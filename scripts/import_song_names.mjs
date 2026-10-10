// 从 MLTDLocalServer 抓到的游戏内容里导出「曲名」与「扩展版本 → 主曲目」对照。
//
// 背景：游戏里同一首歌会挂多个资源包。主包（如 scrobj_flyers.unity3d）带正式曲名；
// 扩展版本（如 scrobj_flye39.unity3d、scrobj_ahhan+.unity3d）不带，但抓来的数据里写着
// 它挂在哪首歌下面。门户原来只按资源名精确查表，这些包就只能显示成代号。
//
// 两边的分工（单向：MLTDLocalServer 产出 → 门户消费）：
//   MLTDLocalServer  side : 抓包写入内容覆盖层并发版，产物入库、由它的 CI 每次刷新。
//                           可选的小文件接口见下面 AUTHORITY 说明。
//   MLTDLocalTranslationPortal side : 本脚本读取后导出 public/lib/song-variants.json（入库），
//                           服务器生成数据时只读这份导出，不需要抓包文件。
//
// 用法：
//   npm run data:import-song-names                       # 自动找可用的源
//   node --experimental-sqlite scripts/import_song_names.mjs --check    # 只看不写
//   ... --sqlite <content-overlay.sqlite>                # 指定覆盖层库
//   ... --authority <song-name-authority.json>           # 指定小文件接口（优先）
//
// AUTHORITY（可选的小文件接口，推荐 MLTDLocalServer 的 CI 产出）：
//   {
//     "schema": "mltd-song-name-authority-v1",
//     "asset_version": "1077741",
//     "songs":    [{ "resource_id": "flyers", "name": "Flyers!!!" }],
//     "variants": [{ "resource_id": "flye39", "parent_resource_id": "flyers" }]
//   }
//   有了它就不必读 20 MB 的库，也不需要打开 SQLite 的开关；门户会自动优先使用。
//
// 找不到任何源时不会报错退出，只提醒——生成器仍能用已入库的对照文件工作。

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SONG_MASTER, SONG_MASTER_EXTRA, SONG_VARIANT_OVERRIDES } from "../public/lib/terms.js";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "public", "lib", "song-variants.json");

/// MLTDLocalServer 的默认位置。换机器时用环境变量或命令行参数指定。
const LOCAL_SERVER_ROOT = process.env.MLTD_LOCAL_SERVER ?? "D:/Project/MLTDLocalServer";

const CANDIDATES = {
  authority: [process.env.MLTD_SONG_AUTHORITY, join(LOCAL_SERVER_ROOT, "ci/fullsave/latest/song-name-authority.json")],
  sqlite: [
    process.env.MLTD_OVERLAY_SQLITE,
    join(LOCAL_SERVER_ROOT, "runtime/content-overlay.sqlite"),
    join(LOCAL_SERVER_ROOT, "fullsave/canonical/local-fullsave-content.sqlite"),
  ],
  overlay: [process.env.MLTD_OVERLAY, join(LOCAL_SERVER_ROOT, "runtime/content-overlay.json")],
};

function parseArgs(argv) {
  const options = { check: false, explicit: null };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    if (argv[i] === "--check") options.check = true;
    else if (argv[i] === "--authority") options.explicit = { kind: "authority", path: resolve(value) };
    else if (argv[i] === "--sqlite") options.explicit = { kind: "sqlite", path: resolve(value) };
    else if (argv[i] === "--overlay") options.explicit = { kind: "overlay", path: resolve(value) };
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const firstExisting = (paths) => paths.filter(Boolean).find((candidate) => existsSync(candidate)) ?? null;

// —— 三种源，按优先级：小文件接口 > 覆盖层库 > 覆盖层 JSON 导出 ——
function pickSource() {
  if (options.explicit) {
    if (!existsSync(options.explicit.path)) throw new Error(`指定的文件不存在：${options.explicit.path}`);
    return options.explicit;
  }
  for (const kind of ["authority", "sqlite", "overlay"]) {
    const path = firstExisting(CANDIDATES[kind]);
    if (path) return { kind, path };
  }
  return null;
}

/// 覆盖层库的表结构：song(resource_id, current_catalog_json, policy_json)。
/// node:sqlite 在 Node 22 上要开 --experimental-sqlite（npm 脚本已经带上）。
async function readSqlite(path) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch (error) {
    throw new Error(`读不了 SQLite（${error.code ?? error.message}）：请用 npm run data:import-song-names，或改用 --authority/--overlay 指定 JSON`);
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare("SELECT resource_id, current_catalog_json, policy_json FROM song").all();
    const songs = [];
    const variants = [];
    for (const row of rows) {
      if (typeof row.resource_id !== "string" || row.resource_id === "") continue;
      const catalog = safeJson(row.current_catalog_json);
      if (typeof catalog.name === "string" && catalog.name !== "") songs.push({ resource_id: row.resource_id, name: catalog.name });
      const policy = safeJson(row.policy_json);
      const list = policy?.song?.extend_song_status_list;
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (typeof item?.resource_id !== "string" || item.resource_id === "" || item.resource_id === row.resource_id) continue;
        variants.push({ resource_id: item.resource_id, parent_resource_id: row.resource_id });
      }
    }
    const meta = db.prepare("SELECT value FROM meta WHERE key = 'counts'").get();
    return { songs, variants, asset_version: null, counts: safeJson(meta?.value) };
  } finally {
    db.close();
  }
}

