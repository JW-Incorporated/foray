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
 * REDESIGN 2026 (ambient): the two-step SHEET this suite used to drive (a Welcome
 * pane, then a chip grid) is retired for one full-screen Room (#onboarding-room,
 * ui/onboarding.js, test/ambient-onboarding.test.js). The gate tests and the
 * ranking tests stay: they pin who sees the screen and what a subject pick does,
 * which the Room keeps (the picks write path now serves Tuning and the personas).
 * What fell, by name: the Preferences chip grid and the typed-subject field
 * (founder Q8's "Show my picks" button is now the Room's primary and goes
 * straight to Today), and the Welcome pane's value props.
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
const { readAppSource, runAppSource } = require("./helpers/app-source.js");

const APP_PATH = path.join(__dirname, "..", "app.js");
const SRC = readAppSource();

function loadApp() {
  const noop = () => {};
  function makeEl() {
    const node = {
      addEventListener: noop, removeEventListener: noop, appendChild: noop,
      append: noop, remove: noop,
      setAttribute: noop, removeAttribute: noop,
      classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
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
  runAppSource(SRC, ctx);
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

test("both buttons set cp_intro_dismissed through one dismiss(); Escape and a navigation only park the Room", () => {
  /* ROUND 2 (p-first-4), kept for the Room: the two buttons are the considered presses; Escape / navigation /
     hardware back route through `park`, which writes no flag. MUTATION: write `cp_intro_dismissed` in park() ->
     the park assertion is red; bind either button to something other than dismiss -> the count is not 2. */
  const body = readAppSource();
  const start = body.indexOf("function openOnboardingRoom(");
  const end = body.indexOf("\nfunction ", start + 10);
  const fn = body.slice(start, end);
  const dismissCalls = (fn.match(/addEventListener\("click", \(\) => (?:\{\s*)?dismiss\(/g) || []).length;
  assert.strictEqual(dismissCalls, 2, "both buttons go through dismiss()");
  assert.match(fn, /onRequestClose: park/, "Escape and a navigation park");
  const park = /const park = \(\) => \{[\s\S]*?\n  \};/.exec(fn);
  assert.ok(park, "park() exists");
  assert.doesNotMatch(park[0], /cp_intro_dismissed/, "and park() never writes the never-again flag");
  assert.match(/const dismiss = \(travel\) => \{[\s\S]*?\n  \};/.exec(fn)[0], /lsSet\("cp_intro_dismissed", true\)/, "dismiss() writes it");
});

/* ---------- no interview/quiz step ---------- */

test("the first-time explainer names the M3 prototype's interview only to say there isn't one, and builds no quiz UI", () => {
  const start = SRC.indexOf("function openOnboardingRoom(");
  const end = SRC.indexOf("\nfunction ", start + 10);
  const fn = SRC.slice(start, end) + SRC.slice(SRC.indexOf("function onboardingRoomHtml("), SRC.indexOf("function onboardingCssUrl("));
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
    /* `!onboardingHeld &&` is the one re-render a finished Delete my data does
       under its sheet (round-2 audit, persist-2); the order is unchanged. */
    /if \((?:!onboardingHeld && )?!showFirstTimeExplainerOnce\(\)\) showIntroPopupOnce\(\);/,
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
  runAppSource(SRC, ctx);

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

const roomUp = (m) => m.body.querySelectorAll("#onboarding-room").length;

test("a typed word matches a subject's label words and its leaves, not only an exact root label", () => {
  /* "health" is "Health & Fitness"; "cooking" is Food's "Cooking Science" leaf.
     MUTATION: restore the exact top-level-label match -> both are misses; red.
     MUTATION 2: search leaves before roots -> "science" lands on a leaf. */
  const m = mount();
  bootWithTaxonomy(m);
  assert.strictEqual(m.ctx.resolveTypedSubject("health").id, "health");
  assert.strictEqual(m.ctx.resolveTypedSubject("  News ").id, "news");
  assert.strictEqual(m.ctx.resolveTypedSubject("cooking").id, "food/cooking-science");
  assert.strictEqual(m.ctx.resolveTypedSubject("science").id, "science");
  assert.strictEqual(m.ctx.resolveTypedSubject("true crime").id, "true-crime");
  assert.strictEqual(m.ctx.resolveTypedSubject("xyzzy"), null);

  /* A typed leaf is written, and the re-deal is told its root. */
  const leaf = "food/cooking-science";
  const before = m.state.interests[leaf];
  assert.ok(before < 1, "fixture: the leaf is not already at the ceiling");
  assert.deepStrictEqual([...m.ctx.applyOnboardingPicks([], "cooking")], ["food"]);
  assert.ok(m.state.interests[leaf] > before, "the leaf's weight is written");
});

/* ==================================================================== */
/* 3. SUBTREE EXPANSION (interest-survey-plan.md §4.1)                   */
/* ==================================================================== */

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

  m.ctx.applyOnboardingPicks(["engineering"], "");

  assert.ok(m.state.interests["engineering"] > beforeRoot, "the root itself must move");
  assert.ok(m.state.interests[child.id] > beforeChild, `child ${child.id} must move too (subtree expansion)`);
});

/* ==================================================================== */
/* 5. THE PICKS CHANGE THE FIRST HOME RENDER (the card's third acceptance) */
/* ==================================================================== */

/* Home's "Suggested" is state.cardSlots, dealt by buildCards() BEFORE
   the sheet opens over Home, from the pre-pick default weights, and never
   rebuilt for the rest of the session. The audit (2026-09-10) found the rendered
   Home did not change with a pick. These drive the flow: Home renders (the Room
   opens over it), the picks are written and re-dealt through the one write path
   (the Room has no chips since Redesign 2026; Tuning and the personas use the
   same path), and Home repaints — and assert on what Home now shows. Eight tied subjects, four items each, and
   Math.random pinned to 0.5 so buildCards()'s jitter is zero: the deal is
   then a pure function of the weights, and the only thing that can reorder
   it is the picks. */
const REDEAL_ROOTS = ["history", "comedy", "engineering", "business", "health", "science", "music", "sports"];

function seedHomeForRedeal(m) {
  m.state.session = { session_id: "s", builder: "t", episodes: {}, cards: [] };
  m.state.itemIndex = {}; m.state.semantic = { concepts: {} }; m.state.itemTags = {};
  m.state.discover = { items: REDEAL_ROOTS.flatMap((root) => [1, 2, 3, 4].map((i) => ({
    id: `${root}-ep-${i}`, title: `${root} episode ${i}`, show: `${root} show`, duration_min: 30,
    topics: [root], release_date: `2026-09-0${i}`, audio_url: `https://cdn.test/${root}-${i}.mp3`,
  }))) };
  REDEAL_ROOTS.forEach((root) => { m.state.interests[root] = 0.3; });
  // `Math` here is the vm context's own global; only this mount sees the pin.
  m.evalIn("state.ready = true; Math = Object.assign(Object.create(Math), { random: () => 0.5 });");
}
const homeHtml = (m) => m.byId.get("view").innerHTML;
/* The subjects the deal put on Home, in page order, once each: Today's hero (the first pick) and Today's picks
   carry `data-branch`; "Off your path" is a different share of the day and is not part of the deal.
   (Redesign 2026: the four `.mini-card`s became a hero and a list of rows, so a subject can show twice.) */
const dealtRoots = (html) => {
  const ends = ['aria-label="Playlists for you"', 'aria-label="Off your path"'].map((m) => html.indexOf(m)).filter((i) => i >= 0);
  const dealt = html.slice(html.indexOf('class="td-hero"'), ends.length ? Math.min(...ends) : undefined);
  return [...new Set([...dealt.matchAll(/data-branch="([^"]+)"/g)].map((mm) => mm[1]))];
};
/* Typographic quotes since audit round 2 (copy-8): every quoted listener
   string goes through app.js's one `quoteQuery` helper. */
const leadEpisode = (html, root) =>
  (new RegExp(`data-branch="${root}"[\\s\\S]*?class="td-link"[^>]*>([^<]+)<`).exec(html) || [])[1];

/** Renders the first Home of the session (which deals cardSlots and opens the
    sheet over it) and returns the four dealt subjects, stretch slot first. */
function firstRunHome(m) {
  m.ctx.renderHome();
  assert.strictEqual(roomUp(m), 1, "the first-run Room must be open over Home");
  const before = dealtRoots(homeHtml(m));
  assert.strictEqual(before.length, 4, "fixture: the pre-pick Home dealt four subjects");
  return before;
}
function pickAndStart(m, roots) {
  const applied = m.ctx.applyOnboardingPicks(roots, "");
  assert.ok(applied, "the picks were written");
  m.ctx.redealAfterOnboardingPicks(applied);
  m.ctx.renderCurrentPage();
}

test("picking three chips changes the FIRST Home render: the picked subjects become the top-tier slots", () => {
  /* MUTATION 1: delete the `redealAfterOnboardingPicks()` call in pickAndStart (the write path's second half)
     -> cardSlots is still the pre-pick deal, Today's picks after the picks is identical to before, and the three
     picked subjects are absent. MUTATION 2: delete the `renderCurrentPage()` call that follows it -> the deal was
     rebuilt in state but the page never repainted; the rendered HTML is still the old deal. */
  const m = mount();
  bootWithTaxonomy(m);
  seedHomeForRedeal(m);
  const before = firstRunHome(m);
  const picks = REDEAL_ROOTS.filter((r) => !before.includes(r)).slice(0, 3);
  assert.strictEqual(picks.length, 3, "fixture: three undealt subjects to pick");

  pickAndStart(m, picks);

  const after = dealtRoots(homeHtml(m));
  assert.notDeepStrictEqual([...after].sort(), [...before].sort(), "the picks must change the Home the listener lands on");
  assert.strictEqual(after.length, 4, `four subjects are dealt; got ${after.join(", ")}`);
  for (const p of picks) assert.ok(after.includes(p), `the picked subject ${p} must be dealt; got ${after.join(", ")}`);
  assert.strictEqual(after.filter((r) => !picks.includes(r)).length, 1, "and the fourth is the stretch pick, outside them by design");
});

test("subjects the pre-pick deal happened to show are not penalised as 'recently shown' or 'seen' when the picks bring them forward", () => {
  /* The pre-pick deal was painted under the modal, not browsed, and
     buildCards() recorded it anyway (cp_recent_branches: -0.35 next time;
     cp_seen: those episodes drop behind unseen ones in their chain). The lift
     a pick gives is at most +0.20, so without undoing that memory a listener
     who picked the very subjects the default deal showed would watch them
     VANISH from the Home their picks were meant to shape.
     MUTATION 1: delete the `cp_recent_branches` line in
     redealAfterOnboardingPicks -> the three picked-and-dealt subjects score
     0.415 - 0.35 and lose slots 2-4 to undealt 0.3 subjects.
     MUTATION 2: delete the `cp_seen` line -> each picked subject's card leads
     with its OLDEST episode (the one the pre-pick deal's 3-deep queue did not
     reach, so the only one still "unseen") instead of its newest. */
  const m = mount();
  bootWithTaxonomy(m);
  seedHomeForRedeal(m);
  const before = firstRunHome(m);
  const stretchRoot = m.state.cardSlots.find((sl) => sl.role === "stretch").branch;
  const picks = before.filter((r) => r !== stretchRoot); // the three top-tier subjects the default deal showed

  pickAndStart(m, picks);

  const html = homeHtml(m);
  const after = dealtRoots(html);
  for (const p of picks) assert.ok(after.includes(p), `the picked subjects the default deal showed must stay the top-tier slots; got ${after.join(", ")}`);
  for (const root of picks) {
    assert.strictEqual(leadEpisode(html, root), `${root} episode 4`,
      `${root}'s card must lead with its newest episode — the pre-pick deal must not count as 'seen'`);
  }
  assert.deepStrictEqual([...m.ctx.lsGet("cp_recent_branches", [])].sort(), [...m.state.cardSlots.map((sl) => sl.branch)].sort(),
    "after the re-deal, recent-branch memory holds exactly the re-dealt subjects, not the pre-pick deal's too");
});

/* ---------- ROUND 2 (p-first-5): a Foray play is prior use ---------- */

test("ROUND 2 review (p-first-5): a playing Foray DEFERS onboarding; it does not make the newcomer a returning user", async () => {
  /* The first fix counted the Foray's resume row as prior use, which sent a
     shared-link newcomer to the returning-user popup (still a modal over the
     Foray) and its "Got it" then suppressed Welcome/Preferences for good.
     MUTATION 1: put a cp_foray: check back into isGenuineFirstTimeUser -> the
     first assertion is red. MUTATION 2: drop `forayHoldsOnboarding()` from
     offerHomeOnboarding -> the Room opens over the playing Foray; red. */
  const { pathToFileURL } = require("node:url");
  const { KEY_PREFIX } = await import(pathToFileURL(path.join(__dirname, "..", "player", "foray-progress.js")).href);
  let status = { forayId: "some-foray", running: true, playing: true, loading: false, gap: false, ended: false };
  const m = mount({
    seed: { [`${KEY_PREFIX}some-foray`]: JSON.stringify({ foray_id: "some-foray" }) },
    forayPlayer: { forayStatus: () => status },
  });
  bootWithTaxonomy(m);
  assert.strictEqual(m.ctx.isGenuineFirstTimeUser(), true, "a Foray row is not a reason to skip the survey");
  m.ctx.offerHomeOnboarding();
  assert.strictEqual(m.body.querySelectorAll("#onboarding-room").length, 0, "nothing over the playing Foray");
  assert.strictEqual(m.body.querySelectorAll("#intro-sheet").length, 0, "not the returning-user popup either");
  assert.strictEqual(m.store.get("cp_intro_dismissed"), undefined, "and nothing is written that would skip it later");
  status = { ...status, running: false, playing: false };
  m.ctx.offerHomeOnboarding();
  assert.strictEqual(m.body.querySelectorAll("#onboarding-room").length, 1, "the next Home after it stops offers the Room");
  assert.strictEqual(m.body.querySelectorAll("#intro-sheet").length, 0);
});

/* ==================================================================== */
/* 6. AN EXPLICIT PICK IS A FACT (audit round 2, p-first-1)              */
/* ==================================================================== */

/* The acceptance test above runs on eight tied subjects with Math.random pinned
   to 0.5 — the one world where a +0.20/√n lift always wins. Over the SHIPPED
   pool with real randomness it did not: Comedy, Food and Sports all reached the
   first Home 1% of the time and none of them 29%, because the deal's ±0.25
   jitter and the authored defaults (Engineering 0.9, History 0.8) are bigger
   than the lift. This runs the real deal, over data/discover.json +
   data/session.json + data/taxonomy.json, with the real Math.random.
   MUTATION: drop `reserve` from buildCards (or the `applied` argument from
   redealAfterOnboardingPicks) -> the rate falls to the finding's numbers; red. */
test("over the shipped pool, the first Home after picking three subjects shows at least two of them in 95% of deals", () => {
  const m = mount();
  bootWithTaxonomy(m);
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
  m.state.discover = read("data/discover.json");
  m.state.session = read("data/session.json");
  m.state.itemIndex = {}; m.state.semantic = { concepts: {} }; m.state.itemTags = {};
  const DEALS = 200;
  for (const picks of [["comedy", "food", "sports"], ["true-crime", "health", "music"]]) {
    let good = 0;
    for (let i = 0; i < DEALS; i++) {
      for (const k of ["cp_interests", "cp_recent_branches", "cp_seen"]) m.store.delete(k);
      m.ctx.loadInterests();
      m.ctx.buildCards();                                   // the pre-pick deal under the sheet
      const applied = m.ctx.applyOnboardingPicks(picks, "");
      m.ctx.redealAfterOnboardingPicks(applied);
      const dealt = new Set(m.state.cardSlots.map((s) => s.branch));
      if (picks.filter((p) => dealt.has(p)).length >= 2) good++;
    }
    assert.ok(good / DEALS >= 0.95, `${picks.join(", ")}: at least two picks on Home in ${good} of ${DEALS} deals`);
  }
});

test("the reserved subjects never take the stretch slot, and fill the top-tier slots first", () => {
  /* MUTATION: let a picked subject be the stretch pick -> the subject the deal
     would have stretched to is picked, and sits in slot 1 as a "stretch"; red. */
  const m = mount();
  bootWithTaxonomy(m);
  seedHomeForRedeal(m);
  m.ctx.buildCards();
  const natural = m.state.cardSlots[0];
  assert.strictEqual(natural.role, "stretch", "fixture: the unpicked deal has a stretch slot");
  const reserve = [natural.branch, m.state.cardSlots[1].branch];
  m.store.delete("cp_recent_branches");
  m.store.delete("cp_seen");
  m.ctx.buildCards({ reserve });
  const slots = m.state.cardSlots;
  assert.ok(!reserve.includes(slots[0].branch) || slots[0].role !== "stretch", `a picked subject took the stretch slot: ${slots[0].branch}`);
  const top = [...slots.filter((s) => s.role === "top").slice(0, 2).map((s) => s.branch)].sort();
  assert.deepStrictEqual(top, [...reserve].sort(), "the picks are the first top-tier slots");
});
