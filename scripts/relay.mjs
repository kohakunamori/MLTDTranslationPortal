#!/usr/bin/env node
// MLTD 翻译查阅站 · 单行写入中继
//
// 为什么要它：GitHub 的文件接口对超过 1MB 的文件不给内容，而 5 个大文件装着一半的行，
// 那些行在纯浏览器的方案里只能看不能改。git 推送走的是压缩传输，不受这个限制，所以把
// "改一行"这一步交给服务器上的 git 来做：浏览器只发几 KB 的意图，服务器拉最新版本、
// 精确替换那一行、再推回去。
//
// 服务器不保存任何密钥：Token 由浏览器每次随请求带来（Authorization: Bearer），只用于
// 这一次的拉取与推送，不落盘、不进日志。所以这个服务是无状态的，重启不丢任何东西。
//
// 环境变量：
//   RELAY_PORT            监听端口，默认 21330（只监听本机，由 nginx 转发）
//   RELAY_HOST            监听地址，默认 127.0.0.1
//   RELAY_BRANCH          写入的分支，默认 main
//   RELAY_REPOS           仓库 → 本地检出目录，JSON，例如 {"owner/repo":"/srv/..."}
//   RELAY_PATH_PREFIXES   允许写入的路径前缀，默认 "locales/,lyrics/,manifests/"
//   RELAY_AUTHOR_NAME     提交署名（拿不到 Token 主人时用），默认 "MLTD portal relay"
//   RELAY_AUTHOR_EMAIL    提交邮箱（同上），默认 "mltd-portal@nyaneko.cn"
//   RELAY_MAX_BODY        请求体上限（字节），默认 1MiB

import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";

import { WriteError, applyJsonlEdit, applyManifestEdit } from "../public/lib/github-write.js";

// ---------------------------------------------------------------- 配置

const PORT = Number(process.env.RELAY_PORT || 21330);
const HOST = process.env.RELAY_HOST || "127.0.0.1";
const BRANCH = process.env.RELAY_BRANCH || "main";
const AUTHOR_NAME = process.env.RELAY_AUTHOR_NAME || "MLTD portal relay";
const AUTHOR_EMAIL = process.env.RELAY_AUTHOR_EMAIL || "mltd-portal@nyaneko.cn";
const MAX_BODY = Number(process.env.RELAY_MAX_BODY || 1024 * 1024);
const PATH_PREFIXES = String(process.env.RELAY_PATH_PREFIXES || "locales/,lyrics/,manifests/")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

function parseRepos(raw) {
  if (!raw) return new Map();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`RELAY_REPOS 不是合法 JSON：${error.message}`);
  }
  const repos = new Map();
  for (const [slug, dir] of Object.entries(data)) {
    if (typeof dir !== "string" || dir.trim() === "") throw new Error(`RELAY_REPOS 里 ${slug} 的目录为空`);
    repos.set(slug, dir.trim());
  }
  return repos;
}

const REPOS = parseRepos(process.env.RELAY_REPOS);

// ---------------------------------------------------------------- 小工具

function log(...parts) {
  process.stdout.write(`[${new Date().toISOString()}] ${parts.join(" ")}\n`);
}

/// git 的报错可能带上远端地址；把任何疑似凭据的内容抹掉再往外传。
function scrub(text) {
  return String(text || "")
    .replace(/https?:\/\/[^\s@/]+:[^\s@/]+@/g, "https://")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g, "<token>")
    .replace(/Authorization: Basic \S+/g, "Authorization: Basic <token>")
    .trim();
}

/// 和中继里的其它错误一样用 WriteError：调用方只需要认 code，不必区分错误来自
/// "改行"还是来自"守门"。
function fail(code, message, extra = null) {
  return new WriteError(code, message, extra);
}

const HTTP_STATUS = {
  no_token: 401,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_edit: 400,
  invalid_json: 400,
  field_missing: 400,
  ambiguous: 409,
  source_changed: 409,
  conflict: 409,
  repo_unknown: 404,
  path_not_allowed: 403,
  not_modified: 200,
  git_failed: 502,
  unexpected: 500,
};

function statusFor(code) {
  return HTTP_STATUS[code] || 500;
}

