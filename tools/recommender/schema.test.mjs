/* tools/recommender/schema.mjs: the three file shapes of the persona-rating
   pipeline (RV-02, docs/roadmap/recommender-v1.md D7, D8, D10).

   Every test names the one-line mutation of schema.mjs (or of the rubric) that
   turns it red; each was run red before this suite was committed. The fixture
   is built fresh per test (validResults()), so no test inherits another's
   edits, and it carries BOTH tiers that matter: a transcript show (audio
   scores allowed) and a show-metadata show (audio scores null, confidence
   capped at 0.5). A fixture with only transcript shows could never reach the
   tier branches these tests exist to pin. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RUBRIC_VERSION,
  RATING_SLOTS,
  MAX_REASON_CHARS,
  capConfidence,
  nullAudioScoresUnlessTranscript,
  reasonCopyProblems,
  schemaForShow,
  validateClientFile,
  validateRatingsFile,
  validateResultsFile,
} from "./schema.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PERSONAS = ["p-history", "p-light"];
const SHOWS = ["curated-show", "1000000001"];
const ctx = { personaIds: PERSONAS, showKeys: SHOWS };
const FLAGS_OFF = { explicit: false, harassment: false, medical_financial_advice: false, injection_suspected: false };

function rating(over = {}) {
  return {
    fit: 4, return_prob: 0.6, topic_fit: 4, depth: 3, accessibility: 4, binge_vs_dip: 5,
    host_style: null, production: null, ad_load: null, confidence: 0.4,
    reason: "Plain answers to kitchen questions, one caller at a time.",
    ...over,
  };
}

function validResults() {
  return {
    batch_id: "pilot-1-joint-2026-10-14-abcd1234",
    rubric_version: RUBRIC_VERSION,
    model: "claude-sonnet",
    mode: "joint",
    pass: 1,
    rated_at: "2026-10-14T12:00:00.000Z",
    results: {
      "curated-show": {
        evidence_tier: "transcript",
        summary: "Two historians retell one battle per episode.",
        format: "narrative",
        host_count: 2,
        flags: { ...FLAGS_OFF },
        not_rated_because: null,
        personas: {
          "p-history": rating({ fit: 5, host_style: 4, production: 4, ad_load: 3, confidence: 0.9, reason: "Battles told from the letters of the people in them." }),
          "p-light": rating({ fit: 2, host_style: 3, production: 4, ad_load: 3, confidence: 0.8, reason: "Heavy going without the background it assumes." }),
        },
      },
      "1000000001": {
        evidence_tier: "show-metadata",
        summary: "A weekly call-in cooking show.",
        format: "panel",
        host_count: null,
        flags: { ...FLAGS_OFF },
        not_rated_because: null,
        personas: { "p-history": rating({ fit: 2 }), "p-light": rating() },
      },
    },
  };
}

const codes = (problems) => problems.map((p) => p.code);

test("a valid joint results file passes", () => {
  /* MUTATION (run red): in checkResultShow, require a key the file does not
     carry -- `for (const k of [...RESULTS_SHOW_KEYS, "notes"])` -- and the
     valid file gains a missing_field problem. Also pins the isolated shape:
     one persona per show is valid in `isolated:<id>` mode. */
  assert.deepEqual(validateResultsFile(validResults(), ctx), []);
  const iso = validResults();
  iso.mode = "isolated:p-light";
  for (const s of Object.values(iso.results)) delete s.personas["p-history"];
  assert.deepEqual(validateResultsFile(iso, ctx), []);
});

test("an unknown persona id is refused", () => {
  /* MUTATION (run red): `if (!expectedPersonas.has(pid))` -> `if (false)` --
     the stray persona is accepted. */
  const doc = validResults();
  doc.results["1000000001"].personas["p-made-up"] = rating();
  assert.ok(codes(validateResultsFile(doc, ctx)).includes("unknown_persona"));
});

test("an unknown show key is refused", () => {
  /* MUTATION (run red): `if (!keys.has(key))` -> `if (false)` -- a show the
     batch never asked about is accepted. */
  const doc = validResults();
  doc.results["999"] = structuredClone(doc.results["1000000001"]);
  assert.ok(codes(validateResultsFile(doc, ctx)).includes("unknown_show"));
});

