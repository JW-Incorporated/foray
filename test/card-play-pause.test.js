/* A card's play button, once it is showing "❚❚", must PAUSE.
 *
 * FOUNDER, 2026-09-22, on build 2026092224:
 *   "the play button works on the Jump back in card but it does not work from
 *    the now playing bar down at the bottom. After playing starts, then the
 *    pause button on jump back in does not work, while the pause button on now
 *    playing does work."
 *
 * The second half is this file. `syncCardButtons` in `player/client.js` repaints
 * every `[data-play]` whose id matches the current episode as "❚❚" and stamps
 * `data-playing="1"` — so the card's button BECOMES a pause button on screen.
 * `bindPlay`'s handler, meanwhile, called `ForayPlayer.play(item, …)`
 * unconditionally. Pressing the pause button rebuilt the queue and restarted the
 * episode.
 *
 * WHY THIS WAS INVISIBLE UNTIL NOW, which is the part worth recording: it is a
 * property every play button in the app has always had, and nothing had ever put
 * one next to the transport bar before. The 2026-09-21 change that gave the Jump
 * back in card a play button put the same episode under two controls a
 * centimetre apart, and the disagreement became obvious the moment a founder
 * used it.
 *
 * THE MIRROR CASE IS PINNED TOO, and it was the next report waiting to happen:
 * pause from the bar, then press the card's "▶". The button is a play button
 * again, the handler starts `play()`, and the queue is rebuilt from zero —
 * losing the listener's position in an episode they had merely paused. Both
 * directions are the same missing question ("is this already the current item"),
 * so both are here.
 *
 * HARNESS. `bindPlay` is driven for real: the scope hands it one fake button
 * that captures its own click listener, and the listener is then invoked. The
 * fake `ForayPlayer` records which method was called. That is the only way to
 * test this — the defect is entirely in WHICH method the handler picks, and a
 * source-text assertion could not tell a branch that exists from one that is
 * reached.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
/* CRLF normalised on read, like every suite here — this repo is developed on
   Windows against a Unix-normalised tree. */
const SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8").replace(/\r\n/g, "\n");

const EPISODE = {
  id: "lex-353",
  title: "Dennis Whyte: Nuclear Fusion",
  show: "Lex Fridman Podcast",
  audio_url: "https://example.com/a.mp3",
  topics: ["science"],
};

/**
 * One fake `[data-play]` button that keeps hold of its click listener.
 *
 * `playing` stamps `data-playing="1"` exactly as `syncCardButtons` does, so the
 * fixture reproduces the on-screen state the founder was pressing rather than a
 * convenient one.
 */
function makeButton(id, { playing = false } = {}) {
  const btn = {
    dataset: { play: id },
    _handler: null,
    addEventListener(type, fn) { if (type === "click") this._handler = fn; },
  };
  if (playing) btn.dataset.playing = "1";
  btn.press = async () => {
    assert.ok(btn._handler, "bindPlay never bound a click handler");
    await btn._handler({ preventDefault() {}, stopPropagation() {} });
  };
  return btn;
}

function loadApp({ current = null, playing = false } = {}) {
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
      querySelector: () => makeEl(), querySelectorAll: () => [],
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

  /* The bridge, faked at exactly the surface `bindPlay` uses — and no wider.
     `isCurrent`/`isPlaying` answer from the fixture rather than from a stub that
     always says yes: a fake that cannot be in the "not current" state could not
     fail the mirror test below. */
  const calls = [];
  ctx.ForayPlayer = {
    calls,
    isCurrent: (id) => current !== null && id === current,
    isPlaying: (id) => playing && id === current,
    async togglePlayback() { calls.push("togglePlayback"); },
    async play(item, opts) { calls.push(`play:${item.id}:${opts?.why ?? ""}`); return true; },
  };
  vm.createContext(ctx);
  process.on("unhandledRejection", noop);
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  /* `state` is `const` at app.js's top level, so it lives in the SCRIPT's
     lexical scope and never reaches the context object — reading `ctx.state`
     gets undefined. Everything that needs it goes through `_run`, the same
     escape hatch test/jump-back-in-kinds.test.js calls `_state`. Function
     declarations (`bindPlay`, `lsGet`) DO become context properties, which is
     why those are reachable directly. */
  ctx._run = (code) => vm.runInContext(code, ctx);
  ctx._run(`state.itemIndex[${JSON.stringify(EPISODE.id)}] = ${JSON.stringify(EPISODE)};`);
  /* `whyFor` reads `state.session.cards` on the PLAY path, so the two cells that
     exercise it need a session. Empty on purpose — the why-line then falls back
     to `item.hook`, which is absent, so `why` is "" and the assertions below can
     match the call shape without depending on curated copy. */
  ctx._run(`state.session = { cards: [] };`);
  ctx._calls = calls;
  ctx._bind = (btn) => ctx.bindPlay({ querySelectorAll: (sel) => (sel === "[data-play]" ? [btn] : []) });
  return ctx;
}

