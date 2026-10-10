#!/usr/bin/env node
// 门户静态数据生成器：读两个翻译仓库的本地 checkout，写出 public/data/**。
//
// 设计约束（见 docs/DATA-CONTRACT.md）：
//   * 只读上游，不写上游。写上游只有"单人 PAT 单行编辑"那一条路径。
//   * 输出确定性：同输入逐字节相同。唯一允许变化的是 portal.json 的 generated_at。
//   * 失败显式：缺字段、非法版本轴、复用被改过的行一律非零退出，不产出空数据。
//   * 低内存：产出边生成边交给"汇"（sink），不再攒在内存里；写模式下先落暂存目录，
//     全部成功后再原子替换目标目录，所以中途失败不会留下半份产出。
//   * 零依赖：只用 node 内置模块 + 与浏览器共享的 lib/*.js。
//
// 用法：
//   node scripts/build_data.mjs --assets-root vendor/assets --client-root vendor/client
//   node scripts/build_data.mjs --check        # 只比对，不写盘（CI 漂移守门）

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, posix, relative } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CATEGORY_ORDER,
  CATEGORY_RULES,
  DOMAIN_META,
  DOMAIN_ORDER,
  IMAGE_CATEGORY_ORDER,
  IMAGE_CATEGORY_RULES,
  categoryId,
  detectIdol,
  detectImageCategory,
  statusCounts,
  upstreamPathForBundle,
} from "../public/lib/taxonomy.js";
import { SONG_MASTER, SONG_MASTER_EXTRA, SONG_VARIANT_OVERRIDES } from "../public/lib/terms.js";

/// 曲名表：基础表 + 抓包之后新增的补充条目。重复时以基础表为准。
const SONGS = { ...SONG_MASTER_EXTRA, ...SONG_MASTER };

/// 扩展版本资源名 -> 主曲目代号。抓包导出的那份（scripts/import_song_names.mjs 生成）
/// 作为底表，手工核对过的几条覆盖在上面。
const SONG_VARIANTS = (() => {
  const file = new URL("../public/lib/song-variants.json", import.meta.url);
  let imported = {};
  if (existsSync(file)) {
    try {
      imported = JSON.parse(readFileSync(file, "utf8"))?.variants ?? {};
    } catch (error) {
      throw new Error(`曲名对照文件读不动：${file.pathname}（${error.message}）`);
    }
  }
  return { ...imported, ...SONG_VARIANT_OVERRIDES };
})();

/// 资源名 -> 曲名记录。先按资源名精确查表；查不到再看它是不是某个扩展版本
/// （游戏里同一首歌会挂多个包，扩展版本自己不带曲名，但抓包里有父子关系）。
/// 返回记录里带 `variant_of` 就表示这是同一首歌的另一个版本。
export function songFor(bundle) {
  const code = String(bundle).replace(/^scrobj_/, "").replace(/\.unity3d$/i, "").toLowerCase();
  const direct = SONGS[code];
  if (direct) return { ...direct, variant_of: null };
  const parentCode = SONG_VARIANTS[code];
  const parent = parentCode ? SONGS[parentCode] : null;
  return parent ? { ...parent, variant_of: parentCode } : null;
}

export const SCHEMA_VERSION = 1;

const DEFAULTS = {
  out: "public/data",
  assetsRepo: "kohakunamori/MLTDTranslationAssets",
  clientRepo: "kohakunamori/MLTDTranslationClient",
  ref: "main",
  imageBase: "",
  assetsRoot: "",
  clientRoot: "",
  imageTasks: "",
  generatedAt: "",
  maxRowsPerPage: "",
  // 站点仓（本仓）标识：只作为产物的来源标注，不参与数据读取。
  portalRepo: "kohakunamori/MLTDTranslationPortal",
  portalCommit: "",
};

const ASSETS_MANIFEST = "manifests/portal-resource-manifest.json";
const IMAGE_MANIFEST = "manifests/images.manifest.json";
const CLIENT_ITEMS_MANIFEST = "manifests/bottom-bar.manifest.json";
const ASSET_VERSION_RE = /^[0-9]+$/;
/// 单页行数上限。真实数据里 MD_jp.gtx 有 11.7 万行，整份一个文件会让阅读页卡死。
export const DEFAULT_MAX_ROWS_PER_PAGE = 2000;
const REPO_SPEC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class BuildError extends Error {}

/// 参数错了必须在写盘之前停下：一个拼错的仓库名会让每一条编辑绑定都指向不存在的
/// 仓库，而页面看上去完全正常。
export function validateSettings(settings) {
  for (const key of ["assetsRepo", "clientRepo"]) {
    const value = String(settings[key] || "");
    if (!REPO_SPEC_RE.test(value)) {
      throw new BuildError(`--${key === "assetsRepo" ? "assets-repo" : "client-repo"} 必须是 owner/name 形状，收到 ${JSON.stringify(value)}`);
    }
  }
  const ref = String(settings.ref || "");
  if (!ref || /\s/.test(ref) || ref.includes("..") || ref.startsWith("-")) {
    throw new BuildError(`--ref 不是合法的分支名：${JSON.stringify(ref)}`);
  }
  const imageBase = String(settings.imageBase || "");
  // 留空是正常情况：图片随站点一起发布，地址就是站点内的相对路径。
  if (imageBase && !/^https?:\/\/[^\s]+$/.test(imageBase)) {
    throw new BuildError(`--image-base 必须留空或 http(s) 地址，收到 ${JSON.stringify(imageBase)}`);
  }
  // 站点仓自己的提交：CI 用它判断"线上那份产物是不是当前代码生成的"（跳过逻辑），
  // 空值表示不知道（本地生成），此时不能据此跳过。
  const portalCommit = String(settings.portalCommit || "").trim();
  if (portalCommit && !/^[0-9a-f]{7,40}$/i.test(portalCommit)) {
    throw new BuildError(`--portal-commit 必须是 git 提交 sha，收到 ${JSON.stringify(portalCommit)}`);
  }
  if (settings.generatedAt) {
    const parsed = new Date(String(settings.generatedAt));
    if (Number.isNaN(parsed.getTime()) || !String(settings.generatedAt).includes("T")) {
      throw new BuildError(`--generated-at 必须是 ISO-8601 时间戳，收到 ${JSON.stringify(settings.generatedAt)}`);
    }
  }
  if (!String(settings.out || "").trim()) throw new BuildError("--out 不能为空");
  if (settings.maxRowsPerPage !== "" && settings.maxRowsPerPage !== undefined && settings.maxRowsPerPage !== null) {
    const maxRows = Number(settings.maxRowsPerPage);
    if (!Number.isInteger(maxRows) || maxRows < 1) {
      throw new BuildError(`--max-rows-per-page 必须是正整数，收到 ${JSON.stringify(settings.maxRowsPerPage)}`);
    }
  }
  return settings;
}

// ---------------------------------------------------------------- 小工具

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new BuildError(`${path}: 无法解析 JSON (${error.message})`);
  }
}

function listFiles(root) {
  if (!root || !existsSync(root)) return [];
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found.sort();
}

