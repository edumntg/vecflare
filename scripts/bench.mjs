// Usage: node scripts/bench.mjs <base-url> <api-key> [rows=20000] [dim=768]
// Loads clustered random vectors, builds the index, then reports upsert, cold and warm query latency.
const [base = "http://localhost:8787", key = "dev-key-change-me", rowsArg = "20000", dimArg = "768"] = process.argv.slice(2);
const N = Number(rowsArg);
const DIM = Number(dimArg);
const NS = `bench-${Date.now().toString(36)}`;
const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };

async function call(method, path, body) {
  const t0 = performance.now();
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return { json, ms: performance.now() - t0 };
}

let seed = 42;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const GROUPS = 64;
const centers = Array.from({ length: GROUPS }, () => Array.from({ length: DIM }, () => rand() * 2 - 1));
const row = (i) => ({
  id: `v${i}`,
  vector: centers[i % GROUPS].map((c) => c + (rand() - 0.5) * 0.3),
  attributes: { group: i % GROUPS, n: i },
});

const pct = (xs, p) => xs.slice().sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)].toFixed(1);
const summary = (label, xs) => console.log(`${label.padEnd(28)} p50 ${pct(xs, 0.5).padStart(7)} ms   p90 ${pct(xs, 0.9).padStart(7)} ms   p99 ${pct(xs, 0.99).padStart(7)} ms   (n=${xs.length})`);

console.log(`namespace=${NS} rows=${N} dim=${DIM} base=${base}`);
const BATCH = 500;
const upserts = [];
const tIngest = performance.now();
for (let i = 0; i < N; i += BATCH) {
  const rows = Array.from({ length: Math.min(BATCH, N - i) }, (_, j) => row(i + j));
  const { ms } = await call("POST", `/v1/namespaces/${NS}/upsert`, { rows });
  upserts.push(ms);
}
const ingestS = (performance.now() - tIngest) / 1000;
summary(`upsert ${BATCH} rows`, upserts);
console.log(`ingest total ${ingestS.toFixed(1)} s  (${Math.round(N / ingestS)} rows/s)`);

const probes = Array.from({ length: 30 }, (_, i) => row(i * 97).vector.map((x) => x + (rand() - 0.5) * 0.05));

const pre = [];
for (const v of probes.slice(0, 10)) pre.push((await call("POST", `/v1/namespaces/${NS}/query`, { vector: v, top_k: 10 })).ms);
summary("query, no index (exhaustive)", pre);

let build = await call("POST", `/v1/namespaces/${NS}/index`, { force: true });
console.log(`index build: ${JSON.stringify(build.json)} wall ${build.ms.toFixed(0)} ms`);
// The automatic build may already be running; wait for it, then rebuild so every row is indexed.
while (build.json.status === "already_running") {
  await new Promise((r) => setTimeout(r, 2000));
  build = await call("POST", `/v1/namespaces/${NS}/index`, { force: true });
  console.log(`index build: ${JSON.stringify(build.json)} wall ${build.ms.toFixed(0)} ms`);
}

const stats = await call("GET", `/v1/namespaces/${NS}`);
console.log(`stats: ${JSON.stringify(stats.json)}`);

const cold = [];
const warm = [];
let scored = 0;
let hits = 0;
let reads = 0;
for (const v of probes) {
  const r = await call("POST", `/v1/namespaces/${NS}/query`, { vector: v, top_k: 10 });
  cold.push(r.ms);
  scored += r.json.stats.vectors_scored;
  hits += r.json.stats.cache_hits;
  reads += r.json.stats.cache_hits + r.json.stats.cache_misses;
}
summary("query, indexed, first time", cold);
console.log(`  avg vectors scored per query: ${Math.round(scored / probes.length)} of ${N}; segment cache hit rate ${Math.round((100 * hits) / reads)}%`);
// Same probes again: the clusters they touch are now in the Durable Object's memory cache.
hits = 0;
reads = 0;
for (const v of probes) {
  const r = await call("POST", `/v1/namespaces/${NS}/query`, { vector: v, top_k: 10 });
  warm.push(r.ms);
  hits += r.json.stats.cache_hits;
  reads += r.json.stats.cache_hits + r.json.stats.cache_misses;
}
summary("query, indexed, repeated", warm);
console.log(`  segment cache hit rate ${Math.round((100 * hits) / reads)}%`);
// One probe many times: every cluster it touches is cached, so this is the floor for an indexed query.
const hot = [];
for (let i = 0; i < 15; i++) hot.push((await call("POST", `/v1/namespaces/${NS}/query`, { vector: probes[0], top_k: 10 })).ms);
summary("query, indexed, fully cached", hot.slice(1));

const filt = [];
for (const v of probes.slice(0, 10)) filt.push((await call("POST", `/v1/namespaces/${NS}/query`, { vector: v, top_k: 10, filters: ["group", "Eq", 3] })).ms);
summary("query, filtered (group Eq)", filt);

const gets = [];
for (let i = 0; i < 20; i++) gets.push((await call("GET", `/v1/namespaces/${NS}/rows/v${i * 7}?include_vectors=true`)).ms);
summary("get row with vector", gets);

await call("DELETE", `/v1/namespaces/${NS}`);
console.log("namespace deleted");
