/* THE PERSONA PICK IN THE FIRST-RUN SHEET (issue #70; docs/roadmap/
 * catalogue-personalization.md PKG-14).
 *
 * PKG-13 (#1058) taught the client to read data/personas.json and to seed a
 * persona as a DECAYING PRIOR (`applyPersonaPick`, pinned by
 * test/personas-client.test.js), but nothing a listener could touch ever
 * called it: the research's five listener profiles changed nothing anyone
 * experienced. This suite pins the listener-facing half, in the one
 * onboarding sheet (`openOnboardingSheet`, code-health CH-38): step 2 offers
 * the five directed personas (never the generalist, which is what a skip
 * already leaves) as single-select pills above the subject chips, and
 * "Show my picks" seeds the lit one before the chips, then re-deals the
 * FIRST Home once with the union of their subjects.
 *
 * What it must not do, and this suite proves it does not: write anything on a
 * tap (a pill only lights) or on a Skip; nag a returning listener (the sheet
 * is first-run only); log an event (persona_picked has no approved privacy
 * row, so the pick stays as local and as silent as a chip tap); or apply the
 * persona when the typed subject missed and the sheet stays open.
 *
 * Runs the REAL app.js in a node:vm over test/helpers/fake-dom.js, with the
 * real data/taxonomy.json and data/personas.json seeded into state (init's
 * fetches never resolve here — the shortcut test/first-time-onboarding.test.js
 * and test/personas-client.test.js take). Every test names the mutation that
 * kills it, per CLAUDE.md.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { El } = require("./helpers/fake-dom.js");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const TAXONOMY = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "taxonomy.json"), "utf8"));
const PERSONAS = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "personas.json"), "utf8"));
const DIRECTED = PERSONAS.personas.filter((p) => p.id !== PERSONAS.default_persona_id);

// init() runs on load and its fetches never resolve; swallow the stray
// rejections once for the whole file.
process.on("unhandledRejection", () => {});

function mount({ seed = {} } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const body = new El("body");
  const view = new El("main"); view.id = "view"; body.appendChild(view);
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
      body, documentElement: body, readyState: "complete", hidden: false,
      addEventListener() {}, removeEventListener() {},
      createElement: (t) => new El(t),
      querySelector: (s) => (String(s).trim() === "#view" ? view : body.querySelector(s)),
      querySelectorAll: (s) => body.querySelectorAll(s),
    },
    navigator: { userAgent: "node", onLine: true },
    addEventListener() {}, removeEventListener() {},
    location: { hash: "#/", search: "", pathname: "/", href: "https://x.test/", protocol: "https:" },
    history: { replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout, queueMicrotask,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  const evalIn = (src) => vm.runInContext(src, ctx);
  const state = evalIn("state");
  // structuredClone so one test's state can never leak into the fixtures.
  state.taxonomy = structuredClone(TAXONOMY);
  state.personas = structuredClone(PERSONAS);
  ctx.loadInterests();
  return { ctx, evalIn, state, store, body, view };
}

/** Fires every click listener on `el` without consuming them (fake-dom's own
    click() treats listeners as once-only, and a pill is tapped twice here). */
function tap(el) {
  for (const fn of el._on.get("click") || []) fn({ target: el, preventDefault() {}, stopPropagation() {} });
}

const $ = (m, sel) => m.body.querySelector(sel);
const pills = (m) => m.body.querySelectorAll(".ft-persona");
const pill = (m, id) => pills(m).find((p) => p.dataset.persona === id);
const chip = (m, id) => m.body.querySelectorAll(".fy-chip").find((c) => c.dataset.chip === id);
const lit = (m) => pills(m).filter((p) => p.classList.contains("on")).map((p) => p.dataset.persona);

/** Opens the first-run sheet and presses "Get started" (step 1 -> step 2). */
function toStep2(m) {
  assert.strictEqual(m.ctx.showFirstTimeExplainerOnce(), true, "fixture: a first-ever visit opens the sheet");
  tap($(m, "#first-time-sheet-go"));
  assert.match($(m, "#first-time-sheet-title").textContent, /What are you into/, "fixture: step 2 is on screen");
}

