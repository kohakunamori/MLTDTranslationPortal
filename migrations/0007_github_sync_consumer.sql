-- Migration 0007: GitHub sync consumer state, reuse attestations, item indexes.
--
-- Statement classes used here, and why:
--
--   * CREATE TABLE / INDEX IF NOT EXISTS — replayable by construction.
--   * ALTER TABLE ... ADD COLUMN — cannot be replayed (a second run raises
--     "duplicate column name"). These are the statements that
--     scripts/bootstrap_portal_d1.py recognises by pattern and skips when the
--     column is already present, on both the fresh-database path (schema.sql
--     already has them) and the upgrade path (this file added them). Never run
--     this file twice by hand: apply it through the bootstrap script, which
--     records the file's SHA-256 in `schema_migrations` and refuses a re-run.
--
-- Deliberately NOT here: a copy-through-rebuild (CREATE v2 → INSERT SELECT →
-- DROP → RENAME) for an existing table. That pattern cannot be made replayable
-- in SQL — the second run drops the live table and renames an empty one over
-- it — so the new job fields are added additively instead, and the states that
-- would have needed a CHECK-constraint change are represented in dedicated
-- tables (see `sync_delegations`).

-- ---------------------------------------------------------------------------
-- 1. sync_jobs: progress cursor, replay-safe commit identity, bounded batches.
--    `attempts` / `max_attempts` / `next_retry_at` already exist.
--
--    The ALTERs below are why this file must be applied through
--    scripts/bootstrap_portal_d1.py, which records the file's SHA-256 and refuses
--    a second run. On a fresh database they are already satisfied by schema.sql
--    and the bootstrap script skips them by checking PRAGMA table_info. Do not
--    execute this file by hand twice: the second run stops at the first ALTER
--    with "duplicate column name" and leaves the rest of the file unapplied.
-- ---------------------------------------------------------------------------
ALTER TABLE sync_jobs ADD COLUMN before_sha TEXT;
ALTER TABLE sync_jobs ADD COLUMN cursor_json TEXT;
ALTER TABLE sync_jobs ADD COLUMN rows_written INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_jobs ADD COLUMN result_json TEXT;

