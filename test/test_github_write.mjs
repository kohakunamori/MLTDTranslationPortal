// Tests for public/lib/github-write.js — the portal's only write path.
//
// House style (see test_worker.mjs): plain Node ESM, node:assert/strict, no test
// framework, no network. Run with:  node test/test_github_write.mjs
//
// Every GitHub call is stubbed: `stubFetch()` records `{url, method, headers, body}`
// and answers from a route table, so the assertions can also prove *how many* calls
// happened and that the PAT never leaks into a URL.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  PAT_STORAGE_KEY,
  WriteError,
  applyJsonlEdit,
  applyManifestEdit,
  commitLineEdit,
  getToken,
  replaceJsonStringField,
  setToken,
  sha256Hex,
  verifyToken,
} from "../public/lib/github-write.js";

const failures = [];
let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL ${name}`);
    console.error(`     ${(error && error.stack) || error}`);
  }
}

/* ------------------------------------------------------------------ helpers */

/** Independent sha256 (node:crypto) so fixtures never depend on the module's own. */
function nodeHash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function wrappedBase64(text) {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  return (b64.match(/.{1,60}/g) || []).join("\n"); // GitHub wraps at 60 chars
}

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function stubFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url,
      method: init.method || "GET",
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    for (const route of routes) {
      if ((route.method || "GET") !== call.method) continue;
      if (url.includes(route.match)) return route.reply(call, calls.length);
    }
    throw new Error(`unexpected ${call.method} ${url}`);
  };
  return { fetchImpl, calls };
}

/** 1-based numbers of the lines that differ, asserting the line count is stable. */
function changedLines(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  assert.equal(b.length, a.length, "the number of lines must not change");
  const out = [];
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) out.push(i + 1);
  return out;
}

async function rejectsWith(promise, code, check = () => true) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof WriteError, `expected a WriteError, got ${error}`);
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
    assert.ok(check(error), `detail check failed for ${code}`);
    return true;
  });
}

/* --------------------------------------------------------------- fixtures */

const JA = ["最新トキメキで ", '昨日より"高く"', "空を見上げて\\そして"];
const BUNDLE = "scrobj_smile1.unity3d";

function row({ item_key, ja, zh = null, zhKey = true, status = "accepted", extra = {} }) {
  const out = {
    asset_version: "1077100",
    base_version: "1077100",
    bundle: BUNDLE,
    item_key,
    ja,
  };
  if (zhKey) out.zh = zh;
  out.source_sha256 = nodeHash(ja);
  out.status = status;
  out.updated_at = "2026-01-01T00:00:00Z";
  return { ...out, ...extra };
}

const ROW_1 = row({ item_key: "1", ja: JA[0], zh: "带着崭新的心动", status: "accepted" });
const ROW_2 = row({ item_key: "2", ja: JA[1], zh: null, status: "untranslated" });
const ROW_3 = row({ item_key: "3", ja: JA[2], zh: "仰望天空", status: "accepted" });
const FILE_TEXT = `${[ROW_1, ROW_2, ROW_3].map((r) => JSON.stringify(r)).join("\n")}\n`;

const LEGACY_ROW = {
  slot_index: 126,
  item_key: "126",
  source: "Make me happy いつだって",
  translation: "Make me happy 无论何时",
  status: "accepted",
  source_sha256: nodeHash("Make me happy いつだって"),
  bundle: "scrobj_aftspt.unity3d",
  asset_version: "1077100",
};
const LEGACY_TEXT = `${JSON.stringify(LEGACY_ROW)}\n`;

const MANIFEST = {
  client_version: "9.0.200",
  asset_version: null,
  commit: "a".repeat(40),
  slots: [
    { index: 0, ja: "ホーム", zh: "主页", provenance: "ci" },
    { index: 1, ja: "ライブ", zh: "演唱会", provenance: "ci" },
    { index: 2, ja: "ガチャ", translation: "扭蛋", provenance: "legacy" },
  ],
};
const MANIFEST_TEXT = `${JSON.stringify(MANIFEST)}\n`; // deliberately unformatted

// `lyrics/songs/*.jsonl` 的行布局：身份字段是数值 `index`，行里没有 `item_key`。
const LY_JA = ["Shooting Stars", "Melty Fantasia", "虹色letters"];

function lyricsRow({ index, ja, zh = null, status = "untranslated" }) {
  return {
    abs_time: "00:01:23.456",
    bundle: BUNDLE,
    index,
    ja,
    source_sha256: nodeHash(ja),
    status,
    tick: 1000 + index,
    updated_at: "2026-01-01T00:00:00Z",
    zh,
  };
}

const LYRIC_1 = lyricsRow({ index: 1, ja: LY_JA[0], zh: "流星" });
const LYRIC_126 = lyricsRow({ index: 126, ja: LY_JA[1] });
const LYRIC_200 = lyricsRow({ index: 200, ja: LY_JA[2], zh: "彩虹色字母" });
const LYRICS_TEXT = `${[LYRIC_1, LYRIC_126, LYRIC_200].map((r) => JSON.stringify(r)).join("\n")}\n`;

/* -------------------------------------------------------------------- tests */

await test("PAT_STORAGE_KEY is the documented localStorage key", () => {
  assert.equal(PAT_STORAGE_KEY, "mltd.pat");
});

await test("getToken/setToken round-trip through a storage stub, '' clears", () => {
  const map = new Map();
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  assert.equal(getToken(storage), "", "unset key reads as empty string");
  assert.equal(setToken("  ghp_example  ", storage), "ghp_example");
  assert.equal(storage.getItem(PAT_STORAGE_KEY), "ghp_example");
  assert.equal(getToken(storage), "ghp_example");
  assert.equal(setToken("", storage), "");
  assert.equal(storage.getItem(PAT_STORAGE_KEY), null, "'' must delete the key");
  assert.equal(getToken(storage), "");
  assert.equal(getToken(), "", "no localStorage in Node: never throws");
  assert.equal(setToken("x", undefined), "", "no storage available: nothing stored");
});

