/* The three file shapes of the persona-rating pipeline, defined once (RV-02).

   docs/roadmap/recommender-v1.md D10: this module is the ONLY definition of
     1. the results file an agent writes for one batch
        (data-local/recommender/results/rating-results-<batch_id>.json),
     2. data/recommender/ratings.json, the merged gold ratings, and
     3. data/recommender/ratings-client.json, the client projection.
   The Claude, Qwen and Jev rater paths, the merge, the student and the client
   builder all validate against these functions, so every path produces and
   consumes the same bytes. The rubric the raters follow is
   docs/curation/rating-rubric-v1.md; its worked example is validated by
   schema.test.mjs, so the prose and this file cannot drift apart.

   Pure: no I/O, no model call, no network. Every validator returns a list of
   problems `{ code, at, message }` and never throws on bad input; an empty
   list means the document is valid. `code` is a stable snake_case token the
   merge reports and the tests assert on; `at` is a dotted path into the
   document.

   Strict about keys: an unknown field anywhere is a problem
   (`unknown_field`). That is deliberate. D7 says raters never see chart rank,
   download counts, the network or `in_curated`; a field this file does not
   name cannot ride along into data/ and from there to the client. */

import copyRules from "../../backend/src/copy/rules.js";

const { BANNED, INTERNAL_VOCABULARY, COMMUTE_FRAMING } = copyRules;

export const RUBRIC_VERSION = 1;

/** Ordered strongest evidence first. `none` (a title-only shows-index row, D4)
    gets no rating: it may appear in a results file only with
    `not_rated_because`, and never in ratings.json. */
export const EVIDENCE_TIERS = ["transcript", "episode-metadata", "show-metadata", "none"];

/** The sub-scores that need audio evidence: null unless the tier is
    `transcript` (D3). */
export const AUDIO_SUBSCORES = ["host_style", "production", "ad_load"];

/** Every 1-5 sub-score, in the order of the ratings.json slot array. */
export const SUBSCORES = ["topic_fit", "depth", "accessibility", "binge_vs_dip", ...AUDIO_SUBSCORES];

export const FLAGS = ["explicit", "harassment", "medical_financial_advice", "injection_suspected"];

export const FORMATS = ["interview", "monologue", "panel", "narrative", "news", "mixed"];

/** Highest confidence a rating may claim at each tier (D3). `none` carries no
    rating, so it has no cap of its own; `capConfidence` caps it at 0. */
export const CONFIDENCE_CAP = { "show-metadata": 0.5, "episode-metadata": 0.7, transcript: 1 };

export const MAX_REASON_CHARS = 200;
export const MAX_SUMMARY_CHARS = 200;

/** The ten slots of one persona's rating in ratings.json, in order (D8: arrays,
    not objects, to hold the size). */
export const RATING_SLOTS = ["fit", "return_prob", ...SUBSCORES, "confidence"];

/** One persona's rating in a results file. */
export const PERSONA_RATING_FIELDS = ["fit", "return_prob", ...SUBSCORES, "confidence", "reason"];

/** The client file's one-letter tier code. */
export const CLIENT_TIER_CODES = { transcript: "t", "episode-metadata": "e", "show-metadata": "s" };

/** RV-30: the tier code of a breadth row rated by the teacher (ratings-breadth.json). */
export const CLIENT_BREADTH_TIER_CODE = "b";

/** The highest pass the three-pass design (D13) ever writes. */
export const MAX_PASS = 3;

const RESULTS_TOP_KEYS = ["batch_id", "rubric_version", "model", "mode", "pass", "rated_at", "results", "profiles_sha256"];
const RESULTS_SHOW_KEYS = ["evidence_tier", "summary", "format", "host_count", "flags", "not_rated_because", "personas"];
const RATINGS_TOP_KEYS = ["version", "rubric_version", "built_at", "merged_batches", "shows"];
const RATINGS_SHOW_KEYS = ["evidence_tier", "summary", "format", "flags", "top_reason", "top_persona", "passes", "personas"];
const CLIENT_TOP_KEYS = ["version", "personas", "shows"];
const CLIENT_SHOW_KEYS = ["f", "x", "t"];

/** The key a show is rated under: `show_id` for a curated row
    (data/catalog.json), `String(apple_collection_id)` for a breadth row
    (data/catalog-breadth.json). Null when the row has neither. */
