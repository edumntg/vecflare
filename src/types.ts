export type Metric = "cosine_distance" | "euclidean_squared" | "dot_product";

export type JsonScalar = string | number | boolean | null;
// Bounded nesting instead of a recursive type: the Durable Object RPC type machinery cannot resolve recursion.
export type JsonValue = JsonScalar | JsonScalar[] | { [key: string]: JsonScalar | JsonScalar[] | { [key: string]: JsonScalar | JsonScalar[] } };

export type Attributes = Record<string, JsonValue>;

export interface UpsertRow {
  id: string;
  vector: number[];
  attributes?: Attributes;
}

export interface PatchRow {
  id: string;
  vector?: number[];
  attributes?: Attributes;
}

export type FilterOp =
  | "Eq"
  | "NotEq"
  | "In"
  | "NotIn"
  | "Lt"
  | "Lte"
  | "Gt"
  | "Gte"
  | "Glob"
  | "NotGlob"
  | "Contains"
  | "ContainsAny";

export type Filter =
  | [field: string, op: FilterOp, value: unknown]
  | ["And", Filter[]]
  | ["Or", Filter[]]
  | ["Not", Filter];

export interface QueryRequest {
  vector: number[];
  top_k?: number;
  filters?: Filter;
  include_attributes?: boolean | string[];
  include_vectors?: boolean;
  distance_metric?: Metric;
  /** Clusters to probe when an index exists. Higher = better recall, more bytes read. */
  nprobe?: number;
}

export interface QueryRow {
  id: string;
  dist: number;
  attributes?: Attributes;
  vector?: number[];
}

export interface QueryStats {
  took_ms: number;
  segments_scanned: number;
  vectors_scored: number;
  cache_hits: number;
  cache_misses: number;
  /** True when every live vector was scored (no index, or a filter that bypassed it). */
  exhaustive: boolean;
  /** Index version used for routing; 0 means no index. */
  index_version: number;
  /** Scored candidates dropped because a newer copy of the row exists elsewhere. */
  stale_candidates: number;
}

export interface QueryResponse {
  rows: QueryRow[];
  stats: QueryStats;
}

export interface NamespaceStats {
  name: string;
  dim: number | null;
  distance_metric: Metric;
  rows: number;
  unindexed_rows: number;
  segments: { wal: number; cluster: number };
  storage_bytes: number;
  index: { version: number; clusters: number } | null;
  created_at: number | null;
}

export interface StoredRow {
  id: string;
  attributes: Attributes | null;
  vector?: number[];
}
