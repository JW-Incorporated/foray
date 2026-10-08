/* Redesign 2026, ambient direction ("Afterglow"), phase 4: the NOT-FOUND PAGE (#/playlist/<gone>, #/episode/<gone>).
 *
 * BUILD-PLAN.md screen 16 and BUILD-NOTES.md (EmptyState) are the specification; agNotFoundPage and agEmptyState in
 * ui/primitives.js are the build, the `.ag-not-found` block in ui/primitives.css its one CSS addition. What it pins:
 *
 *   1  both gone-page routes render the SAME page: one line "Nothing here any more." as the page's heading, one
 *      Secondary link to Today (href="#/"), and nothing else (no ‹ page head, no second button)
 *   2  the copy passes the rules (<= 18 words, no banned word, no we/us/our)
 *   3  the button is 44px (the shared .ag-btn min-height token, which is --tap = 44px) and the page cannot overflow
 *      sideways (the line wraps anywhere, the section never exceeds the viewport, the side padding is the gutter's)
 *   4  hostile input to the shared EmptyState (label, route, lines) goes through esc(); the "#" is a literal
 *
 * Every test names its one-line mutation, and each was run red. HARNESS AUDIT: the page is the real renderEpisode /
 * renderPlaylistDetail running from the same sources the browser loads, in a node:vm context; the only fake is the
 * element stub, which records innerHTML and answers nothing the real DOM would refuse. The overflow claim at 375, 393
 * and 412 is MEASURED in a browser (tools/ui-lab states "playlist-not-found" / "episode-not-found"), not asserted here:
 * a CSS-text test can only pin the rules that make it true.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, " ");
const SRC = readAppSource();

function loadApp() {
  const noop = () => {};
  const makeEl = () => ({
    addEventListener: noop, removeEventListener: noop, appendChild: noop, setAttribute: noop, removeAttribute: noop,
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    style: {}, dataset: {}, children: [], hidden: false, innerHTML: "", textContent: "", className: "",
    querySelector: () => makeEl(), querySelectorAll: () => [],
  });
  const viewEl = makeEl();
  const store = new Map();
  const ctx = {
    console, fetch: () => new Promise(() => {}),
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    document: { body: makeEl(), documentElement: makeEl(), addEventListener: noop, createElement: makeEl, querySelector: (sel) => (sel === "#view" ? viewEl : makeEl()), querySelectorAll: () => [] },
    navigator: { userAgent: "node" }, location: { hash: "#/", href: "https://example.test/" },
    history: { replaceState: noop, pushState: noop }, CSS: { escape: (s) => String(s) },
    URL, Math, Date, JSON, Promise, setTimeout, clearTimeout,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  process.on("unhandledRejection", noop);
  runAppSource(SRC, ctx);
  ctx._view = viewEl;
  ctx._state = (code) => vm.runInContext(code, ctx);
  return ctx;
}

const EXPECTED_BUTTON = /<a class="ag-btn ag-btn-secondary ag-btn-size-44" href="#\/"><span>Today<\/span><\/a>/;

test("1. a gone episode and a gone playlist render the same page: one line, one Secondary link to Today, nothing else", () => {
  /* MUTATION A: change the line in agNotFoundPage to "Episode not found." -> red (the line assertion).
     MUTATION B: change `route: "/"` to `route: "/playlists"` -> red (the href).
     MUTATION C: pass `action: null` -> red (no button). MUTATION D: re-add statusPageHtml in renderEpisode -> red (page-head). */
  const app = loadApp();
  app._state("state.session = { episodes: {} };");
  app.renderEpisode("ghost-id");
  const episode = app._view.innerHTML;
  app._state("playlistById = () => null; subjectQueueById = () => null; generatedPlaylistById = () => null;");
  app.renderPlaylistDetail("ghost-playlist");
  const playlist = app._view.innerHTML;
  assert.strictEqual(episode, playlist, "one not-found page, whichever route it came from");
  assert.match(episode, /^<div class="ag ag-not-found"><section class="ag-empty"><p data-page-heading>Nothing here any more\.<\/p>/);
  assert.match(episode, EXPECTED_BUTTON);
  assert.strictEqual((episode.match(/<a /g) || []).length + (episode.match(/<button/g) || []).length, 1, "exactly one control");
  assert.strictEqual((episode.match(/<p/g) || []).length, 1, "exactly one line");
  assert.ok(!/class="page-head"|class="back"|style=|<script/.test(episode), "no page head, no back arrow, no inline style");
});

