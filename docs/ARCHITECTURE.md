# Architecture

vecflare stores vectors in R2 and keeps the small, mutable state in a SQLite-backed Durable Object. There is one Durable Object per namespace. Nothing else is stateful.

```
client ──HTTP──▶ Worker (auth, routing) ──RPC──▶ VecNamespace Durable Object ──▶ R2 bucket
                                                   │  SQLite: rows, segments, meta
                                                   │  memory: LRU of segments, centroids
                                                   └──▶ alarm: background index build
```

## Storage layout

Everything for a namespace lives under one R2 prefix:

```
ns/<name>/wal/000000000001.bin          committed write batches, newest last
ns/<name>/index/v<N>/centroids.bin      k × dim float32, current index version
ns/<name>/index/v<N>/c<i>-<j>.bin       vectors assigned to cluster i, file j
```

Every `.bin` file is a *segment*: a 32-byte header, then `count × dim` float32 vectors, then the row ids. Vectors come first so that reading one vector is a single range request at a fixed offset. Segments are immutable. A segment is at most 4 MB.

The Durable Object's SQLite holds three tables:

- `rows(id, seg, idx, attrs)`: for every live row, which segment holds its current vector, at which offset, and its attributes as JSON. This table is the truth. If a vector exists in a segment but no row points at it, it is dead.
- `segments(key, kind, version, cluster, count, bytes, ...)`: what files exist. `kind` is `wal` or `cluster`.
- `meta`: dimension, distance metric, sequence number, current index version.

## Write path

An upsert is validated, buffered for up to 50 ms so concurrent requests share one commit, deduplicated by id, encoded as one or more WAL segments and written to R2. Only then are `rows` and `segments` updated in one SQLite transaction. The request returns after the transaction commits, so an acknowledged write survives anything short of losing the bucket.

Updating a row writes a new copy into a new WAL segment and repoints `rows`. The old copy stays in its segment until the next index build drops it. Deleting a row only deletes from `rows`.

Attribute-only patches do not touch R2 at all.

## Query path

1. If the query has a filter, SQLite evaluates it first and returns `(seg, idx)` pairs. Only those offsets are scored. This is exact pre-filtering, so filtered results never miss a matching row.
2. Without a filter and without an index, every WAL segment is scanned. This is exact.
3. Without a filter and with an index, the query vector is compared against the centroids, the `nprobe` nearest clusters are read, and every WAL segment written since the last build is scanned too. This is approximate: a row whose true cluster was not probed is missed.

Scoring runs over the raw float32 arrays with a bounded heap. Candidates are over-fetched 3× and checked against `rows` so that stale copies of updated rows are dropped.

Segments are cached in memory (24 MB LRU per Durable Object) after the first read. A scan larger than the cache streams instead of evicting itself. Centroids are held in memory once loaded.

## Index build

The index is IVF: k-means centroids plus one bucket of vectors per centroid. The build runs inside the Durable Object, either from a 15-second alarm after enough unindexed data accumulates or on demand via `POST /index`.

1. Mark every existing segment as a source. Writes that arrive during the build go to new WAL segments and are not touched.
2. Reservoir-sample up to 4096 live vectors (8 MB max), run Lloyd's k-means for 6 iterations. k is chosen so clusters are around 2 MB or 256 rows, capped at 256.
3. Stream every source segment once, assign each live vector to its nearest centroid, and flush buffered rows into per-cluster part files every 8 MB.
4. For each cluster, stream its parts into final cluster files of at most 4 MB, inserting the new segments and repointing `rows` in a transaction per file. The repoint is conditional on the row still living in a source segment, so a row updated mid-build keeps its newer location.
5. Write `centroids.bin`, bump the index version, delete source segments that no longer hold any live row, and delete the previous version's centroids.

Peak memory during a build stays around 30 MB regardless of namespace size, which is what the 128 MB Durable Object budget demands. CPU is the real cost: assignment is `rows × k × dim` multiplications in JavaScript.

## Cosine metric

For `cosine_distance`, k-means runs on normalized copies and the query vector is normalized before centroid routing. Stored vectors are kept as given, so switching `distance_metric` at query time still produces correct scores; only the index routing was tuned for the namespace metric.

## What is not here yet

- Full-text (BM25) search.
- Sharding a namespace across several Durable Objects. Today one namespace is one Durable Object, which bounds throughput to what one object can do (roughly a few hundred queries per second) and bounds the index build to what fits in five minutes of CPU.
- Quantization. Vectors are stored and scored as float32.
- A Container-based indexer for namespaces where the in-object build is too slow.
