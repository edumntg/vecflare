import { Hono } from "hono";
import { parseError } from "./errors";
import type { Filter, Metric, PatchRow, QueryRequest, UpsertRow } from "./types";

export { VecNamespace } from "./namespace";
export { Indexer } from "./indexer";
export { Registry } from "./registry";

const NS_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

type Vars = { ns: string };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.onError((err, c) => {
  const { status, message } = parseError(err);
  if (status >= 500) console.error(err);
  return c.json({ error: message }, status as 400);
});

app.get("/", (c) => c.json({ name: "vecflare", version: "0.1.0" }));

app.use("/v1/*", async (c, next) => {
  const expected = c.env.API_KEY;
  if (!expected) return c.json({ error: "API_KEY secret is not configured; run `wrangler secret put API_KEY`" }, 500);
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!(await safeEqual(token, expected))) return c.json({ error: "unauthorized" }, 401);
  await next();
});

app.use("/v1/namespaces/:ns/*", async (c, next) => {
  const ns = c.req.param("ns");
  if (!NS_RE.test(ns)) return c.json({ error: "namespace must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}" }, 400);
  c.set("ns", ns);
  await next();
});
app.use("/v1/namespaces/:ns", async (c, next) => {
  const ns = c.req.param("ns");
  if (!NS_RE.test(ns)) return c.json({ error: "namespace must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}" }, 400);
  c.set("ns", ns);
  await next();
});

function stub(c: { env: Env; get: (k: "ns") => string }) {
  const ns = c.get("ns");
  return { ns, obj: c.env.NAMESPACE.get(c.env.NAMESPACE.idFromName(ns)) };
}

function registry(env: Env) {
  return env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
}

app.get("/v1/namespaces", async (c) => {
  return c.json({ namespaces: await registry(c.env).list() });
});

app.put("/v1/namespaces/:ns", async (c) => {
  const { ns, obj } = stub(c);
  const body = await json<{ distance_metric?: Metric }>(c.req.raw);
  const res = await obj.configure(ns, body);
  if (res.created) await registry(c.env).register(ns);
  return c.json({ name: ns, ...res });
});

app.get("/v1/namespaces/:ns", async (c) => {
  const { ns, obj } = stub(c);
  return c.json(await obj.stats(ns));
});

app.delete("/v1/namespaces/:ns", async (c) => {
  const { ns, obj } = stub(c);
  const res = await obj.destroy(ns);
  await registry(c.env).unregister(ns);
  return c.json({ name: ns, ...res });
});

app.post("/v1/namespaces/:ns/upsert", async (c) => {
  const { ns, obj } = stub(c);
  const body = await json<{ rows: UpsertRow[]; distance_metric?: Metric }>(c.req.raw);
  const res = await obj.upsert(ns, body.rows, { distance_metric: body.distance_metric });
  if (res.created) await registry(c.env).register(ns);
  return c.json({ upserted: res.upserted });
});

app.post("/v1/namespaces/:ns/patch", async (c) => {
  const { ns, obj } = stub(c);
  const body = await json<{ rows: PatchRow[] }>(c.req.raw);
  return c.json(await obj.patch(ns, body.rows));
});

app.post("/v1/namespaces/:ns/delete", async (c) => {
  const { ns, obj } = stub(c);
  const body = await json<{ ids?: string[]; filters?: Filter }>(c.req.raw);
  if (body.ids) return c.json(await obj.deleteRows(ns, body.ids));
  if (body.filters) return c.json(await obj.deleteByFilter(ns, body.filters));
  return c.json({ error: "body needs ids or filters" }, 400);
});

app.post("/v1/namespaces/:ns/rows", async (c) => {
  const { ns, obj } = stub(c);
  const body = await json<{ ids: string[]; include_vectors?: boolean }>(c.req.raw);
  return c.json(await obj.getRows(ns, body.ids, body.include_vectors === true));
});

app.get("/v1/namespaces/:ns/rows", async (c) => {
  const { ns, obj } = stub(c);
  const limit = Number(c.req.query("limit") ?? 100);
  return c.json(await obj.listRows(ns, c.req.query("cursor") ?? null, limit));
});

app.get("/v1/namespaces/:ns/rows/:id", async (c) => {
  const { ns, obj } = stub(c);
  const res = await obj.getRows(ns, [c.req.param("id")], c.req.query("include_vectors") === "true");
  if (res.rows.length === 0) return c.json({ error: "not found" }, 404);
  return c.json(res.rows[0]);
});

app.post("/v1/namespaces/:ns/query", async (c) => {
  const { ns, obj } = stub(c);
  const body = await json<QueryRequest>(c.req.raw);
  return c.json(await obj.query(ns, body));
});

app.post("/v1/namespaces/:ns/index", async (c) => {
  const ns = c.get("ns");
  const body = await json<{ force?: boolean }>(c.req.raw, true);
  const indexer = c.env.INDEXER.get(c.env.INDEXER.idFromName(ns));
  return c.json(await indexer.build(ns, body.force !== false));
});

app.notFound((c) => c.json({ error: "not found" }, 404));

async function json<T>(req: Request, optional = false): Promise<T> {
  const text = await req.text();
  if (!text) {
    if (optional) return {} as T;
    throw new Error("400\u001fbody must be JSON");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("400\u001fbody must be valid JSON");
  }
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

export default app;
