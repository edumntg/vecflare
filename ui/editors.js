// JSON lint, a Fields/JSON editor for objects (in the manner of Vault's key/value editor),
// and a filter builder that round-trips with the raw filter JSON.
import { enhanceJsonArea, highlightJson } from "./codearea.js";
export { highlightJson };

/** Strict JSON validator with line and column. Returns { ok, value } or { ok: false, message, line, col }. */
export function lintJson(text) {
  let i = 0;
  const n = text.length;
  const fail = (message, at = i) => {
    let line = 1;
    let col = 1;
    for (let k = 0; k < at && k < n; k++) {
      if (text[k] === "\n") { line++; col = 1; } else col++;
    }
    return { ok: false, message, line, col, offset: Math.min(at, n) };
  };
  const ws = () => { while (i < n && " \t\n\r".includes(text[i])) i++; };
  const value = () => {
    ws();
    if (i >= n) throw fail("unexpected end of input");
    const c = text[i];
    if (c === "{") return object();
    if (c === "[") return array();
    if (c === '"') return string();
    if (c === "-" || (c >= "0" && c <= "9")) return number();
    if (text.startsWith("true", i)) { i += 4; return true; }
    if (text.startsWith("false", i)) { i += 5; return false; }
    if (text.startsWith("null", i)) { i += 4; return null; }
    if (c === "'") throw fail("strings must use double quotes");
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))[0];
      throw fail(`unquoted ${text[i + m.length] === ":" || text.slice(i + m.length).trimStart().startsWith(":") ? "key" : "value"} "${m}"`);
    }
    throw fail(`unexpected character "${c}"`);
  };
  const object = () => {
    const start = i++;
    const out = {};
    ws();
    if (text[i] === "}") { i++; return out; }
    for (;;) {
      ws();
      if (i >= n) throw fail("unterminated object", start);
      if (text[i] === "}") throw fail("trailing comma before }");
      if (text[i] === "'") throw fail("strings must use double quotes");
      if (text[i] !== '"') throw fail(text[i] ? `expected a quoted key, found "${text[i]}"` : "expected a quoted key");
      const key = string();
      ws();
      if (text[i] !== ":") throw fail(`expected ":" after key "${key}"`);
      i++;
      out[key] = value();
      ws();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "}") { i++; return out; }
      throw fail(i >= n ? "unterminated object" : `expected "," or "}" after value of "${key}"`);
    }
  };
  const array = () => {
    const start = i++;
    const out = [];
    ws();
    if (text[i] === "]") { i++; return out; }
    for (;;) {
      ws();
      if (text[i] === "]") throw fail("trailing comma before ]");
      out.push(value());
      ws();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "]") { i++; return out; }
      throw fail(i >= n ? "unterminated array" : `expected "," or "]" in array`, i >= n ? start : i);
    }
  };
  const string = () => {
    const start = i++;
    let out = "";
    while (i < n) {
      const c = text[i++];
      if (c === '"') return out;
      if (c === "\n") throw fail("newline inside string", start);
      if (c === "\\") {
        const e = text[i++];
        if (e === "u") {
          const hex = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw fail("bad \\u escape", i - 2);
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          const map = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
          if (!(e in map)) throw fail(`bad escape "\\${e ?? ""}"`, i - 2);
          out += map[e];
        }
      } else out += c;
    }
    throw fail("unterminated string", start);
  };
  const number = () => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m || m[0] === "-") throw fail("malformed number");
    if (text[i + m[0].length] === "." ) throw fail("malformed number", i + m[0].length);
    i += m[0].length;
    return Number(m[0]);
  };
  try {
    if (text.trim() === "") return { ok: false, message: "empty", line: 1, col: 1, offset: 0, empty: true };
    const v = value();
    ws();
    if (i < n) throw fail(`unexpected "${text[i]}" after the end of the JSON value`);
    return { ok: true, value: v };
  } catch (e) {
    if (e && e.ok === false) return e;
    throw e;
  }
}

export function describeJson(v) {
  if (Array.isArray(v)) return `array of ${v.length}`;
  if (v && typeof v === "object") { const k = Object.keys(v).length; return `object with ${k} key${k === 1 ? "" : "s"}`; }
  return typeof v;
}

