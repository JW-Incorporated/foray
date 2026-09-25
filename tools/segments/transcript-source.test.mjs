/* transcript_source end to end: an Apple Podcasts transcript is neither
   skipped nor relabelled on its way from a normalized body to the pool.
   Run: node --test tools/segments/transcript-source.test.mjs

   WHY THIS FILE EXISTS. foray-db's engine publishes EXISTING transcripts
   (publisher-published, and Apple Podcasts') into foray's normalized layout,
   and an Apple body states `transcript_source: "apple-podcasts"`. On main
   before this change two sites lost that value, silently:

     - `prepare-segment-batch.mjs` wrote `transcript_source: "publisher"` onto
       every batch episode whatever the body said (a RELABEL), and
     - `merge-segments.mjs`'s `TRANSCRIPT_SOURCES` held only publisher and
       asr-local, so an episode that did carry the value was refused (a SKIP).

   The test that matters most is the end-to-end one: the real prepare CLI over
   an on-disk normalized body, then the real merge CLI over the batch it wrote,
   and the value read back off the merged row. A unit test per site proves each
   half; only the pipe proves nothing in between rewrites the value. The
   absent-field case runs the same pipe, because "absent still means publisher"
   is the other half of the contract and the one every body on disk today
   relies on.

   One list: `TRANSCRIPT_SOURCES` is imported by `check-forays.mjs` and
   `prepare-segment-batch.mjs`, and the backend's `TranscriptSourceSchema`
   mirror is pinned against it in `backend/test/mintedSegmentRow.test.ts`. */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { TRANSCRIPT_SOURCES, mergeSegments, validateSegmentsDocument, SEGMENTS_VERSION } from "./merge-segments.mjs";
import { transcriptSourceOf } from "./prepare-segment-batch.mjs";
import { ACCEPTED_SHAPES } from "../foray/check-forays.mjs";

const PREPARE = fileURLToPath(new URL("./prepare-segment-batch.mjs", import.meta.url));
const MERGE = fileURLToPath(new URL("./merge-segments.mjs", import.meta.url));

const TOPIC = "engineering/energy-fusion";

/* ------------------------------------------------------------ the one list */

test("TRANSCRIPT_SOURCES is exactly publisher, asr-local and apple-podcasts", () => {
  assert.deepEqual([...TRANSCRIPT_SOURCES].sort(), ["apple-podcasts", "asr-local", "publisher"]);
});

test("check-forays enumerates the merge's own list, not a copy of it", () => {
  assert.deepEqual([...ACCEPTED_SHAPES["segment.transcript_source"]], [...TRANSCRIPT_SOURCES]);
});

/* -------------------------------------------------- prepare: read, not set */

test("transcriptSourceOf: an absent or null field is publisher, as every fetched body has always meant", () => {
  assert.equal(transcriptSourceOf({ guid: "g" }), "publisher");
  assert.equal(transcriptSourceOf({ guid: "g", transcript_source: null }), "publisher");
  assert.equal(transcriptSourceOf(undefined), "publisher");
});

test("transcriptSourceOf: a stated value in the vocabulary is carried as stated", () => {
  assert.equal(transcriptSourceOf({ transcript_source: "apple-podcasts" }), "apple-podcasts");
  assert.equal(transcriptSourceOf({ transcript_source: "asr-local" }), "asr-local");
  assert.equal(transcriptSourceOf({ transcript_source: "publisher" }), "publisher");
});

test("transcriptSourceOf: a stated value outside the vocabulary throws instead of becoming publisher", () => {
  for (const bad of ["apple", "Apple Podcasts", "apple_podcasts", "", " apple-podcasts", 42, true, {}]) {
    assert.throws(
      () => transcriptSourceOf({ transcript_source: bad }, "show/ep"),
      (e) => /show\/ep: transcript_source/.test(e.message) && /not one of/.test(e.message),
      `${JSON.stringify(bad)} must throw`
    );
  }
});

/* ------------------------------------------------------ merge: not skipped */

const VTT = `WEBVTT

00:00:10.000 --> 00:00:16.000
Snowball Earth is the idea that the whole planet froze over

00:00:16.000 --> 00:00:24.000
and the ice reached the equator more than once in the deep past.

00:01:00.000 --> 00:01:08.000
and that is why the cap carbonates sit right on top of the glacial deposits
`;

const START_ANCHOR = "Snowball Earth is the idea that the whole planet froze over";
const END_ANCHOR = "the cap carbonates sit right on top of the glacial deposits";

function mergeOne(transcriptSource) {
  const batch = {
    batch_id: "seg-apple-t",
    episodes: [
      {
        item_id: "ep-1",
        reference_duration_sec: 1979,
        dai_suspected: true,
        transcript_source: transcriptSource,
        transcript: { body: VTT, mime_type: "text/vtt" },
      },
    ],
  };
  const results = {
    batch_id: "seg-apple-t",
    results: {
      "ep-1": {
        segments: [
          { topic: TOPIC, start_sec: 10, end_sec: 68, start_anchor: START_ANCHOR, end_anchor: END_ANCHOR, why: "Hoffman on why the ice reached the equator", confidence: "high" },
        ],
      },
    },
  };
  return mergeSegments({ batch, results, taxonomyNodeIds: new Set([TOPIC]), existing: { version: SEGMENTS_VERSION, segments: [] } });
}

test("merge: an apple-podcasts episode merges and its row says apple-podcasts", () => {
  const out = mergeOne("apple-podcasts");
  assert.deepEqual(out.errors, []);
  assert.equal(out.merged, 1);
  assert.equal(out.doc.segments[0].transcript_source, "apple-podcasts");
});

