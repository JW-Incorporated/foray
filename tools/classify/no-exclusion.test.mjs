/* THE FOUNDER'S CONSTRAINT, MADE MECHANICAL.
   Run: node --test tools/classify/no-exclusion.test.mjs

   Wyatt, 2026-08-16: "make sure we're just labeling/cataloguing here — no show
   should be excluded at this stage, just catalogued. I don't want to accidentally
   toss out shows that are still useful, for example for playlists (not forays)."

   This is the most valuable suite in the change. Everything else here is a
   throughput fix; this is the thing that must not quietly stop being true. It
   asserts, three different ways, that NO CODE PATH removes a show from the
   catalogue or from the selection queue on the basis of any label:

     1. BEHAVIOURAL, selection — a catalogue whose labels are as unhelpful as a
        real feed can make them selects exactly the same shows, in the same
        order, as one whose labels are ideal.
     2. BEHAVIOURAL, merge — a show with the worst possible label lands in
        `entries` with the same classification, the same `needs_review`, and no
        new key that reads as a verdict.
     3. STRUCTURAL — the pipeline's own source is scanned for the shape this
        constraint dies of: `if (!labels.transcript_present) continue;`. That
        line reads as reasonable to anyone who has not read the ruling, which is
        precisely why a test has to be the thing that stops it.

   WHY THE CONSTRAINT IS RIGHT, so a future session does not "optimise" it away:
   a transcript is a COST, not a requirement. We make our own at ~1.1x realtime
   (~46 min of CPU per hour of audio) and ours beat a publisher's SRT on domain
   vocabulary. A show with no transcript is expensive, not unusable. And a show
   that can never carry a Foray at all can still be a good episode in a
   playlist. Excluding it here would throw away both.                        */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FORBIDDEN_GATE_KEYS, TRANSCRIPT_LABEL_FIELDS, emptyTranscriptLabels, transcriptLabelsFromXml } from "./labels.mjs";
import { selectFreshCandidates } from "./select.mjs";
import { validateResult } from "./merge-results.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HERE = join(ROOT, "tools", "classify");

/* ---------- fixtures: the same catalogue, labelled two opposite ways ---------- */

const SHOWS = Array.from({ length: 40 }, (_, i) => ({
  apple_collection_id: 1000000000 + i * 7919,
  title: `Show ${i}`,
  feed_url: `https://example.test/${i}.xml`,
  chart_rank: (i % 200) + 1,
  apple_genre: "Food",
  chart_genre_name: "Food"
}));

/** Every episode ships a timed VTT: the cheapest possible show to build from. */
const RICH_LABEL = emptyTranscriptLabels({
  episodes_sampled: 8,
  transcript_present: true,
  transcript_tags: 8,
  episodes_with_timed_transcript: 8,
  transcript_types: { "text/vtt": 8 }
});

/** Nothing at all: 8 episodes read, no transcript tag anywhere. ~46 min of CPU
    per hour of audio to build from, and still a perfectly good show. */
const BARREN_LABEL = emptyTranscriptLabels({ episodes_sampled: 8 });

/** We could not even read the feed. The worst record a show can have. */
const UNREADABLE_LABEL = emptyTranscriptLabels();

const classificationWith = (label) => ({
  version: 1,
  entries: Object.fromEntries(
    SHOWS.map((s, i) => [
      String(s.apple_collection_id),
      {
        topics: ["food"],
        confidence: "medium",
        source: i % 2 === 0 ? "genre-map" : "llm-title-genre",
        needs_review: false,
        rationale: "prior pass",
        transcript_labels: label
      }
    ])
  )
});

const emptyProgress = () => ({ in_flight: {}, failed_fetch: {} });
const ids = (list) => list.map((s) => String(s.apple_collection_id));

/* ---------- 1. selection ---------- */

test("selection is IDENTICAL whether every show has transcripts or none does", () => {
  const now = Date.now();
  const rich = selectFreshCandidates(SHOWS, classificationWith(RICH_LABEL), emptyProgress(), now, 40, 3, null);
  const barren = selectFreshCandidates(SHOWS, classificationWith(BARREN_LABEL), emptyProgress(), now, 40, 3, null);
  assert.deepEqual(ids(barren), ids(rich), "the transcript label must not change WHICH shows are selected, or in what order");
  assert.equal(barren.length, SHOWS.length, "and nothing may be dropped");
});

test("a show whose feed could not be read at all is still selected", () => {
  const now = Date.now();
  const out = selectFreshCandidates(SHOWS, classificationWith(UNREADABLE_LABEL), emptyProgress(), now, 40, 3, null);
  assert.equal(out.length, SHOWS.length);
});

