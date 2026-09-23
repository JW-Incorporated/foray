/* "Jump back in" holds Forays, PODCASTS and PLAYLISTS — founder, 2026-09-18:
 * "Only forays are in the jump back in section, podcasts and playlists should
 * be there too."
 *
 * WHY ONLY FORAYS WERE THERE, which is the part worth pinning: the episode card
 * was not missing from the code, it was unreachable. It came from
 * `currentContinue()` reading `cp_lastpick`, and that key is written only when
 * `state.poolIds.has(id)` — the discover pool. The founder listens to episodes
 * opened from a show page, which are never in the pool, so nothing was ever
 * recorded and the card could never render. It was additionally gated on
 * `duration_min > commute + 5`, and it recorded what was TAPPED rather than what
 * was PLAYED.
 *
 * So the tests that matter here are not "an episode card can render" — the old
 * code could do that on paper too. They are: the rail reads the durable playback
 * pointer rather than `cp_lastpick`, an episode from outside the pool appears,
 * and the three kinds are ordered by recency rather than by kind.
 *
 * Harness: the node:vm DOM stub of test/episode-page.test.js.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
/* CRLF NORMALISED ON READ. This repo is developed on Windows against a
   Unix-normalised tree, so whole-tree line-ending churn is the expected state of
   the working copy (CLAUDE.md § "Never discard uncommitted work"). The
   multi-line regexes below match a bare LF and would silently stop matching — not
   fail loudly, just find nothing — the first time a checkout landed with CRLF.
   Caught exactly that way: a `git stash` round trip rewrote the endings and this
   suite went red without a line of source changing. */
const SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8").replace(/\r\n/g, "\n");

function loadApp({ lastEpisodeCard = null } = {}) {
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
      querySelector: () => makeEl(), querySelectorAll: () => [],
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
  /* The bridge, faked at exactly the surface app.js uses. `forayResumeList` is
     what `forayResumeRows` walks; `lastEpisodeCard` is the new one. */
  ctx.ForayPlayer = {
    forayResumeList: () => ctx._forayRows || [],
    lastEpisodeCard: () => lastEpisodeCard,
  };
  vm.createContext(ctx);
  process.on("unhandledRejection", noop);
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  ctx._state = (code) => vm.runInContext(code, ctx);
  return ctx;
}

const EPISODE_CARD = {
  id: "lex-353", title: "Dennis Whyte: Nuclear Fusion", show: "Lex Fridman Podcast",
  audio_url: "https://example.com/a.mp3",
  updated_at: "2026-09-18T09:00:00.000Z", position_sec: 1800, percent: 25, label: "90 min left",
};

/* ---------- the episode card comes from the playback pointer ------------- */

test("the rail reads the durable playback pointer, not cp_lastpick", () => {
  /* THE WHOLE REPORT, in one assertion. `cp_lastpick` is untouched here — the
     fake sets no pool, no history and no lastpick — and the episode still
     appears, because it now comes from what actually played.
     MUTATION: point `lastEpisodeCard()` back at `currentContinue()`. This goes
     red, because nothing has been picked from the pool. */
  const app = loadApp({ lastEpisodeCard: EPISODE_CARD });
  const entries = app.jumpBackInEntries();
  const ep = entries.find((e) => e.kind === "episode");
  assert.ok(ep, "an episode that actually played must appear");
  assert.strictEqual(ep.id, "lex-353");
  assert.strictEqual(app.lsGet("cp_lastpick", null), null, "and it must not have needed cp_lastpick");
});

test("an episode from outside the discover pool appears — the founder's own case", () => {
  /* A Lex episode reached from the show list is not in `state.poolIds`, which
     is precisely why the old card could never render for it.
     MUTATION: gate `lastEpisodeCard` on `state.poolIds.has(id)`. */
  const app = loadApp({ lastEpisodeCard: EPISODE_CARD });
  assert.strictEqual(app._state("state.poolIds.size"), 0, "sanity: the pool is empty in this fixture");
  assert.ok(app.jumpBackInEntries().some((e) => e.kind === "episode"));
});

