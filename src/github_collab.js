// GitHub collaboration primitives for the translation portal Worker.
//
// Everything here is a thin, dependency-free wrapper over the GitHub REST API
// that runs on the Workers runtime (no Node built-ins, no imports). Every
// function takes an injectable `fetchImpl` so the module is testable without a
// network, and every failure is normalised into `GitHubCollabError` carrying the
// HTTP `status` and a stable `code`.
//
// Two deliberate non-behaviours:
//
//   * Rate limits are *reported*, never retried. A 403/429 surfaces `retryAfter`
//     (Retry-After) and `rateLimitReset` (X-RateLimit-Reset) so the caller
//     decides; a self-sleeping retry inside a Worker burns wall-clock the
//     request does not have.
//   * The token is only ever placed in the Authorization header. It is never
//     logged, never echoed into an error detail, and never returned.
//
// This module is *mock-tested* (see test_github_collab.mjs): the tests inject a
// recording fetch. Nothing here has been exercised against api.github.com.

export const GITHUB_API = "https://api.github.com";
export const GITHUB_OAUTH_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_API_VERSION = "2022-11-28";
export const GITHUB_ACCEPT = "application/vnd.github+json";
export const USER_AGENT = "mltd-translation-portal";

/// The narrowest scope that can fork a public repository and open a pull
/// request against it. `repo` (full private access) is never requested.
export const GITHUB_OAUTH_SCOPE = "public_repo";

/// A fork is created asynchronously: GitHub answers 202 and the repository
/// becomes readable a moment later. The wait is bounded and explicit — a fork
/// that never appears is an error, not an infinite poll.
export const DEFAULT_FORK_MAX_POLLS = 6;
export const DEFAULT_FORK_POLL_DELAY_MS = 1000;

/// Branch kinds. `portal/<kind>/<shortid>` — the kind is part of the name so a
/// maintainer can tell a text proposal from an image proposal in the branch list.
export const BRANCH_KINDS = ["text", "image"];

const FULL_SHA = /^[0-9a-f]{40}$/i;
const SHORT_ID = /^[a-z0-9][a-z0-9-]{5,31}$/;
const REPO_SPEC = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

// A GitHub token is a credential. Anything that could carry one into a log, an
// error detail or an audit row goes through here first.
const TOKEN_PATTERNS = [/gh[pousr]_[A-Za-z0-9]{16,}/g, /github_pat_[A-Za-z0-9_]{16,}/g];

