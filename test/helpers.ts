import { SELF } from "cloudflare:test";

export const KEY = "test-key";

export async function api(method: string, path: string, body?: unknown, auth = true): Promise<{ status: number; json: any }> {
  const res = await SELF.fetch(`https://vecflare.test${path}`, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${KEY}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

export function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rows drawn from `groups` gaussian-ish blobs so an IVF index has structure to find. */
export function makeRows(n: number, dim: number, groups: number, seed = 7) {
  const rand = rng(seed);
  const centers = Array.from({ length: groups }, () => Array.from({ length: dim }, () => rand() * 2 - 1));
  const rows = [];
  for (let i = 0; i < n; i++) {
    const g = i % groups;
    const vector = centers[g].map((c) => c + (rand() - 0.5) * 0.2);
    rows.push({
      id: `row-${i}`,
      vector,
      attributes: { group: g, price: Math.round(rand() * 1000) / 10, tags: [`t${g}`, i % 2 === 0 ? "even" : "odd"], name: `item ${i}` },
    });
  }
  return rows;
}

export function bruteForce(rows: { id: string; vector: number[] }[], q: number[], k: number): string[] {
  const scored = rows.map((r) => {
    let dot = 0, qn = 0, vn = 0;
    for (let i = 0; i < q.length; i++) {
      dot += r.vector[i] * q[i];
      qn += q[i] * q[i];
      vn += r.vector[i] * r.vector[i];
    }
    return { id: r.id, d: 1 - dot / Math.sqrt(qn * vn) };
  });
  scored.sort((a, b) => a.d - b.d);
  return scored.slice(0, k).map((s) => s.id);
}
