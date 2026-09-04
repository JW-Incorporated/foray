/* The home-screen declutter (founder instruction, 2026-09-03, after the first
 * TestFlight build):
 *
 *   "the home page has so much clutter. Menu should have the following pages:
 *    Home, Shows, Playlists, Forays, Up Next. Let's start by cleaning that up."
 *
 * followed by six itemised moves. The through-line, and the reason this suite
 * exists rather than a handful of scattered assertions: 4a's pitch is "four
 * cards on one screen, and then you are done choosing", and Home had drifted
 * into the place every new surface got parked.
 *
 * THIS SUITE IS THE MATRIX. Each of the four moved surfaces is asserted in
 * BOTH directions — absent from Home, present on its destination — because a
 * test that only checked the destination stays green when the original never
 * left, which is the specific way "move" work fails. The individual surfaces
 * keep their own suites for their own behaviour:
 *
 *   test/show-search.test.js       the search's matching + breadth-fetch logic
 *   test/show-page.test.js         vouchForHtml's sampling and row markup
 *   test/category-browse.test.js   the #/shows index and its reachability
 *   test/up-next-queue.test.js     cp_queue's storage, ordering and controls
 *
 * WHAT THIS PROVES, in order:
 *  1. `.home` renders the banner slot and `.cards4` and NOTHING else — the
 *     layout invariant behind two shipped regressions, not just a preference.
 *  2-5. The playlist builder, the show search, "Shows we vouch for" and the
 *     foray list each render on exactly one destination page and not on Home.
 *  6. "Jump back in" moved to #/forays with the list it visually belongs to.
 *  7. The menu carries exactly the five named destinations, in order.
 *  8. route() dispatches #/forays, the one new address.
 *  9. "Up Next" is backed by real state (cp_queue) — the menu slot is a page
 *     over a real queue, not a slot filled to match a list.
 * 10. "Starred Shows" left the menu without leaving the app.
 * 11. A Foray's back link lands where an unlocked draft is still listed.
 *
 * Every test names the mutation that kills it, per CLAUDE.md "a green test is
 * not evidence until you have broken it". Every one was run.
 *
 * Harness: the same node:vm DOM stub as test/show-page.test.js, duplicated
 * rather than imported — see that file's header for why.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const INDEX_HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

process.on("unhandledRejection", () => {});

function makeEl(tag) {
  return {
    tagName: String(tag || "div").toUpperCase(),
    id: null, className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {}, click() {},
    remove() {},
  };
}

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn", "banner-slot",
  "pl-form", "pl-input", "pl-note", "sh-form", "sh-input", "sh-note", "sh-results",
];

function mount({ seed = {}, boot = false } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const body = makeEl("body");

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
        return s.startsWith("#") ? byId.get(s.slice(1)) ?? null : null;
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
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });

  const evalIn = (src) => vm.runInContext(src, ctx);
  return {
    ctx, evalIn, store, body, byId,
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

/* A mounted app with just enough state for renderHome() to run: no catalogue,
   no pool, four ready-made card slots. Deliberately NOT booted against the
   real data files — this suite is about what is on each page, and a synthetic
   four-slot home is both faster and independent of today's discover pool. */
function quietMount(seed) {
  const m = mount({ seed });
  m.state.catalog = { shows: [] };
  m.state.discover = { items: [] };
  m.state.taxonomy = { nodes: [] };
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  m.state.cardSlots = [0, 1, 2, 3].map((i) => ({
    branch: `branch-${i}`,
    role: i === 3 ? "stretch" : "core",
    item: { id: `ep-${i}`, title: `Episode ${i}`, show: `Show ${i}`, duration_min: 30, artwork_url: null },
    items: [{ id: `ep-${i}`, title: `Episode ${i}`, show: `Show ${i}`, duration_min: 30 }],
  }));
  return m;
}

/* Everything between `.home`'s opening tag and its close. `#view`'s innerHTML
   is exactly `<div class="home"> … </div>` on the home screen, so the last
   `</div>` is `.home`'s own. */
function homeInner(view) {
  const open = '<div class="home">';
  const at = view.indexOf(open);
  assert.ok(at !== -1, "renderHome must still render a .home container");
  return view.slice(at + open.length, view.lastIndexOf("</div>"));
}

/* ==================================================================== */
/* 1. `.home` HOLDS THE BANNER AND THE FOUR CARDS. FULL STOP.           */
/* ==================================================================== */

