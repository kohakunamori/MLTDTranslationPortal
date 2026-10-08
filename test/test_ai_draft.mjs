// AI 草拟助手（`public/lib/ai-draft.js`）的离线测试。
//
// 全部走 stub fetch + 内存 storage：不联网、不需要 API Key、不碰真实 localStorage。
// 跑法：node test/test_ai_draft.mjs —— 断言失败即非零退出，最后一行是 ... PASS。
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
const MODULE_URL = pathToFileURL(path.join(DIRNAME, "..", "public", "lib", "ai-draft.js")).href;

// 顶层就 import：Node 里既没有 window 也没有 localStorage，能导入成功本身就说明
// 模块顶层没有偷摸访问浏览器全局。
const aiDraft = await import(MODULE_URL);
const {
  AI_STORAGE_KEY,
  AiError,
  buildSystemPrompt,
  callAiChat,
  checkTranslationFormat,
  draftTranslation,
  getAiConfig,
  setAiConfig,
  testAiConnection,
} = aiDraft;

// 旧门户（public/app.js:129）用的键，只做只读兼容。
const LEGACY_AI_STORAGE_KEY = "mltd_ai_config";

// 旧 DEFAULT_AI_CONFIG（app.js:130）的原样期待值：写死在测试里，改了默认值就得改这里。
const DEFAULTS = {
  endpoint: "https://api.deepseek.com/v1/chat/completions",
  apiKey: "",
  model: "deepseek-chat",
  temperature: 0.3,
  systemPrompt: "",
};

const CONFIG = {
  endpoint: "https://api.deepseek.com/v1",
  apiKey: "sk-secret-123",
  model: "deepseek-chat",
  temperature: 0.3,
  systemPrompt: "",
};

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/// 内存版 localStorage，行为与浏览器一致：没有的键返回 null。
function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
    dump: () => Object.fromEntries(map),
  };
}

/// 隐私模式 / 策略禁用下的存储：读写都抛。
const throwingStorage = {
  getItem() { throw new Error("storage disabled"); },
  setItem() { throw new Error("storage disabled"); },
  removeItem() { throw new Error("storage disabled"); },
};

/// 临时把 globalThis.localStorage 换成给定对象（Node 默认没有这个全局），返回还原函数。
function installGlobalStorage(storage) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "localStorage");
  const previous = had ? globalThis.localStorage : undefined;
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  return () => {
    if (had) Object.defineProperty(globalThis, "localStorage", { value: previous, configurable: true, writable: true });
    else delete globalThis.localStorage;
  };
}

/// 断言 promise 以指定 code 的 AiError 失败，顺便把错误对象交回来给调用方继续查。
async function rejectsAi(promise, code, message = null) {
  let caught = null;
  await assert.rejects(promise, (err) => { caught = err; return true; });
  assert.ok(caught instanceof AiError, `期望 AiError，实际是 ${caught?.name}: ${caught?.message}`);
  assert.equal(caught.code, code, `错误码不符：${caught.code}（${caught.message}）`);
  if (message !== null) assert.equal(caught.message, message);
  return caught;
}

