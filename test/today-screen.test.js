/* Today (Redesign 2026, Tactile Home): the glue between Dial's primitives and
 * the app's own engines, and the screen's measured rules.
 *
 * test/home-v2.test.js, home-play.test.js and home-v2-real-data.test.js pin what
 * Today SHOWS and what its keys DO. This suite pins the seams that make that
 * possible without the engines learning a new look:
 *
 *  1. A control that draws its own state (`data-ctl-icons`) is never written
 *     text by the engines (app.js setControlLabel; player/client.js
 *     paintControl), so Play and Pause stay sprite icons and "+ Up Next" never
 *     falls back to a "+" or a check mark character.
 *  2. The primitives' engine hooks are opt-in: with no `id` a row, a bridge and
 *     a keycap are the gallery specimens they always were.
 *  3. "+ Up Next" says "Queued" in --good for two seconds, then settles.
 *  4. The knob is the drawer's opener while Today is on screen, and focus goes
 *     back to it.
 *  5. The measured layout (BUILD-NOTES 4.1) is the CSS's, not an accident of the
 *     render: hero rhythm 10/12/10/12/16, the 44px target of "+ Up Next" without
 *     a taller meta line, the hero band at full enamel.
 *  6. The gauge is exactly the specified readout: a role=img, the caption word
 *     for word, no input, nothing focusable.
 *
 * Every test names the mutation that kills it, per CLAUDE.md.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");

const ROOT = path.join(__dirname, "..");
const APP_SRC = readAppSource();
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");

process.on("unhandledRejection", () => {});

function makeEl(tag) {
  return {
    tagName: String(tag || "div").toUpperCase(),
    id: null, className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {}, click() {},
    remove() {},
  };
}

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn", "banner-slot",
  "pl-form", "pl-input", "pl-note", "sh-form", "sh-input", "sh-note", "sh-results",
];

function mount({ seed = {} } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const body = makeEl("body");

  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),
    localStorage: {
      get length() { return store.size; },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    document: {
      body, documentElement: body, readyState: "complete",
      addEventListener() {}, createElement: (t) => makeEl(t),
      querySelector: (sel) => {
        const s = String(sel);
        return s.startsWith("#") ? byId.get(s.slice(1)) ?? null : null;
      },
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    addEventListener() {}, removeEventListener() {},
    location: { hash: "#/", search: "", pathname: "/", href: "https://x.test/" },
    history: { replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  runAppSource(APP_SRC, ctx);

  const evalIn = (src) => vm.runInContext(src, ctx);
  return {
    ctx, evalIn, store, body, byId,
    state: evalIn("state"),
    view: () => byId.get("view").innerHTML,
  };
}


const { load, rule, CSS_RULES } = require("./helpers/tactile-primitives.js");
const prim = load();

/* ==================================================================== */
/* 1. THE ENGINES NEVER WRITE TEXT INTO A CONTROL THAT DRAWS ITS OWN STATE */
/* ==================================================================== */

function fakeControl({ ctl }) {
  const attrs = new Map(ctl ? [["data-ctl-icons", ""]] : []);
  let text = "<svg>kept</svg>";
  return {
    attrs,
    get textContent() { return text; },
    set textContent(v) { text = v; },
    hasAttribute: (k) => attrs.has(k),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    setAttribute: (k, v) => { attrs.set(k, String(v)); },
    removeAttribute: (k) => { attrs.delete(k); },
  };
}

test("app.js's setControlLabel renames a data-ctl-icons control and never writes text into it", () => {
  /* MUTATION: drop the `!(btn.hasAttribute && btn.hasAttribute("data-ctl-icons"))`
     guard from setControlLabel -> the icon markup is replaced by "❚❚" and the
     first assertion fails. MUTATION 2: skip the label write for a ctl control ->
     the aria-label assertion fails. */
  const m = mount();
  const ctl = fakeControl({ ctl: true });
  m.ctx.setControlLabel(ctl, "❚❚", "Pause An episode");
  assert.strictEqual(ctl.textContent, "<svg>kept</svg>", "no glyph is written into an icon control");
  assert.strictEqual(ctl.getAttribute("aria-label"), "Pause An episode", "but its name still tracks the state");
  const legacy = fakeControl({ ctl: false });
  m.ctx.setControlLabel(legacy, "❚❚", "Pause An episode");
  assert.strictEqual(legacy.textContent, "❚❚", "a legacy text control is written as ever");
});

