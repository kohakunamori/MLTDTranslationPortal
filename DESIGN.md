# DESIGN.md — 765PRO Live Theater Editorial Visual System

## 美学方向：765PRO Live Theater Editorial

灵感源自舞台演出节目单（剧场场刊）与幕后审校台账的结合：
- **日间模式（Stage Program Ivory）** 以柔和温暖的场刊米白为纸面基底，减少长时间对照日文原文与中文译文的视觉眩光，突出剧场深茜红品牌主色与清晰的数据排版层级。
- **夜间模式（Backstage Charcoal）** 采用低反射剧场后台炭灰与墨黑层级，保持歌词与剧本台词在高可读度下平静呈现，杜绝高饱和霓虹紫或刺眼荧光发光特效。

## 色彩令牌（Light & Dark，全状态 WCAG AA ≥ 4.5:1）

| 语义角色 | 浅色模式 | 深色模式 | 用途说明 |
| --- | --- | --- | --- |
| `--bg` | `#faf8f5` | `#111318` | 页面底色 |
| `--surface` | `#ffffff` | `#181b22` | 卡片、工具栏、列表容器 |
| `--surface-sunken` | `#f3efe8` | `#222631` | 统计底槽、缩略图底面、代码块 |
| `--text` | `#18181b` | `#f4f4f6` | 主正文、译文、标题 |
| `--text-muted` | `#52525b` | `#a1a8b8` | 次要元信息、标签（≥ 4.5:1） |
| `--border` | `#e4dfd6` | `#2c3240` | 1px 结构细线分隔 |
| `--primary` | `#b4234e` | `#ff7a9a` | 主色文字、链接、悬停高亮 |
| `--primary-fill` | `#b4234e` | `#c82858` | 实心按钮/激活态背景（配 `#ffffff` 白字 ≥ 4.9:1） |
| `--primary-tint` | `#fff1f4` | `#321a24` | 悬停底色、主动筛选项底色 |
| `--accent` | `#0369a1` | `#7dd3fc` | 舞台宝蓝：多页标记、无需翻译、术语下划线 |
| `--gold` | `#b45309` | `#fbbf24` | 舞台琥珀金：待确认数量与状态 |
| `--success` | `#047857` | `#34d399` | 翡翠绿：已确认、可写状态 |
| `--teal` | `#0f766e` | `#5eead4` | 深海青：缩略图派生徽章与嘉宾兜底色 |
| `--danger` | `#b91c1c` | `#fca5a5` | 告警与危险操作 |

## 排版与空间系统

- **字体族**：`"Noto Sans SC", "Noto Sans CJK SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif`；对日文原文节点统一设置 `lang="ja"`，兼顾平/片假名与日文汉字字形区分。
- **数字对齐**：进度百分比、行号、页码、统计卡、资源数量全量启用 `font-variant-numeric: tabular-nums`。
- **行宽与节奏**：阅读正文控制在舒适扫视宽度内，标题上方留白大于下方留白；使用 1px `--border` 边界与中性阴影偏移建立空间层次。

## 浏览器细节表面（Browser Surfaces）

- **选中高亮（`::selection`）**：使用主色调柔和透明底配高对比前景色，不留默认系统蓝块。
- **文本光标与下划线**：全局输入控件应用 `caret-color: var(--primary)`；链接统一 `text-underline-offset: 0.22em`。
- **焦点环**：全部交互控件统一使用 `:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }`。
- **无障碍与减弱动画**：包含跳过导航链接（`.skip-link`），对话框标注 `role="dialog" aria-modal="true"`，并在 `@media (prefers-reduced-motion: reduce)` 下关闭过渡动画。

## 设计红线（Explicit Bans）

1. **禁止任何紫色/靛蓝色系（如 `#7c3aed`、`#6d28d9`、`#4338ca`、`#eef2ff`、`#f5f3ff`）**。
2. **禁止彩色发光阴影（无零偏移彩色光晕 `box-shadow`）**。
3. **禁止重复条纹/棋盘渐变装饰（`repeating-conic-gradient` 等）**。
4. **禁止无功能装饰的粗左侧彩条（`border-left: 3px`）、标题上方 eyebrow 标签、渐变文字、以及充当按钮图标的 Emoji 字符** —— 统一采用尺寸一致的 16×16 线性内联 SVG 图标。
