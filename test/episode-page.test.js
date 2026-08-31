/* `#/episode/:id` — Stage 1 of docs/episode-pages-plan.md.
 *
 * Direct fix for Joey's live-testing complaint: the mini-player's "Open
 * episode" link always left 4a for Apple Podcasts. player/episode-link.test.js
 * pins the mini-player half (it now routes to `#/episode/:id` in-app); this
 * file pins the page that route lands on: `resolveEpisode`/`renderEpisode`
 * in app.js.
 *
 * Same dependency-free harness as test/app-security.test.js (node:vm, no
 * jsdom) — see that file's header for why it works.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const APP_PATH = path.join(__dirname, "..", "app.js");
const SRC = fs.readFileSync(APP_PATH, "utf8");

/** A minimal element stub that records enough to assert on: innerHTML text,
    and query results scoped to whatever was written there. */
function loadApp() {
  const noop = () => {};
  function makeEl() {
    const node = {
      addEventListener: noop, removeEventListener: noop, appendChild: noop,
      setAttribute: noop, removeAttribute: noop,
      classList: { add: noop, remove: noop, toggle: noop },
      style: {}, dataset: {}, children: [], hidden: false,
      innerHTML: "", textContent: "", className: "",
      querySelector: () => makeEl(), querySelectorAll: () => [],
    };
    return node;
  }
  const viewEl = makeEl();

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
  process.on("unhandledRejection", noop);
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  ctx._view = viewEl;
  /* `state` is a top-level `const` in app.js (classic script), so unlike a
     function declaration it never becomes a property of the global object —
     app.state would be undefined. Functions closing over it (resolveEpisode,
     renderEpisode, hydrationPool...) still see it fine; tests that need to
     SEED it do so by running a snippet in the same vm context, where the
     lexical `state` binding is reachable. */
  ctx._state = (code) => vm.runInContext(code, ctx);
  return ctx;
}

/* ---------- route() dispatches #/episode/:id ---------- */

