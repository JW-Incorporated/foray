/* The four listener-facing formatters, and the rule that every surface uses them
 * (audit 2026-09-22, docs/audit/qa-synthesis.md theme C).
 *
 * WHY THIS EXISTS. Each of these was written once, correctly, at the call site
 * that first hurt, and the other call sites went on doing it by hand:
 *
 *   - fmtDur printed an exact hour as "1h 0m" (49 episodes of the shipped pool);
 *   - a one-episode playlist read "1 parts" on the Playlists page, its search
 *     row and its Jump back in card, "1 part" in Library and "1 episode" on its
 *     own page — one list, three nouns, one of five surfaces pluralising;
 *   - epRow and upNextRow printed "Show ·  · Sep 12" when the feed carried no
 *     duration, while archivedRow and forayRow beside them got it right;
 *   - the Playlists page printed a raw `toLocaleDateString()` that fmtDate's own
 *     header says it exists to prevent ("Invalid Date").
 *
 * So this file pins the HELPERS behaviourally and then pins that the call sites
 * route through them, by rendering the surfaces rather than by grepping. Every
 * test names the mutation that kills it.
 *
 * Harness: the node:vm DOM stub test/library-screen.test.js uses, cut down to
 * what these renders touch, and duplicated rather than imported for the reason
 * that file gives — each suite's fixtures are its own.
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
    closest: () => null, focus() {}, select() {}, click() {}, remove() {},
  };
}

function mount(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const view = makeEl("main");
  const byId = new Map([["view", view], ...["pl-form", "pl-input", "pl-note"].map((id) => [id, makeEl("div")])]);
  const body = makeEl("body");
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),
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
      querySelector: (sel) => (String(sel).startsWith("#") ? byId.get(String(sel).slice(1)) ?? null : null),
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
  const state = vm.runInContext("state", ctx);
  state.catalog = { shows: [] };
  state.discover = { items: [] };
  state.taxonomy = { nodes: [] };
  state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  state.cardSlots = [];
  return { ctx, state, view: () => view.innerHTML };
}

/* ------------------------------------------------------------------ */
/* fmtDur                                                              */
/* ------------------------------------------------------------------ */

/* ONE DIALECT (audit round 2, copy-2): "45 min", "1 hr", "1 hr 5 min" — a row
   used to read "3h 5m" beside "185 min left". MUTATION: restore
   `${h}h ${m}m` above the hour; MUTATION 2: print "1 hr 0 min" for an exact
   hour (the round-1 "1h 0m" defect). */
test("fmtDur: '45 min', '1 hr', '1 hr 5 min' — one dialect, never '1 hr 0 min'", () => {
  const { ctx } = mount();
  assert.strictEqual(ctx.fmtDur(60), "1 hr");
  assert.strictEqual(ctx.fmtDur(120), "2 hr");
  assert.strictEqual(ctx.fmtDur(61), "1 hr 1 min");
  assert.strictEqual(ctx.fmtDur(95), "1 hr 35 min");
  assert.strictEqual(ctx.fmtDur(59), "59 min");
  assert.strictEqual(ctx.fmtDur(44.6), "45 min", "a fraction is rounded, never printed");
});

/* THE RULE ACROSS FILES (copy-2). A classic script and three ES modules cannot
   share one function, so the rule is pinned across all four: for every length,
   the player's span, both "left" labels and app.js's fmtDur say the same words.
   MUTATION: drop the hour branch from any one of fmtSpan, remainingLabel or
   episodeRemainingLabel ("185 min left" comes back) and its row fails. */
