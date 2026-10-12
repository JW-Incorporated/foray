import { describe, it, expect } from "vitest";
import {
  CodeOverlapSupportJudge,
  JevSentenceSupportJudge,
  candidateSourcesFor,
  isSupportUnavailable,
  passageAround,
  readSupportAnswers,
  statementSentences,
  supportQuestions,
  SUPPORT_JEV_PURPOSE,
  type SupportSource
} from "../src/generation/sentenceSupport";
import { hasDeclarativeSentence, isStatementSentence } from "../src/types/narration";
import type { JevAnswer, JevClient, JevResult } from "../src/generation/jevTypes";
import { FakeJevClient, choiceAnswer, noulAnswer } from "./helpers/fakeJevClient";

/**
 * GV-27 (docs/roadmap/generation-v2.md, from W5-08): the per-sentence support
 * judge. Offline only: synthetic texts, FakeJevClient and hand-written
 * JevClient fakes; no test reaches Jev, the Spark or LiteLLM. Each test names
 * the one-line mutation (to sentenceSupport.ts or narration.ts) that turns it
 * red.
 */

const src = (id: string, text: string, kind: SupportSource["kind"] = "doc"): SupportSource => ({
  id,
  kind,
  text,
  publication: `pub-${id}`
});

const totalChars = (sources: readonly SupportSource[]): number => sources.reduce((n, s) => n + s.text.length, 0);

/** A synthetic 30-minute clip transcript (~25k characters): one filler
 * sentence pattern per minute, with a distinctive event at minute 12. */
function thirtyMinuteClip(): { text: string; minute12: string } {
  const minute12 = "At minute twelve the Hoover cofferdam flooded and Kaiser ordered the turbines stopped.";
  const parts: string[] = [];
  for (let minute = 0; minute < 30; minute += 1) {
    const filler: string[] = [];
    while (filler.join(" ").length < 800) {
      filler.push(`The host talks about gardening tomatoes and compost in segment ${minute} again.`);
    }
    if (minute === 12) filler.splice(5, 0, minute12);
    parts.push(filler.join(" "));
  }
  return { text: parts.join(" "), minute12 };
}

describe("isStatementSentence (narration.ts)", () => {
  /* Mutation: drop the `/[?]\s*$/` check in isStatementSentence -> a
     question counts as a statement. */
  it("is false for a question, a short line and a listener imperative, true for a statement", () => {
    expect(isStatementSentence("Why did the dam fail so fast?")).toBe(false);
    expect(isStatementSentence("It failed.")).toBe(false);
    expect(isStatementSentence("Listen to what the engineer says next.")).toBe(false);
    expect(isStatementSentence("The dam failed in March 1928.")).toBe(true);
  });

  /* Mutation: in hasDeclarativeSentence, `return true` when
     isStatementSentence is false -> the two disagree. */
  it("is the per-sentence rule hasDeclarativeSentence applies", () => {
    for (const s of ["Why did it fail?", "Hold on.", "Notice the silence in the room.", "The engineers knew by noon."]) {
      expect(hasDeclarativeSentence(s)).toBe(isStatementSentence(s));
    }
    expect(hasDeclarativeSentence("Why did it fail? The engineers knew by noon.")).toBe(true);
    expect(hasDeclarativeSentence("Why did it fail? Listen to the tape.")).toBe(false);
  });
});

describe("statementSentences", () => {
  /* Mutation: split on /(?<=[.!?])\s+/ instead of splitSpokenSentences ->
     "Dr." ends a sentence and "Dr." / "Mulholland ..." come back apart. */
  it("splits with splitSpokenSentences and keeps only statements", () => {
    const text = "Dr. Mulholland inspected the dam that morning. Was it safe? Listen to his answer. It held until midnight.";
    expect(statementSentences(text)).toEqual(["Dr. Mulholland inspected the dam that morning.", "It held until midnight."]);
  });
});

