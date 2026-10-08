/* Redesign 2026, ambient direction ("Afterglow"), phase 4: the SHOW PAGE (#/show/<id>).
 *
 * docs/redesign-2026/directions/ambient/BUILD-NOTES.md section 10 item 10, section 3 (EpisodeRow) and section 1.5
 * (the Room) are the specification; showRoomHtml, showEpisodeRowHtml and friends in ui/show.js, the Follow button in
 * app.js (showStarBtn, paintFollow) and ui/show.css are the build. The behaviour the page always had (the fetch, the
 * four load states, the search box, the cache, pagination, the count label) is carried by test/show-page*.test.js,
 * show-episode-load-states, show-episodes-cache and show-pages-3b-full-catalogue, rewritten only where the row or the
 * header they read changed. THIS suite pins what the redesign adds, one acceptance line at a time:
 *
 *   1-2   the Room: art 160 lit, the title as the page's heading, the count line, Follow and its note, centred; and
 *         hostile data (a title with markup, an unsafe artwork URL) never reaches the DOM as markup
 *   3     the light: the Room takes the show's Glow, its art and the backdrop, through the CSSOM, from numbers only
 *   4-5   Follow is a Secondary button, and its state is a FILL change (Regular plus -> Fill check, the word, the
 *         ring), not colour alone; its accessible name contains its visible words
 *   6     the rows are EpisodeRows (Today's anatomy, art 72 / Play 44 / two-line why, 96 tall, no hairline), sharing
 *         their geometry with the gallery's EpisodeRow
 *   7-8   latest first, and only when every row is dated; the rows' Play is its own control (never `data-play`, which
 *         the player would repaint as a glyph) and the page repaints it from the player
 *   9     hostile episode data goes through esc()
 *   10-11 the pairs on the Room are AA in BOTH schemes at the lightest and the darkest art, and every line of text sits
 *         below the scrim's second stop (the zone those pairs are measured in)
 *   12    the stylesheet's own rules: scoped, one reduced-motion owner, no inline style, no literal colour, shipped
 *
 * Every test names the one-line mutation that makes it fail, and each was run (the PR lists them). A green test is not
 * evidence until you have broken it (CLAUDE.md). HARNESS AUDIT: the page is built in a node:vm context from the same
 * sources the browser loads, so ui/show.js, ui/home.js (the row helpers) and app.js really run together; the fake
 * elements are the minimum a repaint needs and answer nothing the real DOM would refuse (a missing setProperty is
 * tested as a stub document, below).
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const ok = require("./helpers/oklab.js");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, " ");
const APP_SRC = readAppSource();
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const SHOW_CSS_RAW = process.env.AMBIENT_SHOW_CSS ? fs.readFileSync(process.env.AMBIENT_SHOW_CSS, "utf8").replace(/\r\n/g, "\n") : read("ui/show.css");
const SHOW_CSS = strip(SHOW_CSS_RAW);
const TODAY_CSS = strip(read("ui/today.css"));
const PRIM_CSS = strip(read("ui/primitives.css"));
const TOKENS = read("ui/tokens.css");

process.on("unhandledRejection", () => {});

/* ---------------------------------------------------------------- the CSS reader */
function cssRules(css) {
  const out = [];
  const stack = [];
  let buf = "";
  for (const ch of css) {
    if (ch === "{") { stack.push(buf.trim()); buf = ""; continue; }
    if (ch === "}") {
      const prelude = stack.pop();
      if (buf.trim() && prelude !== undefined) out.push({ prelude, body: buf.trim(), atRules: stack.filter((p) => p.startsWith("@")) });
      buf = "";
      continue;
    }
    buf += ch;
  }
  return out;
}
function selectorsOf(prelude) {
  const out = []; let depth = 0; let cur = "";
  for (const ch of prelude) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim().replace(/\s+/g, " ")); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim().replace(/\s+/g, " "));
  return out;
}
const valueIn = (rules, sel, prop) => {
  let v = null;
  for (const r of rules) {
    if (r.prelude.startsWith("@") || r.atRules.length || !selectorsOf(r.prelude).includes(sel)) continue;
    for (const d of r.body.split(";")) {
      const c = d.indexOf(":");
      if (c >= 0 && d.slice(0, c).trim() === prop) v = d.slice(c + 1).trim().replace(/\s+/g, " ");
    }
  }
  return v;
};
const SHOW_RULES = cssRules(SHOW_CSS);
const TODAY_RULES = cssRules(TODAY_CSS);
const PRIM_RULES = cssRules(PRIM_CSS);
const showValue = (sel, prop) => valueIn(SHOW_RULES, sel, prop);

/* ---------------------------------------------------------------- the app, in a node:vm */
function makeEl(tag) {
  const classes = new Set();
  const attrs = new Map();
  return {
    tagName: String(tag || "div").toUpperCase(), id: null, className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), toggle: (c, on) => { const v = on === undefined ? !classes.has(c) : on; if (v) classes.add(c); else classes.delete(c); return v; }, contains: (c) => classes.has(c) },
    addEventListener() {}, removeEventListener() {}, appendChild(k) { this.children.push(k); return k; }, append() {},
    setAttribute: (k, v) => attrs.set(k, String(v)), getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null), removeAttribute: (k) => attrs.delete(k),
    querySelector: () => null, querySelectorAll: () => [], closest: () => null, focus() {}, select() {}, click() {}, remove() {},
  };
}
const PAGE_IDS = ["view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle", "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn", "banner-slot", "pl-form", "pl-input", "pl-note", "sh-form", "sh-input", "sh-note", "sh-results"];

