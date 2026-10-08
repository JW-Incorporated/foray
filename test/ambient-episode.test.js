/* Redesign 2026, ambient direction: the Episode page (#/episode/<id>), the fourth screen on the Afterglow system
 * (docs/redesign-2026/directions/ambient/BUILD-PLAN.md item 11, BUILD-NOTES 4.6 and 4.7).
 *
 * WHAT THIS PROVES, in the order the page reads:
 *   1. The stylesheet is wired into the page and every shipping path, scoped under `.ag` and `body.view-episode`, and owns
 *      no reduced-motion block and no transition or animation of its own.
 *   2. The page, rendered by the REAL app.js: a 160 lit artwork, the title in --t-title (three lines), the show caption, the
 *      italic why-line, and every interpolation through esc() / every URL through safeUrl().
 *   3. The controls: a 48 primary Play, Save (bookmark, Fill when saved) and Add to Up Next (queue, check-circle Fill when in
 *      Up Next) as 44 targets; Save and Up Next repaint as a NEW button (no colour crossfade under Reduce Motion).
 *   4. The Up Next add: the art flies to the Library tab and its count badge bumps; under Reduce Motion neither happens and the
 *      count alone changes. The count is the length of Up Next, on every page, and never breaks a queue write.
 *   5. The show notes: a four-line clamp with a More button that appears only when the text runs over, timestamp Chips that
 *      are 44px to hit, chapter rows that are 44px to hit.
 *   6. The title never cut mid-word: a word wider than the box shrinks the type to a 17px floor; a title past three lines ends
 *      on a word, with the whole title still in the text.
 *
 * Every test names the one-line mutation that turns it red; each was run red before it was run green. The floor for this
 * suite lives in test/suite-integrity.test.js.
 *
 * Harness: the REAL app.js in a node:vm over the shared small DOM (test/helpers/fake-dom.js).
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");
const { El } = require("./helpers/fake-dom.js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const APP_SRC = readAppSource();
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, " ");
const CSS = stripComments(read("ui/episode.css"));
const PRIMITIVES = stripComments(read("ui/primitives.css"));
const TOKENS = stripComments(read("ui/tokens.css"));

process.on("unhandledRejection", () => {});

/* The fake DOM has no replaceWith (every browser does): the page's tools repaint by replacing a node. */
El.prototype.replaceWith = function replaceWith(next) { const p = this.parent; const i = p.children.indexOf(this); p.children[i] = next; next.parent = p; this.parent = null; };

