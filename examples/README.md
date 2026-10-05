# Examples

Every script here talks to a deployed vecflare over HTTP. Nothing in this folder needs Cloudflare credentials; it needs the two values you get from deploying:

```bash
export VECFLARE_URL=https://vecflare.<your-subdomain>.workers.dev   # printed by `wrangler deploy`
export VECFLARE_API_KEY=<the secret you set with `wrangler secret put API_KEY`>
```

Node 20 or newer, no install step. Run them in order; 01 creates the data the next five use.

| Script | Shows |
|---|---|
| `01-upsert.mjs` | insert 40 rows with attributes, read namespace stats |
| `02-search.mjs` | nearest neighbours, attribute projection, per-query metric, returning vectors |
| `03-filter.mjs` | `Eq`, `Gte`, `Contains`, `In`, `Glob`, `And`/`Or`/`Not`, filtering on `id` |
| `04-get.mjs` | fetch one row with its vector, fetch many by id, page through the namespace |
| `05-update.mjs` | patch attributes (merge, delete a key), patch the vector, full replace via upsert |
| `06-delete.mjs` | delete by ids, delete by filter, `--destroy` to drop the namespace and its R2 objects |
| `07-index.mjs` | load 6,000 rows, force an index build, compare `nprobe` 1 / 4 / 8 / 24 |
| `08-text-search.mjs` | embed sentences with Workers AI and search by meaning; needs `CLOUDFLARE_ACCOUNT_ID` and a token with Workers AI read |
| `curl.sh` | the whole round trip with curl only |

```bash
node examples/01-upsert.mjs
node examples/02-search.mjs
node examples/03-filter.mjs
node examples/04-get.mjs
node examples/05-update.mjs
node examples/06-delete.mjs --destroy
node examples/07-index.mjs
./examples/curl.sh
```

Point them at a local `npm run dev` with `VECFLARE_URL=http://localhost:8787 VECFLARE_API_KEY=dev-key-change-me`.
