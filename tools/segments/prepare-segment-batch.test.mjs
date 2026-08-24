/* Tests for the segment batch prepare + candidate lint (issue #315, #106's
   sibling). Run: node --test "tools/segments/*.test.mjs"

   THE TESTS THAT MATTER MOST ARE THE OVERRUN ONES, and specifically the pair
   built from Causality's *BP Texas City*. That transcript is the reason this
   file exists: its timeline runs 962 s past the episode's declared duration, a
   ratio of 1.464, which is INSIDE `MAX_SPAN_RATIO` (1.5) by 0.036 and would
   therefore never be caught by `span_implausible`. A 30-100 s version of the
   same fault — which is what Being an Engineer actually ships on 55 episodes —
   is invisible to every other check in the repo, because it is smaller than
   ADR-0007's +/-120 s anchor tolerance. If a future change loosens
   TIMELINE_OVERRUN_TOLERANCE_SEC, `overrun below the ADR tolerance is still
   refused` is what has to go red.

   Every gate gets a passing case and a deliberately violating case. The lint
   cases are built so that the flag-only rules (S1, S2) never drop a candidate
   and the gating rules always do — the split is the whole design and a
   refactor that blurs it should fail here. */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TIMELINE_OVERRUN_TOLERANCE_SEC,
  MIN_TRANSCRIPT_COVERAGE,
  MIN_SEGMENT_SEC,
  SOFT_MAX_SEGMENT_SEC,
  HARD_MAX_SEGMENT_SEC,
  MAX_SHARE_OF_EPISODE,
  MUST_MERGE_GAP_SEC,
  SHOULD_MERGE_GAP_SEC,
  SLUG_MAX_CHARS,
  timelineVerdict,
  selectTranscripts,
  slugify,
  mintItemIds,
  enclosureMime,
  buildBatch,
  buildSources,
  renderTranscript,
  coldOpenWarning,
  cleanOutWarning,
  median,
  playedRun,
  anchorBoundsErrors,
  roleMaxSec,
  resolveDaiVerdicts,
  lintCandidates,
  applyLint,
} from "./prepare-segment-batch.mjs";
import { ROLE_MAX_SEC } from "../foray/check-forays.mjs";
import { ANCHOR_TIME_TOLERANCE_SEC } from "./merge-segments.mjs";

const CLI = fileURLToPath(new URL("./prepare-segment-batch.mjs", import.meta.url));

/* ------------------------------------------------------------------ fixture */

/** A digest row shaped exactly like `data/transcript-digests.json` ships. */
function row(over) {
  return {
    show_id: "geology-bites",
    show_title: "Geology Bites",
    guid: "g-1",
    title: "Paul Hoffman on the Snowball Earth Hypothesis",
    enclosure_url: "https://example.test/a/episode.mp3",
    transcript_url: "https://example.test/a/episode.srt",
    sha256: "abc",
    cues: 595,
    last_cue_sec: 1969.5,
    feed_duration_sec: 1979,
    ...over,
  };
}

/* --------------------------------------------------------- the overrun gate */

test("a transcript ending just inside its declared duration passes", () => {
  const v = timelineVerdict(row());
  assert.equal(v.ok, true);
  assert.equal(v.code, "ok");
  assert.ok(v.overrun_sec < 0);
});

test("a transcript ending a second past a rounded duration still passes", () => {
  // itunes:duration is declared to whole seconds; +1 s is arithmetic, not drift.
  assert.equal(timelineVerdict(row({ last_cue_sec: 1980 })).ok, true);
});

test("BP Texas City — the 962 s overrun span_implausible cannot see — is refused", () => {
  const v = timelineVerdict(row({ title: "1: BP Texas City", last_cue_sec: 3033, feed_duration_sec: 2071 }));
  assert.equal(v.ok, false);
  assert.equal(v.code, "timeline_overruns_declared_duration");
  // The whole point: the ratio is under MAX_SPAN_RATIO's 1.5.
  assert.ok(v.coverage < 1.5, `ratio ${v.coverage} should be inside the span check that misses it`);
  assert.ok(v.detail.includes("962.0s"));
});

test("overrun below the ADR tolerance is still refused", () => {
  /* 103.8 s is Being an Engineer's worst episode. It is INSIDE ADR-0007's
     +/-120 s anchor tolerance, so every downstream check passes and the
     segment plays the wrong words. This is the case the whole file is for. */
  const overrun = 103.8;
  assert.ok(overrun < ANCHOR_TIME_TOLERANCE_SEC, "fixture must sit inside the anchor tolerance to be meaningful");
  const v = timelineVerdict(row({ feed_duration_sec: 3227, last_cue_sec: 3227 + overrun }));
  assert.equal(v.ok, false);
  assert.equal(v.code, "timeline_overruns_declared_duration");
});

test("the tolerance is far tighter than the anchor tolerance it protects", () => {
  assert.ok(
    TIMELINE_OVERRUN_TOLERANCE_SEC * 10 < ANCHOR_TIME_TOLERANCE_SEC,
    "a gate wider than a tenth of the anchor tolerance cannot see the offsets that hide inside it"
  );
});

test("the tolerance is honoured exactly at its boundary", () => {
  const d = 1000;
  assert.equal(timelineVerdict(row({ feed_duration_sec: d, last_cue_sec: d + TIMELINE_OVERRUN_TOLERANCE_SEC })).ok, true);
  assert.equal(timelineVerdict(row({ feed_duration_sec: d, last_cue_sec: d + TIMELINE_OVERRUN_TOLERANCE_SEC + 0.01 })).ok, false);
});