test("player/client.js's paintControl has the same guard (it cannot import app.js, so the two are pinned to each other)", () => {
  /* MUTATION: drop the guard from paintControl -> red; the player then paints a
     "▶" over the keycap's icon four times a second. */
  const src = fs.readFileSync(path.join(ROOT, "player", "client.js"), "utf8").replace(/\r\n/g, "\n");
  const fn = src.slice(src.indexOf("function paintControl("), src.indexOf("function buildUI()"));
  assert.match(fn, /!\(btn\.hasAttribute && btn\.hasAttribute\("data-ctl-icons"\)\) && btn\.textContent !== text/);
  const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8").replace(/\r\n/g, "\n");
  const twin = app.slice(app.indexOf("function setControlLabel("), app.indexOf("function setStatusText("));
  assert.match(twin, /!\(btn\.hasAttribute && btn\.hasAttribute\("data-ctl-icons"\)\) && btn\.textContent !== text/);
});

/* ==================================================================== */
/* 2. THE HOOKS ARE OPT-IN                                               */
/* ==================================================================== */

test("a keycap carries engine hooks only when asked: data-* names are checked and values escaped, swapIcon marks it data-ctl-icons", () => {
  /* MUTATION: drop the name check (`/^[a-z][a-z0-9-]*$/`) -> the `onclick` and
     `x y` entries become attributes. MUTATION 2: drop esc() around the value ->
     the quote breaks out. MUTATION 3: add data-ctl-icons without swapIcon -> the
     plain key fails. */
  const plain = prim.tactileKeycap({ icon: "ph-play-fill", label: "Play" });
  assert.doesNotMatch(plain, /data-ctl-icons|data-play/);
  const hooked = prim.tactileKeycap({ icon: "ph-play-fill", swapIcon: "ph-pause-fill", label: "Play", data: { play: 'a"b', title: "T", "onclick": "x", "x y": "z", "Bad": "q" } });
  assert.match(hooked, / data-play="a&quot;b"/);
  assert.match(hooked, / data-title="T"/);
  assert.match(hooked, / data-onclick="x"/, "a lower-case name is a data attribute, not an event handler");
  assert.doesNotMatch(hooked, / onclick=|data-x y|data-Bad|data-bad/);
  assert.match(hooked, / data-ctl-icons/);
  assert.strictEqual((hooked.match(/<svg /g) || []).length, 2, "the play icon and the pause icon");
  assert.match(hooked, /class="i i--lg? ?i--swap"|class="i i--swap"/);
});

test("an episode row and a bridge are the gallery specimens until they are handed an id", () => {
  /* MUTATION: emit data-upnext / data-play unconditionally -> the specimen
     assertions fail (the gallery would offer controls wired to nothing). */
  const specimen = prim.tactileEpisodeRow({ title: "T", show: "S", duration: "35 min", why: "Why." });
  assert.doesNotMatch(specimen, /data-play|data-upnext|data-ctl-icons|row__link|data-branch/);
  assert.match(specimen, /<button type="button" class="row__queue" aria-label="Add to Up Next: T">/);
  const wired = prim.tactileEpisodeRow({ id: "e1", link: "episode", title: "T", show: "S", duration: "35 min", branch: "history", queued: false });
  assert.match(wired, /data-play="e1"/);
  assert.match(wired, /data-upnext="e1" data-ctl-icons/);
  assert.match(wired, /data-branch="history"/);
  const bridge = prim.tactileBridgeCard({ title: "T", show: "S", duration: "35 min" });
  assert.doesNotMatch(bridge, /data-play|data-upnext|row__link/);
});

test("a row offers only the controls the engines will honour: no audio, no Play key; not queueable, no Up Next", () => {
  /* playBtn and upNextBtn refuse an episode with no audio, and a row that drew
     them anyway would be a control that does nothing.
     MUTATION: ignore `playable === false` / `queueable === false` in
     tactilePlayKey / tactileQueueAction -> both controls render. */
  const row = prim.tactileEpisodeRow({ id: "e1", link: "episode", title: "T", show: "S", playable: false, queueable: false });
  assert.doesNotMatch(row, /<button/);
  assert.match(row, /class="row__end"><\/div>/);
});

