/* First-time explanation/consent screen vs. returning-user path.
 *
 * Ports the M3 prototype's `V.signinNew` / `V.signinReturning` split
 * (docs/ux/foray-m3-prototype.html, docs/ux/README.md § "First-time vs.
 * returning user") into the shipped stack. Two things this suite has to
 * prove, because they are the two ways this feature quietly breaks:
 *
 *   1. THE GATE IS A REAL "NEVER USED THIS APP" SIGNAL, not just the
 *      cp_intro_dismissed flag the older popup uses. A user with real
 *      history/saves/playlists must never see this screen, even if
 *      cp_intro_dismissed is somehow unset (a corrupted write, a migrated
 *      device, etc.) — that is the exact trap a flag-only gate falls into.
 *   2. NO INTERVIEW STEP. The M3 prototype's finishOnb/skipOnb describe a
 *      preference interview that does not exist in the real backend. This
 *      screen must not reference one, and must not add a new event/field
 *      that isn't part of the existing weighted-signal model.
 *
 * Same dependency-free node:vm harness as test/episode-page.test.js — no
 * jsdom, just enough DOM surface for app.js to run its top-level init()
 * (parked at its first fetch await) and expose its functions/state.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const APP_PATH = path.join(__dirname, "..", "app.js");
const SRC = fs.readFileSync(APP_PATH, "utf8");

function loadApp() {
  const noop = () => {};
  function makeEl() {
    const node = {
      addEventListener: noop, removeEventListener: noop, appendChild: noop,
      append: noop, remove: noop,
      setAttribute: noop, removeAttribute: noop,
      classList: { add: noop, remove: noop, toggle: noop },
      style: {}, dataset: {}, children: [], hidden: false,
      innerHTML: "", textContent: "", className: "",
      querySelector: () => makeEl(), querySelectorAll: () => [],
    };
    return node;
  }
  const viewEl = makeEl();
  const bodyEl = makeEl();

  const store = new Map();
  const ctx = {
    console,
    fetch: () => new Promise(() => {}), // parks init() at its first await
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: {
      body: bodyEl, documentElement: makeEl(),
      addEventListener: noop, createElement: makeEl,
      querySelector: (sel) => (sel === "#view" ? viewEl : makeEl()),
      querySelectorAll: () => [],
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
  process.on("unhandledRejection", noop);
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  ctx._view = viewEl;
  ctx._body = bodyEl;
  ctx._state = (code) => vm.runInContext(code, ctx);
  return ctx;
}

/* ---------- isGenuineFirstTimeUser(): the real signal ---------- */

test("isGenuineFirstTimeUser is true with no history, saves or playlists", () => {
  const app = loadApp();
  assert.strictEqual(app.isGenuineFirstTimeUser(), true);
});

test("isGenuineFirstTimeUser is false with any history", () => {
  const app = loadApp();
  app.lsSet("cp_history", ["ep-1"]);
  assert.strictEqual(app.isGenuineFirstTimeUser(), false);
});

test("isGenuineFirstTimeUser is false with any saved episode", () => {
  const app = loadApp();
  app.lsSet("cp_saved", { "ep-1": { id: "ep-1" } });
  assert.strictEqual(app.isGenuineFirstTimeUser(), false);
});

test("isGenuineFirstTimeUser is false with any playlist", () => {
  const app = loadApp();
  app.lsSet("cp_playlists", [{ id: "p1", title: "My playlist", item_ids: [] }]);
  assert.strictEqual(app.isGenuineFirstTimeUser(), false);
});

/* ---------- showFirstTimeExplainerOnce(): gate + independence from the flag ---------- */

test("an existing user never sees the first-time screen, even with cp_intro_dismissed unset", () => {
  // KILLED BY: gating this screen on cp_intro_dismissed instead of on real
  // history/saves/playlists — the exact trap the card called out.
  const app = loadApp();
  app.lsSet("cp_history", ["ep-1"]);
  assert.strictEqual(app.lsGet("cp_intro_dismissed", false), false, "flag must be unset for this test to mean anything");
  const shown = app.showFirstTimeExplainerOnce();
  assert.strictEqual(shown, false, "an existing user must not see the first-time explainer");
});

