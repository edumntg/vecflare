# vecflare

An open-source vector database that runs on your own Cloudflare account. Vectors live in R2, metadata lives in a SQLite-backed Durable Object, and one Worker exposes the HTTP API. You deploy it with `wrangler deploy` and pay Cloudflare directly for what it uses, with no vecflare service in between.

- **Cheap.** R2 storage is $0.015 per GB-month and has no egress fee. A million 768-dimension vectors is about 3 GB of float32, so under five cents a month to store. Reads cost $0.36 per million requests.
- **Yours.** The code runs in your account, under your API key. Nobody else can see the data because nobody else has it.
- **Small surface.** Upsert, patch, delete, fetch, list, query with filters, build index. JSON in, JSON out.
- **Honest about speed.** A query that hits the in-memory cache answers in tens of milliseconds. A cold query reads a few megabytes from R2 and takes a few hundred. Numbers measured on a real deployment are in [Benchmarks](#benchmarks).

The design borrows from [turbopuffer](https://turbopuffer.com/architecture): object storage is the source of truth, there is a write-ahead log, an IVF index built from centroids, and a cache in front. The difference is that vecflare is a program you run, not a service you rent.

## How it works, in one paragraph

Each namespace is one Durable Object plus one R2 prefix. Writes are batched for 50 ms, written to R2 as an immutable segment file, then recorded in SQLite together with the row's attributes. A query with a filter asks SQLite which rows match, then scores only those vectors. A query without a filter uses the IVF index: compare against the centroids, read the nearest clusters from R2 (or from the 24 MB in-memory cache), score, return. A second Durable Object builds the index in the background whenever enough new data has arrived, so reads and writes never wait for it. Details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Deploy

You need a Cloudflare account and Node 20 or newer. Durable Objects with SQLite storage are available on the free plan, so the free plan works for trying it out. Index builds of large namespaces need more CPU time than the free plan allows; see [Limits](#limits).

```bash
git clone https://github.com/edumntg/vecflare
cd vecflare
npm install
npx wrangler login
npx wrangler r2 bucket create vecflare
npx wrangler deploy
```

Wrangler prints the Worker URL, something like `https://vecflare.<your-subdomain>.workers.dev`. Set an API key. Every request to `/v1/*` must carry it as a bearer token.

```bash
openssl rand -hex 24 | npx wrangler secret put API_KEY
```

That is the whole install. To run it locally instead:

```bash
cp .dev.vars.example .dev.vars   # sets API_KEY=dev-key-change-me
npm run dev                       # http://localhost:8787
```

Local R2 and Durable Objects are simulated by wrangler. Note that local wrangler runs everything on one thread, so an index build will stall other requests while it runs. That does not happen on Cloudflare.

## Use it

All examples assume:

```bash
export VF=https://vecflare.<your-subdomain>.workers.dev
export KEY=<the key you set>
```

Namespaces are created on first write. Names match `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`.

### Insert or replace vectors

```bash
curl -X POST $VF/v1/namespaces/docs/upsert \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "distance_metric": "cosine_distance",
    "rows": [
      { "id": "doc-1", "vector": [0.12, -0.33, 0.91, 0.05], "attributes": { "lang": "en", "tags": ["news", "ai"], "views": 1200 } },
      { "id": "doc-2", "vector": [0.80, 0.10, -0.20, 0.44], "attributes": { "lang": "es", "tags": ["blog"], "views": 87 } }
    ]
  }'
```

```json
{ "upserted": 2 }
```

Every vector in a namespace must have the same number of dimensions; the first upsert fixes it. `distance_metric` is optional, defaults to `cosine_distance`, and can only be set before the namespace has data. The other metrics are `euclidean_squared` and `dot_product`. Attributes are any JSON object up to 64 KB. Upserting an existing id replaces both its vector and its attributes. Up to 10,000 rows per request.

### Search

```bash
curl -X POST $VF/v1/namespaces/docs/query \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{ "vector": [0.1, -0.3, 0.9, 0.0], "top_k": 5, "include_attributes": true }'
```

```json
{
  "rows": [
    { "id": "doc-1", "dist": 0.0021, "attributes": { "lang": "en", "tags": ["news", "ai"], "views": 1200 } },
    { "id": "doc-2", "dist": 0.9137, "attributes": { "lang": "es", "tags": ["blog"], "views": 87 } }
  ],
  "stats": { "took_ms": 41, "segments_scanned": 3, "vectors_scored": 2, "cache_hits": 3, "cache_misses": 0, "exhaustive": true }
}
```

`dist` is the distance for the namespace metric: lower is closer for `cosine_distance` and `euclidean_squared`, higher is closer for `dot_product`. Results are sorted best first. `include_attributes` may be `true` or a list of attribute names. Add `"include_vectors": true` to get the stored vectors back.

`stats.exhaustive` tells you whether every live vector was scored. It is `true` when there is no index yet or when a filter was applied, and `false` for an indexed search, which probes `nprobe` clusters (default 8). Raise `nprobe` for better recall at the cost of more bytes read:

```json
{ "vector": [...], "top_k": 10, "nprobe": 32 }
```

### Search with filters

Filters are evaluated in SQLite before any vector is scored, so they are exact: a row that matches the filter is never missed because of the index.

```bash
curl -X POST $VF/v1/namespaces/docs/query \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "vector": [0.1, -0.3, 0.9, 0.0],
    "top_k": 10,
    "filters": ["And", [
      ["lang", "Eq", "en"],
      ["views", "Gte", 100],
      ["tags", "Contains", "ai"],
      ["Not", ["id", "In", ["doc-9", "doc-10"]]]
    ]],
    "include_attributes": ["lang", "views"]
  }'
```

A filter is `[field, op, value]` or a combinator `["And", [...]]`, `["Or", [...]]`, `["Not", filter]`.

| op | value | meaning |
|---|---|---|
| `Eq`, `NotEq` | scalar or `null` | equality; `Eq null` matches a missing attribute |
| `Lt`, `Lte`, `Gt`, `Gte` | number or string | comparison |
| `In`, `NotIn` | array of scalars | membership, up to 10,000 values |
| `Glob`, `NotGlob` | string | SQLite GLOB pattern, `*` and `?` wildcards, case-sensitive |
| `Contains` | scalar | attribute is an array that contains the value |
| `ContainsAny` | array | attribute is an array that contains any of the values |

The field `id` can be filtered directly. Other fields are looked up in the attributes object.

### Read rows back

One row, with its vector:

```bash
curl "$VF/v1/namespaces/docs/rows/doc-1?include_vectors=true" -H "Authorization: Bearer $KEY"
```

```json
{ "id": "doc-1", "attributes": { "lang": "en", "tags": ["news", "ai"], "views": 1200 }, "vector": [0.12, -0.33, 0.91, 0.05] }
```

Several rows by id (up to 1,000):

```bash
curl -X POST $VF/v1/namespaces/docs/rows \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{ "ids": ["doc-1", "doc-2"], "include_vectors": false }'
```

Page through everything, ordered by id:

```bash
curl "$VF/v1/namespaces/docs/rows?limit=100" -H "Authorization: Bearer $KEY"
curl "$VF/v1/namespaces/docs/rows?limit=100&cursor=doc-1" -H "Authorization: Bearer $KEY"
```

The response carries `next_cursor`, or `null` on the last page.

### Update part of a row

`patch` merges attributes into the existing ones. Set a key to `null` to remove it. Pass a `vector` to replace the vector while keeping the attributes you do not mention.

```bash
curl -X POST $VF/v1/namespaces/docs/patch \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{ "rows": [
    { "id": "doc-1", "attributes": { "views": 1300, "tags": null } },
    { "id": "doc-2", "vector": [0.7, 0.2, -0.1, 0.5] }
  ] }'
```

```json
{ "patched": 2, "missing": [] }
```

Ids that do not exist are reported in `missing` and skipped. Attribute-only patches do not touch R2.

### Delete

By id:

```bash
curl -X POST $VF/v1/namespaces/docs/delete \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{ "ids": ["doc-2"] }'
```

By filter, using the same filter grammar as search:

```bash
curl -X POST $VF/v1/namespaces/docs/delete \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{ "filters": ["views", "Lt", 10] }'
```

```json
{ "deleted": 1 }
```

Deletes are immediate for reads. The vector bytes stay in R2 until the next index build compacts them away.

### Namespaces

```bash
curl $VF/v1/namespaces -H "Authorization: Bearer $KEY"                 # list
curl $VF/v1/namespaces/docs -H "Authorization: Bearer $KEY"            # stats
curl -X PUT $VF/v1/namespaces/docs -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -d '{ "distance_metric": "dot_product" }'   # create empty, pick metric
curl -X DELETE $VF/v1/namespaces/docs -H "Authorization: Bearer $KEY"  # destroy, including every R2 object
```

Stats look like this:

```json
{
  "name": "docs", "dim": 768, "distance_metric": "cosine_distance",
  "rows": 20000, "unindexed_rows": 0,
  "segments": { "wal": 0, "cluster": 79 }, "storage_bytes": 61591418,
  "index": { "version": 3, "clusters": 79 }, "created_at": 1791178539646
}
```

### The index

You normally do not have to think about it. After 2,000 new rows or 32 MB of new data, a build is scheduled 15 seconds later and runs in a separate Durable Object. Until then, new rows are searched exhaustively alongside the index, so results are always complete; only latency changes. To force a build:

```bash
curl -X POST $VF/v1/namespaces/docs/index -H "Authorization: Bearer $KEY"
```

```json
{ "status": "built", "rows": 20000, "clusters": 79, "version": 3, "took_ms": 63949 }
```

`status` is `already_running` if a build is in progress and `skipped` if there is nothing to do.

### TypeScript client

[`client/vecflare.ts`](client/vecflare.ts) is a small typed wrapper over `fetch` with no dependencies. Copy it into your project.

```ts
import { Vecflare } from "./vecflare";

const db = new Vecflare(process.env.VF!, process.env.KEY!);
const docs = db.namespace("docs");

await docs.upsert([{ id: "doc-1", vector: embedding, attributes: { lang: "en" } }]);
const { rows } = await docs.query(queryEmbedding, { top_k: 5, filters: ["lang", "Eq", "en"], include_attributes: true });
```

## Benchmarks

<!-- bench:start -->
Measured on 2026-10-05 against a real deployment (`vecflare.<subdomain>.workers.dev`, Workers Paid plan) from a client in a different region, so every number below includes about 25 to 50 ms of network round trip. Dataset: 20,000 vectors of 768 dimensions (61 MB of float32) in 64 random clusters, `top_k` 10, default `nprobe` 8.

| Operation | p50 | p90 | p99 |
|---|---|---|---|
| Upsert 500 rows (one 7.7 MB JSON request) | 794 ms | 1,008 ms | 1,343 ms |
| Query, no index yet (exhaustive scan of 61 MB) | 392 ms | 720 ms | 720 ms |
| Query, indexed, clusters not cached | 308 ms | 524 ms | 583 ms |
| Query, indexed, same probes repeated | 199 ms | 321 ms | 348 ms |
| Query, indexed, all probed clusters cached | 50 ms | 75 ms | 76 ms |
| Query with an attribute filter (~312 matching rows) | 55 ms | 98 ms | 98 ms |
| Fetch one row with its vector (R2 range read) | 90 ms | 141 ms | 144 ms |

Index build for the 20,000 rows: 40 s wall, of which about 2 s is CPU. The rest is R2 round trips. Each indexed query scored about 2,200 of the 20,000 vectors.

The two indexed rows in the middle differ only in cache state. The namespace's cache is 24 MB and the 30 probes touched about 47 MB of clusters, so the second pass still missed 60% of the time. A workload whose hot set fits in 24 MB sees the last row.
<!-- bench:end -->

Run it yourself against any deployment:

```bash
node scripts/bench.mjs https://vecflare.<your-subdomain>.workers.dev $KEY 20000 768
```

## Cost

What a namespace costs is what Cloudflare bills for the resources it touches. Prices below are Cloudflare's list prices for the Workers Paid plan at the time of writing.

| Resource | Price | What vecflare does with it |
|---|---|---|
| R2 storage | $0.015 / GB-month | vectors, float32, plus about 2% for ids and headers |
| R2 Class A (writes) | $4.50 / million | one per committed write batch, plus a few hundred per index build |
| R2 Class B (reads) | $0.36 / million | one per segment read that misses the cache, one per vector fetched by id |
| Durable Object requests | $0.15 / million | one per API call |
| Durable Object duration | $12.50 / million GB-s | wall time of each call, at 128 MB |
| SQLite rows read / written | $0.001 / $1.00 per million | attribute filters, row bookkeeping, one write per row per build |
| Workers requests | $0.30 / million | one per API call |

Worked example, 1,000,000 vectors of 768 dimensions (3 GB), 100,000 writes and 1,000,000 queries a month, every query missing the cache and probing 8 clusters:

| | per month |
|---|---|
| R2 storage, 3.1 GB | $0.05 |
| R2 writes, ~2,000 batches plus 2 builds | $0.03 |
| R2 reads, 8 per query | $2.88 |
| Durable Object + Workers requests, 1.1 M | $0.50 |
| Durable Object duration, ~0.3 s per query at 128 MB | $0.47 |
| SQLite row writes, 2 builds | $2.00 |
| **Total** | **about $6** |

The $5 monthly Workers Paid subscription is on top of that. A workload whose queries mostly hit the cache costs less than this, because the R2 reads disappear.

## Limits

These are the limits of version 0.1, not of the design.

- **One namespace is one Durable Object.** A Durable Object handles requests one at a time with interleaved I/O, which in practice means a few hundred queries per second per namespace. Spread hot workloads across namespaces.
- **Index build is JavaScript in a Durable Object.** It streams, so memory stays flat, but CPU grows with `rows × clusters × dimensions`. A build of 20,000 × 768 takes about 40 seconds, almost all of it waiting on R2. Builds run under the Worker CPU limit, which is 5 minutes on the paid plan and 10 ms on the free plan; on the free plan, builds beyond a few thousand rows will fail and the namespace keeps working with exhaustive search.
- **Up to 256 clusters per index**, so a cluster of a 1M-row namespace holds about 4,000 vectors and a default query reads about 3% of the data. Larger namespaces work but read proportionally more per query.
- **Vectors are float32**, no quantization yet.
- **No full-text search.**
- **Filters scan SQLite**, not an index on attributes. A filter that matches 100,000 rows is fine; one that matches 10,000,000 is slow.
- **Request bodies** are limited by your Cloudflare plan: 100 MB on Free and Pro. 10,000 rows of 1,536 dimensions as JSON is about 250 MB, so batch smaller than that.
- Vector dimension up to 8,192. Ids up to 256 bytes. Attributes up to 64 KB per row.

## Development

```bash
npm install
npm run types        # regenerate worker-configuration.d.ts from wrangler.jsonc
npm run typecheck
npm test             # vitest inside workerd, with real R2 and Durable Object emulation
```

The tests cover the segment format, filters, the top-k heap, k-means, and the whole HTTP API including index builds, builds interrupted midway, and the alarm that triggers them.

## License

MIT.
