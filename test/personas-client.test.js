/* PKG-13 (docs/roadmap/catalogue-personalization.md §3; issue #70, part 1):
 * the client loads data/personas.json and can seed a persona as a DECAYING
 * PRIOR through the existing interest machinery.
 *
 * Issue #70's rule: "A persona pick is allowed only as a decaying cold-start
 * prior, never as persisted config ... Observed signal must overtake it."
 * applyPersonaPick() adds `seed_confidence × weight` to each weighted root and
 * its leaves on top of the loaded weights, through the same clamp and the same
 * setInterest/saveInterests path a chip pick uses, and stores nothing else, so
 * the ordinary thumbs nudges wear the lift away. Test 3 proves that.
 *
 * Seeds the REAL data/taxonomy.json and data/personas.json into state, then
 * loadInterests(), the same shortcut test/first-time-onboarding.test.js
 * (bootWithTaxonomy) and test/interests-roots.test.js take. The node:vm
 * harness is the one test/explicit-badge.test.js uses.
 *
 * No persona_picked event here: the plan's fourth test belongs to step 4
 * (instrumentation + privacy-policy copy), which this change skips.
 *
 * Every test names the mutation that kills it, per CLAUDE.md "a green test
 * is not evidence until you have broken it".
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const TAXONOMY = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "taxonomy.json"), "utf8"));
const PERSONAS = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "personas.json"), "utf8"));

// init() runs on load and its fetches never resolve; swallow the stray
// rejections once for the whole file, not once per loadApp().
process.on("unhandledRejection", () => {});

function loadApp() {
  const noop = () => {};
  function makeEl() {
    return {
      addEventListener: noop, removeEventListener: noop, appendChild: noop,
      setAttribute: noop, removeAttribute: noop,
      classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
      style: {}, dataset: {}, children: [], hidden: false,
      innerHTML: "", textContent: "", className: "",
      querySelector: () => makeEl(), querySelectorAll: () => [],
    };
  }
  const viewEl = makeEl();
  const store = new Map();
  const ctx = {
    console,
    fetch: () => new Promise(() => {}),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: {
      body: makeEl(), documentElement: makeEl(),
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
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  const state = vm.runInContext("state", ctx);
  return { ctx, state, store };
}

/** A booted app with the real taxonomy + personas and interests loaded. */
function boot() {
  const m = loadApp();
  // structuredClone so one test's state can never leak into the fixtures.
  m.state.taxonomy = structuredClone(TAXONOMY);
  m.state.personas = structuredClone(PERSONAS);
  m.ctx.loadInterests();
  return m;
}

const persona = (id) => PERSONAS.personas.find((p) => p.id === id);
const subtree = (rootId) => TAXONOMY.nodes.filter((n) => n.id === rootId || n.parent === rootId).map((n) => n.id);
const near = (a, b) => Math.abs(a - b) < 1e-9;
// A thumbs-down whose reason is about the subject: the only kind that moves
// interest weights (voteNudge, audit round 2 p-foray-6).
const thumbsDown = (m) => m.ctx.voteNudge({ direction: "down", reasons: ["Not my subject"] });

test("applyPersonaPick lifts the persona's roots and their leaves by seed_confidence × weight", () => {
  /* MUTATION: drop `persona.seed_confidence *` (lift by `weight` alone). Every
     health-and-performance subtree starts at 0.5, so 0.5 + 0.9 clamps to 1 and
     health no longer reads 0.5 + 0.35 × 0.9 = 0.815. Also killed by lifting the
     root only (no expandTaxonomyPick): the leaves stay at 0.5. */
  const m = boot();
  const p = persona("health-and-performance");
  assert.ok(p, "fixture: data/personas.json carries health-and-performance");
  const before = { ...m.state.interests };
  const gen = m.state._interestsGen || 0;

  const roots = m.ctx.applyPersonaPick(p.id);

  assert.deepStrictEqual([...roots], p.weights.map((w) => w.node_id), "returns the lifted ROOT ids, in persona order");
  const lifted = new Set();
  for (const { node_id, weight } of p.weights) {
    const ids = subtree(node_id);
    assert.ok(ids.length > 1, `fixture: ${node_id} has leaves`);
    for (const id of ids) {
      lifted.add(id);
      const want = Math.max(0, Math.min(1, before[id] + p.seed_confidence * weight));
      assert.ok(want < 1, `fixture: ${id} must not clamp, or the lift size is not observable`);
      assert.ok(near(m.state.interests[id], want), `${id}: expected ${want}, got ${m.state.interests[id]}`);
    }
  }
  for (const [id, v] of Object.entries(before)) {
    if (!lifted.has(id)) assert.strictEqual(m.state.interests[id], v, `${id} is not in the persona and must not move`);
  }
  const saved = JSON.parse(m.store.get("cp_interests"));
  assert.ok(near(saved.health, m.state.interests.health), "the lift is persisted through saveInterests");
  assert.strictEqual(m.state._interestsGen, gen + 1, "_interestsGen bumps so the next rebuild re-scores");
  assert.deepStrictEqual(
    [...m.store.keys()].filter((k) => /persona/i.test(k)), [],
    "a prior, not config: no persona key is ever stored"
  );
});

