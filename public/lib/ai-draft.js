// AI 草拟助手：本地 AI 配置、OpenAI 兼容调用与引擎格式校验。
//
// 这一块原来长在 `public/app.js` 里（`getAiConfig` / `saveAiConfig` /
// `callAiChat` / `buildMltdAiSystemPrompt` / `checkTranslationFormat`，以及
// `requestAiTranslation` / `requestAiPolish` / `testAiConnection` 里的提示词拼装）。
// 门户改成静态站后，同一份逻辑既要在浏览器里 import，也要能在 Node 里跑测试，
// 所以抽成这个零依赖 ES module：
//
//   * 不碰 DOM：旧代码在读元素（`validateTranslationInput`）和弹配置窗（`callAiChat`
//     缺 Key 时顺手 `toggleAiConfigModal(true)`）上掺了副作用，这些全部留给调用方；
//   * 不碰网络：`fetch` 与超时都按参数注入（`fetchImpl` / `timeoutMs`）；
//   * 不碰全局：模块顶层不访问 `window` / `localStorage`，存储对象按参数传入，
//     所以 `import` 它本身在 Node 里是安全的。
//
// 密钥纪律：API Key 只进 `Authorization` 请求头。它不进 URL、不进日志，除了
// `getAiConfig()`，没有任何访问器会吐出它（`draftTranslation` / `testAiConnection`
// 的返回值里都不含 config）。

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/// 配置在本机浏览器里的存放键。旧门户用的是 `mltd_ai_config`，新站改成 `mltd.ai`。
export const AI_STORAGE_KEY = "mltd.ai";

/// 旧键：只读兼容用。`getAiConfig()` 在新键缺失时回落到它，`setAiConfig()` 则始终写新键
/// 并顺手删掉旧键（见下），这样升级后老用户不必重新填一遍 Key。
const LEGACY_AI_STORAGE_KEY = "mltd_ai_config";

/// 旧 `DEFAULT_AI_CONFIG` 的原样搬迁（`app.js:130`）。
const DEFAULT_AI_CONFIG = {
  endpoint: "https://api.deepseek.com/v1/chat/completions",
  apiKey: "",
  model: "deepseek-chat",
  temperature: 0.3,
  systemPrompt: "",
};

/// OpenAI 兼容的补全路径：端点没写到这一层时由 `resolveChatEndpoint` 补上。
const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

/// `callAiChat` 的默认超时。旧代码没有超时，一个卡住的请求会永远转圈；
/// 这里给 60 秒兜底，测试用 `timeoutMs` 注入一个更短的值即可。
const DEFAULT_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

/// 本模块所有失败的统一出口：调用方只看 `err.code`。
///
/// 已用的 code：`missing_endpoint` / `missing_api_key` / `missing_source` /
/// `fetch_unavailable` / `timeout` / `network_error` / `http_error` /
/// `invalid_response` / `empty_response`。
/// `detail` 是可选的结构化补充，例如 `{ status: 500 }`；它永远不含 API Key。
export class AiError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = "AiError";
    this.code = code;
    this.detail = detail;
    if (typeof Error.captureStackTrace === "function") Error.captureStackTrace(this, AiError);
  }
}

// ---------------------------------------------------------------------------
// 配置读写
// ---------------------------------------------------------------------------

/// 读配置，缺字段一律补旧代码的默认值。
///
/// `storage` 默认取 `globalThis.localStorage`；隐私模式或策略禁用时它会直接抛异常，
/// 此时返回默认值而不是崩掉（旧 `getAiConfig` 的 try/catch 行为）。存储不可用、
/// JSON 损坏、键不存在，三种情况都是「默认配置」。
///
/// 键的优先级：`mltd.ai`（新）→ `mltd_ai_config`（旧，只读）→ 默认值。
/// 注意这里**不会**顺手把旧键迁移成新键：读操作不写存储，迁移发生在下一次
/// `setAiConfig()`。
///
/// 返回的是每次新建的对象，调用方改它不会污染默认值。
export function getAiConfig(storage = globalThis.localStorage) {
  for (const key of [AI_STORAGE_KEY, LEGACY_AI_STORAGE_KEY]) {
    const stored = readStoredJson(storage, key);
    if (stored) return normalizeAiConfig(stored);
  }
  return normalizeAiConfig(null);
}

