/* Security invariants for app.js (Tier 4 auto-merge gate).
 *
 * WHY THIS EXISTS
 * Until 2026-08-11 the only CI coverage of app.js was `node --check` — a syntax
 * check. It would pass an XSS regression, a CSP violation, or a javascript:
 * URL without complaint. That was fine while every app.js change was read by a
 * human; it is not fine now that `app.js` is in the auto-merge allowlist
 * (.github/workflows/automerge-nightly.yml). This file is what replaces the
 * human read for the class of bug that actually matters here.
 *
 * WHAT IT DOES NOT DO — read this before trusting it
 * These are *security and convention* invariants, not behavioural coverage of
 * rendering. A change that makes the home page render blank while keeping every
 * invariant below intact will pass. Full render coverage needs a real DOM, and
 * jsdom is a dependency this repo deliberately does not have (root
 * package.json: "NO dependencies and NO build step"). The smoke test at the
 * bottom closes part of that gap with a hand-rolled DOM stub — deliberately
 * minimal, and honest about its limits.
 *
 * No dependencies: node:test + node:vm only, matching player/*.test.js.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const APP_PATH = path.join(__dirname, "..", "app.js");
const SRC = fs.readFileSync(APP_PATH, "utf8");

/* ---------- harness ----------
   app.js is a classic browser script that calls init() at top level. init() is
   async and awaits fetchJson() first, so a fetch that never settles parks it at
   the first await — the function declarations are all hoisted and reachable,
   and no DOM work happens. That is the whole trick that makes this dependency
   free. */
