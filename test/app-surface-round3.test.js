/* Audit round 3, lane L2 (app surface): the small correctness fixes that have no
 * better-fitting suite. Each test names its finding id and the mutation that
 * turns it red.
 *
 * Harness: app.js runs in a node:vm context with a minimal fake DOM and a
 * CONTROLLED timer queue — `ctx.setTimeout` records instead of scheduling, so a
 * test fires exactly the timer it means to (and the 45 s boot deadline app.js
 * arms at load never holds the process open).
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8").replace(/\r\n/g, "\n");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");

function makeEl(tag = "div") {
  const listeners = new Map();
  const el = {
    tagName: String(tag).toUpperCase(),
    listeners,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const l = listeners.get(type) || [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
    dispatch(type, ev = {}) {
      for (const fn of [...(listeners.get(type) || [])]) fn({ type, preventDefault() {}, stopPropagation() {}, ...ev });
    },
    appendChild() {}, setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    style: { setProperty() {}, removeProperty() {} }, dataset: {}, children: [], hidden: false,
    innerHTML: "", textContent: "", className: "", isConnected: true,
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, blur() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 300, height: 600, bottom: 600, right: 300 }),
  };
  return el;
}

function loadApp() {
  const noop = () => {};
  const timers = new Map();
  let nextTimer = 0;
  const store = new Map();
  const win = makeEl("window");
  const doc = makeEl("document");
  const view = makeEl("main");
  /* Elements a test registers by selector, for code that looks them up. */
  const els = {};
  const ctx = {
    console: { log: noop, info: noop, warn: noop, error: noop, debug: noop },
    fetch: () => new Promise(() => {}),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      key: (i) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    },
    document: {
      body: makeEl("body"), documentElement: makeEl("html"), readyState: "complete",
      addEventListener: doc.addEventListener, removeEventListener: doc.removeEventListener, createElement: makeEl,
      querySelector: (sel) => (sel === "#view" ? view : els[sel] || null), querySelectorAll: () => [], getElementById: (id) => els["#" + id] || null,
    },
    navigator: { userAgent: "node", onLine: true },
    location: { hash: "#/", href: "https://example.test/", pathname: "/", search: "" },
    history: { replaceState: noop, pushState: noop, state: null },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, Intl, TextEncoder, AbortController,
    setTimeout: (fn, ms, ...args) => { nextTimer += 1; timers.set(nextTimer, { fn, ms, args }); return nextTimer; },
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: () => 0, clearInterval: noop,
    requestAnimationFrame: (fn) => { nextTimer += 1; timers.set(nextTimer, { fn, ms: 16, args: [0] }); return nextTimer; },
    cancelAnimationFrame: (id) => { timers.delete(id); },
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
    addEventListener: win.addEventListener,
    removeEventListener: win.removeEventListener,
    dispatchEvent: noop,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  return {
    ctx,
    win,
    doc,
    view,
    els,
    timers,
    store,
    run: (code) => vm.runInContext(code, ctx),
    /** Fire (and remove) every pending timer armed for exactly `ms`. */
    fire(ms) {
      for (const [id, t] of [...timers]) if (t.ms === ms) { timers.delete(id); t.fn(...t.args); }
    },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

/* ---------- app-2-14: playerBridge cleans up after a timed-out wait ---------- */

test("app-2-14: a timed-out playerBridge wait removes its listener and its timer", async () => {
  /* On the broken-deploy path (the player module never published) each visit to
     #/forays, Library or a Try again called playerBridge(), which added a
     once-listener for an event that never fires and never removed it.
     MUTATION: drop the removeEventListener in finish() — the listener count is
     2, not 0. Drop the clearTimeout — the ready-path assertion sees a timer. */
  const m = loadApp();
  const wait = m.run("PLAYER_WAIT_MS");
  /* app.js's own boot code holds a listener of its own; count relative to it. */
  const ready = () => (m.win.listeners.get("forayplayer:ready") || []).length;
  const base = ready();
  const a = m.ctx.playerBridge();
  const b = m.ctx.playerBridge();
  assert.strictEqual(ready(), base + 2, "two waits in flight");
  m.fire(wait);
  assert.strictEqual(await a, null);
  assert.strictEqual(await b, null);
  assert.strictEqual(ready(), base, "no listener outlives its wait");

  /* The ready path: the event resolves the wait and its timer is cleared. */
  const c = m.ctx.playerBridge();
  m.ctx.ForayPlayer = { ready: true };
  m.win.dispatch("forayplayer:ready");
  assert.deepStrictEqual(await c, { ready: true });
  assert.ok(![...m.timers.values()].some((t) => t.ms === wait), "the timeout is cleared once the player arrived");
});


/* ---------- app-2-15: no dead search helpers ---------------------------------- */

test("app-2-15: episodeDedupKey and showIndexFetchCount are gone from the code", () => {
  /* Both suggested behaviour that no longer existed: a single-key dedup nothing
     called (everything uses episodeDedupKeys) and a "test-visible" fetch counter
     no test read. Comments are stripped first — prose that records the deletion
     is not a code path.
     MUTATION: restore either declaration — red. */
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:/])\/\/[^\n]*/g, "$1");
  assert.ok(!/\bepisodeDedupKey\b/.test(code), "episodeDedupKey has no caller");
  assert.ok(!/\bshowIndexFetchCount\b/.test(code), "showIndexFetchCount has no reader");
  assert.match(code, /function episodeDedupKeys\(/, "the live helper stays");
});