function mount({ docQuery = null, onLine = true } = {}) {
  const store = new Map();
  const byId = new Map(PAGE_IDS.map((id) => { const el = makeEl("div"); el.id = id; return [id, el]; }));
  const body = makeEl("body");
  /* HARNESS AUDIT: makeEl's classList and className are two unrelated stores, so a className rewrite (what setBodyClass
     does) never dropped a class added through classList, and a class leaking past setBodyClass passed unseen. The body
     gets the real coupling: one class set, className reads and rewrites it. */
  const bodyClasses = new Set();
  Object.defineProperty(body, "className", { get: () => [...bodyClasses].join(" "), set: (v) => { bodyClasses.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => bodyClasses.add(c)); } });
  body.classList = { add: (c) => bodyClasses.add(c), remove: (c) => bodyClasses.delete(c), toggle: (c, on) => { const v = on === undefined ? !bodyClasses.has(c) : on; if (v) bodyClasses.add(c); else bodyClasses.delete(c); return v; }, contains: (c) => bodyClasses.has(c) };
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),
    localStorage: {
      get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); },
    },
    document: {
      body, documentElement: makeEl("html"), readyState: "complete", addEventListener() {}, createElement: (t) => makeEl(t),
      querySelector: (sel) => { const s = String(sel); if (docQuery) { const hit = docQuery(s); if (hit !== undefined) return hit; } return s.startsWith("#") ? byId.get(s.slice(1)) ?? null : null; },
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node", onLine },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    matchMedia: () => ({ matches: false }),
    addEventListener() {}, removeEventListener() {},
    location: { hash: "#/", search: "", pathname: "/", href: "https://x.test/" }, history: { replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) }, URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  runAppSource(APP_SRC, ctx);
  const evalIn = (src) => vm.runInContext(src, ctx);
  const state = evalIn("state");
  state.catalog = { shows: [SHOW] };
  state.discover = { items: [] };
  state.taxonomy = { nodes: [] };
  state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  return { ctx, evalIn, state, store, body, byId };
}

const ART = "https://is1-ssl.mzstatic.com/image/thumb/P/v4/mza_1.jpg/600x600bb.jpg";
const SHOW = { show_id: "s-1", title: "Show One", explicit: false, artwork_url: ART, taxonomy_node_ids: [] };

const ep = (id, title, extra = {}) => ({ id, title, show: "Show One", show_id: "s-1", audio_url: `https://cdn.example.com/${id}.mp3`, duration_min: 30, release_date: null, hook: "", description: "", ...extra });

/* ================================================================================ 1-2 the Room */

test("the Room: a scheme-following .room whose art is 160 and lit, with the heading, the count line, Follow and its note in that order", () => {
  /* MUTATIONS (each run red): swap size 160 for 120 in showRoomHtml's agArtwork call; drop `room` from the section's
     class (it would stop following the scheme); move the count <p> above the <h2>; put the note before Follow. */
  const m = mount();
  const html = m.ctx.showRoomHtml(SHOW, ART);
  assert.match(html, /^<section class="room ag sh-room" data-sh-room data-glow-show="Show One">/, "a Room that wears .ag, so the primitives reach it");
  assert.ok(!/data-theme/.test(html), "no pinned scheme: the Room follows the page's");
  assert.match(html, /<div class="sh-art"><span class="ag-art ag-art-160 [^"]*is-lit lit-art lit-64" role="img" aria-label="Show One">/, "art 160, Lit at 64px (BUILD-NOTES 10.2)");
  const order = ['class="ag-btn ag-btn-icon sh-back back"', 'class="sh-art"', "<h2 ", "data-show-count", "sh-follow", "sh-note"].map((s) => html.indexOf(s));
  assert.ok(order.every((v) => v > 0) && order.every((v, i) => i === 0 || v > order[i - 1]), `Back, art, heading, count, Follow, note in order: ${order}`);
  assert.match(html, /<a class="ag-btn ag-btn-icon sh-back back" href="#\/" aria-label="Back">/, "Back is an icon button on a.back (onBackClick walks history for it)");
  assert.match(html, /<h2 class="t-title clamp3 sh-title">Show One<\/h2>/, "the page's heading: the title style, three lines at most");
  assert.match(html, /<p class="t-caption sh-sub" data-show-count><\/p>/, "the count is emitted EMPTY: paintCount() is its one author (issue #687)");
  assert.ok(html.includes("Following keeps a show one tap away in your Library."), "Follow's note is the one the page always carried");
});

