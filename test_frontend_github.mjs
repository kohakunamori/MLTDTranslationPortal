// Front-end GitHub-proposal suite.
//
// This harness runs the *real* page script, not a paraphrase of it: the inline
// `app.js` and `public/github-contribution.js` are read from disk, evaluated in a
// VM context with a recording `fetch` and a stub DOM, and then driven through
// the same functions the browser calls (`submitCurrentTranslation`,
// `saveSingleLyricLine`, `submitStudioRestore`, `loadAdminProposals`, …).
//
// The fixtures are shaped the way the API serves a resource — a *nested*
// `github` binding (`{target, path, base_commit, source_sha256}`) plus the one
// version axis the target needs — because a flat mock with `path` at the top
// level would pass while the page failed against the real payload.
//
// Covered:
//   1. tolerance parity with the Worker's gate,
//   2. both repositories' request fields + CSRF header,
//   3. a single-line edit that cannot overwrite a whole file,
//   4. the PR link rendered from the response,
//   5. a high-resolution upload accepted and a stretched one refused,
//   6. the retired write paths never called,
//   7. an API failure never reported as success,
//   8. a binding that names the wrong or no repository is refused.
//
// Not covered: real pixels (the images here are constructed PNG headers parsed
// by `src/image_ratio.js`), real CSS layout, and real browsers' `Image`
// decoding. The stub `Image` reads the dimensions out of the data URL with the
// same header parser the Worker uses, which is what makes case 5 meaningful.
//
// Run: node test_frontend_github.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { DEFAULT_RATIO_TOLERANCE, checkAspectRatio, parseImageSize } from "./src/image_ratio.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "public");

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`ok ${checks} - ${name}`);
}

// ---------------------------------------------------------------------------
// DOM stub
// ---------------------------------------------------------------------------

/// A DOM small enough to run this page and large enough to assert on: elements
/// are addressed by id, `innerHTML` is stored as the string it was set to, and
/// listeners are recorded so a test can click a button the way a user would.
function createDom() {
  const registry = new Map();

  function makeClassList(el) {
    const tokens = () => el.className.split(/\s+/).filter(Boolean);
    return {
      add: (...names) => { el.className = [...new Set([...tokens(), ...names])].join(" "); },
      remove: (...names) => { el.className = tokens().filter((t) => !names.includes(t)).join(" "); },
      contains: (name) => tokens().includes(name),
      toggle: (name, force) => {
        const has = tokens().includes(name);
        const want = force === undefined ? !has : Boolean(force);
        if (want) el.classList.add(name); else el.classList.remove(name);
        return want;
      },
    };
  }

  class StubElement {
    constructor(tag = "div") {
      this.tagName = tag;
      this._id = "";
      this.className = "";
      this.style = {};
      this._text = "";
      this._html = "";
      this.value = "";
      this.disabled = false;
      this.href = "";
      this.download = "";
      this.src = "";
      this.type = "";
      this.title = "";
      this.dataset = {};
      this.children = [];
      this.listeners = {};
      this.classList = makeClassList(this);
    }
    set id(value) { this._id = value; registry.set(value, this); }
    get id() { return this._id; }
    get textContent() { return this._text; }
    set textContent(value) { this._text = String(value); }
    get innerHTML() { return this._html; }
    set innerHTML(value) {
      this._html = String(value);
      // A `<select>` built by setting innerHTML: the page reads `.value` and
      // `.options` the way a browser exposes them, so the stub populates both
      // from the markup. The stub has no parser and elements are created by id
      // rather than from the document, so this keys off the markup itself — an
      // innerHTML that defines options *is* a select's, whatever tag it was
      // created as.
      if (this._html.includes("<option")) {
        const options = [...this._html.matchAll(/<option value="([^"]*)"/g)].map((match) => ({ value: match[1] }));
        this.options = options;
        const values = options.map((option) => option.value);
        if (!values.includes(this.value)) this.value = values.find((entry) => entry !== "") || "";
      }
    }
    // The page sets these directly; expose them so the header can be checked.
    get outerHTML() { return this._html; }
    setAttribute(name, value) { if (name === "id") { this.id = value; return; } this[name] = value; }
    getAttribute(name) { return this[name] === undefined ? null : this[name]; }
    addEventListener(type, handler) { (this.listeners[type] = this.listeners[type] || []).push(handler); }
    click() { for (const handler of this.listeners.click || []) handler({ preventDefault() {}, stopPropagation() {}, target: this }); }
    appendChild(child) { this.children.push(child); return child; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items.slice(); }
    insertAdjacentHTML() {}
    remove() {}
    focus() {}
    scrollIntoView() {}
    querySelector(selector) {
      if (String(selector).startsWith("#")) return get(selector.slice(1));
      return null;
    }
    querySelectorAll() { return []; }
    getContext() {
      return { clearRect() {}, fillRect() {}, drawImage() {}, fillStyle: "", strokeStyle: "" };
    }
  }

  function get(id) {
    let el = registry.get(id);
    if (!el) { el = new StubElement(); el.id = id; }
    return el;
  }

  const document = {
    getElementById: (id) => get(id),
    querySelector: (selector) => (String(selector).startsWith("#") ? get(String(selector).slice(1)) : null),
    querySelectorAll: () => [],
    createElement: (tag) => new StubElement(tag),
    addEventListener: () => {},
    body: new StubElement("body"),
  };

  return { document, get, registry, StubElement };
}

/// A browser-ish `Image`: setting `src` decodes the data URL with the same
/// header parser the Worker uses, and reports through `onload`/`onerror`.
function createImageClass() {
  const loaded = [];
  class StubImage {
    constructor() {
      this.width = 0;
      this.height = 0;
      this.onload = null;
      this.onerror = null;
      this._src = "";
    }
    set src(value) {
      this._src = value;
      queueMicrotask(() => {
        try {
          const comma = String(value).indexOf(",");
          const bytes = new Uint8Array(Buffer.from(String(value).slice(comma + 1), "base64"));
          const size = parseImageSize(bytes);
          this.width = size.width;
          this.height = size.height;
          loaded.push(this);
          if (this.onload) this.onload({ target: this });
        } catch (error) {
          if (this.onerror) this.onerror({ target: this, error });
        }
      });
    }
    get src() { return this._src; }
  }
  StubImage.loaded = loaded;
  return StubImage;
}

// ---------------------------------------------------------------------------
// page loader
// ---------------------------------------------------------------------------