/** The declarations of the rule whose selector list is exactly `sel`, merged over every occurrence, as { prop: value }. */
function declsAll(css, sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[};])\\s*${esc}\\s*\\{([^{}]*)\\}`, "g");
  const out = {};
  for (const m of css.matchAll(re)) for (const d of m[1].split(";")) { const c = d.indexOf(":"); if (c > 0) out[d.slice(0, c).trim()] = d.slice(c + 1).trim(); }
  return out;
}

/* ---------- 1. wiring and scope ---------- */

test("the stylesheet is wired into the page and every shipping path", async () => {
  /* MUTATION: remove "ui/episode.css" from SHELL in tools/web/prepare-dist.mjs (or tools/ci/generate-manifest.mjs, or SHELL_FILES
     in tools/mobile/prepare-webdir.mjs), or drop the <link> from index.html -> red, naming the path. */
  const html = read("index.html");
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  assert.ok(links.includes("ui/episode.css") && links.indexOf("ui/episode.css") > links.indexOf("ui/primitives.css"), "linked after the primitives it reads");
  const shell = (rel, re) => { const m = re.exec(read(rel)); assert.ok(m, `${rel}: shell list found`); return m[1]; };
  assert.match(shell("tools/ci/generate-manifest.mjs", /const SHELL = \[([\s\S]*?)\n\];/), /"ui\/episode\.css"/, "generate-manifest SHELL");
  assert.match(shell("tools/web/prepare-dist.mjs", /const SHELL = \[([\s\S]*?)\n\];/), /"ui\/episode\.css"/, "prepare-dist SHELL");
  const pw = await import(pathToFileURL(path.join(ROOT, "tools", "mobile", "prepare-webdir.mjs")).href);
  assert.ok(pw.SHELL_FILES.includes("ui/episode.css"), "prepare-webdir SHELL_FILES");
  assert.ok(pw.buildPlan(ROOT).includes("ui/episode.css"), "the app bundle's copy plan carries it");
});

test("the stylesheet is scoped, loads nothing, owns no reduced-motion block and no motion of its own", () => {
  /* The page cannot restyle any other screen, and a second reduced-motion block would be a second owner (ui/tokens.css has the
     one, scoped to .ag). The only motion on the page is script's, and it asks the media query itself.
     MUTATION: add a bare `.play-btn { … }` rule -> red. MUTATION 2: add `@media (prefers-reduced-motion: reduce)` -> red.
     MUTATION 3: add `transition: color 1s` -> red. MUTATION 4: add an @import or a url(...) -> red. */
  const flat = CSS.replace(/@(?:media|supports)[^{]*\{/g, "{");
  const heads = [...flat.matchAll(/(?:^|[}])\s*([^{}@][^{}]*)\{/g)].map((m) => m[1].trim()).filter(Boolean);
  const splitList = (list) => { const out = []; let depth = 0, cur = ""; for (const ch of list) { if (ch === "(") depth++; if (ch === ")") depth--; if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch; } out.push(cur.trim()); return out; };
  for (const list of heads) {
    for (const sel of splitList(list)) {
      /* `.tab-btn` / `.tab-count`: the Library tab's Up Next count lives on the tab bar, which is outside `.ag`. */
      assert.ok(/^(\.ag\b|body\.view-episode\b|\.page\.ep-page\b|\.tab-btn\b)/.test(sel), `unscoped selector: ${sel}`);
    }
  }
  assert.ok(heads.length >= 40, `fixture assumption: the sheet has its rules (${heads.length})`);
  assert.doesNotMatch(CSS, /prefers-reduced-motion/, "the one block is tokens.css's");
  assert.doesNotMatch(CSS, /@import|url\(/, "no font, no image, no origin");
  assert.doesNotMatch(CSS.replace(/transition:\s*none\s*!important/g, ""), /(?:^|[;{\s])(?:transition|animation)\s*:|@keyframes/, "no motion declared here: tokens.css owns it (the first-paint `transition: none` is the one allowance)");
  assert.strictEqual((CSS.match(/!important/g) || []).length, 1, "nothing wins by force but the one first-paint rule");
});

/* ---------- 2. the page, rendered by the real app.js ---------- */

function mount({ hash = "#/", player = {}, reduced = false } = {}) {
  const body = new El("body");
  const view = new El("main"); view.id = "view"; body.appendChild(view);
  for (const id of ["drawer", "drawer-overlay", "menu-btn", "refresh-btn", "drawer-playlists"]) {
    const e = new El("div"); e.id = id; body.appendChild(e);
  }
  const bar = new El("nav"); bar.id = "tab-bar"; body.appendChild(bar);
  const tab = new El("a"); tab.className = "tab-btn"; tab.dataset.tabKey = "library"; tab.attrs["data-tab-key"] = "library"; bar.appendChild(tab);
  const icon = new El("svg"); tab.appendChild(icon);
  const store = new Map();
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),
    localStorage: {
      get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); },
    },
    document: {
      body, documentElement: body, readyState: "complete", hidden: false, activeElement: null,
      addEventListener() {}, removeEventListener() {}, createElement: (t) => new El(t),
      querySelector: (s) => {
        const str = String(s).trim();
        if (str === "#view") return view;
        if (str.startsWith("#view ")) return view.querySelector(str.slice(6));
        return body.querySelector(str);
      },
      querySelectorAll: (s) => body.querySelectorAll(s),
    },
    navigator: { userAgent: "node", onLine: true },
    addEventListener() {}, removeEventListener() {},
    matchMedia: (q) => ({ matches: reduced && /reduce/.test(q) }),
    location: { hash, search: "", pathname: "/", href: "https://x.test/", protocol: "https:", reload() {} },
    history: { replaceState() {}, pushState() {}, back() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout, queueMicrotask,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  ctx.ForayPlayer = { isPlaying: () => false, isCurrent: () => false, canPlay: () => true, togglePlayback: async () => {}, ...player };
  vm.createContext(ctx);
  runAppSource(APP_SRC, ctx);
  const state = vm.runInContext("state", ctx);
  state.ready = true;
  state.session = { session_id: "s", builder: "t", episodes: {}, cards: [] };
  state.discover = { items: [] };
  state.catalog = { shows: [] };
  return { ctx, state, view, body, bar, tab, store, html: () => view.innerHTML, queue: () => JSON.parse(store.get("cp_queue") || "[]"), saved: () => Object.keys(JSON.parse(store.get("cp_saved") || "{}")) };
}

const EP = {
  id: "ep-1", title: "Cooling factories without wasting water", show: "The Indicator", duration_min: 42, hook: "A plant engineer on how heat leaves a factory.",
  audio_url: "https://example.com/a.mp3", artwork_url: "https://example.com/art.png", explicit: false,
};
function open(m, item = EP, opts) {
  m.state.itemIndex[item.id] = { ...item };
  m.ctx.renderEpisode(item.id, opts);
  return m;
}

test("the page is a Room with a 160 lit artwork, the title, the show caption and the why-line, in that order, wearing the type styles", () => {
  /* BUILD-PLAN 11: art 160 Lit, `--t-title` three-line clamp, show caption, italic why-line. The title is the page's heading
     (data-page-heading) so the router can name it, and it still holds the whole title in its text.
     MUTATIONS: `ag-art-160` -> 120 (size: 160 -> 120 in the template) -> red; clamp3 -> clamp4 -> red; drop `state: "lit"` -> red;
     swap the caption and the why-line -> red; drop data-page-heading -> red. */
  const m = open(mount());
  const html = m.html();
  const order = ["ep-room", "ep-top", "ep-hero", "ep-title", "ep-caption", "ep-reason", "ep-actions"].map((c) => html.indexOf(` ${c}`) >= 0 ? html.indexOf(` ${c}`) : html.indexOf(`"${c}`));
  assert.ok(order.every((i) => i >= 0), `every piece is there: ${order}`);
  assert.deepStrictEqual([...order].sort((a, b) => a - b), order, "in reading order");
  assert.match(html, /<span class="ag-art ag-art-160 ag-tone-amber is-lit lit-art lit-64" role="img" aria-label="The Indicator">/, "the 160 artwork, lit by its own colour");
  assert.match(html, /<h1 class="t-title clamp3 ep-title" data-page-heading><span class="ep-title-text">Cooling factories without wasting water<\/span><\/h1>/);
  assert.match(html, /<p class="t-why clamp3 ep-reason">A plant engineer on how heat leaves a factory\.<\/p>/, "the why-line is the italic style");
  assert.match(html, /<p class="t-caption ep-caption">The Indicator · 42 min/, "the caption carries the show and the length");
  assert.ok(m.ctx.pageHeading(m.view), "pageHeading() finds the title: the route's focus and announcement land on it");
  assert.doesNotMatch(html, /style="/, "no inline style: the strict CSP forbids it");
  assert.ok(m.body.classList.contains("view-episode"), "the body wears the page's class (Dock, hidden top bar)");
});

