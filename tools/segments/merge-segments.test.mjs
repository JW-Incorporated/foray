/* Tests for the segment merge validator (issue #106, ADR-0007).
   Run: node --test "tools/segments/*.test.mjs"

   Every check in the validator gets a test AND a deliberate violation, because
   a validator is only worth what its failure cases are worth. The paraphrased
   anchor is the most important test in this file: it is the one failure that
   produces no error anywhere — the merge succeeds, the JSON is well-formed,
   the segment looks right in a diff, and it simply never resolves at playback.
   If a future refactor loosens the anchor comparison, this is what has to go
   red.

   The transcript below is a real-shaped WebVTT built around the ADR's own
   worked example, so the fixtures and the ADR say the same thing. */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonical,
  buildTranscriptIndex,
  findAnchorOccurrences,
  mergeSegments,
  validateSegmentsDocument,
  segmentId,
  MIN_ANCHOR_WORDS,
  ANCHOR_TIME_TOLERANCE_SEC,
  SEGMENTS_VERSION,
} from "./merge-segments.mjs";
import { normalize } from "./transcript-normalize.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = fileURLToPath(new URL("./merge-segments.mjs", import.meta.url));

/* ------------------------------------------------------------------ fixture */

/** 00:42:10 = 2530s, 00:51:50 = 3110s — the ADR-0007 example, to the second. */
const TRANSCRIPT = `WEBVTT

00:00:05.000 --> 00:00:12.000
Welcome back. Today we are talking about fusion power and why it is hard.

00:42:10.000 --> 00:42:16.000
So the Lawson criterion is really a statement about

00:42:16.000 --> 00:42:24.000
power balance: what you get out versus what you put in, at temperature.

00:42:24.000 --> 00:42:31.000
People hear it and assume hand-waving, but it is arithmetic.

00:51:38.000 --> 00:51:44.000
and that's why the tokamak won by default

00:51:44.000 --> 00:51:50.000
for thirty years.
`;

const START_ANCHOR = "so the Lawson criterion is really a statement about";
const END_ANCHOR = "and that's why the tokamak won by default for thirty years";

const TAXONOMY = new Set(["engineering", "engineering/energy-fusion", "history/ancient"]);

function episode(overrides = {}) {
  return {
    item_id: "lex-353-whyte",
    reference_duration_sec: 11840,
    dai_suspected: true,
    transcript_source: "publisher",
    transcript: { body: TRANSCRIPT, mime_type: "text/vtt" },
    ...overrides,
  };
}

function segment(overrides = {}) {
  return {
    topic: "engineering/energy-fusion",
    start_sec: 2530,
    end_sec: 3110,
    start_anchor: START_ANCHOR,
    end_anchor: END_ANCHOR,
    why: "Whyte explains the Lawson criterion without hand-waving",
    confidence: "high",
    needs_review: false,
    ...overrides,
  };
}

/** One episode, one authored segment, merged into an empty pool. */
function run({ ep = {}, seg = {}, segs = null, existing = { version: SEGMENTS_VERSION, segments: [] } } = {}) {
  const e = episode(ep);
  const batch = { batch_id: "seg-2026-08-12-a", episodes: [e] };
  const results = {
    batch_id: "seg-2026-08-12-a",
    results: { [e.item_id]: { segments: segs || [segment(seg)] } },
  };
  return mergeSegments({ batch, results, taxonomyNodeIds: TAXONOMY, existing });
}

/** Assert the batch was rejected, and that the reason names the right thing. */
function assertRejected(out, pattern) {
  assert.equal(out.doc.segments.length, 0, "a rejected segment must never reach the pool");
  assert.equal(out.merged, 0);
  assert.ok(out.rejected >= 1, "rejection must be counted");
  assert.ok(
    out.errors.some((e) => pattern.test(e)),
    `no error matched ${pattern}\n  got: ${out.errors.join("\n       ") || "(none)"}`
  );
}

const index = () => buildTranscriptIndex(normalize(TRANSCRIPT, "text/vtt").cues);

/* =========================================================== canonical form */

