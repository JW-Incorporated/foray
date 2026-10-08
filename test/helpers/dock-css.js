/* The Dock's committed CSS, read the way the suites read it: as text, with comments gone, and one
 * small resolver for the arithmetic the Dock's geometry is written in.
 *
 * WHY A RESOLVER AND NOT A REGEX PER VALUE. The Dock's reservation is
 * `--dock-reserve: calc(var(--dock-field-h) + var(--dock-mini-h) + var(--dock-tab-rest) + var(--safe-bottom)
 * + var(--dock-inset) + var(--s-6))`, three tokens deep. A test that matched the string would pass on a
 * reservation that no longer added up; one that resolves it compares NUMBERS, so changing a token anywhere
 * in the chain moves the answer. `resolve()` knows var() (with fallbacks), env(safe-area-inset-bottom),
 * calc(), px, and + - * / only; any other function is an error, never a guess.
 *
 * `scope(classes)` answers "what does <body class=...> compute to": the :root tokens (ui/tokens.css), then
 * the Dock's `body.ui-v2` block, then each state class's block, in the order the stylesheet declares them.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");

/** A file's text, LF-normalised and with comments removed. */
function stripped(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** Every UNCONDITIONAL rule of a stylesheet (no @media / @supports / @keyframes around it) as
 *  { selectors: [..], decls: Map(prop -> value) }, in source order. */
function rulesOf(rel) {
  const src = stripped(rel);
  const rules = [];
  const stack = [];
  let buf = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      const prelude = buf.trim();
      buf = "";
      if (prelude.startsWith("@")) { stack.push(prelude); continue; }
      const end = src.indexOf("}", i);
      if (stack.length === 0) {
        const decls = new Map();
        for (const d of src.slice(i + 1, end).split(";")) {
          const c = d.indexOf(":");
          if (c > 0) decls.set(d.slice(0, c).trim(), d.slice(c + 1).trim());
        }
        rules.push({ selectors: prelude.split(",").map((s) => s.trim().replace(/\s+/g, " ")), decls });
      }
      i = end;
    } else if (ch === "}") {
      stack.pop();
      buf = "";
    } else {
      buf += ch;
    }
  }
  return rules;
}

/** The last value `prop` takes on EXACTLY `selector` among unconditional rules of `rel`, or null. */
function declOf(rel, selector, prop) {
  let v = null;
  for (const r of rulesOf(rel)) if (r.selectors.includes(selector) && r.decls.has(prop)) v = r.decls.get(prop);
  return v;
}

/** Custom properties as the cascade leaves them for a <body> carrying `classes`: ui/tokens.css `:root`,
 *  then ui/dock.css's `:root`, `body.ui-v2` and each `body.ui-v2.<class>` block, in that order. */
function scope(classes = []) {
  const vars = new Map();
  const take = (rel, selectors) => {
    for (const r of rulesOf(rel)) {
      if (!r.selectors.some((s) => selectors.includes(s))) continue;
      for (const [k, v] of r.decls) if (k.startsWith("--")) vars.set(k, v);
    }
  };
  take("ui/tokens.css", [":root", ":root, [data-theme=\"dusk\"]"]);
  take("ui/dock.css", [":root", "body.ui-v2"]);
  for (const c of classes) take("ui/dock.css", [`body.ui-v2.${c}`]);
  return vars;
}

/** Resolve a CSS length expression to px under `vars`, with `inset` standing for env(safe-area-inset-bottom). */
function resolve(expr, vars, inset = 0) {
  let e = String(expr).trim();
  for (let guard = 0; guard < 40 && /var\(/.test(e); guard++) {
    e = e.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_, name, fallback) => {
      if (vars.has(name)) return `(${vars.get(name)})`;
      if (fallback !== undefined) return `(${fallback.trim()})`;
      throw new Error(`unresolved ${name} in "${expr}"`);
    });
  }
  e = e.replace(/env\(\s*safe-area-inset-bottom\s*(?:,\s*0(?:px)?\s*)?\)/g, `${inset}px`);
  e = e.replace(/calc\(/g, "(");
  const num = e.replace(/px/g, "");
  if (!/^[\d\s.+\-*/()]+$/.test(num)) throw new Error(`cannot resolve "${expr}" -> "${e}"`);
  return Function(`"use strict"; return (${num});`)();
}

module.exports = { ROOT, stripped, rulesOf, declOf, scope, resolve };
