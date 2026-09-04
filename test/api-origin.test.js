/* The full-catalogue endpoint is asked for at an ABSOLUTE origin the CSP names.
 *
 * Stage 3b (#429) shipped api/shows/[show_id]/episodes so a show page can
 * list a show's whole feed, and app.js called it with a RELATIVE path. That
 * reaches the function only when the page itself is served from the Vercel
 * deployment — which no listener's page is: GitHub Pages (jwlabs.ai/4a)
 * answers 404, and the native shell's origin is `capacitor://localhost`,
 * where `api/shows/x/episodes` resolves to a file inside the bundle that does
 * not exist. Measured 2026-09-04: every show page in the shell silently fell
 * back to the bundled three-per-show slice, so nothing the founder adds to
 * the catalogue was visible in the app. Two client-side causes, one string
 * each:
 *
 *  1. the request URL must be absolute, on API_ORIGIN (app.js)
 *  2. index.html's `connect-src` must name that origin, or the browser blocks
 *     the fetch before it is sent — and app.js swallows that into the same
 *     silent fallback
 *
 * A third cause lives outside the client and is NOT fixed by this suite:
 * the deployed function must answer, and answer with CORS headers for the
 * shell's origin. See the PR that added this file.
 *
 * WHAT THIS PROVES
 *  1. under capacitor://localhost, fetchShowEpisodes asks API_ORIGIN, not the
 *     bundle
 *  2. the CSP's connect-src carries exactly API_ORIGIN — the same string, so
 *     the two cannot drift apart — and nothing broader (no `https:`)
 *  3. API_ORIGIN is an https origin with no path, so `apiUrl` cannot build a
 *     URL with a doubled or missing slash
 *  4. the Shows search (fetchApiJson) is deliberately still relative — see
 *     the privacy-policy promise its comment cites; changing it is a
 *     founders' decision, and this test makes that a visible one
 *
 * Every test names its mutation. All were run.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const INDEX = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

process.on("unhandledRejection", () => {});

function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(), id: "", className: "", innerHTML: "", textContent: "",
    value: "", hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    appendChild(k) { this.children.push(k); return k; }, append(...k) { this.children.push(...k); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    focus() {}, select() {}, click() {}, remove() {},
  };
}

/* The shell: origin capacitor://localhost, every fetch captured. */
function mountShell() {
  const calls = [];
  const byId = new Map(["view", "drawer", "drawer-overlay", "drawer-playlists", "menu-btn", "refresh-btn", "banner-slot"]
    .map((id) => { const el = makeEl("div"); el.id = id; return [id, el]; }));
  const body = makeEl("body");
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: (url) => { calls.push(String(url)); return new Promise(() => {}); },
    localStorage: { get length() { return 0; }, key: () => null, getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      body, documentElement: body, readyState: "complete", addEventListener() {}, createElement: (t) => makeEl(t),
      querySelector: (sel) => { const s = String(sel); return s.startsWith("#") ? byId.get(s.slice(1)) ?? null : null; },
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15" },
    addEventListener() {}, removeEventListener() {},
    location: { hash: "#/", search: "", pathname: "/", href: "capacitor://localhost/", origin: "capacitor://localhost", protocol: "capacitor:" },
    history: { back() {}, replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  calls.length = 0; // init()'s own data fetches are not what is under test
  return { ctx, calls };
}

const apiOrigin = () => /const API_ORIGIN = "([^"]+)"/.exec(APP_SRC)?.[1];
const connectSrc = () => {
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(INDEX);
  assert.ok(csp, "index.html's CSP meta tag could not be located");
  const d = /connect-src ([^;"]*)/.exec(csp[1]);
  assert.ok(d, "the CSP has no connect-src");
  return d[1].trim().split(/\s+/);
};

/* 1 */
test("under capacitor://localhost, fetchShowEpisodes asks API_ORIGIN — never a path inside the bundle", () => {
  /* MUTATION: put fetchShowEpisodes back on the relative path
     (`fetch(pinnedUrl(\`api/shows/...\`))`). The captured URL is then
     `api/shows/my-show/episodes`, which under the shell's origin is
     capacitor://localhost/api/shows/my-show/episodes — a file that does not
     exist — and the startsWith assertion fails. */
  const origin = apiOrigin();
  assert.ok(origin, "app.js declares API_ORIGIN");
  const m = mountShell();
  m.ctx.fetchShowEpisodes("my-show");
  assert.strictEqual(m.calls.length, 1, `exactly one request, got: ${m.calls.join(" | ")}`);
  assert.ok(m.calls[0].startsWith(`${origin}/api/shows/my-show/episodes`), `absolute on API_ORIGIN, got: ${m.calls[0]}`);
  assert.ok(!m.calls[0].includes("_fdid="), "a live function is not pinned to a data deploy generation");
  assert.strictEqual(new URL(m.calls[0], "capacitor://localhost/").origin, origin,
    "resolved against the shell's own origin it still leaves the bundle");
});

/* 2 */
test("index.html's connect-src names exactly API_ORIGIN — the same string as app.js — and nothing broader", () => {
  /* MUTATION: remove `https://foray-web-seven.vercel.app` from connect-src in
     index.html (the request is then blocked before it is sent, and app.js
     swallows that into the silent fallback). Or widen it to `https:` — the
     second assertion. Or change API_ORIGIN alone — the first. */
  const origin = apiOrigin();
  const sources = connectSrc();
  assert.ok(sources.includes(origin), `connect-src must name ${origin}; it names: ${sources.join(" ")}`);
  assert.ok(!sources.some((s) => /^https?:$/.test(s) || s === "*"), `connect-src must not be widened past named origins: ${sources.join(" ")}`);
  assert.strictEqual(sources.length, 3, `'self', Supabase and the API host — nothing else. Got: ${sources.join(" ")}`);
});

/* 3 */
test("API_ORIGIN is an https origin with no path, and apiUrl joins it with exactly one slash", () => {
  /* MUTATION: give API_ORIGIN a trailing slash, or an http scheme. */
  const origin = apiOrigin();
  const u = new URL(origin);
  assert.strictEqual(u.protocol, "https:", "the shell's CSP allows no plaintext connect target, and neither should this");
  assert.strictEqual(u.origin, origin, `API_ORIGIN must be a bare origin (no path, no trailing slash): ${origin}`);
  const m = mountShell();
  assert.strictEqual(m.ctx.apiUrl("api/x"), `${origin}/api/x`);
  assert.strictEqual(m.ctx.apiUrl("/api/x"), `${origin}/api/x`, "a leading slash is not doubled");
});

/* 4 */
test("the Shows search still goes to the page's own origin — a deliberate, documented hold, not the same fix forgotten", () => {
  /* This is a pin on a DECISION. privacy-policy.md §2 promises that nothing
     typed into the Shows search box is transmitted; routing fetchApiJson to
     API_ORIGIN would make that untrue in the shell, and that is the founders'
     call. When they make it, change this test with the policy.
     MUTATION: route fetchApiJson through apiUrl(). The captured URL then
     starts with API_ORIGIN. */
  const m = mountShell();
  m.ctx.fetchApiJson("api/shows/search?q=typed&limit=25");
  assert.strictEqual(m.calls.length, 1);
  assert.ok(!m.calls[0].startsWith(apiOrigin()), `fetchApiJson must stay relative until the privacy policy changes; got: ${m.calls[0]}`);
  assert.ok(/Nothing you type into the playlist box or the Shows search box is transmitted/.test(fs.readFileSync(path.join(ROOT, "docs/legal/privacy-policy.md"), "utf8").replace(/\s+/g, " ")),
    "the promise this hold rests on is still in the policy — if it went, this test should go with it");
});
