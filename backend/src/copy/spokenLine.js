"use strict";
/**
 * THE SPOKEN LINE AND ITS READABILITY, DEFINED ONCE.
 *
 * GV-10 (docs/roadmap/generation-v2.md, #1286; decision 16): this file is the
 * only implementation of the spoken-line rules (N7-N9's reference leak, digit
 * and banned-word checks, N21's sentence-length constants, N24's per-sentence
 * numeric cap), the sentence splitter, the Flesch-Kincaid grade, sentence
 * shape, speakability and filler. It lives in `backend/src/copy/` next to
 * `narratorStructure.js` and for that file's reason: there are consumers with
 * no shared build step -- `tools/foray/check-narration.mjs` (the curation
 * gate), `tools/foray/voice-metrics.mjs` (the scorecard) and the generator in
 * backend TypeScript -- and backend TS cannot import a tools `.mjs` at
 * runtime. CommonJS, so all three can load it.
 *
 * The rules and constants above the "Added" line moved VERBATIM from
 * check-narration.mjs, which re-exports each one under its existing name, so
 * the curation gate's behaviour and messages are unchanged.
 *
 * The readability functions below that line are HEURISTICS (a vowel-group
 * syllable counter, a regex passive-voice detector). They are trend numbers
 * for a scorecard until they are calibrated against the founder's listening
 * cards; nothing gates on them here.
 */

const isStr = (v) => typeof v === "string" && v.trim().length > 0;

/* narration-craft.md §5d's sentence rules (check-narration N21): the mean
   sentence length band, the hard maximum, and the rhythm rule's short
   sentence, which applies to a beat longer than RHYTHM_TRIGGER_SEC. */
const SENTENCE_MEAN_WORDS = [12, 15];
const SENTENCE_MAX_WORDS = 25;
const SHORT_SENTENCE_WORDS = 6;
const RHYTHM_TRIGGER_SEC = 20;

/* HA #22 (2026-09-30), narration-craft.md §5d (check-narration N24): at most
   one numeric fact per sentence. A two-ended range in one sentence with the
   unit spoken once is ONE numeric expression. */
const NUMERIC_FACTS_PER_SENTENCE_MAX = 1;

/* The founder's ruling, mechanised: "It would be so terrible if the references
   were read aloud, they should all just be in some accompanying text." A
   reference is a citation apparatus — a publication, a URL, a retrieval, a
   scholarly formula. Naming the SPEAKER of adjacent tape is a different rule
   (segment-length-rules.md X2) and is deliberately not matched here. */
const REFERENCE_LEAK_RE =
  /\bhttps?:\/\/|\bwikipedia\b|\boldid\b|\bet al\b|\baccording to\b|\bdoi\b|\bibid\b|\bop\. ?cit\b|\bas cited\b|\bcites?\b|\bcitation\b|\b\w+\.(?:com|org|net|edu|gov)\b|\bpp?\.\s*\d/i;

/* narration-craft.md §5e. Each has the grammatical shape of an attribution with
   the attribution deleted, which is how a script manufactures authority out of
   nothing while sounding careful. */
