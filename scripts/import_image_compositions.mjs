#!/usr/bin/env node
// 从已验证的源资源布局导入最小展示配方，不携带工作路径、模型输出或候选审核状态。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateComposition } from "../public/lib/image-composition.js";

const [catalogFile, root, output] = process.argv.slice(2);
if (!catalogFile || !root || !output) throw new Error("用法：node scripts/import_image_compositions.mjs <catalog.json> <internal-composites> <out.json>");
const catalog = JSON.parse(readFileSync(catalogFile, "utf8"));
const sources = new Map();
for (const entry of catalog.source_bound_composites) {
  const folder = entry.task_id;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(folder)) throw new Error("非法拼接任务名");
  const task = JSON.parse(readFileSync(join(root, folder, "task.json"), "utf8"));
  if (!/^[a-f0-9]{64}$/.test(task.source_sha256)) throw new Error(`拼接配方缺少源图哈希：${folder}`);
  if (entry.original_sha256 !== task.source_sha256 || entry.prepared_sha256 !== task.prepared_sha256) {
    throw new Error(`拼接配方与源图目录不一致：${folder}`);
  }
  const recipe = validateComposition({ source_size: task.original_size, size: task.prepared_size,
    regions: task.region_map.map(({ rect, canvas_box, transform }) => ({ rect, canvas_box, transform })) });
  const previous = sources.get(task.source_sha256);
  if (previous && JSON.stringify(previous) !== JSON.stringify(recipe)) throw new Error(`同一源图有冲突的拼接布局：${folder}`);
  sources.set(task.source_sha256, recipe);
}
const entries = [...sources].sort(([a], [b]) => a.localeCompare(b))
  .map(([sha, recipe]) => `    ${JSON.stringify(sha)}: ${JSON.stringify(recipe)}`).join(",\n");
writeFileSync(output, `{\n  "schema_version": 1,\n  "kind": "mltd-source-bound-image-compositions",\n  "sources": {\n${entries}\n  }\n}\n`);
process.stdout.write(`导入 ${sources.size} 份源图哈希绑定的完整图拼接布局\n`);