/** Vault-style value inference: numbers, booleans, null, arrays and objects parse as JSON; anything else is a string. */
export function inferValue(raw) {
  const t = raw.trim();
  if (t === "") return "";
  const lint = lintJson(t);
  if (lint.ok && (typeof lint.value !== "string" || (t.startsWith('"') && t.endsWith('"')))) return lint.value;
  return raw;
}
export function valueToField(v) {
  if (typeof v === "string") {
    // Strings that would be re-read as something else are shown quoted so the round trip is lossless.
    const l = lintJson(v.trim());
    return l.ok && v.trim() !== "" ? JSON.stringify(v) : v;
  }
  return JSON.stringify(v);
}
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

const el = (tag, attrs = {}, children = []) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e[k] = v;
    else if (k === "text") e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return e;
};

/**
 * Object editor with two modes. `get()` returns the object or throws with the lint message.
 * opts: { value, rows (textarea rows), mode: "fields" | "json", onChange }
 */
export function createObjectEditor(container, opts = {}) {
  let mode = opts.mode ?? "fields";
  let value = opts.value ?? {};
  let fieldRows = [];

  const toggle = el("div", { class: "seg", role: "group", "aria-label": "Editor mode" });
  const bFields = el("button", { type: "button", class: "seg-btn", text: "Fields", onclick: () => setMode("fields") });
  const bJson = el("button", { type: "button", class: "seg-btn", text: "JSON", onclick: () => setMode("json") });
  toggle.append(bFields, bJson);
  const fmt = el("button", { type: "button", class: "btn small", text: "Format", onclick: () => { const l = lintJson(ta.value); if (l.ok) { ta.value = JSON.stringify(l.value, null, 2); lintNow(); } } });
  const head = el("div", { class: "editor-head" }, [toggle, el("span", { class: "spacer" }), fmt]);
  const ta = el("textarea", { rows: String(opts.rows ?? 10), spellcheck: "false", class: "json-ta", oninput: () => { lintNow(); opts.onChange?.(); } });
  const fields = el("div", { class: "fields" });
  const lint = el("div", { class: "lint" });
  container.replaceChildren(head, ta, fields, lint);
  const area = enhanceJsonArea(ta);

  function lintNow() {
    const l = lintJson(ta.value);
    area.mark(l.ok || l.empty ? -1 : l.offset);
    if (l.ok) {
      if (!l.value || typeof l.value !== "object" || Array.isArray(l.value)) return setLint(`valid JSON, but attributes must be an object (got ${describeJson(l.value)})`, true);
      return setLint(`valid · ${describeJson(l.value)}`, false);
    }
    if (l.empty) return setLint("empty · will be saved as {}", false);
    setLint(`line ${l.line}, col ${l.col}: ${l.message}`, true);
  }
  function setLint(text, bad) { lint.textContent = text; lint.classList.toggle("bad", bad); fmt.disabled = bad; }

  function renderFields() {
    fields.replaceChildren();
    for (const r of fieldRows) fields.appendChild(fieldRow(r));
    fields.appendChild(el("button", { type: "button", class: "btn small", text: "Add field", onclick: () => { fieldRows.push({ key: "", raw: "" }); renderFields(); fields.querySelector(".frow:last-of-type input")?.focus(); } }));
    const bad = fieldRows.filter((r) => r.key.trim() === "" && r.raw.trim() !== "");
    const dup = fieldRows.map((r) => r.key).filter((k, i, a) => k && a.indexOf(k) !== i);
    if (dup.length) setLint(`duplicate key "${dup[0]}"`, true);
    else if (bad.length) setLint("a value has no key", true);
    else setLint(`${fieldRows.filter((r) => r.key.trim()).length} field(s)`, false);
  }
  function fieldRow(r) {
    const key = el("input", { type: "text", placeholder: "key", value: r.key, class: "fkey", autocomplete: "off", oninput: (e) => { r.key = e.target.value; renderMeta(); opts.onChange?.(); } });
    const val = el("input", { type: "text", placeholder: "value", value: r.raw, class: "fval", autocomplete: "off", oninput: (e) => { r.raw = e.target.value; renderMeta(); opts.onChange?.(); } });
    const type = el("span", { class: "ftype", text: typeOf(inferValue(r.raw)) });
    const del = el("button", { type: "button", class: "btn small", text: "Remove", "aria-label": `remove ${r.key || "field"}`, onclick: () => { fieldRows = fieldRows.filter((x) => x !== r); renderFields(); opts.onChange?.(); } });
    const row = el("div", { class: "frow" }, [key, val, type, del]);
    function renderMeta() { type.textContent = typeOf(inferValue(r.raw)); const d = fieldRows.filter((x) => x.key === r.key && r.key).length > 1; row.classList.toggle("dup", d); lintFields(); }
    return row;
  }
  function lintFields() {
    const dup = fieldRows.map((r) => r.key).filter((k, i, a) => k && a.indexOf(k) !== i);
    if (dup.length) return setLint(`duplicate key "${dup[0]}"`, true);
    if (fieldRows.some((r) => r.key.trim() === "" && r.raw.trim() !== "")) return setLint("a value has no key", true);
    setLint(`${fieldRows.filter((r) => r.key.trim()).length} field(s)`, false);
  }
  function fieldsToObject() {
    const out = {};
    for (const r of fieldRows) if (r.key.trim()) out[r.key] = inferValue(r.raw);
    return out;
  }

  function setMode(next) {
    if (next === mode) return;
    if (mode === "json") {
      const l = lintJson(ta.value);
      if (!l.ok && !l.empty) { setLint(`fix the JSON first · line ${l.line}, col ${l.col}: ${l.message}`, true); return; }
      if (l.ok && (!l.value || typeof l.value !== "object" || Array.isArray(l.value))) { setLint("fields need an object at the top level", true); return; }
      value = l.ok ? l.value : {};
    } else value = fieldsToObject();
    mode = next;
    render();
  }
  function render() {
    bFields.classList.toggle("active", mode === "fields");
    bJson.classList.toggle("active", mode === "json");
    ta.parentElement.classList.toggle("hidden", mode !== "json");
    fmt.classList.toggle("hidden", mode !== "json");
    fields.classList.toggle("hidden", mode !== "fields");
    if (mode === "json") { ta.value = JSON.stringify(value, null, 2); lintNow(); }
    else { fieldRows = Object.entries(value).map(([key, v]) => ({ key, raw: valueToField(v) })); renderFields(); }
  }
  render();

  return {
    get() {
      if (mode === "json") {
        const l = lintJson(ta.value);
        if (l.empty) return {};
        if (!l.ok) throw new Error(`line ${l.line}, col ${l.col}: ${l.message}`);
        if (!l.value || typeof l.value !== "object" || Array.isArray(l.value)) throw new Error("attributes must be a JSON object");
        return l.value;
      }
      const dup = fieldRows.map((r) => r.key).filter((k, i, a) => k && a.indexOf(k) !== i);
      if (dup.length) throw new Error(`duplicate key "${dup[0]}"`);
      return fieldsToObject();
    },
    set(v) { value = v ?? {}; render(); },
    get mode() { return mode; },
  };
}

