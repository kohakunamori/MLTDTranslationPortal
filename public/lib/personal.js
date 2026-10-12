const STORAGE_KEY = "mltd.portal.library.v1";
const MAX_FAVORITES = 500, MAX_RECENT = 100, MAX_POSITIONS = 250;
const empty = () => ({ version: 1, favorites: [], recent: [], positions: {} });
const validFile = (value) => typeof value === "string" && /^bundles\/[a-z_]+\/[a-zA-Z0-9_.-]+\.json$/.test(value);
const boundedString = (value, limit) => typeof value === "string" ? value.slice(0, limit) : "";

export function itemId(entry) {
  return `${entry.channel || "assets"}:${entry.category || ""}:${entry.bundle || entry.file}`;
}

export function cleanBookmark(value) {
  if (!value || !validFile(value.file)) return null;
  return { id: boundedString(value.id, 250) || value.file, file: value.file,
    label: boundedString(value.label, 200) || "阅读内容", category: boundedString(value.category, 50),
    updated_at: Number.isFinite(value.updated_at) ? value.updated_at : 0 };
}

export function cleanPosition(value) {
  if (!value || !validFile(value.file)) return null;
  return { file: value.file, p: Math.max(1, Math.min(10_000, Math.trunc(Number(value.p) || 1))),
    line: boundedString(String(value.line ?? ""), 250), updated_at: Number.isFinite(value.updated_at) ? value.updated_at : 0 };
}

export function cleanPersonalData(doc) {
  if (!doc || doc.version !== 1) return empty();
  const unique = (values, limit) => [...new Map((Array.isArray(values) ? values : [])
    .map(cleanBookmark).filter(Boolean).map((x) => [x.id, x])).values()].slice(0, limit);
  const positions = Object.entries(doc.positions && typeof doc.positions === "object" ? doc.positions : {})
    .map(([id, position]) => [id.slice(0, 250), cleanPosition(position)]).filter(([, x]) => x)
    .sort((a, b) => b[1].updated_at - a[1].updated_at).slice(0, MAX_POSITIONS);
  return { version: 1, favorites: unique(doc.favorites, MAX_FAVORITES), recent: unique(doc.recent, MAX_RECENT),
    positions: Object.fromEntries(positions) };
}

export function createPersonalStore(storage, { now = () => Date.now() } = {}) {
  let data = empty(), available = Boolean(storage);
  const reload = () => {
    try { data = cleanPersonalData(JSON.parse(storage?.getItem(STORAGE_KEY) || "null")); }
    catch (_) { available = false; }
    return data;
  };
  reload();
  function save() {
    data = cleanPersonalData(data);
    try {
      if (!storage) throw new Error("Storage unavailable");
      storage.setItem(STORAGE_KEY, JSON.stringify(data)); available = true;
    } catch (_) { available = false; }
    return available;
  }
  return {
    reload, get available() { return available; }, snapshot: () => structuredClone(data),
    isFavorite: (id) => data.favorites.some((x) => x.id === id),
    position: (id) => data.positions[id] || null,
    toggleFavorite(value) {
      const item = cleanBookmark({ ...value, updated_at: now() });
      if (!item) return false;
      if (data.favorites.some((x) => x.id === item.id)) data.favorites = data.favorites.filter((x) => x.id !== item.id);
      else data.favorites = [item, ...data.favorites].slice(0, MAX_FAVORITES);
      return save();
    },
    visit(value) {
      const item = cleanBookmark({ ...value, updated_at: now() });
      if (!item) return false;
      data.recent = [item, ...data.recent.filter((x) => x.id !== item.id)].slice(0, MAX_RECENT);
      return save();
    },
    savePosition(id, value) {
      const position = cleanPosition({ ...value, updated_at: now() });
      if (!position) return false;
      data.positions[id] = position;
      return save();
    },
    removeFavorite(id) { data.favorites = data.favorites.filter((x) => x.id !== id); return save(); },
    clearRecent() { data.recent = []; data.positions = {}; return save(); },
    exportData: () => JSON.stringify(data, null, 2),
    importData(text) {
      const doc = JSON.parse(text);
      if (!doc || doc.version !== 1 || !Array.isArray(doc.favorites)) throw new Error("无法识别这份收藏备份。");
      const incoming = cleanPersonalData(doc);
      data = cleanPersonalData({ version: 1, favorites: [...data.favorites, ...incoming.favorites],
        recent: [...data.recent, ...incoming.recent], positions: { ...data.positions, ...incoming.positions } });
      return save();
    },
  };
}

export function browserPersonalStore() {
  let storage;
  try { storage = globalThis.localStorage; } catch (_) { /* Use memory when persistence is blocked. */ }
  return createPersonalStore(storage);
}
