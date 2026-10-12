/**
 * GV-10 (docs/roadmap/generation-v2.md, #1286; decision 16): the one
 * spoken-line and readability library, backend/src/copy/spokenLine.js, shared
 * by check-narration.mjs (the curation gate), the generator and the voice
 * scorecard (tools/foray/voice-metrics.mjs).
 *
 * Every test names the one-line mutation to spokenLine.js (or to
 * check-narration.mjs) that turns it red.
 */
import { describe, it, expect } from "vitest";
import {
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
  filler
} from "../src/copy/spokenLine";

describe("spokenLine: one definition behind check-narration", () => {
  it("check-narration.mjs re-exports the moved rules as the very same objects, under their existing names", async () => {
    /* MUTATION: re-declare `export const BANNED_OPENERS = [...]` (or a local
       spokenLineErrors) in check-narration.mjs instead of re-exporting -> red. */
    const checker = (await import("../../tools/foray/check-narration.mjs")) as Record<string, unknown>;
    const moved: Record<string, unknown> = {
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
      spokenLineErrors
    };
    for (const [name, value] of Object.entries(moved)) expect(checker[name], name).toBe(value);
  });

  it("the moved constants keep their curation-gate values", () => {
    /* MUTATION: SENTENCE_MAX_WORDS = 30 (or any constant edited in the move) -> red. */
    expect(SENTENCE_MEAN_WORDS).toEqual([12, 15]);
    expect(SENTENCE_MAX_WORDS).toBe(25);
    expect(SHORT_SENTENCE_WORDS).toBe(6);
    expect(RHYTHM_TRIGGER_SEC).toBe(20);
    expect(NUMERIC_FACTS_PER_SENTENCE_MAX).toBe(1);
    expect(SPELLED[0]).toBe("zero");
    expect(SPELLED[20]).toBe("twenty");
    expect(READING_GRADE_BAND).toEqual([6, 9]);
  });
});

describe("spokenLineErrors", () => {
  it("flags a digit, 'according to', 'fascinating' and an opening 'Now,'", () => {
    /* MUTATION: delete the `/\d/.test(text)` line -> red (the digit finding
       goes); drop "now" from BANNED_OPENERS -> red. */
    const found = spokenLineErrors("Now, according to one fascinating survey, 40 engineers quit.", "s1");
    expect(found.some((e) => /digit in a spoken line/.test(e))).toBe(true);
    expect(found.some((e) => /reference apparatus/.test(e))).toBe(true);
    expect(found).toContain('s1: banned adjective "fascinating"');
    expect(found).toContain('s1: §5c banned opener "now"');
    expect(found).toHaveLength(4);
  });

  it("passes a clean line, keeps 'now' legal mid-sentence, and flags a question only when there is no tape", () => {
    /* MUTATION: match openers with `low.includes(o)` instead of startsWith -> red. */
    expect(spokenLineErrors("The shop was quiet until now.", "s")).toEqual([]);
    expect(spokenLineErrors("Who paid for it?", "s", { hasTape: true })).toEqual([]);
    expect(spokenLineErrors("Who paid for it?", "s", { hasTape: false })).toHaveLength(1);
    expect(spokenLineErrors("  ", "s")).toEqual(["s: empty text"]);
  });
});

describe("splitSpokenSentences", () => {
  it("keeps 'Dr. Smith went to the U.S. in 1990.' as one sentence", () => {
    /* MUTATION: make isAbbreviation return false -> red (three pieces). */
    expect(splitSpokenSentences("Dr. Smith went to the U.S. in 1990.")).toEqual([
      "Dr. Smith went to the U.S. in 1990."
    ]);
  });

  it("splits on . ! ? and the ellipsis, keeps decimals and closing quotes, and guards e.g., vs. and initials but not 'I.'", () => {
    /* MUTATION: drop "…" from the terminator test -> red; drop the
       `t !== "I."` exception -> red. */
    expect(
      splitSpokenSentences('It cost 3.5 dollars. Why? Stop! Wait… then "go." Mr. J. Doe left. So did I. Then e.g. this vs. that.')
    ).toEqual([
      "It cost 3.5 dollars.",
      "Why?",
      "Stop!",
      "Wait…",
      'then "go."',
      "Mr. J. Doe left.",
      "So did I.",
      "Then e.g. this vs. that."
    ]);
    expect(splitSpokenSentences("Three dots... and more")).toEqual(["Three dots...", "and more"]);
    expect(splitSpokenSentences("")).toEqual([]);
  });
});