const BANNED_HEDGES = [
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
const BANNED_ADJECTIVES = [
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
const BANNED_OPENERS = ["it turns out", "as it happens", "interestingly", "of course", "now"];

/* Spelled forms, because §5d requires numbers "written as spoken", so a `self`
   claim's spoken_number reaches the listener as a word. Without this table the
   artifact-side count and the word the listener hears are unrelated. */
const SPELLED = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
  "eighteen", "nineteen", "twenty",
];

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
function spokenLineErrors(text, where, opts = {}) {
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

/* ------------------------------------------------------------------------
 * Added (GV-10): the splitter and the readability measures (MQ-15..MQ-18).
 * ---------------------------------------------------------------------- */

/* OQ-02's adopted default: the reading-grade band generated narration should
   sit in. A scorecard number until calibrated; no gate reads it here. */
const READING_GRADE_BAND = [6, 9];

/* Abbreviations whose full stop does not end a sentence. Dotted letter runs
   (U.S., e.g., i.e., a single initial) are matched by shape below instead. */
const ABBREVIATIONS = new Set(["dr", "mr", "mrs", "st", "vs"]);
const CLOSERS = new Set(['"', "'", "”", "’", ")", "]"]);
const OPENERS_STRIP_RE = /^["'“‘([]+/;

/** Whether the full stop ending `token` belongs to an abbreviation. */
function isAbbreviation(token) {
  const t = token.replace(OPENERS_STRIP_RE, "");
  const bare = t.replace(/\.$/, "").toLowerCase();
  if (ABBREVIATIONS.has(bare)) return true;
  /* Dotted letter runs: U.S., e.g., i.e. */
  if (/^(?:[a-z]\.){2,}$/i.test(t)) return true;
  /* A single capital initial ("J. R. Tolkien"), but not the pronoun "I",
     which ends sentences ("So did I.") far more often than it initials one. */
  if (/^[A-Z]\.$/.test(t) && t !== "I.") return true;
  return false;
}

/**
 * Split narration into its spoken sentences: on . ! ?, the ellipsis ("..."
 * and "…"), with trailing closing quotes and brackets kept on the sentence.
 * A terminator ends a sentence only when whitespace or the end of the text
 * follows it, so a decimal ("3.5") stays whole; an abbreviation's full stop
 * (Dr., Mr., Mrs., St., U.S., e.g., i.e., vs., a single capital initial)
 * never ends one.
 *
 * @param {string} text
 * @returns {string[]} trimmed, non-empty sentences in order
 */
function splitSpokenSentences(text) {
  if (typeof text !== "string") return [];
  const out = [];
  let start = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch !== "." && ch !== "!" && ch !== "?" && ch !== "…") {
      i++;
      continue;
    }
    let j = i;
    while (j < n && (text[j] === "." || text[j] === "!" || text[j] === "?" || text[j] === "…")) j++;
    while (j < n && CLOSERS.has(text[j])) j++;
    if (j < n && !/\s/.test(text[j])) {
      i = j;
      continue;
    }
    /* A lone full stop after an abbreviation is not a boundary. */
    if (j - i === 1 && ch === ".") {
      const before = text.slice(start, i + 1);
      const token = before.slice(before.search(/\S+$/));
      if (isAbbreviation(token)) {
        i = j;
        continue;
      }
    }
    const s = text.slice(start, j).trim();
    if (s) out.push(s);
    start = j;
    i = j;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

/** Whitespace word count, the same count check-narration's N21 uses. */
const wordCount = (s) => String(s).split(/\s+/).filter(Boolean).length;

/**
 * Sentence-length shape (MQ-16) over a list of sentences, or over a text that
 * is split first. Words are whitespace tokens, as in check-narration's N21.
 * `over25` counts sentences longer than SENTENCE_MAX_WORDS; `shortShare` is
 * the share of sentences under SHORT_SENTENCE_WORDS (the rhythm rule's short
 * sentence).
 *
 * @param {string[]|string} sentences
 * @returns {{mean:number,max:number,min:number,n:number,over25:number,shortShare:number}}
 */
function sentenceShape(sentences) {
  const list = typeof sentences === "string" ? splitSpokenSentences(sentences) : sentences ?? [];
  const lens = list.filter(isStr).map(wordCount);
  if (lens.length === 0) return { mean: 0, max: 0, min: 0, n: 0, over25: 0, shortShare: 0 };
  const total = lens.reduce((a, b) => a + b, 0);
  return {
    mean: total / lens.length,
    max: Math.max(...lens),
    min: Math.min(...lens),
    n: lens.length,
    over25: lens.filter((l) => l > SENTENCE_MAX_WORDS).length,
    shortShare: lens.filter((l) => l < SHORT_SENTENCE_WORDS).length / lens.length,
  };
}

const NUMBER_WORDS = new Set([
  ...SPELLED,
  "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
  "hundred", "thousand", "million", "billion", "trillion", "dozen",
]);
const SCALE_WORDS = new Set(["hundred", "thousand", "million", "billion", "trillion", "dozen"]);
const RANGE_JOINERS = new Set(["to", "and", "or", "through", "-", "–", "—"]);
const NUMERIC_TOKEN_RE = /\d+(?:[.,]\d+)*|[A-Za-z]+(?:'[A-Za-z]+)?|[-–—]/g;

/**
 * N24's generated-text variant: how many numeric expressions a sentence
 * carries. Generated narration has no numeric_facts declarations, so this
 * counts what is spoken: digit groups and spoken-number groups ("three
 * hundred and twenty" is one group). Two groups joined directly by a range
 * word (to, and, or, through, a dash) are ONE expression, which is the
 * ruling's "two-ended range with the unit spoken once": "two metres to three
 * metres" says the unit twice and counts two. A lone "one" ("one veteran
 * remembers") is a pronoun far more often than a figure and is not counted.
 *
 * @param {string} sentence
 * @returns {number}
 */
function numericExpressionsIn(sentence) {
  if (typeof sentence !== "string") return 0;
  const tokens = (sentence.match(NUMERIC_TOKEN_RE) || []).map((t) => t.toLowerCase());
  const isNum = (t) => /^\d/.test(t) || NUMBER_WORDS.has(t);
  /* Groups as [startIndex, endIndex, words]. */
  const groups = [];
  let i = 0;
  while (i < tokens.length) {
    if (!isNum(tokens[i])) {
      i++;
      continue;
    }
    const begin = i;
    const words = [tokens[i]];
    i++;
    for (;;) {
      /* Number words chain ("three hundred"); a numeral takes a scale word ("5 million"). */
      if (
        i < tokens.length &&
        isNum(tokens[i]) &&
        !/^\d/.test(tokens[i]) &&
        (!/^\d/.test(words[words.length - 1]) || SCALE_WORDS.has(tokens[i]))
      ) {
        words.push(tokens[i]);
        i++;
        continue;
      }
      /* "three hundred and twenty": "and" inside a number follows a scale word. */
      if (
        tokens[i] === "and" &&
        SCALE_WORDS.has(words[words.length - 1]) &&
        i + 1 < tokens.length &&
        NUMBER_WORDS.has(tokens[i + 1]) &&
        !SCALE_WORDS.has(tokens[i + 1])
      ) {
        words.push(tokens[i + 1]);
        i += 2;
        continue;
      }
      break;
    }
    groups.push({ begin, end: i - 1, words });
  }
  let count = 0;
  for (let g = 0; g < groups.length; g++) {
    const cur = groups[g];
    const next = groups[g + 1];
    if (next && next.begin === cur.end + 2 && RANGE_JOINERS.has(tokens[cur.end + 1])) {
      count++;
      g++;
      continue;
    }
    if (cur.words.length === 1 && cur.words[0] === "one") continue;
    count++;
  }
  return count;
}

/**
 * A heuristic syllable count: vowel groups (y included), with a silent final
 * e, a silent -es and -ed after most consonants, and the -le rule (a
 * consonant before a final "le" makes it a syllable: ta-ble, lit-tle).
 * Words of three letters or fewer are one syllable; a word with no letters
 * counts zero.
 *
 * @param {string} word
 * @returns {number}
 */
function syllables(word) {
  const w = String(word ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  let n = (w.replace(/^y/, "").match(/[aeiouy]+/g) || []).length;
  const consonantLe = /[^aeiouy]le$/.test(w) || /[^aeiouy]les$/.test(w);
  if (!consonantLe) {
    if (/[^aeiouy]e$/.test(w)) n--; /* silent e: make, time, whale */
    else if (/[^aeiouysxz]es$/.test(w) && !/(?:ch|sh|[gc])es$/.test(w)) n--; /* makes, times */
    else if (/[^aeiouytd]ed$/.test(w)) n--; /* named, jumped (not wanted, ended) */
  }
  return Math.max(1, n);
}

/** Word tokens for readability: whitespace tokens that carry a letter or digit. */
const readabilityWords = (text) =>
  String(text ?? "")
    .split(/\s+/)
    .filter((t) => /[A-Za-z0-9]/.test(t));

/**
 * Flesch-Kincaid grade (MQ-15): 0.39 (words / sentences) + 11.8 (syllables /
 * words) - 15.59. A token with no letters (a numeral) counts one syllable.
 * Text with no words scores 0.
 *
 * @param {string} text
 * @returns {number}
 */
function fleschKincaidGrade(text) {
  const words = readabilityWords(text);
  if (words.length === 0) return 0;
  const sentences = Math.max(1, splitSpokenSentences(text).length);
  const syl = words.reduce((a, w) => a + Math.max(1, syllables(w)), 0);
  return 0.39 * (words.length / sentences) + 11.8 * (syl / words.length) - 15.59;
}

const per100 = (count, words) => (words > 0 ? (100 * count) / words : 0);

/**
 * Speakability (MQ-17): things a voice stumbles on, per 100 words — digit
 * groups, URLs, acronyms (two or more capitals), opening brackets, plus every
 * spokenLineErrors finding on each sentence. A digit is counted by both (it is
 * both a stumble and a §5d breach), as the card specifies.
 *
 * @param {string} text
 * @returns {{per100:number,words:number,digits:number,urls:number,acronyms:number,brackets:number,lineErrors:number}}
 */
function speakability(text) {
  const t = String(text ?? "");
  const words = readabilityWords(t).length;
  const urls = (t.match(/\bhttps?:\/\/\S+|\bwww\.\S+/gi) || []).length;
  const digits = (t.match(/\d+(?:[.,]\d+)*/g) || []).length;
  const acronyms = (t.match(/\b[A-Z]{2,}s?\b/g) || []).length;
  const brackets = (t.match(/[([{]/g) || []).length;
  const lineErrors = splitSpokenSentences(t).reduce((a, s) => a + spokenLineErrors(s, "", {}).length, 0);
  const total = digits + urls + acronyms + brackets + lineErrors;
  return { per100: per100(total, words), words, digits, urls, acronyms, brackets, lineErrors };
}

/* -ly words that are not manner adverbs. */
const LY_STOPLIST = new Set([
  "only", "family", "early", "july", "reply", "supply", "apply", "imply", "comply", "rely", "ally", "fly",
  "belly", "holy", "ugly", "daily", "weekly", "monthly", "yearly", "hourly", "friendly", "lonely", "lovely",
  "silly", "italy", "rally", "bully", "jelly", "hilly", "emily", "billy", "sally", "kelly", "assembly",
  "anomaly", "butterfly", "lily", "curly", "costly", "elderly", "likely", "unlikely", "multiply", "oily",
  "jolly", "chilly", "scholarly", "orderly", "deadly", "lively", "timely", "homely", "wily", "doily",
]);
/* -en / -ed words after a be-form that are not past participles. */
const PASSIVE_STOPLIST = new Set([
  "even", "often", "seven", "eleven", "then", "when", "open", "women", "children", "kitchen", "heaven",
  "garden", "golden", "wooden", "sudden", "listen", "citizen", "token", "oxygen", "eighteen", "thirteen",
  "fourteen", "fifteen", "sixteen", "seventeen", "nineteen", "between", "seen", "keen", "green", "queen",
  "screen", "teen", "ten", "hen", "pen", "men", "den", "red", "bed", "need", "seed", "feed", "speed",
  "indeed", "hundred", "kindred", "sacred", "naked", "wicked", "rugged",
]);
const PASSIVE_RE =
  /\b(?:am|is|are|was|were|be|been|being)\s+(?:(?:[a-z]+ly|not|never|often|also|always|still|just)\s+)?([a-z]{3,}(?:ed|en))\b/gi;

/**
 * Filler (MQ-18), per 100 words: -ly manner adverbs (with a stoplist),
 * passive voice (a be-form, an optional adverb, then an -ed/-en word not
 * on a stoplist), BANNED_HEDGES / BANNED_ADJECTIVES hits, a BANNED_OPENERS
 * hit at a sentence's start, and questions.
 *
 * @param {string} text
 * @returns {{per100:number,words:number,lyAdverbs:number,passives:number,banned:number,questions:number}}
 */
function filler(text) {
  const t = String(text ?? "");
  const words = readabilityWords(t).length;
  const lyAdverbs = (t.match(/\b[A-Za-z]{3,}ly\b/g) || []).filter((w) => !LY_STOPLIST.has(w.toLowerCase())).length;
  let passives = 0;
  for (const m of t.matchAll(PASSIVE_RE)) if (!PASSIVE_STOPLIST.has(m[1].toLowerCase())) passives++;
  const low = t.toLowerCase();
  let banned = 0;
  for (const phrase of [...BANNED_HEDGES, ...BANNED_ADJECTIVES]) banned += low.split(phrase).length - 1;
  const sentences = splitSpokenSentences(t);
  let questions = 0;
  for (const s of sentences) {
    const ls = s.toLowerCase().replace(OPENERS_STRIP_RE, "");
    if (BANNED_OPENERS.some((o) => ls === o || ls.startsWith(o + " ") || ls.startsWith(o + ","))) banned++;
    if (/\?["'”’)\]]*$/.test(s)) questions++;
  }
  const total = lyAdverbs + passives + banned + questions;
  return { per100: per100(total, words), words, lyAdverbs, passives, banned, questions };
}

module.exports = {
  REFERENCE_LEAK_RE,
  BANNED_HEDGES,
  BANNED_ADJECTIVES,
  BANNED_OPENERS,
  SPELLED,
  SENTENCE_MEAN_WORDS,
  SENTENCE_MAX_WORDS,
  SHORT_SENTENCE_WORDS,
  RHYTHM_TRIGGER_SEC,
  NUMERIC_FACTS_PER_SENTENCE_MAX,
  READING_GRADE_BAND,
  spokenLineErrors,
  splitSpokenSentences,
  sentenceShape,
  numericExpressionsIn,
  syllables,
  fleschKincaidGrade,
  speakability,
  filler,
};
