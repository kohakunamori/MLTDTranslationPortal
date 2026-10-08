// 生成器契约测试：用 test_helpers/fixtures 里的合成上游仓跑真实的 buildOutputs()，
// 断言输出文件的内容、计数、分页、编辑绑定、对账、确定性与失败模式。
//
// fixture 刻意复刻了真实上游的几处"坑"：
//   - 每个 bundle 只属于一个分类，活动对话单独成 bundle
//   - 行里的 asset_version 比发布版本落后一档（1077500 vs 1077710）
//   - lyrics 行没有 item_key / asset_version，身份是数字 index
//   - lyrics/all_lyrics.jsonl 把每首歌复制一遍
//   - official-<release>-untranslated.jsonl 用发布版本重写了一行（更新的译文）
//   - 一个比发布版本更新的行（9999999）必须被跳过
//
// 运行：node test/test_generator.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { BuildError, buildOutputs, displayStatus, main, renderDocument, rowStatus, sourceNeedsTranslation } from "../scripts/build_data.mjs";
import { CATEGORY_ORDER } from "../public/lib/taxonomy.js";

const FIXTURE_ASSETS = "test_helpers/fixtures/assets-repo";
const FIXTURE_CLIENT = "test_helpers/fixtures/client-repo";
const STAMP = "2026-01-01T00:00:00Z";
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

let passed = 0;
const pendingCases = [];

/// 同步用例：断言立刻执行，计数立刻确定。
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

/// 需要 await 的用例（CLI 退出码等）：收集起来，最后统一等待。
function okAsync(name, fn) {
  pendingCases.push((async () => {
    try {
      await fn();
      passed += 1;
      process.stdout.write(`ok   ${name}\n`);
    } catch (error) {
      process.stdout.write(`FAIL ${name}\n     ${error.message}\n`);
      process.exitCode = 1;
    }
  })());
}

const workDir = mkdtempSync(join(tmpdir(), "portal-gen-"));
process.on("exit", () => rmSync(workDir, { recursive: true, force: true }));

function build(overrides = {}) {
  return buildOutputs({
    assetsRoot: FIXTURE_ASSETS,
    clientRoot: FIXTURE_CLIENT,
    generatedAt: STAMP,
    out: join(workDir, "out"),
    ...overrides,
  });
}

const parse = (result, file) => JSON.parse(result.files.get(file));
const linesOf = (result, file) => parse(result, file).lines;

const result = build();
const portal = parse(result, "portal.json");

// ------------------------------------------------------------------ 汇总

ok("portal.json 版本与来源", () => {
  assert.equal(portal.schema_version, 1);
  assert.equal(portal.generated_at, STAMP);
  assert.equal(portal.sources.assets.repo, "kohakunamori/MLTDTranslationAssets");
  assert.equal(portal.sources.assets.ref, "main");
  assert.equal(portal.sources.assets.commit, "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2");
  assert.equal(portal.releases.assets.asset_version, "1077710");
  assert.equal(portal.releases.client.client_version, "9.0.200");
});

ok("portal.json 计数与进度", () => {
  assert.deepEqual(
    { total: portal.totals.total, translated: portal.totals.translated, pending: portal.totals.pending, untranslated: portal.totals.untranslated, not_needed: portal.totals.not_needed },
    { total: 31, translated: 27, pending: 1, untranslated: 2, not_needed: 1 },
  );
  assert.equal(portal.totals.bundles, 8, "8 个唯一资源：5 个 locales + 2 首歌 + 1 个客户端清单");
  assert.equal(portal.totals.files, 8, "没有超过单页上限的 bundle，所以文件数 = 资源数");
  // 进度分母是"需要译文的行"：31 行里有 1 行原文非日文（"Fire Flower！"），所以是 27/30
  assert.equal(portal.totals.progress_percent, 90);
});