test("canonical() forgives case, whitespace, punctuation and apostrophe style", () => {
  const a = canonical("And that's why the tokamak won  by default");
  assert.equal(a, "DELIBERATE-BREAK-140 proves this suite actually executes in CI");
  // Smart apostrophe, newline, tab, trailing punctuation, doubled space.
  assert.equal(canonical("And that’s why\tthe tokamak\nwon  by default."), a);
  // NFKC folds width/ligature variants of the same characters.
  assert.equal(canonical("ＡＮＤ that's why the tokamak won by default"), a);
});

test("canonical() maps punctuation to a space but elides apostrophes", () => {
  // Hyphenation is a caption-writer's choice, so hand-waving == hand waving...
  assert.equal(canonical("hand-waving"), "hand waving");
  assert.equal(canonical("hand — waving"), "hand waving");
  // ...but an elided apostrophe must not split a contraction into two words.
  assert.equal(canonical("that's"), "thats");
  assert.notEqual(canonical("that's"), "that s");
});

test("canonical() does not spell out digits or stem words", () => {
  // Both of these are rewrites of what was said, and a resolver searching the
  // listener's own transcript would miss them exactly as this does.
  assert.notEqual(canonical("thirty years"), canonical("30 years"));
  assert.notEqual(canonical("won by default"), canonical("wins by default"));
});

/* ================================================= 1. anchors are VERBATIM */

test("an anchor that differs only in case, spacing and apostrophe style still matches", () => {
  const { occurrences } = findAnchorOccurrences(index(), "  And   THAT’S why the tokamak won by default  ");
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].start_sec, 3098);
});

test("an anchor may straddle a cue boundary", () => {
  // END_ANCHOR spans the 00:51:38 and 00:51:44 cues; a per-cue search would
  // miss exactly the anchors an extractor is most likely to pick.
  const { occurrences } = findAnchorOccurrences(index(), END_ANCHOR);
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].end_sec, 3110);
});

test("anchor matching is whole-word, so a partial word never resolves", () => {
  assert.equal(findAnchorOccurrences(index(), "won by default for thirt").occurrences.length, 0);
  assert.equal(findAnchorOccurrences(index(), "the tokamak won by defaul").occurrences.length, 0);
  assert.equal(findAnchorOccurrences(index(), "the tokamak won by default").occurrences.length, 1);
});

test("VIOLATION: a PARAPHRASED anchor is rejected — the silent-failure case", () => {
  // This is the whole reason this file exists. Every word here is plausible,
  // the meaning is identical, and nothing downstream would ever complain: the
  // segment merges, the JSON is valid, and at playback the anchor resolves to
  // nothing, forever. It must not merge.
  const out = run({ seg: { start_anchor: "the Lawson criterion is basically a statement about" } });
  assertRejected(out, /start_anchor does not appear verbatim/);
});

test("VIOLATION: a paraphrase that only expands a contraction is still rejected", () => {
  // "that is" for "that's" adds a word. It reads as a transcription nicety and
  // is the most likely way an LLM drifts off verbatim.
  const out = run({ seg: { end_anchor: "and that is why the tokamak won by default for thirty years" } });
  assertRejected(out, /end_anchor does not appear verbatim/);
});

test("VIOLATION: an anchor from a different episode is rejected", () => {
  const out = run({ seg: { start_anchor: "so the ancient Roman concrete harbours are still standing today" } });
  assertRejected(out, /start_anchor does not appear verbatim/);
});

test(`VIOLATION: an anchor under ${MIN_ANCHOR_WORDS} words is rejected even though it occurs`, () => {
  // "for thirty years" is verbatim, and useless — it is not a location.
  const out = run({ seg: { end_anchor: "for thirty years" } });
  assertRejected(out, /end_anchor is 3 word\(s\)/);
});

test("VIOLATION: an anchor that is verbatim but nowhere near its own timestamp is rejected", () => {
  // The words are real; the timeline cache is junk. A boundary that resolves
  // 42 minutes from where it claims to be is not a boundary.
  const out = run({ seg: { start_anchor: "today we are talking about fusion power and why it is hard" } });
  assertRejected(out, /appears in the transcript at 5s but the segment claims 2530s/);
});

