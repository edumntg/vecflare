// Delete by id, delete by filter, destroy the namespace. Run 01-upsert.mjs first.
import { api, show, NS } from "./_client.mjs";

show("delete two ids", await api("POST", `/v1/namespaces/${NS}/delete`, { ids: ["article-0", "article-1"] }));
show("delete everything unpublished", await api("POST", `/v1/namespaces/${NS}/delete`, { filters: ["published", "Eq", false] }));
show("stats", await api("GET", `/v1/namespaces/${NS}`));

if (process.argv.includes("--destroy")) {
  show("destroy namespace (removes every R2 object too)", await api("DELETE", `/v1/namespaces/${NS}`));
  show("namespaces left", await api("GET", `/v1/namespaces`));
} else {
  console.log("\nRun with --destroy to delete the whole namespace.");
}
