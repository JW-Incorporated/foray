/* Where the committed evidence lives — the two hand-maintained lists of
   measurement ledgers, and nothing else (#326, epic #102).

   STATIC, keyless, no LLM, no dependencies, NO NETWORK, and no filesystem
   access either. This module exports two frozen arrays of strings. That is the
   entire contents, and the emptiness is the design.

   WHY IT IS ITS OWN FILE. Both lists are read by tools that must not import one
   another. `breadth-yield.mjs` is a reporting tool whose suite asserts it has
   "no network path at all" and does not import `politeness.mjs`, because a
   reporter that could make a request would be a second, unthrottled route into
   publishers' hosts. `measure-suspects.mjs` is the scanner that WRITES these
   ledgers and necessarily carries the whole fetch stack. `regrid-clean.mjs`
   drives the probe grid. Handing the reporter its list by importing the scanner
   would drag `ad-inflation.mjs`'s fetch path into a module documented as having
   none — trading a copied constant for a broken boundary, which is a worse
   deal than the copy.

   So the list goes somewhere all three can reach and none of them is: exactly
   the move `politeness.mjs` made when the per-host gate and the outbound
   identity were duplicated into `fetch-transcripts.mjs` and had already drifted
   (#318). This repo has now paid eight separate times for a policy that was
   copied instead of imported (#211/#219/#249, #313, #316, #318, #320, #321),
   and the list of files holding the corpus number is not the place to pay a
   ninth.

   THE FAILURE THESE LISTS PREVENT IS QUIET, NOT LOUD. A committed ledger absent
   from `MEASURED_REPORT_RELS` does not crash anything. It moves that tranche's
   shows out of `measured_clean`/`measured_unresolved` and into `inferred`, and
   `breadth-yield.mjs` then reports a corpus number contradicted by evidence
   sitting in `data/` beside it — requests that were spent, written down, and
   never consulted. `measure-suspects.test.mjs` pins both lists against what is
   actually committed in `data/`, in both directions, because nothing else can. */

/** Every committed ledger of measured dispositions, repo-relative, in the order
    the evidence was gathered.

    ORDER IS CHRONOLOGICAL AND LATER WINS. `measuredDispositions` in
    `breadth-yield.mjs` and `gridIndex` in `measure-suspects.mjs` both let a
    later file supersede an earlier one for a repeated `show_id`, so a narrower
    re-measurement lands on top of the pass it corrects. No two of these share a
    show today; the ordering is what makes that safe on the day they do.

    FORWARD SLASHES, IN BOTH LISTS. These are CLI defaults resolved against
    `process.cwd()` and they are written verbatim into committed JSON as
    `source.measured`, where a backslash would put one machine's path separator
    into a file every checkout reads. `GRID_REPORT_RELS` below was built with
    `join("data", …)` while it lived in `measure-suspects.mjs` — Windows
    separators that never escaped, because its only consumer re-joined them to
    `ROOT`. Moving it here made it a shared constant with more than one reader,
    so it is written the portable way too; every consumer already normalises,
    so the change is invisible except on the day someone adds a reader that
    does not. */
export const MEASURED_REPORT_RELS = Object.freeze([
  "data/breadth-suspect-inflation.json", // #319 — the seven hostname suspects
  "data/breadth-anchorable-inflation.json", // #321 — the 41 nobody suspected
  "data/breadth-tranche-03-inflation.json", // #326 — tranche 3, measured on arrival
]);

/** Where the probe-grid ledgers live, repo-relative.

    THREE FILES BECAUSE THEY ARE THREE POOLS OF ONE INSTRUMENT, not three
    instruments: #324 gridded the `recover` shows and found none varying; the
    flightcast pass gridded the six `unresolved` shows #323 left open; #326
    grids every show tranche 3 marks anchorable. Same `probeGrid`, same
    four-cell floor, same reading. Listing them separately rather than merging
    the artifacts keeps each pass's request count attached to the evidence it
    bought.

    THE THIRD ONE IS A DIFFERENT KIND OF ENTRY, and the distinction is the point
    of #326. The first two are REPAIRS — they re-measured shows already counted
    as anchorable on a hostname inference, and between them the corpus fell
    10,933 to 8,833. The third was spent BEFORE its tranche reported a number,
    so tranche 3 contributes no inferred rows for a fourth pass to repair. */
export const GRID_REPORT_RELS = Object.freeze([
  "data/breadth-clean-regrid.json",
  "data/flightcast-settle-regrid.json",
  "data/breadth-tranche-03-regrid.json",
]);
