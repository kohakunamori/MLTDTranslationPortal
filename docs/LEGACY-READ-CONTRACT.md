# Legacy read contract — the Cloudflare Worker in `src/worker.js`

> **考古文档。** 引用的 `src/worker.js` 行号针对删除前的提交
> `7011fd8`（`git show 7011fd8:src/worker.js`）。该 Worker 与整套 D1/协作运行时已在
> 2026-10 的重构中删除；本文只用于解释新生成器的判定规则从哪来。


**Purpose.** This document specifies, exhaustively, the **read-only HTTP API** implemented by
`src/worker.js` and the **exact schemas of the upstream GitHub-hosted files** that the read paths
consume, so that a *new offline static data generator* can emit equivalent static JSON without
reading the Worker.

**Status.** Reverse-engineered by read-only archaeology. Nothing in the repository was modified
except the creation of this file.

**Primary sources.**

| Source | Role |
| --- | --- |
| `src/worker.js` (5338 lines) | the contract itself; every line citation below is from this file unless prefixed otherwise |
| `src/categories.js` | `CATEGORY_RULES`, `categoryId`, `detectCategory` |
| `src/release_registry.js` | D1 release registry, `PORTAL_DEFAULT_ASSET_VERSION`, asset-version normalisation |
| `src/sync_ingest.js` | JSONL row reader, `buildLogicalKey`, `rebuildReleaseSummary`, `rebuildPortalStats` |
| `src/image_ratio.js` | image geometry gate (write path only; read paths only expose geometry) |
| `src/terms.js` | `TERMS`, `IDOLS`, `SPEAKERS`, `IDOL_MAP`, `SONG_MASTER` (static code data, not release data) |
| `test_worker.mjs`, `test_sync.mjs`, `test_resource_manifest.mjs` | embedded fixtures that show real upstream shapes |
| `schema.sql` | D1 column lists for the tables the read paths select |
| `public/.assetsignore`, `wrangler.jsonc` | which static files are published, and the bindings |

**Tree-state caveat.** While this document was being written, a *concurrent* process (a sibling
agent working on a different deliverable) moved `src/terms.js` to `public/lib/terms.js`, added
`public/lib/taxonomy.js`, and created `docs/DATA-CONTRACT.md`. `src/worker.js` itself was **not**
modified (mtime unchanged), so it still imports `./terms.js` at `src/worker.js:1` — i.e. the Worker
tree was, at the moment of writing, transiently inconsistent. Citations to `src/terms.js` refer to
the file as it existed when it was read (1139 lines, 89116 bytes). None of the read-path logic in
`src/worker.js` changed.

**Reading conventions.** `jsonc` blocks are illustrative; `//` comments give the JS type produced by
`JSON.stringify` (`null`, `true`, numbers, strings). `|` inside a comment is a union of observed
values. Every field is always present unless marked *optional* — the Worker builds responses from
object literals and does not strip `undefined` … except where `JSON.stringify` drops a key whose
value is `undefined` (noted per case).

---

## 1. Global mechanics

### 1.1 Dispatch order and routing

`route(request, env)` — `src/worker.js:5168-5287`; `export default { async fetch }` —
`src/worker.js:5289-5311`.

1. `OPTIONS` on **any** path returns `204` with
   `access-control-allow-methods: GET,POST,OPTIONS` and
   `access-control-allow-headers: content-type,x-csrf-token` (`src/worker.js:5170`). No body.
2. The five retired *write* routes answer `410 gone` **before** authentication
   (`retiredResponse`, `src/worker.js:5121-5166`): `POST /api/contributions`, `POST /api/reviews`,
   `POST /api/reviews/:id`, `POST /api/publish`, `POST /api/images/status`,
   `POST|PATCH /api/images/restore`. These are write routes; listed for completeness only.
3. Route table (read rows only), exact path equality unless a regex is shown:

| Order | Path | Method | Handler |
| --- | --- | --- | --- |
| 1 | `/api/health` | GET | inline `{ ok, service }` — `:5171` |
| 2 | `/api/me` | GET | session-gated, `:5175-5179` |
| 3 | `/api/logout`, `/api/auth/github/logout` | POST only (else `405`) | `:5180-5185` |
| 4 | `/api/terms` | GET | `getTerms` — `:5186` |
| 5 | `/api/stats` | GET | `getStats` — `:5187` |
| 6 | `/api/catalogue/search` | GET | `searchCatalogue` — `:5188` |
| 7 | `/api/lyrics/songs` | GET | `getSongs` — `:5189` |
| 8 | `/api/lyrics/song` | GET | `getSongLyrics` — `:5190` |
| 9 | `/api/client/releases` | GET | `getClientReleases` — `:5193` |
| 10 | `/api/client/releases/:ref` (`^\/api\/client\/releases\/([^/]+)$`) | GET | `getClientReleaseDetail` — `:5194-5195` |
| 11 | `/api/client/releases/:ref/summary` | GET | `getClientReleaseSummary` — `:5196-5197` |
| 12 | `/api/client/releases/:ref/manifest` | GET | `getClientReleaseManifest` — `:5198-5199` |
| 13 | `/api/client/releases/:ref/items` | GET | `getClientReleaseItems` — `:5200-5201` |
| 14 | `/api/client/releases/:ref/item/edit-context` | GET | `getClientStaticItemContext` — `:5202-5203` |
| 15 | `/api/client/releases/:ref/item` | GET | `getReleaseItemDetail("client", …)` — `:5204-5205` |
| 16 | `/api/assets/releases` | GET | `getAssetsReleases` — `:5208` |
| 17 | `/api/assets/releases/:ref` | GET | `getAssetsReleaseDetail` — `:5209-5210` |
| 18 | `/api/assets/releases/:ref/summary` | GET | `getAssetsReleaseSummary` — `:5211-5212` |
| 19 | `/api/assets/releases/:ref/manifest` | GET | `getAssetsReleaseManifest` — `:5213-5214` |
| 20 | `/api/assets/releases/:ref/items` | GET | `getAssetsReleaseItems` — `:5215-5216` |
| 21 | `/api/assets/releases/:ref/item/edit-context` | GET | `getStaticAssetsItemContext` — `:5217-5218` |
| 22 | `/api/assets/releases/:ref/item` | GET | `getReleaseItemDetail("assets", …)` — `:5221-5222` |
| 23 | `/api/resources/:id` | GET | `getResourceDetail` — `:5225-5226` |
| 24 | `/api/resources/:id/history` | GET | `getResourceHistory` — `:5227-5228` |
| 25 | `/api/resources/:id/reuse` | GET | `getResourceReuse` — `:5229-5230` |
| 26 | `/api/resources/:id/edit-context` | GET | `getResourceEditContext` — `:5235-5236` |
| 27 | `/api/sync/status` | GET | `getSyncStatus` (auth) — `:5240` |
| 28 | `/api/images/tasks` | GET | `getImageTasks` — `:5246` |
| 29 | `/api/images/task` | GET | `getImageTaskDetail` — `:5247` |
| 30 | `/api/images/asset` | GET | `getImageAsset` (R2 read or 302) — `:5248` |
| 31 | `/api/images/status` | GET | `getImageStatusOverrides` — `:5249` |

`/api/queue` and `/api/admin/contributions` (`:5252-5253`) are read-only but session- and
GitHub-permission-gated; out of scope for a static generator.

4. **Method mismatch is `404`, not `405`.** Only `/api/logout` checks the method explicitly
   (`:5181`). Every other route is `pathname === X && request.method === "GET"`; a `POST` to
   `/api/stats` therefore falls through to `if (url.pathname.startsWith("/api/")) throw new
   HttpError(404, "not_found")` (`src/worker.js:5285`).
5. Non-`/api/` paths return `null` from `route()` and are proxied to the static assets binding:
   `if (env.ASSETS) return env.ASSETS.fetch(request)` (`src/worker.js:5295`), with
   `"run_worker_first": true` in `wrangler.jsonc:14-20`.

### 1.2 Response envelope

`json(body, status = 200, extra = {})` — `src/worker.js:129-134`:

```
content-type: application/json; charset=utf-8
```

plus any `extra` headers, which are the only place `cache-control`, `etag`, `retry-after` and
`x-summary-source` are set. Bodies are `JSON.stringify(body)` — no pretty printing, no envelope,
no wrapper: the top-level object of each handler *is* the response body.

`cors(request, response)` — `src/worker.js:183-192`: `access-control-allow-origin` is echoed **only
when `Origin === new URL(request.url).origin`** (same-origin), together with
`access-control-allow-credentials: true` and `vary: Origin`. A cross-origin read gets no CORS
header at all.

### 1.3 Error envelope and status codes

| Producer | Status | Body |
| --- | --- | --- |
| `HttpError` (`:205-207`) thrown anywhere | `error.status` | `{ "error": "<code>" }` (`:5309`) |
| `RegistryError` (`src/release_registry.js:20-26`) | `registryErrorStatus()` (`:200-208`): `503` for `d1_quota_exceeded`/`database_unavailable`, else `400` | `503` → `quotaResponse` body; else `{ "error": "<code>", "detail": "<detail|null>" }` (`:5302-5306`) |
| any other throw | `500` | `{ "error": "internal_error" }` and a `console.error` (`:5308-5309`) |
| `quotaResponse(err, extra)` (`:144-153`) | `503` + `retry-after: <seconds to next UTC midnight>` | `{ error: "d1_quota_exceeded", stale: false, detail: <first 200 chars>, retry_after_seconds: <int ≥ 1>, ...extra }` |
| `dataNotReady(detail)` (`:161-165`) | `503` + `cache-control: no-store` | `{ error: "data_not_ready", detail, generated_at: <ISO> }` |

`isQuotaError(err)` (`:139-142`) matches `/limit|7500|exceeded|quota/i` on the message.

Codes that read paths actually emit (complete list found in the read handlers):

`not_found`, `database_unavailable`, `d1_quota_exceeded`, `data_not_ready`,
`unregistered_asset_version`, `composite_version_rejected`, `release_id_required`,
`lookup_invalid`, `bundle_required`, `bundle_not_found`, `bundle_and_item_key_required`,
`release_item_not_found`, `assets_release_not_found`, `client_release_not_found`,
`release_pin_missing`, `client_items_unavailable`, `resource_not_found`, `missing_task_id`,
`task_not_found`, `invalid_task_id`, `invalid_type`, `image_asset_base_unset`,
`bundle_filter_invalid`, `search_filter_invalid`, `authentication_required`, `role_required`,
`github_client_manifest_path_invalid`, `github_client_text_dir_invalid`,
`portal_canonical_origin_invalid`, `path_invalid`, `path_not_allowed`,
`unity3d_upload_rejected` (write-adjacent path helper), `method_not_allowed` (logout only).

### 1.4 Pagination and cursors

`cursorKey()` = `"mltd-portal-cursor-v1"` (`:509-511`).

`encodeCursor(payload)` (`:531-535`):

```js
body   = JSON.stringify(payload)
digest = sha256("mltd-portal-cursor-v1:" + body)
cursor = base64url(JSON.stringify({ b: body, s: digest.slice(0, 32) }))   // 32 hex chars
```

`decodeCursor(cursor, expectedScope)` (`:537-548`) returns the payload, or **`null`** when the
base64/JSON is malformed, the digest does not match, or `payload.scope !== expectedScope`.

> **Critical generator note.** A `null` decode is *not* an error response: every handler silently
> falls back to "start from the beginning". A cursor minted for release A replayed against release
> B therefore re-serves page 1 instead of failing. Cursors are integrity-checked, not secret.

Scope strings in use:

| Scope | Emitted by |
| --- | --- |
| `assets:<release_id>` | `searchCatalogue` → `searchStaticAssets` (`:568`, `:613`, `:738`) |
| `assets:<release_id>:songs` | `getSongs` (`:1219`, `:1302`) |
| `assets:<release_id>:items` | `getAssetsReleaseItems` (`:2333-2335`, `:2362`, `:2394`) |
| `client:<release_id>:items` | `getClientReleaseItems` (`:2140`, `:2154`, `:2193`) |
| `client:releases` | `getClientReleases` (`:1969`) — **never consumed** |
| `assets:releases` | `getAssetsReleases` (`:2236`) — **never consumed** |
| `images:tasks` | `getImageTasks` / `getStaticImageTasks` (`:2891`, `:2930`, `:3016`) |

Cursor payload shapes:

* `assets:<id>` → `{ scope, bundle, item_key }`
* `assets:<id>:songs` → `{ scope, bundle }`
* `assets:<id>:items` (GitHub) → `{ scope, bundle, item_key }`
* `assets:<id>:items` (D1) → `{ scope, bundle, item_key }`
* `client:<id>:items` (GitHub) → `{ scope, item_index }` (an integer slot index)
* `client:<id>:items` (D1) → `{ scope, bundle, item_key }`
* `images:tasks` → `{ scope, task_id }`

`has_more` is always a boolean but is *derived differently* per route (documented per endpoint); it
is **not** simply "`next_cursor !== null`".

### 1.5 Page limits

`readLimit(url, fallback = DEFAULT_PAGE_LIMIT)` (`:550-554`):
`parseInt(searchParams.get("limit") || fallback, 10)`, then `min(max(n, 1), MAX_PAGE_LIMIT)`.

| Constant | Value | Line |
| --- | --- | --- |
| `DEFAULT_PAGE_LIMIT` | `20` | `:76` |
| `MAX_PAGE_LIMIT` | `100` | `:77` |
| `MAX_SCAN_ROWS` | `400` (catalogue scan budget) | `:805` |
| `CONTRIBUTION_LOOKUP_CHUNK` | `25` | `:861` |
| `STATS_CACHE_TTL` | `600000` ms | `:75` |
| `ASSETS_PORTAL_MANIFEST_CACHE_TTL` | `300000` ms | `:84` |
| `MAX_RESOURCE_LINES` | `20000` (write path) | `:100` |
| `PACKAGE_VERSION` | `"mltd-translation-portal/5"` | `:74` |

Exception: `/api/images/tasks` uses **`pageSize`**, not `limit`:
`Math.min(Math.max(parseInt(searchParams.get("pageSize") || "24", 10) || 24, 1), 100)`
(`src/worker.js:2928`). Default `24`.

### 1.6 Cache headers (verbatim)

| Endpoint | `cache-control` | extra |
| --- | --- | --- |
| `/api/health` | *(none)* | — |
| `/api/terms` | `public, max-age=3600` | — |
| `/api/stats` | `public, max-age=600, s-maxage=600` | `x-summary-source: memory\|github\|portal_summary\|release_summaries`; `etag: W/"stats-<updated_at>"` on the `portal_summary` branch |
| `/api/catalogue/search` (GitHub axis) | `public, max-age=30` | — |
| `/api/catalogue/search` (D1 axis) | *(none)* | — |
| `/api/lyrics/songs` | `public, max-age=300, s-maxage=1800` | — |
| `/api/lyrics/song` | `public, max-age=300, s-maxage=600` | — |
| `/api/{assets,client}/releases` | `public, max-age=60` | — |
| `/api/{assets,client}/releases/:ref` | `public, max-age=300` (GitHub) / `max-age=60` (D1) | — |
| `/api/{assets,client}/releases/:ref/summary` | `public, max-age=300` | — |
| `/api/{assets,client}/releases/:ref/manifest` | `public, max-age=300` (GitHub) / `max-age=60` (D1) | — |
| `/api/{assets,client}/releases/:ref/items` | `public, max-age=60` | — |
| `/api/{assets,client}/releases/:ref/item` | `public, max-age=120` | — |
| `/api/{assets,client}/releases/:ref/item/edit-context` | `no-store` | — |
| `/api/resources/:id` | `public, max-age=120` | — |
| `/api/resources/:id/history` | `public, max-age=60` | — |
| `/api/resources/:id/reuse` | `public, max-age=60` | — |
| `/api/resources/:id/edit-context` | `no-store` | — |
| `/api/images/tasks` | `public, max-age=60, s-maxage=300` | — |
| `/api/images/task` | `public, max-age=120` | — |
| `/api/images/status` | `public, max-age=60, s-maxage=300` | — |
| `/api/images/asset` (hit) | `public, max-age=3600` | `content-type` from R2 or `image/png`, `etag` from R2 `httpEtag` |
| `/api/sync/status` | `no-store` | — |

### 1.7 Identity, and which read paths need it

Every read path listed in this document is **anonymous** *except* `GET /api/sync/status`
(`requireActor(request, env, ["reviewer","admin"])`, `:2760`).

