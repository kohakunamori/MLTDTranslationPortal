// 部署配置门禁：唯一部署源是 `wrangler.jsonc`。
//
// `package.json` 的 deploy/preview/deploy:dry-run 必须显式 `--config
// wrangler.jsonc`；本套件只解析这一份配置，并校验它自己的必需绑定：Worker
// 名、入口 `src/worker.js`、assets/D1/R2 绑定、无 cron 触发、通道目标变量、
// 以及 `[vars]` 中不得出现 secret 名。
//
// `wrangler.toml.example` 只是历史参考样例：本套件**既不解析也不与它对照**。
// 它的漂移不能让正式配置门失败（它不能成为第二条部署入口），对它唯一的读取是
// 原始文本的 token 字面量安全扫描。
//
// 负控制使用内存 fixture 证明门禁真的会失败（jsonc 缺绑定、deploy 指向 TOML、
// 任意脚本提到 wrangler.toml），不写改任何共享目标文件。
//
// 本套件同时运行 §5「无静态版本钉死」扫描：运行时不得携带冻结的 release、
// 版本或目录行；fixture/测试/历史迁移可以提到版本号，Worker 运行时加载的文件
// 不可以。
//
// Run: node test_config.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
let checks = 0;
let failures = 0;
let negativeControls = 0;

function check(name, fn) {
  try {
    fn();
    checks += 1;
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${error.message}`);
  }
}

/// 负控制：同样的判据在 fixture 上必须确实失败。断言抛错才算通过——一个从不
/// 失败的门禁不是门禁。
function expectFailure(name, fn) {
  try {
    fn();
  } catch (_) {
    negativeControls += 1;
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}\n     the check accepted a fixture it must refuse`);
}

function read(rel) {
  return fs.readFileSync(path.join(DIRNAME, rel), "utf-8");
}

/// 可选读取：文件缺失时返回 `null` 而不是抛错。
///
/// 只有历史 TOML 样例用它。它**不是**部署入口（唯一入口是 `wrangler.jsonc`），
/// 也不是门禁通过的必要条件：独立源码候选可以不带它，`node test_config.mjs`
/// 仍必须完整跑完并通过。
function readOptional(rel) {
  const full = path.join(DIRNAME, rel);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf-8") : null;
}

/// 提交进仓的 token 是长字面量，不是占位名。从下面的 check 抽出，好让负控用
/// 合成 token 证明该扫描确实会触发——无论是否带历史 TOML 样例。
function secretLiteralErrors(text) {
  const errors = [];
  if (/(gh[pousr]_[A-Za-z0-9]{20,})/.test(text)) errors.push("no GitHub token literal may be committed");
  if (/(sk-[A-Za-z0-9]{20,})/.test(text)) errors.push("no API key literal may be committed");
  return errors;
}

/// 绝不允许出现在 `[vars]` 里的 secret 名——同样抽出，好让合成的 `[vars]`
/// 被证明会被拒。
function forbiddenVarErrors(vars) {
  const secrets = [
    "GITHUB_WEBHOOK_SECRET", "GITHUB_SYNC_TOKEN", "CLOUDFLARE_API_TOKEN",
    "MLTD_RELEASE_KEYSTORE", "PRIVATE_STORAGE_AUTH_BEARER",
  ];
  return Object.keys(vars || {})
    .filter((key) => secrets.includes(key))
    .map((key) => `wrangler.jsonc must not carry ${key} in [vars]: secrets go through wrangler secret`);
}