test("`.home` renders the banner slot and .cards4 and nothing else at all", () => {
  /* THE ONE ASSERTION THAT DOES NOT AGE. Every other test here names a
     specific thing that must not be on Home; this one says nothing new may
     be, which is what actually failed twice.

     It is a layout invariant, not only a product preference: `.home` is a
     fixed-height flex column whose only `flex: 1` child is `.cards4`, and it
     is `overflow: visible`, so ANY tall sibling starves the four cards to
     0px and overflows on top of what follows. #433 shipped exactly that (the
     vouch row: `.cards4` measured 0px and each card 26px at every viewport,
     desktop included), and #458 worked around it with a `.home-below`
     wrapper rather than removing the sibling.

     Written as "subtract the two things that belong, assert nothing remains"
     rather than a list of banned strings, so it fails for a surface nobody
     has thought of yet. The two things that belong are computed from the
     same helpers renderHome calls (bannerHtml, miniCard over the card slots)
     and subtracted as EXACT strings, whitespace between tags normalised. An
     earlier draft subtracted them with a greedy `<a class="mini-card"…</a>`
     regex, which also swallowed any anchor-bearing content appended after
     the cards — the foray list re-added to Home left a leftover of "" and
     the test stayed green. Exact subtraction has no such hole.

     The fixture is seeded so that every helper that returns "" on empty
     state is NON-empty here: editorial notes in the catalogue (vouchForHtml),
     and a ForayPlayer stub with one listed foray and one resume row
     (forayListHtml, jumpBackInHtml). Without those seeds, re-adding any of
     the three to Home renders nothing under quietMount's empty state and
     this test stays green — the forgiving-fixture failure CLAUDE.md lists
     five times over. Tests 4-6 pin each move with their own seed; this one
     has to catch them as "something, anything, inside .home" as well.

     MUTATION: add `${vouchForHtml()}` — or any other line — inside
     renderHome's `.home` template. `leftover` is no longer empty and this
     fails, naming what was added. RUN, each separately, each failed here:
     `${vouchForHtml()}`, `${forayListHtml()}`,
     `${jumpBackInHtml(forayResumeRows())}`, the `#pl-form` block, the
     `#sh-form` block. */
  const m = quietMount();
  m.state.catalog = {
    shows: [
      { show_id: "vouch-a", title: "Vouch A", editorial_note: "A real note." },
      { show_id: "vouch-b", title: "Vouch B", editorial_note: "Another real note." },
    ],
  };
  m.state.forays = { forays: [] };
  m.ctx.ForayPlayer = {
    listForays: () => [{ id: "capital-types-1", title: "What capital actually is", status: "published" }],
    forayResumeList: () => [
      { id: "capital-types-1", title: "What capital actually is", percent: 40, label: "12 min left", finished: false },
    ],
  };
  m.ctx.renderHome();
  const inner = homeInner(m.view());

  assert.ok(inner.includes('<div id="banner-slot">'), "the resume banner slot must still be there");
  assert.strictEqual(
    (inner.match(/class="mini-card"/g) || []).length, 4,
    "all four subject cards must render — they are the product"
  );

  const norm = (s) => s.replace(/>\s+</g, "><").trim();
  const banner = norm(`<div id="banner-slot">${m.ctx.bannerHtml()}</div>`);
  const cards = norm(`<div class="cards4">${m.state.cardSlots.map(m.ctx.miniCard).join("")}</div>`);
  let leftover = norm(inner);
  assert.ok(leftover.includes(banner), "the banner slot must render exactly as bannerHtml() paints it");
  assert.ok(leftover.includes(cards), "the four cards must render exactly as miniCard() paints them");
  leftover = leftover.replace(banner, "").replace(cards, "").trim();
  assert.strictEqual(
    leftover, "",
    `nothing but the banner and .cards4 may render inside .home; found: ${leftover.slice(0, 200)}`
  );
});

/* ==================================================================== */
/* 2-5. THE FOUR MOVES, EACH ASSERTED IN BOTH DIRECTIONS                */
/* ==================================================================== */

test("the playlist builder renders on #/playlists and not on Home", () => {
  /* Founder item 4: "remove the playlist builder box from Home; keep all that
     only on the Playlists page." The Playlists page already carried its own
     #pl-form, so this move is a deletion on one side only — which is exactly
     why the Home-side assertion is the one doing the work here.

     MUTATION: paste the `#pl-form` block back into renderHome's template.
     The Home assertions fail. RUN: both failed. */
  const m = quietMount();

  m.ctx.renderHome();
  const home = m.view();
  assert.ok(!home.includes('id="pl-form"'), "Home must render no playlist-builder form");
  assert.ok(!home.includes("build me a playlist"), "Home must not carry the builder's placeholder either");

  m.ctx.renderPlaylists();
  const playlists = m.view();
  assert.ok(playlists.includes('id="pl-form"'), "the Playlists page must render the builder");
  assert.ok(playlists.includes("build me a playlist"), "the builder's placeholder belongs on the Playlists page");
});

