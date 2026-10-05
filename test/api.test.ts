import { env, runDurableObjectAlarm } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { api, bruteForce, makeRows } from "./helpers";

const DIM = 16;

describe("auth", () => {
  it("rejects missing or wrong keys", async () => {
    expect((await api("GET", "/v1/namespaces", undefined, false)).status).toBe(401);
    const res = await fetch_("/v1/namespaces", "wrong");
    expect(res).toBe(401);
  });
  it("health does not need auth", async () => {
    const r = await api("GET", "/", undefined, false);
    expect(r.status).toBe(200);
    expect(r.json.name).toBe("vecflare");
  });
});

async function fetch_(path: string, key: string): Promise<number> {
  const { SELF } = await import("cloudflare:test");
  const r = await SELF.fetch(`https://vecflare.test${path}`, { headers: { authorization: `Bearer ${key}` } });
  return r.status;
}

describe("crud + search without index", () => {
  const ns = "crud";
  const rows = makeRows(300, DIM, 5);

  beforeAll(async () => {
    const r = await api("POST", `/v1/namespaces/${ns}/upsert`, { rows });
    expect(r.status).toBe(200);
    expect(r.json.upserted).toBe(300);
  });

  it("lists the namespace and reports stats", async () => {
    const list = await api("GET", "/v1/namespaces");
    expect(list.json.namespaces.map((n: any) => n.name)).toContain(ns);
    const s = await api("GET", `/v1/namespaces/${ns}`);
    expect(s.json.rows).toBe(300);
    expect(s.json.dim).toBe(DIM);
    expect(s.json.index).toBeNull();
    expect(s.json.unindexed_rows).toBe(300);
  });

  it("finds the exact vector and matches brute force", async () => {
    const q = rows[42].vector;
    const r = await api("POST", `/v1/namespaces/${ns}/query`, { vector: q, top_k: 10, include_attributes: true });
    expect(r.status).toBe(200);
    expect(r.json.rows[0].id).toBe("row-42");
    expect(r.json.rows[0].dist).toBeCloseTo(0, 5);
    expect(r.json.rows[0].attributes.group).toBe(42 % 5);
    expect(r.json.rows.map((x: any) => x.id)).toEqual(bruteForce(rows, q, 10));
    expect(r.json.stats.exhaustive).toBe(true);
  });

  it("applies filters before scoring", async () => {
    const q = rows[0].vector;
    const r = await api("POST", `/v1/namespaces/${ns}/query`, {
      vector: q,
      top_k: 5,
      filters: ["And", [["group", "Eq", 3], ["price", "Gte", 20], ["tags", "Contains", "odd"]]],
      include_attributes: ["group", "price", "tags"],
    });
    expect(r.status).toBe(200);
    expect(r.json.rows.length).toBe(5);
    for (const row of r.json.rows) {
      expect(row.attributes.group).toBe(3);
      expect(row.attributes.price).toBeGreaterThanOrEqual(20);
      expect(row.attributes.tags).toContain("odd");
      expect(row.attributes.name).toBeUndefined();
    }
    const expected = bruteForce(
      rows.filter((x) => x.attributes.group === 3 && x.attributes.price >= 20 && x.attributes.tags.includes("odd")),
      q,
      5,
    );
    expect(r.json.rows.map((x: any) => x.id)).toEqual(expected);
  });

  it("supports In, Glob, id filters and dot_product override", async () => {
    const r = await api("POST", `/v1/namespaces/${ns}/query`, {
      vector: rows[0].vector,
      top_k: 10,
      filters: ["Or", [["id", "In", ["row-1", "row-2"]], ["name", "Glob", "item 29*"]]],
    });
    const ids: string[] = r.json.rows.map((x: any) => x.id);
    expect(ids.length).toBe(10);
    expect(ids).toContain("row-1");
    expect(ids).toContain("row-2");
    for (const id of ids) expect(id === "row-1" || id === "row-2" || /^row-29\d?$/.test(id)).toBe(true);
    const dp = await api("POST", `/v1/namespaces/${ns}/query`, { vector: rows[0].vector, top_k: 3, distance_metric: "dot_product" });
    expect(dp.json.rows[0].dist).toBeGreaterThanOrEqual(dp.json.rows[1].dist);
  });

  it("reads rows back with and without vectors", async () => {
    const one = await api("GET", `/v1/namespaces/${ns}/rows/row-7?include_vectors=true`);
    expect(one.status).toBe(200);
    expect(one.json.id).toBe("row-7");
    expect(one.json.vector.length).toBe(DIM);
    expect(one.json.vector[0]).toBeCloseTo(rows[7].vector[0], 5);
    const many = await api("POST", `/v1/namespaces/${ns}/rows`, { ids: ["row-1", "row-2", "nope"] });
    expect(many.json.rows.map((r: any) => r.id).sort()).toEqual(["row-1", "row-2"]);
    expect(many.json.rows[0].vector).toBeUndefined();
    const missing = await api("GET", `/v1/namespaces/${ns}/rows/nope`);
    expect(missing.status).toBe(404);
  });

  it("paginates the row list", async () => {
    const p1 = await api("GET", `/v1/namespaces/${ns}/rows?limit=200`);
    expect(p1.json.rows.length).toBe(200);
    expect(p1.json.next_cursor).toBeTruthy();
    const p2 = await api("GET", `/v1/namespaces/${ns}/rows?limit=200&cursor=${p1.json.next_cursor}`);
    expect(p2.json.rows.length).toBe(100);
    expect(p2.json.next_cursor).toBeNull();
  });

  it("patches attributes (merge, delete key) and vectors", async () => {
    let r = await api("POST", `/v1/namespaces/${ns}/patch`, { rows: [{ id: "row-5", attributes: { price: 1.5, name: null, extra: "yes" } }, { id: "ghost", attributes: {} }] });
    expect(r.json.patched).toBe(1);
    expect(r.json.missing).toEqual(["ghost"]);
    const got = await api("GET", `/v1/namespaces/${ns}/rows/row-5`);
    expect(got.json.attributes).toEqual({ group: 0, price: 1.5, tags: ["t0", "odd"], extra: "yes" });

    const newVec = rows[200].vector.map((x) => x + 0.001);
    r = await api("POST", `/v1/namespaces/${ns}/patch`, { rows: [{ id: "row-5", vector: newVec }] });
    expect(r.json.patched).toBe(1);
    const q = await api("POST", `/v1/namespaces/${ns}/query`, { vector: newVec, top_k: 2 });
    expect(q.json.rows[0].id).toBe("row-5");
    expect(q.json.rows[1].id).toBe("row-200");
    const again = await api("GET", `/v1/namespaces/${ns}/rows/row-5`);
    expect(again.json.attributes.extra).toBe("yes");
  });

  it("does not return stale copies after an upsert of the same id", async () => {
    const far = Array.from({ length: DIM }, (_, i) => (i === 0 ? 50 : 0));
    await api("POST", `/v1/namespaces/${ns}/upsert`, { rows: [{ id: "row-10", vector: far, attributes: { moved: true } }] });
    const q = await api("POST", `/v1/namespaces/${ns}/query`, { vector: rows[10].vector, top_k: 300 });
    const ids = q.json.rows.map((x: any) => x.id);
    expect(ids.filter((x: string) => x === "row-10").length).toBe(1);
    expect(ids.indexOf("row-10")).toBeGreaterThan(250);
    const s = await api("GET", `/v1/namespaces/${ns}`);
    expect(s.json.rows).toBe(300);
  });

  it("deletes by ids and by filter", async () => {
    let r = await api("POST", `/v1/namespaces/${ns}/delete`, { ids: ["row-1", "row-2", "nope"] });
    expect(r.json.deleted).toBe(2);
    r = await api("POST", `/v1/namespaces/${ns}/delete`, { filters: ["group", "Eq", 4] });
    expect(r.json.deleted).toBe(60);
    const s = await api("GET", `/v1/namespaces/${ns}`);
    expect(s.json.rows).toBe(238);
    const q = await api("POST", `/v1/namespaces/${ns}/query`, { vector: rows[1].vector, top_k: 1 });
    expect(q.json.rows[0].id).not.toBe("row-1");
  });

  it("validates input", async () => {
    expect((await api("POST", `/v1/namespaces/${ns}/upsert`, { rows: [{ id: "x", vector: [1, 2] }] })).status).toBe(400);
    expect((await api("POST", `/v1/namespaces/${ns}/upsert`, { rows: [] })).status).toBe(400);
    expect((await api("POST", `/v1/namespaces/${ns}/query`, { vector: [1] })).status).toBe(400);
    expect((await api("POST", `/v1/namespaces/${ns}/query`, "not json{")).status).toBe(400);
    expect((await api("GET", `/v1/namespaces/bad%20name`)).status).toBe(400);
    expect((await api("PUT", `/v1/namespaces/${ns}`, { distance_metric: "euclidean_squared" })).status).toBe(409);
  });
});

