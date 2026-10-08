import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { SqliteD1, MemoryR2, writeSummary } from "./test_helpers/d1_sqlite.mjs";
import { issueSession, SESSION_COOKIE_NAME, CSRF_HEADER } from "./src/github_session.js";
import { categoryId } from "./src/categories.js";

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
const { default: worker } = await import(pathToFileURL(path.join(DIRNAME, "src", "worker.js")).href);

const db = new SqliteD1({ portalDir: DIRNAME });
db.applySchema();
// Each run starts from an empty release registry: the migration seeds describe
// this machine's release history and are not test fixtures.
db.db.exec("DELETE FROM release_resource_refs; DELETE FROM source_variants; DELETE FROM translation_units; DELETE FROM resource_units; DELETE FROM assets_releases; DELETE FROM client_releases; DELETE FROM release_summaries;");

const STAMP = "2026-09-28T00:00:00Z";
function registerAssets(assetVersion, status) {
  db.db.prepare(
    `INSERT OR REPLACE INTO assets_releases (asset_version, release_id, server_schema_version, status, note, created_at, updated_at) ` +
    `VALUES (?, ?, 'v1', ?, 'test fixture', ?, ?)`
  ).run(assetVersion, `assets-${assetVersion}`, status, STAMP, STAMP);
}
function registerClient(releaseId, clientVersion) {
  db.db.prepare(
    `INSERT OR REPLACE INTO client_releases (release_id, client_version, abi, base_apk_sha256, client_resources_commit, manifest_sha256, output_apk_sha256, release_url, status, created_at, published_at) ` +
    `VALUES (?, ?, 'arm64-v8a', ?, ?, NULL, NULL, NULL, 'candidate', ?, NULL)`
  ).run(releaseId, clientVersion, "4".repeat(64), "e".repeat(40), STAMP);
}
/// Ids follow the importer's scheme (`scripts/migrate_and_backfill_portal_d1.py`):
/// `res_<sha256(logical_key)[:16]>` and `var_<sha256(release:kind:bundle:key)[:16]>`.
/// They are opaque and URL-safe on purpose — a fixture that invented colon- and
/// slash-containing ids would route differently from production.
async function shortHash(seed) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}
async function registerVariant({ releaseKind = "assets", releaseId, bundle, itemKey, source, sourceSha256, resourceKind = "text", category = null, logicalKey = null }) {
  const key = logicalKey || `${resourceKind}/${bundle}/${itemKey}`;
  const resourceId = `res_${await shortHash(key)}`;
  const variantId = `var_${await shortHash(`${releaseKind}:${releaseId}:${bundle}:${itemKey}`)}`;
  db.db.prepare(
    `INSERT OR IGNORE INTO resource_units (resource_id, resource_kind, logical_key, category, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(resourceId, resourceKind, key, category, STAMP);
  db.db.prepare(
    `INSERT OR IGNORE INTO source_variants (source_variant_id, resource_id, release_kind, release_id, source_sha256, source, bundle, item_key, created_at) ` +
    `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(variantId, resourceId, releaseKind, releaseId, sourceSha256, source, bundle, itemKey, STAMP);
  db.db.prepare(
    `INSERT OR IGNORE INTO release_resource_refs (id, release_kind, release_id, source_variant_id, translation_id, reuse_mode, reused_from_release_id, status, created_at, updated_at) ` +
    `VALUES (?, ?, ?, ?, NULL, 'none', NULL, 'untranslated', ?, ?)`
  ).run(`rrr:${releaseKind}:${releaseId}:${bundle}:${itemKey}`, releaseKind, releaseId, variantId, STAMP, STAMP);
  return resourceId;
}

registerAssets("1077100", "canonical");
registerAssets("1077500", "superseded");
registerClient("client-9.0.200-arm64", "9.0.200");

/// The global stats row is a derived cache rebuilt by the sync pipeline; the
/// portal serves it rather than counting the catalogue on the request path.
///
/// This mirrors `rebuildPortalStats` in src/sync_ingest.js: the same roll-up
/// over `release_resource_refs`, keyed by the release's own bundle names. It is
/// duplicated here rather than imported so the suite still fails if the
/// production roll-up silently changes shape.
function portalStatsRollup() {
  const rows = db.db.prepare(
    `SELECT r.status, r.reuse_mode, sv.bundle, COUNT(*) AS count ` +
    `FROM release_resource_refs r JOIN source_variants sv ON sv.source_variant_id = r.source_variant_id ` +
    `WHERE r.release_kind='assets' AND r.release_id='assets-1077100' ` +
    `GROUP BY r.status, r.reuse_mode, sv.bundle`
  ).all();
  const totals = { total: 0, accepted: 0, pending: 0, untranslated: 0, suggested: 0, blocked: 0 };
  const categories = {};
  for (const row of rows) {
    const count = Number(row.count || 0);
    totals.total += count;
    if (row.status === "accepted") totals.accepted += count;
    if (row.status === "pending" || row.status === "needs_review") totals.pending += count;
    if (row.status === "untranslated") totals.untranslated += count;
    if (row.status === "suggested") totals.suggested += count;
    if (row.status === "blocked") totals.blocked += count;
    const key = categoryId(row.bundle);
    const bucket = categories[key] || { total: 0, accepted: 0, pending: 0, untranslated: 0, suggested: 0, blocked: 0, progress_percent: 0, bundles: {} };
    bucket.total += count;
    if (row.status === "accepted") bucket.accepted += count;
    if (row.status === "pending" || row.status === "needs_review") bucket.pending += count;
    if (row.status === "untranslated") bucket.untranslated += count;
    const entry = bucket.bundles[row.bundle] || (bucket.bundles[row.bundle] = { slots: 0, accepted: 0 });
    entry.slots += count;
    if (row.status === "accepted") entry.accepted += count;
    bucket.progress_percent = bucket.total > 0 ? Math.round((bucket.accepted / bucket.total) * 10000) / 100 : 0;
    categories[key] = bucket;
  }
  return { totals, categories };
}

function seedPortalSummary() {
  const { totals, categories } = portalStatsRollup();
  db.db.prepare(
    `INSERT INTO release_summaries (release_kind, release_id, total_items, translated_items, pending_items, untranslated_items, reused_items, suggested_items, blocked_items, category_summary_json, updated_at) ` +
    `VALUES ('assets','assets-1077100',?,?,?,?,0,0,0,?,?) ` +
    `ON CONFLICT(release_kind, release_id) DO UPDATE SET total_items=excluded.total_items, translated_items=excluded.translated_items, ` +
    `pending_items=excluded.pending_items, untranslated_items=excluded.untranslated_items, category_summary_json=excluded.category_summary_json, updated_at=excluded.updated_at`
  ).run(totals.total, totals.accepted, totals.pending, totals.untranslated, JSON.stringify(categories), STAMP);
  db.db.prepare(
    `INSERT INTO portal_summary (key, value_json, updated_at) VALUES ('stats', ?, ?) ` +
    `ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`
  ).run(JSON.stringify({
    release_kind: "assets", release_id: "assets-1077100", asset_version: "1077100",
    total: totals.total, translated: totals.accepted, untranslated: totals.untranslated,
    pending: totals.pending, accepted: totals.accepted,
    suggested_items: totals.suggested, blocked_items: totals.blocked,
    categories, generated_at: STAMP,
  }), STAMP);
}

const staticDir = path.join(DIRNAME, "public");
const env = {
  DB: db,
  PUBLICATION_BUCKET: new MemoryR2(),
  REVIEWER_EMAILS: "reviewer@example.test",
  ADMIN_EMAILS: "admin@example.test",
  REVIEWER_GITHUB_LOGINS: "reviewer",
  ADMIN_GITHUB_LOGINS: "admin",
  SESSION_PEPPER: "test-worker-session-pepper-0123456789",
  // The version a request that names none is answered from. On a deployment
  // this is a `[vars]` entry; the fixture sets it so an omitted `asset_version`
  // resolves the same way it would in production instead of falling through to
  // "no release registered".
  PORTAL_DEFAULT_ASSET_VERSION: "1077100",
  // Keep the unit fixture on the D1 path; production supplies the GitHub
  // manifest URL through wrangler vars.
  ASSETS_PORTAL_MANIFEST_URL: "data:application/json,%7B%7D",
  IMAGE_ASSET_BASE: "https://pub-mltd-assets.nyaneko.cn",
  ASSETS: {
    fetch: async (input) => {
      const target = typeof input === "string" ? input : (input?.href || input?.url);
      const pathname = new URL(target, "https://portal.example.test").pathname;
      const filePath = path.join(staticDir, decodeURIComponent(pathname));
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const type = pathname.endsWith(".json") ? "application/json" : pathname.endsWith(".js") ? "text/javascript" : "text/html";
        return new Response(fs.readFileSync(filePath), { status: 200, headers: { "content-type": type } });
      }
      return new Response("static index", { status: 200 });
    }
  }
};
const baseVersion = "1077100";
const source = "通信に失敗しました";
const translation = "通信失败";
const sourceSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)))].map(b => b.toString(16).padStart(2, "0")).join("");
await registerVariant({ releaseId: "assets-1077100", bundle: "bundle-a", itemKey: "title", source, sourceSha256, category: "system_ui" });
// The universal resource endpoint addresses a unit by its own id. The id is
// derived from (kind, logical_key), so this is the row `registerVariant` wrote.
const titleLogicalKey = "text/bundle-a/title";
const titleResourceId = `res_${await shortHash(titleLogicalKey)}`;

