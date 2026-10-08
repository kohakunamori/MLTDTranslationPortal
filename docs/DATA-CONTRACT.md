# 站点静态数据契约

这份文档描述 `public/data/**` 里每一个字节的来源与含义，以及单人写入的协议。
它由测试守着：`npm test`（4 个离线套件）与 CI 里的图片/产物校验一旦对不上就红。

- 生成者：`scripts/build_data.mjs`（Node 22，零依赖，只用 `node:` 内置模块）
- 读取者：`public/lib/data.js` + `public/app.js`（浏览器，ES module，无构建步骤）
- 触发者：`.github/workflows/portal.yml`（每天 03:17 UTC + 手动），产物直接进 Pages

## 数据流

```
MLTDTranslationAssets (main)                  MLTDTranslationClient (main)
  locales/**/*.jsonl                             manifests/portal-resource-manifest.json
  lyrics/songs/*.unity3d.jsonl                   manifests/bottom-bar.manifest.json
  lyrics/all_lyrics.jsonl
  manifests/portal-resource-manifest.json
  manifests/images.manifest.json
  images/localized/**/*.png
        \                                              /
         \                                            /
          scripts/build_data.mjs  ──►  public/data/**  ──►  Pages 产物（public/）
                                   └─►  public/media/localized/**（CI 复制图片字节）
```

仓库里**不存生成物**：`public/data/` 与 `public/media/` 都在 `.gitignore` 里，只有 CI 会把它们
写进 Pages artifact。所以每次部署都拿当天上游的最新译文，不需要数据提交、不需要 `contents: write`。

## 上游事实（2026-10 实测，不是推测）

| 事实 | 数值 / 形状 | 对生成器的影响 |
| --- | --- | --- |
| `locales/**` 文件 | 11,818 个 | 一行一条译文，身份是 `item_key` |
| `locales/**` 行 | `{asset_version, bundle, client_version, item_key, ja, zh, source_client_version, source_sha256, status, updated_at}` | 只认这些键，缺 `item_key` 直接报错 |
| `lyrics/songs/*.unity3d.jsonl` | 432 个 | 行里**没有** `item_key` / `asset_version`；身份是数字 `index` |
| `lyrics/all_lyrics.jsonl` | 每首歌的行又复制一遍 | 必须去重，否则行数翻倍 |
| 版本轴 | 行的 `asset_version=1077500`，清单 `release.asset_version=1077710` | **`<=` 发布版本的行都算**，比发布版本新的跳过并告警 |
| 增量文件 | `locales/master/official-1077710-untranslated.jsonl`（1,833 行、5 个 bundle） | 同一 `item_key` 出现两次时**版本新的赢**（译文确实更好） |
| 清单权威 | `categories[].bundles` 里 11,816 个 bundle，**没有一个属于两个分类** | 分类以清单为准，名字规则只用于清单外的 bundle（歌词 432 + 少量历史 bundle） |
| 清单计数 | 按"文件里有几行"统计，所以重复副本会被算两次 | 对账时用 `生成数 + 去重数` 比，不能直接比 |
| 图片 | 清单 937 条；仓库里**只有** `images/localized/**`（937 个 PNG，333 MB） | 中文版随站点发布；**没有**日文原图的字节 |
| 图片分发地址 | 清单的 `distribution.*.url_template`（`images/<sha>.png`）实测 **404** | 数据里不出现这些地址，页面不拼对象键 |
| `generated/` | 400 MB、与译文无关 | CI 用 sparse checkout 跳过 |

## 生成规则

1. **身份**：`item_key` → `index` → `slot_index`，取第一个存在的键；每条记录在
   `edit.identity_field` 里声明用的是哪个，写入时按它定位。
2. **版本**：行有 `asset_version` 且 `> release.asset_version` → 跳过并告警一次（聚合计数）；
   没有版本字段的行一律保留（歌词、客户端清单）。
3. **去重**：同一 `item_key` 在多个文件里出现时，按 `[版本, 文件名等于 bundle 名]` 排序取最好的那一份，
   其余丢弃；`note:` 里报出总行数与"内容因此被更新的版本覆盖"的行数。写路径永远指向权威文件
   （文件名等于 bundle 的那个），**绝不**指向增量或汇总文件。
