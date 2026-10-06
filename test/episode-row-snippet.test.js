/* The description snippet under an episode row's title (founder, 2026-10-03,
 * with an Apple Podcasts screenshot: "episodes show a few lines of the
 * description to give you a hint what it's about. This is super helpful.
 * Please implement the same on 4a wherever appropriate").
 *
 * Pins app.js `episodeRowSnippet` and the `.ep-hook` line `epRow` draws from
 * it. Same dependency-free node:vm harness as test/episode-row-links.test.js.
 * Every test names the one-line mutation that turns it red.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");

const APP_PATH = path.join(__dirname, "..", "app.js");
const SRC = readAppSource();

function loadApp() {
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
  runAppSource(SRC, ctx);
  return ctx;
}

const BASE = { id: "ep-1", title: "#2560 - David Grusch", show: "A Show", duration_min: 156, audio_url: "https://example.com/a.mp3" };

test("epRow draws the publisher's description under the title, as an .ep-hook line", () => {
  // Mutation: drop `${snippet ? ... : ""}` from epRow. No .ep-hook appears.
  const app = loadApp();
  const html = app.epRow({ ...BASE, description: "David Grusch is a former United States Air Force intelligence officer." }, 0, "show-x", -1);
  assert.match(html, /<p class="ep-hook">David Grusch is a former United States Air Force intelligence officer\.<\/p>/);
  // The snippet sits between the title and the metadata line, where the eye reads it.
  const title = html.indexOf('class="ep-title-link"');
  const hook = html.indexOf('class="ep-hook"');
  const meta = html.indexOf('<div class="s">');
  assert.ok(title < hook && hook < meta, "title, then snippet, then the metadata line");
});

test("a row with no description falls back to its hook, and a row with neither draws no line", () => {
  // Mutation: make episodeRowSnippet read only `item.description`. The curated
  // hook case fails. Mutation 2: return "" unconditionally — the hook case fails;
  // return the title when empty — the empty case fails.
  const app = loadApp();
  const curated = app.epRow({ ...BASE, hook: "MIT's Jacopo Buongiorno on the next-generation reactors." }, 0, "show-x", -1);
  assert.match(curated, /<p class="ep-hook">MIT&#39;s Jacopo Buongiorno on the next-generation reactors\.<\/p>/);
  const bare = app.epRow({ ...BASE }, 0, "show-x", -1);
  assert.doesNotMatch(bare, /ep-hook/, "no text, no line — never an empty <p>");
  const blank = app.epRow({ ...BASE, hook: "   ", description: "\n\n" }, 0, "show-x", -1);
  assert.doesNotMatch(blank, /ep-hook/, "whitespace is not a description");
});

test("the description wins over the hook when both exist", () => {
  // Mutation: prefer `item.hook` over `item.description`. The hook text appears.
  const app = loadApp();
  const html = app.epRow({ ...BASE, hook: "short hook", description: "The publisher's own first sentence." }, 0, "show-x", -1);
  assert.match(html, /ep-hook">The publisher&#39;s own first sentence\./);
  assert.doesNotMatch(html, /short hook/);
});

test("the snippet is escaped text, never markup", () => {
  // Mutation: interpolate `snippet` without esc(). The raw <script> survives.
  const app = loadApp();
  const html = app.epRow({ ...BASE, description: '<script>alert(1)</script> & "quotes"' }, 0, "show-x", -1);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;quotes&quot;/);
});

test("a long description is cut at a word boundary with an ellipsis, and whitespace is collapsed", () => {
  // Mutation: remove the length cap — the 1,000-character text appears whole.
  // Mutation 2: cut at EP_ROW_SNIPPET_MAX exactly — the snippet ends mid-word.
  // Mutation 3: drop the `\s+` collapse — the newline survives.
  const app = loadApp();
  const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
  const snippet = app.episodeRowSnippet({ ...BASE, description: `00:00 Intro\n01:23 Chapter\n${words}` });
  // 220 is EP_ROW_SNIPPET_MAX in app.js (a top-level const, so not reachable
  // on the vm context); the ellipsis is the one character past it.
  assert.ok(snippet.length <= 221, `cap holds: ${snippet.length}`);
  assert.ok(snippet.endsWith("…"), "a cut snippet ends in an ellipsis");
  assert.doesNotMatch(snippet, /\n/, "newlines are collapsed to spaces");
  assert.match(snippet, /^00:00 Intro 01:23 Chapter word0 /);
  // The last token before the ellipsis is a whole word of the input.
  const last = snippet.slice(0, -1).split(" ").pop();
  assert.match(last, /^word\d+$/, `cut at a word boundary, not inside "${last}"`);
  // A short description passes through untouched.
  assert.equal(app.episodeRowSnippet({ ...BASE, description: "Two sentences. Both short." }), "Two sentences. Both short.");
});

test("a hook that merely repeats the title is not shown", () => {
  // Mutation: delete the title-equality check. The duplicate title appears as a snippet.
  const app = loadApp();
  assert.equal(app.episodeRowSnippet({ ...BASE, hook: "#2560 - david grusch " }), "");
  const html = app.epRow({ ...BASE, hook: BASE.title }, 0, "show-x", -1);
  assert.doesNotMatch(html, /ep-hook/);
});

test("the snippet appears on every epRow context (show page, search, ordered playlists), and rows that cannot play keep it too", () => {
  // Mutation: gate the snippet on `ctx.startsWith("show-")`. The playlist and search contexts fail.
  const app = loadApp();
  const item = { ...BASE, description: "What it is about." };
  for (const ctx of ["show-x", "search", "playlist-abc", "library-saved"]) {
    assert.match(app.epRow(item, 0, ctx, -1), /ep-hook">What it is about\./, `context ${ctx}`);
  }
  const noAudio = app.epRow({ ...item, audio_url: null }, 0, "show-x", -1);
  assert.match(noAudio, /ep-hook">What it is about\./);
  assert.match(noAudio, /Not available to play/);
});

test("styles.css clamps .ep-hook to two lines", () => {
  // Mutation: delete the `.ep-row .ep-hook` rule, or its line-clamp. The
  // snippet would then push a long description's row to any height.
  const css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
  const rule = /\.ep-row \.ep-hook\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, ".ep-row .ep-hook rule exists");
  assert.match(rule[1], /-webkit-line-clamp:\s*2/);
  assert.match(rule[1], /overflow:\s*hidden/);
});
