/* The transcript label: extraction from real feed shapes, and survival through a
   prepare -> merge round trip.  Run: node --test tools/classify/transcript-label.test.mjs

   WHAT THE LABEL IS. A COST signal, not a requirement: we transcribe our own
   audio, so a show shipping `<podcast:transcript>` is cheap to build from and one
   that does not is merely expensive. The measured rate and the rationale are in
   labels.mjs, which is the single place they are written down. Nothing here may
   read the label as a gate; tools/classify/no-exclusion.test.mjs enforces that.

   The fixtures below are shapes real feeds emit, including the ugly ones: a
   transcript tag with no `@type`, several tags on one episode, a prose-only
   transcript that cannot anchor anything, and a body that is not XML at all. */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { transcriptLabelsFromXml, emptyTranscriptLabels, mergeTranscriptLabels, LABEL_SCHEMA_VERSION, TRANSCRIPT_LABEL_FIELDS } from "./labels.mjs";
import { batchShowFrom } from "./prepare-batch.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const feed = (items) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <channel><title>Fixture</title><description>A feed</description>
${items}
  </channel></rss>`;

const item = (n, tags = "") => `    <item>
      <title>Episode ${n}</title>
      <guid>ep-${n}</guid>
      <pubDate>Mon, 0${n} Aug 2026 10:00:00 GMT</pubDate>
      <enclosure url="https://cdn.example/ep${n}.mp3" type="audio/mpeg" length="1000"/>