/// Load `public/github-contribution.js` and `public/app.js` into one VM context
/// with a recording fetch, and hand back the hooks the page exposes for tests.
function loadPage() {
  const dom = createDom();
  const calls = [];
  const navigations = [];

  const routes = [];
  function program(match, handler) {
    routes.push({ match, handler });
  }
  function reply(body, status = 200) {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  async function recordingFetch(url, init = {}) {
    const call = {
      url: String(url),
      method: String(init.method || "GET").toUpperCase(),
      headers: new Headers(init.headers || {}),
      credentials: init.credentials || "",
      body: init.body,
      json: null,
    };
    if (typeof call.body === "string") {
      try { call.json = JSON.parse(call.body); } catch (_) { call.json = null; }
    }
    calls.push(call);
    // Last registration wins, so a test can override a default the boot helper
    // installed without having to undo it first.
    let route = null;
    for (let index = routes.length - 1; index >= 0; index -= 1) {
      const entry = routes[index];
      if (entry.match instanceof RegExp ? entry.match.test(call.url) : call.url === entry.match) { route = entry; break; }
    }
    if (!route) return reply({ ok: true }, 200);
    return route.handler(call);
  }
  recordingFetch.calls = calls;
  recordingFetch.program = program;
  recordingFetch.reply = reply;

  const storage = () => {
    const map = new Map();
    return {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => map.set(key, String(value)),
      removeItem: (key) => map.delete(key),
      clear: () => map.clear(),
    };
  };

  const windowListeners = {};
  const sandbox = {
    console,
    fetch: recordingFetch,
    addEventListener: (type, handler) => { (windowListeners[type] = windowListeners[type] || []).push(handler); },
    removeEventListener: () => {},
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    Headers,
    Response,
    Blob,
    Uint8Array,
    ArrayBuffer,
    Promise,
    queueMicrotask,
    setImmediate,
    localStorage: storage(),
    sessionStorage: storage(),
    confirm: () => true,
    setTimeout: () => 0,
    clearTimeout: () => {},
    FileReader: class {
      readAsDataURL(file) {
        this.result = `data:${file.type};base64,${file.base64}`;
        queueMicrotask(() => { if (this.onload) this.onload({ target: this }); });
      }
    },
    Image: createImageClass(),
    document: dom.document,
    location: {
      set href(value) { navigations.push(value); },
      get href() { return navigations[navigations.length - 1] || "http://localhost/"; },
      hostname: "localhost",
      protocol: "http:",
      reload: () => navigations.push("reload"),
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const context = vm.createContext(sandbox);
  for (const file of ["github-contribution.js", "app.js"]) {
    const source = fs.readFileSync(path.join(PUBLIC, file), "utf8");
    vm.runInContext(source, context, { filename: `public/${file}` });
  }

  return {
    hooks: sandbox.__portalTestHooks,
    dom,
    calls,
    navigations,
    recordingFetch,
    get toast() { const el = dom.get("toast"); return { text: el.textContent, visible: el.classList.contains("show") }; },
    program,
    reply,
  };
}

function resetCalls(page) {
  page.calls.length = 0;
}

function writeCalls(page) {
  return page.calls.filter((call) => call.method !== "GET");
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/// A PNG with a real signature and a real IHDR chunk (CRC included): the header
/// both this suite and the Worker parse.
function makePng(width, height) {
  const u32be = (value) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  const body = [..."IHDR"].map((c) => c.charCodeAt(0)).concat(u32be(width), u32be(height), [8, 6, 0, 0, 0]);
  const bytes = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...u32be(13), ...body, ...u32be(crc32(Uint8Array.from(body))),
  ];
  return Uint8Array.from(bytes);
}

function dataUrlFor(bytes) {
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

const ASSETS_BINDING = { target: "assets", path: "locales/story/event_0448.jsonl", base_commit: "c".repeat(40), source_sha256: "ea4cef9ff36d07f10f6bd00f4163edfa882ccd469392bc96127a9b2b6b45ae7f" };

/// A catalogue row exactly as `decorateCatalogueRow` serves it, extended with
/// the binding the proposal contract requires. The binding is nested under
/// `github` on purpose: that is the shape the contract names, and a test that
/// flattened it would pass while the page failed.
function assetsRow(overrides = {}) {
  return {
    asset_version: "1077100",
    bundle: "event_0448_story_06",
    item_key: "event_0448_story_06_title",
    logical_key: "event_0448_story_06:event_0448_story_06_title",
    source: "本領発揮",
    source_sha256: ASSETS_BINDING.source_sha256,
    translation: null,
    status: "untranslated",
    github: { ...ASSETS_BINDING },
    ...overrides,
  };
}

/// A client-channel row: `client_version` only, never an asset axis, with the
/// binding naming the client repository.
function clientRow(overrides = {}) {
  return {
    client_version: "9.0.200",
    bundle: "apk_builtin",
    item_key: "bottom_bar:shop",
    logical_key: "apk_builtin:bottom_bar:shop",
    source: "ショップ",
    source_sha256: "b".repeat(64),
    translation: null,
    status: "untranslated",
    github: { target: "client", path: "text/bottom-bar.jsonl", base_commit: "d".repeat(40), source_sha256: "b".repeat(64) },
    ...overrides,
  };
}

/// An image task as the service serves it: the geometry the gate reads, the
/// task's **own** original hash (never the upload's), and the github binding.
function imageTask(overrides = {}) {
  return {
    task_id: "t1",
    bundle: "event_0015_info",
    width: 512,
    height: 512,
    asset_version: "1077100",
    source_sha256: "f".repeat(64),
    status: "untranslated",
    github: { target: "assets", path: "images/restored/t1/restored-texture.png", base_commit: "e".repeat(40), source_sha256: "f".repeat(64) },
    ...overrides,
  };
}

function githubMe({ login = "contributor", csrfToken = "csrf-abc123", avatar = "https://avatars.example/u/1" } = {}) {
  return {
    authenticated: true,
    login,
    github_user_id: 42,
    avatar_url: avatar,
    role: "contributor",
    csrfToken,
  };
}

/// Boot the page with the identity probe answering `me` and the catalogue
/// serving `rows`.
async function bootWith({ me = githubMe(), catalogueRows = [], identityStatus = 200 } = {}) {
  const page = loadPage();
  page.program("/api/me", () => page.reply({ actor: { email: "contributor@example.com", role: "contributor" } }));
  page.program("/api/auth/github/me", () => (identityStatus === 200 ? page.reply(me) : page.reply({ error: "authentication_required" }, identityStatus)));
  page.program("/api/terms", () => page.reply({ terms: [], idols: {} }));
  page.program("/api/stats", () => page.reply({ summary: {} }));
  page.program(/^\/api\/catalogue\/search/, () => page.reply({ rows: catalogueRows, items: catalogueRows }));
  page.program(/^\/api\/client\/releases/, () => page.reply({ releases: [] }));
  page.program(/^\/api\/assets\/releases/, () => page.reply({ releases: [] }));

  assert.ok(page.hooks, "the page must expose its offline hooks");
  await page.hooks.init();
  await new Promise((resolve) => setImmediate(resolve));
  resetCalls(page);
  return page;
}

/// Put the studio into the state `submitCurrentTranslation` expects.
function primeStudio(page, item, translation) {
  page.hooks.state.currentItem = item;
  page.dom.get("translation-input").value = translation;
  page.dom.get("btn-studio-submit").disabled = false;
  page.dom.get("btn-studio-submit").textContent = "提交 PR (Ctrl+Enter)";
}

// ---------------------------------------------------------------------------
// 1. tolerance parity with the Worker's gate
// ---------------------------------------------------------------------------

await check("ratio tolerance matches the Worker's and the two gates agree case for case", () => {
  const moduleContext = vm.createContext({ module: { exports: {} }, console });
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, "github-contribution.js"), "utf8"), moduleContext);
  const frontEnd = moduleContext.module.exports;

  assert.equal(frontEnd.IMAGE_RATIO_TOLERANCE, DEFAULT_RATIO_TOLERANCE);
  assert.equal(frontEnd.IMAGE_RATIO_TOLERANCE, 0.005);

  const cases = [
    { actual: { width: 512, height: 512 }, original: { width: 512, height: 512 } },
    { actual: { width: 1024, height: 1024 }, original: { width: 512, height: 512 } },
    { actual: { width: 600, height: 512 }, original: { width: 512, height: 512 } },
    { actual: { width: 256, height: 256 }, original: { width: 512, height: 512 } },
    { actual: { width: 512, height: 256 }, original: { width: 512, height: 512 } },
    { actual: { width: 0, height: 0 }, original: { width: 512, height: 512 } },
    { actual: { width: 512, height: 512 }, original: { width: 0, height: 0 } },
    // Any deviation in width is now outside the gate — the 0.5 % band (and the
    // six-times-looser hint before it) both admitted these two.
    { actual: { width: 513, height: 512 }, original: { width: 512, height: 512 } },
    { actual: { width: 517, height: 512 }, original: { width: 512, height: 512 } },
    // Exact equality across a reduction and a non-multiple: both must pass.
    { actual: { width: 2048, height: 1024 }, original: { width: 1024, height: 512 } },
    { actual: { width: 1920, height: 1080 }, original: { width: 1280, height: 720 } },
  ];
  for (const entry of cases) {
    const mine = frontEnd.checkImageRatio(entry.actual, entry.original);
    const worker = checkAspectRatio({ actual: entry.actual, original: entry.original });
    assert.equal(mine.ok, worker.ok, `verdict differs for ${JSON.stringify(entry)}`);
    if (!mine.ok) assert.equal(mine.reason, worker.reason, `reason differs for ${JSON.stringify(entry)}`);
    // The exactness flag agrees too, so a future band cannot be reintroduced in
    // one gate without the other's parity check failing.
    assert.equal(mine.exact, worker.exact, `exactness differs for ${JSON.stringify(entry)}`);
  }
});

// ---------------------------------------------------------------------------
// 2. the binding: nested, complete, target-aware
// ---------------------------------------------------------------------------

await check("the binding is read from resource.github, and a flat row without one is refused", () => {
  const moduleContext = vm.createContext({ module: { exports: {} }, console });
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, "github-contribution.js"), "utf8"), moduleContext);
  const api = moduleContext.module.exports;

  const nested = api.githubBinding(assetsRow());
  assert.equal(nested.ok, true);
  assert.equal(nested.target, "assets");
  assert.equal(nested.path, ASSETS_BINDING.path);
  assert.equal(nested.base_commit, ASSETS_BINDING.base_commit);

  const nestedUnderResource = api.githubBinding({ resource: { github: { ...ASSETS_BINDING } } });
  assert.equal(nestedUnderResource.ok, true, "a binding nested under `resource.github` must be found too");

  // The pre-contract shape: everything at the top level and no `github` object.
  const flat = api.githubBinding({ asset_version: "1077100", bundle: "b", item_key: "k", source: "s" });
  assert.equal(flat.ok, false);
  assert.equal([...flat.missing].join(","), "github,target,path,base_commit");

  const noTarget = api.githubBinding({ github: { path: "locales/a.jsonl", base_commit: "c".repeat(40) } });
  assert.equal(noTarget.ok, false);
  assert.equal([...noTarget.missing].join(","), "target");

  const bogusTarget = api.githubBinding({ github: { ...ASSETS_BINDING, target: "web" } });
  assert.equal(bogusTarget.ok, false);
  assert.equal([...bogusTarget.missing].join(","), "target");
});