describe("sentenceShape", () => {
  it("reports mean, max, min, n, over25 and shortShare over whitespace words", () => {
    /* MUTATION: `l > SENTENCE_MAX_WORDS` -> `l >= SENTENCE_MAX_WORDS` -> red
       (the 25-word sentence is not over); `<` -> `<=` for short -> red. */
    const w = (k: number) => Array.from({ length: k }, () => "word").join(" ") + ".";
    const shape = sentenceShape([w(25), w(26), w(5), w(6)]);
    expect(shape).toEqual({ mean: 15.5, max: 26, min: 5, n: 4, over25: 1, shortShare: 0.25 });
    expect(sentenceShape([])).toEqual({ mean: 0, max: 0, min: 0, n: 0, over25: 0, shortShare: 0 });
    expect(sentenceShape("One two three. Four five.").n).toBe(2);
  });
});

describe("numericExpressionsIn (N24's generated-text variant)", () => {
  it("counts 'between two and three hundred metres' once", () => {
    /* MUTATION: delete the range-joiner merge (`if (next && ...)`) -> red (2). */
    expect(numericExpressionsIn("between two and three hundred metres")).toBe(1);
  });

  it("counts a repeated unit twice, numeral groups and scale words, and skips a lone pronoun 'one'", () => {
    /* MUTATION: delete the lone-"one" skip -> red; drop the scale-word join for
       numerals -> red ("3.5 million" becomes two). */
    expect(numericExpressionsIn("two metres to three metres")).toBe(2);
    expect(numericExpressionsIn("It cost 3.5 million in 1990.")).toBe(2);
    expect(numericExpressionsIn("three hundred and twenty people came")).toBe(1);
    expect(numericExpressionsIn("One veteran remembers the price.")).toBe(0);
    expect(numericExpressionsIn("one hundred machines")).toBe(1);
    expect(numericExpressionsIn("from five to ten years, then twelve more")).toBe(2);
    expect(numericExpressionsIn("No figures here.")).toBe(0);
  });
});

describe("syllables", () => {
  /* Dictionary counts the heuristic gets exactly right. */
  const EXACT: Record<string, number> = {
    table: 2, little: 2, whale: 1, makes: 1, changes: 2, watches: 2, named: 1, wanted: 2, played: 1, people: 2,
    machine: 2, engineer: 3, career: 2, evidence: 3, companies: 3, apple: 2, time: 1, cat: 1, river: 2, morning: 2,
    before: 2, school: 1, computer: 3, calculate: 3, quickly: 2, brother: 2, walked: 1, design: 2, boxes: 2, ended: 2
  };

  it("matches a 30-word table", () => {
    /* MUTATION: delete the -le rule (`consonantLe` always false) -> red
       (table, little, apple); delete the silent-e line -> red. */
    expect(Object.keys(EXACT)).toHaveLength(30);
    const got = Object.fromEntries(Object.keys(EXACT).map((w) => [w, syllables(w)]));
    expect(got).toEqual(EXACT);
  });

  it("is within +-1 of the dictionary on a 30-word reference list of hard words", () => {
    /* MUTATION: count every vowel letter instead of vowel GROUPS -> red. */
    const REF: Record<string, number> = {
      create: 2, idea: 3, quiet: 2, recipe: 3, business: 2, every: 3, poem: 2, area: 3, chaos: 2, lion: 2,
      science: 2, period: 3, video: 3, radio: 3, museum: 3, biology: 4, society: 4, reality: 4, experience: 4,
      beautiful: 3, family: 3, different: 3, interesting: 4, vegetable: 4, chocolate: 3, temperature: 4,
      naturally: 4, actually: 4, usually: 4, library: 3
    };
    expect(Object.keys(REF)).toHaveLength(30);
    const off = Object.entries(REF).filter(([w, n]) => Math.abs(syllables(w) - n) > 1);
    expect(off).toEqual([]);
    expect(syllables("1990")).toBe(0);
    expect(syllables("a")).toBe(1);
  });
});

