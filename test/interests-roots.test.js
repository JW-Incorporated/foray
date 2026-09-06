/* U-07's bug fix (docs/ui-transition-plan.md D6, kanban card t_1cb3688a).
 *
 * THE BUG: `loadInterests()` used to seed `state.interests` from
 * `leafNodes()` only — every taxonomy node with a non-null `parent`. A ROOT
 * node (e.g. `true-crime`, `parent: null`) was never written into
 * `state.interests` at all, so even though `saveInterests()` faithfully
 * persisted whatever was in that object, the root key was never there to
 * persist. A listener who set a root-level interest lost it on the very
 * next save/reload cycle, silently — no error, no warning, nothing on
 * screen ever said so.
 *
 * THE FIX: seed from every taxonomy node (roots AND leaves). This suite
 * proves the round trip survives, proves the fix generalizes (not just the
 * one root the card names), and includes the MUTATION TEST the card asks
 * for by name: restoring `leafNodes()` as the seed set must turn it red.
 *
 * Also covers nudgeTopics()'s damped parent-propagation (same card, D6:
 * "nudgeTopics() should propagate to the parent at a damped rate — state
 * the ratio; default 0.5").
 *
 * Harness: the same node:vm DOM stub + mountBooted pattern as
 * test/up-next-queue.test.js, booted against the real committed
 * data/taxonomy.json so this suite is proving something about the actual
 * shipped taxonomy, not a hand-rolled fixture that could quietly diverge
 * from it.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const TAXONOMY = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "taxonomy.json"), "utf8"));

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
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });

  const evalIn = (src) => vm.runInContext(src, ctx);
  return {
    ctx, evalIn, store, body,
    state: evalIn("state"),
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

const A_ROOT_ID = "true-crime";
assert.ok(
  TAXONOMY.nodes.some((n) => n.id === A_ROOT_ID && n.parent === null),
  `fixture assumption broken: ${A_ROOT_ID} must be a root node in data/taxonomy.json`
);

/* ==================================================================== */
/* 1. THE BUG: A ROOT INTEREST SURVIVES SAVE + RELOAD                    */
/* ==================================================================== */

test("a root-node interest set via Preferences survives saveInterests() and a reload", async () => {
  /* MUTATION: restore `leafNodes()` as loadInterests()'s seed set instead of
     `taxonomyNodes()`. state.interests[A_ROOT_ID] is never seeded, the
     Preferences-style write below still lands (it writes directly into the
     object), but reload's loadInterests() overwrites `state.interests`
     wholesale from the taxonomy set — which, under the mutation, excludes
     the root — so the value is gone and this assertion fails. */
  const m = await mountBooted();
  // Simulate Preferences (U-09) writing a root-level pick directly into
  // state.interests, the same path that card names for its own writes.
  m.state.interests[A_ROOT_ID] = 0.9;
  m.ctx.saveInterests();

  // "Reload": a fresh boot against the same persisted localStorage.
  const reloaded = await mountBooted({ cp_interests: m.store.get("cp_interests") });
  assert.strictEqual(
    reloaded.state.interests[A_ROOT_ID], 0.9,
    "a root interest set before save must still be present after saveInterests() + reload"
  );
});

test("every root node in the taxonomy is seeded into state.interests on load, not only leaves", async () => {
  /* MUTATION: restore `leafNodes()` in loadInterests(). Every root id below
     would be `undefined` in state.interests instead of a number. */
  const m = await mountBooted();
  const roots = TAXONOMY.nodes.filter((n) => n.parent === null);
  assert.ok(roots.length > 0, "fixture assumption: taxonomy has root nodes");
  for (const r of roots) {
    assert.strictEqual(
      typeof m.state.interests[r.id], "number",
      `root node ${r.id} must be seeded into state.interests`
    );
  }
});

test("saveInterests() persists whatever loadInterests() seeded, roots included", async () => {
  const m = await mountBooted();
  m.ctx.saveInterests();
  const persisted = JSON.parse(m.store.get("cp_interests"));
  const roots = TAXONOMY.nodes.filter((n) => n.parent === null);
  for (const r of roots) {
    assert.strictEqual(
      typeof persisted[r.id], "number",
      `saveInterests() must persist root node ${r.id}`
    );
  }
});

/* ==================================================================== */
/* 2. nudgeTopics() DAMPED PARENT PROPAGATION (ratio 0.5)                */
/* ==================================================================== */

test("nudgeTopics on a leaf also moves its parent root, at half the leaf's delta", async () => {
  /* MUTATION: delete the parent-propagation block in nudgeTopics(), or
     change the ratio constant to something other than 0.5. Either way the
     root's weight after the nudge stops matching rootBefore + amount*0.5. */
  const m = await mountBooted();
  const leaf = TAXONOMY.nodes.find((n) => n.parent === A_ROOT_ID);
  assert.ok(leaf, `fixture assumption: ${A_ROOT_ID} must have at least one leaf`);

  const rootBefore = m.state.interests[A_ROOT_ID];
  const leafBefore = m.state.interests[leaf.id];
  m.ctx.nudgeTopics([leaf.id], 0.08);

  assert.strictEqual(
    m.state.interests[leaf.id],
    Math.max(0, Math.min(1, leafBefore + 0.08)),
    "the leaf itself must move by the full amount, clamped"
  );
  assert.strictEqual(
    m.state.interests[A_ROOT_ID],
    Math.max(0, Math.min(1, rootBefore + 0.08 * 0.5)),
    "the parent root must move by exactly half the leaf's delta"
  );
});

test("nudgeTopics on a root does not propagate a second hop (roots have no parent)", async () => {
  /* MUTATION: remove the `parent && parent in state.interests` guard so a
     root's own (null) parent is treated as a real key — would throw or
     write into state.interests[null]/state.interests[undefined]. */
  const m = await mountBooted();
  const before = { ...m.state.interests };
  m.ctx.nudgeTopics([A_ROOT_ID], 0.1);
  assert.strictEqual(
    m.state.interests[A_ROOT_ID],
    Math.max(0, Math.min(1, before[A_ROOT_ID] + 0.1))
  );
  // Nothing else in state.interests should have moved.
  const others = Object.keys(m.state.interests).filter((k) => k !== A_ROOT_ID);
  for (const k of others) {
    assert.strictEqual(m.state.interests[k], before[k], `${k} must be unaffected by a root-only nudge`);
  }
});

test("the propagated parent nudge is also clamped 0..1", async () => {
  /* MUTATION: propagate the parent delta without the Math.max(0, Math.min(1, ...))
     clamp. Driving the root to its ceiling first and nudging its leaf again
     would then push the root above 1. */
  const m = await mountBooted();
  const leaf = TAXONOMY.nodes.find((n) => n.parent === A_ROOT_ID);
  m.state.interests[A_ROOT_ID] = 0.98;
  m.ctx.nudgeTopics([leaf.id], 0.5);
  assert.ok(m.state.interests[A_ROOT_ID] <= 1, "the parent's nudged weight must stay clamped at 1");
  assert.strictEqual(m.state.interests[A_ROOT_ID], 1);
});
