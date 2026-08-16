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

test("there is exactly one Foray, and it is #134's kind", () => {
  assert.equal(files.forays.forays.length, 1);
  assert.equal(foray0(files).kind, "deep-dive");
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

test("the four pool segments held back in §7 are not in the running order", () => {
  const used = new Set(foray0(files).items.map((i) => i.segment_id));
  const held = [
    "bbqc-moss-school#1881", // MOSS-G
    "bbqc-traeger-history#2457", // TRA-4
    "bbqrn-argentina-open-fire#2292", // ARG-8
    "bfh-griddle-bakestone#1360", // GRID-3
  ];
  for (const id of held) assert.ok(!used.has(id), `${id} should be held back`);
  assert.equal(files.segments.segments.length, 32 + held.length);
});

/* ---------------------------------------------------- the recorded mapping */

test("every label resolves to exactly one segment by (episode, duration)", () => {
  // This is the derivation the migration did once. Re-running it here is what
  // makes `label` in the data trustworthy rather than decorative: if anyone
  // hand-edits a segment_id, the label no longer picks it out uniquely.
  const f = foray0(files);
  for (const item of f.items) {
    const dur = durationOf(files, item.segment_id);
    const episode = f.label_prefixes[item.label.split("-")[0]];
    const matches = files.segments.segments.filter(
      (s) => s.item_id === episode && Math.abs(s.end_sec - s.start_sec - dur) <= 0.06
    );
    assert.equal(matches.length, 1, `${item.label}: ${matches.length} segments match`);
    assert.equal(matches[0].id, item.segment_id, `${item.label} resolved to ${matches[0].id}`);
  }
});

test("data/forays.json agrees with grilling-foray.md §2, row for row", () => {
  /* #182's third consequence is that the order "silently rots": change the data
   * and the doc goes stale, or the reverse, with nothing to detect the drift.
   * So the doc table is parsed and compared — position, label, duration and
   * role — and the two cannot move independently any more.
   *
   * If this fails because the TABLE was reformatted rather than because the
   * order changed, update the regex below; do not delete the test. */
  const md = fs.readFileSync(path.join(REPO_ROOT, "docs/curation/grilling-foray.md"), "utf8");
  const section = md.split("## 2. The running order")[1]?.split("### Why the order")[0];
  assert.ok(section, "could not find §2 in grilling-foray.md");
  const rows = [...section.matchAll(/^\|\s*(\d+)\s*\|\s*[\d:]+\s*\|\s*([A-Z]+-\d+)\s*\|\s*([\d.]+) s\s*\|\s*(\w+)\s*\|/gm)];
  assert.equal(rows.length, 32, "§2's table no longer parses as 32 numbered rows");

  const items = foray0(files).items;
  for (const [i, [, n, label, dur, role]] of rows.entries()) {
    assert.equal(Number(n), i + 1, "§2's rows are not numbered 1..32 in order");
    assert.equal(items[i].label, label, `position ${n}: data says ${items[i].label}, doc says ${label}`);
    assert.equal(items[i].role, role, `${label}: data says ${items[i].role}, doc says ${role}`);
    assert.ok(
      Math.abs(durationOf(files, items[i].segment_id) - Number(dur)) <= 0.06,
      `${label}: segment is ${durationOf(files, items[i].segment_id)} s, doc says ${dur} s`
    );
  }
});

test("labels are unique and every prefix is declared", () => {
  const f = foray0(files);
  const labels = f.items.map((i) => i.label);
  assert.equal(new Set(labels).size, labels.length);
  for (const l of labels) assert.ok(f.label_prefixes[l.split("-")[0]], `no prefix entry for ${l}`);
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
  assert.equal(warnings.filter((w) => /mean-deviation/.test(w)).length, 3, "the three §5 names");
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
  for (const item of foray0(files).items) {
    const d = durationOf(files, item.segment_id);
    assert.ok(d >= floors[item.role], `${item.label} (${item.role}) is ${d} s, under ${floors[item.role]}`);
    assert.ok(d <= maxes[item.role], `${item.label} (${item.role}) is ${d} s, over ${maxes[item.role]}`);
  }
});

test("no played segment passes L4's 240 s soft maximum", () => {
  // JERK-1 at 237.93 s is the closest, and §4 says it was cut 2 s under the
  // line deliberately. Pinned, because L4's escape hatch below is the part
  // that is easy to get wrong.
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
  delete foray0(f).runtime_sec;
  const item = foray0(f).items.find((i) => i.label === "JERK-1");
  item.needs_review = true;
  item.long_reason = "One continuous three-community answer; every cut lands mid-claim.";
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

test("all nine source episodes are registered", () => {
  assert.equal(files.sources.sources.length, 9);
  assert.equal(checkForays(files).report.sources, 9);
});

test("every item_id in the segment pool resolves to a source", () => {
  const registered = new Set(files.sources.sources.map((s) => s.id));
  for (const s of files.segments.segments) {
    assert.ok(registered.has(s.item_id), `${s.item_id} has no source entry`);
  }
});

test("source ids are exactly the item_ids grilling-foray.md §1 names", () => {
  assert.deepEqual(
    files.sources.sources.map((s) => s.id).sort(),
    [
      "bbqc-moss-school",
      "bbqc-traeger-history",
      "bbqrn-argentina-open-fire",
      "bbqrn-santa-maria-grillzilla",
      "bfh-18c-tavern-briggs",
      "bfh-griddle-bakestone",
      "bfh-medieval-meals-manners",
      "moreish-jerk-jamaica",
      "origin-stories-cooking-human",
    ]
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

test("narration items are accepted between segments and ignored by the rules", () => {
  // No bridges are authored yet (grilling-foray.md §5), but #134's shape has
  // them interleaved. A Foray that grows one must not have to change this file.
  const f = clone();
  foray0(f).items.splice(1, 0, { type: "narration", id: "nar-1", script: "Two million years later." });
  assert.deepEqual(errorsFor(f), []);
});

test("a narration item without an id is rejected", () => {
  const f = clone();
  foray0(f).items.splice(1, 0, { type: "narration", script: "..." });
  assert.match(errorsFor(f).join("\n"), /narration item needs an id/);
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
