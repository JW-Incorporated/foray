/**
 * Type declarations for the plain-JS copy-rules module (see rules.js for
 * why this is JS, not TS). Hand-authored, not generated — keep in sync with
 * rules.js's actual exports.
 */
export declare const BANNED: RegExp[];
export declare const INTERNAL_VOCABULARY: RegExp[];
export declare function toListenerWords(text: string): { text: string; changed: boolean };
export declare function wordCount(text: string): number;
export declare const MAX_WHY_LINE_WORDS: number;
export declare const MAX_HOOK_WORDS: number;
export declare const MAX_DISPLAY_TITLE_WORDS: number;
export declare const MAX_BLURB_WORDS: number;