describe("passageAround", () => {
  /* Mutation: `if (src.length <= limit) return src;` -> `< limit`: a text
     exactly at budget goes through the window search and comes back
     trimmed instead of untouched. */
  it("returns a text within budget whole and untouched", () => {
    const t = "  The dam failed. Water reached the town.  ";
    expect(passageAround(t, "dam failed", t.length)).toBe(t);
    expect(passageAround(t, "dam failed", 1000)).toBe(t);
  });

  /* Mutation: return src.slice(0, limit) after the budget check (no window
     search) -> the minute-12 sentence is far past the first 2,000 chars. */
  it("picks the window densest in the sentence's terms", () => {
    const { text, minute12 } = thirtyMinuteClip();
    const out = passageAround(text, "Kaiser stopped the turbines after the Hoover cofferdam flooded.", 2000);
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out).toContain(minute12);
    expect(text.includes(out)).toBe(true);
  });

  /* Mutation: delete the sentence-snapped loop (`for (const start of
     starts)`) -> only word-edged windows remain and the passage stops
     mid-sentence. */
  it("snaps the window to sentence edges", () => {
    const sentences = Array.from({ length: 40 }, (_, i) => `Sentence ${i} talks about weather and harvest patterns today.`);
    sentences[20] = "The levee at Greenville broke on April twenty first.";
    const text = sentences.join(" ");
    const out = passageAround(text, "The Greenville levee broke.", 300);
    expect(out).toContain("The levee at Greenville broke on April twenty first.");
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out).toMatch(/^[A-Z]/);
    expect(out).toMatch(/[.!?]$/);
    expect(sentences.some((s) => out.startsWith(s))).toBe(true);
  });

  /* Mutation: delete the word-edged fallback loop (`for (const at of
     centres)`) -> an unpunctuated transcript falls back to its first
     `budget` characters and loses the match. */
  it("falls back to word edges when no whole sentence fits", () => {
    const words: string[] = [];
    for (let i = 0; i < 2000; i += 1) words.push(i === 1500 ? "semmelweis" : "uh");
    const text = words.join(" ");
    const out = passageAround(text, "Semmelweis washed his hands.", 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).toContain("semmelweis");
    expect(text.includes(out)).toBe(true);
    expect(out).toMatch(/^\S.*\S$/);
  });
});

describe("candidateSourcesFor", () => {
  /* Mutation: shareBudget gives every source `total` (out[i] = len) ->
     the 25k-character clip is returned whole and the set exceeds 8,000. */
  it("keeps a 30-minute clip's minute-12 passage inside 8,000 characters", () => {
    const { text, minute12 } = thirtyMinuteClip();
    expect(text.length).toBeGreaterThan(20000);
    const sentence = "Kaiser stopped the turbines when the Hoover cofferdam flooded.";
    const out = candidateSourcesFor(sentence, [src("clip-1", text, "clip"), src("doc-1", "Kaiser ran the Hoover works.")]);
    expect(totalChars(out)).toBeLessThanOrEqual(8000);
    const clip = out.find((s) => s.id === "clip-1")!;
    expect(clip.text).toContain(minute12);
    expect(clip.kind).toBe("clip");
    expect(clip.publication).toBe("pub-clip-1");
    expect(out.find((s) => s.id === "doc-1")!.text).toBe("Kaiser ran the Hoover works.");
  });

  /* Mutation: build `chosen` from `ranked` only (drop `pinned`) -> the
     zero-overlap selected claim is missing. */
  it("always includes mustInclude, whatever its overlap", () => {
    const sources = [
      src("c-selected", "Zero shared vocabulary here whatsoever.", "claim"),
      src("d1", "The levee broke at Greenville."),
      src("d2", "Greenville flooded when the levee broke in April.")
    ];
    const out = candidateSourcesFor("The Greenville levee broke in April.", sources, { mustInclude: ["c-selected"], maxSources: 1 });
    expect(out.map((s) => s.id)).toEqual(["c-selected", "d2"]);
  });

  /* Mutation: rank by occurrence count instead of distinct overlap (count
     every token hit) -> the source repeating 'levee' wins. */
  it("ranks by DISTINCT term overlap, drops zero-overlap sources, honours maxSources", () => {
    const sources = [
      src("repeat", "levee levee levee levee levee levee levee levee"),
      src("none", "Nothing in common at all."),
      src("distinct", "Greenville levee broke during April."),
      src("two", "Greenville in April.")
    ];
    const out = candidateSourcesFor("The Greenville levee broke in April.", sources, { maxSources: 2 });
    expect(out.map((s) => s.id)).toEqual(["distinct", "two"]);
    const all = candidateSourcesFor("The Greenville levee broke in April.", sources, { maxSources: 10 });
    expect(all.map((s) => s.id)).toEqual(["distinct", "two", "repeat"]);
  });

  /* Mutation: in shareBudget use `Math.floor(total / lengths.length)` for
     every source (no redistribution) -> the short source's spare budget is
     wasted and the long source is cut harder than it needs to be. */
  it("shares the budget so short sources stay whole and long ones get the rest", () => {
    const longText = Array.from({ length: 200 }, (_, i) => `Levee report line ${i} for Greenville.`).join(" ");
    const out = candidateSourcesFor("Greenville levee", [src("short", "Greenville levee."), src("long", longText)], { maxChars: 1000 });
    expect(out[0]!.text).toBe("Greenville levee.");
    expect(out[1]!.text.length).toBeGreaterThan(900);
    expect(totalChars(out)).toBeLessThanOrEqual(1000);
  });
});

