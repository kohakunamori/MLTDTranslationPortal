# Legacy Browser UI Inventory — `public/`

> **考古文档。** 引用的 `src/worker.js` 行号针对删除前的提交
> `7011fd8`（`git show 7011fd8:src/worker.js`）。该 Worker 与整套 D1/协作运行时已在
> 2026-10 的重构中删除；本文只用于解释新生成器的判定规则从哪来。


Read-only archaeology of the existing portal front end, produced to drive a re-implementation as a
**simplified, static, single-user "view translation content" site** with every collaboration feature removed.

Sources inspected (no file was modified):

| File | Lines | Size |
| --- | --- | --- |
| `public/index.html` | 1027 | 53,660 B |
| `public/app.js` | 3741 | 165,580 B |
| `public/app.css` | 4410 | 90,797 B |
| `public/github-contribution.js` | 233 | 11,568 B |
| `public/resource_hub.js` | 184 | 9,965 B |

Supporting reads for endpoint/response shapes: `src/worker.js`, `src/terms.js`, `src/release_registry.js`,
`local-data/retired-source/web/translation-portal/public/data/image_tasks.json`.

Line citations are `public/app.js:1234` style. All ids/functions/endpoints below were read from source, not inferred.

---

## 1) VIEW INVENTORY

`switchView(viewName)` (`public/app.js:345-373`) is the single router. It toggles `.view-section.active` plus
`style.display`, sets `#nav-{viewName}.active`, and then runs one of four loaders:

```js
if (viewName === "reviewer")      loadAdminProposals();          // app.js:364-365
else if (viewName === "lobby")    loadStats();                   // app.js:366-367
else if (viewName === "selector") loadSelector(state.selector.channel || "assets"); // 368-369
else if (viewName === "releases") loadReleases();                // 370-371
```

Note `#view-studio` has **no** `#nav-studio` button in the current HTML (the handler exists at
`app.js:2728-2731` but the element does not); studio is entered programmatically. Likewise `#view-releases`
has no nav button at all and is unreachable from the shipped markup

| # | View / modal | DOM root | What the user sees | Main DOM regions | Nav button that switches to it | Class |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **Task lobby** | `#view-lobby` (`index.html:36`, `class="view-section active"`) | Two-column landing: search hero, Assets/Client resource hub, image gallery section, lyrics/song catalogue, right sidebar with progress + release cards + repo links + writing tips | `.lobby-main-column` (`:39`) → `.lobby-search-hero` (`:41`) `#search-keyword` `#search-status` `#btn-do-search` `#btn-random-task`; `#resource-hub` (`:59`) `#resource-hub-grid`, `[data-resource-channel=assets|client]`, `#btn-refresh-resource-hub`, `#resource-hub-source`; `#lobby-images-section` (`:96`, `display:none`) `#img-category-tabs` `#search-img-keyword` `#filter-img-status` `#image-tasks-grid` `#image-pagination` `#stat-img-*`; `#lyrics-section` (`:148`, `display:none`) `#lyrics-count-songs` `#lyrics-count-slots` `#lyrics-count-rate` `#search-song-keyword` `#song-type-tabs` `#songs-grid`; `.lobby-sidebar` (`:182`) `#progress-fill` `#stat-total` `#stat-accepted` `#stat-pending` `#stat-contributors` `#card-client-release` `#card-assets-release` `.ssot-sidebar-card` | `#nav-lobby` (`:21`) and `#btn-home` (`:13`); `#btn-studio-back`, `#btn-releases-back`, `#btn-reviewer-back`, `#btn-selector-back`, `#btn-studio-img-back-lobby`, `#btn-lyrics-back-catalog` all return here | **READ-ONLY** — the category cards *open* the studio, but nothing on this view writes |
| 2 | **Studio / workbench** | `#view-studio` (`index.html:314`) | Five mutually exclusive layouts inside one view: dedicated lyrics track table, fake-phone chat mock, AVG story mock, standard single-line workbench, image localization workbench | `.studio-top-nav` (`:316`) `#btn-studio-back` `#studio-category-badge` `#studio-idol-badge` `#studio-mode-pill` `#studio-index-display` `.status-toggle-btn` `#btn-studio-tutorial`; **Layout A** `#studio-lyrics-layout` (`:335`) `#lyrics-dedicated-*` `.filter-pill` `#lyrics-lines-list`; **Layout B** `#studio-chat-layout` (`:377`) `#chat-phone-viewport` `#chat-messages-stream`; **Layout C** `#studio-story-layout` (`:402`) `#story-dialogue-stream`; **Layout D** `#studio-standard-layout` (`:417`) `#studio-source-box` `#term-hints-bar` `#existing-trans-box-wrap` `#translation-input` `#format-validation-panel` `#studio-mode-banner` `#btn-ai-translate` `#btn-ai-config` `#btn-copy-source` `#btn-extract-skeleton` `#btn-fix-delims` `#btn-studio-skip` `#btn-studio-submit` `#studio-pr-link` `.studio-sidebar-col` → `#quick-terms-list`; **Layout E** `#studio-image-layout` (`:556`) `#studio-img-source-preview` `#studio-img-upload-dropzone` `#studio-restore-canvas` `#btn-studio-submit-restore` `#studio-image-pr-link` | *(none — entered programmatically by `startStudioWithFilter`, `startLyricsStudio`, `openImageInStudio`, `openSelectorContextInStudio`)* | **HYBRID — write surface.** Reading (source/JP, existing ZH, terms, lyrics rows, image preview) is read-only; the textarea + `#btn-studio-submit` + `#btn-studio-submit-restore` + `#btn-save-lyric-*` are the collaboration write path |
| 3 | **Independent releases** | `#view-releases` (`index.html:646`, `style="display:none"`) | Dual-column Client/Assets release history with hashes, plus the four-state cross-version reuse matrix | `.studio-top-nav` `#btn-releases-back` `#releases-nav-tabs`; `.release-banner-card`; `.releases-dual-grid` → `#col-client-releases` `#client-releases-list` (`:679`), `#col-assets-releases` `#assets-releases-list` (`:690`); `.reuse-matrix-card` `#matrix-count-exact` `#matrix-count-verified` `#matrix-count-suggested` `#matrix-count-blocked` | **none** — no `#nav-releases` in `index.html`; `resource_hub.js:166` tries `click("#nav-releases")` for `entry === "releases"` but no `[data-resource-entry="releases"]` button exists, so the view is dead markup today | **READ-ONLY** (pure release metadata browsing) |
| 4 | **Reviewer / proposals** | `#view-reviewer` (`index.html:741`) | Read-only mirror of the GitHub PR queue: cards with PR link, state, mergeable badge, CI rollup, head SHA | `.studio-top-nav` `#btn-reviewer-back` `#admin-target-filter` `#btn-refresh-queue`; `.admin-review-note`; `#admin-proposal-list` (`:761`) | `#nav-reviewer` (`:23`, `style="display:none"` by default; unhidden only by `checkUser()` at `app.js:537-540` for role `reviewer`/`admin`) | **COLLABORATION** — exists only to surface other people's proposals/PRs |
| 5 | **Repository → version → resource selector** | `#view-selector` (`index.html:768`) | Channel tabs (Assets/Client), a locked single-release dropdown, a paged list of resource rows, and a right panel showing the row's *commit binding* (target repo / path / base commit / row kind / version axis) with an "edit this row in the workbench" button | `.studio-top-nav` `#btn-selector-back`; `#selector-channel-tabs` `#selector-release` `#selector-channel-note` `#selector-status` `#selector-items` `#selector-more` `#selector-selection` | `#nav-selector` (`:22`) | **HYBRID — mostly write-oriented.** The row list + paging is browsable; `#selector-selection` renders the GitHub binding and `#btn-selector-open` hands the row to the studio editor |
| 6 | **Tutorial modal** | `#tutorial-modal` (`index.html:832`) | Four-section "how to write a translation" guide: forbidden half-width `|`/`^`, tag/variable syntax cards, punctuation habits, shortcuts | `#btn-close-tutorial` `#btn-tutorial-ok`; `.tutorial-sec` `.syntax-cards-grid` `.tips-grid` | opened by `#btn-studio-tutorial` (`:329`), `#btn-guide-more` (`:515`); `#btn-open-tutorial` is referenced at `app.js:2844` but does not exist | **WRITE-GUIDANCE** — content is authoring rules, not collaboration tech |
| 7 | **AI config modal** | `#ai-config-modal` (`index.html:955`, `style="display:none"`) | Provider preset chips (DeepSeek/OpenAI/Gemini/Ollama/custom), endpoint, API key with visibility toggle, model, temperature slider, extra instruction textarea, test button | `#btn-close-ai-config` `.preset-chip[data-preset]` `#ai-endpoint` `#ai-api-key` `#btn-toggle-key-vis` `#ai-model` `#ai-temperature` `#ai-temp-val` `#ai-custom-prompt` `#ai-test-result` `#btn-test-ai` `#btn-clear-ai` `#btn-save-ai` | opened by `#btn-ai-config` (`:431`) via `toggleAiConfigModal(true)` (`app.js:1870`), also auto-opened from `callAiChat` when no key (`app.js:180`) | **PERSONAL DRAFTING HELPER — not collaboration.** Key lives only in `localStorage["mltd_ai_config"]`; requests go straight to the user's own AI provider. See §3 for keep/delete reasoning |
| 8 | Toast | `#toast` (`index.html:829`) | Transient status line | `showToast()` (`app.js:334-342`) | — | shared |
| 9 | Footer | `.app-footer` (`index.html:814`) | Project blurb, repo links, license, "提交 PR" external link (`:823`) | — | — | static / external links |

---

## 2) PER-VIEW DATA DEPENDENCY TABLE

One row per rendered region. **This table is the requirement list for the new static data files.**
`manifest` rows come from `resource_hub.js`; everything else from `app.js`.

### 2.1 Lobby — `#view-lobby`

