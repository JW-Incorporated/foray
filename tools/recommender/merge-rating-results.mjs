/* Merge one rater's results file into the persona ratings (RV-09).

   docs/roadmap/recommender-v1.md D7, D8, D10: this script is the ONLY writer
   of data/recommender/ratings.json (and of ratings-isolated.json beside it).
   Machinery is code, judgement is data: a rater (a Claude Code agent following
   docs/agents/runner-prompts/persona-rate-batch.md, or the dormant Qwen/Jev
   paths) reads a batch file from prepare-rating-batch.mjs and writes a results
   file; this script validates that file against tools/recommender/schema.mjs
   AND the batch it answers, normalises it, merges it, writes the full reasons
   to data-local, and releases the batch's reservations in
   data/recommender/rating-progress.json through progress.mjs. It calls no
   model and no network.

     node tools/recommender/merge-rating-results.mjs \
       --results data-local/recommender/results/rating-results-<batch_id>.json \
       [--batch data-local/recommender/batches/rating-batch-<batch_id>.json] \
       [--into ratings-<rater>.json]
     node tools/recommender/merge-rating-results.mjs --check

   ALL OR NOTHING. A results file with any problem (schema.mjs's, or a
   mismatch with its batch: batch_id, rubric_version, mode, pass,
   profiles_sha256, a pass this show was already rated at) is refused whole:
   exit 1, the problems listed, nothing written anywhere.

   THE BATCH IS AUTHORITATIVE for what the rater was shown: the evidence tier
   merged is the pack's `tier`, not the one the rater copied, and the pack's
   injection pre-scan is OR'd into `injection_suspected`. The two schema.mjs
   normalisers then run against that tier: audio sub-scores are nulled and
   confidence capped where the pack's tier demands it, and both are COUNTED in
   the report (a rater that needed them is a rubric problem RV-13 reads).

   MERGE, newest-wins with pass means. Per show: `evidence_tier`, `summary`,
   `format` are the newest pass's; `flags` are OR'd across passes; `passes` is
   the number of joint passes merged; each persona's 10-slot array
   (schema.mjs RATING_SLOTS) is the running mean over passes, the 1-5 slots to
   one decimal and the two 0-1 slots (return_prob, confidence) to two (one
   decimal would fold 0.65 and 0.74 into the same 0.7). `top_persona` is the
   argmax of the mean fit (ties: higher return_prob, then persona id) among
   the personas whose reason is in hand, and `top_reason` is that persona's
   reason from the latest pass. No other reason ever enters data/: every
   persona's full reason goes to data-local/recommender/reasons/<batch>.jsonl.

   ISOLATED MODE (`isolated:<persona_id>`, RV-11's joint-vs-isolated check)
   merges into data/recommender/ratings-isolated.json, never ratings.json. Each
   persona's array there is newest-wins (one isolated rating per persona), and
   an isolated batch releases its reservations and marks its pass rated only
   under its own progress keys (`<show_key>@isolated:<persona_id>`, RV-08's
   progressKey): it is a side measurement, not one of the show's three joint
   passes, and the record stops the same isolated shows being offered again.

   IDEMPOTENT per batch_id: a merged batch id is recorded in `merged_batches`;
   merging it again changes no rating, re-applying only the (idempotent)
   release and markRated, so a run that died between writing the ratings and
   writing the progress file recovers by being run again.

   LOCKED. From reading the progress and ratings files through writing both,
   a merge holds progress.mjs's withProgressLock on its progress file, so
   concurrent merges and prepares queue instead of overwriting each other's
   records (RV-13 lost four batches' pass records that way). A lock that stays
   held past five minutes refuses the merge with `progress_locked`.

   --check validates the committed ratings.json (and ratings-isolated.json if
   present) and exits 1 on any problem or on an in-flight reservation older
   than 12 hours (reported, not fixed: prepare's reclaimStale frees it).

   SIDE RATERS, --into (RV-18). `--into ratings-<rater>.json` merges a joint
   results file into data/recommender/ratings-<rater>.json instead of
   ratings.json, and settles its reservations in that rater's own progress
   file, data/recommender/rating-progress-<rater>.json (the one its batches
   were prepared against with prepare-rating-batch.mjs --progress), so a side
   rater re-rating gold shows neither blocks nor satisfies a Claude pass.
   `--into` defaults to ratings.json; it takes a bare file name, never
   ratings-isolated/-predicted/-client.json (other writers' files), and never
   an isolated results file. A METADATA-ONLY model (`model` starting `jev-`,
   jev-rate.mjs) writes no text and never sees a transcript: its persona
   reasons may be "" (an empty reason is refused for every other model), the
   tier merged is the weaker of the pack's and the one it declares, and its
   results are refused into ratings.json (Jev replaces nothing until it
   clears the RV-14 gate). An empty `top_reason` is accepted only in a side
   file. */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import { progressKey } from "./prepare-rating-batch.mjs";