/// 读一个目录的 git HEAD（CI 里就是克隆到的那次提交）。不是 git 仓库、没装 git、
/// 或者目录不存在时返回空串——上层据此判断"能不能拿它做跳过比对"，绝不猜。
export function gitHeadOf(dir) {
  if (!dir) return "";
  try {
    return execFileSync("git", ["-C", String(dir), "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().toLowerCase();
  } catch {
    return "";
  }
}

function toPosix(path) {
  return path.split("\\").join("/");
}

/// 行状态：与旧 Worker 的 `staticAssetRowStatus` 一致 —— 有译文才可能是 accepted/pending，
/// 没有译文一律 untranslated（旧 status 字段不足以单独成立）。
export function rowStatus(raw, translation) {
  const status = String(raw?.status || "").toLowerCase();
  const hasText = typeof translation === "string" && translation.length > 0;
  if (!hasText) return "untranslated";
  if (status === "accepted") return "accepted";
  if (status === "pending" || status === "needs_review") return "pending";
  return "untranslated";
}

const JAPANESE_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\u3005\u3006]/;
const LATIN_RE = /\p{Script=Latin}/u;
const LETTER_RE = /\p{L}/u;

/// 原文是否"需要译文"。
///
/// 实测：站上 1,066 行"未翻译"**全部**是英文歌词（`Show goes on`、`We are LEGEND DAYS!`、
/// `Make me happy Yeah Yeah Yeah Yeah`……），上游把它们的 `status` 也写成 `untranslated`，
/// 即上游也没有"无需翻译"这个概念 —— 所以这是**本站的判定**：
///   * 原文含假名/汉字 → 需要译文（正常计入未翻译）；
///   * 原文含有非拉丁字母（韩文、西里尔……）→ 需要译文，别把别的语言当成英文放过；
///   * 其余（纯拉丁字母、数字、符号、emoji）→ 不需要译文。
/// 只对**没有译文**的行生效，所以哪天真的给它加了译文，它会自己变成已翻译。
export function sourceNeedsTranslation(source) {
  const text = String(source ?? "");
  if (JAPANESE_RE.test(text)) return true;
  for (const char of text) {
    if (LETTER_RE.test(char) && !LATIN_RE.test(char)) return true;
  }
  return false;
}

/// 展示用的行状态：在 `rowStatus` 基础上多一档 `not_needed`（原文非日文且没有译文）。
export function displayStatus(raw, translation) {
  const status = rowStatus(raw, translation);
  if (status === "untranslated" && !sourceNeedsTranslation(raw?.ja ?? raw?.source)) return "not_needed";
  return status;
}

/// 一个 bundle 内容的文件名。bundle 里允许出现 `.`、`_`、`-`，其余字符转义，
/// 保证同一分类内不会撞名（撞了直接报错，不静默覆盖）。
export function bundleFileBase(bundle) {
  return String(bundle)
    .replace(/\.unity3d$/i, "")
    .replace(/\.json$/i, "")
    .replace(/[^A-Za-z0-9._-]/g, "_");
}

/// 进度：分母是"需要译文的行"（总行数减去 not_needed），避免英文歌词把进度永远压住。
export function progressOf(translated, translatable) {
  if (!(translatable > 0)) return 0;
  return Math.round((translated / translatable) * 10000) / 100;
}

export function assetVersionOf(raw) {
  const declared = String(raw?.asset_version ?? "").trim();
  const legacy = String(raw?.base_version ?? "").trim();
  const value = declared || legacy;
  if (!value) return "";
  if (!ASSET_VERSION_RE.test(value)) {
    throw new BuildError(`非法资产版本轴 ${JSON.stringify(value)}：只接受纯数字，复合版本 9.0.200+1077100 会被拒绝`);
  }
  return value;
}

// ---------------------------------------------------------------- 确定性序列化

/// 顶层一个 key 一行；数组里的对象每个压一行。这样 git diff 是按行可读的，
/// 同时比 2 空格缩进小得多。
export function renderDocument(value) {
  const entries = Object.entries(value);
  const parts = entries.map(([key, item]) => {
    if (Array.isArray(item) && item.length > 0 && item[0] !== null && typeof item[0] === "object") {
      return `  ${JSON.stringify(key)}: [\n${item.map((row) => `    ${JSON.stringify(row)}`).join(",\n")}\n  ]`;
    }
    return `  ${JSON.stringify(key)}: ${JSON.stringify(item)}`;
  });
  return `{\n${parts.join(",\n")}\n}\n`;
}

// ---------------------------------------------------------------- 读上游

/// 读一个仓库里的全部 JSONL，返回按 (bundle, item_key) 归组的行。
/// 身份字段：门户要能唯一定位一行才能改它。真实数据里有两套布局：
///   locales/**  行带 item_key（字符串，如 "85"）
///   lyrics/**   行没有 item_key，身份是 index（数字，如 126）
/// 所以身份字段是**每行读出来的**，随 bundle 记录写进 `identity_field`。
function identityOf(row) {
  for (const field of ["item_key", "index", "slot_index"]) {
    const value = row?.[field];
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "object") continue;
    return { field, value: String(value).trim() };
  }
  return null;
}

/// 计数型警告：真实数据有 40 万行，逐行 warn 会把日志淹掉，所以只报一次总数。
function makeCounter(warnings, template) {
  let count = 0;
  return {
    add: () => { count += 1; },
    flush: () => { if (count > 0) warnings.push(template(count)); },
  };
}

/// 上游有汇总/增量文件：`lyrics/all_lyrics.jsonl` 把 432 首歌词复制了一遍，而
/// `locales/master/official-<version>-untranslated.jsonl` 用**更新的版本**重写了一批
/// 已有行（实测这些行的译文确实更新，比如「继续准备」→「前往巡演准备」）。
/// 所以同一身份出现在多处时：先比 asset_version（新的赢），再比"文件名是不是就是
/// bundle"（是的那份才是能安全回写的权威文件）。
function dedupeRows(rowsByBundle, repoLabel, notes) {
  let dropped = 0;
  let upgraded = 0;
  const droppedByCategory = new Map();
  const droppedByBundle = new Map();
  for (const [bundle, rows] of rowsByBundle) {
    const canonicalBase = String(bundle).replace(/\.json$/i, "");
    const byIdentity = new Map();
    for (const row of rows) {
      const key = `${row.identity_field}\u0000${row.item_key}`;
      const existing = byIdentity.get(key);
      if (!existing) { byIdentity.set(key, row); continue; }
      const rank = (candidate) => [
        candidate.version === null || candidate.version === undefined ? -1 : Number(candidate.version),
        posix.basename(candidate.repo_path).replace(/\.jsonl$/i, "") === canonicalBase ? 1 : 0,
      ];
      const [rowVersion, rowCanonical] = rank(row);
      const [existingVersion, existingCanonical] = rank(existing);
      const better = rowVersion > existingVersion
        || (rowVersion === existingVersion && rowCanonical > existingCanonical)
        || (rowVersion === existingVersion && rowCanonical === existingCanonical && row.repo_path < existing.repo_path);
      const keep = better ? row : existing;
      const drop = better ? existing : row;
      if (keep.source !== drop.source || keep.translation !== drop.translation || keep.status !== drop.status) upgraded += 1;
      dropped += 1;
      droppedByCategory.set(keep.category, (droppedByCategory.get(keep.category) || 0) + 1);
      droppedByBundle.set(keep.bundle || bundle, (droppedByBundle.get(keep.bundle || bundle) || 0) + 1);
      byIdentity.set(key, keep);
    }
    rowsByBundle.set(bundle, [...byIdentity.values()]);
  }
  if (dropped > 0) {
    const files = [...droppedByBundle.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([name, count]) => `${name}(${count})`).join("、");
    notes.push(`${repoLabel}: 同一 item_key 出现在多个文件里的重复副本 ${dropped} 行已去重（保留版本更新/权威文件的那一份；${upgraded} 行内容因此被更新的版本覆盖；集中在 ${files}）`);
  }
  return { dropped, upgraded, droppedByCategory };
}