| View | DOM element id(s) | HTTP endpoint(s) (exact path from source) | Response fields consumed |
| --- | --- | --- | --- |
| Lobby | `#progress-fill`, `#stat-percent`, `#stat-untranslated-label`, `#stat-total`, `#stat-accepted`, `#stat-pending`, `#stat-contributors` | `GET /api/stats` (`app.js:581`) | `data.summary.{total,accepted,pending,contributors,progress_percent,untranslated}`, `data.{total,accepted,pending,contributors,progress_percent,untranslated,categories,by_idol,idols}` — normalised at `app.js:588-599` |
| Lobby | `#resource-hub-source` (also written by `renderStatsUI`) | *(reuses `/api/stats`)* | `state.stats.release_id`, `.asset_version`, `.summary_updated_at`, `.source`, `.summary_stale` (`app.js:632-639`) |
| Lobby | `[data-resource-channel="assets"]`, `[data-resource-channel="client"]`, `[data-resource-status]`, `[data-resource-metrics]`, `[data-resource-categories]`, `#resource-hub-source` | `GET /api/assets/releases?limit=20`, `GET /api/client/releases?limit=20`, then `GET /api/assets/releases/{asset_version\|release_id}/manifest`, `GET /api/client/releases/{release_id\|client_version}/manifest` (`resource_hub.js:109-119`) | release: `.release_id`, `.asset_version`, `.client_version`, `.status`, `.abi`, `.source_manifest_sha256`, `.manifest_sha256` (`resource_hub.js:69-81`); manifest: `.totals.{total,translated,pending}`, `.categories[].{id,name,icon,total,pending,untranslated,entry}`, `.summary_ready` (`resource_hub.js:45-88`) |
| Lobby | `[data-resource-entry="assets-text"\|"assets-images"\|"client"]` (buttons inside the channel cards) | **no fetch** — dispatches `portal:open-domain` / clicks `#nav-selector` (`resource_hub.js:142-172`) | — |
| Lobby | `#categories-grid` **(id absent from `index.html`)**, `#domain-tabs` **(id absent from `index.html`)**, `.cat-card[data-category]` | **no own fetch** — reads `state.resourceManifests`, set by the `portal:resource-manifests` event from `resource_hub.js` (`app.js:3080-3083`) | `manifest.categories[].{id,icon,name,description,unit,total,accepted,progress_percent,domain,channel,entry}`; `manifest.domains[].{id,name,icon}` (`app.js:673-751`) |
| Lobby | `#lobby-images-section`, `#img-category-tabs .domain-tab`, `#stat-img-total`, `#stat-img-not-needed`, `#stat-img-event`, `#stat-img-costume`, `#stat-img-tutorial` | `GET /api/images/tasks?pageSize=60[&category=][&search=][&cursor=]` (`app.js:2131-2135`, page size const `IMAGE_TASK_PAGE_SIZE` at `:2114`) | `data.tasks[]`, `data.categories{}`, `data.total`, `data.next_cursor` (`app.js:2137-2145`) |
| Lobby | `#search-img-keyword`, `#filter-img-status`, `#image-tasks-grid`, `#image-pagination` (`#btn-img-prev`, `#btn-img-next`) | *(reuses the loaded `allImageTasksCache`)*; thumbnails/downloads: `GET /api/images/asset?task_id={id}&type=composite` and `...&download=1` (`app.js:2251-2252`, `:2420`, `:2428`) | `task.task_id`, `.bundle`, `.category`, `.category_name`, `.width`, `.height`, `.status`, `.description` (`app.js:2246-2286`) — `.source_sha256` is needed only by the write path |
| Lobby | `#lyrics-section`, `#lyrics-count-songs`, `#lyrics-count-slots` **(static literal `12,131 槽位`)**, `#lyrics-count-rate` **(static literal `100% 映射`)**, `#search-song-keyword`, `#song-type-tabs .type-tab[data-song-type]`, `#song-type-count-all`, `#songs-grid` | `GET /api/lyrics/songs?limit=100[&cursor=]` — paged loop up to 40 pages (`app.js:770-785`) | `data.songs[]`, `data.next_cursor`; song: `.bundle`, `.asset`, `.name_ja`, `.name_zh`, `.type`, `.slots`, `.translated`, `.release_id` (`app.js:823-873`). **`.preview_ja`, `.preview_zh`, `.bpm` are consumed but never served — see §7** |
| Lobby | `#search-keyword`, `#search-status`, `#btn-do-search`, `#btn-random-task` | `GET /api/catalogue/search?category=&idol=&status=&query=&asset_version=&limit=50` (`app.js:1209-1221`), with up to two retries on `status` (`app.js:1249`, `:1262`) | `data.rows[]`, `data.quota_exceeded`, `data.message`, `data.status_fallback` (`app.js:1231-1273`) |
| Lobby | `#sidebar-client-status`, `#sidebar-client-version`, `#sidebar-client-abi`, `#sidebar-client-base-sha`, `#sidebar-client-commit`, `#sidebar-client-output-sha` | `GET /api/client/releases` (`app.js:3519`) | `releases[0].client_version`, `.abi`, `.status`, `.base_apk_sha256`, `.client_resources_commit`, `.output_apk_sha256` (`app.js:3527-3557`) |
| Lobby | `#sidebar-assets-status`, `#sidebar-assets-version`, `#sidebar-assets-schema`, `#sidebar-assets-manifest-sha`, `#sidebar-assets-commit`, `.reuse-pill.{exact,verified,suggested,blocked} strong` | `GET /api/assets/releases` (`app.js:3520`) + `GET /api/assets/releases/{asset_version}/summary` (`app.js:3584`) | release: `.asset_version`, `.status`, `.server_schema_version`, `.source_manifest_sha256`, `.assets_commit` (`app.js:3560-3581`); summary: `.reused_items`, `.suggested_items`, `.blocked_items` (`app.js:3592-3595`; `.verified` is hard-coded `"0"`) |

### 2.2 Studio — `#view-studio`

| View | DOM element id(s) | HTTP endpoint(s) | Response fields consumed |
| --- | --- | --- | --- |
| Studio top nav (all layouts) | `#studio-category-badge`, `#studio-idol-badge`, `#studio-mode-pill`, `#studio-index-display` | *(from the studio queue)* | `item.category`, `.category_name`, `.idol.{name_zh,code,color}`, `.item_key`, `.bundle` (`app.js:1334-1401`) |
| Studio Layout A (lyrics) | `#studio-lyrics-layout`, `#lyrics-dedicated-type`, `#lyrics-dedicated-title-ja`, `#lyrics-dedicated-title-zh`, `#lyrics-dedicated-bundle`, `#lyrics-dedicated-bpm`, `#lyrics-dedicated-progress`, `.filter-pill[data-lyric-filter]`, `#lyrics-lines-list`, `#lyric-row-{i}`, `#lyric-input-{i}`, `#len-meter-{i}`, `#lyric-st-badge-{i}`, `#btn-save-lyric-{i}`, `#btn-ai-lyric-{i}` | `GET /api/lyrics/song?bundle={bundle}` (`app.js:900`) | `data.lines[]`, `data.quota_exceeded`; line: `.slot_index`, `.source`, `.translation`, `.status` (`app.js:977-1021`); song meta from the lobby catalogue: `.name_ja`, `.name_zh`, `.bundle`, `.type`, `.bpm` (`app.js:952-959`) |
| Studio Layout B (chat mock) | `#studio-chat-layout`, `#chat-messages-stream`, `#chat-contact-avatar`, `#chat-contact-name` | **DEAD** — never rendered; only force-hidden at `app.js:930`, `:1328`, `:2378` | — |
| Studio Layout C (story AVG) | `#studio-story-layout`, `#story-dialogue-stream`, `#story-scene-bundle` | **DEAD** — same; the AVG look is reproduced by `renderStudioModeBanner` (`app.js:1464-1476`) inside Layout D | — |
| Studio Layout D (standard) | `#studio-standard-layout`, `#studio-speaker-dot`, `#studio-speaker-name`, `#studio-bundle-name`, `#studio-mode-banner`, `#studio-source-box`, `#term-hints-bar`, `#existing-trans-box-wrap`, `#existing-trans-box`, `#existing-trans-status`, `#translation-input`, `#char-counter`, `#format-validation-panel`, `#val-badge`, `#val-summary`, `#validation-details-list` | `GET /api/catalogue/search?...&limit=50` (`app.js:1221`) | row: `.bundle`, `.item_key`, `.source`, `.translation` (fallback `.current_translation`), `.status`, `.category`, `.category_name`, `.idol.{code,name_ja,name_zh,color}`, `.github.{target,path,base_commit,source_sha256}`, `.logical_key`, `.asset_version`, `.client_version`, `.source_sha256`, `.edit_endpoint`, `.release_id`, `.release_kind`, `.reuse_mode` (render at `app.js:1306-1435`, `:1507-1593`) |
| Studio sidebar | `#quick-terms-list`, `#quick-terms-count` | `GET /api/terms` (`app.js:558`), cached in `localStorage["mltd_terms_v2"]` (`app.js:548`, `:564`) | `data.terms[]` → `.source`, `.target`; `data.idols` → `.name_ja`, `.name_zh`, `.color` (`app.js:1517-1531`, `:1642-1658`) |
| Studio Layout E (images) | `#studio-image-layout`, `#studio-img-task-title`, `#studio-img-bundle-meta`, `#studio-img-source-preview`, `#studio-img-source-res`, `#btn-studio-download-source` | `GET /api/images/asset?task_id={id}&type=composite[&download=1]` (`app.js:2420-2429`) — task metadata already in memory from the `/api/images/tasks` page | `task.task_id`, `.description`, `.category_name`, `.width`, `.height`, `.status` (`app.js:2390-2430`) |
| Studio Layout E (upload/restore half) | `#studio-img-upload-dropzone`, `#studio-dropzone-prompt`, `#studio-img-upload-preview`, `#studio-img-upload-res`, `#studio-aspect-ratio-status`, `#studio-restore-canvas`, `#studio-restore-placeholder`, `#studio-img-restore-status`, `#btn-studio-submit-restore` | write path only: `POST /api/images/submit` (`app.js:2652`) | request body from `github-contribution.js:154-180`: `task_id`, `image_base64`, `target`, `path`, `base_commit`, `source_sha256`, `asset_version`; response `.pr_url`, `.pr_number`, `.upstream_direct`, `.scaling` — **delete with the write path** |
| Tutorial modal | `#tutorial-modal` | **no fetch** — fully static prose | — |
| AI config modal | `#ai-config-modal`, `#ai-test-result` | `localStorage["mltd_ai_config"]`; `fetch(cfg.endpoint)` POST for translate/polish/test (`app.js:195-203`, `:1922`) | AI response `data.choices[0].message.content` (`app.js:218`) |

