#!/usr/bin/env bash
# The same operations as the .mjs files, with curl only.
# Usage: VECFLARE_URL=https://... VECFLARE_API_KEY=... ./examples/curl.sh
set -euo pipefail
: "${VECFLARE_URL:?set VECFLARE_URL}" "${VECFLARE_API_KEY:?set VECFLARE_API_KEY}"
H=(-H "Authorization: Bearer $VECFLARE_API_KEY" -H "Content-Type: application/json")
NS="$VECFLARE_URL/v1/namespaces/curl-demo"

echo "# upsert"
curl -s -X POST "$NS/upsert" "${H[@]}" -d '{
  "rows": [
    {"id": "a", "vector": [1, 0, 0, 0], "attributes": {"color": "red",  "size": 10}},
    {"id": "b", "vector": [0, 1, 0, 0], "attributes": {"color": "blue", "size": 20}},
    {"id": "c", "vector": [0.9, 0.1, 0, 0], "attributes": {"color": "red", "size": 30}}
  ]}'; echo

echo "# query"
curl -s -X POST "$NS/query" "${H[@]}" -d '{"vector": [1, 0, 0, 0], "top_k": 2, "include_attributes": true}'; echo

echo "# query with filter"
curl -s -X POST "$NS/query" "${H[@]}" -d '{"vector": [1, 0, 0, 0], "top_k": 2, "filters": ["size", "Gt", 15]}'; echo

echo "# get one"
curl -s "$NS/rows/a?include_vectors=true" "${H[@]}"; echo

echo "# list"
curl -s "$NS/rows?limit=10" "${H[@]}"; echo

echo "# patch"
curl -s -X POST "$NS/patch" "${H[@]}" -d '{"rows": [{"id": "a", "attributes": {"size": 11, "color": null}}]}'; echo

echo "# delete by id"
curl -s -X POST "$NS/delete" "${H[@]}" -d '{"ids": ["b"]}'; echo

echo "# delete by filter"
curl -s -X POST "$NS/delete" "${H[@]}" -d '{"filters": ["color", "Eq", "red"]}'; echo

echo "# stats"
curl -s "$NS" "${H[@]}"; echo

echo "# destroy"
curl -s -X DELETE "$NS" "${H[@]}"; echo
