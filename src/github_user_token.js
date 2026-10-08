// AES-GCM custody for a contributor's GitHub token.
//
// Why this file exists, and what it deliberately is not:
//
// The portal's first cut exchanged the contributor's authorization code and threw
// the token away, then opened every proposal with one deployment token. That is a
// shared bot identity wearing a contributor's name: the PR is opened by
// `GITHUB_PR_TOKEN`'s account, so the portal cannot show that the person who
// signed in is the person GitHub will record as the author, and a contributor
// could not be held to their own suggestions.
//
// Doing it properly means the portal has to *keep* a credential, which is exactly
// the kind of thing that ends up in a dump. So the rules are hard ones:
//
//   * the token is encrypted at rest with AES-GCM under `USER_TOKEN_KEY`;
//   * the plaintext exists only inside the request that needs it;
//   * nothing here logs, returns or audits it — not even a prefix;
//   * when no key is configured the portal does **not** silently fall back to the
//     shared token. It refuses the write with a named code. A deployment that has
//     not decided how to hold credentials has not decided to let contributors
//     write, and the two must not be the same state.
//
// This module is `github_session.js`'s sibling and shares its conventions: it
// throws `SessionError` with `{status, code}` and knows nothing about HTTP.

import { SessionError } from "./github_session.js";
import { deleteAuthObject, quotaLike, readAuthObject, writeAuthObject } from "./auth_fallback.js";

/// 32 bytes of base64 (or 64 hex characters). Checked rather than assumed: a
/// short key with AES-GCM is not a weaker cipher, it is a different one.
const KEY_BYTES = 32;
const IV_BYTES = 12;

function decodeKey(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new SessionError("github_user_token_key_unconfigured", { status: 503 });
  let bytes = null;
  if (/^[0-9a-f]{64}$/i.test(text)) {
    bytes = new Uint8Array(text.match(/.{2}/g).map((pair) => Number.parseInt(pair, 16)));
  } else {
    try {
      const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
      bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    } catch (_) {
      bytes = null;
    }
  }
  if (!bytes || bytes.length !== KEY_BYTES) {
    throw new SessionError("github_user_token_key_invalid", { status: 503 });
  }
  return bytes;
}

/// Whether this deployment can hold a contributor token at all.
///
/// A boolean rather than a throw: the login flow asks this question to decide
/// whether to store anything, and an operator checking a deployment should be
/// able to ask it without provoking an error.
export function tokenCustodyConfigured(env) {
  try {
    decodeKey(env?.USER_TOKEN_KEY);
    return true;
  } catch (_) {
    return false;
  }
}

/// A key id, so a rotation can be told apart from a corruption. It is a
/// fingerprint of the key, not a secret: knowing it does not shorten a search
/// for a 32-byte key, and losing it makes every stored token undecryptable.
async function keyId(keyBytes) {
  const digest = await crypto.subtle.digest("SHA-256", keyBytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

async function importKey(env) {
  const bytes = decodeKey(env?.USER_TOKEN_KEY);
  const key = await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return { key, keyId: await keyId(bytes) };
}

function toBase64(bytes) {
  let out = "";
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let index = 0; index < view.length; index += 1) out += String.fromCharCode(view[index]);
  return btoa(out);
}

function fromBase64(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/// Encrypt a token for storage. The result is what goes in D1 — three columns,
/// none of which is the token.
export async function sealUserToken(env, token) {
  const value = String(token || "").trim();
  if (!value) throw new SessionError("github_user_token_missing", { status: 500 });
  const { key, keyId: id } = await importKey(env);
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode("mltd-portal-user-token") },
    key,
    new TextEncoder().encode(value),
  );
  return { key_id: id, iv: toBase64(iv), ciphertext: toBase64(ciphertext) };
}

/// Decrypt a stored token. Throws rather than returning a sentinel: a caller that
/// cannot decrypt must not be able to proceed by treating the result as empty.
export async function openUserToken(env, row) {
  if (!row?.ciphertext || !row?.iv) throw new SessionError("github_user_token_absent", { status: 404 });
  const { key, keyId: id } = await importKey(env);
  if (row.key_id && row.key_id !== id) throw new SessionError("github_user_token_key_mismatch", { status: 409 });
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(row.iv), additionalData: new TextEncoder().encode("mltd-portal-user-token") },
      key,
      fromBase64(row.ciphertext),
    );
  } catch (_) {
    // A GCM failure means the bytes changed or the key did. Either way the token
    // is gone, and saying so is the only honest answer.
    throw new SessionError("github_user_token_undecryptable", { status: 409 });
  }
  return new TextDecoder().decode(plain);
}

/// Store (or replace) a contributor's token. `actor_key` is the session's stable
/// key (`github:<id>`), so a second login by the same account overwrites the
/// first rather than accumulating rows.
export async function putUserToken(env, actorKey, token) {
  if (!env?.DB) throw new SessionError("database_unavailable", { status: 503 });
  const sealed = await sealUserToken(env, token);
  const timestamp = new Date().toISOString();
  const row = { actor_key: actorKey, key_id: sealed.key_id, iv: sealed.iv, ciphertext: sealed.ciphertext, created_at: timestamp, updated_at: timestamp };
  try {
    await env.DB.prepare(
      `INSERT INTO github_user_tokens (actor_key, key_id, iv, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ` +
      `ON CONFLICT(actor_key) DO UPDATE SET key_id=excluded.key_id, iv=excluded.iv, ciphertext=excluded.ciphertext, updated_at=excluded.updated_at`
    ).bind(actorKey, sealed.key_id, sealed.iv, sealed.ciphertext, timestamp, timestamp).run();
  } catch (error) {
    if (!quotaLike(error) || !await writeAuthObject(env, "tokens", actorKey, row)) throw error;
  }
}

/// Forget a contributor's token — on logout, and on any GitHub write that the
/// token is not authorised for (a revoked token must not be retried).
export async function deleteUserToken(env, actorKey) {
  if (!env?.DB) return false;
  try {
    const result = await env.DB.prepare(`DELETE FROM github_user_tokens WHERE actor_key=?`).bind(actorKey).run();
    if (Number(result?.meta?.changes ?? result?.changes ?? 0) > 0) return true;
  } catch (error) {
    if (!quotaLike(error)) throw error;
  }
  return Boolean(await deleteAuthObject(env, "tokens", actorKey));
}

/// The token to open a proposal with, and the identity it belongs to.
///
/// Fail-closed in three distinct ways, each with its own code, because they have
/// three different fixes:
///   * no key configured          -> `github_user_token_custody_unconfigured`
///   * no row for this session    -> `github_user_token_absent`
///   * a row but no `GITHUB_...`   -> (decrypt errors above)
///
/// There is deliberately no fourth path that returns `GITHUB_PR_TOKEN`. The
/// deployment token is for *reads* the portal makes on its own behalf — reading a
/// pinned file, resolving a rename — where no contributor identity is implied.
export async function requireUserToken(env, actorKey) {
  if (!env?.DB) throw new SessionError("database_unavailable", { status: 503 });
  if (!tokenCustodyConfigured(env)) throw new SessionError("github_user_token_custody_unconfigured", { status: 503 });
  let row;
  try {
    row = await env.DB.prepare(
      `SELECT actor_key, key_id, iv, ciphertext, updated_at FROM github_user_tokens WHERE actor_key=?`
    ).bind(actorKey).first();
  } catch (error) {
    if (!quotaLike(error)) throw error;
  }
  if (!row) row = await readAuthObject(env, "tokens", actorKey);
  if (!row) throw new SessionError("github_user_token_absent", { status: 409 });
  return openUserToken(env, row);
}
