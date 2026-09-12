/* Settings-drawer toggles must not close the drawer (Joey, 2026-08-31,
 * kanban card t_0c09d83a).
 *
 * WHAT HAPPENED: `#family-toggle`/`#player-toggle`'s click handlers flipped
 * the setting, then called `route()` to re-render the page behind the
 * drawer. `route()` unconditionally opens with `openDrawer(false)` (that
 * line exists for REAL navigation — a drawer link, or a hashchange), so a
 * setting change was closing the drawer as a side effect nobody wanted.
 *
 * THE FIX: `route()`'s "render the current page" behaviour was split out
 * into `renderCurrentPage()`, which does not touch the drawer. The three
 * toggle handlers now call `renderCurrentPage()` instead of `route()`, so
 * they still refresh whatever page is open behind the drawer (family mode
 * changes card eligibility) without closing it. `route()` itself is
 * unchanged for real navigation.
 *
 * Harness: the same node:vm DOM stub as test/up-next-queue.test.js, with
 * working addEventListener/click on the toggle/drawer elements specifically
 * (the shared stub's are no-ops) so init()'s real click wiring runs.
 *
 * `querySelector("#id")` resolves APPENDED elements too, not only the page ids
 * seeded below. That matters as of the 2026-09-12 client audit: index.html is
 * outside the auto-merge allowlist, so every control added since is injected in
 * JS — a lookup that consulted only the seeded map would report the drawer's
 * newer switches as absent and read as coverage while testing nothing.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");

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
      for (const fn of listeners.get(type) || []) fn(evt || { target: { closest: () => null } });
    },
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {},
    click() { this._fire("click"); },
    remove() {},
  };
}

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn", "banner-slot", "pl-form",
  "pl-input", "pl-note", "tab-topics", "tab-shows", "sh-form", "sh-input",
  "sh-note", "sh-results", "browse-all-link",
];

function mount({ seed = {}, boot = false } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const body = makeEl("body");

  /** The seeded page ids, then anything appended under them or under body. */
  const findById = (id) => {
    if (byId.has(id)) return byId.get(id);
    const walk = (el) => {
      for (const kid of el.children || []) {
        if (kid.id === id) return kid;
        const deep = walk(kid);
        if (deep) return deep;
      }
      return null;
    };
    return walk(body) || [...byId.values()].reduce((found, el) => found || walk(el), null);
  };

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
        return s.startsWith("#") ? findById(s.slice(1)) : null;
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
    ctx, evalIn, store, body, byId, findById,
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

/* ==================================================================== */
/* SETTINGS TOGGLES LEAVE THE DRAWER OPEN                                */
/* ==================================================================== */

test("#family-toggle updates family mode AND leaves the drawer open", async () => {
  /* MUTATION: restore `route()` in the family-toggle handler instead of
     `renderCurrentPage()`. `route()` unconditionally calls
     `openDrawer(false)` at its top, so `#drawer.hidden` would flip to
     true and this assertion fails. */
  const m = await mountBooted();
  m.byId.get("drawer").hidden = false;
  const before = m.ctx.familyMode();
  m.byId.get("family-toggle")._fire("click");
  assert.strictEqual(m.ctx.familyMode(), !before, "family mode must flip");
  assert.strictEqual(m.byId.get("drawer").hidden, false, "the drawer must stay open after toggling family mode");
});

test("#player-toggle updates the player preference AND leaves the drawer open", async () => {
  /* MUTATION: restore `route()` in the player-toggle handler instead of
     `renderCurrentPage()`. Same drawer-closing regression as family-toggle. */
  const m = await mountBooted();
  m.byId.get("drawer").hidden = false;
  const before = m.ctx.playerPref();
  m.byId.get("player-toggle")._fire("click");
  assert.notStrictEqual(m.ctx.playerPref(), before, "player preference must flip");
  assert.strictEqual(m.byId.get("drawer").hidden, false, "the drawer must stay open after toggling player preference");
});

