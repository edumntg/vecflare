// Minimal typed client. Copy this file into your project; it only uses fetch.

export type Metric = "cosine_distance" | "euclidean_squared" | "dot_product";
export type Filter = [string, string, unknown] | ["And", Filter[]] | ["Or", Filter[]] | ["Not", Filter];

export interface Row {
  id: string;
  vector: number[];
  attributes?: Record<string, unknown>;
}

export interface QueryOptions {
  top_k?: number;
  filters?: Filter;
  include_attributes?: boolean | string[];
  include_vectors?: boolean;
  distance_metric?: Metric;
  nprobe?: number;
}

export interface QueryResult {
  rows: { id: string; dist: number; attributes?: Record<string, unknown>; vector?: number[] }[];
  stats: { took_ms: number; segments_scanned: number; vectors_scored: number; cache_hits: number; cache_misses: number; exhaustive: boolean };
}

export class VecflareError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class Vecflare {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  namespace(name: string): Namespace {
    return new Namespace(this, name);
  }

  async listNamespaces(): Promise<{ name: string; created_at: number }[]> {
    return (await this.request("GET", "/v1/namespaces")).namespaces;
  }

  async request(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new VecflareError(res.status, (json as any).error ?? res.statusText);
    return json;
  }
}

export class Namespace {
  constructor(
    private client: Vecflare,
    public readonly name: string,
  ) {}

  private path(suffix = ""): string {
    return `/v1/namespaces/${encodeURIComponent(this.name)}${suffix}`;
  }

  configure(opts: { distance_metric?: Metric }) {
    return this.client.request("PUT", this.path(), opts);
  }

  upsert(rows: Row[], opts: { distance_metric?: Metric } = {}): Promise<{ upserted: number }> {
    return this.client.request("POST", this.path("/upsert"), { rows, ...opts });
  }

  patch(rows: { id: string; vector?: number[]; attributes?: Record<string, unknown> }[]): Promise<{ patched: number; missing: string[] }> {
    return this.client.request("POST", this.path("/patch"), { rows });
  }

  delete(ids: string[]): Promise<{ deleted: number }> {
    return this.client.request("POST", this.path("/delete"), { ids });
  }

  deleteWhere(filters: Filter): Promise<{ deleted: number }> {
    return this.client.request("POST", this.path("/delete"), { filters });
  }

  get(ids: string[], includeVectors = false): Promise<{ rows: { id: string; attributes: Record<string, unknown> | null; vector?: number[] }[] }> {
    return this.client.request("POST", this.path("/rows"), { ids, include_vectors: includeVectors });
  }

  list(cursor?: string, limit = 100): Promise<{ rows: { id: string; attributes: Record<string, unknown> | null }[]; next_cursor: string | null }> {
    const qs = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
    return this.client.request("GET", this.path(`/rows?${qs}`));
  }

  query(vector: number[], opts: QueryOptions = {}): Promise<QueryResult> {
    return this.client.request("POST", this.path("/query"), { vector, ...opts });
  }

  buildIndex(): Promise<{ status: string; rows?: number; clusters?: number; version?: number; took_ms?: number }> {
    return this.client.request("POST", this.path("/index"), { force: true });
  }

  stats() {
    return this.client.request("GET", this.path());
  }

  destroy(): Promise<{ deleted_objects: number }> {
    return this.client.request("DELETE", this.path());
  }
}
