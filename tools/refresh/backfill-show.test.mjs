/* tools/refresh/backfill-show.mjs — the one-shot that gets a newly curated
   show's back catalogue into the nightly pipeline.
 *
 * WHAT THIS SUITE PINS, AND WHY EACH ONE MATTERS. Every test below names the
 * one-line mutation that kills it, per CLAUDE.md § "A green test is not
 * evidence until you have broken it". The failure mode this file exists to
 * prevent is the quiet one: a backfill that reports success while having
 * emitted nothing, or having emitted rows resolve.mjs can only drop.
 *
 * THE HARNESS IS DELIBERATELY NOT MORE FORGIVING THAN THE REAL THING. The
 * `<item>` fixtures below are the fast-xml-parser SHAPE scan.mjs sees
 * (`itunes:duration` as a bare key, `enclosure` as `@_`-prefixed attributes,
 * `guid` as either a string or an object with `#text`), not a convenience
 * object — five agents shipped green tests in this repo whose fake answered a
 * way the real thing cannot.
 *
 * The floor for this suite lives in test/suite-integrity.test.js.            */

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync as _readSelfFile } from "node:fs";
import {
  titleMatches, selectEpisodes, pendingRecord, resolveShows, parseArgs,
  normDuration, BackfillError, DEFAULT_NEWEST,
} from "./backfill-show.mjs";

const item = (over = {}) => ({
  title: "489: Natural Cider Production Seminar",
  guid: "guid-489",
  pubDate: "Wed, 04 Feb 2026 07:00:00 +0000",
  description: "<p>Natural cider is often <b>misunderstood</b>.</p>",
  "itunes:duration": "01:10:53",
  "itunes:explicit": "no",
  enclosure: { "@_url": "https://traffic.libsyn.com/ciderchat/489.mp3", "@_type": "audio/mpeg", "@_length": "42000000" },
  ...over,
});

const show = (over = {}) => ({
  show_id: "cider-chat",
  title: "Cider Chat",
  apple_collection_id: 1054230417,
  feed_url: "https://rss.libsyn.com/shows/73722/destinations/320706.xml",
  artwork_url: "https://example.test/art.jpg",
  taxonomy_node_ids: ["food/fermentation", "food/drinks"],
  ...over,
});

// ------------------------------------------------------------ title matching --

test("no --match selects everything, so the flag is opt-in", () => {
  // KILLED BY: `if (!needles) return true;` (dropping the length check), which
  // makes `--match` with an empty array select nothing and the run error out.
  assert.equal(titleMatches("anything", []), true);
  assert.equal(titleMatches("anything", undefined), true);
});

test("--match is a case-insensitive substring, because the operator is naming episodes not querying", () => {
  // KILLED BY: replacing `includes` with `===`, or dropping either toLowerCase.
  assert.equal(titleMatches("489: Natural Cider Production Seminar", ["natural cider"]), true);
  assert.equal(titleMatches("489: Natural Cider Production Seminar", ["NATURAL CIDER"]), true);
  assert.equal(titleMatches("489: Natural Cider Production Seminar", ["keeving"]), false);
});

test("a bare episode number matches, which a word-boundary matcher would refuse", () => {
  /* This is the reason the file does not import the search engine's `hitText`.
     `489` against "489: Natural Cider..." is the whole point of --match, and the
     shipped matcher's prefix guard exists to stop exactly this kind of match.
     KILLED BY: swapping `titleMatches` for a `\b`-anchored regex on the needle. */
  assert.equal(titleMatches("489: Natural Cider Production Seminar", ["489"]), true);
});

test("--match is OR across needles, so one call can name several episodes", () => {
  // KILLED BY: `needles.every(...)` instead of `.some(...)`.
  assert.equal(titleMatches("495: Cider Barrels Speak", ["489", "495", "497"]), true);
});

// ---------------------------------------------------------------- selection --

test("--newest caps the feed BEFORE --match filters, so a match cannot reach past the iTunes window", () => {
  /* The ordering is load-bearing: resolve.mjs looks episodes up at limit=25, so a
     row from deeper than that resolves to no trackId and is dropped. Filtering
     first would emit it anyway and the operator would see a "successful" backfill
     whose episodes never arrive.
     KILLED BY: swapping the two lines so `filter` runs before `slice`. */
  const items = [item({ title: "recent" }), item({ title: "old" })];
  assert.deepEqual(selectEpisodes(items, { newest: 1, match: ["old"] }), []);
  assert.equal(selectEpisodes(items, { newest: 2, match: ["old"] }).length, 1);
});

