// CI 的"要不要重新生成"判断契约。自托管（2026-10-10）之后这条流水线只剩手动触发，
// 但跳过判断本身还在用，所以这里同时守着两件事：
//   1. 自动触发不许被加回来（加回来就会重新开始拉上游、传产物）；
//   2. 判断逻辑一旦退化（比如读不到标记却当成"没变"）必须红。
//
// 对应实现：scripts/ci_decide.mjs + .github/workflows/portal.yml

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { decideBuild, deployedMatches, pushNeedsBuild } from "../scripts/ci_decide.mjs";
import { gitHeadOf } from "../scripts/build_data.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`ok   ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`FAIL ${name}\n     ${error.message}\n`);
  }
}

const workflow = readFileSync(join(root, ".github/workflows/portal.yml"), "utf8");
const DEPLOYED = {
  sources: {
    assets: { head: "a".repeat(40) },
    client: { head: "b".repeat(40) },
    portal: { commit: "c".repeat(40) },
  },
};
const UPSTREAM = { assets: "a".repeat(40), client: "b".repeat(40) };

ok("push 只改文档/测试 → 不重建（验证照跑）", () => {
  assert.equal(pushNeedsBuild(["docs/GITHUB-TOKEN.md"]).build, false);
  assert.equal(pushNeedsBuild(["README.md", "test/test_generator.mjs"]).build, false);
  assert.equal(pushNeedsBuild(["test_helpers/fixtures/README.md"]).build, false);
});

ok("push 动了站点输入 → 重建，且原因写清是哪个文件", () => {
  for (const file of ["public/app.js", "public/lib/data.js", "scripts/build_data.mjs", "package.json", ".github/workflows/portal.yml"]) {
    const decision = pushNeedsBuild([file, "README.md"]);
    assert.equal(decision.build, true, `${file} 应当触发重建`);
    assert.ok(decision.reason.includes(file), "原因里应当点名是哪个文件");
  }
});

ok("拿不到改动清单（首次推送/强推）→ 保守重建", () => {
  assert.equal(pushNeedsBuild([]).build, true);
  assert.equal(pushNeedsBuild(null).build, true);
});

ok("定时/手动：上游 HEAD 与本仓 commit 都没变 → 跳过", () => {
  const decision = decideBuild({ event: "schedule", deployed: DEPLOYED, upstream: UPSTREAM, portalCommit: "c".repeat(40) });
  assert.equal(decision.build, false);
  assert.match(decision.reason, /复用/);
});

ok("定时/手动：任一项变了 → 重建", () => {
  const base = { event: "schedule", deployed: DEPLOYED, upstream: UPSTREAM, portalCommit: "c".repeat(40) };
  assert.equal(decideBuild({ ...base, upstream: { ...UPSTREAM, assets: "z".repeat(40) } }).build, true);
  assert.equal(decideBuild({ ...base, upstream: { ...UPSTREAM, client: "z".repeat(40) } }).build, true);
  assert.equal(decideBuild({ ...base, portalCommit: "z".repeat(40) }).build, true);
});

ok("读不到标记/字段缺失 → 一律重建，绝不因为读不到就漏更新", () => {
  const base = { event: "schedule", upstream: UPSTREAM, portalCommit: "c".repeat(40) };
  assert.equal(decideBuild({ ...base, deployed: null }).build, true, "线上取不到 portal.json");
  assert.equal(deployedMatches({ deployed: {}, upstream: UPSTREAM, portalCommit: "c" }).match, false, "旧产物没有 head 字段");
  assert.equal(
    decideBuild({ ...base, deployed: DEPLOYED, upstream: { assets: "", client: "b".repeat(40) } }).build,
    true,
    "这次构建拿不到上游 HEAD",
  );
  assert.equal(
    decideBuild({ ...base, deployed: DEPLOYED, portalCommit: "" }).build,
    true,
    "没传 --portal-commit",
  );
});

ok("force 一律重建（手动触发时想强制刷新的情况）", () => {
  const decision = decideBuild({ event: "workflow_dispatch", force: true, deployed: DEPLOYED, upstream: UPSTREAM, portalCommit: "c".repeat(40) });
  assert.equal(decision.build, true);
  assert.match(decision.reason, /force/);
});

