import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildImageIndex, validImagePath } from "../scripts/image_data.mjs";
import { copyImageMedia } from "../scripts/copy_image_media.mjs";
import { hydrateImageOriginals } from "../scripts/hydrate_image_originals.mjs";
import { buildOutputs } from "../scripts/build_data.mjs";
import { IMAGE_STATUSES, filterImageTasks, imageDisplayReady, imageStatus, thumbnailParent } from "../public/lib/images.js";
import { validateComposition } from "../public/lib/image-composition.js";
import { imageSrc, originalReference } from "../public/lib/data.js";
import { detectImageCategory } from "../public/lib/taxonomy.js";

const root = mkdtempSync(join(tmpdir(), "portal-images-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const assetsRoot = join(root, "assets");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGNcAAAAASUVORK5CYII=", "base64");
const sha = createHash("sha256").update(png).digest("hex");
const put = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
const original = "images/original/event_0001_info/-9223372036854775807_info_00.png";
const tutorial = "images/original/tutorialinfo02/123_info_00.png";
const localized = "images/localized/event_0001_info/translated.png";
for (const path of [original, tutorial, localized, "images/original/hitokoma_100/456.png"]) put(join(assetsRoot, path), png);
const coverage = { asset_version: "1077750", images: { families: {
  event_banners: { missing_reviewed_bundles: ["event_0001_info.unity3d", "event_0002_info.unity3d", "event_0002_info.unity3d"] },
  tutorial: { missing_reviewed_bundles: ["tutorialinfo02.unity3d"] },
  ex4c: { missing_reviewed_bundles: ["ex4c00001.unity3d", "ex4c00001_thumb.unity3d"] },
  talk_stamps: { missing_reviewed_bundles: ["chat_stamp.unity3d"] },
  new_family: { missing_reviewed_bundles: ["new_surface.unity3d"] },
} } };
put(join(assetsRoot, "manifests/localization-coverage.json"), JSON.stringify(coverage));
const payload = { images: [
  { id: "event_0001_info.unity3d:-9223372036854775807", bundle: "event_0001_info.unity3d", image_layout: "complete",
    original: { relative_path: original.replace("original/", "original/original/"), sha256: sha }, localized: { relative_path: localized } },
  { id: "tutorialinfo02.unity3d:123", bundle: "tutorialinfo02.unity3d", image_layout: "complete", original: { relative_path: tutorial, sha256: sha } },
  { id: "plain", bundle: "plain.unity3d", needs_translation: false },
] };
const index = buildImageIndex(payload, { assetsRoot });
const byId = new Map(index.tasks.map((task) => [task.task_id, task]));
let passed = 0;
function ok(name, test) {
  try { test(); passed++; process.stdout.write(`ok   ${name}\n`); }
  catch (error) { process.exitCode = 1; process.stdout.write(`FAIL ${name}\n${error.stack}\n`); }
}

ok("已汉化、未汉化、原图与覆盖目录合并且去重，纹理 ID 不丢精度", () => {
  assert.equal(index.manifest_total, 3);
  assert.equal(index.texture_count, 4);
  assert.equal(index.inventory_bundle_count, 4);
  assert.equal(index.thumbnail_bundle_count, 1);
  assert.equal(index.total, 9);
  assert.deepEqual(index.statuses, { all: 9, localized: 1, original_only: 1, pending: 5, derived: 1, not_needed: 1 });
  assert.equal(index.categories.comic, 2);
  assert.equal(index.categories.other, 2);
  assert.equal(index.tasks.filter((task) => task.bundle === "tutorialinfo02.unity3d").length, 1);
  assert.equal(byId.get("event_0001_info.unity3d:-9223372036854775807").original_path, original);
  assert.equal(index.tasks.find((task) => task.bundle === "hitokoma_100.unity3d").width, 1);
  const thumb = byId.get("ex4c00001_thumb.unity3d:inventory");
  assert.equal(thumb.status, "derived", "缩略图由原图派生，不单独翻译");
  assert.equal(thumb.kind, "bundle_thumbnail");
  assert.equal(thumb.thumbnail_parent, "ex4c00001.unity3d");
  assert.equal(index.coverage.asset_version, "1077750");
});

ok("缩略图识别与上游 thumbnail_rules 一致，普通资源包不受影响", () => {
  assert.equal(thumbnailParent("ex4c00001_thumb.unity3d"), "ex4c00001.unity3d");
  assert.equal(thumbnailParent("exwb2261231_thumb.unity3d"), "exwb2261231.unity3d");
  assert.equal(thumbnailParent("hitokoma_99_thumb.unity3d"), "hitokoma_99.unity3d");
  assert.equal(thumbnailParent("blog60002_thumb.unity3d"), "blog60002.unity3d");
  assert.equal(thumbnailParent("titlebg_event_0001_thumb.unity3d"), "titlebg_event_0001.unity3d");
  assert.equal(thumbnailParent("event_0448_info_thumb.unity3d"), "event_0448_info.unity3d");
  for (const bundle of ["ex4c00001.unity3d", "chat_stamp.unity3d", "event_0448_info.unity3d", "ex4c00001_thumb.png", ""]) {
    assert.equal(thumbnailParent(bundle), null, bundle);
  }
});

ok("原图有文件才发布，不能照抄分发模板或用汉化图代替原图", () => {
  const task = byId.get("event_0001_info.unity3d:-9223372036854775807");
  assert.equal(imageSrc(task), "media/localized/event_0001_info/translated.png");
  assert.equal(imageSrc(task, "original"), `media/${original.slice(7)}`);
  assert.equal(originalReference(task).published, true);
  const missing = buildImageIndex(payload).tasks.find((row) => row.task_id === task.task_id);
  assert.equal(imageSrc(missing, "original"), null);
  assert.ok(imageSrc(missing));
  assert.equal(originalReference(missing).published, false);
  assert.equal(buildImageIndex(payload, { assetsRoot, imageBase: "https://cdn.example.com/base/" }).tasks
    .find((row) => row.task_id === task.task_id).original_url, `https://cdn.example.com/base/media/${original.slice(7)}`);
});

ok("原图哈希不符拒绝生成，不把另一版原图配给已有译图", () => {
  const changed = structuredClone(payload);
  changed.images[0].original.sha256 = "f".repeat(64);
  assert.throws(() => buildImageIndex(changed, { assetsRoot }), /原图哈希不一致/);
});

ok("图片路径拒绝穿越和 URL 注入；未知分类不混进活动", () => {
  for (const path of ["images/original/../secret.png", "images/original//a.png", "images/original/a.png?x", "images/original/%2e%2e/x.png", "images/original/x\\y.png"]) {
    assert.equal(validImagePath(path, "original"), false, path);
  }
  const warnings = [];
  const result = buildImageIndex([{ id: "unsafe", localized: { relative_path: "images/localized/../../secret.png" },
    original: { relative_path: "images/original/../secret.png" }, distribution: { url_template: "https://example.com/no-such-image.png" } }], { warnings });
  assert.equal(warnings.length, 2);
  assert.equal(result.tasks[0].localized_url, null);
  assert.equal(result.tasks[0].original_url, null);
  assert.equal(result.tasks[0].category, "other");
});

ok("筛选可组合状态、分类、原图可用性和文件名，排序不改输入", () => {
  const before = index.tasks.map((task) => task.task_id);
  assert.deepEqual(filterImageTasks(index.tasks, { category: "tutorial", status: "original_only", original: "available", keyword: "TUTORIALINFO02 info_00" })
    .map((task) => task.task_id), ["tutorialinfo02.unity3d:123"]);
  assert.equal(filterImageTasks(index.tasks, { status: "localized", original: "missing" }).length, 0);
  assert.equal(filterImageTasks(index.tasks, { status: "pending", original: "missing" }).length, 5);
  assert.equal(filterImageTasks(index.tasks, { status: "unlocalized" }).length, 6, "未汉化包含尚待确认的资源，不包含无需汉化和缩略图");
  assert.equal(filterImageTasks(index.tasks, { status: "derived" }).length, 1, "缩略图要能单独筛出来");
  assert.deepEqual(filterImageTasks(index.tasks, { keyword: "EX4C00001.UNITY3D", status: "derived" }).map((task) => task.task_id),
    ["ex4c00001_thumb.unity3d:inventory"], "按原图名也能搜到缩略图");
  assert.equal(filterImageTasks(index.tasks, { keyword: "不存在" }).length, 0);
  assert.equal(imageStatus(filterImageTasks(index.tasks)[0]), "original_only");
  assert.equal(filterImageTasks(index.tasks, { sort: "size" })[0].width, 1);
  assert.deepEqual(index.tasks.map((task) => task.task_id), before);
  assert.equal(imageStatus({ has_localized: true }), "localized", "兼容更新前的索引");
});

ok("新增图片家族能正确筛选，教学图与标题不会误归活动", () => {
  for (const [bundle, category] of [["ex4c00001.unity3d", "comic"], ["exwb1170001.unity3d", "whiteboard"],
    ["hitokoma_100.unity3d", "hitokoma"], ["mobile_talk_stamp_common_1.unity3d", "stamp"],
    ["igp_tutorial_info_100101.unity3d", "tutorial"], ["specialeventinfo01.unity3d", "tutorial"],
    ["event_0004_title.unity3d", "title"], ["pinkyringstonesalesinfo01.unity3d", "costume"]]) {
    assert.equal(detectImageCategory(bundle), category, bundle);
  }
});

ok("源图哈希匹配拼接配方，展示尺寸为完整图尺寸", () => {
  const sourceSha = "00182572c98717ac176efadf7597d59fd5b3220fa1832f9b2ca26799902f0558";
  const result = buildImageIndex([{ id: "event:large-texture-id", width: 512, height: 512,
    original: { sha256: sourceSha }, localized: { relative_path: "images/localized/event/translated.png" } }]);
  const task = result.tasks[0];
  assert.deepEqual([task.width, task.height], [576, 324]);
  assert.deepEqual([task.texture_width, task.texture_height], [512, 512]);
  assert.equal(task.composition.regions[1].transform, "rotate_ccw90");
  assert.equal(imageDisplayReady(task), true);
  assert.equal(imageDisplayReady(task, "original"), false);
  assert.equal(imageDisplayReady({ localized_url: "media/texture.png" }), false, "缺少布局时不能直接展示纹理图集");
});

ok("完整原图目录补齐未汉化图片，共享文件保留各资源身份，译图清单独立对账", () => {
  const isolatedRoot = join(root, "complete-originals");
  const path = "images/original/complete/shared.png";
  put(join(isolatedRoot, path), png);
  put(join(isolatedRoot, "images/original/complete/orphan.png"), png);
  const catalog = { schema_version: 1, kind: "source-complete-originals", images: ["ex4c00001", "ex4c00002"].map((bundle) => ({
    task_id: `${bundle}.unity3d:complete-comic`, bundle: `${bundle}.unity3d`,
    status: "original_only", image_layout: "complete", dimensions: { width: 1, height: 1 },
    original: { relative_path: path, sha256: sha },
  })) };
  const manifestPath = join(isolatedRoot, "manifests/image-originals.manifest.json");
  put(manifestPath, JSON.stringify(catalog));
  put(join(isolatedRoot, "manifests/localization-coverage.json"), JSON.stringify({ images: { families: {
    comic: { missing_reviewed_bundles: ["ex4c00001.unity3d", "ex4c00002.unity3d", "ex4c00003.unity3d"] },
  } } }));
  const result = buildImageIndex([], { assetsRoot: isolatedRoot });
  assert.equal(result.manifest_total, 0);
  assert.equal(result.texture_count, 2);
  assert.equal(result.inventory_bundle_count, 1);
  assert.equal(result.statuses.original_only, 2);
  assert.equal(filterImageTasks(result.tasks, { status: "unlocalized", original: "available" }).length, 2);
  for (const task of result.tasks.filter((t) => t.original_url)) {
    assert.equal(imageDisplayReady(task, "original"), true);
    assert.equal(task.has_localized, false);
    assert.equal(task.localized_url, null);
  }
  catalog.images[0].original.sha256 = "f".repeat(64);
  put(manifestPath, JSON.stringify(catalog));
  assert.throws(() => buildImageIndex([], { assetsRoot: isolatedRoot }), /哈希不一致/);
  catalog.images[0].original.relative_path = "images/original/missing.png";
  put(manifestPath, JSON.stringify(catalog));
  assert.throws(() => buildImageIndex([], { assetsRoot: isolatedRoot }), /尚未发布/);
});

ok("全部拼接配方的边界、旋转尺寸和目标区域合法", () => {
  const recipes = JSON.parse(readFileSync("scripts/image-compositions.json", "utf8")).sources;
  assert.equal(Object.keys(recipes).length, 1108);
  for (const [sha, recipe] of Object.entries(recipes)) {
    assert.match(sha, /^[a-f0-9]{64}$/);
    assert.equal(validateComposition(recipe), recipe);
  }
  const recipe = structuredClone(Object.values(recipes)[0]);
  recipe.regions[0].rect[0] = -1;
  assert.throws(() => validateComposition(recipe), /越界/);
  assert.throws(() => validateComposition({ source_size: [512, 512], size: [999999, 999999], regions: [] }), /合法尺寸/);
});

ok("发布脚本同时复制原图和汉化图，忽略尚未发布的占位资源", () => {
  const mediaRoot = join(root, "media");
  assert.equal(copyImageMedia({ assetsRoot, images: index, mediaRoot }), 4);
  assert.deepEqual(readFileSync(join(mediaRoot, original.slice(7))), png);
  assert.ok(existsSync(join(mediaRoot, localized.slice(7))));
  const invalid = { tasks: [{ original_url: "media/original/bad.png", original_path: "images/original/../../bad.png" }] };
  assert.throws(() => copyImageMedia({ assetsRoot, images: invalid, mediaRoot }), /非法图片路径/);
  assert.throws(() => copyImageMedia({ assetsRoot, images: { tasks: [{ localized_url: "media/localized/missing.png", localized_path: "images/localized/missing.png" }] }, mediaRoot }), /ENOENT/);
});

ok("主生成器接入覆盖目录后保持清单对账和 portal 计数一致", () => {
  const fixtureRoot = join(root, "fixture");
  cpSync("test_helpers/fixtures/assets-repo", fixtureRoot, { recursive: true });
  put(join(fixtureRoot, "manifests/localization-coverage.json"), JSON.stringify(coverage));
  const built = buildOutputs({ assetsRoot: fixtureRoot, generatedAt: "2026-01-01T00:00:00Z" });
  const images = JSON.parse(built.files.get("images.json"));
  const portal = JSON.parse(built.files.get("portal.json"));
  assert.equal(images.manifest_total, 4);
  assert.ok(images.inventory_bundle_count > 0);
  assert.equal(built.warnings.some((warning) => warning.includes("图片数不一致")), false);
  assert.equal(images.total, Object.keys(IMAGE_STATUSES).reduce((sum, key) => sum + images.statuses[key], 0));
  assert.deepEqual(portal.image_statuses, images.statuses);
});

async function asyncOk(name, test) {
  try { await test(); passed++; process.stdout.write(`ok   ${name}\n`); }
  catch (error) { process.exitCode = 1; process.stdout.write(`FAIL ${name}\n${error.stack}\n`); }
}

await asyncOk("稀疏媒体恢复固定仓库提交、去重、验证哈希，并复用本地文件", async () => {
  const hydrateRoot = join(root, "hydrate");
  const path = `images/original/complete/${sha}.webp`;
  const task = { image_layout: "complete", original: { relative_path: path, sha256: sha } };
  put(join(hydrateRoot, "manifests/image-originals.manifest.json"), JSON.stringify({ schema_version: 1,
    kind: "source-complete-originals", images: [task, structuredClone(task)] }));
  const requests = [];
  const settings = { assetsRoot: hydrateRoot, repo: "example/assets", revision: "a".repeat(40),
    fetchImage: async (url) => { requests.push(url); return new Response(png); } };
  assert.deepEqual(await hydrateImageOriginals(settings), { total: 1, fetched: 1 });
  assert.equal(requests[0], `https://raw.githubusercontent.com/example/assets/${"a".repeat(40)}/${path}`);
  assert.deepEqual(readFileSync(join(hydrateRoot, path)), png);
  assert.deepEqual(await hydrateImageOriginals(settings), { total: 1, fetched: 0 });
  assert.equal(requests.length, 1);
  put(join(hydrateRoot, path), "modified");
  await assert.rejects(hydrateImageOriginals(settings), /哈希不一致/);
  assert.equal(requests.length, 1, "已有文件哈希异常时不覆盖它");
  await assert.rejects(hydrateImageOriginals({ ...settings, revision: "main" }), /固定提交/);
});

await asyncOk("媒体恢复遇到损坏响应不发布半张图片，也不保留失败临时文件", async () => {
  const hydrateRoot = join(root, "hydrate-failure");
  const path = `images/original/complete/${sha}.webp`;
  put(join(hydrateRoot, "manifests/image-originals.manifest.json"), JSON.stringify({ schema_version: 1,
    kind: "source-complete-originals", images: [{ image_layout: "complete", original: { relative_path: path, sha256: sha } }] }));
  await assert.rejects(hydrateImageOriginals({ assetsRoot: hydrateRoot, repo: "example/assets", revision: "a".repeat(40),
    fetchImage: async () => new Response("damaged") }), /哈希不一致/);
  assert.equal(existsSync(join(hydrateRoot, path)), false);
  assert.deepEqual(readdirSync(dirname(join(hydrateRoot, path))), []);
});

await asyncOk("并行恢复相同媒体不覆盖已有文件，也不共享临时文件", async () => {
  const hydrateRoot = join(root, "hydrate-concurrent");
  mkdirSync(hydrateRoot);
  const path = `images/original/complete/${sha}.webp`;
  const settings = { assetsRoot: hydrateRoot, repo: "example/assets", revision: "a".repeat(40),
    catalog: { schema_version: 1, kind: "source-complete-originals",
      images: [{ image_layout: "complete", original: { relative_path: path, sha256: sha } }] },
    fetchImage: async () => new Response(png) };
  await Promise.all([hydrateImageOriginals(settings), hydrateImageOriginals(settings)]);
  assert.deepEqual(readFileSync(join(hydrateRoot, path)), png);
  assert.deepEqual(readdirSync(dirname(join(hydrateRoot, path))), [`${sha}.webp`]);
});

process.stdout.write(`\n${passed} 个图片用例通过\n`);
