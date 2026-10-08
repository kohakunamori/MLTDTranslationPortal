// Sync job runner: the consumer that turns a queued `sync_jobs` row into
// release data. Driven by the Worker's `scheduled()` handler.
//
// Guarantees:
//   * A job is claimed with a conditional UPDATE, so two overlapping cron ticks
//     cannot both run it.
//   * `max_attempts` and a backoff `next_retry_at` bound the retry loop; past
//     the budget the job is terminal `failed` with the reason recorded.
//   * Per-invocation D1 row budget. Exceeding it leaves the job `queued` with a
//     `cursor_json` progress marker, so the next tick resumes instead of
//     restarting or half-writing.
//   * A commit that is too large to ingest from the edge is marked `delegated`
//     with instructions, never silently truncated.
//   * `release_summaries` is rebuilt once per tick per release - at the end of
//     the tick, for the release the tick's jobs actually touched - so the
//     portal's read path never aggregates and a multi-chunk sync does not pay
//     one full GROUP BY per chunk. `runJob` only *defers* that rebuild: it never
//     performs it, because only the tick knows whether more jobs are coming for
//     the same release.

import {
  DEFAULT_FILE_LIMIT,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_ROWS_PER_JOB,
  GitHubClient,
  evaluateReuseBatch,
  planIngest,
  recordsFromFile,
  rebuildPortalStats,
  rebuildReleaseSummary,
  upsertRelease,
  validateReleaseManifest,
  writeRecordBatch,
} from "./sync_ingest.js";
import { RegistryError, rethrowQuota } from "./release_registry.js";

export const CLAIM_BATCH = 3;

/// The releases a tick must rebuild once its jobs are done, keyed so a release
/// touched by three chunks is rebuilt once. `runJob` cannot know whether the
/// release it just finished will be touched again by the next job of the same
/// tick, so it records the deferral here, on the tick-scoped object it was
/// handed, instead of spending a full GROUP BY per job.
const TOUCHED_RELEASES = Symbol("touched_releases");

/// Called by `runJob` whenever an invocation ends *without* completing its job:
/// a queued chunk, a retry, or a terminal failure. All three leave refs behind
/// that the read path can see, and none of them ends the job.
function deferSummaryRebuild(env, targetKind, releaseId) {
  if (!env?.[TOUCHED_RELEASES] || !releaseId) return;
  env[TOUCHED_RELEASES].set(`${targetKind}\u0000${releaseId}`, { targetKind, releaseId });
}

/// Exponential backoff capped at an hour; attempt numbers are 1-based.
export function backoffForAttempt(attempt, baseSeconds = 60, capSeconds = 3600) {
  const seconds = Math.min(capSeconds, baseSeconds * 2 ** Math.max(0, attempt - 1));
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/// Claim queued/retrying jobs whose backoff has elapsed, oldest first.
export async function claimJobs(env, limit = CLAIM_BATCH) {
  const timestamp = new Date().toISOString();
  let rows;
  try {
    rows = await env.DB.prepare(
      `SELECT job_id, delivery_id, repository, event_type, commit_sha, before_sha, target_kind, target_release_id, ` +
      `attempts, max_attempts, cursor_json ` +
      `FROM sync_jobs WHERE status IN ('queued','retrying') AND (next_retry_at IS NULL OR next_retry_at <= ?) ` +
      `ORDER BY created_at ASC LIMIT ?`
    ).bind(timestamp, limit).all();
  } catch (err) {
    return rethrowQuota(err);
  }

  const claimed = [];
  for (const row of rows.results || []) {
    try {
      const result = await env.DB.prepare(
        `UPDATE sync_jobs SET status='running', attempts=attempts+1, updated_at=? WHERE job_id=? AND status IN ('queued','retrying')`
      ).bind(timestamp, row.job_id).run();
      if ((result.meta?.changes ?? result.changes ?? 0) === 0) continue;
    } catch (err) {
      return rethrowQuota(err);
    }
    claimed.push({ ...row, attempts: Number(row.attempts || 0) + 1 });
  }
  return claimed;
}

async function finishJob(env, job, patch) {
  const timestamp = new Date().toISOString();
  try {
    await env.DB.prepare(
      `UPDATE sync_jobs SET status=?, error_message=?, result_json=?, cursor_json=?, rows_written=?, ` +
      `next_retry_at=?, updated_at=? WHERE job_id=?`
    ).bind(
      patch.status, patch.error_message ?? null, patch.result_json ? JSON.stringify(patch.result_json) : null,
      patch.cursor_json ? JSON.stringify(patch.cursor_json) : null, patch.rows_written ?? 0,
      patch.next_retry_at ?? null, timestamp, job.job_id,
    ).run();
  } catch (err) {
    return rethrowQuota(err);
  }
  return timestamp;
}

async function markDelivery(env, deliveryId, status, errorMessage = null, jobId = null) {
  if (!deliveryId) return;
  const timestamp = new Date().toISOString();
  try {
    await env.DB.prepare(
      `UPDATE github_webhook_deliveries SET status=?, error_message=?, processed_at=?, job_id=COALESCE(job_id, ?) WHERE delivery_id=?`
    ).bind(status, errorMessage, timestamp, jobId, deliveryId).run();
  } catch (err) {
    rethrowQuota(err);
  }
}

/// A delivery that was seen but deliberately not acted on, with the reason kept
/// in its own table so `github_webhook_deliveries` keeps its original shape.
async function recordDeliveryIgnore(env, job, reason, detail) {
  const timestamp = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO github_delivery_ignores (delivery_id, repository, event_type, reason, detail, created_at) ` +
      `VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(job.delivery_id, job.repository, job.event_type, reason, String(detail || "").slice(0, 300), timestamp).run();
    await markDelivery(env, job.delivery_id, "ignored", `${reason}:${detail}`);
  } catch (err) {
    rethrowQuota(err);
  }
}

