// 从 MLTDLocalServer 的抓包（内容覆盖层）里导出「扩展版本 → 主曲目」对照。
//
// 背景：游戏里同一首歌会挂多个资源包。主包（如 scrobj_flyers.unity3d）在抓包的
// local_content.songs[] 里带正式曲名；扩展版本（如 scrobj_flye39.unity3d、
// scrobj_ahhan+.unity3d）挂在同一首歌的 policy.song.extend_song_status_list 里，
// 自己不带曲名。门户原来只按资源名精确查表，扩展版本就查不到名字、页面只能显示代号。
//
// 这个脚本把抓包里的父子关系导出成 public/lib/song-variants.json，交给生成器使用。
// 抓包更新后重跑一次即可：
//
//   node scripts/import_song_names.mjs                    # 用默认路径找抓包
//   node scripts/import_song_names.mjs --overlay <路径>   # 指定抓包文件
//   node scripts/import_song_names.mjs --check            # 只检查不写入
//
// 找不到抓包不会报错退出，只会提醒——生成器仍然能用已有的对照文件工作。

import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SONG_MASTER, SONG_MASTER_EXTRA, SONG_VARIANT_OVERRIDES } from "../public/lib/terms.js";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "public", "lib", "song-variants.json");

/// 抓包文件可能在这些位置（按顺序找第一个存在的）。
const CANDIDATES = [
  process.env.MLTD_OVERLAY,
  "D:/Project/MLTDLocalServer/local-data/work/agents/server/repo-simplification-b3-checkout-20261002/isolated-copy/runtime/content-overlay.json",
  "D:/Project/MLTDLocalServer/runtime/content-overlay.json",
].filter(Boolean);

function parseArgs(argv) {
  const options = { overlay: null, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--overlay") options.overlay = argv[i + 1];
    else if (argv[i] === "--check") options.check = true;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const overlayPath = options.overlay
  ? resolve(options.overlay)
  : CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;

const known = { ...SONG_MASTER, ...SONG_MASTER_EXTRA };

if (!overlayPath || !existsSync(overlayPath)) {
  console.log("[导入曲名] 没找到抓包文件，跳过。");
  console.log("  手动指定：node scripts/import_song_names.mjs --overlay <content-overlay.json>");
  console.log(`  已有的对照文件：${existsSync(outPath) ? "有" : "没有"}`);
  if (!existsSync(outPath)) {
    console.log("  既没有对照文件也没抓到包，生成器会退回“精确查表”的老行为。");
  }
  process.exit(0);
}

const doc = JSON.parse(readFileSync(overlayPath, "utf8"));
const songs = doc?.local_content?.songs;
if (!Array.isArray(songs)) throw new Error(`抓包里没有 local_content.songs[]：${overlayPath}`);

const canonical = new Map();
const variants = new Map();
for (const song of songs) {
  const resourceId = song?.master?.resource_id;
  const name = song?.current_catalog?.name;
  if (typeof resourceId === "string" && typeof name === "string" && name !== "") {
    canonical.set(resourceId, { name, mst_song_id: song?.master?.mst_song_id ?? 0 });
  }
  const list = song?.policy?.song?.extend_song_status_list;
  if (!Array.isArray(list)) continue;
  for (const item of list) {
    const id = item?.resource_id;
    if (typeof id !== "string" || id === "") continue;
    if (canonical.has(id)) continue; // 主曲目优先：它自己带名字
    variants.set(id, resourceId);
  }
}

// 手工补充的对照优先（抓包版本落后时用得上）
for (const [variant, parent] of Object.entries(SONG_VARIANT_OVERRIDES)) {
  if (!variants.has(variant)) variants.set(variant, parent);
}

// —— 一致性检查：抓包与门户的表对得上吗 ——
const missingInTable = [...canonical.keys()].filter((id) => !known[id]);
const missingInCapture = Object.keys(known).filter((id) => !canonical.has(id));
const nameMismatch = [...canonical.entries()]
  .filter(([id, info]) => known[id] && known[id].name_ja !== info.name)
  .map(([id, info]) => `${id}: 表里「${known[id].name_ja}」 抓包「${info.name}」`);

console.log(`[导入曲名] 抓包：${overlayPath}`);
console.log(`  抓包版本: app ${doc?.source?.target_version ?? "?"}  文件时间 ${statSync(overlayPath).mtime.toISOString().slice(0, 10)}`);
console.log(`  正式曲目（带曲名）: ${canonical.size} 首   扩展版本: ${variants.size} 个`);
console.log(`  抓包有、门户表里没有的曲目: ${missingInTable.length}${missingInTable.length ? " -> " + missingInTable.join(", ") : ""}`);
console.log(`  门户表里有、抓包里没有的曲目: ${missingInCapture.length}${missingInCapture.length ? "（多为抓包之后新增，正常）" : ""}`);
console.log(`  同名曲目名称不一致: ${nameMismatch.length}`);
for (const line of nameMismatch.slice(0, 10)) console.log(`    ${line}`);

const danglingVariants = [...variants.entries()].filter(([, parent]) => !known[parent]);
if (danglingVariants.length) {
  console.log(`  扩展版本指向了表里没有的曲目: ${danglingVariants.length}`);
  for (const [variant, parent] of danglingVariants.slice(0, 10)) console.log(`    ${variant} -> ${parent}`);
}

if (options.check) {
  console.log("[导入曲名] --check：未写入文件。");
  process.exit(danglingVariants.length ? 1 : 0);
}

const payload = {
  schema_version: 1,
  note: "由 scripts/import_song_names.mjs 从 MLTDLocalServer 抓包导出：扩展版本资源名 -> 主曲目代号。抓包更新后重跑该脚本刷新。",
  source: {
    overlay: overlayPath.replace(/\\/g, "/"),
    app_version: doc?.source?.target_version ?? null,
    resource_version: doc?.target?.resource_version ?? null,
    captured_at: statSync(overlayPath).mtime.toISOString(),
  },
  variants: Object.fromEntries([...variants].sort(([a], [b]) => (a < b ? -1 : 1))),
};
writeFileSync(outPath, JSON.stringify(payload, null, 1) + "\n", "utf8");
console.log(`[导入曲名] 已写入 ${outPath}（${Object.keys(payload.variants).length} 条对照）`);
