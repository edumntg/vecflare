// Real embeddings: index a few sentences with Workers AI and search them by meaning.
// Needs, on top of VECFLARE_URL and VECFLARE_API_KEY:
//   CLOUDFLARE_ACCOUNT_ID    your account id (dashboard sidebar, or `wrangler whoami`)
//   CLOUDFLARE_API_TOKEN     an API token with the "Workers AI: Read" permission
// Workers AI has a free daily allowance; @cf/baai/bge-base-en-v1.5 returns 768-dimension vectors.
import { api, show } from "./_client.mjs";

const { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN } = process.env;
if (!ACCOUNT || !TOKEN) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (token needs Workers AI: Read).");
  process.exit(1);
}
const NS = "examples-text";

async function embed(texts) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/baai/bge-base-en-v1.5`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ text: texts }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(`Workers AI: ${JSON.stringify(json.errors)}`);
  return json.result.data;
}

const docs = [
  { id: "d1", text: "How to sear a steak in a cast iron pan", topic: "cooking" },
  { id: "d2", text: "Cheap flights to Lisbon in the autumn", topic: "travel" },
  { id: "d3", text: "Index funds versus picking individual stocks", topic: "finance" },
  { id: "d4", text: "Slow-cooked tomato sauce for pasta", topic: "cooking" },
  { id: "d5", text: "Packing list for a two week trip to Japan", topic: "travel" },
  { id: "d6", text: "What an emergency fund should cover", topic: "finance" },
];

const vectors = await embed(docs.map((d) => d.text));
await api("POST", `/v1/namespaces/${NS}/upsert`, {
  rows: docs.map((d, i) => ({ id: d.id, vector: vectors[i], attributes: { text: d.text, topic: d.topic } })),
});

for (const question of ["dinner ideas", "where should I go on holiday", "saving money"]) {
  const [qv] = await embed([question]);
  const r = await api("POST", `/v1/namespaces/${NS}/query`, { vector: qv, top_k: 2, include_attributes: ["text"] });
  console.log(`\n"${question}"`);
  for (const row of r.rows) console.log(`  ${row.dist.toFixed(3)}  ${row.attributes.text}`);
}

const [qv] = await embed(["something to eat"]);
const filtered = await api("POST", `/v1/namespaces/${NS}/query`, { vector: qv, top_k: 3, filters: ["topic", "NotEq", "cooking"], include_attributes: ["text", "topic"] });
show('"something to eat" but topic != cooking', filtered.rows);

await api("DELETE", `/v1/namespaces/${NS}`);
