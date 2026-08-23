/* Tests for the measured_clean re-validation. Run: node --test tools/segments/

   What this audit decides: whether 5,381 timed transcripts — every transcript
   this repo currently calls MEASURED clean, half the anchorable corpus — were
   admitted by an instrument that #323 proved can be lied to. The one outcome
   that must be impossible is a show reading "stable" because nobody actually
   asked it anything, which is the HEAD failure ADR-0008 was written around,
   restated in a new unit. Most of what follows exists to make that impossible. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EPISODES_PER_SHOW,
  answeredCells,
  gridIsInformative,
  cleanShows,
  showGridVerdict,
  slowDownSignals,
  verdictNote,
  summarise,
  parseArgs,
  judgeRow,
  rederive,
  SLOW_DOWN_STATUSES,
  GRID_CELLS,
  NOTE_PREFIX,
  NOTE_JOIN,
} from "./regrid-clean.mjs";

/** One grid cell, field-for-field as `probeGrid` emits it.

    `total: null` is the shape it produces for an origin that sent no readable
    length — never 0, which is the `Number(null)` trap it guards.

    STATUS FOLLOWS THE RANGE AXIS because it does in reality: a ranged cell is
    206 and an unranged one is 200 (144 of each across the committed run). A
    fixture that answered 206 to everything would be more forgiving than the
    thing it stands for, which is how five suites in this repo came to pin
    nothing. */
const cell = (total, over = {}) => {
  const ranged = over.ranged ?? true;
  return {
    identity: "probe",
    ranged,
    status: ranged ? 206 : 200,
    total,
    content_encoding: null,
    transfer_encoding: null,
    resolved_host: "cdn.example.org",
    ...over,
  };
};

/** A grid as `probeGrid` returns it: four cells, and the two derived fields.

    CELL ORDER MATCHES THE REAL EMISSION ORDER — probe/ranged, probe/unranged,
    client/ranged, client/unranged — because `probeGrid` loops identity outside
    range. `distinct_totals` and `varies_by_request` are RECOMPUTED here from
    the cells rather than passed in, so a fixture cannot assert a grid that
    `probeGrid` could not have produced. */