/// Source with comments removed. The scans below ask "does the runtime *depend*
/// on a frozen snapshot", and a comment explaining why it no longer does is the
/// opposite of a dependency — several of them name the file they replaced.
/// Only `//` and `/* */` are stripped, and string literals are left alone so a
/// URL or a message that happens to contain `//` survives.
function code(rel) {
  const text = read(rel);
  let out = "";
  let inString = null;
  let inLine = false;
  let inBlock = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inLine) { if (char === "\n") { inLine = false; out += char; } continue; }
    if (inBlock) { if (char === "*" && next === "/") { inBlock = false; index += 1; } continue; }
    if (inString) {
      out += char;
      if (char === "\\") { out += next; index += 1; continue; }
      if (char === inString) inString = null;
      continue;
    }
    if (char === "/" && next === "/") { inLine = true; index += 1; continue; }
    if (char === "/" && next === "*") { inBlock = true; index += 1; continue; }
    if (char === '"' || char === "'" || char === "`") { inString = char; out += char; continue; }
    out += char;
  }
  return out;
}

/// Strip JSON-with-comments down to parseable JSON. Written by hand rather than
/// with a dependency because the only things in these files are `//` comments.
function parseJsonc(text) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inLine) {
      if (char === "\n") { inLine = false; out += char; }
      continue;
    }
    if (inBlock) {
      if (char === "*" && next === "/") { inBlock = false; index += 1; }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") { out += next; index += 1; continue; }
      if (char === '"') inString = false;
      continue;
    }
    if (char === "/" && next === "/") { inLine = true; index += 1; continue; }
    if (char === "/" && next === "*") { inBlock = true; index += 1; continue; }
    if (char === '"') { inString = true; out += char; continue; }
    out += char;
  }
  return JSON.parse(out);
}

/// 唯一部署源自己的结构判据，抽成函数以便对内存 fixture 做负控制。
/// 只读 wrangler.jsonc 这一份配置：不存在「两份配置必须同名同绑定」的隐式
/// 第二维护面；历史 TOML 样例由本套件解析对照的责任已经取消。
function requiredConfigErrors(config) {
  const errors = [];
  const need = (condition, message) => { if (!condition) errors.push(message); };
  need(config?.name === "mltd-translation-portal", "name must be mltd-translation-portal");
  need(config?.main === "src/worker.js", "main must be src/worker.js");
  need(typeof config?.compatibility_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date),
    "compatibility_date must be a YYYY-MM-DD string");
  need(Array.isArray(config?.compatibility_flags) && config.compatibility_flags.includes("nodejs_compat"),
    "compatibility_flags must include nodejs_compat");
  need(config?.assets?.directory === "./public", "assets.directory must be ./public");
  need(config?.assets?.binding === "ASSETS", "assets.binding must be ASSETS");
  need(config?.assets?.run_worker_first === true, "assets.run_worker_first must be true so /api/* reaches src/worker.js");
  const d1 = config?.d1_databases?.[0];
  need(d1?.binding === "DB", "d1_databases[0].binding must be DB");
  need(Boolean(d1?.database_name), "d1_databases[0].database_name must be set");
  need(d1?.migrations_dir === "migrations", "d1_databases[0].migrations_dir must be migrations");
  const r2 = config?.r2_buckets?.[0];
  need(r2?.binding === "PUBLICATION_BUCKET", "r2_buckets[0].binding must be PUBLICATION_BUCKET");
  need(Boolean(r2?.bucket_name), "r2_buckets[0].bucket_name must be set");
  need(config?.triggers === undefined, "the D1 sync consumer must stay unscheduled (no triggers)");
  const vars = config?.vars || {};
  need(vars.GITHUB_TARGET_ASSETS === "kohakunamori/MLTDTranslationAssets", "vars.GITHUB_TARGET_ASSETS must name the Assets repository");
  need(vars.GITHUB_TARGET_CLIENT === "kohakunamori/MLTDTranslationClient", "vars.GITHUB_TARGET_CLIENT must name the Client repository");
  need(typeof vars.GITHUB_CLIENT_MANIFEST_PATH === "string" && vars.GITHUB_CLIENT_MANIFEST_PATH.trim() !== "",
    "vars.GITHUB_CLIENT_MANIFEST_PATH must declare the client text location");
  return errors;
}