function readRepoRows({ root, repoLabel, releaseVersion, resolveCategory, warnings, notes }) {
  const rowsByBundle = new Map();
  const files = listFiles(root);
  const newerVersions = new Map();

  const noSource = makeCounter(warnings, (n) => `${repoLabel}: ${n} 行缺少 ja/source，已跳过`);
  const noIdentity = makeCounter(warnings, (n) => `${repoLabel}: ${n} 行没有 item_key/index/slot_index，无法定位，已跳过`);
  const noBundle = makeCounter(warnings, (n) => `${repoLabel}: ${n} 行缺少 bundle 且文件名推不出来，已跳过`);
  const noVersion = makeCounter(warnings, (n) => `${repoLabel}: ${n} 行带 item_key 却没有 asset_version（上游布局变了吗）`);
  const noCategory = makeCounter(warnings, (n) => `${repoLabel}: ${n} 行无法判定分类，已跳过`);
  const delimiter = makeCounter(warnings, (n) => `${repoLabel}: ${n} 行译文含保留分隔符 | 或 ^`);
  const mixedIdentity = makeCounter(warnings, (n) => `${repoLabel}: ${n} 个 bundle 内混用了不同的身份字段，按第一行决定`);

  for (const file of files) {
    const relativePath = toPosix(relative(root, file));
    const fallbackBundle = /\.jsonl$/i.test(relativePath)
      ? posix.basename(relativePath).replace(/\.jsonl$/i, "")
      : "";
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index];
      if (!raw.trim()) continue;
      let row;
      try {
        row = JSON.parse(raw);
      } catch (error) {
        throw new BuildError(`${repoLabel}/${relativePath}:${index + 1}: JSON 解析失败 (${error.message})`);
      }
      const where = `${repoLabel}/${relativePath}:${index + 1}`;

      const ja = typeof row.ja === "string" ? row.ja : typeof row.source === "string" ? row.source : null;
      if (ja === null) { noSource.add(); continue; }
      const zhRaw = typeof row.zh === "string" ? row.zh : typeof row.translation === "string" ? row.translation : null;
      const translation = zhRaw && zhRaw.length > 0 ? zhRaw : null;

      const identity = identityOf(row);
      if (!identity) { noIdentity.add(); continue; }

      const bundle = String(row.bundle ?? fallbackBundle ?? "").trim();
      if (!bundle) { noBundle.add(); continue; }

      // 版本轴：行里的 asset_version 是"这行上次被改动的资源版本"，正常情况下**低于或
      // 等于**当前发布版本（一次发版只会重写改动过的文件）。比发布版本还新说明 checkout
      // 是混合/回滚状态，那种行必须丢掉，否则会把别的版本的译文混进来。
      const version = assetVersionOf(row);
      if (version !== null) {
        if (releaseVersion && Number(version) > Number(releaseVersion)) {
          newerVersions.set(version, (newerVersions.get(version) || 0) + 1);
          continue;
        }
      } else if (identity.field === "item_key" && row.client_version === undefined) {
        noVersion.add();
      }

      const declaredSha = String(row.source_sha256 ?? "").trim().toLowerCase();
      const computedSha = sha256Hex(ja);
      if (declaredSha && declaredSha !== computedSha) {
        throw new BuildError(`${where}: source_sha256 与 ja 不一致（声明 ${declaredSha}，实算 ${computedSha}）`);
      }
      if (translation && (translation.includes("|") || translation.includes("^"))) delimiter.add();

      const resolved = resolveCategory({ bundle, itemKey: identity.value, repoPath: relativePath });
      if (!resolved) { noCategory.add(); continue; }

      const explicitSlot = row.slot_index === null || row.slot_index === undefined || row.slot_index === ""
        ? null
        : Number(row.slot_index);
      const slotFromIdentity = identity.field === "index" && Number.isFinite(Number(identity.value))
        ? Number(identity.value)
        : null;
      const rowEntry = {
        slot_index: Number.isFinite(explicitSlot) ? explicitSlot : slotFromIdentity,
        item_key: identity.value,
        identity_field: identity.field,
        version: version === null ? null : Number(version),
        source: ja,
        translation,
        status: displayStatus(row, translation),
        source_sha256: computedSha,
        category: resolved,
        idol: detectIdol(bundle, identity.value, ja),
        repo_path: relativePath,
        line: index + 1,
      };
      if (!rowsByBundle.has(bundle)) rowsByBundle.set(bundle, []);
      const bucket = rowsByBundle.get(bundle);
      if (bucket.length > 0 && bucket[0].identity_field !== identity.field) mixedIdentity.add();
      bucket.push(rowEntry);
    }
  }

  for (const [version, count] of [...newerVersions.entries()].sort()) {
    warnings.push(`${repoLabel}: 跳过 ${count} 行（asset_version=${version} 比发布版本 ${releaseVersion} 更新，不属于本次发布）`);
  }
  for (const counter of [noSource, noIdentity, noBundle, noVersion, noCategory, delimiter, mixedIdentity]) counter.flush();
  const dedupe = dedupeRows(rowsByBundle, repoLabel, notes);
  return { rowsByBundle, dedupe };
}

/// 行序：只有当每一行都带显式 `slot_index`（且互不相同）时才按槽位排 —— 那是歌词
/// 的真实演唱顺序。其余一律按上游文件的行序，因为剧情/对话的顺序只存在于文件里，
/// 用 item_key 里的数字排会把它打乱。
function orderRows(rows) {
  const explicit = rows.length > 0 && rows.every((row) => row.slot_index !== null);
  const distinct = new Set(rows.map((row) => row.slot_index)).size === rows.length;
  if (explicit && distinct) {
    rows.sort((a, b) => (a.slot_index - b.slot_index) || (a.item_key < b.item_key ? -1 : a.item_key > b.item_key ? 1 : 0));
    return true;
  }
  rows.sort((a, b) => {
    if (a.repo_path !== b.repo_path) return a.repo_path < b.repo_path ? -1 : 1;
    return a.line - b.line;
  });
  return false;
}

