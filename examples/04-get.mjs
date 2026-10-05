// Read rows back by id, in bulk, and page through a namespace. Run 01-upsert.mjs first.
import { api, show, NS } from "./_client.mjs";

show("one row with its vector", await api("GET", `/v1/namespaces/${NS}/rows/article-7?include_vectors=true`));

show("several rows by id (unknown ids are simply absent)", await api("POST", `/v1/namespaces/${NS}/rows`, { ids: ["article-1", "article-2", "does-not-exist"] }));

let cursor = null;
let page = 0;
do {
  const res = await api("GET", `/v1/namespaces/${NS}/rows?limit=15${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  console.log(`page ${++page}: ${res.rows.length} rows, first ${res.rows[0]?.id}, last ${res.rows.at(-1)?.id}, next_cursor ${res.next_cursor}`);
  cursor = res.next_cursor;
} while (cursor);
