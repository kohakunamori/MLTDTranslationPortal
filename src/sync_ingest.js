// GitHub -> portal sync ingester.
//
// This module is the *consumer* half of the webhook pipeline. The webhook route
// only authenticates a delivery and enqueues a `sync_jobs` row; everything that
// touches release data lives here and is driven by the Worker's `scheduled()`
// handler (see `runSyncTick` in worker.js).
//
// Boundaries that are enforced here rather than documented and hoped for:
//   * Repository identity comes from the `SYNC_REPOSITORIES` configuration, not
//     from guessing on the repo name. An unconfigured repository is rejected.
//   * Only the paths named by `PATH_RULES` are ingested. A file that merely
//     looks like localisation data does not become a source variant.
//   * Nothing is written above `release_summaries` / `source_variants` until the
//     release row exists, and a release is never promoted to `canonical` by an
//     ingest — promotion is an operator action on the D1 row.
//   * Work is bounded: file count, per-file bytes, D1 rows per invocation and
//     attempts all have explicit ceilings. Exceeding the row budget requeues the
//     job with a progress cursor instead of half-writing a commit.

import { RegistryError, rethrowQuota, resolveAssetsReleaseId, clientReleaseId } from "./release_registry.js";
import { categoryId } from "./categories.js";

export const DEFAULT_FILE_LIMIT = 400;          // changed files considered per job
export const DEFAULT_ROWS_PER_JOB = 4000;       // D1 rows written per invocation
export const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const LOOKUP_CHUNK = 40;                 // logical keys per batched lookup (D1 bound-parameter ceiling is 100)

/// Per-repository ingest policy. `kind` is the release axis, `releaseManifest`
/// names the file that carries release metadata for that axis.
export const REPOSITORY_POLICIES = {
  assets: {
    releaseManifest: "manifests/asset-version.json",
    localeManifests: ["manifests/images.manifest.json"],
  },
  client: {
    releaseManifest: "manifests/apk-builtin.manifest.json",
    localeManifests: ["manifests/bottom-bar.manifest.json"],
  },
};

/// Manifest kinds that are recognisable but carry no localisable text. They are
/// listed so the planner can refuse them *by name* with a reason, instead of
/// being parsed optimistically and dropping every row on the floor.
export const NON_LOCALISABLE_MANIFEST_KINDS = {
  "mltd-images-manifest": "image_manifest_metadata_only",
  "mltd-bottom-bar-manifest": "apk_builtin_surface",
  "mltd-apk-builtin-manifest": "apk_builtin_surface",
};

/// Path -> resource classification. Ordered; first match wins.
/// Deliberately explicit: `video/**` is *listed* so it can be reported as an
/// explicitly excluded surface instead of silently falling through.
///
/// `ingestible: false` marks a path this pipeline recognises but must not turn
/// into a source variant:
///
///   * `manifests/images.manifest.json` is a *pixel* index (sha256, dimensions,
///     format, alpha, object keys). It has no `ja`/`zh` text at all, so parsing
///     it produced zero records and reported success. Image tasks are owned by
///     `scripts/generate_image_tasks_index.py` -> `image_task_units`, with
///     `image_status_overrides` layered at read time; D1 stores metadata only.
///   * `manifests/bottom-bar.manifest.json` describes sprites baked into the
///     APK's embedded `data.unity3d` atlas (`atlas_target` + `slots[]`). That is
///     an APK built-in surface delivered by the Client repository and packaged
///     into the APK — it is not an asset-server overlay row.
export const PATH_RULES = [
  { test: (p) => p.startsWith("generated/"), kind: "generated", ingestible: false, reason: "generated_artifact_only" },
  { test: (p) => p.startsWith("locales/") && p.endsWith(".jsonl"), kind: "text" },
  { test: (p) => p.startsWith("lyrics/") && p.endsWith(".jsonl"), kind: "lyrics" },
  {
    test: (p) => p === "manifests/images.manifest.json", kind: "image",
    ingestible: false, reason: "image_manifest_metadata_only",
  },
  {
    test: (p) => p === "manifests/bottom-bar.manifest.json", kind: "text",
    ingestible: false, reason: "apk_builtin_surface",
  },
  { test: (p) => p.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(p), kind: "video", unsupported: true },
];

export function classifyPath(path) {
  const normalized = String(path || "").replace(/^\/+/, "");
  for (const rule of PATH_RULES) {
    if (rule.test(normalized)) {
      return {
        kind: rule.kind,
        unsupported: Boolean(rule.unsupported),
        ingestible: rule.ingestible !== false,
        reason: rule.reason || null,
      };
    }
  }
  return null;
}

