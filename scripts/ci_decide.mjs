#!/usr/bin/env node
// CI 的"要不要重建/重新部署"判断。目标：上游没变、站点代码没变时，一个字节都不重新拉、不重新传。
//
// 判断规则（三条，按顺序）：
//   1. `--force`（手动触发时勾 force）→ 一律重建。
//   2. push 事件 → 看这次推送改了哪些文件：动了 `public/**`、`scripts/**`、`package.json`、
//      工作流本身才重建；只改 docs/tests 就跳过（验证 job 照常跑，只是不重新生成数据）。
//   3. 定时/手动 → 拿"线上已发布的 portal.json"当缓存标记：里面的两个上游 commit
//      加上本仓 commit 与现在要构建的三者完全一致 → 跳过；任一不同、或者线上压根取不到
//      （首次部署、Pages 抖了）→ 老老实实重建。也就是说：永远不会因为"读不到标记"而漏更新。
//
// 用法：
//   node scripts/ci_decide.mjs --self-test                       # 跑内置用例
//   node scripts/ci_decide.mjs --event push --changed <file>...   # 本地看某次推送的结论
//   node scripts/ci_decide.mjs --event schedule                   # 真的去问上游与线上（网络）
// CI 里通过 `--github-output` 写 build/reason 到 $GITHUB_OUTPUT。

import { readFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/// 这些路径动了才需要重新生成数据并部署；其余（docs/、test/、README……）只跑测试。
export const SITE_PATH_RE = /^(public\/|scripts\/|package\.json$|\.github\/workflows\/portal\.yml$)/;

/// 判断一次 push 是否需要重建。`before` 为空（首次推送/强推）时保守重建。
export function pushNeedsBuild(changedFiles) {
  const files = (changedFiles || []).filter(Boolean);
  if (files.length === 0) return { build: true, reason: "拿不到本次推送的文件清单（首次推送或强推？），保守重建" };
  const hit = files.find((file) => SITE_PATH_RE.test(file));
  if (hit) return { build: true, reason: `本次推送动了站点输入（${hit}）` };
  return { build: false, reason: `本次推送只动了 ${files.length} 个非站点文件（docs/tests 等），不需要重新生成数据` };
}

/// 比较"线上已发布的那份"和"现在要构建的那份"。缺字段一律视为不一致。
///
/// 比的是**实际克隆到的 HEAD**（`sources.*.head`），不是清单里的内容 commit ——
/// 后者是上游生成清单时记录的提交，跟分支 HEAD 天生不同，拿它比会永远判定"变了"。
export function deployedMatches({ deployed, upstream, portalCommit }) {
  if (!deployed) return { match: false, why: "线上没有能读到的 portal.json（首次部署或 Pages 暂时不可用）" };
  const pairs = [
    ["sources.assets.head", deployed?.sources?.assets?.head, upstream?.assets],
    ["sources.client.head", deployed?.sources?.client?.head, upstream?.client],
    ["sources.portal.commit", deployed?.sources?.portal?.commit, portalCommit],
  ];
  for (const [label, was, now] of pairs) {
    if (!now) return { match: false, why: `这次构建的 ${label} 是空的（拿不到上游 HEAD / 没传 --portal-commit），无法确认是否一致` };
    if (!was) return { match: false, why: `线上 portal.json 没有 ${label}（旧产物），需要重建一次` };
    if (String(was) !== String(now)) return { match: false, why: `${label} 变了：线上 ${String(was).slice(0, 12)}… → 现在 ${String(now).slice(0, 12)}…` };
  }
  return { match: true, why: "上游两个仓的 HEAD 与本仓 commit 都和线上一致，直接复用已发布的产物" };
}

/// 把三件事合起来：force > push 规则 > 线上比对。
export function decideBuild({ event, changedFiles, force, deployed, upstream, portalCommit }) {
  if (force) return { build: true, reason: "手动触发了 force，强制重建" };
  if (event === "push") return pushNeedsBuild(changedFiles);
  const compared = deployedMatches({ deployed, upstream, portalCommit });
  return { build: !compared.match, reason: compared.why };
}

/* ------------------------------------------------------------------ CLI */

function gitRemoteCommit(remote, ref) {
  const url = /^https?:\/\//.test(remote) ? remote : `https://github.com/${remote}.git`;
  const out = execFileSync("git", ["ls-remote", url, ref], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const sha = (out.split("\n").find((line) => line.trim()) || "").split(/\s+/)[0] || "";
  return sha.toLowerCase();
}

async function fetchDeployed(url) {
  try {
    const response = await fetch(url, { headers: { "cache-control": "no-cache" } });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function main(argv) {
  const args = { event: "schedule", changed: [], force: false, deployedUrl: "", assets: "", client: "", portalCommit: process.env.GITHUB_SHA || "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force") { args.force = true; continue; }
    if (arg === "--self-test") { args.selfTest = true; continue; }
    if (arg === "--github-output") { args.githubOutput = true; continue; }
    const key = {
      "--event": "event",
      "--changed": "changedFiles",
      "--deployed-url": "deployedUrl",
      "--assets": "assets",
      "--client": "client",
      "--portal-commit": "portalCommit",
      "--upstream": "upstream",
    }[arg];
    if (!key) {
      process.stderr.write(`未知参数 ${arg}\n`);
      return 1;
    }
    if (key === "changedFiles") { args.changed.push(argv[index + 1]); index += 1; continue; }
    if (key === "upstream") { args.upstream = argv[index + 1]; index += 1; continue; }
    args[key] = argv[index + 1];
    index += 1;
  }

  if (args.selfTest) return selfTest();

  // push 事件完全不用碰网络：只看这次推送动了什么。`--changed` 优先，否则读 CHANGED_FILES。
  let changedFiles = args.changed;
  if (args.event === "push" && changedFiles.length === 0 && process.env.CHANGED_FILES) {
    changedFiles = process.env.CHANGED_FILES.split("\n").map((line) => line.trim()).filter(Boolean);
  }
  if (args.event === "push" && !args.force) return report(pushNeedsBuild(changedFiles), args);

  const upstream = args.upstream
    ? JSON.parse(args.upstream)
    : { assets: gitRemoteCommit(args.assets, "main"), client: gitRemoteCommit(args.client, "main") };
  const deployed = args.deployedUrl ? await fetchDeployed(args.deployedUrl) : null;
  return report(decideBuild({ ...args, changedFiles, upstream, deployed }), args);
}

function report(decision, args) {
  process.stdout.write(`build=${decision.build} reason=${decision.reason}\n`);
  if (args.githubOutput && process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `build=${decision.build}\nreason=${decision.reason}\n`);
  }
  return 0;
}

function selfTest() {
  const cases = [
    [{ event: "push", changedFiles: ["public/app.js"] }, true],
    [{ event: "push", changedFiles: ["scripts/build_data.mjs"] }, true],
    [{ event: "push", changedFiles: [".github/workflows/portal.yml"] }, true],
    [{ event: "push", changedFiles: ["docs/GITHUB-TOKEN.md"] }, false],
    [{ event: "push", changedFiles: ["test/test_generator.mjs", "README.md"] }, false],
    [{ event: "push", changedFiles: [] }, true],
    [{ event: "workflow_dispatch", force: true }, true],
    [
      { event: "schedule", deployed: { sources: { assets: { head: "a" }, client: { head: "b" }, portal: { commit: "c" } } }, upstream: { assets: "a", client: "b" }, portalCommit: "c" },
      false,
    ],
    [
      { event: "schedule", deployed: { sources: { assets: { head: "a" }, client: { head: "b" }, portal: { commit: "c" } } }, upstream: { assets: "a2", client: "b" }, portalCommit: "c" },
      true,
    ],
    [
      { event: "schedule", deployed: { sources: { assets: { head: "a" }, client: { head: "b" }, portal: { commit: "old" } } }, upstream: { assets: "a", client: "b" }, portalCommit: "c" },
      true,
    ],
    [{ event: "schedule", deployed: null, upstream: { assets: "a", client: "b" }, portalCommit: "c" }, true],
    [
      { event: "schedule", deployed: { sources: { assets: { head: "a" }, client: { head: "b" } } }, upstream: { assets: "a", client: "b" }, portalCommit: "c" },
      true,
    ],
    // 上游 HEAD 没动、但这次构建拿不到上游 HEAD（clone 失败/参数没给）→ 保守重建
    [
      { event: "schedule", deployed: { sources: { assets: { head: "a" }, client: { head: "b" }, portal: { commit: "c" } } }, upstream: { assets: "", client: "b" }, portalCommit: "c" },
      true,
    ],
  ];
  let failed = 0;
  for (const [input, expected] of cases) {
    const actual = decideBuild(input).build;
    if (actual !== expected) {
      failed += 1;
      process.stdout.write(`FAIL ${JSON.stringify(input)} → ${actual}，期望 ${expected}\n`);
    }
  }
  process.stdout.write(failed === 0 ? `ci_decide self-test ${cases.length} cases PASS\n` : `ci_decide self-test FAILED (${failed}/${cases.length})\n`);
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