test("route() sends #/episode/:id to renderEpisode, per the plan's §1 pattern", () => {
  // Same style of static check test/app-security.test.js uses for the
  // sanctioned-string invariants: prove the wiring exists in source, since
  // route() itself reads `location.hash` at call time via the real DOM path.
  assert.match(
    SRC,
    /else if \(\(m = \/\^#\\\/episode\\\/\(\.\+\)\$\/\.exec\(h\)\)\) renderEpisode\(m\[1\]\);/,
    "route() must match #/episode/:id and call renderEpisode(m[1]), exactly the plan's §1 regex"
  );
});

/* ---------- resolveEpisode: state.itemIndex first, cp_saved fallback ---------- */

test("resolveEpisode finds an item already in state.itemIndex (the fresh path)", () => {
  const app = loadApp();
  app._state('state.itemIndex["ep-1"] = { id: "ep-1", title: "Fresh Item", show: "A Show" };');
  const found = app.resolveEpisode("ep-1");
  assert.strictEqual(found && found.title, "Fresh Item");
});

test("resolveEpisode falls back to a cp_saved snapshot — the archivedRow pattern (#276)", () => {
  // Mutation: delete the `|| savedMap()[id]` fallback in resolveEpisode.
  // This test drops from found to null.
  const app = loadApp();
  app.lsSet("cp_saved", { "ep-2": { id: "ep-2", title: "Aged-out Item", show: "B Show" } });
  assert.strictEqual(app._state('state.itemIndex["ep-2"]'), undefined, "must not already be in itemIndex for this test to mean anything");
  const found = app.resolveEpisode("ep-2");
  assert.strictEqual(found && found.title, "Aged-out Item");
});

test("resolveEpisode returns null for an id in neither source", () => {
  const app = loadApp();
  app._state('state.session = { episodes: {} };'); // hydrationPool needs a session to attempt a build
  assert.strictEqual(app.resolveEpisode("no-such-id"), null);
});

/* ---------- renderEpisode: not-found guard ---------- */

test("renderEpisode renders 'Episode not found' for an unknown id, not a crash", () => {
  // Mirrors renderPlaylistDetail's existing not-found guard exactly, per spec.
  // Mutation: remove the `if (!item)` guard in renderEpisode. This throws
  // instead of rendering, and the assertion below never runs.
  const app = loadApp();
  app._state('state.session = { episodes: {} };');
  assert.doesNotThrow(() => app.renderEpisode("ghost-id"));
  const html = app._view.innerHTML;
  assert.match(html, /Episode not found/);
});

/* ---------- renderEpisode: full render, both data sources ---------- */

function assertFullEpisodeRender(app, html) {
  assert.match(html, /Deep Dive Title/, "title must render");
  assert.match(html, /Great Show/, "show name must render (plain text, Stage 1)");
  assert.match(html, /42 min/, "duration must render via fmtDur");
  assert.match(html, /A description hook/, "hook/description must render");
  assert.match(html, /class="play-btn"/, "the ▶ button must render when audio_url exists");
  assert.match(html, /class="star /, "the star toggle must render");
}

test("renderEpisode renders artwork/title/show/duration/hook/play/star for an itemIndex item", () => {
  const app = loadApp();
  app._state(`state.itemIndex["ep-3"] = {
    id: "ep-3", title: "Deep Dive Title", show: "Great Show",
    duration_min: 42, hook: "A description hook", audio_url: "https://example.com/a.mp3",
    artwork_url: "https://example.com/art.png",
  };`);
  app.renderEpisode("ep-3");
  assertFullEpisodeRender(app, app._view.innerHTML);
});

test("renderEpisode renders the same for a cp_saved-only (aged-out) item", () => {
  // Proves BOTH resolution paths reach the same render, per the card's test spec.
  const app = loadApp();
  app._state('state.session = { episodes: {} };');
  app.lsSet("cp_saved", {
    "ep-4": {
      id: "ep-4", title: "Deep Dive Title", show: "Great Show",
      duration_min: 42, hook: "A description hook", audio_url: "https://example.com/a.mp3",
      artwork_url: "https://example.com/art.png",
    },
  });
  app.renderEpisode("ep-4");
  assertFullEpisodeRender(app, app._view.innerHTML);
});

test("renderEpisode renders no play button when audio_url is absent (Stage 1 scope, not Stage 2's fallback link)", () => {
  // Mutation: change playBtn(item) to unconditionally return a button. This
  // assertion then fails because a play-btn shows up for an unplayable item.
  const app = loadApp();
  app._state(`state.itemIndex["ep-5"] = {
    id: "ep-5", title: "No Audio Here", show: "Great Show", duration_min: 10,
  };`);
  app.renderEpisode("ep-5");
  const html = app._view.innerHTML;
  assert.doesNotMatch(html, /class="play-btn"/, "no play button without audio_url");
  assert.match(html, /class="star /, "star toggle still renders");
});

/* ---------- renderEpisode: Stage 2 "listen elsewhere" fallback (§2) ---------- */

test("renderEpisode shows an honest 'Listen in your podcast app' link when audio_url is absent, in place of the ▶ button", () => {
  // Mutation: drop the `playBtn(item) || <a>...` fallback in renderEpisode.
  // The episode page then offers no play affordance at all for an
  // unplayable episode, and this assertion fails.
  const app = loadApp();
  app._state(`state.itemIndex["ep-6"] = {
    id: "ep-6", title: "Unplayable Episode", show: "Great Show",
    duration_min: 10, apple_collection_id: 555, apple_track_id: 777,
  };`);
  app.renderEpisode("ep-6");
  const html = app._view.innerHTML;
  assert.doesNotMatch(html, /class="play-btn"/, "no in-app ▶ button without audio_url");
  assert.match(html, /Listen in your podcast app ↗<\/a>/, "the fallback control must use the honest label");
  assert.match(html, /class="star /, "star toggle still renders");
});

test("renderEpisode still renders the full page (artwork/title/show/duration/hook) for an unplayable episode", () => {
  // Mutation: return the not-found branch (or otherwise short-circuit) when
  // audio_url is absent. Per plan §2 the page renders fully regardless.
  const app = loadApp();
  app._state(`state.itemIndex["ep-7"] = {
    id: "ep-7", title: "Deep Dive Title", show: "Great Show",
    duration_min: 42, hook: "A description hook",
    artwork_url: "https://example.com/art.png",
    apple_collection_id: 555, apple_track_id: 777,
  };`);
  app.renderEpisode("ep-7");
  const html = app._view.innerHTML;
  assert.match(html, /Deep Dive Title/, "title must render");
  assert.match(html, /Great Show/, "show name must render");
  assert.match(html, /42 min/, "duration must render");
  assert.match(html, /A description hook/, "hook must render");
  assert.match(html, /class="ep-art"/, "artwork must render");
  assert.match(html, /Listen in your podcast app ↗<\/a>/, "fallback link must render in place of ▶");
});

test("renderEpisode renders no play affordance at all (not even a dead link) when the item has neither audio_url nor apple_collection_id", () => {
  // Mirrors archivedRow's guard: a snapshot with no apple_collection_id gets
  // no link rather than a link to ".../idundefined" (docs/episode-pages-plan.md
  // §3's archivedRow row, applied to the episode page's own fallback).
  // Mutation: drop the `item.apple_collection_id ? ... : ""` guard so the
  // fallback renders unconditionally. This then produces a dead link and the
  // assertion fails.
  const app = loadApp();
  app._state(`state.itemIndex["ep-8"] = {
    id: "ep-8", title: "No Metadata At All", show: "Great Show", duration_min: 5,
  };`);
  app.renderEpisode("ep-8");
  const html = app._view.innerHTML;
  assert.doesNotMatch(html, /class="play-btn"/, "no in-app ▶ button without audio_url");
  assert.doesNotMatch(html, /class="go"/, "no dead external link without apple_collection_id");
  assert.match(html, /class="star /, "star toggle still renders");
});
