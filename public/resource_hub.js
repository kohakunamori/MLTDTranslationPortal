// The homepage resource hub is deliberately small and framework-free. It is
// a read-only projection of the two release axes; editing still goes through
// the existing portal views and GitHub PR flow.
(function () {
  "use strict";

  let loading = null;

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function number(value) {
    return Number(value || 0).toLocaleString();
  }

  async function fetchJson(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout || 8000);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: options.cache || "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || data.error || `HTTP ${response.status}`);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  function chooseRelease(releases, preferredStatus) {
    const rows = (Array.isArray(releases) ? releases : []).slice().sort((a, b) => {
      const version = Number(b.asset_version || b.client_version || 0) - Number(a.asset_version || a.client_version || 0);
      if (version) return version;
      const rank = (value) => value === preferredStatus ? 0 : value === "published" ? 1 : value === "canonical" ? 2 : 3;
      return rank(a.status) - rank(b.status);
    });
    return rows[0] || null;
  }

  function summaryTotals(manifest) {
    if (!manifest) return { total: 0, translated: 0, pending: 0, categories: 0 };
    const totals = manifest.totals || {};
    return {
      total: Number(totals.total || 0),
      translated: Number(totals.translated || 0),
      pending: Number(totals.pending || 0),
      categories: Array.isArray(manifest.categories) ? manifest.categories.length : 0,
    };
  }

  function renderChannel(channel, release, manifest, fallbackText) {
    const card = document.querySelector(`[data-resource-channel="${channel}"]`);
    if (!card) return;
    card.classList.remove("is-loading", "is-error");
    const status = card.querySelector("[data-resource-status]");
    const metrics = card.querySelector("[data-resource-metrics]");
    if (!release) {
      card.classList.add("is-error");
      if (status) status.textContent = "未登记";
      if (metrics) metrics.innerHTML = `<span class="resource-hub-error">${escapeHtml(fallbackText)}</span>`;
      return;
    }
    const totals = summaryTotals(manifest);
    const version = channel === "assets" ? release.asset_version : release.client_version;
    const id = release.release_id || version || "unknown";
    const hash = channel === "assets" ? release.source_manifest_sha256 : release.manifest_sha256;
    const readiness = manifest?.summary_ready === false ? "摘要待生成" : `${number(totals.translated)} / ${number(totals.total)} 已完成`;
    if (status) {
      status.textContent = release.status || "registered";
      status.className = `resource-channel-status status-${String(release.status || "registered").replace(/[^a-z-]/g, "")}`;
    }
    if (metrics) {
      metrics.innerHTML = `
        <div><strong>${escapeHtml(version || id)}</strong><span>${escapeHtml(channel === "assets" ? "Assets 版本" : `${release.abi || "Client"} 内置面`)}</span></div>
        <div><strong>${escapeHtml(readiness)}</strong><span>${number(totals.categories)} 个实际分类</span></div>
        <div class="resource-hub-hash" title="${escapeHtml(hash || "")}">manifest ${escapeHtml(hash ? `${hash.slice(0, 12)}…` : "未提供")}</div>`;
    }
    const categoryBox = card.querySelector("[data-resource-categories]");
    if (categoryBox) {
      const categories = Array.isArray(manifest?.categories) ? manifest.categories : [];
      categoryBox.innerHTML = categories.length
        ? `<label class="resource-category-select"><span>选择分类</span><select aria-label="选择${channel === "assets" ? "Assets" : "Client"}资源分类"><option value="">全部分类</option>${categories.map((category) => `<option value="${escapeHtml(category.id)}" data-resource-entry="${escapeHtml(category.entry || "studio")}">${escapeHtml(category.icon || "📦")} ${escapeHtml(category.name)} · ${number(category.total)}（待翻译 ${number(Number(category.pending || 0) + Number(category.untranslated || 0))}）</option>`).join("")}</select></label>`
        : `<span class="resource-category-empty">${manifest?.summary_ready === false ? "分类摘要尚未生成" : "此 release 暂无分类"}</span>`;
      categoryBox.querySelector("select")?.addEventListener("change", (event) => {
        const option = event.target.selectedOptions[0];
        const entry = option?.getAttribute("data-resource-entry") || "studio";
        const category = event.target.value || "";
        if (!category) return;
        window.__portalPendingResourceCategory = { channel, category, entry };
        if (entry === "images") return enterResource("assets-images");
        if (entry === "lyrics") return enterResource("assets-text");
        enterResource(channel === "client" ? "client" : "assets-text");
      });
    }
  }

  async function loadResourceHub(force = false) {
    const source = document.getElementById("resource-hub-source");
    if (!document.getElementById("resource-hub")) return;
    if (loading) return loading;
    if (source) source.textContent = "正在读取独立 release manifest 摘要…";
    loading = (async () => {
      const [assetsResult, clientResult] = await Promise.allSettled([
        fetchJson("/api/assets/releases?limit=20"),
        fetchJson("/api/client/releases?limit=20"),
      ]);
      const assetsRows = assetsResult.status === "fulfilled" ? assetsResult.value.releases || [] : [];
      const clientRows = clientResult.status === "fulfilled" ? clientResult.value.releases || [] : [];
      const assets = chooseRelease(assetsRows, "canonical");
      const client = chooseRelease(clientRows, "published");
      const [assetsManifestResult, clientManifestResult] = await Promise.allSettled([
        assets ? fetchJson(`/api/assets/releases/${encodeURIComponent(assets.asset_version || assets.release_id)}/manifest`) : Promise.reject(new Error("assets release missing")),
        client ? fetchJson(`/api/client/releases/${encodeURIComponent(client.release_id || client.client_version)}/manifest`) : Promise.reject(new Error("client release missing")),
      ]);
      const assetsManifest = assetsManifestResult.status === "fulfilled" ? assetsManifestResult.value : null;
      const clientManifest = clientManifestResult.status === "fulfilled" ? clientManifestResult.value : null;
      window.__portalResourceManifests = { assets: assetsManifest, client: clientManifest };
      window.dispatchEvent(new CustomEvent("portal:resource-manifests", { detail: window.__portalResourceManifests }));
      renderChannel("assets", assets, assetsManifest, assetsResult.status === "rejected" ? "Assets release 暂不可用" : "没有 canonical Assets release");
      renderChannel("client", client, clientManifest, clientResult.status === "rejected" ? "Client release 暂不可用" : "没有登记 Client release");
      const errors = [assetsManifestResult, clientManifestResult].filter((item) => item.status === "rejected");
      if (source) {
        source.textContent = errors.length
          ? "版本已读取，但部分 resource manifest 尚未准备好。"
          : "已读取 Assets / Client resource manifest；任务分类和数量来自各自 release。";
      }
    })().catch((error) => {
      if (source) source.textContent = `资源清单读取失败：${error.message || "网络错误"}`;
      document.querySelectorAll("[data-resource-channel]").forEach((card) => {
        card.classList.remove("is-loading");
        card.classList.add("is-error");
      });
    }).finally(() => { loading = null; });
    return loading;
  }

  function enterResource(entry) {
    const click = (selector) => document.querySelector(selector)?.click();
    if (entry === "assets-images") {
      click("#nav-lobby");
      setTimeout(() => window.dispatchEvent(new CustomEvent("portal:open-domain", { detail: { domain: "images" } })), 0);
      window.__portalPendingResourceCategory = null;
      return;
    }
    if (entry === "assets-text") {
      click("#nav-lobby");
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent("portal:open-domain", { detail: { domain: "all" } }));
        const pending = window.__portalPendingResourceCategory;
        if (pending) window.dispatchEvent(new CustomEvent("portal:resource-category", { detail: pending }));
        window.__portalPendingResourceCategory = null;
      }, 0);
      return;
    }
    if (entry === "client") {
      click("#nav-selector");
      setTimeout(() => click('#selector-channel-tabs [data-selector-channel="client"]'), 0);
      window.__portalPendingResourceCategory = null;
      return;
    }
    if (entry === "releases") return click("#nav-releases");
    // Assets text uses the normal catalogue/lobby entry. The resource hub and
    // the domain tabs make the channel distinction clear without inventing a
    // Client/Assets composite version.
    click("#nav-lobby");
    setTimeout(() => click('.domain-tab[data-domain="all"]'), 0);
  }

  function init() {
    document.getElementById("btn-refresh-resource-hub")?.addEventListener("click", () => loadResourceHub(true));
    document.querySelectorAll("[data-resource-entry]").forEach((button) => {
      button.addEventListener("click", () => enterResource(button.getAttribute("data-resource-entry")));
    });
    loadResourceHub();
    window.__portalResourceHub = { load: loadResourceHub, enter: enterResource };
  }

  window.addEventListener("DOMContentLoaded", init);
})();
