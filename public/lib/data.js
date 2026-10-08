// 静态数据访问层：只读 public/data/** 下的生成文件，没有任何服务端接口。
//
// 约定：
//   * 页面从不自己拼 data 路径 —— 索引文件里给了 `file`，用它。
//   * 图片字节在公开对象存储上，这里只负责拼 URL，不代理、不伪造。
//   * 缓存按 URL 记忆；`clearCache()` 之后重新拉取（设置页的"重新拉取数据"）。

export const DATA_ROOT = "data/";

export class DataError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = "DataError";
    this.code = code;
    this.detail = detail;
  }
}

const jsonCache = new Map();

function fetchImplOf(options) {
  return options.fetchImpl || globalThis.fetch;
}

export function dataUrl(relativePath) {
  return `${DATA_ROOT}${String(relativePath).replace(/^\/+/, "")}`;
}

async function fetchJson(url, { cacheMode = "no-cache" } = {}, options = {}) {
  const fetchImpl = fetchImplOf(options);
  if (typeof fetchImpl !== "function") throw new DataError("no_fetch", "当前环境没有 fetch");
  let response;
  try {
    response = await fetchImpl(url, { cache: cacheMode, headers: { accept: "application/json" } });
  } catch (error) {
    throw new DataError("network_error", `无法读取 ${url}：${error.message}`, { url });
  }
  if (!response.ok) {
    throw new DataError("http_error", `无法读取 ${url}（HTTP ${response.status}）`, { url, status: response.status });
  }
  try {
    return await response.json();
  } catch (_) {
    throw new DataError("invalid_json", `${url} 不是合法 JSON`, { url });
  }
}

async function cached(url, cacheMode, options) {
  if (!options.force && jsonCache.has(url)) return jsonCache.get(url);
  const pending = fetchJson(url, { cacheMode }, options);
  jsonCache.set(url, pending);
  try {
    const value = await pending;
    jsonCache.set(url, Promise.resolve(value));
    return value;
  } catch (error) {
    jsonCache.delete(url);
    throw error;
  }
}

/// `portal.json`：站点元信息与统计。每次载入都会重新拉，因为它决定版本与计数。
export function loadPortal(options = {}) {
  return cached(dataUrl("portal.json"), "no-store", options);
}

export function loadCategoryIndex(category, options = {}) {
  return cached(dataUrl(`catalogue/${encodeURIComponent(category)}.json`), "no-store", options);
}

export function loadBundle(relativeFile, options = {}) {
  return cached(dataUrl(relativeFile), "default", options);
}

export function loadImages(options = {}) {
  return cached(dataUrl("images.json"), "no-store", options);
}

export function clearCache() {
  jsonCache.clear();
}

// ------------------------------------------------------------------ 分页 bundle
//
// 一个 bundle 的行可能被切成多个页面文件（`bundles/<category>/<base>.pN.json`）。目录索引
// 里**一个 bundle 只有一条**，页信息在 `pages[]` 上，`file` 是第一页；分页文件自己是
// `bundles/<category>/<base>[.pN].json`，行号 `index` 跨页连续。

/// 从 `bundles/<category>/<base>[.pN].json` 里取分类；认不出来返回 ""（不猜）。
export function categoryOfBundleFile(relativeFile) {
  const match = /^bundles\/([^/]+)\//.exec(String(relativeFile || "").replace(/^\/+/, ""));
  return match ? match[1] : "";
}

/// 文件名去掉 `.pN` 与 `.json`，得到索引里的 `base`：`…/a.gtx.p3.json` → `a.gtx`。
export function bundleBaseOfFile(relativeFile) {
  return String(relativeFile || "").split("/").pop()
    .replace(/\.json$/i, "")
    .replace(/\.p\d+$/i, "");
}