test("audio sub-scores on a non-transcript show are refused", () => {
  /* MUTATION (run red): in checkAudio, drop the tier branch
     (`if (tier !== "transcript" && v !== null)` -> `if (false)`) -- host_style
     4 on a show-metadata show is accepted. The transcript show in the same
     fixture carries audio scores and must stay clean, so a mutation that
     refuses audio scores everywhere fails too. */
  const doc = validResults();
  doc.results["1000000001"].personas["p-light"].host_style = 4;
  const problems = validateResultsFile(doc, ctx);
  assert.deepEqual(problems.map((p) => [p.code, p.at]), [["audio_score_without_transcript", "results.1000000001.personas.p-light.host_style"]]);
  const fixed = nullAudioScoresUnlessTranscript(doc.results["1000000001"].personas["p-light"], "show-metadata");
  assert.equal(fixed.host_style, null);
  assert.equal(doc.results["1000000001"].personas["p-light"].host_style, 4, "the normaliser does not mutate its input");
  assert.equal(nullAudioScoresUnlessTranscript(rating({ host_style: 4 }), "transcript").host_style, 4);
});

test("confidence above the tier cap is refused", () => {
  /* MUTATION (run red): `CONFIDENCE_CAP = { "show-metadata": 1,
     "episode-metadata": 1, transcript: 1 }` -- 0.9 on a show-metadata show is
     accepted and capConfidence returns 0.9. */
  const doc = validResults();
  doc.results["1000000001"].personas["p-light"].confidence = 0.9;
  assert.ok(codes(validateResultsFile(doc, ctx)).includes("confidence_above_cap"));
  assert.equal(capConfidence(0.9, "show-metadata"), 0.5);
  assert.equal(capConfidence(0.9, "episode-metadata"), 0.7);
  assert.equal(capConfidence(0.9, "transcript"), 0.9);
  assert.equal(capConfidence(0.9, "none"), 0);
});

test("a 201-char reason is refused", () => {
  /* MUTATION (run red): `MAX_REASON_CHARS = 1000` -- 201 characters pass. */
  assert.equal(MAX_REASON_CHARS, 200);
  const doc = validResults();
  doc.results["1000000001"].personas["p-light"].reason = "a".repeat(200);
  assert.deepEqual(validateResultsFile(doc, ctx), [], "exactly 200 is allowed");
  doc.results["1000000001"].personas["p-light"].reason = "a".repeat(201);
  assert.ok(codes(validateResultsFile(doc, ctx)).includes("reason_too_long"));
});

test("a reason with a BANNED word is refused", () => {
  /* MUTATION (run red): in checkReason, drop the reasonCopyProblems loop --
     every case below is accepted. Covers BANNED, INTERNAL_VOCABULARY,
     COMMUTE_FRAMING and the rubric's "This podcast" opener. */
  const cases = [
    ["A fascinating look at kitchen chemistry.", "reason_banned_word"],
    ["A deep dive into braising.", "reason_banned_word"],
    ["Told in eight beats across a season.", "reason_internal_vocabulary"],
    ["Fits a morning commute.", "reason_commute_framing"],
    ["This podcast answers cooking questions.", "reason_show_opener"],
  ];
  for (const [text, code] of cases) {
    const doc = validResults();
    doc.results["1000000001"].personas["p-light"].reason = text;
    assert.ok(codes(validateResultsFile(doc, ctx)).includes(code), `${JSON.stringify(text)} should raise ${code}`);
  }
});

test("trip, journey and ride in the time-fit sense are commute framing", () => {
  /* MUTATION (run red): in reasonCopyProblems, drop
     `|| TRIP_FIT_FRAMING.some(...)` -- every case below is accepted, as the
     RV-13 pilot's four were. The first four are the pilot's own reasons
     (docs/research/persona-ratings-pilot-2026-10.md). */
  const cases = [
    "Clear and easy, but far shorter than a full trip, so it works as filler.",
    "At four minutes it is a snack rather than a full trip.",
    "Some two-part specials are too long for one trip.",
    "Episodes of 75 minutes and up are long for a family trip.",
    "Light enough to have on for the ride.",
    "Episodes run long; a long ride at least.",
    "Each episode is about a 30-minute ride.",
    "An hour-long journey per episode.",
    "Trip-length chapters with a clean ending.",
    "Fits a short trip almost exactly.",
    "A trip's worth of stories in every episode.",
    "Easy company for the morning ride.",
    "Light enough for the ride home.",
  ];
  for (const text of cases) assert.deepEqual(reasonCopyProblems(text), ["reason_commute_framing"], JSON.stringify(text));
  const doc = validResults();
  doc.results["1000000001"].personas["p-light"].reason = cases[3];
  assert.ok(codes(validateResultsFile(doc, ctx)).includes("reason_commute_framing"), "the results validator refuses it too");
});

