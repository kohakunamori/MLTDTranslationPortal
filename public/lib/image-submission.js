import { WriteError } from "./github-write.js";

export const IMAGE_SUBMISSION_PATH = "manifests/image-submissions.json";
export const MAX_SUBMISSION_BYTES = 12 * 1024 * 1024;
export const emptyImageSubmissions = () => ({ schema_version: 1, submissions: {} });
const hex64 = /^[a-f0-9]{64}$/;
const hex40 = /^[a-f0-9]{40}$/;
const fail = (code, message) => new WriteError(code, message);

export function validateImageSubmissions(document) {
  if (document?.schema_version !== 1 || !document.submissions || Array.isArray(document.submissions)
      || typeof document.submissions !== "object") throw fail("invalid_json", "图片投稿目录格式不正确");
  for (const [id, item] of Object.entries(document.submissions)) {
    if (!id.includes(".unity3d:") || item?.status !== "pending" || !hex64.test(item.source_sha256 || "")
        || !hex64.test(item.candidate_sha256 || "") || item.path !== `images/submissions/${item.candidate_sha256}.png`
        || !Number.isInteger(item.width) || !Number.isInteger(item.height) || item.width <= 0 || item.height <= 0
        || item.width * item.height > 16_777_216 || !/^[a-zA-Z0-9-]{1,80}$/.test(item.revision || "")
        || typeof item.note !== "string" || item.note.length > 1000
        || typeof item.submitted_at !== "string" || !Number.isFinite(Date.parse(item.submitted_at))) {
      throw fail("invalid_json", "图片投稿记录不正确");
    }
  }
  return document;
}

function apiRoot(repo, ref) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "") || typeof ref !== "string" || !ref.trim()) throw fail("invalid_edit", "缺少投稿仓库或分支");
  return `https://api.github.com/repos/${repo}`;
}

export function applyImageSubmissions(tasks, document, { repo, ref, urlFor } = {}) {
  validateImageSubmissions(document);
  if (!urlFor) apiRoot(repo, ref);
  for (const task of tasks) {
    const item = Object.hasOwn(document.submissions, task.task_id) ? document.submissions[task.task_id] : null;
    task.submission_record = item;
    task.submission = item && item.source_sha256 === task.original_sha256
      && item.width === task.width && item.height === task.height && task.status !== "derived" ? item : null;
    task.submission_url = task.submission ? (urlFor ? urlFor(item)
      : `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${item.path}`) : null;
  }
}

export function validateSubmissionPng(bytes, task) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_SUBMISSION_BYTES) throw fail("invalid_image", "PNG 文件不能超过 12 MiB");
  if (bytes.length < 45 || ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) throw fail("invalid_image", "请选择完整的静态 PNG 图片");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const typeAt = (offset) => String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
  if (view.getUint32(8) !== 13 || typeAt(8) !== "IHDR") throw fail("invalid_image", "PNG 图片头不正确");
  const width = view.getUint32(16), height = view.getUint32(20);
  if (!width || !height || width * height > 16_777_216 || width !== task.width || height !== task.height) {
    throw fail("invalid_image", `请上传与完整原图相同尺寸的 PNG（${task.width}×${task.height}），当前为 ${width}×${height}`);
  }
  let imageData = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset), type = typeAt(offset);
    const end = offset + length + 12;
    if (end > bytes.length || type === "acTL") throw fail("invalid_image", "不支持损坏或带动画的 PNG");
    if (type === "IDAT") imageData = true;
    if (type === "IEND") {
      if (length || end !== bytes.length || !imageData) break;
      return { width, height };
    }
    offset = end;
  }
  throw fail("invalid_image", "PNG 文件不完整");
}

export async function prepareSubmissionImage(file, task) {
  if (!file || file.size > MAX_SUBMISSION_BYTES) throw fail("invalid_image", "PNG 文件不能超过 12 MiB");
  const bytes = new Uint8Array(await file.arrayBuffer());
  validateSubmissionPng(bytes, task);
  // 真实解码检查文件，提交时保留上传的 PNG 字节，避免改变像素和色彩信息。
  const blob = new Blob([bytes], { type: "image/png" });
  const image = await createImageBitmap(blob);
  try {
    if (image.width !== task.width || image.height !== task.height) throw fail("invalid_image", "图片解码尺寸与原图不一致");
    return { bytes, blob };
  } finally { image.close(); }
}

