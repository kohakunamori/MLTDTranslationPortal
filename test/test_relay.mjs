// Tests for the self-hosted write path:
//   * `public/lib/relay-write.js` — the browser's transport (relay first, direct GitHub as fallback)
//   * `scripts/relay.mjs`         — the relay itself (guards + the git flow)
//
// House style: plain Node ESM, node:assert/strict, no framework, no network. The relay's git
// flow runs against a throwaway bare repository in the OS temp dir, so "fetch -> patch ->
// commit -> push" is really exercised without ever touching GitHub.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WriteError } from "../public/lib/github-write.js";
import { commitEdit, resetRelayState } from "../public/lib/relay-write.js";
import { commitEdit as relayCommitEdit, normalizePath, patchText, scrub } from "../scripts/relay.mjs";

const failures = [];
let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL ${name}`);
    console.error(`     ${(error && error.stack) || error}`);
  }
}

/* ------------------------------------------------------------------ helpers */

function nodeHash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof WriteError, `expected a WriteError, got ${error}`);
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

/** 记录每次调用的 stub，方便断言"发了几个请求、发到哪、令牌有没有跑到地址里"。 */
function stubFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const record = { url: String(url), method: init.method || "GET", headers: init.headers || {}, body: init.body };
    calls.push(record);
    return handler(record, calls.length);
  };
  fn.calls = calls;
  return fn;
}

function base64Wrapped(text) {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  return (encoded.match(/.{1,60}/g) || []).join("\n");
}

function git(cwd, args) {
  return gitRaw(cwd, args).trim();
}

/** 读文件内容时不能 trim：末尾的换行是 JSONL 的一部分，比行数会因此对不上。 */
function gitRaw(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${result.stderr || result.stdout}`);
  return String(result.stdout || "");
}

/* --------------------------------------------------------------- fixtures */

const JA = ["最新トキメキで", "昨日より高く"];
const PATH_IN_REPO = "locales/master/sample.jsonl";

function row(ja, zh, status, itemKey) {
  return {
    asset_version: "1077100",
    bundle: "scrobj_smile1.unity3d",
    item_key: itemKey,
    ja,
    zh,
    source_sha256: nodeHash(ja),
    status,
    updated_at: "2026-01-01T00:00:00Z",
  };
}

const ROW_1 = row(JA[0], "带着崭新的心动", "accepted", "1");
const ROW_2 = row(JA[1], null, "untranslated", "2");
const JSONL_TEXT = `${[ROW_1, ROW_2].map((item) => JSON.stringify(item)).join("\n")}\n`;

const MANIFEST_TEXT = `${JSON.stringify({
  client_version: "9.0.200",
  slots: [
    { index: 0, ja: "ホーム", zh: "主页", provenance: "ci" },
    { index: 1, ja: "ライブ", zh: "演唱会", provenance: "ci" },
  ],
})}\n`;

/** 一个一次性的"上游"：裸仓库 + 工作副本，都在系统临时目录里。 */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "mltd-relay-"));
  const bare = join(root, "origin.git");
  const seed = join(root, "seed");
  const work = join(root, "work");

  git(root, ["init", "--bare", "-b", "main", bare]);
  git(root, ["init", "-b", "main", seed]);
  mkdirSync(join(seed, "locales/master"), { recursive: true });
  mkdirSync(join(seed, "manifests"), { recursive: true });
  writeFileSync(join(seed, PATH_IN_REPO), JSONL_TEXT, "utf8");
  writeFileSync(join(seed, "manifests/bottom-bar.manifest.json"), MANIFEST_TEXT, "utf8");
  git(seed, ["add", "-A"]);
  git(seed, ["-c", "user.name=seed", "-c", "user.email=seed@example.com", "commit", "-q", "-m", "seed"]);
  git(seed, ["remote", "add", "origin", bare]);
  git(seed, ["push", "-q", "origin", "main"]);
  git(root, ["clone", "-q", bare, work]);

  return {
    root,
    bare,
    work,
    remoteFile: () => gitRaw(bare, ["show", `main:${PATH_IN_REPO}`]),
    remoteManifest: () => gitRaw(bare, ["show", "main:manifests/bottom-bar.manifest.json"]),
    commitCount: () => Number(git(bare, ["rev-list", "--count", "main"])),
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 3 }),
  };
}

function editBody(overrides = {}) {
  return {
    repo: "kohakunamori/Fixture",
    ref: "main",
    kind: "jsonl",
    path: PATH_IN_REPO,
    identity_field: "item_key",
    item_key: "2",
    source_sha256: nodeHash(JA[1]),
    translation: "比昨天更高",
    status: "accepted",
    message: "portal: 测试",
    ...overrides,
  };
}

