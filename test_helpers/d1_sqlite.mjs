// A real-SQLite D1 emulation for tests.
//
// The previous harness hand-wrote a JavaScript object that answered each SQL
// string by pattern-matching. That cannot fail when the SQL is wrong: an
// unhandled query shape just raised "unhandled SQL", and a query that was
// accidentally a full scan still looked fine because there was no planner. This
// shim runs the actual DDL from `schema.sql` + `migrations/` against
// `node:sqlite`, so the production SQL is exercised for real, and it records
// planner output so a test can assert *how* a query was answered.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/// Split SQL on semicolons that are not inside a string literal, an identifier
/// literal or a comment. Mirrors split_statements() in
/// scripts/bootstrap_portal_d1.py; the two must agree on every file in
/// migrations/, which scripts/test_portal_schema.py checks.
export function splitStatements(sql) {
  const statements = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    if (inLineComment) {
      if (char === "\n") { inLineComment = false; current += char; }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") { inBlockComment = false; index += 1; continue; }
      continue;
    }
    if (inSingle) {
      current += char;
      if (char === "'") {
        if (next === "'") { current += next; index += 1; continue; }
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      current += char;
      if (char === '"') inDouble = false;
      continue;
    }
    if (char === "-" && next === "-") { inLineComment = true; index += 1; continue; }
    if (char === "/" && next === "*") { inBlockComment = true; index += 1; continue; }
    if (char === "'") { inSingle = true; current += char; continue; }
    if (char === '"') { inDouble = true; current += char; continue; }
    if (char === ";") {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = "";
      continue;
    }
    current += char;
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

const UNREPLAYABLE_ALTER = /^ALTER\s+TABLE\s+(\S+)\s+ADD\s+COLUMN\s+(\S+)/i;

export class SqliteD1 {
  constructor({ portalDir, file = ":memory:", readBudget = null, writeBudget = null } = {}) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.portalDir = portalDir;
    this.rowsRead = 0;
    this.rowsWritten = 0;
    this.queries = 0;
    this.readBudget = readBudget;
    this.writeBudget = writeBudget;
    this.log = [];
    this.scans = [];
    this.offsets = [];
    this.aggregates = [];
    this.appliedMigrations = [];
    this.seededReplaySafe = false;
  }

  // -- schema ---------------------------------------------------------------

  /// Apply schema.sql then every migrations/*.sql, skipping the un-replayable
  /// ALTERs whose columns already exist. This is the same rule the Python
  /// bootstrap applies, so a green test here is evidence for both paths.
  applySchema() {
    const files = [path.join(this.portalDir, "schema.sql")];
    const migrationsDir = path.join(this.portalDir, "migrations");
    for (const name of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
      files.push(path.join(migrationsDir, name));
    }
    for (const file of files) {
      this.applyFile(file);
      this.appliedMigrations.push(path.basename(file));
    }
    return this.appliedMigrations;
  }

  applyFile(file) {
    const sql = fs.readFileSync(file, "utf8");
    for (const statement of splitStatements(sql)) {
      const alter = statement.match(UNREPLAYABLE_ALTER);
      if (alter && this.columnExists(alter[1], alter[2])) continue;
      this.db.exec(statement);
    }
  }

  columnExists(table, column) {
    try {
      return this.db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
    } catch {
      return false;
    }
  }

  tableExists(table) {
    return Boolean(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
  }

  // -- D1 surface -----------------------------------------------------------

  prepare(sql) {
    return new SqliteStatement(this, sql);
  }

  async batch(statements) {
    const out = [];
    for (const statement of statements) out.push(await statement.run());
    return out;
  }

  /// `first`/`all`/`run` are the only entry points, so instrumentation and quota
  /// accounting live here in one place.
  async _all(sql, args) {
    this._beforeQuery(sql, args);
    const rows = this.db.prepare(sql).all(...args);
    this.rowsRead += rows.length;
    return { results: rows, meta: this._meta() };
  }

  async _first(sql, args) {
    this._beforeQuery(sql, args);
    const row = this.db.prepare(sql).get(...args);
    this.rowsRead += row ? 1 : 0;
    return row === undefined ? null : row;
  }

  async _run(sql, args) {
    this._beforeWrite(sql);
    const result = this.db.prepare(sql).run(...args);
    const changed = Number(result.changes || 0);
    this.rowsWritten += changed;
    return { success: true, meta: { changes: changed, rows_written: changed }, changes: changed };
  }

  _beforeQuery(sql) {
    this.queries += 1;
    if (this.readBudget !== null && this.rowsRead >= this.readBudget) {
      throw new Error("D1_ERROR: Exceeded maximum rows read (1000) for the day");
    }
    this._inspect(sql);
  }

  /// Budget checks fire on entry, before the query, so a budget of N still
  /// permits exactly N rows: a test can then assert the difference between "a
  /// handful of rows" and "a full scan" without the off-by-one of a
  /// post-query check.
  _beforeWrite(sql) {
    this.queries += 1;
    if (this.writeBudget !== null && this.rowsWritten >= this.writeBudget) {
      throw new Error("D1_ERROR: Exceeded maximum rows written (100000) for the day");
    }
  }

  /// Record the planner's answer for this query. `SCAN <table>` means the whole
  /// table was walked; `SEARCH <table> USING INDEX` means an index was used.
  _inspect(sql) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    const upper = normalized.toUpperCase();
    let plan = [];
    try {
      plan = this.db.prepare(`EXPLAIN QUERY PLAN ${normalized}`).all().map((row) => String(row.detail));
    } catch {
      plan = ["<unplannable>"];
    }
    const scans = plan.filter((detail) => /^SCAN\b/.test(detail));
    if (scans.length) this.scans.push({ sql: normalized.slice(0, 160), plan: scans });
    if (/\bOFFSET\b/.test(upper)) this.offsets.push(normalized.slice(0, 160));
    if (/COUNT\s*\(/.test(upper) || /GROUP BY/.test(upper)) {
      this.aggregates.push({ sql: normalized.slice(0, 160), scans });
    }
    this.log.push(normalized.slice(0, 200));
    return plan;
  }

  _meta() {
    return { rows_read: this.rowsRead, rows_written: this.rowsWritten };
  }

  resetCounters() {
    this.rowsRead = 0;
    this.rowsWritten = 0;
    this.queries = 0;
    this.log = [];
    this.scans = [];
    this.offsets = [];
    this.aggregates = [];
  }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }
}

class SqliteStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql.replace(/\s+/g, " ").trim();
    this.args = [];
  }

  bind(...args) { this.args = args.map((value) => (value === undefined ? null : value)); return this; }
  async first() { return this.db._first(this.sql, this.args); }
  async all() { return this.db._all(this.sql, this.args); }
  async run() { return this.db._run(this.sql, this.args); }
}

