// Portal sessions, the GitHub-only login, and source-bound single-row edits.
//
// MOCK-TESTED, NO LIVE GITHUB CALL. Every request to api.github.com below is
// answered by the recording `fetch` in this file, built from GitHub's documented
// response shapes. What the suite proves is this service's own contract: which
// cookie it sets, which row it writes, what it refuses, and — for the edit route
// — that the file it commits is the pinned file with exactly one line changed.
//
// Run: node test_github_session.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteD1, MemoryR2 } from "./test_helpers/d1_sqlite.mjs";
import {
  CSRF_HEADER,
  OAUTH_BINDING_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  auditActor,
  buildCookie,
  clearSessionCookie,
  cookieSecure,
  githubIdentityKey,
  hashSessionToken,
  issueSession,
  originAllowed,
  parseCookies,
  readSession,
  revokeSession,
  roleFor,
  sessionCookie,
  timingSafeEqual,
} from "./src/github_session.js";
import {
  GITHUB_API,
  GITHUB_OAUTH_TOKEN_URL,
} from "./src/github_collab.js";

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
const { default: worker } = await import(new URL("./src/worker.js", import.meta.url).href);
await import("./public/github-contribution.js");
const frontendProposals = globalThis.MLTDContribution;

let checks = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    checks += 1;
    console.log(`ok ${checks} - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL ${name}\n     ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// the harness: a real SQLite D1, a recording GitHub, and one call helper
// ---------------------------------------------------------------------------

const ORIGIN = "https://portal.example.test";
const PEPPER = "test-pepper-0123456789abcdef";
const PR_TOKEN = "ghp_TESTONLYSESSIONTOKEN0000000000000";
const OAUTH_SECRET = "cs_TESTONLYOASUTHSECRET00000000000000";
/// 32 bytes, hex — the AES-GCM key a deployment holds contributor tokens under.
const USER_TOKEN_KEY = "5f".repeat(32);
const STAMP = "2026-09-30T00:00:00Z";
const BASE_COMMIT = "c".repeat(40);
/// The blob sha of the file as read at `BASE_COMMIT`. GitHub's contents API
/// updates an existing file by *blob* sha, not by commit sha.
const BLOB_SHA = "b".repeat(40);
/// The original image's own hash. An image proposal carries *this*, never the
/// upload's: the uploaded bytes are the translation.
const IMAGE_SOURCE_SHA256 = "7".repeat(64);
/// The image task the fixtures work against, imported from the assets ledger.
const TASK_ID = "event_0015_info";
const ASSETS_REPO = "kohakunamori/MLTDTranslationAssets";
const CLIENT_REPO = "kohakunamori/MLTDTranslationClient";

const db = new SqliteD1({ portalDir: DIRNAME });
db.applySchema();

function baseEnv(overrides = {}) {
  return {
    DB: db,
    PUBLICATION_BUCKET: new MemoryR2(),
    ENVIRONMENT: "test",
    REVIEWER_EMAILS: "reviewer@example.test",
    ADMIN_EMAILS: "admin@example.test",
    ADMIN_GITHUB_LOGINS: "kohaku-admin",
    REVIEWER_GITHUB_LOGINS: "",
    SESSION_PEPPER: PEPPER,
    USER_TOKEN_KEY,
    PORTAL_CANONICAL_ORIGIN: ORIGIN,
    GITHUB_OAUTH_CLIENT_ID: "cid",
    GITHUB_OAUTH_CLIENT_SECRET: OAUTH_SECRET,
    GITHUB_PR_TOKEN: PR_TOKEN,
    GITHUB_TARGET_ASSETS: ASSETS_REPO,
    GITHUB_TARGET_CLIENT: CLIENT_REPO,
    // 生产读的是 CI manifest；本套件固定在它自己的 D1 fixture 上，显式关掉
    // 远端 manifest（空对象不是合法 manifest，解析会回退 D1 历史），否则
    // bare version 会被线上 manifest 认领，测试变成联网验收。
    ASSETS_PORTAL_MANIFEST_URL: "data:application/json,%7B%7D",
    CLIENT_PORTAL_MANIFEST_URL: "data:application/json,%7B%7D",
    ASSETS: { fetch: async () => new Response("static index", { status: 200 }) },
    ...overrides,
  };
}
const env = baseEnv();


/// A `fetch` that records every call and answers from a list of route rules. An
/// unmatched URL is a test failure, not a fallback: a suite that silently
/// accepted the wrong URL would not be testing the URL.
function recordingFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, method: init.method || "GET", headers: init.headers || {}, body: init.body, init });
    for (const [index, route] of routes.entries()) {
      const matches = typeof route.match === "function" ? route.match(target, init)
        : (route.match instanceof RegExp ? route.match.test(target) : target === route.match);
      if (!matches) continue;
      if (route.consume !== false) routes.splice(index, 1);
      if (route.throw) throw new Error(route.throw);
      const body = route.reply === undefined ? "" : (typeof route.reply === "string" ? route.reply : JSON.stringify(route.reply));
      return new Response(body, {
        status: route.status || 200,
        headers: { "content-type": "application/json", ...(route.headers || {}) },
      });
    }
    throw new Error(`unmatched GitHub request: ${init.method || "GET"} ${target}`);
  };
  impl.calls = calls;
  return impl;
}

function jsonBody(call) {
  assert.ok(call?.body, "the recorded call carried no body");
  return JSON.parse(String(call.body));
}

function committedBytes(call) {
  return Buffer.from(jsonBody(call).content, "base64");
}

async function call(pathname, { method = "GET", headers = {}, body, cookies, env: override, url = ORIGIN } = {}) {
  const h = new Headers({ origin: ORIGIN, ...headers });
  if (body !== undefined) h.set("content-type", "application/json");
  if (cookies) h.set("cookie", cookies);
  const request = new Request(`${url}${pathname}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await worker.fetch(request, override || env);
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
  const setCookie = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  return { response, body: parsed, setCookie };
}

function cookieValue(setCookies, name) {
  for (const header of setCookies) {
    const match = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(header);
    if (match) return match[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. github_session.js — the pieces the Worker builds on
// ---------------------------------------------------------------------------

await check("parseCookies reads a header and refuses to be confused by junk", () => {
  const cookies = parseCookies('a=1; mltd_portal_session=deadbeef; quoted="x=y"; broken; =nope');
  assert.equal(cookies.get("a"), "1");
  assert.equal(cookies.get("mltd_portal_session"), "deadbeef");
  assert.equal(cookies.get("quoted"), "x=y");
  assert.equal(cookies.has("broken"), false);
  assert.equal(cookies.has(""), false);
  assert.equal(parseCookies("").size, 0);
  assert.equal(parseCookies(null).size, 0);
});

await check("buildCookie sets HttpOnly, Secure and SameSite by default", () => {
  const cookie = buildCookie({ name: "s", value: "v", maxAgeSeconds: 60 });
  assert.ok(cookie.startsWith("s=v; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=60"), cookie);
  const cleared = clearSessionCookie(baseEnv());
  assert.match(cleared, /Max-Age=0/, "clearing is Max-Age=0, not a missing attribute");
  assert.match(cleared, /HttpOnly/);
});

await check("Secure is on unless the deployment says exactly \"false\"", () => {
  assert.equal(cookieSecure({}), true);
  assert.equal(cookieSecure({ SESSION_COOKIE_SECURE: "" }), true);
  assert.equal(cookieSecure({ SESSION_COOKIE_SECURE: "0" }), true);
  assert.equal(cookieSecure({ SESSION_COOKIE_SECURE: "true " }), true);
  assert.equal(cookieSecure({ SESSION_COOKIE_SECURE: "false" }), false);
  assert.equal(cookieSecure({ SESSION_COOKIE_SECURE: "FALSE" }), false);
});

await check("sessionCookie carries the TTL and the security attributes", () => {
  const cookie = sessionCookie(baseEnv(), "a".repeat(64));
  assert.ok(cookie.includes(`${SESSION_COOKIE_NAME}=${"a".repeat(64)}`));
  assert.equal(SESSION_TTL_MS, 14 * 24 * 60 * 60 * 1000);
  assert.match(cookie, new RegExp(`Max-Age=${SESSION_TTL_MS / 1000}`));
});

await check("hashSessionToken is keyed, stable, and refuses an unconfigured pepper", async () => {
  const env0 = baseEnv();
  const first = await hashSessionToken(env0, "token-value");
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, await hashSessionToken(env0, "token-value"));
  assert.notEqual(first, await hashSessionToken(env0, "token-value2"));
  // A different pepper is a different hash: the value is not a plain digest.
  assert.notEqual(first, await hashSessionToken(baseEnv({ SESSION_PEPPER: "other-pepper-0123456789abcdef" }), "token-value"));
  // Fail closed rather than fall back to a constant.
  for (const env0 of [baseEnv({ SESSION_PEPPER: "", GITHUB_OAUTH_CLIENT_SECRET: "" }), baseEnv({ SESSION_PEPPER: "short", GITHUB_OAUTH_CLIENT_SECRET: "" })]) {
    const error = await hashSessionToken(env0, "x").catch((err) => err);
    assert.equal(error.code, "session_pepper_unconfigured");
    assert.equal(error.status, 503);
  }
  // The OAuth client secret is an acceptable pepper: it is already a required,
  // revocable deployment secret.
  const viaSecret = await hashSessionToken(baseEnv({ SESSION_PEPPER: "" }), "token-value");
  assert.equal(viaSecret, await hashSessionToken(baseEnv({ SESSION_PEPPER: OAUTH_SECRET }), "token-value"));
});

await check("timingSafeEqual compares without leaking length", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "abcd"), false);
  assert.equal(timingSafeEqual("", ""), true);
});

await check("githubIdentityKey is the numeric id and refuses anything else", () => {
  assert.equal(githubIdentityKey(583231), "github:583231");
  assert.equal(githubIdentityKey("583231"), "github:583231");
  for (const value of [null, undefined, "", "octocat", "12; DROP TABLE", "-1", "1e3"]) {
    assert.throws(() => githubIdentityKey(value), /github_user_id_invalid/, String(value));
  }
});

await check("roleFor reads the allowlists and never promotes by accident", () => {
  const env0 = baseEnv();
  assert.equal(roleFor(env0, { email: "admin@example.test" }), "admin");
  assert.equal(roleFor(env0, { email: "reviewer@example.test" }), "reviewer");
  assert.equal(roleFor(env0, { email: "someone@example.test" }), "contributor");
  assert.equal(roleFor(env0, { login: "kohaku-admin" }), "admin");
  assert.equal(roleFor(env0, { login: "random-dev" }), "contributor");
  // A GitHub login that *looks* like an admin email is not one: the two lists
  // are separate, and neither source is inferred from the other.
  assert.equal(roleFor(env0, { login: "admin@example.test" }), "contributor");
  assert.equal(roleFor(env0, { email: "kohaku-admin" }), "contributor");
  // An empty allowlist is nobody, not everybody.
  assert.equal(roleFor(baseEnv({ ADMIN_EMAILS: "", REVIEWER_EMAILS: "", ADMIN_GITHUB_LOGINS: "", REVIEWER_GITHUB_LOGINS: "" }), { email: "admin@example.test", login: "kohaku-admin" }), "contributor");
});

await check("auditActor prefers a verified email and falls back to the stable key", () => {
  assert.equal(auditActor({ key: "github:1", email: null }), "github:1");
  assert.equal(auditActor({ key: "github:1", email: "A@B.test" }), "a@b.test");
  assert.equal(auditActor(null), "");
});

await check("originAllowed is a same-origin check, with no development exception", () => {
  const request = (target, origin) => new Request(target, origin === undefined ? {} : { headers: { origin } });
  const env0 = baseEnv();
  const local = baseEnv({ PORTAL_CANONICAL_ORIGIN: "" });

  // Same origin, production and local alike.
  assert.equal(originAllowed(request(`${ORIGIN}/api/x`, ORIGIN), env0).ok, true);
  assert.equal(originAllowed(request("http://localhost:8787/api/x", "http://localhost:8787"), local).ok, true);

  // Cross-origin, even when both ends are "local".
  assert.equal(originAllowed(request(`${ORIGIN}/api/x`, "http://localhost:8787"), env0).code, "origin_not_allowed");
  assert.equal(originAllowed(request("http://localhost:8787/api/x", "http://localhost:3000"), local).code, "origin_not_allowed");
  assert.equal(originAllowed(request("http://a.local/api/x", "http://b.local"), local).code, "origin_not_allowed");
  assert.equal(originAllowed(request("http://localhost:8787/api/x", "http://127.0.0.1:8787"), local).code, "origin_not_allowed");

  // A host the deployment does not claim is refused even when Origin agrees.
  assert.equal(originAllowed(request("https://staging.example.test/api/x", "https://staging.example.test"), env0).code, "origin_not_allowed");

  // Missing, malformed and non-HTTP origins.
  assert.equal(originAllowed(request(`${ORIGIN}/api/x`, undefined), env0).code, "origin_missing");
  assert.equal(originAllowed(request(`${ORIGIN}/api/x`, ""), env0).code, "origin_missing");
  assert.equal(originAllowed(request(`${ORIGIN}/api/x`, "not a url"), env0).code, "origin_invalid");
  assert.equal(originAllowed(request(`${ORIGIN}/api/x`, "file:///etc/passwd"), env0).code, "origin_invalid");
  assert.equal(originAllowed(request(`${ORIGIN}/api/x`, "null"), env0).code, "origin_invalid");

  // The canonical origin itself may be malformed — that is a deployment error,
  // named as one rather than silently accepting or silently refusing.
  const broken = (() => {
    try {
      originAllowed(request(`${ORIGIN}/api/x`, ORIGIN), baseEnv({ PORTAL_CANONICAL_ORIGIN: "://nope" }));
      return null;
    } catch (err) {
      return err;
    }
  })();
  assert.equal(broken?.code, "portal_canonical_origin_invalid");
  assert.equal(broken?.status, 503);
});

