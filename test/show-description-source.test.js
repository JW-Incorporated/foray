/* The show page shows the PUBLISHER'S description, not ours — and the row an
 * episode plays from carries the credits a car displays.
 *
 * FOUNDER, 2026-09-21: "the show description looks like it's something we
 * generated. Is there a field from the show's host that we can pull instead?"
 *
 * It was ours — `editorial_note`, 220 hand-written lines in `data/catalog.json`,
 * one per curated show. There is a host field, and it needed no new plumbing:
 * `backend/src/feeds/parser.ts` already parses the feed's channel-level
 * description, `api/shows/:id/episodes` already returns it in its `show` header
 * (verified against production on 2026-09-21 — `lex-fridman-podcast` comes back
 * with his real channel blurb), and `fetchShowEpisodes` was throwing it away.
 *
 * Most of what is worth pinning here is that it cannot silently go back to
 * being ours, and that arbitrary feed text cannot become markup.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
/* CRLF normalised on read — this repo's working copy churns line endings and
   the multi-line regexes below would silently stop matching rather than fail. */
const SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8").replace(/\r\n/g, "\n");
const CSS = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");

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
  const slot = makeEl();
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
      /* The one selector this suite cares about resolves to a slot we keep a
         handle on; everything else gets a fresh throwaway node. */
      querySelector: (sel) => (sel === "#view [data-show-description]" ? slot : makeEl()),
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
  ctx._slot = slot;
  return ctx;
}

const app = loadApp();

/* ---------- the header survives the fetch ------------------------------- */

test("fetchShowEpisodes keeps the show header instead of dropping it", () => {
  /* THE WHOLE BUG. The endpoint has always returned it; this function returned
     only the episode list, so the publisher's description never reached a page.
     MUTATION: delete the `show: body.show || null` line. This goes red. */
  const fn = /async function fetchShowEpisodesUncached\([\s\S]*?\n\}/.exec(SRC)[0];
  assert.match(fn, /show:\s*body\.show\s*\|\|\s*null/);
});

test("the page renders one slot for it, with a single writer", () => {
  /* The same one-writer rule the episode-count label follows. */
  assert.match(SRC, /<div data-show-description hidden><\/div>/);
  const writers = SRC.match(/\[data-show-description\]/g) || [];
  assert.strictEqual(writers.length, 1, "exactly one querySelector for the slot");
});

test("the description is painted from the cache too, not only from the network", () => {
  /* Otherwise a revisit paints episodes instantly and the description a second
     later — a worse flicker than not caching at all.
     MUTATION: drop `paintShowDescription(cached.show)`. */
  assert.match(SRC, /paintShowDescription\(cached\.show\)/);
  assert.match(SRC, /stale: !!stale, show: header \}\)/, "and the header is what gets cached");
});

test("a refresh that agrees about the episodes still fills in the description", () => {
  /* The description is not part of the list, so it must be painted BEFORE the
     unchanged-list early return, or a cached page that never had a description
     never gets one.
     MUTATION: move `paintShowDescription(header)` below that return. */
  const paintIdx = SRC.indexOf("paintShowDescription(header);");
  /* The branch opens a block since 2026-09-22 (it repaints the count label
     before returning, audit qa 85); the order this test is about is unchanged. */
  const returnIdx = SRC.indexOf("if (cached && sameEpisodeList(cached.episodes, episodes)) {");
  assert.ok(paintIdx > 0 && returnIdx > paintIdx, "painted before the early return");
});

/* ---------- the painter ------------------------------------------------- */

test("a real description is shown", () => {
  app.paintShowDescription({ title: "Lex Fridman Podcast", description: "Conversations that explore technology." });
  assert.match(app._slot.innerHTML, /<p class="show-description">Conversations that explore technology\.<\/p>/);
  assert.strictEqual(app._slot.hidden, false);
});

test("an absent, empty or whitespace-only description hides the slot entirely", () => {
  /* An empty box is worse than no box, and a breadth show whose feed carries no
     channel description is a real case rather than a hypothetical. */
  for (const header of [null, undefined, {}, { description: null }, { description: "" }, { description: "   " }]) {
    app.paintShowDescription(header);
    assert.strictEqual(app._slot.hidden, true, `hidden for ${JSON.stringify(header)}`);
    assert.strictEqual(app._slot.innerHTML, "");
  }
});

