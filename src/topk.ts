export interface Candidate {
  id: string;
  dist: number;
  seg: string;
  idx: number;
}

/** Bounded binary heap keeping the K best candidates. The root is the worst kept item. */
export class TopK {
  private heap: Candidate[] = [];
  constructor(
    private readonly k: number,
    private readonly lowerIsBetter: boolean,
  ) {}

  private worse(a: Candidate, b: Candidate): boolean {
    return this.lowerIsBetter ? a.dist > b.dist : a.dist < b.dist;
  }

  /** Fast reject threshold: a candidate must beat this to enter a full heap. */
  threshold(): number | undefined {
    return this.heap.length < this.k ? undefined : this.heap[0].dist;
  }

  accepts(dist: number): boolean {
    if (this.heap.length < this.k) return true;
    const t = this.heap[0].dist;
    return this.lowerIsBetter ? dist < t : dist > t;
  }

  push(c: Candidate): void {
    if (this.heap.length < this.k) {
      this.heap.push(c);
      this.up(this.heap.length - 1);
    } else if (this.worse(this.heap[0], c)) {
      this.heap[0] = c;
      this.down(0);
    }
  }

  private up(i: number): void {
    const h = this.heap;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.worse(h[i], h[p])) break;
      [h[i], h[p]] = [h[p], h[i]];
      i = p;
    }
  }

  private down(i: number): void {
    const h = this.heap;
    const n = h.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && this.worse(h[l], h[m])) m = l;
      if (r < n && this.worse(h[r], h[m])) m = r;
      if (m === i) break;
      [h[i], h[m]] = [h[m], h[i]];
      i = m;
    }
  }

  /** Best first. */
  sorted(): Candidate[] {
    const out = this.heap.slice();
    out.sort((a, b) => (this.lowerIsBetter ? a.dist - b.dist : b.dist - a.dist));
    return out;
  }

  get size(): number {
    return this.heap.length;
  }
}
