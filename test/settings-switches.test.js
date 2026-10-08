/* Settings' switches (Redesign 2026, ambient) — was the drawer-settings-toggle suite.
 *
 * THE RULING THAT FELL: "the drawer" (DIRECTION.md "Information architecture"). Joey's 2026-08-31 rule — a settings
 * toggle must not close the drawer (kanban card t_0c09d83a) — and the drawer's own leave rule are gone with the
 * drawer; the controls are now the Settings page (#/settings), reached from the gear. What the old rule PROTECTED
 * survives in a new form, and is pinned below: a switch flips IN PLACE. The page under the listener's thumb is not
 * rebuilt (a rebuild would drop the focused switch, the way closing the drawer dropped the listener's place), the
 * switch repaints itself, and what the setting governs takes effect where it is read (the next Today for family
 * mode, the running player for continuous playback and the jingle).
 *
 * Harness: the same node:vm DOM stub as test/up-next-queue.test.js, with working addEventListener/click on the
 * elements specifically (the shared stub's are no-ops) so init()'s real click wiring runs.
 *
 * `querySelector("#id")` resolves APPENDED elements too, not only the page ids seeded below. That matters as of the
 * 2026-09-12 client audit: index.html is outside the auto-merge allowlist, so every control added since is injected
 * in JS — a lookup that consulted only the seeded map would report the newer switches as absent and read as coverage
 * while testing nothing. No switch is seeded any more: every one of them is built by app.js's `settingSwitch`.
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
  "view", "menu-btn", "refresh-btn", "banner-slot", "pl-form",
  "pl-input", "pl-note", "tab-topics", "tab-shows", "sh-form", "sh-input",
  "sh-note", "sh-results", "browse-all-link",
];

/** Every element under `root`, depth first (the Settings host is sections of lists, built by app.js). */
const treeOf = (root) => [root, ...(root.children || []).flatMap(treeOf)];

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
  runAppSource(APP_SRC, ctx);

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
/* A SWITCH FLIPS IN PLACE                                               */
/* ==================================================================== */

test("#family-toggle updates family mode, repaints itself, and does not rebuild the page under it", async () => {
  /* MUTATION: have the family-toggle handler call `renderCurrentPage()` (or `route()`) after the write. The page is
     rebuilt under the listener's thumb and the sentinel below is overwritten — the focused switch would be gone. */
  const m = await mountBooted();
  const sw = m.findById("family-toggle");
  m.evalIn("paintSettings()");
  const before = m.ctx.familyMode();
  m.byId.get("view").innerHTML = "sentinel-before-toggle";
  sw._fire("click");
  assert.strictEqual(m.ctx.familyMode(), !before, "family mode must flip");
  assert.strictEqual(sw.textContent, `Family mode: ${before ? "off" : "on"}`, "the switch repainted itself");
  assert.strictEqual(m.view(), "sentinel-before-toggle", "and the page under it was not rebuilt");
});

test("family mode takes effect where it is read: a flip rebuilds the cards the next Today deals", async () => {
  /* The old test pinned that the page BEHIND the drawer was re-rendered. The page behind is Settings now, and
     nothing on it depends on family mode; what does is the card deal. MUTATION: drop `buildCards()` from the
     family-toggle's write -> the deal is stale until something else rebuilds it, and the count below stays 0. */
  const m = await mountBooted();
  let builds = 0;
  m.evalIn("var __realBuildCards = buildCards;");
  m.ctx.buildCards = (...a) => { builds++; return m.ctx.__realBuildCards(...a); };
  m.findById("family-toggle")._fire("click");
  assert.strictEqual(builds, 1, "one rebuild for one flip");
});

test("\"Open in\" is gone, with the dead code it governed", async () => {
  /* It used to be `#player-toggle`, "Open in: Apple Podcasts / Pocket Casts
     (show page)": one of three settings a listener could see, and it changed
     nothing. Its only consumer was `playLink`, which nothing had called since
     the link-out to another podcast app was deleted — so it persisted a value
     nothing read (2026-09-22 design/QA audit; founder ruling R7: delete the
     toggle and its dead code together).

     MUTATION THAT KILLS THIS: restore the `settingSwitch("player-toggle", ...)`
     line, or any of the three builders. */
  const m = await mountBooted();
  assert.ok(![...m.evalIn("settingSwitches.map(t => t.id)")].includes("player-toggle"), "the switch is registered again");
  const index = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.ok(!/id="player-toggle"/.test(index), "index.html still carries the button");
  const code = readAppSource()
    .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:/])\/\/[^\n]*/g, "$1");
  for (const dead of ["playerPref", "playLink", "appleLink", "cp_player\"", "player_pref"]) {
    assert.ok(!code.includes(dead), `${dead} is back in app.js`);
  }
});