async function request(fetchImpl, url, token, { method = "GET", body, accept = "application/vnd.github+json", allowMissing = false } = {}) {
  let response;
  try {
    response = await fetchImpl(url, { method, cache: "no-store", headers: {
      Accept: accept, "X-GitHub-Api-Version": "2026-03-10", ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
  } catch { throw fail("network_error", "投稿连接失败，请检查网络；如在提交最后一步中断，请重新拉取数据确认结果"); }
  if (allowMissing && response.status === 404) return null;
  if (!response.ok) {
    const code = ({ 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict", 422: "conflict" })[response.status] || "http_error";
    throw fail(code, `投稿请求失败（HTTP ${response.status}）`);
  }
  return response.json();
}

export async function loadImageSubmissions({ repo, ref, token = "", fetchImpl = globalThis.fetch }) {
  const root = apiRoot(repo, ref);
  if (token) {
    const document = await request(fetchImpl, `${root}/contents/${IMAGE_SUBMISSION_PATH}?ref=${encodeURIComponent(ref)}`, token,
      { accept: "application/vnd.github.raw+json", allowMissing: true });
    return document === null ? emptyImageSubmissions() : validateImageSubmissions(document);
  }
  const response = await fetchImpl(`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${IMAGE_SUBMISSION_PATH}`, { cache: "no-store" });
  if (response.status === 404) return emptyImageSubmissions();
  if (!response.ok) throw fail("http_error", "无法读取图片投稿目录");
  return validateImageSubmissions(await response.json());
}

function requireObjectSha(value) {
  if (!hex40.test(value || "")) throw fail("invalid_json", "GitHub 未返回有效的提交凭据");
  return value;
}

function toBase64(bytes) {
  let text = "";
  for (let start = 0; start < bytes.length; start += 0x8000) text += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(text);
}

export async function commitImageSubmission({ repo, ref, token, task, bytes, note = "", expectedRevision = null,
  fetchImpl = globalThis.fetch, now = () => new Date().toISOString(), revision = () => crypto.randomUUID() }) {
  if (!token?.trim()) throw fail("no_token", "先在设置中配置有资源仓库写入权限的 GitHub Token");
  const root = apiRoot(repo, ref);
  if (!task?.task_id?.includes(".unity3d:") || task.kind?.startsWith("bundle_") || task.status === "derived"
      || !hex64.test(task.original_sha256 || "") || !task.original_url
      || (!task.composition && task.image_layout !== "complete")) throw fail("invalid_edit", "请先选择有完整原图的图片");
  validateSubmissionPng(bytes, task);
  if (typeof note !== "string" || note.length > 1000) throw fail("invalid_edit", "投稿备注不能超过 1000 字");
  const candidateSha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((v) => v.toString(16).padStart(2, "0")).join("");
  const branchPath = `heads/${ref.split("/").map(encodeURIComponent).join("/")}`;
  const branch = await request(fetchImpl, `${root}/git/ref/${branchPath}`, token);
  const head = requireObjectSha(branch?.object?.sha);
  const parent = await request(fetchImpl, `${root}/git/commits/${head}`, token);
  const baseTree = requireObjectSha(parent?.tree?.sha);
  const document = await loadImageSubmissions({ repo, ref: head, token, fetchImpl });
  const previous = Object.hasOwn(document.submissions, task.task_id) ? document.submissions[task.task_id] : null;
  if ((previous?.revision ?? null) !== expectedRevision) throw fail("conflict", "这张图刚有新投稿，请重新拉取数据后查看");
  const submission = { status: "pending", source_sha256: task.original_sha256, candidate_sha256: candidateSha,
    path: `images/submissions/${candidateSha}.png`, width: task.width, height: task.height,
    revision: revision(), submitted_at: now(), note: note.trim() };
  document.submissions[task.task_id] = submission;
  validateImageSubmissions(document);
  // PNG 与目录在同一提交出现：任何中间失败都不会发布半份投稿。
  const blob = await request(fetchImpl, `${root}/git/blobs`, token, { method: "POST", body: { content: toBase64(bytes), encoding: "base64" } });
  const tree = await request(fetchImpl, `${root}/git/trees`, token, { method: "POST", body: { base_tree: baseTree, tree: [
    { path: submission.path, mode: "100644", type: "blob", sha: requireObjectSha(blob?.sha) },
    { path: IMAGE_SUBMISSION_PATH, mode: "100644", type: "blob", content: `${JSON.stringify(document, null, 2)}\n` },
  ] } });
  const commit = await request(fetchImpl, `${root}/git/commits`, token, { method: "POST", body: {
    message: `portal: 提交汉化图片 ${task.task_id}`, tree: requireObjectSha(tree?.sha), parents: [head],
  } });
  const sha = requireObjectSha(commit?.sha);
  const updated = await request(fetchImpl, `${root}/git/refs/${branchPath}`, token, { method: "PATCH", body: { sha, force: false } });
  if (updated?.object?.sha !== sha) throw fail("invalid_json", "提交结果未确认，请重新拉取数据查看");
  return { document, submission, commit: { sha, html_url: `https://github.com/${repo}/commit/${sha}` } };
}