test("the tolerance is overridable per call, and overriding it changes the verdict", () => {
  const r = row({ feed_duration_sec: 1000, last_cue_sec: 1050 });
  assert.equal(timelineVerdict(r).ok, false);
  assert.equal(timelineVerdict(r, { overrunToleranceSec: 60 }).ok, true);
});

/* -------------------------------------------------------- the coverage gate */

test("a trimmed outro is a shortfall, not an exclusion", () => {
  // Geology Bites lands 8-10 s short on 118 of 120 episodes.
  const v = timelineVerdict(row({ last_cue_sec: 1969.5 }));
  assert.equal(v.ok, true);
  assert.ok(v.coverage > 0.99);
});

test("a transcript covering under half the episode is refused", () => {
  const v = timelineVerdict(row({ feed_duration_sec: 2000, last_cue_sec: 800 }));
  assert.equal(v.ok, false);
  assert.equal(v.code, "transcript_covers_too_little");
  assert.ok(v.detail.includes("40.0%"));
});

test("the coverage floor is honoured exactly at its boundary", () => {
  const d = 2000;
  assert.equal(timelineVerdict(row({ feed_duration_sec: d, last_cue_sec: d * MIN_TRANSCRIPT_COVERAGE })).ok, true);
  assert.equal(timelineVerdict(row({ feed_duration_sec: d, last_cue_sec: d * MIN_TRANSCRIPT_COVERAGE - 1 })).ok, false);
});

/* ------------------------------------------------------ unusable input rows */

test("no declared duration is UNCHECKABLE, never a pass", () => {
  for (const bad of [0, null, undefined, -1, "x"]) {
    const v = timelineVerdict(row({ feed_duration_sec: bad }));
    assert.equal(v.ok, false, `feed_duration_sec ${JSON.stringify(bad)} must not pass`);
    assert.equal(v.code, "no_declared_duration");
  }
});

test("a transcript with no cues is refused before anything is divided", () => {
  const v = timelineVerdict(row({ cues: 0 }));
  assert.equal(v.ok, false);
  assert.equal(v.code, "no_cues");
});

test("a transcript with no usable last cue is refused", () => {
  assert.equal(timelineVerdict(row({ last_cue_sec: 0 })).code, "no_last_cue");
});

/* --------------------------------------------------------------- selection */

test("selectTranscripts splits, counts by code, and keeps a reason on every exclusion", () => {
  const { selected, excluded, byCode } = selectTranscripts([
    row({ guid: "ok-1" }),
    row({ guid: "over-1", feed_duration_sec: 2071, last_cue_sec: 3033 }),
    row({ guid: "short-1", feed_duration_sec: 2000, last_cue_sec: 100 }),
    row({ guid: "nodur-1", feed_duration_sec: 0 }),
  ]);
  assert.equal(selected.length, 1);
  assert.equal(excluded.length, 3);
  assert.deepEqual(byCode, {
    timeline_overruns_declared_duration: 1,
    transcript_covers_too_little: 1,
    no_declared_duration: 1,
  });
  for (const e of excluded) assert.ok(e.detail.length > 0, `${e.guid} was excluded with no reason`);
});

test("selectTranscripts on an empty list is empty, not an error", () => {
  assert.deepEqual(selectTranscripts([]), { selected: [], excluded: [], byCode: {} });
  assert.deepEqual(selectTranscripts(undefined).selected, []);
});

/* ---------------------------------------------------------------- item ids */

test("slugify truncates on a word boundary, never mid-word", () => {
  const long = "Episode 95: Liz Hillard On Wildlife Connectivity In The Pigeon River Gorge Interstate 40 corridor";
  const s = slugify(long);
  assert.ok(s.length <= SLUG_MAX_CHARS);
  assert.ok(!s.endsWith("-"));
  assert.ok(!/pigeo$/.test(s), `truncated mid-word: ${s}`);
  assert.ok(long.toLowerCase().replace(/[^a-z0-9]+/g, "-").startsWith(s));
});

test("slugify folds diacritics rather than dropping the word", () => {
  assert.equal(slugify("Patrick Fulton on the 2011 Tōhoku Earthquake"), "patrick-fulton-on-the-2011-tohoku-earthquake");
});

test("two episodes whose titles slugify the same get different ids", () => {
  const ids = mintItemIds([
    { show_id: "s", guid: "a", title: "Part One!" },
    { show_id: "s", guid: "b", title: "Part  One?" },
  ]);
  assert.equal(ids.get("a"), "s--part-one");
  assert.equal(ids.get("b"), "s--part-one-2");
  assert.notEqual(ids.get("a"), ids.get("b"));
});

test("an id prefix overrides the show_id without changing the slug", () => {
  const rows = [{ show_id: "1434744385", guid: "a", title: "Episode 95: Liz Hillard" }];
  assert.ok(mintItemIds(rows).get("a").startsWith("1434744385--"));
  assert.ok(mintItemIds(rows, { prefix: "rewilding-earth" }).get("a").startsWith("rewilding-earth--"));
});

test("a title that slugifies to nothing still yields an id", () => {
  assert.equal(mintItemIds([{ show_id: "s", guid: "a", title: "!!!" }]).get("a"), "s--episode");
});

/* ------------------------------------------------------------ enclosure mime */

