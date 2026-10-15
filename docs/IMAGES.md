# 图片汉化目录

`#images` 为独立的图片汉化页。每条记录始终保留日文原图、汉化图片两栏，点击可放大对照并分别下载。列表、灯箱及下载均为经过拼接的完整图片，不直接显示 Texture2D 纹理图集。状态、分类、关键字、原图可用性、排序和页码均记录在 URL 中。

旧版只读取 `manifests/images.manifest.json` 的 937 张已审核汉化图，既没有完整待处理目录，也没有发布原图；因此不能用旧版显示的总数推断全部图片已经汉化。

## 数据来源与计数

`scripts/image_data.mjs` 由主生成器调用，按以下来源合并：

- `manifests/images.manifest.json`（或 `--image-tasks` 指定的清单）：纹理级记录，可包含尚无汉化图的任务。
- `images/original/**`：纳入已发布原图，按来源路径或包名与纹理 ID 匹配已有记录；新的未审核原图列为待确认。纹理 ID 始终按字符串处理，避免 64 位 ID 丢失精度。
- `manifests/localization-coverage.json` 的 `images.families.*.missing_reviewed_bundles`：补充没有图片记录的待确认资源包，按包名去重。缺少这份清单时页面明确提示目录不完整。

图片张数与待确认资源包数分别统计；一个包可能包含多张图片，也可能只是缩略图或无需汉化的插画。覆盖报告不能证明某包一定含有待翻译日文，因此包级占位记录不会直接列为已确认需要汉化的图片。

`images.json` 保留 `total/categories/statuses/tasks`，补充 `manifest_total`（用于与审核清单对账）、`texture_count`、`inventory_bundle_count`、`thumbnail_bundle_count` 和 `coverage`。`portal.image_statuses` 与图片索引一致。

状态分别为 `localized`（已汉化）、`original_only`（已收录但无汉化图）、`pending`（待确认汉化需求或审核）、`derived`（缩略图，随原图派生）、`not_needed`（明确无需汉化）。「未汉化（含待确认）」筛选合并 `original_only` 与 `pending`，不含缩略图与无需汉化项。

缩略图资源包按上游 `configs/image-resources.json` 的 `thumbnail_rules` 识别（漫画、白板、单格漫画、博客、称号背景、活动横幅的 `*_thumb.unity3d`）。上游 `manifests/image-family-audit.json` 对这几类的结论是 `derive_from_approved_parent`：缩略图从已审核原图派生，不单独翻译，也不单独送审。因此它们单独计数，不计入待翻译资源包；原图未汉化时，缩略图同样是日文。当前数据里 6,394 个待确认资源包中有 2,301 个属于这一类。

## 原图与发布

`scripts/image-compositions.json` 保存 1,108 份源图哈希绑定的 Sprite 布局，覆盖现有 937 张已审核汉化纹理。生成器按原图 SHA-256 绑定配方；浏览器使用同一布局裁切、旋转并拼接两侧图片，下载时导出完整 PNG。尺寸显示为完整图尺寸，原纹理尺寸保留在 `texture_width/texture_height`。未知布局的纹理显示「完整图尚未拼接」，不冒充完整图。

布局可从上游的源资源绑定目录确定性导入，不包含模型图片或候选审核状态：

```sh
node scripts/import_image_compositions.mjs <reconstructed-preprocess/catalog.json> <internal-composites> scripts/image-compositions.json
```

`original.relative_path` 或哈希本身不代表文件已发布。生成器只为资源仓 `images/original/**` 内真实存在的文件提供 `original_url`，并在清单提供哈希时核验一致性。兼容旧清单重复的 `original/original/` 路径；缺图时保留定位信息并显示占位，不从旧对象存储模板推断下载地址。

与本页面配套，资源仓已补齐现有清单的 937 张日文原图，并逐一通过原始哈希校验。937 份拼接布局也逐一与上游保存的完整原图比较像素，结果一致。

将原图和汉化图按清单路径放到资源仓后，先生成数据，再发布索引引用的媒体：

```sh
node scripts/build_data.mjs --assets-root vendor/MLTDTranslationAssets --client-root vendor/MLTDTranslationClient --out public/data
node scripts/copy_image_media.mjs vendor/MLTDTranslationAssets public/data/images.json public/media
```

媒体发布脚本同时校验并复制原图与汉化图的源文件，仅复制索引有地址的文件。候选图不会因为存在于工作目录就自动成为审核通过的汉化图。缺失被引用的文件会阻止发布。Pages 备用发布流程已使用此脚本。自托管如已将 `public/media` 链接到资源仓 `images`，可沿用这个媒体挂载；否则需在数据生成后调用发布脚本。

`npm test` 包含目录合并、去重、状态与组合筛选、原图哈希、发布文件以及索引对账检查。
