// Server-side sessions for the translation portal.

import { deleteAuthObject, quotaLike, readAuthObject, writeAuthObject } from "./auth_fallback.js";
//
// Why this module exists: Cloudflare Access authenticated the *operator*, not
// the contributor. `Cf-Access-Authenticated-User-Email` is a request header, and
// anything that is decided by a header a caller can set is only as strong as the
// proxy in front of it — a plain GitHub contributor has no Access identity at
// all, so "link your GitHub account" was unreachable for them and every write
// route was blocked behind an operator-only login.
//
// The portal therefore owns a session of its own:
//
//   * a 32-byte opaque token, generated with `crypto.getRandomValues`;
//   * only its hash (HMAC-SHA-256, keyed by a deployment secret) sits in D1, so
//     a database read — a backup, a dump, a log of a query — yields no usable
//     credential; the raw token exists only in the browser's cookie jar and in
//     the request that carries it;
//   * `HttpOnly` + `SameSite=Lax` + `Secure` by default, so script cannot read
//     it and a cross-site navigation cannot use it;
//   * an explicit TTL and a `revoked_at`, so logout is a server-side fact and
//     not a hint to the browser.
//
// This file is deliberately transport-agnostic: it throws `SessionError`
// (`{status, code}`) and the Worker maps that onto HTTP. It is also free of
// Worker-only globals except `crypto.subtle`, so the same code runs under Node
// and in `workerd`. What it does NOT do is trust the caller for anything: no
// function here reads an identity from a header.

/// The cookie that carries the session token. `SameSite=Lax` (not `Strict`) is
/// required: the GitHub callback is a top-level cross-site GET, and a `Strict`
/// cookie is not sent on one — the flow would issue a session the browser then
/// refused to store for the redirect that follows.
export const SESSION_COOKIE_NAME = "mltd_portal_session";

/// The cookie that binds an OAuth round trip to the browser that started it.
/// Random, `HttpOnly`, and single-use: the `state` row carries the hash of this
/// value, so a `state` leaked to another browser (a shared link, a proxy log)
/// still cannot complete the flow. See `github_oauth_states.browser_binding_hash`.
export const OAUTH_BINDING_COOKIE_NAME = "mltd_portal_oauth_binding";

/// The header a same-origin write must echo the session's CSRF token in.
export const CSRF_HEADER = "x-csrf-token";

export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const OAUTH_BINDING_TTL_MS = 10 * 60 * 1000;

const HEX64 = /^[0-9a-f]{64}$/;
const MAX_COOKIE_HEADER_BYTES = 8192;
const MAX_SESSION_ROW_READ = 1;

export class SessionError extends Error {
  constructor(code, { status = 400 } = {}) {
    super(code);
    this.name = "SessionError";
    this.code = code;
    this.status = status;
  }
}

function csv(value) {
  return new Set(String(value || "").split(",").map((part) => part.trim().toLowerCase()).filter(Boolean));
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/// 32 random bytes, hex. Never derived from anything a caller supplied.
export function newOpaqueToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return hex(bytes);
}

/// The secret that keys the token hash.
///
/// Fail closed and *loudly*: without a pepper the hash of a 32-byte random token
/// is still unguessable, but the pepper is what keeps a leaked D1 dump from
/// being checkable offline against a stolen cookie. More importantly, a
/// deployment that forgot it must not silently fall back to a constant — that
/// fallback is exactly the kind of "works on my machine" default that later
/// becomes a production value. `GITHUB_OAUTH_CLIENT_SECRET` is accepted as the
/// pepper only because it is already a required, revocable deployment secret.
export function sessionPepper(env) {
  const value = String(env?.SESSION_PEPPER || env?.GITHUB_OAUTH_CLIENT_SECRET || "").trim();
  if (value.length < 16) throw new SessionError("session_pepper_unconfigured", { status: 503 });
  return value;
}

/// HMAC-SHA-256(pepper, token) as lowercase hex. The keyed form is deliberate:
/// a plain SHA-256 would let anyone holding the D1 row test a guess offline.
export async function hashSessionToken(env, token) {
  const pepper = sessionPepper(env);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(token || "")));
  return hex(mac);
}

