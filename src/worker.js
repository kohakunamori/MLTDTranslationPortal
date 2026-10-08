import { TERMS, IDOLS, SPEAKERS, IDOL_MAP, SONG_MASTER } from "./terms.js";
import { CATEGORY_RULES, categoryId, detectCategory } from "./categories.js";
import {
  RegistryError,
  defaultAssetVersion,
  getAssetsRelease,
  getClientRelease,
  listAssetsReleases,
  normalizeAssetVersionInput,
  registryErrorStatus,
  resolveAssetVersion,
  rethrowQuota,
  verifyAssetVersionForWrite,
} from "./release_registry.js";
import { runSyncTick } from "./sync_runner.js";
import { resolveTargetKind } from "./sync_ingest.js";
import {
  GitHubCollabError,
  base64ToBytes,
  branchName,
  buildAuthorizeUrl,
  createBranch,
  createOAuthState,
  createPullRequest,
  ensureFork,
  exchangeCodeForToken,
  getAuthenticatedUser,
  getBranchHead,
  getPullRequest,
  newShortId,
  parseRepoSpec,
  putFile,
} from "./github_collab.js";
import { ImageSizeError, checkAspectRatio, normalizeRatio, parseImageSize } from "./image_ratio.js";
import { deleteAuthObject, quotaLike, readAuthObject, writeAuthObject } from "./auth_fallback.js";
import {
  deleteUserToken,
  putUserToken,
  requireUserToken,
  tokenCustodyConfigured,
} from "./github_user_token.js";
import {
  CSRF_HEADER,
  OAUTH_BINDING_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  SessionError,
  assertWriteAllowed,
  auditActor,
  clearOauthBindingCookie,
  clearSessionCookie,
  githubIdentityKey,
  hashSessionToken,
  issueSession,
  newOpaqueToken,
  oauthBindingCookie,
  originAllowed,
  readCookie,
  readSession,
  revokeSession,
  roleFor,
  sessionCookie,
  sweepExpiredSessions,
  timingSafeEqual,
  withCookies,
} from "./github_session.js";

const HEX64 = /^[0-9a-f]{64}$/i;
/// Hex SHA-256, either case. Deliberately not `/i`-free: the OAuth binding
/// cookie is 32 random bytes rendered as lower-case hex, and `Hash`-cased input
/// must not be a second way in.
const HEX64_ANY = /^[0-9a-f]{64}$/i;
/// A 40-hex commit sha. `base_commit` is pinned to one of these.
const FULL_SHA = /^[0-9a-f]{40}$/i;
const PACKAGE_VERSION = "mltd-translation-portal/5";
const STATS_CACHE_TTL = 10 * 60 * 1000; // 10 minutes cache
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;
const DEFAULT_ASSETS_PORTAL_MANIFEST_URL =
  "https://raw.githubusercontent.com/kohakunamori/MLTDTranslationAssets/main/manifests/portal-resource-manifest.json";
const DEFAULT_CLIENT_PORTAL_MANIFEST_URL =
  "https://raw.githubusercontent.com/kohakunamori/MLTDTranslationClient/main/manifests/portal-resource-manifest.json";
// Client 槽位文件没有 main 上的默认地址：它必须钉在 CI manifest 给出的 commit
// 上（见 `clientItemsManifestUrl`），main 上的同名文件不是任何 release 的内容。
const ASSETS_PORTAL_MANIFEST_CACHE_TTL = 5 * 60 * 1000;
let assetsPortalManifestCache = { url: "", expiresAt: 0, value: null };
let clientPortalManifestCache = { url: "", expiresAt: 0, value: null };
let clientItemsManifestCache = { url: "", expiresAt: 0, value: null };
const assetsBundleRowsCache = new Map();
/// Who may open a proposal through the portal. Every role the schema defines —
/// the point of a contribution surface is that a plain contributor can use it —
/// and the list is written out rather than implied so a future role has to be
/// added here on purpose.
const GITHUB_WRITE_ROLES = ["contributor", "reviewer", "admin"];
/// Credential-shaped literals (`ghp_…`, `gho_…`, `github_pat_…` and bare 64-hex
/// strings). The last shape is deliberately broad: an opaque session token and a
/// SHA-256 hash are both 64 hex characters, and an audit detail has no business
/// carrying either.
const CREDENTIAL_SHAPED = /(github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|[0-9a-f]{64})/i;
/// A bound on the file the single-line edit route will read and re-serialize.
const MAX_RESOURCE_LINES = 20000;

// Which asset release may be written to is a property of the D1
// `assets_releases` row (see ./release_registry.js). There is intentionally no
// version list in this file: historical versions live in the database and in
// migrations, never as a Worker-side allowlist.
export { resolveAssetVersion };

/// Drop the in-isolate stats memo. Exported so a test can swap the database
/// under the module and assert the *next* read, and so an operator-facing reset
/// has a name. A memo keyed on nothing would otherwise keep serving the previous
/// release after a fixture change.
export function clearStatsMemo() {
  memoryStats = null;
  memoryStatsTime = 0;
}

// Latest release reads are driven by the upstream repositories' CI manifests.
// D1 sync remains available through the authenticated manual `/api/sync/tick`
// route, but is deliberately not scheduled: a background consumer would spend
// the free D1 write budget materialising data the portal no longer reads.
export const SYNC_CRON = "manual";
export const CLAIM_BATCH_SIZE = 3;

let memoryStats = null;
let memoryStatsTime = 0;

export { CATEGORY_RULES, categoryId, detectCategory };

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}

/// Distinguish "D1 said no" from "we wrote a bug". A quota error must never be
/// reported as an empty result set: the caller either serves explicitly stale
/// data or answers 503 with a Retry-After.
function isQuotaError(err) {
  const msg = String(err?.message || err).toLowerCase();
  return msg.includes("limit") || msg.includes("7500") || msg.includes("exceeded") || msg.includes("quota");
}

function quotaResponse(err, extra = {}) {
  const headers = { "retry-after": String(secondsUntilUtcMidnight()) };
  return json({
    error: "d1_quota_exceeded",
    stale: false,
    detail: String(err?.message || err).slice(0, 200),
    retry_after_seconds: secondsUntilUtcMidnight(),
    ...extra,
  }, 503, headers);
}

function secondsUntilUtcMidnight() {
  const nowMs = Date.now();
  const midnight = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate() + 1);
  return Math.max(1, Math.ceil((midnight - nowMs) / 1000));
}

function dataNotReady(detail) {
  return json({ error: "data_not_ready", detail, generated_at: now() }, 503, {
    "cache-control": "no-store",
  });
}

/// Wrap a handler so a RegistryError (D1 quota, unregistered release) is turned
/// into the matching HTTP status instead of an opaque 500.
function withRegistryErrors(handler) {
  return async (request, env) => {
    try {
      return await handler(request, env);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const status = registryErrorStatus(err);
      if (status === 503) return quotaResponse(err);
      if (err instanceof RegistryError) throw new HttpError(status, err.code);
      throw err;
    }
  };
}