test("fmtDur, fmtSpan and both remaining labels speak one dialect at every length", async () => {
  const { ctx } = mount();
  const url = (rel) => require("node:url").pathToFileURL(path.join(ROOT, rel)).href;
  const { fmtSpan } = await import(url("player/foray-resolve.js"));
  const { remainingLabel } = await import(url("player/foray-progress.js"));
  const { episodeRemainingLabel, fmtMinutes } = await import(url("player/episode-progress.js"));
  for (const min of [2, 45, 59, 60, 65, 95, 120, 185]) {
    const words = ctx.fmtDur(min);
    assert.strictEqual(fmtSpan(min * 60), words, `fmtSpan(${min} min)`);
    assert.strictEqual(fmtMinutes(min), words, `fmtMinutes(${min})`);
    assert.strictEqual(remainingLabel(min * 60), `${words} left`, `remainingLabel(${min} min)`);
    assert.strictEqual(episodeRemainingLabel({ duration_sec: min * 60 + 600 }, 600), `${words} left`, `episodeRemainingLabel(${min} min)`);
  }
});

/* A missing duration is absence, not zero. MUTATION: drop the `!min` guard
   and "0 min" / "undefined min" reaches a row. */
test("fmtDur: no duration renders nothing", () => {
  const { ctx } = mount();
  for (const v of [undefined, null, 0, ""]) assert.strictEqual(ctx.fmtDur(v), "");
});

/* ------------------------------------------------------------------ */
/* countLabel / playlistLengthLabel                                    */
/* ------------------------------------------------------------------ */

/* MUTATION: make countLabel always append "s". The singular fails. */
test("countLabel: singular at exactly one, plural otherwise, irregular plural honoured", () => {
  const { ctx } = mount();
  assert.strictEqual(ctx.countLabel(1, "episode"), "1 episode");
  assert.strictEqual(ctx.countLabel(0, "episode"), "0 episodes");
  assert.strictEqual(ctx.countLabel(2, "episode"), "2 episodes");
  assert.strictEqual(ctx.countLabel(1, "match", "matches"), "1 match");
  assert.strictEqual(ctx.countLabel(3, "match", "matches"), "3 matches");
});

/* Dated in a past year on purpose: a date in the current year omits its year
   (copy-15), so a fixture in "this" year would read differently next January. */
function onePartPlaylist(m) {
  const item = { id: "ep-1", title: "Only episode", show: "Show", audio_url: "https://a.test/1.mp3", topics: [] };
  m.state.discover = { items: [item] };
  m.ctx.fullPool && m.ctx.fullPool();
  m.ctx.savePlaylists([{
    id: "q1", title: "Solo", items: [m.ctx.playlistPart(item)],
    created: "2019-09-20T00:00:00.000Z", last_played_at: "2019-09-21T18:00:00.000Z",
  }]);
}

/* THE RULE, not a list: every surface that states a playlist's length says the
   same thing, and a one-episode playlist is singular on all of them.
   MUTATION: revert any ONE of the four call sites to `${resolveParts(p).length} parts`
   (renderPlaylists, the playlist search row, the Jump back in entry, the Library
   summary row). That surface's assertion fails with "1 parts" in hand. */
test("a one-episode playlist reads '1 episode' on the Playlists page, in Library and on its Jump back in card", () => {
  const m = mount();
  onePartPlaylist(m);

  m.ctx.renderPlaylists();
  assert.match(m.view(), />1 episode · played /, "Playlists page row");
  assert.ok(!/\b1 parts?\b/.test(m.view()), `Playlists page must not say "parts": ${m.view()}`);

  m.ctx.renderLibrary();
  assert.match(m.view(), /1 episode</, "Library summary row");
  assert.ok(!/\b1 parts?\b/.test(m.view()), "Library must not say parts");

  const pl = m.ctx.jumpBackInEntries().find((e) => e.kind === "playlist");
  assert.ok(pl, "the played playlist must be a Jump back in entry");
  assert.strictEqual(pl.sub, "1 episode", "Jump back in card");
});

/* The playlist SEARCH row is a fourth surface, and it lives in a different
   function 1,500 lines away from the other three.
   MUTATION: restore `${resolveParts(p).length} parts` in its `row` template. */
