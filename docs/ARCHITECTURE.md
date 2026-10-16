# 仓库模块化架构

本仓库保持零构建依赖，但按职责划分模块。入口文件负责编排，纯逻辑模块不依赖 DOM、网络或进程环境，适配器负责把副作用接到外部系统。

## 分层

```text
领域事实
  public/lib/terms.js
  public/lib/taxonomy.js
       ↓
纯数据逻辑
  public/lib/data.js         静态数据读取、索引解析、筛选
  public/lib/pagination.js   通用分页
  public/lib/read-stats.js   阅读页计数与增量合并
       ↓
浏览器界面工具
  public/lib/ui.js           DOM 工具与安全文本渲染
  public/app.js              路由、状态、视图和事件绑定

生成管线
  scripts/build_data.mjs     参数解析与管线编排
  scripts/fs-utils.mjs       确定性文件遍历
  scripts/output-sink.mjs    收集、写盘、漂移比较、原子替换
       ↓
  public/data/**              版本化静态数据产物

写入边界
  public/lib/token-storage.js 本机 Token 存取
  public/lib/github-write.js 纯文本编辑、校验与 GitHub Contents API
  public/lib/relay-write.js  中继选择与浏览器退路
  scripts/relay-core.mjs    服务端 git/写入服务（可独立测试）
  scripts/relay.mjs          HTTP 适配与进程生命周期
```

## 依赖规则

- `public/lib` 的纯模块只能依赖领域事实或同层纯模块；不能读取 DOM、读取文件、启动网络请求或写日志。
- `public/app.js` 是浏览器组合根。视图函数可以依赖纯模块，但纯模块不能反向导入 `app.js`。
- `scripts/build_data.mjs` 只编排输入、转换和输出；文件系统行为集中在 `fs-utils.mjs` 与 `output-sink.mjs`。
- GitHub、中继、静态服务器和 CI 判断都属于适配器。新增外部服务时，应新增适配器并保持领域逻辑不变。
- 上游写入状态由 `github-write.js` 的 `normalizeWriteStatus` 统一校验；浏览器直连和中继保留各自的错误文案。`not_needed` 是展示派生状态，不能写回；已有上游状态词汇保持兼容。
- 生成数据的 schema 由 `docs/DATA-CONTRACT.md` 约束；模块之间传递对象时不得依赖隐式字段或页面状态。

## 事实来源与生产消费者

`terms.js` 的主曲名表、补充表和人工覆盖项有明确优先级；LocalServer 导出的 `song-variants.json` 提供扩展版本关系与默认演唱信息。生成器只在一处组合这些事实，不能把不同字段或补充规则当作重复副本删除。

生产调度和托管配置由本仓之外的运维环境管理；本站生成与同源中继复用本仓逻辑。读取上游与写入上游的检出分别服务定时生成和 git 提交，保留各自职责。Pages 工作流仍是手动备份入口，`legacy-tools` 是明确隔离的历史工具，不属于这些生产调用链。

## 扩展方式

- 新增筛选或排序：扩展 `public/lib/data.js` 的纯函数，并给它增加无浏览器测试。
- 新增页面：在 `app.js` 注册路由和视图，复用 `ui.js`、`pagination.js`，不要复制 DOM/分页工具。
- 新增上游资源类型：在 `taxonomy.js` 增加规则，在生成器管线加入适配器，保持输出记录格式稳定。
- 新增写入目标：实现与 `commitLineEdit` 相同的“读取、校验源文哈希、单次提交”协议，不把凭据或网络细节带进纯编辑逻辑。
- 任何模块拆分都必须保留现有契约测试，并为新边界增加直接测试；`npm test` 是合并前的最低门槛。

## 当前验证

前端契约测试会检查入口 import、DOM id、静态路径和生成产物；生成器契约测试覆盖确定性、分页、对账和失败关闭；写入与中继测试覆盖字节级修改、权限、冲突和路径安全。