ok("原文非日文且没有译文 → 无需翻译（英文歌词不再算未翻译）", () => {
  // 真实数据里 1,066 行"未翻译"全是英文歌词，上游 status 也写着 untranslated，
  // 所以这是本站的判定：没有日文可译就不该占着"未翻译"。
  for (const english of ["Show goes on", "Make me happy Yeah Yeah Yeah Yeah ", "We are LEGEND DAYS!", "♪♪", "1234", "Thank you！", "Fire Flower！", "ＨＥＬＬＯ", "Let\u2019s get going!"]) {
    assert.equal(sourceNeedsTranslation(english), false, `"${english}" 不该被当成需要翻译`);
  }
  for (const japanese of ["ありがとう", "キラメキ", "ヴィクトリー", "歌", "私の声"]) {
    assert.equal(sourceNeedsTranslation(japanese), true, `"${japanese}" 需要译文`);
  }
  // 别的语言不能被当成英文放过
  for (const other of ["Привет", "안녕", "Γειά"]) {
    assert.equal(sourceNeedsTranslation(other), true, `"${other}" 不是英文，需要译文`);
  }

  assert.equal(displayStatus({ ja: "Show goes on", status: "untranslated" }, ""), "not_needed");
  assert.equal(displayStatus({ ja: "ありがとう", status: "untranslated" }, ""), "untranslated");
  // 有译文就是已翻译/待确认，跟原文语言无关
  assert.equal(displayStatus({ ja: "Show goes on", status: "accepted" }, "继续前进"), "accepted");
  assert.equal(displayStatus({ ja: "Show goes on", status: "pending" }, "继续前进"), "pending");
  // 上游 status 语义本身不变
  assert.equal(rowStatus({ status: "untranslated" }, ""), "untranslated");
  assert.equal(rowStatus({ status: "accepted" }, ""), "untranslated", "没有译文就不算已确认");
});
ok("domain / category 计数自洽", () => {
  const sum = (items, field) => items.reduce((total, item) => total + item[field], 0);
  assert.equal(sum(portal.categories, "total"), portal.totals.total);
  assert.equal(sum(portal.categories, "translated"), portal.totals.translated);
  assert.equal(sum(portal.domains, "total"), portal.totals.total);
  for (const category of portal.categories) {
    const index = parse(result, `catalogue/${category.id}.json`);
    assert.equal(index.total_bundles, category.bundles, `${category.id} 的索引条数与 portal 不一致`);
    assert.equal(index.bundles.reduce((total, bundle) => total + bundle.total, 0), category.total, `${category.id} 的索引行数与 portal 不一致`);
    assert.equal(index.bundles.reduce((total, bundle) => total + bundle.pages.length, 0), category.files, `${category.id} 的页数与 portal 不一致`);
  }
  assert.equal(sum(portal.categories, "files"), portal.totals.files);
});

ok("分类顺序固定为 taxonomy 顺序", () => {
  assert.deepEqual(portal.categories.map((category) => category.id), CATEGORY_ORDER);
});

// ------------------------------------------------------------------ 版本轴与去重

ok("比发布版本更新的行被跳过并产生警告", () => {
  const warning = result.warnings.find((line) => line.includes("9999999"));
  assert.ok(warning, "应当有跳过 9999999 的警告");
  assert.match(warning, /比发布版本 1077710 更新/);
  assert.equal(result.files.has("bundles/system_ui/legacy_ui.gtx.json"), false, "被跳过的行不该产出文件");
});

ok("落后一档的 asset_version 属于本次发布，不该被丢掉", () => {
  const card = parse(result, "bundles/card_episode/card_episode_014mir_01.gtx.json");
  assert.equal(card.asset_version, "1077710", "记录里写的是发布版本");
  assert.equal(card.total_lines, 3, "1077500 的行必须留下");
});

