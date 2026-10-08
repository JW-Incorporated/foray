/* Tuning (ex-Interests), #/interests — U-07's page (docs/ui-transition-plan.md D6, kanban card t_1cb3688a),
 * rebuilt by Redesign 2026, ambient (DIRECTION.md "Information architecture"): "Interests as sliders becomes three
 * states per subject (less, 4a's pick, more) inside Tuning, nearer to 'observed'."
 *
 * THE RULING THAT FELL: "interests are sliders, 0-1, keyboard-operable" (this suite's old tests 3, 5 and 7: the
 * slider's shape, its ARIA triad, the back-to-default button, its touch-action). They are replaced, not deleted: each
 * has its Tuning counterpart below. What did NOT fall, and is still pinned here: the route, the row set, the weights
 * (0-1, `cp_interests`, `state.interests`), the ranking effect, no history feed, the profile never shrunk by a
 * save, and no raw taxonomy id printed.
 *
 * WHAT THIS PROVES, in order:
 *  1. route() dispatches #/interests to renderInterests.
 *  2. The row set: every root, plus any node diverged from its taxonomy default — never every leaf
 *     unconditionally (that would defeat the point of only showing what matters).
 *  3. A row is a radiogroup of three Chips (Less, 4a's pick, More), named by the row's own label; the selected
 *     one is aria-checked and Lamp-filled; there are no sliders anywhere on the page.
 *  4. The state is OBSERVED from the stored weight: a weight the listener's plays moved reads as less or more.
 *  5. Choosing a state writes the weight through the REAL handler, persists via saveInterests(), and changes what
 *     the next Home ranks (the card's actual acceptance test, unchanged).
 *  6. "4a's pick" restores the taxonomy-authored default exactly (the old "Back to 4a's pick" button is the
 *     middle chip), and a state that would not differ from it is offered disabled, not as a dead choice.
 *  7. No history/evidence-feed markup anywhere on the page (D6).
 *  8. CSS: every chip is 44 tall, the selected one is the Lamp fill with its ink.
 *  9. The profile is never shrunk by a save: a missing taxonomy.json writes nothing, and an id the loaded taxonomy
 *     does not name survives (2026-09-22 audit). And no raw taxonomy id is printed.
 * 10. "Delete my data" clears the choice with every other cp_ key.
 *
 * Every test names the mutation that kills it, per CLAUDE.md "a green test is not evidence until you have
 * broken it".
 *
 * Harness: the same node:vm DOM stub + mountBooted pattern as test/interests-roots.test.js / test/up-next-queue.test.js,
 * with the group and chip elements the handler reads constructed by hand (this repo has no jsdom). The handler under
 * test is the REAL `bindInterestsControls`, never a stand-in.
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
const SETTINGS_CSS = fs.readFileSync(path.join(ROOT, "ui", "settings.css"), "utf8").replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, " ");
const PRIMITIVES_CSS = fs.readFileSync(path.join(ROOT, "ui", "primitives.css"), "utf8").replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, " ");
const TAXONOMY = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "taxonomy.json"), "utf8"));

process.on("unhandledRejection", () => {});

function makeEl(tag) {
  const listeners = new Map();
  return {
    tagName: String(tag || "div").toUpperCase(),
    id: null, className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    _fire(type, evt) {
      for (const fn of listeners.get(type) || []) fn(evt || {});
    },
    _count(type) { return (listeners.get(type) || []).length; },
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {}, click() {},
    remove() {},
  };
}

const PAGE_IDS = ["view", "menu-btn", "refresh-btn", "banner-slot", "pl-form", "pl-input", "pl-note", "sh-form", "sh-input", "sh-note", "sh-results"];

function mount({ seed = {}, boot = false } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const body = makeEl("body");

  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: (url) => {
      if (!boot) return new Promise(() => {});
      const file = path.join(ROOT, String(url));
      const ok = String(url).startsWith("data/") && fs.existsSync(file);
      return Promise.resolve({
        ok, status: ok ? 200 : 404,
        json: async () => JSON.parse(fs.readFileSync(file, "utf8")),
      });
    },
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

async function mountBooted(seed) {
  const m = mount({ seed, boot: true });
  for (let i = 0; i < 200 && !m.state.ready; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  assert.ok(m.state.ready, "init() never finished against the committed data files");
  return m;
}

/** Every `data-interest-id="..."` value in the rendered #view markup, in document order. */
function groupIds(html) {
  return [...html.matchAll(/data-interest-id="([^"]+)"/g)].map((m) => m[1]);
}