// ---------------------------------------------------------------------------
// cookies
// ---------------------------------------------------------------------------

/// `a=1; b=2` -> Map. Unparseable pairs are skipped rather than fatal: the value
/// this module needs is either present and well-formed or the caller is
/// anonymous, and a malformed *other* cookie must not turn a read into a 500.
export function parseCookies(header) {
  const out = new Map();
  const text = String(header || "");
  if (!text || text.length > MAX_COOKIE_HEADER_BYTES) return out;
  for (const part of text.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    out.set(name, value);
  }
  return out;
}

export function readCookie(request, name) {
  return parseCookies(request?.headers?.get?.("cookie")).get(name) || "";
}

/// Whether the `Secure` attribute is on.
///
/// Default ON, and a value has to be exactly "false" to turn it off — an unset
/// variable, a typo or "0" all keep it on. Turning it off is for `wrangler dev`
/// over plain http on localhost and nowhere else; a production deployment that
/// lost the attribute would send the session cookie in the clear.
export function cookieSecure(env) {
  return String(env?.SESSION_COOKIE_SECURE || "").trim().toLowerCase() !== "false";
}

export function buildCookie({ name, value, maxAgeSeconds, path = "/", secure = true, sameSite = "Lax", httpOnly = true } = {}) {
  const parts = [`${name}=${value}`, `Path=${path}`];
  if (httpOnly) parts.push("HttpOnly");
  if (secure) parts.push("Secure");
  if (sameSite) parts.push(`SameSite=${sameSite}`);
  if (maxAgeSeconds !== undefined && maxAgeSeconds !== null) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  return parts.join("; ");
}

export function sessionCookie(env, token, { maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000) } = {}) {
  return buildCookie({ name: SESSION_COOKIE_NAME, value: token, maxAgeSeconds, secure: cookieSecure(env) });
}

/// Expiry without a value: `Max-Age=0` plus the empty value is what actually
/// deletes a cookie. The attributes have to match the ones it was set with or
/// the browser keeps the original.
export function clearSessionCookie(env) {
  return buildCookie({ name: SESSION_COOKIE_NAME, value: "", maxAgeSeconds: 0, secure: cookieSecure(env) });
}

export function oauthBindingCookie(env, value, { maxAgeSeconds = Math.floor(OAUTH_BINDING_TTL_MS / 1000) } = {}) {
  // The binding cookie is scoped to the OAuth routes: it has no business being
  // attached to every API request for the next ten minutes.
  return buildCookie({
    name: OAUTH_BINDING_COOKIE_NAME,
    value,
    maxAgeSeconds,
    path: "/api/auth/github",
    secure: cookieSecure(env),
  });
}

export function clearOauthBindingCookie(env) {
  return buildCookie({ name: OAUTH_BINDING_COOKIE_NAME, value: "", maxAgeSeconds: 0, path: "/api/auth/github", secure: cookieSecure(env) });
}

// ---------------------------------------------------------------------------
// roles
// ---------------------------------------------------------------------------

/// The role a person holds on *this* portal.
///
/// Two allowlists per level, because there are two kinds of identity in play: an
/// Access operator (an email) and a GitHub contributor (a login). They are
/// checked separately and neither is inferred from the other — a GitHub account
/// that happens to be named like an admin's email is not an admin, and being
/// able to open a pull request grants nothing here. Anything not on a list is a
/// `contributor`, which is the least privileged role the schema defines.
export function roleFor(env, { email = null, login = null } = {}) {
  const cleanEmail = String(email || "").trim().toLowerCase();
  const cleanLogin = String(login || "").trim().toLowerCase();
  const admins = csv(env?.ADMIN_EMAILS);
  const reviewers = csv(env?.REVIEWER_EMAILS);
  const adminLogins = csv(env?.ADMIN_GITHUB_LOGINS);
  const reviewerLogins = csv(env?.REVIEWER_GITHUB_LOGINS);
  if ((cleanEmail && admins.has(cleanEmail)) || (cleanLogin && adminLogins.has(cleanLogin))) return "admin";
  if ((cleanEmail && reviewers.has(cleanEmail)) || (cleanLogin && reviewerLogins.has(cleanLogin))) return "reviewer";
  return "contributor";
}