${tags}
    </item>`;

const vtt = (n) => `      <podcast:transcript url="https://cdn.example/ep${n}.vtt" type="text/vtt"/>`;
const srt = (n) => `      <podcast:transcript url="https://cdn.example/ep${n}.srt" type="application/x-subrip"/>`;
const txt = (n) => `      <podcast:transcript url="https://cdn.example/ep${n}.txt" type="text/plain"/>`;
const untyped = (n) => `      <podcast:transcript url="https://cdn.example/ep${n}.vtt"/>`;

/* ---------- extraction ---------- */

test("a feed with no transcript tags labels zero, without claiming the feed is bad", () => {
  const l = transcriptLabelsFromXml(feed([item(1), item(2)].join("\n")), 8);
  assert.equal(l.transcript_present, false);
  assert.equal(l.episodes_with_transcript, 0);
  assert.equal(l.episodes_with_timed_transcript, 0);
  assert.equal(l.transcript_tags, 0);
  assert.deepEqual(l.transcript_types, {});
  // The distinction that matters: we DID read the feed. Two episodes, no tags.
  assert.equal(l.episodes_sampled, 2);
});

test("a timed VTT counts as both a tag and a timed transcript", () => {
  const l = transcriptLabelsFromXml(feed([item(1, vtt(1)), item(2)].join("\n")), 8);
  assert.equal(l.transcript_present, true);
  assert.equal(l.episodes_with_transcript, 1);
  assert.equal(l.episodes_with_timed_transcript, 1);
  assert.equal(l.transcript_tags, 1);
  assert.deepEqual(l.transcript_types, { "text/vtt": 1 });
});

test("SRT is timed too — the vocabulary is single-sourced from the transcript sweep", () => {
  const l = transcriptLabelsFromXml(feed(item(1, srt(1))), 8);
  assert.equal(l.episodes_with_timed_transcript, 1);
  assert.deepEqual(l.transcript_types, { "application/x-subrip": 1 });
});

test("a prose-only transcript is a tag but NOT timed — the load-bearing distinction", () => {
  // text/plain is the third most published format and cannot anchor a segment.
  // Counting it as timed would promise a boundary we cannot resolve.
  const l = transcriptLabelsFromXml(feed(item(1, txt(1))), 8);
  assert.equal(l.transcript_present, true);
  assert.equal(l.episodes_with_transcript, 1);
  assert.equal(l.episodes_with_timed_transcript, 0);
  assert.equal(l.transcript_tags, 1);
  assert.deepEqual(l.transcript_types, { "text/plain": 1 });
});

test("several tags on one episode count as ONE episode but THREE tags", () => {
  // Episodes publish ~2.9 tags each in the wild, so the two quantities differ by
  // ~2.9x and must not share a name. `episodes_with_transcript` is the coverage
  // number; `transcript_tags` counts tags and sums to `transcript_types`, matching
  // the fields of the same names in data/transcript-availability.json. The first
  // draft used `transcript_tags` for the episode count, producing a label whose own
  // `transcript_types` summed to 8 while it claimed 3. Caught in review.
  const l = transcriptLabelsFromXml(feed(item(1, [vtt(1), srt(1), txt(1)].join("\n"))), 8);
  assert.equal(l.episodes_with_transcript, 1);
  assert.equal(l.episodes_with_timed_transcript, 1);
  assert.equal(l.transcript_tags, 3);
  assert.deepEqual(l.transcript_types, { "text/vtt": 1, "application/x-subrip": 1, "text/plain": 1 });
});

test("transcript_tags always equals the sum of transcript_types", () => {
  // The internal consistency the rename exists to restore. Checked over a spread
  // of shapes rather than one, since the two are incremented in the same loop and
  // a future edit could easily move one out of it.
  for (const items of [
    item(1, vtt(1)),
    [item(1, [vtt(1), srt(1)].join("\n")), item(2, txt(2)), item(3)].join("\n"),
    [item(1, [vtt(1), untyped(1)].join("\n")), item(2, [txt(2), srt(2), vtt(2)].join("\n"))].join("\n"),
    [item(1), item(2)].join("\n")
  ]) {
    const l = transcriptLabelsFromXml(feed(items), 8);
    const summed = Object.values(l.transcript_types).reduce((a, b) => a + b, 0);
    assert.equal(l.transcript_tags, summed, `tags ${l.transcript_tags} != types sum ${summed}`);
    assert.ok(l.episodes_with_transcript <= l.transcript_tags);
    assert.ok(l.episodes_with_timed_transcript <= l.episodes_with_transcript);
  }
});

test("a transcript tag with no @type is recorded as unknown, not dropped", () => {
  // A new timestamped format should surface as a question, not as a silent loss.
  const l = transcriptLabelsFromXml(feed(item(1, untyped(1))), 8);
  assert.equal(l.episodes_with_transcript, 1);
  assert.equal(l.transcript_tags, 1);
  assert.equal(l.episodes_with_timed_transcript, 0);
  assert.deepEqual(l.transcript_types, { unknown: 1 });
});

test("an untyped tag ALONGSIDE a typed one is still counted", () => {
  // The realistic case, and the one the first draft dropped: its untyped branch was
  // an `else if`, so it only fired when NO tag on the episode had a type. A
  // publisher adding a new timestamped format next to their existing VTT is exactly
  // "a new format shows up", and it reported nothing. Caught in review.
  const l = transcriptLabelsFromXml(feed(item(1, [vtt(1), untyped(1)].join("\n"))), 8);
  assert.equal(l.episodes_with_transcript, 1);
  assert.equal(l.transcript_tags, 2, "the untyped tag must not vanish");
  assert.deepEqual(l.transcript_types, { "text/vtt": 1, unknown: 1 });
});

test("a type with a charset parameter still matches", () => {
  const x = feed(`    <item><title>a</title><enclosure url="https://c/e.mp3" type="audio/mpeg" length="1"/>
      <podcast:transcript url="https://c/a.vtt" type="text/vtt; charset=utf-8"/></item>`);
  const l = transcriptLabelsFromXml(x, 8);
  assert.equal(l.episodes_with_timed_transcript, 1);
  assert.deepEqual(l.transcript_types, { "text/vtt": 1 });
});

test("a namespace prefix other than podcast: is still read", () => {
  const x = feed(`    <item><title>a</title><enclosure url="https://c/e.mp3" type="audio/mpeg" length="1"/>
      <pc:transcript url="https://c/a.vtt" type="text/vtt"/></item>`);
  assert.equal(transcriptLabelsFromXml(x, 8).episodes_with_timed_transcript, 1);
});

test("counts are a FLOOR over the sampled window, and the window is recorded", () => {
  // The label is computed over the <= 8 items already fetched, not the whole
  // back catalogue, so `episodes_sampled` has to travel with the counts or the
  // ratio is unreadable. A show showing 0 of 8 may publish transcripts on older
  // episodes — one more reason this can never gate anything.
  const items = Array.from({ length: 20 }, (_, i) => item(1, i < 3 ? vtt(1) : "")).join("\n");
  const l = transcriptLabelsFromXml(feed(items), 8);
  assert.equal(l.episodes_sampled, 8);
  assert.equal(l.episodes_with_transcript, 3);
  assert.equal(l.episodes_with_timed_transcript, 3);
});

test("the sample window is honoured exactly", () => {
  const items = Array.from({ length: 10 }, () => item(1, vtt(1))).join("\n");
  assert.equal(transcriptLabelsFromXml(feed(items), 3).episodes_sampled, 3);
  assert.equal(transcriptLabelsFromXml(feed(items), 3).episodes_with_transcript, 3);
  assert.equal(transcriptLabelsFromXml(feed(items), 0).episodes_sampled, 0);
});

test("an unreadable body yields episodes_sampled 0 — 'not read', not 'no transcripts'", () => {
  for (const bad of ["", "not xml at all", "<html><body>404</body></html>"]) {
    const l = transcriptLabelsFromXml(bad, 8);
    assert.equal(l.episodes_sampled, 0, `for ${JSON.stringify(bad)}`);
    assert.equal(l.transcript_present, false);
  }
});

test("a feed with zero items is read but empty, and does not throw", () => {
  const l = transcriptLabelsFromXml(feed(""), 8);
  assert.equal(l.episodes_sampled, 0);
  assert.equal(l.episodes_with_transcript, 0);
});

test("an Atom feed does not throw — it is simply unlabelled", () => {
  const l = transcriptLabelsFromXml(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>a</title></entry></feed>`, 8);
  assert.equal(l.episodes_sampled, 0);
});

