// MLTD 翻译查阅站 —— 纯静态前端。
//
// 读取生成数据与完整图片；用户可用本机 GitHub Token 修改译文或保存图片汉化需求。
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
import { WriteError, getToken, setToken, verifyToken } from "./lib/github-write.js";
import { commitEdit } from "./lib/relay-write.js";
import { checkTranslationFormat, draftTranslation, getAiConfig, setAiConfig, testAiConnection } from "./lib/ai-draft.js";
import { paginate } from "./lib/pagination.js";
import { IMAGE_STATUSES, filterImageTasks, imageDisplayReady, imageStatus } from "./lib/images.js";
import { displayImageBlob, loadDisplayImage } from "./lib/image-renderer.js";
import { applyImageReviews, commitImageReview, loadImageReviews } from "./lib/image-review.js";
import { countLines, readTotals } from "./lib/read-stats.js";
import { $, clear, el, formatNumber, hideModal, renderRichText, toast } from "./lib/ui.js";
import { groupSongs, primaryVersion, singerOptions, singerSummary, songKey, versionLabel, versionsOf } from "./lib/songs.js";
import { CAST_TYPES, castType, filterSongPresentation, matchingVersions } from "./lib/library.js";
import { createLibraryUi } from "./lib/library-ui.js";

const PAGE_SIZE_CATALOGUE = 24;
const PAGE_SIZE_READ = 200;

const state = {
  portal: null,
  view: "overview",
  domain: "all",
  songKeyword: "",
  songIdol: "",
  songAttribute: "",
  songCast: "",
  songGrouped: true,
  songPage: 1,
  songRenderId: 0,
  writeStatus: null,
  catalogue: { category: "lyrics", bundles: [], page: 1, filters: { idol: "", status: "", channel: "", keyword: "", sort: "default", groupSongs: true, attribute: "", cast: "" } },
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
    renderId: 0,
    page: 1,
    filters: { keyword: "", status: "", display: "both", size: "normal", highlight: true },
  },
  editing: null,
  images: { data: null, category: "all", status: "all", original: "all", keyword: "", sort: "default", page: 1, reviewBusy: false, reviewUndo: null, reviewMessage: "" },
  lightbox: null,
};

// ------------------------------------------------------------------ 路由

const libraryUi = createLibraryUi({ $, el, clear, navigate, renderPager, toast, renderSongCard, state });

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
  const known = ["overview", "catalogue", "read", "images", "settings", "idols", "idol", "topics", "topic", "personal", "compare", "search"];
  const nextView = known.includes(view) ? view : "overview";
  libraryUi.beforeRoute(nextView);
  state.view = nextView;
  for (const section of document.querySelectorAll(".view")) section.hidden = true;
  $(`view-${state.view}`).hidden = false;
  for (const button of document.querySelectorAll(".nav-btn")) {
    button.classList.toggle("active", button.dataset.nav === state.view);
  }

  if (state.view === "overview") await renderOverview();
  else if (state.view === "catalogue") await renderCatalogue(params);
  else if (state.view === "read") await renderRead(params);
  else if (state.view === "images") await renderImages(params);
  else if (state.view === "settings") await renderSettings();
  else await libraryUi.render(state.view, params);
  window.scrollTo({ top: 0 });
  await libraryUi.afterRoute(params);
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
    `内容更新于 ${portal.generated_at ? new Date(portal.generated_at).toLocaleString("zh-CN") : "未知时间"}`,
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
  const renderId = ++state.songRenderId;
  const empty = $("song-grid-empty");
  let index;
  try {
    index = await loadCategoryIndex("lyrics");
  } catch (error) {
    if (renderId !== state.songRenderId) return;
    clear($("song-grid"));
    clear($("song-grid-pager"));
    $("song-grid-count").textContent = "";
    empty.hidden = false;
    empty.textContent = `歌曲索引无法载入：${error.message}`;
    return;
  }
  if (renderId !== state.songRenderId) return;
  const bundles = index.bundles || [];
  const idolSelect = clear($("song-idol"));
  idolSelect.append(el("option", { value: "", text: "全部偶像" }));
  const idols = singerOptions(bundles);
  if (state.songIdol && !idols.some((idol) => idol.code === state.songIdol)) state.songIdol = "";
  for (const idol of idols) idolSelect.append(el("option", {
    value: idol.code, text: idol.name_zh || idol.name_ja, selected: state.songIdol === idol.code,
  }));
  $("song-group").checked = state.songGrouped;
  $("song-attribute").value = state.songAttribute;
  $("song-cast").value = state.songCast;
  const filters = { idol: state.songIdol, attribute: state.songAttribute, cast: state.songCast };
  const songs = filterSongPresentation(filterBundles(state.songGrouped ? groupSongs(bundles) : bundles,
    { keyword: state.songKeyword, idol: state.songIdol }), filters).sort((a, b) =>
      (Number(a.song?.mst_song_id) || Infinity) - (Number(b.song?.mst_song_id) || Infinity)
      || bundleLabel(a).localeCompare(bundleLabel(b), "ja"));
  const totalPages = Math.max(1, Math.ceil(songs.length / PAGE_SIZE_CATALOGUE));
  state.songPage = Math.min(Math.max(1, state.songPage), totalPages);
  const pageRows = songs.slice((state.songPage - 1) * PAGE_SIZE_CATALOGUE, state.songPage * PAGE_SIZE_CATALOGUE);
  const versions = songs.reduce((sum, song) => sum + versionsOf(song).length, 0);
  $("song-grid-count").textContent = state.songGrouped
    ? `${songs.length} 首歌曲 · ${versions} 个歌词版本 · 展开歌曲可选择版本`
    : `${songs.length} 个歌词版本 · 同曲的版本分别展示`;
  const grid = clear($("song-grid"));
  empty.hidden = songs.length > 0;
  if (!songs.length) empty.textContent = "没有匹配的歌曲。";
  for (const song of pageRows) grid.append(renderSongCard(song, state.songIdol, false, filters));
  renderPager($("song-grid-pager"), state.songPage, totalPages, (next) => {
    state.songPage = next;
    renderSongGrid();
  });
}

