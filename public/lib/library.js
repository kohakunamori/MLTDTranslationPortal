import { versionsOf } from "./songs.js";

export const SONG_TYPES = { Princess: "Princess", Fairy: "Fairy", Angel: "Angel", All: "全属性" };
export const CAST_TYPES = { solo: "独唱", unit: "组合", all: "全员", unknown: "演唱资料待补充" };

export function castType(entry) {
  const ids = new Set((entry.song?.default_singers || []).map((idol) => idol.id));
  if (!ids.size) return "unknown";
  if (Array.from({ length: 52 }, (_, i) => i + 1).every((id) => ids.has(id))
    || (ids.size === 39 && Array.from({ length: 39 }, (_, i) => i + 14).every((id) => ids.has(id)))
    || (ids.size === 13 && Array.from({ length: 13 }, (_, i) => i + 1).every((id) => ids.has(id)))) return "all";
  return ids.size === 1 ? "solo" : "unit";
}

// Apply these predicates to the same version: combining unrelated versions can
// otherwise make a solo song appear to have a duet by the selected idol.
export function matchingVersions(entry, { idol = "", attribute = "", cast = "" } = {}) {
  return versionsOf(entry).filter((version) => (!idol || version.song?.default_singers?.some((x) => x.code === idol))
    && (!attribute || version.song?.type === attribute) && (!cast || castType(version) === cast));
}

export function filterSongPresentation(entries, filters = {}) {
  return entries.filter((entry) => matchingVersions(entry, filters).length > 0);
}

export function readableLabel(entry) {
  return entry.title?.name_zh || entry.title?.name_ja || entry.label
    || entry.song?.name_zh || entry.song?.name_ja || entry.base || "未命名内容";
}

export function chapterContext(topic, file) {
  const chapters = topic?.chapters || [];
  const index = chapters.findIndex((entry) => entry.file === file);
  if (index < 0 || !topic.continuous) return { previous: null, next: null, index };
  return { previous: chapters[index - 1] || null, next: chapters[index + 1] || null, index };
}

export function alignLyrics(left, right, { ignoreWhitespace = false } = {}) {
  const key = (line) => ignoreWhitespace ? String(line.source || "").replace(/\s+/g, "") : String(line.source || "");
  const a = left || [], b = right || [];
  if (a.length * b.length > 4_000_000) throw new Error("歌词过长，请选择较短的版本进行对照。");
  const width = b.length + 1;
  const matrix = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) matrix[i * width + j] = key(a[i]) === key(b[j])
      ? matrix[(i + 1) * width + j + 1] + 1
      : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1]);
  }
  const operations = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && key(a[i]) === key(b[j])) {
      operations.push({ left: a[i++], right: b[j++], kind: "same-source" });
    } else if (i < a.length && (j === b.length || matrix[(i + 1) * width + j] >= matrix[i * width + j + 1])) {
      operations.push({ left: a[i++], right: null });
    } else operations.push({ left: null, right: b[j++] });
  }
  const output = [];
  for (let offset = 0; offset < operations.length;) {
    const op = operations[offset];
    if (op.kind) {
      const sameTranslation = String(op.left.translation || "") === String(op.right.translation || "");
      output.push({ ...op, kind: sameTranslation ? "same" : "translation" });
      offset++;
      continue;
    }
    const removed = [], added = [];
    while (offset < operations.length && !operations[offset].kind) {
      const next = operations[offset++];
      if (next.left) removed.push(next.left);
      else added.push(next.right);
    }
    for (let n = 0; n < Math.max(removed.length, added.length); n++) output.push({
      left: removed[n] || null, right: added[n] || null,
      kind: removed[n] && added[n] ? "changed" : removed[n] ? "removed" : "added",
    });
  }
  return output;
}
