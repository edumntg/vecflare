import { DurableObject } from "cloudflare:workers";
import { makeScorer, lowerIsBetter, normalizeInPlace, METRICS } from "./distance";
import { fail } from "./errors";
import { compileFilter } from "./filters";
import { nearestCentroids } from "./kmeans";
import { LruCache } from "./lru";
import { Segment, encodeSegment, estimateRowBytes, vectorRange } from "./segment";
import { TopK, type Candidate } from "./topk";
import type {
  Attributes,
  Metric,
  NamespaceStats,
  PatchRow,
  QueryRequest,
  QueryResponse,
  QueryRow,
  StoredRow,
  UpsertRow,
  Filter,
} from "./types";

export const SEGMENT_MAX_BYTES = 4 * 1024 * 1024;
const COMMIT_WINDOW_MS = 50;
// Memory budget inside one 128 MB isolate: cache + segments in flight + request bodies being parsed.
const CACHE_BYTES = 24 * 1024 * 1024;
export const AUTO_INDEX_ROWS = 2000;
export const AUTO_INDEX_WAL_BYTES = 32 * 1024 * 1024;
const AUTO_INDEX_DELAY_MS = 15_000;
const AUTO_INDEX_RETRY_MS = 60_000;
const DEFAULT_NPROBE = 8;
const MAX_TOP_K = 1000;
const MAX_DIM = 8192;
const MAX_ID_BYTES = 256;
const MAX_ATTRS_BYTES = 64 * 1024;
const MAX_BATCH_ROWS = 10_000;
const SCAN_CONCURRENCY = 2;
const OVERFETCH = 3;
// Durable Object SQLite caps bound parameters per statement, so id lists are passed as one JSON array.
const IN_JSON = "(SELECT value FROM json_each(?))";

interface Meta {
  name: string | null;
  dim: number | null;
  metric: Metric;
  seq: number;
  indexVersion: number;
  /** Monotonic build counter. A build number is never reused, even after an abort, so file names never collide. */
  buildSeq: number;
  clusters: number;
  createdAt: number | null;
}

interface PendingRow {
  id: string;
  vector: Float32Array;
  attrs: string | null;
}

export type BuildPlan =
  | { status: "skipped"; reason: string }
  | { status: "ready"; dim: number; metric: Metric; version: number; prefix: string; live: number; sources: string[] };

