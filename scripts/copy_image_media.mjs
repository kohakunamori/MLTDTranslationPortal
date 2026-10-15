#!/usr/bin/env node
// 仅发布索引中有地址的原图/汉化图，不把候选图或工作目录一起拷到站点。
import { copyFileSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { validImagePath } from "./image_data.mjs";

export function copyImageMedia({ assetsRoot, images, mediaRoot }) {
  const sourceRoot = realpathSync(assetsRoot);
  const targets = new Map();
  for (const task of images.tasks || []) {
    for (const side of ["original", "localized"]) {
      if (!task[`${side}_url`]) continue;
      const path = task[`${side}_path`];
      if (!validImagePath(path, side)) throw new Error(`非法图片路径：${path}`);
      const source = realpathSync(join(sourceRoot, path));
      if (!source.startsWith(sourceRoot + sep) || !statSync(source).isFile()) throw new Error(`图片来源不在资源目录内：${path}`);
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
  const [assetsRoot, indexFile, mediaRoot] = process.argv.slice(2);
  if (!assetsRoot || !indexFile || !mediaRoot) {
    throw new Error("用法：node scripts/copy_image_media.mjs <assets-root> <images.json> <media-dir>");
  }
  const count = copyImageMedia({ assetsRoot: resolve(assetsRoot), images: JSON.parse(readFileSync(indexFile, "utf8")), mediaRoot: resolve(mediaRoot) });
  process.stdout.write(`图片齐全：已发布 ${count} 个原图/汉化图文件\n`);
}
