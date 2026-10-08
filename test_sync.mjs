// Sync pipeline tests: webhook -> job queue -> consumer -> ingest -> summary.
//
// These run against a real SQLite database built from schema.sql + migrations/
// (see test_helpers/d1_sqlite.mjs), so the production SQL is exercised for real
// and the D1 read/write accounting is measured rather than assumed.

import assert from "node:assert/strict";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SqliteD1, MemoryR2, seedRelease, writeSummary } from "./test_helpers/d1_sqlite.mjs";

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
const workerModule = await import(pathToFileURL(path.join(DIRNAME, "src", "worker.js")).href);
const worker = workerModule.default;
const { runSyncTick, runJob, claimJobs, backoffForAttempt } = await import(pathToFileURL(path.join(DIRNAME, "src", "sync_runner.js")).href);
const { planIngest, classifyPath, collectManifestEntries, recordsFromFile, parseRepositoryConfig, resolveTargetKind, validateReleaseManifest, buildLogicalKey, evaluateReuseBatch, rebuildReleaseSummary, sourceVariantId } = await import(pathToFileURL(path.join(DIRNAME, "src", "sync_ingest.js")).href);

const ASSETS_REPO = "kohakunamori/MLTDTranslationAssets";
const CLIENT_REPO = "kohakunamori/MLTDTranslationClient";

let failures = 0;
let checks = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { checks += 1; })
    .catch((error) => {
      failures += 1;
      console.error(`FAIL ${name}\n     ${error.message}`);
    });
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function newDb(options = {}) {
  // The worker keeps a 10-minute stats memo for production read amplification.
  // Tests swap the whole database, so the memo has to be dropped with it.
  workerModule.clearStatsMemo();
  const db = new SqliteD1({ portalDir: DIRNAME, ...options });
  db.applySchema();
  // Migrations seed 1077100/1077500 as historical release rows. That is data,
  // not schema, so each test starts from an empty release registry and
  // registers exactly the releases it is about.
  db.db.exec("DELETE FROM release_resource_refs; DELETE FROM source_variants; DELETE FROM translation_units; DELETE FROM resource_units; DELETE FROM assets_releases; DELETE FROM client_releases; DELETE FROM release_summaries;");
  return db;
}

function baseEnv(db, overrides = {}) {
  return {
    DB: db,
    PUBLICATION_BUCKET: new MemoryR2(),
    ENVIRONMENT: "test",
    GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
    GITHUB_SYNC_TOKEN: "ghs_test_token",
    SYNC_REPOSITORIES: JSON.stringify({ [ASSETS_REPO]: "assets", [CLIENT_REPO]: "client" }),
    // Production reads the immutable GitHub manifest. Keep sync tests on their
    // explicit D1 fixtures unless a test opts into a manifest response.
    ASSETS_PORTAL_MANIFEST_URL: "data:application/json,%7B%7D",
    CLIENT_PORTAL_MANIFEST_URL: "data:application/json,%7B%7D",
    ...overrides,
  };
}

async function registerAssetsRelease(db, assetVersion, status) {
  await db.prepare(
    `INSERT OR REPLACE INTO assets_releases (asset_version, release_id, server_schema_version, status, note, created_at, updated_at) ` +
    `VALUES (?, ?, 'v1', ?, 'test', '2026-09-28T00:00:00Z', '2026-09-28T00:00:00Z')`
  ).bind(assetVersion, `assets-${assetVersion}`, status).run();
}

async function hmac(secret, body) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function postWebhook(env, payload, { delivery = "d1", event = "push", signature = null, secret = "test-webhook-secret" } = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const headers = new Headers({ "content-type": "application/json" });
  if (event) headers.set("X-GitHub-Event", event);
  if (delivery) headers.set("X-GitHub-Delivery", delivery);
  headers.set("X-Hub-Signature-256", signature || await hmac(secret, body));
  const request = new Request("https://portal.example.test/api/webhooks/github", { method: "POST", headers, body });
  const response = await worker.fetch(request, env);
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { response, body: parsed };
}

// A GitHub double: serves compare/tree/raw from a fixture commit.
function fakeGitHub({ repository, commitSha, files = {}, compare = null, tree = null }) {
  return async (url) => {
    const target = String(url);
    if (target.includes("/compare/")) {
      if (!compare) return new Response("not found", { status: 404 });
      return Response.json({ files: compare });
    }
    if (target.includes("/git/trees/")) {
      return Response.json({ tree: tree || Object.keys(files).map((p) => ({ path: p, type: "blob", sha: sha256Hex(p) })) });
    }
    if (target.includes("raw.githubusercontent.com")) {
      const marker = `/${repository}/${commitSha}/`;
      const index = target.indexOf(marker);
      const filePath = index >= 0 ? target.slice(index + marker.length).split("?")[0] : "";
      const decoded = decodeURIComponent(filePath);
      if (!(decoded in files)) return new Response("not found", { status: 404 });
      return new Response(files[decoded], { status: 200, headers: { "content-type": "text/plain" } });
    }
    return new Response("not found", { status: 404 });
  };
}

// ---------------------------------------------------------------------------
// Webhook: signature, fail-closed, allow-lists, dedup
// ---------------------------------------------------------------------------

await test("webhook rejects a wrong HMAC", async () => {
  const db = newDb();
  const env = baseEnv(db);
  const result = await postWebhook(env, { repository: { full_name: ASSETS_REPO }, after: "a".repeat(40) }, { signature: `sha256=${"0".repeat(64)}` });
  assert.equal(result.response.status, 401);
  assert.equal(result.body.error, "invalid_webhook_signature");
});

await test("webhook accepts a correct HMAC and enqueues exactly one job", async () => {
  const db = newDb();
  const env = baseEnv(db);
  const result = await postWebhook(env, { repository: { full_name: ASSETS_REPO }, after: "a".repeat(40), ref: "refs/heads/main" });
  assert.equal(result.response.status, 202);
  assert.equal(result.body.status, "queued");
  assert.equal(result.body.consumer, "scheduled:cron");
  assert.equal(db.db.prepare("SELECT COUNT(*) c FROM sync_jobs").get().c, 1);
  assert.equal(db.db.prepare("SELECT COUNT(*) c FROM github_webhook_deliveries").get().c, 1);
});

await test("webhook fails closed in production without a secret", async () => {
  const db = newDb();
  const env = baseEnv(db, { GITHUB_WEBHOOK_SECRET: "", ENVIRONMENT: "production" });
  const result = await postWebhook(env, { repository: { full_name: ASSETS_REPO }, after: "b".repeat(40) });
  assert.equal(result.response.status, 503);
  assert.equal(result.body.error, "webhook_secret_unconfigured");
  assert.equal(db.db.prepare("SELECT COUNT(*) c FROM sync_jobs").get().c, 0);
});

await test("webhook rejects missing delivery header", async () => {
  const db = newDb();
  const env = baseEnv(db);
  const result = await postWebhook(env, { repository: { full_name: ASSETS_REPO } }, { delivery: "" });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.error, "missing_github_headers");
});

await test("webhook ignores a duplicate delivery id", async () => {
  const db = newDb();
  const env = baseEnv(db);
  const payload = { repository: { full_name: ASSETS_REPO }, after: "c".repeat(40) };
  const first = await postWebhook(env, payload, { delivery: "dup-1" });
  assert.equal(first.response.status, 202);
  const second = await postWebhook(env, payload, { delivery: "dup-1" });
  assert.equal(second.response.status, 200);
  assert.equal(second.body.status, "duplicate_ignored");
  assert.equal(db.db.prepare("SELECT COUNT(*) c FROM sync_jobs").get().c, 1);
});