CREATE INDEX IF NOT EXISTS idx_sync_jobs_queue
  ON sync_jobs (status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_repository
  ON sync_jobs (repository, target_kind, created_at);

-- Replay guard: at most one live-or-finished job per (repository, commit, kind).
-- A replayed commit therefore collides here and the webhook answers
-- `duplicate_commit_ignored` instead of enqueueing a second ingest.
-- `commit_sha IS NULL` rows (release events with no resolved commit) stay
-- distinct in SQLite, so they never collide with one another.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_jobs_commit_unique
  ON sync_jobs (repository, commit_sha, target_kind)
  WHERE status IN ('queued', 'running', 'completed', 'retrying');

-- ---------------------------------------------------------------------------
-- 1a. github_webhook_deliveries: the two facts the webhook wants to record that
--     its original shape has no column for — which git ref the delivery named,
--     and why a delivery was not acted on. `release_ref`/`ignored_reason` are
--     preferred over the legacy `release_id`/`error_message` columns because the
--     ref is a branch/tag name (not a release id) and "ignored" is not an error.
--
--     These are also why this file must be applied through
--     scripts/bootstrap_portal_d1.py: a second run stops at the first ALTER with
--     "duplicate column name". On a fresh database schema.sql already declares
--     them and the bootstrap skips them by checking PRAGMA table_info.
-- ---------------------------------------------------------------------------
ALTER TABLE github_webhook_deliveries ADD COLUMN release_ref TEXT;
ALTER TABLE github_webhook_deliveries ADD COLUMN ignored_reason TEXT;
ALTER TABLE github_webhook_deliveries ADD COLUMN job_id TEXT;

CREATE INDEX IF NOT EXISTS idx_gh_deliveries_repo
  ON github_webhook_deliveries (repository, created_at);

-- ---------------------------------------------------------------------------
-- 2. Why a delivery was not acted on. Kept out of `github_webhook_deliveries`
--    so that table's shape never has to change (see the header note).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS github_delivery_ignores (
  delivery_id  TEXT PRIMARY KEY,
  repository   TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  reason       TEXT NOT NULL,
  detail       TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_delivery_ignores_reason
  ON github_delivery_ignores (reason, created_at);

-- ---------------------------------------------------------------------------
-- 3. Commits handed off to the repository's own Actions worker because they are
--    too large to ingest from the edge (or the D1 write budget is spent). The
--    job row ends `failed` with `error_message='delegated_to_actions:<reason>'`;
--    this table is what makes the hand-off visible and auditable rather than a
--    bare failure.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_delegations (
  job_id      TEXT PRIMARY KEY,
  repository  TEXT NOT NULL,
  commit_sha  TEXT,
  target_kind TEXT NOT NULL,
  reason      TEXT NOT NULL,
  detail      TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_delegations_repo
  ON sync_delegations (repository, created_at);

-- ---------------------------------------------------------------------------
-- 4. Last commit successfully ingested per repository+ref. One indexed row read
--    lets a cron tick answer "nothing changed" without walking GitHub.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_cursors (
  repository   TEXT NOT NULL,
  ref          TEXT NOT NULL,
  commit_sha   TEXT NOT NULL,
  rows_written INTEGER NOT NULL DEFAULT 0,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (repository, ref)
);

-- ---------------------------------------------------------------------------
-- 5. reuse_attestations: the ONLY accepted evidence for `verified-compatible`.
--    A row here is a human/manifest decision bound to two exact source hashes.
--    Nothing in the codebase may infer this status from version proximity,
--    bundle name, item key, text similarity or release dates.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reuse_attestations (
  attestation_id     TEXT PRIMARY KEY,
  resource_kind      TEXT NOT NULL CHECK (resource_kind IN ('text', 'lyrics', 'image', 'unity3d')),
  logical_key        TEXT NOT NULL,
  locale             TEXT NOT NULL DEFAULT 'zh-CN',
  from_source_sha256 TEXT NOT NULL,
  to_source_sha256   TEXT NOT NULL,
  reason             TEXT NOT NULL,
  attested_by        TEXT NOT NULL,
  source_ref         TEXT,
  created_at         TEXT NOT NULL,
  UNIQUE (resource_kind, logical_key, locale, from_source_sha256, to_source_sha256)
);

CREATE INDEX IF NOT EXISTS idx_reuse_attest_lookup
  ON reuse_attestations (resource_kind, logical_key, locale, to_source_sha256);

-- ---------------------------------------------------------------------------
-- 6. Lookup indexes for the cursor-paginated release item APIs. The composite
--    (release_kind, release_id, bundle, item_key) index already exists on
--    source_variants; these cover the refs join direction and reuse roll-ups.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_release_refs_translation
  ON release_resource_refs (translation_id);

CREATE INDEX IF NOT EXISTS idx_translation_units_kind_lookup
  ON translation_units (resource_kind, logical_key, locale, status);

CREATE INDEX IF NOT EXISTS idx_source_variants_release_cursor
  ON source_variants (release_kind, release_id, bundle, item_key, source_variant_id);

-- The stats read path asks "which release is canonical?" on every request; this
-- turns that from a table walk into an index seek. The unique release_id index
-- also keeps the assets axis addressable by either identity.
CREATE INDEX IF NOT EXISTS idx_assets_releases_status
  ON assets_releases (status, updated_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_releases_release_id
  ON assets_releases (release_id);

-- ---------------------------------------------------------------------------
-- 7. Image task metadata (contract shared with scripts/generate_image_tasks_index.py).
--    A task's source is pixels, not text, so it is deliberately NOT a
--    source_variant: release summaries count translatable text units, and mixing
--    image tasks in would inflate total_items with rows that can never be
--    translated. Status is likewise not stored here — `image_status_overrides`
--    remains the single authority, layered on at read time.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS image_task_units (
  task_id TEXT PRIMARY KEY,
  bundle TEXT NOT NULL,
  category TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  image_format TEXT,
  has_alpha INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT,
  source_sha256 TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_image_task_units_category
  ON image_task_units (category, task_id);

CREATE INDEX IF NOT EXISTS idx_image_task_units_bundle
  ON image_task_units (bundle, task_id);

-- ---------------------------------------------------------------------------
-- 8. Explicitly excluded resource kinds. §一.2 keeps video out of the Assets
--    localisation binary set; listing it here means ingest classifies a video
--    path and skips it loudly (`unsupported_resource_kind`) instead of treating
--    it as text.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS unsupported_resource_kinds (
  resource_kind TEXT PRIMARY KEY,
  reason        TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

INSERT OR IGNORE INTO unsupported_resource_kinds (resource_kind, reason, created_at)
VALUES ('video', 'Video is outside the Assets localisation binary set; excluded by release policy.', '2026-09-28T00:00:00Z');