// ---------------------------------------------------------------------------
// 3. the text proposal body: fields, axis, CSRF
// ---------------------------------------------------------------------------

await check("an assets row posts the bound line-edit body with CSRF and same-origin credentials", async () => {
  const item = assetsRow();
  const page = await bootWith();
  page.program("/api/contributions/github-pr", () => page.reply({
    pr_number: 12, pr_url: "https://github.com/kohakunamori/MLTDTranslationAssets/pull/12", branch: "portal/text-abcd", state: "open", upstream_direct: false,
  }));
  primeStudio(page, item, "大显身手");

  await page.hooks.submitCurrentTranslation();
  const writes = writeCalls(page);
  assert.equal(writes.length, 1);
  const call = writes[0];
  assert.equal(call.url, "/api/contributions/github-pr");
  assert.equal(call.method, "POST");
  assert.equal(call.credentials, "same-origin", "the Access session cookie must travel with the write");
  assert.equal(call.headers.get("x-csrf-token"), "csrf-abc123");
  assert.equal(call.headers.get("content-type"), "application/json");

  assert.deepEqual(Object.keys(call.json).sort(), [
    "asset_version", "base_commit", "bundle", "item_key", "logical_key", "path", "source_sha256", "target", "translation",
  ].sort());
  assert.equal(call.json.target, "assets");
  assert.equal(call.json.asset_version, "1077100");
  assert.equal(call.json.base_commit, item.github.base_commit);
  assert.equal(call.json.path, item.github.path);
  assert.equal(call.json.logical_key, item.logical_key);
  assert.equal(call.json.source_sha256, item.github.source_sha256);
  assert.equal(call.json.translation, "大显身手");
});

await check("a client row targets the client repository and never carries an asset_version", async () => {
  const page = await bootWith();
  page.program("/api/contributions/github-pr", () => page.reply({ pr_number: 3, pr_url: "https://github.com/kohakunamori/MLTDTranslationClient/pull/3", state: "open" }));
  const item = clientRow();
  primeStudio(page, item, "商店");

  await page.hooks.submitCurrentTranslation();
  const writes = writeCalls(page);
  assert.equal(writes.length, 1);
  const body = writes[0].json;
  assert.equal(body.target, "client", "the target must come from the binding, not from the item's channel guesswork");
  assert.equal(body.client_version, "9.0.200");
  assert.equal(body.path, item.github.path);
  assert.equal(Object.prototype.hasOwnProperty.call(body, "asset_version"), false, "a client proposal must not carry an asset axis");

  // And the reverse: an assets row in the same page never carries a client axis.
  primeStudio(page, assetsRow(), "大显身手");
  await page.hooks.submitCurrentTranslation();
  const assetsBody = writeCalls(page)[1].json;
  assert.equal(assetsBody.target, "assets");
  assert.equal(assetsBody.asset_version, "1077100");
  assert.equal(Object.prototype.hasOwnProperty.call(assetsBody, "client_version"), false, "an assets proposal must not carry a client axis");
});

// ---------------------------------------------------------------------------
// 4. a line edit is not a file rewrite
// ---------------------------------------------------------------------------

await check("the proposal body is a single-line edit: no file content, no whole-file overwrite", async () => {
  const page = await bootWith();
  page.program("/api/contributions/github-pr", () => page.reply({ pr_number: 13, pr_url: "https://example.test/pull/13", state: "open" }));
  primeStudio(page, assetsRow(), "大显身手");

  await page.hooks.submitCurrentTranslation();
  const body = writeCalls(page)[0].json;

  assert.equal(Object.prototype.hasOwnProperty.call(body, "content"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(body, "file"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(body, "lines"), false);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.split("大显身手").length - 1, 1);
  assert.ok(body.logical_key && body.path && body.base_commit && body.source_sha256, "a line edit is meaningless without its binding");
  assert.ok(!serialized.includes("本領発揮\n"), "the payload must not carry the file's other rows");
});

await check("a row with no binding is refused, not guessed", async () => {
  const page = await bootWith();
  primeStudio(page, { ...assetsRow(), github: undefined }, "大显身手");

  await page.hooks.submitCurrentTranslation();
  assert.equal(writeCalls(page).length, 0, "nothing may be sent without a binding");
  const toast = page.toast.text;
  assert.ok(/github/.test(toast) && /path/.test(toast) && /base_commit/.test(toast), `toast must name the missing binding, got: ${toast}`);
});

await check("a binding without a repository is refused rather than sent to assets by default", async () => {
  const page = await bootWith();
  primeStudio(page, assetsRow({ github: { path: "locales/a.jsonl", base_commit: "c".repeat(40) } }), "大显身手");
  await page.hooks.submitCurrentTranslation();
  assert.equal(writeCalls(page).length, 0);
  assert.ok(/target/.test(page.toast.text), page.toast.text);
});

await check("a composite version is refused before it can be sent", async () => {
  const page = await bootWith();
  primeStudio(page, assetsRow({ asset_version: "9.0.200+1077100" }), "大显身手");
  await page.hooks.submitCurrentTranslation();
  assert.equal(writeCalls(page).length, 0);
  assert.ok(/组合版本/.test(page.toast.text), page.toast.text);
});

// ---------------------------------------------------------------------------
// 5. anonymous: 401, then the login flow
// ---------------------------------------------------------------------------

await check("an anonymous visitor cannot submit, and the link button starts the OAuth flow", async () => {
  const page = await bootWith({ identityStatus: 401 });
  primeStudio(page, assetsRow(), "大显身手");

  const userInfo = page.dom.get("user-info");
  assert.ok(userInfo.innerHTML.includes("关联 GitHub 账号"), userInfo.innerHTML);

  await page.hooks.submitCurrentTranslation();
  assert.equal(writeCalls(page).length, 0, "a proposal may not be sent without a linked account");

  const linkButton = page.dom.get("btn-github-login");
  assert.ok(linkButton, "the link button must be rendered for an anonymous session");
  linkButton.click();
  assert.equal(page.navigations[page.navigations.length - 1], "/api/auth/github/login");
});

await check("没有公开邮箱的 GitHub 会话仍显示正确身份和管理员入口", async () => {
  const page = await bootWith({ me: { ...githubMe({ login: "maintainer" }), email: null, role: "admin" } });
  assert.equal(page.hooks.state.user.login, "maintainer");
  assert.equal(page.hooks.state.user.role, "admin");
  assert.ok(page.dom.get("user-info").innerHTML.includes("GitHub: maintainer"));
  assert.equal(page.dom.get("nav-reviewer").style.display, "inline-flex");
  await page.hooks.checkUser();
  assert.equal(page.calls.filter((call) => call.url === "/api/me").length, 0);
});

await check("登出调用 Portal POST 并携带 CSRF，不跳转旧 Access 登出页", async () => {
  const page = await bootWith();
  page.program("/api/auth/github/logout", () => page.reply({ ok: true, revoked: true }));
  const handler = page.dom.get("btn-logout").listeners.click?.[0];
  assert.equal(typeof handler, "function");
  await handler({ stopPropagation() {} });
  const writes = writeCalls(page);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].url, "/api/auth/github/logout");
  assert.equal(writes[0].credentials, "same-origin");
  assert.equal(writes[0].headers.get("x-csrf-token"), "csrf-abc123");
  assert.equal(page.hooks.state.githubIdentity, null);
  assert.equal(page.navigations.at(-1), "reload");
  assert.ok(!page.navigations.includes("/cdn-cgi/access/logout"));
});