test("hostile data: a title with markup, an unsafe artwork URL and an explicit badge never reach the DOM as markup", () => {
  /* MUTATIONS (each run red): drop esc() around show.title in the <h2>; drop the safeUrl() in showCssUrl; drop esc()
     on data-glow-show. */
  const m = mount();
  const evil = { ...SHOW, title: 'Evil <img src=x onerror=alert(1)> "quoted"', explicit: true };
  const html = m.ctx.showRoomHtml(evil, "javascript:alert(1)");
  assert.ok(!/<img src=x/.test(html) && !/onerror=alert/.test(html.replace(/&lt;img src=x onerror=alert\(1\)&gt;/g, "")), "the title is escaped");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;") && html.includes("&quot;quoted&quot;"));
  assert.ok(!/javascript:/.test(html), "an unsafe artwork URL never becomes a src");
  assert.match(html, /class="explicit-badge"/, "the explicit badge stays beside the title");
  assert.strictEqual(m.ctx.showCssUrl("javascript:alert(1)"), "none", "and never a backdrop url()");
  assert.strictEqual(m.ctx.showCssUrl(null), "none");
  assert.strictEqual(m.ctx.showCssUrl('https://a.test/x".jpg'), 'url("https://a.test/x%22.jpg")', "a quote cannot end the CSS string");
  assert.strictEqual(m.ctx.showCssUrl(ART), 'url("https://is1-ssl.mzstatic.com/image/thumb/P/v4/mza_1.jpg/400x400bb.jpg")', "asked at the backdrop's blurred size");
});

/* ================================================================================ 3 the light */