export class MemoryR2 {
  constructor() { this.objects = new Map(); this.deleted = []; }
  async put(key, value, options) { this.objects.set(key, { value, options }); }
  async get(key) { return this.objects.get(key) || null; }
  async delete(key) { this.deleted.push(key); this.objects.delete(key); }
  async list({ prefix = "", cursor = "", limit = 1000 } = {}) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    const start = cursor ? keys.indexOf(cursor) + 1 : 0;
    const page = keys.slice(start, start + limit);
    const truncated = start + limit < keys.length;
    return { objects: page.map((key) => ({ key })), truncated, cursor: truncated ? page[page.length - 1] : "" };
  }
}

/// Seed the portal database with a small, deterministic catalogue in the
/// post-decoupling shape: `resource_units` + `source_variants` +
/// `release_resource_refs`, reached through a registered release.
export function seedRelease(db, {
  releaseKind = "assets",
  releaseId = "assets-1077100",
  assetVersion = "1077100",
  bundles = [],
  locale = "zh-CN",
} = {}) {
  const timestamp = new Date("2026-09-28T00:00:00Z").toISOString();
  if (releaseKind === "assets") {
    db.db.prepare(
      `INSERT OR REPLACE INTO assets_releases (asset_version, release_id, server_schema_version, status, source_manifest_sha256, assets_commit, note, created_at, updated_at, published_at) ` +
      `VALUES (?, ?, 'v1', 'canonical', NULL, NULL, 'test seed', ?, ?, ?)`
    ).run(assetVersion, releaseId, timestamp, timestamp, timestamp);
  } else {
    db.db.prepare(
      `INSERT OR REPLACE INTO client_releases (release_id, client_version, abi, base_apk_sha256, client_resources_commit, manifest_sha256, output_apk_sha256, release_url, status, created_at, published_at) ` +
      `VALUES (?, ?, 'arm64-v8a', ?, ?, NULL, NULL, NULL, 'candidate', ?, NULL)`
    ).run(releaseId, String(assetVersion), "0".repeat(64), "1".repeat(40), timestamp);
  }

  for (const bundle of bundles) {
    for (const entry of bundle.entries) {
      const logicalKey = `${bundle.kind}/${String(bundle.name).replace(/\.(gtx|unity3d)$/i, "")}/${entry.item_key}`;
      const resId = `res:${bundle.kind}:${logicalKey}`;
      const variantId = `sv:${releaseKind}:${releaseId}:${bundle.name}:${entry.item_key}`;
      const refId = `rrr:${releaseKind}:${releaseId}:${variantId}`;
      db.db.prepare(
        `INSERT OR IGNORE INTO resource_units (resource_id, resource_kind, logical_key, category, created_at) VALUES (?, ?, ?, ?, ?)`
      ).run(resId, bundle.kind, logicalKey, bundle.category || null, timestamp);
      db.db.prepare(
        `INSERT OR IGNORE INTO source_variants (source_variant_id, resource_id, release_kind, release_id, source_sha256, source, bundle, item_key, created_at) ` +
        `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(variantId, resId, releaseKind, releaseId, entry.source_sha256, entry.source, bundle.name, entry.item_key, timestamp);
      db.db.prepare(
        `INSERT OR IGNORE INTO release_resource_refs (id, release_kind, release_id, source_variant_id, translation_id, reuse_mode, reused_from_release_id, status, created_at, updated_at) ` +
        `VALUES (?, ?, ?, ?, NULL, 'none', NULL, ?, ?, ?)`
      ).run(refId, releaseKind, releaseId, variantId, entry.status || "untranslated", timestamp, timestamp);
      if (entry.translation) {
        const translationId = `tu:${bundle.kind}:${locale}:${logicalKey}:${entry.source_sha256}`;
        db.db.prepare(
          `INSERT OR IGNORE INTO translation_units (translation_id, logical_key, resource_kind, locale, source_sha256, translation, status, contributor_email, reviewer_email, created_at, updated_at) ` +
          `VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`
        ).run(translationId, logicalKey, bundle.kind, locale, entry.source_sha256, entry.translation, entry.translation_status || "accepted", timestamp, timestamp);
        db.db.prepare(
          `UPDATE release_resource_refs SET translation_id=?, reuse_mode=?, status=? WHERE id=?`
        ).run(translationId, entry.reuse_mode || "none", entry.status || "accepted", refId);
      }
    }
  }
  return db;
}

/// Recompute a release summary the way the sync runner does. Kept in the test
/// helper so a fixture can set up a summary without importing the worker.
///
/// The per-unit buckets are keyed by the category taxonomy and carry a
/// `bundles` map of `{slots, accepted}` — the same shape `rebuildReleaseSummary`
/// writes and the songs view reads. The keying is inlined rather than imported
/// from `src/categories.js` on purpose: if the production roll-up silently
/// changed shape, a suite that shared the helper would keep passing.
function categoryIdForBundle(bundle) {
  const b = String(bundle || "").toLowerCase();
  if (b.startsWith("scrobj_") || b.includes("lyric")) return "lyrics";
  if (b.startsWith("event_") && b.includes("chat")) return "event_chat";
  if (b.startsWith("event_") || (b.includes("story") && !b.startsWith("special_"))) return "event_story";
  if (b.startsWith("special_")) return "special_commu";
  if (b === "st_jp.gtx" || b.startsWith("st_")) return "main_commu";
  if (b.startsWith("card_episode_")) return "card_episode";
  if (b.startsWith("card_blst_")) return "card_blog";
  if (b === "cd_jp.gtx" || b.startsWith("cd_")) return "card_skill";
  if (b === "cm_jp.gtx" || b.startsWith("cm_")) return "theater_comm";
  if (b === "mb_jp.gtx" || b.startsWith("mb_")) return "message_board";
  if (b.startsWith("liveresult_")) return "live_result";
  if (b.startsWith("lbonus_")) return "login_bonus";
  if (b.startsWith("birth_bdl")) return "birth_live";
  if (b.startsWith("birth_ent") || b.startsWith("birth_")) return "birth_greet";
  return "system_ui";
}

export function writeSummary(db, releaseKind, releaseId) {
  const rows = db.db.prepare(
    `SELECT r.status, r.reuse_mode, sv.bundle, COUNT(*) AS count ` +
    `FROM release_resource_refs r JOIN source_variants sv ON sv.source_variant_id = r.source_variant_id ` +
    `WHERE r.release_kind=? AND r.release_id=? GROUP BY r.status, r.reuse_mode, sv.bundle`
  ).all(releaseKind, releaseId);
  const totals = { total: 0, translated: 0, pending: 0, untranslated: 0, reused: 0, suggested: 0, blocked: 0 };
  const categories = {};
  for (const row of rows) {
    const count = Number(row.count || 0);
    totals.total += count;
    if (row.status === "accepted") totals.translated += count;
    if (row.status === "pending" || row.status === "needs_review") totals.pending += count;
    if (row.status === "untranslated") totals.untranslated += count;
    if (row.status === "suggested") totals.suggested += count;
    if (row.status === "blocked") totals.blocked += count;
    if (row.reuse_mode === "exact" || row.reuse_mode === "verified-compatible") totals.reused += count;
    const key = categoryIdForBundle(row.bundle);
    const bucket = categories[key] || { total: 0, accepted: 0, pending: 0, suggested: 0, blocked: 0, progress_percent: 0, bundles: {} };
    bucket.total += count;
    if (row.status === "accepted") bucket.accepted += count;
    if (row.status === "pending" || row.status === "needs_review") bucket.pending += count;
    const entry = bucket.bundles[row.bundle] || (bucket.bundles[row.bundle] = { slots: 0, accepted: 0 });
    entry.slots += count;
    if (row.status === "accepted") entry.accepted += count;
    bucket.progress_percent = bucket.total > 0 ? Math.round((bucket.accepted / bucket.total) * 10000) / 100 : 0;
    categories[key] = bucket;
  }
  const timestamp = new Date().toISOString();
  db.db.prepare(
    `INSERT OR REPLACE INTO release_summaries (release_kind, release_id, total_items, translated_items, pending_items, untranslated_items, ` +
    `reused_items, suggested_items, blocked_items, category_summary_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(releaseKind, releaseId, totals.total, totals.translated, totals.pending, totals.untranslated,
    totals.reused, totals.suggested, totals.blocked, JSON.stringify(categories), timestamp);
  return totals;
}