test("every title, show name, hook and URL that reaches the page goes through esc() or safeUrl()", () => {
  /* MUTATION: interpolate `${item.title}` or `${item.hook}` raw in renderEpisode -> red. MUTATION 2: drop safeUrl from the
     artwork primitive's image source -> red (a javascript: URL would reach the src). */
  const hostile = { ...EP, id: "ep-x", title: "<img src=x onerror=alert(1)>", show: "<b>Show</b>", hook: "<script>1</script>", artwork_url: "javascript:alert(1)", description: "see javascript:alert(1) and https://ok.example/a\"onmouseover=\"x" };
  const m = open(mount(), hostile);
  const html = m.html();
  assert.doesNotMatch(html, /<img src=x|<script>1|<b>Show|(?:href|src)="javascript:/i, html.slice(0, 600));
  assert.match(html, /<img src="#" alt=""/, "a URL safeUrl refuses is no artwork");
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<a href="https:\/\/ok\.example\/a" target="_blank" rel="noopener noreferrer">/, "a quote in a URL ends the link; it cannot open an attribute");
  assert.doesNotMatch(html, /<a [^>]*onmouseover/, "…and no attribute named onmouseover exists");
});

/* ---------- 3. the controls ---------- */

test("Play is a 48 primary, Save and Up Next are 44 round targets; the glyphs are the sprite's", () => {
  /* MUTATIONS: `.ag-btn-primary { min-height: … }` -> 40px (primitives.css) -> red; `ag-btn-icon` -> `ag-btn-play` on a tool -> red;
     `--tap: 44px` -> 40px (tokens.css) -> red; the bookmark name -> "star" -> red. */
  const tok = (name) => { const m = new RegExp(`${name}:\\s*(\\d+)px`).exec(TOKENS); return m ? Number(m[1]) : null; };
  const tap = tok("--tap"), s1 = tok("--s-1");
  assert.strictEqual(tap, 44);
  assert.strictEqual(declsAll(PRIMITIVES, ".ag .ag-btn-primary")["min-height"], "calc(var(--tap) + var(--s-1))", "the primary: tap + 4");
  assert.strictEqual(tap + s1, 48, "= 48");
  assert.strictEqual(declsAll(PRIMITIVES, ".ag .ag-btn-icon").width, "var(--tap)");
  assert.strictEqual(declsAll(PRIMITIVES, ".ag .ag-btn-icon").height, "var(--tap)");
  const html = open(mount()).html();
  assert.match(html, /<button type="button" class="ag-btn ag-btn-primary ep-play" data-ep-play="ep-1" data-state="idle" aria-label="Play Cooling factories without wasting water"><svg[^>]*><use href="ui\/icons\.svg#i-play"/);
  assert.match(html, /class="ag-btn ag-btn-icon ep-tool" data-ep-save="ep-1" aria-label="Save episode"><svg[^>]*><use href="ui\/icons\.svg#i-bookmark"/);
  assert.match(html, /class="ag-btn ag-btn-icon ep-tool" data-ep-upnext="ep-1" aria-label="Add to Up Next"><svg[^>]*><use href="ui\/icons\.svg#i-queue"/);
  assert.match(html, /data-ep-playnext="ep-1">Play next<\/button>/);
});

test("an episode with no audio draws the honest note, no Play and no Up Next, and still offers Save", () => {
  /* MUTATION: drop the `playable` check around the Play button -> red (a button that does nothing). MUTATION 2: drop the
     `queueable` check -> red (an Up Next that addToQueue refuses). */
  const m = open(mount(), { ...EP, id: "ep-2", audio_url: null });
  const html = m.html();
  assert.doesNotMatch(html, /data-ep-play=|data-ep-upnext=|data-ep-playnext=/);
  assert.match(html, /<span class="not-playable">Not available to play<\/span>/);
  assert.match(html, /data-ep-save="ep-2"/);
});

