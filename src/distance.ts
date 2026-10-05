import type { Metric } from "./types";

export const METRICS: Metric[] = ["cosine_distance", "euclidean_squared", "dot_product"];

export function lowerIsBetter(metric: Metric): boolean {
  return metric !== "dot_product";
}

export function norm(v: Float32Array, off = 0, dim = v.length): number {
  let s = 0;
  for (let i = 0; i < dim; i++) {
    const x = v[off + i];
    s += x * x;
  }
  return Math.sqrt(s);
}

export function normalizeInPlace(v: Float32Array, off = 0, dim = v.length): void {
  const n = norm(v, off, dim);
  if (n === 0) return;
  for (let i = 0; i < dim; i++) v[off + i] /= n;
}

export type Scorer = (vecs: Float32Array, off: number) => number;

/** Returns a function scoring the vector at `vecs[off..off+dim]` against `q`. */
export function makeScorer(metric: Metric, q: Float32Array): Scorer {
  const dim = q.length;
  if (metric === "euclidean_squared") {
    return (vecs, off) => {
      let s = 0;
      for (let i = 0; i < dim; i++) {
        const d = vecs[off + i] - q[i];
        s += d * d;
      }
      return s;
    };
  }
  if (metric === "dot_product") {
    return (vecs, off) => {
      let s = 0;
      for (let i = 0; i < dim; i++) s += vecs[off + i] * q[i];
      return s;
    };
  }
  const qn = norm(q);
  return (vecs, off) => {
    let dot = 0;
    let vn = 0;
    for (let i = 0; i < dim; i++) {
      const x = vecs[off + i];
      dot += x * q[i];
      vn += x * x;
    }
    const den = qn * Math.sqrt(vn);
    if (den === 0) return 1;
    return 1 - dot / den;
  };
}

/** Squared L2 between a row in `a` and a row in `b`; used by k-means and centroid routing. */
export function l2sq(a: Float32Array, aOff: number, b: Float32Array, bOff: number, dim: number): number {
  let s = 0;
  for (let i = 0; i < dim; i++) {
    const d = a[aOff + i] - b[bOff + i];
    s += d * d;
  }
  return s;
}
