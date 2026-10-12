import { searchCorpus } from "./search-core.js";

let controller, active;
async function read(url, signal) {
  const response = await fetch(url, { signal, cache: "no-cache" });
  if (!response.ok) throw new Error("搜索资料暂时无法载入，请稍后重试。");
  return response.json();
}
self.onmessage = async ({ data }) => {
  controller?.abort();
  if (data.cancel) return;
  const request = data.id;
  active = request; controller = new AbortController();
  const signal = controller.signal;
  const send = (value) => { if (active === request && !signal.aborted) self.postMessage({ id: request, ...value }); };
  try {
    const root = new URL(data.root);
    const manifest = await read(new URL("search/index.json", root), signal);
    const result = await searchCorpus({ manifest, filters: data.filters, signal,
      fetchShard: (file) => read(new URL(file, root), signal), onProgress: (progress) => send({ progress }) });
    send({ result });
  } catch (error) { if (!signal.aborted) send({ error: error.message }); }
};