ok("同一 item_key 出现在多个文件时保留版本更新的那一行", () => {
  const ui = parse(result, "bundles/system_ui/ui_common.gtx.json");
  const updated = ui.lines.find((line) => line.item_key === "ui_common_0003");
  assert.equal(updated.translation, "就如同挥手道别一般（新版本）", "1077710 的新译文必须赢过 1077500 的旧译文");
  assert.equal(updated.status, "accepted");
  assert.equal(ui.total_lines, 3, "仍然只有 3 行（去重，不是叠加）");

  const note = result.notes.find((line) => line.includes("重复副本"));
  assert.ok(note, "去重要留下一条说明");
  assert.match(note, /15 行/, "14 行歌词副本 + 1 行增量覆盖");
  assert.match(note, /1 行内容因此被更新的版本覆盖/);
});

ok("编辑绑定指向权威文件，例外行自带 edit_path", () => {
  const lyrics = parse(result, "bundles/lyrics/scrobj_smile1.json");
  assert.equal(lyrics.edit.path, "lyrics/songs/scrobj_smile1.unity3d.jsonl");
  assert.equal(lyrics.edit.identity_field, "index", "歌词行的身份是 index，不是 item_key");
  assert.equal(lyrics.lines.every((line) => line.edit_path === undefined), true, "歌词行都在权威文件里");

  const ui = parse(result, "bundles/system_ui/ui_common.gtx.json");
  assert.equal(ui.edit.path, "locales/master/ui_common.gtx.jsonl", "文件级写路径必须是权威文件，不能是 official-*.jsonl");
  assert.equal(ui.edit.identity_field, "item_key");
  const delta = ui.lines.find((line) => line.item_key === "ui_common_0003");
  assert.equal(delta.edit_path, "locales/master/official-1077710-untranslated.jsonl", "增量行必须指向它真正住着的文件");
  assert.equal(ui.lines.filter((line) => line.edit_path).length, 1, "只有那一行需要覆盖写路径");
  assert.equal(ui.repo_path, "locales/master/ui_common.gtx.jsonl", "记录级的 repo_path 同样是权威文件");
});

ok("清单里的 bundle->分类 是权威，且与名字规则不冲突", () => {
  // fixture 清单把 event_chat 单独列为一个 bundle，名字规则也这么说，所以不该有冲突警告
  assert.equal(result.warnings.some((line) => line.includes("名字规则与清单分类不一致")), false);
  const story = parse(result, "catalogue/event_story.json");
  const chat = parse(result, "catalogue/event_chat.json");
  assert.deepEqual(story.bundles.map((bundle) => bundle.bundle), ["event_10001_01.gtx"]);
  assert.deepEqual(chat.bundles.map((bundle) => bundle.bundle), ["event_10001_01_chat.gtx"]);
  // 歌词不在 assets 清单里，只能靠名字规则
  const note = result.notes.find((line) => line.includes("不在清单"));
  assert.ok(note && /2 个 bundle/.test(note), "歌词 2 个 bundle 按名字规则判定");
});

// ------------------------------------------------------------------ 对账

ok("对账能发现'清单里有、生成器没产出'的行", () => {
  const systemUi = result.warnings.find((line) => line.includes("分类 system_ui 行数不一致"));
  assert.ok(systemUi, "legacy_ui 那一行在清单里但被跳过了，必须报出来");
  assert.match(systemUi, /生成 3，清单 5（去重 1 行后应为 4）/);
  const total = result.warnings.find((line) => line.includes("assets 轴总行数不一致"));
  assert.ok(total, "总账也要对不上");
  assert.match(total, /合计 16（含去重 15 行），清单 totals 是 17/);
});

