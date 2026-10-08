# 测试夹具

这些文件是**合成夹具**，不是产品数据。

- 形状与上游两个翻译仓库一致（`locales/<dir>/<base>.jsonl`、`lyrics/songs/<base>.jsonl`、
  `manifests/portal-resource-manifest.json`、`manifests/images.manifest.json`、
  `manifests/bottom-bar.manifest.json`）。
- 日文/中文文本取自仓库里退役的静态快照
  （`local-data/retired-source/web/translation-portal/public/data/lyrics/*.json`），
  按上游 JSONL 的键名重排；`source_sha256` 由脚本按 `ja` 现算，所以永远自洽。
- `legacy_ui.gtx.jsonl` 故意带 `asset_version=9999999`，用来验证生成器会跳过并警告。
- 目录名与文件名参与分类判定，请勿重命名以免覆盖分类规则的用例。