/// 写配置：字符串字段先 trim，空值直接丢掉，最后什么都不剩就删掉存储项（清空）。
///
/// 写的是新键 `mltd.ai`；写成功后旧键 `mltd_ai_config` 会被删除，避免同一份配置
/// 在两个键上各留一份、读数取决于谁先被读到。存储不可用时静默降级（与旧
/// `saveAiConfig` 一致），不抛异常。
///
/// 这是整体覆盖而不是合并：`setAiConfig({ model: "x" })` 之后，端点等字段回到默认值。
/// 想清空就用 `setAiConfig({})` 或 `setAiConfig(null)`。
///
/// 和旧 `saveAiConfig` 一样不返回任何东西 —— 写配置不是读取口，别让调用方顺手把含 Key
/// 的对象拿去 `console.log`，要读请走 `getAiConfig()`。
export function setAiConfig(config, storage = globalThis.localStorage) {
  const src = config && typeof config === "object" ? config : {};

  // 按固定顺序组装，落盘的 JSON 字段顺序与默认配置一致，方便人肉看 localStorage。
  const candidates = {
    endpoint: asTrimmedString(src.endpoint),
    apiKey: asTrimmedString(src.apiKey),
    model: asTrimmedString(src.model),
    temperature: pickTemperature(src.temperature, null),
    systemPrompt: asTrimmedString(src.systemPrompt),
  };
  const stored = {};
  for (const [field, value] of Object.entries(candidates)) {
    if (value === "" || value === null || value === undefined) continue;
    stored[field] = value;
  }

  try {
    if (Object.keys(stored).length === 0) {
      storage?.removeItem?.(AI_STORAGE_KEY);
      storage?.removeItem?.(LEGACY_AI_STORAGE_KEY);
    } else {
      storage?.setItem?.(AI_STORAGE_KEY, JSON.stringify(stored));
      storage?.removeItem?.(LEGACY_AI_STORAGE_KEY);
    }
  } catch (_) {
    // 私密模式 / 配额满 / 存储被禁用：和旧 saveAiConfig 一样吞掉，调用方照常继续。
  }
}

// ---------------------------------------------------------------------------
// 调用
// ---------------------------------------------------------------------------