function cors(request, response) {
  const origin = request.headers.get("Origin");
  // 凭据响应只能由同源页面读取，不反射任意 Origin。
  if (!origin || origin !== new URL(request.url).origin) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-credentials", "true");
  headers.set("vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}

function now() { return new Date().toISOString(); }
function id() { return crypto.randomUUID(); }
function csv(value) { return new Set(String(value || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean)); }

async function requireActor(request, env, roles = []) {
  const value = await currentActor(request, env);
  if (!value) throw new HttpError(401, "authentication_required");
  if (roles.length && !roles.includes(value.role)) throw new HttpError(403, "role_required");
  return value;
}

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function textField(value, name, max = 20000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new HttpError(400, `${name}_invalid`);
  if (value.includes("\u0000") || value.includes("|") || value.includes("^")) throw new HttpError(400, `${name}_contains_reserved_separator`);
  return value;
}

/// An audit row is read by an operator and pasted into bug reports, so a
/// credential that reached one would leave the system through a channel nobody
/// is watching. The detail is scrubbed here rather than trusted to each call
/// site: a credential-shaped value is dropped and replaced by a marker, and the
/// event still records that *something* happened. (Refusing the write outright
/// would turn a logging bug into a failed contribution, which is worse.)
async function audit(env, actorEmail, action, objectType, objectId, detail) {
  let serialized = JSON.stringify(detail ?? {});
  if (CREDENTIAL_SHAPED.test(serialized)) {
    console.warn("audit detail dropped: credential-shaped value", JSON.stringify({ action, object_type: objectType }));
    serialized = JSON.stringify({ redacted: "credential_shaped_detail", action });
  }
  try {
    await env.DB.prepare(`INSERT INTO audit_events (id, actor_email, action, object_type, object_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(id(), actorEmail, action, objectType, objectId, serialized, now()).run();
  } catch (err) {
    console.warn("audit D1 write skipped:", err?.message || err);
  }
}

async function notify(env, title, message, priority = 5) {
  const url = String(env.NOTIFY_URL || "").trim();
  if (!url) return { configured: false, ok: false, status: 0 };
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, message, priority }),
    });
    return { configured: true, ok: response.ok, status: response.status };
  } catch (error) {
    return { configured: true, ok: false, status: 0, error: String(error).slice(0, 120) };
  }
}

/// The `contributors` row for an actor. The table is keyed by email because it
/// predates portal sessions; a GitHub actor has no verified email here, so the
/// column holds the stable `github:<id>` key instead. The column is a *name*,
/// and an identity GitHub cannot be talked out of is a better name than one a
/// request header can assert.
async function ensureContributor(env, person) {
  const timestamp = now();
  const key = String(person?.email || person?.key || "").trim().toLowerCase();
  if (!key) throw new HttpError(401, "authentication_required");
  const display = person.email || person.login || key;
  try {
    await env.DB.prepare(`INSERT INTO contributors (email, display_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET updated_at=excluded.updated_at, role=excluded.role`)
      .bind(key, display, person.role, timestamp, timestamp).run();
  } catch (err) {
    // A spent D1 write budget is not a "best effort" condition: swallowing it
    // here turns the *next* write into a foreign-key failure and the caller
    // reports the wrong reason. Quota errors propagate so they can be routed to
    // the R2 buffer.
    if (isQuotaError(err)) rethrowQuota(err);
    console.warn("ensureContributor D1 write skipped:", err?.message || err);
  }
}

export function detectIdol(bundle, itemKey, source) {
  if (itemKey) {
    const m = itemKey.match(/(?:^|_|(?<=[a-z]))(\d{3}[a-z]{3})(?:_|$|[a-z0-9])/i);
    if (m && IDOL_MAP.has(m[1].toLowerCase())) return IDOL_MAP.get(m[1].toLowerCase());
    for (const [code, sp] of Object.entries(SPEAKERS)) {
      if (itemKey.includes(code)) {
        const idol = IDOL_MAP.get(code);
        if (idol) return idol;
        return { code, id: 0, name_ja: sp.name_ja, name_zh: sp.name_zh, type: "Guest", color: "#666666" };
      }
    }
  }
  if (bundle) {
    const m = bundle.match(/(\d{3}[a-z]{3})/i);
    if (m && IDOL_MAP.has(m[1].toLowerCase())) return IDOL_MAP.get(m[1].toLowerCase());
  }
  return null;
}


function getTerms() {
  return json({
    terms: TERMS,
    idols: IDOLS,
    speakers: SPEAKERS
  }, 200, {
    "cache-control": "public, max-age=3600"
  });
}

/**
 * Stats reader. Exactly one bounded read, in this order:
 *   1. `portal_summary` key='stats'      — one indexed row, written by the sync
 *      runner (see rebuildPortalStats in ./sync_ingest.js).
 *   2. `release_summaries` for the canonical assets release — one indexed row.
 * There is deliberately NO third step. This handler used to fall back to
 * COUNT(*) / GROUP BY over `source_catalogue` and `contributions`, which is one
 * full scan away from burning the daily read quota, and on quota exhaustion it
 * answered 0 rather than admitting it could not read. Now a missing summary is a
 * 503 `data_not_ready` and a quota failure is a 503 `d1_quota_exceeded`.
 */
/// The four counters every stats reader expects, derived from whatever the
/// source row provides. A field the source does not carry is 0, never a guess.
function statsSummaryView(source) {
  const total = Number(source?.total ?? source?.total_items ?? 0);
  const translated = Number(source?.translated ?? source?.translated_items ?? 0);
  const untranslated = Number(source?.untranslated ?? source?.untranslated_items ?? 0);
  const pending = Number(source?.pending ?? source?.pending_items ?? 0);
  const progressPercent = source?.progress_percent ?? (total > 0 ? Number(((translated / total) * 100).toFixed(2)) : 0);
  return { total, translated, untranslated, pending, accepted: translated, progress_percent: progressPercent };
}

function statsPayloadFromPortalManifest(manifest) {
  const release = manifest?.release || {};
  const totals = manifest?.totals || {};
  const categories = Object.fromEntries((Array.isArray(manifest?.categories) ? manifest.categories : []).map((entry) => {
    const accepted = Number(entry.accepted ?? entry.translated ?? 0);
    return [entry.id, {
      ...entry,
      accepted,
      translated: Number(entry.translated ?? accepted),
      pending: Number(entry.pending ?? 0),
      untranslated: Number(entry.untranslated ?? 0),
      progress_percent: entry.progress_percent ?? (Number(entry.total || 0) > 0
        ? Number(((accepted / Number(entry.total)) * 100).toFixed(2))
        : 0),
    }];
  }));
  const normalized = statsSummaryView(totals);
  return {
    release_kind: "assets",
    release_id: release.release_id,
    asset_version: release.asset_version,
    total: normalized.total,
    translated: normalized.translated,
    untranslated: normalized.untranslated,
    pending: normalized.pending,
    accepted: normalized.accepted,
    reused_items: Number(totals.reused ?? 0),
    suggested_items: Number(totals.suggested ?? 0),
    blocked_items: Number(totals.blocked ?? 0),
    progress_percent: normalized.progress_percent,
    categories,
    summary_updated_at: release.updated_at || manifest.generated_at || now(),
    summary_stale: false,
    summary: normalized,
    idols: IDOLS,
    by_idol: Object.fromEntries(IDOLS.map((entry) => [entry.code, entry])),
    source: "github",
  };
}

async function getStats(request, env) {
  const nowTime = Date.now();
  if (memoryStats && (nowTime - memoryStatsTime < STATS_CACHE_TTL)) {
    return json(memoryStats, 200, {
      "cache-control": "public, max-age=600, s-maxage=600",
      "x-summary-source": "memory",
    });
  }

  try {
    // The repository CI publishes an immutable manifest for the latest Assets
    // release. It is the authoritative source for the homepage and keeps the
    // read path alive while D1 summary rows are being materialized.
    const staticManifest = await readGitHubAssetsPortalManifest(env);
    if (staticManifest && staticManifest.summary_ready !== false) {
      const payload = statsPayloadFromPortalManifest(staticManifest);
      memoryStats = payload;
      memoryStatsTime = nowTime;
      return json(payload, 200, {
        "cache-control": "public, max-age=600, s-maxage=600",
        "x-summary-source": "github",
      });
    }

    const canonicalForSummary = await env.DB.prepare(
      `SELECT release_id, asset_version, server_schema_version FROM assets_releases ` +
      `WHERE status='canonical' ORDER BY updated_at DESC LIMIT 1`
    ).first();
    const summaryRow = await env.DB.prepare(
      `SELECT value_json, updated_at FROM portal_summary WHERE key='stats'`
    ).first();
    if (summaryRow?.value_json) {
      const parsed = JSON.parse(summaryRow.value_json);
      // A stats cache without the current canonical release identity is
      // historical data; serving it here makes categories look valid while
      // actually coming from a superseded/composite version.
      const summaryBound = Boolean(canonicalForSummary && (
        parsed?.release_id === canonicalForSummary.release_id
        || parsed?.asset_version === canonicalForSummary.asset_version
      ));
      if (!summaryBound) {
        // Continue to the exact canonical release_summaries lookup below.
      } else {
      const payload = {
        ...parsed,
        // The derived row is written by the sync pipeline, so it may lag the
        // response shape this version of the Worker serves. Normalising the
        // canonical fields here means a reader never has to know which of the
        // two branches answered, and a missing field is filled from the same
        // numbers rather than invented.
        summary: parsed.summary || statsSummaryView(parsed),
        accepted: parsed.accepted ?? parsed.translated ?? 0,
        translated: parsed.translated ?? 0,
        untranslated: parsed.untranslated ?? 0,
        pending: parsed.pending ?? 0,
        idols: IDOLS,
        by_idol: Object.fromEntries(IDOLS.map((entry) => [entry.code, entry])),
        summary_updated_at: summaryRow.updated_at,
        summary_stale: (nowTime - Date.parse(summaryRow.updated_at || 0)) > STATS_CACHE_TTL,
      };
      memoryStats = payload;
      memoryStatsTime = nowTime;
      return json(payload, 200, {
        "cache-control": "public, max-age=600, s-maxage=600",
        etag: `W/"stats-${summaryRow.updated_at}"`,
        "x-summary-source": "portal_summary",
      });
      }
    }

    const canonical = canonicalForSummary;
    if (!canonical) return dataNotReady("no canonical assets release is registered");

    const assetSummary = await env.DB.prepare(
      `SELECT total_items, translated_items, pending_items, untranslated_items, reused_items, suggested_items, ` +
      `blocked_items, category_summary_json, updated_at FROM release_summaries ` +
      `WHERE release_kind='assets' AND release_id=?`
    ).bind(canonical.release_id).first();
    if (!assetSummary) return dataNotReady(`release_summaries is empty for ${canonical.release_id}`);

    const categories = JSON.parse(assetSummary.category_summary_json || "{}");
    const progressPercent = assetSummary.total_items > 0
      ? Number(((assetSummary.translated_items / assetSummary.total_items) * 100).toFixed(2))
      : 0;

    const payload = {
      release_kind: "assets",
      release_id: canonical.release_id,
      asset_version: canonical.asset_version,
      server_schema_version: canonical.server_schema_version,
      total: assetSummary.total_items,
      translated: assetSummary.translated_items,
      untranslated: assetSummary.untranslated_items,
      pending: assetSummary.pending_items,
      accepted: assetSummary.translated_items,
      reused_items: assetSummary.reused_items,
      suggested_items: assetSummary.suggested_items,
      blocked_items: assetSummary.blocked_items,
      progress_percent: progressPercent,
      categories,
      summary_updated_at: assetSummary.updated_at,
      summary_stale: (nowTime - Date.parse(assetSummary.updated_at || 0)) > STATS_CACHE_TTL,
      summary: statsSummaryView({
        total: assetSummary.total_items,
        translated: assetSummary.translated_items,
        untranslated: assetSummary.untranslated_items,
        pending: assetSummary.pending_items,
        progress_percent: progressPercent,
      }),
      idols: IDOLS,
      by_idol: Object.fromEntries(IDOLS.map((entry) => [entry.code, entry])),
    };
    memoryStats = payload;
    memoryStatsTime = nowTime;
    return json(payload, 200, {
      "cache-control": "public, max-age=600, s-maxage=600",
      "x-summary-source": "release_summaries",
    });
  } catch (err) {
    if (isQuotaError(err)) return quotaResponse(err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Cursor pagination helpers
// ---------------------------------------------------------------------------

/**
 * Keyset cursors. The cursor carries the last row's sort tuple plus a digest of
 * the query it belongs to, so a cursor cannot be replayed against a different
 * release or filter set. It is integrity-checked, not secret.
 */
function cursorKey() {
  return "mltd-portal-cursor-v1";
}

/// UTF-8 safe base64url. Avoids `escape`/`unescape`, which are legacy globals
/// that are not guaranteed to exist in every JS runtime the worker may target.
function base64UrlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(encoded) {
  const normalized = String(encoded).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

export async function encodeCursor(payload) {
  const body = JSON.stringify(payload);
  const digest = await sha256(`${cursorKey()}:${body}`);
  return base64UrlEncode(JSON.stringify({ b: body, s: digest.slice(0, 32) }));
}

export async function decodeCursor(cursor, expectedScope) {
  try {
    const decoded = JSON.parse(base64UrlDecode(cursor));
    const digest = await sha256(`${cursorKey()}:${decoded.b}`);
    if (digest.slice(0, 32) !== decoded.s) return null;
    const payload = JSON.parse(decoded.b);
    if (expectedScope && payload.scope !== expectedScope) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function readLimit(url, fallback = DEFAULT_PAGE_LIMIT) {
  const parsed = Number.parseInt(url.searchParams.get("limit") || String(fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), MAX_PAGE_LIMIT);
}

// ---------------------------------------------------------------------------
// Catalogue search
// ---------------------------------------------------------------------------

async function searchStaticAssets(request, env, manifest, release) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("query") || url.searchParams.get("keyword") || "").trim().toLowerCase();
  const idolParam = (url.searchParams.get("idol") || "").trim().toLowerCase();
  const categoryParam = (url.searchParams.get("category") || "all").trim().toLowerCase();
  const statusParam = (url.searchParams.get("status") || "all").trim().toLowerCase();
  const limit = readLimit(url);
  const cursor = url.searchParams.get("cursor")
    ? await decodeCursor(url.searchParams.get("cursor"), `assets:${release.release_id}`)
    : { bundle: "", item_key: "" };
  const matches = [];
  let scanned = 0;
  let exhausted = true;
  for (const bundle of staticAssetBundles(manifest, categoryParam)) {
    if (cursor.bundle && bundle < cursor.bundle) continue;
    const rows = await readGitHubAssetsBundleRows(env, release, bundle, Math.min(MAX_SCAN_ROWS, 5000));
    for (const row of rows) {
      if (bundle === cursor.bundle && String(row.item_key).localeCompare(String(cursor.item_key), undefined, { numeric: true }) <= 0) continue;
      scanned += 1;
      const cat = categoryId(row.bundle, row.item_key);
      const domain = CATEGORY_RULES[cat]?.domain;
      const idol = detectIdol(row.bundle, row.item_key, row.source);
      const haystack = `${row.item_key}\n${row.source}`.toLowerCase();
      if (statusParam !== "all" && row.translation_status !== statusParam) continue;
      if (categoryParam !== "all" && categoryParam !== cat && categoryParam !== domain) continue;
      if (idolParam && (!idol || String(idol.code).toLowerCase() !== idolParam)) continue;
      if (query && !haystack.includes(query)) continue;
      matches.push(row);
      if (matches.length >= limit || scanned >= MAX_SCAN_ROWS) { exhausted = false; break; }
    }
    if (!exhausted) break;
  }
  // The release manifest is authoritative for pending counts, while older
  // generated JSONL rows can still carry `accepted` for the same source line.
  // If a status-filtered latest-release query has no materialised match, keep
  // the category usable by returning its pinned rows and explicitly marking
  // the fallback. This prevents a valid category from looking empty while CI
  // catches the row-status lag up.
  if (!matches.length && statusParam !== "all") {
    const fallbackUrl = new URL(request.url);
    fallbackUrl.searchParams.set("status", "all");
    const fallback = await searchStaticAssets(new Request(fallbackUrl, request), env, manifest, release);
    fallback.status_fallback = "all";
    fallback.filters.requested_status = statusParam;
    return fallback;
  }
  const items = [];
  for (const row of matches) items.push(await staticAssetsItem(env, release, row));
  const last = matches[matches.length - 1];
  const hasMore = !exhausted && Boolean(last);
  return {
    scope: { release_kind: "assets", release_id: release.release_id },
    limit,
    next_cursor: hasMore ? await encodeCursor({ scope: `assets:${release.release_id}`, bundle: last.bundle, item_key: last.item_key }) : null,
    has_more: hasMore,
    total_source: null,
    total: null,
    total_note: "latest Assets rows are read from the pinned GitHub locale files",
    scanned_rows: scanned,
    scan_exhausted: exhausted,
    scan_capped: !exhausted && !hasMore,
    filters: { status: statusParam, idol: idolParam || null, category: categoryParam, query: query || null },
    items,
    rows: items,
  };
}

/**
 * Bounded catalogue search.
 *
 * The endpoint this replaces ran, on every request: an unconditional
 * `COUNT(*)` over the catalogue joined against contributions, a `LIMIT ? OFFSET
 * ?` page (so page N skipped N*limit rows), an unconstrained
 * `LIKE '%keyword%'` over both `source` and `item_key`, and — on quota
 * exhaustion — a 200 response with `total: 0` and an empty list.
 *
 * Now: the query is always scoped to one release axis + release id, the default
 * page is a keyset seek on `(bundle, item_key)`, `total` is only returned when
 * the caller explicitly asks for it (and then it comes from the summary table),
 * a keyword search requires an explicit bundle prefix so the LIKE is anchored
 * and short, and quota exhaustion is a 503.
 */
async function searchCatalogue(request, env) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("query") || url.searchParams.get("keyword") || "").trim();
  const idolParam = (url.searchParams.get("idol") || "").trim().toLowerCase();
  const categoryParam = (url.searchParams.get("category") || "all").trim().toLowerCase();
  const statusParam = (url.searchParams.get("status") || "all").trim().toLowerCase();
  const wantTotal = url.searchParams.get("include_total") === "true" || url.searchParams.get("include_total") === "1";
  const releaseKindParam = url.searchParams.get("release_kind");
  const releaseIdParam = (url.searchParams.get("release_id") || "").trim();
  const lookupParam = (url.searchParams.get("lookup") || "").trim();
  const baseVersionParam = (url.searchParams.get("base_version") || "").trim();
  const assetVersionParam = (url.searchParams.get("asset_version") || "").trim();
  const limit = readLimit(url);

  // The latest Assets release is published by GitHub CI before D1 receives a
  // materialized row index. Route that explicit latest axis to the pinned
  // locale files so homepage category/search actions remain usable. The same
  // single resolution decides it: a ref the manifest claims with no usable pin
  // is 503 here too, never a silent fallback to D1 rows of another identity.
  if ((!releaseKindParam || releaseKindParam === "assets") && (assetVersionParam || releaseIdParam)) {
    const source = await resolveReleaseSource(env, "assets", assetVersionParam || releaseIdParam);
    if (source.axis === "broken") throw pinMissingError();
    if (source.axis === "github") {
      const staticManifest = await readGitHubAssetsPortalManifest(env);
      return json(await searchStaticAssets(request, env, staticManifest, source.release), 200, { "cache-control": "public, max-age=30" });
    }
    // `d1`: a genuinely old ref (or a composite caller error) continues below;
    // the registry path is where an invalid version is named.
  }

  try {
    // --- Scope resolution: every query is bound to one release axis + release.
    let releaseKind = releaseKindParam === "client" ? "client" : "assets";
    let releaseId = releaseIdParam;
    let assetVersion = "";
    try {
      assetVersion = assetVersionParam ? normalizeAssetVersionInput(assetVersionParam) : "";
      if (!releaseKindParam && baseVersionParam) {
        assetVersion = normalizeAssetVersionInput(baseVersionParam);
        releaseKind = "assets";
      }
    } catch (err) {
      // A composite Client+Assets string is a caller error, not an asset
      // version: fail closed here instead of resolving it to the asset part.
      if (err instanceof RegistryError && err.code === "composite_version_rejected") {
        throw new HttpError(400, "composite_version_rejected");
      }
      throw err;
    }
    if (!releaseId && releaseKind === "assets") {
      // No release named: fall back to the canonical one the registry reports,
      // which is the release the portal's own header is describing. A version
      // that was named explicitly is still validated, so a caller who asks for
      // an unregistered release is told so rather than being served another.
      if (assetVersion) {
        const release = await getAssetsRelease(env, assetVersion);
        if (!release) throw new HttpError(400, "unregistered_asset_version");
        releaseId = release.release_id;
      } else {
        const canonical = await env.DB.prepare(
          `SELECT release_id FROM assets_releases WHERE status='canonical' ORDER BY updated_at DESC LIMIT 1`
        ).first();
        if (!canonical) throw new HttpError(503, "data_not_ready");
        if (assetVersionParam) throw new HttpError(400, "unregistered_asset_version");
        releaseId = canonical.release_id;
      }
    }
    if (!releaseId) throw new HttpError(400, "release_id_required");

    // --- Point lookup: the studio needs two rows, not a scanned page.
    if (lookupParam) {
      const [bundle, ...rest] = lookupParam.split("/");
      const itemKey = rest.join("/");
      if (!bundle || !itemKey) throw new HttpError(400, "lookup_invalid");
      const row = await fetchCatalogueRow(env, releaseKind, releaseId, bundle, itemKey);
      if (!row) return { scope: { release_kind: releaseKind, release_id: releaseId }, item: null };
      const release = releaseKind === "client" ? await getClientRelease(env, releaseId) : await getAssetsRelease(env, releaseId);
      const decorated = decorateCatalogueRow(row, env, null, release, releaseKind);
      return { scope: { release_kind: releaseKind, release_id: releaseId }, item: decorated, rows: [decorated] };
    }

    // --- Keyset page, with the derived filters applied inside a bounded walk.
    const cursor = url.searchParams.get("cursor") ? await decodeCursor(url.searchParams.get("cursor"), `${releaseKind}:${releaseId}`) : { bundle: "", item_key: "" };
    const page = await fetchFilteredCataloguePage(env, {
      releaseKind, releaseId, cursor, limit, categoryParam,
      filters: { status: statusParam, category: categoryParam, idol: idolParam, query },
    });
    const rows = page.rows;

    // One registry read per page, not per row: the binding a row carries is
    // pinned to the release's commit, and the release is the same for every row.
    const scopeRelease = releaseKind === "client" ? await getClientRelease(env, releaseId) : await getAssetsRelease(env, releaseId);
    const items = rows.map((row) => decorateCatalogueRow(row, env, null, scopeRelease, releaseKind));
    const last = rows[rows.length - 1];
    const hasMore = rows.length === limit && !page.exhausted;
    const nextCursor = hasMore && last
      ? await encodeCursor({ scope: `${releaseKind}:${releaseId}`, bundle: last.bundle, item_key: last.item_key })
      : null;

    // `total` is the release's own item count, which is only the answer to
    // "how many rows match" when nothing was filtered. With a filter in play the
    // honest answer for a page is how many the page holds, plus the fact that
    // the summary total describes the release rather than the filter — so the
    // filtered case reports `total: null` and names the mismatch rather than
    // handing back a number that looks like a match count and is not one.
    const filtersActive = Boolean(
      (statusParam && statusParam !== "all") ||
      (categoryParam && categoryParam !== "all") ||
      idolParam || query,
    );
    let total = null;
    let totalSource = null;
    if (wantTotal && !filtersActive) {
      const summary = await env.DB.prepare(
        `SELECT total_items FROM release_summaries WHERE release_kind=? AND release_id=?`
      ).bind(releaseKind, releaseId).first();
      total = summary ? Number(summary.total_items) : null;
      totalSource = summary ? "release_summaries" : null;
    }

    return {
      scope: { release_kind: releaseKind, release_id: releaseId },
      limit,
      next_cursor: nextCursor,
      has_more: hasMore,
      total_source: totalSource,
      total,
      total_note: wantTotal && filtersActive
        ? "total is null for a filtered query: release_summaries counts the whole release, not the filter"
        : null,
      // How much of the release this page had to walk, and whether the walk
      // stopped on the budget rather than on the data. A caller can tell
      // "no matches" (exhausted) from "no matches found yet" (scan_capped).
      scanned_rows: page.scanned,
      scan_exhausted: page.exhausted,
      scan_capped: page.scan_capped,
      filters: { status: statusParam, idol: idolParam || null, category: categoryParam, query: query || null },
      items,
      rows: items,
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (isQuotaError(err)) return quotaResponse(err, { scope: { release_kind: "unknown", release_id: null } });
    throw err;
  }
}

async function fetchCatalogueRow(env, releaseKind, releaseId, bundle, itemKey) {
  return env.DB.prepare(
    `SELECT sv.bundle, sv.item_key, sv.source, sv.source_sha256, ru.logical_key, r.reuse_mode, r.status AS ref_status, ` +
    `tu.translation, tu.status AS translation_status, tu.updated_at AS translation_updated_at, ` +
    `ru.resource_id, ru.category ` +
    `FROM source_variants sv ` +
    `JOIN resource_units ru ON ru.resource_id = sv.resource_id ` +
    `LEFT JOIN release_resource_refs r ON r.source_variant_id = sv.source_variant_id AND r.release_kind = ? AND r.release_id = ? ` +
    `LEFT JOIN translation_units tu ON tu.translation_id = r.translation_id ` +
    `WHERE sv.release_kind = ? AND sv.release_id = ? AND sv.bundle = ? AND sv.item_key = ? LIMIT 1`
  ).bind(releaseKind, releaseId, releaseKind, releaseId, bundle, itemKey).first();
}

/// A filtered page may need to walk past rows the filter rejects. The walk is
/// bounded so a query that matches nothing cannot turn into a table scan; when
/// the bound is hit the caller says so instead of reporting "no results".
const MAX_SCAN_ROWS = 400;

/**
 * One keyset page. Category filtering happens on the *bundle prefix* so the
 * index can be seeked; an unanchored `LIKE '%…%'` predicate cannot use an index
 * and is what turned the old endpoint into a scan.
 *
 * `status`, `idol` and `query` are applied to the rows the seek returns, not as
 * SQL predicates: `status` lives on the ref row and the other two are derived
 * (`detectIdol`) or unindexed-substring (`query`). Filtering after the seek
 * keeps the ORDER BY on an index path; the cost is a bounded walk, which is why
 * the scan budget exists and the response reports it.
 */
async function fetchCataloguePage(env, { releaseKind, releaseId, cursor, limit, categoryParam }) {
  const where = ["sv.release_kind = ?", "sv.release_id = ?"];
  const predicates = [];

  if (cursor?.bundle) {
    where.push("(sv.bundle > ? OR (sv.bundle = ? AND sv.item_key > ?))");
    predicates.push(cursor.bundle, cursor.bundle, cursor.item_key);
  }

  // The prefix is a *prefilter*: it narrows the seek to an index range, and the
  // derived category check above is what actually decides. A domain (`story`)
  // spans several prefixes and so has none — that case walks bounded instead.
  const prefix = bundlePrefixForCategory(categoryParam);
  if (prefix) {
    // Anchored LIKE only. An equality arm for a truncated stem (`event_`) would
    // narrow the result set to bundles that are exactly that string — none —
    // while an anchored `event_%` is still an index range scan.
    where.push("sv.bundle LIKE ?");
    predicates.push(`${prefix.like}%`);
  }

  const rows = await env.DB.prepare(
    `SELECT sv.bundle, sv.item_key, sv.source, sv.source_sha256, ru.logical_key, r.reuse_mode, r.status AS ref_status, ` +
    `tu.translation, tu.status AS translation_status, tu.updated_at AS translation_updated_at, ` +
    `ru.resource_id, ru.category ` +
    `FROM source_variants sv ` +
    `JOIN resource_units ru ON ru.resource_id = sv.resource_id ` +
    `LEFT JOIN release_resource_refs r ON r.source_variant_id = sv.source_variant_id AND r.release_kind = ? AND r.release_id = ? ` +
    `LEFT JOIN translation_units tu ON tu.translation_id = r.translation_id ` +
    `WHERE ${where.join(" AND ")} ` +
    `ORDER BY sv.bundle ASC, sv.item_key ASC LIMIT ?`
  ).bind(releaseKind, releaseId, releaseKind, releaseId, ...predicates, limit).all();
  return rows.results || [];
}

/// Annotate a page with the review state of any contribution filed against the
/// same source. The ref row records what was *published*; a contribution that is
/// still in the queue is neither accepted nor untranslated, and the studio must
/// see it as `pending` rather than as work that has not started.
///
/// Bounded on purpose: one chunked query per page (never one per row), keyed by
/// the exact (bundle, item_key, source_sha256) triple, so it cannot widen into a
/// scan of the contributions table.
const CONTRIBUTION_LOOKUP_CHUNK = 25;

async function attachPendingContributions(env, rows) {
  if (!rows.length) return rows;
  const byTriple = new Map();
  for (let offset = 0; offset < rows.length; offset += CONTRIBUTION_LOOKUP_CHUNK) {
    const chunk = rows.slice(offset, offset + CONTRIBUTION_LOOKUP_CHUNK);
    const predicates = chunk.map(() => "(bundle=? AND item_key=? AND source_sha256=?)").join(" OR ");
    const params = [];
    for (const row of chunk) params.push(row.bundle, row.item_key, row.source_sha256);
    let result;
    try {
      result = await env.DB.prepare(
        `SELECT bundle, item_key, source_sha256, status FROM contributions WHERE status IN ('pending','needs_review','accepted') AND (${predicates})`
      ).bind(...params).all();
    } catch (err) {
      rethrowQuota(err);
    }
    for (const contribution of result.results || []) {
      byTriple.set(`${contribution.bundle}\u0000${contribution.item_key}\u0000${contribution.source_sha256}`, contribution.status);
    }
  }
  for (const row of rows) {
    const status = byTriple.get(`${row.bundle}\u0000${row.item_key}\u0000${row.source_sha256}`);
    if (status) row.contribution_status = status;
  }
  return rows;
}

/// One bounded seek with the derived filters applied. Returns the matching rows
/// plus how many source rows were inspected and whether the walk stopped on the
/// budget rather than on the end of the release.
async function fetchFilteredCataloguePage(env, { releaseKind, releaseId, cursor, limit, categoryParam, filters = {} }) {
  const matched = [];
  let scanned = 0;
  let walk = cursor || { bundle: "", item_key: "" };
  let exhausted = false;
  while (matched.length < limit && scanned < MAX_SCAN_ROWS) {
    const page = await fetchCataloguePage(env, { releaseKind, releaseId, cursor: walk, limit, categoryParam });
    if (!page.length) { exhausted = true; break; }
    scanned += page.length;
    await attachPendingContributions(env, page);
    for (const row of page) {
      if (matchesCatalogueFilters(row, filters)) matched.push(row);
      if (matched.length >= limit) break;
    }
    const last = page[page.length - 1];
    walk = { bundle: last.bundle, item_key: last.item_key };
    if (page.length < limit) { exhausted = true; break; }
  }
  return { rows: matched.slice(0, limit), scanned, exhausted, scan_capped: !exhausted && matched.length < limit };
}

/// The derived filters, kept in one place so the semantics are explicit: the
/// status is the release-scoped ref status, the category is the same taxonomy
/// (`categoryId`) the UI labels rows with, the idol comes from the same
/// `detectIdol`, and the keyword is a case-insensitive substring over the item
/// key and the source text.
///
/// The category accepts both spellings a caller might use — the taxonomy id
/// (`event_story`, which is what the UI's subcategory grid sends) and the
/// broader domain (`story`) — because the two are different granularities of the
/// same rule, not two rules.
function matchesCatalogueFilters(row, filters = {}) {
  const status = filters.status && filters.status !== "all" ? filters.status : null;
  if (status) {
    const rowStatus = row.translation_status || row.contribution_status || row.ref_status || "untranslated";
    if (rowStatus !== status) return false;
  }
  const category = filters.category && filters.category !== "all" ? filters.category : null;
  if (category) {
    const catId = categoryId(row.bundle, row.item_key);
    const domain = CATEGORY_RULES[catId]?.domain;
    if (category !== catId && category !== domain) return false;
  }
  if (filters.idol) {
    const idol = detectIdol(row.bundle, row.item_key, row.source);
    if (!idol || String(idol.code).toLowerCase() !== filters.idol) return false;
  }
  if (filters.query) {
    const needle = filters.query.toLowerCase();
    const haystack = `${row.item_key || ""}
${row.source || ""}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/// Category -> the bundle prefix that *certainly contains* every match, used as
/// a seek range rather than as the decision. Two cases have no safe prefix and
/// return null: a domain (`story` spans `event_`, `special_` and `st_`), and
/// `system_ui` (the fall-through bucket, which by definition has no prefix). The
/// derived category check is what decides; this only narrows the walk, so a
/// wrong entry here would show up as a missing row and is avoided.
const CATEGORY_BUNDLE_PREFIX = {
  lyrics: "scrobj",
  event_chat: "event_",
  event_story: "event_",
  special_commu: "special_",
  main_commu: "st_",
  card_episode: "card_episode_",
  card_blog: "card_blst_",
  card_skill: "cd_",
  theater_comm: "cm_",
  message_board: "mb_",
  live_result: "liveresult_",
  login_bonus: "lbonus_",
  birth_live: "birth_bdl",
  birth_greet: "birth_",
};

function bundlePrefixForCategory(categoryParam) {
  const prefix = CATEGORY_BUNDLE_PREFIX[String(categoryParam || "").toLowerCase()];
  return prefix ? { like: prefix } : null;
}

/// The repository path a bundle's text lives at.
///
/// The category is a *taxonomy* (`src/categories.js`), and the repository groups
/// its files by the exporter's own five directories, which are coarser
/// (`scripts/export_localization_for_github.py::classify_bundle`). The two are
/// different granularities of the same idea and both are code, not data — so the
/// mapping is a table here rather than a guess, and a bundle the table does not
/// name yields no path at all. That is deliberate: a plausible-looking
/// `locales/master/<bundle>.jsonl` for a file that actually lives in
/// `locales/story/` would be a binding the CI rejects after a contributor has
/// already written a proposal against it.
const EXPORT_DIRECTORY_BY_CATEGORY = {
  lyrics: "lyrics",
  event_chat: "story",
  event_story: "story",
  special_commu: "story",
  main_commu: "story",
  card_episode: "card",
  card_blog: "card",
  card_skill: "card",
  theater_comm: "dialogue",
  message_board: "dialogue",
  live_result: "dialogue",
  login_bonus: "dialogue",
  birth_live: "birth",
  birth_greet: "birth",
  system_ui: "master",
};

/// Where the *client* channel keeps its text, and what shape it is in.
///
/// The assets channel's layout is *generated* — `scripts/export_localization_for_github.py`
/// writes one JSONL per bundle under `locales/`, and this file's
/// `EXPORT_DIRECTORY_BY_CATEGORY` mirrors that generator. The client repository
/// is not generated by it: it is a small, hand-managed set of surfaces, so its
/// layout is a fact about *that* repository and nothing here is entitled to infer
/// it. A guessed path would put a plausible-looking file into a contributor's
/// editor and let them write a proposal against something that does not exist.
///
/// So it is configuration, with no default. Two settings, because the client
/// channel has two shapes:
///
///   * `GITHUB_CLIENT_MANIFEST_PATH` — one JSON manifest whose `slots[]` carry
///     the labelled entries (`{index, ja, zh, provenance}`), which is what the
///     client repository holds today;
///   * `GITHUB_CLIENT_TEXT_DIR` — a directory of `<bundle>.jsonl` files, same row
///     shape as the assets channel, for a surface that has one.
///
/// Unset means the client channel has no verified layout yet, and a client row
/// reports `missing_path` naming the setting — visible, and fixable by whoever
/// owns the repository.
function clientManifestPath(env) {
  const configured = String(env?.GITHUB_CLIENT_MANIFEST_PATH || "").trim().replace(/^\/+/, "");
  if (!configured) return null;
  if (/\.\./.test(configured) || configured.includes("\\")) throw new HttpError(503, "github_client_manifest_path_invalid");
  if (!/\.json$/i.test(configured)) throw new HttpError(503, "github_client_manifest_path_invalid");
  // The assets whitelist describes the *assets* repository. The client one is a
  // different repository with its own layout, so the rule here is that the path
  // is exactly the location the deployment declared — never a prefix match
  // against `locales/`, which would be the other repository's rule.
  return configured;
}

function clientTextDirectory(env) {
  const configured = String(env?.GITHUB_CLIENT_TEXT_DIR || "").trim().replace(/^\/+|\/+$/g, "");
  if (!configured) return null;
  if (/\.\./.test(configured) || /[\\]/.test(configured)) throw new HttpError(503, "github_client_text_dir_invalid");
  return configured;
}

/// `true` when this deployment has declared where client text lives.
function clientTextLayoutConfigured(env) {
  try {
    return Boolean(clientManifestPath(env) || clientTextDirectory(env));
  } catch (_) {
    return false;
  }
}

/// The client channel's path for a bundle, or `null` when no layout is declared.
///
/// A declared manifest wins over a declared directory: it is the more specific
/// statement, and a repository that has one is the one whose labels the portal
/// should be editing.
function clientTextPathForBundle(env, bundle) {
  const manifest = clientManifestPath(env);
  if (manifest) return manifest;
  const name = String(bundle || "").trim();
  if (!name) return null;
  const base = name.replace(/\.(gtx|unity3d)$/i, "");
  if (!base || /[\\/]/.test(base)) return null;
  const directory = clientTextDirectory(env);
  if (!directory) return null;
  return `${directory}/${base}.jsonl`;
}

/// The client channel's own path rule.
///
/// The client repository is not the assets one: its layout is whatever the
/// deployment declared (`GITHUB_CLIENT_MANIFEST_PATH`, or a directory under
/// `GITHUB_CLIENT_TEXT_DIR`). So the check is membership in exactly that set,
/// plus the refusals every channel shares — no traversal, no `.unity3d`.
function requireClientWritablePath(env, path) {
  const clean = String(path ?? "").trim().replace(/^\/+/, "");
  if (typeof path !== "string" || !clean) throw new HttpError(400, "path_invalid");
  if (/\.\./.test(clean) || clean.includes("\\")) throw new HttpError(400, "path_invalid");
  if (/\.unity3d$/i.test(clean)) throw new HttpError(400, "unity3d_upload_rejected");
  const allowed = new Set();
  const manifest = clientManifestPath(env);
  if (manifest) allowed.add(manifest);
  const directory = clientTextDirectory(env);
  if (directory) {
    const prefix = `${directory}/`;
    const rest = clean.startsWith(prefix) ? clean.slice(prefix.length) : "";
    if (rest && !rest.includes("/")) allowed.add(clean);
  }
  if (!allowed.has(clean)) throw new HttpError(400, "path_not_allowed");
  return clean;
}

/// The `locales/<dir>/<bundle>.jsonl` path for a bundle, or `null` when the
/// bundle has no place in the exporter's layout.
function localesPathForBundle(bundle, itemKey = "") {
  const name = String(bundle || "").trim();
  if (!name) return null;
  // Locale exports preserve the `.gtx` filename before adding `.jsonl`;
  // only binary `.unity3d` carriers are stripped here.
  const base = name.replace(/\.unity3d$/i, "");
  if (!base || /[\\/]/.test(base)) return null;
  const category = categoryId(name, itemKey);
  // Lyrics are the one category that does not land under `locales/`: the
  // exporter writes them to `lyrics/songs/<bundle>.jsonl` (see `export_lyrics`
  // in `scripts/export_localization_for_github.py`), which is also where the
  // repository spec puts them. `requireGithubWritablePath` knows the `lyrics/`
  // prefix, so the path is still checked against the same whitelist.
  if (category === "lyrics") return requireGithubWritablePath(`lyrics/songs/${base}.jsonl`, { allowImage: false });
  const directory = EXPORT_DIRECTORY_BY_CATEGORY[category];
  if (!directory) return null;
  try {
    return requireGithubWritablePath(`locales/${directory}/${base}.jsonl`, { allowImage: false });
  } catch (_) {
    return null;
  }
}

function assetsPathMatchesBundle(bundle, itemKey, path) {
  const candidate = String(path || "");
  const declared = localesPathForBundle(bundle, itemKey);
  if (candidate === declared) return true;
  const base = String(bundle || "").trim().replace(/\.unity3d$/i, "");
  return Boolean(base && candidate === `locales/master/${base}.jsonl`);
}

/// The `resource.github` binding for one catalogue row, or `null`.
///
/// `null` is a first-class answer: the row exists, it is readable, and there is
/// simply nothing to propose against yet — the release has no pinned
/// `assets_commit`, or the deployment has not named the repository, or the
/// bundle has no place in the layout. The caller renders "not editable here" and
/// the reason, rather than a binding it cannot honour.
function catalogueGithubBinding(env, { bundle, itemKey = "", sourceSha256 = "", release, releaseKind = "assets" }) {
  const isClient = releaseKind === "client";
  // The pin is the release's own axis column, resolved by the same helper the
  // item routes use — a binding without a commit is not one this route hands out.
  const baseCommit = releasePinnedCommit(isClient ? "client" : "assets", release);
  const sourceHash = String(sourceSha256 || "").trim().toLowerCase();
  if (!baseCommit || !HEX64_ANY.test(sourceHash)) return null;
  try {
    parseRepoSpec(String((isClient ? env?.GITHUB_TARGET_CLIENT : env?.GITHUB_TARGET_ASSETS) || "").trim());
  } catch (_) {
    return null;
  }
  const path = isClient ? clientTextPathForBundle(env, bundle) : localesPathForBundle(bundle, itemKey);
  if (!path) return null;
  // target 是版本轴枚举，不是 owner/repository；与前端提交合同一致。
  return { target: isClient ? "client" : "assets", path, base_commit: baseCommit, source_sha256: sourceHash };
}

function decorateCatalogueRow(row, env, scope = null, release = null, releaseKind = "assets") {
  const cat = detectCategory(row.bundle, row.item_key);
  const idol = detectIdol(row.bundle, row.item_key, row.source);
  const binding = catalogueGithubBinding(env, { bundle: row.bundle, itemKey: row.item_key,
    sourceSha256: row.source_sha256, release, releaseKind });
  return {
    release_kind: releaseKind,
    release_id: release?.release_id || null,
    asset_version: releaseKind === "assets" ? release?.asset_version || null : null,
    client_version: releaseKind === "client" ? release?.client_version || null : null,
    bundle: row.bundle,
    item_key: row.item_key,
    source_sha256: row.source_sha256,
    source: row.source,
    logical_key: row.logical_key || null,
    resource_id: row.resource_id || null,
    category: cat.id,
    category_name: cat.name,
    domain: cat.domain,
    domain_name: cat.domain_name,
    idol: idol ? { code: idol.code, name_ja: idol.name_ja, name_zh: idol.name_zh, color: idol.color, type: idol.type } : null,
    status: row.translation_status || row.contribution_status || row.ref_status || "untranslated",
    translation: row.translation || null,
    reuse_mode: row.reuse_mode || "none",
    contribution_id: null,
    // Where this row can be edited. Null means "not from here", and the client
    // says so instead of assembling a path of its own.
    github: binding,
    edit_endpoint: row.resource_id ? `/api/resources/${encodeURIComponent(row.resource_id)}/edit-context` : null,
  };
}


async function getSongs(request, env) {
  const url = new URL(request.url);
  const queryRaw = (url.searchParams.get("query") || url.searchParams.get("keyword") || "").trim().toLowerCase();
  const typeParam = (url.searchParams.get("type") || "all").trim().toLowerCase();
  let assetVersion;
  try {
    assetVersion = normalizeAssetVersionInput(url.searchParams.get("asset_version") || "") || defaultAssetVersion(env);
  } catch (err) {
    if (err instanceof RegistryError && err.code === "composite_version_rejected") {
      throw new HttpError(400, "composite_version_rejected");
    }
    throw err;
  }
  const limit = readLimit(url);

  let releaseRow;
  try {
    releaseRow = await getAssetsRelease(env, assetVersion);
  } catch (err) {
    if (err instanceof RegistryError && registryErrorStatus(err) === 503) return quotaResponse(err);
    if (err.code === "database_unavailable") throw new HttpError(503, "database_unavailable");
    return quotaResponse(err);
  }
  if (!releaseRow) {
    // No assets release is registered at all: the caller gets an explicit "not
    // ready" instead of an empty song list that looks like "no songs exist".
    return dataNotReady("no assets release is registered, so no song index can be built");
  }

  const releaseId = releaseRow.release_id;
  const cursorParam = url.searchParams.get("cursor") || "";
  const cursor = cursorParam ? await decodeCursor(cursorParam, `assets:${releaseId}:songs`) : null;
  const after = cursor?.bundle || "";

  // Keyset seek on the covering index `(release_kind, release_id, bundle,
  // item_key, source_variant_id)`. `DISTINCT` on the single indexed column
  // collapses the per-slot rows to one row per bundle and is answered from that
  // index; a `MAX(logical_key)`/`COUNT(*)` aggregate over the same rows would be
  // the per-request aggregation this endpoint is being moved off of.
  let rows;
  let summaryRow = null;
  try {
    rows = await env.DB.prepare(
      `SELECT DISTINCT sv.bundle FROM source_variants sv ` +
      `WHERE sv.release_kind='assets' AND sv.release_id=? AND sv.bundle LIKE 'scrobj_%' AND sv.bundle > ? ` +
      `ORDER BY sv.bundle ASC LIMIT ?`
    ).bind(releaseId, after, limit).all();
    summaryRow = await env.DB.prepare(
      `SELECT category_summary_json, total_items, translated_items, updated_at FROM release_summaries ` +
      `WHERE release_kind='assets' AND release_id=?`
    ).bind(releaseId).first();
  } catch (err) {
    if (isQuotaError(err)) return quotaResponse(err);
    throw err;
  }

  // `category_summary_json` carries a per-bundle `{slots, accepted}` map under
  // each category (see rebuildReleaseSummary), so a song card can show its own
  // counts without the Worker walking the release. A summary written by an older
  // build carries a bare number per bundle; that is read as "slots, none
  // accepted" rather than dropped.
  const bundleCounts = {};
  if (summaryRow?.category_summary_json) {
    try {
      const parsed = JSON.parse(summaryRow.category_summary_json);
      for (const bucket of Object.values(parsed || {})) {
        for (const [bundle, entry] of Object.entries(bucket?.bundles || {})) {
          bundleCounts[bundle] = typeof entry === "number"
            ? { slots: Number(entry) || 0, accepted: 0 }
            : { slots: Number(entry?.slots) || 0, accepted: Number(entry?.accepted) || 0 };
        }
      }
    } catch (_) { /* unreadable summary: the catalogue page still renders, with null counts */ }
  }

  const songs = [];
  for (const row of rows.results || []) {
    const asset = String(row.bundle).replace(/^scrobj_/, "").replace(/\.unity3d$/, "").toLowerCase();
    const master = SONG_MASTER[asset] || null;
    const nameJa = master?.name_ja || asset;
    const nameZh = master?.name_zh || "";
    if (typeParam !== "all" && String(master?.type || "All").toLowerCase() !== typeParam) continue;
    if (queryRaw) {
      const haystack = `${nameJa}\u0000${nameZh}\u0000${asset}`.toLowerCase();
      if (!haystack.includes(queryRaw)) continue;
    }
    songs.push({
      bundle: row.bundle,
      asset,
      name_ja: nameJa,
      name_zh: nameZh,
      type: master?.type || "All",
      mst_song_id: master?.mst_song_id || 0,
      slots: bundleCounts[row.bundle]?.slots ?? null,
      translated: bundleCounts[row.bundle]?.accepted ?? null,
      release_id: releaseId,
    });
  }

  const last = (rows.results || [])[rows.results.length - 1];
  // A filtered page reports no release-wide total, and the caller can tell a
  // short page from an exhausted one by the cursor: a filter that dropped every
  // row on this page still carries the seek forward.
  const seekExhausted = (rows.results || []).length < limit;
  return json({
    release_id: releaseId,
    asset_version: releaseRow.asset_version,
    limit,
    // The songs the release itself declares, not a count of files on disk: the
    // song index and this number now come from the same rows.
    total_songs: summaryRow
      ? Object.keys(bundleCounts).filter((bundle) => bundle.startsWith("scrobj_")).length
      : null,
    next_cursor: !seekExhausted && last
      ? await encodeCursor({ scope: `assets:${releaseId}:songs`, bundle: last.bundle })
      : null,
    songs,
  }, 200, { "cache-control": "public, max-age=300, s-maxage=1800" });
}

/**
 * Lyrics for one bundle.
 *
 * The authoritative shape is D1: the release's own `source_variants` carry the
 * source text, its `source_sha256` and its `item_key`, and the ref's
 * `translation_units` row carries the translation and its status. That is the
 * path this handler takes whenever the release is registered.
 *
 * `public/data/lyrics/<bundle>.json` is a retired source-text fallback that
 * predates the release model. It is no longer read here: serving it let an
 * offline extractor snapshot overrule the release that is live now, the exact
 * failure this decoupling removes. A bundle with no release rows is a 404.
 */
async function getSongLyrics(request, env) {
  const url = new URL(request.url);
  const bundle = (url.searchParams.get("bundle") || "").trim();
  if (!bundle) throw new HttpError(400, "bundle_required");
  let assetVersion;
  try {
    assetVersion = normalizeAssetVersionInput(url.searchParams.get("asset_version") || "") || defaultAssetVersion(env);
  } catch (err) {
    if (err instanceof RegistryError && err.code === "composite_version_rejected") {
      throw new HttpError(400, "composite_version_rejected");
    }
    throw err;
  }

  let releaseRow = null;
  try {
    releaseRow = await getAssetsRelease(env, assetVersion);
  } catch (err) {
    if (isQuotaError(err)) return quotaResponse(err);
  }
  const releaseId = releaseRow?.release_id || null;

  // One bundle at a time, joined on the release's own refs. The previous version
  // queried `source_catalogue` with an OR-join on contributions that could match
  // rows across releases, so a translation approved for one assets release could
  // appear under another.
  let dbLines = [];
  if (releaseId) {
    try {
      const rows = await env.DB.prepare(
        `SELECT sv.item_key, sv.source, sv.source_sha256, ru.logical_key, r.reuse_mode, r.status AS ref_status, ` +
        `tu.translation, tu.status AS translation_status, tu.updated_at AS translation_updated_at ` +
        `FROM source_variants sv ` +
        `JOIN resource_units ru ON ru.resource_id = sv.resource_id ` +
        `LEFT JOIN release_resource_refs r ON r.source_variant_id = sv.source_variant_id AND r.release_kind='assets' AND r.release_id = sv.release_id ` +
        `LEFT JOIN translation_units tu ON tu.translation_id = r.translation_id ` +
        `WHERE sv.release_kind='assets' AND sv.release_id=? AND sv.bundle=? ` +
        `ORDER BY CAST(sv.item_key AS INTEGER) ASC, sv.item_key ASC`
      ).bind(releaseId, bundle).all();
      dbLines = rows.results || [];
      // D1 cannot express "join on `ru.resource_id`" and "order by the item
      // key's numeric value" in one plan without walking `resource_units`, so
      // the stable key is resolved by the release's own index instead: one
      // bounded read per bundle, never one per line.
      const logicalKeys = await env.DB.prepare(
        `SELECT sv.item_key, ru.logical_key FROM source_variants sv ` +
        `JOIN resource_units ru ON ru.resource_id = sv.resource_id ` +
        `WHERE sv.release_kind='assets' AND sv.release_id=? AND sv.bundle=?`
      ).bind(releaseId, bundle).all();
      const byItemKey = new Map((logicalKeys.results || []).map((row) => [String(row.item_key), row.logical_key]));
      for (const row of dbLines) row.logical_key = byItemKey.get(String(row.item_key)) || null;
    } catch (err) {
      if (isQuotaError(err)) return quotaResponse(err);
      throw err;
    }
  }

  if (dbLines.length > 0) {
    // The ref row records what was *published*; a submission still in the queue
    // is neither accepted nor untranslated, and the studio must see it as
    // `pending` rather than as work that has not started. One indexed seek
    // scoped to this bundle (`idx_contrib_bundle_key`), never one per line.
    const pendingByKey = new Map();
    try {
      const contributions = await env.DB.prepare(
        `SELECT item_key, source_sha256, translation, status FROM contributions ` +
        `WHERE bundle=? AND asset_version=? AND status IN ('pending','needs_review','accepted')`
      ).bind(bundle, releaseRow.asset_version).all();
      for (const contribution of contributions.results || []) {
        pendingByKey.set(String(contribution.item_key), contribution);
      }
    } catch (err) {
      if (isQuotaError(err)) return quotaResponse(err);
    }

    const lines = dbLines.map((row) => {
      const match = String(row.item_key).match(/\d+/);
      const published = row.translation_status || row.ref_status || "untranslated";
      const contribution = published === "accepted" ? null : pendingByKey.get(String(row.item_key));
      return {
        release_id: releaseId,
        asset_version: releaseRow.asset_version,
        bundle,
        item_key: row.item_key,
        slot_index: match ? parseInt(match[0], 10) : 0,
        source: row.source,
        source_sha256: row.source_sha256,
        logical_key: row.logical_key,
        translation: contribution?.translation || row.translation || null,
        status: contribution?.status || published,
        reuse_mode: row.reuse_mode || "none",
      };
    });
    return json({ bundle, release_id: releaseId, asset_version: releaseRow.asset_version, total_lines: lines.length, lines, source: "release" }, 200, {
      "cache-control": "public, max-age=300, s-maxage=600",
    });
  }

  // No release rows for this bundle: there is nothing authoritative to serve.
  // The old behaviour read the extractor's `/data/lyrics/<bundle>.json` here and
  // reported the file as `source: "source_cache"`. That file is an offline
  // artefact, not a release, so serving it made an unregistered bundle look like
  // a releasable song view. The honest answer is 404: register the release (or
  // the bundle) first.
  if (dbLines.length === 0) throw new HttpError(404, "bundle_not_found");
}

// ============================================================================
// Independent Client Releases API
//
// Client and Assets are two independent axes. A Client release is identified by
// `client_release_id` and never carries an `asset_version`; the endpoints below
// never join the two axes and never return bytes (no APK, ever).
// ============================================================================

// The browser consumes this release manifest instead of carrying a second copy
// of the taxonomy. Counts are still derived from release_summaries; labels,
// domains and entry actions are owned by the Worker so a new category can be
// added without shipping a new frontend bundle.
const IMAGE_MANIFEST_RULES = {
  event: { id: "img_event", domain: "images", name: "活动宣传与公告横幅", description: "游戏活动巡回、资讯公告与演出宣传条幅", icon: "🎪", unit: "张", entry: "images" },
  costume: { id: "img_costume", domain: "images", name: "专属服饰与扭蛋海报", description: "换装服饰上架海报、扭蛋招募与卡面宣传图", icon: "👗", unit: "张", entry: "images" },
  tutorial: { id: "img_tutorial", domain: "images", name: "玩法引导与教学图解", description: "新手教程玩法指南、系统机制流程图示", icon: "📖", unit: "张", entry: "images" },
};

const MANIFEST_DOMAIN_META = {
  lyrics: { name: "歌曲歌词", icon: "🎵" },
  story: { name: "剧场剧情", icon: "📖" },
  card: { name: "卡片物语", icon: "🎴" },
  dialogue: { name: "剧场日常", icon: "🏢" },
  birth: { name: "纪念庆典", icon: "🎂" },
  system: { name: "界面系统", icon: "⚙️" },
  images: { name: "游戏贴图", icon: "🖼️" },
};

function buildResourceManifest({ kind, release, summary, imageSummary = null }) {
  const categories = [];
  const summaryCategories = summary?.categories && typeof summary.categories === "object"
    ? summary.categories
    : {};
  for (const [id, value] of Object.entries(summaryCategories)) {
    const rule = CATEGORY_RULES[id] || {
      id,
      domain: "system",
      name: id,
      description: "当前 release manifest 登记的分类",
      domain_name: "界面系统",
      icon: "📦",
      unit: "句",
      entry: "studio",
    };
    const total = Number(value?.total || 0);
    const accepted = Number(value?.accepted || 0);
    categories.push({
      id: rule.id,
      domain: rule.domain,
      name: rule.name,
      description: rule.description || rule.name,
      icon: rule.icon || "📦",
      unit: rule.unit || "句",
      entry: rule.entry || "studio",
      total,
      accepted,
      pending: Number(value?.pending || 0),
      untranslated: Math.max(0, total - accepted - Number(value?.pending || 0)),
      progress_percent: Number(value?.progress_percent || (total ? ((accepted / total) * 100).toFixed(2) : 0)),
      bundles: value?.bundles && typeof value.bundles === "object" ? value.bundles : {},
    });
  }

  if (kind === "assets" && imageSummary?.counts && typeof imageSummary.counts === "object") {
    for (const [imageCategory, count] of Object.entries(imageSummary.counts)) {
      const rule = IMAGE_MANIFEST_RULES[imageCategory];
      if (!rule) continue;
      categories.push({
        ...rule,
        total: Number(count || 0),
        accepted: null,
        pending: null,
        untranslated: null,
        progress_percent: null,
        bundles: {},
      });
    }
  }

  const domains = [];
  const byDomain = new Map();
  for (const category of categories) {
    let domain = byDomain.get(category.domain);
    if (!domain) {
      const meta = MANIFEST_DOMAIN_META[category.domain] || { name: category.domain, icon: "📦" };
      domain = { id: category.domain, name: meta.name, icon: meta.icon, total: 0, accepted: 0, categories: [] };
      byDomain.set(category.domain, domain);
      domains.push(domain);
    }
    domain.total += Number(category.total || 0);
    domain.accepted += Number(category.accepted || 0);
    domain.categories.push(category.id);
  }
  for (const domain of domains) {
    domain.progress_percent = domain.total ? Number(((domain.accepted / domain.total) * 100).toFixed(2)) : 0;
  }

  return {
    schema: "mltd.portal.resource-manifest/v1",
    kind,
    generated_at: summary?.updated_at || now(),
    summary_ready: Boolean(summary),
    release: release ? { ...release } : null,
    totals: summary ? {
      total: Number(summary.total_items || 0),
      translated: Number(summary.translated_items || 0),
      pending: Number(summary.pending_items || 0),
      untranslated: Number(summary.untranslated_items || 0),
      reused: Number(summary.reused_items || 0),
      suggested: Number(summary.suggested_items || 0),
      blocked: Number(summary.blocked_items || 0),
    } : null,
    domains,
    categories,
    source: {
      summary: "release_summaries",
      manifest_sha256: release?.source_manifest_sha256 || release?.manifest_sha256 || null,
    },
  };
}

export { buildResourceManifest };

async function readReleaseSummary(env, releaseKind, releaseId) {
  const row = await env.DB.prepare(
    `SELECT total_items, translated_items, pending_items, untranslated_items, reused_items, suggested_items, ` +
    `blocked_items, category_summary_json, updated_at FROM release_summaries WHERE release_kind=? AND release_id=?`
  ).bind(releaseKind, releaseId).first();
  if (!row) return null;
  return { ...row, categories: safeJson(row.category_summary_json) };
}

async function readImageManifestSummary(env) {
  const row = await env.DB.prepare(`SELECT value_json, updated_at FROM portal_summary WHERE key='image_categories'`).first();
  if (!row?.value_json) return null;
  const parsed = safeJson(row.value_json);
  const counts = parsed?.counts && typeof parsed.counts === "object" ? parsed.counts : parsed;
  return { counts, updated_at: row.updated_at };
}

async function getClientReleaseManifest(request, env, releaseRef) {
  const source = await resolveReleaseSource(env, "client", releaseRef);
  // 同一条源判定：命中最新的 Client manifest 才会把它的文档整体作为答案；
  // 旧 ref 落到 D1 的 release/summary，绝不会拿到最新 manifest 的内容。
  // manifest 认领了同名的 ref 但 pin 不可用时统一 fail-closed（503），不返回
  // 一份没有任何可用 commit 的 GitHub manifest。
  if (source.axis === "github") {
    const payload = await readGitHubClientPortalManifest(env);
    return json({ ...payload, source: "github" }, 200, { "cache-control": "public, max-age=300" });
  }
  if (source.axis === "broken") throw pinMissingError();
  const resolved = await getClientRelease(env, releaseRef);
  if (!resolved) throw new HttpError(404, "client_release_not_found");
  const release = await env.DB.prepare(`SELECT ${CLIENT_RELEASE_COLUMNS} FROM client_releases WHERE release_id=? LIMIT 1`).bind(resolved.release_id).first();
  const summary = await readReleaseSummary(env, "client", resolved.release_id);
  return json(buildResourceManifest({ kind: "client", release, summary }), 200, { "cache-control": "public, max-age=60" });
}

async function readGitHubAssetsPortalManifest(env) {
  const url = env.ASSETS_PORTAL_MANIFEST_URL || DEFAULT_ASSETS_PORTAL_MANIFEST_URL;
  const nowMs = Date.now();
  if (assetsPortalManifestCache.url === url && assetsPortalManifestCache.expiresAt > nowMs) {
    return assetsPortalManifestCache.value;
  }
  try {
    const response = await fetch(url, {
      cf: { cacheTtl: 300, cacheEverything: true },
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`assets portal manifest HTTP ${response.status}`);
    const payload = await response.json();
    const version = String(payload?.release?.asset_version || "");
    if (payload?.schema !== "mltd.portal.resource-manifest/v1" || payload?.kind !== "assets" || !/^\d+$/.test(version)) {
      throw new Error("invalid assets portal manifest");
    }
    assetsPortalManifestCache = { url, expiresAt: nowMs + ASSETS_PORTAL_MANIFEST_CACHE_TTL, value: payload };
    return payload;
  } catch {
    assetsPortalManifestCache = { url, expiresAt: nowMs + 30_000, value: null };
    return null;
  }
}

function staticAssetBundles(payload, categoryParam = "all") {
  const wanted = String(categoryParam || "all").trim().toLowerCase();
  const seen = new Set();
  const bundles = [];
  for (const category of Array.isArray(payload?.categories) ? payload.categories : []) {
    if (wanted !== "all" && category.id !== wanted && category.domain !== wanted) continue;
    for (const bundle of Object.keys(category.bundles || {}).sort()) {
      if (seen.has(bundle)) continue;
      seen.add(bundle);
      bundles.push(bundle);
    }
  }
  return bundles.sort();
}

function staticAssetRowStatus(row) {
  if (row?.status === "accepted" && row?.zh) return "accepted";
  if (["pending", "needs_review"].includes(String(row?.status || "").toLowerCase()) && row?.zh) return "pending";
  return "untranslated";
}

async function readGitHubAssetsBundleRows(env, release, bundle, maxRows = 0) {
  // 同一 pin 判定：没有一个可用 commit 就不读任何 raw 文件——否则文件内容将无
  // 法被任何 commit 验证。
  const commit = releasePinnedCommit("assets", release);
  const declaredPath = localesPathForBundle(bundle, "");
  if (!commit || !declaredPath) return [];
  // A few historical bundles (notably CM/MD) are published under master even
  // though the taxonomy maps them to a semantic directory. Try the declared
  // generator path first, then the repository's verified master fallback.
  const baseName = String(bundle).replace(/\.unity3d$/i, "");
  const candidates = [declaredPath];
  const masterPath = `locales/master/${baseName}.jsonl`;
  if (!candidates.includes(masterPath)) candidates.push(masterPath);
  const key = `${commit}:${candidates.join("|")}`;
  const cached = assetsBundleRowsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.rows;
  try {
    // 目标仓适配：与编辑/写路径同一个 `GITHUB_TARGET_ASSETS`；未配置时退回
    // 公开仓默认。读取仍钉在 release 自己的 commit 上。
    let spec = null;
    try { spec = parseRepoSpec(String(env?.GITHUB_TARGET_ASSETS || "").trim()); } catch (_) { spec = null; }
    const owner = spec?.owner || "kohakunamori";
    const repo = spec?.repo || "MLTDTranslationAssets";
    let response = null;
    let actualPath = declaredPath;
    for (const candidate of candidates) {
      const candidateResponse = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${candidate}`, {
        cf: { cacheTtl: 300, cacheEverything: true },
        headers: { accept: "application/x-ndjson, application/json, text/plain" },
      });
      if (candidateResponse.ok) { response = candidateResponse; actualPath = candidate; break; }
    }
    if (!response) return [];
    const text = await response.text();
    const rows = [];
    const lines = maxRows > 0 ? text.split("\n", maxRows + 1) : text.split("\n");
    for (const line of lines) {
      if (maxRows > 0 && rows.length >= maxRows) break;
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch (_) { continue; }
      const itemKey = String(row?.item_key || "").trim();
      if (!itemKey || typeof row?.ja !== "string") continue;
      rows.push({
        bundle: String(row.bundle || bundle),
        github_path: actualPath,
        item_key: itemKey,
        source: row.ja,
        source_sha256: String(row.source_sha256 || "").trim().toLowerCase() || await sha256(row.ja),
        logical_key: String(row.logical_key || `${bundle}:${itemKey}`),
        translation: typeof row.zh === "string" ? row.zh : null,
        translation_status: staticAssetRowStatus(row),
      });
    }
    rows.sort((a, b) => String(a.item_key).localeCompare(String(b.item_key), undefined, { numeric: true }));
    assetsBundleRowsCache.set(key, { expiresAt: Date.now() + ASSETS_PORTAL_MANIFEST_CACHE_TTL, rows });
    return rows;
  } catch (_) {
    return [];
  }
}

async function staticAssetsItem(env, release, row) {
  const path = row.github_path || localesPathForBundle(row.bundle, row.item_key);
  const baseCommit = releasePinnedCommit("assets", release);
  const github = path && baseCommit
    ? { target: "assets", path, base_commit: baseCommit, source_sha256: row.source_sha256 }
    : null;
  const cat = detectCategory(row.bundle, row.item_key);
  const idol = detectIdol(row.bundle, row.item_key, row.source);
  return {
    release_kind: "assets",
    release_id: release.release_id,
    asset_version: release.asset_version,
    bundle: row.bundle,
    item_key: row.item_key,
    source_sha256: row.source_sha256,
    logical_key: row.logical_key,
    category: cat.id,
    category_name: cat.name,
    domain: cat.domain,
    domain_name: cat.domain_name,
    status: row.translation_status || "untranslated",
    translation: row.translation || null,
    source: row.source,
    resource_id: null,
    idol: idol ? { code: idol.code, name_ja: idol.name_ja, name_zh: idol.name_zh, color: idol.color, type: idol.type } : null,
    github,
    edit_endpoint: `/api/assets/releases/${encodeURIComponent(String(release.release_id))}/item/edit-context?bundle=${encodeURIComponent(row.bundle)}&item_key=${encodeURIComponent(row.item_key)}`,
  };
}

async function getStaticAssetsItemContext(request, env, releaseRef) {
  const source = await resolveReleaseSource(env, "assets", releaseRef);
  if (source.axis === "broken") throw pinMissingError();
  const release = source.axis === "github" ? source.release : null;
  if (!release) throw new HttpError(404, "assets_release_not_found");
  const url = new URL(request.url);
  const bundle = String(url.searchParams.get("bundle") || "").trim();
  const itemKey = String(url.searchParams.get("item_key") || url.searchParams.get("key") || "").trim();
  if (!bundle || !itemKey) throw new HttpError(400, "bundle_and_item_key_required");
  const row = (await readGitHubAssetsBundleRows(env, release, bundle, 5000)).find((entry) => entry.item_key === itemKey);
  if (!row) throw new HttpError(404, "release_item_not_found");
  const item = await staticAssetsItem(env, release, row);
  if (!item.github) return { editable: false, reason: "assets_manifest_binding_unavailable" };
  return {
    editable: true,
    github: item.github,
    logical_key: item.logical_key,
    bundle: item.bundle,
    item_key: item.item_key,
    row_kind: "jsonl_row",
    resource_kind: "text",
    source: item.source,
    translation: item.translation,
    translation_status: item.status,
    asset_version: release.asset_version,
    client_version: null,
  };
}

async function readGitHubClientPortalManifest(env) {
  const url = env.CLIENT_PORTAL_MANIFEST_URL || DEFAULT_CLIENT_PORTAL_MANIFEST_URL;
  const nowMs = Date.now();
  if (clientPortalManifestCache.url === url && clientPortalManifestCache.expiresAt > nowMs) {
    return clientPortalManifestCache.value;
  }
  try {
    const response = await fetch(url, {
      cf: { cacheTtl: 300, cacheEverything: true },
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`client portal manifest HTTP ${response.status}`);
    const payload = await response.json();
    const version = String(payload?.release?.client_version || "");
    if (payload?.schema !== "mltd.portal.resource-manifest/v1" || payload?.kind !== "client" || !/^\d+(?:\.\d+)+$/.test(version)) {
      throw new Error("invalid client portal manifest");
    }
    clientPortalManifestCache = { url, expiresAt: nowMs + ASSETS_PORTAL_MANIFEST_CACHE_TTL, value: payload };
    return payload;
  } catch {
    clientPortalManifestCache = { url, expiresAt: nowMs + 30_000, value: null };
    return null;
  }
}

/// The client release manifest is a summary; the seven editable labels live in
/// the repository's pinned bottom-bar manifest.
///
/// 读取必须钉在 CI manifest 给出的 commit 上：main 上的同名文件不是这个
/// release 的内容，用它的字节贴一个旧 pin 就是「来源不可证」。`CLIENT_ITEMS_MANIFEST_URL`
/// 仍可覆盖（部署/测试用），但当它明确钉了 `/<sha>/` 段时必须以调用方解析出的
/// commit 为准——两份数据对同一个 release 只能有一个答案。
///
/// 返回 `null` 表示该 commit 下没有可用的槽位文件；调用方据此拒绝（503），
/// 绝不允许退回未钉住的字节。
async function readClientItemsManifestAtPin(env, commit) {
  const pinned = String(commit || "").trim().toLowerCase();
  if (!FULL_SHA.test(pinned)) return null;
  const url = clientItemsManifestUrl(env, pinned);
  const nowMs = Date.now();
  // 缓存键带上 pin：同一个 release 的槽位内容只在它自己的 commit 下才有意义。
  const cacheKey = `${pinned}:${url}`;
  if (clientItemsManifestCache.url === cacheKey && clientItemsManifestCache.expiresAt > nowMs) {
    return clientItemsManifestCache.value;
  }
  try {
    const response = await fetch(url, {
      cf: { cacheTtl: 300, cacheEverything: true },
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`client items manifest HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.kind !== "mltd-bottom-bar-manifest" || !Array.isArray(payload.slots) || !payload.slots.length) {
      throw new Error("invalid client items manifest");
    }
    const slots = payload.slots.filter((slot) => slot && Number.isInteger(Number(slot.index)) && typeof slot.ja === "string");
    if (slots.length !== payload.slots.length) throw new Error("invalid client item slot");
    clientItemsManifestCache = { url: cacheKey, expiresAt: nowMs + ASSETS_PORTAL_MANIFEST_CACHE_TTL, value: { ...payload, slots } };
    return clientItemsManifestCache.value;
  } catch {
    clientItemsManifestCache = { url: cacheKey, expiresAt: nowMs + 30_000, value: null };
    return null;
  }
}

/// 某个 commit 下该读的 Client 槽位文件 URL。
///
/// 目标仓适配：优先沿用部署声明的 `GITHUB_TARGET_CLIENT`（与写入路径同一个
/// 仓库来源），未配置时退回公开仓默认；路径优先沿用 `GITHUB_CLIENT_MANIFEST_PATH`
/// （与编辑绑定同一个声明）。`CLIENT_ITEMS_MANIFEST_URL` 若已配置且是
/// `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>` 形状，则把 `<ref>`
/// 段改写成解析出的 commit —— main 上的同名文件不是这个 release 的内容；其
/// 它形状（测试的 `data:`、镜像）原样使用，其内容仍须通过 kind/slots 校验。
function clientItemsManifestUrl(env, commit) {
  const configured = String(env?.CLIENT_ITEMS_MANIFEST_URL || "").trim();
  if (configured) {
    const match = /^(https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/)([^/]+)(\/.*)$/.exec(configured);
    if (!match) return configured;
    return `${match[1]}${commit}${match[3]}`;
  }
  let spec = null;
  try { spec = parseRepoSpec(String(env?.GITHUB_TARGET_CLIENT || "").trim()); } catch (_) { spec = null; }
  const owner = spec?.owner || "kohakunamori";
  const repo = spec?.repo || "MLTDTranslationClient";
  let path = "manifests/bottom-bar.manifest.json";
  try { path = clientManifestPath(env) || path; } catch (_) { /* 未声明/非法时用默认公开路径 */ }
  return `https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${path}`;
}

function assetsPortalManifestRelease(payload) {
  if (!payload?.release) return null;
  return {
    ...payload.release,
    note: payload.release.note || "Assets GitHub manifest (CI)",
    source: "github",
  };
}

function clientPortalManifestRelease(payload) {
  if (!payload?.release) return null;
  return {
    ...payload.release,
    note: payload.release.note || "Client GitHub manifest (CI)",
    source: "github",
  };
}

/// 单源解析（双轴共用）：把 kind/ref 一次性判成来源轴与 release。
///
/// list / manifest / summary / items / detail / edit-context 都从这里拿同一个
/// source-bound 结果，因此同一 ref 在各路径上得到同一身份与同一 commit。
/// 判定只读该轴 CI manifest 自带的版本与 release id，绝不借用另一轴或 D1 的
/// 行；`matched=false` 表示这个 ref 属于旧版本，必须走 D1 历史路径（latest
/// manifest 不得代答）。Client 与 Assets 的版本模式在此分别适配，两轴的 schema
/// 差异不外溢到调用方。
function releaseSourceForRef(kind, ref, payload) {
  const text = String(ref || "").trim();
  if (!text || !payload?.release) return { matched: false, axis: null, release: null };
  const release = kind === "client" ? clientPortalManifestRelease(payload) : assetsPortalManifestRelease(payload);
  if (!release) return { matched: false, axis: null, release: null };
  const versionField = kind === "client" ? "client_version" : "asset_version";
  const matched = text === String(release[versionField] ?? "") || text === String(release.release_id ?? "");
  return matched ? { matched: true, axis: "github", release } : { matched: false, axis: null, release: null };
}

/// The commit a release pins its files to, on its own axis, or `null`.
///
/// One place decides which column is the pin (`assets_commit` for Assets,
/// `client_resources_commit` for Client) and what counts as a commit. Item
/// routes serve rows only when this returns a sha: a release whose pin cannot
/// be read is answered from D1 history rather than by files no commit verifies.
function releasePinnedCommit(kind, release) {
  const value = String((kind === "client" ? release?.client_resources_commit : release?.assets_commit) || "").trim().toLowerCase();
  return FULL_SHA.test(value) ? value : null;
}

/// Whether the CI manifest's own release can serve item rows at all.
function staticReleaseUsable(kind, release) {
  return Boolean(release) && releasePinnedCommit(kind, release) !== null;
}

/// 双轴共用的解析结果：`axis` 三态 + `release` + `pin`。
///
/// 这是各路径唯一的「D1 历史 vs latest source」决策点，同一 ref（bare version
/// 或 explicit id）在 list / manifest / summary / items / detail / edit-context
/// 上必须得到同一个结果：
///
///   * `github`    —— manifest 同名且 pin 合法：全部路径用 manifest 身份与 pin；
///   * `broken`    —— manifest 同名但 pin 缺失/非法：**fail-closed**。该 ref 的
///                    身份归 CI manifest，但任何一个文件、任何一条 item 都没有
///                    可用 commit 验证，所以不允许混用 GitHub metadata 与 D1 旧
///                    items，也不允许退回 D1 假装这个版本是历史行。调用方回答
///                    503（`release_pin_missing`）；
///   * `d1`        —— 真旧 ref（manifest 不认领）：只读 D1 历史行；
///   * `none`      —— 两边都没有：404。
async function resolveReleaseSource(env, kind, ref) {
  const payload = kind === "client"
    ? await readGitHubClientPortalManifest(env)
    : await readGitHubAssetsPortalManifest(env);
  const source = releaseSourceForRef(kind, ref, payload);
  if (source.axis === "github") {
    if (!staticReleaseUsable(kind, source.release)) {
      return { axis: "broken", release: source.release, pin: null, kind, ref: String(ref || "").trim() };
    }
    return { axis: "github", release: source.release, pin: releasePinnedCommit(kind, source.release), kind, ref: String(ref || "").trim() };
  }
  return { axis: "d1", release: null, pin: null, kind, ref: String(ref || "").trim(), matched: source.matched };
}

/// `broken` 的统一答案：该 ref 已被 CI manifest 认领但 pin 不可用。独立成
/// 异常，让读路径与写路径得到同一个 503 与同一个 code；`release_id` 放在
/// `detail` 里，绝不编造一个可用的 commit。
function pinMissingError() {
  return new HttpError(503, "release_pin_missing");
}

async function getAssetsReleaseManifest(request, env, releaseRef) {
  const source = await resolveReleaseSource(env, "assets", releaseRef);
  if (source.axis === "github") {
    const payload = await readGitHubAssetsPortalManifest(env);
    return json({ ...payload, source: "github" }, 200, { "cache-control": "public, max-age=300" });
  }
  if (source.axis === "broken") throw pinMissingError();
  const release = await env.DB.prepare(`SELECT ${ASSETS_RELEASE_COLUMNS} FROM assets_releases WHERE release_id=? OR asset_version=? LIMIT 1`).bind(releaseRef, releaseRef).first();
  if (!release) throw new HttpError(404, "assets_release_not_found");
  // Do not fall back to portal_summary here: older rows can belong to a
  // superseded/composite release and would silently mislabel the latest axis.
  // The sync pipeline must rebuild this exact release_summaries row first.
  const summary = await readReleaseSummary(env, "assets", release.release_id);
  const imageSummary = await readImageManifestSummary(env);
  return json(buildResourceManifest({ kind: "assets", release, summary, imageSummary }), 200, { "cache-control": "public, max-age=60" });
}

const CLIENT_RELEASE_COLUMNS =
  `release_id, client_version, abi, base_apk_sha256, client_resources_commit, manifest_sha256, ` +
  `output_apk_sha256, release_url, status, created_at, published_at`;

async function getClientReleases(request, env) {
  const url = new URL(request.url);
  const limit = readLimit(url, 20);
  try {
    const rows = await env.DB.prepare(
      `SELECT ${CLIENT_RELEASE_COLUMNS} FROM client_releases ORDER BY created_at DESC LIMIT ?`
    ).bind(limit).all();
    const releases = [...(rows.results || [])];
    const latest = clientPortalManifestRelease(await readGitHubClientPortalManifest(env));
    if (latest && !releases.some((row) => String(row.release_id) === String(latest.release_id))) releases.push(latest);
    releases.sort((a, b) => String(b.client_version || "").localeCompare(String(a.client_version || ""), undefined, { numeric: true }) || String(b.created_at || "").localeCompare(String(a.created_at || "")));
    releases.splice(limit);
    const last = releases[releases.length - 1];
    return json({
      releases,
      limit,
      // Client releases are a handful of rows; an opaque cursor is still
      // returned so a client never learns to page by offset.
      next_cursor: releases.length === limit && last
        ? await encodeCursor({ scope: "client:releases", created_at: last.created_at, release_id: last.release_id })
        : null,
    }, 200, { "cache-control": "public, max-age=60" });
  } catch (err) {
    if (isQuotaError(err)) return quotaResponse(err);
    throw err;
  }
}

async function getClientReleaseDetail(request, env, releaseRef) {
  // Reached by release id or by bare client version, through the same single
  // source resolution the item routes use, so a selector that holds one
  // identifier can walk the whole channel — and an older ref is answered from
  // D1, never from the latest manifest.
  const source = await resolveReleaseSource(env, "client", releaseRef);
  if (source.axis === "github") {
    return json({ release: source.release }, 200, { "cache-control": "public, max-age=300" });
  }
  if (source.axis === "broken") throw pinMissingError();
  const resolved = await getClientRelease(env, releaseRef);
  if (!resolved) throw new HttpError(404, "client_release_not_found");
  const row = await env.DB.prepare(
    `SELECT ${CLIENT_RELEASE_COLUMNS} FROM client_releases WHERE release_id=? LIMIT 1`
  ).bind(resolved.release_id).first();
  if (!row) throw new HttpError(404, "client_release_not_found");
  return json({ release: row }, 200, { "cache-control": "public, max-age=60" });
}

/**
 * One summary row. A missing summary is explicitly `data_not_ready` rather than
 * a fabricated all-zero release, because zeros are indistinguishable from a real
 * empty release and would show up in the UI as "0 translated, 0 total".
 */
async function getClientReleaseSummary(request, env, releaseId) {
  const source = await resolveReleaseSource(env, "client", releaseId);
  // 一条源判定贯穿：只有 ref 命中该 manifest 自己的版本/release id 才用
  // GitHub 汇总；历史 ref 的汇总来自它自己的 release_summaries 行；manifest
  // 认领但 pin 不可用时 503，不让汇总与 items 落在两个来源上。
  if (source.axis === "broken") throw pinMissingError();
  if (source.axis === "github") {
    const staticManifest = await readGitHubClientPortalManifest(env);
    const totals = staticManifest.totals || {};
    return json({
      release_kind: "client",
      release_id: staticManifest.release.release_id,
      summary_ready: true,
      total_items: totals.total || 0,
      translated_items: totals.translated || 0,
      pending_items: totals.pending || 0,
      untranslated_items: totals.untranslated || 0,
      reused_items: totals.reused || 0,
      suggested_items: totals.suggested || 0,
      blocked_items: totals.blocked || 0,
      categories: staticManifest.categories || [],
      source: "github",
      updated_at: staticManifest.release.updated_at || now(),
    }, 200, { "cache-control": "public, max-age=300" });
  }
  let row;
  try {
    row = await env.DB.prepare(
      `SELECT total_items, translated_items, pending_items, untranslated_items, reused_items, suggested_items, ` +
      `blocked_items, category_summary_json, updated_at FROM release_summaries WHERE release_kind='client' AND release_id=?`
    ).bind(releaseId).first();
  } catch (err) {
    if (isQuotaError(err)) return quotaResponse(err);
    throw err;
  }
  if (!row) {
    return json({
      release_kind: "client",
      release_id: releaseId,
      summary_ready: false,
      error: "data_not_ready",
      detail: "release_summaries has no row for this client release yet",
      generated_at: now(),
    }, 503, { "cache-control": "no-store" });
  }
  return json({
    release_kind: "client",
    release_id: releaseId,
    summary_ready: true,
    ...row,
    categories: safeJson(row.category_summary_json),
  }, 200, { "cache-control": "public, max-age=300" });
}

function clientStaticItemIdentity(slot) {
  return `client:bottom-bar:${String(slot.index)}`;
}

async function clientStaticItem(env, release, slot) {
  const source = String(slot.ja);
  const itemKey = String(slot.index);
  const sourceSha256 = await sha256(source);
  const translated = typeof slot.zh === "string" ? slot.zh : (typeof slot.translation === "string" ? slot.translation : null);
  const path = clientTextPathForBundle(env, "manifests/bottom-bar.manifest.json");
  const baseCommit = releasePinnedCommit("client", release);
  const github = path && baseCommit
    ? { target: "client", path, base_commit: baseCommit, source_sha256: sourceSha256 }
    : null;
  return {
    release_kind: "client",
    release_id: release.release_id,
    client_version: release.client_version,
    bundle: "manifests/bottom-bar.manifest.json",
    item_key: itemKey,
    source_sha256: sourceSha256,
    logical_key: clientStaticItemIdentity(slot),
    category: "system_ui",
    category_name: "系统菜单与玩法规则",
    domain: "master",
    domain_name: "系统与主界面",
    status: translated ? "accepted" : "untranslated",
    translation: translated,
    source,
    resource_id: null,
    github,
    edit_endpoint: `/api/client/releases/${encodeURIComponent(String(release.release_id))}/item/edit-context?bundle=${encodeURIComponent("manifests/bottom-bar.manifest.json")}&item_key=${encodeURIComponent(itemKey)}`,
  };
}

async function getClientStaticItemContext(request, env, releaseRef) {
  const source = await resolveReleaseSource(env, "client", releaseRef);
  if (source.axis === "broken") throw pinMissingError();
  const staticRelease = source.axis === "github" ? source.release : null;
  if (!staticRelease) throw new HttpError(404, "client_release_not_found");
  const itemsManifest = await readClientItemsManifestAtPin(env, source.pin);
  const url = new URL(request.url);
  const itemKey = String(url.searchParams.get("item_key") || url.searchParams.get("key") || "").trim();
  const bundle = String(url.searchParams.get("bundle") || "").trim();
  if (bundle !== "manifests/bottom-bar.manifest.json" || !/^\d+$/.test(itemKey)) {
    throw new HttpError(400, "bundle_and_item_key_required");
  }
  if (!itemsManifest?.slots?.length) throw new HttpError(503, "client_items_unavailable");
  const slot = itemsManifest.slots.find((entry) => String(entry.index) === itemKey);
  if (!slot) throw new HttpError(404, "release_item_not_found");
  const item = await clientStaticItem(env, staticRelease, slot);
  if (!item.github) return { editable: false, reason: "client_manifest_binding_unavailable", detail: "Client manifest path or commit is not configured" };
  return {
    editable: true,
    github: item.github,
    logical_key: item.logical_key,
    bundle: item.bundle,
    item_key: item.item_key,
    row_kind: "manifest_slot",
    resource_kind: "text",
    source: item.source,
    translation: item.translation,
    translation_status: item.status,
    asset_version: null,
    client_version: staticRelease.client_version,
  };
}

async function getClientReleaseItems(request, env, releaseRef) {
  const url = new URL(request.url);
  const limit = readLimit(url, 20);
  const cursorParam = url.searchParams.get("cursor") || "";

  const source = await resolveReleaseSource(env, "client", releaseRef);
  // 同一 ref 的 manifest/summary/detail 与 items 必须落在同一来源：manifest 认
  // 领了同名 ref 但 pin 不可用时，items 也 503，而不是悄悄退回 D1 旧行——那会
  // 让「身份来自 CI」与「内容来自历史」混在同一页里。
  if (source.axis === "broken") throw pinMissingError();
  const staticRelease = source.axis === "github" ? source.release : null;
  if (staticRelease) {
    // 历史行可能存在同一个 client_version 的其它 ABI release（probe3 反例）：
    // GitHub 分支的 release_id 必须是 manifest 自己的身份，绝不取名版本号在
    // D1 里「最接近」的那一行。D1 分支才做 registry 解析。
    const cursor = cursorParam
      ? await decodeCursor(cursorParam, `client:${staticRelease.release_id}:items`)
      : null;
    const after = cursor || { bundle: "", item_key: "" };
    const itemsManifest = await readClientItemsManifestAtPin(env, source.pin);
    if (itemsManifest?.slots?.length) {
      const start = Number.isInteger(Number(after.item_index)) ? Number(after.item_index) + 1 : 0;
      const selected = itemsManifest.slots.slice(start, start + limit);
      const items = [];
      for (const slot of selected) items.push(await clientStaticItem(env, staticRelease, slot));
      const last = selected[selected.length - 1];
      return json({
        release_id: staticRelease.release_id,
        limit,
        next_cursor: selected.length === limit && last
          ? await encodeCursor({ scope: `client:${staticRelease.release_id}:items`, item_index: Number(last.index) })
          : null,
        has_more: selected.length === limit && start + selected.length < itemsManifest.slots.length,
        items,
        source: "github",
      }, 200, { "cache-control": "public, max-age=60" });
    }
    // 该 pin 下取不到槽位文件：内容无法被 commit 验证，拒绝而不是改用任何
    // 未钉住的字节（例如 main 上的同名文件）。
    throw new HttpError(503, "client_items_unavailable");
  }

  // The selector holds a client *version*; the variants reference a release
  // *id*. D1 history is reached by either, the same way an assets release is.
  const resolved = await getClientRelease(env, releaseRef);
  const releaseId = resolved?.release_id || releaseRef;
  const cursor = cursorParam ? await decodeCursor(cursorParam, `client:${releaseId}:items`) : null;
  const after = cursor || { bundle: "", item_key: "" };

  try {
    const rows = await env.DB.prepare(
      `SELECT sv.source_variant_id, sv.bundle, sv.item_key, sv.source_sha256, ru.logical_key, r.reuse_mode, r.reused_from_release_id, ` +
      `r.status, tu.translation, tu.translation_id ` +
      `FROM source_variants sv ` +
      `JOIN resource_units ru ON ru.resource_id = sv.resource_id ` +
      `LEFT JOIN release_resource_refs r ON r.source_variant_id=sv.source_variant_id AND r.release_kind='client' AND r.release_id=sv.release_id ` +
      `LEFT JOIN translation_units tu ON tu.translation_id=r.translation_id ` +
      `WHERE sv.release_kind='client' AND sv.release_id=? AND (sv.bundle > ? OR (sv.bundle = ? AND sv.item_key > ?)) ` +
      `ORDER BY sv.bundle ASC, sv.item_key ASC LIMIT ?`
    ).bind(releaseId, after.bundle, after.bundle, after.item_key, limit).all();

    const items = rows.results || [];
    const last = items[items.length - 1];
    // `source` is deliberately not returned in list pages: it is the bulk of the
    // payload, and the detail route has it. This is what keeps a page bounded.
    return json({
      release_id: releaseId,
      limit,
      next_cursor: items.length === limit && last
        ? await encodeCursor({ scope: `client:${releaseId}:items`, bundle: last.bundle, item_key: last.item_key })
        : null,
      has_more: items.length === limit,
      items,
    }, 200, { "cache-control": "public, max-age=60" });
  } catch (err) {
    if (isQuotaError(err)) return quotaResponse(err);
    throw err;
  }
}

// ============================================================================
// Independent Assets Releases API
// ============================================================================

const ASSETS_RELEASE_COLUMNS =
  `asset_version, release_id, server_schema_version, status, source_manifest_sha256, assets_commit, note, created_at, updated_at, published_at`;

async function getAssetsReleases(request, env) {
  const url = new URL(request.url);
  const limit = readLimit(url, 20);
  try {
    const staticManifest = await readGitHubAssetsPortalManifest(env);
    const staticRelease = assetsPortalManifestRelease(staticManifest);
    let releases = [];
    try {
      const rows = await env.DB.prepare(
        `SELECT ${ASSETS_RELEASE_COLUMNS} FROM assets_releases ORDER BY updated_at DESC, asset_version DESC LIMIT ?`
      ).bind(limit).all();
      releases = [...(rows.results || [])];
    } catch (err) {
      if (!staticRelease) throw err;
    }
    if (staticRelease && !releases.some((row) => String(row.asset_version) === String(staticRelease.asset_version))) {
      releases.push(staticRelease);
    }
    releases.sort((a, b) => Number(b.asset_version || 0) - Number(a.asset_version || 0) || String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    releases.splice(limit);
    const last = releases[releases.length - 1];
    return json({
      releases,
      limit,
      next_cursor: releases.length === limit && last
        ? await encodeCursor({ scope: "assets:releases", updated_at: last.updated_at, asset_version: last.asset_version })
        : null,
    }, 200, { "cache-control": "public, max-age=60" });
  } catch (err) {
    if (isQuotaError(err)) return quotaResponse(err);
    throw err;
  }
}

async function getAssetsReleaseDetail(request, env, releaseRef) {
  const source = await resolveReleaseSource(env, "assets", releaseRef);
  if (source.axis === "github") {
    return json({ release: source.release }, 200, { "cache-control": "public, max-age=300" });
  }
  if (source.axis === "broken") throw pinMissingError();
  let row;
  try {
    row = await env.DB.prepare(
      `SELECT ${ASSETS_RELEASE_COLUMNS} FROM assets_releases WHERE release_id=? OR asset_version=? LIMIT 1`
    ).bind(releaseRef, releaseRef).first();
  } catch (err) {
    if (isQuotaError(err)) return quotaResponse(err);
    throw err;
  }
  if (!row) throw new HttpError(404, "assets_release_not_found");
  return json({ release: row }, 200, { "cache-control": "public, max-age=60" });
}

async function getAssetsReleaseSummary(request, env, releaseRef) {
  const source = await resolveReleaseSource(env, "assets", releaseRef);
  if (source.axis === "broken") throw pinMissingError();
  if (source.axis === "github") {
    const staticManifest = await readGitHubAssetsPortalManifest(env);
    const totals = staticManifest.totals || {};
    return json({
      release_kind: "assets",
      release_id: staticManifest.release.release_id,
      summary_ready: true,
      total_items: totals.total || 0,
      translated_items: totals.translated || 0,
      pending_items: totals.pending || 0,
      untranslated_items: totals.untranslated || 0,
      reused_items: totals.reused || 0,
      suggested_items: totals.suggested || 0,
      blocked_items: totals.blocked || 0,
      categories: staticManifest.categories || [],
      source: "github",
      updated_at: staticManifest.release.updated_at || now(),
    }, 200, { "cache-control": "public, max-age=300" });
  }
  // Accept both `1077100` and `assets-1077100` for convenience, but normalise to
  // the registry's own release_id before touching release_summaries.
  let resolvedId = releaseRef;
  try {
    const releaseRow = await env.DB.prepare(
      `SELECT release_id FROM assets_releases WHERE release_id=? OR asset_version=? LIMIT 1`
    ).bind(releaseRef, releaseRef).first();
    if (releaseRow?.release_id) resolvedId = releaseRow.release_id;
    const row = await env.DB.prepare(
      `SELECT total_items, translated_items, pending_items, untranslated_items, reused_items, suggested_items, ` +
      `blocked_items, category_summary_json, updated_at FROM release_summaries WHERE release_kind='assets' AND release_id=?`
    ).bind(resolvedId).first();
    if (!row) {
      return json({
        release_kind: "assets",
        release_id: resolvedId,
        summary_ready: false,
        error: "data_not_ready",
        detail: "release_summaries has no row for this assets release yet",
        generated_at: now(),
      }, 503, { "cache-control": "no-store" });
    }
    return json({
      release_kind: "assets",
      release_id: resolvedId,
      summary_ready: true,
      ...row,
      categories: safeJson(row.category_summary_json),
    }, 200, { "cache-control": "public, max-age=300" });
  } catch (err) {
    if (isQuotaError(err)) return quotaResponse(err);
    throw err;
  }
}

async function getAssetsReleaseItems(request, env, releaseRef) {
  const url = new URL(request.url);
  const limit = readLimit(url, 20);
  const cursorParam = url.searchParams.get("cursor") || "";
  let releaseId = releaseRef;
  try {
    // 身份与来源只解析一次：GitHub 分支用 manifest 自己的 `release_id`（D1 的
    // 行可能尚未物化或叫别的名字），D1 分支才做 registry 解析。此前先查 D1 再
    // 选 GitHub，会让元数据/index 来自两个来源。
    const source = await resolveReleaseSource(env, "assets", releaseRef);
    if (source.axis === "broken") throw pinMissingError();
    const cursor = cursorParam
      ? await decodeCursor(cursorParam, source.axis === "github"
        ? `assets:${source.release.release_id}:items`
        : `assets:${releaseRef}:items`)
      : null;
    const after = cursor || { bundle: "", item_key: "" };

    if (source.axis === "github") {
      const staticRelease = source.release;
      const staticManifest = await readGitHubAssetsPortalManifest(env);
      const items = [];
      let hasMore = false;
      for (const bundle of staticAssetBundles(staticManifest)) {
        if (after.bundle && bundle < after.bundle) continue;
        // The list endpoint only needs a bounded page. Avoid parsing a 100k-line
        // master bundle on every cold Worker isolate; detail/search paths retain
        // their larger scan budget.
        const rows = await readGitHubAssetsBundleRows(env, staticRelease, bundle, Math.max(limit * 4, 200));
        for (const row of rows) {
          if (bundle === after.bundle && String(row.item_key).localeCompare(String(after.item_key), undefined, { numeric: true }) <= 0) continue;
          if (items.length >= limit) { hasMore = true; break; }
          items.push(await staticAssetsItem(env, staticRelease, row));
        }
        if (hasMore) break;
      }
      const last = items[items.length - 1];
      return json({
        release_id: staticRelease.release_id,
        limit,
        next_cursor: hasMore && last
          ? await encodeCursor({ scope: `assets:${staticRelease.release_id}:items`, bundle: last.bundle, item_key: last.item_key })
          : null,
        has_more: hasMore,
        items,
        source: "github",
      }, 200, { "cache-control": "public, max-age=60" });
    }

    const releaseRow = await env.DB.prepare(
      `SELECT release_id FROM assets_releases WHERE release_id=? OR asset_version=? LIMIT 1`
    ).bind(releaseRef, releaseRef).first();
    if (releaseRow?.release_id) releaseId = releaseRow.release_id;
    const cursorD1 = cursorParam ? await decodeCursor(cursorParam, `assets:${releaseId}:items`) : null;
    const afterD1 = cursorD1 || { bundle: "", item_key: "" };

    const rows = await env.DB.prepare(
      `SELECT sv.source_variant_id, sv.bundle, sv.item_key, sv.source_sha256, ru.logical_key, r.reuse_mode, r.reused_from_release_id, ` +
      `r.status, tu.translation, tu.translation_id ` +
      `FROM source_variants sv ` +
      `JOIN resource_units ru ON ru.resource_id = sv.resource_id ` +
      `LEFT JOIN release_resource_refs r ON r.source_variant_id=sv.source_variant_id AND r.release_kind='assets' AND r.release_id=sv.release_id ` +
      `LEFT JOIN translation_units tu ON tu.translation_id=r.translation_id ` +
      `WHERE sv.release_kind='assets' AND sv.release_id=? AND (sv.bundle > ? OR (sv.bundle = ? AND sv.item_key > ?)) ` +
      `ORDER BY sv.bundle ASC, sv.item_key ASC LIMIT ?`
    ).bind(releaseId, afterD1.bundle, afterD1.bundle, afterD1.item_key, limit).all();

    const items = rows.results || [];
    const last = items[items.length - 1];
    return json({
      release_id: releaseId,
      limit,
      next_cursor: items.length === limit && last
        ? await encodeCursor({ scope: `assets:${releaseId}:items`, bundle: last.bundle, item_key: last.item_key })
        : null,
      has_more: items.length === limit,
      items,
    }, 200, { "cache-control": "public, max-age=60" });
  } catch (err) {
    if (isQuotaError(err)) return quotaResponse(err);
    throw err;
  }
}

function safeJson(value) {
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

/// Single-resource detail: the source text lives here, not in the list pages.
async function getReleaseItemDetail(request, env, releaseKind, releaseRef) {
  const url = new URL(request.url);
  const bundle = (url.searchParams.get("bundle") || "").trim();
  const itemKey = (url.searchParams.get("item_key") || url.searchParams.get("key") || "").trim();
  if (!bundle || !itemKey) throw new HttpError(400, "bundle_and_item_key_required");

  if (releaseKind === "assets") {
    const source = await resolveReleaseSource(env, "assets", releaseRef);
    if (source.axis === "broken") throw pinMissingError();
    if (source.axis === "github") {
      const staticRelease = source.release;
      const row = (await readGitHubAssetsBundleRows(env, staticRelease, bundle, 5000)).find((entry) => entry.item_key === itemKey);
      if (!row) throw new HttpError(404, "release_item_not_found");
      return json({
        release_kind: "assets",
        release_id: staticRelease.release_id,
        item: await staticAssetsItem(env, staticRelease, row),
        other_release_variants: [],
        reuse_rule: "Assets rows are pinned to the GitHub release commit; reuse requires the same source hash",
      }, 200, { "cache-control": "public, max-age=120" });
    }
  }

  if (releaseKind === "client") {
    const source = await resolveReleaseSource(env, "client", releaseRef);
    if (source.axis === "broken") throw pinMissingError();
    const staticRelease = source.axis === "github" ? source.release : null;
    if (staticRelease
      && bundle === "manifests/bottom-bar.manifest.json" && /^\d+$/.test(itemKey)) {
      const itemsManifest = await readClientItemsManifestAtPin(env, source.pin);
      if (!itemsManifest?.slots?.length) throw new HttpError(503, "client_items_unavailable");
      const slot = itemsManifest.slots.find((entry) => String(entry.index) === itemKey);
      if (!slot) throw new HttpError(404, "release_item_not_found");
      return json({
        release_kind: "client",
        release_id: staticRelease.release_id,
        item: await clientStaticItem(env, staticRelease, slot),
        other_release_variants: [],
        reuse_rule: "client manifest slots are pinned to the release commit; reuse requires the same source hash",
      }, 200, { "cache-control": "public, max-age=120" });
    }
  }

  let releaseId = releaseRef;
  // Read through the registry rather than a bare `SELECT release_id`, because
  // the row's `assets_commit` is what the item's `github` binding is pinned to:
  // a binding without a commit is not one this route can hand out.
  let releaseRow = null;
  try {
    // The registry read is also what pins the item's `github` binding, so it is
    // the *channel's* registry on both axes.
    releaseRow = releaseKind === "assets"
      ? await getAssetsRelease(env, releaseRef)
      : await getClientRelease(env, releaseRef);
    if (releaseRow?.release_id) releaseId = releaseRow.release_id;

    const row = await fetchCatalogueRow(env, releaseKind, releaseId, bundle, itemKey);
    if (!row) throw new HttpError(404, "release_item_not_found");

    const otherVariants = await env.DB.prepare(
      `SELECT sv.source_variant_id, sv.release_kind, sv.release_id, sv.source_sha256, sv.source, sv.created_at ` +
      `FROM source_variants sv JOIN resource_units ru ON ru.resource_id = sv.resource_id ` +
      `WHERE ru.logical_key = ? AND NOT (sv.release_kind = ? AND sv.release_id = ?) ` +
      `ORDER BY sv.created_at DESC LIMIT 20`
    ).bind(row.logical_key, releaseKind, releaseId).all();

    const variants = (otherVariants.results || []).map((variant) => ({
      ...variant,
      // The UI must be able to say "same source, safe to reuse" or "different
      // source, do not auto-reuse" without re-deriving the rule itself.
      same_source_sha256: variant.source_sha256 === row.source_sha256,
      reusable: variant.source_sha256 === row.source_sha256,
    }));

    return json({
      release_kind: releaseKind,
      release_id: releaseId,
      item: decorateCatalogueRow(row, env, null, releaseRow, releaseKind),
      other_release_variants: variants,
      reuse_rule: "exact reuse requires an identical logical_key, resource_kind, locale and source_sha256; a different source hash is never auto-reused",
    }, 200, { "cache-control": "public, max-age=120" });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (isQuotaError(err)) return quotaResponse(err);
    throw err;
  }
}

// ============================================================================
// Universal Resource Details & Cross-Version Reuse API
// ============================================================================

async function getResourceDetail(request, env, resourceId) {
  try {
    const res = await env.DB.prepare(`SELECT * FROM resource_units WHERE resource_id=?`).bind(resourceId).first();
    if (!res) throw new HttpError(404, "resource_not_found");

    // One resource's variants, newest first, one bounded page. A resource with
    // hundreds of release variants must not widen this into a full history read.
    const variants = await env.DB.prepare(
      `SELECT * FROM source_variants WHERE resource_id=? ORDER BY created_at DESC LIMIT 50`
    ).bind(resourceId).all();

    return json({
      resource: res,
      variants: variants.results || []
    }, 200, { "cache-control": "public, max-age=120" });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(503, "database_unavailable");
  }
}

async function getResourceHistory(request, env, resourceId) {
  try {
    const res = await env.DB.prepare(`SELECT * FROM resource_units WHERE resource_id=?`).bind(resourceId).first();
    if (!res) throw new HttpError(404, "resource_not_found");

    const audits = await env.DB.prepare(
      `SELECT * FROM audit_events WHERE object_id=? OR detail_json LIKE ? ORDER BY created_at DESC LIMIT 50`
    ).bind(resourceId, `%${res.logical_key}%`).all();

    return json({
      resource_id: resourceId,
      logical_key: res.logical_key,
      history: audits.results || []
    }, 200, { "cache-control": "public, max-age=60" });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(503, "database_unavailable");
  }
}

async function getResourceReuse(request, env, resourceId) {
  try {
    const res = await env.DB.prepare(`SELECT * FROM resource_units WHERE resource_id=?`).bind(resourceId).first();
    if (!res) throw new HttpError(404, "resource_not_found");

    // Bounded on both arms: the translation history for one key and the
    // release bindings for one resource, newest first, one page each.
    const translations = await env.DB.prepare(
      `SELECT * FROM translation_units WHERE logical_key=? ORDER BY updated_at DESC LIMIT 50`
    ).bind(res.logical_key).all();

    const refs = await env.DB.prepare(
      `SELECT rrr.*, sv.release_kind, sv.release_id, sv.source_sha256 ` +
      `FROM release_resource_refs rrr ` +
      `JOIN source_variants sv ON rrr.source_variant_id=sv.source_variant_id ` +
      `WHERE sv.resource_id=? ORDER BY rrr.updated_at DESC LIMIT 50`
    ).bind(resourceId).all();

    return json({
      resource_id: resourceId,
      logical_key: res.logical_key,
      translations: translations.results || [],
      release_bindings: refs.results || []
    }, 200, { "cache-control": "public, max-age=60" });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(503, "database_unavailable");
  }
}

// ============================================================================
// GitHub -> Portal Real-time Webhook Handler
// ============================================================================

// Only these events may create a sync job. Anything else is recorded as
// `ignored`, so an unexpected event can never start a repository walk.
const ALLOWED_GITHUB_EVENTS = new Set(["push", "release"]);

export async function verifyGitHubHmac(secret, payloadText, signatureHeader) {
  if (!secret || !signatureHeader) return false;
  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) return false;
  const expectedHex = signatureHeader.slice(prefix.length).trim().toLowerCase();
  // A signature is exactly 64 lowercase hex chars. Rejecting anything else
  // before the HMAC runs keeps a truncated or non-hex header from becoming a
  // comparison at all.
  if (!/^[0-9a-f]{64}$/.test(expectedHex)) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  const sigBytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payloadText)));
  const expectedBytes = new Uint8Array(expectedHex.match(/../g).map((pair) => parseInt(pair, 16)));
  // Constant-time comparison: `===` on hex strings short-circuits on the first
  // differing char and leaks, via timing, how many leading chars matched. The
  // accumulator below touches every byte on every call.
  let diff = sigBytes.length ^ expectedBytes.length;
  const width = Math.max(sigBytes.length, expectedBytes.length);
  for (let index = 0; index < width; index += 1) {
    diff |= (sigBytes[index % sigBytes.length] ^ expectedBytes[index % expectedBytes.length]);
  }
  return diff === 0;
}

async function handleGitHubWebhook(request, env) {
  const event = request.headers.get("X-GitHub-Event") || "";
  const delivery = request.headers.get("X-GitHub-Delivery") || "";
  const signature = request.headers.get("X-Hub-Signature-256") || "";

  if (!event || !delivery) {
    throw new HttpError(400, "missing_github_headers");
  }

  const payloadText = await request.text();

  // Fail closed. An unconfigured secret in production is a misconfiguration, not
  // an invitation to skip verification: without the secret we cannot tell a
  // GitHub delivery from anyone else's POST, so the endpoint refuses to act.
  const secret = String(env.GITHUB_WEBHOOK_SECRET || "").trim();
  if (!secret) {
    if (isProductionEnv(env)) throw new HttpError(503, "webhook_secret_unconfigured");
    // Outside production (wrangler dev, tests) an unsigned delivery is still
    // accepted but recorded, so local development cannot silently depend on it.
    console.warn("GITHUB_WEBHOOK_SECRET unset and ENVIRONMENT != production: accepting unsigned delivery", delivery);
  } else {
    const verified = await verifyGitHubHmac(secret, payloadText, signature);
    if (!verified) throw new HttpError(401, "invalid_webhook_signature");
  }

  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch (_) {
    throw new HttpError(400, "invalid_webhook_json");
  }

  const repoName = payload.repository?.full_name || payload.repository?.name || "unknown";
  const eventAllowed = ALLOWED_GITHUB_EVENTS.has(event);
  const targetKind = resolveTargetKind(env, repoName);

  // Delivery-level dedup: `delivery_id` is GitHub's own idempotency key.
  let existing;
  try {
    existing = await env.DB.prepare(
      `SELECT delivery_id, status FROM github_webhook_deliveries WHERE delivery_id=?`
    ).bind(delivery).first();
  } catch (err) {
    if (isQuotaError(err)) return quotaResponse(err);
    throw err;
  }
  if (existing) {
    return json({ ok: true, status: "duplicate_ignored", delivery_id: delivery }, 200);
  }

  // A release event's `target_commitish` is a branch or tag name ("main"), not a
  // commit. The sync consumer pins every read to a commit sha, so only a 40-hex
  // sha may become a job's `commit_sha`; anything else is recorded and ignored.
  // A null `after` on a push event means the ref was deleted: there is no head
  // commit to ingest, so the delivery is recorded but no job is enqueued. Only
  // a 40-hex sha may become a job's `commit_sha`.
  const pushDeleted = event === "push" && payload.deleted === true;
  const afterSha = /^[0-9a-f]{40}$/i.test(String(payload.after || "")) ? payload.after : null;
  const headSha = /^[0-9a-f]{40}$/i.test(String(payload.head_commit?.id || "")) ? payload.head_commit.id : null;
  const releaseCommit = /^[0-9a-f]{40}$/i.test(String(payload.release?.target_commitish || "")) ? payload.release.target_commitish : null;
  const commitSha = pushDeleted ? null : (afterSha || headSha || releaseCommit);
  const shaOk = commitSha == null
    ? (event === "release" ? false : pushDeleted ? true : (payload.after == null && payload.head_commit?.id == null))
    : /^[0-9a-f]{40}$/i.test(String(commitSha));
  const releaseRef = payload.release?.tag_name || payload.ref || null;
  const timestamp = now();

  let ignoredReason = null;
  if (!eventAllowed) ignoredReason = "event_not_allowed";
  else if (!targetKind) ignoredReason = "repository_not_configured";
  else if (!shaOk) ignoredReason = "commit_sha_unresolved";

  try {
    await env.DB.prepare(
      `INSERT INTO github_webhook_deliveries (delivery_id, repository, event_type, commit_sha, release_ref, job_id, status, ignored_reason, created_at) ` +
      `VALUES (?, ?, ?, ?, ?, NULL, 'received', ?, ?)`
    ).bind(delivery, repoName, event, commitSha, releaseRef, ignoredReason, timestamp).run();
  } catch (err) {
    if (isQuotaError(err)) return quotaResponse(err);
    throw err;
  }

  if (ignoredReason) {
    try {
      await env.DB.prepare(
        `UPDATE github_webhook_deliveries SET status='ignored', processed_at=? WHERE delivery_id=?`
      ).bind(timestamp, delivery).run();
    } catch (err) {
      if (isQuotaError(err)) return quotaResponse(err);
      throw err;
    }
    return json({ ok: true, status: "ignored", reason: ignoredReason, delivery_id: delivery }, 202);
  }

  // Enqueue. The unique index on (repository, commit_sha, target_kind) plus
  // `INSERT OR IGNORE` makes a replayed commit a no-op at the database level.
  try {
    const jobId = id();
    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO sync_jobs (job_id, delivery_id, repository, event_type, commit_sha, before_sha, target_kind, target_release_id, status, attempts, max_attempts, created_at, updated_at) ` +
      `VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 3, ?, ?)`
    ).bind(jobId, delivery, repoName, event, commitSha, payload.before || null, targetKind, releaseRef, timestamp, timestamp).run();

    const changed = inserted.meta?.changes ?? inserted.changes ?? 0;
    let resolvedJobId = jobId;
    if (!changed) {
      const existingJob = await env.DB.prepare(
        `SELECT job_id, status FROM sync_jobs WHERE repository=? AND commit_sha=? AND target_kind=? LIMIT 1`
      ).bind(repoName, commitSha, targetKind).first();
      resolvedJobId = existingJob?.job_id || null;
      await env.DB.prepare(
        `UPDATE github_webhook_deliveries SET status='ignored', ignored_reason='duplicate_commit', processed_at=?, job_id=? WHERE delivery_id=?`
      ).bind(timestamp, resolvedJobId, delivery).run();
      return json({ ok: true, status: "duplicate_commit_ignored", delivery_id: delivery, job_id: resolvedJobId }, 200);
    }

    await env.DB.prepare(
      `UPDATE github_webhook_deliveries SET job_id=?, status='processing' WHERE delivery_id=?`
    ).bind(jobId, delivery).run();

    await audit(env, "github_webhook", "webhook_enqueued", "sync_job", jobId, {
      repository: repoName, event, target_kind: targetKind, commit_sha: commitSha,
    });

    return json({
      ok: true,
      delivery_id: delivery,
      job_id: jobId,
      target_kind: targetKind,
      status: "queued",
      consumer: "scheduled:cron",
    }, 202);
  } catch (err) {
    if (isQuotaError(err)) return quotaResponse(err);
    throw err;
  }
}

function isProductionEnv(env) {
  const value = String(env?.ENVIRONMENT || "").trim().toLowerCase();
  return value === "production" || value === "prod";
}

/**
 * Sync queue health. This is the operator's window into the consumer: which
 * deliveries arrived, which jobs are waiting, which failed and why. Reviewer and
 * admin only, because job errors can quote private repository configuration.
 */
async function getSyncStatus(request, env) {
  await requireActor(request, env, ["reviewer", "admin"]);
  if (!env.DB && !env.PUBLICATION_BUCKET) throw new HttpError(503, "database_unavailable");
  try {
    const jobs = await env.DB.prepare(
      `SELECT job_id, repository, target_kind, commit_sha, status, attempts, max_attempts, rows_written, error_message, next_retry_at, created_at, updated_at ` +
      `FROM sync_jobs ORDER BY created_at DESC LIMIT 50`
    ).all();
    const byStatus = await env.DB.prepare(
      `SELECT status, COUNT(*) AS count FROM sync_jobs GROUP BY status`
    ).all();
    const cursors = await env.DB.prepare(
      `SELECT repository, ref, commit_sha, rows_written, processed_at FROM sync_cursors ORDER BY processed_at DESC LIMIT 20`
    ).all();
    const deliveries = await env.DB.prepare(
      `SELECT delivery_id, repository, event_type, status, ignored_reason, commit_sha, created_at, processed_at ` +
      `FROM github_webhook_deliveries ORDER BY created_at DESC LIMIT 20`
    ).all();
    return json({
      queue: Object.fromEntries((byStatus.results || []).map((row) => [row.status, Number(row.count)])),
      jobs: jobs.results || [],
      cursors: cursors.results || [],
      deliveries: deliveries.results || [],
      consumer: { mode: "scheduled", cron: SYNC_CRON, batches_per_tick: CLAIM_BATCH_SIZE },
    }, 200, { "cache-control": "no-store" });
  } catch (err) {
    if (isQuotaError(err)) return quotaResponse(err);
    throw err;
  }
}

/**
 * Manual trigger for the same consumer the cron runs. Exists because a crontab
 * is invisible in local development and during an incident; it is admin-gated
 * and performs exactly the same bounded batch.
 */
async function runSyncTickNow(request, env) {
  await requireActor(request, env, ["admin"]);
  const result = await runSyncTick(env, { claimLimit: CLAIM_BATCH_SIZE });
  return json({ ok: true, ...result }, 200, { "cache-control": "no-store" });
}

// ============================================================================
// Image Tasks & Overrides API
// ============================================================================

const IMAGE_STATUSES = new Set(["untranslated", "not_needed", "restored", "accepted"]);

/// One image task's own override, if any. The listing path used to read the
/// whole `image_status_overrides` table on every page — a scan that grows with
/// the number of human decisions, on the endpoint a browsing user calls most.
/// The list only needs the overrides for the ids on that page, so it seeks by
/// primary key instead; the standalone overrides endpoint still reads the table,
/// because "give me all of them" is what that endpoint is for.
async function readImageStatusOverride(env, taskId) {
  if (!env.DB || !taskId) return null;
  try {
    const row = await env.DB.prepare(
      `SELECT status FROM image_status_overrides WHERE task_id=?`
    ).bind(taskId).first();
    return row?.status || null;
  } catch (err) {
    // An override is a decoration on the row, never the row itself: if the
    // lookup fails the task still renders, just without the manual verdict.
    return null;
  }
}

async function readImageStatusOverrides(env) {
  const overrides = new Map();
  if (!env.DB) return overrides;
  try {
    const res = await env.DB.prepare(`SELECT task_id, status FROM image_status_overrides`).all();
    for (const row of res.results || []) {
      overrides.set(row.task_id, row.status);
    }
  } catch (_) {}
  return overrides;
}

async function getImageStatusOverrides(request, env) {
  const overrides = await readImageStatusOverrides(env);
  return json({ overrides: Object.fromEntries(overrides) }, 200, {
    "cache-control": "public, max-age=60, s-maxage=300"
  });
}

let imageTaskManifestCache = { expiresAt: 0, value: null };

async function readStaticImageTaskManifest(request, env) {
  const nowMs = Date.now();
  if (imageTaskManifestCache.expiresAt > nowMs) return imageTaskManifestCache.value;
  if (!env?.ASSETS?.fetch) return null;
  try {
    const url = new URL("/data/image_tasks.json", request.url);
    const response = await env.ASSETS.fetch(new Request(url));
    if (!response.ok) throw new Error(`image manifest HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload?.tasks)) throw new Error("invalid image task manifest");
    imageTaskManifestCache = { expiresAt: nowMs + 60_000, value: payload };
    return payload;
  } catch (_) {
    imageTaskManifestCache = { expiresAt: nowMs + 10_000, value: null };
    return null;
  }
}

async function getStaticImageTasks(request, env, { category, bundle, status, search, limit, after }) {
  const manifest = await readStaticImageTaskManifest(request, env);
  if (!manifest) return null;
  const overrideMap = await readImageStatusOverrides(env);
  const normalizedBundle = String(bundle || "").toLowerCase();
  const normalizedSearch = String(search || "").toLowerCase();
  const filtered = manifest.tasks
    .map((task) => ({
      ...task,
      has_alpha: Boolean(task.has_alpha),
      status: overrideMap.get(task.task_id) || task.status || "untranslated",
    }))
    .filter((task) => !category || category === "all" || task.category === category)
    .filter((task) => !normalizedBundle || String(task.bundle || "").toLowerCase() === normalizedBundle)
    .filter((task) => !normalizedSearch
      || String(task.task_id || "").toLowerCase() === normalizedSearch
      || String(task.bundle || "").toLowerCase() === normalizedSearch)
    .filter((task) => !status || status === "all" || task.status === status)
    .sort((a, b) => String(a.task_id).localeCompare(String(b.task_id)));
  const seeked = after ? filtered.filter((task) => String(task.task_id) > String(after)) : filtered;
  const visible = seeked.slice(0, limit);
  const last = visible[visible.length - 1];
  return {
    limit,
    next_cursor: seeked.length > limit && last
      ? await encodeCursor({ scope: "images:tasks", task_id: last.task_id })
      : null,
    has_more: seeked.length > limit,
    categories: manifest.categories || null,
    total: Number(manifest.total || manifest.tasks.length),
    counts_truncated: false,
    summary_updated_at: manifest.generated_at || null,
    tasks: visible,
    source: "static_manifest",
  };
}

/**
 * Image task index.
 *
 * This used to read `public/data/image_tasks.json` on every call — a generated
 * file whose size grows with the reconstruction backlog and which went stale
 * whenever the pipeline advanced. The task metadata now comes from
 * `image_task_units` with a keyset page, and the static JSON is kept only as a
 * reconstructible materialised cache for the pipeline that produces it.
 */
/// A cursor's position must be the last row the caller actually *saw*. The
/// status filter runs after the seek, so a page whose rows were all filtered out
/// still has to hand back a cursor — otherwise a filtered listing can never get
/// past a run of non-matching rows — and that cursor has to name the last
/// *examined* row, not the last visible one.
function seekCursorRow(examined, visible) {
  const lastVisible = visible[visible.length - 1];
  return lastVisible || examined[examined.length - 1] || null;
}

async function getImageTasks(request, env) {
  const url = new URL(request.url);
  const bundle = (url.searchParams.get("bundle") || "").trim().toLowerCase();
  const category = (url.searchParams.get("category") || "all").trim();
  const status = (url.searchParams.get("status") || "all").trim();
  const search = (url.searchParams.get("search") || "").trim().toLowerCase();
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("pageSize") || "24", 10) || 24, 1), 100);
  const cursorParam = url.searchParams.get("cursor") || "";
  const cursor = cursorParam ? await decodeCursor(cursorParam, "images:tasks") : null;
  const after = cursor?.task_id || "";
  const staticResult = await getStaticImageTasks(request, env, { category, bundle, status, search, limit, after });
  if (staticResult) return json(staticResult, 200, { "cache-control": "public, max-age=60, s-maxage=300" });
  if (!env.DB) throw new HttpError(503, "database_unavailable");

  // Substring filters are rejected, not widened: an unanchored LIKE cannot use
  // the (category, task_id) / (bundle, task_id) indexes and turns this keyset
  // page into a scan. Callers filter by exact bundle or by exact task id, so
  // only the LIKE metacharacter `%` is rejected — `_` is an ordinary char in
  // bundle names (`event_0015_info`) and is bound as a parameter, never
  // interpolated into SQL.
  if (bundle.includes("%")) throw new HttpError(400, "bundle_filter_invalid");
  if (search.includes("%")) throw new HttpError(400, "search_filter_invalid");
  const where = ["task_id > ?"];
  const args = [after];
  if (category && category !== "all") { where.push("category = ?"); args.push(category); }
  if (bundle) { where.push("LOWER(bundle) = ?"); args.push(bundle); }
  if (search) {
    where.push("(LOWER(task_id) = ? OR LOWER(bundle) = ?)");
    args.push(search, search);
  }

  let rows;
  let categories;
  try {
    rows = await env.DB.prepare(
      `SELECT task_id, bundle, category, width, height, image_format, has_alpha, r2_key, source_sha256 ` +
      `FROM image_task_units WHERE ${where.join(" AND ")} ORDER BY task_id ASC LIMIT ?`
    ).bind(...args, limit).all();
    // Category totals come from the derived summary row, not from a COUNT/GROUP
    // BY over the whole task table: the aggregate is the importer's job (it is
    // already walking every row), and a request must not re-derive it. Absent a
    // summary the field is reported as null rather than invented.
    //
    // The importer is `scripts/migrate_and_backfill_portal_d1.py`, which writes
    // both `image_task_units` and this row from the same manifest — so the two
    // can never disagree about what was imported.
    const summaryRow = await env.DB.prepare(
      `SELECT value_json, updated_at FROM portal_summary WHERE key='image_categories'`
    ).first();
    // Two shapes exist in the wild: the importer's `{counts, total, truncated}`
    // and a bare `{category: n}` map written by hand or by an older tool. Both
    // are read as counts; a partial roll-up says so instead of looking whole.
    let summaryValue = null;
    if (summaryRow?.value_json) {
      const parsed = safeJson(summaryRow.value_json);
      const counts = parsed?.counts && typeof parsed.counts === "object" ? parsed.counts : parsed;
      const meaningful = Object.fromEntries(
        Object.entries(counts || {}).filter(([, value]) => typeof value === "number" || /^\d+$/.test(String(value)))
      );
      if (Object.keys(meaningful).length > 0) {
        summaryValue = {
          counts: meaningful,
          truncated: parsed?.truncated === true,
          updated_at: summaryRow.updated_at,
        };
      }
    }
    categories = summaryValue;
  } catch (err) {
    if (isQuotaError(err)) return quotaResponse(err);
    throw err;
  }

  const tasks = [];
  for (const task of rows.results || []) {
    tasks.push({
      ...task,
      has_alpha: Boolean(task.has_alpha),
      status: (await readImageStatusOverride(env, task.task_id)) || "untranslated",
    });
  }
  const visible = status && status !== "all" ? tasks.filter((task) => task.status === status) : tasks;
  const last = seekCursorRow(tasks, visible);

  const counts = categories?.counts || null;
  // The cursor continues the *seek*, not the visible page: a filter can leave a
  // page empty while rows remain, and reporting `next_cursor: null` there would
  // tell the caller the listing is finished. Both fields are booleans — `&&`
  // over a row object would leak the row into `has_more`.
  const examined = tasks;
  const seekContinues = examined.length === limit && Boolean(last);
  return json({
    limit,
    next_cursor: seekContinues
      ? await encodeCursor({ scope: "images:tasks", task_id: last.task_id })
      : null,
    has_more: seekContinues,
    categories: counts,
    total: counts ? Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0) : null,
    // A bounded import run leaves partial counts behind; the flag travels with
    // them so the UI can say "still importing" instead of showing a short total.
    counts_truncated: categories?.truncated === true,
    summary_updated_at: categories?.updated_at || null,
    tasks: visible,
  }, 200, { "cache-control": "public, max-age=60, s-maxage=300" });
}

