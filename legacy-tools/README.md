# Legacy offline Portal tools — frozen migration copy

2026-10-03，text-localization；历史上下文为 JP 9.0.200 arm64 / frozen1077100。
本目录仅接收旧仓 3 个有限离线维护/历史导入工具及 3 个对应测试，保持
`scripts/*.py` 与 `scripts/test_*.py` 的原相对布局和原始字节。源仓保留，
没有删除或改写。此有限复制任务已冻结，等待主 Agent 独立验收。

| 工具 | 历史用途 | 本地写入范围由调用者显式指定 |
| --- | --- | --- |
| `scripts/export_translation_portal_catalogue.py` | JSONL → source_catalogue SQL 文件 | `--catalogue` / `--out-dir`，历史 `--base-version` |
| `scripts/sync_github_to_portal_catalogue.py` | locales → contribution seed SQL 文件 | `--repo-root` / `--out-dir`，可选 `--files` |
| `scripts/sync_portal_snapshot_to_github.py` | 历史 snapshot → locales 文件改写 | `--snapshot` / `--repo-root`，支持 `--dry-run` |

这些名称中的 GitHub 不表示脚本会调用 GitHub API。工具只依赖 Python 标准库；
复制的原测试依赖 pytest，其相邻 `scripts` 导入和第一个测试的 ROOT/SCRIPT
路径在本布局下仍指向本目录，不需要主仓或 sibling fallback。本次未安装 pytest、
未运行原 pytest 套件、未接入产品 npm test 或 CI；另以一次 stdlib 合成测试验证
三个工具的有限文件行为。未添加生产 wrapper、调度或第二 producer。

输入只有私有槽位：调用者自行提供 `<private-catalogue.jsonl>`、
`<private-locales-root>`、`<private-snapshot.jsonl>`、`<isolated-output-dir>`。
本目录不含真实输入、SQL 输出、旧 queue、配置、凭据或数据库；不要把这些输入
提交或放进本目录。路径适配 0 项，产品根下的 schema/migrations 未复制，未运行
bootstrap，也未建立数据库。SQL 文本生成不证明可导入当前 schema。

## 语义边界与目标 owner 待办

历史 `accepted` 是旧 publisher 语义，不能视为当前 GitHub PR 审核或发布授权。
snapshot 工具会直接写 `status=accepted`，不检查当前 Portal PR 权威；本目录不能
作为在线 accept/review/publish 路由，不得重新启用已经返回 410 的旧写流程。
已有 Portal fork/PR 产品源码 43 文件不属于本次修改范围。

以下是源码静态发现，按要求保留原字节、登记给目标 owner，不在迁移中修复：

- snapshot 查找使用输入 bundle 构造 glob/path，缺少 resolved-path containment
  校验；仅限可信隔离输入，不宣称能安全接收外部输入。
- snapshot 缺 source hash 时仍可能写入；不核验版本轴/status，重复 key 后项覆盖，
  多 bundle 的写入不具全任务事务性，后续错误可能留下前面的文件更新。
- catalogue 的 base_version 是 opaque，历史测试包含复合版本；不能据此为新产品
  独立 Client/Assets 版本轴背书。contribution 工具虽然拒绝复合资产轴，仍沿用
  旧 base_version 表列与 accepted/admin seed 语义。
- contributions 批大小缺正数校验、显式 files 未检查属于 repo-root；输出目录
  可覆盖同名 SQL，不能指向正式产物。缺 pending/审核授权证明不能由旧状态补齐。

外部旧 script caller 是否还在使用：未知。本次未扩大调查，复制完成不意味着
旧仓完全退役、完整 Portal 迁移或生产部署切换。现有业务缺陷优先留待迁移验收后。

## 证据与唯一下一步

迁移证据见
[HANDOFF](D:/Project/mltd-current/work/agents/text-localization/repo-retirement-portal-tools-20261003/HANDOFF.md)；
逐文件 source/target SHA-256、before/scoped status、字节 diff、源码字面量秘密
扫描的计数/位置、一次合成测试结果位于
[隔离 run](D:/Project/mltd-current/build/runs/text-localization/9.0.200/repo-retirement-portal-tools-20261003)。
源码秘密检查仅是有界 regex + AST 扫描，0 命中不构成完整安全审计。

下一步：主 Agent 只读独立验收六文件 hash/字节一致性及本 README 的历史边界，
将已登记风险交给目标 owner；业务修复与真实数据/部署切换另行立项。