/// 记下每次请求的 url / init / 反序列化后的 body，顺便断言 key 不进 URL。
const SEEN_URLS = [];
function recordFetch(stub) {
  const calls = [];
  const impl = async (url, init) => {
    SEEN_URLS.push(url);
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    return stub(url, init, calls.length);
  };
  impl.calls = calls;
  return impl;
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function textResponse(status, bodyText) {
  return {
    ok: false,
    status,
    statusText: "Error",
    json: async () => JSON.parse(bodyText),
    text: async () => bodyText,
  };
}

const assistantReply = (content) => jsonResponse({ choices: [{ message: { role: "assistant", content } }] });

// ---------------------------------------------------------------------------
// 1. 公开 API 形态
// ---------------------------------------------------------------------------

assert.equal(AI_STORAGE_KEY, "mltd.ai");
assert.deepEqual(
  Object.keys(aiDraft).sort(),
  [
    "AI_STORAGE_KEY",
    "AiError",
    "buildSystemPrompt",
    "callAiChat",
    "checkTranslationFormat",
    "draftTranslation",
    "getAiConfig",
    "setAiConfig",
    "testAiConnection",
  ].sort(),
  "模块只暴露约定的这 9 个名字"
);
{
  const err = new AiError("boom", "炸了", { status: 1 });
  assert.ok(err instanceof Error);
  assert.equal(err.name, "AiError");
  assert.equal(err.code, "boom");
  assert.equal(err.message, "炸了");
  assert.deepEqual(err.detail, { status: 1 });
  assert.equal(new AiError("empty_response", "空").detail, null, "detail 默认 null");
}

// ---------------------------------------------------------------------------
// 2. checkTranslationFormat：纯函数，判定与文案照搬旧实现
// ---------------------------------------------------------------------------

{
  assert.deepEqual(
    Object.keys(checkTranslationFormat("おはよう", "早上好")).sort(),
    ["errors", "ok", "warnings"],
    "只返回 { ok, errors, warnings }"
  );

  // 一条各项都配平的正常内容：{$P$} 与字面量 \n 数量一致，<color> 闭合。
  const SRC = "{$P$}、おはよう！\\n今日もいい天気だね。<color=#FF88CC>キラキラ</color>";
  const TRANS = "{$P$}，早上好！\\n今天天气也不错呢。<color=#FF88CC>闪闪发光</color>";
  assert.deepEqual(checkTranslationFormat(SRC, TRANS), { ok: true, errors: [], warnings: [] });

  // <color> 开闭不配平（两种方向都报同一条文案）
  assert.deepEqual(
    checkTranslationFormat(SRC, "{$P$}，早上好！\\n今天天气也不错呢。<color=#FF88CC>闪闪发光").errors,
    ["<color> 标签未闭合：开 1 / 闭 0。"]
  );
  assert.deepEqual(checkTranslationFormat("", "早上好</color>").errors, ["<color> 标签未闭合：开 0 / 闭 1。"]);
  assert.equal(checkTranslationFormat("", "早上好<color=#fff>呀</color>").ok, true);

  // <b> 不配对
  assert.deepEqual(checkTranslationFormat("", "<b>闪闪发光").errors, ["<b> 标签未配对：开 1 / 闭 0。"]);
  assert.deepEqual(checkTranslationFormat("", "闪闪发光</b>").errors, ["<b> 标签未配对：开 0 / 闭 1。"]);
  assert.equal(checkTranslationFormat("", "<b>闪闪发光</b>").ok, true);

  // {$P$} 数量
  assert.deepEqual(checkTranslationFormat("{$P$}、おはよう", "早上好").errors, [
    "{$P$} 数量不符：原文 1 处，译文 0 处。",
  ]);
  assert.deepEqual(checkTranslationFormat("{$P$}{$P$}、おはよう", "{$P$}，早上好").errors, [
    "{$P$} 数量不符：原文 2 处，译文 1 处。",
  ]);
  // 旧实现只在原文含 {$P$} 时才比对：译文凭空多出来的不报（保持原样）
  assert.deepEqual(checkTranslationFormat("おはよう", "{$P$}早上好{$P$}").errors, []);

  // 编号占位符 {0} {1}
  assert.deepEqual(checkTranslationFormat("{0}と{1}の約束", "{0}的约定").errors, [
    "参数占位符 {1} 缺失或数量不符：原文 1 处，译文 0 处。",
  ]);
  assert.deepEqual(checkTranslationFormat("{0}個", "{0}{0}個").errors, [
    "参数占位符 {0} 缺失或数量不符：原文 1 处，译文 2 处。",
  ]);
  assert.equal(checkTranslationFormat("{0}と{1}", "{1}和{0}").ok, true, "占位符顺序变化不算错");

  // printf 符号 %s / %d
  assert.deepEqual(checkTranslationFormat("%sさん、%d個ください", "先生，请给我个").errors, [
    "格式化符号 %s 缺失或数量不一致：原文 1 处，译文 0 处。",
    "格式化符号 %d 缺失或数量不一致：原文 1 处，译文 0 处。",
  ]);
  assert.equal(checkTranslationFormat("%sさん", "%s先生").ok, true);

  // 半角 | 与 ^ 是致命错误
  assert.deepEqual(checkTranslationFormat("おはよう", "早上好 | 世界 ^ 哦").errors, [
    '含半角 "|"，请改用全角 "｜"。',
    '含半角 "^"，请改用全角 "＾"。',
  ]);
  assert.ok(checkTranslationFormat(SRC, TRANS.replace("，", "｜")).errors.includes('含半角 "|"，请改用全角 "｜"。') === false);

  // 字面量 \n 数量不一致只是警告
  const nl = checkTranslationFormat("おはよう\\nこんばんは", "早上好，晚上好");
  assert.equal(nl.ok, true);
  assert.deepEqual(nl.errors, []);
  assert.deepEqual(nl.warnings, ["\\n 数量不一致：原文 1 处，译文 0 处。"]);

  // 译文过长也只是警告
  const long = checkTranslationFormat("ああああ", "啊啊啊啊啊啊啊啊啊啊啊");
  assert.equal(long.ok, true);
  assert.deepEqual(long.warnings, ["译文 (11 字) 比原文 (4 字) 长很多，界面可能溢出。"]);

  // 纯非 ASCII 的一行、没有任何标记：必须通过且零警告
  assert.deepEqual(checkTranslationFormat("おはよう", "早上好"), { ok: true, errors: [], warnings: [] });
  assert.deepEqual(checkTranslationFormat("プロデューサー", "制作人"), { ok: true, errors: [], warnings: [] });

  // 空译文
  assert.deepEqual(checkTranslationFormat("おはよう", ""), { ok: false, errors: ["译文为空"], warnings: [] });
  assert.deepEqual(checkTranslationFormat("おはよう", "   "), { ok: false, errors: ["译文为空"], warnings: [] });

  // 旧函数在 source 缺失时会 TypeError，这里按空串处理（见模块注释的差异说明）
  assert.deepEqual(checkTranslationFormat(undefined, "早上好"), { ok: true, errors: [], warnings: [] });
  assert.deepEqual(checkTranslationFormat(null, "早上好 |"), { ok: false, errors: ['含半角 "|"，请改用全角 "｜"。'], warnings: [] });
}

// ---------------------------------------------------------------------------
// 3. getAiConfig / setAiConfig
// ---------------------------------------------------------------------------

{
  // 默认值 + 存储不可用时的降级
  assert.deepEqual(getAiConfig(memoryStorage()), DEFAULTS);
  assert.deepEqual(getAiConfig(throwingStorage), DEFAULTS, "storage 抛异常时必须回落到默认值");
  assert.deepEqual(getAiConfig(undefined), DEFAULTS, "Node 里没有 localStorage，也不能崩");
  assert.deepEqual(getAiConfig({}), DEFAULTS, "storage 没有方法也不能崩");
  assert.deepEqual(getAiConfig(memoryStorage({ [AI_STORAGE_KEY]: "{ 这不是 JSON" })), DEFAULTS);
  assert.deepEqual(getAiConfig(memoryStorage({ [AI_STORAGE_KEY]: "null" })), DEFAULTS);
  assert.deepEqual(getAiConfig(memoryStorage({ [AI_STORAGE_KEY]: JSON.stringify(["a"]) })), DEFAULTS);
  assert.deepEqual(getAiConfig(memoryStorage({ [AI_STORAGE_KEY]: JSON.stringify("") })), DEFAULTS);

  // 往返 + trim
  const store = memoryStorage();
  setAiConfig(
    { endpoint: "  https://api.example.com/v1  ", apiKey: "  sk-round-trip  ", model: " deepseek-chat ", temperature: "0.7", systemPrompt: " 多用关西腔 " },
    store
  );
  assert.deepEqual(getAiConfig(store), {
    endpoint: "https://api.example.com/v1",
    apiKey: "sk-round-trip",
    model: "deepseek-chat",
    temperature: 0.7,
    systemPrompt: "多用关西腔",
  });
  assert.deepEqual(Object.keys(store.dump()), [AI_STORAGE_KEY], "只写新键 mltd.ai");
  assert.equal(
    store.dump()[AI_STORAGE_KEY],
    JSON.stringify({ endpoint: "https://api.example.com/v1", apiKey: "sk-round-trip", model: "deepseek-chat", temperature: 0.7, systemPrompt: "多用关西腔" }),
    "落盘的就是裁剪后的配置"
  );
  assert.deepEqual(getAiConfig(store), getAiConfig(store), "两次读取互不影响（返回新对象）");
  {
    const first = getAiConfig(store);
    first.apiKey = "被改坏了";
    assert.equal(getAiConfig(store).apiKey, "sk-round-trip", "调用方改返回值不能污染下一次读取");
  }

  // 温度 0 是合法值（滑块能拉到 0），不能被 || 顶成 0.3
  const zeroStore = memoryStorage();
  setAiConfig({ endpoint: "https://api.example.com/v1", temperature: 0 }, zeroStore);
  assert.equal(getAiConfig(zeroStore).temperature, 0);
  setAiConfig({ endpoint: "https://api.example.com/v1", temperature: "abc" }, zeroStore);
  assert.equal(getAiConfig(zeroStore).temperature, 0.3, "温度解析不出来时退回默认 0.3");

  // 空字段丢掉；全空 = 清空存储项
  const dropStore = memoryStorage();
  setAiConfig({ endpoint: "   ", apiKey: "", model: "   ", temperature: "", systemPrompt: null }, dropStore);
  assert.deepEqual(dropStore.dump(), {});
  assert.deepEqual(getAiConfig(dropStore), DEFAULTS);

  const clearStore = memoryStorage({ [AI_STORAGE_KEY]: JSON.stringify({ endpoint: "https://api.example.com/v1", apiKey: "sk-x" }) });
  setAiConfig({}, clearStore);
  assert.deepEqual(clearStore.dump(), {}, "setAiConfig({}) 清空存储项");
  setAiConfig({ endpoint: "https://api.example.com/v1", apiKey: "sk-y" }, clearStore);
  setAiConfig(null, clearStore);
  assert.deepEqual(clearStore.dump(), {}, "setAiConfig(null) 也是清空");
  assert.deepEqual(getAiConfig(clearStore), DEFAULTS);

  // 旧键 mltd_ai_config 迁移
  const legacySeed = { endpoint: " https://legacy.example.com/v1 ", apiKey: " sk-legacy-key ", model: "legacy-model", temperature: "0.5" };
  const legacyStore = memoryStorage({ [LEGACY_AI_STORAGE_KEY]: JSON.stringify(legacySeed) });
  assert.deepEqual(
    getAiConfig(legacyStore),
    { endpoint: "https://legacy.example.com/v1", apiKey: "sk-legacy-key", model: "legacy-model", temperature: 0.5, systemPrompt: "" },
    "旧键里的配置必须继续可读（老用户不用重填 Key）"
  );
  setAiConfig(getAiConfig(legacyStore), legacyStore);
  assert.deepEqual(Object.keys(legacyStore.dump()), [AI_STORAGE_KEY], "写入新键之后旧键被删掉，不留双份");
  assert.equal(getAiConfig(legacyStore).apiKey, "sk-legacy-key", "迁移后 Key 不丢");

  // 新键优先
  const bothStore = memoryStorage({
    [LEGACY_AI_STORAGE_KEY]: JSON.stringify({ endpoint: "https://legacy.example.com/v1" }),
    [AI_STORAGE_KEY]: JSON.stringify({ endpoint: "https://new.example.com/v1" }),
  });
  assert.equal(getAiConfig(bothStore).endpoint, "https://new.example.com/v1");

  // setAiConfig 是整体覆盖而不是合并
  const partialStore = memoryStorage({ [LEGACY_AI_STORAGE_KEY]: JSON.stringify({ endpoint: "https://legacy.example.com/v1", apiKey: "sk-legacy" }) });
  setAiConfig({ model: "gpt-4o-mini" }, partialStore);
  assert.deepEqual(getAiConfig(partialStore), { ...DEFAULTS, model: "gpt-4o-mini" });

  // 写失败不能把调用方带崩；写配置也不返回含 Key 的对象
  assert.doesNotThrow(() => setAiConfig({ apiKey: "sk-hostile" }, throwingStorage));
  assert.doesNotThrow(() => setAiConfig({ apiKey: "sk-no-storage" }, undefined));
  assert.doesNotThrow(() => setAiConfig(null, { setItem() { throw new Error("nope"); } }));
  assert.equal(setAiConfig({ endpoint: "https://api.example.com/v1", apiKey: "sk-quiet" }, memoryStorage()), undefined, "setAiConfig 不返回含密钥的对象");
}

// ---------------------------------------------------------------------------
// 4. callAiChat
// ---------------------------------------------------------------------------

{
  // 正常一次调用：字符串、URL、请求体、认证头
  const happy = recordFetch(() => assistantReply("  你好，制作人！  "));
  const answer = await callAiChat({ prompt: "おはよう", systemInstruction: "你是一个测试助理。", config: CONFIG, fetchImpl: happy });
  assert.equal(answer, "你好，制作人！", "返回的助手文本要 trim");
  assert.equal(happy.calls.length, 1);

  const call = happy.calls[0];
  assert.equal(call.url, "https://api.deepseek.com/v1/chat/completions", "端点自动补 /chat/completions");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers["Content-Type"], "application/json");
  assert.equal(call.init.headers.Authorization, "Bearer sk-secret-123");
  assert.deepEqual(call.body, {
    model: "deepseek-chat",
    messages: [
      { role: "system", content: "你是一个测试助理。" },
      { role: "user", content: "おはよう" },
    ],
    temperature: 0.3,
  });
  assert.ok(!call.url.includes("sk-secret-123"), "API Key 绝不能进 URL");

  // 没有 systemInstruction 时不发 system 消息
  const noSystem = recordFetch(() => assistantReply("好"));
  await callAiChat({ prompt: "おはよう", config: CONFIG, fetchImpl: noSystem });
  assert.deepEqual(noSystem.calls[0].body.messages, [{ role: "user", content: "おはよう" }]);
  assert.equal(noSystem.calls[0].body.temperature, 0.3);

  // 自定义 model / temperature 原样发出（0 也要发 0）
  const customReq = recordFetch(() => assistantReply("好"));
  await callAiChat({ prompt: "p", config: { ...CONFIG, model: "gpt-4o-mini", temperature: 0 }, fetchImpl: customReq });
  assert.deepEqual(customReq.calls[0].body, { model: "gpt-4o-mini", messages: [{ role: "user", content: "p" }], temperature: 0 });
  const emptyModel = recordFetch(() => assistantReply("好"));
  await callAiChat({ prompt: "p", config: { ...CONFIG, model: "" }, fetchImpl: emptyModel });
  assert.equal(emptyModel.calls[0].body.model, "deepseek-chat", "model 为空时退回 deepseek-chat");

  // 端点写法：带不带 /chat/completions 都要能work，且不能拼成两份
  for (const [given, expected] of [
    ["https://api.deepseek.com/v1", "https://api.deepseek.com/v1/chat/completions"],
    ["https://api.deepseek.com/v1/", "https://api.deepseek.com/v1/chat/completions"],
    ["https://api.deepseek.com/v1/chat/completions", "https://api.deepseek.com/v1/chat/completions"],
    ["https://api.deepseek.com/v1/chat/completions/", "https://api.deepseek.com/v1/chat/completions"],
    ["https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"],
    [
      "https://x.openai.azure.com/openai/deployments/gpt4/chat/completions?api-version=2024-02-01",
      "https://x.openai.azure.com/openai/deployments/gpt4/chat/completions?api-version=2024-02-01",
    ],
    ["http://127.0.0.1:11434/v1", "http://127.0.0.1:11434/v1/chat/completions"],
    ["/api/ai-proxy", "/api/ai-proxy/chat/completions"],
  ]) {
    const stub = recordFetch(() => assistantReply("ok"));
    await callAiChat({ prompt: "p", config: { ...CONFIG, endpoint: given }, fetchImpl: stub });
    assert.equal(stub.calls[0].url, expected, `端点归一化：${given}`);
    assert.ok(!stub.calls[0].url.includes("completions/chat/completions"), "不许拼出双份补全路径");
  }

  // 本地端点允许不带 Key（旧代码同样放行），且不发 Authorization
  const localStub = recordFetch(() => assistantReply("就绪"));
  const localConfig = { ...CONFIG, endpoint: "http://localhost:11434/v1/chat/completions", apiKey: "" };
  assert.equal(await callAiChat({ prompt: "p", config: localConfig, fetchImpl: localStub }), "就绪");
  assert.equal(localStub.calls[0].init.headers.Authorization, undefined);
  assert.equal(localStub.calls[0].url, "http://localhost:11434/v1/chat/completions");

  // 缺 Key：报错且不发请求
  const noKeyStub = recordFetch(() => assistantReply("不该到这一步"));
  await rejectsAi(
    callAiChat({ prompt: "p", config: { ...CONFIG, apiKey: "" }, fetchImpl: noKeyStub }),
    "missing_api_key",
    "请先在弹出窗口中配置 AI API Key！"
  );
  assert.equal(noKeyStub.calls.length, 0, "没配 Key 时不该发请求");

  // 缺端点 / 没有 fetch
  const idle = recordFetch(() => assistantReply("不该到这一步"));
  await rejectsAi(callAiChat({ prompt: "p", config: { ...CONFIG, endpoint: "   " }, fetchImpl: idle }), "missing_endpoint", "请输入 API 接口端点 (Endpoint)");
  await rejectsAi(callAiChat({ prompt: "p", config: CONFIG, fetchImpl: null }), "fetch_unavailable");
  assert.equal(idle.calls.length, 0);

  // 非 2xx → http_error，detail.status 是 HTTP 码，message 取服务端 error.message
  const httpErr = await rejectsAi(
    callAiChat({ prompt: "p", config: CONFIG, fetchImpl: recordFetch(() => textResponse(500, JSON.stringify({ error: { message: "服务器开小差了" } }))) }),
    "http_error",
    "服务器开小差了"
  );
  assert.equal(httpErr.detail.status, 500);
  assert.ok(!JSON.stringify(httpErr.detail).includes("sk-secret-123"), "detail 里不能带 Key");

  // 非 JSON 的响应体 → 取前 120 字；空响应体 → HTTP <status>
  const gatewayErr = await rejectsAi(callAiChat({ prompt: "p", config: CONFIG, fetchImpl: recordFetch(() => textResponse(502, "Bad Gateway")) }), "http_error", "Bad Gateway");
  assert.equal(gatewayErr.detail.status, 502);
  await rejectsAi(callAiChat({ prompt: "p", config: CONFIG, fetchImpl: recordFetch(() => textResponse(401, "")) }), "http_error", "HTTP 401");

  // 2xx 但 choices 空 / content 空白 → empty_response
  await rejectsAi(callAiChat({ prompt: "p", config: CONFIG, fetchImpl: recordFetch(() => jsonResponse({ choices: [] })) }), "empty_response", "AI 返回了空内容。");
  await rejectsAi(callAiChat({ prompt: "p", config: CONFIG, fetchImpl: recordFetch(() => assistantReply("   ")) }), "empty_response");
  await rejectsAi(callAiChat({ prompt: "p", config: CONFIG, fetchImpl: recordFetch(() => jsonResponse({ choices: [{ message: {} }] })) }), "empty_response");

  // 2xx 但不是 JSON → invalid_response
  await rejectsAi(
    callAiChat({
      prompt: "p",
      config: CONFIG,
      fetchImpl: recordFetch(() => ({ ok: true, status: 200, statusText: "OK", json: async () => { throw new SyntaxError("Unexpected token <"); } })),
    }),
    "invalid_response"
  );

  // 连不上 → network_error
  await rejectsAi(callAiChat({ prompt: "p", config: CONFIG, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } }), "network_error");

  // 超时：即便 fetch 不理会 abort，也要按 timeoutMs 中止
  let seenSignal = null;
  const hanging = (_url, init) => {
    seenSignal = init.signal;
    return new Promise(() => {});
  };
  const timeoutErr = await rejectsAi(callAiChat({ prompt: "p", config: CONFIG, fetchImpl: hanging, timeoutMs: 25 }), "timeout");
  assert.equal(timeoutErr.detail.timeoutMs, 25);
  assert.equal(seenSignal.aborted, true, "超时必须真的 abort 掉请求");

  // 超时落在读 body 阶段（服务端已经回 200 但一直不吐内容）：同样报 timeout
  const bodyHang = (_url, init) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: () =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
  });
  await rejectsAi(callAiChat({ prompt: "p", config: CONFIG, fetchImpl: bodyHang, timeoutMs: 25 }), "timeout");

  // 密钥不进日志：整段调用期间 console 应当是安静的
  const logged = [];
  const realConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  console.log = console.warn = console.error = console.info = (...args) => void logged.push(args.map((a) => String(a)).join(" "));
  try {
    await rejectsAi(
      callAiChat({ prompt: "p", config: CONFIG, fetchImpl: recordFetch(() => textResponse(500, JSON.stringify({ error: { message: "boom" } }))) }),
      "http_error"
    );
  } finally {
    console.log = realConsole.log;
    console.warn = realConsole.warn;
    console.error = realConsole.error;
    console.info = realConsole.info;
  }
  assert.deepEqual(logged, [], "失败也不该自己往 console 里打东西");
  assert.ok(!logged.some((line) => line.includes("sk-secret-123")));

  // 整段测试里所有请求 URL 都不许出现密钥
  assert.ok(SEEN_URLS.length > 10, "应当积累了一批请求样本");
  assert.ok(SEEN_URLS.every((url) => !url.includes("sk-")), "API Key 不得出现在任何请求 URL 里");
  assert.ok(SEEN_URLS.every((url) => !url.includes("secret")), "URL 里不得出现密钥片段");
}

