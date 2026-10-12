/** Browser-only token storage adapter.
 * The module is safe to import under Node because storage is resolved lazily.
 */
export const PAT_STORAGE_KEY = "mltd.pat";

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function resolveStorage(storage) {
  if (storage !== undefined && storage !== null) return storage;
  return defaultStorage();
}

export function getToken(storage = defaultStorage()) {
  const store = resolveStorage(storage);
  if (!store) return "";
  try {
    const raw = store.getItem(PAT_STORAGE_KEY);
    return typeof raw === "string" ? raw.trim() : "";
  } catch {
    return "";
  }
}

export function setToken(value, storage = defaultStorage()) {
  const store = resolveStorage(storage);
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    try {
      store?.removeItem?.(PAT_STORAGE_KEY);
    } catch {
      // Storage is optional and may be disabled by the browser.
    }
    return "";
  }
  if (!store) return "";
  try {
    store.setItem(PAT_STORAGE_KEY, text);
    return text;
  } catch {
    return "";
  }
}