Identity is session-only: `currentActor()` (`:3161-3168`) reads the portal session cookie and never
falls back to request headers (`src/worker.js:3101-3110`). Consequence for a static generator:
`/api/sync/status` is **not** reproducible offline.

---

## 2. Endpoint-by-endpoint contract

### 2.1 `GET /api/health`

* Handler: inline object, `src/worker.js:5171`; serialized by `json()` at `:5298`.
* Query params: none. Auth: none.
* Response `200`:

```jsonc
{ "ok": true, "service": "mltd-translation-portal/5" }   // PACKAGE_VERSION, src/worker.js:74
```

* Errors: other methods → `404 not_found` (no 405).

### 2.2 `GET /api/terms`

* Handler `getTerms()` — `src/worker.js:304-312`. Auth: none.
* Query params: none.
* Response `200`, `cache-control: public, max-age=3600`:

```jsonc
{
  "terms":    [ { "source": "…", "target": "…", "category": "…" } ],   // TERMS
  "idols":    [ { "id": 1, "code": "001har", "name_ja": "…", "name_zh": "…", "type": "Princess", "color": "#e22b30" } ],
  "speakers": { "001har": { "name_ja": "…", "name_zh": "…" } }
}
```

* Derivation: the three exports of `src/terms.js` passed through unchanged
  (`TERMS` at `src/terms.js:4`, `IDOLS` at `:457`, `SPEAKERS` at `:876`). Observed shapes:
  `TERMS[] = {source,target,category}`; `IDOLS[] = {id,code,name_ja,name_zh,type,color}`;
  `SPEAKERS` = map `code → {name_ja,name_zh}`.
* **Generator note:** this is *code* data, not release data. To reproduce `/api/terms` statically the
  generator must copy the same constants (today: `public/lib/terms.js`) verbatim.

### 2.3 `GET /api/stats`

Handler `getStats` — `src/worker.js:376-498`. Auth: none. Query params: **none** (the handler never
reads the URL).

Three sources are tried in this order; the branch that answered is named in `x-summary-source`.

**Branch 1 — `memory`** (`:377-383`): an isolate-local memo `memoryStats` (module-level `let`,
`:124-125`) with a 10-minute TTL, dropped by `clearStatsMemo()` (`:112-115`).

**Branch 2 — `github`** (`:389-398`): `readGitHubAssetsPortalManifest(env)`; taken when the manifest
is non-null **and `manifest.summary_ready !== false`**. Payload =
`statsPayloadFromPortalManifest(manifest)` (`:336-374`):

```jsonc
{
  "release_kind": "assets",
  "release_id": "assets-1077650",         // manifest.release.release_id  (may be undefined → key dropped)
  "asset_version": "1077650",             // manifest.release.asset_version
  "total": 2, "translated": 1, "untranslated": 1, "pending": 0,   // statsSummaryView(manifest.totals)
  "accepted": 1,                          // = translated
  "reused_items": 0, "suggested_items": 0, "blocked_items": 0,    // totals.{reused,suggested,blocked} ?? 0
  "progress_percent": 50,                 // totals.progress_percent ?? round(translated/total*100, 2)  (0 when total = 0)
  "categories": {                         // manifest.categories[] → object keyed by entry.id
    "system_ui": {
      "id": "system_ui", "domain": "system", "…": "…",   // the whole upstream entry, spread
      "accepted": 1, "translated": 1, "pending": 0, "untranslated": 1, "progress_percent": 50
    }
  },
  "summary_updated_at": "2026-10-01T00:00:00Z",  // release.updated_at || manifest.generated_at || now()
  "summary_stale": false,
  "summary": { "total": 2, "translated": 1, "untranslated": 1, "pending": 0, "accepted": 1, "progress_percent": 50 },
  "idols": [ /* IDOLS */ ],
  "by_idol": { "001har": { /* the idol object */ } },
  "source": "github"
}
```

Normalisation rule (`statsSummaryView`, `:327-334`): each counter accepts two spellings and
defaults to `0` — `total ?? total_items`, `translated ?? translated_items`,
`untranslated ?? untranslated_items`, `pending ?? pending_items`; `accepted = translated`;
`progress_percent = source.progress_percent ?? (total > 0 ? Number(((translated/total)*100).toFixed(2)) : 0)`.

Category normalisation (`:339-351`): `accepted = entry.accepted ?? entry.translated ?? 0`;
`translated = entry.translated ?? accepted`; `pending = entry.pending ?? 0`;
`untranslated = entry.untranslated ?? 0`;
`progress_percent = entry.progress_percent ?? (entry.total > 0 ? Number(((accepted/entry.total)*100).toFixed(2)) : 0)`.
The upstream entry is spread first, so **unknown keys survive into the response**.

**Branch 3 — `portal_summary`** (`:400-443`): `SELECT release_id, asset_version, server_schema_version
FROM assets_releases WHERE status='canonical' ORDER BY updated_at DESC LIMIT 1` then
`SELECT value_json, updated_at FROM portal_summary WHERE key='stats'`. The cached stats row is only
used when it is *bound to the current canonical release*:

```js
parsed.release_id === canonical.release_id || parsed.asset_version === canonical.asset_version
```

Otherwise the branch is skipped (silently). Payload = the parsed row plus
`summary = parsed.summary || statsSummaryView(parsed)`, `accepted = parsed.accepted ?? parsed.translated ?? 0`,
`translated ?? 0`, `untranslated ?? 0`, `pending ?? 0`, `idols`, `by_idol`,
`summary_updated_at = portal_summary.updated_at`, `summary_stale = (now - Date.parse(updated_at)) > 600000`.
`etag: W/"stats-<updated_at>"`.

**Branch 4 — `release_summaries`** (`:446-493`): requires a canonical `assets_releases` row (else
`503 data_not_ready` "no canonical assets release is registered") and a
`release_summaries WHERE release_kind='assets' AND release_id=<canonical>` row (else
`503 data_not_ready`). Payload adds `server_schema_version`, `reused_items`, `suggested_items`,
`blocked_items`, and `categories = JSON.parse(category_summary_json || "{}")` (raw, **not**
normalised), `progress_percent = total_items > 0 ? Number(((translated_items/total_items)*100).toFixed(2)) : 0`.

Error mapping: `isQuotaError` → `quotaResponse` (`:495`). Note `memoryStats`/`memoryStatsTime` are
only written on branches 1–4 success, and the memo is *not* keyed by release.

### 2.4 `GET /api/catalogue/search`

Handler `searchCatalogue` — `src/worker.js:642-787`. Auth: none.

Query params:

| Name | Default | Meaning |
| --- | --- | --- |
| `query` *or* `keyword` | `""` | case-insensitive substring over `<item_key>\n<source>`; **not** trimmed in the D1 path, trimmed+lowercased in the GitHub path |
| `idol` | `""` | lowercase idol code (`001har`); matched against `detectIdol(...).code` |
| `category` | `"all"` | taxonomy id **or** domain (`story`, `card`, `dialogue`, `birth`, `system`, `lyrics`) |
| `status` | `"all"` | `accepted` \| `pending` \| `untranslated` \| `suggested` \| `blocked` \| `needs_review` … (compared literally) |
| `limit` | `20` | 1…100 |
| `cursor` | *(absent)* | opaque keyset cursor, scope `assets:<release_id>` or `<release_kind>:<release_id>` |
| `include_total` | `"false"` | `"true"`/`"1"` enables `total`, and only when **no** filter is active |
| `release_kind` | *(absent)* | `"client"` selects the Client axis; anything else (including absent) means `assets` |
| `release_id` | `""` | release id, e.g. `assets-1077650` |
| `asset_version` | `""` | bare decimal asset version; composite strings (`+`) → `400 composite_version_rejected` |
| `base_version` | `""` | legacy spelling of `asset_version`; only honoured when `release_kind` is absent |
| `lookup` | `""` | `<bundle>/<item_key>` point lookup → single `item` |

**Axis 1 — explicit `asset_version`/`release_id` on the assets axis** (`:661-670`):

```js
if ((!releaseKindParam || releaseKindParam === "assets") && (assetVersionParam || releaseIdParam)) {
  const source = await resolveReleaseSource(env, "assets", assetVersionParam || releaseIdParam);
  if (source.axis === "broken") throw pinMissingError();          // 503 release_pin_missing
  if (source.axis === "github") return searchStaticAssets(...)    // cache-control: public, max-age=30
}
```

`releaseKindParam === "client"` never enters this block, so a Client search always uses D1.

**`searchStaticAssets(request, env, manifest, release)`** — `:560-625`. Walks
`staticAssetBundles(manifest, categoryParam)` (`:1611-1624`: the sorted, de-duplicated union of
`Object.keys(category.bundles)` over the manifest's `categories[]`, filtered by
`category.id === wanted || category.domain === wanted`), skipping bundles `< cursor.bundle`, then for
each bundle reads `readGitHubAssetsBundleRows(env, release, bundle, min(MAX_SCAN_ROWS, 5000))`
(`:1632-1692`), skips rows whose `item_key` is not `> cursor.item_key` **when the bundle equals the
cursor bundle**, and applies the four filters in this order:

```js
status   : row.translation_status !== statusParam                       → drop
category : categoryParam !== cat && categoryParam !== domain            → drop
idol     : !idol || idol.code.toLowerCase() !== idolParam               → drop
query    : !`${item_key}\n${source}`.toLowerCase().includes(query)      → drop
```

Response:

```jsonc
{
  "scope": { "release_kind": "assets", "release_id": "assets-1077650" },
  "limit": 20,
  "next_cursor": "<opaque|null>",     // when has_more
  "has_more": true,                   // = !exhausted && Boolean(last match)
  "total_source": null,
  "total": null,
  "total_note": "latest Assets rows are read from the pinned GitHub locale files",
  "scanned_rows": 128,                // rows inspected before the break/exhaustion
  "scan_exhausted": false,            // true only when the bundle walk reached the end
  "scan_capped": false,               // = !exhausted && !has_more
  "filters": { "status": "all", "idol": null, "category": "all", "query": null },
  "items": [ /* StaticAssetItem, see §2.7.6 */ ],
  "rows":  [ /* the same array, aliased */ ]
}
```

Special fallback (`:598-605`): when a **status-filtered** search yields no match, the handler
recurses with `status=all` and returns that body with two extra fields:
`status_fallback: "all"` and `filters.requested_status: "<the status asked for>"`.

`MAX_SCAN_ROWS` is only consulted *after a row matches* (`:587-588`), so `scanned_rows` can exceed
400 on this axis for a sparse filter; the loop still terminates because the bundle list is finite.

**`lookup` point lookup** (`:712-721`) — same for both axes:

```jsonc
{ "scope": { "release_kind": "assets", "release_id": "assets-1077100" },
  "item":  { /* decorateCatalogueRow */ },
  "rows":  [ /* the same item */ ] }
```

When the row is absent: `{ scope, item: null }` (no `rows` key, HTTP 200). `lookup` without a `/`,
or with an empty bundle/item_key → `400 lookup_invalid`.

**D1 axis** (`:673-781`): scope resolution then a bounded keyset walk.

* Scope: `releaseKind = release_kind === "client" ? "client" : "assets"`. When no `release_id` is
  given and the axis is `assets`, an explicit `asset_version` must resolve in `assets_releases`
  (else `400 unregistered_asset_version`), otherwise the canonical row is used
  (`SELECT release_id FROM assets_releases WHERE status='canonical' ORDER BY updated_at DESC LIMIT 1`)
  and its absence is `503 data_not_ready`. No release id at all → `400 release_id_required`.
* `fetchFilteredCataloguePage` (`:893-912`) walks `fetchCataloguePage` (`:818-851`) in `limit`-sized
  seeks while `matched < limit && scanned < MAX_SCAN_ROWS`. SQL predicate:
  `(sv.bundle > ? OR (sv.bundle = ? AND sv.item_key > ?))` plus an **anchored** `sv.bundle LIKE
  '<prefix>%'` prefilter from `bundlePrefixForCategory(categoryParam)` (`:972-975`, table at
  `:955-970`). `ORDER BY sv.bundle ASC, sv.item_key ASC LIMIT ?`.
* `matchesCatalogueFilters` (`:924-947`) decides: status =
  `row.translation_status || row.contribution_status || row.ref_status || "untranslated"`;
  category = `categoryId(bundle,item_key)` id or its domain; idol = `detectIdol(...)`;
  query = case-insensitive substring over `` `${item_key}\n${source}` ``.
  `attachPendingContributions` (`:863-888`) adds `contribution_status` from `contributions` in
  chunks of 25 keyed by `(bundle,item_key,source_sha256)` for statuses
  `pending|needs_review|accepted`.
* Response (same envelope as the GitHub axis, different `total_note`):

```jsonc
{
  "scope": { "release_kind": "assets", "release_id": "assets-1077100" },
  "limit": 50,
  "next_cursor": null,
  "has_more": false,                       // = rows.length === limit && !page.exhausted
  "total_source": "release_summaries",     // or null
  "total": 12,                             // only when include_total && no filter
  "total_note": null,                      // or "total is null for a filtered query: release_summaries counts the whole release, not the filter"
  "scanned_rows": 50,
  "scan_exhausted": true,
  "scan_capped": false,                    // = !exhausted && matched < limit
  "filters": { "status": "all", "idol": null, "category": "all", "query": null },
  "items": [ /* decorateCatalogueRow */ ],
  "rows":  [ /* alias */ ]
}
```

* Row shape `decorateCatalogueRow(row, env, scope=null, release, releaseKind)` — `:1155-1185`:

```jsonc
{
  "release_kind": "assets",            // or "client"
  "release_id": "assets-1077100",      // release?.release_id || null
  "asset_version": "1077100",          // assets axis only, else null
  "client_version": null,              // client axis only, else null
  "bundle": "bundle-a",
  "item_key": "title",
  "source_sha256": "<64hex>",
  "source": "通信に失敗しました",
  "logical_key": "text/bundle-a/title",// ru.logical_key || null
  "resource_id": "res:…",              // ru.resource_id || null
  "category": "system_ui",             // detectCategory
  "category_name": "系统菜单与玩法规则",
  "domain": "system",
  "domain_name": "界面系统",
  "idol": { "code": "001har", "name_ja": "…", "name_zh": "…", "color": "#e22b30", "type": "Princess" },
  "status": "accepted",                // translation_status || contribution_status || ref_status || "untranslated"
  "translation": "通信失败",            // or null
  "reuse_mode": "none",                // exact|verified-compatible|suggested|blocked|none
  "contribution_id": null,             // always null in this build
  "github": { "target": "assets", "path": "locales/master/bundle-a.jsonl",
              "base_commit": "<40hex>", "source_sha256": "<64hex>" },   // or null
  "edit_endpoint": "/api/resources/res%3A…/edit-context"                // or null
}
```

  `github` is `null` unless all of: a 40-hex pin exists for the release
  (`releasePinnedCommit`, `:1884-1887`), `source_sha256` matches `HEX64_ANY`, `GITHUB_TARGET_*`
  parses as `owner/repo`, and the bundle has a path (`catalogueGithubBinding`, `:1137-1153`).

* `include_total` reads `release_summaries.total_items` and reports it **only** when no filter is
  active; with any filter the response carries `total: null` and the explanatory `total_note`
  (`:747-771`).

* Errors: `HttpError` propagates; quota → `503 d1_quota_exceeded` with `scope` merged into the body
  (`scope: {release_kind:"unknown", release_id:null}`, `:784`).

### 2.5 `GET /api/lyrics/songs`

Handler `getSongs` — `src/worker.js:1188-1306`. Auth: none. **D1-only**; there is no GitHub/static
branch.

| Param | Default | Meaning |
| --- | --- | --- |
| `query` *or* `keyword` | `""` | lowercased substring over `` `${name_ja}\u0000${name_zh}\u0000${asset}` `` |
| `type` | `"all"` | compared to `String(SONG_MASTER[asset].type || "All").toLowerCase()` — observed values `all`, `princess`, `fairy`, `angel` |
| `asset_version` | `env.PORTAL_DEFAULT_ASSET_VERSION` | bare decimal; composite → `400 composite_version_rejected` |
| `limit` | `20` | 1…100 |
| `cursor` | *(absent)* | scope `assets:<release_id>:songs`, payload `{scope,bundle}` |

Response `200`, `cache-control: public, max-age=300, s-maxage=1800`:

