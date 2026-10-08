// Small R2-backed escape hatch for authentication metadata when the D1 free
// row-write budget is exhausted. Release/catalogue reads never use this path;
// it only keeps an OAuth round trip and an already-issued session alive until
// D1 is available again.

const PREFIX = "_portal-auth/";

function key(kind, id) {
  return `${PREFIX}${kind}/${encodeURIComponent(String(id || ""))}.json`;
}

export function authStorageAvailable(env) {
  return Boolean(env?.PUBLICATION_BUCKET?.get && env?.PUBLICATION_BUCKET?.put);
}

export async function readAuthObject(env, kind, id) {
  if (!authStorageAvailable(env)) return null;
  const object = await env.PUBLICATION_BUCKET.get(key(kind, id));
  if (!object) return null;
  try {
    return JSON.parse(await object.text());
  } catch (_) {
    return null;
  }
}

export async function writeAuthObject(env, kind, id, value) {
  if (!authStorageAvailable(env)) return false;
  await env.PUBLICATION_BUCKET.put(key(kind, id), JSON.stringify(value), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  return true;
}

export async function deleteAuthObject(env, kind, id) {
  if (!env?.PUBLICATION_BUCKET?.delete) return false;
  await env.PUBLICATION_BUCKET.delete(key(kind, id));
  return true;
}

export function quotaLike(error) {
  const text = String(error?.message || error || "").toLowerCase();
  return error?.code === 7500 || text.includes("free tier") || text.includes("row write limit") || text.includes("quota");
}
