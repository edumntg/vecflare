const $ = (sel) => document.querySelector(sel);
const fmtBytes = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`);
const fmtDate = (ms) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "–");
const compact = (obj) => (obj == null ? "" : JSON.stringify(obj));

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(json.error ?? `${res.status} ${res.statusText}`);
  return json;
}

const state = { ns: null, stats: null, tab: "overview", cursor: null, rowsHistory: [], drawerRow: null, viz: null, health: null, target: "" };

// ---- namespaces sidebar ----

async function loadNamespaces(select) {
  const list = $("#ns-list");
  try {
    const { namespaces } = await api("GET", "/namespaces");
    if (namespaces.length === 0) {
      list.innerHTML = `<li class="muted">No namespaces yet. Writes create them.</li>`;
      return;
    }
    list.innerHTML = "";
    for (const n of namespaces) {
      const li = document.createElement("li");
      li.dataset.ns = n.name;
      li.innerHTML = `<span>${esc(n.name)}</span><span class="count">…</span>`;
      li.onclick = () => openNamespace(n.name);
      list.appendChild(li);
      api("GET", `/namespaces/${encodeURIComponent(n.name)}`).then((s) => (li.querySelector(".count").textContent = s.rows.toLocaleString())).catch(() => (li.querySelector(".count").textContent = "?"));
    }
    if (select) openNamespace(select);
    else if (state.ns) markActive();
  } catch (err) {
    list.innerHTML = `<li class="muted">Could not list namespaces: ${esc(err.message)}</li>`;
  }
}

function markActive() {
  for (const li of document.querySelectorAll("#ns-list li")) li.classList.toggle("active", li.dataset.ns === state.ns);
}

async function openNamespace(name) {
  state.ns = name;
  state.cursor = null;
  state.rowsHistory = [];
  markActive();
  $("#welcome").classList.add("hidden");
  $("#ns-view").classList.remove("hidden");
  $("#ns-name").textContent = name;
  $("#ns-meta").textContent = "loading…";
  $("#build-result").classList.add("hidden");
  $("#search-table").classList.add("hidden");
  $("#search-status").textContent = "";
  $("#q-id").value = "";
  $("#q-vector").value = "";
  closeDrawer();
  await refreshStats();
  showTab(state.tab);
}

async function refreshStats() {
  try {
    const s = await api("GET", `/namespaces/${encodeURIComponent(state.ns)}`);
    state.stats = s;
    $("#ns-meta").textContent = `${s.rows.toLocaleString()} rows · ${s.dim ?? "?"} dims · ${s.distance_metric} · index ${s.index ? `v${s.index.version}, ${s.index.clusters} clusters` : "none"}`;
    const idx = s.index ? `v${s.index.version} · ${s.index.clusters} clusters` : "none yet";
    const pending = s.unindexed_rows > 0 ? ` (${s.unindexed_rows.toLocaleString()} rows searched exhaustively until the next build)` : "";
    $("#stats").innerHTML = rows([
      ["Rows", s.rows.toLocaleString()],
      ["Dimensions", s.dim ?? "not set until the first upsert"],
      ["Distance metric", s.distance_metric],
      ["Index", idx + pending],
      ["Segments", `${s.segments.wal} WAL · ${s.segments.cluster} cluster files`],
      ["Storage in R2", `${fmtBytes(s.storage_bytes)} (${s.storage_bytes.toLocaleString()} bytes)`],
      ["Created", fmtDate(s.created_at)],
    ]);
    const monthly = (s.storage_bytes / 1073741824) * 0.015;
    $("#deploy").innerHTML = rows([
      ["Worker", state.target || "–"],
      ["Health", state.health ? `${state.health.name} ${state.health.version}` : "unreachable"],
      ["Durable Objects", `VecNamespace + Indexer for “${s.name}”`],
      ["R2 prefix", `ns/${s.name}/`],
      ["Storage cost", monthly < 0.01 ? "under $0.01 per month at list price" : `$${monthly.toFixed(2)} per month at list price`],
    ]);
    const li = document.querySelector(`#ns-list li[data-ns="${CSS.escape(state.ns)}"] .count`);
    if (li) li.textContent = s.rows.toLocaleString();
  } catch (err) {
    $("#ns-meta").textContent = `could not load stats: ${err.message}`;
  }
}

