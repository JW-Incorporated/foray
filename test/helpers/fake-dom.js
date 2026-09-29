/* ONE small DOM for the suites that run the REAL app.js in a node:vm
 * (audit round 3, tests-10).
 *
 * test/boot-path.test.js and test/load-states.test.js each carried their own
 * copy of this class, identical in the part that mattered and wrong in the
 * same way: a `[name="value"]` selector threw the value away and matched every
 * element carrying the attribute, so `[data-star="b"]` answered with the first
 * star on the page. app.js selects rows by value in several places (the star,
 * the show star, the Up Next row, the chip, the segment), so a test that looked
 * one up got whichever came first, and code that repainted the wrong row passed.
 *
 * What this parses: innerHTML into a NESTED tree (tags, ids, classes, every
 * attribute, `data-*` into `dataset`, `hidden`). What `querySelector(All)`
 * understands: descendant chains of compound selectors made of a tag, `#id`,
 * `.class`, `[attr]` and `[attr="value"]` / `[attr='value']` / `[attr=value]`.
 * The tokenizer reads a bracket to its closing `]` outside quotes, so a value
 * holding `.`, `#` or a space is one token, not three.
 *
 * Kept deliberately small: no combinators other than the descendant space, no
 * pseudo-classes. A selector this does not understand throws, so a test cannot
 * pass by matching nothing.
 */

const VOID = new Set(["img", "input", "br", "hr", "meta", "link", "source", "wbr"]);

class El {
  constructor(tag) {
    this.tagName = String(tag || "div").toUpperCase();
    this.children = [];
    this.parent = null;
    this.id = null;
    this.className = "";
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.attrs = {};
    this.dataset = {};
    this.style = { setProperty() {} };
    this._html = "";
    this._on = new Map();
    const cls = () => new Set(String(this.className).split(/\s+/).filter(Boolean));
    this.classList = {
      add: (...c) => { const s = cls(); c.forEach((x) => s.add(x)); this.className = [...s].join(" "); },
      remove: (...c) => { const s = cls(); c.forEach((x) => s.delete(x)); this.className = [...s].join(" "); },
      contains: (c) => cls().has(c),
      toggle: (c, on) => { const want = on ?? !cls().has(c); if (want) this.classList.add(c); else this.classList.remove(c); return want; },
    };
  }
  get firstElementChild() { return this.children[0] || null; }
  get innerHTML() { return this._html; }
  set innerHTML(html) {
    this._html = String(html);
    this.children = [];
    const stack = [this];
    const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
    let m;
    while ((m = re.exec(this._html))) {
      const [, closing, tag, rest] = m;
      if (closing) { if (stack.length > 1) stack.pop(); continue; }
      const kid = new El(tag);
      for (const a of rest.matchAll(/([a-zA-Z_:][\w:.-]*)(?:="([^"]*)")?/g)) {
        const [, name, val = ""] = a;
        kid.attrs[name] = val;
        if (name === "id") kid.id = val;
        if (name === "class") kid.className = val;
        if (name === "hidden") kid.hidden = true;
        if (name.startsWith("data-")) kid.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = val;
      }
      stack[stack.length - 1].appendChild(kid);
      if (!VOID.has(tag.toLowerCase()) && !/\/\s*$/.test(rest)) stack.push(kid);
    }
  }
  appendChild(k) { k.parent = this; this.children.push(k); return k; }
  append(...ks) { ks.forEach((k) => this.appendChild(k)); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return k in this.attrs; }
  addEventListener(t, fn) { if (!this._on.has(t)) this._on.set(t, []); this._on.get(t).push(fn); }
  removeEventListener() {}
  /** How many listeners of type `t` are bound. */
  listeners(t) { return (this._on.get(t) || []).length; }
  /** Fire this element's click listeners, once-listeners included. */
  click() { const fns = this._on.get("click") || []; this._on.set("click", []); for (const fn of fns) fn({ target: this, preventDefault() {}, stopPropagation() {} }); }
  focus() {} blur() {} select() {}
  closest() { return null; }
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; }
  descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    let scopes = [this];
    for (const compound of splitDescendants(sel)) {
      const toks = compoundTokens(compound);
      scopes = scopes.flatMap((s) => s.descendants().filter((e) => toks.every((t) => t(e))));
    }
    return [...new Set(scopes)];
  }
}

/** Split on whitespace that is outside brackets and quotes. */
function splitDescendants(sel) {
  const out = [];
  let cur = "", depth = 0, quote = null;
  for (const ch of String(sel).trim()) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === "\"" || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "[") depth += 1;
    if (ch === "]") depth -= 1;
    if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** One compound selector -> a list of element predicates. */
function compoundTokens(compound) {
  const preds = [];
  let i = 0;
  const readIdent = () => { const m = /^[\w-]+/.exec(compound.slice(i)); if (!m) throw new Error(`fake-dom: cannot parse selector "${compound}"`); i += m[0].length; return m[0]; };
  while (i < compound.length) {
    const ch = compound[i];
    if (ch === "#") { i += 1; const id = readIdent(); preds.push((el) => el.id === id); continue; }
    if (ch === ".") { i += 1; const c = readIdent(); preds.push((el) => el.classList.contains(c)); continue; }
    if (ch === "[") {
      let j = i + 1, quote = null;
      for (; j < compound.length; j++) {
        const c = compound[j];
        if (quote) { if (c === quote) quote = null; continue; }
        if (c === "\"" || c === "'") { quote = c; continue; }
        if (c === "]") break;
      }
      if (j >= compound.length) throw new Error(`fake-dom: unclosed [ in "${compound}"`);
      const body = compound.slice(i + 1, j);
      i = j + 1;
      const eq = body.indexOf("=");
      if (eq < 0) { const name = body.trim(); preds.push((el) => name in el.attrs); continue; }
      const name = body.slice(0, eq).trim();
      if (/[~|^$*]$/.test(name)) throw new Error(`fake-dom: attribute operator in "${body}" is not supported`);
      let value = body.slice(eq + 1).trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      preds.push((el) => name in el.attrs && el.attrs[name] === value);
      continue;
    }
    if (/[A-Za-z*]/.test(ch)) {
      if (ch === "*") { i += 1; continue; }
      const tag = readIdent().toUpperCase();
      preds.push((el) => el.tagName === tag);
      continue;
    }
    throw new Error(`fake-dom: cannot parse selector "${compound}"`);
  }
  return preds;
}

/** Does `el` match one compound selector (no descendant spaces)? */
function matches(el, compound) {
  return compoundTokens(compound).every((t) => t(el));
}

module.exports = { El, matches, VOID };