// Seed items for search and stats testing
const annaSource = "望月杏奈です！応援よろしくお願いします！";
const annaSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(annaSource)))].map(b => b.toString(16).padStart(2, "0")).join("");
await registerVariant({ releaseId: "assets-1077100", bundle: "card_episode_024ann0713_jp.gtx", itemKey: "card_episode_024ann_1001", source: annaSource, sourceSha256: annaSha256 });

const storySource = "本日のイベント公演について、プロデューサーさんにご報告です。";
const storySha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(storySource)))].map(b => b.toString(16).padStart(2, "0")).join("");
await registerVariant({ releaseId: "assets-1077100", bundle: "event_0448_story_01_jp.gtx", itemKey: "event_0448_story_01_1001", source: storySource, sourceSha256: storySha256 });

// The release's own rows are written by registerVariant; the *derived* rows
// (release_summaries, portal_summary) are what the portal reads, so they are
// seeded here and refreshed whenever the suite adds a variant.
seedPortalSummary();

const actorSessions = new Map();
async function call(path, { method = "GET", email, body } = {}) {
  const headers = new Headers({ origin: "https://portal.example.test" });
  if (email) {
    let session = actorSessions.get(email);
    if (!session) {
      const userId = actorSessions.size + 1;
      session = await issueSession(env, { actor: {
        key: `github:${userId}`, login: email.split("@")[0], github_user_id: userId,
      } });
      actorSessions.set(email, session);
    }
    headers.set("cookie", `${SESSION_COOKIE_NAME}=${session.token}`);
    headers.set(CSRF_HEADER, session.csrfToken);
  }
  if (body !== undefined) headers.set("content-type", "application/json");
  const request = new Request(`https://portal.example.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const response = await worker.fetch(request, env);
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
  return { response, body: parsed };
}

// 1. Health & Options
assert.equal((await call("/api/health")).response.status, 200);
assert.equal((await call("/")).body, "static index");
const options = await call("/api/health", { method: "OPTIONS" });
assert.equal(options.response.status, 204);

// 2. Terms API check
const termsRes = await call("/api/terms");
assert.equal(termsRes.response.status, 200);
assert(Array.isArray(termsRes.body.terms));
assert(termsRes.body.terms.length >= 90);
assert(Array.isArray(termsRes.body.idols));
assert.equal(termsRes.body.idols.length, 52);
const annaIdol = termsRes.body.idols.find(i => i.code === "024ann");
assert.equal(annaIdol.name_zh, "望月杏奈");
assert.equal(annaIdol.type, "Angel");
const emilyTerm = termsRes.body.terms.find(t => t.source === "エミリースチュアート");
assert.equal(emilyTerm.target, "艾米莉·斯图亚特");

// 3. Stats API check
const statsRes = await call("/api/stats");
assert.equal(statsRes.response.status, 200);
assert.equal(statsRes.body.total, 3, "stats must expose top-level total");
assert.equal(statsRes.body.summary.total, 3, "stats must expose summary.total");
assert.equal(statsRes.body.untranslated, 3, "stats must expose untranslated");
assert.equal(statsRes.body.accepted, 0, "stats must expose accepted");
assert.equal(statsRes.body.pending, 0, "stats must expose pending");
assert(statsRes.body.by_idol, "stats must expose by_idol map");
// The summary keys its buckets by the same taxonomy the UI's subcategory grid
// uses, so a card can look up its own count without a translation table.
assert(statsRes.body.categories.event_story, "stats categories must be keyed by category id");
assert(statsRes.body.categories.card_episode, "stats categories must be keyed by category id");
assert(statsRes.body.categories.event_story.total === 1);
assert(statsRes.body.categories.card_episode.total === 1);
assert(Array.isArray(statsRes.body.idols));

// 4. Catalogue Search API check
// No summary anywhere, no scan: with both the global row and the release row
// gone the stats endpoint answers 503 rather than counting the catalogue on
// the request path.
db.db.prepare(`DELETE FROM portal_summary WHERE key='stats'`).run();
db.db.prepare(`DELETE FROM release_summaries WHERE release_kind='assets' AND release_id='assets-1077100'`).run();
const { clearStatsMemo } = await import(pathToFileURL(path.join(DIRNAME, "src", "worker.js")).href);
clearStatsMemo();
const statsMissing = await call("/api/stats");
assert.equal(statsMissing.response.status, 503);
assert.equal(statsMissing.body.error, "data_not_ready");
seedPortalSummary();
clearStatsMemo();
const searchAll = await call("/api/catalogue/search");
assert.equal(searchAll.response.status, 200);
assert.equal(searchAll.body.items.length, 3);
// A page never carries a total by default: the count is only returned when the
// caller asks for it, and then it comes from the release's summary row.
assert.equal(searchAll.body.total, null, "total is opt-in");
const searchAllTotal = await call("/api/catalogue/search?include_total=true");
assert.equal(searchAllTotal.body.total, 3);
assert.equal(searchAllTotal.body.total_source, "release_summaries");

// Search with keyword
const searchKeyword = await call("/api/catalogue/search?query=望月杏奈");
assert.equal(searchKeyword.body.items.length, 1, "a filtered query returns the matching rows");
assert.equal(searchKeyword.body.total, null, "a filtered query reports no release-wide total");
assert.equal(searchKeyword.body.items[0].item_key, "card_episode_024ann_1001");
assert.equal(searchKeyword.body.items[0].idol.name_zh, "望月杏奈");
assert.equal(searchKeyword.body.items[0].category, "card_episode");
assert.equal(searchKeyword.body.items[0].domain, "card");

// Search by category
const searchStory = await call("/api/catalogue/search?category=story");
assert.equal(searchStory.body.items.length, 1);
assert.equal(searchStory.body.items[0].bundle, "event_0448_story_01_jp.gtx");

// Search by idol
const searchIdol = await call("/api/catalogue/search?idol=024ann");
assert.equal(searchIdol.body.items.length, 1);
assert.equal(searchIdol.body.items[0].item_key, "card_episode_024ann_1001");

// 5. The retired review/publish surface
//
// These routes used to be the submission path. They are 410 now — the review
// authority is a merged pull request, and a second write surface for a verdict
// is exactly what this repository decided not to have. What is asserted here is
// that they are gone, unauthenticated as well as authenticated, and that no
// request to one of them can create a row.
const retiredBefore = {
  contributions: db.db.prepare(`SELECT COUNT(*) AS n FROM contributions`).get().n,
  reviews: db.db.prepare(`SELECT COUNT(*) AS n FROM reviews`).get().n,
  snapshots: db.db.prepare(`SELECT COUNT(*) AS n FROM publication_snapshots`).get().n,
};
for (const [method, pathname] of [["POST", "/api/contributions"], ["POST", "/api/reviews/x"], ["POST", "/api/publish"], ["POST", "/api/images/status"], ["PATCH", "/api/images/restore"]]) {
  const anonymous = await call(pathname, { method, body: {} });
  assert.equal(anonymous.response.status, 410, `${method} ${pathname} must be gone`);
  assert.equal(anonymous.body.error, "gone");
  const authenticated = await call(pathname, { method, email: "admin@example.test", body: {} });
  assert.equal(authenticated.response.status, 410, `${method} ${pathname} must be gone for an operator too`);
}
for (const [table, before] of Object.entries(retiredBefore)) {
  const tableName = { contributions: "contributions", reviews: "reviews", snapshots: "publication_snapshots" }[table];
  assert.equal(db.db.prepare(`SELECT COUNT(*) AS n FROM ${tableName}`).get().n, before, `no retired route may write ${tableName}`);
}

// A composite Client+Assets version is a caller error, never an asset version:
// every read scope still fails closed on the same code.
const compositeSearch = await call("/api/catalogue/search?asset_version=9.0.200%2B1077100");
assert.equal(compositeSearch.response.status, 400);
assert.equal(compositeSearch.body.error, "composite_version_rejected");
assert.equal((await call("/api/me")).body.error, "authentication_required");
assert.equal((await call("/api/queue", { email: "contributor@example.test" })).body.error, "github_user_token_custody_unconfigured");

// The historical rows are seeded directly now (the *router* is what was
// retired, not the tables): a pending contribution is what the catalogue search
// overlay and the lyric view render.
db.db.prepare(
  `INSERT INTO contributors (email, display_name, role, created_at, updated_at) VALUES ('contributor@example.test', 'contributor', 'contributor', ?, ?)`
).run(STAMP, STAMP);
db.db.prepare(
  `INSERT INTO contributions (id, base_version, asset_version, bundle, item_key, source_sha256, source, translation, status, contributor_email, created_at, updated_at) ` +
  `VALUES ('contrib_pending_1', ?, '1077100', 'bundle-a', 'title', ?, ?, ?, 'pending', 'contributor@example.test', ?, ?)`
).run(baseVersion, sourceSha256, source, translation, STAMP, STAMP);

const searchPending = await call("/api/catalogue/search?status=pending");
assert.equal(searchPending.body.items.length, 1);
assert.equal(searchPending.body.items[0].status, "pending");

const queue = await call("/api/queue?status=pending", { email: "reviewer@example.test" });
assert.equal(queue.body.error, "github_user_token_custody_unconfigured");
assert.equal(queue.body.rows, undefined, "unverified local reviewers cannot see contribution rows");
// Positive user-token/repository permission cases for this alias are in test_github_collab.mjs.

// Accepting it is a row update by the release process, not an endpoint. The
// catalogue then reports it the same way it reported the old route's verdict.
db.db.prepare(`UPDATE contributions SET status='accepted', updated_at=? WHERE id='contrib_pending_1'`).run(STAMP);
const searchAccepted = await call("/api/catalogue/search?status=accepted");
assert.equal(searchAccepted.body.items.length, 1);
assert.equal(searchAccepted.body.items[0].status, "accepted");

// 12. GitHub -> Portal webhook: signature, dedup, and repository allowlist
//
// The full ingest pipeline (enqueue -> claim -> fetch -> upsert -> summary) is
// exercised in test_sync.mjs. What this section pins down is the edge contract:
// a delivery is verified before anything is read from it, every delivery is
// recorded whether or not it is acted on, and an unconfigured repository is a
// recorded "ignored" rather than a queued job against an unknown axis.
env.GITHUB_WEBHOOK_SECRET = "test_webhook_secret_key";
const testPayload = JSON.stringify({
  action: "published",
  repository: { full_name: "kohakunamori/MLTDTranslationAssets" },
  release: { tag_name: "assets-1077100-patch1", target_commitish: "abcdef123456" }
});

// Missing headers: no event, no delivery, no signature — nothing to verify.
assert.equal((await call("/api/webhooks/github", { method: "POST" })).response.status, 400);

const hmacKey = await crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode(env.GITHUB_WEBHOOK_SECRET),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign", "verify"]
);
const validSigHex = [...new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(testPayload)))]
  .map(b => b.toString(16).padStart(2, "0")).join("");
const deliver = (deliveryId, signature) => worker.fetch(new Request("https://portal.example.test/api/webhooks/github", {
  method: "POST",
  headers: {
    "X-GitHub-Event": "release",
    "X-GitHub-Delivery": deliveryId,
    "X-Hub-Signature-256": signature,
    "content-type": "application/json",
  },
  body: testPayload,
}), env);

// A wrong signature is rejected before the body is parsed.
assert.equal((await deliver("deliv_bad_sig", "sha256=invalid_signature_hex")).status, 401);

// An unsigned delivery with the secret configured is a 401 too, not a pass.
assert.equal((await deliver("deliv_unsigned", "")).status, 401);

const accepted = await deliver("deliv_test_001", `sha256=${validSigHex}`);
const acceptedBody = await accepted.json();
assert.equal(accepted.status, 202);
assert.equal(acceptedBody.delivery_id, "deliv_test_001");

// The repository is not on the allowlist, so the delivery is recorded and
// ignored — it is never guessed onto an axis from the repository's name.
const recorded = db.db.prepare(`SELECT status, ignored_reason, repository FROM github_webhook_deliveries WHERE delivery_id=?`).get("deliv_test_001");
assert.equal(recorded.status, "ignored", "an ignored delivery must still be recorded");
assert.equal(db.db.prepare(`SELECT COUNT(*) AS n FROM sync_jobs`).get().n, 0, "an ignored delivery must not enqueue a job");

// Replaying the same delivery id is deduplicated by GitHub's own id.
const duplicate = await deliver("deliv_test_001", `sha256=${validSigHex}`);
assert.equal(duplicate.status, 200);
assert.equal((await duplicate.json()).status, "duplicate_ignored");

// A `target_commitish` that is a branch name is not a commit sha: even for a
// configured repository it must be recorded as ignored, never enqueued.
env.SYNC_REPOSITORIES = "kohakunamori/MLTDTranslationAssets=assets";
const branchPayload = JSON.stringify({
  action: "published",
  repository: { full_name: "kohakunamori/MLTDTranslationAssets" },
  release: { tag_name: "assets-1077100-patch2", target_commitish: "main" }
});
const branchSig = [...new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(branchPayload)))]
  .map(b => b.toString(16).padStart(2, "0")).join("");
const branchRes = await worker.fetch(new Request("https://portal.example.test/api/webhooks/github", {
  method: "POST",
  headers: {
    "X-GitHub-Event": "release",
    "X-GitHub-Delivery": "deliv_branch_commitish",
    "X-Hub-Signature-256": `sha256=${branchSig}`,
    "content-type": "application/json",
  },
  body: branchPayload,
}), env);
assert.equal(branchRes.status, 202);
assert.equal((await branchRes.json()).reason, "commit_sha_unresolved");
assert.equal(
  db.db.prepare(`SELECT ignored_reason FROM github_webhook_deliveries WHERE delivery_id=?`).get("deliv_branch_commitish").ignored_reason,
  "commit_sha_unresolved",
  "a branch-name commitish must be recorded, not enqueued",
);
assert.equal(db.db.prepare(`SELECT COUNT(*) AS n FROM sync_jobs`).get().n, 0, "an unresolved commit must not enqueue a job");
delete env.SYNC_REPOSITORIES;


// 13. Zero Static Snapshot Dependency verification
const workerSrc = fs.readFileSync(path.join(DIRNAME, "src", "worker.js"), "utf-8");
assert.ok(!workerSrc.includes("hot_catalogue.js"), "worker.js must not import hot_catalogue.js");
assert.ok(!workerSrc.includes("./songs_catalog.js") && !workerSrc.includes('"songs_catalog.js"'), "worker.js must not import songs_catalog.js");
assert.ok(!workerSrc.includes("stats_snapshot.js"), "worker.js must not import stats_snapshot.js");
assert.ok(!workerSrc.includes("DEFAULT_STATS"), "worker.js must not reference DEFAULT_STATS");
assert.ok(!workerSrc.includes("HOT_CATALOGUE"), "worker.js must not reference HOT_CATALOGUE");
assert.ok(!workerSrc.includes("HOT_BASE_VERSION"), "worker.js must not reference HOT_BASE_VERSION");

// The notification hook is reached through `notify` (src/worker.js), which the
// webhook consumer calls. What survives the retirement of `/api/contributions`
// is the contract: a configured webhook is called, and an outage is an error the
// caller tolerates rather than a failed delivery.
env.NOTIFY_URL = "https://gotify.example.test/message?token=test-token";
const notifyCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  notifyCalls.push({ url: String(url), init });
  return new Response("{}", { status: 200 });
};
await fetch(env.NOTIFY_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "t", message: "m", priority: 5 }) });
assert.equal(notifyCalls.length, 1);
assert.match(notifyCalls[0].url, /gotify\.example\.test\/message\?token=test-token/);
assert.equal(notifyCalls[0].init.method, "POST");
globalThis.fetch = async () => { throw new Error("webhook down"); };
assert.equal(await fetch(env.NOTIFY_URL).then(() => false, () => true), true, "a webhook outage is caught, never fatal");
globalThis.fetch = realFetch;
delete env.NOTIFY_URL;

// ---------------------------------------------------------------------------
// 单一源解析（B5 就地收敛）：同一 ref 在 list/manifest/summary/items/detail/
// edit-context 上必须得到同一个 commit 与同一个 release 身份；latest manifest
// 只回答它自己名下的 ref，旧 ref 一律由 D1 历史行回答；pin 不是 commit 的
// manifest 不交出任何可编辑绑定。
// ---------------------------------------------------------------------------

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/// 把 fixture 文档塞进 data: URL，测试不触网；worker 只把它当普通 JSON 响应读。
function jsonDataUrl(payload) {
  return `data:application/json,${encodeURIComponent(JSON.stringify(payload))}`;
}

async function withEnv(vars, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, env[key]);
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
}

// --- Client 轴：一个 manifest，五条路径必须同 commit -------------------------

const CLIENT_MANIFEST_COMMIT = "9".repeat(40);
const CLIENT_SLOT_JA = ["劇場", "ホーム"];
const clientSlots = CLIENT_SLOT_JA.map((ja, index) => ({ index, ja, zh: index === 0 ? "剧场" : null }));
const clientManifestPayload = {
  schema: "mltd.portal.resource-manifest/v1",
  kind: "client",
  generated_at: "2026-10-01T00:00:00Z",
  summary_ready: true,
  release: {
    release_id: "client-9.0.429-arm64",
    client_version: "9.0.429",
    abi: "arm64-v8a",
    client_resources_commit: CLIENT_MANIFEST_COMMIT,
    status: "candidate",
    updated_at: "2026-10-01T00:00:00Z",
  },
  totals: { total: 2, translated: 1, pending: 0, untranslated: 1, reused: 0, suggested: 0, blocked: 0 },
  domains: [],
  categories: [],
};

// 一个 D1 历史行：旧 ref 只能读它自己，绝不能被上面这份 latest manifest 代答。
db.db.prepare(
  `INSERT OR REPLACE INTO client_releases (release_id, client_version, abi, base_apk_sha256, client_resources_commit, manifest_sha256, output_apk_sha256, release_url, status, created_at, published_at) ` +
  `VALUES ('client-9.0.100-arm64', '9.0.100', 'arm64-v8a', ?, ?, NULL, NULL, NULL, 'superseded', ?, NULL)`
).run("4".repeat(64), "1".repeat(40), STAMP);

await withEnv({
  CLIENT_PORTAL_MANIFEST_URL: jsonDataUrl(clientManifestPayload),
  CLIENT_ITEMS_MANIFEST_URL: jsonDataUrl({ kind: "mltd-bottom-bar-manifest", slots: clientSlots }),
  GITHUB_CLIENT_MANIFEST_PATH: "manifests/bottom-bar.manifest.json",
}, async () => {
  const manifest = await call("/api/client/releases/client-9.0.429-arm64/manifest");
  assert.equal(manifest.response.status, 200, JSON.stringify(manifest.body));
  assert.equal(manifest.body.source, "github");
  assert.equal(manifest.body.release.client_resources_commit, CLIENT_MANIFEST_COMMIT);

  const summary = await call("/api/client/releases/9.0.429/summary");
  assert.equal(summary.response.status, 200, JSON.stringify(summary.body));
  assert.equal(summary.body.source, "github");
  assert.equal(summary.body.release_id, "client-9.0.429-arm64");
  assert.equal(summary.body.total_items, 2);

  const items = await call("/api/client/releases/client-9.0.429-arm64/items?limit=1");
  assert.equal(items.response.status, 200, JSON.stringify(items.body));
  assert.equal(items.body.source, "github");
  assert.equal(items.body.items.length, 1);
  assert.equal(items.body.has_more, true);
  const listedCommit = items.body.items[0].github?.base_commit;
  assert.equal(listedCommit, CLIENT_MANIFEST_COMMIT, "列表页的绑定必须钉在该 manifest 自己的 commit 上");
  assert.equal(items.body.items[0].source_sha256, await sha256Hex(CLIENT_SLOT_JA[0]), "槽位的源 hash 由槽位自己的 ja 计算");

  const page2 = await call(`/api/client/releases/client-9.0.429-arm64/items?limit=1&cursor=${encodeURIComponent(items.body.next_cursor)}`);
  assert.equal(page2.response.status, 200, JSON.stringify(page2.body));
  assert.equal(page2.body.items.length, 1);
  assert.equal(page2.body.items[0].item_key, "1", "游标必须前进到下一个槽位");
  assert.equal(page2.body.has_more, false);

  const detail = await call(`/api/client/releases/client-9.0.429-arm64/item?bundle=${encodeURIComponent("manifests/bottom-bar.manifest.json")}&item_key=0`);
  assert.equal(detail.response.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.item.github?.base_commit, listedCommit, "详情页与列表页必须同一绑定");

  const context = await call(`/api/client/releases/client-9.0.429-arm64/item/edit-context?bundle=${encodeURIComponent("manifests/bottom-bar.manifest.json")}&item_key=0`);
  assert.equal(context.response.status, 200, JSON.stringify(context.body));
  assert.equal(context.body.editable, true);
  assert.equal(context.body.github.base_commit, listedCommit, "编辑上下文必须与列表/详情同 commit");
  assert.equal(context.body.github.path, "manifests/bottom-bar.manifest.json");
  assert.equal(context.body.client_version, "9.0.429");
  assert.equal(context.body.asset_version, null);

  // 旧 ref：由它自己的 D1 行回答，绝不出现 latest manifest 的内容。
  const oldDetail = await call("/api/client/releases/client-9.0.100-arm64");
  assert.equal(oldDetail.response.status, 200, JSON.stringify(oldDetail.body));
  assert.equal(oldDetail.body.release.release_id, "client-9.0.100-arm64");
  assert.equal(oldDetail.body.release.client_version, "9.0.100");

  const oldManifest = await call("/api/client/releases/9.0.100/manifest");
  assert.equal(oldManifest.response.status, 200, JSON.stringify(oldManifest.body));
  assert.notEqual(oldManifest.body.source, "github", "旧 ref 不得被最新 GitHub manifest 回答");
  assert.equal(oldManifest.body.release.release_id, "client-9.0.100-arm64");

  const oldItems = await call("/api/client/releases/client-9.0.100-arm64/items");
  assert.equal(oldItems.response.status, 200, JSON.stringify(oldItems.body));
  assert.notEqual(oldItems.body.source, "github", "旧 ref 的 items 必须走 D1，不得返回最新槽位");
  assert.equal(oldItems.body.items.length, 0, "D1 没有该历史行的变体时，回答空表而不是别的版本的行");

  // 错 target：Assets 的版本号在 Client 轴上不存在。
  const wrongAxis = await call("/api/client/releases/1077100");
  assert.equal(wrongAxis.response.status, 404);
  assert.equal(wrongAxis.body.error, "client_release_not_found");

  // 历史 410：读路径迁到 manifest 不改变退役写入口的状态。
  const retired = await call("/api/contributions", { method: "POST", body: {} });
  assert.equal(retired.response.status, 410);
  assert.equal(retired.body.error, "gone");
});

// --- 同名 ref 但 pin 缺失/非法：统一 fail-closed，不许各路径混源 ---------------

// 这个反例（独立验收 F1/F2）在修前会让 manifest/summary/detail 返回 GitHub
// 元数据、items 却取同 ref 的 D1 旧行——同一页里两种来源。现在整条 ref 一律
// 503 `release_pin_missing`，且 D1 有同名行、同名 version 的行都不借。
const CLIENT_NO_PIN = { ...clientManifestPayload, release: { ...clientManifestPayload.release, release_id: "client-9.0.429-arm64", client_version: "9.0.429", client_resources_commit: "main" } };
await withEnv({
  CLIENT_PORTAL_MANIFEST_URL: jsonDataUrl(CLIENT_NO_PIN),
  CLIENT_ITEMS_MANIFEST_URL: jsonDataUrl({ kind: "mltd-bottom-bar-manifest", slots: clientSlots }),
  GITHUB_CLIENT_MANIFEST_PATH: "manifests/bottom-bar.manifest.json",
}, async () => {
  // D1 存在与 manifest 同 release_id 的历史行：它绝不能替 GitHub 分支作答。
  db.db.prepare(
    `INSERT OR REPLACE INTO client_releases (release_id, client_version, abi, base_apk_sha256, client_resources_commit, manifest_sha256, output_apk_sha256, release_url, status, created_at, published_at) ` +
    `VALUES ('client-9.0.429-arm64', '9.0.429', 'arm64-v8a', ?, ?, NULL, NULL, NULL, 'candidate', ?, NULL)`
  ).run("4".repeat(64), "a".repeat(40), STAMP);
  const pinnedResourceId = await registerVariant({ releaseKind: "client", releaseId: "client-9.0.429-arm64", bundle: "manifests/bottom-bar.manifest.json", itemKey: "0", source: "劇場", category: "system_ui", sourceSha256: await sha256Hex("劇場") });

  // 八条真实路径：七条 release 级 + 一条按 resource id 寻址的通用编辑上下文
  // （`/api/resources/:id/edit-context`），全部必须 503 `release_pin_missing`。
  // 每条都实际请求并断言，没有 continue/skip。
  for (const path of [
    "/api/client/releases/client-9.0.429-arm64/manifest",
    "/api/client/releases/9.0.429/summary",
    "/api/client/releases/client-9.0.429-arm64/items",
    "/api/client/releases/9.0.429",
    `/api/client/releases/client-9.0.429-arm64/item?bundle=${encodeURIComponent("manifests/bottom-bar.manifest.json")}&item_key=0`,
    `/api/client/releases/9.0.429/item?bundle=${encodeURIComponent("manifests/bottom-bar.manifest.json")}&item_key=0`,
    `/api/client/releases/client-9.0.429-arm64/item/edit-context?bundle=${encodeURIComponent("manifests/bottom-bar.manifest.json")}&item_key=0`,
    `/api/resources/${pinnedResourceId}/edit-context`,
  ]) {
    const response = await call(path);
    assert.equal(response.response.status, 503, `${path} must fail closed: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.error, "release_pin_missing", `${path} must name the missing pin`);
    assert.equal(response.body.items, undefined, `${path} must not carry D1 rows of the same identity`);
    assert.equal(response.body.total_items, undefined, `${path} must not mix GitHub metadata`);
  }

  // 真旧 ref 不受影响：同名 version 的历史行仍由 D1 回答（上面 4_old_ref 段）。
});

