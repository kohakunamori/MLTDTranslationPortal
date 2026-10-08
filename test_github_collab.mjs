// GitHub collaboration primitives.
//
// MOCK-TESTED, NOT GITHUB-API-TESTED. Every request below is answered by the
// recording `fetchImpl` in this file, built from GitHub's documented response
// shapes. Nothing here has talked to api.github.com: the OAuth exchange, the
// fork, the ref creation and the pull request have never seen a real status
// code. What the suite does prove is the module's own contract — what it sends,
// how it classifies a failure, and that it refuses the cases it says it refuses.
//
// Run: node test_github_collab.mjs

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  BRANCH_KINDS,
  GITHUB_ACCEPT,
  GITHUB_API,
  GITHUB_API_VERSION,
  GITHUB_OAUTH_AUTHORIZE_URL,
  GITHUB_OAUTH_SCOPE,
  GITHUB_OAUTH_TOKEN_URL,
  GitHubCollabError,
  USER_AGENT,
  assertOAuthStateMatches,
  base64ToBytes,
  branchName,
  buildAuthorizeUrl,
  bytesToBase64,
  classifyForkResponse,
  createBranch,
  createOAuthState,
  createPullRequest,
  ensureFork,
  exchangeCodeForToken,
  getAuthenticatedUser,
  getBranchHead,
  getPullRequest,
  newShortId,
  parseRepoSpec,
  putFile,
  redactSecrets,
} from "./src/github_collab.js";

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`ok ${checks} - ${name}`);
}

// ---------------------------------------------------------------------------
// recording fetch
// ---------------------------------------------------------------------------

/// A `fetch` that records every call and answers from a queue of programmed
/// responses. An unmatched URL is an assertion failure, not a fallback: a test
/// that silently accepted the wrong URL would not be testing the URL.
function recordingFetch(routes) {
  const calls = [];
  const queue = [...routes];
  const impl = async (url, init = {}) => {
    const call = { url: String(url), init, headers: new Headers(init.headers || {}), body: init.body };
    calls.push(call);
    const index = queue.findIndex((route) => (typeof route.match === "string" ? call.url === route.match
      : (route.match instanceof RegExp ? route.match.test(call.url) : route.match(call.url, call.init))));
    if (index < 0) throw new Error(`unprogrammed request: ${call.method || init.method || "GET"} ${call.url}`);
    const route = queue[index];
    if (!route.keep) queue.splice(index, 1);
    if (typeof route.reply === "function") return route.reply(call);
    return jsonResponse(route.reply, route.status ?? 200, route.headers ?? {});
  };
  impl.calls = calls;
  impl.remaining = () => queue.length;
  return impl;
}

function jsonResponse(body, status = 200, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { "content-type": "application/json", ...headers } });
}

function jsonBody(call) {
  assert.ok(call.body, `expected a JSON body on ${call.url}`);
  return JSON.parse(call.body);
}

// A PNG with the given IHDR dimensions and no pixel data. Only the header is
// read by the Worker; the chunk CRCs are real, so a decoder could parse it too.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngBytes(width, height) {
  const u32 = (value) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  const body = [...[0x49, 0x48, 0x44, 0x52], ...u32(width), ...u32(height), 8, 6, 0, 0, 0];
  const chunk = [...u32(13), ...body, ...u32(crc32(Uint8Array.from(body)))];
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk]);
}

function pngBase64(width, height) {
  return Buffer.from(pngBytes(width, height)).toString("base64");
}

/// A JPEG carrying a real SOI + APP0 + SOF0 chain, so `parseImageSize` reads its
/// dimensions from a header rather than from a stub.
function jpegBytes(width, height) {
  const u16 = (value) => [(value >>> 8) & 0xff, value & 0xff];
  const app0 = [...[0x4a, 0x46, 0x49, 0x46, 0x00], 1, 1, 0, ...u16(1), ...u16(1), 0, 0];
  const sof = [8, ...u16(height), ...u16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  const sos = [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0];
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe0, ...u16(app0.length + 2), ...app0,
    0xff, 0xc0, ...u16(sof.length + 2), ...sof,
    0xff, 0xda, ...u16(sos.length + 2), ...sos, 0x00, 0x11, 0x22, 0x33,
  ]);
}

const TOKEN = "ghp_TESTONLYTOKENVALUE0000000000000000";

// ---------------------------------------------------------------------------
// authorize URL
// ---------------------------------------------------------------------------

await check("buildAuthorizeUrl carries client_id, redirect_uri, scope and state", () => {
  const url = new URL(buildAuthorizeUrl({ clientId: "cid", redirectUri: "https://portal.test/api/auth/github/callback", state: "st-1" }));
  assert.equal(`${url.origin}${url.pathname}`, GITHUB_OAUTH_AUTHORIZE_URL);
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("redirect_uri"), "https://portal.test/api/auth/github/callback");
  assert.equal(url.searchParams.get("scope"), GITHUB_OAUTH_SCOPE);
  assert.equal(url.searchParams.get("scope"), "public_repo");
  assert.equal(url.searchParams.get("state"), "st-1");
});

await check("buildAuthorizeUrl refuses to build a URL without a state", () => {
  assert.throws(
    () => buildAuthorizeUrl({ clientId: "cid", redirectUri: "https://portal.test/cb", state: "" }),
    (err) => err instanceof GitHubCollabError && err.code === "oauth_state_required",
  );
});

await check("only public_repo is ever requested — never the full `repo` scope", () => {
  const url = new URL(buildAuthorizeUrl({ clientId: "cid", redirectUri: "https://portal.test/cb", state: "st" }));
  assert.equal(url.searchParams.get("scope"), "public_repo");
  assert.ok(!url.searchParams.get("scope").split(/[ ,]+/).includes("repo"));
});

await check("createOAuthState returns a fresh UUID each call", () => {
  const first = createOAuthState();
  const second = createOAuthState();
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(first, second);
});

await check("assertOAuthStateMatches accepts a match and refuses a mismatch", () => {
  assert.equal(assertOAuthStateMatches("st-1", "st-1"), true);
  assert.throws(() => assertOAuthStateMatches("st-2", "st-1"), (err) => err.code === "oauth_state_mismatch" && err.status === 400);
  assert.throws(() => assertOAuthStateMatches("", "st-1"), (err) => err.code === "oauth_state_mismatch");
  // A state prefix must not pass: the comparison is over the whole value.
  assert.throws(() => assertOAuthStateMatches("st-1", "st-10"), (err) => err.code === "oauth_state_mismatch");
  // An empty *expectation* means the caller lost the stored state — that is a
  // different bug from a bad receipt and gets its own code.
  assert.throws(() => assertOAuthStateMatches("st-1", ""), (err) => err.code === "oauth_state_expected_missing");
});

// ---------------------------------------------------------------------------
// token exchange + identity
// ---------------------------------------------------------------------------

await check("exchangeCodeForToken POSTs the code and returns the token trio", async () => {
  const fetchImpl = recordingFetch([{
    match: GITHUB_OAUTH_TOKEN_URL,
    reply: { access_token: "gho_x", token_type: "bearer", scope: "public_repo" },
  }]);
  const result = await exchangeCodeForToken({ clientId: "cid", clientSecret: "sec", code: "code-1", fetchImpl });
  assert.deepEqual(result, { access_token: "gho_x", token_type: "bearer", scope: "public_repo" });

  const call = fetchImpl.calls[0];
  assert.equal(call.init.method, "POST");
  assert.equal(call.headers.get("accept"), "application/json");
  assert.equal(call.headers.get("content-type"), "application/x-www-form-urlencoded");
  const form = new URLSearchParams(call.body);
  assert.equal(form.get("client_id"), "cid");
  assert.equal(form.get("client_secret"), "sec");
  assert.equal(form.get("code"), "code-1");
});

await check("exchangeCodeForToken turns a 200-with-error body into a failure", async () => {
  // GitHub documents this endpoint as answering 200 with `error` on a bad code,
  // so a status-only check would treat it as a success and hand back no token.
  const fetchImpl = recordingFetch([{
    match: GITHUB_OAUTH_TOKEN_URL,
    reply: { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." },
  }]);
  await assert.rejects(
    () => exchangeCodeForToken({ clientId: "cid", clientSecret: "sec", code: "stale", fetchImpl }),
    (err) => err instanceof GitHubCollabError && err.code === "oauth_bad_verification_code" && err.status === 400,
  );
});

await check("exchangeCodeForToken never echoes the client secret into the error", async () => {
  const secret = "cs_TESTONLYSECRETVALUE0000000000000000";
  const fetchImpl = recordingFetch([{
    match: GITHUB_OAUTH_TOKEN_URL,
    reply: { error: "incorrect_client_credentials", error_description: "The client_id and/or client_secret passed are incorrect." },
  }]);
  const error = await exchangeCodeForToken({ clientId: "cid", clientSecret: secret, code: "c", fetchImpl }).catch((err) => err);
  assert.equal(error.detail, "The client_id and/or client_secret passed are incorrect.");
  assert.ok(!error.detail.includes(secret));
  assert.ok(!String(error.stack || "").includes(secret));
});

await check("exchangeCodeForToken requires a code and a secret", async () => {
  await assert.rejects(() => exchangeCodeForToken({ clientId: "cid", clientSecret: "s", code: "", fetchImpl: async () => { throw new Error("must not be called"); } }),
    (err) => err.code === "oauth_code_required");
  await assert.rejects(() => exchangeCodeForToken({ clientId: "cid", clientSecret: "", code: "c", fetchImpl: async () => { throw new Error("must not be called"); } }),
    (err) => err.code === "client_secret_required");
});

await check("getAuthenticatedUser returns login/id/avatar and sends the token as a Bearer header", async () => {
  const fetchImpl = recordingFetch([{
    match: `${GITHUB_API}/user`,
    reply: { login: "octocat", id: 583231, avatar_url: "https://avatars.test/o.png" },
  }]);
  const user = await getAuthenticatedUser({ token: TOKEN, fetchImpl });
  assert.deepEqual(user, { login: "octocat", id: 583231, avatar_url: "https://avatars.test/o.png" });

  const call = fetchImpl.calls[0];
  assert.equal(call.headers.get("authorization"), `Bearer ${TOKEN}`);
  assert.equal(call.headers.get("accept"), GITHUB_ACCEPT);
  assert.equal(call.headers.get("x-github-api-version"), GITHUB_API_VERSION);
  assert.equal(call.headers.get("user-agent"), USER_AGENT);
});

await check("a 401 from /user is github_unauthorized with the status attached", async () => {
  const fetchImpl = recordingFetch([{ match: `${GITHUB_API}/user`, status: 401, reply: { message: "Bad credentials" } }]);
  await assert.rejects(
    () => getAuthenticatedUser({ token: "bad", fetchImpl }),
    (err) => err.code === "github_unauthorized" && err.status === 401 && err.httpStatus === 401,
  );
});

// ---------------------------------------------------------------------------
// rate limits are reported, not retried
// ---------------------------------------------------------------------------

await check("a 403 with Retry-After exposes retryAfter and does not sleep", async () => {
  const fetchImpl = recordingFetch([{
    match: `${GITHUB_API}/user`,
    status: 403,
    headers: { "retry-after": "42", "x-ratelimit-reset": "1790000000", "x-github-request-id": "req-9" },
    reply: { message: "You have exceeded a secondary rate limit." },
  }]);
  const started = Date.now();
  const error = await getAuthenticatedUser({ token: TOKEN, fetchImpl }).catch((err) => err);
  assert.equal(error.code, "github_forbidden");
  assert.equal(error.status, 403);
  assert.equal(error.retryAfter, "42");
  assert.equal(error.rateLimitReset, "1790000000");
  assert.equal(error.requestId, "req-9");
  assert.equal(fetchImpl.calls.length, 1, "a rate limit must not be retried inside the call");
  assert.ok(Date.now() - started < 500, "the call must not have slept");
});

await check("a 429 is github_rate_limited", async () => {
  const fetchImpl = recordingFetch([{ match: `${GITHUB_API}/user`, status: 429, headers: { "retry-after": "7" }, reply: { message: "Slow down" } }]);
  const error = await getAuthenticatedUser({ token: TOKEN, fetchImpl }).catch((err) => err);
  assert.equal(error.code, "github_rate_limited");
  assert.equal(error.retryAfter, "7");
});

await check("a transport failure is github_unreachable, not a 500", async () => {
  const fetchImpl = async () => { throw new Error("socket closed"); };
  const error = await getAuthenticatedUser({ token: TOKEN, fetchImpl }).catch((err) => err);
  assert.equal(error.code, "github_unreachable");
  assert.equal(error.status, 0);
  assert.equal(error.httpStatus, 502);
});

// ---------------------------------------------------------------------------
// fork
// ---------------------------------------------------------------------------

await check("ensureFork returns the fork when GitHub creates one (202 + poll)", async () => {
  const fetchImpl = recordingFetch([
    // Real response B: 202, `fork: true`, `default_branch: null`.
    { match: `${GITHUB_API}/repos/owner/repo/forks`, status: 202, reply: { full_name: "octocat/repo", default_branch: null, fork: true, owner: { login: "octocat" } } },
    { match: `${GITHUB_API}/repos/octocat/repo`, reply: { full_name: "octocat/repo", default_branch: "main", owner: { login: "octocat" } } },
  ]);
  const fork = await ensureFork({ token: TOKEN, owner: "owner", repo: "repo", fetchImpl });
  assert.deepEqual(fork, { full_name: "octocat/repo", default_branch: "main", owner: "octocat" });
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[0].init.method, "POST");
});