/// 调一次 OpenAI 兼容的 `/chat/completions`，返回助手文本（已 trim）。
///
/// 端点：`config.endpoint` 写到 `.../v1` 或 `.../v1/` 都行，模块会补上
/// `/chat/completions`；已经写到补全路径的（含 Azure 那种带 `?api-version=` 的）
/// 原样使用，不会拼出 `chat/completions/chat/completions`。
///
/// 认证：有 Key 就发 `Authorization: Bearer <apiKey>`；`localhost` / `127.0.0.1`
/// 视为本地 Ollama 之类的服务，允许不带 Key（旧代码同样放行）。
///
/// 超时：默认 60 秒（`DEFAULT_TIMEOUT_MS`），用 `timeoutMs` 注入别的值。
/// 超时抛 `AiError("timeout")`。
///
/// 失败即抛 `AiError`：非 2xx → `http_error`（`detail.status` 是 HTTP 状态码，
/// `message` 取服务端 `error.message`，取不到就用响应体前 120 字，再取不到就是
/// `HTTP <status>`）；2xx 但不是 JSON → `invalid_response`；`choices[0].message.content`
/// 缺失或全空白 → `empty_response`。
export async function callAiChat({
  prompt,
  systemInstruction = null,
  config,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const cfg = config === undefined || config === null ? getAiConfig() : normalizeAiConfig(config);
  const endpoint = resolveChatEndpoint(cfg.endpoint);

  // 旧代码在这里还会弹出配置弹窗；模块不碰 DOM，只把同一句提示作为错误抛出。
  if (!cfg.apiKey && !isLocalEndpoint(cfg.endpoint)) {
    throw new AiError("missing_api_key", "请先在弹出窗口中配置 AI API Key！");
  }
  if (typeof fetchImpl !== "function") {
    throw new AiError("fetch_unavailable", "当前环境没有可用的 fetch，无法调用 AI 接口。");
  }

  const messages = [];
  if (systemInstruction) messages.push({ role: "system", content: String(systemInstruction) });
  messages.push({ role: "user", content: prompt === undefined || prompt === null ? "" : String(prompt) });

  const headers = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const body = {
    model: cfg.model || DEFAULT_AI_CONFIG.model,
    messages,
    temperature: cfg.temperature,
  };

  const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);

  try {
    let res;
    try {
      res = await Promise.race([
        fetchImpl(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        rejectOnAbort(controller.signal, effectiveTimeout),
      ]);
    } catch (err) {
      throw toRequestFailure(err, controller.signal, effectiveTimeout);
    }

    if (!res || typeof res !== "object") {
      throw new AiError("invalid_response", "AI 接口返回了无法识别的响应。");
    }

    if (!res.ok) {
      const raw = await readTextSafely(res);
      throw new AiError("http_error", describeHttpError(raw, res.status), {
        status: res.status,
        statusText: res.statusText || "",
      });
    }

    let data;
    try {
      if (typeof res.json !== "function") throw new Error("no json() on response");
      data = await res.json();
    } catch (_) {
      // 读 body 阶段被超时打断时，报 timeout 而不是 invalid_response。
      if (controller.signal.aborted) {
        throw new AiError("timeout", `AI 接口在 ${effectiveTimeout}ms 内没有响应，已中止请求。`, {
          timeoutMs: effectiveTimeout,
        });
      }
      throw new AiError("invalid_response", "AI 接口返回的不是合法 JSON。", { status: res.status });
    }

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new AiError("empty_response", "AI 返回了空内容。", { model: body.model });
    }
    return content.trim();
  } catch (err) {
    if (err instanceof AiError) throw err;
    throw toRequestFailure(err, controller.signal, effectiveTimeout);
  } finally {
    clearTimeout(timer);
  }
}

/// 翻译（`polish: false`）或润色（`polish: true`）一条文本，返回最终写法与用过的提示词。
///
/// `item`：`{ source, translation?, current_translation?, idol?: { name_zh, name_ja }, category? }`，
/// 就是列表里的一条内容。`polish` 但没有已有译文时（旧代码的 `requestAiPolish` 行为）
/// 退回普通翻译。译文会做和旧代码一样的清洗：去掉 markdown 代码围栏、把半角 `|` `^`
/// 换成全角，再 trim。
///
/// `config` 省略时读 `getAiConfig()`；**一旦传入就完全按它来**（内部补默认值），
/// 不会再去读存储，避免显式参数和已存配置悄悄混在一起。`config.systemPrompt`
/// （旧弹窗里那个从来没接线的「附加指令」输入框）作为附加块接在系统提示之后，
/// 不会替换掉引擎安全规范。
///
/// 返回值：`{ text, prompt, systemPrompt }` —— 都不含 API Key。
export async function draftTranslation({ item, config, fetchImpl, polish = false, timeoutMs } = {}) {
  const source = typeof item?.source === "string" ? item.source : "";
  if (!source.trim()) {
    throw new AiError("missing_source", "缺少日文原文，无法生成译文。");
  }

  const cfg = config === undefined || config === null ? getAiConfig() : normalizeAiConfig(config);
  const existing = asTrimmedString(item?.translation ?? item?.current_translation);
  const usePolish = Boolean(polish) && Boolean(existing);
  const category = asTrimmedString(item?.category);

  const baseSystemPrompt = buildSystemPrompt({ item, polish: usePolish, category });
  const systemPrompt = cfg.systemPrompt
    ? `${baseSystemPrompt}\n\n【用户附加指令】\n${cfg.systemPrompt}`
    : baseSystemPrompt;

  const prompt = usePolish ? buildPolishPrompt(source, existing) : buildTranslatePrompt(source);
  const raw = await callAiChat({ prompt, systemInstruction: systemPrompt, config: cfg, fetchImpl, timeoutMs });
  return { text: cleanAssistantText(raw), prompt, systemPrompt };
}