// ---------------------------------------------------------------- git

/// Token 通过 http.extraheader 传给 git，而不是拼进远端地址：地址会出现在报错里、
/// 也会留在 .git/config 里，头部不会。
function gitEnv(token) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    LC_ALL: "C",
  };
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraheader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
  }
  return env;
}

/// git 在"凭据不对"和"真出别的错"之间不给区分度，这里替它分一下类：
/// 前者要告诉用户是 Token 的问题（界面上对应"权限不足"），后者才是服务器侧的故障。
export function classifyGitError(stderr) {
  return /could not read Username|Authentication failed|terminal prompts disabled|returned error: 40[13]/i.test(String(stderr || ""))
    ? "forbidden"
    : "git_failed";
}

function runGit(cwd, args, token, extraEnv = null) {
  const result = spawnSync("git", args, {
    cwd,
    env: { ...gitEnv(token), ...(extraEnv || {}) },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw fail("git_failed", `git 无法执行：${result.error.message}`);
  if (result.status !== 0) {
    const raw = String(result.stderr || result.stdout || "");
    const code = classifyGitError(raw);
    const text = scrub(raw);
    // 按公开仓库的规则：不带凭据读是能成功的，所以走到"读不到用户名"就说明 GitHub
    // 收到了一个它不认的 Authorization 头 —— 也就是 Token 对这个仓库无效。
    throw fail(code, code === "forbidden"
      ? `Token 用不了这个仓库（git ${args[0]}）：${text}`
      : `git ${args[0]} 失败：${text}`);
  }
  return String(result.stdout || "").trim();
}

// ---------------------------------------------------------------- 单行写入

/// 只允许写进约定的目录，且路径不能跑出仓库。
function normalizePath(raw) {
  if (typeof raw !== "string" || raw.trim() === "") throw fail("invalid_edit", "path 不能为空");
  const value = raw.trim().replace(/^\/+/, "");
  if (value.includes("\\") || value.includes("..") || value.includes("\0")) {
    throw fail("path_not_allowed", "path 里不能有 .. 或反斜杠");
  }
  const clean = posix.normalize(value);
  if (!PATH_PREFIXES.some((prefix) => clean.startsWith(prefix))) {
    throw fail("path_not_allowed", `只允许写入 ${PATH_PREFIXES.join(" / ")}`);
  }
  return clean;
}

function requireSha(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
    throw fail("invalid_edit", "source_sha256 必须是 64 位十六进制");
  }
  return value.toLowerCase();
}

/// 把"改成什么"应用到文件内容上。复用网页端那套精确替换：只动目标行的目标字段，
/// 其余字节原样保留。返回改完的文本与用于回报的信息。
async function patchText(currentText, body) {
  const itemKey = body.item_key;
  const identityField = typeof body.identity_field === "string" && body.identity_field !== ""
    ? body.identity_field
    : undefined;
  const translation = body.translation === null || body.translation === undefined ? "" : body.translation;
  if (typeof translation !== "string") throw fail("invalid_edit", "translation 必须是字符串或 null");

  let statusValue = null;
  if (body.status !== undefined && body.status !== null) {
    if (typeof body.status !== "string" || body.status.trim() === "") {
      throw fail("invalid_edit", "status 必须是非空字符串");
    }
    statusValue = body.status.trim();
    // `not_needed` 是本站自己派生的状态，上游 schema 里没有；和网页端一样直接拒绝。
    if (statusValue === "not_needed") {
      throw fail("invalid_edit", "not_needed 是本站派生状态，写回上游请用 accepted 或 pending");
    }
  }

  if (body.kind === "jsonl") {
    if (itemKey === undefined || itemKey === null || itemKey === "") {
      throw fail("invalid_edit", "jsonl 编辑需要 item_key");
    }
    const first = await applyJsonlEdit(currentText, {
      item_key: itemKey,
      source_sha256: requireSha(body.source_sha256),
      identity_field: identityField,
      field: "translation",
      value: translation,
    });
    let text = first.text;
    let previousStatus = null;
    if (statusValue !== null) {
      const second = await applyJsonlEdit(text, {
        item_key: itemKey,
        source_sha256: requireSha(body.source_sha256),
        identity_field: identityField,
        field: "status",
        value: statusValue,
      });
      text = second.text;
      previousStatus = second.previous ?? null;
    }
    return { text, lineNumber: first.lineNumber, previous: first.previous, previousStatus };
  }

  if (body.kind === "manifest") {
    if (!Number.isInteger(body.manifest_index) || body.manifest_index < 0) {
      throw fail("invalid_edit", "manifest 编辑需要非负整数 manifest_index");
    }
    const applied = await applyManifestEdit(currentText, {
      manifest_index: body.manifest_index,
      source_sha256: requireSha(body.source_sha256),
      field: "translation",
      value: translation,
      status: statusValue,
    });
    return {
      text: applied.text,
      lineNumber: null,
      previous: applied.previous,
      previousStatus: applied.previousStatus,
    };
  }

  throw fail("invalid_edit", "kind 只能是 jsonl 或 manifest");
}

/// 问一下 Token 是谁的，用来给提交正确署名；问不到就用默认署名（不影响能否写入）。
async function resolveAuthor(token) {
  try {
    const response = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "mltd-portal-relay",
      },
    });
    if (response.status === 401) throw fail("unauthorized", "Token 无效");
    if (!response.ok) return null;
    const data = await response.json();
    if (typeof data?.login !== "string" || data.login === "") return null;
    const email = Number.isInteger(data.id)
      ? `${data.id}+${data.login}@users.noreply.github.com`
      : `${data.login}@users.noreply.github.com`;
    return { name: data.login, email };
  } catch (error) {
    if (error?.code === "unauthorized") throw error;
    return null;
  }
}