ok("把清单里那一行去掉之后，对账完全干净", () => {
  // 复制一份 fixture，把 legacy_ui.gtx 从清单里删掉，模拟"清单与数据完全一致"的正常情况
  const root = join(workDir, "clean");
  cpSync(FIXTURE_ASSETS, join(root, "assets"), { recursive: true });
  const manifestPath = join(root, "assets", "manifests", "portal-resource-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const category of manifest.categories) {
    delete category.bundles["legacy_ui.gtx"];
  }
  manifest.totals.total -= 1;
  manifest.totals.translated -= 1;
  const systemUi = manifest.categories.find((category) => category.id === "system_ui");
  systemUi.bundles["ui_common.gtx"].total -= 1;
  systemUi.bundles["ui_common.gtx"].translated -= 1;
  systemUi.total -= 1;
  systemUi.translated -= 1;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  const clean = buildOutputs({ assetsRoot: join(root, "assets"), clientRoot: FIXTURE_CLIENT, generatedAt: STAMP, out: join(root, "out") });
  const reconciliation = clean.warnings.filter((line) => line.startsWith("对账"));
  assert.deepEqual(reconciliation, [], `不该再有对账警告：${reconciliation.join(" / ")}`);
  assert.equal(clean.portal.totals.total, 31);
});

// ------------------------------------------------------------------ 行级内容

ok("每一行的 source_sha256 与 source 自洽，身份唯一", () => {
  for (const category of portal.categories) {
    const index = parse(result, `catalogue/${category.id}.json`);
    for (const bundle of index.bundles) {
      const keys = new Set();
      for (const page of bundle.pages) {
        const content = parse(result, page.file);
        for (const line of content.lines) {
          assert.equal(line.source_sha256, sha256(line.source), `${page.file} 的 ${line.item_key} 哈希不一致`);
          assert.ok(!keys.has(line.item_key), `${page.file} 的 item_key ${line.item_key} 重复`);
          keys.add(line.item_key);
          assert.ok(["accepted", "pending", "untranslated", "not_needed"].includes(line.status));
        }
      }
      assert.equal(keys.size, bundle.total, `${bundle.bundle} 的行数对不上索引`);
    }
  }
});

ok("歌词行按槽位排序，且槽位就是上游 index", () => {
  const lyrics = parse(result, "bundles/lyrics/scrobj_smile1.json");
  assert.equal(lyrics.slot_based, true);
  assert.deepEqual(lyrics.lines.map((line) => line.slot_index), [85, 148, 191, 248, 309, 363, 444, 516, 589, 668]);
  assert.deepEqual(lyrics.lines.map((line) => line.item_key), ["85", "148", "191", "248", "309", "363", "444", "516", "589", "668"]);
});

ok("歌词索引带 SONG_MASTER 曲名", () => {
  const index = parse(result, "catalogue/lyrics.json");
  const smile = index.bundles.find((bundle) => bundle.bundle === "scrobj_smile1.unity3d");
  assert.equal(smile.song.name_ja, "スマイルいちばん");
  assert.equal(smile.song.name_zh, "最棒的笑容");
  assert.equal(smile.slot_based, true);
});

ok("非歌词行保持上游文件行序", () => {
  const story = parse(result, "bundles/main_commu/st_014mir_01.gtx.json");
  assert.equal(story.slot_based, false);
  assert.deepEqual(story.lines.map((line) => line.line), [1, 2, 3, 4, 5], "按上游文件行号");
  assert.deepEqual(story.lines.map((line) => line.index), [1, 2, 3, 4, 5], "展示序号从 1 连续编号");
});

ok("状态由「有没有译文」决定", () => {
  assert.equal(rowStatus({ status: "accepted" }, ""), "untranslated", "没译文就不能是 accepted");
  assert.equal(rowStatus({ status: "accepted" }, "有"), "accepted");
  assert.equal(rowStatus({ status: "needs_review" }, "有"), "pending");
  assert.equal(rowStatus({ status: "weird" }, "有"), "untranslated");

  const chat = parse(result, "bundles/event_chat/event_10001_01_chat.gtx.json");
  const empty = chat.lines.find((line) => line.translation === null);
  assert.equal(empty.status, "untranslated");
});

