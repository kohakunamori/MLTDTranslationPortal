import { IDOLS, SPEAKERS, SONG_MASTER, SONG_MASTER_EXTRA, SONG_VARIANT_OVERRIDES } from "./terms.js";

const masters = { ...SONG_MASTER_EXTRA, ...SONG_MASTER };
const idols = new Map(IDOLS.map((idol) => [idol.id, idol]));
for (const [code, speaker] of Object.entries(SPEAKERS)) {
  if (/^20\d/.test(code)) idols.set(Number(code.slice(0, 3)), { id: Number(code.slice(0, 3)), code, ...speaker, type: "Guest", color: "#7c3aed" });
}

// Captured facts refresh Japanese titles, IDs and attributes; curated Chinese titles stay local.
// A version's cast belongs to that version and must never be borrowed from its parent.
export function createSongResolver(details = {}) {
  const songs = { ...masters };
  for (const [code, captured] of Object.entries(details.songs || {})) {
    if (!captured || typeof captured.name_ja !== "string" || !captured.name_ja.trim()) {
      throw new Error(`曲目资料缺少正式曲名：${code}`);
    }
    songs[code] = { ...masters[code], bundle: `scrobj_${code}.unity3d`, name_ja: captured.name_ja };
    if (Number.isInteger(captured.mst_song_id) && captured.mst_song_id > 0) songs[code].mst_song_id = captured.mst_song_id;
    if (["All", "Princess", "Fairy", "Angel"].includes(captured.type)) songs[code].type = captured.type;
  }
  const variants = { ...details.variants, ...SONG_VARIANT_OVERRIDES };
  for (const [code, parent] of Object.entries(variants)) {
    if (code === parent || !songs[parent]) throw new Error(`曲目版本关系无效：${code} -> ${parent}`);
  }
  return (bundle) => {
    const code = String(bundle).replace(/^scrobj_/i, "").replace(/\.unity3d$/i, "").toLowerCase();
    const direct = songs[code];
    const parent = variants[code];
    const song = direct || songs[parent];
    if (!song) return null;
    const singerIds = details.default_singers?.[code] ?? masters[code]?.default_singer_ids ?? [];
    return { ...song, variant_of: direct ? null : parent, canonical_key: direct ? code : parent,
      default_singer_ids: singerIds, default_singers: singerIds.map((id) => idols.get(id)).filter(Boolean) };
  };
}