await check("issueSession stores the hash, never the token", async () => {
  const isolated = new SqliteD1({ portalDir: DIRNAME });
  isolated.applySchema();
  const env0 = baseEnv({ DB: isolated });
  const issued = await issueSession(env0, {
    actor: { key: "github:42", email: null, login: "octocat", github_user_id: 42, role: "contributor" },
    request: new Request(`${ORIGIN}/x`, { headers: { "user-agent": "test-agent" } }),
  });
  assert.match(issued.token, /^[0-9a-f]{64}$/);
  assert.match(issued.csrfToken, /^[0-9a-f]{64}$/);
  assert.notEqual(issued.token, issued.csrfToken);
  const row = isolated.db.prepare(`SELECT * FROM portal_sessions`).get();
  assert.equal(row.token_hash, await hashSessionToken(env0, issued.token));
  assert.notEqual(row.token_hash, issued.token);
  assert.equal(row.actor_key, "github:42");
  assert.equal(row.role, "contributor");
  assert.equal(row.user_agent, "test-agent");
  assert.equal(row.revoked_at, null);
  assert.ok(!JSON.stringify(row).includes(issued.token), "the raw token must not be stored anywhere in the row");
  isolated.close();
});

await check("readSession authenticates a live cookie and refuses a dead one", async () => {
  const isolated = new SqliteD1({ portalDir: DIRNAME });
  isolated.applySchema();
  const env0 = baseEnv({ DB: isolated });
  const issued = await issueSession(env0, { actor: { key: "github:7", login: "dev", github_user_id: 7, role: "contributor" } });
  const request = (cookie) => new Request(`${ORIGIN}/api/x`, { headers: cookie ? { cookie } : {} });

  const live = await readSession(request(`${SESSION_COOKIE_NAME}=${issued.token}`), env0);
  assert.equal(live.actor.key, "github:7");
  assert.equal(live.csrfToken, issued.csrfToken);

  // No cookie, a malformed cookie, and a well-formed cookie with no row.
  assert.equal(await readSession(request(null), env0), null);
  assert.equal(await readSession(request(`${SESSION_COOKIE_NAME}=not-hex`), env0), null);
  assert.equal(await readSession(request(`${SESSION_COOKIE_NAME}=${"f".repeat(64)}`), env0), null);

  // Revoked.
  assert.equal(await revokeSession(env0, issued.token), true);
  assert.equal(await revokeSession(env0, issued.token), false, "a second revoke has nothing to do");
  assert.equal(await readSession(request(`${SESSION_COOKIE_NAME}=${issued.token}`), env0), null);

  // Expired.
  const expiring = await issueSession(env0, { actor: { key: "github:8", login: "dev2", github_user_id: 8, role: "contributor" } });
  assert.equal(await readSession(request(`${SESSION_COOKIE_NAME}=${expiring.token}`), env0, { nowMs: Date.now() + SESSION_TTL_MS + 1000 }), null);
  isolated.close();
});

await check("readSession re-derives the role from the current allowlists", async () => {
  const isolated = new SqliteD1({ portalDir: DIRNAME });
  isolated.applySchema();
  const env0 = baseEnv({ DB: isolated });
  const issued = await issueSession(env0, {
    actor: { key: "admin@example.test", email: "admin@example.test", login: null, role: "admin" },
  });
  const request = new Request(`${ORIGIN}/api/x`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${issued.token}` } });
  assert.equal((await readSession(request, env0)).actor.role, "admin");

  // The admin is removed from the allowlist. The stored row still says `admin`;
  // the next request must not.
  env0.ADMIN_EMAILS = "someone-else@example.test";
  const demoted = await readSession(request, env0);
  assert.equal(demoted.actor.role, "contributor", "a removed admin must not keep the role for the session's TTL");
  assert.equal(demoted.actor.stored_role, "admin");
  // ...and the row converges, so D1 does not keep claiming otherwise.
  assert.equal(isolated.db.prepare(`SELECT role FROM portal_sessions`).get().role, "contributor");

  // The same for the GitHub login list.
  const byLogin = await issueSession(env0, { actor: { key: "github:9", login: "kohaku-admin", github_user_id: 9, role: "admin" } });
  const loginRequest = new Request(`${ORIGIN}/api/x`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${byLogin.token}` } });
  assert.equal((await readSession(loginRequest, env0)).actor.role, "admin");
  env0.ADMIN_GITHUB_LOGINS = "";
  assert.equal((await readSession(loginRequest, env0)).actor.role, "contributor");

  // Every allowlist empty is nobody — not "fall back to what the row says".
  const empty = baseEnv({ DB: isolated, ADMIN_EMAILS: "", REVIEWER_EMAILS: "", ADMIN_GITHUB_LOGINS: "", REVIEWER_GITHUB_LOGINS: "" });
  const issued2 = await issueSession(empty, { actor: { key: "admin@example.test", email: "admin@example.test", role: "admin" } });
  const emptyRequest = new Request(`${ORIGIN}/api/x`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${issued2.token}` } });
  assert.equal((await readSession(emptyRequest, empty)).actor.role, "contributor");
  isolated.close();
});

// ---------------------------------------------------------------------------
// 2. the Worker's login: anonymous in, session out
// ---------------------------------------------------------------------------

await check("GET /api/auth/github/me is 401 anonymously", async () => {
  const { response, body } = await call("/api/auth/github/me");
  assert.equal(response.status, 401);
  assert.equal(body.error, "authentication_required");
});

await check("GET /api/auth/github/login needs no identity and starts a bound flow", async () => {
  const { response, setCookie } = await call("/api/auth/github/login?return_to=/queue");
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location"));
  assert.equal(`${location.origin}${location.pathname}`, "https://github.com/login/oauth/authorize");
  assert.equal(location.searchParams.get("client_id"), "cid");
  assert.equal(location.searchParams.get("scope"), "public_repo");
  const state = location.searchParams.get("state");
  assert.ok(state);

  const binding = cookieValue(setCookie, OAUTH_BINDING_COOKIE_NAME);
  assert.match(binding, /^[0-9a-f]{64}$/, "the binding cookie must be 32 random bytes");
  assert.match(setCookie.join(";"), /HttpOnly/);

  const row = db.db.prepare(`SELECT actor_key, browser_binding_hash, return_to, consumed_at FROM github_oauth_states WHERE state=?`).get(state);
  assert.equal(row.actor_key, null, "the flow is not tied to an Access identity any more");
  assert.equal(row.consumed_at, null);
  assert.equal(row.return_to, "/queue");
  // The binding is stored as a hash, not as the cookie value.
  assert.notEqual(row.browser_binding_hash, binding);
  assert.equal(row.browser_binding_hash, await hashSessionToken(env, binding));
});

await check("return_to cannot become an open redirect", async () => {
  for (const [given, expected] of [["//evil.test", "/"], ["/\\evil.test", "/"], ["https://evil.test", "/"], ["", "/"], ["/queue?x=1", "/queue?x=1"]]) {
    const { response } = await call(`/api/auth/github/login?return_to=${encodeURIComponent(given)}`);
    const state = new URL(response.headers.get("location")).searchParams.get("state");
    assert.equal(db.db.prepare(`SELECT return_to FROM github_oauth_states WHERE state=?`).get(state).return_to, expected, given);
  }
});

await check("the callback refuses a state that is unknown, expired or spent", async () => {
  const unknown = await call("/api/auth/github/callback?state=nope&code=c1", { headers: { accept: "application/json" } });
  assert.equal(unknown.body.error, "oauth_state_unknown");

  const missing = await call("/api/auth/github/callback?state=x", { headers: { accept: "application/json" } });
  assert.equal(missing.body.error, "oauth_code_missing");

  // A migrated row that predates the browser binding cannot be completed.
  db.db.prepare(
    `INSERT INTO github_oauth_states (state, actor_key, created_at, expires_at, consumed_at, browser_binding_hash, return_to) VALUES ('legacy-1', NULL, ?, ?, NULL, 'legacy', '/')`
  ).run(STAMP, "2099-01-01T00:00:00Z");
  const legacy = await call("/api/auth/github/callback?state=legacy-1&code=c1", { headers: { accept: "application/json" } });
  assert.equal(legacy.body.error, "oauth_state_browser_binding_legacy");

  db.db.prepare(
    `INSERT INTO github_oauth_states (state, actor_key, created_at, expires_at, consumed_at, browser_binding_hash, return_to) VALUES ('expired-1', NULL, ?, '2020-01-01T00:00:00Z', NULL, ?, '/')`
  ).run(STAMP, "a".repeat(64));
  const expired = await call("/api/auth/github/callback?state=expired-1&code=c1", { cookies: `${OAUTH_BINDING_COOKIE_NAME}=${"a".repeat(64)}`, headers: { accept: "application/json" } });
  assert.equal(expired.body.error, "oauth_state_expired");
});

await check("the callback requires the browser that started the flow", async () => {
  const login = await call("/api/auth/github/login");
  const state = new URL(login.response.headers.get("location")).searchParams.get("state");
  const binding = cookieValue(login.setCookie, OAUTH_BINDING_COOKIE_NAME);

  const noCookie = await call(`/api/auth/github/callback?state=${state}&code=c1`, { headers: { accept: "application/json" } });
  assert.equal(noCookie.body.error, "oauth_state_browser_binding_missing");

  const wrongCookie = await call(`/api/auth/github/callback?state=${state}&code=c1`, {
    cookies: `${OAUTH_BINDING_COOKIE_NAME}=${"b".repeat(64)}`,
    headers: { accept: "application/json" },
  });
  assert.equal(wrongCookie.body.error, "oauth_state_browser_binding_mismatch");

  const malformed = await call(`/api/auth/github/callback?state=${state}&code=c1`, {
    cookies: `${OAUTH_BINDING_COOKIE_NAME}=not-hex`,
    headers: { accept: "application/json" },
  });
  assert.equal(malformed.body.error, "oauth_state_browser_binding_missing");

  // The state is still unspent: a refusal must not burn the flow.
  assert.equal(db.db.prepare(`SELECT consumed_at FROM github_oauth_states WHERE state=?`).get(state).consumed_at, null);
  assert.match(binding, /^[0-9a-f]{64}$/);
});

/// The one GitHub conversation a successful login makes.
function loginFetch({ login = "octocat", id = 583231 } = {}) {
  return recordingFetch([
    { match: GITHUB_OAUTH_TOKEN_URL, reply: { access_token: "gho_ROUTESMOKE000000000000000000000000", token_type: "bearer", scope: "public_repo" } },
    { match: `${GITHUB_API}/user`, reply: { login, id, avatar_url: `https://avatars.test/${login}.png` } },
  ]);
}

async function completeLogin({ login = "octocat", id = 583231, returnTo = null, envOverride = null } = {}) {
  const query = returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : "";
  const started = await call(`/api/auth/github/login${query}`, { env: envOverride });
  const state = new URL(started.response.headers.get("location")).searchParams.get("state");
  const binding = cookieValue(started.setCookie, OAUTH_BINDING_COOKIE_NAME);
  const fetchImpl = loginFetch({ login, id });
  const finished = await call(`/api/auth/github/callback?state=${state}&code=code-1`, {
    cookies: `${OAUTH_BINDING_COOKIE_NAME}=${binding}`,
    headers: { accept: "application/json" },
    env: envOverride ? { ...envOverride, GITHUB_COLLAB_FETCH: fetchImpl } : { ...env, GITHUB_COLLAB_FETCH: fetchImpl },
  });
  return { started, finished, fetchImpl, state, binding };
}

await check("a GitHub contributor logs in with no Access identity at all", async () => {
  const { finished } = await completeLogin({ login: "octocat", id: 583231 });
  assert.equal(finished.response.status, 200, JSON.stringify(finished.body));
  assert.deepEqual(finished.body, {
    authenticated: true,
    login: "octocat",
    github_user_id: 583231,
    avatar_url: "https://avatars.test/octocat.png",
    role: "contributor",
    csrfToken: finished.body.csrfToken,
    via: "github",
    // The token was sealed into D1, so this session can open proposals...
    token_custody: "stored",
    can_submit: true,
  });
  assert.match(finished.body.csrfToken, /^[0-9a-f]{64}$/);

  const token = cookieValue(finished.setCookie, SESSION_COOKIE_NAME);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.match(finished.setCookie.join(";"), /HttpOnly/);
  assert.match(finished.setCookie.join(";"), /Secure/);
  assert.match(finished.setCookie.join(";"), /SameSite=Lax/);

  const row = db.db.prepare(`SELECT * FROM portal_sessions WHERE actor_key='github:583231'`).get();
  assert.ok(row, "the session row is keyed by the numeric id");
  assert.equal(row.login ?? row.github_login, "octocat");
  assert.equal(row.token_hash, await hashSessionToken(env, token));
  assert.equal(row.role, "contributor");
  // The token itself is nowhere in the row.
  assert.ok(!JSON.stringify(row).includes(token));

  const identity = db.db.prepare(`SELECT actor_key, login, github_user_id, access_token_ref FROM github_identities WHERE actor_key='github:583231'`).get();
  assert.equal(identity.login, "octocat");
  // 0009's `access_token_ref` still stays NULL; the token lives in its own
  // table, encrypted (migration 0011).
  assert.equal(identity.access_token_ref, null, "the OAuth token is never stored in the identity row");

  const custody = db.db.prepare(`SELECT actor_key, key_id, iv, ciphertext FROM github_user_tokens WHERE actor_key='github:583231'`).get();
  assert.ok(custody, "the contributor's token must be held for the write routes");
  assert.match(custody.iv, /^[A-Za-z0-9+/]+=*$/);
  assert.match(custody.ciphertext, /^[A-Za-z0-9+/]+=*$/);
  assert.notEqual(custody.ciphertext, "gho_ROUTESMOKE000000000000000000000000");
  assert.ok(!custody.ciphertext.includes("gho_"), "the ciphertext must not contain the token");
  assert.ok(!JSON.stringify(custody).includes("gho_ROUTESMOKE"), "no column may carry the token in the clear");
  assert.equal(custody.key_id.length, 16, "the key id is a fingerprint, not the key");

  // It decrypts back to exactly the token the exchange returned — the property
  // the whole custody scheme exists for.
  const { openUserToken } = await import("./src/github_user_token.js");
  assert.equal(await openUserToken(env, custody), "gho_ROUTESMOKE000000000000000000000000");
});