test("the show search renders on #/shows and not on Home", () => {
  /* Founder item 5: "remove the search from Home; move it into the Shows
     page."
     MUTATION: paste the `#sh-form` block back into renderHome's template.
     The Home assertion fails. RUN: failed as named. */
  const m = quietMount();

  m.ctx.renderHome();
  assert.ok(!m.view().includes('id="sh-form"'), "Home must render no show-search form");

  m.ctx.renderAllShows();
  assert.ok(m.view().includes('id="sh-form"'), "the Shows page must render the show search");
});

test("'Shows we vouch for' renders on #/shows and not on Home", () => {
  /* Founder item 1: "move the 'shows we recommend' row to the Shows page."
     (He calls it "shows we recommend"; the shipped heading says "Shows we
     vouch for" and is left as it is — he asked for a move, not a rename.)

     MUTATION: put `${vouchForHtml()}` back inside renderHome's `.home`
     template. The Home assertion fails. RUN: failed as named. */
  const m = quietMount();
  m.state.catalog = {
    shows: [
      { show_id: "vouch-a", title: "Vouch A", editorial_note: "A real note." },
      { show_id: "vouch-b", title: "Vouch B", editorial_note: "Another real note." },
    ],
  };

  m.ctx.renderHome();
  assert.ok(!m.view().includes("Shows we vouch for"), "Home must not render the editorial show row");

  m.ctx.renderAllShows();
  assert.ok(m.view().includes("Shows we vouch for"), "the Shows page must render the editorial show row");
});

test("the foray list renders on #/forays and not on Home", () => {
  /* Founder item 2: "get rid of the recommended foray at the top of Home.
     Move it into a page accessible via the menu exclusively for Forays."

     MUTATION: put `${forayListHtml()}` back inside renderHome's `.home`
     template. The Home assertion fails. RUN: failed as named. */
  const m = quietMount();
  m.state.forays = { forays: [] };
  m.ctx.ForayPlayer = {
    listForays: () => [{ id: "capital-types-1", title: "What capital actually is", status: "published" }],
    forayResumeList: () => [],
  };

  m.ctx.renderHome();
  const home = m.view();
  assert.ok(!home.includes("fy-home-row"), "Home must render no foray rows");
  assert.ok(!home.includes("What capital actually is"), "Home must not name a foray at all");

  m.ctx.renderForays();
  const forays = m.view();
  assert.ok(forays.includes("fy-home-row"), "the Forays page must render the foray rows");
  assert.ok(forays.includes("What capital actually is"), "the Forays page must name the foray");
});

test("'Jump back in' moved to #/forays with the list it looks identical to", () => {
  /* A judgement call worth pinning because it is NOT literally in the
     founder's six items, and Joey owns product: "Jump back in" renders the
     same `.fy-home-row` markup as the foray list, directly above it, so to
     the eye it IS "the foray at the top of Home" he asked to remove. Leaving
     it behind would have kept a row that looks exactly like the removed one.

     It is still gated by the same visibility rule (forayResumeRows filters to
     what forayCards would list), so an unpublished Foray's progress is
     remembered and not advertised — moving the surface did not widen it.

     MUTATION: render `${jumpBackInHtml(forayResumeRows())}` inside
     renderHome's `.home` template again. The Home assertion fails. RUN:
     failed as named. */
  const m = quietMount();
  m.state.forays = { forays: [] };
  m.ctx.ForayPlayer = {
    listForays: () => [{ id: "capital-types-1", title: "What capital actually is", status: "published" }],
    forayResumeList: () => [
      { id: "capital-types-1", title: "What capital actually is", percent: 40, label: "12 min left", finished: false },
    ],
  };

  m.ctx.renderHome();
  assert.ok(!m.view().includes("Jump back in"), "Home must render no resume row");

  m.ctx.renderForays();
  const forays = m.view();
  assert.ok(forays.includes("Jump back in"), "the Forays page must render the resume row");
  assert.ok(forays.includes("12 min left"), "the resume row must keep its observed time-left label");
});

/* ==================================================================== */
/* 6-7. THE MENU ITSELF                                                  */
/* ==================================================================== */

test("the menu lists exactly the five named destinations, in the founder's order", () => {
  /* "Menu should have the following pages: Home, Shows, Playlists, Forays,
     Up Next." Asserted as an exact, ordered list rather than five
     containment checks, because the failure this guards is ACCUMULATION —
     the same failure the home screen just had. A sixth entry is a change to
     the information architecture and should have to edit this line.

     Read out of index.html, which is where the drawer's markup actually
     lives; nothing in app.js rebuilds these five links.

     MUTATION: add a sixth `<a class="drawer-section">` to index.html, or
     reorder two. deepStrictEqual fails and prints the list. RUN: added
     "Starred Shows" back as a sixth; failed naming it. */
  const items = [...INDEX_HTML.matchAll(/<a class="drawer-section" href="([^"]+)">([^<]+)<\/a>/g)]
    .map((m) => [m[2], m[1]]);
  assert.deepStrictEqual(items, [
    ["Home", "#/"],
    ["Shows", "#/shows"],
    ["Playlists", "#/playlists"],
    ["Forays", "#/forays"],
    ["Up Next", "#/queue"],
  ], "the drawer's top-level destinations must be exactly these five, in this order");
});

