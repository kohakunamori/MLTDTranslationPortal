import assert from "node:assert/strict";
import { buildOutputs } from "../scripts/build_data.mjs";
import { decorateLibraryBundles, emitLibrary, emitSearch } from "../scripts/library_data.mjs";
import { alignLyrics, castType, chapterContext, filterSongPresentation, matchingVersions } from "../public/lib/library.js";
import { cleanPersonalData, createPersonalStore, itemId } from "../public/lib/personal.js";
import { bloomMayMatch, buildBloom, normalizeSearch, searchCorpus } from "../public/lib/search-core.js";

const mirai = { id: 14, code: "014mir", name_zh: "春日未来" };
const shizuka = { id: 15, code: "015siz", name_zh: "最上静香" };
const solo = { file: "bundles/lyrics/solo.json", bundle: "solo", category: "lyrics", song: { type: "Princess", default_singers: [mirai] } };
const duet = { ...solo, file: "bundles/lyrics/duet.json", song: { type: "Fairy", default_singers: [shizuka, { id: 16, code: "016tub" }] } };
const mixed = { ...solo, versions: [solo, duet] };
assert.equal(castType(solo), "solo");
assert.equal(castType(duet), "unit");
assert.equal(castType({ song: { default_singers: Array.from({ length: 52 }, (_, i) => ({ id: i + 1 })) } }), "all");
assert.equal(castType({ song: {} }), "unknown");
assert.equal(filterSongPresentation([mixed], { idol: mirai.code, cast: "unit" }).length, 0, "所有条件必须匹配同一版本");
assert.equal(matchingVersions(mixed, { attribute: "Fairy", cast: "unit" })[0].file, duet.file);

const line = (source, translation = source) => ({ source, translation });
const aligned = alignLyrics([line("A"), line("chorus"), line("B"), line("chorus")],
  [line("A"), line("intro"), line("chorus"), line("B", "新译文"), line("chorus")]);
assert.deepEqual(aligned.map((x) => x.kind), ["same", "added", "same", "translation", "same"]);
assert.equal(aligned.filter((x) => x.left?.source === "chorus").length, 2, "重复副歌不能去重");
assert.equal(alignLyrics([line("AA")], [line("BB")])[0].kind, "changed");
assert.equal(alignLyrics([line("A B")], [line("AB")], { ignoreWhitespace: true })[0].kind, "translation");
assert.equal(alignLyrics([], [line("a")])[0].kind, "added");

const memory = new Map();
const storage = { getItem: (k) => memory.get(k), setItem: (k, v) => memory.set(k, v) };
const store = createPersonalStore(storage, { now: () => 123 });
const bookmark = { id: itemId(solo), file: solo.file, label: "歌曲", category: "lyrics" };
assert.equal(store.toggleFavorite(bookmark), true);
store.visit(bookmark); store.visit(bookmark);
store.savePosition(bookmark.id, { file: solo.file, p: 3, line: "slot_123" });
const restored = createPersonalStore(storage);
assert.equal(restored.snapshot().favorites.length, 1);
assert.equal(restored.snapshot().recent.length, 1);
assert.equal(restored.position(bookmark.id).p, 3);
assert.equal(restored.position(bookmark.id).line, "slot_123");
restored.toggleFavorite(bookmark);
assert.equal(restored.isFavorite(bookmark.id), false);
restored.importData(store.exportData());
assert.equal(restored.isFavorite(bookmark.id), true);
restored.clearRecent();
assert.equal(restored.snapshot().recent.length, 0);
assert.equal(restored.snapshot().favorites.length, 1);
assert.deepEqual(restored.snapshot().positions, {});
assert.equal(createPersonalStore({ getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); } }).toggleFavorite(bookmark), false);
assert.equal(createPersonalStore(undefined).available, false);
assert.deepEqual(cleanPersonalData({ version: 1, favorites: [{ file: "https://example.org/private" }], token: "secret" }).favorites, []);
assert.ok(!store.exportData().includes("secret"));

const fixture = buildOutputs({ assetsRoot: "test_helpers/fixtures/assets-repo", clientRoot: "test_helpers/fixtures/client-repo",
  generatedAt: "2026-01-01T00:00:00Z" });