async function getImageTaskDetail(request, env) {
  const url = new URL(request.url);
  const taskId = url.searchParams.get("id");
  if (!taskId) throw new HttpError(400, "missing_task_id");
  const staticManifest = await readStaticImageTaskManifest(request, env);
  if (staticManifest) {
    const task = staticManifest.tasks.find((entry) => String(entry.task_id) === String(taskId));
    if (task) {
      const overrides = await readImageStatusOverrides(env);
      return json({ task: {
        ...task,
        has_alpha: Boolean(task.has_alpha),
        status: overrides.get(task.task_id) || task.status || "untranslated",
      }, source: "static_manifest" }, 200, { "cache-control": "public, max-age=120" });
    }
  }
  if (!env.DB) throw new HttpError(503, "database_unavailable");

  let task;
  try {
    task = await env.DB.prepare(
      `SELECT task_id, bundle, category, width, height, image_format, has_alpha, r2_key, source_sha256 FROM image_task_units WHERE task_id=?`
    ).bind(taskId).first();
  } catch (err) {
    if (isQuotaError(err)) return quotaResponse(err);
    throw err;
  }
  if (!task) throw new HttpError(404, "task_not_found");

  const overrides = await readImageStatusOverride(env, taskId);
  return json({
    task: { ...task, has_alpha: Boolean(task.has_alpha), status: overrides || "untranslated" },
  }, 200, { "cache-control": "public, max-age=120" });
}