test("the three states of '+ Up Next' are drawn as sibling spans, and the engines pick between them with `on` and `is-fresh`", () => {
  /* MUTATION: drop the `.row__queue.on.is-fresh .row__queue-fresh` rule -> the
     fresh state shows nothing. MUTATION 2: render only one label span -> the
     count fails. */
  const row = prim.tactileEpisodeRow({ id: "e1", link: "episode", title: "T", show: "S", queued: true });
  assert.match(row, /class="row__queue on"/);
  assert.deepStrictEqual([...row.matchAll(/<span class="row__queue-(off|fresh|on)">([^<]*)</g)].map((x) => [x[1], x[2]]),
    [["off", "Up Next"], ["fresh", "Queued"], ["on", "In Up Next"]]);
  assert.match(rule(".row__queue.on.is-fresh .row__queue-fresh"), /display:\s*inline/);
  assert.match(rule(".row__queue.on.is-fresh .row__queue-on"), /display:\s*none/);
  assert.match(rule(".row__queue.is-fresh"), /color:\s*var\(--good\)/, "Queued is --good");
});

/* ==================================================================== */
/* 3. TWO SECONDS OF "QUEUED"                                            */
/* ==================================================================== */

test("a Dial '+ Up Next' control shows Queued for two seconds and then settles; a legacy one is left alone", (t) => {
  /* MUTATION: change QUEUED_FRESH_MS to 200 -> the 1999ms assertion fails;
     delete the clearTimeout -> a second tap's earlier timer ends the second
     window early (last assertion). */
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const m = mount();
  const classes = (c) => ({
    set: new Set(), add(x) { this.set.add(x); }, remove(x) { this.set.delete(x); }, contains(x) { return this.set.has(x); },
    toggle() {},
  });
  const dial = { ...fakeControl({ ctl: true }), classList: classes() };
  const legacy = { ...fakeControl({ ctl: false }), classList: classes() };
  m.ctx.markQueuedFresh(legacy);
  assert.ok(!legacy.classList.contains("is-fresh"), "a text control has no fresh state");
  m.ctx.markQueuedFresh(dial);
  assert.ok(dial.classList.contains("is-fresh"));
  t.mock.timers.tick(1999);
  assert.ok(dial.classList.contains("is-fresh"), "still Queued at 1999ms");
  t.mock.timers.tick(1);
  assert.ok(!dial.classList.contains("is-fresh"), "quiet at 2000ms");
  m.ctx.markQueuedFresh(dial);
  t.mock.timers.tick(1500);
  m.ctx.markQueuedFresh(dial);              // a second tap restarts the window
  t.mock.timers.tick(1500);
  assert.ok(dial.classList.contains("is-fresh"), "the first tap's timer did not cut the second window short");
});

/* ==================================================================== */
/* 4. THE KNOB IS THE DRAWER'S OPENER                                    */
/* ==================================================================== */

test("with Today on screen the knob is the drawer's opener: it carries aria-expanded and gets focus back", () => {
  /* MUTATION: make menuOpener() return $("#menu-btn") always -> the knob's
     aria-expanded never changes and focus returns to a hidden control. */
  const m = mount();
  const topbarMenu = m.byId.get("menu-btn");
  assert.strictEqual(m.evalIn("menuOpener()"), topbarMenu, "every other page: the topbar's menu button");
  const knob = { id: "today-knob" };
  m.byId.set("today-knob", knob);
  assert.strictEqual(m.evalIn("menuOpener()"), knob, "Today: the knob, while it is in the page");
  /* openDrawer and the sheet stack both ask for the opener through it. */
  assert.match(APP_SRC, /const menu = menuOpener\(\);/, "openDrawer reads aria-expanded and focus return through it");
  assert.match(APP_SRC, /returnFocus: opts\.returnFocus \|\| \(fromDrawer \? menuOpener\(\) : null\)/, "and so does a sheet opened from the drawer");
});

