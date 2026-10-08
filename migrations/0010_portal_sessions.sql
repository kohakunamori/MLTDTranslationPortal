-- Migration 0010: server-side portal sessions, and the OAuth browser binding.
--
-- Statement classes used here, and why:
--
-- CREATE TABLE/INDEX 使用 IF NOT EXISTS；下面的 ADD COLUMN 本身不幂等。
-- 正式环境须由迁移台账保证只执行一次。测试/本地 bootstrap 会先检查列是否已存在，
-- 不得据此声称把本文件原样重复提交给 D1 也一定安全。
--
-- Two problems, one file, because they are the same problem seen twice: the
-- portal had no login of its own.
--
--   * `portal_sessions` — what a browser holds instead of an identity header.
--     The row stores the *hash* of the token (`HMAC-SHA-256(pepper, token)`,
--     lower-case hex), never the token: a D1 backup, a dumped table or a query
--     logged by an operator then yields nothing that can be replayed. `role` is
--     登录时的快照；每次请求仍按当前 ACL 重新计算权限，不能依赖旧 role 保权。
--     `revoked_at` 记录服务端登出事实。
--
--   * `github_oauth_states.browser_binding_hash` — the missing half of the CSRF
--     defence for the authorization-code flow. `state` alone proves only that a
--     flow was started by *someone*; a state leaked to a second browser (a
--     shared link, a proxy log, a shoulder) could be completed there. The state
--     row now carries the hash of a random, HttpOnly cookie set in the browser
--     that began the flow, and the callback refuses unless the two agree.
--
-- Deliberately NOT here: any `INSERT`. Seeding is a release event; this file
-- only adds storage. Existing `github_oauth_states` rows are backfilled to the
-- sentinel `legacy` rather than left NULL, so "no binding was required" is a
-- value the callback can name and refuse, instead of a NULL it might shrug at.

-- ---------------------------------------------------------------------------
-- 1. Server-side sessions.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS portal_sessions (
  -- Lower-case hex HMAC-SHA-256 of the opaque token. Primary key: one row per
  -- token, and a token is never reused after revocation or expiry.
  token_hash TEXT PRIMARY KEY,
  -- Stable identity: `github:<numeric id>` for a contributor (a login can be
  -- renamed and a renamed login must not inherit the old row), or the
  -- Cloudflare Access email for an operator session.
  actor_key TEXT NOT NULL,
  -- Verified attributes, copied at login. `email` is filled only from an
  -- identity source; it is never taken from a request body or a header.
  email TEXT,
  github_login TEXT,
  github_user_id INTEGER,
  role TEXT NOT NULL CHECK (role IN ('contributor', 'reviewer', 'admin')) DEFAULT 'contributor',
  -- The per-session write token a same-origin caller echoes in `x-csrf-token`.
  -- Random and independent of the cookie value, so reading the cookie (script
  -- cannot: it is HttpOnly) would still not let a page forge a write.
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  -- Recorded for the operator's benefit only ("which of my browsers is this?").
  -- No authorisation decision may read it.
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_portal_sessions_expiry
  ON portal_sessions (expires_at);

CREATE INDEX IF NOT EXISTS idx_portal_sessions_actor
  ON portal_sessions (actor_key, expires_at);

-- ---------------------------------------------------------------------------
-- 2. Browser binding for an OAuth round trip.
-- ---------------------------------------------------------------------------

ALTER TABLE github_oauth_states ADD COLUMN browser_binding_hash TEXT;

-- Rows that predate the binding cannot be completed any more: they were minted
-- before the browser ever received a binding cookie. Marking them `legacy` makes
-- the callback's refusal explicit (`oauth_state_browser_binding_legacy`)
-- instead of letting a NULL mean "unconstrained".
UPDATE github_oauth_states SET browser_binding_hash='legacy' WHERE browser_binding_hash IS NULL;

ALTER TABLE github_oauth_states ADD COLUMN return_to TEXT;

-- The rows that predate the binding cannot be completed any more, and neither
-- can a row that names no return path: both are marked so the callback refuses
-- them with a code an operator can act on.
UPDATE github_oauth_states SET return_to='/' WHERE return_to IS NULL;
