/**
 * github-write.js — the portal's only write path.
 *
 * Refactor context: the Cloudflare Worker + D1 collaboration portal is retired. The
 * single remaining write is "one person edits one translation line in the browser
 * with their own GitHub PAT, committing straight into the data repository".
 * See docs/DATA-CONTRACT.md §"单人写入" and §"bundles/<category>/<bundle>.json".
 *
 * Invariants enforced here (everything fails closed — never guess):
 *
 *  1. The PAT lives in `localStorage['mltd.pat']` only. It travels as an
 *     `authorization` request header and NEVER appears in a URL, in a thrown
 *     message, in a `WriteError.detail` object, or in console output. This module
 *     contains no logging calls at all.
 *  2. A JSONL edit is byte-surgical: the file is split on "\n", exactly one line is
 *     rewritten through `replaceJsonStringField()`, and every other byte of the
 *     file survives untouched. A manifest edit cannot be byte-surgical (there is no
 *     line to splice), so it rewrites the whole document with
 *     `JSON.stringify(obj, null, 2) + "\n"`.
 *  3. A row is addressed by (identity_field, item_key, sha256(source)). The identity
 *     field is named per file by the generated data — `item_key` for the JSONL files
 *     under `locales/`, `index` for `lyrics/songs/*.jsonl` rows (those carry
 *     no `item_key` at all, and `index` is a JSON number, not a string). A row matches
 *     when `String(row[identity_field]) === String(item_key)`, so `index: 126` is
 *     addressed as `"126"`; a row that does not own the identity field never matches,
 *     because this writer cannot add keys and must never guess a row. The hash is
 *     recomputed here from `ja` (falling back to `source`) — a `source_sha256` stored
 *     inside the row is never accepted as proof. A mismatch means the upstream source
 *     text moved on, and the caller must regenerate `public/data/` instead of writing.
 *  4. Optimistic concurrency: the blob `sha` returned by the read is sent back with
 *     the write. 409/422 is surfaced as `conflict` and is never retried.
 *
 * No dependencies, no `window`/`document`/`localStorage` access at module top level:
 * the file is import-safe both from a browser `<script type="module">` and from Node
 * (used by test/test_github_write.mjs).
 */

/* -------------------------------------------------------------------------- */
/* constants                                                                   */
/* -------------------------------------------------------------------------- */

/** localStorage key holding the user's personal access token. */
export const PAT_STORAGE_KEY = "mltd.pat";

const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "mltd-portal";

/**
 * The JSON representation of the contents API. NOTE: the task sketch also mentioned
 * `application/vnd.github.raw+json`, but that media type makes GitHub return the
 * *raw file bytes*, which carries neither a base64 `content` field nor an easily
 * readable `sha` in the body — and this module needs both back from one request.
 * The JSON media type is therefore the only workable one:
 *   https://docs.github.com/rest/repos/contents#get-repository-content
 */
const JSON_ACCEPT = "application/vnd.github+json";

const HEX64 = /^[0-9a-f]{64}$/i;
const REPO_FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Field names that mean "the translation slot of this row", resolved per row by
 * `translationKeyFor()`. Everything else is taken literally.
 */
const TRANSLATION_SLOT_ALIASES = new Set(["", "auto", "translation"]);

/**
 * 行身份字段的缺省名。上游有两套行布局：`locales` 目录里的 JSONL 行用字符串
 * `item_key`，`lyrics/songs/*.jsonl` 的行没有 `item_key`，身份字段是数值 `index`。
 * 生成数据（`public/data/` 里的 `edit.identity_field`）总是显式给出字段名，这里
 * 的缺省值只为兼容不带该字段的旧调用点。
 */
export const DEFAULT_IDENTITY_FIELD = "item_key";

/* -------------------------------------------------------------------------- */
/* errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every refusal in this module is a `WriteError`; nothing is ever guessed.
 *
 * Codes: no_token, no_fetch, invalid_edit, invalid_json, invalid_response,
 *        unsupported_encoding, field_missing, ambiguous_field, field_not_string,
 *        not_found, ambiguous, source_changed, unauthorized, forbidden, conflict,
 *        http_error, network_error.
 */
export class WriteError extends Error {
  constructor(code, message, detail = null) {
    super(message || code);
    this.name = "WriteError";
    this.code = code;
    this.detail = detail === undefined ? null : detail;
  }
}

function fail(code, message, detail = null) {
  return new WriteError(code, message, detail);
}

/* -------------------------------------------------------------------------- */
/* token storage                                                               */
/* -------------------------------------------------------------------------- */

/**
 * `localStorage` access can throw (private mode, blocked cookies, file:// in some
 * browsers), and `globalThis.localStorage` is `undefined` under plain Node, so the
 * default is resolved lazily and defensively instead of at module top level.
 */
function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function resolveStorage(storage) {
  if (storage !== undefined && storage !== null) return storage;
  return defaultStorage();
}

