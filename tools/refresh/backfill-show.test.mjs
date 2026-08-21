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
  feedItems, buildPayload, resolveOutPath,
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
  /* "old" is outside a 1-item window, so it is unreachable — and unreachable is
     NO_MATCH, not an empty array. Widen the window by one and it resolves. */
  assert.throws(() => selectEpisodes(items, { newest: 1, match: ["old"] }), (e) => e.code === "NO_MATCH");
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

test("the emitted record carries every field resolve.mjs reads, WITH ITS VALUE", () => {
  /* resolve.mjs reads apple_collection_id, title, topics, show, show_id and the
     audio fields. A record missing one is dropped or lands half-built in
     discover.json, and merge.mjs would not notice.

     THE FIRST VERSION OF THIS TEST WAS VACUOUS AND IT IS WORTH SAYING HOW, because
     it is this file's own header failing in the file it heads. It asserted `k in
     record` and nothing else. `"show" in { show: undefined }` is TRUE, so every one
     of these eight mutations passed it: `show: undefined`, `show_id: undefined`,
     `apple_collection_id: undefined`, `artwork_url: undefined`,
     `duration_min: undefined`, `duration_sec: undefined`, `audio_bytes: undefined`,
     `explicit_hint: undefined`. And `JSON.stringify` DROPS undefined-valued keys, so
     the field the test certified as present is genuinely absent from the written
     file — the exact outcome the comment above claims to prevent.
     The `show_id` one has a downstream consequence worth naming: resolve.mjs builds
     ids as `showPrefix.get(ep.show) || ep.show_id`, and `showPrefix` is keyed by show
     TITLE, which a newly curated show has no entry for. With `show_id` undefined
     every id becomes `undefined--489-natural-cider-...` and merge.mjs writes it.

     KILLED BY: setting any one of those fifteen keys to `undefined` — all fifteen
     were run against this version and all fifteen fail. Also killed by deleting a
     key outright, which the old version did catch. */
  const { record } = pendingRecord(show(), item());
  const expected = {
    show: "Cider Chat",
    show_id: "cider-chat",
    apple_collection_id: 1054230417,
    artwork_url: "https://example.test/art.jpg",
    topics: ["food/fermentation", "food/drinks"],
    guid: "guid-489",
    title: "489: Natural Cider Production Seminar",
    release_date: "2026-02-04",
    duration_min: 71,
    duration_sec: 4253,
    audio_url: "https://traffic.libsyn.com/ciderchat/489.mp3",
    audio_type: "audio/mpeg",
    audio_bytes: 42000000,
    /* The space before the full stop is real: `<b>misunderstood</b>.` becomes
       "misunderstood ." once the tags are replaced by spaces. Pinned as it is
       rather than tidied, because scan.mjs produces the same string and the two
       shapes must not drift. */
    description: "Natural cider is often misunderstood .",
    explicit_hint: false,
  };
  /* STRICT, because `deepEqual` is loose enough to be under-fitted here: `"71" == 71`
     and `0 == false`, so `duration_min: String(...)`, `apple_collection_id: String(...)`,
     `audio_bytes: String(...)` and `explicit_hint: ... ? 1 : 0` all survived the loose
     version. All four were run against this one and all four fail. Types matter to
     resolve.mjs: `apple_collection_id` goes into a URL and a Map key. */
  assert.deepStrictEqual(record, expected);
  /* And the key set is exactly this — a record that grew a field resolve.mjs does
     not read is a divergence from scan.mjs's shape, which is the one thing this
     script is not allowed to invent. */
  assert.deepEqual(Object.keys(record).sort(), Object.keys(expected).sort());
  /* The serialisation round-trip, because `in` is not what the pipeline sees.
     An undefined value survives `in` and does not survive the file. */
  assert.deepStrictEqual(JSON.parse(JSON.stringify(record)), expected);
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

test("an unknown flag is refused rather than ignored", () => {
  /* `--newst 60` used to parse as "--newest 25, say nothing" and `--show --dry-run`
     used to look up a show literally called "--dry-run". Both report a successful
     run against input the operator did not give — the same class as NO_MATCH.
     KILLED BY: deleting the validation loop at the top of parseArgs. Run. */
  const codeOf = (argv) => { try { parseArgs(argv); return null; } catch (e) { return e.code; } };
  assert.equal(codeOf(["--newst", "60"]), "BAD_FLAG");
  assert.equal(codeOf(["--show", "cider-chat", "--dryrun"]), "BAD_FLAG");
  assert.equal(codeOf(["--show", "--dry-run"]), "MISSING_VALUE");
  assert.equal(codeOf(["--show", "cider-chat", "--newest"]), "MISSING_VALUE");
  /* and the valid line still parses */
  assert.equal(codeOf(["--show", "cider-chat", "--match", "489", "--dry-run"]), null);
  /* `--out` REACHES the parse result. Pinned because this branch promoted `--out`
     from a convenience to the documented way of not colliding with a nightly scan
     (see the header's invariant #2), and nothing tested that the flag arrived.
     KILLED BY: dropping "--out" from VALUE_FLAGS (it then throws BAD_FLAG), or
     `out: null` in the returned object. Both run. */
  const a = parseArgs(["--show", "cider-chat", "--out", "mine.json"]);
  assert.equal(a.out, "mine.json");
  assert.equal(parseArgs(["--show", "cider-chat"]).out, null);
});

// ------------------------------------------------------- the run's invariants --

test("zero matches is an ERROR, not an empty run — the reason this script exists", () => {
  /* THE HEADLINE INVARIANT, and until this test it was unpinned: the guard lived
     inside main(), which is not exported and which no test calls, so deleting it
     outright left the whole suite green. A typo'd --match must never look like a
     feed with nothing to backfill.
     KILLED BY: deleting the `chosen.length === 0` throw in selectEpisodes, or
     softening it to `return []`. Both run. */
  const items = [item({ title: "489: Natural Cider" }), item({ title: "495: Barrels" })];
  const e = (() => { try { selectEpisodes(items, { match: ["keeving"], showId: "cider-chat" }); return null; } catch (x) { return x; } })();
  assert.ok(e, "0 matches returned normally — an empty backfill is indistinguishable from a satisfied one");
  assert.equal(e.code, "NO_MATCH");
  assert.match(e.message, /cider-chat/, "the message must name the show, or the operator cannot tell which --show was the typo");
  /* A match that DOES hit is not an error, or the guard is just broken. */
  assert.equal(selectEpisodes(items, { match: ["489"] }).length, 1);
});

test("a feed with no items is an error, and a one-item feed is one item not one character", () => {
  /* fast-xml-parser collapses a single `<item>` to an object, so `items.length`
     on it is undefined and a naive guard would read a one-episode feed as empty.
     The other half: an HTML error page served with 200 parses to a document with
     no rss.channel.item, and that must be an error rather than a zero-episode run.
     KILLED BY: dropping the `Array.isArray` normalisation (first assertion), and
     by deleting the length check (second). Both run. */
  assert.equal(feedItems({ rss: { channel: { item: item() } } }, "cider-chat").length, 1);
  assert.equal(feedItems({ rss: { channel: { item: [item(), item()] } } }).length, 2);
  for (const dead of [{}, { rss: {} }, { rss: { channel: {} } }, { html: { body: "404" } },
    /* THE ONE THAT CAUGHT A REAL REGRESSION. fast-xml-parser renders `<item/>` and
       `<item></item>` as the empty string, so a `??` here (which this file briefly
       had) wraps it to `[""]`, passes the guard, emits nothing and exits 0. */
    { rss: { channel: { item: "" } } }]) {
    const e = (() => { try { feedItems(dead, "cider-chat"); return null; } catch (x) { return x; } })();
    assert.equal(e?.code, "EMPTY_FEED", `${JSON.stringify(dead)} was read as a successful zero-episode run`);
  }
});

test("the payload's episode list is keyed `episodes`, which is the key resolve.mjs reads", () => {
  /* A payload keyed `items` parses, validates as JSON, and resolves nothing —
     resolve.mjs reads `.episodes` and would iterate undefined. This lived in
     main() as an object literal and was unreachable by any test.
     KILLED BY: renaming `episodes` to `items` in buildPayload. Run — and note
     the run is what proved the old arrangement untestable, because the same
     rename inside main() left the suite green. */
  const p = buildPayload({
    shows: [show()], match: ["489"], newest: 25, episodes: [{ guid: "g" }],
    now: new Date("2026-08-19T16:05:00.000Z"),
  });
  assert.deepEqual(Object.keys(p).sort(), ["episodes", "generated_at", "match", "newest", "shows", "source"]);
  assert.deepEqual(p.episodes, [{ guid: "g" }]);
  assert.deepEqual(p.shows, ["cider-chat"], "shows must be ids, not the whole catalogue row");
  assert.equal(p.source, "backfill-show");
  assert.equal(p.generated_at, "2026-08-19T16:05:00.000Z");
});

test("--out beats PENDING_PATH beats the default, and PENDING_PATH is the hole in invariant #2", () => {
  /* The file header promises a backfill "cannot clobber a nightly scan that is
     mid-flight". That is true of the DEFAULT and false of the env var, which is
     the same PENDING_PATH scan.mjs writes and resolve.mjs reads — and the README's
     hand-off recipe has you exporting it. Asserted rather than narrated so the
     limitation cannot quietly stop being documented.
     KILLED BY: reordering the three branches in resolveOutPath. Run. */
  const root = "/repo", cwd = "/work";
  assert.match(resolveOutPath({ root, cwd }).replace(/\\/g, "/"), /\/repo\/data-local\/backfill-pending\.json$/);
  assert.match(
    resolveOutPath({ env: { PENDING_PATH: "data-local/fresh-pending.json" }, root, cwd }).replace(/\\/g, "/"),
    /\/work\/data-local\/fresh-pending\.json$/,
    "PENDING_PATH is honoured, so a shared shell CAN aim a backfill at the nightly's file"
  );
  assert.match(
    resolveOutPath({ out: "mine.json", env: { PENDING_PATH: "data-local/fresh-pending.json" }, root, cwd }).replace(/\\/g, "/"),
    /\/work\/mine\.json$/,
    "--out must win over the env var, because it is the only way to be sure of the target"
  );
});

test("release_date is the UTC day, which SHIFTS a non-UTC feed forward — pinned deliberately", () => {
  /* THE KIND CLAUDE.md POINT 5 ASKS FOR: this cannot fail on today's shipped data
     and is written anyway. `pub.toISOString()` is UTC, so a feed declaring a
     negative offset late in its local day gets tomorrow's date. Spirits &
     Distilling declares -0700/-0600 and 17 of its 47 items shift by a day; none of
     the four this PR curated does, because they all publish at 13:00-16:00 local.
     This matches scan.mjs, so it is the pipeline's behaviour and not a bug this
     script introduced — but the ONLY offset in the fixture above is +0000, the one
     value where the shift cannot appear, and that is how it stayed invisible.
     Change the behaviour and this test tells you what you changed.

     KILLED BY: switching to a local-time formatter — BUT ONLY OFF UTC. In UTC the two
     formatters are the same function, so no fixture can tell them apart and this
     mutation survives in CI. Run it as `TZ=America/Los_Angeles node --test
     tools/refresh/backfill-show.test.mjs`, where it fails three assertions. Said out
     loud because "I ran the mutation" is worth nothing if the reader's machine cannot
     reproduce it. */
  const utc = pendingRecord(show(), item({ pubDate: "Wed, 04 Feb 2026 07:00:00 +0000" }));
  assert.equal(utc.record.release_date, "2026-02-04");
  const shifted = pendingRecord(show(), item({ pubDate: "Tue, 03 Feb 2026 19:00:00 -0700" }));
  assert.equal(shifted.record.release_date, "2026-02-04", "02:00Z on the 4th — the publisher said the 3rd");
  const gmt = pendingRecord(show(), item({ pubDate: "Wed, 04 Feb 2026 07:00:00 GMT" }));
  assert.equal(gmt.record.release_date, "2026-02-04", "Basic Brewing Radio spells its offset GMT");
  const nulls = pendingRecord(show(), item({ pubDate: "Wed, 04 Feb 2026 07:00:00 -0000" }));
  assert.equal(nulls.record.release_date, "2026-02-04", "I'll Drink to That and Bourbon Pursuit spell it -0000");
});

test("the default output path is NOT the nightly's fresh-pending.json, and the seen-guid state is never touched", () => {
  /* Two invariants that live in main() rather than in an exported function, so
     they are asserted against the source with comments and strings stripped —
     the prose above main() names both files deliberately, and a scan that
     matched the prose would pass while the code did the opposite.

     THIS TEST ASSERTS ON SOURCE TEXT AND THAT IS A WEAKER THING THAN IT LOOKS:
     it pins what the file SAYS, not what a run does. It is kept because the
     refresh-state half genuinely has no other handle, and the output-path half is
     now also covered executably by the resolveOutPath test above — which is the
     one to trust.
     KILLED BY: changing the default to data-local/fresh-pending.json (first
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
