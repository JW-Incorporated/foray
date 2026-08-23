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
  poolShows,
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
  DEFAULT_POOL_DISPOSITIONS,
  KNOWN_DISPOSITIONS,
  defaultOutFor,
  methodFor,
  POLICY,
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

/* MUTATION: delete the `.sort()` in `poolShows`, or flip its sign. Verified
   failing (both directions).

   The brief's instruction is "order the work by transcript count, so each
   request buys the most certainty", and it is not decoration: this pool is
   extremely skewed — one show carries 1,368 transcripts and five carry four or
   fewer — so a run stopped by a host asking us to slow down has either
   re-validated a quarter of the corpus or almost none of it, decided entirely
   by this line. Note this is deliberately NOT `measure-suspects.mjs`'s
   host-total ordering; see `poolShows`' docstring for why the two scans want
   opposite orders. */
test("shows are audited biggest-asset-first", () => {
  const pool = poolShows([
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
  const pool = poolShows([
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

/* MUTATION: default `dispositions` to `["recover", "unresolved"]`, or drop the
   `wanted` set and match everything. Verified failing (both).

   THE DEFAULT IS THE GUARD. #324's committed pass, its summary block and its
   reconciliation against `measurement_coverage.measured_clean` all assume the
   pool is `recover` and nothing else. A widened default would silently change
   what the committed file means on the next `--resume`, with no flag in the
   invocation to say so. */
test("the pool defaults to measured_clean and nothing else", () => {
  assert.deepEqual([...DEFAULT_POOL_DISPOSITIONS], ["recover"]);
  assert.deepEqual(parseArgs([]).dispositions, ["recover"]);
});

/* MUTATION: have `poolShows` ignore `dispositions` and hardcode `recover`.
   Verified failing.

   This is the line that made the flightcast pass possible without a second
   grid implementation: the six shows #323 left open are `unresolved`, the
   instrument that must ask them is byte-for-byte the one that asked the
   `recover` pool, and the only thing that legitimately differs is which rows
   are handed to it. */
test("the audited bucket is selectable, and only the named one is audited", () => {
  const reports = [
    {
      results: [
        showRow({ show_id: "clean", disposition: "recover" }),
        showRow({ show_id: "dirty", disposition: "drop" }),
        showRow({ show_id: "dunno", disposition: "unresolved", timed_transcripts: 999 }),
      ],
    },
  ];
  assert.deepEqual(poolShows(reports, { dispositions: ["unresolved"] }).map((r) => r.show_id), ["dunno"]);
  assert.deepEqual(
    poolShows(reports, { dispositions: ["recover", "unresolved"] }).map((r) => r.show_id),
    ["dunno", "clean"],
    "still biggest-asset-first across a widened pool",
  );
  /* `drop` is selectable too and deliberately not special-cased: a settled
     condemnation is not this file's business, but refusing it in code would be
     a policy hidden in a filter rather than in an invocation. */
  assert.deepEqual(poolShows(reports, { dispositions: ["drop"] }).map((r) => r.show_id), ["dirty"]);
});

/* MUTATION: drop `prior_disposition` from the row `poolShows` builds. Verified
   failing.

   `--rederive` re-judges from the committed file ALONE and never re-reads the
   measured pool, so if the row does not carry which bucket it was drawn from,
   every note in a re-judged flightcast artifact silently reverts to the
   `measured_clean` wording — telling a reader that an `unresolved` show "still
   rests on its ranged-GET samples", which on this host is precisely the claim
   #323 destroyed. */
test("a row remembers which bucket it was drawn from", () => {
  const pool = poolShows([{ results: [showRow({ show_id: "u", disposition: "unresolved" })] }], {
    dispositions: ["unresolved"],
  });
  assert.equal(pool[0].prior_disposition, "unresolved");
});

/* MUTATION: have `judgeRow` call `verdictNote(grid, { perShow })` and drop
   `priorDisposition`. SURVIVED the first mutation run, and this test is why it
   no longer does.

   THE HOLE WAS THE JOIN, WHICH IS THE PART THAT ACTUALLY RUNS. One test pinned
   that `poolShows` writes `prior_disposition`; another pinned that
   `verdictNote` reads it. Neither pinned that anything connects them — so
   deleting the argument left both green while every note in a re-judged
   flightcast artifact silently reverted to the `measured_clean` wording. That
   is exactly the failure `--rederive` exists to prevent, arriving through
   `--rederive` itself: it re-judges from the committed file alone, so this is
   the only path by which the field is ever read. */
test("a re-judged row is judged as the bucket it was drawn from", () => {
  const grids = [grid([100, 100, 100, 100])];
  const open = judgeRow({ show_id: "u", prior_disposition: "unresolved", grids });
  assert.match(open.note, /remains unresolved/);
  assert.ok(!/rests on its ranged-GET samples/.test(open.note), "an unresolved show rests on nothing");

  /* #324's rows predate the field and must keep their wording exactly. */
  assert.match(judgeRow({ show_id: "c", grids }).note, /still rests on its ranged-GET samples/);
  assert.match(judgeRow({ show_id: "c", prior_disposition: "recover", grids }).note, /still rests on its ranged-GET samples/);

  /* AND IT SURVIVES A ROUND TRIP, which is the operation that would lose it. */
  const rejudged = rederive({ results: [open] });
  assert.equal(rejudged.results[0].note, open.note);
});

/* MUTATION: remove the `seen` set. Verified failing.

   The two measured files are two POOLS of one scan (suspects, then everyone
   else) and nothing structurally stops a show appearing in both. Counted twice
   it would report more transcripts audited than exist, which is the exact
   direction of error that makes an audit worthless. */
test("a show present in both measured files is audited once", () => {
  const pool = poolShows([
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
  /* THE NOTE QUOTES THE PAIR, and quoting `varying_totals` here instead was
     itself a (smaller) version of this bug — see "the condemning evidence is
     one pair per URL". With a single varying episode the two renderings differ
     only by the separator; with three they differ by a factor of three in how
     many lengths one URL appears to have been served. */
  assert.ok(verdictNote(v).includes("100 vs 200"));
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

/* MUTATION: delete the `clean` branch in `verdictNote` so both pools share the
   `recover` wording. Verified failing on both halves.

   A NOTE THAT DESCRIBES THE WRONG POOL IS THE FAILURE MODE THIS FILE EXISTS TO
   PREVENT, one layer up from the grid. On a `recover` row the note may say the
   show "still rests on its ranged-GET samples", because something admitted it
   and that something was the ranged GET. On an `unresolved` flightcast row the
   same sentence would credit samples #323 proved are master lengths rather
   than deliveries — the exact assertion the whole sequence has been correcting
   — and "the verdict does not stand" would name a verdict that was never
   issued. The note is what a later reader quotes, so it has to be true of the
   row it is attached to. */
test("a note never describes a bucket the row did not come from", () => {
  const stable = showGridVerdict([grid([100, 100, 100, 100])]);
  const varies = showGridVerdict([grid([100, 100, 100, 140])]);

  const cleanStable = verdictNote(stable, { priorDisposition: "recover" });
  const openStable = verdictNote(stable, { priorDisposition: "unresolved" });
  assert.match(cleanStable, /still rests on its ranged-GET samples/);
  assert.ok(
    !/rests on its ranged-GET samples/.test(openStable),
    "an unresolved show rests on nothing; saying otherwise credits the samples #323 voided",
  );
  assert.match(openStable, /remains unresolved/);
  /* WHY STABILITY CANNOT ADMIT IT, stated as the reason rather than as a
     citation. An earlier version named #323's bare-chain control here — which,
     on that show's own row, cited the row itself as its own corroboration. */
  assert.match(openStable, /did not vary for us/);

  const cleanVaries = verdictNote(varies, { priorDisposition: "recover" });
  const openVaries = verdictNote(varies, { priorDisposition: "unresolved" });
  assert.match(cleanVaries, /the verdict does not stand/);
  assert.ok(!/the verdict does not stand/.test(openVaries), "there was no verdict to overturn");
  assert.match(openVaries, /leaves the anchorable count/);

  /* THE DEFAULT IS `recover`, which is what keeps #324's committed notes
     byte-identical under `--rederive`: those rows predate the field. */
  assert.equal(verdictNote(stable), cleanStable);
});

/* MUTATION: make `varying_pairs` read `varying_totals` (the pooled union).
   Verified failing.

   THE POOLED FORM IS ACTIVELY MISLEADING ONCE A SHOW HAS MORE THAN ONE VARYING
   EPISODE, and this file already says so about `totals_seen`: three episodes
   are three different files, so three distinct numbers there mean nothing. The
   condemning claim is "ONE url, two lengths". Unioned across three episodes it
   renders as `a / b / c / d / e / f`, which reads as a single URL served six
   lengths — an overstatement of the finding sitting inside the note that
   reports it. Per-episode pairs are the shape the evidence actually has, and
   `data/breadth-anchorable-inflation.json` quotes them verbatim. */
test("the condemning evidence is one pair per URL, never a pool of them", () => {
  const v = showGridVerdict([grid([10, 10, 10, 14]), grid([20, 20, 20, 26])]);
  assert.deepEqual(v.varying_pairs, ["10 vs 14", "20 vs 26"]);
  /* The pooled field still exists and still pools — the point is that they are
     different numbers and the note must quote the right one. */
  assert.deepEqual(v.varying_totals, [10, 14, 20, 26]);
  assert.match(verdictNote(v), /10 vs 14; 20 vs 26/);
  assert.ok(!/10 \/ 14 \/ 20 \/ 26/.test(verdictNote(v)), "the note must not restate the union as one URL's lengths");

  /* A STABLE SHOW HAS NO PAIRS AT ALL, which is what keeps the field from
     becoming a second `totals_seen`. */
  assert.deepEqual(showGridVerdict([grid([10, 10, 10, 10])]).varying_pairs, []);
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

/* MUTATION: flip one stored cell's `total` in the committed flightcast file so
   a `stable` row's grid disagrees with its own evidence; and separately, edit
   `summary.varies_by_request.timed_transcripts` by hand. Verified failing, and
   verified changing bytes on disk first (#319/#324: an untracked file makes
   `git diff` report a no-op that never happened).

   WHAT THIS FILE DECIDES. 5,320 timed transcripts — the six shows #323 left
   open on the one origin it caught assembling per request — and through
   `gridOverride` it is what moved 1,914 of them out of the anchorable count.
   The number in the founder's hands rests on these cells, so the verdicts have
   to be re-derivable from them and the pool has to be exactly the six. */
test("the committed flightcast pass covers exactly the six shows #323 left open", () => {
  const re = JSON.parse(readFileSync(new URL("../../data/flightcast-settle-regrid.json", import.meta.url), "utf8"));
  const measured = JSON.parse(
    readFileSync(new URL("../../data/breadth-anchorable-inflation.json", import.meta.url), "utf8"),
  );

  assert.deepEqual(summarise(re.results), re.summary, "the summary block is recomputed, not narrated");
  assert.equal(re.results.length, 6);
  assert.equal(summarise(re.results).audited.timed_transcripts, 5320);

  for (const r of re.results) {
    assert.equal(r.enclosure_host, "atelier.flightcast.com");
    assert.equal(r.prior_disposition, "unresolved", "every audited row was unresolved when it was probed");
    assert.deepEqual(showGridVerdict(r.grids), r.grid, `${r.title}: the verdict is derived from the stored grids`);
    for (const g of r.grids || []) {
      assert.equal(g.cells.length, GRID_CELLS, `${r.title}: a partial grid is a different instrument`);
      assert.equal(answeredCells(g).length, GRID_CELLS, `${r.title}: all four cells answered`);
      /* NO HOST ASKED US TO SLOW DOWN, pinned against the cells rather than
         restated from the PR body. */
      for (const c of g.cells) assert.ok(!SLOW_DOWN_STATUSES.has(c.status), `${r.title}: HTTP ${c.status}`);
    }
  }

  /* A PLATFORM VERDICT IS NOT A SHOW VERDICT, and on this pool that is a
     measured fact rather than a caution. All six rows share one enclosure host
     and they do not share one answer: two were served a longer file on the
     client/unranged cell and four were served one length in all four. A change
     that aggregated to the hostname would make this fail, which is the point —
     `_adswizz_note` and #321's blubrry 9/1 and libsyn 4/4 splits say the same
     thing and nothing here may quietly stop obeying them. */
  const byStatus = (s) => re.results.filter((r) => r.grid.status === s);
  assert.equal(byStatus("varies").length, 2, "two of six — not a platform verdict");
  assert.equal(byStatus("stable").length, 4);
  assert.equal(byStatus("inconclusive").length, 0);

  /* THE FLIGHTCAST SIGNATURE, cell by cell. #323's finding is specific: three
     cells agree and ONLY `client`/unranged is served the assembled file. A
     `varies` row whose discrepancy sat anywhere else would be a different
     phenomenon wearing this one's verdict. */
  for (const r of byStatus("varies")) {
    for (const g of r.grids) {
      const long = g.cells.find((c) => c.identity === "client" && !c.ranged);
      const others = g.cells.filter((c) => c !== long);
      assert.ok(long.total > others[0].total, `${r.title}: the client/unranged cell is the long one`);
      assert.equal(new Set(others.map((c) => c.total)).size, 1, `${r.title}: the other three agree`);
    }
  }

  /* THE ROWS THIS EVIDENCE MOVED. `gridOverride` is condemn-only, so a `varies`
     row must be `drop` in the measured file and a `stable` row must be exactly
     as unresolved as it was — stability admits nothing, which is the whole of
     what #323's bare-chain control established. */
  const dispositionOfShow = (id) => measured.results.find((x) => String(x.show_id) === String(id));
  for (const r of re.results) {
    const row = dispositionOfShow(r.show_id);
    assert.ok(row, `${r.title}: audited but absent from the measured file`);
    assert.equal(row.grid_status, r.grid.status, `${r.title}: the measured row records what the grid saw`);
    assert.equal(
      row.disposition,
      r.grid.status === "varies" ? "drop" : "unresolved",
      `${r.title}: stability never moves a row, and variance always does`,
    );
  }
});

/* MUTATION: make `defaultOutFor` ignore its argument and always return
   `data/breadth-clean-regrid.json`. Verified failing.

   THE FOOTGUN A REVIEWER FOUND. `--out` defaulted to the clean-pool path
   unconditionally, so `--disposition unresolved` with no `--out` would
   overwrite #324's committed evidence with a different pool's rows — and
   `GRID_REPORT_RELS` in `measure-suspects.mjs` would go on consuming that file
   as the clean-pool ledger. One artifact per pool, chosen by the same flag that
   chooses the pool. */
test("a pool cannot silently overwrite another pool's committed evidence", () => {
  assert.equal(defaultOutFor(["recover"]), "data/breadth-clean-regrid.json");
  assert.notEqual(defaultOutFor(["unresolved"]), defaultOutFor(["recover"]));
  assert.notEqual(defaultOutFor(["recover", "unresolved"]), defaultOutFor(["recover"]));
  assert.equal(parseArgs([]).out, "data/breadth-clean-regrid.json", "#324's invocation is unchanged");
  assert.notEqual(parseArgs(["--disposition", "unresolved"]).out, "data/breadth-clean-regrid.json");
  /* An explicit path still wins: a caller who names one has said what they mean. */
  assert.equal(parseArgs(["--disposition", "unresolved", "--out", "data/x.json"]).out, "data/x.json");
});

/* MUTATION: hardcode `method` back to "over every measured_clean show", or make
   `rederive` recompute it from `DEFAULT_POOL_DISPOSITIONS` instead of from
   `prev.source.dispositions`. Verified failing (both).

   A PROVENANCE BLOCK THAT CONTRADICTS ITSELF IS WORSE THAN NONE. The flightcast
   artifact opened by claiming it had audited `measured_clean` and then listed
   `"dispositions": ["unresolved"]` three keys later — the same defect
   `measure-suspects.mjs` records against its own `source.passes`, where a
   provenance block could not be reconciled with the evidence attached to it.

   AND `--rederive` MUST READ THE POOL OFF THE FILE, not off argv: it takes no
   `--disposition`, so recomputing from today's flags would let a zero-request
   re-judgement relabel a pass's pool. */
test("a ledger's method names the pool that ledger actually audited", () => {
  assert.match(methodFor(["unresolved"]), /\[unresolved\]/);
  assert.match(methodFor(["recover"]), /\[recover\]/);
  assert.ok(!/measured_clean/.test(methodFor(["unresolved"])), "it must not name a bucket it did not touch");

  const prev = { source: { dispositions: ["unresolved"] }, policy: "stale", results: [] };
  assert.match(rederive(prev).method, /\[unresolved\]/, "re-judging reads the pool off the file, not off argv");
  /* A file written before the field was recorded was run against `recover`. */
  assert.match(rederive({ source: {}, results: [] }).method, /\[recover\]/);
  /* PROVENANCE IS COPIED, NEVER INVENTED. */
  assert.deepEqual(rederive(prev).source, prev.source);
});

/* MUTATION: drop `policy: POLICY` from `rederive`. Verified failing.

   `policy` states what a reader may conclude from the file. Two committed grid
   ledgers stating it in different words is the prose form of "rows judged by
   two standards" — the failure `--rederive` exists to prevent, one level up
   from the verdicts. */
test("re-judging restates the current policy, and both ledgers carry the same one", () => {
  assert.equal(rederive({ policy: "an older, looser claim", results: [] }).policy, POLICY);
  /* THE POLICY MAY MENTION "clean bill" ONLY TO DENY IT. A reviewer caught the
     first version of this line stripping the one occurrence with `.replace()`
     before testing for it, and pairing that with a lookahead that pointed the
     wrong way — an assertion that could not fail. Every occurrence must be
     negated in place. */
  for (const m of POLICY.matchAll(/(.{0,12})clean bill/g)) {
    assert.match(m[1], /\bnot a $/, `"clean bill" must be denied where it appears, got "${m[0]}"`);
  }
  assert.ok(POLICY.includes("clean bill"), "the denial is the point; a policy that never says it cannot deny it");
  assert.match(POLICY, /can never move one up/);

  const clean = JSON.parse(readFileSync(new URL("../../data/breadth-clean-regrid.json", import.meta.url), "utf8"));
  const flight = JSON.parse(readFileSync(new URL("../../data/flightcast-settle-regrid.json", import.meta.url), "utf8"));
  assert.equal(clean.policy, POLICY);
  assert.equal(flight.policy, POLICY);
  /* ...and each still names its own pool, which is the part that must DIFFER. */
  assert.match(clean.method, /\[recover\]/);
  assert.match(flight.method, /\[unresolved\]/);
});

/* MUTATION: restore "Only ADR-0008 decode-and-compare can settle it" to
   `verdictNote`'s unresolved/stable branch. Verified failing.

   IT WAS FALSE, AND IT CONTRADICTED A SIBLING FILE. `measure-suspects.mjs`
   drops exactly this claim from `decodeOverride`'s blind-host note, on the
   grounds that a grid settled two of these shows for 72 requests and no
   download — so leaving it here produced two committed files asserting opposite
   things about the same four show_ids. The regex matches the CLAIM rather than
   one phrasing of it: the first version of the guard next door tested
   `/only instrument/` and this wording walked straight past it. */
test("no note claims one instrument is the only way to settle a row", () => {
  const claimsSoleInstrument = /\bonly\b[^.]*\bsettle\b|\bsettle\b[^.]*\bonly\b/i;
  const stable = showGridVerdict([grid([100, 100, 100, 100])]);
  assert.ok(!claimsSoleInstrument.test(verdictNote(stable, { priorDisposition: "unresolved" })));
  assert.ok(!claimsSoleInstrument.test(verdictNote(stable, { priorDisposition: "recover" })));

  /* AND IT MUST NOT CITE ITSELF. The sentence used to name #323's bare-chain
     control as corroboration, which on that show's own row cited the row. */
  assert.ok(
    !/Secret To Success/.test(verdictNote(stable, { priorDisposition: "unresolved" })),
    "a row must not be its own corroboration",
  );

  for (const rel of ["breadth-clean-regrid", "flightcast-settle-regrid"]) {
    const f = JSON.parse(readFileSync(new URL(`../../data/${rel}.json`, import.meta.url), "utf8"));
    for (const r of f.results) {
      assert.ok(!claimsSoleInstrument.test(r.note), `${rel} / ${r.title}`);
    }
  }
});

/* MUTATION: drop the `assertKnownDispositions` call from `parseArgs`, or add
   the typo to `KNOWN_DISPOSITIONS`. Verified failing.

   A TYPO SELECTED NOTHING AND WROTE A FILE ANYWAY. `--disposition unresolve`
   produced an empty pool, printed `0 show(s)`, and committed a zero-row
   artifact under a path derived from the typo — a file that looks like a
   measurement and is the absence of one. */
test("a misspelled bucket is an error, not an empty measurement", () => {
  assert.throws(() => parseArgs(["--disposition", "unresolve"]), /unknown value/);
  assert.throws(() => parseArgs(["--disposition", "recover,dropped"]), /dropped/);
  for (const d of KNOWN_DISPOSITIONS) assert.deepEqual(parseArgs(["--disposition", d]).dispositions, [d]);
  /* The known set is exactly what the other tool can write; if `dispositionOf`
     ever grows a fourth, this fails and someone has to decide. */
  assert.deepEqual([...KNOWN_DISPOSITIONS].sort(), ["drop", "recover", "unresolved"]);
});

/* MUTATION: drop `source` from `rederive`'s returned object. Verified failing.

   THE INFERENCE MUST HAPPEN ONCE. A file written before `source.dispositions`
   existed has its pool inferred from `DEFAULT_POOL_DISPOSITIONS` — correct,
   because `recover` was the only pool there was — but leaving the key absent
   means every future `--rederive` re-infers it, so changing that constant would
   silently relabel a pass. Backfilling converts a standing assumption into a
   recorded fact. */
test("re-judging records the pool it inferred, so it is never inferred twice", () => {
  const backfilled = rederive({ source: { yield: "y" }, results: [] });
  assert.deepEqual(backfilled.source.dispositions, ["recover"]);
  assert.equal(backfilled.source.yield, "y", "the rest of the provenance is untouched");

  /* AND A RECORDED POOL IS NEVER OVERWRITTEN. */
  const recorded = rederive({ source: { dispositions: ["unresolved"] }, results: [] });
  assert.deepEqual(recorded.source.dispositions, ["unresolved"]);
  assert.match(recorded.method, /\[unresolved\]/);

  /* Both committed ledgers now carry it, so neither is inferred again. */
  for (const [rel, want] of [["breadth-clean-regrid", "recover"], ["flightcast-settle-regrid", "unresolved"]]) {
    const f = JSON.parse(readFileSync(new URL(`../../data/${rel}.json`, import.meta.url), "utf8"));
    assert.deepEqual(f.source.dispositions, [want], rel);
  }
});