await check("服务端登出失败时不伪装成功或清空已登录界面", async () => {
  const page = await bootWith();
  page.program("/api/auth/github/logout", () => page.reply({ ok: false, error: "logout_revoke_failed" }, 503));
  await page.dom.get("btn-logout").listeners.click[0]({ stopPropagation() {} });
  assert.ok(page.hooks.state.githubIdentity);
  assert.equal(page.navigations.length, 0);
  assert.ok(page.toast.text.includes("退出登录失败"));
});

await check("资源选择导航按钮确实打开选择器，而非仅暴露测试 hook", async () => {
  const page = await bootWith();
  page.dom.get("nav-selector").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.hooks.state.currentView, "selector");
  assert.equal(page.dom.get("view-selector").style.display, "block");
  assert.ok(page.calls.some((call) => call.url.startsWith("/api/assets/releases")));
});

await check("后台缺预览的文字 PR 不得被误标为图片，并显示实际仓库", async () => {
  const page = await bootWith();
  page.program("/api/admin/contributions", () => page.reply({ rows: [{
    id: "mock-text-pr", ja: null, zh: null, contributor_email: "github:42",
    github: { target_repo: "kohakunamori/MLTDTranslationClient", head_branch: "portal/text/fixture",
      pr_number: 31, pr_url: "https://example.test/pr/31", state: "open" },
  }] }));
  await page.hooks.loadAdminProposals();
  const html = page.dom.get("admin-proposal-list").children.map((x) => x.innerHTML).join(" ");
  assert.ok(html.includes("MLTDTranslationClient"), html);
  assert.ok(html.includes("文字预览未镜像"), html);
  assert.ok(!html.includes("图片提案"), html);
});

await check("a missing CSRF token blocks the write even with a linked account", async () => {
  const page = await bootWith({ me: githubMe({ csrfToken: "" }) });
  primeStudio(page, assetsRow(), "大显身手");
  await page.hooks.submitCurrentTranslation();
  assert.equal(writeCalls(page).length, 0);
  assert.ok(/令牌|CSRF/.test(page.toast.text), page.toast.text);
});

// ---------------------------------------------------------------------------
// 6. the PR link and honest failure reporting
// ---------------------------------------------------------------------------

await check("a successful proposal shows the PR link and says the portal only mirrors CI", async () => {
  const page = await bootWith();
  page.program("/api/contributions/github-pr", () => page.reply({
    pr_number: 21, pr_url: "https://github.com/kohakunamori/MLTDTranslationAssets/pull/21", branch: "portal/text-1", state: "open", upstream_direct: false,
  }));
  primeStudio(page, assetsRow(), "大显身手");
  await page.hooks.submitCurrentTranslation();

  const link = page.dom.get("studio-pr-link");
  assert.ok(link.innerHTML.includes("https://github.com/kohakunamori/MLTDTranslationAssets/pull/21"), link.innerHTML);
  assert.ok(link.innerHTML.includes("#21"), link.innerHTML);
  assert.ok(/GitHub 为准/.test(link.innerHTML), link.innerHTML);
  assert.ok(!link.classList.contains("is-warning"));
});

await check("an upstream-direct proposal is visibly flagged", async () => {
  const page = await bootWith();
  page.program("/api/contributions/github-pr", () => page.reply({
    pr_number: 22, pr_url: "https://example.test/pull/22", state: "open", upstream_direct: true,
  }));
  primeStudio(page, assetsRow(), "大显身手");
  await page.hooks.submitCurrentTranslation();
  const link = page.dom.get("studio-pr-link");
  assert.ok(link.classList.contains("is-warning"));
  assert.ok(/未经 fork/.test(link.innerHTML), link.innerHTML);
});

await check("an API error is never rendered as success", async () => {
  const page = await bootWith();
  page.program("/api/contributions/github-pr", () => page.reply({ error: "source_hash_mismatch" }, 400));
  primeStudio(page, assetsRow(), "大显身手");
  await page.hooks.submitCurrentTranslation();

  const link = page.dom.get("studio-pr-link");
  assert.ok(!/github\.com/.test(link.innerHTML), "no PR link may be shown for a failed submission");
  assert.ok(/校验失败|失败/.test(page.toast.text), page.toast.text);
  const button = page.dom.get("btn-studio-submit");
  assert.equal(button.disabled, false, "a failed submit must leave the button usable");
  assert.ok(!/已提交 PR/.test(button.textContent), button.textContent);
});

// ---------------------------------------------------------------------------
// 7. lyrics: the same bound line edit
// ---------------------------------------------------------------------------

await check("a lyric slot submits a bound single-line edit on the assets axis", async () => {
  const page = await bootWith();
  page.program("/api/contributions/github-pr", () => page.reply({ pr_number: 31, pr_url: "https://example.test/pull/31", state: "open" }));
  const line = {
    asset_version: "1077100",
    bundle: "scrobj_song_0001",
    item_key: "0",
    logical_key: "lyrics/scrobj_song_0001/0",
    source: "キラメキラリ",
    source_sha256: "d".repeat(64),
    slot_index: 1,
    github: { target: "assets", path: "lyrics/scrobj_song_0001.jsonl", base_commit: "a".repeat(40), source_sha256: "d".repeat(64) },
  };

  page.hooks.state.studioQueue = [line];
  page.dom.get("lyric-input-0").value = "闪闪发光";
  await page.hooks.saveSingleLyricLine(0);

  const writes = writeCalls(page);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].url, "/api/contributions/github-pr");
  assert.equal(writes[0].json.target, "assets");
  assert.equal(writes[0].json.logical_key, "lyrics/scrobj_song_0001/0");
  assert.equal(writes[0].json.path, "lyrics/scrobj_song_0001.jsonl");
  assert.equal(writes[0].json.base_commit, "a".repeat(40));
  assert.equal(writes[0].json.translation, "闪闪发光");
  assert.equal(writes[0].headers.get("x-csrf-token"), "csrf-abc123");
  assert.equal(page.dom.get("lyric-st-badge-0").textContent, "已提 PR");
});

// ---------------------------------------------------------------------------
// 8. images: both repositories, high resolution accepted, stretch refused
// ---------------------------------------------------------------------------