/// 一个 bundle 的"代表偶像"：出现次数最多的那位；平票取 code 较小的，保证确定性。
function dominantIdol(rows) {
  const tally = new Map();
  for (const row of rows) {
    if (!row.idol?.code) continue;
    tally.set(row.idol.code, (tally.get(row.idol.code) || 0) + 1);
  }
  let best = null;
  for (const [code, count] of tally) {
    if (!best || count > best.count || (count === best.count && code < best.code)) best = { code, count };
  }
  if (!best) return null;
  const found = rows.find((row) => row.idol?.code === best.code)?.idol;
  return found ? { code: found.code, id: found.id, name_ja: found.name_ja, name_zh: found.name_zh, type: found.type, color: found.color } : null;
}

/// 一个"（分类, bundle）"文件一条索引记录。
///
/// 同一 bundle 的行可以落在不同分类（`event_*` 里对话行是 event_chat、其余是
/// event_story），所以分组键是分类 + bundle，而不是只有 bundle。这样"索引里的行数"
/// 和"文件里的行数"永远是同一个数，阅读页看到的也就是该分类的那一部分。
function buildBundleRecord({ bundle, category, rows, channel, repo, ref, assetVersion, clientVersion, page = null, pageCount = 1, pageOffset = 0, slotBased: givenSlotBased }) {
  const slotBased = givenSlotBased === undefined ? orderRows(rows) : givenSlotBased;
  // 权威写路径：文件名就是 bundle 的那个文件。非权威的（增量文件、汇总文件）只做数据源，
  // 绝不当作写目标 —— 写到 official-<version>-*.jsonl 会把增量文件顶掉。
  const canonicalBase = String(bundle).replace(/\.json$/i, "");
  const pathTally = new Map();
  for (const row of rows) pathTally.set(row.repo_path, (pathTally.get(row.repo_path) || 0) + 1);
  const canonicalPath = rows.find((row) => posix.basename(row.repo_path).replace(/\.jsonl$/i, "") === canonicalBase)?.repo_path
    || [...pathTally.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))[0]?.[0]
    || null;
  const fileBase = bundleFileBase(bundle);
  const file = page === null
    ? `bundles/${category}/${fileBase}.json`
    : `bundles/${category}/${fileBase}.p${page}.json`;
  const record = {
    bundle,
    base: bundle.replace(/\.unity3d$/i, ""),
    file,
    file_base: fileBase,
    page,
    page_count: pageCount,
    first_index: pageOffset + 1,
    last_index: pageOffset + rows.length,
    category,
    domain: CATEGORY_RULES[category].domain,
    channel,
    slot_based: slotBased,
    asset_version: assetVersion || null,
    client_version: clientVersion || null,
    repo_path: canonicalPath,
    total: rows.length,
  };
  const counts = statusCounts(rows.map((row) => ({ status: row.status })));
  record.translated = counts.translated;
  record.pending = counts.pending;
  record.untranslated = counts.untranslated;
  // 原文非日文且没有译文的行：既不算已翻译也不算未翻译，进度分母里也要扣掉，
  // 否则"全英文歌词"会让进度永远差一截（真实数据里就是这 1,066 行）。
  record.not_needed = counts.not_needed;
  record.idol = dominantIdol(rows);
  const song = channel === "assets" ? songFor(bundle) : null;
  if (song) {
    record.song = {
      name_ja: song.name_ja || record.base,
      name_zh: song.name_zh || "",
      type: song.type || "All",
      mst_song_id: song.mst_song_id || 0,
      variant_of: song.variant_of || null,
    };
  }
  record.edit = {
    kind: channel === "client" ? "manifest" : "jsonl",
    repo,
    ref,
    path: canonicalPath,
    // 写入时用哪个上游字段定位这一行：locales 行是 item_key，歌词行是 index。
    identity_field: rows[0]?.identity_field || "item_key",
  };
  return { record, rows, slotBased, pageOffset, canonicalPath };
}

/// 把一个 (分类, bundle) 的行切成页。
///
/// 真实数据里有 5 个巨型 bundle：MD_jp.gtx 一个就 11.7 万行（41 MB 的 JSON），
/// CM/CD/MB/ST 也都在 1 万行以上。整份塞进一个文件会让阅读页直接卡死，所以超过
/// `maxRows` 就按页切开，页号后缀 `.p1`、`.p2`…，索引里同时给出每一页的文件与计数。
function splitIntoPages(rows, maxRows) {
  if (rows.length <= maxRows) return [rows];
  const pages = [];
  for (let start = 0; start < rows.length; start += maxRows) pages.push(rows.slice(start, start + maxRows));
  return pages;
}
function groupIntoFiles(rowsByBundle, meta) {
  const files = [];
  for (const [bundle, rows] of [...rowsByBundle.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const byCategory = new Map();
    for (const row of rows) {
      if (!byCategory.has(row.category)) byCategory.set(row.category, []);
      byCategory.get(row.category).push(row);
    }
    for (const [category, scoped] of [...byCategory.entries()].sort((a, b) => CATEGORY_ORDER.indexOf(a[0]) - CATEGORY_ORDER.indexOf(b[0]))) {
      // 先排序再切页：否则页边界会落在未排序的顺序上，翻页看到的行号就不是连续的槽位序。
      const slotBased = orderRows(scoped);
      const pages = splitIntoPages(scoped, meta.maxRowsPerPage || DEFAULT_MAX_ROWS_PER_PAGE);
      let offset = 0;
      pages.forEach((pageRows, index) => {
        files.push(buildBundleRecord({
          bundle, category, rows: pageRows, pageOffset: offset, slotBased,
          page: pages.length === 1 ? null : index + 1, pageCount: pages.length, ...meta,
        }));
        offset += pageRows.length;
      });
    }
  }
  return files;
}

// ---------------------------------------------------------------- 图片任务

/// 真实的上游图片清单（`manifests/images.manifest.json`）形状：
///   { counts:{total_images}, images: [{ id, kind, bundle, texture_path_id,
///                dimensions:{width,height}, original:{relative_path,sha256},
///                localized:{relative_path,sha256}, distribution:{...}, review_status }] }
///
/// 实测过的两件事决定了这里怎么写：
///   1. 清单里的 `distribution.*.url_template`（`images/<sha>.png`）在公开对象存储上
///      **404**，所以永远不要拿它当图片地址；
///   2. 仓库里**只有** `images/localized/<bundle>/*.png`（937 个文件、333 MB），
///      日文原图没有发布，因此不存在"原图 vs 中文版"的对比。
/// 所以：中文版图片由 CI 复制到站点的 `media/` 下，这里只记站点内相对路径。
function normalizeImageTasks(payload, { imageBase, warnings, notes }) {
  let tasks = [];
  if (Array.isArray(payload)) tasks = payload;
  else if (Array.isArray(payload?.images)) tasks = payload.images;
  else if (Array.isArray(payload?.tasks)) tasks = payload.tasks;
  else throw new BuildError("图片清单里找不到 images/tasks 数组");

  const unknownCategory = makeCounter(warnings, (n) => `images: ${n} 个任务的 bundle 名判不出分类，按 event 归类`);
  const missingLocalized = makeCounter(notes, (n) => `images: ${n} 个任务没有中文版文件（上游只发布了中文版，这属于异常）`);
  const base = String(imageBase || "").replace(/\/+$/, "");

  const seen = new Set();
  const normalized = [];
  for (const task of tasks) {
    const taskId = String(task?.task_id ?? task?.id ?? "").trim();
    if (!taskId) {
      warnings.push("图片任务缺少 task_id，已跳过");
      continue;
    }
    if (seen.has(taskId)) {
      warnings.push(`图片任务 ${taskId} 重复，已跳过后一条`);
      continue;
    }
    seen.add(taskId);

    const bundle = String(task.bundle || "");
    let category = detectImageCategory(bundle);
    if (!category) { unknownCategory.add(); category = "event"; }

    const localizedPath = String(task?.localized?.relative_path || "").trim();
    const localizedSha = String(task?.localized?.sha256 || "").trim().toLowerCase();
    const originalPath = String(task?.original?.relative_path || "").trim();
    const originalSha = String(task?.original?.sha256 || "").trim().toLowerCase();
    // `images/localized/<bundle>/x.png` → `media/localized/<bundle>/x.png`
    const mediaUrl = localizedPath ? `${base ? `${base}/` : ""}media/${localizedPath.replace(/^images\//, "")}` : null;
    if (!mediaUrl) missingLocalized.add();

    normalized.push({
      task_id: taskId,
      bundle,
      kind: String(task.kind || ""),
      category,
      category_name: `${IMAGE_CATEGORY_RULES[category].icon} ${IMAGE_CATEGORY_RULES[category].name}`,
      width: Number(task?.dimensions?.width ?? task?.width) || 0,
      height: Number(task?.dimensions?.height ?? task?.height) || 0,
      localized_path: localizedPath || null,
      localized_url: mediaUrl,
      localized_file: localizedPath ? posix.basename(localizedPath) : null,
      localized_sha256: localizedSha || null,
      // 日文原图只在清单里留有路径与哈希，仓库与对象存储都没有可下载的字节。
      original_path: originalPath || null,
      original_sha256: originalSha || null,
      original_published: false,
      has_localized: Boolean(mediaUrl),
      review_status: String(task.review_status || ""),
    });
  }
  normalized.sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0));
  unknownCategory.flush();
  missingLocalized.flush();

  const categories = { all: normalized.length };
  for (const id of IMAGE_CATEGORY_ORDER) categories[id] = 0;
  const statuses = { all: normalized.length, localized: 0, original_only: 0 };
  for (const task of normalized) {
    categories[task.category] += 1;
    statuses[task.has_localized ? "localized" : "original_only"] += 1;
  }
  return { total: normalized.length, categories, statuses, tasks: normalized };
}