test("the label object always carries exactly the documented field set", () => {
  for (const l of [emptyTranscriptLabels(), transcriptLabelsFromXml(feed(item(1, vtt(1))), 8)]) {
    assert.deepEqual(Object.keys(l).sort(), [...TRANSCRIPT_LABEL_FIELDS].sort());
    assert.equal(l.label_schema_version, LABEL_SCHEMA_VERSION);
  }
});

/* ---------- prepare -> merge round trip ----------
   The batch entry is built by prepare-batch.mjs's own `batchShowFrom`, and the
   merge is the real merge-results.mjs in a child process. That is what makes
   this a round trip rather than two independent assertions: if the writer and
   the reader ever disagree about the field's name, this fails. */

const TAXONOMY = JSON.parse(readFileSync(join(ROOT, "data", "taxonomy.json"), "utf8"));
const A_REAL_NODE = TAXONOMY.nodes[0].id;

function roundTrip({ labels, extraResult = {} }) {
  const dir = mkdtempSync(join(tmpdir(), "foray-classify-rt-"));
  try {
    const batchId = "fresh-2026-08-16-testrt";
    const show = { apple_collection_id: 1434243584, title: "Fixture Show", chart_rank: 7 };
    const batch = {
      batch_id: batchId,
      mode: "fresh",
      tier: 1,
      generated_at: new Date().toISOString(),
      label_schema_version: LABEL_SCHEMA_VERSION,
      shows: [batchShowFrom(show, { topics: [], confidence: "low" }, { labels, description: "d", episodes: [] })]
    };
    const results = {
      batch_id: batchId,
      results: {
        "1434243584": {
          topics: [{ node: A_REAL_NODE, confidence: 0.9 }],
          needs_review: false,
          rationale: "A fixture show used to prove the label survives the merge.",
          display_title: "Fixture Show",
          blurb: "A fixture feed used by the classification pipeline tests.",
          ...extraResult
        }
      }
    };
    const batchPath = join(dir, "batch.json");
    const resultsPath = join(dir, "results.json");
    const classPath = join(dir, "breadth-classification.json");
    const progressPath = join(dir, "progress.json");
    writeFileSync(batchPath, JSON.stringify(batch));
    writeFileSync(resultsPath, JSON.stringify(results));
    writeFileSync(classPath, JSON.stringify({ version: 1, entries: {} }));
    writeFileSync(progressPath, JSON.stringify({ in_flight: { 1434243584: { batch_id: batchId } }, failed_fetch: {} }));

    execFileSync(process.execPath, [join(ROOT, "tools", "classify", "merge-results.mjs"), "--batch", batchPath, "--results", resultsPath], {
      cwd: ROOT,
      env: { ...process.env, BREADTH_CLASSIFICATION_PATH: classPath, PROGRESS_PATH: progressPath },
      stdio: "pipe"
    });

    return {
      batchShow: batch.shows[0],
      classification: JSON.parse(readFileSync(classPath, "utf8")),
      progress: JSON.parse(readFileSync(progressPath, "utf8"))
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("prepare writes the label, merge carries it onto the record, byte for byte", () => {
  const labels = transcriptLabelsFromXml(feed([item(1, vtt(1)), item(2, txt(2)), item(3)].join("\n")), 8);
  const { batchShow, classification } = roundTrip({ labels });
  assert.deepEqual(batchShow.transcript_labels, labels, "the batch input must carry the label");
  const entry = classification.entries["1434243584"];
  assert.ok(entry, "the show must be merged");
  assert.deepEqual(entry.transcript_labels, labels, "the label must survive prepare -> merge unchanged");
  assert.equal(entry.transcript_labels.episodes_with_transcript, 2);
  assert.equal(entry.transcript_labels.episodes_with_timed_transcript, 1);
  assert.equal(entry.transcript_labels.episodes_sampled, 3);
});

test("a show with NO transcripts round-trips just as completely", () => {
  // The whole founder constraint in one test: the expensive show is recorded
  // with the same fidelity as the cheap one, and lands in the same file.
  const labels = transcriptLabelsFromXml(feed([item(1), item(2)].join("\n")), 8);
  const { classification } = roundTrip({ labels });
  const entry = classification.entries["1434243584"];
  assert.ok(entry, "a show with no transcripts must still be merged");
  assert.deepEqual(entry.transcript_labels, labels);
  assert.equal(entry.transcript_labels.transcript_present, false);
  assert.deepEqual(entry.topics, [A_REAL_NODE], "its classification is unaffected");
});

test("a show whose feed could not be read round-trips with an honestly empty label", () => {
  const { classification } = roundTrip({ labels: emptyTranscriptLabels() });
  const entry = classification.entries["1434243584"];
  assert.ok(entry, "a show whose feed failed must still be catalogued");
  assert.equal(entry.transcript_labels.episodes_sampled, 0);
});

test("the merge records the label schema version and says the label is not a filter", () => {
  const { classification } = roundTrip({ labels: emptyTranscriptLabels() });
  assert.equal(classification.label_schema_version, LABEL_SCHEMA_VERSION);
  assert.match(classification.provenance.transcript_labels, /never an eligibility test/i);
  assert.match(classification.provenance.transcript_labels, /labels[.]mjs/);
});

test("the label does not disturb the fields the record already had", () => {
  const labels = transcriptLabelsFromXml(feed(item(1, vtt(1))), 8);
  const { classification } = roundTrip({ labels });
  const entry = classification.entries["1434243584"];
  for (const k of ["topics", "confidence", "source", "topic_confidences", "needs_review", "rationale", "display_title", "blurb", "display_copy_ok", "tier", "batch_id", "classified_at"]) {
    assert.ok(k in entry, `pre-existing field ${k} went missing`);
  }
  assert.equal(entry.source, "classify-agent-tier1");
  assert.equal(entry.display_copy_ok, true);
});

test("a batch produced before the label existed still merges", () => {
  // Backward compatibility in the direction that actually happens: an in-flight
  // batch prepared by the old script, merged by the new one.
  const { classification } = roundTrip({ labels: undefined });
  const entry = classification.entries["1434243584"];
  assert.ok(entry);
  // batchShowFrom substitutes an empty label rather than omitting the field.
  assert.equal(entry.transcript_labels.episodes_sampled, 0);
});

test("the label is never taken from the agent's results file", () => {
  // It is observed, not judged. An agent claiming a rich transcript record must
  // not be able to write one — there is nothing here for a classifier to get
  // wrong, and that is the reason the agent's contract did not change.
  const labels = transcriptLabelsFromXml(feed([item(1), item(2)].join("\n")), 8);
  const { classification } = roundTrip({
    labels,
    extraResult: { transcript_labels: { episodes_sampled: 999, episodes_with_transcript: 999, transcript_present: true } }
  });
  assert.deepEqual(classification.entries["1434243584"].transcript_labels, labels);
});

/* ---------- re-merge keeps the richer observation ---------- */

test("a re-merge whose feed failed does not destroy the earlier reading", () => {
  // A Tier-2 escalation re-merges a show Tier 1 already labelled. If that run's
  // feed fetch 500s, an unconditional overwrite would replace a real reading of 8
  // episodes with "we saw 0" — data loss in the one field whose whole purpose is
  // budgeting. Caught in review.
  const rich = transcriptLabelsFromXml(feed(Array.from({ length: 8 }, () => item(1, vtt(1))).join("\n")), 8);
  assert.equal(rich.episodes_sampled, 8);
  assert.deepEqual(mergeTranscriptLabels(rich, emptyTranscriptLabels()), rich);
});

test("a re-merge that read FEWER episodes does not undo the earlier reading", () => {
  const wide = transcriptLabelsFromXml(feed([item(1, vtt(1)), item(2, vtt(2)), item(3, vtt(3))].join("\n")), 8);
  const narrow = transcriptLabelsFromXml(feed(item(1)), 8);
  assert.equal(wide.episodes_sampled, 3);
  assert.equal(narrow.episodes_sampled, 1);
  assert.deepEqual(mergeTranscriptLabels(wide, narrow), wide, "a thinner reading must not overwrite a wider one");
  assert.deepEqual(mergeTranscriptLabels(narrow, wide), wide, "and a wider one replaces a thinner one");
});

test("on an equal-width re-reading the FRESH observation wins, because feeds change", () => {
  // The tie-break, stated as a decision rather than left to whichever branch the
  // comparison happens to take: a show that has started publishing transcripts
  // since we last looked must be able to say so.
  const before = transcriptLabelsFromXml(feed([item(1), item(2)].join("\n")), 8);
  const after = transcriptLabelsFromXml(feed([item(1, vtt(1)), item(2, vtt(2))].join("\n")), 8);
  assert.equal(before.episodes_sampled, after.episodes_sampled);
  assert.deepEqual(mergeTranscriptLabels(before, after), after);
  assert.equal(mergeTranscriptLabels(before, after).transcript_present, true);
});

test("merging with nothing on either side still yields a valid label", () => {
  assert.deepEqual(Object.keys(mergeTranscriptLabels(null, null)).sort(), [...TRANSCRIPT_LABEL_FIELDS].sort());
  const l = transcriptLabelsFromXml(feed(item(1, vtt(1))), 8);
  assert.deepEqual(mergeTranscriptLabels(null, l), l);
  assert.deepEqual(mergeTranscriptLabels(l, null), l);
  assert.deepEqual(mergeTranscriptLabels(undefined, l), l);
});

test("the merge never drops a show over which label won", () => {
  // The founder's constraint applied to this helper: both branches produce a
  // record, and the show is merged either way.
  for (const labels of [emptyTranscriptLabels(), transcriptLabelsFromXml(feed(item(1, vtt(1))), 8)]) {
    const { classification } = roundTrip({ labels });
    assert.ok(classification.entries["1434243584"], "merged regardless of which label won");
  }
});

test("the merge still advances progress for a show with no transcripts", () => {
  const labels = transcriptLabelsFromXml(feed(item(1)), 8);
  const { progress } = roundTrip({ labels });
  assert.equal(progress.in_flight["1434243584"], undefined, "a merged show must leave in_flight regardless of its label");
});