/** One row's markup: from its name element to the end of its radiogroup. */
function rowHtml(html, id) {
  const at = html.indexOf(`data-interest-id="${id}"`);
  if (at < 0) return null;
  const start = html.lastIndexOf('<div class="st-tune-row', at);
  const end = html.indexOf("</div></div>", at) + "</div></div>".length;
  return html.slice(start, end);
}

/** The three chips of a row, as { value, checked, disabled }. */
function chipsOf(html, id) {
  const row = rowHtml(html, id);
  assert.ok(row, `the ${id} row must render`);
  return [...row.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].map((m) => {
    const attr = (n) => (new RegExp(`${n}="([^"]*)"`).exec(m[1]) || [null, null])[1];
    return { value: attr("data-st-value"), checked: attr("aria-checked") === "true", disabled: /\sdisabled\b/.test(m[1]), label: m[2], role: attr("role"), selected: /class="[^"]*\bis-selected\b/.test(m[1]) };
  });
}

/** What the page wires for one row: the group element carrying data-interest-id, and a chip the handler reads. */
function tuneGroup(m, id) {
  const group = makeEl("div");
  group.getAttribute = (k) => (k === "data-interest-id" ? id : null);
  m.byId.get("view").querySelectorAll = (sel) => (sel === "[data-interest-id]" ? [group] : []);
  m.ctx.bindInterestsControls(m.byId.get("view"));
  return group;
}
function tapChip(group, which, { disabled = false } = {}) {
  const chip = makeEl("button");
  chip.disabled = disabled;
  chip.getAttribute = (k) => (k === "data-st-value" ? which : null);
  chip.closest = (sel) => (sel === "[data-st-value]" ? chip : null);
  group._fire("click", { target: chip });
}

const A_ROOT_ID = "true-crime";

/* ==================================================================== */
/* 1. ROUTING                                                            */
/* ==================================================================== */

test("route() dispatches #/interests to renderInterests", async () => {
  /* MUTATION: remove the `#/interests` branch in renderCurrentPage(). The
     hash falls through to renderHome() instead, and #view never gets a
     Tuning page. */
  const m = await mountBooted();
  m.ctx.location.hash = "#/interests";
  m.ctx.route();
  assert.ok(m.view().includes('data-st-page="tuning"'), "the #/interests route must render Tuning");
  assert.ok(m.view().includes(">Tuning<"), "and the page is named Tuning");
});

/* ==================================================================== */
/* 2. ROW SET: roots always; leaves only when diverged                   */
/* ==================================================================== */

test("every root renders as a row, even with no divergence from default", async () => {
  /* MUTATION: change interestGroups() to only include diverged roots. A
     root nobody has touched (value === node.weight) would disappear. */
  const m = await mountBooted();
  m.ctx.location.hash = "#/interests";
  m.ctx.route();
  const html = m.view();
  const roots = TAXONOMY.nodes.filter((n) => n.parent === null);
  for (const r of roots) {
    assert.ok(groupIds(html).includes(r.id), `root ${r.id} must have a row`);
  }
});

test("a leaf at its taxonomy default weight does NOT get a row", async () => {
  /* MUTATION: drop the divergence filter on leaves in interestGroups() (show
     every leaf unconditionally). Every leaf id would appear regardless of
     whether the listener ever touched it. */
  const m = await mountBooted();
  const untouchedLeaf = TAXONOMY.nodes.find(
    (n) => n.parent !== null && m.state.interests[n.id] === n.weight
  );
  assert.ok(untouchedLeaf, "fixture assumption: at least one leaf starts at its default weight");
  m.ctx.location.hash = "#/interests";
  m.ctx.route();
  assert.ok(
    !groupIds(m.view()).includes(untouchedLeaf.id),
    `an undiverged leaf (${untouchedLeaf.id}) must not clutter the page`
  );
});