/// 「测试连接」：发一句固定问候，通得过就返回 `{ ok: true, model }`，否则抛 `AiError`。
///
/// 和旧按钮的区别：旧实现先把输入框的值 `saveAiConfig()` 落盘再借 `callAiChat` 发请求，
/// 所以「测试」会顺手改掉用户已保存的配置；这里直接用传入的 `config`，不写存储。
export async function testAiConnection({ config, fetchImpl, timeoutMs } = {}) {
  const cfg = config === undefined || config === null ? getAiConfig() : normalizeAiConfig(config);

  // 这两句是旧「测试连接」按钮的原话，测试路径上先自己校验，报错比服务端回 401 清楚。
  if (!cfg.endpoint) {
    throw new AiError("missing_endpoint", "请输入 API 接口端点 (Endpoint)");
  }
  if (!cfg.apiKey && !isLocalEndpoint(cfg.endpoint)) {
    throw new AiError("missing_api_key", "请输入 API Key");
  }

  await callAiChat({
    prompt: "请回复一句话测试通信（如'MLTD AI 已就绪'）：",
    systemInstruction: "你是一个测试助理。",
    config: cfg,
    fetchImpl,
    timeoutMs,
  });
  return { ok: true, model: cfg.model || DEFAULT_AI_CONFIG.model };
}

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------

/// 系统提示词：`buildMltdAiSystemPrompt` 的搬迁（引擎安全规范一字未改）。
///
/// `polish` 对应旧的 `isPolish`（多一句「或对已有译文进行高质量润色」）。
/// `category` 是新增的可选上下文：传了就多一行分类说明，不传时输出与旧函数完全一致。
export function buildSystemPrompt({ item, polish = false, category = "" } = {}) {
  const contextLines = [];
  if (item && item.idol) {
    contextLines.push(
      `当前讲话者为剧场偶像【${item.idol.name_zh || item.idol.name_ja}】。请保持符合该角色的人设语气与性格习惯。`
    );
  }
  const categoryText = asTrimmedString(category);
  if (categoryText) {
    contextLines.push(`当前文本分类为【${categoryText}】。请沿用该分类既有的用语与口吻。`);
  }
  const itemContext = contextLines.join("\n");

  return `你是一名精通《偶像大师 百万现场 剧场时光》(MLTD) 的资深游戏本地化专家与润色工程师。
你的任务是将日文原文翻译为自然流畅、符合简体中文本土化表达、符合偶像人设性格的译文${polish ? "（或对已有译文进行高质量润色）" : ""}。

【最高优先级引擎安全规范】（任何违反都将导致游戏客户端崩溃或数据损坏）：
1. 严禁出现任何半角竖线 "|" 或脱字符 "^"！如果原文或表达中需要分隔，必须转为全角 "｜" 或 "＾"，或用逗号、破折号替代。
2. 完整保留所有制作人占位符：必须严格保留 "{$P$}"，绝不能翻译成 "制作人" 或删去。
3. 完整保留所有编号参数占位符：如 "{0}", "{1}", "{2}" 等，不得修改其编号或丢失。
4. 完整保留所有 printf 格式化占位符：如 "%s", "%d", "%f" 等。
5. 完整保留所有 Unity 富文本样式标签：如 "<color=#HEX>...</color>", "<b>...</b>"，必须闭合完整。
6. 转义换行符 "\\n"：若原文含有 "\\n"，翻译时应保留 "\\n" 维持对话排版。
7. 标准偶像译名：如 天海春香、春日未来、最上静香、伊吹翼、艾蜜莉·司徒亚特、白石紬、樱守歌织 等 52 位剧场偶像官方标准中文名。
${itemContext}

【输出要求】：
仅输出最终的中文译文，严禁输出任何解释、注释、思考过程或包裹 markdown 代码块（如不要带 \`\`\` ）。`;
}