await test("webhook ignores an unconfigured repository", async () => {
  const db = newDb();
  const env = baseEnv(db);
  const result = await postWebhook(env, { repository: { full_name: "someone/other-repo" }, after: "d".repeat(40) }, { delivery: "repo-1" });
  assert.equal(result.response.status, 202);
  assert.equal(result.body.status, "ignored");
  assert.equal(result.body.reason, "repository_not_configured");
  assert.equal(db.db.prepare("SELECT COUNT(*) c FROM sync_jobs").get().c, 0);
});

await test("webhook ignores a disallowed event type", async () => {
  const db = newDb();
  const env = baseEnv(db);
  const result = await postWebhook(env, { repository: { full_name: ASSETS_REPO }, after: "e".repeat(40) }, { delivery: "ev-1", event: "issues" });
  assert.equal(result.response.status, 202);
  assert.equal(result.body.reason, "event_not_allowed");
});

await test("replaying the same commit enqueues no second job", async () => {
  const db = newDb();
  const env = baseEnv(db);
  const commit = "f".repeat(40);
  const payload = { repository: { full_name: ASSETS_REPO }, after: commit };
  const first = await postWebhook(env, payload, { delivery: "commit-1" });
  assert.equal(first.response.status, 202);
  const second = await postWebhook(env, payload, { delivery: "commit-2" });
  assert.equal(second.response.status, 200);
  assert.equal(second.body.status, "duplicate_commit_ignored");
  assert.equal(db.db.prepare("SELECT COUNT(*) c FROM sync_jobs").get().c, 1, "commit replay must not duplicate the job");
});

await test("repository identity comes from config, not from the repo name", async () => {
  const env = baseEnv(newDb(), { SYNC_REPOSITORIES: '{"acme/thing":"client"}' });
  assert.equal(resolveTargetKind(env, "acme/thing"), "client");
  assert.equal(resolveTargetKind(env, "acme/thing-client"), null, "a name substring must not imply an axis");
  assert.equal(parseRepositoryConfig("a/b=assets,c/d=client").get("a/b"), "assets");
});

// ---------------------------------------------------------------------------
// Ingest planning and manifest validation
// ---------------------------------------------------------------------------

await test("path classification covers locales/lyrics/images and excludes video", () => {
  assert.equal(classifyPath("locales/story/event_1_jp.gtx.jsonl").kind, "text");
  assert.equal(classifyPath("lyrics/songs/scrobj_x.unity3d.jsonl").kind, "lyrics");
  assert.equal(classifyPath("manifests/images.manifest.json").kind, "image");
  assert.equal(classifyPath("video/op.mp4").unsupported, true);
  assert.equal(classifyPath("README.md"), null);
});

await test("the two non-text manifests are refused by name, not parsed to a silent zero", () => {
  // `manifests/images.manifest.json` is 937 pixel rows with no `ja`/`zh`; every
  // row used to fail `entryToRecord` and vanish, and the job reported success.
  const images = classifyPath("manifests/images.manifest.json");
  assert.equal(images.ingestible, false);
  assert.equal(images.reason, "image_manifest_metadata_only");

  // `manifests/bottom-bar.manifest.json` is an APK built-in atlas; it used to be
  // planned as `text` and then thrown out mid-ingest by shape validation.
  const bottomBar = classifyPath("manifests/bottom-bar.manifest.json");
  assert.equal(bottomBar.ingestible, false);
  assert.equal(bottomBar.reason, "apk_builtin_surface");

  const imagesPlan = planIngest([{ path: "manifests/images.manifest.json", status: "modified" }], { targetKind: "assets" });
  assert.deepEqual(imagesPlan.planned, []);
  assert.deepEqual(imagesPlan.skipped, [{ path: "manifests/images.manifest.json", reason: "image_manifest_metadata_only", kind: "image" }]);

  const clientPlan = planIngest([{ path: "manifests/bottom-bar.manifest.json", status: "modified" }], { targetKind: "client" });
  assert.deepEqual(clientPlan.planned, []);
  assert.deepEqual(clientPlan.skipped, [{ path: "manifests/bottom-bar.manifest.json", reason: "apk_builtin_surface", kind: "text" }]);

  // Defence in depth: a self-declaring manifest of either kind is refused by
  // `collectManifestEntries` too, so no future path rule can reopen the hole.
  assert.throws(
    () => collectManifestEntries({ kind: "mltd-images-manifest", images: [{}] }, "manifests/images.manifest.json"),
    /image_manifest_metadata_only/,
  );
  assert.throws(
    () => collectManifestEntries({ kind: "mltd-bottom-bar-manifest", slots: [{}] }, "manifests/bottom-bar.manifest.json"),
    /apk_builtin_surface/,
  );
  assert.throws(
    () => collectManifestEntries({ kind: "mltd-apk-builtin-manifest", surfaces: [{}] }, "manifests/apk-builtin.manifest.json"),
    /apk_builtin_surface/,
  );

  // The real shapes, as published today: 937 image rows, 7 bottom-bar slots.
  const realImages = { kind: "mltd-images-manifest", images: Array.from({ length: 937 }, (_, i) => ({ id: `tex_${i}` })) };
  const realBottomBar = { kind: "mltd-bottom-bar-manifest", atlas_target: { texture: "theater_system_footer_main" }, slots: Array.from({ length: 7 }, (_, i) => ({ index: i, ja: "x", zh: "y" })) };
  assert.throws(() => collectManifestEntries(realImages, "manifests/images.manifest.json"), /image_manifest_metadata_only/);
  assert.throws(() => collectManifestEntries(realBottomBar, "manifests/bottom-bar.manifest.json"), /apk_builtin_surface/);

  // A *text* manifest still parses; the refusal is by declared kind only.
  const textManifest = collectManifestEntries({ entries: [{ item_key: "k", ja: "あ", zh: "啊" }] }, "manifests/text.json");
  assert.equal(textManifest.length, 1);
  assert.equal(textManifest[0].item_key, "k");
});

await test("video stays an explicitly excluded surface, and PATH_RULES lists it", async () => {
  // §一.2 keeps video outside the Assets localisation binary set. It must be
  // reported as unsupported rather than falling through as unknown.
  const plan = planIngest([{ path: "video/op.mp4", status: "added" }], { targetKind: "assets" });
  assert.deepEqual(plan.planned, []);
  assert.equal(plan.skipped[0].reason, "unsupported_resource_kind");
  assert.equal(plan.skipped[0].kind, "video");

  const source = await import("node:fs/promises").then((fs) => fs.readFile(path.join(DIRNAME, "src", "sync_ingest.js"), "utf8"));
  assert.ok(/resource_kind.*video|'video'|"video"/.test(source), "PATH_RULES must list video explicitly");
  const kinds = dbKinds();
  assert.deepEqual(kinds, ["video"], "video is the only excluded resource kind");
});

function dbKinds() {
  const db = new SqliteD1({ portalDir: DIRNAME });
  db.applySchema();
  try {
    return db.db.prepare("SELECT resource_kind FROM unsupported_resource_kinds ORDER BY resource_kind").all().map((row) => row.resource_kind);
  } finally {
    db.close();
  }
}