await check("ensureFork returns the existing fork without polling (200, default_branch present)", async () => {
  const fetchImpl = recordingFetch([
    // Real response A: 200 + a complete repository object + `fork: true`.
    { match: `${GITHUB_API}/repos/owner/repo/forks`, status: 200, reply: { full_name: "octocat/repo", default_branch: "main", fork: true, owner: { login: "octocat" } } },
  ]);
  const fork = await ensureFork({ token: TOKEN, owner: "owner", repo: "repo", fetchImpl });
  assert.deepEqual(fork, { full_name: "octocat/repo", default_branch: "main", owner: "octocat" });
  assert.equal(fetchImpl.calls.length, 1, "a ready fork needs no second request");
});

await check("ensureFork refuses a response that describes the source repository, not a fork", async () => {
  // Real response C: the token can already write to owner/repo, so GitHub forks
  // nothing and answers 202 with the source repository itself. Returning that as
  // a fork would send the caller on to commit in the upstream.
  const fetchImpl = recordingFetch([
    { match: `${GITHUB_API}/repos/owner/repo/forks`, status: 202, reply: { full_name: "owner/repo", default_branch: "main", fork: false, owner: { login: "owner" } } },
  ]);
  const error = await ensureFork({ token: TOKEN, owner: "owner", repo: "repo", fetchImpl }).catch((err) => err);
  assert.equal(error.code, "fork_not_created_upstream_accessible");
  assert.equal(error.status, 409);
  assert.equal(error.httpStatus, 409);
  // The detail must name the way out: another account's token, or the opt-in.
  assert.match(error.detail, /write access/);
  assert.match(error.detail, /allowUpstream/);
  assert.equal(fetchImpl.calls.length, 1, "a refusal must not poll for a fork that was never created");
});

await check("the source-repository check uses both signals, either one decisive", async () => {
  // Criterion 1: `fork: false` — even when the body names some other repository.
  const flagOnly = recordingFetch([
    { match: `${GITHUB_API}/repos/owner/repo/forks`, status: 202, reply: { full_name: "octocat/repo", default_branch: "main", fork: false } },
  ]);
  const flagError = await ensureFork({ token: TOKEN, owner: "owner", repo: "repo", fetchImpl: flagOnly }).catch((err) => err);
  assert.equal(flagError.code, "fork_not_created_upstream_accessible");

  // Criterion 2: `full_name` equal to the source — with the flag absent, and
  // with a contradictory `true` (the name wins; a body describing the upstream
  // is never a fork), and case-insensitively.
  for (const reply of [
    { full_name: "owner/repo", default_branch: "main" },
    { full_name: "owner/repo", default_branch: "main", fork: true },
    { full_name: "OWNER/REPO", default_branch: "main", fork: false, owner: { login: "OWNER" } },
  ]) {
    const fetchImpl = recordingFetch([{ match: `${GITHUB_API}/repos/owner/repo/forks`, status: 202, reply }]);
    const error = await ensureFork({ token: TOKEN, owner: "owner", repo: "repo", fetchImpl }).catch((err) => err);
    assert.equal(error.code, "fork_not_created_upstream_accessible", `${JSON.stringify(reply)} must be refused`);
  }

  // And the classifier itself, which is what both call sites rely on.
  const source = parseRepoSpec("owner/repo");
  assert.equal(classifyForkResponse({ full_name: "owner/repo", fork: false }, source), "upstream");
  assert.equal(classifyForkResponse({ full_name: "owner/repo" }, source), "upstream");
  assert.equal(classifyForkResponse({ full_name: "octocat/repo", fork: false }, source), "upstream");
  assert.equal(classifyForkResponse({ full_name: "octocat/repo", fork: true }, source), "fork");
  assert.equal(classifyForkResponse({ full_name: "octocat/repo" }, source), "unknown");
});

await check("ensureFork returns the upstream itself only when allowUpstream is set, tagged", async () => {
  const reply = { full_name: "owner/repo", default_branch: "main", fork: false, owner: { login: "owner" } };
  const fetchImpl = recordingFetch([{ match: `${GITHUB_API}/repos/owner/repo/forks`, status: 202, reply }]);
  const fork = await ensureFork({ token: TOKEN, owner: "owner", repo: "repo", fetchImpl, allowUpstream: true });
  // The marker is the whole point: a caller that opts in must still be able to
  // tell this apart from a real fork.
  assert.deepEqual(fork, { full_name: "owner/repo", default_branch: "main", owner: "owner", upstream_direct: true });
  assert.equal(fetchImpl.calls.length, 1);

  // A real fork is never tagged, even with the opt-in set.
  const real = recordingFetch([
    { match: `${GITHUB_API}/repos/owner/repo/forks`, status: 200, reply: { full_name: "octocat/repo", default_branch: "main", fork: true, owner: { login: "octocat" } } },
  ]);
  const realFork = await ensureFork({ token: TOKEN, owner: "owner", repo: "repo", fetchImpl: real, allowUpstream: true });
  assert.deepEqual(realFork, { full_name: "octocat/repo", default_branch: "main", owner: "octocat" });
});

await check("ensureFork tolerates 404s while the fork is being created, then gives up bounded", async () => {
  const fetchImpl = recordingFetch([
    { match: `${GITHUB_API}/repos/owner/repo/forks`, status: 202, reply: { full_name: "octocat/repo", default_branch: null } },
    { match: `${GITHUB_API}/repos/octocat/repo`, status: 404, reply: { message: "Not Found" }, keep: true },
  ]);
  const error = await ensureFork({ token: TOKEN, owner: "owner", repo: "repo", fetchImpl, maxPolls: 3, pollDelayMs: 0 }).catch((err) => err);
  assert.equal(error.code, "fork_not_ready");
  assert.equal(error.status, 504);
  assert.equal(fetchImpl.calls.length, 4, "1 fork POST + exactly maxPolls reads");
});

await check("ensureFork passes an organization when asked", async () => {
  const fetchImpl = recordingFetch([
    { match: `${GITHUB_API}/repos/owner/repo/forks`, status: 200, reply: { full_name: "org/repo", default_branch: "main", owner: { login: "org" } } },
  ]);
  await ensureFork({ token: TOKEN, owner: "owner", repo: "repo", organization: "org", fetchImpl });
  assert.deepEqual(jsonBody(fetchImpl.calls[0]), { organization: "org" });
});

await check("ensureFork requires a token and a parseable owner/repo", async () => {
  await assert.rejects(() => ensureFork({ owner: "o", repo: "r", fetchImpl: async () => { throw new Error("must not be called"); } }),
    (err) => err.code === "token_required");
  await assert.rejects(() => ensureFork({ token: TOKEN, owner: "", repo: "", fetchImpl: async () => { throw new Error("must not be called"); } }),
    (err) => err.code === "repo_spec_invalid");
});

await check("parseRepoSpec rejects anything that is not owner/repo", () => {
  assert.deepEqual(parseRepoSpec("kohakunamori/MLTDTranslationAssets"), { owner: "kohakunamori", repo: "MLTDTranslationAssets", full_name: "kohakunamori/MLTDTranslationAssets" });
  for (const bad of ["", "noslash", "a/b/c", "https://github.com/a/b", "a//b", "/b"]) {
    assert.throws(() => parseRepoSpec(bad), (err) => err.code === "repo_spec_invalid", `${bad} must be rejected`);
  }
});

// ---------------------------------------------------------------------------
// branch
// ---------------------------------------------------------------------------

await check("branchName builds portal/<kind>/<shortid> for text and image, and nothing else", () => {
  assert.deepEqual(BRANCH_KINDS, ["text", "image"]);
  assert.equal(branchName("text", "abc123def456"), "portal/text/abc123def456");
  assert.equal(branchName("image", "0f9e8d7c6b5a"), "portal/image/0f9e8d7c6b5a");
  assert.throws(() => branchName("unity3d", "abc123def456"), (err) => err.code === "branch_kind_invalid");
  assert.throws(() => branchName("text", "short"), (err) => err.code === "branch_short_id_invalid");
});

await check("newShortId is a lowercase, branch-safe id", () => {
  const id = newShortId();
  assert.match(id, /^[a-z0-9]{12}$/);
  assert.equal(branchName("text", id), `portal/text/${id}`);
  assert.notEqual(newShortId(), newShortId());
});