const rows = (pairs) => pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(String(v))}</dd>`).join("");

// ---- tabs ----

function showTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll(".tab")) b.classList.toggle("active", b.dataset.tab === tab);
  for (const p of document.querySelectorAll(".tabpanel")) p.classList.toggle("hidden", p.id !== `tab-${tab}`);
  if (tab === "rows" && !$("#rows-table tbody").children.length) loadRows(true);
}
document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

// ---- rows ----

async function loadRows(first) {
  if (first) {
    state.cursor = null;
    state.rowsHistory = [];
  }
  const limit = Number($("#page-size").value);
  const status = $("#rows-status");
  status.textContent = `Loading rows from ${state.ns}…`;
  const tbody = $("#rows-table tbody");
  try {
    const res = await api("GET", `/namespaces/${encodeURIComponent(state.ns)}/rows?limit=${limit}${state.cursor ? `&cursor=${encodeURIComponent(state.cursor)}` : ""}`);
    tbody.innerHTML = "";
    if (res.rows.length === 0) {
      status.textContent = state.cursor ? "No more rows." : "This namespace has no rows. Insert some with the button above or run examples/01-upsert.mjs.";
      $("#btn-rows-next").disabled = true;
      return;
    }
    for (const r of res.rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="id">${esc(r.id)}</td><td class="attrs" title="${esc(compact(r.attributes))}">${esc(compact(r.attributes))}</td>
        <td class="row-actions"><button class="btn small" data-act="similar">Similar</button> <button class="btn small danger" data-act="delete">Delete</button></td>`;
      tr.onclick = (e) => {
        const act = e.target.dataset?.act;
        if (act === "similar") return findSimilar(r.id);
        if (act === "delete") return deleteRow(r.id);
        openDrawer(r.id);
      };
      tbody.appendChild(tr);
    }
    const from = state.rowsHistory.length * limit + 1;
    status.textContent = `Rows ${from}–${from + res.rows.length - 1}, ordered by id${res.next_cursor ? "" : " · last page"}.`;
    state.nextCursor = res.next_cursor;
    $("#btn-rows-next").disabled = !res.next_cursor;
  } catch (err) {
    status.textContent = `Could not load rows: ${err.message}`;
  }
}
$("#btn-rows-first").onclick = () => loadRows(true);
$("#btn-rows-next").onclick = () => {
  if (!state.nextCursor) return;
  state.rowsHistory.push(state.cursor);
  state.cursor = state.nextCursor;
  loadRows(false);
};
$("#page-size").onchange = () => loadRows(true);

async function deleteRow(id) {
  const ok = await confirmDialog("Delete row", `Delete “${id}” from ${state.ns}? The vector bytes stay in R2 until the next index build.`);
  if (!ok) return;
  try {
    await api("POST", `/namespaces/${encodeURIComponent(state.ns)}/delete`, { ids: [id] });
    if (state.drawerRow?.id === id) closeDrawer();
    await Promise.all([loadRows(false), refreshStats()]);
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
  }
}

$("#btn-insert").onclick = async () => {
  const dim = state.stats?.dim;
  const template = JSON.stringify([{ id: "", vector: dim ? Array(dim).fill(0) : [], attributes: {} }], null, 2);
  const val = await formDialog("Insert rows", `Rows are upserted: an existing id is replaced. ${dim ? `Vectors must have ${dim} dimensions.` : "The first vector fixes the dimension."}`, [{ name: "rows", label: "rows (JSON array)", type: "textarea", value: template, rows: 10 }], "Upsert");
  if (!val) return;
  try {
    const parsed = JSON.parse(val.rows);
    const res = await api("POST", `/namespaces/${encodeURIComponent(state.ns)}/upsert`, { rows: parsed });
    $("#rows-status").textContent = `Upserted ${res.upserted} row(s).`;
    await Promise.all([loadRows(true), refreshStats(), loadNamespaces()]);
  } catch (err) {
    alert(`Upsert failed: ${err.message}`);
  }
};

// ---- drawer ----