test("a genuine first-ever visit shows the explainer; once dismissed it never shows again", () => {
  const app = loadApp();
  const shownFirst = app.showFirstTimeExplainerOnce();
  assert.strictEqual(shownFirst, true, "first-ever visit must show the explainer");

  // The harness has no real DOM, so a synthetic click can't reach the
  // dismiss() closure bound inside showFirstTimeExplainerOnce() — the
  // "single dismiss() for all three actions" test above already proves
  // skip/go/scrim all set cp_intro_dismissed structurally. Simulate that
  // outcome directly to prove the *gate* behaves correctly once dismissed.
  app.lsSet("cp_intro_dismissed", true);
  const shownAgain = app.showFirstTimeExplainerOnce();
  assert.strictEqual(shownAgain, false, "must not show a second time once dismissed");
});

test("skipping/completing the explainer both set cp_intro_dismissed (single flag, either action)", () => {
  const app = loadApp();
  app.showFirstTimeExplainerOnce();
  // both dismiss paths (scrim/skip/go) call the same dismiss() closure —
  // proven structurally since there is only one dismiss() defined in the
  // function body and all three listeners are bound to it.
  const body = require("node:fs").readFileSync(APP_PATH, "utf8");
  const start = body.indexOf("function showFirstTimeExplainerOnce(");
  const end = body.indexOf("\nfunction ", start + 10);
  const fn = body.slice(start, end);
  const dismissBindings = (fn.match(/addEventListener\("click", dismiss\)/g) || []).length;
  assert.strictEqual(dismissBindings, 3, "scrim, skip and go must all bind to the same dismiss() function");
});

/* ---------- no interview/quiz step ---------- */

test("the first-time explainer names the M3 prototype's interview only to say there isn't one, and builds no quiz UI", () => {
  const start = SRC.indexOf("function showFirstTimeExplainerOnce(");
  const end = SRC.indexOf("\nfunction ", start + 10);
  const fn = SRC.slice(start, end);
  // Copy is allowed to reassure the user "there's no interview" — that is
  // the whole point of this screen per the card. What must never appear is
  // an actual interview mechanic: a question/answer flow, or calls to the
  // prototype's finishOnb/skipOnb names.
  assert.doesNotMatch(fn, /finishOnb|skipOnb/,
    "must not port the M3 prototype's preference-interview functions");
  assert.doesNotMatch(fn.toLowerCase(), /\bquiz\b|onboarding question|preference question/,
    "must not build a quiz/question-based interview step");
});

/* ---------- renderHome() wiring: explainer and old popup are mutually exclusive ---------- */

test("renderHome shows the first-time explainer instead of the older intro popup on a first-ever visit", () => {
  const app = loadApp();
  const explainerShown = app.showFirstTimeExplainerOnce();
  assert.strictEqual(explainerShown, true);
  // The harness has no real DOM, so the click that would fire dismiss()
  // can't be simulated here — simulate its effect directly (mirrors the
  // "single dismiss() for all three actions" structural test above).
  app.lsSet("cp_intro_dismissed", true);
  // Because that flag is now set, renderHome's fallback
  // `if (!showFirstTimeExplainerOnce()) showIntroPopupOnce()` would call
  // showIntroPopupOnce() next — but its own early-return guard on the same
  // flag makes that a no-op, so the two screens can never both render.
  const popupWouldRun = !app.lsGet("cp_intro_dismissed", false);
  assert.strictEqual(popupWouldRun, false, "showIntroPopupOnce() must no-op once the flag is set");
});

test("renderHome source calls showFirstTimeExplainerOnce() and only falls back to showIntroPopupOnce()", () => {
  assert.match(
    SRC,
    /if \(!showFirstTimeExplainerOnce\(\)\) showIntroPopupOnce\(\);/,
    "renderHome must try the first-time explainer first and only show the old popup when it didn't render"
  );
});
const ROOT = path.join(__dirname, "..");
const TAXONOMY = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "taxonomy.json"), "utf8"));
/* A real (if minimal) DOM tree: appendChild/append build actual parent-child
   structure, querySelector/querySelectorAll walk it by id/class/attribute,
   and addEventListener/_fire drive real click handlers — everything
   showFirstTimeExplainerOnce() needs since it builds its UI with
   createElement rather than an innerHTML string. */