```jsonc
{
  "release_id": "assets-1077100",
  "asset_version": "1077100",
  "limit": 20,
  "total_songs": 432,          // count of bundleCounts keys starting with "scrobj_", or null when no summary row
  "next_cursor": "…",          // present iff rows.length === limit
  "songs": [{
    "bundle": "scrobj_aftspt.unity3d",
    "asset": "aftspt",         // bundle minus ^scrobj_ and .unity3d$, lowercased
    "name_ja": "アフタースクールパーリータイム",   // SONG_MASTER[asset].name_ja || asset
    "name_zh": "After School Party Time",       // SONG_MASTER[asset].name_zh || ""
    "type": "Fairy",                            // || "All"
    "mst_song_id": 14,                          // || 0
    "slots": 38,                                // summary bundle counts, or null
    "translated": 33,                           // summary bundle "accepted", or null
    "release_id": "assets-1077100"
  }]
}
```

Derivation:

* Release: `getAssetsRelease(env, assetVersion)` (`src/release_registry.js:79-91`); absent → `503
  data_not_ready` "no assets release is registered, so no song index can be built" (`:1211-1215`).
* Bundles: `SELECT DISTINCT sv.bundle FROM source_variants sv WHERE sv.release_kind='assets' AND
  sv.release_id=? AND sv.bundle LIKE 'scrobj_%' AND sv.bundle > ? ORDER BY sv.bundle ASC LIMIT ?`
  (`:1230-1234`).
* Counts: `release_summaries.category_summary_json` → for every bucket,
  `bucket.bundles[bundle]` read as `{slots, accepted}` when it is an object, or as
  `{slots: <number>, accepted: 0}` when a bucket value is a bare number (`:1249-1261`).
* `total_songs` = `Object.keys(bundleCounts).filter(b => b.startsWith("scrobj_")).length`, or `null`
  when there is no summary row (`:1298-1300`).
* `next_cursor` = encoded `{scope:`assets:<release_id>:songs`, bundle: <last *examined* bundle>}` when
  `rows.length === limit` (`:1291`, `:1301-1303`); the cursor continues the seek, not the visible page.
* Filters (`type`, `query`) run after the seek, so a page may be shorter than `limit` while
  `next_cursor` is still non-null.

Errors (`:1206-1210`, in order): a `RegistryError` whose `registryErrorStatus` is `503`
(`d1_quota_exceeded`, `database_unavailable`) → `quotaResponse` (i.e. body
`{error:"d1_quota_exceeded", …}`); an error whose `.code === "database_unavailable"` (not
necessarily a `RegistryError`) → `503 database_unavailable`; **anything else also becomes
`quotaResponse`**, i.e. any unexpected registry failure is reported as a quota problem.

### 2.6 `GET /api/lyrics/song`

Handler `getSongLyrics` — `src/worker.js:1321-1426`. Auth: none. D1-only.

| Param | Default | Meaning |
| --- | --- | --- |
| `bundle` | — (required) | e.g. `scrobj_aftspt.unity3d` |
| `asset_version` | `env.PORTAL_DEFAULT_ASSET_VERSION` | bare decimal; composite → `400 composite_version_rejected` |

Response `200`, `cache-control: public, max-age=300, s-maxage=600`:

```jsonc
{
  "bundle": "scrobj_aftspt.unity3d",
  "release_id": "assets-1077100",
  "asset_version": "1077100",
  "total_lines": 38,
  "source": "release",            // literal
  "lines": [{
    "release_id": "assets-1077100",
    "asset_version": "1077100",
    "bundle": "scrobj_aftspt.unity3d",
    "item_key": "126",
    "slot_index": 126,            // parseInt(first /\d+/ match in item_key, 10), else 0
    "source": "Make me happy いつだって",
    "source_sha256": "<64hex>",
    "logical_key": "lyrics/scrobj_aftspt/126",   // or null
    "translation": "Make me happy 无论何时",       // contribution?.translation || row.translation || null
    "status": "accepted",         // contribution?.status || translation_status || ref_status || "untranslated"
    "reuse_mode": "none"
  }]
}
```

Derivation:

* Lines come from one bundle-scoped join (`:1350-1359`) ordered
  `CAST(sv.item_key AS INTEGER) ASC, sv.item_key ASC`; `logical_key` is filled by a second bounded
  read keyed by `item_key` (`:1365-1371`).
* The pending-contribution overlay (`:1383-1394`) reads
  `SELECT item_key, source_sha256, translation, status FROM contributions WHERE bundle=? AND
  asset_version=? AND status IN ('pending','needs_review','accepted')` and is consulted **only when
  the published status is not `accepted`** (`:1399`).
* **404 behaviour:** when the release has no rows for the bundle the handler throws
  `HttpError(404, "bundle_not_found")` (`:1425`). The retired
  `public/data/lyrics/<bundle>.json` fallback (`source: "source_cache"`) is **deliberately gone** —
  see the comment at `:1419-1424` and the header comment at `:1308-1320`. The release lookup is
  wrapped so that **a quota error returns `503 d1_quota_exceeded` immediately**
  (`if (isQuotaError(err)) return quotaResponse(err)`, `:1338-1339`), while **any other** lookup
  failure is swallowed: `releaseRow` stays `null` → `releaseId` is `null` → no rows are read → the
  request ends as `404 bundle_not_found`. A missing `assets_releases` row (no throw) behaves the
  same way — this route never emits `data_not_ready`, unlike `/api/lyrics/songs`.
* Missing `bundle` → `400 bundle_required` (`:1324`).

### 2.7 The Assets release axis

Shared machinery (both axes) — **read this once, it explains every route below**:

* `resolveReleaseSource(env, kind, ref)` — `src/worker.js:1908-1920`:

```js
payload = kind === "client" ? readGitHubClientPortalManifest(env) : readGitHubAssetsPortalManifest(env)
source  = releaseSourceForRef(kind, ref, payload)          // :1868-1876
if (source.axis === "github" && !staticReleaseUsable(kind, source.release))
    return { axis: "broken", release, pin: null, kind, ref }
return { axis: "github"|"d1", release, pin, kind, ref }      // pin = releasePinnedCommit(...)
```

* `releaseSourceForRef(kind, ref, payload)` — `:1868-1876`: matches iff
  `ref === String(release.asset_version ?? "")` (client: `client_version`) **or**
  `ref === String(release.release_id ?? "")`. The release object is
  `assetsPortalManifestRelease` (`:1842-1849`) / `clientPortalManifestRelease` (`:1851-1858`) =
  `{ ...payload.release, note: release.note || "<Assets|Client> GitHub manifest (CI)", source: "github" }`.
* `releasePinnedCommit(kind, release)` — `:1884-1887`: `assets_commit` (assets) or
  `client_resources_commit` (client), trimmed + lowercased, must match `/^[0-9a-f]{40}$/i`
  (`FULL_SHA`, `:73`) else `null`.
* `staticReleaseUsable` — `:1890-1892`: `Boolean(release) && pin !== null`.
* `pinMissingError()` — `:1925-1927`: `HttpError(503, "release_pin_missing")`. **The `broken` axis is
  fail-closed**: no GitHub bytes, no D1 history, no mixed answer.
* `axis === "d1"` covers both "a genuinely old ref the manifest does not claim" and "no manifest at
  all" (`:1919`).
* Upstream manifest reader `readGitHubAssetsPortalManifest(env)` — `:1586-1609`:
  URL = `env.ASSETS_PORTAL_MANIFEST_URL || DEFAULT_ASSETS_PORTAL_MANIFEST_URL` (`:78-79`);
  `fetch` with `cf: {cacheTtl: 300, cacheEverything: true}` and `accept: application/json`;
  validation **all three** must hold, else the value is `null` and cached as `null` for 30 s:
  `payload.schema === "mltd.portal.resource-manifest/v1"`, `payload.kind === "assets"`,
  `/^\d+$/.test(String(payload?.release?.asset_version || ""))`. Success is cached 5 min in the
  module-level `assetsPortalManifestCache` (`:85`, `:1603`).
  Client equivalent `readGitHubClientPortalManifest` — `:1753-1776`: `kind === "client"` and
  `/^\d+(?:\.\d+)+$/.test(String(payload?.release?.client_version || ""))`.
* Raw row reader `readGitHubAssetsBundleRows(env, release, bundle, maxRows = 0)` — `:1632-1692`
  (details in §3.A/§3.C). Its cache `assetsBundleRowsCache` (`:88`) is keyed
  `` `${commit}:${declaredPath}|${masterPath}` `` with a 5-minute TTL (`:1687`).
* `staticAssetBundles(payload, categoryParam = "all")` — `:1611-1624`.
* `staticAssetRowStatus(row)` — `:1626-1630`: `accepted` iff `row.status === "accepted" && row.zh`;
  `pending` iff `String(row.status).toLowerCase() ∈ {pending, needs_review}` **and** `row.zh`;
  otherwise `untranslated`.
* `getStaticAssetsItemContext` — `:1724-1751`; `staticAssetsItem` — `:1694-1722`.

#### 2.7.1 `GET /api/assets/releases`

Handler `getAssetsReleases` — `:2211-2243`. Params: `limit` (default 20, 1…100). **`cursor` is
accepted by the URL but never read** — the `next_cursor` it returns cannot be replayed as input.

```jsonc
{
  "releases": [ /* D1 row (ASSETS_RELEASE_COLUMNS) or the GitHub manifest release */ ],
  "limit": 20,
  "next_cursor": "…"   // when releases.length === limit
}
```

* `ASSETS_RELEASE_COLUMNS` (`:2208-2209`): `asset_version, release_id, server_schema_version,
  status, source_manifest_sha256, assets_commit, note, created_at, updated_at, published_at`.
* D1 read: `SELECT … FROM assets_releases ORDER BY updated_at DESC, asset_version DESC LIMIT ?`
  (`:2219-2221`). If that read throws **and** a GitHub manifest release exists, the error is
  swallowed (`:2223-2225`).
* The GitHub release (`assetsPortalManifestRelease(staticManifest)`) is appended when no D1 row has
  the same `asset_version` (`:2226-2228`) — **without** a pin check, so an unusable release still
  appears here.
* Sort: `Number(b.asset_version||0) - Number(a.asset_version||0) || String(b.updated_at||"").localeCompare(a.updated_at)`
  then `splice(limit)`.
* Errors: quota → `503 d1_quota_exceeded`; other D1 errors propagate only when there is no GitHub
  release to show.

#### 2.7.2 `GET /api/assets/releases/:ref`

Handler `getAssetsReleaseDetail` — `:2245-2262`. Params: none (`:ref` is the only input).

* GitHub axis → `200 { "release": { ...manifest.release, note, source: "github" } }`, `max-age=300`.
* Broken axis → `503 release_pin_missing`.
* D1 axis → `SELECT <ASSETS_RELEASE_COLUMNS> FROM assets_releases WHERE release_id=? OR asset_version=? LIMIT 1`;
  missing → `404 assets_release_not_found`; else `200 { "release": <row> }`, `max-age=60`.
* Quota → `503 d1_quota_exceeded`.

#### 2.7.3 `GET /api/assets/releases/:ref/summary`

Handler `getAssetsReleaseSummary` — `:2264-2319`.

* Broken axis → `503 release_pin_missing`.
* GitHub axis (`:2267-2285`) → `200`, `max-age=300`:

```jsonc
{
  "release_kind": "assets",
  "release_id": "assets-1077650",          // staticManifest.release.release_id
  "summary_ready": true,
  "total_items": 2,                        // totals.total || 0
  "translated_items": 1,                   // totals.translated || 0
  "pending_items": 0,                      // totals.pending || 0
  "untranslated_items": 1,                 // totals.untranslated || 0
  "reused_items": 0,                       // totals.reused || 0
  "suggested_items": 0,                    // totals.suggested || 0
  "blocked_items": 0,                      // totals.blocked || 0
  "categories": [ /* staticManifest.categories || []  — the raw upstream array */ ],
  "source": "github",
  "updated_at": "2026-10-01T00:00:00Z"     // staticManifest.release.updated_at || now()
}
```

* D1 axis: resolves `release_id` from `assets_releases` (`release_id=? OR asset_version=?`) and reads
  `release_summaries WHERE release_kind='assets' AND release_id=?`.
  * missing row → `503`, `cache-control: no-store`, body
    `{ release_kind:"assets", release_id, summary_ready:false, error:"data_not_ready",
       detail:"release_summaries has no row for this assets release yet", generated_at }`.
  * present → `200`, `max-age=300`, body `{ release_kind, release_id, summary_ready:true, ...row,
    categories: safeJson(row.category_summary_json) }` — i.e. the raw
    `release_summaries` columns **plus** a parsed `categories` object. Note `category_summary_json`
    itself is *also* present (spread), unlike the GitHub branch.
* `safeJson(value)` (`:2405-2407`) returns `{}` on parse failure.

#### 2.7.4 `GET /api/assets/releases/:ref/manifest`

Handler `getAssetsReleaseManifest` — `:1929-1944`.

* GitHub axis → **the entire upstream `portal-resource-manifest.json` verbatim** plus
  `source: "github"` (`{ ...payload, source: "github" }`), `max-age=300`. This is the only way to see
  the whole manifest through the API.
* Broken axis → `503 release_pin_missing`.
* D1 axis → `SELECT <ASSETS_RELEASE_COLUMNS> FROM assets_releases WHERE release_id=? OR asset_version=? LIMIT 1`;
  missing → `404 assets_release_not_found`; then `readReleaseSummary(env,"assets",row.release_id)`
  (`:1551-1558`) and `readImageManifestSummary(env)` (`:1560-1566`), and the response is
  `buildResourceManifest({kind:"assets", release, summary, imageSummary})` (`:1456-1547`),
  `max-age=60`.
  Explicitly **no `portal_summary['stats']` fallback** (`:1938-1940`).

`buildResourceManifest` output (the D1-axis manifest shape):

```jsonc
{
  "schema": "mltd.portal.resource-manifest/v1",
  "kind": "assets",                      // or "client"
  "generated_at": "<summary.updated_at or now()>",
  "summary_ready": true,                 // Boolean(summary)
  "release": { /* the release row, spread; null when release is null */ },
  "totals": {                            // null when summary is null
    "total": 12, "translated": 4, "pending": 3, "untranslated": 5,
    "reused": 2, "suggested": 1, "blocked": 0
  },
  "domains": [{ "id": "lyrics", "name": "歌曲歌词", "icon": "🎵",
                "total": 8, "accepted": 3, "progress_percent": 37.5,
                "categories": ["lyrics"] }],
  "categories": [{
    "id": "lyrics", "domain": "lyrics", "name": "全曲打歌歌词",
    "description": "按正式 Assets 曲目束逐行对照与翻译",
    "icon": "🎵", "unit": "句", "entry": "lyrics",
    "total": 8, "accepted": 3, "pending": 2, "untranslated": 3,
    "progress_percent": 37.5,
    "bundles": { /* copied verbatim from summary.categories[id].bundles */ }
  }],
  "source": { "summary": "release_summaries",
              "manifest_sha256": "<release.source_manifest_sha256 || release.manifest_sha256 || null>" }
}
```

Derivation notes (`:1456-1547`):

* Categories iterate `Object.entries(summary.categories)` in **insertion order** and label each with
  `CATEGORY_RULES[id]` (`src/categories.js:8-24`) or a synthetic fallback `{domain:"system",
  name:id, description:"当前 release manifest 登记的分类", domain_name:"界面系统", icon:"📦",
  unit:"句", entry:"studio"}`.
* `untranslated = Math.max(0, total - accepted - pending)`;
  `progress_percent = Number(value.progress_percent || (total ? ((accepted/total)*100).toFixed(2) : 0))`
  — `entry.progress_percent` wins verbatim when truthy, otherwise the computed value is a *rounded to
  2 dp* number (the `toFixed` string is wrapped in `Number(...)`, `:1486`).
* `accepted = Number(value?.accepted || 0)` — note this is `accepted`, **not** `translated`
  (`:1473`); the manifest's `categories[]` and the D1 `category_summary_json` buckets agree on that
  key name, `statsPayloadFromPortalManifest` (`:340`) is the one that also accepts `translated`.
* When `kind === "assets"` and an image summary exists, one synthetic category per known image
  category is appended after the text categories (`:1491-1505`), with `accepted/pending/
  untranslated/progress_percent: null` and `bundles: {}`. Rules (`IMAGE_MANIFEST_RULES`,
  `:1440-1444`): `event → img_event`, `costume → img_costume`, `tutorial → img_tutorial`; unknown
  image categories are skipped.