/* ---------- app-1-16 / app-2-13: every route link encodes its id ------------- */

const ODD_ID = "a/b%c#d";
const ODD_HASH = "a%2Fb%25c%23d";

test("app-1-16: show links go through showRouteHash, and the prefetch parses the route", () => {
  /* parseShowRoute decodes the segment, so a producer that only HTML-escaped
     misrouted any id carrying `%`, `/` or `#`; and bindShowPrefetch decoded the
     whole tail after `#/show/`, so a `/q/<query>` anchor prefetched a
     nonexistent id.
     MUTATION: restore `href="#/show/${esc(id)}"` in showNameLink — red. Restore
     the `href.slice` in bindShowPrefetch — the prefetch assertion goes red. */
  const m = loadApp();
  const html = m.ctx.showNameLink("Odd Show", ODD_ID);
  assert.ok(html.includes(`href="#/show/${ODD_HASH}"`), html);
  assert.strictEqual(m.ctx.parseShowRoute(`#/show/${ODD_HASH}`).id, ODD_ID, "and it routes back to the same id");

  m.run(`state.catalog = { shows: [{ show_id: ${JSON.stringify(ODD_ID)}, title: "Odd Show" }] };`);
  const cites = m.ctx.citesHtml({ cites: [{ kind: "tape", show: "Odd Show", show_id: ODD_ID }] });
  assert.ok(cites.includes(`href="#/show/${ODD_HASH}"`), `a Foray's Sources list encodes too: ${cites}`);

  const prefetched = [];
  m.ctx.prefetchShowEpisodes = (id) => prefetched.push(id);
  m.ctx.bindShowPrefetch();
  const a = { getAttribute: (k) => (k === "href" ? "#/show/lex/q/neuralink" : null) };
  m.doc.dispatch("pointerdown", { target: { closest: () => a } });
  assert.deepStrictEqual(prefetched, ["lex"], "the /q/ tail is the show page's search, not part of the id");

  /* And no producer is left that only HTML-escapes a show id into a route
     (forayCreditHtml and the credit upgrade included). */
  assert.ok(!/#\/show\/\$\{esc\(/.test(SRC), "every `#/show/` link goes through showRouteHash or encodeURIComponent");
});

test("app-2-13: Foray links go through forayRouteHash, which encodes", () => {
  /* forayCardV2Html, the show page's Forays rows and the Forays page rows built
     `#/foray/${esc(id)}` while Library and the router encode: an id carrying
     `/`, `#`, `?` or `%` broke routing from those surfaces only.
     MUTATION: restore `href="#/foray/${esc(foray.id)}"` in forayCardV2Html — the
     card assertion goes red; restore any other producer — the source guard does. */
  const m = loadApp();
  assert.strictEqual(m.ctx.forayRouteHash(ODD_ID), `#/foray/${ODD_HASH}`);
  const card = m.ctx.forayCardV2Html({ id: ODD_ID, title: "Odd Foray", topic: "science" });
  assert.ok(card.includes(`href="#/foray/${ODD_HASH}"`), card.slice(0, 300));
  assert.ok(!/#\/foray\/\$\{esc\(/.test(SRC), "every `#/foray/` link goes through forayRouteHash");
});

/* ---------- app-2-9: the vouched-for set does not depend on the locale -------- */

test("app-2-9: 'Shows 4a vouches for' is the same set whatever the device locale collates", () => {
  /* The base order used a bare localeCompare, which collates in the device's
     locale (lt/et/cs/sk sort the committed ids differently), so the seeded
     shuffle picked different shows there. Simulated here by a context whose
     localeCompare collates in REVERSE: the answer must not move.
     MUTATION: restore `.sort((a, b) => a.show_id.localeCompare(b.show_id))` — red. */
  const m = loadApp();
  const ids = ["zeta", "alpha", "chi", "hotel", "yankee", "bravo", "cz-show", "ch-show", "delta", "echo"];
  m.run(`state.catalog = { shows: ${JSON.stringify(ids.map((id) => ({ show_id: id, title: id, editorial_note: "yes" })))} };`);
  const now = new Date("2026-09-25T12:00:00Z");
  const plain = Array.from(m.ctx.showsWeVouchFor(4, now), (s) => s.show_id);
  m.run("String.prototype.localeCompare = function (b) { const a = String(this); return a < b ? 1 : a > b ? -1 : 0; };");
  const reversed = Array.from(m.ctx.showsWeVouchFor(4, now), (s) => s.show_id);
  assert.deepStrictEqual(reversed, plain, "a locale's collation must not change the day's picks");
  const codepoint = ids.slice().sort();
  const expected = Array.from(m.ctx.seededShuffle(codepoint.map((id) => ({ show_id: id })), m.ctx.dayOfYearSeed(now)).slice(0, 4), (s) => s.show_id);
  assert.deepStrictEqual(plain, expected, "and the base order is plain codepoint order");
});

/* ---------- app-2-8: a URL ending in a balanced ')' keeps it ------------------ */

test("app-2-8: the notes linkifier keeps a balanced closing paren and still drops a sentence's", () => {
  /* The pattern excludes a trailing `)` so `(see https://x.test/a)` does not eat
     the sentence's paren — which also cut Wikipedia-style links:
     …/wiki/Mercury_(planet) linked to …/wiki/Mercury_(planet.
     MUTATION: delete the `while (src[…] === ")" …)` extension — red. */
  const m = loadApp();
  const links = (text) => Array.from(m.ctx.episodeDescriptionTokens(text), (t) => ({ ...t })).filter((t) => t.kind === "link").map((t) => t.text);
  const tokens = (text) => Array.from(m.ctx.episodeDescriptionTokens(text), (t) => t.text);
  assert.deepStrictEqual(links("see https://en.wikipedia.org/wiki/Mercury_(planet) now"), ["https://en.wikipedia.org/wiki/Mercury_(planet)"]);
  assert.deepStrictEqual(links("see https://en.wikipedia.org/wiki/Mercury_(planet)."), ["https://en.wikipedia.org/wiki/Mercury_(planet)"], "a full stop after it is still the sentence's");
  assert.deepStrictEqual(links("(see https://x.test/a)"), ["https://x.test/a"], "an unbalanced paren is the sentence's");
  assert.deepStrictEqual(tokens("(see https://x.test/a)"), ["(see ", "https://x.test/a", ")"], "and it stays in the text, nothing lost");
  assert.deepStrictEqual(tokens("(https://w.test/F_(x)) 1:02"), ["(", "https://w.test/F_(x)", ") ", "1:02"], "only the balanced one is taken back, and scanning resumes after it");
});

/* ---------- app-2-7: the notes' timestamp guard reads duration_sec ------------ */

test("app-2-7: a chapter stamp in an episode's last half-minute is a control, not dead text", () => {
  /* The guard was `duration_min * 60`, and every producer ROUNDS the minutes:
     3569 s -> 59 min -> a 3540 s guard, so "59:10 Outro" (3550 s) rendered as
     plain text. rowProgress already preferred duration_sec; both now share one
     helper.
     MUTATION: restore `item.duration_min ? item.duration_min * 60 : null` in
     episodeDescriptionSectionHtml — red. */
  const m = loadApp();
  const item = { id: "e", description: "59:10 Outro", duration_sec: 3569, duration_min: 59 };
  const html = m.ctx.episodeDescriptionSectionHtml(item);
  assert.match(html, /data-ts="3550"/, `the stamp is a seek control: ${html}`);
  const past = m.ctx.episodeDescriptionSectionHtml({ ...item, description: "59:40 Nothing" });
  assert.doesNotMatch(past, /data-ts=/, "a stamp past the real end is still plain text");
  /* Minutes only: rounded, so the guard allows the rounding's half-minute. */
  const minsOnly = m.ctx.episodeDescriptionSectionHtml({ id: "e", description: "59:20 Outro", duration_min: 59 });
  assert.match(minsOnly, /data-ts="3560"/);
  assert.strictEqual(m.ctx.itemDurationSec({ duration_sec: 3569, duration_min: 59 }), 3569, "duration_sec first");
  assert.strictEqual(m.ctx.itemDurationSec({ duration_min: 59 }), 3540);
  assert.strictEqual(m.ctx.itemDurationSec({}), null);
});

/* ---------- app-2-6: changing or clearing a thumbs vote undoes its nudge ------ */

test("app-2-6: up, clear, up leaves one nudge, not three; up -> a non-subject down undoes the up", () => {
  /* setFeedback applied +0.08 on every up and nothing on a clear, so up, clear,
     up ratcheted a topic to 1.0; changing up to down with a non-subject reason
     left the +0.08 in place.
     MUTATION: drop the `undo` term (apply only the new vote's nudge) — red. */
  const m = loadApp();
  m.run(`state.interests = { "science": 0.5 };`);
  const entry = { segment_id: "seg-1", topic: "science", item_id: "ep" };
  const interest = () => m.run(`state.interests["science"]`);
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);
  m.ctx.setFeedback(entry, "up");
  near(interest(), 0.58, "an up nudges once");
  m.ctx.setFeedback(entry, null);
  near(interest(), 0.5, "clearing it takes the nudge back");
  m.ctx.setFeedback(entry, "up");
  m.ctx.setFeedback(entry, null);
  m.ctx.setFeedback(entry, "up");
  near(interest(), 0.58, "up, clear, up, clear, up is ONE up");
  m.ctx.setFeedback(entry, "down", { reasons: ["Bad audio quality"] });
  near(interest(), 0.5, "a down about the audio undoes the up and moves nothing else");
  m.ctx.setFeedback(entry, "down", { reasons: ["Not my subject"] });
  near(interest(), 0.42, "a subject down moves the subject");
  m.ctx.setFeedback(entry, "up");
  near(interest(), 0.58, "and flipping it to up undoes the down first");
});

test("app-2-6 (sweep): a changed or withdrawn vote is logged with the vote it replaces, and reaches the server as 'cleared'", () => {
  /* The client-side nudge was fixed in the lane, but the event log still saw
     only the ups: a clear logged nothing, so up, clear, up reached the learning
     job as three ups (backend interestLearning.ts undoes `replaces` now).
     MUTATION: drop `|| replaces` from the logEvent guard -> no 'cleared' row,
     red. Drop `replaces` from the logged payload -> red. Drop the `replaces`
     spread in toEventRow -> the server row carries nothing to undo, red.
     Let toEventRow send a 'cleared' row with no `replaces` -> red. */
  const m = loadApp();
  m.run(`state.interests = { "science": 0.5 }; globalThis.__log = []; logEvent = (type, payload) => __log.push({ type, payload });`);
  const entry = { segment_id: "seg-9", topic: "science", item_id: "ep" };
  const logged = () => JSON.parse(m.run(`JSON.stringify(__log)`)).map((e) => e.payload);
  m.ctx.setFeedback(entry, "up");
  m.ctx.setFeedback(entry, null);
  m.ctx.setFeedback(entry, "up");
  m.ctx.setFeedback(entry, "down", { reasons: ["Not my subject"] });
  const rows = logged();
  assert.deepStrictEqual(rows.map((p) => [p.direction, p.replaces && p.replaces.direction]), [
    ["up", null], ["cleared", "up"], ["up", null], ["down", "up"],
  ]);
  assert.deepStrictEqual(rows[1].reasons, [], "a withdrawal carries no reasons of its own");

  const toRow = (payload) => JSON.parse(JSON.stringify(m.ctx.toEventRow({ type: "thumbs", ts: "2026-09-25T00:00:00Z", payload }, "u1")));
  const cleared = toRow(rows[1]);
  assert.strictEqual(cleared.type, "thumbs");
  assert.deepStrictEqual([cleared.payload.direction, cleared.payload.node_id, cleared.payload.replaces], ["cleared", "science", { direction: "up", reasons: [] }]);
  assert.deepStrictEqual(toRow(rows[3]).payload.replaces, { direction: "up", reasons: [] }, "a changed vote names the one it replaced");
  assert.strictEqual(toRow(rows[0]).payload.replaces, undefined, "a first vote has nothing to replace");
  assert.strictEqual(m.ctx.toEventRow({ type: "thumbs", ts: "t", payload: { direction: "cleared", node_id: "science" } }, "u1"), null,
    "a withdrawal that does not say what it withdrew is not sent");
});

/* ---------- app-2-10: a panel drag captures its pointer ----------------------- */

test("app-2-10: panel drag-to-dismiss captures the pointer, and a lost capture ends the drag", () => {
  /* With a mouse there is no implicit capture: a release off the panel never
     reached it, so `drag`/`pointer` stayed set, the panel stayed displaced, and
     every later pointerdown was ignored.
     MUTATION: drop the setPointerCapture call — red. Drop the
     lostpointercapture listener — the second press is ignored, red. */
  const m = loadApp();
  const panel = makeEl("section");
  panel.classList.add("fy-panel");
  const captured = [];
  panel.setPointerCapture = (id) => captured.push(id);
  m.ctx.ForayPlayer = {
    sheetDrag: {
      start: () => ({ y: 0 }), move: (d) => d, offset: () => 40,
      end: () => ({ dismiss: false }), claimsTouch: () => true,
    },
  };
  m.ctx.bindPanelDrag({ panel, requestClose() {} });
  const target = { closest: () => null };
  panel.dispatch("pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientY: 10, timeStamp: 1, target });
  assert.deepStrictEqual(captured, [1], "the press captures its pointer");
  panel.dispatch("pointermove", { pointerId: 1, clientY: 60, timeStamp: 2 });
  assert.ok(panel.classList.contains("fy-panel-dragging"), "dragging");
  panel.dispatch("lostpointercapture", { pointerId: 1 });
  assert.ok(!panel.classList.contains("fy-panel-dragging"), "a lost capture springs the panel back");
  panel.dispatch("pointerdown", { pointerId: 2, pointerType: "mouse", button: 0, clientY: 10, timeStamp: 3, target });
  assert.deepStrictEqual(captured, [1, 2], "and the next press is not ignored");
});

/* ---------- app-2-1: Home's Jump back in never thins a rich entry ------------- */

test("app-2-1: lastEpisodeCard seeds the player's pointer only when the index has nothing richer", () => {
  /* The pointer carries id/title/show/artwork/audio/duration only. Home calls
     lastEpisodeCard() on every render, and it snapshotted the pointer over the
     episode's full pool/show-page entry, so the episode page lost its notes,
     chapters, date and topics for the session (fullPool is memoised and never
     re-seeds).
     MUTATION: restore the unguarded `snapshot(r.id, r)` — red. */
  const m = loadApp();
  const pointer = { id: "ep-1", title: "Ep One", show: "Show", audio_url: "https://cdn.test/1.mp3", duration_sec: 600, percent: 40, label: "6 min left", updated_at: "2026-09-25T00:00:00Z" };
  m.ctx.ForayPlayer = { lastEpisodeCard: () => ({ ...pointer }) };
  m.run(`state.itemIndex["ep-1"] = { id: "ep-1", title: "Ep One", show: "Show", audio_url: "https://cdn.test/1.mp3", description: "Full notes", topics: ["science"], release_date: "2026-09-01", chapters: [{ t: 0 }] };`);
  const card = m.ctx.lastEpisodeCard();
  assert.strictEqual(card.id, "ep-1");
  const kept = m.run(`state.itemIndex["ep-1"]`);
  assert.strictEqual(kept.description, "Full notes", "the rich entry survives Home's render");
  assert.deepStrictEqual(Array.from(kept.topics), ["science"]);
  /* With nothing in the index the pointer is still seeded, so the card can play. */
  m.run(`delete state.itemIndex["ep-1"];`);
  m.ctx.lastEpisodeCard();
  assert.strictEqual(m.run(`state.itemIndex["ep-1"].audio_url`), "https://cdn.test/1.mp3");
});

/* ---------- app-2-12: Home computes each rail's picks once per render --------- */

test("app-2-12: renderHomeV2 computes every rail's picks once, for the button and the rails alike", () => {
  /* homePlayHtml -> homePlayTarget -> homePlayRails computed every rail, and then
     jumpBackInV2Html, foraysForYouHtml and playlistsForYouHtml computed each one
     again — generatedPlaylists' full-pool scan and sort included.
     MUTATION: call homePlayHtml() / the rail renderers without `picks` in
     renderHomeV2 — the counts go to 2, red. */
  const m = loadApp();
  const calls = { jbi: 0, forays: 0, playlists: 0 };
  m.ctx.jumpBackInEntries = () => { calls.jbi += 1; return []; };
  m.ctx.foraysForYouPicks = () => { calls.forays += 1; return null; };
  m.ctx.playlistsForYouPicks = () => { calls.playlists += 1; return { own: [], generated: [] }; };
  for (const name of ["homeGreeting", "testTrackNoticeHtml", "suggestedHtml"]) m.ctx[name] = () => "";
  for (const name of ["offerHomeOnboarding", "sizeProgressBars", "bindPickLogging", "bindStars", "bindUpNext", "bindPlay", "bindHomePlay", "buildCards"]) m.ctx[name] = () => {};
  m.run("state.cardSlots = [];");
  m.ctx.renderHomeV2();
  assert.deepStrictEqual(calls, { jbi: 1, forays: 1, playlists: 1 }, "each rail's picks are computed once per render");
});

/* ---------- app-1-15: a retried catalogue repaints only the page that asked --- */

test("app-1-15: retryCatalog keeps the catalogue but repaints only if the asking page is still on screen", async () => {
  /* The listener taps Try again, then goes to Home or a show page before the
     bounded fetch answers; the retry re-rendered whatever was current and moved
     focus to its heading.
     MUTATION: drop the route check (`if (currentHash() !== askedFrom) return;`) — red.
     Round-3 review (L2): the check was the render epoch, which a SAME-page
     repaint during the fetch also moves, so the failed page was never told the
     catalogue arrived. MUTATION: compare renderToken() again -- the same-page
     case below does not repaint. */
  const m = loadApp();
  let answer;
  m.ctx.fetchJson = () => new Promise((r) => { answer = r; });
  let painted = 0;
  m.ctx.renderCurrentPage = () => { painted += 1; };
  m.ctx.pageDidPaint = () => {};
  m.run('location.hash = "#/shows";');
  const left = m.ctx.retryCatalog();
  m.run('location.hash = "#/"; renderEpoch += 1;'); // the listener navigated
  answer({ shows: [{ show_id: "s" }] });
  await left;
  assert.strictEqual(painted, 0, "the page the listener moved to is not re-rendered");
  assert.strictEqual(m.run("state.catalog.shows[0].show_id"), "s", "but the catalogue is kept");

  m.run('location.hash = "#/shows";');
  const stayed = m.ctx.retryCatalog();
  answer({ shows: [] });
  await stayed;
  assert.strictEqual(painted, 1, "the page that asked, still on screen, repaints");

  const repainted = m.ctx.retryCatalog();
  m.run("renderEpoch += 1;"); // a same-page repaint (↻, a drawer switch) landed during the fetch
  answer({ shows: [{ show_id: "t" }] });
  await repainted;
  assert.strictEqual(painted, 2, "a same-page repaint does not stop the page learning the catalogue arrived");
});

/* ---------- app-2-5: the show index's body read is inside its deadline -------- */

test("app-2-5: a show index whose body stalls after the headers still ends, aborts, and lets a later focus retry", async () => {
  /* withDeadline wrapped only fetch(); headers inside the bound and then a
     stalled body left `await res.text()` pending, the `finally` never ran, and
     every later focus got the same hung promise for the session.
     MUTATION: move `await res.text()` back outside the deadlined attempt — the
     load never settles and the test times out/fails. */
  const m = loadApp();
  let signal = null;
  m.ctx.fetch = (url, opts) => { signal = opts && opts.signal; return Promise.resolve({ ok: true, text: () => new Promise(() => {}) }); };
  const p = m.ctx.loadShowIndex();
  await flush(); await flush();
  m.fire(m.run("DATA_DEADLINE_MS"));
  const settled = await Promise.race([p, new Promise((r) => setTimeout(() => r("still pending"), 200))]);
  assert.strictEqual(settled, null, "the load answers null like any failure");
  assert.ok(signal && signal.aborted, "and the stalled request is aborted");
  assert.strictEqual(m.run("showIndexPromise"), null, "so the next focus asks again");
});

/* ---------- data-integrity-8: cp_lastpick is retired and removed once --------- */

test("data-integrity-8: cp_lastpick is never written, and a stored copy is removed once storage settles", () => {
  /* Nothing has read cp_lastpick since the Continue banner was deleted, yet every
     pick stored a full untrimmed episode snapshot in it, in every tier.
     MUTATION: drop `storageSettleWaiters.push(forgetRetiredKeys)` — the stored
     copy survives, red. (The write itself is pinned in
     test/playlist-durability.test.js.) */
  const m = loadApp();
  m.store.set("cp_lastpick", JSON.stringify({ id: "old", hook: "x".repeat(4000) }));
  m.store.set("cp_saved", "{}");
  m.run("markStorageSettled();");
  assert.strictEqual(m.store.has("cp_lastpick"), false, "the retired key is removed after hydration");
  assert.strictEqual(m.store.get("cp_saved"), "{}", "and nothing else is touched");
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:/])\/\/[^\n]*/g, "$1");
  assert.ok(!/lsSet\(\s*["']cp_lastpick["']/.test(code), "no code path writes it");
  const policy = fs.readFileSync(path.join(ROOT, "docs/legal/privacy-policy.md"), "utf8");
  assert.match(policy, /\| `cp_lastpick` \| Retired/, "the privacy policy says it is retired");
});

/* ---------- app-2-11: the Search CTA's query reaches Create without a timer --- */

test("app-2-11: the Search CTA hands its query to Create through module state, consumed when the form is bound", () => {
  /* The CTA set location.hash and prefilled on a setTimeout(0), assuming the
     hashchange render ran first; the spec does not order those tasks, and when
     the timer won there was no #cr-form and the listener landed on an empty
     Create page.
     MUTATION: restore the setTimeout(0) hand-off — no pending query reaches
     renderCreate (and a 0 ms timer is armed), red. */
  const m = loadApp();
  const btn = makeEl("button");
  btn.dataset.createPlaylist = "tokamaks";
  const scope = makeEl("div");
  scope.querySelector = (sel) => (sel === "[data-create-playlist]" ? btn : null);
  m.ctx.bindCreatePlaylistCta(scope);
  btn.dispatch("click");
  assert.strictEqual(m.ctx.location.hash, "#/create", "it navigates");
  assert.ok(![...m.timers.values()].some((t) => t.ms === 0), "and arms no race-prone 0 ms timer");

  const submits = [];
  m.ctx.bindCreateFormSubmit = (e) => submits.push(e.currentTarget);
  m.els["#cr-form"] = makeEl("form");
  m.els["#cr-input"] = makeEl("input");
  m.ctx.renderCreate();
  assert.strictEqual(m.els["#cr-input"].value, "tokamaks", "the form is prefilled");
  assert.deepStrictEqual(submits, [m.els["#cr-form"]], "and submitted through the one creation path");
  m.ctx.renderCreate();
  assert.strictEqual(submits.length, 1, "consumed once: a later visit to Create does not rebuild it");
});

/* ---------- app-2-3: leaving Search supersedes its passes --------------------- */

test("app-2-3: the router supersedes the Search page's passes when it leaves #/shows, and only then", () => {
  /* showSearchToken moved only on a keystroke, a new Search mount or ✕, so a
     debounce tick pending when the listener tapped a show result still fired
     its fetches and index scan, and the playlist-CTA scan ran over the show
     page they had just opened.
     MUTATION: drop the supersedeShowSearch() call in renderCurrentPage — the
     tick survives and the token is unchanged, red. */
  const m = loadApp();
  for (const name of ["renderShow", "renderAllShows", "resetPageHeadScrollState", "renderTabBar", "pageDidPaint", "landOnPage", "restoreRails", "noteRoutePainted"]) m.ctx[name] = () => {};
  m.run("state.ready = true;");
  const arm = () => m.run("showSearchDebounceTimer = setTimeout(() => {}, SHOW_SEARCH_DEBOUNCE_MS); showSearchToken");

  m.ctx.location.hash = "#/shows/q/fridman";
  const stay = arm();
  m.ctx.renderCurrentPage();
  assert.strictEqual(m.run("showSearchToken"), stay, "a repaint of Search itself leaves its search alone");
  assert.ok(m.run("showSearchDebounceTimer"), "and its pending tick");

  m.ctx.location.hash = "#/show/lex-fridman-podcast";
  const before = m.run("showSearchToken");
  const tick = m.run("showSearchDebounceTimer");
  m.ctx.renderCurrentPage();
  assert.ok(m.run("showSearchToken") > before, "every in-flight pass is superseded");
  assert.strictEqual(m.run("showSearchDebounceTimer"), null, "the pending tick is cancelled");
  assert.ok(!m.timers.has(tick), "and its timer cleared");
});

test("app-2-3: the deferred playlist-CTA scan is skipped for a section no longer in the document", async () => {
  /* The belt to the router's supersede: the whenIdle callback checked only the
     token, so the 1.3-8 s relaxation scan ran for a detached container.
     MUTATION: drop the `container.isConnected === false` return — the scan
     runs, red. */
  const m = loadApp();
  const container = makeEl("section");
  m.els["#pl-search-results"] = container;
  m.ctx.playlists = () => [];
  m.ctx.generatedPlaylistCandidatesForQuery = () => [];
  m.ctx.searchDataSettled = () => Promise.resolve();
  let scans = 0;
  m.ctx.createPlaylistCtaHtml = () => { scans += 1; return ""; };
  const token = m.run("showSearchToken");
  const reported = [];
  m.ctx.renderPlaylistSearchResults("fridman", token, (ms) => reported.push(ms));
  container.isConnected = false; // the listener tapped a result: #view was replaced
  m.fire(0);
  await flush();
  assert.strictEqual(scans, 0, "no scan for a section nobody can see");
  assert.deepStrictEqual(reported, [null], "and the diagnostics entry is still closed");
});

/* ---------- app-3-1: Play after closing the bar resumes where the listener was  */

test("app-3-1: play, advance, close the bar, press Play: the Foray resumes from the stored position, not the render-time one", async () => {
  /* The resume point was read once at render (state.forayResume and the
     bindForayTransport closure). After playing on to 30:00 and closing the mini
     bar, the cold page read 0:00 (or the old 10:00), Play restarted there, and
     the player's next save overwrote the real position.
     MUTATIONS: have startOrResume read the bind-time `resume` again — red; drop
     the live->cold refreshForayResume() — red. */
  const m = loadApp();
  for (const sel of ["#fy-play", "#fy-next", "#fy-prev", "#fy-back", "#fy-fwd", "#fy-now", "#fy-strip", "#fy-list"]) m.els[sel] = makeEl("button");
  const at = makeEl("span");
  m.els["#fy-resume .fy-resume-at"] = at;
  const r = { id: "f1", title: "A Foray", playable: [{ id: "s1" }, { id: "s2" }, { id: "s3" }], totalSec: 3600, foray: {} };
  let stored = { elapsedSec: 600, index: 0, label: "50 min left" }; // "Jump back in at 10:00" at render
  const starts = [];
  const player = {
    forayResume: () => stored,
    fmtClock: (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`,
    playForay: async (_r, opts) => { starts.push(opts); return true; },
    forayToggle: async () => {},
    watchForay: () => {},
  };
  m.ctx.ForayPlayer = player;
  m.ctx.logEvent = () => {};
  m.run(`state.foray = ${JSON.stringify(r)}; state.forayResume = ${JSON.stringify(stored)};`);
  m.ctx.bindForayTransport(m.run("state.foray"), player, stored);

  /* Play on to 30:00: live ticks. The player saves as it goes. */
  m.ctx.paintForay({ forayId: "f1", index: 1, playing: true, running: true, elapsedSec: 1800 });
  stored = { elapsedSec: 1800, index: 1, label: "30 min left" };
  /* Close the mini bar: the player sends index -1. */
  m.ctx.paintForay({ forayId: "f1", index: -1, playing: false, running: false, elapsedSec: 0 });
  assert.strictEqual(m.run("state.forayResume.elapsedSec"), 1800, "the cold page holds the stored point");
  assert.strictEqual(at.textContent, "Jump back in at 30:00", "and the banner says so");

  m.els["#fy-play"].dispatch("click");
  await flush();
  assert.strictEqual(starts.length, 1);
  assert.strictEqual(starts[0].startElapsedSec, 1800, "Play resumes where the listener stopped");
});

/* ---------- app-2-2: the Shows search paints a page of rows, not thousands ---- */

test("app-2-2: the Shows list paints SHOW_RESULTS_PAINT_STEP rows at a time, and 'Show more shows' reveals the next step", () => {
  /* paintShowResults turned every match into markup — about 2,500 rows for 't'
     — and later passes re-rendered the whole list up to six times per query.
     MUTATION: paint `shows.map(showResultRow)` uncapped again — red. */
  const m = loadApp();
  const results = makeEl("div");
  const note = makeEl("p");
  const more = makeEl("button");
  results.querySelector = (sel) => (sel === "[data-sh-more]" && /data-sh-more/.test(results.innerHTML) ? more : null);
  m.els["#sh-results"] = results;
  m.els["#sh-note"] = note;
  const step = m.run("SHOW_RESULTS_PAINT_STEP");
  assert.ok(step >= 25 && step <= 100, "a screenful or two");
  const rows = Array.from({ length: step * 2 + 30 }, (_, i) => ({ show_id: `s${i}`, title: `Show ${i}` }));
  const token = m.run("showSearchToken");
  const count = () => (results.innerHTML.match(/class="show-result"/g) || []).length;
  m.ctx.paintShowResults("s", rows, token);
  assert.strictEqual(count(), step, "the first step is painted");
  assert.match(results.innerHTML, /data-sh-more/, "with a way to the rest");
  assert.strictEqual(m.run("showSearchPainted.rows.length"), rows.length, "while the painted record keeps every row for dedupe");
  more.dispatch("click");
  assert.strictEqual(count(), step * 2, "Show more reveals the next step");
  /* A later pass appending beneath keeps what was revealed. */
  m.ctx.paintShowResults("s", rows.concat([{ show_id: "late", title: "Late Row" }]), token);
  assert.strictEqual(count(), step * 2);
  more.dispatch("click");
  assert.strictEqual(count(), rows.length + 1, "and the last step paints the remainder");
  assert.doesNotMatch(results.innerHTML, /data-sh-more/, "with no button left once everything is shown");
  /* A new query starts again from one step. */
  m.ctx.paintShowResults("sh", rows, token);
  assert.strictEqual(count(), step);
});

test("round-3 review (L2): 'Show more shows' puts focus on the first row it revealed, not on <body>", () => {
  /* The repaint rewrote results.innerHTML, destroying the focused button, and
     nothing moved focus. MUTATION: drop the focus() after the repaint -- no
     row is focused. */
  const m = loadApp();
  const results = makeEl("div");
  const note = makeEl("p");
  const more = makeEl("button");
  let focused = null;
  results.querySelector = (sel) => (sel === "[data-sh-more]" && /data-sh-more/.test(results.innerHTML) ? more : null);
  results.querySelectorAll = (sel) => {
    if (sel !== ".show-result") return [];
    const n = (results.innerHTML.match(/class="show-result"/g) || []).length;
    return Array.from({ length: n }, (_, i) => ({ focus() { focused = i; } }));
  };
  m.els["#sh-results"] = results;
  m.els["#sh-note"] = note;
  const step = m.run("SHOW_RESULTS_PAINT_STEP");
  const rows = Array.from({ length: step * 2 + 5 }, (_, i) => ({ show_id: `s${i}`, title: `Show ${i}` }));
  m.ctx.paintShowResults("s", rows, m.run("showSearchToken"));
  more.dispatch("click");
  assert.strictEqual(focused, step, "the first newly revealed row has focus");
});

test("app-2-2: each local pass hands over at most SHOW_PASS_LIMIT rows, and the row caches are bounded", () => {
  /* prefixSearchShows/scanShowIndex were called with no limit (0 = all), and
     breadthShowCache/shardShowCache gained an entry for every row every query
     received, for the session.
     MUTATION: drop the limit from localShowMatches' prefix call — red; drop the
     eviction loop in cacheShowRow — red. */
  const m = loadApp();
  const limit = m.run("SHOW_PASS_LIMIT");
  const lines = Array.from({ length: limit * 3 }, (_, i) => `Tea Time ${String(i).padStart(4, "0")}\t${9000 + i}\t${i + 1}\t0`);
  m.run(`showIndex = SearchEngine.parseShowIndex(${JSON.stringify(lines.join("\n") + "\n")}); state.catalog = { shows: [] };`);
  assert.strictEqual(m.run("showIndex.rows.length"), limit * 3, "fixture: the index holds three limits' worth of prefix hits");
  assert.strictEqual(m.ctx.localShowMatches("tea").length, limit, "the prefix pass hands over its best SHOW_PASS_LIMIT");

  const max = m.run("SHOW_ROW_CACHE_MAX");
  for (let i = 0; i < max + 25; i += 1) m.ctx.cacheShowRow("breadth", { show_id: String(100000 + i), title: `B${i}` });
  assert.strictEqual(Object.keys(m.run("state.breadthShowCache")).length, max, "never more than the bound");
  assert.ok(!m.run('state.breadthShowCache["100000"]'), "the oldest go first, even for integer-like Apple ids");
  assert.ok(m.run(`state.breadthShowCache["${100000 + max + 24}"]`), "the newest stay");
});

test("round-3 review (L2): played to the end and closed, the Foray page drops 'Jump back in' for 'Played'", async () => {
  /* refreshForayResume nulled state.forayResume when the point read finished
     but left the rendered "Jump back in at 10:00" banner up over a 0:00 clock
     and a Play from the top. MUTATION: drop the finished branch -- the banner
     still says "Jump back in at 10:00". */
  const m = loadApp();
  for (const sel of ["#fy-play", "#fy-next", "#fy-prev", "#fy-back", "#fy-fwd", "#fy-now", "#fy-strip", "#fy-list"]) m.els[sel] = makeEl("button");
  const banner = makeEl("div");
  let removed = 0;
  const at = makeEl("span");
  at.remove = () => { removed += 1; };
  const left = makeEl("span");
  const restart = makeEl("button");
  at.textContent = "Jump back in at 10:00";
  left.textContent = "50 min left";
  restart.textContent = "Start over";
  m.els["#fy-resume"] = banner;
  m.els["#fy-resume .fy-resume-at"] = at;
  m.els["#fy-resume .fy-resume-left"] = left;
  m.els["#fy-restart"] = restart;
  const r = { id: "f1", title: "A Foray", playable: [{ id: "s1" }, { id: "s2" }], totalSec: 3600, foray: {} };
  let stored = { elapsedSec: 600, index: 0, label: "50 min left" };
  const player = {
    forayResume: () => stored,
    fmtClock: (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`,
    playForay: async () => true, forayToggle: async () => {}, watchForay: () => {},
  };
  m.ctx.ForayPlayer = player;
  m.ctx.logEvent = () => {};
  m.run(`state.foray = ${JSON.stringify(r)}; state.forayResume = ${JSON.stringify(stored)};`);
  m.ctx.bindForayTransport(m.run("state.foray"), player, stored);
  m.ctx.paintForay({ forayId: "f1", index: 1, playing: true, running: true, elapsedSec: 3500 });
  stored = { elapsedSec: 3600, index: 1, label: "Played", finished: true };   // it ran to the end
  m.ctx.paintForay({ forayId: "f1", index: -1, playing: false, running: false, elapsedSec: 0 });
  assert.strictEqual(m.run("state.forayResume"), null, "premise: no resume point");
  assert.strictEqual(removed, 1, "the 'Jump back in at' line is gone");
  assert.ok(banner.classList.contains("fy-played"), "the banner is the Played variant");
  assert.strictEqual(left.textContent, "Played");
  assert.strictEqual(restart.textContent, "Play again");
});
