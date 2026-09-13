/* Episodes section under Shows search (S-07, kanban t_6baccaa0):
 * `renderEpisodeSearchResults` in app.js, wired into `renderShowSearchResults`.
 *
 * Harness: the same node:vm DOM-stub pattern test/show-page.test.js uses,
 * duplicated per that file's own stated convention (a shared harness module
 * is a bigger refactor than this card's scope).
 *
 * WHAT THIS PROVES, in order:
 *  1. A successful api/episodes/search response renders an "Episodes"
 *     section with one ep-row per result.
 *  2. `source` including "apple" captions the section "from Apple's index";
 *     a result with source not including "apple" (e.g. show-scoped/live)
 *     does not add that caption.
 *  3. An empty result list renders nothing (hidden), not an empty section
 *     or a broken state — this repo's "absence is a real state" rule.
 *  4. Offline (`navigator.onLine === false`) skips the fetch entirely, and
 *     with an empty library renders nothing rather than hanging on a request
 *     that will fail.
 *  5. A superseded (stale) response is dropped — the token guard.
 *  6. Results are playable exactly like a curated ep-row (audio_url reaches
 *     playBtn via snapshot()).
 *
 * AND SINCE P-05 PIECE 2 (docs/search-parity-plan.md §4, 2026-09-12), the
 * INSTANT TIER — the first half of the two-pass shape, over the listener's own
 * `cp_saved`/`cp_queue` episodes:
 *  7. It paints on the keystroke, before any network call.
 *  8. It matches the SHOW name as well as the episode title.
 *  9. The endpoint's copy of an already-saved episode is merged, not
 *     duplicated, and the listener's copy leads.
 * 10. The "from Apple's index" caption never labels a local row.
 * 11. A failed endpoint pass leaves the local tier exactly as it was.
 * 12. Offline now ANSWERS from the device instead of clearing — a deliberate
 *     change from (4), which still holds for an empty library.
 * 13. `state.itemIndex` is not a source: an episode merely rendered this
 *     session is not the listener's own, and scanning it would put unbounded
 *     work back on the keystroke tick #662 just cleared.
 * 14. A fresh query with no local match clears the previous query's rows.
 *
 * AND SINCE THE ADVERSARIAL REVIEW OF 2026-09-12, the three defects it found
 * in that tier, each reproduced against this harness before it was fixed:
 * 15. Painting the tier may not write over the session snapshot of a REAL
 *     stored episode (defect 1 — the one that corrupted saved data).
 * 16. An episode saved from a SHOW PAGE dedups against the endpoint's copy of
 *     it, which it structurally could not before (defect 4).
 * 17. The show index landing mid-query does not clear the episode section
 *     (defect 5, the half that was new on this branch).
 *
 * Every test names the mutation that kills it, per CLAUDE.md.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");

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
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn", "banner-slot", "pl-form",
  "pl-input", "pl-note", "tab-topics", "tab-shows", "sh-form", "sh-input",
  "sh-note", "sh-results", "ep-search-results", "browse-all-link",
];

/* `storage` seeds the localStorage stub (P-05 piece 2): the instant episode
   tier reads `cp_saved` and `cp_queue`, so a suite that cannot write them can
   only ever exercise the empty-library case — which is every test above, and
   is why they stayed green through this change. Values are given as objects
   and stringified here, exactly as lsSet would have left them. */