test("an anchor within the time tolerance is accepted", () => {
  // Same anchor, honest timestamps: the guard fires on drift, not on cue
  // granularity.
  const out = run({
    seg: { start_sec: 2530 + ANCHOR_TIME_TOLERANCE_SEC - 1, start_anchor: START_ANCHOR },
  });
  assert.equal(out.doc.segments.length, 1);
  assert.equal(out.rejected, 0);
});

test("an ambiguous anchor merges but is flagged for review, never silently", () => {
  const doubled = TRANSCRIPT + `
01:05:00.000 --> 01:05:08.000
So the Lawson criterion is really a statement about the machines nobody built.
`;
  const out = run({ ep: { transcript: { body: doubled, mime_type: "text/vtt" } } });
  assert.equal(out.doc.segments.length, 1);
  assert.equal(out.doc.segments[0].needs_review, true, "ambiguity must force a human pass");
  assert.match(out.doc.segments[0].review_notes.join(" "), /occurs 2 times/);
});

test("an episode whose transcript yields no cues rejects all of its segments", () => {
  // No transcript, no verification. Merging unverified anchors is the exact
  // silent failure this validator exists to prevent, so the episode is dropped.
  const out = run({ ep: { transcript: { body: "not a transcript at all", mime_type: "text/vtt" } } });
  assertRejected(out, /no cues, so no anchor can be verified/);
});

/* ============================================================== 2. timing */

test("a valid segment merges with the full ADR-0007 record shape", () => {
  const out = run();
  assert.equal(out.merged, 1);
  assert.equal(out.rejected, 0);
  assert.equal(out.changed, true);
  assert.deepEqual(out.doc.segments[0], {
    id: "lex-353-whyte#2530",
    item_id: "lex-353-whyte",
    topic: "engineering/energy-fusion",
    start_sec: 2530,
    end_sec: 3110,
    reference_duration_sec: 11840,
    start_anchor: START_ANCHOR,
    end_anchor: END_ANCHOR,
    why: "Whyte explains the Lawson criterion without hand-waving",
    confidence: "high",
    transcript_source: "publisher",
    dai_suspected: true,
    source: "agent-v1",
    batch_id: "seg-2026-08-12-a",
    needs_review: false,
  });
  assert.equal(out.doc.version, SEGMENTS_VERSION);
  assert.equal(out.doc.segments[0].id, segmentId("lex-353-whyte", 2530));
});

test("VIOLATION: end_sec at or before start_sec is rejected", () => {
  assertRejected(run({ seg: { end_sec: 2530 } }), /end_sec \(2530\) must be greater than start_sec/);
  assertRejected(run({ seg: { end_sec: 2000 } }), /must be greater than start_sec/);
});

test("VIOLATION: a segment past reference_duration_sec is rejected", () => {
  const out = run({ seg: { end_sec: 12000 } });
  assertRejected(out, /end_sec \(12000\) is past reference_duration_sec \(11840\)/);
});

test("VIOLATION: a non-numeric or negative start_sec is rejected", () => {
  assertRejected(run({ seg: { start_sec: -1 } }), /start_sec must be a number >= 0/);
  assertRejected(run({ seg: { start_sec: "2530" } }), /start_sec must be a number >= 0/);
  assertRejected(run({ seg: { end_sec: null } }), /end_sec must be a number/);
});

/* ====================================== 3. copy rules (backend/src/copy) */

test("VIOLATION: `deep dive` in a why-line is rejected", () => {
  // Called out in #106 because it trips on segment prose more than expected.
  assertRejected(run({ seg: { why: "A deep dive into the Lawson criterion" } }), /why: banned phrase/);
  assertRejected(run({ seg: { why: "A deep-dive on fusion break-even" } }), /why: banned phrase/);
});

test("VIOLATION: the rest of the banned list is enforced from rules.js, not reimplemented", () => {
  for (const why of [
    "A fascinating look at fusion break-even",
    "Whyte explores why break-even took thirty years",
    "Whyte delves into the Lawson criterion",
    "Fits your drive: fusion explained simply",
  ]) {
    assertRejected(run({ seg: { why } }), /why: banned phrase/);
  }
});

test("VIOLATION: a why-line over the 18-word limit is rejected", () => {
  const why = "Whyte walks through the arithmetic behind break even and why the machines we built took quite so long to arrive";
  assert.ok(why.split(" ").length > 18);
  assertRejected(run({ seg: { why } }), /why: \d+ words > 18/);
});

