/* voice-metrics.mjs — the narration voice scorecard (MQ-15..MQ-18).
 *
 * GV-10 (docs/roadmap/generation-v2.md, #1286; decision 16). A THIN ESM
 * wrapper over `backend/src/copy/spokenLine.js`, which is the only
 * implementation of the sentence splitter, the syllable counter, the
 * Flesch-Kincaid grade, sentence shape, speakability and filler. The curation
 * gate (`check-narration.mjs`) and the generator read the same file, so the
 * scorecard can never measure a different sentence from the one the gate
 * checks. This file adds only the scorecard's own view: sentenceShape over a
 * text with the scorecard's field names, and scoreVoice over many scripts.
 *
 * Every number here is a HEURISTIC trend metric (vowel-group syllables, a
 * regex passive detector). Calibrate against the founder's listening cards
 * before anything gates on it; R2-14 owns gating.
 */

import spokenLine from "../../backend/src/copy/spokenLine.js";

export const {
  READING_GRADE_BAND,
  SENTENCE_MEAN_WORDS,
  SENTENCE_MAX_WORDS,
  SHORT_SENTENCE_WORDS,
  syllables,
  fleschKincaidGrade,
  speakability,
  filler,
} = spokenLine;

/** The spoken sentences of a text (spokenLine's splitter). */
export function splitSentences(text) {
  return spokenLine.splitSpokenSentences(text);
}

/**
 * MQ-16: sentence-length shape of a text, in the scorecard's field names.
 * Words are whitespace tokens, as in check-narration's N21.
 *
 * @param {string} text
 * @returns {{meanWords:number,maxWords:number,minWords:number,sentences:number,over25:number,shortShare:number}}
 */
export function sentenceShape(text) {
  const s = spokenLine.sentenceShape(splitSentences(text));
  return {
    meanWords: s.mean,
    maxWords: s.max,
    minWords: s.min,
    sentences: s.n,
    over25: s.over25,
    shortShare: s.shortShare,
  };
}

const inBand = (grade) => grade >= READING_GRADE_BAND[0] && grade <= READING_GRADE_BAND[1];

/**
 * Score many narration scripts at once. Each entry is a script string, or an
 * object with a `script` (and optionally an `id`, as a Foray narration item
 * has). Returns one row per script plus word-weighted aggregates: the grade is
 * the word-weighted mean of the per-script grades; the per-100 rates are total
 * hits over total words (the word-weighted mean of the per-script rates);
 * meanWords and shortShare are over every sentence; over25 is a count.
 *
 * @param {Array<string|{id?:string,script:string}>} scripts
 */
export function scoreVoice(scripts) {
  const rows = (scripts ?? []).map((entry, i) => {
    const script = typeof entry === "string" ? entry : String(entry?.script ?? "");
    const id = typeof entry === "string" ? `#${i}` : String(entry?.id ?? `#${i}`);
    const shape = sentenceShape(script);
    const sp = speakability(script);
    const fl = filler(script);
    const grade = fleschKincaidGrade(script);
    return {
      id,
      words: sp.words,
      fkGrade: grade,
      inBand: inBand(grade),
      ...shape,
      speakabilityPer100: sp.per100,
      fillerPer100: fl.per100,
      speakability: sp,
      filler: fl,
    };
  });
  const words = rows.reduce((a, r) => a + r.words, 0);
  const sentences = rows.reduce((a, r) => a + r.sentences, 0);
  const shapeWords = rows.reduce((a, r) => a + r.meanWords * r.sentences, 0);
  const short = rows.reduce((a, r) => a + r.shortShare * r.sentences, 0);
  const sum = (pick) => rows.reduce((a, r) => a + pick(r), 0);
  const grade = words > 0 ? sum((r) => r.fkGrade * r.words) / words : 0;
  const per100 = (hits) => (words > 0 ? (100 * hits) / words : 0);
  return {
    scripts: rows.length,
    words,
    sentences,
    fkGrade: grade,
    inBand: inBand(grade),
    gradeBand: READING_GRADE_BAND,
    scriptsInBand: rows.filter((r) => r.inBand).length,
    meanWords: sentences > 0 ? shapeWords / sentences : 0,
    maxWords: rows.reduce((a, r) => Math.max(a, r.maxWords), 0),
    over25: sum((r) => r.over25),
    shortShare: sentences > 0 ? short / sentences : 0,
    speakabilityPer100: per100(sum(({ speakability: s }) => s.digits + s.urls + s.acronyms + s.brackets + s.lineErrors)),
    fillerPer100: per100(sum(({ filler: f }) => f.lyAdverbs + f.passives + f.banned + f.questions)),
    rows,
  };
}