test("a leaf nudged away from its default gets a row, grouped under its root", async () => {
  /* MUTATION: group diverged leaves under the wrong key (e.g. their own id
     instead of node.parent) — the leaf would render outside its root's
     .st-group entirely. */
  const m = await mountBooted();
  const leaf = TAXONOMY.nodes.find((n) => n.parent === A_ROOT_ID);
  m.state.interests[leaf.id] = Math.min(1, leaf.weight + 0.2);
  m.ctx.location.hash = "#/interests";
  m.ctx.route();
  const html = m.view();
  assert.ok(groupIds(html).includes(leaf.id), "the diverged leaf must have a row");
  // The leaf's row must appear textually within the same group block as its
  // root's group label (a loose but real ordering check given the no-DOM harness).
  const rootNode = TAXONOMY.nodes.find((n) => n.id === A_ROOT_ID);
  const groupBlockRe = new RegExp(
    `<h3 class="st-group-label t-headline">${rootNode.label}</h3>[\\s\\S]*?data-interest-id="${leaf.id}"`
  );
  assert.ok(groupBlockRe.test(html), `${leaf.id} must render inside the ${A_ROOT_ID} group block`);
});

/* ==================================================================== */
/* 3. THE SHAPE: three Chips in a radiogroup, no sliders                  */
/* ==================================================================== */

test("a row is a radiogroup of Less / 4a's pick / More, named by the row, with exactly one aria-checked", async () => {
  /* MUTATION: render a fourth chip, drop `role="radio"` or the `aria-labelledby` link from stSegHtml, or mark two
     chips checked. The listener's three words are the whole control; a screen reader needs the group's name
     and exactly one checked radio. */
  const m = await mountBooted();
  m.ctx.location.hash = "#/interests";
  m.ctx.route();
  const html = m.view();
  const chips = chipsOf(html, A_ROOT_ID);
  assert.deepStrictEqual(chips.map((c) => c.label), ["Less", "4a's pick", "More"].map((s) => s.replace("'", "&#39;")));
  assert.deepStrictEqual(chips.map((c) => c.value), ["less", "pick", "more"]);
  assert.ok(chips.every((c) => c.role === "radio"), "each chip is a radio");
  assert.strictEqual(chips.filter((c) => c.checked).length, 1, "exactly one is checked");
  const row = rowHtml(html, A_ROOT_ID);
  assert.match(row, /role="radiogroup" aria-labelledby="tune-name-true-crime"/, "the group is named by the row's own label");
  assert.match(row, /id="tune-name-true-crime">True Crime</, "which is the subject's name in words");
});

test("there are no sliders on the page", async () => {
  /* The ruling that fell. MUTATION: put an `<input type="range">` (or role="slider") back in interestTuneRow. */
  const m = await mountBooted();
  m.ctx.location.hash = "#/interests";
  m.ctx.route();
  const html = m.view();
  assert.ok(!/type="range"|role="slider"|interest-slider/.test(html), "no slider markup");
  assert.ok(!/\d+%/.test(html.replace(/<[^>]*>/g, " ")), "and no percentage is printed: a direction, not a number");
});

test("the chip that reads as selected is the one that is aria-checked, tabbable, and Lamp-filled", async () => {
  /* MUTATION: leave `is-selected` on the old chip after a tap (stSegSelect not called), or give every chip
     tabindex="0". The roving tabindex keeps one Tab stop per row of 40; the picture and the state agree. */
  const m = await mountBooted();
  m.ctx.location.hash = "#/interests";
  m.ctx.route();
  const row = rowHtml(m.view(), A_ROOT_ID);
  const tabbable = [...row.matchAll(/<button\b[^>]*tabindex="0"[^>]*>/g)];
  assert.strictEqual(tabbable.length, 1, "one Tab stop per row");
  assert.match(tabbable[0][0], /aria-checked="true"/, "and it is the checked one");
  assert.match(tabbable[0][0], /class="ag-chip is-selected"/, "which wears the Lamp fill class");
});

/* ==================================================================== */
/* 4. THE STATE IS OBSERVED                                              */
/* ==================================================================== */

test("a weight the listener's plays moved reads as less or more; a small drift reads as 4a's pick", async () => {
  /* "State observed, never declared" (product principle 2): the row shows where the stored weight IS. MUTATION:
     compute tuneState from a stored 'choice' instead of the weight, or drop TUNE_EPSILON (every drift of 0.01
     would read as a choice). */
  const m = await mountBooted();
  const node = TAXONOMY.nodes.find((n) => n.id === A_ROOT_ID);
  const state = (v) => { m.state.interests[node.id] = v; return m.evalIn(`tuneState(nodeById(${JSON.stringify(node.id)}))`); };
  assert.strictEqual(state(node.weight), "pick");
  assert.strictEqual(state(node.weight + 0.01), "pick", "a nudge under the epsilon is still 4a's pick");
  assert.strictEqual(state(node.weight + 0.2), "more");
  assert.strictEqual(state(node.weight - 0.2), "less");
  m.state.interests[node.id] = node.weight - 0.2;
  m.ctx.location.hash = "#/interests";
  m.ctx.route();
  assert.strictEqual(chipsOf(m.view(), node.id).find((c) => c.checked).value, "less", "and the page paints it");
});

