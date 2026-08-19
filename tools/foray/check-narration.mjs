/* check-narration.mjs — the gate on authored narration, before anything is voiced.
 *
 * WHY THIS EXISTS
 * `check-forays.mjs` validates that a narration item has an id, a length and an
 * asset. It never reads a word of the script. That is the right split for a
 * player-facing gate and the wrong place to stop, because the failure mode this
 * product actually has is not a malformed item — it is a fluent, on-topic,
 * correctly-sized script asserting something no source says.
 * `docs/curation/narration-craft.md` §6e states it plainly: bad narration does
 * not announce itself.
 *
 * So this file gates the CURATION artifacts under
 * `docs/curation/narration/<foray_id>/`, which is where a script exists before
 * it becomes a `data/forays.json` item. Architecture, data shapes and the
 * reasoning behind every rule: `docs/curation/narration-architecture.md`.
 *
 * WHAT IT CAN AND CANNOT DO
 * It cannot tell whether a claim is true. It can tell whether the claim's
 * numbers appear inside a span somebody actually fetched, whether a claim
 * resting on nothing has been marked as resting on nothing, and whether a
 * citation has leaked into the spoken line. Those three are mechanical, and
 * they are the three that catch a model citing from memory.
 *
 * Exit 0 = clean. Exit 1 = at least one violation. Warnings never fail, the
 * same convention check-forays.mjs uses.
 *
 * Usage:
 *   node tools/foray/check-narration.mjs
 *   node tools/foray/check-narration.mjs --json
 *   node tools/foray/check-narration.mjs --root <dir>
 *   node tools/foray/check-narration.mjs --references <thread_id>
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const NARRATION_DIR = path.join("docs", "curation", "narration");

/* Inherited from player/foray-queue.js rather than re-derived. narration-craft
   §2a's 17 chars/s is the planning rate the whole cost model rests on, and a
   second copy of it here is how two documents come to disagree about money. */
export const NARRATION_CHARS_PER_SEC = 17;

/* narration-craft.md §0. Bands are in characters because characters are what a
   script actually has; the word budgets are the authored primitive and the
   seconds are a prediction about an engine nobody has run. */
export const MODE_CHAR_BANDS = {
  hinge: [50, 135],
  frame: [70, 170],
  marker: [135, 340],
  correction: [100, 205],
  patch: [340, 765],
  carry: [765, 1870],
};
export const NARRATION_SOFT_MAX_SEC = 150;
export const NARRATION_HARD_MAX_SEC = 180;
/* §2e caps CONSECUTIVE narration items at two. This schema cannot see
   consecutiveness: a thread's items[] holds only its own narration items and has
   no representation for tape items at all, so what is enforced here is a cap on
   narration items PER THREAD. On an all-empty thread the two coincide, which is
   every thread in alcohol Act I. Named for what it measures, not for what §2e says. */
export const NARRATION_ITEMS_PER_THREAD_MAX = 2;
export const NUMERIC_FACTS_PER_ITEM_MAX = 3;
export const SENTENCE_MEAN_WORDS = [12, 15];
export const SENTENCE_MAX_WORDS = 25;
export const SHORT_SENTENCE_WORDS = 6;
export const RHYTHM_TRIGGER_SEC = 20;
export const MIN_QUOTE_CHARS = 40;
export const MIN_REASONING_CHARS = 40;
export const SPANS_PER_SOURCE_WARN = 3;

export const SUPPORT_KINDS = ["quoted", "inference", "self", "blocked"];
export const LICENCES = ["claim", "attribution", "signpost", "correction", "antecedent", "head"];

/* The founder's ruling, mechanised: "It would be so terrible if the references
   were read aloud, they should all just be in some accompanying text." A
   reference is a citation apparatus — a publication, a URL, a retrieval, a
   scholarly formula. Naming the SPEAKER of adjacent tape is a different rule
   (segment-length-rules.md X2) and is deliberately not matched here. */
export const REFERENCE_LEAK_RE =
  /\bhttps?:\/\/|\bwikipedia\b|\boldid\b|\bet al\b|\baccording to\b|\bdoi\b|\bibid\b|\bop\. ?cit\b|\bas cited\b|\bcites?\b|\bcitation\b|\b\w+\.(?:com|org|net|edu|gov)\b|\bpp?\.\s*\d/i;

/* narration-craft.md §5e. Each has the grammatical shape of an attribution with
   the attribution deleted, which is how a script manufactures authority out of
   nothing while sounding careful. */
export const BANNED_HEDGES = [
  "some say",
  "it is believed",
  "many historians believe",
  "legend has it",
  "it is often said",
  "experts think",
  "some argue",
  "it is thought that",
];

/* narration-craft.md §5c's banned adjectives of significance, in full. (An earlier
   version of this comment credited §8a, which is the established-craft table, not
   the register section.) "deep dive" and "delve" come from CLAUDE.md's copy rules. */