/* ------------------------------------------------- 客户端传输（relay-write） */

await test("relay-write: 有中继时走中继，请求体只带意图，令牌不进地址", async () => {
  resetRelayState();
  const fetchImpl = stubFetch(() => jsonResponse(200, {
    changed: true,
    path: PATH_IN_REPO,
    lineNumber: 2,
    previous: null,
    previousStatus: "untranslated",
    commit: { sha: "a".repeat(40), html_url: "https://github.com/x/y/commit/aaa" },
  }));

  const result = await commitEdit({
    token: "ghp_secret_value",
    edit: { kind: "jsonl", repo: "kohakunamori/Fixture", ref: "main", path: PATH_IN_REPO },
    line: { item_key: "2", source_sha256: nodeHash(JA[1]) },
    translation: "比昨天更高",
    status: "accepted",
    message: "portal: 测试",
    fetchImpl,
  });

  assert.equal(result.changed, true);
  assert.equal(result.commit.sha, "a".repeat(40));
  assert.equal(result.lineNumber, 2);
  assert.equal(fetchImpl.calls.length, 1, "有中继就不该再发第二个请求");
  const call = fetchImpl.calls[0];
  assert.equal(call.url, "/api/edit");
  assert.equal(call.method, "POST");
  assert.equal(call.headers.Authorization, "Bearer ghp_secret_value");
  assert.ok(!call.url.includes("ghp_"), "令牌绝不能出现在地址里");
  const sent = JSON.parse(call.body);
  assert.equal(sent.repo, "kohakunamori/Fixture");
  assert.equal(sent.path, PATH_IN_REPO);
  assert.equal(sent.item_key, "2");
  assert.equal(sent.translation, "比昨天更高");
  assert.equal(sent.source_sha256, nodeHash(JA[1]));
});

await test("relay-write: 中继明确拒绝时把错误码原样抛出，不偷偷退回直连", async () => {
  resetRelayState();
  const fetchImpl = stubFetch(() => jsonResponse(409, { error: "source_changed", message: "日文原文变了" }));
  await rejectsWith(
    commitEdit({
      token: "ghp_secret_value",
      edit: { kind: "jsonl", repo: "kohakunamori/Fixture", ref: "main", path: PATH_IN_REPO },
      line: { item_key: "2", source_sha256: nodeHash(JA[1]) },
      translation: "x",
      fetchImpl,
    }),
    "source_changed",
  );
  assert.equal(fetchImpl.calls.length, 1, "被拒绝就不该改走直连");
});

await test("relay-write: 旧站点上没有中继（no_route）时退回直连 GitHub", async () => {
  resetRelayState();
  const fetchImpl = stubFetch((call) => {
    if (call.url === "/api/edit") return jsonResponse(404, { error: "no_route", message: "只有 POST /api/edit" });
    if (call.method === "PUT") return jsonResponse(200, { commit: { sha: "f".repeat(40), html_url: "https://github.com/c" } });
    return jsonResponse(200, { sha: "b".repeat(40), encoding: "base64", content: base64Wrapped(JSONL_TEXT) });
  });

  const result = await commitEdit({
    token: "ghp_secret_value",
    edit: { kind: "jsonl", repo: "kohakunamori/Fixture", ref: "main", path: PATH_IN_REPO },
    line: { item_key: "1", source_sha256: nodeHash(JA[0]) },
    translation: "改过的译文",
    status: "accepted",
    fetchImpl,
  });

  assert.equal(result.commit.sha, "f".repeat(40));
  assert.equal(fetchImpl.calls[0].url, "/api/edit");
  assert.ok(fetchImpl.calls.some((call) => call.url.startsWith("https://api.github.com/repos/")), "应该退回直连");
  const put = fetchImpl.calls.find((call) => call.method === "PUT");
  assert.ok(put, "直连路径要发 PUT");
  assert.ok(!put.url.includes("ghp_"), "令牌不能进地址");
});

await test("relay-write: 网络不通时也退回直连，并且不再反复试探", async () => {
  resetRelayState();
  const fetchImpl = stubFetch((call) => {
    if (call.url === "/api/edit") throw new TypeError("fetch failed");
    if (call.method === "PUT") return jsonResponse(200, { commit: { sha: "f".repeat(40), html_url: "https://github.com/c" } });
    return jsonResponse(200, { sha: "b".repeat(40), encoding: "base64", content: base64Wrapped(JSONL_TEXT) });
  });

  const options = {
    token: "ghp_secret_value",
    edit: { kind: "jsonl", repo: "kohakunamori/Fixture", ref: "main", path: PATH_IN_REPO },
    line: { item_key: "1", source_sha256: nodeHash(JA[0]) },
    translation: "改过的译文",
    status: "accepted",
    fetchImpl,
  };
  await commitEdit({ ...options, translation: "第一遍" });
  await commitEdit({ ...options, translation: "第二遍" });

  const relayCalls = fetchImpl.calls.filter((call) => call.url === "/api/edit").length;
  assert.equal(relayCalls, 1, "记住这里没有中继之后不该再试第二次");
});