import { LOCK_WAIT_MS, loadProgress, markRated, release, saveProgress, serializeProgress, STALE_MS, withProgressLock } from "./progress.mjs";
import {
  AUDIO_SUBSCORES,
  EVIDENCE_TIERS,
  RATING_SLOTS,
  RUBRIC_VERSION,
  capConfidence,
  nullAudioScoresUnlessTranscript,
  validateRatingsFile,
  validateResultsFile,
} from "./schema.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const RATINGS_PATH = "data/recommender/ratings.json";
export const ISOLATED_PATH = "data/recommender/ratings-isolated.json";
export const PROGRESS_PATH = "data/recommender/rating-progress.json";
export const PROFILES_PATH = "data/recommender/persona-profiles.json";
export const BATCHES_DIR = "data-local/recommender/batches";
export const REASONS_DIR = "data-local/recommender/reasons";

export const DEFAULT_INTO = "ratings.json";
/** File names --into may not take: written by other tools or other modes. */
const RESERVED_INTO = new Set(["ratings-isolated.json", "ratings-predicted.json", "ratings-client.json"]);

/** The prefix of a metadata-only rater's `model` (jev-rate.mjs, RV-18). */
export const METADATA_ONLY_MODEL_PREFIX = "jev-";

/** True for a model that writes no reasons and never sees a transcript. */
export function isMetadataOnlyModel(model) {
  return typeof model === "string" && model.startsWith(METADATA_ONLY_MODEL_PREFIX);
}

/** The ratings file and progress file `--into <name>` selects (repo-relative),
    or throws on a name it may not take. */
