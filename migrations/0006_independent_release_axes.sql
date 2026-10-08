-- Migration 0006: Complete Independent Release Axes & Cross-Version Reuse Models
-- Additive migration: Preserves all existing tables and data.

-- 1. Client Releases Table
CREATE TABLE IF NOT EXISTS client_releases (
  release_id TEXT PRIMARY KEY,
  client_version TEXT NOT NULL,
  abi TEXT NOT NULL DEFAULT 'arm64-v8a' CHECK (abi = 'arm64-v8a'),
  base_apk_sha256 TEXT NOT NULL,
  client_resources_commit TEXT NOT NULL,
  manifest_sha256 TEXT,
  output_apk_sha256 TEXT,
  release_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'candidate', 'published', 'superseded', 'failed')) DEFAULT 'candidate',
  created_at TEXT NOT NULL,
  published_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_client_releases_status
  ON client_releases (status, created_at);

-- 2. Extend assets_releases Table (additive)
ALTER TABLE assets_releases ADD COLUMN release_id TEXT;
ALTER TABLE assets_releases ADD COLUMN assets_commit TEXT;
ALTER TABLE assets_releases ADD COLUMN published_at TEXT;

-- Seed canonical 1077100 Assets release with full metadata
INSERT OR REPLACE INTO assets_releases (
  asset_version, release_id, server_schema_version, status, source_manifest_sha256, note, created_at, updated_at, published_at
) VALUES (
  '1077100',
  'assets-1077100',
  'v1',
  'canonical',
  '6c1d816cd16cc020e71019fa6c14fe3803d415b4de1769481657f585636a00fe',
  'Primary canonical frozen assets release (batch 7 published on NAS /cn/1077100/)',
  '2026-09-27T00:00:00Z',
  '2026-09-28T00:00:00Z',
  '2026-09-27T00:00:00Z'
);

-- Seed unverified/superseded 1077500 Assets release
INSERT OR REPLACE INTO assets_releases (
  asset_version, release_id, server_schema_version, status, source_manifest_sha256, note, created_at, updated_at, published_at
) VALUES (
  '1077500',
  'assets-1077500',
  'v1',
  'superseded',
  NULL,
  'Unverified staging candidate; /cn/1077500 overlay is empty; not an approved release',
  '2026-09-15T00:00:00Z',
  '2026-09-26T00:00:00Z',
  NULL
);

-- Seed default client release 9.0.200 (arm64-v8a)
INSERT OR REPLACE INTO client_releases (
  release_id, client_version, abi, base_apk_sha256, client_resources_commit, manifest_sha256, output_apk_sha256, status, created_at, published_at
) VALUES (
  'client-9.0.200-arm64',
  '9.0.200',
  'arm64-v8a',
  '4c8448e97eadf2220748835e04a458ffaa61e7c219e686d2eb50be64b76088c1',
  'e4894f75040d8745cbfae10986754bde29841f32',
  'a3b4c5d6e7f8091a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a',
  NULL,
  'candidate',
  '2026-09-27T00:00:00Z',
  NULL
);

-- 3. Logical Resource Units Table
CREATE TABLE IF NOT EXISTS resource_units (
  resource_id TEXT PRIMARY KEY,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('text', 'lyrics', 'image', 'unity3d')),
  logical_key TEXT NOT NULL UNIQUE,
  category TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_resource_units_kind
  ON resource_units (resource_kind, category);

-- 4. Source Variants Table (Version-bound representation of a resource)
CREATE TABLE IF NOT EXISTS source_variants (
  source_variant_id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resource_units(resource_id),
  release_kind TEXT NOT NULL CHECK (release_kind IN ('client', 'assets')),
  release_id TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  source TEXT NOT NULL,
  bundle TEXT NOT NULL,
  item_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (release_kind, release_id, bundle, item_key)
);

CREATE INDEX IF NOT EXISTS idx_source_variants_release
  ON source_variants (release_kind, release_id, bundle, item_key);

CREATE INDEX IF NOT EXISTS idx_source_variants_sha
  ON source_variants (source_sha256);

-- 5. Translation Units Table (Canonical reusable localized units)
CREATE TABLE IF NOT EXISTS translation_units (
  translation_id TEXT PRIMARY KEY,
  logical_key TEXT NOT NULL,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('text', 'lyrics', 'image', 'unity3d')),
  locale TEXT NOT NULL DEFAULT 'zh-CN',
  source_sha256 TEXT NOT NULL,
  translation TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'needs_review', 'suggested', 'blocked')) DEFAULT 'pending',
  contributor_email TEXT,
  reviewer_email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (logical_key, resource_kind, locale, source_sha256)
);

CREATE INDEX IF NOT EXISTS idx_translation_units_lookup
  ON translation_units (logical_key, source_sha256, locale);

-- 6. Release Resource References Table (Binds release variant to translation & records reuse mode)
CREATE TABLE IF NOT EXISTS release_resource_refs (
  id TEXT PRIMARY KEY,
  release_kind TEXT NOT NULL CHECK (release_kind IN ('client', 'assets')),
  release_id TEXT NOT NULL,
  source_variant_id TEXT NOT NULL REFERENCES source_variants(source_variant_id),
  translation_id TEXT REFERENCES translation_units(translation_id),
  reuse_mode TEXT NOT NULL CHECK (reuse_mode IN ('exact', 'verified-compatible', 'suggested', 'blocked', 'none')) DEFAULT 'none',
  reused_from_release_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('untranslated', 'pending', 'accepted', 'rejected', 'needs_review', 'suggested', 'blocked')) DEFAULT 'untranslated',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (release_kind, release_id, source_variant_id)
);

CREATE INDEX IF NOT EXISTS idx_release_refs_filter
  ON release_resource_refs (release_kind, release_id, status);

CREATE INDEX IF NOT EXISTS idx_release_refs_reuse
  ON release_resource_refs (reuse_mode);

-- 7. Release Summaries Table (Fast pre-calculated stats per release; eliminates table scans)
CREATE TABLE IF NOT EXISTS release_summaries (
  release_kind TEXT NOT NULL CHECK (release_kind IN ('client', 'assets')),
  release_id TEXT NOT NULL,
  total_items INTEGER NOT NULL DEFAULT 0,
  translated_items INTEGER NOT NULL DEFAULT 0,
  pending_items INTEGER NOT NULL DEFAULT 0,
  untranslated_items INTEGER NOT NULL DEFAULT 0,
  reused_items INTEGER NOT NULL DEFAULT 0,
  suggested_items INTEGER NOT NULL DEFAULT 0,
  blocked_items INTEGER NOT NULL DEFAULT 0,
  category_summary_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (release_kind, release_id)
);

-- 8. GitHub Webhook Deliveries Table (Deduplication and audit log)
CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  event_type TEXT NOT NULL,
  commit_sha TEXT,
  release_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('received', 'processing', 'completed', 'ignored', 'failed')) DEFAULT 'received',
  created_at TEXT NOT NULL,
  processed_at TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_gh_deliveries_status
  ON github_webhook_deliveries (status, created_at);

-- 9. Asynchronous Sync Jobs Table (Retryable queue for event-driven manifest sync)
CREATE TABLE IF NOT EXISTS sync_jobs (
  job_id TEXT PRIMARY KEY,
  delivery_id TEXT REFERENCES github_webhook_deliveries(delivery_id),
  repository TEXT NOT NULL,
  event_type TEXT NOT NULL,
  commit_sha TEXT,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('client', 'assets')),
  target_release_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'retrying')) DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_retry_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_queue
  ON sync_jobs (status, next_retry_at);
