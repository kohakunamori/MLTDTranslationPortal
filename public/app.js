// MLTD 翻译查阅站 —— 纯静态前端。
//
// 只读 public/data/** 的生成文件 + 公开对象存储上的图片；唯一的写操作是用户在阅读页
// 用自己存在本机的 GitHub Token 改一行译文（见 lib/github-write.js）。
//
// 路由用 hash：`#overview` / `#catalogue?category=` / `#read?file=&p=` / `#images` / `#settings`。
// `#read` 的 `file` 是 bundle 文件（多页 bundle 就是它的第一页文件），`p` 是 1 起算的
// 数据页号；分页只影响抓哪个页面文件，不改变"整包计数"的口径。

import {
  DataError,
  bundleBaseOfFile,
  bundleLabel,
  categoryOfBundleFile,
  clearCache,
  dataUrl,
  filterBundles,
  imageSrc,
  originalReference,
  loadBundle,
  loadCategoryIndex,
  loadImages,
  loadPortal,
  pageNumberOfFile,
  percentOf,
  progressPercent,
  resolveBundlePage,
} from "./lib/data.js";
import { CATEGORY_RULES, CATEGORY_ORDER, IMAGE_CATEGORY_RULES, IMAGE_CATEGORY_ORDER } from "./lib/taxonomy.js";
import { IDOLS, TERMS } from "./lib/terms.js";
import { WriteError, commitLineEdit, getToken, setToken, verifyToken } from "./lib/github-write.js";
import { checkTranslationFormat, draftTranslation, getAiConfig, setAiConfig, testAiConnection } from "./lib/ai-draft.js";

const PAGE_SIZE_CATALOGUE = 24;
const PAGE_SIZE_READ = 200;

const state = {
  portal: null,
  view: "overview",
  domain: "all",
  songKeyword: "",
  writeStatus: null,
  catalogue: { category: "lyrics", bundles: [], page: 1, filters: { idol: "", status: "", channel: "", keyword: "", sort: "default" } },
  read: {
    // `file` 是当前 bundle 的规范文件；`urlFile` 是 URL 里那个 file（原样带回，不在渲染中改写 URL）。
    file: "",
    urlFile: "",
    bundle: null,
    loadedFile: "",
    // 数据页（bundle 分页）：page 是本视图内的行分页，bundlePage 是数据页号。
    bundlePage: 1,
    entry: null,
    pages: [],
    baseline: null,
    page: 1,
    filters: { keyword: "", status: "", display: "both", size: "normal", highlight: true },
  },
  editing: null,
  images: { data: null, category: "all", keyword: "", sort: "default", page: 1 },
  lightbox: null,
};

// ------------------------------------------------------------------ DOM 工具

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, value);
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

let toastTimer = null;
function toast(message, kind = "") {
  const node = $("toast");
  node.textContent = message;
  node.className = `toast ${kind}`.trim();
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, kind === "err" ? 6000 : 3200);
}

function hideModal(name) {
  const modal = name === "confirm" ? $("confirm-modal") : $("lightbox");
  if (modal) modal.hidden = true;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("zh-CN");
}

// ------------------------------------------------------------------ 文本渲染

const GAME_TAG = /<color=(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})>|<\/color>|<b>|<\/b>/g;

/// 术语与偶像名的高亮表：长词优先，避免短词先命中把长词切碎。
const HIGHLIGHTS = (() => {
  const list = [];
  for (const idol of IDOLS) if (idol.name_ja) list.push({ text: idol.name_ja, title: idol.name_zh || idol.name_ja, kind: "idol" });
  for (const term of TERMS) if (term.source) list.push({ text: term.source, title: term.target || term.source, kind: "term" });
  list.sort((a, b) => b.text.length - a.text.length);
  return list;
})();

