import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { applyImageSubmissions, commitImageSubmission, emptyImageSubmissions, loadImageSubmissions,
  MAX_SUBMISSION_BYTES, prepareSubmissionImage, validateImageSubmissions, validateSubmissionPng } from "../public/lib/image-submission.js";
import { imageDisplayReady, imageStatus, filterImageTasks } from "../public/lib/images.js";
import { loadDisplayImage } from "../public/lib/image-renderer.js";
import { buildImageIndex } from "../scripts/image_data.mjs";
import { copyImageMedia } from "../scripts/copy_image_media.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGNcAAAAASUVORK5CYII=", "base64");
const hash = createHash("sha256").update(png).digest("hex");
const task = () => ({ task_id: "sample.unity3d:complete-123", bundle: "sample.unity3d", kind: "source_complete_image",
  width: 1, height: 1, image_layout: "complete", original_sha256: hash, original_url: "media/original/source.png", status: "original_only", has_localized: false });
const submission = (revision = "review-1") => ({ source_sha256: hash, candidate_sha256: hash, path: `images/submissions/${hash}.png`,
  status: "pending", width: 1, height: 1, note: "译名待复核", revision, submitted_at: "2026-10-16T00:00:00Z" });
const opts = () => ({ repo: "owner/assets", ref: "main", token: "test-secret-token", task: task(), bytes: png,
  note: "中文备注", revision: () => "review-1", now: () => "2026-10-16T00:00:00Z" });
const sha = (n) => String(n).repeat(40);

function mockApi(initial = null, failAt = null) {
  const calls = [];
  let draft = null, visible = initial, encodedImage = null;
  const fetchImpl = async (url, init = {}) => {
    assert(!url.includes("test-secret-token"));
    assert.equal(init.headers.Authorization, "Bearer test-secret-token");
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, body });
    if (failAt && url.includes(failAt)) return new Response("", { status: 409 });
    if (url.includes("/git/ref/")) return Response.json({ object: { sha: sha(1) } });
    if (url.includes(`/git/commits/${sha(1)}`)) return Response.json({ tree: { sha: sha(2) } });
    if (url.includes("/contents/")) {
      assert(url.endsWith(`?ref=${sha(1)}`), "清单从同一个不可变 HEAD 读取");
      return initial ? Response.json(initial) : new Response("", { status: 404 });
    }
    if (url.endsWith("/git/blobs")) { encodedImage = body.content; return Response.json({ sha: sha(3) }); }
    if (url.endsWith("/git/trees")) {
      assert.equal(body.base_tree, sha(2), "继承完整树，保留其他所有文件");
      assert.equal(body.tree.length, 2);
      assert.equal(body.tree[0].path, `images/submissions/${hash}.png`);
      assert.equal(body.tree[0].sha, sha(3));
      assert.equal(body.tree[1].path, "manifests/image-submissions.json");
      draft = JSON.parse(body.tree[1].content);
      assert.equal(visible, initial, "创建对象未发布半份投稿");
      return Response.json({ sha: sha(4) });
    }
    if (url.endsWith("/git/commits")) {
      assert.deepEqual(body.parents, [sha(1)]);
      assert.equal(body.tree, sha(4));
      assert.equal(visible, initial);
      return Response.json({ sha: sha(5) });
    }
    if (url.includes("/git/refs/")) {
      assert.equal(init.method, "PATCH");
      assert.deepEqual(body, { sha: sha(5), force: false });
      visible = draft;
      return Response.json({ object: { sha: sha(5) } });
    }
    assert.fail(`unexpected request ${url}`);
  };
  return { fetchImpl, calls, get document() { return visible; }, get png() { return Buffer.from(encodedImage, "base64"); } };
}

test("完整 PNG 与投稿目录原子提交，保存备注、源哈希及其他投稿", async () => {
  const initial = { schema_version: 1, submissions: { "other.unity3d:1": submission("other") }, note: "保留元信息" };
  const api = mockApi(initial);
  const result = await commitImageSubmission({ ...opts(), fetchImpl: api.fetchImpl });
  assert.deepEqual(api.png, png);
  assert.equal(result.commit.sha, sha(5));
  assert.equal(api.document.note, "保留元信息");
  assert.deepEqual(api.document.submissions["other.unity3d:1"], initial.submissions["other.unity3d:1"]);
  assert.equal(api.document.submissions[task().task_id].status, "pending");
  assert.equal(api.document.submissions[task().task_id].note, "中文备注");
  assert.equal(api.document.submissions[task().task_id].candidate_sha256, hash);
  assert(api.calls.every(({ url }) => !url.includes("images.manifest.json")), "不更改批准清单");
});

