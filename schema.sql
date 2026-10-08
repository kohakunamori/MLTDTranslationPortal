PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS contributors (
  email TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('contributor', 'reviewer', 'admin')) DEFAULT 'contributor',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_catalogue (
  base_version TEXT NOT NULL,
  bundle TEXT NOT NULL,
  item_key TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  asset_version TEXT,
  logical_key TEXT,
  PRIMARY KEY (base_version, bundle, item_key)
);

CREATE TABLE IF NOT EXISTS contributions (
  id TEXT PRIMARY KEY,
  base_version TEXT NOT NULL,
  bundle TEXT NOT NULL,
  item_key TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  source TEXT NOT NULL,
  translation TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'needs_review')) DEFAULT 'pending',
  contributor_email TEXT NOT NULL REFERENCES contributors(email),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  asset_version TEXT,
  logical_key TEXT,
  UNIQUE (base_version, bundle, item_key, source_sha256, contributor_email)
);

CREATE INDEX IF NOT EXISTS contributions_queue_idx
  ON contributions (base_version, status, updated_at);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  contribution_id TEXT NOT NULL REFERENCES contributions(id),
  reviewer_email TEXT NOT NULL REFERENCES contributors(email),
  verdict TEXT NOT NULL CHECK (verdict IN ('accepted', 'rejected', 'needs_review')),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS publication_snapshots (
  id TEXT PRIMARY KEY,
  base_version TEXT NOT NULL,
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES contributors(email),
  created_at TEXT NOT NULL,
  asset_version TEXT,
  server_schema_version TEXT,
  client_version TEXT
);

CREATE TABLE IF NOT EXISTS assets_releases (
  asset_version TEXT PRIMARY KEY,
  release_id TEXT,
  server_schema_version TEXT NOT NULL DEFAULT 'v1',
  status TEXT NOT NULL CHECK (status IN ('canonical', 'staging', 'unverified', 'superseded')) DEFAULT 'canonical',
  source_manifest_sha256 TEXT,
  assets_commit TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT
);

-- The read path asks "which release is canonical right now?" on every stats
-- request. Without this it walked the table.
CREATE INDEX IF NOT EXISTS idx_assets_releases_status
  ON assets_releases (status, updated_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_releases_release_id
  ON assets_releases (release_id);

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

CREATE TABLE IF NOT EXISTS resource_units (
  resource_id TEXT PRIMARY KEY,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('text', 'lyrics', 'image', 'unity3d')),
  logical_key TEXT NOT NULL UNIQUE,
  category TEXT,
  created_at TEXT NOT NULL
);

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

CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  event_type TEXT NOT NULL,
  commit_sha TEXT,
  release_id TEXT,
  release_ref TEXT,
  ignored_reason TEXT,
  job_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('received', 'processing', 'completed', 'ignored', 'failed')) DEFAULT 'received',
  created_at TEXT NOT NULL,
  processed_at TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_gh_deliveries_repo
  ON github_webhook_deliveries (repository, created_at);

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

CREATE TABLE IF NOT EXISTS image_status_overrides (
  task_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('untranslated', 'not_needed', 'restored', 'accepted')),
  actor_email TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS image_restore_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  upload_key TEXT NOT NULL,
  upload_sha256 TEXT NOT NULL,
  model_size TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'done', 'failed')) DEFAULT 'queued',
  actor_email TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  localized_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Image task metadata. A task's *source* is pixels, not text, so it does not
-- belong in `source_variants` (whose rows are translatable text units and whose
-- counts feed the release summaries). Status is NOT stored here: the only
-- authority for a task's status is `image_status_overrides`, layered on top at
-- read time. Rows arrive from the metadata-only import manifest produced by
-- scripts/generate_image_tasks_index.py, keyed by task_id so a replay is a no-op.
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

CREATE INDEX IF NOT EXISTS idx_image_restore_status
  ON image_restore_requests (status, created_at);

-- ============================================================================
-- High-Performance D1 Read Quota Optimization Indexes & Summary Table
-- ============================================================================