test("bindTodayKnob names what the knob controls and opens the drawer", () => {
  /* MUTATION: drop `knob.setAttribute("aria-controls", "drawer")` -> red;
     toggle with `openDrawer(true)` only -> the second press does not close. */
  const m = mount();
  m.byId.get("drawer").hidden = true;          // the stub's elements start unhidden: a closed drawer is hidden
  const attrs = {};
  const handlers = {};
  const knob = { setAttribute: (k, v) => { attrs[k] = String(v); }, addEventListener: (t, f) => { handlers[t] = f; } };
  m.ctx.bindTodayKnob({ querySelector: (sel) => (sel === "#today-knob" ? knob : null) });
  assert.strictEqual(attrs["aria-controls"], "drawer");
  assert.strictEqual(attrs["aria-expanded"], "false");
  const calls = [];
  m.ctx.openDrawer = (v) => { calls.push(v); };
  m.evalIn("drawerIsOpen = () => false");
  handlers.click();
  m.evalIn("drawerIsOpen = () => true");
  handlers.click();
  assert.deepStrictEqual(calls, [true, false], "press opens, press again closes");
});

/* ==================================================================== */
/* 5. THE MEASURED LAYOUT                                                */
/* ==================================================================== */

const px = (v, vars = {}) => {
  const e = String(v).replace(/var\(--([\w-]+)\)/g, (_m, n) => vars[n] ?? `var(--${n})`);
  return Function(`"use strict"; return (${e.replace(/calc/g, "").replace(/(\d+(?:\.\d+)?)px/g, "$1")});`)();
};
const SPACE = { "s-1": "4px", "s-2": "8px", "s-3": "12px", "s-4": "16px", "s-5": "20px", "s-6": "24px", "s-8": "32px" };

test("the hero's rhythm is eyebrow 10 title 12 band 10 meta 12 why 16 keys, inside a 20px card", () => {
  /* BUILD-NOTES 4.1: "gaps: eyebrow -> title 10, title -> band 12, band ->
     discs 10, discs -> why 12, why -> keys 16 (r1's uniform 12 plus 32/36 at
     three lines made the hero 420px)".
     MUTATION: change `.today-hero__keys { margin-top }` to var(--s-3) -> the 16
     fails (and the hero grows by nothing visible, which is why it is pinned). */
  const get = (sel) => px((/margin-top:\s*([^;]+);/.exec(rule(sel)) || [])[1], SPACE);
  assert.strictEqual(get(".today .today-hero__title"), 10, "eyebrow -> title");
  assert.strictEqual(get(".today-hero__band"), 12, "title -> band");
  assert.strictEqual(get(".today-hero__meta"), 10, "band -> discs");
  assert.strictEqual(get(".today .today-hero__why"), 12, "discs -> why");
  assert.strictEqual(get(".today-hero__keys"), 16, "why -> keys");
  assert.match(rule(".card--hero"), /padding:\s*var\(--s-5\)/, "20px");
  assert.match(rule(".today .today-hero__title"), /clamp\(1\.75rem, 7\.2vw, 2rem\)/);
  assert.match(rule(".today .today-hero__title"), /line-height:\s*1\.2/);
  assert.match(rule(".today .today-hero__link"), /-webkit-line-clamp:\s*3/, "a title takes three lines at most");
  /* The title is the card's one link (the card is not a link), so even a
     one-line title is a 44px target: the hard limit beats the 10px rhythm for
     that one case. MUTATION: delete `min-height: var(--tap)` -> gates.mjs reports
     the link at 28px, and this fails. */
  assert.match(rule(".today .today-hero__link"), /min-height:\s*var\(--tap\)/);
});