test("更新投稿检查旧版本，提交历史由 Git 保留", async () => {
  const initial = { schema_version: 1, submissions: { [task().task_id]: submission("older") } };
  const stale = mockApi(initial);
  await assert.rejects(commitImageSubmission({ ...opts(), fetchImpl: stale.fetchImpl }), { code: "conflict" });
  assert(stale.calls.every(({ method }) => method === "GET"));
  const fresh = mockApi(initial);
  await commitImageSubmission({ ...opts(), expectedRevision: "older", fetchImpl: fresh.fetchImpl });
  assert.equal(fresh.document.submissions[task().task_id].revision, "review-1");
});

test("上传、建树或最终更新失败均不发布半份记录，不强制覆盖并发提交", async () => {
  for (const step of ["/git/blobs", "/git/trees", "/git/commits", "/git/refs/"]) {
    const api = mockApi(null, step);
    await assert.rejects(commitImageSubmission({ ...opts(), fetchImpl: api.fetchImpl }), { code: "conflict" });
    assert.equal(api.document, null);
  }
  await assert.rejects(commitImageSubmission({ ...opts(), fetchImpl: async () => { throw Error("test-secret-token"); } }),
    (error) => error.code === "network_error" && !error.message.includes("test-secret-token"));
});

test("无 Token、坏图、错误尺寸、超限、占位包在发请求前拒绝", async () => {
  const fetchImpl = () => assert.fail("不应发送请求");
  await assert.rejects(commitImageSubmission({ ...opts(), token: "", fetchImpl }), { code: "no_token" });
  await assert.rejects(commitImageSubmission({ ...opts(), bytes: Buffer.from("not a PNG"), fetchImpl }), { code: "invalid_image" });
  await assert.rejects(commitImageSubmission({ ...opts(), task: { ...task(), width: 2 }, fetchImpl }), { code: "invalid_image" });
  await assert.rejects(commitImageSubmission({ ...opts(), note: "字".repeat(1001), fetchImpl }), { code: "invalid_edit" });
  await assert.rejects(commitImageSubmission({ ...opts(), task: { ...task(), kind: "bundle_inventory" }, fetchImpl }), { code: "invalid_edit" });
  assert.throws(() => validateSubmissionPng(new Uint8Array(MAX_SUBMISSION_BYTES + 1), task()), { code: "invalid_image" });
  assert.throws(() => validateSubmissionPng(png.subarray(0, png.length - 5), task()), { code: "invalid_image" });
  const animated = Buffer.concat([png.subarray(0, 33), Buffer.from([0, 0, 0, 0, 97, 99, 84, 76, 0, 0, 0, 0]), png.subarray(33)]);
  assert.throws(() => validateSubmissionPng(animated, task()), { code: "invalid_image" });
});

test("公开与带 Token 的最新投稿读取，权限失败不当作空清单", async () => {
  const document = { schema_version: 1, submissions: { [task().task_id]: submission() } };
  assert.deepEqual(await loadImageSubmissions({ ...opts(), fetchImpl: async (_url, init) => {
    assert.equal(init.headers.Accept, "application/vnd.github.raw+json");
    return Response.json(document);
  } }), document);
  assert.deepEqual(await loadImageSubmissions({ ...opts(), token: "", fetchImpl: async (url, init) => {
    assert(url.startsWith("https://raw.githubusercontent.com/owner/assets/main/"));
    assert.equal(init.headers, undefined);
    return new Response("", { status: 404 });
  } }), emptyImageSubmissions());
  for (const [status, code] of [[401, "unauthorized"], [403, "forbidden"], [500, "http_error"]]) {
    await assert.rejects(loadImageSubmissions({ ...opts(), fetchImpl: async () => new Response("", { status }) }), { code });
  }
});