/**
 * @param {Storage} [storage]
 * @returns {string} the stored token, or "" when unset/unreadable. Whitespace is
 *   trimmed because a pasted token routinely carries a trailing newline. A GitHub
 *   token never contains whitespace, so trimming cannot corrupt one.
 */
export function getToken(storage = defaultStorage()) {
  const store = resolveStorage(storage);
  if (!store) return "";
  try {
    const raw = store.getItem(PAT_STORAGE_KEY);
    return typeof raw === "string" ? raw.trim() : "";
  } catch {
    return "";
  }
}

/**
 * Store (or clear) the token. `""` / whitespace-only clears the key entirely.
 *
 * @param {string} value
 * @param {Storage} [storage]
 * @returns {string} the value that is actually stored ("" when cleared or when the
 *   storage refused the write). Storage failures are swallowed on purpose: this is
 *   not a data write and must not throw into the UI.
 */
export function setToken(value, storage = defaultStorage()) {
  const store = resolveStorage(storage);
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    if (store) {
      try {
        store.removeItem(PAT_STORAGE_KEY);
      } catch {
        /* nothing else we can do */
      }
    }
    return "";
  }
  if (!store) return "";
  try {
    store.setItem(PAT_STORAGE_KEY, text);
    return text;
  } catch {
    return "";
  }
}

/* -------------------------------------------------------------------------- */
/* sha256 (own helper — the caller's hash is never trusted)                     */
/* -------------------------------------------------------------------------- */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value, bits) {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

function utf8Bytes(text) {
  return new TextEncoder().encode(String(text));
}

/**
 * Pure-JS SHA-256 over the UTF-8 bytes of `text`. Deliberately synchronous and
 * dependency-free: `crypto.subtle` is async, unavailable in some non-secure
 * contexts, and would make the "recompute the hash yourself" rule awkward to audit.
 *
 * @param {string} text
 * @returns {string} 64 lowercase hex characters
 */
export function sha256Hex(text) {
  const bytes = utf8Bytes(text);
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array((Math.floor((bytes.length + 9 + 63) / 64) * 64));
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];

    for (let i = 0; i < 64; i += 1) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  let hex = "";
  for (let i = 0; i < 8; i += 1) hex += h[i].toString(16).padStart(8, "0");
  return hex;
}

/* -------------------------------------------------------------------------- */
/* UTF-8 <-> base64                                                            */
/* -------------------------------------------------------------------------- */

function encodeBase64Utf8(text) {
  const bytes = utf8Bytes(text);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  try {
    return btoa(binary);
  } catch {
    throw fail("invalid_response", "could not base64-encode the edited file");
  }
}

function decodeBase64Utf8(value) {
  // GitHub wraps `content` at 60 characters, so newlines are expected.
  const clean = String(value).replace(/\s+/g, "");
  let binary;
  try {
    binary = atob(clean);
  } catch {
    throw fail("invalid_response", "GitHub returned file content that is not valid base64");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  try {
    // ignoreBOM: true keeps a leading U+FEFF as real text instead of silently
    // dropping it, so a decode -> edit -> encode round trip is byte faithful.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw fail("invalid_response", "GitHub returned file content that is not valid UTF-8");
  }
}

/* -------------------------------------------------------------------------- */
/* a hand-written JSON scanner (regexes get fooled by escaped quotes)           */
/* -------------------------------------------------------------------------- */

function skipWhitespace(text, index) {
  let i = index;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") i += 1;
    else break;
  }
  return i;
}

/** `text[index]` must be `"`. Returns the index just past the closing quote. */
function scanStringEnd(text, index) {
  let i = index + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      // Skips \" \\ \/ \b \f \n \r \t and \uXXXX in one step: the four hex digits
      // of a \u escape can never be a quote or a backslash.
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    i += 1;
  }
  throw fail("invalid_json", "unterminated JSON string literal");
}

/** Index just past a balanced `{...}` / `[...]` value, string literals skipped. */
function scanBalancedEnd(text, index, open, close) {
  let depth = 0;
  let i = index;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      i = scanStringEnd(text, i);
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  throw fail("invalid_json", "unbalanced JSON value");
}

function readValueSpan(text, index) {
  const c = text[index];
  if (c === '"') return { kind: "string", start: index, end: scanStringEnd(text, index) };
  if (c === "{") return { kind: "object", start: index, end: scanBalancedEnd(text, index, "{", "}") };
  if (c === "[") return { kind: "array", start: index, end: scanBalancedEnd(text, index, "[", "]") };
  if (text.startsWith("null", index) && !/[^\s,\]}]/.test(text[index + 4] ?? " ")) {
    return { kind: "null", start: index, end: index + 4 };
  }
  let i = index;
  while (i < text.length && !",}] \t\r\n".includes(text[i])) i += 1;
  return { kind: "scalar", start: index, end: i };
}