export function showKey(row) {
  if (row && typeof row.show_id === "string" && row.show_id.length > 0) return row.show_id;
  if (row && row.apple_collection_id != null && String(row.apple_collection_id).length > 0) {
    return String(row.apple_collection_id);
  }
  return null;
}

/* ---------- normalisers (the merge applies both, RV-09) ---------- */

/** A copy of one persona's rating with the audio sub-scores nulled unless the
    show's evidence is a transcript. Never mutates its input. */
export function nullAudioScoresUnlessTranscript(personaRating, tier) {
  const out = { ...personaRating };
  if (tier !== "transcript") for (const k of AUDIO_SUBSCORES) out[k] = null;
  return out;
}

/** `value` capped at the tier's ceiling (and floored at 0). A tier with no
    cap (`none`, or anything unknown) carries no confidence at all: 0. */
export function capConfidence(value, tier) {
  const cap = Object.prototype.hasOwnProperty.call(CONFIDENCE_CAP, tier) ? CONFIDENCE_CAP[tier] : 0;
  return Math.max(0, Math.min(Number(value), cap));
}

/* ---------- the per-show reply schema of a direct-model rater (RV-20) ---------- */

/** The JSON Schema of ONE show's entry in a results file (`results.<show_key>`),
    for a rater that answers one show per call through an OpenAI-compatible
    `response_format: { type: "json_schema", strict: true }` (the dormant Qwen
    path, qwen-rate.mjs). Generated from the constants above so it cannot drift
    from `validateResultsFile`; strict mode wants every property required and
    no other allowed, so optional values are typed nullable instead.

    `personas` lists exactly `personaIds`, each required (in the order given),
    and nothing else. With `tier`, the schema also carries the tier's rules:
    the audio sub-scores and `host_count` are typed null unless the tier is
    `transcript`, and `confidence` is capped at the tier's ceiling. A grammar
    that honours the schema then cannot emit what the validator refuses; the
    caller still validates every reply, because a server may drop the schema
    (llm.mjs header). `personas` and the per-show texts are nullable so the
    rater can decline a show with `not_rated_because`, as an agent may. */
export function schemaForShow(personaIds, { tier = null } = {}) {
  const ids = [...new Set(Array.from(personaIds ?? [], String))];
  const transcript = tier === "transcript";
  const cap = Object.prototype.hasOwnProperty.call(CONFIDENCE_CAP, tier) ? CONFIDENCE_CAP[tier] : 1;
  const score = { type: "integer", minimum: 1, maximum: 5 };
  const audio = transcript ? { type: ["integer", "null"], minimum: 1, maximum: 5 } : { type: "null" };
  const unit = { type: "number", minimum: 0, maximum: 1 };
  const ratingProps = {
    fit: score,
    return_prob: unit,
    ...Object.fromEntries(SUBSCORES.map((k) => [k, AUDIO_SUBSCORES.includes(k) ? audio : score])),
    confidence: { type: "number", minimum: 0, maximum: cap },
    reason: { type: "string", minLength: 1, maxLength: MAX_REASON_CHARS },
  };
  const rating = { type: "object", additionalProperties: false, required: [...PERSONA_RATING_FIELDS], properties: ratingProps };
  return {
    type: "object",
    additionalProperties: false,
    required: [...RESULTS_SHOW_KEYS],
    properties: {
      evidence_tier: { type: "string", enum: [...EVIDENCE_TIERS] },
      summary: { type: ["string", "null"], maxLength: MAX_SUMMARY_CHARS },
      format: { type: ["string", "null"], enum: [...FORMATS, null] },
      host_count: transcript ? { type: ["integer", "null"], minimum: 1, maximum: 50 } : { type: "null" },
      flags: {
        type: "object",
        additionalProperties: false,
        required: [...FLAGS],
        properties: Object.fromEntries(FLAGS.map((f) => [f, { type: "boolean" }])),
      },
      not_rated_because: { type: ["string", "null"] },
      personas: {
        type: ["object", "null"],
        additionalProperties: false,
        required: ids,
        properties: Object.fromEntries(ids.map((id) => [id, rating])),
      },
    },
  };
}

/* ---------- copy check on the listener-facing reason ---------- */