/// deploy/preview/dry-run 必须显式从 wrangler.jsonc 读取；任何脚本不得提到
/// wrangler.toml——TOML 样例不是第二条部署入口。
function deploymentEntryErrors(pkg) {
  const errors = [];
  const scripts = pkg?.scripts || {};
  for (const name of ["deploy", "preview", "deploy:dry-run"]) {
    if (!scripts[name]) { errors.push(`package.json must declare the ${name} script`); continue; }
    if (!/--config\s+wrangler\.jsonc(?:\s|$)/.test(String(scripts[name]))) {
      errors.push(`${name} must deploy from wrangler.jsonc`);
    }
  }
  for (const [name, value] of Object.entries(scripts)) {
    if (/wrangler\.toml/.test(String(value))) errors.push(`script ${name} must not read a TOML deployment file`);
  }
  return errors;
}

const jsonc = parseJsonc(read("wrangler.jsonc"));

// ---------------------------------------------------------------------------
// 1. 唯一部署源：wrangler.jsonc 自己的必需绑定与入口
// ---------------------------------------------------------------------------

check("package.json deploys from wrangler.jsonc only", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.deepEqual(deploymentEntryErrors(pkg), []);
});

check("wrangler.jsonc carries every required binding and the Worker entry", () => {
  assert.deepEqual(requiredConfigErrors(jsonc), []);
  const workerSource = read("src/worker.js");
  assert.match(workerSource, /export default\s*\{/, "src/worker.js must export the Worker default handler");
});

// 负控制（内存 fixture，不写任何共享目标文件）：同一个判据必须真的会拒绝。
expectFailure("negative control: a deploy script pointing at wrangler.toml is refused", () => {
  const bad = { scripts: { deploy: "wrangler deploy --config wrangler.toml", preview: "wrangler dev --config wrangler.jsonc", "deploy:dry-run": "wrangler deploy --config wrangler.jsonc --dry-run" } };
  assert.deepEqual(deploymentEntryErrors(bad), []);
});

expectFailure("negative control: a jsonc fixture missing a required binding is refused", () => {
  const bad = JSON.parse(JSON.stringify(jsonc));
  delete bad.r2_buckets;
  assert.deepEqual(requiredConfigErrors(bad), []);
});

expectFailure("negative control: a jsonc fixture omitting nodejs_compat is refused", () => {
  const bad = JSON.parse(JSON.stringify(jsonc));
  bad.compatibility_flags = [];
  assert.deepEqual(requiredConfigErrors(bad), []);
});

check("no secret is present in the deployment config", () => {
  assert.deepEqual(forbiddenVarErrors(jsonc.vars), []);
  // 部署配置自身的字节始终被扫描：提交进仓的 token 是长字面量，不是占位名。
  assert.deepEqual(secretLiteralErrors(read("wrangler.jsonc")), []);
  // 历史 TOML 样例是**可选**的。存在时其字节同样被扫描（卫生：仓内任何一处
  // 都不得出现 token 字面量），但缺失不得令门禁失败——独立源码候选不必带它，
  // 它也不是第二个部署入口。它永不参与解析。
  const toml = readOptional("wrangler.toml.example");
  if (toml !== null) {
    assert.deepEqual(secretLiteralErrors(toml), []);
  }
});

// secret 扫描器的负控。抽上面两个 helper 的意义就在这里：一个无法被证明会
// 失败的门禁不是门禁。
expectFailure("negative control: a synthetic GitHub token literal is refused", () => {
  assert.deepEqual(secretLiteralErrors("token = " + JSON.stringify("ghp_" + "a".repeat(30))), []);
});
expectFailure("negative control: a synthetic API key literal is refused", () => {
  assert.deepEqual(secretLiteralErrors("key = " + JSON.stringify("sk-" + "b".repeat(30))), []);
});
expectFailure("negative control: a forbidden secret key in [vars] is refused", () => {
  assert.deepEqual(forbiddenVarErrors({ GITHUB_SYNC_TOKEN: "x" }), []);
});
// 带历史 TOML 样例（**存在**）时同样被拒：扫描器照旧跑在拼接后的字节上。
expectFailure("negative control: a synthetic token in a legacy TOML sample is refused", () => {
  const toml = 'name = "mltd-translation-portal"\n' + 'token = "' + "ghp_" + "c".repeat(30) + '"';
  assert.deepEqual(secretLiteralErrors(read("wrangler.jsonc") + toml), []);
});
// 缺部署配置仍被拒：唯一入口是必须的，`requiredConfigErrors(null)` 必须报出它。
// （另外，套件顶层自身的 `read("wrangler.jsonc")` 在文件缺失时也会抛错。）
expectFailure("negative control: a missing deployment config is refused", () => {
  assert.deepEqual(requiredConfigErrors(null), []);
});

check("the Worker marks D1 sync as manual-only", async () => {
  const workerSource = read("src/worker.js");
  const match = workerSource.match(/SYNC_CRON\s*=\s*"([^"]+)"/);
  assert.ok(match, "src/worker.js must declare SYNC_CRON");
  assert.equal(match[1], "manual");
});