4. **分类**：清单 `categories[].bundles` 是权威；不在清单里的按 `public/lib/taxonomy.js` 的名字规则判定，
   数量记在 `note:` 里。分类顺序固定为 `CATEGORY_ORDER`。
5. **排序**：歌词按 `slot_index`（= 上游 `index`）升序；其他按上游文件行序。展示序号 `index` 从 1 起跨页连续。
6. **分页**：bundle 超过 `--max-rows-per-page`（默认 2,000）切成 `<base>.p1.json`…；
   一个 bundle 仍是一条目录记录，`pages[]` 描述每页。真实数据里最大的页约 1.9 MB
   （不分页时 `MD_jp.gtx.json` 会到 41.6 MB）。
7. **对账**：生成完按清单逐分类比对行数（用 `生成 + 去重` 抵消清单的双重计数），总账再比一次。
   不一致 → `warn:`。`--strict` 让警告变成失败。
8. **行状态**：先按"有没有译文"定 `accepted` / `pending` / `untranslated`；再对**没有译文**的行
   看原文语言 —— 原文不含假名/汉字、也没有别的语言字母（韩文、西里尔……）时判为 `not_needed`
   （"无需翻译"）。这是**本站的判定**，不是上游的：上游把这些行的 `status` 也写成 `untranslated`。
   实测真实数据里 1,066 行"未翻译"全是这类英文歌词（`Show goes on`、`We are LEGEND DAYS!`），
   所以进度分母用 `total - not_needed`，它们不再把进度压住。反过来，只要有人真的给这类行加了译文，
   它立刻按正常规则变成 `accepted`/`pending`。`not_needed` **不会**被写回上游（`commitLineEdit` 直接拒绝）。
9. **确定性**：同样的输入产生逐字节相同的输出；`generated_at` 是唯一允许变化的字段，
   所以 `--check` 不会因为时间戳假报漂移。

## 产物

### `portal.json`

| 字段 | 含义 |
| --- | --- |
| `schema_version` | 目前是 `1`；形状变了就加 |
| `generated_at` | 生成时刻（唯一非确定字段） |
| `image_base` | 图片基址；留空表示用站点内相对路径（默认） |
| `sources.assets` | `{repo, ref, commit, manifest_generated_at}`；缺清单时 `commit` 为空串 |
| `sources.client` | 同上（客户端仓） |
| `releases.assets` | 清单里的发布信息 `{release_id, asset_version, status, updated_at}`；缺清单时为 `null` |
| `totals` | `{total, translated, pending, untranslated, not_needed, bundles, files, progress_percent}`；`bundles` 是资源数，`files` 是页文件数 |
| `domains[]` | `{id, name, icon, total, translated, not_needed}` |
| `categories[]` | `{id, domain, name, icon, unit, entry, bundles, files, total, translated, not_needed}`（顺序固定） |
| `image_categories` | `{all, event, costume, tutorial}` |
| `image_statuses` | `{all, localized, original_only}` |

### `catalogue/<category>.json`

```jsonc
{ "category": "lyrics", "name": "…", "domain": "studio", "total_bundles": 432,
  "bundles": [{
    "bundle": "scrobj_smile1.unity3d", "base": "scrobj_smile1", "file": "bundles/lyrics/scrobj_smile1.json",
    "category": "lyrics", "domain": "studio", "channel": "assets", "slot_based": true,
    "asset_version": "1077710", "client_version": null, "repo_path": "lyrics/songs/scrobj_smile1.unity3d.jsonl",
    "idol": null, "song": { "name_ja": "スマイルいちばん", "name_zh": "最棒的笑容", "type": "Princess", "mst_song_id": 15 },
    "edit": { "kind": "jsonl", "repo": "kohakunamori/MLTDTranslationAssets", "ref": "main",
              "path": "lyrics/songs/scrobj_smile1.unity3d.jsonl", "identity_field": "index" },
    "total": 32, "translated": 27, "pending": 0, "untranslated": 0, "not_needed": 5,
    "page_count": 1,
    "pages": [{ "file": "bundles/lyrics/scrobj_smile1.json", "page": null,
                "first_index": 1, "last_index": 32, "total": 32, "translated": 27, "pending": 0, "untranslated": 0, "not_needed": 5 }]
  }]}
```

