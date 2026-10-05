// Local dashboard for a vecflare deployment. Serves the static page and proxies /api/* to the Worker,
// adding the bearer key server-side so the browser never sees it. Binds to 127.0.0.1 only.
//
// Usage: node ui/server.mjs [--url https://vecflare.<sub>.workers.dev] [--key <api key>] [--port 4466]
// Falls back to VECFLARE_URL and VECFLARE_API_KEY.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : [])).filter((e) => e.length));
const TARGET = (args.url ?? process.env.VECFLARE_URL ?? "").replace(/\/$/, "");
const KEY = args.key ?? process.env.VECFLARE_API_KEY ?? "";
const PORT = Number(args.port ?? process.env.PORT ?? 4466);

if (!TARGET || !KEY) {
  console.error("Need the Worker URL and the API key.\n  node ui/server.mjs --url https://vecflare.<sub>.workers.dev --key <key>\n  or set VECFLARE_URL and VECFLARE_API_KEY");
  process.exit(1);
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/api/config") {
      // Health is fetched here rather than from the page: the Worker does not send CORS headers.
      const health = await fetch(`${TARGET}/`).then((r) => r.json()).catch(() => null);
      return send(res, 200, JSON.stringify({ target: TARGET, key_hint: KEY.slice(-4), health }), "application/json");
    }
    if (url.pathname.startsWith("/api/")) {
      const body = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req);
      const upstream = await fetch(`${TARGET}/v1/${url.pathname.slice(5)}${url.search}`, {
        method: req.method,
        headers: { authorization: `Bearer ${KEY}`, ...(body ? { "content-type": "application/json" } : {}) },
        body,
      });
      const text = await upstream.text();
      return send(res, upstream.status, text, upstream.headers.get("content-type") ?? "application/json");
    }
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1).replace(/\.\./g, "");
    const data = await readFile(join(here, file)).catch(() => null);
    if (!data) return send(res, 404, "not found", "text/plain");
    return send(res, 200, data, TYPES[extname(file)] ?? "application/octet-stream");
  } catch (err) {
    return send(res, 502, JSON.stringify({ error: String(err) }), "application/json");
  }
});

function send(res, status, body, type) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`vecflare dashboard  http://127.0.0.1:${PORT}  ->  ${TARGET}  (key ending in ${KEY.slice(-4)})`);
});
