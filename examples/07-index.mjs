// Bulk load, build the IVF index, and see what nprobe does. Uses its own namespace and deletes it at the end.
import { api, show, DIM } from "./_client.mjs";

const NS = "examples-index";
const N = 6000;
const GROUPS = 24;
const rand = (() => { let s = 7; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })();
const centers = Array.from({ length: GROUPS }, () => Array.from({ length: 32 }, () => rand() * 2 - 1));
const vec = (i) => centers[i % GROUPS].map((c) => c + (rand() - 0.5) * 0.3);

console.log(`loading ${N} vectors of 32 dims in batches of 1000`);
for (let i = 0; i < N; i += 1000) {
  const rows = Array.from({ length: 1000 }, (_, j) => ({ id: `v${i + j}`, vector: vec(i + j), attributes: { group: (i + j) % GROUPS } }));
  await api("POST", `/v1/namespaces/${NS}/upsert`, { rows });
}
show("before build", await api("GET", `/v1/namespaces/${NS}`));

// Builds also start on their own 15 s after enough new data; this forces one now.
show("POST /index", await api("POST", `/v1/namespaces/${NS}/index`, { force: true }));
show("after build", await api("GET", `/v1/namespaces/${NS}`));

const q = vec(123);
for (const nprobe of [1, 4, 8, 24]) {
  const r = await api("POST", `/v1/namespaces/${NS}/query`, { vector: q, top_k: 5, nprobe });
  console.log(`nprobe=${String(nprobe).padStart(2)}  scored ${String(r.stats.vectors_scored).padStart(5)} of ${N}  exhaustive=${r.stats.exhaustive}  top=${r.rows[0].id} dist=${r.rows[0].dist.toFixed(4)}  ${r.stats.took_ms} ms`);
}

await api("DELETE", `/v1/namespaces/${NS}`);
console.log("\nnamespace deleted");