function renderSongCard(song, idol = "", compact = false, filters = {}) {
  const matching = matchingVersions(song, { ...filters, idol });
  const primary = matching[0] || primaryVersion(song, idol);
  const versions = versionsOf(song);
  const percent = progressPercent(song);
  const card = el("article", { class: `song-card${compact ? " song-list-card" : ""}` },
    el("button", { class: "song-open", type: "button", onclick: () => navigate("read", { file: primary.file }) }, [
      el("div", { class: "song-name", text: bundleLabel(primary) }),
      el("div", { class: "song-sub", text: [primary.song?.type, CAST_TYPES[castType(primary)], `${versions.length} 个歌词版本`].filter(Boolean).join(" · ") }),
      el("div", { class: "song-sub song-cast", text: `默认演唱：${singerSummary(primary)}` }),
      idol ? el("span", { class: "pill", text: `${primary.song?.default_singers?.find((singer) => singer.code === idol)?.name_zh || "所选偶像"}参与演唱` }) : null,
      (filters.attribute || filters.cast) ? el("span", { class: "pill", text: `${matching.length} 个版本符合筛选` }) : null,
      el("div", { class: "progress-track" }, el("div", { class: "progress-fill", style: `width:${percent}%` })),
      el("div", { class: "song-foot" }, [
        el("span", { text: `${versions.length > 1 ? "各版本合计 · " : ""}${song.translated}/${song.total} 句` }),
        el("span", { text: `${percent}%` }),
      ]),
    ]));
  if (versions.length > 1) {
    card.append(el("details", { class: "song-versions" }, [
      el("summary", { text: `展开 ${versions.length} 个版本` }),
      el("div", { class: "song-version-list" }, versions.map((version, index) =>
        el("button", { type: "button", class: "song-version", onclick: () => navigate("read", { file: version.file }) }, [
          el("span", { text: `${versionLabel(version, index)} · ${progressPercent(version)}%` }),
          el("span", { class: "hint", text: singerSummary(version) }),
        ]))),
    ]));
  }
  const actions = el("div", { class: "library-actions" }, libraryUi.favoriteButton(primary));
  if (versions.length > 1) actions.append(el("button", { type: "button", class: "btn btn-ghost", text: "版本对照", onclick: () => navigate("compare", { file: primary.file }) }));
  card.append(actions);
  return card;
}

// ------------------------------------------------------------------ 索引浏览