await test("sha256Hex matches node:crypto for ASCII, CJK and block boundaries", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  for (let length = 0; length <= 200; length += 1) {
    const text = `${"あ".repeat(length)}x${length}`;
    assert.equal(sha256Hex(text), nodeHash(text), `length ${length}`);
  }
  const long = "最新トキメキで " + "😀".repeat(500);
  assert.equal(sha256Hex(long), nodeHash(long));
});

await test("replaceJsonStringField: plain value, only the value span moves", () => {
  const line = '{ "item_key" : "1" ,"zh":  "旧"  , "tail":1 }';
  const out = replaceJsonStringField(line, "zh", "新");
  assert.equal(out, '{ "item_key" : "1" ,"zh":  "新"  , "tail":1 }');
  assert.equal(out.slice(0, out.indexOf('"新"')), line.slice(0, line.indexOf('"旧"')));
  assert.equal(out.slice(out.indexOf('"新"') + 3), line.slice(line.indexOf('"旧"') + 3));
});

await test("replaceJsonStringField: escaped quote, backslash and \\uXXXX survive", () => {
  const line = '{"zh":"say \\"hi\\" \\\\ ok \\u4f60\u597d","ja":"x"}';
  const out = replaceJsonStringField(line, "zh", 'a "quoted" \\ value');
  assert.equal(JSON.parse(out).zh, 'a "quoted" \\ value');
  assert.equal(JSON.parse(out).ja, "x");
  // The escaped-quote value must not fool the scanner into matching a nested key:
  assert.equal(out, '{"zh":"a \\"quoted\\" \\\\ value","ja":"x"}');
});

await test("replaceJsonStringField: unicode, null value and null newValue", () => {
  const line = '{"item_key":"2","zh":null,"status":"untranslated"}';
  const filled = replaceJsonStringField(line, "zh", "昨日より高く 🎵 空");
  assert.equal(JSON.parse(filled).zh, "昨日より高く 🎵 空");
  assert.equal(JSON.parse(filled).status, "untranslated");
  const cleared = replaceJsonStringField(filled, "zh", null);
  assert.equal(cleared, '{"item_key":"2","zh":"","status":"untranslated"}');
});

await test("replaceJsonStringField: nested-only key does not match; nested is untouched", async () => {
  await rejectsWith(
    Promise.resolve().then(() => replaceJsonStringField('{"a":{"zh":"nested"},"b":1}', "zh", "x")),
    "field_missing",
  );
  const line = '{"zh":"top","nested":{"zh":"inner","deep":[{"zh":"deeper"}]}}';
  const out = replaceJsonStringField(line, "zh", "TOP");
  assert.equal(out, '{"zh":"TOP","nested":{"zh":"inner","deep":[{"zh":"deeper"}]}}');
  assert.equal(JSON.parse(out).nested.deep[0].zh, "deeper");
});

await test("replaceJsonStringField: missing field, duplicate key, non-string value", async () => {
  await rejectsWith(
    Promise.resolve().then(() => replaceJsonStringField('{"a":1}', "zh", "x")),
    "field_missing",
  );
  await rejectsWith(
    Promise.resolve().then(() => replaceJsonStringField('{"zh":"a","zh":"b"}', "zh", "x")),
    "ambiguous_field",
  );
  await rejectsWith(
    Promise.resolve().then(() => replaceJsonStringField('{"zh":12}', "zh", "x")),
    "field_not_string",
  );
  await rejectsWith(
    Promise.resolve().then(() => replaceJsonStringField('"not an object"', "zh", "x")),
    "invalid_json",
  );
});

await test("applyJsonlEdit: replaces one line, every other byte identical", async () => {
  const out = await applyJsonlEdit(FILE_TEXT, {
    item_key: "2",
    source_sha256: nodeHash(JA[1]),
    value: "比昨天更高",
  });
  assert.equal(out.lineNumber, 2);
  assert.equal(out.previous, null);
  assert.deepEqual(changedLines(FILE_TEXT, out.text), [2]);
  assert.ok(out.text.endsWith("\n"), "trailing newline preserved");

  const before = JSON.parse(FILE_TEXT.split("\n")[1]);
  const after = JSON.parse(out.text.split("\n")[1]);
  assert.equal(after.zh, "比昨天更高");
  assert.deepEqual({ ...before, zh: after.zh }, after, "no other key of that row moved");
  // Unchanged lines are byte-identical, not merely JSON-equal:
  assert.equal(out.text.split("\n")[0], JSON.stringify(ROW_1));
  assert.equal(out.text.split("\n")[2], JSON.stringify(ROW_3));
});

await test("applyJsonlEdit: translation spelling fallback for legacy rows", async () => {
  const out = await applyJsonlEdit(LEGACY_TEXT, {
    item_key: "126",
    source_sha256: nodeHash(LEGACY_ROW.source),
    value: "Make me happy 无论何时(改)",
  });
  assert.equal(out.lineNumber, 1);
  assert.equal(out.previous, "Make me happy 无论何时");
  const parsed = JSON.parse(out.text.trimEnd());
  assert.equal(parsed.translation, "Make me happy 无论何时(改)");
  assert.equal(parsed.zh, undefined, "must not invent a zh key");
  assert.deepEqual(changedLines(LEGACY_TEXT, out.text), [1]);
});

await test("applyJsonlEdit: explicit status write goes to the row's status field", async () => {
  const out = await applyJsonlEdit(FILE_TEXT, {
    item_key: "2",
    source_sha256: nodeHash(JA[1]),
    field: "status",
    value: "pending",
  });
  assert.equal(out.previous, "untranslated");
  assert.deepEqual(changedLines(FILE_TEXT, out.text), [2]);
  assert.equal(JSON.parse(out.text.split("\n")[1]).status, "pending");
});

await test("replaceJsonStringField: control characters stay escaped inside one line", () => {
  const out = replaceJsonStringField('{"zh":"旧","ja":"x"}', "zh", '行1\n行2\t"q" \u0000 \u007f');
  assert.equal(out.split("\n").length, 1, "a multi-line translation must not break the JSONL row");
  assert.equal(JSON.parse(out).zh, '行1\n行2\t"q" \u0000 \u007f');
  assert.equal(JSON.parse(out).ja, "x");
});