export function redactSecrets(value) {
  let out = String(value ?? "");
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

export class GitHubCollabError extends Error {
  constructor(code, { status = 0, detail = null, retryAfter = null, rateLimitReset = null, requestId = null } = {}) {
    super(code);
    this.name = "GitHubCollabError";
    this.code = code;
    // `status` is GitHub's HTTP status, or 0 when the request never completed.
    this.status = status;
    this.detail = detail == null ? null : redactSecrets(String(detail)).slice(0, 300);
    this.retryAfter = retryAfter == null ? null : String(retryAfter);
    this.rateLimitReset = rateLimitReset == null ? null : String(rateLimitReset);
    this.requestId = requestId == null ? null : String(requestId);
  }

  /// The status to answer an HTTP caller with. GitHub statuses pass through
  /// (they are meaningful to the client); anything else becomes a 502, because a
  /// transport failure is this service's bad gateway, not the caller's fault.
  get httpStatus() {
    return this.status >= 400 && this.status <= 599 ? this.status : 502;
  }
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

function resolveFetch(fetchImpl) {
  const impl = fetchImpl || globalThis.fetch;
  if (typeof impl !== "function") {
    throw new GitHubCollabError("fetch_unavailable", { detail: "no fetch implementation" });
  }
  return impl;
}

function codeForStatus(status) {
  if (status === 401) return "github_unauthorized";
  if (status === 403) return "github_forbidden";
  if (status === 404) return "github_not_found";
  if (status === 409) return "github_conflict";
  if (status === 422) return "github_unprocessable";
  if (status === 429) return "github_rate_limited";
  return `github_error_${status}`;
}

async function readJson(response) {
  let text = "";
  try {
    text = await response.text();
  } catch (_) {
    return null;
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return { message: text.slice(0, 200) };
  }
}

/// One authenticated JSON request against the GitHub API.
///
/// `notFoundCode` lets a caller name the missing thing (a branch, a pull
/// request) instead of returning a generic `github_not_found`.
async function githubFetch(url, {
  token,
  method = "GET",
  body,
  fetchImpl,
  notFoundCode = null,
  codeOverride = null,
  validateStatus = null,
} = {}) {
  const doFetch = resolveFetch(fetchImpl);
  const headers = {
    accept: GITHUB_ACCEPT,
    "user-agent": USER_AGENT,
    "x-github-api-version": GITHUB_API_VERSION,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const init = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await doFetch(url, init);
  } catch (err) {
    throw new GitHubCollabError("github_unreachable", {
      status: 0,
      detail: err?.message || "network failure",
    });
  }

  const status = Number(response?.status) || 0;
  const parsed = await readJson(response);

  if (validateStatus && validateStatus(status)) return { status, body: parsed };

  if (status < 200 || status >= 300) {
    const message = parsed && typeof parsed.message === "string" ? parsed.message : "";
    const code = codeOverride
      || (status === 404 && notFoundCode ? notFoundCode : codeForStatus(status));
    throw new GitHubCollabError(code, {
      status,
      detail: message || `github request failed with status ${status}`,
      retryAfter: response?.headers?.get?.("retry-after") ?? null,
      rateLimitReset: response?.headers?.get?.("x-ratelimit-reset") ?? null,
      requestId: response?.headers?.get?.("x-github-request-id") ?? null,
    });
  }
  return { status, body: parsed };
}

// ---------------------------------------------------------------------------
// base64 (Workers-safe, UTF-8 correct)
// ---------------------------------------------------------------------------

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// `btoa(content)` cannot be used for file content: the portal's payloads are
/// Japanese text, and `btoa` rejects anything above U+00FF. Encoding bytes
/// directly keeps UTF-8 intact and is identical in Workers and Node.
export function bytesToBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let out = "";
  for (let index = 0; index < view.length; index += 3) {
    const b0 = view[index];
    const b1 = index + 1 < view.length ? view[index + 1] : undefined;
    const b2 = index + 2 < view.length ? view[index + 2] : undefined;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : B64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : B64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

const B64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let index = 0; index < B64_ALPHABET.length; index += 1) table[B64_ALPHABET.charCodeAt(index)] = index;
  return table;
})();