-- Fast 1-row precomputed summary table for 0-scan lobby loads (saves ~300,000 row reads per hit)
CREATE TABLE IF NOT EXISTS portal_summary (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Point-lookup covering index on bundle: enables sub-50 row read queries for songs & stories
CREATE INDEX IF NOT EXISTS idx_source_cat_bundle_key
  ON source_catalogue (bundle, item_key);

-- Covering index for base_version and bundle pairing
CREATE INDEX IF NOT EXISTS idx_source_cat_base_bundle
  ON source_catalogue (base_version, bundle);

CREATE INDEX IF NOT EXISTS idx_source_cat_asset_version
  ON source_catalogue (asset_version, bundle);

-- Covering index on contributions for fast joins and status filtering without full table scan
CREATE INDEX IF NOT EXISTS idx_contrib_bundle_key
  ON contributions (bundle, item_key);

CREATE INDEX IF NOT EXISTS idx_contrib_status
  ON contributions (status, updated_at);

CREATE INDEX IF NOT EXISTS idx_contrib_asset_version
  ON contributions (asset_version, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_snapshots_asset_version
  ON publication_snapshots (asset_version);

-- ============================================================================
-- GitHub collaboration (migration 0009)
--
-- Additive only. These declarations mirror migrations/0009_github_collab.sql
-- exactly: a fresh database gets them from here, an existing one from the
-- migration. The reasoning for each shape lives in that file.
-- ============================================================================

-- One-shot CSRF state for the GitHub OAuth authorization-code flow.
CREATE TABLE IF NOT EXISTS github_oauth_states (
  state TEXT PRIMARY KEY,
  actor_key TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_github_oauth_states_expiry
  ON github_oauth_states (expires_at);

-- Which GitHub account an actor is. `access_token_ref` names a revocable secret;
-- the token itself is never stored in D1.
CREATE TABLE IF NOT EXISTS github_identities (
  actor_key TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE,
  github_user_id INTEGER,
  avatar_url TEXT,
  access_token_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_github_identities_login
  ON github_identities (login);

-- Mirror of a proposed pull request. The PR's own state/merged stay the review
-- authority; this table is what the maintainer dashboard reads.
CREATE TABLE IF NOT EXISTS github_prs (
  id TEXT PRIMARY KEY,
  contribution_id TEXT,
  target_repo TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  head_branch TEXT NOT NULL,
  fork_full_name TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  state TEXT,
  mergeable_state TEXT,
  head_sha TEXT,
  ci_status TEXT,
  merged INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_github_prs_branch_unique
  ON github_prs (target_repo, head_branch);

CREATE INDEX IF NOT EXISTS idx_github_prs_contribution
  ON github_prs (contribution_id);

CREATE INDEX IF NOT EXISTS idx_github_prs_state
  ON github_prs (state, updated_at);

CREATE INDEX IF NOT EXISTS idx_github_prs_number
  ON github_prs (target_repo, pr_number);

-- Independent version axes. `source_catalogue.base_version` and
-- `contributions.base_version` are the pre-decoupling composite columns; the
-- CHECKs here make a composite string unrepresentable instead of discouraged.
CREATE TABLE IF NOT EXISTS asset_axes (
  logical_key TEXT PRIMARY KEY,
  asset_version TEXT CHECK (
    asset_version IS NULL
    OR (asset_version GLOB '[0-9]*' AND asset_version NOT LIKE '%+%' AND asset_version NOT LIKE '%assets-%')
  ),
  client_version TEXT CHECK (
    client_version IS NULL
    OR (client_version NOT LIKE '%+%' AND client_version NOT LIKE '%assets-%')
  ),
  source_sha256 TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_asset_axes_asset_version
  ON asset_axes (asset_version);

CREATE INDEX IF NOT EXISTS idx_asset_axes_client_version
  ON asset_axes (client_version);


-- ---------------------------------------------------------------------------
-- Server-side portal sessions (migration 0010)
-- ---------------------------------------------------------------------------
--
-- What a browser holds instead of an identity header. The row stores the *hash*
-- of the token (`HMAC-SHA-256(pepper, token)`, lower-case hex), never the token
-- itself: a D1 backup, a dumped table or a query logged by an operator then
-- yields nothing that can be replayed. `role` is materialised at login and
-- re-derived from the allowlists on every request, so removing an operator from
-- `ADMIN_EMAILS` takes effect on their next request rather than at their
-- session's expiry.

CREATE TABLE IF NOT EXISTS portal_sessions (
  token_hash TEXT PRIMARY KEY,
  actor_key TEXT NOT NULL,
  email TEXT,
  github_login TEXT,
  github_user_id INTEGER,
  role TEXT NOT NULL CHECK (role IN ('contributor', 'reviewer', 'admin')) DEFAULT 'contributor',
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_portal_sessions_expiry
  ON portal_sessions (expires_at);

CREATE INDEX IF NOT EXISTS idx_portal_sessions_actor
  ON portal_sessions (actor_key, expires_at);

-- `browser_binding_hash` binds an authorization-code round trip to the browser
-- that started it: the hash of a random HttpOnly cookie. `state` alone proves
-- only that *someone* began a flow. Rows that predate the column are set to the
-- sentinel `legacy` by migration 0010 so the callback refuses them by name.
ALTER TABLE github_oauth_states ADD COLUMN browser_binding_hash TEXT;

-- Where the callback has to send the browser once a login lands. A same-site
-- path only; see `safeReturnTo` in src/worker.js.
ALTER TABLE github_oauth_states ADD COLUMN return_to TEXT;

-- ---------------------------------------------------------------------------
-- Encrypted custody for a contributor's GitHub token (migration 0011)
-- ---------------------------------------------------------------------------
--
-- A proposal has to be authored by the contributor who asked for it, so the
-- portal keeps their token — encrypted with AES-GCM under `USER_TOKEN_KEY`. The
-- plaintext exists only inside the request that uses it: not in this table, not
-- in a log line, not in an audit row, not in any response. `actor_key` is the
-- session's stable key (`github:<numeric id>`), so a rename cannot inherit a
-- stored credential, and one row per account means a logout removes exactly one.

CREATE TABLE IF NOT EXISTS github_user_tokens (
  actor_key TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_github_user_tokens_updated
  ON github_user_tokens (updated_at);