function safeJson(text) {
  if (typeof text !== "string" || text === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/// 覆盖层 JSON 导出：local_content.songs[] 里既有曲名也有扩展版本关系。
function readOverlayJson(path) {
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const songs = doc?.local_content?.songs;
  if (!Array.isArray(songs)) throw new Error(`这份 JSON 里没有 local_content.songs[]：${path}`);
  const names = [];
  const variants = [];
  for (const song of songs) {
    const id = song?.master?.resource_id;
    const name = song?.current_catalog?.name;
    if (typeof id === "string" && typeof name === "string" && name !== "") names.push({ resource_id: id, name });
    const list = song?.policy?.song?.extend_song_status_list;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item?.resource_id !== "string" || item.resource_id === id) continue;
      variants.push({ resource_id: item.resource_id, parent_resource_id: id });
    }
  }
  return { songs: names, variants, asset_version: doc?.source?.target_version ?? null, counts: null };
}

function readAuthorityJson(path) {
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const songs = Array.isArray(doc?.songs) ? doc.songs : [];
  const variants = Array.isArray(doc?.variants) ? doc.variants : Object.entries(doc?.variants ?? {}).map(([id, parent]) => ({ resource_id: id, parent_resource_id: parent }));
  return { songs, variants, asset_version: doc?.asset_version ?? null, counts: null };
}

