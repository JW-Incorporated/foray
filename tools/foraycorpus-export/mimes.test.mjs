/* PKG-02 (docs/roadmap/corpus.md): the transcript mime classifier. Pure
   functions over string constants; no network, no files. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { TIMED_MIMES, PLAIN_MIMES, classifyTranscriptMime, isTimedMime } from "./mimes.mjs";
import { TIMED_TRANSCRIPT_TYPES } from "../segments/sweep-transcripts.mjs";

/* The corpus's junk variants are real rows (brief §2: 763 "/application/srt",
   184 "plain/txt"), and application/pdf is prose, not "other". A null mime is
   "other" (it is not a mime; the brief's plain bucket counts it, we do not).
   Mutation that turns this red: delete "/application/srt" from TIMED_MIMES in
   mimes.mjs (normalizeMimeType keeps the leading slash, so the list entry is
   the only thing that classifies it). */
test("leading-slash variants are timed; plain list and unknowns classify as the brief says", () => {
  assert.equal(classifyTranscriptMime("/application/srt"), "timed");
  assert.equal(classifyTranscriptMime("/application/vtt"), "timed");
  assert.equal(classifyTranscriptMime("text/plain"), "plain");
  assert.equal(classifyTranscriptMime("plain/txt"), "plain");
  assert.equal(classifyTranscriptMime("application/pdf"), "plain");
  assert.equal(classifyTranscriptMime("image/png"), "other");
  assert.equal(classifyTranscriptMime("application/json+chapters"), "other");
  assert.equal(classifyTranscriptMime(null), "other");
  assert.equal(classifyTranscriptMime(undefined), "other");
  assert.equal(classifyTranscriptMime(42), "other");
  assert.equal(classifyTranscriptMime(""), "other");
  assert.ok(!PLAIN_MIMES.includes(null));
});

/* RSS publishers write the type attribute in any case, with whitespace and
   parameters; a raw comparison files those as "other" and loses the episode.
   Mutation that turns this red: in classifyTranscriptMime replace
   `normalizeMimeType(raw)` with `raw` (no lowercase/trim/parameter strip). */
test("case, whitespace and parameters are normalised before matching", () => {
  assert.equal(classifyTranscriptMime("TEXT/VTT "), "timed");
  assert.equal(classifyTranscriptMime("text/vtt; charset=utf-8"), "timed");
  assert.equal(classifyTranscriptMime(" Text/Plain"), "plain");
  assert.equal(isTimedMime("TEXT/VTT "), true);
  assert.equal(isTimedMime("text/plain"), false);
});

/* The pipeline's own timed list (sweep-transcripts.mjs, mirroring
   backend/src/feeds/parser.ts) must stay inside ours, or the exporter would
   call an episode untimed that the pipeline happily anchors on.
   Mutation that turns this red: remove "application/x-subrip" from
   TIMED_MIMES in mimes.mjs. */
test("TIMED_MIMES is a superset of the pipeline's TIMED_TRANSCRIPT_TYPES", () => {
  assert.ok(TIMED_TRANSCRIPT_TYPES.length > 0);
  const missing = TIMED_TRANSCRIPT_TYPES.filter((t) => !TIMED_MIMES.includes(t));
  assert.deepEqual(missing, []);
  for (const t of TIMED_TRANSCRIPT_TYPES) assert.equal(classifyTranscriptMime(t), "timed");
});