const IMAGE_ASSET_KEYS = {
  composite: (id) => `images/composite/${id}/source-composite.png`,
  restored: (id) => `images/restored/${id}/restored-texture.png`,
  model: (id) => `images/restored/${id}/edited-composite-model.png`,
};

async function getImageAsset(request, env) {
  const url = new URL(request.url);
  const taskId = url.searchParams.get("task_id") || "";
  const type = url.searchParams.get("type") || "composite";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(taskId)) throw new HttpError(400, "invalid_task_id");
  const keyFor = IMAGE_ASSET_KEYS[type];
  if (!keyFor) throw new HttpError(400, "invalid_type");
  const objectKey = keyFor(encodeURIComponent(taskId));
  // Prefer the private R2 binding so previews work even when the public custom
  // domain has not been attached to the bucket. The redirect remains the CDN
  // path for deployments that expose IMAGE_ASSET_BASE.
  if (env.PUBLICATION_BUCKET?.get) {
    const object = await env.PUBLICATION_BUCKET.get(objectKey);
    if (object) {
      const headers = new Headers({
        "content-type": object.httpMetadata?.contentType || "image/png",
        "cache-control": "public, max-age=3600",
      });
      if (object.httpEtag) headers.set("etag", object.httpEtag);
      return new Response(object.body, { status: 200, headers });
    }
  }
  const base = String(env.IMAGE_ASSET_BASE || "").replace(/\/+$/, "");
  if (!base) throw new HttpError(503, "image_asset_base_unset");
  return Response.redirect(`${base}/${objectKey}`, 302);
}

