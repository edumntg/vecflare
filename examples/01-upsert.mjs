// Insert rows. A namespace is created on first write; its dimension is fixed by the first vector.
import { api, show, toyVector, NS } from "./_client.mjs";

const rows = [];
const topics = ["cooking", "travel", "finance", "sports"];
for (let i = 0; i < 40; i++) {
  const group = i % topics.length;
  rows.push({
    id: `article-${i}`,
    vector: toyVector(group, i),
    attributes: { topic: topics[group], words: 300 + i * 25, tags: [topics[group], i % 2 ? "long" : "short"], published: i < 30 },
  });
}

show("POST /upsert", await api("POST", `/v1/namespaces/${NS}/upsert`, { rows, distance_metric: "cosine_distance" }));
show("GET stats", await api("GET", `/v1/namespaces/${NS}`));
