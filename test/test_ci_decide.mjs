// "要不要重新生成"判断契约。GitHub Pages 部署流水线已于 2026-10-19 删除
// （生产站托管在仓外），这里只保留判断逻辑本身的单元测试，以及站点数据契约：
//   1. 判断逻辑一旦退化（比如读不到标记却当成"没变"）必须红；
//   2. build_data 写出的 portal.json 必须带上三个来源的 HEAD 与 commit。
//
// 对应实现：scripts/ci_decide.mjs

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
  for (const file of ["public/app.js", "public/lib/data.js", "scripts/build_data.mjs", "package.json"]) {
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
  const decision = decideBuild({
    event: "schedule",
    deployed: { sources: { assets: { head: "a".repeat(40) }, client: { head: "b".repeat(40) }, portal: { commit: "c".repeat(40) } } },
    upstream: UPSTREAM,
    portalCommit: "c".repeat(40),
  });
  assert.equal(decision.build, false);
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