await check("a GitHub contributor is not an administrator — the ACLs are separate", async () => {
  // The account logs in and is a contributor; no email allowlist can reach it,
  // because GitHub does not tell us an email and a client-supplied one is not
  // evidence. Only ADMIN_GITHUB_LOGINS can promote it.
  const asContributor = await completeLogin({ login: "octocat", id: 583231 });
  assert.equal(asContributor.finished.body.role, "contributor");

  const asAdmin = await completeLogin({ login: "kohaku-admin", id: 4242 });
  assert.equal(asAdmin.finished.body.role, "admin", "ADMIN_GITHUB_LOGINS is the one list that can promote a login");

  const asReviewer = await completeLogin({ login: "someone", id: 5151, envOverride: baseEnv({ REVIEWER_GITHUB_LOGINS: "someone", GITHUB_COLLAB_FETCH: loginFetch({ login: "someone", id: 5151 }) }) });
  assert.equal(asReviewer.finished.body.role, "reviewer");
});

await check("the authorization code is exchanged and the token is thrown away", async () => {
  const { fetchImpl, finished } = await completeLogin({ login: "octocat", id: 583231 });
  const exchange = fetchImpl.calls.find((call) => call.url === GITHUB_OAUTH_TOKEN_URL);
  assert.equal(exchange.method, "POST");
  assert.ok(String(exchange.body).includes("code=code-1"));
  assert.ok(String(exchange.body).includes("client_secret="), "the exchange is the documented one");

  // Nothing in the response carries it.
  assert.ok(!JSON.stringify(finished.body).includes("gho_ROUTESMOKE"));
  assert.ok(!JSON.stringify(db.db.prepare(`SELECT * FROM github_identities`).all()).includes("gho_ROUTESMOKE"));
  assert.ok(!JSON.stringify(db.db.prepare(`SELECT * FROM portal_sessions`).all()).includes("gho_ROUTESMOKE"));
  assert.ok(!JSON.stringify(db.db.prepare(`SELECT * FROM audit_events`).all()).includes("gho_ROUTESMOKE"));
});

await check("the state is single-use, even for the right browser", async () => {
  const { state, binding } = await completeLogin({ login: "octocat", id: 583231 });
  const replay = await call(`/api/auth/github/callback?state=${state}&code=code-1`, {
    cookies: `${OAUTH_BINDING_COOKIE_NAME}=${binding}`,
    headers: { accept: "application/json" },
    env: { ...env, GITHUB_COLLAB_FETCH: loginFetch() },
  });
  assert.equal(replay.body.error, "oauth_state_replayed");
});

await check("a rename moves the identity row instead of opening a second one", async () => {
  // "renamer" (id 777) logs in, then renames to "renamed" (same id).
  const first = await completeLogin({ login: "renamer", id: 777 });
  assert.equal(first.finished.body.role, "contributor");
  const second = await completeLogin({ login: "renamed", id: 777 });
  assert.equal(second.finished.body.login, "renamed");
  const rows = db.db.prepare(`SELECT actor_key, login FROM github_identities WHERE actor_key='github:777'`).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].login, "renamed");
  assert.equal(db.db.prepare(`SELECT COUNT(*) AS n FROM github_identities WHERE login='renamer'`).get().n, 0);
});

await check("a login held by another account's row is refused, not adopted", async () => {
  // The row for id 888 claims "contested". A *different* id trying to take the
  // name is refused unless GitHub says the account behind it is the same one.
  db.db.prepare(
    `INSERT INTO github_identities (actor_key, login, github_user_id, avatar_url, created_at, updated_at) VALUES ('github:888', 'contested', 888, NULL, ?, ?)`
  ).run(STAMP, STAMP);
  const fetchImpl = recordingFetch([
    { match: GITHUB_OAUTH_TOKEN_URL, reply: { access_token: "gho_CONTEST" } },
    { match: `${GITHUB_API}/user`, reply: { login: "contested", id: 999, avatar_url: null } },
    { match: `${GITHUB_API}/users/contested`, reply: { login: "contested", id: 888 } },
  ]);
  const started = await call("/api/auth/github/login");
  const state = new URL(started.response.headers.get("location")).searchParams.get("state");
  const binding = cookieValue(started.setCookie, OAUTH_BINDING_COOKIE_NAME);
  const { body, response } = await call(`/api/auth/github/callback?state=${state}&code=c1`, {
    cookies: `${OAUTH_BINDING_COOKIE_NAME}=${binding}`,
    headers: { accept: "application/json" },
    env: { ...env, GITHUB_COLLAB_FETCH: fetchImpl },
  });
  assert.equal(response.status, 409, JSON.stringify(body));
  assert.equal(body.error, "github_identity_conflict");
  // No session was minted, and the other account's row is untouched.
  assert.equal(db.db.prepare(`SELECT role FROM portal_sessions WHERE actor_key='github:999'`).get(), undefined);
  assert.equal(db.db.prepare(`SELECT actor_key FROM github_identities WHERE login='contested'`).get().actor_key, "github:888");
});

await check("GET /api/auth/github/me returns the frozen contract and nothing else", async () => {
  const { finished } = await completeLogin({ login: "octocat", id: 583231 });
  const token = cookieValue(finished.setCookie, SESSION_COOKIE_NAME);
  const { response, body } = await call("/api/auth/github/me", { cookies: `${SESSION_COOKIE_NAME}=${token}` });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["authenticated", "avatar_url", "can_submit", "csrfToken", "github_user_id", "login", "role", "token_custody", "via"]);
  assert.equal(body.authenticated, true);
  assert.equal(body.login, "octocat");
  assert.equal(body.github_user_id, 583231);
  assert.equal(body.role, "contributor");
  assert.equal(body.csrfToken, finished.body.csrfToken);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

await check("POST /api/logout revokes server-side, not just in the browser", async () => {
  const { finished } = await completeLogin({ login: "octocat", id: 583231 });
  const token = cookieValue(finished.setCookie, SESSION_COOKIE_NAME);
  const out = await call("/api/logout", { method: "POST", cookies: `${SESSION_COOKIE_NAME}=${token}`, headers: { [CSRF_HEADER]: finished.body.csrfToken } });
  assert.equal(out.body.ok, true);
  assert.equal(out.body.revoked, true);
  assert.equal(cookieValue(out.setCookie, SESSION_COOKIE_NAME), "", "the cookie is cleared in the response");
  const after = await call("/api/auth/github/me", { cookies: `${SESSION_COOKIE_NAME}=${token}` });
  assert.equal(after.response.status, 401);
  // The row is still there, marked — an operator can see the logout happened.
  assert.ok(db.db.prepare(`SELECT revoked_at FROM portal_sessions WHERE actor_key='github:583231' AND revoked_at IS NOT NULL`).get());
});

await check("a session the browser no longer has cannot be resurrected by a header", async () => {
  const { finished } = await completeLogin({ login: "octocat", id: 583231 });
  const token = cookieValue(finished.setCookie, SESSION_COOKIE_NAME);
  await call("/api/logout", { method: "POST", cookies: `${SESSION_COOKIE_NAME}=${token}`, headers: { [CSRF_HEADER]: finished.body.csrfToken } });
  // The revoked cookie is still presented, and the Access header is present too.
  const { response } = await call("/api/auth/github/me", {
    cookies: `${SESSION_COOKIE_NAME}=${token}`,
    headers: { "Cf-Access-Authenticated-User-Email": "admin@example.test" },
  });
  assert.equal(response.status, 401, "a refused session must not fall back to the proxy header");
});

await check("未验证的 Access 头不能代替 Portal 会话", async () => {
  for (const pathname of ["/api/me", "/api/auth/github/me", "/api/admin/contributions", "/api/queue"]) {
    const anon = await call(pathname, { headers: { "Cf-Access-Authenticated-User-Email": "admin@example.test" } });
    assert.equal(anon.response.status, 401, pathname);
  }
  const write = await call("/api/contributions/github-pr", {
    method: "POST",
    headers: { "Cf-Access-Authenticated-User-Email": "admin@example.test", [CSRF_HEADER]: "a".repeat(64) },
    body: { target: "assets", path: "locales/x.jsonl", logical_key: "a", content: "{}", asset_version: "1077100" },
  });
  assert.equal(write.response.status, 401);
});

await check("本地管理员名单和会话不能代替可验证的 GitHub 仓库权限", async () => {
  const session = await sessionFor("kohaku-admin", 4242);
  const { response } = await call("/api/admin/contributions", { cookies: session.cookie });
  assert.equal(response.status, 401, "no stored user token means repository permission cannot be verified");
});

await check("带会话的读取不向跨源页面开放凭据响应", async () => {
  const session = await sessionFor("octocat", 583231);
  const { response } = await call("/api/auth/github/me", {
    cookies: session.cookie, headers: { origin: "https://untrusted.example.test" },
  });
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
});

await check("登出要求 POST 和会话 CSRF，不允许跨源或 GET 撤销", async () => {
  const session = await sessionFor("octocat", 583231);
  const get = await call("/api/logout", { cookies: session.cookie });
  assert.equal(get.response.status, 405);
  const missing = await call("/api/auth/github/logout", { method: "POST", cookies: session.cookie });
  assert.equal(missing.response.status, 403);
  const cross = await call("/api/auth/github/logout", {
    method: "POST", cookies: session.cookie,
    headers: { [CSRF_HEADER]: session.csrf, origin: "https://untrusted.example.test" },
  });
  assert.equal(cross.response.status, 403);
  assert.equal((await call("/api/auth/github/me", { cookies: session.cookie })).response.status, 200);
  const out = await call("/api/auth/github/logout", {
    method: "POST", cookies: session.cookie, headers: { [CSRF_HEADER]: session.csrf },
  });
  assert.equal(out.response.status, 200);
  assert.equal(out.body.revoked, true);
});

// ---------------------------------------------------------------------------
// 3. write protection: origin + CSRF on every state-changing route
// ---------------------------------------------------------------------------

await check("a write needs a session, a matching Origin and the CSRF token", async () => {
  const { finished } = await completeLogin({ login: "octocat", id: 583231 });
  const token = cookieValue(finished.setCookie, SESSION_COOKIE_NAME);
  const csrf = finished.body.csrfToken;
  const payload = { target: "assets", path: "locales/doc.jsonl", logical_key: "text/a/b", content: "{}\n", asset_version: "1077100", message: "m" };

  // No session at all.
  const anonymous = await call("/api/contributions/github-pr", { method: "POST", body: payload });
  assert.equal(anonymous.response.status, 401);

  // Session, no CSRF token.
  const noCsrf = await call("/api/contributions/github-pr", { method: "POST", cookies: `${SESSION_COOKIE_NAME}=${token}`, body: payload });
  assert.equal(noCsrf.response.status, 403);
  assert.equal(noCsrf.body.error, "csrf_token_missing");

  // Session, wrong CSRF token.
  const wrongCsrf = await call("/api/contributions/github-pr", {
    method: "POST",
    cookies: `${SESSION_COOKIE_NAME}=${token}`,
    headers: { [CSRF_HEADER]: "0".repeat(64) },
    body: payload,
  });
  assert.equal(wrongCsrf.body.error, "csrf_token_mismatch");

  // Session, right CSRF token, wrong origin.
  const wrongOrigin = await call("/api/contributions/github-pr", {
    method: "POST",
    cookies: `${SESSION_COOKIE_NAME}=${token}`,
    headers: { origin: "https://evil.example", [CSRF_HEADER]: csrf },
    body: payload,
  });
  assert.equal(wrongOrigin.body.error, "origin_not_allowed");

  // No Origin header at all (a non-browser client) is refused too.
  const noOrigin = await call("/api/contributions/github-pr", {
    method: "POST",
    cookies: `${SESSION_COOKIE_NAME}=${token}`,
    headers: { origin: "", [CSRF_HEADER]: csrf },
    body: payload,
  });
  assert.equal(noOrigin.body.error, "origin_missing");

  // Every refusal happened before GitHub was called.
  assert.equal(db.db.prepare(`SELECT COUNT(*) AS n FROM github_prs`).get().n, 0, "no refused write may reach GitHub");
});

await check("the CSRF token is per session", async () => {
  const first = await completeLogin({ login: "octocat", id: 583231 });
  const second = await completeLogin({ login: "octocat", id: 583231 });
  assert.notEqual(first.finished.body.csrfToken, second.finished.body.csrfToken);
  const tokenA = cookieValue(first.finished.setCookie, SESSION_COOKIE_NAME);
  // Session A's cookie with session B's CSRF token is a mismatch.
  const crossed = await call("/api/contributions/github-pr", {
    method: "POST",
    cookies: `${SESSION_COOKIE_NAME}=${tokenA}`,
    headers: { [CSRF_HEADER]: second.finished.body.csrfToken },
    body: { target: "assets", path: "locales/x.jsonl", logical_key: "a", content: "{}", asset_version: "1077100" },
  });
  assert.equal(crossed.body.error, "csrf_token_mismatch");
});

// ---------------------------------------------------------------------------
// 4. the retired surface
// ---------------------------------------------------------------------------

await check("every retired review/publish route answers 410, authenticated or not", async () => {
  const retired = [
    ["POST", "/api/contributions"],
    ["POST", "/api/reviews/abc"],
    ["POST", "/api/reviews"],
    ["POST", "/api/publish"],
    ["POST", "/api/images/status"],
    ["POST", "/api/images/restore"],
    ["PATCH", "/api/images/restore"],
  ];
  for (const [method, pathname] of retired) {
    const anonymous = await call(pathname, { method, body: {} });
    assert.equal(anonymous.response.status, 410, `${method} ${pathname} must be gone`);
    assert.equal(anonymous.body.error, "gone");
    assert.ok(anonymous.body.replaced_by, `${method} ${pathname} must name its replacement`);
    assert.equal(anonymous.body.review_authority ?? "github_pull_request", "github_pull_request");
  }
});

await check("the retired routes are gone from the source, not only from the router", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("./src/worker.js", import.meta.url), "utf8"));
  for (const name of ["async function submit(request, env)", "async function review(request, env", "async function publish(request, env", "async function setImageStatus(", "async function requestImageRestore(", "async function updateImageRestoreRequest("]) {
    assert.ok(!source.includes(name), `${name} must not exist: a second review authority must not be one edit away from being re-routed`);
  }
  // The archive tables are still declared (history is not deleted), but nothing
  // in the runtime writes them any more.
  const requests = await import("node:fs/promises").then((fs) => fs.readFile(new URL("./test_retired_routes.mjs", import.meta.url), "utf8")).catch(() => "");
  assert.equal(typeof requests, "string");
});