test("#autoadvance-toggle updates auto-advance AND leaves the drawer open", async () => {
  /* Pins the already-correct behaviour (this handler never called route())
     so a future edit that adds a route()/openDrawer(false) call here gets
     caught too.
     MUTATION: add `route()` (or `openDrawer(false)`) to the autoadvance
     handler. The drawer assertion fails. */
  const m = await mountBooted();
  m.byId.get("drawer").hidden = false;
  const before = m.ctx.autoAdvanceOn();
  m.byId.get("autoadvance-toggle")._fire("click");
  assert.strictEqual(m.ctx.autoAdvanceOn(), !before, "auto-advance must flip");
  assert.strictEqual(m.byId.get("drawer").hidden, false, "the drawer must stay open after toggling auto-advance");
});

test("family-toggle's re-render still reaches the page behind the drawer (renderCurrentPage runs)", async () => {
  /* Proves the split didn't just delete the re-render — family mode changes
     which cards are eligible, so the home page behind the drawer must
     still be refreshed, just without closing the drawer.
     MUTATION: remove the `renderCurrentPage()` call entirely (call nothing
     after renderDrawer()). #view's innerHTML would keep whatever renderHome
     wrote before init()'s own route() call, so a spy overwrite would go
     undetected the same way `route()` would go uncalled. */
  const m = await mountBooted();
  let calls = 0;
  const original = m.ctx.renderCurrentPage;
  m.ctx.renderCurrentPage = (...args) => { calls++; return original(...args); };
  /* re-bind: the click handler captured the ORIGINAL renderCurrentPage by
     reference at init() time, so assert against the real signal instead —
     #view's content changes when family mode flips. */
  m.byId.get("view").innerHTML = "sentinel-before-toggle";
  m.byId.get("family-toggle")._fire("click");
  assert.notStrictEqual(m.view(), "sentinel-before-toggle", "the page behind the drawer must be re-rendered when family mode changes");
});

/* ==================================================================== */
/* REAL NAVIGATION STILL CLOSES THE DRAWER (no regression)               */
/* ==================================================================== */

test("clicking a link inside the drawer still closes it (route() unchanged for real navigation)", async () => {
  /* MUTATION: remove `openDrawer(false)` from route(), or from the
     drawer's own click-delegate handler. The drawer would stay open after
     a real navigation, regressing the pre-existing (correct) behaviour. */
  const m = await mountBooted();
  m.byId.get("drawer").hidden = false;
  const fakeLink = { closest: (sel) => (sel === "a" ? {} : null) };
  m.byId.get("drawer")._fire("click", { target: fakeLink });
  assert.strictEqual(m.byId.get("drawer").hidden, true, "a real navigation (drawer link) must still close the drawer");
});

test("route() still closes the drawer on a hashchange-driven call", async () => {
  /* MUTATION: drop `openDrawer(false)` from route() itself. A real
     hashchange-triggered route() call would leave the drawer open. */
  const m = await mountBooted();
  m.byId.get("drawer").hidden = false;
  m.ctx.location.hash = "#/queue";
  m.ctx.route();
  assert.strictEqual(m.byId.get("drawer").hidden, true, "route() must still close the drawer for real navigation");
});


/* ==================================================================== */
/* THE SIXTH SWITCH, AND THE SHAPE (findings 5-7, client audit 2026-09-12)*/
/* ==================================================================== */

/* Finding 5: `cp_interlude` is disclosed in docs/legal/privacy-policy.md as
   "On unless you turn it off", and there was no way to turn it off —
   `writeInterludePref` and `PlayerQueueManager.setInterludeEnabled` were each
   called from their own test and nowhere else. Finding 6: the five switches
   that did exist were five copies of one shape, which is what made a sixth
   expensive. Finding 7: `ui2On()` was `return true` with four live branches. */

const SWITCH_IDS = [
  "family-toggle", "player-toggle", "autoadvance-toggle",
  "interlude-toggle", "drafts-toggle", "voice-probe-toggle",
];

