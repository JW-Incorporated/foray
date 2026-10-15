/* tools/recommender/merge-rating-results.mjs: validate, merge, release
   (RV-09, docs/roadmap/recommender-v1.md D7, D8, D10).

   Every test runs against a fresh temp repo root (data/recommender/ with a
   two-persona profiles file, a progress file holding the batch's
   reservations, and data-local/recommender/batches/) and names the one-line
   mutation of merge-rating-results.mjs that turns it red; each was run red
   before this suite was committed. Offline: no network, no model. The batch
   carries three packs that pin the three branches: a transcript show (audio
   scores kept), a show-metadata show (audio nulled, confidence capped at
   0.5) and a tier-"none" show the rater leaves unrated. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ISOLATED_PATH,
  PROGRESS_PATH,
  RATINGS_PATH,
  batchPathFor,
  main,
  reasonsPathFor,
  runCheck,
  runMerge,
  serializeRatings,
  skeletonRatings,
} from "./merge-rating-results.mjs";
import { eligibleShows, progressKey } from "./prepare-rating-batch.mjs";
import { lockPathFor } from "./progress.mjs";
import { RUBRIC_VERSION, validateRatingsFile } from "./schema.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NOW = new Date("2026-10-14T12:00:00.000Z");
const HOUR = 3600e3;
const FLAGS_OFF = { explicit: false, harassment: false, medical_financial_advice: false, injection_suspected: false };
const PROFILES_REL = "data/recommender/persona-profiles.json";
const KEYS = ["curated-show", "1000000001", "1000000002"];

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
const writeJson = (path, doc) => write(path, `${JSON.stringify(doc, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** A temp repo root with profiles and an empty progress file. */
function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "rv09-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeJson(join(root, PROFILES_REL), { version: 1, personas: [{ id: "p-history" }, { id: "p-light" }] });
  writeJson(join(root, PROGRESS_PATH), { in_flight: {}, rated: {} });
  return root;
}

const profilesSha = (root) => createHash("sha256").update(readFileSync(join(root, PROFILES_REL))).digest("hex");

function batchDoc(root, { batchId = "pilot-1-joint-2026-10-14-aaaa1111", pass = 1, mode = "joint", prescan = false } = {}) {
  return {
    batch_id: batchId,
    rubric_version: RUBRIC_VERSION,
    rubric_path: "docs/curation/rating-rubric-v1.md",
    profiles_path: PROFILES_REL,
    profiles_sha256: profilesSha(root),
    mode,
    pass,
    persona_order: {},
    shows: [
      { show_key: "1000000001", title: "Kitchen calls", tier: "show-metadata", flags_prescan: { injection_suspected: prescan } },
      { show_key: "curated-show", title: "One battle", tier: "transcript", flags_prescan: { injection_suspected: false } },
      { show_key: "1000000002", title: "Title only", tier: "none", flags_prescan: { injection_suspected: false } },
    ],
  };
}

function rating(over = {}) {
  return {
    fit: 4, return_prob: 0.6, topic_fit: 4, depth: 3, accessibility: 4, binge_vs_dip: 5,
    host_style: null, production: null, ad_load: null, confidence: 0.4,
    reason: "Plain answers to kitchen questions, one caller at a time.",
    ...over,
  };
}