await test("relay-write: 没有令牌时直接拒绝，一个请求都不发", async () => {
  resetRelayState();
  const fetchImpl = stubFetch(() => jsonResponse(200, {}));
  await rejectsWith(commitEdit({ token: "  ", edit: {}, line: {}, fetchImpl }), "no_token");
  assert.equal(fetchImpl.calls.length, 0);
});

/* ------------------------------------------------------------- 中继：守门 */

await test("relay: 只允许写进约定的目录，路径不能跑出仓库", () => {
  assert.equal(normalizePath("locales/master/MD_jp.gtx.jsonl"), "locales/master/MD_jp.gtx.jsonl");
  assert.equal(normalizePath("lyrics/songs/scrobj_smile1.unity3d.jsonl"), "lyrics/songs/scrobj_smile1.unity3d.jsonl");
  assert.equal(normalizePath("manifests/bottom-bar.manifest.json"), "manifests/bottom-bar.manifest.json");
  for (const bad of ["other/x.jsonl", "locales/../../etc/passwd", "/etc/passwd", "locales\\x.jsonl", ""]) {
    assert.throws(() => normalizePath(bad), (error) => error instanceof WriteError, `${bad} 应该被拒`);
  }
});

await test("relay: 报错信息里的令牌被抹掉", () => {
  const dirty = [
    "fatal: could not read from https://x-access-token:ghp_abcdefghijklmnop@github.com/a/b.git",
    "rejected: github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
    "Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2hwX3h4eA==",
  ].join("\n");
  const clean = scrub(dirty);
  assert.ok(!clean.includes("ghp_abcdefghijklmnop"), "经典令牌要抹掉");
  assert.ok(!clean.includes("github_pat_11ABCDEFG"), "细粒度令牌要抹掉");
  assert.ok(!clean.includes("eC1hY2Nlc3MtdG9rZW46"), "Basic 头要抹掉");
});

/* ------------------------------------------------------------- 中继：改行 */

await test("relay: jsonl 只动目标行的目标字段，其余字节不变", async () => {
  const applied = await patchText(JSONL_TEXT, editBody());
  const before = JSONL_TEXT.split("\n");
  const after = applied.text.split("\n");
  assert.equal(after.length, before.length, "行数不能变");
  assert.equal(after[0], before[0], "第一行必须逐字节不变");
  const changed = JSON.parse(after[1]);
  assert.equal(changed.zh, "比昨天更高");
  assert.equal(changed.status, "accepted");
  assert.equal(changed.ja, JA[1], "日文原文不动");
  assert.equal(applied.lineNumber, 2);
  assert.equal(applied.previous, null);
  assert.equal(applied.previousStatus, "untranslated");
});

await test("relay: 原文对不上时拒绝（source_changed）", async () => {
  await rejectsWith(patchText(JSONL_TEXT, editBody({ source_sha256: nodeHash("别的原文") })), "source_changed");
});

await test("relay: 派生状态 not_needed 不许写回上游", async () => {
  await rejectsWith(patchText(JSONL_TEXT, editBody({ status: "not_needed" })), "invalid_edit");
});

await test("relay: manifest 编辑改的是指定槽位", async () => {
  const applied = await patchText(MANIFEST_TEXT, {
    kind: "manifest",
    manifest_index: 1,
    source_sha256: nodeHash("ライブ"),
    translation: "演唱会（改）",
    status: null,
  });
  const parsed = JSON.parse(applied.text);
  assert.equal(parsed.slots[1].zh, "演唱会（改）");
  assert.equal(parsed.slots[0].zh, "主页", "别的槽位不动");
  assert.equal(applied.previous, "演唱会");
});

/* --------------------------------------------------- 中继：真跑一遍 git 流程 */