/**
 * Textarea with live lint for any JSON value. `expect(value)` returns a problem string, nothing when the value
 * is fine, or `{ ok: text }` to replace the default success text.
 */
export function attachLint(textarea, lintEl, expect) {
  const area = enhanceJsonArea(textarea);
  const run = () => {
    const l = lintJson(textarea.value);
    area.mark(l.ok || l.empty ? -1 : l.offset);
    if (l.empty) { lintEl.textContent = ""; lintEl.classList.remove("bad"); return; }
    if (!l.ok) { lintEl.textContent = `line ${l.line}, col ${l.col}: ${l.message}`; lintEl.classList.add("bad"); return; }
    const r = expect?.(l.value);
    const bad = typeof r === "string";
    lintEl.textContent = bad ? r : (r?.ok ?? `valid · ${describeJson(l.value)}`);
    lintEl.classList.toggle("bad", bad);
  };
  textarea.addEventListener("input", run);
  run();
  return run;
}

const OPS = ["Eq", "NotEq", "Lt", "Lte", "Gt", "Gte", "In", "NotIn", "Glob", "NotGlob", "Contains", "ContainsAny"];
const LIST_OPS = new Set(["In", "NotIn", "ContainsAny"]);

/**
 * Filter editor: a builder for one level of And/Or over [field, op, value] conditions, and a raw JSON mode
 * for anything the builder cannot express. `get()` returns the filter, or undefined when empty.
 */