// ---------------------------------------------------------------- 主流程

function parseArgs(argv) {
  const options = { ...DEFAULTS, check: false, strict: false };
  const flags = {
    "--out": "out",
    "--assets-root": "assetsRoot",
    "--client-root": "clientRoot",
    "--assets-repo": "assetsRepo",
    "--client-repo": "clientRepo",
    "--ref": "ref",
    "--image-base": "imageBase",
    "--image-tasks": "imageTasks",
    "--generated-at": "generatedAt",
    "--max-rows-per-page": "maxRowsPerPage",
    "--portal-commit": "portalCommit",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") { options.check = true; continue; }
    if (arg === "--strict") { options.strict = true; continue; }
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    const key = flags[arg];
    if (!key) throw new BuildError(`未知参数 ${arg}`);
    const value = argv[index + 1];
    if (value === undefined) throw new BuildError(`${arg} 需要一个值`);
    options[key] = value;
    index += 1;
  }
  return options;
}

export function buildOutputs(options = {}, sink = collectingSink()) {
  const settings = validateSettings({ ...DEFAULTS, ...options });
  const warnings = [];
  // notes 是"数据本来就这样"的说明，不算异常；--strict 只把 warnings 当失败。
  const notes = [];

  if (!settings.assetsRoot && !settings.clientRoot && !settings.imageTasks) {
    throw new BuildError("至少需要 --assets-root / --client-root / --image-tasks 之一");
  }

  // ---- assets 轴
  const assetsManifest = settings.assetsRoot && existsSync(join(settings.assetsRoot, ASSETS_MANIFEST))
    ? readJsonFile(join(settings.assetsRoot, ASSETS_MANIFEST))
    : null;
  if (settings.assetsRoot && !assetsManifest) warnings.push(`assets: 找不到 ${ASSETS_MANIFEST}，版本轴标识与 pin 将为空`);
  const assetsRelease = assetsManifest?.release || null;
  const assetVersion = String(assetsRelease?.asset_version || "").trim();
  const assetsCommit = String(assetsRelease?.assets_commit || assetsManifest?.source?.commit || "").trim();

  // 上游清单里的 categories[].bundles 是"bundle → 分类"的权威映射（1.1 万条），
  // 比按名字猜准得多；猜出来的规则只用于清单里没有的 bundle。
  const bundleCategory = new Map();
  if (Array.isArray(assetsManifest?.categories)) {
    for (const category of assetsManifest.categories) {
      for (const bundle of Object.keys(category?.bundles || {})) {
        if (!bundleCategory.has(bundle)) bundleCategory.set(bundle, String(category.id || ""));
      }
    }
  }
  if (settings.assetsRoot && bundleCategory.size === 0) {
    warnings.push("assets: 清单里没有 categories[].bundles，bundle→分类只能靠名字规则猜");
  }
  const ruleMismatch = makeCounter(warnings, (n) => `assets: ${n} 个 bundle 的名字规则与清单分类不一致，以清单为准`);
  const unknownBundle = makeCounter(warnings, (n) => `assets: ${n} 行的 bundle 既不在清单里、也判不出分类，已跳过`);
  const ruleJudgedBundles = new Set();

  const resolveCategory = ({ bundle, itemKey }) => {
    // 清单的键是去掉了 .unity3d / .json 的 bundle 基名。
    const base = String(bundle).replace(/\.unity3d$/i, "").replace(/\.json$/i, "");
    const fromManifest = bundleCategory.get(base) || bundleCategory.get(bundle) || null;
    const fromRule = categoryId(bundle, itemKey);
    if (fromManifest) {
      if (fromRule && fromRule !== fromManifest) ruleMismatch.add();
      return CATEGORY_RULES[fromManifest] ? fromManifest : null;
    }
    if (!fromRule) { unknownBundle.add(); return null; }
    ruleJudgedBundles.add(base);
    return fromRule;
  };

  let imagePayload = null;
  if (settings.imageTasks) {
    imagePayload = readJsonFile(settings.imageTasks);
  } else if (settings.assetsRoot && existsSync(join(settings.assetsRoot, IMAGE_MANIFEST))) {
    imagePayload = readJsonFile(join(settings.assetsRoot, IMAGE_MANIFEST));
  } else if (settings.assetsRoot) {
    warnings.push(`assets: 找不到 ${IMAGE_MANIFEST}，图片索引为空`);
  }

  const bundles = [];
  let assetsDedupe = null;
  if (settings.assetsRoot) {
    const assetsRead = readRepoRows({
      root: settings.assetsRoot,
      repoLabel: "assets",
      releaseVersion: assetVersion,
      resolveCategory,
      warnings,
      notes,
    });
    assetsDedupe = assetsRead.dedupe;
    bundles.push(...groupIntoFiles(assetsRead.rowsByBundle, {
      channel: "assets",
      repo: settings.assetsRepo,
      ref: settings.ref,
      assetVersion,
      maxRowsPerPage: settings.maxRowsPerPage,
    }));
  }
  ruleMismatch.flush();
  unknownBundle.flush();
  if (ruleJudgedBundles.size > 0) {
    notes.push(`assets: ${ruleJudgedBundles.size} 个 bundle 不在清单 categories[].bundles 里（歌词 + 少量历史 bundle），分类按名字规则判定`);
  }

  // ---- client 轴：底栏清单本身就是一个 bundle
  const clientManifest = settings.clientRoot && existsSync(join(settings.clientRoot, ASSETS_MANIFEST))
    ? readJsonFile(join(settings.clientRoot, ASSETS_MANIFEST))
    : null;
  if (settings.clientRoot && !clientManifest) warnings.push(`client: 找不到 ${ASSETS_MANIFEST}，版本轴标识与 pin 将为空`);
  const clientRelease = clientManifest?.release || null;
  const clientVersion = String(clientRelease?.client_version || "").trim();
  let clientRows = [];
  if (settings.clientRoot && existsSync(join(settings.clientRoot, CLIENT_ITEMS_MANIFEST))) {
    const items = readJsonFile(join(settings.clientRoot, CLIENT_ITEMS_MANIFEST));
    const slots = Array.isArray(items?.slots) ? items.slots : [];
    slots.forEach((slot, index) => {
      const ja = typeof slot?.ja === "string" ? slot.ja : "";
      if (!ja) {
        warnings.push(`client/${CLIENT_ITEMS_MANIFEST}: 槽位 ${index} 缺少 ja，已跳过`);
        return;
      }
      const zh = typeof slot?.zh === "string" && slot.zh.length > 0 ? slot.zh : null;
      const manifestIndex = Number.isInteger(slot?.index) ? slot.index : index;
      clientRows.push({
        slot_index: Number.isFinite(manifestIndex) ? manifestIndex : index,
        item_key: String(manifestIndex),
        source: ja,
        translation: zh,
        status: zh ? "accepted" : "untranslated",
        source_sha256: sha256Hex(ja),
        category: "system_ui",
        idol: null,
        repo_path: CLIENT_ITEMS_MANIFEST,
        line: index + 1,
        manifest_index: manifestIndex,
      });
    });
    if (slots.length === 0) warnings.push(`client: ${CLIENT_ITEMS_MANIFEST} 没有 slots`);
  } else if (settings.clientRoot) {
    warnings.push(`client: 找不到 ${CLIENT_ITEMS_MANIFEST}，底栏清单为空`);
  }
  if (clientRows.length > 0) {
    bundles.push(...groupIntoFiles(new Map([[CLIENT_ITEMS_MANIFEST, clientRows]]), {
      channel: "client",
      repo: settings.clientRepo,
      ref: settings.ref,
      clientVersion,
    }));
  }

  // ---- 汇总。注意 `bundles` 数的是**唯一资源**，`files` 数的是落盘文件：巨型
  // bundle 会被切成多页，所以两者不再相等。
  const categoryCounts = new Map(CATEGORY_ORDER.map((id) => [id, { bundles: 0, files: 0, total: 0, translated: 0, not_needed: 0 }]));
  const seenBundleKeys = new Set();
  // 对账只跟 assets 轴比：客户端底栏清单不属于 assets 清单的统计范围。
  const assetsCategoryRows = new Map(CATEGORY_ORDER.map((id) => [id, 0]));
  const domainCounts = new Map(DOMAIN_ORDER.map((id) => [id, { total: 0, translated: 0, not_needed: 0 }]));
  let total = 0;
  let translated = 0;
  let pending = 0;
  let untranslated = 0;
  let notNeeded = 0;
  for (const { record } of bundles) {
    const bucket = categoryCounts.get(record.category);
    if (!bucket) throw new BuildError(`未知分类 ${record.category}（bundle ${record.bundle}）`);
    const bundleKey = `${record.category}\u0000${record.bundle}`;
    if (!seenBundleKeys.has(bundleKey)) {
      seenBundleKeys.add(bundleKey);
      bucket.bundles += 1;
    }
    bucket.files += 1;
    bucket.total += record.total;
    bucket.translated += record.translated;
    bucket.not_needed += record.not_needed || 0;
    if (record.channel === "assets") assetsCategoryRows.set(record.category, assetsCategoryRows.get(record.category) + record.total);
    const domainBucket = domainCounts.get(record.domain);
    domainBucket.total += record.total;
    domainBucket.translated += record.translated;
    domainBucket.not_needed += record.not_needed || 0;
    total += record.total;
    translated += record.translated;
    pending += record.pending;
    untranslated += record.untranslated;
    notNeeded += record.not_needed || 0;
  }

  const images = imagePayload ? normalizeImageTasks(imagePayload, {
    imageBase: settings.imageBase,
    warnings,
    notes,
  }) : {
    total: 0,
    categories: { all: 0, ...Object.fromEntries(IMAGE_CATEGORY_ORDER.map((id) => [id, 0])) },
    statuses: { all: 0, localized: 0, original_only: 0 },
    tasks: [],
  };

  // ---- 与上游清单对账：清单自己带每个分类的行数，对不上说明版本轴或分类判定错了。
  // 这正是之前"只留下 1840 行"那类静默丢数据问题唯一能被自动抓住的地方。
  //
  // 去重掉的行要减掉：清单是按"文件里有多少行"统计的，而同一 item_key 在汇总文件和
  // 权威文件里各有一份，门户只保留一份，所以差值是预期的，不该报成异常。
  if (Array.isArray(assetsManifest?.categories)) {
    const droppedByCategory = assetsDedupe?.droppedByCategory || new Map();
    for (const category of assetsManifest.categories) {
      const id = String(category?.id || "");
      if (!categoryCounts.has(id)) {
        if (Number(category?.total) > 0) warnings.push(`对账：清单里有分类 ${id}，本生成器不认识，其 ${category.total} 行没有产出`);
        continue;
      }
      const computed = assetsCategoryRows.get(id) || 0;
      const expected = Number(category.total) - (droppedByCategory.get(id) || 0);
      if (Number.isFinite(Number(category.total)) && computed !== expected) {
        warnings.push(`对账：分类 ${id} 行数不一致 —— 生成 ${computed}，清单 ${category.total}（去重 ${droppedByCategory.get(id) || 0} 行后应为 ${expected}）`);
      }
    }
    // 总账按"清单列出的分类逐个加回来"比：清单的 totals 不含歌词（歌词不在任何
    // categories[] 里），直接拿生成总数比会永远差一个歌词的行数。
    if (Number.isFinite(Number(assetsManifest?.totals?.total))) {
      const manifestTotal = Number(assetsManifest.totals.total);
      const droppedByCategory = assetsDedupe?.droppedByCategory || new Map();
      let accounted = 0;
      for (const category of assetsManifest.categories) {
        const id = String(category?.id || "");
        accounted += (assetsCategoryRows.get(id) || 0) + (droppedByCategory.get(id) || 0);
      }
      if (accounted !== manifestTotal) {
        warnings.push(`对账：assets 轴总行数不一致 —— 清单列出的分类合计 ${accounted}（含去重 ${assetsDedupe?.dropped || 0} 行），清单 totals 是 ${manifestTotal}`);
      }
    }
  }
  if (imagePayload && Number.isFinite(Number(imagePayload?.counts?.total_images))) {
    if (images.total !== Number(imagePayload.counts.total_images)) {
      warnings.push(`对账：图片数不一致 —— 生成 ${images.total}，清单 ${imagePayload.counts.total_images}`);
    }
  }

  const generatedAt = settings.generatedAt
    || process.env.SOURCE_DATE_EPOCH && new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")
    || new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  // 曲名覆盖自检：歌词分类里凡是没有解析出曲名的曲目束都报出来。上游每次批量发现
  // 新资源都可能带进新的扩展版本，抓包没跟上时就靠这条提醒。
  const unnamedSongs = bundles
    .filter(({ record }) => record.category === "lyrics" && record.channel === "assets" && !record.song)
    .map(({ record }) => record.base.replace(/\.unity3d$/i, ""));
  if (unnamedSongs.length > 0) {
    warnings.push(`有 ${unnamedSongs.length} 个曲目束没有曲名（曲名表与抓包对照里都查不到）：${unnamedSongs.slice(0, 8).join("、")}${unnamedSongs.length > 8 ? " 等" : ""}`);
  }

  const portal = {
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt,
    image_base: String(settings.imageBase || "").replace(/\/+$/, ""),
    sources: {
      assets: { repo: settings.assetsRepo, ref: settings.ref, commit: assetsCommit, head: gitHeadOf(settings.assetsRoot), manifest_generated_at: String(assetsManifest?.generated_at || "") },
      client: { repo: settings.clientRepo, ref: settings.ref, commit: String(clientRelease?.client_resources_commit || ""), head: gitHeadOf(settings.clientRoot), manifest_generated_at: String(clientManifest?.generated_at || "") },
      // 站点仓自己的提交。CI 的"要不要重建"判断靠它：线上 portal.json 里记的
      // portal.commit 等于本次要部署的提交、且两个上游 commit 也没变 → 直接跳过。
      portal: { repo: DEFAULTS.portalRepo, commit: String(settings.portalCommit || "") || gitHeadOf(".") },
    },
    releases: {
      assets: assetsRelease ? {
        release_id: String(assetsRelease.release_id || ""),
        asset_version: assetVersion,
        status: String(assetsRelease.status || ""),
        updated_at: String(assetsRelease.updated_at || ""),
      } : null,
      client: clientRelease ? {
        release_id: String(clientRelease.release_id || ""),
        client_version: clientVersion,
        abi: String(clientRelease.abi || ""),
        status: String(clientRelease.status || ""),
        updated_at: String(clientRelease.updated_at || ""),
      } : null,
    },
    totals: {
      total,
      translated,
      pending,
      untranslated,
      // 原文非日文且没有译文（英文歌词）：不是"待翻译"，从进度分母里扣掉。
      not_needed: notNeeded,
      bundles: seenBundleKeys.size,
      files: bundles.length,
      progress_percent: progressOf(translated, total - notNeeded),
    },
    domains: DOMAIN_ORDER.map((id) => ({
      id,
      name: DOMAIN_META[id].name,
      icon: DOMAIN_META[id].icon,
      total: domainCounts.get(id).total,
      translated: domainCounts.get(id).translated,
      not_needed: domainCounts.get(id).not_needed,
    })),
    categories: CATEGORY_ORDER.map((id) => ({
      id,
      domain: CATEGORY_RULES[id].domain,
      name: CATEGORY_RULES[id].name,
      icon: CATEGORY_RULES[id].icon,
      unit: CATEGORY_RULES[id].unit,
      entry: CATEGORY_RULES[id].entry,
      bundles: categoryCounts.get(id).bundles,
      files: categoryCounts.get(id).files,
      total: categoryCounts.get(id).total,
      translated: categoryCounts.get(id).translated,
      not_needed: categoryCounts.get(id).not_needed,
    })),
    image_categories: IMAGE_CATEGORY_ORDER.map((id) => ({
      id,
      name: `${IMAGE_CATEGORY_RULES[id].icon} ${IMAGE_CATEGORY_RULES[id].name}`,
      count: images.categories[id] || 0,
    })),
    image_statuses: images.statuses,
  };

  sink.put("portal.json", renderDocument(portal));

  /// 每一页都是一个落盘文件，但索引里一个 bundle 只出现一次：多页的 bundle 由
  /// `pages[]` 描述（阅读页据此翻页），计数是全 bundle 的合计。
  const catalogueEntries = new Map();
  for (const { record } of bundles) {
    const key = `${record.category}\u0000${record.bundle}`;
    let entry = catalogueEntries.get(key);
    if (!entry) {
      const { file_base: _fileBase, page: _page, page_count: _pageCount, first_index: _first, last_index: _last, total: _total, translated: _translated, pending: _pending, untranslated: _untranslated, not_needed: _notNeeded, ...rest } = record;
      entry = { ...rest, total: 0, translated: 0, pending: 0, untranslated: 0, not_needed: 0, page_count: record.page_count, pages: [] };
      catalogueEntries.set(key, entry);
    }
    entry.total += record.total;
    entry.translated += record.translated;
    entry.pending += record.pending;
    entry.untranslated += record.untranslated;
    entry.not_needed += record.not_needed || 0;
    entry.pages.push({
      file: record.file,
      page: record.page,
      first_index: record.first_index,
      last_index: record.last_index,
      total: record.total,
      translated: record.translated,
      pending: record.pending,
      untranslated: record.untranslated,
      not_needed: record.not_needed || 0,
    });
  }

  for (const category of CATEGORY_ORDER) {
    const rows = [...catalogueEntries.values()].filter((entry) => entry.category === category);
    sink.put(`catalogue/${category}.json`, renderDocument({
      category,
      name: CATEGORY_RULES[category].name,
      domain: CATEGORY_RULES[category].domain,
      total_bundles: rows.length,
      bundles: rows,
    }));
  }

  const emitted = new Set();
  for (const { record, rows, slotBased } of bundles) {
    const file = record.file;
    if (emitted.has(file)) throw new BuildError(`两个 bundle 生成了同一个文件 ${file}`);
    emitted.add(file);
    sink.put(file, renderDocument({
      bundle: record.bundle,
      base: record.base,
      channel: record.channel,
      category: record.category,
      domain: record.domain,
      slot_based: slotBased,
      asset_version: record.asset_version,
      client_version: record.client_version,
      repo_path: record.repo_path,
      edit: record.edit,
      song: record.song || null,
      idol: record.idol || null,
      page: record.page,
      page_count: record.page_count,
      first_index: record.first_index,
      last_index: record.last_index,
      total_lines: rows.length,
      translated: record.translated,
      pending: record.pending,
      untranslated: record.untranslated,
      not_needed: record.not_needed || 0,
      lines: rows.map((row, index) => ({
        // index 是**整个 bundle** 内的行号（跨页连续），阅读页靠它定位"第 N 行"。
        index: record.first_index + index,
        slot_index: row.slot_index,
        item_key: row.item_key,
        source: row.source,
        translation: row.translation,
        status: row.status,
        source_sha256: row.source_sha256,
        line: row.line,
        ...(row.category === record.category ? {} : { category: row.category }),
        // 少见的行：这一行实际住在另一个上游文件里（比如增量文件覆盖过的行），
        // 写它必须写到那个文件，而不是文件级的权威路径。
        ...(row.repo_path === record.edit.path ? {} : { edit_path: row.repo_path }),
        ...(row.manifest_index === undefined ? {} : { manifest_index: row.manifest_index }),
      })),
    }));
  }

  sink.put("images.json", renderDocument(images));

  return { files: sink.files, fileCount: sink.count(), warnings, notes, portal };
}