function parseStringLiteral(token) {
  try {
    const value = JSON.parse(token);
    if (typeof value !== "string") throw new Error("not a string");
    return value;
  } catch {
    throw fail("invalid_json", "could not decode a JSON object key");
  }
}

/** A correctly escaped JSON string literal for `value` (null/undefined -> ""). */
function jsonStringLiteral(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return JSON.stringify(text);
}

/**
 * Replace the *top-level* string value of `field` in one JSON object line, leaving
 * every other byte of `lineText` untouched.
 *
 * Only depth-1 keys are considered: a `"zh"` nested inside another object is not a
 * match. The existing value may be a string containing escaped quotes/backslashes/
 * `\uXXXX`, or `null`; both are replaced by a freshly encoded literal.
 *
 * @param {string} lineText one JSONL line (no trailing "\n")
 * @param {string} field top-level key name
 * @param {string|null} newValue
 * @returns {string} the line with exactly one value span substituted
 * @throws {WriteError} field_missing | ambiguous_field | field_not_string | invalid_json
 */
export function replaceJsonStringField(lineText, field, newValue) {
  if (typeof lineText !== "string") throw fail("invalid_json", "line is not a string");
  const name = String(field);
  const literal = jsonStringLiteral(newValue);
  const text = lineText;

  let i = skipWhitespace(text, 0);
  if (text[i] !== "{") throw fail("invalid_json", "line is not a JSON object");
  i += 1;

  const spans = [];
  for (;;) {
    i = skipWhitespace(text, i);
    if (i >= text.length) throw fail("invalid_json", "unterminated JSON object");
    if (text[i] === "}") break;
    if (text[i] === ",") {
      i += 1;
      continue;
    }
    if (text[i] !== '"') throw fail("invalid_json", `unexpected character at offset ${i}`);

    const keyEnd = scanStringEnd(text, i);
    const key = parseStringLiteral(text.slice(i, keyEnd));
    i = skipWhitespace(text, keyEnd);
    if (text[i] !== ":") throw fail("invalid_json", "expected ':' after an object key");
    i = skipWhitespace(text, i + 1);
    if (i >= text.length) throw fail("invalid_json", "missing value for an object key");

    const span = readValueSpan(text, i);
    if (key === name) spans.push(span);
    i = span.end;
  }

  if (spans.length === 0) throw fail("field_missing", `field "${name}" is not a top-level key`);
  if (spans.length > 1) {
    // Duplicate keys make the parsed value ambiguous ("last one wins" for
    // JSON.parse) — replacing the wrong one would silently change nothing.
    throw fail("ambiguous_field", `field "${name}" appears ${spans.length} times at the top level`);
  }

  const span = spans[0];
  if (span.kind !== "string" && span.kind !== "null") {
    throw fail("field_not_string", `field "${name}" is a JSON ${span.kind}, not a string or null`);
  }
  return text.slice(0, span.start) + literal + text.slice(span.end);
}

/* -------------------------------------------------------------------------- */
/* row addressing                                                              */
/* -------------------------------------------------------------------------- */

/** Upstream source text of a row: `ja`, else the legacy `source`. */
function rowSourceText(row) {
  if (typeof row.ja === "string") return row.ja;
  if (typeof row.source === "string") return row.source;
  return null;
}

/**
 * Which key holds the translation of this row: `zh`, or the legacy `translation`
 * when the row has no `zh` key at all. (A row carrying both is written through
 * `zh`, which is the canonical spelling — see docs/DATA-CONTRACT.md §上游解析规则.)
 */
function translationKeyFor(row) {
  const hasZh = Object.prototype.hasOwnProperty.call(row, "zh");
  const hasTranslation = Object.prototype.hasOwnProperty.call(row, "translation");
  return hasZh || !hasTranslation ? "zh" : "translation";
}

/**
 * `field` may be omitted / "auto" / "translation" (= the translation slot, spelled
 * per row) or any literal key such as "status".
 */
function resolveFieldName(row, field) {
  if (field === null || field === undefined) return translationKeyFor(row);
  const name = String(field);
  if (TRANSLATION_SLOT_ALIASES.has(name)) return translationKeyFor(row);
  return name;
}

function requireHex64(value) {
  return typeof value === "string" && HEX64.test(value.trim()) ? value.trim().toLowerCase() : null;
}

/**
 * 归一化行身份字段名。
 *
 * `undefined` / `null` 表示"调用方没给"，返回 `null` 交给上层取缺省值；非空字符串
 * 去掉首尾空白后原样使用；其余（空串、纯空白、非字符串）一律拒绝 —— 一个空的身份
 * 字段名会让文件里每一行都参与匹配，那正是"猜行"，必须失败关闭。
 *
 * @returns {string|null}
 * @throws {WriteError} invalid_edit
 */