/* Trip-length framing: the commute ban said another way. The RV-13 pilot's
   raters, told never to write "commute" or "drive", wrote "far shorter than a
   full trip", "long for a family trip" and "too long for one trip"
   (docs/research/persona-ratings-pilot-2026-10.md). "trip", "journey" and
   "ride" are plain English in a reason far more often ("park trip reports",
   "a personal journey", "a trip to Japan", "ride manufacturers", "a bad
   trip"), so, like COMMUTE_FRAMING, these match only the time-fit shapes: a
   length word on the trip ("a full trip", "a long ride", "an hour-long trip",
   "trip-length"; never "a whole journey", which is a founder's or a
   grief's), a trip the episode is measured against ("long for a family
   trip", "for one trip", "for the ride", "fits a short trip", "a trip's
   worth"), and the listener's own trip ("the morning ride", "the ride home").
   A trip followed by where it goes or what it is about ("a long trip to
   Japan", "a full journey through grief", "trip reports") is a topic and
   passes. Recommender-only: backend/src/copy/rules.js's lists also gate
   Foray copy and discover hooks, which this pilot finding says nothing
   about. */
const TRIP = "(?:trips?|journeys?|rides?)";
const TRIP_TOPIC = "(?!\\s+(?:to|of|from|through|across|into|around|abroad|with|reports?|stories|ideas|planning|talk|scholarships?)\\b)";
const LENGTH = "(?:long|longer|short|shorter|brief|quick|lengthy)";
const POINTER = "(?:a|an|one|the|your|any|every|each|most|a single)";
export const TRIP_FIT_FRAMING = [
  new RegExp(`\\b(?:full|whole|entire|single|average|typical)[ -](?:trips?|rides?)\\b${TRIP_TOPIC}`, "i"),
  new RegExp(`\\b(?:for|than|in|on|over) (?:one|a single)[ -]${TRIP}\\b${TRIP_TOPIC}`, "i"),
  new RegExp(`\\b${LENGTH}\\b[^.;:!?]{0,30}?\\bfor ${POINTER}(?: [a-z-]+){0,2} ${TRIP}\\b${TRIP_TOPIC}`, "i"),
  new RegExp(`\\bfor the (?:whole |entire |full |long )?${TRIP}\\b${TRIP_TOPIC}`, "i"),
  new RegExp(`\\b${LENGTH}(?: car| bus| train)? (?:trips?|rides?)\\b${TRIP_TOPIC}`, "i"),
  new RegExp(`\\b(?:minute|min|hour)s?(?:[ -]long)?[ -]${TRIP}\\b${TRIP_TOPIC}`, "i"),
  new RegExp(`\\b(?:fits?|fitting|fills?|filling|lasts?|outlasts?)(?: ${POINTER})?(?: [a-z-]+)? ${TRIP}\\b${TRIP_TOPIC}`, "i"),
  /\b(?:trip|journey|ride)(?:['’]s|s['’]?)? worth\b/i,
  new RegExp(`\\b(?:trip|journey|ride)[ -](?:length|sized?|companion|filler|listen|listening)s?\\b`, "i"),
  new RegExp(`\\b(?:today'?s|tomorrow'?s|tonight'?s|(?:the|a|your|this) (?:morning|evening|afternoon|school)) ${TRIP}\\b`, "i"),
  /\bride (?:home|to work|to school)\b|\b(?:trip|journey) to (?:work|school)\b/i,
];

/** The copy problems in a listener-facing reason, as codes. The same lists the
    classify merge and the Foray gates use (backend/src/copy/rules.js), plus
    the rubric's own "no 'This podcast' opener" rule and TRIP_FIT_FRAMING
    above (reported as commute framing, which it is). */
export function reasonCopyProblems(text) {
  const out = [];
  if (BANNED.some((rx) => rx.test(text))) out.push("reason_banned_word");
  if (INTERNAL_VOCABULARY.some((rx) => rx.test(text))) out.push("reason_internal_vocabulary");
  if (COMMUTE_FRAMING.some((rx) => rx.test(text)) || TRIP_FIT_FRAMING.some((rx) => rx.test(text))) out.push("reason_commute_framing");
  if (/^\s*(?:this|the) (?:podcast|show)\b/i.test(text)) out.push("reason_show_opener");
  return out;
}