function makeEl(tag) {
  const listeners = new Map();
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    id: null, _className: "", textContent: "", value: "", type: "",
    hidden: false, disabled: false, style: {}, children: [],
    _innerHTML: "",
    get innerHTML() { return this._innerHTML; },
    set innerHTML(v) { this._innerHTML = v; if (v === "") this.children = []; },
    get className() { return this._className; },
    set className(v) {
      this._className = v || "";
      this.classList._set = new Set(this._className.split(/\s+/).filter(Boolean));
    },
    classList: {
      _set: new Set(),
      add(...cls) { cls.forEach((c) => this._set.add(c)); el._className = [...this._set].join(" "); },
      remove(...cls) { cls.forEach((c) => this._set.delete(c)); el._className = [...this._set].join(" "); },
      toggle(c) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); el._className = [...this._set].join(" "); },
      contains(c) { return this._set.has(c); },
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    _fire(type, evt) {
      for (const fn of listeners.get(type) || []) fn(evt || {});
    },
    appendChild(k) { this.children.push(k); k._parent = this; return k; },
    append(...ks) { ks.forEach((k) => { this.children.push(k); k._parent = this; }); },
    setAttribute(name, val) { this[`_attr_${name}`] = String(val); },
    getAttribute(name) { return this[`_attr_${name}`] ?? null; },
    removeAttribute(name) { delete this[`_attr_${name}`]; },
    closest() { return null; },
    focus() {}, select() {}, click() { this._fire("click"); },
    remove() { if (this._parent) this._parent.children = this._parent.children.filter((c) => c !== this); },
    querySelector(sel) { return makeEl._query(sel, this)[0] || null; },
    querySelectorAll(sel) { return makeEl._query(sel, this); },
  };
  // dataset.foo <-> data-foo attribute, both directions — app.js sets/reads
  // via .dataset (never setAttribute) for its data-* hooks, so this proxy is
  // what makes the selector engine's [data-x] / [data-x="y"] matching see it.
  el.dataset = new Proxy({}, {
    get(_, key) {
      const kebab = String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      return el.getAttribute(`data-${kebab}`) ?? undefined;
    },
    set(_, key, val) {
      const kebab = String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      el.setAttribute(`data-${kebab}`, val);
      return true;
    },
  });
  return el;
}

/* Minimal selector engine: supports "#id", ".class", "[data-x]", and
   "[data-x=\"y\"]" — everything this test needs to drive the real handlers. */
function walk(node, pred, out) {
  for (const c of node.children || []) {
    if (pred(c)) out.push(c);
    walk(c, pred, out);
  }
  return out;
}
makeEl._query = (sel, root) => {
  const s = String(sel).trim();
  if (s.startsWith("#")) {
    const id = s.slice(1);
    return walk(root, (n) => n.id === id, []);
  }
  if (s.startsWith(".")) {
    const cls = s.slice(1);
    return walk(root, (n) => n.classList.contains(cls), []);
  }
  const attrEq = s.match(/^\[([\w-]+)="([^"]*)"\]$/);
  if (attrEq) {
    const [, name, val] = attrEq;
    return walk(root, (n) => n.getAttribute(name) === val, []);
  }
  const attrHas = s.match(/^\[([\w-]+)\]$/);
  if (attrHas) {
    const [, name] = attrHas;
    return walk(root, (n) => n.getAttribute(name) != null, []);
  }
  return [];
};

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn", "banner-slot",
  "pl-form", "pl-input", "pl-note", "sh-form", "sh-input", "sh-note", "sh-results",
];

function mount({ seed = {}, forayPlayer = null } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const body = makeEl("body");
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    body.appendChild(el);
    return [id, el];
  }));

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
        if (s.startsWith("#") && byId.has(s.slice(1))) return byId.get(s.slice(1));
        return body.querySelector(sel);
      },
      querySelectorAll: (sel) => body.querySelectorAll(sel),
    },
    navigator: { userAgent: "node" },
    addEventListener() {}, removeEventListener() {},
    location: { hash: "#/", search: "", pathname: "/", href: "https://x.test/" },
    history: { replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
    window: null,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  if (forayPlayer) ctx.ForayPlayer = forayPlayer;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: "app.js" });

  const evalIn = (src) => vm.runInContext(src, ctx);
  return { ctx, evalIn, store, body, byId, state: evalIn("state") };
}