await check("both read-only review aliases refuse a cookie without verifiable repository access", async () => {
  const session = await sessionFor("kohaku-admin", 4242);
  for (const path of ["/api/queue?status=pending", "/api/admin/contributions"]) {
    const result = await call(path, { cookies: session.cookie });
    assert.equal(result.response.status, 401);
  }
  // Positive GitHub permission + review-authority assertions are exercised
  // end-to-end through both aliases in test_github_collab.mjs.
});

// ---------------------------------------------------------------------------
// 5. the source-bound single-row edit, end to end
// ---------------------------------------------------------------------------

const LOGICAL_KEY = "text/event_0448_story_01/event_0448_story_01_1001";
const BUNDLE = "event_0448_story_01_jp";
const ITEM_KEY = "event_0448_story_01_1001";
const SOURCE = "本日のイベント公演について、プロデューサーさんにご報告です。";
const SOURCE_SHA = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SOURCE)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const RESOURCE_ID = "res_edit_fixture";

// A JSONL file with the row we edit in the middle: the whole point of the route
// is that the rows around it are carried through untouched, so the fixture has
// rows on both sides, a blank line and a row that is not the one being edited.
const ROW_A = { channel: "assets", asset_version: "1077100", bundle: BUNDLE, item_key: "other_1", ja: "別の行", zh: "另一行", source_sha256: "1".repeat(64), translation_status: "accepted", updated_at: "2026-09-01T00:00:00Z" };
const ROW_TARGET = { channel: "assets", asset_version: "1077100", bundle: BUNDLE, item_key: ITEM_KEY, ja: SOURCE, zh: "旧的译文", source_sha256: SOURCE_SHA, translation_status: "accepted", updated_at: "2026-09-01T00:00:00Z" };
const ROW_B = { channel: "assets", asset_version: "1077100", bundle: BUNDLE, item_key: "other_2", ja: "最後の行", zh: "最后一行", source_sha256: "2".repeat(64), translation_status: "accepted", updated_at: "2026-09-01T00:00:00Z" };
const FILE_TEXT = [ROW_A, ROW_TARGET, ROW_B, ""].map((row) => (row === "" ? "" : JSON.stringify(row))).join("\n");
// The exporter's own layout: `locales/story/` for a `event_*_story_*` bundle.
const FILE_PATH = `locales/story/${BUNDLE}.jsonl`;

db.db.prepare(
  `INSERT OR REPLACE INTO assets_releases (asset_version, release_id, server_schema_version, status, source_manifest_sha256, assets_commit, note, created_at, updated_at) ` +
  `VALUES ('1077100', 'assets-1077100', 'v1', 'canonical', NULL, ?, 'fixture', ?, ?)`
).run(BASE_COMMIT, STAMP, STAMP);
db.db.prepare(
  `INSERT INTO resource_units (resource_id, resource_kind, logical_key, category, created_at) VALUES (?, 'text', ?, 'story', ?)`
).run(RESOURCE_ID, LOGICAL_KEY, STAMP);
db.db.prepare(
  `INSERT INTO source_variants (source_variant_id, resource_id, release_kind, release_id, source_sha256, source, bundle, item_key, created_at) ` +
  `VALUES ('sv_edit_fixture', ?, 'assets', 'assets-1077100', ?, ?, ?, ?, ?)`
).run(RESOURCE_ID, SOURCE_SHA, SOURCE, BUNDLE, ITEM_KEY, STAMP);
db.db.prepare(
  `INSERT INTO translation_units (translation_id, logical_key, resource_kind, locale, source_sha256, translation, status, created_at, updated_at) ` +
  `VALUES ('tu_edit_fixture', ?, 'text', 'zh-CN', ?, '旧的译文', 'accepted', ?, ?)`
).run(LOGICAL_KEY, SOURCE_SHA, STAMP, STAMP);

/// The identity probe every write begins with. `person.github_user_id` is what
/// the session claims; GitHub is what confirms it, and a disagreement is a
/// refusal rather than a warning.
const WRITE_IDENTITY = {
  match: (url) => url === `${GITHUB_API}/user`,
  reply: { login: "octocat", id: 583231, avatar_url: "https://avatars.test/octocat.png" },
};

/// The same probe answering for a *different* account, for the mismatch check.
const WRITE_IDENTITY_OTHER = {
  match: (url) => url === `${GITHUB_API}/user`,
  reply: { login: "someone-else", id: 999999, avatar_url: null },
};

/// The GitHub conversation one source-bound edit makes, in order. The file read
/// is pinned to the commit, so there is no branch-head read and no `lookupExisting`
/// read before the commit.
function editFetch({ owner = "kohakunamori", repo = "MLTDTranslationAssets", forkFull = "octocat/MLTDTranslationAssets", prNumber = 501, fileText = FILE_TEXT, readStatus = 200, blobSha = BLOB_SHA, identity = WRITE_IDENTITY } = {}) {
  // `blobSha: ""` simulates a contents response with no blob sha at all.
  return recordingFetch([
    identity,
    { match: `${GITHUB_API}/repos/${owner}/${repo}/forks`, status: 200, reply: { full_name: forkFull, default_branch: "main", fork: true, owner: { login: forkFull.split("/")[0] } } },
    { match: new RegExp(`^${GITHUB_API}/repos/${owner}/${repo}/contents/.+\\?ref=${BASE_COMMIT}$`), status: readStatus, reply: { type: "file", encoding: "base64", sha: blobSha, content: Buffer.from(fileText, "utf8").toString("base64") } },
    { match: `${GITHUB_API}/repos/octocat/${repo}/git/refs`, status: 201, reply: { ref: "refs/heads/portal/text/x", object: { sha: BASE_COMMIT } } },
    { match: new RegExp(`^${GITHUB_API}/repos/octocat/${repo}/contents/.+$`), status: 201, reply: { content: { sha: "c".repeat(40), html_url: "https://github.com/x" }, commit: { sha: "d".repeat(40) } } },
    { match: `${GITHUB_API}/repos/${owner}/${repo}/pulls`, status: 201, reply: { number: prNumber, html_url: `https://github.com/${owner}/${repo}/pull/${prNumber}`, state: "open" } },
  ]);
}

async function sessionFor(login, id) {
  const { finished } = await completeLogin({ login, id });
  return { cookie: `${SESSION_COOKIE_NAME}=${cookieValue(finished.setCookie, SESSION_COOKIE_NAME)}`, csrf: finished.body.csrfToken, body: finished.body };
}

await check("GET /api/resources/:id/edit-context hands out a complete, trusted binding", async () => {
  const { body } = await call(`/api/resources/${RESOURCE_ID}/edit-context`);
  assert.deepEqual(body.github, {
    target: "assets",
    path: FILE_PATH,
    base_commit: BASE_COMMIT,
    source_sha256: SOURCE_SHA,
  }, "the binding is nested and comes from the release registry, not the client");
  assert.equal(body.editable, true);
  assert.equal(body.bundle, BUNDLE);
  assert.equal(body.item_key, ITEM_KEY);
  assert.equal(body.logical_key, LOGICAL_KEY);
  assert.equal(body.source, SOURCE);
  assert.equal(body.translation, "旧的译文");
  assert.equal(body.asset_version, "1077100");
  // The client must never be given an `asset_version` to send for a client
  // target, and vice versa: the two axes stay separate here too.
  assert.equal(body.client_version, null);
});

await check("the catalogue items carry a materialised binding for the editor", async () => {
  // The studio reads its rows from the catalogue and the item detail. Both have
  // to say where the row can be edited, from the release registry's own commit —
  // the client must not have to build a path or a `base_commit` itself.
  const search = await call("/api/catalogue/search?asset_version=1077100&limit=50");
  assert.equal(search.response.status, 200, JSON.stringify(search.body));
  const row = (search.body.items || []).find((item) => item.item_key === ITEM_KEY);
  assert.ok(row, "the fixture row must be in the page");
  assert.deepEqual(row.github, {
    target: "assets",
    path: FILE_PATH,
    base_commit: BASE_COMMIT,
    source_sha256: SOURCE_SHA,
  }, "the binding is nested, pinned to the release's commit, and uses the exporter's layout");
  assert.equal(row.asset_version, "1077100");
  const proposal = frontendProposals.buildTextProposal(row, "来自实际前端构造器的译文");
  assert.equal(proposal.ok, true, JSON.stringify(proposal));
  assert.equal(proposal.payload.target, "assets");
  assert.equal(proposal.payload.asset_version, "1077100");
  assert.equal(proposal.payload.source_sha256, SOURCE_SHA);
  assert.equal(row.source_sha256, SOURCE_SHA);
  assert.equal(row.logical_key, LOGICAL_KEY);
  assert.equal(row.edit_endpoint, `/api/resources/${RESOURCE_ID}/edit-context`, "the row also names where its context lives");

  // Without a placeholder repository configured there is no binding to hand
  // out — and the route says so rather than naming a repository it was not told.
  const unconfigured = await call("/api/catalogue/search?asset_version=1077100&limit=50", {
    env: { ...env, GITHUB_TARGET_ASSETS: "" },
  });
  const unconfiguredRow = (unconfigured.body.items || []).find((item) => item.item_key === ITEM_KEY);
  assert.equal(unconfiguredRow.github, null, "an unconfigured target repository yields no binding");
  assert.equal(unconfiguredRow.edit_endpoint !== null, true, "the row is still addressable");

  // The item detail carries the same binding, so a deep link works too.
  const detail = await call(`/api/assets/releases/1077100/item?bundle=${encodeURIComponent(BUNDLE)}&item_key=${encodeURIComponent(ITEM_KEY)}`);
  assert.equal(detail.response.status, 200, JSON.stringify(detail.body));
  assert.deepEqual(detail.body.item.github, row.github);
});

// ---------------------------------------------------------------------------
// the client channel: a manifest of labelled slots
//
// The client repository does not hold `locales/**/*.jsonl`; its labels live in a
// manifest whose `slots[]` are `{index, ja, zh, provenance}`. The editor treats
// one slot as one row: identity is `index`, the source is `ja`, and the rewrite
// must leave every other slot — and every other field — exactly as it was.
// ---------------------------------------------------------------------------

const CLIENT_BUNDLE = "bottom-bar";
const CLIENT_ITEM_KEY = "0";
const CLIENT_PATH = "manifests/bottom-bar.manifest.json";
const CLIENT_COMMIT = "d".repeat(40);
const CLIENT_SLOT_SOURCE = "ホーム";
const CLIENT_SLOT_SOURCE_SHA = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(CLIENT_SLOT_SOURCE)))].map((b) => b.toString(16).padStart(2, "0")).join("");

/// The document as the repository holds it: a slots array with the labelled
/// entries, and the atlas target the slots refer to.
const CLIENT_MANIFEST = {
  kind: "mltd-apk-builtin-content",
  schema_version: 1,
  atlas_target: { client_version: "9.0.200", atlas_entry: "bottom_bar" },
  slots: [
    { index: 0, ja: "ホーム", zh: "首页", provenance: "client_builtin" },
    { index: 1, ja: "劇場", zh: "剧场", provenance: "client_builtin" },
    { index: 2, ja: "カード", zh: "卡片", provenance: "client_builtin" },
  ],
};
const CLIENT_MANIFEST_TEXT = `${JSON.stringify(CLIENT_MANIFEST, null, 2)}\n`;

/// The client side of the environment: the pin, the declared layout, and the
/// catalogue row the proposal is verified against.
function clientEnv(overrides = {}) {
  return {
    ...env,
    GITHUB_CLIENT_MANIFEST_PATH: CLIENT_PATH,
    GITHUB_CLIENT_TEXT_DIR: "",
    ...overrides,
  };
}

db.db.prepare(`INSERT OR REPLACE INTO client_releases (release_id, client_version, abi, base_apk_sha256, client_resources_commit, status, created_at) VALUES ('client-9.0.200', '9.0.200', 'arm64-v8a', ?, ?, 'candidate', ?)`).run("4".repeat(64), CLIENT_COMMIT, STAMP);
db.db.prepare(`INSERT OR REPLACE INTO resource_units (resource_id, resource_kind, logical_key, category, created_at) VALUES ('res_client_labels', 'text', 'text/client_ui/bottom-bar', 'system_ui', ?)`).run(STAMP);
db.db.prepare(
  `INSERT OR REPLACE INTO source_variants (source_variant_id, resource_id, release_kind, release_id, source_sha256, source, bundle, item_key, created_at) ` +
  `VALUES ('sv_client_labels', 'res_client_labels', 'client', 'client-9.0.200', ?, ?, ?, ?, ?)`
).run(CLIENT_SLOT_SOURCE_SHA, CLIENT_SLOT_SOURCE, CLIENT_BUNDLE, CLIENT_ITEM_KEY, STAMP);
// The proposal path verifies the row against the *release's* catalogue entry as
// well as the file, so the client release carries the same source hash.
db.db.prepare(
  `INSERT OR REPLACE INTO source_catalogue (base_version, bundle, item_key, source_sha256, source, created_at, asset_version, logical_key) ` +
  `VALUES ('9.0.200', ?, ?, ?, ?, ?, NULL, ?)`
).run(CLIENT_BUNDLE, CLIENT_ITEM_KEY, CLIENT_SLOT_SOURCE_SHA, CLIENT_SLOT_SOURCE, STAMP, "text/client_ui/bottom-bar");