/* ---------- small checks ---------- */

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isNum = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const isIsoDate = (v) => typeof v === "string" && v.length >= 10 && !Number.isNaN(Date.parse(v));
const toSet = (v) => (v instanceof Set ? v : new Set(Array.isArray(v) ? v : []));

function problemList() {
  const problems = [];
  const add = (code, at, message) => problems.push({ code, at, message: message || code });
  return { problems, add };
}

function unknownKeys(obj, allowed, at, add) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) add("unknown_field", `${at}.${k}`, `${at} has an unknown field "${k}"`);
}

function checkFlags(flags, at, add) {
  if (!isObject(flags)) return add("bad_flags", at, `${at} must be an object of ${FLAGS.length} booleans`);
  unknownKeys(flags, FLAGS, at, add);
  for (const f of FLAGS) if (typeof flags[f] !== "boolean") add("bad_flag", `${at}.${f}`, `${at}.${f} must be a boolean`);
}

function checkText(v, max, at, add, code) {
  if (typeof v !== "string" || v.trim().length === 0) return add(`${code}_missing`, at, `${at} must be a non-empty string`);
  if (v.length > max) add(`${code}_too_long`, at, `${at} is ${v.length} chars, over ${max}`);
}

function checkReason(v, at, add) {
  checkText(v, MAX_REASON_CHARS, at, add, "reason");
  if (typeof v === "string") for (const code of reasonCopyProblems(v)) add(code, at, `${at} breaks the copy rules (${code}): ${JSON.stringify(v)}`);
}

/** One sub-score or the fit: an integer 1-5 in a results file (`whole`), a
    one-decimal pass mean in ratings.json. */
function checkScale(v, at, add, { whole, nullable = false }) {
  if (v === null && nullable) return;
  const ok = whole ? isInt(v, 1, 5) : isNum(v, 1, 5);
  if (!ok) add("bad_score", at, `${at} must be ${whole ? "an integer" : "a number"} 1-5${nullable ? " or null" : ""}, got ${JSON.stringify(v)}`);
}

function checkAudio(values, tier, at, add) {
  for (const [k, v] of Object.entries(values)) {
    if (tier !== "transcript" && v !== null) {
      add("audio_score_without_transcript", `${at}.${k}`, `${at}.${k} is ${JSON.stringify(v)} on a ${tier} show; audio sub-scores are null unless evidence_tier is "transcript"`);
    }
  }
}

function checkConfidence(v, tier, at, add) {
  if (!isNum(v, 0, 1)) return add("bad_confidence", at, `${at} must be a number 0-1, got ${JSON.stringify(v)}`);
  const cap = Object.prototype.hasOwnProperty.call(CONFIDENCE_CAP, tier) ? CONFIDENCE_CAP[tier] : 0;
  if (v > cap) add("confidence_above_cap", at, `${at} is ${v}, over the ${tier} cap of ${cap}`);
}

/* ---------- 1. the results file ---------- */

function checkPersonaRating(r, tier, at, add) {
  if (!isObject(r)) return add("bad_persona_rating", at, `${at} must be an object`);
  unknownKeys(r, PERSONA_RATING_FIELDS, at, add);
  for (const k of PERSONA_RATING_FIELDS) if (!(k in r)) add("missing_field", `${at}.${k}`, `${at} has no "${k}"`);
  checkScale(r.fit, `${at}.fit`, add, { whole: true });
  if (!isNum(r.return_prob, 0, 1)) add("bad_return_prob", `${at}.return_prob`, `${at}.return_prob must be a number 0-1`);
  for (const k of SUBSCORES) {
    if (!(k in r)) continue;
    checkScale(r[k], `${at}.${k}`, add, { whole: true, nullable: AUDIO_SUBSCORES.includes(k) });
  }
  checkAudio(Object.fromEntries(AUDIO_SUBSCORES.filter((k) => k in r).map((k) => [k, r[k]])), tier, at, add);
  checkConfidence(r.confidence, tier, `${at}.confidence`, add);
  checkReason(r.reason, `${at}.reason`, add);
}

