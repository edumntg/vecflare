import { DurableObject } from "cloudflare:workers";
import { normalizeInPlace } from "./distance";
import { kmeans, nearestCentroid } from "./kmeans";
import { SEGMENT_MAX_BYTES, type BuildPlan } from "./namespace";
import { Segment, encodeSegment } from "./segment";

// One Indexer per namespace. It owns the CPU and memory of an index build so the namespace object stays responsive.
// It talks to R2 directly and to the namespace only through short RPC calls.

const PART_BUFFER_BYTES = 16 * 1024 * 1024;
const READ_AHEAD = 3;
const TARGET_CLUSTER_BYTES = 2 * 1024 * 1024;
const TARGET_CLUSTER_ROWS = 256;
const MAX_CLUSTERS = 256;
const SAMPLE_MAX_ROWS = 4096;
const SAMPLE_MAX_BYTES = 8 * 1024 * 1024;
const KMEANS_ITERS = 6;
const MERGE_CONCURRENCY = 4;

export interface BuildResult {
  status: "built" | "skipped" | "already_running";
  reason?: string;
  rows?: number;
  clusters?: number;
  version?: number;
  took_ms?: number;
}

export class Indexer extends DurableObject<Env> {
  private building = false;

  async build(name: string, force: boolean): Promise<BuildResult> {
    if (this.building) return { status: "already_running" };
    this.building = true;
    const t0 = Date.now();
    console.log(JSON.stringify({ event: "index_build_start", namespace: name, force }));
    const ns = this.env.NAMESPACE.get(this.env.NAMESPACE.idFromName(name));
    let plan: BuildPlan | null = null;
    try {
      plan = await ns.beginBuild(name, force);
      if (plan.status !== "ready") return { status: "skipped", reason: plan.reason };
      const { dim, version, prefix, live, sources } = plan;
      const phases: Record<string, number> = {};
      let mark = Date.now();
      const phase = (label: string) => {
        phases[label] = Date.now() - mark;
        mark = Date.now();
      };
      const cosine = plan.metric === "cosine_distance";
      const rowBytes = dim * 4;
      const idxPrefix = `${prefix}index/v${version}/`;

      let k = Math.max(Math.ceil((live * rowBytes) / TARGET_CLUSTER_BYTES), Math.ceil(live / TARGET_CLUSTER_ROWS));
      k = Math.max(1, Math.min(MAX_CLUSTERS, k, Math.floor(live / 2) || 1));

      const sampleN = Math.min(live, SAMPLE_MAX_ROWS, Math.floor(SAMPLE_MAX_BYTES / rowBytes));
      const sample = new Float32Array(sampleN * dim);
      let seen = 0;
      const offsets = new Map<string, number[]>();
      for (let i = 0; i < sources.length; i += 200) {
        const chunk = sources.slice(i, i + 200);
        const got = await ns.liveOffsets(name, chunk);
        for (const key of chunk) offsets.set(key, got[key] ?? []);
      }
      const liveSources = sources.filter((key) => (offsets.get(key)?.length ?? 0) > 0);
      for await (const [key, seg] of this.readAhead(liveSources)) {
        if (!seg) continue;
        const live = offsets.get(key)!;
        for (const idx of live) {
          // Reservoir sampling across all live rows.
          let slot = -1;
          if (seen < sampleN) slot = seen;
          else {
            const j = Math.floor(Math.random() * (seen + 1));
            if (j < sampleN) slot = j;
          }
          seen++;
          if (slot >= 0) {
            sample.set(seg.vector(idx), slot * dim);
            if (cosine) normalizeInPlace(sample, slot * dim, dim);
          }
        }
      }
      const n = Math.min(seen, sampleN);
      if (n === 0) {
        await ns.abortBuild(name, version);
        return { status: "skipped", reason: "empty" };
      }
      k = Math.min(k, n);
      phase("sample");
      const centroids = kmeans(sample, n, dim, k, KMEANS_ITERS);
      if (cosine) for (let c = 0; c < k; c++) normalizeInPlace(centroids, c * dim, dim);
      phase("kmeans");

      const builders: { ids: string[]; vecs: Float32Array[] }[] = Array.from({ length: k }, () => ({ ids: [], vecs: [] }));
      const parts = new Map<number, string[]>();
      let buffered = 0;
      let partSeq = 0;
      const tmp = new Float32Array(dim);
      const flushParts = async () => {
        const puts: Promise<unknown>[] = [];
        for (let c = 0; c < k; c++) {
          const b = builders[c];
          if (b.ids.length === 0) continue;
          const key = `${idxPrefix}parts/c${c}-${partSeq++}.bin`;
          puts.push(this.env.BUCKET.put(key, encodeSegment(b.ids, concat(b.vecs, dim), dim)));
          let list = parts.get(c);
          if (!list) parts.set(c, (list = []));
          list.push(key);
          builders[c] = { ids: [], vecs: [] };
        }
        await Promise.all(puts);
        buffered = 0;
      };

      for await (const [key, seg] of this.readAhead(liveSources)) {
        if (!seg) continue;
        const live = offsets.get(key)!;
        for (const idx of live) {
          const v = seg.vector(idx);
          let routed = v;
          if (cosine) {
            tmp.set(v);
            normalizeInPlace(tmp);
            routed = tmp;
          }
          const c = nearestCentroid(centroids, k, routed, 0, dim);
          builders[c].ids.push(seg.ids[idx]);
          builders[c].vecs.push(Float32Array.from(v));
          buffered += rowBytes;
        }
        if (buffered >= PART_BUFFER_BYTES) await flushParts();
      }
      await flushParts();
      phase("assign");

      const perFile = Math.max(1, Math.floor(SEGMENT_MAX_BYTES / rowBytes));
      const mergeCluster = async (c: number) => {
        const keys = parts.get(c) ?? [];
        if (keys.length === 0) return;
        let file = 0;
        let ids: string[] = [];
        let vecs: Float32Array[] = [];
        const writeFile = async () => {
          const key = `${idxPrefix}c${c}-${file++}.bin`;
          const bytes = encodeSegment(ids, concat(vecs, dim), dim);
          await this.env.BUCKET.put(key, bytes);
          await ns.commitClusterFile(name, { key, version, cluster: c, ids, bytes: bytes.byteLength });
          ids = [];
          vecs = [];
        };
        // A cluster's parts together hold roughly one cluster of vectors, so reading them at once stays small.
        const loaded = await Promise.all(keys.map((pk) => this.read(pk)));
        for (const part of loaded) {
          if (!part) continue;
          for (let i = 0; i < part.count; i++) {
            ids.push(part.ids[i]);
            vecs.push(Float32Array.from(part.vector(i)));
            if (ids.length >= perFile) await writeFile();
          }
        }
        if (ids.length) await writeFile();
        await Promise.all(keys.map((pk) => this.env.BUCKET.delete(pk)));
      };
      // A few clusters at a time: each holds at most one part plus one output file, so memory stays bounded.
      let nextCluster = 0;
      await Promise.all(
        Array.from({ length: Math.min(MERGE_CONCURRENCY, k) }, async () => {
          while (nextCluster < k) await mergeCluster(nextCluster++);
        }),
      );

      phase("merge");
      await this.env.BUCKET.put(`${idxPrefix}centroids.bin`, new Uint8Array(centroids.buffer, centroids.byteOffset, centroids.byteLength));
      const done = await ns.finishBuild(name, version, k);
      plan = null;
      if (done.dropped.length) await this.env.BUCKET.delete(done.dropped);
      phase("finish");
      console.log(JSON.stringify({ event: "index_built", namespace: name, version, clusters: k, rows: done.moved, live, sources: sources.length, phases_ms: phases, took_ms: Date.now() - t0 }));
      return { status: "built", rows: done.moved, clusters: k, version, took_ms: Date.now() - t0 };
    } catch (err) {
      console.error(JSON.stringify({ event: "index_build_failed", namespace: name, version: plan?.status === "ready" ? plan.version : null, error: String(err) }));
      if (plan && plan.status === "ready") {
        await ns.abortBuild(name, plan.version).catch(() => {});
        await this.deletePrefix(`${plan.prefix}index/v${plan.version}/parts/`).catch(() => {});
      }
      throw err;
    } finally {
      this.building = false;
    }
  }

  /** Yields segments in order while keeping a few R2 reads in flight. */
  private async *readAhead(keys: string[]): AsyncGenerator<[string, Segment | null]> {
    const pending: Promise<Segment | null>[] = [];
    let next = 0;
    while (next < keys.length && pending.length < READ_AHEAD) pending.push(this.read(keys[next++]));
    for (let i = 0; i < keys.length; i++) {
      const seg = await pending.shift()!;
      if (next < keys.length) pending.push(this.read(keys[next++]));
      yield [keys[i], seg];
    }
  }

  private async read(key: string): Promise<Segment | null> {
    const obj = await this.env.BUCKET.get(key);
    if (!obj) return null;
    return new Segment(await obj.arrayBuffer());
  }

  private async deletePrefix(prefix: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.env.BUCKET.list({ prefix, cursor, limit: 1000 });
      if (page.objects.length) await this.env.BUCKET.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
}

function concat(vecs: Float32Array[], dim: number): Float32Array {
  const out = new Float32Array(vecs.length * dim);
  for (let i = 0; i < vecs.length; i++) out.set(vecs[i], i * dim);
  return out;
}