test("Save is a bookmark that fills when saved, repainted as a new button that keeps the focus (no colour crossfade under Reduce Motion)", () => {
  /* The tokens turn every colour change into a 200ms crossfade under Reduce Motion, and the gate fails any that runs: a tool
     whose colour flips is REPLACED, drawn in its final state.
     MUTATION: repaint by `btn.classList.toggle("is-on")` and an innerHTML swap (the old node) -> the identity assertion fails.
     MUTATION 2: drop the focus hand-over -> red. MUTATION 3: Save does not call toggleStar -> the store assertion fails. */
  const m = open(mount());
  const save = m.view.querySelector("[data-ep-save]");
  m.ctx.document.activeElement = save;
  let focused = null;
  const realFocus = El.prototype.focus; El.prototype.focus = function focus() { focused = this; };
  try {
    save.click();
    assert.deepStrictEqual(m.saved(), ["ep-1"], "toggleStar wrote the save");
    const now = m.view.querySelector("[data-ep-save]");
    assert.notStrictEqual(now, save, "a NEW node, not a mutated one");
    assert.match(now.className, /is-on/);
    assert.strictEqual(now.getAttribute("aria-label"), "Saved");
    assert.match(now.querySelector("use").getAttribute("href"), /#i-bookmark-fill$/, "a fill, never only a colour");
    assert.strictEqual(focused, now, "the focus the old button held moves to the new one");
    now.click();
    assert.deepStrictEqual(m.saved(), [], "pressing again un-saves");
    assert.match(m.view.querySelector("[data-ep-save] use").getAttribute("href"), /#i-bookmark$/);
  } finally { El.prototype.focus = realFocus; }
});

test("Play starts this episode alone, and a button showing Pause pauses", async () => {
  /* MUTATION: drop the isCurrent branch -> pressing Pause restarts the episode (togglePlayback is never called); red.
     MUTATION 2: pass the page's rows as the play list -> the list assertion fails. */
  const calls = [];
  const m = mount({ player: { isCurrent: () => false, canPlay: () => true, play: async (...a) => { calls.push(["play", ...a]); return true; } } });
  open(m);
  let started = null;
  m.ctx.startEpisodePlay = async (id, item, opts) => { started = { id, opts }; return true; };
  vm.runInContext("startEpisodePlay = globalThis.startEpisodePlay", m.ctx);
  await m.view.querySelector("[data-ep-play]").click();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(started && started.id, "ep-1");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(started.opts)), { ctx: null, list: [{ id: "ep-1", ctx: null }] }, "alone: no list, no playlist context");
  let toggled = 0;
  const p = mount({ player: { isCurrent: () => true, isPlaying: () => true, canPlay: () => true, togglePlayback: async () => { toggled++; } } });
  open(p);
  p.view.querySelector("[data-ep-play]").click();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(toggled, 1, "the player's own item is paused, not restarted");
});

/* ---------- 4. the Up Next add and the Library tab's count ---------- */

function armFlight(m) {
  const art = m.view.querySelector(".ep-hero .ag-art");
  art.getBoundingClientRect = () => ({ left: 116, top: 60, width: 160, height: 160 });
  const flights = [];
  const animate = (frames, opts) => { const a = { frames, opts, onfinish: null, oncancel: null }; flights.push(a); return a; };
  art.animate = animate;
  art.cloneNode = () => { const c = new El("span"); c.className = art.className; c.attrs = { role: "img", "aria-label": "x" }; c.style = { props: {}, setProperty(k, v) { this.props[k] = v; } }; c.animate = animate; return c; };
  const icon = m.tab.children[0];
  icon.getBoundingClientRect = () => ({ left: 300, top: 780, width: 28, height: 28 });
  const bumps = [];
  const realAppend = m.tab.appendChild.bind(m.tab);
  m.tab.appendChild = (k) => { k.animate = (frames, opts) => { bumps.push({ frames, opts }); return {}; }; return realAppend(k); };
  m.ctx.getComputedStyle = () => ({ getPropertyValue: () => "" });
  return { flights, bumps, art };
}
const badgeText = (m) => { const b = m.tab.querySelector(".tab-count"); return b ? b.textContent : null; };

