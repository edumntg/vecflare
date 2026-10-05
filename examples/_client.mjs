// Shared helper for the examples: reads VECFLARE_URL and VECFLARE_API_KEY, wraps fetch, pretty-prints.
// Plain JavaScript so it runs on any Node 20+ without a build step. For TypeScript projects see ../client/vecflare.ts.

export const BASE = (process.env.VECFLARE_URL ?? "").replace(/\/$/, "");
export const KEY = process.env.VECFLARE_API_KEY ?? "";

if (!BASE || !KEY) {
  console.error("Set VECFLARE_URL (your Worker URL) and VECFLARE_API_KEY (the secret you chose at deploy time).");
  console.error('Example: export VECFLARE_URL=https://vecflare.<subdomain>.workers.dev VECFLARE_API_KEY=...');
  process.exit(1);
}

export async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${json.error ?? res.statusText}`);
  return json;
}

export const show = (label, value) => console.log(`\n${label}\n${JSON.stringify(value, null, 2)}`);

// Deterministic toy vectors so every example sees the same data. 8 dimensions, one "topic" per group.
export const DIM = 8;
export function toyVector(group, i) {
  const v = Array.from({ length: DIM }, (_, d) => (d === group ? 1 : 0.1 * Math.sin(i + d)));
  return v;
}

export const NS = process.env.VECFLARE_NS ?? "examples";
