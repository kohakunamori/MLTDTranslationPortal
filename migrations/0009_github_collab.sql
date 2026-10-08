-- Migration 0009: GitHub collaboration (OAuth identities, proposal PRs, axes).
--
-- Statement classes used here, and why:
--
--   * CREATE TABLE / CREATE INDEX IF NOT EXISTS — replayable by construction.
--     This file contains ONLY those, so running it twice is a no-op and a
--     partially applied file can be re-run without damage. Nothing here is an
--     `ALTER TABLE ... ADD COLUMN`, so nothing here depends on
--     scripts/bootstrap_portal_d1.py's duplicate-column skip. The tables are
--     also declared verbatim in schema.sql, which is the *current* full schema;
--     this file is what brings an already-deployed database up to it.
--
--     `merged` on `github_prs` is declared inline rather than added by a later
--     ALTER precisely so that stays true. The table has no pre-existing
--     deployment to migrate, so there is no column to add to.
--
-- Four tables, four jobs:
--
--   * `github_oauth_states` — one-shot CSRF tokens for the authorization-code
--     flow. Consumption is a row update (`consumed_at`), so a replayed callback
--     is refused even while the token is inside its TTL.
--
--   * `github_identities` — which GitHub account an actor is. The access token
--     is NOT stored: `access_token_ref` names a revocable secret (a Worker
--     secret or a KMS key) rather than carrying the credential. A D1 row is a
--     much weaker place to keep a token than a secret store, and the portal
--     never needs the raw value to render a page.
--
--   * `github_prs` — the portal's mirror of a pull request. The PR's own
--     `state`/`merged` are the only review authority; the columns here exist so
--     the maintainer dashboard can show a status without calling GitHub per row.
--     `ci_status` mirrors a check-run rollup for the same reason.
--
--   * `asset_axes` — the independent version axes. `source_catalogue.base_version`
--     and `contributions.base_version` predate the decoupling and are *composite*
--     columns; this table is the corrected shape. The CHECK constraints make a
--     composite string (`9.0.200+1077100`) unrepresentable rather than merely
--     discouraged: an asset version must start with a digit and may not contain
--     `+`, and a client version may not contain `+` either. A client version is
--     dotted (`9.0.200`), so no single form is imposed on it beyond that.
--
-- Deliberately NOT here: any `INSERT`. Seeding a release is a release event
-- (migrations 0006/0007 do it for history); this file only adds storage.

-- ---------------------------------------------------------------------------
-- 1. One-shot OAuth state tokens.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS github_oauth_states (
  state TEXT PRIMARY KEY,
  -- The Cloudflare Access identity that started the flow, so a callback cannot
  -- be replayed by a different session even with a leaked state value.
  actor_key TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_github_oauth_states_expiry
  ON github_oauth_states (expires_at);

-- ---------------------------------------------------------------------------
-- 2. GitHub identities. No plaintext token, by design.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS github_identities (
  actor_key TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE,
  github_user_id INTEGER,
  avatar_url TEXT,
  -- A *reference* to a revocable secret (worker secret name / KMS key id),
  -- never the token itself.
  access_token_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_github_identities_login
  ON github_identities (login);

-- ---------------------------------------------------------------------------
-- 3. Pull request mirror.
-- ---------------------------------------------------------------------------

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
  -- GitHub's own merged flag, mirrored. Kept beside `state` because a merged PR
  -- is also `closed`: the two facts are not the same one.
  merged INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One PR per branch+repo is the invariant the submit path relies on: a retried
-- submission must find its PR rather than open a second one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_github_prs_branch_unique
  ON github_prs (target_repo, head_branch);

CREATE INDEX IF NOT EXISTS idx_github_prs_contribution
  ON github_prs (contribution_id);

CREATE INDEX IF NOT EXISTS idx_github_prs_state
  ON github_prs (state, updated_at);

CREATE INDEX IF NOT EXISTS idx_github_prs_number
  ON github_prs (target_repo, pr_number);

-- ---------------------------------------------------------------------------
-- 4. Independent version axes.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS asset_axes (
  logical_key TEXT PRIMARY KEY,
  -- A bare decimal assets version ("1077100"). A composite ("9.0.200+1077100")
  -- or a release ref ("assets-1077100") is rejected by the CHECK below.
  asset_version TEXT CHECK (
    asset_version IS NULL
    OR (asset_version GLOB '[0-9]*' AND asset_version NOT LIKE '%+%' AND asset_version NOT LIKE '%assets-%')
  ),
  -- A client version ("9.0.200"). Never carries the asset version alongside it.
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