test("VIOLATION: a missing why-line is rejected", () => {
  assertRejected(run({ seg: { why: "   " } }), /why: missing/);
});

/* ============================================================= 4. taxonomy */

test("VIOLATION: a topic that is not a taxonomy node is rejected", () => {
  assertRejected(run({ seg: { topic: "engineering/fusion" } }), /unknown taxonomy node "engineering\/fusion"/);
  assertRejected(run({ seg: { topic: undefined } }), /unknown taxonomy node/);
});

test("VIOLATION: a bad confidence bucket is rejected", () => {
  assertRejected(run({ seg: { confidence: 0.9 } }), /confidence must be one of/);
});

/* ================================================== 5. DAI needs anchors */

test("VIOLATION: a DAI-sourced segment missing an anchor is rejected (ADR-0007)", () => {
  assertRejected(run({ seg: { end_anchor: "" } }), /end_anchor is required on a dai_suspected item/);
  assertRejected(run({ seg: { start_anchor: undefined } }), /start_anchor is required on a dai_suspected item/);
});

test("a non-DAI segment may omit anchors, but is flagged rather than trusted", () => {
  // ADR-0007: non-DAI "may omit anchors, but should not" — a publisher can
  // re-upload a static file too, and that segment rots when they do.
  const out = run({
    ep: { dai_suspected: false },
    seg: { start_anchor: undefined, end_anchor: undefined },
  });
  assert.equal(out.merged, 1);
  assert.equal(out.doc.segments[0].start_anchor, null);
  assert.equal(out.doc.segments[0].needs_review, true);
  assert.match(out.doc.segments[0].review_notes.join(" "), /rots if the publisher re-uploads/);
});

test("a present anchor is checked on a non-DAI item too", () => {
  const out = run({ ep: { dai_suspected: false }, seg: { start_anchor: "the Lawson criterion is basically a claim about" } });
  assertRejected(out, /start_anchor does not appear verbatim/);
});

/* =========================================================== 6. idempotent */

test("re-running the same batch changes nothing", () => {
  const first = run();
  const second = run({ existing: first.doc });
  assert.deepEqual(second.doc.segments, first.doc.segments);
  assert.equal(second.changed, false, "an unchanged merge must not rewrite the file");
  assert.equal(second.merged, 0);
  assert.equal(second.unchanged, 1);
  assert.equal(JSON.stringify(second.doc), JSON.stringify(first.doc));
});

test("a rejected segment leaves the existing record untouched", () => {
  const good = run();
  const rerun = run({ existing: good.doc, seg: { start_anchor: "the Lawson criterion is loosely a statement about" } });
  assert.deepEqual(rerun.doc.segments, good.doc.segments, "a bad re-author must not degrade a good record");
  assert.equal(rerun.changed, false);
  assert.equal(rerun.rejected, 1);
});

test("merging a second batch keeps segments from the first", () => {
  const first = run();
  const other = {
    batch_id: "seg-2026-08-13-b",
    episodes: [episode({ item_id: "abc-101-concrete" })],
  };
  const out = mergeSegments({
    batch: other,
    results: { batch_id: "seg-2026-08-13-b", results: { "abc-101-concrete": { segments: [segment()] } } },
    taxonomyNodeIds: TAXONOMY,
    existing: first.doc,
  });
  assert.deepEqual(out.doc.segments.map((s) => s.id), ["abc-101-concrete#2530", "lex-353-whyte#2530"]);
});

test("VIOLATION: two segments claiming the same boundary are both rejected", () => {
  const out = run({ segs: [segment(), segment({ why: "Whyte on the arithmetic of break-even" })] });
  assert.equal(out.doc.segments.length, 0);
  assert.match(out.errors.join("\n"), /two segments claim the same boundary/);
});

/* ==================================================== batch-level contract */

test("VIOLATION: mismatched batch_id is fatal, not partial", () => {
  assert.throws(
    () =>
      mergeSegments({
        batch: { batch_id: "seg-a", episodes: [episode()] },
        results: { batch_id: "seg-b", results: {} },
        taxonomyNodeIds: TAXONOMY,
      }),
    /refusing to merge mismatched files/
  );
});