test("enclosureMime reads the extension through a percent-encoded inner URL", () => {
  const anchored =
    "https://anchor.fm/s/80e7bb4/podcast/play/78532779/https%3A%2F%2Fd3ctxlq1ktw2nl.cloudfront.net%2Fstaging%2F2023-10-12%2F535a32b1.mp3";
  assert.equal(enclosureMime(anchored), "audio/mpeg");
});

test("enclosureMime ignores a query string and handles the common formats", () => {
  assert.equal(enclosureMime("https://x.test/a.mp3?dest-id=258524"), "audio/mpeg");
  assert.equal(enclosureMime("https://x.test/a.m4a"), "audio/mp4");
  assert.equal(enclosureMime("https://x.test/a.ogg#t=1"), "audio/ogg");
});

test("enclosureMime returns null rather than guessing", () => {
  // A value invented here would be written into a committed file on no evidence.
  assert.equal(enclosureMime("https://x.test/stream"), null);
  assert.equal(enclosureMime("https://x.test/a.bin"), null);
  assert.equal(enclosureMime(null), null);
  assert.equal(enclosureMime("https://x.test/%E0%A4%A.mp3"), "audio/mpeg");
});

/* --------------------------------------------------------- batch + sources */

const EPISODE = {
  item_id: "geology-bites--paul-hoffman-on-the-snowball-earth-hypothesis",
  show_id: "geology-bites",
  show_title: "Geology Bites",
  title: "Paul Hoffman on the Snowball Earth Hypothesis",
  guid: "g-1",
  reference_duration_sec: 1979,
  dai_suspected: true,
  transcript_source: "publisher",
  mime_type: "application/x-subrip",
  body: "1\n00:00:03,100 --> 00:00:07,800\nhello\n",
  enclosure_url: "https://example.test/a/episode.mp3",
  ad_free_ratio: 1,
};

test("buildBatch emits exactly what merge-segments reads", () => {
  const batch = buildBatch({ batchId: "seg-x", episodes: [EPISODE] });
  assert.equal(batch.batch_id, "seg-x");
  assert.equal(batch.source, "agent-v1");
  const e = batch.episodes[0];
  for (const f of ["item_id", "reference_duration_sec", "dai_suspected", "transcript_source"]) {
    assert.ok(e[f] !== undefined, `merge-segments requires ${f}`);
  }
  assert.equal(e.transcript.mime_type, "application/x-subrip");
  assert.ok(e.transcript.body.includes("hello"));
});

test("buildBatch refuses a batch with no id or no episodes", () => {
  assert.throws(() => buildBatch({ episodes: [EPISODE] }), /batchId/);
  assert.throws(() => buildBatch({ batchId: "x", episodes: [] }), /at least one episode/);
});

test("a source's duration_sec is the SAME number as reference_duration_sec", () => {
  /* check-forays.mjs errors when the two differ by more than 2 s. One function
     writing both from one number is the only way that cannot drift. */
  const batch = buildBatch({ batchId: "seg-x", episodes: [EPISODE] });
  const [source] = buildSources([EPISODE]);
  assert.equal(source.duration_sec, batch.episodes[0].reference_duration_sec);
  assert.equal(Math.abs(source.duration_sec - batch.episodes[0].reference_duration_sec) <= 2, true);
});

test("buildSources carries the fields check-forays requires", () => {
  const [s] = buildSources([EPISODE], { verifiedOn: "2026-08-23" });
  assert.equal(s.id, EPISODE.item_id);
  assert.equal(s.audio_url, EPISODE.enclosure_url);
  assert.equal(s.audio_type, "audio/mpeg");
  assert.equal(s.dai_suspected, true);
  assert.ok(s.duration_sec > 0);
  assert.equal(s.audio_verified_on, "2026-08-23");
  assert.equal(s.ad_free_ratio, 1);
});

test("buildSources leaves audio_type null when the URL does not say", () => {
  const [s] = buildSources([{ ...EPISODE, enclosure_url: "https://example.test/stream" }]);
  assert.equal(s.audio_type, null);
});

/* -------------------------------------------------------------- rendering */

test("renderTranscript prints both clocks, and the seconds keep two decimals", () => {
  const out = renderTranscript([{ start_sec: 754.2, end_sec: 758.94, text: " a line " }]);
  assert.match(out, /\[0000 00:12:34 \| 754\.20-758\.94\] a line/);
});

test("renderTranscript indexes every cue and keeps the text byte-for-byte", () => {
  const cues = [
    { start_sec: 0, end_sec: 1, text: "This is geology B, with all of us crumpled." },
    { start_sec: 1, end_sec: 2, text: "[Music]" },
  ];
  const lines = renderTranscript(cues).trim().split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].endsWith("This is geology B, with all of us crumpled."));
  assert.ok(lines[1].endsWith("[Music]"));
  assert.ok(lines[1].startsWith("[0001 "));
});

test("renderTranscript puts the header first and survives an empty cue list", () => {
  assert.ok(renderTranscript([], { header: "# h" }).startsWith("# h\n"));
  assert.equal(renderTranscript(null), "\n");
});

/* ------------------------------------------------------- cold open / clean out */

test("S1 flags an unbound connective and clears a bound one", () => {
  assert.ok(coldOpenWarning("and that's why it matters, in the end, for us"));
  assert.equal(coldOpenWarning("So the Lawson criterion is really a statement about"), null);
  assert.equal(coldOpenWarning("The Lawson criterion is really a statement about power"), null);
});

test("S1 needs the proper noun inside the first twelve words", () => {
  assert.equal(coldOpenWarning("so one two three four five six seven eight nine ten Hoffman"), null);
  assert.ok(coldOpenWarning("so one two three four five six seven eight nine ten eleven Hoffman"));
});