/* ---------- the founder's report ---------------------------------------- */

test("a card button for the PLAYING episode pauses instead of restarting", async () => {
  /* THE REPORT. The button says "❚❚" because client.js painted it that way;
     pressing it must reach the player's own toggle, not `play()`.
     MUTATION: delete the `isCurrent` branch from bindPlay. This goes red with
     `play:lex-353:…` — the episode restarts, which is what the founder saw.
     RUN: failed as named. */
  const app = loadApp({ current: EPISODE.id, playing: true });
  const btn = makeButton(EPISODE.id, { playing: true });
  app._bind(btn);
  await btn.press();
  assert.deepStrictEqual(app._calls, ["togglePlayback"], "a pause must not be a play");
});

test("a card button for the PAUSED current episode resumes it, rather than starting it over", async () => {
  /* The mirror case, and it is a data-loss bug rather than a cosmetic one:
     `play()` rebuilds the queue and begins at zero, so pressing "▶" on the card
     for an episode you had merely paused would throw away your position.
     `data-playing` is absent here — client.js removes it when paused — so a
     guard written against the ATTRIBUTE rather than against `isCurrent` would
     pass the test above and fail this one.
     MUTATION: change the guard to `btn.dataset.playing === "1"`. This goes red. */
  const app = loadApp({ current: EPISODE.id, playing: false });
  const btn = makeButton(EPISODE.id, { playing: false });
  app._bind(btn);
  await btn.press();
  assert.deepStrictEqual(app._calls, ["togglePlayback"], "resume the paused item, do not restart it");
});

test("a card button for a DIFFERENT episode still starts it — the guard must not swallow every press", async () => {
  /* The obvious way to break this fix: toggle unconditionally, and no card can
     ever start anything again. The `?.` in `isCurrent?.(id)` makes that failure
     silent on an older bridge, so this is the cell that would catch it.
     MUTATION: drop the `id === current` comparison inside the fake's isCurrent —
     no; that is the fixture. Drop `isCurrent?.(id) &&`-style narrowing in app.js
     so the branch always fires. This goes red. */
  const app = loadApp({ current: "some-other-episode", playing: true });
  const btn = makeButton(EPISODE.id);
  app._bind(btn);
  await btn.press();
  assert.strictEqual(app._calls.length, 1);
  assert.match(app._calls[0], /^play:lex-353:/, "a card for another episode plays it");
});

test("nothing current at all: the card plays, exactly as it always did", async () => {
  const app = loadApp({ current: null });
  const btn = makeButton(EPISODE.id);
  app._bind(btn);
  await btn.press();
  assert.match(app._calls[0], /^play:lex-353:/);
});

/* ---------- the toggle is not counted as a start ------------------------- */

test("a pause does not log play_started, and does not re-append to history", async () => {
  /* `bindPlay` logs `play_started` and appends to `cp_history` after the play
     succeeds. A toggle that fell through to that code would count every
     pause as a play — inflating the event stream and putting the same episode
     into `cp_history` again on each press, which is a sort key two rails read.
     MUTATION: move the `isCurrent` early return below the `logEvent` call. This
     goes red. */
  const app = loadApp({ current: EPISODE.id, playing: true });
  const before = app.lsGet("cp_history", []);
  const btn = makeButton(EPISODE.id, { playing: true });
  app._bind(btn);
  await btn.press();
  assert.deepStrictEqual(app.lsGet("cp_history", []), before, "a pause is not a listen");
});

/* ---------- the bridge contract ----------------------------------------- */

test("bindPlay asks the player whether the item is current — it does not guess from the DOM", async () => {
  /* The attribute is a RENDERING of the player's state, written by a different
     module on its own schedule. Deciding a transport action from it means the
     card can act on a stale paint. Pinned as a source claim because the
     behavioural cells above cannot distinguish "read the attribute, which
     happened to agree" from "asked the player". */
  assert.match(SRC, /window\.ForayPlayer\.isCurrent\?\.\(id\)/,
    "the guard must ask the player, not read data-playing");
  assert.match(SRC, /window\.ForayPlayer\.togglePlayback\(\)/);
});

test("the player actually exposes the two methods app.js calls", async () => {
  /* The seam. `app.js` reaches for `isCurrent` and `togglePlayback` on a bridge
     that lives in another file, through optional chaining — so a rename on the
     player's side would make the card silently go back to restarting episodes
     rather than throwing. This is the only thing that would notice.
     MUTATION: rename `isCurrent` in player/client.js. This goes red. */
  const client = fs.readFileSync(path.join(ROOT, "player/client.js"), "utf8");
  assert.match(client, /^\s{2}isCurrent\(id\)\s*\{/m, "ForayPlayer.isCurrent must exist");
  assert.match(client, /^\s{2}async togglePlayback\(\)\s*\{/m, "ForayPlayer.togglePlayback must exist");
});