test("selection is identical when the label is absent entirely", () => {
  const now = Date.now();
  const withLabel = selectFreshCandidates(SHOWS, classificationWith(BARREN_LABEL), emptyProgress(), now, 40, 3, null);
  const noLabelClassification = classificationWith(BARREN_LABEL);
  for (const e of Object.values(noLabelClassification.entries)) delete e.transcript_labels;
  const withoutLabel = selectFreshCandidates(SHOWS, noLabelClassification, emptyProgress(), now, 40, 3, null);
  assert.deepEqual(ids(withoutLabel), ids(withLabel));
});

test("mixed labels do not reorder the queue — no show drifts to the back", () => {
  // The soft version of the ban, and the more likely accident: ordering by
  // `transcript_present` would not drop a show, it would push it behind 17,000
  // others. At any cadence that does not finish, that is exclusion with extra
  // steps.
  const now = Date.now();
  const uniform = selectFreshCandidates(SHOWS, classificationWith(BARREN_LABEL), emptyProgress(), now, 40, 3, null);
  const mixed = classificationWith(BARREN_LABEL);
  Object.values(mixed.entries).forEach((e, i) => {
    e.transcript_labels = i % 3 === 0 ? RICH_LABEL : i % 3 === 1 ? BARREN_LABEL : UNREADABLE_LABEL;
  });
  assert.deepEqual(ids(selectFreshCandidates(SHOWS, mixed, emptyProgress(), now, 40, 3, null)), ids(uniform));
});

test("a small batch takes the same shows regardless of label", () => {
  // A truncated batch is where a bias would actually bite: the top N is all
  // anyone ever sees in one run.
  const now = Date.now();
  const rich = selectFreshCandidates(SHOWS, classificationWith(RICH_LABEL), emptyProgress(), now, 5, 3, null);
  const barren = selectFreshCandidates(SHOWS, classificationWith(BARREN_LABEL), emptyProgress(), now, 5, 3, null);
  assert.deepEqual(ids(barren), ids(rich));
  assert.equal(barren.length, 5);
});

test("every shard's slice is label-independent too", () => {
  const now = Date.now();
  for (let i = 0; i < 6; i++) {
    const rich = selectFreshCandidates(SHOWS, classificationWith(RICH_LABEL), emptyProgress(), now, 40, 3, `${i}/6`);
    const barren = selectFreshCandidates(SHOWS, classificationWith(BARREN_LABEL), emptyProgress(), now, 40, 3, `${i}/6`);
    assert.deepEqual(ids(barren), ids(rich), `shard ${i} differs by label`);
  }
});

test("having been LABELLED does not make a show look done", () => {
  // The subtle version: a rich label plus a distrusted source must still be
  // re-classified. Only `classify-agent-*` means "done", and that is about work
  // performed, not about what the show is.
  const now = Date.now();
  const out = selectFreshCandidates(SHOWS, classificationWith(RICH_LABEL), emptyProgress(), now, 40, 3, null);
  assert.equal(out.length, SHOWS.length, "a labelled show on a distrusted source is still eligible");
});

test("the label cannot mask the one legitimate reason to skip: already classified", () => {
  const now = Date.now();
  const c = classificationWith(RICH_LABEL);
  Object.values(c.entries).slice(0, 10).forEach((e) => { e.source = "classify-agent-tier1"; });
  const out = selectFreshCandidates(SHOWS, c, emptyProgress(), now, 40, 3, null);
  assert.equal(out.length, SHOWS.length - 10, "already-classified shows leave the QUEUE, not the catalogue");
});

/* ---------- 2. merge ---------- */

const TAXONOMY = JSON.parse(readFileSync(join(ROOT, "data", "taxonomy.json"), "utf8"));
const NODE_IDS = new Set(TAXONOMY.nodes.map((n) => n.id));
const A_NODE = TAXONOMY.nodes[0].id;

const goodResult = () => ({
  topics: [{ node: A_NODE, confidence: 0.9 }],
  needs_review: false,
  rationale: "A show about something, described honestly.",
  display_title: "A Show",
  blurb: "A short honest description of what this show actually covers."
});

test("the merged record carries no key that reads as a verdict on usability", () => {
  const { ok, entry } = validateResult("1", "A Show", goodResult(), NODE_IDS);
  assert.equal(ok, true);
  for (const key of Object.keys(entry)) {
    for (const banned of FORBIDDEN_GATE_KEYS) {
      assert.ok(
        !key.toLowerCase().includes(banned),
        `the record grew a field named "${key}", which reads as an eligibility verdict. ` +
          `Labels describe; they never decide. See tools/classify/labels.mjs.`
      );
    }
  }
});