await check("a 2x high-resolution upload at the same ratio is accepted and sent byte-for-byte", async () => {
  const page = await bootWith();
  page.program("/api/images/submit", () => page.reply({ task_id: "t1", pr_number: 41, pr_url: "https://example.test/pull/41", scaling: "ci" }));

  const task = imageTask();
  const png = makePng(1024, 1024);
  page.hooks.state.images.currentTask = task;

  page.hooks.handleStudioImageFile({ type: "image/png", name: "cn.png", base64: Buffer.from(png).toString("base64") });
  await new Promise((resolve) => setImmediate(resolve));

  const status = page.dom.get("studio-aspect-ratio-status");
  assert.ok(status.classList.contains("match"), `${status.className}: ${status.innerHTML}`);
  assert.ok(/CI 等比缩放/.test(status.innerHTML), status.innerHTML);
  assert.equal(page.dom.get("btn-studio-submit-restore").disabled, false);

  page.hooks.state.images.uploadedImageBase64 = dataUrlFor(png);
  page.hooks.state.images.uploadedImageObj = { width: 1024, height: 1024 };
  await page.hooks.submitStudioRestore();

  const writes = writeCalls(page);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].url, "/api/images/submit");
  assert.equal(writes[0].credentials, "same-origin");
  assert.equal(writes[0].headers.get("x-csrf-token"), "csrf-abc123");
  assert.equal(writes[0].json.task_id, "t1");
  assert.equal(writes[0].json.target, "assets", "the image proposal carries the binding's target too");
  assert.equal(writes[0].json.path, task.github.path);
  assert.equal(writes[0].json.base_commit, task.github.base_commit);
  assert.equal(writes[0].json.asset_version, "1077100");
  assert.equal(Object.prototype.hasOwnProperty.call(writes[0].json, "client_version"), false);
  assert.ok(!String(writes[0].json.image_base64).startsWith("data:"), "the committed blob must be the image's own bytes");
  assert.equal(writes[0].json.image_base64, Buffer.from(png).toString("base64"));
  assert.equal(writes[0].json.width, undefined, "the client's claimed size is not part of the proposal shape");
});

await check("a client-channel image is refused before sending: there is no trusted client image source", async () => {
  const page = await bootWith();
  page.program("/api/images/submit", () => page.reply({ task_id: "t9", pr_number: 49, pr_url: "https://example.test/pull/49", scaling: "ci" }));

  const task = imageTask({
    task_id: "t9",
    client_version: "9.0.200",
    asset_version: undefined,
    github: { target: "client", path: "images/bottom-bar/shop.png", base_commit: "1".repeat(40), source_sha256: "2".repeat(64) },
  });
  const png = makePng(1024, 1024);
  page.hooks.state.images.currentTask = task;
  page.hooks.state.images.uploadedImageBase64 = dataUrlFor(png);
  page.hooks.state.images.uploadedImageObj = { width: 1024, height: 1024 };

  await page.hooks.submitStudioRestore();
  assert.equal(writeCalls(page).length, 0, "the service has no verified client image source; the form must not ask");
  assert.ok(/Client 通道/.test(page.toast.text), page.toast.text);

  // And the module itself refuses the same shape, so the rule has one home.
  const moduleContext = vm.createContext({ module: { exports: {} }, console });
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, "github-contribution.js"), "utf8"), moduleContext);
  const refused = moduleContext.module.exports.buildImageProposal(task, Buffer.from(png).toString("base64"));
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "client_image_unsupported");
});

await check("the image proposal carries the assets binding and the task's own source hash, never the upload's", async () => {
  const page = await bootWith();
  page.program("/api/images/submit", () => page.reply({ task_id: "t8", pr_number: 48, pr_url: "https://example.test/pull/48", scaling: "ci" }));

  const TASK_SOURCE_SHA = "9".repeat(64);
  const task = imageTask({ task_id: "t8", source_sha256: TASK_SOURCE_SHA });
  const png = makePng(1024, 1024);
  page.hooks.state.images.currentTask = task;
  page.hooks.state.images.uploadedImageBase64 = dataUrlFor(png);
  page.hooks.state.images.uploadedImageObj = { width: 1024, height: 1024 };
  await page.hooks.submitStudioRestore();

  const writes = writeCalls(page);
  assert.equal(writes.length, 1);
  const body = writes[0].json;
  assert.equal(body.target, "assets");
  assert.equal(body.path, task.github.path, "the path is the binding's, which the service checks against the task's own layout");
  assert.equal(body.base_commit, task.github.base_commit);
  assert.equal(body.asset_version, "1077100");
  assert.equal(body.source_sha256, TASK_SOURCE_SHA, "the source hash is the task's original, not the upload's bytes");
  const uploadSha = await crypto.subtle.digest("SHA-256", png);
  const uploadHex = [...new Uint8Array(uploadSha)].map((b) => b.toString(16).padStart(2, "0")).join("");
  assert.notEqual(body.source_sha256, uploadHex, "recording the upload as its own source is the bug this guards");

  // A task with no recorded hash is refused with the service's own code, before
  // anything is sent — the page will not stand an upload in for a source.
  primeStudio(page, assetsRow(), "x");
  resetCalls(page);
  const bare = imageTask({ task_id: "t7", source_sha256: undefined, github: { target: "assets", path: "images/restored/t7/restored-texture.png", base_commit: "e".repeat(40), source_sha256: "" } });
  page.hooks.state.images.currentTask = bare;
  page.hooks.state.images.uploadedImageBase64 = dataUrlFor(png);
  page.hooks.state.images.uploadedImageObj = { width: 1024, height: 1024 };
  await page.hooks.submitStudioRestore();
  assert.equal(writeCalls(page).length, 0);
  assert.ok(/原始 hash|image_source_sha256_missing|冒充/.test(page.toast.text), page.toast.text);
});

await check("a stretched upload is refused before any request is made", async () => {
  const page = await bootWith();
  const task = imageTask({ task_id: "t2" });
  const png = makePng(600, 512);
  page.hooks.state.images.currentTask = task;

  page.hooks.handleStudioImageFile({ type: "image/png", name: "stretch.png", base64: Buffer.from(png).toString("base64") });
  await new Promise((resolve) => setImmediate(resolve));

  const status = page.dom.get("studio-aspect-ratio-status");
  assert.ok(status.classList.contains("mismatch"), status.className);
  assert.ok(/拉伸|比例不符/.test(status.innerHTML), status.innerHTML);
  assert.equal(page.dom.get("btn-studio-submit-restore").disabled, true);

  page.hooks.state.images.uploadedImageBase64 = dataUrlFor(png);
  page.hooks.state.images.uploadedImageObj = { width: 600, height: 512 };
  await page.hooks.submitStudioRestore();
  assert.equal(writeCalls(page).length, 0);
});

await check("a downsample and an unknown original size are both refused", async () => {
  const page = await bootWith();
  const cases = [
    { task: imageTask({ task_id: "t3" }), png: makePng(256, 256), pattern: /降采样|分辨率/ },
    { task: imageTask({ task_id: "t4", width: 0, height: 0 }), png: makePng(512, 512), pattern: /原始尺寸|比例/ },
  ];
  for (const entry of cases) {
    page.hooks.state.images.currentTask = entry.task;
    page.hooks.handleStudioImageFile({ type: "image/png", name: "x.png", base64: Buffer.from(entry.png).toString("base64") });
    await new Promise((resolve) => setImmediate(resolve));
    const status = page.dom.get("studio-aspect-ratio-status");
    assert.equal(page.dom.get("btn-studio-submit-restore").disabled, true, `expected refusal for ${entry.task.task_id}`);
    assert.ok(entry.pattern.test(status.innerHTML), `${entry.task.task_id}: ${status.innerHTML}`);
  }
});

// ---------------------------------------------------------------------------
// 9. the retired write paths, including the image status toggle
// ---------------------------------------------------------------------------

