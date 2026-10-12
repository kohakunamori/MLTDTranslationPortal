// Relay write service: filesystem/git operations with no HTTP server concerns.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, posix } from "node:path";

import { WriteError, applyJsonlEdit, applyManifestEdit } from "../public/lib/github-write.js";

const DEFAULT_BRANCH = "main";
const DEFAULT_AUTHOR_NAME = "MLTD portal relay";
const DEFAULT_AUTHOR_EMAIL = "mltd-portal@nyaneko.cn";
const DEFAULT_PATH_PREFIXES = ["locales/", "lyrics/", "manifests/"];

export function parseRepos(raw) {
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


// ---------------------------------------------------------------- 小工具

function log(...parts) {
  process.stdout.write(`[${new Date().toISOString()}] ${parts.join(" ")}\n`);
}

/// git 的报错可能带上远端地址；把任何疑似凭据的内容抹掉再往外传。
export function scrub(text) {
  return String(text || "")
    .replace(/https?:\/\/[^\s@/]+:[^\s@/]+@/g, "https://")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g, "<token>")
    .replace(/Authorization: Basic \S+/g, "Authorization: Basic <token>")
    .trim();
}

/// 和中继里的其它错误一样用 WriteError：调用方只需要认 code，不必区分错误来自
/// "改行"还是来自"守门"。
export function fail(code, message, extra = null) {
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

export function statusFor(code) {
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

export function runGit(cwd, args, token, extraEnv = null) {
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
export function normalizePath(raw, prefixes = DEFAULT_PATH_PREFIXES) {
  if (typeof raw !== "string" || raw.trim() === "") throw fail("invalid_edit", "path 不能为空");
  const value = raw.trim().replace(/^\/+/, "");
  if (value.includes("\\") || value.includes("..") || value.includes("\0")) {
    throw fail("path_not_allowed", "path 里不能有 .. 或反斜杠");
  }
  const clean = posix.normalize(value);
  if (!prefixes.some((prefix) => clean.startsWith(prefix))) {
    throw fail("path_not_allowed", `只允许写入 ${prefixes.join(" / ")}`);
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
export async function patchText(currentText, body) {
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
export async function resolveAuthor(token) {
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
export async function commitEdit({ repo, dir, token, body, branch = DEFAULT_BRANCH, authorName = DEFAULT_AUTHOR_NAME, authorEmail = DEFAULT_AUTHOR_EMAIL, pathPrefixes = DEFAULT_PATH_PREFIXES }) {
  const path = normalizePath(body.path, pathPrefixes);
  const full = join(dir, path);
  let lastPushError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    runGit(dir, ["fetch", "--quiet", "origin", branch], token);
    runGit(dir, ["reset", "--hard", "--quiet", `origin/${branch}`]);

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
    const author = body.author || { name: authorName, email: authorEmail };
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
      runGit(dir, ["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], token);
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

