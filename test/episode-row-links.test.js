/* Stage 3 of docs/episode-pages-plan.md — epRow/archivedRow/bannerHtml title
 * links to `#/episode/:id`, on top of the existing ▶/star/external controls
 * which must keep their current behavior unchanged (§3 rows 2-4, §4 Stage 3).
 *
 * Same dependency-free node:vm harness as test/episode-page.test.js — see
 * that file's header for why it works without jsdom.
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

/* ---------- epRow: title links to #/episode/:id ---------- */

test("epRow's title links to #/episode/:id, on top of the unchanged ▶/star/external controls", () => {
  // Mutation: revert epRow's title cell to plain `esc(item.title)`. This
  // assertion fails because no #/episode/ href appears.
  const app = loadApp();
  const item = { id: "ep-x", title: "X Title", show: "Unlisted Show", duration_min: 10, audio_url: "https://example.com/a.mp3" };
  const html = app.epRow(item, 0, "ctx-1", -1);
  assert.match(
    html,
    /<a class="ep-title-link" href="#\/episode\/ep-x">X Title<\/a>/,
    "episode title must be an in-app link to #/episode/:id"
  );
  // PR #357 regression: exactly one play control, star and up-next unchanged.
  assert.match(html, /class="play-btn"/, "play button must be present, unchanged");
  assert.match(html, /class="star /, "star toggle must be present, unchanged");
  assert.match(html, /data-upnext=/, "up-next control must be present, unchanged");
  assert.strictEqual((html.match(/class="play-btn"/g) || []).length, 1, "exactly one play control per row (PR #357)");
  assert.doesNotMatch(html, /class="go"/, "no external link-out control when audio_url exists — unchanged from before");
});

test("epRow falls back to the external listen-elsewhere link when no audio_url, title link still present", () => {
  const app = loadApp();
  const item = { id: "ep-noaudio", title: "No Audio", show: "Some Show", duration_min: 5 };
  const html = app.epRow(item, 0, "ctx-1", -1);
  assert.match(html, /<a class="ep-title-link" href="#\/episode\/ep-noaudio">No Audio<\/a>/);
  assert.match(html, /class="go"[^>]*target="_blank"[^>]*>Listen in your podcast app ↗<\/a>/,
    "external control must be unchanged: still target=_blank to playLink");
  assert.doesNotMatch(html, /class="play-btn"/, "no play button without audio_url — unchanged");
});

/* ---------- archivedRow: title links to #/episode/:id ---------- */

test("archivedRow's title links to #/episode/:id for a named (still-catalogued-elsewhere) part", () => {
  // Mutation: revert archivedRow's title cell to `esc(item.title)`. Fails.
  const app = loadApp();
  const item = { id: "ep-y", title: "Y Title", show: "Gone Show", duration_min: 7, apple_collection_id: "123" };
  const html = app.archivedRow(item, 0, "ctx-1");
  assert.match(
    html,
    /<a class="ep-title-link" href="#\/episode\/ep-y">Y Title<\/a>/,
    "archived row's episode title must link to #/episode/:id even though the part aged out of the live pool"
  );
  assert.match(html, /class="go"[^>]*target="_blank"[^>]*>Listen in your podcast app ↗<\/a>/,
    "external control unchanged: still links out via apple_collection_id");
});

test("archivedRow's unnamed part has neither a title link nor a play/star/external control (unchanged)", () => {
  // Mutation: give an unnamed part a title link anyway. This assertion fails
  // because unnamed parts have no id/title worth linking (matches the
  // existing no-link-for-unnamed-parts behavior).
  const app = loadApp();
  const item = { id: "ep-z" };
  const html = app.archivedRow(item, 0, "ctx-1");
  assert.doesNotMatch(html, /ep-title-link/, "an unnamed part must not render a title link");
  assert.match(html, /Part no longer in the catalogue/);
});

/* ---------- bannerHtml: in-app link, not target="_blank" ---------- */

test("the continue banner is an in-app link to #/episode/:id, not target=\"_blank\"", () => {
  // Mutation: revert bannerHtml's href back to playLink(c) with
  // target="_blank". This assertion fails on both counts.
  const app = loadApp();
  app._state(`state.session = { commute: { content_minutes: 27 } };`);
  app.lsSet("cp_lastpick", {
    id: "ep-continue", title: "Continue Me", duration_min: 60, ts: new Date().toISOString(),
  });
  const html = app.bannerHtml();
  assert.match(
    html,
    /<a class="banner" href="#\/episode\/ep-continue"/,
    "banner must be an in-app link to #/episode/:id"
  );
  assert.doesNotMatch(html, /target="_blank"/, "banner must not open a new tab any more");
});