test("merge: a value outside the vocabulary is still refused, naming apple-podcasts among the accepted", () => {
  const out = mergeOne("apple");
  assert.equal(out.merged, 0);
  assert.match(out.errors.join("\n"), /transcript_source must be one of publisher\/asr-local\/apple-podcasts/);
});

test("--check: a pool row with apple-podcasts is valid; a near miss is not", () => {
  const row = mergeOne("apple-podcasts").doc.segments[0];
  assert.deepEqual(validateSegmentsDocument({ version: SEGMENTS_VERSION, segments: [row] }, new Set([TOPIC])), []);
  const errors = validateSegmentsDocument({ version: SEGMENTS_VERSION, segments: [{ ...row, transcript_source: "apple" }] }, new Set([TOPIC]));
  assert.match(errors.join("\n"), /bad transcript_source "apple"/);
});

/* ------------------------------------------ prepare -> merge, the real CLIs */

/** A digest row for Geology Bites, a show with a committed DAI verdict (the
    prepare CLI refuses a show without one), and an on-disk corpus laid out the
    way `fetch-transcripts.mjs` and foray-db both write it: `normalized/<show>/
    <stem>.json` beside `raw/<show>/<stem>.<ext>`. */
function corpus({ statedSource } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "apple-src-"));
  const digest = join(dir, "digest.json");
  writeFileSync(
    digest,
    JSON.stringify({
      transcripts: [
        {
          show_id: "geology-bites",
          show_title: "Geology Bites",
          guid: "apple-g-1",
          title: "Paul Hoffman on the Snowball Earth Hypothesis",
          enclosure_url: "https://example.test/a/episode.mp3",
          transcript_url: "https://example.test/a/episode.vtt",
          sha256: "abc",
          cues: 3,
          last_cue_sec: 1969.5,
          feed_duration_sec: 1979,
        },
      ],
    })
  );
  const tdir = join(dir, "transcripts");
  const showDir = "geology-bites-0000";
  mkdirSync(join(tdir, "normalized", showDir), { recursive: true });
  mkdirSync(join(tdir, "raw", showDir), { recursive: true });
  const body = {
    show_id: "geology-bites",
    guid: "apple-g-1",
    source_url: "https://example.test/apple/transcript.ttml",
    ...(statedSource === undefined ? {} : { transcript_source: statedSource }),
    cues: [
      { start_sec: 10, end_sec: 16, text: "Snowball Earth is the idea that the whole planet froze over", speaker: null },
      { start_sec: 16, end_sec: 24, text: "and the ice reached the equator more than once in the deep past.", speaker: null },
      { start_sec: 60, end_sec: 68, text: "and that is why the cap carbonates sit right on top of the glacial deposits", speaker: null },
    ],
  };
  writeFileSync(join(tdir, "normalized", showDir, "apple-g-1-abcd.json"), JSON.stringify(body));
  writeFileSync(join(tdir, "raw", showDir, "apple-g-1-abcd.vtt"), VTT);
  return { dir, digest, tdir };
}

function prepare({ dir, digest, tdir }) {
  const out = join(dir, "batch.json");
  execFileSync(process.execPath, [PREPARE, "--show", "geology-bites", "--batch-id", "seg-apple-e2e", "--out", out], {
    env: { ...process.env, DIGEST_PATHS: digest, TRANSCRIPTS_DIR: tdir },
    encoding: "utf8",
    stdio: "pipe",
  });
  return out;
}

function mergeCli({ dir }, batchPath) {
  const batch = JSON.parse(readFileSync(batchPath, "utf8"));
  const resultsPath = join(dir, "results.json");
  writeFileSync(
    resultsPath,
    JSON.stringify({
      batch_id: batch.batch_id,
      results: {
        [batch.episodes[0].item_id]: {
          segments: [
            { topic: TOPIC, start_sec: 10, end_sec: 68, start_anchor: START_ANCHOR, end_anchor: END_ANCHOR, why: "Hoffman on why the ice reached the equator", confidence: "high" },
          ],
        },
      },
    })
  );
  const poolPath = join(dir, "pool.json");
  const stdout = execFileSync(process.execPath, [MERGE, "--batch", batchPath, "--results", resultsPath], {
    env: { ...process.env, SEGMENTS_PATH: poolPath },
    encoding: "utf8",
    stdio: "pipe",
  });
  return { batch, stdout, pool: JSON.parse(readFileSync(poolPath, "utf8")) };
}

test("end to end: an Apple-sourced normalized transcript goes prepare -> merge as apple-podcasts, merged, not relabelled", () => {
  const c = corpus({ statedSource: "apple-podcasts" });
  const { batch, stdout, pool } = mergeCli(c, prepare(c));
  assert.equal(batch.episodes.length, 1, "prepare must not skip the Apple episode");
  assert.equal(batch.episodes[0].transcript_source, "apple-podcasts", "prepare must carry the body's own provenance");
  assert.match(stdout, /merged=1 rejected=0/);
  assert.equal(pool.segments.length, 1);
  assert.equal(pool.segments[0].transcript_source, "apple-podcasts");
  assert.deepEqual(validateSegmentsDocument(pool, new Set([TOPIC])), []);
});

test("end to end: a body with no transcript_source still lands as publisher", () => {
  const c = corpus();
  const { batch, stdout, pool } = mergeCli(c, prepare(c));
  assert.equal(batch.episodes[0].transcript_source, "publisher");
  assert.match(stdout, /merged=1 rejected=0/);
  assert.equal(pool.segments[0].transcript_source, "publisher");
});

test("end to end: a body stating an unknown transcript_source stops prepare and writes no batch", () => {
  const c = corpus({ statedSource: "apple" });
  assert.throws(
    () => prepare(c),
    (e) => e.status !== 0 && /transcript_source "apple" is not one of/.test(String(e.stderr))
  );
  assert.equal(existsSync(join(c.dir, "batch.json")), false);
});