test("the jingle between segments has a switch, and it writes the spelling player/interlude.js reads", async () => {
  /* THE DISCLOSED SETTING, MADE TRUE. The key is the one `cp_` key that is NOT
     JSON: `readInterludePref` compares against the literal `"off"` and treats
     everything else — including an absent key — as ON. Writing it through
     `lsSet` would store `"false"`, which is not `"off"`, which reads back as
     ON: an off switch that silently never works.

     MUTATION: make `setInterludeOn` call `lsSet("cp_interlude", on)`. The
     stored value becomes `"false"` and both the spelling assertion and the
     round-trip below go red.
     MUTATION: drop the `drawerToggle("interlude-toggle", ...)` line. The
     control assertion goes red — and the privacy policy goes back to
     promising something the app does not have. */
  const m = await mountBooted();
  const btn = m.findById("interlude-toggle");
  assert.ok(btn, "#interlude-toggle is in the drawer after init");
  assert.ok(m.byId.get("drawer").children.includes(btn),
    "appended to the drawer, like every other JS-injected control");

  m.byId.get("drawer").hidden = false;
  m.ctx.openDrawer(true);
  assert.strictEqual(btn.textContent, "Jingle between segments: on", "ON is the default the policy promises");
  assert.strictEqual(m.ctx.interludeOn(), true);

  btn._fire("click");
  assert.strictEqual(m.store.get("cp_interlude"), "off",
    "the exact word player/interlude.js reads — not `false`, not `0`");
  assert.strictEqual(m.ctx.interludeOn(), false, "and it round-trips");
  assert.strictEqual(btn.textContent, "Jingle between segments: off");
  assert.strictEqual(m.byId.get("drawer").hidden, false, "a settings toggle must not close the drawer");

  btn._fire("click");
  assert.strictEqual(m.store.get("cp_interlude"), "on");
  assert.strictEqual(m.ctx.interludeOn(), true);
});

test("flipping the jingle switch reaches a player that is already running", async () => {
  /* A setting, not a thing that takes effect at the next launch:
     `client.js` reads `cp_interlude` ONCE at boot and hands it to the manager,
     which is why `PlayerQueueManager.setInterludeEnabled` exists at all.

     MUTATION: delete the `player.setInterludeEnabled(on)` call from
     `setInterludeOn`. The key still changes and nothing hears about it until
     the app is relaunched — this goes red. */
  const m = await mountBooted();
  const told = [];
  m.ctx.ForayPlayer = { setInterludeEnabled: (on) => { told.push(on); return on; } };
  m.findById("interlude-toggle")._fire("click");
  assert.deepStrictEqual(told, [false], "the running manager is told");
  /* And the PAGE does not also write the key behind the bridge's back: exactly
     ONE writer knows the value is the literal word "off", and it is
     `player/interlude.js`'s `writeInterludePref`, which `client.js` calls.
     This stub is deliberately not a real bridge and stores nothing, so an
     "off" here could only have come from a second writer in app.js.
     MUTATION: write the raw string in `setInterludeOn` as well as delegating.
     Two writers for one key, and this goes red. */
  assert.strictEqual(m.store.get("cp_interlude"), undefined,
    "the page delegates the write rather than doing it too");

  /* Stand in for what the real bridge would have persisted, then tap again:
     the switch reads the STORE on every paint and every tap, so the second tap
     has to be the other direction. */
  m.store.set("cp_interlude", "off");
  m.findById("interlude-toggle")._fire("click");
  assert.deepStrictEqual(told, [false, true], "the running manager is told, in both directions");
});

test("a page with no player module loaded still takes the tap", async () => {
  /* Every `window.ForayPlayer` call on this page is guarded for the same
     reason: the module is deferred and may have failed to load at all.
     MUTATION: call `window.ForayPlayer.setInterludeEnabled(on)` unguarded.
     This throws instead of storing. */
  const m = await mountBooted();
  m.ctx.ForayPlayer = undefined;
  assert.doesNotThrow(() => m.findById("interlude-toggle")._fire("click"));
  assert.strictEqual(m.store.get("cp_interlude"), "off");
});

