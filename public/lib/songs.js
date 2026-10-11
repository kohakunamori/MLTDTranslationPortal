// Shared song presentation rules. Each lyric version keeps its own reading link.
export function songKey(entry) {
  const channel = entry.channel || "assets";
  const id = Number(entry.song?.mst_song_id);
  if (id > 0) return `${channel}:song:${id}`;
  const canonical = entry.song?.canonical_key || entry.song?.variant_of;
  return canonical ? `${channel}:song:${canonical}` : `${channel}:file:${entry.file || entry.bundle || entry.base}`;
}

export function versionsOf(entry) {
  return entry.versions || [entry];
}

export function primaryVersion(entry, idol = "") {
  const versions = versionsOf(entry);
  const matching = idol ? versions.filter((version) => version.song?.default_singers?.some((singer) => singer.code === idol)) : [];
  return (matching.length ? matching : versions)[0];
}

export function groupSongs(bundles) {
  const groups = new Map();
  for (const entry of bundles) {
    const key = songKey(entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups.entries()].map(([key, entries]) => {
    const versions = entries.slice().sort((a, b) => Number(Boolean(a.song?.variant_of)) - Number(Boolean(b.song?.variant_of))
      || String(a.bundle).localeCompare(String(b.bundle), "en"));
    const primary = versions[0];
    const singers = new Map();
    for (const version of versions) {
      for (const singer of version.song?.default_singers || []) singers.set(singer.code, singer);
    }
    const group = { ...primary, group_key: key, versions,
      song: primary.song ? { ...primary.song, default_singers: [...singers.values()] } : undefined };
    for (const field of ["total", "translated", "untranslated", "pending", "not_needed"]) {
      group[field] = versions.reduce((sum, version) => sum + Number(version[field] || 0), 0);
    }
    return group;
  });
}

export function versionLabel(entry, index = 0) {
  return entry.song?.variant_of ? `其他版本 ${index || 1}` : "主要版本";
}

export function singerSummary(entry) {
  const singers = entry.song?.default_singers || [];
  if (!singers.length) return "演唱信息待补充";
  if (singers.length >= 52 && Array.from({ length: 52 }, (_, offset) => offset + 1).every((id) => singers.some((idol) => idol.id === id))) {
    return singers.length === 52 ? "765PRO 全体偶像" : "765PRO 全体偶像及嘉宾";
  }
  if (singers.length === 39 && singers.every((idol) => idol.id >= 14 && idol.id <= 52)) return "Million Stars";
  if (singers.length === 13 && singers.every((idol) => idol.id >= 1 && idol.id <= 13)) return "765PRO Allstars";
  const names = singers.map((idol) => idol.name_zh || idol.name_ja);
  return names.slice(0, 3).join("、") + (names.length > 3 ? `等 ${names.length} 位偶像` : "");
}

export function singerOptions(bundles) {
  const idols = new Map();
  for (const entry of bundles) {
    for (const idol of entry.song?.default_singers || []) idols.set(idol.code, idol);
  }
  return [...idols.values()].sort((a, b) => a.id - b.id);
}