// ============================================================================
// Sessions, write protection, and the GitHub-only login
// ============================================================================
//
// The portal used to authenticate with Cloudflare Access alone: the Worker read
// `Cf-Access-Authenticated-User-Email` and derived an identity from it. That is
// an *operator* login, and it has two consequences this section exists to
// remove. A plain GitHub contributor — the person this portal is for — has no
// Access identity, so every write route was closed to them; and an identity that
// lives in a request header is only as strong as the proxy in front of it.
//
// 所有身份都来自服务端验证过的 Portal 会话；原始 Access/email 请求头
// 未经过本服务 JWT 校验，不可用于身份、后台读取或写入授权。
// GitHub 登录签发的会话以 HMAC token hash 存储，权限按当前 ACL 重新计算。
//
// Write protection is two independent checks, both required: the request must
// come from an origin this deployment serves, and it must echo the session's CSRF
// token. Either alone is defeatable — an origin check alone trusts the browser, a
// CSRF token alone can be leaked by a same-site XSS.

/// A `SessionError` is `github_session.js`'s refusal; `HttpError` is this file's.
/// One adapter, so a route body can call either.
function asHttpError(err) {
  if (err instanceof HttpError) return err;
  if (err instanceof SessionError) return new HttpError(err.status, err.code);
  return null;
}

/// What a caller is told about who it is. The session token, the CSRF token and
/// the raw `actor_key` never appear: `/api/me` is rendered into a page, and a
/// rendering is a copy in a DOM, a screenshot and a browser cache.
function publicActor(person) {
  return {
    login: person.login || null,
    email: person.email || null,
    github_user_id: person.github_user_id ?? null,
    role: person.role,
    via: person.via,
  };
}

/// POST 登出：先撤销服务端会话及托管 token，再清除 cookie。
/// 路由层校验会话、Origin、CSRF；撤销失败必须明确报告，不能只清前端状态。
async function logout(request, env) {
  let revoked = false;
  let failed = false;
  try {
    const token = readCookie(request, SESSION_COOKIE_NAME);
    if (token) {
      const session = await readSession(request, env);
      revoked = await revokeSession(env, token);
      if (session?.actor?.via === "github") await deleteUserToken(env, session.actor.key);
    }
  } catch (err) {
    failed = true;
    console.warn("logout revoke failed:", err?.code || err?.message || String(err));
  }
  // 即使清除浏览器 cookie，也不能把服务端撤销失败记为成功。
  const response = json({ ok: !failed, revoked, ...(failed ? { error: "logout_revoke_failed" } : {}) },
    failed ? 503 : 200, { "cache-control": "no-store" });
  return withCookies(response, [clearSessionCookie(env), clearOauthBindingCookie(env)]);
}

/// 已验证会话的身份；没有有效会话时返回 null，不回退到请求头。
async function currentActor(request, env) {
  try {
    const found = await readSession(request, env);
    return found ? { ...found.actor, csrfToken: found.csrfToken, session: found } : null;
  } catch (err) {
    throw asHttpError(err) || err;
  }
}

/// 需要真实会话及角色的接口共用此门禁；写请求另验 Origin 与 CSRF。
async function requireWriteActor(request, env, { roles = [] } = {}) {
  const person = await currentActor(request, env);
  if (!person?.session) throw new HttpError(401, "authentication_required");
  if (roles.length && !roles.includes(person.role)) throw new HttpError(403, "role_required");
  return person;
}

/// Origin + CSRF, in one call, so a write route cannot forget half of it.
function requireWriteGuard(request, env, person) {
  try {
    assertWriteAllowed(request, { session: person.session, env });
  } catch (err) {
    const http = asHttpError(err);
    if (http) throw http;
    throw err;
  }
  return true;
}

/// The contribution history, read-only.
///
/// This is what is left of the review queue. Rows are shown so a maintainer (and
/// a contributor looking at their own work) can see what was proposed and when —
/// but nothing here writes a verdict, because the verdict is a merge on GitHub,
/// and `review_authority` says so in the payload.
async function contributionQueue(request, env) {
  const person = await requireWriteActor(request, env, { roles: ["reviewer", "admin"] });
  const status = new URL(request.url).searchParams.get("status") || "pending";
  if (!["pending", "needs_review", "accepted", "rejected"].includes(status)) throw new HttpError(400, "status_invalid");
  await ensureContributor(env, person);
  const rows = await env.DB.prepare(
    `SELECT id, base_version, asset_version, bundle, item_key, source_sha256, source, translation, status, contributor_email, created_at, updated_at FROM contributions WHERE status=? ORDER BY updated_at ASC LIMIT 100`
  ).bind(status).all();
  return {
    status,
    rows: rows.results || [],
    review_authority: "github_pull_request",
    writable: false,
  };
}

// ============================================================================
// The source-bound edit context
// ============================================================================
//
// A single-row editor needs three things before it can offer an input box: which
// repository and file the row lives in, which commit that file was read at, and
// what the row's source text currently is. All three come from *this* service —
// the browser never names a `base_commit`, because a commit the client chose is
// not a pin, it is a suggestion.
//
// The context is derived from the release registry (`assets_releases`,
// `client_releases`) plus the catalogue rows that release already carries. When a
// piece of that is missing the answer is `editable: false` with a machine-readable
// `reason` and a `detail` naming the missing input — never a silent refusal, and
// never an edit accepted on a file nobody pinned.

/// `resource_kind` -> proposal target. The mapping is a property of the delivery
/// channel (an `image` or `unity3d` resource is shipped by the assets server), so
/// it is a constant table here rather than a guess from a path.
/// The channel a resource kind belongs to — when the kind decides it.
///
/// The same `resource_kind` ships through both channels in this project: a text
/// row may be an assets-server string or a client built-in one, and the
/// repository it lives in is a property of the *release*, not of the kind. So
/// the kind narrows the candidates (an image is never a client surface) and the
/// variant's `release_kind` picks between them; `null` means "not editable from
/// here" rather than "assets".
function targetsForResourceKind(resourceKind) {
  const kind = String(resourceKind || "").toLowerCase();
  if (kind === "text" || kind === "lyrics") return ["assets", "client"];
  if (kind === "image" || kind === "unity3d") return ["assets"];
  return [];
}

async function editContextForResource(env, resourceId) {
  // `env` is the request's own environment throughout: the layout a client row
  // reports is the layout the commit will be checked against.
  const notEditable = (reason, detail) => ({ editable: false, reason, detail });
  if (!env.DB) throw new HttpError(503, "database_unavailable");

  const resource = await env.DB.prepare(`SELECT * FROM resource_units WHERE resource_id=?`).bind(resourceId).first();
  if (!resource) throw new HttpError(404, "resource_not_found");
  const candidates = targetsForResourceKind(resource.resource_kind);
  if (!candidates.length) return notEditable("resource_kind_not_editable", `resource_kind=${resource.resource_kind}`);

  // The resource's own variant decides the channel: a row that exists on both
  // axes is edited where it actually lives, not where a table says it should.
  const variant = await env.DB.prepare(
    `SELECT * FROM source_variants WHERE resource_id=? AND release_kind IN (${candidates.map(() => "?").join(",")}) ` +
    `ORDER BY CASE release_kind WHEN 'client' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`
  ).bind(resourceId, ...candidates).first();
  if (!variant) return notEditable("missing_binding", `no source variant for this resource on the ${candidates.join("/")} axis`);
  const target = variant.release_kind;

  // The pin comes from the release's *own* axis. `client_releases` carries
  // `client_resources_commit`; borrowing `assets_releases.assets_commit` for a
  // client row would pin the wrong repository to the wrong revision.
  //
  // 与 item 路由同一条源判定：该 release 被 CI manifest 认领时，pin 与身份以
  // manifest 为准（D1 行可能滞后）；认领但 pin 不可用时 fail-closed，绝不给
  // 出一个 manifest 已不再确认的 commit 让编辑器去验证。
  const isClient = target === "client";
  const source = await resolveReleaseSource(env, target, variant.release_id);
  if (source.axis === "broken") throw pinMissingError();
  const release = source.axis === "github"
    ? source.release
    : (isClient ? await getClientRelease(env, variant.release_id) : await getAssetsRelease(env, variant.release_id));
  if (!release) return notEditable("missing_binding", `release ${variant.release_id} is not registered on the ${target} axis`);
  // The pin is the point of the whole route: without a commit there is no
  // revision to verify a row against, so there is no binding to hand out. Which
  // column carries it, and what counts as a commit, is the same rule the item
  // routes use.
  const baseCommit = source.axis === "github" ? source.pin : releasePinnedCommit(target, release);
  if (!baseCommit) {
    return notEditable("missing_base_commit", isClient
      ? `client_releases.client_resources_commit is unset or not a commit sha for ${release.release_id}`
      : `assets_releases.assets_commit is unset for ${release.release_id}`);
  }

  const path = isClient
    ? clientTextPathForBundle(env, variant.bundle)
    : localesPathForBundle(variant.bundle, variant.item_key);
  if (!path) {
    return notEditable("missing_path", isClient
      ? "the client repository's layout is not declared (set GITHUB_CLIENT_MANIFEST_PATH or GITHUB_CLIENT_TEXT_DIR to the verified location)"
      : `bundle ${variant.bundle} has no place in the exporter's locales/ layout`);
  }

  let translation = null;
  let translationStatus = null;
  try {
    const unit = await env.DB.prepare(
      `SELECT translation, status, source_sha256 FROM translation_units WHERE logical_key=? AND resource_kind=? AND locale='zh-CN' AND source_sha256=? LIMIT 1`
    ).bind(resource.logical_key, resource.resource_kind, variant.source_sha256).first();
    if (unit) {
      // A row whose stored source no longer matches the variant cannot be shown
      // as an editable translation: the text on screen would not be the text the
      // pin verifies.
      translation = unit.translation;
      translationStatus = unit.status;
    }
  } catch (err) {
    if (isQuotaError(err)) return notEditable("quota", "read budget exhausted");
    throw err;
  }

  return {
    editable: true,
    github: {
      target,
      path,
      base_commit: baseCommit,
      source_sha256: String(variant.source_sha256).toLowerCase(),
    },
    logical_key: resource.logical_key,
    bundle: variant.bundle,
    item_key: variant.item_key,
    // The row's shape decides how it is addressed and rewritten: a JSONL row is
    // one line, a client manifest slot is one entry of `slots[]`. The client
    // tells the service which it has by echoing `row_kind`.
    row_kind: isClient && /\.json$/i.test(path) ? "manifest_slot" : "jsonl_row",
    resource_kind: resource.resource_kind,
    source: variant.source,
    translation,
    translation_status: translationStatus,
    // The independent axes, each named for what it is. A client must send back
    // the one that matches `github.target` — never both.
    asset_version: isClient ? null : String(release.asset_version),
    client_version: isClient ? String(release.client_version) : null,
  };
}

/// `GET /api/resources/:id/edit-context`
async function getResourceEditContext(request, env, resourceId) {
  return json(await editContextForResource(env, resourceId), 200, { "cache-control": "no-store" });
}

/// `(resource_kind, logical_key)` -> the resource id the exporter derives. The
/// single-item detail endpoints already address a row this way, so the two agree
/// by construction (`res_<first 24 chars of sha256(logical_key)>`).
async function resourceIdFor(env, logicalKey, resourceKind) {
  const row = await env.DB.prepare(
    `SELECT resource_id FROM resource_units WHERE logical_key=? AND resource_kind=? LIMIT 1`
  ).bind(logicalKey, resourceKind).first();
  return row?.resource_id || null;
}

/// A read against the GitHub API through the portal's own token.
///
/// Kept here rather than added to `github_collab.js` because that module's
/// contract is the *proposal* conversation (fork, branch, commit, PR) and each
/// of its exports has an existing test; this is a plain authenticated GET whose
/// only variance is the URL. A non-2xx is mapped onto the same codes the module
/// uses, so the two cannot disagree about what a 404 means.
async function githubRequest(env, path, { token = null, method = "GET", body = undefined, fetchImpl = undefined } = {}) {
  const auth = String(token || env?.GITHUB_PR_TOKEN || "").trim();
  const doFetch = fetchImpl || githubFetchImpl(env) || globalThis.fetch;
  if (typeof doFetch !== "function") throw new HttpError(502, "github_unreachable");
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "mltd-translation-portal",
    "x-github-api-version": "2022-11-28",
  };
  if (auth) headers.authorization = `Bearer ${auth}`;
  const init = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await doFetch(`https://api.github.com${path}`, init);
  } catch (err) {
    throw new HttpError(502, "github_unreachable");
  }
  const status = Number(response?.status) || 0;
  let text = "";
  try {
    text = await response.text();
  } catch (_) {
    text = "";
  }
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      parsed = { message: text.slice(0, 200) };
    }
  }
  if (status < 200 || status >= 300) {
    if (status === 401) throw new HttpError(502, "github_unauthorized");
    if (status === 403) throw new HttpError(502, "github_forbidden");
    if (status === 404) throw new HttpError(404, "github_not_found");
    if (status === 429) throw new HttpError(502, "github_rate_limited");
    throw new HttpError(502, `github_error_${status}`);
  }
  return { status, body: parsed };
}

// ============================================================================
// Source-bound single-line text editing
// ============================================================================
//
// The old proposal route took a whole `content` string and committed it. That is
// the wrong shape for this UI: the dashboard edits ONE row of a JSONL file, and
// a client that has to send the entire file back is a client that can silently
// drop every other row it failed to parse, or race a concurrent edit. So the
// route takes the *identity* of the row instead of the file:
//
//   resource.github = { target, path, base_commit, source_sha256 }
//   + logical_key / bundle / item_key / translation (+ asset_version|client_version)
//
// and the server does the rest: it reads the pinned file at `base_commit`, finds
// the one row whose identity matches, verifies that row's source against the
// pinned hash, and rewrites only that row's translation. Every other line is
// carried through byte-for-byte. There is no input anywhere in this path that
// lets a caller supply the file's contents.

