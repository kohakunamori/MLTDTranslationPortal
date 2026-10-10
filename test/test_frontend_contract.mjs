// 静态站点契约测试：不需要浏览器，验证三件事
//   1. 读取只依赖 public/** 里的静态文件（没有任何服务端接口或 Worker 时代的残留）；
//      写入多了一条可选的同源中继，只放行 lib/relay-write.js，且它必须能退回直连；
//   2. index.html 与 app.js 的 id / 路由 / 关闭目标互相对得上；
//   3. 生成的数据自洽（索引指向的文件存在、计数一致、hash 自洽、编辑绑定可用），
//      并且真的能被静态服务器按页面用的 URL 取到。
//
// 运行：node test/test_frontend_contract.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildOutputs } from "../scripts/build_data.mjs";
import { createStaticServer } from "../scripts/serve.mjs";
import { applyJsonlEdit } from "../public/lib/github-write.js";
import { filterBundles, progressPercent } from "../public/lib/data.js";

const FIXTURE_ASSETS = "test_helpers/fixtures/assets-repo";
const FIXTURE_CLIENT = "test_helpers/fixtures/client-repo";
const STAMP = "2026-01-01T00:00:00Z";
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`ok   ${name}\n`);
  } catch (error) {
    process.stdout.write(`FAIL ${name}\n     ${error.message}\n`);
    process.exitCode = 1;
  }
}

const publicFiles = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "data") continue; // 生成数据单独检查
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else publicFiles.push(full);
  }
})("public");

const readPublic = (file) => readFileSync(file, "utf8");
const indexHtml = readPublic("public/index.html");
const appJs = readPublic("public/app.js");

// ------------------------------------------------------------------ 1. 静态化