test("S2 flags an anchor that does not land on a sentence terminal", () => {
  assert.equal(cleanOutWarning("for thirty years."), null);
  assert.equal(cleanOutWarning('he called it "a runaway."'), null);
  assert.ok(cleanOutWarning("and then the pressure in the"));
});

test("median handles both parities and an empty list", () => {
  assert.equal(median([]), 0);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

/* ---------------------------------------------- A1: the anchors bound the run */

/** Four cues, one sentence spread across them, so an anchor can be built that
    reads cleanly while straddling a cue boundary — which is the whole defect. */
const A1_CUES = [
  { start_sec: 100, end_sec: 140, text: "The thing that a lot of people don't" },
  { start_sec: 140, end_sec: 180, text: "realize about Chlorine though, is that" },
  { start_sec: 180, end_sec: 220, text: "Chlorine is essential to protecting us." },
  { start_sec: 220, end_sec: 260, text: "Deficiency Report 001 was considered to be" },
  { start_sec: 260, end_sec: 300, text: "closed on the 26th of January, 2001." },
];

test("playedRun takes only the cues lying wholly inside the segment", () => {
  assert.equal(playedRun(A1_CUES, 140, 220).length, 2);
  assert.equal(playedRun(A1_CUES, 139.9995, 220.0005).length, 2);
  assert.equal(playedRun(A1_CUES, 145, 215).length, 0);
  /* The epsilon is a float-comparison allowance, not a tolerance: half a second
     of slack must still exclude the cue it straddles, or A1 stops seeing the
     boundary-width defect it exists to catch. */
  assert.equal(playedRun(A1_CUES, 140.5, 220).length, 1);
});

test("A1 passes when the anchors are exactly the run's head and tail", () => {
  const errors = anchorBoundsErrors(A1_CUES, {
    start_sec: 140,
    end_sec: 220,
    start_anchor: "realize about Chlorine though, is that",
    end_anchor: "Chlorine is essential to protecting us.",
  });
  assert.deepEqual(errors, []);
});

test("A1 catches a start_anchor trimmed out of the cue BEFORE the segment", () => {
  /* This is the real defect: the anchor reads like a whole sentence, resolves
     verbatim, sits well inside the 120 s tolerance — and the audio starts
     four seconds later than the anchor claims. */
  const errors = anchorBoundsErrors(A1_CUES, {
    start_sec: 140,
    end_sec: 220,
    start_anchor: "The thing that a lot of people don't realize about Chlorine though, is that",
    end_anchor: "Chlorine is essential to protecting us.",
  });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes("start_anchor"));
});

test("A1 catches an end_anchor that runs PAST the segment, the cut-off case", () => {
  const errors = anchorBoundsErrors(A1_CUES, {
    start_sec: 180,
    end_sec: 260,
    start_anchor: "Chlorine is essential to protecting us.",
    end_anchor: "Deficiency Report 001 was considered to be closed on the 26th of January, 2001.",
  });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes("end_anchor"));
});

test("A1 refuses a segment that plays no whole cue at all", () => {
  const errors = anchorBoundsErrors(A1_CUES, { start_sec: 145, end_sec: 215, start_anchor: "a", end_anchor: "b" });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes("no cue lies wholly inside"));
});

test("A1 matches on whole words, so an anchor trimmed into a word still fails", () => {
  const cues = [
    { start_sec: 100, end_sec: 160, text: "and it wasnt the pressure" },
    { start_sec: 160, end_sec: 220, text: "that finally gave way here." },
  ];
  const trimmed = anchorBoundsErrors(cues, {
    start_sec: 100,
    end_sec: 220,
    start_anchor: "and it was",
    end_anchor: "that finally gave way here.",
  });
  assert.equal(trimmed.length, 1);
  assert.ok(trimmed[0].includes("start_anchor"));
  const whole = anchorBoundsErrors(cues, {
    start_sec: 100,
    end_sec: 220,
    start_anchor: "and it wasnt",
    end_anchor: "gave way here.",
  });
  assert.deepEqual(whole, []);

  /* The tail needs its own case, and it has to be trimmed into a word that is
     NOT the last one: `endsWith` on a raw string accepts "ay here." against
     "...gave way here." while whole-word matching does not. */
  const trimmedTail = anchorBoundsErrors(cues, {
    start_sec: 100,
    end_sec: 220,
    start_anchor: "and it wasnt the pressure",
    end_anchor: "ay here.",
  });
  assert.equal(trimmedTail.length, 1);
  assert.ok(trimmedTail[0].includes("end_anchor"));
});

test("A1 forgives punctuation and case but not a rewrite", () => {
  const base = { start_sec: 140, end_sec: 220, end_anchor: "Chlorine is essential to protecting us." };
  assert.deepEqual(anchorBoundsErrors(A1_CUES, { ...base, start_anchor: "REALIZE about chlorine though is that" }), []);
  assert.equal(anchorBoundsErrors(A1_CUES, { ...base, start_anchor: "realise about Chlorine though, is that" }).length, 1);
});

