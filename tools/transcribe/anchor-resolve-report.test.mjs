/* Offline anchor-resolution report (tools/transcribe/anchor-resolve-report.mjs,
   GV-78). Run:
   node --test tools/transcribe/anchor-resolve-report.test.mjs

   Synthetic cues and a synthetic diagnostic paste only: no transcript from
   data-local/, no network. Every test names the one-line mutation that turns
   it red; each was applied to anchor-resolve-report.mjs and seen to fail. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AD_LENGTHS_SEC,
  RESOLVE_TARGET,
  candidateSegments,
  forayReport,
  parseDiagRecord,
  readEpisodeCues,
  resolveRow,
  run,
  safeKey,
  simulateSegment,
} from "./anchor-resolve-report.mjs";
import { safeKey as writerSafeKey } from "../segments/fetch-transcripts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** One cue per word, word k at k seconds, ending 0.5 s later: an anchor's
    first word's cue start is its authored start, its last word's cue end its
    authored end. Filler words are unique tokens (`f<k>`), so nothing matches
    an anchor by accident. */
function episode(placements, length = 600) {
  const words = Array.from({ length }, (_, k) => `f${k}`);
  for (const [at, text] of placements) text.split(" ").forEach((w, j) => (words[at + j] = w));
  return words.map((w, k) => ({ text: w, start_sec: k, end_sec: k + 0.5 }));
}

const START = "we started measuring the river after the flood last spring";
const END = "and that is why the town still keeps the old gauge";
/** Segment 300 s .. 359.5 s: the start anchor at 300, the end anchor's last
    word at 359 (ends 359.5). */
const SEG = { id: "rome#1", itemId: "ep-rome", start_sec: 300, end_sec: 359.5, start_anchor: START, end_anchor: END };
const clean = () => episode([[300, START], [349, END]]);
/** The same episode with the start anchor ALSO spoken 50 s earlier. */
const REPEAT_AT = 250;
const withRepeat = () => episode([[REPEAT_AT, START], [300, START], [349, END]]);

test("output is deterministic for a fixed seed, and the seed changes the scenarios", () => {
  // MUTATION: `hash32(`${seed}\u0000${forayId}\u0000${segment.id}`)` -> `hash32(`${forayId}\u0000${segment.id}`)` -> seeds 1 and 2 agree.
  const a = simulateSegment(SEG, clean(), { seed: 1, scenarios: 12, forayId: "rome" });
  const b = simulateSegment(SEG, clean(), { seed: 1, scenarios: 12, forayId: "rome" });
  const c = simulateSegment(SEG, clean(), { seed: 2, scenarios: 12, forayId: "rome" });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.details.map((d) => d.insertAtSec), c.details.map((d) => d.insertAtSec));
  assert.deepEqual(a.details.map((d) => d.adSec), Array.from({ length: 12 }, (_, k) => AD_LENGTHS_SEC[k % 3]));
  for (const d of a.details) assert.ok(d.insertAtSec >= 0 && d.insertAtSec < SEG.start_sec, "the ad goes in before start_sec");
  const r1 = forayReport({ forayId: "rome", segments: [SEG] }, { cuesFor: () => clean(), scenarios: 12, seed: 7 });
  const r2 = forayReport({ forayId: "rome", segments: [SEG] }, { cuesFor: () => clean(), scenarios: 12, seed: 7 });
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
});

test("a clean unique anchor resolves after every ad shift, at authored time + L", () => {
  // MUTATION: `start_sec: c.start_sec + bySec` -> `start_sec: c.start_sec` in shiftCues -> the truth moves, nothing resolves.
  const sim = simulateSegment(SEG, clean(), { scenarios: 9, noise_p: 0 });
  assert.equal(sim.resolved, 9);
  for (const d of sim.details) {
    assert.equal(d.startHitSec, SEG.start_sec + d.adSec);
    assert.equal(d.endHitSec, SEG.end_sec + d.adSec);
  }
  const rep = forayReport({ forayId: "rome", segments: [SEG] }, { cuesFor: () => clean(), scenarios: 9, noise_p: 0 });
  assert.equal(rep.resolveRate, 1);
  assert.equal(rep.nonUnique, 0);
  assert.deepEqual(rep.unresolvable, []);
});