ok("读取路径不依赖任何服务端接口", () => {
  // 站点必须能纯静态跑起来：读取一律走 public/data/**。
  // 写入从 2026-10 起多了一条**可选**的同源中继（只有自托管那边有），旧站点上不存在时
  // 必须自动退回浏览器直连 GitHub，所以只放行 relay-write.js 一个文件，别处照旧禁止。
  const allowed = join("public", "lib", "relay-write.js");
  const offenders = [];
  for (const file of publicFiles) {
    if (!/\.(js|html|css)$/i.test(file)) continue;
    if (file === allowed) continue;
    const text = readPublic(file);
    for (const pattern of [/["'`]\/api\//, /\bfetch\(["'`]\/api/]) {
      if (pattern.test(text)) offenders.push(`${file} 命中 ${pattern}`);
    }
  }
  assert.deepEqual(offenders, []);
});

ok("中继只是可选传输，缺席时退回浏览器直连", () => {
  const relay = readPublic(join("public", "lib", "relay-write.js"));
  assert.ok(relay.includes("commitLineEdit"), "relay-write.js 必须保留直连实现作为退路");
  assert.ok(relay.includes("no_route"), "缺席判定要看路由级 404，不能把业务错误当成没有中继");
  assert.ok(!appJs.includes("/api/"), "app.js 不该自己拼接口地址，传输细节留在 lib 里");
  assert.ok(!indexHtml.includes("/api/"), "index.html 不该引用接口");
});

ok("没有 Worker / D1 / 协作时代的残留标识", () => {
  const banned = ["MLTDContribution", "resource_hub", "github-contribution", "wrangler", "env.DB", "PUBLICATION_BUCKET", "csrf", "PR 提案"];
  const offenders = [];
  for (const file of publicFiles) {
    if (!/\.(js|html|css)$/i.test(file)) continue;
    const text = readPublic(file);
    for (const token of banned) if (text.includes(token)) offenders.push(`${file} 含 ${token}`);
  }
  assert.deepEqual(offenders, []);
});

ok("不使用 XMLHttpRequest / document.cookie / localStorage 明文外发", () => {
  for (const file of publicFiles) {
    if (!file.endsWith(".js")) continue;
    const text = readPublic(file);
    assert.ok(!text.includes("XMLHttpRequest"), `${file} 用了 XMLHttpRequest`);
    assert.ok(!text.includes("document.cookie"), `${file} 读了 cookie`);
  }
});

ok("app.js 的 import 全部指向存在的文件", () => {
  const specifiers = [...appJs.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(specifiers.length >= 5, "app.js 应该 import 数据层与两个可选模块");
  for (const specifier of specifiers) {
    assert.ok(specifier.startsWith("./"), `${specifier} 必须是相对路径（Pages 子路径部署）`);
    const full = join("public", specifier.replace(/^\.\//, ""));
    assert.ok(existsSync(full), `${specifier} 指向的文件不存在`);
  }
});

// ------------------------------------------------------------------ 2. DOM 契约

const htmlIds = new Set([...indexHtml.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));

ok("app.js 引用的每个 DOM id 都存在于 index.html", () => {
  const referenced = new Set();
  for (const match of appJs.matchAll(/\$\("([^"]+)"\)/g)) referenced.add(match[1]);
  for (const match of appJs.matchAll(/getElementById\("([^"]+)"\)/g)) referenced.add(match[1]);
  const missing = [...referenced].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `index.html 缺少这些 id：${missing.join(", ")}`);
});

ok("每个导航按钮都有对应的 view 区块", () => {
  const navs = [...indexHtml.matchAll(/data-nav="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(navs.length >= 4);
  for (const nav of navs) assert.ok(htmlIds.has(`view-${nav}`), `缺少 #view-${nav}`);
});

ok("data-close 指向存在的弹窗", () => {
  const targets = [...indexHtml.matchAll(/data-close="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(targets.length >= 2);
  const modalOf = { confirm: "confirm-modal", lightbox: "lightbox" };
  for (const target of targets) {
    assert.ok(modalOf[target], `未知的 data-close=${target}`);
    assert.ok(htmlIds.has(modalOf[target]), `缺少 #${modalOf[target]}`);
  }
});

ok("页面不再加载被删除的脚本", () => {
  assert.ok(!indexHtml.includes("github-contribution.js"));
  assert.ok(!indexHtml.includes("resource_hub.js"));
  const scripts = [...indexHtml.matchAll(/<script[^>]*src="([^"]+)"/g)].map((match) => match[1]);
  for (const src of scripts) assert.ok(existsSync(join("public", src)), `${src} 不存在`);
  const styles = [...indexHtml.matchAll(/<link[^>]*href="([^"]+)"/g)].map((match) => match[1]).filter((href) => !href.startsWith("http"));
  for (const href of styles) assert.ok(existsSync(join("public", href)), `${href} 不存在`);
});

// ------------------------------------------------------------------ 临时站点（真实生成的产物）

const siteDir = mkdtempSync(join(tmpdir(), "portal-site-"));
process.on("exit", () => rmSync(siteDir, { recursive: true, force: true }));

for (const entry of readdirSync("public", { withFileTypes: true })) {
  if (entry.name === "data") continue;
  cpSync(join("public", entry.name), join(siteDir, entry.name), { recursive: true });
}

const built = buildOutputs({
  assetsRoot: FIXTURE_ASSETS,
  clientRoot: FIXTURE_CLIENT,
  generatedAt: STAMP,
  out: join(siteDir, "data"),
});
for (const [file, content] of built.files) {
  const full = join(siteDir, "data", file);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}
const portal = JSON.parse(readFileSync(join(siteDir, "data", "portal.json"), "utf8"));

// ------------------------------------------------------------------ 3. 数据自洽

ok("每个分类分片都能解析，索引指向的每个页文件都存在", () => {
  let files = 0;
  for (const category of portal.categories) {
    const index = JSON.parse(readFileSync(join(siteDir, "data", `catalogue/${category.id}.json`), "utf8"));
    assert.equal(index.category, category.id);
    assert.equal(index.total_bundles, index.bundles.length);
    for (const bundle of index.bundles) {
      assert.equal(bundle.category, category.id, `${bundle.bundle} 出现在错误的分片里`);
      assert.equal(bundle.pages.length, bundle.page_count, `${bundle.bundle} 的页数不一致`);
      assert.equal(bundle.pages.reduce((sum, page) => sum + page.total, 0), bundle.total);
      for (const page of bundle.pages) {
        assert.ok(page.file.startsWith(`bundles/${category.id}/`), `${bundle.bundle} 的文件不在本分类目录下`);
        assert.ok(existsSync(join(siteDir, "data", page.file)), `缺少 ${page.file}`);
        files += 1;
      }
      // 单页 bundle 的 file 就是那一页；多页 bundle 的 file 是第一页（便于直接打开）
      assert.equal(bundle.file, bundle.pages[0].file);
    }
  }
  assert.equal(files, portal.totals.files);
  assert.equal(portal.totals.bundles, portal.categories.reduce((sum, category) => sum + category.bundles, 0));
});

ok("索引计数与每个页文件内容一致，行号跨页连续", () => {
  for (const category of portal.categories) {
    const index = JSON.parse(readFileSync(join(siteDir, "data", `catalogue/${category.id}.json`), "utf8"));
    for (const bundle of index.bundles) {
      let seen = 0;
      for (const page of bundle.pages) {
        const content = JSON.parse(readFileSync(join(siteDir, "data", page.file), "utf8"));
        assert.equal(content.total_lines, page.total, `${page.file} 行数对不上索引`);
        assert.equal(
          content.translated + content.pending + content.untranslated + content.not_needed,
          content.total_lines,
          `${page.file} 的四类计数加起来不等于总行数`,
        );
        assert.equal(content.lines.length, page.total);
        assert.equal(content.category, bundle.category);
        assert.equal(content.bundle, bundle.bundle);
        assert.equal(content.page_count, bundle.page_count);
        assert.equal(content.page, bundle.page_count === 1 ? null : page.page);
        assert.equal(content.edit.kind, bundle.channel === "client" ? "manifest" : "jsonl");
        assert.equal(content.edit.identity_field, bundle.edit.identity_field, `${page.file} 的定位字段与索引不一致`);
        assert.ok(content.edit.path, `${page.file} 缺少可写路径`);
        assert.equal(content.first_index, page.first_index);
        assert.equal(content.last_index, page.last_index);
        assert.equal(content.lines[0]?.index, page.first_index, `${page.file} 首页行号不对`);
        assert.equal(content.lines.at(-1)?.index, page.last_index, `${page.file} 末页行号不对`);
        seen += content.total_lines;
      }
      assert.equal(seen, bundle.total);
      assert.equal(bundle.translated + bundle.pending + bundle.untranslated + bundle.not_needed, bundle.total);
    }
  }
});

ok("行级 edit_path 只在真正需要时出现，且指向另一个上游文件", () => {
  for (const category of portal.categories) {
    const index = JSON.parse(readFileSync(join(siteDir, "data", `catalogue/${category.id}.json`), "utf8"));
    for (const bundle of index.bundles) {
      for (const page of bundle.pages) {
        const content = JSON.parse(readFileSync(join(siteDir, "data", page.file), "utf8"));
        const canonical = content.edit.path.replace(/\.jsonl$/, "");
        for (const line of content.lines) {
          if (line.edit_path === undefined) continue;
          assert.notEqual(line.edit_path, content.edit.path, `${page.file} 的 ${line.item_key} 带了多余的 edit_path`);
          assert.ok(!line.edit_path.includes(".."), "写路径不能跳出仓库");
          // 权威路径以 bundle 名结尾；例外行指向增量 / 汇总文件
          assert.ok(
            line.edit_path.endsWith(`${bundle.bundle}.jsonl`) === false || line.edit_path === content.edit.path,
            `${page.file} 的行把 edit_path 指回了权威文件`,
          );
          assert.ok(canonical.length > 0);
        }
      }
    }
  }
});

ok("每一行的 hash、状态与可写定位字段都齐全", () => {
  const allowed = new Set(["accepted", "pending", "untranslated", "not_needed"]);
  for (const category of portal.categories) {
    const index = JSON.parse(readFileSync(join(siteDir, "data", `catalogue/${category.id}.json`), "utf8"));
    for (const bundle of index.bundles) {
      const keys = new Set();
      for (const page of bundle.pages) {
        const content = JSON.parse(readFileSync(join(siteDir, "data", page.file), "utf8"));
        assert.ok(content.edit.repo.includes("/"), `${page.file} 的仓库标识不合法`);
        assert.ok(content.edit.ref, `${page.file} 缺少分支`);
        assert.ok(content.edit.path && !content.edit.path.includes(".."), `${page.file} 的可写路径不合法`);
        assert.ok(["item_key", "index"].includes(content.edit.identity_field), `${page.file} 的定位字段未知`);
        for (const line of content.lines) {
          assert.equal(line.source_sha256, sha256(line.source), `${page.file} 的 ${line.item_key} hash 不一致`);
          assert.ok(line.item_key, "缺少 item_key：没有它就无法定位行");
          assert.ok(allowed.has(line.status), `未知状态 ${line.status}`);
          // 派生状态只可能出现在没有译文的行上
          if (line.status === "not_needed") assert.equal(line.translation, null, "无需翻译的行不该带译文");
          assert.ok(!keys.has(line.item_key), `${page.file} 里 item_key ${line.item_key} 重复，写入路径会拒绝`);
          keys.add(line.item_key);
          if (content.edit.kind === "manifest") assert.equal(typeof line.manifest_index, "number");
        }
      }
      assert.equal(keys.size, bundle.total, `${bundle.bundle} 的行数对不上索引`);
    }
  }
});

ok("portal 计数等于各分片之和", () => {
  const total = portal.categories.reduce((sum, category) => sum + category.total, 0);
  const translated = portal.categories.reduce((sum, category) => sum + category.translated, 0);
  assert.equal(total, portal.totals.total);
  assert.equal(translated, portal.totals.translated);
  assert.equal(portal.domains.reduce((sum, domain) => sum + domain.total, 0), portal.totals.total);
});

ok("图片索引结构完整，地址是站点内相对路径", () => {
  const images = JSON.parse(readFileSync(join(siteDir, "data", "images.json"), "utf8"));
  assert.equal(images.categories.all, images.total);
  assert.equal(images.statuses.all, images.total);
  assert.equal(images.statuses.localized + images.statuses.original_only, images.total);
  assert.equal(portal.image_statuses.all, images.total, "portal 与 images.json 的图片总数要一致");
  assert.deepEqual(portal.image_statuses, images.statuses);
  for (const task of images.tasks) {
    assert.ok(task.task_id);
    assert.ok(images.categories[task.category] >= 1, `${task.task_id} 的分类不在清单里`);
    assert.ok(task.localized_path || !task.has_localized, `${task.task_id} 有中文版却没有上游路径`);
    // 清单里的 distribution URL 实测 404，数据与页面都不许再出现
    assert.equal(task.original_url, undefined, "不许给会 404 的原图地址");
    assert.equal(task.original_published, false);
    if (task.has_localized) {
      assert.match(task.localized_url, /^media\/localized\/.+\.png$/, "必须是站点内相对路径");
      assert.equal(task.localized_url.startsWith("/"), false, "不能有前导斜杠（Pages 子路径部署）");
      assert.equal(task.localized_url.startsWith("http"), false, "不能是外部地址");
      assert.equal(images.tasks.filter((other) => other.localized_url === task.localized_url).length, 1);
    } else {
      assert.equal(task.localized_url, null);
    }
  }
});

ok("Token 入口只指向 GitHub 官方页面，且没有偷偷调用 OAuth 端点", () => {
  const html = readFileSync(join(siteDir, "index.html"), "utf8");
  for (const id of ["pat-create-fine", "pat-create-classic", "pat-input", "pat-verify"]) {
    assert.match(html, new RegExp(`id="${id}"`), `设置页缺少 #${id}`);
  }
  // 大段"推荐细粒度…"的说明已经删掉：细节放进可展开的分步指南，卡片上不再堆文字
  const app = readFileSync(join(siteDir, "app.js"), "utf8");
  assert.equal(/id="pat-howto"/.test(html), false, "不该再有大段说明段落");
  // 删掉那段说明后，指南里必须自己写清要勾哪个仓库
  assert.match(html, /id="pat-guide-repo"/, "分步指南要指出具体仓库名");
  assert.match(app, /pat-guide-repo/, "仓库名要从数据里填，不能写死");
  assert.match(app, /settings\/personal-access-tokens\/new/, "要有细粒度 Token 的一键新建入口");
  assert.match(app, /settings\/tokens\/new\?scopes=public_repo/, "经典 Token 链接要预勾好 scope");
  // 分步指南直接内嵌在页面里（原生 details），并指向仓库里的完整版
  assert.match(html, /id="pat-guide"/);
  assert.match(html, /<details[^>]*id="pat-guide"/);
  for (const phrase of ["Only select repositories", "Contents", "Read and write", "Generate token"]) {
    assert.ok(html.includes(phrase), `设置页的分步指南里应当出现「${phrase}」`);
  }
  assert.ok(existsSync("docs/GITHUB-TOKEN.md"), "完整指南 docs/GITHUB-TOKEN.md 必须在仓库里");
  const guide = readFileSync("docs/GITHUB-TOKEN.md", "utf8");
  for (const phrase of ["personal-access-tokens/new", "public_repo", "Contents: Read and write", "Revoke"]) {
    assert.ok(guide.includes(phrase), `指南里应当出现「${phrase}」`);
  }
  // 权限给错时的正确处置 + 自查用的响应头（取自 GitHub 官方文档）
  assert.ok(guide.includes("Edit"), "细粒度 Token 应当说明可以直接 Edit 改权限");
  assert.equal(/改完权限要重新生成/.test(guide), false, "不该再说'改权限必须重新生成'（细粒度可以 Edit）");
  assert.ok(guide.includes("X-Accepted-GitHub-Permissions"), "排错里应当教人用 X-Accepted-GitHub-Permissions 自查");
  assert.ok(guide.includes("docs.github.com"), "指南应当引用 GitHub 官方文档链接");
  // 实测：github.com/login/oauth/* 与 /login/device/code 都不返回 Access-Control-Allow-Origin，
  // 浏览器连设备码都拿不到，换码还需要 client_secret —— 纯静态站点做不了 OAuth，别写进去。
  assert.equal(/fetch\(\s*[`"']https:\/\/github\.com\/login/.test(app), false, "不许调用 github.com 的 OAuth 端点");
  // 注释里说明"为什么做不了 OAuth"是可以的，但不许真的把它发出去
  assert.equal(/client_secret\s*[=:]/.test(app), false, "client_secret 不能出现在任何请求里");
  assert.equal(/client_secret\s*[=:]/.test(html), false);
});

ok("页面用 imageSrc()，不自己拼图片地址", () => {
  const app = readFileSync(join(siteDir, "app.js"), "utf8");
  assert.match(app, /imageSrc\(/);
  assert.equal(/imageUrl\s*\(/.test(app), false, "旧的 imageUrl() 已经删掉");
  assert.equal(/prepared_image|restored_image|imageObjectUrl/.test(app), false);
  assert.equal(/lightbox-view-(both|original|localized)/.test(app), false, "没有并排对照按钮了");
  const html = readFileSync(join(siteDir, "index.html"), "utf8");
  assert.equal(/id="image-status"/.test(html), false, "状态筛选已去掉（937 条全有中文版）");
  assert.match(html, /id="lightbox-image"/);
});

ok("来源（Assets/Client）与翻译状态筛选语义正确", () => {
  const all = [];
  for (const category of portal.categories) {
    const index = JSON.parse(readFileSync(join(siteDir, "data", `catalogue/${category.id}.json`), "utf8"));
    for (const bundle of index.bundles) {
      assert.ok(["assets", "client"].includes(bundle.channel), `${bundle.bundle} 的 channel 非法：${bundle.channel}`);
      all.push(bundle);
    }
  }
  assert.equal(all.length, portal.totals.bundles);

  const client = filterBundles(all, { channel: "client" });
  const assets = filterBundles(all, { channel: "assets" });
  assert.equal(client.length + assets.length, all.length, "两个来源必须正好覆盖全部");
  assert.ok(client.length >= 1, "fixture 里应当有客户端清单");
  assert.ok(client.every((bundle) => bundle.channel === "client"));
  assert.ok(assets.every((bundle) => bundle.channel === "assets"));
  assert.equal(filterBundles(all, {}).length, all.length, "不传筛选就全都要");

  // 状态筛选与"有没有未译行 / 待确认行"严格对齐
  const untranslated = filterBundles(all, { status: "untranslated" });
  const pending = filterBundles(all, { status: "pending" });
  const complete = filterBundles(all, { status: "complete" });
  assert.deepEqual(untranslated.map((b) => b.bundle).sort(), all.filter((b) => b.untranslated > 0).map((b) => b.bundle).sort());
  assert.deepEqual(pending.map((b) => b.bundle).sort(), all.filter((b) => b.pending > 0).map((b) => b.bundle).sort());
  assert.deepEqual(complete.map((b) => b.bundle).sort(), all.filter((b) => b.untranslated === 0 && b.pending === 0).map((b) => b.bundle).sort());
  // 三类互斥且覆盖全部：已翻译（无未译无待确认）/ 未翻译（有未译行）/ 仅待确认
  const pendingOnly = all.filter((b) => b.pending > 0 && b.untranslated === 0);
  assert.equal(
    untranslated.length + complete.length + pendingOnly.length,
    all.length,
    "未翻译 / 已翻译 / 仅待确认三类必须互斥且覆盖全部资源",
  );
  assert.equal(untranslated.filter((b) => b.pending === 0 && b.untranslated === 0).length, 0);

  // 两个维度叠加
  const clientComplete = filterBundles(all, { channel: "client", status: "complete" });
  assert.ok(clientComplete.every((bundle) => bundle.channel === "client" && bundle.untranslated === 0 && bundle.pending === 0));
  const assetsUntranslated = filterBundles(all, { channel: "assets", status: "untranslated" });
  assert.ok(assetsUntranslated.every((bundle) => bundle.channel === "assets" && bundle.untranslated > 0));
});

ok("筛选器出现在页面上，且状态/来源下拉带真实数量", () => {
  const html = readFileSync(join(siteDir, "index.html"), "utf8");
  assert.match(html, /id="filter-channel"/);
  assert.match(html, /value="assets"/);
  assert.match(html, /value="client"/);
  assert.match(html, /id="filter-status"/);
  for (const value of ["untranslated", "pending", "complete"]) {
    assert.match(html, new RegExp(`id="filter-status"[\\s\\S]{0,400}value="${value}"`), `状态下拉缺少 ${value}`);
  }
  const app = readFileSync(join(siteDir, "app.js"), "utf8");
  assert.match(app, /labelStatusOptions\(/);
  assert.match(app, /filterBundles\(state\.catalogue\.bundles, state\.catalogue\.filters\)/);
  assert.match(app, /filters\.channel/);
});

ok("「无需翻译」在数据与界面里都成立", () => {
  // 数据：四类互斥且覆盖全部行；not_needed 只可能出现在没有译文的行上
  const all = [];
  for (const category of portal.categories) {
    const index = JSON.parse(readFileSync(join(siteDir, "data", `catalogue/${category.id}.json`), "utf8"));
    for (const bundle of index.bundles) {
      assert.equal(
        bundle.translated + bundle.pending + bundle.untranslated + bundle.not_needed,
        bundle.total,
        `${bundle.bundle} 的四类计数加起来不等于总行数`,
      );
      for (const page of bundle.pages) {
        const content = JSON.parse(readFileSync(join(siteDir, "data", page.file), "utf8"));
        for (const line of content.lines) {
          if (line.status === "not_needed") {
            assert.equal(line.translation, null, "无需翻译的行不该带译文");
          }
        }
      }
      all.push(bundle);
    }
  }
  const sum = (field) => all.reduce((total, bundle) => total + bundle[field], 0);
  assert.equal(sum("not_needed"), portal.totals.not_needed);
  assert.equal(sum("untranslated"), portal.totals.untranslated);

  // 进度口径一致：分母扣掉 not_needed，且与 portal 的总进度对得上
  const translatable = sum("total") - sum("not_needed");
  assert.equal(Math.round((sum("translated") / translatable) * 10000) / 100, portal.totals.progress_percent);
  for (const bundle of all) assert.equal(progressPercent(bundle), progressPercent({ ...bundle }), "纯函数，重复调用要稳定");
  const afspt = all.find((bundle) => bundle.bundle === "scrobj_aftspt.unity3d");
  if (afspt) assert.equal(progressPercent(afspt), 100, "全英文歌词的歌应当算 100%");

  // 界面：阅读页有「无需翻译」选项，编辑时不会把派生状态写回上游
  const html = readFileSync(join(siteDir, "index.html"), "utf8");
  assert.match(html, /id="read-status"[\s\S]{0,400}value="not_needed"/, "阅读页状态筛选缺少「无需翻译」");
  const app = readFileSync(join(siteDir, "app.js"), "utf8");
  assert.match(app, /status === "not_needed"\) return "无需翻译"/);
  assert.match(app, /line\.status === "not_needed" \? "accepted"/, "编辑派生状态的行时要写成 accepted");
});

// ------------------------------------------------------------------ 4. 写入路径（不改上游也能验证）

ok("按生成的字段能重建上游 JSONL 并完成一次字节精确的单行修改", async () => {
  const bundle = JSON.parse(readFileSync(join(siteDir, "data", "bundles/lyrics/scrobj_smile1.json"), "utf8"));
  // 上游行按契约必须带 zh 与 status 键；这里按同一形状重建一个上游文件。
  const upstream = bundle.lines
    .map((line) => JSON.stringify({
      asset_version: bundle.asset_version,
      bundle: bundle.bundle,
      item_key: line.item_key,
      ja: line.source,
      zh: line.translation ?? "",
      status: line.status === "untranslated" ? "untranslated" : line.status,
      source_sha256: line.source_sha256,
      untouched: "这一行之外不允许变化",
    }))
    .join("\n") + "\n";

  const target = bundle.lines[2];
  const edited = await applyJsonlEdit(upstream, {
    item_key: target.item_key,
    source_sha256: target.source_sha256,
    value: "改过的译文",
  });

  const before = upstream.split("\n");
  const after = edited.text.split("\n");
  assert.equal(before.length, after.length, "行数不能变");
  for (let index = 0; index < before.length; index += 1) {
    if (index === edited.lineNumber - 1) continue;
    assert.equal(after[index], before[index], `第 ${index + 1} 行被改动了`);
  }
  const parsed = JSON.parse(after[edited.lineNumber - 1]);
  assert.equal(parsed.zh, "改过的译文");
  assert.equal(parsed.ja, target.source, "日文源文不能被改动");
  assert.equal(parsed.untouched, "这一行之外不允许变化");
});

// ------------------------------------------------------------------ 5. 真的能被静态服务器取到

async function withServer(fn) {
  const server = createStaticServer({ root: siteDir });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

try {
  await withServer(async (base) => {
    const targets = [
      ["/", "text/html"],
      ["/app.js", "text/javascript"],
      ["/app.css", "text/css"],
      ["/lib/data.js", "text/javascript"],
      ["/lib/taxonomy.js", "text/javascript"],
      ["/lib/github-write.js", "text/javascript"],
      ["/lib/ai-draft.js", "text/javascript"],
      ["/lib/terms.js", "text/javascript"],
      ["/data/portal.json", "application/json"],
      ["/data/images.json", "application/json"],
    ];
    for (const category of portal.categories) targets.push([`/data/catalogue/${category.id}.json`, "application/json"]);
    for (const category of portal.categories) {
      const index = JSON.parse(readFileSync(join(siteDir, "data", `catalogue/${category.id}.json`), "utf8"));
      for (const bundle of index.bundles) targets.push([`/data/${bundle.file}`, "application/json"]);
    }

    const failures = [];
    for (const [path, expectedType] of targets) {
      const response = await fetch(`${base}${path}`);
      if (!response.ok) {
        failures.push(`${path} -> ${response.status}`);
        continue;
      }
      const type = response.headers.get("content-type") || "";
      if (!type.includes(expectedType)) failures.push(`${path} -> content-type ${type}`);
    }
    ok(`静态服务器能取到页面用到的全部 ${targets.length} 个地址`, () => assert.deepEqual(failures, []));

    const traversal = await fetch(`${base}/../package.json`);
    ok("路径穿越被拒绝", () => assert.equal(traversal.status, 404));

    const html = await (await fetch(`${base}/`)).text();
    ok("首页就是新的查阅页", () => {
      assert.ok(html.includes("翻译查阅站"));
      assert.ok(!html.includes("提案与 PR"));
    });
  });
} catch (error) {
  process.exitCode = 1;
  process.stdout.write(`FAIL 静态服务器用例无法运行：${error.message}\n`);
}

process.stdout.write(`\nstatic site contract ${passed} checks ${process.exitCode ? "FAILED" : "PASS"}\n`);