function normalizeIdentityField(value, what = "identity_field") {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw fail("invalid_edit", `${what} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * 归一化 `item_key`（行的身份值）。
 *
 * 生成数据里它是身份字段值的字符串形式（`"85"` / `"126"`），但也接受没被字符串化
 * 的数值 —— 匹配规则本来就是两边都过 `String()`，`126` 与 `"126"` 必须等价。空串、
 * `null`/`undefined`、布尔和对象一律返回 `null`：地址不明确时失败关闭，绝不猜行。
 *
 * @param {unknown} value
 * @param {{trim?: boolean}} [options] 只影响字符串：`true` 去掉首尾空白
 * @returns {string|null}
 */
function normalizeItemKey(value, { trim = false } = {}) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const text = trim ? value.trim() : value;
  return text === "" ? null : text;
}

/**
 * Shared JSONL writer. 按 `(identity_field, item_key)` 定位唯一的一行，并要求该行
 * 现算的源文哈希等于 `source_sha256`，然后只重写这一行。
 *
 * 身份字段缺省为 `item_key`（旧调用点兼容）。数值 `index: 126` 用字符串 `"126"`
 * 命中：两边都过 `String()`。没有身份字段的行永远不参与匹配，也绝不按行号或近似
 * 文本兜底 —— 找不到就是 `not_found`，多于一行就是 `ambiguous`。
 *
 * @param {{item_key: string, source_sha256: string, entries: Array<{field: string, value: string|null}>,
 *   identity_field?: string|null}} options
 * @returns {Promise<{text: string, lineNumber: number, previous: Object, fields: string[]}>}
 */
async function spliceJsonlLine(text, { item_key, source_sha256, entries, identity_field }) {
  if (typeof text !== "string") throw fail("invalid_edit", "jsonl text is not a string");
  const wantedKey = normalizeItemKey(item_key);
  if (wantedKey === null) {
    throw fail("invalid_edit", "line.item_key is required");
  }
  const identityField = normalizeIdentityField(identity_field) ?? DEFAULT_IDENTITY_FIELD;
  const expectedHash = requireHex64(source_sha256);
  if (expectedHash === null) {
    throw fail("invalid_edit", "line.source_sha256 must be 64 hex characters");
  }

  const lines = text.split("\n");
  const rows = new Array(lines.length).fill(null);
  const keyHits = [];
  const hashHits = [];

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.trim() === "") continue; // a trailing newline is expected, not a row
    let row;
    try {
      row = JSON.parse(raw);
    } catch {
      // Fail closed: a file we cannot fully read is a file we must not rewrite.
      throw fail("invalid_json", `line ${i + 1} of the JSONL file is not valid JSON`, { line: i + 1 });
    }
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw fail("invalid_json", `line ${i + 1} of the JSONL file is not a JSON object`, { line: i + 1 });
    }
    rows[i] = row;
    // 行没有这个身份字段就不可能是目标行（lyrics 行没有 item_key、locales 行没有
    // index），用错字段只会得到 not_found，绝不会改到别的行上。
    if (!Object.prototype.hasOwnProperty.call(row, identityField)) continue;
    if (String(row[identityField]) !== wantedKey) continue;
    keyHits.push(i);
    const source = rowSourceText(row);
    if (source === null) continue;
    if (sha256Hex(source) === expectedHash) hashHits.push(i);
  }

  if (hashHits.length === 0) {
    if (keyHits.length > 0) {
      throw fail(
        "source_changed",
        `the upstream source for ${identityField} ${wantedKey} no longer hashes to source_sha256`,
        {
          item_key: wantedKey,
          identity_field: identityField,
          line: keyHits[0] + 1,
          lines: keyHits.map((i) => i + 1),
        },
      );
    }
    throw fail("not_found", `no JSONL row has ${identityField} ${wantedKey}`, {
      item_key: wantedKey,
      identity_field: identityField,
    });
  }
  if (hashHits.length > 1) {
    throw fail(
      "ambiguous",
      `${hashHits.length} rows match ${identityField} ${wantedKey} and source_sha256`,
      { item_key: wantedKey, identity_field: identityField, lines: hashHits.map((i) => i + 1) },
    );
  }

  const index = hashHits[0];
  const row = rows[index];
  const previous = {};
  const fields = [];
  let lineText = lines[index];
  for (const entry of entries) {
    const field = resolveFieldName(row, entry.field);
    previous[field] = typeof row[field] === "string" ? row[field] : null;
    lineText = replaceJsonStringField(lineText, field, entry.value);
    fields.push(field);
  }
  lines[index] = lineText;

  return { text: lines.join("\n"), lineNumber: index + 1, previous, fields };
}

/* -------------------------------------------------------------------------- */
/* pure edit operations                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Apply one field edit to a JSONL file text.
 *
 * @param {string} text whole file text
 * @param {{item_key: string|number, source_sha256: string, field?: string, value: string|null,
 *   identity_field?: string}} options
 *   `field` defaults to the row's translation slot (`zh`, or `translation` when the
 *   row has no `zh` key). `identity_field` names the per-file row identity — `"index"`
 *   for `lyrics/songs/*.jsonl`, `"item_key"` (the default) everywhere else; the row
 *   matches when `String(row[identity_field]) === String(item_key)`, so `item_key`
 *   may be either the stringified value (`"126"`) or the raw number (`126`).
 * @returns {Promise<{text: string, lineNumber: number, previous: string|null}>}
 * @throws {WriteError} not_found | ambiguous | source_changed | field_missing | invalid_json
 */
export async function applyJsonlEdit(text, options) {
  const opts = options && typeof options === "object" ? options : {};
  const result = await spliceJsonlLine(text, {
    item_key: opts.item_key,
    source_sha256: opts.source_sha256,
    identity_field: opts.identity_field,
    entries: [{ field: opts.field, value: opts.value }],
  });
  const name = result.fields[0];
  return {
    text: result.text,
    lineNumber: result.lineNumber,
    previous: result.previous[name] ?? null,
  };
}

/**
 * Apply one edit to a client manifest (`manifests/*.manifest.json`).
 *
 * Unlike a JSONL edit, this one is NOT byte-surgical: a manifest slot is not a
 * line, so the whole document is re-serialized with `JSON.stringify(obj, null, 2)
 * + "\n"`. That is the documented trade-off (docs/DATA-CONTRACT.md §单人写入 only
 * promises byte surgery for JSONL rows).
 *
 * `status` is not part of the documented destructuring but is accepted because
 * `commitLineEdit()` has to write it; it is written whenever it is provided.
 *
 * @returns {Promise<{text: string, previous: string|null, field: string, previousStatus: string|null}>}
 * @throws {WriteError} invalid_edit | invalid_json | not_found | source_changed
 */
export async function applyManifestEdit(text, options) {
  const opts = options && typeof options === "object" ? options : {};
  if (typeof text !== "string") throw fail("invalid_edit", "manifest text is not a string");
  const index = opts.manifest_index;
  if (!Number.isInteger(index) || index < 0) {
    throw fail("invalid_edit", "line.manifest_index must be a non-negative integer");
  }
  const expectedHash = requireHex64(opts.source_sha256);
  if (expectedHash === null) {
    throw fail("invalid_edit", "line.source_sha256 must be 64 hex characters");
  }

  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw fail("invalid_json", "manifest is not valid JSON");
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw fail("invalid_json", "manifest is not a JSON object");
  }
  if (!Array.isArray(manifest.slots)) throw fail("invalid_json", "manifest has no slots[] array");
  if (index >= manifest.slots.length) {
    throw fail("not_found", `manifest slot ${index} is out of range`, {
      manifest_index: index,
      slots: manifest.slots.length,
    });
  }
  const slot = manifest.slots[index];
  if (slot === null || typeof slot !== "object" || Array.isArray(slot)) {
    throw fail("source_changed", `manifest slot ${index} is not an object`, { manifest_index: index });
  }
  const source = rowSourceText(slot);
  if (source === null || sha256Hex(source) !== expectedHash) {
    throw fail("source_changed", `manifest slot ${index} does not hash to source_sha256`, {
      manifest_index: index,
    });
  }

  const field = resolveFieldName(slot, opts.field);
  const previous = typeof slot[field] === "string" ? slot[field] : null;
  const previousStatus = typeof slot.status === "string" ? slot.status : null;

  slot[field] = opts.value === null || opts.value === undefined ? "" : String(opts.value);
  if (opts.status !== undefined && opts.status !== null) slot.status = String(opts.status);

  return { text: `${JSON.stringify(manifest, null, 2)}\n`, previous, field, previousStatus };
}

/* -------------------------------------------------------------------------- */
/* GitHub HTTP                                                                 */
/* -------------------------------------------------------------------------- */

function resolveFetch(fetchImpl) {
  const impl = fetchImpl === undefined || fetchImpl === null ? globalThis.fetch : fetchImpl;
  if (typeof impl !== "function") throw fail("no_fetch", "no fetch implementation is available");
  return impl;
}

function githubHeaders(token, accept) {
  // The token lives here and nowhere else: not in the URL, not in a message.
  return {
    authorization: `Bearer ${token}`,
    accept,
    "x-github-api-version": API_VERSION,
    "user-agent": USER_AGENT,
  };
}

/**
 * The single network shape of this module — always `fetchImpl(url, {method,
 * headers, body?})` — so tests can stub one function and see every call.
 */
async function ghRequest(fetchImpl, url, { method, token, accept = JSON_ACCEPT, body = null }) {
  const init = { method, headers: githubHeaders(token, accept) };
  if (body !== null) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    // The rejection text may echo request internals; never risk the token.
    throw fail("network_error", `GitHub request failed (${method})`, { url });
  }
  let text = "";
  try {
    text = await response.text();
  } catch {
    throw fail("network_error", `could not read the GitHub response (${method})`, { url });
  }
  return { status: response.status, ok: response.ok === true, headers: response.headers, text };
}

