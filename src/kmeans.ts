import { l2sq } from "./distance";

/**
 * Lloyd's k-means on `n` rows of `dim` floats. Random init instead of k-means++ because
 * the init alone would cost as much as every iteration combined at the sizes we run.
 * Returns k*dim centroids; empty clusters are re-seeded from the farthest point.
 */
export function kmeans(data: Float32Array, n: number, dim: number, k: number, iters: number, seed = 1): Float32Array {
  if (k > n) k = n;
  const rand = mulberry32(seed);
  const centroids = new Float32Array(k * dim);
  const chosen = new Set<number>();
  for (let c = 0; c < k; c++) {
    let i = Math.floor(rand() * n);
    while (chosen.has(i)) i = (i + 1) % n;
    chosen.add(i);
    centroids.set(data.subarray(i * dim, (i + 1) * dim), c * dim);
  }

  const assign = new Int32Array(n);
  const sums = new Float64Array(k * dim);
  const counts = new Int32Array(k);
  const farDist = new Float64Array(n);

  for (let it = 0; it < iters; it++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = l2sq(data, i * dim, centroids, c * dim, dim);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      farDist[i] = bestD;
      if (assign[i] !== best) moved++;
      assign[i] = best;
    }
    sums.fill(0);
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const c = assign[i];
      counts[c]++;
      const off = i * dim;
      const coff = c * dim;
      for (let j = 0; j < dim; j++) sums[coff + j] += data[off + j];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) {
        let far = 0;
        for (let i = 1; i < n; i++) if (farDist[i] > farDist[far]) far = i;
        centroids.set(data.subarray(far * dim, (far + 1) * dim), c * dim);
        farDist[far] = 0;
        continue;
      }
      const coff = c * dim;
      for (let j = 0; j < dim; j++) centroids[coff + j] = sums[coff + j] / counts[c];
    }
    if (moved === 0 && it > 0) break;
  }
  return centroids;
}

export function nearestCentroid(centroids: Float32Array, k: number, v: Float32Array, off: number, dim: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let c = 0; c < k; c++) {
    const d = l2sq(v, off, centroids, c * dim, dim);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

export function nearestCentroids(centroids: Float32Array, k: number, q: Float32Array, nprobe: number): number[] {
  const dim = q.length;
  const scored: { c: number; d: number }[] = [];
  for (let c = 0; c < k; c++) scored.push({ c, d: l2sq(q, 0, centroids, c * dim, dim) });
  scored.sort((a, b) => a.d - b.d);
  return scored.slice(0, Math.min(nprobe, k)).map((s) => s.c);
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