test("Add to Up Next: the art flies to the Library tab, and the count changes when it lands, then bumps 1 to 1.3 to 1", () => {
  /* BUILD-NOTES "Up Next add": the tapped art flies to the Library tab icon (FLIP), the badge scales 1 -> 1.3 -> 1, 420ms.
     MUTATION: never call land() from onfinish -> the count stays at its old value; red. MUTATION 2: drop the hold (set
     libraryBadgeHold = false in episodeUpNextAdd) -> the count is already 1 while the art is in the air; red. MUTATION 3: drop the
     badge.animate bump -> bumps stays empty; red. MUTATION 4: translate to the wrong target (the art's own rect) -> the
     transform assertion fails. */
  const m = open(mount());
  const { flights, bumps } = armFlight(m);
  m.view.querySelector("[data-ep-upnext]").click();
  assert.deepStrictEqual(m.queue(), ["ep-1"], "the add was written");
  assert.strictEqual(flights.length, 1, "one flight");
  const f = flights[0];
  assert.strictEqual(f.opts.duration, 420);
  assert.match(f.frames[1].transform, /translate\(184px, 720px\) scale\(0\.175\)/, "from the art's corner to the icon's: 300-116, 780-60, 28/160");
  assert.strictEqual(badgeText(m), null, "the count is held while the art is in the air");
  assert.ok(m.body.children.some((c) => /ep-flight-layer/.test(c.className)), "the clone sits in its own layer on the body, above the Dock");
  f.onfinish();
  assert.strictEqual(badgeText(m), "1", "it lands, the count goes up");
  assert.strictEqual(m.tab.getAttribute("aria-label"), "Library, 1 in Up Next", "the tab's name carries the count");
  assert.strictEqual(bumps.length, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(bumps[0].frames.map((x) => x.transform))), ["scale(1)", "scale(1.3)", "scale(1)"]);
  assert.ok(!m.body.children.some((c) => /ep-flight-layer/.test(c.className)), "the layer is gone");
  assert.match(m.view.querySelector("[data-ep-upnext] use").getAttribute("href"), /#i-check-circle-fill$/, "the control reads In Up Next as a fill");
});

test("under Reduce Motion the add is a count and nothing else: no flight, no bump", () => {
  /* MUTATION: drop the episodeReducedMotion() check from canFly -> a flight starts under Reduce Motion; red. */
  const m = open(mount({ reduced: true }));
  const { flights, bumps } = armFlight(m);
  m.view.querySelector("[data-ep-upnext]").click();
  assert.deepStrictEqual(m.queue(), ["ep-1"]);
  assert.strictEqual(flights.length, 0, "no flight");
  assert.strictEqual(badgeText(m), "1", "the count changed in place");
  assert.strictEqual(bumps.length, 0, "no bump");
  assert.ok(!m.body.children.some((c) => /ep-flight-layer/.test(c.className)));
});

test("a flight that never reports back still lands the count, and the layer goes (the safety timer)", async () => {
  /* MUTATION: delete the `setTimeout(() => land(true), 700)` line -> the count stays held for ever; red. */
  const m = open(mount());
  armFlight(m);
  m.view.querySelector("[data-ep-upnext]").click();
  assert.strictEqual(badgeText(m), null);
  await new Promise((r) => setTimeout(r, 760));
  assert.strictEqual(badgeText(m), "1");
});

test("the Library tab's count is the length of Up Next on every page: nothing at 0, 9+ past nine, and it never breaks a queue write", () => {
  /* MUTATION: show the badge at 0 -> red. MUTATION 2: drop the 9+ cap -> red. MUTATION 3: delete the try/catch in
     syncLibraryBadge -> the stub-tab assertion throws; red. MUTATION 4: delete the syncLibraryBadge call in saveQueueIds -> the
     add-from-anywhere assertion fails. */
  const m = mount();
  m.ctx.syncLibraryBadge();
  assert.strictEqual(badgeText(m), null, "no badge at 0");
  assert.strictEqual(m.tab.getAttribute("aria-label"), null);
  for (let i = 0; i < 10; i++) { m.state.itemIndex["q" + i] = { id: "q" + i, title: "t", show: "s", audio_url: "https://x.test/" + i + ".mp3" }; m.ctx.addToQueue("q" + i); }
  assert.strictEqual(badgeText(m), "9+", "added from anywhere (not the episode page): saveQueueIds repaints the count");
  m.ctx.removeFromQueue("q9");
  assert.strictEqual(badgeText(m), "9");
  for (let i = 0; i < 9; i++) m.ctx.removeFromQueue("q" + i);
  assert.strictEqual(badgeText(m), null, "and it goes with the last one");
  const stub = mount();
  /* a tab whose count node answers but whose attribute calls throw (no setAttribute): the badge is decoration */
  stub.ctx.document.querySelector = () => ({ getAttribute: () => null, querySelector: () => ({ textContent: "" }) });
  assert.doesNotThrow(() => { stub.state.itemIndex.z = { id: "z", title: "t", show: "s", audio_url: "https://x.test/z.mp3" }; stub.ctx.addToQueue("z"); });
  assert.deepStrictEqual(stub.queue(), ["z"], "the list is the truth");
});

/* ---------- 5. the show notes ---------- */

