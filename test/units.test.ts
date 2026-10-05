import { describe, expect, it } from "vitest";
import { Segment, encodeSegment, vectorRange, HEADER_BYTES } from "../src/segment";
import { compileFilter } from "../src/filters";
import { TopK } from "../src/topk";
import { kmeans, nearestCentroid } from "../src/kmeans";
import { LruCache } from "../src/lru";
import { makeScorer } from "../src/distance";

describe("segment format", () => {
  it("round-trips ids and vectors", () => {
    const ids = ["a", "b-longer-id", "ünïcødé"];
    const dim = 3;
    const vecs = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const bytes = encodeSegment(ids, vecs, dim);
    const seg = new Segment(bytes.buffer as ArrayBuffer);
    expect(seg.dim).toBe(3);
    expect(seg.count).toBe(3);
    expect(seg.ids).toEqual(ids);
    expect(Array.from(seg.vector(1))).toEqual([4, 5, 6]);
    const r = vectorRange(2, dim);
    expect(r.offset).toBe(HEADER_BYTES + 2 * 12);
    expect(Array.from(new Float32Array(bytes.buffer.slice(r.offset, r.offset + r.length)))).toEqual([7, 8, 9]);
  });
});

describe("filters", () => {
  it("compiles nested And/Or/Not", () => {
    const f = compileFilter(["And", [["group", "Eq", 1], ["Or", [["price", "Gte", 5], ["Not", ["tags", "Contains", "x"]]]]]]);
    expect(f.sql).toContain("json_extract(attrs, '$.\"group\"') = ?");
    expect(f.sql).toContain("json_each");
    expect(f.params).toEqual([1, 5, "x"]);
    const big = compileFilter(["id", "In", Array.from({ length: 5000 }, (_, i) => String(i))]);
    expect(big.params.length).toBe(1);
  });
  it("rejects bad fields and ops", () => {
    expect(() => compileFilter(["bad field", "Eq", 1])).toThrow();
    expect(() => compileFilter(["a", "Like" as any, 1])).toThrow();
    expect(() => compileFilter(["a", "In", []])).toThrow();
  });
  it("filters on id directly", () => {
    const f = compileFilter(["id", "In", ["a", "b"]]);
    expect(f.sql).toBe("id IN (SELECT value FROM json_each(?))");
    expect(f.params).toEqual(['["a","b"]']);
  });
});

describe("topk", () => {
  it("keeps the k best for lower-is-better", () => {
    const h = new TopK(3, true);
    for (const d of [5, 1, 4, 2, 3, 0.5]) h.push({ id: String(d), dist: d, seg: "", idx: 0 });
    expect(h.sorted().map((c) => c.dist)).toEqual([0.5, 1, 2]);
    expect(h.accepts(1.5)).toBe(true);
    expect(h.accepts(2.5)).toBe(false);
  });
  it("keeps the k best for higher-is-better", () => {
    const h = new TopK(2, false);
    for (const d of [5, 1, 4, 2]) h.push({ id: String(d), dist: d, seg: "", idx: 0 });
    expect(h.sorted().map((c) => c.dist)).toEqual([5, 4]);
  });
});

describe("kmeans", () => {
  it("separates two obvious blobs", () => {
    const dim = 2;
    const pts: number[] = [];
    for (let i = 0; i < 50; i++) pts.push(10 + Math.random(), 10 + Math.random());
    for (let i = 0; i < 50; i++) pts.push(-10 + Math.random(), -10 + Math.random());
    const data = Float32Array.from(pts);
    const c = kmeans(data, 100, dim, 2, 10);
    const a = nearestCentroid(c, 2, data, 0, dim);
    const b = nearestCentroid(c, 2, data, 50 * dim, dim);
    expect(a).not.toBe(b);
    for (let i = 1; i < 50; i++) expect(nearestCentroid(c, 2, data, i * dim, dim)).toBe(a);
  });
});

describe("lru", () => {
  it("evicts by bytes, oldest first", () => {
    const c = new LruCache<{ bytes: number }>(10);
    c.set("a", { bytes: 4 });
    c.set("b", { bytes: 4 });
    c.get("a");
    c.set("c", { bytes: 4 });
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBeDefined();
    expect(c.bytes).toBe(8);
  });
});

describe("distance", () => {
  it("scores the three metrics", () => {
    const q = Float32Array.from([1, 0]);
    const v = Float32Array.from([0, 1, 1, 0, 2, 0]);
    expect(makeScorer("cosine_distance", q)(v, 0)).toBeCloseTo(1);
    expect(makeScorer("cosine_distance", q)(v, 2)).toBeCloseTo(0);
    expect(makeScorer("euclidean_squared", q)(v, 4)).toBeCloseTo(1);
    expect(makeScorer("dot_product", q)(v, 4)).toBeCloseTo(2);
  });
});