await test("planIngest names the release manifest and reports exclusions", () => {
  const plan = planIngest([
    { path: "manifests/asset-version.json", status: "modified" },
    { path: "locales/story/a.jsonl", status: "added" },
    { path: "video/op.mp4", status: "added" },
    { path: "docs/notes.md", status: "modified" },
    { path: "old.jsonl", status: "removed" },
  ], { targetKind: "assets" });
  assert.deepEqual(plan.planned.map((p) => p.role), ["release-manifest", "entries"]);
  const reasons = plan.skipped.map((s) => s.reason).sort();
  assert.deepEqual(reasons, ["deleted", "path_not_ingestible", "unsupported_resource_kind"]);
});

await test("client release manifest may not carry an asset axis", () => {
  assert.throws(
    () => validateReleaseManifest("client", { client_version: "9.0.200", abi: "arm64-v8a", asset_version: "1077100" }, CLIENT_REPO),
    /decoupling_violation|must not carry/,
  );
});

await test("client release manifest enforces arm64-v8a", () => {
  assert.throws(
    () => validateReleaseManifest("client", { client_version: "9.0.200", abi: "armeabi-v7a" }, CLIENT_REPO),
    /client_abi_unsupported/,
  );
  const ok = validateReleaseManifest("client", { client_version: "9.0.200", abi: "arm64-v8a" }, CLIENT_REPO);
  assert.equal(ok.releaseId, "client-9.0.200-arm64-v8a");
});

await test("assets release manifest may not carry client fields", () => {
  assert.throws(
    () => validateReleaseManifest("assets", { asset_version: "1077100", base_apk_sha256: "0".repeat(64) }, ASSETS_REPO),
    /decoupling_violation/,
  );
});

// ---------------------------------------------------------------------------
// Consumer: claim, ingest, summary, idempotency
// ---------------------------------------------------------------------------

const ASSETS_ENTRY = { bundle: "event_0448_story_01_jp.gtx", item_key: "event_0448_story_01_1001", ja: "本日のイベント公演について", zh: "关于今天的活动公演", status: "accepted" };
const ASSETS_ENTRY_JSONL = `${JSON.stringify({ ...ASSETS_ENTRY, source_sha256: sha256Hex(ASSETS_ENTRY.ja) })}\n`;
const ASSETS_MANIFEST = JSON.stringify({ asset_version: "1077100", release_id: "assets-1077100", server_schema_version: "v1", assets_commit: "c".repeat(40) });

async function seedAssetsJob(db, env, { delivery = "job-1", commit = "9".repeat(40), files = null } = {}) {
  const fixture = files || {
    "manifests/asset-version.json": ASSETS_MANIFEST,
    "locales/story/event_0448_story_01_jp.gtx.jsonl": ASSETS_ENTRY_JSONL,
  };
  env.__fetch = fakeGitHub({ repository: ASSETS_REPO, commitSha: commit, files: fixture });
  await postWebhook(env, { repository: { full_name: ASSETS_REPO }, after: commit }, { delivery });
  return { commit, fixture };
}

await test("consumer ingests an assets commit and rebuilds the summary", async () => {
  const db = newDb();
  const env = baseEnv(db);
  const { commit } = await seedAssetsJob(db, env);

  const tick = await runSyncTick(env, { fetchImpl: env.__fetch });
  assert.equal(tick.claimed, 1);
  assert.equal(tick.results[0].status, "completed");

  const variant = db.db.prepare("SELECT * FROM source_variants WHERE release_kind='assets' AND release_id='assets-1077100'").get();
  assert.equal(variant.bundle, ASSETS_ENTRY.bundle);
  assert.equal(variant.item_key, ASSETS_ENTRY.item_key);
  assert.equal(variant.source_sha256, sha256Hex(ASSETS_ENTRY.ja));

  const ref = db.db.prepare("SELECT * FROM release_resource_refs WHERE source_variant_id=?").get(variant.source_variant_id);
  assert.equal(ref.status, "accepted");
  assert.equal(ref.reuse_mode, "none", "a first ingest of a brand-new key has nothing to reuse");

  const unit = db.db.prepare("SELECT * FROM translation_units").get();
  assert.equal(unit.translation, ASSETS_ENTRY.zh);
  assert.equal(unit.logical_key, buildLogicalKey("text", ASSETS_ENTRY.bundle, ASSETS_ENTRY.item_key));

  const summary = db.db.prepare("SELECT * FROM release_summaries WHERE release_kind='assets' AND release_id='assets-1077100'").get();
  assert.equal(summary.total_items, 1);
  assert.equal(summary.translated_items, 1);

  const cursor = db.db.prepare("SELECT * FROM sync_cursors WHERE repository=?").get(ASSETS_REPO);
  assert.equal(cursor.commit_sha, commit);

  const job = db.db.prepare("SELECT * FROM sync_jobs").get();
  assert.equal(job.status, "completed");
  assert.equal(job.attempts, 1);
  assert.ok(Number(job.rows_written) >= 4);

  const delivery = db.db.prepare("SELECT * FROM github_webhook_deliveries").get();
  assert.equal(delivery.status, "completed");
});

await test("re-running the same commit is idempotent (no duplicate rows)", async () => {
  const db = newDb();
  const env = baseEnv(db);
  const { commit, fixture } = await seedAssetsJob(db, env);
  await runSyncTick(env, { fetchImpl: env.__fetch });
  const before = {
    variants: db.db.prepare("SELECT COUNT(*) c FROM source_variants").get().c,
    units: db.db.prepare("SELECT COUNT(*) c FROM translation_units").get().c,
    refs: db.db.prepare("SELECT COUNT(*) c FROM release_resource_refs").get().c,
  };

  // Replay the same commit as a new delivery: the unique index must absorb it.
  const replay = await postWebhook(env, { repository: { full_name: ASSETS_REPO }, after: commit }, { delivery: "job-1-replay" });
  assert.equal(replay.body.status, "duplicate_commit_ignored");

  // And a second consumer pass over an already-processed commit must be a no-op:
  db.db.prepare("UPDATE sync_jobs SET status='queued', next_retry_at=NULL, cursor_json=NULL").run();
  const direct = await runJob(env, db.db.prepare("SELECT * FROM sync_jobs").get(), { fetchImpl: fakeGitHub({ repository: ASSETS_REPO, commitSha: commit, files: fixture }) });
  assert.equal(direct.status, "completed");

  const after = {
    variants: db.db.prepare("SELECT COUNT(*) c FROM source_variants").get().c,
    units: db.db.prepare("SELECT COUNT(*) c FROM translation_units").get().c,
    refs: db.db.prepare("SELECT COUNT(*) c FROM release_resource_refs").get().c,
  };
  assert.deepEqual(after, before, "a replayed commit must not create rows");
});

await test("a declared hash that does not match the content is rejected, not repaired", async () => {
  const db = newDb();
  const env = baseEnv(db);
  const bad = { ...ASSETS_ENTRY, source_sha256: "1".repeat(64) };
  await seedAssetsJob(db, env, {
    files: {
      "manifests/asset-version.json": ASSETS_MANIFEST,
      "locales/story/event_0448_story_01_jp.gtx.jsonl": `${JSON.stringify(bad)}\n`,
    },
  });
  const tick = await runSyncTick(env, { fetchImpl: env.__fetch });
  assert.equal(tick.results[0].status, "completed");
  const variant = db.db.prepare("SELECT * FROM source_variants").get();
  assert.equal(variant, undefined, "a source-integrity failure must not create a variant");
  const job = db.db.prepare("SELECT * FROM sync_jobs").get();
  const result = JSON.parse(job.result_json);
  assert.equal(result.rejections.length, 1);
  assert.equal(result.rejections[0].reason, "source_hash_mismatch");
});

