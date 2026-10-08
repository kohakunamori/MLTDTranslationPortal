#!/usr/bin/env node
// 本地静态预览服务：GitHub Pages 上就是这套纯静态文件，本地用它验证同一份产物。
//
//   node scripts/serve.mjs                 # http://127.0.0.1:8788
//   node scripts/serve.mjs --port 9000
//
// 只读，零依赖；路径穿越一律 404。

import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function parseArgs(argv) {
  const options = { port: 8788, root: "public", host: "127.0.0.1" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--port") options.port = Number(argv[index + 1]);
    else if (argv[index] === "--root") options.root = argv[index + 1];
    else if (argv[index] === "--host") options.host = argv[index + 1];
  }
  return options;
}

export function createStaticServer({ root = "public" } = {}) {
  const rootDir = resolve(root);
  return createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith("/")) pathname += "index.html";
    const relative = normalize(pathname).replace(/^([/\\])+/, "");
    const full = join(rootDir, relative);
    if (!full.startsWith(rootDir + sep) && full !== rootDir) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    if (!existsSync(full) || !statSync(full).isFile()) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end(`not found: ${pathname}`);
      return;
    }
    response.writeHead(200, {
      "content-type": MIME[extname(full).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(readFileSync(full));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  const server = createStaticServer({ root: options.root });
  server.listen(options.port, options.host, () => {
    process.stdout.write(`静态服务已启动：http://${options.host}:${options.port}/  (root=${resolve(options.root)})\n`);
    if (!existsSync(join(resolve(options.root), "data", "portal.json"))) {
      process.stdout.write(
        "提示：还没有数据（" + join(options.root, "data", "portal.json") + " 不存在）。\n" +
        "      npm run data:demo   用 test_helpers/fixtures 生成一份演示数据\n" +
        "      npm run data        用 vendor/ 里的真实翻译仓库 checkout 生成\n",
      );
    }
  });
}