await test("applyJsonlEdit: CRLF line endings survive byte-for-byte", async () => {
  const crlf = `${JSON.stringify(ROW_1)}\r\n${JSON.stringify(ROW_2)}\r\n`;
  const out = await applyJsonlEdit(crlf, { item_key: "2", source_sha256: nodeHash(JA[1]), value: "改" });
  assert.deepEqual(changedLines(crlf, out.text), [2]);
  assert.ok(out.text.endsWith("\r\n"), "CRLF preserved");
  assert.equal(out.text.split("\r\n")[0], JSON.stringify(ROW_1));
});

await test("applyJsonlEdit: a missing target key fails closed instead of inventing one", async () => {
  // A byte-surgical writer cannot add a key without re-serializing the row, so a
  // row with no `status` refuses a status write...
  const noStatus = `${JSON.stringify({ item_key: "7", ja: "七", zh: "七" })}\n`;
  await rejectsWith(
    applyJsonlEdit(noStatus, { item_key: "7", source_sha256: nodeHash("七"), field: "status", value: "accepted" }),
    "field_missing",
  );
  // ...and a row with neither `zh` nor `translation` refuses any translation write.
  const bare = `${JSON.stringify({ item_key: "8", ja: "八" })}\n`;
  await rejectsWith(
    applyJsonlEdit(bare, { item_key: "8", source_sha256: nodeHash("八"), value: "八(译)" }),
    "field_missing",
  );
});

await test("applyJsonlEdit: not_found, ambiguous and source_changed refuse", async () => {
  await rejectsWith(
    applyJsonlEdit(FILE_TEXT, { item_key: "999", source_sha256: nodeHash(JA[0]), value: "x" }),
    "not_found",
  );
  const twin = `${JSON.stringify(ROW_2)}\n${JSON.stringify(ROW_2)}\n`;
  await rejectsWith(
    applyJsonlEdit(twin, { item_key: "2", source_sha256: nodeHash(JA[1]), value: "x" }),
    "ambiguous",
  );
  await rejectsWith(
    // same item_key, but the file's current source hashes differently: upstream moved
    applyJsonlEdit(FILE_TEXT, { item_key: "1", source_sha256: nodeHash("源文已改"), value: "x" }),
    "source_changed",
  );
  await rejectsWith(
    applyJsonlEdit('{"item_key":"1",\n', { item_key: "1", source_sha256: nodeHash(JA[0]), value: "x" }),
    "invalid_json",
  );
  await rejectsWith(applyJsonlEdit(FILE_TEXT, { item_key: "1", value: "x" }), "invalid_edit");
});

/* --------------------------------------------- 行身份字段 identity_field ---- */

await test("applyJsonlEdit: 数值 index 行按 identity_field 'index' 定位（行内没有 item_key）", async () => {
  const out = await applyJsonlEdit(LYRICS_TEXT, {
    identity_field: "index",
    item_key: "126",
    source_sha256: nodeHash(LY_JA[1]),
    value: "旋律幻想曲",
  });
  assert.equal(out.lineNumber, 2);
  assert.equal(out.previous, null);
  assert.deepEqual(changedLines(LYRICS_TEXT, out.text), [2], "只有目标行变化");
  assert.ok(out.text.endsWith("\n"), "结尾换行保留");

  const before = JSON.parse(LYRICS_TEXT.split("\n")[1]);
  const after = JSON.parse(out.text.split("\n")[1]);
  assert.equal(after.zh, "旋律幻想曲");
  assert.equal(after.index, 126);
  assert.equal(typeof after.index, "number", "数值 index 不能被字符串化");
  assert.equal(after.item_key, undefined, "绝不凭空写入 item_key");
  assert.deepEqual(after, { ...before, zh: "旋律幻想曲" }, "只有 zh 变了");
  for (const field of ["abs_time", "bundle", "ja", "source_sha256", "status", "tick", "updated_at"]) {
    assert.equal(after[field], before[field], `${field} 必须原样保留`);
  }
  assert.equal(out.text.split("\n")[0], JSON.stringify(LYRIC_1), "未命中的行逐字节不变");
  assert.equal(out.text.split("\n")[2], JSON.stringify(LYRIC_200));
});

await test("applyJsonlEdit: identity_field 'index' 找不到请求值 -> not_found，缺省仍是 item_key", async () => {
  await rejectsWith(
    applyJsonlEdit(LYRICS_TEXT, {
      identity_field: "index",
      item_key: "999",
      source_sha256: nodeHash(LY_JA[0]),
      value: "x",
    }),
    "not_found",
    (error) => error.detail.identity_field === "index" && error.detail.item_key === "999",
  );
  // 省略 identity_field 就是旧的 item_key：lyrics 行没有 item_key，同样只会 not_found，
  // 绝不退回行号或近似文本
  await rejectsWith(
    applyJsonlEdit(LYRICS_TEXT, { item_key: "126", source_sha256: nodeHash(LY_JA[1]), value: "x" }),
    "not_found",
  );
  // 字段名给了但是空的/不是字符串 = 调用方错误：空字段名会让每一行都像命中，必须拒绝
  await rejectsWith(
    applyJsonlEdit(LYRICS_TEXT, {
      identity_field: "",
      item_key: "126",
      source_sha256: nodeHash(LY_JA[1]),
      value: "x",
    }),
    "invalid_edit",
  );
  await rejectsWith(
    applyJsonlEdit(LYRICS_TEXT, {
      identity_field: 7,
      item_key: "126",
      source_sha256: nodeHash(LY_JA[1]),
      value: "x",
    }),
    "invalid_edit",
  );
});

await test("applyJsonlEdit: 两行共享同一个 index -> ambiguous；源文哈希守卫不变", async () => {
  const twin = `${JSON.stringify(LYRIC_126)}\n${JSON.stringify(LYRIC_126)}\n`;
  await rejectsWith(
    applyJsonlEdit(twin, {
      identity_field: "index",
      item_key: "126",
      source_sha256: nodeHash(LY_JA[1]),
      value: "x",
    }),
    "ambiguous",
    (error) => error.detail.lines.length === 2 && error.detail.identity_field === "index",
  );
  // 源文已经变了（哈希对不上）依旧报 source_changed，不因为换了身份字段而放松
  await rejectsWith(
    applyJsonlEdit(LYRICS_TEXT, {
      identity_field: "index",
      item_key: "126",
      source_sha256: nodeHash("源文已改"),
      value: "x",
    }),
    "source_changed",
  );
});