ok("偶像归属从 bundle / 源文推出来", () => {
  const story = parse(result, "bundles/main_commu/st_014mir_01.gtx.json");
  assert.equal(story.idol.code, "014mir");
  assert.equal(story.idol.name_ja, "春日未来");
});

// ------------------------------------------------------------------ 分页

ok("巨型 bundle 按页切开，索引里仍是一个资源", () => {
  const paged = build({ maxRowsPerPage: 2 });
  const index = parse(paged, "catalogue/lyrics.json");
  const smile = index.bundles.find((bundle) => bundle.bundle === "scrobj_smile1.unity3d");
  assert.equal(smile.total, 10);
  assert.equal(smile.page_count, 5, "10 行 / 每页 2 行 = 5 页");
  assert.equal(smile.pages.length, 5);
  assert.equal(smile.file, "bundles/lyrics/scrobj_smile1.p1.json");
  assert.deepEqual(smile.pages.map((page) => page.file), [
    "bundles/lyrics/scrobj_smile1.p1.json",
    "bundles/lyrics/scrobj_smile1.p2.json",
    "bundles/lyrics/scrobj_smile1.p3.json",
    "bundles/lyrics/scrobj_smile1.p4.json",
    "bundles/lyrics/scrobj_smile1.p5.json",
  ]);
  assert.deepEqual(smile.pages.map((page) => [page.first_index, page.last_index]), [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]]);
  assert.equal(smile.pages.reduce((sum, page) => sum + page.total, 0), smile.total);

  // 先排序再切页：第 3 页是第 5、6 行，槽位必须是全局有序的那两个
  const first = parse(paged, smile.pages[0].file);
  const third = parse(paged, smile.pages[2].file);
  assert.deepEqual(first.lines.map((line) => line.index), [1, 2]);
  assert.deepEqual(third.lines.map((line) => line.index), [5, 6]);
  assert.deepEqual(third.lines.map((line) => line.slot_index), [309, 363]);
  assert.equal(third.page, 3);
  assert.equal(third.page_count, 5);
  assert.equal(third.edit.identity_field, "index", "分页不影响写路径");
  assert.equal(first.edit.path, "lyrics/songs/scrobj_smile1.unity3d.jsonl");

  // 没超上限的 bundle 保持单文件、单页（用默认页大小的构建来看）
  const single = parse(result, "bundles/system_ui/ui_common.gtx.json");
  assert.equal(single.page, null);
  assert.equal(single.page_count, 1);
  const singleIndex = parse(result, "catalogue/system_ui.json").bundles.find((bundle) => bundle.bundle === "ui_common.gtx");
  assert.equal(singleIndex.page_count, 1);
  assert.equal(singleIndex.pages.length, 1);
  assert.equal(singleIndex.pages[0].file, "bundles/system_ui/ui_common.gtx.json");
  assert.equal(singleIndex.pages[0].page, null);
  assert.equal(singleIndex.pages[0].first_index, 1);
  assert.equal(singleIndex.pages[0].last_index, 3);
});

ok("--max-rows-per-page 必须是正整数", () => {
  for (const bad of ["0", "-3", "abc", "2.5"]) {
    assert.throws(() => build({ maxRowsPerPage: bad }), (error) => error instanceof BuildError && /max-rows-per-page/.test(error.message));
  }
});

// ------------------------------------------------------------------ 图片

