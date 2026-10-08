-- Migration 0008: Historical seed provenance (additive, replay-safe).
--
-- Why this file exists:
--   * 0005 seeds assets 1077100 (canonical) + 1077500 (superseded).
--   * 0006 re-seeds both via INSERT OR REPLACE and additionally seeds a default
--     client release (client-9.0.200-arm64, candidate).
--   * Those rows are HISTORICAL MIGRATION SEEDS, not production evidence. A real
--     release must arrive through the GitHub manifest import path
--     (sync_ingest.js validateReleaseManifest + upsertRelease), which pins the
--     manifest to an exact commit SHA and validates hashes.
--   * Far-end databases may already have executed 0005/0006, so this file MUST
--     NOT delete, downgrade, or rewrite those rows. It only records provenance
--     so future readers and fresh-database tests can tell "came from a migration
--     seed" apart from "arrived via a verified import".
--
-- Replay safety: CREATE TABLE / INDEX IF NOT EXISTS + INSERT OR IGNORE only.
-- Safe to apply through scripts/bootstrap_portal_d1.py on fresh and upgrade
-- paths. Fresh-database tests must still start by clearing the release
-- registry (see test_sync.mjs newDb) and registering exactly the releases the
-- test is about.

CREATE TABLE IF NOT EXISTS migration_seed_provenance (
  seed_key TEXT PRIMARY KEY,
  migration TEXT NOT NULL,
  release_kind TEXT NOT NULL CHECK (release_kind IN ('client', 'assets')),
  release_id TEXT,
  asset_version TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO migration_seed_provenance (seed_key, migration, release_kind, release_id, asset_version, reason, created_at)
VALUES
  ('0005:assets-1077100', '0005_decouple_release_versions.sql', 'assets', 'assets-1077100', '1077100', 'historical migration seed, not production evidence; real releases arrive via GitHub manifest import', '2026-09-29T00:00:00Z'),
  ('0005:assets-1077500', '0005_decouple_release_versions.sql', 'assets', 'assets-1077500', '1077500', 'historical migration seed, not production evidence; real releases arrive via GitHub manifest import', '2026-09-29T00:00:00Z'),
  ('0006:assets-1077100', '0006_independent_release_axes.sql', 'assets', 'assets-1077100', '1077100', 'historical migration re-seed (INSERT OR REPLACE), not production evidence', '2026-09-29T00:00:00Z'),
  ('0006:assets-1077500', '0006_independent_release_axes.sql', 'assets', 'assets-1077500', '1077500', 'historical migration re-seed (INSERT OR REPLACE), not production evidence', '2026-09-29T00:00:00Z'),
  ('0006:client-9.0.200-arm64', '0006_independent_release_axes.sql', 'client', 'client-9.0.200-arm64', NULL, 'historical migration seed, not production evidence; real client releases arrive via GitHub manifest import', '2026-09-29T00:00:00Z');

CREATE INDEX IF NOT EXISTS idx_migration_seed_provenance_kind
  ON migration_seed_provenance (release_kind, asset_version);
