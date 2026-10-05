// Three ways to change a row. Run 01-upsert.mjs first.
import { api, show, toyVector, NS } from "./_client.mjs";

// 1. Patch attributes: keys you send are merged in, null removes a key, the vector is untouched.
show(
  "patch attributes",
  await api("POST", `/v1/namespaces/${NS}/patch`, {
    rows: [{ id: "article-5", attributes: { words: 999, reviewed: true, tags: null } }, { id: "nope", attributes: { x: 1 } }],
  }),
);
show("article-5 after patch", await api("GET", `/v1/namespaces/${NS}/rows/article-5`));

// 2. Patch the vector only: attributes stay.
await api("POST", `/v1/namespaces/${NS}/patch`, { rows: [{ id: "article-5", vector: toyVector(3, 5) }] });
show("article-5 now matches the sports topic", await api("POST", `/v1/namespaces/${NS}/query`, { vector: toyVector(3, 5), top_k: 1, include_attributes: true }));

// 3. Upsert with an existing id replaces vector and attributes entirely.
await api("POST", `/v1/namespaces/${NS}/upsert`, { rows: [{ id: "article-5", vector: toyVector(1, 5), attributes: { topic: "travel", words: 300, tags: ["travel", "short"], published: true } }] });
show("article-5 after full replace", await api("GET", `/v1/namespaces/${NS}/rows/article-5`));