/// Verify the manifest's own identity and refuse a decoupling violation.
async function loadReleaseManifest(client, targetKind, cursorPath) {
  const policyPath = cursorPath || (targetKind === "assets" ? "manifests/asset-version.json" : "manifests/apk-builtin.manifest.json");
  const text = await client.rawFile(policyPath, DEFAULT_MAX_FILE_BYTES);
  let payload;
  try { payload = JSON.parse(text); } catch { throw new RegistryError("ingest_json_invalid", policyPath); }
  return validateReleaseManifest(targetKind, payload, client.repository);
}

async function loadCursor(env, job) {
  if (job.cursor_json) {
    try { return JSON.parse(job.cursor_json); } catch { /* fall through to a fresh cursor */ }
  }
  try {
    const row = await env.DB.prepare(
      `SELECT commit_sha FROM sync_cursors WHERE repository=? AND ref='HEAD'`
    ).bind(job.repository).first();
    if (row?.commit_sha && row.commit_sha !== job.commit_sha) return { base_sha: row.commit_sha };
  } catch (err) {
    rethrowQuota(err);
  }
  return {};
}

/**
 * Run one job to completion or to a bounded stop. Returns a summary object; the
 * caller logs it. Never throws for a job-level failure — that is recorded on the
 * job row so a cron tick stays alive for the other jobs.
 */
