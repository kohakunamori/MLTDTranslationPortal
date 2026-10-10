# 曲名数据：门户与 MLTDLocalServer 的对接约定

本文写给两边维护者：说明**谁产出、谁消费、怎么对账**。方向是单向的
（MLTDLocalServer → 门户），门户不往对方写任何东西。

## 为什么需要这条链路

游戏里同一首歌会挂多个资源包：

- **主包**：`scrobj_flyers.unity3d`，带正式曲名（`Flyers!!!`）。
- **扩展版本**：`scrobj_flye39.unity3d`、`scrobj_ahhan+.unity3d`，**自己不带曲名**，
  但抓来的数据里写着它挂在哪首歌下面。

门户的曲名表（`public/lib/terms.js` 的 `SONG_MASTER`）只登记主包，所以扩展版本原本只能
把资源名当名字显示（页面上就是一串 `scrobj_ahhan+`，而且因为编号为 0 还排在最前面）。
2026-10-10 上游一次批量发现 59 个新资源包，这个问题一次暴露了出来。

## 产出方：MLTDLocalServer

| 产物 | 位置 | 说明 |
| --- | --- | --- |
| 内容覆盖层（库） | `runtime/content-overlay.sqlite`、`fullsave/canonical/local-fullsave-content.sqlite` | 入库、由它的 CI 每次抓包刷新；`song` 表里 `current_catalog_json.name` 是曲名，`policy_json` 里 `song.extend_song_status_list` 是扩展版本关系 |
| 发版记录 | `ci/fullsave/latest/RELEASE.json` | `overlay_sha256`、`run_number`、`commit`、资产版本；用于对账 |

覆盖层里的 `song` 表：435 行，其中 **432 首带正式曲名**；扩展版本关系 51 条（含主包自列）。

## 消费方：本门户

```bash
npm run data:import-song-names     # 读对方的库 -> 导出 public/lib/song-variants.json（入库）
npm run data                       # 生成数据；日志会点名仍缺曲名的曲目束
```

- 脚本：`scripts/import_song_names.mjs`（源优先级：`--authority` 小文件接口 > `--sqlite` 覆盖层库 > `--overlay` JSON 导出）。
- 产物：`public/lib/song-variants.json`，记录本次导入的源、`sha256`、资产版本和对方发版信息。
- **服务器上不需要抓包数据**：生成数据时只读这份已入库的导出；所以每天自动更新不受对方是否可访问影响。
- 手工兜底：`terms.js` 的 `SONG_MASTER_EXTRA`（抓包之后的新曲）与 `SONG_VARIANT_OVERRIDES`
  （抓包没覆盖、用歌词逐行比对确认的条目）。生成器查不到曲名时不猜名字，改为在日志里点名。

## 对账

导入时脚本会：

1. 比对曲名与门户表，列出"抓包有、表里没有"的曲目（= 需要补 `SONG_MASTER_EXTRA` 的新曲）；
2. 列出同名但写法不同的曲目（多为全角/半角标点，无需处理）；
3. **用覆盖层 sha256 与对方 `RELEASE.json` 的 `overlay_sha256` 对齐**，对不上会明确警告
   （常见原因：抓包后还没发版，或读到的不是发版产物）。

最近一次对账：对方第 80 次发版 / 提交 `f074cae0` / 资产版本 `1077741`，
覆盖层 sha256 `564a0347…e219a`，两边一致；432 首曲名逐条吻合，7 处差异仅为标点写法。

## 可选的加强（需要产出方配合）

现在门户要刷新曲名，得在**装有 MLTDLocalServer 的机器上**跑一次导入再提交。要做到全自动，
产出方可以在 CI 里多写一个小文件：

```json
{
  "schema": "mltd-song-name-authority-v1",
  "asset_version": "1077741",
  "songs":    [{ "resource_id": "flyers", "name": "Flyers!!!" }],
  "variants": [{ "resource_id": "flye39", "parent_resource_id": "flyers" }]
}
```

建议路径 `ci/fullsave/latest/song-name-authority.json`（约 50 KB，入库）。门户这边已经支持：

