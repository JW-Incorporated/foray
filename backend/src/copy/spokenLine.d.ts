/**
 * Type declarations for the plain-JS spoken-line and readability library (see
 * spokenLine.js for why this is JS, not TS). Hand-authored, not generated —
 * keep in sync with that file's actual exports.
 */
export declare const REFERENCE_LEAK_RE: RegExp;
export declare const BANNED_HEDGES: string[];
export declare const BANNED_ADJECTIVES: string[];
export declare const BANNED_OPENERS: string[];
export declare const SPELLED: string[];
export declare const SENTENCE_MEAN_WORDS: [number, number];
export declare const SENTENCE_MAX_WORDS: number;
export declare const SHORT_SENTENCE_WORDS: number;
export declare const RHYTHM_TRIGGER_SEC: number;
export declare const NUMERIC_FACTS_PER_SENTENCE_MAX: number;
export declare const READING_GRADE_BAND: [number, number];
export declare function spokenLineErrors(text: string, where: string, opts?: { hasTape?: boolean }): string[];
export declare function splitSpokenSentences(text: string): string[];
export interface SentenceShape {
  mean: number;
  max: number;
  min: number;
  n: number;
  over25: number;
  shortShare: number;
}
export declare function sentenceShape(sentences: string[] | string): SentenceShape;
export declare function numericExpressionsIn(sentence: string): number;
export declare function syllables(word: string): number;
export declare function fleschKincaidGrade(text: string): number;
export interface Speakability {
  per100: number;
  words: number;
  digits: number;
  urls: number;
  acronyms: number;
  brackets: number;
  lineErrors: number;
}
export declare function speakability(text: string): Speakability;
export interface Filler {
  per100: number;
  words: number;
  lyAdverbs: number;
  passives: number;
  banned: number;
  questions: number;
}
export declare function filler(text: string): Filler;
