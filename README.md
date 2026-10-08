# MLTD translation contribution portal

本目录是 `text-localization` 的 serverless 候选协作门户，保留 Cloudflare Worker、D1、R2 与 Worker Static Assets；它不直接写生产翻译队列、NAS 或 APK。

贡献者通过 GitHub OAuth 登录，使用服务端 Portal 会话提交 source-bound 单行/槽位修改或普通图片提案。fork、branch、commit、PR 使用该用户的 GitHub 授权；最终审核在 GitHub 完成，D1 只作查询索引和提案状态镜像。后台不提供独立 accept/publish 权力。

会话使用随机 HttpOnly cookie，D1 只保存 HMAC token hash；GitHub token 由 `USER_TOKEN_KEY` 加密托管。读写授权均不信任未校验的 `Cf-Access-Authenticated-User-Email`。写请求校验 Origin 与 CSRF，登出为受保护 POST；明文 token、API key、构建/签名及 NAS 凭据不能进入本目录。当前部署与外部验收状态以 stream STATE 和 run HANDOFF 为准，不能从本地测试推断已上线。

## Local setup

1. Create a D1 database and bring it to the current schema:
   `python web/translation-portal/scripts/bootstrap_portal_d1.py --db local_portal.db`
   applies [`schema.sql`](schema.sql) and every file in [`migrations/`](migrations/)
   in order, recording each file's SHA-256 in `schema_migrations` so a re-run
   skips what is already applied. Do not apply migrations by hand:
   `ALTER TABLE … ADD COLUMN` is not replayable, and a half-applied database is
   the one state nothing else can detect.

   **Local and remote keep two different ledgers, and they have not been
   reconciled.** `bootstrap_portal_d1.py` records into `schema_migrations`;
   `npx wrangler d1 migrations apply` records into wrangler's own
   `d1_migrations`. Neither knows about the other's rows, so a database
   migrated by one and inspected by the other will look un-migrated. The remote
   migration path is therefore still an open decision — treat it as a reviewed
   release step, not as a command to run, until the ledger identity is settled.

   **The script classifies before it touches anything, and refuses what it
   cannot manage.** `--status`, `--inspect` and `--dry-run` open the database
   read-only; `--status` never creates the ledger table (a probe that writes a
   ledger into the database it is inspecting answers "was this bootstrapped?"
   with the act of asking). The write path classifies on a read-only handle
   *first* and refuses before opening anything read-write, so a refusal cannot
   leave a journal file behind. `--dry-run` classifies first too: producing a
   plan to write to a database this script must not write to would be a plan
   nobody should run.

   | state | meaning | exit | write / dry-run |
   | --- | --- | --- | --- |
   | `managed-current` | ledger intact, every file recorded (schema.sql included), objects present | 0 | allowed |
   | `fresh` | no ledger, no portal objects | 2 | allowed |
   | `pending` | ledger intact, some file not yet recorded (schema.sql included) | 2 | allowed |
   | `foreign-unmanaged` | a `d1_migrations` ledger, or portal objects with **no or an empty** ledger | 3 | **refused** |
   | `hash-mismatch` | a recorded file does not hash to what was recorded (an empty hash counts) | 4 | **refused** |
   | `ledger-ahead` | the ledger claims a file whose objects are absent | 5 | **refused** |

   Only `managed-current` is "ready"; `fresh` and `pending` are manageable but
   not current, so they share exit 2 and are not success codes. `--baseline`
   records a file as applied without executing it only when the database shows
   a mark that file itself left (a seeded row); a file with no such mark is
   refused, and there is deliberately no flag to override that.

   In practice `local_portal.db` classifies as `foreign-unmanaged` (exit 3):
   it has tables but no `schema_migrations`, so this script declines both the
   write and the plan. Adopting it is a reviewed migration decision, not a
   command-line flag.
2. Copy [`wrangler.toml.example`](wrangler.toml.example) to a local
   `wrangler.toml`, then fill in only local resource identifiers. The canonical
   file is [`wrangler.jsonc`](wrangler.jsonc); `npm run deploy` reads it.