const NOTES = "Prose first.\n\n00:00 Cold open\n02:15 The instrument\n\nThe best bit starts at 31:20 if you are short of time. Paper: https://example.org/p";
test("the notes are a four-line clamp that fades and opens with More; the button exists only when the text runs over", () => {
  /* BUILD-NOTES 4.7: "4-line clamp + More quiet button". MUTATIONS: `--ep-notes-lines: 4` -> 6 (css) -> red; drop `is-clamped` from the
     markup -> red; show the button when the text fits (drop `more.hidden = !runs`) -> red; do not open on focus -> red;
     start aria-expanded="true" -> red. */
  assert.strictEqual(declsAll(CSS, ".ag .ep-description-text.is-clamped")["--ep-notes-lines"], "4");
  assert.match(declsAll(CSS, ".ag .ep-description-text.is-clamped")["max-height"], /^calc\(var\(--ep-notes-lines\) \* 1\.5rem\)$/, "four lines of --t-body's 1.5rem leading");
  assert.match(TOKENS, /--t-body:\s*400 1rem\/1\.5rem/, "fixture assumption: the body leading is 1.5rem");
  const layout = (scrollHeight) => {
    /* the fake DOM has no layout: the text box is 96 tall (four lines) and its content `scrollHeight` tall */
    Object.defineProperty(El.prototype, "isConnected", { configurable: true, get() { return true; } });
    Object.defineProperty(El.prototype, "clientHeight", { configurable: true, get() { return /ep-description-text/.test(this.className) ? 96 : 0; } });
    Object.defineProperty(El.prototype, "scrollHeight", { configurable: true, get() { return scrollHeight; } });
  };
  const unlayout = () => { for (const k of ["isConnected", "clientHeight", "scrollHeight"]) delete El.prototype[k]; };
  layout(300);
  const m = open(mount(), { ...EP, description: NOTES });
  const sec = m.view.querySelector(".ep-description");
  const text = sec.querySelector(".ep-description-text");
  const more = sec.querySelector(".ep-notes-more");
  assert.match(text.className, /is-clamped/);
  assert.strictEqual(more.getAttribute("aria-controls"), text.id);
  assert.strictEqual(more.getAttribute("aria-expanded"), "false");
  assert.strictEqual(more.hidden, false, "runs over: More is shown");
  assert.ok(text.classList.contains("is-faded"), "and the last line fades");
  more.click();
  assert.ok(!text.classList.contains("is-clamped"), "More opens it");
  assert.strictEqual(more.getAttribute("aria-expanded"), "true");
  assert.strictEqual(more.textContent, "Less");
  /* a text that fits has no button */
  layout(48);
  const fits = open(mount(), { ...EP, id: "ep-3", description: "Short." });
  assert.strictEqual(fits.view.querySelector(".ep-notes-more").hidden, true, "nothing to open");
  assert.ok(!fits.view.querySelector(".ep-description-text").classList.contains("is-faded"), "and nothing fades");
  /* a timestamp reached by keyboard opens it: nothing focusable is clipped */
  layout(300);
  const kb = open(mount(), { ...EP, id: "ep-4", description: NOTES });
  const t3 = kb.view.querySelector(".ep-description-text");
  assert.ok(t3.classList.contains("is-clamped"));
  const fire = (t3._on.get("focusin") || [])[0];
  assert.ok(fire, "a focusin handler is bound");
  fire();
  assert.ok(!t3.classList.contains("is-clamped"), "focus inside the clamp opens it");
  unlayout();
});

test("timestamps in the notes are Chips that seek, a stamp-led line is a 44px chapter row, a link is safeUrl'd, and the chip is 44px to hit", () => {
  /* The linkifier is pinned in test/episode-description-links.test.js; this pins the page's use of it and the sizes.
     MUTATION: `.ag .ep-ts::after` inset -12px -> -4px (the hit box falls under 44) -> red. MUTATION 2: `.ag .ep-chapter-row
     { min-height: var(--tap) }` -> 0 -> red. MUTATION 3: render the notes through esc() alone -> no data-ts; red. */
  const html = open(mount(), { ...EP, duration_min: 62, description: NOTES }).html();
  assert.match(html, /<button type="button" class="ep-ts" data-ts="1880" aria-label="Play from 31:20">31:20<\/button>/, "the inline stamp seeks");
  assert.match(html, /<button type="button" class="ep-chapter-row" data-ts="135" aria-label="Play from 02:15, The instrument">/, "a stamp-led line is a row");
  assert.match(html, /<a href="https:\/\/example\.org\/p" target="_blank" rel="noopener noreferrer">/);
  const hit = declsAll(CSS, ".ag .ep-ts::after");
  const inset = /^calc\(var\(--s-1\) \* -(\d+)\) calc\(var\(--s-1\) \* -(\d+)\)$/.exec(hit.inset);
  assert.ok(inset, `the hit box is an inset in spacing steps (${hit.inset})`);
  const lineBox = 14 * 1.302 + 2 * 0.09 * 14;   // the chip's own box: 14px DM Sans label, its content area plus 0.09em padding
  assert.ok(lineBox + 2 * Number(inset[1]) * 4 >= 44, `the chip's hit height ${(lineBox + 2 * Number(inset[1]) * 4).toFixed(1)}px reaches 44`);
  assert.strictEqual(declsAll(CSS, ".ag .ep-chapter-row")["min-height"], "var(--tap)");
});