test("the lint runs A1 when the batch carries a transcript, and drops on it", () => {
  const at = (s) => `00:${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")},000`;
  const body = A1_CUES.map((c, i) => `${i + 1}\n${at(c.start_sec)} --> ${at(c.end_sec)}\n${c.text}\n`).join("\n");
  const batch = {
    batch_id: "b",
    episodes: [{ item_id: "ep", reference_duration_sec: 2000, transcript: { mime_type: "application/x-subrip", body } }],
  };
  const bad = {
    start_sec: 140,
    end_sec: 260,
    start_anchor: "The thing that a lot of people don't realize about Chlorine though, is that",
    end_anchor: "Deficiency Report 001 was considered to be",
    topic: "nature/earth-science",
    why: "Chlorine is consumed by bare iron pipe, and then the coliforms grow",
    confidence: "high",
  };
  const out = lintCandidates({ batch, results: { batch_id: "b", results: { ep: [bad] } } });
  assert.ok(out.errors.some((e) => e.includes("A1")), out.errors.join("|"));
  assert.equal(out.dropped.size, 1);

  const good = { ...bad, start_anchor: "realize about Chlorine though, is that" };
  assert.deepEqual(lintCandidates({ batch, results: { batch_id: "b", results: { ep: [good] } } }).errors, []);
});

test("a batch with no transcript skips A1 rather than inventing a verdict", () => {
  const out = lintCandidates({ batch: { batch_id: "b", episodes: [{ item_id: "ep", reference_duration_sec: 2000 }] }, results: { batch_id: "b", results: { ep: [] } } });
  assert.deepEqual(out.errors, []);
});

/* -------------------------------------------------------------------- lint */

function batchOf(refDuration = 2000) {
  return { batch_id: "b", episodes: [{ item_id: "ep", reference_duration_sec: refDuration }] };
}
function resultsOf(segments) {
  return { batch_id: "b", results: { ep: segments } };
}
function seg(over = {}) {
  return {
    start_sec: 600,
    end_sec: 710,
    start_anchor: "The Lawson criterion is really a statement about power balance.",
    end_anchor: "and that is why the tokamak won by default for thirty years.",
    topic: "nature/earth-science",
    why: "Hoffman explains how a frozen ocean still weathers rock",
    confidence: "high",
    ...over,
  };
}

test("a well-formed candidate passes the lint clean", () => {
  const out = lintCandidates({ batch: batchOf(), results: resultsOf([seg()]) });
  assert.deepEqual(out.errors, []);
  assert.equal(out.stats.kept, 1);
  assert.equal(out.dropped.size, 0);
});

test("L1 drops a candidate under the 30 s floor", () => {
  const out = lintCandidates({ batch: batchOf(), results: resultsOf([seg({ end_sec: 600 + 29.9 })]) });
  assert.equal(out.dropped.size, 1);
  assert.ok(out.errors.some((e) => e.includes("L1")));
  // ... and passes at exactly the floor.
  assert.equal(lintCandidates({ batch: batchOf(), results: resultsOf([seg({ end_sec: 600 + 30 })]) }).dropped.size, 0);
});

/* The numbers below are written out rather than derived from the exported
   constants. Deriving them makes the test move WITH a change to the constant,
   so raising the cap and raising the fixture cancel out and the mutation
   survives — which is what happened the first time this was mutation-tested.
   The constants are pinned separately, once, so a change to either is loud. */
test("the length constants are the ones section 9 publishes", () => {
  assert.equal(MIN_SEGMENT_SEC, 30);
  assert.equal(SOFT_MAX_SEGMENT_SEC, 240);
  assert.equal(HARD_MAX_SEGMENT_SEC, 480);
  assert.equal(MAX_SHARE_OF_EPISODE, 0.2);
  assert.equal(MUST_MERGE_GAP_SEC, 45);
  assert.equal(SHOULD_MERGE_GAP_SEC, 180);
});

test("L3 drops a candidate over the hard maximum", () => {
  const long = { needs_review: true, long_reason: "one continuous account of the accident" };
  const out = lintCandidates({ batch: batchOf(100000), results: resultsOf([seg({ end_sec: 600 + 481, ...long })]) });
  assert.ok(out.errors.some((e) => e.includes("L3")), out.errors.join("|"));
  assert.equal(out.dropped.size, 1);
  const ok = lintCandidates({ batch: batchOf(100000), results: resultsOf([seg({ end_sec: 600 + 480, ...long })]) });
  assert.ok(!ok.errors.some((e) => e.includes("L3")));
});

test("L5 drops a candidate over 20% of its own episode, however long it is absolutely", () => {
  const long = { end_sec: 600 + 300, needs_review: true, long_reason: "one continuous account of the accident" };
  // 300 s of a 1400 s episode is 21.4%.
  const out = lintCandidates({ batch: batchOf(1400), results: resultsOf([seg(long)]) });
  assert.ok(out.errors.some((e) => e.includes("L5")), out.errors.join("|"));
  // The same segment in a 1600 s episode is 18.8% and fine.
  const ok = lintCandidates({ batch: batchOf(1600), results: resultsOf([seg(long)]) });
  assert.deepEqual(ok.errors, []);
});

test("L4 requires a long_reason AND needs_review over the soft maximum", () => {
  const long = seg({ end_sec: 600 + 241 });
  const batch = batchOf(100000);
  assert.ok(lintCandidates({ batch, results: resultsOf([long]) }).errors.some((e) => e.includes("no long_reason")));
  assert.ok(
    lintCandidates({ batch, results: resultsOf([{ ...long, long_reason: "one continuous account of the accident" }]) }).errors.some((e) =>
      e.includes("needs_review must be true")
    )
  );
  assert.deepEqual(
    lintCandidates({ batch, results: resultsOf([{ ...long, long_reason: "one continuous account of the accident", needs_review: true }]) }).errors,
    []
  );
});