await check("the image status toggle is display-only: clicking it sends nothing", async () => {
  const page = await bootWith();
  page.program(/^\/api\/images\/tasks/, () => page.reply({
    tasks: [{ task_id: "t1", bundle: "event_0015_info", category: "event", width: 512, height: 512, image_format: "png", has_alpha: true, source_sha256: "f".repeat(64), status: "untranslated", category_name: "活动", description: "banner" }],
    total: 1, categories: { all: 1, event: 1, costume: 0, tutorial: 0 }, has_more: false, next_cursor: null,
  }));
  page.program("/api/images/status", () => page.reply({ error: "images_status_retired" }, 410));

  await page.hooks.loadImagesView();
  await new Promise((resolve) => setImmediate(resolve));
  resetCalls(page);

  // The studio's button: present in the page, clickable, and inert.
  const studioButton = page.dom.get("btn-studio-img-toggle-status");
  page.hooks.state.images.currentTask = { task_id: "t1", width: 512, height: 512, asset_version: "1077100", status: "untranslated" };
  studioButton.click();
  assert.equal(writeCalls(page).length, 0, "the status button must not write anything");
  assert.ok(/维护者|只读/.test(page.toast.text), `the click must explain the decision moved, got: ${page.toast.text}`);

  // And opening the images view must not probe the retired overlay endpoint —
  // a request that can only answer 410 is a request that should not be made.
  await page.hooks.loadImagesView();
  await new Promise((resolve) => setImmediate(resolve));
  const endpoints = page.calls.map((call) => `${call.method} ${call.url.split("?")[0]}`);
  assert.ok(!endpoints.includes("GET /api/images/status"), endpoints.join(", "));
  assert.ok(!endpoints.includes("POST /api/images/status"), endpoints.join(", "));
});

await check("the retired write paths are never called by any flow", async () => {
  const page = await bootWith();
  page.program("/api/contributions/github-pr", () => page.reply({ pr_number: 51, pr_url: "https://example.test/pull/51", state: "open" }));
  page.program("/api/admin/contributions", () => page.reply({
    rows: [{
      id: "c1", status: "pending", bundle: "event_0448_story_06", item_key: "title", ja: "本領発揮", zh: "大显身手",
      contributor_email: "a@b.c", created_at: "2026-09-30T00:00:00Z", updated_at: "2026-09-30T00:00:00Z",
      github: { target_repo: "kohakunamori/MLTDTranslationAssets", base_branch: "main", head_branch: "portal/text-1", fork: "contributor/MLTDTranslationAssets", pr_number: 51, pr_url: "https://example.test/pull/51", state: "open", merged: false, mergeable_state: "clean", head_sha: "f".repeat(40), ci_status: "success" },
    }],
  }));

  primeStudio(page, assetsRow(), "大显身手");
  await page.hooks.submitCurrentTranslation();

  page.hooks.state.studioQueue = [{
    asset_version: "1077100", bundle: "scrobj_song_0001", item_key: "0", logical_key: "lyrics/x/0", source: "キラ", source_sha256: "d".repeat(64), slot_index: 1,
    github: { target: "assets", path: "lyrics/scrobj_song_0001.jsonl", base_commit: "a".repeat(40), source_sha256: "d".repeat(64) },
  }];
  page.dom.get("lyric-input-0").value = "闪闪";
  await page.hooks.saveSingleLyricLine(0);

  await page.hooks.loadAdminProposals();

  // Exact endpoints, not substrings: `/api/contributions/github-pr` is the new
  // route and `/api/admin/contributions` is a different view, while
  // `POST /api/contributions` is the retired one.
  const endpoints = page.calls.map((call) => `${call.method} ${call.url.split("?")[0]}`);
  const retired = [
    "POST /api/contributions",
    "POST /api/images/restore",
    "POST /api/images/status",
    "GET /api/queue",
    "POST /api/publish",
  ];
  for (const endpoint of retired) {
    assert.ok(!endpoints.includes(endpoint), `retired endpoint called: ${endpoint} (${endpoints.join(", ")})`);
  }
  assert.ok(endpoints.every((entry) => !entry.startsWith("POST /api/reviews/")), endpoints.join(", "));
  assert.ok(endpoints.includes("POST /api/contributions/github-pr"), endpoints.join(", "));
  assert.ok(endpoints.includes("GET /api/admin/contributions"), endpoints.join(", "));
});

// ---------------------------------------------------------------------------
// 10. the admin view mirrors GitHub and decides nothing
// ---------------------------------------------------------------------------

await check("the proposal list shows the PR link, state and CI, and offers no verdict", async () => {
  const page = await bootWith();
  page.program("/api/admin/contributions", () => page.reply({
    review_authority: "github_pull_request",
    rows: [
      {
        id: "c1", status: "pending", bundle: "event_0448_story_06", item_key: "title", ja: "本領発揮", zh: "大显身手",
        contributor_email: "a@b.c", created_at: "2026-09-30T00:00:00Z", updated_at: "2026-09-30T00:00:00Z",
        github: { target_repo: "kohakunamori/MLTDTranslationAssets", base_branch: "main", head_branch: "portal/text-1", pr_number: 61, pr_url: "https://example.test/pull/61", state: "open", merged: false, mergeable_state: "clean", head_sha: "a".repeat(40), ci_status: "success" },
      },
      {
        id: null, status: "proposed", bundle: null, item_key: null, ja: null, zh: null,
        contributor_email: "b@c.d", created_at: "2026-09-30T00:00:00Z", updated_at: "2026-09-30T00:00:00Z",
        github: { target_repo: "kohakunamori/MLTDTranslationClient", base_branch: "main", head_branch: "portal/image-2", pr_number: 62, pr_url: "https://example.test/pull/62", state: "closed", merged: true, mergeable_state: "unknown", head_sha: "b".repeat(40), ci_status: "failure" },
      },
      {
        id: "c3", status: "pending", bundle: "b", item_key: "k", ja: "ja", zh: "zh",
        contributor_email: "c@d.e", created_at: "2026-09-30T00:00:00Z", updated_at: "2026-09-30T00:00:00Z",
        github: null,
      },
    ],
  }));

  await page.hooks.loadAdminProposals();
  const list = page.dom.get("admin-proposal-list");
  const html = list.children.map((child) => child.innerHTML).join("\n");

  assert.ok(html.includes("https://example.test/pull/61"), html);
  assert.ok(html.includes("#61"), html);
  assert.ok(/CI 通过/.test(html), html);
  assert.ok(/CI 失败/.test(html), html);
  assert.ok(/已合并/.test(html), html);
  assert.ok(/尚未提交 PR/.test(html), "a contribution with no PR must say so");
  assert.ok(!/btn-accept|btn-reject|btn-needs-review|采纳|驳回/.test(html), "the portal must not offer a second verdict");
  assert.equal(writeCalls(page).length, 0, "the dashboard is read-only");
});

// ---------------------------------------------------------------------------
// 11. the selector: both channels, isolated versions, slot 0
// ---------------------------------------------------------------------------

const ASSETS_COMMIT = "a".repeat(40);
const CLIENT_COMMIT = "d".repeat(40);
const SLOT0_SOURCE = "ホーム";
/// The client manifest's first slot. `index: 0` is the point: every selector
/// key is read with an explicit null check, so a falsy index survives as "0".
const CLIENT_SLOT0 = {
  index: 0,
  ja: SLOT0_SOURCE,
  zh: "首页",
  provenance: "client_builtin",
};
const CLIENT_PATH = "manifests/bottom-bar.manifest.json";