const parse = (file) => JSON.parse(fixture.files.get(file));
const manifest = parse("search/index.json");
assert.equal(manifest.total, parse("portal.json").totals.total);
const result = await searchCorpus({ manifest, filters: { keyword: "アイドル" }, fetchShard: async (file) => parse(file) });
const actual = manifest.shards.flatMap((shard) => {
  const doc = parse(shard.file);
  return doc.rows.filter((row) => normalizeSearch(row[3]).includes("アイドル") || normalizeSearch(row[4]).includes("アイドル"));
});
assert.equal(result.total, actual.length, "分片过滤不能漏掉匹配行");
const bloom = Buffer.from(buildBloom(["春日未来 hello ＡＢＣ 😀音楽"])).toString("base64");
for (const query of ["未", "未来", "hello", "abc", "😀音楽"]) assert.equal(bloomMayMatch(bloom, query), true);
assert.equal(bloomMayMatch("broken", "未来"), true, "损坏的预筛选应退化为完整搜索");
const cancel = new AbortController(); cancel.abort();
await assert.rejects(searchCorpus({ manifest: { shards: [{ file: "x", category: "lyrics" }] }, signal: cancel.signal,
  filters: { keyword: "a" }, fetchShard: async () => assert.fail("cancelled request fetched") }), { name: "AbortError" });
await assert.rejects(searchCorpus({ manifest: { shards: [{ file: "x" }] }, filters: { keyword: "a" },
  fetchShard: async () => { throw new Error("unavailable"); } }), /unavailable/);

const chapter = (bundle, rows, page = 1) => ({ record: { bundle, file: `bundles/event_story/${bundle}.json`,
  category: "event_story", domain: "story", channel: "assets", page, first_index: 1, total: rows.length }, rows });
const chapters = [chapter("event_0004_story_01_jp.gtx", [{ item_key: "event_0004_story_01_title", source: "始まり", translation: "开始", idol: mirai }]),
  chapter("event_0004_story_02_jp.gtx", [{ item_key: "event_0004_story_02_1_015siz", source: "こんにちは", translation: "你好", idol: shizuka }]),
  chapter("event_0004_story_chat_jp.gtx", [{ item_key: "chat", source: "chat", translation: "短信", idol: mirai }])];
decorateLibraryBundles(chapters);
assert.equal(chapters[0].record.title.name_zh, "开始");
assert.deepEqual(chapters[1].record.participants, [shizuka.code]);
const generated = new Map(), sink = { put: (file, text) => generated.set(file, JSON.parse(text)) };
emitLibrary(sink, chapters.map((x) => x.record));
const topic = generated.get("library/topics/event-0004.json");
assert.equal(topic.continuous, true);
assert.equal(topic.chapters.length, 2);
assert.equal(topic.related.length, 1, "短信不能混入正文的章节顺序");
assert.equal(chapterContext(topic, chapters[0].record.file).previous, null);
assert.equal(chapterContext(topic, chapters[0].record.file).next.file, chapters[1].record.file);
assert.equal(chapterContext(topic, chapters[1].record.file).next, null);
assert.equal(generated.get("library/idols/014mir.json").stories.length, 2);
emitSearch(sink, chapters, chapters.map((x) => x.record), { chunkSize: 1 });
const customManifest = generated.get("search/index.json");
const search = await searchCorpus({ manifest: customManifest, fetchShard: async (file) => generated.get(file), filters: { keyword: "你好", idol: shizuka.code } });
assert.equal(search.total, 1);
assert.equal(search.results[0].line, "event_0004_story_02_1_015siz");
assert.equal(search.results[0].file, chapters[1].record.file);
const main = chapter("main_intro_001_jp.gtx", [{ item_key: "main_intro_001_title", source: "Title", translation: "标题", idol: mirai }]);
main.record.category = "system_ui"; main.record.domain = "system";
const anniversary = chapter("event_0044_story_intro_jp.gtx", [{ item_key: "intro", source: "劇場の記念日をお祝いします", translation: "庆祝剧场纪念日" }]);
decorateLibraryBundles([main, anniversary]);
assert.equal(main.record.reading_category, "main_commu", "主线阅读与搜索不能被混入界面字段");
assert.equal(anniversary.record.topic.kind, "anniversary");
const magazine = chapter("event_0371_story_intro_jp.gtx", [{ item_key: "intro", source: "創刊50周年", translation: "《Little Candy》迎来了创刊50周年" }]);
decorateLibraryBundles([magazine]);
assert.equal(magazine.record.topic.label, "Little Candy · 50 周年纪念", "其他活动的周年不能冒充剧场周年");
emitLibrary(sink, [main.record]);
assert.equal(generated.get("library/idols/014mir.json").stories.length, 1);
console.log("Library, song facets, personal records, lyric alignment, topic sequence and full-text search checks PASS");