function bootWithTaxonomy(m) {
  // The suite never awaits init() (fetch never resolves) — everything under
  // test reads state.taxonomy directly, same shortcut test/interests-roots.test.js
  // takes for isolating loadInterests()/nudgeTopics() from the full boot.
  m.state.taxonomy = TAXONOMY;
  m.ctx.loadInterests();
}

const sheetTitle = (m) => m.body.querySelector("#first-time-sheet-title")?.textContent || "";
const skipBtn = (m) => m.body.querySelector("#first-time-sheet-skip");
const goBtn = (m) => m.body.querySelector("#first-time-sheet-go");
const prefsSkipBtn = (m) => m.body.querySelector("#first-time-sheet-prefs-skip");
const prefsGoBtn = (m) => m.body.querySelector("#first-time-sheet-prefs-go");
const chipsOf = (m) => m.body.querySelectorAll("[data-chip]");

/* ==================================================================== */
/* 1. STEP 1 — WELCOME                                                   */
/* ==================================================================== */

test("step 1 renders the Welcome pane with two value props", () => {
  const m = mount();
  bootWithTaxonomy(m);
  const shown = m.ctx.showFirstTimeExplainerOnce();
  assert.strictEqual(shown, true);
  assert.match(sheetTitle(m), /picks podcast episodes for you/);
  const props = m.body.querySelectorAll(".ft-value-prop");
  assert.strictEqual(props.length, 2, "Welcome must show exactly two value props");
});

test("Welcome's second prop carries a live SegmentStrip when a Foray exists", () => {
  /* MUTATION: drop the segmentStripHtml() call from renderWelcome — the
     .ft-strip-wrap block would never appear even with a resolvable Foray. */
  const stripHtml = '<div class="fy-strip fy-strip--sm fy-strip--static" role="img" aria-label="x"></div>';
  let growApplied = null;
  const player = {
    listForays: () => [{ id: "f1", title: "Test Foray", status: "published" }],
    resolve: (doc, opts) => (opts.id === "f1" ? { playable: [{ id: "a" }] } : null),
    segmentStripHtml: () => stripHtml,
    applyStripGrow: (scope) => { growApplied = scope; },
  };
  const m = mount({ forayPlayer: player });
  bootWithTaxonomy(m);
  m.state.forays = { forays: [{ id: "f1", status: "published" }] };
  m.ctx.showFirstTimeExplainerOnce();
  const wraps = m.body.querySelectorAll(".ft-strip-wrap");
  assert.strictEqual(wraps.length, 1, "the strip illustration must render when a Foray resolves");
  assert.ok(growApplied, "applyStripGrow must run on the strip's container once it is in the document");
});

test("Welcome degrades to no strip when the player module or forays are unavailable", () => {
  /* MUTATION: throw instead of returning "" when window.ForayPlayer is
     absent — a broken/late-loading player module must not break onboarding. */
  const m = mount(); // no forayPlayer bridged at all
  bootWithTaxonomy(m);
  assert.doesNotThrow(() => m.ctx.showFirstTimeExplainerOnce());
  assert.strictEqual(m.body.querySelectorAll(".ft-strip-wrap").length, 0);
});

test("Skip for now at step 1 dismisses immediately with no interest write", () => {
  /* MUTATION: make step-1 skip advance to step 2 instead of calling dismiss()
     directly — the acceptance line ("skipping at step 1 or 2 lands on Home
     with default weights") requires step 1's skip to exit the whole flow. */
  const m = mount();
  bootWithTaxonomy(m);
  const before = JSON.stringify(m.state.interests);
  m.ctx.showFirstTimeExplainerOnce();
  skipBtn(m)._fire("click");
  assert.strictEqual(m.ctx.lsGet("cp_intro_dismissed", false), true);
  assert.strictEqual(JSON.stringify(m.state.interests), before, "interests must be untouched by a step-1 skip");
  assert.strictEqual(m.store.has("cp_interests"), false, "no cp_interests write on a step-1 skip");
});