await test("an ingest never promotes a release to canonical", async () => {
  const db = newDb();
  const env = baseEnv(db);
  await seedAssetsJob(db, env, { files: { "manifests/asset-version.json": JSON.stringify({ asset_version: "1077700", assets_commit: "d".repeat(40) }) } });
  await runSyncTick(env, { fetchImpl: env.__fetch });
  const release = db.db.prepare("SELECT * FROM assets_releases WHERE asset_version='1077700'").get();
  assert.equal(release.status, "staging", "an ingest may only ever create staging releases");
});

await test("failure retries with backoff and stops at max_attempts", async () => {
  const db = newDb();
  const env = baseEnv(db);
  await seedAssetsJob(db, env);
  db.db.prepare("UPDATE sync_jobs SET max_attempts=2").run();
  const failing = async () => new Response("boom", { status: 500 });

  let job = db.db.prepare("SELECT * FROM sync_jobs").get();
  const first = await runJob(env, job, { fetchImpl: failing });
  assert.equal(first.status, "retrying");
  job = db.db.prepare("SELECT * FROM sync_jobs").get();
  assert.equal(job.status, "retrying");
  assert.ok(job.next_retry_at, "a retry must carry a backoff timestamp");
  assert.equal(job.attempts, 1);

  // The retry gate must hold the job until the backoff elapses.
  const claimedEarly = await claimJobs(env, 5);
  assert.equal(claimedEarly.length, 0, "a job inside its backoff window must not be claimed");

  db.db.prepare("UPDATE sync_jobs SET next_retry_at=? WHERE job_id=?").run(new Date(Date.now() - 1000).toISOString(), job.job_id);
  const second = await runSyncTick(env, { fetchImpl: failing });
  assert.equal(second.results[0].status, "failed", "the second attempt exhausts max_attempts");
  const final = db.db.prepare("SELECT * FROM sync_jobs").get();
  assert.equal(final.status, "failed");
  assert.equal(final.attempts, 2);
  assert.match(final.error_message, /github_request_failed/);
  assert.equal(db.db.prepare("SELECT status FROM github_webhook_deliveries").get().status, "failed");
});

await test("backoff grows and is capped", () => {
  const one = Date.parse(backoffForAttempt(1)) - Date.now();
  const three = Date.parse(backoffForAttempt(3)) - Date.now();
  const twenty = Date.parse(backoffForAttempt(20)) - Date.now();
  assert.ok(one <= 60000 && one > 50000, `attempt 1 ≈ 60s, got ${one}`);
  assert.ok(three <= 240000 && three > 200000, `attempt 3 ≈ 240s, got ${three}`);
  assert.ok(twenty <= 3600000 && twenty > 3500000, `capped at 1h, got ${twenty}`);
});

await test("a too-large tree is delegated, recorded and reported", async () => {
  const db = newDb();
  const env = baseEnv(db);
  await postWebhook(env, { repository: { full_name: ASSETS_REPO }, after: "7".repeat(40) }, { delivery: "big-1" });
  const hugeTree = Array.from({ length: 450 }, (_, i) => ({ path: `locales/story/f${i}.jsonl`, type: "blob", sha: "0".repeat(40) }));
  const fetchImpl = async (url) => {
    if (String(url).includes("/git/trees/")) return Response.json({ tree: hugeTree });
    return new Response("not found", { status: 404 });
  };
  const tick = await runSyncTick(env, { fetchImpl });
  assert.equal(tick.results[0].status, "failed");
  const job = db.db.prepare("SELECT * FROM sync_jobs").get();
  assert.match(job.error_message, /delegated_to_actions:ingest_tree_too_large/);
  const delegation = db.db.prepare("SELECT * FROM sync_delegations").get();
  assert.equal(delegation.reason, "ingest_tree_too_large");
  assert.equal(db.db.prepare("SELECT status FROM github_webhook_deliveries").get().status, "ignored");
});

await test("a job exceeding the row budget requeues with a progress cursor", async () => {
  const db = newDb();
  const env = baseEnv(db);
  const files = {
    "manifests/asset-version.json": ASSETS_MANIFEST,
    "locales/story/a.jsonl": `${JSON.stringify({ ...ASSETS_ENTRY, item_key: "a1", source_sha256: sha256Hex(ASSETS_ENTRY.ja) })}\n`,
    "locales/story/b.jsonl": `${JSON.stringify({ ...ASSETS_ENTRY, item_key: "b1", source_sha256: sha256Hex(ASSETS_ENTRY.ja) })}\n`,
  };
  await seedAssetsJob(db, env, { files, commit: "8".repeat(40) });
  const fetchImpl = fakeGitHub({ repository: ASSETS_REPO, commitSha: "8".repeat(40), files });

  const first = await runJob(env, db.db.prepare("SELECT * FROM sync_jobs").get(), { fetchImpl, rowsPerJob: 4 });
  assert.equal(first.status, "queued");
  const job = db.db.prepare("SELECT * FROM sync_jobs").get();
  const cursor = JSON.parse(job.cursor_json);
  assert.equal(cursor.processed_paths.length, 1, "the first file is recorded in the cursor");
  assert.equal(db.db.prepare("SELECT COUNT(*) c FROM source_variants").get().c, 1);

  // Resuming must continue from the cursor rather than restarting the commit.
  db.db.prepare("UPDATE sync_jobs SET status='queued', next_retry_at=NULL").run();
  const second = await runJob(env, db.db.prepare("SELECT * FROM sync_jobs").get(), { fetchImpl, rowsPerJob: 100 });
  assert.equal(second.status, "completed");
  assert.equal(db.db.prepare("SELECT COUNT(*) c FROM source_variants").get().c, 2);
});

// ---------------------------------------------------------------------------
// The summary contract: per tick per release, not per job
// ---------------------------------------------------------------------------
//
// `runJob` no longer rebuilds `release_summaries` itself — it defers the release
// to the tick. That is what makes a multi-chunk import cost one full GROUP BY
// instead of one per chunk (the 16.5x daily-read overrun recorded in
// work/agents/text-localization/sync-schema-quota-20260929/HANDOFF.md), and it
// is only sound while the tick always drains what was deferred. The tests below
// pin both halves: the deferral, and the drain under a tick that fails.

/// Count the summary rebuilds by wrapping `prepare` and looking for the one
/// statement that writes `release_summaries` (`rebuildReleaseSummary` is its
/// only issuer). Counting the statement rather than the function keeps the
/// assertion about the invariant, not about how the rebuild is implemented.
function countSummaryRebuilds(env) {
  const counter = { rebuilds: 0 };
  const realPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    if (/INSERT INTO release_summaries/i.test(String(sql))) counter.rebuilds += 1;
    return realPrepare(sql);
  };
  return counter;
}