// ---------------------------------------------------------------- 产出汇 / 写盘

/// 生成器每完成一个文件就交给"汇"，不再把 174 MB 产出全堆在内存里——那是
/// 峰值 815 MB 的主因，而目标机器（1 核 / 1.4 GB 且已跑满服务）扛不住。
/// 三种汇的对外形状一样：`put(路径, 内容)` + `count()`，只有收集型带 `files`。
function collectingSink() {
  const files = new Map();
  return {
    files,
    put: (relativePath, content) => files.set(relativePath, content),
    count: () => files.size,
  };
}

function writingSink(outDir) {
  let written = 0;
  return {
    files: null,
    put(relativePath, content) {
      const full = join(outDir, relativePath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, "utf8");
      written += 1;
    },
    count: () => written,
  };
}

/// `--check` 的汇：逐文件比对，只记住"磁盘上还有哪些没被认领"，不保留内容。
function compareSink(outDir) {
  const drift = [];
  const onDisk = existingFiles(outDir);
  let seen = 0;
  return {
    files: null,
    put(relativePath, content) {
      seen += 1;
      const full = onDisk.get(relativePath);
      if (!full) {
        drift.push(`缺失 ${relativePath}`);
        return;
      }
      const actual = readFileSync(full, "utf8");
      if (comparable(actual, relativePath) !== comparable(content, relativePath)) drift.push(`内容不同 ${relativePath}`);
      onDisk.delete(relativePath);
    },
    count: () => seen,
    finish() {
      for (const leftover of onDisk.keys()) drift.push(`多余 ${leftover}`);
      return drift.sort();
    },
  };
}