export function base64ToBytes(value) {
  const clean = String(value ?? "").replace(/\s+/g, "").replace(/=+$/, "");
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (let index = 0; index < clean.length; index += 1) {
    const code = clean.charCodeAt(index);
    const digit = code < 128 ? B64_LOOKUP[code] : -1;
    if (digit < 0) throw new GitHubCollabError("invalid_base64", { detail: `bad character at ${index}` });
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// OAuth (authorization-code flow)
// ---------------------------------------------------------------------------

/// A single-use CSRF token for the authorization request.
///
/// The *store* is the caller's: this module generates and compares, it never
/// keeps state. One-shot consumption is a property of the store (the portal
/// uses `github_oauth_states.consumed_at`), so a replayed callback can be
/// refused even if the token itself is still inside its TTL.
export function createOAuthState() {
  if (!globalThis.crypto?.randomUUID) {
    throw new GitHubCollabError("crypto_unavailable", { detail: "crypto.randomUUID is required" });
  }
  return globalThis.crypto.randomUUID();
}

/// Constant-time comparison of the state GitHub echoed back against the one the
/// store handed out. A mismatch, an empty expectation and an empty receipt are
/// all refusals.
export function assertOAuthStateMatches(received, expected) {
  const want = String(expected ?? "");
  const got = String(received ?? "");
  if (!want) throw new GitHubCollabError("oauth_state_expected_missing", { status: 400 });
  if (!got) throw new GitHubCollabError("oauth_state_mismatch", { status: 400 });
  const width = Math.max(want.length, got.length);
  let diff = want.length ^ got.length;
  for (let index = 0; index < width; index += 1) {
    diff |= want.charCodeAt(index % want.length) ^ got.charCodeAt(index % got.length);
  }
  if (diff !== 0) throw new GitHubCollabError("oauth_state_mismatch", { status: 400 });
  return true;
}

export function buildAuthorizeUrl({ clientId, redirectUri, state, scope = GITHUB_OAUTH_SCOPE, allowSignup = true } = {}) {
  const id = String(clientId ?? "").trim();
  const redirect = String(redirectUri ?? "").trim();
  const csrf = String(state ?? "").trim();
  if (!id) throw new GitHubCollabError("client_id_required", { status: 500 });
  if (!redirect) throw new GitHubCollabError("redirect_uri_required", { status: 500 });
  if (!csrf) throw new GitHubCollabError("oauth_state_required", { status: 500 });
  const params = new URLSearchParams({
    client_id: id,
    redirect_uri: redirect,
    scope: String(scope || GITHUB_OAUTH_SCOPE),
    state: csrf,
    allow_signup: allowSignup ? "true" : "false",
  });
  return `${GITHUB_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

/// Trade the callback's `code` for an access token.
///
/// The token endpoint answers 200 with `{ error: ... }` on failure, so a
/// non-2xx check is not enough: the body is inspected too. The response body is
/// never attached to an error — on the success path it *is* the credential.
export async function exchangeCodeForToken({ clientId, clientSecret, code, redirectUri, fetchImpl } = {}) {
  const id = String(clientId ?? "").trim();
  const secret = String(clientSecret ?? "").trim();
  const grant = String(code ?? "").trim();
  if (!id) throw new GitHubCollabError("client_id_required", { status: 500 });
  if (!secret) throw new GitHubCollabError("client_secret_required", { status: 500 });
  if (!grant) throw new GitHubCollabError("oauth_code_required", { status: 400 });

  const doFetch = resolveFetch(fetchImpl);
  const form = new URLSearchParams({ client_id: id, client_secret: secret, code: grant });
  if (redirectUri) form.set("redirect_uri", String(redirectUri));

  let response;
  try {
    response = await doFetch(GITHUB_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  } catch (err) {
    throw new GitHubCollabError("github_unreachable", { status: 0, detail: err?.message || "network failure" });
  }

  const status = Number(response?.status) || 0;
  const parsed = await readJson(response);
  if (status < 200 || status >= 300) {
    throw new GitHubCollabError(codeForStatus(status), {
      status,
      detail: parsed?.error_description || parsed?.error || `token exchange failed with status ${status}`,
      retryAfter: response?.headers?.get?.("retry-after") ?? null,
      rateLimitReset: response?.headers?.get?.("x-ratelimit-reset") ?? null,
    });
  }
  // GitHub's documented failure shape on this endpoint is HTTP 200 + `error`.
  if (parsed?.error) {
    throw new GitHubCollabError(`oauth_${String(parsed.error).replace(/[^a-z0-9_]/gi, "_")}`, {
      status: 400,
      detail: parsed.error_description || parsed.error,
    });
  }
  const token = parsed?.access_token;
  if (!token || typeof token !== "string") {
    throw new GitHubCollabError("oauth_token_missing", { status: 502, detail: "token endpoint returned no access_token" });
  }
  return {
    access_token: token,
    token_type: parsed.token_type || "bearer",
    scope: parsed.scope || "",
  };
}

export async function getAuthenticatedUser({ token, fetchImpl } = {}) {
  if (!String(token ?? "").trim()) throw new GitHubCollabError("token_required", { status: 401 });
  const { body } = await githubFetch(`${GITHUB_API}/user`, { token, fetchImpl });
  if (!body?.login) throw new GitHubCollabError("github_user_invalid", { status: 502, detail: "no login in /user response" });
  return { login: String(body.login), id: Number(body.id) || 0, avatar_url: body.avatar_url || null };
}

// ---------------------------------------------------------------------------
// fork / branch / file / pull request
// ---------------------------------------------------------------------------

export function parseRepoSpec(spec) {
  const value = String(spec ?? "").trim();
  if (!REPO_SPEC.test(value)) {
    throw new GitHubCollabError("repo_spec_invalid", { status: 500, detail: `expected owner/repo, got ${value.slice(0, 80) || "empty"}` });
  }
  const [owner, repo] = value.split("/");
  return { owner, repo, full_name: `${owner}/${repo}` };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/// `ensureFork` has exactly three outcomes, and only two of them are forks:
///
///   * a fork exists (created just now, or already there);
///   * GitHub created none, and the response describes the *source* repository —
///     `POST /repos/{owner}/{repo}/forks` answers 202 with the source itself when
///     the token already has write access to it. The caller was about to branch
///     and commit somewhere other than where its own prose says;
///   * the request produced nothing usable.
///
/// This module used to collapse the first two into "fork". It no longer does.
///
/// The refusal raised for the second outcome.
///
/// An independent code (not a reused `github_conflict`): the caller's token is
/// valid, the repository exists and the request was well formed, so no GitHub
/// status describes this. `409` is chosen over `502` deliberately — a 502 says
/// "the upstream is broken, retry", and a retry would reproduce the same
/// no-fork answer; a 409 says "this request conflicts with the state of the
/// account", which is exactly what a write-capable token is here.
export const FORK_NOT_CREATED_UPSTREAM_ACCESSIBLE = "fork_not_created_upstream_accessible";

/// Whether a fork response describes the source repository rather than a fork.
///
/// Two independent signals, either of which is decisive: the explicit `fork`
/// flag, or a `full_name` equal to the source `owner/repo`. The flag alone would
/// miss a body that omits it; the name alone would miss an owner case
/// difference. An absent flag is not a lie in either direction: such a body is
/// classified by name, and anything else is `unknown` (no verdict, so the caller
/// falls back to its own readiness check rather than guessing).
export function classifyForkResponse(body, source) {
  if (!body || typeof body !== "object") return "unknown";
  if (body.fork === false) return "upstream";
  const fullName = String(body.full_name || "").trim().toLowerCase();
  if (fullName && fullName === String(source.full_name).toLowerCase()) return "upstream";
  if (body.fork === true) return "fork";
  return "unknown";
}

/// Fork `owner/repo` for the authenticated user, or return the existing fork.
///
/// GitHub answers 202 when it is creating the fork and 200 when the fork already
/// exists; both are success. A 202 response carries a repository object whose
/// `default_branch` is still null, so readiness is confirmed with a bounded poll
/// (at most `maxPolls` reads). Exhausting the budget is an error.
///
/// The third, previously silent case is that GitHub creates *nothing*: a token
/// that can already write to the source repository receives a 202 whose body is
/// the source repository (`fork: false`). Returning that as a "fork" sends the
/// caller on to create a branch and commit in a repository it does not own. It
/// is refused by default with `fork_not_created_upstream_accessible`; a caller
/// that really means "commit straight to the upstream" must say so with
/// `allowUpstream: true`, and then gets back a result tagged `upstream_direct:
/// true` so nothing downstream can mistake it for a fork.
export async function ensureFork({
  token,
  owner,
  repo,
  organization = null,
  fetchImpl,
  maxPolls = DEFAULT_FORK_MAX_POLLS,
  pollDelayMs = DEFAULT_FORK_POLL_DELAY_MS,
  sleep = defaultSleep,
  allowUpstream = false,
} = {}) {
  if (!String(token ?? "").trim()) throw new GitHubCollabError("token_required", { status: 401 });
  const source = parseRepoSpec(`${owner ?? ""}/${repo ?? ""}`);
  const limit = Math.max(1, Number.parseInt(maxPolls, 10) || DEFAULT_FORK_MAX_POLLS);
  const body = organization ? { organization: String(organization) } : undefined;

  const created = await githubFetch(`${GITHUB_API}/repos/${source.owner}/${source.repo}/forks`, {
    token, method: "POST", body, fetchImpl,
  });

  const fullName = created.body?.full_name
    || (created.body?.owner?.login ? `${created.body.owner.login}/${source.repo}` : null);
  if (!fullName) {
    throw new GitHubCollabError("fork_response_invalid", { status: 502, detail: "fork response carried no full_name" });
  }

  const describe = (repository, extra = {}) => ({
    full_name: repository.full_name || fullName,
    default_branch: repository.default_branch || null,
    owner: repository.owner?.login || repository.full_name?.split("/")[0] || null,
    ...extra,
  });

  // Responses A (200 + fork) and C (202 + the source repository) are told apart
  // here, before the already-exists shortcut can mislabel C as a ready fork.
  const sourceLike = classifyForkResponse(created.body, source) === "upstream";
  if (sourceLike) {
    if (!allowUpstream) {
      throw new GitHubCollabError(FORK_NOT_CREATED_UPSTREAM_ACCESSIBLE, {
        status: 409,
        detail: `GitHub created no fork of ${source.full_name}: the response describes the source repository `
          + `(fork=${JSON.stringify(created.body?.fork)}, full_name=${created.body?.full_name || "?"}), which happens when the token `
          + `already has write access to it. Use a token from another account, or set allowUpstream to branch and commit in `
          + `${source.full_name} directly.`,
      });
    }
    return describe(created.body, { upstream_direct: true });
  }

  // The already-exists path is a single request: the 200 response is a complete
  // repository object, so there is nothing to wait for.
  if (created.body?.default_branch) return describe(created.body);

  for (let attempt = 0; attempt < limit; attempt += 1) {
    if (attempt > 0) await sleep(pollDelayMs);
    try {
      const read = await githubFetch(`${GITHUB_API}/repos/${fullName}`, { token, fetchImpl });
      if (read.body?.full_name && read.body?.default_branch) return describe(read.body);
    } catch (err) {
      // A 404 while the fork is being created is expected, not fatal.
      if (!(err instanceof GitHubCollabError) || err.status !== 404) throw err;
    }
  }
  throw new GitHubCollabError("fork_not_ready", {
    status: 504,
    detail: `fork ${fullName} was not readable after ${limit} polls`,
  });
}

/// `portal/<kind>/<shortid>`, the only branch shape this module will create.
export function branchName(kind, shortId) {
  const cleanKind = String(kind ?? "").trim().toLowerCase();
  if (!BRANCH_KINDS.includes(cleanKind)) {
    throw new GitHubCollabError("branch_kind_invalid", { status: 500, detail: `kind must be one of ${BRANCH_KINDS.join(", ")}` });
  }
  const cleanId = String(shortId ?? "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!SHORT_ID.test(cleanId)) {
    throw new GitHubCollabError("branch_short_id_invalid", { status: 500, detail: `shortid must match ${SHORT_ID}` });
  }
  return `portal/${cleanKind}/${cleanId}`;
}

export function newShortId() {
  if (!globalThis.crypto?.randomUUID) {
    throw new GitHubCollabError("crypto_unavailable", { detail: "crypto.randomUUID is required" });
  }
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export async function getBranchHead({ token, owner, repo, branch, fetchImpl } = {}) {
  const target = parseRepoSpec(`${owner}/${repo}`);
  const name = String(branch ?? "").trim();
  if (!name) throw new GitHubCollabError("branch_required", { status: 400 });
  const { body } = await githubFetch(
    `${GITHUB_API}/repos/${target.full_name}/branches/${encodeURIComponent(name)}`,
    { token, fetchImpl, notFoundCode: "branch_not_found" },
  );
  const sha = body?.commit?.sha;
  if (!sha) throw new GitHubCollabError("branch_response_invalid", { status: 502, detail: "branch response carried no commit sha" });
  return { sha: String(sha) };
}

/// Create `branch` at `fromSha` in `owner/repo`.
///
/// An existing branch is a refusal (`branch_exists`), never a silent reuse: the
/// caller asked for a *new* proposal branch, and reusing one would push commits
/// onto a branch a maintainer may already be reviewing.
export async function createBranch({ token, owner, repo, branch, fromSha, fetchImpl } = {}) {
  const target = parseRepoSpec(`${owner}/${repo}`);
  const name = String(branch ?? "").trim();
  if (!name) throw new GitHubCollabError("branch_required", { status: 400 });
  const sha = String(fromSha ?? "").trim();
  if (!FULL_SHA.test(sha)) throw new GitHubCollabError("from_sha_invalid", { status: 400, detail: "fromSha must be a 40-hex commit sha" });

  const { body } = await githubFetch(`${GITHUB_API}/repos/${target.full_name}/git/refs`, {
    token,
    method: "POST",
    fetchImpl,
    body: { ref: `refs/heads/${name}`, sha },
    validateStatus: (status) => status === 422,
  });

  if (body?.ref) return { ref: String(body.ref), sha: String(body.object?.sha || sha) };

  // 422 with "Reference already exists" is the branch-exists signal; anything
  // else 422 (a bad sha, a malformed ref) is a different failure.
  if (/already exists/i.test(String(body?.message || ""))) {
    throw new GitHubCollabError("branch_exists", { status: 409, detail: name });
  }
  throw new GitHubCollabError("branch_create_failed", {
    status: 422,
    detail: body?.message || `could not create ${name}`,
  });
}

/// Write `content` (a string) to `path` on `branch`.
///
/// GitHub's contents API is create-or-update: updating an existing file requires
/// the current blob `sha`, so when the caller does not supply one it is looked up
/// (one extra read). `lookupExisting: false` skips that read for a known-new
/// path.
export async function putFile({
  token,
  owner,
  repo,
  branch,
  path,
  content,
  message,
  fetchImpl,
  sha,
  lookupExisting = true,
} = {}) {
  if (!String(token ?? "").trim()) throw new GitHubCollabError("token_required", { status: 401 });
  const target = parseRepoSpec(`${owner}/${repo}`);
  const name = String(branch ?? "").trim();
  const filePath = String(path ?? "").trim().replace(/^\/+/, "");
  if (!name) throw new GitHubCollabError("branch_required", { status: 400 });
  if (!filePath) throw new GitHubCollabError("path_required", { status: 400 });
  const isBytes = content instanceof Uint8Array || ArrayBuffer.isView(content) || content instanceof ArrayBuffer;
  if (typeof content !== "string" && !isBytes) throw new GitHubCollabError("content_required", { status: 400 });
  const commitMessage = String(message ?? "").trim() || `portal: update ${filePath}`;

  // The contents API takes base64 of the *bytes*. A string is converted through
  // UTF-8 (that is what a Japanese locale file is); bytes are passed through
  // untouched, because re-encoding them as a string would corrupt every value
  // above 0x7F — a PNG's `89` becomes the two bytes `C2 89`, so the committed
  // blob would no longer be the image that was validated.
  const encoded = bytesToBase64(isBytes ? content : new TextEncoder().encode(content));

  let existingSha = sha === undefined ? undefined : (sha || undefined);
  if (existingSha === undefined && lookupExisting) {
    const read = await githubFetch(
      `${GITHUB_API}/repos/${target.full_name}/contents/${filePath}?ref=${encodeURIComponent(name)}`,
      { token, fetchImpl, validateStatus: (status) => status === 404 },
    );
    if (read.status !== 404 && read.body?.sha) existingSha = String(read.body.sha);
  }

  const body = { message: commitMessage, content: encoded, branch: name };
  if (existingSha) body.sha = existingSha;

  const { body: written } = await githubFetch(`${GITHUB_API}/repos/${target.full_name}/contents/${filePath}`, {
    token, method: "PUT", body, fetchImpl,
  });

  return {
    commit_sha: written?.commit?.sha || null,
    html_url: written?.content?.html_url || written?.commit?.html_url || null,
    content_sha: written?.content?.sha || null,
    created: !existingSha,
  };
}

/// Open a pull request. `head` is `owner:branch` for a cross-fork PR.
export async function createPullRequest({
  token, owner, repo, title, head, base, body, fetchImpl, draft = false,
} = {}) {
  const target = parseRepoSpec(`${owner}/${repo}`);
  const headRef = String(head ?? "").trim();
  const baseRef = String(base ?? "").trim();
  const prTitle = String(title ?? "").trim();
  if (!headRef) throw new GitHubCollabError("head_required", { status: 400 });
  if (!baseRef) throw new GitHubCollabError("base_required", { status: 400 });
  if (!prTitle) throw new GitHubCollabError("title_required", { status: 400 });
  // A PR from a branch to itself is not a proposal. GitHub would reject it with
  // a 422; refusing here keeps the error code stable and named. `head` is
  // `owner:branch` for a cross-fork PR, so the branch half is compared too.
  const headBranch = headRef.includes(":") ? headRef.slice(headRef.indexOf(":") + 1) : headRef;
  if (headRef === baseRef || headBranch === baseRef) {
    throw new GitHubCollabError("head_equals_base", { status: 400, detail: `${headRef} -> ${baseRef}` });
  }

  const result = await githubFetch(`${GITHUB_API}/repos/${target.full_name}/pulls`, {
    token,
    method: "POST",
    fetchImpl,
    body: { title: prTitle, head: headRef, base: baseRef, body: String(body ?? ""), draft: Boolean(draft) },
    validateStatus: (status) => status === 422,
  });

  if (result.status === 422) {
    const message = String(result.body?.message || "");
    if (/already exists/i.test(message)) {
      throw new GitHubCollabError("pr_already_exists", { status: 409, detail: message });
    }
    throw new GitHubCollabError("pr_create_failed", { status: 422, detail: message || "pull request rejected" });
  }
  const pr = result.body;
  if (!pr?.number) throw new GitHubCollabError("pr_response_invalid", { status: 502, detail: "pull request response carried no number" });
  return { number: Number(pr.number), html_url: pr.html_url || null, state: pr.state || null };
}

/// The read side of the review authority: a PR's own `state`/`merged`.
export async function getPullRequest({ token, owner, repo, number, fetchImpl } = {}) {
  const target = parseRepoSpec(`${owner}/${repo}`);
  const prNumber = Number.parseInt(number, 10);
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    throw new GitHubCollabError("pr_number_invalid", { status: 400 });
  }
  const { body } = await githubFetch(`${GITHUB_API}/repos/${target.full_name}/pulls/${prNumber}`, {
    token, fetchImpl, notFoundCode: "pr_not_found",
  });
  return {
    number: Number(body?.number) || prNumber,
    state: body?.state || null,
    merged: body?.merged === true,
    mergeable_state: body?.mergeable_state || null,
    head_sha: body?.head?.sha || null,
    html_url: body?.html_url || null,
  };
}
