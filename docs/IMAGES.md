# 图片汉化目录

`#images` 为独立的图片汉化页。每条记录始终保留日文原图、汉化图片两栏，点击可放大对照并分别下载。列表、灯箱及下载均为经过拼接的完整图片，不直接显示 Texture2D 纹理图集。状态、分类、关键字、原图可用性、排序和页码均记录在 URL 中。

旧版只读取 `manifests/images.manifest.json` 的 937 张已审核汉化图，既没有完整待处理目录，也没有发布原图；因此不能用旧版显示的总数推断全部图片已经汉化。

## 数据来源与计数

`scripts/image_data.mjs` 由主生成器调用，按以下来源合并：

- `manifests/images.manifest.json`（或 `--image-tasks` 指定的清单）：纹理级记录，可包含尚无汉化图的任务。
- `images/original/**`：纳入已发布原图，按来源路径或包名与纹理 ID 匹配已有记录；新的未审核原图列为待确认。纹理 ID 始终按字符串处理，避免 64 位 ID 丢失精度。
- `manifests/image-originals.manifest.json`：从未审核资源包实际导出的完整原图，含源版本、包哈希、Sprite 布局及输出哈希；以「已收录未汉化」纳入，独立于已审核译图清单对账。完整图文件必须真实存在并通过哈希校验，多个资源可以共享同一个内容寻址文件。
- `manifests/localization-coverage.json` 的 `images.families.*.missing_reviewed_bundles`：补充没有图片记录的待确认资源包，按包名去重。缺少这份清单时页面明确提示目录不完整。

图片张数与待确认资源包数分别统计；一个包可能包含多张图片，也可能只是缩略图或无需汉化的插画。覆盖报告不能证明某包一定含有待翻译日文，因此包级占位记录不会直接列为已确认需要汉化的图片。

`images.json` 保留 `total/categories/statuses/tasks`，补充 `manifest_total`（用于与审核清单对账）、`texture_count`、`inventory_bundle_count`、`thumbnail_bundle_count` 和 `coverage`。`portal.image_statuses` 与图片索引一致。

状态分别为 `localized`（已汉化）、`original_only`（已收录但无汉化图）、`pending`（待确认汉化需求或审核）、`derived`（缩略图，随原图派生）、`not_needed`（明确无需汉化）。「未汉化（含待确认）」筛选合并 `original_only` 与 `pending`，不含缩略图与无需汉化项。

缩略图资源包按上游 `configs/image-resources.json` 的 `thumbnail_rules` 识别（漫画、白板、单格漫画、博客、称号背景、活动横幅的 `*_thumb.unity3d`）。上游 `manifests/image-family-audit.json` 对这几类的结论是 `derive_from_approved_parent`：缩略图从已审核原图派生，不单独翻译，也不单独送审。因此它们单独计数，不计入待翻译资源包；原图未汉化时，缩略图同样是日文。原有 8 个图片家族的覆盖快照共列出 6,394 个未审核资源包，其中 2,301 个是缩略图，4,093 个是完整图资源包。完成原图导出后，对应包级占位由实际图片取代，不能把旧快照的 4,093 当作剩余缺图数。

## 原图与发布

`scripts/image-compositions.json` 保存 1,108 份源图哈希绑定的 Sprite 布局，覆盖现有 937 张已审核汉化纹理。生成器按原图 SHA-256 绑定配方；浏览器使用同一布局裁切、旋转并拼接两侧图片，下载时导出完整 PNG。尺寸显示为完整图尺寸，原纹理尺寸保留在 `texture_width/texture_height`。未知布局的纹理显示「完整图尚未拼接」，不冒充完整图。

布局可从上游的源资源绑定目录确定性导入，不包含模型图片或候选审核状态：

```sh
node scripts/import_image_compositions.mjs <reconstructed-preprocess/catalog.json> <internal-composites> scripts/image-compositions.json
```

`original.relative_path` 或哈希本身不代表文件已发布。生成器只为资源仓 `images/original/**` 内真实存在的文件提供 `original_url`，并在清单提供哈希时核验一致性。兼容旧清单重复的 `original/original/` 路径；缺图时保留定位信息并显示占位，不从旧对象存储模板推断下载地址。

与本页面配套，资源仓已补齐现有清单的 937 张日文原图，并逐一通过原始哈希校验。937 份拼接布局也逐一与上游保存的完整原图比较像素，结果一致。

资源仓 `scripts/export_portal_originals.py` 继续提取覆盖快照中的未审核完整图资源：漫画按六个 Sprite 的编号纵向拼接，切片宽度少量差异（2% 以内，允许两像素取整误差）且居中 pivot 时保留原像素居中补透明边；横幅、教学和白板按明确的双 Sprite 布局拼接；贴图按独立 Sprite 提取。输出为逐像素校验的无损 WebP，浏览器仍将完整图下载为 PNG。源包仅下载、读取，不调用翻译模型，也不发布汉化替换包。不能确定布局的包保留占位，原因保存在原图目录的 `unresolved` 中。目录只表示原图可查看，日文内容和汉化需求仍需筛选审核。

将原图和汉化图按清单路径放到资源仓后，先生成数据，再发布索引引用的媒体：

```sh
node scripts/build_data.mjs --assets-root vendor/MLTDTranslationAssets --client-root vendor/MLTDTranslationClient --out public/data
node scripts/copy_image_media.mjs vendor/MLTDTranslationAssets public/data/images.json public/media
```

