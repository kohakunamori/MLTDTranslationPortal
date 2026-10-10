# MLTD 翻译查阅站

个人自用的译文查阅站点。**读取侧是纯静态的**：没有协作门户、没有 Cloudflare Worker、
没有 D1 数据库、没有 OAuth 登录、没有会话与审核队列——页面就是 `public/` 下的一组静态文件。
数据由本仓的 `scripts/build_data.mjs` 从两个翻译仓库生成，2026-10 起在自托管的
`vps_racknerd` 上每天生成一次（原先由 GitHub Actions 生成并发布到 Pages）。

线上：**https://mltd-portal.nyaneko.cn/**（自托管；旧的 Pages 地址在同一份数据上并存，
迁移验证完成后关闭）

- **读**：15 个分类、12,249 个资源、405,518 行；按分类 / **来源（Assets·Client）** / 偶像 / **翻译状态（已翻译·未翻译·待确认·无需翻译）** / 关键字筛选；日中对照阅读、术语/偶像名高亮、
  歌词按槽位排序、资源内搜索与筛选、图片本地化画廊、巨型资源分页（每页 2,000 行）。
- **写**（可选，单人）：在阅读页直接改一行译文，用**你自己存在本机**的 GitHub Token
  提交到翻译仓库。**服务器不保存任何密钥**。自托管那边多了一台中继
  （[`scripts/relay.mjs`](scripts/relay.mjs)）：浏览器只发几 KB 的编辑意图，服务器用 git
  精确改一行再推送，所以**超过 1 MB 的大文件也能改**——纯浏览器方案下那些行只能看
  （GitHub 的文件接口对超过 1 MB 的文件不给内容，而 5 个大文件装着一半的行）。
  探测不到中继时自动退回浏览器直连，所以旧站点照常可用。

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
                            |  每天 04:40 在 vps_racknerd 上跑（上游 HEAD 没变就整段跳过，
                            |  约 1 秒）；先写 .staging 再原子替换，失败保留上一次数据
                            v
                    public/data/**（JSON，200 MB）
                            |
                  nginx（mltd-portal.nyaneko.cn，Cloudflare 前置）
                     |                         |
     图片经软链接读上游检出            /api/ → 写入中继容器（可选）
     （不复制，省 336 MB）            浏览器带 Token，服务器不存
                            \           /
                             浏览器
```

生成物**不入库**（`public/data/`、`public/media/` 都在 `.gitignore` 里）：每次部署都是当天上游
的最新数据，仓库里只有站点代码。完整形状与生成规则见
[`docs/DATA-CONTRACT.md`](docs/DATA-CONTRACT.md)，由 6 个离线测试守着。

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
| `docs/` | 数据契约、[Token 创建指南](docs/GITHUB-TOKEN.md) + 旧 Worker 读接口 / 旧前端界面的考古记录 |
| `legacy-tools/` | 已退役的 D1 时代 Python 工具的冻结副本（不参与构建与测试） |

## 本地使用

```bash
npm run data:demo     # 用 test_helpers/fixtures 生成一份演示数据到 public/data
npm run serve         # http://127.0.0.1:8788
npm test              # 6 个离线契约测试（生成器 / 静态站点 / 单行写入 / AI 草稿 / CI 判断 / 中继）
```

真数据需要两个翻译仓库的 checkout（只取需要的目录，省掉上游 400 MB 的 `generated/`）：

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/kohakunamori/MLTDTranslationAssets vendor/MLTDTranslationAssets
git -C vendor/MLTDTranslationAssets sparse-checkout set locales lyrics manifests images
git clone --depth 1 --filter=blob:none --sparse https://github.com/kohakunamori/MLTDTranslationClient vendor/MLTDTranslationClient
git -C vendor/MLTDTranslationClient sparse-checkout set manifests

npm run data          # 读取 vendor/ 生成 public/data（实测 14 秒、峰值 383 MB、12,356 个文件）
npm run data:check    # 只比对：一致退出 0，有漂移退出 2，出错退出 1
```

图片要跟着站点一起看时，把上游的 `images/localized` 复制成 `public/media/localized`：

```bash
cp -R vendor/MLTDTranslationAssets/images/localized public/media/localized
```

> 演示数据（`data:demo`）没有 `public/media/`，所以图片卡片会显示"图片不可用"占位——
> 这是预期行为，不是坏了。

## 部署（自托管）

站点跑在 `vps_racknerd` 上，运维适配器在 Control 仓的 `deploy/vps-racknerd-mltd-portal/`
（容器定义、nginx 配置、生成脚本、定时单元、防护自测）。

1. 把本仓克隆到 `/srv/mltd-portal/portal`，再建上游检出（读取一份、写入一份）：
   `bash /srv/mltd-portal/ops/setup-read-clones.sh`（含 937 张图片，读取那份保持干净）。
2. `bash /srv/mltd-portal/generate.sh` 生成数据；再装
   `bash /srv/mltd-portal/ops/install-systemd.sh`，之后每天 04:40 自动检查上游。
3. `bash /srv/mltd-portal/ops/relay-up.sh` 起写入中继，并把 nginx 的 `/api/` 接上。
4. `bash /srv/mltd-portal/ops/guards.sh` 自测防护项与站点回归。
5. **每次更新站点代码（`git pull`）之后跑一次 `bash /srv/mltd-portal/ops/publish-version.sh`。**
   页面入口用"带版本号的地址"加载，靠它写的 `/version.json` 决定版本号；不跑这一步，地址不变，
   Cloudflare 与浏览器里那份旧脚本会继续发出去（页面不会白屏，只是更新不生效）。

域名 `mltd-portal.nyaneko.cn` 走 Cloudflare，HTTPS 复用 `*.nyaneko.cn` 通配证书与现有 443
SNI 汇聚入口，没有新增公网监听端口。

**生成机器是 1 核 1.4 GB 且已经跑满服务的机器**，所以生成器必须省内存：产出边生成边落盘
（峰值 815 MB → 383 MB），并且在 512 MB 内存上限的容器里跑——超了就失败，而不是拖垮同机服务。

中继容器不保存任何密钥，可以随时删除重建：它挂了只会让"改译文"暂时不可用，页面照常打开。

### 旧的 GitHub Pages 部署（已停用并下线）

2026-10-10 起这条流水线不再自动跑：`push` 触发与每天 03:17 UTC 的定时都已删除，只剩手动
**Actions → Run workflow**（可勾 **force**）；同日旧镜像也已下线，返回 404。需要时它仍然能
重新生成一份数据并发布到 Pages，"要不要重新生成"的判断逻辑没动
（[`scripts/ci_decide.mjs`](scripts/ci_decide.mjs)，可 `node scripts/ci_decide.mjs --self-test`
本地验）；测试会盯着"自动触发不许被加回来"。

自动触发还在时的三条省配额规矩，留作参考：`push` 只有动了站点输入（`public/**`、`scripts/**`、
`test/**`、`package.json`、工作流本身）才重建，改 docs 不触发；定时与手动触发先比对线上已发布
`portal.json` 里记的 `sources.*.head` 与本仓 commit，一致就整段跳过。

**省下来的是什么**（别误会成"省 runner 分钟"）：公开仓库用 GitHub 托管 runner 的分钟数**不计费**，
所以省的是另外三样 ——
1. **上游克隆流量**：真重建每次要从两个翻译仓拉 200~330 MB（跳过时 0）；
2. **Pages 产物流量**：每次真重建上传并发布约 536 MB（174 MB 数据 + 333 MB 图片；跳过时 0）；
3. **墙上时间**：实测一次完整跑 95 秒，跳过那次 14 秒。

旧镜像（`kohakunamori.github.io/MLTDTranslationPortal/`）已于 2026-10-10 下线，返回 404。
要恢复：仓库 **Settings → Pages** 重新选 **Source = GitHub Actions**，再手动跑一次
**Actions → Run workflow**（产物不入库，必须重新生成）。

## 单人写入怎么用

1. 打开站点 → 设置 → 点 **① 一键新建 Token**（细粒度）或 **经典 Token（勾好权限）**。
   站点里有一份可展开的分步说明（含每个字段怎么填），完整版见
   [`docs/GITHUB-TOKEN.md`](docs/GITHUB-TOKEN.md)（两条路线的取舍、排错对照表、泄露后怎么撤销）：
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
以上四条在自托管那边由中继在服务器上执行：写之前先 `git fetch` 到最新版本，提交署名用 Token
的主人（问一下 GitHub 就知道），推不上去就基于最新版本重来一次。

增量文件覆盖过的行（真实数据里有 292 行）会写到它真正住着的文件——确认弹窗里显示的就是
那一个路径。页面会立刻显示新值，全站生效要等下一次生成数据（自托管是每天 04:40，旧的 Pages 是每天 03:17 UTC）。

## 测试

| 套件 | 覆盖 |
| --- | --- |
| `test/test_generator.mjs` | 40 项：计数/进度自洽、版本轴（落后一档保留、更新一档跳过）、同名去重取新版、清单对账、分页与跨页行号、`edit_path` 例外行、图片字段、真实清单形状、确定性与 `generated_at` 例外、`--check`/`--strict` 退出码、坏 JSON/哈希不符/参数错误等失败模式 |
| `test/test_frontend_contract.mjs` | 24 项：读取路径不依赖服务端接口、中继缺席时退回直连、DOM id 与路由闭合、索引↔分页文件计数一致、行级字段齐全、图片地址是站点内相对路径且不含 404 的上游模板、真实产物能被静态服务器按页面用的 URL 取到、路径穿越被拒、单行修改字节精确 |
| `test/test_github_write.mjs` | 36 项：单行 JSON 扫描器（两种身份字段）、`not_found`/`ambiguous`/`source_changed`/`conflict` 等失败模式、token 不落 URL/日志、仓库权限判定（scope 只写公开仓库，`permissions.push` 才是权威） |
| `test/test_ai_draft.mjs` | 格式校验与 AI 调用（stub fetch，无网络） |
| `test/test_ci_decide.mjs` | 14 项：跳过/重建判断（push 路径、HEAD 比对、缺标记保守重建、force）、工作流门控与触发路径 |
| `test/test_relay.mjs` | 18 项：写入中继（路径白名单、令牌不外泄、原文对不上就拒绝、真跑一遍 git 流程：改一行→提交→推送、落后于远端时先同步再改、内容没变不空提交、越界不碰仓库）与网页端传输层（走中继 / 无中继退回直连 / 不反复试探） |

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