function encodeRepoPath(path) {
  return String(path)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function contentsUrl(repo, path, ref) {
  const base = `${GITHUB_API}/repos/${repo}/contents/${encodeRepoPath(path)}`;
  return ref ? `${base}?ref=${encodeURIComponent(ref)}` : base;
}

function parseJsonBody(response, context) {
  try {
    return JSON.parse(response.text);
  } catch {
    throw fail("invalid_response", `GitHub returned a non-JSON response for ${context}`, {
      status: response.status,
    });
  }
}

/**
 * Status -> refusal mapping. 409/422 means "the blob sha you sent is stale": that is
 * a conflict, and this module never retries it.
 */
function httpError(status, context) {
  const detail = { status };
  if (context && context.path) detail.path = context.path;
  if (status === 401) return fail("unauthorized", "GitHub rejected the token (401)", detail);
  if (status === 403) return fail("forbidden", "GitHub refused the request (403)", detail);
  if (status === 404) return fail("not_found", `GitHub returned 404 for ${context?.what ?? "the request"}`, detail);
  if (status === 409 || status === 422) {
    return fail("conflict", "the file changed since it was read; regenerate data and try again", detail);
  }
  return fail("http_error", `GitHub returned ${status}`, detail);
}

/* -------------------------------------------------------------------------- */
/* verifyToken                                                                 */
/* -------------------------------------------------------------------------- */

function parseScopes(headerValue) {
  if (typeof headerValue !== "string") return [];
  return headerValue
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope !== "");
}