await test("applyJsonlEdit: lyrics 行缺 zh / 缺 status 时依旧 field_missing（不新增键）", async () => {
  const noZh = `${JSON.stringify({ bundle: BUNDLE, index: 7, ja: "七", status: "untranslated" })}\n`;
  await rejectsWith(
    applyJsonlEdit(noZh, { identity_field: "index", item_key: "7", source_sha256: nodeHash("七"), value: "七(译)" }),
    "field_missing",
  );
  const out = await applyJsonlEdit(noZh, {
    identity_field: "index",
    item_key: "7",
    source_sha256: nodeHash("七"),
    field: "status",
    value: "accepted",
  });
  assert.equal(JSON.parse(out.text).status, "accepted");
  assert.equal(JSON.parse(out.text).zh, undefined, "绝不新增 zh");
  assert.deepEqual(changedLines(noZh, out.text), [1]);

  const noStatus = `${JSON.stringify({ bundle: BUNDLE, index: 8, ja: "八", zh: "" })}\n`;
  await rejectsWith(
    applyJsonlEdit(noStatus, {
      identity_field: "index",
      item_key: "8",
      source_sha256: nodeHash("八"),
      field: "status",
      value: "accepted",
    }),
    "field_missing",
  );
});

await test("applyJsonlEdit: 同一个文件用 identity_field 'item_key' 仍然照旧工作", async () => {
  const explicit = await applyJsonlEdit(FILE_TEXT, {
    identity_field: "item_key",
    item_key: "3",
    source_sha256: nodeHash(JA[2]),
    value: "仰望天空(改)",
  });
  assert.equal(explicit.lineNumber, 3);
  assert.equal(explicit.previous, "仰望天空");
  assert.deepEqual(changedLines(FILE_TEXT, explicit.text), [3]);
  assert.equal(JSON.parse(explicit.text.split("\n")[2]).zh, "仰望天空(改)");

  // 显式写 "item_key" 与省略 identity_field 完全等价：旧调用点不受影响
  const implicit = await applyJsonlEdit(FILE_TEXT, {
    item_key: "3",
    source_sha256: nodeHash(JA[2]),
    value: "仰望天空(改)",
  });
  assert.equal(implicit.text, explicit.text);

  // 身份值按 String() 比较：locales 行里写成数字的 item_key 也能被 "85" 命中
  const numeric = `${JSON.stringify({
    bundle: BUNDLE,
    item_key: 85,
    ja: "八十五",
    status: "untranslated",
    zh: null,
  })}\n`;
  const hit = await applyJsonlEdit(numeric, {
    item_key: "85",
    source_sha256: nodeHash("八十五"),
    value: "八十五(译)",
  });
  assert.equal(hit.lineNumber, 1);
  assert.equal(JSON.parse(hit.text).item_key, 85, "数值 item_key 不被字符串化");
  assert.equal(JSON.parse(hit.text).zh, "八十五(译)");

  // item_key 没被字符串化（直接给数值）也按 String() 命中，两边等价
  const numericKey = await applyJsonlEdit(numeric, {
    item_key: 85,
    source_sha256: nodeHash("八十五"),
    value: "八十五(译)",
  });
  assert.equal(numericKey.lineNumber, 1);
  const numericIndex = await applyJsonlEdit(LYRICS_TEXT, {
    identity_field: "index",
    item_key: 200,
    source_sha256: nodeHash(LY_JA[2]),
    value: "彩虹色字母(改)",
  });
  assert.equal(numericIndex.lineNumber, 3);
  assert.equal(JSON.parse(numericIndex.text.split("\n")[2]).zh, "彩虹色字母(改)");

  // 空的身份值仍然失败关闭：'' / null 不是"某个第 0 行"
  await rejectsWith(
    applyJsonlEdit(numeric, { item_key: "", source_sha256: nodeHash("八十五"), value: "x" }),
    "invalid_edit",
  );
  await rejectsWith(
    applyJsonlEdit(numeric, { item_key: null, source_sha256: nodeHash("八十五"), value: "x" }),
    "invalid_edit",
  );
});

await test("applyManifestEdit: slot replaced, hash checked, 2-space + newline output", async () => {
  const out = await applyManifestEdit(MANIFEST_TEXT, {
    manifest_index: 1,
    source_sha256: nodeHash("ライブ"),
    value: "演唱会(改)",
  });
  assert.equal(out.previous, "演唱会");
  assert.ok(out.text.endsWith("\n"), "trailing newline added");
  assert.ok(out.text.includes('\n  "client_version": "9.0.200",'), "2-space indentation");
  assert.equal(out.text, `${JSON.stringify(JSON.parse(out.text), null, 2)}\n`, "stable formatting");
  const parsed = JSON.parse(out.text);
  assert.equal(parsed.slots[1].zh, "演唱会(改)");
  assert.equal(parsed.slots[0].zh, "主页");
  assert.equal(parsed.slots[2].translation, "扭蛋", "legacy spelling untouched");
  // A manifest edit rewrites formatting; a JSONL edit does not. That is documented.
  assert.notEqual(out.text, MANIFEST_TEXT);

  const legacy = await applyManifestEdit(MANIFEST_TEXT, {
    manifest_index: 2,
    source_sha256: nodeHash("ガチャ"),
    value: "扭蛋(改)",
  });
  assert.equal(JSON.parse(legacy.text).slots[2].translation, "扭蛋(改)");
  assert.equal(JSON.parse(legacy.text).slots[2].zh, undefined);

  const withStatus = await applyManifestEdit(MANIFEST_TEXT, {
    manifest_index: 0,
    source_sha256: nodeHash("ホーム"),
    value: "首页",
    status: "accepted",
  });
  assert.equal(JSON.parse(withStatus.text).slots[0].status, "accepted");
});