### 2.3 Releases — `#view-releases`

| View | DOM element id(s) | HTTP endpoint(s) | Response fields consumed |
| --- | --- | --- | --- |
| Releases | `#releases-nav-tabs .domain-tab[data-rel-tab]`, `#col-client-releases`, `#col-assets-releases` | *(client-side show/hide, `app.js:2736-2754`)* | — |
| Releases | `#client-releases-list` → `.release-item-card` | `GET /api/client/releases` (`app.js:3519`) | `.client_version`, `.abi`, `.status`, `.release_id`, `.base_apk_sha256`, `.client_resources_commit`, `.output_apk_sha256`, `.created_at` (`app.js:3624-3656`) |
| Releases | `#assets-releases-list` → `.release-item-card` | `GET /api/assets/releases` (`app.js:3520`) | `.asset_version`, `.status`, `.server_schema_version`, `.release_id`, `.source_manifest_sha256`, `.assets_commit`, `.note`, `.updated_at`, `.created_at` (`app.js:3664-3698`) |
| Releases | `#matrix-count-exact`, `#matrix-count-verified`, `#matrix-count-suggested`, `#matrix-count-blocked` | `GET /api/assets/releases/{asset_version}/summary` (`app.js:3584`) | `.reused_items`, `.suggested_items`, `.blocked_items` (`app.js:3597-3604`; verified hard-coded `0`) |

### 2.4 Reviewer — `#view-reviewer` (collaboration)

| View | DOM element id(s) | HTTP endpoint(s) | Response fields consumed |
| --- | --- | --- | --- |
| Reviewer | `#admin-target-filter`, `#btn-refresh-queue`, `#admin-proposal-list` → `.queue-card.admin-pr-card` | `GET /api/admin/contributions[?target=assets\|client]` (`app.js:2092`) | `data.rows[]`; `row.github.{target_repo,head_branch,pr_url,pr_number,state,merged,mergeable_state,ci_status,head_sha}`, `row.bundle`, `row.item_key`, `row.contributor_email`, `row.ja`, `row.zh`, `row.updated_at`, `row.created_at`, `row.target_repo` (`app.js:2039-2079`) |

### 2.5 Selector — `#view-selector`

| View | DOM element id(s) | HTTP endpoint(s) | Response fields consumed |
| --- | --- | --- | --- |
| Selector | `#selector-channel-tabs .domain-tab[data-selector-channel]`, `#selector-release`, `#selector-channel-note`, `#selector-status` | `GET /api/assets/releases` and `GET /api/client/releases` (`SELECTOR_CHANNELS`, `app.js:3120-3137`, fetched `:3209`) | `.release_id`, `.asset_version`, `.client_version`, `.status`, `.source` (github), `.assets_commit`, `.client_resources_commit` (`app.js:3215-3251`) |
| Selector | `#selector-items` → `.selector-item`, `#selector-more` | `GET /api/{assets\|client}/releases/{ref}/items?limit=100[&cursor=]` (`selectorItemsUrl`, `app.js:3181-3186`) | `data.items[].{bundle,item_key,status,translation}`, `data.release_id`, `data.next_cursor`, `data.has_more` (`app.js:3315-3326`, `:3358-3379`) |
| Selector | `#selector-selection` → `.selector-context-row` | `GET /api/{channel}/releases/{ref}/item?bundle=&item_key=` (`selectorItemUrl`, `app.js:3188-3192`) then the **service-supplied** `edit_endpoint` (`app.js:3442`) which `src/worker.js:1720` / `:2087` builds as `/api/{assets\|client}/releases/{release_id}/item/edit-context?bundle=&item_key=` | detail: `detail.item.edit_endpoint` (`app.js:3434`); context: `.editable`, `.reason`, `.detail`, `.github.{target,path,base_commit}`, `.row_kind`, `.asset_version`, `.client_version`, `.bundle`, `.item_key`, `.logical_key`, `.source`, `.translation`, `.category`, `.resource_id` (`app.js:3381-3407`, `:3462-3491`) |
| Selector | `#btn-selector-open` | **no fetch** — hands the context to the studio editor | — |

---

## 3) COLLABORATION-ONLY SURFACE LIST (delete list)

**40 numbered items.** Each is a self-contained deletable unit with the exact names needed to verify removal.

### A. Identity / OAuth / session (items 1–8)

1. **Header identity pill container** — `#user-info` (`index.html:29-31`) and its renderer `renderUserInfo()` (`app.js:464-491`). It overwrites `innerHTML` with the session email, role tag, GitHub account and logout button.
2. **GitHub link button** — element `#btn-github-login`, created only inside `renderUserInfo()` (`app.js:480`), bound at `app.js:490`; handler `startGithubLogin(e)` (`app.js:458-461`) which navigates to `/api/auth/github/login`.
3. **Logout button + handler** — element `#btn-logout` (`app.js:487`, bound `:489`); `async function handleLogout(e)` (`app.js:493-513`) → `POST /api/auth/github/logout`, clears `localStorage["mltd_terms_v2"]` and `sessionStorage`, then reloads.
4. **Session bootstrap** — `async function checkUser()` (`app.js:516-541`) → `GET /api/auth/github/me`; assigns the four undeclared state keys `state.user`, `state.githubIdentity`, `state.csrfToken`, `state.access`. Called from `init()` (`app.js:3706`).
5. **Reviewer-nav gate** — `app.js:537-540` unhides `#nav-reviewer` only when `state.user.role` is `reviewer`/`admin`. Delete together with item 24.
6. **CSRF header helper** — `function githubPrHeaders()` (`app.js:396-401`) returning `{"Content-Type": "application/json", "x-csrf-token": state.csrfToken || ""}`. Its only three callers are the three write paths (items 14, 15, 17).
7. **Identity state fields** — `state.user`, `state.githubIdentity`, `state.csrfToken`, `state.access` (never declared in the `state` literal at `app.js:7-69`; created at `app.js:518-520`, `:528-532`). Also the `roleClass`/`roleLabel` computation at `app.js:469-470`.
8. **User-status CSS** — `.user-status-pill`, `.logout-btn`, `.gh-link-btn`, `.gh-avatar`, `.gh-login`, `.role-tag` (`app.css:2892-2923`, `:4193-4219`).

### B. Proposal submission (text) (items 9–15)

9. **Error-code translation table** — `SUBMIT_ERROR_TEXT` (`app.js:80-120`, ~40 codes) + `describeSubmitError(code)` (`app.js:122-124`). Every code is a submission-failure code (`duplicate_contribution`, `csrf_token_*`, `github_pr_token_unconfigured`, `role_required`, …).
10. **Shared contribution module binding** — `const contributionApi = window.MLTDContribution` (`app.js:429`), `IMAGE_RATIO_TOLERANCE` (`app.js:436`), and the three wrappers `checkImageRatio()` (`:438-441`), `buildTextProposal()` (`:443-446`), `buildImageProposal()` (`:448-451`), `dataUrlToBase64()` (`:453-456`).
11. **PR result link renderer** — `function renderPrLink(el, proposal)` (`app.js:407-422`); DOM targets `#studio-pr-link` (`index.html:506`), `#studio-image-pr-link` (`:637`), and the per-lyric-row `#lyric-pr-link-{index}` (`app.js:1015`); CSS `.pr-result-link`, `.pr-result-link.is-warning`, `.pr-result-link .pr-ci` (`app.css:4165-4191`).
12. **Studio submit button** — `#btn-studio-submit` (`index.html:504`, bound `app.js:3072`) and the `disabled` toggling inside `validateTranslationInput()` (`app.js:1675`, `:1690`, `:1699`, `:1704`, `:1719`, `:1752`, `:1783`).
13. **Standard-line submit path** — `async function submitCurrentTranslation()` (`app.js:1949-2019`) → `POST /api/contributions/github-pr` (`app.js:1986`); locally mutates `state.currentItem.{translation,status,pr_url,pr_number}` (`:2003-2006`). Ctrl+Enter binding at `app.js:3045-3047`.
14. **Lyric-line submit path** — `async function saveSingleLyricLine(index)` (`app.js:1083-1158`) → `POST /api/contributions/github-pr` (`app.js:1124`); the button `#btn-save-lyric-{index}` and its label `💾 提交 PR` (`app.js:1020`), plus the status badge rewrite at `:1140-1141`.
15. **Write-gate guards inside both submit paths** — `if (!state.githubIdentity) { showToast("…关联 GitHub 账号…") }` (`app.js:1101-1104`, `:1962-1965`, `:2606-2609`) and `if (!state.csrfToken) { … }` (`app.js:1105-1108`, `:1966-1969`, `:2610-2613`).

### C. Proposal submission (images) (items 16–23)