/**
 * Prove that a PAT is usable before the UI enables any editing.
 *
 * One network shape (`fetchImpl(url, init)`), three possible requests: `GET /user`
 * always, `GET /repos/{repo}` only for a fine-grained `github_pat_` token with a
 * `repo` argument.
 *
 * @param {{token: string, fetchImpl?: Function, repo?: string}} options
 * @returns {Promise<{login: string, name: string, scopes: string[], canPush: boolean, repos: string[]}>}
 *   `repos` lists the repos whose push permission was actually proven (a classic
 *   token's `x-oauth-scopes` header does not enumerate repositories, so it stays
 *   empty there rather than guessing).
 * @throws {WriteError} no_token | unauthorized | forbidden | http_error | network_error
 */
export async function verifyToken(options) {
  const opts = options && typeof options === "object" ? options : {};
  const request = resolveFetch(opts.fetchImpl);
  const token = typeof opts.token === "string" ? opts.token.trim() : "";
  if (token === "") throw fail("no_token", "a GitHub personal access token is required");

  const userResponse = await ghRequest(request, `${GITHUB_API}/user`, { method: "GET", token });
  if (userResponse.status === 401) {
    throw fail("unauthorized", "GitHub rejected the token (401)", { status: 401 });
  }
  if (!userResponse.ok) throw httpError(userResponse.status, { what: "GET /user" });

  const user = parseJsonBody(userResponse, "GET /user");
  const login = typeof user?.login === "string" ? user.login : "";
  if (login === "") throw fail("invalid_response", "GitHub /user returned no login");
  const name = typeof user?.name === "string" ? user.name : "";

  const scopes = parseScopes(userResponse.headers?.get?.("x-oauth-scopes"));
  const fineGrained = token.startsWith("github_pat_");
  // Classic tokens advertise their scopes; fine-grained tokens send no scope header.
  // 这只是初判：下面探仓库拿到 permissions.push 后会被覆盖成权威答案。
  let canPush = scopes.includes("repo") || scopes.includes("public_repo") || fineGrained;

  const repos = [];
  const wanted = typeof opts.repo === "string" ? opts.repo.trim() : "";
  // 仓库权限是唯一权威的答案：经典 token 的 scope 列表只说"能写所有公开仓库"，
  // 不代表你对**这个**仓库有写权限。所以两种 token 都探一次 /repos/{repo}。
  let repoStatus = null;
  if (wanted !== "") {
    const probe = await ghRequest(request, `${GITHUB_API}/repos/${encodeRepoPath(wanted)}`, {
      method: "GET",
      token,
    });
    if (probe.status === 401) throw fail("unauthorized", "GitHub rejected the token (401)", { status: 401 });
    if (probe.ok) {
      const data = parseJsonBody(probe, `GET /repos/${wanted}`);
      const push = data?.permissions?.push === true;
      canPush = push;
      repoStatus = {
        name: wanted,
        visible: true,
        permission: push ? "write" : data?.permissions?.admin ? "admin" : "read",
      };
      if (push) repos.push(wanted);
    } else if (probe.status === 403 || probe.status === 404) {
      // 403/404 = 这个 token 连仓库都看不见（或没被选中）：一定没有写权限。
      canPush = false;
      repoStatus = { name: wanted, visible: false, permission: "none", status: probe.status };
    } else {
      throw httpError(probe.status, { what: `GET /repos/${wanted}` });
    }
  }

  return { login, name, scopes, canPush, repos, repo: repoStatus, fineGrained };
}