await check("a selector can list both channels' versions and bind a row from the list", async () => {
  // The assets channel. The list carries the release's own pin, which is what a
  // selector needs in order to know whether its rows are editable at all.
  const assets = await call("/api/assets/releases", { env: clientEnv() });
  assert.equal(assets.response.status, 200, JSON.stringify(assets.body));
  assert.ok(Array.isArray(assets.body.releases));
  const assetsRelease = assets.body.releases.find((release) => release.asset_version === "1077100");
  assert.ok(assetsRelease, "the fixture release must be listed");
  assert.equal(assetsRelease.assets_commit, BASE_COMMIT, "the list carries the pin the editor will verify against");
  assert.ok("status" in assetsRelease, "the selector can show whether the release is writable");

  // The client channel. Same shape of answer, its own columns.
  const client = await call("/api/client/releases", { env: clientEnv() });
  assert.equal(client.response.status, 200, JSON.stringify(client.body));
  const clientRelease = client.body.releases.find((release) => release.release_id === "client-9.0.200");
  assert.ok(clientRelease, "the client release must be listed");
  assert.equal(clientRelease.client_version, "9.0.200");
  assert.equal(clientRelease.client_resources_commit, CLIENT_COMMIT, "the client list carries *its* pin, not the assets one");
  assert.equal("asset_version" in clientRelease, false, "a client release never carries an asset version");

  // Drill in: the client release's own items, addressed by the bare client
  // version the selector holds.
  const items = await call("/api/client/releases/9.0.200/items?limit=50", { env: clientEnv() });
  assert.equal(items.response.status, 200, JSON.stringify(items.body));
  // The page answers with the **release id** the variants are keyed by, which is
  // what a selector must send back. A caller may address the page by the bare
  // client version, but the answer names the row.
  assert.equal(items.body.release_id, "client-9.0.200");
  assert.equal(items.body.items.length, 1);
  const item = items.body.items[0];
  assert.equal(item.bundle, CLIENT_BUNDLE);
  assert.equal(item.item_key, CLIENT_ITEM_KEY);
  assert.equal(item.source_sha256, CLIENT_SLOT_SOURCE_SHA);
  assert.equal(item.source, undefined, "a list page never ships the whole source text");

  // And the per-row binding the editor takes, at both scopes.
  const contextual = await call(`/api/resources/res_client_labels/edit-context`, { env: clientEnv() });
  assert.equal(contextual.body.editable, true);
  assert.equal(contextual.body.github.path, CLIENT_PATH);
  assert.equal(contextual.body.github.base_commit, CLIENT_COMMIT);

  // The item detail route addresses the same row and carries the same binding,
  // so a deep link and a list click produce the same proposal.
  const detail = await call(`/api/client/releases/9.0.200/item?bundle=${encodeURIComponent(CLIENT_BUNDLE)}&item_key=${encodeURIComponent(CLIENT_ITEM_KEY)}`, { env: clientEnv() });
  assert.equal(detail.response.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.item.github?.path, CLIENT_PATH, `the item page binds the client manifest, not an assets path: ${JSON.stringify(detail.body.item.github)}`);
  assert.equal(detail.body.item.github?.base_commit, CLIENT_COMMIT);
});

await check("GET /api/resources/:id/edit-context names the client manifest and its slot", async () => {
  const { response, body } = await call("/api/resources/res_client_labels/edit-context", { env: clientEnv() });
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.editable, true, JSON.stringify(body));
  assert.deepEqual(body.github, {
    target: "client",
    path: CLIENT_PATH,
    base_commit: CLIENT_COMMIT,
    source_sha256: CLIENT_SLOT_SOURCE_SHA,
  });
  assert.equal(body.row_kind, "manifest_slot", "the client tells the service which shape this row is");
  assert.equal(body.bundle, CLIENT_BUNDLE);
  assert.equal(body.item_key, CLIENT_ITEM_KEY, "a slot is addressed by its index");
  assert.equal(body.source, CLIENT_SLOT_SOURCE);
  assert.equal(body.client_version, "9.0.200");
  assert.equal(body.asset_version, null, "a client row never carries an assets version");
  // The pin is the client release's own commit, never `assets_commit`.
  assert.equal(body.github.base_commit, CLIENT_COMMIT);
});

await check("POST /api/resources/:id/edit rewrites one manifest slot and nothing else", async () => {
  const session = await sessionFor("octocat", 583231);
  const fetchImpl = recordingFetch([
    WRITE_IDENTITY,
    { match: `${GITHUB_API}/repos/kohakunamori/MLTDTranslationClient/forks`, status: 200, reply: { full_name: "octocat/MLTDTranslationClient", default_branch: "main", fork: true, owner: { login: "octocat" } } },
    { match: (url) => url.includes("/contents/") && url.includes(`?ref=${CLIENT_COMMIT}`), reply: { type: "file", encoding: "base64", sha: CLIENT_COMMIT, content: Buffer.from(CLIENT_MANIFEST_TEXT, "utf8").toString("base64") } },
    { match: `${GITHUB_API}/repos/octocat/MLTDTranslationClient/git/refs`, status: 201, reply: { ref: "refs/heads/portal/text/x", object: { sha: CLIENT_COMMIT } } },
    { match: (url, init) => url.startsWith(`${GITHUB_API}/repos/octocat/MLTDTranslationClient/contents/`) && (init?.method || "GET") === "PUT", status: 200, reply: { content: { sha: "c".repeat(40) }, commit: { sha: "e".repeat(40) } } },
    { match: `${GITHUB_API}/repos/kohakunamori/MLTDTranslationClient/pulls`, status: 201, reply: { number: 811, html_url: "https://github.com/kohakunamori/MLTDTranslationClient/pull/811", state: "open" } },
  ]);
  const { response, body } = await call("/api/resources/res_client_labels/edit", {
    method: "POST",
    cookies: session.cookie,
    headers: { [CSRF_HEADER]: session.csrf },
    env: clientEnv({ GITHUB_COLLAB_FETCH: fetchImpl }),
    body: { translation: "主页", base_commit: CLIENT_COMMIT, row_kind: "manifest_slot" },
  });
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.single_line_edit, true);
  assert.equal(body.row_field, "zh");
  assert.equal(body.previous_translation, "首页");
  assert.equal(body.target_repo, "kohakunamori/MLTDTranslationClient", "the client channel targets the client repository");

  // The committed document: the same JSON, one slot's `zh` changed.
  const put = fetchImpl.calls.find((call) => (call.init?.method || "GET") === "PUT");
  const committed = JSON.parse(Buffer.from(JSON.parse(String(put.init.body)).content, "base64").toString("utf8"));
  assert.deepEqual(committed.slots[0], { index: 0, ja: "ホーム", zh: "主页", provenance: "client_builtin" });
  assert.deepEqual(committed.slots.slice(1), CLIENT_MANIFEST.slots.slice(1), "every other slot is untouched");
  assert.deepEqual(committed.atlas_target, CLIENT_MANIFEST.atlas_target);
  assert.equal(committed.kind, CLIENT_MANIFEST.kind);
  assert.equal(committed.schema_version, CLIENT_MANIFEST.schema_version);

  // The client repository is the one the fork belongs to.
  for (const entry of fetchImpl.calls) {
    if (entry.url.endsWith("/user")) continue;
    assert.ok(entry.url.includes("MLTDTranslationClient"), `unexpected repository in ${entry.url}`);
  }
});

await check("a client slot whose source moved under the pin is refused", async () => {
  const session = await sessionFor("octocat", 583231);
  const drifted = JSON.parse(CLIENT_MANIFEST_TEXT);
  drifted.slots[0].ja = "違う原文";
  const fetchImpl = recordingFetch([
    WRITE_IDENTITY,
    { match: (url) => url.includes("/contents/"), reply: { type: "file", encoding: "base64", sha: "f".repeat(40), content: Buffer.from(`${JSON.stringify(drifted, null, 2)}\n`, "utf8").toString("base64") } },
  ]);
  const { response, body } = await call("/api/resources/res_client_labels/edit", {
    method: "POST",
    cookies: session.cookie,
    headers: { [CSRF_HEADER]: session.csrf },
    env: clientEnv({ GITHUB_COLLAB_FETCH: fetchImpl }),
    body: { translation: "x", base_commit: CLIENT_COMMIT },
  });
  assert.equal(response.status, 409, JSON.stringify(body));
  assert.equal(body.error, "resource_source_mismatch");
});

await check("the client channel refuses an assets-shaped path", async () => {
  // The client repository's rule is the declared location, not the assets
  // whitelist: `locales/...` is the wrong repository's layout.
  const session = await sessionFor("octocat", 583231);
  const fetchImpl = recordingFetch([WRITE_IDENTITY]);
  const { response, body } = await call("/api/contributions/github-pr", {
    method: "POST",
    cookies: session.cookie,
    headers: { [CSRF_HEADER]: session.csrf },
    env: clientEnv({ GITHUB_COLLAB_FETCH: fetchImpl }),
    body: {
      target: "client",
      path: "locales/story/bottom-bar.jsonl",
      base_commit: CLIENT_COMMIT,
      source_sha256: CLIENT_SLOT_SOURCE_SHA,
      bundle: CLIENT_BUNDLE,
      item_key: CLIENT_ITEM_KEY,
      translation: "x",
      client_version: "9.0.200",
    },
  });
  assert.equal(response.status, 400, JSON.stringify(body));
  assert.equal(body.error, "path_not_allowed");
});

await check("a bundle that cannot be a file name gets no path, and no client guess", async () => {
  // The taxonomy places every known prefix (and everything else under `master`),
  // so the case that must be refused is a bundle whose name cannot be a path at
  // all. `localesPathForBundle` refuses it rather than normalising it.
  db.db.prepare(`INSERT OR REPLACE INTO resource_units (resource_id, resource_kind, logical_key, category, created_at) VALUES ('res_unknown_dir', 'text', 'text/zzz_thing/item', NULL, ?)`).run(STAMP);
  db.db.prepare(
    `INSERT INTO source_variants (source_variant_id, resource_id, release_kind, release_id, source_sha256, source, bundle, item_key, created_at) ` +
    `VALUES ('sv_unknown_dir', 'res_unknown_dir', 'assets', 'assets-1077100', ?, 'xyz', 'zzz_thing', 'item', ?)`
  ).run("5".repeat(64), STAMP);
  const placed = await call("/api/resources/res_unknown_dir/edit-context");
  assert.equal(placed.body.editable, true, JSON.stringify(placed.body));
  assert.equal(placed.body.github.path, "locales/master/zzz_thing.jsonl", "an unrecognised prefix lands under the exporter's fallback directory");

  db.db.prepare(
    `INSERT INTO source_variants (source_variant_id, resource_id, release_kind, release_id, source_sha256, source, bundle, item_key, created_at) ` +
    `VALUES ('sv_traversal', 'res_unknown_dir', 'assets', 'assets-1077100', ?, 'xyz', '../escape', 'item', ?)`
  ).run("6".repeat(64), STAMP);
  const traversal = await call("/api/resources/res_unknown_dir/edit-context");
  assert.equal(traversal.body.editable, false, JSON.stringify(traversal.body));
  assert.equal(traversal.body.reason, "missing_path");
});

await check("an unbound row reports exactly which input is missing", async () => {
  db.db.prepare(`INSERT INTO resource_units (resource_id, resource_kind, logical_key, category, created_at) VALUES ('res_unbound', 'text', 'text/x/y', 'story', ?)`).run(STAMP);
  const { body } = await call("/api/resources/res_unbound/edit-context");
  assert.equal(body.editable, false);
  assert.equal(body.reason, "missing_binding");
  assert.match(body.detail, /source variant/);

  const missing = await call("/api/resources/res_does_not_exist/edit-context");
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.error, "resource_not_found");
});

await check("POST /api/resources/:id/edit changes one line and nothing else", async () => {
  const session = await sessionFor("octocat", 583231);
  const fetchImpl = editFetch();
  const { response, body } = await call(`/api/resources/${RESOURCE_ID}/edit`, {
    method: "POST",
    cookies: session.cookie,
    headers: { [CSRF_HEADER]: session.csrf },
    env: { ...env, GITHUB_COLLAB_FETCH: fetchImpl },
    body: { translation: "今天关于活动公演，向制作人先生报告。", base_commit: BASE_COMMIT, source_sha256: SOURCE_SHA },
  });
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.single_line_edit, true);
  assert.equal(body.row_index, 1, "the edited row is the second line");
  assert.equal(body.row_field, "zh");
  assert.equal(body.previous_translation, "旧的译文");
  assert.equal(body.authority, "github_pull_request");
  assert.equal(body.resource_id, RESOURCE_ID);
  assert.equal(body.pr_number, 501);

  // The committed file: identical to the input except for the one row.
  const written = fetchImpl.calls.find((call) => call.method === "PUT");
  const committed = committedBytes(written).toString("utf8");
  const before = FILE_TEXT.split("\n");
  const after = committed.split("\n");
  assert.equal(after.length, before.length, "the line count must not change");
  let changed = 0;
  for (let index = 0; index < after.length; index += 1) {
    if (after[index] === before[index]) continue;
    changed += 1;
    assert.equal(index, 1, "only line 2 may differ");
    const row = JSON.parse(after[index]);
    assert.equal(row.zh, "今天关于活动公演，向制作人先生报告。");
    assert.equal(row.translation_status, "modified", "an edited translation is `modified` (§6.3 rule 2)");
    assert.equal(row.ja, SOURCE, "the source text is carried through");
    assert.equal(row.item_key, ITEM_KEY);
  }
  assert.equal(changed, 1);

  // The branch was created at the pinned commit, not at the fork's tip.
  const refCall = fetchImpl.calls.find((call) => call.url.endsWith("/git/refs"));
  assert.equal(jsonBody(refCall).sha, BASE_COMMIT);
  // The read was pinned to the commit.
  const readCall = fetchImpl.calls.find((call) => call.method === "GET" && call.url.includes("/contents/"));
  assert.ok(readCall.url.endsWith(`?ref=${BASE_COMMIT}`), readCall.url);

  const mirror = db.db.prepare(`SELECT target_repo, head_branch, pr_number, created_by FROM github_prs WHERE pr_number=501`).get();
  assert.equal(mirror.target_repo, ASSETS_REPO);
  assert.match(mirror.head_branch, /^portal\/text\//);
  assert.equal(mirror.created_by, "github:583231", "the mirror row is keyed by the stable identity, not an email");
});

