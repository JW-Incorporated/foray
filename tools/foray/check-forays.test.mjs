/* Issue #182. Two jobs, and the second is the one that matters.
 *
 *   1. Assert the COMMITTED data is valid — this is the gate. CI runs this file
 *      (tools/ci/run-suites.mjs discovers it), so a Foray whose running order
 *      breaks D1 or D5 turns `data-and-site` red and cannot merge.
 *   2. Prove that it actually would. #182's acceptance is explicit: "verified by
 *      deliberately reordering to break a rule and confirming CI goes red — not
 *      by inspection". Every rule below is therefore broken on purpose against
 *      a copy of the REAL running order, and the D1/D5 cases go one further and
 *      spawn the real CLI against a mutated checkout to assert exit code 1.
 *      A checker that is only ever run on passing data is not a checker.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import copyRules from "../../backend/src/copy/rules.js";
import {
  checkForays,
  loadFiles,
  d1Budget,
  d5Triples,
  iqr,
  maxStartsInWindow,
  D1_WINDOW_SEC,
} from "./check-forays.mjs";

const { BANNED, wordCount, MAX_WHY_LINE_WORDS } = copyRules;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const CLI = path.join(HERE, "check-forays.mjs");

const files = loadFiles(REPO_ROOT);
const clone = () => structuredClone(files);
const foray0 = (f) => f.forays.forays[0];
/* Foray #2 (`capital-types-1`) landed 2026-08-16, so `forays[0]` is no longer
 * "the Foray" — it is Foray #1. Every assertion that is about #1 specifically
 * keeps using `foray0`; every assertion that is about the FILE loops. Anything
 * that pinned a whole-file count now pins it per Foray, because a count that
 * grows with each Foray is a number nobody can maintain. */
const forayBy = (f, id) => f.forays.forays.find((x) => x.id === id);
const errorsFor = (f) => checkForays(f).errors;
const durationOf = (f, segmentId) => {
  const s = f.segments.segments.find((x) => x.id === segmentId);
  return s.end_sec - s.start_sec;
};

/* ------------------------------------------------- the committed data is ok */

test("the committed data passes with zero errors", () => {
  const { errors } = checkForays(files);
  assert.deepEqual(errors, [], errors.join("\n"));
});

test("the CLI exits 0 on the committed data", () => {
  const out = execFileSync(process.execPath, [CLI], { encoding: "utf8" });
  assert.match(out, /forays ok/);
});

test("the committed Forays are the three documented ones, and all are #134's kind", () => {
  // Pinned by id rather than by count so that adding a fourth is a deliberate
  // edit here, and so a RENAME cannot pass as an addition.
  //
  // `grilling-history-2` landed 2026-08-17 (#226) as the on-plot rebuild of #1.
  // #1 is kept and marked `superseded_by` rather than replaced in place: its
  // exact shape is this file's fixture for the D1 and D5 proofs below, and an
  // 8-segment Foray with D1 headroom cannot express "the budget exactly met",
  // the 620.5 s span, or the GRID-3 reinstatement. ORDER MATTERS — `foray0` is
  // `forays[0]`, so #1 must stay first or every proof below silently retargets.
  assert.deepEqual(
    files.forays.forays.map((f) => f.id),
    ["grilling-history-1", "grilling-history-2", "capital-types-1"]
  );
  for (const f of files.forays.forays) assert.equal(f.kind, "deep-dive", f.id);
});

test("Foray #1 is labelled superseded, so nobody re-tests the drift by accident", () => {
  /* Both grilling Forays are drafts reachable by `?foray=<id>`, and the older
   * link still works. A stale draft that nothing labels stale is how the wrong
   * one gets tested next week (#226). Neither field is read by the player. */
  const one = forayBy(files, "grilling-history-1");
  assert.equal(one.superseded_by, "grilling-history-2");
  assert.match(one.superseded_note, /Superseded 2026-08-17/);
  assert.ok(forayBy(files, "grilling-history-2"), "the successor must exist");
  assert.equal(forayBy(files, "grilling-history-2").superseded_by, undefined);
});

test("Foray #1 is draft, so no client may surface it yet", () => {
  // Same safety valve as ladders (docs/curation/ladders-client-spec.md): nobody
  // has listened to this end to end, and grilling-foray.md §9 says so.
  assert.equal(foray0(files).status, "draft");
});

test("Foray #1 carries the 32-segment running order from grilling-foray.md §2", () => {
  const items = foray0(files).items.filter((i) => i.type === "segment");
  assert.equal(items.length, 32);
});

test("Foray #1's runtime is the documented 3,673.0 s (61:13)", () => {
  const { report } = checkForays(files);
  assert.equal(report.forays[0].runtime_sec, 3673.03);
});

test("Foray #1's mean segment duration matches the doc's 114.8 s", () => {
  assert.equal(checkForays(files).report.forays[0].mean_sec, 114.8);
});

/* ------------------------------------------------------------- Foray #2 pins
 * Same treatment as #1: the numbers docs/curation/foray2-capital.md quotes are
 * pinned here, because an unpinned number is what drifted last time. */

test("Foray #2 is draft, and carries the 22-segment running order from foray2-capital.md §2", () => {
  const f = forayBy(files, "capital-types-1");
  assert.equal(f.status, "draft");
  assert.equal(f.items.filter((i) => i.type === "segment").length, 22);
});

test("Foray #2's numbers are the ones its doc quotes", () => {
  const r = checkForays(files).report.forays.find((x) => x.id === "capital-types-1");
  assert.equal(r.runtime_sec, 3082.43, "51:22 of tape");
  assert.equal(r.mean_sec, 140.1);
  assert.equal(r.d1_budget, 6, "51.4 min puts it in the 45-120 minute band");
  assert.equal(r.d1_max_starts_in_window, 5, "one start of headroom, unlike #1");
  assert.equal(r.d5_pairwise_violations, 0);
  assert.equal(r.d5_iqr_sec, 71.75);
});

test("Foray #2's only L4 segment carries both escape-hatch fields", () => {
  // VD-1 is 259.9 s, past the 240 s soft maximum. `needs_review` and
  // `long_reason` are not in the segment schema yet, so they live on the item.
  const f = forayBy(files, "capital-types-1");
  const long = f.items.filter((i) => {
    const s = files.segments.segments.find((x) => x.id === i.segment_id);
    return s && s.end_sec - s.start_sec > 240;
  });
  assert.equal(long.length, 1);
  assert.equal(long[0].label, "VD-1");
  assert.equal(long[0].needs_review, true);
  assert.ok(long[0].long_reason && long[0].long_reason.length > 40, "long_reason must say what the extra minutes do");
});

test("Foray #2 draws on exactly eight episodes", () => {
  // Pinned because M4's 25 % cap is only meaningful against a known denominator,
  // and because losing an episode is how a Foray quietly becomes an edit of one
  // show. The editorial claim in foray2-capital.md §0 — that only one of the
  // eight is a VC show — is NOT checked here: "is this a VC show" is not a
  // property of the data. An earlier version of this test asserted no source id
  // began with `fr-`, which was vacuous (no such id exists) and read as if it
  // were checking the editorial claim. The real guard against a DAI source
  // playing is `check-forays.mjs` itself, pinned by "a dai_suspected source
  // cannot carry a played segment" and "no source is DAI-suspected".
  const f = forayBy(files, "capital-types-1");
  const eps = new Set(
    f.items
      .filter((i) => i.type === "segment")
      .map((i) => files.segments.segments.find((s) => s.id === i.segment_id).item_id)
  );
  assert.equal(eps.size, 8);
});

test("the pool segments held back from their Foray are not in any running order", () => {
  // The pool is a pool, not a playlist. Each Foray's doc names the segments it
  // authored and deliberately did not play; those must stay unplayed by EVERY
  // Foray, or the reason they were held (pacing, a rule, an expletive) is void.
  /* type-filtered: a narration item has no `segment_id`, and letting `undefined`
   * into this set would inflate `used.size` and quietly satisfy the identity
   * below. None exist yet, which is exactly when this is cheap to get right. */
  const used = new Set(
    files.forays.forays.flatMap((f) => f.items.filter((i) => i.type === "segment").map((i) => i.segment_id))
  );
  const held = [
    "bbqc-moss-school#1881", // MOSS-G   — grilling-foray.md §7
    "bbqc-traeger-history#2457", // TRA-4
    "bbqrn-argentina-open-fire#2292", // ARG-8
    "bfh-griddle-bakestone#1360", // GRID-3
    "ss-inlaw-investors#770", // FAM-3   — foray2-capital.md §7
    "tbf-328-tringas#2299", // CALM-2
    "ftb-89-sbir-grants#2467", // GR-4
    "yc-how-fundraising-works#1230", // YC-4
    /* The four Miller cuts M4's 25 % concentration cap would not let
     * grilling-history-2 play — grilling-history-coverage.md §5b. Each advances a
     * beat and each is authored; the cap is what held them, not the tape. */
    "grill-coach-adrian-miller#1346", // beat 38, the media audit
    "grill-coach-adrian-miller#1609", // beat 18, the indigenous template
    "grill-coach-adrian-miller#1964", // beat 24, skill as capital
    "grill-coach-adrian-miller#2167", // beat 38, the aesthetic shift
  ];
  for (const id of held) {
    assert.ok(files.segments.segments.some((s) => s.id === id), `${id} should be in the pool`);
    assert.ok(!used.has(id), `${id} should be held back`);
  }
  // The pool is exactly what the Forays play plus what they held back. Stated
  // as an identity rather than as a total, so it survives the next batch.
  assert.equal(files.segments.segments.length, used.size + held.length);
});