// ---------------------------------------------------------------------------
// 2. Nothing in the runtime may pin a release
// ---------------------------------------------------------------------------

const RUNTIME_FILES = [
  "src/worker.js",
  "src/sync_ingest.js",
  "src/sync_runner.js",
  "src/release_registry.js",
  "src/categories.js",
  "src/terms.js",
];

const FORBIDDEN_IDENTIFIERS = [
  "HOT_CATALOGUE", "HOT_BASE_VERSION", "SONGS_CATALOG", "DEFAULT_STATS",
  "REGISTERED_ASSET_VERSIONS", "SUPERSEDED_OR_UNVERIFIED_ASSET_VERSIONS",
  "STATS_SNAPSHOT", "hot_catalogue", "songs_catalog", "stats_snapshot",
];

check("no runtime file references a frozen release or catalogue constant", () => {
  for (const rel of RUNTIME_FILES) {
    const text = code(rel);
    for (const identifier of FORBIDDEN_IDENTIFIERS) {
      assert.ok(
        !text.includes(identifier),
        `${rel} must not reference ${identifier}: release state is read from D1`,
      );
    }
  }
});

check("no runtime file writes a composite version as an identity", () => {
  // `9.0.200+1077100` is a *tested combination*, recorded for humans. It must
  // never appear as a key, a default, or a build input in the runtime.
  for (const rel of RUNTIME_FILES) {
    const text = code(rel);
    const composite = text.match(/\d+\.\d+\.\d+\+\d{4,}/g) || [];
    assert.deepEqual(
      composite, [],
      `${rel} must not contain a composite version literal (found ${composite.join(", ")})`,
    );
  }
});

