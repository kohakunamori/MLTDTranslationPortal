# MLTD 翻译查阅站

个人自用的**纯静态**译文查阅站点。没有协作门户、没有 Cloudflare Worker、没有 D1 数据库、
没有 OAuth 登录、没有会话与审核队列：站点就是 `public/` 下的一组静态文件，数据由本仓
GitHub Actions 每天从翻译仓库生成，直接进 Pages 产物。

线上：**https://kohakunamori.github.io/MLTDTranslationPortal/**

- **读**：15 个分类、12,249 个资源、405,518 行译文；日中对照阅读、术语/偶像名高亮、
  歌词按槽位排序、资源内搜索与筛选、图片本地化画廊、巨型资源分页（每页 2,000 行）。
- **写**（可选，单人）：在阅读页直接改一行译文，用**你自己存在本机**的 GitHub Token
  提交到翻译仓库。没有服务端，没有别人的身份体系。

## 架构

```
kohakunamori/MLTDTranslationAssets (main)     kohakunamori/MLTDTranslationClient (main)
  locales/**/*.jsonl  lyrics/songs/*.jsonl      manifests/portal-resource-manifest.json
  lyrics/all_lyrics.jsonl                       manifests/bottom-bar.manifest.json
  manifests/*.json  images/localized/**/*.png
                    \                            /
                     \                          /
             scripts/build_data.mjs（node，零依赖）
                            |
              +-------------+--------------+
              |                            |
              v                            v
      public/data/**（JSON）        public/media/localized/**（图片字节）
              \                            /
               \                          /
                 GitHub Actions → Pages artifact → 浏览器
```

生成物**不入库**（`public/data/`、`public/media/` 都在 `.gitignore` 里）：每次部署都是当天上游
的最新数据，仓库里只有站点代码。完整形状与生成规则见
[`docs/DATA-CONTRACT.md`](docs/DATA-CONTRACT.md)，由 4 个离线测试守着。

## 目录

| 路径 | 作用 |
| --- | --- |
| `public/index.html` `public/app.js` `public/app.css` | 查阅页面本体（ES module，无构建步骤） |
| `public/lib/taxonomy.js` | 分类 / domain / 偶像归属 / 上游路径规则（生成器与页面**共用同一份**） |
| `public/lib/terms.js` | `TERMS` / `IDOLS` / `SPEAKERS` / `SONG_MASTER`（游戏事实常量，432 首曲目） |
| `public/lib/data.js` | 静态数据访问层（portal / 分类索引 / bundle 分页 / 图片） |
| `public/lib/github-write.js` | 单人单行写入（PAT → GitHub Contents API，字节级替换） |
| `public/lib/ai-draft.js` | 可选 AI 草稿 + 译文格式校验（自带 endpoint/key，浏览器直连） |
| `public/data/**` `public/media/**` | 生成物：CI 产出，不进 git |
| `scripts/build_data.mjs` | 数据生成器（确定性、fail-fast、对账、`--check` 漂移比对） |
| `scripts/serve.mjs` | 本地静态预览服务（Pages 上就是这套文件） |
| `test/` | 4 个离线契约测试，无网络、无凭据 |
| `docs/` | 数据契约 + 旧 Worker 读接口 / 旧前端界面的考古记录 |
| `legacy-tools/` | 已退役的 D1 时代 Python 工具的冻结副本（不参与构建与测试） |

## 本地使用

```bash
npm run data:demo     # 用 test_helpers/fixtures 生成一份演示数据到 public/data
npm run serve         # http://127.0.0.1:8788
npm test              # 4 个离线契约测试（生成器 / 静态站点 / 单行写入 / AI 草稿）
```

真数据需要两个翻译仓库的 checkout（只取需要的目录，省掉上游 400 MB 的 `generated/`）：

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/kohakunamori/MLTDTranslationAssets vendor/MLTDTranslationAssets
git -C vendor/MLTDTranslationAssets sparse-checkout set locales lyrics manifests images
git clone --depth 1 --filter=blob:none --sparse https://github.com/kohakunamori/MLTDTranslationClient vendor/MLTDTranslationClient
git -C vendor/MLTDTranslationClient sparse-checkout set manifests