// ---------------------------------------------------------------------------
// 5. buildSystemPrompt / draftTranslation
// ---------------------------------------------------------------------------

{
  const item = { source: "{$P$}、おはよう！", idol: { name_zh: "天海春香", name_ja: "天海春香" } };
  const sysPrompt = buildSystemPrompt({ item });
  assert.ok(sysPrompt.includes("你是一名精通《偶像大师 百万现场 剧场时光》(MLTD) 的资深游戏本地化专家与润色工程师。"));
  assert.ok(sysPrompt.includes("仅输出最终的中文译文"), "必须只让模型输出中文译文");
  assert.ok(sysPrompt.includes("简体中文"));
  assert.ok(sysPrompt.includes("【最高优先级引擎安全规范】"));
  assert.ok(sysPrompt.includes("{$P$}"), "安全规范里要交代占位符");
  assert.ok(sysPrompt.includes("当前讲话者为剧场偶像【天海春香】"));
  assert.ok(!sysPrompt.includes(item.source), "原文只进 user 提示，不塞进系统提示");
  assert.ok(!sysPrompt.includes("高质量润色"));

  const polishPrompt = buildSystemPrompt({ item, polish: true });
  assert.notEqual(polishPrompt, sysPrompt, "润色变体必须与翻译变体不同");
  assert.ok(polishPrompt.includes("高质量润色"));

  const bare = buildSystemPrompt({});
  assert.ok(!bare.includes("当前讲话者"), "没有偶像信息时不加人设行");
  assert.ok(!bare.includes("当前文本分类为"), "不传 category 时不加分类行");
  assert.ok(buildSystemPrompt({ item, category: " 活动短信与聊天 " }).includes("当前文本分类为【活动短信与聊天】"));
  assert.ok(buildSystemPrompt({ item: { idol: { name_ja: "春日未来" } } }).includes("【春日未来】"), "没有中文名时退回日文名");

  // 翻译：提示词、清洗、返回值
  const draftStub = recordFetch(() => assistantReply("```\n{$P$}，早上好！\n```"));
  const draft = await draftTranslation({ item, config: CONFIG, fetchImpl: draftStub });
  assert.equal(draft.text, "{$P$}，早上好！", "markdown 代码围栏要剥掉");
  assert.equal(draft.prompt, `请将以下 MLTD 游戏日文文本翻译为简体中文，严格遵守引擎特殊符号与占位符规范：\n\n${item.source}`);
  assert.ok(draft.prompt.includes(item.source), "user 提示里必须带日文原文");
  assert.ok(draft.prompt.includes("简体中文"));
  assert.equal(draft.systemPrompt, sysPrompt);
  assert.deepEqual(draftStub.calls[0].body.messages, [
    { role: "system", content: draft.systemPrompt },
    { role: "user", content: draft.prompt },
  ]);
  assert.ok(!JSON.stringify(draft).includes("sk-secret-123"), "返回值不能带出 API Key");

  // 半角 | ^ 清洗成全角（旧代码写回输入框前做的事）
  const dirtyStub = recordFetch(() => assistantReply("早上好 | 制作人 ^ 哦"));
  const dirty = await draftTranslation({ item: { source: "おはよう" }, config: CONFIG, fetchImpl: dirtyStub });
  assert.equal(dirty.text, "早上好 ｜ 制作人 ＾ 哦");
  assert.equal(checkTranslationFormat("おはよう", dirty.text).ok, true, "清洗后的译文应当能过格式校验");

  // config.systemPrompt（旧弹窗里没接线的「附加指令」）附加在系统提示之后
  const customStub = recordFetch(() => assistantReply("早上好"));
  const custom = await draftTranslation({ item: { source: "おはよう" }, config: { ...CONFIG, systemPrompt: "多用关西腔" }, fetchImpl: customStub });
  assert.ok(custom.systemPrompt.includes("【用户附加指令】\n多用关西腔"));
  assert.ok(custom.systemPrompt.includes("【最高优先级引擎安全规范】"), "附加指令不能顶掉安全规范");

  // 润色变体
  const polishItem = { source: "{$P$}、おはよう！", translation: "制作人，早上好！", idol: { name_zh: "天海春香" } };
  const polishStub = recordFetch(() => assistantReply("{$P$}，早上好呀！"));
  const polished = await draftTranslation({ item: polishItem, config: CONFIG, fetchImpl: polishStub, polish: true });
  assert.equal(polished.text, "{$P$}，早上好呀！");
  assert.ok(polished.prompt.includes("【日文原文】："));
  assert.ok(polished.prompt.includes("【已有译文】："));
  assert.ok(polished.prompt.includes("制作人，早上好！"));
  assert.ok(polished.prompt.includes("{$P$}、おはよう！"));
  assert.notEqual(polished.prompt, draft.prompt);
  assert.notEqual(polished.systemPrompt, draft.systemPrompt);
  assert.ok(polished.systemPrompt.includes("高质量润色"));

  // 没有已有译文时退回普通翻译（旧 requestAiPolish 行为）；current_translation 也算已有译文
  const fallbackStub = recordFetch(() => assistantReply("早上好"));
  const fallback = await draftTranslation({ item: { source: "おはよう" }, config: CONFIG, fetchImpl: fallbackStub, polish: true });
  assert.ok(!fallback.prompt.includes("【已有译文】"));
  assert.equal(fallback.prompt, `请将以下 MLTD 游戏日文文本翻译为简体中文，严格遵守引擎特殊符号与占位符规范：\n\nおはよう`);

  const currentStub = recordFetch(() => assistantReply("早"));
  const current = await draftTranslation({ item: { source: "おはよう", current_translation: "早" }, config: CONFIG, fetchImpl: currentStub, polish: true });
  assert.ok(current.prompt.includes("【已有译文】：\n早\n"), "current_translation 也是已有译文");

  // 缺原文直接报错，不发请求
  const sourceStub = recordFetch(() => assistantReply("不该到这一步"));
  await rejectsAi(draftTranslation({ item: { source: "   " }, config: CONFIG, fetchImpl: sourceStub }), "missing_source", "缺少日文原文，无法生成译文。");
  await rejectsAi(draftTranslation({ config: CONFIG, fetchImpl: sourceStub }), "missing_source");
  assert.equal(sourceStub.calls.length, 0);
}