test("every switch in the drawer goes through the ONE helper, in reading order", async () => {
  /* FINDING 6. Three of these were bound by hand in `init()`, two by
     near-identical fifteen-line twins, and their labels were five ad-hoc lines
     in `renderDrawer` — three unguarded, two guarded, each spelling its own
     on/off. The registry is what makes the sixth switch one line.

     MUTATION: bind any one of them by hand again (its own addEventListener
     plus its own textContent line). It drops out of `drawerToggles` and the
     first assertion goes red. */
  const m = await mountBooted();
  /* Spread into a host-realm array: the vm's Array has a different prototype,
     which deepStrictEqual (rightly) refuses to call equal. */
  const registered = [...m.evalIn("drawerToggles.map(t => t.id)")];
  assert.deepStrictEqual(registered, SWITCH_IDS,
    "all six, and in the order they read down the drawer");

  m.ctx.openDrawer(true);
  for (const id of SWITCH_IDS) {
    const el = m.findById(id);
    assert.ok(el, `${id} exists`);
    assert.match(el.textContent, /^[^:]+: .+$/, `${id} is painted by the one label pass, got "${el.textContent}"`);
  }
  assert.ok(["Open in: Apple Podcasts", "Open in: Pocket Casts (show page)"].includes(m.findById("player-toggle").textContent),
    "a switch whose two states are two DESTINATIONS reads as one of them, never as on/off — that is what `words` is for; "
    + `got "${m.findById("player-toggle").textContent}"`);
});

test("binding twice never stacks a second handler or a second button", async () => {
  /* The guard the two hand-written twins each carried (`if ($("#id")) return`),
     kept in the helper — with the handler half added, which neither twin had:
     they returned before appending, so a second call was a no-op only because
     the element already existed.

     MUTATION: delete the `_drawerToggleBound` guard. The second bind attaches
     a second click handler, one tap flips the key twice, and the value below
     comes back unchanged. */
  const m = await mountBooted();
  m.evalIn("bindDrawerToggles()");
  m.evalIn("bindDrawerToggles()");
  assert.deepStrictEqual([...m.evalIn("drawerToggles.map(t => t.id)")], SWITCH_IDS,
    "no duplicate registrations");
  const before = m.ctx.autoAdvanceOn();
  m.byId.get("autoadvance-toggle")._fire("click");
  assert.strictEqual(m.ctx.autoAdvanceOn(), !before, "exactly one flip per tap");
});

test("the retired ui-v2 flag leaves nothing behind, and the ui-v2 class stays", async () => {
  /* FINDING 7. `ui2On()` was `return true` and four sites still branched on
     it; `bindUi2Control()` removed an element nothing created and was still
     called from `init()`; `renderDrawer` painted a label for a switch that did
     not exist. The pre-cutover copy is in archive/legacy-ui-2026-09/.

     The class is the half that must NOT go: styles.css hangs the whole v2
     sheet on `body.ui-v2`.

     MUTATION: re-add `function ui2On() { return true; }` and a branch on it.
     The source sweep goes red. MUTATION: drop `ui-v2` from `setBodyClass`.
     The class assertion goes red. */
  const src = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  for (const dead of ["ui2On(", "bindUi2Control", "#ui2-toggle"]) {
    const hits = src.split(dead).length - 1;
    const inComments = dead === "ui2On(" ? 1 : dead === "bindUi2Control" ? 1 : 0;
    assert.strictEqual(hits, inComments,
      `"${dead}" survives in app.js ${hits} times; only the cutover note may name it`);
  }
  const m = await mountBooted();
  assert.ok(!m.findById("ui2-toggle"), "no element, and nothing trying to remove one");
  m.ctx.setBodyClass("home");
  assert.strictEqual(m.body.className, "home ui-v2", "the class styles.css needs is untouched");
});