test("the playlist search row counts through the same helper", () => {
  const body = APP_SRC.slice(APP_SRC.indexOf("const row = (p, generated) => `"), APP_SRC.indexOf("const row = (p, generated) => `") + 600);
  assert.ok(body.includes("playlistLengthLabel(p)"), `the search row counts by hand: ${body}`);
  assert.ok(!/resolveParts\(p\)\.length\}\s*part/.test(APP_SRC), "no surface may count playlist parts by hand");
});

/* ------------------------------------------------------------------ */
/* joinMeta                                                            */
/* ------------------------------------------------------------------ */

/* MUTATION: `pieces.join(" · ")` without the filter. */
test("joinMeta drops empty pieces instead of leaving a separator around nothing", () => {
  const { ctx } = mount();
  assert.strictEqual(ctx.joinMeta("Show", "", "Sep 12, 2026"), "Show · Sep 12, 2026");
  assert.strictEqual(ctx.joinMeta("Show", "", ""), "Show");
  assert.strictEqual(ctx.joinMeta("", "45 min"), "45 min");
  assert.strictEqual(ctx.joinMeta(), "");
});

/* The surfaces the audit found printing "Show ·  · date": epRow and the live
   Up Next row. MUTATION: restore `${showNameLink(item.show)} · ${fmtDur(...)}`
   in epRow — the double separator comes back and this fails. */
test("an episode row with no duration has no empty field between separators", () => {
  const { ctx } = mount();
  const html = ctx.epRow({ id: "e", title: "T", show: "Lex", duration_min: null, release_date: "2019-09-12", audio_url: "https://a.test/x.mp3" }, 0, "", -1);
  assert.ok(!/·\s*·/.test(html), `double separator: ${html}`);
  assert.match(html, /Lex · Sep 12, 2019/);
  const noDate = ctx.epRow({ id: "e", title: "T", show: "Lex", duration_min: null, release_date: null, audio_url: "https://a.test/x.mp3" }, 0, "", -1);
  assert.ok(!/·\s*<\/div>/.test(noDate), `trailing separator: ${noDate}`);
});

/* MUTATION: restore `${esc(item.show)} · ${fmtDur(item.duration_min)}` in upNextRow. */
test("a live Up Next row with no duration ends at the show name", () => {
  const { ctx } = mount();
  const html = ctx.upNextRow({ id: "e", state: "live", item: { id: "e", title: "T", show: "Lex", audio_url: "https://a.test/x.mp3" } }, 0, 1);
  assert.match(html, /<div class="s">Lex<\/div>/, html);
});

/* The aged-out playlist row said "not available" twice on one line (qa row 142):
   a caption "· not available right now" AND the "Not available to play" chip.
   MUTATION: put the caption back into archivedRow. */
test("an aged-out playlist row states its unavailability once", () => {
  const { ctx } = mount();
  const html = ctx.archivedRow({ id: "e", title: "T", show: "Lex", duration_min: 60, release_date: "2019-09-12" }, 0, "");
  assert.ok(html.includes("Not available to play"), "the chip is the one statement");
  assert.ok(!html.includes("not available right now"), `said twice: ${html}`);
  assert.match(html, /Lex · 1 hr · Sep 12, 2019/);
});

/* ------------------------------------------------------------------ */
/* fmtDate                                                             */
/* ------------------------------------------------------------------ */

/* The local calendar day of an instant, the way `fmtDate(…, { local: true })`
   must write it — computed HERE, in the machine's own zone, rather than written
   as a literal. The fixtures' instants fall on Sep 21 in the Americas and Sep 22
   from about UTC+6 east, so a literal (or a `Sep 2[01]` regex) failed on any
   machine set to Asia/Pacific time (review 2026-09-23). */
const localDay = (iso) => new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

