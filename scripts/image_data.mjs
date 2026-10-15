// 已审核清单、已发布原图与覆盖报告共同组成图片目录。只读上游，不猜下载地址。
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { extname, join, posix } from "node:path";
import { relativeFileMap } from "./fs-utils.mjs";
import { IMAGE_CATEGORY_ORDER, IMAGE_CATEGORY_RULES, detectImageCategory } from "../public/lib/taxonomy.js";
import { IMAGE_STATUSES, imageStatus, thumbnailParent } from "../public/lib/images.js";
import { validateComposition } from "../public/lib/image-composition.js";

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

export function buildImageIndex(payload, { assetsRoot = "", imageBase = "", warnings = [], notes = [] } = {}) {
  const tasks = payload == null ? [] : Array.isArray(payload) ? payload : payload.images ?? payload.tasks;
  if (!Array.isArray(tasks)) throw new Error("图片清单里找不到 images/tasks 数组");
  const base = String(imageBase || "").replace(/\/+$/, "");
  const mediaUrl = (path) => `${base ? `${base}/` : ""}media/${path.slice("images/".length).split("/").map(encodeURIComponent).join("/")}`;
  const files = assetsRoot ? new Map([...relativeFileMap(join(assetsRoot, "images/original"),
    (entry) => /\.(png|jpe?g|webp)$/i.test(entry.name))].map(([path, full]) => [`images/original/${path}`, full])) : new Map();
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
    };
    normalized.set(taskId, row);
    if (originalPath) byOriginalPath.set(originalPath.replace(/^images\/original\/original\//, "images/original/"), row);
    return row;
  };
  for (const task of tasks) normalize(task);
  const manifestTotal = normalized.size;

  // 旧清单的 original/original/ 是历史目录形状。以真实文件定位，并校验像素文件哈希。
  const imageBuffer = Buffer.allocUnsafe(64 * 1024);
  for (const [path, full] of files) {
    if (!validImagePath(path, "original")) continue;
    const canonicalPath = path.replace(/^images\/original\/original\//, "images/original/");
    const filename = posix.basename(path);
    const textureId = filename.match(/^(-?\d+)(?:_|\.)/)?.[1];
    const bundleBase = posix.basename(posix.dirname(path)).replace(/\.unity3d$/i, "");
    let row = byOriginalPath.get(canonicalPath) || (textureId && normalized.get(`${bundleBase}.unity3d:${textureId}`));
    const { sha, header } = hashImageFile(full, imageBuffer);
    if (row?.original_sha256 && row.original_sha256 !== sha) {
      throw new Error(`图片原图哈希不一致：${path}`);
    }
    if (!row) {
      // 保留完整文件路径作身份，避免无法识别纹理 ID 的文件互相覆盖。
      row = normalize({ task_id: textureId ? `${bundleBase}.unity3d:${textureId}` : `original:${canonicalPath}`,
        bundle: `${bundleBase}.unity3d`, original: { relative_path: path, sha256: sha }, status: "pending" });
    }
    if (!row) continue;
    row.original_path = path;
    row.original_url = mediaUrl(path);
    row.original_published = true;
    row.original_sha256 = sha;
    if (!row.width && extname(path).toLowerCase() === ".png" && header.length >= 24 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      row.width = header.readUInt32BE(16);
      row.height = header.readUInt32BE(20);
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
        review_status: "not_reviewed", thumbnail_parent: parent });
    }
  }

  const rows = [...normalized.values()].sort((a, b) => a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0);
  for (const task of rows) {
    const recipe = COMPOSITIONS[task.original_sha256];
    if (!recipe) continue;
    task.composition = recipe;
    task.image_layout = "composed";
    task.texture_width = task.width;
    task.texture_height = task.height;
    [task.width, task.height] = recipe.size;
  }
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