test("an anchor repeated before the segment is non-unique, and the scenarios whose shift pushes the repeat into the window fail", () => {
  // MUTATION: `Math.abs(s.start_sec - (start_sec + L)) <= RESOLVE_TOLERANCE_SEC` -> `true` -> a hit on the repeat counts as resolved.
  // MUTATION: `if (n > 1) nonUniqueAnchors.push` -> `if (n > 2)` -> nonUnique 0.
  const sim = simulateSegment(SEG, withRepeat(), { scenarios: 60, seed: 3, noise_p: 0 });
  let landed = 0;
  for (const d of sim.details) {
    if (d.adSec >= 60 && d.insertAtSec <= REPEAT_AT) {
      // The repeat moved to 250 + L, inside [300, 300 + reach] and ahead of the truth.
      assert.equal(d.startHitSec, REPEAT_AT + d.adSec, JSON.stringify(d));
      assert.equal(d.resolved, false, JSON.stringify(d));
      landed += 1;
    }
    if (d.adSec === 30 || d.insertAtSec > REPEAT_AT + 10) assert.equal(d.resolved, true, JSON.stringify(d));
  }
  assert.ok(landed > 0, "the seed puts at least one scenario on the repeat");
  assert.ok(sim.resolved < sim.scenarios);
  const rep = forayReport({ forayId: "rome", segments: [SEG] }, { cuesFor: () => withRepeat(), scenarios: 60, seed: 3, noise_p: 0 });
  assert.equal(rep.nonUnique, 1);
  assert.deepEqual(rep.nonUniqueAnchors, [{ segmentId: "rome#1", which: "start", occurrences: 2 }]);
  assert.equal(rep.resolveRate, sim.resolved / sim.scenarios);
  assert.deepEqual(rep.unresolvable, [{ segmentId: "rome#1", reason: "scenarios failed", resolved: sim.resolved, scenarios: 60 }]);
});

test("word noise is applied at the default rate and can break an anchor; real ASR cues replace the noise", () => {
  // MUTATION: `const heard = asrCues ? inWindow : noisyCues(...)` -> `const heard = inWindow` -> the noisy rate is 1.
  const noisy = simulateSegment(SEG, clean(), { scenarios: 90, seed: 11 });
  assert.ok(noisy.resolved < noisy.scenarios, "p=0.05 over two 10-word anchors misses some of 90");
  assert.ok(noisy.resolved / noisy.scenarios > 0.85, `${noisy.resolved}/${noisy.scenarios}`);
  // An ASR transcript that mishears three words of the start anchor never resolves.
  const asr = episode([[300, START.replace("river", "liver").replace("flood", "food").replace("spring", "string").replace("measuring", "treasuring")], [349, END]]);
  const heard = simulateSegment(SEG, clean(), { scenarios: 6, asrCues: asr });
  assert.equal(heard.resolved, 0);
});

test("an anchor too short to match counts as failed; a segment with no transcript is left out of the rate", () => {
  // MUTATION: `scenarios += k;` (too-short branch) -> deleted -> the rate ignores the short anchor and reads 1.
  const short = { ...SEG, id: "rome#2", start_anchor: "the river" };
  const lost = { ...SEG, id: "rome#3", itemId: "ep-gone" };
  const rep = forayReport(
    { forayId: "rome", segments: [SEG, short, lost], missing: ["rome#9"] },
    { cuesFor: (s) => (s.itemId === "ep-gone" ? null : clean()), scenarios: 6, noise_p: 0 },
  );
  assert.equal(rep.segments, 4);
  assert.equal(rep.scenarios, 12);
  assert.equal(rep.resolveRate, 0.5);
  assert.deepEqual(rep.unresolvable, [{ segmentId: "rome#2", reason: "anchor missing or too short", resolved: 0, scenarios: 6 }]);
  assert.deepEqual(rep.unmeasured.map((u) => u.segmentId).sort(), ["rome#3", "rome#9"]);
  const row = resolveRow(rep, { seed: 1 });
  assert.equal(row.metric, "anchor_resolve_simulated");
  assert.equal(row.forayId, "rome");
  assert.equal(row.rate, 0.5);
  assert.equal(row.target, 0.98);
  assert.equal(RESOLVE_TARGET, 0.98);
});