test("step 2 offers one pill per directed persona, never the generalist, under a one-line lead", () => {
  /* MUTATION: drop the `default_persona_id` filter -> six pills, generalist
     among them; red. MUTATION: render the pills without personas.json loaded
     (no `if (personas.length)` guard) -> an empty row and an orphan lead line
     in the second half; red. */
  const m = mount();
  toStep2(m);
  assert.deepStrictEqual(pills(m).map((p) => p.dataset.persona), DIRECTED.map((p) => p.id));
  assert.deepStrictEqual(pills(m).map((p) => p.textContent), DIRECTED.map((p) => p.label), "each pill reads persona.label");
  assert.ok(!pill(m, PERSONAS.default_persona_id), "the generalist is what a skip leaves; it is not a pill");
  for (const p of pills(m)) {
    assert.strictEqual(p.tagName, "BUTTON");
    assert.strictEqual(p.getAttribute("aria-pressed"), "false", "no pill starts lit");
  }
  const lead = $(m, ".ft-personas-lead");
  assert.ok(lead, "a lead line introduces the pills");
  const words = lead.textContent.trim().split(/\s+/);
  assert.ok(words.length <= 12, `the lead is at most 12 words (PKG-14), got ${words.length}`);
  assert.doesNotMatch(lead.textContent, /\b(we|us|our)\b/i, "4a never says 'we'");
  assert.strictEqual($(m, "#first-time-sheet-personas").getAttribute("aria-labelledby"), lead.id,
    "the row is a group named by its lead line");

  // personas.json 404'd (fetchJson -> null): no row, no lead, the chips stand alone.
  const bare = mount();
  bare.state.personas = null;
  toStep2(bare);
  assert.strictEqual(pills(bare).length, 0);
  assert.strictEqual($(bare, ".ft-personas-lead"), null);
  assert.strictEqual($(bare, "#first-time-sheet-personas"), null);
  assert.ok(bare.body.querySelectorAll(".fy-chip").length > 0, "the subject chips still render");
});

test("a pill is single-select, a second tap clears it, and tapping writes nothing", () => {
  /* MUTATION: drop the loop that unlights the other pills -> two pills lit at
     once; red. MUTATION: call applyPersonaPick() in the pill's click handler
     (seeding on tap, not on "Show my picks") -> cp_interests is written by a
     tap; red. */
  const m = mount();
  toStep2(m);
  const before = JSON.stringify(m.state.interests);
  tap(pill(m, "history-and-ideas"));
  assert.deepStrictEqual(lit(m), ["history-and-ideas"]);
  assert.strictEqual(pill(m, "history-and-ideas").getAttribute("aria-pressed"), "true");
  tap(pill(m, "comedy-and-culture"));
  assert.deepStrictEqual(lit(m), ["comedy-and-culture"], "lighting a second pill unlights the first");
  assert.strictEqual(pill(m, "history-and-ideas").getAttribute("aria-pressed"), "false");
  tap(pill(m, "comedy-and-culture"));
  assert.deepStrictEqual(lit(m), [], "a second tap on the lit pill clears the pick");
  assert.strictEqual(JSON.stringify(m.state.interests), before, "a tap only lights a pill");
  assert.strictEqual(m.store.has("cp_interests"), false, "nothing is saved on a tap");
});

