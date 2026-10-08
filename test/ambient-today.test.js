/* Redesign 2026, ambient direction ("Afterglow"), phase 4: TODAY (Home).
 *
 * docs/redesign-2026/directions/ambient/BUILD-NOTES.md §4.1, §10.3, §10.5, §10.6 and BUILD-PLAN.md §2.1.3
 * are the specification; ui/home.js (todayHtml and friends), ui/today.css and ui/palette.js are the build.
 * test/home-v2.test.js, home-v2-real-data.test.js, home-play.test.js, card-anatomy.test.js and the other
 * Home suites carry the behaviour they always carried (the floor, the bridge copy, the badges, the play
 * conventions), rewritten for Today; THIS suite pins what Today adds, one acceptance line at a time:
 *
 *   1-2   the Glow palette: the table is the prototype's, the clamp is the direction's, and nothing but
 *         numbers ever reaches a style
 *   3     the header: wordmark left, the 44px gear right, the date line
 *   4     HeroPick: collage (160, whole first square), eyebrow, four-line title, Play 56, two-line why
 *   5-6   the wash: 48vh, the three layers, the 52% hot spot on the collage; and the contrast pair that
 *         makes it legal (text-2 measures under AA there, --on-wash-2 does not)
 *   7     first run: the hero IS the first pick, the list is one shorter, no Keep listening
 *   8-9   Keep listening (only mid-listen, with its Ember rim) and Playlists for you (the one scroller)
 *   10    Off your path draws only from outside the top tier and the Stretch's own subject
 *   11    offline: the banner, the dimmed rows, the disabled Play, the downloaded row that still plays
 *   12    loading: the skeleton, the lamp sweep, the boot screen
 *   13-14 pick to play: Glow moves first, the row takes its state, the art flies to the mini slot
 *   15    hostile data goes through esc(), hostile routes are encoded
 *   16    the stylesheet's own rules: scoped, one reduced-motion owner, no inline style, shipped
 *
 * Every test names the one-line mutation that makes it fail, and each was run (the suite's header in the
 * PR lists them). A green test is not evidence until you have broken it (CLAUDE.md).
 */

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
const APP_SRC = readAppSource();
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const TODAY_CSS = read("ui/today.css").replace(/\/\*[\s\S]*?\*\//g, " ");
const PALETTE_SRC = read("ui/palette.js");

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
const RULES = cssRules(TODAY_CSS);
/* Top-level comma split: a comma inside :where() / :is() / calc() is not a list separator. */
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
/** The last unconditional value `prop` gets on exactly `sel` (a rule inside @media / @supports is a variant, not the rule). */
function valueOf(sel, prop) {
  let v = null;
  for (const r of RULES) {
    if (r.prelude.startsWith("@") || r.atRules.length || !selectorsOf(r.prelude).includes(sel)) continue;
    for (const d of r.body.split(";")) {
      const c = d.indexOf(":");
      if (c >= 0 && d.slice(0, c).trim() === prop) v = d.slice(c + 1).trim();
    }
  }
  return v;
}

/* ---------------------------------------------------------------- the app, in a node:vm */
function makeEl(tag) {
  return {
    tagName: String(tag || "div").toUpperCase(), id: null, className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild(k) { this.children.push(k); return k; }, append() {},
    setAttribute() {}, getAttribute: () => null, removeAttribute() {}, querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {}, click() {}, remove() {},
  };
}
const PAGE_IDS = ["view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle", "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn", "banner-slot", "pl-form", "pl-input", "pl-note", "sh-form", "sh-input", "sh-note", "sh-results"];

/** Today's fixture: a returning listener (history), four subject slots with a Stretch, eight subjects so a lower
    tier exists, one published Foray that resolves over five shows, and a recording documentElement. */
function mount({ onLine = true, seed = {}, vars = {}, hero = "foray", player = {} } = {}) {
  const store = new Map(Object.entries({ cp_history: JSON.stringify(["played-before"]), ...seed }));
  const byId = new Map(PAGE_IDS.map((id) => { const el = makeEl("div"); el.id = id; return [id, el]; }));
  const body = makeEl("body");
  const rootStyle = [];
  const docEl = makeEl("html");
  docEl.style = { setProperty: (k, v) => rootStyle.push([k, v]) };
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),
    localStorage: {
      get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); },
    },
    document: {
      body, documentElement: docEl, readyState: "complete", addEventListener() {}, createElement: (t) => makeEl(t),
      querySelector: (sel) => { const s = String(sel); return s.startsWith("#") ? byId.get(s.slice(1)) ?? null : null; },
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node", onLine },
    getComputedStyle: () => ({ getPropertyValue: (p) => vars[p] || "" }),
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
  state.catalog = { shows: [] };
  state.taxonomy = { nodes: ["engineering", "business", "comedy", "arts", "history", "travel", "sports", "food"].map((id) => ({ id, parent: null, label: id[0].toUpperCase() + id.slice(1), weight: 0.5 }))
    .concat([{ id: "history/ancient", parent: "history", label: "Ancient history", weight: 0.5 }]) };
  state.session = { session_id: "s", builder: "t", episodes: {}, cards: [] };
  /* Eight subjects in the pool, so the 60% cut leaves a lower tier (sports, food) beside the Stretch's own (comedy);
     "history/ancient" is a leaf outside every slot, so Playlists for you has a generated playlist to draw. */
  state.interests = { engineering: 0.9, business: 0.8, arts: 0.7, history: 0.6, travel: 0.14, sports: 0.13, food: 0.12, comedy: 0.1, "history/ancient": 0.8 };
  const ep = (id, show, topic, extra = {}) => ({ id, title: `Title ${id}`, show, duration_min: 30, topics: [topic], release_date: "2026-09-10", audio_url: `https://cdn.test/${id}.mp3`, artwork_url: `https://is1-ssl.mzstatic.com/image/thumb/P/v4/${id}/600x600bb.jpg`, hook: `Why ${id} matters.`, ...extra });
  const pool = ["engineering", "business", "arts", "history", "travel", "sports", "food", "comedy"].map((b) => ep(`pool-${b}`, `Show ${b}`, b));
  const ancient = [1, 2, 3].map((i) => ep(`anc-${i}`, `Ancient Show ${i}`, "history/ancient", { release_date: `2026-09-0${i}` }));
  state.discover = { items: pool.concat(ancient) };
  state.cardSlots = [
    { branch: "engineering", role: "top", item: ep("top-1", "Eng Weekly", "engineering"), items: [ep("top-1", "Eng Weekly", "engineering"), ep("top-1b", "Eng Weekly", "engineering")] },
    { branch: "business", role: "top", item: ep("top-2", "Biz Daily", "business"), items: [ep("top-2", "Biz Daily", "business"), ep("top-2b", "Biz Daily", "business")] },
    { branch: "arts", role: "top", item: ep("top-3", "Arts Hour", "arts"), items: [ep("top-3", "Arts Hour", "arts"), ep("top-3b", "Arts Hour", "arts")] },
    { branch: "comedy", role: "stretch", item: ep("stretch-1", "Laugh Hour", "comedy"), items: [ep("stretch-1", "Laugh Hour", "comedy")] },
  ];
  state.forays = { forays: [] };
  ctx.forayDownloads = { store: { normaliseDownloads: (v) => ({ settings: { cellular: false }, items: {}, ...(v || {}) }) } };
  const names = ["Alpha Show", "Beta Show", "Gamma Show", "Delta Show", "Echo Show"];
  ctx.ForayPlayer = {
    listForays: () => (hero === "foray" ? [{ id: "foray-a", title: "A Foray Title", topic: "engineering/energy", status: "published", summary: "A short account of five shows." }] : []),
    resolve: () => ({ id: "foray-a", title: "A Foray Title", totalSec: 2520, playable: [{ type: "segment", show: names[0] }, { type: "narration" }, ...names.slice(1).map((show) => ({ type: "segment", show }))] }),
    forayResumeList: () => [], stripTally: () => ({ shows: 5, clips: 4, bridges: 1 }), fmtSpan: (s) => `${Math.round(s / 60)} min`,
    segmentStripHtml: () => "", applyStripGrow() {}, isPlaying: () => false, isCurrent: () => false, ...player,
  };
  return { ctx, evalIn, state, store, rootStyle, docEl, view: () => byId.get("view").innerHTML };
}