test("--newest defaults to the iTunes lookup window rather than the whole feed", () => {
  /* Not a style preference: DEFAULT_NEWEST is 25 because resolve.mjs's lookup is
     limit=25. If this drifts up, every run past the window reports drops; if the
     lookup limit ever rises, this is the number to move with it.
     KILLED BY: changing DEFAULT_NEWEST to any other value. */
  assert.equal(DEFAULT_NEWEST, 25);
  const items = Array.from({ length: 40 }, (_, i) => item({ title: `ep ${i}` }));
  assert.equal(selectEpisodes(items).length, 25);
});

test("a non-integer or zero --newest is refused, not coerced", () => {
  // KILLED BY: deleting the guard, which makes `--newest 0` emit nothing and
  // `--newest abc` emit nothing, both reported as a successful run.
  for (const bad of [0, -1, 2.5, NaN]) {
    assert.throws(() => selectEpisodes([item()], { newest: bad }), /BAD_NEWEST|positive integer/);
  }
});

// ------------------------------------------------------------------- record --

test("the emitted record carries every field resolve.mjs reads", () => {
  /* resolve.mjs reads apple_collection_id, title, topics, show, show_id and the
     audio fields. A record missing one is dropped or lands half-built in
     discover.json, and merge.mjs would not notice.
     KILLED BY: deleting any single key from pendingRecord's returned object. */
  const { record } = pendingRecord(show(), item());
  for (const k of ["show", "show_id", "apple_collection_id", "artwork_url", "topics", "guid",
    "title", "release_date", "duration_min", "duration_sec", "audio_url", "audio_type",
    "audio_bytes", "description", "explicit_hint"]) {
    assert.ok(k in record, `pendingRecord dropped ${k}, which the scan.mjs shape carries`);
  }
});

test("topics come from the SHOW's taxonomy_node_ids, which is how a curated show labels its episodes", () => {
  /* resolve.mjs drops any episode whose topics do not resolve to a taxonomy node,
     so an empty topics array is a silent total failure of the run.
     KILLED BY: `topics: it.topics || []` (reading the item instead of the show). */
  const { record } = pendingRecord(show(), item());
  assert.deepEqual(record.topics, ["food/fermentation", "food/drinks"]);
  const { record: bare } = pendingRecord(show({ taxonomy_node_ids: undefined }), item());
  assert.deepEqual(bare.topics, []);
});

test("the description is de-tagged and truncated, because the agent reads it to author a hook", () => {
  // KILLED BY: dropping the `.replace(/<[^>]*>/g, " ")`, which leaks markup into
  // the hook-authoring input and from there into user-facing copy.
  const { record } = pendingRecord(show(), item());
  assert.ok(!/[<>]/.test(record.description), `markup survived: ${record.description}`);
  assert.match(record.description, /Natural cider is often misunderstood/);
  const long = pendingRecord(show(), item({ description: "x".repeat(900) })).record;
  assert.equal(long.description.length, 500);
});

test("an item with no guid, no title or an unparseable pubDate is reported, not emitted as a half-record", () => {
  /* scan.mjs skips these with `continue`; here they have to come back with a
     reason so the run can print them. A null-field record reaching resolve.mjs
     would dedup against nothing, because the trackId guard needs a title.
     KILLED BY: returning `{ record: {...}, reason }` unconditionally. */
  for (const [over, why] of [[{ guid: undefined, enclosure: undefined }, /guid/],
    [{ title: undefined }, /title/], [{ pubDate: "not a date" }, /pubDate/]]) {
    const out = pendingRecord(show(), item(over));
    assert.equal(out.record, null);
    assert.match(out.reason, why);
  }
});

test("guid is read from either the string form or the object form fast-xml-parser produces", () => {
  /* KILLED BY: `String(it.guid)` in place of `text(it.guid)`, which yields
     "[object Object]" for the `<guid isPermaLink="false">` form.
     NOT killed by removing a `typeof it.guid === "object" ? …` ternary around the
     call — which is how this test earned its keep: the first draft of the source
     copied that ternary out of scan.mjs, the mutation came back GREEN, and the
     ternary turned out to be dead code because `text()` already unwraps the
     object. The redundancy was deleted rather than the test. */
  assert.equal(pendingRecord(show(), item({ guid: "plain" })).record.guid, "plain");
  assert.equal(
    pendingRecord(show(), item({ guid: { "#text": "nested", "@_isPermaLink": "false" } })).record.guid,
    "nested"
  );
});

test("release_date is the feed's pubDate as an ISO day, not the run date", () => {
  /* A backfill of a 2026-02-04 episode that stamped today would make every
     back-catalogue item look brand new, and discoverSlice picks "the newest of
     the rest" per show off exactly this field.
     KILLED BY: `release_date: new Date().toISOString().slice(0, 10)`. */
  assert.equal(pendingRecord(show(), item()).record.release_date, "2026-02-04");
});

