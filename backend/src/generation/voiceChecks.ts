import {
  NUMERIC_FACTS_PER_SENTENCE_MAX,
  READING_GRADE_BAND,
  RHYTHM_TRIGGER_SEC,
  SENTENCE_MAX_WORDS,
  SENTENCE_MEAN_WORDS,
  SHORT_SENTENCE_WORDS,
  filler,
  fleschKincaidGrade,
  numericExpressionsIn,
  sentenceShape,
  speakability,
  splitSpokenSentences,
  spokenLineErrors,
  type SentenceShape
} from "../copy/spokenLine";
import { scriptSeconds } from "../types/narration";
import type { WrittenAct } from "./writeNarration";
import type { ForayItem } from "./forayItems";

/**
 * GV-104 (docs/roadmap/generation-v2.md, #1286; W5-18 + W4-12; R2-14,
 * QK-25, GP-24, MQ-15..MQ-18): the voice rules that live in the writer's
 * prompt, checked in CODE on generated narration.
 *
 * ONE IMPLEMENTATION (decision 16). Every rule and constant here is
 * `backend/src/copy/spokenLine.js`'s: the splitter, N7-N9's spoken-line
 * errors, N21's sentence constants, N24's per-sentence numeric count, the
 * Flesch-Kincaid grade, speakability and filler. This module only arranges
 * them for generated text -- a script per seam rather than a beat's
 * `sentences` -- and mirrors nothing, so it cannot drift from the curation
 * gate (`check-narration.mjs`) or the scorecard (`voice-metrics.mjs`), which
 * read the same file.
 *
 * TWO USES, deliberately different in force:
 *   - the writer gate (`writeAct.ts`, FORAY_VOICE_GATE=enforce): only the
 *     HARD errors (`voiceReport().hardErrors`) re-ask a seam, and only from
 *     act FORAY_VOICE_ENFORCE_FROM_ACT on (default 1, so act 1's first-audio
 *     path never pays for a retry). Sentence shape and the grade never gate.
 *   - the scorecard (`meta.veracity.voice`, every run but `off`): the grade, the shape
 *     and the per-100-word rates over every final narration item, computed
 *     from the finished items, so a resumed run reports the same numbers.
 *
 * The grade band (OQ-02's 6-9) is NOT validated for listening; it is a trend
 * number until the founder's listening cards calibrate it.
 */

/** FORAY_VOICE_GATE's modes. `report` (the default) does nothing in the
 * writer and adds the voice block to the report; `enforce` also re-asks;
 * `off` does neither. */
export const VOICE_GATE_MODES = ["off", "report", "enforce"] as const;
export type VoiceGateMode = (typeof VOICE_GATE_MODES)[number];

/** The writer-side voice gate, threaded from the run's `GateConfig`
 * (decision 34) into `WriteActOptions.voiceGate`. */
export interface VoiceGate {
  mode: VoiceGateMode;
  /** The first act (0-based position in the Foray) whose seams are
   * enforced. Default 1: act 1 is on the first-audio path (R2). */
  enforceFromAct: number;
}

/** Whether the voice gate re-asks seams of the act at `actIndex` (0-based). */
export function voiceGateEnforces(gate: VoiceGate | undefined, actIndex: number): boolean {
  return gate !== undefined && gate.mode === "enforce" && actIndex >= gate.enforceFromAct;
}

export interface VoiceReport {
  /** N7-N9 per sentence (reference leak, digit, hedge, banned adjective,
   * throat-clearing opener, a rhetorical question with no tape) plus N24 (more
   * than one numeric expression in a sentence). The only findings the writer
   * gate may act on. */
  hardErrors: string[];
  /** N21's measurements over the script's spoken sentences. */
  shape: SentenceShape;
  /** N21's three rules: mean outside 12-15 words, a sentence over 25, and no
   * sentence under 6 words when the script runs over RHYTHM_TRIGGER_SEC.
   * Reported, never gated. */
  shapeIssues: string[];
  /** Flesch-Kincaid grade (MQ-15). Reported, never gated. */
  grade: number;
  wordCount: number;
}

const quoted = (sentence: string): string => `the sentence "${sentence.length > 120 ? `${sentence.slice(0, 120)}…` : sentence}"`;

/**
 * The voice rules on one narration script. `hasTape`: whether tape plays
 * beside the script (a clip it introduces or follows), which is the only
 * place a rhetorical question is allowed (§5c: the tape answers it). Left
 * undefined, no question is flagged.
 */