* Domain rollup: one entry per distinct `category.domain`, in first-seen order, from
  `MANIFEST_DOMAIN_META` (`:1446-1454`: `lyrics/story/card/dialogue/birth/system/images`),
  `progress_percent = total ? Number(((accepted/total)*100).toFixed(2)) : 0` (a **number** here).

#### 2.7.5 `GET /api/assets/releases/:ref/items`

Handler `getAssetsReleaseItems` — `:2321-2403`.

Params: `limit` (default 20, 1…100), `cursor` (scope `assets:<github release_id>:items` on the GitHub
axis, `assets:<resolved release_id>:items` on D1).

**GitHub axis** (`:2339-2368`) → `200`, `max-age=60`:

```jsonc
{
  "release_id": "assets-1077650",
  "limit": 10,
  "next_cursor": "…",         // when has_more
  "has_more": true,
  "items": [ /* StaticAssetItem */ ],
  "source": "github"
}
```

Walk: for each bundle of `staticAssetBundles(staticManifest)` (all categories, sorted), skip bundles
`< after.bundle`; read `readGitHubAssetsBundleRows(env, release, bundle, Math.max(limit*4, 200))`;
within the cursor bundle skip rows whose `item_key` is not `> after.item_key`
(`localeCompare(..., {numeric:true})`); stop as soon as `items.length >= limit` and set
`hasMore = true`. `next_cursor` = `{scope, bundle: last.bundle, item_key: last.item_key}`.

**D1 axis** (`:2370-2398`) → `200`, `max-age=60`:

```jsonc
{
  "release_id": "assets-1077100",
  "limit": 20,
  "next_cursor": "…",         // when items.length === limit
  "has_more": true,           // = items.length === limit
  "items": [{
    "source_variant_id": "sv:assets:assets-1077100:bundle-a:title",
    "bundle": "bundle-a",
    "item_key": "title",
    "source_sha256": "<64hex>",
    "logical_key": "text/bundle-a/title",
    "reuse_mode": "none",
    "reused_from_release_id": null,
    "status": "accepted",
    "translation": "通信失败",
    "translation_id": "tu:text:zh-CN:text/bundle-a/title:<sha>"
  }]
}
```

> **The D1 page deliberately omits `source`** (`:2187-2188` explains why). The GitHub page uses the
> entirely different `StaticAssetItem` shape. A generator that wants one uniform item shape must
> normalise both.

#### 2.7.6 `GET /api/assets/releases/:ref/item`

Handler `getReleaseItemDetail(request, env, "assets", ref)` — `:2410-2496`.

Params: `bundle` (required), `item_key` *or* `key` (required). Missing either → `400
bundle_and_item_key_required`.

* Broken axis → `503 release_pin_missing`.
* GitHub axis (`:2419-2430`): finds the row in the first 5000 rows of the bundle, else
  `404 release_item_not_found`. Response `200`, `max-age=120`:

```jsonc
{
  "release_kind": "assets",
  "release_id": "assets-1077650",
  "item": { /* StaticAssetItem, §2.7.6b */ },
  "other_release_variants": [],
  "reuse_rule": "Assets rows are pinned to the GitHub release commit; reuse requires the same source hash"
}
```

* Otherwise the registry path (`:2453-2490`): the release row is read through
  `getAssetsRelease`/`getClientRelease` (so `github.base_commit` is pinned), then
  `fetchCatalogueRow` (`:789-800`), then the cross-release variants query

```sql
SELECT sv.source_variant_id, sv.release_kind, sv.release_id, sv.source_sha256, sv.source, sv.created_at
FROM source_variants sv JOIN resource_units ru ON ru.resource_id = sv.resource_id
WHERE ru.logical_key = ? AND NOT (sv.release_kind = ? AND sv.release_id = ?)
ORDER BY sv.created_at DESC LIMIT 20
```

  each variant annotated with `same_source_sha256: <bool>` and `reusable: <bool>` (both
  `variant.source_sha256 === row.source_sha256`, `:2476-2482`), and `reuse_rule` =
  `"exact reuse requires an identical logical_key, resource_kind, locale and source_sha256; a
  different source hash is never auto-reused"`.