/* -------------------------------------------------------------------------- */
/* commitLineEdit                                                              */
/* -------------------------------------------------------------------------- */

function requireNonEmptyString(value, what) {
  if (typeof value !== "string" || value.trim() === "") {
    throw fail("invalid_edit", `${what} is required`);
  }
  return value.trim();
}

/**
 * 解析行身份字段：`edit.identity_field` 优先，其次 `line.identity_field`，都没有时
 * 退回 `item_key`（兼容不带该字段的旧生成数据）。manifest 没有"行"这个概念，也就
 * 没有身份字段，一律忽略，`identity_field` 传什么都不影响清单编辑的旧行为。
 *
 * @throws {WriteError} invalid_edit（字段名给了但不是非空字符串）
 */
function resolveIdentityField(edit, line, kind) {
  if (kind !== "jsonl") return DEFAULT_IDENTITY_FIELD;
  return (
    normalizeIdentityField(edit.identity_field, "edit.identity_field") ??
    normalizeIdentityField(line.identity_field, "line.identity_field") ??
    DEFAULT_IDENTITY_FIELD
  );
}

/**
 * Validate the `edit` object of a generated bundle file
 * (`{kind, repo, ref, path}` plus, for JSONL files, `identity_field`) and the `line`
 * it addresses.
 */