const heroOf = (html) => html.slice(html.indexOf('<section class="td-hero"'), html.indexOf("</section>", html.indexOf('<section class="td-hero"')) + 10);

/* ================================================================== 1-2. the palette */

test("the palette table is the prototype's palettes.json: every show hashes to its pair, nothing else is in it", () => {
  /* The numbers are committed from the prototype's build script (BUILD-PLAN 0.2); keyed by fnv1a(name), not the name,
     so a show's title is never scanned as listener copy. MUTATION: change one pair in AG_PALETTES (or drop a key) in
     ui/palette.js -> red, naming the show. */
  const proto = JSON.parse(read("docs/redesign-2026/directions/ambient/prototype/palettes.json"));
  const ctx = { Math, Object, String, Number, document: {} };
  vm.createContext(ctx);
  vm.runInContext(`${PALETTE_SRC}\nthis.__t = { AG_PALETTES, agFnv1a };`, ctx);
  const { AG_PALETTES, agFnv1a } = ctx.__t;
  const have = Object.entries(proto).filter(([, v]) => Array.isArray(v));
  assert.ok(have.length >= 40, `fixture assumption: the prototype carries its pairs (${have.length})`);
  for (const [name, pair] of have) assert.deepStrictEqual([...AG_PALETTES[agFnv1a(name)]], pair, `${name}: the pair`);
  assert.strictEqual(Object.keys(AG_PALETTES).length, have.length, "and the table holds nothing the prototype does not");
  assert.ok(!/Science Vs|Planet Money/.test(PALETTE_SRC), "no show name is spelled in the source (the table is hashed)");
});

test("Glow is clamped for mood (L from the live token, chroma 0.07 to 0.14), and only numbers ever reach a style", () => {
  /* BUILD-NOTES 1.2: Dusk L 0.66, Dawn 0.56 (the --glow-l token), chroma capped at 0.14, hash hue at chroma 0.10 for a
     show not in the table. MUTATION: drop the Math.min(0.14, ...) clamp -> the 0.155 pair is not clamped; return the
     name inside the colour string -> the hostile name shows up in it. */
  const mk = (glowL) => {
    const ctx = { Math, Object, String, Number, document: { documentElement: {} }, getComputedStyle: () => ({ getPropertyValue: () => glowL }) };
    vm.createContext(ctx);
    vm.runInContext(`${PALETTE_SRC}\nthis.__t = { agGlowFor, agPaletteFor, agFnv1a, agSetGlow };`, ctx);
    return ctx.__t;
  };
  const dusk = mk("0.66"), dawn = mk("0.56");
  assert.match(dusk.agGlowFor("Science Vs"), /^oklch\(0\.66 0\.140 15\)$/, "the 0.155 pair clamps to 0.14 at its hue");
  assert.match(dawn.agGlowFor("Science Vs"), /^oklch\(0\.56 0\.140 15\)$/, "Dawn uses the Dawn lightness");
  const unknown = "A Show Nobody Mapped";
  assert.strictEqual(dusk.agGlowFor(unknown), `oklch(0.66 0.100 ${dusk.agFnv1a(unknown) % 360})`, "a hash hue at chroma 0.10");
  assert.match(dusk.agGlowFor("</style><img src=x onerror=1>"), /^oklch\(0\.66 0\.100 \d{1,3}\)$/, "a hostile name cannot reach the colour string");
  assert.strictEqual(dusk.agGlowFor(""), "oklch(0.66 0.05 70)", "no name: the warm neutral");
  const set = []; const el = { style: { setProperty: (k, v) => set.push([k, v]) } };
  dusk.agSetGlow(el, "Science Vs"); dusk.agSetGlow(el, "Science Vs", "--art-glow");
  assert.deepStrictEqual(set.map((x) => x[0]), ["--glow", "--art-glow"], "written through the CSSOM, to the property asked for");
});

/* ================================================================== 3. the header */

test("the header: the wordmark left, the 44px gear right, the date line under it, 'Monday, 5 October'", () => {
  /* MUTATION: change the date format in todayDateLine (e.g. month first) -> red; drop `ag-btn-icon` from the gear
     (a 44px round button comes from that class) -> red; render a second wordmark -> the count assertion fails. */
  const m = mount();
  assert.strictEqual(m.ctx.todayDateLine(new Date(2026, 9, 5)), "Monday, 5 October");
  assert.strictEqual(m.ctx.todayDateLine(new Date(2026, 0, 31)), "Saturday, 31 January");
  m.ctx.renderHome();
  const html = m.view();
  assert.strictEqual((html.match(/class="td-wordmark"/g) || []).length, 1, "one wordmark");
  assert.ok(html.indexOf('class="td-wordmark"') < html.indexOf("data-today-gear"), "left of the gear");
  assert.match(html, /<button type="button" class="ag-btn ag-btn-icon td-gear" data-today-gear aria-label="Settings, Tuning and About">/);
  assert.match(html, /<p class="t-caption td-date">[A-Z][a-z]+, \d{1,2} [A-Z][a-z]+<\/p>/, "the date line is a caption");
  assert.strictEqual(valueOf(".ag .td-wordmark", "font")?.startsWith("italic 500 1.625rem/1.875rem"), true, "Fraunces italic 500 26px");
  assert.strictEqual(valueOf(".ag .td-head", "min-height"), "var(--tap)", "a 44px header row");
  assert.match(m.ctx.todayHeaderHtml(true), /data-today-gear[^>]*disabled/, "the loading header's gear is disabled until the app binds it");
});

/* ================================================================== 4. HeroPick */