- 脚本会自动优先用它（`--authority`），不再需要打开 SQLite 开关、也不必读 20 MB 的库；
- 服务器上可以每天直接从 GitHub 拉这个小文件刷新对照，做到"对方抓包 → 门户第二天自动跟上"。

在对方产出该文件之前，本条链路保持"本地导入 + 提交"的手动节奏，功能不受影响。

## 自动同步的三种做法

**卡点**：MLTDLocalServer 是**私有仓库**，服务器匿名拉不到它的数据（`raw.githubusercontent.com` 返回 404）。
所以"完全自动"必须解决凭据问题，三条路：

| 做法 | 怎么做 | 代价 | 评价 |
| --- | --- | --- | --- |
| **A（推荐）** | MLTDLocalServer 的 CI 多一步：跑门户的 `scripts/import_song_names.mjs`（或自己按 `mltd-song-name-authority-v1` 导出），把结果**提交到门户仓库**（公开）。门户仓库是公开的，服务器每天例行 `git fetch` 时就顺带拿到了 | 需要一次性给它的 CI 一个能 push 门户仓库的令牌；对方 CI 每天多跑十几秒 | 门户不需要令牌、不占 Actions 额度（门户的自动触发已停用），对方数据一变第二天就生效 |
| **B** | 在服务器上放一个**只读**令牌（仅该私有仓库、仅读），`generate.sh` 先看发版指纹（`RELEASE.json` 里的 `overlay_sha256`），变了才下载 21 MB 覆盖层并现场导出 | 服务器上多一个只读凭据（root-only）；下载 21 MB 时约几秒 | 不用改对方仓库；但与"令牌只留在浏览器"的既有取舍不完全一致 |
| **C** | 保持现状：在装有 MLTDLocalServer 的机器上跑 `npm run data:import-song-names` 再提交 | 零新凭据；需要人动手 | 目前就是这样，功能不受影响 |

三种做法都只影响"曲名对照多久刷新一次"；**真正的新歌**（抓包还没有的）无论如何都要手工补一条
`SONG_MASTER_EXTRA`，生成器会在日志里点名。等对方下一次抓到包含该曲目的存档，自动同步就会接管它。

### 方案 A 的现成材料（本仓库已备好）

| 文件 | 用途 |
| --- | --- |
| `ops/publish-song-names.sh` | 对方 CI 调用的脚本：在门户检出里读它的覆盖层库 → 导出对照 → **数据真的变了才**提交推送 |
| `ops/mltdlocalserver-ci-step.yml` | 直接粘进对方 workflow 的步骤片段（含一次性令牌配置说明） |

对方那边只需三步：建一个只对门户仓库有 `Contents: Read and write` 的细粒度令牌 →
存成对方仓库的 `PORTAL_SYNC_TOKEN` secret → 把片段里那一步加进它的 CI。

安全阀（任一触发都只报错、不提交）：

1. 导出的对照里有指向不存在曲目的条目（说明库或曲名表对不上）；
2. 对照条数比上一次少 20% 以上（防止 CI 读到空库/陈旧库把对照冲掉）。

另外两条经验（都来自一次真实的演练）：

- **不要在服务器检出里手工跑这个脚本**：它的用途是在对方 CI 里跑（那边的检出带推送令牌、库也在检出内）。
  在服务器检出里跑会留下一个本地提交；推送失败时脚本现在会自动撤销该提交，但仍不该那样用。
- **库必须放在对方仓库的检出里**，脚本才能顺着找到 `ci/fullsave/latest/RELEASE.json`。找不到时它会明确提醒：
  对照照常导出，但文件里会缺发版号与资产版本，可能产生一次多余的提交。

配套的一个小改动：`song-variants.json` 现在是**可复现**的——不含时间戳、路径记对方发版记录里的
规范路径，所以"数据没变"时重跑不会产生差异，机器人不会天天提交。

## 不做的事

- 门户不写回 MLTDLocalServer，也不依赖它在线提供服务。
- 译文回写走的是另一条链路（上游 `MLTDTranslationAssets`），与本约定无关。