const HIGHLIGHT_REGEX = HIGHLIGHTS.length
  ? new RegExp(HIGHLIGHTS.map((item) => item.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g")
  : null;

function appendHighlighted(host, text) {
  const raw = String(text ?? "");
  if (!HIGHLIGHT_REGEX || !raw) {
    host.append(document.createTextNode(raw));
    return;
  }
  let cursor = 0;
  let match;
  HIGHLIGHT_REGEX.lastIndex = 0;
  while ((match = HIGHLIGHT_REGEX.exec(raw)) !== null) {
    if (match.index > cursor) host.append(document.createTextNode(raw.slice(cursor, match.index)));
    const hit = HIGHLIGHTS.find((item) => item.text === match[0]);
    host.append(el("span", {
      class: hit?.kind === "idol" ? "idol-hit" : "term-hit",
      title: hit ? `${match[0]} → ${hit.title}` : "",
    }, match[0]));
    cursor = match.index + match[0].length;
    if (match[0].length === 0) HIGHLIGHT_REGEX.lastIndex += 1;
  }
  if (cursor < raw.length) host.append(document.createTextNode(raw.slice(cursor)));
}

/// 游戏内标记（`<color=…>`、`<b>`）只做白名单转换；所有文本都走 textContent，
/// 因此源文里的 HTML 不会被当成标签执行。
function renderRichText(text, { highlight = false } = {}) {
  const host = el("span");
  const raw = String(text ?? "");
  const stack = [];
  const appendTo = (node) => (stack.length ? stack[stack.length - 1] : host).append(node);
  const pushText = (value) => {
    if (!value) return;
    if (highlight && stack.length === 0) appendHighlighted(host, value);
    else if (highlight && stack[stack.length - 1] === host) appendHighlighted(host, value);
    else appendTo(document.createTextNode(value));
  };

  let cursor = 0;
  let match;
  GAME_TAG.lastIndex = 0;
  while ((match = GAME_TAG.exec(raw)) !== null) {
    pushText(raw.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const tag = match[0];
    if (tag === "</color>" || tag === "</b>") {
      if (stack.length) stack.pop();
      continue;
    }
    const node = tag === "<b>"
      ? el("strong")
      : el("span", { class: "game-color", style: /^#/.test(match[1]) ? `color:${match[1]}` : "" });
    appendTo(node);
    stack.push(node);
  }
  pushText(raw.slice(cursor));
  return host;
}

// ------------------------------------------------------------------ 路由

function navigate(view, params = {}) {
  // 路径直接写在 hash 里更好读（`file=bundles/system_ui/x.json`），URLSearchParams 会把 `/`
  // 转义成 %2F，这里只把 `/` 还原回去；其余字符保持转义。
  const query = new URLSearchParams(params).toString().replace(/%2F/gi, "/");
  location.hash = query ? `#${view}?${query}` : `#${view}`;
}

function parseRoute() {
  const raw = location.hash.replace(/^#/, "") || "overview";
  const [view, query = ""] = raw.split("?");
  return { view: view || "overview", params: Object.fromEntries(new URLSearchParams(query)) };
}

async function applyRoute() {
  const { view, params } = parseRoute();
  const known = ["overview", "catalogue", "read", "images", "settings"];
  state.view = known.includes(view) ? view : "overview";
  for (const section of document.querySelectorAll(".view")) section.hidden = true;
  $(`view-${state.view}`).hidden = false;
  for (const button of document.querySelectorAll(".nav-btn")) {
    button.classList.toggle("active", button.dataset.nav === state.view);
  }

  if (state.view === "overview") await renderOverview();
  else if (state.view === "catalogue") await renderCatalogue(params);
  else if (state.view === "read") await renderRead(params);
  else if (state.view === "images") await renderImages();
  else if (state.view === "settings") await renderSettings();
  window.scrollTo({ top: 0 });
}

// ------------------------------------------------------------------ 顶部

function renderHeader() {
  const portal = state.portal;
  if (!portal) return;
  const totals = portal.totals || {};
  $("header-subtitle").textContent =
    `${totals.bundles || 0} 个资源 · ${formatNumber(totals.total || 0)} 行 · 已译 ${formatNumber(totals.translated || 0)}（${totals.progress_percent ?? 0}%）`;
  // 直接读 localStorage，而不是缓存到 state：Token 可能是别的标签页或上次会话留下的。
  const token = getToken();
  const chip = $("write-chip");
  if (token) {
    const label = state.writeStatus?.login ? `@${state.writeStatus.login}` : "已配置 Token";
    chip.textContent = `${label} · 可写`;
    chip.className = "write-chip on";
    chip.title = "行内修改会直接用这个 Token 提交到数据仓库";
  } else {
    chip.textContent = "只读";
    chip.className = "write-chip";
    chip.title = "未配置 GitHub Token，只能查看；在「设置」里配置后可单行修改";
  }
}

function statBox(label, value, kind = "") {
  return el("div", { class: `stat ${kind}`.trim() }, [el("b", { text: formatNumber(value) }), el("span", { text: label })]);
}

// ------------------------------------------------------------------ 概览

async function renderOverview() {
  state.portal = state.portal || await loadPortal();
  renderHeader();
  const portal = state.portal;
  const totals = portal.totals || {};

  $("hero-meta").textContent = [
    `生成于 ${portal.generated_at || "未知时间"}`,
    portal.releases?.assets?.asset_version ? `Assets ${portal.releases.assets.asset_version}` : null,
    portal.releases?.client?.client_version ? `Client ${portal.releases.client.client_version}` : null,
    portal.sources?.assets?.commit ? `assets@${String(portal.sources.assets.commit).slice(0, 8)}` : null,
  ].filter(Boolean).join(" · ");

  $("hero-progress").style.width = `${Math.min(100, Number(totals.progress_percent) || 0)}%`;
  $("hero-progress-value").textContent = `${totals.progress_percent ?? 0}%`;
  clear($("stat-row")).append(
    statBox("总行数", totals.total),
    statBox("已确认", totals.translated, "accepted"),
    statBox("待确认", totals.pending, "pending"),
    statBox("未翻译", totals.untranslated, "untranslated"),
    // 原文非日文（英文歌词）且没有译文：不算未翻译，也不占进度分母
    statBox("无需翻译", totals.not_needed || 0, "not_needed"),
    statBox("资源数", totals.bundles),
  );

  const tabs = clear($("domain-tabs"));
  const domains = [{ id: "all", name: "全部", icon: "✨" }].concat(portal.domains || []);
  for (const domain of domains) {
    tabs.append(el("button", {
      class: `domain-tab${state.domain === domain.id ? " active" : ""}`,
      type: "button",
      text: `${domain.icon || ""} ${domain.name}`,
      onclick: () => { state.domain = domain.id; renderOverview(); },
    }));
  }

  const grid = clear($("category-grid"));
  const visible = (portal.categories || []).filter((category) => {
    if (state.domain !== "all" && category.domain !== state.domain) return false;
    return category.total > 0 || category.bundles > 0;
  });
  const emptyHint = $("category-empty");
  emptyHint.hidden = visible.length > 0;
  emptyHint.textContent = state.domain === "all"
    ? "这次生成的数据里没有任何分类内容。"
    : `${state.domain} 这个 domain 在这次生成的数据里没有内容，换个 domain 看看。`;
  for (const category of visible) {
    const percent = progressPercent(category);
    grid.append(el("button", {
      class: "category-card",
      type: "button",
      onclick: () => navigate("catalogue", { category: category.id }),
    }, [
      el("div", { class: "cat-head" }, [
        el("span", { class: "cat-icon", text: category.icon || "📄" }),
        el("span", { class: "cat-name", text: category.name }),
      ]),
      el("div", { class: "hint", text: CATEGORY_RULES[category.id]?.description || "" }),
      el("div", { class: "progress-track" }, el("div", { class: "progress-fill", style: `width:${percent}%` })),
      el("div", { class: "cat-counts" }, [
        el("span", { text: `${category.bundles} 个资源 · ${formatNumber(category.total)} 行` }),
        el("span", { text: `${percent}%` }),
      ]),
    ]));
  }

  await renderSongGrid();
}

async function renderSongGrid() {
  const grid = clear($("song-grid"));
  const empty = $("song-grid-empty");
  let index;
  try {
    index = await loadCategoryIndex("lyrics");
  } catch (error) {
    empty.hidden = false;
    empty.textContent = `歌曲索引无法载入：${error.message}`;
    return;
  }
  const keyword = state.songKeyword.trim().toLowerCase();
  const songs = (index.bundles || [])
    .filter((bundle) => {
      if (!keyword) return true;
      const haystack = `${bundle.song?.name_ja || ""}\n${bundle.song?.name_zh || ""}\n${bundle.base}\n${bundle.bundle}`.toLowerCase();
      return haystack.includes(keyword);
    })
    .sort((a, b) => (a.song?.mst_song_id || 0) - (b.song?.mst_song_id || 0));

  empty.hidden = songs.length > 0;
  if (!songs.length) empty.textContent = "没有匹配的歌曲。";
  for (const song of songs) {
    const percent = progressPercent(song);
    grid.append(el("button", {
      class: "song-card",
      type: "button",
      onclick: () => navigate("read", { file: song.file }),
    }, [
      el("div", { class: "song-name", text: song.song?.name_ja || song.base }),
      el("div", { class: "song-sub", text: [song.song?.name_zh, song.song?.type].filter(Boolean).join(" · ") || song.base }),
      el("div", { class: "progress-track" }, el("div", { class: "progress-fill", style: `width:${percent}%` })),
      el("div", { class: "song-foot" }, [
        el("span", { text: `${song.translated}/${song.total} 句` }),
        el("span", { text: `${percent}%` }),
      ]),
    ]));
  }
}

// ------------------------------------------------------------------ 索引浏览

/// 筛选下拉里带上当前分类的真实数量，让人一眼看出筛完还剩多少：
/// 「未翻译（1,067 行 · 12 个资源）」。数量基于**当前已加载的分类**，不跨分类瞎算。
function labelStatusOptions(bundles) {
  const count = (predicate) => bundles.filter(predicate).length;
  const sum = (pick) => bundles.reduce((total, bundle) => total + pick(bundle), 0);
  const labels = {
    "": `全部（${formatNumber(bundles.length)} 个资源）`,
    untranslated: `未翻译（${formatNumber(sum((b) => b.untranslated))} 行 · ${formatNumber(count((b) => b.untranslated > 0))} 个资源）`,
    pending: `待确认（${formatNumber(sum((b) => b.pending))} 行 · ${formatNumber(count((b) => b.pending > 0))} 个资源）`,
    complete: `已翻译（全部译完 · ${formatNumber(count((b) => b.untranslated === 0 && b.pending === 0))} 个资源）`,
  };
  for (const option of $("filter-status").options) {
    if (labels[option.value] !== undefined) option.textContent = labels[option.value];
  }
  // 来源下拉也带数量——真实数据里 client 只有 1 个资源，一眼就该看出来
  const client = count((bundle) => (bundle.channel || "assets") === "client");
  for (const option of $("filter-channel").options) {
    if (option.value === "") option.textContent = `全部来源（${formatNumber(bundles.length)} 个资源）`;
    else if (option.value === "client") option.textContent = `Client 仓（客户端清单 · ${formatNumber(client)} 个资源）`;
    else option.textContent = `Assets 仓（译文 · ${formatNumber(bundles.length - client)} 个资源）`;
  }
}

async function renderCatalogue(params = {}) {
  state.portal = state.portal || await loadPortal();
  if (params.category && CATEGORY_RULES[params.category]) state.catalogue.category = params.category;
  if (params.status) state.catalogue.filters.status = params.status;
  if (params.sort) state.catalogue.filters.sort = params.sort;
  const { category } = state.catalogue;

  const select = clear($("filter-category"));
  for (const id of CATEGORY_ORDER) {
    const entry = (state.portal.categories || []).find((item) => item.id === id);
    if (!entry || (!entry.total && !entry.bundles)) continue;
    select.append(el("option", { value: id, text: `${entry.icon} ${entry.name}`, selected: id === category }));
  }

  const index = await loadCategoryIndex(category);
  state.catalogue.bundles = index.bundles || [];
  const meta = CATEGORY_RULES[category];
  $("catalogue-title").textContent = `${meta.icon} ${meta.name}`;
  // 分类卡片说"几个资源"；这里再补一句数据文件数（分页后文件数会大于资源数）。
  const categoryMeta = (state.portal.categories || []).find((item) => item.id === category);
  const files = Number(categoryMeta?.files || 0);
  $("catalogue-meta").textContent = [
    `${index.total_bundles} 个资源`,
    `共 ${formatNumber(state.catalogue.bundles.reduce((sum, item) => sum + item.total, 0))} 行`,
    files > index.total_bundles ? `切成 ${formatNumber(files)} 个数据文件` : null,
    meta.description,
  ].filter(Boolean).join(" · ");

  const idolSelect = clear($("filter-idol"));
  idolSelect.append(el("option", { value: "", text: "全部" }));
  const idols = new Map();
  for (const bundle of state.catalogue.bundles) if (bundle.idol?.code) idols.set(bundle.idol.code, bundle.idol);
  for (const idol of [...idols.values()].sort((a, b) => a.code.localeCompare(b.code))) {
    idolSelect.append(el("option", {
      value: idol.code,
      text: `${idol.name_ja}（${idol.code}）`,
      selected: state.catalogue.filters.idol === idol.code,
    }));
  }

  $("filter-status").value = state.catalogue.filters.status;
  $("filter-sort").value = state.catalogue.filters.sort;
  $("filter-keyword").value = state.catalogue.filters.keyword;
  $("filter-channel").value = state.catalogue.filters.channel;
  labelStatusOptions(state.catalogue.bundles);

  const rows = filterBundles(state.catalogue.bundles, state.catalogue.filters);
  const list = clear($("bundle-list"));
  $("catalogue-empty").hidden = rows.length > 0;
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE_CATALOGUE));
  state.catalogue.page = Math.min(Math.max(1, state.catalogue.page), totalPages);
  const pageRows = rows.slice((state.catalogue.page - 1) * PAGE_SIZE_CATALOGUE, state.catalogue.page * PAGE_SIZE_CATALOGUE);

  for (const bundle of pageRows) {
    const percent = progressPercent(bundle);
    list.append(el("button", {
      class: "bundle-row",
      type: "button",
      onclick: () => navigate("read", { file: bundle.file }),
    }, [
      el("div", { class: "bundle-main" }, [
        el("div", { class: "bundle-name", text: bundleLabel(bundle) }),
        el("div", { class: "bundle-sub" }, [
          bundle.idol ? el("span", { class: "pill idol", style: `background:${bundle.idol.color}`, text: bundle.idol.name_ja }) : null,
          el("span", { text: bundle.bundle }),
          bundle.slot_based ? el("span", { text: "按槽位" }) : null,
          bundle.channel === "client" ? el("span", { text: "客户端" }) : null,
          // 一个大 bundle 被切成多个页面文件时，这里说清楚有几页（阅读页才分页加载）。
          Number(bundle.page_count) > 1 ? el("span", { class: "pill pages", text: `${bundle.page_count} 个数据页` }) : null,
        ]),
      ]),
      el("div", { class: "bundle-side" }, [
        el("div", { class: "progress-track" }, el("div", { class: "progress-fill", style: `width:${percent}%` })),
        el("div", { class: "bundle-counts", text: `${bundle.translated}/${bundle.total} 句 · ${percent}%${bundle.not_needed > 0 ? `（${bundle.not_needed} 行无需翻译）` : ""}` }),
      ]),
    ]));
  }

  renderPager($("catalogue-pager"), state.catalogue.page, totalPages, (page) => {
    state.catalogue.page = page;
    renderCatalogue();
  });
}

function renderPager(host, page, totalPages, onGo) {
  clear(host);
  if (totalPages <= 1) return;
  const add = (label, target, options = {}) => {
    host.append(el("button", {
      type: "button",
      text: label,
      disabled: options.disabled || false,
      class: options.active ? "active" : "",
      onclick: () => onGo(target),
    }));
  };
  add("‹ 上一页", page - 1, { disabled: page <= 1 });
  const start = Math.max(1, Math.min(page - 2, totalPages - 4));
  const end = Math.min(totalPages, start + 4);
  for (let index = start; index <= end; index += 1) add(String(index), index, { active: index === page });
  host.append(el("span", { class: "pager-info", text: `${page} / ${totalPages}` }));
  add("下一页 ›", page + 1, { disabled: page >= totalPages });
}

// ------------------------------------------------------------------ 对照阅读

/// 一个 bundle 的行可能被切成多个页面文件。目录索引里一个 bundle 只有一条记录：
/// 整包计数 + `pages[]` 在索引上，行内容在页面文件里，所以阅读页要两者都拿到。
async function findCatalogueEntry(relativeFile) {
  const category = categoryOfBundleFile(relativeFile);
  if (!category) return null;
  let index;
  try {
    index = await loadCategoryIndex(category);
  } catch (_) {
    return null; // 索引不可读就按单页处理，计数退化成这一页的，不猜。
  }
  const base = bundleBaseOfFile(relativeFile);
  const wanted = String(relativeFile);
  return (index?.bundles || []).find((entry) =>
    entry.file === wanted ||
    entry.base === base ||
    (entry.pages || []).some((page) => page?.file === wanted)) || null;
}

/// URL 里的 `file` 可能是 bundle 文件，也可能是某一页文件；`pageParam` 是显式页号。
/// 返回要抓的那一个页面文件、页号，以及整包口径的目录条目。
async function resolveReadTarget(relativeFile, pageParam) {
  const entry = await findCatalogueEntry(relativeFile);
  const explicit = Number.parseInt(pageParam ?? "", 10);
  const wanted = Number.isFinite(explicit) && explicit > 0 ? explicit : (pageNumberOfFile(relativeFile) || 1);
  const resolved = entry ? resolveBundlePage(entry, wanted) : null;
  if (resolved?.file) {
    return {
      entry,
      pages: resolved.pages,
      page: resolved.page,
      info: resolved.info,
      file: resolved.file,
      bundleFile: entry.file || relativeFile,
    };
  }
  // 索引里没有它：直接取 URL 给的文件，页信息由文件自己说（page_count 仍在文件里）。
  return { entry: null, pages: [], page: 1, info: null, file: relativeFile, bundleFile: relativeFile };
}

/// 重渲染（换筛选、翻视图内的行分页）不该重新解析页号：沿用上次的结果。
function currentReadTarget() {
  return {
    entry: state.read.entry,
    pages: state.read.pages,
    page: state.read.bundlePage,
    info: state.read.pageInfo,
    file: state.read.loadedFile,
    bundleFile: state.read.file,
  };
}

/// 一次遍历得出四个数：本地改过一行后靠它把增量算回整包计数。
function countLines(lines) {
  const counts = { total: 0, translated: 0, pending: 0, untranslated: 0, not_needed: 0 };
  for (const line of lines || []) {
    counts.total += 1;
    if (line.status === "accepted") counts.translated += 1;
    else if (line.status === "pending") counts.pending += 1;
    else if (status === "not_needed") counts.not_needed += 1;
    else counts.untranslated += 1;
  }
  return counts;
}

/// 抬头的四个数始终是**整包**口径（来自目录索引），再加上当前这一页上本地改动的增量，
/// 所以行内提交后数字立刻变，但不会退化成"这一页的计数"。
function readTotals(bundle, entry, baseline) {
  const page = countLines(bundle?.lines);
  if (!entry) return page;
  const delta = (key) => (page[key] || 0) - (baseline?.[key] || 0);
  return {
    total: Number(entry.total ?? page.total),
    translated: Number(entry.translated || 0) + delta("translated"),
    pending: Number(entry.pending || 0) + delta("pending"),
    untranslated: Number(entry.untranslated || 0) + delta("untranslated"),
    not_needed: Number(entry.not_needed || 0) + delta("not_needed"),
  };
}

async function renderRead(params = {}) {
  state.portal = state.portal || await loadPortal();
  const requested = params.file || state.read.urlFile || state.read.file;
  if (!requested) {
    navigate("catalogue");
    return;
  }

  const fileChanged = requested !== state.read.urlFile || !state.read.loadedFile;
  const target = (!fileChanged && params.p === undefined && state.read.pages.length)
    ? currentReadTarget()
    : await resolveReadTarget(requested, params.p !== undefined ? params.p : (fileChanged ? undefined : state.read.bundlePage));

  if (target.file !== state.read.loadedFile) {
    // 换资源或换数据页：只抓这一个页面文件，视图内分页回到第一屏，筛选条件原样保留。
    state.read.bundle = await loadBundle(target.file);
    state.read.baseline = countLines(state.read.bundle?.lines);
    state.read.loadedFile = target.file;
    state.read.page = 1;
    state.editing = null;
  }
  state.read.file = target.bundleFile;
  state.read.urlFile = requested;
  state.read.entry = target.entry;
  state.read.pages = target.pages;
  state.read.bundlePage = target.page;
  state.read.pageInfo = target.info;

  const bundle = state.read.bundle;
  renderHeader();

  $("read-title").textContent = bundleLabel(bundle);
  const pageCount = Math.max(1, (target.pages || []).length);
  $("read-meta").textContent = [
    CATEGORY_RULES[bundle.category]?.name,
    bundle.idol ? bundle.idol.name_ja : null,
    bundle.channel === "client" ? "客户端清单" : null,
    bundle.asset_version ? `assets ${bundle.asset_version}` : null,
    bundle.client_version ? `client ${bundle.client_version}` : null,
    pageCount > 1 ? `切为 ${pageCount} 个数据页` : null,
    bundle.repo_path,
  ].filter(Boolean).join(" · ");

  const totals = readTotals(bundle, target.entry, state.read.baseline);
  clear($("read-counts")).append(
    statBox(pageCount > 1 ? "整包行数" : "总行数", totals.total),
    statBox("已确认", totals.translated, "accepted"),
    statBox("待确认", totals.pending, "pending"),
    statBox("未翻译", totals.untranslated, "untranslated"),
    // 原文非日文的行（英文歌词）单独一格，省得看的人以为漏译了
    totals.not_needed > 0 ? statBox("无需翻译", totals.not_needed, "not_needed") : null,
  );
  renderReadPageBar();

  $("read-search").value = state.read.filters.keyword;
  $("read-status").value = state.read.filters.status;
  $("read-display").value = state.read.filters.display;
  $("read-size").value = state.read.filters.size;
  $("read-highlight").checked = state.read.filters.highlight;

  const list = $("line-list");
  list.className = `line-list mode-${state.read.filters.display} size-${state.read.filters.size}`;
  clear(list);

  const keyword = state.read.filters.keyword.trim().toLowerCase();
  const rows = (bundle.lines || []).filter((line) => {
    if (state.read.filters.status && line.status !== state.read.filters.status) return false;
    if (!keyword) return true;
    return `${line.source}\n${line.translation || ""}\n${line.item_key}`.toLowerCase().includes(keyword);
  });
  $("read-empty").hidden = rows.length > 0;

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE_READ));
  state.read.page = Math.min(Math.max(1, state.read.page), totalPages);
  const pageRows = rows.slice((state.read.page - 1) * PAGE_SIZE_READ, state.read.page * PAGE_SIZE_READ);

  for (const line of pageRows) list.append(renderLine(bundle, line));
  renderPager($("read-pager"), state.read.page, totalPages, (page) => {
    state.read.page = page;
    renderRead();
  });

  // 视图内的行号是**整包行号**（跨页连续），所以这里报的是真实的行号区间。
  const first = pageRows[0]?.index;
  const last = pageRows[pageRows.length - 1]?.index;
  $("read-window").textContent = rows.length
    ? `筛选后 ${formatNumber(rows.length)} 行 · 当前显示第 ${formatNumber(first)}–${formatNumber(last)} 行`
    : "筛选后没有匹配的行";
}

/// 数据页控件：bundle 被切成多页时才出现。59 页用 `<select>` 而不是 59 个按钮。
function renderReadPageBar() {
  const pages = state.read.pages || [];
  const nav = $("read-page-nav");
  const select = $("read-page-select");
  if (pages.length < 2) {
    nav.hidden = true;
    clear(select);
    $("read-page-info").textContent = "";
    return;
  }
  const page = state.read.bundlePage;
  nav.hidden = false;
  $("read-page-prev").disabled = page <= 1;
  $("read-page-next").disabled = page >= pages.length;
  clear(select);
  pages.forEach((item, offset) => {
    const number = offset + 1;
    const range = item.first_index ? `（${formatNumber(item.first_index)}–${formatNumber(item.last_index)} 行）` : "";
    select.append(el("option", { value: String(number), text: `第 ${number} 页${range}`, selected: number === page }));
  });
  $("read-page-total").textContent = `/ ${pages.length} 页`;
  const info = pages[page - 1] || {};
  const parts = [`第 ${page}/${pages.length} 页`];
  if (info.first_index) parts.push(`第 ${formatNumber(info.first_index)}–${formatNumber(info.last_index)} 行`);
  if (info.total !== undefined) parts.push(`本页 ${formatNumber(info.total)} 行`);
  $("read-page-info").textContent = parts.join(" · ");
}

/// 切数据页只改 URL 的 `p`：刷新、前进后退都会落到同一页，且只重新抓那一个页面文件。
function goToBundlePage(page) {
  const total = Math.max(1, (state.read.pages || []).length);
  const wanted = Math.min(Math.max(1, Math.trunc(Number(page) || 1)), total);
  if (wanted === state.read.bundlePage) return;
  navigate("read", { file: state.read.urlFile || state.read.file, p: wanted });
}

function statusLabel(status) {
  if (status === "accepted") return "已确认";
  if (status === "pending") return "待确认";
  if (status === "not_needed") return "无需翻译";
  return "未翻译";
}

function canEdit(bundle) {
  return Boolean(bundle?.edit?.path && bundle?.edit?.repo);
}

/// 写入时靠哪个字段定位这一行：`locales/**` 的行用 `item_key`，歌词行用数值 `index`
/// （生成数据在 `edit.identity_field` 里说清楚）。定位标签两种都要读得懂。
function identityLabel(bundle, line) {
  const edit = bundle?.edit || {};
  if (edit.kind === "manifest") return `slots[${line.manifest_index}]`;
  const field = edit.identity_field || "item_key";
  const value = line.item_key ?? line.index;
  return `${field}=${value}`;
}

function renderLine(bundle, line) {
  const editing = Boolean(state.editing && state.editing.itemKey === line.item_key);
  // 原文非日文又没有译文：说清"不用译"，而不是显示成漏译。
  const placeholder = line.status === "not_needed" ? "无需翻译（原文非日文）" : "未翻译";
  const body = el("div", { class: "line-body" }, [
    el("div", { class: "line-source" }, renderRichText(line.source, { highlight: state.read.filters.highlight })),
    el("div", {
      class: `line-translation${line.translation ? "" : " missing"}`,
    }, line.translation ? renderRichText(line.translation) : placeholder),
  ]);
  if (editing) body.append(renderEditor(bundle, line));

  return el("li", {
    class: `line-item status-${line.status}${editing ? " editing" : ""}`,
    id: `line-${encodeURIComponent(line.item_key)}`,
  }, [
    el("div", { class: "line-no" }, [
      String(line.index),
      el("small", { text: line.slot_index === null || line.slot_index === undefined ? line.item_key : `槽 ${line.slot_index}` }),
    ]),
    body,
    el("div", { class: "line-actions" }, [
      el("span", { class: `badge ${line.status}`, text: statusLabel(line.status) }),
      el("button", {
        class: "btn btn-ghost",
        type: "button",
        text: editing ? "取消" : "修改",
        disabled: !canEdit(bundle),
        title: canEdit(bundle) ? "用本机 Token 提交一行修改" : "该资源在上游没有可写位置",
        onclick: () => toggleEdit(line, editing),
      }),
    ]),
  ]);
}

/// 只改本地渲染状态，不动数据。
function toggleEdit(line, editing) {
  if (editing) {
    state.editing = null;
    renderRead();
    return;
  }
  if (!getToken()) {
    toast("先在「设置」里配置 GitHub Token 才能修改", "err");
    navigate("settings");
    return;
  }
  state.editing = {
    itemKey: line.item_key,
    value: line.translation || "",
    // `not_needed` 是本站判定，上游没有这个取值：开始编辑就当作"要给它加译文"，
    // 否则保存时会把一个上游不认识的状态写回去。
    status: line.status === "untranslated" || line.status === "not_needed" ? "accepted" : line.status,
  };
  renderRead();
  const input = document.querySelector(`#line-${encodeURIComponent(line.item_key)} textarea`);
  if (input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

function renderEditor(bundle, line) {
  const textarea = el("textarea", {
    spellcheck: "false",
    placeholder: "填入中文译文…",
    oninput: (event) => {
      state.editing.value = event.target.value;
      updateEditorValidation(line, event.target.value);
    },
  });
  textarea.value = state.editing.value;

  const statusSelect = el("select", { class: "input", style: "width:auto" }, [
    el("option", { value: "accepted", text: "标记为已确认", selected: state.editing.status !== "pending" }),
    el("option", { value: "pending", text: "标记为待确认", selected: state.editing.status === "pending" }),
  ]);
  statusSelect.addEventListener("change", (event) => { state.editing.status = event.target.value; });

  const aiButton = el("button", {
    class: "btn",
    type: "button",
    text: "✨ AI 草稿",
    onclick: async (event) => {
      const config = getAiConfig();
      if (!config.endpoint || !config.apiKey) {
        toast("先在「设置」里配置 AI endpoint 与 key", "err");
        return;
      }
      event.target.disabled = true;
      event.target.textContent = "生成中…";
      try {
        const result = await draftTranslation({
          item: { source: line.source, bundle: bundle.bundle, category: bundle.category },
          config,
        });
        state.editing.value = result.text;
        textarea.value = result.text;
        updateEditorValidation(line, result.text);
      } catch (error) {
        toast(`AI 草稿失败：${error.message}`, "err");
      } finally {
        event.target.disabled = false;
        event.target.textContent = "✨ AI 草稿";
      }
    },
  });

  const wrapper = el("div", { class: "line-editor" }, [
    textarea,
    el("p", { class: "editor-validation" }),
    el("div", { class: "editor-row" }, [
      aiButton,
      statusSelect,
      el("button", { class: "btn btn-primary", type: "button", text: "提交修改", onclick: () => confirmSave(bundle, line) }),
      el("button", { class: "btn btn-ghost", type: "button", text: "取消", onclick: () => { state.editing = null; renderRead(); } }),
      el("span", { class: "hint", text: `源文 ${line.source.length} 字 · ${identityLabel(bundle, line)}` }),
    ]),
  ]);
  queueMicrotask(() => updateEditorValidation(line, textarea.value));
  return wrapper;
}

function updateEditorValidation(line, value) {
  const host = document.querySelector(".line-item.editing .editor-validation");
  if (!host) return;
  clear(host);
  if (!value.trim()) {
    host.append(el("span", { class: "warn", text: "空译文不会写入。" }));
    return;
  }
  const result = checkTranslationFormat(line.source, value);
  if (!result.ok) {
    host.append(el("span", { class: "err", text: `格式问题：${result.errors.join("；")}` }));
    return;
  }
  host.append(el("span", { class: "ok", text: "格式检查通过" }));
  if (result.warnings.length) host.append(el("span", { class: "warn", text: ` · 提醒：${result.warnings.join("；")}` }));
}

/// 这一行到底该写进哪个上游文件。绝大多数行住在本 bundle 的权威文件里，但增量文件
/// （`official-<version>-*.jsonl`）覆盖过的行住在自己的文件里，必须按行上带的 edit_path 走。
function editTargetFor(bundle, line) {
  const edit = bundle.edit;
  const path = line.edit_path || edit.path;
  return path === edit.path ? edit : { ...edit, path };
}

function confirmSave(bundle, line) {
  const value = state.editing?.value ?? "";
  if (!value.trim()) {
    toast("译文为空，未提交", "err");
    return;
  }
  const edit = editTargetFor(bundle, line);
  clear($("confirm-body")).append(
    el("p", { class: "diff-line" }, [el("strong", { text: "仓库：" }), `${edit.repo} @ ${edit.ref}`]),
    el("p", { class: "diff-line" }, [el("strong", { text: "文件：" }), edit.path]),
    el("p", { class: "diff-line" }, [el("strong", { text: "定位：" }), identityLabel(bundle, line)]),
    el("p", { class: "diff-line" }, [el("strong", { text: "状态：" }), statusLabel(state.editing.status)]),
    el("p", { class: "diff-line" }, [el("strong", { text: "原文：" }), line.source]),
    el("p", { class: "diff-line diff-old", text: line.translation || "（空）" }),
    el("p", { class: "diff-line diff-new", text: value }),
  );
  $("confirm-modal").hidden = false;
  $("confirm-ok").onclick = async () => {
    $("confirm-ok").disabled = true;
    try {
      const result = await commitLineEdit({
        token: getToken(),
        edit,
        line,
        translation: value,
        status: state.editing.status,
        message: `portal: 修改 ${bundle.base} ${edit.kind === "manifest" ? `slot ${line.manifest_index}` : line.item_key}`,
      });
      hideModal("confirm");
      toast(result.changed === false
        ? "内容没有变化，未提交"
        : `已提交 ${String(result.commit?.sha || "").slice(0, 8)}：页面先显示新值，CI 重新生成后全站生效`, result.changed === false ? "" : "ok");
      line.translation = value;
      line.status = state.editing.status;
      state.editing = null;
      clearCache();
      // 计数不用在这里重算：renderRead 会拿"整包计数 + 本页增量"重新算一遍。
      await renderRead();
    } catch (error) {
      toast(`提交失败：${error instanceof WriteError ? writeErrorText(error) : error.message}`, "err");
    } finally {
      $("confirm-ok").disabled = false;
    }
  };
}

function writeErrorText(error) {
  switch (error.code) {
    case "no_token": return "没有配置 Token";
    case "not_found": return "上游文件里找不到这一行（可能已被移动）";
    case "ambiguous": return "同一 item_key 匹配到多行，已拒绝写入";
    case "source_changed": return "日文源文已变化，请刷新数据后重试";
    case "conflict": return "文件刚被改过（409），请刷新数据后重试";
    case "unauthorized": return "Token 无效";
    case "forbidden": return "Token 权限不足（需要 Contents: Read and write）";
    default: return error.message;
  }
}

// ------------------------------------------------------------------ 图片

async function renderImages() {
  state.portal = state.portal || await loadPortal();
  if (!state.images.data) state.images.data = await loadImages();
  const data = state.images.data;
  const tasks = data.tasks || [];
  const localized = tasks.filter((task) => task.has_localized).length;
  $("images-meta").textContent =
    `共 ${formatNumber(data.total)} 张图片任务 · 有中文版 ${formatNumber(localized)} · 图片随站点发布（media/）`;

  const tabs = clear($("image-category-tabs"));
  const categories = [{ id: "all", name: "全部", icon: "🖼️", count: data.categories?.all ?? data.total }].concat(
    IMAGE_CATEGORY_ORDER.map((id) => ({ id, name: IMAGE_CATEGORY_RULES[id].name, icon: IMAGE_CATEGORY_RULES[id].icon, count: data.categories?.[id] || 0 })),
  );
  for (const category of categories) {
    tabs.append(el("button", {
      class: `domain-tab${state.images.category === category.id ? " active" : ""}`,
      type: "button",
      text: `${category.icon} ${category.name}（${category.count}）`,
      onclick: () => { state.images.category = category.id; state.images.page = 1; renderImages(); },
    }));
  }

  const rows = (data.tasks || []).filter((task) => {
    if (state.images.category !== "all" && task.category !== state.images.category) return false;
    const keyword = state.images.keyword.trim().toLowerCase();
    if (!keyword) return true;
    return `${task.task_id}\n${task.bundle}\n${task.kind || ""}\n${task.category_name || ""}`.toLowerCase().includes(keyword);
  });
  if (state.images.sort === "name") rows.sort((a, b) => a.task_id.localeCompare(b.task_id));
  else if (state.images.sort === "size") rows.sort((a, b) => b.width * b.height - a.width * a.height);

  const grid = clear($("image-grid"));
  $("image-empty").hidden = rows.length > 0;
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE_CATALOGUE));
  state.images.page = Math.min(Math.max(1, state.images.page), totalPages);
  const pageRows = rows.slice((state.images.page - 1) * PAGE_SIZE_CATALOGUE, state.images.page * PAGE_SIZE_CATALOGUE);

  for (const task of pageRows) grid.append(renderImageCard(task));
  renderPager($("image-pager"), state.images.page, totalPages, (page) => {
    state.images.page = page;
    renderImages();
  });
}

/// 图片地址就是生成器给的站点内相对路径（`media/localized/...`），页面不拼对象键。
function thumbUrl(task) {
  return imageSrc(task);
}

function renderImageCard(task) {
  const thumb = el("div", { class: "image-thumb" });
  const url = thumbUrl(task);
  if (url) {
    const image = el("img", { loading: "lazy", alt: `${task.task_id}（${task.has_localized ? "中文版" : "日文原图"}）` });
    // 上游对象存储里缺图是常态：失败就换成占位文案，不留破图。
    image.addEventListener("error", () => {
      image.remove();
      if (!thumb.querySelector(".thumb-missing")) thumb.append(el("span", { class: "thumb-missing", text: "图片不可用" }));
    });
    image.src = url;
    thumb.append(image);
  } else {
    thumb.append(el("span", { class: "thumb-missing", text: "图片不可用" }));
  }
  return el("button", { class: "image-card", type: "button", onclick: () => openLightbox(task) }, [
    thumb,
    el("div", { class: "image-body" }, [
      el("div", { class: "image-id", text: task.task_id }),
      el("div", { class: "image-sub" }, [
        el("span", {
          class: `badge ${task.has_localized ? "accepted" : "original-only"}`,
          text: task.has_localized ? "已有中文版" : "仅日文原图",
        }),
        el("span", { text: `${task.width}×${task.height}` }),
        el("span", { text: task.category_name || task.category }),
      ]),
    ]),
  ]);
}

function openLightbox(task) {
  state.lightbox = { task };
  renderLightbox();
  $("lightbox").hidden = false;
}

function renderLightbox() {
  const { task } = state.lightbox;
  const src = imageSrc(task);
  const reference = originalReference(task);

  $("lightbox-title").textContent = task.task_id;
  lightboxImage("lightbox-image", "lightbox-image-missing", src, `${task.task_id} 中文版`);

  const meta = clear($("lightbox-meta"));
  meta.append(
    el("span", { text: `${formatNumber(task.width)}×${formatNumber(task.height)}` }),
    el("span", { text: `资源：${task.bundle}` }),
    el("span", { text: `分类：${task.category_name || task.category}` }),
    el("span", { text: `上游审核：${String(task.review_status || "").trim() || "（未提供）"}` }),
  );
  if (reference && !reference.published) {
    // 日文原图没有发布：只把清单里的定位信息摆出来，绝不给一个会 404 的地址。
    meta.append(el("span", { class: "warn", text: "上游未发布日文原图，这里只能看中文版" }));
    meta.append(el("span", { class: "hint", text: `原图 sha256：${reference.sha || "（未提供）"}` }));
    if (reference.path) meta.append(el("span", { class: "hint", text: `原图路径：${reference.path}` }));
  }

  const download = $("lightbox-download");
  if (src) {
    download.href = src;
    download.setAttribute("download", task.localized_file || `${String(task.task_id).replace(/[^\w.-]+/g, "_")}.png`);
    download.hidden = false;
  } else {
    download.removeAttribute("href");
    download.hidden = true;
  }
}

/// 加载失败就把 img 换成占位文案，不留破图（本地演示数据没有 media/，这是常态）。
function lightboxImage(imgId, missingId, url, alt) {
  const image = $(imgId);
  const missing = $(missingId);
  image.hidden = false;
  missing.hidden = true;
  image.onerror = null;
  if (!url) {
    image.removeAttribute("src");
    image.hidden = true;
    missing.hidden = false;
    missing.textContent = "图片不可用（清单里没有中文版文件）";
    return;
  }
  image.onerror = () => {
    image.hidden = true;
    missing.hidden = false;
    missing.textContent = "图片不可用（站点里没有这个文件）";
  };
  image.alt = alt;
  image.src = url;
}

// ------------------------------------------------------------------ 设置

/// 两个 Token 入口都指向 GitHub 自己的页面，本站不做任何中转：细粒度新建页按仓库+权限自己勾，
/// 经典 token 链接预勾 public_repo（公开仓库够用）。具体怎么勾看卡片里的分步说明。
/// 真 OAuth 在纯静态站点上做不到 —— `github.com/login/oauth/*` 与 `/login/device/code`
/// 都不返回 `Access-Control-Allow-Origin`，浏览器连设备码都拿不到，换码还需要 client_secret。
function renderTokenEntry(assetsRepo) {
  const description = encodeURIComponent("MLTD 翻译查阅站（单行提交）");
  $("pat-create-fine").href = "https://github.com/settings/personal-access-tokens/new";
  $("pat-create-classic").href = `https://github.com/settings/tokens/new?scopes=public_repo&description=${description}`;
  // 分步说明里要勾的仓库名从数据里取，不写死
  $("pat-guide-repo").textContent = assetsRepo || "kohakunamori/MLTDTranslationAssets";
}

async function renderSettings() {
  state.portal = state.portal || await loadPortal();
  renderHeader();
  const portal = state.portal;

  $("pat-input").value = getToken();
  renderTokenEntry(portal.sources?.assets?.repo || "");
  const ai = getAiConfig();
  $("ai-endpoint").value = ai.endpoint || "";
  $("ai-key").value = ai.apiKey || "";
  $("ai-model").value = ai.model || "";

  const sources = clear($("settings-sources"));
  const rows = [
    ["数据生成时间", portal.generated_at || "未知"],
    ["资源仓库", `${portal.sources?.assets?.repo || "—"} @ ${portal.sources?.assets?.ref || "—"}`],
    ["资源 commit", portal.sources?.assets?.commit || "（未提供）"],
    ["客户端仓库", `${portal.sources?.client?.repo || "—"} @ ${portal.sources?.client?.ref || "—"}`],
    ["客户端 commit", portal.sources?.client?.commit || "（未提供）"],
    ["Assets 版本", portal.releases?.assets?.asset_version || "—"],
    ["Client 版本", portal.releases?.client?.client_version || "—"],
    ["数据文件数（含分页）", formatNumber(portal.totals?.files || 0)],
    ["图片基址", portal.image_base || "—"],
    ["数据入口", dataUrl("portal.json")],
  ];
  for (const [key, value] of rows) sources.append(el("dt", { text: key }), el("dd", { text: value }));

  updatePatStatus(getToken() ? "已保存 Token（未验证）" : "未配置 Token：整站只读", "");
}

function updatePatStatus(text, kind) {
  const node = $("pat-status");
  node.textContent = text;
  node.className = `settings-status ${kind}`.trim();
}

// ------------------------------------------------------------------ 事件绑定

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function bindEvents() {
  $("logo-home").addEventListener("click", (event) => { event.preventDefault(); navigate("overview"); });
  // 密码输入框放在 <form> 里 Chrome 才不报 "Password field is not contained in a form"；
  // 这两行表单不提交到任何地方，只是把输入框圈起来。
  for (const id of ["pat-form", "ai-form"]) {
    $(id).addEventListener("submit", (event) => event.preventDefault());
  }
  for (const button of document.querySelectorAll(".nav-btn")) {
    button.addEventListener("click", () => navigate(button.dataset.nav));
  }
  for (const node of document.querySelectorAll("[data-close]")) {
    node.addEventListener("click", () => hideModal(node.dataset.close));
  }

  $("hero-random-song").addEventListener("click", async () => {
    const index = await loadCategoryIndex("lyrics");
    const songs = index.bundles || [];
    if (!songs.length) return;
    navigate("read", { file: songs[Math.floor(Math.random() * songs.length)].file });
  });
  $("hero-untranslated").addEventListener("click", () => {
    state.catalogue.filters.status = "untranslated";
    state.catalogue.filters.sort = "progress-asc";
    state.catalogue.page = 1;
    navigate("catalogue", { category: "lyrics", status: "untranslated", sort: "progress-asc" });
  });
  $("btn-reload-data").addEventListener("click", () => reloadData());
  $("settings-reload").addEventListener("click", () => reloadData());

  $("song-search").addEventListener("input", debounce((event) => {
    state.songKeyword = event.target.value;
    renderSongGrid();
  }, 150));

  $("catalogue-back").addEventListener("click", () => navigate("overview"));
  $("read-back").addEventListener("click", () => navigate("catalogue", { category: state.read.bundle?.category || "lyrics" }));

  $("filter-category").addEventListener("change", (event) => {
    state.catalogue.page = 1;
    state.catalogue.filters.idol = "";
    navigate("catalogue", { category: event.target.value });
  });
  $("filter-idol").addEventListener("change", (event) => { state.catalogue.filters.idol = event.target.value; state.catalogue.page = 1; renderCatalogue(); });
  $("filter-status").addEventListener("change", (event) => { state.catalogue.filters.status = event.target.value; state.catalogue.page = 1; renderCatalogue(); });
  $("filter-channel").addEventListener("change", (event) => { state.catalogue.filters.channel = event.target.value; state.catalogue.page = 1; renderCatalogue(); });
  $("filter-sort").addEventListener("change", (event) => { state.catalogue.filters.sort = event.target.value; renderCatalogue(); });
  $("filter-keyword").addEventListener("input", debounce((event) => {
    state.catalogue.filters.keyword = event.target.value;
    state.catalogue.page = 1;
    renderCatalogue();
  }, 150));

  $("read-search").addEventListener("input", debounce((event) => {
    state.read.filters.keyword = event.target.value;
    state.read.page = 1;
    renderRead();
  }, 150));
  $("read-page-prev").addEventListener("click", () => goToBundlePage(state.read.bundlePage - 1));
  $("read-page-next").addEventListener("click", () => goToBundlePage(state.read.bundlePage + 1));
  $("read-page-select").addEventListener("change", (event) => goToBundlePage(event.target.value));
  $("read-status").addEventListener("change", (event) => { state.read.filters.status = event.target.value; state.read.page = 1; renderRead(); });
  $("read-display").addEventListener("change", (event) => { state.read.filters.display = event.target.value; renderRead(); });
  $("read-size").addEventListener("change", (event) => { state.read.filters.size = event.target.value; renderRead(); });
  $("read-highlight").addEventListener("change", (event) => { state.read.filters.highlight = event.target.checked; renderRead(); });

  $("image-sort").addEventListener("change", (event) => { state.images.sort = event.target.value; renderImages(); });
  $("image-search").addEventListener("input", debounce((event) => {
    state.images.keyword = event.target.value;
    state.images.page = 1;
    renderImages();
  }, 150));

  $("pat-save").addEventListener("click", () => {
    const value = $("pat-input").value.trim();
    setToken(value);
    state.writeStatus = null;
    updatePatStatus(value ? "已保存到本机 localStorage" : "已清除 Token：整站只读", value ? "ok" : "");
    renderHeader();
    toast(value ? "Token 已保存在本机" : "Token 已清除", "ok");
  });
  $("pat-toggle-vis").addEventListener("click", (event) => {
    const input = $("pat-input");
    const hidden = input.type === "password";
    input.type = hidden ? "text" : "password";
    event.target.textContent = hidden ? "隐藏" : "显示";
  });
  $("pat-clear").addEventListener("click", () => {
    setToken("");
    $("pat-input").value = "";
    state.writeStatus = null;
    updatePatStatus("已清除 Token：整站只读", "");
    renderHeader();
  });
  $("pat-verify").addEventListener("click", async () => {
    const token = $("pat-input").value.trim() || getToken();
    if (!token) {
      updatePatStatus("没有可验证的 Token", "err");
      return;
    }
    updatePatStatus("验证中…", "");
    try {
      const repo = state.portal?.sources?.assets?.repo || "";
      const status = await verifyToken({ token, repo });
      state.writeStatus = status;
      if (status.canPush) {
        updatePatStatus(
          `✓ 已登录 @${status.login}：对 ${repo} 有写权限，可以直接在阅读页改了` +
          `${status.scopes?.length ? `（scopes: ${status.scopes.join(", ")}）` : "（细粒度 token）"}`,
          "ok",
        );
      } else {
        // 说清楚到底缺哪一步，而不是只说"未确认写权限"。
        const why = status.repo?.visible === false
          ? `这个 Token 看不到 ${repo}（经典 Token 需要 public_repo，细粒度 Token 需要在 Repository access 里选中它）`
          : `这个 Token 对 ${repo} 只有 ${status.repo?.permission === "read" ? "读" : "受限"}权限，需要在 Permissions 里把 Contents 设为 Read and write`;
        // 细粒度 Token 可以直接 Edit 改权限（token 值不变）；经典 Token 的 scope 只能重建。
        updatePatStatus(`✗ 已登录 @${status.login}，但还不能写入：${why}。细粒度 Token 改完保存即可（值不变），经典 Token 需要重新生成。`, "err");
      }
      renderHeader();
    } catch (error) {
      updatePatStatus(`验证失败：${error.message}`, "err");
    }
  });

  $("ai-save").addEventListener("click", () => {
    setAiConfig({ endpoint: $("ai-endpoint").value, apiKey: $("ai-key").value, model: $("ai-model").value });
    $("ai-status").textContent = "已保存在本机 localStorage";
    $("ai-status").className = "settings-status ok";
  });
  $("ai-clear").addEventListener("click", () => {
    setAiConfig({ endpoint: "", apiKey: "", model: "" });
    $("ai-endpoint").value = "";
    $("ai-key").value = "";
    $("ai-model").value = "";
    $("ai-status").textContent = "已清除 AI 配置";
    $("ai-status").className = "settings-status";
  });
  $("ai-test").addEventListener("click", async () => {
    const config = { endpoint: $("ai-endpoint").value, apiKey: $("ai-key").value, model: $("ai-model").value };
    $("ai-status").textContent = "测试中…";
    $("ai-status").className = "settings-status";
    try {
      const result = await testAiConnection({ config });
      $("ai-status").textContent = `连接成功（model: ${result.model || config.model || "未知"}）`;
      $("ai-status").className = "settings-status ok";
    } catch (error) {
      $("ai-status").textContent = `连接失败：${error.message}`;
      $("ai-status").className = "settings-status err";
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideModal("confirm");
      hideModal("lightbox");
    }
  });
  window.addEventListener("hashchange", () => { applyRoute().catch(showError); });
}

function showFatal(message) {
  $("fatal-detail").textContent = message;
  $("fatal").hidden = false;
  $("main").hidden = true;
}

function showError(error) {
  if (error instanceof DataError) {
    showFatal(error.message);
    return;
  }
  console.error(error);
  toast(`出错了：${error.message}`, "err");
}

async function reloadData() {
  clearCache();
  state.images.data = null;
  state.read.bundle = null;
  state.read.loadedFile = "";
  state.read.pages = [];
  state.read.entry = null;
  try {
    await applyRoute();
    toast("数据已重新拉取", "ok");
  } catch (error) {
    showError(error);
  }
}

async function init() {
  bindEvents();
  try {
    state.portal = await loadPortal();
  } catch (error) {
    showFatal(error.message);
    return;
  }
  renderHeader();
  await applyRoute();
}

init().catch(showError);

// 离线测试入口：把页面真正使用的函数暴露出来，测试驱动与浏览器同一份代码。
if (typeof window !== "undefined") {
  window.__portalTestHooks = {
    state,
    applyRoute,
    loadPortal,
    loadCategoryIndex,
    loadBundle,
    loadImages,
    renderRichText,
    filterBundles,
    percentOf,
  progressPercent,
    bundleLabel,
    checkTranslationFormat,
    canEdit,
    navigate,
    // 分页与图片相关的纯函数，离线测试不用起浏览器也能验。
    resolveReadTarget,
    resolveBundlePage,
    categoryOfBundleFile,
    bundleBaseOfFile,
    pageNumberOfFile,
    countLines,
    readTotals,
    identityLabel,
    editTargetFor,
    imageSrc,
    originalReference,
    goToBundlePage,
  };
}