test("a tokened or non-audio enclosure is withheld with a reason rather than published", () => {
  /* Corner case #9: a tokened URL is a secret and must never reach a public data
     file. This path is enclosure.mjs's, and the test is here to prove the
     backfill actually routes through it instead of copying `@_url`.
     KILLED BY: `audio_url: it.enclosure?.["@_url"]` in place of audioFieldsFrom. */
  const tokened = item({ enclosure: { "@_url": "https://cdn.test/a.mp3?token=abc123", "@_type": "audio/mpeg" } });
  const out = pendingRecord(show(), tokened);
  assert.equal(out.record.audio_url, null);
  assert.ok(out.reason, "a withheld URL must come back with a reason so the run can log it");

  const video = item({ enclosure: { "@_url": "https://cdn.test/a.mp4", "@_type": "video/mp4" } });
  assert.equal(pendingRecord(show(), video).record.audio_url, null);
});

test("duration parses all three itunes:duration spellings", () => {
  // KILLED BY: deleting the `parts.length === 2` branch (mm:ss feeds read as null).
  assert.equal(normDuration("01:10:53"), 71);
  assert.equal(normDuration("23:20"), 23);
  assert.equal(normDuration("3600"), 60);
  assert.equal(normDuration("nonsense"), null);
  assert.equal(normDuration(null), null);
});

// ------------------------------------------------------------ show resolution --

test("an unknown or feedless show_id is a hard error, because a typo and an empty feed look identical", () => {
  /* This is the central refusal. `--show cider-chatt` producing zero episodes and
     exit 0 is the failure this script must never have: the operator believes the
     show had nothing to backfill.
     KILLED BY: `if (!s) continue;` in resolveShows. */
  const catalog = { shows: [show()] };
  const codeOf = (fn) => { try { fn(); return null; } catch (e) { return e.code ?? e.message; } };
  assert.equal(codeOf(() => resolveShows(catalog, ["cider-chatt"])), "NO_SUCH_SHOW");
  assert.equal(codeOf(() => resolveShows(catalog, [])), "NO_SHOW");
  assert.equal(codeOf(() => resolveShows({ shows: [show({ feed_url: null })] }, ["cider-chat"])), "NO_FEED");
  assert.equal(codeOf(() => resolveShows(catalog, ["cider-chat"])), null);
  assert.equal(resolveShows(catalog, ["cider-chat"]).length, 1);
  /* The code is what the CLI prints and what a caller can branch on, so it is what
     is asserted — `assert.throws(fn, /NO_SUCH_SHOW/)` matches the MESSAGE and
     passed vacuously here until it was run against a mutation. */
  assert.ok(new BackfillError("X", "y") instanceof Error);
  assert.equal(new BackfillError("X", "y").code, "X");
});

// -------------------------------------------------------------------- args --

test("--show accepts repetition and comma lists, and --match repeats", () => {
  // KILLED BY: `one("--show")` instead of `many("--show")`, which silently
  // backfills only the last show named on the command line.
  const a = parseArgs(["--show", "cider-chat,whiskycast", "--show", "bourbon-pursuit",
    "--match", "489", "--match", "495", "--newest", "60", "--dry-run"]);
  assert.deepEqual(a.shows, ["cider-chat", "whiskycast", "bourbon-pursuit"]);
  assert.deepEqual(a.match, ["489", "495"]);
  assert.equal(a.newest, 60);
  assert.equal(a.dryRun, true);
});

test("the default output path is NOT the nightly's fresh-pending.json, and the seen-guid state is never touched", () => {
  /* Two invariants that live in main() rather than in an exported function, so
     they are asserted against the source with comments and strings stripped —
     the prose above main() names both files deliberately, and a scan that
     matched the prose would pass while the code did the opposite.
     KILLED BY: changing main()'s default to data-local/fresh-pending.json (first
     assertion), and by adding any readFileSync/writeFileSync of
     refresh-state.json (second). Both mutations were run. */
  const code = codeOnly(readSelf());
  assert.match(code, /backfill-pending\.json/);
  assert.ok(
    !/fresh-pending/.test(code),
    "backfill-show must not default to the nightly scan's output file"
  );
  assert.ok(
    !/refresh-state/.test(code),
    "backfill-show must never read or write the nightly's seen-guid state — an episode " +
      "it has not merged must not be marked seen"
  );
});

function readSelf() {
  const url = new URL("./backfill-show.mjs", import.meta.url);
  return _readSelfFile(url, "utf8");
}

/** Source with block and line comments removed, so an assertion about the CODE
    cannot be satisfied by a sentence in a comment. */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}