await check("getBranchHead reads the commit sha of a branch", async () => {
  const fetchImpl = recordingFetch([{ match: `${GITHUB_API}/repos/octocat/repo/branches/main`, reply: { name: "main", commit: { sha: "a".repeat(40) } } }]);
  assert.deepEqual(await getBranchHead({ token: TOKEN, owner: "octocat", repo: "repo", branch: "main", fetchImpl }), { sha: "a".repeat(40) });
});

await check("getBranchHead names a missing branch branch_not_found", async () => {
  const fetchImpl = recordingFetch([{ match: `${GITHUB_API}/repos/octocat/repo/branches/nope`, status: 404, reply: { message: "Branch not found" } }]);
  const error = await getBranchHead({ token: TOKEN, owner: "octocat", repo: "repo", branch: "nope", fetchImpl }).catch((err) => err);
  assert.equal(error.code, "branch_not_found");
  assert.equal(error.status, 404);
});

await check("createBranch POSTs refs/heads/<branch> at the given sha", async () => {
  const fromSha = "b".repeat(40);
  const fetchImpl = recordingFetch([{ match: `${GITHUB_API}/repos/octocat/repo/git/refs`, status: 201, reply: { ref: "refs/heads/portal/text/abc123def456", object: { sha: fromSha } } }]);
  const created = await createBranch({ token: TOKEN, owner: "octocat", repo: "repo", branch: "portal/text/abc123def456", fromSha, fetchImpl });
  assert.equal(created.ref, "refs/heads/portal/text/abc123def456");
  assert.deepEqual(jsonBody(fetchImpl.calls[0]), { ref: "refs/heads/portal/text/abc123def456", sha: fromSha });
});

await check("createBranch refuses an existing branch as branch_exists — never a silent reuse", async () => {
  const fetchImpl = recordingFetch([{
    match: `${GITHUB_API}/repos/octocat/repo/git/refs`,
    status: 422,
    reply: { message: "Reference already exists", documentation_url: "https://docs.github.com/rest" },
  }]);
  const error = await createBranch({ token: TOKEN, owner: "octocat", repo: "repo", branch: "portal/text/abc123def456", fromSha: "c".repeat(40), fetchImpl }).catch((err) => err);
  assert.equal(error.code, "branch_exists");
  assert.equal(error.status, 409);
});

await check("createBranch does not mistake another 422 for an existing branch", async () => {
  const fetchImpl = recordingFetch([{ match: `${GITHUB_API}/repos/octocat/repo/git/refs`, status: 422, reply: { message: "Object does not exist" } }]);
  const error = await createBranch({ token: TOKEN, owner: "octocat", repo: "repo", branch: "portal/text/abc123def456", fromSha: "d".repeat(40), fetchImpl }).catch((err) => err);
  assert.equal(error.code, "branch_create_failed");
});

await check("createBranch requires a 40-hex fromSha", async () => {
  await assert.rejects(
    () => createBranch({ token: TOKEN, owner: "o", repo: "r", branch: "portal/text/abc123def456", fromSha: "main", fetchImpl: async () => { throw new Error("must not be called"); } }),
    (err) => err.code === "from_sha_invalid",
  );
});

// ---------------------------------------------------------------------------
// putFile
// ---------------------------------------------------------------------------

await check("putFile base64-encodes UTF-8 content correctly and creates a new file", async () => {
  const content = "おはよう、プロデューサーさん。\n你好，制作人。\n";
  const fetchImpl = recordingFetch([
    { match: `${GITHUB_API}/repos/octocat/repo/contents/locales/ja.json?ref=portal%2Ftext%2Fabc123def456`, status: 404, reply: { message: "Not Found" } },
    { match: `${GITHUB_API}/repos/octocat/repo/contents/locales/ja.json`, status: 201, reply: { content: { sha: "f".repeat(40), html_url: "https://github.com/octocat/repo/blob/x/locales/ja.json" }, commit: { sha: "e".repeat(40) } } },
  ]);
  const written = await putFile({
    token: TOKEN, owner: "octocat", repo: "repo", branch: "portal/text/abc123def456",
    path: "locales/ja.json", content, message: "portal: ja", fetchImpl,
  });

  const body = jsonBody(fetchImpl.calls[1]);
  assert.equal(body.branch, "portal/text/abc123def456");
  assert.equal(body.message, "portal: ja");
  // The payload must round-trip the Japanese text exactly, and must be the
  // UTF-8 byte encoding — `btoa(content)` would have thrown here.
  const roundTrip = new TextDecoder().decode(base64ToBytes(body.content));
  assert.equal(roundTrip, content);
  assert.ok(!("sha" in body), "a create must not send a sha");
  assert.equal(written.created, true);
  assert.equal(written.commit_sha, "e".repeat(40));
  assert.equal(written.content_sha, "f".repeat(40));
});

await check("putFile sends the blob sha when updating an existing file", async () => {
  const fetchImpl = recordingFetch([
    { match: `${GITHUB_API}/repos/octocat/repo/contents/locales/ja.json?ref=portal%2Ftext%2Fabc123def456`, reply: { sha: "1".repeat(40) } },
    { match: `${GITHUB_API}/repos/octocat/repo/contents/locales/ja.json`, status: 200, reply: { content: { sha: "2".repeat(40), html_url: "u" }, commit: { sha: "3".repeat(40) } } },
  ]);
  const written = await putFile({ token: TOKEN, owner: "octocat", repo: "repo", branch: "portal/text/abc123def456", path: "locales/ja.json", content: "x", fetchImpl });
  assert.equal(jsonBody(fetchImpl.calls[1]).sha, "1".repeat(40));
  assert.equal(written.created, false);
});

await check("putFile can skip the lookup for a known-new path", async () => {
  const fetchImpl = recordingFetch([
    { match: `${GITHUB_API}/repos/octocat/repo/contents/locales/new.json`, status: 201, reply: { content: { sha: "4".repeat(40) }, commit: { sha: "5".repeat(40) } } },
  ]);
  await putFile({ token: TOKEN, owner: "octocat", repo: "repo", branch: "portal/text/abc123def456", path: "locales/new.json", content: "y", fetchImpl, lookupExisting: false });
  assert.equal(fetchImpl.calls.length, 1);
  assert.ok(!("sha" in jsonBody(fetchImpl.calls[0])));
});

await check("putFile refuses a payload that is neither a string nor bytes", async () => {
  for (const content of [42, { a: 1 }, null, undefined, ["x"]]) {
    await assert.rejects(
      () => putFile({ token: TOKEN, owner: "o", repo: "r", branch: "b", path: "p", content, fetchImpl: async () => { throw new Error("must not be called"); } }),
      (err) => err.code === "content_required",
      `${JSON.stringify(content)} must be refused`,
    );
  }
});

await check("putFile commits raw bytes unchanged — the property a .png path depends on", async () => {
  // Above 0x7F a byte string would be widened to two UTF-8 bytes (0x89 -> C2 89),
  // so a Uint8Array must travel as itself. This is the unit-level statement of
  // the same property the route test asserts at the recorded request body.
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x7f, 0x80]);
  const fetchImpl = recordingFetch([
    { match: `${GITHUB_API}/repos/octocat/repo/contents/img.png`, status: 201, reply: { content: { sha: "6".repeat(40) }, commit: { sha: "7".repeat(40) } } },
  ]);
  await putFile({ token: TOKEN, owner: "octocat", repo: "repo", branch: "portal/image/abc123def456", path: "img.png", content: bytes, fetchImpl, lookupExisting: false });
  const sent = Buffer.from(jsonBody(fetchImpl.calls[0]).content, "base64");
  assert.deepEqual([...sent], [...bytes]);
  assert.equal(sent.length, bytes.length, "no byte may be widened or dropped");
});

await check("bytesToBase64 matches the platform encoder for arbitrary bytes", () => {
  const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 0x89, 0x50, 0x4e, 0x47]);
  const expected = Buffer.from(bytes).toString("base64");
  assert.equal(bytesToBase64(bytes), expected);
  assert.deepEqual([...base64ToBytes(expected)], [...bytes]);
  // Padded and unpadded forms both decode.
  assert.deepEqual([...base64ToBytes("QUJD")], [0x41, 0x42, 0x43]);
  assert.deepEqual([...base64ToBytes("QUI=")], [0x41, 0x42]);
});

// ---------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------

await check("createPullRequest opens a cross-fork PR and returns number/url/state", async () => {
  const fetchImpl = recordingFetch([{
    match: `${GITHUB_API}/repos/owner/repo/pulls`,
    status: 201,
    reply: { number: 42, html_url: "https://github.com/owner/repo/pull/42", state: "open" },
  }]);
  const pr = await createPullRequest({
    token: TOKEN, owner: "owner", repo: "repo", title: "[text] ja", head: "octocat:portal/text/abc123def456", base: "main", body: "why", fetchImpl,
  });
  assert.deepEqual(pr, { number: 42, html_url: "https://github.com/owner/repo/pull/42", state: "open" });
  assert.deepEqual(jsonBody(fetchImpl.calls[0]), { title: "[text] ja", head: "octocat:portal/text/abc123def456", base: "main", body: "why", draft: false });
});

await check("createPullRequest refuses head equal to base, before any request", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error("must not be called"); };
  await assert.rejects(
    () => createPullRequest({ token: TOKEN, owner: "owner", repo: "repo", title: "t", head: "main", base: "main", fetchImpl }),
    (err) => err.code === "head_equals_base" && err.status === 400,
  );
  // The `owner:branch` form of the same thing must be refused too.
  await assert.rejects(
    () => createPullRequest({ token: TOKEN, owner: "owner", repo: "repo", title: "t", head: "octocat:main", base: "main", fetchImpl }),
    (err) => err.code === "head_equals_base",
  );
  assert.equal(called, false);
});

await check("createPullRequest names an existing PR pr_already_exists", async () => {
  const fetchImpl = recordingFetch([{ match: `${GITHUB_API}/repos/owner/repo/pulls`, status: 422, reply: { message: "A pull request already exists for octocat:portal/text/abc123def456." } }]);
  const error = await createPullRequest({ token: TOKEN, owner: "owner", repo: "repo", title: "t", head: "octocat:portal/text/abc123def456", base: "main", fetchImpl }).catch((err) => err);
  assert.equal(error.code, "pr_already_exists");
  assert.equal(error.status, 409);
});

await check("createPullRequest requires a title", async () => {
  await assert.rejects(
    () => createPullRequest({ token: TOKEN, owner: "o", repo: "r", title: " ", head: "h", base: "main", fetchImpl: async () => { throw new Error("must not be called"); } }),
    (err) => err.code === "title_required",
  );
});

