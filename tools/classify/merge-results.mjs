/* Classification batch merge — STATIC machinery (committed, never
   regenerated), keyless, no LLM. Companion to tools/refresh/merge.mjs,
   adapted for the breadth-catalog reclassification pipeline
   (docs/adr/0006-podcast-classification-methodology.md).

   Reads one batch INPUT file (from prepare-batch.mjs) + the matching
   agent-authored RESULTS file (written by a Claude Code classification
   agent following docs/agents/runner-prompts/classify-batch.md), enforces
   the copy rules + schema on that output, and merges it into
   data/breadth-classification.json — REPLACING whatever entry (old,
   distrusted "genre-map"/"llm-title-genre", or absent) currently exists
   for each classified show. Also advances the shared progress state
   (data-local/classify-progress.json by default): classified shows leave
   `in_flight` and `failed_fetch`.

   This never touches data/catalog.json or data/discover.json (the curated
   tier) — per the founders' explicit precedence rule, curated hand-authored
   tags always win over breadth reclassification; this script only ever
   writes the breadth-tier file.

   Contract for the agent's results file:
     { "batch_id": "<must match the batch input's batch_id>",
       "results": {
         "<apple_collection_id>": {
           "topics": [{"node": "<taxonomy id>", "confidence": 0..1}, ...],
           "needs_review": boolean,
           "rationale": "<short, ~15 words>",
           "display_title": "<tile header, copy-gated>",
           "blurb": "<1-2 sentence tile description, copy-gated>",
           "model": "<optional free-text note on what did the classifying>"
         }, ...
       }
     }
   A show present in the batch but missing from results (or failing
   validation) is SKIPPED and reported — never merged with guessed/partial
   data (principle #2: state observed, never declared). Re-running this
   script with the same batch+results files is idempotent: shows already
   merged under the same batch_id are skipped on the second pass.

   THE TRANSCRIPT LABEL. The agent's contract above is UNCHANGED by it:
   `transcript_labels` is never read from the agent's file, it is copied off the
   batch input, where prepare-batch.mjs wrote it deterministically from the feed
   it fetched. There is nothing for a classifier to get wrong about it and
   nothing new for it to judge.

   IT IS NOT A FILTER (founder ruling 2026-08-16). The label never removes a show
   from the catalogue, never touches `needs_review`, and never affects what a
   downstream consumer can see. A show that ships no transcript merges exactly
   like one that ships a timed VTT for every episode; the label records that the
   first costs ~46 min of CPU per hour of audio through our own ASR and the
   second is nearly free. See tools/classify/labels.mjs.

   Usage:
     node tools/classify/merge-results.mjs --batch data-local/classify-batch-<id>.json \
       --results data-local/classify-results-<id>.json

   Env overrides:
     BREADTH_CLASSIFICATION_PATH  (default data/breadth-classification.json)
     TAXONOMY_PATH                (default data/taxonomy.json)
     PROGRESS_PATH                (default data-local/classify-progress.json)   */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import copyRules from "../../backend/src/copy/rules.js";
import { LABEL_SCHEMA_VERSION, emptyTranscriptLabels } from "./labels.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { BANNED, wordCount, MAX_DISPLAY_TITLE_WORDS, MAX_BLURB_WORDS } = copyRules;

function parseArgs(argv) {
  const get = (flag) => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  return { batchPath: get("--batch"), resultsPath: get("--results") };
}

function envPath(name, def) {
  const v = process.env[name];
  return v ? resolvePath(process.cwd(), v) : join(ROOT, ...def);
}

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function confidenceBucket(maxConfidence) {
  if (maxConfidence >= 0.75) return "high";
  if (maxConfidence >= 0.5) return "medium";
  return "low";
}

/** Validates one show's agent-authored result. Returns { ok, entry, errors }.
    Exported so tools/classify/no-exclusion.test.mjs can drive it directly. */