/// The two channels as the service lists them: each carries *its own* pin, and
/// the client list has no `asset_version` at all.
function selectorRoutes(page) {
  page.program("/api/assets/releases", () => page.reply({
    releases: [
      { release_id: "assets-1077100", asset_version: "1077100", assets_commit: ASSETS_COMMIT, status: "canonical" },
      { release_id: "assets-1077500", asset_version: "1077500", assets_commit: null, status: "candidate" },
    ],
  }));
  page.program("/api/client/releases", () => page.reply({
    releases: [
      { release_id: "client-9.0.200", client_version: "9.0.200", client_resources_commit: CLIENT_COMMIT, status: "candidate" },
    ],
  }));
  page.program(/^\/api\/assets\/releases\/[^/]+\/items/, () => page.reply({
    release_id: "assets-1077100",
    items: [{ bundle: "event_0448_story_06", item_key: "event_0448_story_06_title", source_sha256: ASSETS_BINDING.source_sha256, status: "untranslated", translation: null }],
  }));
  page.program(/^\/api\/client\/releases\/[^/]+\/items/, () => page.reply({
    release_id: "client-9.0.200",
    items: [{ bundle: "bottom-bar", item_key: "0", source_sha256: "e".repeat(64), status: "untranslated", translation: null }],
  }));
  page.program(/^\/api\/assets\/releases\/[^/]+\/item\?/, () => page.reply({
    item: {
      bundle: "event_0448_story_06", item_key: "event_0448_story_06_title", logical_key: "event_0448_story_06:event_0448_story_06_title",
      source_sha256: ASSETS_BINDING.source_sha256, resource_id: "res_assets_row",
      github: { target: "assets", path: ASSETS_BINDING.path, base_commit: ASSETS_COMMIT, source_sha256: ASSETS_BINDING.source_sha256 },
      edit_endpoint: "/api/resources/res_assets_row/edit-context",
    },
  }));
  page.program(/^\/api\/client\/releases\/[^/]+\/item\?/, () => page.reply({
    item: {
      bundle: "bottom-bar", item_key: "0", logical_key: "text/client_ui/bottom-bar",
      source_sha256: "e".repeat(64), resource_id: "res_client_labels",
      github: { target: "client", path: CLIENT_PATH, base_commit: CLIENT_COMMIT, source_sha256: "e".repeat(64) },
      edit_endpoint: "/api/resources/res_client_labels/edit-context",
    },
  }));
  page.program("/api/resources/res_assets_row/edit-context", () => page.reply({
    editable: true,
    row_kind: "jsonl_row",
    github: { target: "assets", path: ASSETS_BINDING.path, base_commit: ASSETS_COMMIT, source_sha256: ASSETS_BINDING.source_sha256 },
    logical_key: "event_0448_story_06:event_0448_story_06_title",
    bundle: "event_0448_story_06",
    item_key: "event_0448_story_06_title",
    source: "本領発揮",
    translation: null,
    asset_version: "1077100",
    client_version: null,
  }));
  page.program("/api/resources/res_client_labels/edit-context", () => page.reply({
    editable: true,
    row_kind: "manifest_slot",
    github: { target: "client", path: CLIENT_PATH, base_commit: CLIENT_COMMIT, source_sha256: "e".repeat(64) },
    logical_key: "text/client_ui/bottom-bar",
    bundle: "bottom-bar",
    item_key: "0",
    source: SLOT0_SOURCE,
    translation: CLIENT_SLOT0.zh,
    asset_version: null,
    client_version: "9.0.200",
  }));
}

await check("the selector lists both channels, each with its own pin and axis", async () => {
  const page = await bootWith();
  selectorRoutes(page);

  await page.hooks.loadSelector("assets");
  assert.equal(page.hooks.state.selector.channel, "assets");
  const assetsRequest = page.calls.map((call) => call.url).filter((url) => url.startsWith("/api/assets/releases"));
  assert.ok(assetsRequest.includes("/api/assets/releases"), assetsRequest.join(", "));
  const assetsOptions = page.dom.get("selector-release").innerHTML;
  assert.ok(assetsOptions.includes("1077100"), assetsOptions);
  assert.ok(assetsOptions.includes("1077500"), assetsOptions);
  assert.ok(assetsOptions.includes(ASSETS_COMMIT.slice(0, 7)), "the selector shows the release's own pin");
  assert.equal(page.dom.get("selector-release").disabled, true, "the portal locks the selector to the latest usable release");
  assert.equal(page.hooks.state.selector.ref, "assets-1077100");

  resetCalls(page);
  await page.hooks.loadSelector("client");
  assert.equal(page.hooks.state.selector.channel, "client");
  const clientOptions = page.dom.get("selector-release").innerHTML;
  assert.ok(clientOptions.includes("9.0.200"), clientOptions);
  assert.ok(clientOptions.includes(CLIENT_COMMIT.slice(0, 7)), "the client list carries *its* pin, not the assets one");
  // The client channel is addressed by its own routes only.
  const urls = page.calls.map((call) => `${call.method} ${call.url.split("?")[0]}`);
  assert.ok(urls.some((entry) => entry === "GET /api/client/releases"), urls.join(", "));
  assert.ok(!urls.some((entry) => entry.startsWith("GET /api/assets/releases")), urls.join(", "));
});

await check("switching the release clears the previous channel's rows before listing the new ones", async () => {
  const page = await bootWith();
  selectorRoutes(page);

  // List the assets release's rows and select one, so the studio holds a binding.
  await page.hooks.loadSelector("assets");
  await page.hooks.loadSelectorItems();
  const assetsItems = page.dom.get("selector-items").children;
  assert.equal(assetsItems.length, 1, `the assets release's row is listed; calls=${page.calls.map((c) => c.url).join(" | ")} ref=${page.hooks.state.selector.ref} html=${page.dom.get("selector-items").innerHTML}`);
  await page.hooks.selectSelectorItem(page.hooks.state.selector.items[0], assetsItems[0]);
  assert.equal(page.hooks.state.selector.selected.github.target, "assets");
  assert.equal(page.hooks.state.currentItem, null, "selecting alone does not enter the studio");
  assert.equal(page.hooks.state.currentView, "lobby", "the view only changes when the user opens the row");

  // Switch the channel: the old rows and the old context must be gone, or a
  // stale row could be submitted under the new release's selector.
  await page.hooks.loadSelector("client");
  assert.equal(page.hooks.state.selector.selected, null, "the previous context is dropped");
  assert.equal(page.hooks.state.selector.next_cursor, null, "the previous release's cursor is dropped");
  assert.equal(page.hooks.state.selector.release_id, "client-9.0.200");

  const clientItems = page.dom.get("selector-items").children;
  assert.equal(clientItems.length, 1);
  assert.ok(clientItems[0].innerHTML.includes("bottom-bar"), clientItems[0].innerHTML);
  const listed = page.hooks.state.selector.items.map((item) => item.bundle);
  assert.deepEqual(listed, ["bottom-bar"], `no asset row survives the channel switch: ${listed.join(", ")}`);
  const selectionPanel = page.dom.get("selector-selection").innerHTML;
  assert.ok(/选择左侧条目/.test(selectionPanel), "the detail panel no longer shows the assets binding");
});

await check("slot 0 of the client manifest survives selection and becomes a flat client PR body", async () => {
  const page = await bootWith();
  selectorRoutes(page);
  page.program("/api/contributions/github-pr", () => page.reply({
    pr_number: 811,
    pr_url: "https://github.com/kohakunamori/MLTDTranslationClient/pull/811",
    state: "open",
    single_line_edit: true,
    target_repo: "kohakunamori/MLTDTranslationClient",
  }));

  await page.hooks.loadSelector("client");
  assert.equal(page.hooks.state.selector.release_id, "client-9.0.200");

  // The row's key is the string "0" — not "", and not undefined. This is the
  // index-0 case the selector has to get right.
  const item = page.hooks.state.selector.items[0];
  assert.equal(page.hooks.selectorItemKey(item), "0");

  await page.hooks.selectSelectorItem(item, page.dom.get("selector-items").children[0]);
  const selected = page.hooks.state.selector.selected;
  assert.ok(selected, "the context must resolve");
  assert.equal(selected.row_kind, "manifest_slot");
  assert.equal(selected.github.target, "client");
  assert.equal(selected.github.path, CLIENT_PATH, "the path is the service's; the selector never builds one");
  assert.equal(selected.github.base_commit, CLIENT_COMMIT);
  assert.equal(selected.item_key, "0");

  // The detail read and the context read must both name the slot as "0".
  const itemCall = page.calls.map((call) => call.url).find((url) => url.includes("/item?"));
  assert.ok(itemCall.includes("item_key=0"), itemCall);
  assert.ok(!itemCall.includes("item_key=&"), `an empty key would be the index-0 bug: ${itemCall}`);

  // Opening it hands the trusted context to the existing studio editor.
  await page.hooks.openSelectorContextInStudio(selected);
  assert.equal(page.hooks.state.currentItem.github.target, "client");
  assert.equal(page.hooks.state.currentItem.github.base_commit, CLIENT_COMMIT);
  assert.equal(page.hooks.state.currentItem.item_key, "0");

  // And submitting builds the flat, source-bound body from that context alone.
  resetCalls(page);
  page.dom.get("translation-input").value = "主页";
  await page.hooks.submitCurrentTranslation();
  const writes = writeCalls(page);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].url, "/api/contributions/github-pr");
  const body = writes[0].json;
  assert.equal(body.target, "client");
  assert.equal(body.path, CLIENT_PATH);
  assert.equal(body.base_commit, CLIENT_COMMIT);
  assert.equal(body.source_sha256, "e".repeat(64));
  assert.equal(body.bundle, "bottom-bar");
  assert.equal(body.item_key, "0", "slot 0 is sent as \"0\", never as an empty string");
  assert.equal(body.logical_key, "text/client_ui/bottom-bar");
  assert.equal(body.translation, "主页");
  assert.equal(body.client_version, "9.0.200");
  assert.equal(Object.prototype.hasOwnProperty.call(body, "asset_version"), false, "a client row never carries an asset axis");
  assert.equal(Object.prototype.hasOwnProperty.call(body, "content"), false, "a slot edit is still a single-row edit");
  assert.equal(body.row_kind, undefined, "row_kind is the server's answer, not a field to post back");
});

