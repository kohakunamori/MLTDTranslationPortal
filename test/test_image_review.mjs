import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyImageReviews, commitImageReview, emptyImageReviews, loadImageReviews, validateImageReviews } from "../public/lib/image-review.js";
import { filterImageTasks } from "../public/lib/images.js";
import { buildImageIndex } from "../scripts/image_data.mjs";

const task = () => ({ task_id: "sample.unity3d:complete-123", original_sha256: "a".repeat(64), status: "original_only", has_localized: false });
const mark = (revision = "revision-1") => ({ source_sha256: "a".repeat(64), status: "not_needed", revision });
const options = () => ({ repo: "owner/assets", ref: "main", token: "secret-token", task: task(), decision: mark() });
function mock(initial = null) {
  let stored = initial;
  let version = 1;
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    assert(!url.includes("secret-token"));
    if (init.method === "PUT") {
      const body = JSON.parse(init.body);
      assert.equal(body.sha, stored ? String(version).padStart(40, "0") : undefined);
      assert.equal(body.branch, "main");
      stored = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
      version++;
      return Response.json({ commit: { sha: "b".repeat(40) } }, { status: 201 });
    }
    return stored ? Response.json({ type: "file", sha: String(version).padStart(40, "0"), encoding: "base64", content: Buffer.from(JSON.stringify(stored)).toString("base64") })
      : Response.json({ message: "not found" }, { status: 404 });
  };
  return { fetchImpl, calls, get document() { return stored; } };
}

test("保存与撤销真正写回仓库，保留其他图片和元信息", async () => {
  const unrelated = { ...emptyImageReviews(), note: "人工复核", decisions: { "other.unity3d:1": mark("other") } };
  const api = mock(unrelated);
  const saved = await commitImageReview({ ...options(), fetchImpl: api.fetchImpl });
  assert.equal(saved.previous, null);
  assert.equal(api.document.note, "人工复核");
  assert.deepEqual(api.document.decisions[task().task_id], mark());
  const undone = await commitImageReview({ ...options(), expected: saved.decision, decision: null, fetchImpl: api.fetchImpl });
  assert.deepEqual(undone.previous, mark());
  assert.deepEqual(api.document, unrelated);
  assert.equal(api.calls.filter(({ init }) => init.method === "PUT").length, 2);
  assert(api.calls.every(({ init }) => init.headers.Authorization === "Bearer secret-token"));
});

test("首次标记创建文件；带 Token 重新读取立即可见", async () => {
  const api = mock();
  await commitImageReview({ ...options(), fetchImpl: api.fetchImpl });
  const document = await loadImageReviews({ ...options(), fetchImpl: api.fetchImpl });
  assert.deepEqual(document.decisions[task().task_id], mark());
});

test("多人标记冲突与过期撤销都不会覆盖新决定", async () => {
  const api = mock({ schema_version: 1, decisions: { [task().task_id]: mark("newer-review") } });
  await assert.rejects(commitImageReview({ ...options(), fetchImpl: api.fetchImpl }), { code: "conflict" });
  await assert.rejects(commitImageReview({ ...options(), expected: mark(), decision: null, fetchImpl: api.fetchImpl }), { code: "conflict" });
  assert(!api.calls.some(({ init }) => init.method === "PUT"));
});

test("没有权限、网络失败、409 都不伪报成功", async () => {
  await assert.rejects(commitImageReview({ ...options(), token: "", fetchImpl: () => assert.fail("must not fetch") }), { code: "no_token" });
  for (const [status, code] of [[401, "unauthorized"], [403, "forbidden"], [409, "conflict"], [422, "conflict"], [500, "http_error"]]) {
    await assert.rejects(commitImageReview({ ...options(), fetchImpl: async () => new Response("", { status }) }), { code });
  }
  await assert.rejects(commitImageReview({ ...options(), fetchImpl: async () => { throw Error("secret-token"); } }), (error) => error.code === "network_error" && !error.message.includes("secret-token"));
  let requests = 0;
  await assert.rejects(commitImageReview({ ...options(), fetchImpl: async () => ++requests === 1 ? new Response("", { status: 404 }) : new Response("", { status: 409 }) }), { code: "conflict" });
});

test("大文件用不可变 blob 读取，不把空 content 当成空文档", async () => {
  const document = { schema_version: 1, decisions: { "other.unity3d:1": mark() } };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (init.method === "PUT") {
      assert(JSON.parse(Buffer.from(JSON.parse(init.body).content, "base64").toString()).decisions["other.unity3d:1"]);
      return Response.json({ commit: { sha: "b".repeat(40) } });
    }
    return url.includes("/git/blobs/") ? new Response(JSON.stringify(document))
      : Response.json({ type: "file", sha: "c".repeat(40), encoding: "none", content: "" });
  };
  await commitImageReview({ ...options(), fetchImpl });
  assert(calls[1].endsWith(`/git/blobs/${"c".repeat(40)}`));
});

test("公开读取不携带凭据，缺失文件代表尚无标记", async () => {
  const document = await loadImageReviews({ ...options(), token: "", fetchImpl: async (url, init) => {
    assert(url.startsWith("https://raw.githubusercontent.com/owner/assets/main/"));
    assert.equal(init.headers, undefined);
    return new Response("", { status: 404 });
  } });
  assert.deepEqual(document, emptyImageReviews());
});

test("标记绑定原图；撤销恢复原状态，不改动已汉化或派生资源", () => {
  const tasks = [task(), { ...task(), task_id: "localized.unity3d:1", status: "localized", has_localized: true },
    { ...task(), task_id: "thumb.unity3d:1", status: "derived" },
    { ...task(), task_id: "updated.unity3d:1", original_sha256: "d".repeat(64) }];
  applyImageReviews(tasks, { schema_version: 1, decisions: Object.fromEntries(tasks.map((row) => [row.task_id, mark()])) });
  assert.deepEqual(tasks.map((row) => row.status), ["not_needed", "localized", "derived", "original_only"]);
  assert(!filterImageTasks(tasks, { status: "unlocalized" }).includes(tasks[0]));
  assert(filterImageTasks(tasks, { status: "not_needed" }).includes(tasks[0]));
  applyImageReviews(tasks, emptyImageReviews());
  assert.equal(tasks[0].status, "original_only");
  assert(filterImageTasks(tasks, { status: "unlocalized" }).includes(tasks[0]));
  assert.throws(() => validateImageReviews({ schema_version: 1, decisions: { [task().task_id]: { ...mark(), source_sha256: "bad" } } }), { code: "invalid_json" });
});

test("重新生成目录保留人工决定及原图；撤销文件记录后计数恢复", () => {
  const root = mkdtempSync(join(tmpdir(), "portal-image-decisions-"));
  try {
    mkdirSync(join(root, "manifests"));
    const file = join(root, "manifests/image-review-decisions.json");
    const source = { images: [{ ...task(), bundle: "sample.unity3d", original: { sha256: task().original_sha256 }, image_layout: "complete" }] };
    writeFileSync(file, JSON.stringify({ schema_version: 1, decisions: { [task().task_id]: mark() } }));
    const marked = buildImageIndex(source, { assetsRoot: root });
    assert.equal(marked.statuses.not_needed, 1);
    assert.equal(marked.tasks[0].base_status, "original_only");
    assert.equal(marked.tasks[0].original_sha256, task().original_sha256);
    writeFileSync(file, JSON.stringify(emptyImageReviews()));
    assert.equal(buildImageIndex(source, { assetsRoot: root }).statuses.original_only, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