describe("index build", () => {
  const ns = "indexed";
  const rows = makeRows(3000, DIM, 12, 99);

  beforeAll(async () => {
    for (let i = 0; i < rows.length; i += 1000) {
      const r = await api("POST", `/v1/namespaces/${ns}/upsert`, { rows: rows.slice(i, i + 1000) });
      expect(r.status).toBe(200);
    }
  });

  it("builds on demand and keeps results correct", async () => {
    const before = await api("POST", `/v1/namespaces/${ns}/query`, { vector: rows[123].vector, top_k: 10 });
    const b = await api("POST", `/v1/namespaces/${ns}/index`, { force: true });
    expect(b.status).toBe(200);
    expect(b.json.status).toBe("built");
    expect(b.json.rows).toBe(3000);
    expect(b.json.clusters).toBeGreaterThan(1);

    const s = await api("GET", `/v1/namespaces/${ns}`);
    expect(s.json.index.version).toBe(1);
    expect(s.json.unindexed_rows).toBe(0);
    expect(s.json.segments.wal).toBe(0);
    expect(s.json.rows).toBe(3000);

    const after = await api("POST", `/v1/namespaces/${ns}/query`, { vector: rows[123].vector, top_k: 10 });
    expect(after.json.rows[0].id).toBe("row-123");
    expect(after.json.stats.exhaustive).toBe(false);
    expect(after.json.stats.vectors_scored).toBeLessThan(3000);
    expect(after.json.rows.map((x: any) => x.id)).toEqual(before.json.rows.map((x: any) => x.id));
  });

  it("has high recall against brute force on random probes", async () => {
    let hit = 0;
    const probes = 20;
    for (let p = 0; p < probes; p++) {
      const q = rows[(p * 137) % rows.length].vector.map((x) => x + (Math.random() - 0.5) * 0.1);
      const truth = new Set(bruteForce(rows, q, 10));
      const r = await api("POST", `/v1/namespaces/${ns}/query`, { vector: q, top_k: 10 });
      for (const row of r.json.rows) if (truth.has(row.id)) hit++;
    }
    expect(hit / (probes * 10)).toBeGreaterThanOrEqual(0.9);
  });

  it("exhaustive nprobe equals brute force exactly", async () => {
    const s = await api("GET", `/v1/namespaces/${ns}`);
    const q = rows[7].vector.map((x) => x + 0.03);
    const r = await api("POST", `/v1/namespaces/${ns}/query`, { vector: q, top_k: 15, nprobe: s.json.index.clusters });
    expect(r.json.stats.exhaustive).toBe(true);
    expect(r.json.rows.map((x: any) => x.id)).toEqual(bruteForce(rows, q, 15));
  });

  it("serves writes after the build from the WAL and filters still work", async () => {
    const fresh = rows[500].vector.map((x) => x + 0.002);
    await api("POST", `/v1/namespaces/${ns}/upsert`, { rows: [{ id: "fresh", vector: fresh, attributes: { group: -1 } }] });
    const q = await api("POST", `/v1/namespaces/${ns}/query`, { vector: fresh, top_k: 2 });
    expect(q.json.rows[0].id).toBe("fresh");
    expect(q.json.rows[1].id).toBe("row-500");

    await api("POST", `/v1/namespaces/${ns}/upsert`, { rows: [{ id: "row-500", vector: Array(DIM).fill(9), attributes: { group: 0 } }] });
    const q2 = await api("POST", `/v1/namespaces/${ns}/query`, { vector: fresh, top_k: 2 });
    expect(q2.json.rows.map((x: any) => x.id)).not.toContain("row-500");

    const f = await api("POST", `/v1/namespaces/${ns}/query`, { vector: fresh, top_k: 3, filters: ["group", "Eq", -1] });
    expect(f.json.rows.map((x: any) => x.id)).toEqual(["fresh"]);

    const got = await api("GET", `/v1/namespaces/${ns}/rows/row-77?include_vectors=true`);
    expect(got.json.vector[3]).toBeCloseTo(rows[77].vector[3], 5);
  });

  it("rebuilds into a new version and drops the old files", async () => {
    const b = await api("POST", `/v1/namespaces/${ns}/index`, { force: true });
    expect(b.json.version).toBe(2);
    const s = await api("GET", `/v1/namespaces/${ns}`);
    expect(s.json.rows).toBe(3001);
    expect(s.json.unindexed_rows).toBe(0);
    const listed = await env.BUCKET.list({ prefix: `ns/${ns}/` });
    expect(listed.objects.every((o: { key: string }) => o.key.includes("/index/v2/"))).toBe(true);
    expect(listed.objects.some((o: { key: string }) => o.key.endsWith("centroids.bin"))).toBe(true);
    const q = await api("POST", `/v1/namespaces/${ns}/query`, { vector: rows[2].vector, top_k: 1 });
    expect(q.json.rows[0].id).toBe("row-2");
  });

  it("destroys the namespace completely", async () => {
    const d = await api("DELETE", `/v1/namespaces/${ns}`);
    expect(d.status).toBe(200);
    expect(d.json.deleted_objects).toBeGreaterThan(0);
    const listed = await env.BUCKET.list({ prefix: `ns/${ns}/` });
    expect(listed.objects.length).toBe(0);
    const list = await api("GET", "/v1/namespaces");
    expect(list.json.namespaces.map((n: any) => n.name)).not.toContain(ns);
    const s = await api("GET", `/v1/namespaces/${ns}`);
    expect(s.json.rows).toBe(0);
  });
});