test("trip, journey and ride as a topic are not commute framing", () => {
  /* MUTATION (run red): TRIP_FIT_FRAMING = [/\b(?:trip|journey|ride)s?\b/i]
     (ban the words outright) -- every case below is refused. The first eight
     are reasons the RV-13 pilot wrote. */
  const cases = [
    "Mostly career biography and personal journey, with little on how things work.",
    "Founder journeys told as interviews rather than produced narrative.",
    "Weekly park trip reports of an hour or more, with no news cadence.",
    "Trip ideas and places to stay have planning value.",
    "One episode centres on a bad trip and a struggle with mental health.",
    "The notes read as park reviews, not ride engineering.",
    "Short destination episodes, mostly aimed at adults planning trips.",
    "Coaster models and ride manufacturers come up by name.",
    "Two friends plan a trip to Japan, one city per episode.",
    "Road trip stories from small towns, told by the people who live there.",
    "A long trip across the Sahara, retold from the diaries.",
    "One host's whole journey through grief, told gently.",
    "Admissions advice on landing a full ride scholarship.",
  ];
  for (const text of cases) assert.deepEqual(reasonCopyProblems(text), [], JSON.stringify(text));
});

test("isolated mode requires exactly the isolated persona", () => {
  /* MUTATION (run red): in the isolated branch, `expected = new Set([pid])`
     -> `expected = personas` -- a correct isolated file is refused for the
     personas it was never asked to rate (missing_persona). And an isolated
     file that rates a second persona is refused. */
  const doc = validResults();
  doc.mode = "isolated:p-history";
  for (const s of Object.values(doc.results)) delete s.personas["p-light"];
  assert.deepEqual(validateResultsFile(doc, ctx), []);
  doc.results["1000000001"].personas["p-light"] = rating();
  assert.ok(codes(validateResultsFile(doc, ctx)).includes("unknown_persona"));
});

test("an unrated show carries no ratings, and a show with no evidence is never rated", () => {
  /* MUTATION (run red): drop the `if (tier === "none") add("rated_without_evidence", ...)`
     line -- a tier-none show with persona ratings is accepted (D4: title-only
     rows get no rating). */
  const doc = validResults();
  doc.results["1000000001"] = {
    evidence_tier: "none", summary: null, format: null, host_count: null,
    flags: { ...FLAGS_OFF }, not_rated_because: "the evidence pack is empty", personas: null,
  };
  assert.deepEqual(validateResultsFile(doc, ctx), []);
  const rated = validResults();
  rated.results["1000000001"].evidence_tier = "none";
  rated.results["1000000001"].personas["p-light"].confidence = 0;
  rated.results["1000000001"].personas["p-history"].confidence = 0;
  assert.ok(codes(validateResultsFile(rated, ctx)).includes("rated_without_evidence"));
});

test("a field the raters must never carry (chart_rank) is refused", () => {
  /* MUTATION (run red): in checkResultShow, drop the
     `unknownKeys(s, RESULTS_SHOW_KEYS, at, add)` line -- chart_rank rides into
     the merge (D7). */
  const doc = validResults();
  doc.results["1000000001"].chart_rank = 12;
  const problems = validateResultsFile(doc, ctx);
  assert.deepEqual(problems.map((p) => [p.code, p.at]), [["unknown_field", "results.1000000001.chart_rank"]]);
});

test("the rubric's worked example validates", () => {
  /* MUTATION (run red): rename `"reason"` to `"why"` in one persona of the
     worked example in docs/curation/rating-rubric-v1.md (or set its
     rubric_version to 2) -- the prose and the code have drifted apart. */
  const md = readFileSync(join(ROOT, "docs", "curation", "rating-rubric-v1.md"), "utf8");
  const section = md.slice(md.indexOf("## Worked example"));
  const m = section.match(/```json\r?\n([\s\S]*?)\r?\n```/);
  assert.ok(m, "the rubric has a ```json worked example");
  const doc = JSON.parse(m[1]);
  const personaIds = [...new Set(Object.values(doc.results).flatMap((s) => Object.keys(s.personas || {})))];
  assert.equal(personaIds.length, 2);
  assert.deepEqual(validateResultsFile(doc, { personaIds, showKeys: Object.keys(doc.results) }), []);
});

