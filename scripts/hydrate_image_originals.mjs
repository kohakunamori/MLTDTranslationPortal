// 稀疏检出可从固定提交恢复完整原图，避免 Git 对象和媒体重复占用服务器磁盘。
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

async function digest(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

export async function hydrateImageOriginals({ assetsRoot, repo, revision, catalog: suppliedCatalog = null, concurrency = 4, fetchImage = fetch, log = () => {} }) {
  if (!assetsRoot || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[a-f0-9]{40}$/.test(revision)) throw new Error("原图恢复需要资源仓和固定提交");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("原图恢复并发数不合法");
  const root = realpathSync(assetsRoot);
  const file = join(root, "manifests/image-originals.manifest.json");
  if (!suppliedCatalog && !existsSync(file)) return { total: 0, fetched: 0 };
  const catalog = suppliedCatalog || JSON.parse(readFileSync(file, "utf8"));
  if (catalog.schema_version !== 1 || catalog.kind !== "source-complete-originals" || !Array.isArray(catalog.images)) throw new Error("完整原图目录格式不正确");
  const references = new Map();
  for (const task of catalog.images) {
    const path = task.original?.relative_path;
    const sha = task.original?.sha256;
    if (!/^[a-f0-9]{64}$/.test(sha || "") || path !== `images/original/complete/${sha}.webp` || task.image_layout !== "complete") {
      throw new Error(`完整原图来源不合法：${task.task_id}`);
    }
    references.set(path, sha);
  }
  const queue = [...references];
  let next = 0, fetched = 0, done = 0;
  async function worker() {
    while (next < queue.length) {
      const [path, sha] = queue[next++];
      const destination = join(root, path);
      mkdirSync(dirname(destination), { recursive: true });
      if (!realpathSync(dirname(destination)).startsWith(root + sep)) throw new Error("完整原图目录越界");
      if (existsSync(destination)) {
        if (!realpathSync(destination).startsWith(root + sep) || await digest(destination) !== sha) throw new Error(`完整原图哈希不一致：${path}`);
      } else {
        const temporary = `${destination}.${process.pid}.part`;
        for (let attempt = 0; attempt < 3; attempt++) {
          let handle;
          try {
            const response = await fetchImage(`https://raw.githubusercontent.com/${repo}/${revision}/${path}`, { signal: AbortSignal.timeout(120_000) });
            if (!response.ok || !response.body) throw new Error(`下载原图 HTTP ${response.status}：${path}`);
            handle = await open(temporary, "wx");
            const hash = createHash("sha256");
            let length = 0;
            for await (const chunk of response.body) {
              length += chunk.length;
              if (length > 80 * 1024 * 1024) throw new Error("原图文件超过大小限制");
              hash.update(chunk);
              await handle.writeFile(chunk);
            }
            await handle.close(); handle = null;
            if (hash.digest("hex") !== sha) throw new Error(`下载原图哈希不一致：${path}`);
            await rename(temporary, destination);
            fetched++;
            break;
          } catch (error) {
            if (handle) await handle.close();
            await unlink(temporary).catch((cleanup) => { if (cleanup.code !== "ENOENT") throw cleanup; });
            if (attempt === 2) throw error;
          }
        }
      }
      done++;
      if (done % 100 === 0 || done === queue.length) log(`原图齐备 ${done}/${queue.length}，本次下载 ${fetched}`);
    }
  }
  // 等到所有工作结束再返回错误，调用者不会在后台仍写文件时开始生成或清理。
  const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  return { total: queue.length, fetched };
}