function mount({ fetchImpl, online = true, storage = null } = {}) {
  const store = new Map(Object.entries(storage || {}).map(([k, v]) => [k, JSON.stringify(v)]));
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const body = makeEl("body");

  const ctx = {
    console: { ...console, warn() {}, error() {} },
    // Boot fetches (data/*.json triggered by init() at module load) never
    // resolve, exactly like show-page.test.js's unbooted mount() — this
    // suite doesn't need a real catalogue, only the episode-search fetch,
    // which the test-specific fetchImpl below distinguishes by URL.
    fetch: (url) => {
      if (fetchImpl) return fetchImpl(url);
      return new Promise(() => {});
    },
    localStorage: {
      get length() { return store.size; },
      key: (i) => Array.from(store.keys())[i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem(k, v) { store.set(k, String(v)); },
      removeItem(k) { store.delete(k); },
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
    navigator: { userAgent: "node", onLine: online },
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

  return {
    ctx, byId,
    state: vm.runInContext("state", ctx),
    container: () => byId.get("ep-search-results"),
  };
}

async function flush(n = 20) {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

function jsonResponse(body) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}

/** Routes `api/episodes/search` and `api/shows/search` calls to the given
 * handlers; anything else (data/*.json boot fetches) never resolves, same
 * as show-page.test.js's unbooted harness — this suite never calls init(). */
function apiRouter({ episodes, shows } = {}) {
  return (url) => {
    const u = String(url);
    if (u.includes("api/episodes/search")) return episodes ? episodes(u) : jsonResponse({ episodes: [], source: [] });
    if (u.includes("api/shows/search")) return shows ? shows(u) : jsonResponse({ shows: [] });
    return new Promise(() => {});
  };
}

/* ==================================================================== */

test("a successful episode search renders one ep-row per result under an Episodes heading", async () => {
  const m = mount({
    fetchImpl: apiRouter({
      episodes: () => jsonResponse({
        query: "geology",
        episodes: [
          { show_id: "geology-bites", show_title: "Geology Bites", title: "Ep One", guid: "g1", audio_url: "https://cdn.test/g1.mp3", duration_seconds: 600 },
          { show_id: "geology-bites", show_title: "Geology Bites", title: "Ep Two", guid: "g2", audio_url: "https://cdn.test/g2.mp3", duration_seconds: 700 },
        ],
        source: ["apple"],
        degraded: false,
        error: null,
      }),
    }),
  });

  m.state.catalog = { shows: [] };
  vm.runInContext("renderShowSearchResults('geology')", m.ctx);
  await flush();

  const html = m.container().innerHTML;
  assert.ok(html.includes("Episodes"), "must render an Episodes heading");
  assert.ok(html.includes("Ep One") && html.includes("Ep Two"), "must render both episode titles");
  assert.strictEqual((html.match(/class="ep-row/g) || []).length, 2, "must render exactly one ep-row per result");
  assert.strictEqual(m.container().hidden, false);
});

test('source including "apple" captions the section "from Apple\'s index"; a non-apple source does not', async () => {
  /* MUTATION: drop the `fromApple ?` conditional and always append the
     caption (or never append it). Either direction makes one of these two
     assertions fail. */
  const appleRun = mount({
    fetchImpl: apiRouter({
      episodes: () => jsonResponse({ episodes: [{ show_id: "s", title: "T", guid: "g", audio_url: "https://cdn.test/a.mp3" }], source: ["apple"] }),
    }),
  });
  appleRun.state.catalog = { shows: [] };
  vm.runInContext("renderShowSearchResults('x')", appleRun.ctx);
  await flush();
  assert.ok(appleRun.container().innerHTML.includes("from Apple's index"));

  const liveRun = mount({
    fetchImpl: apiRouter({
      episodes: () => jsonResponse({ episodes: [{ show_id: "s", title: "T", guid: "g", audio_url: "https://cdn.test/a.mp3" }], source: ["live"] }),
    }),
  });
  liveRun.state.catalog = { shows: [] };
  vm.runInContext("renderShowSearchResults('x')", liveRun.ctx);
  await flush();
  assert.ok(!liveRun.container().innerHTML.includes("from Apple's index"),
    "a live (show-scoped) source must not carry the Apple caption");
});

test("an empty episode result list renders nothing — hidden, not an empty section", async () => {
  /* MUTATION: drop the `if (!episodes.length)` early return so the section
     header renders even with zero rows. This fails on the hidden assertion. */
  const m = mount({
    fetchImpl: apiRouter({ episodes: () => jsonResponse({ episodes: [], source: [] }) }),
  });
  m.state.catalog = { shows: [] };
  vm.runInContext("renderShowSearchResults('nomatch')", m.ctx);
  await flush();
  assert.strictEqual(m.container().hidden, true);
  assert.strictEqual(m.container().innerHTML, "");
});

test("offline never issues the episode-search fetch and renders nothing", async () => {
  /* MUTATION: remove the navigator.onLine guard. fetchCalled would flip true
     and this fails. */
  let fetchCalled = false;
  const m = mount({
    online: false,
    fetchImpl: apiRouter({
      episodes: () => { fetchCalled = true; return jsonResponse({ episodes: [], source: [] }); },
    }),
  });
  m.state.catalog = { shows: [] };
  vm.runInContext("renderShowSearchResults('geology')", m.ctx);
  await flush();
  assert.strictEqual(fetchCalled, false, "must not call the episode-search endpoint while offline");
  assert.strictEqual(m.container().hidden, true);
});

test("a superseded (stale) episode-search response is dropped", async () => {
  /* Two overlapping queries; the first's response resolves AFTER the second
     starts. The stale response must never overwrite the fresher one.
     MUTATION: drop the `myToken !== showSearchToken` guard inside the
     episode-search .then(). The stale "first" text would win and this fails. */
  let resolveFirst;
  const firstPromise = new Promise((r) => { resolveFirst = r; });
  let call = 0;
  const m = mount({
    fetchImpl: apiRouter({
      episodes: () => {
        call++;
        if (call === 1) {
          return firstPromise.then(() => ({ ok: true, status: 200, json: async () => ({ episodes: [{ show_id: "s", title: "STALE", guid: "g1", audio_url: "https://cdn.test/a.mp3" }], source: [] }) }));
        }
        return jsonResponse({ episodes: [{ show_id: "s", title: "FRESH", guid: "g2", audio_url: "https://cdn.test/b.mp3" }], source: [] });
      },
    }),
  });
  m.state.catalog = { shows: [] };
  vm.runInContext("renderShowSearchResults('first')", m.ctx);
  vm.runInContext("renderShowSearchResults('second')", m.ctx);
  await flush();
  resolveFirst();
  await flush();

  const html = m.container().innerHTML;
  assert.ok(html.includes("FRESH"), "the newer query's results must be shown");
  assert.ok(!html.includes("STALE"), "the superseded query's results must never render");
});

test("an episode result is playable exactly like a curated row (audio_url reaches the play button)", async () => {
  /* MUTATION: drop `audio_url: ep.audio_url` from the snapshot() call inside
     renderEpisodeSearchResults. playBtn() would then render nothing for the
     row (see app.js's own rule: no audio_url -> no in-app play button) and
     this fails. */
  const m = mount({
    fetchImpl: apiRouter({
      episodes: () => jsonResponse({ episodes: [{ show_id: "s", title: "Playable Ep", guid: "g1", audio_url: "https://cdn.test/play.mp3", duration_seconds: 120 }], source: ["apple"] }),
    }),
  });
  m.state.catalog = { shows: [] };
  vm.runInContext("renderShowSearchResults('play')", m.ctx);
  await flush();
  const html = m.container().innerHTML;
  assert.ok(html.includes('class="play-btn"'), "a result with audio_url must render an in-app play button");
});

/* ====================================================================
   P-05 piece 2 (docs/search-parity-plan.md §4, rewritten 2026-09-12):
   THE INSTANT EPISODE TIER.

   The deck asked episodes to "ride the same two-pass shape" as shows.
   The second pass already existed; these cover the first — a local paint
   over the listener's OWN episodes (`cp_saved` + `cp_queue`), on the
   keystroke, merged with the endpoint's answer beneath it.

   Every test here seeds the storage stub, because with an empty library
   this tier is a no-op — which is exactly why every test above stayed
   green through the change, and also why none of them could have caught
   a regression in it.
   ==================================================================== */

const SAVED_HUBERMAN = {
  cp_saved: {
    "apple:huberman-lab:g-sleep": {
      id: "apple:huberman-lab:g-sleep",
      show: "Huberman Lab",
      title: "Sleep Toolkit",
      hook: "Tools for better sleep.",
      audio_url: "https://cdn.test/sleep.mp3",
      duration_sec: 3600,
      topics: [],
      saved_at: "2026-09-01T00:00:00Z",
    },
  },
};

test("a saved episode appears in the Episodes section on the keystroke, before any network call", async () => {
  /* THE CARD'S OWN "DONE WHEN". No flush, no timer: `onShowSearchInput`
     paints locally and then arms a 250 ms debounce, so everything asserted
     here happened on the keystroke itself.

     MUTATION: remove the `paintLocalEpisodeSearch(query, myToken)` call from
     paintShowSearchLocal. The container stays hidden and both assertions
     fail. */
  let fetched = false;
  const m = mount({
    storage: SAVED_HUBERMAN,
    fetchImpl: apiRouter({
      episodes: () => { fetched = true; return jsonResponse({ episodes: [], source: [] }); },
    }),
  });
  m.state.catalog = { shows: [] };
  vm.runInContext("onShowSearchInput('sleep')", m.ctx);

  assert.strictEqual(fetched, false, "the local tier must not wait on — or trigger — the endpoint");
  assert.strictEqual(m.container().hidden, false, "the Episodes section must be visible on the keystroke");
  assert.ok(m.container().innerHTML.includes("Sleep Toolkit"), "the listener's saved episode must be painted");
});

test("the show name matches too, so a host's name finds their saved episodes", async () => {
  /* §2.2's finding one layer down: a listener who types "huberman" is after
     their saved Huberman episodes, whose TITLES do not contain the word.
     MUTATION: drop the `else if (String(snap.show || "")...)` branch from
     localEpisodeMatches. */
  const m = mount({ storage: SAVED_HUBERMAN });
  m.state.catalog = { shows: [] };
  vm.runInContext("onShowSearchInput('huberman')", m.ctx);
  assert.ok(m.container().innerHTML.includes("Sleep Toolkit"), "a show-name match must reach the local tier");
});

test("the endpoint's copy of an already-saved episode is merged, not duplicated", async () => {
  /* The other half of the card's "done when". Same guid on both sides, so
     the row must appear exactly once — and it must be the LOCAL copy, whose
     id is the real storage id and whose star therefore renders as saved.

     MUTATION: drop the `seen.has(key)` skip in paintEpisodeSearchResults.
     Two ep-rows render and the count assertion fails. */
  const m = mount({
    storage: SAVED_HUBERMAN,
    fetchImpl: apiRouter({
      episodes: () => jsonResponse({
        episodes: [
          { show_id: "huberman-lab", show_title: "Huberman Lab", title: "Sleep Toolkit", guid: "g-sleep", audio_url: "https://cdn.test/sleep.mp3", duration_seconds: 3600 },
          { show_id: "huberman-lab", show_title: "Huberman Lab", title: "Focus Toolkit", guid: "g-focus", audio_url: "https://cdn.test/focus.mp3", duration_seconds: 3000 },
        ],
        source: ["apple"],
      }),
    }),
  });
  m.state.catalog = { shows: [] };
  vm.runInContext("renderShowSearchResults('toolkit')", m.ctx);
  await flush();

  const html = m.container().innerHTML;
  /* Counted on the TITLE LINK, not on the bare string: `playBtn` also puts the
     title in an `aria-label`, so every rendered row mentions it twice and a
     naive /Sleep Toolkit/g count reads 2 for a correctly-deduped list. */
  assert.strictEqual((html.match(/>Sleep Toolkit</g) || []).length, 1, "the shared episode must render exactly one row");
  assert.ok(html.includes(">Focus Toolkit<"), "the endpoint's other row must still be merged beneath");
  assert.strictEqual((html.match(/class="ep-row/g) || []).length, 2, "two distinct episodes, two rows");
  assert.ok(
    html.indexOf("Sleep Toolkit") < html.indexOf("Focus Toolkit"),
    "the listener's own episode leads; the endpoint's rows are merged BENEATH, never interleaved"
  );
});

test("the Apple caption never labels the listener's own rows", async () => {
  /* Provenance is an attribution, not decoration. With a local tier present
     the caption must move off the heading and sit above the endpoint's rows;
     with no local tier it stays on the heading, byte-identical to S-07.

     MUTATION: put the caption back on the `<h3>` unconditionally. The
     divider-position assertion fails, and the section then claims a saved
     episode came from Apple's index. */
  const m = mount({
    storage: SAVED_HUBERMAN,
    fetchImpl: apiRouter({
      episodes: () => jsonResponse({
        episodes: [{ show_id: "s", show_title: "Other Show", title: "Elsewhere", guid: "g-x", audio_url: "https://cdn.test/x.mp3" }],
        source: ["apple"],
      }),
    }),
  });
  m.state.catalog = { shows: [] };
  vm.runInContext("renderShowSearchResults('sleep')", m.ctx);
  await flush();

  const html = m.container().innerHTML;
  const heading = html.slice(0, html.indexOf("</h3>"));
  assert.ok(!heading.includes("from Apple's index"), "the heading must not caption a list whose first rows are the listener's own");
  assert.ok(
    html.indexOf("Sleep Toolkit") < html.indexOf("from Apple's index"),
    "the caption must sit below the listener's own rows and above the endpoint's"
  );
  assert.ok(html.indexOf("from Apple's index") < html.indexOf("Elsewhere"));
});

test("a failed endpoint pass leaves the local tier exactly as it was", async () => {
  /* The structural promise P-02 made the show list, held for episodes:
     nothing the endpoint does can SHORTEN the answer. `fetchApiJson`
     resolves null on any network or parse failure.

     MUTATION: restore the old `data ? paint(...) : null` call, which skipped
     the repaint entirely on a null response — under the two-tier merge that
     is not "leave it alone", because the debounced pass is the one that owns
     the container by then. */
  const m = mount({
    storage: SAVED_HUBERMAN,
    fetchImpl: apiRouter({ episodes: () => Promise.resolve(null) }),
  });
  m.state.catalog = { shows: [] };
  vm.runInContext("renderShowSearchResults('sleep')", m.ctx);
  await flush();

  assert.strictEqual(m.container().hidden, false, "a dead endpoint must not take the listener's own episodes away");
  assert.ok(m.container().innerHTML.includes("Sleep Toolkit"));
});

test("offline still answers from the listener's own episodes, and still issues no fetch", async () => {
  /* A DELIBERATE BEHAVIOUR CHANGE, and the reason to state it: before P-05
     this branch cleared the container, because without the network there was
     genuinely nothing to show. There is now, and offline is exactly when it
     matters.

     MUTATION: restore the `container.innerHTML = ""; container.hidden = true`
     clear in the offline branch of renderEpisodeSearchResults. The first
     assertion fails. The `fetchCalled` assertion is the older rule, kept
     here so the new behaviour cannot be bought by dropping it. */
  let fetchCalled = false;
  const m = mount({
    online: false,
    storage: SAVED_HUBERMAN,
    fetchImpl: apiRouter({
      episodes: () => { fetchCalled = true; return jsonResponse({ episodes: [], source: [] }); },
    }),
  });
  m.state.catalog = { shows: [] };
  vm.runInContext("renderShowSearchResults('sleep')", m.ctx);
  await flush();

  assert.ok(m.container().innerHTML.includes("Sleep Toolkit"), "offline must still answer from the device");
  assert.strictEqual(fetchCalled, false, "offline must still never call the endpoint");
});

test("an episode merely rendered this session is NOT in the local tier", async () => {
  /* THE SCAN'S BOUNDARY, which is a performance rule and an honesty rule at
     once. `state.itemIndex` holds every snapshot() this session made —
     including the previous query's Apple results — so scanning it would put
     unbounded work on the keystroke tick that #662 just cleared, AND would
     resurface a directory result as though it were the listener's own.

     MUTATION: add `state.itemIndex` as a source in localEpisodeMatches.
     "Never Saved" appears and this fails. */
  const m = mount({ storage: SAVED_HUBERMAN });
  m.state.catalog = { shows: [] };
  m.state.itemIndex["apple:other:g-never"] = {
    id: "apple:other:g-never", show: "Some Show", title: "Never Saved", hook: "", topics: [],
  };
  vm.runInContext("onShowSearchInput('never')", m.ctx);

  assert.strictEqual(m.container().hidden, true, "nothing of the listener's matches, so the section stays absent");
  assert.ok(!m.container().innerHTML.includes("Never Saved"));
});

test("a fresh query with no local match clears the previous query's rows rather than leaving them", async () => {
  /* "Absence is a real state", and the stale-section failure is the one a
     two-tier paint makes possible: the local tier paints instantly, so a
     query it cannot answer would otherwise sit under the OLD rows for the
     369 ms median the endpoint takes to correct it.

     MUTATION: delete the `container.innerHTML = ""; container.hidden = true`
     clear from paintLocalEpisodeSearch's no-match branch. */
  const m = mount({ storage: SAVED_HUBERMAN });
  m.state.catalog = { shows: [] };
  vm.runInContext("onShowSearchInput('sleep')", m.ctx);
  assert.ok(m.container().innerHTML.includes("Sleep Toolkit"), "precondition: the first query painted");
  vm.runInContext("onShowSearchInput('zzqx')", m.ctx);
  assert.strictEqual(m.container().hidden, true);
  assert.strictEqual(m.container().innerHTML, "");
});

/* ====================================================================
   ADVERSARIAL REVIEW, 2026-09-12. Three defects, each reproduced against
   this harness first and each fixed here. The point of these three is not
   that the bugs were fixed — it is that they cannot come back.
   ==================================================================== */

/** The shape `fullCatalogueRowToEpRowItem` (app.js) mints for an episode saved
    from a show page or the full-catalogue list: `${show_id}--${guid}`, where
    the suffix is the feed's REAL guid. Every test below that is about a
    show-page save uses this id, because it is the id the app actually writes. */
const SHOW_PAGE_SAVED = {
  cp_saved: {
    "lex-fridman-podcast--abc-123-guid": {
      id: "lex-fridman-podcast--abc-123-guid",
      show: "Lex Fridman Podcast",
      title: "Elon Musk: Neuralink",
      hook: "A conversation.",
      artwork_url: "https://img.test/lex.jpg",
      topics: ["technology", "science"],
      release_date: "2026-01-02",
      audio_url: "https://cdn.test/lex.mp3",
      duration_min: 180,
      duration_sec: 10800,
      explicit: false,
      apple_collection_id: 1434243584,
      saved_at: "2026-09-01T00:00:00Z",
    },
  },
};

test("a search paint never writes over the session snapshot of a real stored episode", async () => {
  /* DEFECT 1 of the adversarial review, and the worst of the five because it
     corrupted the listener's own data rather than only the screen.

     `rowFor` passed `ep._localId` — the REAL storage id — into `snapshot()`,
     and the object it passed was the ENDPOINT's row shape, which has no
     `artwork_url`, no `topics`, no `release_date`, no `explicit` and no
     `apple_*`. `snapshot()` ends `state.itemIndex[id] = snap`, so ONE
     KEYSTROKE, with no network and no debounce, replaced a starred, in-pool
     episode's artwork and topics with nulls. `rowsForIds` then rendered the
     degraded copy in Up Next and the Library for the rest of the session, and
     `toggleStar` wrote it into `cp_saved` at the next star toggle — at which
     point it was on disk and `boostTopics` was being fed `[]`.

     THE ASSERTIONS ARE THE STORED RECORD, not the painted row, deliberately:
     a row that happened to render artwork while `itemIndex` rotted would be
     the same bug one repaint later.

     MUTATION: collapse `rowFor` back to one branch —
     `const id = ep._localId || \`apple:...\`` followed by the shared
     `snapshot(id, {...})`. The artwork, topics and release_date assertions all
     go red, and so does the queue row's.

     MUTATION 2: keep the branch but pass the projection instead of
     `ep._localSnapshot`. Same three failures — which is the point: the branch
     alone is not the fix, the SOURCE it snapshots from is. */
  const m = mount({ storage: SHOW_PAGE_SAVED });
  m.state.catalog = { shows: [] };
  const ID = "lex-fridman-podcast--abc-123-guid";
  const rich = SHOW_PAGE_SAVED.cp_saved[ID];
  m.state.itemIndex[ID] = { ...rich };
  m.state.poolIds = new Set([ID]);

  vm.runInContext("onShowSearchInput('neuralink')", m.ctx);

  const after = m.state.itemIndex[ID];
  assert.strictEqual(after.artwork_url, rich.artwork_url, "the snapshot must keep its artwork through a search paint");
  assert.deepStrictEqual(after.topics, rich.topics, "and its topics, which feed boostTopics on the next star");
  assert.strictEqual(after.release_date, rich.release_date, "and its release date, which the row itself renders");
  assert.strictEqual(after.explicit, rich.explicit, "and its explicit flag, which the badge reads");

  /* The surface that made it visible: anything in `poolIds` renders from
     `state.itemIndex`, so Up Next and the Library screen read back whatever
     the paint left there. */
  const row = vm.runInContext(`rowsForIds([${JSON.stringify(ID)}])[0]`, m.ctx);
  assert.strictEqual(row.state, "live");
  assert.strictEqual(row.item.artwork_url, rich.artwork_url, "the Up Next / Library row must not render the degraded copy");
});

test("an episode saved from a SHOW PAGE dedups against the endpoint's copy of it", async () => {
  /* DEFECT 4. `episodeDedupKey` uses two disjoint namespaces — `g:<guid>` when
     a row has a guid, `t:<title>|<show>` when it does not — and
     `localEpisodeRow` only ever recovered a guid from an `apple:<show>:<guid>`
     id. Every episode saved from a show page has id `<show_id>--<guid>`
     (`fullCatalogueRowToEpRowItem`), so it yielded `guid: null` and keyed by
     TITLE, while the endpoint's copy — endpoint rows always carry a guid —
     keyed by GUID. A `t:` key can never equal a `g:` key, so the listener saw
     the episode they had starred twice: once in the local tier with a filled
     star, once under "from Apple's index" with an empty one and a different
     minted id, so starring THAT copy made a second `cp_saved` entry for the
     same episode.

     MUTATION: restore `guid: wasApple ? parts.slice(2).join(":") : null` in
     `localEpisodeRow` (i.e. drop the `--` branch of `localEpisodeIdentity`).
     The row renders twice and the count assertion goes red. */
  const m = mount({
    storage: SHOW_PAGE_SAVED,
    fetchImpl: apiRouter({
      episodes: () => jsonResponse({
        episodes: [
          { show_id: "lex-fridman-podcast", show_title: "Lex Fridman Podcast", title: "Elon Musk: Neuralink", guid: "abc-123-guid", audio_url: "https://cdn.test/lex.mp3", duration_seconds: 10800 },
          { show_id: "lex-fridman-podcast", show_title: "Lex Fridman Podcast", title: "Another Conversation", guid: "def-456-guid", audio_url: "https://cdn.test/other.mp3", duration_seconds: 7200 },
        ],
        source: ["apple"],
      }),
    }),
  });
  m.state.catalog = { shows: [] };
  vm.runInContext("renderShowSearchResults('neuralink')", m.ctx);
  await flush();

  const html = m.container().innerHTML;
  assert.strictEqual((html.match(/>Elon Musk: Neuralink</g) || []).length, 1,
    "the episode the listener starred from a show page must render exactly once");
  assert.ok(html.includes(">Another Conversation<"), "the endpoint's genuinely new row must still be merged");
  assert.ok(html.includes(`#/episode/${encodeURIComponent("lex-fridman-podcast--abc-123-guid")}`),
    "and the copy that survives must be the LOCAL one, whose id is the real storage id and whose star is real");
});

test("the guid recovered from an id is a candidate, not an answer: the curated pool dedups by title", () => {
  /* THE OTHER DIRECTION OF DEFECT 4, and the reason the fix is a key SET
     rather than a better guid parse. `data/discover.json`'s 2,160 ids share
     the `<a>--<b>` shape and NOT its meaning: the suffix there is an editorial
     slug (`lex-fridman-podcast--don-lincoln-physics`), so it will never equal
     any feed's guid. Trusting a recovered guid alone would therefore have
     fixed the show-page case and left the curated pool duplicating — and, far
     worse, a guid key carries no show, so `show-a--intro` and `show-b--intro`
     would both derive `g:intro` and collapse two unrelated episodes into one.

     MUTATION: make `episodeDedupKeys` return `[episodeDedupKey(ep)]`. The
     first assertion goes red — the curated row and the endpoint row stop
     agreeing on anything. */
  const m = mount();
  const curatedKeys = vm.runInContext(
    'episodeDedupKeys(localEpisodeRow("omega-tau--modern-fission-reactors", {show:"omega tau", title:"Modern Fission Reactors"}))',
    m.ctx);
  const endpointKeys = vm.runInContext(
    'episodeDedupKeys({guid:"https://feed.test/?p=9912", title:"Modern Fission Reactors", show_title:"omega tau"})',
    m.ctx);
  assert.ok(curatedKeys.some((k) => endpointKeys.includes(k)),
    "a curated pool item and the endpoint's copy of it must share at least one key");

  const a = vm.runInContext('episodeDedupKeys(localEpisodeRow("show-a--intro", {show:"Show A", title:"Intro"}))', m.ctx);
  const b = vm.runInContext('episodeDedupKeys(localEpisodeRow("show-b--intro", {show:"Show B", title:"Intro"}))', m.ctx);
  assert.ok(!a.some((k) => b.includes(k)),
    "two different shows' episodes must not collapse through a slug that merely looks like a guid");
});

test("the show index landing mid-query does not clear the episode section", async () => {
  /* DEFECT 5, the half that was new on this branch. The show index is loaded
     lazily on the first focus, so it routinely resolves in the MIDDLE of a
     query the endpoint has already answered. `repaintShowSearchForIndex` ran
     `paintShowSearchLocal` with the CURRENT token — not a supersession, so no
     guard stopped it — and P-05 had just put `paintLocalEpisodeSearch` on that
     function, whose no-local-match branch does
     `container.innerHTML = ""; container.hidden = true`. The endpoint's
     episode rows vanished, with no way back until the next keystroke.

     A SHOW INDEX SAYS NOTHING ABOUT EPISODES. That is the whole argument, and
     the fix is that `repaintShowSearchForIndex` no longer touches this
     container at all.

     MUTATION: put `paintLocalEpisodeSearch(query, showSearchToken)` back into
     `repaintShowSearchForIndex` (or restore its `paintShowSearchLocal` call).
     The section is cleared and both assertions go red. */
  const m = mount({
    fetchImpl: apiRouter({
      episodes: () => jsonResponse({
        episodes: [{ show_id: "radiolab", show_title: "Radiolab", title: "Stereothreat", guid: "g1", audio_url: "https://cdn.test/s.mp3" }],
        source: ["apple"],
      }),
    }),
  });
  m.state.catalog = { shows: [] };
  m.byId.get("sh-input").value = "radiolab";
  vm.runInContext("renderShowSearchResults('radiolab')", m.ctx);
  await flush();
  assert.ok(m.container().innerHTML.includes("Stereothreat"), "precondition: the endpoint's row is on screen");

  vm.runInContext("repaintShowSearchForIndex()", m.ctx);

  assert.strictEqual(m.container().hidden, false, "the index landing must not hide an answered episode section");
  assert.ok(m.container().innerHTML.includes("Stereothreat"), "nor throw away the rows it had no opinion about");
});