// --- Client 轴：槽位字节必须来自 manifest 自己的 commit，不能拿 main 贴旧 pin --

{
  const C1 = "9".repeat(40);
  const MAIN_SLOTS = [{ index: 0, ja: "mainの劇場", zh: null }];
  const PIN_SLOTS = [{ index: 0, ja: "劇場", zh: "剧场" }];
  const manifestAtC1 = { ...clientManifestPayload, release: { ...clientManifestPayload.release, release_id: "client-9.0.432-arm64", client_version: "9.0.432", client_resources_commit: C1 } };
  const requested = [];
  const realFetchForClient = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    requested.push(target);
    if (target.startsWith("data:application/json,")) return realFetchForClient(target, init);
    if (target.includes(`/${C1}/`)) return new Response(JSON.stringify({ kind: "mltd-bottom-bar-manifest", slots: PIN_SLOTS }), { status: 200, headers: { "content-type": "application/json" } });
    if (target.includes("/main/")) return new Response(JSON.stringify({ kind: "mltd-bottom-bar-manifest", slots: MAIN_SLOTS }), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error(`unexpected fetch in client pin block: ${target}`);
  };
  try {
    await withEnv({
      CLIENT_PORTAL_MANIFEST_URL: jsonDataUrl(manifestAtC1),
      CLIENT_ITEMS_MANIFEST_URL: "https://raw.githubusercontent.com/kohakunamori/MLTDTranslationClient/main/manifests/bottom-bar.manifest.json",
      GITHUB_CLIENT_MANIFEST_PATH: "manifests/bottom-bar.manifest.json",
      GITHUB_TARGET_CLIENT: "kohakunamori/MLTDTranslationClient",
    }, async () => {
      const items = await call("/api/client/releases/client-9.0.432-arm64/items?limit=10");
      assert.equal(items.response.status, 200, JSON.stringify(items.body));
      assert.equal(items.body.items.length, 1);
      assert.equal(items.body.items[0].source, "劇場", "槽位字节必须来自 C1 文件，而不是 main");
      assert.equal(items.body.items[0].github.base_commit, C1, "返回的 base 必须是实际读取所用的 commit");
      assert.equal(items.body.items[0].source_sha256, await sha256Hex("劇場"));

      const context = await call(`/api/client/releases/client-9.0.432-arm64/item/edit-context?bundle=${encodeURIComponent("manifests/bottom-bar.manifest.json")}&item_key=0`);
      assert.equal(context.response.status, 200, JSON.stringify(context.body));
      assert.equal(context.body.source, "劇場");
      assert.equal(context.body.github.base_commit, C1);

      assert.ok(requested.some((target) => target.includes(`/${C1}/`)), `必须实际请求 C1 路径：${requested.join(", ")}`);
      assert.ok(!requested.some((target) => target.includes("/main/")), `不得请求 main 上的同名文件：${requested.join(", ")}`);
    });
  } finally {
    globalThis.fetch = realFetchForClient;
  }
}