test("a short episode appears too — there is no duration gate any more", () => {
  /* `currentContinue` refused anything at or under commute+5 minutes, so a
     35-minute episode on a 27-minute commute was silently ineligible.
     MUTATION: re-add `if (duration_min <= commute + 5) return null`. */
  const app = loadApp({ lastEpisodeCard: { ...EPISODE_CARD, duration_min: 5 } });
  assert.ok(app.jumpBackInEntries().some((e) => e.kind === "episode"));
});

test("no pointer means no episode card, and the rail still renders the rest", () => {
  const app = loadApp({ lastEpisodeCard: null });
  app._state(`state.playlists = null;`);
  assert.strictEqual(app.jumpBackInEntries().filter((e) => e.kind === "episode").length, 0);
});

test("a bridge that throws costs the card, not the page", () => {
  /* Home must paint even if the player module is broken or absent. */
  const app = loadApp();
  app._state(`window.ForayPlayer.lastEpisodeCard = () => { throw new Error("boom"); };`);
  assert.doesNotThrow(() => app.jumpBackInEntries());
  assert.strictEqual(app.jumpBackInEntries().filter((e) => e.kind === "episode").length, 0);
});

/* ---------- playlists ---------------------------------------------------- */

test("a played playlist appears", () => {
  /* `last_played_at` has been stamped since #558 and two other surfaces already
     sort by it — playlists were simply never offered here.
     MUTATION: drop the playlist loop from jumpBackInEntries. */
  const app = loadApp();
  app.lsSet("cp_playlists", [
    { id: "pl-1", title: "Fusion week", parts: [], last_played_at: "2026-09-18T08:00:00.000Z" },
  ]);
  const pl = app.jumpBackInEntries().find((e) => e.kind === "playlist");
  assert.ok(pl, "a playlist that has been played must appear");
  assert.strictEqual(pl.id, "pl-1");
});

test("a playlist that was BUILT but never played does not appear", () => {
  /* It is not something you are jumping BACK into; it has its own page.
     MUTATION: change the filter to `p.last_played_at || p.created`. */
  const app = loadApp();
  app.lsSet("cp_playlists", [
    { id: "pl-2", title: "Never played", parts: [], created: "2026-09-18T08:00:00.000Z", last_played_at: null },
  ]);
  assert.strictEqual(app.jumpBackInEntries().filter((e) => e.kind === "playlist").length, 0);
});

/* ---------- ordering ----------------------------------------------------- */

test("the three kinds are ordered by recency, not grouped by kind", () => {
  /* A rail that always put Forays first would reproduce the complaint the day a
     Foray is the oldest thing on it.
     MUTATION: sort by kind, or drop the sort. RUN: failed as named. */
  const app = loadApp({ lastEpisodeCard: { ...EPISODE_CARD, updated_at: "2026-09-18T09:00:00.000Z" } });
  app._state(`_forayRows = [{ foray_id: "f-1", id: "f-1", title: "A Foray", updated_at: "2026-09-18T07:00:00.000Z", percent: 10, label: "20 min left", drift: "exact", finished: false }];`);
  app.lsSet("cp_playlists", [
    { id: "pl-1", title: "Middle", parts: [], last_played_at: "2026-09-18T08:00:00.000Z" },
  ]);
  const kinds = app.jumpBackInEntries().map((e) => e.kind).join(",");
  /* The Foray row is dropped by `forayResumeRows`'s own visibility filter (it
     keeps only Forays that are also listed on the page), which this fixture does
     not stock — so what is pinned here is the ORDER of the two that survive:
     the 09:00 episode ahead of the 08:00 playlist. */
  assert.strictEqual(kinds, "episode,playlist", "newest first, across kinds");
});

test("an entry with no timestamp sorts last, never first", () => {
  /* An unknown time must not out-rank a known one — the conservative direction.
     MUTATION: `String(a.at || "")` -> a default of "9999", which makes an
     unknown time win. */
  const app = loadApp({ lastEpisodeCard: { ...EPISODE_CARD, updated_at: null } });
  app.lsSet("cp_playlists", [
    { id: "pl-1", title: "Known time", parts: [], last_played_at: "2026-09-18T08:00:00.000Z" },
  ]);
  assert.strictEqual(app.jumpBackInEntries().map((e) => e.kind).join(","), "playlist,episode");
});

