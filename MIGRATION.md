# Portal 本地源码迁移

迁移日期：2026-10-03。唯一今后维护源码：`D:/Project/MLTDTranslationPortal`。旧主仓 `D:/Project/mltd-current/web/translation-portal` 作为 archive 保留；本次仅复制，原文件未删除、移动或改写。旧仓导航未修改；本地迁移交由独立 review 验收。

## 范围与来源

按历史 SOURCE manifest 的 43 文件白名单复制主仓现盘最新字节，保持相对路径。源与目标逐文件 SHA-256 和 size 账在 [repo-retirement-portal-migration-20261003 manifest](D:/Project/mltd-current/build/runs/text-localization/9.0.200/repo-retirement-portal-migration-20261003/source-target-manifest.json)。43/43 复制字节一致；与历史候选漂移 0 项：无。不回滚已有 WIP。另加 `.gitignore` 和本文件。Git 仅本地初始化，没有 stage、commit、remote、push。

JP 9.0.200 arm64 / frozen1077100 仅历史上下文。Portal 的 Client / Assets 版本轴独立，不合并为复合版本。

## 验证及未解决问题

- 本次既有 `npm test` 只运行一次：exit 0。日志与详细检查见 [repo-retirement-portal-migration-20261003](D:/Project/mltd-current/build/runs/text-localization/9.0.200/repo-retirement-portal-migration-20261003)；测试失败留待独立 review，未修逻辑、未加 skip。Python 仅 AST 语法检查，不重跑历史 42 个测试。npm 日志部分非 ASCII 输出受 Windows 子进程编码影响出现替代字符，退出码与 ASCII PASS 行可读；未为修日志重跑。
- 运行源码 import 静态闭包问题 0 项（5 处注释误报已逐行排除）；部署和真实业务闭环仍未验证。README 保留原始字节，其中旧路径、操作说明或历史部署记录应结合本迁移边界阅读，不能当作本次执行证据。
- 历史主仓 `test_config.mjs` 会可选读取旧 TOML 的行为未修改；目标不含 TOML。本次未读取或 hash `wrangler.toml.example`、真实数据库及 sidecar、秘密、private/raw、生成 snapshot，未复制 node_modules 或 .wrangler。
- 历史 sourceclaim 的 before 原始 capture 不完整：验收报告说明 reverse-patch 可重现 raw hash，不证明原始 capture 被保留；本次仅核对当前字节，不追认历史 before。历史 actor 与 reviewer 的 TOML 越界仍保留，不能用本次通过清除。参见 [原 HANDOFF](D:/Project/mltd-current/work/agents/text-localization/repo-simplification-b5-portal-source-20261002/HANDOFF.md) 与 [独立 ACCEPTANCE](D:/Project/mltd-current/work/agents/text-localization/repo-simplification-b5-portal-source-review-20261002/ACCEPTANCE.md)。
- 数据库及生产部署尚未切换。未 adopt DB、未迁移真实数据、未运行 Wrangler（包括 dry-run）、未部署；OAuth / GitHub / R2 / NAS / 设备及队列未验收。未安装依赖、未 npx、未联网。

## 唯一有限下一步

独立 reviewer 对本目标的 43 文件、实际 hash/size 账、静态闭包、Gitignore 和一次测试结果进行只读验收；发现问题先记录，修复另议，不将 DB/部署切换绑定为复制前置。