test("L4's long_reason obeys the same copy rules as `why`", () => {
  const long = seg({ end_sec: 600 + 241, needs_review: true, long_reason: "a deep dive into the failure" });
  assert.ok(lintCandidates({ batch: batchOf(100000), results: resultsOf([long]) }).errors.some((e) => e.includes("banned phrase")));
});

test("M1 drops the second of two same-episode segments closer than 45 s", () => {
  const out = lintCandidates({
    batch: batchOf(),
    results: resultsOf([seg({ start_sec: 600, end_sec: 710 }), seg({ start_sec: 710 + 44, end_sec: 900 })]),
  });
  assert.ok(out.errors.some((e) => e.includes("M1")));
  assert.equal(out.dropped.size, 1);
  assert.equal(out.stats.kept, 1);
});

test("M1 measures against the last KEPT candidate, so a drop does not cascade", () => {
  /* Three candidates 40 s apart. The second is genuinely too close to the first
     and goes; the third is then 150 s from the surviving one and must SURVIVE.
     Comparing to the dropped neighbour would take it too. */
  const out = lintCandidates({
    batch: batchOf(),
    results: resultsOf([
      seg({ start_sec: 0, end_sec: 100 }),
      seg({ start_sec: 140, end_sec: 240, keep_separate_reason: "different sub-topic" }),
      seg({ start_sec: 280, end_sec: 380, keep_separate_reason: "different sub-topic" }),
    ]),
  });
  assert.equal(out.dropped.size, 1, out.errors.join("|"));
  assert.ok(out.dropped.has("ep[1]"));
  assert.equal(out.stats.kept, 2);
});

test("the left edge advances with every kept candidate, not only the first", () => {
  /* 0-100, 200-300, 330-430. The middle one is 100 s after the first (an M2
     warning) and the third is 30 s after the MIDDLE one, which is an M1 drop.
     A left edge that never advances measures the third against the first — a
     230 s gap — and lets a must-merge pair through. */
  const out = lintCandidates({
    batch: batchOf(),
    results: resultsOf([
      seg({ start_sec: 0, end_sec: 100 }),
      seg({ start_sec: 200, end_sec: 300 }),
      seg({ start_sec: 330, end_sec: 430 }),
    ]),
  });
  assert.ok(out.warnings.some((w) => w.includes("M2") && w.includes("ep[1]")), out.warnings.join("|"));
  assert.ok(out.errors.some((e) => e.includes("M1") && e.includes("ep[2]")), out.errors.join("|"));
  assert.deepEqual([...out.dropped], ["ep[2]"]);
});

test("M1 fires on the chronological neighbour, not the authored order", () => {
  const out = lintCandidates({
    batch: batchOf(),
    results: resultsOf([seg({ start_sec: 740, end_sec: 900 }), seg({ start_sec: 600, end_sec: 710 })]),
  });
  assert.ok(out.errors.some((e) => e.includes("M1")), out.errors.join("|"));
});

test("M2 warns without dropping, and a stated reason clears it", () => {
  const pair = (extra) => [seg({ start_sec: 600, end_sec: 710 }), seg({ start_sec: 810, end_sec: 900, ...extra })];
  const warned = lintCandidates({ batch: batchOf(), results: resultsOf(pair({})) });
  assert.ok(warned.warnings.some((w) => w.includes("M2")));
  assert.equal(warned.dropped.size, 0);
  const cleared = lintCandidates({ batch: batchOf(), results: resultsOf(pair({ keep_separate_reason: "different sub-topic" })) });
  assert.ok(!cleared.warnings.some((w) => w.includes("M2")));
});

test("a gap over the should-merge window is not even warned about", () => {
  const out = lintCandidates({
    batch: batchOf(),
    results: resultsOf([seg({ start_sec: 600, end_sec: 710 }), seg({ start_sec: 710 + 181, end_sec: 1050 })]),
  });
  assert.deepEqual(out.warnings.filter((w) => w.includes("M")), []);
});

test("overlapping same-episode segments are dropped, not merged", () => {
  const out = lintCandidates({
    batch: batchOf(),
    results: resultsOf([seg({ start_sec: 600, end_sec: 800 }), seg({ start_sec: 700, end_sec: 900 })]),
  });
  assert.ok(out.errors.some((e) => e.includes("overlaps")));
  assert.equal(out.dropped.size, 1);
});

test("S1 and S2 warn but NEVER drop", () => {
  const out = lintCandidates({
    batch: batchOf(),
    results: resultsOf([seg({ start_anchor: "and that is the whole of it, really, you know", end_anchor: "and then the pressure in the" })]),
  });
  assert.equal(out.dropped.size, 0);
  assert.equal(out.stats.kept, 1);
  assert.ok(out.warnings.some((w) => w.includes("S1")));
  assert.ok(out.warnings.some((w) => w.includes("S2")));
});

test("cold_open_ok suppresses S1 and nothing else", () => {
  const s = seg({ start_anchor: "and that is the whole of it, really, you know", cold_open_ok: true });
  const out = lintCandidates({ batch: batchOf(), results: resultsOf([s]) });
  assert.ok(!out.warnings.some((w) => w.includes("S1")));
});

test("an unusable interval is dropped before any rule reads it", () => {
  const out = lintCandidates({ batch: batchOf(), results: resultsOf([seg({ end_sec: 600 }), seg({ start_sec: "x" })]) });
  assert.equal(out.dropped.size, 2);
  assert.equal(out.stats.kept, 0);
});