test("a non-string description is refused rather than stringified", () => {
  /* `String({})` is "[object Object]", which would render. */
  app.paintShowDescription({ description: { evil: true } });
  assert.strictEqual(app._slot.hidden, true);
});

test("feed text is escaped — it is third-party HTML from an arbitrary publisher", () => {
  /* MUTATION: drop the `esc()`. This goes red.
     The episode-page linkifier could be pointed at this later, but that is a
     deliberate step with its own tests, not something to inherit by accident. */
  app.paintShowDescription({ description: '<img src=x onerror="alert(1)"> and <b>bold</b>' });
  assert.ok(!app._slot.innerHTML.includes("<img"), "no tag from a feed may reach the page");
  assert.ok(!/<[^>]*\sonerror/i.test(app._slot.innerHTML), "and no event-handler attribute");
  assert.match(app._slot.innerHTML, /&lt;img/);
});

/* ---------- our own line is still there, and still visibly ours --------- */

test("NOTHING renders the editorial note to a listener", () => {
  /* FOUNDER, 2026-09-21: "Delete the 'why it's in 4a' field from anything the
     user can read." It briefly sat under the publisher's description, labelled
     as ours. The label was not the problem — a second blurb about the same show
     is noise whoever wrote it.

     The FIELD stays in data/catalog.json and is still load-bearing: it is what
     `showsWeVouchFor` filters on to choose the "Shows we vouch for" rail. So
     this asserts the field is never RENDERED, not that it is unused — those are
     different claims and only one of them is wanted.
     MUTATION: put the paragraph back on the show page. This goes red. */
  const rendered = SRC.match(/esc\(show\.editorial_note\)/g) || [];
  assert.deepStrictEqual(rendered, [], "no template may interpolate the note as text");
  assert.ok(!/Why it's in 4a/.test(SRC), "and the label is gone with it");
  assert.ok(!/ep-why/.test(SRC), "…along with the class that styled it");
});

test("the note is still used as a CURATION filter, which is not the same thing", () => {
  /* If this ever fails, "Shows we vouch for" has quietly lost its input.
     MUTATION: delete the `.filter(s => s.editorial_note ...)` in showsWeVouchFor. */
  assert.match(SRC, /\.filter\(s => s\.editorial_note && s\.editorial_note\.trim\(\)\)/);
});

test("the publisher's description is styled as body copy", () => {
  assert.match(CSS, /\.show-description\s*\{[^}]*color:\s*var\(--text\)/);
});

test("a feed blurb cannot widen the page", () => {
  /* Same rule the episode description carries, for the same reason: feed text
     routinely holds an unbroken URL. */
  assert.match(CSS, /\.show-description\s*\{[^}]*overflow-wrap:\s*anywhere/);
});

/* ---------- the row an episode plays from carries the car's credits ------ */

test("an episode from a show page carries the show's artwork", () => {
  /* FOUNDER, 2026-09-21: the car shows no art beside the credits.
     `api/shows/:id/episodes` returns no per-episode image and most podcasts set
     none, so the show's square is the right art — it is what Apple Podcasts
     shows. Without it every breadth episode reached `mediaMetadata` with
     `artwork_url: null` and the car fell back to the 4a icon. Curated pool
     episodes carry their own, which is why this only bites on the breadth path
     — the one the founder listens on.
     MUTATION: delete the `artwork_url` line from fullCatalogueRowToEpRowItem. */
  const fn = /function fullCatalogueRowToEpRowItem\([\s\S]*?\n\}/.exec(SRC)[0];
  assert.match(fn, /artwork_url:\s*show\.artwork_url\s*\|\|\s*null/);
});

test("the credit fields a car reads are all carried by that row", () => {
  /* `mediaMetadata` builds title from `item.title` and artist from `item.show`.
     A row missing either renders as "4a" with a blank credit — the shape of the
     founder's report — so all three are pinned together rather than left to be
     discovered one at a time on a head unit. */
  const fn = /function fullCatalogueRowToEpRowItem\([\s\S]*?\n\}/.exec(SRC)[0];
  assert.match(fn, /show:\s*show\.title/, "artist comes from item.show");
  assert.match(fn, /title:\s*ep\.title/, "title comes from item.title");
});
