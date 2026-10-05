// Nearest-neighbour search. Run 01-upsert.mjs first.
import { api, show, toyVector, NS } from "./_client.mjs";

// A query vector that leans toward the "finance" topic (group 2).
const query = toyVector(2, 1000);

const res = await api("POST", `/v1/namespaces/${NS}/query`, {
  vector: query,
  top_k: 5,
  include_attributes: ["topic", "words"],
});
show("top 5 for a finance-like vector", res);

// include_vectors returns the stored vectors too; distance_metric can be overridden per query.
const dot = await api("POST", `/v1/namespaces/${NS}/query`, { vector: query, top_k: 2, distance_metric: "dot_product", include_vectors: true });
show("same query scored by dot product, with vectors", dot.rows);
