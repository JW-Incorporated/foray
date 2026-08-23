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
  SLOW_DOWN_STATUSES,
} from "./regrid-clean.mjs";

/** One grid cell. `total: null` is the shape `probeGrid` produces for an origin
    that sent no readable length — never 0, which is the trap it guards. */
const cell = (total, over = {}) => ({
  identity: "probe",
  ranged: true,
  status: 206,
  total,
  content_encoding: null,
  transfer_encoding: null,
  resolved_host: "cdn.example.org",
  ...over,
});

/** A grid as `probeGrid` returns it: four cells, and the two derived fields. */
const grid = (totals, over = {}) => {
  const cells = totals.map((t, i) => cell(t, { identity: i < 2 ? "probe" : "client", ranged: i % 2 === 0 }));
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

/* MUTATION: `gridIsInformative` returning `answered.length >= 1`, or simply
   `true`. Verified failing.

   THIS IS THE TEST THIS FILE EXISTS FOR. Four refused requests produce zero
   totals, an empty `distinct_totals`, and `varies_by_request: false` — a row
   that is byte-for-byte indistinguishable from a file that answered four times
   identically. Filing that as "stable" would be ADR-0008's own cautionary tale
   repeated: "the first version of this scan used HEAD, reported 18 of 18 shows
   byte-stable, and was completely wrong." A negative filed as a pass.

   `politeness.mjs` records a Buzzsprout edge answering 403 to one product token
   and 206 to another, reproducible both ways, so a grid half-refused BY
   IDENTITY is a measured shape on this corpus, not a hypothetical. */
test("a grid nobody answered is not evidence of stability", () => {
  assert.equal(gridIsInformative(grid([null, null, null, null])), false);
  assert.equal(gridIsInformative(grid([100, null, null, null])), false, "one answer has nothing to agree with");
  assert.equal(gridIsInformative(grid([100, 100, null, null])), true, "one ranged and one unranged is the comparison");
});

/* MUTATION: `gridIsInformative` counting answers instead of checking axes
   (`answered.length >= 2`). Verified failing — and this mutant is the code that
   was actually shipped into the first pass over the real pool.

   THE SHAPE IS MEASURED, NOT IMAGINED. `podcasts.beehiiv.com` answers an
   unranged request CHUNKED, with no `Content-Length`, so both its unranged
   cells report nothing and the two survivors are both ranged. That is two
   answers that agree, and under a bare count-of-two it read `stable` — for a
   show whose grid never once compared a ranged request against an unranged one.
   The flightcast discrepancy appeared on exactly that comparison and on no
   other, so this is a grid that cannot see the thing it was sent to look for
   reporting that it did not see it. */
test("two answers on the same axis are not the comparison", () => {
  /* index 0/2 are ranged, 1/3 unranged — so this is beehiiv exactly: both
     ranged cells answered, both unranged sent nothing. */
  const beehiiv = grid([100, null, 100, null]);
  assert.equal(answeredCells(beehiiv).length, 2, "two cells did answer");
  assert.equal(beehiiv.varies_by_request, false, "and they agreed");
  assert.equal(gridIsInformative(beehiiv), false, "and it still proves nothing about the range axis");
  assert.equal(showGridVerdict([beehiiv]).status, "inconclusive");
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
  assert.equal(
    s.varies_by_request.timed_transcripts + s.stable_across_the_grid.timed_transcripts + s.inconclusive.timed_transcripts,
    s.audited.timed_transcripts,
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
      assert.equal(g.cells.length, 4, `${r.title}: four cells, two axes — a partial grid is a different instrument`);
      /* NO BODY WAS READ, asserted from the artifact. `probeGrid` promises the
         unranged calls are aborted as their headers arrive; a grid row carrying
         a byte count would mean something downloaded audio, and #323's download
         exception has expired. */
      assert.ok(!("bytes" in g) && !("body" in g), `${r.title}: the grid records lengths, never a download`);
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