/// The key a GitHub identity is stored under. `github:<id>` and never a login:
/// logins are renameable and reusable, the numeric id is not, so a rename must
/// not be able to claim another person's row.
export function githubIdentityKey(githubUserId) {
  const id = String(githubUserId ?? "").trim();
  if (!/^[0-9]{1,20}$/.test(id)) throw new SessionError("github_user_id_invalid", { status: 500 });
  return `github:${id}`;
}

/// What goes in an audit row. A contributor who has no verified email still gets
/// a stable, non-forgeable actor string; an email is used only when GitHub
/// itself returned one.
export function auditActor(actor) {
  if (!actor) return "";
  return String(actor.email || "").trim().toLowerCase() || String(actor.key || "");
}

// ---------------------------------------------------------------------------
// session lifecycle
// ---------------------------------------------------------------------------

function expiredAt(iso, nowMs) {
  const value = Date.parse(String(iso || ""));
  if (!Number.isFinite(value)) return true;
  return value <= nowMs;
}

/// Read the session a request carries, or `null`.
///
/// Anonymous is a normal answer, not an error: every caller decides for itself
/// whether it needs a session. What is *not* normal is a database error, and
/// that propagates.
export async function readSession(request, env, { nowMs = Date.now() } = {}) {
  if (!env?.DB) throw new SessionError("database_unavailable", { status: 503 });
  const token = readCookie(request, SESSION_COOKIE_NAME);
  if (!HEX64.test(token)) return null;
  const tokenHash = await hashSessionToken(env, token);
  let row;
  try {
    row = await env.DB.prepare(
      `SELECT token_hash, actor_key, email, github_login, github_user_id, role, csrf_token, created_at, last_seen_at, expires_at, revoked_at ` +
      `FROM portal_sessions WHERE token_hash=?`
    ).bind(tokenHash).first();
  } catch (error) {
    if (!quotaLike(error)) throw error;
    row = null;
  }
  if (!row) {
    row = await readAuthObject(env, "sessions", tokenHash);
    if (row) row.token_hash = tokenHash;
  }
  if (!row) return null;
  if (row.revoked_at) return null;
  if (expiredAt(row.expires_at, nowMs)) return null;
  // `actor_key` is the stable identity this module promises: `github:<id>` once
  // a GitHub account is linked, an Access email for an operator session.
  const storedRole = row.role || "contributor";
  // The role is re-derived from the *current* allowlists on every request.
  //
  // The row's `role` column is therefore a record of what the role was at login,
  // not an authority: an operator removed from `ADMIN_EMAILS` (or a login
  // removed from `ADMIN_GITHUB_LOGINS`) loses the role on their very next
  // request instead of keeping it until the session's TTL runs out. Sessions
  // would otherwise be a way to outlive a revocation, which is the classic
  // reason to keep the decision and the credential in different places.
  //
  // There is deliberately no "the allowlists are empty, so fall back to the
  // stored role" branch. That branch looks like protection against locking an
  // operator out, and it is really a fail-open: deleting the last administrator
  // — or a typo in the variable name — would leave every existing admin session
  // in force, which is precisely the revocation this function exists to enforce.
  // An empty allowlist means nobody is a reviewer or an admin; the route that
  // needs one then refuses with `role_required`, which is a visible, actionable
  // state, unlike a silent promotion from a stale column.
  const role = roleFor(env, { email: row.email, login: row.github_login });
  if (role !== storedRole) {
    // Converge the row so an operator reading D1 sees the role that is actually
    // in force. Best effort: a failed write must not fail the request.
    try {
      await env.DB.prepare(`UPDATE portal_sessions SET role=? WHERE token_hash=?`).bind(role, row.token_hash).run();
    } catch (_) { /* the recomputed role is what returns either way */ }
  }
  const actor = {
    key: row.actor_key,
    email: row.email || null,
    login: row.github_login || null,
    github_user_id: row.github_user_id === null || row.github_user_id === undefined ? null : Number(row.github_user_id),
    role,
    stored_role: storedRole,
    // How this identity was established, which is a property of the *row* and
    // not of the key's spelling: a session minted by the GitHub login carries a
    // GitHub login, one established through the Access handshake carries an
    // operator email.
    via: row.github_login ? "github" : "access",
  };
  return {
    token,
    tokenHash: row.token_hash,
    actor,
    // The raw per-session write token. It is returned to the browser by exactly
    // two routes (`/api/auth/github/me` and the callback) and is never logged.
    csrfToken: row.csrf_token,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/// Create a session row and return the only copy of the raw token that will
/// ever exist server-side.
export async function issueSession(env, { actor, request = null, nowMs = Date.now() } = {}) {
  if (!env?.DB) throw new SessionError("database_unavailable", { status: 503 });
  if (!actor?.key) throw new SessionError("actor_key_required", { status: 500 });
  const token = newOpaqueToken();
  const csrfToken = newOpaqueToken();
  const tokenHash = await hashSessionToken(env, token);
  const timestamp = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + SESSION_TTL_MS).toISOString();
  const row = {
    actor_key: actor.key,
    email: actor.email || null,
    github_login: actor.login || null,
    github_user_id: actor.github_user_id ?? null,
    role: actor.role || "contributor",
    csrf_token: csrfToken,
    created_at: timestamp,
    last_seen_at: timestamp,
    expires_at: expiresAt,
    revoked_at: null,
    user_agent: String(request?.headers?.get?.("user-agent") || "").slice(0, 200) || null,
  };
  try {
    await env.DB.prepare(
      `INSERT INTO portal_sessions (token_hash, actor_key, email, github_login, github_user_id, role, csrf_token, created_at, last_seen_at, expires_at, revoked_at, user_agent) ` +
      `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
    ).bind(tokenHash, row.actor_key, row.email, row.github_login, row.github_user_id, row.role, row.csrf_token,
      row.created_at, row.last_seen_at, row.expires_at, row.user_agent).run();
  } catch (error) {
    if (!quotaLike(error) || !await writeAuthObject(env, "sessions", tokenHash, row)) throw error;
  }
  return { token, csrfToken, expiresAt, cookie: sessionCookie(env, token) };
}

/// Server-side logout. Returns whether a live row was actually revoked, so the
/// caller can tell "you were logged out" from "there was nothing to log out".
export async function revokeSession(env, token, { nowMs = Date.now() } = {}) {
  if (!env?.DB) throw new SessionError("database_unavailable", { status: 503 });
  if (!HEX64.test(String(token || ""))) return false;
  const tokenHash = await hashSessionToken(env, token);
  let quota = false;
  try {
    const result = await env.DB.prepare(
      `UPDATE portal_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL`
    ).bind(new Date(nowMs).toISOString(), tokenHash).run();
    if (Number(result?.meta?.changes ?? result?.changes ?? 0) > 0) return true;
  } catch (error) {
    if (!quotaLike(error)) throw error;
    quota = true;
  }
  return quota ? Boolean(await deleteAuthObject(env, "sessions", tokenHash)) : false;
}

/// Sweep sessions that are past their TTL and long-dead rows. Bounded by
/// `limit`, best-effort by design: a session that is not swept is still refused
/// by the expiry check, so a failed sweep can never widen access.
export async function sweepExpiredSessions(env, { nowMs = Date.now(), limit = 200 } = {}) {
  if (!env?.DB) return 0;
  const cutoff = new Date(nowMs).toISOString();
  try {
    const result = await env.DB.prepare(
      `DELETE FROM portal_sessions WHERE token_hash IN (SELECT token_hash FROM portal_sessions WHERE expires_at < ? OR revoked_at IS NOT NULL LIMIT ?)`
    ).bind(cutoff, limit).run();
    return Number(result?.meta?.changes ?? result?.changes ?? 0);
  } catch (_) {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// write protection (origin + CSRF)
// ---------------------------------------------------------------------------

/// Is this request's `Origin` the origin it was sent to?
///
/// The check is a *same-origin* check and nothing else. There is deliberately no
/// development exception: `http://localhost:8787` writing to
/// `https://portal.example` is a cross-origin request, and so is
/// `http://a.local` writing to `http://b.local`, or `http://localhost:3000`
/// writing to `http://localhost:8787` — "both hosts are local" is not the same
/// fact as "this is the same origin", and treating it as one is what turns a
/// loopback convenience into an accepted cross-site write. Local development
/// works because a dev server serves both the page and the API from one origin.
///
/// When `PORTAL_CANONICAL_ORIGIN` is set, the request's own origin must equal it
/// as well, so a request aimed at a hostname this deployment does not claim is
/// refused even though its `Origin` agrees with its target.
///
/// A missing `Origin` is also not accepted: browsers always send it on a
/// cross-origin write and on every same-origin POST/PUT/PATCH/DELETE, so "no
/// header" means a non-browser client — which is fine, but it must then carry
/// the CSRF token instead (and it cannot read that token without a session).
export function originAllowed(request, env) {
  const origin = String(request?.headers?.get?.("origin") || "").trim();
  if (!origin) return { ok: false, code: "origin_missing" };
  let parsed;
  try {
    parsed = new URL(origin);
  } catch (_) {
    return { ok: false, code: "origin_invalid" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { ok: false, code: "origin_invalid" };
  // `URL` normalises (`https://HOST:443` -> `https://host`), so a raw string
  // comparison would refuse legitimate forms; the parsed origin is the value
  // that has to match, and it is compared against the parsed one below.
  let selfOrigin = "";
  try {
    selfOrigin = new URL(String(request.url)).origin;
  } catch (_) {
    return { ok: false, code: "origin_invalid" };
  }
  if (parsed.origin !== selfOrigin) return { ok: false, code: "origin_not_allowed" };

  const canonical = String(env?.PORTAL_CANONICAL_ORIGIN || "").trim();
  if (canonical) {
    let canonicalOrigin = "";
    try {
      canonicalOrigin = new URL(canonical).origin;
    } catch (_) {
      throw new SessionError("portal_canonical_origin_invalid", { status: 503 });
    }
    if (parsed.origin !== canonicalOrigin) return { ok: false, code: "origin_not_allowed" };
  }
  return { ok: true, origin: parsed.origin };
}

/// The guard every state-changing request passes through.
///
/// Two independent checks, both required: the request must come from an origin
/// this deployment serves, and it must echo the session's CSRF token. Either one
/// alone is defeatable — an origin check alone trusts the browser, a CSRF token
/// alone can be leaked by a same-site XSS — and together they are the standard
/// shape. `SameSite=Lax` on the cookie is a third layer, not a substitute.
export function assertWriteAllowed(request, { session, env }) {
  const origin = originAllowed(request, env);
  if (!origin.ok) throw new SessionError(origin.code, { status: 403 });
  if (!session) throw new SessionError("authentication_required", { status: 401 });
  const presented = String(request?.headers?.get?.(CSRF_HEADER) || "").trim();
  if (!presented) throw new SessionError("csrf_token_missing", { status: 403 });
  const expected = String(session.csrfToken || "");
  if (!expected || !timingSafeEqual(presented, expected)) throw new SessionError("csrf_token_mismatch", { status: 403 });
  return origin;
}

/// Length-independent comparison. The values are 64 hex characters, but a
/// constant-time compare costs nothing here and removes the question.
export function timingSafeEqual(left, right) {
  const a = String(left);
  const b = String(right);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

/// The one place that formats a `Set-Cookie` list. `Headers.append` is what
/// keeps several cookies from overwriting each other — a plain object keyed by
/// `set-cookie` silently drops all but the last.
export function withCookies(response, cookies) {
  const list = (cookies || []).filter(Boolean);
  if (!list.length) return response;
  const headers = new Headers(response.headers);
  for (const cookie of list) headers.append("set-cookie", cookie);
  // A response that sets a session must never be cached, anywhere.
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}