/* MUTATION: drop the NaN guard — "Invalid Date" comes back. */
test("fmtDate never says 'Invalid Date', in either timezone mode", () => {
  const { ctx } = mount();
  for (const opts of [undefined, { local: true }]) {
    assert.strictEqual(ctx.fmtDate("not a date", opts), "");
    assert.strictEqual(ctx.fmtDate("", opts), "");
    assert.strictEqual(ctx.fmtDate(null, opts), "");
  }
  assert.strictEqual(ctx.fmtDate("2019-09-21"), "Sep 21, 2019");
  assert.strictEqual(ctx.fmtDate("2019-09-21T12:00:00.000Z", { local: true }), localDay("2019-09-21T12:00:00.000Z"));
  assert.match(localDay("2019-09-21T12:00:00.000Z"), /^Sep 2\d, 2019$/, "fixture: the expected form is the short month");
});

/* THE YEAR ONLY WHEN IT IS NOT THIS ONE (audit round 2, copy-15), Apple
   Podcasts' rule — judged in the zone the date is written in, so a New Year's
   Eve release is not "this year" anywhere it is already January in UTC.
   `now` is fixed so the test does not depend on the machine's calendar.
   MUTATION: always set `opts.year` (every row says ", 2026" again);
   MUTATION 2: judge "this year" in local time for a UTC release date. */
test("fmtDate drops the year for a date in the current year and keeps it otherwise", () => {
  const { ctx } = mount();
  const now = new Date("2026-09-23T12:00:00.000Z");
  assert.strictEqual(ctx.fmtDate("2026-09-12", { now }), "Sep 12");
  assert.strictEqual(ctx.fmtDate("2025-11-03", { now }), "Nov 3, 2025");
  assert.strictEqual(ctx.fmtDate("2025-12-31", { now: new Date("2026-01-01T02:00:00.000Z") }), "Dec 31, 2025",
    "a UTC release date is judged in UTC");
  const localNow = new Date(2026, 8, 23, 12);
  assert.strictEqual(ctx.fmtDate(new Date(2026, 8, 21, 18).toISOString(), { local: true, now: localNow }), "Sep 21");
  assert.strictEqual(ctx.fmtDate(new Date(2025, 8, 21, 18).toISOString(), { local: true, now: localNow }), "Sep 21, 2025");
});

/* The Playlists page was the one raw toLocaleDateString() in the app: "played
   9/21/2026" beside "Sep 21, 2026" everywhere else, and "played Invalid Date" for
   a hand-edited store. MUTATION: restore
   `played ${new Date(p.last_played_at).toLocaleDateString()}`. */
test("the Playlists page formats 'played' through fmtDate and says nothing for a corrupt date", () => {
  const m = mount();
  onePartPlaylist(m);
  m.ctx.renderPlaylists();
  assert.ok(m.view().includes(`played ${localDay("2019-09-21T18:00:00.000Z")}`), m.view());

  const raw = JSON.parse(m.ctx.localStorage.getItem("cp_playlists"));
  raw[0].last_played_at = "garbage";
  m.ctx.localStorage.setItem("cp_playlists", JSON.stringify(raw));
  m.ctx.renderPlaylists();
  assert.ok(!m.view().includes("Invalid Date"), m.view());
  assert.ok(!m.view().includes("played"), "no date, no 'played' clause");
  assert.ok(!/\.toLocaleDateString\(\)/.test(APP_SRC), "no bare toLocaleDateString() may remain in app.js");
});

/* ------------------------------------------------------------------ */
/* One length per episode (audit round 2, honesty-1)                   */
/* ------------------------------------------------------------------ */

/* in-the-dark--blood-relatives-ep1 carried duration_min 45 and duration_sec
   3581: the row read "45 min" and, seven minutes in, "45 min · 53 min left".
   MUTATION: return `item.duration_min` first in episodeMinutes — the row says
   45 min again; MUTATION 2: revert epRow to `fmtDur(item.duration_min)`. */