/// 一次写入：同步到远端最新 -> 改那一行 -> 提交 -> 推送。
/// 推送被拒（别人同时推了）就整体重来一次，重新基于最新版本改。
async function commitEdit({ repo, dir, token, body }) {
  const path = normalizePath(body.path);
  const full = join(dir, path);
  let lastPushError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    runGit(dir, ["fetch", "--quiet", "origin", BRANCH], token);
    runGit(dir, ["reset", "--hard", "--quiet", `origin/${BRANCH}`]);

    let currentText;
    try {
      currentText = readFileSync(full, "utf8");
    } catch (error) {
      throw fail("not_found", `读不到 ${path}：${error.message}`);
    }

    const applied = await patchText(currentText, body);
    if (applied.text === currentText) {
      return {
        changed: false,
        path,
        lineNumber: applied.lineNumber,
        previous: applied.previous,
        previousStatus: applied.previousStatus,
        commit: null,
      };
    }

    writeFileSync(full, applied.text, "utf8");
    const author = body.author || { name: AUTHOR_NAME, email: AUTHOR_EMAIL };
    const message = typeof body.message === "string" && body.message.trim() !== ""
      ? body.message.trim()
      : `portal: 修改 ${path}`;

    runGit(dir, ["add", "--", path]);
    const changedFiles = runGit(dir, ["diff", "--cached", "--name-only"]);
    if (changedFiles === "") {
      return {
        changed: false,
        path,
        lineNumber: applied.lineNumber,
        previous: applied.previous,
        previousStatus: applied.previousStatus,
        commit: null,
      };
    }
    // 提交署名走环境变量：容器里没有全局 git 身份，也避免往检出目录里写配置。
    runGit(dir, ["commit", "--quiet", "-m", message], token, {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
    });

    try {
      runGit(dir, ["push", "--quiet", "origin", `HEAD:refs/heads/${BRANCH}`], token);
    } catch (error) {
      lastPushError = error;
      log(`push 被拒（第 ${attempt} 次）：${error.message}`);
      continue;
    }

    const sha = runGit(dir, ["rev-parse", "HEAD"]);
    return {
      changed: true,
      path,
      lineNumber: applied.lineNumber,
      previous: applied.previous,
      previousStatus: applied.previousStatus,
      commit: { sha, html_url: `https://github.com/${repo}/commit/${sha}` },
    };
  }

  throw fail("conflict", `上游一直在变，连续两次没推上去：${lastPushError?.message || ""}`);
}