await test("applyManifestEdit: wrong hash, bad index and bad JSON refuse", async () => {
  await rejectsWith(
    applyManifestEdit(MANIFEST_TEXT, { manifest_index: 0, source_sha256: nodeHash("别的原文"), value: "x" }),
    "source_changed",
  );
  await rejectsWith(
    applyManifestEdit(MANIFEST_TEXT, { manifest_index: 9, source_sha256: nodeHash("ホーム"), value: "x" }),
    "not_found",
  );
  await rejectsWith(
    applyManifestEdit("{\n", { manifest_index: 0, source_sha256: nodeHash("ホーム"), value: "x" }),
    "invalid_json",
  );
  await rejectsWith(applyManifestEdit(MANIFEST_TEXT, { manifest_index: -1, source_sha256: "a".repeat(64), value: "x" }), "invalid_edit");
});

/* ------------------------------------------------------- commitLineEdit ---- */

const TOKEN = `ghp_${"A".repeat(36)}`;
const REPO = "kohakunamori/MLTDTranslationAssets";
const EDIT = { kind: "jsonl", repo: REPO, ref: "main", path: "lyrics/songs/scrobj_smile1.jsonl" };
const LINE = {
  slot_index: 2,
  item_key: "2",
  source: JA[1],
  source_sha256: nodeHash(JA[1]),
  translation: null,
  status: "untranslated",
  line: 2,
};
const GET_URL = `https://api.github.com/repos/${REPO}/contents/lyrics/songs/scrobj_smile1.jsonl?ref=main`;
const PUT_URL = `https://api.github.com/repos/${REPO}/contents/lyrics/songs/scrobj_smile1.jsonl`;
const BLOB_SHA = "b".repeat(40);
const COMMIT_SHA = "c".repeat(40);
const COMMIT_URL = `https://github.com/${REPO}/commit/${COMMIT_SHA}`;

function fileRoutes({ read = FILE_TEXT, readStatus = 200, putStatus = 200, sha = BLOB_SHA } = {}) {
  return stubFetch([
    {
      method: "GET",
      match: "/contents/",
      reply: () =>
        readStatus === 200
          ? jsonResponse(200, {
              name: "scrobj_smile1.jsonl",
              path: EDIT.path,
              sha,
              size: read.length,
              encoding: "base64",
              content: wrappedBase64(read),
            })
          : jsonResponse(readStatus, { message: "nope" }),
    },
    {
      method: "PUT",
      match: "/contents/",
      reply: () =>
        putStatus === 200
          ? jsonResponse(200, {
              content: { sha: "d".repeat(40) },
              commit: { sha: COMMIT_SHA, html_url: COMMIT_URL },
            })
          : jsonResponse(putStatus, { message: "conflict" }),
    },
  ]);
}

await test("commitLineEdit: happy path = one GET then one PUT with the right body", async () => {
  const { fetchImpl, calls } = fileRoutes();
  const result = await commitLineEdit({
    token: TOKEN,
    edit: EDIT,
    line: LINE,
    translation: "比昨天更高",
    status: "pending",
    message: "translations: scrobj_smile1 line 2",
    fetchImpl,
  });

  assert.equal(calls.length, 2, "exactly one GET and one PUT");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[1].method, "PUT");

  assert.equal(calls[0].url, GET_URL);
  assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].headers.accept, "application/vnd.github+json");
  assert.equal(calls[0].headers["x-github-api-version"], "2022-11-28");
  assert.equal(calls[0].headers["user-agent"], "mltd-portal");
  assert.equal(calls[0].body, null);

  assert.equal(calls[1].url, PUT_URL, "the PUT must not carry ?ref");
  assert.ok(!calls[1].url.includes(TOKEN), "the token must never appear in a URL");
  assert.ok(!calls[0].url.includes(TOKEN));
  assert.equal(calls[1].body.message, "translations: scrobj_smile1 line 2");
  assert.equal(calls[1].body.sha, BLOB_SHA);
  assert.equal(calls[1].body.branch, "main");
  assert.equal(calls[1].headers["content-type"], "application/json");

  const written = Buffer.from(calls[1].body.content, "base64").toString("utf8");
  assert.deepEqual(changedLines(FILE_TEXT, written), [2], "only line 2 of the file moved");
  const writtenRow = JSON.parse(written.split("\n")[1]);
  assert.equal(writtenRow.zh, "比昨天更高", "CJK survived the base64 round-trip");
  assert.equal(writtenRow.status, "pending");
  assert.equal(writtenRow.ja, JA[1]);

  assert.deepEqual(result, {
    commit: { sha: COMMIT_SHA, html_url: COMMIT_URL },
    path: EDIT.path,
    lineNumber: 2,
    previous: null,
    previousStatus: "untranslated",
    changed: true,
  });
});

await test("commitLineEdit: empty token and missing edit pieces refuse before any fetch", async () => {
  let called = 0;
  const fetchImpl = async () => {
    called += 1;
    throw new Error("no network expected");
  };
  await rejectsWith(commitLineEdit({ token: "", edit: EDIT, line: LINE, translation: "x", fetchImpl }), "no_token");
  await rejectsWith(commitLineEdit({ token: "   ", edit: EDIT, line: LINE, translation: "x", fetchImpl }), "no_token");
  await rejectsWith(commitLineEdit({ token: TOKEN, edit: {}, line: LINE, translation: "x", fetchImpl }), "invalid_edit");
  await rejectsWith(
    commitLineEdit({ token: TOKEN, edit: { ...EDIT, kind: "other" }, line: LINE, translation: "x", fetchImpl }),
    "invalid_edit",
  );
  await rejectsWith(
    commitLineEdit({ token: TOKEN, edit: { ...EDIT, path: "../secrets.json" }, line: LINE, translation: "x", fetchImpl }),
    "invalid_edit",
  );
  await rejectsWith(
    commitLineEdit({ token: TOKEN, edit: EDIT, line: { item_key: "2" }, translation: "x", fetchImpl }),
    "invalid_edit",
  );
  await rejectsWith(
    commitLineEdit({ token: TOKEN, edit: EDIT, line: LINE, translation: 42, fetchImpl }),
    "invalid_edit",
  );
  await rejectsWith(
    commitLineEdit({ token: TOKEN, edit: { ...EDIT, kind: "manifest" }, line: LINE, translation: "x", fetchImpl }),
    "invalid_edit",
  );
  await rejectsWith(
    commitLineEdit({ token: TOKEN, edit: { ...EDIT, repo: "not-a-repo" }, line: LINE, translation: "x", fetchImpl }),
    "invalid_edit",
    (error) => !String(error.message).includes(TOKEN) && !JSON.stringify(error.detail ?? {}).includes(TOKEN),
  );
  assert.equal(called, 0, "validation must not touch the network");
});

