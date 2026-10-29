import { IDOLS } from "../public/lib/terms.js";

// An iGP solo can precede the captured song catalogue. Only accept its title
// when the idol-specific official bundle has one song-name row and the same
// title occurs in the corresponding lyric bundle after Unicode and whitespace
// normalization. Ambiguous or short candidates stay unresolved; no artist,
// numeric song ID, or type is guessed.
export function recoverIgpSongTitles(rowsByBundle, resolveSong) {
  const recovered = new Map();
  const normalize = (value) => String(value || "").normalize("NFKC").replace(/\s+/gu, "");
  for (const [bundle, lyrics] of rowsByBundle) {
    const match = /^scrobj_s04([a-z0-9]{3})\.unity3d$/i.exec(bundle);
    if (!match || resolveSong(bundle)) continue;
    const idols = IDOLS.filter((idol) => /^\d{3}[a-z0-9]{3}$/i.test(idol.code)
      && idol.code.slice(3).toLowerCase() === match[1].toLowerCase());
    if (idols.length !== 1) continue;
    const sourceBundle = `igp_${idols[0].code}_jp.gtx`;
    const candidates = new Map();
    for (const row of rowsByBundle.get(sourceBundle) || []) {
      if (!/^ld_song_name_\d+$/.test(String(row.item_key))) continue;
      const title = String(row.source || "").trim();
      const key = normalize(title);
      if (!key) continue;
      if (!candidates.has(key)) candidates.set(key, { title, itemKey: row.item_key });
    }
    if (candidates.size !== 1) continue;
    const [normalizedTitle, candidate] = [...candidates.entries()][0];
    if ([...normalizedTitle].length < 6) continue;
    if (!lyrics.some((row) => row.category === "lyrics" && normalize(row.source).includes(normalizedTitle))) continue;
    const code = `s04${match[1].toLowerCase()}`;
    recovered.set(bundle, {
      name_ja: candidate.title,
      name_zh: "",
      type: null,
      mst_song_id: 0,
      canonical_key: code,
      variant_of: null,
      default_singer_ids: [],
      default_singers: [],
      title_source: { kind: "igp_lyric_match", bundle: sourceBundle, item_key: candidate.itemKey },
    });
  }
  return recovered;
}
