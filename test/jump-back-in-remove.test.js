/* "Jump back in": the x and the age-out, through app.js (founder, 2026-10-15:
 * "We should add a little x or something so I can remove items from Jump Back
 * In. Also, if they have been there a long time then they should just go away
 * in their own instead of piling up").
 *
 * player/jump-back-in.test.js pins the rule. This suite pins the wiring: the
 * rail asks the rule, the card carries the x, and pressing it stores the removal
 * in `cp_jbi_dismissed` so the card stays gone.
 *
 * Harness: test/jump-back-in-kinds.test.js's node:vm DOM stub, with the REAL
 * player/jump-back-in.js behind the ForayPlayer bridge.
 * Every test names the one-line mutation that turns it red (CLAUDE.md).
 */

const { test, before } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8").replace(/\r\n/g, "\n");

let rule;
before(async () => {
  rule = await import(pathToFileURL(path.join(ROOT, "player", "jump-back-in.js")).href);
});

/* Arrays made inside the vm context are another realm's; compare plain copies. */
const idsOf = (entries) => Array.from(entries, (e) => String(e.id));

const daysAgo = (d) => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();

function loadApp({ bridge = true, homeShown = false } = {}) {
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
  const store = new Map();
  const view = makeEl();
  const listeners = [];
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
      addEventListener: (type, fn) => { if (type === "click") listeners.push(fn); },
      createElement: makeEl,
      querySelector: (sel) => (sel === "#view" ? view : sel === "#view .hv2-home" ? (homeShown ? makeEl() : null) : makeEl()),
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    location: { hash: "#/", href: "https://example.test/" },
    history: { replaceState: noop, pushState: noop },
    CSS: { escape: (s) => String(s) },
    URL, Math, Date, JSON, Promise, setTimeout, clearTimeout,
    scrollY: 0, scrollTo: noop,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.ForayPlayer = {
    forayResumeList: () => [],
    lastEpisodeCard: () => null,
    episodeProgress: () => ({ state: "unplayed", percent: null, label: null }),
  };
  if (bridge) {
    ctx.ForayPlayer.visibleJumpBackIn = (entries, opts) => rule.visibleJumpBackIn(entries, opts);
    ctx.ForayPlayer.withJumpBackInDismissed = (d, e, now) => rule.withDismissed(d, e, now);
  }
  vm.createContext(ctx);
  process.on("unhandledRejection", noop);
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  ctx._listeners = listeners;
  return ctx;
}

/** Press the x the way the delegated listener sees it. */
function pressRemove(app, { kind, id }) {
  const removed = [];
  const card = { remove: () => removed.push("card") };
  const section = { remove: () => removed.push("section"), querySelector: () => null };
  const btn = {
    dataset: { jbiRemoveKind: kind, jbiRemoveId: id },
    closest: (sel) => (sel === ".hv2-jbi-card" ? card : sel === ".hv2-jbi" ? section : null),
  };
  const event = {
    target: { closest: (sel) => (sel === "[data-jbi-remove-id]" ? btn : null) },
    preventDefault() {}, stopPropagation() {},
  };
  assert.ok(app._listeners.length, "the rail must have bound its click listener");
  for (const fn of app._listeners) fn(event);
  return removed;
}

const playlists = (rows) => rows.map(([id, at]) => ({ id, title: id, parts: [], last_played_at: at }));

// MUTATION: drop the `visibleJumpBackIn` call in jumpBackInEntries -> red.
test("a playlist untouched for more than 14 days leaves the rail by itself", () => {
  const app = loadApp();
  app.lsSet("cp_playlists", playlists([["fresh", daysAgo(2)], ["stale", daysAgo(20)]]));
  assert.deepStrictEqual(idsOf(app.jumpBackInEntries()), ["fresh"]);
});

// MUTATION: render `remove` unconditionally (or never) -> red.
test("the rail's card carries the x, named for the screen reader; a card elsewhere does not", () => {
  const app = loadApp();
  const c = { kind: "playlist", id: "pl-1", title: "Fusion week", sub: "", percent: null, left: "" };
  const onRail = app.jumpBackInCardHtml(c, { inSection: true });
  assert.match(onRail, /class="hv2-jbi-x" data-jbi-remove-kind="playlist" data-jbi-remove-id="pl-1"/);
  assert.match(onRail, /aria-label="Remove Fusion week from Jump back in"/);
  assert.doesNotMatch(app.jumpBackInCardHtml(c, { inSection: false }), /hv2-jbi-x/);
});

// MUTATION: skip the lsSet in onJumpBackInRemove -> red.
test("pressing the x removes the card, and it stays gone", () => {
  const app = loadApp();
  app.lsSet("cp_playlists", playlists([["keep", daysAgo(1)], ["drop", daysAgo(2)]]));
  app.jumpBackInCardHtml({ kind: "playlist", id: "drop", title: "drop" }, { inSection: true });
  const removed = pressRemove(app, { kind: "playlist", id: "drop" });
  assert.deepStrictEqual(removed, ["card", "section"], "off Home the card leaves the DOM (and an emptied rail with it)");
  assert.ok(app.lsGet("cp_jbi_dismissed", {})["playlist:drop"], "the removal is stored");
  assert.deepStrictEqual(idsOf(app.jumpBackInEntries()), ["keep"]);
});

// MUTATION: compare `at <= gone` the wrong way round in the rule -> red here too.
test("playing a removed playlist again brings it back", () => {
  const app = loadApp();
  app.lsSet("cp_playlists", playlists([["again", daysAgo(1)]]));
  app.jumpBackInCardHtml({ kind: "playlist", id: "again", title: "again" }, { inSection: true });
  pressRemove(app, { kind: "playlist", id: "again" });
  assert.strictEqual(app.jumpBackInEntries().length, 0);
  app.lsSet("cp_playlists", playlists([["again", new Date(Date.now() + 1000).toISOString()]]));
  assert.deepStrictEqual(idsOf(app.jumpBackInEntries()), ["again"]);
});

// MUTATION: call the bridge without the typeof guard -> red (TypeError).
test("without the player module the rail shows everything, as before, and the x does nothing", () => {
  const app = loadApp({ bridge: false });
  app.lsSet("cp_playlists", playlists([["old", daysAgo(30)]]));
  assert.deepStrictEqual(idsOf(app.jumpBackInEntries()), ["old"]);
  app.jumpBackInCardHtml({ kind: "playlist", id: "old", title: "old" }, { inSection: true });
  assert.deepStrictEqual(pressRemove(app, { kind: "playlist", id: "old" }), []);
  assert.strictEqual(app.lsGet("cp_jbi_dismissed", null), null);
});