/// Parse the `SYNC_REPOSITORIES` configuration value into a repo -> kind map.
/// Accepted forms: `{"owner/repo":"assets"}` JSON, or `owner/repo=assets,other/repo=client`.
export function parseRepositoryConfig(value) {
  const map = new Map();
  const raw = String(value || "").trim();
  if (!raw) return map;
  if (raw.startsWith("{")) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new RegistryError("sync_repositories_config_invalid", "not valid JSON"); }
    for (const [repo, kind] of Object.entries(parsed)) {
      if (kind === "assets" || kind === "client") map.set(repo.toLowerCase(), kind);
    }
    return map;
  }
  for (const pair of raw.split(",")) {
    const [repo, kind] = pair.split("=").map((part) => String(part || "").trim());
    if (repo && (kind === "assets" || kind === "client")) map.set(repo.toLowerCase(), kind);
  }
  return map;
}

/// Which release axis a delivery belongs to, or null when the repository is not
/// configured for sync. Never infers the axis from the repository name.
export function resolveTargetKind(env, repository) {
  const name = String(repository || "").trim().toLowerCase();
  if (!name) return null;
  return parseRepositoryConfig(env?.SYNC_REPOSITORIES).get(name) || null;
}

/// A stable, content-derived identifier for a source variant. Re-running the
/// same commit therefore targets the same row.
export function sourceVariantId(releaseKind, releaseId, bundle, itemKey) {
  return `sv:${releaseKind}:${releaseId}:${bundle}:${itemKey}`;
}

export function resourceId(kind, logicalKey) {
  return `res:${kind}:${logicalKey}`;
}

export function translationUnitId(logicalKey, kind, locale, sourceSha256) {
  return `tu:${kind}:${locale}:${logicalKey}:${sourceSha256}`;
}

/// Build the logical key for a resource. Must be stable across releases: that is
/// the whole mechanism by which two releases can share a translation.
export function buildLogicalKey(kind, bundle, itemKey) {
  const clean = String(bundle || "").replace(/\.(gtx|unity3d|jsonl|json)$/i, "");
  return `${kind}/${clean}/${itemKey}`;
}

function normalizeSha(value) {
  const sha = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(sha) ? sha : "";
}

/// A local JSONL parser. Kept dependency-free so the Worker bundle stays small
/// and so the exact same code runs in the test harness.
export function parseJsonl(text) {
  const rows = [];
  const lines = String(text || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (err) {
      throw new RegistryError("ingest_jsonl_invalid", `line ${index + 1}: ${String(err?.message || err).slice(0, 120)}`);
    }
  }
  return rows;
}

/// Turn one decoded entry into the fields the DB layer needs. Returns null for
/// entries that are not ingestible, so a malformed line cannot abort a whole
/// file — the caller counts it as `rejected`.
export function entryToRecord(entry, context) {
  const { kind, releaseKind, releaseId, defaultBundle } = context;
  const bundle = String(entry.bundle || defaultBundle || "").trim();
  const itemKey = String(entry.item_key ?? entry.key ?? "").trim();
  if (!bundle || !itemKey) return null;

  const source = entry.ja ?? entry.source ?? entry.source_text;
  if (typeof source !== "string") return null;

  // The declared hash is authoritative only when it matches the content. A
  // mismatch is a source-integrity failure, not something to "repair".
  const declared = normalizeSha(entry.source_sha256);
  const translation = entry.zh ?? entry.translation;
  return {
    resource_kind: kind,
    release_kind: releaseKind,
    release_id: releaseId,
    bundle,
    item_key: itemKey,
    logical_key: buildLogicalKey(kind, bundle, itemKey),
    source_text: source,
    declared_sha256: declared,
    translation: typeof translation === "string" ? translation : null,
    translation_status: String(entry.status || "").toLowerCase() || null,
    contributor: typeof entry.contributor_email === "string" ? entry.contributor_email : null,
  };
}

// ---------------------------------------------------------------------------
// Bounded GitHub reads
// ---------------------------------------------------------------------------

export class GitHubClient {
  constructor({ token, repository, commitSha, fetchImpl = fetch, userAgent = "mltd-portal-sync" }) {
    this.token = token;
    this.repository = repository;
    this.commitSha = commitSha;
    this.fetch = fetchImpl;
    this.userAgent = userAgent;
  }