export function intoPaths(into = DEFAULT_INTO) {
  if (into === DEFAULT_INTO) return { ratings: RATINGS_PATH, progress: PROGRESS_PATH, side: false };
  const m = /^ratings-([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/.exec(String(into));
  if (!m || RESERVED_INTO.has(into)) {
    throw new Error(`--into takes ${DEFAULT_INTO} or a bare ratings-<rater>.json (not ${[...RESERVED_INTO].join(", ")}), got ${JSON.stringify(into)}`);
  }
  return { ratings: `data/recommender/${into}`, progress: `data/recommender/rating-progress-${m[1]}.json`, side: true };
}

/** The two slots on a 0-1 scale; every other slot is 1-5. */
const UNIT_SLOTS = new Set(["return_prob", "confidence"]);

/** A batch id as a file-name segment. Batch ids may carry `:` (the
    `isolated:<persona_id>` mode), which Windows refuses in a file name. */
export function fileSafe(batchId) {
  return String(batchId).replace(/[^A-Za-z0-9._-]/g, "_");
}

export function batchPathFor(batchId, root = REPO_ROOT) {
  return join(root, BATCHES_DIR, `rating-batch-${fileSafe(batchId)}.json`);
}

export function reasonsPathFor(batchId, root = REPO_ROOT) {
  return join(root, REASONS_DIR, `${fileSafe(batchId)}.jsonl`);
}

/** The never-merged ratings file (also the committed skeleton). */
export function skeletonRatings() {
  return { version: 1, rubric_version: RUBRIC_VERSION, built_at: null, merged_batches: [], shows: {} };
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const round = (v, places) => (v === null ? null : Math.round(v * 10 ** places) / 10 ** places);
const placesOf = (slot) => (UNIT_SLOTS.has(slot) ? 2 : 1);
const isRated = (show) => !(typeof show.not_rated_because === "string" && show.not_rated_because.trim().length > 0);

/** The batch's packs by show key. A pack's tier is `tier` (evidence.mjs
    buildEvidence); `evidence_tier` is accepted too. */
export function packsByKey(batch) {
  const out = new Map();
  for (const pack of Array.isArray(batch?.shows) ? batch.shows : []) {
    if (pack && typeof pack.show_key === "string") out.set(pack.show_key, pack);
  }
  return out;
}

const packTier = (pack, fallback) => pack?.tier ?? pack?.evidence_tier ?? fallback;

/* ---------------------------------------------------------- validation */

/** The `at` paths of the persona reasons that may be "" in `results`: every
    exactly-empty reason of a metadata-only model (Jev writes no text), none
    for any other model. */
export function emptyReasonPaths(results) {
  const out = new Set();
  if (!isObject(results) || !isMetadataOnlyModel(results.model) || !isObject(results.results)) return out;
  for (const [key, show] of Object.entries(results.results)) {
    if (!isObject(show) || !isObject(show.personas)) continue;
    for (const [pid, r] of Object.entries(show.personas)) {
      if (isObject(r) && r.reason === "") out.add(`results.${key}.personas.${pid}.reason`);
    }
  }
  return out;
}

/** The weaker of two evidence tiers (later in EVIDENCE_TIERS). */
const weakerTier = (a, b) => (EVIDENCE_TIERS.indexOf(b) > EVIDENCE_TIERS.indexOf(a) ? b : a);

/** Every reason to refuse `results` as an answer to `batch`: schema.mjs's
    problems plus the batch checks. `profilesSha256OnDisk` is the hash of the
    profiles file the batch names, as it is now; `progress` is the progress
    document (for the already-rated check). Pure. */
export function validateAgainstBatch(results, batch, { personaIds, profilesSha256OnDisk = null, progress = null } = {}) {
  const problems = [];
  const add = (code, at, message) => problems.push({ code, at, message });
  if (!isObject(batch) || typeof batch.batch_id !== "string" || !Array.isArray(batch.shows)) {
    add("bad_batch", "", "the batch file must carry batch_id and a shows array (prepare-rating-batch.mjs)");
    return problems;
  }
  const packs = packsByKey(batch);
  const allowedEmpty = emptyReasonPaths(results);
  for (const p of validateResultsFile(results, { personaIds, showKeys: [...packs.keys()] })) {
    if (!(p.code === "reason_missing" && allowedEmpty.has(p.at))) problems.push(p);
  }
  if (!isObject(results)) return problems;

  if (results.batch_id !== batch.batch_id) {
    add("batch_id_mismatch", "batch_id", `results answer batch ${JSON.stringify(results.batch_id)}, the batch file is ${JSON.stringify(batch.batch_id)}`);
  }
  if (results.rubric_version !== batch.rubric_version) {
    add("rubric_version_mismatch", "rubric_version", `results use rubric ${JSON.stringify(results.rubric_version)}, the batch asked for ${JSON.stringify(batch.rubric_version)}`);
  }
  if (results.mode !== batch.mode) add("mode_mismatch", "mode", `results are ${JSON.stringify(results.mode)}, the batch is ${JSON.stringify(batch.mode)}`);
  if (results.pass !== batch.pass) add("pass_mismatch", "pass", `results are pass ${JSON.stringify(results.pass)}, the batch is pass ${JSON.stringify(batch.pass)}`);
  if (results.profiles_sha256 !== batch.profiles_sha256) {
    add("profiles_sha256_mismatch", "profiles_sha256", `results carry profiles_sha256 ${JSON.stringify(results.profiles_sha256 ?? null)}, the batch ${JSON.stringify(batch.profiles_sha256 ?? null)}; copy it from the batch`);
  }
  if (profilesSha256OnDisk !== null && batch.profiles_sha256 !== profilesSha256OnDisk) {
    add("profiles_changed", "profiles_sha256", `the profiles file ${batch.profiles_path} changed since the batch was prepared; re-prepare the batch`);
  }

  if (!isObject(results.results)) return problems;
  const joint = results.mode === "joint";
  for (const [key, show] of Object.entries(results.results)) {
    const pack = packs.get(key);
    if (!pack || !isObject(show)) continue;
    if (packTier(pack) === "none" && isRated(show)) {
      add("rated_without_evidence", `results.${key}`, `results.${key} is rated, but its pack has evidence tier "none"; a show with no evidence is never rated (D4)`);
    }
    const passes = progress?.rated?.[key]?.passes;
    if (joint && Array.isArray(passes) && passes.includes(results.pass)) {
      add("pass_already_rated", `results.${key}`, `results.${key} was already rated at pass ${results.pass} (by ${progress.rated[key].last_batch_id}); a pass is merged once`);
    }
  }
  return problems;
}

/* ---------------------------------------------------------------- merge */

/** One persona's rating, normalised for `tier`, as the 10-slot array. */
function slotsOf(rating, tier, counts) {
  const audioNulled = nullAudioScoresUnlessTranscript(rating, tier);
  if (AUDIO_SUBSCORES.some((k) => rating[k] !== null && rating[k] !== undefined && audioNulled[k] === null)) counts.audio_nulled += 1;
  const capped = capConfidence(rating.confidence, tier);
  if (capped < rating.confidence) counts.confidence_capped += 1;
  return RATING_SLOTS.map((slot) => (slot === "confidence" ? capped : audioNulled[slot] ?? null));
}

/** The running mean of one slot: `old` held over `n` passes, `x` the new pass.
    A missing side (null) takes the other. */
function meanSlot(old, n, x, slot) {
  if (old === null || old === undefined || n < 1) return round(x, placesOf(slot));
  if (x === null || x === undefined) return round(old, placesOf(slot));
  return round((old * n + x) / (n + 1), placesOf(slot));
}

/** The array a persona ends with, after the tier's rules are re-applied to
    the merged values (a later pass may lower the tier). */
function finishArray(arr, tier) {
  const bySlot = Object.fromEntries(RATING_SLOTS.map((k, i) => [k, arr[i]]));
  const nulled = nullAudioScoresUnlessTranscript(bySlot, tier);
  nulled.confidence = round(capConfidence(nulled.confidence, tier), 2);
  return RATING_SLOTS.map((k) => nulled[k]);
}

/** argmax fit, ties to the higher return_prob, then the persona id. Only
    personas in `candidates` (those whose reason is in hand) are eligible. */
export function topPersona(personas, candidates) {
  const ids = Object.keys(personas).filter((p) => candidates.has(p)).sort();
  let best = null;
  for (const p of ids) {
    if (best === null) best = p;
    else {
      const [f, r] = personas[p];
      const [bf, br] = personas[best];
      if (f > bf || (f === bf && r > br)) best = p;
    }
  }
  return best;
}

/** Merge validated `results` (answering `batch`) into `target` (a ratings
    document), in place. Returns the counts and the reason lines. Call only
    after validateAgainstBatch returned no problems. */
export function mergeInto(target, results, batch, { now = new Date() } = {}) {
  const isolated = results.mode !== "joint";
  const packs = packsByKey(batch);
  const counts = { shows_merged: 0, not_rated: [], audio_nulled: 0, confidence_capped: 0, tier_from_batch: 0 };
  const reasons = [];

  for (const key of Object.keys(results.results).sort()) {
    const show = results.results[key];
    const pack = packs.get(key);
    if (!isRated(show)) {
      counts.not_rated.push(key);
      continue;
    }
    // A metadata-only rater may declare less than the pack holds (it never saw
    // the transcript windows); it can never declare more.
    const fromPack = packTier(pack, show.evidence_tier);
    const tier = isMetadataOnlyModel(results.model) ? weakerTier(fromPack, show.evidence_tier) : fromPack;
    if (tier !== show.evidence_tier) counts.tier_from_batch += 1;
    const old = target.shows[key] || null;
    const n = old ? old.passes : 0;

    const personas = old ? { ...old.personas } : {};
    const candidateReasons = new Map();
    if (old && old.top_persona) candidateReasons.set(old.top_persona, old.top_reason);
    for (const pid of Object.keys(show.personas).sort()) {
      const rating = show.personas[pid];
      const slots = slotsOf(rating, tier, counts);
      const prev = personas[pid];
      personas[pid] = isolated || !prev
        ? slots.map((v, i) => round(v, placesOf(RATING_SLOTS[i])))
        : slots.map((v, i) => meanSlot(prev[i], n, v, RATING_SLOTS[i]));
      candidateReasons.set(pid, rating.reason);
      reasons.push({ batch_id: results.batch_id, show_key: key, persona_id: pid, pass: results.pass, reason: rating.reason });
    }
    for (const pid of Object.keys(personas)) personas[pid] = finishArray(personas[pid], tier);

    const flags = {};
    for (const f of Object.keys(show.flags)) flags[f] = Boolean(show.flags[f]) || Boolean(old?.flags?.[f]);
    if (pack?.flags_prescan?.injection_suspected === true) flags.injection_suspected = true;

    const top = topPersona(personas, new Set(candidateReasons.keys()));
    const sortedPersonas = Object.fromEntries(Object.keys(personas).sort().map((p) => [p, personas[p]]));
    target.shows[key] = {
      evidence_tier: tier,
      summary: show.summary,
      format: show.format,
      flags,
      top_reason: candidateReasons.get(top),
      top_persona: top,
      passes: isolated ? results.pass : n + 1,
      personas: sortedPersonas,
    };
    counts.shows_merged += 1;
  }
  target.merged_batches = [...(target.merged_batches || []), results.batch_id];
  target.built_at = new Date(now instanceof Date ? now.getTime() : now).toISOString();
  return { counts, reasons };
}

/** ratings.json as the file holds it: the header and the batch ledger one
    item per line, then one show per line (keys sorted), so a diff of a merge
    shows exactly the shows it touched and a 5,000-show file stays readable. */
export function serializeRatings(doc) {
  const list = (items, indent) => (items.length === 0 ? "[]" : `[\n${items.map((b) => `${indent}  ${JSON.stringify(b)}`).join(",\n")}\n${indent}]`);
  const keys = Object.keys(doc.shows || {}).sort();
  const shows = keys.length === 0 ? "{}" : `{\n${keys.map((k) => `    ${JSON.stringify(k)}: ${JSON.stringify(doc.shows[k])}`).join(",\n")}\n  }`;
  return [
    "{",
    `  "version": ${JSON.stringify(doc.version)},`,
    `  "rubric_version": ${JSON.stringify(doc.rubric_version)},`,
    `  "built_at": ${JSON.stringify(doc.built_at)},`,
    `  "merged_batches": ${list(doc.merged_batches || [], "  ")},`,
    `  "shows": ${shows}`,
    "}",
    "",
  ].join("\n");
}

/* ------------------------------------------------------------------ I/O */

function readJsonOr(path, code, add) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    add(code, path, `${path}: ${existsSync(path) ? `does not parse (${e.message})` : "does not exist"}`);
    return null;
  }
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const within = (root, p) => (isAbsolute(p) ? p : join(root, p));

/** Validate and merge one results file. Returns `{ ok, problems, report }`;
    writes only when ok. `root` is the repo root (tests pass a temp dir). */
export function runMerge({ resultsPath, batchPath = null, root = REPO_ROOT, now = new Date(), into = DEFAULT_INTO, lockWaitMs = LOCK_WAIT_MS }) {
  const problems = [];
  const add = (code, at, message) => problems.push({ code, at, message });
  const refuse = () => ({ ok: false, problems, report: null });

  let paths;
  try {
    paths = intoPaths(into);
  } catch (e) {
    add("bad_into", "--into", e.message);
    return refuse();
  }
  const results = readJsonOr(resultsPath, "results_unreadable", add);
  if (!results) return refuse();
  if (typeof results.batch_id !== "string" || results.batch_id.trim().length === 0) {
    add("bad_batch_id", "batch_id", "the results file has no batch_id, so it answers no batch");
    return refuse();
  }
  const bPath = batchPath ?? batchPathFor(results.batch_id, root);
  const batch = readJsonOr(bPath, "batch_not_found", add);
  if (!batch) return refuse();

  const isolated = results.mode !== "joint";
  if (isolated && paths.side) {
    add("isolated_into_side_file", "--into", `isolated results always merge into ${ISOLATED_PATH}; drop --into ${into}`);
    return refuse();
  }
  if (isMetadataOnlyModel(results.model) && !paths.side) {
    add("metadata_only_into_gold", "model", `${JSON.stringify(results.model)} results carry no reasons and replace no rating until they clear the RV-14 gate; merge them with --into ratings-jev.json`);
    return refuse();
  }
  const targetPath = join(root, isolated ? ISOLATED_PATH : paths.ratings);
  const progressPath = join(root, paths.progress);
  /* A side file's shows may hold an empty top_reason (a metadata-only rater's);
     ratings.json's never. */
  const shapeProblems = (doc) =>
    validateRatingsFile(doc).filter((p) => {
      const m = /^shows\.(.+)\.top_reason$/.exec(p.at);
      return !(paths.side && p.code === "reason_missing" && m && doc.shows?.[m[1]]?.top_reason === "");
    });
  /* Everything from reading the progress and ratings files through writing
     both runs under the progress lock: prepare and other merges rewrite the
     same files whole, and an interleaved read-modify-write loses a batch
     (RV-13). */
  const mergeLocked = () => {
    const progress = loadProgress(progressPath);
    const progressBefore = serializeProgress(progress);
    const target = existsSync(targetPath) ? readJsonOr(targetPath, "ratings_unreadable", add) : skeletonRatings();
    if (!target) return refuse();
    if (!Array.isArray(target.merged_batches)) target.merged_batches = [];
    const batchKeys = (Array.isArray(batch.shows) ? batch.shows : []).map((p) => p?.show_key).filter((k) => typeof k === "string");

    const settleProgress = () => {
      const released = release(progress, results.batch_id);
      // An isolated batch is recorded under the keys RV-08 reserved it by
      // (`<show_key>@isolated:<persona_id>`), never the show's own joint key: it is
      // not one of the joint passes, but without the record prepare-rating-batch
      // would offer the same isolated shows again after every merge.
      if (Number.isInteger(results.pass)) {
        const keys = isolated ? batchKeys.map((k) => progressKey(k, results.mode)) : batchKeys;
        markRated(progress, keys, { pass: results.pass, batchId: results.batch_id });
      }
      if (serializeProgress(progress) !== progressBefore) saveProgress(progressPath, progress);
      return released;
    };

    if (target.merged_batches.includes(results.batch_id) && batch.batch_id === results.batch_id) {
      const released = settleProgress();
      return { ok: true, problems, report: { batch_id: results.batch_id, already_merged: true, released: released.length } };
    }

    const profilesPath = within(root, typeof batch.profiles_path === "string" ? batch.profiles_path : PROFILES_PATH);
    const profiles = readJsonOr(profilesPath, "profiles_unreadable", add);
    if (!profiles) return refuse();
    const personaIds = (Array.isArray(profiles.personas) ? profiles.personas : []).map((p) => p && p.id).filter(Boolean);

    for (const p of validateAgainstBatch(results, batch, { personaIds, profilesSha256OnDisk: sha256File(profilesPath), progress })) problems.push(p);
    /* The results' personas were checked against the profiles above; the file
       being merged into is checked for shape only, so a persona pruned from the
       profiles later (RV-29) does not wedge every merge. --check names it. */
    for (const p of shapeProblems(target)) problems.push({ ...p, code: `existing_${p.code}`, at: `${targetPath}#${p.at}` });
    if (problems.length > 0) return refuse();

    const { counts, reasons } = mergeInto(target, results, batch, { now });
    for (const p of shapeProblems(target)) problems.push({ ...p, code: `merged_${p.code}` });
    if (problems.length > 0) return refuse();

    const reasonsPath = reasonsPathFor(results.batch_id, root);
    writeText(reasonsPath, reasons.map((r) => `${JSON.stringify(r)}\n`).join(""));
    writeText(targetPath, serializeRatings(target));
    const released = settleProgress();
    return {
      ok: true,
      problems,
      report: {
        batch_id: results.batch_id,
        mode: results.mode,
        pass: results.pass,
        target: targetPath,
        progress: progressPath,
        reasons_path: reasonsPath,
        reasons_written: reasons.length,
        released: released.length,
        ...counts,
      },
    };
  };
  try {
    return withProgressLock(progressPath, mergeLocked, { waitMs: lockWaitMs });
  } catch (e) {
    if (e.code !== "progress_locked") throw e;
    add("progress_locked", progressPath, e.message);
    return refuse();
  }
}

/** --check: the committed ratings files validate and no reservation is
    older than 12 hours. Returns the problems (empty = clean). */
export function runCheck({ root = REPO_ROOT, now = new Date() } = {}) {
  const problems = [];
  const add = (code, at, message) => problems.push({ code, at, message });
  const profiles = readJsonOr(join(root, PROFILES_PATH), "profiles_unreadable", add);
  const personaIds = profiles && Array.isArray(profiles.personas) ? profiles.personas.map((p) => p && p.id).filter(Boolean) : undefined;
  for (const rel of [RATINGS_PATH, ISOLATED_PATH]) {
    const path = join(root, rel);
    if (rel === ISOLATED_PATH && !existsSync(path)) continue;
    const doc = readJsonOr(path, "ratings_unreadable", add);
    if (doc) for (const p of validateRatingsFile(doc, { personaIds })) problems.push({ ...p, at: `${rel}#${p.at}` });
  }
  const progress = loadProgress(join(root, PROGRESS_PATH));
  const t = now instanceof Date ? now.getTime() : Number(now);
  for (const [key, meta] of Object.entries(progress.in_flight)) {
    const at = Date.parse(meta && meta.reserved_at);
    if (Number.isNaN(at) || t - at > STALE_MS) {
      add("stale_in_flight", `${PROGRESS_PATH}#in_flight.${key}`, `${key} has been reserved by ${meta?.batch_id} since ${meta?.reserved_at}, over 12 h; prepare's reclaimStale frees it`);
    }
  }
  return problems;
}

/* ------------------------------------------------------------------ CLI */

const USAGE = "usage: node tools/recommender/merge-rating-results.mjs --results <file> [--batch <file>] [--into ratings-<rater>.json] | --check";

export function parseArgs(argv) {
  const args = { results: null, batch: null, check: false, into: DEFAULT_INTO };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--results") args.results = argv[++i];
    else if (a === "--batch") args.batch = argv[++i];
    else if (a === "--into") args.into = argv[++i];
    else if (a === "--check") args.check = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!args.check && !args.results) throw new Error("--results <file> or --check is required");
  if (args.check && args.results) throw new Error("--check takes no --results");
  if (args.check && args.into !== DEFAULT_INTO) throw new Error("--check takes no --into");
  intoPaths(args.into);
  return args;
}

function printProblems(problems, log) {
  for (const p of problems) log(`  ${p.code}  ${p.at}  ${p.message}`);
}

export function main(argv = process.argv.slice(2), { root = REPO_ROOT, now = new Date(), log = (l) => console.error(l), out = (l) => console.log(l) } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    log(`merge-rating-results: ${e.message}\n${USAGE}`);
    return 2;
  }
  if (args.check) {
    const problems = runCheck({ root, now });
    if (problems.length > 0) {
      log(`merge-rating-results --check: ${problems.length} problem(s)`);
      printProblems(problems, log);
      return 1;
    }
    out("merge-rating-results --check: ok");
    return 0;
  }
  const { ok, problems, report } = runMerge({
    resultsPath: resolve(process.cwd(), args.results),
    batchPath: args.batch ? resolve(process.cwd(), args.batch) : null,
    root,
    now,
    into: args.into,
  });
  if (!ok) {
    log(`merge-rating-results: refused, nothing merged (${problems.length} problem(s)); fix them in the results file and run again`);
    printProblems(problems, log);
    return 1;
  }
  out(JSON.stringify(report));
  return 0;
}

if (isEntryScript(import.meta.url)) {
  process.exitCode = main();
}