ok("比的是克隆到的 HEAD，不是清单里的内容 commit", () => {
  // 拿内容 commit 去比分支 HEAD 会永远判定"变了"，这正是先踩过的坑
  assert.match(workflow, /sources\.\*\.head|sources\.assets\.head/);
  const decision = decideBuild({
    event: "schedule",
    deployed: { sources: { assets: { head: "a".repeat(40) }, client: { head: "b".repeat(40) }, portal: { commit: "c".repeat(40) } } },
    upstream: UPSTREAM,
    portalCommit: "c".repeat(40),
  });
  assert.equal(decision.build, false);
});

ok("workflow：build 与 deploy 都受 check 门控", () => {
  assert.match(workflow, /^ {2}check:/m, "要有 check 任务");
  assert.match(workflow, /^ {4}outputs:\n {6}build: \$\{\{ steps\.decide\.outputs\.build \}\}/m, "check 要输出 build");
  assert.equal((workflow.match(/if: needs\.check\.outputs\.build == 'true'/g) || []).length, 2, "build 和 deploy 各要一处门控");
  assert.match(workflow, /^ {2}build:\n {4}needs: \[check, verify\]/m, "build 要等 check 与 verify");
  assert.match(workflow, /^ {2}deploy:\n {4}needs: \[check, build\]/m, "deploy 要等 check 与 build");
  assert.match(workflow, /^ {2}verify:\n/m, "verify 始终跑，不能也被门控");
});

ok("workflow：自动触发已停用，只剩手动（自托管后不再自动构建与发布）", () => {
  // 2026-10-10 起站点自托管，这条流水线只在手动触发时跑。自动触发一旦被加回来，
  // 就会重新开始拉几百 MB 上游、上传几百 MB 产物 —— 这里必须红。
  const onBlock = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));
  assert.equal(/^\s{2}push:/m.test(onBlock), false, "不该再有 push 触发");
  assert.equal(/^\s{2}schedule:/m.test(onBlock), false, "不该再有定时触发");
  assert.match(onBlock, /^\s{2}workflow_dispatch:/m, "手动触发要保留");
  assert.match(onBlock, /force:/, "手动触发要保留 force");
});

ok("workflow：手动触发有 force，且旧任务会被顶掉、每个任务有超时", () => {
  assert.match(workflow, /workflow_dispatch:\n {4}inputs:\n {6}force:/);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.ok((workflow.match(/timeout-minutes:/g) || []).length >= 4, "四个任务都要有超时上限");
});

ok("workflow：构建时把本仓 commit 写进产物（下次跳过判断的依据）", () => {
  assert.match(workflow, /--portal-commit "\$GITHUB_SHA"/);
});

ok("gitHeadOf：真仓库能读到 HEAD，没有 git/目录不存在时返回空串而不是抛错", () => {
  const head = gitHeadOf(root);
  assert.match(head, /^[0-9a-f]{40}$/);
  const tmp = mkdtempSync(join(tmpdir(), "ci-decide-"));
  try {
    assert.equal(gitHeadOf(tmp), "", "非 git 目录应当返回空串");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  assert.equal(gitHeadOf(""), "");
  assert.equal(gitHeadOf(join(root, "这个目录不存在")), "");
});

ok("生成器把 head 与 portal.commit 写进 portal.json", () => {
  const fixture = join(root, "local-data", "ci-decide-fx");
  rmSync(fixture, { recursive: true, force: true });
  try {
    execFileSync(
      process.execPath,
      [
        join(root, "scripts/build_data.mjs"),
        "--assets-root", join(root, "test_helpers/fixtures/assets-repo"),
        "--client-root", join(root, "test_helpers/fixtures/client-repo"),
        "--out", fixture,
        "--generated-at", "2026-01-01T00:00:00Z",
        "--portal-commit", "0123456789abcdef0123456789abcdef01234567",
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const portal = JSON.parse(readFileSync(join(fixture, "portal.json"), "utf8"));
    assert.match(portal.sources.assets.head, /^[0-9a-f]{40}$/);
    assert.match(portal.sources.client.head, /^[0-9a-f]{40}$/);
    assert.equal(portal.sources.portal.commit, "0123456789abcdef0123456789abcdef01234567");
    assert.equal(portal.sources.portal.repo, "kohakunamori/MLTDTranslationPortal");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

process.stdout.write(`\nci decide contract ${passed + failed} checks ${failed ? "FAILED" : "PASS"}\n`);
process.exitCode = failed ? 1 : 0;