export class VecNamespace extends DurableObject<Env> {
  private sql: SqlStorage;
  private meta!: Meta;
  private cache = new LruCache<Segment>(CACHE_BYTES);
  private centroids: { version: number; data: Float32Array } | null = null;
  private pending: PendingRow[] = [];
  private flushing: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.initSchema();
      this.meta = this.loadMeta();
    });
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rows (
        id TEXT PRIMARY KEY,
        seg TEXT NOT NULL,
        idx INTEGER NOT NULL,
        attrs TEXT
      );
      CREATE INDEX IF NOT EXISTS rows_seg ON rows(seg);
      CREATE TABLE IF NOT EXISTS segments (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        cluster INTEGER,
        count INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        frozen INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL
      );
    `);
  }

  private loadMeta(): Meta {
    const m: Meta = { name: null, dim: null, metric: "cosine_distance", seq: 0, indexVersion: 0, buildSeq: 0, clusters: 0, createdAt: null };
    for (const r of this.sql.exec<{ k: string; v: string }>("SELECT k, v FROM meta")) {
      switch (r.k) {
        case "name": m.name = r.v; break;
        case "dim": m.dim = Number(r.v); break;
        case "metric": m.metric = r.v as Metric; break;
        case "seq": m.seq = Number(r.v); break;
        case "indexVersion": m.indexVersion = Number(r.v); break;
        case "buildSeq": m.buildSeq = Number(r.v); break;
        case "clusters": m.clusters = Number(r.v); break;
        case "createdAt": m.createdAt = Number(r.v); break;
      }
    }
    return m;
  }

  private setMeta(patch: Partial<Meta>): void {
    Object.assign(this.meta, patch);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined) this.sql.exec("DELETE FROM meta WHERE k = ?", k);
      else this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, String(v));
    }
  }

  private get prefix(): string {
    return `ns/${this.meta.name}/`;
  }

  private ensureName(name: string): boolean {
    if (this.meta.name === null) {
      this.setMeta({ name, createdAt: Date.now() });
      return true;
    }
    if (this.meta.name !== name) fail(500, "namespace name mismatch");
    return false;
  }

  // ---- public RPC surface ----

  async configure(name: string, opts: { distance_metric?: Metric }): Promise<{ created: boolean }> {
    const created = this.ensureName(name);
    if (opts.distance_metric !== undefined) {
      if (!METRICS.includes(opts.distance_metric)) fail(400, `distance_metric must be one of ${METRICS.join(", ")}`);
      if (opts.distance_metric !== this.meta.metric) {
        if (this.meta.dim !== null) fail(409, "distance_metric cannot change once the namespace has data");
        this.setMeta({ metric: opts.distance_metric });
      }
    }
    return { created };
  }

  async upsert(name: string, rows: UpsertRow[], opts: { distance_metric?: Metric } = {}): Promise<{ upserted: number; created: boolean }> {
    const created = this.ensureName(name);
    if (opts.distance_metric !== undefined) await this.configure(name, opts);
    if (!Array.isArray(rows) || rows.length === 0) fail(400, "rows must be a non-empty array");
    if (rows.length > MAX_BATCH_ROWS) fail(400, `at most ${MAX_BATCH_ROWS} rows per request`);

    const prepared: PendingRow[] = [];
    for (const r of rows) {
      prepared.push({ id: this.checkId(r.id), vector: this.checkVector(r.vector), attrs: this.checkAttrs(r.attributes) });
    }
    await this.enqueue(prepared);
    return { upserted: prepared.length, created };
  }

  async patch(name: string, rows: PatchRow[]): Promise<{ patched: number; missing: string[] }> {
    this.ensureName(name);
    if (!Array.isArray(rows) || rows.length === 0) fail(400, "rows must be a non-empty array");
    if (rows.length > MAX_BATCH_ROWS) fail(400, `at most ${MAX_BATCH_ROWS} rows per request`);

    const missing: string[] = [];
    const reinsert: PendingRow[] = [];
    let patched = 0;
    for (const r of rows) {
      const id = this.checkId(r.id);
      const cur = this.sql.exec<{ attrs: string | null }>("SELECT attrs FROM rows WHERE id = ?", id).toArray()[0];
      if (!cur) {
        missing.push(id);
        continue;
      }
      let attrs = cur.attrs;
      if (r.attributes !== undefined) {
        const merged: Attributes = cur.attrs ? JSON.parse(cur.attrs) : {};
        if (typeof r.attributes !== "object" || r.attributes === null || Array.isArray(r.attributes)) fail(400, "attributes must be an object");
        for (const [k, v] of Object.entries(r.attributes)) {
          if (v === null) delete merged[k];
          else merged[k] = v;
        }
        attrs = this.checkAttrs(merged);
      }
      if (r.vector !== undefined) {
        reinsert.push({ id, vector: this.checkVector(r.vector), attrs });
      } else if (r.attributes !== undefined) {
        this.sql.exec("UPDATE rows SET attrs = ? WHERE id = ?", attrs, id);
      }
      patched++;
    }
    if (reinsert.length) await this.enqueue(reinsert);
    return { patched, missing };
  }

  async deleteRows(name: string, ids: string[]): Promise<{ deleted: number }> {
    this.ensureName(name);
    if (!Array.isArray(ids) || ids.length === 0) fail(400, "ids must be a non-empty array");
    if (ids.length > MAX_BATCH_ROWS) fail(400, `at most ${MAX_BATCH_ROWS} ids per request`);
    for (const id of ids) this.checkId(id);
    this.sql.exec(`DELETE FROM rows WHERE id IN ${IN_JSON}`, JSON.stringify(ids));
    return { deleted: this.changes() };
  }

  async deleteByFilter(name: string, filter: Filter): Promise<{ deleted: number }> {
    this.ensureName(name);
    const { sql, params } = compileFilter(filter);
    this.sql.exec(`DELETE FROM rows WHERE ${sql}`, ...params);
    return { deleted: this.changes() };
  }

  async getRows(name: string, ids: string[], includeVectors: boolean): Promise<{ rows: StoredRow[] }> {
    this.ensureName(name);
    if (!Array.isArray(ids) || ids.length === 0) fail(400, "ids must be a non-empty array");
    if (ids.length > 1000) fail(400, "at most 1000 ids per request");
    const found = this.sql
      .exec<{ id: string; seg: string; idx: number; attrs: string | null }>(
        `SELECT id, seg, idx, attrs FROM rows WHERE id IN ${IN_JSON}`,
        JSON.stringify(ids),
      )
      .toArray();
    const out: StoredRow[] = [];
    if (includeVectors && this.meta.dim) {
      const dim = this.meta.dim;
      await Promise.all(
        found.map(async (r) => {
          const vec = await this.readVector(r.seg, r.idx, dim);
          out.push({ id: r.id, attributes: r.attrs ? JSON.parse(r.attrs) : null, vector: vec ? Array.from(vec) : undefined });
        }),
      );
      const order = new Map(found.map((r, i) => [r.id, i]));
      out.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    } else {
      for (const r of found) out.push({ id: r.id, attributes: r.attrs ? JSON.parse(r.attrs) : null });
    }
    return { rows: out };
  }

  async listRows(name: string, cursor: string | null, limit: number): Promise<{ rows: StoredRow[]; next_cursor: string | null }> {
    this.ensureName(name);
    limit = Math.min(Math.max(1, limit || 100), 1000);
    const rows = this.sql
      .exec<{ id: string; attrs: string | null }>(
        cursor ? "SELECT id, attrs FROM rows WHERE id > ? ORDER BY id LIMIT ?" : "SELECT id, attrs FROM rows ORDER BY id LIMIT ?",
        ...(cursor ? [cursor, limit + 1] : [limit + 1]),
      )
      .toArray();
    const more = rows.length > limit;
    const page = rows.slice(0, limit).map((r) => ({ id: r.id, attributes: r.attrs ? JSON.parse(r.attrs) : null }));
    return { rows: page, next_cursor: more ? page[page.length - 1].id : null };
  }

  async query(name: string, q: QueryRequest): Promise<QueryResponse> {
    this.ensureName(name);
    const t0 = Date.now();
    if (this.meta.dim === null) {
      return { rows: [], stats: { took_ms: 0, segments_scanned: 0, vectors_scored: 0, cache_hits: 0, cache_misses: 0, exhaustive: true, index_version: 0, stale_candidates: 0 } };
    }
    const dim = this.meta.dim;
    const qv = this.checkVector(q.vector);
    const topK = Math.min(Math.max(1, q.top_k ?? 10), MAX_TOP_K);
    const metric = q.distance_metric ?? this.meta.metric;
    if (!METRICS.includes(metric)) fail(400, `distance_metric must be one of ${METRICS.join(", ")}`);
    const scorer = makeScorer(metric, qv);
    const heap = new TopK(topK * OVERFETCH, lowerIsBetter(metric));

    // Plan: which segments to read, and within each, which row offsets (null = all).
    const plan = new Map<string, number[] | null>();
    let exhaustive = true;
    if (q.filters !== undefined) {
      const { sql, params } = compileFilter(q.filters);
      for (const r of this.sql.exec<{ seg: string; idx: number }>(`SELECT seg, idx FROM rows WHERE ${sql}`, ...params)) {
        let list = plan.get(r.seg);
        if (list === undefined) plan.set(r.seg, (list = []));
        list!.push(r.idx);
      }
    } else {
      // Everything outside the current index version gets scanned in full: WAL segments, cluster files of a build
      // still in progress, and leftovers from an interrupted build. Only the current version is routed by centroid.
      for (const r of this.sql.exec<{ key: string }>("SELECT key FROM segments WHERE kind = 'wal' OR version != ?", this.meta.indexVersion)) plan.set(r.key, null);
      if (this.meta.indexVersion > 0) {
        const version = this.meta.indexVersion;
        const centroids = await this.loadCentroids();
        // Centroids, cluster count and cluster files must all come from the same version. If a build finished during
        // the centroid read, fall back to scanning everything rather than routing with mismatched state.
        if (centroids && this.meta.indexVersion === version && centroids.length === this.meta.clusters * dim) {
          const probe = Math.min(Math.max(1, q.nprobe ?? DEFAULT_NPROBE), this.meta.clusters);
          const routed = metric === "cosine_distance" ? normalized(qv) : qv;
          const picked = nearestCentroids(centroids, this.meta.clusters, routed, probe);
          exhaustive = picked.length === this.meta.clusters;
          for (const r of this.sql.exec<{ key: string }>(
            `SELECT key FROM segments WHERE kind = 'cluster' AND version = ? AND cluster IN ${IN_JSON}`,
            version,
            JSON.stringify(picked),
          ))
            plan.set(r.key, null);
        } else {
          for (const r of this.sql.exec<{ key: string }>("SELECT key FROM segments WHERE kind = 'cluster'")) plan.set(r.key, null);
        }
      }
    }

    const hits0 = this.cache.hits;
    const miss0 = this.cache.misses;
    let scored = 0;
    let scanned = 0;
    const keys = Array.from(plan.keys());
    // A scan larger than the cache would only evict itself; stream it instead.
    const planBytes = keys.length
      ? this.sql.exec<{ b: number }>(`SELECT COALESCE(SUM(bytes), 0) AS b FROM segments WHERE key IN ${IN_JSON}`, JSON.stringify(keys)).one().b
      : 0;
    const useCache = planBytes <= CACHE_BYTES;
    let next = 0;
    const worker = async () => {
      while (next < keys.length) {
        const key = keys[next++];
        const seg = await this.loadSegment(key, useCache);
        if (!seg) continue;
        scanned++;
        const only = plan.get(key);
        if (only === null || only === undefined) {
          for (let i = 0; i < seg.count; i++) {
            const d = scorer(seg.vectors, i * dim);
            scored++;
            if (heap.accepts(d)) heap.push({ id: seg.ids[i], dist: d, seg: key, idx: i });
          }
        } else {
          for (const i of only) {
            if (i >= seg.count) continue;
            const d = scorer(seg.vectors, i * dim);
            scored++;
            if (heap.accepts(d)) heap.push({ id: seg.ids[i], dist: d, seg: key, idx: i });
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, keys.length) }, worker));

    // Segments are immutable, so a scored row may be a stale copy. The rows table says where the live copy is.
    const cands = heap.sorted();
    const live = new Map<string, { seg: string; idx: number; attrs: string | null }>();
    for (const r of this.sql.exec<{ id: string; seg: string; idx: number; attrs: string | null }>(
      `SELECT id, seg, idx, attrs FROM rows WHERE id IN ${IN_JSON}`,
      JSON.stringify(cands.map((c) => c.id)),
    ))
      live.set(r.id, r);
    const out: QueryRow[] = [];
    const seen = new Set<string>();
    let stale = 0;
    for (const c of cands) {
      const l = live.get(c.id);
      if (!l || l.seg !== c.seg || l.idx !== c.idx || seen.has(c.id)) {
        stale++;
        continue;
      }
      seen.add(c.id);
      const row: QueryRow = { id: c.id, dist: c.dist };
      if (q.include_attributes) {
        const attrs: Attributes = l.attrs ? JSON.parse(l.attrs) : {};
        row.attributes = Array.isArray(q.include_attributes) ? pick(attrs, q.include_attributes) : attrs;
      }
      if (q.include_vectors) {
        const seg = this.cache.get(c.seg);
        row.vector = Array.from(seg ? seg.vector(c.idx) : (await this.readVector(c.seg, c.idx, dim)) ?? []);
      }
      out.push(row);
      if (out.length === topK) break;
    }
    return {
      rows: out,
      stats: {
        took_ms: Date.now() - t0,
        segments_scanned: scanned,
        vectors_scored: scored,
        cache_hits: this.cache.hits - hits0,
        cache_misses: this.cache.misses - miss0,
        exhaustive,
        index_version: this.meta.indexVersion,
        stale_candidates: stale,
      },
    };
  }

  async stats(name: string): Promise<NamespaceStats> {
    this.ensureName(name);
    const rows = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM rows").one().n;
    const unindexed = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM rows WHERE seg IN (SELECT key FROM segments WHERE kind = 'wal' OR version != ?)", this.meta.indexVersion).one().n;
    const segs = { wal: 0, cluster: 0 };
    let bytes = 0;
    for (const r of this.sql.exec<{ kind: string; n: number; b: number }>("SELECT kind, COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM segments GROUP BY kind")) {
      if (r.kind === "wal") segs.wal = r.n;
      if (r.kind === "cluster") segs.cluster = r.n;
      bytes += r.b;
    }
    return {
      name,
      dim: this.meta.dim,
      distance_metric: this.meta.metric,
      rows,
      unindexed_rows: unindexed,
      segments: segs,
      storage_bytes: bytes,
      index: this.meta.indexVersion > 0 ? { version: this.meta.indexVersion, clusters: this.meta.clusters } : null,
      created_at: this.meta.createdAt,
    };
  }

  // ---- index build protocol, driven by the Indexer Durable Object ----
  // The heavy work runs elsewhere so this object keeps answering reads and writes. Each call here is short.

  async beginBuild(name: string, force: boolean): Promise<BuildPlan> {
    this.ensureName(name);
    if (this.meta.dim === null) return { status: "skipped", reason: "empty" };
    const live = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM rows").one().n;
    if (live === 0) return { status: "skipped", reason: "empty" };
    if (!force) {
      const wal = this.sql.exec<{ n: number; b: number }>("SELECT COALESCE(SUM(count), 0) AS n, COALESCE(SUM(bytes), 0) AS b FROM segments WHERE kind = 'wal'").one();
      if (wal.n < AUTO_INDEX_ROWS && wal.b < AUTO_INDEX_WAL_BYTES) return { status: "skipped", reason: "below threshold" };
    }
    // Every segment present now is a source. Rows written during the build land in new, unfrozen WAL segments.
    this.sql.exec("UPDATE segments SET frozen = 1");
    const sources = this.sql.exec<{ key: string }>("SELECT key FROM segments WHERE frozen = 1 ORDER BY key").toArray().map((r) => r.key);
    const version = this.meta.buildSeq + 1;
    this.setMeta({ buildSeq: version });
    return { status: "ready", dim: this.meta.dim, metric: this.meta.metric, version, prefix: this.prefix, live, sources };
  }

  async liveOffsets(name: string, keys: string[]): Promise<Record<string, number[]>> {
    this.ensureName(name);
    const out: Record<string, number[]> = {};
    for (const k of keys) out[k] = [];
    for (const r of this.sql.exec<{ seg: string; idx: number }>(`SELECT seg, idx FROM rows WHERE seg IN ${IN_JSON} ORDER BY seg, idx`, JSON.stringify(keys))) {
      out[r.seg].push(r.idx);
    }
    return out;
  }

  async commitClusterFile(name: string, file: { key: string; version: number; cluster: number; ids: string[]; bytes: number }): Promise<void> {
    this.ensureName(name);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO segments (key, kind, version, cluster, count, bytes, frozen, created) VALUES (?, 'cluster', ?, ?, ?, ?, 0, ?)",
        file.key, file.version, file.cluster, file.ids.length, file.bytes, Date.now(),
      );
      // One statement per file: the row's new offset is its position in the ids array (json_each exposes it as key).
      // Only rows still pointing at a frozen source move; anything updated mid-build keeps its newer location.
      const ids = JSON.stringify(file.ids);
      this.sql.exec(
        `UPDATE rows SET seg = ?1, idx = (SELECT j.key FROM json_each(?2) j WHERE j.value = rows.id)
         WHERE id IN (SELECT value FROM json_each(?2)) AND seg IN (SELECT key FROM segments WHERE frozen = 1)`,
        file.key, ids,
      );
    });
  }

  async finishBuild(name: string, version: number, clusters: number): Promise<{ moved: number; dropped: string[] }> {
    this.ensureName(name);
    const previous = this.meta.indexVersion;
    this.setMeta({ indexVersion: version, clusters });
    this.centroids = null;
    const moved = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM rows WHERE seg IN (SELECT key FROM segments WHERE kind = 'cluster' AND version = ?)", version).one().n;
    // Sources with no live rows left are garbage. Sources that still hold live rows stay as WAL so they keep being scanned.
    const dropped: string[] = [];
    for (const r of this.sql.exec<{ key: string }>("SELECT key FROM segments WHERE frozen = 1").toArray()) {
      const n = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM rows WHERE seg = ?", r.key).one().n;
      if (n === 0) {
        this.sql.exec("DELETE FROM segments WHERE key = ?", r.key);
        this.cache.delete(r.key);
        dropped.push(r.key);
      } else {
        this.sql.exec("UPDATE segments SET kind = 'wal', frozen = 0 WHERE key = ?", r.key);
      }
    }
    if (previous > 0) dropped.push(`${this.prefix}index/v${previous}/centroids.bin`);
    return { moved, dropped };
  }

  async abortBuild(name: string, version: number): Promise<void> {
    this.ensureName(name);
    this.sql.exec("UPDATE segments SET frozen = 0");
    // Rows may already point at cluster files of the aborted version, so those files stay and are scanned like WAL.
    this.sql.exec("UPDATE segments SET kind = 'wal', version = 0, cluster = NULL WHERE kind = 'cluster' AND version = ?", version);
  }

  async destroy(name: string): Promise<{ deleted_objects: number }> {
    this.ensureName(name);
    let deleted = 0;
    let cursor: string | undefined;
    do {
      const page = await this.env.BUCKET.list({ prefix: this.prefix, cursor, limit: 1000 });
      if (page.objects.length) {
        await this.env.BUCKET.delete(page.objects.map((o) => o.key));
        deleted += page.objects.length;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.cache.clear();
    this.centroids = null;
    this.pending = [];
    this.initSchema();
    this.meta = this.loadMeta();
    return { deleted_objects: deleted };
  }

  async alarm(): Promise<void> {
    if (!this.meta.name) return;
    const indexer = this.env.INDEXER.get(this.env.INDEXER.idFromName(this.meta.name));
    try {
      await indexer.build(this.meta.name, false);
    } catch (err) {
      console.error("index build failed, retrying later", this.meta.name, err);
      await this.ctx.storage.setAlarm(Date.now() + AUTO_INDEX_RETRY_MS);
    }
  }

  // ---- write path ----

  private async enqueue(rows: PendingRow[]): Promise<void> {
    for (const r of rows) this.pending.push(r);
    if (!this.flushing) {
      this.flushing = (async () => {
        await new Promise((res) => setTimeout(res, COMMIT_WINDOW_MS));
        const batch = this.pending;
        this.pending = [];
        this.flushing = null;
        await this.commit(batch);
      })();
    }
    await this.flushing;
  }

  private async commit(batch: PendingRow[]): Promise<void> {
    if (batch.length === 0) return;
    const dim = this.meta.dim!;
    const latest = new Map<string, PendingRow>();
    for (const r of batch) latest.set(r.id, r);
    const rows = Array.from(latest.values());

    let i = 0;
    while (i < rows.length) {
      const chunk: PendingRow[] = [];
      let bytes = 0;
      while (i < rows.length && (chunk.length === 0 || bytes + estimateRowBytes(rows[i].id, dim) <= SEGMENT_MAX_BYTES)) {
        bytes += estimateRowBytes(rows[i].id, dim);
        chunk.push(rows[i++]);
      }
      const seq = this.meta.seq + 1;
      this.setMeta({ seq });
      const key = `${this.prefix}wal/${String(seq).padStart(12, "0")}.bin`;
      const data = encodeSegment(chunk.map((r) => r.id), concat(chunk.map((r) => r.vector), dim), dim);
      await this.env.BUCKET.put(key, data);
      this.ctx.storage.transactionSync(() => {
        this.sql.exec("INSERT INTO segments (key, kind, version, count, bytes, frozen, created) VALUES (?, 'wal', 0, ?, ?, 0, ?)", key, chunk.length, data.byteLength, Date.now());
        for (let j = 0; j < chunk.length; j++) {
          this.sql.exec(
            "INSERT INTO rows (id, seg, idx, attrs) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET seg = excluded.seg, idx = excluded.idx, attrs = excluded.attrs",
            chunk[j].id, key, j, chunk[j].attrs,
          );
        }
      });
      this.cache.set(key, new Segment(data.buffer as ArrayBuffer));
    }
    await this.maybeScheduleIndex();
  }

  private async maybeScheduleIndex(): Promise<void> {
    const wal = this.sql.exec<{ n: number; b: number }>("SELECT COALESCE(SUM(count), 0) AS n, COALESCE(SUM(bytes), 0) AS b FROM segments WHERE kind = 'wal'").one();
    if (wal.n < AUTO_INDEX_ROWS && wal.b < AUTO_INDEX_WAL_BYTES) return;
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + AUTO_INDEX_DELAY_MS);
  }

  // ---- read helpers ----

  private async loadSegment(key: string, cache = true): Promise<Segment | null> {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const obj = await this.env.BUCKET.get(key);
    if (!obj) return null;
    const seg = new Segment(await obj.arrayBuffer());
    if (cache) this.cache.set(key, seg);
    return seg;
  }

  private async readVector(key: string, idx: number, dim: number): Promise<Float32Array | null> {
    const cached = this.cache.get(key);
    if (cached) return idx < cached.count ? cached.vector(idx) : null;
    const obj = await this.env.BUCKET.get(key, { range: vectorRange(idx, dim) });
    if (!obj) return null;
    return new Float32Array(await obj.arrayBuffer());
  }

  private async loadCentroids(): Promise<Float32Array | null> {
    const version = this.meta.indexVersion;
    if (this.centroids?.version === version) return this.centroids.data;
    const obj = await this.env.BUCKET.get(`${this.prefix}index/v${version}/centroids.bin`);
    if (!obj) return null;
    const data = new Float32Array(await obj.arrayBuffer());
    // A build may have finished while this read was in flight; never cache centroids under the wrong version.
    if (this.meta.indexVersion !== version) return data;
    this.centroids = { version, data };
    return data;
  }

  private changes(): number {
    return this.sql.exec<{ c: number }>("SELECT changes() AS c").one().c;
  }

  // ---- validation ----

  private checkId(id: unknown): string {
    if (typeof id !== "string" || id.length === 0) fail(400, "id must be a non-empty string");
    if (new TextEncoder().encode(id).length > MAX_ID_BYTES) fail(400, `id must be at most ${MAX_ID_BYTES} bytes`);
    return id;
  }

  private checkVector(v: unknown): Float32Array {
    if (!Array.isArray(v) || v.length === 0) fail(400, "vector must be a non-empty array of numbers");
    if (v.length > MAX_DIM) fail(400, `vector has ${v.length} dimensions; max is ${MAX_DIM}`);
    if (this.meta.dim === null) this.setMeta({ dim: v.length });
    else if (v.length !== this.meta.dim) fail(400, `vector has ${v.length} dimensions; namespace uses ${this.meta.dim}`);
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) {
      const x = v[i];
      if (typeof x !== "number" || !Number.isFinite(x)) fail(400, `vector[${i}] is not a finite number`);
      out[i] = x;
    }
    return out;
  }

  private checkAttrs(a: unknown): string | null {
    if (a === undefined || a === null) return null;
    if (typeof a !== "object" || Array.isArray(a)) fail(400, "attributes must be an object");
    const s = JSON.stringify(a);
    if (s.length > MAX_ATTRS_BYTES) fail(400, `attributes must be at most ${MAX_ATTRS_BYTES} bytes as JSON`);
    return s;
  }
}

function concat(vecs: Float32Array[], dim: number): Float32Array {
  const out = new Float32Array(vecs.length * dim);
  for (let i = 0; i < vecs.length; i++) out.set(vecs[i], i * dim);
  return out;
}

function normalized(v: Float32Array): Float32Array {
  const out = Float32Array.from(v);
  normalizeInPlace(out);
  return out;
}

function pick(attrs: Attributes, keys: string[]): Attributes {
  const out: Attributes = {};
  for (const k of keys) if (k in attrs) out[k] = attrs[k];
  return out;
}
