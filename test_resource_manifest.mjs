import assert from "node:assert/strict";
import { buildResourceManifest } from "./src/worker.js";

const release = {
  release_id: "assets-1077100",
  asset_version: "1077100",
  source_manifest_sha256: "a".repeat(64),
  status: "canonical",
};

const summary = {
  total_items: 12,
  translated_items: 4,
  pending_items: 3,
  untranslated_items: 5,
  reused_items: 2,
  suggested_items: 1,
  blocked_items: 0,
  updated_at: "2026-09-30T00:00:00.000Z",
  categories: {
    lyrics: { total: 8, accepted: 3, pending: 2, progress_percent: 37.5, bundles: {} },
    system_ui: { total: 4, accepted: 1, pending: 1, progress_percent: 25, bundles: {} },
  },
};

const manifest = buildResourceManifest({
  kind: "assets",
  release,
  summary,
  imageSummary: { counts: { event: 5, costume: 2, ignored_unknown: 9 } },
});

assert.equal(manifest.schema, "mltd.portal.resource-manifest/v1");
assert.equal(manifest.kind, "assets");
assert.equal(manifest.release.release_id, release.release_id);
assert.deepEqual(manifest.categories.map((item) => item.id), ["lyrics", "system_ui", "img_event", "img_costume"]);
assert.equal(manifest.categories.find((item) => item.id === "lyrics").entry, "lyrics");
assert.equal(manifest.categories.find((item) => item.id === "img_event").entry, "images");
assert.deepEqual(manifest.domains.map((item) => item.id), ["lyrics", "system", "images"]);
assert.equal(manifest.totals.total, 12);

const client = buildResourceManifest({
  kind: "client",
  release: { release_id: "client-9.0.200-arm64", client_version: "9.0.200", manifest_sha256: "b".repeat(64) },
  summary: { total_items: 2, translated_items: 1, pending_items: 0, untranslated_items: 1, categories: { system_ui: { total: 2, accepted: 1 } } },
});
assert.equal(client.categories[0].entry, "studio");
assert.equal(client.categories[0].domain, "system");

console.log("resource manifest PASS (dynamic Assets/Client taxonomy)");