test("HeroPick: a 160 collage whose first square is the first show's, the Lamp eyebrow, a four-line title, Play 56, a two-line italic why", () => {
  /* MUTATION: pass `size: 120` to agCollage in todayHeroHtml -> the collage class is wrong; reorder the shows so the
     first show is not first -> its square is not the complete one; drop `clamp4` -> the title may be cut by nothing. */
  const m = mount();
  m.ctx.renderHome();
  const html = m.view();
  const hero = heroOf(html);
  assert.match(hero, /class="ag-collage ag-collage-160 c4 lit-art lit-64"/, "four shows: the 2x2, lit at 64");
  const arts = [...hero.matchAll(/class="ag-art ag-art-160[^"]*" role="img" aria-label="([^"]+)"/g)].map((x) => x[1]);
  assert.deepStrictEqual(arts, ["Alpha Show", "Beta Show", "Gamma Show", "Delta Show"], "the first show's square leads; at most four");
  assert.match(hero, /<span class="eyebrow lamp">Today’s foray<\/span>/);
  assert.match(hero, /<h2 class="t-title clamp4 td-hero-title">/, "title: --t-title, four lines");
  assert.match(hero, /class="ag-btn ag-btn-play ag-btn-size-56" data-home-play/, "Ember Play 56");
  assert.match(hero, /<p class="t-why td-why">A short account of five shows\.<\/p>/, "why-line: italic, full width, never clamped (iteration 3; MUTATION: put clamp2 back on it -> red)");
  assert.match(hero, /<div class="td-hero-actions"><button[^]*?<\/button><p class="t-caption td-hero-meta num">5 shows · 42 min<\/p><\/div>/, "a foray's meta caption sits beside Play");
  const asEpisode = mount({ hero: "none" });
  asEpisode.ctx.renderHome();
  assert.match(heroOf(asEpisode.view()), /<p class="t-caption td-hero-meta">[^<]+ · 30 min<\/p>\s*<div class="td-hero-actions"><button/, "an episode's meta line sits under its title");
  assert.strictEqual(valueOf(".ag .td-why", "grid-column"), "1 / -1", "the why-line spans the pair");
  assert.strictEqual(valueOf(".ag.td-today", "--td-hero-art"), "var(--art-hero)");
  const narrow = RULES.find((r) => r.atRules.some((a) => /max-width:\s*392px/.test(a)) && /\.ag\.td-today/.test(r.prelude));
  assert.ok(narrow && /--td-hero-art:\s*136px/.test(narrow.body), "136 at 375");
});

test("a hero title that cannot fit its four lines steps down one style; one that fits is left alone", () => {
  /* The stress seed's `scrollHeight <= clientHeight` is a layout fact (checked in the gates run); the JS half is the
     step-down. MUTATION: invert the comparison in todayFitHeroTitle -> a fitting title is compacted. */
  const m = mount();
  const el = (sh, ch) => { const added = []; return { scrollHeight: sh, clientHeight: ch, classList: { add: (c) => added.push(c) }, added }; };
  const run = (t) => { m.ctx.todayFitHeroTitle({ querySelector: (sel) => (sel === ".td-hero-title" ? t : null) }); return t.added; };
  assert.deepStrictEqual(run(el(92, 92)), [], "a title that fits (sh == ch) is left alone");
  assert.deepStrictEqual(run(el(93, 92)), [], "a 1px rounding difference is not overflow");
  assert.deepStrictEqual(run(el(152, 92)), ["is-compact"], "two lines too many: one style down");
  assert.match(valueOf(".ag .td-hero-title.is-compact", "font"), /var\(--t-headline\)/);
  assert.match(valueOf(".ag .td-hero-title", "padding-bottom") || "", /calc\(var\(--s-1\) \/ 2\)/, "the 2px that keeps scrollHeight honest");
});

/* ================================================================== 5-6. the wash */

test("the wash: 48vh behind header and hero, three layers, the 52% hot spot centred on the collage", () => {
  /* BUILD-NOTES §4.1 and §10.3, with the prototype's geometry (the hot spot sits on the collage's centre, measured).
     MUTATION: change --td-hot to 30%, drop the `radial-gradient(120% 70% at 22% 20%` layer, or --td-hot-x to a bare
     percentage -> red. */
  assert.strictEqual(valueOf(".ag .td-wash", "height"), "48vh");
  assert.strictEqual(valueOf(".ag .td-wash", "z-index"), "-1");
  assert.strictEqual(valueOf(".ag .td-wash", "pointer-events"), "none");
  assert.strictEqual(valueOf(".ag.td-today", "--td-hot"), "52%");
  assert.strictEqual(valueOf(".ag.td-today", "--td-hc"), "calc(var(--td-hero-art) / 2)", "half the art");
  assert.strictEqual(valueOf(".ag.td-today", "--td-hot-x"), "calc(var(--gutter) + var(--td-hc))", "the gutter plus half the art");
  assert.match(valueOf(".ag.td-today", "--td-hot-y"), /^calc\(var\(--safe-top\) \+ 86px \+ var\(--td-hc\)\)$/, "the header and date, plus half the art");
  const bg = valueOf(".ag .td-wash", "background").replace(/\s+/g, " ");
  assert.ok(bg.includes("radial-gradient(60% 34% at var(--td-hot-x) var(--td-hot-y), color-mix(in oklab, var(--glow) var(--td-hot), transparent) 0%, transparent 100%)"), "the hot spot");
  assert.ok(bg.includes("radial-gradient(120% 70% at 22% 20%, var(--glow-wash) 0%, transparent 70%)"), "the radial from 22% / 20% at Glow-wash");
  assert.ok(bg.includes("linear-gradient(var(--glow-wash), var(--bg0))"), "and the fade into bg0");
  /* --glow is the hero's FIRST show, written on the wash itself */
  const m = mount();
  m.ctx.renderHome();
  assert.match(m.view(), /<div class="td-wash" aria-hidden="true" data-glow-show="Alpha Show"><\/div>/);
  /* The Glow tokens resolve where they are declared, so the wash redeclares them for its own --glow. */
  assert.match(valueOf(".ag .td-wash", "--glow-wash") || "", /color-mix\(in oklab, var\(--bg0\), var\(--glow\) var\(--mix-wash\)\)/);
});

test("the hero's secondary text is --on-wash-2: text-2 is under AA on the hot spot at its worst hue, --on-wash-2 is not", () => {
  /* The AC says text-2 on the hot-spot row clears 4.5:1. Measured, it does not at 52% (3.55:1, worst hue; the tokens
     suite pins the on-wash-2 numbers), which is exactly why ui/tokens.css carries --on-wash-2 (5.49:1) and why the
     prototype wears it on the wash. This pins both halves so nobody "fixes" it back to text-2.
     MUTATION: set `.ag .td-why` (or .td-hero-meta, .td-date, .td-first-run) to `var(--text-2)` -> red. */
  for (const sel of [".ag .td-hero-meta", ".ag .td-date"]) assert.strictEqual(valueOf(sel, "color"), "var(--on-wash-2)", sel);
  for (const sel of [".ag .td-why", ".ag .td-first-run"]) assert.ok(selectorsOf(RULES.find((r) => selectorsOf(r.prelude).includes(sel)).prelude).includes(sel) && valueOf(sel, "color") === "var(--on-wash-2)", sel);
  const dusk = /:root, \[data-theme="dusk"\] \{([\s\S]*?)\n\}/.exec(read("ui/tokens.css"))[1];
  const tok = (name) => ok.hexToRgb(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(dusk)[1]);
  const bg0 = ok.srgbToOklab(tok("--bg0")), textTwo = tok("--text-2"), onWash = tok("--on-wash-2");
  const HOT = Number(/--td-hot:\s*(\d+)%/.exec(read("ui/today.css"))[1]) / 100;
  let worstText2 = Infinity, worstOnWash = Infinity;
  for (let h = 0; h < 360; h += 10) {
    const glow = ok.oklchToLab(0.66, 0.14, h);
    const bg = ok.oklabToSrgb(ok.mixLab(bg0, glow, 1 - HOT));
    worstText2 = Math.min(worstText2, ok.contrast(textTwo, bg));
    worstOnWash = Math.min(worstOnWash, ok.contrast(onWash, bg));
  }
  assert.ok(worstText2 < 4.5, `text-2 on the 52% hot spot is under AA at its worst hue (${worstText2.toFixed(2)}): the reason the pair below exists`);
  assert.ok(worstOnWash >= 4.5, `--on-wash-2 clears AA on the hot spot at every hue (${worstOnWash.toFixed(2)})`);
});

/* ================================================================== 7. first run */

test("first run: the hero is the first pick, the list starts at the second pick and is one shorter, there is no Keep listening", () => {
  /* MUTATION 2: name the hero's landmark by its eyebrow (aria-label="${esc(eyebrow)}" in todayHeroHtml) -> two "Today's picks" regions, red.
     MUTATION: keep the first pick in the list (drop `.filter(r => r.item.id !== firstPickId)`) -> the count does not drop
     by one and the hero's episode is in the list too. */
  const fresh = mount({ seed: { cp_history: "[]" } });
  fresh.ctx.renderHome();
  const html = fresh.view();
  const returning = mount();
  returning.ctx.renderHome();
  const base = returning.view();
  const count = (h) => Number(/<h2 class="t-headline">Today’s picks<\/h2><span class="t-caption count">(\d+)<\/span>/.exec(h)[1]);
  assert.strictEqual(count(html), count(base) - 1, "the count drops by one against the same listener with a Foray leading");
  assert.match(html, /<section class="td-hero" aria-label="Today&#39;s pick" data-branch="engineering">/, "the hero is the first pick (the first top slot's lead)");
  assert.match(html, /<span class="eyebrow lamp">Today’s picks<\/span>/);
  const list = html.slice(html.indexOf('aria-label="Today\'s picks"', html.indexOf("</section>")));
  assert.ok(!list.includes('data-td-ep="top-1"'), "the hero's episode is not in the list again");
  assert.ok(list.includes('data-td-ep="top-2"'), "the list starts at the second pick");
  assert.ok(!heroOf(html).includes("usual subjects"), "the first-run hero never cites 'usual subjects'");
  assert.ok(!html.includes('aria-label="Keep listening"'), "no Keep listening");
  assert.ok(heroOf(html).includes(`<p class="t-body td-first-run">4a found today’s picks. No account, no setup.</p>`), "its one extra line");
  assert.match(html, /data-today="first-run"/);
  const labels = [...html.matchAll(/<section[^>]*aria-label="([^"]+)"/g)].map((x) => x[1]);
  assert.strictEqual(new Set(labels).size, labels.length, `landmark names are unique, or axe says landmark-unique: ${labels.join(" | ")}`);
});

/* ================================================================== 8-9. Keep listening and the rail */

test("Keep listening shows only something mid-listen, as one 72px row with an Ember progress rim at the right percent", () => {
  /* MUTATION: pass `pct: null` for an episode entry in todayKeepHtml -> no rim; drop the guard in todayKeepEntry so a
     finished or never-started entry qualifies -> the null / 100 assertions fail. */
  const m = mount({ player: {
    lastEpisodeCard: () => ({ id: "ep-mid", title: "Half heard", show: "Mid Show", audio_url: "https://cdn.test/mid.mp3", artwork_url: "https://is1-ssl.mzstatic.com/image/thumb/P/v4/mid/600x600bb.jpg", updated_at: "2026-10-04T12:00:00.000Z", percent: 30, label: "21 min left" }),
  } });
  m.ctx.renderHome();
  const html = m.view();
  const keep = html.slice(html.indexOf('aria-label="Keep listening"'));
  assert.match(keep, /<article class="raised td-row is-default" data-td-ep="ep-mid"/, "one EpisodeRow");
  assert.match(keep, /ag-art ag-art-72[^>]*>[\s\S]*?<span class="td-rim" aria-hidden="true"><i class="td-rim-fill" data-pct="30"><\/i><\/span>/, "72px art with the rim at 30%");
  assert.strictEqual((keep.slice(0, keep.indexOf("</section>")).match(/class="raised td-row/g) || []).length, 1, "exactly one row");
  assert.strictEqual(valueOf(".ag .td-rim-fill", "background"), "var(--ember)", "the rim is Ember: progress made is the listener's own mark");
  assert.strictEqual(valueOf(".ag .td-row", "min-height"), "var(--row-episode)", "rows are the 96px EpisodeRow");
  /* The rim's width is a CSSOM write, never an inline style attribute. */
  const widths = []; const fill = { dataset: { pct: "30" }, style: { setProperty: (k, v) => widths.push([k, v]) } };
  m.ctx.todaySizeRims({ querySelectorAll: () => [fill] });
  assert.deepStrictEqual(widths, [["width", "30%"]]);
  assert.strictEqual(m.ctx.todayKeepEntry([{ kind: "playlist", percent: null }]), null);
  assert.strictEqual(m.ctx.todayKeepEntry([{ kind: "foray", percent: 100 }]), null);
});

test("Playlists for you is the only horizontal scroller: 2 tiles and a 24px peek, snapping to the gutter", () => {
  /* MUTATION: add `overflow-x: auto` to any other rule in today.css (or a second `td-rail` in the markup) -> the count
     assertions fail; change the tile width formula -> the peek is not 24. */
  const scrollers = RULES.filter((r) => !r.prelude.startsWith("@") && /overflow-x:\s*auto|overflow:\s*auto/.test(r.body)).map((r) => r.prelude);
  assert.deepStrictEqual(scrollers, [".ag .td-rail"], "one scroller in the whole sheet");
  assert.strictEqual(valueOf(".ag .td-rail", "scroll-snap-type"), "x mandatory");
  assert.strictEqual(valueOf(".ag .td-rail > *", "width"), "calc((100% + var(--gutter) - var(--s-12)) / 2)");
  /* the arithmetic, at the three phone widths: visible tiles + gaps + peek fill the viewport from the gutter */
  for (const [vw, gutter] of [[375, 16], [393, 20], [412, 20]]) {
    const content = vw - 2 * gutter, tile = (content + gutter - 48) / 2;
    const visible = vw - gutter;   // from the first tile's left edge to the screen's right edge
    assert.ok(Math.abs(visible - (2 * tile + 2 * 12 + 24)) < 0.01, `${vw}: two tiles, two gaps and a 24px peek (tile ${tile}px)`);
  }
  const m = mount();
  m.ctx.renderHome();
  const html = m.view();
  assert.strictEqual((html.match(/class="td-rail"/g) || []).length, 1, "one rail on the page");
  assert.match(html, /<section class="hv2-playlists td-section" aria-label="Playlists for you">/, "its section keeps the hook the scroll memory reads");
  assert.ok(!/hv2-hscroll/.test(html), "and no other shelf");
});

/* ================================================================== 10. Off your path */

test("Off your path draws two or three rows from outside the top tier, never the Stretch's subject, never a pick already on the page", () => {
  /* MUTATION: drop `top.has(b)` from todayOffPath's skip -> a top-tier subject appears; drop the excludeIds guard -> a
     pick repeats. */
  const m = mount();
  const exclude = new Set(["top-1", "top-2", "top-3", "stretch-1"]);
  const off = m.ctx.todayOffPath(exclude, "comedy");
  assert.strictEqual(off.length, 2, "the two subjects below the 60% cut that are not the Stretch's");
  assert.ok(off.every((r) => r.branch !== "travel"), "travel sits on the cut's top side");
  for (const r of off) {
    assert.ok(["sports", "food"].includes(r.branch), `${r.branch} is outside the top tier`);
    assert.notStrictEqual(r.branch, "comedy", "and is not the Stretch's own subject");
  }
  assert.strictEqual(new Set(off.map((r) => r.item.id)).size, off.length, "no repeats");
  const again = m.ctx.todayOffPath(new Set(["top-1", "top-2", "top-3", "stretch-1", ...off.map((r) => r.item.id)]), "comedy");
  assert.strictEqual(again.length, 0, "a pick already on the page is not drawn again (the lower tier is spent)");
});

/* ================================================================== 11. offline */

test("offline: a 36px raised banner with the wifi-slash glyph, rows that cannot play at half art with Play disabled, a downloaded row that still plays", () => {
  /* MUTATION: return false from todayOffline -> no banner; skip the todayDownloaded check -> the downloaded row is
     dimmed too; drop `disabled` from the unavailable Play -> a dead tap target. */
  const online = mount();
  online.ctx.renderHome();
  assert.ok(!online.view().includes("td-banner"), "online: no banner");
  assert.ok(!online.view().includes("is-unavailable"), "online: nothing is unavailable");

  const downloaded = { cp_downloads: JSON.stringify({ settings: { cellular: false }, items: { "top-2": { status: "done", path: "/p", bytes: 1, total: 1 } } }) };
  const m = mount({ onLine: false, seed: downloaded });
  m.ctx.renderHome();
  const html = m.view();
  assert.match(html, /<div class="raised td-banner t-label" role="status"><svg class="icon icon-20"[^>]*><use href="ui\/icons\.svg#i-wifi-slash"><\/use><\/svg><span>Offline\. Downloaded items play\.<\/span><\/div>/);
  assert.strictEqual(valueOf(".ag .td-banner", "min-height"), "36px");
  const row = (id) => { const at = html.indexOf(`data-td-ep="${id}"`); return html.slice(html.lastIndexOf("<article", at), html.indexOf("</article>", at)); };
  const dead = row("top-1");
  assert.match(dead, /class="raised td-row is-unavailable"/);
  assert.match(dead, /ag-art ag-art-72 ag-tone-amber is-dim/, "art at 50% (the primitive's dim state)");
  assert.match(dead, /<span class="ag-row-state warn"><svg[^>]*><use href="ui\/icons\.svg#i-wifi-slash"><\/use><\/svg>Unavailable<\/span>/, "glyph and word, never colour alone");
  assert.match(dead, /data-td-play="top-1"[^>]*disabled aria-disabled="true"/, "Play is disabled");
  const alive = row("top-2");
  assert.match(alive, /class="raised td-row is-downloaded"/);
  assert.ok(!/disabled/.test(alive), "a downloaded row's Play works");
  assert.match(alive, /<span class="ag-row-state ok">[\s\S]*?Downloaded<\/span>/);
  assert.ok(!/is-dim/.test(alive), "and its art is whole");
  assert.ok(/data-home-play/.test(heroOf(html)) && !/disabled/.test(heroOf(html)), "the hero's Play is not struck offline (a foray plays from its own feeds)");
});

/* ================================================================== 12. loading */

test("loading: skeletons for the hero and four rows with the lamp sweep, both edges transparent, 1.6s; the boot screen on Home", () => {
  /* MUTATION: draw five rows (or three); put an opaque colour at the sweep's first stop; change 1600ms; drop
     `data-boot-loading` -> the webview probe stops reading it as booting; drop the init() branch -> Home boots to text. */
  const m = mount();
  const sk = m.ctx.todaySkeletonHtml();
  assert.strictEqual((sk.match(/class="td-skel td-skel-row"/g) || []).length, 4, "four rows");
  assert.strictEqual((sk.match(/td-hero-skel/g) || []).length, 1, "one hero");
  assert.ok(sk.includes("td-skel-art") && sk.includes("td-skel-play"), "the hero's art and Play");
  assert.ok(!sk.includes("data-boot-loading"), "off the boot path it is an ordinary page");
  const boot = m.ctx.todaySkeletonHtml({ boot: true });
  assert.ok(boot.includes("data-boot-loading") && boot.includes("Loading 4a…") && boot.includes('role="status"'), "the boot screen is the probe's mark and a screen reader's line");
  assert.ok(!sk.includes("data-td-play") && !sk.includes("<a "), "nothing in a skeleton can be tapped");
  assert.match(valueOf(".ag .td-skel", "background").replace(/\s+/g, " "), /^linear-gradient\(90deg, transparent 0%, var\(--overlay\) 50%, transparent 100%\) -70% 0 \/ 40% 100% no-repeat var\(--bg1\)$/, "both edges transparent");
  assert.match(valueOf(".ag .td-skel", "animation"), /td-sweep 1600ms/, "1.6s");
  assert.ok(RULES.some((r) => r.atRules.includes("@keyframes td-sweep")), "the keyframes exist");
  const init = APP_SRC.slice(APP_SRC.indexOf("async function init()"), APP_SRC.indexOf("const storageP = storageReady();"));
  assert.match(init, /typeof todaySkeletonHtml === "function" && isHomeRoute\(\)[\s\S]*?todaySkeletonHtml\(\{ boot: true \}\)/, "init() paints the skeleton on Home");
  assert.ok(init.includes("BOOT_LOADING_HTML"), "and keeps the line for every other route");
});

/* ================================================================== 13-14. pick to play */

test("pick to play: Glow moves first, the row takes its state (Pause label, Lamp 'Playing', Fill glyph), and Play toggles what is current", async () => {
  /* MUTATION: call todayGlowTo AFTER startEpisodePlay -> the order assertion fails; drop `is-playing` from todayRowState's
     first branch -> the playing row renders as default; call startEpisodePlay for the current episode instead of
     togglePlayback -> the toggle assertion fails. */
  const order = [];
  const player = { isPlaying: (id) => id === "top-2", isCurrent: (id) => id === "top-2", async togglePlayback() { order.push("toggle"); } };
  const m = mount({ player });
  m.ctx.renderHome();
  const html = m.view();
  const at = html.indexOf('data-td-ep="top-2"');
  const row = html.slice(html.lastIndexOf("<article", at), html.indexOf("</article>", at));
  assert.match(row, /class="raised td-row is-playing"/);
  assert.match(row, /aria-label="Pause Title top-2"/);
  assert.match(row, /<span class="ag-row-state"><svg class="icon icon-20"[^>]*><use href="ui\/icons\.svg#i-play-fill"><\/use><\/svg>Playing<\/span>/, "Fill glyph and the word");
  assert.match(row, /<use href="ui\/icons\.svg#i-pause">/, "the control shows Pause");
  assert.strictEqual(valueOf(".ag .td-row.is-playing", "background"), "linear-gradient(var(--overlay), var(--overlay)) var(--glow-row)", "the playing row takes Glow-row");

  /* the press: Glow first, then the start */
  const m2 = mount({ player: { isPlaying: () => false, isCurrent: () => false } });
  m2.ctx.startEpisodePlay = async (id) => { order.push("start:" + id); return true; };
  m2.ctx.todaySyncPlay = () => {};
  const btn = { dataset: { tdPlay: "top-1" }, closest: () => null };
  m2.ctx.todayGlowTo = (show) => { order.push("glow:" + show); };
  m2.evalIn('state.itemIndex["top-1"] = state.cardSlots[0].item;');
  order.length = 0;
  await m2.ctx.todayPlayPress(btn, { querySelectorAll: () => [btn] });
  assert.deepStrictEqual(order, ["glow:Eng Weekly", "start:top-1"], "the colour changes as the art moves, not after");
  /* a row that is current toggles */
  order.length = 0;
  m.ctx.todaySyncPlay = () => {};
  m.evalIn('state.itemIndex["top-2"] = state.cardSlots[1].item;');
  await m.ctx.todayPlayPress({ dataset: { tdPlay: "top-2" }, closest: () => null }, { querySelectorAll: () => [] });
  assert.deepStrictEqual(order, ["toggle"], "Pause pauses; it never restarts the episode");
  /* Glow lands on <html> through the CSSOM, as a number-only colour */
  const g = mount();
  g.ctx.todayGlowTo("Science Vs");
  assert.deepStrictEqual(g.rootStyle, [["--glow", "oklch(0.66 0.140 15)"]]);
  assert.match(read("ui/tokens.css"), /transition: --glow var\(--m-room\) var\(--e-out\);/, "and the :root transition makes it 560ms");
  assert.match(read("ui/tokens.css"), /--m-room: 560ms;/);
});

test("the art flies to the mini slot in 560ms on the --e-spring easing; under Reduce Motion it does not fly", () => {
  /* MUTATION: change 560 to 420 in todayFlipToMini -> red; drop the matchMedia guard -> the Reduce Motion case flies;
     append the clone to <body> -> it escapes the `.ag` scope and loses its styles. */
  const calls = [];
  const clone = { classList: { add() {} }, style: { setProperty() {} }, animate: (frames, opts) => { calls.push({ frames, opts }); return {}; }, remove() {} };
  const art = { getBoundingClientRect: () => ({ left: 20, top: 100, width: 72, height: 72 }), animate() {}, cloneNode: () => clone };
  const slot = { hidden: false, getBoundingClientRect: () => ({ left: 36, top: 740, width: 44, height: 44 }) };
  const appended = [];
  const scope = { appendChild: (el) => appended.push(el) };
  const m = mount({ vars: { "--e-spring": "linear(0, 1)" } });
  m.ctx.document.querySelector = (sel) => (sel === ".td-today" ? scope : sel === "[data-mini-art]" ? slot : null);
  m.ctx.todayFlipToMini(art);
  assert.strictEqual(calls.length, 1, "the art flew");
  assert.strictEqual(calls[0].opts.duration, 560);
  assert.strictEqual(calls[0].opts.easing, "linear(0, 1)", "the --e-spring token, read live");
  assert.match(calls[0].frames[1].transform, /^translate\(16px, 640px\) scale\(0\.61/, "to the slot: its offset and 44/72 of its size");
  assert.deepStrictEqual(appended, [clone], "inside the .td-today scope");
  const reduced = mount();
  reduced.ctx.matchMedia = () => ({ matches: true });
  const calls2 = [];
  const art2 = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 72, height: 72 }), animate() {}, cloneNode: () => ({ ...clone, animate: () => { calls2.push(1); return {}; } }) };
  reduced.ctx.document.querySelector = (sel) => (sel === "[data-mini-art]" ? slot : sel === ".td-today" ? scope : null);
  reduced.ctx.todayFlipToMini(art2);
  assert.strictEqual(calls2.length, 0, "Reduce Motion: the art fades in place");
});

/* ================================================================== 15. hostile data */

test("every string from the catalogue goes through esc(), every route is encoded, and no title can open a tag", () => {
  /* MUTATION: drop esc() on the row title, the hook, the show, the hero why-line, or the playlist title in ui/home.js
     -> the raw <img appears; interpolate the id into an href unencoded -> the raw "/" and "#" appear. */
  const evil = '<img src=x onerror=alert(1)>';
  const m = mount({ hero: "none" });
  m.state.cardSlots[1].item = { ...m.state.cardSlots[1].item, id: 'a/b#c?d', title: evil, show: evil, hook: evil };
  m.state.cardSlots[1].items = [m.state.cardSlots[1].item];
  m.store.set("cp_playlists", JSON.stringify([{ id: "pl-x", title: evil, items: [], created: "2026-09-01T00:00:00Z" }]));
  m.ctx.renderHome();
  const html = m.view();
  assert.ok(!html.includes("<img src=x"), "no raw tag from any field");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"), "the text is there, escaped");
  assert.ok(html.includes('href="#/episode/a%2Fb%23c%3Fd"'), "the id is encoded in the route");
  assert.ok(html.includes('data-td-play="a/b#c?d"'), "and carried, as text, in the attribute");
  assert.ok(!/href="#\/episode\/a\/b/.test(html), "never raw");
  assert.ok(!/<[^>]*\son\w+=/.test(html.replace(/&lt;[^]*?&gt;/g, "")), "no event-handler attribute anywhere");
});

/* ================================================================== 16. the stylesheet and its shipping */

test("ui/today.css: every rule scoped under .ag (or Home's body class), one reduced-motion owner, no inline style, no literal colour", () => {
  /* The sheet cannot reach another screen (tokens.css's collision rule, kept by hand because it is a different file).
     MUTATION: add a bare `.row { }` or `button { }` rule, a `@media (prefers-reduced-motion)` block, or a `#fff` -> red. */
  const raw = read("ui/today.css");
  for (const r of RULES) {
    if (r.prelude.startsWith("@keyframes") || r.atRules.some((a) => a.startsWith("@keyframes"))) continue;
    if (r.prelude.startsWith("@")) continue;
    for (const sel of selectorsOf(r.prelude)) assert.ok(/^(\.ag(?![\w-])|body\.view-home(?![\w-]))/.test(sel), `selector "${sel}" is not scoped under .ag or body.view-home`);
  }
  assert.ok(!/prefers-reduced-motion/.test(raw.replace(/\/\*[\s\S]*?\*\//g, " ")), "ui/tokens.css owns the one reduced-motion block (its `.ag *` scope covers this sheet)");
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(TODAY_CSS), "no literal colour: every colour is a token");
  assert.ok(!/\bstyle\s*=|!important/.test(TODAY_CSS), "no inline style, no !important");
  assert.ok(!/@import|url\(|https?:/.test(TODAY_CSS), "no import, url or origin");
  const emitted = read("ui/home.js");
  assert.ok(!/\bstyle\s*=\s*["'`]/.test(emitted), "ui/home.js writes no inline style attribute (CSSOM only)");
});

test("ui/today.css and ui/palette.js ship: the page links and loads them, and the SW generation, web dist and app bundle list the stylesheet", async () => {
  /* MUTATION: remove "ui/today.css" from SHELL in tools/ci/generate-manifest.mjs, tools/web/prepare-dist.mjs or SHELL_FILES in
     prepare-webdir.mjs, or the <link>/<script> from index.html -> red, naming the path. */
  const html = read("index.html");
  assert.ok(html.includes('<link rel="stylesheet" href="ui/today.css">'), "linked");
  assert.ok(html.indexOf("ui/today.css") > html.indexOf("ui/primitives.css"), "after the primitives it composes");
  assert.ok(html.includes('<script src="ui/palette.js"></script>'), "palette.js is loaded as a classic script");
  assert.match(read("tools/ci/generate-manifest.mjs"), /const SHELL = \[[\s\S]*?"ui\/today\.css"[\s\S]*?\n\];/, "generate-manifest SHELL");
  assert.match(read("tools/web/prepare-dist.mjs"), /const SHELL = \[[\s\S]*?"ui\/today\.css"[\s\S]*?\n\];/, "prepare-dist SHELL");
  const pw = await import(pathToFileURL(path.join(ROOT, "tools", "mobile", "prepare-webdir.mjs")).href);
  assert.ok(pw.SHELL_FILES.includes("ui/today.css"), "prepare-webdir SHELL_FILES");
});

/* ================================================================== 17-20. iteration 2: the Dock, the fade, the meta line, the apostrophes */

test("the Dock on Today: inset by the gutter, 12px above the safe area, --r-xl corners, the Glow-tinted Veil; an inert tab is text-2, the active tab is Lamp", () => {
  /* The first build shipped the legacy full-width, square-cornered, purple-grey bar with an Ember active tab.
     MUTATION 1: change `background: var(--glow-veil)` on `body.view-home .tab-bar` to `var(--surface)` (the legacy grey) -> red.
     MUTATION 2: drop `left`/`right` (the bar is full width again) or set `border-radius: 0` -> red.
     MUTATION 3: set the active colour to `var(--ember)` (Ember is the listener's own marks) -> red. */
  const bar = "body.view-home .tab-bar";
  assert.strictEqual(valueOf(bar, "left"), "var(--ag-gutter)", "inset by the gutter on the left");
  assert.strictEqual(valueOf(bar, "right"), "var(--ag-gutter)", "and on the right: a floating Dock, not a full-width bar");
  assert.strictEqual(valueOf(bar, "bottom"), "var(--dock-lift)", "floating above the safe area");
  assert.strictEqual(valueOf("body.view-home", "--dock-lift"), "calc(env(safe-area-inset-bottom, 0px) + var(--dock-inset))", "the lift is the safe area plus the 12px token");
  assert.strictEqual(valueOf(bar, "border-radius"), "var(--r-xl)", "rounded corners");
  assert.strictEqual(valueOf(bar, "background"), "var(--glow-veil)", "the warm Glow-tinted Veil, never the legacy purple-grey surface");
  assert.match(valueOf(bar, "backdrop-filter"), /blur\(20px\) saturate\(140%\)/, "the Veil's blur");
  assert.match(valueOf(bar, "box-shadow"), /var\(--rim\)/, "lit from above by the rim, no hairline");
  assert.strictEqual(valueOf(bar, "border"), "0", "no border");
  assert.strictEqual(valueOf("body.view-home .tab-btn", "color"), "var(--text-2)", "an inert tab");
  assert.strictEqual(valueOf('body.view-home .tab-bar .tab-btn[aria-current="page"]', "color"), "var(--lamp-text)", "the active tab is Lamp, not Ember");
  assert.strictEqual(valueOf("body.view-home .tab-btn", "min-height"), "var(--tap)", "44px targets");
  /* The mini player is the Dock's top row: same gutter, same Veil, the top corners; the tab row keeps the bottom ones. */
  const mini = "body.view-home.ui-v2.fp-open #foray-player";
  assert.strictEqual(valueOf(mini, "left"), "var(--ag-gutter)");
  assert.strictEqual(valueOf(mini, "background"), "var(--glow-veil)");
  assert.strictEqual(valueOf(mini, "border-radius"), "var(--r-xl) var(--r-xl) 0 0");
  assert.strictEqual(valueOf("body.view-home.fp-open .tab-bar", "border-radius"), "0 0 var(--r-xl) var(--r-xl)");
  assert.strictEqual(valueOf("body.view-home.ui-v2 #foray-player .fp-play", "background"), "var(--ember)", "the mini's Play is Ember, not the legacy violet (MUTATION 4: put var(--violet) there)");
  assert.strictEqual(valueOf("body.view-home", "--tab-bar-h"), "calc(var(--tab-bar) + var(--dock-inset))", "the legacy sums (mini bottom, content padding) read the Dock's real height");
  /* The three material fallbacks the Veil carries elsewhere. */
  for (const q of ["@supports not", "prefers-reduced-transparency", "prefers-contrast"]) {
    assert.ok(RULES.some((r) => r.atRules.some((a) => a.includes(q)) && /body\.view-home \.tab-bar/.test(r.prelude)), `the Dock has its ${q} fallback`);
  }
});

test("content runs under the Dock and fades to bg: a fixed fade behind it, solid from 32px above the Dock to the screen's bottom edge", () => {
  /* The first build sliced the second picks row with the bar's hard top edge.
     MUTATION 1: delete the `body.view-home::after` rule -> red. MUTATION 2: set its z-index to 56 (over the Dock) or
     its pointer-events to auto (it would eat taps) -> red. MUTATION 3: end the gradient at transparent -> red. */
  const fade = "body.view-home::after";
  assert.strictEqual(valueOf(fade, "position"), "fixed");
  assert.strictEqual(valueOf(fade, "bottom"), "0", "to the screen's bottom edge");
  assert.strictEqual(valueOf(fade, "pointer-events"), "none", "the fade never takes a tap");
  assert.ok(Number(valueOf(fade, "z-index")) < 55, "under the Dock (the legacy bar is 55)");
  assert.ok(Number(valueOf(fade, "z-index")) > 1, "over the content");
  assert.strictEqual(valueOf(fade, "height"), "calc(var(--td-dock-h) + var(--s-8))", "32px taller than the Dock");
  assert.strictEqual(valueOf(fade, "background"), "linear-gradient(transparent 0, var(--bg0) var(--s-8))", "solid bg from 32px up");
  assert.strictEqual(valueOf("body.view-home", "--td-dock-h"), "calc(var(--dock-lift) + var(--tab-bar))");
  assert.strictEqual(valueOf("body.view-home.fp-open", "--td-dock-h"), "calc(var(--dock-lift) + var(--tab-bar) + var(--mini))", "the mini row is part of the Dock when something is loaded");
});

test("the hero's meta stays beside Play on ONE nowrap line, or stacks its two parts; it never wraps mid-line", () => {
  /* Iteration 3 let "1 show · about 43 min" wrap inside the 109px beside Play, which left "1 show ·" at a line end and
     "about 43 min" under it (the separator stranded). Iteration 4: the line is nowrap; a meta too long for it is
     rendered as two stacked parts, one per line, the separator for screen readers only.
     MUTATION 1: set `flex-wrap: wrap` back on `.ag .td-hero-actions` -> red.
     MUTATION 2: delete `flex: 1 1 0` or `min-width: 0` on `.ag .td-hero-actions .td-hero-meta` -> red.
     MUTATION 3: delete the `flex: none` on the row's Play (it shrinks to 49.5px) -> red.
     MUTATION 4: delete `white-space: nowrap` from the meta -> red (the wrap, and the stranded "·", is back).
     MUTATION 5: raise TODAY_META_ONE_LINE_MAX to 99 in ui/home.js -> the 21-character estimate renders as one line -> red.
     MUTATION 6: drop the `is-stacked` class from todayForayMetaHtml, or the `display: block` on its spans -> red. */
  assert.strictEqual(valueOf(".ag .td-hero-actions", "flex-wrap"), "nowrap");
  assert.strictEqual(valueOf(".ag .td-hero-actions .td-hero-meta", "flex"), "1 1 0");
  assert.strictEqual(valueOf(".ag .td-hero-actions .td-hero-meta", "min-width"), "0");
  assert.strictEqual(valueOf(".ag .td-hero-actions .td-hero-meta", "white-space"), "nowrap", "one line, never wrapped");
  assert.strictEqual(valueOf(".ag .td-hero-actions .td-hero-meta", "text-wrap"), null, "no balanced wrapping to strand a separator");
  assert.strictEqual(valueOf(".ag .td-hero-actions > .ag-btn", "flex"), "none");
  assert.strictEqual(valueOf(".ag .td-hero-actions .td-hero-meta.is-stacked > span:not(.sr-only)", "display"), "block", "stacked parts take a line each");
  const m = mount();
  const fits = m.ctx.todayForayMetaHtml({ meta: "4 shows · 19 min", metaParts: ["4 shows", "19 min"] });
  assert.strictEqual(fits, '<p class="t-caption td-hero-meta num">4 shows · 19 min</p>', "the prototype's own line stays one line");
  const estimate = m.ctx.todayForayMetaHtml({ meta: "1 show · about 43 min", metaParts: ["1 show", "about 43 min"] });
  assert.strictEqual(estimate, '<p class="t-caption td-hero-meta num is-stacked"><span>1 show</span><span class="sr-only"> · </span><span>about 43 min</span></p>', "the estimate stacks: no line can end on the separator");
  const hostile = m.ctx.todayForayMetaHtml({ meta: "<b>x</b> · about 43 min", metaParts: ["<b>x</b>", "about 43 min"] });
  assert.ok(!hostile.includes("<b>"), "every part goes through esc()");
  assert.strictEqual(m.ctx.todayForayMetaHtml({ meta: "about 43 min", metaParts: ["about 43 min"] }), '<p class="t-caption td-hero-meta num">about 43 min</p>', "one part is one line");
  /* The whole path, not only the helper: an ESTIMATED foray on Home comes out stacked, a measured one on one line.
     MUTATION 7: drop `metaParts` from the foray hero in ui/home.js -> the estimate falls back to one (overflowing) line -> red. */
  const est = mount({ player: { stripTally: () => ({ shows: 1, clips: 4, bridges: 1, estimated: true }) } });
  est.ctx.renderHome();
  assert.match(heroOf(est.view()), /<p class="t-caption td-hero-meta num is-stacked"><span>1 show<\/span><span class="sr-only"> · <\/span><span>about 42 min<\/span><\/p>/, "an estimated foray stacks beside Play");
});

test("the 2x2 collage is one treatment at every size: whole squares, one gap, no rounded inner tile", () => {
  /* The finding compared the 72px Keep listening collage with the hero's. Both are `.ag-collage.c4`; the gap and the
     inner-tile radius come from ONE rule in ui/primitives.css, and Today may restyle neither.
     MUTATION 1: add `gap: 3px` (or any padding) to `.ag .td-keep-art .ag-collage` in ui/today.css -> red.
     MUTATION 2: set the c4 inner art's border-radius to var(--r-sm) in ui/primitives.css -> red.
     MUTATION 3: change the c4 gap in ui/primitives.css to 3px (or back to 2px) -> red. */
  const prim = cssRules(read("ui/primitives.css").replace(/\/\*[\s\S]*?\*\//g, " "));
  const inPrim = (sel, prop) => {
    let v = null;
    for (const r of prim) {
      if (r.prelude.startsWith("@") || r.atRules.length || !selectorsOf(r.prelude).includes(sel)) continue;
      for (const d of r.body.split(";")) { const c = d.indexOf(":"); if (c >= 0 && d.slice(0, c).trim() === prop) v = d.slice(c + 1).trim(); }
    }
    return v;
  };
  assert.strictEqual(inPrim(".ag .ag-collage.c4", "gap"), "1px", "a 1px hairline between whole squares, at every size (iteration 4)");
  assert.strictEqual(inPrim(".ag .ag-collage.c4 > .ag-art", "border-radius"), "0", "inner squares are whole and square-cornered; the collage rounds once");
  for (const sel of [".ag .td-keep-art .ag-collage", ".ag .td-hero-art .ag-collage"]) {
    for (const prop of ["gap", "padding", "background"]) assert.strictEqual(valueOf(sel, prop), null, `${sel} does not restyle ${prop}`);
  }
  assert.strictEqual(valueOf(".ag .td-keep-art .ag-collage .ag-art", "border-radius"), null);
});

test("what Today draws uses typographic apostrophes (Today’s picks, Today’s foray); the landmark names stay ASCII", () => {
  /* The prototype sets them in Fraunces. MUTATION: put a straight ' back in the eyebrow, the section head or either note -> red. */
  const m = mount();
  m.ctx.renderHome();
  const html = m.view();
  const visible = html.replace(/<[^>]+>/g, "|");
  assert.ok(visible.includes("Today’s foray"), "the eyebrow");
  assert.ok(visible.includes("Today’s picks"), "the section head");
  assert.ok(!/Today(&#39;|')s/.test(visible), "no straight apostrophe in a text node");
  assert.ok(html.includes('aria-label="Today\'s picks"'), "the landmark name is unchanged, so every query that finds the region still does");
  const first = mount({ seed: { cp_history: "[]" } });
  first.ctx.renderHome();
  assert.ok(/4a found today’s picks\./.test(first.view()), "the first-run note");
  assert.ok(!/today(&#39;|')s/.test(first.view().replace(/<[^>]+>/g, "|")), "and no straight one anywhere in its text");
});