test("an unknown persona id returns false and writes nothing", () => {
  /* MUTATION: remove `if (!persona) return false;` (the pick then throws on
     `persona.weights`), or move the _interestsGen bump / saveInterests() above
     the early returns. Also covers personas.json absent (state.personas null):
     MUTATION drop the `?.` / `|| []` in personaById and it throws. */
  const m = boot();
  const before = JSON.stringify(m.state.interests);
  const gen = m.state._interestsGen;

  assert.strictEqual(m.ctx.applyPersonaPick("no-such-persona"), false);
  assert.strictEqual(m.ctx.applyPersonaPick(undefined), false);
  assert.strictEqual(m.ctx.personaById("no-such-persona"), null);

  m.state.personas = null; // the fetch 404'd: fetchJson returns null
  assert.strictEqual(m.ctx.personaById("history-and-ideas"), null);
  assert.strictEqual(m.ctx.applyPersonaPick("history-and-ideas"), false);

  assert.strictEqual(JSON.stringify(m.state.interests), before, "no weight moved");
  assert.strictEqual(m.store.has("cp_interests"), false, "nothing was saved");
  assert.strictEqual(m.state._interestsGen, gen, "no re-score was asked for");
});

test("the pick is a prior: four thumbs-down nudges on the lifted root bring it below the unlifted default", () => {
  /* Issue #70: "Picking a persona seeds a *prior*, not config -- observed
     signal overtakes it, with a test." The signal here is the real one: four
     subject thumbs-down through nudgeTopics, at voteNudge's own size.
     MUTATION: lift × 10 (`persona.seed_confidence * weight * 10`). medicine
     then clamps at 1 and four downs leave it at 0.68, above its 0.5 default;
     and in the sweep below, every root the clamp would otherwise hide stays
     above where it started after five downs. Run: red on both. */
  const m = boot();
  const down = thumbsDown(m);
  assert.ok(down < 0, "fixture: a subject thumbs-down lowers the weight");

  const def = m.state.interests.medicine;
  m.ctx.applyPersonaPick("health-and-performance");
  assert.ok(m.state.interests.medicine > def, "the persona lifted medicine");
  for (let i = 0; i < 4; i++) m.ctx.nudgeTopics(["medicine"], down);
  assert.ok(
    m.state.interests.medicine < def,
    `four thumbs-down must overtake the prior: ${m.state.interests.medicine} vs default ${def}`
  );

  /* The general claim, for every directed persona and every root it lifts:
     the largest lift (0.35 × 1.0) is worth less than five subject
     thumbs-down, so observed signal always overtakes the prior. */
  const maxLift = Math.max(...PERSONAS.personas.flatMap((p) => p.weights.map((w) => p.seed_confidence * w.weight)));
  assert.ok(maxLift <= -5 * down, `fixture: the largest persona lift (${maxLift}) fits inside five thumbs-down`);
  for (const p of PERSONAS.personas) {
    if (p.id === PERSONAS.default_persona_id) continue;
    // One boot per persona: a nudge on a ROOT never propagates (roots have
    // no parent), so the roots can be worn down one after another.
    const fresh = boot();
    const start = { ...fresh.state.interests };
    fresh.ctx.applyPersonaPick(p.id);
    for (const { node_id } of p.weights) {
      for (let i = 0; i < 5; i++) fresh.ctx.nudgeTopics([node_id], down);
      assert.ok(
        fresh.state.interests[node_id] <= start[node_id] + 1e-9,
        `${p.id} / ${node_id}: five thumbs-down left ${fresh.state.interests[node_id]}, above its pre-pick ${start[node_id]}`
      );
    }
  }
});

test("init's document batch names data/personas.json", () => {
  /* Source regex, as first-time-onboarding.test.js's renderHome test does.
     MUTATION: remove `fetchJson("data/personas.json")` from documentsP, or drop
     `state.personas` from the destructure (or move it off the END, so it would
     take another document's slot). */
  const start = SRC.indexOf("const documentsP = Promise.all([");
  assert.ok(start > 0, "init's documentsP batch moved");
  const batch = SRC.slice(start, SRC.indexOf("]);", start));
  assert.match(batch, /fetchJson\("data\/personas\.json"\),?\s*$/, "data/personas.json is the LAST document in the batch");
  assert.match(
    SRC,
    /state\.catalog,\s*state\.personas,\s*\] = await documentsP;/,
    "state.personas is the LAST name in the destructure, matching the batch order"
  );
});