await test("commitLineEdit: 409 and 422 are conflicts and are never retried", async () => {
  for (const status of [409, 422]) {
    const { fetchImpl, calls } = fileRoutes({ putStatus: status });
    await rejectsWith(
      commitLineEdit({ token: TOKEN, edit: EDIT, line: LINE, translation: "比昨天更高", fetchImpl }),
      "conflict",
      (error) => error.detail.status === status && !String(error.message).includes(TOKEN),
    );
    assert.equal(calls.length, 2, `${status}: one GET, one PUT, no retry`);
  }
});

await test("commitLineEdit: 401/403/404 map to unauthorized/forbidden/not_found; token never in messages", async () => {
  const cases = [
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
  ];
  for (const [status, code] of cases) {
    const { fetchImpl } = fileRoutes({ readStatus: status });
    await rejectsWith(
      commitLineEdit({ token: TOKEN, edit: EDIT, line: LINE, translation: "x", fetchImpl }),
      code,
      (error) => !String(error.message).includes(TOKEN) && !JSON.stringify(error.detail ?? {}).includes(TOKEN),
    );
  }
});

await test("commitLineEdit: a no-op edit performs no PUT", async () => {
  const { fetchImpl, calls } = fileRoutes();
  const result = await commitLineEdit({
    token: TOKEN,
    edit: EDIT,
    line: { ...LINE, item_key: "1", source: JA[0], source_sha256: nodeHash(JA[0]), translation: "带着崭新的心动" },
    translation: "带着崭新的心动",
    fetchImpl,
  });
  assert.equal(result.changed, false);
  assert.equal(result.commit, null);
  assert.equal(result.lineNumber, 1);
  assert.equal(result.previous, "带着崭新的心动");
  assert.equal(calls.length, 1, "read only, never a PUT");
  assert.equal(calls[0].method, "GET");
});

await test("commitLineEdit: unchanged translation with a new status still commits", async () => {
  const { fetchImpl, calls } = fileRoutes();
  const result = await commitLineEdit({
    token: TOKEN,
    edit: EDIT,
    line: { ...LINE, item_key: "1", source: JA[0], source_sha256: nodeHash(JA[0]), translation: "带着崭新的心动" },
    translation: "带着崭新的心动",
    status: "pending",
    fetchImpl,
  });
  assert.equal(result.changed, true);
  assert.equal(result.previousStatus, "accepted");
  assert.equal(calls.length, 2);
  const written = Buffer.from(calls[1].body.content, "base64").toString("utf8");
  assert.equal(JSON.parse(written.split("\n")[0]).status, "pending");
  assert.deepEqual(changedLines(FILE_TEXT, written), [1]);
});

await test("commitLineEdit: manifest edit reads and rewrites the manifest file", async () => {
  const manifestEdit = { kind: "manifest", repo: REPO, ref: "main", path: "manifests/bottom-bar.manifest.json" };
  const line = { manifest_index: 1, item_key: "1", source: "ライブ", source_sha256: nodeHash("ライブ") };
  const { fetchImpl, calls } = stubFetch([
    { method: "GET", match: "/contents/", reply: () => jsonResponse(200, { sha: BLOB_SHA, encoding: "base64", content: wrappedBase64(MANIFEST_TEXT) }) },
    { method: "PUT", match: "/contents/", reply: () => jsonResponse(200, { commit: { sha: COMMIT_SHA, html_url: COMMIT_URL } }) },
  ]);
  const result = await commitLineEdit({
    token: TOKEN,
    edit: manifestEdit,
    line,
    translation: "演唱会(改)",
    fetchImpl,
  });
  assert.equal(result.changed, true);
  assert.equal(result.lineNumber, null, "a manifest slot has no file line number");
  assert.equal(result.previous, "演唱会");
  assert.equal(
    calls[0].url,
    `https://api.github.com/repos/${REPO}/contents/manifests/bottom-bar.manifest.json?ref=main`,
  );
  const written = JSON.parse(Buffer.from(calls[1].body.content, "base64").toString("utf8"));
  assert.equal(written.slots[1].zh, "演唱会(改)");
});

/* ------------------------------- commitLineEdit：行身份字段转发 ------------ */