test("a candidate authored against an episode not in the batch is DROPPED, not just reported", () => {
  const results = { batch_id: "b", results: { ghost: [seg(), seg({ start_sec: 2000, end_sec: 2100 })] } };
  const out = lintCandidates({ batch: batchOf(), results });
  assert.ok(out.errors.some((e) => e.includes("absent from the batch")));
  assert.equal(out.dropped.size, 2);
  assert.equal(out.stats.kept, 0);
  /* --write must not leave them in the file it says it cleaned. */
  assert.deepEqual(applyLint(results, out.dropped).results, {});
});

test("applyLint keeps an entry's sibling keys when it is an object, not a bare array", () => {
  const results = { batch_id: "b", results: { ep: { note: "rough ASR", segments: [seg({ start_sec: 600, end_sec: 605 }), seg({ start_sec: 1000, end_sec: 1120 })] } } };
  const { dropped } = lintCandidates({ batch: batchOf(), results });
  const out = applyLint(results, dropped);
  assert.equal(out.results.ep.note, "rough ASR");
  assert.equal(out.results.ep.segments.length, 1);
});

test("an episode that yielded nothing is not an error", () => {
  const out = lintCandidates({ batch: batchOf(), results: { batch_id: "b", results: { ep: [] } } });
  assert.deepEqual(out.errors, []);
  assert.equal(out.stats.candidates, 0);
});

test("B1 warns when the batch median falls outside the target band", () => {
  const short = lintCandidates({
    batch: batchOf(),
    results: resultsOf([seg({ start_sec: 0, end_sec: 40 }), seg({ start_sec: 200, end_sec: 245 }), seg({ start_sec: 400, end_sec: 435 })]),
  });
  assert.ok(short.warnings.some((w) => w.includes("B1")));
  assert.ok(!lintCandidates({ batch: batchOf(), results: resultsOf([seg()]) }).warnings.some((w) => w.includes("B1")));
});

test("applyLint removes exactly the dropped candidates and keeps the rest", () => {
  const results = resultsOf([seg({ start_sec: 600, end_sec: 605 }), seg({ start_sec: 1000, end_sec: 1120 })]);
  const { dropped } = lintCandidates({ batch: batchOf(), results });
  const out = applyLint(results, dropped);
  assert.equal(out.results.ep.length, 1);
  assert.equal(out.results.ep[0].start_sec, 1000);
  assert.equal(out.batch_id, "b");
});

test("applyLint drops the episode key entirely when nothing survives", () => {
  const results = resultsOf([seg({ start_sec: 600, end_sec: 605 })]);
  const { dropped } = lintCandidates({ batch: batchOf(), results });
  assert.deepEqual(applyLint(results, dropped).results, {});
});

/* ------------------------------------------------- roles and the DAI verdict */

test("the role ceilings are check-forays' own table, not a second copy", () => {
  assert.equal(roleMaxSec("quote"), ROLE_MAX_SEC.quote);
  assert.equal(roleMaxSec("explanation"), ROLE_MAX_SEC.explanation);
  assert.equal(roleMaxSec("narrative"), ROLE_MAX_SEC.narrative);
  assert.equal(HARD_MAX_SEGMENT_SEC, Math.max(...Object.values(ROLE_MAX_SEC)));
});

test("an unknown or missing role falls back to the most permissive ceiling", () => {
  assert.equal(roleMaxSec(undefined), HARD_MAX_SEGMENT_SEC);
  assert.equal(roleMaxSec("banter"), HARD_MAX_SEGMENT_SEC);
});

test("L3 uses the role's own ceiling, so a long `quote` is dropped where a `narrative` is not", () => {
  const long = { needs_review: true, long_reason: "one continuous account of the accident" };
  const batch = batchOf(100000);
  const asQuote = lintCandidates({ batch, results: resultsOf([seg({ end_sec: 600 + 200, role: "quote", ...long })]) });
  assert.ok(asQuote.errors.some((e) => e.includes("L3") && e.includes("quote")), asQuote.errors.join("|"));
  const asNarrative = lintCandidates({ batch, results: resultsOf([seg({ end_sec: 600 + 200, role: "narrative", ...long })]) });
  assert.deepEqual(asNarrative.errors, []);
});

test("an unresolved DAI probe stays null and is never folded to false", () => {
  /* `data/transcript-availability.json` really does ship omega tau with
     `dai_suspected: null`, and `false` there would waive ADR-0007's anchor
     requirement on a show nobody could resolve. */
  const map = resolveDaiVerdicts({
    availability: { shows: [{ show_id: "omega-tau", dai_suspected: null, apple_collection_id: 1 }] },
  });
  assert.equal(map.get("omega-tau").dai, null);
});

test("the resolved classification outranks the sweep's feed-host heuristic", () => {
  const map = resolveDaiVerdicts({
    availability: { shows: [{ show_id: "geology-bites", dai_suspected: true, apple_collection_id: 1525620301, feed_url: "https://f.test/rss" }] },
    classification: { shows: { 1525620301: { dai: false, ad_inflation: { verdict: "ad-free", median_ratio: 1 } } } },
  });
  const meta = map.get("geology-bites");
  assert.equal(meta.dai, false);
  assert.match(meta.dai_source, /dai-classification/);
  assert.equal(meta.ad_free_ratio, 1);
  assert.equal(meta.feed_url, "https://f.test/rss");
});

test("a show the classifier has never seen keeps the sweep's verdict", () => {
  const map = resolveDaiVerdicts({
    yieldDoc: { shows: [{ show_id: "1434744385", dai_suspected: false, apple_collection_id: 1434744385 }] },
    classification: { shows: {} },
  });
  assert.equal(map.get("1434744385").dai, false);
  assert.match(map.get("1434744385").dai_source, /sweep/);
});