* `item` = `decorateCatalogueRow(...)`. Missing row → `404 release_item_not_found`
  (`assets_release_not_found`/`client_release_not_found` when the release itself is unknown — thrown
  earlier by `getAssetsRelease`'s `404` at `:1937`/`:2260`).

##### 2.7.6b `StaticAssetItem` — `staticAssetsItem(env, release, row)` — `:1694-1722`

```jsonc
{
  "release_kind": "assets",
  "release_id": "assets-1077650",
  "asset_version": "1077650",
  "bundle": "bundle-a",
  "item_key": "k1",
  "source_sha256": "<64hex>",
  "logical_key": "<row.logical_key || 'bundle-a:k1'>",
  "category": "system_ui",
  "category_name": "系统菜单与玩法规则",
  "domain": "system",
  "domain_name": "界面系统",
  "status": "accepted",                    // row.translation_status || "untranslated"
  "translation": "译文一",                  // row.translation || null
  "source": "原文一",
  "resource_id": null,                     // always null
  "idol": { "code": "…", "name_ja": "…", "name_zh": "…", "color": "…", "type": "…" },  // or null
  "github": { "target": "assets", "path": "locales/master/bundle-a.jsonl",
              "base_commit": "<40hex>", "source_sha256": "<64hex>" },                  // or null
  "edit_endpoint": "/api/assets/releases/assets-1077650/item/edit-context?bundle=bundle-a&item_key=k1"
}
```

Note the shape difference from `decorateCatalogueRow`: no `reuse_mode`, no `contribution_id`, no
`client_version`, and `resource_id` is hard-coded `null`.

#### 2.7.7 `GET /api/assets/releases/:ref/item/edit-context`

Handler `getStaticAssetsItemContext` — `:1724-1751`. Params: `bundle` (required), `item_key` *or*
`key` (required). `bundle`/`item_key` missing → `400 bundle_and_item_key_required`.

* Broken axis → `503 release_pin_missing`.
* **Only the GitHub axis is handled**: when the ref resolves to D1, `release` is `null` → `404
  assets_release_not_found` (`:1727-1728`), even though `/api/resources/:id/edit-context` would work
  for the same row.
* Row lookup: first 5000 rows of the bundle; not found → `404 release_item_not_found`.
* If `staticAssetsItem(...).github` is `null` → `200 { "editable": false, "reason":
  "assets_manifest_binding_unavailable" }`.
* Else `200`, `cache-control: no-store`:

```jsonc
{
  "editable": true,
  "github": { "target": "assets", "path": "locales/master/bundle-a.jsonl",
              "base_commit": "<40hex>", "source_sha256": "<64hex>" },
  "logical_key": "…",
  "bundle": "bundle-a",
  "item_key": "k1",
  "row_kind": "jsonl_row",           // literal
  "resource_kind": "text",           // literal
  "source": "原文一",
  "translation": "译文一",
  "translation_status": "accepted",
  "asset_version": "1077650",
  "client_version": null
}
```

### 2.8 The Client release axis

`CLIENT_RELEASE_COLUMNS` (`:1946-1948`): `release_id, client_version, abi, base_apk_sha256,
client_resources_commit, manifest_sha256, output_apk_sha256, release_url, status, created_at,
published_at`. All seven routes exist and behave as the assets counterparts except for the points
below; a Client release **never** carries an `asset_version` (`:1428-1434`).

#### 2.8.1 `GET /api/client/releases`

Handler `getClientReleases` — `:1950-1976`. Param: `limit` (default 20). **`cursor` is never read**
(same wart as the assets list, `:1966-1970`).

```jsonc
{ "releases": [ /* CLIENT_RELEASE_COLUMNS row or the client manifest release */ ],
  "limit": 20, "next_cursor": "…" }
```

* D1: `SELECT <CLIENT_RELEASE_COLUMNS> FROM client_releases ORDER BY created_at DESC LIMIT ?`.
* The GitHub release (`clientPortalManifestRelease`) is appended when no row shares its `release_id`
  (again without a pin check), then the list is sorted by
  `String(b.client_version||"").localeCompare(String(a.client_version||""), undefined, {numeric:true})
  || String(b.created_at||"").localeCompare(String(a.created_at||""))` and truncated to `limit`.
* Client-side effect visible in the tests: `asset_version` is `undefined` on a client row and
  `client_version` is `undefined` on an assets row (`test_sync.mjs:941-942`).

#### 2.8.2 `GET /api/client/releases/:ref`

Handler `getClientReleaseDetail` — `:1978-1995`. GitHub axis → `{ "release": {..., source: "github"} }`,
`max-age=300`. Broken → `503 release_pin_missing`. D1 → `client_releases WHERE release_id=?` via
`getClientRelease` first (which also accepts a bare `client_version`, `src/release_registry.js:174-196`),
`404 client_release_not_found` when absent.

#### 2.8.3 `GET /api/client/releases/:ref/summary`

Handler `getClientReleaseSummary` — `:2002-2054`. Identical to the assets summary except
`release_kind: "client"`, `release_id` comes from `staticManifest.release.release_id`, and the
`503 data_not_ready` detail is `"release_summaries has no row for this client release yet"`.

#### 2.8.4 `GET /api/client/releases/:ref/manifest`

Handler `getClientReleaseManifest` — `:1568-1584`. GitHub axis → the entire upstream client
`portal-resource-manifest.json` plus `source: "github"`, `max-age=300`. Broken → `503
release_pin_missing`. D1 → `buildResourceManifest({kind:"client", release, summary})` with **no**
image summary, `max-age=60`; `404 client_release_not_found` when the row is missing.

#### 2.8.5 `GET /api/client/releases/:ref/items`

Handler `getClientReleaseItems` — `:2124-2202`. Params: `limit` (default 20), `cursor`.

*GitHub axis* (`:2135-2164`) — slots come from the pinned bottom-bar manifest:

```jsonc
{
  "release_id": "client-9.0.429-arm64",
  "limit": 1,
  "next_cursor": "…",                  // when selected.length === limit
  "has_more": true,                    // = selected.length === limit && start + selected.length < slots.length
  "items": [ /* ClientStaticItem */ ],
  "source": "github"
}
```

Cursor payload is `{ scope: "client:<release_id>:items", item_index: <int> }`; the next page starts at
`item_index + 1` (`:2145-2146`). If the pinned manifest is unavailable or has no slots →
`503 client_items_unavailable` (`:2163`) — **never** a fallback to unpinned bytes.

*D1 axis* (`:2166-2201`): resolves the release id via `getClientRelease` (falling back to the raw
`ref`), then the same keyset SQL as the assets axis but with `release_kind='client'`, returning raw
rows `{source_variant_id, bundle, item_key, source_sha256, logical_key, reuse_mode,
reused_from_release_id, status, translation, translation_id}` and **no `source` field**.

##### 2.8.5b `ClientStaticItem` — `clientStaticItem(env, release, slot)` — `:2060-2089`

```jsonc
{
  "release_kind": "client",
  "release_id": "client-9.0.429-arm64",
  "client_version": "9.0.429",
  "bundle": "manifests/bottom-bar.manifest.json",   // hard-coded
  "item_key": "0",                                  // String(slot.index)
  "source_sha256": "<sha256 of slot.ja>",
  "logical_key": "client:bottom-bar:0",             // clientStaticItemIdentity, :2056-2058
  "category": "system_ui",                          // hard-coded
  "category_name": "系统菜单与玩法规则",              // hard-coded
  "domain": "master",                               // hard-coded  ← see §5 contradiction
  "domain_name": "系统与主界面",                      // hard-coded  ← see §5 contradiction
  "status": "accepted",                             // translated ? "accepted" : "untranslated"
  "translation": "剧场",                             // slot.zh ?? slot.translation ?? null
  "source": "劇場",                                  // String(slot.ja)
  "resource_id": null,
  "github": { "target": "client", "path": "manifests/bottom-bar.manifest.json",
              "base_commit": "<40hex>", "source_sha256": "<64hex>" },   // or null
  "edit_endpoint": "/api/client/releases/client-9.0.429-arm64/item/edit-context?bundle=manifests%2Fbottom-bar.manifest.json&item_key=0"
}
```

The source hash is **always recomputed** from `slot.ja` with `sha256()` (`:2063`); a `source_sha256`
key on the slot is ignored.

#### 2.8.6 `GET /api/client/releases/:ref/item`

Handler `getReleaseItemDetail(..., "client", ref)` — `:2433-2451` for the GitHub axis: requires
`bundle === "manifests/bottom-bar.manifest.json"` **and** `/^\d+$/.test(item_key)`; otherwise it
falls through to the D1 path (`:2453+`). Responses:

* GitHub slot found → `{ release_kind:"client", release_id, item: ClientStaticItem,
  other_release_variants: [], reuse_rule: "client manifest slots are pinned to the release commit;
  reuse requires the same source hash" }`, `max-age=120`.
* Pinned manifest unavailable → `503 client_items_unavailable`; slot absent → `404
  release_item_not_found`.
* Broken axis → `503 release_pin_missing` (`:2435`).
* D1 → same as the assets variant, with `release_kind: "client"`.

#### 2.8.7 `GET /api/client/releases/:ref/item/edit-context`

Handler `getClientStaticItemContext` — `:2091-2122`.

Params: `item_key` *or* `key`, and `bundle`. Validation is strict (`:2100-2102`):
`bundle` must equal exactly `manifests/bottom-bar.manifest.json` and `item_key` must match `/^\d+$/`,
else `400 bundle_and_item_key_required` (a misleading code for a wrong bundle).
Broken axis → `503 release_pin_missing`; D1 axis → `404 client_release_not_found`;
no pinned slots → `503 client_items_unavailable`; slot not found → `404 release_item_not_found`.

Response (`:2108-2121`), `cache-control: no-store`:

```jsonc
{
  "editable": true,
  "github": { "target": "client", "path": "manifests/bottom-bar.manifest.json",
              "base_commit": "<40hex>", "source_sha256": "<64hex>" },
  "logical_key": "client:bottom-bar:0",
  "bundle": "manifests/bottom-bar.manifest.json",
  "item_key": "0",
  "row_kind": "manifest_slot",        // literal
  "resource_kind": "text",            // literal
  "source": "劇場",
  "translation": "剧场",
  "translation_status": "accepted",
  "asset_version": null,
  "client_version": "9.0.429"
}
```

When the binding is unavailable:
`{ "editable": false, "reason": "client_manifest_binding_unavailable",
   "detail": "Client manifest path or commit is not configured" }` (`:2107`).

#### 2.8.8 `clientItemsManifestUrl(env, commit)` — `:1826-1840`

Resolution order for the pinned slot file:

1. `env.CLIENT_ITEMS_MANIFEST_URL` if set, and if it matches
   `^(https://raw\.githubusercontent\.com/[^/]+/[^/]+/)([^/]+)(/.*)$` the **`<ref>` segment is
   rewritten to `commit`**; any other shape (e.g. a `data:` URL in tests) is used verbatim.
2. Otherwise `https://raw.githubusercontent.com/<owner>/<repo>/<commit>/<path>` where
   `owner/repo` comes from `GITHUB_TARGET_CLIENT` (fallback `kohakunamori/MLTDTranslationClient`)
   and `path` from `clientManifestPath(env)` (fallback `manifests/bottom-bar.manifest.json`).

### 2.9 `/api/resources/*` (universal resource reads, D1-only)

These four routes are D1-only: they have no GitHub/static branch, so a static generator must decide
how to represent them (or omit them).

#### 2.9.1 `GET /api/resources/:id`

`getResourceDetail` — `:2502-2521`. Response `200`, `max-age=120`:

```jsonc
{
  "resource": { "resource_id": "res:…", "resource_kind": "text", "logical_key": "text/bundle-a/title",
                "category": null, "created_at": "<ISO>" },                 // SELECT * resource_units
  "variants": [{ "source_variant_id": "sv:…", "resource_id": "res:…", "release_kind": "assets",
                 "release_id": "assets-1077100", "source_sha256": "<64hex>",
                 "source": "通信に失敗しました", "bundle": "bundle-a", "item_key": "title",
                 "created_at": "<ISO>" }]                                    // SELECT * source_variants, created_at DESC LIMIT 50
}
```

`resource_kind` enum (schema.sql:112): `text | lyrics | image | unity3d`.
**Every error — including “not found” — is remapped**: `HttpError` re-thrown as-is, anything else
becomes `503 database_unavailable` (`:2517-2520`).

#### 2.9.2 `GET /api/resources/:id/history`

`getResourceHistory` — `:2523-2541`. Response `200`, `max-age=60`:

```jsonc
{
  "resource_id": "res:…",
  "logical_key": "text/bundle-a/title",
  "history": [{ "id": "…", "actor_email": "…", "action": "…", "object_type": "…", "object_id": "…",
                "detail_json": "…", "created_at": "<ISO>" }]     // SELECT * audit_events
}
```

Query: `WHERE object_id = ? OR detail_json LIKE '%<logical_key>%' ORDER BY created_at DESC LIMIT 50`
(`:2528-2530`). `404 resource_not_found` when the unit is absent; any other failure → `503
database_unavailable`.

#### 2.9.3 `GET /api/resources/:id/reuse`

`getResourceReuse` — `:2543-2571`. Response `200`, `max-age=60`:

```jsonc
{
  "resource_id": "res:…",
  "logical_key": "text/bundle-a/title",
  "translations": [ /* SELECT * translation_units WHERE logical_key=? ORDER BY updated_at DESC LIMIT 50 */ ],
  "release_bindings": [ /* rrr.* + sv.release_kind, sv.release_id, sv.source_sha256
                           WHERE sv.resource_id=? ORDER BY rrr.updated_at DESC LIMIT 50 */ ]
}
```

`translation_units` columns (schema.sql:131-144): `translation_id, logical_key, resource_kind,
locale, source_sha256, translation, status, contributor_email, reviewer_email, created_at,
updated_at`; `status ∈ pending|accepted|rejected|needs_review|suggested|blocked`.
`release_resource_refs` columns (schema.sql:146-157): `id, release_kind, release_id,
source_variant_id, translation_id, reuse_mode, reused_from_release_id, status, created_at,
updated_at`; `reuse_mode ∈ exact|verified-compatible|suggested|blocked|none`.

#### 2.9.4 `GET /api/resources/:id/edit-context`

`getResourceEditContext` → `editContextForResource(env, resourceId)` — `:3246-3342`; `no-store`.

Algorithm:

1. No `env.DB` → `503 database_unavailable`.
2. `SELECT * FROM resource_units WHERE resource_id=?`; absent → `404 resource_not_found`.
3. `targetsForResourceKind(resource_kind)` (`:3239-3244`): `text|lyrics → ["assets","client"]`,
   `image|unity3d → ["assets"]`, anything else → `[]` →
   `{ editable:false, reason:"resource_kind_not_editable", detail:"resource_kind=<kind>" }`.
4. Pick the variant: `SELECT * FROM source_variants WHERE resource_id=? AND release_kind IN (…)
   ORDER BY CASE release_kind WHEN 'client' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`; none →
   `{editable:false, reason:"missing_binding", detail:"no source variant for this resource on the
   assets/client axis"}`.
5. `resolveReleaseSource(env, target, variant.release_id)`; broken → `503 release_pin_missing`.
   GitHub axis wins; otherwise the D1 registry row is read.
6. No pin → `{ editable:false, reason:"missing_base_commit", detail:"client_releases.
   client_resources_commit is unset or not a commit sha for <id>" | "assets_releases.assets_commit
   is unset for <id>" }`.
7. Path: client → `clientTextPathForBundle(env, variant.bundle)`; assets →
   `localesPathForBundle(variant.bundle, variant.item_key)`. `null` →
   `{ editable:false, reason:"missing_path", detail:"the client repository's layout is not declared
   (set GITHUB_CLIENT_MANIFEST_PATH or GITHUB_CLIENT_TEXT_DIR to the verified location)" |
   "bundle <b> has no place in the exporter's locales/ layout" }`.
8. Translation lookup: `SELECT translation, status, source_sha256 FROM translation_units WHERE
   logical_key=? AND resource_kind=? AND locale='zh-CN' AND source_sha256=? LIMIT 1` — the stored
   hash must equal the variant's; a quota error short-circuits to
   `{editable:false, reason:"quota", detail:"read budget exhausted"}`.

Success body:

```jsonc
{
  "editable": true,
  "github": { "target": "assets", "path": "locales/master/bundle-a.jsonl",
              "base_commit": "<40hex>", "source_sha256": "<lowercased variant hash>" },
  "logical_key": "text/bundle-a/title",
  "bundle": "bundle-a",
  "item_key": "title",
  "row_kind": "jsonl_row",          // = isClient && /\.json$/i.test(path) ? "manifest_slot" : "jsonl_row"
  "resource_kind": "text",
  "source": "通信に失敗しました",
  "translation": "通信失败",          // or null
  "translation_status": "accepted",  // or null
  "asset_version": "1077100",        // client → null
  "client_version": null             // assets → null
}
```

`resourceIdFor(env, logicalKey, resourceKind)` (`:3352-3357`) is defined but **not used by any read
route** — it exists for the write path.

### 2.10 `/api/images/*`

Enums and constants:

* `IMAGE_STATUSES` — `:2805`: `{ "untranslated", "not_needed", "restored", "accepted" }` (matches the
  `image_status_overrides.status` CHECK, schema.sql:212).
* `IMAGE_ASSET_KEYS` — `:3064-3068`:
  `composite → images/composite/<id>/source-composite.png`,
  `restored → images/restored/<id>/restored-texture.png`,
  `model → images/restored/<id>/edited-composite-model.png`.
  The `<id>` is `encodeURIComponent(taskId)`.
* `readStaticImageTaskManifest(request, env)` — `:2848-2864`: requires `env.ASSETS.fetch`; fetches
  `new URL("/data/image_tasks.json", request.url)` through the **static assets binding**; requires
  `Array.isArray(payload.tasks)`; success cached 60 s, failure cached as `null` for 10 s
  (`imageTaskManifestCache`, `:2846`).
* `readImageStatusOverride(env, taskId)` — `:2813-2825` (single PK read, `null` on any error) and
  `readImageStatusOverrides(env)` — `:2827-2837` (whole table; empty map when `env.DB` is absent).

#### 2.10.1 `GET /api/images/tasks`

Handler `getImageTasks` — `:2922-3027`; static branch `getStaticImageTasks` — `:2866-2901`.

| Param | Default | Meaning |
| --- | --- | --- |
| `pageSize` | `24` | 1…100 (**not** `limit`) |
| `category` | `"all"` | static: exact `task.category`; D1: SQL `category = ?` |
| `bundle` | `""` | lowercased; static and D1 both compare lowercased equality |
| `search` | `""` | lowercased; matches `task_id` **or** `bundle` (exact, not substring) |
| `status` | `"all"` | one of the four statuses |
| `cursor` | *(absent)* | scope `images:tasks`, payload `{scope, task_id}` |

**Static branch** (`getStaticImageTasks`) — used whenever `/data/image_tasks.json` is readable;
`200`, `cache-control: public, max-age=60, s-maxage=300`:

```jsonc
{
  "limit": 24,
  "next_cursor": "…",                 // iff seeked.length > limit
  "has_more": true,                   // = seeked.length > limit
  "categories": { "all": 1109, "event": 768, "costume": 219, "tutorial": 122 },   // manifest.categories || null
  "total": 1109,                      // Number(manifest.total || manifest.tasks.length)
  "counts_truncated": false,          // hard-coded false on this branch
  "summary_updated_at": null,         // manifest.generated_at || null
  "tasks": [ /* task + has_alpha: Boolean(...) + status: override || task.status || "untranslated" */ ],
  "source": "static_manifest"
}
```

Pipeline (`:2872-2887`): `map` (coerce `has_alpha`, apply overrides) → `filter` category → bundle →
search → status → `sort` by `String(task_id).localeCompare(...)` → seek (`task_id > after`) →
`slice(0, limit)`. The status filter runs **before** the seek on this branch, so `next_cursor` names
the last *visible* task.

**D1 branch** (`:2934-3026`) — `200`, same cache header:

```jsonc
{
  "limit": 24,
  "next_cursor": "…",        // iff examined.length === limit && last
  "has_more": true,          // = the same condition
  "categories": { "event": 768, "costume": 218, "tutorial": 122 },   // summary.counts or null
  "total": 1108,             // sum of counts, or null when no summary
  "counts_truncated": false, // categories?.truncated === true
  "summary_updated_at": "<portal_summary.updated_at>",
  "tasks": [{
    "task_id": "…", "bundle": "…", "category": "event",
    "width": 576, "height": 324, "image_format": "png",
    "has_alpha": true,                 // Boolean(image_task_units.has_alpha)
    "r2_key": "images/composite/<id>/source-composite.png",
    "source_sha256": "<64hex>",
    "status": "untranslated"           // override || "untranslated"  ← note: no static fallback to task.status
  }]
}
```

* SQL: `SELECT task_id, bundle, category, width, height, image_format, has_alpha, r2_key,
  source_sha256 FROM image_task_units WHERE task_id > ? [AND category = ?] [AND LOWER(bundle) = ?]
  [AND (LOWER(task_id) = ? OR LOWER(bundle) = ?)] ORDER BY task_id ASC LIMIT ?` (`:2956-2959`).
* `categories` = `portal_summary['image_categories']` (`:2968-2989`): `parsed.counts` when it is an
  object, else the parsed object itself; only entries whose value is a number or a digit string
  survive; `categories = null` when nothing meaningful remains.
* `total` = `Object.values(counts).reduce(sum)` (`:3020`) — so a bare map that contains an `all` key
  double-counts.
* The status filter runs **after** the seek, and `seekCursorRow(examined, visible)` (`:2917-2920`)
  makes `next_cursor` name the last row the caller actually *saw*, or the last examined row when the
  page was filtered empty.
* `%` in `bundle` or `search` → `400 bundle_filter_invalid` / `400 search_filter_invalid`
  (`:2942-2943`); `_` is allowed.
* No `env.DB` → `503 database_unavailable`; quota → `503 d1_quota_exceeded`.

#### 2.10.2 `GET /api/images/task`

Handler `getImageTaskDetail` — `:3029-3062`. Param: `id` (required → `400 missing_task_id`).

* Static manifest readable and contains the id → `200 { "task": { …task, has_alpha: Boolean(…),
  status: override || task.status || "untranslated" }, "source": "static_manifest" }`, `max-age=120`.
* Otherwise D1 (`image_task_units` by PK): missing → `404 task_not_found`; found →
  `{ "task": { …row, has_alpha: Boolean(…), status: override || "untranslated" } }` — **no `source`
  key** and, unlike the static branch, no fallback to a stored `status`.
* No `env.DB` after a static miss → `503 database_unavailable`.

#### 2.10.3 `GET /api/images/asset`

Handler `getImageAsset` — `:3070-3095`. Params: `task_id` (validated by
`/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/`, else `400 invalid_task_id`), `type`
∈ `composite|restored|model`, else `400 invalid_type`. `download=1` (used by `public/app.js:2251`)
is **ignored**.

* With `env.PUBLICATION_BUCKET.get` and the object present → `200` with the R2 body,
  `content-type` = `object.httpMetadata.contentType || "image/png"`,
  `cache-control: public, max-age=3600`, `etag` = `object.httpEtag` when present.
* Otherwise, if `env.IMAGE_ASSET_BASE` is set → `302` `Location: <base without trailing slashes>/<objectKey>`.
* Otherwise → `503 image_asset_base_unset`.

#### 2.10.4 `GET /api/images/status`

Handler `getImageStatusOverrides` — `:2839-2844`. No params, no auth, never fails:

```jsonc
{ "overrides": { "img_task_000": "not_needed" } }     // task_id → one of IMAGE_STATUSES
```

`cache-control: public, max-age=60, s-maxage=300`. Note: `POST /api/images/status` is retired → `410`.

### 2.11 `GET /api/sync/status`

Handler `getSyncStatus` — `:2759-2788`. **Auth required**: `requireActor(request, env,
["reviewer","admin"])` (`:2760`) → `401 authentication_required` without a session,
`403 role_required` with the wrong role. `!env.DB && !env.PUBLICATION_BUCKET` → `503
database_unavailable`. `cache-control: no-store`.

```jsonc
{
  "queue": { "queued": 3, "completed": 12 },       // GROUP BY sync_jobs.status
  "jobs": [{ "job_id": "…", "repository": "owner/repo", "target_kind": "assets|client",
             "commit_sha": "…", "status": "queued|running|completed|failed|retrying",
             "attempts": 0, "max_attempts": 3, "rows_written": 0, "error_message": null,
             "next_retry_at": null, "created_at": "…", "updated_at": "…" }],   // LIMIT 50
  "cursors": [{ "repository": "…", "ref": "…", "commit_sha": "…", "rows_written": 0,
                "processed_at": "…" }],                                        // LIMIT 20
  "deliveries": [{ "delivery_id": "…", "repository": "…", "event_type": "…",
                   "status": "received|processing|completed|ignored|failed",
                   "ignored_reason": null, "commit_sha": "…", "created_at": "…",
                   "processed_at": null }],                                    // LIMIT 20
  "consumer": { "mode": "scheduled", "cron": "manual", "batches_per_tick": 3 }
}
```

Constants: `SYNC_CRON = "manual"` (`:121`), `CLAIM_BATCH_SIZE = 3` (`:122`).
Not reproducible by a static generator (session-gated).

---

## 3. Upstream data schemas

### 3.A `manifests/portal-resource-manifest.json`

Two documents share the schema id `mltd.portal.resource-manifest/v1` and differ by `kind`. They live
in the **root of the default branch** of each repository:

* Assets: `ASSETS_PORTAL_MANIFEST_URL` →
  `https://raw.githubusercontent.com/kohakunamori/MLTDTranslationAssets/main/manifests/portal-resource-manifest.json`
  (`wrangler.jsonc:57`, default at `src/worker.js:78-79`).
* Client: `CLIENT_PORTAL_MANIFEST_URL` →
  `.../MLTDTranslationClient/main/manifests/portal-resource-manifest.json`
  (`wrangler.jsonc:58`, default at `src/worker.js:80-81`).

#### 3.A.1 Required / optional keys

| Level | Key | Required | Type | Read by |
| --- | --- | --- | --- | --- |
| root | `schema` | **required, must equal `mltd.portal.resource-manifest/v1`** | string | `readGitHubAssetsPortalManifest:1600`, `readGitHubClientPortalManifest:1767` |
| root | `kind` | **required**, `assets` or `client` | string | same lines |
| root | `generated_at` | optional | ISO-8601 string | `statsPayloadFromPortalManifest:367` (`summary_updated_at` fallback) |
| root | `summary_ready` | optional; **`false` disables the whole GitHub stats/summary path** | boolean | `getStats:390` |
| root | `release` | **required (a falsy `release` makes the manifest unusable)** | object | `assetsPortalManifestRelease:1843`, `releaseSourceForRef:1870` |
| root | `totals` | required for the summary routes | object | `getAssetsReleaseSummary:2269` |
| root | `categories` | required for `staticAssetBundles` and the stats categories | array | `:1615`, `:339`, `:2281` |
| root | `domains` | optional, ignored by the Worker | array | — |
| `release` (assets) | `asset_version` | **required**, must match `/^\d+$/` | numeric string | `:1600`, `:1873` |
| `release` (client) | `client_version` | **required**, must match `/^\d+(?:\.\d+)+$/` | string | `:1767`, `:1873` |
| `release` | `release_id` | required for identity matching and for the responses | string | `:1874`, `:2013`, `:2272` |
| `release` (assets) | `assets_commit` | required for the `github` axis to be *usable* | 40-hex string | `releasePinnedCommit:1885` |
| `release` (client) | `client_resources_commit` | required for the `github` axis to be *usable* | 40-hex string | `:1885` |
| `release` | `note` | optional | string | `:1846`, `:1855` (default `"<Assets|Client> GitHub manifest (CI)"`) |
| `release` | `updated_at` | optional | ISO-8601 | `:2024`, `:2283`, `:367` |
| `release` | `status` | optional, passed through | string | — |
| `release` | `source_manifest_sha256` (assets) / `manifest_sha256` (client) | optional | 64-hex | `buildResourceManifest:1544`, `:1546` |
| `release` | anything else | optional, **spread into responses verbatim** | any | `assetsPortalManifestRelease:1845`, `getAssetsReleaseDetail:2248`, `/manifest` full-body echo `:1933` |
| `totals` | `total`, `translated`, `pending`, `untranslated`, `reused`, `suggested`, `blocked` | optional, default `0` | number | `:2274-2280`, `:2015-2021`, `statsSummaryView:327-334` |
| `totals` | `progress_percent` | optional | number | `statsSummaryView:332` |
| `categories[]` | `id` | **required** (becomes the object key in `/api/stats`) | string | `:341`, `:1616` |
| `categories[]` | `domain` | required for domain filtering and the `/api/stats` domain rollup | string | `:1616`, `:580`, `:933` |
| `categories[]` | `bundles` | required for any item/row route on this axis | object: bundle name → anything | `:1617` |
| `categories[]` | `total`, `accepted`, `translated`, `pending`, `untranslated`, `progress_percent` | optional | number | `:340-349`, `:1485` |
| `categories[]` | `name`, `description`, `icon`, `unit`, `entry` | optional (the stats branch spreads them; `buildResourceManifest` uses `CATEGORY_RULES` instead) | string | `:342` |

#### 3.A.2 What makes a release “usable” / “pinned”

```js
releasePinnedCommit(kind, release)   // src/worker.js:1884-1887
  = String((kind === "client" ? release.client_resources_commit : release.assets_commit) || "")
      .trim().toLowerCase()
  ; FULL_SHA.test(value) ? value : null          // FULL_SHA = /^[0-9a-f]{40}$/i, :73

staticReleaseUsable(kind, release) = Boolean(release) && releasePinnedCommit(kind, release) !== null
```

`resolveReleaseSource` then yields exactly one of three axes:

| Axis | Condition | Consequence |
| --- | --- | --- |
| `github` | a ref **matches** (`ref === asset_version/client_version` or `ref === release_id`) **and** the pin is a 40-hex sha | all six sub-routes read the pinned GitHub bytes; identity = the manifest's own `release_id` |
| `broken` | a ref matches but the pin is missing/not a sha | **`503 release_pin_missing` on every sub-route** (`/manifest`, `/summary`, `/items`, `/item`, `/item/edit-context`, and `/api/catalogue/search` on this axis). No D1 fallback, ever |
| `d1` | no ref matches (or no manifest at all) | only D1 rows are read; `matched: false` is not distinguished from "manifest absent" |

#### 3.A.3 Raw-file read for the Assets axis — `readGitHubAssetsBundleRows`

`src/worker.js:1632-1692`. This one function defines the row contract for the whole Assets axis.

1. `commit = releasePinnedCommit("assets", release)`; no commit → `[]`.
2. `declaredPath = localesPathForBundle(bundle, "")` (§3.C.4); no path → `[]`.
3. Candidates, in order: `[declaredPath, "locales/master/<bundle minus .unity3d>.jsonl"]`
   (`:1641-1644`).
4. Base URL: `https://raw.githubusercontent.com/<owner>/<repo>/<commit>/<candidate>` where
   `owner/repo` comes from `GITHUB_TARGET_ASSETS` (fallback `kohakunamori/MLTDTranslationAssets`,
   `:1652-1654`). Headers: `accept: application/x-ndjson, application/json, text/plain`,
   `cf: {cacheTtl:300, cacheEverything:true}`. The first candidate that answers `ok` wins; none → `[]`.
5. Parse: split on `"\n"`, `JSON.parse` each non-blank line; a line that fails to parse is **skipped
   silently** (`:1672`).

   > **Contradiction note.** `MAX_RESOURCE_LINES` = 20000 (`:100`) is applied nowhere in this
   > reader; the budget is the caller's `maxRows` (`5000` for search/edit-context/detail, `min(400,
   > 5000)` for search, `max(limit*4, 200)` for `/items`).

6. Row acceptance (`:1673-1674`): `item_key = String(row.item_key || "").trim()` must be non-empty
   **and** `typeof row.ja === "string"`. Anything else is dropped.
7. Emitted row:

```jsonc
{
  "bundle": "bundle-a",                          // String(row.bundle || <requested bundle>)
  "github_path": "locales/master/bundle-a.jsonl",// the candidate that answered
  "item_key": "k1",
  "source": "原文一",                             // row.ja verbatim
  "source_sha256": "<64hex>",                    // row.source_sha256 trimmed+lowercased, else sha256(row.ja)
  "logical_key": "…",                            // String(row.logical_key || `<requested bundle>:<item_key>`)
  "translation": "译文一",                        // typeof row.zh === "string" ? row.zh : null
  "translation_status": "accepted"               // staticAssetRowStatus(row)
}
```

8. `rows.sort((a,b) => String(a.item_key).localeCompare(String(b.item_key), undefined, {numeric:true}))`
   — numeric-aware ordering.
9. Cached by `` `${commit}:${declaredPath}|${masterPath}` `` for 5 minutes.

The declared `source_sha256` is **trusted, not verified**, on this path (the D1 sync path verifies
and rejects — `src/sync_ingest.js:744-745`).

### 3.B `manifests/bottom-bar.manifest.json` (Client repository)

Read by `readClientItemsManifestAtPin(env, commit)` — `src/worker.js:1788-1816`. URL from
`clientItemsManifestUrl` (§2.8.8). Only ever read **at a pin**; there is deliberately no default
`main` URL (`:82-83`).

Validation (all of these, else the whole document is `null` and cached as `null` for 30 s):

| Check | Line |
| --- | --- |
| `FULL_SHA.test(commit)` — the caller must supply the 40-hex sha | `:1790` |
| HTTP ok and body parses as JSON | `:1803-1804` |
| `payload.kind === "mltd-bottom-bar-manifest"` | `:1805` |
| `Array.isArray(payload.slots) && payload.slots.length > 0` | `:1805` |
| **every** slot satisfies `slot && Number.isInteger(Number(slot.index)) && typeof slot.ja === "string"` — one bad slot invalidates the document | `:1808-1809` |

Document shape:

```jsonc
{
  "kind": "mltd-bottom-bar-manifest",              // required
  "atlas_target": { "texture": "theater_system_footer_main" },   // present in the real file; ignored by the Worker
  "slots": [
    { "index": 0, "ja": "劇場", "zh": "剧场", "provenance": "…" },
    { "index": 1, "ja": "ホーム", "zh": null }
  ]
}
```

Real-file evidence: `test_sync.mjs:258` builds
`{ kind: "mltd-bottom-bar-manifest", atlas_target: { texture: "theater_system_footer_main" },
slots: Array.from({length: 7}, (_, i) => ({ index: i, ja: "x", zh: "y" })) }` and calls it
"the real shapes, as published today: 937 image rows, 7 bottom-bar slots".

`slots[]` element schema as consumed:

| Key | Required | Type | Use |
| --- | --- | --- | --- |
| `index` | **yes** (`Number.isInteger(Number(index))`) | integer | slot identity: `item_key = String(slot.index)` (`:2062`), `logical_key = "client:bottom-bar:<index>"` (`:2057`), the match key in `/item` and `/item/edit-context`, and the cursor's `item_index` (`:2154`) — **position is never used as identity** |
| `ja` | **yes** (`typeof === "string"`) | string | the source text; `source_sha256 = sha256(slot.ja)` is recomputed on every read (`:2061-2063`) |
| `zh` | preferred | string \| null | the translation; `null` → `status: "untranslated"` |
| `translation` | fallback | string \| null | read only when `typeof slot.zh !== "string"` (`:2064`) |
| any other key | no | any | passed through only via the `/manifest` full-document echo; never mapped into `ClientStaticItem` |
| `provenance` | no | string | documented as part of the shape (`manifestSlotHasTranslation`'s doc comment, `:3596-3599`) but never read |

**Editability requirement (write-adjacent, but generator-relevant):** a slot must own a `zh` **or**
`translation` key — `manifestSlotHasTranslation` (`:3600-3602`), else `422
resource_row_not_translatable` (`:3637`). Emitting `"zh": null` (as the fixtures do,
`test_worker.mjs:493`) is therefore mandatory; omitting the key makes the row read-only.

### 3.C JSONL rows — `locales/**/*.jsonl` and `lyrics/songs/*.jsonl`

#### 3.C.1 Which keys each consumer reads

| Consumer | Source text | Translation | Hash | Status | Identity |
| --- | --- | --- | --- | --- | --- |
| **Worker read path** (`readGitHubAssetsBundleRows`, `:1673-1684`) | `ja` (required, string) | `zh` (string → value, else `null`) | `source_sha256` optional → recomputed from `ja` | `status` via `staticAssetRowStatus` | `item_key` required; `logical_key` optional; `bundle` optional |
| **D1 sync path** (`entryToRecord`, `src/sync_ingest.js:171-197`) | `ja ?? source ?? source_text` (must be a string) | `zh ?? translation` | `source_sha256`, validated to 64-hex; a mismatch with the content rejects the row (`sync_ingest.js:744-745`) | `status` (lowercased) | `item_key ?? key` required; `bundle` required (or the file's default) |
| **Write path** (`rowSource`, `src/worker.js:3563-3567`) | `ja`, else `source` | `zh` else `translation` | the pinned `source_sha256` must equal `sha256(rowSource(row))` (`:3685-3686`) | `translation_status` is set to `"modified"` **only when the key already exists** (`:3698`) | `rowMatchesIdentity` (`:3544-3560`) |
| **Retired offline extractor fixture** (`public/data/lyrics/*.json`, now `.assetsignore`d and **never read** by the Worker — `:1419-1425`) | `source` | `translation` | `source_sha256` | `status` | `item_key` + `slot_index` |

Real fixture row (assets JSONL), from `test_worker.mjs:723-727`:

```json
{"bundle":"bundle-a","item_key":"k1","ja":"原文一","zh":"译文一","translation_status":"accepted","source_sha256":"<64hex>"}
{"bundle":"bundle-a","item_key":"k2","ja":"原文二","zh":null,"translation_status":"untranslated","source_sha256":"<64hex>"}
```

> **Key-name contradiction, stated explicitly.** The two ecosystems use different names:
>
> * D1 sync (and the exporter, per `scripts/generate_portal_categories.py:113-170`) reads
>   **`ja` / `zh` / `bundle` / `item_key` / `source_sha256` / `status`** and the legacy
>   `base_version` / `asset_version`.
> * The retired `public/data/lyrics/<bundle>.json` fixtures use
>   **`source` / `translation` / `slot_index` / `bundle` / `item_key` / `asset_version` /
>   `base_version`** — a real example:
>   ```json
>   {"slot_index":1,"item_key":"126","source":"Make me happy いつだって",
>    "translation":"Make me happy 无论何时","status":"accepted",
>    "source_sha256":"58ae…dd57","bundle":"scrobj_aftspt.unity3d",
>    "asset_version":"1077100","base_version":"1077100"}
>   ```
>   (file: `local-data/retired-source/web/translation-portal/public/data/lyrics/scrobj_aftspt.unity3d.json`,
>   432 such files.)
> * The **Worker read path reads only `ja` / `zh`** — a `source`/`translation`-only row is invisible
>   to `/api/assets/releases/*` (it fails the `typeof row.ja === "string"` test at `:1674`) while the
>   **write path would still accept it** (`rowSource` prefers `ja` but falls back to `source`).
>   A generator must emit `ja`/`zh` (or both spellings) to be readable by the Worker.

#### 3.C.2 `item_key`, `logical_key` and row identity

* **`item_key`** is the per-bundle row identity. In the Assets repo it is usually a slot id like
  `"126"`, `"k1"`, or `<bundle-ish>_<index>`; in the Client manifest it is `String(slot.index)`.
* **`logical_key`** is the cross-release identity that makes reuse possible:
  * D1/sync: `buildLogicalKey(kind, bundle, itemKey)` — `src/sync_ingest.js:141-144`:
    ```js
    clean = String(bundle).replace(/\.(gtx|unity3d|jsonl|json)$/i, "")
    key   = `${kind}/${clean}/${itemKey}`          // kind ∈ text|lyrics|image|unity3d
    ```
  * write path: `generateLogicalKey(kind, bundle, itemKey)` — `src/worker.js:3714-3717`:
    ```js
    clean = String(bundle).replace(/\.(gtx|unity3d)$/i, "")   // NOTE: no .jsonl/.json strip
    key   = `${kind}/${clean}/${itemKey}`
    ```
    → these two agree for `.gtx`/`.unity3d` bundles and **diverge** for `.jsonl`/`.json` bundles.
  * Worker static read path: `String(row.logical_key || `${bundle}:${itemKey}`)` (`:1681`) — a
    *third* spelling, used when the JSONL row has no `logical_key`.
  * Client slots: `client:bottom-bar:<index>` (`:2057`).
* **`rowMatchesIdentity(row, identity)`** — `:3544-3560`, the write-side matcher a generator should
  mirror to guarantee an editable row:
  ```js
  candidates = { row.logical_key, row.key, row.item_key, row.id, row.logical }   // strings only
  if (row.bundle && (row.item_key ?? row.key)) candidates += { `${bundle}:${itemKey}`, `${bundle}/${itemKey}` }
  identity.logicalKey ∈ candidates → "logical_key"
  identity.itemKey    ∈ candidates → "item_key"
  else null
  ```
  Zero matches → `404 resource_row_not_found`; more than one → `409 resource_row_ambiguous`
  (`:3680-3681`).
* **`parseJsonlRows(lines)`** — `:3577-3592`: skips blank lines (a trailing newline is expected),
  `JSON.parse` each remaining line, requires a non-array object, else `422
  resource_file_row_invalid_json`. Indices are the **raw 0-based file line numbers** so the writer
  can prove only one line moved (`:3699-3703`).

#### 3.C.3 How `bundle` / `category` / `idol` are derived

* **`bundle`** — the JSONL row's own `bundle` when present (`:1676`), else the requested bundle name.
  The repository path is derived from the bundle, not stored in the row (§3.C.5).
* **`detectCategory(bundle, itemKey)` / `categoryId(bundle, itemKey)`** — `src/categories.js:29-53`.
  Both the bundle and the item key are lowercased; **first match wins**, in this exact order:

  | # | Condition | Category id |
  | --- | --- | --- |
  | 1 | `b.startsWith("scrobj_")` **or** `b.includes("lyric")` | `lyrics` |
  | 2 | `b.startsWith("event_")` and (`b.includes("chat")` or `k.includes("chat")`) | `event_chat` |
  | 3 | `b.startsWith("event_")` **or** (`b.includes("story")` and not `b.startsWith("special_")`) | `event_story` |
  | 4 | `b.startsWith("special_")` | `special_commu` |
  | 5 | `b === "st_jp.gtx"` or `b.startsWith("st_")` | `main_commu` |
  | 6 | `b.startsWith("card_episode_")` | `card_episode` |
  | 7 | `b.startsWith("card_blst_")` | `card_blog` |
  | 8 | `b === "cd_jp.gtx"` or `b.startsWith("cd_")` | `card_skill` |
  | 9 | `b === "cm_jp.gtx"` or `b.startsWith("cm_")` | `theater_comm` |
  | 10 | `b === "mb_jp.gtx"` or `b.startsWith("mb_")` | `message_board` |
  | 11 | `b.startsWith("liveresult_")` | `live_result` |
  | 12 | `b.startsWith("lbonus_")` | `login_bonus` |
  | 13 | `b.startsWith("birth_bdl")` | `birth_live` |
  | 14 | `b.startsWith("birth_ent")` or `b.startsWith("birth_")` | `birth_greet` |
  | 15 | *(fall-through)* | `system_ui` |

  Each id maps to a `CATEGORY_RULES` record with
  `{id, domain, name, description, domain_name, icon, unit, entry}` (`src/categories.js:8-24`) — the
  canonical label set (`domain ∈ lyrics|story|card|dialogue|birth|system`).

  The `scripts/generate_portal_categories.py:69-100` classifier is an **older, narrower twin** of
  this table (no `lyrics`, no `md_jp.gtx`, different `birth_*` handling): do not use it as the source
  of truth.

* **`bundlePrefixForCategory(categoryParam)`** — `:972-975` with the table at `:955-970`. Used
  **only** as an SQL seek prefilter. `lyrics → "scrobj"`, `event_chat|event_story → "event_"`,
  `special_commu → "special_"`, `main_commu → "st_"`, `card_episode → "card_episode_"`,
  `card_blog → "card_blst_"`, `card_skill → "cd_"`, `theater_comm → "cm_"`,
  `message_board → "mb_"`, `live_result → "liveresult_"`, `login_bonus → "lbonus_"`,
  `birth_live → "birth_bdl"`, `birth_greet → "birth_"`; a domain (`story`, `card`, `dialogue`,
  `birth`, `system`) and `system_ui` return `null` (no safe prefix — the walk is bounded instead).
* **`detectIdol(bundle, itemKey, source)`** — `src/worker.js:284-301`. The `source` argument is
  accepted but **never used**. Order:
  1. Match `/(?:^|_|(?<=[a-z]))(\d{3}[a-z]{3})(?:_|$|[a-z0-9])/i` against `itemKey`; a hit that is in
     `IDOL_MAP` (`src/terms.js:1123`) returns that idol record `{id, code, name_ja, name_zh, type,
     color}`.
  2. Otherwise scan `SPEAKERS` keys and return the idol for any code contained in `itemKey`; a
     speaker with no idol entry yields `{code, id: 0, name_ja, name_zh, type: "Guest",
     color: "#666666"}`.
  3. Otherwise match `/(\d{3}[a-z]{3})/i` against `bundle`.
  4. Otherwise `null`.
* **`EXPORT_DIRECTORY_BY_CATEGORY`** — `:988-1004`: `lyrics→lyrics`, `event_chat|event_story|
  special_commu|main_commu→story`, `card_episode|card_blog|card_skill→card`,
  `theater_comm|message_board|live_result|login_bonus→dialogue`, `birth_live|birth_greet→birth`,
  `system_ui→master`.

#### 3.C.4 `localesPathForBundle(bundle, itemKey)` — `:1099-1120`

```
base = bundle with /\.unity3d$/i stripped            (a .gtx suffix is KEPT)
category = categoryId(bundle, itemKey)
category === "lyrics" → "lyrics/songs/<base>.jsonl"
otherwise dir = EXPORT_DIRECTORY_BY_CATEGORY[category] → "locales/<dir>/<base>.jsonl"
no dir, an empty base, or a base containing / or \ → null
```

Both results pass through `requireGithubWritablePath(path, {allowImage:false})` (`:3806-3818`), which
enforces: non-empty, no `..`, no trailing `.unity3d`, and a prefix in
`GITHUB_PATH_PREFIXES = ["locales/", "lyrics/", "manifests/"]` (`:3768`). A validation failure inside
`localesPathForBundle` is converted to `null` (`:1115-1119`).

`assetsPathMatchesBundle` (`:1122-1128`) additionally accepts `locales/master/<base>.jsonl` for any
bundle — matching the reader's fallback candidate.

#### 3.C.5 Client text layout helpers

* `clientManifestPath(env)` — `:1028-1038`: `GITHUB_CLIENT_MANIFEST_PATH` with leading slashes
  stripped; must end in `.json`, must not contain `..` or `\`, else `503
  github_client_manifest_path_invalid`. There is **no** default; unset → `null`.
* `clientTextDirectory(env)` — `:1040-1045`: `GITHUB_CLIENT_TEXT_DIR`, trimmed of slashes; `..`/`\` →
  `503 github_client_text_dir_invalid`.
* `clientTextPathForBundle(env, bundle)` — `:1061-1071`: the declared manifest path wins; else
  `<dir>/<bundle minus .(gtx|unity3d)>.jsonl`; else `null`.
* `requireClientWritablePath(env, path)` — `:1079-1095`: membership in exactly `{manifestPath} ∪
  {<dir>/<one-segment>.jsonl}`, with the shared refusals.

### 3.D `public/data/image_tasks.json`

Read by `readStaticImageTaskManifest(request, env)` — `:2848-2864` — through the **static assets
binding** at the absolute path `/data/image_tasks.json`; the artifact must exist under `public/`.
`.assetsignore` (`public/.assetsignore`) currently ignores `/data/songs_catalog.json`,
`/data/lyrics/*.json` and `/data/image_status_overrides.json` and **deliberately does not ignore
`/data/image_tasks.json`** ("The image task manifest is intentionally public", comment at
`.assetsignore:16-17`).

Top-level keys:

| Key | Required | Type | Use |
| --- | --- | --- | --- |
| `tasks` | **required** (`Array.isArray` else the whole file is rejected) | array | everything |
| `total` | optional | number | `total` (`:2895`; falls back to `tasks.length`) |
| `categories` | optional | object `name → count` | returned as-is (`:2894`) |
| `statuses` | optional | object `name → count` | **never read** by the Worker |
| `generated_at` | optional | ISO-8601 | `summary_updated_at` (`:2897`) |

Real published fixture head (570 158 bytes,
`local-data/retired-source/web/translation-portal/public/data/image_tasks.json`):

```jsonc
{
  "total": 1109,
  "categories": { "all": 1109, "event": 768, "costume": 219, "tutorial": 122 },
  "statuses":   { "all": 1109, "untranslated": 5, "not_needed": 171, "restored": 932, "accepted": 1 },
  "tasks": [{
    "task_id": "salesinfo0015-info04-pilot",
    "bundle": "costumesalesinfo0015.unity3d",
    "category": "costume",
    "category_name": "👗 服装海报",
    "width": 650,
    "height": 366,
    "status": "accepted",
    "has_restored": true,
    "description": "765PRO 换装资讯宣传海报 (Pilot 验收样片)",
    "prepared_image": "salesinfo0015-info04-pilot/source-composite.png",
    "restored_image": "salesinfo0015-info04-pilot/restored-texture.png",
    "model_image": "salesinfo0015-info04-pilot/edited-composite-model.png"
  }]
}
```

`tasks[]` element — keys the Worker actually reads are marked **read**:

| Key | Read? | Type | Derivation / note |
| --- | --- | --- | --- |
| `task_id` | **read** | string | the sort key (`String(task_id).localeCompare`, `:2884`), the cursor key (`{scope:"images:tasks", task_id}`, `:2891`, `:3016`), and the `image_status_overrides` PK |
| `bundle` | **read** | string | exact (lowercased) match for `bundle` and `search` |
| `category` | **read** | string | exact match for `category`; observed enum `event \| costume \| tutorial` (`IMAGE_MANIFEST_RULES`, `:1440-1444`) plus `other` in the D1 import manifest's `categories` map |
| `status` | **read** (with override) | string | one of `untranslated \| not_needed \| restored \| accepted` (`IMAGE_STATUSES`, `:2805`; `schema.sql:212`) |
| `has_alpha` | **read** (coerced) | any → boolean | `Boolean(task.has_alpha)` (`:2875`, `:3040`); **absent from the published fixture** |
| anything else | passed through | any | `...task` spread: `width`, `height`, `category_name`, `has_restored`, `description`, `prepared_image`, `restored_image`, `model_image` are emitted unchanged |

D1 equivalent row (for cross-checking) — `image_task_units` (schema.sql:237-249) with
`task_id, bundle, category, width, height, image_format, has_alpha(int 0/1), r2_key, source_sha256,
created_at, updated_at`. It is imported from a **different** manifest,
`kind: "mltd-portal-image-task-import"`, `runtime_authoritative: false`,
`import_target: "d1:image_task_units"`, `import_columns: [task_id, bundle, category, width, height,
image_format, has_alpha, r2_key, source_sha256]` (`scripts/migrate_and_backfill_portal_d1.py:628-641`;
a real 1.4 MB example exists at
`local-data/build/runs/text-localization/9.0.200/portal-decouple-backfill-20260928/image-task-import-manifest.json`).
That manifest's tasks additionally carry `logical_key` (`image/<task_id>`), `resource_kind`
(`image`), `category_name`, `description`, `in_edit_queue`, and an `objects{composite,restored}`
map with `{r2_key, github_relative_path, sha256}`.

### 3.E The D1 summary rows, and how to recompute them offline

#### 3.E.1 `release_summaries` (schema.sql:160-173)

```
PRIMARY KEY (release_kind, release_id)
total_items, translated_items, pending_items, untranslated_items,
reused_items, suggested_items, blocked_items   -- INTEGER NOT NULL DEFAULT 0
category_summary_json                          -- TEXT NOT NULL DEFAULT '{}'
updated_at                                     -- TEXT NOT NULL
```

Writer: `rebuildReleaseSummary(env, releaseKind, releaseId)` — `src/sync_ingest.js:555-622`. It
groups the release's refs:

```sql
SELECT r.status, r.reuse_mode, sv.bundle, COUNT(*) AS count
FROM release_resource_refs r JOIN source_variants sv ON sv.source_variant_id = r.source_variant_id
WHERE r.release_kind=? AND r.release_id=?
GROUP BY r.status, r.reuse_mode, sv.bundle
```

and accumulates, per group (all counters are **row counts of source variants**):

| Counter | Rule |
| --- | --- |
| `total_items` | `+= count` unconditionally |
| `translated_items` | `+= count` when `status === "accepted"` |
| `pending_items` | `+= count` when `status === "pending" \|\| "needs_review"` |
| `untranslated_items` | `+= count` when `status === "untranslated"` |
| `suggested_items` | `+= count` when `status === "suggested"` |
| `blocked_items` | `+= count` when `status === "blocked"` |
| `reused_items` | `+= count` when `reuse_mode ∈ {exact, verified-compatible}` |

`category_summary_json` = `{ <categoryId(bundle)>: bucket }` with

```jsonc
{ "total": 0, "accepted": 0, "pending": 0, "suggested": 0, "blocked": 0,
  "progress_percent": 0,
  "bundles": { "<bundle>": { "slots": 0, "accepted": 0 } } }
```

`bucket.total += count`; `accepted`/`pending`(`pending|needs_review`)/`suggested`/`blocked` per
status; `bundles[bundle].slots += count` and `.accepted += count` when accepted;
`progress_percent = total > 0 ? Math.round((accepted/total)*10000)/100 : 0`.

> Note the divergence the reader has to absorb: the **D1** per-bundle entry is
> `{slots, accepted}` (this is what `/api/lyrics/songs` reads, `:1281-1282`), while the
> **CI manifest's** `categories[].bundles[bundle]` in `portal-resource-manifest.json` uses whatever
> the CI writes — the fixtures use `{total, translated, pending, untranslated}`
> (`test_worker.mjs:743`). Only the **keys** of that map are read by `staticAssetBundles`.

#### 3.E.2 `portal_summary[key='stats']`

Writer: `rebuildPortalStats(env, summary = null)` — `src/sync_ingest.js:633-662`:

```jsonc
{
  "release_kind": "assets",
  "release_id": "assets-1077100",       // the canonical assets_releases row
  "asset_version": "1077100",
  "total": 0, "translated": 0, "untranslated": 0, "pending": 0,
  "reused_items": 0, "suggested_items": 0, "blocked_items": 0,
  "categories": { /* the category_summary_json object above */ },
  "generated_at": "<summary.updated_at>"
}
```

`updated_at` in the `portal_summary` row is the same timestamp. Note the stats row **omits
`accepted` and `progress_percent`** — the handler derives them (`:427`, `statsSummaryView`).

`portal_summary[key='image_categories']` — written by
`scripts/migrate_and_backfill_portal_d1.py:688-720`:

```jsonc
{ "counts": { "event": 768, "costume": 218, "tutorial": 122, "other": 0 },
  "total": 1108, "truncated": false }