/* ==================================================================== */
/* 5. ACCEPTANCE: choosing changes the next Home ranking                  */
/* ==================================================================== */

test("choosing More changes what buildCards() ranks on the next Home render, and persists", async () => {
  /* This is the card's own acceptance line, verbatim: "assert by seeding two nodes and flipping which is higher."
     interestScore() averages state.interests over an item's topics, and buildCards() ranks branches by
     avgInterest — so lifting one root above another must flip which branch buildCards() puts first among items
     whose only topic is that root.

     Drives the REAL handler bindInterestsControls wires to the radiogroup's click (a constructed group and chip,
     the same technique the old slider test used) rather than mutating state.interests directly — a version that
     pokes state.interests itself would pass even if the handler wrote to the wrong key or never called
     saveInterests() at all, which is exactly the "green test that pins nothing" shape CLAUDE.md warns about.

     MUTATION: make the handler write to a key OTHER than `id` (e.g. always state.interests[A_ROOT_ID]), skip
     saveInterests(), or map "more" to the default weight. rankAfter would not reflect the choice. */
  const m = await mountBooted();
  const roots = TAXONOMY.nodes.filter((n) => n.parent === null && n.weight === 0.5);
  const [rootA, rootB] = roots;
  assert.ok(rootA && rootB, "fixture assumption: at least two root nodes sit at 0.5");

  const itemA = { topics: [rootA.id] };
  const itemB = { topics: [rootB.id] };
  assert.strictEqual(m.ctx.interestScore(itemA), m.ctx.interestScore(itemB), "must start tied at 4a's own pick");

  m.ctx.location.hash = "#/interests";
  m.ctx.route();
  tapChip(tuneGroup(m, rootA.id), "more");

  assert.ok(m.ctx.interestScore(itemA) > m.ctx.interestScore(itemB), "rootA must now outrank rootB after More");
  assert.strictEqual(m.state.interests[rootA.id], 0.8, "More is the pick + 0.3");
  const persisted = JSON.parse(m.store.get("cp_interests"));
  assert.strictEqual(persisted[rootA.id], 0.8, "the choice must be persisted via saveInterests(), under the existing cp_interests key");

  tapChip(tuneGroup(m, rootB.id), "less");
  assert.strictEqual(m.state.interests[rootB.id], 0.2, "Less is 0.4 x the pick");
  assert.ok(m.ctx.interestScore(itemA) > m.ctx.interestScore(itemB));
  assert.ok((m.state._interestsGen || 0) >= 2, "each choice told the search cache its answers are stale");
});

/* ==================================================================== */
/* 6. 4a's pick IS THE RESET                                              */
/* ==================================================================== */

test("4a's pick restores the taxonomy-authored default exactly, and persists at once", async () => {
  /* MUTATION: reset to 0 (or 0.5) instead of Math.max(0, node.weight). A node whose taxonomy weight is not 0/0.5
     would come back wrong. */
  const m = await mountBooted();
  const leaf = TAXONOMY.nodes.find((n) => n.parent === A_ROOT_ID);
  m.state.interests[leaf.id] = Math.min(1, leaf.weight + 0.3);
  m.ctx.location.hash = "#/interests";
  m.ctx.route();
  tapChip(tuneGroup(m, leaf.id), "pick");
  assert.strictEqual(m.state.interests[leaf.id], Math.max(0, leaf.weight));
  const persisted = JSON.parse(m.store.get("cp_interests"));
  assert.strictEqual(persisted[leaf.id], Math.max(0, leaf.weight), "the choice must persist immediately");
});