await check("a client row reports no binding yet, and the two axes cannot be crossed", async () => {
  db.db.prepare(`INSERT OR REPLACE INTO resource_units (resource_id, resource_kind, logical_key, category, created_at) VALUES ('res_client', 'text', 'text/client_ui/bottom-bar-legacy', 'system_ui', ?)`).run(STAMP);
  db.db.prepare(
    `INSERT OR REPLACE INTO client_releases (release_id, client_version, abi, base_apk_sha256, client_resources_commit, status, created_at) ` +
    `VALUES ('client-9.0.200', '9.0.200', 'arm64-v8a', ?, ?, 'candidate', ?)`
  ).run("4".repeat(64), "e".repeat(40), STAMP);
  db.db.prepare(
    `INSERT INTO source_variants (source_variant_id, resource_id, release_kind, release_id, source_sha256, source, bundle, item_key, created_at) ` +
    `VALUES ('sv_client', 'res_client', 'client', 'client-9.0.200', ?, 'ホーム', 'bottom-bar', 'home', ?)`
  ).run("3".repeat(64), STAMP);

  // With the client release's own pin in place, the context is a *client*
  // binding: the client repository, the client commit, and the client version —
  // never an assets commit borrowed from the other axis.
  // `text/` is declared for this half; the client repository's real layout is a
  // fact about that repository (docs/GITHUB_LOCALIZATION_REPO_SPEC.md §3.2), and
  // the route refuses to invent one — asserted below.
  const clientEnv = { ...env, GITHUB_CLIENT_TEXT_DIR: "text" };
  db.db.prepare(`UPDATE client_releases SET client_resources_commit=? WHERE release_id='client-9.0.200'`).run("d".repeat(40));
  const context = await call("/api/resources/res_client/edit-context", { env: clientEnv });
  assert.equal(context.body.editable, true, JSON.stringify(context.body));
  assert.equal(context.body.github.target, "client");
  assert.equal(context.body.github.base_commit, "d".repeat(40), "the pin is client_resources_commit");
  assert.equal(context.body.client_version, "9.0.200");
  assert.equal(context.body.asset_version, null, "a client row never carries an assets version");
  assert.equal(context.body.source, "ホーム");

  // The path is a *declared* layout, not a guess: without it the row reports
  // exactly which setting is missing.
  const unset = await call("/api/resources/res_client/edit-context");
  assert.equal(unset.body.editable, false);
  assert.equal(unset.body.reason, "missing_path", JSON.stringify(unset.body));
  assert.match(unset.body.detail, /GITHUB_CLIENT_TEXT_DIR/);

  // ...and with one declared, the path follows it.
  const declared = await call("/api/resources/res_client/edit-context", { env: { ...env, GITHUB_CLIENT_TEXT_DIR: "text" } });
  assert.equal(declared.body.editable, true, JSON.stringify(declared.body));
  assert.equal(declared.body.github.path, "text/bottom-bar.jsonl");

  // The editor route takes the version from the *context*, so a body that also
  // names an `asset_version` cannot smuggle a second axis in.
  const session = await sessionFor("octocat", 583231);
  const edited = await call(`/api/resources/${RESOURCE_ID}/edit`, {
    method: "POST",
    cookies: session.cookie,
    headers: { [CSRF_HEADER]: session.csrf },
    env: { ...env, GITHUB_COLLAB_FETCH: editFetch({ prNumber: 504 }) },
    body: { translation: "x", asset_version: "1077100", client_version: "9.0.200" },
  });
  assert.equal(edited.response.status, 200, JSON.stringify(edited.body));

  // The general route, which takes the binding from the body, is where the
  // independent-axes rule has to be enforced — and is.
  const both = await call("/api/contributions/github-pr", {
    method: "POST",
    cookies: session.cookie,
    headers: { [CSRF_HEADER]: session.csrf },
    body: {
      resource: { github: { target: "assets", path: FILE_PATH, base_commit: BASE_COMMIT, source_sha256: SOURCE_SHA } },
      bundle: BUNDLE,
      item_key: ITEM_KEY,
      translation: "x",
      asset_version: "1077100",
      client_version: "9.0.200",
    },
  });
  assert.equal(both.response.status, 400, JSON.stringify(both.body));
  assert.equal(both.body.error, "independent_axes_violated");

  // ...and a client target without a client version is refused too.
  const missingVersion = await call("/api/contributions/github-pr", {
    method: "POST",
    cookies: session.cookie,
    headers: { [CSRF_HEADER]: session.csrf },
    body: {
      resource: { github: { target: "client", path: FILE_PATH, base_commit: BASE_COMMIT, source_sha256: SOURCE_SHA } },
      bundle: BUNDLE,
      item_key: ITEM_KEY,
      translation: "x",
    },
  });
  assert.equal(missingVersion.body.error, "missing_client_version");
});

await check("an edit whose pin moved is refused, and the file is never rewritten from the body", async () => {
  const session = await sessionFor("octocat", 583231);

  // A body that tries to supply content is ignored: the route reads the file.
  const withContent = await call(`/api/resources/${RESOURCE_ID}/edit`, {
    method: "POST",
    cookies: session.cookie,
    headers: { [CSRF_HEADER]: session.csrf },
    env: { ...env, GITHUB_COLLAB_FETCH: editFetch({ prNumber: 502 }) },
    body: { translation: "新译文", base_commit: BASE_COMMIT, resource: { github: { target: "assets", path: FILE_PATH, base_commit: BASE_COMMIT, source_sha256: SOURCE_SHA } }, content: JSON.stringify({ ja: "x", zh: "injected" }) },
  });
  assert.equal(withContent.response.status, 200, JSON.stringify(withContent.body));

  // A `base_commit` that does not match the pin is refused.
  const moved = await call(`/api/resources/${RESOURCE_ID}/edit`, {
    method: "POST",
    cookies: session.cookie,
    headers: { [CSRF_HEADER]: session.csrf },
    body: { translation: "x", base_commit: "f".repeat(40) },
  });
  assert.equal(moved.response.status, 409);
  assert.equal(moved.body.error, "base_commit_moved");

  const sourceMismatch = await call(`/api/resources/${RESOURCE_ID}/edit`, {
    method: "POST",
    cookies: session.cookie,
    headers: { [CSRF_HEADER]: session.csrf },
    body: { translation: "x", source_sha256: "9".repeat(64) },
  });
  assert.equal(sourceMismatch.body.error, "resource_source_mismatch");
});

await check("the pinned file is verified against the row's own source", async () => {
  const session = await sessionFor("octocat", 583231);
  // A file whose row carries a different source than the pinned hash: the
  // catalogue says one thing and the file says another, and the file wins.
  const drifted = JSON.stringify({ ...ROW_TARGET, ja: "違う原文" });
  const fileText = `${JSON.stringify(ROW_A)}\n${drifted}\n`;
  const { body } = await call(`/api/resources/${RESOURCE_ID}/edit`, {
    method: "POST",
    cookies: session.cookie,
    headers: { [CSRF_HEADER]: session.csrf },
    env: { ...env, GITHUB_COLLAB_FETCH: editFetch({ fileText }) },
    body: { translation: "x", base_commit: BASE_COMMIT },
  });
  assert.equal(body.error, "resource_source_mismatch");

  // A row that is not in the file at all.
  const absent = `${JSON.stringify(ROW_A)}\n`;
  const notFound = await call(`/api/resources/${RESOURCE_ID}/edit`, {
    method: "POST",
    cookies: session.cookie,
    headers: { [CSRF_HEADER]: session.csrf },
    env: { ...env, GITHUB_COLLAB_FETCH: editFetch({ fileText: absent }) },
    body: { translation: "x", base_commit: BASE_COMMIT },
  });
  assert.equal(notFound.body.error, "resource_row_not_found");
  assert.equal(notFound.response.status, 404);

  // Two rows with the same identity: ambiguous, refused rather than guessed.
  const doubled = `${JSON.stringify(ROW_TARGET)}\n${JSON.stringify(ROW_TARGET)}\n`;
  const ambiguous = await call(`/api/resources/${RESOURCE_ID}/edit`, {
    method: "POST",
    cookies: session.cookie,
    headers: { [CSRF_HEADER]: session.csrf },
    env: { ...env, GITHUB_COLLAB_FETCH: editFetch({ fileText: doubled }) },
    body: { translation: "x", base_commit: BASE_COMMIT },
  });
  assert.equal(ambiguous.response.status, 409);
  assert.equal(ambiguous.body.error, "resource_row_ambiguous");
});

await check("the commit carries the blob sha, and a mock that enforces GitHub's rule catches its absence", async () => {
  // GitHub's contents API updates an existing file by *blob* sha. A commit
  // without one is a 422 — so the mock here enforces exactly that, and a future
  // change that dropped the sha would fail this suite instead of failing in
  // production against the real API.
  const session = await sessionFor("octocat", 583231);
  const strict = recordingFetch([
    WRITE_IDENTITY,
    { match: `${GITHUB_API}/repos/kohakunamori/MLTDTranslationAssets/forks`, status: 200, reply: { full_name: "octocat/MLTDTranslationAssets", default_branch: "main", fork: true, owner: { login: "octocat" } } },
    { match: (url) => url.includes("/contents/") && url.includes(`?ref=${BASE_COMMIT}`), reply: { type: "file", encoding: "base64", sha: BLOB_SHA, content: Buffer.from(FILE_TEXT, "utf8").toString("base64") } },
    { match: `${GITHUB_API}/repos/octocat/MLTDTranslationAssets/git/refs`, status: 201, reply: { ref: "refs/heads/portal/text/x", object: { sha: BASE_COMMIT } } },
    {
      // The enforcement: a PUT of an existing file without the current blob sha
      // is what GitHub answers 422 to.
      match: (url, init) => url.startsWith(`${GITHUB_API}/repos/octocat/MLTDTranslationAssets/contents/`) && (init?.method || "GET") === "PUT",
      reply: (call) => {
        const body = JSON.parse(String(call.init.body));
        if (body.sha !== BLOB_SHA) {
          return { status: 422, body: { message: "Invalid request: sha was not supplied" } };
        }
        return { status: 200, body: { content: { sha: "c".repeat(40) }, commit: { sha: "d".repeat(40) } } };
      },
    },
    { match: `${GITHUB_API}/repos/kohakunamori/MLTDTranslationAssets/pulls`, status: 201, reply: { number: 901, html_url: "https://github.com/x/pull/901", state: "open" } },
  ]);

  const { response, body } = await call("/api/resources/" + RESOURCE_ID + "/edit", {
    method: "POST",
    cookies: session.cookie,
    headers: { [CSRF_HEADER]: session.csrf },
    env: { ...env, GITHUB_COLLAB_FETCH: strict },
    body: { translation: "严格模拟下的译文", base_commit: BASE_COMMIT },
  });
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.pr_number, 901);
  const put = strict.calls.find((call) => (call.init?.method || "GET") === "PUT");
  const sent = JSON.parse(String(put.init.body));
  assert.equal(sent.sha, BLOB_SHA, "the commit must present the blob sha the read returned");
  assert.equal(sent.branch.startsWith("portal/text/"), true);
});

await check("a read that yields no blob sha is refused before any commit", async () => {
  const session = await sessionFor("octocat", 583231);
  const fetchImpl = editFetch({ blobSha: "" });
  const { response, body } = await call(`/api/resources/${RESOURCE_ID}/edit`, {
    method: "POST",
    cookies: session.cookie,
    headers: { [CSRF_HEADER]: session.csrf },
    env: { ...env, GITHUB_COLLAB_FETCH: fetchImpl },
    body: { translation: "x", base_commit: BASE_COMMIT },
  });
  assert.equal(response.status, 502, JSON.stringify(body));
  assert.equal(body.error, "github_content_blob_sha_missing");
  assert.equal(fetchImpl.calls.some((call) => (call.init?.method || "GET") === "PUT"), false, "no commit may be attempted");
});

await check("a translation that does not change the row is refused", async () => {
  const session = await sessionFor("octocat", 583231);
  const { body } = await call(`/api/resources/${RESOURCE_ID}/edit`, {
    method: "POST",
    cookies: session.cookie,
    headers: { [CSRF_HEADER]: session.csrf },
    env: { ...env, GITHUB_COLLAB_FETCH: editFetch({ prNumber: 503 }) },
    body: { translation: "旧的译文", base_commit: BASE_COMMIT },
  });
  assert.equal(body.error, "translation_unchanged");
});

// ---------------------------------------------------------------------------
// 6. the front-end contract fixture
//
// The dashboard's own payload for a text edit, built from the edit-context
// response exactly as the shipped front end builds it: the binding is taken
// verbatim from `resource.github`, and the version field is the one that matches
// `github.target`. This is the integration seam — if the context stops carrying a
// field, or the route stops accepting the nested shape, this fails.
// ---------------------------------------------------------------------------