await test("relay: 完整流程 —— 改一行、提交、推送，远端确实变了", async () => {
  const fixture = makeFixture();
  try {
    const before = fixture.commitCount();
    const result = await relayCommitEdit({ repo: "kohakunamori/Fixture", dir: fixture.work, token: "", body: editBody() });

    assert.equal(result.changed, true);
    assert.equal(result.lineNumber, 2);
    assert.ok(/^[0-9a-f]{40}$/.test(result.commit.sha), "要回报提交号");
    assert.ok(result.commit.html_url.endsWith(result.commit.sha));
    assert.equal(fixture.commitCount(), before + 1, "远端应该多一个提交");

    const remote = fixture.remoteFile();
    const lines = remote.split("\n");
    assert.equal(lines[0], JSONL_TEXT.split("\n")[0], "别的行逐字节不变");
    assert.equal(JSON.parse(lines[1]).zh, "比昨天更高");
    assert.equal(JSON.parse(lines[1]).ja, JA[1]);
    assert.equal(git(fixture.bare, ["log", "-1", "--format=%s"]), "portal: 测试");
  } finally {
    fixture.cleanup();
  }
});

await test("relay: 内容没变化时不产生空提交", async () => {
  const fixture = makeFixture();
  try {
    const before = fixture.commitCount();
    const result = await relayCommitEdit({
      repo: "kohakunamori/Fixture",
      dir: fixture.work,
      token: "",
      body: editBody({ item_key: "1", source_sha256: nodeHash(JA[0]), translation: "带着崭新的心动", status: "accepted" }),
    });
    assert.equal(result.changed, false);
    assert.equal(result.commit, null);
    assert.equal(fixture.commitCount(), before, "不该多出提交");
  } finally {
    fixture.cleanup();
  }
});

await test("relay: 原文对不上时既不提交也不推送", async () => {
  const fixture = makeFixture();
  try {
    const before = fixture.commitCount();
    await rejectsWith(
      relayCommitEdit({ repo: "kohakunamori/Fixture", dir: fixture.work, token: "", body: editBody({ source_sha256: nodeHash("过期的原文") }) }),
      "source_changed",
    );
    assert.equal(fixture.commitCount(), before, "远端不该动");
    // 工作副本也不能留下半改的痕迹，否则下一次编辑会从脏状态开始。
    assert.equal(git(fixture.work, ["status", "--short"]), "", "工作副本要保持干净");
  } finally {
    fixture.cleanup();
  }
});

await test("relay: 越界路径被拒，且不碰仓库", async () => {
  const fixture = makeFixture();
  try {
    const before = fixture.commitCount();
    await rejectsWith(
      relayCommitEdit({ repo: "kohakunamori/Fixture", dir: fixture.work, token: "", body: editBody({ path: "secrets/keys.jsonl" }) }),
      "path_not_allowed",
    );
    assert.equal(fixture.commitCount(), before);
  } finally {
    fixture.cleanup();
  }
});

await test("relay: 工作副本落后于远端时先同步再改（别人刚推过）", async () => {
  const fixture = makeFixture();
  try {
    // 模拟"别人"往远端推了一行新数据
    const other = join(fixture.root, "other");
    git(fixture.root, ["clone", "-q", fixture.bare, other]);
    const pushed = JSONL_TEXT + `${JSON.stringify(row("新加的原文", "新加的译文", "accepted", "3"))}\n`;
    writeFileSync(join(other, PATH_IN_REPO), pushed, "utf8");
    git(other, ["add", "-A"]);
    git(other, ["-c", "user.name=other", "-c", "user.email=other@example.com", "commit", "-q", "-m", "别处的改动"]);
    git(other, ["push", "-q", "origin", "main"]);

    const result = await relayCommitEdit({ repo: "kohakunamori/Fixture", dir: fixture.work, token: "", body: editBody() });
    assert.equal(result.changed, true);

    const remote = fixture.remoteFile();
    assert.equal(remote.split("\n").length, pushed.split("\n").length, "不能把别人的改动覆盖掉");
    assert.equal(JSON.parse(remote.split("\n")[2]).zh, "新加的译文", "别人加的那一行还在");
    assert.equal(JSON.parse(remote.split("\n")[1]).zh, "比昨天更高");
  } finally {
    fixture.cleanup();
  }
});

await test("relay: manifest 也能走完整流程", async () => {
  const fixture = makeFixture();
  try {
    const result = await relayCommitEdit({
      repo: "kohakunamori/Fixture",
      dir: fixture.work,
      token: "",
      body: {
        kind: "manifest",
        path: "manifests/bottom-bar.manifest.json",
        manifest_index: 0,
        source_sha256: nodeHash("ホーム"),
        translation: "首页",
        status: null,
      },
    });
    assert.equal(result.changed, true);
    assert.equal(JSON.parse(fixture.remoteManifest()).slots[0].zh, "首页");
  } finally {
    fixture.cleanup();
  }
});

/* ------------------------------------------------------------------ 汇总 */

console.log("");
if (failures.length === 0) {
  console.log(`relay module ${passed} tests PASS`);
  process.exit(0);
}
console.error(`${failures.length} of ${passed + failures.length} tests FAILED`);
process.exit(1);
