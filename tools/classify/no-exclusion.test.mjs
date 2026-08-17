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
   a transcript is a COST, not a requirement — we make our own (rate and source in
   labels.mjs). A show with no transcript is expensive, not unusable. And a show
   that can never carry a Foray at all can still be a good episode in a playlist.
   Excluding it here would throw away both.                                   */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FORBIDDEN_GATE_KEYS, TRANSCRIPT_LABEL_FIELDS, emptyTranscriptLabels, transcriptLabelsFromXml } from "./labels.mjs";
import { selectFreshCandidates, selectEscalateCandidates } from "./select.mjs";
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

/** Nothing at all: 8 episodes read, no transcript tag anywhere. More expensive
    to build from, and still a perfectly good show. */
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

/* ---------- 1b. the ESCALATE queue, which had no coverage at all ---------- */

/* A review demonstrated that a label-based `continue` could be added to
   selectEscalateCandidates without a single suite going red — it was the one
   selection path with no behavioural test. It lives in select.mjs now, for exactly
   this reason, and gets the same treatment as the fresh selector. */

const escalateClassification = (label) => ({
  version: 1,
  entries: Object.fromEntries(
    SHOWS.map((s) => [
      String(s.apple_collection_id),
      {
        topics: ["food"],
        confidence: "low",
        source: "classify-agent-tier1",
        needs_review: true,
        rationale: "flagged at tier 1",
        transcript_labels: label
      }
    ])
  )
});

test("the escalate queue is IDENTICAL whether shows have transcripts or none do", () => {
  const rich = selectEscalateCandidates(SHOWS, escalateClassification(RICH_LABEL), emptyProgress(), 40);
  const barren = selectEscalateCandidates(SHOWS, escalateClassification(BARREN_LABEL), emptyProgress(), 40);
  const unread = selectEscalateCandidates(SHOWS, escalateClassification(UNREADABLE_LABEL), emptyProgress(), 40);
  assert.equal(rich.length, SHOWS.length, "every flagged show must be escalatable");
  assert.deepEqual(ids(barren.map((c) => c.show)), ids(rich.map((c) => c.show)));
  assert.deepEqual(ids(unread.map((c) => c.show)), ids(rich.map((c) => c.show)));
});

test("a show whose feed could not be read is still escalatable", () => {
  const out = selectEscalateCandidates(SHOWS, escalateClassification(UNREADABLE_LABEL), emptyProgress(), 40);
  assert.equal(out.length, SHOWS.length);
});

test("a truncated escalate batch takes the same shows regardless of label", () => {
  const rich = selectEscalateCandidates(SHOWS, escalateClassification(RICH_LABEL), emptyProgress(), 5);
  const barren = selectEscalateCandidates(SHOWS, escalateClassification(BARREN_LABEL), emptyProgress(), 5);
  assert.equal(barren.length, 5);
  assert.deepEqual(ids(barren.map((c) => c.show)), ids(rich.map((c) => c.show)));
});

test("mixed labels do not reorder the escalate queue either", () => {
  const uniform = selectEscalateCandidates(SHOWS, escalateClassification(BARREN_LABEL), emptyProgress(), 40);
  const mixed = escalateClassification(BARREN_LABEL);
  Object.values(mixed.entries).forEach((e, i) => {
    e.transcript_labels = i % 3 === 0 ? RICH_LABEL : i % 3 === 1 ? BARREN_LABEL : UNREADABLE_LABEL;
  });
  assert.deepEqual(
    ids(selectEscalateCandidates(SHOWS, mixed, emptyProgress(), 40).map((c) => c.show)),
    ids(uniform.map((c) => c.show))
  );
});

/* ---------- 2. merge, asserted on the record main() ACTUALLY writes ---------- */

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

/* Runs the REAL merge-results.mjs and returns the record it wrote.

   This exists because asserting on validateResult's return value is not enough,
   and a review proved it: every field the merge adds after validation — source,
   tier, batch_id, transcript_labels, and anything a future change appends — is
   written in main(), which validateResult never sees. A patch adding
   `entry.eligible = show.transcript_labels.transcript_present` in main() passed
   this suite 20/20. It does not now. */
