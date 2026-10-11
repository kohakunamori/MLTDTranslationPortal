import assert from "node:assert/strict";
import { filterBundles, progressPercent } from "../public/lib/data.js";
import { groupSongs, primaryVersion, singerOptions, singerSummary } from "../public/lib/songs.js";
import { songFor, buildOutputs } from "../scripts/build_data.mjs";

const mirai = { id: 14, code: "014mir", name_ja: "春日未来", name_zh: "春日未来" };
const shizuka = { id: 15, code: "015siz", name_ja: "最上静香", name_zh: "最上静香" };
const base = { bundle: "base", file: "base.json", category: "lyrics", total: 10, translated: 10,
  untranslated: 0, pending: 0, not_needed: 0, idol: shizuka,
  song: { mst_song_id: 1, canonical_key: "base", name_ja: "Song", default_singers: [mirai] } };
const variant = { ...base, bundle: "variant", file: "variant.json", translated: 5, untranslated: 3,
  pending: 0, not_needed: 2, song: { ...base.song, variant_of: "base", default_singers: [shizuka] } };
const [group] = groupSongs([variant, base]);
assert.equal(group.versions.length, 2);
assert.equal(primaryVersion(group).file, "base.json");
assert.equal(primaryVersion(group, shizuka.code).file, "variant.json");
assert.equal(group.total, 20);
assert.equal(group.not_needed, 2);
assert.equal(progressPercent(group), 83.3);
assert.equal(filterBundles([group], { status: "complete" }).length, 0);
assert.equal(filterBundles([group], { status: "untranslated" }).length, 1);
assert.equal(filterBundles([group], { idol: shizuka.code }).length, 1);
assert.equal(filterBundles([base], { idol: shizuka.code }).length, 0, "歌词不能使用文本的代表偶像筛选");
assert.equal(filterBundles([group], { keyword: "variant" }).length, 1);
assert.equal(filterBundles([group], { keyword: "最上静香" }).length, 1);
assert.deepEqual(singerOptions([variant, base, base]).map((idol) => idol.id), [14, 15]);
assert.equal(singerSummary(base), "春日未来");
assert.equal(singerSummary({ song: {} }), "演唱信息待补充");
assert.equal(groupSongs([base, { ...base, file: "different.json", song: { ...base.song, mst_song_id: 2 } }]).length, 2,
  "同名但不同歌曲不能合并");
assert.equal(groupSongs([{ file: "unknown-a", song: { mst_song_id: 0 } },
  { file: "unknown-b", song: { mst_song_id: 0 } }]).length, 2, "未知歌曲不能合成一首");
assert.equal(groupSongs([base, { ...base, channel: "client" }]).length, 2);
assert.equal(groupSongs([{ ...base, song: { ...base.song, mst_song_id: 0 } },
  { ...variant, song: { ...variant.song, mst_song_id: 0 } }]).length, 1,
  "没有数字编号时可使用已确认的同曲关系");
assert.equal(filterBundles([{ ...base, song: undefined }], { idol: shizuka.code }).length, 1,
  "剧情类内容仍按文本归属筛选");

const knownSong = songFor("scrobj_stknkk.unity3d");
assert.deepEqual(knownSong.default_singer_ids, [14]);
assert.deepEqual(knownSong.default_singers.map((idol) => idol.code), ["014mir"]);
const extended = songFor("scrobj_thank+.unity3d");
assert.equal(extended.canonical_key, "thanky");
assert.ok(extended.default_singer_ids.length > 0);
const guests = songFor("scrobj_alstar.unity3d");
assert.deepEqual(guests.default_singers.map((idol) => idol.id).sort((a, b) => a - b), [201, 202], "嘉宾也是有效的默认演唱成员");
assert.ok(songFor("scrobj_ittana.unity3d").default_singers.length > 0, "名称资料暂缺不应丢失演唱名单");
assert.deepEqual(songFor("scrobj_flyer+.unity3d").default_singers, [], "未确认的版本不能借用主版本的名单");

const output = buildOutputs({ assetsRoot: "test_helpers/fixtures/assets-repo", clientRoot: "test_helpers/fixtures/client-repo",
  generatedAt: "2026-01-01T00:00:00Z" });
const index = JSON.parse(output.files.get("catalogue/lyrics.json"));
assert.ok(index.bundles.every((bundle) => Array.isArray(bundle.song.default_singers)));
for (const entry of index.bundles) {
  const detail = JSON.parse(output.files.get(entry.file));
  assert.deepEqual(detail.song.default_singers, entry.song.default_singers);
}
console.log("Song grouping, singer filtering, version selection and generated metadata checks PASS");