test("#autoadvance-toggle updates auto-advance and repaints itself without touching the page", async () => {
  /* Pins the already-correct behaviour (this handler never called route()) so a future edit that adds a
     route()/renderCurrentPage() call here gets caught too.
     MUTATION: add `renderCurrentPage()` (or `route()`) to the autoadvance handler. The sentinel is overwritten. */
  const m = await mountBooted();
  const sw = m.findById("autoadvance-toggle");
  m.evalIn("paintSettings()");
  const before = m.ctx.autoAdvanceOn();
  m.byId.get("view").innerHTML = "sentinel-before-toggle";
  sw._fire("click");
  assert.strictEqual(m.ctx.autoAdvanceOn(), !before, "auto-advance must flip");
  assert.strictEqual(sw.textContent, `Continuous playback: ${before ? "off" : "on"}`);
  assert.strictEqual(m.view(), "sentinel-before-toggle", "the page is untouched");
});

test("the controls live in ONE host that route() parks before the page is replaced", async () => {
  /* The host (`#settings-host`) is moved into the Settings page and back to <body> by renderCurrentPage's FIRST
     line (`parkSettingsHost`). MUTATION: drop that line -> replacing #view's contents takes the host with it (in
     a browser, it is detached and every `$("#id")` lookup the builders make fails until the next visit); here the
     host is no longer a child of body after navigating away. */
  const m = await mountBooted();
  const host = m.findById("settings-host");
  assert.ok(host, "the host exists after init()");
  assert.ok(m.body.children.includes(host), "and is parked in <body>");
  assert.strictEqual(host.hidden, true, "hidden, until the Settings page mounts it");
  /* As renderSettings() does through its slot: the host leaves <body> for #view and is shown. (This stub keeps no
     parent links, so the move is written out.) */
  m.body.children = m.body.children.filter((c) => c !== host);
  m.byId.get("view").appendChild(host);
  host.parentElement = m.byId.get("view");
  host.hidden = false;
  assert.ok(!m.body.children.includes(host), "premise: it is mounted in the page, not parked");
  m.ctx.location.hash = "#/queue";
  m.ctx.route();
  assert.ok(m.body.children.includes(host), "navigating away parks it in <body> again");
  assert.strictEqual(host.hidden, true);
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
  "family-toggle", "autoadvance-toggle",
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
     MUTATION: drop the `settingSwitch("interlude-toggle", ...)` line. The
     control assertion goes red — and the privacy policy goes back to
     promising something the app does not have. */
  const m = await mountBooted();
  const btn = m.findById("interlude-toggle");
  assert.ok(btn, "#interlude-toggle is in Settings after init");
  assert.ok(treeOf(m.findById("settings-host")).includes(btn),
    "appended to the Settings host, like every other JS-injected control");

  m.evalIn("paintSettings()");
  assert.strictEqual(btn.textContent, "Jingle between clips: on", "ON is the default the policy promises");
  assert.strictEqual(m.ctx.interludeOn(), true);

  btn._fire("click");
  assert.strictEqual(m.store.get("cp_interlude"), "off",
    "the exact word player/interlude.js reads — not `false`, not `0`");
  assert.strictEqual(m.ctx.interludeOn(), false, "and it round-trips");
  assert.strictEqual(btn.textContent, "Jingle between clips: off");
  assert.strictEqual(m.ctx.interludeOn(), false, "and a tap leaves it flipped, in place");

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

test("every switch in Settings goes through the ONE helper, in reading order", async () => {
  /* FINDING 6. Three of these were bound by hand in `init()`, two by
     near-identical fifteen-line twins, and their labels were five ad-hoc lines
     in `renderDrawer` — three unguarded, two guarded, each spelling its own
     on/off. The registry is what makes the sixth switch one line.

     MUTATION: bind any one of them by hand again (its own addEventListener
     plus its own textContent line). It drops out of `settingSwitches` and the
     first assertion goes red. */
  const m = await mountBooted();
  /* Spread into a host-realm array: the vm's Array has a different prototype,
     which deepStrictEqual (rightly) refuses to call equal. */
  const registered = [...m.evalIn("settingSwitches.map(t => t.id)")];
  assert.deepStrictEqual(registered, SWITCH_IDS,
    "all five, and in the order they read down Settings");

  m.evalIn("paintSettings()");
  for (const id of SWITCH_IDS) {
    const el = m.findById(id);
    assert.ok(el, `${id} exists`);
    assert.match(el.textContent, /^[^:]+: .+$/, `${id} is painted by the one label pass, got "${el.textContent}"`);
  }
});

test("binding twice never stacks a second handler or a second button", async () => {
  /* The guard the two hand-written twins each carried (`if ($("#id")) return`),
     kept in the helper — with the handler half added, which neither twin had:
     they returned before appending, so a second call was a no-op only because
     the element already existed.

     MUTATION: delete the `_switchBound` guard. The second bind attaches
     a second click handler, one tap flips the key twice, and the value below
     comes back unchanged. */
  const m = await mountBooted();
  /* init() bound them once; this is the second bind. (A third would make the unguarded count odd and a double flip look
     like a single one, which is how this test first survived its own mutation.) */
  m.evalIn("bindSettingSwitches()");
  assert.deepStrictEqual([...m.evalIn("settingSwitches.map(t => t.id)")], SWITCH_IDS,
    "no duplicate registrations");
  assert.strictEqual(treeOf(m.findById("settings-host")).filter((e) => e.id === "autoadvance-toggle").length, 1, "and no second button");
  const before = m.ctx.autoAdvanceOn();
  m.findById("autoadvance-toggle")._fire("click");
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
  const src = readAppSource();
  for (const dead of ["ui2On(", "bindUi2Control", "#ui2-toggle"]) {
    const hits = src.split(dead).length - 1;
    const inComments = dead === "ui2On(" ? 1 : dead === "bindUi2Control" ? 1 : 0;
    assert.strictEqual(hits, inComments,
      `"${dead}" survives in app.js ${hits} times; only the cutover note may name it`);
  }
  const m = await mountBooted();
  assert.ok(!m.findById("ui2-toggle"), "no element, and nothing trying to remove one");
  /* A fresh profile boots with the first-run explainer OPEN, and since
     2026-09-22 the modal lock is derived from the sheets actually open (the
     sheet owner), so `fy-sheet-open` would rightly be on the body here. Close
     them first: this test is about ui-v2 and nothing else. */
  m.ctx.closeAllSheets();
  m.ctx.setBodyClass("home");
  assert.strictEqual(m.body.className, "home ui-v2", "the class styles.css needs is untouched");
});

test("the founder's tools sit in ONE collapsed Developer group, directly above Delete my data", async () => {
  /* The persona audit read "Show draft Forays", "Voice engine probe" and
     "Playback diagnostics" as the founder's debug switches shipped in every
     listener's Settings. Founder ruling R8 (2026-09-22): they stay reachable —
     he files field reports with them — but move into one collapsed "Developer"
     group at the bottom of Settings. No hidden unlock.

     MUTATION THAT KILLS THIS: drop `{ into }` from either founder switch, or
     append `#diag-open` to the Listening list again — red, a founder tool is back
     among the listener's settings. */
  const m = await mountBooted();
  const host = m.findById("settings-host");
  const group = m.findById("settings-dev");
  assert.ok(group, "there is no Developer group");
  assert.strictEqual(group.tagName, "DETAILS", "a native disclosure: keyboard and screen-reader operable");
  assert.ok(!group.open, "it starts collapsed");
  assert.strictEqual(group.children[0].tagName, "SUMMARY");
  assert.strictEqual(group.children[0].textContent, "Developer");
  assert.deepStrictEqual(group.children.slice(1).map((c) => c.id),
    ["drafts-toggle", "voice-probe-toggle", "diag-open"]);

  /* The host's sections, in order: Listening, Downloads, the Developer disclosure, Your data. */
  const sections = host.children.map((c) => c.dataset.stSection);
  assert.deepStrictEqual(sections, ["listening", "downloads", "developer", "data"],
    "the group is above the data section, and Delete my data stays the last control");
  const leaves = (el) => (el.children.length ? el.children.flatMap(leaves) : [el]);
  const ids = leaves(host).map((c) => c.id).filter(Boolean);
  assert.strictEqual(ids[ids.length - 1], "delete-data", "Delete my data is the last control of the page");
  const listening = leaves(host.children[0]).map((c) => c.id).filter(Boolean);
  for (const id of ["drafts-toggle", "voice-probe-toggle", "diag-open"]) {
    assert.ok(!listening.includes(id), `${id} is loose among the listener's settings again`);
  }
  for (const id of ["interlude-toggle", "voice-open"]) {
    assert.ok(listening.includes(id), `${id} is a listener setting and belongs outside the group`);
  }
});
