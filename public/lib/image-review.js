// 人工判断独立于生成的原图目录；原图更新时旧判断自动失效。
import { WriteError } from "./github-write.js";

export const IMAGE_REVIEW_PATH = "manifests/image-review-decisions.json";
export const emptyImageReviews = () => ({ schema_version: 1, decisions: {} });
const hex64 = /^[a-f0-9]{64}$/;

export function validateImageReviews(value) {
  if (value?.schema_version !== 1 || !value.decisions || Array.isArray(value.decisions)
      || typeof value.decisions !== "object") throw new WriteError("invalid_json", "图片标记文件格式不正确");
  for (const [id, decision] of Object.entries(value.decisions)) {
    if (!id.includes(".unity3d:") || decision?.status !== "not_needed"
        || !hex64.test(decision.source_sha256 || "") || !/^[a-zA-Z0-9-]{1,80}$/.test(decision.revision || "")) {
      throw new WriteError("invalid_json", "图片标记记录不正确");
    }
  }
  return value;
}

export function applyImageReviews(tasks, document) {
  validateImageReviews(document);
  for (const task of tasks) {
    task.base_status ??= task.status;
    task.status = task.base_status;
    task.review_decision = Object.hasOwn(document.decisions, task.task_id) ? document.decisions[task.task_id] : null;
    if (!task.has_localized && task.base_status !== "derived" && task.review_decision
        && task.review_decision.source_sha256 === task.original_sha256) task.status = "not_needed";
  }
}

function target({ repo, ref }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "") || typeof ref !== "string" || !ref.trim()) {
    throw new WriteError("invalid_edit", "缺少图片仓库或分支信息");
  }
  return `https://api.github.com/repos/${repo}/contents/${IMAGE_REVIEW_PATH}`;
}

function errorFor(status) {
  const code = ({ 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict", 422: "conflict" })[status] || "http_error";
  return new WriteError(code, `图片标记请求失败（HTTP ${status}）`);
}

async function request(fetchImpl, url, token, options = {}) {
  let response;
  try {
    response = await fetchImpl(url, { cache: "no-store", ...options, headers: {
      Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10",
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers,
    } });
  } catch { throw new WriteError("network_error", "图片标记连接失败，请检查网络后重试"); }
  return response;
}

export async function loadImageReviews({ repo, ref, token = "", fetchImpl = globalThis.fetch }) {
  target({ repo, ref });
  if (token) return (await readReviewDocument({ repo, ref, token, fetchImpl })).document;
  // 公共读取不携带 Token，也不消耗 GitHub API 的匿名请求配额。
  const response = await fetchImpl(`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${IMAGE_REVIEW_PATH}`, { cache: "no-store" });
  if (response.status === 404) return emptyImageReviews();
  if (!response.ok) throw errorFor(response.status);
  return validateImageReviews(await response.json());
}

function sameDecision(a, b) {
  if (!a || !b) return a === b;
  return a.status === b.status && a.source_sha256 === b.source_sha256 && a.revision === b.revision;
}

async function readReviewDocument({ repo, ref, token, fetchImpl }) {
  const url = target({ repo, ref });
  const response = await request(fetchImpl, `${url}?ref=${encodeURIComponent(ref)}`, token,
    { headers: { Accept: "application/vnd.github.object+json" } });
  let sha = null;
  let document = emptyImageReviews();
  if (response.ok) {
    const blob = await response.json();
    sha = blob.sha;
    if (!/^[a-f0-9]{40}$/.test(sha || "") || blob.type !== "file") throw new WriteError("invalid_json", "图片标记文件元信息不正确");
    // 使用不可变 blob SHA 读取大文件，避免元信息与内容来自不同提交。
    if (blob.encoding === "base64") {
      const binary = atob(blob.content.replace(/\s/g, ""));
      document = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
    } else {
      const raw = await request(fetchImpl, `https://api.github.com/repos/${repo}/git/blobs/${sha}`, token,
        { headers: { Accept: "application/vnd.github.raw+json" } });
      if (!raw.ok) throw errorFor(raw.status);
      document = JSON.parse(await raw.text());
    }
  } else if (response.status !== 404) throw errorFor(response.status);
  validateImageReviews(document);
  return { document, sha };
}

export async function commitImageReview({ repo, ref, token, task, expected = null, decision = null, fetchImpl = globalThis.fetch }) {
  if (!token?.trim()) throw new WriteError("no_token", "先在设置里配置 GitHub Token 才能修改");
  const url = target({ repo, ref });
  if (!task?.task_id?.includes(".unity3d:") || !hex64.test(task.original_sha256 || "")
      || task.has_localized || task.base_status === "derived" || task.status === "derived") {
    throw new WriteError("invalid_edit", "只能标记尚未汉化且已有原图的图片");
  }
  validateImageReviews({ schema_version: 1, decisions: decision ? { [task.task_id]: decision } : {} });
  if (decision && decision.source_sha256 !== task.original_sha256) throw new WriteError("source_changed", "原图已更新，请重新确认");
  const { document, sha } = await readReviewDocument({ repo, ref, token, fetchImpl });
  const previous = Object.hasOwn(document.decisions, task.task_id) ? document.decisions[task.task_id] : null;
  if (!sameDecision(previous, expected)) throw new WriteError("conflict", "此图片的标记已被修改，请重新拉取数据后再操作");
  if (decision) document.decisions[task.task_id] = decision;
  else delete document.decisions[task.task_id];
  const bytes = new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const saved = await request(fetchImpl, url, token, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    branch: ref, ...(sha ? { sha } : {}), content: btoa(binary),
    message: `portal: ${decision ? "无需汉化" : "撤销无需汉化"} ${task.task_id}`,
  }) });
  if (!saved.ok) throw errorFor(saved.status);
  const payload = await saved.json();
  if (!/^[a-f0-9]{40}$/.test(payload.commit?.sha || "")) throw new WriteError("invalid_json", "未收到有效的保存凭据，请重新拉取数据确认");
  return { document, previous, decision, commit: payload.commit };
}