await check("getPullRequest reports the PR's own state and merged flag", async () => {
  const fetchImpl = recordingFetch([{
    match: `${GITHUB_API}/repos/owner/repo/pulls/42`,
    reply: { number: 42, state: "closed", merged: true, mergeable_state: "unknown", head: { sha: "9".repeat(40) }, html_url: "https://github.com/owner/repo/pull/42" },
  }]);
  assert.deepEqual(await getPullRequest({ token: TOKEN, owner: "owner", repo: "repo", number: 42, fetchImpl }), {
    number: 42,
    state: "closed",
    merged: true,
    mergeable_state: "unknown",
    head_sha: "9".repeat(40),
    html_url: "https://github.com/owner/repo/pull/42",
  });
});

await check("getPullRequest names a missing PR pr_not_found", async () => {
  const fetchImpl = recordingFetch([{ match: `${GITHUB_API}/repos/owner/repo/pulls/7`, status: 404, reply: { message: "Not Found" } }]);
  const error = await getPullRequest({ token: TOKEN, owner: "owner", repo: "repo", number: 7, fetchImpl }).catch((err) => err);
  assert.equal(error.code, "pr_not_found");
  assert.equal(error.status, 404);
});

// ---------------------------------------------------------------------------
// the token never leaves the header
// ---------------------------------------------------------------------------

await check("no error raised anywhere carries the token", async () => {
  // GitHub echoes request-scoped detail back in `message`; a token that reached
  // a body once must not reach a log line through the error object.
  const failures = [
    recordingFetch([{ match: `${GITHUB_API}/user`, status: 403, headers: { "retry-after": "1" }, reply: { message: `token ${TOKEN} is rate limited` } }]),
    recordingFetch([{ match: `${GITHUB_API}/user`, status: 422, reply: { message: `bad request for ${TOKEN}` } }]),
  ];
  for (const fetchImpl of failures) {
    const error = await getAuthenticatedUser({ token: TOKEN, fetchImpl }).catch((err) => err);
    assert.equal(error.name, "GitHubCollabError");
    assert.ok(!JSON.stringify({ code: error.code, detail: error.detail, message: error.message }).includes(TOKEN), "the token must be redacted");
    assert.ok(error.detail.includes("[redacted]"), "a token-shaped detail is replaced, not dropped");
  }
});

await check("redactSecrets scrubs every GitHub token shape", () => {
  assert.equal(redactSecrets(`x ${TOKEN} y`), "x [redacted] y");
  assert.equal(redactSecrets("github_pat_" + "TESTONLY" + "0".repeat(18)), "[redacted]"); // TESTONLY: constructed synthetic redaction fixture.
  assert.equal(redactSecrets("ghs_" + "TESTONLY" + "0".repeat(12)), "[redacted]"); // TESTONLY: constructed synthetic redaction fixture.
  assert.equal(redactSecrets("no token here"), "no token here");
});

// ---------------------------------------------------------------------------
// the Worker surface wired on top of this module
//
// These checks are source-level on purpose: the Worker's routes need a D1
// database, a Cloudflare Access header and a real GitHub, so what can be pinned
// here cheaply is that the wiring exists and that the gates are still in it. The
// runtime behaviour of each route is NOT covered by this file.
// ---------------------------------------------------------------------------

const WORKER_SOURCE = await import("node:fs/promises").then((fs) => fs.readFile(new URL("./src/worker.js", import.meta.url), "utf8"));

await check("worker.js registers the collaboration routes", () => {
  for (const route of [
    "/api/auth/github/login",
    "/api/auth/github/callback",
    "/api/auth/github/me",
    "/api/contributions/github-pr",
    "/api/images/submit",
    "/api/admin/contributions",
  ]) {
    assert.ok(WORKER_SOURCE.includes(`url.pathname === "${route}"`), `${route} must be routed`);
  }
});

await check("worker.js does not require an Access identity to begin a login", () => {
  // The bug this guards: `requireActor(request, env)` at the top of the login
  // handler made the flow unreachable for the GitHub contributors it exists for.
  const login = WORKER_SOURCE.slice(WORKER_SOURCE.indexOf("async function githubLogin("));
  const body = login.slice(0, login.indexOf("\n}"));
  assert.ok(!/requireActor\(/.test(body), "githubLogin must not require an Access identity");
  assert.ok(!/requireWriteActor\(/.test(body), "githubLogin must not require a session either");
  // And the browser binding is part of it, not an optional extra.
  assert.ok(body.includes("browser_binding_hash"), "the state must be bound to the browser");
});

await check("the retired review/publish handlers are gone from the source", () => {
  for (const name of [
    "async function submit(request, env)",
    "async function review(request, env",
    "async function publish(request, env",
    "async function setImageStatus(",
    "async function requestImageRestore(",
    "async function updateImageRestoreRequest(",
  ]) {
    assert.ok(!WORKER_SOURCE.includes(name), `${name} must not exist — a second review authority must not be one edit away`);
  }
  // The 410 surface that replaces them answers on every retired method.
  assert.ok(WORKER_SOURCE.includes("function retiredResponse("), "the retired routes must answer 410, not 404");
  for (const pathname of ["/api/contributions", "/api/reviews", "/api/publish", "/api/images/status", "/api/images/restore"]) {
    assert.ok(WORKER_SOURCE.includes(`"${pathname}"`), `${pathname} must still be named in the 410 table`);
  }
});

await check("worker.js keeps every fail-closed gate on the proposal path", () => {
  // A proposal is authored with the *contributor's* token now. The gates are the
  // custody ones: no key, no stored token, and a token that GitHub says belongs
  // to somebody else. There is deliberately no `GITHUB_PR_TOKEN` fallback for a
  // write — the deployment token is for the portal's own reads.
  assert.ok(WORKER_SOURCE.includes("github_user_token_custody_unconfigured"), "a deployment with no custody key must refuse");
  assert.ok(WORKER_SOURCE.includes("github_user_token_absent"), "a session with no stored token must refuse");
  assert.ok(WORKER_SOURCE.includes("github_user_mismatch"), "a token for another account must refuse");
  assert.ok(WORKER_SOURCE.includes("content_not_accepted"), "a whole-file body must be refused by name");
  assert.ok(WORKER_SOURCE.includes("binding_conflict"), "a body naming two different bindings must refuse");
  assert.ok(WORKER_SOURCE.includes("github_target_${kind}_unconfigured"), "an unconfigured target repo must refuse");
  assert.ok(WORKER_SOURCE.includes("unity3d_upload_rejected"), "a .unity3d upload must be refused");
  assert.ok(WORKER_SOURCE.includes("composite_version_rejected"), "a composite version must be refused");
  assert.ok(WORKER_SOURCE.includes("GITHUB_PATH_PREFIXES"), "the path whitelist must exist");
  assert.ok(WORKER_SOURCE.includes("github_oauth_states"), "the one-shot OAuth state table must be used");
});

await check("worker.js always requires a fork even with the retired upstream switch", () => {
  const gate = WORKER_SOURCE.match(/function githubAllowUpstream\([^)]*\) \{([\s\S]*?)\n\}/);
  assert.ok(gate);
  assert.ok(gate[1].includes("return false;"));
  assert.ok(!gate[1].includes("env?."));
});

await check("worker.js checks aspect ratio before opening an image proposal", () => {
  const submit = WORKER_SOURCE.slice(WORKER_SOURCE.indexOf("async function submitImageProposal"));
  const gate = submit.indexOf("checkAspectRatio(");
  const proposal = submit.indexOf("submitGithubProposal(");
  assert.ok(gate > 0, "the image path must call checkAspectRatio");
  assert.ok(proposal > gate, "the ratio gate must run before the proposal is assembled");
  assert.ok(!WORKER_SOURCE.includes("resize("), "the portal must not scale an image itself");
});

await check("no exported function ever returns the token", async () => {
  const fetchImpl = recordingFetch([
    { match: `${GITHUB_API}/repos/owner/repo/forks`, status: 200, reply: { full_name: "octocat/repo", default_branch: "main", fork: true, owner: { login: "octocat" } } },
    { match: `${GITHUB_API}/repos/octocat/repo/branches/main`, reply: { commit: { sha: "a".repeat(40) } } },
    { match: `${GITHUB_API}/repos/octocat/repo/git/refs`, status: 201, reply: { ref: "refs/heads/portal/text/abc123def456", object: { sha: "a".repeat(40) } } },
    { match: `${GITHUB_API}/repos/octocat/repo/contents/locales/ja.json`, status: 201, reply: { content: { sha: "4".repeat(40) }, commit: { sha: "5".repeat(40) } } },
    { match: `${GITHUB_API}/repos/owner/repo/pulls`, status: 201, reply: { number: 7, html_url: "u", state: "open" } },
  ]);
  const fork = await ensureFork({ token: TOKEN, owner: "owner", repo: "repo", fetchImpl });
  const head = await getBranchHead({ token: TOKEN, owner: "octocat", repo: "repo", branch: "main", fetchImpl });
  const branch = await createBranch({ token: TOKEN, owner: "octocat", repo: "repo", branch: branchName("text", "abc123def456"), fromSha: head.sha, fetchImpl });
  const written = await putFile({ token: TOKEN, owner: "octocat", repo: "repo", branch: branchName("text", "abc123def456"), path: "locales/ja.json", content: "x", fetchImpl, lookupExisting: false });
  const pr = await createPullRequest({ token: TOKEN, owner: "owner", repo: "repo", title: "t", head: "octocat:portal/text/abc123def456", base: "main", fetchImpl });
  for (const value of [fork, head, branch, written, pr]) {
    assert.ok(!JSON.stringify(value).includes(TOKEN), `a return value carried the token: ${JSON.stringify(value)}`);
  }
});

// ---------------------------------------------------------------------------
// the Worker routes, driven end to end over a real SQLite D1
//
// The GitHub side is still the recording fetch, but everything else is real:
// the Worker's own router, its D1 statements, the schema applied from
// schema.sql + migrations/. This is where "does the gate actually gate" is
// answered — a source-level check cannot tell whether a refusal returns 400 or
// falls through to a 200.
// ---------------------------------------------------------------------------

const { SqliteD1 } = await import("./test_helpers/d1_sqlite.mjs");
const { default: worker } = await import("./src/worker.js");

// `fileURLToPath` 会解码百分号转义（空格、非 ASCII），并返回本地路径（Windows
// 盘符、反斜杠）；`.pathname` 不会：候选若位于带空格的路径下会保留 `%20`，
// 下面每次 `readdirSync` 都会对真实存在的目录报 ENOENT。
const PORTAL_DIR = fileURLToPath(new URL(".", import.meta.url));
const db = new SqliteD1({ portalDir: PORTAL_DIR });
db.applySchema();

const STAMP = "2026-09-29T00:00:00Z";
const TASK_ID = "event_0015_info";
/// The pinned revision everything text-side is verified against.
const BASE_COMMIT = "c".repeat(40);
/// The blob sha of the file at that revision — what GitHub's contents API needs
/// in order to *update* an existing file rather than reject the commit.
const BLOB_SHA = "b".repeat(40);
const EDIT_BUNDLE = "bundle-a";
const EDIT_ITEM = "k";
const EDIT_SOURCE = "通信に失敗しました";
const EDIT_SOURCE_SHA = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(EDIT_SOURCE)))]
  .map((b) => b.toString(16).padStart(2, "0")).join("");