function insertJob(db, { jobId, deliveryId, commit, status = "queued", attempts = 0, created_at = "2026-09-29T00:00:00Z" }) {
  db.db.prepare(
    `INSERT OR IGNORE INTO github_webhook_deliveries (delivery_id, repository, event_type, commit_sha, status, created_at) ` +
    `VALUES (?, ?, 'push', ?, 'processing', '2026-09-29T00:00:00Z')`
  ).run(deliveryId, ASSETS_REPO, commit);
  // The claim orders by `created_at ASC`, so a fixture that wants a specific
  // claim order names the time it wants.
  db.db.prepare(
    `INSERT INTO sync_jobs (job_id, delivery_id, repository, event_type, commit_sha, before_sha, target_kind, target_release_id, status, attempts, max_attempts, created_at, updated_at) ` +
    `VALUES (?, ?, ?, 'push', ?, NULL, 'assets', 'assets-1077100', ?, ?, 3, ?, ?)`
  ).run(jobId, deliveryId, ASSETS_REPO, commit, status, attempts, created_at, created_at);
}

async function seedMultiChunkJob(db, env, { jobId, deliveryId, commit, files }) {
  insertJob(db, { jobId, deliveryId, commit });
  env.__fetch = fakeGitHub({ repository: ASSETS_REPO, commitSha: commit, files });
}

/// A GitHub double over a chain of commits (`{commit: {path: body}}`). Each
/// commit answers `compare/<parent>...<commit>` with the files that differ from
/// its parent, which is what the runner's incremental path asks for, and serves
/// its own raw files. A commit whose parent is not in the map answers 404 for
/// the compare — the same shape a first sync sees from the real API.
function fakeCommitChain(filesByCommit) {
  const order = Object.keys(filesByCommit);
  const parentOf = new Map(order.map((commit, index) => [commit, order[index - 1] || null]));
  const clients = new Map(order.map((commit) => [commit, fakeGitHub({ repository: ASSETS_REPO, commitSha: commit, files: filesByCommit[commit] })]));
  return async (url) => {
    const target = String(url);
    if (target.includes("/compare/")) {
      const [base, head] = target.split("/compare/")[1].split("?")[0].split("...");
      const headFiles = filesByCommit[head];
      if (!headFiles || parentOf.get(head) !== base) return new Response("not found", { status: 404 });
      const baseFiles = filesByCommit[base] || {};
      const changed = Object.entries(headFiles)
        .filter(([path, body]) => baseFiles[path] !== body)
        .map(([path]) => ({ filename: path, status: baseFiles[path] === undefined ? "added" : "modified", sha: sha256Hex(path) }));
      return Response.json({ files: changed });
    }
    for (const [commit, client] of clients) {
      if (target.includes(commit)) return client(url);
    }
    return new Response("not found", { status: 404 });
  };
}

await test("a multi-chunk job defers its summary to the tick and pays one rebuild there", async () => {
  const db = newDb();
  const env = baseEnv(db);
  // Three files, one record each. One record is 4 written rows (see
  // `writeRecordBatch`), so a budget of 4 makes each invocation consume exactly
  // one file: three ticks, one finished job, three deferrals.
  const files = { "manifests/asset-version.json": ASSETS_MANIFEST };
  for (const name of ["a", "b", "c"]) {
    files[`locales/story/${name}.jsonl`] = `${JSON.stringify({ ...ASSETS_ENTRY, item_key: `${name}1`, source_sha256: sha256Hex(ASSETS_ENTRY.ja) })}\n`;
  }
  const commit = "6".repeat(40);
  await seedMultiChunkJob(db, env, { jobId: "chunked", deliveryId: "d-chunked", commit, files });
  // `/api/stats` reads the *canonical* release, and an ingest never promotes one
  // (that is an operator decision), so the fixture registers it. Registering it
  // also exercises the tick's `rebuildPortalStats` call, which only happens when
  // an assets release moved.
  await registerAssetsRelease(db, "1077100", "canonical");
  const fetchImpl = env.__fetch;

  const counter = countSummaryRebuilds(env);
  const chunkStatuses = [];
  for (let tickNumber = 1; tickNumber <= 5; tickNumber += 1) {
    const rebuildsBeforeTick = counter.rebuilds;
    const tick = await runSyncTick(env, { fetchImpl, rowsPerJob: 4, claimLimit: 1 });
    assert.equal(tick.results.length, 1, "one job per tick in this fixture");
    chunkStatuses.push(tick.results[0].status);
    // Every tick drains, finished or not: that is what makes deferring safe.
    assert.equal(counter.rebuilds, rebuildsBeforeTick + 1, `tick ${tickNumber} must drain its one touched release`);
    // The invariant the brief asks for, after *every* tick, failed ticks and
    // unfinished jobs included: the summary equals the refs that exist.
    const refsNow = db.db.prepare("SELECT COUNT(*) c FROM release_resource_refs WHERE release_kind='assets' AND release_id='assets-1077100'").get().c;
    const summaryNow = db.db.prepare("SELECT total_items FROM release_summaries WHERE release_kind='assets' AND release_id='assets-1077100'").get();
    assert.equal(summaryNow.total_items, refsNow, `after tick ${tickNumber} the summary must equal the refs (${refsNow})`);
    if (tick.results[0].status !== "queued") break;
    db.db.prepare("UPDATE sync_jobs SET status='queued', next_retry_at=NULL, attempts=0").run();
  }
  assert.deepEqual(chunkStatuses, ["queued", "queued", "completed"], "3 files at 1 file per invocation");

  // Three ticks, one release, three rebuilds — not three per chunk. A tick that
  // had claimed the whole job at once (the `rowsPerJob` default) would be one.
  assert.equal(counter.rebuilds, 3, "one rebuild per tick, not one per file");

  const refs = db.db.prepare("SELECT COUNT(*) c FROM release_resource_refs WHERE release_kind='assets' AND release_id='assets-1077100'").get().c;
  const summary = db.db.prepare("SELECT total_items FROM release_summaries WHERE release_kind='assets' AND release_id='assets-1077100'").get();
  assert.equal(refs, 3);
  assert.equal(summary.total_items, refs, "the last tick's rebuild counts every ref all three chunks wrote");

  // And the read path can serve it: `/api/stats` consumes both derived rows.
  const stats = await worker.fetch(new Request("https://portal.example.test/api/stats"), env);
  assert.equal(stats.status, 200, "the reader can serve the rebuilt summary");
  assert.equal((await stats.json()).total, refs, "the stats endpoint must report every ref, not a stale count");
});