`channel` 是 `assets`（翻译资源仓，`kind: "jsonl"`）或 `client`（客户端仓，`kind: "manifest"`）。
`page` 为 `null` 表示只有一页。`file` 恒等于第一页的文件，方便直接打开。

### `bundles/<category>/<file>.json`

```jsonc
{ "bundle": "CD_jp.gtx", "base": "CD_jp", "channel": "assets", "category": "card_skill", "domain": "cards",
  "slot_based": false, "asset_version": "1077710", "client_version": null,
  "repo_path": "locales/master/CD_jp.gtx.jsonl",
  "edit": { "kind": "jsonl", "repo": "…", "ref": "main", "path": "locales/master/CD_jp.gtx.jsonl", "identity_field": "item_key" },
  "song": null, "idol": { "code": "019min", "name_ja": "…", "name_zh": "…" },
  "page": 13, "page_count": 13, "first_index": 24001, "last_index": 25356,
  "total_lines": 1356, "translated": 1353, "pending": 3, "untranslated": 0, "not_needed": 0,
  "lines": [{
    "index": 24001,            // 整个 bundle 内的展示序号，跨页连续，从 1 起
    "slot_index": null,        // 歌词的槽位（= 上游 index），其他为 null
    "item_key": "card_list_019min0634_skillname_019min",
    "source": "おしおきですわ！", "translation": "这是惩罚！", "status": "accepted",
    "source_sha256": "…",      // = sha256(source)，写入前必须重算比对
    "line": 1,                 // 上游文件里的行号（1 起）
    "edit_path": "locales/master/official-1077710-untranslated.jsonl",  // 只在这行不住权威文件里时出现
    "manifest_index": 0        // 只有 kind=manifest 才有：slots[] 的下标
  }]}
```

`edit_path` 是**行级覆盖**：真实数据里 `CD_jp.gtx` 的 13 页中有 292 行住在增量文件里，
写它们必须写到那个文件。绝大多数行没有这个字段，用文件级 `edit.path`。

### `images.json`

```jsonc
{ "total": 937, "categories": { "all": 937, "event": 768, "costume": 52, "tutorial": 117 },
  "statuses": { "all": 937, "localized": 937, "original_only": 0 },
  "tasks": [{
    "task_id": "event_0057_info.unity3d:173530774192334429", "bundle": "event_0057_info.unity3d",
    "kind": "ui_texture", "category": "event", "category_name": "🎪 活动宣传与公告横幅",
    "width": 512, "height": 512,
    "localized_path": "images/localized/event_0057_info/173530774192334429_info_01.png",
    "localized_url": "media/localized/event_0057_info/173530774192334429_info_01.png",   // 站点内相对路径
    "localized_file": "173530774192334429_info_01.png", "localized_sha256": "…",
    "original_path": "images/original/original/event_0057_info/…_info_01.png",
    "original_sha256": "…", "original_published": false,
    "has_localized": true, "review_status": "user_approved_for_isolated_install_staging"
  }]}
```

- `localized_url` 相对**站点根目录**（Pages 可能是子路径 `/repo/`），所以没有前导斜杠；
  CI 把 `images/localized/**` 复制到 `public/media/localized/**` 后地址才成立。
- 日文原图只有清单里的路径与哈希，**没有可下载的字节**，因此 `original_published` 恒为 `false`，
  数据里**没有** `original_url`（上游清单的 `distribution` 地址实测 404）。
- `--image-base <url>` 可以把 `media/` 指到别处（例如自己的 CDN）。

## 单人写入（唯一写路径）

