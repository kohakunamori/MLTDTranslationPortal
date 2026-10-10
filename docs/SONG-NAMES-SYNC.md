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

## 不做的事

- 门户不写回 MLTDLocalServer，也不依赖它在线提供服务。
- 译文回写走的是另一条链路（上游 `MLTDTranslationAssets`），与本约定无关。
