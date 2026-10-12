import { bundleLabel, loadBundle, loadCategoryIndex, loadLibrary, loadLibraryFile, progressPercent, dataUrl } from "./data.js";
import { CATEGORY_RULES } from "./taxonomy.js";
import { groupSongs, primaryVersion, singerSummary, songKey, versionLabel } from "./songs.js";
import { alignLyrics, chapterContext, readableLabel } from "./library.js";
import { browserPersonalStore, itemId } from "./personal.js";
import { normalizeSearch, searchCorpus } from "./search-core.js";

const TOPIC_KINDS = { event: "活动", main: "主线", anniversary: "周年", special: "特别企划", birthday: "生日" };

export function createLibraryUi({ $, el, clear, navigate, renderPager, toast, renderSongCard, state }) {
  const personal = browserPersonalStore();
  let renderId = 0, currentReading = null, lastVisit = "", positionTimer, worker, searchId = 0, controller, suppressPosition = true, readingTouched = false;
  let searchResults = [], searchPage = 1, searchQuery = "", searchSummary = "", compareData = null;
  const button = (text, onclick, extra = {}) => el("button", { type: "button", class: "btn", text, onclick, ...extra });
  const bookmark = (entry) => ({ id: entry.id || itemId(entry), file: entry.file, label: entry.label || bundleLabel(entry), category: entry.category });
  const profileLink = (idol) => button(idol.name_zh || idol.name_ja, () => navigate("idol", { id: idol.code }), { class: "idol-link" });
  function favoriteButton(entry) {
    const item = bookmark(entry);
    const target = button(personal.isFavorite(item.id) ? "★ 已收藏" : "☆ 收藏", () => {
      const persisted = personal.toggleFavorite(item);
      target.textContent = personal.isFavorite(item.id) ? "★ 已收藏" : "☆ 收藏";
      target.setAttribute("aria-pressed", String(personal.isFavorite(item.id)));
      if (!persisted) toast("此浏览器暂时无法保存记录，收藏仅在本次打开期间保留。", "err");
    }, { class: "btn btn-ghost favorite-button", "aria-pressed": String(personal.isFavorite(item.id)) });
    return target;
  }
  function openSaved(item) {
    const position = personal.position(item.id);
    navigate("read", { file: item.file, ...(position ? { p: position.p, l: position.line } : {}) });
  }
  function entryCard(entry, { idol = "", saved = false } = {}) {
    if (entry.song && !saved) return renderSongCard(entry, idol, true);
    const card = el("article", { class: "library-card" }, [
      button(entry.label || readableLabel(entry), () => saved ? openSaved(entry) : navigate("read", { file: entry.file }), { class: "library-open" }),
      el("p", { class: "hint", text: CATEGORY_RULES[entry.reading_category || entry.category]?.name || "阅读内容" }),
      entry.topic ? el("p", { class: "hint", text: `${entry.topic.label} · ${entry.topic.chapter_label}` }) : null,
      entry.summary ? el("p", { class: "library-excerpt", text: entry.summary }) : null,
      !saved ? el("p", { class: "hint", text: `${progressPercent(entry)}% · ${entry.total || 0} 句` }) : null,
    ]);
    const actions = el("div", { class: "library-actions" }, favoriteButton(entry));
    if (saved && personal.position(entry.id)) actions.append(button("继续阅读", () => openSaved(entry)));
    card.append(actions);
    return card;
  }
  function pagedList(host, entries, makeCard = entryCard) {
    let page = 1;
    const list = el("div", { class: "library-grid" }), pager = el("div", { class: "pager" });
    host.append(list, pager);
    function draw() {
      clear(list);
      if (!entries.length) list.append(el("p", { class: "empty", text: "暂无对应内容。" }));
      for (const entry of entries.slice((page - 1) * 18, page * 18)) list.append(makeCard(entry));
      renderPager(pager, page, Math.max(1, Math.ceil(entries.length / 18)), (next) => { page = next; draw(); host.scrollIntoView({ block: "start" }); });
    }
    draw();
  }
  async function renderIdols(params) {
    const request = ++renderId;
    const index = await loadLibrary();
    if (request !== renderId || state.view !== "idols") return;
    const query = String(params.q || "").trim().toLowerCase();
    $("idols-query").value = query;
    const entries = index.idols.filter((idol) => `${idol.name_zh} ${idol.name_ja}`.toLowerCase().includes(query));
    $("idols-count").textContent = `${entries.length} 位偶像`;
    const host = clear($("idols-list"));
    for (const idol of entries) host.append(el("button", { type: "button", class: "idol-card", onclick: () => navigate("idol", { id: idol.code }) }, [
      el("span", { class: "idol-avatar", style: `background:${idol.color}`, text: (idol.name_zh || idol.name_ja).slice(0, 1) }),
      el("strong", { text: idol.name_zh || idol.name_ja }),
      el("span", { class: "hint", text: `${idol.counts.songs} 首歌曲 · ${idol.counts.stories} 篇剧情 · ${idol.counts.birthday} 篇生日内容` }),
    ]));
    if (!entries.length) host.append(el("p", { class: "empty", text: "没有匹配的偶像。" }));
  }
  async function renderIdol(params) {
    const request = ++renderId, index = await loadLibrary();
    const idol = index.idols.find((entry) => entry.code === params.id);
    const host = clear($("idol-content"));
    if (!idol) { $("idol-name").textContent = "未找到偶像"; $("idol-description").textContent = ""; clear($("idol-tabs")); host.append(el("p", { class: "empty", text: "未找到这位偶像。" })); return; }
    const doc = await loadLibraryFile(idol.file);
    if (request !== renderId || state.view !== "idol") return;
    $("idol-name").textContent = idol.name_zh || idol.name_ja;
    $("idol-description").textContent = `${idol.name_ja} · ${idol.counts.songs} 首参与演唱的歌曲`;
    const tabs = clear($("idol-tabs"));
    const sections = { songs: ["参与歌曲", doc.songs], stories: ["个人主线与参与剧情", doc.stories], birthday: ["生日纪念", doc.birthday], other: ["其他相关内容", doc.other] };
    const tab = sections[params.tab] ? params.tab : "songs";
    for (const [id, [label, entries]] of Object.entries(sections)) tabs.append(button(`${label}（${entries.length}）`,
      () => navigate("idol", { id: idol.code, tab: id }), { class: `domain-tab${tab === id ? " active" : ""}` }));
    host.append(el("p", { class: "hint", text: tab === "songs" ? "按默认演唱成员汇集；点击歌曲会优先打开这位偶像参与的版本。" : "汇集能够确认与这位偶像相关的篇章，阅读时保留完整上下文。" }));
    pagedList(host, sections[tab][1], (entry) => entryCard(entry, { idol: idol.code }));
  }
  async function renderTopics(params) {
    const request = ++renderId, index = await loadLibrary();
    if (request !== renderId || state.view !== "topics") return;
    $("topics-query").value = params.q || ""; $("topics-kind").value = params.kind || "";
    const needle = normalizeSearch(params.q);
    const entries = index.topics.filter((topic) => (!params.kind || topic.kind === params.kind)
      && (!needle || normalizeSearch(`${topic.label} ${topic.excerpt}`).includes(needle)));
    $("topics-count").textContent = `${entries.length} 个专题`;
    const host = clear($("topics-list"));
    pagedList(host, entries, (topic) => el("article", { class: "library-card" }, [
      button(topic.label, () => navigate("topic", { id: topic.id }), { class: "library-open" }),
      el("p", { class: "hint", text: `${TOPIC_KINDS[topic.kind] || "专题"} · ${topic.count} 篇${topic.continuous ? " · 支持连续阅读" : ""}` }),
      el("p", { class: "library-excerpt", text: topic.excerpt }),
    ]));
  }
  async function renderTopic(params) {
    const request = ++renderId, index = await loadLibrary();
    const meta = index.topics.find((entry) => entry.id === params.id), host = clear($("topic-content"));
    if (!meta) { $("topic-name").textContent = "未找到专题"; $("topic-description").textContent = ""; host.append(el("p", { class: "empty", text: "未找到此专题。" })); return; }
    const doc = await loadLibraryFile(meta.file);
    if (request !== renderId || state.view !== "topic") return;
    $("topic-name").textContent = doc.label;
    $("topic-description").textContent = `${TOPIC_KINDS[doc.kind]} · ${meta.count} 篇${doc.continuous ? " · 按章节顺序阅读" : ""}`;
    if (doc.continuous) host.append(button("从第一章开始", () => navigate("read", { file: doc.chapters[0].file }), { class: "btn btn-primary" }));
    pagedList(host, doc.chapters, (entry) => {
      const card = entryCard(entry); card.prepend(el("span", { class: "pill", text: entry.topic.chapter_label })); return card;
    });
    if (doc.related?.length) {
      const related = el("div", { class: "related-content" }, el("h3", { text: "相关短信与博客" })); host.append(related); pagedList(related, doc.related);
    }
  }
  function renderPersonal() {
    const snapshot = personal.snapshot();
    $("personal-note").textContent = personal.available ? "收藏与阅读位置保存在此浏览器，可导出备份。" : "此浏览器暂时无法保存记录，当前记录只在本次打开期间保留。";
    $("personal-favorites-count").textContent = `收藏（${snapshot.favorites.length}）`;
    $("personal-recent-count").textContent = `最近阅读（${snapshot.recent.length}）`;
    pagedList(clear($("personal-favorites")), snapshot.favorites, (entry) => {
      const card = entryCard(entry, { saved: true });
      const action = card.querySelector(".favorite-button");
      action.addEventListener("click", () => renderPersonal());
      return card;
    });
    pagedList(clear($("personal-recent")), snapshot.recent, (entry) => entryCard(entry, { saved: true }));
  }
  async function loadAllLines(entry) {
    const index = await loadCategoryIndex("lyrics");
    const found = index.bundles.find((x) => x.file === entry.file) || entry;
    const pages = found.pages?.length ? found.pages : [{ file: found.file }];
    const docs = await Promise.all(pages.map((x) => loadBundle(x.file)));
    return docs.flatMap((x) => x.lines || []);
  }
  async function renderCompare(params) {
    const request = ++renderId, index = await loadCategoryIndex("lyrics");
    const entry = index.bundles.find((x) => x.file === params.file);
    const group = entry && groupSongs(index.bundles).find((x) => songKey(x) === songKey(entry));
    const host = clear($("compare-lines"));
    if (!group || group.versions.length < 2) { compareData = null; $("compare-title").textContent = "多版本歌词对照"; $("compare-summary").textContent = ""; clear($("compare-left")); clear($("compare-right")); host.append(el("p", { class: "empty", text: "这首歌曲暂无可对照的其他版本。" })); return; }
    const left = entry, right = group.versions.find((x) => x.file === params.other)
      || group.versions.find((x) => x.file !== entry.file);
    const [a, b] = await Promise.all([loadAllLines(left), loadAllLines(right)]);
    if (request !== renderId || state.view !== "compare") return;
    $("compare-title").textContent = bundleLabel(entry);
    for (const [id, selected] of [["compare-left", left.file], ["compare-right", right.file]]) {
      const select = clear($(id));
      for (const [offset, version] of group.versions.entries()) select.append(el("option", { value: version.file,
        text: `${versionLabel(version, offset)} · ${singerSummary(version)}`, selected: version.file === selected }));
    }
    compareData = { left, right, a, b };
    drawCompare();
  }
  function drawCompare() {
    if (!compareData) return;
    const rows = alignLyrics(compareData.a, compareData.b, { ignoreWhitespace: $("compare-whitespace").checked });
    const changes = rows.filter((x) => x.kind !== "same");
    $("compare-summary").textContent = `${rows.length} 组歌词 · ${changes.length} 处差异（包含原文与译文差异）`;
    const host = clear($("compare-lines"));
    for (const row of $("compare-only").checked ? changes : rows) {
      const label = { same: "相同", translation: "译文不同", changed: "原文不同", removed: "仅左侧", added: "仅右侧" }[row.kind];
      host.append(el("article", { class: `compare-row diff-${row.kind}` }, [
        el("span", { class: "diff-label", text: label }),
        ...[row.left, row.right].map((line) => el("div", { class: "compare-cell" }, line ? [
          el("p", { text: line.source }), el("p", { class: "line-translation", text: line.translation || "暂无译文" }),
        ] : el("p", { class: "hint", text: "此版本没有对应段落" }))),
      ]));
    }
    if (!host.children.length) host.append(el("p", { class: "empty", text: "这两个版本没有匹配当前条件的差异。" }));
  }
  function cancelSearch() {
    searchId++; worker?.postMessage({ cancel: true }); controller?.abort(); $("search-cancel").disabled = true;
  }
  function drawSearch() {
    const host = clear($("search-results"));
    for (const result of searchResults.slice((searchPage - 1) * 20, searchPage * 20)) host.append(el("article", { class: "search-result card" }, [
      button(`${result.label} · 第 ${result.index} 行`, () => navigate("read", { file: result.file, p: result.p, l: result.line }), { class: "library-open" }),
      el("p", { class: "hint", text: CATEGORY_RULES[result.category]?.name || "阅读内容" }),
      highlighted(result.source), highlighted(result.translation || "暂无译文"),
    ]));
    renderPager($("search-pager"), searchPage, Math.max(1, Math.ceil(searchResults.length / 20)), (next) => { searchPage = next; drawSearch(); $("search-status").scrollIntoView(); });
  }
  function highlighted(value) {
    const node = el("p", { class: "search-snippet" });
    const offset = value.toLowerCase().indexOf(searchQuery.toLowerCase());
    if (offset < 0) node.textContent = value;
    else node.append(document.createTextNode(value.slice(0, offset)), el("mark", { text: value.slice(offset, offset + searchQuery.length) }), document.createTextNode(value.slice(offset + searchQuery.length)));
    return node;
  }
  async function renderSearch(params) {
    cancelSearch();
    const request = searchId, index = await loadLibrary();
    if (request !== searchId || state.view !== "search") return;
    $("search-query").value = params.q || ""; $("search-scope").value = params.scope || "all"; $("search-state").value = params.status || "";
    const select = clear($("search-idol")); select.append(el("option", { value: "", text: "全部偶像" }));
    for (const idol of index.idols) select.append(el("option", { value: idol.code, text: idol.name_zh || idol.name_ja, selected: idol.code === params.idol }));
    searchResults = []; searchPage = 1; searchQuery = String(params.q || "").trim(); drawSearch();
    if (!searchQuery) { $("search-status").textContent = "输入日文或中文正文开始搜索。"; return; }
    const scope = params.scope || "all";
    const categories = scope === "all" ? [] : scope === "lyrics" ? ["lyrics"]
      : Object.values(CATEGORY_RULES).filter((x) => x.domain === scope).map((x) => x.id);
    const filters = { keyword: searchQuery, categories, idol: params.idol || "", status: params.status || "" };
    $("search-status").textContent = "正在搜索…"; $("search-cancel").disabled = false;
    const receive = (data) => {
      if (request !== searchId || state.view !== "search") return;
      if (data.error) { $("search-status").textContent = data.error; $("search-cancel").disabled = true; return; }
      const result = data.result || data.progress;
      if (!result) return;
      searchResults = result.results;
      searchSummary = `${result.total} 处匹配${result.total > 200 ? " · 展示前 200 处，请缩小搜索范围" : ""}`;
      $("search-status").textContent = data.result ? searchSummary : `正在搜索 ${result.scanned}/${result.shards} · 已找到 ${result.total} 处`;
      if (data.result) $("search-cancel").disabled = true;
      drawSearch();
    };
    try {
      if (typeof Worker === "function") {
        worker ||= new Worker(new URL("./search-worker.js", import.meta.url), { type: "module" });
        worker.onmessage = ({ data }) => { if (data.id === request) receive(data); };
        worker.onerror = () => receive({ error: "搜索暂时无法启动，请刷新后重试。" });
        worker.postMessage({ id: request, root: new URL(dataUrl(""), location.href).href, filters });
      } else {
        controller = new AbortController();
        const read = async (file, signal) => { const response = await fetch(dataUrl(file), { signal, cache: "no-cache" }); if (!response.ok) throw new Error("搜索资料暂时无法载入。"); return response.json(); };
        const manifest = await read("search/index.json", controller.signal);
        const result = await searchCorpus({ manifest, filters, signal: controller.signal, fetchShard: read,
          onProgress: (progress) => receive({ progress }) });
        receive({ result });
      }
    } catch (error) { if (request === searchId && error.name !== "AbortError") receive({ error: error.message }); }
  }
  async function afterRead(bundle, entry, params) {
    const current = entry || { ...bundle, file: state.read.file };
    const id = itemId(current);
    currentReading = { entry: current, id, p: state.read.bundlePage };
    if (lastVisit !== `${id}:${state.read.bundlePage}`) { personal.visit(bookmark(current)); lastVisit = `${id}:${state.read.bundlePage}`; }
    clear($("read-personal-actions")).append(favoriteButton(current));
    const position = personal.position(id);
    if (position?.line && position.line !== String(params.l || "")) $("read-personal-actions").append(button("继续上次阅读", () => openSaved(bookmark(current))));
    const related = clear($("read-related"));
    if (current.topic) {
      related.append(button(`专题：${current.topic.label}`, () => navigate("topic", { id: current.topic.id })));
      try {
        const topic = await loadLibraryFile(current.topic.file);
        if (state.view !== "read" || state.read.file !== current.file) return;
        const context = chapterContext(topic, current.file);
        if (context.previous) related.append(button(`← ${context.previous.topic.chapter_label}`, () => navigate("read", { file: context.previous.file })));
        if (context.next) related.append(button(`${context.next.topic.chapter_label} →`, () => navigate("read", { file: context.next.file })));
      } catch (_) { /* Reading itself remains usable when a topic is unavailable. */ }
    }
    const codes = current.song ? current.song.default_singers.map((x) => x.code) : current.participants || [];
    const index = await loadLibrary();
    if (state.view !== "read" || state.read.file !== current.file) return;
    const links = clear($("read-idol-links"));
    for (const code of codes) { const idol = index.idols.find((x) => x.code === code); if (idol) links.append(profileLink(idol)); }
    $("read-idols-block").hidden = !links.children.length;
  }
  function savePosition() {
    if (suppressPosition || !readingTouched || state.view !== "read" || !currentReading) return;
    const header = document.querySelector(".app-header").getBoundingClientRect().bottom;
    const lines = [...$("line-list").children];
    const visible = lines.find((line) => line.getBoundingClientRect().bottom > header);
    if (!visible) return;
    const key = visible.dataset.lineKey;
    if (key) personal.savePosition(currentReading.id, { file: currentReading.entry.file, p: state.read.bundlePage, line: key });
  }
  function bindEvents() {
    $("idols-form").addEventListener("submit", (event) => { event.preventDefault(); navigate("idols", { q: $("idols-query").value }); });
    $("topics-form").addEventListener("submit", (event) => { event.preventDefault(); navigate("topics", { q: $("topics-query").value, kind: $("topics-kind").value }); });
    $("topics-kind").addEventListener("change", () => navigate("topics", { q: $("topics-query").value, kind: $("topics-kind").value }));
    $("personal-clear").addEventListener("click", () => { if (confirm("清空最近阅读及阅读位置？收藏会保留。")) { personal.clearRecent(); renderPersonal(); } });
    $("personal-export").addEventListener("click", () => {
      const url = URL.createObjectURL(new Blob([personal.exportData()], { type: "application/json" }));
      const anchor = el("a", { href: url, download: "mltd-collections.json" }); anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    $("personal-import").addEventListener("change", async (event) => {
      try { const file = event.target.files[0]; if (!file) return; if (file.size > 2_000_000) throw new Error("这份备份过大。");
        if (!personal.importData(await file.text())) toast("记录已导入，但此浏览器暂时无法长期保存。", "err");
        else toast("收藏备份已合并。", "ok"); renderPersonal();
      } catch (error) { toast(error.message, "err"); } finally { event.target.value = ""; }
    });
    for (const id of ["compare-only", "compare-whitespace"]) $(id).addEventListener("change", drawCompare);
    for (const id of ["compare-left", "compare-right"]) $(id).addEventListener("change", () => navigate("compare", { file: $("compare-left").value, other: $("compare-right").value }));
    $("search-form").addEventListener("submit", (event) => {
      event.preventDefault(); const params = { q: $("search-query").value, scope: $("search-scope").value, idol: $("search-idol").value, status: $("search-state").value };
      const next = `#search?${new URLSearchParams(params)}`;
      if (location.hash === next) renderSearch(params); else navigate("search", params);
    });
    $("search-cancel").addEventListener("click", () => { cancelSearch(); $("search-status").textContent = `搜索已停止 · 已显示 ${searchResults.length} 处匹配，结果尚不完整。`; });
    window.addEventListener("scroll", () => { if (suppressPosition || state.view !== "read") return; readingTouched = true; clearTimeout(positionTimer); positionTimer = setTimeout(savePosition, 350); }, { passive: true });
    window.addEventListener("pagehide", savePosition);
    window.addEventListener("storage", () => { personal.reload(); if (state.view === "personal") renderPersonal(); });
  }
  return {
    favoriteButton, profileLink, bindEvents,
    beforeRoute(view) { savePosition(); readingTouched = false; suppressPosition = true; clearTimeout(positionTimer); renderId++; if (view !== "search") cancelSearch(); },
    async afterRoute(params) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (state.view === "read" && params.l) {
        const target = document.getElementById(`line-${encodeURIComponent(params.l)}`);
        if (target) {
          target.scrollIntoView({ block: "center" }); target.classList.add("target-line");
          personal.savePosition(currentReading.id, { file: currentReading.entry.file, p: state.read.bundlePage, line: params.l });
        }
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
      suppressPosition = false;
    },
    afterRead,
    render(view, params) {
      if (view === "idols") return renderIdols(params);
      if (view === "idol") return renderIdol(params);
      if (view === "topics") return renderTopics(params);
      if (view === "topic") return renderTopic(params);
      if (view === "personal") return renderPersonal();
      if (view === "compare") return renderCompare(params);
      if (view === "search") return renderSearch(params);
    },
  };
}