describe("automatic indexing", () => {
  it("schedules an alarm past the row threshold and builds", async () => {
    const ns = "auto";
    const rows = makeRows(2500, DIM, 6, 3);
    for (let i = 0; i < rows.length; i += 1000) await api("POST", `/v1/namespaces/${ns}/upsert`, { rows: rows.slice(i, i + 1000) });
    const stub = env.NAMESPACE.get(env.NAMESPACE.idFromName(ns));
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);
    const s = await api("GET", `/v1/namespaces/${ns}`);
    expect(s.json.index).not.toBeNull();
    expect(s.json.unindexed_rows).toBe(0);
  });
});

describe("build in progress", () => {
  it("keeps rows searchable once they moved into a pending cluster file", async () => {
    const ns = "pending";
    const rows = makeRows(200, DIM, 4, 11);
    await api("POST", `/v1/namespaces/${ns}/upsert`, { rows });
    const stub = env.NAMESPACE.get(env.NAMESPACE.idFromName(ns));
    const plan = await stub.beginBuild(ns, true);
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;

    // Hand-roll one cluster file for the first 50 rows, as the Indexer would, but never finish the build.
    const { encodeSegment } = await import("../src/segment");
    const ids = rows.slice(0, 50).map((r) => r.id);
    const vecs = new Float32Array(50 * DIM);
    rows.slice(0, 50).forEach((r, i) => vecs.set(r.vector, i * DIM));
    const key = `${plan.prefix}index/v${plan.version}/c0-0.bin`;
    const bytes = encodeSegment(ids, vecs, DIM);
    await env.BUCKET.put(key, bytes);
    await stub.commitClusterFile(ns, { key, version: plan.version, cluster: 0, ids, bytes: bytes.byteLength });

    const s = await api("GET", `/v1/namespaces/${ns}`);
    expect(s.json.index).toBeNull();
    expect(s.json.unindexed_rows).toBe(200);
    const q = await api("POST", `/v1/namespaces/${ns}/query`, { vector: rows[3].vector, top_k: 1 });
    expect(q.json.rows[0].id).toBe("row-3");
    // 200 WAL copies plus 50 cluster copies get scored; liveness filtering drops the stale WAL copies.
    expect(q.json.stats.vectors_scored).toBe(250);
    expect(q.json.rows.length).toBe(1);

    await stub.abortBuild(ns, plan.version);
    const q2 = await api("POST", `/v1/namespaces/${ns}/query`, { vector: rows[3].vector, top_k: 1 });
    expect(q2.json.rows[0].id).toBe("row-3");
    const got = await api("GET", `/v1/namespaces/${ns}/rows/row-3?include_vectors=true`);
    expect(got.json.vector[0]).toBeCloseTo(rows[3].vector[0], 5);

    const b = await api("POST", `/v1/namespaces/${ns}/index`, { force: true });
    expect(b.json.status).toBe("built");
    expect(b.json.rows).toBe(200);
  });
});
