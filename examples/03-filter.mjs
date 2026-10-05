// Filters are applied in SQLite before scoring, so they are exact. Run 01-upsert.mjs first.
import { api, show, toyVector, NS } from "./_client.mjs";

const query = toyVector(0, 7);

show(
  "topic = travel AND words >= 500",
  await api("POST", `/v1/namespaces/${NS}/query`, {
    vector: query,
    top_k: 5,
    filters: ["And", [["topic", "Eq", "travel"], ["words", "Gte", 500]]],
    include_attributes: true,
  }),
);

show(
  "tags contains 'long', published, not article-1/3",
  await api("POST", `/v1/namespaces/${NS}/query`, {
    vector: query,
    top_k: 5,
    filters: ["And", [["tags", "Contains", "long"], ["published", "Eq", true], ["Not", ["id", "In", ["article-1", "article-3"]]]]],
    include_attributes: ["tags", "published"],
  }),
);

show(
  "id glob + OR",
  await api("POST", `/v1/namespaces/${NS}/query`, {
    vector: query,
    top_k: 10,
    filters: ["Or", [["id", "Glob", "article-3*"], ["topic", "In", ["sports"]]]],
  }),
);