function resultsDoc(batch, { personas = ["p-history", "p-light"] } = {}) {
  const pick = (all) => Object.fromEntries(personas.map((p) => [p, all[p]]));
  return {
    batch_id: batch.batch_id,
    rubric_version: RUBRIC_VERSION,
    model: "claude-sonnet",
    mode: batch.mode,
    pass: batch.pass,
    rated_at: NOW.toISOString(),
    profiles_sha256: batch.profiles_sha256,
    results: {
      "curated-show": {
        evidence_tier: "transcript",
        summary: "Two historians retell one battle per episode.",
        format: "narrative",
        host_count: 2,
        flags: { ...FLAGS_OFF },
        not_rated_because: null,
        personas: pick({
          "p-history": rating({ fit: 5, return_prob: 0.9, host_style: 4, production: 4, ad_load: 3, confidence: 0.9, reason: "Battles told from the letters of the people in them." }),
          "p-light": rating({ fit: 2, return_prob: 0.2, host_style: 3, production: 4, ad_load: 3, confidence: 0.8, reason: "Long chapters with dates and maps, heavy going for a casual ear." }),
        }),
      },
      "1000000001": {
        evidence_tier: "show-metadata",
        summary: "Call-in cooking questions answered by a chef.",
        format: "panel",
        host_count: null,
        flags: { ...FLAGS_OFF },
        not_rated_because: null,
        personas: pick({
          "p-history": rating({ fit: 2, return_prob: 0.1, confidence: 0.3, reason: "Recipes and timings with no past to dig into." }),
          "p-light": rating({ fit: 4, return_prob: 0.6, confidence: 0.4 }),
        }),
      },
      "1000000002": {
        evidence_tier: "none",
        summary: null,
        format: null,
        host_count: null,
        flags: { ...FLAGS_OFF },
        not_rated_because: "the pack has a title and nothing else",
        personas: null,
      },
    },
  };
}