test("a choice that would not differ from 4a's pick is offered disabled, and a tap on it changes nothing", async () => {
  /* A subject already at 1 has no "More"; at 0 no "Less". MUTATION: drop `tuneOffered` from chooseInterest or the
     `disabled` flag from interestTuneRow — a dead choice that looks live. */
  const m = await mountBooted();
  const node = { id: "x-top", label: "Top subject", parent: null, weight: 1 };
  const html = m.ctx.interestTuneRow(node);
  const more = [...html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].find((b) => /data-st-value="more"/.test(b[1]));
  assert.ok(/\sdisabled\b/.test(more[1]), "More is disabled where the pick is already 1");
  assert.strictEqual(m.ctx.chooseInterest("x-top", "more"), null, "and choosing it does nothing");
  const zero = { id: "x-zero", label: "Zero subject", parent: null, weight: 0 };
  const zeroHtml = m.ctx.interestTuneRow(zero);
  const less = [...zeroHtml.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].find((b) => /data-st-value="less"/.test(b[1]));
  assert.ok(/\sdisabled\b/.test(less[1]), "Less is disabled where the pick is already 0");
});

test("a disabled chip's tap never reaches the weights", async () => {
  /* MUTATION: drop the `chip.disabled` guard in bindInterestsControls AND the tuneOffered check -> red. The real
     chooseInterest is the second belt; this is the first. */
  const m = await mountBooted();
  const rootA = TAXONOMY.nodes.find((n) => n.parent === null);
  const before = m.state.interests[rootA.id];
  tapChip(tuneGroup(m, rootA.id), "more", { disabled: true });
  assert.strictEqual(m.state.interests[rootA.id], before, "a disabled chip did nothing");
});

/* ==================================================================== */
/* 7. NO HISTORY FEED / EVIDENCE LOG (D6)                                 */
/* ==================================================================== */

test("the tuning page renders no history/evidence markup", async () => {
  /* MUTATION: add any element carrying class="interest-history" or similar
     to renderInterests()'s template. D6 explicitly excludes this. */
  const m = await mountBooted();
  m.ctx.location.hash = "#/interests";
  m.ctx.route();
  const html = m.view();
  assert.ok(!/interest-history/i.test(html));
  assert.ok(!/evidence/i.test(html));
  assert.ok(!/recent signals/i.test(html));
});

/* ==================================================================== */
/* 8. CSS: 44-tall chips, the selected one is the Lamp fill               */
/* ==================================================================== */

test("every Tuning chip is 44 tall, and the selected one is Lamp with its ink", () => {
  /* The direction's words: "three states as a segmented control of 44-tall Chips, selected = Lamp fill, ink bg0".
     MUTATION: give `.ag .st-seg .ag-chip` a `min-height: 36px` (or drop the Chip's own min-height from
     primitives.css), or change the selected rule to `background: var(--ember)` -> red. */
  const chip = /\.ag \.ag-chip \{([^}]*)\}/.exec(PRIMITIVES_CSS)[1];
  assert.match(chip, /min-height:\s*var\(--tap\)/, "the Chip primitive is the 44px tap");
  assert.doesNotMatch(SETTINGS_CSS, /\.st-seg[^{]*\{[^}]*(?<![-\w])(min-)?height:/, "the segmented control never shortens its chips");
  const selected = /\.ag \.st-seg \.ag-chip\.is-selected \{([^}]*)\}/.exec(SETTINGS_CSS)[1];
  assert.match(selected, /background:\s*var\(--lamp\)/, "selected = the Lamp fill");
  assert.match(selected, /color:\s*var\(--lamp-ink\)/, "with the Lamp's ink");
});

/* ==================================================================== */
/* 9. THE PROFILE IS NEVER SHRUNK, AND NO DEVELOPER STRINGS (2026-09-22) */
/* ==================================================================== */

test("a missing taxonomy.json does not wipe the stored profile on the first play", () => {
  /* The audit's case: data/taxonomy.json 404s (a partial deploy, a stale
     service-worker generation), `loadInterests` seeds nothing, and the first
     play or thumb wrote `{}` over the listener's whole profile.

     Two rules guard it, and each is pinned on its own: with no taxonomy the
     save writes NOTHING (this test), and a save merges rather than replaces
     (the next one). Either alone keeps the profile; both are kept because a
     write the session had no basis for is still a write that can race.
     MUTATIONS THAT KILL THIS: drop the `if (!taxonomyNodes().length) return`
     guard — red, a write happened; or write `state.interests` alone AND drop
     the guard — red, the stored profile is `{}`. */
  const saved = { "true-crime": 0.9, "true-crime/cold-cases": 0.7 };
  const m = mount({ seed: { cp_interests: JSON.stringify(saved) } });
  assert.strictEqual(m.evalIn("state.taxonomy"), null, "premise: no taxonomy loaded");
  const writes = [];
  const realSet = m.ctx.localStorage.setItem;
  m.ctx.localStorage.setItem = (k, v) => { if (k === "cp_interests") writes.push(v); realSet(k, v); };
  m.evalIn("loadInterests()");
  m.evalIn('nudgeTopics(["true-crime"], 0.2)');         // what a play does
  assert.deepStrictEqual(JSON.parse(m.store.get("cp_interests")), saved);
  assert.deepStrictEqual(writes, [], "a session with no taxonomy wrote the profile anyway");
});