test("the rail is capped", () => {
  const app = loadApp({ lastEpisodeCard: EPISODE_CARD });
  app.lsSet("cp_playlists", Array.from({ length: 12 }, (_, i) => ({
    id: `pl-${i}`, title: `P${i}`, parts: [], last_played_at: `2026-09-1${i % 9}T08:00:00.000Z`,
  })));
  assert.ok(app.jumpBackInEntries().length <= 6);
  assert.strictEqual(app.jumpBackInEntries(2).length, 2);
});

/* ---------- the markup --------------------------------------------------- */

test("each kind links to its own route, with the scheme fixed in code", () => {
  /* Not a style point: test/app-security.test.js forbids interpolating a whole
     href, and `safeUrl` would turn every one of these in-app routes into "#".
     MUTATION: build one `c.href` string and interpolate it — the security suite
     goes red, and so does this. */
  const app = loadApp();
  const out = [
    app.jumpBackInCardHtml({ kind: "foray", id: "f 1", title: "F" }),
    app.jumpBackInCardHtml({ kind: "playlist", id: "pl-1", title: "P" }),
    app.jumpBackInCardHtml({ kind: "episode", id: "ep-1", title: "E" }),
  ].join("");
  assert.match(out, /href="#\/foray\/f%201"/, "an id with a space must be encoded, not broken");
  assert.match(out, /href="#\/playlist\/pl-1"/);
  assert.match(out, /href="#\/episode\/ep-1"/);
});

test("only the episode card carries the pick-logging attributes", () => {
  /* `bindPickLogging` reads `data-ep` as an episode id; a Foray or a playlist id
     there would log a pick for something that is not an episode.
     MUTATION: emit `ev` for every kind. */
  const app = loadApp();
  assert.ok(app.jumpBackInCardHtml({ kind: "episode", id: "ep-1", title: "E" }).includes('data-ev="picked"'));
  assert.ok(!app.jumpBackInCardHtml({ kind: "foray", id: "f-1", title: "F" }).includes("data-ev"));
  assert.ok(!app.jumpBackInCardHtml({ kind: "playlist", id: "pl-1", title: "P" }).includes("data-ev"));
});

test("a title is escaped like any other untrusted text", () => {
  const out = app0().jumpBackInCardHtml({ kind: "playlist", id: "pl-1", title: '<img src=x onerror=1>' });
  assert.ok(!out.includes("<img"));
  assert.match(out, /&lt;img/);
});

test("a card with no progress renders no bar rather than an empty one", () => {
  /* A zero-width bar reads as "no progress", which is a different claim from
     "we do not know". MUTATION: always emit the bar. */
  const out = app0().jumpBackInCardHtml({ kind: "playlist", id: "pl-1", title: "P" });
  assert.ok(!out.includes("fy-bar"));
  assert.ok(app0().jumpBackInCardHtml({ kind: "episode", id: "e", title: "E", percent: 40 }).includes("fy-bar"));
});

let _app0 = null;
function app0() { if (!_app0) _app0 = loadApp(); return _app0; }

/* ---------- episodes get a progress bar too (founder, 2026-09-21) --------- */

/* CR stripped with no escape sequences at all -- writing an escaped CRLF through
   a shell heredoc kept turning it into a real one and breaking the regex literal
   it lived in. `fromCharCode(13)` cannot be mangled by any quoting layer. */
const CLIENT_SRC = fs.readFileSync(path.join(ROOT, "player/client.js"), "utf8")
  .split(String.fromCharCode(13)).join("");

/* Slice a function body out by its delimiters rather than matching it with a
   regex. Same reason as above: a pattern needing an escaped newline is one more
   thing that can be silently mangled between here and the file. */
function block(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) return "";
  const j = src.indexOf(endMarker, i);
  return j < 0 ? src.slice(i) : src.slice(i, j + endMarker.length);
}

