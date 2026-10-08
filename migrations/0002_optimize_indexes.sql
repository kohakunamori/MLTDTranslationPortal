-- Migration 0002: D1 Quota Protection and High-Performance Covering Indexes

CREATE TABLE IF NOT EXISTS portal_summary (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_source_cat_bundle_key
  ON source_catalogue (bundle, item_key);

CREATE INDEX IF NOT EXISTS idx_source_cat_base_bundle
  ON source_catalogue (base_version, bundle);

CREATE INDEX IF NOT EXISTS idx_contrib_bundle_key
  ON contributions (bundle, item_key);

CREATE INDEX IF NOT EXISTS idx_contrib_status
  ON contributions (status, updated_at);
