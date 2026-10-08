# 怎么创建一个 GitHub Token（单行修改用）

站点的"改一行译文并提交"功能需要在**你自己**的浏览器里持有一个能写翻译仓库的 token。
本指南给两条路，选一条就行。**token 只保存在你这台浏览器的 `localStorage` 里，站点只把它发给
`api.github.com`，没有别的服务器经手**（页面本身是 GitHub Pages 上的静态文件）。

---

## 30 秒版

1. 打开站点 → **设置** → 点 **① 一键新建 Token**（推荐）或 **或：用经典 Token（勾好权限）**。
2. 在 GitHub 页面点 **Generate token** → 复制那串 `github_pat_…` / `ghp_…`（**只显示这一次**）。
3. 回站点粘贴 → **保存** → **验证**。看到 `✓ 已登录 @你的用户名：对 …/MLTDTranslationAssets 有写权限` 就成了。

---

## 路线 A：细粒度 Token（推荐）

只授权**一个仓库**、只给**一个权限**，泄露的影响面最小。

1. 打开 <https://github.com/settings/personal-access-tokens/new>
   （设置页的「① 一键新建 Token」就是它）。
2. 填四个字段：

   | 字段 | 填什么 |
   | --- | --- |
   | **Token name** | `MLTD 翻译查阅站`（随便起，只是给你自己认） |
   | **Expiration** | 建议 **90 days**；也可以选更短。到期后重新生成一次即可（站点会提示 401） |
   | **Description** | 可留空，例如"单行译文提交" |
   | **Repository access** | 选 **Only select repositories** → 勾 **`kohakunamori/MLTDTranslationAssets`** |

3. 展开 **Permissions → Repository permissions**，找到 **Contents**，把访问级别改成
   **Read and write**（改完这一项，下面的 `Metadata: Read-only` 会自动被带上，这是正常的）。
4. 点 **Generate token** → 复制 `github_pat_…`。

> 只有想改**客户端仓库**里的资源（真实数据里就 1 个：底部栏清单 `manifests/bottom-bar.manifest.json`）
> 才需要再加 `kohakunamori/MLTDTranslationClient`，权限同样只给 Contents: Read and write。

## 路线 B：经典 Token（最省事，但权限更宽）

站点里那个「或：用经典 Token（勾好权限）」链接指向
<https://github.com/settings/tokens/new?scopes=public_repo&description=MLTD%20翻译查阅站（单行提交）>，
已经帮你预勾好 **`public_repo`**、填好说明：

1. 打开链接（没预勾上的话，手动勾 **`public_repo`**）。
2. 点 **Generate token** → 复制 `ghp_…`。

**代价要说清楚**：`public_repo` 等于"对**你名下所有公开仓库**的读写"，而细粒度 Token 只给一个仓库。
两个翻译仓都是公开仓库，所以功能上没问题；如果你名下还有别的公开仓库，建议用路线 A。

---

## 粘贴与验证

- 设置页 → 输入框粘贴 → **保存**（写进本机 `localStorage`）→ **验证**。
- 「验证」不只是查你是谁：它会真的去问 GitHub `GET /repos/{仓库}` 的 `permissions.push`，
  然后明确告诉你结果：
  - `✓ 已登录 @you：对 …/MLTDTranslationAssets 有写权限` → 可以去阅读页改译文了；
  - `✗ … 这个 Token 看不到 <仓库>` → 细粒度 Token 忘了在 Repository access 里勾选仓库，
    或经典 Token 没勾 `public_repo`；
  - `✗ … 只有读权限` → Contents 设成了 Read-only，改成 Read and write 后**重新生成**一个 Token；
  - `验证失败：GitHub rejected the token (401)` → token 打错、被撤销或已过期。
- 顶部会出现 **已配置 Token · 可写** 的小标签；清除 Token 后整站回到只读。

## 安全

- **只在这台机器上保存**：换电脑/换浏览器要重新粘贴；共享电脑上用完点「清除」。
- **不要**把 token 贴进聊天、issue、截图、别的网站。任何拿到它的人都能以你的身份提交。
- 提交时 token 走 `Authorization` 请求头，**不会**出现在 URL、提交信息或页面日志里（测试守着这一点）。
- 一旦怀疑泄露：<https://github.com/settings/tokens>（经典）或
  <https://github.com/settings/personal-access-tokens>（细粒度）→ 找到它 → **Revoke**，
  然后重新生成一个。
- 想随时掐掉：撤销 token 就等于关闭了站点的写入能力，站点其余部分照常浏览。

## 排错对照表

| 站点提示 | 真正的原因 | 怎么办 |
| --- | --- | --- |
| `Token 无效` / `GitHub rejected the token (401)` | token 复制不全、已撤销、已过期 | 重新生成并粘贴 |
| `Token 权限不足（需要 Contents: Read and write）`（403） | 权限没给写 | 改 Contents 为 Read and write，**重新生成** token |
| `✗ … 看不到 <仓库>` | 细粒度没选仓库 / 经典缺 `public_repo` | 按上面两条路线补上 |
| `上游文件里找不到这一行（可能已被移动）` | 上游刚重排过行 | 等 CI 重新生成数据（每天 03:17 UTC）或手动 Run workflow |
| `日文源文已变化，请刷新数据后重试` | 上游改了原文，页面数据是旧的 | 刷新页面（必要时等 CI） |
| `文件刚被改过（409），请刷新数据后重试` | 别人/CI 在你提交前刚写了同一个文件 | 刷新后重试；页面**不会**自动覆盖 |
| 验证通过但写入仍失败 | 没有该仓库的 push 权限（协作者只读）或仓库被归档 | 确认你有写权限 |

## 想更省事？（可选，本机命令行）

如果你更想批量改而不是一行一行点，本机已经登录过 `gh` 的话可以直接拿到同一个 Token：

```bash
gh auth token          # 打印当前 gh 登录用的 token（可直接粘进站点输入框）
gh auth status         # 看它有哪些 scope（需要 repo 或 public_repo）
```

要刷新 `gh` 的 scope：`gh auth refresh -s public_repo`。