/** Write a batch and its results, reserve the batch's keys; return paths. */
function stage(root, batch, results, { reserve = true } = {}) {
  writeJson(batchPathFor(batch.batch_id, root), batch);
  const resultsPath = join(root, "data-local", "recommender", "results", `rating-results-${batch.batch_id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  writeJson(resultsPath, results);
  if (reserve) {
    const progress = readJson(join(root, PROGRESS_PATH));
    for (const k of KEYS) progress.in_flight[k] = { batch_id: batch.batch_id, reserved_at: new Date(NOW.getTime() - HOUR).toISOString() };
    writeJson(join(root, PROGRESS_PATH), progress);
  }
  return resultsPath;
}

test("merges a valid batch and releases its reservations", (t) => {
  // mutation: skip `release(progress, results.batch_id)` in settleProgress -> in_flight keeps the keys
  const root = makeRoot(t);
  const batch = batchDoc(root);
  const resultsPath = stage(root, batch, resultsDoc(batch));
  const progress0 = readJson(join(root, PROGRESS_PATH));
  progress0.in_flight.elsewhere = { batch_id: "another-batch", reserved_at: NOW.toISOString() };
  writeJson(join(root, PROGRESS_PATH), progress0);

  const { ok, problems, report } = runMerge({ resultsPath, root, now: NOW });
  assert.deepEqual(problems, []);
  assert.equal(ok, true);
  assert.equal(report.shows_merged, 2);
  assert.deepEqual(report.not_rated, ["1000000002"]);
  assert.equal(report.released, 3);

  const ratings = readJson(join(root, RATINGS_PATH));
  assert.deepEqual(validateRatingsFile(ratings, { personaIds: ["p-history", "p-light"] }), []);
  assert.deepEqual(Object.keys(ratings.shows).sort(), ["1000000001", "curated-show"], "the unrated show never enters ratings.json");
  assert.deepEqual(ratings.merged_batches, [batch.batch_id]);
  assert.equal(ratings.built_at, NOW.toISOString());
  assert.deepEqual(ratings.shows["curated-show"].personas["p-history"], [5, 0.9, 4, 3, 4, 5, 4, 4, 3, 0.9]);

  const progress = readJson(join(root, PROGRESS_PATH));
  assert.deepEqual(Object.keys(progress.in_flight), ["elsewhere"], "only this batch's reservations are released");
  for (const k of KEYS) assert.deepEqual(progress.rated[k], { last_batch_id: batch.batch_id, passes: [1] });
});

test("a second merge of the same batch_id is a no-op", (t) => {
  // mutation: drop the `target.merged_batches.includes(results.batch_id)` early return -> pass_already_rated refuses the rerun
  const root = makeRoot(t);
  const batch = batchDoc(root);
  const resultsPath = stage(root, batch, resultsDoc(batch));
  assert.equal(runMerge({ resultsPath, root, now: NOW }).ok, true);
  const before = readFileSync(join(root, RATINGS_PATH), "utf8");
  const progressBefore = readFileSync(join(root, PROGRESS_PATH), "utf8");

  const again = runMerge({ resultsPath, root, now: new Date(NOW.getTime() + HOUR) });
  assert.deepEqual(again.problems, []);
  assert.equal(again.ok, true);
  assert.equal(again.report.already_merged, true);
  assert.equal(readFileSync(join(root, RATINGS_PATH), "utf8"), before, "ratings.json is byte-identical (built_at included)");
  assert.equal(readFileSync(join(root, PROGRESS_PATH), "utf8"), progressBefore);
});

test("a merge holds the progress lock: refused and unwritten while another holds it", (t) => {
  // mutation: in runMerge, `return mergeLocked();` instead of through withProgressLock -> the merge writes ratings.json
  // and rating-progress.json while a prepare or another merge holds the lock
  const root = makeRoot(t);
  const batch = batchDoc(root);
  const resultsPath = stage(root, batch, resultsDoc(batch));
  const progressPath = join(root, PROGRESS_PATH);
  const progressBefore = readFileSync(progressPath, "utf8");
  mkdirSync(lockPathFor(progressPath)); // another process holds it

  const held = runMerge({ resultsPath, root, now: NOW, lockWaitMs: 100 });
  assert.equal(held.ok, false);
  assert.deepEqual(held.problems.map((p) => p.code), ["progress_locked"]);
  assert.equal(existsSync(join(root, RATINGS_PATH)), false, "ratings.json is not written");
  assert.equal(readFileSync(progressPath, "utf8"), progressBefore, "the progress file is not written");
  assert.ok(existsSync(lockPathFor(progressPath)), "the other holder's lock is left alone");

  rmSync(lockPathFor(progressPath), { recursive: true });
  assert.equal(runMerge({ resultsPath, root, now: NOW }).ok, true);
  assert.equal(existsSync(lockPathFor(progressPath)), false, "the merge releases its lock");
});

test("one problem refuses the whole file", (t) => {
  // mutation: replace the first `if (problems.length > 0) return refuse();` with "delete the shows the problems name, clear
  // the problems" (merge the valid shows) -> the transcript show lands in ratings.json
  const root = makeRoot(t);
  const batch = batchDoc(root);
  const results = resultsDoc(batch);
  results.results["1000000001"].personas["p-light"].reason = "x".repeat(201);
  const resultsPath = stage(root, batch, results);
  const progressBefore = readFileSync(join(root, PROGRESS_PATH), "utf8");

  const { ok, problems } = runMerge({ resultsPath, root, now: NOW });
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.code === "reason_too_long"), JSON.stringify(problems));
  assert.equal(existsSync(join(root, RATINGS_PATH)), false, "nothing merged, not even the valid transcript show");
  assert.equal(existsSync(reasonsPathFor(batch.batch_id, root)), false);
  assert.equal(readFileSync(join(root, PROGRESS_PATH), "utf8"), progressBefore, "reservations kept for the retry");
  assert.equal(main(["--results", resultsPath], { root, now: NOW, log: () => {}, out: () => {} }), 1, "the CLI exits 1");
});

test("a profiles_sha256 mismatch is refused", (t) => {
  // mutation: drop the `results.profiles_sha256 !== batch.profiles_sha256` check in validateAgainstBatch
  const root = makeRoot(t);
  const batch = batchDoc(root);
  const results = resultsDoc(batch);
  results.profiles_sha256 = "0".repeat(64);
  const resultsPath = stage(root, batch, results);
  const { ok, problems } = runMerge({ resultsPath, root, now: NOW });
  assert.equal(ok, false);
  assert.deepEqual(problems.map((p) => p.code), ["profiles_sha256_mismatch"]);
  assert.equal(existsSync(join(root, RATINGS_PATH)), false);
});

test("the profiles file changing after prepare is refused", (t) => {
  // mutation: drop the `batch.profiles_sha256 !== profilesSha256OnDisk` check in validateAgainstBatch
  const root = makeRoot(t);
  const batch = batchDoc(root);
  const resultsPath = stage(root, batch, resultsDoc(batch));
  writeJson(join(root, PROFILES_REL), { version: 2, personas: [{ id: "p-history" }, { id: "p-light" }] });
  const { ok, problems } = runMerge({ resultsPath, root, now: NOW });
  assert.equal(ok, false);
  assert.deepEqual(problems.map((p) => p.code), ["profiles_changed"]);
});

test("audio sub-scores are nulled for non-transcript shows and the count is reported", (t) => {
  // mutation: in slotsOf, `const audioNulled = rating;` (skip nullAudioScoresUnlessTranscript) -> audio_nulled 0
  // The rater copied "transcript" for a show whose pack is show-metadata; the batch's tier wins.
  const root = makeRoot(t);
  const batch = batchDoc(root);
  const results = resultsDoc(batch);
  const show = results.results["1000000001"];
  show.evidence_tier = "transcript";
  show.personas["p-light"] = rating({ host_style: 4, production: 3, ad_load: 2, confidence: 0.9 });
  const resultsPath = stage(root, batch, results);

  const { ok, problems, report } = runMerge({ resultsPath, root, now: NOW });
  assert.deepEqual(problems, []);
  assert.equal(ok, true);
  assert.equal(report.audio_nulled, 1);
  assert.equal(report.confidence_capped, 1);
  assert.equal(report.tier_from_batch, 1);
  const merged = readJson(join(root, RATINGS_PATH)).shows["1000000001"];
  assert.equal(merged.evidence_tier, "show-metadata");
  assert.deepEqual(merged.personas["p-light"], [4, 0.6, 4, 3, 4, 5, null, null, null, 0.5]);
});

test("pass 2 averages and records passes: 2", (t) => {
  // mutation: in mergeInto, `personas[pid] = isolated || !prev` -> `personas[pid] = true` (overwrite) -> fit 3, passes 2
  const root = makeRoot(t);
  const b1 = batchDoc(root);
  assert.equal(runMerge({ resultsPath: stage(root, b1, resultsDoc(b1)), root, now: NOW }).ok, true);

  const b2 = batchDoc(root, { batchId: "pilot-2-joint-2026-10-15-bbbb2222", pass: 2 });
  const r2 = resultsDoc(b2);
  r2.results["curated-show"].personas["p-history"] = rating({ fit: 3, return_prob: 0.65, host_style: 2, production: 4, ad_load: 3, confidence: 0.6, reason: "Second listen: the letters carry it, the asides drag." });
  const { ok, problems } = runMerge({ resultsPath: stage(root, b2, r2), root, now: NOW });
  assert.deepEqual(problems, []);
  assert.equal(ok, true);

  const show = readJson(join(root, RATINGS_PATH)).shows["curated-show"];
  assert.equal(show.passes, 2);
  // fit (5+3)/2, return_prob (0.9+0.65)/2 to two places, host_style (4+2)/2, confidence (0.9+0.6)/2
  assert.deepEqual(show.personas["p-history"], [4, 0.78, 4, 3, 4, 5, 3, 4, 3, 0.75]);
  assert.equal(show.top_persona, "p-history");
  assert.equal(show.top_reason, "Second listen: the letters carry it, the asides drag.", "top_reason is the latest pass's");
  assert.deepEqual(readJson(join(root, PROGRESS_PATH)).rated["curated-show"].passes, [1, 2]);
});

test("a pass a show was already rated at is refused", (t) => {
  // mutation: drop the `pass_already_rated` check -> pass 1 counted twice (passes: 2)
  const root = makeRoot(t);
  const b1 = batchDoc(root);
  assert.equal(runMerge({ resultsPath: stage(root, b1, resultsDoc(b1)), root, now: NOW }).ok, true);
  const again = batchDoc(root, { batchId: "pilot-1-joint-2026-10-15-cccc3333" });
  const { ok, problems } = runMerge({ resultsPath: stage(root, again, resultsDoc(again)), root, now: NOW });
  assert.equal(ok, false);
  assert.ok(problems.length > 0 && problems.every((p) => p.code === "pass_already_rated"), JSON.stringify(problems));
  assert.equal(readJson(join(root, RATINGS_PATH)).shows["curated-show"].passes, 1);
});

test("full reasons go to data-local and only top_reason stays", (t) => {
  // mutation: drop the `writeText(reasonsPath, ...)` line -> no reasons file
  const root = makeRoot(t);
  const batch = batchDoc(root);
  const results = resultsDoc(batch);
  const resultsPath = stage(root, batch, results);
  const { report } = runMerge({ resultsPath, root, now: NOW });
  assert.equal(report.reasons_written, 4);

  const lines = readFileSync(reasonsPathFor(batch.batch_id, root), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const all = Object.entries(results.results).flatMap(([key, s]) => Object.entries(s.personas || {}).map(([pid, r]) => ({ batch_id: batch.batch_id, show_key: key, persona_id: pid, pass: 1, reason: r.reason })));
  const order = (a, b) => `${a.show_key}/${a.persona_id}`.localeCompare(`${b.show_key}/${b.persona_id}`);
  assert.deepEqual(lines.sort(order), all.sort(order));

  const text = readFileSync(join(root, RATINGS_PATH), "utf8");
  const ratings = JSON.parse(text);
  assert.equal(ratings.shows["curated-show"].top_reason, results.results["curated-show"].personas["p-history"].reason);
  assert.equal(ratings.shows["1000000001"].top_persona, "p-light");
  for (const r of all) {
    const isTop = ratings.shows[r.show_key].top_persona === r.persona_id;
    assert.equal(text.includes(r.reason), isTop, `${r.show_key}/${r.persona_id}'s reason ${isTop ? "is" : "is not"} in ratings.json`);
  }
});