test("'+ Up Next' has a 44px target without making its meta line taller: a 24px box (4px padding, cancelled by margin) plus 10 above and below", () => {
  /* WCAG 2.5.8 wants 24px by the element's own box (axe's target-size), the hard
     limit 44px by hit-test (gates.mjs). The padding and the negative margin
     cancel, so the meta line stays 16px; the ::before reaches the other 20.
     MUTATION: change the `inset: -10px 0` to `-6px 0` -> 36px, red.
     MUTATION 2: remove the padding -> the box is 16px and axe's target-size
     flags it; red here. MUTATION 3: give `.today .row__queue` a min-height ->
     the meta line grows. */
  const before = rule(".today .row__queue::before");
  const inset = /inset:\s*(-?\d+)px (-?\d+)(?:px)?/.exec(before);
  assert.ok(inset, "the hit-area extension exists");
  const box = rule(".today .row__queue");
  assert.match(box, /padding:\s*var\(--s-1\) 0/, "4px of padding makes the box 24px tall");
  assert.match(box, /margin:\s*calc\(-1 \* var\(--s-1\)\) 0 calc\(-1 \* var\(--s-1\)\) var\(--s-1\)/, "and the margin takes it back, so the line does not grow (and keeps 4px of air from the length, off the title link's 44px square)");
  assert.match(rule(".today .row__title"), /text-wrap:\s*balance/, "two even title lines keep the link narrow");
  const lineHeight = 16;
  const tall = lineHeight + 2 * 4 + 2 * Math.abs(Number(inset[1]));
  assert.ok(tall >= 44, `${tall}px tall`);
  assert.match(box, /min-height:\s*0/);
  assert.match(box, /position:\s*relative/);
});