test("预览先真实解码，提交保留 PNG 原始字节，并释放解码资源", async () => {
  const original = globalThis.createImageBitmap;
  let closed = 0;
  try {
    globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close: () => closed++ });
    const prepared = await prepareSubmissionImage(new Blob([png]), task());
    assert.deepEqual(Buffer.from(prepared.bytes), png);
    assert.deepEqual(Buffer.from(await prepared.blob.arrayBuffer()), png);
    assert.equal(closed, 1);
    globalThis.createImageBitmap = async () => ({ width: 2, height: 1, close: () => closed++ });
    await assert.rejects(prepareSubmissionImage(new Blob([png]), task()), { code: "invalid_image" });
    assert.equal(closed, 2);
  } finally { globalThis.createImageBitmap = original; }
});

test("原图变更使旧投稿失效，待审核可筛选，审核译图保留", () => {
  const rows = [task(), { ...task(), task_id: "approved.unity3d:1", has_localized: true, status: "localized", localized_url: "media/approved.png" },
    { ...task(), task_id: "updated.unity3d:1", original_sha256: "a".repeat(64) }];
  applyImageSubmissions(rows, { schema_version: 1, submissions: Object.fromEntries(rows.map((row) => [row.task_id, submission()])) }, { repo: "owner/assets", ref: sha(5) });
  assert.equal(imageStatus(rows[0]), "pending");
  assert.equal(imageStatus(rows[1]), "localized");
  assert.equal(rows[1].localized_url, "media/approved.png");
  assert.equal(rows[2].submission, null);
  assert.deepEqual(filterImageTasks(rows, { status: "submitted" }).map((row) => row.task_id).sort(), [rows[0].task_id, rows[1].task_id].sort());
  assert(imageDisplayReady(rows[0], "localized"));
  assert(imageDisplayReady(rows[1], "submission"));
  assert(rows[0].submission_url.includes(`/${sha(5)}/`));
  assert.throws(() => validateImageSubmissions({ schema_version: 1, submissions: { [task().task_id]: { ...submission(), path: "../private" } } }), { code: "invalid_json" });
});

test("投稿是完整图，不对其再次应用原 Texture2D 拼接配方", async () => {
  const previousImage = globalThis.Image;
  try {
    globalThis.Image = class { naturalWidth = 1; naturalHeight = 1; set src(_) { queueMicrotask(() => this.onload()); } };
    const row = { ...task(), image_layout: "composed", composition: { invalid: "must never be used for full candidate" }, submission: submission(), submission_url: "https://example.com/submission.png" };
    const calls = [];
    const canvas = { getContext: () => ({ drawImage: (...args) => calls.push(args) }) };
    await loadDisplayImage(canvas, row, "localized");
    assert.deepEqual([canvas.width, canvas.height], [1, 1]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 3);
  } finally { globalThis.Image = previousImage; }
});

test("生成与静态媒体发布保留投稿，哈希异常阻止生成", () => {
  const root = mkdtempSync(join(tmpdir(), "portal-submissions-"));
  const put = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
  try {
    const original = "images/original/source/1.png";
    const source = { images: [{ ...task(), original: { relative_path: original, sha256: hash } }] };
    put(join(root, original), png);
    put(join(root, submission().path), png);
    put(join(root, "manifests/image-submissions.json"), JSON.stringify({ schema_version: 1, submissions: { [task().task_id]: submission() } }));
    const index = buildImageIndex(source, { assetsRoot: root });
    assert.equal(index.statuses.pending, 1);
    assert.equal(index.statuses.localized, 0);
    assert.equal(index.manifest_total, 1);
    assert.equal(index.tasks[0].submission_url, `media/submissions/${hash}.png`);
    const mediaRoot = join(root, "public/media");
    assert.equal(copyImageMedia({ assetsRoot: root, images: index, mediaRoot }), 2);
    assert.deepEqual(readFileSync(join(mediaRoot, `submissions/${hash}.png`)), png);
    const changed = Buffer.from(png); changed[50] ^= 1;
    writeFileSync(join(root, submission().path), changed);
    assert.throws(() => buildImageIndex(source, { assetsRoot: root }), /投稿哈希不一致/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