function checkResultShow(s, at, expectedPersonas, add) {
  if (!isObject(s)) return add("bad_show", at, `${at} must be an object`);
  unknownKeys(s, RESULTS_SHOW_KEYS, at, add);
  for (const k of RESULTS_SHOW_KEYS) if (!(k in s)) add("missing_field", `${at}.${k}`, `${at} has no "${k}"`);
  const tier = s.evidence_tier;
  if (!EVIDENCE_TIERS.includes(tier)) add("bad_evidence_tier", `${at}.evidence_tier`, `${at}.evidence_tier must be one of ${EVIDENCE_TIERS.join(", ")}`);
  checkFlags(s.flags, `${at}.flags`, add);

  const notRated = s.not_rated_because;
  if (notRated !== null && (typeof notRated !== "string" || notRated.trim().length === 0)) {
    add("bad_not_rated_because", `${at}.not_rated_because`, `${at}.not_rated_because must be null or a non-empty string`);
  }
  if (typeof notRated === "string" && notRated.trim().length > 0) {
    /* An unrated show carries no persona ratings at all (RV-10: "null
       personas"); an empty object means the same. */
    if (!(s.personas === null || (isObject(s.personas) && Object.keys(s.personas).length === 0))) {
      add("ratings_on_unrated_show", `${at}.personas`, `${at} has not_rated_because and persona ratings; it must have neither or only the first`);
    }
    return;
  }
  if (tier === "none") add("rated_without_evidence", at, `${at} has evidence_tier "none" and no not_rated_because; a show with no evidence is never rated (D4)`);

  checkText(s.summary, MAX_SUMMARY_CHARS, `${at}.summary`, add, "summary");
  if (!FORMATS.includes(s.format)) add("bad_format", `${at}.format`, `${at}.format must be one of ${FORMATS.join(", ")}`);
  if (tier === "transcript") {
    if (!(s.host_count === null || isInt(s.host_count, 1, 50))) add("bad_host_count", `${at}.host_count`, `${at}.host_count must be a positive integer or null`);
  } else if (s.host_count !== null && s.host_count !== undefined) {
    add("host_count_without_transcript", `${at}.host_count`, `${at}.host_count is ${JSON.stringify(s.host_count)} on a ${tier} show; it is null without transcript evidence`);
  }

  if (!isObject(s.personas)) return add("bad_personas", `${at}.personas`, `${at}.personas must be an object keyed by persona id`);
  for (const [pid, r] of Object.entries(s.personas)) {
    if (!expectedPersonas.has(pid)) add("unknown_persona", `${at}.personas.${pid}`, `${at} rates "${pid}", which is not a persona this batch asked for`);
    checkPersonaRating(r, tier, `${at}.personas.${pid}`, add);
  }
  for (const pid of expectedPersonas) {
    if (!(pid in s.personas)) add("missing_persona", `${at}.personas.${pid}`, `${at} has no rating for persona "${pid}"`);
  }
}

/** Problems in one agent's results file. `personaIds` are the rating personas
    of the profiles file the batch names; `showKeys` are the keys of the shows
    in the batch. Both are required (arrays or Sets): a results file is only
    ever valid against the batch it answers. In `joint` mode every show is
    rated for every persona; in `isolated:<id>` mode for that one persona
    only. Every batch show must appear: a show the rater could not judge is
    listed with `not_rated_because`. */
