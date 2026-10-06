// Turns a <textarea> into a small JSON code editor: a highlighted layer underneath a transparent textarea,
// line numbers, auto-indent, bracket and quote auto-close, Tab as two spaces, and an error mark from the linter.
// No dependency; the textarea stays the source of truth so forms and tests keep working on it.

const TOKEN = /("(?:[^"\\\n]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}\[\],:])/g;
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

/** Highlight a JSON string to HTML. Keys are strings followed by a colon. */
export function highlightJson(text) {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    out += esc(text.slice(last, m.index));
    if (m[1] !== undefined) out += `<span class="tk-${m[2] ? "key" : "str"}">${esc(m[1])}</span>${m[2] ? `<span class="tk-p">${esc(m[2])}</span>` : ""}`;
    else if (m[3] !== undefined) out += `<span class="tk-num">${esc(m[3])}</span>`;
    else if (m[4] !== undefined) out += `<span class="tk-kw">${esc(m[4])}</span>`;
    else out += `<span class="tk-p">${esc(m[5])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

const PAIRS = { "{": "}", "[": "]", '"': '"' };
const CLOSERS = new Set(["}", "]", '"']);

export function enhanceJsonArea(ta, opts = {}) {
  if (ta.dataset.enhanced) return ta._codeArea;
  ta.dataset.enhanced = "1";
  const wrap = document.createElement("div");
  wrap.className = "code" + (opts.gutter === false ? " no-gutter" : "");
  const pre = document.createElement("pre");
  pre.className = "code-hl";
  pre.setAttribute("aria-hidden", "true");
  const code = document.createElement("code");
  pre.appendChild(code);
  ta.parentNode.insertBefore(wrap, ta);
  wrap.append(pre, ta);
  ta.classList.add("code-ta");
  ta.spellcheck = false;
  ta.setAttribute("autocapitalize", "off");
  ta.setAttribute("autocorrect", "off");

  let errorAt = -1;

  function render() {
    const text = ta.value;
    const lines = text.split("\n");
    let offset = 0;
    let html = "";
    for (const line of lines) {
      let body;
      if (errorAt >= offset && errorAt <= offset + line.length) {
        const at = errorAt - offset;
        const ch = line[at] ?? " ";
        body = highlightJson(line.slice(0, at)) + `<span class="tk-err">${esc(ch)}</span>` + highlightJson(line.slice(at + 1));
      } else body = highlightJson(line);
      html += `<div class="ln">${body || " "}</div>`;
      offset += line.length + 1;
    }
    code.innerHTML = html;
    syncSize();
  }
  function syncSize() {
    // The pre defines the height so the textarea never scrolls independently of the highlight.
    const rows = Math.max(Number(ta.rows) || 3, ta.value.split("\n").length);
    wrap.style.setProperty("--rows", String(rows));
    pre.scrollLeft = ta.scrollLeft;
  }

  ta.addEventListener("input", render);
  ta.addEventListener("scroll", () => (pre.scrollLeft = ta.scrollLeft));
  ta.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const { selectionStart: s, selectionEnd: en, value: v } = ta;
    if (e.key === "Tab") {
      e.preventDefault();
      insert(s, en, "  ");
    } else if (e.key === "Enter") {
      e.preventDefault();
      const lineStart = v.lastIndexOf("\n", s - 1) + 1;
      const indent = /^[ \t]*/.exec(v.slice(lineStart, s))[0];
      const prev = v.slice(0, s).trimEnd().slice(-1);
      const next = v.slice(en).trimStart()[0];
      if ((prev === "{" || prev === "[") && (next === "}" || next === "]")) {
        // Cursor between an open and a close bracket: put the close on its own line.
        const nextIdx = en + (v.slice(en).length - v.slice(en).trimStart().length);
        ta.setRangeText("\n" + indent + "  \n" + indent, s, nextIdx, "end");
        ta.selectionStart = ta.selectionEnd = s + 1 + indent.length + 2;
      } else insert(s, en, "\n" + indent + (prev === "{" || prev === "[" ? "  " : ""));
    } else if (e.key in PAIRS && s === en) {
      const after = v[s];
      if (e.key === '"' && after === '"') { e.preventDefault(); ta.selectionStart = ta.selectionEnd = s + 1; return; }
      if (after === undefined || /[\s\]},:]/.test(after)) {
        e.preventDefault();
        ta.setRangeText(e.key + PAIRS[e.key], s, en, "end");
        ta.selectionStart = ta.selectionEnd = s + 1;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } else if (CLOSERS.has(e.key) && s === en && v[s] === e.key) {
      e.preventDefault();
      ta.selectionStart = ta.selectionEnd = s + 1;
    } else if (e.key === "Backspace" && s === en && s > 0 && PAIRS[v[s - 1]] === v[s]) {
      e.preventDefault();
      ta.setRangeText("", s - 1, s + 1, "end");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  function insert(s, en, text) {
    ta.setRangeText(text, s, en, "end");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }

  const api = {
    /** Mark the character at `offset` as the error, or clear with -1. */
    mark(offset) {
      errorAt = offset ?? -1;
      render();
    },
    refresh: render,
  };
  ta._codeArea = api;
  render();
  // Textareas filled by script do not fire input; observe value changes through a tiny poll-free hook.
  const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  Object.defineProperty(ta, "value", {
    get() { return desc.get.call(this); },
    set(v) { desc.set.call(this, v); render(); },
    configurable: true,
  });
  return api;
}