async function openDrawer(id) {
  const d = $("#drawer");
  d.classList.remove("hidden");
  $("#d-id").textContent = id;
  $("#d-attrs").value = "";
  $("#d-status").textContent = "loading…";
  $("#d-vec-meta").textContent = "";
  try {
    const res = await api("POST", `/namespaces/${encodeURIComponent(state.ns)}/rows`, { ids: [id], include_vectors: true });
    const row = res.rows[0];
    if (!row) throw new Error("row no longer exists");
    state.drawerRow = row;
    $("#d-attrs").value = JSON.stringify(row.attributes ?? {}, null, 2);
    $("#d-status").textContent = "";
    drawVector($("#d-vec"), row.vector ?? []);
    const v = row.vector ?? [];
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    $("#d-vec-meta").textContent = v.length ? `${v.length} dims · min ${Math.min(...v).toFixed(3)} · max ${Math.max(...v).toFixed(3)} · ‖v‖ ${norm.toFixed(3)}` : "";
  } catch (err) {
    $("#d-status").textContent = `Could not load row: ${err.message}`;
  }
}
function closeDrawer() {
  $("#drawer").classList.add("hidden");
  state.drawerRow = null;
}
$("#btn-drawer-close").onclick = closeDrawer;
$("#btn-similar").onclick = () => state.drawerRow && findSimilar(state.drawerRow.id);
$("#btn-delete-row").onclick = () => state.drawerRow && deleteRow(state.drawerRow.id);
$("#btn-copy-vector").onclick = async () => {
  if (!state.drawerRow) return;
  await navigator.clipboard.writeText(JSON.stringify(state.drawerRow.vector));
  $("#d-status").textContent = "Vector copied as JSON.";
};
$("#btn-save-attrs").onclick = async () => {
  if (!state.drawerRow) return;
  try {
    const next = JSON.parse($("#d-attrs").value);
    const current = state.drawerRow.attributes ?? {};
    // patch merges, so keys removed in the editor are sent as null to delete them
    const patch = { ...next };
    for (const k of Object.keys(current)) if (!(k in next)) patch[k] = null;
    const res = await api("POST", `/namespaces/${encodeURIComponent(state.ns)}/patch`, { rows: [{ id: state.drawerRow.id, attributes: patch }] });
    $("#d-status").textContent = res.patched ? "Saved." : "Row not found.";
    state.drawerRow.attributes = next;
    if (state.tab === "rows") loadRows(false);
  } catch (err) {
    $("#d-status").textContent = `Not saved: ${err.message}`;
  }
};

function drawVector(canvas, v) {
  const ctx = canvas.getContext("2d");
  const W = (canvas.width = canvas.clientWidth * devicePixelRatio);
  const H = (canvas.height = 72 * devicePixelRatio);
  ctx.clearRect(0, 0, W, H);
  if (!v.length) return;
  const n = Math.min(v.length, 512);
  const max = Math.max(1e-9, ...v.slice(0, n).map(Math.abs));
  const bw = W / n;
  const mid = H / 2;
  ctx.fillStyle = "#e4e0da";
  ctx.fillRect(0, mid, W, 1);
  ctx.fillStyle = "#4f46e5";
  for (let i = 0; i < n; i++) {
    const h = (v[i] / max) * (mid - 4);
    ctx.fillRect(i * bw, h >= 0 ? mid - h : mid, Math.max(1, bw - 0.5), Math.abs(h));
  }
}

// ---- search ----

async function findSimilar(id) {
  showTab("search");
  $("#q-id").value = id;
  $("#q-vector").value = "";
  runSearch();
}

$("#search-form").onsubmit = (e) => {
  e.preventDefault();
  runSearch();
};

