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

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";


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

import { classifyGitError, commitEdit, fail, normalizePath, parseRepos, patchText, resolveAuthor, runGit, scrub, statusFor } from "./relay-core.mjs";

const REPOS = parseRepos(process.env.RELAY_REPOS);

function log(...parts) {
  process.stdout.write(`[${new Date().toISOString()}] ${parts.join(" ")}\n`);
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
  normalizePath(body.path, PATH_PREFIXES);

  const author = await resolveAuthor(token);
  const result = await serialize(() => commitEdit({ repo, dir, token, body: { ...body, author }, branch: BRANCH, authorName: AUTHOR_NAME, authorEmail: AUTHOR_EMAIL, pathPrefixes: PATH_PREFIXES }));
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

export { classifyGitError, commitEdit, handleEdit, patchText, normalizePath, scrub, parseRepos, server };