npm run data          # 读取 vendor/ 生成 public/data（约 15 秒、12,356 个文件）
npm run data:check    # 只比对：一致退出 0，有漂移退出 2，出错退出 1
```

图片要跟着站点一起看时，把上游的 `images/localized` 复制成 `public/media/localized`：

```bash
cp -R vendor/MLTDTranslationAssets/images/localized public/media/localized
```

> 演示数据（`data:demo`）没有 `public/media/`，所以图片卡片会显示"图片不可用"占位——
> 这是预期行为，不是坏了。

## 部署（GitHub Pages）

1. 仓库 **Settings → Pages → Source** 选 **GitHub Actions**。
2. 跑一次 **Actions → 生成数据并部署 Pages → Run workflow**（或直接 push 到 `main`）。
3. 之后每天 03:17 UTC 自动重新生成并部署。

工作流做四件事：跑 4 个离线测试 → sparse clone 两个翻译仓 → 生成 `public/data` 并把图片复制到
`public/media` → 校验每个图片地址都真的有文件、产物非空 → 打包 `public/` 发布。
两个数据仓都是公开仓库，所以**不需要任何 secret**，工作流也不需要 `contents: write`。

产物约 500 MB（JSON 约 170 MB + 图片 333 MB），在 Pages 的 1 GB 限制内。

## 单人写入怎么用

1. 打开站点 → 设置 → 点 **① 一键新建 Token**（细粒度）或 **经典 Token（勾好权限）**：
   - 细粒度：Repository access 选 Only select repositories → `kohakunamori/MLTDTranslationAssets`；
     Permissions → **Contents: Read and write**；
   - 经典：链接已经预勾好 `public_repo`（两个翻译仓都是公开仓库，够用），点 Generate 即可。
2. 复制粘贴进设置里的输入框 → **验证**。验证会用这个 Token 实际查一次仓库权限，
   直接告诉你"能不能写"以及缺哪一步（而不是只说"未确认"）。
3. 进任意资源，点某行的「修改」，改完「提交修改」→ 确认弹窗给出仓库/文件/定位/旧值/新值
   → 确认后提交到数据仓库。

> **为什么不是 OAuth 登录？** 实测 `github.com/login/oauth/*` 与 `github.com/login/device/code`
> 都**不返回** `Access-Control-Allow-Origin`（只有 `api.github.com` 有），所以静态页面连设备码都拿不到；
> 授权码换 token 还需要一个不能公开的 client secret。要在纯静态站点上做真 OAuth，必须加一个
> 几十行的换码代理（Worker/函数）——那正是这次重构删掉的东西，所以这里选择"把创建 Token 的
> 页面按对的权限直接打开 + 粘贴后立刻验证"。

写入的四条硬约束（详见数据契约）：

- 定位按数据里声明的 `edit.identity_field`（`locales/**` 是 `item_key`，歌词是 `index`）；
- 只替换那一行的 `zh`（以及可选 `status`）字符串字面量，**其余字节不动**；
- 提交前重算 `sha256(ja)` 与数据里的 `source_sha256` 比对，**源文变过就拒绝写入**；
- 409/422 视为并发冲突，**不自动重试、不覆盖**，提示重新生成数据后再说。

增量文件覆盖过的行（真实数据里有 292 行）会写到它真正住着的文件——确认弹窗里显示的就是
那一个路径。页面会立刻显示新值，全站生效要等 CI 下一次生成数据。

## 测试

| 套件 | 覆盖 |
| --- | --- |
| `test/test_generator.mjs` | 39 项：计数/进度自洽、版本轴（落后一档保留、更新一档跳过）、同名去重取新版、清单对账、分页与跨页行号、`edit_path` 例外行、图片字段、真实清单形状、确定性与 `generated_at` 例外、`--check`/`--strict` 退出码、坏 JSON/哈希不符/参数错误等失败模式 |
| `test/test_frontend_contract.mjs` | 20 项：页面无 `/api/` 依赖、DOM id 与路由闭合、索引↔分页文件计数一致、行级字段齐全、图片地址是站点内相对路径且不含 404 的上游模板、真实产物能被静态服务器按页面用的 URL 取到、路径穿越被拒、单行修改字节精确 |
| `test/test_github_write.mjs` | 36 项：单行 JSON 扫描器（两种身份字段）、`not_found`/`ambiguous`/`source_changed`/`conflict` 等失败模式、token 不落 URL/日志、仓库权限判定（scope 只写公开仓库，`permissions.push` 才是权威） |
| `test/test_ai_draft.mjs` | 格式校验与 AI 调用（stub fetch，无网络） |

CI 在打包前另跑两道真实数据校验：每个 `localized_url` 都要有对应文件；产物非空才允许部署。

## 与旧版本的关系

2026-10 的这次重构删除了协作门户的全部运行时：`src/worker.js`（5300 行 Worker）、
`src/github_collab.js`、`src/github_session.js`、`src/github_user_token.js`、
`src/sync_*.js`、`src/release_registry.js`、`schema.sql`、`migrations/`、
`wrangler.jsonc`、8 个 Worker/D1/协作测试与全部 D1 运维脚本。

删除前的读接口契约与旧前端界面清单保留为考古记录，行号引用针对删除前的
git 提交（`git show 7011fd8:src/worker.js`）：

- [`docs/LEGACY-READ-CONTRACT.md`](docs/LEGACY-READ-CONTRACT.md) —— 旧读接口与上游清单
  的逐字段契约，以及 26 条自相矛盾之处（新生成器的判定规则就是从它里面挑出来的）。
- [`docs/LEGACY-UI-INVENTORY.md`](docs/LEGACY-UI-INVENTORY.md) —— 旧界面的视图/字段
  依赖表与 40 项协作专属界面，新页面删掉了它们，保留了浏览与对照阅读。

`legacy-tools/` 里那 6 个 Python 文件是 D1 时代的冻结副本，只作历史证据存在。