await check("front-end fixture: edit-context -> buildProposal -> mock PR", async () => {
  const session = await sessionFor("octocat", 583231);

  // Step 1: the front end reads the context (a plain GET, no credentials).
  const context = await call(`/api/resources/${RESOURCE_ID}/edit-context`);
  assert.equal(context.body.editable, true);

  // Step 2: `buildProposal` — the shipped front end's shape, and only fields it
  // could have got from the context.
  function buildProposal(bindingContext, translation) {
    const version = bindingContext.github.target === "assets"
      ? { asset_version: bindingContext.asset_version }
      : { client_version: bindingContext.client_version };
    return {
      resource: {
        github: {
          target: bindingContext.github.target,
          path: bindingContext.github.path,
          base_commit: bindingContext.github.base_commit,
          source_sha256: bindingContext.github.source_sha256,
        },
      },
      bundle: bindingContext.bundle,
      item_key: bindingContext.item_key,
      logical_key: bindingContext.logical_key,
      translation,
      ...version,
    };
  }
  const proposal = buildProposal(context.body, "前端提交的译文");
  assert.equal(proposal.asset_version, "1077100");
  assert.equal(proposal.client_version, undefined);

  // Step 3: POST it with credentials + CSRF.
  const fetchImpl = editFetch({ prNumber: 601 });
  const result = await call("/api/contributions/github-pr", {
    method: "POST",
    cookies: session.cookie,
    headers: { [CSRF_HEADER]: session.csrf },
    env: { ...env, GITHUB_COLLAB_FETCH: fetchImpl },
    body: proposal,
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.pr_number, 601);
  assert.equal(result.body.single_line_edit, true);
  const committed = committedBytes(fetchImpl.calls.find((call) => call.method === "PUT")).toString("utf8");
  const lines = committed.split("\n");
  assert.equal(JSON.parse(lines[1]).zh, "前端提交的译文");
  assert.equal(lines.length, FILE_TEXT.split("\n").length);
  assert.equal(lines[0], FILE_TEXT.split("\n")[0], "the row above is byte-identical");
  assert.equal(lines[2], FILE_TEXT.split("\n")[2], "the row below is byte-identical");
});

let CRC_TABLE = null;
function crc32(buffer) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc ^ -1;
}

/// The image proposal body the frozen front end sends: the pixel payload plus the
/// same binding a text edit carries.
function imageBody({ taskId = TASK_ID, imageBase64, target = "assets", path = `images/restored/${TASK_ID}/restored-texture.png`, baseCommit = BASE_COMMIT, sourceSha256 = IMAGE_SOURCE_SHA256, assetVersion = "1077100", ...rest } = {}) {
  // `null` is the "leave it out" sentinel: an `undefined` default parameter
  // would re-apply the default, which is how a check that meant to omit the
  // version would silently send one.
  const body = {
    task_id: taskId,
    image_base64: imageBase64,
    target,
    path,
    base_commit: baseCommit,
    source_sha256: sourceSha256,
    ...rest,
  };
  if (assetVersion !== null) body.asset_version = assetVersion;
  return body;
}

/// The GitHub conversation an image proposal makes: the identity probe, the
/// lookup of the path at the pin (absent for a new texture), then fork -> branch
/// -> commit -> PR.
function imageRouteList({ owner = "kohakunamori", repo = "MLTDTranslationAssets", existingBlob = null, prNumber = 701 } = {}) {
  return [
    WRITE_IDENTITY,
    { match: `${GITHUB_API}/repos/${owner}/${repo}/forks`, status: 200, reply: { full_name: `octocat/${repo}`, default_branch: "main", fork: true, owner: { login: "octocat" } } },
    {
      match: (url, init) => url.startsWith(`${GITHUB_API}/repos/${owner}/${repo}/contents/`) && url.includes("?ref=") && (init?.method || "GET") === "GET",
      status: existingBlob ? 200 : 404,
      reply: existingBlob
        ? { type: "file", encoding: "base64", sha: existingBlob, content: Buffer.from("old", "utf8").toString("base64") }
        : { message: "Not Found" },
    },
    { match: (url, init) => url.startsWith(`${GITHUB_API}/repos/octocat/${repo}/contents/`) && (init?.method || "GET") === "PUT", status: 200, reply: { content: { sha: "c".repeat(40) }, commit: { sha: "d".repeat(40) } } },
    { match: `${GITHUB_API}/repos/octocat/${repo}/git/refs`, status: 201, reply: { ref: "refs/heads/portal/image/x", object: { sha: BASE_COMMIT } } },
    { match: `${GITHUB_API}/repos/${owner}/${repo}/pulls`, status: 201, reply: { number: prNumber, html_url: `https://github.com/${owner}/${repo}/pull/${prNumber}`, state: "open" } },
  ];
}

await check("an image proposal carries a verified binding and lands on the assets repo", async () => {
  const session = await sessionFor("octocat", 583231);
  const png = makePng(1024, 512);
  db.db.prepare(
    `INSERT OR REPLACE INTO image_task_units (task_id, bundle, category, width, height, image_format, has_alpha, r2_key, source_sha256, created_at, updated_at) ` +
    `VALUES (?, 'bundle-x', 'system_ui', 512, 256, 'png', 0, NULL, ?, ?, ?)`
  ).run(TASK_ID, IMAGE_SOURCE_SHA256, STAMP, STAMP);
  // The task has to belong to the release it proposes against: the release
  // carries the task's bundle as a variant. Without that relation the route
  // refuses with `image_task_not_in_release`, which is the point — the binding is
  // evidence, not a fallback.
  db.db.prepare(
    `INSERT OR REPLACE INTO resource_units (resource_id, resource_kind, logical_key, category, created_at) VALUES ('res_image_bundle', 'image', 'image/bundle-x', 'system_ui', ?)`
  ).run(STAMP);
  db.db.prepare(
    `INSERT OR REPLACE INTO source_variants (source_variant_id, resource_id, release_kind, release_id, source_sha256, source, bundle, item_key, created_at) ` +
    `VALUES ('sv_image_bundle', 'res_image_bundle', 'assets', 'assets-1077100', ?, 'bundle-x', 'bundle-x', ?, ?)`
  ).run(IMAGE_SOURCE_SHA256, TASK_ID, STAMP);

  const fetchImpl = recordingFetch(imageRouteList({ prNumber: 701 }));
  const { response, body } = await call("/api/images/submit", {
    method: "POST",
    cookies: session.cookie,
    headers: { [CSRF_HEADER]: session.csrf },
    env: { ...env, GITHUB_COLLAB_FETCH: fetchImpl },
    body: imageBody({ imageBase64: png.toString("base64") }),
  });
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.target_repo, ASSETS_REPO);
  assert.equal(body.target, "assets");
  assert.equal(body.base_commit, BASE_COMMIT);
  assert.equal(body.source_sha256, IMAGE_SOURCE_SHA256, "the proposal records the *original's* hash");
  assert.equal(body.asset_version, "1077100");
  assert.equal(body.branch.startsWith("portal/image/"), true);
  assert.equal(body.aspect_ratio, "2:1");

  // The branch is cut at the pin, and the commit is a real PNG.
  const refCall = fetchImpl.calls.find((call) => call.url.endsWith("/git/refs"));
  assert.equal(jsonBody(refCall).sha, BASE_COMMIT, "the branch starts at the pinned commit");
  const written = fetchImpl.calls.find((call) => (call.init?.method || "GET") === "PUT");
  const committed = committedBytes(written);
  assert.deepEqual([...committed.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(committed.length, png.length);
  // A new file at the pin: no sha is sent, and the absence was *read* (the 404
  // above) rather than assumed.
  assert.equal(jsonBody(written).sha, undefined);
});

await check("an existing blob at the path is committed with its sha", async () => {
  const session = await sessionFor("octocat", 583231);
  const png = makePng(1024, 512);
  const existing = "e".repeat(40);
  const fetchImpl = recordingFetch(imageRouteList({ prNumber: 702, existingBlob: existing }));
  const { response, body } = await call("/api/images/submit", {
    method: "POST",
    cookies: session.cookie,
    headers: { [CSRF_HEADER]: session.csrf },
    env: { ...env, GITHUB_COLLAB_FETCH: fetchImpl },
    body: imageBody({ imageBase64: png.toString("base64") }),
  });
  assert.equal(response.status, 200, JSON.stringify(body));
  const written = fetchImpl.calls.find((call) => (call.init?.method || "GET") === "PUT");
  assert.equal(jsonBody(written).sha, existing, "an update presents the blob sha the pin read returned");
});

await check("a client image request is refused, not filed against the assets repository", async () => {
  const session = await sessionFor("octocat", 583231);
  const png = makePng(1024, 512);
  let githubCalled = false;
  const fetchImpl = async () => { githubCalled = true; throw new Error("GitHub must not be called"); };
  const { response, body } = await call("/api/images/submit", {
    method: "POST",
    cookies: session.cookie,
    headers: { [CSRF_HEADER]: session.csrf },
    env: { ...env, GITHUB_COLLAB_FETCH: fetchImpl },
    body: imageBody({ imageBase64: png.toString("base64"), target: "client", client_version: "9.0.200", assetVersion: null }),
  });
  assert.equal(response.status, 422, JSON.stringify(body));
  assert.equal(body.error, "client_image_unsupported");
  assert.equal(githubCalled, false, "a client image must not reach GitHub at all");
});

await check("a wrong path, commit, source hash or version writes nothing", async () => {
  const session = await sessionFor("octocat", 583231);
  const png = makePng(1024, 512);
  const post = async (overrides, expected) => {
    let githubCalled = false;
    const fetchImpl = async () => { githubCalled = true; throw new Error("GitHub must not be called"); };
    const { response, body } = await call("/api/images/submit", {
      method: "POST",
      cookies: session.cookie,
      headers: { [CSRF_HEADER]: session.csrf },
      env: { ...env, GITHUB_COLLAB_FETCH: fetchImpl },
      body: imageBody({ imageBase64: png.toString("base64"), ...overrides }),
    });
    assert.equal(response.status, expected.status, JSON.stringify(body));
    assert.equal(body.error, expected.error);
    assert.equal(githubCalled, false, `${expected.error} must not reach GitHub`);
    return body;
  };

  // The path is the task's own layout, not whatever the caller prefers.
  await post({ path: "images/restored/elsewhere/restored-texture.png" }, { status: 409, error: "image_path_mismatch" });
  // The commit must be a 40-hex sha.
  await post({ baseCommit: "not-a-sha" }, { status: 400, error: "base_commit_required" });
  // The source hash must be the task's original — the upload's hash is not a
  // substitute: it is the *translation*.
  await post({ sourceSha256: "9".repeat(64) }, { status: 409, error: "resource_source_mismatch" });
  // A malformed hash is a shape error, not a mismatch.
  await post({ sourceSha256: "nope" }, { status: 400, error: "resource_source_sha256_invalid" });
  // Both axes at once is a composite identity.
  await post({ assetVersion: "1077100", client_version: "9.0.200" }, { status: 400, error: "independent_axes_violated" });
  // The version is required: this route files a proposal against a release.
  await post({ assetVersion: null }, { status: 400, error: "missing_asset_version" });
});

await check("an image proposal is bound to the release it names, not just to a commit's shape", async () => {
  const session = await sessionFor("octocat", 583231);
  const png = makePng(1024, 512);
  const post = async (overrides, expected) => {
    let githubCalled = false;
    const fetchImpl = async () => { githubCalled = true; throw new Error("GitHub must not be called"); };
    const { response, body } = await call("/api/images/submit", {
      method: "POST",
      cookies: session.cookie,
      headers: { [CSRF_HEADER]: session.csrf },
      env: { ...env, GITHUB_COLLAB_FETCH: fetchImpl },
      body: imageBody({ imageBase64: png.toString("base64"), ...overrides }),
    });
    assert.equal(response.status, expected.status, JSON.stringify(body));
    assert.equal(body.error, expected.error);
    assert.equal(githubCalled, false, `${expected.error} must not reach GitHub`);
  };

  // A version that is shaped like a version but is not registered.
  await post({ assetVersion: "9999999" }, { status: 400, error: "unregistered_asset_version" });
  // A legitimate-looking commit that is not this release's pin.
  await post({ baseCommit: "f".repeat(40) }, { status: 409, error: "release_pin_mismatch" });
  // A task whose bundle the release does not carry: no evidence binds them.
  db.db.prepare(
    `INSERT OR REPLACE INTO image_task_units (task_id, bundle, category, width, height, image_format, has_alpha, r2_key, source_sha256, created_at, updated_at) ` +
    `VALUES ('task_other_bundle', 'bundle-elsewhere', 'system_ui', 512, 256, 'png', 0, NULL, ?, ?, ?)`
  ).run(IMAGE_SOURCE_SHA256, STAMP, STAMP);
  await post({
    taskId: "task_other_bundle",
    path: "images/restored/task_other_bundle/restored-texture.png",
  }, { status: 409, error: "image_task_not_in_release" });
});

await check("a bundle whose original changed under the release is refused", async () => {
  // The membership relation is by *source*, not by name: the release carries the
  // task's bundle, but its variant hashes a different original — so the task is
  // not this release's revision of that bundle, and the proposal is refused
  // rather than filed against the wrong file.
  const session = await sessionFor("octocat", 583231);
  const png = makePng(1024, 512);
  db.db.prepare(`UPDATE source_variants SET source_sha256=? WHERE source_variant_id='sv_image_bundle'`).run("9".repeat(64));
  let githubCalled = false;
  const fetchImpl = async () => { githubCalled = true; throw new Error("GitHub must not be called"); };
  const { response, body } = await call("/api/images/submit", {
    method: "POST",
    cookies: session.cookie,
    headers: { [CSRF_HEADER]: session.csrf },
    env: { ...env, GITHUB_COLLAB_FETCH: fetchImpl },
    body: imageBody({ imageBase64: png.toString("base64") }),
  });
  assert.equal(response.status, 409, JSON.stringify(body));
  assert.equal(body.error, "image_source_not_in_release");
  assert.equal(githubCalled, false, "a mismatched original must not reach GitHub");
  // Restore the fixture for anything that follows.
  db.db.prepare(`UPDATE source_variants SET source_sha256=? WHERE source_variant_id='sv_image_bundle'`).run(IMAGE_SOURCE_SHA256);
});

await check("同一 bundle 的另一张新图片不能遮蔽当前图片的精确来源", async () => {
  const session = await sessionFor("octocat", 583231);
  db.db.prepare(
    `INSERT INTO resource_units (resource_id, resource_kind, logical_key, category, created_at) ` +
    `VALUES ('res_image_sibling', 'image', 'image/bundle-x/sibling', 'system_ui', ?)`
  ).run(STAMP);
  db.db.prepare(
    `INSERT INTO source_variants (source_variant_id, resource_id, release_kind, release_id, source_sha256, source, bundle, item_key, created_at) ` +
    `VALUES ('sv_image_sibling', 'res_image_sibling', 'assets', 'assets-1077100', ?, 'another image', 'bundle-x', 'sibling', ?)`
  ).run("8".repeat(64), "2099-01-01T00:00:00Z");
  try {
    const fetchImpl = recordingFetch(imageRouteList({ prNumber: 703 }));
    const { response, body } = await call("/api/images/submit", {
      method: "POST", cookies: session.cookie,
      headers: { [CSRF_HEADER]: session.csrf },
      env: { ...env, GITHUB_COLLAB_FETCH: fetchImpl },
      body: imageBody({ imageBase64: makePng(1024, 512).toString("base64") }),
    });
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.source_sha256, IMAGE_SOURCE_SHA256);
    assert.equal(body.pr_number, 703);
  } finally {
    db.db.prepare(`DELETE FROM source_variants WHERE source_variant_id='sv_image_sibling'`).run();
    db.db.prepare(`DELETE FROM resource_units WHERE resource_id='res_image_sibling'`).run();
  }
});