function validateTarget(edit, line) {
  if (edit === null || typeof edit !== "object" || Array.isArray(edit)) {
    throw fail("invalid_edit", "edit is missing");
  }
  const kind = edit.kind;
  if (kind !== "jsonl" && kind !== "manifest") {
    throw fail("invalid_edit", `unknown edit.kind "${kind}"`);
  }
  const repo = requireNonEmptyString(edit.repo, "edit.repo");
  if (!REPO_FULL_NAME.test(repo)) throw fail("invalid_edit", `edit.repo "${repo}" is not owner/name`);
  const ref = requireNonEmptyString(edit.ref, "edit.ref");
  if (/[\s\\?#]/.test(ref)) throw fail("invalid_edit", "edit.ref must not contain whitespace, \\, ? or #");
  const path = requireNonEmptyString(edit.path, "edit.path");
  if (path.startsWith("/") || path.includes("\\") || path.split("/").includes("..") || path.includes("//")) {
    throw fail("invalid_edit", `edit.path "${path}" is not a repository-relative path`);
  }

  if (line === null || typeof line !== "object" || Array.isArray(line)) {
    throw fail("invalid_edit", "line is missing");
  }
  const itemKey = normalizeItemKey(line.item_key, { trim: true });
  if (itemKey === null) throw fail("invalid_edit", "line.item_key is required");
  const hash = requireHex64(line.source_sha256);
  if (hash === null) throw fail("invalid_edit", "line.source_sha256 must be 64 hex characters");

  if (kind === "manifest") {
    if (!Number.isInteger(line.manifest_index) || line.manifest_index < 0) {
      throw fail("invalid_edit", "line.manifest_index must be a non-negative integer");
    }
  }

  return {
    kind,
    repo,
    ref,
    path,
    item_key: itemKey,
    source_sha256: hash,
    identity_field: resolveIdentityField(edit, line, kind),
    manifest_index: kind === "manifest" ? line.manifest_index : null,
  };
}

/**
 * Read one file from the data repository, apply exactly one line edit, and commit
 * it with the caller's PAT.
 *
 * @param {{
 *   token: string,
 *   edit: {kind: "jsonl"|"manifest", repo: string, ref: string, path: string, identity_field?: string|null},
 *   line: {item_key: string|number, source_sha256: string, manifest_index?: number, identity_field?: string|null},
 *   translation: string|null,
 *   status?: string|null,
 *   message?: string,
 *   fetchImpl?: Function,
 * }} options `edit.identity_field` (else `line.identity_field`, else `"item_key"`)
 *   names the row identity: generated data uses `"item_key"` for the JSONL files
 *   under `locales/` and `"index"` for `lyrics/songs/*.jsonl`.
 * @returns {Promise<{commit: {sha: string, html_url: string}|null, path: string,
 *   lineNumber: number|null, previous: string|null, previousStatus: string|null,
 *   changed: boolean}>} `changed: false` (and no PUT) when the file would not move.
 * @throws {WriteError} no_token | invalid_edit | unauthorized | forbidden |
 *   not_found | conflict | http_error | network_error | invalid_response |
 *   source_changed | ambiguous | field_missing | ...
 */
export async function commitLineEdit(options) {
  const opts = options && typeof options === "object" ? options : {};
  const request = resolveFetch(opts.fetchImpl);

  const token = typeof opts.token === "string" ? opts.token.trim() : "";
  if (token === "") throw fail("no_token", "a GitHub personal access token is required");

  const target = validateTarget(opts.edit, opts.line);

  const translation = opts.translation;
  if (translation !== null && translation !== undefined && typeof translation !== "string") {
    throw fail("invalid_edit", "translation must be a string or null");
  }
  const nextTranslation = translation === null || translation === undefined ? "" : translation;

  let statusValue = null;
  if (opts.status !== undefined && opts.status !== null) {
    if (typeof opts.status !== "string" || opts.status.trim() === "") {
      throw fail("invalid_edit", "status must be a non-empty string when provided");
    }
    statusValue = opts.status.trim();
    // `not_needed` 是本站按"原文有没有日文"派生的状态，上游 schema 里没有这个取值。
    // 真写进去会让上游多出一个不认识的 status，所以这里直接拒绝。
    if (statusValue === "not_needed") {
      throw fail("invalid_edit", "not_needed 是本站派生状态，写回上游请用 accepted 或 pending");
    }
  }

  const identity = target.kind === "jsonl" ? target.item_key : `slot ${target.manifest_index}`;
  const message =
    typeof opts.message === "string" && opts.message.trim() !== ""
      ? opts.message.trim()
      : `Update translation: ${target.path} (${identity})`;

  // ---- read (JSON representation: base64 `content` + blob `sha` in one answer) --
  const readResponse = await ghRequest(request, contentsUrl(target.repo, target.path, target.ref), {
    method: "GET",
    token,
  });
  if (!readResponse.ok) throw httpError(readResponse.status, { path: target.path, what: "the file" });

  const payload = parseJsonBody(readResponse, target.path);
  const sha = typeof payload?.sha === "string" && payload.sha !== "" ? payload.sha : "";
  if (sha === "") throw fail("invalid_response", "GitHub returned no blob sha", { path: target.path });
  if (payload?.encoding !== undefined && payload.encoding !== "base64") {
    // GitHub answers `encoding: "none"` with an empty body above 1 MiB.
    throw fail("unsupported_encoding", `GitHub returned encoding "${payload.encoding}"`, {
      path: target.path,
      encoding: payload.encoding,
    });
  }
  if (typeof payload?.content !== "string") {
    throw fail("invalid_response", "GitHub returned no file content", { path: target.path });
  }
  const currentText = decodeBase64Utf8(payload.content);

  // ---- edit -------------------------------------------------------------------
  let nextText;
  let lineNumber = null;
  let previous = null;
  let previousStatus = null;

  if (target.kind === "jsonl") {
    const entries = [{ field: "translation", value: nextTranslation }];
    if (statusValue !== null) entries.push({ field: "status", value: statusValue });
    const applied = await spliceJsonlLine(currentText, {
      item_key: target.item_key,
      source_sha256: target.source_sha256,
      identity_field: target.identity_field,
      entries,
    });
    nextText = applied.text;
    lineNumber = applied.lineNumber;
    previous = applied.previous[applied.fields[0]] ?? null;
    if (statusValue !== null) previousStatus = applied.previous.status ?? null;
  } else {
    const applied = await applyManifestEdit(currentText, {
      manifest_index: target.manifest_index,
      source_sha256: target.source_sha256,
      field: "translation",
      value: nextTranslation,
      status: statusValue,
    });
    nextText = applied.text;
    previous = applied.previous;
    previousStatus = applied.previousStatus;
  }

  const translationMoved = (previous ?? "") !== nextTranslation;
  const statusMoved = statusValue !== null && (previousStatus ?? "") !== statusValue;

  if ((!translationMoved && !statusMoved) || nextText === currentText) {
    return {
      commit: null,
      path: target.path,
      lineNumber,
      previous,
      previousStatus,
      changed: false,
    };
  }

  // ---- write (no ?ref: the branch travels in the body, the sha guards races) ----
  const writeResponse = await ghRequest(request, contentsUrl(target.repo, target.path, null), {
    method: "PUT",
    token,
    body: {
      message,
      content: encodeBase64Utf8(nextText),
      sha,
      branch: target.ref,
    },
  });
  if (!writeResponse.ok) throw httpError(writeResponse.status, { path: target.path, what: "the file" });

  const result = parseJsonBody(writeResponse, `PUT ${target.path}`);
  const commitSha = typeof result?.commit?.sha === "string" ? result.commit.sha : "";
  const commitUrl = typeof result?.commit?.html_url === "string" ? result.commit.html_url : "";
  if (commitSha === "") throw fail("invalid_response", "GitHub returned no commit sha", { path: target.path });

  return {
    commit: { sha: commitSha, html_url: commitUrl },
    path: target.path,
    lineNumber,
    previous,
    previousStatus,
    changed: true,
  };
}