await test("one tick with three jobs on one release rebuilds it once, with the finished total", async () => {
  const db = newDb();
  const env = baseEnv(db);
  // Three separate jobs (three commits, three deliveries), each one file, all
  // writing the same release. Claimed together by one tick, in `created_at`
  // order, which is the order the claim sorts by.
  const filesByCommit = {};
  for (const [index, name] of ["p", "q", "r"].entries()) {
    const commit = String(index + 1).repeat(40);
    filesByCommit[commit] = { "manifests/asset-version.json": ASSETS_MANIFEST };
    filesByCommit[commit][`locales/story/${name}.jsonl`] = `${JSON.stringify({ ...ASSETS_ENTRY, item_key: `${name}1`, source_sha256: sha256Hex(ASSETS_ENTRY.ja) })}\n`;
    insertJob(db, { jobId: `tick-${name}`, deliveryId: `d-tick-${name}`, commit, created_at: `2026-09-29T00:00:0${index}Z` });
  }
  // The three commits form a chain, so the fixture serves the same
  // `compare/<base>...<head>` the real GitHub would: the second and third jobs
  // are found by the cursor the first one writes (the runner's incremental
  // path), not by a tree listing.
  const fetchImpl = fakeCommitChain(filesByCommit);

  const counter = countSummaryRebuilds(env);
  const tick = await runSyncTick(env, { fetchImpl, rowsPerJob: 1000, claimLimit: 10 });
  assert.equal(tick.claimed, 3, "all three jobs are claimed in one tick");
  assert.deepEqual(tick.results.map((r) => r.status), ["completed", "completed", "completed"]);
  assert.equal(
    counter.rebuilds, 1,
    "three jobs on one release must cost one rebuild after the tick, not three (one per job)",
  );
  const refs = db.db.prepare("SELECT COUNT(*) c FROM release_resource_refs WHERE release_kind='assets' AND release_id='assets-1077100'").get().c;
  const summary = db.db.prepare("SELECT total_items FROM release_summaries WHERE release_kind='assets' AND release_id='assets-1077100'").get();
  assert.equal(refs, 3);
  assert.equal(summary.total_items, 3, "the single rebuild happens after the last job, so it sees all three files");
});

await test("a tick that throws still rebuilds what its jobs wrote", async () => {
  const db = newDb();
  const env = baseEnv(db);
  const files = { "manifests/asset-version.json": ASSETS_MANIFEST };
  for (const name of ["a", "b"]) {
    files[`locales/story/${name}.jsonl`] = `${JSON.stringify({ ...ASSETS_ENTRY, item_key: `${name}1`, source_sha256: sha256Hex(ASSETS_ENTRY.ja) })}\n`;
  }
  // One file per invocation, so the job is still unfinished when the fetch dies:
  // `rows_written` counts 4 rows per one-record file (see `writeRecordBatch`), so
  // a budget of 4 stops after the first file, which leaves the second one unread.
  const commit = "9".repeat(40);
  await seedMultiChunkJob(db, env, { jobId: "chunked", deliveryId: "d-chunked", commit, files });
  const fetchImpl = env.__fetch;

  // Two chunks land under a tick each. The refs of the first chunk are visible
  // to the read path from the moment it is written, and each of those ticks
  // ends by draining, so the summary is never behind.
  const firstTick = await runSyncTick(env, { fetchImpl, rowsPerJob: 4, claimLimit: 1 });
  assert.equal(firstTick.results[0].status, "queued");
  const summaryAfterFirstChunk = db.db.prepare("SELECT total_items FROM release_summaries WHERE release_kind='assets' AND release_id='assets-1077100'").get();
  assert.equal(summaryAfterFirstChunk.total_items, 1, "a tick that only queued a chunk still drained it");
  db.db.prepare("UPDATE sync_jobs SET status='queued', next_retry_at=NULL, attempts=0").run();

  // The second chunk's fetch dies on its first HTTP call — after the tick has
  // already claimed the job, and with the first chunk's ref on disk. The tick
  // must still unwind through the drain: this is the case the completion path
  // never reaches, and the one that would silently leave the summary behind.
  const flaky = async () => { throw new Error("boom: network down mid-tick"); };
  const failingTick = await runSyncTick(env, { fetchImpl: flaky, rowsPerJob: 4, claimLimit: 1 });
  assert.equal(failingTick.results[0].status, "retrying", "the job failed, and the tick still returned");

  const refs = db.db.prepare("SELECT COUNT(*) c FROM release_resource_refs WHERE release_kind='assets' AND release_id='assets-1077100'").get().c;
  const summary = db.db.prepare("SELECT total_items FROM release_summaries WHERE release_kind='assets' AND release_id='assets-1077100'").get();
  assert.equal(refs, 1, "only the chunk that landed is in the refs table");
  assert.equal(summary.total_items, refs, "a tick whose job failed still rebuilt the summary of what it wrote");
});

// ---------------------------------------------------------------------------
// Cross-version reuse
// ---------------------------------------------------------------------------

const SOURCE = "おはようございます！";
const SOURCE_SHA = sha256Hex(SOURCE);

await test("two assets releases with the same source hash reuse exactly", async () => {
  const db = newDb();
  await registerAssetsRelease(db, "1077200", "staging");
  seedRelease(db, {
    releaseId: "assets-1077100", assetVersion: "1077100",
    bundles: [{ kind: "text", name: "bundle-a", entries: [{ item_key: "greet", source: SOURCE, source_sha256: SOURCE_SHA, translation: "早上好！", status: "accepted" }] }],
  });
  const env = baseEnv(db);
  const records = [{ resource_kind: "text", release_kind: "assets", release_id: "assets-1077200", bundle: "bundle-a", item_key: "greet", logical_key: buildLogicalKey("text", "bundle-a", "greet"), source_text: SOURCE, declared_sha256: SOURCE_SHA, translation: null }];
  const decisions = await evaluateReuseBatch(env, records);
  const decision = decisions.get(records[0]);
  assert.equal(decision.reuse_mode, "exact");
  assert.equal(decision.translation, "早上好！");
});

await test("two client releases with the same source hash reuse exactly", async () => {
  const db = newDb();
  seedRelease(db, { releaseKind: "client", releaseId: "client-9.0.200-arm64-v8a", assetVersion: "9.0.200",
    bundles: [{ kind: "text", name: "bottom-bar", entries: [{ item_key: "home", source: "ホーム", source_sha256: sha256Hex("ホーム"), translation: "主页", status: "accepted" }] }] });
  const env = baseEnv(db);
  const records = [{ resource_kind: "text", release_kind: "client", release_id: "client-9.0.201-arm64-v8a", bundle: "bottom-bar", item_key: "home", logical_key: buildLogicalKey("text", "bottom-bar", "home"), source_text: "ホーム", declared_sha256: sha256Hex("ホーム"), translation: null }];
  const decisions = await evaluateReuseBatch(env, records);
  assert.equal(decisions.get(records[0]).reuse_mode, "exact");
});

await test("client and assets sharing a logical_key with different hashes never reuse exactly", async () => {
  const db = newDb();
  seedRelease(db, {
    releaseId: "assets-1077100", assetVersion: "1077100",
    bundles: [{ kind: "text", name: "shared", entries: [{ item_key: "greet", source: SOURCE, source_sha256: SOURCE_SHA, translation: "早上好！", status: "accepted" }] }],
  });
  const env = baseEnv(db);
  const changed = "おはよう！";
  const records = [{ resource_kind: "text", release_kind: "client", release_id: "client-9.0.200-arm64-v8a", bundle: "shared", item_key: "greet", logical_key: buildLogicalKey("text", "shared", "greet"), source_text: changed, declared_sha256: sha256Hex(changed), translation: null }];
  const decisions = await evaluateReuseBatch(env, records);
  const decision = decisions.get(records[0]);
  assert.notEqual(decision.reuse_mode, "exact");
  assert.equal(decision.reuse_mode, "suggested", "a different hash with history may only be suggested");
  assert.equal(decision.translation_id, null, "a suggestion is not bound to the release");
});

