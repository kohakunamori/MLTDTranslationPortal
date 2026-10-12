export const BLOOM_BYTES = 32768;
export function normalizeSearch(text) {
  return String(text || "").replace(/<\/?(?:b|color(?:=[^>]+)?)>/gi, "")
    .normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}
function tokens(text) {
  const chars = Array.from(normalizeSearch(text));
  const values = chars.map((x) => `c:${x}`);
  for (let i = 1; i < chars.length; i++) values.push(`b:${chars[i - 1]}${chars[i]}`);
  return values;
}
function hashes(token) {
  let a = 2166136261, b = 5381;
  for (let i = 0; i < token.length; i++) {
    const code = token.charCodeAt(i);
    a = Math.imul(a ^ code, 16777619); b = Math.imul(b, 33) ^ code;
  }
  return [a >>> 0, b >>> 0];
}
export function buildBloom(texts) {
  const bits = new Uint8Array(BLOOM_BYTES);
  for (const text of texts) for (const token of new Set(tokens(text))) for (const hash of hashes(token)) {
    const bit = hash % (BLOOM_BYTES * 8); bits[bit >> 3] |= 1 << (bit & 7);
  }
  return bits;
}
export function bloomMayMatch(encoded, keyword) {
  // Missing filters degrade to a full scan; they must never omit matching rows.
  if (!encoded || !keyword) return true;
  let bits;
  try {
    const binary = globalThis.atob(encoded);
    bits = Uint8Array.from(binary, (x) => x.charCodeAt(0));
  } catch (_) { return true; }
  if (bits.length !== BLOOM_BYTES) return true;
  return tokens(keyword).every((token) => hashes(token).every((hash) => {
    const bit = hash % (BLOOM_BYTES * 8); return bits[bit >> 3] & (1 << (bit & 7));
  }));
}
export function rowMatches(row, definition, { keyword = "", idol = "", status = "" } = {}) {
  const needle = normalizeSearch(keyword);
  return (!idol || definition[4]?.includes(idol) || row[6] === idol)
    && (!status || row[5] === status)
    && (normalizeSearch(row[3]).includes(needle) || normalizeSearch(row[4]).includes(needle));
}
export function excerpt(text, keyword, limit = 160) {
  const raw = String(text || "").replace(/\s+/g, " ");
  const at = normalizeSearch(raw).indexOf(normalizeSearch(keyword));
  const start = Math.max(0, at - Math.floor(limit / 3));
  return (start ? "…" : "") + raw.slice(start, start + limit) + (raw.length > start + limit ? "…" : "");
}

export async function searchCorpus({ manifest, fetchShard, filters = {}, signal, onProgress = () => {}, limit = 200 }) {
  const keyword = normalizeSearch(filters.keyword);
  if (!keyword) return { total: 0, results: [], scanned: 0 };
  const selected = (manifest.shards || []).filter((shard) => (!filters.categories?.length || filters.categories.includes(shard.category))
    && bloomMayMatch(shard.bloom, keyword));
  const results = [];
  let total = 0, scanned = 0;
  for (const shard of selected) {
    signal?.throwIfAborted();
    const doc = await fetchShard(shard.file, signal);
    if (!Array.isArray(doc.rows) || !Array.isArray(doc.files)) throw new Error("搜索资料不完整，请刷新后重试。");
    for (const row of doc.rows) {
      const definition = doc.files[row[0]];
      if (!definition || !rowMatches(row, definition, { ...filters, keyword })) continue;
      total++;
      if (results.length < limit) results.push({ file: definition[0], category: definition[1], label: definition[2],
        p: definition[3], index: row[1], line: row[2], status: row[5],
        source: excerpt(row[3], keyword), translation: excerpt(row[4], keyword) });
    }
    scanned++;
    onProgress({ total, results: results.slice(), scanned, shards: selected.length });
  }
  return { total, results, scanned, shards: selected.length };
}
