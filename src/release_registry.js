// Release registry: the D1 `assets_releases` / `client_releases` tables are the
// only authority for "which asset version may be written to".
//
// There is deliberately NO hard-coded version set in this file. Historical
// versions (1077100, 1077500, …) exist in the database and in migrations, never
// as a Worker-side allowlist. Adding or retiring a release is a D1 row update.
//
// This module is import-safe for the test harness: every function is async and
// takes the env binding, so a MemoryD1 can drive it.

const ASSET_VERSION_PATTERN = /^[0-9]{1,10}$/;

/// Asset release statuses in `assets_releases.status`.
export const ASSETS_RELEASE_STATUSES = ["canonical", "staging", "unverified", "superseded"];

// A release in one of these states may accept new source variants and
// translation work. `unverified` and `superseded` are read-only history.
const WRITABLE_ASSETS_STATUSES = new Set(["canonical", "staging"]);

export class RegistryError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

/// Reject a composite identity such as `9.0.200+1077100` outright.
///
/// A composite Client+Assets string must never be silently stripped down to its
/// asset part: that tolerance turned a caller error into a wrong-release write.
/// The bare decimal asset version (or `assets-<version>` where a release ref is
/// accepted) is the only valid input; anything containing `+` fails closed with
/// `composite_version_rejected` and the caller must resubmit a bare version.
export function normalizeAssetVersionInput(inputVersion) {
  if (inputVersion === undefined || inputVersion === null) return "";
  const str = String(inputVersion).trim();
  if (!str) return "";
  if (str.includes("+")) {
    throw new RegistryError(
      "composite_version_rejected",
      `composite Client+Assets version is not an asset_version: ${str.slice(0, 80)}`
    );
  }
  return str;
}

/// The default asset version is deployment configuration (`PORTAL_DEFAULT_ASSET_VERSION`).
/// It is only used to fill in an omitted field; it is never treated as "the
/// registered release" — that answer always comes from D1.
export function defaultAssetVersion(env) {
  return normalizeAssetVersionInput(env?.PORTAL_DEFAULT_ASSET_VERSION);
}

export function resolveAssetVersion(env, inputVersion) {
  const normalized = normalizeAssetVersionInput(inputVersion);
  if (normalized) return normalized;
  return defaultAssetVersion(env);
}

function lower(value) {
  return String(value || "").trim().toLowerCase();
}

function d1QuotaExceeded(err) {
  const msg = lower(err?.message || err);
  return msg.includes("limit") || msg.includes("7500") || msg.includes("exceeded") || msg.includes("quota");
}

/// Re-throw D1 quota exhaustion as a distinguishable error so callers can answer
/// 503 instead of silently degrading to empty data.
export function rethrowQuota(err) {
  if (d1QuotaExceeded(err)) throw new RegistryError("d1_quota_exceeded", String(err?.message || err));
  return err;
}

/// One indexed point-read on `assets_releases`. Accepts either the stable
/// `release_id` (`assets-1077100`) or the bare `asset_version` (`1077100`).
export async function getAssetsRelease(env, releaseRef) {
  const ref = String(releaseRef || "").trim();
  if (!ref) return null;
  if (!env?.DB) throw new RegistryError("database_unavailable");
  try {
    return await env.DB.prepare(
      `SELECT asset_version, release_id, server_schema_version, status, source_manifest_sha256, assets_commit, published_at, updated_at ` +
      `FROM assets_releases WHERE release_id=? OR asset_version=? LIMIT 1`
    ).bind(ref, ref).first();
  } catch (err) {
    return rethrowQuota(err);
  }
}

export async function listAssetsReleases(env, limit = 50) {
  const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 100);
  if (!env?.DB) throw new RegistryError("database_unavailable");
  try {
    const rows = await env.DB.prepare(
      `SELECT asset_version, release_id, server_schema_version, status, source_manifest_sha256, assets_commit, published_at, updated_at ` +
      `FROM assets_releases ORDER BY updated_at DESC, asset_version DESC LIMIT ?`
    ).bind(bounded).all();
    return rows.results || [];
  } catch (err) {
    return rethrowQuota(err);
  }
}

/// The canonical release id for a bare asset version: prefer the registry row's
/// own `release_id`, fall back to the `assets-<version>` convention.
export async function resolveAssetsReleaseId(env, assetVersion) {
  const row = await getAssetsRelease(env, assetVersion);
  if (row?.release_id) return row.release_id;
  return `assets-${assetVersion}`;
}

