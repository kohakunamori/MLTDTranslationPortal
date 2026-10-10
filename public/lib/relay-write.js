// 单行写入的传输层：优先走自托管中继，走不通就退回浏览器直连 GitHub。
//
// 为什么要有这一层：GitHub 的文件接口对超过 1MB 的文件不给内容，5 个大文件里装着一半的
// 行，那些行只有让服务器用它本地的 git 才改得动。浏览器这边只发"改哪一行、改成什么"，
// 几 KB 的请求。Token 仍然只存在浏览器里，每次随请求带给中继，中继不保存。
//
// 和 `github-write.js` 的关系：那边负责"怎么精确改一行"以及直连 GitHub 的旧路径；这里
// 只负责换一条传输。两者返回同样的结构，调用方不用分情况。

import { WriteError, commitLineEdit } from "./github-write.js";

/// 中继地址：和站点同源，所以不需要任何配置，也不会跨站。
export const RELAY_ENDPOINT = "/api/edit";

/// 站点可能同时存在于两个地方（自托管 + 旧的 GitHub Pages）。探到"这里没有中继"要记住，
/// 否则旧站点上每次保存都白发一个请求；但不能记一辈子 —— 页面开着不动、服务器后上线，
/// 一个永久的否定结论会把整个会话锁死在直连上（**实际踩过**：标签页比中继先打开，之后
/// 所有保存都绕过服务器，而大文件因此改不动）。所以否定结论会过期，过一会儿再探一次。
let relayState = null; // null = 还没探过；true = 有；false = 没有
let relayStateAt = 0;
const RELAY_NEGATIVE_TTL_MS = 5 * 60 * 1000;

export function resetRelayState() {
  relayState = null;
  relayStateAt = 0;
}

function rememberRelay(state) {
  relayState = state;
  relayStateAt = Date.now();
}

/// 该不该再试中继：肯定结论一直有效；否定结论过期后重新当"没探过"。
function relayUsable() {
  if (relayState !== false) return true;
  return Date.now() - relayStateAt > RELAY_NEGATIVE_TTL_MS;
}

function relayWriteError(payload, status) {
  const code = typeof payload?.error === "string" && payload.error !== "" ? payload.error : "http_error";
  const message = typeof payload?.message === "string" && payload.message !== "" ? payload.message : `中继返回 ${status}`;
  return new WriteError(code, message, { status, path: payload?.path });
}

/// 判断"这个地址上没有中继"，而不是"中继说这次编辑有问题"。
/// 路由级 404 用 `no_route`，GitHub Pages 那边则返回一坨 HTML——两种都算没有中继。
async function looksLikeNoRelay(response) {
  if (response.status === 405 || response.status === 501) return true;
  if (response.status !== 404) return false;
  const text = await response.text();
  try {
    const payload = JSON.parse(text);
    return payload?.error === "no_route";
  } catch (error) {
    return true;
  }
}

/**
 * 提交一行修改。
 *
 * @param {object} options 与 `commitLineEdit()` 相同（token / edit / line / translation /
 *   status / message），另加 `endpoint` 与 `fetchImpl`（测试用）。
 * @returns {Promise<{commit: {sha: string, html_url: string}|null, path: string,
 *   lineNumber: number|null, previous: string|null, previousStatus: string|null,
 *   changed: boolean}>}
 * @throws {WriteError} 中继明确拒绝时抛出的错误码与直连路径一致（no_token /
 *   unauthorized / forbidden / not_found / conflict / source_changed / ...），
 *   所以界面上的提示文案不用改。
 */
export async function commitEdit(options) {
  const opts = options && typeof options === "object" ? options : {};
  const endpoint = typeof opts.endpoint === "string" && opts.endpoint !== "" ? opts.endpoint : RELAY_ENDPOINT;
  const request = typeof opts.fetchImpl === "function" ? opts.fetchImpl : globalThis.fetch;

  const token = typeof opts.token === "string" ? opts.token.trim() : "";
  if (token === "") throw new WriteError("no_token", "a GitHub personal access token is required");

  const edit = opts.edit || {};
  const line = opts.line || {};
  const body = {
    repo: edit.repo,
    ref: edit.ref,
    kind: edit.kind,
    path: line.edit_path || edit.path,
    identity_field: edit.identity_field ?? line.identity_field ?? null,
    item_key: line.item_key,
    manifest_index: line.manifest_index,
    source_sha256: line.source_sha256,
    translation: opts.translation ?? null,
    status: opts.status ?? null,
    message: opts.message,
  };

  if (relayUsable()) {
    let response = null;
    try {
      response = await request(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    } catch (error) {
      // 网络不通：当作这个地址上没有中继，走直连。
      rememberRelay(false);
      response = null;
    }

    if (response) {
      if (response.ok) {
        rememberRelay(true);
        const payload = await response.json();
        return {
          commit: payload?.commit ?? null,
          path: payload?.path || body.path,
          lineNumber: payload?.lineNumber ?? null,
          previous: payload?.previous ?? null,
          previousStatus: payload?.previousStatus ?? null,
          changed: payload?.changed !== false,
        };
      }
      if (await looksLikeNoRelay(response)) {
        rememberRelay(false);
      } else {
        rememberRelay(true);
        let payload = null;
        try {
          payload = await response.json();
        } catch (error) {
          payload = null;
        }
        throw relayWriteError(payload, response.status);
      }
    }
  }

  return commitLineEdit(opts);
}