await test("verified-compatible requires an explicit attestation row", async () => {
  const db = newDb();
  seedRelease(db, {
    releaseId: "assets-1077100", assetVersion: "1077100",
    bundles: [{ kind: "text", name: "shared", entries: [{ item_key: "greet", source: SOURCE, source_sha256: SOURCE_SHA, translation: "早上好！", status: "accepted" }] }],
  });
  const env = baseEnv(db);
  const changed = "おはよう！";
  const record = { resource_kind: "text", release_kind: "assets", release_id: "assets-1077200", bundle: "shared", item_key: "greet", logical_key: buildLogicalKey("text", "shared", "greet"), source_text: changed, declared_sha256: sha256Hex(changed), translation: null };

  const before = await evaluateReuseBatch(env, [record]);
  assert.equal(before.get(record).reuse_mode, "suggested");

  db.db.prepare(
    `INSERT INTO reuse_attestations (attestation_id, resource_kind, logical_key, locale, from_source_sha256, to_source_sha256, reason, attested_by, created_at) ` +
    `VALUES ('att-1', 'text', ?, 'zh-CN', ?, ?, 'manual review of the wording change', 'reviewer@example.test', '2026-09-28T00:00:00Z')`
  ).run(record.logical_key, SOURCE_SHA, record.declared_sha256);

  const after = await evaluateReuseBatch(env, [record]);
  const decision = after.get(record);
  assert.equal(decision.reuse_mode, "verified-compatible");
  assert.equal(decision.translation, "早上好！");
  assert.equal(decision.attestation_reason, "manual review of the wording change");
});