test("the light: the Room's Glow, its --art-glow and its backdrop are written through the CSSOM from numbers; a stub document is not an error", () => {
  /* MUTATIONS (each run red): drop the agSetGlow(art, ..., "--art-glow") line; write --room-art with the raw URL
     (drop showCssUrl); remove the typeof setProperty guard (the stub case below throws). */
  const m = mount();
  const sets = [];
  const art = { style: { setProperty: (k, v) => sets.push(["art", k, v]) } };
  const room = { style: { setProperty: (k, v) => sets.push(["room", k, v]) }, querySelector: (sel) => (sel === ".sh-art .ag-art" ? art : null) };
  const scope = { querySelector: (sel) => (sel === "[data-sh-room]" ? room : null) };
  m.ctx.showApplyRoom(scope, m.ctx.showRoomLight(SHOW, ART));
  const byKey = Object.fromEntries(sets.map(([who, k, v]) => [`${who}${k}`, v]));
  assert.match(byKey["room--glow"], /^oklch\(0\.66 0\.\d{3} \d+\)$/, "the Room's Glow is a number-built oklch() at Dusk's lightness");
  assert.strictEqual(byKey["art--art-glow"], byKey["room--glow"], "the art is lit by the same show");
  assert.match(byKey["room--room-art"], /^url\("https:\/\/is1-ssl\.mzstatic\.com\/.*\/400x400bb\.jpg"\)$/);
  assert.ok(!/Show One/.test(JSON.stringify(sets)), "the show's NAME never reaches a style, only numbers do");
  /* A stub document has no CSSOM: no throw, nothing painted. */
  assert.doesNotThrow(() => m.ctx.showApplyRoom({ querySelector: () => ({ style: {} }) }, m.ctx.showRoomLight(SHOW, ART)));
  assert.doesNotThrow(() => m.ctx.showApplyRoom(null, m.ctx.showRoomLight(SHOW, ART)));
  /* ORDER: the light is computed before the Room is in the DOM (a getComputedStyle after it would flush the default
     Glow into a transition). MUTATION: call showRoomLight after the innerHTML install in renderShow -> red. */
  const src = read("ui/show.js");
  assert.ok(src.indexOf("const roomLight = showRoomLight(show, showArt);") < src.indexOf('$("#view").innerHTML = `${showRoomHtml(show, showArt)}'), "the light is read before the Room is installed");
  const renderBody = src.slice(src.indexOf("function renderShow("));
  assert.strictEqual((renderBody.match(/showRoomLight\(/g) || []).length, 1, "and read once, there, never again after the install");
  assert.ok(renderBody.includes('showApplyRoom($("#view"), roomLight);'), "the install only WRITES what was read");
});

/* ================================================================================ 4-5 Follow */

test("Follow is a Secondary button; followed, the state is a FILL change: the Regular plus becomes the Fill check, the word and the ring change with it", () => {
  /* MUTATIONS (each run red): use `check-circle` (Regular) instead of `check-circle-fill` for the on state; make
     followFillHtml return the same icon for both; drop `is-following` from showStarBtn's on class; delete the Ember
     ring from `.ag .sh-follow.is-following`. */
  const m = mount();
  const off = m.ctx.showStarBtn("s-1");
  m.ctx.toggleShowStar("s-1");
  const on = m.ctx.showStarBtn("s-1");
  for (const html of [off, on]) assert.match(html, /^<button type="button" class="ag-btn ag-btn-secondary sh-follow/, "a Secondary button, one treatment");
  assert.ok(off.includes("#i-plus") && !off.includes("check-circle"), "unfollowed: the Regular plus");
  assert.ok(on.includes("#i-check-circle-fill") && !on.includes("#i-plus") && !/#i-check-circle"/.test(on), "followed: the FILL check, not the Regular one");
  assert.ok(off.includes("<span>Follow</span>") && on.includes("<span>Following</span>"), "the word moves with it");
  assert.ok(!/is-following/.test(off) && /sh-follow is-following"/.test(on));
  const strip2 = (h) => h.replace(/ is-following/, "").replace(/#i-[\w-]+/, "#i").replace(/<span>[^<]*<\/span>/, "").replace(/aria-label="[^"]*"/, "");
  assert.strictEqual(strip2(off), strip2(on), "icon, word, name and class are the ONLY differences: nothing else moved");
  assert.strictEqual(showValue(".ag .sh-follow.is-following", "background"), "var(--overlay)", "the inside takes the overlay");
  assert.match(showValue(".ag .sh-follow.is-following", "box-shadow"), /var\(--ember\)$/, "the ring is Ember");
  assert.strictEqual(showValue(".ag .sh-follow.is-following .icon", "color"), "var(--ember)");
  assert.strictEqual(valueIn(PRIM_RULES, ".ag .ag-btn-secondary", "box-shadow") !== null, true, "Secondary is the primitive's own ring");
});

test("Follow's accessible name always contains its visible words and names the show; the repaint and the first paint write the same three things", () => {
  /* MUTATIONS (each run red): make followName drop the title; have paintFollow skip setAttribute("aria-label", ...);
     have showStarBtn write a hand-typed aria-label. */
  const m = mount();
  assert.strictEqual(m.ctx.followName(false, "Show One"), "Follow Show One");
  assert.strictEqual(m.ctx.followName(true, "Show One"), "Following Show One");
  assert.strictEqual(m.ctx.followName(true, ""), "Following", "a show with no title still has a name");
  const off = m.ctx.showStarBtn("s-1");
  assert.match(off, /data-follow-name="Show One" aria-label="Follow Show One"/);
  const btn = makeEl("button");
  btn.dataset.followName = "Show One";
  m.ctx.paintFollow(btn, true);
  assert.strictEqual(btn.innerHTML, m.ctx.followFillHtml(true), "the repaint's markup is the builder's markup");
  assert.strictEqual(btn.getAttribute("aria-label"), "Following Show One");
  assert.ok(btn.classList.contains("is-following"));
  m.ctx.paintFollow(btn, false);
  assert.strictEqual(btn.getAttribute("aria-label"), "Follow Show One");
  assert.ok(!btn.classList.contains("is-following"));
  /* hostile show title: escaped in the attribute */
  m.state.catalog.shows.push({ show_id: "s-2", title: 'A" onfocus="x', taxonomy_node_ids: [] });
  assert.ok(!/ onfocus="x"/.test(m.ctx.showStarBtn("s-2")), "a quote in a title cannot open an attribute");
});

/* ================================================================================ 6 the rows */

test("the rows are EpisodeRows: Today's anatomy, 96 tall, no hairline, sharing the gallery EpisodeRow's geometry", () => {
  /* MUTATIONS (each run red): add `border-bottom: 1px solid var(--line)` to `.ag .td-row` (the share check) or to
     `.ag.sh-eps`; change `.ag .td-row`'s min-height to 88px; put the Play back on `data-play`; render the why-line
     without clamp2; draw epRow in paintList instead of showEpisodeRowsHtml. */
  const m = mount();
  const item = ep("e-1", "A clear account", { release_date: "2026-08-26T00:00:00Z", description: "A practical account of how ideas move into ordinary tools, and the people who carry them across the gap." });
  const html = m.ctx.showEpisodeRowHtml(item, "show-s-1");
  assert.match(html, /^<article class="raised td-row sh-row is-default" data-sh-ep="e-1">/, "a Raised row in Today's anatomy");
  assert.ok(html.includes('class="ag-art ag-art-72'), "art 72");
  assert.match(html, /<h3 class="t-headline clamp2 td-row-title"><a class="td-link" href="#\/episode\/e-1" data-ev="picked" data-ep="e-1" data-ctx="show-s-1">A clear account<\/a><\/h3>/, "the title is the row's one stretched link");
  assert.match(html, /<button type="button" class="ag-btn ag-btn-play ag-btn-size-44"[^>]*aria-label="Play A clear account"/, "Play 44");
  assert.match(html, /<p class="t-why clamp2 td-row-why">A practical account of how ideas move/, "a two-line why-line from the publisher's own words");
  assert.ok(!/ep-row|star-btn|data-upnext|data-star/.test(html), "no legacy row, no Save or Up Next of its own");
  /* geometry shared with the gallery's row, by value */
  for (const prop of ["min-height", "padding", "grid-template-columns"]) {
    assert.strictEqual(valueIn(TODAY_RULES, ".ag .td-row", prop), valueIn(PRIM_RULES, ".ag .ag-episode-row", prop), `.td-row and the gallery EpisodeRow agree on ${prop}`);
  }
  assert.strictEqual(valueIn(TODAY_RULES, ".ag .td-row", "min-height"), "var(--row-episode)");
  assert.ok(/--row-episode:\s*96px/.test(TOKENS), "96 is the token");
  /* no hairline: neither the row nor the list draws a border or an outline between rows */
  for (const [rules, sel] of [[TODAY_RULES, ".ag .td-row"], [SHOW_RULES, ".ag.sh-eps"], [SHOW_RULES, ".ag.sh-eps [data-show-episodes] > * + *"]]) {
    for (const prop of ["border", "border-top", "border-bottom", "outline"]) assert.strictEqual(valueIn(rules, sel, prop), null, `${sel} sets no ${prop}`);
  }
  assert.strictEqual(showValue(".ag.sh-eps [data-show-episodes] > * + *", "margin-top"), "var(--s-2)", "rows are separated by an 8px gap of page, never a rule");
  /* the page really draws these, and not epRow */
  assert.match(APP_SRC, /c\.innerHTML = showEpisodeRowsHtml\(rows, ctx\);/, "the full list");
  assert.match(APP_SRC, /const rows = showEpisodeRowsHtml\(curatedEps, ctx\);/, "the curated rows");
  assert.ok(!/epRow\(/.test(read("ui/show.js").replace(/\/\*[\s\S]*?\*\//g, "")), "ui/show.js draws no epRow");
});

/* ================================================================================ 7-8 order and play */

test("latest first: newest date on top, ties keep their order, and a list with any undated row keeps the order it arrived in", () => {
  /* MUTATIONS (each run red): flip the comparator (b/a -> a/b); drop the `every` guard (the mixed case then shuffles);
     return the argument untouched. */
  const m = mount();
  const ids = (rows) => Array.from(rows, (r) => r.id);   /* the page's arrays are the vm's: copy into this realm before deepStrictEqual */
  const a = ep("a", "A", { release_date: "2026-01-01T00:00:00Z" });
  const b = ep("b", "B", { release_date: "2026-03-01T00:00:00Z" });
  const c = ep("c", "C", { release_date: "2026-02-01T00:00:00Z" });
  const d = ep("d", "D", { release_date: "2026-03-01T00:00:00Z" });
  assert.deepStrictEqual(ids(m.ctx.showRowsLatestFirst([a, b, c])), ["b", "c", "a"], "newest first");
  assert.deepStrictEqual(ids(m.ctx.showRowsLatestFirst([a, b, c, d])), ["b", "d", "c", "a"], "a tie keeps the order it arrived in");
  const undated = ep("u", "U");
  assert.deepStrictEqual(ids(m.ctx.showRowsLatestFirst([a, b, undated])), ["a", "b", "u"], "one undated row: the whole list keeps the server's order, a pair of dated rows included");
  assert.deepStrictEqual(m.ctx.showRowsLatestFirst([]), []);
  const html = m.ctx.showEpisodeRowsHtml([a, b, c], "show-s-1");
  const at = ["e/b", "e/c", "e/a"].map((s) => html.indexOf(`href="#/${s.replace("e/", "episode/")}"`));
  assert.ok(at.every((v) => v > 0) && at[0] < at[1] && at[1] < at[2], "and the markup is in that order");
  assert.deepStrictEqual([a, b, c].map((r) => r.id), ["a", "b", "c"], "the caller's array is not reordered in place");
});

test("a row's Play is its own control (never data-play, which the player repaints as a glyph), and the page repaints the rows from the player", () => {
  /* MUTATIONS (each run red): write `data-play=` on the row's Play (the player's syncCardButtons would wipe its icon);
     drop the is-playing toggle in showSyncPlay; leave the old Playing caption when playback stops. */
  let playing = null;
  const rows = ["e-1", "e-2"].map((id) => {
    const row = makeEl("article"); row.dataset.shEp = id;
    const btn = makeEl("button"); btn.dataset.shPlay = id; btn.dataset.title = `Title ${id}`;
    const meta = makeEl("p");
    let line = null;
    meta.querySelector = (sel) => (sel === ".ag-row-state" ? line : null);
    meta.insertAdjacentHTML = (where, html) => { assert.strictEqual(where, "afterbegin"); line = { html, remove() { line = null; } }; };
    meta.line = () => line;
    row.querySelector = (sel) => (sel === "[data-sh-play]" ? btn : sel === ".td-row-meta" ? meta : null);
    return { id, row, btn, meta };
  });
  const scope = { querySelectorAll: (sel) => (sel === "[data-sh-ep]" ? rows.map((r) => r.row) : []) };
  const m = mount({ docQuery: (s) => (s === "[data-show-episodes]" ? scope : undefined) });
  m.ctx.ForayPlayer = { isPlaying: (id) => id === playing };
  const html = m.ctx.showEpisodeRowHtml(ep("e-1", "Title e-1"), "show-s-1");
  assert.ok(!/ data-play=/.test(html), "not data-play");
  assert.match(html, / data-sh-play="e-1" data-ctx="show-s-1" data-title="Title e-1"/);
  playing = "e-2";
  m.ctx.showSyncPlay();
  assert.ok(rows[1].row.classList.contains("is-playing") && !rows[0].row.classList.contains("is-playing"));
  assert.strictEqual(rows[1].btn.getAttribute("aria-label"), "Pause Title e-2");
  assert.ok(rows[1].btn.innerHTML.includes("#i-pause") && !rows[1].btn.innerHTML.includes("#i-play"));
  assert.ok(rows[1].meta.line() && rows[1].meta.line().html.includes("Playing") && rows[1].meta.line().html.includes("play-fill"), "the Lamp state line carries a Fill glyph and a word");
  assert.strictEqual(rows[0].meta.line(), null, "only the playing row has one");
  playing = null;
  m.ctx.showSyncPlay();
  assert.ok(!rows[1].row.classList.contains("is-playing"));
  assert.strictEqual(rows[1].btn.getAttribute("aria-label"), "Play Title e-2");
  assert.ok(rows[1].btn.innerHTML.includes("#i-play") && !rows[1].btn.innerHTML.includes("#i-pause"));
  assert.strictEqual(rows[1].meta.line(), null, "and the caption goes when playback stops");
  /* an item with no audio_url has no Play at all, never a dead one */
  assert.ok(!/data-sh-play/.test(m.ctx.showEpisodeRowHtml(ep("e-3", "No audio", { audio_url: null }), "show-s-1")));
});

/* ================================================================================ 9 hostile episodes */

test("hostile episode data: title, description and ids go through esc() and encodeURIComponent", () => {
  /* MUTATIONS (each run red): drop esc() around item.title; drop encodeURIComponent on the href; drop esc() around the
     snippet. */
  const m = mount();
  const evil = ep('x"><script>1</script>', '<b onmouseover=alert(1)>T</b>', { description: '<img src=x onerror=alert(2)>' });
  const html = m.ctx.showEpisodeRowHtml(evil, 'c"x');
  assert.ok(!/<script>|<b onmouseover|<img src=x onerror/.test(html), "no markup from data");
  assert.ok(html.includes("&lt;b onmouseover=alert(1)&gt;T&lt;/b&gt;") && html.includes("&lt;img src=x onerror=alert(2)&gt;"));
  assert.ok(html.includes('href="#/episode/x%22%3E%3Cscript%3E1%3C%2Fscript%3E"'), "the route id is encoded");
  assert.ok(html.includes('data-ep="x&quot;&gt;&lt;script&gt;1&lt;/script&gt;"') && html.includes('data-ctx="c&quot;x"'));
});

/* ================================================================================ 10-11 contrast */

/* The Room's scrim, at the zone every line of text sits in (at or below --rs2), over the lightest and the darkest art
   there can be, at every hue, in each scheme. The scheme tokens are read out of ui/tokens.css, the derived Glow mixes
   from the same formulas the CSS uses. */
const block = (head) => { const i = TOKENS.indexOf(head); assert.ok(i >= 0, head); return TOKENS.slice(TOKENS.indexOf("{", i) + 1, TOKENS.indexOf("\n}", i)); };
const tokenMap = (text) => Object.fromEntries([...strip(text).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((x) => [x[1], x[2].trim().replace(/\s+/g, " ")]));
const DUSK = tokenMap(block(':root, [data-theme="dusk"] {'));
const DAWN = tokenMap(block('[data-theme="dawn"] {'));
const resolve = (map, v, depth = 0) => { const x = /^var\((--[\w-]+)\)$/.exec(v); return x ? (assert.ok(depth < 5 && map[x[1]], `${v} resolves`), resolve(map, map[x[1]], depth + 1)) : v; };
const rgbOf = (map, name) => { const v = resolve(map, map[name]); assert.match(v, /^#[0-9A-Fa-f]{6}$/, `${name} is a hex (${v})`); return ok.hexToRgb(v); };
const rgba = (v) => { const x = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(v); assert.ok(x, v); return { rgb: [+x[1], +x[2], +x[3]], a: +x[4] }; };
const pct = (v) => parseFloat(v) / 100;

function roomPairs(scheme, fgs) {
  const L = parseFloat(scheme["--glow-l"]);
  const mid = rgba(scheme["--scrim-mid-base"]);
  const share = 1 - pct(scheme["--mix-scrim"]);
  const bg0 = ok.srgbToOklab(rgbOf(scheme, "--bg0"));
  const layer = parseFloat(scheme["--room-art-opacity"]);
  const worst = {};
  for (let h = 0; h < 360; h += 10) {
    const glow = ok.oklchToLab(L, 0.14, h);
    const base = ok.oklabToSrgb(ok.mixLab(bg0, glow, 1 - pct(scheme["--mix-room"])));   // the Room's own base, under the art
    for (const [art, rgbArt] of [["white", [1, 1, 1]], ["black", [0, 0, 0]]]) {
      const back = ok.over(rgbArt, layer, base);
      const m = ok.mixScrim(mid.rgb, mid.a, share, glow);
      const bg = ok.over(ok.oklabToSrgb(m.lab), m.alpha, back);
      for (const [name, fg] of Object.entries(fgs)) {
        const r = ok.contrast(fg, bg);
        const key = `${name} over ${art} art`;
        if (!worst[key] || r < worst[key].r) worst[key] = { r, h };
      }
    }
  }
  return worst;
}

test("the pairs on the Room are AA in Dusk and in Dawn, at the lightest and the darkest art, at every hue; the worst cases are pinned", () => {
  /* The title is --text; the count and the note are --on-wash-2 (--text-2 is the pair this test exists to forbid: at
     the lightest art it measures under 4.5 in Dusk, see the last assertion). MUTATIONS (each run red): set
     `.ag .sh-sub { color: var(--text-2) }`; lower --mix-scrim; change --on-wash-2 in Dusk to #B9AFA3. The pinned
     numbers are this suite's own first measurement, to 0.011. */
  const pin = (label, got, want) => { assert.ok(got.r >= 4.5, `${label} is under AA: ${got.r.toFixed(3)} at hue ${got.h}`); assert.ok(Math.abs(got.r - want) <= 0.011, `${label}: ${got.r.toFixed(3)} at hue ${got.h}, pinned ${want}`); };
  assert.strictEqual(showValue(".ag .sh-sub", "color"), "var(--on-wash-2)");
  assert.strictEqual(showValue(".ag .sh-note", "color"), "var(--on-wash-2)");
  assert.strictEqual(showValue(".room.sh-room", "color"), "var(--text)");
  const dusk = roomPairs(DUSK, { text: rgbOf(DUSK, "--ag-text"), "on-wash-2": rgbOf(DUSK, "--on-wash-2") });
  const dawn = roomPairs(DAWN, { text: rgbOf(DAWN, "--ag-text"), "on-wash-2": rgbOf(DAWN, "--on-wash-2") });
  const PINNED = {
    dusk: { "text over white art": 8.324, "on-wash-2 over white art": 6.867, "text over black art": 11.992, "on-wash-2 over black art": 9.893 },
    dawn: { "text over white art": 11.948, "on-wash-2 over white art": 11.948, "text over black art": 10.93, "on-wash-2 over black art": 10.93 },
  };
  for (const [k, w] of Object.entries(PINNED.dusk)) pin(`Dusk ${k}`, dusk[k], w);
  for (const [k, w] of Object.entries(PINNED.dawn)) pin(`Dawn ${k}`, dawn[k], w);
  assert.strictEqual(Object.keys(dusk).length + Object.keys(dawn).length, 8, "all eight worst cases were measured");
  const textTwo = roomPairs(DUSK, { "text-2": rgbOf(DUSK, "--text-2") });
  assert.ok(textTwo["text-2 over white art"].r < 4.5, `fixture assumption: --text-2 is NOT enough over the lightest art in Dusk (${textTwo["text-2 over white art"].r.toFixed(2)}), which is why --on-wash-2 is used`);
});

test("every line of text sits at or below the scrim's second stop, the zone the pairs are measured in; Back and the art sit above it", () => {
  /* The stops and the stack are read out of ui/show.css and ui/tokens.css: safe-top 0, then the rhythm top to bottom. */
  /* MUTATIONS (each run red): raise `.ag .sh-head`'s margin-top to var(--s-6) is fine, but lower it to var(--s-3) (the
     title then starts at 228, above --rs2 = 232); lower the art's margin-top; set --rs2 to 280px. */
  const tok = (name) => { const x = new RegExp(`${name}:\\s*(\\d+)px`).exec(TOKENS); assert.ok(x, name); return +x[1]; };
  const space = { "--s-1": tok("--s-1"), "--s-2": tok("--s-2"), "--s-3": tok("--s-3"), "--s-4": tok("--s-4"), "--s-5": tok("--s-5"), "--s-6": tok("--s-6") };
  const px = (v) => { const x = /^var\((--s-\d)\)$/.exec(v); assert.ok(x, v); return space[x[1]]; };
  const rs2 = Number(/--rs2:\s*calc\(var\(--safe-top\) \+ (\d+)px\)/.exec(showValue(".room.sh-room", "--rs2") ? `--rs2: ${showValue(".room.sh-room", "--rs2")}` : "")?.[1]);
  const rs1 = Number(/calc\(var\(--safe-top\) \+ (\d+)px\)/.exec(showValue(".room.sh-room", "--rs1"))?.[1]);
  assert.ok(rs1 > 0 && rs2 > rs1, `the two stops are read (${rs1}, ${rs2})`);
  const padTop = /calc\(var\(--safe-top\) \+ (var\(--s-\d\))\)/.exec(showValue(".room.sh-room", "padding"));
  assert.ok(padTop, "the Room's top padding is safe-top + a step");
  const tap = tok("--tap"), art = tok("--art-hero");
  const artTop = px(padTop[1]) + tap + px(showValue(".ag .sh-art", "margin-top"));
  const titleTop = artTop + art + px(showValue(".ag .sh-head", "margin-top"));
  assert.strictEqual(artTop, 56, "the art starts where the scrim's top stop does (safe-top + 56)");
  assert.ok(px(padTop[1]) + tap <= 56, "Back ends on the head scrim (safe-top + 56)");
  assert.ok(titleTop >= rs2, `the title starts at ${titleTop}, at or below --rs2 (${rs2})`);
  /* and the scrim this page draws ends in bg0, with the tokens' own stops before it */
  const after = showValue(".room.sh-room::after", "background");
  assert.match(after, /var\(--scrim-head\) 0, var\(--scrim-top\) calc\(var\(--safe-top\) \+ 56px\), var\(--scrim-top\) var\(--rs1\), var\(--scrim-mid\) var\(--rs2\), var\(--bg0\) 100%/);
});

/* ================================================================================ 12 the stylesheet and the wiring */

test("ui/show.css: every rule scoped under .ag or the Room, a new name each, one reduced-motion owner, no inline style, no literal colour, no raw duration", () => {
  /* MUTATIONS (each run red): add `.page-head { top: 0 }`; add a `@media (prefers-reduced-motion: reduce)` block; add
     `color: #fff` to any rule; add `transition: opacity 200ms` to any rule. */
  const legacy = new Set(cssRules(strip(read("styles.css"))).flatMap((r) => selectorsOf(r.prelude).flatMap((s) => [...s.matchAll(/\.([A-Za-z][\w-]*)/g)].map((x) => x[1]))));
  const heads = [/^\.ag(?![\w-])/, /^\.room\.sh-room(?![\w-])/, /^\.page\.sh-body$/, /^body\.view-show(?![\w-])/];
  let seen = 0;
  for (const r of SHOW_RULES) {
    if (r.prelude.startsWith("@")) continue;
    for (const s of selectorsOf(r.prelude)) {
      seen++;
      assert.ok(heads.some((h) => h.test(s)), `selector "${s}" is not scoped under .ag / the Room / body.view-show`);
      /* `body.view-show .topbar` names the legacy bar on purpose: it is the one rule that HIDES it (as Today's does). */
      for (const c of s.startsWith("body.view-show") ? [] : [...s.matchAll(/\.([A-Za-z][\w-]*)/g)].map((x) => x[1])) {
        if (/^(ag|room|page|view-show|sh-[\w-]+|raised)$/.test(c) || ["t-title", "t-caption"].includes(c)) { if (c.startsWith("sh-")) assert.ok(!legacy.has(c), `.${c} is already a styles.css class`); continue; }
        assert.ok(/^(ag-btn|icon|td-row|clamp2|is-following)/.test(c) || ["ag-art", "note"].includes(c), `class .${c} is not a new name`);
      }
    }
    for (const d of r.body.split(";")) {
      const v = d.slice(d.indexOf(":") + 1);
      if (/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i.test(v)) assert.fail(`literal colour in ${r.prelude}: ${d}`);
      if (/^\s*(transition|animation)/.test(d) && /(^|[\s,(])\d*\.?\d+m?s\b/.test(v)) assert.fail(`raw duration in ${r.prelude}: ${d}`);
    }
  }
  assert.ok(seen >= 15, `fixture assumption: the sheet's selectors are read (${seen})`);
  assert.ok(!/prefers-reduced-motion/.test(SHOW_CSS_RAW), "no second reduced-motion block: ui/tokens.css owns the one");
  assert.ok(!/\bstyle\s*=/.test(read("ui/show.js").slice(read("ui/show.js").indexOf("function showRoomHtml"), read("ui/show.js").indexOf("function renderShow"))), "no inline style attribute in the page's templates");
  assert.ok(!/url\(|@import|https?:/.test(SHOW_CSS), "no image, no import, no origin in the sheet");
});

test("the page is wired: linked after the primitives it composes, shipped by the SW generation, the web dist and the app bundle, the body class and the legacy bar", async () => {
  /* MUTATIONS (each run red): remove "ui/show.css" from SHELL in tools/ci/generate-manifest.mjs, from SHELL in
     tools/web/prepare-dist.mjs or from SHELL_FILES in tools/mobile/prepare-webdir.mjs; drop the <link> from index.html;
     drop the view-show class from renderShow; drop `.sh-head` from pageHeading() (landOnPage would name no page). */
  const html = read("index.html");
  assert.ok(html.includes('<link rel="stylesheet" href="ui/show.css">'), "linked");
  for (const dep of ["ui/tokens.css", "ui/primitives.css", "ui/today.css"]) assert.ok(html.indexOf("ui/show.css") > html.indexOf(dep), `after ${dep}`);
  assert.ok(/"ui\/show\.css"/.test(read("tools/ci/generate-manifest.mjs")), "generate-manifest SHELL");
  assert.ok(/"ui\/show\.css"/.test(read("tools/web/prepare-dist.mjs")), "prepare-dist SHELL");
  const pw = await import(pathToFileURL(path.join(ROOT, "tools", "mobile", "prepare-webdir.mjs")).href);
  assert.ok(pw.SHELL_FILES.includes("ui/show.css") && pw.buildPlan(ROOT).includes("ui/show.css"), "the app bundle");
  assert.match(read("ui/show.js"), /document\.body\.classList\.add\("view-show"\)/, "renderShow marks the body");
  assert.strictEqual(showValue("body.view-show .topbar", "display"), "none", "the legacy bar steps aside");
  assert.strictEqual(showValue("body.view-show #view", "padding-top"), "0");
  /* the heading is the page's name: landOnPage() reads `.sh-head h2` */
  const m = mount();
  const h2 = { textContent: "Show One" };
  const view = { querySelector: (sel) => (sel === ".page-head" ? null : sel === ".sh-head" ? { querySelector: (s2) => (s2 === "h2" ? h2 : null) } : null) };
  assert.strictEqual(m.ctx.pageHeading(view), h2, "pageHeading finds the Room's heading");
  /* and the page uses the one body class through the real route */
  const body = m.body;
  m.ctx.renderShow("s-1");
  assert.ok(body.classList.contains("view-show"), "rendering a show adds view-show");
  m.ctx.setBodyClass("view-page");
  assert.ok(!/view-show/.test(body.className), "and the next page's setBodyClass takes it away again (it rewrites the whole className)");
});

test("a missing show has no Room, so it does not take the Room's chrome: view-show stays off for every status page", () => {
  /* MUTATION (run red): move `document.body.classList.add("view-show")` in renderShow back above the
     `if (!show) { resolveMissingShow(...); return; }` guard. Then body.view-show hides .topbar and zeroes #view's top
     padding for a page whose head and Back have no safe-area inset of their own (notched iPhone, edge-to-edge Android).
     HARNESS AUDIT: the body starts WITH view-show (a Room was on screen a moment ago); the render must drop it, and
     with the add above the guard it is put straight back, so the test cannot pass on a clean body by accident. */
  const m = mount();
  for (const id of ["pi:unknown", "no-such-show"]) {
    m.ctx.renderShow("s-1");
    assert.ok(m.body.classList.contains("view-show"), "precondition: a real show carries view-show");
    m.ctx.renderShow(id);
    assert.ok(!m.body.classList.contains("view-show"), `an unknown id (${id}) leaves view-show off`);
    assert.match(m.byId.get("view").innerHTML, /back/i, `${id}: the status page paints its own Back`);
  }
});