export function validateResultsFile(doc, { personaIds, showKeys } = {}) {
  const { problems, add } = problemList();
  if (personaIds === undefined || showKeys === undefined) {
    add("no_batch_context", "", "validateResultsFile needs { personaIds, showKeys } from the batch it answers");
    return problems;
  }
  const personas = toSet(personaIds);
  const keys = toSet(showKeys);
  if (!isObject(doc)) {
    add("not_an_object", "", "a results file is a JSON object");
    return problems;
  }
  unknownKeys(doc, RESULTS_TOP_KEYS, "", add);
  if (typeof doc.batch_id !== "string" || doc.batch_id.trim().length === 0) add("bad_batch_id", "batch_id", "batch_id must be a non-empty string");
  if (doc.rubric_version !== RUBRIC_VERSION) add("rubric_version_mismatch", "rubric_version", `rubric_version must be ${RUBRIC_VERSION}, got ${JSON.stringify(doc.rubric_version)}`);
  if (typeof doc.model !== "string" || doc.model.trim().length === 0) add("bad_model", "model", "model must name the model that rated");
  if (!isInt(doc.pass, 1, MAX_PASS)) add("bad_pass", "pass", `pass must be 1-${MAX_PASS}`);
  if (!isIsoDate(doc.rated_at)) add("bad_rated_at", "rated_at", "rated_at must be an ISO date string");
  if ("profiles_sha256" in doc && !(typeof doc.profiles_sha256 === "string" && /^[0-9a-f]{64}$/.test(doc.profiles_sha256))) {
    add("bad_profiles_sha256", "profiles_sha256", "profiles_sha256 must be 64 lowercase hex characters");
  }

  let expected = personas;
  if (doc.mode === "joint") {
    expected = personas;
  } else if (typeof doc.mode === "string" && doc.mode.startsWith("isolated:")) {
    const pid = doc.mode.slice("isolated:".length);
    if (!personas.has(pid)) add("unknown_persona", "mode", `mode isolates "${pid}", which is not a persona this batch asked for`);
    expected = new Set([pid]);
  } else {
    add("bad_mode", "mode", `mode must be "joint" or "isolated:<persona_id>", got ${JSON.stringify(doc.mode)}`);
  }

  if (!isObject(doc.results)) {
    add("bad_results", "results", "results must be an object keyed by show key");
    return problems;
  }
  for (const [key, s] of Object.entries(doc.results)) {
    if (!keys.has(key)) add("unknown_show", `results.${key}`, `results has show "${key}", which is not in the batch`);
    checkResultShow(s, `results.${key}`, expected, add);
  }
  for (const key of keys) if (!(key in doc.results)) add("missing_show", `results.${key}`, `results has no entry for batch show "${key}"`);
  return problems;
}

/* ---------- 2. data/recommender/ratings.json ---------- */

function checkRatingArray(arr, tier, at, add) {
  if (!Array.isArray(arr) || arr.length !== RATING_SLOTS.length) {
    return add("bad_rating_array", at, `${at} must be an array of exactly ${RATING_SLOTS.length} slots (${RATING_SLOTS.join(", ")})`);
  }
  const v = Object.fromEntries(RATING_SLOTS.map((k, i) => [k, arr[i]]));
  checkScale(v.fit, `${at}[fit]`, add, { whole: false });
  if (!isNum(v.return_prob, 0, 1)) add("bad_return_prob", `${at}[return_prob]`, `${at}[return_prob] must be a number 0-1`);
  for (const k of SUBSCORES) checkScale(v[k], `${at}[${k}]`, add, { whole: false, nullable: AUDIO_SUBSCORES.includes(k) });
  checkAudio(Object.fromEntries(AUDIO_SUBSCORES.map((k) => [k, v[k]])), tier, at, add);
  checkConfidence(v.confidence, tier, `${at}[confidence]`, add);
}

/** Problems in data/recommender/ratings.json (and in ratings-isolated.json,
    which has the same shape). `personaIds`, when given, must contain every
    persona the file rates. `built_at` is null only in the never-merged
    skeleton; `merged_batches` is the merge's idempotency ledger (RV-09). */