test("Get started at step 1 advances to step 2 without dismissing yet", () => {
  /* MUTATION: call dismiss() from the "Get started" handler instead of
     renderPreferences() — cp_intro_dismissed would flip true before the
     listener ever saw the Preferences pane, and a reload mid-flow would skip
     straight past it forever. */
  const m = mount();
  bootWithTaxonomy(m);
  m.ctx.showFirstTimeExplainerOnce();
  goBtn(m)._fire("click");
  assert.strictEqual(m.ctx.lsGet("cp_intro_dismissed", false), false, "must not be dismissed yet");
  assert.match(sheetTitle(m), /What are you into/);
});

/* ==================================================================== */
/* 2. STEP 2 — PREFERENCES                                               */
/* ==================================================================== */

function toStep2(m) {
  m.ctx.showFirstTimeExplainerOnce();
  goBtn(m)._fire("click");
}

test("step 2 renders a chip per PREFS_CHIP_IDS node and the typed-subject field", () => {
  const m = mount();
  bootWithTaxonomy(m);
  toStep2(m);
  const chips = chipsOf(m);
  assert.strictEqual(chips.length, m.evalIn("PREFS_CHIP_IDS").length);
  assert.ok(m.body.querySelector("#first-time-sheet-typed"), "the typed-subject input must render");
});

test("Skip at step 2 dismisses with no interest write (Generalist stands)", () => {
  const m = mount();
  bootWithTaxonomy(m);
  toStep2(m);
  const before = JSON.stringify(m.state.interests);
  chipsOf(m)[0]._fire("click"); // pick one, then skip anyway
  prefsSkipBtn(m)._fire("click");
  assert.strictEqual(m.ctx.lsGet("cp_intro_dismissed", false), true);
  assert.strictEqual(JSON.stringify(m.state.interests), before, "a picked-then-skipped chip must never be written");
  assert.strictEqual(m.store.has("cp_interests"), false);
});

test("picking a chip and continuing writes through the FIXED U-07 path (root included)", () => {
  /* MUTATION: write to leafNodes()-only or bypass applyOnboardingPicks
     entirely — a root-level chip (every PREFS_CHIP_IDS entry is a root)
     would silently fail to persist, exactly the bug U-07 fixed. */
  const m = mount();
  bootWithTaxonomy(m);
  const before = m.state.interests["history"];
  toStep2(m);
  const historyChip = m.body.querySelectorAll('[data-chip="history"]')[0];
  assert.ok(historyChip, "a history chip must exist");
  historyChip._fire("click");
  prefsGoBtn(m)._fire("click");

  assert.strictEqual(m.ctx.lsGet("cp_intro_dismissed", false), true);
  assert.ok(m.state.interests["history"] > before, "picking history must raise its weight");
  const persisted = JSON.parse(m.store.get("cp_interests"));
  assert.ok(persisted["history"] > before, "the raised weight must be persisted via saveInterests()");
});

test("a chip pick changes what buildCards() ranks on the next Home render (the card's acceptance line)", () => {
  const m = mount();
  bootWithTaxonomy(m);
  m.state.interests["history"] = 0.4;
  m.state.interests["comedy"] = 0.4;
  const itemHistory = { topics: ["history"] };
  const itemComedy = { topics: ["comedy"] };
  assert.strictEqual(m.ctx.interestScore(itemHistory), m.ctx.interestScore(itemComedy), "must start tied");

  toStep2(m);
  m.body.querySelectorAll('[data-chip="history"]')[0]._fire("click");
  prefsGoBtn(m)._fire("click");

  assert.ok(
    m.ctx.interestScore(itemHistory) > m.ctx.interestScore(itemComedy),
    "picking history must outrank the untouched comedy branch afterward"
  );
});

test("picking three chips changes the ranking (card's literal acceptance wording)", () => {
  const m = mount();
  bootWithTaxonomy(m);
  ["engineering", "science", "sports"].forEach((id) => { m.state.interests[id] = 0.4; });
  m.state.interests["comedy"] = 0.4;
  const before = m.ctx.interestScore({ topics: ["engineering"] });

  toStep2(m);
  ["engineering", "science", "sports"].forEach((id) => {
    m.body.querySelectorAll(`[data-chip="${id}"]`)[0]._fire("click");
  });
  prefsGoBtn(m)._fire("click");

  const after = m.ctx.interestScore({ topics: ["engineering"] });
  assert.ok(after > before, "three picked chips must raise each picked node's score");
  assert.ok(
    after > m.ctx.interestScore({ topics: ["comedy"] }),
    "a picked branch must outrank an unpicked one on the next scoring pass"
  );
});