test("ratings arrays have exactly 10 slots", () => {
  /* MUTATION (run red): in checkRatingArray, drop
     `|| arr.length !== RATING_SLOTS.length` -- a 9-slot array is accepted.
     Also pins the merge's skeleton (RV-09: built_at null, merged_batches []). */
  assert.equal(RATING_SLOTS.length, 10);
  assert.deepEqual(validateRatingsFile({ version: 1, rubric_version: 1, built_at: null, merged_batches: [], shows: {} }), []);
  const doc = {
    version: 1, rubric_version: 1, built_at: "2026-10-14T12:00:00.000Z", merged_batches: ["b1"],
    shows: {
      "1000000001": {
        evidence_tier: "show-metadata", summary: "A weekly call-in cooking show.", format: "panel",
        flags: { ...FLAGS_OFF }, top_reason: "Plain answers to kitchen questions.", top_persona: "p-light", passes: 2,
        personas: { "p-light": [3.5, 0.4, 3, 2, 5, 5, null, null, null, 0.4], "p-history": [2, 0.1, 1, 2, 5, 5, null, null, null, 0.3] },
      },
    },
  };
  assert.deepEqual(validateRatingsFile(doc, { personaIds: PERSONAS }), []);
  doc.shows["1000000001"].personas["p-light"] = [3.5, 0.4, 3, 2, 5, 5, null, null, 0.4];
  assert.ok(codes(validateRatingsFile(doc)).includes("bad_rating_array"));
});

test("the client file's f string has one digit per persona", () => {
  /* MUTATION (run red): in validateClientFile, drop the
     `else if (personasOk && s.f.length !== personas.length)` branch -- a
     two-digit f for three personas is accepted. */
  const doc = { version: 1, personas: ["a", "b", "c"], shows: { "curated-show": { f: "503", x: 0, t: "t" } } };
  assert.deepEqual(validateClientFile(doc), []);
  doc.shows["curated-show"].f = "50";
  assert.ok(codes(validateClientFile(doc)).includes("fit_string_length"));
  doc.shows["curated-show"] = { f: "503", x: 1, t: "s", chart_rank: 3 };
  assert.ok(codes(validateClientFile(doc)).includes("unknown_field"), "nothing beyond f, x and t reaches the client");
});

test("schemaForShow lists exactly the given persona ids as required", () => {
  /* RV-20. MUTATION (run red): in schemaForShow, set the personas object's
     `required: []` -- a strict json_schema reply could then leave a persona
     out and the grammar would allow it. Also pins that the schema is built
     from the same field lists the validator checks (a show entry of the
     fixture has exactly the schema's required keys), and the tier rules. */
  const ids = ["p-light", "p-history"];
  const schema = schemaForShow(ids, { tier: "show-metadata" });
  const personas = schema.properties.personas;
  assert.deepEqual(personas.required, ids);
  assert.deepEqual(Object.keys(personas.properties), ids);
  assert.equal(personas.additionalProperties, false);
  assert.equal(schema.additionalProperties, false);
  const show = validResults().results["1000000001"];
  assert.deepEqual([...schema.required].sort(), Object.keys(show).sort());
  const rating = personas.properties["p-light"];
  assert.deepEqual([...rating.required].sort(), Object.keys(show.personas["p-light"]).sort());
  assert.equal(rating.additionalProperties, false);
  assert.equal(rating.properties.reason.maxLength, MAX_REASON_CHARS);
  // show-metadata: no audio score, no host count, confidence capped at 0.5.
  assert.deepEqual(rating.properties.host_style, { type: "null" });
  assert.deepEqual(schema.properties.host_count, { type: "null" });
  assert.equal(rating.properties.confidence.maximum, 0.5);
  // transcript: audio scores allowed (or null), confidence up to 1.
  const t = schemaForShow(["p-history"], { tier: "transcript" }).properties.personas;
  assert.deepEqual(t.required, ["p-history"]);
  assert.deepEqual(t.properties["p-history"].properties.ad_load.type, ["integer", "null"]);
  assert.equal(t.properties["p-history"].properties.confidence.maximum, 1);
});