// ---------------------------------------------------------------------------
// 6. testAiConnection
// ---------------------------------------------------------------------------

{
  // 成功：返回 { ok, model }，且不写用户的已存配置（旧实现会顺手 saveAiConfig）
  const testStub = recordFetch(() => assistantReply("MLTD AI 已就绪"));
  const spyStorage = memoryStorage();
  const restoreSpy = installGlobalStorage(spyStorage);
  try {
    assert.deepEqual(await testAiConnection({ config: CONFIG, fetchImpl: testStub }), { ok: true, model: "deepseek-chat" });
  } finally {
    restoreSpy();
  }
  assert.deepEqual(spyStorage.dump(), {}, "测试连接不该改用户的配置");
  assert.equal(testStub.calls[0].url, "https://api.deepseek.com/v1/chat/completions");
  assert.deepEqual(testStub.calls[0].body.messages, [
    { role: "system", content: "你是一个测试助理。" },
    { role: "user", content: "请回复一句话测试通信（如'MLTD AI 已就绪'）：" },
  ]);

  // 传了 config 就完全按参数来，不去读存储
  const overrideStub = recordFetch(() => assistantReply("ok"));
  const restoreOverride = installGlobalStorage(memoryStorage({ [AI_STORAGE_KEY]: JSON.stringify({ endpoint: "https://stored.example.com/v1", apiKey: "sk-stored" }) }));
  try {
    assert.deepEqual(await testAiConnection({ config: CONFIG, fetchImpl: overrideStub }), { ok: true, model: "deepseek-chat" });
  } finally {
    restoreOverride();
  }
  assert.equal(overrideStub.calls[0].url, "https://api.deepseek.com/v1/chat/completions");

  // 不传 config 时读本机配置
  const storedStub = recordFetch(() => assistantReply("ok"));
  const restoreStored = installGlobalStorage(memoryStorage({ [AI_STORAGE_KEY]: JSON.stringify({ endpoint: "https://stored.example.com/v1", apiKey: "sk-stored" }) }));
  try {
    assert.deepEqual(await testAiConnection({ fetchImpl: storedStub }), { ok: true, model: "deepseek-chat" });
  } finally {
    restoreStored();
  }
  assert.equal(storedStub.calls[0].url, "https://stored.example.com/v1/chat/completions");
  assert.equal(storedStub.calls[0].init.headers.Authorization, "Bearer sk-stored");

  // callAiChat 省略 config 时同样读本机配置，且温度 0 原样发出
  const globalStub = recordFetch(() => assistantReply("ok"));
  const restoreGlobal = installGlobalStorage(
    memoryStorage({ [AI_STORAGE_KEY]: JSON.stringify({ endpoint: "https://stored.example.com/v1", apiKey: "sk-stored", temperature: 0 }) })
  );
  try {
    assert.equal(await callAiChat({ prompt: "p", fetchImpl: globalStub }), "ok");
  } finally {
    restoreGlobal();
  }
  assert.equal(globalStub.calls[0].body.temperature, 0);
  assert.equal(globalStub.calls[0].init.headers.Authorization, "Bearer sk-stored");

  // 失败：缺 Key / 缺端点 / 服务端报错，都给旧按钮的中文提示
  await rejectsAi(testAiConnection({ config: { ...CONFIG, apiKey: "" }, fetchImpl: recordFetch(() => assistantReply("不该到这一步")) }), "missing_api_key", "请输入 API Key");
  await rejectsAi(testAiConnection({ config: { ...CONFIG, endpoint: "" }, fetchImpl: recordFetch(() => assistantReply("不该到这一步")) }), "missing_endpoint", "请输入 API 接口端点 (Endpoint)");
  await rejectsAi(
    testAiConnection({ config: CONFIG, fetchImpl: recordFetch(() => textResponse(500, JSON.stringify({ error: { message: "密钥无效" } }))) }),
    "http_error",
    "密钥无效"
  );
  await rejectsAi(testAiConnection({ config: CONFIG, fetchImpl: recordFetch(() => jsonResponse({ choices: [] })) }), "empty_response");
  // 失败也不该炸出非 AiError
  const unexpected = await rejectsAi(testAiConnection({ config: CONFIG, fetchImpl: async () => { throw new TypeError("Failed to fetch"); } }), "network_error");
  assert.ok(unexpected instanceof AiError);
}

console.log("ai draft module PASS");