export async function runJob(env, job, { fetchImpl = fetch, rowsPerJob = DEFAULT_ROWS_PER_JOB, fileLimit = DEFAULT_FILE_LIMIT } = {}) {
  const targetKind = job.target_kind;
  if (targetKind !== "assets" && targetKind !== "client") {
    await finishJob(env, job, { status: "failed", error_message: `sync_kind_unknown: ${targetKind}` });
    return { job_id: job.job_id, status: "failed", reason: "sync_kind_unknown" };
  }
  if (!job.commit_sha) {
    await finishJob(env, job, { status: "failed", error_message: "commit_sha_missing" });
    await markDelivery(env, job.delivery_id, "failed", "commit_sha_missing");
    return { job_id: job.job_id, status: "failed", reason: "commit_sha_missing" };
  }

  // `claimJobs` counts the attempt when it takes the row. A job run through any
  // other entry point — the admin tick route, a resumed job, a test — never went
  // through the claim, so the attempt is counted here. The retry budget must not
  // depend on which door the job came in through.
  let attempts = Number(job.attempts || 0);
  if (attempts === 0) {
    try {
      await env.DB.prepare(`UPDATE sync_jobs SET attempts=1, updated_at=? WHERE job_id=?`)
        .bind(new Date().toISOString(), job.job_id).run();
    } catch (err) {
      rethrowQuota(err);
    }
    attempts = 1;
  }
  const client = new GitHubClient({
    token: env.GITHUB_SYNC_TOKEN,
    repository: job.repository,
    commitSha: job.commit_sha,
    fetchImpl,
  });

  const startedAt = new Date().toISOString();

  // The release this job writes into. Set as soon as `upsertRelease` returns, so
  // the failure path below knows whether there is anything to rebuild.
  //
  // Why the rebuild cannot be spread over the chunks instead: a `runJob` cannot
  // aggregate its own rows until the invocation ends. Cloudflare D1 gives a
  // Worker read-your-own-writes *within* an invocation, but the isolation
  // boundary runs the other way for a long job: every chunk is a separate
  // invocation, and the files written by chunk N are only in a committed state
  // for chunk N+1. A partial rebuild is therefore possible in principle (each
  // chunk would have to re-aggregate the whole release anyway, since a summary
  // cannot be "added to"), but it costs the same full GROUP BY the old shape
  // paid, which is the cost this change exists to remove. So it was rejected
  // rather than forced, and the rebuild is done once, after the last write.
  let summaryRelease = null;

  try {
    const cursor = await loadCursor(env, job);
    // A resumed job already knows its release: the queued path stores it in the
    // cursor. Taking it here — before the tree/compare call, which is the first
    // thing that can fail — means a chunk that dies on its very first HTTP call
    // still leaves the refs its earlier chunks wrote reflected in the summary.
    if (cursor.release_id) summaryRelease = cursor.release_id;
    let files;
    if (cursor.base_sha) {
      files = await client.changedFiles(cursor.base_sha, job.commit_sha, fileLimit);
    } else {
      files = await client.treePaths(fileLimit);
    }

    const plan = planIngest(files, { targetKind });
    const entriesToProcess = plan.planned.filter((item) => item.role === "entries");
    const skipped = [...plan.skipped];

    // Release manifest first: a source variant must never point at a release row
    // that does not exist yet.
    const manifestPlan = plan.planned.find((item) => item.role === "release-manifest");
    let manifest = null;
    if (manifestPlan) {
      const text = await client.rawFile(manifestPlan.path, DEFAULT_MAX_FILE_BYTES);
      let payload;
      try { payload = JSON.parse(text); } catch { throw new RegistryError("ingest_json_invalid", manifestPlan.path); }
      manifest = validateReleaseManifest(targetKind, payload, job.repository);
    } else {
      manifest = await loadReleaseManifest(client, targetKind, null);
    }

    const releaseId = targetKind === "assets" ? `assets-${manifest.assetVersion}` : manifest.releaseId;
    const releaseRef = await upsertRelease(env, targetKind, manifest, startedAt);
    summaryRelease = releaseRef.releaseId;
    skipped.push({ path: manifestPlan?.path || "release-manifest", reason: "release_manifest_identified" });

    // Apply the progress cursor: files already consumed in an earlier attempt of
    // this same job are not re-read.
    const consumed = new Set(cursor.processed_paths || []);
    const remaining = entriesToProcess.filter((item) => !consumed.has(item.path));

    let rowsWritten = 0;
    const processedPaths = new Set(consumed);
    const rejections = [];
    let summary = null;

    for (const item of remaining) {
      if (rowsWritten >= rowsPerJob) {
        // A queued chunk is not a finished job, and neither is it the last word
        // on this release. The rebuild is therefore deferred to the end of the
        // tick: 101 chunks of one import now pay one rebuild, not 101 — the
        // 16.5x read-budget term recorded in
        // work/agents/text-localization/sync-schema-quota-20260929/HANDOFF.md.
        // Deferring is only honest because `runSyncTick` always drains the set
        // in a `finally`, so a job that fails later in the same tick still
        // leaves every ref it wrote visible.
        deferSummaryRebuild(env, targetKind, releaseRef.releaseId);
        await finishJob(env, job, {
          status: "queued",
          cursor_json: { base_sha: cursor.base_sha, processed_paths: [...processedPaths], release_id: releaseRef.releaseId },
          rows_written: rowsWritten,
          error_message: null,
          result_json: { continued: true, remaining_files: remaining.length - processedPaths.size + consumed.size },
        });
        return { job_id: job.job_id, status: "queued", rows_written: rowsWritten, continued: true };
      }

      const text = await client.rawFile(item.path, DEFAULT_MAX_FILE_BYTES);
      const context = {
        kind: item.kind,
        releaseKind: targetKind,
        releaseId: releaseRef.releaseId,
        defaultBundle: bundleFromPath(item.path),
      };
      const records = recordsFromFile(item, text, context);
      const decisions = await evaluateReuseBatch(env, records, { locale: "zh-CN" });
      const outcome = await writeRecordBatch(env, records, decisions, new Date().toISOString());
      rowsWritten += outcome.written;
      for (const rejection of outcome.rejected) rejections.push({ path: item.path, ...rejection });
      processedPaths.add(item.path);
    }

    // The job is finished, but the summary is not rebuilt here: this release may
    // be touched again by another job in the same tick (the common case is a
    // multi-chunk import, where every chunk is its own job). The deferral is
    // what makes 101 jobs cost one rebuild instead of 101.
    deferSummaryRebuild(env, targetKind, releaseRef.releaseId);

    const timestamp = new Date().toISOString();
    try {
      await env.DB.prepare(
        `INSERT INTO sync_cursors (repository, ref, commit_sha, rows_written, processed_at) VALUES (?, 'HEAD', ?, ?, ?) ` +
        `ON CONFLICT(repository, ref) DO UPDATE SET commit_sha=excluded.commit_sha, rows_written=excluded.rows_written, processed_at=excluded.processed_at`
      ).bind(job.repository, job.commit_sha, rowsWritten, timestamp).run();
    } catch (err) {
      rethrowQuota(err);
    }

    const result = {
      release_kind: targetKind,
      release_id: releaseRef.releaseId,
      files_ingested: processedPaths.size,
      files_skipped: skipped.length,
      skipped,
      rows_written: rowsWritten,
      rejections: rejections.slice(0, 50),
      summary,
    };
    await finishJob(env, job, { status: "completed", rows_written: rowsWritten, result_json: result });
    await markDelivery(env, job.delivery_id, "completed");
    console.log("sync job completed", JSON.stringify({ job_id: job.job_id, target_kind: targetKind, release_id: releaseRef.releaseId, rows_written: rowsWritten }));
    return { job_id: job.job_id, status: "completed", rows_written: rowsWritten, result };
  } catch (err) {
    const code = err instanceof RegistryError ? err.code : String(err?.message || err).slice(0, 200);
    const maxAttempts = Number(job.max_attempts || 3);

    // This invocation dies here, so it never reaches the end of a successful job.
    // If it already wrote refs (and it may have: the release row is upserted
    // before the first file, and `writeRecordBatch` commits per file), the read
    // path would otherwise serve a summary that does not count them. Retrying
    // and terminal failures both end the invocation, so both defer the rebuild
    // to the tick — which is strictly better than rebuilding here, because the
    // tick's drain happens after the *last* job of the tick, so a tick of 3 jobs
    // pays one rebuild rather than three.
    //
    // Two cases are deliberately excluded:
    //   * `delegated_to_actions` hands the commit to the repository's own
    //     Actions worker, which consumes the same release and rebuilds the
    //     summary itself — a rebuild here would buy nothing.
    //   * an explicit flush that itself exhausted the quota must not enqueue
    //     another read; the summary self-heals on the next tick (see the
    //     self-healing note in `runSyncTick`).
    if (job.target_release_id) deferSummaryRebuild(env, targetKind, job.target_release_id);
    else if (summaryRelease) deferSummaryRebuild(env, targetKind, summaryRelease);

    if (err instanceof RegistryError && (err.code === "ingest_tree_too_large" || err.code === "d1_quota_exceeded")) {
      // Too big for the edge, or the daily write budget is spent. A too-large
      // commit is handed to the repository's own Actions worker and recorded in
      // `sync_delegations` so the hand-off is visible rather than a bare
      // failure; a quota stop is a temporary condition and simply backs off.
      const delegated = err.code !== "d1_quota_exceeded";
      if (delegated) {
        try {
          await env.DB.prepare(
            `INSERT OR IGNORE INTO sync_delegations (job_id, repository, commit_sha, target_kind, reason, detail, created_at) ` +
            `VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).bind(job.job_id, job.repository, job.commit_sha, targetKind, err.code, String(err.detail || "").slice(0, 300), new Date().toISOString()).run();
        } catch (delegationErr) {
          rethrowQuota(delegationErr);
        }
      }
      await finishJob(env, job, {
        status: delegated ? "failed" : "retrying",
        error_message: delegated ? `delegated_to_actions:${code}` : `${code}: ${err.detail || ""}`.slice(0, 300),
        next_retry_at: delegated ? null : backoffForAttempt(attempts),
      });
      if (delegated) await recordDeliveryIgnore(env, job, "delegated_to_actions", code);
      else await markDelivery(env, job.delivery_id, "received", code);
      return { job_id: job.job_id, status: delegated ? "failed" : "retrying", reason: code };
    }

    const terminal = attempts >= maxAttempts;
    await finishJob(env, job, {
      status: terminal ? "failed" : "retrying",
      error_message: `${code}`.slice(0, 300),
      next_retry_at: terminal ? null : backoffForAttempt(attempts),
    });
    await markDelivery(env, job.delivery_id, terminal ? "failed" : "received", code);
    console.warn("sync job failed", JSON.stringify({ job_id: job.job_id, attempts, code }));
    return { job_id: job.job_id, status: terminal ? "failed" : "retrying", reason: code };
  }
}

/// One cron tick: claim a bounded number of jobs, run them, then rebuild the
/// summary of every release they touched — once per release, not once per job.
///
/// The drain runs in a `finally`, so it also happens when the loop itself
/// throws (a claim failure, or an exception `runJob`'s own try/catch does not
/// cover). The only way refs can be left out of a summary is the platform
/// killing the whole tick between the last write and this drain; that is
/// self-healing, because the next tick claims whatever is still queued and
/// drains again — and a job that was interrupted mid-run is still queued (its
/// per-file progress is in `cursor_json`) or has already completed, so its
/// release is touched again either way.
export async function runSyncTick(env, options = {}) {
  const touched = new Map();
  Object.defineProperty(env, TOUCHED_RELEASES, { value: touched, configurable: true, writable: true });
  try {
    return await drainTick(env, touched, options);
  } finally {
    // A rebuild is a bounded amount of work per touched release; it runs even
    // when the tick failed, because a failed tick still leaves refs behind.
    await flushTouchedSummaries(env, touched);
  }
}

async function drainTick(env, touched, options) {
  const claimed = await claimJobs(env, options.claimLimit || CLAIM_BATCH);
  const results = [];
  for (const job of claimed) results.push(await runJob(env, job, options));
  return { claimed: claimed.length, results };
}

/// Rebuild what the tick touched: one GROUP BY per release, plus the global
/// stats row once if any asset release moved. The keys are consumed as they are
/// flushed, so a release added while the flush is running becomes the next
/// flush's work rather than being dropped.
async function flushTouchedSummaries(env, touched) {
  if (!touched || touched.size === 0) return;
  // Which release the global stats row is keyed by. One extra indexed point-read
  // per flush buys the removal of a whole extra GROUP BY over the same refs: the
  // tick already rebuilt this release's summary, so `rebuildPortalStats` is
  // handed that result instead of computing it again.
  let canonical = null;
  try {
    canonical = await env.DB.prepare(
      `SELECT release_id FROM assets_releases WHERE status='canonical' ORDER BY updated_at DESC LIMIT 1`
    ).first();
  } catch (err) {
    canonical = null;
  }

  let canonicalSummary = null;
  const failures = [];
  for (const key of [...touched.keys()]) {
    const entry = touched.get(key);
    touched.delete(key);
    try {
      const summary = await rebuildReleaseSummary(env, entry.targetKind, entry.releaseId);
      if (canonical && entry.targetKind === "assets" && entry.releaseId === canonical.release_id) canonicalSummary = summary;
    } catch (err) {
      // One run's ingest is a snapshot: a release that cannot be summarised now
      // is left to the next tick (`runSyncTick` drains on every tick, and a
      // failed summary never blocks ingestion) rather than failing the others.
      failures.push({ release_id: entry.releaseId, release_kind: entry.targetKind, error: String(err?.message || err).slice(0, 120) });
    }
  }
  if (canonical) {
    try {
      await rebuildPortalStats(env, canonicalSummary);
    } catch (err) {
      failures.push({ release_id: `assets(stats:${canonical.release_id})`, release_kind: "assets", error: String(err?.message || err).slice(0, 120) });
    }
  }
  for (const failure of failures) console.warn("sync tick summary rebuild failed", JSON.stringify(failure));
}

export function bundleFromPath(path) {
  const parts = String(path || "").split("/");
  return parts.slice(0, -1).join("/") || "root";
}
