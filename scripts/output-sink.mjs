// Output sinks keep generation policy separate from data transformation.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { relativeFileMap } from "./fs-utils.mjs";

/// 生成器每完成一个文件就交给"汇"，不再把 174 MB 产出全堆在内存里——那是
/// 峰值 815 MB 的主因，而目标机器（1 核 / 1.4 GB 且已跑满服务）扛不住。
/// 三种汇的对外形状一样：`put(路径, 内容)` + `count()`，只有收集型带 `files`。
export function collectingSink() {
  const files = new Map();
  return {
    files,
    put: (relativePath, content) => files.set(relativePath, content),
    count: () => files.size,
  };
}

export function writingSink(outDir) {
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
export function compareSink(outDir) {
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
export function swapIntoPlace(outDir, staging) {
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
export function clearStaleStaging(outDir) {
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
  return relativeFileMap(outDir, (entry) => entry.name.endsWith(".json"));
}

/// `generated_at` 是唯一允许变化的字段：比对时把它抹平，否则每天都会"漂移"。
function comparable(content, relativePath) {
  if (relativePath !== "portal.json") return content;
  return content.replace(/"generated_at": "[^"]*"/, '"generated_at": "<ignored>"');
}