function mergedRecord(labels) {
  const dir = mkdtempSync(join(tmpdir(), "foray-no-exclusion-"));
  try {
    const batchId = "fresh-2026-08-16-noexcl";
    const id = "1434243584";
    const batch = {
      batch_id: batchId,
      mode: "fresh",
      tier: 1,
      shows: [{ apple_collection_id: Number(id), title: "A Show", transcript_labels: labels }]
    };
    const results = { batch_id: batchId, results: { [id]: goodResult() } };
    const p = (n) => join(dir, n);
    writeFileSync(p("batch.json"), JSON.stringify(batch));
    writeFileSync(p("results.json"), JSON.stringify(results));
    writeFileSync(p("class.json"), JSON.stringify({ version: 1, entries: {} }));
    writeFileSync(p("progress.json"), JSON.stringify({ in_flight: {}, failed_fetch: {} }));
    execFileSync(process.execPath, [join(HERE, "merge-results.mjs"), "--batch", p("batch.json"), "--results", p("results.json")], {
      cwd: ROOT,
      env: { ...process.env, BREADTH_CLASSIFICATION_PATH: p("class.json"), PROGRESS_PATH: p("progress.json") },
      stdio: "pipe"
    });
    const out = JSON.parse(readFileSync(p("class.json"), "utf8"));
    return out.entries[id];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every key on the record, including nested ones, so a verdict cannot hide a
    level down (`entry.flags.eligible`). */
function deepKeys(value, prefix = "") {
  if (value === null || typeof value !== "object") return [];
  const out = [];
  for (const [k, v] of Object.entries(value)) {
    out.push(prefix ? `${prefix}.${k}` : k);
    out.push(...deepKeys(v, prefix ? `${prefix}.${k}` : k));
  }
  return out;
}

for (const [name, label] of [
  ["a rich label", RICH_LABEL],
  ["a barren label", BARREN_LABEL],
  ["an unreadable label", UNREADABLE_LABEL]
]) {
  test(`the record the merge WRITES carries no verdict key, given ${name}`, () => {
    const entry = mergedRecord(label);
    assert.ok(entry, "the show must be merged whatever its label");
    for (const key of deepKeys(entry)) {
      const leaf = key.split(".").pop().toLowerCase();
      for (const banned of FORBIDDEN_GATE_KEYS) {
        assert.ok(
          !leaf.includes(banned),
          `the merged record grew a field "${key}", which reads as an eligibility verdict. ` +
            `Labels describe; they never decide. See tools/classify/labels.mjs.`
        );
      }
    }
  });
}

test("the merged record is byte-identical apart from the label itself", () => {
  // The sharpest form of "the label changes nothing": strip it, and the two
  // records are the same object. Any new field derived from the label — a
  // boolean, a score, a tier — shows up here as a diff.
  const strip = (e) => {
    const { transcript_labels, classified_at, ...rest } = e;
    return rest;
  };
  const rich = mergedRecord(RICH_LABEL);
  const barren = mergedRecord(BARREN_LABEL);
  const unread = mergedRecord(UNREADABLE_LABEL);
  assert.deepEqual(strip(barren), strip(rich));
  assert.deepEqual(strip(unread), strip(rich));
});

test("no transcript never forces needs_review, on the real record", () => {
  // needs_review is about our confidence in the TAGS. Making it depend on the
  // label would put ~17,000 shows in a review pile for a property that has
  // nothing to do with whether the tags are right. Asserted against the merged
  // record rather than validateResult's happy path, which could not have failed.
  assert.equal(mergedRecord(BARREN_LABEL).needs_review, false);
  assert.equal(mergedRecord(UNREADABLE_LABEL).needs_review, false);
});

test("the label never suppresses display copy, on the real record", () => {
  for (const label of [BARREN_LABEL, UNREADABLE_LABEL]) {
    const entry = mergedRecord(label);
    assert.equal(entry.display_copy_ok, true);
    assert.equal(entry.display_title, "A Show");
    assert.ok(entry.blurb);
  }
});

test("validation never receives the transcript label at all", () => {
  // The label comes off the batch input in main(), after validation has already
  // succeeded, so a hostile one in the agent's results changes nothing.
  const plain = validateResult("1", "A Show", goodResult(), NODE_IDS);
  const withLabel = validateResult("1", "A Show", { ...goodResult(), transcript_labels: UNREADABLE_LABEL }, NODE_IDS);
  assert.deepEqual(withLabel.entry, plain.entry);
});

/* ---------- 3. structural: the shape this constraint dies of ---------- */

/** Source with comments removed, so a doc comment that discusses the ban is not
    mistaken for the ban. String literals are blanked only where asked, because
    `entry["eligible"] = false` hides inside one. */
function codeOf(file, { blankStrings = true } = {}) {
  let src = readFileSync(join(HERE, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/([^:])\/\/.*$/gm, "$1");
  if (blankStrings) {
    src = src
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/`(?:[^`\\]|\\.)*`/g, "``");
  }
  return src;
}

const PIPELINE_FILES = ["prepare-batch.mjs", "merge-results.mjs", "select.mjs"];
const LABEL_TOKENS = ["transcript_labels", ...TRANSCRIPT_LABEL_FIELDS.filter((f) => f !== "label_schema_version")];

/* Two complementary shapes, kept separate because they fail for different reasons
   and a merged regex was too blunt to be useful — its first draft flagged
   `transcript_labels: signal.labels ?? emptyTranscriptLabels()`, which is the
   label being WRITTEN, not a branch. */

/** Anything that can drop a row from a list, or a run from a loop body. */
const REMOVES_A_ROW = /\b(continue|break|return|filter|splice|shift|pop|reject)\b/;

/** A condition: `if (…)`, `while (…)`, `for (…)`, or a ternary. `??` and `?.` are
    deliberately excluded — neither is a branch on the label's content. */
const IS_A_CONDITION = /\b(if|while|for)\s*\(|(^|[^?.])\?(?![?.])/;

/* TAINT TRACKING, because the single-line scan alone was walked past in review by
   the most ordinary refactor there is:

     const cheap = show.transcript_labels?.transcript_present ?? false;   // reads
     if (!cheap) continue;                                               // branches

   Neither line trips a token scan — the first has no branch, the second has no
   label token. So any local assigned from an expression containing a label token
   becomes a label token itself, and the scans run again over the widened set. */
function taintedTokens(code) {
  const tainted = new Set(LABEL_TOKENS);
  let grew = true;
  while (grew) {
    grew = false;
    for (const line of code.split("\n")) {
      const named = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]+)$/.exec(line);
      if (named && !tainted.has(named[1]) && [...tainted].some((t) => named[2].includes(t))) {
        tainted.add(named[1]);
        grew = true;
      }
      const destructured = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(.+)$/.exec(line);
      if (destructured && [...tainted].some((t) => destructured[2].includes(t))) {
        for (const part of destructured[1].split(",")) {
          const bound = part.split(":").pop().trim().replace(/^\.\.\./, "");
          if (bound && !tainted.has(bound)) {
            tainted.add(bound);
            grew = true;
          }
        }
      }
    }
  }
  return tainted;
}

test("no label field — or anything derived from one — can drop a show", () => {
  // This is the test that stops `if (!labels.transcript_present) continue;`.
  for (const file of PIPELINE_FILES) {
    const code = codeOf(file);
    const tokens = taintedTokens(code);
    code.split("\n").forEach((line, i) => {
      for (const token of tokens) {
        if (!new RegExp(`\\b${token}\\b`).test(line)) continue;
        assert.ok(
          !REMOVES_A_ROW.test(line),
          `tools/classify/${file}:${i + 1} uses the label (or a value derived from it, "${token}") next to a ` +
            `row-dropping operation:\n    ${line.trim()}\n  A label describes a show; it must never decide ` +
            `whether the show is processed. If this is a legitimate new use, the founder's ruling ` +
            `(labels.mjs) has to change first.`
        );
      }
    });
  }
});

