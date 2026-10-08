-- Migration 0005: Decouple release versions (Client vs Assets releases)
-- Additive migration preserving all existing columns and data.

-- 1. Add asset_version and logical_key to source_catalogue
ALTER TABLE source_catalogue ADD COLUMN asset_version TEXT;
ALTER TABLE source_catalogue ADD COLUMN logical_key TEXT;

-- 2. Add asset_version and logical_key to contributions
ALTER TABLE contributions ADD COLUMN asset_version TEXT;
ALTER TABLE contributions ADD COLUMN logical_key TEXT;

-- 3. Add asset_version, server_schema_version, and client_version to publication_snapshots
ALTER TABLE publication_snapshots ADD COLUMN asset_version TEXT;
ALTER TABLE publication_snapshots ADD COLUMN server_schema_version TEXT;
ALTER TABLE publication_snapshots ADD COLUMN client_version TEXT;

-- 4. Registry table for validated assets releases (enforces unverified asset rejection)
CREATE TABLE IF NOT EXISTS assets_releases (
  asset_version TEXT PRIMARY KEY,
  server_schema_version TEXT NOT NULL DEFAULT 'v1',
  status TEXT NOT NULL CHECK (status IN ('canonical', 'staging', 'unverified', 'superseded')) DEFAULT 'canonical',
  source_manifest_sha256 TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Seed canonical 1077100 assets release
INSERT OR IGNORE INTO assets_releases (asset_version, server_schema_version, status, note, created_at, updated_at)
VALUES ('1077100', 'v1', 'canonical', 'Primary canonical frozen assets release', datetime('now'), datetime('now'));

-- Seed superseded 1077500 assets release
INSERT OR IGNORE INTO assets_releases (asset_version, server_schema_version, status, note, created_at, updated_at)
VALUES ('1077500', 'v1', 'superseded', 'Historical staging candidate with empty /cn/ overlay', datetime('now'), datetime('now'));

-- 5. Helpful covering indexes for asset_version
CREATE INDEX IF NOT EXISTS idx_source_cat_asset_version
  ON source_catalogue (asset_version, bundle);

CREATE INDEX IF NOT EXISTS idx_contrib_asset_version
  ON contributions (asset_version, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_snapshots_asset_version
  ON publication_snapshots (asset_version);
