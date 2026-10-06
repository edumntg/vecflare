# Dashboard

`node ui/server.mjs --url <worker url> --key <api key> [--port 4466]`, or `npm run ui` with `VECFLARE_URL` and `VECFLARE_API_KEY` set.

Three files, no build step and no dependencies:

- `server.mjs` serves the page on 127.0.0.1 and proxies `/api/*` to `<worker>/v1/*` with the bearer key added server-side.
- `index.html` and `app.css` are the markup and styles.
- `editors.js` holds the JSON linter (a strict parser that reports line and column), the Fields/JSON object editor used for attributes, and the filter builder that round-trips with raw filter JSON.
- `app.js` does the work: namespace list, overview, paged rows with a detail drawer (vector strip, editable attributes), search by row id or pasted vector with JSON filters, "find similar" from any row, a PCA scatter of up to 600 sampled vectors, and the write actions.

Everything the page does goes through the same public API documented in the main README; the dashboard has no private endpoints.