/// 文件名里写的页号（`a.gtx.p3.json` → 3）；不是分页文件返回 null。
export function pageNumberOfFile(relativeFile) {
  const match = /\.p(\d+)\.json$/i.exec(String(relativeFile || ""));
  return match ? Number(match[1]) : null;
}

/// 目录条目上有哪些页；单页 bundle 也返回一条（`page: null`），调用方不必再分支。
export function bundlePages(entry) {
  const pages = Array.isArray(entry?.pages) ? entry.pages.filter((page) => page && page.file) : [];
  if (pages.length) return pages;
  return entry?.file ? [{ file: entry.file, page: null, total: entry.total || 0 }] : [];
}

/// 目录条目 + 想要的页号 → 归一化后的页号、该抓的文件与这一页的计数。页号越界就夹到范围内。
export function resolveBundlePage(entry, requestedPage = 1) {
  const pages = bundlePages(entry);
  const wanted = Math.trunc(Number(requestedPage));
  const page = pages.length ? Math.min(Math.max(1, Number.isFinite(wanted) ? wanted : 1), pages.length) : 1;
  const info = pages[page - 1] || null;
  return { pages, page, info, file: info?.file || entry?.file || null };
}

/// 图片地址。
///
/// 实测过的事实：上游清单里的 `distribution.*.url_template`（`images/<sha>.png`）在公开
/// 对象存储上**404**，而仓库里只有中文版图片（`images/localized/**`，937 个文件 333 MB），
/// 日文原图没有发布。所以生成器给出的是**站点内相对路径**（`media/localized/...`），
/// 由 CI 随站点一起发布；页面用它，不自己拼对象键。
export function imageSrc(task) {
  if (!task) return null;
  return task.localized_url || null;
}

/// 日文原图没有可下载的字节，只有清单里的路径与哈希，界面按这个说明展示。
export function originalReference(task) {
  const path = task?.original_path || null;
  const sha = task?.original_sha256 || null;
  if (!path && !sha) return null;
  return { path, sha, published: Boolean(task?.original_published) };
}

/// 按分类把索引行抽成一个便于筛选的数组；任何一格拿不到就返回空数组，不猜。
export function filterBundles(bundles, { idol = "", status = "", keyword = "", sort = "default" } = {}) {
  const needle = String(keyword).trim().toLowerCase();
  let rows = bundles.filter((bundle) => {
    if (idol && bundle.idol?.code !== idol) return false;
    if (status === "untranslated" && bundle.untranslated === 0) return false;
    if (status === "pending" && bundle.pending === 0) return false;
    if (status === "complete" && (bundle.untranslated > 0 || bundle.pending > 0)) return false;
    if (needle) {
      const haystack = `${bundle.bundle}\n${bundle.base}\n${bundle.song?.name_ja || ""}\n${bundle.song?.name_zh || ""}\n${bundle.repo_path || ""}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
  if (sort === "progress-asc" || sort === "progress-desc") {
    const ratio = (bundle) => (bundle.total > 0 ? bundle.translated / bundle.total : 1);
    rows = rows.slice().sort((a, b) => (sort === "progress-asc" ? ratio(a) - ratio(b) : ratio(b) - ratio(a)));
  } else if (sort === "size-desc") {
    rows = rows.slice().sort((a, b) => b.total - a.total);
  } else if (sort === "name") {
    rows = rows.slice().sort((a, b) => bundleLabel(a).localeCompare(bundleLabel(b), "ja"));
  }
  return rows;
}

/// 列表/标题里显示什么：歌曲用曲名，其余用资源名。
export function bundleLabel(bundle) {
  if (!bundle) return "—";
  const name = bundle.song?.name_ja || bundle.base || bundle.bundle;
  return bundle.song?.name_zh && bundle.song.name_zh !== bundle.song.name_ja
    ? `${name} / ${bundle.song.name_zh}`
    : name;
}

export function percentOf(translated, total) {
  if (!total) return 0;
  return Math.round((translated / total) * 1000) / 10;
}