test("a candidate's segment items resolve against its minted segments first and the pool second", () => {
  // MUTATION: `const seg = byId.get(id) ?? poolById.get(id)` -> `const seg = byId.get(id)` -> the pool clip is reported missing.
  const candidate = {
    id: "rome",
    items: [
      { type: "narration", id: "n0" },
      { type: "segment", segment_id: "new#0" },
      { type: "segment", segment_id: "pool#5" },
      { type: "segment", segment_id: "nowhere#1" },
    ],
    segments: [{ id: "new#0", itemId: "ep-new", startSec: 10, endSec: 70, startAnchor: START, endAnchor: END }],
  };
  const pool = [{ id: "pool#5", item_id: "ep-pool", start_sec: 5, end_sec: 50, start_anchor: START, end_anchor: END }];
  const parsed = candidateSegments(candidate, { pool });
  assert.equal(parsed.forayId, "rome");
  assert.deepEqual(parsed.segments.map((s) => [s.id, s.itemId, s.start_sec, s.end_sec]), [["new#0", "ep-new", 10, 70], ["pool#5", "ep-pool", 5, 50]]);
  assert.deepEqual(parsed.missing, ["nowhere#1"]);
});

test("the transcript key matches fetch-transcripts.mjs's safeKey, and a body is found by its show and guid", () => {
  // MUTATION: `.slice(0, 60)` -> `.slice(0, 80)` in safeKey -> a long guid's key differs from the writer's.
  for (const g of ["Buzzsprout-10011710", "https://blubrry.com/beckershealthcarepodcast/123/a-very-long-title-slug-that-runs-well-past-sixty-characters/", "", "ep 5"]) {
    assert.equal(safeKey(g), writerSafeKey(g), g);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv78-"));
  try {
    fs.mkdirSync(path.join(dir, "rome-show-abc"));
    fs.writeFileSync(path.join(dir, "rome-show-abc", `${safeKey("G-1")}.json`), JSON.stringify({ show_id: "rome-show", guid: "G-1", cues: clean() }));
    fs.writeFileSync(path.join(dir, "rome-show-abc", "odd-name.json"), JSON.stringify({ guid: "https://x.test/2", cues: [{ text: "hi", start_sec: 1, end_sec: 2 }] }));
    assert.equal(readEpisodeCues(dir, { showId: "rome-show", guid: "G-1" }).length, 600);
    assert.equal(readEpisodeCues(dir, { showId: null, guid: "G-1" }).length, 600, "an exact name is found without the show");
    assert.equal(readEpisodeCues(dir, { showId: "rome-show", guid: "https://x.test/2" }).length, 1, "a body found by its own guid field");
    assert.equal(readEpisodeCues(dir, { showId: "other", guid: "G-1" }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const PASTE = [
  "Foray diagnostic record",
  "",
  "clips rome: 0 static, 1 exact, 1 padded, 1 skipped, 0 dropped, 0 load-failed; 67% at authored time",
  "clips b: 1 static, 0 exact, 0 padded, 0 skipped, 1 dropped, 0 load-failed; 50% at authored time",
  "clips engine: 2 exact|padded, 1 skipped, 1 load-failed; 50% at authored time (static plays write no row)",
  "",
  "#1    09:00:01 clip       exact  item=rome#0",
  "#2    09:00:05 clip       padded  item=rome#1",
  "#3    09:00:09 clip       skipped  item=rome#2",
  "#4    09:01:00 clip       load-failed  item=solo#0",
  "#5    09:01:02 clip       static  item=solo#1",
  "#6    09:01:09 clip       exact  item=solo#0",
].join("\r\n");

test("a pasted record yields the per-Foray authored-time rate: tally lines win, and rows fill a Foray with no tally", () => {
  // MUTATION: `const AUTHORED = new Set(["static", "exact", "padded"])` -> without "static" -> Foray b reads 0, not 0.5.
  // MUTATION: `if (!held || held.seq < seq)` -> `if (!held)` -> solo#0 keeps load-failed and solo reads 0.5.
  const rows = parseDiagRecord(PASTE);
  assert.deepEqual(rows, [
    { metric: "clip_authored_time", forayId: "rome", static: 0, exact: 1, padded: 1, skipped: 1, dropped: 0, loadFailed: 0, authoredTimeRate: 2 / 3 },
    { metric: "clip_authored_time", forayId: "b", static: 1, exact: 0, padded: 0, skipped: 0, dropped: 1, loadFailed: 0, authoredTimeRate: 0.5 },
    { metric: "clip_authored_time", forayId: "solo", static: 1, exact: 1, padded: 0, skipped: 0, dropped: 0, loadFailed: 0, authoredTimeRate: 1 },
    { metric: "clip_authored_time", forayId: null, lane: "engine", exactOrPadded: 2, skipped: 1, loadFailed: 1, authoredTimeRate: 0.5 },
  ]);
  assert.deepEqual(parseDiagRecord("nothing here\nclips ?: 1 static, 0 exact, 0 padded, 0 skipped, 0 dropped, 0 load-failed; 100% at authored time"), []);
});

test("the CLI reads only local files, makes no network call and writes no transcript text", async () => {
  // MUTATION: `unresolvable.push({ segmentId: seg.id, reason: "scenarios failed", ...` gains `anchor: seg.start_anchor` -> the anchor's words reach the report.
  // MUTATION: an `import "node:https";` line added to the module -> the import scan fails.
  const src = fs.readFileSync(path.join(HERE, "anchor-resolve-report.mjs"), "utf8");
  assert.doesNotMatch(src, /from\s+["']node:(https?|net|tls|dgram)["']|import\s+["']node:(https?|net|tls|dgram)["']|\bfetch\s*\(/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv78-cli-"));
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("network");
  };
  try {
    const root = path.join(dir, "root");
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(path.join(root, "data", "segment-sources.json"), JSON.stringify({ sources: [{ id: "ep-rome", episode_guid: "G-1" }] }));
    fs.writeFileSync(path.join(root, "data", "transcript-digests.json"), JSON.stringify({ transcripts: [{ show_id: "rome-show", guid: "G-1" }] }));
    fs.writeFileSync(path.join(root, "data", "segments.json"), JSON.stringify({ segments: [] }));
    const norm = path.join(dir, "normalized", "rome-show-abc");
    fs.mkdirSync(norm, { recursive: true });
    fs.writeFileSync(path.join(norm, `${safeKey("G-1")}.json`), JSON.stringify({ show_id: "rome-show", guid: "G-1", cues: withRepeat() }));
    const candidate = path.join(dir, "rome.json");
    fs.writeFileSync(candidate, JSON.stringify({ id: "rome", items: [{ type: "segment", segment_id: "rome#1" }], segments: [SEG] }));
    const diag = path.join(dir, "record.txt");
    fs.writeFileSync(diag, PASTE);
    const out = path.join(dir, "rows.jsonl");
    const reportFile = path.join(dir, "report.json");
    const args = [candidate, "--transcripts", path.join(dir, "normalized"), "--root", root, "--scenarios", "12", "--diag", diag, "--out", out, "--report", reportFile];
    const r = run(args);
    const lines = fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 5);
    assert.deepEqual(Object.keys(lines[0]).slice(0, 4), ["metric", "forayId", "rate", "target"]);
    assert.equal(lines[0].metric, "anchor_resolve_simulated");
    assert.equal(lines[0].forayId, "rome");
    assert.equal(r.reports[0].nonUnique, 1);
    assert.equal(r.reports[0].measuredSegments, 1);
    const written = fs.readFileSync(out, "utf8") + fs.readFileSync(reportFile, "utf8");
    for (const w of [...START.split(" "), ...END.split(" ")].filter((w) => w.length > 3)) {
      assert.ok(!new RegExp(`\\b${w}\\b`).test(written), `transcript word "${w}" written`);
    }
    assert.equal(JSON.stringify(run(args).rows), JSON.stringify(r.rows), "the same run twice gives the same rows");
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