await test("commitLineEdit: lyrics 行往返 —— 只动目标行，其余字段逐字节不变", async () => {
  const lyricsEdit = {
    kind: "jsonl",
    repo: REPO,
    ref: "main",
    path: "lyrics/songs/scrobj_smile1.jsonl",
    identity_field: "index",
  };
  const line = { item_key: "126", source: LY_JA[1], source_sha256: nodeHash(LY_JA[1]) };
  const { fetchImpl, calls } = fileRoutes({ read: LYRICS_TEXT });
  const result = await commitLineEdit({
    token: TOKEN,
    edit: lyricsEdit,
    line,
    translation: "旋律幻想曲",
    fetchImpl,
  });

  assert.equal(result.changed, true);
  assert.equal(result.lineNumber, 2);
  assert.equal(result.previous, null);
  assert.equal(result.path, lyricsEdit.path);
  assert.equal(calls.length, 2, "一次读、一次写");
  assert.equal(
    calls[0].url,
    `https://api.github.com/repos/${REPO}/contents/${lyricsEdit.path}?ref=main`,
  );
  assert.equal(calls[1].url, `https://api.github.com/repos/${REPO}/contents/${lyricsEdit.path}`, "PUT 不带 ?ref");
  assert.equal(calls[1].body.sha, BLOB_SHA);
  assert.equal(calls[1].body.branch, "main");
  assert.equal(calls[1].body.message, `Update translation: ${lyricsEdit.path} (126)`, "默认提交信息不变");
  assert.ok(!calls[1].url.includes(TOKEN) && !String(calls[1].body.message).includes(TOKEN), "token 不进 URL/信息");

  const written = Buffer.from(calls[1].body.content, "base64").toString("utf8");
  assert.deepEqual(changedLines(LYRICS_TEXT, written), [2], "只有目标行变化");
  assert.equal(written.split("\n").length, LYRICS_TEXT.split("\n").length, "行数不变");
  for (const raw of written.split("\n")) if (raw.trim() !== "") JSON.parse(raw); // 整个文件仍可解析

  // 逐字节：目标行只有 zh 的值片段被替换（zh 是 lyrics 行的最后一个键）
  const before = LYRICS_TEXT.split("\n")[1];
  const after = written.split("\n")[1];
  assert.equal(after.slice(0, after.indexOf('"zh"')), before.slice(0, before.indexOf('"zh"')), "zh 之前逐字节相同");
  assert.equal(before.slice(before.indexOf('"zh":')), '"zh":null}');
  assert.equal(after.slice(after.indexOf('"zh":')), '"zh":"旋律幻想曲"}');

  const writtenRow = JSON.parse(after);
  assert.equal(writtenRow.zh, "旋律幻想曲");
  assert.equal(writtenRow.index, 126);
  assert.equal(typeof writtenRow.index, "number");
  assert.equal(writtenRow.item_key, undefined, "绝不凭空写入 item_key");
  for (const field of ["abs_time", "bundle", "ja", "source_sha256", "status", "tick", "updated_at"]) {
    assert.equal(writtenRow[field], LYRIC_126[field], `${field} 逐字节不变`);
  }
  assert.equal(written.split("\n")[0], JSON.stringify(LYRIC_1));
  assert.equal(written.split("\n")[2], JSON.stringify(LYRIC_200));
});

await test("commitLineEdit: identity_field 优先取 edit，其次 line，缺省 item_key", async () => {
  const path = "lyrics/songs/scrobj_smile1.jsonl";
  const base = { kind: "jsonl", repo: REPO, ref: "main", path };
  const line = { item_key: "126", source: LY_JA[1], source_sha256: nodeHash(LY_JA[1]) };

  // 只有 line.identity_field：照样能定位 lyrics 行
  const fromLine = fileRoutes({ read: LYRICS_TEXT });
  const ok = await commitLineEdit({
    token: TOKEN,
    edit: base,
    line: { ...line, identity_field: "index" },
    translation: "旋律幻想曲",
    fetchImpl: fromLine.fetchImpl,
  });
  assert.equal(ok.changed, true);
  assert.equal(ok.lineNumber, 2);

  // edit.identity_field 优先：edit 说是 item_key，而 lyrics 行没有 item_key -> not_found
  // （若把 line 上的 index 当准，这里就会写进去）
  const conflict = fileRoutes({ read: LYRICS_TEXT });
  await rejectsWith(
    commitLineEdit({
      token: TOKEN,
      edit: { ...base, identity_field: "item_key" },
      line: { ...line, identity_field: "index" },
      translation: "旋律幻想曲",
      fetchImpl: conflict.fetchImpl,
    }),
    "not_found",
  );
  assert.equal(conflict.calls.length, 1, "定位失败只读不写");

  // 两边都没给 -> 缺省 item_key：locales 文件照旧可写
  const fallback = fileRoutes({ read: FILE_TEXT });
  const legacy = await commitLineEdit({
    token: TOKEN,
    edit: EDIT,
    line: { ...LINE, item_key: "1", source: JA[0], source_sha256: nodeHash(JA[0]) },
    translation: "带着崭新的心动(改)",
    fetchImpl: fallback.fetchImpl,
  });
  assert.equal(legacy.changed, true);
  assert.equal(legacy.lineNumber, 1);

  // 非法字段名在动网络之前就被拒
  let called = 0;
  const noNetwork = async () => {
    called += 1;
    throw new Error("no network expected");
  };
  await rejectsWith(
    commitLineEdit({
      token: TOKEN,
      edit: { ...base, identity_field: "  " },
      line,
      translation: "x",
      fetchImpl: noNetwork,
    }),
    "invalid_edit",
  );
  assert.equal(called, 0, "校验不碰网络");

  // manifest 没有"行身份字段"这回事：identity_field 一律忽略，旧行为不变
  const manifest = stubFetch([
    {
      method: "GET",
      match: "/contents/",
      reply: () => jsonResponse(200, { sha: BLOB_SHA, encoding: "base64", content: wrappedBase64(MANIFEST_TEXT) }),
    },
    { method: "PUT", match: "/contents/", reply: () => jsonResponse(200, { commit: { sha: COMMIT_SHA, html_url: COMMIT_URL } }) },
  ]);
  const manifestResult = await commitLineEdit({
    token: TOKEN,
    edit: { kind: "manifest", repo: REPO, ref: "main", path: "manifests/bottom-bar.manifest.json", identity_field: "" },
    line: { manifest_index: 1, item_key: "1", source: "ライブ", source_sha256: nodeHash("ライブ") },
    translation: "演唱会(改)",
    fetchImpl: manifest.fetchImpl,
  });
  assert.equal(manifestResult.changed, true);
  assert.equal(manifestResult.previous, "演唱会");
});

/* ---------------------------------------------------------- verifyToken ---- */

const USER_URL = "https://api.github.com/user";

await test("verifyToken: x-oauth-scopes parsed；没给仓库时不做仓库探测", async () => {
  const { fetchImpl, calls } = stubFetch([
    {
      method: "GET",
      match: USER_URL,
      reply: () =>
        jsonResponse(200, { login: "kohaku", name: "Kohaku" }, { "x-oauth-scopes": " repo ,  gist , read:user ," }),
    },
  ]);
  const result = await verifyToken({ token: TOKEN, fetchImpl });
  assert.deepEqual(result, {
    login: "kohaku",
    name: "Kohaku",
    scopes: ["repo", "gist", "read:user"],
    canPush: true,
    repos: [],
    repo: null,
    fineGrained: false,
  });
  assert.equal(calls.length, 1, "没指定仓库就只查 /user");
  assert.equal(calls[0].url, USER_URL);
  assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(!calls[0].url.includes(TOKEN));
});