const grid = (totals, over = {}, tweak = (c) => c) => {
  const cells = totals
    .map((t, i) => cell(t, { identity: i < 2 ? "probe" : "client", ranged: i % 2 === 0 }))
    .map(tweak);
  const distinct = [...new Set(cells.map((c) => c.total).filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
  return {
    url: "https://cdn.example.org/e.mp3",
    checked_at: "2026-08-23T00:00:00.000Z",
    cells,
    distinct_totals: distinct,
    varies_by_request: distinct.length > 1,
    compressed: false,
    ...over,
  };
};

const showRow = (over = {}) => ({
  show_id: "1",
  title: "A Show",
  feed_host: "feeds.example.org",
  enclosure_host: "cdn.example.org",
  timed_transcripts: 10,
  verdict: "ad-free",
  disposition: "recover",
  n: 5,
  ...over,
});

/* --------------------------------------------------------------- the pool */

/* MUTATION: delete the `.sort()` in `cleanShows`, or flip its sign. Verified
   failing (both directions).

   The brief's instruction is "order the work by transcript count, so each
   request buys the most certainty", and it is not decoration: this pool is
   extremely skewed — one show carries 1,368 transcripts and five carry four or
   fewer — so a run stopped by a host asking us to slow down has either
   re-validated a quarter of the corpus or almost none of it, decided entirely
   by this line. Note this is deliberately NOT `measure-suspects.mjs`'s
   host-total ordering; see `cleanShows`' docstring for why the two scans want
   opposite orders. */
test("shows are audited biggest-asset-first", () => {
  const pool = cleanShows([
    { results: [showRow({ show_id: "small", timed_transcripts: 3 }), showRow({ show_id: "big", timed_transcripts: 1368 })] },
  ]);
  assert.deepEqual(pool.map((r) => r.show_id), ["big", "small"]);
});

/* MUTATION: drop the `disposition !== "recover"` guard. Verified failing.

   The pool IS the claim under audit. A run that also probed the `drop` and
   `unresolved` rows would spend requests re-asking questions that are already
   settled, and — worse — its summary would no longer reconcile with
   `measurement_coverage.measured_clean`, which is the number this whole exercise
   exists to either confirm or correct. */
test("only measured_clean shows are in the pool", () => {
  const pool = cleanShows([
    {
      results: [
        showRow({ show_id: "clean", disposition: "recover" }),
        showRow({ show_id: "dirty", disposition: "drop" }),
        showRow({ show_id: "dunno", disposition: "unresolved" }),
      ],
    },
  ]);
  assert.deepEqual(pool.map((r) => r.show_id), ["clean"]);
});

/* MUTATION: remove the `seen` set. Verified failing.

   The two measured files are two POOLS of one scan (suspects, then everyone
   else) and nothing structurally stops a show appearing in both. Counted twice
   it would report more transcripts audited than exist, which is the exact
   direction of error that makes an audit worthless. */
test("a show present in both measured files is audited once", () => {
  const pool = cleanShows([
    { results: [showRow({ show_id: "dup", timed_transcripts: 100 })] },
    { results: [showRow({ show_id: "dup", timed_transcripts: 100 })] },
  ]);
  assert.equal(pool.length, 1);
  assert.equal(pool.reduce((n, r) => n + r.timed_transcripts, 0), 100);
});

/* ------------------------------------------------- what counts as an answer */

/* MUTATION: `answeredCells` filtering on `c.total !== undefined` instead of
   `Number.isFinite`. Verified failing.

   `probeGrid` already refuses to turn a missing `Content-Length` into `total: 0`
   — the `Number(null) === 0` trap, which would manufacture a second length out
   of a missing header and condemn an innocent show. This is the same guard
   pointed the other way: a null cell must not be counted toward the AGREEMENT
   that lets a show read stable either. Both directions of that trap have now
   been paid for once each. */
test("a cell that reported no length is not an answer", () => {
  assert.equal(answeredCells(grid([100, null, 100, null])).length, 2);
  assert.equal(answeredCells(grid([null, null, null, null])).length, 0);
});

/* MUTATION: `gridIsInformative` returning `answered.length >= 1`, `>= 2`, or
   the range-axis-only rule `answered.some(c => c.ranged) && answered.some(c =>
   !c.ranged)`. All three verified failing.

   THIS IS THE TEST THIS FILE EXISTS FOR, and it has now been wrong twice, both
   times in the forgiving direction, which is why the rule is the whole grid.

   Four refused requests produce zero totals, an empty `distinct_totals` and
   `varies_by_request: false` — a row byte-for-byte indistinguishable from a
   file that answered four times identically. Filing that as "stable" would be
   ADR-0008's own cautionary tale repeated: "the first version of this scan used
   HEAD, reported 18 of 18 shows byte-stable, and was completely wrong." */
test("a grid nobody answered is not evidence of stability", () => {
  assert.equal(gridIsInformative(grid([null, null, null, null])), false);
  assert.equal(gridIsInformative(grid([100, null, null, null])), false, "one answer has nothing to agree with");
  assert.equal(gridIsInformative(grid([100, 100, 100, 100])), true, "all four answered is the instrument");
});

/* MUTATION: `answered.length >= 2`. Verified failing — and this mutant is the
   code that actually shipped into the first pass over the real pool.

   THE SHAPE IS MEASURED, NOT IMAGINED. `podcasts.beehiiv.com` answers an
   unranged request CHUNKED, with no `Content-Length`, so both its unranged
   cells report nothing and the two survivors are both ranged. That is two
   answers that agree, and under a bare count-of-two it read `stable` — for a
   show whose grid never once compared a ranged request against an unranged
   one. */
test("two answers on the same axis are not the comparison", () => {
  /* index 0/2 ranged, 1/3 unranged — beehiiv exactly: both ranged cells
     answered 206, both unranged replied 200 chunked with no length. */
  const beehiiv = grid([100, null, 100, null], {}, (c) =>
    c.ranged ? c : { ...c, transfer_encoding: "chunked" });
  assert.deepEqual(
    beehiiv.cells.map((c) => [c.ranged, c.status, c.total, c.transfer_encoding]),
    [[true, 206, 100, null], [false, 200, null, "chunked"], [true, 206, 100, null], [false, 200, null, "chunked"]],
    "the fixture is the real beehiiv shape, statuses and all",
  );
  assert.equal(answeredCells(beehiiv).length, 2, "two cells did answer");
  assert.equal(beehiiv.varies_by_request, false, "and they agreed");
  assert.equal(gridIsInformative(beehiiv), false, "and it still proves nothing about the range axis");
  assert.equal(showGridVerdict([beehiiv]).status, "inconclusive");
});

/* MUTATION: the range-axis-only rule, `answered.some((c) => c.ranged) &&
   answered.some((c) => !c.ranged)`. Verified failing.

   A REVIEWER CAUGHT THIS ONE AND IT IS THE SHARPEST OF THE THREE. That rule
   passes a grid whose entire CLIENT identity was refused — and `probe` ranged +
   `probe` unranged + `client` ranged are precisely the three cells flightcast
   answers HONESTLY. The one it lied in is the fourth. So the forgiving rule
   acquits, using only the cells a lying origin is happy to tell the truth in.

   `politeness.mjs` records a Buzzsprout edge answering 403 to one product token
   and 206 to another, reproducible both ways, so losing exactly one identity is
   a measured shape on this corpus. */
test("losing one identity is losing the cell flightcast lied in", () => {
  /* The real DOAC grid, with the one cell that differed removed. */
  const flightcastMinusTheLie = grid([67510022, 67510022, 67510022, null]);
  assert.equal(flightcastMinusTheLie.varies_by_request, false, "the three honest cells agree");
  assert.equal(gridIsInformative(flightcastMinusTheLie), false);
  assert.equal(showGridVerdict([flightcastMinusTheLie]).status, "inconclusive");

  /* And the whole client identity refused, which is the Buzzsprout shape. */
  assert.equal(gridIsInformative(grid([100, 100, null, null])), false);
});

/* A test that cannot fail on today's data, written deliberately (CLAUDE.md
   rule 5): the full DOAC grid must still condemn. If a future edit to
   `gridIsInformative` ever made the COMPLETE grid uninformative, every one of
   the tests above would still pass — they all assert `false`. */
test("the complete flightcast grid is informative, and condemns", () => {
  const doac = grid([67510022, 67510022, 67510022, 68884898]);
  assert.equal(gridIsInformative(doac), true);
  const v = showGridVerdict([doac]);
  assert.equal(v.status, "varies");
  assert.deepEqual(v.varying_totals, [67510022, 68884898]);
});

/* --------------------------------------------------------------- the verdict */

/* MUTATION: `status = varying.length ? "varies" : "stable"` — i.e. delete the
   `inconclusive` branch. Verified failing. */
test("a show whose every request was refused is inconclusive, never stable", () => {
  const v = showGridVerdict([grid([null, null, null, null]), grid([null, null, null, null])]);
  assert.equal(v.status, "inconclusive");
  assert.equal(v.varies_by_request, false);
  assert.equal(v.episodes_informative, 0);
});

/* MUTATION: also `showGridVerdict([])` — a show whose feed would not load, or
   which published no episode with a timed transcript, probes nothing at all and
   must not fall through to "stable" on an empty array. `informative.length &&`
   is the clause that stops it; deleting it leaves `0 === 0` true. Verified
   failing. */
test("a show that was never probed is inconclusive", () => {
  assert.equal(showGridVerdict([]).status, "inconclusive");
  assert.equal(showGridVerdict(null).status, "inconclusive");
});

/* MUTATION: `informative.length > 0` instead of `informative.length ===
   list.length`. Verified failing.

   THE ASYMMETRY IS THE POINT and it is the same one `varyingSamples` runs on:
   evidence of a mechanism running is proof and needs no corroboration, while
   the absence of it is a sample size. A show where two of three grids were
   refused has a sample of one dressed up as a sample of three. */
test("stability requires every probed episode to have answered", () => {
  const v = showGridVerdict([grid([100, 100, 100, 100]), grid([null, null, null, null])]);
  assert.equal(v.status, "inconclusive");
  assert.equal(v.episodes_informative, 1);
  assert.equal(v.episodes_probed, 2);
});

/* MUTATION: require `varying.length === list.length`, or a majority. Verified
   failing.

   #319 measured insertion running "in discrete ~30s slots on SOME episodes and
   not others" — two Spreaker shows came back `ad-free` while each had an
   episode carrying the same 481,071-byte creative. One episode served two
   lengths for one URL is one observation of the mechanism, and one is enough,
   exactly as `insertedSamples` already condemns a show on a single episode. */
test("one varying episode out of three condemns the show", () => {
  const v = showGridVerdict([
    grid([100, 100, 100, 100]),
    grid([100, 100, 100, 200]),
    grid([100, 100, 100, 100]),
  ]);
  assert.equal(v.status, "varies");
  assert.equal(v.varies_by_request, true);
  assert.equal(v.varying_episodes, 1);
  /* The two lengths of the ONE URL that disagreed — not the union across
     episodes, which for three different episodes is three different file sizes
     and says nothing. See `verdictNote`. */
  assert.deepEqual(v.varying_totals, [100, 200]);
});

/* MUTATION: build `varying_totals` from every grid rather than from the varying
   ones (`list.flatMap` instead of `varying.flatMap`). Verified failing.

   Three episodes of one show are three different files and therefore three
   different lengths; that is not the finding. The finding is two lengths for
   ONE url, and a note that printed the union would render an ordinary
   three-episode sample as though it were the flightcast discrepancy. */
test("the condemning number is one URL's two lengths, not three episodes' sizes", () => {
  const v = showGridVerdict([
    grid([500, 500, 500, 500]),
    grid([900, 900, 900, 900]),
    grid([100, 100, 100, 200]),
  ]);
  assert.deepEqual(v.varying_totals, [100, 200]);
  assert.deepEqual(v.totals_seen, [100, 200, 500, 900], "the union is still recorded, just not as the headline");
  assert.ok(verdictNote(v).includes("100 / 200"));
  assert.ok(!verdictNote(v).includes("900"), "an unrelated episode's size never appears in the finding");
});

/* ------------------------------------------------------------- what we say */

/* MUTATION: reword the `stable` note to "measured clean across the grid".
   Verified failing.

   #321 was burned by treating N identical answers as proof, and its correction
   — "consistent with a stitcher that did not vary inside a cache window" — is
   the standard this note is held to. The note is what a later reader quotes, so
   the caveat has to live IN it and not in a docstring beside it. This test
   cannot fail on today's data if the wording is left alone; it is here
   deliberately, to fail on the edit that quietly upgrades the claim. */
test("a stable grid never reads as a clean bill", () => {
  const note = verdictNote(showGridVerdict([grid([100, 100, 100, 100])]));
  assert.match(note, /does NOT re-certify/);
  assert.match(note, /cache window/);
  assert.ok(!/\bclean\b/i.test(note), "the word this note must never contain");
});

/* MUTATION: make `inconclusive` share the `stable` note. Verified failing. A row
   that learned nothing and a row that answered consistently must not be
   readable as the same thing in prose either — the boolean already renders them
   identically, which is why the status exists. */
test("an unspent probe says so", () => {
  const note = verdictNote(showGridVerdict([grid([null, null, null, null])]));
  assert.match(note, /inconclusive/);
  assert.match(note, /not a negative result/);
});

/* ---------------------------------------------------------- slowing down */

/* MUTATION: drop 503 from `SLOW_DOWN_STATUSES`, or compare `=== 429`. Verified
   failing.

   The standing record across every pass in this repo is zero 429s and this run
   must not be the one that breaks it quietly. 503 is here because an origin
   under load says the same thing with it, and pushing through a 503 is how a
   429 gets earned. */
test("an origin asking us to slow down is caught, and named", () => {
  const g = grid([100, 100, 100, 100]);
  g.cells[2] = cell(null, { status: 503, identity: "client", resolved_host: "edge.example.org" });
  const stop = slowDownSignals([g]);
  assert.equal(stop.length, 1);
  assert.equal(stop[0].status, 503);
  assert.equal(stop[0].host, "edge.example.org", "the host is named — a stop report that cannot say who is useless");
  assert.ok(SLOW_DOWN_STATUSES.has(429));
});

test("an ordinary refusal is not a throttle", () => {
  const g = grid([100, 100, null, null]);
  g.cells[2] = cell(null, { status: 403 });
  assert.deepEqual(slowDownSignals([g]), [], "403 is a refusal to serve us, not a request to slow down");
});

/* ------------------------------------------------------------- arithmetic */

/* MUTATION: count `inconclusive` rows inside `stable_across_the_grid`. Verified
   failing.

   This is `measurementSplit`'s lesson applied here: the three buckets must
   reconstruct the audited total, because the PR body quotes them and a summary
   that does not sum is how "we checked 5,381 transcripts" becomes true of a run
   that checked 4,000. */
test("every audited transcript lands in exactly one bucket", () => {
  const rows = [
    { timed_transcripts: 1000, grid: { status: "stable" } },
    { timed_transcripts: 300, grid: { status: "varies" } },
    { timed_transcripts: 81, grid: { status: "inconclusive" } },
  ];
  const s = summarise(rows);
  assert.deepEqual(s.audited, { shows: 3, timed_transcripts: 1381 });
  assert.deepEqual(s.varies_by_request, { shows: 1, timed_transcripts: 300 });
  assert.deepEqual(s.stable_across_the_grid, { shows: 1, timed_transcripts: 1000 });
  assert.deepEqual(s.inconclusive, { shows: 1, timed_transcripts: 81 });
  assert.deepEqual(s.unclassified, { shows: 0, timed_transcripts: 0 });
  assert.equal(
    s.varies_by_request.timed_transcripts + s.stable_across_the_grid.timed_transcripts +
      s.inconclusive.timed_transcripts + s.unclassified.timed_transcripts,
    s.audited.timed_transcripts,
  );
});

/* MUTATION: delete the `unclassified` bucket. Verified failing.

   A REVIEWER FOUND THIS AND THE FIRST VERSION OF THE TEST ABOVE DID NOT. Every
   row it fed carried a `grid`, so the sum identity it advertised held for a
   reason that had nothing to do with the code: the three real buckets read
   `r.grid.status`, so a row with no `grid` was counted in `audited` and in
   nothing else and the buckets silently stopped summing. The PR body quotes
   this block. A visible non-zero bucket is a bug report; a total that quietly
   fails to add up is a wrong number nobody notices. */
test("a row carrying no verdict is visible, not silently dropped", () => {
  const s = summarise([{ timed_transcripts: 100, grid: { status: "stable" } }, { timed_transcripts: 50 }]);
  assert.deepEqual(s.audited, { shows: 2, timed_transcripts: 150 });
  assert.deepEqual(s.unclassified, { shows: 1, timed_transcripts: 50 });
  assert.equal(
    s.varies_by_request.timed_transcripts + s.stable_across_the_grid.timed_transcripts +
      s.inconclusive.timed_transcripts + s.unclassified.timed_transcripts,
    s.audited.timed_transcripts,
    "the four buckets always reconstruct the audited total",
  );
});

/* MUTATION: default `--per-show` to 5, copying `MIN_SAMPLES_FOR_AD_FREE`.
   Verified failing.

   Pinned because the temptation to "match the other scan" is real and wrong:
   five is that scan's floor because it ADMITS shows and an acquittal needs one.
   This scan admits nothing, so draws four and five could only ever re-confirm a
   result that was never a clean bill — at 24 shows and four requests an episode
   that is 192 requests for nothing. See `EPISODES_PER_SHOW`. */
test("three episodes per show by default, overridable", () => {
  assert.equal(EPISODES_PER_SHOW, 3);
  assert.equal(parseArgs([]).perShow, 3);
  assert.equal(parseArgs(["--per-show", "1"]).perShow, 1);
  assert.equal(parseArgs(["--per-show", "banana"]).perShow, 3, "a junk value falls back rather than probing NaN episodes");
});

/* --------------------------------------------------- re-judging what we have */

/* MUTATION: have `judgeRow` return `{ ...row }` unchanged, i.e. copy instead of
   re-judge. Verified failing.

   THE GRIDS ARE THE EVIDENCE; THE VERDICT IS AN OPINION ABOUT THEM. This is
   `deriveRow`'s rule in `measure-suspects.mjs`, which a reviewer had to teach it
   after `--resume` was found copying prior rows verbatim — letting one file hold
   rows judged by two standards with nothing on them saying which.

   Not hypothetical here. The committed artifact was produced by a pass whose
   `gridIsInformative` was the weaker `>= 2 answered cells` rule, under which
   beehiiv read `stable`. Re-judging is the only reason the file says
   `inconclusive` today, and a `--resume` that copied would have carried the
   wrong verdict straight past its own fix. */
test("a row is re-judged from its stored grids, never carried forward", () => {
  const stale = {
    show_id: "1",
    timed_transcripts: 84,
    grid: { status: "stable", varies_by_request: false, episodes_probed: 1, episodes_informative: 1 },
    note: "PROBE GRID: 1 episode(s) ... reported one length every time",
    grids: [grid([100, null, 100, null])],
  };
  const fresh = judgeRow(stale);
  assert.equal(fresh.grid.status, "inconclusive", "today's rule, not the one the row was written under");
  assert.match(fresh.note, /inconclusive/);
});

/* MUTATION: drop the fetch-note recovery in `judgeRow` (return `note` bare).
   Verified failing.

   "the feed would not load" explains a row better than any verdict drawn from
   the grids that failure prevented, and it is the one fact on the row that no
   grid can reconstruct. Losing it on the first `--rederive` would silently turn
   an unreadable feed into an ordinary inconclusive. */
test("a fetch note survives re-judgement, and round-trips", () => {
  const row = { show_id: "1", timed_transcripts: 1, grids: [], note: `feed unreadable: 503${NOTE_JOIN} old text` };
  const once = judgeRow(row);
  assert.ok(once.note.startsWith("feed unreadable: 503"), "the fetch note is still there");
  assert.ok(once.note.includes(NOTE_PREFIX), "and the grid note follows it");
  /* IDEMPOTENT, which is what makes `--rederive` safe to run twice. The split
     and the join are derived from one constant so they cannot drift; if the
     prefix were renamed on one side only, the second pass would swallow the
     fetch note and this assertion is what would catch it. */
  assert.equal(judgeRow(once).note, once.note);
  assert.equal(judgeRow(judgeRow(once)).note, once.note);
});

/* MUTATION: have `verdictNote` open with anything other than `NOTE_PREFIX`.
   Verified failing — this is the drift the constant exists to prevent. */
test("every note opens with the prefix the split looks for", () => {
  for (const g of [
    showGridVerdict([grid([100, 100, 100, 200])]),
    showGridVerdict([grid([100, 100, 100, 100])]),
    showGridVerdict([grid([null, null, null, null])]),
  ]) {
    assert.ok(verdictNote(g).startsWith(NOTE_PREFIX), `${g.status} note must open with ${NOTE_PREFIX}`);
  }
});

/* MUTATION: make `rederive` recompute `results` but not `summary`. Verified
   failing. A file whose rows say one thing and whose summary block says another
   is the exact artifact this repo has been burned by twice. */
test("rederive re-judges the rows and the summary together", () => {
  const prev = {
    requests: { feeds: 1, grid_requests: 4 },
    summary: { audited: { shows: 1, timed_transcripts: 84 } },
    results: [{ show_id: "1", timed_transcripts: 84, grid: { status: "stable" }, grids: [grid([100, null, 100, null])] }],
  };
  const out = rederive(prev);
  assert.equal(out.results[0].grid.status, "inconclusive");
  assert.deepEqual(out.summary, summarise(out.results));
  assert.deepEqual(out.requests, prev.requests, "re-judging makes no request and must not claim one");
});

/* ------------------------------------------------------ the committed evidence */

/* THE ARTIFACT IS PART OF THE CLAIM. #323's headline finding was refused by a
   reviewer for existing only in a PR comment, and the same objection had already
   been raised against the Gastropod numbers. So the committed file is asserted
   against, not merely produced.

   MUTATION: edit `summary.audited.timed_transcripts` in the committed JSON by
   hand. Verified failing — and verified changing bytes first, since a
   whitespace-only edit to a CRLF working tree is a no-op (#319). */
test("the committed re-validation covers exactly the measured_clean bucket", () => {
  const re = JSON.parse(readFileSync(new URL("../../data/breadth-clean-regrid.json", import.meta.url), "utf8"));
  const yieldReport = JSON.parse(
    readFileSync(new URL("../../data/breadth-transcript-yield.json", import.meta.url), "utf8"),
  );
  const clean = yieldReport.measurement_coverage.measured_clean;

  /* RECOMPUTED FROM THE ROWS, not restated from the file's own summary block —
     `measure-suspects.test.mjs` learned this by mutation: asserting an internal
     sum identity while never comparing it to the committed block left a
     hand-edited 999999 green across 39 tests. */
  assert.deepEqual(summarise(re.results), re.summary, "the summary block is recomputed, not narrated");

  /* Every audited row keeps the grids its verdict was drawn from, so
     `varies_by_request: false` is falsifiable by a later reader. */
  for (const r of re.results) {
    assert.deepEqual(showGridVerdict(r.grids), r.grid, `${r.title}: the verdict is derived from the stored grids`);
    for (const g of r.grids || []) {
      assert.equal(g.cells.length, GRID_CELLS, `${r.title}: four cells, two axes — a partial grid is a different instrument`);
      /* NO BODY WAS READ is pinned upstream, not here: `decode-compare.test.mjs`
         counts body reads through a stub, which is a real check. An earlier
         version of this line asserted `!("bytes" in g)` and looked like
         corroboration — but `probeGrid` cannot emit a `bytes` key under any
         circumstance, so it passed whether or not audio had been downloaded.
         Deleted rather than left: an assertion that cannot fail, sitting under
         a comment about an expired download exception, is worse than no
         assertion, because it reads as evidence. What this file CAN check about
         cost is the request count, and it does, below. */
    }
  }

  /* THE RECONCILIATION. If these disagree, either the audit missed shows or the
     coverage file moved underneath it, and both are reasons to distrust every
     number in the PR body. */
  const audited = summarise(re.results).audited;
  const varies = summarise(re.results).varies_by_request;
  assert.equal(audited.shows, clean.shows + varies.shows, "audited pool == the measured_clean bucket it was drawn from");
  assert.equal(audited.timed_transcripts, clean.timed_transcripts + varies.timed_transcripts);
});