媒体发布脚本同时校验并复制原图与汉化图的源文件，仅复制索引有地址的文件。候选图不会因为存在于工作目录就自动成为审核通过的汉化图。缺失被引用的文件会阻止发布。Pages 备用发布流程已使用此脚本。自托管如已将 `public/media` 链接到资源仓 `images`，可沿用这个媒体挂载；否则需在数据生成后调用发布脚本。

磁盘较小的自托管服务器可在资源仓稀疏检出中排除 `images/original/complete/`，并给生成命令加 `--hydrate-originals --complete-originals-root /work/complete-originals`。完整原图必须存在 Git 工作区以外；否则后续快进同步也可能按稀疏规则清除已下载的媒体。缓存从资源仓当前固定提交的 GitHub 原始文件地址恢复，流式核验哈希后原子落盘；已有文件异常则拒绝覆盖。已有图片保留本地缓存，日常生成无需重新下载。恢复选项会写媒体，禁止与只读的 `--check` 同用。

现网将完整原图持久保存在工作区以外的部署专用目录，在 Nginx 为对应 URL 设置独立目录映射；原有 `public/media` 挂载继续提供审核译图和历史原图。部署配置需包含：

```nginx
location ^~ /media/original/complete/ {
    # 替换为部署环境的本地目录；不要将真实部署路径写入公开文档。
    alias /path/to/complete-originals/;
    add_header Cache-Control "public, max-age=31536000, immutable";
    add_header X-Content-Type-Options nosniff always;
    error_page 404 = @complete_original_missing;
}
location @complete_original_missing {
    add_header Cache-Control "no-store" always;
    add_header X-Content-Type-Options nosniff always;
    return 404;
}
```

如果需要复制完整静态产物，可将独立缓存目录作为 `copy_image_media.mjs` 的第四个参数。索引输出继续使用相同的相对媒体 URL，不暴露服务器路径。

`npm test` 包含目录合并、去重、状态与组合筛选、原图哈希、发布文件以及索引对账检查。

## 无需汉化的人工标记

未汉化且已具备完整原图的卡片和放大对照中提供“无需汉化”按钮。配置有资源仓库 Contents 写入权限的 GitHub Token 后，按钮直接通过 GitHub Contents API 保存到 `manifests/image-review-decisions.json`，不改写生成的原图目录或已审核汉化清单。保存成功后立刻更新列表、筛选和计数，并显示提交凭据与“撤销上次操作”；在“无需汉化”筛选中也可长期撤销标记。写入失败保留原状态。

文档格式为 `{ "schema_version": 1, "decisions": { "<task_id>": { "status": "not_needed", "source_sha256": "<原图 SHA-256>", "revision": "<UUID>" } } }`。生成器与前端共同应用标记；图片源哈希变更时旧决定失效。撤销前检查记录版本，写入时检查文件 blob SHA，避免覆盖其他人的修改。已汉化图和派生缩略图不提供此按钮。

进入页面时读取最新标记，已配置 Token 的浏览器从 GitHub API 读取；公共浏览器读取原始文件，可能受 GitHub 公共缓存影响。数据重新生成后标记也随静态目录发布。Token 仅随 API 请求头发送，不能写入标记文件、URL 或日志。大于 1 MB 的标记文档按不可变 blob 读取。

资源仓已有 `scripts/incremental_images.py` 使用日文 OCR；其 `ocr_no_text` 只表示没有检测到文字。细小字、装饰字、竖排和低对比文字可能漏识别，因此这些结果适合筛选人工复核候选，不能直接转换为“无需汉化”的最终结论。当前人工标记功能不调用翻译模型，也不把 OCR 空结果自动落为最终决定。

## 提交汉化图

卡片与放大对照的“提交汉化图”打开完整图片投稿窗口。下载并编辑完整原图后，选择同尺寸的静态 PNG（最多 12 MiB），并排预览原图与投稿，可填写最多 1000 字备注。浏览器检查 PNG 结构、真实解码和完整图尺寸，保留上传文件原始字节。需要使用在设置中配置的资源仓库 Contents 写入 Token。

图片保存到 `images/submissions/<PNG SHA-256>.png`，元信息保存在 `manifests/image-submissions.json` 的 `submissions[task_id]` 中，包括源图哈希、投稿哈希、尺寸、备注、时间和记录版本。上传使用 Git Data API，在原分支完整树上一次提交图片与目录，再进行普通快进更新。最后一步失败不会把半份投稿加入分支；并发提交不重试覆盖，需重新拉取数据后查看。网络在最后一步中断时结果可能尚未确认，应重新拉取后判断，避免重复操作。

提交成功后原图旁显示汉化投稿，并可通过“已提交汉化（待审核）”筛选查看；有已审核汉化图时继续展示已审核图，点“查看／更新投稿”预览待审版本。更新投稿检查旧版本，历史图与记录由 Git 保留。原图哈希或完整图尺寸变化后旧投稿不再作为当前图片展示。

投稿只进入待审核目录。它不会写入 `images.manifest.json`、人工批准清单或游戏替换包；后续应依据现有源包绑定、人工审核及资源重打包流程处理。生成器核验已登记投稿的 PNG、尺寸与哈希，静态媒体发布只复制这些明确登记且匹配当前源图的候选文件。投稿本身和“已汉化”计数保持区分。