16. **Image submit path** — `async function submitStudioRestore()` (`app.js:2597-2683`) → `POST /api/images/submit` (`app.js:2652`); button `#btn-studio-submit-restore` (`index.html:631`, bound `app.js:2841`), CSS `.btn-run-restore` (present but unused), the CI note at `index.html:634-636`.
17. **Upload intake** — `function handleStudioImageFile(file)` (`app.js:2486-2552`) and its bound elements `#studio-file-input-image` (`index.html:606`), `#studio-img-upload-dropzone` (`:599`), `#studio-dropzone-prompt` (`:600`), `#studio-img-upload-preview` (`:605`), `#btn-studio-trigger-file` (`:609`), `#btn-studio-clear-img` (`:610`), `#studio-img-upload-res` (`:597`); bindings at `app.js:2808-2840` (click / change / dragover / dragleave / drop).
18. **Aspect-ratio gate output** — `#studio-aspect-ratio-status` (`index.html:612`) written by `handleStudioImageFile` (`app.js:2516-2547`); verdict object from `MLTDContribution.checkImageRatio` (`github-contribution.js:188-210`); CSS `.aspect-ratio-status.match`, `.aspect-ratio-status.mismatch`.
19. **Restore preview** — `function renderStudioRestoreCanvas(task, uploadedImg)` (`app.js:2554-2592`) and DOM `#studio-restore-canvas` (`index.html:628`), `#studio-restore-placeholder` (`:624`), `#studio-img-restore-status` (`:621`).
20. **Upload state reset** — `function resetStudioImageState()` (`app.js:2436-2466`), called from `openImageInStudio` (`app.js:2433`) and the clear button (`app.js:2840`).
21. **Retired status-write shim** — `function onStudioImageStatusClick()` (`app.js:2708-2710`) + button `#btn-studio-img-toggle-status` (`index.html:566`, bound `app.js:2801`). Kept only so a retired `POST /api/images/status` cannot creep back; there is no reader for it in a viewer.
22. **`public/github-contribution.js` (whole file)** — exposes `window.MLTDContribution` (`github-contribution.js:219-231`) with `buildTextProposal` (`:114-136`), `buildImageProposal` (`:154-180`), `githubBinding` (`:67-84`), `versionFieldsFor` (`:89-97`), `versionFor` (`:100-109`), `isCompositeVersion` (`:53-57`), `dataUrlToBase64` (`:213-217`), `checkImageRatio` (`:188-210`), and the constants `IMAGE_RATIO_TOLERANCE` (`:42`), `MAX_GATE_DIMENSION` (`:47`), `TARGETS` (`:51`). **100 % write-path**; the only reader-side use is the aspect gate (item 18), which dies with the upload form.
23. **Write-path error codes in the image flow** — `image_source_sha256_missing`, `image_path_mismatch`, `client_image_unsupported`, `aspect_ratio_mismatch`, `resolution_below_original`, `original_size_unknown` guards (`app.js:2615-2644`).

### D. Reviewer queue / admin (items 24–29)

24. **Reviewer view** — `<main id="view-reviewer">` (`index.html:741-765`) including `#btn-reviewer-back`, `#admin-target-filter`, `#btn-refresh-queue`, `#admin-proposal-list`, and the `.admin-review-note` paragraph (`:756-759`).
25. **Reviewer loader** — `async function loadAdminProposals()` (`app.js:2081-2107`) → `GET /api/admin/contributions` (`:2092`); call sites in `switchView` (`:364-365`) and `#btn-refresh-queue` (`:2764`).
26. **Proposal card renderer** — `function renderGithubProposalCard(row)` (`app.js:2039-2079`) producing `.queue-card.admin-pr-card` (note: **`.queue-card` has no CSS rule at all**).
27. **CI label map** — `const ADMIN_CI_LABELS` (`app.js:2032-2037`).
28. **Reviewer nav button** — `#nav-reviewer` (`index.html:23`) and its binding (`app.js:2734`).
29. **Admin CSS block** — `.admin-proposal-list`, `.admin-pr-card .admin-pr-row`, `.admin-pr-card .pr-link`, `.admin-pr-badge`, `.admin-pr-badge.ci-{success,failure,pending}`, `.admin-pr-badge.state-merged`, `.admin-pr-missing` (`app.css:4228-4284`); plus unused leftovers `.state-merged`, `.ci-success`, `.ci-failure`, `.ci-pending`, `.pr-link`, `.admin-review-note` (`.admin-review-note` is still used by `#view-selector` — see §5).

### E. Selector write half (item 30)

30. **Selector commit-binding panel + hand-off** — `function renderSelectorSelection(context)` (`app.js:3381-3407`) with `#btn-selector-open`, `function openSelectorContextInStudio(context)` (`app.js:3462-3491`), and `async function selectSelectorItem(item, rowElement)` (`app.js:3414-3453`). The *browsing* half (`loadSelector`, `loadSelectorReleases`, `loadSelectorItems`, `fetchSelectorPage`, `renderSelectorItems`, `renderSelectorMore`, `loadMoreSelectorItems`) is keepable — see §4.

### F. Test hooks / write helpers (items 31–33)

31. **`window.__portalTestHooks`** (`app.js:3717-3740`) — 20-member object: `init`, `loadAdminProposals`, `loadImagesView`, `loadSelector`, `loadSelectorItems`, `loadMoreSelectorItems`, `selectSelectorItem`, `openSelectorContextInStudio`, `selectorReleaseRef`, `selectorItemKey`, `switchView`, `saveSingleLyricLine`, `submitCurrentTranslation`, `submitStudioRestore`, `handleStudioImageFile`, `resetStudioImageState`, `checkUser`, `computeSha256`, `state`, `escapeHtml`. Consumed only by `test_frontend_github.mjs` (`:299`). Of these, `loadAdminProposals`, `selectSelectorItem`, `openSelectorContextInStudio`, `saveSingleLyricLine`, `submitCurrentTranslation`, `submitStudioRestore`, `handleStudioImageFile`, `resetStudioImageState`, `checkUser`, `computeSha256` are **collaboration-only**.
32. **`computeSha256()`** (`app.js:72-77`) — never called anywhere in the page; only exported to the test hooks (`app.js:3736`). Dead.
33. **Studio session persistence** — `function saveStudioSession()` (`app.js:1160-1170`) writing `sessionStorage["mltd_studio_session"]` (filter/index/queue/mode/songMeta) plus the restore branch in `startStudioWithFilter` (`app.js:1183-1203`) and the `removeItem` calls at `app.js:1309`, `:3487`. It is a *local draft/submit-progress* helper tied to the submit flow; a static viewer has no queue to resume.

### G. AI config modal — collaboration-related? NO (items 34–35)

34. **Verdict: personal drafting helper, not collaboration.** Evidence: the key is stored only in `localStorage["mltd_ai_config"]` (`app.js:129-130`, `:160-174`); the request goes **directly from the browser to the user's own provider** with `Authorization: Bearer <key>` (`app.js:190-203`), never through the portal; the UI states this itself (`index.html:960` "密钥只存在本机浏览器", `:989` "不经本站"). Nothing about it is multi-user, and it works identically for a single-user viewer.
    *Deletion is therefore optional.* It is still an **authoring** assistant (translate/polish), so a "view translation content" site can drop it without losing any browsing capability. Affected surface if dropped: `#ai-config-modal` (`index.html:955-1021`), `#btn-ai-config` (`:431`), `#btn-ai-translate` (`:430`), `#btn-ai-translate-tool` (`:479`), `#btn-ai-polish` (`:469`), `#btn-ai-lyric-{i}` (`app.js:1019`); functions `AI_CONFIG_KEY`/`DEFAULT_AI_CONFIG` (`app.js:129-135`), `AI_PRESETS` (`:137-158`), `getAiConfig` (`:160`), `saveAiConfig` (`:170`), `callAiChat` (`:176`), `buildMltdAiSystemPrompt` (`:222`), `requestAiTranslation` (`:1788`), `requestAiPolish` (`:1821`), `toggleAiConfigModal` (`:1870`), `testAiConnection` (`:1892`), `applyPreset` (`:2975`), `handleSaveAi` (`:2998`); bindings at `app.js:2934-3032`; CSS `.ai-config-body`, `.ai-provider-presets`, `.preset-chip(s)`, `.form-*`, `.input-with-toggle`, `.btn-toggle-vis`, `.range-with-val`, `.range-display`, `.ai-test-result`, `.safe-note`.
35. **`#btn-ai-quick-polish`** (`app.js:1832`, `:2936`) and `#btn-close-ai-modal` (`app.js:2951`) and `#btn-save-ai-config` (`app.js:3015`) are bound but **absent from `index.html`** — dead bindings either way.

### H. Tutorial modal — write guidance (item 36)

36. **`#tutorial-modal`** (`index.html:832-952`) + `toggleTutorialModal(show)` (`app.js:1635-1640`), triggers `#btn-studio-tutorial` (`:329`), `#btn-guide-more` (`:515`), `#btn-close-tutorial` (`:839`), `#btn-tutorial-ok` (`:949`, never bound). All four sections are instructions for *producing* translations (forbidden `|`/`^`, tag preservation, punctuation, shortcuts). Harmless but authoring-oriented; deletable along with the `.studio-sidebar-col` guide card and `.sidebar-guide-list` tips.

### I. Misc collaboration-flavoured (items 37–40)

37. **Contribution counters** — `#stat-contributors` (`index.html:212-214`) and its writer (`app.js:612`). `/api/stats` never serves a `contributors` field (`src/worker.js:336-374`, `:461-487`) so it always renders `0`.
38. **GitHub-repo footer CTA** — `.footer-links` "提交 PR" (`index.html:823`) and the header `GitHub 仓库 ↗` nav link (`index.html:24-27`). External links, not code, but they advertise the contribution flow.
39. **`#studio-index-display` / `#btn-studio-skip` wording** — `第 N / M 条` (`app.js:1383`) and `下一条 (Alt+S)` are *queue cursor* UI ("task claiming"). Keep the position indicator if useful; the "skip this task" semantics are workflow, not browsing.
40. **Retired-write tombstones** — the three long comments that exist only to explain removed writes: `app.js:2471-2484` (three image upload paths), `app.js:2695-2707` (`/api/images/status`), `app.js:2254-2259` (card status toggle). They carry no behaviour but name retired endpoints (`POST /api/images/restore`, `POST /api/images/status`, `POST /api/contributions`) that a clean re-implementation should not resurrect.