test("persona + Show my picks lifts the persona's top root more than the same chip pick alone, and logs nothing", () => {
  /* MUTATION: skip applyPersonaPick() in the "Show my picks" handler -> the
     persona's top root rises by the chip lift only; red. MUTATION: add
     logEvent("persona_picked", ...) -> an event is recorded; red (and
     test/legal-citations.test.js would fail on the uncounted type). */
  const p = persona("history-and-ideas");
  const top = [...p.weights].sort((a, b) => b.weight - a.weight)[0].node_id;
  // Room under the clamp for both lifts to show: history defaults to 0.8.
  const run = (withPersona) => {
    const m = mount();
    m.state.interests[top] = 0.3;
    toStep2(m);
    if (withPersona) tap(pill(m, p.id));
    tap(chip(m, top));
    tap($(m, "#first-time-sheet-prefs-go"));
    assert.strictEqual(m.ctx.lsGet("cp_intro_dismissed", false), true, "Show my picks ends onboarding");
    assert.strictEqual($(m, "#first-time-sheet"), null, "the sheet is gone");
    return m;
  };
  const chipOnly = run(false);
  const both = run(true);
  assert.ok(both.state.interests[top] > chipOnly.state.interests[top],
    `${top}: persona + chip ${both.state.interests[top]} must exceed chip alone ${chipOnly.state.interests[top]}`);
  const saved = JSON.parse(both.store.get("cp_interests"));
  assert.ok(Math.abs(saved[top] - both.state.interests[top]) < 1e-9, "the lift is saved through the interest path");
  // A second persona root the chip never touched rose too: the whole prior applied.
  const other = p.weights.find((w) => w.node_id !== top).node_id;
  assert.ok(both.state.interests[other] > chipOnly.state.interests[other], `${other} carries the persona's lift`);
  assert.deepStrictEqual(
    [...both.store.keys()].filter((k) => /persona/i.test(k)), [],
    "a prior, not config: no persona key is stored"
  );
  // No window.forayEventLog in this harness, so every logEvent() row waits in
  // app.js's pre-module buffer, where it can be read back.
  const events = both.evalIn("_bufferedEvents");
  assert.ok(Array.isArray(events), "fixture: the event buffer is readable");
  assert.ok(!events.some((e) => /persona/i.test(JSON.stringify(e))), "no persona event is logged");
  assert.ok(![...both.store.values()].some((v) => /persona_picked/.test(v)), "no persona_picked anywhere in storage");
});

/* ---------- the FIRST Home reflects a persona picked alone ---------- */

// Eight subjects, four items each, all tied at 0.3, and Math.random pinned to
// 0.5 so buildCards()'s jitter is zero (test/first-time-onboarding.test.js's
// re-deal fixture): the deal is then a pure function of the weights.
const COMEDY = () => persona("comedy-and-culture");
const HOME_ROOTS = ["history", "engineering", "business", "science", "comedy", "culture", "tv-film", "music"];
function seedHome(m) {
  m.state.session = { session_id: "s", builder: "t", episodes: {}, cards: [] };
  m.state.itemIndex = {}; m.state.semantic = { concepts: {} }; m.state.itemTags = {};
  m.state.discover = { items: HOME_ROOTS.flatMap((root) => [1, 2, 3, 4].map((i) => ({
    id: `${root}-ep-${i}`, title: `${root} episode ${i}`, show: `${root} show`, duration_min: 30,
    topics: [root], release_date: `2026-09-0${i}`, audio_url: `https://cdn.test/${root}-${i}.mp3`,
  }))) };
  HOME_ROOTS.forEach((root) => { m.state.interests[root] = 0.3; });
  m.evalIn("state.ready = true; Math = Object.assign(Object.create(Math), { random: () => 0.5 });");
}
const dealt = (m) => [...m.view.innerHTML.matchAll(/class="mini-card" data-branch="([^"]+)"/g)].map((x) => x[1]);

test("a persona picked with no chips re-deals the first Home: its subjects take the top-tier slots", () => {
  /* MUTATION: re-deal only when the CHIPS applied (`if (applied)` on
     applyOnboardingPicks' result alone) -> a persona-only pick changes the
     weights but the Home under the sheet stays the pre-pick deal; red.
     MUTATION: drop renderCurrentPage() after the re-deal -> state re-dealt,
     page never repainted; red. */
  const m = mount();
  seedHome(m);
  m.ctx.renderHome();
  const before = dealt(m);
  assert.strictEqual(before.length, 4, "fixture: the pre-pick Home dealt four subject cards");
  const personaRoots = COMEDY().weights.map((w) => w.node_id).filter((r) => HOME_ROOTS.includes(r));
  assert.ok(personaRoots.length >= 3, "fixture: the pool holds at least three of the persona's subjects");
  assert.ok(before.slice(1).some((r) => !personaRoots.includes(r)), "fixture: the pre-pick top tier is not already the persona's");

  tap($(m, "#first-time-sheet-go"));
  tap(pill(m, COMEDY().id));
  tap($(m, "#first-time-sheet-prefs-go"));

  const after = dealt(m);
  assert.strictEqual(after.length, 4);
  assert.notDeepStrictEqual(after, before, "the persona must change the Home the listener lands on");
  for (const r of after.slice(1)) {
    assert.ok(personaRoots.includes(r), `slots 2-4 are the persona's subjects; got ${after.join(", ")}`);
  }
  assert.ok(after.includes("comedy"), "the persona's strongest subject is dealt");
  assert.ok(!personaRoots.includes(after[0]), "the stretch slot stays outside the persona, by design");
});

