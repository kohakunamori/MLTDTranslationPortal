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

只授权**一个仓库**、只给**一个权限**，泄露的影响面最小（GitHub 官方文档也建议优先用细粒度 Token）。

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
  - `✗ … 只有读权限` → Contents 设成了 Read-only；
  - `验证失败：GitHub rejected the token (401)` → token 打错、被撤销或已过期。
- 顶部会出现 **已配置 Token · 可写** 的小标签；清除 Token 后整站回到只读。

### 权限给错了怎么改

- **细粒度 Token**：回 [Token 列表](https://github.com/settings/personal-access-tokens) → 点开这个 Token →
  **Edit** → 调整 Repository access / Permissions → **Save**。**token 值不变**，不用回站点重新粘贴；
  同一个页面还能延长 Expiration。只有点了 **Regenerate token** 才会换新值（那时才需要重新粘贴）。
- **经典 Token**：scope 建好之后不能改，只能 **Delete** 掉旧的、用新 scope 重新生成一个
  （或者在建的时候就把 `public_repo` 勾上——站点给的链接已经预勾了）。

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
| `Token 权限不足（需要 Contents: Read and write）`（403） | 权限没给写；GitHub 原文是 `Resource not accessible by personal access token` | 按上面「权限给错了怎么改」调整：细粒度 Edit 即可（值不变），经典只能重建 |
| `✗ … 看不到 <仓库>` | 细粒度没选仓库 / 经典缺 `public_repo` | 按上面两条路线补上 |
| `上游文件里找不到这一行（可能已被移动）` | 上游刚重排过行 | 等 CI 重新生成数据（每天 03:17 UTC）或手动 Run workflow |
| `日文源文已变化，请刷新数据后重试` | 上游改了原文，页面数据是旧的 | 刷新页面（必要时等 CI） |
| `文件刚被改过（409），请刷新数据后重试` | 别人/CI 在你提交前刚写了同一个文件 | 刷新后重试；页面**不会**自动覆盖 |
| 验证通过但写入仍失败 | 没有该仓库的 push 权限（协作者只读）或仓库被归档 | 确认你有写权限 |

### 自己诊断：GitHub 会告诉你缺哪个权限

403 的响应里有一个 **`X-Accepted-GitHub-Permissions`** 头，列出这个接口需要的权限，
非常适合自查（本机有 `curl` 就能跑）：

```bash
# 1) 这个 token 是谁、有什么 scope（经典 token 才会返回 x-oauth-scopes）
curl -sS -D - -o /dev/null -H "Authorization: Bearer $TOKEN" \
  https://api.github.com/user | grep -i -E '^(HTTP|x-oauth-scopes)'

# 2) 我对这个仓库到底有没有写权限（站点「验证」用的就是这一步）
curl -sS -H "Authorization: Bearer $TOKEN" \
  https://api.github.com/repos/kohakunamori/MLTDTranslationAssets \
  | python -c "import json,sys; print(json.load(sys.stdin)['permissions'])"

# 3) 直接看写接口要什么权限（故意的空 PUT：看响应头里的 X-Accepted-GitHub-Permissions）
curl -sS -D - -o /dev/null -X PUT -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/kohakunamori/MLTDTranslationAssets/contents/README.md \
  | grep -i -E '^(HTTP|x-accepted-github-permissions)'
```

第 3 步只在**权限不足**时才有诊断价值：那种情况下响应是 **403**，并带
`X-Accepted-GitHub-Permissions: contents=write`，说明 `contents` 权限需要 **write**。
如果权限本来就有，它不会去看权限头，而是直接因为缺 body 报 422——那就说明权限没问题了。
（这个头是 GitHub 官方文档里专门为排查细粒度 Token 权限准备的。）

参考（GitHub 官方文档）：[REST API 认证](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api)、
[细粒度 Token 所需权限](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)、
[管理个人访问令牌](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)。

## 想更省事？（可选，本机命令行）

如果你更想批量改而不是一行一行点，本机已经登录过 `gh` 的话可以直接拿到同一个 Token：

```bash
gh auth token          # 打印当前 gh 登录用的 token（可直接粘进站点输入框）
gh auth status         # 看它有哪些 scope（需要 repo 或 public_repo）
```

要刷新 `gh` 的 scope：`gh auth refresh -s public_repo`。