/// Returns the release row, or throws `unregistered_assets_release` when the
/// version must not be written to. `superseded` and `unverified` releases fail
/// closed; so does a syntactically invalid version.
export async function assertAssetsReleaseWritable(env, assetVersion) {
  // A composite input throws `composite_version_rejected` here rather than being
  // stripped: the throw path is intentional and covered by tests.
  const version = normalizeAssetVersionInput(assetVersion);
  if (!ASSET_VERSION_PATTERN.test(version)) {
    throw new RegistryError("unregistered_asset_version", `asset_version must be decimal: ${version || "empty"}`);
  }
  const row = await getAssetsRelease(env, version);
  if (!row) throw new RegistryError("unregistered_asset_version", `${version} is not registered`);
  if (!WRITABLE_ASSETS_STATUSES.has(String(row.status))) {
    throw new RegistryError("unregistered_asset_version", `${version} is ${row.status}`);
  }
  return row;
}

export function assetsReleaseStatusAllowsWrite(status) {
  return WRITABLE_ASSETS_STATUSES.has(String(status || ""));
}

/**
 * Resolve an asset version that a contributor supplied explicitly, failing
 * closed when nothing is registered. `env` may carry `ALLOW_UNVERIFIED_ASSETS`
 * for staging work; even then the version has to exist in the registry, so the
 * flag widens *status*, never *existence*.
 */
export async function verifyAssetVersionForWrite(env, assetVersion) {
  let version;
  try {
    version = normalizeAssetVersionInput(assetVersion);
  } catch (err) {
    if (err instanceof RegistryError && err.code === "composite_version_rejected") throw err;
    throw err;
  }
  if (!version) throw new RegistryError("missing_asset_version");
  if (!ASSET_VERSION_PATTERN.test(version)) {
    throw new RegistryError("unregistered_asset_version", "asset_version must be decimal digits");
  }
  const allowUnverified = env?.ALLOW_UNVERIFIED_ASSETS === "true" || env?.ALLOW_UNVERIFIED_ASSETS === true;
  try {
    return await assertAssetsReleaseWritable(env, version);
  } catch (err) {
    if (!(err instanceof RegistryError) || err.code !== "unregistered_asset_version" || !allowUnverified) throw err;
    const row = await getAssetsRelease(env, version);
    if (!row) throw err;
    return row;
  }
}

/**
 * A stable release id for a Client version. Client releases are keyed by
 * `client_release_id`; `asset_version` is not part of the identity.
 */
export function clientReleaseId(clientVersion, abi = "arm64-v8a") {
  return `client-${String(clientVersion).trim()}-${String(abi).trim()}`;
}

export async function getClientRelease(env, releaseRef) {
  const ref = String(releaseRef || "").trim();
  if (!ref) return null;
  if (!env?.DB) throw new RegistryError("database_unavailable");
  try {
    return await env.DB.prepare(
      `SELECT release_id, client_version, abi, base_apk_sha256, client_resources_commit, manifest_sha256, output_apk_sha256, ` +
      `release_url, status, created_at, published_at ` +
      // Reached either by the release id (`client-9.0.200-arm64`) or by the bare
      // client version (`9.0.200`), the same way an assets release is reached by
      // its release id or its asset version: a caller that names the axis should
      // not have to know which of the two identifiers it holds.
      //
      // Two rows may share a client version (one per ABI). An exact release-id
      // match wins, then the most recent: a version-only lookup must not answer
      // with an arbitrary row when the caller named one precisely.
      `FROM client_releases WHERE release_id=? OR client_version=? ` +
      `ORDER BY CASE WHEN release_id=? THEN 0 ELSE 1 END, created_at DESC LIMIT 1`
    ).bind(ref, ref, ref).first();
  } catch (err) {
    return rethrowQuota(err);
  }
}

/// Map a registry error onto the worker's HttpError shape without importing it
/// (keeps this module usable from tests and scripts).
export function registryErrorStatus(err) {
  if (err instanceof RegistryError) {
    if (err.code === "d1_quota_exceeded") return 503;
    if (err.code === "database_unavailable") return 503;
    if (err.code === "unregistered_asset_version" || err.code === "missing_asset_version") return 400;
    return 400;
  }
  return null;
}