test("route() dispatches #/forays to renderForays, matching the #/playlists pattern", () => {
  /* #/forays is the one genuinely new address in this change; every other
     destination already had a route. A menu item pointing at an unrouted
     hash falls through to renderHome, which looks like "the link does
     nothing" rather than an error.

     MUTATION: delete the `#/forays` branch from renderCurrentPage(). This
     fails because renderHome runs instead and the "Forays" heading never
     appears. RUN: failed as named. */
  const m = quietMount();
  m.state.forays = { forays: [] };
  m.state.ready = true;
  m.ctx.ForayPlayer = { listForays: () => [], forayResumeList: () => [] };

  m.ctx.location.hash = "#/forays";
  m.ctx.route();
  assert.ok(m.view().includes("<h2>Forays</h2>"), "route() must dispatch #/forays to renderForays");
});

/* ==================================================================== */
/* 8-10. THE THREE THINGS THE MOVE COULD HAVE QUIETLY BROKEN            */
/* ==================================================================== */

test("'Up Next' is a page over real cp_queue state, not a slot filled to match the menu", () => {
  /* The one menu entry that could have been a fiction. It is not: `cp_queue`
     predates this change (docs/listening-queue-plan.md Stage 1), the "+ Up
     Next" control on every episode row writes to it, and #/queue renders it.
     This suite asserts that rather than assuming it, because "build a page to
     fill a menu slot" is the failure mode a five-item menu invites.

     MUTATION: make renderQueue ignore queueRows() and always render the empty
     state. The queued-title assertion fails while the menu entry still
     exists — which is precisely the empty-page failure this pins. RUN:
     replaced `rows.length ?` with `false ?`; failed as named. */
  const discover = readJson("data/discover.json");
  const item = discover.items[0];
  assert.ok(item && item.id, "fixture assumption: discover.json has at least one item");

  return mountBooted({ cp_queue: JSON.stringify([item.id]) }).then((m) => {
    m.ctx.renderQueue();
    const html = m.view();
    assert.ok(html.includes("<h2>Up Next</h2>"), "the page must be the Up Next page");
    assert.ok(html.includes("1 queued"), "the count must come from the stored queue");
    assert.ok(html.includes(m.ctx.esc(item.title)), "the queued episode must actually render");
  });
});

test("'Starred Shows' left the menu without leaving the app — the Shows page carries it", () => {
  /* The founder named five destinations and Starred Shows is a sixth, so it
     came off the menu. It is working functionality, so it did not come out of
     the app: a show-shaped surface belongs on the Shows page, which is where
     the link now is, and #/starred-shows still routes.

     FLAGGED FOR JOEY in the PR, as product: dropping a top-level entry is his
     call, not this change's.

     MUTATION: delete the `page-link-row` anchor from renderAllShows's `above`
     block. The link assertion fails and #/starred-shows becomes reachable
     only by typing the URL. RUN: failed as named. */
  const m = quietMount();

  m.ctx.renderAllShows();
  assert.ok(
    m.view().includes('href="#/starred-shows"'),
    "the Shows page must link to the starred-shows page"
  );

  m.state.ready = true;
  m.ctx.location.hash = "#/starred-shows";
  m.ctx.route();
  assert.ok(m.view().includes("Starred Shows"), "#/starred-shows must still route to its own page");
});

test("a Foray's back link lands on #/forays, where an unlocked draft is still listed", () => {
  /* The subtle breakage this change could have shipped. `enterForayFromQuery`
     exists so a `?foray=<id>` link opens that Foray once and its back button
     reaches a page that LISTS the unlocked draft — the first draft sent the
     back button to a home screen that just bounced it back, which is written
     up in that function's own comment. That list is no longer on Home, so a
     back link still pointing at `#/` would have re-created exactly the dead
     end that comment describes.

     Asserted over the renderForay template's source because the page is
     async, needs the resolved player module, and this is a link-target
     question rather than a rendering one.

     MUTATION: change renderForay's back link to href="#/". This fails. RUN:
     failed as named. */
  const forayPage = APP_SRC.slice(APP_SRC.indexOf('<div class="page foray">'));
  const back = /<a class="back" href="([^"]+)">/.exec(forayPage);
  assert.ok(back, "the Foray page must still render a back link");
  assert.strictEqual(
    back[1], "#/forays",
    "a Foray's back link must reach the page that lists Forays, not the home screen that no longer does"
  );
});