```

That is a `GROUP BY category` over `image_task_units`. Older/hand-written rows may be a **bare**
`{category: count}` map, optionally including `all` — the reader accepts both (`:2976-2987`) and sums
every value for `total` (`:3020`), which double-counts an `all` key.

#### 3.E.3 What an offline generator can and cannot recompute

| Field | Offline from pinned GitHub files? | How |
| --- | --- | --- |
| `total_items` | **yes** | count of readable JSONL rows (+ 1 per client slot) |
| `translated_items` | **yes** | rows whose effective status is `accepted` |
| `pending_items` | **yes** | statuses `pending` / `needs_review` |
| `untranslated_items` | **yes** | everything else (the static reader's third bucket) |
| `category_summary_json` | **yes** | the §3.E.1 rules, keyed by `categoryId(bundle)` |
| `reused_items` | **NO** | `reuse_mode` is produced by `evaluateReuseBatch` (`src/sync_ingest.js:447-524`) against D1 `translation_units` + `reuse_attestations`; the pinned files carry no reuse state |
| `suggested_items`, `blocked_items` | **NO** | same |
| `summary.progress_percent` | yes | `round(translated/total*100, 2)` |
| image `counts` / `total` | yes, if the generator also produces the status/category roll-up itself | group `tasks[]` by `category` (and `status`) |
| image `truncated` | n/a offline | emit `false` |

Also note the `status` vocabulary mismatch: the pinned JSONL files use the *release ref* statuses a
core contributor writes (`accepted`, `pending`, `needs_review`, `untranslated`, and in principle
`suggested`/`blocked`), while `staticAssetRowStatus` (`:1626-1630`) recognises only `accepted`,
`pending`, `needs_review` and collapses everything else to `untranslated`. A row marked
`suggested` or `blocked` in the file therefore reads as **`untranslated`** through
`/api/assets/releases/*/items`, but as `suggested`/`blocked` through D1.

---

## 4. Environment, bindings and constants

### 4.1 Bindings (`wrangler.jsonc`)

| Binding | Type | Used by read paths |
| --- | --- | --- |
| `DB` | D1 (`mltd-translation-portal`) | every D1 axis; absence → varies (`503 database_unavailable` on most, skipped on `/api/images/status`) |
| `ASSETS` | Workers static assets, `directory: ./public`, `run_worker_first: true` | `/data/image_tasks.json` (`:2851`, `:2854`), and every non-`/api/` request (`:5295`) |
| `PUBLICATION_BUCKET` | R2 (`mltd-translation-candidates`) | `/api/images/asset` private read (`:3081-3091`); also a fallback presence check in `/api/sync/status` (`:2761`) |

There is **no** cron trigger configured (the `scheduled()` handler exists at `:5323-5337` but
`wrangler.jsonc` declares no `triggers`, and `SYNC_CRON = "manual"`).

### 4.2 Variables and secrets (names only — complete list from `src/*.js` + `wrangler.jsonc`)

**Read-path variables (a static generator must know these to reproduce identity/paths):**

| Name | Read by | Effect |
| --- | --- | --- |
| `PORTAL_DEFAULT_ASSET_VERSION` | `defaultAssetVersion` (registry:51-53) → `/api/lyrics/songs`, `/api/lyrics/song` | the asset version used when the request names none; must be decimal (`normalizeAssetVersionInput`) |
| `ASSETS_PORTAL_MANIFEST_URL` | `:1587` | Assets CI-manifest URL (default constant `:78-79`) |
| `CLIENT_PORTAL_MANIFEST_URL` | `:1754` | Client CI-manifest URL (default constant `:80-81`) |
| `CLIENT_ITEMS_MANIFEST_URL` | `clientItemsManifestUrl:1827` | pinned slot-file URL; `raw.githubusercontent.com/<o>/<r>/<ref>/<path>` shapes are re-pinned to the release commit |
| `GITHUB_TARGET_ASSETS` | `:1145`, `:1652` | `owner/repo` for raw Assets reads and for `github.target="assets"` bindings (fallback `kohakunamori/MLTDTranslationAssets`) |
| `GITHUB_TARGET_CLIENT` | `:1145`, `:1834` | `owner/repo` for the Client axis (fallback `kohakunamori/MLTDTranslationClient`) |
| `GITHUB_CLIENT_MANIFEST_PATH` | `clientManifestPath:1029` | the Client channel's one editable manifest path |
| `GITHUB_CLIENT_TEXT_DIR` | `clientTextDirectory:1041` | the Client channel's `<bundle>.jsonl` directory |
| `GITHUB_BASE_BRANCH_ASSETS`, `GITHUB_BASE_BRANCH_CLIENT` | `githubBaseBranch` (write path) | default branches; **not** used by any read route |
| `IMAGE_ASSET_BASE` | `:3092` | redirect base for `/api/images/asset` |
| `PORTAL_CANONICAL_ORIGIN` | `configuredOrigin:3754` | write-guard origin; a malformed value → `503 portal_canonical_origin_invalid` on write routes |
| `ENVIRONMENT` | `isProductionEnv:2749-2752` | `production`/`prod` — webhook only |
| `SYNC_REPOSITORIES` | `resolveTargetKind` (sync_ingest:119-123) | `owner/repo=assets,…` or JSON `{"owner/repo":"assets"}` |
| `ALLOW_UNVERIFIED_ASSETS` | registry:155 | write path only |

**Auth / write-only (out of scope, listed so the list is complete):** `REVIEWER_EMAILS`,
`ADMIN_EMAILS`, `REVIEWER_GITHUB_LOGINS`, `ADMIN_GITHUB_LOGINS`, `SESSION_PEPPER`,
`SESSION_COOKIE_SECURE`, `USER_TOKEN_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_SYNC_TOKEN`,
`GITHUB_PR_TOKEN`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `NOTIFY_URL`,
`GITHUB_COLLAB_FETCH` (a test seam for `fetch`).

### 4.3 Hard-coded constants (complete)

| Kind | Value | Location |
| --- | --- | --- |
| Service version | `"mltd-translation-portal/5"` | `:74` |
| Page limits | `20` default / `100` max / images `24` default | `:76-77`, `:2928` |
| Scan budget | `MAX_SCAN_ROWS = 400` | `:805` |
| Contribution lookup chunk | `25` | `:861` |
| Stats memo TTL | `600000` ms | `:75` |
| Manifest cache TTL | `300000` ms (30 s on failure) | `:84`, `:1606`, `:1773` |
| Image task manifest cache | `60000` ms (10 s on failure) | `:2858`, `:2861` |
| Cursor key | `"mltd-portal-cursor-v1"` | `:510` |
| Allowed manifest paths | `GITHUB_PATH_PREFIXES = ["locales/","lyrics/","manifests/"]`; `GITHUB_IMAGE_PATH_PREFIX = "images/"` | `:3768-3769` |
| Target kinds | `GITHUB_TARGET_KINDS = ["assets","client"]` | `:3767` |
| Release statuses | `ASSETS_RELEASE_STATUSES = ["canonical","staging","unverified","superseded"]`; writable = `{canonical, staging}` | registry:14,18 |
| Client release statuses | `["draft","candidate","published","superseded","failed"]` (default `candidate`) | sync_ingest:424; schema.sql:105 |
| Asset version pattern | `/^[0-9]{1,10}$/` (write) / `/^\d+$/` (CI manifest) | registry:11; `:1600` |
| Client version pattern | `/^\d+(?:\.\d+)+$/` (CI manifest), `/^[0-9]+\.[0-9]+\.[0-9]+$/` (sync) | `:1767`; sync_ingest:386 |
| Commit pattern | `/^[0-9a-f]{40}$/i` | `:73` |
| Hash pattern | `/^[0-9a-f]{64}$/i` | `:67`, `:71` |
| Task-id pattern (images) | `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/` | `:3074` |
| Image statuses | `{untranslated, not_needed, restored, accepted}` | `:2805` |
| Image categories | `event → img_event`, `costume → img_costume`, `tutorial → img_tutorial` | `:1440-1444` |
| Image object keys | `images/composite/<id>/source-composite.png`, `images/restored/<id>/restored-texture.png`, `images/restored/<id>/edited-composite-model.png` | `:3064-3068` |
| Domain meta | `lyrics/story/card/dialogue/birth/system/images` names+icons | `:1446-1454` |
| Export dirs | `EXPORT_DIRECTORY_BY_CATEGORY` | `:988-1004` |
| Category taxonomy | 14 ids (`src/categories.js:8-24`) | — |
| Repo defaults | `kohakunamori/MLTDTranslationAssets`, `kohakunamori/MLTDTranslationClient`, branches `main` | `:79`, `:81`, `:1654`, `:1836` |
| Sync constants | `SYNC_CRON="manual"`, `CLAIM_BATCH_SIZE=3`, `DEFAULT_FILE_LIMIT=400`, `DEFAULT_ROWS_PER_JOB=4000`, `DEFAULT_MAX_FILE_BYTES=4 MiB`, `LOOKUP_CHUNK=40` | `:121-122`; sync_ingest:23-26 |
| Localisation paths (sync) | `locales/**/*.jsonl` = `text`, `lyrics/**/*.jsonl` = `lyrics`, `generated/**` = not ingestible, `manifests/images.manifest.json` = not ingestible, `manifests/bottom-bar.manifest.json` = not ingestible (`apk_builtin_surface`), `video/**`+`*.mp4|webm|mov|m4v` = unsupported | sync_ingest:66-79 |
| Release manifests (sync) | assets → `manifests/asset-version.json`; client → `manifests/apk-builtin.manifest.json` | sync_ingest:30-39 |
| Non-localisable manifest kinds | `mltd-images-manifest → image_manifest_metadata_only`, `mltd-bottom-bar-manifest`/`mltd-apk-builtin-manifest → apk_builtin_surface` | sync_ingest:44-48 |
| Image ratio gate | `DEFAULT_RATIO_TOLERANCE = 0.005` (retained, no longer the gate), `MAX_GATE_DIMENSION = 1<<20`; equality is a cross-product | `src/image_ratio.js:39`, `:45`, `:196-248` |

---

## 5. Ambiguities, warts and genuine contradictions

Numbered so a downstream implementer can cite them.

1. **`/api/{assets,client}/releases` mint a `next_cursor` they never accept.** Both list handlers
   take only `limit` (`:1952`, `:2213`) yet emit `next_cursor` with scopes `client:releases` /
   `assets:releases` (`:1969`, `:2236`). Nothing ever decodes those scopes. Treat them as
   decorative.
2. **`clientStaticItem` hard-codes a domain that contradicts the taxonomy.** `domain: "master"`,
   `domain_name: "系统与主界面"` (`:2080-2081`) versus `CATEGORY_RULES.system_ui` = `domain: "system"`,
   `domain_name: "界面系统"` (`src/categories.js:23`). Every other row in the system uses
   `detectCategory`. A generator that reuses `detectCategory` will not be byte-identical here.
3. **Two item shapes on one route family.** GitHub-axis items are `StaticAssetItem`
   (`:1694-1722`) / `ClientStaticItem` (`:2060-2089`); D1-axis items are raw SQL rows without
   `source`, `category` or `idol`. `/items` is shape-polymorphic.
4. **Identity matching vs. `logical_key` formation disagree.**
   `src/worker.js:1681` uses `` `${bundle}:${itemKey}` ``; `generateLogicalKey` (`:3714-3717`) uses
   `` `${kind}/${bundle}/${itemKey}` `` and strips only `.gtx|.unity3d`; `buildLogicalKey`
   (`src/sync_ingest.js:141-144`) strips `.gtx|.unity3d|.jsonl|.json` as well. Three spellings for
   one concept.
5. **`resourceIdFor`'s doc comment contradicts the writer.** `src/worker.js:3351` says the id is
   `res_<first 24 chars of sha256(logical_key)>` (which is what `test_worker.mjs:159` uses), while
   `src/sync_ingest.js:131-133` writes `res:${kind}:${logicalKey}`. Both spellings exist in the
   repository; the read routes only ever echo whatever D1 holds.
6. **The Worker read path ignores `source`/`translation` JSONL keys.** `readGitHubAssetsBundleRows`
   requires `typeof row.ja === "string"` (`:1674`) and reads only `row.zh` (`:1682`), while the
   write path (`rowSource`, `:3563-3567`) and the retired lyrics fixtures use `source`/`translation`.
   A row with only `source`/`translation` is invisible to every `/api/assets/releases/*` item route.
7. **`staticAssetRowStatus` ignores `suggested`/`blocked`.** Statuses outside
   `{accepted, pending, needs_review}` collapse to `untranslated` (`:1626-1630`), so the GitHub axis
   cannot express reuse states the D1 axis can.
8. **`MAX_SCAN_ROWS` is not enforced while scanning the GitHub axis.** In `searchStaticAssets` the
   budget is only tested after a *match* (`:587-588`), so `scanned_rows` may exceed 400 and the walk
   is bounded only by the manifest's bundle list. The D1 path (`fetchFilteredCataloguePage:898`) does
   enforce `scanned < MAX_SCAN_ROWS`.
9. **`/api/images/tasks` `total` double-counts a bare `{all: n, …}` summary.**
   `Object.values(counts).reduce(sum)` (`:3020`) includes an `all` key when the stored
   `portal_summary['image_categories']` value is a bare map. `test_sync.mjs:962` seeds exactly such a
   map and only asserts the per-category numbers, so the behaviour is untested.
10. **Two different status-filter positions in `/api/images/tasks`.** Static branch filters by status
    *before* the seek (so `next_cursor` names the last visible task, `:2883-2891`); D1 branch filters
    *after* the seek (so `next_cursor` names the last examined row, `:3003-3016`).
11. **`/api/catalogue/search` mixes two item_key orderings.** The D1 axis compares `item_key` with SQL
    `>` (byte order, `:823`) while the GitHub axis compares with `localeCompare(…, {numeric: true})`
    (`:577`). For a bundle whose keys are `9`, `10`, the two axes paginate differently.
12. **A cursor minted for a different release silently restarts pagination** instead of erroring
    (`decodeCursor` → `null` → `{bundle:"",item_key:""}`). Same for an expired/re-scoped cursor —
    list endpoints can loop forever if the caller believes `has_more` implies a new page.
13. **`/api/catalogue/search` on the GitHub axis needs the *manifest's* `release_id` in the cursor
    scope.** When CI publishes a new asset version mid-walk, previously issued cursors stop decoding
    and the client re-reads page 1.
14. **`getAssetsReleases`/`getClientReleases` append the CI manifest release without checking the
    pin** (`:2226`, `:1959`), so `broken` releases still appear in the list even though every
    sub-route for them answers `503`.
15. **`/api/assets/releases/:ref/item/edit-context` is GitHub-axis only** (`:1727-1728`): an old
    (D1) ref gets `404 assets_release_not_found` even though `/api/resources/:id/edit-context`
    works. The Client route instead answers `404 client_release_not_found` (`:2095`).
16. **`400 bundle_and_item_key_required` is reused for two different Client validations**: a missing
    parameter *and* a wrong bundle/wrong key shape (`:2100-2102`).
17. **`withRegistryErrors` is dead code.** Defined at `:169-181`, never referenced. Registry errors
    are instead mapped in `fetch`'s catch (`:5302-5306`), and handlers that catch locally
    (`getSongs:1206-1210`) route them by hand.
18. **`getResourceDetail/History/Reuse` mask every failure as `503 database_unavailable`**
    (`:2517-2520`, `:2537-2540`, `:2567-2570`), *except* an `HttpError`, which is re-thrown first —
    so a D1 quota exhaustion is indistinguishable from a missing binding on those three routes.
19. **`/api/lyrics/song` swallows a quota error and answers `404 bundle_not_found`**
    (`:1336-1340` + `:1425`): a release lookup that failed for budget reasons looks like "this bundle
    does not exist".
20. **The read path and the write path disagree about which key carries a translation.**
    `readGitHubAssetsBundleRows` reads **only** `row.zh` (`:1682`) and `staticAssetRowStatus` tests
    only `row.zh` (`:1627-1628`), so an Assets JSONL row that writes its translation under
    `translation` (the spelling the retired `public/data/lyrics/*.json` fixtures use) reads as
    `translation: null` / `status: "untranslated"` — even though the **write** path would accept that
    same row (`rowHasTranslationField` accepts `zh` *or* `translation`, `:3570-3572`, and `rowSource`
    accepts `ja` *or* `source`, `:3563-3567`). The Client slot path does honour the fallback
    (`slot.zh ?? slot.translation`, `:2064`). Reproduce the *asymmetry*, not an idealised merge.
    Related: `"zh": ""` is falsy in both `staticAssetRowStatus` (`:1627`) and
    `clientStaticItem`'s `translated ? … : …` (`:2082`), so an empty string reads as `untranslated`
    on both axes — but the `translation` field is still the empty string on the Assets axis
    (`typeof "" === "string"`) and `null` on the Client axis when `zh` is absent.
21. **`decodeUploadedImage`/image geometry is write-only.** `src/image_ratio.js` is imported by
    `src/worker.js:34` but no read route exposes `asset_axes` or the ratio gate; `/api/images/*` reads
    only expose `width`/`height`/`has_alpha` as stored.
22. **`rel="…"` for the Client `domain` field.** (See item 2 — repeated here because it is the single
    most likely place a regenerated file will differ from the live API.)
23. **An assets manifest whose `release.asset_version` is absent or non-decimal makes the *whole*
    manifest `null`** (`:1600`) — which silently downgrades `/api/stats` to D1 and makes every
    `/api/assets/releases/:ref` route take the D1 axis (i.e. `404` for a version D1 does not hold).
    The same applies to a client manifest whose `client_version` is not `\d+(\.\d+)+`.
24. **`/api/stats` `categories` differs by branch.** The GitHub branch builds an object of
    *normalised* entries (`:339-351`); the `release_summaries` branch returns
    `JSON.parse(category_summary_json)` *raw* (`:456`), whose buckets carry
    `{total, accepted, pending, suggested, blocked, progress_percent, bundles}` — a different key set
    from the manifest's categories.
25. **Cache-layer asymmetry for `/data/image_tasks.json`.** It is served publicly by the assets
    binding (not in `.assetsignore`) *and* read by the Worker through that same binding, so a stale
    published file is both the input and the output of the same URL.
26. **The `scheduled()` consumer and `POST /api/sync/tick` still exist** while `SYNC_CRON` is
    `"manual"` and no cron trigger is declared — i.e. `sync_jobs` will accumulate without ever being
    drained on a deployment that only sets the vars in `wrangler.jsonc`. Irrelevant to reads, but it
    explains why D1 summaries can be permanently stale.

---

## 6. Offline generator checklist (what to emit, per legacy endpoint)

A generator that reads the pinned upstream files and needs to *stand in* for the read API must
produce:

| Legacy endpoint | Offline stand-in | Required inputs |
| --- | --- | --- |
| `GET /api/health` | `{ok:true, service:"mltd-translation-portal/5"}` | none |
| `GET /api/terms` | the three `terms.js` arrays verbatim | `public/lib/terms.js` (or `src/terms.js`) |
| `GET /api/stats` | `statsPayloadFromPortalManifest` shape (§2.3) with `source:"github"`, `reused/suggested/blocked = 0` and a note that they are not derivable (§3.E.3) | assets manifest + a row walk for `totals` |
| `GET /api/catalogue/search` | the GitHub-axis envelope (§2.4) or a precomputed index; `total: null`, `total_source: null`, `scan_*` recomputed | assets manifest `categories[].bundles` keys + each bundle's JSONL |
| `GET /api/lyrics/songs` | the D1 song list, with `slots`/`translated` from a locally rebuilt `category_summary_json` | `scrobj_*` bundles + `SONG_MASTER` |
| `GET /api/lyrics/song` | `{bundle, release_id, asset_version, total_lines, source:"release", lines[]}`; `slot_index` = first integer in `item_key` | that bundle's JSONL |
| `/api/assets/releases*` | six routes; `/manifest` = the upstream document + `source:"github"`; `/items` and `/item` = `StaticAssetItem`; `/edit-context` = `getStaticAssetsItemContext` shape with `row_kind:"jsonl_row"` | assets manifest (pin + `categories[].bundles`) + JSONL rows |
| `/api/client/releases*` | same six with `ClientStaticItem` and `row_kind:"manifest_slot"`; `bundle` is always `manifests/bottom-bar.manifest.json` | client manifest (pin) + bottom-bar manifest |
| `/api/resources/:id{,/history,/reuse}` | D1-only; **no offline equivalent** unless the generator also materialises a resource index | — |
| `/api/resources/:id/edit-context` | `editContextForResource` shape; `row_kind` depends on the resolved path ending in `.json` | release pin + the row's bundle/item_key |
| `/api/images/tasks`, `/api/images/task` | the `public/data/image_tasks.json` document itself **is** the contract (§3.D) | image task source pipeline |
| `/api/images/asset` | not an API payload: compute `<base>/images/<family>/<task_id>/<file>` | `IMAGE_ASSET_BASE` |
| `/api/images/status` | `{overrides:{…}}` | not derivable offline |
| `GET /api/sync/status` | session-gated; not reproducible | — |

Hard requirements a generator must not get wrong (each is enforced by a `throw` or a silent drop in
the Worker):

1. Emit `ja` **and** `zh` on every Assets JSONL row (keys, not just values) — §5.6, §3.C.1.
2. Emit `"zh": null` (or `translation`) on every row and every client slot that must remain editable —
   §3.B, `:3570-3572`, `:3600-3602`.
3. Put the **bundle names** in `categories[].bundles`; the values are ignored by the row routes —
   `:1617`.
4. Give `categories[]` entries a stable `id` and a `domain`, and give `release` a decimal
   `asset_version` (assets) or `\d+(\.\d+)+` `client_version` (client), plus a 40-hex
   `assets_commit` / `client_resources_commit` — §3.A.2.
5. Number client slots with `index` (integer) and Japanese text in `ja`; one malformed slot voids the
   whole document — §3.B.
6. Keep `item_key` unique per bundle: duplicates make edit-by-identity return `409` —
   `:3680-3681`.