  headers() {
    const headers = { accept: "application/vnd.github+json", "user-agent": this.userAgent };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  async json(url) {
    const response = await this.fetch(url, { headers: this.headers() });
    if (!response.ok) {
      throw new RegistryError("github_request_failed", `${response.status} ${url.replace(/[?].*$/, "")}`);
    }
    return response.json();
  }

  async text(url, maxBytes = DEFAULT_MAX_FILE_BYTES) {
    const response = await this.fetch(url, { headers: this.headers() });
    if (!response.ok) throw new RegistryError("github_request_failed", `${response.status} ${url}`);
    const declared = Number(response.headers?.get?.("content-length") || 0);
    if (declared && declared > maxBytes) throw new RegistryError("ingest_file_too_large", `${declared} bytes`);
    const body = await response.text();
    if (body.length > maxBytes) throw new RegistryError("ingest_file_too_large", `${body.length} bytes`);
    return body;
  }

  /// Changed files between two commits. One API call, bounded page of results.
  async changedFiles(base, head, limit = DEFAULT_FILE_LIMIT) {
    const url = `https://api.github.com/repos/${this.repository}/compare/${base}...${head}?per_page=${Math.min(limit, 300)}`;
    const payload = await this.json(url);
    return (payload.files || []).map((file) => ({
      path: String(file.filename || ""),
      status: String(file.status || ""),
      sha: String(file.sha || ""),
      previous_path: file.previous_filename ? String(file.previous_filename) : null,
    }));
  }

  /// Every path in a commit, used only for the first sync of a repository where
  /// no previous commit is known. Callers must still apply the path allowlist.
  async treePaths(limit = DEFAULT_FILE_LIMIT) {
    const url = `https://api.github.com/repos/${this.repository}/git/trees/${this.commitSha}?recursive=1`;
    const payload = await this.json(url);
    const tree = payload.tree || [];
    if (tree.length > limit) {
      throw new RegistryError("ingest_tree_too_large", `${tree.length} paths`);
    }
    return tree.filter((node) => node.type === "blob").map((node) => ({
      path: String(node.path || ""),
      status: "added",
      sha: String(node.sha || ""),
      previous_path: null,
    }));
  }

  /// Raw content pinned to a commit sha: deterministic, cacheable, and immune to
  /// the branch moving under us.
  async rawFile(path, maxBytes = DEFAULT_MAX_FILE_BYTES) {
    const url = `https://raw.githubusercontent.com/${this.repository}/${this.commitSha}/${path}`;
    return this.text(url, maxBytes);
  }

  async fileAt(path) {
    const url = `https://api.github.com/repos/${this.repository}/contents/${path}?ref=${this.commitSha}`;
    const payload = await this.json(url);
    if (!payload || payload.encoding !== "base64" || typeof payload.content !== "string") {
      throw new RegistryError("ingest_file_unreadable", path);
    }
    const binary = atob(String(payload.content).replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
}

// ---------------------------------------------------------------------------
// Planning (pure, unit-testable)
// ---------------------------------------------------------------------------

/**
 * Decide which changed files this job will ingest, and why the others were
 * skipped. Returns a bounded plan; the caller decides whether it can afford it.
 */
export function planIngest(files, { targetKind }) {
  const policy = REPOSITORY_POLICIES[targetKind];
  if (!policy) throw new RegistryError("sync_kind_unknown", targetKind);

  const planned = [];
  const skipped = [];
  for (const file of files) {
    const path = String(file.path || "");
    if (file.status === "removed") { skipped.push({ path, reason: "deleted" }); continue; }
    if (path === policy.releaseManifest) { planned.push({ path, role: "release-manifest", kind: null }); continue; }
    if (!policy.localeManifests.includes(path) && /\/(manifest|index)\.json$/i.test(path)) {
      skipped.push({ path, reason: "unrecognised_manifest" });
      continue;
    }
    const classification = classifyPath(path);
    if (!classification) { skipped.push({ path, reason: "path_not_ingestible" }); continue; }
    if (classification.unsupported) { skipped.push({ path, reason: "unsupported_resource_kind", kind: classification.kind }); continue; }
    if (!classification.ingestible) {
      // Named refusal, not a silent zero: the path is recognised, it is simply
      // not a text surface. The reason string is the one thing a reader needs.
      skipped.push({ path, reason: classification.reason, kind: classification.kind });
      continue;
    }
    planned.push({ path, role: "entries", kind: classification.kind, manifest: policy.localeManifests.includes(path) });
  }
  return { planned, skipped };
}

/// Extract source-variant records from a fetched file. JSONL files produce many
/// records; a manifest produces one record per declared entry.
export function recordsFromFile(plan, text, context) {
  if (plan.manifest || plan.path.endsWith(".json")) {
    let payload;
    try { payload = JSON.parse(text); } catch { throw new RegistryError("ingest_json_invalid", plan.path); }
    const entries = collectManifestEntries(payload, plan.path);
    return entries.map((entry) => entryToRecord(entry, context)).filter(Boolean);
  }
  return parseJsonl(text).map((entry) => entryToRecord(entry, context)).filter(Boolean);
}

/// Manifests in the two repositories use several shapes. Only the documented
/// shapes are accepted — an unknown shape throws instead of being coerced.
///
/// A manifest that *declares itself* one of the non-localisable kinds is refused
/// by name. Otherwise `mltd-images-manifest` would be accepted here (it has an
/// `images[]` array) and every one of its pixel rows would fail `entryToRecord`
/// and be dropped — a silent zero that looks like a successful ingest.
export function collectManifestEntries(payload, path) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") throw new RegistryError("ingest_manifest_shape_unknown", path);

  const declaredKind = String(payload.kind || "").trim();
  const refusal = NON_LOCALISABLE_MANIFEST_KINDS[declaredKind];
  if (refusal) throw new RegistryError(refusal, `${path} declares kind=${declaredKind}`);

  const english = payload.entries || payload.items || payload.images || payload.tasks || payload.lines;
  if (Array.isArray(english)) return english.map((entry) => normaliseManifestEntry(entry, path));
  if (Array.isArray(payload.labels)) return payload.labels.map((entry) => normaliseManifestEntry(entry, path));
  throw new RegistryError("ingest_manifest_shape_unknown", path);
}

function normaliseManifestEntry(entry, path) {
  if (!entry || typeof entry !== "object") throw new RegistryError("ingest_manifest_entry_invalid", path);
  const itemKey = entry.item_key ?? entry.id ?? entry.key ?? entry.name ?? entry.label;
  const source = entry.ja ?? entry.source ?? entry.source_text ?? entry.text_ja ?? entry.japanese;
  const sourceSha = entry.source_sha256 ?? entry.original_sha256 ?? entry.sha256;
  const bundle = entry.bundle ?? entry.file ?? entry.path ?? path.split("/").slice(0, -1).join("/");
  return {
    bundle,
    item_key: itemKey,
    ja: source,
    source_sha256: sourceSha,
    zh: entry.zh ?? entry.translation ?? entry.text_zh,
    status: entry.status,
  };
}

/**
 * Validate the release manifest of one axis. Refuses to derive an identity from
 * a composite version and refuses a Client manifest that carries an asset
 * version (§一.2: Client builds must not depend on the Assets axis).
 */
export function validateReleaseManifest(targetKind, payload, repository) {
  if (!payload || typeof payload !== "object") throw new RegistryError("ingest_manifest_shape_unknown", "release-manifest");
  const notes = [];

  if (targetKind === "client") {
    if (payload.asset_version !== undefined || payload.base_version !== undefined) {
      throw new RegistryError("decoupling_violation", "client release manifest must not carry asset_version/base_version");
    }
    const abi = String(payload.abi || "").trim();
    if (abi && abi !== "arm64-v8a") throw new RegistryError("client_abi_unsupported", abi);
    const clientVersion = String(payload.client_version || "").trim();
    if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(clientVersion)) {
      throw new RegistryError("client_version_invalid", clientVersion || "missing");
    }
    const abiFinal = abi || "arm64-v8a";
    return {
      releaseId: String(payload.release_id || clientReleaseId(clientVersion, abiFinal)),
      clientVersion,
      abi: abiFinal,
      baseApkSha256: normalizeSha(payload.base_apk_sha256) || null,
      clientResourcesCommit: String(payload.client_resources_commit || "").trim() || null,
      manifestSha256: normalizeSha(payload.manifest_sha256) || null,
      outputApkSha256: normalizeSha(payload.output_apk_sha256) || null,
      releaseUrl: String(payload.release_url || (payload.release && payload.release.html_url) || "").trim() || null,
      status: normaliseClientStatus(payload.status),
      notes,
    };
  }

  const assetVersion = String(payload.asset_version ?? payload.version ?? "").trim();
  if (!/^[0-9]{1,10}$/.test(assetVersion)) {
    throw new RegistryError("asset_version_invalid", assetVersion || "missing");
  }
  if (payload.base_apk_sha256 !== undefined || payload.client_version !== undefined) {
    throw new RegistryError("decoupling_violation", "assets release manifest must not carry client fields");
  }
  return {
    releaseId: String(payload.release_id || `assets-${assetVersion}`),
    assetVersion,
    serverSchemaVersion: String(payload.server_schema_version || "v1").trim() || "v1",
    sourceManifestSha256: normalizeSha(payload.source_manifest_sha256) || null,
    assetsCommit: String(payload.assets_commit || "").trim() || null,
    status: "staging",
    notes,
  };
}

function normaliseClientStatus(status) {
  const value = String(status || "").trim();
  return ["draft", "candidate", "published", "superseded", "failed"].includes(value) ? value : "candidate";
}

// ---------------------------------------------------------------------------
// Reuse evaluation (batched; never one query per item)
// ---------------------------------------------------------------------------

/**
 * Decide the reuse mode for a batch of records using at most three queries.
 *
 *   exact               same logical_key + kind + locale + source_sha256 and an
 *                       accepted translation exists
 *   verified-compatible an explicit `reuse_attestations` row authorises this
 *                       source hash transition
 *   suggested           the same logical key has accepted history under a
 *                       *different* source hash
 *   blocked             the same logical key exists with a different source hash
 *                       and no attestation
 *   none                no history at all
 *
 * No branch here inspects version numbers, bundle names, dates or text
 * similarity: those are exactly the signals §四 forbids using.
 */
export async function evaluateReuseBatch(env, records, { locale = "zh-CN" } = {}) {
  const decisions = new Map();
  if (!env?.DB || records.length === 0) return decisions;

  const keys = [...new Set(records.map((record) => record.logical_key))];
  const byKey = new Map();
  // Attestations are keyed by `kind:logical_key:to_sha`; kept in its own map so
  // it cannot collide with the per-record decision map below.
  const attestationsByKey = new Map();

  for (let offset = 0; offset < keys.length; offset += LOOKUP_CHUNK) {
    const chunk = keys.slice(offset, offset + LOOKUP_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    let units;
    let attestations;
    try {
      // Two batched queries for the whole chunk — never one query per record.
      units = await env.DB.prepare(
        `SELECT translation_id, logical_key, resource_kind, locale, source_sha256, status, translation ` +
        `FROM translation_units WHERE locale=? AND status='accepted' AND logical_key IN (${placeholders})`
      ).bind(locale, ...chunk).all();
      attestations = await env.DB.prepare(
        `SELECT logical_key, resource_kind, locale, from_source_sha256, to_source_sha256, reason, attested_by ` +
        `FROM reuse_attestations WHERE locale=? AND logical_key IN (${placeholders})`
      ).bind(locale, ...chunk).all();
    } catch (err) {
      return rethrowQuota(err);
    }
    for (const unit of units.results || []) {
      const list = byKey.get(unit.logical_key) || [];
      list.push(unit);
      byKey.set(unit.logical_key, list);
    }
    for (const attestation of attestations.results || []) {
      attestationsByKey.set(`${attestation.resource_kind}:${attestation.logical_key}:${attestation.to_source_sha256}`, attestation);
    }
  }

  const result = new Map();
  for (const record of records) {
    const history = byKey.get(record.logical_key) || [];
    const sameSha = history.find((unit) => unit.source_sha256 === record.declared_sha256 && unit.resource_kind === record.resource_kind);
    if (sameSha) {
      result.set(record, { reuse_mode: "exact", translation_id: sameSha.translation_id, translation: sameSha.translation, source: sameSha.source_sha256 });
      continue;
    }
    const attestation = attestationsByKey.get(`${record.resource_kind}:${record.logical_key}:${record.declared_sha256}`);
    if (attestation) {
      const approved = history.find((unit) => unit.source_sha256 === attestation.from_source_sha256 && unit.resource_kind === record.resource_kind);
      if (approved) {
        result.set(record, {
          reuse_mode: "verified-compatible",
          translation_id: approved.translation_id,
          translation: approved.translation,
          source: approved.source_sha256,
          attestation_reason: attestation.reason,
        });
        continue;
      }
    }
    const other = history.find((unit) => unit.resource_kind === record.resource_kind);
    if (other) {
      // Same resource, different source text, no attestation: a human may decide
      // the old translation still applies, so it is offered as a suggestion and
      // explicitly NOT bound to the release.
      result.set(record, {
        reuse_mode: "suggested",
        translation_id: null,
        suggestion_translation_id: other.translation_id,
        translation: other.translation,
        source: other.source_sha256,
      });
      continue;
    }
    result.set(record, { reuse_mode: "none", translation_id: null, translation: null, source: null });
  }
  return result;
}

/// Map a reuse decision onto the ref `status` column.
///
/// The reuse decision and the unit's own review state answer different
/// questions, so they are combined here rather than conflated:
///
///   * a reuse (exact / verified-compatible) binds an already-accepted
///     translation, so the ref is `accepted`;
///   * a suggestion or a block is a statement *about reuse* and wins outright,
///     because the whole point is to stop a reviewer from missing it;
///   * with no reuse, the status is the one the import itself declared — a
///     manifest that marks a row `accepted` is the SSOT and must not be
///     silently downgraded to `pending` just because it was newly imported.
export function refStatusFor(decision, record) {
  const mode = decision?.reuse_mode;
  if (mode === "exact" || mode === "verified-compatible") return "accepted";
  if (mode === "suggested") return "suggested";
  if (mode === "blocked") return "blocked";
  if (!record?.translation) return "untranslated";
  const declared = String(record.translation_status || "").trim();
  if (declared === "accepted" || declared === "needs_review") return declared;
  return "pending";
}

// ---------------------------------------------------------------------------
// Release summaries (derived, rebuildable, never hand-maintained)
// ---------------------------------------------------------------------------

/// Recompute one release's summary from `release_resource_refs`. This is the
/// only writer of `release_summaries`; the worker's read path never aggregates.
export async function rebuildReleaseSummary(env, releaseKind, releaseId) {
  if (!env?.DB) throw new RegistryError("database_unavailable");
  let rows;
  try {
    rows = await env.DB.prepare(
      `SELECT r.status, r.reuse_mode, sv.bundle, COUNT(*) AS count ` +
      `FROM release_resource_refs r JOIN source_variants sv ON sv.source_variant_id = r.source_variant_id ` +
      `WHERE r.release_kind=? AND r.release_id=? ` +
      `GROUP BY r.status, r.reuse_mode, sv.bundle`
    ).bind(releaseKind, releaseId).all();
  } catch (err) {
    return rethrowQuota(err);
  }

  const totals = { total_items: 0, translated_items: 0, pending_items: 0, untranslated_items: 0, reused_items: 0, suggested_items: 0, blocked_items: 0 };
  const categories = {};
  for (const row of rows.results || []) {
    const count = Number(row.count || 0);
    totals.total_items += count;
    if (row.status === "accepted") totals.translated_items += count;
    if (row.status === "pending" || row.status === "needs_review") totals.pending_items += count;
    if (row.status === "untranslated") totals.untranslated_items += count;
    if (row.status === "suggested") totals.suggested_items += count;
    if (row.status === "blocked") totals.blocked_items += count;
    if (row.reuse_mode === "exact" || row.reuse_mode === "verified-compatible") totals.reused_items += count;

    // Keyed by the category taxonomy, not by raw bundle name, so the UI's
    // subcategory grid and this summary speak the same language. The per-bundle
    // detail stays available in `bundles` for anyone who needs to drill down.
    const bundleKey = String(row.bundle || "unknown");
    const categoryKey = categoryId(bundleKey);
    const bucket = categories[categoryKey] || { total: 0, accepted: 0, pending: 0, suggested: 0, blocked: 0, progress_percent: 0, bundles: {} };
    bucket.total += count;
    if (row.status === "accepted") bucket.accepted += count;
    if (row.status === "pending" || row.status === "needs_review") bucket.pending += count;
    if (row.status === "suggested") bucket.suggested += count;
    if (row.status === "blocked") bucket.blocked += count;
    // Per bundle: `{ slots, accepted }`. The songs view needs both ("43 lines,
    // 33 done") and asking for them per request is what forced a COUNT(*) and a
    // conditional SUM into its read path. Computed once here, they are free.
    const entry = bucket.bundles[bundleKey] || (bucket.bundles[bundleKey] = { slots: 0, accepted: 0 });
    entry.slots += count;
    if (row.status === "accepted") entry.accepted += count;
    bucket.progress_percent = bucket.total > 0 ? Math.round((bucket.accepted / bucket.total) * 10000) / 100 : 0;
    categories[categoryKey] = bucket;
  }

  const timestamp = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO release_summaries (release_kind, release_id, total_items, translated_items, pending_items, untranslated_items, ` +
      `reused_items, suggested_items, blocked_items, category_summary_json, updated_at) ` +
      `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ` +
      `ON CONFLICT(release_kind, release_id) DO UPDATE SET ` +
      `total_items=excluded.total_items, translated_items=excluded.translated_items, pending_items=excluded.pending_items, ` +
      `untranslated_items=excluded.untranslated_items, reused_items=excluded.reused_items, suggested_items=excluded.suggested_items, ` +
      `blocked_items=excluded.blocked_items, category_summary_json=excluded.category_summary_json, updated_at=excluded.updated_at`
    ).bind(
      releaseKind, releaseId,
      totals.total_items, totals.translated_items, totals.pending_items, totals.untranslated_items,
      totals.reused_items, totals.suggested_items, totals.blocked_items,
      JSON.stringify(categories), timestamp,
    ).run();
  } catch (err) {
    return rethrowQuota(err);
  }
  return { ...totals, categories, updated_at: timestamp };
}

/// The global stats row is a *derived cache* keyed by the canonical release, and
/// it is rebuilt by this module. Freshness is recorded so a reader can tell how
/// old it is.
///
/// A caller that has just rebuilt the canonical release's own summary may pass
/// it as `summary` to skip the second full GROUP BY this function would
/// otherwise run over the same refs. It is optional and additive: with no
/// argument the behaviour is unchanged, so every existing caller keeps exactly
/// one rebuild of its own.
export async function rebuildPortalStats(env, summary = null) {
  const canonical = await env.DB.prepare(
    `SELECT release_id, asset_version FROM assets_releases WHERE status='canonical' ORDER BY updated_at DESC LIMIT 1`
  ).first();
  if (!canonical) return null;
  const computed = summary || await rebuildReleaseSummary(env, "assets", canonical.release_id);
  const payload = {
    release_kind: "assets",
    release_id: canonical.release_id,
    asset_version: canonical.asset_version,
    total: computed.total_items,
    translated: computed.translated_items,
    untranslated: computed.untranslated_items,
    pending: computed.pending_items,
    reused_items: computed.reused_items,
    suggested_items: computed.suggested_items,
    blocked_items: computed.blocked_items,
    categories: computed.categories,
    generated_at: computed.updated_at,
  };
  try {
    await env.DB.prepare(
      `INSERT INTO portal_summary (key, value_json, updated_at) VALUES ('stats', ?, ?) ` +
      `ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`
    ).bind(JSON.stringify(payload), computed.updated_at).run();
  } catch (err) {
    return rethrowQuota(err);
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Upserts used by the job runner
// ---------------------------------------------------------------------------

async function upsertAssetsRelease(env, manifest, timestamp) {
  const releaseId = await resolveAssetsReleaseId(env, manifest.assetVersion);
  const existing = await env.DB.prepare(
    `SELECT status, source_manifest_sha256, assets_commit FROM assets_releases WHERE release_id=? OR asset_version=? LIMIT 1`
  ).bind(releaseId, manifest.assetVersion).first();

  // An ingest never promotes a release to canonical and never downgrades a
  // canonical one: status transitions are an operator decision.
  const status = existing?.status === "canonical" ? "canonical" : "staging";
  const resolvedReleaseId = existing?.release_id || releaseId;
  try {
    await env.DB.prepare(
      `INSERT INTO assets_releases (asset_version, release_id, server_schema_version, status, source_manifest_sha256, assets_commit, note, created_at, updated_at, published_at) ` +
      `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ` +
      `ON CONFLICT(asset_version) DO UPDATE SET release_id=excluded.release_id, server_schema_version=excluded.server_schema_version, ` +
      `status=CASE WHEN assets_releases.status='canonical' THEN 'canonical' ELSE excluded.status END, ` +
      `source_manifest_sha256=COALESCE(excluded.source_manifest_sha256, assets_releases.source_manifest_sha256), ` +
      `assets_commit=COALESCE(excluded.assets_commit, assets_releases.assets_commit), updated_at=excluded.updated_at`
    ).bind(
      manifest.assetVersion, resolvedReleaseId, manifest.serverSchemaVersion, status,
      manifest.sourceManifestSha256, manifest.assetsCommit, "ingested from GitHub release manifest",
      timestamp, timestamp, status === "canonical" ? timestamp : null,
    ).run();
  } catch (err) {
    return rethrowQuota(err);
  }
  const changed = existing?.source_manifest_sha256 !== manifest.sourceManifestSha256 || existing?.assets_commit !== manifest.assetsCommit;
  return { releaseId: resolvedReleaseId, changed: Boolean(changed) };
}

async function upsertClientRelease(env, manifest, timestamp) {
  const existing = await env.DB.prepare(
    `SELECT release_id, output_apk_sha256, manifest_sha256 FROM client_releases WHERE release_id=? LIMIT 1`
  ).bind(manifest.releaseId).first();
  try {
    await env.DB.prepare(
      `INSERT INTO client_releases (release_id, client_version, abi, base_apk_sha256, client_resources_commit, manifest_sha256, output_apk_sha256, release_url, status, created_at, published_at) ` +
      `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ` +
      `ON CONFLICT(release_id) DO UPDATE SET client_version=excluded.client_version, abi=excluded.abi, ` +
      `base_apk_sha256=COALESCE(excluded.base_apk_sha256, client_releases.base_apk_sha256), ` +
      `client_resources_commit=COALESCE(excluded.client_resources_commit, client_releases.client_resources_commit), ` +
      `manifest_sha256=COALESCE(excluded.manifest_sha256, client_releases.manifest_sha256), ` +
      `output_apk_sha256=COALESCE(excluded.output_apk_sha256, client_releases.output_apk_sha256), ` +
      `release_url=COALESCE(excluded.release_url, client_releases.release_url), ` +
      `status=CASE WHEN client_releases.status='published' THEN 'published' ELSE excluded.status END, ` +
      `published_at=COALESCE(client_releases.published_at, excluded.published_at)`
    ).bind(
      manifest.releaseId, manifest.clientVersion, manifest.abi, manifest.baseApkSha256, manifest.clientResourcesCommit,
      manifest.manifestSha256, manifest.outputApkSha256, manifest.releaseUrl, manifest.status,
      timestamp, manifest.status === "published" ? timestamp : null,
    ).run();
  } catch (err) {
    return rethrowQuota(err);
  }
  const changed = existing?.manifest_sha256 !== manifest.manifestSha256 || existing?.output_apk_sha256 !== manifest.outputApkSha256;
  return { releaseId: manifest.releaseId, changed: Boolean(changed) };
}

export async function upsertRelease(env, targetKind, manifest, timestamp) {
  if (targetKind === "assets") return upsertAssetsRelease(env, manifest, timestamp);
  if (targetKind === "client") return upsertClientRelease(env, manifest, timestamp);
  throw new RegistryError("sync_kind_unknown", targetKind);
}

/**
 * Write one batch of records. Every statement is an idempotent upsert keyed by a
 * content-derived id, so replaying a commit cannot duplicate rows. A record
 * whose declared hash does not match its content is rejected, not repaired.
 */
export async function writeRecordBatch(env, records, decisions, timestamp) {
  const statements = [];
  const rejected = [];
  let written = 0;

  for (const record of records) {
    const decision = decisions.get(record);
    const hashOk = record.declared_sha256 ? await verifySha256(record.source_text, record.declared_sha256) : true;
    if (!hashOk) { rejected.push({ ...keyOf(record), reason: "source_hash_mismatch" }); continue; }

    const variantId = sourceVariantId(record.release_kind, record.release_id, record.bundle, record.item_key);
    const resId = resourceId(record.resource_kind, record.logical_key);
    const refId = `rrr:${record.release_kind}:${record.release_id}:${variantId}`;
    const status = refStatusFor(decision, record);
    const translationId = decision?.translation_id || null;
    const reuseMode = decision?.reuse_mode || "none";

    statements.push(
      env.DB.prepare(
        `INSERT INTO resource_units (resource_id, resource_kind, logical_key, category, created_at) VALUES (?, ?, ?, ?, ?) ` +
        `ON CONFLICT(resource_id) DO NOTHING`
      ).bind(resId, record.resource_kind, record.logical_key, null, timestamp),
      env.DB.prepare(
        `INSERT INTO source_variants (source_variant_id, resource_id, release_kind, release_id, source_sha256, source, bundle, item_key, created_at) ` +
        `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ` +
        `ON CONFLICT(source_variant_id) DO UPDATE SET source_sha256=excluded.source_sha256, source=excluded.source`
      ).bind(variantId, resId, record.release_kind, record.release_id, record.declared_sha256, record.source_text, record.bundle, record.item_key, timestamp),
      env.DB.prepare(
        `INSERT INTO release_resource_refs (id, release_kind, release_id, source_variant_id, translation_id, reuse_mode, reused_from_release_id, status, created_at, updated_at) ` +
        `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ` +
        `ON CONFLICT(release_kind, release_id, source_variant_id) DO UPDATE SET ` +
        `translation_id=excluded.translation_id, reuse_mode=excluded.reuse_mode, reused_from_release_id=excluded.reused_from_release_id, ` +
        `status=excluded.status, updated_at=excluded.updated_at`
      ).bind(refId, record.release_kind, record.release_id, variantId, translationId, reuseMode, decision?.reused_from_release_id || null, status, timestamp, timestamp),
    );
    written += 3;

    if (record.translation) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO translation_units (translation_id, logical_key, resource_kind, locale, source_sha256, translation, status, contributor_email, reviewer_email, created_at, updated_at) ` +
          `VALUES (?, ?, ?, 'zh-CN', ?, ?, ?, ?, NULL, ?, ?) ` +
          `ON CONFLICT(logical_key, resource_kind, locale, source_sha256) DO UPDATE SET ` +
          `translation=excluded.translation, updated_at=excluded.updated_at`
        ).bind(
          translationUnitId(record.logical_key, record.resource_kind, "zh-CN", record.declared_sha256),
          record.logical_key, record.resource_kind, record.declared_sha256, record.translation,
          normaliseTranslationStatus(record.translation_status), record.contributor, timestamp, timestamp,
        ),
      );
      written += 1;
    }
  }

  if (statements.length) {
    try {
      await env.DB.batch(statements);
    } catch (err) {
      return rethrowQuota(err);
    }
  }
  return { written, rejected, records: records.length };
}

function normaliseTranslationStatus(status) {
  const value = String(status || "").trim();
  return ["pending", "accepted", "rejected", "needs_review"].includes(value) ? value : "pending";
}

function keyOf(record) {
  return { release_kind: record.release_kind, release_id: record.release_id, bundle: record.bundle, item_key: record.item_key };
}

async function verifySha256(text, expected) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const actual = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return actual === String(expected).toLowerCase();
}