/* ---------- 6. the title is never cut mid-word ---------- */

/** A title element the fitter can measure: width is what the size leaves, height is the line count the words make. */
function titleFixture({ words, perLine = 5, widthAt = (px) => px * 18, box = 343 }) {
  const el = new El("h1");
  const label = new El("span"); label.className = "ep-title-text"; label.textContent = words.join(" "); label.perLine = perLine;
  el.appendChild(label);
  el.vars = {};
  el.style = { setProperty(k, v) { el.vars[k] = v; }, removeProperty(k) { delete el.vars[k]; } };
  el.clientWidth = box;
  const px = () => (el.vars["--ep-title-size"] ? parseFloat(el.vars["--ep-title-size"]) * 16 : 26);
  Object.defineProperty(el, "scrollWidth", { get: () => widthAt(px()) });
  Object.defineProperty(el, "clientHeight", { get: () => 3 * 30 });
  const pieces = words.join(" ").split(/[ -]/).filter(Boolean).length;   // what the engine breaks lines at
  Object.defineProperty(el, "scrollHeight", { get: () => (el.classList.contains("is-trimmed") ? 3 * 30 : Math.ceil(pieces / perLine) * 30) });
  Object.defineProperty(El.prototype, "offsetTop", {
    configurable: true,
    get() {
      const sibs = this.parent ? this.parent.children : [];
      const i = sibs.indexOf(this);
      const per = this.parent && this.parent.perLine;
      const line = Math.floor(i / per);
      /* "word…" is a longer word: the last word on a line wraps down if it carries the ellipsis */
      return line * 30 + (this.classList.contains("ep-last") && (i + 1) % per === 0 ? 30 : 0);
    },
  });
  return { el, label, px };
}
const withFonts = (m) => { m.ctx.getComputedStyle = (node) => ({ fontSize: node === m.body ? "16px" : "26px" }); return m; };

test("a word wider than the box is not broken: the type steps down 1px at a time until it fits, to a 17px floor", () => {
  /* MUTATION: drop the `size > 17` floor -> the loop runs to 0 on a word that never fits; red (the floor assertion).
     MUTATION 2: step by 2px -> 18px is skipped for 19... the exact-size assertion fails. MUTATION 3: add
     `overflow-wrap: anywhere` to .ep-title in the sheet -> red (the token would be cut). */
  assert.doesNotMatch(declsAll(CSS, ".ag .ep-title")["overflow-wrap"] || "", /anywhere|break-word/, "the CSS never breaks inside a word");
  const m = withFonts(mount());
  const fit = titleFixture({ words: ["Supercalifragilisticexpialidocious-Electroencephalographically"], widthAt: (px) => px * 18 });
  m.ctx.fitEpisodeTitle(fit.el);
  assert.ok(fit.el.classList.contains("is-fit"));
  assert.strictEqual(fit.px(), 19, "the largest size at which an 18em-wide word fits 343px: 343/18 = 19.05");
  const never = titleFixture({ words: ["x"], widthAt: () => 9999 });
  m.ctx.fitEpisodeTitle(never.el);
  assert.strictEqual(never.px(), 17, "the floor holds on a word that cannot fit");
  const fits = titleFixture({ words: ["Short title"], widthAt: () => 100 });
  m.ctx.fitEpisodeTitle(fits.el);
  assert.ok(!fits.el.classList.contains("is-fit") && !fits.el.vars["--ep-title-size"], "a title that fits is left at --t-title");
});

