/* Async work knows which page asked for it — audit 2026-09-22, theme B.
 *
 * Guards asked "is SOMETHING still on screen?" rather than "is this still the
 * page that asked?", and every one of these defects is that confusion:
 *
 *  1. Show A's episodes, description and count painted onto show B's page,
 *     because every show page has a `[data-show-episodes]` (qa 83, qa 114).
 *  2. Leaving and re-entering #/shows did not supersede the old page's search
 *     passes, so "radio" results painted under an empty field (qa 84).
 *  3. A refresh that succeeded left "couldn't refresh just now" on screen,
 *     because `anyStale` was sticky and the unchanged-list return skipped the
 *     label (qa 85).
 *  4. The Foray page's "Show more" toggled N times per tap after N visits,
 *     because each render added a listener to the persistent #view (qa 82).
 *  5. A foreground directory refresh re-rendered the whole show/Foray page
 *     under the listener even when nothing it shows had changed (qa 86).
 *  6. The stale-shell bar came back after ×, once per code file (qa 87).
 *
 * THE HARNESS IS DELIBERATELY UNFORGIVING in the one way that matters here:
 * `$("#view [data-show-episodes]")` answers with the SAME element whichever
 * show page is up — exactly what the browser does, and exactly what made the
 * presence check pass for the wrong page. A fake that returned null after a
 * navigation would have hidden defect 1.
 *
 * Every test names the mutation that kills it.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");

process.on("unhandledRejection", () => {});

function makeEl(tag) {
  const heard = [];
  return {
    tagName: String(tag || "div").toUpperCase(),
    id: null, className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {}, children: [], heard,
    parentNode: null,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, fn) { heard.push([type, fn]); }, removeEventListener() {},
    appendChild(k) { this.children.push(k); k.parentNode = this; return k; },
    append(...k) { for (const c of k) this.appendChild(c); },
    insertBefore(k) { return this.appendChild(k); },
    removeChild(k) { this.children = this.children.filter((c) => c !== k); k.parentNode = null; return k; },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {}, click() {}, remove() {},
  };
}

function mount({ hash = "#/" } = {}) {
  const els = new Map();
  const body = makeEl("body");
  /* Any selector answers with ONE element per selector string, created on first
     ask and kept — so a region looked up on page B is the same object page A's
     late callback would write to, as in a browser. `#shell-notice` is the one
     exception: it exists only once the app has put it in the body. */
  const el = (sel) => {
    if (!els.has(sel)) { const e = makeEl("div"); e.id = sel; els.set(sel, e); body.appendChild(e); }
    return els.get(sel);
  };
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),
    localStorage: { get length() { return 0; }, key: () => null, getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      body, documentElement: body, readyState: "complete",
      addEventListener() {}, createElement: (t) => makeEl(t),
      querySelector: (sel) => {
        const s = String(sel);
        if (s === "#shell-notice") return body.children.find((c) => c.id === "shell-notice") || null;
        if (s === "#shell-notice-dismiss" || s === "#shell-notice-reload") return el(s);
        return s.startsWith("#") ? el(s) : null;
      },
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    addEventListener() {}, removeEventListener() {},
    location: { hash, search: "", pathname: "/", href: "https://x.test/" + hash },
    history: { state: null, replaceState(st) { this.state = st; }, back() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    requestAnimationFrame: (fn) => { const t = setTimeout(fn, 0); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
    scrollTo() {},
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  const evalIn = (src) => vm.runInContext(src, ctx);
  evalIn(`state.ready = true;
    state.session = { session_id: 's', episodes: {}, cards: [], commute: {} };
    state.discover = { items: [] }; state.taxonomy = { nodes: [] };
    state.catalog = { shows: [
      { show_id: "show-a", title: "Show A", taxonomy_node_ids: [] },
      { show_id: "show-b", title: "Show B", taxonomy_node_ids: [] },
    ] };`);
  return { ctx, evalIn, el, body, go(h) { ctx.location.hash = h; evalIn("renderCurrentPage()"); } };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/* ==================================================================== */
/* 1. A LATE FETCH FOR SHOW A NEVER PAINTS INTO SHOW B                    */
/* ==================================================================== */

test("show A's late episode fetch does not paint into show B's page", async () => {
  /* MUTATION: restore `const stillMounted = () => !!container();` — A's
     episode title lands in the container B is using. */
  const m = mount();
  const pending = {};
  m.ctx.fetchShowEpisodes = (id) => new Promise((r) => { pending[id] = r; });
  m.ctx.cachedShowEpisodes = () => null;
  m.ctx.cacheShowEpisodes = () => {};
  m.go("#/show/show-a");
  m.go("#/show/show-b");                      // navigated on before A answered
  pending["show-a"]({ episodes: [{ guid: "a1", title: "An episode of A", audio_url: "https://a.test/1.mp3" }], nextCursor: null });
  await tick();
  const list = m.el("#view [data-show-episodes]").innerHTML;
  assert.ok(!list.includes("An episode of A"), `A's episode painted onto B: ${list.slice(0, 200)}`);
  pending["show-b"]({ episodes: [{ guid: "b1", title: "An episode of B", audio_url: "https://b.test/1.mp3" }], nextCursor: null });
  await tick();
  assert.ok(m.el("#view [data-show-episodes]").innerHTML.includes("An episode of B"), "B's own answer still paints");
});

/* ==================================================================== */
/* 2. RE-ENTERING #/shows SUPERSEDES THE OLD PAGE'S SEARCH                 */
/* ==================================================================== */

test("a pass started before #/shows was re-entered cannot paint onto the new page", () => {
  /* MUTATION: drop `supersedeShowSearch()` from renderAllShows — the old
     token is still current and the "radio" row paints. */
  const m = mount({ hash: "#/shows" });
  m.evalIn("renderAllShows()");
  const stale = m.evalIn("++showSearchToken");  // a pass the old page started
  m.evalIn("renderAllShows()");                  // left and came back
  m.evalIn(`paintShowResults("radio", [{ show_id: "r1", title: "Radio Show" }], ${stale})`);
  assert.ok(!m.el("#sh-results").innerHTML.includes("Radio Show"), "a superseded pass painted onto the fresh page");
});

/* ==================================================================== */
/* 3. A SUCCESSFUL REFRESH CLEARS "COULDN'T REFRESH"                      */
/* ==================================================================== */

test("a refresh that succeeds and agrees clears the stale label", async () => {
  /* MUTATION: restore the bare `return` on the unchanged-list path (or make
     anyStale sticky again) — the label keeps "couldn't refresh just now". */
  const m = mount();
  const eps = [{ guid: "g1", title: "Ep", audio_url: "https://a.test/1.mp3" }];
  let answer;
  m.ctx.cachedShowEpisodes = () => ({ episodes: eps, nextCursor: null, stale: true, show: null });
  m.ctx.cacheShowEpisodes = () => {};
  m.ctx.fetchShowEpisodes = () => new Promise((r) => { answer = r; });
  m.go("#/show/show-a");
  assert.match(m.el("#view [data-show-count]").textContent, /couldn't refresh/, "the cached stale list says so first");
  answer({ episodes: eps, nextCursor: null, stale: false });
  await tick();
  assert.doesNotMatch(m.el("#view [data-show-count]").textContent, /couldn't refresh/);
});

/* ==================================================================== */
/* 4. "SHOW MORE" TOGGLES ONCE PER TAP, HOWEVER MANY VISITS                */
/* ==================================================================== */

test("the Foray script toggle is one delegated listener, bound once — renderForay adds none", () => {
  /* Behaviour first: one click opens, a second closes. Then the binding: the
     handler is bound in exactly one place, and it is not in renderForay (the
     render that runs on every visit). MUTATION: call a #view click binding from
     renderForay again — the structural assertion fails. */
  const m = mount();
  let expanded = "false";
  let label = "Show more";
  const text = { classList: { toggle() {} } };
  m.ctx.document.querySelector = (sel) => (sel === "#view" ? { querySelector: () => text } : null);
  const btn = {
    dataset: { scriptFor: "s1" },
    getAttribute: () => expanded,
    setAttribute: (_k, v) => { expanded = v; },
    set textContent(v) { label = v; },
  };
  const click = () => m.ctx.onForayScriptClick({ target: { closest: () => btn }, preventDefault() {}, stopPropagation() {} });
  click();
  assert.strictEqual(expanded, "true");
  assert.strictEqual(label, "Show less");
  click();
  assert.strictEqual(expanded, "false");

  const code = APP_SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const binds = code.match(/addEventListener\("click", onForayScriptClick\)/g) || [];
  assert.strictEqual(binds.length, 1, "bound exactly once");
  const renderForay = code.slice(code.indexOf("async function renderForay("), code.indexOf("\nfunction ", code.indexOf("async function renderForay(")));
  assert.ok(!/\$\("#view"\)\.addEventListener/.test(renderForay) && !/view\.addEventListener/.test(renderForay),
    "renderForay must not add listeners to the persistent #view");
});

/* ==================================================================== */
/* 5. A FOREGROUND REFRESH LEAVES AN UNCHANGED PAGE ALONE                 */
/* ==================================================================== */

test("an adopted directory set that changes nothing on this show page does not re-render it", async () => {
  /* MUTATION: restore `if (isForaySurface(location.hash)) renderCurrentPage();`
     — the page is rebuilt under the listener. */
  const m = mount({ hash: "#/show/show-a" });
  m.evalIn("state.forays = { version: 1, forays: [] };");
  let rendered = 0;
  m.ctx.renderCurrentPage = () => { rendered++; };
  m.ctx.forayDirectory = { boot() {}, refresh: async () => ({ status: "adopted", set: { forays: { version: 2, forays: [] } } }) };
  await m.evalIn('refreshForayDirectory("foreground")');
  assert.strictEqual(rendered, 0, "nothing this page shows changed, so nothing moves");
});

test("when the set DOES change a show page, only its Foray footer is repainted", async () => {
  /* MUTATION: have repaintForaySurface call renderCurrentPage() on show pages. */
  const m = mount({ hash: "#/show/show-a" });
  m.evalIn("state.forays = { version: 1, forays: [] };");
  let rendered = 0;
  m.ctx.renderCurrentPage = () => { rendered++; };
  m.ctx.showForaysHtml = () => (m.evalIn("state.forays.version") === 2 ? "<footer>new</footer>" : "");
  m.ctx.forayDirectory = { boot() {}, refresh: async () => ({ status: "adopted", set: { forays: { version: 2, forays: [] } } }) };
  await m.evalIn('refreshForayDirectory("foreground")');
  assert.strictEqual(rendered, 0, "the page itself is not rebuilt");
  assert.strictEqual(m.el("#view [data-show-forays]").innerHTML, "<footer>new</footer>");
});

/* ==================================================================== */
/* 6. A DISMISSED SHELL NOTICE STAYS DISMISSED                           */
/* ==================================================================== */

test("the stale-shell bar stays gone after ×, however many code files report", () => {
  /* MUTATION: drop `|| shellNoticeDismissed` from showShellNotice's guard. */
  const m = mount();
  m.ctx.showShellNotice("stale-shell");
  const bar = m.body.children.find((c) => c.id === "shell-notice");
  assert.ok(bar, "the first report shows the bar");
  const dismiss = m.el("#shell-notice-dismiss");
  const onDismiss = dismiss.heard.find(([t]) => t === "click")[1];
  onDismiss();
  assert.ok(!m.body.children.includes(bar), "× removes it");
  m.ctx.showShellNotice("stale-shell");         // the next code file's message
  assert.ok(!m.body.children.some((c) => c.id === "shell-notice"), "it must not come back this page load");
});