test("top persona ties go to the higher return_prob", (t) => {
  // mutation: in topPersona, drop `|| (f === bf && r > br)` -> the alphabetically first persona wins the tie
  const root = makeRoot(t);
  const batch = batchDoc(root);
  const results = resultsDoc(batch);
  results.results["1000000001"].personas["p-history"] = rating({ fit: 4, return_prob: 0.3, confidence: 0.3, reason: "Recipes and timings with no past to dig into." });
  results.results["1000000001"].personas["p-light"] = rating({ fit: 4, return_prob: 0.7, confidence: 0.4 });
  const { ok } = runMerge({ resultsPath: stage(root, batch, results), root, now: NOW });
  assert.equal(ok, true);
  const show = readJson(join(root, RATINGS_PATH)).shows["1000000001"];
  assert.equal(show.top_persona, "p-light");
  assert.equal(show.top_reason, "Plain answers to kitchen questions, one caller at a time.");
});

test("the pack's injection pre-scan is OR'd into the flags", (t) => {
  // mutation: drop the `pack?.flags_prescan?.injection_suspected` line in mergeInto
  const root = makeRoot(t);
  const batch = batchDoc(root, { prescan: true });
  const results = resultsDoc(batch);
  results.results["curated-show"].flags.explicit = true;
  const { ok } = runMerge({ resultsPath: stage(root, batch, results), root, now: NOW });
  assert.equal(ok, true);
  const shows = readJson(join(root, RATINGS_PATH)).shows;
  assert.equal(shows["1000000001"].flags.injection_suspected, true, "the rater missed it, the pre-scan did not");
  assert.equal(shows["curated-show"].flags.injection_suspected, false);
  assert.equal(shows["curated-show"].flags.explicit, true);
});