/// Read the source binding off a proposal body.
///
/// Two accepted shapes, and they are the *same* facts:
///
///   * the frozen front-end contract — `target`, `path`, `base_commit`,
///     `source_sha256` at the top level;
///   * the nested `resource.github` form, kept as an equivalent alias for a
///     caller that prefers to group them.
///
/// Supplying both is legal only when they agree: a body that names one file in
/// `path` and another in `resource.github.path` is refused, because there is no
/// reading of that request in which the caller meant one of them.
function readResourceBinding(body) {
  const flat = {
    target: body?.target,
    path: body?.path,
    base_commit: body?.base_commit,
    source_sha256: body?.source_sha256,
  };
  const nested = body?.resource?.github;
  if (body?.resource !== undefined && body?.resource !== null) {
    if (typeof body.resource !== "object" || Array.isArray(body.resource)) throw new HttpError(400, "resource_invalid");
    if (nested === undefined || nested === null) throw new HttpError(400, "missing_binding");
    if (typeof nested !== "object" || Array.isArray(nested)) throw new HttpError(400, "missing_binding");
  }
  const supplied = (value) => value !== undefined && value !== null && String(value).trim() !== "";
  if (nested) {
    for (const field of ["target", "path", "base_commit", "source_sha256"]) {
      const a = supplied(flat[field]) ? String(flat[field]).trim().toLowerCase() : null;
      const b = supplied(nested[field]) ? String(nested[field]).trim().toLowerCase() : null;
      if (a && b && a !== b) throw new HttpError(409, "binding_conflict");
    }
  }
  const pick = (field) => {
    if (nested && supplied(nested[field])) return nested[field];
    return flat[field];
  };
  const target = String(pick("target") || "").trim().toLowerCase();
  if (!GITHUB_TARGET_KINDS.includes(target)) throw new HttpError(400, "target_invalid");
  // Shape only. The *channel's* rule is applied later, once the target is known:
  // the assets whitelist describes the assets repository, and a client row lives
  // in a different one whose layout the deployment declares.
  const rawPath = pick("path");
  const cleanPath = String(rawPath ?? "").trim().replace(/^\/+/, "");
  if (typeof rawPath !== "string" || !cleanPath) throw new HttpError(400, "path_invalid");
  if (/\.\./.test(cleanPath) || cleanPath.includes("\\")) throw new HttpError(400, "path_invalid");
  if (/\.unity3d$/i.test(cleanPath)) throw new HttpError(400, "unity3d_upload_rejected");
  const path = cleanPath;
  const baseCommit = String(pick("base_commit") || "").trim().toLowerCase();
  // Fail closed: the file the row is pinned to must be named by the commit it
  // was read at. "Read the default branch instead" is exactly the drift this
  // field exists to prevent.
  if (!FULL_SHA.test(baseCommit)) throw new HttpError(400, "base_commit_required");
  const sourceSha = String(pick("source_sha256") || "").trim().toLowerCase();
  if (!HEX64_ANY.test(sourceSha)) throw new HttpError(400, "resource_source_sha256_invalid");
  return { target, path, base_commit: baseCommit, source_sha256: sourceSha };
}

/// The version a `resource.github.target` pins, refused if it is a composite.
function pinnedVersion(env, target, body) {
  const field = target === "assets" ? "asset_version" : "client_version";
  const other = target === "assets" ? "client_version" : "asset_version";
  if (body?.[other] !== undefined && body?.[other] !== null && String(body[other]).trim()) {
    throw new HttpError(400, "independent_axes_violated");
  }
  const version = rejectCompositeVersion(body?.[field]);
  if (!version) throw new HttpError(400, field === "asset_version" ? "missing_asset_version" : "missing_client_version");
  return version;
}

/// Read `path` at `base_commit` through the portal's own token, and split it
/// into lines.
///
/// The read is pinned to the *commit*, not to a branch: a branch name resolves
/// to whatever tip it has when the request runs, so the file could change
/// between the client's read and this one and the `source_sha256` check would be
/// verifying a different revision than the one being edited.
async function readPinnedFile(env, { target, path, baseCommit, fetchImpl, token }) {
  const repo = githubTargetRepo(env, target);
  // The contributor's own token, which is inside the same permission envelope as
  // the commit that follows it: a file this token cannot read is a file it could
  // not have committed either, and finding that out at the read is better than at
  // the write.
  if (!String(token || "").trim()) throw new HttpError(401, "github_user_token_absent");
  const result = await githubRequest(env, `/repos/${repo.full_name}/contents/${path}?ref=${encodeURIComponent(baseCommit)}`, { token, fetchImpl });
  const body = result.body;
  if (Array.isArray(body)) throw new HttpError(400, "resource_path_not_a_file");
  if (!body || typeof body !== "object") throw new HttpError(502, "github_content_response_invalid");
  if (body.type && body.type !== "file") throw new HttpError(400, "resource_path_not_a_file");
  if (body.encoding && body.encoding !== "base64") throw new HttpError(502, "github_content_encoding_unsupported");
  const encoded = String(body.content || "").replace(/\s+/g, "");
  if (!encoded) throw new HttpError(502, "github_content_empty");
  const bytes = base64ToBytes(encoded);
  if (bytes.length > MAX_PR_FILE_BYTES) throw new HttpError(413, "resource_file_too_large");
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (text.includes("�")) throw new HttpError(422, "resource_file_not_utf8");
  // `split("\n")` keeps a trailing empty entry for a file that ends in a
  // newline. That entry is preserved by the writer, so the file's final newline
  // survives the round trip.
  const lines = text.split("\n");
  if (lines.length > MAX_RESOURCE_LINES) throw new HttpError(413, "resource_file_too_many_lines");
  // The blob sha is not optional: the commit that follows updates an existing
  // file, and GitHub's contents API identifies that file by its blob sha, not by
  // the commit it was read at. A read that cannot produce one cannot produce a
  // proposal.
  const blobSha = String(body.sha || "").trim();
  if (!/^[0-9a-f]{40}$/i.test(blobSha)) throw new HttpError(502, "github_content_blob_sha_missing");
  return { repo, lines, blob_sha: blobSha, size: bytes.length };
}

/// Where a caller-supplied identity lands in a JSONL row. The row's own keys are
/// tried in a fixed order; `logical_key` may also be the bare `bundle:item_key`
/// form the export pipeline writes.
function rowMatchesIdentity(row, identity) {
  const text = (value) => (typeof value === "string" ? value : null);
  const candidates = new Set();
  for (const field of ["logical_key", "key", "item_key", "id", "logical"]) {
    const value = text(row[field]);
    if (value) candidates.add(value);
  }
  const bundle = text(row.bundle);
  const itemKey = text(row.item_key ?? row.key);
  if (bundle && itemKey) {
    candidates.add(`${bundle}:${itemKey}`);
    candidates.add(`${bundle}/${itemKey}`);
  }
  if (identity.logicalKey && candidates.has(identity.logicalKey)) return "logical_key";
  if (identity.itemKey && candidates.has(identity.itemKey)) return "item_key";
  return null;
}

/// The source text of a row, as the export writes it.
function rowSource(row) {
  if (typeof row.ja === "string") return row.ja;
  if (typeof row.source === "string") return row.source;
  return null;
}

/// The translation field of a row, present or not.
function rowHasTranslationField(row) {
  return Object.prototype.hasOwnProperty.call(row, "zh") || Object.prototype.hasOwnProperty.call(row, "translation");
}

/// Parse the file's lines into `{ index, row }` entries, refusing a file that is
/// not a JSONL object per line. A blank line is skipped (a trailing newline
/// produces one) and is left untouched by the writer.
function parseJsonlRows(lines) {
  const rows = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (_) {
      throw new HttpError(422, "resource_file_row_invalid_json");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(422, "resource_file_row_invalid_json");
    rows.push({ index, row: parsed });
  }
  return rows;
}

/// The translation-bearing field of a *client* manifest slot, present or not.
///
/// The client manifest is the shape the repository actually holds: a `slots`
/// array whose entries are `{index, ja, zh, provenance}`. `index` is the slot's
/// identity — it is what the atlas coordinate refers to — so a slot is addressed
/// by it and never by position.
function manifestSlotHasTranslation(slot) {
  return Object.prototype.hasOwnProperty.call(slot, "zh") || Object.prototype.hasOwnProperty.call(slot, "translation");
}

/// Rewrite exactly one slot of a pinned client manifest.
///
/// The same three verifications as the JSONL editor, in the same order — exactly
/// one slot matches the identity, that slot's own `ja`/`source` hashes to the
/// pin, and the slot carries a translation field — and the same promise
/// afterwards: every other byte of the document is unchanged.
async function editPinnedManifest(text, { identity, sourceSha256, translation, updatedAt }) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (_) {
    throw new HttpError(422, "resource_file_row_invalid_json");
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new HttpError(422, "resource_file_row_invalid_json");
  const slots = Array.isArray(doc.slots) ? doc.slots : null;
  if (!slots) throw new HttpError(422, "resource_manifest_slots_missing");

  // A slot's identity is its `index`. `logical_key`/`item_key` may name the same
  // slot; when they do, they must agree with it.
  const wanted = String(identity.itemKey ?? identity.slotIndex ?? "").trim();
  const matches = [];
  for (const slot of slots) {
    if (!slot || typeof slot !== "object") throw new HttpError(422, "resource_file_row_invalid_json");
    const index = slot.index === undefined || slot.index === null ? "" : String(slot.index);
    if (index && (index === wanted || index === String(identity.logicalKey || ""))) matches.push(slot);
  }
  if (matches.length === 0) throw new HttpError(404, "resource_row_not_found");
  if (matches.length > 1) throw new HttpError(409, "resource_row_ambiguous");
  const slot = matches[0];
  const source = typeof slot.ja === "string" ? slot.ja : (typeof slot.source === "string" ? slot.source : null);
  if (source === null) throw new HttpError(422, "resource_row_source_missing");
  const actual = await sha256(source);
  if (actual !== String(sourceSha256).toLowerCase()) throw new HttpError(409, "resource_source_mismatch");
  if (!manifestSlotHasTranslation(slot)) throw new HttpError(422, "resource_row_not_translatable");
  const key = Object.prototype.hasOwnProperty.call(slot, "zh") ? "zh" : "translation";
  const previous = typeof slot[key] === "string" ? slot[key] : null;
  slot[key] = translation;
  if (typeof doc.updated_at === "string") doc.updated_at = updatedAt;
  // The serialized form is the one the commit carries. `JSON.stringify` on the
  // parsed document reproduces the input byte for byte when nothing changed,
  // which is what makes "only this slot moved" checkable below.
  const next = JSON.stringify(doc, null, 2) + (text.endsWith("\n") ? "\n" : "");
  const rebuilt = JSON.stringify(JSON.parse(text), null, 2) + (text.endsWith("\n") ? "\n" : "");
  if (rebuilt !== text && text.trim().startsWith("{")) {
    // The document is not in the formatting this writer produces, so a rewrite
    // would touch every line. Refusing is the honest answer: the portal will not
    // report a single-slot edit it cannot prove.
    const untouched = JSON.stringify(JSON.parse(text)) === JSON.stringify(doc);
    if (!untouched) throw new HttpError(409, "resource_manifest_reformat_required");
  }
  return {
    text: next,
    row_index: slots.indexOf(slot),
    row_field: key,
    previous,
    matched_by: "slot_index",
    lines_total: slots.length,
  };
}

/// Rewrite exactly one row of a pinned file.
///
/// The three verifications, in order of specificity:
///   1. exactly one row matches the identity (0 -> `resource_row_not_found`,
///      >1 -> `resource_row_ambiguous`);
///   2. that row's own source hashes to the pinned `source_sha256`
///      (`resource_source_mismatch`) — checked against the *file*, not only
///      against the catalogue, so a file row and a catalogue row that disagree
///      cannot produce a silent overwrite of the wrong line;
///   3. the row carries a translation field (`resource_row_not_translatable`).
///
/// Then the property the whole route exists for, asserted rather than assumed:
/// not one other line may differ.
async function editPinnedRow(lines, { identity, sourceSha256, translation, updatedAt }) {
  const rows = parseJsonlRows(lines);
  const matches = rows.filter(({ row }) => rowMatchesIdentity(row, identity));
  if (matches.length === 0) throw new HttpError(404, "resource_row_not_found");
  if (matches.length > 1) throw new HttpError(409, "resource_row_ambiguous");
  const { index, row } = matches[0];
  const source = rowSource(row);
  if (source === null) throw new HttpError(422, "resource_row_source_missing");
  const actual = await sha256(source);
  if (actual !== String(sourceSha256).toLowerCase()) throw new HttpError(409, "resource_source_mismatch");
  if (!rowHasTranslationField(row)) throw new HttpError(422, "resource_row_not_translatable");
  const key = Object.prototype.hasOwnProperty.call(row, "zh") ? "zh" : "translation";
  const previous = typeof row[key] === "string" ? row[key] : null;
  row[key] = translation;
  // The record's own timestamp moves with its content. Written only when the row
  // already has one: inventing a field the schema does not define would be this
  // route editing the data model.
  if (typeof row.updated_at === "string") row.updated_at = updatedAt;
  // `translation_status` is the content-change axis, and an edited translation is
  // `modified` — §6.3 rule 2 of docs/GITHUB_LOCALIZATION_REPO_SPEC.md. Touched
  // only when the row already carries the field, for the same reason.
  if (typeof row.translation_status === "string") row.translation_status = "modified";
  const copy = lines.slice();
  copy[index] = JSON.stringify(row);
  for (let position = 0; position < copy.length; position += 1) {
    if (position !== index && copy[position] !== lines[position]) throw new HttpError(500, "resource_single_line_violation");
  }
  return {
    text: copy.join("\n"),
    row_index: index,
    row_key: key,
    previous,
    matched_by: rowMatchesIdentity(row, identity),
    lines_total: lines.length,
  };
}

function generateLogicalKey(kind, bundle, itemKey) {
  const clean = String(bundle || "").replace(/\.(gtx|unity3d)$/i, "");
  return `${kind}/${clean}/${itemKey}`;
}

// ============================================================================
// GitHub collaboration (OAuth + pull-request proposals)
// ============================================================================
//
// The portal does not push to a translation repository: it forks, writes one
// branch and opens a pull request. Review happens on GitHub, and the PR's own
// `state`/`merged` are the only authoritative review status — the D1 rows below
// mirror it for the maintainer dashboard and never vote on it.

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
/// The callback the OAuth flow lands on, derived from one trusted source.
///
/// It used to be a hard-coded host, which is how a deployment ends up pointing at
/// a domain that is not the site. The origin now comes from
/// `PORTAL_CANONICAL_ORIGIN` — the same setting the write guard uses, so there is
/// exactly one place a deployment names itself. The constant beside it is only a
/// fallback for a deployment that has not set one, and it is a *name*, not a
/// reflection: a request's own `Host` is never echoed in production, because
/// anyone can point a hostname at a Worker and a redirect_uri built from it would
/// make this endpoint an open redirector.
const OAUTH_REDIRECT_URL = "https://mltd-translate.nyaneko.cn/api/auth/github/callback";
const OAUTH_CALLBACK_PATH = "/api/auth/github/callback";

/// Whether a host is a local development origin.
///
/// These are the only hosts a request may name itself on: loopback and `.local`
/// are not registrable, so an attacker cannot point one at this Worker. Everything
/// else has to match the configured origin, or the deployment's fallback.
function isLocalDevelopmentHost(host) {
  const name = String(host || "").toLowerCase();
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]" || name === "::1" || name.endsWith(".local");
}

/// The configured origin, normalised, or `null` when a deployment has not set one.
function configuredOrigin(env) {
  const raw = String(env?.PORTAL_CANONICAL_ORIGIN || "").trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch (_) {
    throw new HttpError(503, "portal_canonical_origin_invalid");
  }
}

/// Where a proposal may be written, per target repository. A path outside these
/// prefixes is refused even when the fork and branch already exist — the
/// whitelist is what keeps the portal from becoming a general-purpose committer
/// into the translation repos.
const GITHUB_TARGET_KINDS = ["assets", "client"];
const GITHUB_PATH_PREFIXES = ["locales/", "lyrics/", "manifests/"];
const GITHUB_IMAGE_PATH_PREFIX = "images/";
const MAX_PR_FILE_BYTES = 2 * 1024 * 1024;

function githubTargetRepo(env, target) {
  const kind = String(target || "").trim().toLowerCase();
  if (!GITHUB_TARGET_KINDS.includes(kind)) {
    throw new HttpError(400, "target_invalid");
  }
  const spec = kind === "assets" ? env.GITHUB_TARGET_ASSETS : env.GITHUB_TARGET_CLIENT;
  const value = String(spec || "").trim();
  // Fail closed: an unconfigured target is a deployment error, not a default.
  if (!value) throw new HttpError(503, `github_target_${kind}_unconfigured`);
  try {
    return parseRepoSpec(value);
  } catch (err) {
    throw new HttpError(503, `github_target_${kind}_invalid`);
  }
}

function githubBaseBranch(env, target) {
  const value = target === "assets" ? env.GITHUB_BASE_BRANCH_ASSETS : env.GITHUB_BASE_BRANCH_CLIENT;
  const branch = String(value || "").trim() || "main";
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/.test(branch) || branch.includes("..")) {
    throw new HttpError(503, "github_base_branch_invalid");
  }
  return branch;
}

/// A composite version is never an identity. Refused here as well as at the
/// registry boundary so the proposal path cannot be reached with one at all.
function rejectCompositeVersion(value) {
  const str = String(value ?? "").trim();
  if (!str) return null;
  if (str.includes("+") || /^assets-/i.test(str)) throw new HttpError(400, "composite_version_rejected");
  return str;
}

function requireGithubWritablePath(path, { allowImage = false } = {}) {
  const clean = String(path ?? "").trim().replace(/^\/+/, "");
  if (typeof path !== "string" || !clean) throw new HttpError(400, "path_invalid");
  if (/\.\./.test(clean)) throw new HttpError(400, "path_invalid");
  // Unity3D bundles are never pushed from here: a binary container edited by a
  // web form cannot be reviewed as a diff, and backfilling one is CI's job.
  if (/\.unity3d$/i.test(clean)) throw new HttpError(400, "unity3d_upload_rejected");
  const allowed = allowImage
    ? [...GITHUB_PATH_PREFIXES.filter((prefix) => prefix !== "locales/"), GITHUB_IMAGE_PATH_PREFIX]
    : GITHUB_PATH_PREFIXES;
  if (!allowed.some((prefix) => clean.startsWith(prefix))) throw new HttpError(400, "path_not_allowed");
  return clean;
}

/// The `fetch` the collaboration calls use. Production leaves this undefined, so
/// the module falls back to the runtime's global `fetch`; a test can inject a
/// recording implementation through the env without any network access.
function githubFetchImpl(env) {
  const impl = env?.GITHUB_COLLAB_FETCH;
  return typeof impl === "function" ? impl : undefined;
}

/// Whether a proposal may bypass the fork and commit straight into the target
/// repository. Off unless explicitly switched on: a token that can already write
/// to the target makes GitHub answer `POST .../forks` with a 202 that describes
/// the *source* repository, and following that answer means opening a branch and
/// commits in the upstream under the portal's name with no fork in between.
/// Only this exact value enables it — a typo, an empty variable or "true " all
/// stay closed.
function githubAllowUpstream(_env) {
  // Retired GITHUB_PR_ALLOW_UPSTREAM: public collaboration always requires a fork.
  return false;
}

/// A collab failure carries GitHub's own status; anything else is this
/// service's bad gateway. The code is passed through so a caller can branch on
/// `branch_exists` versus `pr_already_exists` instead of parsing prose.
function collabError(err) {
  if (err instanceof GitHubCollabError) throw new HttpError(err.httpStatus, err.code);
  throw err;
}

function redirectTo(url) {
  return new Response(null, { status: 302, headers: { location: url, "cache-control": "no-store" } });
}

/// The one callback URL this request's flow uses, for the authorize redirect and
/// the token exchange alike. Both halves call this function, so the two cannot
/// disagree about `redirect_uri` — GitHub rejects a mismatch, and a deployment
/// that produced one would fail every login.
///
/// The order is deliberate:
///
///   1. a local development host, because a dev server is served from one origin
///      and cannot be reached through the production one — and because loopback
///      and `.local` cannot be pointed at this Worker by anyone else;
///   2. the configured origin, when the request *is* that origin;
///   3. the configured origin anyway, when the request arrived on some other host
///      (a preview deployment, a stale DNS name) — the callback stays on the
///      address GitHub knows, rather than naming a host the flow did not come
///      from;
///   4. the deployment's fallback, when no origin is configured.
///
/// A request on any other host is never echoed: `Host` is attacker-controllable,
/// and a `redirect_uri` built from it would make this an open redirector.
function callbackUrl(request, env) {
  let url;
  try {
    url = new URL(request.url);
  } catch (_) {
    return OAUTH_REDIRECT_URL;
  }
  const host = String(url.hostname || "").toLowerCase();
  if (isLocalDevelopmentHost(host)) {
    const scheme = url.protocol === "https:" ? "https:" : "http:";
    return `${scheme}//${url.host}${OAUTH_CALLBACK_PATH}`;
  }
  const origin = configuredOrigin(env);
  if (origin) return `${origin}${OAUTH_CALLBACK_PATH}`;
  return OAUTH_REDIRECT_URL;
}

/// The stable key a GitHub identity row is stored under. `github:<numeric id>`,
/// never the login: a login can be renamed, and a renamed login must not be able
/// to claim the row (and the history) of whoever held it before.
async function readGithubIdentity(env, identityKey) {
  return env.DB.prepare(
    `SELECT actor_key, login, github_user_id, avatar_url, access_token_ref, created_at, updated_at FROM github_identities WHERE actor_key=?`
  ).bind(identityKey).first();
}

/// The GitHub account that owns a login, read back through the portal's own
/// token. Used only to *detect* a rename: an identity is never re-bound to a new
/// account by name.
async function lookupGithubUser(env, login) {
  const { body } = await githubRequest(env, `/users/${encodeURIComponent(login)}`);
  if (!body?.id) throw new HttpError(502, "github_user_invalid");
  return { id: Number(body.id), login: String(body.login || login) };
}

/// Exchange an authorization code for a token, and read the account it belongs
/// to.
///
/// The token is *not* discarded any more: a proposal opened with the deployment's
/// own `GITHUB_PR_TOKEN` is authored by whichever account holds it, so the portal
/// could not show that the person who signed in is the person GitHub records as
/// the author. Review is a merge on GitHub, and an author identity that is
/// somebody else is not reviewable.
///
/// The caller stores the token through `github_user_token.js` (encrypted, or not
/// at all when no key is configured) and drops the local reference. Nothing on
/// this path logs it, returns it or audits it; the only value read from it here
/// is the account it names.
async function exchangeCodeForIdentity(env, { code, redirectUri, fetchImpl }) {
  const exchanged = await exchangeCodeForToken({
    clientId: env.GITHUB_OAUTH_CLIENT_ID,
    clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
    code,
    redirectUri,
    fetchImpl,
  });
  const token = exchanged.access_token;
  const user = await getAuthenticatedUser({ token, fetchImpl });
  return { token, user };
}

/// Where the callback may send a *human browser* once the login lands. Strictly
/// same-site paths, never a URL: `//evil` and `/\evil` both parse as a
/// protocol-relative URL in some clients, so anything that is not a single `/`
/// followed by a non-slash is dropped.
function safeReturnTo(value) {
  const text = String(value || "").trim();
  if (!text) return "/";
  if (!text.startsWith("/") || text.startsWith("//") || text.startsWith("/\\")) return "/";
  if (text.length > 300) return "/";
  return text;
}

/// Whether the caller asked for JSON rather than a browser redirect. Only an
/// explicit `Accept: application/json` counts; a browser sends `text/html`.
function wantsJsonResponse(request, url) {
  if (url.searchParams.get("format") === "json") return true;
  return String(request.headers.get("accept") || "").includes("application/json");
}

/// `GET /api/auth/github/login` — the *only* login this portal needs.
///
/// No Access identity is required to start: requiring one was the bug. A plain
/// GitHub user reaches this route anonymously, and the round trip ends with a
/// portal session bound to `github:<id>`. The `state` row records where the
/// browser came from (`return_to`) so the callback has somewhere to send it, and
/// the browser gets a random HttpOnly cookie whose hash is stored beside the
/// state — the state is then useless in any other browser.
async function githubLogin(request, env) {
  if (!env.DB && !env.PUBLICATION_BUCKET) throw new HttpError(503, "database_unavailable");
  const clientId = String(env.GITHUB_OAUTH_CLIENT_ID || "").trim();
  if (!clientId) throw new HttpError(503, "github_oauth_unconfigured");

  const state = createOAuthState();
  const browserBinding = newOpaqueToken();
  const bindingHash = await hashSessionToken(env, browserBinding);
  const timestamp = now();
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString();
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("return_to"));
  try {
    await env.DB.prepare(
      `INSERT INTO github_oauth_states (state, actor_key, created_at, expires_at, consumed_at, browser_binding_hash, return_to) ` +
      `VALUES (?, NULL, ?, ?, NULL, ?, ?)`
    ).bind(state, timestamp, expiresAt, bindingHash, returnTo).run();
    // Opportunistic sweeps; an expired-but-unconsumed row is useless and a replay
    // is refused by the expiry checks below regardless of whether these ran.
    await env.DB.prepare(`DELETE FROM github_oauth_states WHERE expires_at < ?`).bind(timestamp).run();
    await env.DB.prepare(`DELETE FROM portal_sessions WHERE expires_at < ? AND revoked_at IS NULL`).bind(timestamp).run();
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes("no such table") || msg.includes("no such column")) throw new HttpError(503, "portal_auth_migration_pending");
    if (!quotaLike(err) || !await writeAuthObject(env, "oauth", state, {
      state, actor_key: null, created_at: timestamp, expires_at: expiresAt,
      consumed_at: null, browser_binding_hash: bindingHash, return_to: returnTo,
    })) throw err;
  }
  const response = redirectTo(buildAuthorizeUrl({ clientId, redirectUri: callbackUrl(request, env), state }));
  return withCookies(response, [oauthBindingCookie(env, browserBinding)]);
}