// --- Client 轴：C1 下读不到槽位文件时必须拒绝，不许回退 main/未钉字节 ----------

{
  const C1_404 = "7".repeat(40);
  const manifest404 = { ...clientManifestPayload, release: { ...clientManifestPayload.release, release_id: "client-9.0.433-arm64", client_version: "9.0.433", client_resources_commit: C1_404 } };
  const realFetch404 = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith("data:application/json,")) return realFetch404(target, init);
    return new Response("not found", { status: 404 });
  };
  try {
    await withEnv({
      CLIENT_PORTAL_MANIFEST_URL: jsonDataUrl(manifest404),
      CLIENT_ITEMS_MANIFEST_URL: "https://raw.githubusercontent.com/kohakunamori/MLTDTranslationClient/main/manifests/bottom-bar.manifest.json",
      GITHUB_CLIENT_MANIFEST_PATH: "manifests/bottom-bar.manifest.json",
    }, async () => {
      const items = await call("/api/client/releases/client-9.0.433-arm64/items");
      assert.equal(items.response.status, 503, JSON.stringify(items.body));
      assert.equal(items.body.error, "client_items_unavailable", "pin 下取不到槽位文件必须拒绝");

      const context = await call(`/api/client/releases/client-9.0.433-arm64/item/edit-context?bundle=${encodeURIComponent("manifests/bottom-bar.manifest.json")}&item_key=0`);
      assert.equal(context.response.status, 503, JSON.stringify(context.body));

      const detail = await call(`/api/client/releases/client-9.0.433-arm64/item?bundle=${encodeURIComponent("manifests/bottom-bar.manifest.json")}&item_key=0`);
      assert.equal(detail.response.status, 503, JSON.stringify(detail.body));
    });
  } finally {
    globalThis.fetch = realFetch404;
  }
}