test("isolated results never enter ratings.json", (t) => {
  // mutation: `const targetPath = join(root, RATINGS_PATH);` (ignore the mode) -> the isolated rating lands in ratings.json
  const root = makeRoot(t);
  const batch = batchDoc(root, { batchId: "pilot-1-isolated:p-light-2026-10-14-dddd4444", mode: "isolated:p-light" });
  const resultsPath = stage(root, batch, resultsDoc(batch, { personas: ["p-light"] }));
  const { ok, problems, report } = runMerge({ resultsPath, root, now: NOW });
  assert.deepEqual(problems, []);
  assert.equal(ok, true);
  assert.equal(existsSync(join(root, RATINGS_PATH)), false, "ratings.json untouched");
  const isolated = readJson(join(root, ISOLATED_PATH));
  assert.deepEqual(validateRatingsFile(isolated), []);
  assert.deepEqual(Object.keys(isolated.shows["curated-show"].personas), ["p-light"]);
  assert.equal(report.released, 3);
  const progress = readJson(join(root, PROGRESS_PATH));
  assert.deepEqual(progress.in_flight, {});
  // mutation: in settleProgress, `if (Number.isInteger(results.pass))` -> `if (!isolated && Number.isInteger(results.pass))` -> rated stays {} and the isolated shows are offered again
  // mutation: map the isolated keys with `(k) => k` -> the shows' joint pass 1 is recorded
  const keys = batch.shows.map((p) => p.show_key);
  assert.deepEqual(Object.keys(progress.rated).sort(), keys.map((k) => progressKey(k, batch.mode)).sort(), "recorded under the isolated keys only, never the joint ones");
  for (const k of keys) assert.deepEqual(progress.rated[progressKey(k, batch.mode)].passes, [1]);
  const set = { shows: keys.map((show_key) => ({ show_key, roles: ["pilot", "isolated"] })) };
  assert.deepEqual(eligibleShows(set, progress, { role: "pilot", pass: 1, mode: batch.mode }), [], "a merged isolated batch is not offered again");
  assert.deepEqual(eligibleShows(set, progress, { role: "pilot", pass: 1, mode: "joint" }), keys, "the shows' joint pass 1 is still open");
  assert.ok(existsSync(reasonsPathFor(batch.batch_id, root)), "the reasons file name is Windows-safe despite the ':'");
});