/// `GET /api/auth/github/callback` — finish the flow, mint a session.
///
/// Every refusal here is a *refusal*, never a redirect to `/`: a callback that
/// silently dropped a failed login onto the home page would look identical to a
/// successful one from the outside, and an operator would have no code to read.
/// `Accept: application/json` (or `?format=json`) asks for the JSON form, which
/// is what a test and a fetch-driven client use.
async function githubCallback(request, env) {
  if (!env.DB) throw new HttpError(503, "database_unavailable");
  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const wantsJson = wantsJsonResponse(request, url);
  const fail = (status, error) => json({ error }, status, { "cache-control": "no-store" });
  if (!state) return fail(400, "oauth_state_missing");
  if (!code) return fail(400, "oauth_code_missing");

  let row;
  let stateFromFallback = false;
  try {
    row = await env.DB.prepare(
      `SELECT state, actor_key, expires_at, consumed_at, browser_binding_hash, return_to FROM github_oauth_states WHERE state=?`
    ).bind(state).first();
  } catch (err) {
    if (!quotaLike(err)) throw err;
    row = await readAuthObject(env, "oauth", state);
    stateFromFallback = Boolean(row);
  }
  // One-shot consumption: a row that does not exist, was already spent, or has
  // aged out is refused. The claim is the UPDATE — a `consumed_at` that was
  // non-null when read and still null after the write means some other request
  // won the race, and this one must not exchange the code.
  if (!row) return fail(400, "oauth_state_unknown");
  if (row.consumed_at) return fail(400, "oauth_state_replayed");
  if (new Date(row.expires_at).getTime() <= Date.now()) return fail(400, "oauth_state_expired");

  // The browser binding. `state` alone proves only that *someone* started a
  // flow; the cookie proves it was *this* browser. A `state` copied out of a
  // shared link, a proxy log or a shoulder is therefore not a login.
  const bindingHash = row.browser_binding_hash;
  if (bindingHash === "legacy") return fail(400, "oauth_state_browser_binding_legacy");
  if (!bindingHash) return fail(400, "oauth_state_browser_binding_missing");
  const presentedBinding = String(readCookie(request, OAUTH_BINDING_COOKIE_NAME) || "").trim();
  if (!HEX64_ANY.test(presentedBinding)) return fail(400, "oauth_state_browser_binding_missing");
  const presentedHash = await hashSessionToken(env, presentedBinding);
  if (!timingSafeEqual(presentedHash, String(bindingHash))) return fail(400, "oauth_state_browser_binding_mismatch");

  if (stateFromFallback) {
    if (!await deleteAuthObject(env, "oauth", state)) return fail(400, "oauth_state_replayed");
  } else {
    let claimed;
    try {
      claimed = await env.DB.prepare(
        `UPDATE github_oauth_states SET consumed_at=? WHERE state=? AND consumed_at IS NULL`
      ).bind(now(), state).run();
    } catch (err) {
      if (!quotaLike(err)) throw err;
      if (!await writeAuthObject(env, "oauth", state, { ...row, consumed_at: now() })) return fail(503, "d1_quota_exceeded");
      await deleteAuthObject(env, "oauth", state);
      claimed = { meta: { changes: 1 } };
    }
    const changed = claimed?.meta?.changes ?? claimed?.changes ?? 0;
    if (!changed) return fail(400, "oauth_state_replayed");
  }

  const fetchImpl = githubFetchImpl(env);
  try {
    const { token: userToken, user } = await exchangeCodeForIdentity(env, { code, redirectUri: callbackUrl(request, env), fetchImpl });
    const githubUserId = Number(user.id);
    if (!Number.isFinite(githubUserId) || githubUserId <= 0) return fail(502, "github_user_invalid");
    const login = String(user.login);
    const identityKey = githubIdentityKey(githubUserId);
    const timestamp = now();

    // A rename is detected through GitHub's own `/users/<login>` and resolved by
    // moving the row, never by creating a second one for the new name. `login` is
    // UNIQUE, so the conflict branch below is the rename landing.
    let created = false;
    let identity = await readGithubIdentity(env, identityKey);
    if (!identity) {
      try {
        await env.DB.prepare(
          `INSERT INTO github_identities (actor_key, login, github_user_id, avatar_url, access_token_ref, created_at, updated_at) ` +
          `VALUES (?, ?, ?, ?, NULL, ?, ?)`
        ).bind(identityKey, login, githubUserId, user.avatar_url || null, timestamp, timestamp).run();
        created = true;
      } catch (insertError) {
        if (quotaLike(insertError)) {
          // D1 may be temporarily unable to accept rows on the free tier. The
          // session/token fallback still has the verified GitHub identity, so
          // do not turn a successful OAuth exchange into a false login failure.
          identity = {
            actor_key: identityKey,
            login,
            github_user_id: githubUserId,
            avatar_url: user.avatar_url || null,
          };
          created = true;
        } else {
          const holder = await env.DB.prepare(`SELECT actor_key FROM github_identities WHERE login=?`).bind(login).first();
          if (!holder) throw new HttpError(409, "github_identity_conflict");
          if (holder.actor_key !== identityKey) {
          // Somebody's row already holds this login. Confirm with GitHub that the
          // account behind it is the *new* numeric id before adopting it —
          // otherwise a rename would hand one account's history to another.
            const owner = await lookupGithubUser(env, login);
            if (Number(owner.id) !== githubUserId) throw new HttpError(409, "github_identity_conflict");
            await env.DB.prepare(`DELETE FROM github_identities WHERE login=?`).bind(login).run();
            await env.DB.prepare(
              `INSERT INTO github_identities (actor_key, login, github_user_id, avatar_url, access_token_ref, created_at, updated_at) ` +
              `VALUES (?, ?, ?, ?, NULL, ?, ?)`
            ).bind(identityKey, login, githubUserId, user.avatar_url || null, timestamp, timestamp).run();
            created = true;
          }
        }
      }
      if (!identity) identity = await readGithubIdentity(env, identityKey);
    } else if (identity.login !== login || Number(identity.github_user_id) !== githubUserId) {
      await env.DB.prepare(
        `UPDATE github_identities SET login=?, github_user_id=?, avatar_url=?, updated_at=? WHERE actor_key=?`
      ).bind(login, githubUserId, user.avatar_url || null, timestamp, identityKey).run();
    }

    // The role is derived here, once, from the allowlists. Note what is *not*
    // consulted: `ADMIN_EMAILS` cannot promote a GitHub account, because GitHub
    // does not tell us an email and a value the client chose is not evidence.
    // Custody. With a key, the token is sealed into `github_user_tokens` and the
    // writes that follow are authored by this contributor. Without one, the
    // session is still minted — signing in must not fail because a deployment has
    // not finished configuring itself — and the write routes refuse with
    // `github_user_token_custody_unconfigured` rather than quietly falling back
    // to the shared deployment token.
    let tokenCustody = "stored";
    if (tokenCustodyConfigured(env)) {
      try {
        await putUserToken(env, identityKey, userToken);
      } catch (err) {
        // A storage failure is a real failure: a session whose writes will all be
        // refused is worse than a login that says it could not complete.
        if (isQuotaError(err)) return quotaResponse(err);
        tokenCustody = "stored_failed";
        console.warn("github user token custody failed:", err?.code || err?.name || "error");
      }
    } else {
      tokenCustody = "unconfigured";
    }

    const role = roleFor(env, { login });
    const issued = await issueSession(env, {
      actor: { key: identityKey, email: null, login, github_user_id: githubUserId, role },
      request,
    });
    await audit(env, identityKey, "github_login", "portal_session", identityKey, {
      login,
      github_user_id: githubUserId,
      role,
      // A fingerprint, not the token: enough for an operator to correlate two
      // logins, useless to anyone who reads it.
      session: issued.token.slice(0, 8),
      identity_created: created,
      token_custody: tokenCustody,
    });
    await sweepExpiredSessions(env, { limit: 50 });
    const payload = {
      authenticated: true,
      login,
      github_user_id: githubUserId,
      avatar_url: user.avatar_url || null,
      role,
      csrfToken: issued.csrfToken,
      via: "github",
      // Whether this session can open proposals, and why not when it cannot. The
      // answer is a word, never a credential.
      token_custody: tokenCustody,
      can_submit: tokenCustody === "stored",
    };
    return withCookies(json(payload, 200, { "cache-control": "no-store" }), [
      issued.cookie,
      clearOauthBindingCookie(env),
    ]);
  } catch (err) {
    // The state is spent either way: the code it carried is single-use too, so
    // leaving the row unconsumed would only invite a replay of a dead code.
    const http = asHttpError(err);
    if (http) {
      if (!wantsJson) return fail(http.status, http.code);
      throw http;
    }
    collabError(err);
  }
}

/// `GET /api/auth/github/me` — the frozen front-end contract.
///
/// `{authenticated, login, github_user_id, avatar_url, role, csrfToken}`, and
/// nothing else: no token, no session id, no internal key. Anonymous is a clean
/// 401 `authentication_required`, which is what the shipped `public/app.js`
/// already treats as "not logged in".
async function githubMe(request, env) {
  const person = await currentActor(request, env);
  if (!person) throw new HttpError(401, "authentication_required");
  return json({
    authenticated: true,
    login: person.login || null,
    github_user_id: person.github_user_id ?? null,
    avatar_url: person.via === "github" ? await avatarFor(env, person) : null,
    role: person.role,
    // The write token the front end echoes in `x-csrf-token`. Per-session, so it
    // appears only in this response and in the `portal_sessions` row.
    csrfToken: person.csrfToken || null,
    via: person.via,
    // `token_custody`/`can_submit` are additive: the front end can tell "signed
    // in and able to propose" from "signed in, and this deployment cannot hold a
    // credential yet" without a failed submission to discover it. The value is a
    // word describing the *storage*, never anything derived from the token.
    token_custody: person.via === "github" ? await custodyState(env, person.key) : null,
    can_submit: person.via === "github" ? await canSubmit(env, person.key) : null,
  }, 200, { "cache-control": "no-store" });
}

/// Whether this session's token is held, and why not when it is not.
async function custodyState(env, actorKey) {
  if (!tokenCustodyConfigured(env)) return "unconfigured";
  try {
    const row = await env.DB.prepare(`SELECT actor_key FROM github_user_tokens WHERE actor_key=?`).bind(actorKey).first();
    if (row) return "stored";
  } catch (error) {
    if (!quotaLike(error)) return "unknown";
  }
  return (await readAuthObject(env, "tokens", actorKey)) ? "stored" : "absent";
}

/// Whether a proposal from this session would be accepted. The write routes are
/// the authority; this is the same question asked one step earlier so the UI can
/// disable a button instead of surfacing a failure.
async function canSubmit(env, actorKey) {
  return (await custodyState(env, actorKey)) === "stored";
}

/// The avatar is read from the identity row (written at login) rather than
/// re-fetched per page view: `/api/auth/github/me` is on the hot path of a
/// dashboard, and GitHub's rate limit is not.
async function avatarFor(env, person) {
  try {
    const identity = await readGithubIdentity(env, person.key);
    return identity?.avatar_url || null;
  } catch (_) {
    return null;
  }
}

/// The one place a proposal is assembled. Text and image submissions differ only
/// in how the payload is validated and which repository they land in.
///
/// Fail-closed on every input it cannot verify: no token, no fork, no branch, no
/// PR, no D1 row. There is deliberately no "best effort" path — a proposal that
/// half-succeeded is worse than one that was refused, because the contributor
/// would believe it was filed.
///
/// `content` is a text string (JSONL, locale files) or raw bytes (an image), and
/// it is handed to `putFile` unchanged — that function is what knows how to
/// encode each. Widening bytes to a string here would corrupt every value above
/// 0x7F before `putFile` ever saw them.
async function submitGithubProposal(env, {
  person,
  target,
  path,
  kind,
  content,
  message,
  contributionId = null,
  logicalKey = null,
  sourceSha256 = null,
  extra = {},
}) {
  const person0 = person;
  if (!env.DB) throw new HttpError(503, "database_unavailable");
  // The token this proposal is authored with is the *contributor's*. A shared
  // deployment token would open the PR under the portal's own account, so the
  // portal could not show that the person who signed in is the person GitHub
  // records as the author — and an author identity that is somebody else is not
  // reviewable. Resolved by `resolveWriteToken`, which also verifies the account;
  // a caller that already holds one (the text path, which needed it to read the
  // pinned file) passes it in rather than resolving twice.
  const token = String(extra.writer_token || "").trim() || await resolveWriteToken(env, person);
  const fetchImpl0 = githubFetchImpl(env);
  const repo = githubTargetRepo(env, target);
  const baseBranch = githubBaseBranch(env, target);
  // Each channel is checked against its own repository's rule: the assets
  // whitelist for `assets`, the deployment's declared client location for
  // `client`. One shared check would either refuse the client's real layout or
  // admit an assets-shaped path into the client repository.
  const filePath = target === "client" && kind !== "image"
    ? requireClientWritablePath(env, path)
    : requireGithubWritablePath(path, { allowImage: kind === "image" });
  const byteLength = typeof content === "string"
    ? content.length
    : (content instanceof Uint8Array || ArrayBuffer.isView(content) ? content.byteLength
      : (content instanceof ArrayBuffer ? content.byteLength : -1));
  if (byteLength < 0) throw new HttpError(400, "proposal_content_invalid");
  if (byteLength > MAX_PR_FILE_BYTES) throw new HttpError(413, "proposal_too_large");
  const fetchImpl = fetchImpl0;
  // A source-bound text proposal names its input by `base_commit` and by the
  // *blob* sha of the file as it was read there: GitHub's contents API updates a
  // file by blob sha, not by commit sha, so `sha` is what makes a DELETE+PUT of
  // an existing file an update rather than a 422. Only a caller with no binding —
  // an image upload — reaches GitHub with `lookupExisting` and no blob sha.
  const baseCommit = String(extra.base_commit || "").trim().toLowerCase();
  const blobSha = String(extra.blob_sha || "").trim();
  const pinnedCommit = FULL_SHA.test(baseCommit) ? baseCommit : "";
  // A pinned proposal always presents a blob sha: the file it edits is read
  // first (the text route) or looked up at the pin (the image route), and the
  // *absence* of a sha means "the file does not exist at that commit" — which is
  // a legitimate answer for a new localized texture, so it is spelled `null`
  // rather than an empty string. `lookupExisting` is therefore only for a caller
  // with no pin at all.
  const blobShaKnown = blobSha === "absent" || /^[0-9a-f]{40}$/i.test(blobSha);
  if (pinnedCommit && !blobShaKnown) throw new HttpError(500, "blob_sha_required");
  const lookupExisting = !pinnedCommit;

  try {
    // `GITHUB_PR_ALLOW_UPSTREAM` is off unless it is exactly "true". With a token
    // that cannot write to the target this changes nothing: GitHub forks and the
    // branch/commit/PR all happen in the fork. When the *configured* token can
    // already write to the target, GitHub creates no fork at all and answers 202
    // with the source repository; the default (closed) refuses that with
    // `fork_not_created_upstream_accessible`, and the open value runs the same
    // steps in the upstream instead — recorded as `upstream_direct` so an
    // operator can tell the two apart in D1, in the audit trail and in the
    // response. See docs/GITHUB_LOCALIZATION_REPO_SPEC.md §8.2.
    const fork = await ensureFork({ token, owner: repo.owner, repo: repo.repo, fetchImpl, allowUpstream: githubAllowUpstream(env) });
    if (!fork.default_branch) throw new HttpError(502, "github_fork_incomplete");
    const upstreamDirect = fork.upstream_direct === true;
    const forkOwner = fork.full_name.split("/")[0];
    // The branch is created at the pinned commit when the proposal names one: a
    // branch cut from the fork's current tip would carry the edit away from the
    // file contents it was verified against.
    const headSha = pinnedCommit || (await getBranchHead({ token, owner: forkOwner, repo: repo.repo, branch: baseBranch, fetchImpl })).sha;
    const branch = branchName(kind, newShortId());
    await createBranch({ token, owner: forkOwner, repo: repo.repo, branch, fromSha: headSha, fetchImpl });
    const written = await putFile({
      token,
      owner: forkOwner,
      repo: repo.repo,
      branch,
      path: filePath,
      content,
      message: message || `portal(${kind}): ${filePath}`,
      // `sha` is the blob sha of the file as it was read at the pin (or absent,
      // when the pin holds no such file). It travels with `lookupExisting: false`
      // so no second read is issued — and so a file that changed between the read
      // and the commit is a conflict from GitHub rather than a silent overwrite.
      sha: lookupExisting ? undefined : (blobSha === "absent" ? undefined : blobSha),
      lookupExisting,
      fetchImpl,
    });
    const pr = await createPullRequest({
      token,
      owner: repo.owner,
      repo: repo.repo,
      title: message || `[portal/${kind}] ${filePath}`,
      head: `${forkOwner}:${branch}`,
      base: baseBranch,
      body: [
        `Automated proposal from the MLTD translation portal.`,
        ``,
        `- target: ${repo.full_name} (${target})`,
        `- path: ${filePath}`,
        logicalKey ? `- logical_key: ${logicalKey}` : null,
        sourceSha256 ? `- source_sha256: ${sourceSha256}` : null,
        contributionId ? `- contribution: ${contributionId}` : null,
      ].filter((line) => line !== null).join("\n"),
      fetchImpl,
    });

    const timestamp = now();
    const prId = id();
    // The mirror row is keyed by (target_repo, head_branch): a retried
    // submission updates its own row instead of opening a second entry.
    await env.DB.prepare(
      `INSERT INTO github_prs (id, contribution_id, target_repo, base_branch, head_branch, fork_full_name, pr_number, pr_url, state, mergeable_state, head_sha, ci_status, created_by, created_at, updated_at) ` +
      `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?) ` +
      `ON CONFLICT(target_repo, head_branch) DO UPDATE SET pr_number=excluded.pr_number, pr_url=excluded.pr_url, state=excluded.state, ` +
      `head_sha=excluded.head_sha, contribution_id=COALESCE(excluded.contribution_id, github_prs.contribution_id), updated_at=excluded.updated_at`
    ).bind(prId, contributionId, repo.full_name, baseBranch, branch, upstreamDirect ? null : fork.full_name, pr.number, pr.html_url, pr.state, written.commit_sha, auditActor(person0), timestamp, timestamp).run();

    if (upstreamDirect) {
      // The mirror row's `fork_full_name` stays NULL — no fork was used — so the
      // one signal an operator reading D1 sees is this warning line, next to the
      // `upstream_direct: true` in the audit detail below.
      console.warn("github proposal committed to the upstream without a fork", JSON.stringify({
        target_repo: repo.full_name,
        head_branch: branch,
        pr_number: pr.number,
        configured_by: "GITHUB_PR_ALLOW_UPSTREAM",
      }));
    }

    if (logicalKey) {
      // The independent axes get their own row. The CHECK constraint on
      // `asset_axes` is what makes a composite version unrepresentable, so a
      // version that reached here by another route would fail the write.
      await env.DB.prepare(
        `INSERT INTO asset_axes (logical_key, asset_version, client_version, source_sha256, created_at) VALUES (?, ?, ?, ?, ?) ` +
        `ON CONFLICT(logical_key) DO UPDATE SET asset_version=COALESCE(excluded.asset_version, asset_axes.asset_version), ` +
        `client_version=COALESCE(excluded.client_version, asset_axes.client_version), source_sha256=COALESCE(excluded.source_sha256, asset_axes.source_sha256)`
      ).bind(logicalKey, extra.asset_version || null, extra.client_version || null, sourceSha256, timestamp).run();
    }
    memoryStats = null;
    await audit(env, auditActor(person0), "github_proposal_opened", "github_pr", String(pr.number), {
      target, repo: repo.full_name, path: filePath, branch, pr_url: pr.html_url, commit_sha: written.commit_sha,
      upstream_direct: upstreamDirect,
    });
    return {
      pr_number: pr.number,
      pr_url: pr.html_url,
      branch,
      // A `fork` field is only meaningful when a fork was used; when the commit
      // went straight to the upstream the field is null and `upstream_direct`
      // says so out loud.
      fork: upstreamDirect ? null : fork.full_name,
      target_repo: repo.full_name,
      base_branch: baseBranch,
      commit_sha: written.commit_sha,
      state: pr.state,
      upstream_direct: upstreamDirect,
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    return collabError(err);
  }
}

/// `POST /api/contributions/github-pr` — one route, two shapes.
///
/// Shape A (source-bound single-line edit) is what the dashboard uses: the body
/// names a *row* and the route reads the file itself. Shape B (raw `content`) is
/// kept for a caller that genuinely owns the whole file and has no row identity
/// to name. The two can never be mixed — a body carrying `resource` never has its
/// `content` read, and a body with no `resource` is never verified against a
/// file — so no proposal is ever half-checked.
/// The token a proposal is authored with, and the identity check that has to
/// pass before it is used.
///
/// Resolved once, up front, so a write fails on custody *before* it reads a file
/// or opens a fork: a refused proposal leaves nothing half-created. The identity
/// check is not optional — a stored token that GitHub now reports as a different
/// account is a stale or tampered row, and the row is dropped rather than used.
async function resolveWriteToken(env, person) {
  let userToken;
  try {
    userToken = await requireUserToken(env, person.key);
  } catch (err) {
    const http = asHttpError(err);
    if (http) throw http;
    throw err;
  }
  const fetchImpl = githubFetchImpl(env);
  let owner;
  try {
    owner = await getAuthenticatedUser({ token: userToken, fetchImpl });
  } catch (err) {
    const http = asHttpError(err);
    if (http) throw http;
    collabError(err);
  }
  if (owner.id && Number(owner.id) !== Number(person.github_user_id)) {
    await deleteUserToken(env, person.key);
    throw new HttpError(409, "github_user_mismatch");
  }
  return userToken;
}

/// `POST /api/contributions/github-pr` — the single-row edit, and nothing else.
///
/// The route used to have a second shape that took a whole `content` string and
/// committed it. It is gone. Two paths to the same repository, one of which is
/// verified against a pinned file and one of which is not, is one path too many:
/// the second is a way to commit text no source gate has seen, and the portal
/// exists to make every write traceable to a source it read itself.
async function submitGithubContribution(request, env, person) {
  const body = await request.json().catch(() => { throw new HttpError(400, "invalid_json"); });
  const message = typeof body.message === "string" ? body.message.slice(0, 240) : "";
  // Named refusal rather than a silent ignore: a caller still sending a whole
  // file is running against an old contract and has to be told so.
  if (body.content !== undefined && body.content !== null) throw new HttpError(400, "content_not_accepted");
  await ensureContributor(env, person);
  return submitSourceBoundTextProposal(env, person, body, message);
}

/// `POST /api/resources/:id/edit` — the shape the single-row editor sends.
///
/// The body carries only what the editor owns: the new translation, and optional
/// echoes of the binding it was shown. `base_commit` and `source_sha256` still
/// have to match — a pin that moved between the read and the write is refused
/// with the moved field named — but the caller never constructs a repository
/// path, and a path it does not construct is a path it cannot get wrong.
async function submitResourceEdit(request, env, person, resourceId, options = {}) {
  const body = await request.json().catch(() => { throw new HttpError(400, "invalid_json"); });
  // The route may carry its own deployment overrides (a test does; a deployment
  // does not), so the context is resolved against the same env the proposal will
  // be opened with — otherwise a context read from one configuration and a commit
  // written under another could disagree about the layout.
  const context = await editContextForResource(env, resourceId, options);
  if (!context.editable) {
    // The same reason the context reported, as a refusal: an editor that acts on
    // a context it was shown must not be able to submit past it.
    throw new HttpError(context.reason === "missing_binding" ? 409 : 400, context.reason);
  }
  const translation = textField(body.translation, "translation");
  const message = typeof body.message === "string" ? body.message.slice(0, 240) : "";
  // What the client was shown is what it must confirm back. A binding that went
  // stale between the read and the write is refused here, naming the field.
  if (body.base_commit !== undefined && String(body.base_commit).trim()
    && String(body.base_commit).trim().toLowerCase() !== context.github.base_commit) {
    throw new HttpError(409, "base_commit_moved");
  }
  if (body.source_sha256 !== undefined && String(body.source_sha256).trim()
    && String(body.source_sha256).trim().toLowerCase() !== context.github.source_sha256) {
    throw new HttpError(409, "resource_source_mismatch");
  }

  await ensureContributor(env, person);
  const proposal = await submitSourceBoundTextProposal(env, person, {
    // The frozen flat shape, built from the context this route just read: the
    // caller supplied the translation, the server supplies the binding.
    target: context.github.target,
    path: context.github.path,
    base_commit: context.github.base_commit,
    source_sha256: context.github.source_sha256,
    logical_key: context.logical_key,
    bundle: context.bundle,
    item_key: context.item_key,
    translation,
    asset_version: context.asset_version || undefined,
    client_version: context.client_version || undefined,
    message,
  }, message);
  return { ...proposal, resource_id: resourceId };
}

/// Shape A: locate the row in the pinned file, verify it, rewrite one line.
async function submitSourceBoundTextProposal(env, person, body, message) {
  const binding = readResourceBinding(body);
  const { target, path, base_commit: baseCommit, source_sha256: sourceSha256 } = binding;
  const version = pinnedVersion(env, target, body);
  const bundle = textField(body.bundle, "bundle", 512);
  const itemKey = textField(String(body.item_key ?? body.key ?? ""), "item_key", 1024);
  const logicalKey = typeof body.logical_key === "string" && body.logical_key.trim()
    ? textField(body.logical_key, "logical_key", 512)
    : null;
  const translation = textField(body.translation, "translation");
  const fetchImpl = githubFetchImpl(env);

  // 1. The channel's own path rule — the assets whitelist for `assets`, the
  //    deployment's declared client location for `client`. First, and before
  //    custody: "you may not write here" is a fact about the request, while "this
  //    deployment cannot hold a credential" is a fact about the deployment, and a
  //    caller that got the path wrong should hear about the path.
  const channelPath = target === "client" ? requireClientWritablePath(env, path) : requireGithubWritablePath(path, { allowImage: false });

  // 2. Custody and identity: a session that cannot author a proposal must be told
  //    so before this route reads anything or leaves any trace.
  const writerToken = await resolveWriteToken(env, person);

  // 2. The pinned file. Read before anything is written, so a missing file or a
  //    bad commit never leaves a half-created proposal behind.
  const pinned = await readPinnedFile(env, { target, path: channelPath, baseCommit, fetchImpl, token: writerToken });

  // 3. The catalogue: the release this version names must carry the unit, and its
  //    stored source must be the pinned one. This is the same model the retired
  //    `/api/contributions` route used, so a row cannot be invented by naming a
  //    path.
  let catalogue = null;
  let staticClientBinding = false;
  let staticAssetsBinding = false;
  try {
    // Each axis resolves its own release: the client's rows live in
    // `client_releases`, reached by `client_version`.
    const release = target === "assets"
      ? await getAssetsRelease(env, version)
      : await getClientRelease(env, version);
    if (release?.release_id) {
      const variant = await env.DB.prepare(
        `SELECT sv.source_sha256, sv.source FROM source_variants sv ` +
        `WHERE sv.release_kind=? AND sv.release_id=? AND sv.bundle=? AND sv.item_key=? LIMIT 1`
      ).bind(target, release.release_id, bundle, itemKey).first();
      if (variant) catalogue = variant;
    }
    if (!catalogue) {
      catalogue = await env.DB.prepare(
        `SELECT source_sha256, source FROM source_catalogue WHERE (base_version=? OR asset_version=?) AND bundle=? AND item_key=?`
      ).bind(version, version, bundle, itemKey).first();
    }
  } catch (err) {
    if (isQuotaError(err)) return quotaResponse(err);
    throw err;
  }
  // The generated Client manifest can be published before its optional D1
  // materialization catches up. The pinned file and source hash verification
  // below remain authoritative; this exception only covers the declared
  // bottom-bar manifest and a numeric slot identity.
  if (!catalogue && target === "client"
    && channelPath === clientManifestPath(env)
    && bundle === "manifests/bottom-bar.manifest.json"
    && /^\d+$/.test(itemKey)) {
    staticClientBinding = true;
  }
  if (!catalogue && target === "assets") {
    // 同一解析：manifest 认领但 pin 不可用时是这个版本的绑定不可用（503），
    // 不是「没有绑定」；旧 ref 才继续找 D1 目录行。
    const source = await resolveReleaseSource(env, "assets", version);
    if (source.axis === "broken") throw pinMissingError();
    staticAssetsBinding = Boolean(source.axis === "github"
      && source.pin === baseCommit
      && assetsPathMatchesBundle(bundle, itemKey, channelPath));
  }
  if (!catalogue && !staticClientBinding && !staticAssetsBinding) {
    // Fail closed, and say *which input* was missing: the front end can fix a
    // binding, it cannot fix silence.
    throw new HttpError(409, "missing_binding");
  }
  if (catalogue && String(catalogue.source_sha256).toLowerCase() !== sourceSha256) throw new HttpError(409, "resource_source_mismatch");

  // 4. The edit itself. The shape is the *file's*, and it is taken from what was
  //    read rather than trusted from the body: a JSON manifest is edited as a
  //    slot, a JSONL file as a line.
  const isManifest = /^\s*\{/.test(pinned.lines[0] || "") && path.toLowerCase().endsWith(".json");
  const edited = isManifest
    ? await editPinnedManifest(pinned.lines.join("\n"), {
      identity: { logicalKey, itemKey, bundle },
      sourceSha256,
      translation,
      updatedAt: now(),
    })
    : await editPinnedRow(pinned.lines, {
      identity: { logicalKey, itemKey, bundle },
      sourceSha256,
      translation,
      updatedAt: now(),
    });
  if (edited.previous === translation) throw new HttpError(409, "translation_unchanged");

  // 5. The proposal. `base_commit` pins the branch, and no `lookupExisting` read
  //    is needed because the file is known to exist at that commit.
  const proposal = await submitGithubProposal(env, {
    person,
    target,
    path,
    kind: "text",
    content: edited.text,
    message: message || `portal(text): ${path} [${edited.row_index + 1}]`,
    logicalKey: logicalKey || `${bundle}:${itemKey}`,
    sourceSha256,
    extra: {
      asset_version: target === "assets" ? version : null,
      client_version: target === "client" ? version : null,
      base_commit: baseCommit,
      blob_sha: pinned.blob_sha,
      writer_token: writerToken,
    },
  });

  await audit(env, auditActor(person), "github_text_row_proposed", "github_pr", String(proposal.pr_number), {
    target,
    path,
    base_commit: baseCommit,
    row_index: edited.row_index,
    row_field: edited.row_field || edited.row_key,
    bundle,
    item_key: itemKey,
    version,
    via: person.via,
  });

  return {
    ...proposal,
    target,
    path,
    base_commit: baseCommit,
    row_index: edited.row_index,
    row_field: edited.row_field || edited.row_key,
    previous_translation: edited.previous,
    lines_total: edited.lines_total,
    // Stated in the response so a reader does not have to take it on faith.
    single_line_edit: true,
    authority: "github_pull_request",
  };
}

// ============================================================================
// Image submission (aspect-ratio gate + proposal)
// ============================================================================

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

function decodeBase64(value) {
  const clean = String(value).replace(/^data:image\/[a-z+]+;base64,/i, "").replace(/\s+/g, "");
  if (!clean || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) throw new HttpError(400, "image_base64_invalid");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/// The image task's own recorded geometry, which is what an upload is checked
/// against. `width`/`height` are nullable on `image_task_units`: a task imported
/// without dimensions has nothing to compare, and `checkAspectRatio` fails
/// closed on it rather than letting the upload through unverified.
async function readImageTaskGeometry(env, taskId) {
  try {
    return await env.DB.prepare(
      `SELECT task_id, bundle, category, width, height, image_format, r2_key, source_sha256 FROM image_task_units WHERE task_id=?`
    ).bind(taskId).first();
  } catch (err) {
    if (isQuotaError(err)) return quotaResponse(err);
    throw err;
  }
}

/// The width/height a restore upload is now *measured* at, not the pair the
/// client claimed in the body. The claim is still accepted so an existing client
/// keeps working, but it is only ever compared against the parsed header: a
/// disagreement is a refusal, never a silent preference for one or the other.
function decodeUploadedImage(bytes) {
  try {
    return parseImageSize(bytes);
  } catch (err) {
    if (err instanceof ImageSizeError) throw new HttpError(400, `image_${err.code}`);
    throw err;
  }
}

/// A candidate file name for a localized texture, derived from the task id.
/// The CI backfill expects the restored/edited model paths it already knows, so
/// the proposal writes the same name the R2 layout uses.
function imageProposalPath(task, taskId) {
  const bundle = String(task?.bundle || "").trim();
  if (!bundle) throw new HttpError(503, "image_task_bundle_missing");
  // `task_id` is opaque and already bounded by `textField`; it is placed raw so
  // the committed path is the same string the R2 layout and the backfill use.
  return `${GITHUB_IMAGE_PATH_PREFIX}restored/${String(taskId)}/restored-texture.png`;
}

/// A localized texture proposal.
///
/// The pixel gate is this route's reason to exist, but it is not its only
/// obligation: the proposal it opens has to be *the one the caller asked for*.
/// So the body carries the same binding a text edit does — `target`, `path`,
/// `base_commit`, `source_sha256` — and every one of them is checked:
///
///   * `target` picks the repository. A `client` request is not silently filed
///     against the assets repository; when the client channel has no verified
///     image source, the answer is a refusal naming it (`unsupported`), because a
///     wrong-repository write is worse than no write;
///   * `path` must be the path the task's own layout produces. The route derives
///     it from the task and compares, so a caller cannot move an image somewhere
///     the backfill will never look;
///   * `base_commit` pins the branch, and the blob sha of the file it names (if it
///     exists at that commit) is what the commit presents;
///   * `source_sha256` must be **the task's own original hash**. It is never
///     filled in from the upload: the uploaded bytes are the *translation*, and a
///     translation standing in for its source is the opposite of provenance.
async function submitImageProposal(request, env, person) {
  if (!env.DB) throw new HttpError(503, "database_unavailable");
  const body = await request.json().catch(() => { throw new HttpError(400, "invalid_json"); });
  const taskId = textField(body.task_id, "task_id", 256);
  // 1. The binding, in the same shapes the text route accepts. Checked *first*,
  //    before the pixels are even decoded: which repository this lands in is not
  //    something a malformed upload should be able to change the answer to.
  const binding = readResourceBinding(body);
  const version = pinnedVersion(env, binding.target, body);
  if (binding.target !== "assets") {
    // The assets channel is the only one with a verified image source today: an
    // image task's geometry and hash live in `image_task_units`, which is the
    // assets pipeline's ledger. A client image would need its own trusted source
    // and its own pin, and inventing one here is how an assets-shaped write ends
    // up in the client repository.
    throw new HttpError(422, "client_image_unsupported");
  }

  // 2. The release, and the pin that belongs to it.
  //
  // `pinnedVersion` proved only that `asset_version` is shaped like a version.
  // The release is resolved here so its *own* commit can be compared with the one
  // the caller sent: a well-formed sha from a different release is a mismatch,
  // and reading the file at it would mean editing another release's tree.
  let release;
  try {
    release = await getAssetsRelease(env, version);
  } catch (err) {
    if (isQuotaError(err)) return quotaResponse(err);
    throw err;
  }
  if (!release) throw new HttpError(400, "unregistered_asset_version");
  const releasePin = releasePinnedCommit("assets", release);
  if (!releasePin) throw new HttpError(409, "release_pin_missing");
  if (releasePin !== binding.base_commit) throw new HttpError(409, "release_pin_mismatch");

  // 3. The pixels.
  const bytes = decodeBase64(body.image_base64);
  if (bytes.length > MAX_UPLOAD_BYTES) throw new HttpError(413, "image_too_large");
  const measured = decodeUploadedImage(bytes);

  const task = await readImageTaskGeometry(env, taskId);
  if (!task) throw new HttpError(404, "task_not_found");

  // 4. The task has to belong to the release that was named, and *by its source*.
  //
  //    The relation this service already holds is the release's own variant list.
  //    Two facts have to hold, not one: the release carries a variant for the
  //    task's bundle, **and** that variant's `source_sha256` is the task's. The
  //    first alone says only that the release knows this bundle — a bundle whose
  //    original changed under the release would pass, and the proposal would be
  //    filed against the wrong revision. `resource_kind='image'` keeps a text
  //    variant that happens to share the bundle name from standing in.
  //
  //    When either fact is absent there is no evidence binding the task to this
  //    release, and the answer is a refusal rather than a guess.
  const imageSha256 = String(task.source_sha256 || "").trim().toLowerCase();
  // A task with no recorded original is refused before the release comparison:
  // there is nothing to compare, and the fix is the task's ledger row, not the
  // release.
  if (!HEX64_ANY.test(imageSha256)) throw new HttpError(409, "image_source_sha256_missing");
  const imageVariantQuery =
    `SELECT sv.source_sha256 FROM source_variants sv ` +
    `JOIN resource_units ru ON ru.resource_id = sv.resource_id ` +
    `WHERE sv.release_kind='assets' AND sv.release_id=? AND sv.bundle=? AND ru.resource_kind='image'`;
  // 同一 bundle 可含多张图片；匹配精确来源，不能拿最后入库的另一张图代替。
  const variant = await env.DB.prepare(
    imageVariantQuery + ` AND LOWER(sv.source_sha256)=? LIMIT 1`
  ).bind(release.release_id, String(task.bundle), imageSha256).first();
  if (!variant) {
    const knownBundle = await env.DB.prepare(imageVariantQuery + ` LIMIT 1`)
      .bind(release.release_id, String(task.bundle)).first();
    throw new HttpError(409, knownBundle ? "image_source_not_in_release" : "image_task_not_in_release");
  }

  // 5. The task's own original hash. Never the upload's: that would record the
  //    translated artifact as the thing it was translated from.
  const sourceSha256 = imageSha256;
  if (!HEX64_ANY.test(sourceSha256)) throw new HttpError(409, "image_source_sha256_missing");
  if (sourceSha256 !== binding.source_sha256) throw new HttpError(409, "resource_source_mismatch");

  // 6. The path the task's layout produces, which the caller must have named.
  const derivedPath = imageProposalPath(task, taskId);
  if (binding.path !== derivedPath) throw new HttpError(409, "image_path_mismatch");

  await ensureContributor(env, person);

  // 7. The pixel gate. Two refusals, two codes: a wrong ratio and a downsample
  //    are different mistakes with different fixes.
  const verdict = checkAspectRatio({
    actual: { width: measured.width, height: measured.height },
    original: { width: Number(task.width), height: Number(task.height) },
  });
  if (!verdict.ok) throw new HttpError(400, verdict.reason);
  // The format is part of the gate too: this pipeline produces PNG textures, and
  // a JPEG upload would have to be re-encoded before Unity could read it.
  if (String(task.image_format || "").toLowerCase() === "png" && measured.format !== "png") {
    throw new HttpError(400, "image_format_mismatch");
  }

  const sha = await sha256Hex(bytes);
  // 8. The commit's blob sha, read at the pinned commit. Absent is normal — this
  //    is a new file — but a *different* existing blob is not: that would mean
  //    the task's path already holds something the caller did not see.
  const fetchImpl = githubFetchImpl(env);
  const writerToken = await resolveWriteToken(env, person);
  const existing = await imageBlobShaAt(env, {
    target: binding.target,
    path: binding.path,
    baseCommit: binding.base_commit,
    fetchImpl,
    token: writerToken,
  });
  const proposal = await submitGithubProposal(env, {
    person,
    target: binding.target,
    path: binding.path,
    kind: "image",
    // The proposal payload is the image itself, as bytes. Not a data URL, not a
    // base64 string: the committed blob has to *be* a PNG, so that a decoder
    // downstream sees `89 50 4E 47` and not the ASCII `data`.
    content: bytes,
    message: `portal(image): ${taskId}`,
    logicalKey: `image/${String(task.bundle).replace(/\.(png|jpg|jpeg|gtx|unity3d)$/i, "")}/${taskId}`,
    sourceSha256,
    extra: {
      asset_version: version,
      base_commit: binding.base_commit,
      // `"absent"` is a value, not a hole: the pin was read and holds no such
      // file, which is a different fact from "nobody looked".
      blob_sha: existing?.blob_sha || "absent",
      writer_token: writerToken,
    },
  });
  return {
    task_id: taskId,
    sha256: sha,
    size: `${measured.width}x${measured.height}`,
    format: measured.format,
    original_size: `${task.width}x${task.height}`,
    aspect_ratio: normalizeRatio(measured.width, measured.height),
    original_ratio: normalizeRatio(Number(task.width), Number(task.height)),
    // Stated in the response so a reader does not have to guess: the portal
    // checked the pixels; scaling and the Unity3D backfill happen in CI.
    scaling: "ci",
    target: binding.target,
    path: binding.path,
    base_commit: binding.base_commit,
    source_sha256: sourceSha256,
    asset_version: version,
    ...proposal,
  };
}

/// The blob sha of `path` at `baseCommit`, or `null` when the file does not exist
/// there (the normal case for a new localized texture).
async function imageBlobShaAt(env, { target, path, baseCommit, fetchImpl, token }) {
  const repo = githubTargetRepo(env, target);
  let result;
  try {
    result = await githubRequest(env, `/repos/${repo.full_name}/contents/${path}?ref=${encodeURIComponent(baseCommit)}`, { fetchImpl, token });
  } catch (err) {
    // A missing file is the *expected* answer for a new localized texture: the pin
    // holds no such file, so there is no sha to present. `githubRequest` maps the
    // 404 to that status, and anything else is a real failure.
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
  const blobSha = String(result.body?.sha || "").trim();
  if (!/^[0-9a-f]{40}$/i.test(blobSha)) throw new HttpError(502, "github_content_blob_sha_missing");
  return { blob_sha: blobSha };
}

/// The maintainer's list: contributions joined to their proposal mirror.
///
/// Deliberately read-only with respect to review state. The list *shows* the PR's
/// `state`/`merged` so a maintainer does not have to open every PR to triage;
/// nothing here writes a verdict, because a verdict is a merge on GitHub.
async function verifiedMaintainerTargets(env, person, requestedTarget) {
  // Verify token ownership before asking GitHub for this user's repository
  // permissions. Local role/email/login allowlists do not grant repository access.
  const token = await resolveWriteToken(env, person);
  const requested = requestedTarget ? [requestedTarget] : GITHUB_TARGET_KINDS;
  const allowed = [];
  for (const target of requested) {
    if (!targetRepoFilter(env, target) || targetRepoFilter(env, target) === "\u0000unconfigured") continue;
    const repo = githubTargetRepo(env, target);
    let result;
    try {
      result = await githubRequest(env, `/repos/${repo.full_name}`, { token, fetchImpl: githubFetchImpl(env) });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) continue;
      throw error; // unknown/failed permission lookup must never grant access
    }
    const body = result.body;
    if (String(body?.full_name || "").toLowerCase() !== repo.full_name.toLowerCase()) continue;
    const permission = body?.permissions;
    if (permission?.admin === true || permission?.maintain === true) allowed.push(target);
  }
  if (!allowed.length) throw new HttpError(403, "github_repo_maintainer_required");
  return allowed;
}

async function listAdminContributions(request, env) {
  const person = await requireActor(request, env);
  if (!env.DB) throw new HttpError(503, "database_unavailable");
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "";
  if (status && !["pending", "needs_review", "accepted", "rejected"].includes(status)) throw new HttpError(400, "status_invalid");
  const target = String(url.searchParams.get("target") || "").trim().toLowerCase();
  if (target && !GITHUB_TARGET_KINDS.includes(target)) throw new HttpError(400, "target_invalid");
  const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get("limit"), 10) || 50, 1), MAX_PAGE_LIMIT);

  const allowedTargets = await verifiedMaintainerTargets(env, person, target);
  const collected = [];
  // Always query an explicit authorized target, including the "all" UI view.
  // A maintainer of Assets must never receive Client or unbound legacy rows.
  for (const allowedTarget of allowedTargets) {
    const found = url.searchParams.get("refresh") === "1"
      ? await refreshGithubPrRows(env, { status, target: allowedTarget, limit })
      : await queryAdminContributionRows(env, { status, target: allowedTarget, limit });
    collected.push(...(found.results || []));
  }
  collected.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  const result = { results: collected.slice(0, limit) };

  const rows = (result.results || []).map((row) => ({
    id: row.id,
    // No contribution row means the proposal *is* the whole record — a status
    // invented for it would be a second review state, which this dashboard
    // deliberately does not have.
    status: row.id == null ? "proposed" : row.status,
    base_version: row.base_version,
    asset_version: row.asset_version,
    bundle: row.bundle,
    item_key: row.item_key,
    source_sha256: row.source_sha256,
    // The text diff is rendered from these two, client-side.
    ja: row.source,
    zh: row.translation,
    contributor_email: row.contributor_email,
    created_at: row.created_at,
    updated_at: row.updated_at,
    // GitHub is the review authority; these are mirrors for triage only.
    github: row.pr_number == null ? null : {
      target_repo: row.target_repo,
      base_branch: row.base_branch,
      head_branch: row.head_branch,
      fork: row.fork_full_name,
      pr_number: row.pr_number,
      pr_url: row.pr_url,
      state: row.pr_state,
      merged: Number(row.merged || 0) === 1,
      mergeable_state: row.mergeable_state,
      head_sha: row.head_sha,
      ci_status: row.ci_status,
    },
  }));
  return json({
    status: status || null,
    target: target || null,
    limit,
    rows,
    review_authority: "github_pull_request",
    writable: false,
  }, 200, { "cache-control": "no-store" });
}