describe("fleschKincaidGrade", () => {
  it("matches the hand-computed grade of three synthetic paragraphs within +-0.5", () => {
    /* MUTATION: 11.8 -> 11 in the formula -> red; 0.39 -> 0.5 -> red (para B/C). */
    /* A: 12 words, 2 sentences, 12 syllables:
          0.39 * 6 + 11.8 * 1 - 15.59 = -1.45 */
    expect(fleschKincaidGrade("The cat sat on the mat. The dog ran to the park.")).toBeCloseTo(-1.45, 0);
    expect(Math.abs(fleschKincaidGrade("The cat sat on the mat. The dog ran to the park.") - -1.45)).toBeLessThanOrEqual(0.5);
    /* B: 7 words, 2 sentences; en-gi-neers 3, de-sign 2, ma-chines 2,
          com-pu-ters 3, cal-cu-late 3, num-bers 2, quick-ly 2 = 17 syllables:
          0.39 * 3.5 + 11.8 * 17/7 - 15.59 = 14.432 */
    expect(
      Math.abs(fleschKincaidGrade("Engineers design machines. Computers calculate numbers quickly.") - 14.432)
    ).toBeLessThanOrEqual(0.5);
    /* C: 13 words, 1 sentence; bro-ther 2, ri-ver 2, mor-ning 2, be-fore 2,
          nine one-syllable words = 17 syllables:
          0.39 * 13 + 11.8 * 17/13 - 15.59 = 4.911 */
    expect(
      Math.abs(fleschKincaidGrade("My brother and I walked to the old river each morning before school.") - 4.911)
    ).toBeLessThanOrEqual(0.5);
  });

  it("scores text with no words as 0", () => {
    /* MUTATION: drop the `words.length === 0` guard -> red (NaN). */
    expect(fleschKincaidGrade("")).toBe(0);
    expect(fleschKincaidGrade(" -- ")).toBe(0);
  });
});

describe("speakability (MQ-17) and filler (MQ-18)", () => {
  it("speakability counts digits, URLs, acronyms, brackets and spokenLineErrors hits per 100 words", () => {
    /* MUTATION: drop `acronyms` from the total -> red. */
    const s = speakability("The NASA team (and the FAA) spent 40 years. See https://example.org now.");
    expect(s).toMatchObject({ digits: 1, urls: 1, acronyms: 2, brackets: 1 });
    /* spokenLineErrors on sentence 1: the digit; sentence 2: the URL leak. */
    expect(s.lineErrors).toBe(2);
    expect(s.words).toBe(12);
    expect(s.per100).toBeCloseTo((100 * 7) / 12, 10);
    expect(speakability("").per100).toBe(0);
  });

  it("filler counts -ly adverbs past a stoplist, passives, banned words and openers, and questions", () => {
    /* MUTATION: empty LY_STOPLIST -> red ("only", "early" count); drop the
       PASSIVE_STOPLIST check -> red ("were even" counts). */
    const f = filler(
      "Of course the plan was quickly abandoned. It is often said only early risers win. Was it fascinating? The bridge is often closed. They were even happier."
    );
    expect(f.lyAdverbs).toBe(1);
    expect(f.passives).toBe(2);
    /* "it is often said" (hedge), "fascinating" (adjective), "Of course" (opener). */
    expect(f.banned).toBe(3);
    expect(f.questions).toBe(1);
    expect(f.words).toBe(27);
    expect(f.per100).toBeCloseTo((100 * 7) / 27, 10);
  });
});