test("the curated sweep wins over the breadth yield for a show in both", () => {
  const map = resolveDaiVerdicts({
    availability: { shows: [{ show_id: "dup", dai_suspected: true, feed_url: "curated" }] },
    yieldDoc: { shows: [{ show_id: "dup", dai_suspected: false, feed_url: "breadth" }] },
  });
  assert.equal(map.get("dup").dai, true);
  assert.equal(map.get("dup").feed_url, "curated");
});

test("a classification entry with a non-boolean verdict does not overwrite the sweep", () => {
  const map = resolveDaiVerdicts({
    availability: { shows: [{ show_id: "s", dai_suspected: true, apple_collection_id: 9 }] },
    classification: { shows: { 9: { dai: null } } },
  });
  assert.equal(map.get("s").dai, true);
});

/* --------------------------------------------------------------------- CLI */

test("the CLI reports the excluded episodes and writes a batch a merge can read", () => {
  const dir = mkdtempSync(join(tmpdir(), "prep-"));
  const digest = join(dir, "digest.json");
  writeFileSync(
    digest,
    JSON.stringify({
      transcripts: [
        row({ guid: "keep", title: "Keeper" }),
        row({ guid: "drop", title: "1: BP Texas City", feed_duration_sec: 2071, last_cue_sec: 3033 }),
      ],
    })
  );
  const tdir = join(dir, "transcripts");
  mkdirSync(join(tdir, "normalized", "geology-bites"), { recursive: true });
  mkdirSync(join(tdir, "raw", "geology-bites"), { recursive: true });
  writeFileSync(
    join(tdir, "normalized", "geology-bites", "keep.json"),
    JSON.stringify({ show_id: "geology-bites", guid: "keep", cues: [{ start_sec: 1, end_sec: 2, text: "hello there" }] })
  );
  writeFileSync(join(tdir, "raw", "geology-bites", "keep.srt"), "1\n00:00:01,000 --> 00:00:02,000\nhello there\n");

  const out = join(dir, "batch.json");
  const sources = join(dir, "sources.json");
  const stdout = execFileSync(
    process.execPath,
    [CLI, "--show", "geology-bites", "--batch-id", "seg-t", "--out", out, "--sources-out", sources, "--render", join(dir, "render")],
    { env: { ...process.env, DIGEST_PATHS: digest, TRANSCRIPTS_DIR: tdir }, encoding: "utf8" }
  );

  assert.match(stdout, /1 excluded/);
  assert.match(stdout, /BP Texas City/);
  const batch = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(batch.episodes.length, 1);
  assert.equal(batch.episodes[0].guid, "keep");
  assert.equal(batch.episodes[0].transcript.mime_type, "application/x-subrip");
  assert.equal(JSON.parse(readFileSync(sources, "utf8"))[0].duration_sec, batch.episodes[0].reference_duration_sec);
  assert.ok(existsSync(join(dir, "render", `${batch.episodes[0].item_id}.txt`)));
});

test("the CLI refuses a show with no DAI verdict rather than claiming one", () => {
  const dir = mkdtempSync(join(tmpdir(), "prep-nodai-"));
  const digest = join(dir, "digest.json");
  writeFileSync(digest, JSON.stringify({ transcripts: [row({ show_id: "ghost-show", guid: "keep" })] }));
  const tdir = join(dir, "transcripts");
  mkdirSync(join(tdir, "normalized", "ghost-show"), { recursive: true });
  mkdirSync(join(tdir, "raw", "ghost-show"), { recursive: true });
  writeFileSync(
    join(tdir, "normalized", "ghost-show", "keep.json"),
    JSON.stringify({ show_id: "ghost-show", guid: "keep", cues: [{ start_sec: 1, end_sec: 2, text: "hello there" }] })
  );
  writeFileSync(join(tdir, "raw", "ghost-show", "keep.srt"), "1\n00:00:01,000 --> 00:00:02,000\nhello there\n");
  assert.throws(
    () =>
      execFileSync(process.execPath, [CLI, "--show", "ghost-show", "--batch-id", "seg-t", "--out", join(dir, "batch.json")], {
        env: { ...process.env, DIGEST_PATHS: digest, TRANSCRIPTS_DIR: tdir },
        encoding: "utf8",
        stdio: "pipe",
      }),
    (e) => e.status === 1 && /no DAI verdict/.test(e.stderr)
  );
  assert.equal(existsSync(join(dir, "batch.json")), false, "no batch may be written without a verdict");
});

test("the CLI's lint mode exits non-zero on a violation and zero on a clean batch", () => {
  const dir = mkdtempSync(join(tmpdir(), "lint-"));
  const batch = join(dir, "batch.json");
  const results = join(dir, "results.json");
  writeFileSync(batch, JSON.stringify(batchOf()));

  writeFileSync(results, JSON.stringify(resultsOf([seg({ end_sec: 610 })])));
  assert.throws(
    () => execFileSync(process.execPath, [CLI, "--lint", results, "--batch", batch], { encoding: "utf8", stdio: "pipe" }),
    (e) => e.status === 1 && /L1/.test(e.stdout)
  );

  writeFileSync(results, JSON.stringify(resultsOf([seg()])));
  assert.match(execFileSync(process.execPath, [CLI, "--lint", results, "--batch", batch], { encoding: "utf8" }), /1 kept, 0 dropped/);
});