### Write endpoints to remove (route table, `src/worker.js:5123-5280`)

| Endpoint | Called from | Purpose |
| --- | --- | --- |
| `GET /api/auth/github/login` | `app.js:460` | OAuth start |
| `GET /api/auth/github/callback` | browser redirect (`src/worker.js:3991`) | OAuth finish |
| `GET /api/auth/github/me` | `app.js:522` | session + CSRF token |
| `POST /api/auth/github/logout` (also `POST /api/logout`, `src/worker.js:5180`) | `app.js:497` | session end |
| `POST /api/contributions/github-pr` | `app.js:1124`, `app.js:1986` | text/lyric proposal PR |
| `POST /api/images/submit` | `app.js:2652` | image proposal PR |
| `GET /api/admin/contributions` | `app.js:2092` | proposal queue mirror |
| `GET /api/{assets\|client}/releases/{ref}/item/edit-context` | `app.js:3442` via service-supplied `edit_endpoint` | commit binding hand-off |

---

## 4) READ-ONLY VALUE LIST (keep list)

| # | Feature | Implementation | Data source |
| --- | --- | --- | --- |
| 1 | **Stats / progress dashboard** | `loadStats(force)` (`app.js:574-605`), `renderStatsUI()` (`:607-642`), 3-minute client throttle via `lastStatsFetchTime` / `STATS_CACHE_DURATION` (`:542-543`) | `GET /api/stats` |
| 2 | **Resource hub overview (Assets / Client)** | `loadResourceHub(force)` (`resource_hub.js:102-140`), `chooseRelease()` (`:35-43`), `summaryTotals()` (`:45-54`), `renderChannel()` (`:56-100`), `enterResource()` (`:142-172`) | `/api/{assets,client}/releases`, `.../manifest` |
| 3 | **Category taxonomy from the release manifest** | `renderCategoriesGrid()` (`app.js:673-752`), `activateLobbyDomain(domain)` (`:646-671`) | `manifest.categories[]`, `manifest.domains[]` — **DOM hook `#categories-grid`/`#domain-tabs` must be re-added** |
| 4 | **Domain / section switching** | `portal:open-domain` listener (`app.js:3096-3098`), `portal:resource-category` listener (`:3085-3091`) | events, no fetch |
| 5 | **Keyword + status search** | `#btn-do-search` handler (`app.js:2898-2902`), Enter key (`:2904-2908`) | `GET /api/catalogue/search` |
| 6 | **Random item jump** | `#btn-random-task` handler (`app.js:2910-2920`) — picks a random studio-entry category from the manifests | manifests |
| 7 | **Studio queue pagination / reading order** | `startStudioWithFilter()` (`app.js:1173-1288`) with `limit=50`, `#btn-studio-skip` (`:3073-3077`) | `/api/catalogue/search` |
| 8 | **Auto layout selection by category** | `detectStudioMode(item)` (`app.js:1291-1301`) — lyrics / chat / story / card / lounge / system from `bundle` + `category` | row fields |
| 9 | **JP/ZH side-by-side reading (standard)** | `renderCurrentStudioItem()` (`app.js:1306-1435`): `#studio-source-box` (JA) vs `#existing-trans-box` + `#translation-input` (ZH); `#existing-trans-status` badge from `item.status` (`:1419-1424`) | row `.source`, `.translation`, `.status` |
| 10 | **Tailored per-category presentation** | `renderStudioModeBanner(item, mode)` (`app.js:1438-1504`) — chat phone bubble, AVG dialogue card, SSR card frame, lounge sticky note, system UI meter | row fields + `item.idol` |
| 11 | **Idol/term highlighting + click-to-fill hints** | `renderSourceWithHighlights(sourceText)` (`app.js:1507-1593`) — longest-match-wins overlap suppression (`:1539-1551`), `.term-highlight` spans, `#term-hints-bar` chips | `GET /api/terms` (`state.terms`, `state.idols`) |
| 12 | **Quick glossary sidebar** | `renderQuickTerms()` (`app.js:1642-1658`) — first 24 terms, `#quick-terms-count` | `/api/terms` |
| 13 | **Term insertion helper** | `insertTermIntoTextarea(zh)` (`app.js:1660-1670`) | — |
| 14 | **Full-track lyrics reading (slots, JP, ZH, status)** | `renderDedicatedLyricsStudio()` (`app.js:927-967`), `renderLyricsLinesList()` (`app.js:969-1074`), per-line `.filter-pill[data-lyric-filter]` (`:2855-2862`), `state.sessionSongLyricsCache` (`:889`, `:917`) | `GET /api/lyrics/song?bundle=` |
| 15 | **Song catalogue browse + search + type tabs** | `loadSongsCatalog()` (`app.js:758-794`), `renderSongsGrid()` (`app.js:796-881`), type tabs (`:2879-2886`), instant keyword filter over `name_ja`/`name_zh`/`asset`/`preview_*` (`:820-834`) | `GET /api/lyrics/songs?limit=100` (paged) |
| 16 | **Open a song's lyric track from the catalogue** | `startLyricsStudio(songMeta)` (`app.js:884-922`), `#btn-lyrics-back-catalog` (`:2757-2761`) | `/api/lyrics/song` |
| 17 | **Image gallery with category tabs, status filter, search, pagination** | `loadImageTasks()` (`app.js:2125-2149`), `loadImagesView()` (`:2151-2164`), `renderImageTasks()` (`:2197-2301`), `renderImagePagination()` (`:2303-2334`), `updateImageStatsUI()` (`:2166-2195`), `filterImagesCategoryAndShow()` (`:2339-2362`) | `GET /api/images/tasks?pageSize=60` + `/api/images/asset` |
| 18 | **Full-size image viewer + PNG download** | `openImageInStudio(task)` (`app.js:2367-2434`), `navigateStudioImage(offset)` (`:2685-2693`), buttons `#btn-studio-img-prev` / `#btn-studio-img-next` (`:2803-2804`) | `/api/images/asset` |
| 19 | **Release history browsing (Client / Assets)** | `loadReleases()` (`app.js:3516-3614`), `renderReleasesView()` (`app.js:3616-3701`), tab filtering (`:2736-2754`) | `/api/{client,assets}/releases` |
| 20 | **Cross-version reuse matrix** | summary fetch + writes at `app.js:3584-3607` | `/api/assets/releases/{v}/summary` |
| 21 | **Resource-row browser per release with cursor paging** | `loadSelector(channelId)` (`app.js:3493-3513`), `loadSelectorReleases()` (`:3202-3257`), `loadSelectorItems()` (`:3265-3283`), `fetchSelectorPage()` (`:3286-3337`), `renderSelectorItems()` (`:3358-3379`), `renderSelectorMore()` (`:3339-3349`), `loadMoreSelectorItems()` (`:3351-3356`), helpers `selectorChannel` (`:3150`), `selectorReleaseRef` (`:3162`), `selectorItemKey` (`:3176`), `selectorItemsUrl` (`:3181`), `selectorReleaseVersion` (`:3196`) | `/api/{channel}/releases/{ref}/items` |
| 22 | **Format/safety inspection of a translation (read-only lint)** | `checkTranslationFormat(source, translation)` (`app.js:248-331`) — `|`/`^` fatal check, `{$P$}`, `{0}`, `%s`, `<color>`/`<b>` pairing, `\n` + length warnings. Used by `validateTranslationInput()` (`:1672-1785`) which also drives `#format-validation-panel`, `#val-badge`, `#val-summary`, `#validation-details-list`, `#char-counter`. **Keep the lint and the panel; drop only the `btnSubmit.disabled` lines.** |
| 23 | **Copy-source / tag-skeleton helpers** | `copySourceToTranslation()` (`app.js:1596-1603`), `extractSkeleton()` (`:1605-1620`), `fixDelimitersInInput()` (`:1622-1633`) | local |
| 24 | **Toast feedback** | `showToast(msg, duration)` (`app.js:334-342`) | — |
| 25 | **HTML escaping** | `escapeHtml(str)` (`app.js:2713-2721`) and the duplicate in `resource_hub.js:9-16` | — |

---

## 5) CSS / RENDER DEPENDENCY NOTES

### 5.1 Stylesheet section map (`public/app.css`, 4410 lines / 476 unique class names)

| Line | Section banner |
| --- | --- |
| 1 | `:root` variables & reset (not annotated) |
| 44 | Header & Nav |
| 177 | Views Common |
| 200 | View 1: Lobby Stats Banner & Sidebar Layout |
| 233 | Lobby Hero Search (Top Positioned) |
| 278 | Sidebar Cards |
| 449 | Fallback for `stats-banner` if referenced |
| 577 | Domain Tabs & Fine-Grained Categorization |
| 631 | Category Cards |
| 752 | Lyrics Exclusive Showcase Section (432 Songs) |
| 959 | Search Box |
| 998 | Idols Section |
| 1029 | View 2: Studio (Modern Widescreen Dual-column Workbench) |
| 1117 | Studio Grid Layout |
| 1149 | Category-Tailored Studio Themes & Layouts |
| 1153 / 1267 / 1348 / 1390 / 1417 / 1438 | Lyrics / Chat phone / Story AVG / Card / Lounge / System UI modes |
| 1453 | Dedicated Lyrics Full-Track Studio |
| 1555 | Lyrics Table & Lines |
| 1690 | Chat & AVG dedicated containers |
| 1783 | AVG Story Theater |
| 1931 | Studio Status Toggle |
| 1964 | Existing Translation Comparison Box |
| 2009 | Format Validation Panel |
| 2097 | AI Config Modal Form |
| 2251 | Source Box |
| 2301 | Term Hints Bar |
| 2361 | Input Group |
| 2437 | Studio Actions |
| 2491 | Studio Sidebar Guides |
| 2592 | Tutorial Modal |
| 2825 | Toast |
| 2851 | App Footer |
| 2892 | User Status Pill & Logout Button |
| 2924 | View 4: Image Localization Showcase & Pipeline |
| 3158 | Image Pagination |
| 3195 | Image Localization Studio Modal |
| 3384 | Restored Texture Triplet Section |
| 3480 | View: Independent Client & Assets Releases & Reuse Matrix |
| 3604 | Unified resource hub |
| 3702 | Visual refresh: clearer hierarchy / MLTD stage palette |
| 3778 | Compact mode |
| 4046 | Studio Dedicated Layout E: Image Studio Workbench |
| 4157 | **GitHub proposal surfaces** (`portal-ui-flash-20260930`) |
| 4286 | Repository → version → resource selector (additive) |