test("an episode's length is its seconds when it has them, on the row beside its own 'left' label", () => {
  const m = mount();
  assert.strictEqual(m.ctx.episodeMinutes({ duration_min: 45, duration_sec: 3581 }), 60);
  assert.strictEqual(m.ctx.episodeMinutes({ duration_min: 45 }), 45, "no seconds: the minute count stands");
  assert.strictEqual(m.ctx.episodeMinutes({}), 0);
  const item = { id: "drift", title: "T", show: "S", duration_min: 45, duration_sec: 3581, release_date: "2019-01-01", audio_url: "https://a.test/x.mp3" };
  const html = m.ctx.epRow(item, 0, "", -1);
  assert.match(html, /S<\/a> · 1 hr · |S · 1 hr · /, html);
  assert.ok(!/45 min/.test(html), `the minute count reached the row: ${html}`);
});

/* The data half: the two fields may not drift a minute apart anywhere in the
   committed pool. MUTATION: put `"duration_min": 45` back on
   in-the-dark--blood-relatives-ep1 in data/discover.json. */
test("the committed pool carries no episode whose minutes and seconds disagree by a minute", async () => {
  const url = require("node:url").pathToFileURL(path.join(ROOT, "tools/check-durations.mjs")).href;
  const { durationDrift, committedItems, minutesFromSeconds } = await import(url);
  assert.deepStrictEqual(durationDrift([{ id: "x", duration_min: 45, duration_sec: 3581 }]).map((d) => d.id), ["x"], "the gate can see");
  assert.strictEqual(minutesFromSeconds(3581), 60);
  assert.strictEqual(minutesFromSeconds(null), null);
  const items = committedItems();
  assert.ok(items.length > 2000, `fixture: the pool loaded (${items.length})`);
  assert.deepStrictEqual(durationDrift(items), []);
});

/* ------------------------------------------------------------------ */
/* A zero is not a fact worth a line (copy-13, p-first-10, copy-10)    */
/* ------------------------------------------------------------------ */

/* MUTATION: restore `${played} played` unconditionally — every list a
   newcomer opens reads "0 played". */
test("a playlist page says how many were played only when some were", () => {
  const m = mount();
  onePartPlaylist(m);
  m.ctx.renderPlaylistDetail("q1");
  assert.ok(!/0 played/.test(m.view()), m.view());
  m.ctx.localStorage.setItem("cp_history", JSON.stringify(["ep-1"]));
  m.ctx.renderPlaylistDetail("q1");
  assert.match(m.view(), /1 played/);
});

/* MUTATION: restore either count subtitle unguarded ("0 queued" over "Nothing
   in Up Next yet", "0 built" over "No playlists yet"), the drawer's lowercase
   fragment, or the Library's lowercase subtitle. */
test("empty Up Next and Playlists pages carry no zero count, and the drawer's empty line is a sentence", () => {
  const m = mount();
  m.ctx.renderQueue();
  assert.ok(!/0 queued/.test(m.view()), m.view());
  m.ctx.renderPlaylists();
  assert.ok(!/0 built/.test(m.view()), m.view());
  m.ctx.renderLibrary();
  assert.ok(!/forays, shows, saved/.test(m.view()), "the Library subtitle is gone");
  assert.ok(APP_SRC.includes('<p class="drawer-empty">No playlists yet</p>'), "the drawer's empty playlists line");
  assert.ok(!APP_SRC.includes(">none yet<"), "the lowercase fragment is gone");
});

/* MUTATION: put back "where it fits" for the plural case. */
test("an aged-out note's plural agrees to the end of the sentence", () => {
  const m = mount();
  const rows = [{ state: "archived", item: { id: "a" } }, { state: "archived", item: { id: "b" } }];
  const html = m.ctx.partsNote(rows);
  assert.match(html, /they stay listed so you can see where they fit in the playlist\./, html);
  assert.match(m.ctx.partsNote(rows.slice(0, 1)), /it stays listed so you can see where it fits in the playlist\./);
});