test("no label field — or anything derived from one — appears in a condition", () => {
  // Stricter than the check above, and it catches the multi-line form:
  //   if (!labels.transcript_present) {\n continue;\n }
  //
  // Absolute rather than allowlisted, deliberately. There is no benign branch on
  // this label in the pipeline: merge-results.mjs delegates the one real decision
  // (which of two observations to keep) to mergeTranscriptLabels in labels.mjs,
  // which is not a PIPELINE_FILE and has its own tests. Keeping this absolute is a
  // far easier invariant than "the branch is a harmless one".
  for (const file of PIPELINE_FILES) {
    const code = codeOf(file);
    const tokens = taintedTokens(code);
    code.split("\n").forEach((line, i) => {
      for (const token of tokens) {
        if (!new RegExp(`\\b${token}\\b`).test(line)) continue;
        assert.ok(
          !IS_A_CONDITION.test(line),
          `tools/classify/${file}:${i + 1} tests the label (or "${token}", derived from it) in a condition:\n` +
            `    ${line.trim()}\n  Copy it unconditionally instead. Nothing in this pipeline may branch on it.`
        );
      }
    });
  }
});

test("the scans can actually see every shape they exist to catch", () => {
  // A source-scanning test that cannot fire is indistinguishable from one that
  // never fires. These are the exact shapes the checks above must reject —
  // including the two a review used to walk past the first version of them.
  const fires = (src) => {
    const tokens = taintedTokens(src);
    return src.split("\n").some((line) =>
      [...tokens].some((t) => new RegExp(`\\b${t}\\b`).test(line) && (REMOVES_A_ROW.test(line) || IS_A_CONDITION.test(line)))
    );
  };
  // Direct, single-line.
  assert.ok(fires("if (!labels.transcript_present) continue;"));
  assert.ok(fires("shows = shows.filter((s) => s.transcript_labels.transcript_present);"));
  assert.ok(fires("const n = x.transcript_present ? 1 : 0;"));
  // Multi-line `if` body.
  assert.ok(fires("if (!x.transcript_present) {\n  continue;\n}"));
  // Local-variable extraction — walked past the first version of this suite.
  assert.ok(fires("const cheap = show.transcript_labels?.transcript_present ?? false;\nif (!cheap) continue;"));
  // Destructuring, same trick.
  assert.ok(fires("const { episodes_sampled } = show.transcript_labels;\nif (episodes_sampled === 0) continue;"));
  // Two hops.
  assert.ok(fires("const a = show.transcript_labels;\nconst b = a.transcript_present;\nif (!b) continue;"));

  // And these must NOT fire — writing or copying the label is not branching on it.
  assert.ok(!fires("    transcript_labels: signal.labels ?? emptyTranscriptLabels(),"));
  assert.ok(!fires("    entry.transcript_labels = mergeTranscriptLabels(a, show.transcript_labels);"));
  assert.ok(!fires("    const n = show?.transcript_labels;"));
});