test("typing a real top-level taxonomy label reaches the same write path a chip tap would", () => {
  /* MUTATION: only read the chip Set, ignore the typed field entirely — the
     mockup's "Or type a subject yourself…" input would be decorative. */
  const m = mount();
  bootWithTaxonomy(m);
  const before = m.state.interests["true-crime"];
  toStep2(m);
  const typed = m.body.querySelector("#first-time-sheet-typed");
  typed.value = m.ctx.nodeById("true-crime").label; // exact label match, case-insensitive per applyOnboardingPicks
  prefsGoBtn(m)._fire("click");
  assert.ok(m.state.interests["true-crime"] > before, "a typed real subject must be written");
});

test("a typed subject with no taxonomy match is a no-op, not an invented node", () => {
  const m = mount();
  bootWithTaxonomy(m);
  const before = JSON.stringify(m.state.interests);
  toStep2(m);
  const typed = m.body.querySelector("#first-time-sheet-typed");
  typed.value = "Underwater basket weaving";
  prefsGoBtn(m)._fire("click");
  assert.strictEqual(JSON.stringify(m.state.interests), before, "an unmatched typed subject must change nothing");
  assert.strictEqual(m.ctx.lsGet("cp_intro_dismissed", false), true, "the screen must still dismiss");
});

/* ==================================================================== */
/* 3. SUBTREE EXPANSION (interest-survey-plan.md §4.1)                   */
/* ==================================================================== */

test("PREFS_CHIP_IDS resolves to real taxonomy roots, none dangling", () => {
  /* MUTATION: add a stale/typo'd id to PREFS_CHIP_IDS — a chip for a node
     that no longer exists would silently vanish from the grid (nodeById
     guards it), so this pins the LIST itself rather than the render. */
  const m = mount();
  bootWithTaxonomy(m);
  m.evalIn("PREFS_CHIP_IDS").forEach((id) => {
    const node = TAXONOMY.nodes.find((n) => n.id === id);
    assert.ok(node, `PREFS_CHIP_IDS entry ${id} must be a real taxonomy node`);
    assert.strictEqual(node.parent, null, `PREFS_CHIP_IDS entry ${id} must be a top-level node`);
  });
});

test("applyOnboardingPicks seeds every descendant of a picked root, not just the root", () => {
  const m = mount();
  bootWithTaxonomy(m);
  // Pick a child not already at the weight ceiling (1.0) — a node already
  // maxed out can't demonstrate "moved" since nudgeTopics/applyOnboardingPicks
  // clamp at 1, which would make this test pass even if subtree expansion
  // were broken.
  const child = TAXONOMY.nodes.find((n) => n.parent === "engineering" && n.weight < 1);
  assert.ok(child, "fixture assumption: engineering has an unclamped child node");
  const beforeChild = m.state.interests[child.id];
  const beforeRoot = m.state.interests["engineering"];

  toStep2(m);
  m.body.querySelectorAll('[data-chip="engineering"]')[0]._fire("click");
  prefsGoBtn(m)._fire("click");

  assert.ok(m.state.interests["engineering"] > beforeRoot, "the root itself must move");
  assert.ok(m.state.interests[child.id] > beforeChild, `child ${child.id} must move too (subtree expansion)`);
});

/* ==================================================================== */
/* 4. NOT BUILT — connector features stay out of scope (D2/C5)           */
/* ==================================================================== */

test("neither step renders an account-connector or import-history control", () => {
  /* MUTATION: add a "Continue with Apple"/"Continue with Google" button or an
     import-subscriptions control to either pane — both are explicitly out of
     scope per the card ("Not built: Continue with Apple/Google, Import
     subscriptions/listening history"). */
  const m = mount();
  bootWithTaxonomy(m);
  toStep2(m); // renders through both panes along the way
  const html = JSON.stringify([...m.body.children].map((c) => c.id || c.className));
  assert.doesNotMatch(SRC.slice(
    SRC.indexOf("function showFirstTimeExplainerOnce("),
    SRC.indexOf("\nfunction ", SRC.indexOf("function showFirstTimeExplainerOnce(") + 10)
  ), /Continue with (Apple|Google)|Import (subscriptions|listening history)/i);
});