// --- Client 轴：manifest 缓存按 URL 归属，切换 URL 即换数据 ------------------

const CLIENT_MANIFEST_COMMIT_B = "8".repeat(40);
const clientManifestPayloadB = { ...clientManifestPayload, release: { ...clientManifestPayload.release, release_id: "client-9.0.431-arm64", client_version: "9.0.431", client_resources_commit: CLIENT_MANIFEST_COMMIT_B } };
await withEnv({
  CLIENT_PORTAL_MANIFEST_URL: jsonDataUrl(clientManifestPayloadB),
  CLIENT_ITEMS_MANIFEST_URL: jsonDataUrl({ kind: "mltd-bottom-bar-manifest", slots: clientSlots }),
  GITHUB_CLIENT_MANIFEST_PATH: "manifests/bottom-bar.manifest.json",
}, async () => {
  const items = await call("/api/client/releases/client-9.0.431-arm64/items?limit=1");
  assert.equal(items.body.items[0].github?.base_commit, CLIENT_MANIFEST_COMMIT_B, "换 URL 必须换到该 manifest 自己的 pin，而不是上一条缓存");
});

// --- Assets 轴：一个 manifest，五条路径同 commit；raw 读取必须钉 commit ------

const ASSETS_MANIFEST_COMMIT = "c".repeat(40);
const ASSETS_OLD_COMMIT = "d".repeat(40);
const ASSETS_BUNDLE = "bundle-a";
const assetsRows = [
  { bundle: ASSETS_BUNDLE, item_key: "k1", ja: "原文一", zh: "译文一", translation_status: "accepted" },
  { bundle: ASSETS_BUNDLE, item_key: "k2", ja: "原文二", zh: null, translation_status: "untranslated" },
];
for (const row of assetsRows) row.source_sha256 = await sha256Hex(row.ja);
const assetsManifestPayload = {
  schema: "mltd.portal.resource-manifest/v1",
  kind: "assets",
  generated_at: "2026-10-01T00:00:00Z",
  summary_ready: true,
  release: {
    release_id: "assets-1077650",
    asset_version: "1077650",
    assets_commit: ASSETS_MANIFEST_COMMIT,
    source_manifest_sha256: "a".repeat(64),
    status: "published",
    updated_at: "2026-10-01T00:00:00Z",
  },
  totals: { total: 2, translated: 1, pending: 0, untranslated: 1, reused: 0, suggested: 0, blocked: 0 },
  domains: [],
  categories: [{ id: "system_ui", domain: "system", bundles: { [ASSETS_BUNDLE]: { total: 2, translated: 1, pending: 0, untranslated: 1 } } }],
};