test("a title past three lines ends on a WORD with the ellipsis on it, the whole title stays in the text, and an ellipsis that would wrap takes one more word", () => {
  /* The engine's own line clamp cuts the third line wherever "…" fits ("acros…"). MUTATION: `lines[i] < 3` -> `lines[i] < 2` -> only two lines
     show (14 words become 9); red. MUTATION 2: drop the `while (last > 0)` wrap-back -> "…" wraps to a fourth line; red. MUTATION 3:
     write the trimmed text into textContent instead of hiding spans -> the whole-title assertion fails. */
  const words = "The extraordinarily long and winding story of how a small group of researchers across three continents spent eleven years arguing".split(" ");
  const m = withFonts(mount());
  const fit = titleFixture({ words, perLine: 5, widthAt: () => 100 });
  m.ctx.fitEpisodeTitle(fit.el);
  const spans = fit.label.querySelectorAll(".ep-w");
  assert.strictEqual(spans.length, words.length, "every word is wrapped");
  const visible = spans.filter((s) => !s.classList.contains("ep-cut"));
  const lastVisible = visible[visible.length - 1];
  assert.ok(lastVisible.classList.contains("ep-last"));
  const marked = [...fit.label.innerHTML.matchAll(/<span class="ep-w">([^<]*)<\/span>/g)].map((x) => x[1]);
  assert.deepStrictEqual(marked, words, "every word, in order, each its own span: the cut is between words, never inside one");
  assert.strictEqual(spans.indexOf(lastVisible), visible.length - 1, "the visible words are the first ones, and the last of them takes the ellipsis");
  /* five per line, three lines = 15 words; the 15th would carry the ellipsis AND wrap, so the 14th does */
  assert.strictEqual(visible.length, 14, "the word that would carry an ellipsis down a line is cut too");
  assert.strictEqual(fit.label._full, words.join(" "), "the whole title is kept: the hidden words are clipped, not removed (headingName() and a screen reader keep it)");
  assert.ok(fit.el.classList.contains("is-trimmed"));
  assert.strictEqual(spans.filter((s) => s.classList.contains("ep-last")).length, 1, "exactly one word carries the ellipsis");
  /* A hyphenated word is several pieces: a title that is two long hyphenated words (the token seed) is cut between their parts,
     after a hyphen, never inside a part and never leaving a word that wraps past line three.
     MUTATION: split on whitespace only (drop the hyphen split (the `match(/[^-]*-|[^-]+/g)`)) -> the first word is one piece standing for four lines; red. */
  const hy = titleFixture({ words: ["Super-cali-fragil", "Electro-encephalo-graphically", "Counter-revolution-aries", "Uncon-stitution-ally", "Again-and-again"], perLine: 3, widthAt: () => 100 });
  m.ctx.fitEpisodeTitle(hy.el);
  const parts = [...hy.label.innerHTML.matchAll(/<span class="ep-w">([^<]*)<\/span>/g)].map((x) => x[1]);
  assert.deepStrictEqual(parts.slice(0, 6), ["Super-", "cali-", "fragil", "Electro-", "encephalo-", "graphically"], "split after each hyphen, the parts of a word kept together in order");
  assert.ok(hy.label.querySelectorAll(".ep-w").filter((s) => !s.classList.contains("ep-cut")).length <= 9, "at most three lines of three pieces");
  /* run again (a resize): back to the plain text first, then the same answer */
  m.ctx.fitEpisodeTitle(fit.el);
  assert.strictEqual(fit.label.querySelectorAll(".ep-w").filter((s) => !s.classList.contains("ep-cut")).length, 14);
  /* a title of three lines or fewer is never wrapped */
  const short = titleFixture({ words: ["A", "short", "title"], perLine: 5, widthAt: () => 100 });
  m.ctx.fitEpisodeTitle(short.el);
  assert.strictEqual(short.label.querySelectorAll(".ep-w").length, 0, "nothing to trim");
  delete El.prototype.offsetTop;
});

/* ---------- harness ---------- */

test("the harness reaches the page: an episode-notes state with the notes, the notes open and the Up Next add; the stress and token seeds already route to it", async () => {
  /* MUTATION: drop the episode-notes block from tools/ui-lab/lib/states.mjs -> red. The shots in the PR come from these steps. */
  const { appStates } = await import(pathToFileURL(path.join(ROOT, "tools", "ui-lab", "lib", "states.mjs")).href);
  const { loadFixtures } = await import(pathToFileURL(path.join(ROOT, "tools", "ui-lab", "lib", "seed.mjs")).href);
  const fx = loadFixtures(ROOT);
  const states = appStates(fx);
  const notes = states.find((s) => s.id === "episode-notes");
  assert.ok(notes, "the state exists");
  assert.deepStrictEqual(notes.steps.map((s) => s.label), ["episode-notes", "episode-notes-open", "episode-upnext-added"]);
  assert.strictEqual(notes.steps[0].route, "#/episode/" + encodeURIComponent(fx.items[11].id), "an item the returning seed neither saved nor queued, so Save and Up Next start Off");
  const stress = states.find((s) => s.id === "stress");
  assert.ok(stress.steps.some((s) => s.label === "episode") && stress.steps.some((s) => s.label === "episode-token"));
});

test("the Glow the page puts on the ROOT does not outlive the page: the next route clears it, so a sheet over Today reads the scheme's own Glow", () => {
  /* Iteration 2 baseline regression: ui/episode.js writes --glow on documentElement (the Dock reads the root's Glow), and nothing
     took it off, so the Settings and "What 4a does" sheets, opened later from Today, tinted their header with the last show's hue.
     The harness's documentElement is its <body>, whose style only had setProperty; here it is a real store.
     MUTATION: delete the removeProperty("--glow") call from setBodyClass() in app.js -> the second assertion goes red.
     MUTATION 2: drop forayCssVar(document.documentElement, "--glow", glow) from renderEpisode -> the first goes red (the Dock
     would stop reading the Room's light, so the clear would be tested against nothing). */
  const m = mount();
  const props = new Map();
  m.body.style = { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => { props.delete(k); }, getPropertyValue: (k) => props.get(k) || "" };
  open(m);
  assert.ok(props.get("--glow"), "on the page the root carries the show's Glow (the Dock reads it)");
  m.ctx.setBodyClass("view-home");
  assert.strictEqual(props.has("--glow"), false, "leaving the page leaves no Glow on the root");
  open(m);
  assert.ok(props.get("--glow"), "and coming back lights it again: the clear happens before the page writes, not after");
});