check("no runtime file hard-codes an allowlist of asset versions", () => {
  // A `Set(["1077100"])` or a bare `["1077100", "1077500"]` in the runtime is the
  // pattern that made a version map into an authority. Writability is the
  // `status` column of `assets_releases`.
  for (const rel of RUNTIME_FILES) {
    const text = code(rel);
    const versionLiterals = text.match(/["'`]\d{7}["'`]/g) || [];
    assert.deepEqual(
      versionLiterals, [],
      `${rel} must not contain an asset version literal (found ${versionLiterals.join(", ")})`,
    );
  }
});

check("the runtime reads release state from D1, not from a Set", () => {
  const registry = code("src/release_registry.js");
  assert.ok(
    /FROM assets_releases/.test(registry),
    "release_registry.js must resolve releases by querying assets_releases",
  );
  // A `Set` here is fine when it holds *statuses* (`canonical`, `staging`) —
  // those are a schema enum, not release data. What must not exist is a Set of
  // version strings, which is how an allowlist gets reintroduced.
  const sets = registry.match(/new Set\(\[([^\]]*)\]\)/g) || [];
  for (const literal of sets) {
    const versions = literal.match(/\d{6,}/g) || [];
    assert.deepEqual(
      versions, [],
      `release_registry.js must not build a Set of versions: ${literal}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. The static bundle carries no release state
// ---------------------------------------------------------------------------

check("the shipped public/ tree publishes no generated release snapshot", () => {
  // A snapshot may sit in the working tree as regenerable evidence, but it must
  // never be *published*: `wrangler deploy` uploads every file under
  // `assets.directory` except those matched by `public/.assetsignore`. Deleting
  // the file is one way to pass this; excluding it is the other, and it is the
  // one that keeps the evidence. So the check is "on disk implies excluded",
  // not "absent".
  // The image task manifest is intentionally published as a static read-only fallback.
  const banned = ["songs_catalog.json", "hot_catalogue.js", "stats_snapshot.js"];
  const ignorePath = path.join(DIRNAME, "public", ".assetsignore");
  const ignoreText = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, "utf-8") : "";
  const excluded = ignoreText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  const published = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (banned.includes(entry.name)) {
        const webPath = "/" + path.relative(path.join(DIRNAME, "public"), full).split(path.sep).join("/");
        if (!excluded.includes(webPath)) published.push(webPath);
      }
    }
  };
  walk(path.join(DIRNAME, "public"));
  assert.deepEqual(
    published, [],
    `public/ must not publish generated release snapshots — add them to public/.assetsignore: ${published.join(", ")}`,
  );

  // The retired per-song lyric snapshots are covered by a glob, not by name, so
  // they need their own assertion: no file under public/data/lyrics/ may be
  // published.
  const lyricPublished = [];
  const lyricsDir = path.join(DIRNAME, "public", "data", "lyrics");
  if (fs.existsSync(lyricsDir)) {
    for (const entry of fs.readdirSync(lyricsDir)) {
      if (!entry.endsWith(".json")) continue;
      const webPath = `/data/lyrics/${entry}`;
      const covered = excluded.some((pattern) => {
        if (pattern === webPath) return true;
        if (pattern.includes("*")) {
          const regex = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
          return regex.test(webPath);
        }
        return false;
      });
      if (!covered) lyricPublished.push(webPath);
    }
  }
  assert.deepEqual(
    lyricPublished, [],
    `public/data/lyrics/ must not be published — keep /data/lyrics/*.json in public/.assetsignore: ${lyricPublished.slice(0, 5).join(", ")}`,
  );
});

check("the shipped index.html carries no hard-coded catalogue counts", () => {
  const html = read("public/index.html");
  // The counts are filled from the API. A literal like "432 首" or "(432)" is a
  // number that goes stale the moment a release changes.
  const literals = html.match(/\((?:1,)?\d{3,}\)/g) || [];
  assert.deepEqual(literals, [], `index.html must not hard-code catalogue counts: ${literals.join(", ")}`);
});

// ---------------------------------------------------------------------------
// 4. The lyrics cache is a source cache, not a translation store
// ---------------------------------------------------------------------------

check("the Worker never serves the static lyric cache at runtime", () => {
  // `public/data/lyrics/<bundle>.json` is a retired extractor artefact: any live
  // read of it (fetch or import) would let an offline snapshot overrule the
  // release. Comments may name the retired path so history stays legible.
  const worker = code("src/worker.js");
  assert.ok(
    !/fetch\([^)]*data\/lyrics\//.test(worker),
    "worker.js must not fetch data/lyrics/ at runtime",
  );
  assert.ok(
    !/from\s+["'][^"']*data\/lyrics\//.test(worker) && !/import\([^)]*data\/lyrics\//.test(worker),
    "worker.js must not import data/lyrics/ at runtime",
  );
  assert.ok(
    !/source:\s*"source_cache"/.test(worker),
    "worker.js must not report a source_cache origin",
  );
});

console.log(failures === 0
  ? `portal config conformance PASS (${checks} checks, ${negativeControls} negative controls)`
  : `portal config conformance FAIL (${checks} checks, ${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);