test("--check passes the committed ratings and fails a bad file or a stale reservation", (t) => {
  // mutation: in runCheck, `t - at > STALE_MS` -> `t - at > Infinity` -> the 13-hour reservation passes
  const committed = readFileSync(join(REPO, RATINGS_PATH), "utf8");
  assert.equal(committed, serializeRatings(JSON.parse(committed)), "the committed ratings are in the merge's own form");
  assert.deepEqual(runCheck({ root: REPO, now: NOW }).filter((p) => p.code !== "stale_in_flight"), []);

  const root = makeRoot(t);
  write(join(root, RATINGS_PATH), serializeRatings(skeletonRatings()));
  assert.deepEqual(runCheck({ root, now: NOW }), []);
  assert.equal(main(["--check"], { root, now: NOW, log: () => {}, out: () => {} }), 0);

  writeJson(join(root, PROGRESS_PATH), { in_flight: { "1000000001": { batch_id: "old", reserved_at: new Date(NOW.getTime() - 13 * HOUR).toISOString() }, "1000000002": { batch_id: "new", reserved_at: new Date(NOW.getTime() - HOUR).toISOString() } }, rated: {} });
  assert.deepEqual(runCheck({ root, now: NOW }).map((p) => p.code), ["stale_in_flight"]);
  assert.equal(main(["--check"], { root, now: NOW, log: () => {}, out: () => {} }), 1);
  assert.deepEqual(readJson(join(root, PROGRESS_PATH)).in_flight["1000000001"].batch_id, "old", "reported, not fixed");

  writeJson(join(root, PROGRESS_PATH), { in_flight: {}, rated: {} });
  writeJson(join(root, RATINGS_PATH), { ...skeletonRatings(), shows: { x: { evidence_tier: "none" } } });
  assert.ok(runCheck({ root, now: NOW }).length > 0);
});

/* RV-18: --into and the metadata-only (jev-) rater. */

/** resultsDoc with every persona reason "" and `model`. */
function textlessResults(batch, model) {
  const results = resultsDoc(batch);
  results.model = model;
  for (const show of Object.values(results.results)) for (const r of Object.values(show.personas ?? {})) r.reason = "";
  return results;
}