/* ---------------------------------------------------- the recorded mapping */

test("every label resolves to exactly one segment by (episode, duration)", () => {
  // This is the derivation the migration did once. Re-running it here is what
  // makes `label` in the data trustworthy rather than decorative: if anyone
  // hand-edits a segment_id, the label no longer picks it out uniquely.
  for (const f of files.forays.forays) {
    for (const item of f.items.filter((i) => i.type === "segment")) {
      const dur = durationOf(files, item.segment_id);
      const episode = f.label_prefixes[item.label.split("-")[0]];
      const matches = files.segments.segments.filter(
        (s) => s.item_id === episode && Math.abs(s.end_sec - s.start_sec - dur) <= 0.06
      );
      assert.equal(matches.length, 1, `${f.id} ${item.label}: ${matches.length} segments match`);
      assert.equal(matches[0].id, item.segment_id, `${f.id} ${item.label} resolved to ${matches[0].id}`);
    }
  }
});

/* Each Foray's §2 running-order table, and where it stops. Adding a Foray means
 * adding a row here, which is the point: the doc table and `items` must not be
 * able to move independently. Foray #2 was authored with its §2 claiming this
 * test covered it while the test read only grilling-foray.md — the claim was
 * true of #1 and false of #2 for one commit. */
const RUNNING_ORDER_DOCS = [
  { forayId: "grilling-history-1", doc: "docs/curation/grilling-foray.md", endsBefore: "### Why the order", rows: 32 },
  { forayId: "grilling-history-2", doc: "docs/curation/grilling-history-assembly.md", endsBefore: "### 2a.", rows: 10 },
  { forayId: "capital-types-1", doc: "docs/curation/foray2-capital.md", endsBefore: "### Why the slots run", rows: 22 },
];

test("every committed Foray has a running-order doc pinned above", () => {
  /* RUNNING_ORDER_DOCS drives a loop, and `test/suite-integrity.test.js` counts
   * top-level `test(` DECLARATIONS — so deleting an entry from that array would
   * delete a real test without moving the floor. This assertion is what makes
   * that deletion loud instead, and it is also what stops Foray #3 landing with
   * its §2 table unpinned, which is the mistake Foray #2 shipped with. */
  assert.deepEqual(
    RUNNING_ORDER_DOCS.map((d) => d.forayId),
    files.forays.forays.map((f) => f.id)
  );
  for (const { doc } of RUNNING_ORDER_DOCS) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, doc)), `${doc} is missing`);
  }
});

for (const { forayId, doc, endsBefore, rows: expectedRows } of RUNNING_ORDER_DOCS) {
  test(`data/forays.json agrees with ${path.basename(doc)} §2, row for row`, () => {
    /* #182's third consequence is that the order "silently rots": change the data
     * and the doc goes stale, or the reverse, with nothing to detect the drift.
     * So the doc table is parsed and compared — position, label, duration and
     * role — and the two cannot move independently any more.
     *
     * If this fails because the TABLE was reformatted rather than because the
     * order changed, update the regex below; do not delete the test. */
    const md = fs.readFileSync(path.join(REPO_ROOT, doc), "utf8");
    const section = md.split("## 2. The running order")[1]?.split(endsBefore)[0];
    assert.ok(section, `could not find §2 in ${doc}`);
    const rows = [...section.matchAll(/^\|\s*(\d+)\s*\|\s*[\d:]+\s*\|\s*([A-Z]+-\d+)\s*\|\s*([\d.]+) s\s*\|\s*(\w+)\s*\|/gm)];
    assert.equal(rows.length, expectedRows, `§2's table no longer parses as ${expectedRows} numbered rows`);

    const items = forayBy(files, forayId).items.filter((i) => i.type === "segment");
    for (const [i, [, n, label, dur, role]] of rows.entries()) {
      assert.equal(Number(n), i + 1, `§2's rows are not numbered 1..${expectedRows} in order`);
      assert.equal(items[i].label, label, `position ${n}: data says ${items[i].label}, doc says ${label}`);
      assert.equal(items[i].role, role, `${label}: data says ${items[i].role}, doc says ${role}`);
      assert.ok(
        Math.abs(durationOf(files, items[i].segment_id) - Number(dur)) <= 0.06,
        `${label}: segment is ${durationOf(files, items[i].segment_id)} s, doc says ${dur} s`
      );
    }
  });
}

test("labels are unique and every prefix is declared, in every Foray", () => {
  for (const f of files.forays.forays) {
    const labels = f.items.filter((i) => i.type === "segment").map((i) => i.label);
    assert.equal(new Set(labels).size, labels.length, `${f.id} has duplicate labels`);
    for (const l of labels) assert.ok(f.label_prefixes[l.split("-")[0]], `${f.id}: no prefix entry for ${l}`);
  }
});

test("GRID-3's incidental mapping in the doc agrees with label_prefixes", () => {
  // grilling-foray.md line 578 is the one committed label -> id example that
  // predates this file. It names a held-back segment, so it is checked here
  // rather than through the running order.
  assert.equal(foray0(files).label_prefixes.GRID, "bfh-griddle-bakestone");
});

test("a label pointing at the wrong episode is rejected", () => {
  const f = clone();
  const item = foray0(f).items.find((i) => i.label === "ORI-1");
  item.segment_id = "moreish-jerk-jamaica#266";
  assert.match(errorsFor(f).join("\n"), /label "ORI-1" maps to episode/);
});

test("a segment id that is not in the pool is rejected", () => {
  const f = clone();
  foray0(f).items[0].segment_id = "not-a-real-episode#1";
  assert.match(errorsFor(f).join("\n"), /unknown segment_id/);
});

test("the same segment twice in one Foray is rejected", () => {
  const f = clone();
  foray0(f).items[5].segment_id = foray0(f).items[4].segment_id;
  assert.match(errorsFor(f).join("\n"), /appears twice/);
});