export function createFilterEditor(container, opts = {}) {
  let mode = "builder";
  let comb = "And";
  let conds = [];
  let raw = "";

  const toggle = el("div", { class: "seg", role: "group", "aria-label": "Filter editor mode" });
  const bBuilder = el("button", { type: "button", class: "seg-btn", text: "Builder", onclick: () => setMode("builder") });
  const bJson = el("button", { type: "button", class: "seg-btn", text: "JSON", onclick: () => setMode("json") });
  toggle.append(bBuilder, bJson);
  const combSel = el("select", { class: "comb", onchange: (e) => { comb = e.target.value; lintBuilder(); } }, [new Option("match all (And)", "And"), new Option("match any (Or)", "Or")]);
  const head = el("div", { class: "editor-head" }, [toggle, combSel, el("span", { class: "spacer" })]);
  const ta = el("textarea", { rows: "3", spellcheck: "false", class: "json-ta", placeholder: '["And", [["topic", "Eq", "travel"], ["words", "Gte", 500]]]', oninput: () => { raw = ta.value; lintRaw(); } });
  const list = el("div", { class: "fields" });
  const lint = el("div", { class: "lint" });
  container.replaceChildren(head, ta, list, lint);
  const area = enhanceJsonArea(ta, { gutter: false });

  const setLint = (t, bad) => { lint.textContent = t; lint.classList.toggle("bad", bad); };

  function condRow(c) {
    const field = el("input", { type: "text", placeholder: "field (or id)", value: c.field, class: "fkey", autocomplete: "off", oninput: (e) => { c.field = e.target.value; lintBuilder(); } });
    const op = el("select", { onchange: (e) => { c.op = e.target.value; val.placeholder = LIST_OPS.has(c.op) ? "a, b, c  or a JSON array" : "value"; lintBuilder(); } }, OPS.map((o) => new Option(o, o, false, o === c.op)));
    const val = el("input", { type: "text", placeholder: LIST_OPS.has(c.op) ? "a, b, c  or a JSON array" : "value", value: c.raw, class: "fval", autocomplete: "off", oninput: (e) => { c.raw = e.target.value; lintBuilder(); } });
    const del = el("button", { type: "button", class: "btn small", text: "Remove", onclick: () => { conds = conds.filter((x) => x !== c); renderBuilder(); } });
    return el("div", { class: "frow cond" }, [field, op, val, del]);
  }
  function renderBuilder() {
    list.replaceChildren(...conds.map(condRow), el("button", { type: "button", class: "btn small", text: "Add condition", onclick: () => { conds.push({ field: "", op: "Eq", raw: "" }); renderBuilder(); list.querySelector(".frow:last-of-type input")?.focus(); } }));
    combSel.classList.toggle("hidden", conds.length < 2);
    lintBuilder();
  }
  function condValue(c) {
    if (LIST_OPS.has(c.op)) {
      const t = c.raw.trim();
      if (t.startsWith("[")) { const l = lintJson(t); if (!l.ok) throw new Error(`"${c.field}": ${l.message}`); return l.value; }
      return t.split(",").map((s) => inferValue(s.trim())).filter((v) => v !== "");
    }
    return inferValue(c.raw);
  }
  function builderFilter() {
    const active = conds.filter((c) => c.field.trim() !== "");
    if (active.length === 0) return undefined;
    const parts = active.map((c) => [c.field.trim(), c.op, condValue(c)]);
    return parts.length === 1 ? parts[0] : [comb, parts];
  }
  function lintBuilder() {
    try {
      const f = builderFilter();
      if (!f) return setLint("no filter · every row is a candidate", false);
      if (conds.some((c) => c.field.trim() === "" && c.raw.trim() !== "")) return setLint("a condition has no field", true);
      setLint(JSON.stringify(f), false);
    } catch (e) { setLint(e.message, true); }
  }
  function lintRaw() {
    const l = lintJson(ta.value);
    area.mark(l.ok || l.empty ? -1 : l.offset);
    if (l.empty) return setLint("no filter · every row is a candidate", false);
    if (!l.ok) return setLint(`line ${l.line}, col ${l.col}: ${l.message}`, true);
    const problem = checkFilterShape(l.value);
    setLint(problem ?? "valid filter", !!problem);
  }
  /** Returns null for a usable builder state, or a string explaining why this filter stays in JSON mode. */
  function toBuilder(f) {
    if (f === undefined) { conds = []; return null; }
    const isCond = (x) => Array.isArray(x) && x.length === 3 && typeof x[0] === "string" && OPS.includes(x[1]);
    const fromCond = ([field, op, v]) => ({ field, op, raw: LIST_OPS.has(op) && Array.isArray(v) ? v.map(valueToField).join(", ") : valueToField(v) });
    if (isCond(f)) { conds = [fromCond(f)]; return null; }
    if (Array.isArray(f) && (f[0] === "And" || f[0] === "Or") && Array.isArray(f[1]) && f[1].every(isCond)) { comb = f[0]; combSel.value = comb; conds = f[1].map(fromCond); return null; }
    return "this filter nests And/Or/Not; the builder handles one level, so it stays as JSON";
  }
  function setMode(next) {
    if (next === mode) return;
    if (mode === "builder") {
      try { const f = builderFilter(); raw = f === undefined ? "" : JSON.stringify(f); } catch (e) { setLint(e.message, true); return; }
      mode = "json";
    } else {
      const l = lintJson(ta.value);
      if (!l.ok && !l.empty) { setLint(`fix the JSON first · line ${l.line}, col ${l.col}: ${l.message}`, true); return; }
      const shape = l.empty ? null : checkFilterShape(l.value);
      if (shape) { setLint(shape, true); return; }
      const why = toBuilder(l.empty ? undefined : l.value);
      if (why) { setLint(why, true); return; }
      mode = "builder";
    }
    render();
  }
  function render() {
    bBuilder.classList.toggle("active", mode === "builder");
    bJson.classList.toggle("active", mode === "json");
    ta.parentElement.classList.toggle("hidden", mode !== "json");
    list.classList.toggle("hidden", mode !== "builder");
    combSel.classList.toggle("hidden", mode !== "builder" || conds.length < 2);
    if (mode === "json") { ta.value = raw; lintRaw(); } else renderBuilder();
  }
  render();

  return {
    get() {
      if (mode === "builder") return builderFilter();
      const l = lintJson(ta.value);
      if (l.empty) return undefined;
      if (!l.ok) throw new Error(`filter: line ${l.line}, col ${l.col}: ${l.message}`);
      const problem = checkFilterShape(l.value);
      if (problem) throw new Error(`filter: ${problem}`);
      return l.value;
    },
    set(f) { raw = f === undefined ? "" : JSON.stringify(f); const why = toBuilder(f); mode = why ? "json" : "builder"; render(); },
    get mode() { return mode; },
  };
}

/** Structural check mirroring the server's filter grammar; returns a message or null. */
export function checkFilterShape(f, depth = 0) {
  if (depth > 16) return "filter nested too deeply";
  if (!Array.isArray(f) || f.length < 2) return "a filter is [field, op, value] or [And|Or, [...]] or [Not, filter]";
  if (f[0] === "And" || f[0] === "Or") {
    if (!Array.isArray(f[1]) || f[1].length === 0) return `${f[0]} needs a non-empty array of filters`;
    for (const p of f[1]) { const m = checkFilterShape(p, depth + 1); if (m) return m; }
    return null;
  }
  if (f[0] === "Not") return f.length === 2 ? checkFilterShape(f[1], depth + 1) : "Not takes exactly one filter";
  if (f.length !== 3) return "a condition is [field, op, value]";
  if (typeof f[0] !== "string") return "field must be a string";
  if (!OPS.includes(f[1])) return `unknown op "${f[1]}"; use ${OPS.join(", ")}`;
  if (LIST_OPS.has(f[1]) && !Array.isArray(f[2])) return `${f[1]} needs an array value`;
  return null;
}