function loadApp() {
  const noop = () => {};
  const el = () => ({
    addEventListener: noop, removeEventListener: noop, appendChild: noop,
    setAttribute: noop, removeAttribute: noop, classList: { add: noop, remove: noop, toggle: noop },
    style: {}, dataset: {}, children: [], hidden: false,
    innerHTML: "", textContent: "", className: "",
    querySelector: () => el(), querySelectorAll: () => [],
  });

  const store = new Map();
  const ctx = {
    console,
    // Never settles: parks init() at its first await.
    fetch: () => new Promise(() => {}),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: {
      body: el(), documentElement: el(),
      addEventListener: noop, createElement: el,
      querySelector: () => el(), querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    location: { hash: "#/", href: "https://example.test/" },
    history: { replaceState: noop, pushState: noop },
    CSS: { escape: (s) => String(s) },
    URL, Math, Date, JSON, Promise, setTimeout, clearTimeout,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;

  vm.createContext(ctx);
  // Unhandled rejection from the parked init() must not kill the test run.
  process.on("unhandledRejection", noop);
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  return ctx;
}

const app = loadApp();

/* ---------- esc(): the HTML-escaping primitive ---------- */

test("esc is reachable and is a function", () => {
  assert.strictEqual(typeof app.esc, "function");
});

test("esc escapes every character that can break out of an HTML context", () => {
  assert.strictEqual(app.esc("&"), "&amp;");
  assert.strictEqual(app.esc("<"), "&lt;");
  assert.strictEqual(app.esc(">"), "&gt;");
  assert.strictEqual(app.esc('"'), "&quot;");
  assert.strictEqual(app.esc("'"), "&#39;");
});

test("esc neutralises a script-tag injection", () => {
  const out = app.esc('<script>alert(1)</script>');
  assert.ok(!out.includes("<script"), "raw <script must not survive escaping");
  assert.strictEqual(out, "&lt;script&gt;alert(1)&lt;/script&gt;");
});

test("esc neutralises an attribute-breakout payload", () => {
  // The realistic feed-data attack: close the attribute, add a handler.
  const out = app.esc('" onerror="alert(1)');
  assert.ok(!out.includes('"'), "no raw double quote may survive");
  assert.strictEqual(out, "&quot; onerror=&quot;alert(1)");
});

test("esc escapes ampersands first, so entities are not double-decodable", () => {
  // If & were escaped last, "&lt;" would come back out as a literal "<".
  assert.strictEqual(app.esc("&lt;"), "&amp;lt;");
});

test("esc coerces null and undefined to empty string, not the words", () => {
  assert.strictEqual(app.esc(null), "");
  assert.strictEqual(app.esc(undefined), "");
});

test("esc stringifies non-strings rather than throwing", () => {
  assert.strictEqual(app.esc(42), "42");
  assert.strictEqual(app.esc(0), "0");
  assert.strictEqual(app.esc(false), "false");
});

/* ---------- safeUrl(): the URL-scheme gate ---------- */

test("safeUrl is reachable and is a function", () => {
  assert.strictEqual(typeof app.safeUrl, "function");
});

test("safeUrl passes through http and https unchanged", () => {
  assert.strictEqual(app.safeUrl("https://example.com/a?b=c"), "https://example.com/a?b=c");
  assert.strictEqual(app.safeUrl("http://example.com/"), "http://example.com/");
});

test("safeUrl rejects every scheme that can execute", () => {
  for (const bad of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "blob:https://example.com/uuid",
  ]) {
    assert.strictEqual(app.safeUrl(bad), "#", `${bad} must be neutralised`);
  }
});

test("safeUrl rejects malformed and empty input rather than passing it through", () => {
  for (const bad of ["", "   ", "not a url", "//protocol-relative", null, undefined]) {
    assert.strictEqual(app.safeUrl(bad), "#");
  }
});

test("safeUrl does not attempt to sanitise — it either allows or replaces", () => {
  // A rejected URL must become exactly "#", never a partially-cleaned string
  // that a caller might mistake for safe.
  assert.strictEqual(app.safeUrl("javascript:alert(1)"), "#");
});

/* ---------- static invariants (CLAUDE.md § Conventions) ----------
   "All escaping in app.js goes through esc(); all href/src through safeUrl().
    The page has a strict CSP — no inline styles/scripts."
   Enforced by nothing until now. */

test("every interpolated href and src passes through safeUrl", () => {
  const attrs = SRC.match(/\b(?:href|src)\s*=\s*"\$\{[^}]*\}/g) || [];
  assert.ok(attrs.length > 0, "expected at least one interpolated href/src to guard");
  const unguarded = attrs.filter((a) => !a.includes("safeUrl("));
  assert.deepStrictEqual(
    unguarded, [],
    "these href/src interpolations bypass safeUrl():\n" + unguarded.join("\n")
  );
});

test("no inline style attribute — the CSP has style-src 'self'", () => {
  const hits = SRC.match(/\bstyle\s*=\s*["'`]/g) || [];
  assert.deepStrictEqual(hits, [], "inline style attributes are blocked by the page CSP");
});

test("no inline script tag is ever constructed", () => {
  const hits = SRC.match(/<script\b/gi) || [];
  assert.deepStrictEqual(hits, [], "the CSP is script-src 'self'; inline scripts cannot run");
});

test("no javascript: URL is constructed anywhere in the source", () => {
  const hits = SRC.match(/javascript\s*:/gi) || [];
  assert.deepStrictEqual(hits, []);
});

test("localStorage keys keep the legacy cp_ prefix", () => {
  // CLAUDE.md: renaming these wipes existing user state. A rename is a silent,
  // unrecoverable data loss for every current user, so it is worth a gate.
  const keys = [...SRC.matchAll(/\bls(?:Get|Set)\(\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 0, "expected localStorage usage to guard");
  const bad = keys.filter((k) => !k.startsWith("cp_"));
  assert.deepStrictEqual(bad, [], "localStorage keys must keep the cp_ prefix");
});

/* ---------- smoke ----------
   Not a substitute for real render coverage; see the header. This only proves
   the escaping primitives compose the way the render path assumes. */

test("smoke: esc(safeUrl(x)) is the composition used at every href site", () => {
  const hostile = 'javascript:alert(1)"onload="alert(2)';
  const rendered = app.esc(app.safeUrl(hostile));
  assert.strictEqual(rendered, "#");
  assert.ok(!rendered.includes('"'));
});