export function validateResult(id, showTitle, raw, taxonomyNodeIds) {
  const errors = [];

  if (!raw || typeof raw !== "object") return { ok: false, errors: [`${id} (${showTitle}): missing result`] };

  if (!Array.isArray(raw.topics) || raw.topics.length === 0) {
    errors.push(`${id}: topics must be a non-empty array`);
  } else {
    for (const t of raw.topics) {
      if (!t || typeof t.node !== "string" || !taxonomyNodeIds.has(t.node)) {
        errors.push(`${id}: unknown taxonomy node "${t?.node}"`);
      }
      if (typeof t?.confidence !== "number" || t.confidence < 0 || t.confidence > 1) {
        errors.push(`${id}: bad confidence for node "${t?.node}": ${t?.confidence}`);
      }
    }
  }
  if (typeof raw.needs_review !== "boolean") errors.push(`${id}: needs_review must be boolean`);
  if (typeof raw.rationale !== "string" || raw.rationale.trim().length === 0) errors.push(`${id}: missing rationale`);

  if (errors.length) return { ok: false, errors };

  // --- Copy-rule preflight on the Foray-authored display fields (ADR-0006).
  // A copy violation does NOT reject the show's classification — the
  // topics/confidence data is still good — but the display fields are
  // withheld and the show is force-flagged needs_review, exactly as a
  // low-confidence classification would be (never silently emit banned
  // copy, per CLAUDE.md's copy rules + principle #2).
  let displayCopyOk = true;
  const copyNotes = [];
  const checkCopy = (label, text, maxWords) => {
    if (typeof text !== "string" || text.trim().length === 0) {
      displayCopyOk = false;
      copyNotes.push(`${label}: missing`);
      return;
    }
    if (wordCount(text) > maxWords) {
      displayCopyOk = false;
      copyNotes.push(`${label}: ${wordCount(text)}w > ${maxWords}`);
    }
    for (const rx of BANNED) {
      if (rx.test(text)) {
        displayCopyOk = false;
        copyNotes.push(`${label}: banned ${rx}`);
      }
    }
  };
  checkCopy("display_title", raw.display_title, MAX_DISPLAY_TITLE_WORDS);
  checkCopy("blurb", raw.blurb, MAX_BLURB_WORDS);

  const maxConfidence = Math.max(...raw.topics.map((t) => t.confidence));
  const entry = {
    topics: [...raw.topics].sort((a, b) => b.confidence - a.confidence).map((t) => t.node),
    confidence: confidenceBucket(maxConfidence),
    source: null, // filled in by caller (knows the batch tier)
    topic_confidences: [...raw.topics].sort((a, b) => b.confidence - a.confidence),
    needs_review: raw.needs_review || !displayCopyOk,
    rationale: String(raw.rationale).slice(0, 300),
    display_title: displayCopyOk ? raw.display_title : null,
    blurb: displayCopyOk ? raw.blurb : null,
    display_copy_ok: displayCopyOk,
    display_copy_notes: copyNotes.length ? copyNotes : undefined,
    model: typeof raw.model === "string" ? raw.model : undefined
  };
  return { ok: true, entry };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.batchPath || !args.resultsPath) {
    console.error("Usage: node tools/classify/merge-results.mjs --batch <path> --results <path>");
    process.exit(1);
  }

  const batch = readJson(resolvePath(process.cwd(), args.batchPath));
  const results = readJson(resolvePath(process.cwd(), args.resultsPath));

  if (results.batch_id !== batch.batch_id) {
    console.error(`FATAL: results.batch_id ("${results.batch_id}") does not match batch.batch_id ("${batch.batch_id}") — refusing to merge mismatched files.`);
    process.exit(1);
  }

  const CLASSIFICATION_PATH = envPath("BREADTH_CLASSIFICATION_PATH", ["data", "breadth-classification.json"]);
  const TAXONOMY_PATH = envPath("TAXONOMY_PATH", ["data", "taxonomy.json"]);
  const PROGRESS_PATH = envPath("PROGRESS_PATH", ["data-local", "classify-progress.json"]);

  const taxonomy = readJson(TAXONOMY_PATH);
  const taxonomyNodeIds = new Set(taxonomy.nodes.map((n) => n.id));

  const classification = existsSync(CLASSIFICATION_PATH)
    ? readJson(CLASSIFICATION_PATH)
    : { version: 1, entries: {} };
  const progress = existsSync(PROGRESS_PATH) ? readJson(PROGRESS_PATH) : { in_flight: {}, failed_fetch: {} };

  const source = batch.tier === 2 ? "classify-agent-tier2" : "classify-agent-tier1";
  const now = new Date().toISOString();

  let merged = 0, skippedMissing = 0, skippedInvalid = 0, skippedAlready = 0;
  const errors = [];

  for (const show of batch.shows) {
    const id = String(show.apple_collection_id);
    const existing = classification.entries[id];
    if (existing && existing.source === source && existing.batch_id === batch.batch_id) {
      skippedAlready++;
      continue; // already merged by a prior run of this exact script call — idempotent
    }

    const raw = results.results?.[id];
    if (!raw) {
      skippedMissing++;
      errors.push(`${id} (${show.title}): no result authored — skipped`);
      continue;
    }

    const { ok, entry, errors: valErrors } = validateResult(id, show.title, raw, taxonomyNodeIds);
    if (!ok) {
      skippedInvalid++;
      errors.push(...valErrors);
      continue;
    }

    /* The transcript label rides along from the BATCH file, not from the agent's
       results — prepare-batch.mjs read it off the feed it fetched, so it is
       observed rather than judged.

       Unconditional on purpose. A batch prepared before the label existed gets an
       honestly-empty one rather than a missing field, so every record has the
       same shape — and, more to the point, there is then no branch anywhere in
       this pipeline whose condition mentions the label at all. That is asserted
       by tools/classify/no-exclusion.test.mjs, and it is a much easier invariant
       to keep true than "the branch is a benign one". */
    entry.transcript_labels = show.transcript_labels ?? emptyTranscriptLabels();

    entry.source = source;
    entry.tier = batch.tier;
    entry.batch_id = batch.batch_id;
    entry.classified_at = now;
    classification.entries[id] = entry;

    delete progress.in_flight[id];
    delete progress.failed_fetch[id];
    merged++;
  }

  classification.version = classification.version || 1;
  classification.built_at = now;
  classification.label_schema_version = LABEL_SCHEMA_VERSION;
  classification.provenance = {
    produced_by: "tools/classify/merge-results.mjs",
    method: "Claude Code classification agent (Max-plan cron routine) — see docs/adr/0006-podcast-classification-methodology.md",
    last_batch_id: batch.batch_id,
    last_batch_tier: batch.tier,
    transcript_labels_are_not_filters:
      "transcript_labels is descriptive only, and it is a COST signal rather than a requirement: a show that ships no <podcast:transcript> costs ~46 min of CPU per hour of audio through our own ASR, and is still catalogued, still recommendable and still Foray material. No consumer may read it as an eligibility test."
  };

  writeFileSync(CLASSIFICATION_PATH, JSON.stringify(classification, null, 2) + "\n");
  writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2) + "\n");

  if (errors.length) console.warn("SKIPPED:\n  " + errors.join("\n  "));
  console.log(
    `MERGED ${merged} show(s) (source=${source}). skipped: ${skippedMissing} no-result, ${skippedInvalid} invalid, ${skippedAlready} already-merged.`
  );
  console.log(`CLASSIFY_MERGE_COMPLETE: batch_id=${batch.batch_id} merged=${merged}`);
}

/* Only run as a script, so validateResult can be imported by the suites. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