没有服务端：浏览器用**你自己**的 GitHub token 直接调 Contents API。设置页提供两个 GitHub 官方
入口（细粒度新建页 / 经典 token 预勾 public_repo 的链接），粘贴后「验证」会用该 token 实查
GET /repos/{repo} 的 permissions.push——scope 列表只说"能写所有公开仓库"，仓库权限才是权威答案。

**这里没有 OAuth，而且做不了**：实测 github.com/login/oauth/access_token、
github.com/login/device/code、github.com/login/oauth/authorize 都不返回
Access-Control-Allow-Origin（同一时刻 pi.github.com/user 有），所以静态页面既拿不到设备码，
也无法完成授权码换 token（那还需要一个不能公开的 client secret）。真要 OAuth 就得加一个换码代理，
那是一个必须运维的服务端——本项目的取舍是不要它。

1. `GET /repos/{repo}/contents/{path}?ref={ref}` 拿文件当前内容与 `sha`。
2. 逐行扫描 JSONL，按 `edit.identity_field`（`item_key` 或 `index`）找到唯一匹配行；
   0 行 → `not_found`，多行 → `ambiguous`，**不猜**。
3. 重算 `sha256(ja)` 与 `source_sha256` 比对（客户端仓的清单则直接比 `source` 字符串）。
   不一致 → `source_changed`，拒绝写入。
4. **字节级替换**：只替换那一行的 `zh`（以及可选 `status`）字符串字面量，其余字节一个不动；
   替换后重新解析整份文件并逐字段比对，确保只有目标字段变了。
5. `PUT` 带 `sha` + `branch`；409/422 → `conflict`，**不自动重试、不覆盖**。

写路径取 `line.edit_path ?? record.edit.path`；两者都不存在 → `field_missing`。
token 只写进本机 `localStorage['mltd.pat']`，不进 URL、不进提交信息、不进日志。
`public/lib/github-write.js` 在 Node 下也能跑（不碰 `localStorage`），`test/test_github_write.mjs` 的
34 个用例就是纯 Node 跑的。

## 不变量（测试守着）

| 不变量 | 守在哪 |
| --- | --- |
| 每一行的 `source_sha256 == sha256(source)` | 生成器运行时 + 两个契约测试 |
| `totals` = 各分类之和；分类 = 各 bundle 之和；bundle = 各页之和 | 两个契约测试 |
| 四类计数 `translated + pending + untranslated + not_needed == total`（行 / 页 / bundle / 分类 / totals 全层级） | 两个契约测试 |
| `not_needed` 的行一定没有译文；且不会被写回上游 | 两个契约测试 + 写入模块测试 |
| 进度分母恒为 `total - not_needed`（`progressOf` / `progressPercent` 两处口径一致） | 两个契约测试 |
| 索引指向的每个页文件都存在，且行数一致 | 前端契约测试 |
| 没有孤儿文件（产物里每个文件都被某个索引引用） | 生成器契约测试 |
| 唯一 `item_key`（同一 bundle 内不重复，否则写入会 `ambiguous`） | 两个契约测试 |
| `edit.path` 恒为权威文件；`edit_path` 只在需要时出现且指向另一个文件 | 两个契约测试 |
| 图片地址都是 `media/…` 相对路径且**不含** 404 的 `distribution` 地址 | 前端契约测试 |
| 同样输入 → 逐字节相同输出（`generated_at` 例外） | 生成器契约测试 |
| 缺清单时告警、不伪造 commit、不产出空站点 | 生成器契约测试 + CI 产物校验 |
| 每个 `localized_url` 都有对应文件 | CI（`public/` 里真的 `existsSync`） |

## 与旧契约的关系

2026-10 的重构删掉了 Worker/D1/协作时代的运行时。旧读接口的逐字段契约与旧界面清单保留为
考古记录（行号针对删除前的提交 `7011fd8`）：[`LEGACY-READ-CONTRACT.md`](LEGACY-READ-CONTRACT.md)、
[`LEGACY-UI-INVENTORY.md`](LEGACY-UI-INVENTORY.md)。本文件描述的判定规则，多数是从那份旧契约里
被证伪/澄清的假设中挑出来的（版本轴、清单权威性、歌词身份、图片地址——都在真实数据上验过）。