3. 配置 GitHub OAuth 的 `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET`，并使回调 URL 与 `PORTAL_CANONICAL_ORIGIN` 一致。普通贡献者不依赖 Access 账号；未验证的代理/email 头不授予任何权限。
4. 用受保护的部署 Secret 配置 `USER_TOKEN_KEY`（32字节，hex/base64）与 `SESSION_PEPPER`。`ADMIN_GITHUB_LOGINS` / `REVIEWER_GITHUB_LOGINS` 仅是角色提示，不授予仓库访问权：后台必须以当前用户 token 核对 GitHub 身份及各目标仓库的 `admin` / `maintain` 布尔权限（只有 `push` 的写协作者不获后台访问权）。缺托管 key 或不能验证权限时拒绝，不回退共享 bot。
5. 配置两仓 `GITHUB_TARGET_ASSETS` / `GITHUB_TARGET_CLIENT`、各自默认分支、`GITHUB_CLIENT_MANIFEST_PATH`（当前已核对为 `manifests/bottom-bar.manifest.json`）。Webhook/sync/图片源的凭据与标识继续通过受保护变量提供，不写进 Git。
6. 部署 Worker、Static Assets 与迁移必须分别验证；下述本地测试不代表远端 D1、OAuth 或发布已完成。

离线检查使用内存 D1/R2 与严格 GitHub mock：`test_worker.mjs`、`test_sync.mjs`、`test_github_collab.mjs`、`test_github_session.mjs`、`test_frontend_github.mjs`、`test_config.mjs`、`test_image_ratio.mjs`。会话测试包含未验证头部拒绝、Origin/CSRF、撤权、加密托管、单行修改与旧写入口410；`test_worker.mjs` 覆盖双轴单一源解析的跨路径一致性（列表/详情/编辑上下文同一 commit、旧 ref 不回读最新 manifest、错 target、缺 pin、缺 summary、配额不伪装空表）；`test_github_session.mjs` 覆盖同 commit 贯穿分支/钉住读取/PR 记录与过期 commit、错 target 不触达写路径。前端测试不能替代真实浏览器检查。

旧 snapshot 消费/导出脚本只用于隔离迁移和历史追溯，不是网页审核/发布入口。不能用 D1 的旧 `accepted` 状态绕过 GitHub PR 权威。新提案只走 GitHub 分支与 PR，不创建 R2 发布快照，不写 NAS 或 APK。

## HTTP contract

- `GET /api/health`：公开存活检查。
- `GET /api/auth/github/login` / `callback`：GitHub OAuth；state 一次性并绑定浏览器。
- `GET /api/auth/github/me`：已验证会话的身份、角色与 CSRF token；匿名401。
- `GET /api/me`：同一会话的兼容身份读取，不信任原始 Access 头。
- `POST /api/auth/github/logout`（兼容 `/api/logout`）：校验会话、Origin、CSRF后撤销；GET返回405。
- `GET /api/{assets,client}/releases`、`/:ref/items`、`/:ref/item`：独立版本轴及有界分页；ref可为release id或该轴的版本。
- `GET /api/{assets,client}/releases/:ref/{manifest,summary,items,item,item/edit-context}`：同一 ref 经单一源解析（`releaseSourceForRef` / `releasePinnedCommit`）得到同一身份与同一 commit —— CI manifest 只回答它自己名下版本；旧 ref 一律由 D1 历史行回答，绝不返回最新数据；pin 不是 commit 的 manifest 不交出任何可编辑绑定（items 回退 D1、edit-context 404）。列表/详情/编辑上下文三处的 `github.base_commit` 必然一致。
- `GET /api/resources/:id/edit-context`：可信 `github={target,path,base_commit,source_sha256}` 及行/槽上下文。
- `POST /api/contributions/github-pr`：平铺单行/槽位编辑请求；不接受整文件 `content` 回退。服务端固定commit读源、检查blob SHA和源hash后，仅改指定行/槽。
- `POST /api/images/submit`：Assets图片提案；必须有目标/路径/版本/pin/原图hash绑定，通过普通图片格式与整数交叉乘法的精确比例门禁，允许同比例更高分辨率；不在Portal回填Unity。缺可信来源的Client图片明确拒绝。
- `GET /api/admin/contributions` / `GET /api/queue`：同一只读权限入口；验证当前用户对目标 GitHub 仓库的实际维护权限，按获授权仓库查询，不能跨仓查看或用本地名单绕过。D1 状态不构成独立审核结论。完整 diff/CI/图片详情接线仍须单独验收，不能显示虚构 PASS。
- 图片列表、详情与资源重定向接口保留为读接口；其源码绑定和生产数据导入完成度见STATE。不能从旧列表字段自行猜提交路径。
- **已退役（410）**：`POST /api/contributions`、`POST /api/reviews/:id`、`POST /api/publish`、`POST /api/images/status`、`POST|PATCH /api/images/restore`。历史数据保留，不能从旧文档重新启用写入口。