test("an empty reason is accepted only for jev- models", (t) => {
  // mutation: in emptyReasonPaths, drop `|| !isMetadataOnlyModel(results.model)` (accept always) -> the claude-sonnet file merges
  // mutation: in runMerge's shapeProblems, `return true;` (no side-file allowance) -> merged_reason_missing refuses the jev file's empty top_reason
  const root = makeRoot(t);
  const batch = batchDoc(root);
  const sideProgress = join(root, "data/recommender/rating-progress-jev.json");
  writeJson(sideProgress, { in_flight: {}, rated: {} });

  const claudePath = stage(root, batch, textlessResults(batch, "claude-sonnet"), { reserve: false });
  const refused = runMerge({ resultsPath: claudePath, root, now: NOW, into: "ratings-jev.json" });
  assert.equal(refused.ok, false);
  assert.deepEqual([...new Set(refused.problems.map((p) => p.code))], ["reason_missing"]);
  assert.equal(refused.problems.length, 4, "every empty reason of a non-jev model is a problem");
  assert.equal(existsSync(join(root, "data/recommender/ratings-jev.json")), false);

  const jevPath = stage(root, batch, textlessResults(batch, "jev-1.13.0"), { reserve: false });
  const merged = runMerge({ resultsPath: jevPath, root, now: NOW, into: "ratings-jev.json" });
  assert.deepEqual(merged.problems, []);
  assert.equal(merged.ok, true);
  const side = readJson(join(root, "data/recommender/ratings-jev.json"));
  assert.equal(side.shows["curated-show"].top_reason, "");
  assert.equal(side.shows["1000000001"].top_reason, "");
});

test("jev- results merge only --into their own ratings and progress files", (t) => {
  // mutation: drop the `metadata_only_into_gold` refusal -> the jev ratings land in ratings.json
  // mutation: `const progressPath = join(root, PROGRESS_PATH);` (ignore --into) -> the Claude pass 1 record refuses the merge (pass_already_rated)
  // mutation: `const tier = fromPack;` for every model -> the transcript pack's show is recorded as transcript though Jev never saw the windows
  const root = makeRoot(t);
  const batch = batchDoc(root);
  const results = textlessResults(batch, "jev-1.13.0");
  const curated = results.results["curated-show"];
  curated.evidence_tier = "episode-metadata";
  curated.host_count = null;
  for (const r of Object.values(curated.personas)) Object.assign(r, { host_style: null, production: null, ad_load: null, confidence: 0.6 });
  const resultsPath = stage(root, batch, results, { reserve: false });

  // The gold shows already carry a Claude pass 1 in the main progress file.
  const mainProgress = { in_flight: {}, rated: Object.fromEntries(KEYS.map((k) => [k, { last_batch_id: "claude-batch", passes: [1] }])) };
  writeJson(join(root, PROGRESS_PATH), mainProgress);
  const mainBefore = readFileSync(join(root, PROGRESS_PATH), "utf8");
  const sideProgressPath = join(root, "data/recommender/rating-progress-jev.json");
  writeJson(sideProgressPath, { in_flight: Object.fromEntries(KEYS.map((k) => [k, { batch_id: batch.batch_id, reserved_at: NOW.toISOString() }])), rated: {} });

  const gold = runMerge({ resultsPath, root, now: NOW });
  assert.equal(gold.ok, false);
  assert.deepEqual(gold.problems.map((p) => p.code), ["metadata_only_into_gold"]);
  assert.equal(existsSync(join(root, RATINGS_PATH)), false, "ratings.json untouched");

  const side = runMerge({ resultsPath, root, now: NOW, into: "ratings-jev.json" });
  assert.deepEqual(side.problems, []);
  assert.equal(side.ok, true);
  assert.equal(side.report.released, 3);
  const ratings = readJson(join(root, "data/recommender/ratings-jev.json"));
  assert.equal(ratings.shows["curated-show"].evidence_tier, "episode-metadata", "the weaker declared tier wins for a metadata-only rater");
  assert.deepEqual(ratings.shows["curated-show"].personas["p-history"].slice(6), [null, null, null, 0.6]);
  assert.equal(readFileSync(join(root, PROGRESS_PATH), "utf8"), mainBefore, "the Claude progress file is untouched");
  const sideProgress = readJson(sideProgressPath);
  assert.deepEqual(sideProgress.in_flight, {});
  for (const k of KEYS) assert.deepEqual(sideProgress.rated[k].passes, [1]);

  assert.equal(main(["--results", resultsPath, "--into", "ratings-isolated.json"], { root, now: NOW, log: () => {}, out: () => {} }), 2, "another writer's file is refused");
  assert.equal(main(["--check", "--into", "ratings-jev.json"], { root, now: NOW, log: () => {}, out: () => {} }), 2);
});