### 5.2 Classes used **only** by deleted collaboration views — safe to remove

Verified as referenced exclusively from the write/review code paths:

- **Identity / auth:** `.user-status-pill` (`app.css:2895-2899`), `.logout-btn` (`:2901-2922`), `.gh-link-btn` (`:4193-4206`), `.gh-avatar` (`:4208-4214`), `.gh-login` (`:4216-4219`), `.role-tag` (used only in `renderUserInfo`, `app.js:485`).
- **PR result surfaces:** `.pr-result-link` and its `a` / `:hover` / `.is-warning` / `.pr-ci` variants (`app.css:4165-4191`).
- **Reviewer queue:** `.admin-proposal-list` (`:4228-4232`), `.admin-pr-card .admin-pr-row` (`:4234-4240`), `.admin-pr-card .pr-link` (`:4242-4250`), `.admin-pr-badge` + `.ci-success` / `.ci-failure` / `.ci-pending` / `.state-merged` (`:4252-4278`), `.admin-pr-missing` (`:4280-4284`). Emission notes: `.queue-card` (emitted at `app.js:2042`) has **no rule in `app.css` at all**; `.admin-pr-row` (`app.js:2070`), `.pr-link` (`:2071`) and `.admin-pr-missing` (`:2052`) are emitted as bare classes; `.state-merged` / `.state-open` and `.ci-success` / `.ci-failure` / `.ci-pending` exist only through template interpolation (`app.js:2072`, `:2074`) and therefore die with the reviewer card.
- **Image upload/restore half:** `.upload-dropzone`, `.dropzone-prompt`, `.dropzone-icon`, `.dropzone-sub`, `.dragover`, `.aspect-ratio-status` (+ `.match` / `.mismatch`), `.is-restore`, `.btn-run-restore`, `.btn-download-restored`, `.restore-success-alert`, `.restored`, `.restored-texture-section`, `.triplet-*`, `.img-studio-comparison-row`, `.img-studio-submit-row`, `.img-preview-col`, `.image-studio-body`, `.pipeline-icon`, `.pipeline-desc-box`, `.rhythm-meter-bar`, `.rhythm-stat`.
- **Selector binding panel (items 30):** `.selector-context`, `.selector-context-row` — only produced by `renderSelectorSelection()` (`app.js:3396-3405`). Keep `.selector-item`, `.selector-item-key`, `.selector-item-meta`, `.selector-items`, `.selector-more`, `.selector-layout`, `.selector-list-col`, `.selector-detail-col`, `.selector-toolbar`, `.selector-status`, `.selector-channel-note`, `.selector-col-header` if the browse half stays.

### 5.3 Classes that are **dead in the CSS only** (no HTML/JS producer)

Detected by cross-referencing every `.class` in `app.css` against `class="…"` literals in `index.html`, `app.js`, `resource_hub.js`. These have no producer today — remove or re-wire:

`.accepted .admin .All .candidate .canonical .categories-grid .chat-bubble-card .chat-reply-row .chat-source-row .context-lyric-row .context-tag .current .current-active .domain-toolbar .err .error .has-error .icon .is-empty .is-stale .lobby-domains-section .lyrics-context-stream .lyrics-hero-top .lyrics-meta-pills .lyrics-pill .lyrics-song-title-group .lyrics-song-zh .lyrics-studio-hero .not_needed .ok .producer .progress-container .progress-text .repo-info .repo-link .reviewer .search-hero-subtitle .show .sidebar-link-btn .ssot-actions-row .ssot-code .stat-item .stat-label .stat-val .stats-banner .stats-grid .status-candidate .status-canonical .status-published .status-toggle .story-line-card .superseded .superseded-badge .text .triplet-item .triplet-label .triplet-img-wrap .triplet-preview-grid .type-All .type-Angel .type-Fairy .type-Princess .untranslated .val-error .val-warn .validation-msg .warn`

Two of these matter for a re-implementation:

- **`.untranslated` / `.accepted` / `.not_needed` / `.restored`** are emitted only as *template-suffixed* classes (`class="lyric-status-badge ${st.class}"` at `app.js:1016`, `class="image-card-status-badge ${statusClass}"` at `app.js:2264`), so they **are** live — the bare-name detector misses them. Keep.
- **`.status-candidate` / `.status-canonical` / `.status-published`** are dead: `resource_hub.js:75` builds `status-${release.status}` dynamically, so they *are* reachable — keep.

### 5.4 Classes shared with read-only views — **must be kept**

- **Shell:** `.app-header`, `.header-container`, `.logo-group`, `.logo-badge`, `.logo-title`, `.nav-links`, `.nav-btn`, `.nav-github`, `.view-section`, `.active`, `.app-footer`, `.footer-*`, `.toast`, `.show`.
- **Lobby:** `.lobby-layout-wrapper`, `.lobby-main-column`, `.lobby-search-hero`, `.search-hero-header`, `.search-filter-box`, `.search-input`, `.search-select`, `.btn-primary`, `.btn-secondary`, `.section-title`, `.lobby-sidebar`, `.sidebar-card`, `.sidebar-card-header`, `.sidebar-badge`, `.live-badge`, `.candidate-badge`, `.canonical-badge`, `.superseded-badge`, `.sidebar-progress-box`, `.progress-bar-wrap`, `.progress-bar-fill`, `.progress-text-row`, `.pct-highlight`, `.sidebar-stats-grid`, `.stat-mini-tile`, `.stat-mini-val`, `.stat-mini-label`, `.release-info-table`, `.release-info-row`, `.rel-label`, `.rel-val-muted`, `.abi-tag`, `.schema-tag`, `.hash-short`, `.release-reuse-summary`, `.reuse-title`, `.reuse-grid`, `.reuse-pill.{exact,verified,suggested,blocked}`, `.release-status-note`, `.ssot-sidebar-card`, `.repo-banner`, `.repo-badge`, `.ssot-repo-info`, `.ssot-row`, `.ssot-label`, `.ssot-link`, `.quick-guide-card`, `.sidebar-guide-list`.
- **Resource hub:** every `.resource-*` class (`app.css:3604-3701`), `.resource-category-select`.
- **Category browsing:** `.domain-tabs`, `.domain-tab`, `.cat-card` + `.cat-*` children, `.cat-progress-wrap`, `.cat-progress-bar`, `.cat-btn` (**these need their DOM hooks `#categories-grid` / `#domain-tabs` reintroduced**).
- **Images (read half):** `.lobby-images-section`, `.image-header-card`, `.image-toolbar-row`, `.image-filters-right`, `.image-tasks-grid`, `.image-task-card`, `.image-card-thumb-wrap`, `.image-card-status-badge`, `.image-card-dim-badge`, `.image-card-content`, `.image-card-header`, `.image-card-category-tag`, `.image-card-bundle`, `.image-card-title`, `.image-card-actions`, `.btn-card-action`, `.image-pagination`, `.page-btn`, `.img-display-frame`, `.img-res-badge`, `.img-col-header`, `.img-col-actions`, `.col-title`, `.btn-download-img`, `.img-guide-note`, `.studio-image-*` (hero/header/grid/card), `.stat-count-pill`, `.dot`.
- **Lyrics:** `.lyrics-section`, `.lyrics-header-card`, `.lyrics-header-info`, `.lyrics-badge`, `.lyrics-stat-pill`, `.lyrics-toolbar`, `.lyrics-dedicated-hero`, `.lyrics-dedicated-meta`, `.lyrics-dedicated-titles`, `.lyrics-dedicated-title-zh`, `.lyrics-dedicated-specs`, `.lyrics-dedicated-actions`, `.lyrics-lines-container`, `.lyrics-lines-table-header`, `.lyrics-lines-list`, `.filter-pills`, `.filter-pill`, `.song-type-tag` + `.Princess`/`.Fairy`/`.Angel`/`.All`, `.songs-grid`, `.song-card`, `.song-card-header`, `.song-title-group`, `.song-title-ja`, `.song-title-zh`, `.song-preview-snippet`, `.preview-ja`, `.preview-zh`, `.song-meta-line`, `.song-progress-text`, `.song-open-btn`, `.type-tabs`, `.type-tab`, `.col-slot`, `.col-ja`, `.col-zh`, `.col-status`, `.col-action`, `.lyric-line-row`, `.lyric-inline-input`, `.lyric-meter-hint`, `.lyric-status-badge`.
- **Studio reading half:** `.studio-container-wide`, `.studio-top-nav`, `.back-btn`, `.studio-context`, `.badge.{category,idol}`, `.studio-mode`, `.index-pill`, `.studio-status-toggle`, `.status-toggle-btn`, `.btn-tutorial-pill`, `.studio-dedicated-layout`, `.studio-grid-layout`, `.studio-card`, `.main-workbench`, `.workbench-header`, `.source-speaker`, `.speaker-avatar`, `.speaker-meta`, `.speaker-name`, `.speaker-bundle`, `.workbench-quick-actions`, `.btn-mini`, `.studio-mode-banner`, `.source-box-wrap`, `.box-label`, `.term-click-tip`, `.source-box`, `.term-highlight`, `.term-hints-bar-wrap`, `.term-hints-title`, `.term-hints-bar`, `.hint-chip`, `.chip-color-dot`, `.zh-target`, `.fill-action`, `.existing-trans-box-wrap`, `.existing-title`, `.existing-status-badge`, `.existing-trans-box`, `.studio-actions`, `.studio-sidebar-col`, `.guide-card*`, `.guide-item`, `.guide-tag-badge`, `.glossary-quick`, `.guide-count`, `.quick-terms-list`, `.quick-term-item`, `.q-ja`, `.q-arrow`, `.q-zh`.
- **Validation panel (keep for read-only lint):** `.format-validation-panel` + `.is-ok` / `.is-warning` / `.is-error`, `.validation-status-row`, `.val-badge` + `.val-ok`, `.val-summary`, `.validation-details-list`, `.val-detail-item.error-item`, `.val-detail-item.warn-item`, `.char-counter`, `.trans-textarea`, `.input-group`, `.input-header`, `.input-label`, `.input-tools`, `.btn-text-tool`.
- **Selector browse half:** see §5.2.
- **Releases view:** `.release-banner-card`, `.release-banner-icon`, `.release-banner-content`, `.releases-dual-grid`, `.release-col`, `.release-col-header`, `.release-cards-list`, `.release-item-card`, `.release-item-header`, `.release-title-group`, `.release-item-meta`, `.meta-field-row`, `.meta-field-label`, `.reuse-matrix-card`, `.reuse-matrix-desc`, `.matrix-grid`, `.matrix-tile`, `.tile-header`, `.tile-badge`, `.tile-count`.
- **`.admin-review-note`** is **shared**: it styles the explanatory paragraph in both `#view-reviewer` (`index.html:756`) and `#view-selector` (`:775`). If the reviewer view is deleted, keep the rule for the selector, or replace the class on the selector paragraph.