test("a stored interest the shipped taxonomy no longer names survives a save", () => {
  /* The same write used to delete any weight whose node a newer taxonomy had
     renamed or dropped — silently, on the next play.
     MUTATION THAT KILLS THIS: write `state.interests` alone instead of merging
     it over the stored row — red. */
  const m = mount({ seed: { cp_interests: JSON.stringify({ "retired/node": 0.8, food: 0.9 }) } });
  m.evalIn('state.taxonomy = { nodes: [{ id: "food", parent: null, weight: 0.5, label: "Food" }] };');
  m.evalIn("loadInterests()");
  m.evalIn('nudgeTopics(["food"], -0.1)');
  const stored = JSON.parse(m.store.get("cp_interests"));
  assert.strictEqual(stored["retired/node"], 0.8, "the unknown id was deleted by an unrelated play");
  assert.ok(Math.abs(stored.food - 0.8) < 1e-9, "and the known one still moved");
});

test("no Tuning row prints a raw taxonomy id, and the page speaks listener words", async () => {
  /* The persona audit found `engineering/energy-fusion`-style ids under every
     slider, "Reset to learned" (it resets to 4a's default, not to anything
     learned) and "overrule what 4a has learned". Plain words from the jargon
     ledger (docs/audit/persona-synthesis.md section 2). Tuning's copy keeps the rule: "subject", never
     "topic"; no we/us/our. */
  const m = await mountBooted();
  const leaf = TAXONOMY.nodes.find((n) => n.parent === A_ROOT_ID);
  m.state.interests[leaf.id] = Math.min(1, leaf.weight + 0.3);
  m.ctx.location.hash = "#/interests";
  m.ctx.route();
  const html = m.view();
  const text = html.replace(/<[^>]*>/g, " ");
  assert.ok(!text.includes(leaf.id), `the raw id ${leaf.id} is printed on the page`);
  assert.ok(!/interest-row-path/.test(html));
  assert.ok(!/Reset to learned|overrule|Drag a slider/.test(html), "the old wording is back");
  assert.match(html, /Choose less or more of a subject\. 4a&#39;s pick is where it starts\./);
  assert.ok(!/\btopics?\b/i.test(text), `"subject", not "topic": ${text.match(/.{20}\btopics?\b.{20}/i)}`);
  assert.ok(!/\b(we|us|our)\b/i.test(text), "no we/us/our");
  const lede = "Choose less or more of a subject. 4a's pick is where it starts.";
  assert.ok(lede.split(/\s+/).length <= 18, "inside the copy budget");
});

/* ==================================================================== */
/* 10. DELETE MY DATA                                                    */
/* ==================================================================== */

test("Delete my data clears the choice with every other cp_ key", async () => {
  /* The unit's acceptance line: "the choice persists through the shim under an existing cp_ key and delete-data
     still clears it". Drives the REAL clearStoredKeys (the page's own purge fallback), then reloads the profile
     the way the deletion does. MUTATION: write the choice under a key without the `cp_` prefix (renaming wipes user
     state, and escapes the purge) -> red here and in app-security. */
  const m = await mountBooted();
  const rootA = TAXONOMY.nodes.find((n) => n.parent === null && n.weight === 0.5);
  m.ctx.location.hash = "#/interests";
  m.ctx.route();
  tapChip(tuneGroup(m, rootA.id), "more");
  assert.ok(m.store.has("cp_interests"), "premise: the choice was stored");
  await m.ctx.clearStoredKeys();
  assert.ok(!m.store.has("cp_interests"), "the purge removed the profile");
  m.evalIn("state.interests = {}; interestsSetThisSession = new Set(); loadInterests();");
  assert.strictEqual(m.state.interests[rootA.id], rootA.weight, "and the next load is back at 4a's pick");
});