test("a stated runtime that drifts from the items is rejected", () => {
  const f = clone();
  foray0(f).runtime_sec = 3600;
  assert.match(errorsFor(f).join("\n"), /runtime_sec` says/);
});

/* ------------------------------------------------------------------- D1 */

test("D1 passes on the committed order with the budget exactly met", () => {
  const r = checkForays(files).report.forays[0];
  assert.equal(r.d1_budget, 6, "61:13 falls in the 45-120 minute band");
  assert.equal(r.d1_max_starts_in_window, 6);
});

test("D1 FAILS when GRID-3 — dropped in §5 to fit the budget — is put back", () => {
  // The sharpest possible D1 test, because it is the exact edit §5 says was
  // required in reverse. GRID-3 goes back into the pre-modern slot in its
  // chronological position, so M3 still holds and the slot stays contiguous.
  // The ONLY error this produces is D1: verified, and asserted below.
  const f = clone();
  const errors = errorsFor(putGrid3Back(f));
  assert.equal(errors.length, 1, `expected D1 alone, got:\n${errors.join("\n")}`);
  assert.match(errors[0], /D1 FAIL: 7 segment starts inside a 600 s window \(budget 6/);
});

test("the CLI exits 1 on a D1-breaking order (the red-CI proof)", () => {
  const { status, stderr } = runCli(mutatedCheckout(putGrid3Back));
  assert.equal(status, 1, "the CLI must exit non-zero");
  assert.match(stderr, /D1 FAIL/);
  assert.doesNotMatch(stderr, /D5 FAIL/, "this mutation must isolate D1");
});

test("D1 FAILS on a pathological shortest-first order", () => {
  // Shortest-first packs the most starts into every window. Unlike the GRID-3
  // case this trips D5 and M3 as well, which is the point: a Foray can fail
  // several tier-A rules at once and all of them must be reported, not the
  // first one found.
  const f = clone();
  foray0(f).items.sort((a, b) => durationOf(f, a.segment_id) - durationOf(f, b.segment_id));
  const kinds = new Set(errorsFor(f).map((e) => e.match(/(D\d|M\d) FAIL/)?.[0]).filter(Boolean));
  assert.ok(kinds.has("D1 FAIL"), [...kinds].join(", "));
  assert.ok(kinds.has("D5 FAIL"), [...kinds].join(", "));
  assert.ok(kinds.has("M3 FAIL"), [...kinds].join(", "));
});

test("d1Budget follows the 45 / 120 minute bands", () => {
  assert.equal(d1Budget(30 * 60), 8);
  assert.equal(d1Budget(45 * 60), 8);
  assert.equal(d1Budget(45 * 60 + 1), 6);
  assert.equal(d1Budget(120 * 60), 6);
  assert.equal(d1Budget(120 * 60 + 1), 5);
});

test("maxStartsInWindow counts starts, not gaps", () => {
  // Five starts 100 s apart span 400 s; all five sit inside one 600 s window.
  assert.equal(maxStartsInWindow([0, 100, 200, 300, 400]).count, 5);
  // Two starts 600 s apart do not: the window is half-open.
  assert.equal(maxStartsInWindow([0, 600]).count, 1);
});

test("the committed order's tightest seven-start span is the doc's 620.5 s", () => {
  // grilling-foray.md §5 reports 620.5 s and calls it "the tightest run of
  // six". It counts the six gaps; this counts the seven starts that bound
  // them. Pinned so the two never quietly disagree again.
  const items = foray0(files).items;
  const starts = [];
  let t = 0;
  for (const i of items) { starts.push(t); t += durationOf(files, i.segment_id); }
  let tightest = Infinity;
  for (let i = 0; i + 6 < starts.length; i++) tightest = Math.min(tightest, starts[i + 6] - starts[i]);
  assert.equal(Math.round(tightest * 10) / 10, 620.5);
  assert.ok(tightest > D1_WINDOW_SEC);
});

/* ------------------------------------------------------------------- D5 */

test("D5 (pairwise) passes on the committed order", () => {
  assert.equal(checkForays(files).report.forays[0].d5_pairwise_violations, 0);
});

test("D5 FAILS when three near-equal segments are made consecutive", () => {
  const f = clone();
  const items = foray0(f).items;
  // MED-1/MED-2/MED-3 are 102.5 / 100.2 / 113.9 s — within 13.7 % of each
  // other. Batch 1 warned they must never be played adjacently; the committed
  // order obeys that. Force it and the gate must fire.
  const pick = (label) => items.find((i) => i.label === label);
  const [a, b, c] = [pick("MED-1"), pick("MED-2"), pick("MED-3")];
  const rest = items.filter((i) => ![a, b, c].includes(i));
  foray0(f).items = [...rest.slice(0, 4), a, b, c, ...rest.slice(4)];
  const msg = errorsFor(f).join("\n");
  assert.match(msg, /D5 FAIL: MED-1 \/ MED-2 \/ MED-3/);
});

test("D5 FAILS in isolation on the one swap that breaks only D5", () => {
  // Exhaustively searched: of the 496 pair swaps of the real running order,
  // SM-1 <-> TRA-1 is the only one whose sole violation is D5. Everything else
  // trips D1 too, because D1 sits exactly at budget. That makes this the
  // honest D5 proof — a red build here can mean nothing else.
  const errors = errorsFor(swapSmAndTra1(clone()));
  assert.equal(errors.length, 2, `expected D5 alone, got:\n${errors.join("\n")}`);
  for (const e of errors) assert.match(e, /D5 FAIL/);
  assert.match(errors[0], /ARG-6 \/ ARG-7 \/ SM-1/);
});

test("the CLI exits 1 on a D5-breaking order (the red-CI proof)", () => {
  const { status, stderr } = runCli(mutatedCheckout(swapSmAndTra1));
  assert.equal(status, 1, "the CLI must exit non-zero");
  assert.match(stderr, /D5 FAIL/);
  assert.doesNotMatch(stderr, /D1 FAIL/, "this mutation must isolate D5");
});

test("d5Triples pairwise fires only when max/min <= 1.2", () => {
  assert.equal(d5Triples([100, 110, 119]).length, 1);
  assert.equal(d5Triples([100, 110, 121]).length, 0);
  assert.equal(d5Triples([100, 121, 110]).length, 0, "order within the triple must not matter");
});

test("d5Triples mean-deviation is the stricter reading, and is warn-only", () => {
  // 97.9 / 126.7 / 101.8 — grilling-foray.md §5's MOSS-2/MOSS-3/SM-1. Pairwise
  // says fine (max/min 1.294); mean-deviation says violation.
  const t = [97.9, 126.7, 101.8];
  assert.equal(d5Triples(t, { reading: "pairwise" }).length, 0);
  assert.equal(d5Triples(t, { reading: "mean-deviation" }).length, 1);
  const { warnings, errors } = checkForays(files);
  assert.equal(errors.length, 0);
  const md = (id) => warnings.filter((w) => /mean-deviation/.test(w) && w.includes(id)).length;
  assert.equal(md("grilling-history-1"), 3, "the three grilling-foray.md §5 names");
  assert.equal(md("capital-types-1"), 2, "the two foray2-capital.md §5 names");
});

test("the tightest pairwise triple is MOSS-2/MOSS-3/SM-1, not ARG-5/6/7", () => {
  // §5 named ARG-5/6/7 at +32 % as the closest call; it is 1.3204 and
  // MOSS-2/MOSS-3/SM-1 is 1.2945, so the doc had the wrong triple. Corrected
  // there and pinned here, because an unpinned number is what drifted.
  const durations = foray0(files).items.map((i) => durationOf(files, i.segment_id));
  let tightest = { ratio: Infinity, at: -1 };
  for (let i = 0; i + 2 < durations.length; i++) {
    const t = durations.slice(i, i + 3);
    const ratio = Math.max(...t) / Math.min(...t);
    if (ratio < tightest.ratio) tightest = { ratio, at: i };
  }
  const names = foray0(files).items.slice(tightest.at, tightest.at + 3).map((i) => i.label);
  assert.deepEqual(names, ["MOSS-2", "MOSS-3", "SM-1"]);
  assert.equal(tightest.ratio.toFixed(4), "1.2945");
  assert.ok(tightest.ratio > 1.2, "and it still clears the rule");
});

test("D5's IQR clause holds at the documented 57.8 s", () => {
  assert.equal(checkForays(files).report.forays[0].d5_iqr_sec, 57.81);
});

test("iqr uses R-7 linear interpolation", () => {
  assert.equal(iqr([1, 2, 3, 4]), 1.5); // q75 3.25, q25 1.75
  assert.equal(iqr([1, 2, 3, 4, 5]), 2);
});

test("D5 FAILS when every segment is the same length (IQR floor)", () => {
  const f = clone();
  // Nine copies of one duration: IQR 0, and every triple pairwise-identical.
  const one = files.segments.segments[0];
  f.segments.segments = Array.from({ length: 9 }, (_, i) => ({ ...one, id: `x#${i}`, item_id: "x" }));
  f.sources.sources = [{ ...f.sources.sources[0], id: "x", duration_sec: one.reference_duration_sec }];
  foray0(f).items = f.segments.segments.map((s, i) => ({ type: "segment", label: `X-${i}`, segment_id: s.id, role: "explanation" }));
  foray0(f).label_prefixes = { X: "x" };
  delete foray0(f).runtime_sec;
  delete foray0(f).slots;
  const msg = errorsFor(f).join("\n");
  assert.match(msg, /interquartile range 0\.0 s is under the 45 s floor/);
});

/* ------------------------------------------------------------- D2/D3/D4/M */

test("L2/L3 hold for every played segment, per §4's role table", () => {
  // Computed directly rather than filtered out of the error list: a test that
  // filters an array another test already asserts is empty cannot fail on its
  // own, and reads as coverage it does not have.
  const floors = { quote: 30, explanation: 60, exchange: 75, narrative: 120 };
  const maxes = { quote: 90, explanation: 360, exchange: 480, narrative: 480 };
  let checked = 0;
  for (const f of files.forays.forays) {
    for (const item of f.items.filter((i) => i.type === "segment")) {
      const d = durationOf(files, item.segment_id);
      assert.ok(d >= floors[item.role], `${f.id} ${item.label} (${item.role}) is ${d} s, under ${floors[item.role]}`);
      assert.ok(d <= maxes[item.role], `${f.id} ${item.label} (${item.role}) is ${d} s, over ${maxes[item.role]}`);
      checked += 1;
    }
  }
  // A loop that silently iterates nothing is the failure this guards against.
  // 32 (#1) + 10 (grilling-history-2, #226) + 22 (capital-types-1).
  assert.equal(checked, 64, "every played segment of every Foray must be checked");
});

test("no segment played by Foray #1 passes L4's 240 s soft maximum", () => {
  // JERK-1 at 237.93 s is the closest, and grilling-foray.md §4 says it was cut
  // 2 s under the line deliberately. Pinned, because L4's escape hatch is the
  // part that is easy to get wrong. Deliberately Foray #1 only: Foray #2 has one
  // segment past 240 s ON PURPOSE (VD-1, 259.88 s), and the test above named
  // "Foray #2's only L4 segment carries both escape-hatch fields" is what holds
  // that case to its `needs_review` + `long_reason` bargain.
  const longest = Math.max(...foray0(files).items.map((i) => durationOf(files, i.segment_id)));
  assert.ok(longest <= 240, `longest is ${longest} s`);
  assert.equal(longest, 237.93);
});

test("L2 FAILS when an `exchange` drops under its 75 s floor", () => {
  const f = clone();
  // TAV-2 is the Foray's only quote, at 51.2 s — legal as a quote (floor 30),
  // illegal as an exchange. Relabelling it is the smallest honest break.
  foray0(f).items.find((i) => i.label === "TAV-2").role = "exchange";
  assert.match(errorsFor(f).join("\n"), /L2 FAIL: TAV-2 is 51\.2 s, under the 75 s floor/);
});

test("L3 FAILS when a `quote` runs past its 90 s ceiling", () => {
  const f = clone();
  foray0(f).items.find((i) => i.label === "JERK-1").role = "quote"; // 237.9 s
  assert.match(errorsFor(f).join("\n"), /L3 FAIL: JERK-1 .* over the 90 s maximum/);
});

test("L4 FAILS on a segment over 240 s with no long_reason", () => {
  const f = clone();
  // JERK-1 is 237.9 s — deliberately cut 2 s under the line, per §4.
  const seg = f.segments.segments.find((s) => s.id === "moreish-jerk-jamaica#266");
  seg.end_sec = seg.start_sec + 250;
  delete foray0(f).runtime_sec;
  assert.match(errorsFor(f).join("\n"), /L4 FAIL: JERK-1/);
});

test("L4's escape hatch is reachable — needs_review + long_reason clears it", () => {
  /* The whole point of L4 is a burden-of-proof flip: past 240 s, SAY WHY.
   * An escape hatch that cannot be satisfied turns it into a silent hard cap.
   * `long_reason` is one of §9's proposed additive fields and
   * merge-segments.mjs does not write it, so the checker also accepts it from
   * the Foray item — and this test is what proves that path actually works. */
  const f = clone();
  const seg = f.segments.segments.find((s) => s.id === "moreish-jerk-jamaica#266");
  seg.end_sec = seg.start_sec + 250;
  /* `moreish-jerk-jamaica#266` is played by BOTH grilling Forays since #226, so
   * stretching the pooled segment reaches every Foray that references it — and
   * this assertion is "no L4 error ANYWHERE", so clearing the hatch on #1 alone
   * would leave grilling-history-2's copy failing and the test red for a reason
   * that is not about the escape hatch. Every Foray playing the segment gets the
   * hatch and drops its stated runtime, which is the same edit #1 always got,
   * applied wherever the segment now appears.
   *
   * `applied` is counted and asserted non-zero for the same reason the L2/L3 loop
   * above pins `checked`: a loop that silently iterates nothing is the failure to
   * guard against. If a later rebuild drops this segment from every running order
   * while leaving it in the pool — the class of edit #226 just made — the `continue`
   * would apply zero hatches, and because the checker's L4 block only walks PLAYED
   * segments, a stretched-but-unplayed segment raises no L4 error at all. The
   * assertion below would then pass green having never exercised the hatch. The
   * single-Foray version this replaced threw a TypeError in that case, which was
   * at least loud; this keeps it loud without depending on a crash. */
  let applied = 0;
  for (const foray of f.forays.forays) {
    const item = foray.items.find((i) => i.segment_id === "moreish-jerk-jamaica#266");
    if (!item) continue;
    delete foray.runtime_sec;
    item.needs_review = true;
    item.long_reason = "One continuous three-community answer; every cut lands mid-claim.";
    applied += 1;
  }
  assert.ok(applied > 0, "no Foray plays moreish-jerk-jamaica#266, so this test proved nothing about L4's escape hatch — point it at a segment that is actually played");
  assert.deepEqual(errorsFor(f).filter((e) => /L4/.test(e)), []);
});

test("L4's escape hatch needs BOTH fields, not either", () => {
  const f = clone();
  const seg = f.segments.segments.find((s) => s.id === "moreish-jerk-jamaica#266");
  seg.end_sec = seg.start_sec + 250;
  delete foray0(f).runtime_sec;
  foray0(f).items.find((i) => i.label === "JERK-1").long_reason = "reason but no flag";
  assert.match(errorsFor(f).join("\n"), /L4 FAIL: JERK-1/);
});

test("D3 FAILS when the mean segment duration drops under 90 s", () => {
  const f = clone();
  for (const s of f.segments.segments) s.end_sec = s.start_sec + 70;
  delete foray0(f).runtime_sec;
  assert.match(errorsFor(f).join("\n"), /D3 FAIL/);
});

test("D2 FAILS when two sub-60 s segments are followed by a short one", () => {
  // No segment in the real Foray but TAV-2 (51.2 s) is under 60 s, so D2 is
  // never exercised by the committed data. Without this test the rule is dead
  // code — and its trailing-pair bug lived behind exactly that gap.
  const f = clone();
  const shrink = (label, sec) => {
    const id = foray0(f).items.find((i) => i.label === label).segment_id;
    const s = f.segments.segments.find((x) => x.id === id);
    s.end_sec = s.start_sec + sec;
  };
  shrink("MED-1", 55);
  shrink("MED-2", 55);
  shrink("GRID-4", 100); // the recovery segment, under the 150 s floor
  delete foray0(f).runtime_sec;
  assert.match(errorsFor(f).join("\n"), /D2 FAIL: two consecutive segments under 60 s at MED-1 are followed by 100\.0 s/);
});

test("D2 FAILS when the Foray ENDS on two sub-60 s segments", () => {
  // The trailing-pair case: a pairwise loop reaches for a recovery segment
  // that does not exist and silently passes. There is no segment left to
  // recover, which is the violation, not an exemption.
  const f = clone();
  for (const label of ["TRA-2", "TRA-3"]) {
    const id = foray0(f).items.find((i) => i.label === label).segment_id;
    const s = f.segments.segments.find((x) => x.id === id);
    s.end_sec = s.start_sec + 55;
  }
  delete foray0(f).runtime_sec;
  assert.match(errorsFor(f).join("\n"), /D2 FAIL: the Foray ends on two consecutive segments under 60 s/);
});

test("D2 reports a run of three once, not once per overlapping pair", () => {
  const f = clone();
  for (const label of ["MED-1", "MED-2", "GRID-4"]) {
    const id = foray0(f).items.find((i) => i.label === label).segment_id;
    const s = f.segments.segments.find((x) => x.id === id);
    s.end_sec = s.start_sec + 55;
  }
  delete foray0(f).runtime_sec;
  const d2 = errorsFor(f).filter((e) => /D2 FAIL/.test(e));
  assert.equal(d2.length, 1, d2.join("\n"));
  assert.match(d2[0], /3 consecutive segments under 60 s starting at MED-1/);
});

test("D4 FAILS on the 20 % share clause", () => {
  const f = clone();
  for (const i of foray0(f).items) i.role = "quote";
  assert.match(errorsFor(f).join("\n"), /D4 FAIL: 32\/32 segments are `quote`/);
});

test("D4 FAILS on the adjacency clause alone, under the 20 % share", () => {
  /* Three adjacent quotes out of 32 is 9.4 % — legal by share, illegal by
   * adjacency. Without this the share clause masks the adjacency loop, and
   * deleting the loop entirely left the suite green. */
  const f = clone();
  for (const label of ["MED-1", "MED-2", "GRID-4"]) {
    foray0(f).items.find((i) => i.label === label).role = "quote";
  }
  const d4 = errorsFor(f).filter((e) => /D4 FAIL/.test(e));
  assert.equal(d4.length, 1, d4.join("\n"));
  assert.match(d4[0], /3 adjacent `quote` segments/);
  assert.doesNotMatch(d4[0], /% cap/, "the share clause must not be what fired");
});

test("an out-of-enum role is rejected (L6)", () => {
  const f = clone();
  foray0(f).items[0].role = "monologue";
  assert.match(errorsFor(f).join("\n"), /is not in the L6 enum/);
});

test("M3 FAILS when two segments from one episode play out of order", () => {
  const f = clone();
  const items = foray0(f).items;
  const a = items.findIndex((i) => i.label === "ARG-1");
  const b = items.findIndex((i) => i.label === "ARG-2");
  [items[a], items[b]] = [items[b], items[a]];
  assert.match(errorsFor(f).join("\n"), /M3 FAIL/);
});

test("M4 FAILS when one episode carries over 25 % of the Foray", () => {
  const f = clone();
  // Keep only the two episodes with the most segments; each then clears 25 %.
  foray0(f).items = foray0(f).items.filter((i) => /^(ARG|MED)-/.test(i.label));
  delete foray0(f).runtime_sec;
  delete foray0(f).slots;
  for (const i of foray0(f).items) delete i.slot;
  assert.match(errorsFor(f).join("\n"), /M4 FAIL/);
});

test("slots are contiguous blocks in the order `slots` declares", () => {
  const f = clone();
  const items = foray0(f).items;
  [items[0], items[items.length - 1]] = [items[items.length - 1], items[0]];
  assert.match(errorsFor(f).join("\n"), /slots are interleaved|slot blocks play as/);
});

test("an item in an undeclared slot is rejected", () => {
  const f = clone();
  foray0(f).items[0].slot = "no-such-slot";
  assert.match(errorsFor(f).join("\n"), /is not declared in `slots`/);
});

/* ------------------------------------------------------- the source registry */

test("every registered source is reported, and every Foray's episodes are registered", () => {
  assert.equal(checkForays(files).report.sources, files.sources.sources.length);
  const registered = new Set(files.sources.sources.map((s) => s.id));
  for (const f of files.forays.forays) {
    for (const i of f.items.filter((x) => x.type === "segment")) {
      const seg = files.segments.segments.find((s) => s.id === i.segment_id);
      assert.ok(registered.has(seg.item_id), `${f.id}: ${seg.item_id} is not registered`);
    }
  }
});

test("every item_id in the segment pool resolves to a source", () => {
  const registered = new Set(files.sources.sources.map((s) => s.id));
  for (const s of files.segments.segments) {
    assert.ok(registered.has(s.item_id), `${s.item_id} has no source entry`);
  }
});

test("source ids are exactly the item_ids the curation docs name", () => {
  assert.deepEqual(
    files.sources.sources.map((s) => s.id).sort(),
    [
      // grilling-history-assembly.md §2a — minted for grilling-history-2 (#226)
      "satay-okay-e01-satay-myth",
      // grilling-history-coverage.md §5 — Act IV's authorship tape (#226)
      "grill-coach-adrian-miller",
      // grilling-foray.md §1
      "bbqc-moss-school",
      "bbqc-traeger-history",
      "bbqrn-argentina-open-fire",
      "bbqrn-santa-maria-grillzilla",
      "bfh-18c-tavern-briggs",
      "bfh-griddle-bakestone",
      "bfh-medieval-meals-manners",
      "moreish-jerk-jamaica",
      "origin-stories-cooking-human",
      // foray2-capital.md §1
      "am-sba-lender-roundtable",
      "crowdcrux-557-atombeam",
      "ftb-89-sbir-grants",
      "rtn-venture-debt",
      "ss-inlaw-investors",
      "tbf-309-funded",
      "tbf-328-tringas",
      "yc-how-fundraising-works",
    ].sort()
  );
});

test("every source has the four fields a player needs", () => {
  for (const s of files.sources.sources) {
    for (const f of ["show", "title", "audio_url"]) assert.ok(s[f], `${s.id} missing ${f}`);
    assert.ok(s.duration_sec > 0, `${s.id} missing duration_sec`);
  }
});

test("every audio_url is https and free of tokens (ci.yml invariant 4, re-asserted)", () => {
  for (const s of files.sources.sources) {
    assert.match(s.audio_url, /^https:\/\//, s.id);
    assert.doesNotMatch(s.audio_url, /[?&](token|auth|api_?key|secret|password|session)=/i, s.id);
  }
});

test("a tokened audio_url is rejected as a secret leak", () => {
  const f = clone();
  f.sources.sources[0].audio_url = "https://cdn.example.com/a.mp3?token=abc123";
  assert.match(errorsFor(f).join("\n"), /tokened/);
});

test("a non-https audio_url is rejected", () => {
  const f = clone();
  f.sources.sources[0].audio_url = "http://cdn.example.com/a.mp3";
  assert.match(errorsFor(f).join("\n"), /must be https/);
});

test("every source carries a boolean dai_suspected (ci.yml invariant 5)", () => {
  for (const s of files.sources.sources) assert.equal(typeof s.dai_suspected, "boolean", s.id);
});

test("a missing dai_suspected is rejected", () => {
  const f = clone();
  delete f.sources.sources[0].dai_suspected;
  assert.match(errorsFor(f).join("\n"), /dai_suspected` must be a boolean/);
});

test("a dai_suspected source cannot carry a played segment (#65 §2)", () => {
  const f = clone();
  f.sources.sources.find((s) => s.id === "origin-stories-cooking-human").dai_suspected = true;
  assert.match(errorsFor(f).join("\n"), /cannot be anchored/);
});

test("no source is DAI-suspected, so every out-point is anchorable", () => {
  for (const s of files.sources.sources) assert.equal(s.dai_suspected, false, s.id);
});

test("a segment whose item_id has no source is rejected", () => {
  const f = clone();
  f.sources.sources = f.sources.sources.filter((s) => s.id !== "moreish-jerk-jamaica");
  assert.match(errorsFor(f).join("\n"), /nothing can resolve its audio/);
});

test("a source duration that disagrees with the pool is rejected", () => {
  const f = clone();
  f.sources.sources[0].duration_sec += 60;
  assert.match(errorsFor(f).join("\n"), /wrong episode registered/);
});

test("each source's feed duration matches its segments' reference_duration_sec", () => {
  for (const s of files.sources.sources) {
    for (const seg of files.segments.segments.filter((x) => x.item_id === s.id)) {
      assert.ok(
        Math.abs(seg.reference_duration_sec - s.duration_sec) <= 2,
        `${s.id}: feed ${s.duration_sec} vs pool ${seg.reference_duration_sec}`
      );
    }
  }
});

test("no segment runs past the end of its episode", () => {
  for (const seg of files.segments.segments) {
    const src = files.sources.sources.find((s) => s.id === seg.item_id);
    assert.ok(seg.end_sec <= src.duration_sec + 2, `${seg.id} ends at ${seg.end_sec}`);
  }
});

/* ------------------------------------------------------------------- copy */

test("the Foray's own copy obeys the shared copy rules", () => {
  // Applied directly against the same BANNED list backend/test/copyRules.test.ts
  // uses, rather than filtered out of an error array another test already
  // asserts is empty. Publisher episode titles are quoted fact and are
  // deliberately not gated; what is gated is what we wrote.
  const f = foray0(files);
  const ours = [f.title, f.summary, ...f.slots.map((s) => s.title)];
  for (const text of ours) {
    assert.ok(text, "a copy field is empty");
    assert.ok(wordCount(text) <= MAX_WHY_LINE_WORDS, `${wordCount(text)} words: "${text}"`);
    for (const rx of BANNED) assert.doesNotMatch(text, rx, `banned ${rx} in "${text}"`);
  }
});

test("a banned phrase in the summary is rejected", () => {
  const f = clone();
  foray0(f).summary = "A fascinating tour of fire.";
  assert.match(errorsFor(f).join("\n"), /banned phrase/);
});

test("an over-long slot title is rejected", () => {
  const f = clone();
  foray0(f).slots[0].title = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen";
  assert.match(errorsFor(f).join("\n"), /over the 18-word limit/);
});

test("`topic` must resolve to a taxonomy node", () => {
  const f = clone();
  foray0(f).topic = "food/not-a-node";
  assert.match(errorsFor(f).join("\n"), /is not a data\/taxonomy\.json node/);
});

test("Foray #1's topic is a real taxonomy node", () => {
  const nodes = new Set(files.taxonomy.nodes.map((n) => n.id));
  assert.ok(nodes.has(foray0(files).topic));
});

/* -------------------------------------------------------------- narration */

/** A well-formed bridge: an id, a length something can read, and an asset — with
    no asset the player drops it, so the checker excludes it from the clock too
    (see "an unvoiced bridge" below). 40 s is a Patch, comfortably inside
    narration-craft.md §0's 20-45 s band. */
const bridge = (extra = {}) => ({
  type: "narration", id: "nar-1", audio_url: "https://cdn.example/nar-1.mp3",
  duration_sec: 40, ...extra,
});

/** A bridge timed by its script rather than by a stamped duration. */
const scripted = (chars, extra = {}) =>
  bridge({ script: "x".repeat(chars), duration_sec: undefined, ...extra });

/** Insert a bridge into a cloned Foray and restate its runtime, because
    `runtime_sec` is now the LISTENER's clock and a bridge moves it. Returns the
    clone so a test can read the errors it actually cares about. */
function withBridges(forayId, inserts) {
  const f = clone();
  const target = forayBy(f, forayId);
  /* Spliced back to front so each index still refers to the position the caller
     meant by the time its turn comes. */
  for (const { at, item } of [...inserts].sort((a, b) => b.at - a.at)) target.items.splice(at, 0, item);
  /* `sec` where the caller passes one, because a bridge timed by its SCRIPT has
     no `duration_sec` to add up. */
  const added = inserts.reduce((t, i) => t + (typeof i.sec === "number" ? i.sec : i.item.duration_sec), 0);
  if (typeof target.runtime_sec === "number") target.runtime_sec = +(target.runtime_sec + added).toFixed(2);
  return f;
}

test("a well-formed narration item is accepted between segments", () => {
  // No bridges are authored yet (grilling-foray.md §5), but #134's shape has
  // them interleaved. A Foray that grows one must not have to change this file.
  assert.deepEqual(errorsFor(withBridges("grilling-history-1", [{ at: 1, item: bridge() }])), []);
});

test("a narration item without an id is rejected", () => {
  const f = clone();
  foray0(f).items.splice(1, 0, { type: "narration", script: "a bridge long enough to be a bridge and not a placeholder" });
  assert.match(errorsFor(f).join("\n"), /narration item needs an id/);
});

/* ---------- narration has to say how long it is ----------

   The gap `docs/narrator-pipeline.md` §1 item 2 records: this file validated a
   narration item's `id` and nothing else, so an item with no script and no audio
   passed — and then contributed 0 s to `runtime_sec`, to D1's window, and to
   every resume arithmetic in the player. */

test("a narration item that nothing can time is REJECTED, not silently free", () => {
  /* The headline. Mutation that kills it: delete this branch, or soften it to
     `W(...)`. Either way an item worth an unknown number of a listener's seconds
     goes back to being worth zero of ours. */
  const f = clone();
  foray0(f).items.splice(1, 0, { type: "narration", id: "nar-1" });
  assert.match(errorsFor(f).join("\n"), /has neither a `duration_sec` nor a `script`/);
});

test("a narration item is timed by EITHER a duration or a script", () => {
  // Mutation: require both. Scripts exist long before audio does —
  // narration-craft.md is explicit that the word budgets are the primitive — so
  // demanding a measured duration at authoring time would block the normal case.
  assert.deepEqual(errorsFor(withBridges("grilling-history-1", [{ at: 1, item: bridge() }])), []);
  const byScript = withBridges("grilling-history-1", [{ at: 1, item: scripted(340), sec: 20 }]);  // 340/17 = 20.0 s
  assert.deepEqual(errorsFor(byScript), []);
});

test("a duration_sec that is not a positive finite number of seconds is rejected", () => {
  /* Mutation: accept anything truthy. `"40"` is the shape a hand-edited JSON
     file produces, and string arithmetic would make the runtime a concatenation
     rather than a sum. 0 is the shape that reintroduces the original defect
     while looking deliberate. */
  for (const bad of [0, -12, "40", null, NaN, {}]) {
    const f = clone();
    foray0(f).items.splice(1, 0, bridge({ duration_sec: bad, script: "x".repeat(340) }));
    assert.match(
      errorsFor(f).join("\n"), /must be a positive finite number of seconds/,
      `duration_sec: ${JSON.stringify(bad)} should be rejected even with a usable script beside it`
    );
  }
});

test("a narration item over the 180 s Carry hard max is rejected, and over 150 s warns", () => {
  /* narration-craft.md §0: "Carry hard max 180 s. The narrator is never the
     longest item in the Foray." Mutation: raise NARRATION_HARD_MAX_SEC, or turn
     the error into a warning — a single 20-minute "bridge" would then pass, and
     narration would be able to eat a Foray one legal item at a time. */
  const over = withBridges("grilling-history-1", [{ at: 1, item: bridge({ duration_sec: 181 }) }]);
  assert.match(errorsFor(over).join("\n"), /over the 180 s Carry hard max/);
  const soft = withBridges("grilling-history-1", [{ at: 1, item: bridge({ duration_sec: 160 }) }]);
  assert.deepEqual(errorsFor(soft), [], "the soft max warns; it does not fail");
  assert.match(checkForays(soft).warnings.join("\n"), /past narration-craft.md §0's 150 s Carry soft max/);
  // And the boundary is inclusive on the passing side, not off by one.
  assert.deepEqual(errorsFor(withBridges("grilling-history-1", [{ at: 1, item: bridge({ duration_sec: 180 }) }])), []);
});

test("a script too short to be a bridge is rejected as a placeholder", () => {
  /* "Two million years later." is 24 characters — 1.4 s. Mutation: drop the
     NARRATION_MIN_SEC check, and a one-word stub passes and contributes 1.4 s
     instead of the real length of whatever eventually gets voiced. That is the
     original defect with a smaller number, which is harder to notice. */
  const f = clone();
  foray0(f).items.splice(1, 0, scripted(24));   // "Two million years later." is 24 characters
  assert.match(errorsFor(f).join("\n"), /24-character script, under narration-craft.md §0's 50-character Hinge floor/);
  /* The boundary is the CHARACTER figure, not the seconds figure, and the row's
     own two numbers disagree: 50 characters at narration-craft's own 17 chars/s
     is 2.94 s, so a hard-coded 3 rejected a 50-character Hinge — the documented
     minimum. Mutation: `NARRATION_MIN_SEC = 3`, and the next line fails. */
  assert.deepEqual(errorsFor(withBridges("grilling-history-1", [{ at: 1, item: scripted(50), sec: 50 / 17 }])), []);
  assert.match(
    errorsFor(withBridges("grilling-history-1", [{ at: 1, item: scripted(49), sec: 49 / 17 }])).join("\n"),
    /Hinge floor/,
    "one character under the documented minimum is still a placeholder"
  );
});

test("an estimated narration length is reported as an estimate; a measured one is not", () => {
  /* A D1 verdict that leans on a character count is only as good as a speaking
     rate nobody has measured (narrator-pipeline.md §6). Mutation: warn
     unconditionally, or not at all — either way the report stops distinguishing
     a fact from a projection. */
  const byScript = withBridges("grilling-history-1", [{ at: 1, item: scripted(340), sec: 20 }]);
  assert.match(checkForays(byScript).warnings.join("\n"), /estimated from the script at 17 chars\/s/);
  const measured = withBridges("grilling-history-1", [{ at: 1, item: bridge() }]);
  assert.doesNotMatch(checkForays(measured).warnings.join("\n"), /estimated from the script/);
});

test("an unvoiced bridge is excluded from the clock and warned about, not counted", () => {
  /* THE TWO GATES MUST AGREE ON WHAT PLAYS. `buildForayQueue` drops a narration
     item with no asset, so the player's `totalSec` excludes it — and
     `player/foray-playback.test.js` asserts `totalSec` matches the committed
     `runtime_sec` to within a second. Counting an unvoiced bridge here would
     therefore make one gate or the other permanently red the moment a script was
     authored, which is the ordinary pre-audio state.

     Mutation: push it into `timeline`/`narrations` anyway. The runtime moves, and
     `runtime_sec` can no longer satisfy both gates at once. */
  const f = clone();
  foray0(f).items.splice(1, 0, { type: "narration", id: "nar-1", script: "x".repeat(340) });
  assert.deepEqual(errorsFor(f), [], "an authored, unvoiced script is not an error");
  const { warnings, report } = checkForays(f);
  assert.match(warnings.join("\n"), /has no usable `audio_url`\/`asset`, so the player drops it/);
  assert.equal(report.forays[0].narration_sec, 0);
  assert.equal(report.forays[0].runtime_sec, 3673.03, "unchanged: nothing extra will play");
});

test("the checker's runtime and the player's agree on a bridged Foray", async () => {
  /* The invariant the test above protects, asserted directly against the real
     player rather than argued about. Mutation: count an unvoiced bridge in the
     checker, or stop counting a voiced one — either way these two diverge. */
  const { resolveForay, indexSegments, indexSources } = await import("../../player/foray-resolve.js");
  const A = "https://cdn.example/nar-1.mp3";
  const cases = [
    bridge(),
    scripted(340),
    { type: "narration", id: "nar-1", script: "x".repeat(340) },
    /* THE CASE THE FIRST VERSION OF THIS TEST MISSED, and the divergence it
       missed. `buildForayQueue` resolves the asset as `audio_url ?? asset`, and
       `??` falls through only on null/undefined — so a PRESENT BUT USELESS
       `audio_url` shadows a good `asset` and the player drops the item. The
       checker's first attempt asked "is either one non-empty", saw the good
       `asset`, and counted seconds the player would never play.

       Mutation: `const url = item.audio_url ?? item.asset` back to
       `!nonEmptyString(item.audio_url) && !nonEmptyString(item.asset)` — the last
       four rows below diverge by 40 s each. */
    bridge({ audio_url: undefined, asset: A }),
    bridge({ audio_url: null, asset: A }),
    bridge({ audio_url: "", asset: A }),
    bridge({ audio_url: "   ", asset: A }),
    bridge({ audio_url: 0, asset: A }),
    bridge({ audio_url: false, asset: A }),
  ];
  for (const item of cases) {
    const f = clone();
    forayBy(f, "grilling-history-1").items.splice(1, 0, item);
    const checker = checkForays(f).report.forays[0].runtime_sec;
    const r = resolveForay(forayBy(f, "grilling-history-1"), {
      segments: indexSegments(f.segments), sources: indexSources(f.sources),
    });
    assert.ok(
      Math.abs(checker - r.totalSec) < 0.5,
      `checker ${checker} vs player ${r.totalSec} for ${JSON.stringify(item).slice(0, 60)}`
    );
  }
});

test("a narration asset must be https and must not be tokened", () => {
  /* The same two lexical checks every `segment-sources` audio_url gets. This
     field only became load-bearing in this change, and the failures are the
     identical ones: an http:// media load blocked by the CSP, or a credential
     committed to a data file. Mutation: drop either regex. */
  const insecure = withBridges("grilling-history-1", [{ at: 1, item: bridge({ audio_url: "http://cdn.example/n.mp3" }) }]);
  assert.match(errorsFor(insecure).join("\n"), /asset must be https/);
  const tokened = withBridges("grilling-history-1", [{ at: 1, item: bridge({ audio_url: "https://cdn.example/n.mp3?token=abc" }) }]);
  assert.match(errorsFor(tokened).join("\n"), /asset looks tokened/);
  // Via `asset` too, not only `audio_url` — the player reads either.
  const viaAsset = withBridges("grilling-history-1", [{ at: 1, item: bridge({ audio_url: undefined, asset: "http://cdn.example/n.mp3" }) }]);
  assert.match(errorsFor(viaAsset).join("\n"), /asset must be https/);
});

test("the Hinge floor judges the SCRIPT, not the audio", () => {
  /* A measured 2.5 s recording of a legal 50-character Hinge is a fact about a
     file, not a placeholder — and real TTS of 50 characters lands anywhere in
     roughly 2.5-3.5 s, so a seconds floor applied to `dur.sec` would have been a
     routine false positive the moment `tools/narrate/` started stamping
     durations. What the floor detects is a stub script.

     Mutation: compare `dur.sec < NARRATION_MIN_SEC` again. The first assertion
     fails, and the second stops failing for a stub script that happens to carry
     a generous stamped duration. */
  const shortAudio = withBridges("grilling-history-1", [
    { at: 1, item: bridge({ duration_sec: 2.5, script: "x".repeat(50) }) },
  ]);
  assert.deepEqual(errorsFor(shortAudio), []);
  const stub = clone();
  foray0(stub).items.splice(1, 0, bridge({ duration_sec: 40, script: "TODO" }));
  assert.match(errorsFor(stub).join("\n"), /4-character script, under narration-craft.md §0's 50-character Hinge floor/);
});

test("a bridge that OPENS a Foray must declare its own slot", () => {
  /* It has no preceding item to inherit one from, so `groupBySlot` appends it to
     a trailing untitled section — the Foray renders with its first item last.
     Silent, which is why it is an error rather than a comment.
     Mutation: drop the `played.length === 0` branch. */
  const f = clone();
  foray0(f).items.unshift(bridge({ duration_sec: 40 }));
  assert.match(errorsFor(f).join("\n"), /opens the Foray, so it has no preceding item to inherit a `slot` from/);
  // Declaring one is all it takes.
  const declared = clone();
  const target = forayBy(declared, "grilling-history-1");
  target.items.unshift(bridge({ duration_sec: 40, slot: target.slots[0].id }));
  target.runtime_sec = +(target.runtime_sec + 40).toFixed(2);
  assert.deepEqual(errorsFor(declared), []);
});

test("an unvoiced bridge is neither counted as unresolved nor erased from the report", () => {
  /* Two separate ways the report lied about the state the checker deliberately
     permits. Mutations: drop `- unvoiced` from the tally, and drop
     `narration_unvoiced` from the report. */
  const f = clone();
  const target = forayBy(f, "grilling-history-1");
  target.items.splice(1, 0, { type: "narration", id: "nar-1", script: "x".repeat(340), slot: target.items[0].slot });
  target.items.push({ type: "segment", slot: "arc-1", segment_id: "does-not-exist" });
  const { warnings, report } = checkForays(f);
  assert.match(warnings.join("\n"), /^foray "grilling-history-1": 1 item\(s\) did not resolve/m);
  assert.equal(report.forays[0].narration_unvoiced, 1);
  assert.equal(report.forays[0].narration_items, 0, "it will not play, so it is not in the clock");
});

test("a narration item with no id is dropped from the clock, like its sibling rejections", () => {
  /* It carried on with `id: null`, so an item nothing can name was still counted
     in `runtime_sec` — inconsistent with the three rejections beside it, and it
     put a second, spurious `runtime_sec` error on top of the real one.
     Mutation: remove the `continue` after the id error. */
  const f = clone();
  foray0(f).items.splice(1, 0, bridge({ id: undefined }));
  const errors = errorsFor(f);
  assert.equal(errors.length, 1, errors.join("\n"));
  assert.match(errors[0], /a narration item needs an id/);
  assert.equal(checkForays(f).report.forays[0].runtime_sec, 3673.03);
});

test("a duplicate narration id is rejected rather than silently rewritten", () => {
  /* The builder renames a collision to `${forayId}#${index}` and warns, which is
     a safe failure and a baffling one — the id the author wrote is not the id
     anything plays. Segment ids and labels are already checked here; this closes
     the third case. Mutation: drop `seenNarrationIds`. */
  const f = withBridges("grilling-history-1", [
    { at: 1, item: bridge() },
    { at: 5, item: bridge() },
  ]);
  assert.match(errorsFor(f).join("\n"), /narration id "nar-1" appears twice in one Foray/);
});

test("a narration item cannot declare a slot the Foray does not have", () => {
  // Mutation: drop the check. A bridge in an undeclared slot renders in a
  // trailing untitled section, out of authored order.
  const f = withBridges("grilling-history-1", [{ at: 1, item: bridge({ slot: "not-a-slot" }) }]);
  assert.match(errorsFor(f).join("\n"), /declares slot "not-a-slot", which is not in `slots`/);
});

test("an over-long bridge is dropped from the clock, not left to distort every other verdict", () => {
  /* Mutation: remove the `continue` after the hard-max error. A
     `duration_sec: 1e6` bridge then drags `runtime` to 12 days, flips the D1
     band to 5, and buries the one real error under a spurious `runtime_sec`
     drift and a D1 failure that is an artefact of the first mistake. */
  const f = clone();
  foray0(f).items.splice(1, 0, bridge({ duration_sec: 1e6 }));
  const errors = errorsFor(f);
  assert.equal(errors.length, 1, errors.join("\n"));
  assert.match(errors[0], /over the 180 s Carry hard max/);
  assert.equal(checkForays(f).report.forays[0].runtime_sec, 3673.03);
});

test("valid narration items are not counted as items that failed to resolve", () => {
  /* `played` is tape only, so subtracting it from the whole item list reported
     every good bridge as a failure: "4 item(s) did not resolve" for one bad
     segment and three fine bridges. Mutation: drop `- narrations.length`. */
  const f = withBridges("grilling-history-1", [
    { at: 1, item: bridge() },
    { at: 5, item: bridge({ id: "nar-2" }) },
    { at: 9, item: bridge({ id: "nar-3" }) },
  ]);
  forayBy(f, "grilling-history-1").items.push({ type: "segment", slot: "arc-1", segment_id: "does-not-exist" });
  assert.match(checkForays(f).warnings.join("\n"), /^foray "grilling-history-1": 1 item\(s\) did not resolve/m);
});

test("`runtime_sec` is the listener's clock, so a Foray that gains a bridge must restate it", () => {
  /* Mutation: compare `runtime_sec` against `tapeRuntime`. The stated runtime
     would then agree with a number no listener experiences, and the drift
     detector would stop noticing that 23 minutes of narrator had been added. */
  const f = clone();
  foray0(f).items.splice(1, 0, bridge());          // +40 s, runtime_sec untouched
  assert.match(errorsFor(f).join("\n"), /`runtime_sec` says 3673\.03 but the items sum to 3713\.03 \(3673\.03 of tape \+ 40\.00 of narration\)/);
});

test("the report keeps the two clocks apart", () => {
  // Mutation: report `tape_runtime_sec: runtime`. Nothing would fail, and the
  // one number that says how much of a Foray is narrator would silently be 0.
  const f = withBridges("grilling-history-1", [{ at: 1, item: bridge() }, { at: 5, item: bridge({ id: "nar-2", duration_sec: 60 }) }]);
  const r = checkForays(f).report.forays[0];
  assert.equal(r.tape_runtime_sec, 3673.03);
  assert.equal(r.narration_sec, 100);
  assert.equal(r.runtime_sec, 3773.03);
  assert.equal(r.narration_items, 2);
  assert.equal(r.narration_share, +(100 / 3773.03).toFixed(4));
  // The per-segment rules are unmoved, because they are rules about tape.
  assert.equal(r.mean_sec, 114.8);
  assert.equal(r.d5_iqr_sec, 57.81);
});

/* ---------- D1 on the listener's clock, proved on a purpose-built Foray ----

   #236's recommendation, and the only honest way to prove a D1 movement: the two
   grilling Forays carry ~130 assertion sites between them and `grilling-history-2`
   is what the founder listens to, so a proof that needs particular durations
   builds its own tape rather than bending theirs. These segments and sources are
   synthetic, they exist only inside the returned clone, and nothing on disk
   moves.

   Nine 60-second segments is the whole point of the shape: tape-only they are
   nine starts inside one 600 s window against a budget of 8, which fails by
   exactly one. */

const NINE_SIXTIES = Array.from({ length: 9 }, () => 60);

/**
 * Append a synthetic Foray to a clone. `spec` is a list of numbers (segment
 * lengths in seconds, one synthetic episode each so M4 can never be the thing
 * that fires) and narration objects.
 */
function fixtureForay(spec, { forayId = "fixture-1" } = {}) {
  const f = clone();
  const items = [];
  let n = 0;
  for (const s of spec) {
    if (typeof s !== "number") {
      items.push({ type: "narration", audio_url: `https://cdn.example/${s.id}.mp3`, slot: "one", ...s });
      continue;
    }
    const eid = `${forayId}-ep${n}`;
    const sid = `${forayId}-seg${n}`;
    f.sources.sources.push({
      id: eid, show: "Fixture Show", title: `Fixture episode ${n}`,
      audio_url: `https://cdn.example/${eid}.mp3`, audio_type: "audio/mpeg",
      duration_sec: 3600, dai_suspected: false,
    });
    f.segments.segments.push({
      id: sid, item_id: eid, start_sec: 100, end_sec: 100 + s, reference_duration_sec: 3600,
    });
    items.push({ type: "segment", slot: "one", segment_id: sid });
    n++;
  }
  f.forays.forays.push({
    id: forayId, kind: "deep-dive", status: "draft", topic: foray0(files).topic,
    title: "A fixture Foray", summary: "A fixture Foray",
    slots: [{ id: "one", title: "One" }], items,
  });
  return f;
}

const d1FailsIn = (f, forayId = "fixture-1") =>
  errorsFor(f).some((e) => e.includes(`foray "${forayId}"`) && e.includes("D1 FAIL"));

test("the D1 fixture fails on tape alone — nine 60 s segments, budget 8", () => {
  // The control. If this ever stops failing, every assertion below is vacuous:
  // they would be proving that a passing Foray passes.
  assert.equal(d1FailsIn(fixtureForay(NINE_SIXTIES)), true);
});

test("D1's 600 s window is the listener's clock, and a bridge is not a segment start", () => {
  /* The same nine segments, with two 60 s bridges dropped in. Nothing about the
     tape changed; the ninth start simply now falls at 600 s of PLAYBACK instead
     of 480 s, which is §5c's "600-second window of Foray playback".

     TWO mutations kill this, in opposite directions, and that is the point:

       - stop advancing the clock for narration (`clock += entry.duration` only
         for segments) and the nine starts crowd back into one window: FAIL.
       - count a bridge AS a start (`starts.push(clock)` unconditionally) and the
         window from zero holds eight segment starts plus two bridges: also FAIL.

     Only the ruling actually implemented — narration occupies the clock, and is
     not itself a cut — passes. */
  const bridged = fixtureForay([
    60, 60, 60,
    { id: "nar-a", duration_sec: 60 },
    60, 60, 60,
    { id: "nar-b", duration_sec: 60 },
    60, 60, 60,
  ]);
  assert.equal(d1FailsIn(bridged), false);
  const r = checkForays(bridged).report.forays.find((x) => x.id === "fixture-1");
  assert.equal(r.tape_runtime_sec, 540);
  assert.equal(r.runtime_sec, 660);
  assert.equal(r.d1_max_starts_in_window, 8, "eight tape starts, not ten items");
  assert.equal(r.d1_budget, 8);
});

test("D1's budget BAND is set by the listener's clock too", () => {
  /* §5c's bands are by "total Foray duration", and a Foray's duration is what a
     listener sits through. Forty 60 s segments is 40 min of tape — band N=8 — and
     stays 40 min of tape when 9 minutes of narrator is added on top, at which
     point it is a 49-minute Foray and the band is N=6.

     Mutation: `d1Budget(tapeRuntime)`. The band stays 8 and a Foray the listener
     experiences as 49 minutes long is judged against the under-45-minute
     allowance. */
  const tape = Array.from({ length: 40 }, () => 60);
  const bare = checkForays(fixtureForay(tape)).report.forays.find((x) => x.id === "fixture-1");
  assert.equal(bare.runtime_sec, 2400);
  assert.equal(bare.d1_budget, 8);

  // Nine 60 s bridges: 540 s, taking the Foray to 49 minutes.
  const withNarration = fixtureForay([
    ...tape.slice(0, 20),
    ...Array.from({ length: 9 }, (_, i) => ({ id: `nar-${i}`, duration_sec: 60 })),
    ...tape.slice(20),
  ]);
  const r = checkForays(withNarration).report.forays.find((x) => x.id === "fixture-1");
  assert.equal(r.tape_runtime_sec, 2400);
  assert.equal(r.runtime_sec, 2940);
  assert.equal(r.d1_budget, 6, "a 49-minute Foray is in the 45-120 band");
});

test("M4's denominator stays the tape, so narration cannot buy a Foray under the cap", () => {
  /* M4 asks whether one episode dominates the SOURCING. Two segments of one
     episode against one of another is 62.0 % of the tape and fails; adding six
     minutes of narrator does not rebalance the sourcing by one second, so the
     reported share must not move.

     Mutation: `e.sec / runtime`. The share falls to 31.1 % — still over the cap
     here, but on a marginal Foray the same change would let narration buy a pass
     that no editorial decision earned. */
  const spec = [153, 149, 101];
  const bare = errorsFor(fixtureForay(spec)).filter((e) => e.includes("M4 FAIL"));
  const padded = errorsFor(fixtureForay([spec[0], spec[1], { id: "nar-a", duration_sec: 180 }, spec[2], { id: "nar-b", duration_sec: 180 }]))
    .filter((e) => e.includes("M4 FAIL"));
  assert.ok(bare.length > 0, "the fixture has to fail M4 for this to be testing anything");
  assert.deepEqual(padded, bare);
});

test("the CLI exits 1 on a bridge nothing can time", () => {
  /* Same discipline as the D1/D5 proofs below: the real CLI, a mutated
     checkout, and the exit code — not an inspection of the code. This is also
     what proves the new `player/foray-queue.js` import resolves when the CLI is
     spawned as its own process with no install step, which is the one risk the
     shared-rule import carries. (`mutatedCheckout` writes only `data/`, so this
     is not a bare-checkout test — `--root` moves the data, not the code.) */
  const root = mutatedCheckout((f) => {
    foray0(f).items.splice(1, 0, { type: "narration", id: "nar-1" });
  });
  const { status, stderr } = runCli(root);
  assert.equal(status, 1);
  assert.match(stderr, /has neither a `duration_sec` nor a `script`/);
});

test("an unknown item type is rejected", () => {
  const f = clone();
  foray0(f).items.splice(1, 0, { type: "advert", id: "no" });
  assert.match(errorsFor(f).join("\n"), /unknown item type/);
});

test("`kind` must be deep-dive", () => {
  const f = clone();
  foray0(f).kind = "ladder";
  assert.match(errorsFor(f).join("\n"), /`kind` must be "deep-dive"/);
});

test("two Forays may not share an id", () => {
  const f = clone();
  f.forays.forays.push(structuredClone(foray0(f)));
  assert.match(errorsFor(f).join("\n"), /duplicate foray id/);
});

/* ----------------------------------------------------------------- helpers */

/** Put GRID-3 back where §5 says it was cut from: the pre-modern slot, in
 * chronological position between GRID-2 (968 s) and GRID-4 (1691 s). Breaks
 * D1 and nothing else. */
function putGrid3Back(f) {
  const foray = f.forays.forays[0];
  const at = foray.items.findIndex((i) => i.label === "GRID-4");
  foray.items.splice(at, 0, {
    type: "segment",
    slot: "pre-modern-hearth",
    label: "GRID-3",
    segment_id: "bfh-griddle-bakestone#1360",
    role: "quote",
  });
  delete foray.runtime_sec; // 33 segments obviously do not sum to 3,673 s
  return f;
}

/** Swap SM-1 and TRA-1. Breaks D5 and nothing else — see the test. The slot
 * declaration goes because the two are in different arc slots. */
function swapSmAndTra1(f) {
  const foray = f.forays.forays[0];
  const a = foray.items.findIndex((i) => i.label === "SM-1");
  const b = foray.items.findIndex((i) => i.label === "TRA-1");
  [foray.items[a], foray.items[b]] = [foray.items[b], foray.items[a]];
  delete foray.slots;
  for (const i of foray.items) delete i.slot;
  return f;
}

/** Write a checkout containing only the four files the checker reads, with
 * `mutate` applied to the parsed copies. Returns the temp root. */
function mutatedCheckout(mutate) {
  const f = clone();
  mutate(f);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foray-check-"));
  fs.mkdirSync(path.join(root, "data"));
  for (const [name, value] of [
    ["forays.json", f.forays],
    ["segments.json", f.segments],
    ["segment-sources.json", f.sources],
    ["taxonomy.json", f.taxonomy],
  ]) {
    fs.writeFileSync(path.join(root, "data", name), JSON.stringify(value, null, 2) + "\n");
  }
  return root;
}

function runCli(root) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, "--root", root], { encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return { status: e.status, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
  }
}