### 5.5 Inline scripts, load order and expected globals

**Inline scripts / inline handlers:** there are **none**. `index.html` contains exactly three `<script src=…>` tags (`:1023-1025`), no `<style>` block, and no `on*=` attributes — **except** one inline handler generated by JS:

```js
// app.js:2266 — image thumbnail fallback
onerror="this.src='data:image/svg+xml,…暂无预览…'"
```

That is the only inline JS in the whole UI; a re-implementation should replace it with a real `onerror` listener (a strict CSP would break it).

**Script load order (`index.html:1023-1025`) — order matters:**

1. `github-contribution.js` — must run first: it defines `window.MLTDContribution`, read by `app.js:429` at module-evaluation time into the `contributionApi` const. If it fails to load, every write path fails closed (`app.js:443-456`).
2. `app.js` — IIFE (`app.js:2`), registers `DOMContentLoaded → init` (`app.js:3712`), also registers the three `portal:*` listeners at top level (`app.js:3080`, `:3085`, `:3096`).
3. `resource_hub.js` — IIFE, registers its own `DOMContentLoaded → init` (`resource_hub.js:183`). Registered **after** `app.js`, so on `DOMContentLoaded` `app.js:init()` runs first and `resource_hub.js:init()` second. Because `init()` is `async` and awaits `checkUser()`/`loadTerms()`/`loadStats()`, the hub's synchronous `loadResourceHub()` call (`resource_hub.js:179`) actually *starts* first in wall-clock terms; the manifests then arrive via the `portal:resource-manifests` event (`resource_hub.js:122-123` → `app.js:3080-3083`).

**Global objects the page expects / publishes:**

| Global | Written by | Read by | Notes |
| --- | --- | --- | --- |
| `window.PORTAL_DEFAULT_ASSET_VERSION` | **nobody** | `app.js:5` (`DEFAULT_PORTAL_ASSET_VERSION`) | The worker only reads the *env var* of the same name (`src/release_registry.js:52`); no HTML/page code ever sets the browser global, and `DEFAULT_PORTAL_ASSET_VERSION` itself is never used after assignment. **Dead constant.** |
| `window.MLTDContribution` | `github-contribution.js:231` | `app.js:429` | Collaboration write-form builders. |
| `window.__portalResourceHub` | `resource_hub.js:180` | — (nothing reads it) | Test/debug handle. |
| `window.__portalResourceManifests` | `resource_hub.js:122` | via the event, `app.js:3081` | `{assets, client}` manifest cache. |
| `window.__portalPendingResourceCategory` | `resource_hub.js:94`, cleared `:147`, `:156`, `:163` | `resource_hub.js:154` | Cross-module hand-off for "open this category". |
| `window.__portalTestHooks` | `app.js:3718` | `test_frontend_github.mjs:299` | 20 members (§3 item 31). |
| `portal:resource-manifests` event | `resource_hub.js:123` | `app.js:3080` | payload `{assets, client}`. |
| `portal:resource-category` event | `resource_hub.js:155` | `app.js:3085` | payload `{channel, category, entry}`. |
| `portal:open-domain` event | `resource_hub.js:146`, `:153` | `app.js:3096` | payload `{domain}`. |

**localStorage / sessionStorage keys:** `mltd_ai_config` (AI config, `app.js:129`), `mltd_terms_v2` (terms+idols cache, `app.js:548`/`:564`, cleared at `:503`), `mltd_studio_session` (studio queue resume, `app.js:1162`, cleared `:1309`/`:3487`).

---

## 6) STATE MACHINE — the `state` object

`const state = {…}` is declared once at `app.js:7-69`. Four further members are created at runtime without being declared — flagged below.

| Key | Declared | Holds | Written by | Path |
| --- | --- | --- | --- | --- |
| `currentView` | `:8` | `"lobby"` \| `"studio"` \| `"releases"` \| `"reviewer"` \| `"selector"` | `switchView()` `:346` | **READ** (navigation) |
| `user` | `:9` | `null` \| `{login, email, github_user_id, role, via}` | `checkUser()` `:517`, `:529-530`; `handleLogout()` `:506` | **WRITE** (identity) |
| `terms` | `:10` | `term[]` — `{source, target}` | `loadTerms()` `:551`, `:561` | **READ** |
| `idols` | `:11` | idol map/array — `{code, name_ja, name_zh, color, type}` | `loadTerms()` `:552`, `:562` | **READ** |
| `stats` | `:12` | normalised `/api/stats` payload (`total, accepted, pending, contributors, progress_percent, untranslated, categories, by_idol`, plus `release_id, asset_version, summary_updated_at, summary_stale, source`) | `loadStats()` `:588-599` | **READ**. Note `stats.categories` is stored but never rendered — `renderCategoriesGrid` uses `state.resourceManifests` instead |
| `activeDomain` | `:13` | `"all"` \| `"images"` \| `"lyrics"` \| a manifest domain id | `activateLobbyDomain()` `:648`; `filterImagesCategoryAndShow()` `:2340` | **READ** (section filter) |
| `activeResource` | `:14` | `"all"` \| `"assets"` \| `"client"` | `renderCategoriesGrid()` `:745`; random button `:2918`; `portal:resource-category` `:3087` | **READ** (channel scope) |
| `resourceManifests` | `:15` | `{assets: manifest\|null, client: manifest\|null}` | `portal:resource-manifests` listener `:3081` | **READ** |
| `songsCatalog` | `:18` | `song[]` \| `null` | `loadSongsCatalog()` `:786` | **READ** |
| `songsError` | `:19` | `string` \| `null` | `:776`, `:787`, `:791` | **READ** |
| `activeSongType` | `:20` | `"all"` \| `"Princess"` \| `"Fairy"` \| `"Angel"` \| `"All"` | song-type tab handler `:2883` | **READ** |
| `songFilterKeyword` | `:21` | free text | `#search-song-keyword` handler `:2892` | **READ** |
| `sessionSongLyricsCache` | `:22` | `{ [bundle]: line[] }` | `startLyricsStudio()` `:917` | **READ** (per-session cache) |
| `studioQueue` | `:25` | `row[]` — the current reading/editing queue | `startStudioWithFilter()` `:1193`, `:1273`; `startLyricsStudio()` `:890`, `:918`; `openSelectorContextInStudio()` `:3483` | **READ queue, WRITE target** — its rows are what the submit path mutates |
| `studioIndex` | `:26` | cursor into `studioQueue` | `:1194`, `:1205`, `:3050`, `:3074`, `:3484` | **READ** (pagination) / write-adjacent (skip) |
| `currentItem` | `:27` | the row under the cursor | `renderCurrentStudioItem()` `:1315`; `openSelectorContextInStudio()` `:3485`; **mutated by the submit path** `:2003-2006` (`translation`, `status="proposed"`, `pr_url`, `pr_number`) | **HYBRID — read for display, written on submit** |
| `currentMode` | `:28` | `"standard"` \| `"lyrics"` \| `"chat"` \| `"story"` \| `"card"` \| `"lounge"` \| `"system"` | `detectStudioMode()` result `:1281`, `:1318`; `startLyricsStudio()` `:886` | **READ** (presentation switch) |
| `currentSongMeta` | `:29` | song object from the catalogue | `startLyricsStudio()` `:885`; cleared `:1175`, `:3482` | **READ** |
| `activeLyricLineFilter` | `:30` | `"all"` \| `"untranslated"` \| `"pending"` | filter-pill handler `:2859` | **READ** |
| `currentFilter` | `:31-36` | `{category, idol, keyword, status}` | `startStudioWithFilter()` `:1174`; status fallback `:1237`, `:1253`, `:1266`; reset `:3486` | **READ** (query) — the fallback writes are query correction, not user data |
| `images.tasks` | `:40` | `[]` | **never written** — `allImageTasksCache` (`:2112`) is the real store | **DEAD key** |
| `images.categories` | `:41` | `{all, event, costume, tutorial}` (+ any server key) | `loadImageTasks()` `:2140` | **READ** |
| `images.total` | `:42` | number | `:2141` | **READ** (unused for rendering) |
| `images.page` | `:43` | current page (1-based) | pagination handlers `:2321`, `:2329`; resets `:2772`, `:2779`, `:2790` | **READ** |
| `images.pageSize` | `:44` | `12` | — | **READ** (client page size; the server page size is the separate `IMAGE_TASK_PAGE_SIZE = 60`, `:2114`) |
| `images.status` | `:45` | `"all"` \| `"untranslated"` \| `"not_needed"` \| `"restored"` \| `"accepted"` | `#filter-img-status` handler `:2779` | **READ** — note `restored` is a retired write-path status |
| `images.category` | `:46` | `"all"` \| `"event"` \| `"costume"` \| `"tutorial"` | tab handlers `:2771`, `:2354` | **READ** |
| `images.search` | `:47` | free text (200 ms debounce, `:2785-2792`) | `:2789` | **READ** |
| `images.currentTask` | `:48` | the image task in the studio | `openImageInStudio()` `:2369`; **mutated on submit** `:2661-2662` | **HYBRID** |
| `images.uploadedImageBase64` | `:49` | `data:` URL of the upload | `handleStudioImageFile()` `:2495`; cleared `:2370`, `:2437` | **WRITE** |
| `images.uploadedImageObj` | `:50` | decoded `Image` | `:2499`; cleared `:2371`, `:2438` | **WRITE** |
| `images.statuses` | *(not declared)* | — | **never assigned**; read speculatively at `:2174` (`state.images.statuses?.not_needed`) | **DEAD reference** |
| `selector.channel` | `:58` | `"assets"` \| `"client"` | `loadSelector()` `:3495` | **READ** |
| `selector.ref` | `:59` | release id or version used in item URLs | `:3276`, `:3496` | **READ** |
| `selector.release_id` | `:60` | the id the *service* answered with | `:3277`, `:3318`, `:3497` | **READ** |
| `selector.items` | `:61` | `item[]` | `:3267`, `:3319`, `:3500` | **READ** |
| `selector.next_cursor` | `:65` | opaque server cursor | `:3269`, `:3322`, `:3498` | **READ** (paging) |
| `selector.has_more` | `:66` | boolean | `:3270`, `:3323`, `:3499` | **READ** (paging) |
| `selector.selected` | `:67` | the trusted edit context (`{editable, github{target,path,base_commit}, row_kind, asset_version, client_version, source, translation, …}`) | `:3268`, `:3423`, `:3448`, `:3501` | **WRITE-adjacent** — exists only to authorize a submission |
| `csrfToken` | *(not declared)* `:508`, `:519`, `:531` | CSRF token string | `checkUser()`; cleared `handleLogout()` | **WRITE** |
| `githubIdentity` | *(not declared)* `:468`, `:472`, `:507`, `:518`, `:528` | `/api/auth/github/me` payload `{authenticated, login, email, github_user_id, role, csrfToken}` | `checkUser()`; cleared `handleLogout()` | **WRITE** |
| `access` | *(not declared)* `:520`, `:532` | `{authenticated, via}` | `checkUser()` | **WRITE** (identity, never read anywhere) |