describe("JevSentenceSupportJudge", () => {
  const sources = [src("claim-7", "The levee broke at Greenville on April 21.", "claim"), src("clip-3", "We watched the levee go.", "clip")];

  /* Mutation: `restsOn: sources[at + 1]?.id` in readSupportAnswers -> s2
     maps to the wrong source. */
  it("maps the noul to p and the choice to the real source id, with source ids kept local", async () => {
    const jev = new FakeJevClient({
      byId: { supported: noulAnswer(0.83), restsOn: choiceAnswer("s2", { s1: 0.2, s2: 0.7, none: 0.1 }) }
    });
    const judge = new JevSentenceSupportJudge(jev);
    const out = await judge.judge([{ id: "a0:s3", sentence: "The levee broke.", sources }]);
    expect(out.get("a0:s3")).toEqual({ p: 0.83, restsOn: "clip-3" });
    expect(jev.calls).toHaveLength(1);
    const call = jev.calls[0]!;
    expect(call.purpose).toBe(SUPPORT_JEV_PURPOSE);
    expect(call.state).toEqual({ sentence: "The levee broke.", sources: { s1: sources[0]!.text, s2: sources[1]!.text } });
    expect(JSON.stringify(call.state)).not.toContain("claim-7");
    const [noul, choice] = call.questions;
    expect(noul).toMatchObject({ id: "supported", type: "noul" });
    expect(noul!.type === "noul" && noul!.criteria.true).toBe(
      "Every statement of fact in `sentence` is backed by at least one of `sources`, read literally."
    );
    expect(noul!.type === "noul" && noul!.criteria.false).toBe("Some statement in `sentence` is not in `sources`.");
    expect(choice).toMatchObject({ id: "restsOn", type: "choice" });
    expect(Object.keys(choice!.type === "choice" ? choice!.criteria : {})).toEqual(["s1", "s2", "none"]);
  });

  /* Mutation: `if (restsOn.choice === SUPPORT_NONE) return { p, restsOn: SUPPORT_NONE }`
     -> 'none' leaks out as a source id. */
  it("leaves restsOn absent when Jev chooses none", async () => {
    const jev = new FakeJevClient({
      byId: { supported: noulAnswer(0.1), restsOn: choiceAnswer("none", { s1: 0.05, s2: 0.05, none: 0.9 }) }
    });
    const out = await new JevSentenceSupportJudge(jev).judge([{ id: "x", sentence: "The mayor resigned.", sources }]);
    expect(out.get("x")).toEqual({ p: 0.1 });
  });

  /* Mutation: on `!result.ok` return { p: 0 } -> an unavailable Jev reads
     as "not supported". */
  it("returns {unavailable} when the ask fails", async () => {
    const jev = new FakeJevClient({ fail: { category: "no_key", reason: "no_key" } });
    const out = await new JevSentenceSupportJudge(jev).judge([{ id: "x", sentence: "The levee broke.", sources }]);
    const v = out.get("x")!;
    expect(isSupportUnavailable(v)).toBe(true);
    expect(v).toEqual({ unavailable: true, reason: "no_key" });
  });

  /* Mutation: drop `p < 0 || p > 1` from readSupportAnswers -> a noul of
     1.4 comes back as a verdict. */
  it("returns {unavailable} for answers that do not fit the questions", async () => {
    const keys = ["s1", "s2"];
    const bad: JevAnswer[][] = [
      [{ id: "supported", type: "noul", noul: 1.4 }, { id: "restsOn", type: "choice", choice: "s1", probabilities: {}, confidence: 1 }],
      [{ id: "supported", type: "noul", noul: 0.9 }, { id: "restsOn", type: "choice", choice: "s9", probabilities: {}, confidence: 1 }],
      [{ id: "supported", type: "noul", noul: 0.9 }],
      [{ id: "restsOn", type: "choice", choice: "s1", probabilities: {}, confidence: 1 }],
      [{ id: "supported", type: "score", score: 1, legend: null, probabilities: {}, confidence: 1 }, { id: "restsOn", type: "choice", choice: "s1", probabilities: {}, confidence: 1 }]
    ];
    for (const answers of bad) {
      expect(readSupportAnswers(answers, keys, sources)).toEqual({ unavailable: true, reason: "malformed_answer" });
    }
    /* Through the judge: a client whose ok reply carries a malformed answer. */
    const sloppy: JevClient = {
      async ask(): Promise<JevResult> {
        return {
          ok: true,
          answers: bad[0]!,
          model: "jev-1.13.0",
          modelMismatch: false,
          usage: { inputTokens: null, outputTokens: null },
          requestId: null,
          latencyMs: 0
        };
      }
    };
    const out = await new JevSentenceSupportJudge(sloppy).judge([{ id: "x", sentence: "The levee broke.", sources }]);
    expect(out.get("x")).toEqual({ unavailable: true, reason: "malformed_answer" });
  });

  /* Mutation: `this.pool = client` (no createJevPool) -> all 20 asks run at
     once. */
  it("keeps at most 8 asks in flight", async () => {
    let running = 0;
    let peak = 0;
    const slow: JevClient = {
      async ask(_state, questions): Promise<JevResult> {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running -= 1;
        return {
          ok: true,
          answers: [
            { id: questions[0]!.id, type: "noul", noul: 0.5 },
            { id: questions[1]!.id, type: "choice", choice: "s1", probabilities: { s1: 1, none: 0 }, confidence: 1 }
          ],
          model: "jev-1.13.0",
          modelMismatch: false,
          usage: { inputTokens: null, outputTokens: null },
          requestId: null,
          latencyMs: 5
        };
      }
    };
    const items = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, sentence: "The levee broke.", sources: [sources[0]!] }));
    const out = await new JevSentenceSupportJudge(slow).judge(items);
    expect(peak).toBe(8);
    expect(out.size).toBe(20);
    expect(out.get("s19")).toEqual({ p: 0.5, restsOn: "claim-7" });
  });

  /* Mutation: delete the `item.sources.length === 0` early return -> a
     one-option choice is asked (and FakeJevClient records a call). */
  it("judges a sentence with no sources as p 0 without asking, and refuses duplicate ids", async () => {
    const jev = new FakeJevClient({ byId: {} });
    const judge = new JevSentenceSupportJudge(jev);
    const out = await judge.judge([{ id: "x", sentence: "The levee broke.", sources: [] }]);
    expect(out.get("x")).toEqual({ p: 0 });
    expect(jev.calls).toHaveLength(0);
    await expect(
      judge.judge([
        { id: "d", sentence: "a b c", sources: [] },
        { id: "d", sentence: "d e f", sources: [] }
      ])
    ).rejects.toThrow(/duplicate item id 'd'/);
    expect(supportQuestions(["s1"])[1].criteria).toHaveProperty("none");
  });
});

describe("CodeOverlapSupportJudge", () => {
  /* Mutation: `const p = distinctOverlap(terms, s.text)` (drop
     `/ terms.size`) -> p is a count, not a share. */
  it("scores the share of content words found in the best source", async () => {
    const judge = new CodeOverlapSupportJudge();
    const out = await judge.judge([
      {
        id: "a",
        sentence: "The Greenville levee broke in April.",
        sources: [src("d1", "Greenville flooded."), src("d2", "The Greenville levee broke.")]
      },
      { id: "b", sentence: "Mulholland resigned.", sources: [src("d1", "Greenville flooded.")] },
      { id: "c", sentence: "It is.", sources: [src("d1", "It is.")] }
    ]);
    /* content terms: greenville, levee, broke, april -> d2 holds three. */
    expect(out.get("a")).toEqual({ p: 0.75, restsOn: "d2" });
    expect(out.get("b")).toEqual({ p: 0 });
    expect(out.get("c")).toEqual({ p: 0 });
    expect(judge.name).toBe("code-overlap");
  });
});