test("validation does not consult the transcript label at all", () => {
  // validateResult never receives it — the label comes off the batch input in
  // main(), after validation has already succeeded. Proven by the fact that
  // passing a hostile one changes nothing.
  const plain = validateResult("1", "A Show", goodResult(), NODE_IDS);
  const withLabel = validateResult("1", "A Show", { ...goodResult(), transcript_labels: UNREADABLE_LABEL }, NODE_IDS);
  assert.deepEqual(withLabel.entry, plain.entry);
});

test("no transcript never forces needs_review", () => {
  // needs_review is about our confidence in the TAGS. Making it depend on the
  // label would put ~17,000 shows in a review pile for a property that has
  // nothing to do with whether the tags are right.
  const { entry } = validateResult("1", "A Show", goodResult(), NODE_IDS);
  assert.equal(entry.needs_review, false);
});

test("the label never suppresses display copy", () => {
  const { entry } = validateResult("1", "A Show", goodResult(), NODE_IDS);
  assert.equal(entry.display_copy_ok, true);
  assert.equal(entry.display_title, "A Show");
  assert.ok(entry.blurb);
});

/* ---------- 3. structural: the shape this constraint dies of ---------- */

/** Source with comments and string literals removed, so a doc comment that
    discusses the ban is not mistaken for the ban. */