## Image localization surface

The image-task index is generated by CI at `public/data/image_tasks.json` and published as a read-only static fallback. The Worker uses it when D1 has no materialised image rows, then overlays any `image_status_overrides` rows that are available. Tasks that never entered `image-edit-queue.jsonl` carry no Japanese text and default to `not_needed`; everything else starts as `untranslated`.\r\n\r\nHuman decisions never rewrite the task rows: the Worker overlays the
`image_status_overrides` table (migration
[`migrations/0003_image_status_overrides.sql`](migrations/0003_image_status_overrides.sql))
at read time. The listing endpoint seeks the override for each id on the page
(primary-key lookups, no table scan) and `/api/images/status` is the one route
that reads the whole table, because "give me every override" is what it is for.

Category totals come from the derived `portal_summary['image_categories']` row
(`{counts, total, truncated}`) that the importer writes while it is already
walking every task, so a request never runs `COUNT`/`GROUP BY`. When the row is
absent the API returns `categories: null` and `total: null` rather than a
fabricated zero; when the import was bounded by `--limit` the roll-up carries
`counts_truncated: true`.

The regenerate → publish sequence is: apply any pending migration, run the
importer, deploy the worker.

Image bytes themselves are **not** served by this worker: `/api/images/asset`
redirects to `IMAGE_ASSET_BASE`, and the four object families
(`images/composite|restored|original|task/`) live in the R2 bucket
`mltd-translation-candidates`, published at `pub-mltd-assets.nyaneko.cn`.
`scripts/upload_image_assets_to_r2.py` is the only uploader; pass
`--skip-existing` when re-running (the Cloudflare REST API throttles at roughly
3 req/s with error 971). Both R2 scripts take the account id, bucket, database
id and token path from flags, the environment (`CLOUDFLARE_ACCOUNT_ID`,
`R2_BUCKET`, `D1_DATABASE_ID`, `CLOUDFLARE_API_TOKEN`) or the uncommitted
`private/r2-upload.json`; nothing is compiled in, the token is never logged, and
a missing credential is a hard exit rather than a guess.

旧 R2 restore 队列及公开仓的 `backfill-image.yml` 属于历史通道；本地退役写接口不会自动停掉远端旧 cron。新流程应由 GitHub PR 合并后触发 Assets CI，依次完成缩放、源绑定注入、独立审计和 generated CAS 发布；具体工具与输入契约见中心仓 `docs/ASSETS_GENERATED_CI.md`。未完成真实输入与CI接线前，不得将历史队列冒充新流程。

每个新提案使用单一版本轴（`client_version` 或 `asset_version`）、精确文件/行位置、基线commit与源SHA；D1只记录镜像和操作审计，不提供第二个审核权威。

## GitHub Repository Integration