/// 生成物先写进暂存目录，全部成功后再整体换到目标位置。同一文件系统内的 rename
/// 是原子的，所以中途失败时原有数据一个字节都不会动（以前是"先删再写"，失败会
/// 留下半份产出——生成搬到服务器上之后，那等于让站点直接读到坏数据）。
function swapIntoPlace(outDir, staging) {
  const previous = `${outDir}.previous`;
  rmSync(previous, { recursive: true, force: true });
  const hadPrevious = existsSync(outDir);
  if (hadPrevious) renameSync(outDir, previous);
  try {
    renameSync(staging, outDir);
  } catch (error) {
    if (hadPrevious) renameSync(previous, outDir);
    throw error;
  }
  rmSync(previous, { recursive: true, force: true });
}

/// 上一次运行被中断时，暂存目录会留在产物旁边；每次动手前先清掉，
/// 免得多余目录被 Pages 或自托管站点一起发布出去。
function clearStaleStaging(outDir) {
  const parent = dirname(outDir);
  const base = basename(outDir);
  if (!existsSync(parent)) return;
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === `${base}.staging` || entry.name === `${base}.previous`) {
      rmSync(join(parent, entry.name), { recursive: true, force: true });
    }
  }
}

function existingFiles(outDir) {
  const found = new Map();
  if (!existsSync(outDir)) return found;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".json")) found.set(toPosix(relative(outDir, full)), full);
    }
  };
  walk(outDir);
  return found;
}

