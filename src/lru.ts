/** Byte-bounded LRU. Map iteration order doubles as recency order. */
export class LruCache<V extends { bytes: number }> {
  private map = new Map<string, V>();
  private used = 0;
  hits = 0;
  misses = 0;

  constructor(private readonly capacityBytes: number) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) {
      this.misses++;
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, v);
    this.hits++;
    return v;
  }

  set(key: string, v: V): void {
    if (v.bytes > this.capacityBytes) return;
    const prev = this.map.get(key);
    if (prev) {
      this.used -= prev.bytes;
      this.map.delete(key);
    }
    this.map.set(key, v);
    this.used += v.bytes;
    while (this.used > this.capacityBytes) {
      const oldest = this.map.keys().next().value as string;
      const ev = this.map.get(oldest)!;
      this.map.delete(oldest);
      this.used -= ev.bytes;
    }
  }

  delete(key: string): void {
    const v = this.map.get(key);
    if (!v) return;
    this.map.delete(key);
    this.used -= v.bytes;
  }

  clear(): void {
    this.map.clear();
    this.used = 0;
  }

  get bytes(): number {
    return this.used;
  }
}