test("VIOLATION: an episode missing dai_suspected or transcript_source is rejected", () => {
  // A missing DAI verdict would read as falsy and silently waive the anchor
  // requirement — the same trap the discover.json CI invariant guards.
  const a = run({ ep: { dai_suspected: undefined } });
  assert.match(a.errors.join("\n"), /dai_suspected must be a boolean/);
  assert.equal(a.doc.segments.length, 0);

  const b = run({ ep: { transcript_source: "whisper" } });
  assert.match(b.errors.join("\n"), /transcript_source must be one of publisher\/asr-local/);
  assert.equal(b.doc.segments.length, 0);
});

test("VIOLATION: results for an episode absent from the batch are skipped and reported", () => {
  const out = mergeSegments({
    batch: { batch_id: "seg-x", episodes: [episode()] },
    results: { batch_id: "seg-x", results: { "ghost-999": { segments: [segment()] } } },
    taxonomyNodeIds: TAXONOMY,
  });
  assert.equal(out.doc.segments.length, 0);
  assert.match(out.errors.join("\n"), /ghost-999: authored in results but absent from the batch/);
});

test("an episode that yields zero segments is a normal answer, not an error", () => {
  // Most episodes contain nothing worth a Foray. A pipeline that treats
  // silence as failure manufactures filler, and filler kills the format.
  const out = mergeSegments({
    batch: { batch_id: "seg-x", episodes: [episode()] },
    results: { batch_id: "seg-x", results: {} },
    taxonomyNodeIds: TAXONOMY,
  });
  assert.deepEqual(out.errors, []);
  assert.equal(out.episodesWithNoSegments, 1);
  assert.equal(out.changed, false);
});

/* ============================================ the committed file + CI gate */

test("the merged document passes the standalone schema validator", () => {
  assert.deepEqual(validateSegmentsDocument(run().doc, TAXONOMY), []);
});

test("validateSegmentsDocument rejects a malformed document", () => {
  const good = run().doc;
  const mutate = (fn) => {
    const doc = JSON.parse(JSON.stringify(good));
    fn(doc);
    return validateSegmentsDocument(doc, TAXONOMY);
  };
  assert.match(mutate((d) => (d.version = 2)).join("\n"), /version must be 1/);
  assert.match(mutate((d) => d.segments.push({ ...d.segments[0] })).join("\n"), /duplicate segment id/);
  assert.match(mutate((d) => (d.segments[0].start_sec = 99)).join("\n"), /id does not match its item_id/);
  assert.match(mutate((d) => (d.segments[0].why = "A deep dive on fusion")).join("\n"), /banned phrase/);
  assert.match(mutate((d) => (d.segments[0].transcript_source = "guess")).join("\n"), /bad transcript_source/);
  assert.match(mutate((d) => (d.segments[0].topic = "nope")).join("\n"), /unknown taxonomy node/);
  assert.match(mutate((d) => (d.segments[0].end_sec = 99999)).join("\n"), /past reference_duration_sec/);
  assert.match(mutate((d) => (d.segments[0].start_anchor = null)).join("\n"), /start_anchor is required on a dai_suspected item/);
  assert.match(mutate((d) => (d.segments[0].needs_review = "no")).join("\n"), /needs_review must be boolean/);
});

test("the committed data/segments.json passes --check (this is the CI gate)", () => {
  const out = execFileSync(process.execPath, [CLI, "--check"], { cwd: ROOT, encoding: "utf8" });
  assert.match(out, /^ok /m);
  const doc = JSON.parse(readFileSync(join(ROOT, "data", "segments.json"), "utf8"));
  assert.equal(doc.version, SEGMENTS_VERSION);
  assert.ok(Array.isArray(doc.segments));
});

test("--check exits non-zero on a malformed segments file", () => {
  const dir = mkdtempSync(join(tmpdir(), "foray-seg-"));
  const path = join(dir, "segments.json");
  writeFileSync(path, JSON.stringify({ version: 1, segments: [{ id: "x#1", item_id: "x" }] }));
  assert.throws(
    () => execFileSync(process.execPath, [CLI, "--check", path], { cwd: ROOT, encoding: "utf8", stdio: "pipe" }),
    (e) => /INVALID/.test(String(e.stderr))
  );
});