/// The repository a `target=assets|client` filter means, taken from the same
/// configuration the proposal route reads. The axis is never inferred from the
/// repository's *name* — a repo that happens to end in "Assets" is not evidence
/// of anything. An unconfigured target yields a value no repository can equal,
/// so the filter returns an empty set rather than everything.
function targetRepoFilter(env, target) {
  if (!target) return "";
  const spec = target === "assets" ? env.GITHUB_TARGET_ASSETS : env.GITHUB_TARGET_CLIENT;
  const value = String(spec || "").trim().toLowerCase();
  return value || "\u0000unconfigured";
}

/// One query shape for the maintainer listing, shared by the plain read and the
/// refresh path so the two can never drift into returning different columns.
///
/// Two branches, because a proposal does not have to come from a `contributions`
/// row: an image submission is a PR and nothing else, and a listing that could
/// only show contributions would make those invisible to the reviewer who has to
/// merge them. Both branches produce the same column list, so the mapper below
/// does not care which one a row came from.
function queryAdminContributionRows(env, { status, target, limit }) {
  const repoFilter = targetRepoFilter(env, target);
  const sql =
    `SELECT * FROM (` +
    `SELECT c.id AS id, c.status AS status, c.base_version AS base_version, c.asset_version AS asset_version, ` +
    `c.bundle AS bundle, c.item_key AS item_key, c.source_sha256 AS source_sha256, c.source AS source, ` +
    `c.translation AS translation, c.contributor_email AS contributor_email, ` +
    `c.created_at AS created_at, c.updated_at AS updated_at, ` +
    `p.target_repo AS target_repo, p.base_branch AS base_branch, p.head_branch AS head_branch, ` +
    `p.fork_full_name AS fork_full_name, p.pr_number AS pr_number, p.pr_url AS pr_url, ` +
    `p.state AS pr_state, p.mergeable_state AS mergeable_state, p.head_sha AS head_sha, ` +
    `p.ci_status AS ci_status, p.merged AS merged ` +
    `FROM contributions c LEFT JOIN github_prs p ON p.contribution_id = c.id ` +
    `WHERE (? = '' OR c.status = ?) AND (? = '' OR LOWER(p.target_repo) = ?) ` +
    `UNION ALL ` +
    `SELECT NULL AS id, NULL AS status, NULL AS base_version, NULL AS asset_version, ` +
    `NULL AS bundle, NULL AS item_key, NULL AS source_sha256, NULL AS source, ` +
    `NULL AS translation, p.created_by AS contributor_email, ` +
    `p.created_at AS created_at, p.updated_at AS updated_at, ` +
    `p.target_repo AS target_repo, p.base_branch AS base_branch, p.head_branch AS head_branch, ` +
    `p.fork_full_name AS fork_full_name, p.pr_number AS pr_number, p.pr_url AS pr_url, ` +
    `p.state AS pr_state, p.mergeable_state AS mergeable_state, p.head_sha AS head_sha, ` +
    `p.ci_status AS ci_status, p.merged AS merged ` +
    `FROM github_prs p ` +
    `WHERE NOT EXISTS (SELECT 1 FROM contributions c WHERE c.id = p.contribution_id) ` +
    `AND (? = '' OR LOWER(p.target_repo) = ?) AND ? = '' ` +
    `) ORDER BY updated_at DESC LIMIT ?`;
  return env.DB.prepare(sql)
    .bind(status, status, target, repoFilter, target, repoFilter, status, limit)
    .all();
}

/// Optional refresh of the mirror from GitHub. Bounded, read-only and never
/// fatal to the listing: a GitHub failure leaves the mirrored row in place with
/// its previous state rather than blanking the dashboard.
async function refreshGithubPrRows(env, { status, target, limit }) {
  const token = String(env.GITHUB_PR_TOKEN || "").trim();
  let rows;
  try {
    const found = await queryAdminContributionRows(env, { status, target, limit });
    rows = found.results || [];
  } catch (err) {
    if (isQuotaError(err)) return quotaResponse(err);
    throw err;
  }
  if (!token) return { results: rows };

  const fetchImpl = githubFetchImpl(env);
  for (const row of rows) {
    if (row.pr_number == null || !row.target_repo) continue;
    let spec;
    try {
      spec = parseRepoSpec(row.target_repo);
    } catch (_) {
      continue;
    }
    try {
      const pr = await getPullRequest({ token, owner: spec.owner, repo: spec.repo, number: row.pr_number, fetchImpl });
      // GitHub, not this table, decides. The mirror is a courtesy for triage.
      await env.DB.prepare(
        `UPDATE github_prs SET state=?, merged=?, mergeable_state=?, head_sha=?, updated_at=? WHERE target_repo=? AND head_branch=?`
      ).bind(pr.state, pr.merged ? 1 : 0, pr.mergeable_state, pr.head_sha, now(), row.target_repo, row.head_branch).run();
      row.pr_state = pr.state;
      row.merged = pr.merged ? 1 : 0;
      row.mergeable_state = pr.mergeable_state;
      row.head_sha = pr.head_sha;
    } catch (err) {
      // Not fatal: the listing still serves the last-known mirror.
      if (err instanceof GitHubCollabError) continue;
      throw err;
    }
  }
  return { results: rows };
}

/// The retired D1 review/publish surface. Answered with 410 and a body that
/// says what replaced it, *before* any authentication runs: an unauthenticated
/// 410 and an authenticated 410 are the same answer, and a caller that was
/// relying on one of these needs the code, not a login prompt.
function retiredResponse(request, url) {
  const method = request.method;
  if (url.pathname === "/api/contributions" && method === "POST") {
    return json({
      error: "gone",
      retired: "/api/contributions",
      replaced_by: "/api/contributions/github-pr",
      review_authority: "github_pull_request",
      detail: "The portal no longer accepts translations into D1. A proposal is a GitHub pull request; nothing here reviews, accepts or publishes.",
    }, 410, { "cache-control": "no-store" });
  }
  if ((url.pathname === "/api/reviews" && method === "POST") || (/^\/api\/reviews\/[^/]+$/.test(url.pathname) && method === "POST")) {
    return json({
      error: "gone",
      retired: "/api/reviews/:id",
      replaced_by: "https://github.com/<owner>/<repo>/pull/<n>",
      review_authority: "github_pull_request",
      detail: "A verdict is a merge on GitHub. This endpoint wrote a second, independent review state; keeping it would have left two authorities for one fact.",
    }, 410, { "cache-control": "no-store" });
  }
  if (url.pathname === "/api/publish" && method === "POST") {
    return json({
      error: "gone",
      retired: "/api/publish",
      replaced_by: "the release pipeline (ledger, fallback, version and rollback gates)",
      detail: "Publication consumed the D1 review queue. With review moved to GitHub there is nothing left for it to publish.",
    }, 410, { "cache-control": "no-store" });
  }
  if (url.pathname === "/api/images/status" && method === "POST") {
    return json({
      error: "gone",
      retired: "/api/images/status",
      replaced_by: "/api/images/submit",
      detail: "Image status is derived from the image task ledger and the proposals merged on GitHub; it is not a value a caller writes.",
    }, 410, { "cache-control": "no-store" });
  }
  if (url.pathname === "/api/images/restore" && (method === "POST" || method === "PATCH")) {
    return json({
      error: "gone",
      retired: `/api/images/restore ${method}`,
      replaced_by: "/api/images/submit",
      detail: "The restore queue carried the image's review state. The merge on GitHub is the one authority now.",
    }, 410, { "cache-control": "no-store" });
  }
  return null;
}

async function route(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type,x-csrf-token" } });
  if (url.pathname === "/api/health" && request.method === "GET") return { ok: true, service: PACKAGE_VERSION };
  // Retired writes answer 410 before anything else: see `retiredResponse`.
  const retired = retiredResponse(request, url);
  if (retired) return retired;
  if (url.pathname === "/api/me" && request.method === "GET") {
    const person = await currentActor(request, env);
    if (!person) throw new HttpError(401, "authentication_required");
    return { authenticated: true, actor: publicActor(person), review_authority: "github_pull_request" };
  }
  if (url.pathname === "/api/logout" || url.pathname === "/api/auth/github/logout") {
    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
    const person = await requireWriteActor(request, env);
    requireWriteGuard(request, env, person);
    return logout(request, env);
  }
  if (url.pathname === "/api/terms" && request.method === "GET") return getTerms();
  if (url.pathname === "/api/stats" && request.method === "GET") return getStats(request, env);
  if (url.pathname === "/api/catalogue/search" && request.method === "GET") return searchCatalogue(request, env);
  if (url.pathname === "/api/lyrics/songs" && request.method === "GET") return getSongs(request, env);
  if (url.pathname === "/api/lyrics/song" && request.method === "GET") return getSongLyrics(request, env);

  // Client Releases API
  if (url.pathname === "/api/client/releases" && request.method === "GET") return getClientReleases(request, env);
  const clientReleaseMatch = url.pathname.match(/^\/api\/client\/releases\/([^/]+)$/);
  if (clientReleaseMatch && request.method === "GET") return getClientReleaseDetail(request, env, clientReleaseMatch[1]);
  const clientSummaryMatch = url.pathname.match(/^\/api\/client\/releases\/([^/]+)\/summary$/);
  if (clientSummaryMatch && request.method === "GET") return getClientReleaseSummary(request, env, clientSummaryMatch[1]);
  const clientManifestMatch = url.pathname.match(/^\/api\/client\/releases\/([^/]+)\/manifest$/);
  if (clientManifestMatch && request.method === "GET") return getClientReleaseManifest(request, env, clientManifestMatch[1]);
  const clientItemsMatch = url.pathname.match(/^\/api\/client\/releases\/([^/]+)\/items$/);
  if (clientItemsMatch && request.method === "GET") return getClientReleaseItems(request, env, clientItemsMatch[1]);
  const clientStaticEditMatch = url.pathname.match(/^\/api\/client\/releases\/([^/]+)\/item\/edit-context$/);
  if (clientStaticEditMatch && request.method === "GET") return json(await getClientStaticItemContext(request, env, clientStaticEditMatch[1]), 200, { "cache-control": "no-store" });
  const clientItemMatch = url.pathname.match(/^\/api\/client\/releases\/([^/]+)\/item$/);
  if (clientItemMatch && request.method === "GET") return getReleaseItemDetail(request, env, "client", clientItemMatch[1]);

  // Assets Releases API
  if (url.pathname === "/api/assets/releases" && request.method === "GET") return getAssetsReleases(request, env);
  const assetsReleaseMatch = url.pathname.match(/^\/api\/assets\/releases\/([^/]+)$/);
  if (assetsReleaseMatch && request.method === "GET") return getAssetsReleaseDetail(request, env, assetsReleaseMatch[1]);
  const assetsSummaryMatch = url.pathname.match(/^\/api\/assets\/releases\/([^/]+)\/summary$/);
  if (assetsSummaryMatch && request.method === "GET") return getAssetsReleaseSummary(request, env, assetsSummaryMatch[1]);
  const assetsManifestMatch = url.pathname.match(/^\/api\/assets\/releases\/([^/]+)\/manifest$/);
  if (assetsManifestMatch && request.method === "GET") return getAssetsReleaseManifest(request, env, assetsManifestMatch[1]);
  const assetsItemsMatch = url.pathname.match(/^\/api\/assets\/releases\/([^/]+)\/items$/);
  if (assetsItemsMatch && request.method === "GET") return getAssetsReleaseItems(request, env, assetsItemsMatch[1]);
  const assetsStaticEditMatch = url.pathname.match(/^\/api\/assets\/releases\/([^/]+)\/item\/edit-context$/);
  if (assetsStaticEditMatch && request.method === "GET") return json(await getStaticAssetsItemContext(request, env, assetsStaticEditMatch[1]), 200, { "cache-control": "no-store" });
  // Single-item detail. The source text is only ever served here, one row at a
  // time, which is what keeps the list endpoints' payload bounded.
  const assetsItemMatch = url.pathname.match(/^\/api\/assets\/releases\/([^/]+)\/item$/);
  if (assetsItemMatch && request.method === "GET") return getReleaseItemDetail(request, env, "assets", assetsItemMatch[1]);

  // Universal Resource Endpoints
  const resDetailMatch = url.pathname.match(/^\/api\/resources\/([^/]+)$/);
  if (resDetailMatch && request.method === "GET") return getResourceDetail(request, env, resDetailMatch[1]);
  const resHistoryMatch = url.pathname.match(/^\/api\/resources\/([^/]+)\/history$/);
  if (resHistoryMatch && request.method === "GET") return getResourceHistory(request, env, resHistoryMatch[1]);
  const resReuseMatch = url.pathname.match(/^\/api\/resources\/([^/]+)\/reuse$/);
  if (resReuseMatch && request.method === "GET") return getResourceReuse(request, env, resReuseMatch[1]);
  // The single-row editor's starting state: repository, path, pinned commit and
  // the row's own source. Public, because it exposes nothing a contributor
  // cannot already read in the repository — it is what makes the editor possible
  // without the client inventing a `base_commit`.
  const resEditMatch = url.pathname.match(/^\/api\/resources\/([^/]+)\/edit-context$/);
  if (resEditMatch && request.method === "GET") return getResourceEditContext(request, env, resEditMatch[1]);

  // GitHub Webhook
  if (url.pathname === "/api/webhooks/github" && request.method === "POST") return handleGitHubWebhook(request, env);
  if (url.pathname === "/api/sync/status" && request.method === "GET") return getSyncStatus(request, env);
  if (url.pathname === "/api/sync/tick" && request.method === "POST") return runSyncTickNow(request, env);

  // Image tasks. The reads stay: a task list, a task's geometry and the R2
  // redirect are how the dashboard shows what still needs work. The status and
  // restore *writes* are retired above — both were second review states.
  if (url.pathname === "/api/images/tasks" && request.method === "GET") return getImageTasks(request, env);
  if (url.pathname === "/api/images/task" && request.method === "GET") return getImageTaskDetail(request, env);
  if (url.pathname === "/api/images/asset" && request.method === "GET") return getImageAsset(request, env);
  if (url.pathname === "/api/images/status" && request.method === "GET") return getImageStatusOverrides(request, env);

  // Contributions (read-only) and the maintainer dashboard.
  if (url.pathname === "/api/queue" && request.method === "GET") return listAdminContributions(request, env);
  if (url.pathname === "/api/admin/contributions" && request.method === "GET") return listAdminContributions(request, env);

  // GitHub login. Neither route requires an identity to *start*: requiring one
  // was the bug — a plain GitHub contributor has no Access identity at all.
  if (url.pathname === "/api/auth/github/login" && request.method === "GET") return githubLogin(request, env);
  if (url.pathname === "/api/auth/github/callback" && request.method === "GET") return githubCallback(request, env);
  if (url.pathname === "/api/auth/github/me" && request.method === "GET") return githubMe(request, env);

  // The single-row edit. Same proposal machinery as `/api/contributions/github-pr`,
  // addressed by resource id so a caller does not have to assemble the binding
  // itself — the service already knows the repository, the path and the pinned
  // commit for the row.
  const resourceEditMatch = url.pathname.match(/^\/api\/resources\/([^/]+)\/edit$/);
  if (resourceEditMatch && request.method === "POST") {
    const person = await requireWriteActor(request, env, { roles: GITHUB_WRITE_ROLES });
    requireWriteGuard(request, env, person);
    return submitResourceEdit(request, env, person, resourceEditMatch[1]);
  }

  // Authenticated writes: session, then Origin + CSRF. All three, in this order.
  if (url.pathname === "/api/contributions/github-pr" && request.method === "POST") {
    const person = await requireWriteActor(request, env, { roles: GITHUB_WRITE_ROLES });
    requireWriteGuard(request, env, person);
    return submitGithubContribution(request, env, person);
  }
  // The pixel path, which gates on aspect ratio and opens a PR.
  if (url.pathname === "/api/images/submit" && request.method === "POST") {
    const person = await requireWriteActor(request, env, { roles: GITHUB_WRITE_ROLES });
    requireWriteGuard(request, env, person);
    return submitImageProposal(request, env, person);
  }

  if (url.pathname.startsWith("/api/")) throw new HttpError(404, "not_found");
  return null;
}

export default {
  async fetch(request, env) {
    try {
      const result = await route(request, env);
      if (result instanceof Response) return cors(request, result);
      if (result === null) {
        if (env.ASSETS) return env.ASSETS.fetch(request);
        return new Response("Not Found", { status: 404 });
      }
      return cors(request, json(result));
    }
    catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (error instanceof RegistryError) {
        const registryStatus = registryErrorStatus(error) || 500;
        if (registryStatus === 503) return cors(request, quotaResponse(error));
        return cors(request, json({ error: error.code, detail: error.detail || null }, registryStatus));
      }
      // OAuth 回调的 query 含临时凭据；异常日志只记录路由路径。
      if (!(error instanceof HttpError)) console.error("request failed", request.method, new URL(request.url).pathname, error?.stack || String(error));
      return cors(request, json({ error: error instanceof HttpError ? error.code : "internal_error" }, status));
    }
  },

  /**
   * The webhook only enqueues; this is the consumer that makes the pipeline
   * "real-time". It is a Cron Trigger (see wrangler.jsonc `triggers.crons`), so
   * a push that lands on GitHub is ingested within a minute without anyone
   * running a script by hand.
   *
   * The handler is bounded in three ways: jobs claimed per tick, files per job,
   * and D1 rows written per invocation. A job that hits a limit is requeued with
   * a progress cursor rather than left half-written.
   */
  async scheduled(controller, env, ctx) {
    const tick = async () => {
      try {
        const result = await runSyncTick(env, { claimLimit: CLAIM_BATCH_SIZE });
        if (result.claimed > 0) {
          console.log("sync tick", JSON.stringify({ cron: controller?.cron, claimed: result.claimed, results: result.results.map((r) => ({ status: r.status, rows_written: r.rows_written || 0 })) }));
        }
      } catch (err) {
        // A cron tick must never throw: the next tick is the retry mechanism.
        console.error("sync tick failed", String(err?.message || err));
      }
    };
    if (ctx?.waitUntil) ctx.waitUntil(tick());
    else await tick();
  },
};