**Module-scope (non-`state`) mutable variables:** `lastStatsFetchTime` + `STATS_CACHE_DURATION` (`:542-543`, read throttle), `allImageTasksCache` (`:2112`, the real image task store), `selectorRequestSeq` (`:3148`, stale-response guard), `contributionApi` (`:429`), `IMAGE_RATIO_TOLERANCE` (`:436`), `SELECTOR_CHANNELS` (`:3120`), `SELECTOR_PAGE_SIZE = 100` (`:3142`), `ADMIN_CI_LABELS` (`:2032`), `AI_CONFIG_KEY` / `DEFAULT_AI_CONFIG` / `AI_PRESETS` (`:129-158`), `SUBMIT_ERROR_TEXT` (`:80`), `IMAGE_TASK_PAGE_SIZE = 60` (`:2114`), `DEFAULT_PORTAL_ASSET_VERSION` (`:5`, dead).

**Read-path summary:** 25 of the declared keys are pure read/filter/pagination state (`currentView`, `terms`, `idols`, `stats`, `activeDomain`, `activeResource`, `resourceManifests`, `songsCatalog`, `songsError`, `activeSongType`, `songFilterKeyword`, `sessionSongLyricsCache`, `studioIndex`, `currentMode`, `currentSongMeta`, `activeLyricLineFilter`, `currentFilter`, `images.categories`, `images.total`, `images.page`, `images.pageSize`, `images.status`, `images.category`, `images.search`, `selector.{channel,ref,release_id,items,next_cursor,has_more}`).
**Write-path summary:** `user`, `csrfToken`, `githubIdentity`, `access`, `images.uploadedImageBase64`, `images.uploadedImageObj`, `selector.selected`, plus the write-back mutations on `currentItem` and `images.currentTask`.

---

## 7) READ-ONLY FEATURES NOT FULLY MAPPED TO A DATA SOURCE

These are consumed by rendering code but never served by the current API. A static re-implementation must
either drop them or add the field to its data files.

| Feature / element | Where consumed | Why it is unmapped |
| --- | --- | --- |
| **Song preview snippet** `🇯🇵 preview_ja / 🇨🇳 preview_zh` | `app.js:829-831` (search haystack) and `:862-867` (`.song-preview-snippet` render) | `GET /api/lyrics/songs` emits only `bundle, asset, name_ja, name_zh, type, mst_song_id, slots, translated, release_id` (`src/worker.js:1274-1284`). No `preview_*` field exists anywhere in `src/`. The snippet therefore never renders today. |
| **Song BPM pill** `#lyrics-dedicated-bpm` | `app.js:955` — `BPM ${song?.bpm \|\| 170}` | `bpm` is not in `SONG_MASTER` (`src/worker.js:1139`: `bundle, mst_song_id, name_ja, name_zh, type`) nor in the songs response. Always the literal `170`. |
| **Lyric slot total pill `#lyrics-count-slots`** | `index.html:158` — hard-coded `12,131 槽位` | No JS writer at all (confirmed absent from the "ids never referenced by JS" scan). Pure markup fiction. |
| **Lyric mapping rate pill `#lyrics-count-rate`** | `index.html:160` — hard-coded `100% 映射` | Same: no writer. |
| **`#lyrics-domain-count`** | `app.js:817-818` writes it | The element does not exist in `index.html`, so the write silently no-ops. |
| **Contributor count `#stat-contributors`** | `app.js:612` reads `state.stats.contributors` | None of the three `/api/stats` branches serves `contributors` (`src/worker.js:336-374` GitHub path, `:419-443` `portal_summary` path, `:461-487` `release_summaries` path). Renders `0` unless a `portal_summary` row happens to carry it. |
| **Image card title `task.description`** | `app.js:2266` (`alt`), `:2273` (`.image-card-title`), `:2404` (`#studio-img-task-title`) | The D1 query selects `task_id, bundle, category, width, height, image_format, has_alpha, r2_key, source_sha256` (`src/worker.js:2957`) — no `description`. Only the static-manifest path (`getStaticImageTasks`, `src/worker.js:2866-2901`, reading `public/data/image_tasks.json`) carries `description`, and that file lives in `local-data/retired-source/…` (1,109 tasks, keys `task_id, bundle, category, category_name, width, height, status, has_restored, description, prepared_image, restored_image, model_image`). |
| **Image card category label `task.category_name`** | `app.js:2270` (`.image-card-category-tag`), `:2390` (`#studio-category-badge`) | Same split as above: `category_name` exists only in the static manifest, never in the D1 `SELECT`. |
| **Category card grid `#categories-grid` + domain tabs `#domain-tabs`** | `renderCategoriesGrid()` `app.js:673-752`, `activateLobbyDomain()` `:646-671`, `.cat-card` CSS `app.css:631-751` | The *data* is available (`manifest.categories[]`, `manifest.domains[]` via the resource-hub event), but **the DOM targets are missing from `index.html`** — every lookup is null-guarded so the grid silently never renders. A static rebuild must reintroduce the markup to use the taxonomy. |
| **`#view-releases` reachability** | `loadReleases()` / `renderReleasesView()` | No nav button (`#nav-releases` absent) and the only programmatic entry, `resource_hub.js:166`, requires a `[data-resource-entry="releases"]` button that does not exist. Data source is present; only navigation is broken. |
| **Dedicated chat layout `#studio-chat-layout` / `#chat-messages-stream` / `#chat-contact-avatar` / `#chat-contact-name`** | Only ever force-hidden (`app.js:930`, `:1328`, `:2378`) | Never populated by any renderer; the chat *look* is produced inside `#studio-standard-layout` by `renderStudioModeBanner` (`app.js:1443-1463`). Dead markup with no data source. |
| **Dedicated story layout `#studio-story-layout` / `#story-dialogue-stream` / `#story-scene-bundle`** | Only force-hidden (`app.js:931`, `:1329`, `:2379`) | Same as above; the AVG look lives in `renderStudioModeBanner` (`app.js:1464-1476`). |
| **Idol badge / speaker from `item.idol.type`** | Not rendered | `type` (`"Guest"`, from `src/worker.js:292`) is delivered but no renderer reads it. |
| **Idol taxonomy per-face** | `state.stats.by_idol` / `state.stats.idols` (`app.js:598`) | Populated but never rendered anywhere. |

Additional structural unknowns worth flagging for the rebuild: the `.queue-card` class emitted by
`renderGithubProposalCard` (`app.js:2042`) has **no CSS rule**; `#btn-open-tutorial`, `#btn-close-ai-modal`,
`#btn-save-ai-config`, `#btn-ai-quick-polish`, `#nav-studio`, `#nav-images`, `#validation-msg`,
`#studio-status-tabs` are all bound in `setupEventListeners()` but absent from `index.html` (null-guarded
no-ops); and `#btn-toggle-context` (`index.html:432`), `#btn-tutorial-ok` (`:949`), `#ai-custom-prompt`
(`:1008`), `#ai-test-result` (`:1011`), `#validation-status-row` (`:492`), `#studio-speaker-wrap` (`:422`),
`#studio-img-restore-frame` (`:623`), `#resource-hub-grid` (`:68`), `#card-client-release` (`:219`),
`#card-assets-release` (`:246`) exist in markup but are never touched by JS.