test("the episode card renders a bar at 0 %, not no bar", () => {
  /* `typeof c.percent === "number"` has to admit 0. A listener who has just
     started an episode has an honest 0 %, and the Foray cards draw theirs at
     every value -- the episode card matching them is the whole report.
     MUTATION: change the guard to `c.percent` (truthy) and 0 stops drawing a
     bar. This goes red. */
  const out = app0().jumpBackInCardHtml({ kind: "episode", id: "e", title: "E", percent: 0 });
  assert.match(out, /fy-bar-fill/, "a zero-percent bar is still a bar");
  assert.match(out, /data-pct="0"/);
});

test("lastEpisodeCard does not need the player booted to read a position", () => {
  /* THE REPORT. `lastEpisodeCard` runs while HOME renders, which happens in
     `route()` -- before `restoreNowPlayingRibbon` calls `ensureBooted`. It read
     the module-level `positions`, still null at that moment, so the offset
     defaulted to 0 and every episode card drew an empty bar.
     MUTATION: restore `positions ? positions.resumeOffset(...) : 0`. */
  const fn = block(CLIENT_SRC, "lastEpisodeCard() {", "},");
  assert.ok(fn, "lastEpisodeCard must still exist");
  assert.match(fn, /const store = positionReader\(\);/, "it goes through the reader");
  assert.ok(!/positions \? positions\.resumeOffset/.test(fn),
    "...and never falls back to 0 for want of a boot");
});

test("the reader prefers the booted store, and builds a thin one otherwise", () => {
  /* One definition of a position. The read-only instance is over the SAME durable
     store and the same `cp_pos:` rows, so the two cannot disagree -- and the
     booted one wins whenever it exists, so a live session never reads a staler
     copy of itself. */
  const fn = block(CLIENT_SRC, "function positionReader() {", "return positionsRead;");
  assert.match(fn, /if \(positions\) return positions;/, "the booted store wins");
  assert.match(fn, /new PositionStore\(\{ storage \}\)/, "...and the fallback shares its storage");
});

test("a duration the feed never gave us comes from the position store", () => {
  /* The second reason a bar went missing: `episodePercentDone` returns null when
     the duration is unknown, and `percent: undefined` renders no bar at all. Some
     feeds carry no `itunes:duration`. `PositionStore` records the duration it read
     off the media element beside every position, which is both more available and
     more accurate than a feed's own claim.
     MUTATION: drop the `stored?.duration` branch and an episode with no catalogue
     duration goes back to having no bar. */
  const fn = block(CLIENT_SRC, "lastEpisodeCard() {", "},");
  assert.match(fn, /const stored = store\.load\(rec\.id\);/);
  /* Audit round 2 (honesty-4): the stored, MEASURED duration is now the first
     choice, not the fallback, through the one rule every surface shares. */
  assert.match(fn, /const durationSec = knownEpisodeDurationSec\(rec\.id, rec\.duration_sec\);/, "the duration goes through the shared rule");
  const rule = block(CLIENT_SRC, "function measuredDurationSec(id) {", "}");
  assert.match(rule, /Number\(positionReader\(\)\.load\(id\)\?\.duration\)/, "which reads the stored duration");
  /* 2026-09-22: the percent now comes from `episodeProgress`, which owns the
     finished/in-progress reading every surface shares — same duration argument. */
  assert.match(fn, /episodeProgress\(\{ \.\.\.rec, duration_sec: durationSec \}/,
    "...and it is what the percent is computed from");
});

test("the card's bar and label read the RAW stored position, never the collapsed resume offset", () => {
  /* Audit 2026-09-22: `resumeOffset` collapses a finished episode to 0 — right
     for where play resumes, wrong for what the card says. Fed that 0, the card
     showed an empty bar and "180 min left" on a three-hour episode the listener
     had just finished, for thirty days. `position_sec` stays the offset (it is
     where the press starts); the progress reads `stored.seconds`.
     MUTATION: pass `offset` to episodeProgress instead of `stored?.seconds`.
     This goes red (and player/episode-progress.test.js pins what the raw
     reading then says: "Played"). */
  const fn = block(CLIENT_SRC, "lastEpisodeCard() {", "restoreLastEpisode() {");
  assert.match(fn, /episodeProgress\(\{ \.\.\.rec, duration_sec: durationSec \}, stored\?\.seconds \?\? null\)/);
  assert.match(fn, /position_sec: offset,/, "where play resumes is still the resume offset");
});