test("Skip with a lit pill writes nothing, and the Home is not re-dealt", () => {
  /* MUTATION: apply the lit persona in the Skip handler (or on tap) ->
     cp_interests is written; red. */
  const m = mount();
  seedHome(m);
  m.ctx.renderHome();
  const before = dealt(m);
  const interests = JSON.stringify(m.state.interests);
  tap($(m, "#first-time-sheet-go"));
  tap(pill(m, COMEDY().id));
  tap($(m, "#first-time-sheet-prefs-skip"));
  assert.strictEqual(m.ctx.lsGet("cp_intro_dismissed", false), true, "Skip still ends onboarding");
  assert.strictEqual(JSON.stringify(m.state.interests), interests, "a lit-then-skipped pill is never written");
  assert.strictEqual(m.store.has("cp_interests"), false);
  assert.deepStrictEqual(dealt(m), before, "Skip leaves the Home under the sheet as it was");
});

test("a typed miss with a lit pill applies nothing and keeps the pill lit", () => {
  /* MUTATION: call applyPersonaPick() before the typed subject is resolved ->
     the persona is written although the sheet stayed open on the miss, and a
     second press would lift it twice; red. */
  const m = mount();
  toStep2(m);
  const before = JSON.stringify(m.state.interests);
  tap(pill(m, "true-crime-and-story"));
  $(m, "#first-time-sheet-typed").value = "zzqx no such subject";
  tap($(m, "#first-time-sheet-prefs-go"));
  assert.ok($(m, "#first-time-sheet"), "the sheet stays open on a typed miss");
  assert.strictEqual(JSON.stringify(m.state.interests), before, "nothing is written on a miss");
  assert.strictEqual(m.store.has("cp_interests"), false);
  assert.deepStrictEqual(lit(m), ["true-crime-and-story"], "the pick survives the miss");
});

test("a returning listener is never offered the persona pick", () => {
  /* Issue #70: "Returning users never see it again". The pick lives only in
     the first-run sheet, which opens only for a genuine first-ever visit that
     has not dismissed it. MUTATION: delete `if (!isGenuineFirstTimeUser())
     return false;` in showFirstTimeExplainerOnce -> a listener with history
     is offered the pills; red. MUTATION: delete the cp_intro_dismissed gate
     -> a newcomer who already finished onboarding is offered them again; red. */
  const withHistory = mount({ seed: { cp_history: JSON.stringify(["ep-1"]) } });
  assert.strictEqual(withHistory.ctx.showFirstTimeExplainerOnce(), false);
  assert.strictEqual(withHistory.body.querySelectorAll("#first-time-sheet").length, 0);

  const dismissed = mount({ seed: { cp_intro_dismissed: "true" } });
  assert.strictEqual(dismissed.ctx.showFirstTimeExplainerOnce(), false);
  assert.strictEqual(dismissed.body.querySelectorAll("#first-time-sheet").length, 0);

  // And the returning listener's own popup (the one a returning listener CAN
  // see) carries no persona row.
  withHistory.ctx.showIntroPopupOnce();
  assert.ok($(withHistory, "#intro-sheet"), "fixture: the returning-listener popup opened");
  assert.strictEqual(pills(withHistory).length, 0, "no persona pill outside the first-run sheet");
});

function persona(id) {
  const p = PERSONAS.personas.find((x) => x.id === id);
  assert.ok(p, `fixture: data/personas.json carries ${id}`);
  return p;
}