function codeOf(file) {
  return readFileSync(join(HERE, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/([^:])\/\/.*$/gm, "$1")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

const PIPELINE_FILES = ["prepare-batch.mjs", "merge-results.mjs", "select.mjs"];
const LABEL_TOKENS = ["transcript_labels", ...TRANSCRIPT_LABEL_FIELDS.filter((f) => f !== "label_schema_version")];

/* Two complementary shapes, kept separate because they fail for different
   reasons and a merged regex was too blunt to be useful — its first draft
   flagged `transcript_labels: signal.labels ?? emptyTranscriptLabels()`, which
   is the label being WRITTEN, not a branch. */

/** Anything that can drop a row from a list, or a run from a loop body. */
const REMOVES_A_ROW = /\b(continue|break|return|filter|splice|shift|pop|reject)\b/;

/** A condition: `if (…)`, `while (…)`, `for (…)`, or a ternary. `??` and `?.`
    are deliberately excluded — neither is a branch on the label's content. */
const IS_A_CONDITION = /\b(if|while|for)\s*\(|(^|[^?.])\?(?![?.])/;

test("no label field appears where it could drop a show", () => {
  // This is the test that stops `if (!labels.transcript_present) continue;`.
  for (const file of PIPELINE_FILES) {
    codeOf(file).split("\n").forEach((line, i) => {
      for (const token of LABEL_TOKENS) {
        if (!line.includes(token)) continue;
        assert.ok(
          !REMOVES_A_ROW.test(line),
          `tools/classify/${file}:${i + 1} uses the label "${token}" next to a row-dropping operation:\n    ${line.trim()}\n` +
            `  A label describes a show; it must never decide whether the show is processed. ` +
            `If this is a legitimate new use, the founder's ruling (labels.mjs) has to change first.`
        );
      }
    });
  }
});

test("no label field appears inside any condition anywhere in the pipeline", () => {
  // Stricter than the check above, and it catches the multi-line form the
  // same-line scan would miss:  if (!labels.transcript_present) {\n continue;\n }
  //
  // Absolute rather than allowlisted, deliberately. There is no benign branch on
  // this label in the pipeline today — merge-results.mjs copies it
  // unconditionally precisely so that this assertion can stay absolute, which is
  // a far easier invariant to keep than "the branch is a harmless one".
  for (const file of PIPELINE_FILES) {
    codeOf(file).split("\n").forEach((line, i) => {
      for (const token of LABEL_TOKENS) {
        if (!line.includes(token)) continue;
        assert.ok(
          !IS_A_CONDITION.test(line),
          `tools/classify/${file}:${i + 1} tests the label "${token}" in a condition:\n    ${line.trim()}\n` +
            `  Copy it unconditionally instead. Nothing in this pipeline may branch on it.`
        );
      }
    });
  }
});

test("the scan can actually see the line it exists to catch", () => {
  // A source-scanning test that never fires is indistinguishable from one that
  // cannot fire. These are the exact shapes the two checks above must reject.
  assert.ok(REMOVES_A_ROW.test("    if (!labels.transcript_present) continue;"));
  assert.ok(IS_A_CONDITION.test("    if (!labels.transcript_present) {"));
  assert.ok(REMOVES_A_ROW.test("  shows = shows.filter((s) => s.transcript_labels.transcript_present);"));
  assert.ok(IS_A_CONDITION.test("  const n = x.transcript_present ? 1 : 0;"));
  // And these must NOT fire — writing the label is not branching on it.
  assert.ok(!REMOVES_A_ROW.test("    transcript_labels: signal.labels ?? emptyTranscriptLabels(),"));
  assert.ok(!IS_A_CONDITION.test("    transcript_labels: signal.labels ?? emptyTranscriptLabels(),"));
  assert.ok(!IS_A_CONDITION.test("    entry.transcript_labels = show.transcript_labels ?? emptyTranscriptLabels();"));
  assert.ok(!IS_A_CONDITION.test("    const n = show?.transcript_labels;"));
});

test("labels.mjs itself branches on nothing but parse validity", () => {
  // Kept separate because labels.mjs legitimately contains the vocabulary of the
  // ban (FORBIDDEN_GATE_KEYS) and the counting loop, so it cannot be scanned the
  // same way. What must hold is narrower: it exports no predicate that answers
  // "should this show be processed".
  const src = readFileSync(join(HERE, "labels.mjs"), "utf8");
  const exported = [...src.matchAll(/^export function (\w+)/gm)].map((m) => m[1]);
  for (const name of exported) {
    for (const banned of FORBIDDEN_GATE_KEYS) {
      assert.ok(!name.toLowerCase().includes(banned), `labels.mjs exports ${name}(), which sounds like a gate`);
    }
  }
});

test("the pipeline declares no field whose name is an eligibility verdict", () => {
  for (const file of [...PIPELINE_FILES, "labels.mjs"]) {
    const code = codeOf(file);
    for (const banned of FORBIDDEN_GATE_KEYS) {
      // An object key being WRITTEN, e.g. `eligible: false`.
      const re = new RegExp(`\\b${banned}\\s*:`, "i");
      assert.ok(
        !re.test(code),
        `tools/classify/${file} declares a "${banned}:" field. No show may carry a verdict on its own usability.`
      );
    }
  }
});

test("no per-show ad flag has been reintroduced", () => {
  // ADR-0008 removed ad load as a rejection reason, and a per-show ad number is
  // invalid by that ADR's own rule anyway (N >= 2 probes of the SAME episode, a
  // maximum in seconds, never a median across different episodes). The ranged-GET
  // probe stays in tools/transcribe/ad-inflation.mjs.
  for (const file of [...PIPELINE_FILES, "labels.mjs"]) {
    const code = codeOf(file);
    for (const re of [/\bdai_suspected\s*:/i, /\bad_free\b/i, /\bad_ratio\b/i, /\bad_inflation\s*:/i]) {
      assert.ok(!re.test(code), `tools/classify/${file} looks like it grew a per-show ad flag (${re})`);
    }
  }
});

test("a real barren feed produces a label that is empty, not a rejection", () => {
  // End to end on the extraction itself: the honest answer to "does this ship
  // transcripts" is "no", and "no" is a number, not a verdict.
  const barren = transcriptLabelsFromXml(
    `<rss><channel><title>t</title><item><title>a</title><enclosure url="https://c/a.mp3" type="audio/mpeg" length="1"/></item></channel></rss>`,
    8
  );
  assert.equal(barren.transcript_present, false);
  assert.equal(barren.episodes_sampled, 1);
  assert.deepEqual(Object.keys(barren).sort(), [...TRANSCRIPT_LABEL_FIELDS].sort());
  for (const key of Object.keys(barren)) {
    for (const banned of FORBIDDEN_GATE_KEYS) {
      assert.ok(!key.toLowerCase().includes(banned), `label field "${key}" reads as a verdict`);
    }
  }
});

test("the runner prompt does not tell the agent to skip or drop a show for a label", () => {
  // The prompt is the other place this can be lost — an instruction is as
  // binding as an `if`, and it would not show up in any code scan.
  const prompt = readFileSync(join(ROOT, "docs", "agents", "runner-prompts", "classify-batch.md"), "utf8");
  const offending = prompt
    .split("\n")
    .filter((l) => /transcript_labels|transcript_present|episodes_with_timed_transcript/i.test(l))
    .filter((l) => /\b(skip|exclude|drop|omit|ignore|reject|only if|do not classify)\b/i.test(l));
  assert.deepEqual(
    offending,
    [],
    `the runner prompt appears to make the transcript label actionable:\n  ${offending.join("\n  ")}`
  );
});
