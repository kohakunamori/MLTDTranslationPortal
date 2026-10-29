import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSongResolver } from "../public/lib/song-metadata.js";
import { filterBundles, progressPercent } from "../public/lib/data.js";
import { groupSongs, primaryVersion, singerOptions, singerSummary } from "../public/lib/songs.js";
import { songFor, buildOutputs, main } from "../scripts/build_data.mjs";

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

// Newly captured songs do not require an edit to the static song master.
const captured = { songs: { future: { name_ja: "New song", mst_song_id: 9998, type: "Fairy" },
  stknkk: { name_ja: "Updated Japanese title", mst_song_id: 9 } },
  variants: { "future+": "future" }, default_singers: { future: [14], "future+": [15] } };
const resolveCaptured = createSongResolver(captured);
assert.equal(resolveCaptured("scrobj_future.unity3d").name_ja, "New song");
assert.equal(resolveCaptured("scrobj_future+.unity3d").canonical_key, "future");
assert.deepEqual(resolveCaptured("scrobj_future+.unity3d").default_singer_ids, [15]);
assert.equal(resolveCaptured("scrobj_stknkk.unity3d").name_zh, knownSong.name_zh);
assert.equal(resolveCaptured("scrobj_stknkk.unity3d").name_ja, "Updated Japanese title");
assert.throws(() => createSongResolver({ variants: { broken: "missing" } }), /版本关系无效/);
assert.throws(() => createSongResolver({ songs: { future: {} } }), /缺少正式曲名/);
assert.equal(songFor("scrobj_hapipi.unity3d").name_ja, "ハピピス♡");
assert.deepEqual(songFor("scrobj_hapipi.unity3d").default_singer_ids, [19, 18, 45, 44]);
assert.equal(songFor("scrobj_s04mat.unity3d").name_ja, "プリンセス・アラモード");
assert.deepEqual(songFor("scrobj_s04mat.unity3d").default_singer_ids, [21]);
assert.deepEqual(createSongResolver({ default_singers: { hapipi: [18] } })("scrobj_hapipi.unity3d").default_singer_ids, [18],
  "Captured cast supersedes the temporary curated fallback");

const work = mkdtempSync(join(tmpdir(), "portal-song-metadata-"));
try {
  const assetsRoot = join(work, "assets");
  cpSync("test_helpers/fixtures/assets-repo", assetsRoot, { recursive: true });
  const lyric = readFileSync(join(assetsRoot, "lyrics/songs/scrobj_smile1.unity3d.jsonl"), "utf8");
  writeFileSync(join(assetsRoot, "lyrics/songs/scrobj_s04rio.unity3d.jsonl"), lyric.replaceAll("scrobj_smile1", "scrobj_s04rio"));
  const rio = buildOutputs({ assetsRoot, clientRoot: "test_helpers/fixtures/client-repo", generatedAt: "2026-01-01T00:00:00Z" });
  const rioCatalogue = JSON.parse(rio.files.get("catalogue/lyrics.json"));
  const rioSong = rioCatalogue.bundles.find((entry) => entry.bundle === "scrobj_s04rio.unity3d");
  assert.equal(rioSong.song.name_ja, "週末だけのハーレクイン");
  assert.equal(rioSong.song.type, "Fairy");
  assert.deepEqual(rioSong.song.default_singer_ids, [46]);
  assert.deepEqual(rio.portal.song_metadata.missing_titles, []);
  writeFileSync(join(assetsRoot, "lyrics/songs/scrobj_future.unity3d.jsonl"), lyric.replaceAll("scrobj_smile1", "scrobj_future"));
  const settings = { assetsRoot, clientRoot: "test_helpers/fixtures/client-repo", generatedAt: "2026-01-01T00:00:00Z", maxRowsPerPage: 1 };
  assert.throws(() => buildOutputs(settings), /歌词缺少曲名资料：scrobj_future.unity3d/);
  const out = join(work, "published");
  mkdirSync(out);
  writeFileSync(join(out, "sentinel.json"), '{"previous":"published"}');
  assert.equal(await main(["--assets-root", assetsRoot, "--out", out]), 1);
  assert.equal(readFileSync(join(out, "sentinel.json"), "utf8"), '{"previous":"published"}', "Failed coverage keeps the previously published output");
  assert.equal(existsSync(`${out}.staging`), false);
  assert.equal(await main(["--assets-root", assetsRoot, "--out", out, "--allow-incomplete-songs"]), 0);
  const preview = buildOutputs({ ...settings, allowIncompleteSongs: true });
  assert.deepEqual(preview.portal.song_metadata.missing_titles, ["scrobj_future.unity3d"], "Coverage counts resources once across pages");
  assert.ok(preview.portal.song_metadata.missing_default_singers.includes("scrobj_future.unity3d"));
  const generated = buildOutputs({ ...settings, songDetails: captured });
  const catalogue = JSON.parse(generated.files.get("catalogue/lyrics.json"));
  const fresh = catalogue.bundles.find((entry) => entry.bundle === "scrobj_future.unity3d");
  assert.equal(fresh.song.mst_song_id, 9998);
  assert.equal(fresh.song.type, "Fairy");
  assert.deepEqual(fresh.song.default_singer_ids, [14]);
  assert.deepEqual(generated.portal.song_metadata.missing_titles, []);
  for (const page of fresh.pages) assert.deepEqual(JSON.parse(generated.files.get(page.file)).song, fresh.song);
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log("Captured song metadata, current missing songs and publication coverage checks PASS");
