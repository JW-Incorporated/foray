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

/* MUTATION: restore `${Math.floor(min / 60)}h ${min % 60}m` for every
   min >= 60. The exact-hour assertions fail ("1h 0m"). */
test("fmtDur: an exact hour is '1h', never '1h 0m'", () => {
  const { ctx } = mount();
  assert.strictEqual(ctx.fmtDur(60), "1h");
  assert.strictEqual(ctx.fmtDur(120), "2h");
  assert.strictEqual(ctx.fmtDur(61), "1h 1m");
  assert.strictEqual(ctx.fmtDur(95), "1h 35m");
  assert.strictEqual(ctx.fmtDur(59), "59 min");
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

function onePartPlaylist(m) {
  const item = { id: "ep-1", title: "Only episode", show: "Show", audio_url: "https://a.test/1.mp3", topics: [] };
  m.state.discover = { items: [item] };
  m.ctx.fullPool && m.ctx.fullPool();
  m.ctx.savePlaylists([{
    id: "q1", title: "Solo", items: [m.ctx.playlistPart(item)],
    created: "2026-09-20T00:00:00.000Z", last_played_at: "2026-09-21T18:00:00.000Z",
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
  const html = ctx.epRow({ id: "e", title: "T", show: "Lex", duration_min: null, release_date: "2026-09-12", audio_url: "https://a.test/x.mp3" }, 0, "", -1);
  assert.ok(!/·\s*·/.test(html), `double separator: ${html}`);
  assert.match(html, /Lex · Sep 12, 2026/);
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
  const html = ctx.archivedRow({ id: "e", title: "T", show: "Lex", duration_min: 60, release_date: "2026-09-12" }, 0, "");
  assert.ok(html.includes("Not available to play"), "the chip is the one statement");
  assert.ok(!html.includes("not available right now"), `said twice: ${html}`);
  assert.match(html, /Lex · 1h · Sep 12, 2026/);
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
  assert.strictEqual(ctx.fmtDate("2026-09-21"), "Sep 21, 2026");
  assert.strictEqual(ctx.fmtDate("2026-09-21T12:00:00.000Z", { local: true }), localDay("2026-09-21T12:00:00.000Z"));
  assert.match(localDay("2026-09-21T12:00:00.000Z"), /^Sep 2\d, 2026$/, "fixture: the expected form is the short month");
});

/* The Playlists page was the one raw toLocaleDateString() in the app: "played
   9/21/2026" beside "Sep 21, 2026" everywhere else, and "played Invalid Date" for
   a hand-edited store. MUTATION: restore
   `played ${new Date(p.last_played_at).toLocaleDateString()}`. */
test("the Playlists page formats 'played' through fmtDate and says nothing for a corrupt date", () => {
  const m = mount();
  onePartPlaylist(m);
  m.ctx.renderPlaylists();
  assert.ok(m.view().includes(`played ${localDay("2026-09-21T18:00:00.000Z")}`), m.view());

  const raw = JSON.parse(m.ctx.localStorage.getItem("cp_playlists"));
  raw[0].last_played_at = "garbage";
  m.ctx.localStorage.setItem("cp_playlists", JSON.stringify(raw));
  m.ctx.renderPlaylists();
  assert.ok(!m.view().includes("Invalid Date"), m.view());
  assert.ok(!m.view().includes("played"), "no date, no 'played' clause");
  assert.ok(!/\.toLocaleDateString\(\)/.test(APP_SRC), "no bare toLocaleDateString() may remain in app.js");
});