const EDIT_LOGICAL_KEY = `text/${EDIT_BUNDLE}/${EDIT_ITEM}`;
const EDIT_PATH = `locales/story/${EDIT_BUNDLE}.jsonl`;
/// The file as it exists at BASE_COMMIT: the row under edit, plus a neighbour on
/// each side so "only one line changed" is a property this suite can assert.
const EDIT_ROWS = [
  { channel: "assets", bundle: EDIT_BUNDLE, item_key: "before", ja: "前", zh: "前译", source_sha256: "1".repeat(64), translation_status: "accepted", updated_at: STAMP },
  { channel: "assets", bundle: EDIT_BUNDLE, item_key: EDIT_ITEM, ja: EDIT_SOURCE, zh: "旧的译文", source_sha256: EDIT_SOURCE_SHA, translation_status: "accepted", updated_at: STAMP },
  { channel: "assets", bundle: EDIT_BUNDLE, item_key: "after", ja: "後", zh: "后译", source_sha256: "2".repeat(64), translation_status: "accepted", updated_at: STAMP },
];

// The registry the proposal is verified against: the release and the one row
// this fixture edits. The route checks the *catalogue's* source hash and the
// *file's*, so both have to exist and agree.
db.db.prepare(
  `INSERT OR REPLACE INTO assets_releases (asset_version, release_id, server_schema_version, status, source_manifest_sha256, assets_commit, note, created_at, updated_at) ` +
  `VALUES ('1077100', 'assets-1077100', 'v1', 'canonical', NULL, ?, 'fixture', ?, ?)`
).run(BASE_COMMIT, STAMP, STAMP);
db.db.prepare(
  `INSERT OR REPLACE INTO source_catalogue (base_version, bundle, item_key, source_sha256, source, created_at, asset_version, logical_key) ` +
  `VALUES ('1077100', ?, ?, ?, ?, ?, '1077100', ?)`
).run(EDIT_BUNDLE, EDIT_ITEM, EDIT_SOURCE_SHA, EDIT_SOURCE, STAMP, EDIT_LOGICAL_KEY);
const EDIT_FILE_TEXT = `${EDIT_ROWS.map((row) => JSON.stringify(row)).join("\n")}\n`;
// Two 1x1 vertices are enough: only the IHDR is read. Built here rather than
// imported from test_image_ratio.mjs, which would run that suite a second time.
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

db.db.prepare(
  `INSERT INTO image_task_units (task_id, bundle, category, width, height, image_format, has_alpha, r2_key, source_sha256, created_at, updated_at) ` +
  `VALUES (?, 'bundle-x', 'system_ui', 512, 256, 'png', 0, NULL, NULL, ?, ?)`
).run(TASK_ID, STAMP, STAMP);

const routeEnv = {
  DB: db,
  ENVIRONMENT: "test",
  REVIEWER_EMAILS: "reviewer@example.test",
  ADMIN_EMAILS: "admin@example.test",
  REVIEWER_GITHUB_LOGINS: "reviewer",
  ADMIN_GITHUB_LOGINS: "admin",
  // A proposal is authored with the contributor's token, held encrypted under
  // this key. The deployment token stays for the portal's own reads.
  USER_TOKEN_KEY: "a1".repeat(32),
  PORTAL_CANONICAL_ORIGIN: "https://portal.test",
  GITHUB_PR_TOKEN: "ghp_TESTONLYROUTETOKEN000000000000000",
  GITHUB_TARGET_ASSETS: "kohakunamori/MLTDTranslationAssets",
  GITHUB_TARGET_CLIENT: "kohakunamori/MLTDTranslationClient",
  GITHUB_OAUTH_CLIENT_ID: "cid",
  GITHUB_OAUTH_CLIENT_SECRET: "cs_TESTONLYROUTESECRET000000000000000",
};

/// A portal session for an actor, so `callRoute` can drive an authenticated
/// write the way a browser does: a cookie plus the per-session CSRF token.
///
/// The login flow itself has its own suite; what this needs is the *state* a
/// signed-in contributor is in — a GitHub-keyed session with a stored token — so
/// the proposal routes can be exercised end to end. `githubUserId` is fixed per
/// email so a check that calls three times uses one identity, and the recording
/// fetch answers `/user` with the same id.
const { issueSession, roleFor, CSRF_HEADER, SESSION_COOKIE_NAME } = await import("./src/github_session.js");
const { putUserToken } = await import("./src/github_user_token.js");
const sessions = new Map();
const GITHUB_USER_BY_EMAIL = new Map();
let nextGithubUserId = 700001;
/// The GitHub account a fixture email stands for. Assigned on first use so a
/// route list built *before* the session exists still names the right id.
function githubUserIdFor(email) {
  const key = String(email).toLowerCase();
  if (!GITHUB_USER_BY_EMAIL.has(key)) GITHUB_USER_BY_EMAIL.set(key, nextGithubUserId++);
  return GITHUB_USER_BY_EMAIL.get(key);
}

async function sessionFor(email) {
  const key = String(email).toLowerCase();
  if (sessions.has(key)) return sessions.get(key);
  const githubUserId = githubUserIdFor(key);
  const login = key.split("@")[0].replace(/[^a-z0-9-]/g, "-");
  const actorKey = `github:${githubUserId}`;
  const issued = await issueSession(routeEnv, {
    actor: { key: actorKey, email: null, login, github_user_id: githubUserId, role: roleFor(routeEnv, { email: key }) },
  });
  // The token a signed-in contributor would hold after the callback. It is
  // sealed through the same module the callback uses, so this fixture cannot
  // drift from the real custody path.
  const tokenValue = `gho_TESTONLYROUTETOKEN${String(githubUserId).padStart(9, "0")}`;
  await putUserToken(routeEnv, actorKey, tokenValue);
  Object.assign(issued, { actorKey, githubUserId, tokenValue });
  sessions.set(key, issued);
  return issued;
}

/// The `/user` answer for a session's token. Every write begins with this probe,
/// so each route list starts with it.
function identityRouteFor(email) {
  const key = String(email).toLowerCase();
  return { match: (url) => url === `${GITHUB_API}/user`, reply: { login: key.split("@")[0], id: githubUserIdFor(key), avatar_url: null } };
}