export function validateRatingsFile(doc, { personaIds } = {}) {
  const { problems, add } = problemList();
  if (!isObject(doc)) {
    add("not_an_object", "", "ratings.json is a JSON object");
    return problems;
  }
  const known = personaIds === undefined ? null : toSet(personaIds);
  unknownKeys(doc, RATINGS_TOP_KEYS, "", add);
  if (!isInt(doc.version, 1, Number.MAX_SAFE_INTEGER)) add("bad_version", "version", "version must be a positive integer");
  if (doc.rubric_version !== RUBRIC_VERSION) add("rubric_version_mismatch", "rubric_version", `rubric_version must be ${RUBRIC_VERSION}`);
  if (!(doc.built_at === null || isIsoDate(doc.built_at))) add("bad_built_at", "built_at", "built_at must be an ISO date string or null");
  if ("merged_batches" in doc && !(Array.isArray(doc.merged_batches) && doc.merged_batches.every((b) => typeof b === "string" && b.length > 0))) {
    add("bad_merged_batches", "merged_batches", "merged_batches must be an array of batch ids");
  }
  if (!isObject(doc.shows)) {
    add("bad_shows", "shows", "shows must be an object keyed by show key");
    return problems;
  }
  for (const [key, s] of Object.entries(doc.shows)) {
    const at = `shows.${key}`;
    if (!isObject(s)) {
      add("bad_show", at, `${at} must be an object`);
      continue;
    }
    unknownKeys(s, RATINGS_SHOW_KEYS, at, add);
    const tier = s.evidence_tier;
    if (!Object.prototype.hasOwnProperty.call(CONFIDENCE_CAP, tier)) {
      add("bad_evidence_tier", `${at}.evidence_tier`, `${at}.evidence_tier must be transcript, episode-metadata or show-metadata (an unrated show is not in ratings.json)`);
    }
    checkText(s.summary, MAX_SUMMARY_CHARS, `${at}.summary`, add, "summary");
    if (!FORMATS.includes(s.format)) add("bad_format", `${at}.format`, `${at}.format must be one of ${FORMATS.join(", ")}`);
    checkFlags(s.flags, `${at}.flags`, add);
    checkReason(s.top_reason, `${at}.top_reason`, add);
    if (!isInt(s.passes, 1, MAX_PASS)) add("bad_passes", `${at}.passes`, `${at}.passes must be 1-${MAX_PASS}`);
    if (!isObject(s.personas) || Object.keys(s.personas).length === 0) {
      add("bad_personas", `${at}.personas`, `${at}.personas must be a non-empty object keyed by persona id`);
      continue;
    }
    if (!(s.top_persona in s.personas)) add("bad_top_persona", `${at}.top_persona`, `${at}.top_persona must be one of the personas the show is rated for`);
    for (const [pid, arr] of Object.entries(s.personas)) {
      if (known && !known.has(pid)) add("unknown_persona", `${at}.personas.${pid}`, `${at} rates "${pid}", which is not a rating persona`);
      checkRatingArray(arr, tier, `${at}.personas.${pid}`, add);
    }
  }
  return problems;
}

/* ---------- 3. data/recommender/ratings-client.json ---------- */

/** Problems in the client projection: `personas` is the column order and each
    show's `f` carries one fit digit per persona (0 = unrated), `x` the
    explicit flag as 0|1 and `t` the evidence tier as one letter. Nothing else
    is allowed in it (the 40 KB budget, D8, and D7's hidden fields). */
export function validateClientFile(doc) {
  const { problems, add } = problemList();
  if (!isObject(doc)) {
    add("not_an_object", "", "ratings-client.json is a JSON object");
    return problems;
  }
  unknownKeys(doc, CLIENT_TOP_KEYS, "", add);
  if (!isInt(doc.version, 1, Number.MAX_SAFE_INTEGER)) add("bad_version", "version", "version must be a positive integer");
  const personas = doc.personas;
  const personasOk = Array.isArray(personas) && personas.length > 0
    && personas.every((p) => typeof p === "string" && p.length > 0)
    && new Set(personas).size === personas.length;
  if (!personasOk) add("bad_personas", "personas", "personas must be a non-empty array of distinct persona ids");
  if (!isObject(doc.shows)) {
    add("bad_shows", "shows", "shows must be an object keyed by show id");
    return problems;
  }
  const codes = [...Object.values(CLIENT_TIER_CODES), CLIENT_BREADTH_TIER_CODE];
  for (const [key, s] of Object.entries(doc.shows)) {
    const at = `shows.${key}`;
    if (!isObject(s)) {
      add("bad_show", at, `${at} must be an object`);
      continue;
    }
    unknownKeys(s, CLIENT_SHOW_KEYS, at, add);
    if (typeof s.f !== "string" || !/^[0-5]*$/.test(s.f)) {
      add("bad_fit_string", `${at}.f`, `${at}.f must be a string of digits 0-5`);
    } else if (personasOk && s.f.length !== personas.length) {
      add("fit_string_length", `${at}.f`, `${at}.f has ${s.f.length} digits for ${personas.length} personas`);
    }
    if (s.x !== 0 && s.x !== 1) add("bad_explicit", `${at}.x`, `${at}.x must be 0 or 1`);
    if (!codes.includes(s.t)) add("bad_tier_code", `${at}.t`, `${at}.t must be one of ${codes.join(", ")}`);
  }
  return problems;
}
