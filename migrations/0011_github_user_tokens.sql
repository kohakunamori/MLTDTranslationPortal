-- Migration 0011: encrypted custody for a contributor's GitHub token.
--
-- Why the portal keeps a token at all, after 0009 said it would not:
--
-- The first cut exchanged the authorization code and discarded the token, then
-- opened every proposal with the deployment's `GITHUB_PR_TOKEN`. That made the
-- portal a shared bot: the pull request is authored by whichever account holds
-- the deployment token, so the portal cannot show that the person who signed in
-- is the person GitHub records as the author, and a contributor cannot be held
-- to their own suggestions. Review is a merge on GitHub, and an author identity
-- that is somebody else is not a reviewable proposal.
--
-- So the token is kept — and the storage is the whole point of this file:
--
--   * `ciphertext` is AES-GCM under `USER_TOKEN_KEY`, an `iv` beside it and a
--     `key_id` fingerprint so a key rotation can be told from a corruption. The
--     plaintext token exists only inside the request that uses it: it is not in
--     this table, not in a log line, not in an audit row, not in any response.
--   * `actor_key` is the session's stable key (`github:<numeric id>`), never a
--     login, so a rename cannot inherit a stored credential.
--   * One row per account. A second login replaces the first token rather than
--     accumulating them, so a logout can remove exactly one thing.
--
-- Deliberately NOT here: any `INSERT`, and any fallback. A deployment without
-- `USER_TOKEN_KEY` does not get a weaker scheme — the write routes refuse with
-- `github_user_token_custody_unconfigured` (HTTP 503) and say so. A deployment
-- that has not decided how to hold credentials has not decided to let
-- contributors write.

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