test("2. the copy passes the rules", () => {
  /* MUTATION: change the line to "Let's deep dive: we couldn't find it, fascinating as that is, in our catalogue and
     beyond all of the places that one would think to look" -> red (banned words, we/our, > 18 words). */
  const app = loadApp();
  app.renderEpisode("ghost-id");
  const text = [...app._view.innerHTML.matchAll(/<(?:p[^>]*|span)>([^<]*)</g)].map((m) => m[1]);
  assert.deepStrictEqual(text, ["Nothing here any more.", "Today"]);
  for (const line of text) {
    assert.ok(line.split(/\s+/).length <= 18, `why-line length: ${line}`);
    assert.ok(!/fascinating|deep dive|delve|explores|topic/i.test(line), `banned word in "${line}"`);
    assert.ok(!/\b(we|us|our|we're|we've)\b/i.test(line), `first person in "${line}"`);
  }
});

test("3. the button is 44px and the page cannot overflow sideways: the rules that make it so", () => {
  /* MUTATION A: set `--tap` to 40px in ui/tokens.css, or `.ag .ag-btn { min-height: 0 }` -> red (44).
     MUTATION B: delete `overflow-wrap: anywhere` or `max-width: 100%` from the .ag-not-found rules -> red.
     MUTATION C: set `.ag.ag-not-found { width: 120vw }` -> red (nothing may size the page past the viewport).
     The measured 375/393/412 check is the browser run named in this file's header. */
  const css = strip(read("ui/primitives.css"));
  const tokens = read("ui/tokens.css");
  assert.match(tokens, /--tap:\s*44px;/);
  assert.match(css, /\.ag \.ag-btn \{[^}]*min-height:\s*var\(--tap\)/);
  const page = css.match(/\.ag\.ag-not-found \{([^}]*)\}/);
  assert.ok(page, "the .ag-not-found rule exists");
  assert.ok(!/(?:^|[;\s])(?:min-)?width:/.test(page[1]), `nothing sizes the page's width: ${page[1]}`);
  assert.match(page[1], /padding-inline:\s*var\(--gutter\)/);
  assert.match(page[1], /justify-content:\s*center/);
  const empty = css.match(/\.ag\.ag-not-found \.ag-empty \{([^}]*)\}/);
  assert.ok(empty && /max-width:\s*100%/.test(empty[1]), "the section never exceeds the page");
  const line = css.match(/\.ag\.ag-not-found \.ag-empty p \{([^}]*)\}/);
  assert.ok(line && /overflow-wrap:\s*anywhere/.test(line[1]), "a long line wraps instead of widening the page");
  assert.ok(!/style=|prefers-reduced-motion/.test(page[0]), "no motion and no inline style here");
  /* MUTATION D: delete the `[data-page-heading]:focus` rule -> red (the landing focus paints a ring on the line, seen in the shot);
     MUTATION E: delete the `a.ag-btn { text-decoration: none }` rule -> red (the Today label is underlined as a legacy link). */
  assert.match(css, /\.ag\.ag-not-found \[data-page-heading\]:focus \{\s*outline:\s*none;/);
  assert.match(css, /\.ag\.ag-not-found a\.ag-btn \{\s*text-decoration:\s*none;/);
});

test("4. the shared EmptyState escapes its label, route and lines; the '#' is a literal", () => {
  /* MUTATION A: drop esc() around action.route in agEmptyState -> red (a quote breaks out of the href).
     MUTATION B: drop esc() around action.label -> red. MUTATION C: write `href="${route}"` (no literal #) -> red. */
  const app = loadApp();
  const html = app.agEmptyState({ lines: ["<img src=x onerror=1>"], action: { label: "<b>x</b>", route: '/"><script>1</script>' } });
  assert.ok(!/<img|<b>|<script/.test(html), html);
  assert.match(html, /href="#\/&quot;&gt;&lt;script&gt;1&lt;\/script&gt;"/);
  const src = read("ui/primitives.js");
  assert.match(src, /href="#\$\{esc\(/, "the # is in the literal, the route is escaped");
});