test("the pipeline declares no field whose name is an eligibility verdict", () => {
  // `[:=]`, and with string literals INTACT, because `entry.eligible = false` uses
  // `=` and `entry["eligible"] = false` hides in a string. The first version
  // checked only `eligible:` on string-blanked source, and a review shipped both
  // other forms past it.
  for (const file of [...PIPELINE_FILES, "labels.mjs"]) {
    const code = codeOf(file, { blankStrings: false });
    for (const banned of FORBIDDEN_GATE_KEYS) {
      const re = new RegExp(`\\b${banned}\\b\\s*(?:"|')?\\s*\\]?\\s*[:=](?!=)`, "i");
      assert.ok(
        !re.test(code),
        `tools/classify/${file} assigns or declares a "${banned}" field. No show may carry a verdict on its ` +
          `own usability — that is the founder's ruling, and this is how it would be broken.`
      );
    }
  }
});

test("the verdict-name scan can see all three assignment forms", () => {
  const hits = (src) =>
    FORBIDDEN_GATE_KEYS.some((b) => new RegExp(`\\b${b}\\b\\s*(?:"|')?\\s*\\]?\\s*[:=](?!=)`, "i").test(src));
  assert.ok(hits("entry.eligible = present;"));
  assert.ok(hits('entry["eligible"] = false;'));
  assert.ok(hits("const e = { eligible: false };"));
  assert.ok(hits("entry.foray_ready = cheap;"));
  // Not a declaration: a comparison, or the word inside a longer identifier.
  assert.ok(!hits("if (entry.somethingElse === 1) {}"));
});

test("no per-show ad flag has been reintroduced", () => {
  // ADR-0008 removed ad load as a rejection reason, and a per-show ad number is
  // invalid by that ADR's own rule anyway (N >= 2 probes of the SAME episode, a
  // maximum in seconds, never a median across different episodes). The ranged-GET
  // probe stays in tools/transcribe/ad-inflation.mjs.
  for (const file of [...PIPELINE_FILES, "labels.mjs"]) {
    const code = codeOf(file);
    for (const re of [/\bdai_suspected\s*[:=]/i, /\bad_free\b/i, /\bad_ratio\b/i, /\bad_inflation\s*[:=]/i]) {
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
  // The prompt is the other place this can be lost — an instruction is as binding
  // as an `if`, and it would not show up in any code scan. Scanned over joined
  // paragraphs, not lines, since prose wraps and a line-based scan is evaded by a
  // line break.
  const prompt = readFileSync(join(ROOT, "docs", "agents", "runner-prompts", "classify-batch.md"), "utf8");
  const paragraphs = prompt.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " "));
  const offending = paragraphs
    .filter((p) => /transcript_labels|transcript_present|episodes_with_(timed_)?transcript/i.test(p))
    .filter((p) => /\b(skip|exclude|drop|omit|ignore|reject|only if|do not classify)\b/i.test(p));
  assert.deepEqual(
    offending,
    [],
    `the runner prompt appears to make the transcript label actionable:\n  ${offending.join("\n  ")}`
  );
});