async function runSearch() {
  const status = $("#search-status");
  const table = $("#search-table");
  const id = $("#q-id").value.trim();
  const vecText = $("#q-vector").value.trim();
  const filterText = $("#q-filter").value.trim();
  let vector;
  try {
    if (vecText) vector = JSON.parse(vecText);
    else if (id) {
      status.textContent = `Fetching the vector of ${id}…`;
      const res = await api("POST", `/namespaces/${encodeURIComponent(state.ns)}/rows`, { ids: [id], include_vectors: true });
      if (!res.rows[0]) throw new Error(`no row with id “${id}”`);
      vector = res.rows[0].vector;
    } else throw new Error("give a row id or paste a vector");
    const body = { vector, top_k: Number($("#q-topk").value) || 10, include_attributes: $("#q-attrs").checked };
    if ($("#q-nprobe").value) body.nprobe = Number($("#q-nprobe").value);
    if (filterText) body.filters = JSON.parse(filterText);
    status.textContent = "Searching…";
    const t0 = performance.now();
    const res = await api("POST", `/namespaces/${encodeURIComponent(state.ns)}/query`, body);
    const ms = Math.round(performance.now() - t0);
    const s = res.stats;
    status.textContent = `${res.rows.length} result(s) in ${ms} ms round trip (${s.took_ms} ms in the Durable Object) · scored ${s.vectors_scored.toLocaleString()} vectors in ${s.segments_scanned} segment(s) · cache ${s.cache_hits} hit / ${s.cache_misses} miss · ${s.exhaustive ? "exhaustive" : `index v${s.index_version}`}${s.stale_candidates ? ` · ${s.stale_candidates} stale dropped` : ""}`;
    const tbody = table.querySelector("tbody");
    tbody.innerHTML = "";
    res.rows.forEach((r, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="num">${i + 1}</td><td class="id">${esc(r.id)}${r.id === id ? ' <span class="muted small">(query)</span>' : ""}</td><td class="num">${r.dist.toFixed(5)}</td><td class="attrs" title="${esc(compact(r.attributes))}">${esc(compact(r.attributes))}</td>
        <td class="row-actions"><button class="btn small" data-act="similar">Similar</button></td>`;
      tr.onclick = (e) => (e.target.dataset?.act === "similar" ? findSimilar(r.id) : openDrawer(r.id));
      tbody.appendChild(tr);
    });
    table.classList.toggle("hidden", res.rows.length === 0);
    if (res.rows.length === 0) status.textContent += " · nothing matched; loosen the filter or check that the namespace has rows";
  } catch (err) {
    status.textContent = `Search failed: ${err.message}`;
    table.classList.add("hidden");
  }
}

// ---- visualize ----

$("#btn-viz").onclick = loadViz;
$("#viz-color").onchange = () => state.viz && drawViz();

async function loadViz() {
  const n = Number($("#viz-n").value);
  const status = $("#viz-status");
  try {
    status.textContent = "Listing ids…";
    const ids = [];
    let cursor = null;
    while (ids.length < n) {
      const page = await api("GET", `/namespaces/${encodeURIComponent(state.ns)}/rows?limit=${Math.min(1000, n - ids.length)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      ids.push(...page.rows.map((r) => r.id));
      cursor = page.next_cursor;
      if (!cursor) break;
    }
    if (ids.length < 3) {
      status.textContent = "Need at least 3 rows to project.";
      return;
    }
    const rowsOut = [];
    for (let i = 0; i < ids.length; i += 100) {
      status.textContent = `Fetching vectors ${i + 1}–${Math.min(ids.length, i + 100)} of ${ids.length}…`;
      const res = await api("POST", `/namespaces/${encodeURIComponent(state.ns)}/rows`, { ids: ids.slice(i, i + 100), include_vectors: true });
      rowsOut.push(...res.rows.filter((r) => r.vector));
    }
    status.textContent = "Computing PCA…";
    await new Promise((r) => setTimeout(r));
    const pts = pca2d(rowsOut.map((r) => r.vector));
    const keys = new Set();
    for (const r of rowsOut) for (const k of Object.keys(r.attributes ?? {})) if (["string", "number", "boolean"].includes(typeof r.attributes[k])) keys.add(k);
    const sel = $("#viz-color");
    const prev = sel.value;
    sel.innerHTML = `<option value="">(none)</option>` + [...keys].map((k) => `<option ${k === prev ? "selected" : ""}>${esc(k)}</option>`).join("");
    state.viz = { rows: rowsOut, pts };
    status.textContent = `${rowsOut.length} rows projected (first ${rowsOut.length} by id).`;
    drawViz();
  } catch (err) {
    status.textContent = `Could not load: ${err.message}`;
  }
}

const PALETTE = ["#4f46e5", "#0f766e", "#b45309", "#be123c", "#1d4ed8", "#4d7c0f", "#7e22ce", "#0e7490", "#9f1239", "#374151"];

function drawViz() {
  const { rows: vrows, pts } = state.viz;
  const canvas = $("#viz");
  const ctx = canvas.getContext("2d");
  const W = (canvas.width = canvas.clientWidth * devicePixelRatio);
  const H = (canvas.height = 520 * devicePixelRatio);
  ctx.clearRect(0, 0, W, H);
  const key = $("#viz-color").value;
  const cats = new Map();
  const colorOf = (r) => {
    if (!key) return "#4f46e5";
    const v = r.attributes?.[key];
    const label = v === undefined ? "(missing)" : String(v);
    if (!cats.has(label)) cats.set(label, PALETTE[cats.size % PALETTE.length]);
    return cats.get(label);
  };
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pad = 24 * devicePixelRatio;
  const sx = (x) => pad + ((x - x0) / (x1 - x0 || 1)) * (W - 2 * pad);
  const sy = (y) => H - pad - ((y - y0) / (y1 - y0 || 1)) * (H - 2 * pad);
  const r = 3.5 * devicePixelRatio;
  state.viz.screen = pts.map(([x, y]) => [sx(x), sy(y)]);
  vrows.forEach((row, i) => {
    ctx.fillStyle = colorOf(row);
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.arc(state.viz.screen[i][0], state.viz.screen[i][1], r, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
  const legend = $("#viz-legend");
  legend.innerHTML = key ? [...cats].slice(0, 20).map(([label, c]) => `<div><span class="sw" style="background:${c}"></span>${esc(label)}</div>`).join("") + (cats.size > 20 ? `<div class="muted">+${cats.size - 20} more</div>` : "") : "";
}

$("#viz").onmousemove = (e) => {
  if (!state.viz?.screen) return;
  const rect = e.target.getBoundingClientRect();
  const x = (e.clientX - rect.left) * devicePixelRatio;
  const y = (e.clientY - rect.top) * devicePixelRatio;
  let best = -1;
  let bd = 12 * devicePixelRatio;
  state.viz.screen.forEach(([px, py], i) => {
    const d = Math.hypot(px - x, py - y);
    if (d < bd) { bd = d; best = i; }
  });
  const tip = $("#viz-tip");
  state.viz.hover = best;
  if (best < 0) return tip.classList.add("hidden");
  const row = state.viz.rows[best];
  tip.textContent = `${row.id}\n${compact(row.attributes).slice(0, 240)}`;
  tip.style.left = `${e.clientX + 12}px`;
  tip.style.top = `${e.clientY + 12}px`;
  tip.classList.remove("hidden");
  e.target.style.cursor = "pointer";
};
$("#viz").onmouseleave = () => $("#viz-tip").classList.add("hidden");
$("#viz").onclick = () => {
  if (state.viz?.hover >= 0) openDrawer(state.viz.rows[state.viz.hover].id);
};

/** First two principal components by power iteration on the covariance, enough for a picture. */
function pca2d(vectors) {
  const n = vectors.length;
  const d = vectors[0].length;
  const mean = new Float64Array(d);
  for (const v of vectors) for (let j = 0; j < d; j++) mean[j] += v[j] / n;
  const X = vectors.map((v) => v.map((x, j) => x - mean[j]));
  const comps = [];
  for (let c = 0; c < 2; c++) {
    let w = new Float64Array(d).map((_, j) => Math.sin(j * 12.9898 + c * 78.233));
    for (let it = 0; it < 60; it++) {
      const next = new Float64Array(d);
      for (const x of X) {
        let dot = 0;
        for (let j = 0; j < d; j++) dot += x[j] * w[j];
        for (let j = 0; j < d; j++) next[j] += dot * x[j];
      }
      for (const p of comps) {
        let dot = 0;
        for (let j = 0; j < d; j++) dot += next[j] * p[j];
        for (let j = 0; j < d; j++) next[j] -= dot * p[j];
      }
      const norm = Math.sqrt(next.reduce((s, x) => s + x * x, 0)) || 1;
      w = next.map((x) => x / norm);
    }
    comps.push(w);
  }
  return X.map((x) => comps.map((w) => x.reduce((s, xi, j) => s + xi * w[j], 0)));
}

// ---- namespace actions ----

$("#btn-build").onclick = async () => {
  const out = $("#build-result");
  showTab("overview");
  out.classList.remove("hidden");
  out.textContent = "Building index… this runs in the Indexer Durable Object and can take a while for large namespaces.";
  $("#btn-build").disabled = true;
  try {
    const res = await api("POST", `/namespaces/${encodeURIComponent(state.ns)}/index`, { force: true });
    out.textContent = res.status === "built" ? `Built index v${res.version}: ${res.clusters} clusters over ${res.rows.toLocaleString()} rows in ${(res.took_ms / 1000).toFixed(1)} s.` : res.status === "already_running" ? "A build is already running; refresh the overview in a bit." : `Skipped: ${res.reason}.`;
    await refreshStats();
  } catch (err) {
    out.textContent = `Build failed: ${err.message}`;
  } finally {
    $("#btn-build").disabled = false;
  }
};

$("#btn-delete-ns").onclick = async () => {
  const val = await formDialog("Delete namespace", `This removes every row and every R2 object under ns/${state.ns}/. Type the namespace name to confirm.`, [{ name: "confirm", label: "namespace name", type: "text", value: "" }], "Delete");
  if (!val || val.confirm !== state.ns) return;
  try {
    const res = await api("DELETE", `/namespaces/${encodeURIComponent(state.ns)}`);
    state.ns = null;
    $("#ns-view").classList.add("hidden");
    $("#welcome").classList.remove("hidden");
    $("#welcome p").textContent = `Deleted “${res.name}” and ${res.deleted_objects} R2 object(s).`;
    closeDrawer();
    await loadNamespaces();
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
  }
};

$("#btn-new-ns").onclick = async () => {
  const val = await formDialog("New namespace", "Creates an empty namespace. The dimension is fixed by the first vector you insert.", [
    { name: "name", label: "name ([A-Za-z0-9][A-Za-z0-9_-]{0,63})", type: "text", value: "" },
    { name: "metric", label: "distance metric", type: "select", options: ["cosine_distance", "euclidean_squared", "dot_product"] },
  ], "Create");
  if (!val || !val.name) return;
  try {
    await api("PUT", `/namespaces/${encodeURIComponent(val.name)}`, { distance_metric: val.metric });
    await loadNamespaces(val.name);
  } catch (err) {
    alert(`Could not create: ${err.message}`);
  }
};

// ---- dialogs ----

function confirmDialog(title, text) {
  return formDialog(title, text, [], "Confirm").then((v) => v !== null);
}

function formDialog(title, text, fields, okLabel) {
  const dlg = $("#dlg");
  $("#dlg-title").textContent = title;
  $("#dlg-text").textContent = text;
  $("#dlg-ok").textContent = okLabel;
  const wrap = $("#dlg-fields");
  wrap.innerHTML = "";
  for (const f of fields) {
    const label = document.createElement("label");
    label.textContent = f.label;
    let input;
    if (f.type === "textarea") {
      input = document.createElement("textarea");
      input.rows = f.rows ?? 6;
      input.value = f.value ?? "";
    } else if (f.type === "select") {
      input = document.createElement("select");
      for (const o of f.options) input.add(new Option(o, o));
    } else {
      input = document.createElement("input");
      input.type = "text";
      input.value = f.value ?? "";
      input.autocomplete = "off";
    }
    input.name = f.name;
    label.appendChild(input);
    wrap.appendChild(label);
  }
  dlg.showModal();
  wrap.querySelector("input, textarea, select")?.focus();
  return new Promise((resolve) => {
    dlg.onclose = () => {
      if (dlg.returnValue !== "ok") return resolve(null);
      const out = {};
      for (const el of wrap.querySelectorAll("[name]")) out[el.name] = el.value;
      resolve(out);
    };
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---- boot ----

(async () => {
  try {
    const cfg = await fetch("/api/config").then((r) => r.json());
    state.target = cfg.target;
    state.health = cfg.health;
    $("#target").textContent = cfg.target.replace(/^https?:\/\//, "");
  } catch {
    $("#target").textContent = "dashboard server not reachable";
  }
  loadNamespaces();
})();