ok("图片任务读真实清单形状，中文版来自站点内的 media 路径", () => {
  const images = parse(result, "images.json");
  assert.equal(images.total, 4);
  assert.deepEqual(images.categories, { all: 4, event: 2, costume: 1, tutorial: 1 });
  assert.deepEqual(images.statuses, { all: 4, localized: 3, original_only: 1 });

  const byId = new Map(images.tasks.map((task) => [task.task_id, task]));
  const banner = byId.get("eventbanner0001.unity3d:1111111111111111111");
  assert.equal(banner.category, "event");
  assert.match(banner.category_name, /活动宣传/);
  assert.equal(banner.width, 1024);
  assert.equal(banner.height, 512);
  assert.equal(banner.localized_path, "images/localized/eventbanner0001/1111_info_01.png");
  assert.equal(banner.localized_url, "media/localized/eventbanner0001/1111_info_01.png", "站点内相对路径，不能带前导斜杠");
  assert.equal(banner.localized_file, "1111_info_01.png");
  assert.equal(banner.has_localized, true);
  // 原图只留路径与哈希作为参考，永远不给 URL
  assert.equal(banner.original_sha256, "1".repeat(64));
  assert.equal(banner.original_published, false);
  assert.equal(banner.original_url, undefined, "清单里的 distribution URL 实测 404，不许出现在数据里");

  const noLocalized = byId.get("tutorialinfo0003.unity3d:4444444444444444444");
  assert.equal(noLocalized.category, "tutorial");
  assert.equal(noLocalized.has_localized, false);
  assert.equal(noLocalized.localized_url, null);
  assert.equal(noLocalized.localized_file, null);
  assert.ok(result.notes.some((line) => line.includes("没有中文版文件")), "缺中文版文件要有说明");
});

ok("--image-base 可以把 media 指到别处", () => {
  const hosted = parse(build({ imageBase: "https://cdn.example.com/assets" }), "images.json");
  const banner = hosted.tasks.find((task) => task.task_id.startsWith("eventbanner0001"));
  assert.equal(banner.localized_url, "https://cdn.example.com/assets/media/localized/eventbanner0001/1111_info_01.png");
  assert.equal(parse(result, "images.json").tasks[0].localized_url.startsWith("media/"), true, "默认是站点内相对路径");
});