await test("no reuse branch reads a version number, bundle name or date", async () => {
  const db = newDb();
  seedRelease(db, {
    releaseId: "assets-1077100", assetVersion: "1077100",
    bundles: [{ kind: "text", name: "bundle-a", entries: [{ item_key: "k", source: "A", source_sha256: sha256Hex("A"), translation: "甲", status: "accepted" }] }],
  });
  const env = baseEnv(db);
  // Same bundle and item key, adjacent versions, one day apart — must still be
  // blocked/untranslated because the source text changed without an attestation.
  const record = { resource_kind: "text", release_kind: "assets", release_id: "assets-1077101", bundle: "bundle-a", item_key: "k", logical_key: buildLogicalKey("text", "bundle-a", "k"), source_text: "B", declared_sha256: sha256Hex("B"), translation: null };
  const decisions = await evaluateReuseBatch(env, [record]);
  assert.equal(decisions.get(record).reuse_mode, "suggested");
  const src = await import("node:fs/promises").then((fs) => fs.readFile(path.join(DIRNAME, "src", "sync_ingest.js"), "utf8"));
  const evaluateBody = src.slice(src.indexOf("export async function evaluateReuseBatch"), src.indexOf("/// Map a reuse decision"));
  for (const forbidden of ["version", "releasedAt", "date", "similarity", "difflib", "bundle ===", "itemKey === "]) {
    assert.ok(!evaluateBody.includes(forbidden), `evaluateReuseBatch must not consult ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
// API surface over a real database
// ---------------------------------------------------------------------------

await test("stats reads one summary row and never scans a catalogue", async () => {
  const db = newDb();
  const env = baseEnv(db);
  seedRelease(db, {
    releaseId: "assets-1077100", assetVersion: "1077100",
    bundles: [
      { kind: "text", name: "bundle-a", entries: [{ item_key: "a", source: "A", source_sha256: sha256Hex("A"), translation: "甲", status: "accepted" }] },
      { kind: "text", name: "bundle-b", entries: [{ item_key: "b", source: "B", source_sha256: sha256Hex("B") }] },
    ],
  });
  writeSummary(db, "assets", "assets-1077100");
  db.resetCounters();

  const response = await worker.fetch(new Request("https://portal.example.test/api/stats"), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.total, 2);
  assert.equal(body.translated, 1);
  assert.equal(db.scans.length, 0, `stats must not scan: ${JSON.stringify(db.scans)}`);
  assert.ok(db.rowsRead <= 4, `stats must read a handful of rows, read ${db.rowsRead}`);
});

await test("stats answers data_not_ready instead of fabricating zeros", async () => {
  const db = newDb();
  const env = baseEnv(db);
  await registerAssetsRelease(db, "1077100", "canonical");
  const response = await worker.fetch(new Request("https://portal.example.test/api/stats"), env);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, "data_not_ready");
  assert.notEqual(body.total, 0);
});

await test("stats turns a D1 quota error into 503, not an empty summary", async () => {
  const db = newDb({ readBudget: 0 });
  const env = baseEnv(db);
  await registerAssetsRelease(db, "1077100", "canonical");
  db.resetCounters();
  db.readBudget = 0;
  const response = await worker.fetch(new Request("https://portal.example.test/api/stats"), env);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, "d1_quota_exceeded");
  assert.ok(response.headers.get("retry-after"), "a quota answer must tell the caller when to retry");
  assert.equal(body.total, undefined, "a quota failure must never be reported as total=0");
});

await test("catalogue search is scoped, cursor-paged, has no OFFSET and no COUNT", async () => {
  const db = newDb();
  const env = baseEnv(db);
  const entries = Array.from({ length: 60 }, (_, i) => ({
    item_key: `k${String(i).padStart(3, "0")}`,
    source: `source ${i}`,
    source_sha256: sha256Hex(`source ${i}`),
    translation: i % 2 === 0 ? `译文 ${i}` : undefined,
    status: i % 2 === 0 ? "accepted" : "untranslated",
  }));
  seedRelease(db, { releaseId: "assets-1077100", assetVersion: "1077100", bundles: [{ kind: "text", name: "bundle-a", entries }] });
  writeSummary(db, "assets", "assets-1077100");
  db.resetCounters();

  const first = await worker.fetch(new Request("https://portal.example.test/api/catalogue/search?release_id=assets-1077100&limit=25"), env);
  const firstBody = await first.json();
  assert.equal(firstBody.items.length, 25);
  assert.ok(firstBody.next_cursor, "a full page must return a cursor");
  assert.equal(firstBody.total, null, "total is opt-in");

  const second = await worker.fetch(new Request(`https://portal.example.test/api/catalogue/search?release_id=assets-1077100&limit=25&cursor=${encodeURIComponent(firstBody.next_cursor)}`), env);
  const secondBody = await second.json();
  assert.equal(secondBody.items.length, 25);
  assert.notEqual(secondBody.items[0].item_key, firstBody.items[0].item_key, "page 2 must continue, not repeat");

  assert.equal(db.offsets.length, 0, `no query may use OFFSET: ${JSON.stringify(db.offsets)}`);
  assert.equal(db.aggregates.length, 0, `no request may run COUNT/GROUP BY: ${JSON.stringify(db.aggregates)}`);
  assert.ok(db.rowsRead < 120, `two pages must read bounded rows, read ${db.rowsRead}`);

  db.resetCounters();
  const withTotal = await worker.fetch(new Request("https://portal.example.test/api/catalogue/search?release_id=assets-1077100&limit=5&include_total=true"), env);
  const totalBody = await withTotal.json();
  assert.equal(totalBody.total, 60);
  assert.equal(totalBody.total_source, "release_summaries");
  assert.equal(db.aggregates.length, 0, "even an explicit total must come from the summary row");
});

await test("catalogue search rejects an unregistered release and a tampered cursor", async () => {
  const db = newDb();
  const env = baseEnv(db);
  seedRelease(db, { releaseId: "assets-1077100", assetVersion: "1077100", bundles: [{ kind: "text", name: "b", entries: [{ item_key: "k", source: "s", source_sha256: sha256Hex("s") }] }] });
  const unregistered = await worker.fetch(new Request("https://portal.example.test/api/catalogue/search?asset_version=9999999"), env);
  assert.equal(unregistered.status, 400);
  assert.equal((await unregistered.json()).error, "unregistered_asset_version");

  const badCursor = await worker.fetch(new Request("https://portal.example.test/api/catalogue/search?release_id=assets-1077100&cursor=not-a-cursor"), env);
  assert.equal(badCursor.status, 200, "an unreadable cursor degrades to the first page");
});

await test("release item pages use keyset paging and never return the source blob", async () => {
  const db = newDb();
  const env = baseEnv(db);
  const entries = Array.from({ length: 30 }, (_, i) => ({ item_key: `i${String(i).padStart(3, "0")}`, source: `長い原文テキスト ${i}`.repeat(20), source_sha256: sha256Hex(`長い原文テキスト ${i}`.repeat(20)) }));
  seedRelease(db, { releaseId: "assets-1077100", assetVersion: "1077100", bundles: [{ kind: "text", name: "bundle-big", entries }] });
  db.resetCounters();

  const response = await worker.fetch(new Request("https://portal.example.test/api/assets/releases/1077100/items?limit=10"), env);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.items.length, 10);
  assert.ok(body.next_cursor);
  assert.equal(body.items[0].source, undefined, "list pages must not carry the source text");
  assert.equal(db.offsets.length, 0);
  assert.ok(db.rowsRead <= 30, `one page should read ~limit rows, read ${db.rowsRead}`);

  const detail = await worker.fetch(new Request("https://portal.example.test/api/assets/releases/1077100/item?bundle=bundle-big&item_key=i000"), env);
  assert.equal(detail.status, 200);
  const detailBody = await detail.json();
  assert.ok(detailBody.item.source, "the single-item route carries the source text");
  assert.ok(Array.isArray(detailBody.other_release_variants));
  assert.match(detailBody.reuse_rule, /source_sha256/);
});

await test("client and assets release lists are independent and never merge", async () => {
  const db = newDb();
  const env = baseEnv(db);
  seedRelease(db, { releaseId: "assets-1077100", assetVersion: "1077100", bundles: [] });
  seedRelease(db, { releaseKind: "client", releaseId: "client-9.0.200-arm64-v8a", assetVersion: "9.0.200", bundles: [] });
  const assets = await (await worker.fetch(new Request("https://portal.example.test/api/assets/releases"), env)).json();
  const clients = await (await worker.fetch(new Request("https://portal.example.test/api/client/releases"), env)).json();
  assert.deepEqual(assets.releases.map((r) => r.release_id), ["assets-1077100"]);
  assert.deepEqual(clients.releases.map((r) => r.release_id), ["client-9.0.200-arm64-v8a"]);
  assert.equal(assets.releases[0].client_version, undefined);
  assert.equal(clients.releases[0].asset_version, undefined);
});

await test("image tasks come from D1 with a keyset cursor and overrides on top", async () => {
  const db = newDb();
  const env = baseEnv(db);
  const insert = db.db.prepare(
    `INSERT INTO image_task_units (task_id, bundle, category, width, height, image_format, has_alpha, r2_key, source_sha256, created_at, updated_at) ` +
    `VALUES (?, ?, ?, 969, 726, 'png', 1, ?, ?, '2026-09-28T00:00:00Z', '2026-09-28T00:00:00Z')`
  );
  for (let i = 0; i < 30; i += 1) {
    insert.run(`img_task_${String(i).padStart(3, "0")}`, "banner_bundle", i % 2 ? "costume" : "event", `images/composite/img_task_${i}/source-composite.png`, "0".repeat(64));
  }
  db.db.prepare(
    `INSERT INTO image_status_overrides (task_id, status, actor_email, updated_at) VALUES ('img_task_000','not_needed','reviewer@example.test','2026-09-28T00:00:00Z')`
  ).run();
  // The category totals are a derived summary row written by the importer, not
  // an aggregate the request path runs.
  db.db.prepare(
    `INSERT OR REPLACE INTO portal_summary (key, value_json, updated_at) VALUES ('image_categories', ?, '2026-09-28T00:00:00Z')`
  ).run(JSON.stringify({ all: 30, event: 15, costume: 15 }));

  const first = await (await worker.fetch(new Request("https://portal.example.test/api/images/tasks?pageSize=10"), env)).json();
  assert.equal(first.tasks.length, 10);
  assert.ok(first.next_cursor);
  assert.equal(first.categories.event, 15);
  assert.equal(first.categories.costume, 15);
  assert.equal(first.tasks.find((t) => t.task_id === "img_task_000").status, "not_needed");

  const second = await (await worker.fetch(new Request(`https://portal.example.test/api/images/tasks?pageSize=10&cursor=${encodeURIComponent(first.next_cursor)}`), env)).json();
  assert.notEqual(second.tasks[0].task_id, first.tasks[0].task_id);

  const detail = await (await worker.fetch(new Request("https://portal.example.test/api/images/task?id=img_task_000"), env)).json();
  assert.equal(detail.task.status, "not_needed");
  assert.equal(detail.task.has_alpha, true);
});

// ---------------------------------------------------------------------------
// The retired submission route
//
// This section used to drive the R2 buffer that caught a contribution when the
// D1 write budget was spent. Both are gone: the portal no longer writes
// translations into D1, so there is nothing to buffer, and `/api/contributions`
// is 410. The write-quota behaviour that *does* remain — the sync consumer
// degrading rather than corrupting — is covered above, where it belongs.
// ---------------------------------------------------------------------------

await test("the retired contribution route is 410 even while the D1 writer is exhausted", async () => {
  const db = newDb();
  const env = baseEnv(db);
  seedRelease(db, { releaseId: "assets-1077100", assetVersion: "1077100", bundles: [{ kind: "text", name: "bundle-a", entries: [{ item_key: "k", source: SOURCE, source_sha256: SOURCE_SHA }] }] });
  db.writeBudget = 0;
  const response = await worker.fetch(new Request("https://portal.example.test/api/contributions", {
    method: "POST",
    headers: { "content-type": "application/json", "Cf-Access-Authenticated-User-Email": "contributor@example.test" },
    body: JSON.stringify({ asset_version: "1077100", bundle: "bundle-a", key: "k", source: SOURCE, translation: "早上好！", source_sha256: SOURCE_SHA }),
  }), env);
  assert.equal(response.status, 410, "the old submission route must be gone, not merely spent");
  const body = await response.json();
  assert.equal(body.error, "gone");
  assert.equal(body.replaced_by, "/api/contributions/github-pr");
  assert.equal(env.PUBLICATION_BUCKET.objects.size, 0, "no retired route may write a buffer object");
  assert.equal(db.db.prepare(`SELECT COUNT(*) AS n FROM contributions`).get().n, 0, "no retired route may write a contribution row");
});

await test("generated-only paths are explicitly excluded from translation ingest", () => {
  for (const path of ["generated/1077100/manifest.json", "generated/1077500/checksums.txt", "generated/objects/sha256/aa/" + "a".repeat(64)]) {
    const rule = classifyPath(path);
    assert.equal(rule.ingestible, false);
    assert.equal(rule.reason, "generated_artifact_only");
  }
});

console.log(`sync pipeline ${failures === 0 ? "PASS" : "FAIL"} (${checks} checks, ${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);