/// `generated_at` 是唯一允许变化的字段：比对时把它抹平，否则每天都会"漂移"。
function comparable(content, relativePath) {
  if (relativePath !== "portal.json") return content;
  return content.replace(/"generated_at": "[^"]*"/, '"generated_at": "<ignored>"');
}

const HELP = `门户静态数据生成器

  node scripts/build_data.mjs [选项]

  --assets-root <dir>     翻译资源仓库 checkout（locales/ lyrics/ manifests/）
  --client-root <dir>     客户端仓库 checkout（manifests/）
  --image-tasks <file>    图片任务清单 JSON（缺省用 assets 仓的 ${IMAGE_MANIFEST}）
  --out <dir>             输出目录，默认 ${DEFAULTS.out}
  --assets-repo <o/r>     资源仓标识，默认 ${DEFAULTS.assetsRepo}
  --client-repo <o/r>     客户端仓标识，默认 ${DEFAULTS.clientRepo}
  --ref <name>            写路径使用的分支，默认 ${DEFAULTS.ref}
  --image-base <url>      图片对象基址（留空=随站点发布的 media/ 相对路径）
  --generated-at <iso>    固定 generated_at（测试与可复现构建用）
  --portal-commit <sha>   本仓提交，写进 sources.portal.commit（CI 的跳过判断靠它）
  --check                 只比对磁盘现状，不写入；有漂移时退出码 2
  --strict                把警告升级为失败
`;

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${HELP}`);
    return 1;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  /// 写模式下产出先落在暂存目录；比对模式不碰磁盘。
  const staging = options.check ? null : `${options.out}.staging`;
  let sink;
  try {
    if (options.check) {
      sink = compareSink(options.out);
    } else {
      clearStaleStaging(options.out);
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      sink = writingSink(staging);
    }
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    return 1;
  }

  let result;
  try {
    result = buildOutputs(options, sink);
  } catch (error) {
    if (staging) rmSync(staging, { recursive: true, force: true });
    process.stderr.write(`error: ${error.message}\n`);
    return 1;
  }

  for (const warning of result.warnings) process.stderr.write(`warn: ${warning}\n`);
  if (options.strict && result.warnings.length > 0) {
    if (staging) rmSync(staging, { recursive: true, force: true });
    process.stderr.write(`error: --strict 下不允许警告（${result.warnings.length} 条）\n`);
    return 1;
  }
  for (const note of result.notes || []) process.stderr.write(`note: ${note}\n`);

  if (options.check) {
    const drift = sink.finish();
    for (const line of drift) process.stderr.write(`drift: ${line}\n`);
    process.stdout.write(`检查 ${result.fileCount} 个文件，漂移 ${drift.length} 处\n`);
    return drift.length === 0 ? 0 : 2;
  }

  try {
    swapIntoPlace(options.out, staging);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    process.stderr.write(`error: 产出替换失败 ${error.message}\n`);
    return 1;
  }
  process.stdout.write(
    `写出 ${result.fileCount} 个文件到 ${options.out}：` +
    `${result.portal.totals.bundles} 个 bundle / ${result.portal.totals.total} 行 / ` +
    `已译 ${result.portal.totals.translated} / 图片 ${result.portal.image_statuses?.all || 0}\n`
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