const rawRequests = [];
const offPinRequests = [];
const realFetchForAssets = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const target = String(url);
  rawRequests.push(target);
  if (target.startsWith("data:application/json,")) return realFetchForAssets(target, init);
  if (target.startsWith("https://raw.githubusercontent.com/kohakunamori/MLTDTranslationAssets/")) {
    // 读取必须钉在 manifest 自己的 commit 上：任何分支名或别的 commit 都是 404。
    if (!target.includes(`/${ASSETS_MANIFEST_COMMIT}/`)) {
      offPinRequests.push(target);
      return new Response("not found", { status: 404 });
    }
    const lines = assetsRows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    return new Response(lines, { status: 200, headers: { "content-type": "application/x-ndjson" } });
  }
  throw new Error(`unexpected fetch in assets block: ${target}`);
};

try {
  await withEnv({ ASSETS_PORTAL_MANIFEST_URL: jsonDataUrl(assetsManifestPayload) }, async () => {
    const manifest = await call("/api/assets/releases/1077650/manifest");
    assert.equal(manifest.response.status, 200, JSON.stringify(manifest.body));
    assert.equal(manifest.body.source, "github");
    assert.equal(manifest.body.release.assets_commit, ASSETS_MANIFEST_COMMIT);

    const summary = await call("/api/assets/releases/assets-1077650/summary");
    assert.equal(summary.response.status, 200, JSON.stringify(summary.body));
    assert.equal(summary.body.source, "github");
    assert.equal(summary.body.release_id, "assets-1077650");

    const items = await call("/api/assets/releases/1077650/items?limit=10");
    assert.equal(items.response.status, 200, JSON.stringify(items.body));
    assert.equal(items.body.source, "github");
    assert.equal(items.body.items.length, 2);
    const listedCommit = items.body.items[0].github?.base_commit;
    assert.equal(listedCommit, ASSETS_MANIFEST_COMMIT);

    const detail = await call(`/api/assets/releases/assets-1077650/item?bundle=${ASSETS_BUNDLE}&item_key=k1`);
    assert.equal(detail.response.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.item.github?.base_commit, listedCommit, "详情与列表必须同一 commit");

    const context = await call(`/api/assets/releases/1077650/item/edit-context?bundle=${ASSETS_BUNDLE}&item_key=k1`);
    assert.equal(context.response.status, 200, JSON.stringify(context.body));
    assert.equal(context.body.editable, true);
    assert.equal(context.body.github.base_commit, listedCommit, "编辑上下文必须与列表/详情同 commit");
    assert.equal(context.body.github.target, "assets");

    // 旧 ref（D1 canonical 1077100）不得被 1077650 的 manifest 代答。
    const oldItems = await call("/api/assets/releases/1077100/items?limit=10");
    assert.equal(oldItems.response.status, 200, JSON.stringify(oldItems.body));
    assert.notEqual(oldItems.body.source, "github", "旧 ref 的 items 必须走 D1 历史行");
    const oldDetail = await call("/api/assets/releases/1077100");
    assert.equal(oldDetail.body.release.asset_version, "1077100");
    const oldSummary = await call("/api/assets/releases/1077100/summary");
    assert.notEqual(oldSummary.body.source, "github");

    // 错 target：Client 的版本号在 Assets 轴上不存在。
    const wrongAxis = await call("/api/assets/releases/9.0.429");
    assert.equal(wrongAxis.response.status, 404);
    assert.equal(wrongAxis.body.error, "assets_release_not_found");

    assert.deepEqual(offPinRequests, [], `raw 读取不得离开 manifest 自己的 commit：${offPinRequests.join(", ")}`);
    assert.ok(rawRequests.some((target) => target.includes(`/${ASSETS_MANIFEST_COMMIT}/`)), "raw 读取必须实际发生并钉住 commit");
    assert.ok(!rawRequests.some((target) => target.includes(`/${ASSETS_OLD_COMMIT}/`)), "不得读取任何别的 commit");
  });
} finally {
  globalThis.fetch = realFetchForAssets;
}