export const BANNED_ADJECTIVES = [
  "remarkable",
  "fascinating",
  "surprising",
  "extraordinary",
  "striking",
  "deep dive",
  "delve",
];

/* narration-craft.md §5c's throat-clearing openers. Matched sentence-initially only,
   because "now" mid-sentence is ordinary English. */
export const BANNED_OPENERS = ["it turns out", "as it happens", "interestingly", "of course", "now"];

/* Spelled forms, because §5d requires numbers "written as spoken", so a `self`
   claim's spoken_number reaches the listener as a word. Without this table the
   artifact-side count and the word the listener hears are unrelated. */
export const SPELLED = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
  "eighteen", "nineteen", "twenty",
];

/* A claim whose text carries a digit is quantitative whether its author said so
   or not, and a quantitative claim is where an invented figure does its damage.
   The tier floor is inferred so an agent cannot downgrade its own claim to duck
   the numeric check. */
const DIGIT_RE = /\d+(?:[.,]\d+)?/g;
const SUPERLATIVE_RE =
  /\b(?:the (?:best|worst|first|last|oldest|largest|biggest|smallest|highest|lowest|strongest|weakest|only)\b|world'?s\s+\w+|never\b|always\b|unique\b|the most\b)/i;

const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const words = (s) => s.split(/\s+/).filter(Boolean);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Every rule that applies to a line the listener will hear, in one place.
 *
 * This is a function rather than inline code because there are two producers of
 * spoken words, not one: a beat's `sentences` (level 3) and an item's
 * `seam_sentences` (level 2, written by the parent when it merges). An earlier
 * version checked only the first, so the founder's ruling-3 leak check, the
 * digit rule and the banned lists were all absent from exactly the place a
 * parent agent writes prose.
 *
 * @param {string} text  one spoken sentence
 * @param {string} where a human-readable location for the message
 * @returns {string[]} findings, empty when clean
 */
export function spokenLineErrors(text, where, opts = {}) {
  const out = [];
  if (!isStr(text)) return [`${where}: empty text`];

  /* Ruling 3 (2026-08-19): a reference must never reach the spoken line. */
  if (REFERENCE_LEAK_RE.test(text))
    out.push(`${where}: reference apparatus in a spoken line — references live in accompanying text only`);

  /* §5d: numbers are "written as spoken". A numeral is an untested instruction
     to a TTS voice. */
  if (/\d/.test(text)) out.push(`${where}: digit in a spoken line; §5d requires numbers written as spoken`);

  const low = text.toLowerCase();
  for (const h of BANNED_HEDGES) if (low.includes(h)) out.push(`${where}: banned hedge "${h}"`);
  for (const a of BANNED_ADJECTIVES) if (low.includes(a)) out.push(`${where}: banned adjective "${a}"`);

  /* §5c's throat-clearing openers, sentence-initially only. */
  for (const o of BANNED_OPENERS) {
    if (low === o || low.startsWith(o + " ") || low.startsWith(o + ",")) {
      out.push(`${where}: §5c banned opener "${o}"`);
      break;
    }
  }

  /* §5c permits a rhetorical question only where "the tape answers immediately".
     In an item with no tape the narrator answers itself, which §5c names as a
     padding pattern. */
  if (opts.hasTape === false && /\?\s*$/.test(text.trim()))
    out.push(`${where}: rhetorical question in a beat with no tape; §5c allows one only where the tape answers it`);

  return out;
}

/** The spoken text of a beat: its sentences, joined. There is deliberately no
 *  `script` field on a beat file — a stored copy would be one edit away from
 *  disagreeing with the sentences it was derived from, and the sentences are
 *  what carry the per-sentence licence and evidence binding. */
export function beatScript(beat) {
  const sentences = beat?.sentences;
  if (!Array.isArray(sentences)) return "";
  return sentences.map((s) => s?.text ?? "").join(" ");
}

export function scriptSeconds(chars) {
  return Math.round((chars / NARRATION_CHARS_PER_SEC) * 1000) / 1000;
}

/** Every number token in a string, as written. "63-70 °C" gives ["63","70"].
 *  Comparison downstream is by substring against a fetched span, so an en-dash
 *  range in the source and a hyphen range in the claim still match on the
 *  numbers themselves — which is the part a model gets wrong. */
export function numberTokens(text) {
  return [...String(text ?? "").matchAll(DIGIT_RE)].map((m) => m[0]);
}

/** Minimum tier a claim's own text demands, regardless of what it declares. */
export function inferredTier(text) {
  const t = String(text ?? "");
  if (numberTokens(t).length > 0) return "2";
  if (SUPERLATIVE_RE.test(t)) return "2";
  return "1";
}

/** Every span a claim offers as evidence, including corroboration. */
function allSpans(claim) {
  return [...(claim?.sources ?? []), ...(claim?.corroboration ?? [])];
}

function readJson(root, rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
}

/* Malformed input must produce a finding, not a stack trace. A checker that throws
   on one bad field reports nothing about the good data beside it, and the crash is
   indistinguishable from the tool being broken. */
const arr = (v) => (Array.isArray(v) ? v : []);

function listForays(root) {
  const dir = path.join(root, NARRATION_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/** Load one Foray's three levels off disk. */
export function loadForay(root, forayId) {
  const base = path.join(NARRATION_DIR, forayId);
  let arc = null;
  let loadError = null;
  try {
    arc = readJson(root, path.join(base, "arc.json"));
  } catch (err) {
    return { forayId, arc: null, threads: [], beats: [], loadError: String(err?.message ?? err) };
  }
  const threadDir = path.join(root, base, "threads");
  const beatDir = path.join(root, base, "beats");
  const threads = fs.existsSync(threadDir)
    ? fs
        .readdirSync(threadDir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => readJson(root, path.join(base, "threads", f)))
    : [];
  const beats = fs.existsSync(beatDir)
    ? fs
        .readdirSync(beatDir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => readJson(root, path.join(base, "beats", f)))
    : [];
  return { forayId, arc, threads, beats, loadError };
}

/**
 * The gate. Pure: takes loaded artifacts, returns findings. Every rule is
 * numbered N* and every number is cited to narration-architecture.md or
 * narration-craft.md so a failing line tells the reader which doctrine it is
 * enforcing.
 */
export function checkForay(foray) {
  /* eslint-disable-next-line no-param-reassign -- normalised once, below. */
  const errors = [];
  const warnings = [];
  const at = (s) => `[${foray.forayId}] ${s}`;

  /* Drop anything that is not an object BEFORE anything indexes it, and report
     the drop. A null in beats[] used to crash the map below, which meant one bad
     entry suppressed every finding about the good entries beside it. */
  const allBeats = arr(foray?.beats);
  const beats = allBeats.filter((b) => b && typeof b === "object");
  if (beats.length !== allBeats.length)
    errors.push(at(`${allBeats.length - beats.length} entry(s) in beats[] are not objects`));
  foray = { ...foray, beats };
  const byId = new Map(beats.map((b) => [b.beat_id, b]));

  /* ---- level 3: beats ---- */
  for (const beat of foray.beats) {
    const id = beat?.beat_id ?? "(no beat_id)";
    const claims = new Map();
    for (const c of arr(beat?.claims)) {
      /* A duplicate id makes one of the two unreachable, and a Map silently keeps
         the last — so a sentence binding would resolve to evidence its author
         never wrote. */
      if (claims.has(c?.claim_id)) errors.push(at(`${id}: duplicate claim_id ${c?.claim_id}`));
      claims.set(c?.claim_id, c);
    }

    if (!isStr(beat.beat_id)) errors.push(at("a beat file has no beat_id"));
    if (!isStr(beat.thread_id)) errors.push(at(`${id}: no thread_id`));
    if (!Number.isInteger(beat.spine_beat)) errors.push(at(`${id}: spine_beat must be an integer`));
    const beatBand = MODE_CHAR_BANDS[beat?.mode];
    if (!beatBand) errors.push(at(`${id}: unknown mode "${beat?.mode}"`));
    else {
      /* §0's bands are per-BEAT budgets. They are checked here and deliberately
         NOT checked on a merged item: §2e's merge produces one item out of two
         beats, so a merged Carry legitimately exceeds the single-beat ceiling
         while staying inside the 150/180 s item maxima, which is what governs an
         item. An earlier version of this file looked the band up on the item and
         compared it to nothing, so the constant was decorative. */
      const chars = beatScript(beat).length;
      if (chars < beatBand[0] || chars > beatBand[1])
        errors.push(
          at(`${id}: ${chars} chars is outside the ${beat.mode} band ${beatBand[0]}-${beatBand[1]} (§0)`)
        );
    }
    if (!Array.isArray(beat.sentences) || beat.sentences.length === 0)
      errors.push(at(`${id}: no sentences`));
    if (!Array.isArray(beat.establishes)) errors.push(at(`${id}: establishes must be an array`));
    if (!Array.isArray(beat.assumes)) errors.push(at(`${id}: assumes must be an array`));

    /* N1 — every sentence is licensed (R1) and bound to claims that exist. */
    for (const [i, s] of arr(beat?.sentences).entries()) {
      const where = `${id} sentence ${i + 1}`;
      if (!isStr(s?.text)) errors.push(at(`${where}: empty text`));
      if (!LICENCES.includes(s?.licence))
        errors.push(at(`${where}: licence "${s?.licence}" is not one of R1's six`));
      if (!Array.isArray(s?.claims)) errors.push(at(`${where}: claims must be an array`));
      for (const cid of s?.claims ?? []) {
        if (!claims.has(cid)) errors.push(at(`${where}: cites unknown claim ${cid}`));
      }
      /* A sentence licensed as a claim that cites nothing is asserting on the
         narrator's own credit, which is the thing R3 exists to stop. */
      if (s?.licence === "claim" && (s?.claims ?? []).length === 0)
        errors.push(at(`${where}: licensed "claim" but cites no claim_id`));

      /* N7-N9 — every spoken-line rule, including ruling 3's leak check. */
      for (const e of spokenLineErrors(s?.text, where, { hasTape: beat?.coverage_verdict !== "empty" }))
        errors.push(at(e));
    }

    /* ---- claims: the evidence contract ---- */
    for (const c of arr(beat?.claims)) {
      const where = `${id} ${c?.claim_id ?? "(no claim_id)"}`;
      if (!isStr(c?.claim_id)) errors.push(at(`${id}: a claim has no claim_id`));
      if (!isStr(c?.text)) errors.push(at(`${where}: no text`));
      if (!SUPPORT_KINDS.includes(c?.support))
        errors.push(at(`${where}: support "${c?.support}" is not one of ${SUPPORT_KINDS.join("|")}`));
      if (!["1", "2"].includes(c?.tier)) errors.push(at(`${where}: tier must be "1" or "2"`));

      /* N5 — the tier floor. Declared tier may exceed the inferred one; it may
         never fall below it. `self` claims are exempt because their referent is
         the artifact set rather than the world, and N10 checks them directly. */
      const floor = inferredTier(c?.text);
      if (c?.support !== "self" && floor === "2" && c?.tier !== "2")
        errors.push(
          at(`${where}: text is quantitative or superlative, so tier 2 is the floor, not tier ${c?.tier}`)
        );
      if (c?.tier === "2" && !isStr(c?.tier_reason))
        errors.push(at(`${where}: tier 2 needs a tier_reason`));

      const spans = allSpans(c);

      if (c?.support === "quoted") {
        if (spans.length === 0) errors.push(at(`${where}: support "quoted" with no source`));
        const perSource = new Map();
        for (const [i, s] of spans.entries()) {
          const sw = `${where} source ${i + 1}`;
          for (const f of ["source_id", "kind", "publication", "work", "url", "pinned_url", "revision", "quote"]) {
            if (!isStr(s?.[f])) errors.push(at(`${sw}: missing ${f}`));
          }
          if (!ISO_DATE_RE.test(String(s?.retrieved ?? "")))
            errors.push(at(`${sw}: retrieved must be an ISO date (YYYY-MM-DD)`));
          if (isStr(s?.quote) && s.quote.trim().length < MIN_QUOTE_CHARS)
            errors.push(
              at(`${sw}: quote is ${s.quote.trim().length} chars; a span under ${MIN_QUOTE_CHARS} is not a span`)
            );
          if (isStr(s?.url) && !/^https:\/\//.test(s.url))
            errors.push(at(`${sw}: url must be https`));
          /* The two fields that make a tertiary source auditable have to agree.
             Without this, `revision` can say one thing and the permalink fetch
             another, and the "pinned" claim is decoration. */
          if (isStr(s?.pinned_url) && isStr(s?.revision) && !s.pinned_url.includes(s.revision))
            errors.push(at(`${sw}: pinned_url does not contain revision "${s.revision}"`));
          perSource.set(s?.source_id, (perSource.get(s?.source_id) ?? 0) + 1);
        }
        for (const [sid, n] of perSource) {
          if (n > SPANS_PER_SOURCE_WARN)
            warnings.push(at(`${where}: ${n} spans from ${sid}; a claim needing that many is doing too much`));
        }

        /* N6 — the anti-hallucination check, and the reason this whole file
           exists. Every number the claim asserts must appear inside a span
           somebody fetched. A citation produced from memory fails here. */
        for (const tok of numberTokens(c.text)) {
          const found = spans.some((s) => String(s?.quote ?? "").includes(tok));
          if (!found)
            errors.push(
              at(`${where}: the number "${tok}" is in the claim and in none of its fetched spans`)
            );
        }
      }

      if (c?.support === "inference") {
        if (!Array.isArray(c?.inferred_from) || c.inferred_from.length < 2)
          errors.push(at(`${where}: an inference needs at least two claims it is drawn from`));
        if (!isStr(c?.reasoning) || c.reasoning.trim().length < MIN_REASONING_CHARS)
          errors.push(at(`${where}: an inference needs written reasoning of at least ${MIN_REASONING_CHARS} chars`));
        /* An inference pointing at a claim id that does not exist is an
           unfalsifiable derivation, and renderReferences would print it as if it
           did. Ids may name a claim in ANY beat of this Foray, because an
           inference legitimately reaches upstream. */
        const known = new Set(foray.beats.flatMap((b) => arr(b?.claims).map((x) => x?.claim_id)));
        for (const src of arr(c?.inferred_from)) {
          if (!known.has(src)) errors.push(at(`${where}: inferred_from names unknown claim ${src}`));
        }
        /* A quantitative or named claim may never rest on inference. This is the
           single strictest rule in the file and it is deliberate: reasoning to a
           number is indistinguishable from inventing one. */
        if (c?.tier === "2" || floor === "2")
          errors.push(at(`${where}: a tier 2 claim may not rest on inference — it needs a fetched span`));
      }

      if (c?.support === "self") {
        if (!isStr(c?.self_check)) errors.push(at(`${where}: support "self" needs a self_check`));
        if (!Number.isInteger(c?.spoken_number) || c.spoken_number < 0)
          errors.push(at(`${where}: support "self" needs an integer spoken_number`));
        /* And the number has to be the one the listener hears. Comparing
           spoken_number to the artifacts (N10) proves nothing on its own: the
           script says the number in words, so without this the sentence could say
           "ninety-seven" while the JSON says 4 and the gate would be green. */
        const word = SPELLED[c?.spoken_number];
        const carriers = arr(beat?.sentences).filter((x) => arr(x?.claims).includes(c.claim_id));
        if (carriers.length > 0) {
          if (!isStr(word))
            errors.push(at(`${where}: spoken_number ${c?.spoken_number} has no spelled form to check against`));
          else if (!carriers.some((x) => new RegExp(`\\b${word}\\b`, "i").test(String(x?.text ?? ""))))
            errors.push(at(`${where}: no sentence citing it says "${word}" — the spoken number and the count can drift`));
        }
      }

      if (c?.support === "blocked") {
        if (c?.spoken !== false) errors.push(at(`${where}: a blocked claim must carry spoken: false`));
        if (!isStr(c?.block_reason) || c.block_reason.trim().length < MIN_REASONING_CHARS)
          errors.push(at(`${where}: a blocked claim needs a block_reason of at least ${MIN_REASONING_CHARS} chars`));
        /* N4 — and it must not be spoken anyway. */
        const cited = arr(beat?.sentences).some((s) => (s?.claims ?? []).includes(c.claim_id));
        if (cited) errors.push(at(`${where}: blocked but cited by a spoken sentence`));
      }
    }

    /* N19/N20 — numeric facts are declared, and the declaration is checked in
       both directions so an author can neither over- nor under-count them. */
    const nf = beat.numeric_facts;
    if (!Array.isArray(nf)) {
      errors.push(at(`${id}: numeric_facts must be an array (empty is fine)`));
    } else {
      for (const entry of nf) {
        const cid = String(entry ?? "").split(":")[0];
        const c = claims.get(cid);
        if (!c) errors.push(at(`${id}: numeric_facts entry "${entry}" names no claim`));
        else if (c.tier !== "2" && c.support !== "self")
          errors.push(at(`${id}: numeric_facts entry "${entry}" points at a tier 1 claim`));
      }
      for (const c of arr(beat?.claims)) {
        const spoken = arr(beat?.sentences).some((s) => (s?.claims ?? []).includes(c.claim_id));
        /* Was: a regex for the literal word "quantitative" in tier_reason, which
           made the whole cap one prose edit away from silence. A tier 2 claim
           whose text carries a digit is quantitative whatever its reason says. */
        const quantitative = c?.tier === "2" && numberTokens(c?.text).length > 0;
        if (spoken && quantitative && !nf.some((e) => String(e).startsWith(`${c.claim_id}:`)))
          errors.push(
            at(`${id}: ${c.claim_id} is spoken and quantitative but appears in no numeric_facts entry`)
          );
      }
    }

    /* N21 — §5d sentence rules, per beat. */
    const sents = arr(beat?.sentences).filter((s) => isStr(s?.text));
    if (sents.length > 0) {
      const lens = sents.map((s) => words(s.text).length);
      const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
      if (mean < SENTENCE_MEAN_WORDS[0] || mean > SENTENCE_MEAN_WORDS[1])
        errors.push(
          at(`${id}: mean sentence length ${mean.toFixed(1)} words is outside §5d's ${SENTENCE_MEAN_WORDS.join("-")}`)
        );
      const longest = Math.max(...lens);
      if (longest > SENTENCE_MAX_WORDS)
        errors.push(at(`${id}: longest sentence is ${longest} words against §5d's maximum of ${SENTENCE_MAX_WORDS}`));
      const chars = beatScript(beat).length;
      if (scriptSeconds(chars) > RHYTHM_TRIGGER_SEC && Math.min(...lens) >= SHORT_SENTENCE_WORDS)
        errors.push(
          at(`${id}: no sentence under ${SHORT_SENTENCE_WORDS} words; §5d's rhythm rule applies over ${RHYTHM_TRIGGER_SEC} s`)
        );
    }
  }

  /* ---- level 2: threads ---- */
  for (const thread of foray.threads) {
    const tid = thread.thread_id ?? "(no thread_id)";
    const mine = foray.beats
      .filter((b) => b.thread_id === thread.thread_id)
      .sort((a, b) => a.spine_beat - b.spine_beat);

    if (!isStr(thread.dot_id)) errors.push(at(`${tid}: no dot_id`));
    if (!Array.isArray(thread.start_criteria) || thread.start_criteria.length === 0)
      errors.push(at(`${tid}: a thread with no start criteria is not checkable`));
    if (!Array.isArray(thread.end_criteria) || thread.end_criteria.length === 0)
      errors.push(at(`${tid}: a thread with no end criteria is not checkable`));
    for (const c of [...arr(thread?.start_criteria), ...arr(thread?.end_criteria)]) {
      if (!isStr(c?.check))
        errors.push(at(`${tid} ${c?.id ?? "?"}: a criterion without a check is a wish`));
    }
    for (const c of arr(thread?.start_criteria)) {
      if (!["requires", "forbids"].includes(c?.polarity))
        errors.push(at(`${tid} ${c?.id ?? "?"}: start criterion needs polarity "requires" or "forbids"`));
    }
    if (!Array.isArray(thread.items) || thread.items.length === 0)
      errors.push(at(`${tid}: no items`));

    /* N22 — repetition across siblings. The defect a narrow-focus agent cannot
       see: two beats explaining the same thing. One establisher per key. */
    const establishedBy = new Map();
    for (const b of mine) {
      for (const k of arr(b?.establishes)) {
        if (establishedBy.has(k))
          errors.push(
            at(`${tid}: "${k}" is established by both ${establishedBy.get(k)} and ${b.beat_id}`)
          );
        else establishedBy.set(k, b.beat_id);
      }
    }

    /* N23 — assumed knowledge with no establisher. Every key a beat assumes is
       either established by an earlier beat anywhere in the Foray, or declared
       here as an open dependency with a "requires" criterion. A "forbids"
       criterion never satisfies an assumption. */
    const declared = new Set(
      arr(thread?.start_criteria).filter((c) => c?.polarity === "requires").map((c) => c?.key)
    );
    for (const b of mine) {
      for (const k of arr(b?.assumes)) {
        const earlier = foray.beats.some(
          (o) => o?.spine_beat < b?.spine_beat && arr(o?.establishes).includes(k)
        );
        if (!earlier && !declared.has(k))
          errors.push(
            at(`${tid}: ${b.beat_id} assumes "${k}" and nothing earlier establishes it or declares it`)
          );
      }
    }

    /* N10 — a `self` claim's spoken number is checked against the artifacts. */
    for (const b of mine) {
      for (const c of arr(b?.claims)) {
        if (c?.support !== "self") continue;
        if (c.self_check === "thread.routes.length") {
          const n = Array.isArray(thread.routes) ? thread.routes.length : null;
          if (n === null) errors.push(at(`${tid}: ${c.claim_id} checks thread.routes, which is absent`));
          else if (n !== c.spoken_number)
            errors.push(
              at(`${tid}: ${c.claim_id} speaks ${c.spoken_number} but thread.routes holds ${n}`)
            );
        } else {
          warnings.push(at(`${tid}: ${c.claim_id} has self_check "${c.self_check}", which nothing evaluates`));
        }
      }
    }

    /* ---- items: the budget, the merge and the rhythm ---- */
    const measured = [];
    for (const item of arr(thread?.items)) {
      const iw = `${tid} ${item?.item_id ?? "(no item_id)"}`;
      const beats = arr(item?.beats).map((bid) => byId.get(bid));
      if (beats.some((b) => !b)) {
        errors.push(at(`${iw}: names a beat that has no file`));
        continue;
      }
      /* Seam sentences are spoken words authored at level 2, so they carry every
         rule a beat sentence carries. */
      for (const [i, seam] of arr(item?.seam_sentences).entries()) {
        const hasTape = beats.some((b) => b?.coverage_verdict !== "empty");
        for (const e of spokenLineErrors(seam, `${iw} seam ${i + 1}`, { hasTape })) errors.push(at(e));
      }
      const chars =
        beats.map(beatScript).join(" ").length +
        arr(item?.seam_sentences).join(" ").length;
      const sec = scriptSeconds(chars);
      measured.push({ item_id: item.item_id, chars, sec, mode: item?.mode });

      if (!MODE_CHAR_BANDS[item?.mode]) errors.push(at(`${iw}: unknown mode "${item?.mode}"`));

      /* N15 — the hard max is a principle first: the narrator is never the
         longest item in the Foray (§2c). */
      if (sec > NARRATION_HARD_MAX_SEC)
        errors.push(at(`${iw}: ${sec.toFixed(1)} s is past the ${NARRATION_HARD_MAX_SEC} s hard max`));
      if (sec > NARRATION_SOFT_MAX_SEC && !(item?.needs_review === true && isStr(item?.long_reason)))
        errors.push(
          at(`${iw}: ${sec.toFixed(1)} s is past the ${NARRATION_SOFT_MAX_SEC} s soft max and needs needs_review plus a long_reason`)
        );

      /* N18 — §5d's cap, applied across the merged item rather than the beat,
         because the item is what a listener hears without a break. */
      const facts = beats.flatMap((b) => b.numeric_facts ?? []);
      if (facts.length > NUMERIC_FACTS_PER_ITEM_MAX)
        errors.push(
          at(`${iw}: ${facts.length} numeric facts against §5d's cap of ${NUMERIC_FACTS_PER_ITEM_MAX}`)
        );

      /* Every beat in the thread belongs to exactly one item, or the merge lost
         one. §2e's merge is the parent's job and this is the check on it. */
      for (const b of beats) {
        if (b.thread_id !== thread.thread_id)
          errors.push(at(`${iw}: includes ${b.beat_id}, which belongs to ${b.thread_id}`));
      }
    }
    const placedCount = new Map();
    for (const bid of arr(thread?.items).flatMap((i) => arr(i?.beats)))
      placedCount.set(bid, (placedCount.get(bid) ?? 0) + 1);
    for (const b of mine) {
      const placements = placedCount.get(b.beat_id) ?? 0;
      if (placements === 0) errors.push(at(`${tid}: ${b.beat_id} is in no item`));
      /* "Exactly one", not "at least one": a beat in two items is spoken twice. */
      else if (placements > 1)
        errors.push(at(`${tid}: ${b.beat_id} is in ${placements} items; it must be in exactly one`));
    }

    /* N16 — §2e's consecutive cap. Every item in an all-empty thread is a
       narration item, so the item count IS the consecutive count. */
    /* §2b: a narration item is a Patch, a Carry, or a Marker over 12 s. A shorter
       Marker is a transition item and must not be counted here. */
    const narrationItems = measured.filter(
      (m) => ["patch", "carry"].includes(m.mode) || (m.mode === "marker" && m.sec > 12)
    );
    if (narrationItems.length > NARRATION_ITEMS_PER_THREAD_MAX)
      errors.push(
        at(`${tid}: ${narrationItems.length} narration items against §2e's cap of ${NARRATION_ITEMS_PER_THREAD_MAX}`)
      );

    /* N17 — §2e: the second of two consecutive narration items is shorter. */
    for (let i = 1; i < measured.length; i++) {
      if (measured[i].sec >= measured[i - 1].sec)
        errors.push(
          at(
            `${tid}: ${measured[i].item_id} (${measured[i].sec.toFixed(1)} s) must be shorter than ${measured[i - 1].item_id} (${measured[i - 1].sec.toFixed(1)} s)`
          )
        );
    }
  }

  /* ---- level 1: the arc ---- */
  const threadIds = new Set(foray.threads.map((t) => t.thread_id));
  const dotIds = new Set(arr(foray.arc?.dots).map((d) => d?.dot_id));
  for (const t of foray.threads) {
    if (!dotIds.has(t.dot_id)) errors.push(at(`${t.thread_id}: dot_id "${t.dot_id}" is in no dot`));
  }
  for (const d of arr(foray.arc?.dots)) {
    if (!isStr(d?.dot)) errors.push(at(`${d?.dot_id}: a dot must be a non-empty sentence`));
    for (const built of arr(d?.built)) {
      if (!threadIds.has(built)) errors.push(at(`${d.dot_id}: names built thread "${built}" with no file`));
    }
  }
  for (const b of foray.beats) {
    if (!threadIds.has(b.thread_id))
      errors.push(at(`${b.beat_id}: thread_id "${b.thread_id}" has no thread file`));
  }

  return { errors, warnings };
}

/** The accompanying-text surface: every claim a thread speaks, with its spans.
 *  Generated, never hand-maintained, because a reference list that can drift
 *  from the script it documents is worse than none. */
export function renderReferences(foray, threadId) {
  const thread = foray.threads.find((t) => t.thread_id === threadId);
  if (!thread) throw new Error(`no thread ${threadId}`);
  const beats = foray.beats
    .filter((b) => b.thread_id === threadId)
    .sort((a, b) => a.spine_beat - b.spine_beat);
  const out = [];
  out.push(`# References — ${thread.title}`);
  out.push("");
  out.push(
    "Generated by `node tools/foray/check-narration.mjs --references " +
      threadId +
      "`. Do not edit by hand. Nothing on this page is spoken."
  );
  out.push("");
  for (const b of beats) {
    out.push(`## ${b.beat_id} — spine beat ${b.spine_beat}: ${b.spine_heading}`);
    out.push("");
    out.push("**As spoken.**");
    out.push("");
    out.push(`> ${beatScript(b)}`);
    out.push("");
    for (const s of b.sentences ?? []) {
      if ((s.claims ?? []).length === 0) continue;
      out.push(`- *"${s.text}"* — ${s.claims.join(", ")}`);
    }
    out.push("");
    out.push("**Evidence.**");
    out.push("");
    for (const c of arr(b?.claims)) {
      const spoken = (b.sentences ?? []).some((s) => (s.claims ?? []).includes(c.claim_id));
      const tag =
        c.support === "blocked"
          ? "BLOCKED, not spoken"
          : c.spoken === false
            ? "sourced, not spoken"
            : spoken
              ? `tier ${c.tier}, ${c.support}`
              : `tier ${c.tier}, ${c.support}, unbound`;
      out.push(`### ${c.claim_id} — ${tag}`);
      out.push("");
      out.push(c.text);
      out.push("");
      if (c.support === "inference")
        out.push(`Inference from ${arr(c.inferred_from).join(", ")}. ${c.reasoning ?? ""}`);
      if (c.support === "self") out.push(`Checked against the artifacts: \`${c.self_check}\`. ${c.reasoning ?? ""}`);
      if (c.support === "blocked") out.push(c.block_reason);
      if (c.spoken === false && c.not_spoken_reason) out.push(c.not_spoken_reason);
      for (const s of allSpans(c)) {
        out.push("");
        out.push(
          `- ${s.publication ?? "(no publication)"}, *${s.work}* (${s.kind}), retrieved ${s.retrieved}, revision ${s.revision} — <${s.pinned_url}>`
        );
        out.push(`  > ${s.quote}`);
      }
      out.push("");
    }
  }
  return out.join("\n") + "\n";
}

export function checkNarration(root = REPO_ROOT) {
  const errors = [];
  const warnings = [];
  const forays = listForays(root);
  if (forays.length === 0) warnings.push("no narration artifacts under " + NARRATION_DIR);
  const report = [];
  for (const id of forays) {
    const foray = loadForay(root, id);
    if (foray.loadError) {
      errors.push(`[${id}] could not be loaded: ${foray.loadError}`);
      continue;
    }
    const r = checkForay(foray);
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    /* Seam sentences are spoken, so they belong in the headline seconds too —
       otherwise the CLI total and the per-item totals are computed on different
       bases. */
    const seamChars = foray.threads
      .flatMap((t) => arr(t?.items))
      .flatMap((i) => arr(i?.seam_sentences))
      .join(" ").length;
    report.push({
      foray_id: id,
      threads: foray.threads.length,
      beats: foray.beats.length,
      narration_sec: scriptSeconds(foray.beats.map(beatScript).join(" ").length + seamChars),
    });
  }
  return { errors, warnings, report };
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  /* run-suites.mjs refuses an unrecognised flag rather than ignoring it, and a
     silently-ignored `--references=T2` is a person believing they generated a
     file they did not. Same convention here. */
  const KNOWN = new Set(["--json", "--root", "--references"]);
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("-") && !KNOWN.has(a)) {
      console.error(`unknown flag ${a} (known: ${[...KNOWN].join(", ")}); use "--flag value", not "--flag=value"`);
      process.exit(2);
    }
  }

  const rootFlag = process.argv.indexOf("--root");
  if (rootFlag >= 0 && !process.argv[rootFlag + 1]) {
    console.error("--root needs a directory");
    process.exit(2);
  }
  const root = rootFlag >= 0 ? path.resolve(process.argv[rootFlag + 1]) : REPO_ROOT;

  const refFlag = process.argv.indexOf("--references");
  if (refFlag >= 0) {
    const threadId = process.argv[refFlag + 1];
    if (!threadId) {
      console.error("--references needs a thread_id");
      process.exit(2);
    }
    const forayId = listForays(root).find((id) =>
      loadForay(root, id).threads.some((t) => t.thread_id === threadId)
    );
    if (!forayId) {
      console.error(`no Foray carries thread ${threadId}`);
      process.exit(2);
    }
    process.stdout.write(renderReferences(loadForay(root, forayId), threadId));
    process.exit(0);
  }

  const { errors, warnings, report } = checkNarration(root);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ errors, warnings, report }, null, 2));
  } else {
    for (const w of warnings) console.warn(`WARN ${w}`);
    for (const e of errors) console.error(`FAIL ${e}`);
    for (const r of report)
      console.log(
        `${r.foray_id}: ${r.threads} thread(s), ${r.beats} beat(s), ${r.narration_sec.toFixed(1)} s of narration`
      );
    console.log(errors.length === 0 ? "narration ok" : `${errors.length} violation(s)`);
  }
  process.exit(errors.length === 0 ? 0 : 1);
}