export function voiceReport(script: string, opts: { hasTape?: boolean } = {}): VoiceReport {
  const text = String(script ?? "");
  const sentences = splitSpokenSentences(text);
  const hardErrors: string[] = [];
  for (const sentence of sentences) {
    const where = quoted(sentence);
    hardErrors.push(...spokenLineErrors(sentence, where, opts.hasTape === undefined ? {} : { hasTape: opts.hasTape }));
    const numeric = numericExpressionsIn(sentence);
    if (numeric > NUMERIC_FACTS_PER_SENTENCE_MAX) {
      hardErrors.push(`${where}: ${numeric} numeric expressions against §5d's cap of ${NUMERIC_FACTS_PER_SENTENCE_MAX} per sentence (N24)`);
    }
  }
  const shape = sentenceShape(sentences);
  const shapeIssues: string[] = [];
  if (shape.n > 0) {
    if (shape.mean < SENTENCE_MEAN_WORDS[0] || shape.mean > SENTENCE_MEAN_WORDS[1]) {
      shapeIssues.push(`mean sentence length ${shape.mean.toFixed(1)} words is outside §5d's ${SENTENCE_MEAN_WORDS.join("-")} (N21)`);
    }
    if (shape.max > SENTENCE_MAX_WORDS) {
      shapeIssues.push(`longest sentence is ${shape.max} words against §5d's maximum of ${SENTENCE_MAX_WORDS} (N21)`);
    }
    if (scriptSeconds(text.length) > RHYTHM_TRIGGER_SEC && shape.min >= SHORT_SENTENCE_WORDS) {
      shapeIssues.push(`no sentence under ${SHORT_SENTENCE_WORDS} words; §5d's rhythm rule applies over ${RHYTHM_TRIGGER_SEC} s (N21)`);
    }
  }
  return { hardErrors, shape, shapeIssues, grade: fleschKincaidGrade(text), wordCount: speakability(text).words };
}

/** W4-12: one seam's sentence shape, in the per-seam field names. */
export interface SeamSentenceShape {
  sentences: number;
  meanWords: number;
  maxWords: number;
  /** Share of sentences under SHORT_SENTENCE_WORDS. */
  shortShare: number;
  /** Sentences over SENTENCE_MAX_WORDS. */
  overMax: number;
}

export function seamSentenceShape(script: string): SeamSentenceShape {
  const s = sentenceShape(splitSpokenSentences(String(script ?? "")));
  return { sentences: s.n, meanWords: s.mean, maxWords: s.max, shortShare: s.shortShare, overMax: s.over25 };
}

/** W4-12: the per-seam shape over many seams. */
export interface SeamShapeSummary {
  /** Seams with at least one sentence. */
  seams: number;
  /** Mean words per sentence over every sentence of every seam. */
  meanWords: number;
  maxWords: number;
  /** Share of seams whose own mean sits in SENTENCE_MEAN_WORDS (12-15);
   * null with no seam. */
  shareInBand: number | null;
  /** Seams with a sentence over SENTENCE_MAX_WORDS. */
  overMaxSeams: number;
}

export function seamShapeSummary(scripts: readonly string[]): SeamShapeSummary {
  const shapes = scripts.map(seamSentenceShape).filter((s) => s.sentences > 0);
  const sentences = shapes.reduce((a, s) => a + s.sentences, 0);
  const words = shapes.reduce((a, s) => a + s.meanWords * s.sentences, 0);
  const inBand = shapes.filter((s) => s.meanWords >= SENTENCE_MEAN_WORDS[0] && s.meanWords <= SENTENCE_MEAN_WORDS[1]).length;
  return {
    seams: shapes.length,
    meanWords: sentences > 0 ? words / sentences : 0,
    maxWords: shapes.reduce((a, s) => Math.max(a, s.maxWords), 0),
    shareInBand: shapes.length > 0 ? inBand / shapes.length : null,
    overMaxSeams: shapes.filter((s) => s.overMax > 0).length
  };
}

/** W4-12: the seam shape of one written act, over its kept pages (one page
 * per seam on the act path; `allWrittenNarration`'s traversal, inlined so
 * this module, which writeAct.ts imports, does not import writeNarration.ts
 * back). */
export function actVoiceSummary(writtenAct: WrittenAct): SeamShapeSummary {
  const scripts: string[] = [];
  for (const slot of writtenAct.slots) {
    for (const beat of slot.beats) {
      const page = beat.sourcing === "narration" ? beat.narration : beat.connectiveNarration;
      if (page) scripts.push(page.script);
    }
  }
  return seamShapeSummary(scripts);
}