await check("the items list follows the service's cursor page by page, and never walks the catalogue", async () => {
  const page = await bootWith();
  selectorRoutes(page);
  page.program(/^\/api\/client\/releases\/[^/]+\/items/, (call) => {
    const url = new URL(call.url, "http://localhost");
    if (!url.searchParams.get("cursor")) {
      return page.reply({
        release_id: "client-9.0.200",
        limit: Number(url.searchParams.get("limit")),
        next_cursor: "cursor-page-2",
        has_more: true,
        items: [{ bundle: "bottom-bar", item_key: "0", status: "untranslated", translation: null }],
      });
    }
    return page.reply({
      release_id: "client-9.0.200",
      limit: 100,
      next_cursor: null,
      has_more: false,
      items: [{ bundle: "bottom-bar", item_key: "1", status: "untranslated", translation: null }],
    });
  });

  await page.hooks.loadSelector("client");
  // One page was fetched, at the size the service actually serves — not 200.
  const first = page.calls.map((call) => call.url).filter((url) => url.includes("/items"));
  assert.equal(first.length, 1, first.join(", "));
  assert.ok(first[0].includes("limit=100"), `the page size must be the service's maximum: ${first[0]}`);
  assert.ok(!first[0].includes("cursor="), `the first page carries no cursor: ${first[0]}`);
  assert.equal(page.hooks.state.selector.items.length, 1);
  assert.equal(page.hooks.state.selector.has_more, true);
  assert.equal(page.dom.get("selector-more").disabled, false, "more pages are offered, not assumed");

  await page.hooks.loadMoreSelectorItems();
  const second = page.calls.map((call) => call.url).filter((url) => url.includes("/items"));
  assert.equal(second.length, 2, second.join(", "));
  assert.ok(second[1].includes("cursor=cursor-page-2"), `the cursor is echoed back verbatim: ${second[1]}`);
  assert.equal(page.hooks.state.selector.items.length, 2, "the second page is appended, not substituted");
  assert.equal(page.dom.get("selector-more").disabled, true, "the end of the list is reported");
  assert.ok(/已到底部/.test(page.dom.get("selector-more").textContent), page.dom.get("selector-more").textContent);

  // The list never fetched the whole catalogue: exactly two requests for two pages.
  const itemCalls = page.calls.filter((call) => call.url.includes("/items"));
  assert.equal(itemCalls.length, 2, itemCalls.map((call) => call.url).join(" | "));
});

await check("switching the release drops the old cursor and ignores the old response", async () => {
  const page = await bootWith();
  selectorRoutes(page);
  let releaseSecondPage;
  page.program(/^\/api\/assets\/releases\/[^/]+\/items/, (call) => {
    const url = new URL(call.url, "http://localhost");
    if (!url.searchParams.get("cursor")) {
      return page.reply({
        release_id: "assets-1077100",
        next_cursor: "assets-page-2",
        has_more: true,
        items: [{ bundle: "event_0448_story_06", item_key: "event_0448_story_06_title", status: "untranslated", translation: null }],
      });
    }
    // A slow second page. It resolves only after the test has switched away.
    releaseSecondPage = () => page.reply({
      release_id: "assets-1077100",
      next_cursor: null,
      has_more: false,
      items: [{ bundle: "stale-bundle", item_key: "stale", status: "untranslated", translation: null }],
    });
    return new Promise((resolve) => setTimeout(() => resolve(releaseSecondPage()), 0));
  });

  await page.hooks.loadSelector("assets");
  assert.equal(page.hooks.state.selector.next_cursor, "assets-page-2");
  assert.equal(page.hooks.state.selector.items.length, 1);

  // Start page 2 and then switch channels before it lands.
  const pending = page.hooks.loadMoreSelectorItems();
  await page.hooks.loadSelector("client");
  await pending;

  assert.equal(page.hooks.state.selector.channel, "client");
  assert.equal(page.hooks.state.selector.release_id, "client-9.0.200");
  assert.equal(page.hooks.state.selector.ref, "client-9.0.200");
  const bundles = page.hooks.state.selector.items.map((item) => item.bundle);
  assert.deepEqual(bundles, ["bottom-bar"], `the stale page must not land in the new channel: ${bundles.join(", ")}`);
  assert.equal(page.hooks.state.selector.next_cursor, null, "the client list has one page");
  assert.equal(page.hooks.state.selector.selected, null);
});

await check("a channel whose item list is empty does not fabricate rows", async () => {
  const page = await bootWith();
  selectorRoutes(page);
  page.program(/^\/api\/client\/releases\/[^/]+\/items/, () => page.reply({ release_id: "client-9.0.200", items: [] }));

  await page.hooks.loadSelector("client");
  assert.equal(page.hooks.state.selector.items.length, 0);
  assert.ok(/没有条目/.test(page.dom.get("selector-items").innerHTML), page.dom.get("selector-items").innerHTML);
  assert.equal(writeCalls(page).length, 0, "listing is read-only");
});

// ---------------------------------------------------------------------------
// 12. the page loads its shared module (no silent second implementation)
// ---------------------------------------------------------------------------

await check("app.js loads the shared contribution module rather than re-deriving the rules", () => {
  const appSource = fs.readFileSync(path.join(PUBLIC, "app.js"), "utf8");
  const htmlSource = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  const moduleSource = fs.readFileSync(path.join(PUBLIC, "github-contribution.js"), "utf8");

  assert.equal((htmlSource.match(/github-contribution\.js/g) || []).length, 1, "the module must be loaded exactly once");
  assert.ok(htmlSource.indexOf("github-contribution.js") < htmlSource.indexOf('src="app.js"'), "load order matters");
  assert.ok(appSource.includes("window.MLTDContribution"), "app.js must consume the shared module");

  for (const rule of ["function githubBinding(", "function isCompositeVersion(", "function versionFieldsFor("]) {
    assert.ok(moduleSource.includes(rule), `the module must define ${rule}`);
    assert.ok(!appSource.includes(rule), `app.js must not redefine ${rule}`);
  }
  assert.equal((moduleSource.match(/function buildTextProposal\(/g) || []).length, 1);
  assert.equal((appSource.match(/function buildTextProposal\(/g) || []).length, 1, "app.js keeps exactly one delegating wrapper");
  assert.equal((appSource.match(/function buildImageProposal\(/g) || []).length, 1, "app.js keeps exactly one delegating wrapper");
  // The old hint was six times the Worker's tolerance. Neither file may mention
  // that number at all — the tolerance is stated once, as 0.005.
  assert.ok(!/0\.03/.test(appSource), "the old looser ratio hint must be gone");
  assert.ok(!/0\.03/.test(moduleSource), "the old looser ratio hint must be gone from the module too");
  assert.ok(/0\.005/.test(moduleSource), "the module must state the Worker's tolerance");
});

console.log(`\n${checks} front-end GitHub checks passed`);