async function callRoute(path, { method = "GET", email, body, env = routeEnv, origin = "https://portal.test" } = {}) {
  if ((path.startsWith("/api/admin/contributions") || path.startsWith("/api/queue")) && email) {
    const upstreamFetch = env.GITHUB_COLLAB_FETCH;
    const defaults = /^(reviewer|admin)@/.test(email) ? { assets: { maintain: true }, client: { maintain: true } } : {};
    const granted = env.MOCK_REPO_PERMISSIONS || defaults;
    env = { ...env, GITHUB_COLLAB_FETCH: async (url, init) => {
      if (url === `${GITHUB_API}/user`) return new Response(JSON.stringify({ id: githubUserIdFor(email), login: email.split("@")[0] }), { status: 200 });
      for (const target of ["assets", "client"]) {
        const fullName = target === "assets" ? routeEnv.GITHUB_TARGET_ASSETS : routeEnv.GITHUB_TARGET_CLIENT;
        if (url === `${GITHUB_API}/repos/${fullName}`) return new Response(JSON.stringify({ full_name: fullName, permissions: granted[target] || {} }), { status: 200 });
      }
      return upstreamFetch ? upstreamFetch(url, init) : new Response("{}", { status: 404 });
    }};
  }
  const headers = new Headers({ origin });
  if (email) {
    const session = await sessionFor(email);
    if (env !== routeEnv) {
      // A route that runs against its own env still needs the token where *it*
      // will look for it.
      await putUserToken(env, session.actorKey, session.tokenValue);
    }
    headers.set("cookie", `${SESSION_COOKIE_NAME}=${session.token}`);
    headers.set(CSRF_HEADER, session.csrfToken);
    // The Access header rides along too: a signed-in operator browsing through
    // Access has both, and the session must be the one that is used.
    headers.set("Cf-Access-Authenticated-User-Email", email);
  }
  const request = new Request(`https://portal.test${path}`, {
    method,
    headers: body === undefined ? headers : new Headers([...headers, ["content-type", "application/json"]]),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await worker.fetch(request, env);
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
  return { response, body: parsed };
}

/// The full GitHub conversation one happy-path proposal makes, in order.
/// The full GitHub conversation one happy-path edit makes, in order.
///
/// `identityRouteFor` first — every write asks GitHub which account the stored
/// token belongs to — then the pinned read (which hands back the blob sha the
/// commit presents), then fork -> branch -> commit -> PR.
function proposalRoutes({ owner = "kohakunamori", repo = "MLTDTranslationAssets", forkFullName = "octocat/MLTDTranslationAssets", prNumber = 101, forkFlag = true, status = 200, email = "contributor@example.test", fileText = EDIT_FILE_TEXT, blobSha = BLOB_SHA } = {}) {
  return [
    identityRouteFor(email),
    { match: `${GITHUB_API}/repos/${owner}/${repo}/forks`, status, reply: { full_name: forkFullName, default_branch: "main", fork: forkFlag, owner: { login: forkFullName.split("/")[0] } } },
    { match: (url) => url.startsWith(`${GITHUB_API}/repos/${owner}/${repo}/contents/`) && url.includes(`?ref=${BASE_COMMIT}`), reply: { type: "file", encoding: "base64", sha: blobSha, content: Buffer.from(fileText, "utf8").toString("base64") } },
    { match: (url, init) => url.startsWith(`${GITHUB_API}/repos/octocat/${repo}/contents/`) && (init?.method || "GET") === "PUT", status: 200, reply: { content: { sha: "c".repeat(40), html_url: "https://github.com/x" }, commit: { sha: "d".repeat(40) } } },
    { match: (url, init) => url.startsWith(`${GITHUB_API}/repos/octocat/${repo}/contents/`) && (init?.method || "GET") === "GET", reply: { type: "file", encoding: "base64", sha: blobSha, content: Buffer.from(fileText, "utf8").toString("base64") } },
    { match: `${GITHUB_API}/repos/octocat/${repo}/branches/main`, reply: { commit: { sha: "a".repeat(40) } } },
    { match: `${GITHUB_API}/repos/octocat/${repo}/git/refs`, status: 201, reply: { ref: "refs/heads/portal/text/x", object: { sha: BASE_COMMIT } } },
    { match: `${GITHUB_API}/repos/${owner}/${repo}/pulls`, status: 201, reply: { number: prNumber, html_url: `https://github.com/${owner}/${repo}/pull/${prNumber}`, state: "open" } },
  ];
}

/// The proposal body the frozen front end sends: flat, binding at the top level.
function editBody({ translation = "新的译文", path = EDIT_PATH, target = "assets", version = { asset_version: "1077100" }, ...rest } = {}) {
  return {
    target,
    path,
    base_commit: BASE_COMMIT,
    source_sha256: EDIT_SOURCE_SHA,
    bundle: EDIT_BUNDLE,
    item_key: EDIT_ITEM,
    logical_key: EDIT_LOGICAL_KEY,
    translation,
    ...version,
    ...rest,
  };
}

// The login flow itself — the browser binding, the session it mints, the token
// it refuses to keep — is covered by `test_github_session.mjs`, which drives it
// over the same SQLite D1 with a recording GitHub. What stays here are the
// proposal routes, which need the fork/branch/PR conversation this file models.

await check("POST /api/contributions/github-pr refuses a body with no binding, a bad path and a whole file", async () => {
  const route = (body, env = routeEnv) => callRoute("/api/contributions/github-pr", { method: "POST", email: "contributor@example.test", body, env });

  // No binding at all: the route is an edit, and an edit names where it lands.
  const noBinding = await route({ translation: "x" });
  assert.equal(noBinding.response.status, 400);
  assert.equal(noBinding.body.error, "target_invalid");

  const noCommit = await route({ target: "assets", path: "locales/story/a.jsonl", source_sha256: "a".repeat(64), bundle: "bundle-a", item_key: "k", translation: "x", asset_version: "1077100" });
  assert.equal(noCommit.response.status, 400);
  assert.equal(noCommit.body.error, "base_commit_required");

  const badSha = await route({ target: "assets", path: "locales/story/a.jsonl", base_commit: "c".repeat(40), source_sha256: "nope", bundle: "bundle-a", item_key: "k", translation: "x", asset_version: "1077100" });
  assert.equal(badSha.response.status, 400);
  assert.equal(badSha.body.error, "resource_source_sha256_invalid");

  // The shape that used to be the whole-file branch is refused by *name*: a
  // caller still sending a file is running against an old contract.
  const wholeFile = await route({ target: "assets", path: "locales/story/a.jsonl", base_commit: "c".repeat(40), source_sha256: "a".repeat(64), logical_key: "text/a/b", content: "{}", asset_version: "1077100" });
  assert.equal(wholeFile.response.status, 400);
  assert.equal(wholeFile.body.error, "content_not_accepted");

  // An unconfigured target repository is a deployment error, not a default. The
  // refusal happens in the *proposal* step — the binding reader only checks the
  // shape — which this suite reaches with the fork conversation programmed, so
  // the body is otherwise valid and the code is the specific one.
  const noTargetFetch = recordingFetch([identityRouteFor("contributor@example.test"), {
    match: (url) => url.endsWith(`/repos/kohakunamori/MLTDTranslationAssets/forks`),
    status: 200,
    reply: { full_name: "octocat/MLTDTranslationAssets", default_branch: "main", fork: true, owner: { login: "octocat" } },
  }]);
  const noTarget = await route(
    { target: "assets", path: "locales/story/a.jsonl", base_commit: "c".repeat(40), source_sha256: "a".repeat(64), bundle: "bundle-a", item_key: "k", translation: "x", asset_version: "1077100" },
    { ...routeEnv, GITHUB_TARGET_ASSETS: "", GITHUB_COLLAB_FETCH: noTargetFetch },
  );
  assert.ok([503, 502].includes(noTarget.response.status), JSON.stringify(noTarget.body));
  assert.ok(
    ["github_target_assets_unconfigured", "github_unreachable", "github_not_found"].includes(noTarget.body.error),
    `an unconfigured target must not be served by a default: ${noTarget.body.error}`,
  );

  // `target_invalid` is the shape check and runs before any repository lookup,
  // so it is stable even with a target repository configured.
  const badTarget = await route({ target: "server", path: "locales/story/a.jsonl", base_commit: "c".repeat(40), source_sha256: "a".repeat(64), bundle: "bundle-a", item_key: "k", translation: "x", asset_version: "1077100" });
  assert.equal(badTarget.response.status, 400);
  assert.equal(badTarget.body.error, "target_invalid");

  const unity3d = await route({ target: "assets", path: "locales/pack.unity3d", base_commit: "c".repeat(40), source_sha256: "a".repeat(64), bundle: "bundle-a", item_key: "k", translation: "x", asset_version: "1077100" });
  assert.equal(unity3d.response.status, 400);
  assert.equal(unity3d.body.error, "unity3d_upload_rejected");

  // `path_invalid` for a traversal, `path_not_allowed` for a path that is
  // simply not in the whitelist. Both are 400 refusals; the code says which.
  const traversal = await route({ target: "assets", path: "locales/../secrets.json", base_commit: "c".repeat(40), source_sha256: "a".repeat(64), bundle: "bundle-a", item_key: "k", translation: "x", asset_version: "1077100" });
  assert.equal(traversal.response.status, 400);
  assert.equal(traversal.body.error, "path_invalid");

  for (const path of ["src/worker.js", "images/restored/x.png", "locales", "README.md"]) {
    const refused = await route({ target: "assets", path, base_commit: "c".repeat(40), source_sha256: "a".repeat(64), bundle: "bundle-a", item_key: "k", translation: "x", asset_version: "1077100" });
    assert.equal(refused.response.status, 400, `${path} must be refused: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.error, "path_not_allowed");
  }
});

await check("POST /api/contributions/github-pr rejects a composite version with the registry's own code", async () => {
  const route = (body) => callRoute("/api/contributions/github-pr", { method: "POST", email: "contributor@example.test", body });
  const base = { target: "assets", path: "locales/story/a.jsonl", base_commit: "c".repeat(40), source_sha256: "a".repeat(64), bundle: "bundle-a", item_key: "k", translation: "x" };
  for (const value of ["9.0.200+1077100", "assets-1077100"]) {
    const { response, body } = await route({ ...base, asset_version: value });
    assert.equal(response.status, 400, `${value} must be refused`);
    assert.equal(body.error, "composite_version_rejected");
  }
  // The independent axes: a client proposal may not carry an asset version, and
  // a composite is never an identity on either axis.
  const both = await route({ ...base, target: "client", asset_version: "1077100", client_version: "9.0.200" });
  assert.equal(both.response.status, 400);
  assert.equal(both.body.error, "independent_axes_violated");
  const compositeClient = await route({ ...base, target: "client", client_version: "9.0.200+1077100" });
  assert.equal(compositeClient.response.status, 400);
  assert.equal(compositeClient.body.error, "composite_version_rejected");
});

await check("the nested and flat bindings must agree when both are sent", async () => {
  const nested = {
    resource: { github: { target: "assets", path: "locales/story/a.jsonl", base_commit: "c".repeat(40), source_sha256: "a".repeat(64) } },
    translation: "x",
    asset_version: "1077100",
  };
  const agreeing = { ...nested, target: "assets", path: "locales/story/a.jsonl", base_commit: "c".repeat(40), source_sha256: "a".repeat(64) };
  const disagreeing = { ...agreeing, path: "locales/story/b.jsonl" };
  const { response, body } = await callRoute("/api/contributions/github-pr", { method: "POST", email: "contributor@example.test", body: disagreeing });
  assert.equal(response.status, 409);
  assert.equal(body.error, "binding_conflict");
  // The agreeing form gets past the binding reader; it then fails on custody or
  // the pinned read, which is a *different* code and proves the shape is accepted.
  const agreed = await callRoute("/api/contributions/github-pr", { method: "POST", email: "contributor@example.test", body: agreeing });
  assert.notEqual(agreed.body.error, "binding_conflict");
  assert.notEqual(agreed.body.error, "target_invalid");
});

await check("POST /api/contributions/github-pr opens a fork->branch->PR edit and mirrors it in D1", async () => {
  const fetchImpl = recordingFetch(proposalRoutes());
  const { response, body } = await callRoute("/api/contributions/github-pr", {
    method: "POST",
    email: "contributor@example.test",
    env: { ...routeEnv, GITHUB_COLLAB_FETCH: fetchImpl },
    body: editBody({ message: "portal: ja" }),
  });
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.pr_number, 101);
  assert.equal(body.fork, "octocat/MLTDTranslationAssets");
  assert.equal(body.target_repo, "kohakunamori/MLTDTranslationAssets");
  assert.equal(body.base_branch, "main");
  assert.equal(body.state, "open");
  assert.equal(body.upstream_direct, false, "a real fork path must say so, not leave the field absent");
  assert.match(body.branch, /^portal\/text\/[a-z0-9]{12}$/);
  assert.equal(body.single_line_edit, true);
  assert.equal(body.row_index, 1, "the second line of the fixture file");

  // The branch is cut at the *pinned commit*, not at the fork's tip.
  const refCall = fetchImpl.calls.find((call) => call.url.endsWith("/git/refs"));
  assert.equal(jsonBody(refCall).sha, BASE_COMMIT);

  // The commit presents the blob sha the pinned read returned — that is what
  // makes it an update of an existing file rather than a 422.
  const commitCall = fetchImpl.calls.find((call) => (call.init?.method || "GET") === "PUT");
  const commitBody = jsonBody(commitCall);
  assert.equal(commitBody.sha, BLOB_SHA, "the contents API updates by blob sha");
  assert.equal(commitBody.branch, body.branch);
  assert.equal(commitBody.message, "portal: ja");
  // And the file it commits is the fixture with exactly one line changed.
  const committed = Buffer.from(commitBody.content, "base64").toString("utf8");
  const before = EDIT_FILE_TEXT.split("\n");
  const after = committed.split("\n");
  assert.equal(after.length, before.length);
  let changed = 0;
  for (let index = 0; index < after.length; index += 1) {
    if (after[index] === before[index]) continue;
    changed += 1;
    assert.equal(index, 1, "only the edited row may differ");
    const row = JSON.parse(after[index]);
    assert.equal(row.zh, "新的译文");
    assert.equal(row.translation_status, "modified");
    assert.equal(row.ja, EDIT_SOURCE);
  }
  assert.equal(changed, 1);

  const mirror = db.db.prepare(`SELECT target_repo, base_branch, head_branch, fork_full_name, pr_number, pr_url, state, head_sha, created_by FROM github_prs WHERE pr_number=101`).get();
  assert.equal(mirror.target_repo, "kohakunamori/MLTDTranslationAssets");
  assert.equal(mirror.head_branch, body.branch);
  assert.equal(mirror.fork_full_name, "octocat/MLTDTranslationAssets");
  assert.equal(mirror.state, "open");
  assert.equal(mirror.head_sha, "d".repeat(40));
  assert.match(mirror.created_by, /^github:\d+$/, "the mirror row is keyed by the stable identity");

  // The independent axes row is written beside it, with the bare asset version.
  const axis = db.db.prepare(`SELECT asset_version, client_version FROM asset_axes WHERE logical_key=?`).get(EDIT_LOGICAL_KEY);
  assert.equal(axis.asset_version, "1077100");
  assert.equal(axis.client_version, null);
});

await check("a proposal is refused when the stored token belongs to another account", async () => {
  const fetchImpl = recordingFetch([
    { match: (url) => url === `${GITHUB_API}/user`, reply: { login: "someone-else", id: 424242, avatar_url: null } },
    ...proposalRoutes().slice(1),
  ]);
  const { response, body } = await callRoute("/api/contributions/github-pr", {
    method: "POST",
    email: "contributor@example.test",
    env: { ...routeEnv, GITHUB_COLLAB_FETCH: fetchImpl },
    body: editBody(),
  });
  assert.equal(response.status, 409, JSON.stringify(body));
  assert.equal(body.error, "github_user_mismatch");
});

await check("a composite version cannot reach asset_axes even if a caller got one that far", () => {
  // Belt and braces: the route refuses it first, and the schema refuses it last.
  for (const value of ["9.0.200+1077100", "assets-1077100"]) {
    assert.throws(
      () => db.db.prepare(`INSERT INTO asset_axes (logical_key, asset_version, created_at) VALUES (?, ?, ?)`).run(`probe/${value}`, value, STAMP),
      /CHECK constraint failed/,
      `${value} must be unrepresentable`,
    );
  }
});

/// The image proposal body the frozen contract sends: the pixels plus the
/// binding every write now carries.
function imageBody({ taskId = TASK_ID, imageBase64, target = "assets", path = `images/restored/${TASK_ID}/restored-texture.png`, baseCommit = BASE_COMMIT, sourceSha256 = null, assetVersion = "1077100", ...rest } = {}) {
  const body = { task_id: taskId, image_base64: imageBase64, target, path, base_commit: baseCommit, ...rest };
  if (sourceSha256 !== null) body.source_sha256 = sourceSha256;
  if (assetVersion !== null) body.asset_version = assetVersion;
  return body;
}

/// The task's own original hash, which a proposal must carry.
const IMAGE_SOURCE_SHA256 = "7".repeat(64);
db.db.prepare(`UPDATE image_task_units SET source_sha256=? WHERE task_id=?`).run(IMAGE_SOURCE_SHA256, TASK_ID);
// The release the image proposals name, with its own pin: the route resolves it
// and compares that pin with the one the body sends.
db.db.prepare(
  `INSERT OR REPLACE INTO assets_releases (asset_version, release_id, server_schema_version, status, source_manifest_sha256, assets_commit, note, created_at, updated_at) ` +
  `VALUES ('1077100', 'assets-1077100', 'v1', 'canonical', NULL, ?, 'fixture', ?, ?)`
).run(BASE_COMMIT, STAMP, STAMP);
db.db.prepare(
  `INSERT OR REPLACE INTO resource_units (resource_id, resource_kind, logical_key, category, created_at) VALUES ('res_image_collab', 'image', 'image/bundle-x', 'system_ui', ?)`
).run(STAMP);
db.db.prepare(
  `INSERT OR REPLACE INTO source_variants (source_variant_id, resource_id, release_kind, release_id, source_sha256, source, bundle, item_key, created_at) ` +
  `VALUES ('sv_image_collab', 'res_image_collab', 'assets', 'assets-1077100', ?, 'bundle-x', 'bundle-x', ?, ?)`
).run(IMAGE_SOURCE_SHA256, TASK_ID, STAMP);

await check("POST /api/images/submit refuses a wrong ratio, a downsample and a non-PNG without calling GitHub", async () => {
  let githubCalled = false;
  const fetchImpl = async () => { githubCalled = true; throw new Error("GitHub must not be called"); };
  const env = { ...routeEnv, GITHUB_COLLAB_FETCH: fetchImpl };
  const post = (body) => callRoute("/api/images/submit", { method: "POST", email: "artist@example.test", env, body });

  // A missing binding is refused before the pixels are even looked at: which
  // repository a proposal lands in is not something an upload may decide.
  const noBinding = await post({ task_id: TASK_ID, image_base64: PNG_1x1 });
  assert.equal(noBinding.response.status, 400);
  assert.equal(noBinding.body.error, "target_invalid");

  // 1x1 against a 512x256 task is both a downsample and the wrong ratio: the
  // resolution rule is the one that fires.
  const downsample = await post(imageBody({ imageBase64: PNG_1x1, sourceSha256: IMAGE_SOURCE_SHA256 }));
  assert.equal(downsample.response.status, 400);
  assert.equal(downsample.body.error, "resolution_below_original");

  const unknown = await post(imageBody({ taskId: "no_such_task", imageBase64: PNG_1x1, path: "images/restored/no_such_task/restored-texture.png", sourceSha256: IMAGE_SOURCE_SHA256 }));
  assert.equal(unknown.response.status, 404);
  assert.equal(unknown.body.error, "task_not_found");

  const notAnImage = await post(imageBody({ imageBase64: Buffer.from("not-an-image").toString("base64"), sourceSha256: IMAGE_SOURCE_SHA256 }));
  assert.equal(notAnImage.response.status, 400);
  assert.equal(notAnImage.body.error, "image_unsupported_format");

  // The source hash is part of the binding and is checked as one: omitted is a
  // shape error, and a value that is not the task's own is a mismatch (asserted
  // in the session suite, which has a task with a known original).
  const noSource = await post(imageBody({ imageBase64: PNG_1x1 }));
  assert.equal(noSource.response.status, 400);
  assert.equal(noSource.body.error, "resource_source_sha256_invalid");

  // A well-formed commit that is not the named release's pin is refused as such.
  const wrongPin = await post(imageBody({ imageBase64: PNG_1x1, baseCommit: "f".repeat(40), sourceSha256: IMAGE_SOURCE_SHA256 }));
  assert.equal(wrongPin.response.status, 409);
  assert.equal(wrongPin.body.error, "release_pin_mismatch");

  assert.equal(githubCalled, false, "a refused image must not reach GitHub");
  assert.equal(db.db.prepare(`SELECT COUNT(*) AS n FROM github_prs`).get().n, 1, "no refused image may write a mirror row");
});

/// The bytes a recorded `putFile` request actually asked GitHub to commit.
/// `putFile` sends the UTF-8 encoding of its content, base64'd; decoding it back
/// is the only way to see what a downstream decoder would see.
function committedBytes(call) {
  return Buffer.from(jsonBody(call).content, "base64");
}

await check("POST /api/images/submit accepts a larger same-ratio PNG and opens the PR", async () => {
  // A 1024x512 redraw of a 512x256 task: same 2:1 ratio, both sides larger.
  const png = Buffer.from(pngBase64(1024, 512), "base64");
  const fetchImpl = recordingFetch(proposalRoutes({ prNumber: 202, email: "artist@example.test" }));
  const upstream = await callRoute("/api/images/submit", {
    method: "POST",
    email: "artist@example.test",
    env: { ...routeEnv, GITHUB_COLLAB_FETCH: fetchImpl },
    body: imageBody({ imageBase64: pngBase64(1024, 512), sourceSha256: IMAGE_SOURCE_SHA256 }),
  });
  assert.equal(upstream.response.status, 200, JSON.stringify(upstream.body));
  assert.equal(upstream.body.pr_number, 202);
  assert.equal(upstream.body.size, "1024x512");
  assert.equal(upstream.body.format, "png");
  assert.equal(upstream.body.original_size, "512x256");
  assert.equal(upstream.body.aspect_ratio, "2:1");
  assert.equal(upstream.body.original_ratio, "2:1");
  assert.equal(upstream.body.scaling, "ci", "the portal checks; CI scales");
  assert.equal(upstream.body.branch.startsWith("portal/image/"), true, "an image proposal uses the image branch kind");

  // THE commit-content property. The path ends in `.png`, so what lands in the
  // repository has to *be* a PNG. A base64 data URL committed here would decode
  // to the ASCII `data` (64 61 74 61) and every downstream decoder — the Assets
  // CI backfill included — would reject the file.
  // A `lookupExisting` read precedes the commit, so the *commit* is the PUT.
  const written = fetchImpl.calls.find((call) => call.url.includes("/contents/") && (call.init?.method || "GET") === "PUT");
  const bytes = committedBytes(written);
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "the committed blob must start with the PNG signature");
  assert.deepEqual([...bytes], [...png], "the committed blob must be the uploaded image, byte for byte");
  assert.ok(!bytes.toString("latin1").startsWith("data:"), "a data URL must never be committed");
  // The width/height in the committed IHDR are still the 1024x512 that passed
  // the gate — measured, not claimed.
  assert.equal(bytes.readUInt32BE(16), 1024);
  assert.equal(bytes.readUInt32BE(20), 512);
});

await check("an uploaded JPEG is committed as JPEG bytes, not as text", async () => {
  // A 2048x1024 JPEG against the 512x256 task: 2:1, larger on both sides. The
  // task declares `png`, so this also pins the format gate in the other
  // direction — a JPEG must be refused, not silently committed.
  const jpeg = jpegBytes(2048, 1024);
  const refused = await callRoute("/api/images/submit", {
    method: "POST",
    email: "artist@example.test",
    env: { ...routeEnv, GITHUB_COLLAB_FETCH: async () => { throw new Error("GitHub must not be called"); } },
    body: imageBody({ imageBase64: Buffer.from(jpeg).toString("base64"), sourceSha256: IMAGE_SOURCE_SHA256 }),
  });
  assert.equal(refused.response.status, 400);
  assert.equal(refused.body.error, "image_format_mismatch");

  // With a task that does declare JPEG, the same upload is accepted — and the
  // bytes that reach GitHub are still JPEG bytes.
  db.db.prepare(
    `INSERT OR REPLACE INTO image_task_units (task_id, bundle, category, width, height, image_format, has_alpha, source_sha256, created_at, updated_at) ` +
    `VALUES ('jpeg_task', 'bundle-x', 'system_ui', 512, 256, 'jpeg', 0, ?, ?, ?)`
  ).run(IMAGE_SOURCE_SHA256, STAMP, STAMP);
  const fetchImpl = recordingFetch(proposalRoutes({ prNumber: 303, email: "artist@example.test" }));
  const accepted = await callRoute("/api/images/submit", {
    method: "POST",
    email: "artist@example.test",
    env: { ...routeEnv, GITHUB_COLLAB_FETCH: fetchImpl },
    body: imageBody({ taskId: "jpeg_task", imageBase64: Buffer.from(jpeg).toString("base64"), path: "images/restored/jpeg_task/restored-texture.png", sourceSha256: IMAGE_SOURCE_SHA256 }),
  });
  assert.equal(accepted.response.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.format, "jpeg");
  // A `lookupExisting` read precedes the commit, so the *commit* is the PUT.
  const written = fetchImpl.calls.find((call) => call.url.includes("/contents/") && (call.init?.method || "GET") === "PUT");
  const bytes = committedBytes(written);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff], "the committed blob must start with the JPEG SOI/APP0");
  assert.deepEqual([...bytes], [...jpeg], "the committed blob must be the uploaded image, byte for byte");
});

await check("GET /api/admin/contributions is reviewer-gated and reports the PR as the review authority", async () => {
  const denied = await callRoute("/api/admin/contributions", { email: "contributor@example.test" });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.body.error, "github_repo_maintainer_required");
  const anonymous = await callRoute("/api/admin/contributions");
  assert.equal(anonymous.response.status, 401);

  const { response, body } = await callRoute("/api/admin/contributions?limit=5", { email: "reviewer@example.test" });
  assert.equal(response.status, 200);
  assert.equal(body.review_authority, "github_pull_request");
  assert.equal(body.limit, 5);

  // A row with no contribution row still lists, because the proposal is the
  // thing a maintainer triages; `ja`/`zh` are null for it by construction.
  const row = body.rows.find((entry) => entry.github?.pr_number === 101);
  assert.ok(row, "the text proposal must appear");
  assert.equal(row.github.state, "open");
  assert.equal(row.github.target_repo, "kohakunamori/MLTDTranslationAssets");
  assert.equal("source_sha256" in row, true, "the text diff needs the source hash and both sides");
  assert.equal("ja" in row && "zh" in row, true);

  const tiny = await callRoute("/api/admin/contributions?limit=5000", { email: "admin@example.test" });
  assert.equal(tiny.body.limit, 100, "the page limit is capped");

  const badStatus = await callRoute("/api/admin/contributions?status=whatever", { email: "admin@example.test" });
  assert.equal(badStatus.response.status, 400);
  assert.equal(badStatus.body.error, "status_invalid");
});

await check("the maintainer listing mirrors a merged PR rather than deciding it", async () => {
  const fetchImpl = recordingFetch([{
    match: `${GITHUB_API}/repos/kohakunamori/MLTDTranslationAssets/pulls/101`,
    reply: { number: 101, state: "closed", merged: true, mergeable_state: "clean", head: { sha: "d".repeat(40) }, html_url: "u" },
  }]);
  const { body } = await callRoute("/api/admin/contributions?refresh=1", {
    email: "admin@example.test",
    env: { ...routeEnv, GITHUB_COLLAB_FETCH: fetchImpl },
  });
  const row = body.rows.find((entry) => entry.github?.pr_number === 101);
  assert.equal(row.github.state, "closed");
  assert.equal(row.github.merged, true);
  const mirror = db.db.prepare(`SELECT state, merged FROM github_prs WHERE pr_number=101`).get();
  assert.equal(mirror.state, "closed");
  assert.equal(mirror.merged, 1);
  // D1 kept no verdict of its own: the contribution row's status is untouched.
  assert.equal(db.db.prepare(`SELECT COUNT(*) AS n FROM reviews`).get().n, 0, "a merge is not a portal review row");
});

await check("the proposal route never writes a token into D1 or the audit trail", async () => {
  const dump = JSON.stringify([
    db.db.prepare(`SELECT * FROM github_prs`).all(),
    db.db.prepare(`SELECT * FROM github_identities`).all(),
    db.db.prepare(`SELECT action, detail_json FROM audit_events`).all(),
  ]);
  assert.ok(!dump.includes(routeEnv.GITHUB_PR_TOKEN), "the PR token must never be persisted");
  assert.ok(!dump.includes(routeEnv.GITHUB_OAUTH_CLIENT_SECRET), "the client secret must never be persisted");
  assert.ok(!dump.includes("gho_route"), "an access token must never be persisted");
});

// ---------------------------------------------------------------------------
// the upstream-accessible token, over the same real D1
//
// The three fork responses are told apart at the unit level above. What these
// two checks add is what the *route* does about response C, which is the part a
// contributor would otherwise never learn about: by default nothing is opened
// anywhere, and with the opt-in the row and the audit trail both say that no
// fork was involved.
// ---------------------------------------------------------------------------

/// Real response C: the token can already write to the target, so GitHub creates
/// no fork and describes the source repository instead.
function upstreamForkReply(owner, repo) {
  return { full_name: `${owner}/${repo}`, default_branch: "main", fork: false, owner: { login: owner } };
}

/// Both axes, and both the text and the image submission surface: the refusal is
/// a property of the fork step, not of which form a proposal arrived through.
/// The image entry is a 1024x512 redraw of the 512x256 task, so the upload
/// itself validates — it has to reach the fork for this assertion to mean
/// anything.
const upstreamBodies = [
  editBody(),
  editBody({ path: "locales/story/other_b.jsonl", logical_key: "text/bundle-a/other_b" }),
  // The image path is the task's own layout; the refusal under test is the fork,
  // so the binding has to be one the route would otherwise accept.
  imageBody({ path: `images/restored/${TASK_ID}/restored-texture.png`, imageBase64: pngBase64(1024, 512), sourceSha256: IMAGE_SOURCE_SHA256 }),
];

await check("a write-capable token must not open a proposal in the upstream unless the route is told to", async () => {
  const before = db.db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action='github_proposal_opened'`).get().n;
  const mirrors = db.db.prepare(`SELECT COUNT(*) AS n FROM github_prs`).get().n;

  for (const payload of upstreamBodies) {
    const owner = "kohakunamori";
    const repo = payload.target === "assets" ? "MLTDTranslationAssets" : "MLTDTranslationClient";
    const isImage = Boolean(payload.image_base64);
    const email = isImage ? "artist@example.test" : "upstream@example.test";
    const fetchImpl = recordingFetch([
      identityRouteFor(email),
      { match: `${GITHUB_API}/repos/${owner}/${repo}/forks`, status: 202, reply: upstreamForkReply(owner, repo) },
      // A text proposal reads its pinned file first, so the read has to succeed
      // for the fork refusal to be the thing that stops it.
      { match: (url) => url.includes("/contents/") && url.includes(`?ref=${BASE_COMMIT}`), reply: { type: "file", encoding: "base64", sha: BLOB_SHA, content: Buffer.from(EDIT_FILE_TEXT, "utf8").toString("base64") } },
    ]);
    const { response, body } = await callRoute(isImage ? "/api/images/submit" : "/api/contributions/github-pr", {
      method: "POST",
      email,
      env: { ...routeEnv, GITHUB_COLLAB_FETCH: fetchImpl },
      // The image payload already carries its binding; only `task_id` has to be
      // added, because the body is what the route reads.
      body: isImage ? { task_id: TASK_ID, ...payload } : payload,
    });
    assert.equal(response.status, 409, `${payload.target} ${payload.path} must be refused: ${JSON.stringify(body)}`);
    assert.equal(body.error, "fork_not_created_upstream_accessible");
    // The refusal happens at the fork: no branch, no commit, no PR, no listing.
    // (The identity probe and, for text, the pinned read precede it.)
    const afterFork = fetchImpl.calls.filter((call) => !call.url.endsWith("/user") && !call.url.includes("/contents/"));
    assert.equal(afterFork.length, 1, "nothing may be opened after a refusal");
  }

  assert.equal(db.db.prepare(`SELECT COUNT(*) AS n FROM github_prs`).get().n, mirrors, "a refused proposal writes no mirror row");
  assert.equal(db.db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action='github_proposal_opened'`).get().n, before, "a refused proposal is never audited as opened");
});

await check("GITHUB_PR_ALLOW_UPSTREAM=true cannot bypass fork-only collaboration", async () => {
  const owner = "kohakunamori";
  const repo = "MLTDTranslationAssets";
  const fetchImpl = recordingFetch([
    identityRouteFor("upstream@example.test"),
    { match: `${GITHUB_API}/repos/${owner}/${repo}/forks`, status: 202, reply: upstreamForkReply(owner, repo) },
    { match: `${GITHUB_API}/repos/${owner}/${repo}/branches/main`, reply: { commit: { sha: "a".repeat(40) } } },
    { match: `${GITHUB_API}/repos/${owner}/${repo}/git/refs`, status: 201, reply: { ref: "refs/heads/portal/text/x", object: { sha: BASE_COMMIT } } },
    { match: (url, init) => url.startsWith(`${GITHUB_API}/repos/${owner}/${repo}/contents/`) && (init?.method || "GET") === "PUT", status: 200, reply: { content: { sha: "c".repeat(40), html_url: "https://github.com/x" }, commit: { sha: "d".repeat(40) } } },
    { match: (url) => url.startsWith(`${GITHUB_API}/repos/${owner}/${repo}/contents/`), reply: { type: "file", encoding: "base64", sha: BLOB_SHA, content: Buffer.from(EDIT_FILE_TEXT, "utf8").toString("base64") } },
    { match: `${GITHUB_API}/repos/${owner}/${repo}/pulls`, status: 201, reply: { number: 777, html_url: `https://github.com/${owner}/${repo}/pull/777`, state: "open" } },
  ]);
  const { response, body } = await callRoute("/api/contributions/github-pr", {
    method: "POST",
    email: "upstream@example.test",
    env: { ...routeEnv, GITHUB_COLLAB_FETCH: fetchImpl, GITHUB_PR_ALLOW_UPSTREAM: "true" },
    body: editBody(),
  });
  assert.equal(response.status, 409, JSON.stringify(body));
  assert.equal(db.db.prepare(`SELECT COUNT(*) AS n FROM github_prs WHERE pr_number=777`).get().n, 0);
  assert.ok(!fetchImpl.calls.some((call) => (call.init?.method || "GET") === "PUT"));
});

await check("GitHub per-repository permissions override local role hints without crossing targets", async () => {
  const denied = await callRoute("/api/admin/contributions", {
    email: "admin@example.test", env: { ...routeEnv, MOCK_REPO_PERMISSIONS: { assets: { pull: true }, client: { push: "true" } } },
  });
  assert.equal(denied.response.status, 403, "an allowlisted admin without real write permission is denied");
  const allowed = await callRoute("/api/admin/contributions", {
    email: "repository-maintainer@example.test", env: { ...routeEnv, MOCK_REPO_PERMISSIONS: { assets: { maintain: true } } },
  });
  assert.equal(allowed.response.status, 200, JSON.stringify(allowed.body));
  assert.ok(allowed.body.rows.every((row) => row.github?.target_repo === routeEnv.GITHUB_TARGET_ASSETS));
  const other = await callRoute("/api/admin/contributions?target=client", {
    email: "repository-maintainer@example.test", env: { ...routeEnv, MOCK_REPO_PERMISSIONS: { assets: { maintain: true } } },
  });
  assert.equal(other.response.status, 403, "Assets maintenance does not authorize Client");
  const writer = await callRoute("/api/admin/contributions?target=assets", {
    email: "writer@example.test", env: { ...routeEnv, MOCK_REPO_PERMISSIONS: { assets: { push: true, maintain: false, admin: false } } },
  });
  assert.equal(writer.response.status, 403, "write-only collaborator is not a repository maintainer");
  const alias = await callRoute("/api/queue?target=assets", {
    email: "repository-maintainer@example.test", env: { ...routeEnv, MOCK_REPO_PERMISSIONS: { assets: { maintain: true } } },
  });
  assert.equal(alias.response.status, 200);
  assert.equal(alias.body.review_authority, "github_pull_request");
  assert.equal(alias.body.writable, false);
});

db.close();

console.log(`github collab PASS (${checks} checks, 0 failed) — MOCK-TESTED, no live GitHub API call`);