/** One final narration item, as the scorecard reads it. */
export interface VoiceScript {
  id?: string;
  script: string;
  /** Tape plays right before or right after the item. */
  hasTape: boolean;
}

/**
 * The narration items of a finished item list, in order, each with whether a
 * segment sits beside it. Every narration item counts: seams, act
 * introductions and exits, the prelude.
 */
export function voiceScriptsOf(items: readonly ForayItem[]): VoiceScript[] {
  const out: VoiceScript[] = [];
  items.forEach((item, i) => {
    if (item.type !== "narration") return;
    const hasTape = items[i - 1]?.type === "segment" || items[i + 1]?.type === "segment";
    out.push({ id: item.id, script: item.script, hasTape });
  });
  return out;
}

/** `meta.veracity.voice` (MQ-15..MQ-18 plus W4-12's per-seam shape). */
export interface VoiceMetrics {
  /** Narration items scored. */
  items: number;
  words: number;
  /** MQ-15: Flesch-Kincaid grade, the word-weighted mean of the per-item
   * grades (the scorecard's `scoreVoice` reading). null with no words. */
  readingGrade: number | null;
  /** The band the grade was read against (OQ-02, default 6-9). */
  gradeBand: [number, number];
  gradeInBand: boolean | null;
  /** MQ-16: sentences over 25 words, per 100 words. */
  sentencesOver25Per100Words: number;
  meanSentenceWords: number;
  /** Share of sentences under 6 words. */
  shortSentenceShare: number;
  /** MQ-17's parts, each per 100 words. */
  speakabilityPer100Words: { digits: number; urls: number; acronyms: number; brackets: number };
  /** MQ-18's banned hedges, adjectives and openers, per 100 words. */
  bannedPer100Words: number;
  /** N7-N9 + N24 findings over every item (what FORAY_VOICE_GATE=enforce
   * would re-ask on a seam): the report-mode re-ask signal. */
  hardErrors: number;
  /** W4-12: the per-item sentence shape. */
  seamShape: { meanWords: number; maxWords: number; shareInBand: number | null; overMaxSeams: number };
}

/** The per-100-word rate the scorecard uses: zero without words. */
const per100 = (count: number, words: number): number => (words > 0 ? (100 * count) / words : 0);

export function computeVoiceMetrics(scripts: readonly VoiceScript[], gradeBand: readonly [number, number] = READING_GRADE_BAND): VoiceMetrics {
  let words = 0;
  let gradeWords = 0;
  let sentences = 0;
  let sentenceWords = 0;
  let short = 0;
  let over25 = 0;
  let banned = 0;
  let hardErrors = 0;
  const sp = { digits: 0, urls: 0, acronyms: 0, brackets: 0 };
  for (const { script, hasTape } of scripts) {
    const report = voiceReport(script, { hasTape });
    const s = speakability(script);
    words += s.words;
    gradeWords += report.grade * s.words;
    sentences += report.shape.n;
    sentenceWords += report.shape.mean * report.shape.n;
    short += report.shape.shortShare * report.shape.n;
    over25 += report.shape.over25;
    sp.digits += s.digits;
    sp.urls += s.urls;
    sp.acronyms += s.acronyms;
    sp.brackets += s.brackets;
    banned += filler(script).banned;
    hardErrors += report.hardErrors.length;
  }
  const readingGrade = words > 0 ? gradeWords / words : null;
  const band: [number, number] = [gradeBand[0], gradeBand[1]];
  const seam = seamShapeSummary(scripts.map((s) => s.script));
  return {
    items: scripts.length,
    words,
    readingGrade,
    gradeBand: band,
    gradeInBand: readingGrade === null ? null : readingGrade >= band[0] && readingGrade <= band[1],
    sentencesOver25Per100Words: per100(over25, words),
    meanSentenceWords: sentences > 0 ? sentenceWords / sentences : 0,
    shortSentenceShare: sentences > 0 ? short / sentences : 0,
    speakabilityPer100Words: {
      digits: per100(sp.digits, words),
      urls: per100(sp.urls, words),
      acronyms: per100(sp.acronyms, words),
      brackets: per100(sp.brackets, words)
    },
    bannedPer100Words: per100(banned, words),
    hardErrors,
    seamShape: { meanWords: seam.meanWords, maxWords: seam.maxWords, shareInBand: seam.shareInBand, overMaxSeams: seam.overMaxSeams }
  };
}