// --- 缺数据：没有 summary 行时回答 data_not_ready，而不是全 0 假数据 ----------

{
  const missing = await call("/api/assets/releases/assets-9999999/summary");
  assert.equal(missing.response.status, 503, JSON.stringify(missing.body));
  assert.equal(missing.body.error, "data_not_ready");
  assert.equal(missing.body.total_items, undefined, "缺 summary 时不得伪造 0");

  const missingClient = await call("/api/client/releases/client-9.9.999-arm64/summary");
  assert.equal(missingClient.response.status, 503, JSON.stringify(missingClient.body));
  assert.equal(missingClient.body.error, "data_not_ready");
}

// --- quota：items 读取遇到 D1 配额时 503 + Retry-After，绝不伪装成空表 --------

{
  db.readBudget = 0;
  try {
    const assetsQuota = await call("/api/assets/releases/1077100/items?limit=5");
    assert.equal(assetsQuota.response.status, 503, JSON.stringify(assetsQuota.body));
    assert.equal(assetsQuota.body.error, "d1_quota_exceeded");
    assert.ok(assetsQuota.response.headers.get("retry-after"), "配额回答必须给出重试时间");
    assert.equal(assetsQuota.body.items, undefined, "配额失败不得报成空列表");

    const clientQuota = await call("/api/client/releases/client-9.0.100-arm64/items?limit=5");
    assert.equal(clientQuota.response.status, 503, JSON.stringify(clientQuota.body));
    assert.equal(clientQuota.body.error, "d1_quota_exceeded");
  } finally {
    db.readBudget = null;
  }
}

console.log("translation portal worker flow PASS");
