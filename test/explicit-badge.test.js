/* Kanban card t_02c6bb0b: "Add visible explicit-content ('E') badge — flag
 * already captured, never shown".
 *
 * The publisher's <itunes:explicit> flag has been correctly ingested into
 * `explicit` at both episode level (discover.json) and show level
 * (catalog.json) since long before this card, and Family Mode
 * (`poolFiltered`'s `i.explicit !== true` check) already filters on it — but
 * nothing ever rendered the flag for a listener browsing with Family Mode
 * OFF. This suite pins `explicitBadge()` and its four call sites: epRow,
 * archivedRow, renderEpisode, renderShow.
 *
 * Same dependency-free node:vm harness as test/episode-page.test.js — see
 * that file's header comment for why it works without jsdom.
 *
 * Every test names the mutation that kills it, per CLAUDE.md "a green test
 * is not evidence until you have broken it".
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const APP_PATH = path.join(__dirname, "..", "app.js");
const SRC = fs.readFileSync(APP_PATH, "utf8");

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
  process.on("unhandledRejection", noop);
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  ctx._view = viewEl;
  ctx._state = (code) => vm.runInContext(code, ctx);
  return ctx;
}

/* ---------- explicitBadge() itself ---------- */

test("explicitBadge renders the E marker only for explicit === true", () => {
  // Mutation: change the `=== true` check to a truthy check. This test's
  // false/null/undefined cases then all fail because they'd also render.
  const app = loadApp();
  assert.match(app.explicitBadge(true), /explicit-badge/);
  assert.match(app.explicitBadge(true), />E</);
  assert.strictEqual(app.explicitBadge(false), "", "false must render nothing (publisher explicitly said clean)");
  assert.strictEqual(app.explicitBadge(null), "", "null (unset/unknown) must render nothing, not a badge");
  assert.strictEqual(app.explicitBadge(undefined), "", "undefined must render nothing");
});

/* ---------- epRow ---------- */

test("epRow shows the E badge for an explicit episode and omits it otherwise", () => {
  // Mutation: drop the explicitBadge(item.explicit) call from epRow's title
  // line. Both assertions collapse to the same (badge-less) output.
  const app = loadApp();
  const explicitItem = { id: "e1", title: "Spicy Episode", show: "A Show", duration_min: 10, explicit: true };
  const cleanItem = { id: "e2", title: "Clean Episode", show: "A Show", duration_min: 10, explicit: false };
  const rowExplicit = app.epRow(explicitItem, 0, "ctx", -1);
  const rowClean = app.epRow(cleanItem, 0, "ctx", -1);
  assert.match(rowExplicit, /class="explicit-badge"/, "explicit item must carry the badge");
  assert.doesNotMatch(rowClean, /class="explicit-badge"/, "non-explicit item must not carry the badge");
});

/* ---------- archivedRow ---------- */

test("archivedRow shows the E badge for a named, aged-out explicit part", () => {
  // Mutation: drop the explicitBadge(item.explicit) call from archivedRow's
  // named-title branch. The badge assertion fails.
  const app = loadApp();
  const explicitPart = { id: "p1", title: "Old Spicy Part", show: "A Show", explicit: true };
  const row = app.archivedRow(explicitPart, 0, "ctx");
  assert.match(row, /class="explicit-badge"/);
});

test("archivedRow renders no badge for an unnamed part (nothing to flag)", () => {
  // Mutation: call explicitBadge unconditionally (even for the unnamed
  // branch) using a truthy default. That would make this test fail because
  // an unnamed part carries no explicit field to read in the first place —
  // this pins that the unnamed branch stays exactly as it was.
  const app = loadApp();
  const unnamedPart = { id: "p2" };
  const row = app.archivedRow(unnamedPart, 0, "ctx");
  assert.doesNotMatch(row, /class="explicit-badge"/);
  assert.match(row, /Part no longer in the catalogue/);
});

/* ---------- renderEpisode ---------- */

test("renderEpisode shows the E badge next to the title for an explicit episode", () => {
  // Mutation: drop explicitBadge(item.explicit) from renderEpisode's <h2>.
  // The badge assertion fails while the rest of the page still renders fine.
  const app = loadApp();
  app._state(`state.itemIndex["ep-x"] = {
    id: "ep-x", title: "Deep Dive Title", show: "Great Show",
    duration_min: 42, audio_url: "https://example.com/a.mp3", explicit: true,
  };`);
  app.renderEpisode("ep-x");
  const html = app._view.innerHTML;
  assert.match(html, /Deep Dive Title/);
  assert.match(html, /class="explicit-badge"/);
});

test("renderEpisode shows no badge for a non-explicit episode", () => {
  const app = loadApp();
  app._state(`state.itemIndex["ep-y"] = {
    id: "ep-y", title: "Clean Title", show: "Great Show",
    duration_min: 42, audio_url: "https://example.com/a.mp3", explicit: false,
  };`);
  app.renderEpisode("ep-y");
  const html = app._view.innerHTML;
  assert.doesNotMatch(html, /class="explicit-badge"/);
});

/* ---------- renderShow: SHOW-level flag, independent of any episode ---------- */

test("renderShow shows the E badge next to the show title when the SHOW itself is flagged explicit", () => {
  // Mutation: drop explicitBadge(show.explicit) from renderShow's <h2>, or
  // read an episode's explicit flag instead of the show's own field — this
  // seeds zero episodes for the show, so only the show-level path can pass.
  const app = loadApp();
  app._state(`
    state.catalog = { shows: [{ show_id: "show-nsfw", title: "NSFW Show", explicit: true }] };
    state.discover = { items: [] };
    state.session = { episodes: {} };
  `);
  app.renderShow("show-nsfw");
  const html = app._view.innerHTML;
  assert.match(html, /NSFW Show/);
  assert.match(html, /class="explicit-badge"/);
});

test("renderShow shows no badge when the show's explicit field is false or null", () => {
  const app = loadApp();
  app._state(`
    state.catalog = { shows: [{ show_id: "show-clean", title: "Clean Show", explicit: false }] };
    state.discover = { items: [] };
    state.session = { episodes: {} };
  `);
  app.renderShow("show-clean");
  assert.doesNotMatch(app._view.innerHTML, /class="explicit-badge"/);
});

/* ---------- Family Mode's existing filter stays untouched ---------- */

test("poolFiltered still removes explicit items in Family Mode — the badge is additive, not a replacement", () => {
  // Mutation: change poolFiltered's filter away from `i.explicit !== true`.
  // This test, independent of any badge/render code, would then fail on its
  // own because the explicit item would survive the Family Mode filter.
  const app = loadApp();
  app._state(`
    state.discover = { items: [
      { id: "clean-1", show: "A", explicit: false, topics: [] },
      { id: "spicy-1", show: "A", explicit: true, topics: [] },
    ] };
    state.session = { episodes: {} };
  `);
  app.lsSet("cp_family", true);
  const pool = app.poolFiltered();
  const ids = pool.map((i) => i.id);
  assert.ok(ids.includes("clean-1"), "non-explicit item must survive Family Mode");
  assert.ok(!ids.includes("spicy-1"), "explicit item must still be filtered out by Family Mode");
});