/// MLTDLocalServer 每次发版都会写 ci/fullsave/latest/RELEASE.json，里面记着这次覆盖层的
/// sha256、CI 运行号和资产版本。记下来两边就能对齐"门户导入的是哪一次发布"。
function readRelease(sourcePath) {
  let dir = dirname(resolve(sourcePath));
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = join(dir, "ci", "fullsave", "latest", "RELEASE.json");
    if (existsSync(candidate)) {
      const doc = JSON.parse(readFileSync(candidate, "utf8"));
      return {
        file: portablePath(candidate),
        schema: doc?.schema ?? null,
        run_number: doc?.run_number ?? null,
        commit: doc?.commit ?? null,
        asset_version: doc?.asset_snapshot?.asset_version ?? doc?.validated_against_asset_version ?? null,
        overlay_sha256: doc?.overlay_sha256 ?? null,
        overlay_path: doc?.overlay_path ?? null,
      };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// —— 汇总成「资源名 → 曲名」与「扩展版本 → 主曲目」 ——
function build(payload) {
  const names = new Map();
  for (const row of payload.songs) {
    if (typeof row?.resource_id === "string" && typeof row?.name === "string" && row.name !== "") names.set(row.resource_id, row.name);
  }
  const variants = new Map();
  for (const row of payload.variants) {
    const id = row?.resource_id;
    const parent = row?.parent_resource_id;
    if (typeof id !== "string" || typeof parent !== "string" || id === "" || parent === "") continue;
    if (names.has(id)) continue; // 自己就是主曲目，归到自己
    if (!variants.has(id)) variants.set(id, parent);
  }
  return { names, variants };
}

const known = { ...SONG_MASTER, ...SONG_MASTER_EXTRA };

/// 记录源文件位置时去掉机器相关的部分：落在 MLTDLocalServer 根目录下的记相对路径，
/// 其余只记文件名。这样在本地和在对方 CI 里跑出来的对照文件内容一致，不会因为路径不同
/// 就产生"看起来变了"的差异。
function portablePath(path) {
  const normalized = resolve(path).replace(/\\/g, "/");
  const root = resolve(LOCAL_SERVER_ROOT).replace(/\\/g, "/");
  if (normalized.startsWith(root + "/")) return normalized.slice(root.length + 1);
  return normalized.split("/").pop() ?? normalized;
}

const source = pickSource();
if (!source) {
  console.log("[导入曲名] 没找到可用的源（MLTDLocalServer 的库 / JSON 导出 / 小文件接口），跳过。");
  console.log(`  默认找的位置：${LOCAL_SERVER_ROOT}`);
  console.log("  可用 --sqlite / --overlay / --authority 指定，或用环境变量 MLTD_LOCAL_SERVER 换根目录。");
  console.log(`  已入库的对照文件：${existsSync(outPath) ? "有（生成器会继续用它）" : "没有（生成器退回精确查表）"}`);
  process.exit(0);
}

const payload = source.kind === "sqlite"
  ? await readSqlite(source.path)
  : source.kind === "authority"
    ? readAuthorityJson(source.path)
    : readOverlayJson(source.path);

const { names, variants } = build(payload);
for (const [variant, parent] of Object.entries(SONG_VARIANT_OVERRIDES)) if (!variants.has(variant)) variants.set(variant, parent);

// —— 一致性检查 ——
const missingInTable = [...names.keys()].filter((id) => !known[id]);
const mismatched = [...names.entries()].filter(([id, name]) => known[id] && known[id].name_ja !== name);
const dangling = [...variants.entries()].filter(([, parent]) => !known[parent]);
const previous = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : null;
const previousVersion = previous?.source?.asset_version ?? previous?.source?.sha256 ?? null;

const digest = createHash("sha256").update(readFileSync(source.path)).digest("hex");
const release = readRelease(source.path);
const version = payload.asset_version ?? release?.asset_version ?? null;

console.log(`[导入曲名] 源：${source.kind}  ${source.path}`);
console.log(`  文件时间 ${statSync(source.path).mtime.toISOString().slice(0, 19)}   sha256 ${digest.slice(0, 16)}${version ? `   asset_version ${version}` : ""}`);
if (release) {
  console.log(`  对齐 MLTDLocalServer 第 ${release.run_number ?? "?"} 次发版（提交 ${String(release.commit ?? "").slice(0, 8)}，资产版本 ${release.asset_version ?? "?"}）`);
  if (release.overlay_sha256 && release.overlay_sha256.toLowerCase() !== digest) {
    console.log(`  ⚠ 覆盖层哈希与发版记录不一致：记录 ${release.overlay_sha256.slice(0, 16)}，本次读到 ${digest.slice(0, 16)}。可能抓包后还没发版，或读的不是发版产物。`);
  }
}
console.log(`  正式曲目（带曲名）${names.size} 首   扩展版本 ${variants.size} 个（含手工补充 ${Object.keys(SONG_VARIANT_OVERRIDES).length} 条）`);
console.log(`  抓包有、门户表里没有的曲目：${missingInTable.length}${missingInTable.length ? " -> " + missingInTable.join(", ") : ""}`);
console.log(`  同名曲目名称不一致：${mismatched.length}（多为全角/半角标点写法差异）`);
for (const [id, name] of mismatched.slice(0, 5)) console.log(`    ${id}: 表里「${known[id].name_ja}」  抓包「${name}」`);
console.log(`  扩展版本指向了表里没有的曲目：${dangling.length}${dangling.length ? " -> " + dangling.map(([v, p]) => `${v}->${p}`).join(", ") : ""}`);

if (previousVersion && previousVersion !== (version ?? digest)) {
  console.log(`  抓包数据比上次导入时有变化：${previousVersion} -> ${version ?? digest.slice(0, 16)}`);
}

if (options.check) {
  console.log("[导入曲名] --check：未写入文件。");
  process.exit(dangling.length ? 1 : 0);
}

writeFileSync(outPath, JSON.stringify({
  schema_version: 1,
  note: "由 scripts/import_song_names.mjs 从 MLTDLocalServer 的内容覆盖层导出：扩展版本资源名 -> 主曲目代号。抓包更新后重跑该脚本刷新；服务器生成数据时只读这份文件。本文件刻意不含时间戳等每次都变的字段，数据没变时重跑不会产生差异。",
  source: {
    kind: source.kind,
    // 记对方发版记录里的规范路径（如 fullsave/canonical/local-fullsave-content.sqlite）；
    // 没有发版记录时退回相对路径。这样在本地和在对方 CI 里跑出来的文件内容一致，
    // 数据没变时不会因为路径不同产生"看起来变了"的差异。
    file: release?.overlay_path || portablePath(source.path),
    asset_version: version,
    sha256: digest,
    local_server_release: release,
  },
  variants: Object.fromEntries([...variants].sort(([a], [b]) => (a < b ? -1 : 1))),
}, null, 1) + "\n", "utf8");
console.log(`[导入曲名] 已写入 ${outPath}（${variants.size} 条对照）`);