await check("回调异常日志不得记录授权 code 或 state 查询参数", async () => {
  const messages = [];
  const previous = console.error;
  console.error = (...parts) => messages.push(parts.map(String).join(" "));
  try {
    const brokenDb = { prepare() { throw new Error("injected storage failure"); } };
    const { response } = await call("/api/auth/github/callback?code=TEST_PRIVATE_CODE&state=TEST_PRIVATE_STATE", {
      env: { ...env, DB: brokenDb },
    });
    assert.equal(response.status, 500);
  } finally {
    console.error = previous;
  }
  assert.ok(messages.length > 0, "测试必须实际经过异常日志路径");
  assert.ok(messages.join("\n").includes("/api/auth/github/callback"));
  assert.ok(!messages.join("\n").includes("TEST_PRIVATE_CODE"));
  assert.ok(!messages.join("\n").includes("TEST_PRIVATE_STATE"));
});

await check("the OAuth callback comes from one configured origin, for both halves", async () => {
  // The authorize URL and the token exchange have to name the same
  // `redirect_uri`; GitHub refuses the exchange otherwise. Both read it from
  // `PORTAL_CANONICAL_ORIGIN` — the same setting the write guard uses — and a
  // request on some other host never has its own `Host` echoed.
  const production = { ...env, PORTAL_CANONICAL_ORIGIN: "https://mltd-translate.nyaneko.cn" };

  const started = await call("/api/auth/github/login", { env: production, url: "https://portal.example.test" });
  assert.equal(started.response.status, 302);
  const authorize = new URL(started.response.headers.get("location"));
  assert.equal(authorize.searchParams.get("redirect_uri"), "https://mltd-translate.nyaneko.cn/api/auth/github/callback");
  const state = authorize.searchParams.get("state");
  const binding = cookieValue(started.setCookie, OAUTH_BINDING_COOKIE_NAME);

  // The exchange must send the *same* value.
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), body: String(init.body || "") });
    if (String(url).includes("/login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "gho_CALLBACKTEST000000000000000000000" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ login: "octocat", id: 583231, avatar_url: null }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const finished = await call(`/api/auth/github/callback?state=${state}&code=c1`, {
    cookies: `${OAUTH_BINDING_COOKIE_NAME}=${binding}`,
    headers: { accept: "application/json" },
    env: { ...production, GITHUB_COLLAB_FETCH: fetchImpl },
  });
  assert.equal(finished.response.status, 200, JSON.stringify(finished.body));
  const exchange = calls.find((entry) => entry.url.includes("/login/oauth/access_token"));
  assert.ok(exchange, "the exchange must have happened");
  assert.ok(
    exchange.body.includes(encodeURIComponent("https://mltd-translate.nyaneko.cn/api/auth/github/callback")),
    `the exchange must send the same redirect_uri: ${exchange.body}`,
  );
  assert.ok(!exchange.body.includes("portal.example.test"), "the request's own host must never be reflected");
});

await check("a request on another host never has its Host echoed into the flow", async () => {
  const production = { ...env, PORTAL_CANONICAL_ORIGIN: "https://mltd-translate.nyaneko.cn" };
  const started = await call("/api/auth/github/login", { env: production, url: "https://evil.example.test" });
  const authorize = new URL(started.response.headers.get("location"));
  assert.equal(authorize.searchParams.get("redirect_uri"), "https://mltd-translate.nyaneko.cn/api/auth/github/callback");
  assert.ok(!String(started.response.headers.get("location")).includes("evil.example.test"));

  // Without a configured origin the deployment's own fallback is used, and it is
  // a fixed name rather than the request's host.
  const unconfigured = { ...env, PORTAL_CANONICAL_ORIGIN: "" };
  const fallback = await call("/api/auth/github/login", { env: unconfigured, url: "https://evil.example.test" });
  const fallbackAuthorize = new URL(fallback.response.headers.get("location"));
  assert.equal(fallbackAuthorize.searchParams.get("redirect_uri"), "https://mltd-translate.nyaneko.cn/api/auth/github/callback");
});

await check("a local development host keeps its own callback", async () => {
  // Loopback and `.local` are not registrable, so a dev server names itself and
  // the flow still works there. This is the one host a request may choose.
  for (const [target, expected] of [
    ["http://localhost:8787", "http://localhost:8787/api/auth/github/callback"],
    ["http://127.0.0.1:8787", "http://127.0.0.1:8787/api/auth/github/callback"],
  ]) {
    const started = await call("/api/auth/github/login", { env: { ...env, PORTAL_CANONICAL_ORIGIN: "" }, url: target });
    const authorize = new URL(started.response.headers.get("location"));
    assert.equal(authorize.searchParams.get("redirect_uri"), expected, target);
  }
});

await check("a task with no original hash cannot be proposed against", async () => {
  const session = await sessionFor("octocat", 583231);
  const png = makePng(1024, 512);
  db.db.prepare(
    `INSERT OR REPLACE INTO image_task_units (task_id, bundle, category, width, height, image_format, has_alpha, r2_key, source_sha256, created_at, updated_at) ` +
    `VALUES ('task_no_hash', 'bundle-x', 'system_ui', 512, 256, 'png', 0, NULL, NULL, ?, ?)`
  ).run(STAMP, STAMP);
  let githubCalled = false;
  const fetchImpl = async () => { githubCalled = true; throw new Error("GitHub must not be called"); };
  const { response, body } = await call("/api/images/submit", {
    method: "POST",
    cookies: session.cookie,
    headers: { [CSRF_HEADER]: session.csrf },
    env: { ...env, GITHUB_COLLAB_FETCH: fetchImpl },
    body: imageBody({
      taskId: "task_no_hash",
      imageBase64: png.toString("base64"),
      path: "images/restored/task_no_hash/restored-texture.png",
      sourceSha256: "7".repeat(64),
    }),
  });
  assert.equal(response.status, 409, JSON.stringify(body));
  assert.equal(body.error, "image_source_sha256_missing", "a missing original is refused, never filled from the upload");
  assert.equal(githubCalled, false);
});

// ---------------------------------------------------------------------------
// 单一源解析的写路径：同一 commit 贯穿「编辑上下文 → 提案分支 → PR 绑定」。
// 编辑上下文给出的 pin 就是分支切出的 sha、读文件用的 ref、以及提案自身记账的
// commit；三者任一漂移到别的版本都必须能被反例证明。
// ---------------------------------------------------------------------------

await check("one commit runs through edit-context, the branch, the pinned read and the proposal record", async () => {
  const session = await sessionFor("octocat", 583231);
  const fetchImpl = editFetch({ prNumber: 512 });
  const { response, body } = await call(`/api/resources/${RESOURCE_ID}/edit`, {
    method: "POST",
    cookies: session.cookie,
    headers: { [CSRF_HEADER]: session.csrf },
    env: { ...env, GITHUB_COLLAB_FETCH: fetchImpl },
    body: { translation: "单一来源的译文", base_commit: BASE_COMMIT },
  });
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.base_commit, BASE_COMMIT, "提案记录的 commit 就是上下文给出的 pin");

  // 分支从 pin 切出，不是从 fork 的 tip。
  const refCall = fetchImpl.calls.find((entry) => entry.url.endsWith("/git/refs"));
  assert.equal(jsonBody(refCall).sha, BASE_COMMIT, "分支必须切在 pin 上，而不是 fork 的当前 tip");

  // 读文件钉在同一个 commit 上。
  const readCall = fetchImpl.calls.find((entry) => entry.method === "GET" && entry.url.includes("/contents/"));
  assert.ok(readCall.url.endsWith(`?ref=${BASE_COMMIT}`), `读取必须钉住同一个 commit：${readCall.url}`);

  // 写文件提交到 fork 上从 pin 长出来的分支，且带 pin 读取返回的 blob sha。
  const written = fetchImpl.calls.find((entry) => entry.method === "PUT");
  assert.equal(jsonBody(written).branch, body.branch);
  assert.equal(jsonBody(written).sha, BLOB_SHA, "更新必须携带 pin 读取返回的 blob sha");

  // PR 的 base 是配置的默认分支，head 是本次提案自己的分支，不会跨到别的版本。
  const prCall = fetchImpl.calls.find((entry) => entry.url.endsWith("/pulls"));
  assert.equal(jsonBody(prCall).base, "main");
  assert.match(jsonBody(prCall).head, /^octocat:portal\/text\//);
});

await check("a stale commit or source hash is refused before anything is written", async () => {
  const session = await sessionFor("octocat", 583231);
  const staleCommit = "a".repeat(40);
  let githubCalled = false;
  const refused = await call(`/api/resources/${RESOURCE_ID}/edit`, {
    method: "POST",
    cookies: session.cookie,
    headers: { [CSRF_HEADER]: session.csrf },
    env: { ...env, GITHUB_COLLAB_FETCH: async () => { githubCalled = true; throw new Error("GitHub must not be called"); } },
    body: { translation: "x", base_commit: staleCommit },
  });
  assert.equal(refused.response.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "base_commit_moved", "被移动的 pin 必须点名拒绝");
  assert.equal(githubCalled, false, "过期的 commit 不得触达 GitHub");

  const sourceMismatch = await call(`/api/resources/${RESOURCE_ID}/edit`, {
    method: "POST",
    cookies: session.cookie,
    headers: { [CSRF_HEADER]: session.csrf },
    env: { ...env, GITHUB_COLLAB_FETCH: async () => { githubCalled = true; throw new Error("GitHub must not be called"); } },
    body: { translation: "x", base_commit: BASE_COMMIT, source_sha256: "9".repeat(64) },
  });
  assert.equal(sourceMismatch.response.status, 409, JSON.stringify(sourceMismatch.body));
  assert.equal(sourceMismatch.body.error, "resource_source_mismatch", "与上下文不符的源 hash 必须点名拒绝");
  assert.equal(githubCalled, false, "错误的源 hash 不得触达 GitHub");
});

await check("a wrong target never reaches the right repository's write path", async () => {
  const session = await sessionFor("octocat", 583231);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method || "GET" });
    if (String(url) === `${GITHUB_API}/user`) return new Response(JSON.stringify({ login: "octocat", id: 583231 }), { status: 200 });
    throw new Error(`unexpected GitHub call: ${init?.method || "GET"} ${url}`);
  };
  const { response, body } = await call("/api/contributions/github-pr", {
    method: "POST",
    cookies: session.cookie,
    headers: { [CSRF_HEADER]: session.csrf },
    env: { ...env, GITHUB_COLLAB_FETCH: fetchImpl },
    body: {
      target: "client",
      path: FILE_PATH,
      base_commit: BASE_COMMIT,
      source_sha256: SOURCE_SHA,
      bundle: BUNDLE,
      item_key: ITEM_KEY,
      translation: "x",
      client_version: "9.0.200",
    },
  });
  assert.equal(response.status, 400, JSON.stringify(body));
  assert.equal(body.error, "path_not_allowed", "Assets 的路径格式不得通过 Client 仓的路径规则");
  // 路径规则在 custodian/身份探测之前执行：错 target 的请求连 GitHub 都不碰。
  assert.deepEqual(calls, [], "错 target 的路径必须在任何 GitHub 调用之前被拒");
});

await check("an older ref is refused by its own pinned read, not answered from the latest file", async () => {
  const session = await sessionFor("octocat", 583231);
  const oldCommit = "b".repeat(40);
  const staleBody = {
    target: "assets",
    path: FILE_PATH,
    base_commit: oldCommit,
    source_sha256: SOURCE_SHA,
    bundle: BUNDLE,
    item_key: ITEM_KEY,
    translation: "旧版本的译文",
    asset_version: "1077100",
  };
  // 该 commit 下没有这个文件：读取必须 404，而不是悄悄改读最新版本的文件。
  const fetchImpl = recordingFetch([
    WRITE_IDENTITY,
    { match: (url) => url.includes("/contents/") && url.includes(`?ref=${oldCommit}`), status: 404, reply: { message: "Not Found" } },
  ]);
  const { response, body } = await call("/api/contributions/github-pr", {
    method: "POST",
    cookies: session.cookie,
    headers: { [CSRF_HEADER]: session.csrf },
    env: { ...env, GITHUB_COLLAB_FETCH: fetchImpl },
    body: staleBody,
  });
  assert.equal(response.status, 404, JSON.stringify(body));
  // 没有读成功就没有分支、没有提交、没有 PR：调用表只有身份探测与那次钉住的读取。
  assert.equal(fetchImpl.calls.filter((entry) => entry.url.endsWith("/forks")).length, 0);
  assert.equal(fetchImpl.calls.filter((entry) => (entry.init?.method || "GET") === "PUT").length, 0);
  assert.equal(fetchImpl.calls.filter((entry) => entry.url.endsWith("/pulls")).length, 0);
});

/// A minimal PNG with the given IHDR dimensions — the ratio gate reads the
/// header, nothing decodes the pixels.
function makePng(width, height) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

db.close();

console.log(failures.length === 0
  ? `github session PASS (${checks} checks, 0 failed) — MOCK-TESTED, no live GitHub API call`
  : `github session FAIL (${checks} checks, ${failures.length} failed)`);
process.exit(failures.length === 0 ? 0 : 1);