/// 旧 `requestAiTranslation` 的 user 提示词（一字未改）。
function buildTranslatePrompt(source) {
  return `请将以下 MLTD 游戏日文文本翻译为简体中文，严格遵守引擎特殊符号与占位符规范：\n\n${source}`;
}

/// 旧 `requestAiPolish` 的 user 提示词（一字未改）。
function buildPolishPrompt(source, existing) {
  return `请在保留原意、保留全部特殊控制符和占位标签的前提下，对已有译文进行通顺度与角色口吻润色优化：
【日文原文】：
${source}

【已有译文】：
${existing}

请输出润色优化后的简体中文译文：`;
}

/// 旧代码在写回输入框前的清洗：剥掉 markdown 代码围栏 → 半角 `|` `^` 换全角 → trim。
function cleanAssistantText(text) {
  return String(text ?? "")
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/\n?```$/i, "")
    .replace(/\|/g, "｜")
    .replace(/\^/g, "＾")
    .trim();
}

// ---------------------------------------------------------------------------
// 引擎安全格式校验
// ---------------------------------------------------------------------------

/// 纯粹的格式校验：`(source, translation) -> { ok, errors, warnings }`。
///
/// 逐条搬迁旧 `checkTranslationFormat`（`app.js:248`）的判定与文案：
/// 半角 `|` `^`、`{$P$}` 数量、`{0}` 之类编号参数、printf 符号 `%s` `%d`、
/// `<color=...>` 与 `<b>` 的闭合、字面量 `\n` 数量（警告）与译文过长（警告）。
///
/// 与旧函数的差别只有两处，都不改判定：
///   * 返回字段 `isValid` 改名为 `ok`（元素读取那段本来就在 `validateTranslationInput`
///     里，没有混进来，所以这里天生是纯函数）；
///   * `source` 不是字符串时按空串处理，不再 TypeError（旧函数会直接抛）。
///
/// 注意：旧代码的注释提到 `<i>` 标签，但只实现了 `<color>` 与 `<b>` 两项检查，
/// 这里保持一致，没有替它补上。
export function checkTranslationFormat(source, translation) {
  const errors = [];
  const warnings = [];

  if (!translation || !translation.trim()) {
    return { ok: false, errors: ["译文为空"], warnings: [] };
  }

  const src = typeof source === "string" ? source : "";
  const text = String(translation);

  // 1. 致命错误：半角 | 与 ^ (引擎崩溃控制字符)
  if (text.includes("|")) {
    errors.push('含半角 "|"，请改用全角 "｜"。');
  }
  if (text.includes("^")) {
    errors.push('含半角 "^"，请改用全角 "＾"。');
  }

  // 2. 制作人变量 {$P$}
  const pVarRegex = /\{\$P\$\}/g;
  const srcPCount = (src.match(pVarRegex) || []).length;
  const transPCount = (text.match(pVarRegex) || []).length;
  if (srcPCount > 0 && transPCount !== srcPCount) {
    errors.push(`{$P$} 数量不符：原文 ${srcPCount} 处，译文 ${transPCount} 处。`);
  }

  // 3. 数字变量参数 {0}, {1}, {2}...
  const numArgRegex = /\{[0-9]+\}/g;
  const srcNumArgs = src.match(numArgRegex) || [];
  const transNumArgs = text.match(numArgRegex) || [];
  const srcArgsSet = new Set(srcNumArgs);
  for (const arg of srcArgsSet) {
    const srcArgCount = srcNumArgs.filter((a) => a === arg).length;
    const transArgCount = transNumArgs.filter((a) => a === arg).length;
    if (transArgCount !== srcArgCount) {
      errors.push(`参数占位符 ${arg} 缺失或数量不符：原文 ${srcArgCount} 处，译文 ${transArgCount} 处。`);
    }
  }

  // 4. printf 格式化符号 %s, %d, %f 等
  const printfRegex = /%[0-9]*[a-zA-Z]/g;
  const srcPrintf = src.match(printfRegex) || [];
  const transPrintf = text.match(printfRegex) || [];
  if (srcPrintf.length > 0) {
    for (const fmt of new Set(srcPrintf)) {
      const srcCnt = srcPrintf.filter((f) => f === fmt).length;
      const transCnt = transPrintf.filter((f) => f === fmt).length;
      if (transCnt !== srcCnt) {
        errors.push(`格式化符号 ${fmt} 缺失或数量不一致：原文 ${srcCnt} 处，译文 ${transCnt} 处。`);
      }
    }
  }

  // 5. Unity 富文本标签闭合检查 <color=...>...</color>, <b>...</b>（旧注释里的 <i> 没实现）
  const colorOpenRegex = /<color=[^>]+>/gi;
  const colorCloseRegex = /<\/color>/gi;
  const colorOpenCnt = (text.match(colorOpenRegex) || []).length;
  const colorCloseCnt = (text.match(colorCloseRegex) || []).length;
  if (colorOpenCnt !== colorCloseCnt) {
    errors.push(`<color> 标签未闭合：开 ${colorOpenCnt} / 闭 ${colorCloseCnt}。`);
  }

  const bOpenCnt = (text.match(/<b>/gi) || []).length;
  const bCloseCnt = (text.match(/<\/b>/gi) || []).length;
  if (bOpenCnt !== bCloseCnt) {
    errors.push(`<b> 标签未配对：开 ${bOpenCnt} / 闭 ${bCloseCnt}。`);
  }

  // 6. 警告提示 (Warnings，不阻断提交)
  const newlineRegex = /\\n/g;
  const srcNlCnt = (src.match(newlineRegex) || []).length;
  const transNlCnt = (text.match(newlineRegex) || []).length;
  if (srcNlCnt > 0 && transNlCnt !== srcNlCnt) {
    warnings.push(`\\n 数量不一致：原文 ${srcNlCnt} 处，译文 ${transNlCnt} 处。`);
  }

  if (src.length >= 4 && text.length > src.length * 2.5) {
    warnings.push(`译文 (${text.length} 字) 比原文 (${src.length} 字) 长很多，界面可能溢出。`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/// 读一个键并解析成普通对象；存储抛异常、键不存在、JSON 损坏、存的是数组或标量，
/// 一律当作「没有配置」，由调用方回落到默认值或旧键。
function readStoredJson(storage, key) {
  try {
    const raw = storage?.getItem?.(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

/// 把任意来源的对象整形成标准配置：字符串 trim，缺字段补默认值，
/// 显式空串保留为空串（让「端点没填」在调用时报一句清楚的错，而不是悄悄打到 DeepSeek）。
function normalizeAiConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    endpoint: asTrimmedStringWithDefault(src.endpoint, DEFAULT_AI_CONFIG.endpoint),
    apiKey: asTrimmedStringWithDefault(src.apiKey, DEFAULT_AI_CONFIG.apiKey),
    model: asTrimmedStringWithDefault(src.model, DEFAULT_AI_CONFIG.model),
    temperature: pickTemperature(src.temperature, DEFAULT_AI_CONFIG.temperature),
    systemPrompt: asTrimmedStringWithDefault(src.systemPrompt, DEFAULT_AI_CONFIG.systemPrompt),
  };
}

function asTrimmedString(value) {
  if (typeof value === "string") return value.trim();
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function asTrimmedStringWithDefault(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return asTrimmedString(value);
}

/// 温度：数字或数字字符串都收，非法值走 `fallback`（传 `null` 表示「这个字段不要」）。
/// 旧代码写的是 `parseFloat(x) || 0.3`，会把用户明确选的 0 也顶成 0.3；滑块本来就能拉到 0，
/// 所以这里保留 0。
function pickTemperature(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const num = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(num) ? num : fallback;
}

/// 端点归一化：`.../v1`、`.../v1/` → `.../v1/chat/completions`；已经到补全层的原样用。
/// 用 `URL` 只改 pathname，查询串（Azure 的 `?api-version=` 之类）原样保留。
function resolveChatEndpoint(endpoint) {
  const trimmed = asTrimmedString(endpoint);
  if (!trimmed) {
    throw new AiError("missing_endpoint", "请输入 API 接口端点 (Endpoint)");
  }

  let url = null;
  try {
    url = new URL(trimmed);
  } catch (_) {
    url = null; // 相对路径（同源代理）走下面的字符串拼接。
  }

  if (url) {
    const path = url.pathname.replace(/\/+$/, "");
    url.pathname = path.toLowerCase().endsWith(CHAT_COMPLETIONS_SUFFIX) ? path : `${path}${CHAT_COMPLETIONS_SUFFIX}`;
    return url.toString();
  }

  const bare = trimmed.replace(/\/+$/, "");
  if (bare.toLowerCase().endsWith(CHAT_COMPLETIONS_SUFFIX)) return bare;
  return `${bare}${CHAT_COMPLETIONS_SUFFIX}`;
}

/// 旧代码的本地服务判定：带 Key 就发，不带 Key 只放行本机端点。
function isLocalEndpoint(endpoint) {
  const text = asTrimmedString(endpoint);
  return text.includes("localhost") || text.includes("127.0.0.1");
}

/// 让超时能盖住「fetch 不理会 abort」的实现（stub 或某些代理层）：
/// 和 fetch promise 赛跑，abort 一触发就先抛 `timeout`。
function rejectOnAbort(signal, timeoutMs) {
  return new Promise((_, reject) => {
    const onAbort = () =>
      reject(new AiError("timeout", `AI 接口在 ${timeoutMs}ms 内没有响应，已中止请求。`, { timeoutMs }));
    if (typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/// 把 fetch 阶段的异常翻成 AiError：abort 过就是超时，其余算网络错误。
/// 只用 `err.message`，绝不把整个异常对象塞进 detail（避免把请求细节带进日志）。
function toRequestFailure(err, signal, timeoutMs) {
  if (err instanceof AiError) return err;
  if (signal?.aborted) {
    return new AiError("timeout", `AI 接口在 ${timeoutMs}ms 内没有响应，已中止请求。`, { timeoutMs });
  }
  const reason = err instanceof Error ? err.message : String(err ?? "unknown error");
  return new AiError("network_error", `无法连接 AI 接口：${reason}`, { reason });
}

/// 非 2xx 的提示文案，沿用旧 callAiChat 的三段式：
/// 默认 `HTTP <status>`，能解析出 `error.message` 就用它，响应体不是 JSON 就取前 120 字。
/// 旧代码在响应体为空时会得到空提示，这里补回 `HTTP <status>`。
function describeHttpError(errText, status) {
  const raw = typeof errText === "string" ? errText : "";
  let message = `HTTP ${status}`;
  try {
    const parsed = JSON.parse(raw);
    message = parsed?.error?.message || message;
  } catch (_) {
    message = raw.slice(0, 120).trim() || message;
  }
  return message;
}

async function readTextSafely(res) {
  try {
    return typeof res.text === "function" ? await res.text() : "";
  } catch (_) {
    return "";
  }
}
