/**
 * Type declarations for the plain-JS narrator-structure rule (see
 * narratorStructure.js for why this is JS, not TS). Hand-authored, not
 * generated — keep in sync with that file's actual exports.
 */
export declare function narratorStructureLeaks(text: string): Array<{ phrase: string; rule: string; why: string }>;
export declare function narratorStructureErrors(text: string, where: string): string[];
export declare function toNarrationWords(text: string): { text: string; changed: boolean };
export declare const NARRATOR_STRUCTURE_RULE: string;
export declare const NARRATOR_STRUCTURE_EXAMPLES: { refused: string[]; fine: string[] };
export declare const STRUCTURE_NOUN: string;
export declare const PROGRAMME_NOUN: string;
