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

test("renderEpisode renders the honest not-playable note, not a play button or link-out, when audio_url is absent", () => {
  // Mutation: change playBtn(item) to unconditionally return a button. This
  // assertion then fails because a play-btn shows up for an unplayable item.
  // Mutation 2: drop the `item.audio_url ? playBtn(item) : ...` fallback in
  // renderEpisode. The page then renders neither control at all for ep-5.
  const app = loadApp();
  app._state(`state.itemIndex["ep-5"] = {
    id: "ep-5", title: "No Audio Here", show: "Great Show", duration_min: 10,
  };`);
  app.renderEpisode("ep-5");
  const html = app._view.innerHTML;
  assert.doesNotMatch(html, /class="play-btn"/, "no play button without audio_url");
  assert.doesNotMatch(html, /class="go"/, "no external link-out control any more (removed 2026-09-03)");
  assert.doesNotMatch(html, /Listen in your podcast app/, "the old link-out copy must not appear anywhere");
  assert.match(html, /class="not-playable"/, "an honest in-app not-playable note replaces the ▶ button");
  assert.match(html, /class="star /, "star toggle still renders");
});

/* ---------- A1.8: "More from this show" ---------- */

test("renderEpisode lists other episodes from the same show via episodesForShow, using epRow", () => {
  // Mutation: drop the moreFromShow() call from renderEpisode's template.
  // This assertion fails because neither sibling title appears.
  const app = loadApp();
  app._state(`
    state.catalog = { shows: [{ show_id: "show-1", title: "Great Show" }] };
    state.discover = { items: [
      { id: "ep-3", title: "Deep Dive Title", show: "Great Show", duration_min: 42, audio_url: "https://example.com/a.mp3" },
      { id: "ep-sib-1", title: "Sibling One", show: "Great Show", duration_min: 20, audio_url: "https://example.com/b.mp3" },
      { id: "ep-sib-2", title: "Sibling Two", show: "Great Show", duration_min: 15 },
      { id: "ep-other", title: "Other Show Episode", show: "Other Show", duration_min: 5 },
    ] };
    state.session = { episodes: {} };
    state.itemIndex["ep-3"] = {
      id: "ep-3", title: "Deep Dive Title", show: "Great Show",
      duration_min: 42, hook: "A description hook", audio_url: "https://example.com/a.mp3",
    };
  `);
  app.renderEpisode("ep-3");
  const html = app._view.innerHTML;
  assert.match(html, /More from this show/, "section heading must render");
  assert.match(html, /Sibling One/, "must list another episode from the same show");
  assert.match(html, /Sibling Two/, "must list every sibling episode, not just the first");
  assert.doesNotMatch(html, /Other Show Episode/, "must not list an episode from a different show");
  assert.doesNotMatch(html, />Deep Dive Title<\/a>.*>Deep Dive Title</s, "must not list the episode itself among its own siblings");
});

test("renderEpisode omits the 'More from this show' section when there are no other episodes", () => {
  // Mutation: drop the `if (!eps.length) return ""` guard in moreFromShow.
  // This would then render an empty <section class="ep-more"> heading with
  // no rows, which this test catches.
  const app = loadApp();
  app._state(`
    state.catalog = { shows: [{ show_id: "show-1", title: "Great Show" }] };
    state.discover = { items: [
      { id: "ep-3", title: "Deep Dive Title", show: "Great Show", duration_min: 42, audio_url: "https://example.com/a.mp3" },
    ] };
    state.session = { episodes: {} };
    state.itemIndex["ep-3"] = {
      id: "ep-3", title: "Deep Dive Title", show: "Great Show",
      duration_min: 42, audio_url: "https://example.com/a.mp3",
    };
  `);
  app.renderEpisode("ep-3");
  const html = app._view.innerHTML;
  assert.doesNotMatch(html, /More from this show/, "no section when the show has no other episodes");
});

test("renderEpisode omits the 'More from this show' section when the show does not join catalog.json", () => {
  // Mutation: make moreFromShow fall back to a raw filter over state.discover
  // by name without going through showIdForShowName/showById. This test
  // still passes for that mutation only if a show truly has no siblings;
  // paired with the sibling test above it pins the real join path.
  const app = loadApp();
  app._state(`
    state.catalog = { shows: [] };
    state.discover = { items: [] };
    state.session = { episodes: {} };
    state.itemIndex["ep-3"] = {
      id: "ep-3", title: "Deep Dive Title", show: "Unlisted Show",
      duration_min: 42, audio_url: "https://example.com/a.mp3",
    };
  `);
  app.renderEpisode("ep-3");
  const html = app._view.innerHTML;
  assert.doesNotMatch(html, /More from this show/, "no section when the show has no catalog.json record");
});