The translation portal acts as the interactive review and contribution surface for
the community-maintained GitHub repository:
**[kohakunamori/MLTDTranslationAssets](https://github.com/kohakunamori/MLTDTranslationAssets)**.

That repository carries only the surfaces the asset server can deliver
(`locales/`, `lyrics/`, `glossary/`, `manifests/images.manifest.json`). The APK
built-in surfaces (bottom-bar atlas, runtime BI text, CJK font) live in the
sibling repository
[MLTDTranslationClient](https://github.com/kohakunamori/MLTDTranslationClient)。门户按Client自己的commit读取可编辑manifest，当前底栏是`slots[index]`适配；缺少可编辑源的其他内置面不能从二进制索引推造译文。

### LLM 自动并入流程

Assets 的 LLM 草稿由 `MLTDTranslationAssets` 的 GitHub-hosted Linux Actions
运行，API key 只存在于 Actions secret，Portal 不接触 provider 凭据，也不在
浏览器中直接调用模型。每次成功运行会把结果直接提交到 Assets 默认分支，
只使用 `translation_stage=llm_translated` 标记；`status=pending` 仍表示尚未
人工确认。Portal 通过 GitHub 同步显示这些提交，维护者发现问题后直接修正，
不把 LLM 结果冒充为 `human_translated`。

### 1. Ingest Accepted GitHub Translations into D1
To synchronize existing accepted translations from the GitHub repository into the
portal's D1 database (populating `contributions` with `status='accepted'`):
```bash
python scripts/sync_github_to_portal_catalogue.py \
  --repo-root build/runs/text-localization/9.0.200/github-export-candidate \
  --out-dir work/d1-contributions-sync \
  --batch-size 3000
```
Then execute the generated SQL batches against D1:
```bash
npx wrangler d1 execute mltd-translation-portal --file=work/d1-contributions-sync/contributions-batch-0001.sql
```

### 2. 历史 Portal Snapshot 离线迁移（不是当前网页提交流程）

以下工具只用于在隔离目录核对历史 R2 JSONL；新Portal不再生成该类审核快照。任何迁移结果仍应走GitHub PR，不得把旧D1状态直接提升为正式译文：
```bash
python scripts/sync_portal_snapshot_to_github.py \
  --snapshot path/to/snapshot.jsonl \
  --repo-root build/runs/text-localization/9.0.200/github-export-candidate
```
This performs source SHA-256 verification, control delimiter filtering (`|` and `^`),
updates `zh`, sets `status='accepted'`, and timestamps the updated lines.

## What is no longer a runtime source

Three generated snapshots used to be imported by `src/worker.js` and are now
gone from the runtime. The Worker reads release state from D1 only, and
`test_config.mjs` fails the suite if any of these names reappear in a runtime
file (comments are stripped before the scan, so prose about them is fine):

- **`src/hot_catalogue.js`** (`HOT_CATALOGUE`, `HOT_ASSET_VERSION`,
  `HOT_BASE_VERSION`) — a 3.7 MB module holding every untranslated row plus the
  asset version it was generated for. A frozen copy of release state in the code
  bundle: a new release could not change it, and it decided which version was
  writable by existing. Categorical browsing now seeks D1 with a bounded scan.
- **`src/songs_catalog.js`** (`SONGS_CATALOG`) and `src/stats_snapshot.js`
  (`DEFAULT_STATS`) — a songs list with per-song `slots`/`translated` counts and a
  lobby statistics blob, both generated at build time and stale the moment a
  review was accepted.
- **`public/data/image_tasks.json`** and `public/data/songs_catalog.json` — the
  same idea on the static side.

What survived, and why it is not the same thing: `src/terms.js` holds
`TERMS`/`IDOLS`/`SPEAKERS` and a `SONG_MASTER` of 432 songs — titles, unit type
and `mst_song_id`. Those are *game facts* that do not change when someone
accepts a translation, the same class of constant as the idol roster. It
deliberately carries no slot counts, translated counts or status: the moment it
did, it would be a stale release snapshot again. Slot counts live in
`release_summaries` (`category_summary_json`), rebuilt by the importer and by
every sync job.

The lyric files under `public/data/lyrics/<bundle>.json` are a **source** cache
only. They are read to recover the original Japanese text and its
`source_sha256` for a bundle; the `translation` and `status` fields they also
contain are ignored, and the API reports the D1 state (or `untranslated`) with a
`source: "release" | "source_cache"` marker saying where the source text came
from.

`scripts/generate_portal_categories.py` and `scripts/build_portal_songs_catalog.py`
still exist and still produce those files for the localization export pipeline
(the latter also rebuilds the static lyric assets), but the Portal does not read
their output any more. `scripts/build_portal_songs_catalog.py` also writes
`src/songs_catalog.json` and `src/songs_catalog.js`; treat those as build
artifacts of that pipeline, not as Portal inputs.

Generation checks that keep this true: `node test_config.mjs` (config
conformance + the static-pinning scan + the `.assetsignore` check),
`node test_worker.mjs` and `node test_sync.mjs`.

## Two release axes, not one version string

A release here is either a **Client release** or an **Assets release**. They are
separate rows, separate endpoints and separate pages; they are never flattened
into one "combination version".

- `client_releases` — `release_id` (`client-9.0.200-arm64`), `client_version`,
  `abi` (constrained to `arm64-v8a` by a `CHECK`), `base_apk_sha256`,
  `client_resources_commit`, `manifest_sha256`, `output_apk_sha256`,
  `release_url`, `status`, `created_at`, `published_at`. There is deliberately
  **no `asset_version` column**: an APK is built from its own version's
  localization resources and is not rebuilt because an Assets release changed.
- `assets_releases` — `asset_version` (primary key), `release_id`,
  `server_schema_version`, `status`, `source_manifest_sha256`, `assets_commit`,
  `note`, `created_at`, `updated_at`, `published_at`. Which asset version may be
  written is decided by this table's `status` column
  (`canonical`/`staging`/`unverified`/`superseded`), read from D1 on every
  request — there is no in-code allowlist, and adding a version is a row
  insertion, not a redeploy.

Everything else hangs off the pair `(release_kind, release_id)`:
`resource_units` (the logical resource), `source_variants` (one row per distinct
source text of that resource), `translation_units` (the accepted translation),
`release_resource_refs` (which resource belongs to which release, and how it was
resolved) and `release_summaries` (the derived roll-up).

The tested pair `9.0.200+1077100` is recorded for humans — [§ Compatibility](#compatibility--tested-combinations)
below. It is not a key, a default, or a build input anywhere in the runtime.

### Cross-version reuse

`release_resource_refs.reuse_mode` answers "can this release borrow a
translation another release already has?" with four values and nothing in
between:

| `reuse_mode` | when |
| --- | --- |
| `exact` | `logical_key` + `resource_kind` + `locale` + `source_sha256` all match and an accepted `translation_units` row exists. The text is identical, so the translation applies verbatim. |
| `verified-compatible` | the hash differs but there is explicit evidence — a manifest entry or a recorded attestation (`reuse_attestations`) — that the resource is the same one. Still requires a human or a manifest, never an inference. |
| `suggested` | the hash differs and a historical translation exists for that key. Shown to a reviewer as a suggestion; it does not become the release's translation until accepted. |
| `blocked` | nothing matched, so nothing is borrowed. |

Never inferred from version proximity, bundle name, `item_key` shape, text
similarity, or date adjacency, and never shared by combination version. The
evaluator is scanned by `test_sync.mjs`, which fails the suite if words like
`version`, `date`, `similarity` or a bare `bundle ===` comparison appear in it.

## Compatibility / tested combinations

`9.0.200 + 1077100` is a combination that has been tested together. It is
recorded as a fact about testing, nothing more: not a key, not a default, not a
resource version, not a build input. The Portal renders the Client release list
and the Assets release list separately; a tested combination may appear as an
extra compatibility note on a release, never as the page's identity.

## Webhook → D1 live sync

`POST /api/webhooks/github` is the entry point, and it has a real consumer:

1. **Verify** — `X-GitHub-Event`, `X-GitHub-Delivery` and `X-Hub-Signature-256`
   are all required; the HMAC is checked against `GITHUB_WEBHOOK_SECRET`. With
   the secret unset the endpoint answers `503 webhook_secret_unconfigured`
   instead of accepting unverified payloads.
2. **Deduplicate** — the delivery id is inserted into
   `github_webhook_deliveries` with a partial unique index, so a GitHub redelivery
   is `duplicate_ignored` rather than a second import.
3. **Accept only configured repositories** — `SYNC_REPOSITORIES` decides. A
   repository name containing "client" is not auto-classified; the mapping from
   repository to `release_kind` is configuration.
4. **Enqueue** — one `sync_jobs` row (`pending`, target `release_kind`/`release_id`).
   Enqueuing is *not* syncing.
5. **Consume** — the consumer is manual-only now: `POST /api/sync/tick` runs one
   bounded batch synchronously for an operator, while `GET /api/sync/status`
   reports the queue. The portal's latest release reads come from the upstream
   CI manifests, so an always-on D1 cron would only spend the free write budget
   duplicating data the homepage does not read. When invoked, the consumer walks
   commit → manifest → changed files, upserts release metadata, source variants
   and translation units, generates the release refs, rebuilds
   `release_summaries` and records the outcome.
6. **Retry or fail closed** — attempts are bounded (`max_attempts`) with
   backoff; exceeding the per-job row budget requeues with a `cursor_json`
   instead of reporting partial success.

Import scope is narrow on purpose: currently untranslated or pending rows only,
changed files only. Assets imports recognise `locales/**/*.jsonl`, `lyrics/**`,
`glossary/**`, `manifests/images.manifest.json` and the Unity3D/release
manifests; every entry must satisfy `source_sha256`, locale, `logical_key`,
`release_id` and file-hash checks before it becomes canonical — a resource that
merely appears in a manifest does not. Client imports reject a manifest that
requires an `asset_version` (`decoupling_violation`) and any ABI other than
`arm64-v8a` (`client_abi_unsupported`). A release imported this way lands as
`staging`; promotion to `canonical` is a separate, deliberate act. APK bytes are
never read from D1 or R2.

Portal → GitHub uses source-bound edits and the authenticated contributor's fork/branch/PR. `GITHUB_PR_ALLOW_UPSTREAM` is retired and cannot bypass fork-only collaboration. The historical snapshot importer is an isolated migration tool, not the current Portal write path. Generated-only files are explicitly excluded from translation ingest.

## D1 read budget — per request type

The free tier allows 5M row reads/day. The old design answered first-screen
requests by scanning hundreds of thousands of rows; every read path is now
bounded and shaped by what the page actually shows.

| Request | Reads | Shape |
| --- | --- | --- |
| `GET /api/stats` | 1 row | `portal_summary` / `release_summaries` single row. No `COUNT`, no `GROUP BY`, no full-table fallback. Missing summary → `503 data_not_ready`, never a fabricated zero. |
| `GET /api/assets/releases`, `GET /api/client/releases` | 1 bounded page | `LIMIT` with an explicit column list (no `SELECT *`), keyset cursor. |
| `GET /api/catalogue/search` | 1 bounded page | Scoped to `release_kind` + `release_id` (unscoped defaults to the canonical release, resolved from D1). Keyset seek on `(bundle, item_key)`; no `OFFSET`; `total` is opt-in from the summary, and a filtered query reports `total: null` + `total_note` instead of a release-wide number. |
| `GET /api/lyrics/songs` | 1 page + 1 summary row | `DISTINCT bundle` keyset seek, capped; per-song slot counts from `release_summaries.category_summary_json`. |
| `GET /api/lyrics/song` | ~3 bounded queries | Source variants + resource units + translation refs for one bundle, then one indexed overlay of pending contributions. |
| `GET /api/images/tasks` | 1 page + 1 row + ≤1 per task | Keyset on `task_id`, category totals from `portal_summary['image_categories']`, one primary-key lookup per task on the page for its override. |
| `POST /api/contributions` | no writes | Retired: HTTP 410. Source-bound proposals use `/api/contributions/github-pr`. |
| `GET /api/queue`, `/api/admin/contributions` | at most one bounded query per authorized repo | User-token ownership and live GitHub repository permissions are checked first; results stay repository-scoped and `no-store`. |
| `scheduled` sync tick | bounded batch | `rowsPerJob` / `fileLimit` caps; over budget requeues with a cursor. |

Per-request limits are clamped (`DEFAULT_PAGE_LIMIT` 20, `MAX_PAGE_LIMIT` 100,
filtered catalogue scans capped at `MAX_SCAN_ROWS` 400). Aggregation happens in
the importer and is stored, never in a request.

Quota failures are not success: `isQuotaError` maps supported D1 quota errors to `503` with `d1_quota_exceeded` and `Retry-After`. The historical R2 contribution buffer is not the new GitHub proposal authority. A quota error must not become a fabricated zero, empty successful listing or independent final review status.

## R2 object layout

Keys are computed, never discovered by listing, so a write can be re-run without
reading the bucket first:

| Key | Contents |
| --- | --- |
| `images/composite/<task_id>/source-composite.png` | reconstructed composite shown in the portal |
| `images/restored/<task_id>/restored-texture.png` | localized texture, when scored |
| `images/original/<bundle>/<file>.png` | source Texture2D, needed to re-run the backfill |
| `images/task/<task_id>/task.json` | region map for the backfill |
| `snapshots/<release_kind>/<release_id>/<sha256>.jsonl` | immutable publication snapshot |
| `buffer/contributions/<asset_version>/<uuid>.json` | write-buffer held while D1 is over quota |
| `uploads/restore/<task_id>/…` | contributor-uploaded composite awaiting backfill |

The `images/*` families are public through the custom domain because the portal
displays them. The buffer and snapshot prefixes are **private**: candidate and
buffered content must not be publicly readable. Uploads are idempotent (PUT on a
computed key), deletes happen only after the downstream step succeeded, listings
are cursor-paginated, and the Worker never pulls R2 bytes into memory to do bulk
transforming.

## Client APK builds

`.github/workflows/private-client-build-arm64.yml.example` is an **example**, not
a working release pipeline, and it is not enabled. It documents the shape of a
build: read the Client manifest, read the private official APK, read the exact
`client_resources_commit`, patch, `zipalign`, `apksigner`, hash the result and
attach it to a `MLTDTranslationClient` GitHub Release.

Publishing is decided by the build's own report, not by an input: the daily
scheduled run performs the real build, and a gate step calls
`assert_publishable` (`scripts/private_build_poller.py`) on the report it just
wrote. Only if that gate exits 0 does the run mint a token and create the
Release. A manual `workflow_dispatch` (default `dry_run=true`) validates only,
and a tag push builds nothing.

Without the toolchain, the official base APK, or the signing environment the
build fails closed: no placeholder APK, no fake artifact, no
`base_apk_bytes + b"-patched"` as a production path. The private Build
repository must not read or bind an Assets release and must not depend on
`asset_version`.

**Actual status: not built here.** Nothing in this directory has produced a real
signed APK, and `npm run deploy:dry-run` passing says nothing about the APK.

## 14 Fine-Grained Categories & Category-Tailored Translation Studios
   - **🎵 歌曲打歌歌词 (`lyrics`)**: 432 首歌曲、12,131 句打歌歌词独立展示。专属打歌视轨工作台：曲名大标题、BPM 节拍显示、每一行槽位编号、日文原句排版、就地行内输入框、拍子字数计步器与快捷保存（`Ctrl+Enter` 连打保存并自动对焦下一句）。
   - **📱 活动短信与聊天 (`event_chat` / `card_blog`)**: 拟真智能手机外壳 + 灵动岛 + 偶像气泡对话流。
   - **🌟 剧场 AVG 剧情 (`event_story` / `main_commu` / `special_commu`)**: 视觉小说剧幕框 + 角色铭牌 + 沉浸式场景流。
   - **🎴 卡片觉醒物语与技能 (`card_episode` / `card_skill`)**: SSR 金色专属卡面铭框与卡面编号档案。
   - **🏢 剧场工作与留言 (`theater_comm` / `message_board`)**: 休息室白板留言便签风格。
   - **⚙️ 界面系统与规则 (`system_ui`)**: UI 字数长度安全提示与非法控制符实时拦截。

## Running the checks

```bash
cd web/translation-portal
npm test                    # worker flow + sync pipeline + config conformance
node test_worker.mjs        # HTTP contract, memory D1/R2, no credentials
node test_sync.mjs          # webhook, importer, reuse rules, quota, R2 buffer
node test_config.mjs        # wrangler.jsonc ⇄ wrangler.toml.example, static-pinning scan
python web/translation-portal/scripts/bootstrap_portal_d1.py --db local_portal.db   # schema + migrations, offline
python web/translation-portal/scripts/bootstrap_portal_d1.py --db local_portal.db --status   # read-only classification (exit 0/2/3/4/5)
python web/translation-portal/scripts/test_bootstrap_portal_d1.py   # the classification and refusal guarantees, offline
npm run deploy:dry-run      # bundles the Worker; needs no Cloudflare credentials
```

`npm run deploy:dry-run` is a **local** check: it proves the config parses, the
entry point resolves and the asset selection is what you expect. It is not a
deployment, and it says nothing about D1, R2, Access allowlists, the webhook
secret, or whether the remote database has the current migrations.

- `scripts/export_translation_portal_catalogue.py`：历史离线目录导出，仅生成指定输出目录的 SQL；历史证据将归 Portal 本地 ignored 位置，本轮旧仓保全仅为过渡。
- `scripts/sync_github_to_portal_catalogue.py`：历史离线 locales → SQL 维护工具；当前提交与 review 沿用 GitHub fork/PR。
- `scripts/sync_portal_snapshot_to_github.py`：仅历史离线 snapshot 转换，会写指定仓库 locales 并设 status=accepted；不构成当前正式 publish/review 链，Worker 旧入口 410 保持。