test("Today carries no deck of its own: the live deck (ui/tabbar.js) is the one tab bar on every screen", () => {
  /* Iteration 1 drew the Dial deck on `body.view-home` only, over the legacy four-tab bar.
     The direction branch has since merged the live deck (three tabs, Phosphor icons in
     both weights, the mini docked on it), so a Today-scoped copy would hide that deck's
     icons: the merged build rendered Today's tabs as bare labels until these rules went.
     MUTATION: restore `body.view-home .tab-btn svg:not(.tab-dial) { display: none }` ->
     the tab icons vanish on Today and this fails. */
  const rogue = [...CSS_RULES.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((x) => x[1].trim())
    .filter((sel) => /view-home/.test(sel) && /#tab-bar|\.tab-btn|\.tab-dial/.test(sel));
  assert.deepStrictEqual(rogue, [], "a Today-scoped rule restyles the deck");
});

test("the hero band is a foray not yet played: full enamel, not the 40% base the progress layer sits over", () => {
  /* The prototype's idle band is full colour; the primitive's base layer is 40%
     so progress can fill over it. MUTATION: delete `.today-hero .t-band__base
     { opacity: 1 }` -> the whole hero band is washed out (the 1.0 build reads
     as pale dashes). */
  assert.match(rule(".today-hero .t-band__base"), /opacity:\s*1/);
  assert.match(rule(".t-band__base"), /opacity:\s*\.4/, "the primitive's own base stays 40%");
});

test("a paper key keeps its edge on its face, the knob is the primitive's 48 x 44 key, and the readout words sit close", () => {
  /* MUTATION: delete `.keycap--paper::before { box-shadow }` -> Details vanishes
     into the card (both are --card); the edge lives on the face because the
     element's own inset shadow would be painted UNDER the face pseudo-element.
     MUTATION 2: add `width: var(--tap); padding: 0` back to `.today-top .keycap`
     -> the knob is a 44px square, 4px narrower than the prototype's 48 (an icon
     and the small key's 12px side padding); the 48 x 44 rendered box is pinned by
     the fidelity run. */
  assert.match(rule(".keycap--paper::before"), /box-shadow:\s*inset 0 0 0 calc\(var\(--s-1\) \/ 4\) var\(--dial-line\)/);
  assert.doesNotMatch(rule(".today .keycap--paper"), /box-shadow/, "no element-level shadow: it would sit under the face");
  assert.doesNotMatch(rule(".today-top .keycap"), /width|padding/);
  assert.match(rule(".today .readout"), /word-spacing:\s*-0\.2em/);
});

/* ==================================================================== */
/* 6. NEW GROUND, EXACTLY                                                */
/* ==================================================================== */

test("New ground is the specified gauge: role=img, the caption word for word, no input, nothing focusable", () => {
  /* BUILD-NOTES 3.7: "role=img with the same text as aria-label; no focus, no
     :active, no input". MUTATION: change one word of the caption, add an
     <input type=range> to tactileGauge, or add tabindex to the figure -> red. */
  const m = mount();
  m.state.catalog = { shows: [] }; m.state.discover = { items: [] }; m.state.taxonomy = { nodes: [] };
  m.state.session = { session_id: "s", builder: "t", episodes: {}, cards: [] };
  m.state.cardSlots = [];
  m.ctx.renderHome();
  const html = m.view();
  const gauge = /<figure class="gauge"[\s\S]*?<\/figure>/.exec(html)[0];
  assert.match(gauge, /role="img"/);
  assert.match(gauge, /<p>About a third of today sits outside your usual subjects\. 4a keeps it that way\.<\/p>/);
  assert.match(gauge, /<span class="readout">1 in 3<\/span>/);
  assert.match(gauge, /<span class="heading">New ground<\/span>/);
  assert.doesNotMatch(gauge, /<input|tabindex|<button|<a /);
  assert.ok(gauge.indexOf("gauge__needle") > gauge.indexOf("gauge__fill"));
  assert.strictEqual("About a third of today sits outside your usual subjects. 4a keeps it that way.".split(" ").length, 15, "15 words: under the 18 ceiling");
  assert.doesNotMatch(rule(".gauge"), /cursor:\s*pointer|touch-action/);
  assert.match(rule(".gauge__well"), /height:\s*var\(--s-6\)/, "a 24px well");
  assert.match(rule(".gauge__needle"), /top:\s*calc\(-1 \* \(var\(--s-2\) \+ var\(--s-1\) \/ 2\)\)/, "the needle stands 10px above the well, its cap at the top");
  assert.match(rule(".gauge__fill"), /calc\(var\(--s-1\) \* \.75\)[\s\S]*calc\(var\(--s-1\) \* 1\.5\)/, "the hatch is 3px lines with 3px gaps");
  assert.match(CSS_RULES, /\.bridge__arc \{[^}]*calc\(var\(--art-row\) \+ var\(--s-4\)\)/, "the bridge's third column is the 72px stretch artwork");
});

/* ==================================================================== */
/* 7. COPY                                                               */
/* ==================================================================== */

test("the hero says its why-line only when it fits the ceiling, and the first-run line replaces it, never joins it", () => {
  /* CLAUDE.md copy rules: why-lines at most 18 words. MUTATION: drop the
     `<= TODAY_WHY_WORDS` check -> a 19-word summary is printed. MUTATION 2:
     render both the first-run line and the why -> the count assertion fails. */
  const m = mount();
  const foray = { id: "f", title: "Title", summary: "word ".repeat(19).trim() };
  const r = { totalSec: 600, playable: [] };
  const model = m.ctx.todayHeroModel({ foray, r });
  assert.strictEqual(model.why, "", "a 19-word summary is not a why-line");
  const fit = m.ctx.todayHeroModel({ foray: { ...foray, summary: "Short and honest." }, r });
  assert.strictEqual(fit.why, "Short and honest.");
  const first = m.ctx.todayHeroHtml(fit, { firstRun: true });
  assert.strictEqual((first.match(/class="today-hero__why"/g) || []).length, 1);
  assert.match(first, />4a starts with wide bets\. Each listen narrows the dial\.</);
  assert.doesNotMatch(first, /Short and honest/, "the first-run line takes the why-line's slot, it does not sit beside one");
  assert.ok(m.evalIn("TODAY_FIRST_RUN_LINE").split(" ").length <= 18);
});

test("a Resume or hero title the listener's feed controls is escaped, and the date is written, not locale-formatted", () => {
  /* MUTATION: interpolate `foray.title` without esc() in todayHeroHtml -> red.
     MUTATION 2: use toLocaleDateString in todayDateLine -> the shape moves with
     the device's language. */
  const m = mount();
  const evil = '<img src=x onerror=1>"';
  const html = m.ctx.todayHeroHtml({ foray: { id: "f", title: evil }, discs: [], segments: [], facts: "", why: "", bandLabel: "" });
  assert.ok(!html.includes("<img"));
  assert.match(html, /&lt;img src=x onerror=1&gt;&quot;/);
  assert.strictEqual(m.ctx.todayDateLine(new Date(2026, 9, 5)), "Mon 5 Oct");
  assert.strictEqual(m.ctx.todayDateLine(new Date(2026, 0, 1)), "Thu 1 Jan");
});
