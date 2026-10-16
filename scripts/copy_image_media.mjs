#!/usr/bin/env node
// 发布索引引用的原图、审核译图和明确登记的待审投稿。
import { copyFileSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { validImagePath } from "./image_data.mjs";

export function copyImageMedia({ assetsRoot, images, mediaRoot, completeOriginalsRoot = "" }) {
  const sourceRoot = realpathSync(assetsRoot);
  const targets = new Map();
  for (const task of images.tasks || []) {
    for (const side of ["original", "localized", "submission"]) {
      if (!task[`${side}_url`]) continue;
      const path = side === "submission" ? task.submission?.path : task[`${side}_path`];
      if (!validImagePath(path, side === "submission" ? "submissions" : side)) throw new Error(`非法图片路径：${path}`);
      const external = completeOriginalsRoot && path.startsWith("images/original/complete/");
      const allowedRoot = external ? realpathSync(completeOriginalsRoot) : sourceRoot;
      if (external && path !== `images/original/complete/${basename(path)}`) throw new Error(`完整原图路径不合法：${path}`);
      const source = realpathSync(external ? join(allowedRoot, basename(path)) : join(sourceRoot, path));
      if (!source.startsWith(allowedRoot + sep) || !statSync(source).isFile()) throw new Error(`图片来源不在资源目录内：${path}`);
      targets.set(path, source);
    }
  }
  for (const [path, source] of targets) {
    const destination = join(mediaRoot, path.slice("images/".length));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  return targets.size;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [assetsRoot, indexFile, mediaRoot, completeOriginalsRoot = ""] = process.argv.slice(2);
  if (!assetsRoot || !indexFile || !mediaRoot) {
    throw new Error("用法：node scripts/copy_image_media.mjs <assets-root> <images.json> <media-dir> [complete-originals-dir]");
  }
  const count = copyImageMedia({ assetsRoot: resolve(assetsRoot), images: JSON.parse(readFileSync(indexFile, "utf8")), mediaRoot: resolve(mediaRoot), completeOriginalsRoot });
  process.stdout.write(`图片齐全：已发布 ${count} 个原图/汉化图文件\n`);
}