// ---------------------------------------------------------------- 请求处理

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(fail("invalid_edit", `请求体超过 ${MAX_BODY} 字节`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", (error) => reject(fail("invalid_edit", error.message)));
  });
}

function bearerToken(request) {
  const raw = request.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(Array.isArray(raw) ? raw[0] : raw);
  return match ? match[1].trim() : "";
}

function sendJson(response, status, payload) {
  const text = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(text);
}

/// 同一时刻只允许一次写入：git 的工作目录是共享的，并发会互相踩。
let queue = Promise.resolve();

function serialize(task) {
  const run = queue.then(task, task);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

async function handleEdit(request, response) {
  const token = bearerToken(request);
  if (token === "") throw fail("no_token", "缺少 Token（Authorization: Bearer）");

  let body;
  try {
    body = JSON.parse(await readBody(request));
  } catch (error) {
    if (error?.code) throw error;
    throw fail("invalid_json", `请求体不是合法 JSON：${error.message}`);
  }
  if (!body || typeof body !== "object") throw fail("invalid_json", "请求体必须是对象");

  const repo = typeof body.repo === "string" ? body.repo : "";
  const dir = activeRepos.get(repo);
  if (!dir) throw fail("repo_unknown", `不管理仓库 ${repo || "(空)"}`);
  // 越界路径在碰网络之前就挡掉：非法请求不必去 GitHub 绕一圈。
  normalizePath(body.path);

  const author = await resolveAuthor(token);
  const result = await serialize(() => commitEdit({ repo, dir, token, body: { ...body, author } }));
  if (result.changed) {
    log(`写入 ${repo} ${result.path} 第 ${result.lineNumber ?? "-"} 行 -> ${result.commit.sha.slice(0, 8)}`);
  } else {
    log(`无变化 ${repo} ${result.path}`);
  }
  return result;
}

async function handleHealth() {
  const repos = {};
  for (const [slug, dir] of activeRepos) {
    let head = "";
    let error = "";
    try {
      head = runGit(dir, ["rev-parse", "--short", "HEAD"]);
    } catch (caught) {
      error = caught.message;
    }
    repos[slug] = { dir, head, error };
  }
  return { ok: true, branch: BRANCH, path_prefixes: PATH_PREFIXES, repos };
}

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const route = `${request.method} ${url.pathname}`;

  if (route === "GET /api/health") {
    handleHealth()
      .then((payload) => sendJson(response, 200, payload))
      .catch((error) => sendJson(response, 500, { error: "unexpected", message: scrub(error.message) }));
    return;
  }

  if (route !== "POST /api/edit") {
    sendJson(response, 404, { error: "no_route", message: "只有 POST /api/edit 与 GET /api/health" });
    return;
  }

  handleEdit(request, response)
    .then((payload) => sendJson(response, 200, payload))
    .catch((error) => {
      if (!error?.code || error.code === "unexpected") log(`内部错误：${error?.stack || error}`);
      sendJson(response, statusFor(error?.code), {
        error: error?.code || "unexpected",
        message: scrub(error?.message || "未知错误"),
        ...(error?.detail?.path ? { path: error.detail.path } : {}),
      });
    });
});

/// 当前生效的仓库表：正常启动来自环境变量，测试里可以直接传，免得为了可测性去改环境。
let activeRepos = REPOS;

/// 被 `import` 时只导出函数，不监听端口（测试要用到 commitEdit / patchText）。
export function start({ port = PORT, host = HOST, repos = REPOS } = {}) {
  if (repos.size === 0) throw new Error("RELAY_REPOS 没有配置任何仓库，拒绝启动");
  activeRepos = repos;
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      log(`写入中继已启动 http://${host}:${port}（分支 ${BRANCH}）`);
      for (const [slug, dir] of activeRepos) log(`  仓库 ${slug} -> ${dir}`);
      resolve(server);
    });
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    start().catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    });
  } catch (error) {
    // 配置不对（例如没配仓库）时同步抛错：直接退出，别留一个半死不活的进程。
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
}

export { commitEdit, handleEdit, patchText, normalizePath, scrub, parseRepos, server };