/// 筛选下拉里带上当前分类的真实数量，让人一眼看出筛完还剩多少：
/// 「未翻译（1,067 行 · 12 个资源）」。数量基于**当前已加载的分类**，不跨分类瞎算。
function labelStatusOptions(bundles) {
  const unit = state.catalogue.category === "lyrics"
    ? (state.catalogue.filters.groupSongs ? "首歌曲" : "个歌词版本") : "个资源";
  const count = (predicate) => bundles.filter(predicate).length;
  const sum = (pick) => bundles.reduce((total, bundle) => total + pick(bundle), 0);
  const labels = {
    "": `全部（${formatNumber(bundles.length)} 个资源）`,
    untranslated: `未翻译（${formatNumber(sum((b) => b.untranslated))} 行 · ${formatNumber(count((b) => b.untranslated > 0))} 个资源）`,
    pending: `待确认（${formatNumber(sum((b) => b.pending))} 行 · ${formatNumber(count((b) => b.pending > 0))} 个资源）`,
    complete: `已翻译（全部译完 · ${formatNumber(count((b) => b.untranslated === 0 && b.pending === 0))} 个资源）`,
  };
  for (const option of $("filter-status").options) {
    if (labels[option.value] !== undefined) option.textContent = labels[option.value].replaceAll("个资源", unit);
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
  const lyrics = category === "lyrics";
  const presentation = lyrics && state.catalogue.filters.groupSongs ? groupSongs(state.catalogue.bundles) : state.catalogue.bundles;
  $("filter-song-group-field").hidden = !lyrics;
  $("filter-song-attribute-field").hidden = !lyrics;
  $("filter-song-cast-field").hidden = !lyrics;
  $("filter-song-attribute").value = state.catalogue.filters.attribute;
  $("filter-song-cast").value = state.catalogue.filters.cast;
  $("filter-song-group").checked = state.catalogue.filters.groupSongs;
  $("filter-idol-label").textContent = lyrics ? "默认歌唱偶像" : "偶像";
  const meta = CATEGORY_RULES[category];
  $("catalogue-title").textContent = `${meta.icon} ${meta.name}`;
  // 分类卡片说"几个资源"；这里再补一句数据文件数（分页后文件数会大于资源数）。
  const categoryMeta = (state.portal.categories || []).find((item) => item.id === category);
  const files = Number(categoryMeta?.files || 0);
  $("catalogue-meta").textContent = [
    lyrics ? `${groupSongs(state.catalogue.bundles).length} 首歌曲 · ${index.total_bundles} 个歌词版本` : `${index.total_bundles} 个资源`,
    `共 ${formatNumber(state.catalogue.bundles.reduce((sum, item) => sum + item.total, 0))} 行`,
    !lyrics && files > index.total_bundles ? `切成 ${formatNumber(files)} 个数据文件` : null,
    meta.description,
  ].filter(Boolean).join(" · ");

  const idolSelect = clear($("filter-idol"));
  idolSelect.append(el("option", { value: "", text: "全部" }));
  const idols = new Map();
  if (lyrics) {
    for (const idol of singerOptions(state.catalogue.bundles)) idols.set(idol.code, idol);
  } else {
    for (const bundle of state.catalogue.bundles) if (bundle.idol?.code) idols.set(bundle.idol.code, bundle.idol);
  }
  if (state.catalogue.filters.idol && !idols.has(state.catalogue.filters.idol)) state.catalogue.filters.idol = "";
  for (const idol of [...idols.values()].sort((a, b) => a.code.localeCompare(b.code))) {
    idolSelect.append(el("option", {
      value: idol.code,
      text: lyrics ? (idol.name_zh || idol.name_ja) : `${idol.name_ja}（${idol.code}）`,
      selected: state.catalogue.filters.idol === idol.code,
    }));
  }

  $("filter-status").value = state.catalogue.filters.status;
  $("filter-sort").value = state.catalogue.filters.sort;
  $("filter-keyword").value = state.catalogue.filters.keyword;
  $("filter-channel").value = state.catalogue.filters.channel;
  labelStatusOptions(presentation);

  const filtered = filterBundles(presentation, state.catalogue.filters);
  const rows = lyrics ? filterSongPresentation(filtered, state.catalogue.filters) : filtered;
  $("catalogue-results").textContent = lyrics
    ? (state.catalogue.filters.groupSongs ? `找到 ${rows.length} 首歌曲` : `找到 ${rows.length} 个歌词版本`)
    : `找到 ${rows.length} 个资源`;
  const list = clear($("bundle-list"));
  $("catalogue-empty").hidden = rows.length > 0;
  const page = paginate(rows, state.catalogue.page, PAGE_SIZE_CATALOGUE);
  state.catalogue.page = page.page;

  for (const bundle of page.rows) {
    if (lyrics) {
      list.append(renderSongCard(bundle, state.catalogue.filters.idol, true, state.catalogue.filters));
      continue;
    }
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

  renderPager($("catalogue-pager"), page.page, page.totalPages, (nextPage) => {
    state.catalogue.page = nextPage;
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

async function renderRead(params = {}) {
  const request = ++state.read.renderId;
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
  if (request !== state.read.renderId || state.view !== "read") return;

  if (target.file !== state.read.loadedFile) {
    // 换资源或换数据页：只抓这一个页面文件，视图内分页回到第一屏，筛选条件原样保留。
    const loaded = await loadBundle(target.file);
    if (request !== state.read.renderId || state.view !== "read") return;
    state.read.bundle = loaded;
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
  $("read-meta").textContent = (bundle.category === "lyrics" ? [
    "歌曲歌词", `默认演唱：${singerSummary(target.entry || bundle)}`,
  ] : [
    CATEGORY_RULES[bundle.reading_category || bundle.category]?.name,
    bundle.topic?.chapter_label,
    pageCount > 1 ? `共 ${pageCount} 页` : null,
  ]).filter(Boolean).join(" · ");

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
  await renderReadSongOptions(bundle, target.entry);
  if (request !== state.read.renderId || state.view !== "read") return;
  if (params.l !== undefined) { state.read.filters.keyword = ""; state.read.filters.status = ""; }

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

  if (params.l !== undefined) {
    const focusIndex = rows.findIndex((line) => String(line.item_key) === String(params.l));
    if (focusIndex >= 0) state.read.page = Math.floor(focusIndex / PAGE_SIZE_READ) + 1;
  }

  const page = paginate(rows, state.read.page, PAGE_SIZE_READ);
  state.read.page = page.page;

  for (const line of page.rows) list.append(renderLine(bundle, line));
  renderPager($("read-pager"), page.page, page.totalPages, (nextPage) => {
    state.read.page = nextPage;
    renderRead();
  });

  // 视图内的行号是**整包行号**（跨页连续），所以这里报的是真实的行号区间。
  const first = page.rows[0]?.index;
  const last = page.rows[page.rows.length - 1]?.index;
  $("read-window").textContent = rows.length
    ? `筛选后 ${formatNumber(rows.length)} 行 · 当前显示第 ${formatNumber(first)}–${formatNumber(last)} 行`
    : "筛选后没有匹配的行";
  await libraryUi.afterRead(bundle, target.entry, params);
}

/// 数据页控件：bundle 被切成多页时才出现。59 页用 `<select>` 而不是 59 个按钮。
async function renderReadSongOptions(bundle, entry) {
  const host = $("read-song-options");
  const select = clear($("read-song-version"));
  host.hidden = bundle.category !== "lyrics" || !bundle.song;
  if (host.hidden) return;
  const index = await loadCategoryIndex("lyrics");
  const current = entry || bundle;
  const group = groupSongs(index.bundles || []).find((song) => songKey(song) === songKey(current));
  const versions = group ? versionsOf(group) : [current];
  for (const [offset, version] of versions.entries()) select.append(el("option", {
    value: version.file,
    text: `${versionLabel(version, offset)} · ${singerSummary(version)}`,
    selected: version.file === state.read.file,
  }));
  select.disabled = versions.length < 2;
  const singers = current.song?.default_singers || [];
  $("read-song-singers-summary").textContent = `默认演唱：${singerSummary(current)}`;
  $("read-song-singers").textContent = singers.length
    ? singers.map((idol) => idol.name_zh || idol.name_ja).join("、") : "这首歌的演唱信息尚待补充。";
}

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
    "data-line-key": line.item_key,
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
      const result = await commitEdit({
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
        : `已提交 ${String(result.commit?.sha || "").slice(0, 8)}：页面先显示新值，等下一次重新生成数据后全站生效`, result.changed === false ? "" : "ok");
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
    // GitHub 的文件接口对超过 1MB 的文件不给内容。自托管那边由服务器代劳，不会走到这里；
    // 走到这里说明没连上中继，而这一行住在一个大文件里。
    case "unsupported_encoding": return "这个文件太大，浏览器直连改不了（没连上服务器中继）——稍后重试，或换一个较小的文件";
    default: return error.message;
  }
}

// ------------------------------------------------------------------ 图片

function navigateImages(changes = {}) {
  const filters = { ...state.images, keyword: $("image-search").value, page: 1, ...changes };
  const params = {};
  for (const key of ["category", "status", "original"]) if (filters[key] !== "all") params[key] = filters[key];
  if (filters.keyword.trim()) params.q = filters.keyword.trim();
  if (filters.sort !== "default") params.sort = filters.sort;
  if (filters.page > 1) params.p = filters.page;
  navigate("images", params);
}

async function renderImages(params = {}) {
  state.portal = state.portal || await loadPortal();
  if (!state.images.data) {
    state.images.data = await loadImages();
    try {
      applyImageReviews(state.images.data.tasks || [], await loadImageReviews({ ...state.portal.sources.assets, token: getToken() }));
    } catch {
      state.images.reviewMessage = "未能读取最新图片标记，当前显示已生成的数据；保存时会检查冲突。";
    }
  }
  if (state.view !== "images") return;
  const filters = state.images;
  filters.category = Object.hasOwn(IMAGE_CATEGORY_RULES, params.category) ? params.category : "all";
  filters.status = params.status === "unlocalized" || Object.hasOwn(IMAGE_STATUSES, params.status) ? params.status : "all";
  filters.original = ["available", "missing"].includes(params.original) ? params.original : "all";
  filters.keyword = params.q || "";
  filters.sort = ["name", "size"].includes(params.sort) ? params.sort : "default";
  filters.page = Math.max(1, Number(params.p) || 1);
  const data = state.images.data;
  const tasks = data.tasks || [];
  renderImageReviewFeedback();
  const inventoryCount = data.inventory_bundle_count || 0;
  const thumbnailCount = data.thumbnail_bundle_count || 0;
  $("images-meta").textContent = `已收录 ${formatNumber(data.texture_count ?? tasks.length)} 张图片 · 另有 ${formatNumber(inventoryCount)} 个待确认资源包`
    + (thumbnailCount ? ` · ${formatNumber(thumbnailCount)} 个缩略图资源包` : "");
  $("images-coverage-note").textContent = data.coverage?.available
    ? "待确认资源包含尚未提取或审核的图片，也可能包含无需汉化的缩略图、插画。资源包数不等于图片张数。"
      + (thumbnailCount ? "缩略图由原图自动生成，不单独翻译；原图未汉化时缩略图同样是日文。" : "")
    : "当前数据尚未提供完整图片目录，列表数量不代表全部待汉化图片。";
  const summary = clear($("image-summary"));
  const unlocalized = tasks.filter((task) => ["original_only", "pending"].includes(imageStatus(task))).length;
  for (const [id, meta] of Object.entries(IMAGE_STATUSES)) {
    const count = tasks.filter((task) => imageStatus(task) === id).length;
    summary.append(statBox(id === "original_only" ? "未汉化（含待确认）" : meta.name, id === "original_only" ? unlocalized : count, meta.badge));
    $("image-status").querySelector(`option[value="${id}"]`).textContent = `${id === "original_only" ? "已收录未汉化" : meta.name}（${formatNumber(count)}）`;
  }
  $("image-status").querySelector('option[value="unlocalized"]').textContent = `未汉化（含待确认） · ${formatNumber(unlocalized)}`;
  $("image-status").value = filters.status;
  $("image-original").value = filters.original;
  $("image-search").value = filters.keyword;
  $("image-sort").value = filters.sort;

  const tabs = clear($("image-category-tabs"));
  const categories = [{ id: "all", name: "全部", icon: "🖼️", count: data.categories?.all ?? data.total }].concat(
    IMAGE_CATEGORY_ORDER.map((id) => ({ id, name: IMAGE_CATEGORY_RULES[id].name, icon: IMAGE_CATEGORY_RULES[id].icon, count: data.categories?.[id] || 0 })),
  );
  for (const category of categories) {
    tabs.append(el("button", {
      class: `domain-tab${state.images.category === category.id ? " active" : ""}`,
      type: "button",
      text: `${category.icon} ${category.name}（${category.count}）`,
      "aria-pressed": state.images.category === category.id ? "true" : "false",
      onclick: () => navigateImages({ category: category.id }),
    }));
  }

  const rows = filterImageTasks(tasks, filters);

  const grid = clear($("image-grid"));
  $("image-empty").hidden = rows.length > 0;
  const page = paginate(rows, state.images.page, PAGE_SIZE_CATALOGUE);
  state.images.page = page.page;
  $("image-results").textContent = `找到 ${formatNumber(rows.length)} 条记录${rows.length ? ` · 第 ${page.page} / ${page.totalPages} 页` : ""}`;

  for (const task of page.rows) grid.append(renderImageCard(task));
  renderPager($("image-pager"), page.page, page.totalPages, (nextPage) => {
    navigateImages({ page: nextPage });
  });
}

function imageMissingText(task, side) {
  if (imageSrc(task, side) && !imageDisplayReady(task, side)) return "完整图尚未拼接";
  if (side === "original") {
    if (task.original_issue) return task.original_issue;
    if (task.kind === "bundle_thumbnail") return "缩略图由原图生成，尚未提取";
    return task.kind === "bundle_inventory" ? "尚未提取原图" : "原图尚未发布";
  }
  const status = imageStatus(task);
  if (status === "localized") return "汉化图片暂不可用";
  if (status === "not_needed") return "无需汉化";
  if (status === "derived") return "缩略图随原图汉化，暂不可查看";
  if (status === "pending") return "待确认汉化需求或审核结果";
  return "尚未汉化";
}

function renderImagePreview(task, side) {
  const thumb = el("div", { class: "image-thumb" });
  const label = side === "original" ? "日文原图" : "汉化图片";
  if (imageDisplayReady(task, side)) {
    const canvas = el("canvas", { role: "img", "aria-label": `${task.task_id} ${label}完整图`, hidden: true });
    const loading = el("span", { class: "thumb-missing", text: "正在拼接完整图…" });
    thumb.append(canvas, loading);
    loadDisplayImage(canvas, task, side).then(() => {
      if (!thumb.isConnected) return;
      canvas.hidden = false;
      loading.remove();
    }).catch(() => {
      canvas.remove();
      loading.textContent = `${label}完整图加载失败`;
    });
  } else {
    thumb.append(el("span", { class: "thumb-missing", text: imageMissingText(task, side) }));
  }
  return el("button", { class: `image-preview${task.height > task.width * 1.5 ? " image-preview-portrait" : ""}`, type: "button", "aria-label": `查看 ${task.task_id} ${label}`, onclick: () => openLightbox(task) }, [
    el("span", { class: "image-preview-label", text: label }), thumb,
  ]);
}

function imageRowLabel(task) {
  if (task.kind === "bundle_thumbnail") return "缩略图 · 随原图自动生成，不单独翻译";
  if (task.kind === "bundle_inventory") return "资源包 · 图片张数待确认";
  return task.width && task.height ? `${task.width}×${task.height}` : "尺寸待确认";
}

function renderImageCard(task) {
  const status = IMAGE_STATUSES[imageStatus(task)];
  const bundleRow = task.kind.startsWith("bundle_");
  return el("article", { class: "image-card" }, [
    el("div", { class: "image-body" }, [
      el("div", { class: "image-id", text: bundleRow ? task.bundle : task.task_id }),
      el("div", { class: "image-sub" }, [
        el("span", {
          class: `badge ${status.badge}`,
          text: status.name,
        }),
        el("span", { text: imageRowLabel(task) }),
        el("span", { text: task.category_name || task.category }),
      ]),
      task.thumbnail_parent ? el("div", { class: "image-sub" }, [el("span", { text: `对应原图：${task.thumbnail_parent}` })]) : null,
      el("button", { class: "btn btn-ghost", type: "button", text: "放大对照", onclick: () => openLightbox(task) }),
      imageReviewButton(task),
    ]),
    renderImagePreview(task, "original"),
    renderImagePreview(task, "localized"),
  ]);
}

function imageReviewButton(task) {
  if (task.has_localized || task.kind.startsWith("bundle_") || !imageDisplayReady(task, "original")) return null;
  if (imageStatus(task) === "not_needed" && !task.review_decision) return null;
  const marked = imageStatus(task) === "not_needed";
  return el("button", {
    class: "btn btn-ghost image-review-button", type: "button", disabled: state.images.reviewBusy,
    text: marked ? "撤销无需汉化" : "无需汉化",
    onclick: () => saveImageReview(task, marked ? null : {
      status: "not_needed", source_sha256: task.original_sha256, revision: crypto.randomUUID(),
    }),
  });
}

function renderImageReviewFeedback() {
  const feedback = clear($("image-review-feedback"));
  feedback.hidden = !state.images.reviewMessage;
  if (feedback.hidden) return;
  feedback.append(el("span", { text: state.images.reviewMessage }));
  const undo = state.images.reviewUndo;
  if (undo) feedback.append(" ", el("button", {
    class: "btn btn-ghost", type: "button", text: "撤销上次操作", disabled: state.images.reviewBusy,
    onclick: () => saveImageReview(undo.task, undo.previous, undo.decision, true),
  }));
}

async function saveImageReview(task, decision, expected = task.review_decision || null, undoing = false) {
  if (state.images.reviewBusy) return;
  if (!getToken()) {
    toast("先在「设置」里配置有资源仓库写入权限的 GitHub Token 才能标记", "err");
    return;
  }
  state.images.reviewBusy = true;
  document.querySelectorAll(".image-review-button").forEach((button) => { button.disabled = true; });
  state.images.reviewMessage = "正在保存图片标记…";
  renderImageReviewFeedback();
  try {
    const result = await commitImageReview({ ...state.portal.sources.assets, token: getToken(), task, expected, decision });
    applyImageReviews(state.images.data.tasks, result.document);
    state.images.reviewUndo = undoing ? null : { task,
      previous: result.previous?.source_sha256 === task.original_sha256 ? result.previous : null, decision };
    state.images.reviewMessage = `${decision ? "已标记为无需汉化" : "已撤销无需汉化标记"}：${task.task_id}（已保存 ${result.commit.sha.slice(0, 8)}）`;
    toast(decision ? "标记成功，可撤销；已从未汉化列表移出" : "已撤销，图片恢复原来的状态", "ok");
  } catch (error) {
    state.images.reviewMessage = `保存失败：${error.code === "conflict" ? "图片标记已变化，请在设置中重新拉取数据后重试" : writeErrorText(error) || error.message}`;
    toast(state.images.reviewMessage, "err");
  } finally {
    state.images.reviewBusy = false;
    if (state.view === "images") await renderImages(parseRoute().params);
    else renderImageReviewFeedback();
    const activeTask = state.lightbox?.task;
    if (activeTask) {
      clear($("lightbox-review-actions")).append(...[imageReviewButton(activeTask)].filter(Boolean));
      $("lightbox-image-missing").textContent = imageMissingText(activeTask, "localized");
      $("lightbox-meta").querySelector("[data-image-status]").textContent = `状态：${IMAGE_STATUSES[imageStatus(activeTask)].name}`;
    }
  }
}

function openLightbox(task) {
  closeLightbox();
  state.lightbox = { task, downloads: [] };
  $("lightbox").hidden = false;
  renderLightbox();
}

function closeLightbox() {
  for (const url of state.lightbox?.downloads || []) URL.revokeObjectURL(url);
  state.lightbox = null;
  hideModal("lightbox");
}

function renderLightbox() {
  const { task } = state.lightbox;
  $("lightbox").classList.toggle("lightbox-portrait", task.height > task.width * 1.5);
  $("lightbox").querySelector(".lightbox-body").scrollTop = 0;
  const reference = originalReference(task);

  $("lightbox-title").textContent = task.kind.startsWith("bundle_") ? task.bundle : task.task_id;
  lightboxImage("lightbox-original", "lightbox-original-missing", task, "original", "lightbox-download-original");
  lightboxImage("lightbox-image", "lightbox-image-missing", task, "localized", "lightbox-download");

  const meta = clear($("lightbox-meta"));
  meta.append(
    el("span", { text: task.width && task.height ? `${formatNumber(task.width)}×${formatNumber(task.height)}` : "尺寸待确认" }),
    el("span", { text: `资源：${task.bundle}` }),
    el("span", { text: `分类：${task.category_name || task.category}` }),
    el("span", { "data-image-status": true, text: `状态：${IMAGE_STATUSES[imageStatus(task)].name}` }),
  );
  if (task.thumbnail_parent) meta.append(el("span", { text: `对应原图：${task.thumbnail_parent}` }));
  clear($("lightbox-review-actions")).append(...[imageReviewButton(task)].filter(Boolean));
  if (reference && !reference.published) {
    meta.append(el("span", { class: "warn", text: "原图尚未发布" }));
    meta.append(el("span", { class: "hint", text: `原图 sha256：${reference.sha || "（未提供）"}` }));
    if (reference.path) meta.append(el("span", { class: "hint", text: `原图路径：${reference.path}` }));
  }

}

/// 灯箱和下载都使用拼接结果；异步加载旧任务不得覆盖新打开的图片。
async function lightboxImage(canvasId, missingId, task, side, downloadId) {
  const canvas = $(canvasId);
  const missing = $(missingId);
  const download = $(downloadId);
  const current = state.lightbox;
  canvas.hidden = true;
  missing.hidden = false;
  download.hidden = true;
  download.removeAttribute("href");
  if (!imageDisplayReady(task, side)) {
    missing.textContent = imageMissingText(task, side);
    return;
  }
  missing.textContent = "正在拼接完整图…";
  try {
    const rendered = document.createElement("canvas");
    await loadDisplayImage(rendered, task, side);
    if (state.lightbox !== current) return;
    canvas.width = rendered.width;
    canvas.height = rendered.height;
    canvas.getContext("2d").drawImage(rendered, 0, 0);
    canvas.hidden = false;
    missing.hidden = true;
    const blob = await displayImageBlob(rendered);
    if (state.lightbox !== current) return;
    const url = URL.createObjectURL(blob);
    current.downloads.push(url);
    download.href = url;
    download.setAttribute("download", `${String(task.task_id).replace(/[^\w.-]+/g, "_")}-${side}-complete.png`);
    download.hidden = false;
  } catch (_) {
    if (state.lightbox !== current) return;
    missing.hidden = false;
    missing.textContent = "完整图加载或导出失败，请稍后重试";
  }
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
  libraryUi.bindEvents();
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
    node.addEventListener("click", () => node.dataset.close === "lightbox" ? closeLightbox() : hideModal(node.dataset.close));
  }

  $("hero-random-song").addEventListener("click", async () => {
    const index = await loadCategoryIndex("lyrics");
    const songs = groupSongs(index.bundles || []);
    if (!songs.length) return;
    navigate("read", { file: primaryVersion(songs[Math.floor(Math.random() * songs.length)]).file });
  });
  $("hero-untranslated").addEventListener("click", () => {
    state.catalogue.filters.status = "untranslated";
    state.catalogue.filters.sort = "progress-asc";
    state.catalogue.page = 1;
    navigate("catalogue", { category: "lyrics", status: "untranslated", sort: "progress-asc" });
  });
  $("btn-reload-data").addEventListener("click", () => reloadData());
  $("settings-reload").addEventListener("click", () => reloadData());

  const refreshSongSearch = debounce(() => renderSongGrid(), 150);
  $("song-search").addEventListener("input", (event) => {
    state.songKeyword = event.target.value;
    state.songPage = 1;
    refreshSongSearch();
  });

  $("song-idol").addEventListener("change", (event) => { state.songIdol = event.target.value; state.songPage = 1; renderSongGrid(); });
  $("song-group").addEventListener("change", (event) => { state.songGrouped = event.target.checked; state.songPage = 1; renderSongGrid(); });
  $("song-attribute").addEventListener("change", (event) => { state.songAttribute = event.target.value; state.songPage = 1; renderSongGrid(); });
  $("song-cast").addEventListener("change", (event) => { state.songCast = event.target.value; state.songPage = 1; renderSongGrid(); });
  $("filter-song-attribute").addEventListener("change", (event) => { state.catalogue.filters.attribute = event.target.value; state.catalogue.page = 1; renderCatalogue(); });
  $("filter-song-cast").addEventListener("change", (event) => { state.catalogue.filters.cast = event.target.value; state.catalogue.page = 1; renderCatalogue(); });
  $("filter-song-group").addEventListener("change", (event) => { state.catalogue.filters.groupSongs = event.target.checked; state.catalogue.page = 1; renderCatalogue(); });
  $("read-song-version").addEventListener("change", (event) => { navigate("read", { file: event.target.value }); });

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
  const refreshCatalogueSearch = debounce(() => renderCatalogue(), 150);
  $("filter-keyword").addEventListener("input", (event) => {
    state.catalogue.filters.keyword = event.target.value;
    state.catalogue.page = 1;
    refreshCatalogueSearch();
  });

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

  $("image-sort").addEventListener("change", (event) => navigateImages({ sort: event.target.value }));
  $("image-status").addEventListener("change", (event) => navigateImages({ status: event.target.value }));
  $("image-original").addEventListener("change", (event) => navigateImages({ original: event.target.value }));
  $("image-reset").addEventListener("click", () => navigateImages({ category: "all", status: "all", original: "all", keyword: "", sort: "default" }));
  $("image-search").addEventListener("input", debounce((event) => {
    if (state.view === "images") navigateImages({ keyword: event.target.value });
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
      closeLightbox();
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
  if (state.images.reviewBusy) {
    toast("图片标记正在保存，请完成后再重新拉取数据", "err");
    return;
  }
  clearCache();
  state.images.data = null;
  state.images.reviewUndo = null;
  state.images.reviewMessage = "";
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
    filterImageTasks,
    originalReference,
    goToBundlePage,
  };
}