await test("verifyToken: 经典 token 也要以仓库权限为准（scope 只说能写公开仓库）", async () => {
  // scope 写着 public_repo，但仓库权限只有读：不能写，必须报出来
  const { fetchImpl, calls } = stubFetch([
    {
      method: "GET",
      match: USER_URL,
      reply: () => jsonResponse(200, { login: "kohaku", name: "Kohaku" }, { "x-oauth-scopes": "public_repo" }),
    },
    {
      method: "GET",
      match: `/repos/${REPO}`,
      reply: () => jsonResponse(200, { full_name: REPO, permissions: { admin: false, push: false, pull: true } }),
    },
  ]);
  const result = await verifyToken({ token: TOKEN, fetchImpl, repo: REPO });
  assert.equal(result.canPush, false, "permissions.push=false 必须压过 scope 的乐观判断");
  assert.deepEqual(result.repos, []);
  assert.deepEqual(result.repo, { name: REPO, visible: true, permission: "read" });
  assert.equal(calls.length, 2);

  // 同一个 token，仓库说能写 -> 能写
  const allowed = stubFetch([
    { method: "GET", match: USER_URL, reply: () => jsonResponse(200, { login: "kohaku" }, { "x-oauth-scopes": "public_repo" }) },
    { method: "GET", match: `/repos/${REPO}`, reply: () => jsonResponse(200, { permissions: { push: true, pull: true } }) },
  ]);
  const yes = await verifyToken({ token: TOKEN, fetchImpl: allowed.fetchImpl, repo: REPO });
  assert.equal(yes.canPush, true);
  assert.deepEqual(yes.repos, [REPO]);
  assert.deepEqual(yes.repo, { name: REPO, visible: true, permission: "write" });
});

await test("verifyToken: 看不见仓库（403/404）时给出可见性判定，而不是含糊的 false", async () => {
  for (const status of [403, 404]) {
    const { fetchImpl } = stubFetch([
      { method: "GET", match: USER_URL, reply: () => jsonResponse(200, { login: "kohaku" }, { "x-oauth-scopes": "read:user" }) },
      { method: "GET", match: `/repos/${REPO}`, reply: () => jsonResponse(status, { message: "nope" }) },
    ]);
    const result = await verifyToken({ token: TOKEN, fetchImpl, repo: REPO });
    assert.equal(result.canPush, false);
    assert.equal(result.repo.visible, false, `${status} 应当被记成"看不见"`);
    assert.equal(result.repo.status, status);
    assert.equal(result.repo.permission, "none");
  }
});

await test("verifyToken: 不带 scope 的细粒度 token；401 与空 token 拒绝", async () => {
  const readOnly = stubFetch([
    { method: "GET", match: USER_URL, reply: () => jsonResponse(200, { login: "kohaku", name: null }, { "x-oauth-scopes": "read:user" }) },
  ]);
  const result = await verifyToken({ token: TOKEN, fetchImpl: readOnly.fetchImpl });
  assert.deepEqual(result.scopes, ["read:user"]);
  assert.equal(result.canPush, false);
  assert.equal(result.name, "", "a null display name becomes an empty string");

  const rejected = stubFetch([{ method: "GET", match: USER_URL, reply: () => jsonResponse(401, { message: "Bad credentials" }) }]);
  await rejectsWith(
    verifyToken({ token: TOKEN, fetchImpl: rejected.fetchImpl }),
    "unauthorized",
    (error) => !String(error.message).includes(TOKEN),
  );
  await rejectsWith(
    verifyToken({ token: "", fetchImpl: rejected.fetchImpl }),
    "no_token",
  );
});

await test("verifyToken: bare github_pat_ token goes down the repo probe path", async () => {
  const fineGrained = `github_pat_${"B".repeat(22)}`;
  const { fetchImpl, calls } = stubFetch([
    { method: "GET", match: USER_URL, reply: () => jsonResponse(200, { login: "kohaku", name: "Kohaku" }) },
    {
      method: "GET",
      match: `/repos/${REPO}`,
      reply: () => jsonResponse(200, { full_name: REPO, permissions: { admin: false, push: true, pull: true } }),
    },
  ]);
  const allowed = await verifyToken({ token: fineGrained, fetchImpl, repo: REPO });
  assert.deepEqual(allowed.scopes, [], "a fine-grained token sends no scope header");
  assert.equal(allowed.canPush, true);
  assert.deepEqual(allowed.repos, [REPO]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, `https://api.github.com/repos/${REPO}`);
  assert.ok(!calls[1].url.includes(fineGrained));

  const denied = stubFetch([
    { method: "GET", match: USER_URL, reply: () => jsonResponse(200, { login: "kohaku" }) },
    { method: "GET", match: `/repos/${REPO}`, reply: () => jsonResponse(200, { permissions: { push: false } }) },
  ]);
  const refused = await verifyToken({ token: fineGrained, fetchImpl: denied.fetchImpl, repo: REPO });
  assert.equal(refused.canPush, false, "permissions.push wins for a fine-grained token");
  assert.deepEqual(refused.repos, []);

  const unseen = stubFetch([
    { method: "GET", match: USER_URL, reply: () => jsonResponse(200, { login: "kohaku" }) },
    { method: "GET", match: `/repos/${REPO}`, reply: () => jsonResponse(404, { message: "Not Found" }) },
  ]);
  const hidden = await verifyToken({ token: fineGrained, fetchImpl: unseen.fetchImpl, repo: REPO });
  assert.equal(hidden.canPush, false, "an invisible repository is not pushable");
});

/* -------------------------------------------------------------------- exit */

if (failures.length > 0) {
  console.error(`\n${failures.length} of ${failures.length + passed} tests failed:`);
  for (const failure of failures) console.error(` - ${failure.name}`);
  process.exit(1);
}
console.log(`\ngithub-write module ${passed} tests PASS`);
