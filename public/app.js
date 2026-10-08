// MLTD Translation Portal Frontend Application
(function () {
  "use strict";

  const DEFAULT_PORTAL_ASSET_VERSION = (typeof window !== "undefined" && window.PORTAL_DEFAULT_ASSET_VERSION) || "1077100";

  const state = {
    currentView: "lobby",
    user: null,
    terms: {},
    idols: {},
    stats: null,
    activeDomain: "all",
    activeResource: "all",
    resourceManifests: { assets: null, client: null },

    // Lyrics Catalog state
    songsCatalog: null,
    songsError: null,
    activeSongType: "all",
    songFilterKeyword: "",
    sessionSongLyricsCache: {},

    // Studio state
    studioQueue: [],
    studioIndex: 0,
    currentItem: null,
    currentMode: "standard", // lyrics, chat, story, card, lounge, system
    currentSongMeta: null,
    activeLyricLineFilter: "all",
    currentFilter: {
      category: null,
      idol: null,
      keyword: "",
      status: "untranslated",
    },

    // Image Localization state
    images: {
      tasks: [],
      categories: { all: 0, event: 0, costume: 0, tutorial: 0 },
      total: 0,
      page: 1,
      pageSize: 12,
      category: "all",
      status: "all",
      search: "",
      currentTask: null,
      uploadedImageBase64: null,
      uploadedImageObj: null
    },

    // Repository → version → resource selector state. `release_id` is what the
    // item routes are addressed by once a list has answered; `selected` holds
    // the last edit context the service handed over, which is the only binding
    // the studio is allowed to submit with.
    selector: {
      channel: "assets",
      ref: "",
      release_id: "",
      items: [],
      // The service's own paging state: `next_cursor` is opaque and is sent back
      // exactly as it arrived; `has_more` is read with it so the "load more"
      // control never offers a page that cannot be fetched.
      next_cursor: null,
      has_more: false,
      selected: null
    }
  };

  // Helper: SHA-256
  async function computeSha256(str) {
    const buffer = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Human-readable text for the API's error codes
  const SUBMIT_ERROR_TEXT = {
    source_not_in_catalogue: "该条目已不在本地服的源目录中（可能是版本或路径不匹配），请刷新后重试",
    duplicate_contribution: "你已经提交过这一条了，等待审核即可",
    source_hash_mismatch: "源文本校验失败，请刷新页面重新加载该条目",
    key_invalid: "条目标识缺失，请刷新页面后重试",
    bundle_invalid: "章节标识缺失，请刷新页面后重试",
    translation_invalid: "译文为空或过长",
    translation_contains_reserved_separator: "译文包含半角 | 或 ^，请先替换为全角 ｜ 与 ＾",
    d1_quota_exceeded: "云端数据库今日读取额度已用完（北京时间 08:00 恢复），稍后再试",
    authentication_required: "未登录或登录状态已过期：请先完成站点登录；提交 PR 还需要关联 GitHub 账号",
    internal_error: "云端服务出错，请稍后重试",
    csrf_token_missing: "缺少请求令牌，请刷新页面后重试",
    csrf_token_invalid: "请求令牌不匹配，请刷新页面后重试",
    composite_version_rejected: "版本串是组合版本（含 + 或 assets-），两个仓库都不接受；请分别使用 client_version / asset_version",
    missing_asset_version: "缺少资源版本，无法定位该资源在 Assets 仓的版本轴",
    missing_client_version: "缺少客户端版本，无法定位该资源在 Client 仓的版本轴",
    path_invalid: "资源路径缺失或非法：门户不会自造路径",
    path_not_allowed: "该路径不在门户可写的目录范围内",
    unity3d_upload_rejected: "门户不接受 Unity3D 文件，回填由 CI 负责",
    github_pr_token_unconfigured: "门户尚未配置 GitHub 提交凭据，当前只能浏览",
    github_oauth_unconfigured: "门户尚未配置 GitHub 登录，暂时无法关联账号",
    github_target_assets_unconfigured: "门户未配置 Assets 目标仓库",
    github_target_client_unconfigured: "门户未配置 Client 目标仓库",
    github_target_assets_invalid: "Assets 目标仓库配置不合法",
    github_target_client_invalid: "Client 目标仓库配置不合法",
    fork_not_created_upstream_accessible: "门户凭据对目标仓库已有写权限，GitHub 未创建 fork：请联系维护者更换凭据",
    proposal_too_large: "提案内容超过单文件上限（2 MiB）",
    proposal_content_invalid: "提案内容为空或格式不支持",
    image_base64_invalid: "图片数据无法解码",
    image_too_large: "图片超过上传上限",
    image_source_sha256_missing: "该图片任务未记录原始 hash，门户不会用上传图冒充原文，已拒绝提交",
    image_path_mismatch: "提交路径与该任务的布局不符：门户只使用服务端给出的路径",
    client_image_unsupported: "Client 通道暂无可信的图片来源，图片提案只支持 Assets 通道",
    image_format_mismatch: "图片格式与该任务要求的格式不一致",
    image_unsupported_format: "只接受 PNG 或 JPEG 图片",
    aspect_ratio_mismatch: "图片比例与原图不一致：等比放大可以，拉伸不接受",
    resolution_below_original: "图片分辨率低于原图：门户不接受降采样",
    original_size_unknown: "该任务未记录原始尺寸，门户无法校验比例，已拒绝提交",
    task_not_found: "该图片任务不存在或已被移除",
    role_required: "当前账号没有该操作所需的角色",
  };

  function describeSubmitError(code) {
    return SUBMIT_ERROR_TEXT[code] || `提交失败（${code}）`;
  }

  // ==========================================================================
  // Local AI Configuration & Client-Side Fetch Engine
  // ==========================================================================
  const AI_CONFIG_KEY = "mltd_ai_config";
  const DEFAULT_AI_CONFIG = {
    endpoint: "https://api.deepseek.com/v1/chat/completions",
    apiKey: "",
    model: "deepseek-chat",
    temperature: 0.3,
  };

  const AI_PRESETS = {
    deepseek: {
      endpoint: "https://api.deepseek.com/v1/chat/completions",
      model: "deepseek-chat",
      temperature: 0.3,
    },
    openai: {
      endpoint: "https://api.openai.com/v1/chat/completions",
      model: "gpt-4o-mini",
      temperature: 0.3,
    },
    gemini: {
      endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      model: "gemini-1.5-flash",
      temperature: 0.3,
    },
    ollama: {
      endpoint: "http://localhost:11434/v1/chat/completions",
      model: "qwen2.5:7b",
      temperature: 0.3,
    },
  };

  function getAiConfig() {
    try {
      const raw = localStorage.getItem(AI_CONFIG_KEY);
      if (raw) {
        return { ...DEFAULT_AI_CONFIG, ...JSON.parse(raw) };
      }
    } catch (_) {}
    return { ...DEFAULT_AI_CONFIG };
  }

  function saveAiConfig(cfg) {
    try {
      localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(cfg));
    } catch (_) {}
  }

  async function callAiChat(prompt, systemInstruction = null) {
    const cfg = getAiConfig();
    const isLocal = cfg.endpoint.includes("localhost") || cfg.endpoint.includes("127.0.0.1");
    if (!cfg.apiKey && !isLocal) {
      toggleAiConfigModal(true);
      throw new Error("请先在弹出窗口中配置 AI API Key！");
    }

    const messages = [];
    if (systemInstruction) {
      messages.push({ role: "system", content: systemInstruction });
    }
    messages.push({ role: "user", content: prompt });

    const headers = { "Content-Type": "application/json" };
    if (cfg.apiKey) {
      headers["Authorization"] = `Bearer ${cfg.apiKey.trim()}`;
    }

    const res = await fetch(cfg.endpoint.trim(), {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: cfg.model.trim() || "deepseek-chat",
        messages,
        temperature: parseFloat(cfg.temperature) || 0.3,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      let errMsg = `HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(errText);
        errMsg = parsed.error?.message || errMsg;
      } catch (_) {
        errMsg = errText.slice(0, 120);
      }
      throw new Error(errMsg);
    }

    const data = await res.json();
    const choice = data.choices?.[0]?.message?.content || "";
    return choice.trim();
  }

  function buildMltdAiSystemPrompt(item, isPolish = false) {
    let idolContext = "";
    if (item && item.idol) {
      idolContext = `当前讲话者为剧场偶像【${item.idol.name_zh || item.idol.name_ja}】。请保持符合该角色的人设语气与性格习惯。`;
    }

    return `你是一名精通《偶像大师 百万现场 剧场时光》(MLTD) 的资深游戏本地化专家与润色工程师。
你的任务是将日文原文翻译为自然流畅、符合简体中文本土化表达、符合偶像人设性格的译文${isPolish ? "（或对已有译文进行高质量润色）" : ""}。

【最高优先级引擎安全规范】（任何违反都将导致游戏客户端崩溃或数据损坏）：
1. 严禁出现任何半角竖线 "|" 或脱字符 "^"！如果原文或表达中需要分隔，必须转为全角 "｜" 或 "＾"，或用逗号、破折号替代。
2. 完整保留所有制作人占位符：必须严格保留 "{$P$}"，绝不能翻译成 "制作人" 或删去。
3. 完整保留所有编号参数占位符：如 "{0}", "{1}", "{2}" 等，不得修改其编号或丢失。
4. 完整保留所有 printf 格式化占位符：如 "%s", "%d", "%f" 等。
5. 完整保留所有 Unity 富文本样式标签：如 "<color=#HEX>...</color>", "<b>...</b>"，必须闭合完整。
6. 转义换行符 "\\n"：若原文含有 "\\n"，翻译时应保留 "\\n" 维持对话排版。
7. 标准偶像译名：如 天海春香、春日未来、最上静香、伊吹翼、艾蜜莉·司徒亚特、白石紬、樱守歌织 等 52 位剧场偶像官方标准中文名。
${idolContext}

【输出要求】：
仅输出最终的中文译文，严禁输出任何解释、注释、思考过程或包裹 markdown 代码块（如不要带 \`\`\` ）。`;
  }

  // ==========================================================================
  // Engine Safety Format Validator
  // ==========================================================================
  function checkTranslationFormat(source, translation) {
    const errors = [];
    const warnings = [];

    if (!translation || !translation.trim()) {
      return { isValid: false, errors: ["译文为空"], warnings: [] };
    }

    // 1. 致命错误：半角 | 与 ^ (引擎崩溃控制字符)
    if (translation.includes("|")) {
      errors.push('含半角 "|"，请改用全角 "｜"。');
    }
    if (translation.includes("^")) {
      errors.push('含半角 "^"，请改用全角 "＾"。');
    }

    // 2. 制作人变量 {$P$}
    const pVarRegex = /\{\$P\$\}/g;
    const srcPCount = (source.match(pVarRegex) || []).length;
    const transPCount = (translation.match(pVarRegex) || []).length;
    if (srcPCount > 0 && transPCount !== srcPCount) {
      errors.push(`{$P$} 数量不符：原文 ${srcPCount} 处，译文 ${transPCount} 处。`);
    }

    // 3. 数字变量参数 {0}, {1}, {2}...
    const numArgRegex = /\{[0-9]+\}/g;
    const srcNumArgs = source.match(numArgRegex) || [];
    const transNumArgs = translation.match(numArgRegex) || [];
    const srcArgsSet = new Set(srcNumArgs);
    for (const arg of srcArgsSet) {
      const srcArgCount = srcNumArgs.filter(a => a === arg).length;
      const transArgCount = transNumArgs.filter(a => a === arg).length;
      if (transArgCount !== srcArgCount) {
        errors.push(`参数占位符 ${arg} 缺失或数量不符：原文 ${srcArgCount} 处，译文 ${transArgCount} 处。`);
      }
    }

    // 4. printf 格式化符号 %s, %d, %f 等
    const printfRegex = /%[0-9]*[a-zA-Z]/g;
    const srcPrintf = source.match(printfRegex) || [];
    const transPrintf = translation.match(printfRegex) || [];
    if (srcPrintf.length > 0) {
      for (const fmt of new Set(srcPrintf)) {
        const srcCnt = srcPrintf.filter(f => f === fmt).length;
        const transCnt = transPrintf.filter(f => f === fmt).length;
        if (transCnt !== srcCnt) {
          errors.push(`格式化符号 ${fmt} 缺失或数量不一致：原文 ${srcCnt} 处，译文 ${transCnt} 处。`);
        }
      }
    }

    // 5. Unity 富文本标签闭合检查 <color=...>...</color>, <b>...</b>, <i>...</i>
    const colorOpenRegex = /<color=[^>]+>/gi;
    const colorCloseRegex = /<\/color>/gi;
    const colorOpenCnt = (translation.match(colorOpenRegex) || []).length;
    const colorCloseCnt = (translation.match(colorCloseRegex) || []).length;
    if (colorOpenCnt !== colorCloseCnt) {
      errors.push(`<color> 标签未闭合：开 ${colorOpenCnt} / 闭 ${colorCloseCnt}。`);
    }

    const bOpenCnt = (translation.match(/<b>/gi) || []).length;
    const bCloseCnt = (translation.match(/<\/b>/gi) || []).length;
    if (bOpenCnt !== bCloseCnt) {
      errors.push(`<b> 标签未配对：开 ${bOpenCnt} / 闭 ${bCloseCnt}。`);
    }

    // 6. 警告提示 (Warnings，不阻断提交)
    const newlineRegex = /\\n/g;
    const srcNlCnt = (source.match(newlineRegex) || []).length;
    const transNlCnt = (translation.match(newlineRegex) || []).length;
    if (srcNlCnt > 0 && transNlCnt !== srcNlCnt) {
      warnings.push(`\\n 数量不一致：原文 ${srcNlCnt} 处，译文 ${transNlCnt} 处。`);
    }

    if (source.length >= 4 && translation.length > source.length * 2.5) {
      warnings.push(`译文 (${translation.length} 字) 比原文 (${source.length} 字) 长很多，界面可能溢出。`);
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  // Toast notifications
  function showToast(msg, duration = 3000) {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => {
      toast.classList.remove("show");
    }, duration);
  }

  // View Switching
  function switchView(viewName) {
    state.currentView = viewName;
    document.querySelectorAll(".view-section").forEach((sec) => {
      sec.classList.remove("active");
      sec.style.display = "none";
    });
    document.querySelectorAll(".nav-btn").forEach((btn) => {
      btn.classList.remove("active");
    });

    const targetSec = document.getElementById(`view-${viewName}`);
    if (targetSec) {
      targetSec.classList.add("active");
      targetSec.style.display = "block";
    }

    const targetNav = document.getElementById(`nav-${viewName}`);
    if (targetNav) targetNav.classList.add("active");

    if (viewName === "reviewer") {
      loadAdminProposals();
    } else if (viewName === "lobby") {
      loadStats();
    } else if (viewName === "selector") {
      loadSelector(state.selector.channel || "assets");
    } else if (viewName === "releases") {
      loadReleases();
    }
  }

  // ==========================================================================
  // Portal account, GitHub link state and the CSRF token
  // ==========================================================================
  //
  // Two identities are in play and they are not the same one. Cloudflare Access
  // decides who may open the portal at all (`/api/me`); GitHub decides whose
  // name a proposal pull request is opened under (`/api/auth/github/me`). The
  // old header showed only the first and fell back to a hard-coded demo
  // contributor when the session was missing — a display name is not a session,
  // and a write that fails at the last step is worse than one refused at the
  // first, so the fallback is gone and an anonymous session says so.
  //
  // Nothing touches GitHub until the contributor clicks the link button: the
  // link flow starts with a real navigation (the Worker answers 302 to
  // github.com, which `fetch` would follow into a CORS wall).

  /// Headers for every portal write. `credentials: "same-origin"` on the request
  /// is what carries the Access session cookie; the CSRF token is the second,
  /// independent check and is sent in the header the contract names. An empty
  /// token is sent as an empty value rather than omitted, so the request shape
  /// never silently changes.
  function githubPrHeaders() {
    return {
      "Content-Type": "application/json",
      "x-csrf-token": state.csrfToken || "",
    };
  }

  /// The PR link a successful proposal produced. Rendered from the response
  /// alone — a submission that came back without a `pr_url` says so instead of
  /// showing a green tick over nothing. `upstream_direct` is surfaced because it
  /// means the commit did not go through a fork at all.
  function renderPrLink(el, proposal) {
    if (!el) return;
    el.style.display = "block";
    const url = String(proposal?.pr_url || "");
    if (!url) {
      el.className = "pr-result-link is-warning";
      el.textContent = "已提交，但未返回 PR 链接，请到 GitHub 仓库确认";
      return;
    }
    el.className = proposal?.upstream_direct ? "pr-result-link is-warning" : "pr-result-link";
    const number = proposal?.pr_number ? `#${escapeHtml(String(proposal.pr_number))}` : "Pull Request";
    el.innerHTML =
      `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">PR ${number} ↗</a>` +
      (proposal?.upstream_direct ? "<span class=\"pr-ci\">⚠️ 未经 fork，直接提交到上游仓库</span>" : "") +
      "<span class=\"pr-ci\">CI 与合并状态以 GitHub 为准，门户只镜像</span>";
  }

  /// The pure form logic lives in `public/github-contribution.js` so the offline
  /// test exercises the same code the page runs. If that file failed to load,
  /// every write path fails closed — there is deliberately no second copy of the
  /// rules to fall back on, because two copies is how a front end and a Worker
  /// drift apart.
  const contributionApi = (typeof window !== "undefined" && window.MLTDContribution) || null;

  /// The ratio tolerance of the *server's* gate (`checkAspectRatio`,
  /// `DEFAULT_RATIO_TOLERANCE` in `src/image_ratio.js`). The client hint was six
  /// times looser in the old front end, so an upload that looked fine there
  /// could only be refused by the server. The number now comes from the shared
  /// module: one definition, asserted against the Worker's by the test.
  const IMAGE_RATIO_TOLERANCE = contributionApi ? contributionApi.IMAGE_RATIO_TOLERANCE : 0.005;

  function checkImageRatio(actual, original) {
    if (!contributionApi) return { ok: false, reason: "contribution_module_missing", delta: null };
    return contributionApi.checkImageRatio(actual, original);
  }

  function buildTextProposal(item, translation) {
    if (!contributionApi) return { ok: false, reason: "contribution_module_missing" };
    return contributionApi.buildTextProposal(item, translation);
  }

  function buildImageProposal(task, base64) {
    if (!contributionApi) return { ok: false, reason: "contribution_module_missing" };
    return contributionApi.buildImageProposal(task, base64);
  }

  function dataUrlToBase64(dataUrl) {
    if (!contributionApi) throw new Error("contribution_module_missing");
    return contributionApi.dataUrlToBase64(dataUrl);
  }

  function startGithubLogin(e) {
    if (e) e.preventDefault();
    window.location.href = "/api/auth/github/login";
  }

  // User Auth & Status
  function renderUserInfo() {
    const userInfo = document.getElementById("user-info");
    if (!userInfo) return;

    const access = escapeHtml(state.user?.email || state.githubIdentity?.login || "未登录");
    const roleClass = state.user?.role === "admin" ? "admin" : state.user?.role === "reviewer" ? "reviewer" : "";
    const roleLabel = state.user?.role === "admin" ? "管理员" : state.user?.role === "reviewer" ? "审核员" : "贡献者";

    const identity = state.githubIdentity;
    let accountHtml;
    if (identity?.login) {
      const avatar = identity.avatar_url
        ? `<img class="gh-avatar" src="${escapeHtml(identity.avatar_url)}" alt="" referrerpolicy="no-referrer">`
        : "";
      accountHtml = `${avatar}<span class="gh-login" title="提案 PR 以此账号提交">GitHub: ${escapeHtml(identity.login)}</span>`;
    } else {
      accountHtml = `<button class="gh-link-btn" id="btn-github-login" title="关联 GitHub 账号；门户通过 fork + Pull Request 提交，不直接写入仓库">关联 GitHub 账号</button>`;
    }

    userInfo.innerHTML = `
      <span title="站点会话">👤 ${access}</span>
      <span class="role-tag ${roleClass}">${roleLabel}</span>
      ${accountHtml}
      <button class="logout-btn" id="btn-logout" title="退出当前登录账号">登出 ⏏</button>
    `;
    document.getElementById("btn-logout")?.addEventListener("click", handleLogout);
    document.getElementById("btn-github-login")?.addEventListener("click", startGithubLogin);
  }

  async function handleLogout(e) {
    if (e) e.stopPropagation();
    if (!confirm("确定要退出当前登录账号吗？")) return;
    try {
      const response = await fetch("/api/auth/github/logout", {
        method: "POST", credentials: "same-origin", headers: githubPrHeaders(), body: "{}",
      });
      const result = await response.json();
      if (!response.ok || result.ok !== true) throw new Error(result.error || "logout_failed");
      try {
        localStorage.removeItem("mltd_terms_v2");
        sessionStorage.clear();
      } catch (_) {}
      state.user = null;
      state.githubIdentity = null;
      state.csrfToken = "";
      window.location.reload();
    } catch (error) {
      showToast(`退出登录失败：${error.message}`, 4000);
    }
  }

  // 只采用服务端验证过的 GitHub 会话；GitHub 用户不必有公开邮箱。
  async function checkUser() {
    state.user = null;
    state.githubIdentity = null;
    state.csrfToken = "";
    state.access = { authenticated: false };
    try {
      const res = await fetch("/api/auth/github/me", {
        credentials: "same-origin", headers: { accept: "application/json" },
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.authenticated === true && data.login) {
          state.githubIdentity = data;
          state.user = { login: data.login, email: data.email || null,
            github_user_id: data.github_user_id, role: data.role || "contributor", via: "github" };
          state.csrfToken = String(data.csrfToken || "");
          state.access = { authenticated: true, via: "github" };
        }
      }
    } catch (_) {}
    renderUserInfo();
    const navReviewer = document.getElementById("nav-reviewer");
    if (navReviewer) {
      navReviewer.style.display = ["reviewer", "admin"].includes(state.user?.role) ? "inline-flex" : "none";
    }
  }
  let lastStatsFetchTime = 0;
  const STATS_CACHE_DURATION = 3 * 60 * 1000; // 3 minutes client throttle

  // Load Terms & Idols (with localStorage cache to eliminate repeat requests)
  async function loadTerms() {
    try {
      const cached = localStorage.getItem("mltd_terms_v2");
      if (cached) {
        const parsed = JSON.parse(cached);
        state.terms = Array.isArray(parsed.terms) ? parsed.terms : [];
        state.idols = parsed.idols || {};
        renderQuickTerms();
      }
    } catch (_) {}

    try {
      const res = await fetch("/api/terms");
      if (res.ok) {
        const data = await res.json();
        state.terms = Array.isArray(data.terms) ? data.terms : [];
        state.idols = data.idols || {};
        try {
          localStorage.setItem("mltd_terms_v2", JSON.stringify({ terms: state.terms, idols: state.idols }));
        } catch (_) {}
        renderQuickTerms();
      }
    } catch (err) {
      console.warn("Failed to load terms:", err);
    }
  }

  // Load & Render Stats
  async function loadStats(force = false) {
    const now = Date.now();
    if (!force && state.stats && (now - lastStatsFetchTime < STATS_CACHE_DURATION)) {
      renderStatsUI();
      return;
    }
    try {
      const res = await fetch("/api/stats");
      if (!res.ok) {
        console.warn("Failed to fetch /api/stats, status:", res.status);
        return;
      }
      const data = await res.json();
      const summary = data.summary || data;
      state.stats = {
        ...data,
        ...summary,
        total: summary.total ?? data.total ?? 0,
        accepted: summary.accepted ?? data.accepted ?? 0,
        pending: summary.pending ?? data.pending ?? 0,
        contributors: summary.contributors ?? data.contributors ?? 0,
        progress_percent: summary.progress_percent ?? data.progress_percent ?? 0,
        untranslated: summary.untranslated ?? data.untranslated ?? 0,
        categories: data.categories || {},
        by_idol: data.by_idol || (Array.isArray(data.idols) ? Object.fromEntries(data.idols.map(i => [i.code, i])) : {})
      };
      lastStatsFetchTime = now;
      renderStatsUI();
    } catch (err) {
      console.warn("Failed to load stats:", err);
    }
  }

  function renderStatsUI() {
    if (!state.stats) return;
    document.getElementById("stat-total").textContent = Number(state.stats.total || 0).toLocaleString();
    document.getElementById("stat-accepted").textContent = Number(state.stats.accepted || 0).toLocaleString();
    document.getElementById("stat-pending").textContent = Number(state.stats.pending || 0).toLocaleString();
    document.getElementById("stat-contributors").textContent = Number(state.stats.contributors || 0).toLocaleString();

    const total = Number(state.stats.total || 0);
    const accepted = Number(state.stats.accepted || 0);
    const serverPct = Number(state.stats.progress_percent || 0);
    // Release manifests distinguish accepted, pending and untranslated rows.
    // Calculate the visible progress from the accepted/total pair so a release
    // with pending rows cannot be rounded up to a misleading 100%.
    const pctValue = total > 0 && Number.isFinite(accepted)
      ? Math.min(100, Math.max(0, (accepted / total) * 100))
      : serverPct;
    const pct = pctValue.toFixed(1);
    document.getElementById("progress-fill").style.width = `${pct}%`;
    document.getElementById("stat-percent").textContent = `${pct}%`;
    const untranslated = Number(state.stats.untranslated || 0);
    const pending = Number(state.stats.pending || 0);
    document.getElementById("stat-untranslated-label").textContent = `待处理（翻译/审核）: ${(untranslated + pending).toLocaleString()} 条`;

    // The category truth comes from the release manifest. Keep the source
    // visible so a stale or fallback summary is reviewable.
    const sourceNote = document.getElementById("resource-hub-source");
    if (sourceNote) {
      const release = state.stats.release_id || state.stats.asset_version || "当前 Assets release";
      const updated = state.stats.summary_updated_at ? new Date(state.stats.summary_updated_at).toLocaleString() : "未知时间";
      const source = state.stats.source === "github" ? "GitHub manifest" : "release summary";
      sourceNote.textContent = `主页分类来自 ${release} 的 ${source}（${updated}）${state.stats.summary_stale ? " · 摘要可能已过期，请刷新" : ""}`;
      sourceNote.classList.toggle("is-stale", Boolean(state.stats.summary_stale));
    }

    renderCategoriesGrid();
  }

  // Render category cards from the release manifests. The browser does not
  // carry a taxonomy or category-to-entry map; both arrive from the Worker.
  function activateLobbyDomain(domain = "all") {
    const value = String(domain || "all");
    state.activeDomain = value;
    document.querySelectorAll("#domain-tabs .domain-tab").forEach((tab) => {
      tab.classList.toggle("active", tab.getAttribute("data-domain") === value);
    });
    const catGrid = document.getElementById("categories-grid");
    const lyricsSec = document.getElementById("lyrics-section");
    const imgSec = document.getElementById("lobby-images-section");
    if (value === "images") {
      if (catGrid) catGrid.style.display = "none";
      if (lyricsSec) lyricsSec.style.display = "none";
      if (imgSec) imgSec.style.display = "block";
      loadImagesView();
    } else if (value === "lyrics") {
      if (catGrid) catGrid.style.display = "none";
      if (imgSec) imgSec.style.display = "none";
      if (lyricsSec) lyricsSec.style.display = "block";
      loadSongsCatalog();
    } else {
      if (catGrid) catGrid.style.display = "grid";
      if (imgSec) imgSec.style.display = "none";
      if (lyricsSec) lyricsSec.style.display = "none";
      renderCategoriesGrid();
    }
  }

  function renderCategoriesGrid() {
    const grid = document.getElementById("categories-grid");
    if (!grid) return;
    grid.innerHTML = "";

    const activeDomain = state.activeDomain;
    const manifests = state.resourceManifests || {};
    const channels = ["assets", "client"]
      .filter((channel) => state.activeResource === "all" || state.activeResource === channel)
      .map((channel) => ({ channel, manifest: manifests[channel] }))
      .filter((entry) => entry.manifest && Array.isArray(entry.manifest.categories));
    const categories = channels.flatMap(({ channel, manifest }) => manifest.categories.map((category) => ({ ...category, channel })));
    const filtered = categories.filter((category) => activeDomain === "all" || category.domain === activeDomain);

    // The domain tabs are generated from the manifests and disappear when a
    // release does not expose that domain.
    const tabs = document.getElementById("domain-tabs");
    if (tabs) {
      const domainRows = [];
      const seen = new Set();
      categories.forEach((category) => {
        if (seen.has(category.domain)) return;
        seen.add(category.domain);
        const domain = (channels.find(({ manifest }) => manifest.domains?.some((item) => item.id === category.domain))?.manifest.domains || [])
          .find((item) => item.id === category.domain);
        domainRows.push({ id: category.domain, name: domain?.name || category.domain, icon: domain?.icon || "📦" });
      });
      tabs.innerHTML = `<button class="domain-tab active" data-domain="all">全部</button>` + domainRows.map((domain) =>
        `<button class="domain-tab" data-domain="${escapeHtml(domain.id)}">${escapeHtml(domain.icon)} ${escapeHtml(domain.name)}</button>`
      ).join("");
      tabs.querySelectorAll(".domain-tab").forEach((tab) => tab.addEventListener("click", () => {
        activateLobbyDomain(tab.dataset.domain || "all");
      }));
    }

    filtered.forEach((sub) => {
      const total = Number(sub.total || 0);
      const accepted = Number(sub.accepted || 0);
      const pct = sub.progress_percent == null ? 0 : Number(sub.progress_percent);

      const card = document.createElement("div");
      card.className = "cat-card";
      card.setAttribute("data-category", sub.id);

      card.innerHTML = `
        <div class="cat-card-header">
          <span class="cat-icon">${sub.icon}</span>
          <span class="cat-name">
            ${escapeHtml(sub.name)}
            <span class="cat-domain-badge">${escapeHtml(sub.channel.toUpperCase())} · ${escapeHtml(sub.domain)}</span>
          </span>
        </div>
        <p class="cat-desc">${escapeHtml(sub.description || sub.name)}</p>
        <div class="cat-meta-row">
          <span>总计: <span class="stat-bold">${Number(total).toLocaleString()}</span> ${escapeHtml(sub.unit || "项")}</span>
          <span>完成度: <span class="stat-bold">${pct}%</span></span>
        </div>
        <div class="cat-progress-wrap">
          <div class="cat-progress-bar" style="width:${pct}%"></div>
        </div>
        <div class="cat-footer">
          <button class="cat-btn">${sub.domain === "images" ? "浏览贴图专区 →" : "进入专属工作台 →"}</button>
        </div>
      `;

      card.addEventListener("click", () => {
        if (sub.entry === "images") {
          filterImagesCategoryAndShow(sub.id.replace(/^img_/, "") || "all");
        } else if (sub.entry === "lyrics") {
          const lyricsTab = document.querySelector('.domain-tab[data-domain="lyrics"]');
          if (lyricsTab) lyricsTab.click();
        } else {
          state.activeResource = sub.channel;
          startStudioWithFilter({ category: sub.id, idol: null, status: "untranslated" });
        }
      });

      grid.appendChild(card);
    });
  }

  // ==========================================================================
  // Lyrics Songs Showcase Logic (song list and per-song slot counts both come
  // from the release's own rows: a keyset-paged index plus the release summary)
  // ==========================================================================
  async function loadSongsCatalog() {
    if (state.songsCatalog) {
      renderSongsGrid();
      return;
    }
    // The index is a keyset page capped at 100 rows per request (the Worker's
    // MAX_PAGE_LIMIT), so a full song list is walked page by page. A `limit=500`
    // request used to be answered by materialising the whole catalogue; it is
    // now clamped, which is why this loop exists rather than one big fetch.
    try {
      const songs = [];
      let cursor = "";
      for (let page = 0; page < 40; page += 1) {
        const url = `/api/lyrics/songs?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const res = await fetch(url);
        if (!res.ok) {
          if (songs.length === 0) {
            const detail = await res.json().catch(() => ({}));
            state.songsError = detail.detail || detail.error || `HTTP ${res.status}`;
            renderSongsGrid();
          }
          return;
        }
        const data = await res.json();
        songs.push(...(data.songs || []));
        cursor = data.next_cursor || "";
        if (!cursor) break;
      }
      state.songsCatalog = songs;
      state.songsError = null;
      renderSongsGrid();
    } catch (err) {
      console.warn("Failed to load songs catalog:", err);
      state.songsError = String(err?.message || err);
      renderSongsGrid();
    }
  }

  function renderSongsGrid() {
    const grid = document.getElementById("songs-grid");
    if (!grid) return;
    grid.innerHTML = "";

    if (state.songsError) {
      grid.innerHTML = `<p style='color:var(--text-muted);padding:1rem'>曲目清单暂不可用：${escapeHtml(state.songsError)}</p>`;
      return;
    }

    if (!state.songsCatalog) {
      grid.innerHTML = "<p style='color:var(--text-muted);padding:1rem'>正在加载曲目清单...</p>";
      return;
    }

    // The tab label and the header pill are filled from the catalogue that was
    // actually loaded, not from a number written into the markup.
    const countAll = document.getElementById("song-type-count-all");
    if (countAll) countAll.textContent = `(${state.songsCatalog.length})`;
    const songsPill = document.getElementById("lyrics-count-songs");
    if (songsPill) songsPill.textContent = `${state.songsCatalog.length} 首`;
    const domainPill = document.getElementById("lyrics-domain-count");
    if (domainPill) domainPill.textContent = `(${state.songsCatalog.length})`;

    const typeFilter = state.activeSongType;
    const kw = state.songFilterKeyword.trim().toLowerCase();

    const filtered = state.songsCatalog.filter(s => {
      if (typeFilter !== "all" && s.type.toLowerCase() !== typeFilter.toLowerCase()) return false;
      if (kw) {
        const nameJa = (s.name_ja || "").toLowerCase();
        const nameZh = (s.name_zh || "").toLowerCase();
        const asset = (s.asset || "").toLowerCase();
        const pJa = (s.preview_ja || "").toLowerCase();
        const pZh = (s.preview_zh || "").toLowerCase();
        return nameJa.includes(kw) || nameZh.includes(kw) || asset.includes(kw) || pJa.includes(kw) || pZh.includes(kw);
      }
      return true;
    });

    if (filtered.length === 0) {
      grid.innerHTML = "<p style='color:var(--text-muted);padding:1rem'>未找到匹配的歌曲</p>";
      return;
    }

    filtered.forEach(song => {
      const card = document.createElement("div");
      card.className = `song-card type-${song.type}`;

      // Slot counts come from the release's own summary, so a song whose bundle
      // is in the release but has no summary row yet renders without a
      // percentage rather than with an invented 100%.
      const slots = song.slots;
      const trans = song.translated;
      const pct = (typeof slots === "number" && slots > 0 && typeof trans === "number")
        ? Math.round((trans / slots) * 100)
        : null;

      card.innerHTML = `
        <div class="song-card-header">
          <div class="song-title-group">
            <div class="song-title-ja">${escapeHtml(song.name_ja)}</div>
            <div class="song-title-zh">${escapeHtml(song.name_zh)}</div>
          </div>
          <span class="song-type-tag ${song.type}">${song.type}</span>
        </div>
        ${song.preview_ja ? `
          <div class="song-preview-snippet">
            <div class="preview-ja">🇯🇵 ${escapeHtml(song.preview_ja)}</div>
            <div class="preview-zh">🇨🇳 ${escapeHtml(song.preview_zh || "（待校对）")}</div>
          </div>
        ` : ""}
        <div class="song-meta-line">
          <span>${typeof slots === "number" ? `共 ${slots} 句歌词` : "歌词句数待同步"}</span>
          <span class="song-progress-text">${pct === null ? "—" : `${pct}% 已对齐`}</span>
        </div>
        <button class="song-open-btn">🎵 进入打歌时间轴校对</button>
      `;

      card.addEventListener("click", () => {
        startLyricsStudio(song);
      });

      grid.appendChild(card);
    });
  }

  // Start Dedicated Lyrics Studio for a specific song (Minimal D1 reads: 1-point query, 20-50 rows only!)
  async function startLyricsStudio(songMeta) {
    state.currentSongMeta = songMeta;
    state.currentMode = "lyrics";

    // Check client session cache first (0 D1 reads!)
    if (state.sessionSongLyricsCache[songMeta.bundle]) {
      state.studioQueue = state.sessionSongLyricsCache[songMeta.bundle];
      state.studioIndex = 0;
      switchView("studio");
      renderDedicatedLyricsStudio();
      return;
    }

    showToast(`正在加载《${songMeta.name_zh}》打歌歌词视轨...`);
    let lines = [];
    try {
      const res = await fetch(`/api/lyrics/song?bundle=${encodeURIComponent(songMeta.bundle)}`);
      if (res.ok) {
        const data = await res.json();
        if (!data.quota_exceeded) lines = data.lines || [];
      }
    } catch (err) {
      console.warn("lyrics api failed:", err);
    }

    // No static fallback: `/api/lyrics/song` is the only authority. A generated
    // `/data/lyrics/<bundle>.json` snapshot would re-authorise a source the
    // release does not carry, so an empty release stays empty here.
    if (lines.length === 0) {
      showToast("该歌曲暂无独立分轨歌词条目");
      return;
    }

    state.sessionSongLyricsCache[songMeta.bundle] = lines;
    state.studioQueue = lines;
    state.studioIndex = 0;
    switchView("studio");
    renderDedicatedLyricsStudio();
  }

  // ==========================================================================
  // Render Dedicated Lyrics Studio (曲名 + 每一行歌词打歌视轨)
  // ==========================================================================
  function renderDedicatedLyricsStudio() {
    // Show lyrics layout, hide others
    document.getElementById("studio-lyrics-layout").style.display = "block";
    document.getElementById("studio-chat-layout").style.display = "none";
    document.getElementById("studio-story-layout").style.display = "none";
    document.getElementById("studio-standard-layout").style.display = "none";
    const imgLayoutLyrics = document.getElementById("studio-image-layout");
    if (imgLayoutLyrics) imgLayoutLyrics.style.display = "none";

    const song = state.currentSongMeta;
    const lines = state.studioQueue;

    // Badges & top nav
    const catBadge = document.getElementById("studio-category-badge");
    const idolBadge = document.getElementById("studio-idol-badge");
    const modePill = document.getElementById("studio-mode-pill");
    const indexDisp = document.getElementById("studio-index-display");

    catBadge.textContent = "🎵 打歌歌词";
    idolBadge.style.display = "none";
    modePill.textContent = "🎵 音乐韵律与打歌视轨模式";
    modePill.style.background = "#2563eb";
    indexDisp.textContent = `全曲共 ${lines.length} 句`;

    // Hero metadata
    document.getElementById("lyrics-dedicated-title-ja").textContent = song?.name_ja || "歌曲歌词";
    document.getElementById("lyrics-dedicated-title-zh").textContent = song?.name_zh || "";
    document.getElementById("lyrics-dedicated-bundle").textContent = song?.bundle || lines[0]?.bundle || "";
    document.getElementById("lyrics-dedicated-bpm").textContent = `BPM ${song?.bpm || 170}`;

    const typeTag = document.getElementById("lyrics-dedicated-type");
    typeTag.textContent = song?.type || "All";
    typeTag.className = `song-type-tag ${song?.type || "All"}`;

    const acceptedCount = lines.filter(l => l.status === "accepted").length;
    const pct = lines.length > 0 ? Math.round((acceptedCount / lines.length) * 100) : 0;
    document.getElementById("lyrics-dedicated-progress").textContent = `共 ${lines.length} 行歌词 · ${pct}% 已校对`;

    // Render lines list
    renderLyricsLinesList();
  }

  function renderLyricsLinesList() {
    const listEl = document.getElementById("lyrics-lines-list");
    if (!listEl) return;
    listEl.innerHTML = "";

    const lines = state.studioQueue;
    const filter = state.activeLyricLineFilter;

    lines.forEach((line, index) => {
      if (filter === "untranslated" && line.status === "accepted") return;
      if (filter === "pending" && line.status !== "pending") return;

      const row = document.createElement("div");
      row.className = "lyric-line-row";
      row.id = `lyric-row-${index}`;

      const slotIdx = line.slot_index || (index + 1);
      const slotStr = `#${String(slotIdx).padStart(3, "0")}`;

      const statusMap = {
        untranslated: { label: "未翻译", class: "untranslated" },
        pending: { label: "已提 PR", class: "pending" },
        accepted: { label: "已采纳", class: "accepted" },
      };
      const st = statusMap[line.status] || statusMap.untranslated;

      const jaText = line.source;
      const zhText = line.translation || "";

      row.innerHTML = `
        <div class="col-slot">${slotStr}</div>
        <div class="col-ja">${escapeHtml(jaText)}</div>
        <div class="col-zh">
          <input
            type="text"
            class="lyric-inline-input"
            id="lyric-input-${index}"
            value="${escapeHtml(zhText)}"
            placeholder="请输入对应节拍中文翻译 (Ctrl+Enter 保存)..."
          />
          <div class="lyric-meter-hint">
            <span>日文约 ${jaText.length} 拍</span>
            <span class="char-len-meter" id="len-meter-${index}">· 当前中文 ${zhText.length} 字</span>
          </div>
        </div>
        <div class="col-status">
          <span class="pr-result-link" id="lyric-pr-link-${index}" style="display:none"></span>
          <span class="lyric-status-badge ${st.class}" id="lyric-st-badge-${index}">${st.label}</span>
        </div>
        <div class="col-action" style="display:flex;gap:6px;align-items:center">
          <button class="btn-mini btn-ai-action" id="btn-ai-lyric-${index}" title="使用 AI 单行歌词翻译" style="padding:4px 8px;font-size:0.75rem">🤖 AI</button>
          <button class="btn-lyric-save" id="btn-save-lyric-${index}">💾 提交 PR</button>
        </div>
      `;

      const input = row.querySelector(`#lyric-input-${index}`);
      const lenMeter = row.querySelector(`#len-meter-${index}`);
      const saveBtn = row.querySelector(`#btn-save-lyric-${index}`);
      const aiBtn = row.querySelector(`#btn-ai-lyric-${index}`);

      aiBtn?.addEventListener("click", async () => {
        aiBtn.disabled = true;
        aiBtn.textContent = "⏳";
        try {
          const songName = state.currentSongMeta?.name_zh || state.currentSongMeta?.name_ja || "偶像大师歌曲";
          const systemPrompt = `你是一名精通日文动漫与游戏歌曲本地化的专业译者。这是偶像大师百万现场歌曲《${songName}》的单行歌词。
请翻译为优美、符合原曲节拍、适合中文歌唱的单行中文歌词。
【严格禁令】：严禁包含半角 "|" 或 "^" 字符！仅输出这一行中文歌词，不要带多余解释或引号。`;
          const prompt = `日文单行歌词：\n${jaText}\n\n请输出对应的一行中文歌词：`;
          const res = await callAiChat(prompt, systemPrompt);
          const clean = res.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").replace(/\|/g, "｜").replace(/\^/g, "＾").trim();
          input.value = clean;
          lenMeter.textContent = `· 当前中文 ${clean.length} 字`;
          showToast(`✨ 第 ${slotStr} 拍歌词 AI 生成完成`);
        } catch (err) {
          showToast(`AI 生成失败: ${err.message}`);
        } finally {
          aiBtn.disabled = false;
          aiBtn.textContent = "🤖 AI";
        }
      });

      input.addEventListener("input", (e) => {
        const val = e.target.value;
        lenMeter.textContent = `· 当前中文 ${val.length} 字`;
        if (val.includes("|") || val.includes("^")) {
          input.style.borderColor = "#ef4444";
        } else {
          input.style.borderColor = "";
        }
      });

      input.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          saveSingleLyricLine(index);
        }
      });

      saveBtn.addEventListener("click", () => {
        saveSingleLyricLine(index);
      });

      listEl.appendChild(row);
    });
  }

  /// Save one lyric slot as a GitHub proposal.
  ///
  /// Same contract as the studio submit: a *line edit* keyed by `logical_key`,
  /// bound to the exact `path` and `base_commit` the server named, under the one
  /// version axis this resource belongs to (lyrics ride the assets channel). The
  /// whole file is never sent — the Worker rewrites the single matching row and
  /// everything else in the pinned JSONL stays exactly as it was.
  async function saveSingleLyricLine(index) {
    const line = state.studioQueue[index];
    if (!line) return;
    const input = document.getElementById(`lyric-input-${index}`);
    const saveBtn = document.getElementById(`btn-save-lyric-${index}`);
    const stBadge = document.getElementById(`lyric-st-badge-${index}`);
    const prLink = document.getElementById(`lyric-pr-link-${index}`);

    const transVal = input.value.trim();
    if (!transVal) {
      showToast("译文不能为空");
      return;
    }
    if (transVal.includes("|") || transVal.includes("^")) {
      showToast("⚠️ 请改用全角 ｜ 或 ＾");
      return;
    }

    if (!state.githubIdentity) {
      showToast("请先在页面右上角关联 GitHub 账号，歌词提案会以 fork + PR 提交", 5000);
      return;
    }
    if (!state.csrfToken) {
      showToast("缺少请求令牌（CSRF），请刷新页面后重新登录 GitHub 账号", 5000);
      return;
    }

    const proposal = buildTextProposal(line, transVal);
    if (!proposal.ok) {
      if (proposal.reason === "binding_missing") {
        showToast(`❌ 该歌词条目缺少提交绑定（${proposal.missing.join(" / ")}），门户不会自造路径或基线提交`, 6000);
      } else {
        showToast(`❌ ${describeSubmitError(proposal.reason)}`, 6000);
      }
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = "提交中...";

    try {
      const res = await fetch("/api/contributions/github-pr", {
        method: "POST",
        credentials: "same-origin",
        headers: githubPrHeaders(),
        body: JSON.stringify(proposal.payload),
      });

      const resData = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(describeSubmitError(resData.error));
      }

      line.translation = transVal;
      line.status = "proposed";
      line.pr_url = resData.pr_url || null;

      stBadge.textContent = "已提 PR";
      stBadge.className = "lyric-status-badge pending";
      renderPrLink(prLink, resData);

      showToast(`✅ 槽位 #${String(line.slot_index || (index+1)).padStart(3, "0")} 已提交 PR`, 4000);

      // Automatically focus next row if available
      const nextInput = document.getElementById(`lyric-input-${index + 1}`);
      if (nextInput) {
        nextInput.focus();
        nextInput.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    } catch (err) {
      showToast(`❌ 提交失败: ${err.message}`, 6000);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "💾 提交 PR";
    }
  }

  function saveStudioSession() {
    try {
      sessionStorage.setItem("mltd_studio_session", JSON.stringify({
        filter: state.currentFilter,
        index: state.studioIndex,
        queue: state.studioQueue,
        mode: state.currentMode,
        songMeta: state.currentSongMeta
      }));
    } catch (_) {}
  }

  // Studio Flow
  async function startStudioWithFilter(filter, useCache = true) {
    state.currentFilter = { ...state.currentFilter, ...filter };
    state.currentSongMeta = null;

    const curStatus = state.currentFilter.status || "all";
    document.querySelectorAll(".status-toggle-btn").forEach((b) => {
      const bSt = b.getAttribute("data-status-filter") || "all";
      b.classList.toggle("active", bSt === curStatus || (!state.currentFilter.status && bSt === "all"));
    });

    if (useCache) {
      try {
        const saved = sessionStorage.getItem("mltd_studio_session");
        if (saved) {
          const parsed = JSON.parse(saved);
          const sameCategory = parsed.filter?.category === state.currentFilter.category;
          const sameIdol = parsed.filter?.idol === state.currentFilter.idol;
          const sameStatus = parsed.filter?.status === state.currentFilter.status;
          const sameKeyword = parsed.filter?.keyword === state.currentFilter.keyword;
          if (sameCategory && sameIdol && sameStatus && sameKeyword && Array.isArray(parsed.queue) && parsed.index < parsed.queue.length) {
            state.studioQueue = parsed.queue;
            state.studioIndex = parsed.index;
            state.currentMode = parsed.mode || detectStudioMode(state.studioQueue[state.studioIndex]);
            state.currentSongMeta = parsed.songMeta || null;
            switchView("studio");
            renderCurrentStudioItem();
            return;
          }
        }
      } catch (_) {}
    }

    state.studioIndex = 0;
    state.studioQueue = [];

    showToast("正在检索待翻译条目...");
    const params = new URLSearchParams();
    if (state.currentFilter.category) params.set("category", state.currentFilter.category);
    if (state.currentFilter.idol) params.set("idol", state.currentFilter.idol);
    if (state.currentFilter.status) params.set("status", state.currentFilter.status);
    if (state.currentFilter.keyword) params.set("query", state.currentFilter.keyword);
    const activeAssetVersion = state.activeResource === "assets"
      ? state.resourceManifests?.assets?.release?.asset_version
      : null;
    if (activeAssetVersion) params.set("asset_version", activeAssetVersion);
    params.set("limit", "50");

    try {
      const res = await fetch(`/api/catalogue/search?${params.toString()}`);
      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        if (activeAssetVersion && (errorBody.error === "unregistered_asset_version" || errorBody.error === "data_not_ready")) {
          showToast(`${activeAssetVersion} 的任务索引尚未同步，分类统计已从 GitHub manifest 读取`, 6000);
        } else {
          showToast("未找到匹配的条目");
        }
        return;
      }
      const data = await res.json();
      if (data.quota_exceeded) {
        showToast(data.message || "今日额度已用完，08:00 恢复", 6000);
        return;
      }
      if (data.status_fallback === "all" && data.rows?.length) {
        state.currentFilter.status = "all";
      }
      // The latest Assets manifest uses `pending` for reviewed rows awaiting
      // publication; it can legitimately report zero `untranslated` rows.
      // Keep the existing filter semantics for older D1 releases, but make the
      // latest-only portal fall back to pending work so category buttons remain
      // actionable.
      if ((!data.rows || data.rows.length === 0)
        && activeAssetVersion
        && state.currentFilter.status === "untranslated") {
        const pendingParams = new URLSearchParams(params);
        pendingParams.set("status", "pending");
        const pendingRes = await fetch(`/api/catalogue/search?${pendingParams.toString()}`);
        if (pendingRes.ok) {
          const pendingData = await pendingRes.json();
          if (Array.isArray(pendingData.rows) && pendingData.rows.length) {
            state.currentFilter.status = "pending";
            data.rows = pendingData.rows;
          } else {
            // Some older generated locale files contain the translated source
            // rows while the release manifest carries the pending count. Keep
            // the category usable by showing the pinned rows when no pending
            // row is materialised in that file yet.
            const allParams = new URLSearchParams(params);
            allParams.set("status", "all");
            const allRes = await fetch(`/api/catalogue/search?${allParams.toString()}`);
            if (allRes.ok) {
              const allData = await allRes.json();
              if (Array.isArray(allData.rows) && allData.rows.length) {
                state.currentFilter.status = "all";
                data.rows = allData.rows;
              }
            }
          }
        }
      }
      state.studioQueue = data.rows || [];
      if (state.studioQueue.length === 0) {
        showToast(activeAssetVersion
          ? `${activeAssetVersion} 的该分类暂无待翻译条目，或任务索引尚未同步`
          : "该分类下暂无待翻译条目");
        return;
      }

      state.currentMode = detectStudioMode(state.studioQueue[0]);
      saveStudioSession();
      switchView("studio");
      renderCurrentStudioItem();
    } catch (err) {
      showToast("加载工作台失败: " + err.message);
    }
  }

  // Detect which tailored Studio mode fits the item
  function detectStudioMode(item) {
    if (!item) return "standard";
    const b = String(item.bundle || "").toLowerCase();
    const cat = String(item.category || "").toLowerCase();
    if (b.startsWith("scrobj_") || cat === "lyrics") return "lyrics";
    if (cat === "event_chat" || cat === "card_blog" || b.includes("chat") || b.startsWith("card_blst_")) return "chat";
    if (cat === "event_story" || cat === "main_commu" || cat === "special_commu" || cat === "birth_live" || b.includes("story") || b.startsWith("special_") || b.startsWith("st_")) return "story";
    if (cat === "card_episode" || cat === "card_skill" || b.startsWith("card_") || b.startsWith("cd_")) return "card";
    if (cat === "message_board" || cat === "theater_comm" || cat === "live_result" || cat === "login_bonus" || b.startsWith("cm_") || b.startsWith("mb_") || b.startsWith("lbonus_")) return "lounge";
    return "system";
  }

  // ==========================================================================
  // Render Current Studio Item (With Category-Tailored Studio Layouts!)
  // ==========================================================================
  function renderCurrentStudioItem() {
    if (state.studioIndex >= state.studioQueue.length) {
      showToast("🎉 本批次任务已全部完成！");
      try { sessionStorage.removeItem("mltd_studio_session"); } catch (_) {}
      switchView("lobby");
      return;
    }

    const item = state.studioQueue[state.studioIndex];
    state.currentItem = item;

    // Detect Tailored Mode
    state.currentMode = detectStudioMode(item);
    const mode = state.currentMode;

    if (mode === "lyrics" && state.currentSongMeta) {
      renderDedicatedLyricsStudio();
      return;
    }

    // Default: switch on standard layout
    document.getElementById("studio-lyrics-layout").style.display = "none";
    document.getElementById("studio-chat-layout").style.display = "none";
    document.getElementById("studio-story-layout").style.display = "none";
    const imgLayoutStd = document.getElementById("studio-image-layout");
    if (imgLayoutStd) imgLayoutStd.style.display = "none";
    document.getElementById("studio-standard-layout").style.display = "grid";

    // Badges & Context
    const idolBadge = document.getElementById("studio-idol-badge");
    const catBadge = document.getElementById("studio-category-badge");
    const modePill = document.getElementById("studio-mode-pill");
    const indexDisp = document.getElementById("studio-index-display");

    if (item.idol) {
      idolBadge.style.display = "inline-flex";
      idolBadge.textContent = item.idol.name_zh || item.idol.code;
      idolBadge.style.background = item.idol.color ? `${item.idol.color}22` : "";
      idolBadge.style.color = item.idol.color || "";
      idolBadge.style.borderColor = item.idol.color || "";
    } else {
      idolBadge.style.display = "none";
    }

    const subcatMap = {
      event_story: "🌟 活动剧情",
      main_commu: "📖 主线剧情",
      special_commu: "🎭 特别企划",
      event_chat: "📱 活动聊天",
      card_episode: "🎴 觉醒物语",
      card_blog: "💌 偶像博客",
      card_skill: "⚔️ 卡片技能",
      theater_comm: "🏢 剧场互动",
      message_board: "📝 白板留言",
      live_result: "🎤 演出结算",
      login_bonus: "🎁 登录演出",
      birth_live: "🎂 生日演出",
      birth_greet: "🎈 生日祝贺",
      system_ui: "⚙️ 界面系统",
      lyrics: "🎵 打歌歌词"
    };
    catBadge.textContent = subcatMap[item.category] || item.category_name || item.category || "剧场";

    const modeLabels = {
      lyrics: { text: "🎵 音乐韵律与打歌视轨模式", color: "#2563eb" },
      chat: { text: "📱 手机即时通讯模式", color: "#16a34a" },
      story: { text: "🌟 剧场 AVG 剧本模式", color: "#9333ea" },
      card: { text: "🎴 卡面物语与档案模式", color: "#d97706" },
      lounge: { text: "🏢 休息室日常留言模式", color: "#ca8a04" },
      system: { text: "⚙️ 游戏规则与菜单模式", color: "#475569" },
    };
    const modeInfo = modeLabels[mode] || { text: "标准工作台", color: "#0284c7" };
    if (modePill) {
      modePill.textContent = modeInfo.text;
      modePill.style.background = modeInfo.color;
    }

    indexDisp.textContent = `第 ${state.studioIndex + 1} / ${state.studioQueue.length} 条`;

    // Speaker avatar & name & bundle
    const speakerDot = document.getElementById("studio-speaker-dot");
    const speakerName = document.getElementById("studio-speaker-name");
    const bundleName = document.getElementById("studio-bundle-name");

    if (item.idol) {
      speakerDot.style.background = item.idol.color || "#ea5b76";
      speakerDot.textContent = (item.idol.name_zh || "").slice(0, 1) || "春";
      speakerName.textContent = item.idol.name_zh;
    } else {
      speakerDot.style.background = "#64748b";
      speakerDot.textContent = mode === "lyrics" ? "歌" : "旁";
      speakerName.textContent = mode === "lyrics" ? (state.currentSongMeta?.name_zh || "打歌歌词") : (item.item_key?.split("/")[0] || "旁白 / 系统提示");
    }
    if (bundleName) {
      bundleName.textContent = item.bundle || "";
    }

    // Render Mode Specific Custom Banner (Lyrics / Chat / AVG / Card / Lounge / System)
    renderStudioModeBanner(item, mode);

    // Text & Term Highlights
    renderSourceWithHighlights(item.source);

    // Render Existing Translation Card (For Re-translation and Polishing)
    const existingWrap = document.getElementById("existing-trans-box-wrap");
    const existingBox = document.getElementById("existing-trans-box");
    const existingStatus = document.getElementById("existing-trans-status");
    const existingTrans = item.translation || item.current_translation || "";

    if (existingWrap) {
      if (existingTrans && existingTrans.trim()) {
        existingWrap.style.display = "block";
        if (existingBox) existingBox.textContent = existingTrans;
        if (existingStatus) {
          const isAccepted = item.status === "accepted";
          const isPending = item.status === "pending";
          existingStatus.textContent = isAccepted ? "已采纳 (Accepted)" : (isPending ? "待审核 (Pending)" : "已有译文");
          existingStatus.className = `existing-status-badge ${isAccepted ? "accepted" : (isPending ? "pending" : "")}`;
        }
      } else {
        existingWrap.style.display = "none";
      }
    }

    // Textarea reset
    const textarea = document.getElementById("translation-input");
    textarea.value = item.translation || item.current_translation || "";
    validateTranslationInput(textarea.value);
    textarea.focus();
  }

  // Render Category-Tailored Banner
  function renderStudioModeBanner(item, mode) {
    const banner = document.getElementById("studio-mode-banner");
    if (!banner) return;
    banner.innerHTML = "";

    if (mode === "chat") {
      banner.innerHTML = `
        <div class="chat-studio-phone">
          <div class="phone-island-bar">
            <span>9:41 AM</span>
            <div class="island-notch"></div>
            <span>剧场通信 5G 📶</span>
          </div>
          <div class="chat-bubble-stream">
            <div class="chat-bubble-row idol">
              <div class="chat-avatar" style="background:${item.idol?.color || '#ea5b76'}">
                ${(item.idol?.name_zh || "偶").slice(0, 1)}
              </div>
              <div class="chat-bubble-body">
                <strong>${escapeHtml(item.idol?.name_zh || "偶像")}:</strong>
                <div>${escapeHtml(item.source)}</div>
              </div>
            </div>
          </div>
        </div>
      `;
    } else if (mode === "story") {
      banner.innerHTML = `
        <div class="avg-studio-stage">
          <div class="avg-scene-badge">
            <span>🎭 剧场篇章</span>
            <span>${escapeHtml(item.bundle)}</span>
          </div>
          <div class="avg-dialogue-card">
            <div class="avg-speaker-title">${escapeHtml(item.idol?.name_zh || "剧场人物")}</div>
            <div style="font-size:1.05rem">${escapeHtml(item.source)}</div>
          </div>
        </div>
      `;
    } else if (mode === "card") {
      banner.innerHTML = `
        <div class="card-studio-frame">
          <div class="card-frame-header">
            <span class="ssr-gold-tag">SSR 专属物语与卡面</span>
            <span style="font-size:0.8rem;color:#b45309;font-weight:700">卡面编号: ${escapeHtml(item.item_key)}</span>
          </div>
          <div style="font-size:0.95rem;color:#78350f">
            <strong>原文台词:</strong> ${escapeHtml(item.source)}
          </div>
        </div>
      `;
    } else if (mode === "lounge") {
      banner.innerHTML = `
        <div class="lounge-studio-memo">
          <div class="lounge-memo-tag">📌 休息室白板留言便签 · ${escapeHtml(item.idol?.name_zh || "偶像")}</div>
          <div style="font-size:1rem;color:#713f12;font-style:italic">“${escapeHtml(item.source)}”</div>
        </div>
      `;
    } else if (mode === "system") {
      banner.innerHTML = `
        <div class="system-studio-meter">
          <span>⚙️ 界面系统规范：日文 ${item.source.length} 字 · 中文建议在 ${Math.max(2, Math.round(item.source.length * 0.8))}~${Math.round(item.source.length * 1.2)} 字内，防止 UI 溢出</span>
          <span>⚠️ 严禁半角 | 与 ^</span>
        </div>
      `;
    }
  }

  // Parse & Highlight terms safely
  function renderSourceWithHighlights(sourceText) {
    const box = document.getElementById("studio-source-box");
    const hintsBar = document.getElementById("term-hints-bar");
    box.innerHTML = "";
    hintsBar.innerHTML = "";

    if (!sourceText) return;

    const detectedTerms = [];

    const idolList = Array.isArray(state.idols) ? state.idols : Object.values(state.idols || {});
    idolList.forEach((idol) => {
      if (idol && idol.name_ja && typeof idol.name_ja === "string" && idol.name_ja.length >= 2 && sourceText.includes(idol.name_ja)) {
        detectedTerms.push({ ja: idol.name_ja, zh: idol.name_zh || idol.name_ja, color: idol.color });
      }
    });

    const termList = Array.isArray(state.terms) ? state.terms : [];
    termList.forEach((t) => {
      const ja = typeof t.source === "string" ? t.source : "";
      const zh = typeof t.target === "string" ? t.target : "";
      if (ja && zh && ja.length >= 2 && sourceText.includes(ja)) {
        detectedTerms.push({ ja, zh, color: null });
      }
    });

    const uniqueTermsMap = new Map();
    detectedTerms.forEach((t) => {
      if (!uniqueTermsMap.has(t.ja)) uniqueTermsMap.set(t.ja, t);
    });
    const uniqueTerms = Array.from(uniqueTermsMap.values()).sort((a, b) => b.ja.length - a.ja.length);

    const intervals = [];
    uniqueTerms.forEach((t) => {
      let idx = 0;
      while ((idx = sourceText.indexOf(t.ja, idx)) !== -1) {
        const end = idx + t.ja.length;
        const overlaps = intervals.some(inv => (idx < inv.end && end > inv.start));
        if (!overlaps) {
          intervals.push({ start: idx, end, term: t });
        }
        idx += 1;
      }
    });
    intervals.sort((a, b) => a.start - b.start);

    let html = "";
    let cursor = 0;
    intervals.forEach(inv => {
      if (inv.start > cursor) {
        html += escapeHtml(sourceText.slice(cursor, inv.start));
      }
      const rawTerm = sourceText.slice(inv.start, inv.end);
      const colorStyle = inv.term.color ? `style="--term-color:${inv.term.color};border-bottom-color:${inv.term.color};color:${inv.term.color}"` : "";
      html += `<span class="term-highlight" data-ja="${escapeHtml(inv.term.ja)}" data-zh="${escapeHtml(inv.term.zh)}" ${colorStyle} title="点击填入: ${escapeHtml(inv.term.zh)}">${escapeHtml(rawTerm)}</span>`;
      cursor = inv.end;
    });
    if (cursor < sourceText.length) {
      html += escapeHtml(sourceText.slice(cursor));
    }
    box.innerHTML = html;

    const hintsBarWrap = document.querySelector(".term-hints-bar-wrap");
    if (uniqueTerms.length > 0) {
      if (hintsBarWrap) hintsBarWrap.style.display = "block";
      uniqueTerms.forEach((t) => {
        const chip = document.createElement("div");
        chip.className = "hint-chip";
        const colorDot = t.color ? `<span class="chip-color-dot" style="background:${t.color}"></span>` : "";
        chip.innerHTML = `${colorDot}<strong>${escapeHtml(t.ja)}</strong> → <span class="zh-target">${escapeHtml(t.zh)}</span> <span class="fill-action">[填入]</span>`;
        chip.title = `点击将「${t.zh}」填入光标位置`;
        chip.addEventListener("click", () => {
          insertTermIntoTextarea(t.zh);
        });
        hintsBar.appendChild(chip);
      });
    } else {
      if (hintsBarWrap) hintsBarWrap.style.display = "none";
    }

    box.querySelectorAll(".term-highlight").forEach((el) => {
      el.addEventListener("click", () => {
        const zh = el.getAttribute("data-zh");
        if (zh) insertTermIntoTextarea(zh);
      });
    });
  }

  // Quick helper tools
  function copySourceToTranslation() {
    if (!state.currentItem || !state.currentItem.source) return;
    const textarea = document.getElementById("translation-input");
    textarea.value = state.currentItem.source;
    validateTranslationInput(textarea.value);
    textarea.focus();
    showToast("已复制原文，保留标签后修改");
  }

  function extractSkeleton() {
    if (!state.currentItem || !state.currentItem.source) return;
    const src = state.currentItem.source;
    let skeleton = src.replace(/<[^>]+>|\{\$[A-Za-z0-9_]+\$\}|\{[0-9]+\}|%[a-z]|\\n/g, (tag) => `\u0001${tag}\u0002`);
    const parts = skeleton.split(/\u0001|\u0002/);
    const result = parts.map((part, i) => {
      if (i % 2 === 1) return part;
      return part.trim() ? "【译文】" : part;
    }).join("");

    const textarea = document.getElementById("translation-input");
    textarea.value = result;
    validateTranslationInput(textarea.value);
    textarea.focus();
    showToast("已提取标签骨架，替换【译文】即可");
  }

  function fixDelimitersInInput() {
    const textarea = document.getElementById("translation-input");
    const val = textarea.value;
    if (!val.includes("|") && !val.includes("^")) {
      showToast("译文里没有半角 | 或 ^");
      return;
    }
    const fixed = val.replace(/\|/g, "｜").replace(/\^/g, "＾");
    textarea.value = fixed;
    validateTranslationInput(fixed);
    showToast("已替换为全角 ｜ 与 ＾");
  }

  function toggleTutorialModal(show) {
    const modal = document.getElementById("tutorial-modal");
    if (!modal) return;
    modal.style.display = show ? "flex" : "none";
    document.body.style.overflow = show ? "hidden" : "";
  }

  function renderQuickTerms() {
    const list = document.getElementById("quick-terms-list");
    if (!list) return;
    list.innerHTML = "";
    const termList = Array.isArray(state.terms) ? state.terms : [];
    const sample = termList.slice(0, 24);
    sample.forEach(t => {
      const item = document.createElement("div");
      item.className = "quick-term-item";
      item.innerHTML = `<span class="q-ja">${escapeHtml(t.source)}</span><span class="q-arrow">→</span><span class="q-zh">${escapeHtml(t.target)}</span>`;
      item.title = `点击填入: ${t.target}`;
      item.addEventListener("click", () => insertTermIntoTextarea(t.target));
      list.appendChild(item);
    });
    const countEl = document.getElementById("quick-terms-count");
    if (countEl) countEl.textContent = `${termList.length} 条`;
  }

  function insertTermIntoTextarea(zh) {
    const textarea = document.getElementById("translation-input");
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const val = textarea.value;

    textarea.value = val.substring(0, start) + zh + val.substring(end);
    textarea.selectionStart = textarea.selectionEnd = start + zh.length;
    textarea.focus();
    validateTranslationInput(textarea.value);
  }

  function validateTranslationInput(val) {
    const textarea = document.getElementById("translation-input");
    const valMsg = document.getElementById("validation-msg");
    const btnSubmit = document.getElementById("btn-studio-submit");
    const charCounter = document.getElementById("char-counter");
    const valPanel = document.getElementById("format-validation-panel");
    const valBadge = document.getElementById("val-badge");
    const valSummary = document.getElementById("val-summary");
    const valList = document.getElementById("validation-details-list");

    if (charCounter) charCounter.textContent = `${val.length} 字`;

    const source = state.currentItem?.source || "";
    const result = checkTranslationFormat(source, val);

    // 基础输入框降级提示
    if (!valPanel || !valBadge) {
      if (val.trim().length === 0) {
        if (btnSubmit) btnSubmit.disabled = true;
        return false;
      }
      if (!result.isValid) {
        textarea?.classList.add("error");
        if (valMsg) {
          valMsg.textContent = result.errors[0];
          valMsg.style.display = "block";
        }
        if (btnSubmit) btnSubmit.disabled = true;
        return false;
      }
      textarea?.classList.remove("error");
      if (valMsg) valMsg.style.display = "none";
      if (btnSubmit) btnSubmit.disabled = false;
      return true;
    }

    if (valList) valList.innerHTML = "";

    // 尚未输入
    if (val.trim().length === 0) {
      valPanel.className = "format-validation-panel";
      valBadge.className = "val-badge";
      valBadge.textContent = "等待输入";
      if (valSummary) valSummary.textContent = "输入译文后自动检查格式";
      if (valList) valList.style.display = "none";
      if (valMsg) valMsg.style.display = "none";
      textarea?.classList.remove("error");
      if (btnSubmit) btnSubmit.disabled = true;
      return false;
    }

    // 存在致命格式错误，严禁提交
    if (!result.isValid) {
      valPanel.className = "format-validation-panel is-error";
      valBadge.className = "val-badge is-error";
      valBadge.textContent = "❌ 格式错误 (禁止提交)";
      if (valSummary) valSummary.textContent = `${result.errors.length} 处格式错误，须先修正`;
      textarea?.classList.add("error");

      if (valList) {
        valList.style.display = "flex";
        result.errors.forEach(err => {
          const item = document.createElement("div");
          item.className = "val-detail-item error-item";
          item.innerHTML = `⛔ <strong>错误:</strong> ${escapeHtml(err)}`;
          valList.appendChild(item);
        });

        result.warnings.forEach(warn => {
          const item = document.createElement("div");
          item.className = "val-detail-item warn-item";
          item.innerHTML = `⚠️ <strong>提示:</strong> ${escapeHtml(warn)}`;
          valList.appendChild(item);
        });
      }

      if (valMsg) {
        valMsg.textContent = result.errors[0];
        valMsg.style.display = "block";
      }
      if (btnSubmit) btnSubmit.disabled = true;
      return false;
    }

    // 格式通过
    textarea?.classList.remove("error");
    if (valMsg) valMsg.style.display = "none";

    if (result.warnings.length > 0) {
      valPanel.className = "format-validation-panel is-warning";
      valBadge.className = "val-badge is-warning";
      valBadge.textContent = "⚠️ 有提示 (可提交)";
      if (valSummary) valSummary.textContent = "格式合规，仅字数或排版提示";

      if (valList) {
        valList.style.display = "flex";
        result.warnings.forEach(warn => {
          const item = document.createElement("div");
          item.className = "val-detail-item warn-item";
          item.innerHTML = `⚠️ <strong>提示:</strong> ${escapeHtml(warn)}`;
          valList.appendChild(item);
        });
      }
    } else {
      valPanel.className = "format-validation-panel is-ok";
      valBadge.className = "val-badge is-ok";
      valBadge.textContent = "✅ 格式通过";
      if (valSummary) valSummary.textContent = "标签、变量与占位符均完整";
      if (valList) valList.style.display = "none";
    }

    if (btnSubmit) btnSubmit.disabled = false;
    return true;
  }

  // AI Actions
  async function requestAiTranslation() {
    if (!state.currentItem || !state.currentItem.source) return;
    const textarea = document.getElementById("translation-input");
    const btnAi = document.getElementById("btn-ai-translate");
    const originalBtnText = btnAi ? btnAi.textContent : "";

    if (btnAi) {
      btnAi.disabled = true;
      btnAi.textContent = "🤖 翻译中...";
    }

    try {
      const systemPrompt = buildMltdAiSystemPrompt(state.currentItem, false);
      const userPrompt = `请将以下 MLTD 游戏日文文本翻译为简体中文，严格遵守引擎特殊符号与占位符规范：\n\n${state.currentItem.source}`;

      const result = await callAiChat(userPrompt, systemPrompt);
      let cleanText = result.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
      cleanText = cleanText.replace(/\|/g, "｜").replace(/\^/g, "＾");

      textarea.value = cleanText;
      validateTranslationInput(cleanText);
      textarea.focus();
      showToast("✨ AI 翻译完成，请检查后提交");
    } catch (err) {
      showToast(`❌ AI 翻译失败: ${err.message}`);
    } finally {
      if (btnAi) {
        btnAi.disabled = false;
        btnAi.textContent = originalBtnText;
      }
    }
  }

  async function requestAiPolish() {
    if (!state.currentItem || !state.currentItem.source) return;
    const textarea = document.getElementById("translation-input");
    const existingTrans = state.currentItem.translation || state.currentItem.current_translation || textarea.value;

    if (!existingTrans || !existingTrans.trim()) {
      showToast("还没有译文，先执行 AI 翻译");
      return requestAiTranslation();
    }

    const btnPolish = document.getElementById("btn-ai-polish");
    const quickPolishBtn = document.getElementById("btn-ai-quick-polish");
    const triggerBtn = btnPolish || quickPolishBtn;
    const originalText = triggerBtn ? triggerBtn.textContent : "";

    if (triggerBtn) {
      triggerBtn.disabled = true;
      triggerBtn.textContent = "✨ 润色中...";
    }

    try {
      const systemPrompt = buildMltdAiSystemPrompt(state.currentItem, true);
      const userPrompt = `请在保留原意、保留全部特殊控制符和占位标签的前提下，对已有译文进行通顺度与角色口吻润色优化：
【日文原文】：
${state.currentItem.source}

【已有译文】：
${existingTrans}

请输出润色优化后的简体中文译文：`;

      const result = await callAiChat(userPrompt, systemPrompt);
      let cleanText = result.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
      cleanText = cleanText.replace(/\|/g, "｜").replace(/\^/g, "＾");

      textarea.value = cleanText;
      validateTranslationInput(cleanText);
      textarea.focus();
      showToast("✨ AI 润色完成");
    } catch (err) {
      showToast(`❌ AI 润色失败: ${err.message}`);
    } finally {
      if (triggerBtn) {
        triggerBtn.disabled = false;
        triggerBtn.textContent = originalText;
      }
    }
  }

  function toggleAiConfigModal(show) {
    const modal = document.getElementById("ai-config-modal");
    if (!modal) return;
    modal.style.display = show ? "flex" : "none";
    document.body.style.overflow = show ? "hidden" : "";

    if (show) {
      const cfg = getAiConfig();
      const ep = document.getElementById("ai-endpoint");
      const key = document.getElementById("ai-api-key");
      const model = document.getElementById("ai-model");
      const temp = document.getElementById("ai-temperature");
      const tempVal = document.getElementById("ai-temp-val");

      if (ep) ep.value = cfg.endpoint || "";
      if (key) key.value = cfg.apiKey || "";
      if (model) model.value = cfg.model || "";
      if (temp) temp.value = cfg.temperature !== undefined ? cfg.temperature : 0.3;
      if (tempVal) tempVal.textContent = (cfg.temperature !== undefined ? cfg.temperature : 0.3).toFixed(2);
    }
  }

  async function testAiConnection() {
    const btnTest = document.getElementById("btn-test-ai");
    const originalText = btnTest ? btnTest.textContent : "";
    if (btnTest) {
      btnTest.disabled = true;
      btnTest.textContent = "⏳ 测试通信中...";
    }

    try {
      const epInput = document.getElementById("ai-endpoint");
      const keyInput = document.getElementById("ai-api-key");
      const modelInput = document.getElementById("ai-model");
      const tempInput = document.getElementById("ai-temperature");

      const ep = (epInput?.value || "").trim();
      const key = (keyInput?.value || "").trim();
      const model = (modelInput?.value || "").trim();
      const temp = parseFloat(tempInput?.value || "0.3") || 0.3;

      if (!ep) {
        throw new Error("请输入 API 接口端点 (Endpoint)");
      }

      if (!key && !ep.includes("localhost") && !ep.includes("127.0.0.1")) {
        throw new Error("请输入 API Key");
      }

      // 临时保存当前输入以供测试
      saveAiConfig({ endpoint: ep, apiKey: key, model: model, temperature: temp });

      const testReply = await callAiChat("请回复一句话测试通信（如'MLTD AI 已就绪'）：", "你是一个测试助理。");
      showToast(`✅ 连接成功：${testReply}`, 5000);
    } catch (err) {
      showToast(`❌ 测试失败: ${err.message}`, 6000);
    } finally {
      if (btnTest) {
        btnTest.disabled = false;
        btnTest.textContent = originalText;
      }
    }
  }

  // Submit Contribution (Optimistic local update, Zero extra D1 select reads!)
  /// Submit the current studio line as a GitHub proposal.
  ///
  /// This is the only write path in the studio. It posts a *line edit* to
  /// `/api/contributions/github-pr`; the Worker reads the pinned JSONL, verifies
  /// the source hash and rewrites the single matching row. The portal does not
  /// accept a translation itself, does not touch D1 as a write target, and does
  /// not "restore" anything locally — GitHub's pull request is the review, and
  /// the merge is the acceptance.
  ///
  /// A submission can stop in three places, and each one is reported:
  ///   * no linked GitHub account or no CSRF token → the button is disabled;
  ///   * the item carries no binding (path / base_commit) → refused here, because
  ///     a guessed path or base commit would produce a PR nobody asked for;
  ///   * the API answered an error → its code is shown, never a fake success.
  async function submitCurrentTranslation() {
    if (!state.currentItem) return;
    const textarea = document.getElementById("translation-input");
    const translation = textarea.value.trim();

    if (!validateTranslationInput(translation)) return;

    const btnSubmit = document.getElementById("btn-studio-submit");
    const prLink = document.getElementById("studio-pr-link");

    // Identity first. A proposal is opened under the linked GitHub account; with
    // no link there is nothing to open it with, and the flow to get one is one
    // navigation, not a hidden retry.
    if (!state.githubIdentity) {
      showToast("请先在页面右上角关联 GitHub 账号，提案会以 fork + PR 提交", 5000);
      return;
    }
    if (!state.csrfToken) {
      showToast("缺少请求令牌（CSRF），请刷新页面后重新登录 GitHub 账号", 5000);
      return;
    }

    const proposal = buildTextProposal(state.currentItem, translation);
    if (!proposal.ok) {
      if (proposal.reason === "binding_missing") {
        showToast(`❌ 该条目缺少提交绑定（${proposal.missing.join(" / ")}）：门户不自造路径、基线提交与目标仓库`, 6000);
      } else {
        showToast(`❌ ${describeSubmitError(proposal.reason)}`, 6000);
      }
      return;
    }

    btnSubmit.disabled = true;
    btnSubmit.textContent = "提交 PR 中...";
    if (prLink) prLink.style.display = "none";

    try {
      const res = await fetch("/api/contributions/github-pr", {
        method: "POST",
        credentials: "same-origin",
        headers: githubPrHeaders(),
        body: JSON.stringify(proposal.payload),
      });

      const resData = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(describeSubmitError(resData.error));
      }

      renderPrLink(prLink, resData);

      // Local bookkeeping only: the line is now *proposed*, not accepted. No
      // counter is incremented and no status is written back to any server —
      // the PR, and only the PR, records what happened.
      state.currentItem.translation = translation;
      state.currentItem.status = "proposed";
      state.currentItem.pr_url = resData.pr_url || null;
      state.currentItem.pr_number = resData.pr_number || null;
      if (resData.upstream_direct) {
        showToast("⚠️ 本次提交未经 fork 直接进入上游仓库，请联系维护者核对凭据", 8000);
      } else {
        showToast("✅ 已创建 Pull Request，请在 GitHub 上查看审核与 CI", 4500);
      }

      btnSubmit.textContent = "✅ 已提交 PR";
    } catch (err) {
      showToast(`❌ 提交失败: ${err.message}`, 6000);
      btnSubmit.disabled = false;
      btnSubmit.textContent = "提交 PR (Ctrl+Enter)";
    }
  }

  // ==========================================================================
  // Admin view: proposals, PR links and CI
  // ==========================================================================
  //
  // Deliberately read-only with respect to review state. The list *shows* each
  // proposal's pull request, its GitHub state, its mergeable state and its CI
  // rollup, because GitHub is the review authority and a second verdict decided
  // here would be a competing one. There is no accept/reject button on this
  // view, no write to D1, and no backfill: a merged PR is what "accepted" means,
  // and merging happens on GitHub.

  const ADMIN_CI_LABELS = {
    success: { text: "CI 通过", cls: "success" },
    failure: { text: "CI 失败", cls: "failure" },
    pending: { text: "CI 运行中", cls: "pending" },
    error: { text: "CI 出错", cls: "failure" },
  };

  function renderGithubProposalCard(row) {
    const gh = row.github;
    const card = document.createElement("div");
    card.className = "queue-card admin-pr-card";

    if (!gh) {
      // A contribution with no proposal yet is not an error: it is a row that
      // has not been turned into a PR. Saying "no PR" is the honest answer.
      card.innerHTML = `
        <div class="queue-meta">
          <span>📦 ${escapeHtml(row.bundle || "-")} · ${escapeHtml(row.item_key || "-")}</span>
          <span>👤 ${escapeHtml(row.contributor_email || "匿名")}</span>
        </div>
        <div class="admin-pr-missing">尚未提交 PR（该条目排队中，门户不会代替 GitHub 判定）</div>
      `;
      return card;
    }

    const ci = ADMIN_CI_LABELS[String(gh.ci_status || "").toLowerCase()] || null;
    const stateText = gh.merged ? "已合并" : String(gh.state || "unknown");
    const mergeableText = gh.mergeable_state || "unknown";
    const isImage = String(gh.head_branch || "").startsWith("portal/image/");
    const previewMissing = isImage ? "（图片提案，请在 GitHub 查看图像 diff）" : "（文字预览未镜像，请在 GitHub 查看 diff）";

    card.innerHTML = `
      <div class="queue-meta">
        <span>📦 ${escapeHtml(gh.target_repo || row.target_repo || "")} · ${escapeHtml(gh.head_branch || "")}</span>
        <span>👤 ${escapeHtml(row.contributor_email || "匿名")} · ${new Date(row.updated_at || row.created_at || Date.now()).toLocaleString()}</span>
      </div>
      <div class="queue-source"><strong>原文:</strong> ${escapeHtml(row.ja || previewMissing)}</div>
      <div class="queue-translation"><strong>译文:</strong> ${escapeHtml(row.zh || previewMissing)}</div>
      <div class="admin-pr-row">
        <a class="pr-link" href="${escapeHtml(gh.pr_url || "#")}" target="_blank" rel="noopener noreferrer">PR ${gh.pr_number != null ? "#" + escapeHtml(String(gh.pr_number)) : ""} ↗</a>
        <span class="admin-pr-badge state-${escapeHtml(stateText === "已合并" ? "merged" : "open")}">${escapeHtml(stateText)}</span>
        <span class="admin-pr-badge">mergeable: ${escapeHtml(mergeableText)}</span>
        ${ci ? `<span class="admin-pr-badge ci-${ci.cls}">${ci.text}</span>` : `<span class="admin-pr-badge">CI 未镜像</span>`}
        <code class="hash-short" title="${escapeHtml(gh.head_sha || "")}">${escapeHtml(String(gh.head_sha || "").slice(0, 10))}</code>
      </div>
    `;
    return card;
  }

  async function loadAdminProposals() {
    const list = document.getElementById("admin-proposal-list");
    if (!list) return;
    const targetSelect = document.getElementById("admin-target-filter");
    list.innerHTML = "<p style='color:var(--text-muted)'>正在加载提案列表...</p>";

    const params = new URLSearchParams();
    if (targetSelect?.value) params.set("target", targetSelect.value);
    const query = params.toString();

    try {
      const res = await fetch(`/api/admin/contributions${query ? `?${query}` : ""}`);
      if (!res.ok) {
        list.innerHTML = "<p style='color:var(--danger)'>无法加载提案列表（需要审核员或管理员权限）</p>";
        return;
      }
      const data = await res.json();
      const rows = data.rows || [];
      if (rows.length === 0) {
        list.innerHTML = "<p style='color:var(--text-muted)'>暂无提案记录</p>";
        return;
      }
      list.replaceChildren(...rows.map(renderGithubProposalCard));
    } catch (err) {
      list.innerHTML = `<p style='color:var(--danger)'>加载失败: ${escapeHtml(err.message)}</p>`;
    }
  }
  // ==========================================================================
  // ==========================================================================
  // View 4: Image Localization Functions & Auto-Restore Pipeline
  // ==========================================================================
  let allImageTasksCache = null;

  const IMAGE_TASK_PAGE_SIZE = 60;

  /**
   * Image tasks come from D1 (`image_task_units`), a page at a time.
   *
   * The old loader fetched `/data/image_tasks.json` — a single generated file
   * that grew with the reconstruction backlog, so the first paint of this view
   * pulled the whole task list and the file went stale the moment the pipeline
   * advanced. Now the view pages through the API with the server's cursor; the
   * static file is only a reconstructible cache for the importer.
   */
  async function loadImageTasks({ force = false } = {}) {
    if (!force && allImageTasksCache) return allImageTasksCache;
    const tasks = [];
    let cursor = "";
    let pages = 0;
    while (pages < 40) {
      const query = new URLSearchParams({ pageSize: String(IMAGE_TASK_PAGE_SIZE) });
      if (state.images.category && state.images.category !== "all") query.set("category", state.images.category);
      if (state.images.search) query.set("search", state.images.search);
      if (cursor) query.set("cursor", cursor);
      const res = await fetch(`/api/images/tasks?${query.toString()}`);
      if (!res.ok) break;
      const data = await res.json();
      tasks.push(...(data.tasks || []));
      if (data.categories) {
        state.images.categories = data.categories;
        state.images.total = data.total ?? Object.values(data.categories).reduce((a, b) => a + Number(b || 0), 0);
      }
      pages += 1;
      if (!data.next_cursor) break;
      cursor = data.next_cursor;
    }
    allImageTasksCache = tasks;
    return tasks;
  }

  async function loadImagesView(force = false) {
    try {
      allImageTasksCache = null;
      // Task statuses arrive with the listing itself. The separate
      // `GET /api/images/status` overlay read is gone with the write path it
      // mirrored: the service no longer serves that table to the portal, and a
      // second read that can only fail is not worth the request.
      await loadImageTasks({ force: force || true });
      updateImageStatsUI();
    } catch (err) {
      console.warn("Failed to load image tasks data:", err);
    }
    renderImageTasks();
  }

  function updateImageStatsUI() {
    const totalEl = document.getElementById("stat-img-total");
    const notNeededEl = document.getElementById("stat-img-not-needed");
    const eventEl = document.getElementById("stat-img-event");
    const costumeEl = document.getElementById("stat-img-costume");
    const tutorialEl = document.getElementById("stat-img-tutorial");
    if (totalEl) totalEl.textContent = `${state.images.categories.all || 0} 张整图`;
    if (notNeededEl) {
      const notNeededCount = allImageTasksCache ? allImageTasksCache.filter(t => t.status === "not_needed").length : (state.images.statuses?.not_needed || 0);
      notNeededEl.textContent = `${notNeededCount} 无需汉化`;
    }
    if (eventEl) eventEl.textContent = `${state.images.categories.event || 0} 活动横幅`;
    if (costumeEl) costumeEl.textContent = `${state.images.categories.costume || 0} 服饰海报`;
    if (tutorialEl) tutorialEl.textContent = `${state.images.categories.tutorial || 0} 教学图解`;
    // The category tabs carry counts too, and they come from the same roll-up as
    // the pills above. They used to be literals in index.html, which meant the
    // toolbar went stale whenever a release changed while everything around it
    // updated.
    const categoryCounts = state.images.categories || {};
    document.querySelectorAll("#img-category-tabs .domain-tab").forEach(tab => {
      const key = tab.getAttribute("data-img-category") || "all";
      const count = categoryCounts[key];
      const label = tab.textContent.replace(/\s*\(\d[\d,]*\)\s*$/, "").trim();
      tab.textContent = typeof count === "number" ? `${label} (${count})` : label;
    });
    // The tab and the header pill both carry release state, so they are written
    // from the same source the table is built from.
    const imagesTab = document.querySelector('.domain-tab[data-domain="images"]');
    if (imagesTab) imagesTab.textContent = `🖼️ 贴图 (${state.images.categories.all || 0})`;
  }

  function renderImageTasks() {
    const grid = document.getElementById("image-tasks-grid");
    if (!grid) return;

    if (!allImageTasksCache || allImageTasksCache.length === 0) {
      grid.innerHTML = `<div class="empty-state" style="grid-column: 1/-1; text-align:center; padding:3rem;">加载中...</div>`;
      return;
    }

    let filtered = allImageTasksCache;

    // Filter by Category
    if (state.images.category !== "all") {
      filtered = filtered.filter(t => t.category === state.images.category);
    }

    // Filter by Status
    if (state.images.status !== "all") {
      filtered = filtered.filter(t => t.status === state.images.status);
    }

    // Filter by Search Keyword
    if (state.images.search) {
      const q = state.images.search.toLowerCase();
      filtered = filtered.filter(t =>
        (t.task_id && t.task_id.toLowerCase().includes(q)) ||
        (t.bundle && t.bundle.toLowerCase().includes(q)) ||
        (t.description && t.description.toLowerCase().includes(q))
      );
    }

    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / state.images.pageSize));
    if (state.images.page > totalPages) state.images.page = totalPages;

    const startIndex = (state.images.page - 1) * state.images.pageSize;
    const paged = filtered.slice(startIndex, startIndex + state.images.pageSize);

    if (paged.length === 0) {
      grid.innerHTML = `
        <div class="empty-state" style="grid-column: 1/-1; text-align:center; padding:3rem; color:var(--text-muted)">
          <div style="font-size:2.5rem; margin-bottom:0.5rem">🖼️</div>
          <p>没有找到符合条件的图片任务</p>
        </div>
      `;
      renderImagePagination(0, 1);
      return;
    }

    grid.innerHTML = paged.map(task => {
      const statusClass = task.status === "accepted" ? "accepted" : task.status === "restored" ? "restored" : task.status === "not_needed" ? "not_needed" : "untranslated";
      // `restored` was the retired R2 upload queue's word; the portal no longer
      // produces it (a proposal is `proposed`), so it is not printed.
      const statusLabel = task.status === "accepted" ? "🟢 已验收" : task.status === "not_needed" ? "🔵 无需汉化" : task.status === "proposed" ? "🟣 已提 PR" : "⚪ 待汉化";
      const downloadUrl = `/api/images/asset?task_id=${encodeURIComponent(task.task_id)}&type=composite&download=1`;
      const thumbUrl = `/api/images/asset?task_id=${encodeURIComponent(task.task_id)}&type=composite`;

      // The card-level status toggle is retired. Marking a task "no Japanese
      // text" used to write an `image_status_overrides` row through the portal;
      // that decision now belongs to the maintainer, and the portal's own
      // surfaces are read-only with respect to it. The task's status is still
      // shown as the badge on the card.
      const toggleBtnHtml = "";

      return `
        <div class="image-task-card" data-task-id="${escapeHtml(task.task_id)}">
          <div class="image-card-thumb-wrap">
            <span class="image-card-status-badge ${statusClass}">${statusLabel}</span>
            <span class="image-card-dim-badge">${task.width}×${task.height}</span>
            <img src="${thumbUrl}" alt="${escapeHtml(task.description)}" loading="lazy" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'100\\' height=\\'100\\'%3E%3Ctext x=\\'50%25\\' y=\\'50%25\\' dominant-baseline=\\'middle\\' text-anchor=\\'middle\\' fill=\\'%23666\\'%3E暂无预览%3C/text%3E%3C/svg%3E'" />
          </div>
          <div class="image-card-content">
            <div class="image-card-header">
              <span class="image-card-category-tag">${escapeHtml(task.category_name || "贴图")}</span>
              <span class="image-card-bundle">${escapeHtml(task.bundle.replace(".unity3d", ""))}</span>
            </div>
            <div class="image-card-title">${escapeHtml(task.description)}</div>
            <div class="image-card-actions">
              <a href="${downloadUrl}" class="btn-card-action secondary" target="_blank" download="${escapeHtml(task.task_id)}-composite.png" title="直接下载拼接好的完整透明原图 PNG">
                📥 原图
              </a>
              ${toggleBtnHtml}
              <button type="button" class="btn-card-action primary btn-open-img-studio" data-task-id="${escapeHtml(task.task_id)}">
                ✏️ ${task.status === "accepted" || task.status === "proposed" ? "重新汉化" : "上传汉化"}
              </button>
            </div>
          </div>
        </div>
      `;
    }).join("");

    renderImagePagination(total, totalPages);

    // Bind card action buttons: opens directly in the Studio workbench!
    grid.querySelectorAll(".btn-open-img-studio").forEach(btn => {
      btn.addEventListener("click", () => {
        const tid = btn.getAttribute("data-task-id");
        const found = allImageTasksCache.find(t => t.task_id === tid);
        if (found) openImageInStudio(found);
      });
    });

    // No bindings for `.btn-toggle-task-status`: the per-card status toggle is
    // retired (see onStudioImageStatusClick), so no card renders one.
  }

  function renderImagePagination(total, totalPages) {
    const pag = document.getElementById("image-pagination");
    if (!pag) return;
    if (totalPages <= 1) {
      pag.innerHTML = "";
      return;
    }

    const cur = state.images.page;
    let html = `
      <button class="page-btn" id="btn-img-prev" ${cur <= 1 ? "disabled" : ""}>« 上一页</button>
      <span style="font-size:0.85rem; color:var(--text-muted); margin:0 0.5rem">第 ${cur} / ${totalPages} 页 (共 ${total} 张)</span>
      <button class="page-btn" id="btn-img-next" ${cur >= totalPages ? "disabled" : ""}>下一页 »</button>
    `;
    pag.innerHTML = html;

    document.getElementById("btn-img-prev")?.addEventListener("click", () => {
      if (state.images.page > 1) {
        state.images.page--;
        renderImageTasks();
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    });

    document.getElementById("btn-img-next")?.addEventListener("click", () => {
      if (state.images.page < totalPages) {
        state.images.page++;
        renderImageTasks();
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    });
  }

  // ==========================================================================
  // Filter Images Category and Switch to Lobby Images Section
  // ==========================================================================
  function filterImagesCategoryAndShow(category = "all") {
    state.activeDomain = "images";
    document.querySelectorAll(".domain-tab").forEach(t => {
      if (t.getAttribute("data-domain") === "images") t.classList.add("active");
      else t.classList.remove("active");
    });

    const catGrid = document.getElementById("categories-grid");
    const lyricsSec = document.getElementById("lyrics-section");
    const imgSec = document.getElementById("lobby-images-section");

    if (catGrid) catGrid.style.display = "none";
    if (lyricsSec) lyricsSec.style.display = "none";
    if (imgSec) imgSec.style.display = "block";

    state.images.category = category;
    document.querySelectorAll("#img-category-tabs .domain-tab").forEach(t => {
      if (t.getAttribute("data-img-category") === category) t.classList.add("active");
      else t.classList.remove("active");
    });

    loadImagesView();
    imgSec?.scrollIntoView({ behavior: "smooth" });
  }

  // ==========================================================================
  // Dedicated Image Studio in #view-studio (图片汉化在工作台进行)
  // ==========================================================================
  function openImageInStudio(task) {
    if (!task) return;
    state.images.currentTask = task;
    state.images.uploadedImageBase64 = null;
    state.images.uploadedImageObj = null;

    // Switch view to Studio
    switchView("studio");

    // Hide all text/lyrics layouts, show image layout
    document.getElementById("studio-lyrics-layout").style.display = "none";
    document.getElementById("studio-chat-layout").style.display = "none";
    document.getElementById("studio-story-layout").style.display = "none";
    document.getElementById("studio-standard-layout").style.display = "none";
    const imgLayout = document.getElementById("studio-image-layout");
    if (imgLayout) imgLayout.style.display = "block";

    // Update Top Context Nav
    const catBadge = document.getElementById("studio-category-badge");
    const idolBadge = document.getElementById("studio-idol-badge");
    const modePill = document.getElementById("studio-mode-pill");
    const indexDisp = document.getElementById("studio-index-display");

    if (catBadge) catBadge.textContent = task.category_name || "贴图";
    if (idolBadge) idolBadge.style.display = "none";
    if (modePill) modePill.textContent = "🖼️ 图片汉化";

    if (allImageTasksCache) {
      const idx = allImageTasksCache.findIndex(t => t.task_id === task.task_id);
      if (indexDisp && idx !== -1) {
        indexDisp.textContent = `第 ${idx + 1} / ${allImageTasksCache.length} 张`;
      }
    }

    // Populate Studio Image Hero
    const titleEl = document.getElementById("studio-img-task-title");
    const metaEl = document.getElementById("studio-img-bundle-meta");
    if (titleEl) titleEl.textContent = task.description || task.task_id;
    if (metaEl) metaEl.textContent = `尺寸: ${task.width}×${task.height}`;

    // Status button
    const btnToggle = document.getElementById("btn-studio-img-toggle-status");
    if (btnToggle) {
      if (task.status === "not_needed") {
        btnToggle.textContent = "↩️ 恢复汉化";
        btnToggle.className = "btn-mini btn-toggle-not-needed is-restore";
      } else {
        btnToggle.textContent = "🚫 无需汉化";
        btnToggle.className = "btn-mini btn-toggle-not-needed";
      }
    }

    // Source Preview
    const srcUrl = `/api/images/asset?task_id=${encodeURIComponent(task.task_id)}&type=composite`;
    const srcImg = document.getElementById("studio-img-source-preview");
    const srcRes = document.getElementById("studio-img-source-res");
    const btnDownload = document.getElementById("btn-studio-download-source");

    if (srcImg) srcImg.src = srcUrl;
    if (srcRes) srcRes.textContent = `${task.width}×${task.height}`;
    if (btnDownload) {
      btnDownload.href = `/api/images/asset?task_id=${encodeURIComponent(task.task_id)}&type=composite&download=1`;
      btnDownload.download = `${task.task_id}-composite.png`;
    }

    // Reset upload and restore panels
    resetStudioImageState();
  }

  function resetStudioImageState() {
    state.images.uploadedImageBase64 = null;
    state.images.uploadedImageObj = null;

    const uploadPreview = document.getElementById("studio-img-upload-preview");
    const dropPrompt = document.getElementById("studio-dropzone-prompt");
    const btnClear = document.getElementById("btn-studio-clear-img");
    const uploadRes = document.getElementById("studio-img-upload-res");
    const aspectStatus = document.getElementById("studio-aspect-ratio-status");
    const btnSubmit = document.getElementById("btn-studio-submit-restore");
    const restorePlaceholder = document.getElementById("studio-restore-placeholder");
    const restoreCanvas = document.getElementById("studio-restore-canvas");
    const restoreStatus = document.getElementById("studio-img-restore-status");
    const fileInput = document.getElementById("studio-file-input-image");

    if (uploadPreview) { uploadPreview.style.display = "none"; uploadPreview.src = ""; }
    if (dropPrompt) dropPrompt.style.display = "flex";
    if (btnClear) btnClear.style.display = "none";
    if (fileInput) fileInput.value = "";
    if (uploadRes) uploadRes.textContent = "未选择";
    if (aspectStatus) { aspectStatus.style.display = "none"; aspectStatus.textContent = ""; }
    if (btnSubmit) { btnSubmit.disabled = true; btnSubmit.textContent = "🚀 确认提交"; }
    if (restorePlaceholder) restorePlaceholder.style.display = "flex";
    if (restoreCanvas) restoreCanvas.style.display = "none";
    if (restoreStatus) {
      restoreStatus.textContent = "等待上传";
      restoreStatus.className = "img-res-badge";
      restoreStatus.style.background = "";
      restoreStatus.style.color = "";
    }
  }

  // ==========================================================================
  // Image proposal studio (aspect-ratio gate + PR)
  // ==========================================================================
  //
  // Three upload paths exist in the Worker and only one of them is a proposal:
  //
  //   * `POST /api/images/submit` — decodes the image, measures its own header,
  //     gates on ratio and resolution, and opens a PR. This is what the studio
  //     calls.
  //   * `POST /api/images/restore` — the legacy R2 queue upload. It does not gate
  //     the pixels and does not open a PR, so the studio no longer calls it.
  //   * `POST /api/images/status` — the "not needed" marker. Retired with it: the
  //     portal no longer decides a task's status, and the button that used to
  //     call it is display-only (see onStudioImageStatusClick).
  //
  // The image is sent as the raw base64 of the original bytes: not a data URL,
  // not a re-encode, not a resize. What is reviewed is what was drawn.

  function handleStudioImageFile(file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showToast("❌ 请上传图片文件", 3000);
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      state.images.uploadedImageBase64 = dataUrl;

      const img = new Image();
      img.onload = () => {
        state.images.uploadedImageObj = img;
        const uploadPreview = document.getElementById("studio-img-upload-preview");
        const dropPrompt = document.getElementById("studio-dropzone-prompt");
        const btnClear = document.getElementById("btn-studio-clear-img");
        const uploadRes = document.getElementById("studio-img-upload-res");
        const aspectStatus = document.getElementById("studio-aspect-ratio-status");
        const btnSubmit = document.getElementById("btn-studio-submit-restore");

        if (uploadPreview) {
          uploadPreview.src = dataUrl;
          uploadPreview.style.display = "block";
        }
        if (dropPrompt) dropPrompt.style.display = "none";
        if (btnClear) btnClear.style.display = "inline-flex";
        if (uploadRes) uploadRes.textContent = `${img.width}×${img.height}`;

        const task = state.images.currentTask;
        if (task && aspectStatus && btnSubmit) {
          // The same gate the Worker applies (`checkAspectRatio`), at the same
          // tolerance. A hint looser than the server's only produces a button
          // that looks enabled and a submission that is refused.
          const verdict = checkImageRatio(
            { width: img.width, height: img.height },
            { width: task.width, height: task.height }
          );
          aspectStatus.style.display = "block";

          if (verdict.ok) {
            const upscaled = img.width > Number(task.width) || img.height > Number(task.height);
            aspectStatus.className = "aspect-ratio-status match";
            aspectStatus.innerHTML = upscaled
              ? `✅ 比例一致 (${img.width}×${img.height})，高清 ${img.width}×${img.height} → 由 CI 等比缩放`
              : `✅ 尺寸一致 (${img.width}×${img.height})`;
            btnSubmit.disabled = false;
            renderStudioRestoreCanvas(task, img);
          } else if (verdict.reason === "resolution_below_original") {
            aspectStatus.className = "aspect-ratio-status mismatch";
            aspectStatus.innerHTML = `⚠️ 分辨率低于原图（原图 ${task.width}×${task.height}）：不接受降采样`;
            btnSubmit.disabled = true;
          } else if (verdict.reason === "original_size_unknown") {
            aspectStatus.className = "aspect-ratio-status mismatch";
            aspectStatus.innerHTML = "⚠️ 该任务未记录原始尺寸，门户无法校验比例，已禁用提交";
            btnSubmit.disabled = true;
          } else {
            aspectStatus.className = "aspect-ratio-status mismatch";
            aspectStatus.innerHTML = `⚠️ 比例不符：原图 ${task.width}×${task.height}，等比放大可以，拉伸不行`;
            btnSubmit.disabled = true;
          }
        }
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }

  function renderStudioRestoreCanvas(task, uploadedImg) {
    const canvas = document.getElementById("studio-restore-canvas");
    const placeholder = document.getElementById("studio-restore-placeholder");
    const restoreStatus = document.getElementById("studio-img-restore-status");
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, 512, 512);

    ctx.fillStyle = "#1e293b";
    ctx.fillRect(0, 0, 512, 512);

    // 绘制棋盘格底纹
    ctx.fillStyle = "#334155";
    for (let r = 0; r < 512; r += 16) {
      for (let c = 0; c < 512; c += 16) {
        if ((r / 16 + c / 16) % 2 === 0) {
          ctx.fillRect(c, r, 16, 16);
        }
      }
    }

    const scale = Math.min(512 / uploadedImg.width, 512 / uploadedImg.height, 1);
    const w = uploadedImg.width * scale;
    const h = uploadedImg.height * scale;
    const x = (512 - w) / 2;
    const y = (512 - h) / 2;
    ctx.drawImage(uploadedImg, x, y, w, h);

    if (placeholder) placeholder.style.display = "none";
    canvas.style.display = "block";
    if (restoreStatus) {
      // 这是浏览器里的等比预览，不是门户的产物：真正的缩放与 Unity3D 回填在 CI。
      restoreStatus.textContent = `等比预览 (${uploadedImg.width}×${uploadedImg.height})`;
      restoreStatus.className = "img-res-badge";
      restoreStatus.style.background = "#dcfce7";
      restoreStatus.style.color = "#15803d";
    }
  }

  /// Submit the uploaded image as a proposal PR. The version axis comes from the
  /// task's own record; the portal never guesses an asset version, and a task
  /// with no recorded original size is refused rather than uploaded unverified.
  async function submitStudioRestore() {
    const task = state.images.currentTask;
    const dataUrl = state.images.uploadedImageBase64;
    const img = state.images.uploadedImageObj;
    if (!task || !dataUrl) return;

    const btnSubmit = document.getElementById("btn-studio-submit-restore");
    const prLink = document.getElementById("studio-image-pr-link");

    if (!state.githubIdentity) {
      showToast("请先在页面右上角关联 GitHub 账号，图片提案会以 fork + PR 提交", 5000);
      return;
    }
    if (!state.csrfToken) {
      showToast("缺少请求令牌（CSRF），请刷新页面后重新登录 GitHub 账号", 5000);
      return;
    }

    // The task's own geometry. A task that never recorded its size fails closed
    // here for the same reason the Worker fails closed on it.
    const verdict = checkImageRatio(
      { width: img ? img.width : 0, height: img ? img.height : 0 },
      { width: task.width, height: task.height }
    );
    if (!verdict.ok) {
      showToast(`❌ ${describeSubmitError(verdict.reason)}`, 6000);
      return;
    }

    // The task's own original hash has to be in hand before anything is sent:
    // the service checks `source_sha256` against `image_task_units`, and the
    // uploaded bytes are the *translation* — a form that filled this in from the
    // upload would record the translated artifact as its own source. A task
    // without a recorded hash is refused here with the same code the service
    // would answer.
    if (!String(task.source_sha256 || "").trim()) {
      showToast(`❌ ${describeSubmitError("image_source_sha256_missing")}`, 6000);
      return;
    }

    // Raw base64, no `data:` prefix: the Worker's own decoder rejects a payload
    // that is not the image's own bytes. The version axis comes from the task's
    // record; the shape is the one the Worker's `/api/images/submit` expects.
    const imageProposal = buildImageProposal(task, dataUrlToBase64(dataUrl));
    if (!imageProposal.ok) {
      showToast(`❌ ${describeSubmitError(imageProposal.reason)}`, 6000);
      return;
    }

    if (btnSubmit) {
      btnSubmit.disabled = true;
      btnSubmit.textContent = "⏳ 提交 PR 中...";
    }

    try {
      const res = await fetch("/api/images/submit", {
        method: "POST",
        credentials: "same-origin",
        headers: githubPrHeaders(),
        body: JSON.stringify(imageProposal.payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(describeSubmitError(data.error));

      task.status = "proposed";
      task.pr_url = data.pr_url || null;
      renderPrLink(prLink, data);
      if (data.scaling === "ci") {
        showToast("🎉 已创建 PR：比例已通过，缩放与回填由 CI 完成", 5000);
      } else {
        showToast("🎉 已创建 PR，请在 GitHub 上查看", 4500);
      }

      if (btnSubmit) {
        btnSubmit.disabled = true;
        btnSubmit.textContent = "✅ 已提交 PR";
      }
      renderImageTasks();
    } catch (err) {
      console.error("Studio image proposal failed:", err);
      showToast(`❌ 提交失败: ${err.message}`, 5000);
      if (btnSubmit) {
        btnSubmit.disabled = false;
        btnSubmit.textContent = "🚀 重试提交";
      }
    }
  }

  function navigateStudioImage(offset) {
    if (!allImageTasksCache || !state.images.currentTask) return;
    const idx = allImageTasksCache.findIndex(t => t.task_id === state.images.currentTask.task_id);
    if (idx === -1) return;
    let nextIdx = idx + offset;
    if (nextIdx < 0) nextIdx = allImageTasksCache.length - 1;
    if (nextIdx >= allImageTasksCache.length) nextIdx = 0;
    openImageInStudio(allImageTasksCache[nextIdx]);
  }

  /// What the studio's status button does now.
  ///
  /// The portal used to write a maintenance decision here: "this art has no
  /// Japanese text, stop asking for a translation" was a POST to
  /// `/api/images/status`, which wrote the `image_status_overrides` row. That
  /// write path is retired — the maintainer dashboard is read-only and unknown
  /// decisions belong in the review, not in a button that bypasses GitHub — so
  /// the button no longer calls anything. The live status is still *shown*: it
  /// arrives with the task and is rendered above.
  ///
  /// Kept as a named function so the retired write cannot creep back in as an
  /// inline handler, and so `test_frontend_github.mjs` can assert that clicking
  /// the button produces no request at all.
  function onStudioImageStatusClick() {
    showToast("状态由维护者处理：门户不再直接改写图片状态", 4000);
  }

  // Utilities
  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Event Listeners Setup
  function setupEventListeners() {
    // Navigation
    document.getElementById("btn-home")?.addEventListener("click", () => switchView("lobby"));
    document.getElementById("nav-lobby")?.addEventListener("click", () => switchView("lobby"));
    document.getElementById("nav-studio")?.addEventListener("click", () => {
      if (state.studioQueue.length > 0) switchView("studio");
      else startStudioWithFilter({ status: "untranslated" });
    });
    document.getElementById("nav-selector")?.addEventListener("click", () => switchView("selector"));
    document.getElementById("btn-releases-back")?.addEventListener("click", () => switchView("lobby"));
    document.getElementById("nav-reviewer")?.addEventListener("click", () => switchView("reviewer"));

    document.querySelectorAll("#releases-nav-tabs .domain-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        document.querySelectorAll("#releases-nav-tabs .domain-tab").forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        const relTab = tab.getAttribute("data-rel-tab");
        const colClient = document.getElementById("col-client-releases");
        const colAssets = document.getElementById("col-assets-releases");
        if (relTab === "client") {
          if (colClient) colClient.style.display = "flex";
          if (colAssets) colAssets.style.display = "none";
        } else if (relTab === "assets") {
          if (colClient) colClient.style.display = "none";
          if (colAssets) colAssets.style.display = "flex";
        } else {
          if (colClient) colClient.style.display = "flex";
          if (colAssets) colAssets.style.display = "flex";
        }
      });
    });

    document.getElementById("btn-studio-back")?.addEventListener("click", () => switchView("lobby"));
    document.getElementById("btn-lyrics-back-catalog")?.addEventListener("click", () => {
      switchView("lobby");
      const lyricsTab = document.querySelector('.domain-tab[data-domain="lyrics"]');
      if (lyricsTab) lyricsTab.click();
    });

    document.getElementById("btn-reviewer-back")?.addEventListener("click", () => switchView("lobby"));
    document.getElementById("btn-refresh-queue")?.addEventListener("click", loadAdminProposals);

    // Image Localization Event Listeners
    document.querySelectorAll("#img-category-tabs .domain-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        document.querySelectorAll("#img-category-tabs .domain-tab").forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        state.images.category = tab.getAttribute("data-img-category") || "all";
        state.images.page = 1;
        renderImageTasks();
      });
    });

    document.getElementById("filter-img-status")?.addEventListener("change", (e) => {
      state.images.status = e.target.value;
      state.images.page = 1;
      renderImageTasks();
    });

    const imgSearchInput = document.getElementById("search-img-keyword");
    if (imgSearchInput) {
      let debounceTimer = null;
      imgSearchInput.addEventListener("input", (e) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          state.images.search = e.target.value.trim();
          state.images.page = 1;
          renderImageTasks();
        }, 200);
      });
    }

    // ========================================================================
    // Studio Dedicated Layout E (Image Workbench) Events
    // ========================================================================
    // The studio's status button is display-only now: clicking it explains that
    // the decision moved to the maintainer, and sends nothing.
    document.getElementById("btn-studio-img-toggle-status")?.addEventListener("click", onStudioImageStatusClick);

    document.getElementById("btn-studio-img-prev")?.addEventListener("click", () => navigateStudioImage(-1));
    document.getElementById("btn-studio-img-next")?.addEventListener("click", () => navigateStudioImage(1));
    document.getElementById("btn-studio-img-back-lobby")?.addEventListener("click", () => switchView("lobby"));

    // File input & Dropzone for Studio Image Layout
    const studioFileInput = document.getElementById("studio-file-input-image");
    const studioDropzone = document.getElementById("studio-img-upload-dropzone");
    const btnStudioTriggerFile = document.getElementById("btn-studio-trigger-file");
    const btnStudioClearImg = document.getElementById("btn-studio-clear-img");

    btnStudioTriggerFile?.addEventListener("click", () => studioFileInput?.click());
    studioFileInput?.addEventListener("change", (e) => {
      if (e.target.files && e.target.files[0]) {
        handleStudioImageFile(e.target.files[0]);
      }
    });

    if (studioDropzone) {
      studioDropzone.addEventListener("click", () => {
        if (!state.images.uploadedImageBase64) studioFileInput?.click();
      });
      studioDropzone.addEventListener("dragover", (e) => {
        e.preventDefault();
        studioDropzone.classList.add("dragover");
      });
      studioDropzone.addEventListener("dragleave", () => {
        studioDropzone.classList.remove("dragover");
      });
      studioDropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        studioDropzone.classList.remove("dragover");
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
          handleStudioImageFile(e.dataTransfer.files[0]);
        }
      });
    }

    btnStudioClearImg?.addEventListener("click", () => resetStudioImageState());
    document.getElementById("btn-studio-submit-restore")?.addEventListener("click", submitStudioRestore);

    // Tutorial Modal Triggers
    document.getElementById("btn-open-tutorial")?.addEventListener("click", () => toggleTutorialModal(true));
    document.getElementById("btn-studio-tutorial")?.addEventListener("click", () => toggleTutorialModal(true));
    document.getElementById("btn-guide-more")?.addEventListener("click", () => toggleTutorialModal(true));
    document.getElementById("btn-close-tutorial")?.addEventListener("click", () => toggleTutorialModal(false));

    // Studio Workbench Action Tools
    document.getElementById("btn-copy-source")?.addEventListener("click", copySourceToTranslation);
    document.getElementById("btn-extract-skeleton")?.addEventListener("click", extractSkeleton);
    document.getElementById("btn-fix-delims")?.addEventListener("click", fixDelimitersInInput);

    // Dedicated Lyrics Line Filter Pills
    document.querySelectorAll(".lyrics-dedicated-actions .filter-pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".lyrics-dedicated-actions .filter-pill").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        state.activeLyricLineFilter = btn.getAttribute("data-lyric-filter") || "all";
        renderLyricsLinesList();
      });
    });

    // Domain Tabs Click Handling
    document.querySelectorAll(".domain-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        activateLobbyDomain(tab.getAttribute("data-domain") || "all");
      });
    });

    // Top Header nav-images button: seamlessly switches to Lobby and activates the images section
    document.getElementById("nav-images")?.addEventListener("click", () => {
      switchView("lobby");
      const imgTab = document.querySelector(`.domain-tab[data-domain="images"]`);
      if (imgTab) imgTab.click();
    });

    // Song Type Tabs Click Handling
    document.querySelectorAll("#song-type-tabs .type-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll("#song-type-tabs .type-tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        state.activeSongType = tab.getAttribute("data-song-type");
        renderSongsGrid();
      });
    });

    // Song search input (Instant client-side filter, 0 network requests)
    const songSearchInput = document.getElementById("search-song-keyword");
    if (songSearchInput) {
      songSearchInput.addEventListener("input", (e) => {
        state.songFilterKeyword = e.target.value;
        renderSongsGrid();
      });
    }

    // Search & Random Buttons (Top-placed in Lobby)
    document.getElementById("btn-do-search")?.addEventListener("click", () => {
      const kw = document.getElementById("search-keyword").value.trim();
      const status = document.getElementById("search-status").value;
      startStudioWithFilter({ keyword: kw, status: status, category: null, idol: null });
    });

    document.getElementById("search-keyword")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        document.getElementById("btn-do-search")?.click();
      }
    });

    document.getElementById("btn-random-task")?.addEventListener("click", () => {
      const categories = ["assets", "client"].flatMap((channel) =>
        (state.resourceManifests[channel]?.categories || [])
          .filter((category) => category.entry === "studio" && Number(category.total || 0) > 0)
          .map((category) => ({ ...category, channel }))
      );
      const random = categories[Math.floor(Math.random() * categories.length)];
      if (!random) return startStudioWithFilter({ status: "untranslated", keyword: "", category: null, idol: null }, false);
      state.activeResource = random.channel;
      startStudioWithFilter({ status: "untranslated", keyword: "", category: random.id, idol: null }, false);
    });

    // Studio Status Tabs Capsule Click Handling
    document.querySelectorAll("#studio-status-tabs .tab-capsule, .status-toggle-btn").forEach((capsule) => {
      capsule.addEventListener("click", () => {
        document.querySelectorAll("#studio-status-tabs .tab-capsule, .status-toggle-btn").forEach(c => c.classList.remove("active"));
        capsule.classList.add("active");
        const st = capsule.getAttribute("data-status-filter") || capsule.getAttribute("data-status") || "";
        const targetStatus = st === "all" ? "" : st;
        startStudioWithFilter({ status: targetStatus }, false);
      });
    });

    // AI Workbench Tools
    document.getElementById("btn-ai-translate")?.addEventListener("click", requestAiTranslation);
    document.getElementById("btn-ai-config")?.addEventListener("click", () => toggleAiConfigModal(true));
    document.getElementById("btn-ai-quick-polish")?.addEventListener("click", requestAiPolish);

    // Existing Translation Card Actions
    document.getElementById("btn-use-existing")?.addEventListener("click", () => {
      const curTrans = state.currentItem?.translation || state.currentItem?.current_translation || "";
      if (!curTrans) return;
      const textarea = document.getElementById("translation-input");
      textarea.value = curTrans;
      validateTranslationInput(curTrans);
      textarea.focus();
      showToast("已载入已有译文，可继续修改");
    });
    document.getElementById("btn-ai-polish")?.addEventListener("click", requestAiPolish);

    // AI Config Modal Actions
    document.getElementById("btn-close-ai-modal")?.addEventListener("click", () => toggleAiConfigModal(false));
    document.getElementById("btn-close-ai-config")?.addEventListener("click", () => toggleAiConfigModal(false));
    document.getElementById("btn-toggle-key-vis")?.addEventListener("click", () => {
      const keyInput = document.getElementById("ai-api-key");
      const btn = document.getElementById("btn-toggle-key-vis");
      if (keyInput) {
        if (keyInput.type === "password") {
          keyInput.type = "text";
          if (btn) btn.textContent = "🙈";
        } else {
          keyInput.type = "password";
          if (btn) btn.textContent = "👁️";
        }
      }
    });

    const tempSlider = document.getElementById("ai-temperature");
    const tempDisp = document.getElementById("ai-temp-val");
    if (tempSlider && tempDisp) {
      tempSlider.addEventListener("input", (e) => {
        tempDisp.textContent = parseFloat(e.target.value).toFixed(2);
      });
    }

    const applyPreset = (presetKey) => {
      const p = AI_PRESETS[presetKey];
      if (!p) return;
      const ep = document.getElementById("ai-endpoint");
      const model = document.getElementById("ai-model");
      const temp = document.getElementById("ai-temperature");
      const tempVal = document.getElementById("ai-temp-val");
      if (ep) ep.value = p.endpoint;
      if (model) model.value = p.model;
      if (temp) temp.value = p.temperature;
      if (tempVal) tempVal.textContent = parseFloat(p.temperature).toFixed(2);
      showToast(`已应用 ${presetKey} 预设模板`);
    };

    document.querySelectorAll(".preset-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const p = btn.getAttribute("data-preset");
        if (p && AI_PRESETS[p]) applyPreset(p);
      });
    });

    document.getElementById("btn-test-ai")?.addEventListener("click", testAiConnection);

    const handleSaveAi = () => {
      const ep = (document.getElementById("ai-endpoint")?.value || "").trim();
      const key = (document.getElementById("ai-api-key")?.value || "").trim();
      const model = (document.getElementById("ai-model")?.value || "").trim();
      const temp = parseFloat(document.getElementById("ai-temperature")?.value || "0.3") || 0.3;

      if (!ep) {
        showToast("请填写接口地址");
        return;
      }

      saveAiConfig({ endpoint: ep, apiKey: key, model: model, temperature: temp });
      showToast("✅ 配置已保存到本机浏览器");
      toggleAiConfigModal(false);
    };

    document.getElementById("btn-save-ai")?.addEventListener("click", handleSaveAi);
    document.getElementById("btn-save-ai-config")?.addEventListener("click", handleSaveAi);

    document.getElementById("btn-clear-ai")?.addEventListener("click", () => {
      try { localStorage.removeItem(AI_CONFIG_KEY); } catch (_) {}
      const ep = document.getElementById("ai-endpoint");
      const key = document.getElementById("ai-api-key");
      const model = document.getElementById("ai-model");
      const temp = document.getElementById("ai-temperature");
      const tempVal = document.getElementById("ai-temp-val");
      if (ep) ep.value = "";
      if (key) key.value = "";
      if (model) model.value = "";
      if (temp) temp.value = 0.3;
      if (tempVal) tempVal.textContent = "0.30";
      showToast("已清空本地 AI 配置");
    });

    document.getElementById("btn-ai-translate-tool")?.addEventListener("click", requestAiTranslation);

    // Textarea input validation & shortcuts
    const textarea = document.getElementById("translation-input");
    if (textarea) {
      textarea.addEventListener("input", (e) => {
        validateTranslationInput(e.target.value);
      });

      textarea.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
          e.preventDefault();
          requestAiTranslation();
        } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          submitCurrentTranslation();
        } else if (e.altKey && (e.key === "s" || e.key === "S")) {
          e.preventDefault();
          state.studioIndex++;
          saveStudioSession();
          renderCurrentStudioItem();
        }
      });
    }

    // Repository → version → resource selector
    document.getElementById("btn-selector-back")?.addEventListener("click", () => switchView("lobby"));
    document.querySelectorAll("#selector-channel-tabs .domain-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        const channel = tab.getAttribute("data-selector-channel") || "assets";
        loadSelector(channel);
      });
    });
    document.getElementById("selector-release")?.addEventListener("change", () => {
      loadSelectorItems();
    });
    document.getElementById("selector-more")?.addEventListener("click", () => {
      loadMoreSelectorItems();
    });

    document.getElementById("btn-studio-submit")?.addEventListener("click", submitCurrentTranslation);
    document.getElementById("btn-studio-skip")?.addEventListener("click", () => {
      state.studioIndex++;
      saveStudioSession();
      renderCurrentStudioItem();
    });
  }

  window.addEventListener("portal:resource-manifests", (event) => {
    state.resourceManifests = event.detail || { assets: null, client: null };
    renderCategoriesGrid();
  });

  window.addEventListener("portal:resource-category", (event) => {
    const detail = event.detail || {};
    if (detail.channel) state.activeResource = detail.channel;
    if (detail.entry === "studio" && detail.category) {
      startStudioWithFilter({ category: detail.category, idol: null, status: "untranslated" });
    }
  });

  // Resource hub buttons use an explicit event instead of clicking a stale
  // historical header tab. This keeps the entry point stable when the lobby
  // taxonomy is rebuilt from a manifest.
  window.addEventListener("portal:open-domain", (event) => {
    activateLobbyDomain(event.detail?.domain || "all");
  });

  // ==========================================================================
  // Repository → version → resource selector
  // ==========================================================================
  //
  // The two channels are independent release axes, and the portal now walks each
  // one the way the service exposes it: list the channel's releases, page
  // through that release's rows, then ask for the row's edit context. The
  // context is the only thing that carries a trustworthy binding — `target` (the
  // *channel*), `path`, `base_commit` and `source_sha256` — so nothing here
  // assembles a path, a commit or a resource id of its own.
  //
  // Paging is the service's, not this page's. A release can hold hundreds of
  // thousands of rows, so the list follows `next_cursor` one page at a time
  // behind an explicit button: it never walks the whole catalogue, and it never
  // assumes a `limit` larger than the server will honour.
  //
  // A row's list entry does not carry `resource_id`; the per-row detail route
  // does, along with the `edit_endpoint` the context lives at. That is one extra
  // read per selection and it is deliberate: the alternative is guessing an id.

  const SELECTOR_CHANNELS = [
    {
      id: "assets",
      label: "Assets 资源",
      releases: "/api/assets/releases",
      versionField: "asset_version",
      pinField: "assets_commit",
      note: "服务器下发通道（locales / lyrics / manifests）",
    },
    {
      id: "client",
      label: "Client 客户端",
      releases: "/api/client/releases",
      versionField: "client_version",
      pinField: "client_resources_commit",
      note: "APK 内置通道（manifests 的 slots 逐槽编辑）",
    },
  ];

  /// The page size this list asks for. The service clamps to its own maximum
  /// (100); asking for more would be ask-and-ignore, so the number here is the
  /// one the service actually serves.
  const SELECTOR_PAGE_SIZE = 100;

  /// Bumped on every list load. A response that comes back after the user has
  /// switched channel or release is stale and is dropped: appending page 2 of
  /// release A into release B's list is how a binding for the wrong revision
  /// gets shown.
  let selectorRequestSeq = 0;

  function selectorChannel(id) {
    return SELECTOR_CHANNELS.find((entry) => entry.id === id) || null;
  }

  /// The reference a channel's item routes accept. The list answers with the
  /// release *id*, which is always acceptable; a bare version works too, and the
  /// service resolves it. Passing the id back is what keeps a version rename from
  /// silently retargeting the page.
  ///
  /// `undefined`/`null` checks rather than `||`: a release id that is an empty
  /// string is a fact about the row, not a reason to fall through to another
  /// field.
  function selectorReleaseRef(channel, release) {
    if (!release || !channel) return "";
    const primary = release.release_id;
    if (primary !== undefined && primary !== null && String(primary) !== "") return String(primary);
    const version = release[channel.versionField];
    return version === undefined || version === null ? "" : String(version);
  }

  /// One slot of an item list, rendered as a button the user clicks.
  ///
  /// The keys are read with explicit null checks, never with `||`. A client
  /// manifest slot's identity is its `index`, and slot **0** is a perfectly
  /// ordinary slot whose index is falsy — `slot.index || ""` would turn it into
  /// an empty key, and the row would then be addressed by nothing.
  function selectorItemKey(item) {
    const raw = item && item.item_key;
    return raw === undefined || raw === null ? "" : String(raw);
  }

  function selectorItemsUrl(channel, ref, cursor = "", limit = SELECTOR_PAGE_SIZE) {
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    if (cursor) params.set("cursor", cursor);
    return `/api/${channel.id}/releases/${encodeURIComponent(ref)}/items?${params.toString()}`;
  }

  function selectorItemUrl(channel, ref, item) {
    return `/api/${channel.id}/releases/${encodeURIComponent(ref)}/item`
      + `?bundle=${encodeURIComponent(String(item.bundle || ""))}`
      + `&item_key=${encodeURIComponent(selectorItemKey(item))}`;
  }

  /// The version a release row carries on its own axis. `asset_version` and
  /// `client_version` never mix, and this reads the one the channel declares.
  function selectorReleaseVersion(channel, release) {
    const field = channel.versionField;
    const value = release && release[field];
    return value === undefined || value === null ? "" : String(value);
  }

  async function loadSelectorReleases(channel) {
    const select = document.getElementById("selector-release");
    if (select) select.innerHTML = "<option value=\"\">加载中…</option>";
    const status = document.getElementById("selector-status");
    if (status) status.textContent = "";

    try {
      const res = await fetch(channel.releases, { headers: { accept: "application/json" } });
      if (!res.ok) {
        if (select) select.innerHTML = "<option value=\"\">无法加载版本</option>";
        if (status) status.textContent = `无法加载 ${channel.label} 的版本列表（${res.status}）`;
        return [];
      }
      const data = await res.json();
      const releases = Array.isArray(data.releases) ? data.releases : [];
      if (releases.length === 0) {
        if (select) select.innerHTML = "<option value=\"\">暂无发布</option>";
        if (status) status.textContent = `${channel.label} 暂无已登记的发布版本`;
        return [];
      }
      // The portal is a latest-version workbench. Historical rows remain in
      // the service for audit/release tooling, but the contributor UI binds to
      // one latest usable release per independent axis and cannot switch back.
      const latest = channel.id === "assets"
        // Assets is an independent numeric release axis. The D1 canonical row
        // can lag the GitHub manifest, so status must never outrank the latest
        // version shown on the public homepage. Candidate rows without a
        // pinned commit are not usable workbench releases, however.
        ? (releases.filter((release) => /^[0-9a-f]{40}$/i.test(String(release.assets_commit || "")) || release.source === "github")
          .slice().sort((a, b) => Number(b.asset_version || 0) - Number(a.asset_version || 0))[0]
          || releases.slice().sort((a, b) => Number(b.asset_version || 0) - Number(a.asset_version || 0))[0])
        : releases.slice().sort((a, b) => {
          const rank = (release) => release.status === "published" ? 2 : release.status === "candidate" ? 1 : 0;
          return String(b.client_version || "").localeCompare(String(a.client_version || ""), undefined, { numeric: true })
            || rank(b) - rank(a);
        })[0];
      const historical = releases.filter((release) => release !== latest);
      if (select) {
        select.innerHTML = [latest, ...historical].map((release, index) => {
          const version = selectorReleaseVersion(channel, release);
          const pin = String(release[channel.pinField] || "");
          const pinNote = pin ? ` · ${pin.slice(0, 7)}` : " · 未固定 commit";
          const statusNote = release.status ? ` · ${release.status}` : "";
          const archived = index > 0 ? " hidden disabled" : "";
          return `<option value="${escapeHtml(selectorReleaseRef(channel, release))}"${archived}>${escapeHtml(version)}${escapeHtml(statusNote)}${escapeHtml(pinNote)}</option>`;
        }).join("");
        select.value = selectorReleaseRef(channel, latest);
        select.disabled = true;
      }
      if (status) status.textContent = `${channel.label} · 仅处理最新可用版本`;
      return releases;
    } catch (err) {
      if (status) status.textContent = `加载失败: ${err.message}`;
      return [];
    }
  }

  /// Load the selected release's first page.
  ///
  /// Switching the version clears everything the previous release put on screen,
  /// including the cursor: a row from one release must never be left standing
  /// under another release's selector, because submitting it would then name a
  /// binding for the wrong revision.
  async function loadSelectorItems() {
    const channel = selectorChannel(state.selector.channel);
    state.selector.items = [];
    state.selector.selected = null;
    state.selector.next_cursor = null;
    state.selector.has_more = false;
    renderSelectorSelection(null);
    if (!channel) return;

    const select = document.getElementById("selector-release");
    const ref = select ? select.value : "";
    state.selector.ref = ref;
    state.selector.release_id = ref;
    if (!ref) {
      renderSelectorItems([]);
      return;
    }
    await fetchSelectorPage(channel, ref, "", { replace: true });
  }

  /// Fetch one page and either replace the list or append to it.
  async function fetchSelectorPage(channel, ref, cursor, { replace }) {
    const list = document.getElementById("selector-items");
    const more = document.getElementById("selector-more");
    const status = document.getElementById("selector-status");
    if (!list) return;

    const seq = ++selectorRequestSeq;
    if (replace) list.innerHTML = "<p style='color:var(--text-muted)'>正在加载资源条目…</p>";
    else if (more) { more.disabled = true; more.textContent = "加载中…"; }
    if (status && replace) status.textContent = "";

    let data;
    try {
      const res = await fetch(selectorItemsUrl(channel, ref, cursor));
      if (seq !== selectorRequestSeq) return; // a newer load started; drop this page
      if (!res.ok) {
        if (replace) list.innerHTML = `<p style='color:var(--danger)'>无法加载条目（${res.status}）</p>`;
        if (more) { more.disabled = false; more.textContent = "加载更多"; }
        return;
      }
      data = await res.json();
    } catch (err) {
      if (seq !== selectorRequestSeq) return;
      if (replace) list.innerHTML = `<p style='color:var(--danger)'>加载失败: ${escapeHtml(err.message)}</p>`;
      if (more) { more.disabled = false; more.textContent = "加载更多"; }
      return;
    }
    if (seq !== selectorRequestSeq) return;

    const items = Array.isArray(data.items) ? data.items : [];
    // The answer names the release id the rows are keyed by; a selector must
    // send *that* back, so the page adopts it even when it asked by version.
    if (data.release_id) state.selector.release_id = String(data.release_id);
    state.selector.items = replace ? items : state.selector.items.concat(items);
    // The cursor is the service's. `has_more` without one would leave the button
    // spinning on a page that can never arrive, so both are read together.
    state.selector.next_cursor = data.next_cursor === undefined || data.next_cursor === null ? null : String(data.next_cursor);
    state.selector.has_more = Boolean(data.has_more) && Boolean(state.selector.next_cursor);

    renderSelectorItems(state.selector.items);
    renderSelectorMore();

    if (status) {
      const total = state.selector.items.length;
      status.textContent = `${channel.label} · 已载入 ${total} 条${state.selector.has_more ? "（还有更多）" : ""}`;
    }
    if (state.selector.items.length === 0) {
      // An empty page is an answer, and it is shown as one: "loading" left on
      // screen would be a lie about a request that already came back.
      list.innerHTML = "<p style='color:var(--text-muted)'>该版本在此通道下没有条目</p>";
    }
  }

  function renderSelectorMore() {
    const more = document.getElementById("selector-more");
    if (!more) return;
    if (!state.selector.has_more) {
      more.disabled = true;
      more.textContent = "已到底部";
      return;
    }
    more.disabled = false;
    more.textContent = `加载更多（已载入 ${state.selector.items.length} 条）`;
  }

  async function loadMoreSelectorItems() {
    const channel = selectorChannel(state.selector.channel);
    const cursor = state.selector.next_cursor;
    if (!channel || !cursor) return;
    await fetchSelectorPage(channel, state.selector.release_id || state.selector.ref, cursor, { replace: false });
  }

  function renderSelectorItems(items) {
    const list = document.getElementById("selector-items");
    if (!list) return;
    if (!items || items.length === 0) {
      list.replaceChildren(...[]);
      return;
    }
    const rows = items.map((item) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "selector-item";
      const key = selectorItemKey(item);
      const status = String(item.status || "untranslated");
      const translated = item.translation ? "已有译文" : "未翻译";
      row.innerHTML =
        `<span class="selector-item-key">${escapeHtml(String(item.bundle || ""))} · ${escapeHtml(key)}</span>` +
        `<span class="selector-item-meta">${escapeHtml(status)} · ${escapeHtml(translated)}</span>`;
      row.addEventListener("click", () => { selectSelectorItem(item, row); });
      return row;
    });
    list.replaceChildren(...rows);
  }

  function renderSelectorSelection(context) {
    const panel = document.getElementById("selector-selection");
    if (!panel) return;
    if (!context) {
      panel.innerHTML = "<p style='color:var(--text-muted)'>选择左侧条目以读取它的提交绑定</p>";
      return;
    }
    if (!context.editable) {
      panel.innerHTML = `<p style='color:var(--danger)'>该条不可编辑：${escapeHtml(String(context.reason || "未知原因"))}` +
        (context.detail ? `<br><small>${escapeHtml(String(context.detail))}</small>` : "") + "</p>";
      return;
    }
    const version = context.github.target === "client"
      ? `client_version ${escapeHtml(String(context.client_version || "-"))}`
      : `asset_version ${escapeHtml(String(context.asset_version || "-"))}`;
    panel.innerHTML = `
      <div class="selector-context">
        <div class="selector-context-row"><span>目标仓库</span><strong>${escapeHtml(String(context.github.target))}</strong></div>
        <div class="selector-context-row"><span>文件路径</span><code>${escapeHtml(String(context.github.path))}</code></div>
        <div class="selector-context-row"><span>基线提交</span><code title="${escapeHtml(String(context.github.base_commit))}">${escapeHtml(String(context.github.base_commit).slice(0, 12))}</code></div>
        <div class="selector-context-row"><span>行形态</span><strong>${escapeHtml(String(context.row_kind || "-"))}</strong></div>
        <div class="selector-context-row"><span>版本轴</span><strong>${version}</strong></div>
      </div>
      <button type="button" class="btn-primary" id="btn-selector-open">在工作台中编辑这一条</button>
    `;
    document.getElementById("btn-selector-open")?.addEventListener("click", () => { openSelectorContextInStudio(state.selector.selected); });
  }

  /// Resolve the trusted context for one row.
  ///
  /// Two reads, both from the service: the row's own detail (which carries
  /// `resource_id` and `edit_endpoint`) and then the context itself. Nothing is
  /// derived locally — not the id, not the path, not the commit.
  async function selectSelectorItem(item, rowElement) {
    const channel = selectorChannel(state.selector.channel);
    const panel = document.getElementById("selector-selection");
    if (!channel || !panel) return;
    const ref = state.selector.release_id || state.selector.ref;
    if (!ref) return;

    document.querySelectorAll(".selector-item").forEach((el) => el.classList.remove("active"));
    if (rowElement) rowElement.classList.add("active");
    state.selector.selected = null;
    panel.innerHTML = "<p style='color:var(--text-muted)'>正在读取条目详情…</p>";

    try {
      const detailRes = await fetch(selectorItemUrl(channel, ref, item));
      if (!detailRes.ok) {
        panel.innerHTML = `<p style='color:var(--danger)'>读取条目失败（${detailRes.status}）</p>`;
        return;
      }
      const detail = await detailRes.json();
      const row = detail.item || {};
      const endpoint = String(row.edit_endpoint || "");
      if (!endpoint) {
        // The service decides where a row can be edited. A row without an edit
        // endpoint is one this portal cannot propose against, and the honest
        // answer is to say so rather than to build one.
        panel.innerHTML = "<p style='color:var(--danger)'>该条目未提供编辑上下文入口（edit_endpoint 缺失），门户不会自造绑定</p>";
        return;
      }
      const contextRes = await fetch(endpoint, { headers: { accept: "application/json" } });
      if (!contextRes.ok) {
        panel.innerHTML = `<p style='color:var(--danger)'>读取编辑上下文失败（${contextRes.status}）</p>`;
        return;
      }
      const context = await contextRes.json();
      state.selector.selected = context;
      renderSelectorSelection(context);
    } catch (err) {
      panel.innerHTML = `<p style='color:var(--danger)'>加载失败: ${escapeHtml(err.message)}</p>`;
    }
  }

  /// Hand the trusted context to the existing studio editor.
  ///
  /// The editor is the same one the rest of the portal uses: the context becomes
  /// the current queue item, so the source, the existing translation and the
  /// validation panel all behave as they do for a catalogue row, and the submit
  /// path builds its body from this context — the path and the commit come from
  /// the service, never from here.
  function openSelectorContextInStudio(context) {
    if (!context || !context.editable) {
      showToast("该条目当前不可编辑", 4000);
      return;
    }
    const item = {
      bundle: context.bundle,
      item_key: context.item_key,
      logical_key: context.logical_key,
      source: context.source,
      translation: context.translation || null,
      status: "untranslated",
      category: context.category || null,
      github: context.github,
      row_kind: context.row_kind,
      asset_version: context.asset_version,
      client_version: context.client_version,
      resource_id: context.resource_id || null,
      origin: "selector",
    };
    state.currentSongMeta = null;
    state.studioQueue = [item];
    state.studioIndex = 0;
    state.currentItem = item;
    state.currentFilter = { category: null, idol: null, keyword: "", status: "" };
    try { sessionStorage.removeItem("mltd_studio_session"); } catch (_) {}
    switchView("studio");
    renderCurrentStudioItem();
    showToast(`已载入 ${context.bundle} · ${context.item_key}（${context.github.target}）`, 3500);
  }

  async function loadSelector(channelId) {
    const channel = selectorChannel(channelId) || SELECTOR_CHANNELS[0];
    state.selector.channel = channel.id;
    state.selector.ref = "";
    state.selector.release_id = "";
    state.selector.next_cursor = null;
    state.selector.has_more = false;
    state.selector.items = [];
    state.selector.selected = null;
    // Any page still in flight belongs to the previous selection.
    selectorRequestSeq += 1;
    document.querySelectorAll("#selector-channel-tabs .domain-tab").forEach((tab) => {
      tab.classList.toggle("active", tab.getAttribute("data-selector-channel") === channel.id);
    });
    const note = document.getElementById("selector-channel-note");
    if (note) note.textContent = channel.note;
    renderSelectorItems([]);
    renderSelectorSelection(null);
    await loadSelectorReleases(channel);
    await loadSelectorItems();
  }
  // Load and Render Independent Releases
  // Load and Render Independent Releases
  async function loadReleases() {
    try {
      const [clientRes, assetsRes] = await Promise.all([
        fetch("/api/client/releases").catch(() => null),
        fetch("/api/assets/releases").catch(() => null),
      ]);

      let clientData = clientRes && clientRes.ok ? await clientRes.json() : { releases: [] };
      let assetsData = assetsRes && assetsRes.ok ? await assetsRes.json() : { releases: [] };

      // Update sidebar Client card
      if (clientData.releases && clientData.releases.length > 0) {
        const topClient = clientData.releases[0];
        const elVer = document.getElementById("sidebar-client-version");
        const elAbi = document.getElementById("sidebar-client-abi");
        const elStatus = document.getElementById("sidebar-client-status");
        const elBase = document.getElementById("sidebar-client-base-sha");
        const elCommit = document.getElementById("sidebar-client-commit");
        const elOutput = document.getElementById("sidebar-client-output-sha");

        if (elVer) elVer.textContent = topClient.client_version;
        if (elAbi) elAbi.textContent = topClient.abi;
        if (elStatus) {
          elStatus.textContent = topClient.status;
          elStatus.className = `sidebar-badge ${topClient.status === "published" ? "canonical-badge" : "candidate-badge"}`;
        }
        if (elBase && topClient.base_apk_sha256) {
          elBase.textContent = topClient.base_apk_sha256.slice(0, 8) + "...";
          elBase.title = topClient.base_apk_sha256;
        }
        if (elCommit && topClient.client_resources_commit) {
          elCommit.textContent = topClient.client_resources_commit.slice(0, 7);
          elCommit.title = topClient.client_resources_commit;
        }
        if (elOutput) {
          if (topClient.output_apk_sha256) {
            elOutput.innerHTML = `<code class="hash-short" title="${escapeHtml(topClient.output_apk_sha256)}">${escapeHtml(topClient.output_apk_sha256.slice(0, 8))}...</code>`;
          } else {
            elOutput.textContent = "待 Private Build";
          }
        }
      }

      // Update sidebar Assets card & reuse
      if (assetsData.releases && assetsData.releases.length > 0) {
        const canonicalAsset = assetsData.releases.find(r => r.status === "canonical") || assetsData.releases[0];
        const elVer = document.getElementById("sidebar-assets-version");
        const elStatus = document.getElementById("sidebar-assets-status");
        const elSchema = document.getElementById("sidebar-assets-schema");
        const elManifest = document.getElementById("sidebar-assets-manifest-sha");
        const elCommit = document.getElementById("sidebar-assets-commit");

        if (elVer) elVer.textContent = canonicalAsset.asset_version;
        if (elStatus) {
          elStatus.textContent = canonicalAsset.status;
          elStatus.className = `sidebar-badge ${canonicalAsset.status === "canonical" ? "canonical-badge" : "superseded-badge"}`;
        }
        if (elSchema) elSchema.textContent = `Schema ${canonicalAsset.server_schema_version || "v1"}`;
        if (elManifest && canonicalAsset.source_manifest_sha256) {
          elManifest.textContent = canonicalAsset.source_manifest_sha256.slice(0, 7) + "...";
          elManifest.title = canonicalAsset.source_manifest_sha256;
        }
        if (elCommit && canonicalAsset.assets_commit) {
          elCommit.textContent = canonicalAsset.assets_commit.slice(0, 7);
          elCommit.title = canonicalAsset.assets_commit;
        }

        // Fetch summary for canonical asset to get reuse counts
        fetch(`/api/assets/releases/${canonicalAsset.asset_version}/summary`)
          .then(r => r.ok ? r.json() : null)
          .then(summary => {
            if (summary) {
              const elExact = document.querySelector(".reuse-pill.exact strong");
              const elVerified = document.querySelector(".reuse-pill.verified strong");
              const elSuggested = document.querySelector(".reuse-pill.suggested strong");
              const elBlocked = document.querySelector(".reuse-pill.blocked strong");
              if (elExact) elExact.textContent = Number(summary.reused_items || 0).toLocaleString();
              if (elVerified) elVerified.textContent = "0";
              if (elSuggested) elSuggested.textContent = Number(summary.suggested_items || 0).toLocaleString();
              if (elBlocked) elBlocked.textContent = Number(summary.blocked_items || 0).toLocaleString();

              const mExact = document.getElementById("matrix-count-exact");
              const mVerified = document.getElementById("matrix-count-verified");
              const mSuggested = document.getElementById("matrix-count-suggested");
              const mBlocked = document.getElementById("matrix-count-blocked");
              if (mExact) mExact.textContent = `${Number(summary.reused_items || 0).toLocaleString()} 项`;
              if (mVerified) mVerified.textContent = "0 项";
              if (mSuggested) mSuggested.textContent = `${Number(summary.suggested_items || 0).toLocaleString()} 项`;
              if (mBlocked) mBlocked.textContent = `${Number(summary.blocked_items || 0).toLocaleString()} 项`;
            }
          })
          .catch(() => {});
      }

      renderReleasesView(clientData.releases || [], assetsData.releases || []);
    } catch (err) {
      console.warn("loadReleases failed:", err);
    }
  }

  function renderReleasesView(clientReleases, assetsReleases) {
    const clientList = document.getElementById("client-releases-list");
    const assetsList = document.getElementById("assets-releases-list");

    if (clientList) {
      if (clientReleases.length === 0) {
        clientList.innerHTML = `<div class="empty-state">暂无 Client 发布记录</div>`;
      } else {
        clientList.innerHTML = clientReleases.map(r => `
          <div class="release-item-card ${r.status}">
            <div class="release-item-header">
              <div class="release-title-group">
                <h4>${escapeHtml(r.client_version)}</h4>
                <span class="abi-tag">${escapeHtml(r.abi)}</span>
              </div>
              <span class="sidebar-badge ${r.status === "published" ? "canonical-badge" : "candidate-badge"}">${escapeHtml(r.status)}</span>
            </div>
            <div class="release-item-meta">
              <div class="meta-field-row">
                <span class="meta-field-label">Release ID:</span>
                <code>${escapeHtml(r.release_id)}</code>
              </div>
              <div class="meta-field-row">
                <span class="meta-field-label">Base APK:</span>
                <code class="hash-short" title="${escapeHtml(r.base_apk_sha256)}">${escapeHtml(r.base_apk_sha256.slice(0, 16))}...</code>
              </div>
              <div class="meta-field-row">
                <span class="meta-field-label">内置资源 Commit:</span>
                <code class="hash-short">${escapeHtml(r.client_resources_commit.slice(0, 10))}</code>
              </div>
              <div class="meta-field-row">
                <span class="meta-field-label">产物 APK SHA:</span>
                ${r.output_apk_sha256 ? `<code class="hash-short" title="${escapeHtml(r.output_apk_sha256)}">${escapeHtml(r.output_apk_sha256.slice(0, 16))}...</code>` : `<span class="rel-val-muted">未构建 (Private Build CI)</span>`}
              </div>
              <div class="meta-field-row">
                <span class="meta-field-label">创建时间:</span>
                <span>${escapeHtml(new Date(r.created_at).toLocaleString())}</span>
              </div>
            </div>
          </div>
        `).join("");
      }
    }

    if (assetsList) {
      if (assetsReleases.length === 0) {
        assetsList.innerHTML = `<div class="empty-state">暂无 Assets 发布记录</div>`;
      } else {
        assetsList.innerHTML = assetsReleases.map(r => `
          <div class="release-item-card ${r.status}">
            <div class="release-item-header">
              <div class="release-title-group">
                <h4>${escapeHtml(r.asset_version)}</h4>
                <span class="schema-tag">Schema ${escapeHtml(r.server_schema_version || "v1")}</span>
              </div>
              <span class="sidebar-badge ${r.status === "canonical" ? "canonical-badge" : r.status === "superseded" ? "superseded-badge" : "candidate-badge"}">${escapeHtml(r.status)}</span>
            </div>
            <div class="release-item-meta">
              <div class="meta-field-row">
                <span class="meta-field-label">Release ID:</span>
                <code>${escapeHtml(r.release_id || ("assets-" + r.asset_version))}</code>
              </div>
              ${r.source_manifest_sha256 ? `
              <div class="meta-field-row">
                <span class="meta-field-label">Manifest SHA:</span>
                <code class="hash-short" title="${escapeHtml(r.source_manifest_sha256)}">${escapeHtml(r.source_manifest_sha256.slice(0, 16))}...</code>
              </div>` : ""}
              ${r.assets_commit ? `
              <div class="meta-field-row">
                <span class="meta-field-label">Assets Commit:</span>
                <code class="hash-short">${escapeHtml(r.assets_commit.slice(0, 10))}</code>
              </div>` : ""}
              <div class="meta-field-row">
                <span class="meta-field-label">发布说明:</span>
                <span>${escapeHtml(r.note || "无特别说明")}</span>
              </div>
              <div class="meta-field-row">
                <span class="meta-field-label">更新时间:</span>
                <span>${escapeHtml(new Date(r.updated_at || r.created_at).toLocaleString())}</span>
              </div>
            </div>
          </div>
        `).join("");
      }
    }
  }

  // Initialization
  async function init() {
    setupEventListeners();
    await checkUser();
    await loadTerms();
    await loadStats();
    loadSongsCatalog();
  }

  window.addEventListener("DOMContentLoaded", init);

  // Offline suite surface (`test_frontend_github.mjs`). The page itself never
  // reads this: it is how the harness drives the very functions a browser would,
  // instead of a copy of them.
  if (typeof window !== "undefined") {
    window.__portalTestHooks = {
      init,
      loadAdminProposals,
      loadImagesView,
      loadSelector,
      loadSelectorItems,
      loadMoreSelectorItems,
      selectSelectorItem,
      openSelectorContextInStudio,
      selectorReleaseRef,
      selectorItemKey,
      switchView,
      saveSingleLyricLine,
      submitCurrentTranslation,
      submitStudioRestore,
      handleStudioImageFile,
      resetStudioImageState,
      checkUser,
      computeSha256,
      state,
      escapeHtml,
    };
  }
})();
