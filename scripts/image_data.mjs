// 已审核清单、已发布原图与覆盖报告共同组成图片目录。只读上游，不猜下载地址。
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync } from "node:fs";
import { extname, join, posix } from "node:path";
import { relativeFileMap } from "./fs-utils.mjs";
import { IMAGE_CATEGORY_ORDER, IMAGE_CATEGORY_RULES, detectImageCategory } from "../public/lib/taxonomy.js";
import { IMAGE_STATUSES, imageStatus, thumbnailParent } from "../public/lib/images.js";
import { validateComposition } from "../public/lib/image-composition.js";
import { IMAGE_REVIEW_PATH, applyImageReviews, emptyImageReviews } from "../public/lib/image-review.js";

const COMPOSITIONS = JSON.parse(readFileSync(new URL("./image-compositions.json", import.meta.url), "utf8")).sources;
for (const recipe of Object.values(COMPOSITIONS)) validateComposition(recipe);

const FAMILY_CATEGORY = {
  event_banners: "event", costume_sale: "costume", tutorial: "tutorial", ex4c: "comic",
  exwb: "whiteboard", hitokoma: "hitokoma", talk_stamps: "stamp", titles_logos: "title",
};

function hashImageFile(full, buffer) {
  const descriptor = openSync(full, "r");
  const hash = createHash("sha256");
  let header = null;
  try {
    let size;
    while ((size = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      if (!header) header = Buffer.from(buffer.subarray(0, Math.min(24, size)));
      hash.update(buffer.subarray(0, size));
    }
  } finally { closeSync(descriptor); }
  return { sha: hash.digest("hex"), header: header || Buffer.alloc(0) };
}

export function validImagePath(value, side) {
  const path = String(value || "");
  return path.startsWith(`images/${side}/`) && !/[\\?#%\x00-\x1f]/.test(path)
    && !path.split("/").some((part) => !part || part === "." || part === "..")
    && /\.(png|jpe?g|webp)$/i.test(path);
}

export function buildImageIndex(payload, { assetsRoot = "", completeOriginalsRoot = "", imageBase = "", warnings = [], notes = [] } = {}) {
  const tasks = payload == null ? [] : Array.isArray(payload) ? payload : payload.images ?? payload.tasks;
  if (!Array.isArray(tasks)) throw new Error("图片清单里找不到 images/tasks 数组");
  const base = String(imageBase || "").replace(/\/+$/, "");
  const mediaUrl = (path) => `${base ? `${base}/` : ""}media/${path.slice("images/".length).split("/").map(encodeURIComponent).join("/")}`;
  const files = assetsRoot ? new Map([...relativeFileMap(join(assetsRoot, "images/original"),
    (entry) => /\.(png|jpe?g|webp)$/i.test(entry.name))].map(([path, full]) => [`images/original/${path}`, full])) : new Map();
  if (completeOriginalsRoot) {
    for (const path of files.keys()) if (path.startsWith("images/original/complete/")) files.delete(path);
    for (const entry of readdirSync(completeOriginalsRoot, { withFileTypes: true })) {
      if (entry.isFile() && /^[a-f0-9]{64}\.webp$/.test(entry.name)) {
        files.set(`images/original/complete/${entry.name}`, join(completeOriginalsRoot, entry.name));
      }
    }
  }
  const normalized = new Map();
  const byOriginalPath = new Map();

  const normalize = (task) => {
    const taskId = String(task?.task_id ?? task?.id ?? "").trim();
    if (!taskId) { warnings.push("图片任务缺少 task_id，已跳过"); return null; }
    if (normalized.has(taskId)) { warnings.push(`图片任务 ${taskId} 重复，已跳过后一条`); return null; }
    const bundle = String(task.bundle || "");
    const category = (Object.hasOwn(IMAGE_CATEGORY_RULES, task.category) ? task.category : detectImageCategory(bundle)) || "other";
    const imagePath = (side) => {
      const path = task?.[side]?.relative_path || "";
      if (path && !validImagePath(path, side)) {
        warnings.push(`图片任务 ${taskId} 的 ${side} 路径非法，已忽略`);
        return "";
      }
      return path;
    };
    const localizedPath = imagePath("localized");
    const originalPath = imagePath("original");
    const status = ["pending", "derived"].includes(task.status) ? task.status : localizedPath ? "localized"
      : task.status === "not_needed" || task.needs_translation === false ? "not_needed" : "original_only";
    const row = {
      task_id: taskId, bundle, kind: String(task.kind || "ui_texture"), category,
      category_name: `${IMAGE_CATEGORY_RULES[category].icon} ${IMAGE_CATEGORY_RULES[category].name}`,
      width: Number(task?.dimensions?.width ?? task?.width) || 0,
      height: Number(task?.dimensions?.height ?? task?.height) || 0,
      status,
      localized_path: localizedPath || null,
      localized_url: status === "localized" ? mediaUrl(localizedPath) : null,
      localized_file: localizedPath ? posix.basename(localizedPath) : null,
      localized_sha256: String(task?.localized?.sha256 || "").trim().toLowerCase() || null,
      original_path: originalPath || null,
      original_url: null,
      original_sha256: String(task?.original?.sha256 || "").trim().toLowerCase() || null,
      original_published: false,
      has_localized: status === "localized",
      image_layout: task.image_layout === "complete" ? "complete" : "unprepared",
      review_status: String(task.review_status || ""),
      thumbnail_parent: String(task.thumbnail_parent || "") || null,
      ...(task.original_issue ? { original_issue: String(task.original_issue) } : {}),
    };
    normalized.set(taskId, row);
    if (originalPath) {
      const canonical = originalPath.replace(/^images\/original\/original\//, "images/original/");
      if (!byOriginalPath.has(canonical)) byOriginalPath.set(canonical, []);
      byOriginalPath.get(canonical).push(row);
    }
    return row;
  };
  for (const task of tasks) normalize(task);
  const manifestTotal = normalized.size;
  const originalIssues = new Map();

  // 完整原图目录独立于已审核译图清单；源图入库不代表汉化已经通过审核。
  const originalsManifest = assetsRoot && join(assetsRoot, "manifests/image-originals.manifest.json");
  if (originalsManifest && existsSync(originalsManifest)) {
    const catalog = JSON.parse(readFileSync(originalsManifest, "utf8"));
    if (catalog.schema_version !== 1 || catalog.kind !== "source-complete-originals" || !Array.isArray(catalog.images)) {
      throw new Error("完整原图目录格式不正确");
    }
    for (const task of catalog.images) {
      const path = task?.original?.relative_path;
      if (task.image_layout !== "complete" || task.status !== "original_only" || task.localized
          || !validImagePath(path, "original") || !/^[a-f0-9]{64}$/.test(task?.original?.sha256 || "")
          || !task.bundle?.endsWith(".unity3d") || !task.task_id?.startsWith(`${task.bundle}:`)
          || !Number.isInteger(task?.dimensions?.width) || !Number.isInteger(task?.dimensions?.height)
          || task.dimensions.width <= 0 || task.dimensions.height <= 0
          || task.dimensions.width * task.dimensions.height > 16_777_216) {
        throw new Error(`完整原图记录不合法：${task.task_id || path}`);
      }
      if (!files.has(path)) throw new Error(`完整原图文件尚未发布：${path}`);
      if (normalized.has(task.task_id)) throw new Error(`完整原图任务重复：${task.task_id}`);
      normalize(task);
    }
    for (const entry of catalog.unresolved || []) {
      originalIssues.set(entry.bundle, String(entry.reason || "").includes("complete-image grouping")
        ? "该资源包含额外图层，尚待确认完整图布局" : "原图提取失败，等待处理");
    }
    notes.push(`images: 已发布 ${catalog.images.length} 张未汉化完整原图`);
  }

  // 旧清单的 original/original/ 是历史目录形状。以真实文件定位，并校验像素文件哈希。
  const imageBuffer = Buffer.allocUnsafe(64 * 1024);
  for (const [path, full] of files) {
    if (!validImagePath(path, "original")) continue;
    const canonicalPath = path.replace(/^images\/original\/original\//, "images/original/");
    // 内容寻址的完整原图必须在来源目录中有记录，不能把中断导出的孤立文件当任务发布。
    if (path.startsWith("images/original/complete/") && !byOriginalPath.has(canonicalPath)) continue;
    const filename = posix.basename(path);
    const textureId = filename.match(/^(-?\d+)(?:_|\.)/)?.[1];
    const bundleBase = posix.basename(posix.dirname(path)).replace(/\.unity3d$/i, "");
    let matching = byOriginalPath.get(canonicalPath) || [];
    if (!matching.length && textureId && normalized.has(`${bundleBase}.unity3d:${textureId}`)) {
      matching = [normalized.get(`${bundleBase}.unity3d:${textureId}`)];
    }
    const { sha, header } = hashImageFile(full, imageBuffer);
    if (!matching.length) {
      // 保留完整文件路径作身份，避免无法识别纹理 ID 的文件互相覆盖。
      const row = normalize({ task_id: textureId ? `${bundleBase}.unity3d:${textureId}` : `original:${canonicalPath}`,
        bundle: `${bundleBase}.unity3d`, original: { relative_path: path, sha256: sha }, status: "pending" });
      if (row) matching = [row];
    }
    for (const row of matching) {
      if (row.original_sha256 && row.original_sha256 !== sha) throw new Error(`图片原图哈希不一致：${path}`);
      row.original_path = path;
      row.original_url = mediaUrl(path);
      row.original_published = true;
      row.original_sha256 = sha;
      if (!row.width && extname(path).toLowerCase() === ".png" && header.length >= 24 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        row.width = header.readUInt32BE(16);
        row.height = header.readUInt32BE(20);
      }
    }
  }

  const coveragePath = assetsRoot && join(assetsRoot, "manifests/localization-coverage.json");
  const coverage = coveragePath && existsSync(coveragePath) ? JSON.parse(readFileSync(coveragePath, "utf8")) : null;
  const families = coverage?.images?.families;
  const knownBundles = new Set([...normalized.values()].map((task) => task.bundle));
  // 覆盖清单按包计数，不能假设每包只有一张图，或每张图都含日文。
  // 缩略图按上游政策由已审核原图派生，不单独翻译，因此单独归类而不是算作待翻译。
  for (const [family, inventory] of Object.entries(families || {})) {
    for (const bundle of inventory.missing_reviewed_bundles || []) {
      if (typeof bundle !== "string" || !bundle.endsWith(".unity3d") || knownBundles.has(bundle)) continue;
      knownBundles.add(bundle);
      const parent = thumbnailParent(bundle);
      normalize({ task_id: `${bundle}:inventory`, bundle, kind: parent ? "bundle_thumbnail" : "bundle_inventory",
        category: FAMILY_CATEGORY[family] || "other", status: parent ? "derived" : "pending",
        review_status: "not_reviewed", thumbnail_parent: parent, original_issue: originalIssues.get(bundle) });
    }
  }

  const rows = [...normalized.values()].sort((a, b) => a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0);
  for (const task of rows) {
    if (task.image_layout === "complete") continue;
    const recipe = COMPOSITIONS[task.original_sha256];
    if (!recipe) continue;
    task.composition = recipe;
    task.image_layout = "composed";
    task.texture_width = task.width;
    task.texture_height = task.height;
    [task.width, task.height] = recipe.size;
  }
  const reviewPath = assetsRoot && join(assetsRoot, IMAGE_REVIEW_PATH);
  applyImageReviews(rows, reviewPath && existsSync(reviewPath) ? JSON.parse(readFileSync(reviewPath, "utf8")) : emptyImageReviews());
  const categories = { all: rows.length, ...Object.fromEntries(IMAGE_CATEGORY_ORDER.map((id) => [id, 0])) };
  const statuses = { all: rows.length, ...Object.fromEntries(Object.keys(IMAGE_STATUSES).map((id) => [id, 0])) };
  for (const task of rows) { categories[task.category] += 1; statuses[imageStatus(task)] += 1; }
  const bundleRows = rows.filter((task) => task.kind.startsWith("bundle_"));
  if (statuses.original_only) notes.push(`images: ${statuses.original_only} 个任务没有中文版文件，列为未汉化`);
  if (statuses.derived) notes.push(`images: ${statuses.derived} 个缩略图资源包由原图派生，不计入待翻译`);
  if (!families) notes.push("images: 未提供图片覆盖清单，无法列出尚未收录的资源包");
  return { total: rows.length, manifest_total: manifestTotal,
    texture_count: rows.length - bundleRows.length,
    inventory_bundle_count: bundleRows.filter((task) => task.kind === "bundle_inventory").length,
    thumbnail_bundle_count: bundleRows.filter((task) => task.kind === "bundle_thumbnail").length,
    coverage: { available: Boolean(families), asset_version: coverage?.asset_version || null },
    categories, statuses, tasks: rows };
}