ok("图片计数对不上清单时报警", () => {
  const root = join(workDir, "imgs");
  cpSync(FIXTURE_ASSETS, join(root, "assets"), { recursive: true });
  const manifestPath = join(root, "assets", "manifests", "images.manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.counts.total_images = 99;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  const built = buildOutputs({ assetsRoot: join(root, "assets"), generatedAt: STAMP, out: join(root, "out") });
  assert.ok(built.warnings.some((line) => line.includes("图片数不一致")), "清单说 99、实际 4，必须报出来");
});

// ------------------------------------------------------------------ 输出完整性

ok("所有输出都是合法 JSON 且可 round-trip", () => {
  for (const [file, content] of result.files) {
    const value = JSON.parse(content);
    assert.equal(content, renderDocument(value), `${file} 不是 renderDocument 的结果`);
  }
});

ok("索引里的每个文件都存在，行数与索引一致", () => {
  for (const category of portal.categories) {
    for (const bundle of parse(result, `catalogue/${category.id}.json`).bundles) {
      let sum = 0;
      for (const page of bundle.pages) {
        const content = parse(result, page.file);
        assert.equal(content.total_lines, page.total, `${page.file} 行数与索引不一致`);
        assert.ok(content.lines.length === content.total_lines);
        assert.equal(content.translated + content.pending + content.untranslated + content.not_needed, content.total_lines);
        assert.ok(content.lines.every((line) => line.status !== "not_needed" || !line.translation));
        assert.equal(content.bundle, bundle.bundle);
        assert.equal(content.category, bundle.category);
        sum += content.total_lines;
      }
      assert.equal(sum, bundle.total);
    }
  }
});

ok("每个生成的文件都在某个索引里被引用（没有孤儿）", () => {
  const referenced = new Set(["portal.json", "images.json"]);
  for (const category of portal.categories) {
    referenced.add(`catalogue/${category.id}.json`);
    for (const bundle of parse(result, `catalogue/${category.id}.json`).bundles) {
      for (const page of bundle.pages) referenced.add(page.file);
    }
  }
  const orphans = [...result.files.keys()].filter((file) => !referenced.has(file));
  assert.deepEqual(orphans, []);
});

ok("没有行的分类也会产出一份空索引", () => {
  const empty = parse(result, "catalogue/birth_live.json");
  assert.equal(empty.total_bundles, 0);
  assert.deepEqual(empty.bundles, []);
});

// ------------------------------------------------------------------ 确定性

ok("同样输入产生逐字节相同的输出", () => {
  const again = build();
  assert.deepEqual([...again.files.keys()], [...result.files.keys()]);
  for (const [file, content] of result.files) assert.equal(again.files.get(file), content, `${file} 不稳定`);
});

ok("generated_at 是唯一允许变化的字段", () => {
  const moved = build({ generatedAt: "2027-02-03T04:05:06Z" });
  for (const [file, content] of result.files) {
    if (file === "portal.json") continue;
    assert.equal(moved.files.get(file), content, `${file} 不该随 generated_at 变化`);
  }
  const other = JSON.parse(moved.files.get("portal.json"));
  assert.equal(other.generated_at, "2027-02-03T04:05:06Z");
  delete other.generated_at;
  const baseline = JSON.parse(JSON.stringify(portal));
  delete baseline.generated_at;
  assert.deepEqual(other, baseline);
});

// ------------------------------------------------------------------ 失败模式

ok("复合版本轴直接报错，不静默丢行", () => {
  const root = join(workDir, "composite");
  cpSync(FIXTURE_ASSETS, join(root, "assets"), { recursive: true });
  const file = join(root, "assets", "locales", "story", "event_10001_01.gtx.jsonl");
  const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  rows[0].asset_version = "9.0.200+1077710";
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  assert.throws(
    () => buildOutputs({ assetsRoot: join(root, "assets"), generatedAt: STAMP, out: join(root, "out") }),
    (error) => error instanceof BuildError && /版本轴/.test(error.message),
  );
});

ok("source_sha256 与 ja 不一致时报错", () => {
  const root = join(workDir, "badhash");
  cpSync(FIXTURE_ASSETS, join(root, "assets"), { recursive: true });
  const file = join(root, "assets", "locales", "story", "st_014mir_01.gtx.jsonl");
  const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  rows[0].source_sha256 = "0".repeat(64);
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  assert.throws(
    () => buildOutputs({ assetsRoot: join(root, "assets"), generatedAt: STAMP, out: join(root, "out") }),
    (error) => error instanceof BuildError && /source_sha256/.test(error.message),
  );
});

ok("坏 JSON 行报错", () => {
  const root = join(workDir, "badjson");
  cpSync(FIXTURE_ASSETS, join(root, "assets"), { recursive: true });
  const file = join(root, "assets", "locales", "card", "card_episode_014mir_01.gtx.jsonl");
  writeFileSync(file, readFileSync(file, "utf8") + "{ 这不是 JSON\n", "utf8");
  assert.throws(
    () => buildOutputs({ assetsRoot: join(root, "assets"), generatedAt: STAMP, out: join(root, "out") }),
    (error) => error instanceof BuildError && /JSON 解析失败/.test(error.message),
  );
});

ok("一个数据源都没有时拒绝生成", () => {
  assert.throws(() => buildOutputs({ generatedAt: STAMP, out: join(workDir, "never") }), BuildError);
});

ok("参数错误在写盘之前就报错", () => {
  const base = { assetsRoot: FIXTURE_ASSETS, generatedAt: STAMP, out: join(workDir, "never") };
  const cases = [
    [{ assetsRepo: "no-slash" }, /assets-repo/],
    [{ assetsRepo: "owner/name/extra" }, /assets-repo/],
    [{ clientRepo: " owner/name" }, /client-repo/],
    [{ ref: "bad ref" }, /--ref/],
    [{ ref: "../main" }, /--ref/],
    [{ imageBase: "ftp://example.com" }, /image-base/],
    [{ generatedAt: "not-a-date" }, /generated-at/],
    [{ out: "  " }, /--out/],
  ];
  for (const [overrides, matcher] of cases) {
    assert.throws(
      () => buildOutputs({ ...base, ...overrides }),
      (error) => error instanceof BuildError && matcher.test(error.message),
      `${JSON.stringify(overrides)} 应该被拒绝`,
    );
  }
});

ok("缺清单时警告但不伪造 commit", () => {
  const root = join(workDir, "nomanifest");
  cpSync(FIXTURE_ASSETS, join(root, "assets"), { recursive: true });
  rmSync(join(root, "assets", "manifests"), { recursive: true, force: true });
  const built = buildOutputs({ assetsRoot: join(root, "assets"), generatedAt: STAMP, out: join(root, "out") });
  assert.ok(built.warnings.some((line) => line.includes("找不到 manifests/portal-resource-manifest.json")));
  assert.equal(built.portal.sources.assets.commit, "");
  assert.equal(built.portal.releases.assets, null);
  assert.ok(built.portal.totals.total > 0, "没有清单也要能按名字规则产出内容");
});

// ------------------------------------------------------------------ CLI

okAsync("cli 写出后所有文件都在磁盘上", async () => {
  const out = join(workDir, "cli-argv");
  assert.equal(existsSync(out), false);
  assert.equal(await main(["--assets-root", FIXTURE_ASSETS, "--client-root", FIXTURE_CLIENT, "--out", out, "--generated-at", STAMP]), 0);
  assert.ok(existsSync(join(out, "portal.json")), "portal.json 没有写出");
  assert.ok(existsSync(join(out, "images.json")), "images.json 没有写出");
  assert.ok(readdirSync(join(out, "catalogue")).length >= 15, "分类索引不全");
  assert.ok(readdirSync(join(out, "bundles", "lyrics")).length >= 2, "bundle 文件不全");
  const portalFile = JSON.parse(readFileSync(join(out, "portal.json"), "utf8"));
  assert.equal(portalFile.totals.total, 31);
});

okAsync("--check 在磁盘一致时退出 0，被改动后退出 2", async () => {
  const out = join(workDir, "check");
  const argv = ["--assets-root", FIXTURE_ASSETS, "--client-root", FIXTURE_CLIENT, "--out", out, "--generated-at", STAMP];
  assert.equal(await main(argv), 0);
  const target = join(out, "portal.json");
  const before = readFileSync(target, "utf8");
  assert.ok(before.includes("\"progress_percent\":90"), "portal.json 里应当有进度值");
  writeFileSync(target, before.replace("\"progress_percent\":90", "\"progress_percent\":91"), "utf8");
  assert.equal(await main([...argv, "--check"]), 2);
  assert.equal(await main(argv), 0);
  assert.equal(await main([...argv, "--check"]), 0);
});

okAsync("generated_at 变化不算漂移", async () => {
  const out = join(workDir, "stamp");
  const argv = ["--assets-root", FIXTURE_ASSETS, "--client-root", FIXTURE_CLIENT, "--out", out];
  assert.equal(await main([...argv, "--generated-at", "2026-01-01T00:00:00Z"]), 0);
  assert.equal(await main([...argv, "--generated-at", "2030-12-31T23:59:59Z", "--check"]), 0);
});

okAsync("--strict 把警告变成失败", async () => {
  const out = join(workDir, "strict");
  const argv = ["--assets-root", FIXTURE_ASSETS, "--client-root", FIXTURE_CLIENT, "--out", out, "--generated-at", STAMP];
  assert.equal(await main(argv), 0, "默认模式下警告不影响退出码");
  assert.equal(await main([...argv, "--strict"]), 1);
});

okAsync("未知参数直接失败", async () => {
  assert.equal(await main(["--nope"]), 1);
});

await Promise.all(pendingCases);

process.stdout.write(`\ngenerator contract ${passed} checks ${process.exitCode ? "FAILED" : "PASS"}\n`);
