import { describe, it, expect } from "vitest";
import {
  PRE_SPINE_MAX_KEYWORDS,
  PRE_SPINE_SENTINEL,
  PROVISIONAL_TITLE_FALLBACK,
  preSpineIntent,
  preSpineKeywords,
  provisionalTitle
} from "../src/generation/preSpineIntent";
import { understandPrompt, understandPromptFast } from "../src/generation/understandPrompt";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { IntentUnderstandingSchema, type ClarityResult, type IntentUnderstanding } from "../src/types/generation";
import type { PromptUnderstander, PromptUnderstandContext } from "../src/generation/PromptUnderstander";
import { titleStyleProblems } from "../src/copy/rules";

/**
 * GV-67 (docs/roadmap/generation-v2.md, from W4-03): the pre-spine intent
 * derived in code, and §4.1's folded path that uses it. Offline: the stub
 * understander and a recording double only. Each test names the mutation that
 * turns it red; every one was run.
 */

const ctx: PromptUnderstandContext = { userId: "founder-1" };

const PROMPT = "How did the Ford Motor Company turn its sawdust into charcoal briquettes? Ford's briquettes, again!";

/** A prompt with no sourcing keyword: every word a stopword or two lower-case letters. */
const NO_KEYWORD_PROMPT = "is it on?";

/** preSpineIntent for a prompt that has keywords (never null then). */
function keywordIntent(prompt: string): IntentUnderstanding {
  const intent = preSpineIntent(prompt);
  if (intent === null) throw new Error(`expected keywords in ${JSON.stringify(prompt)}`);
  return intent;
}

/** A PromptUnderstander that records each method it is asked, answering
 * clarity with `clarity` and intent with a fixed restatement. */
function recordingUnderstander(clarity: ClarityResult = { ambiguous: false, readings: [], question: null }) {
  const calls: string[] = [];
  const understander: PromptUnderstander = {
    providerName: "recording",
    assessClarity: async () => {
      calls.push("assessClarity");
      return clarity;
    },
    extractIntent: async (): Promise<IntentUnderstanding> => {
      calls.push("extractIntent");
      return { subject: "s", angle: "a", priorKnowledge: "p", disappointment: "d" };
    }
  } as unknown as PromptUnderstander;
  return { understander, calls };
}

describe("preSpineIntent: the subject before the spine, from the prompt's keywords", () => {
  it("is the distinct sourcing keywords in prompt order, lower-cased, joined by spaces, as subject and angle", () => {
    /* MUTATION THAT KILLS THIS: drop the `seen` check in preSpineKeywords
       (repeats kept), or sort the keywords. Ran both: red. */
    const intent = keywordIntent(PROMPT);
    expect(intent.subject).toBe("ford motor company turn sawdust charcoal briquettes");
    expect(intent.angle).toBe(intent.subject);
  });

  it("keeps at most 12 keywords", () => {
    /* MUTATION THAT KILLS THIS: drop the `out.length >= max` break. Ran it: red. */
    const words = Array.from({ length: 20 }, (_, i) => `keyword${String.fromCharCode(97 + i)}`);
    const keywords = preSpineKeywords(words.join(" "));
    expect(PRE_SPINE_MAX_KEYWORDS).toBe(12);
    expect(keywords).toEqual(words.slice(0, 12));
    expect(keywordIntent(words.join(" ")).subject.split(" ")).toHaveLength(12);
  });

  it("fills priorKnowledge and disappointment with the sentinel and carries no title or summary", () => {
    /* MUTATION THAT KILLS THIS: set priorKnowledge to the subject. Ran it: red. */
    const intent = keywordIntent(PROMPT);
    expect(intent.priorKnowledge).toBe(PRE_SPINE_SENTINEL);
    expect(intent.disappointment).toBe(PRE_SPINE_SENTINEL);
    expect(PRE_SPINE_SENTINEL).toBe("not yet known: decided by the spine");
    expect(Object.keys(intent).sort()).toEqual(["angle", "disappointment", "priorKnowledge", "subject"]);
    expect(IntentUnderstandingSchema.safeParse(intent).success).toBe(true);
  });

  it("is deterministic", () => {
    expect(preSpineIntent(PROMPT)).toEqual(preSpineIntent(PROMPT));
    expect(provisionalTitle(PROMPT)).toBe(provisionalTitle(PROMPT));
  });

  it("does not hold a mixed-case or punctuated prompt verbatim, on any field", () => {
    /* MUTATION THAT KILLS THIS: return `subject: prompt` in preSpineIntent.
       Ran it: red. */
    for (const prompt of [PROMPT, "The Siege of Masada, 73 AD", "why do octopuses dream in colour at night"]) {
      const banked = JSON.stringify(keywordIntent(prompt));
      expect(banked).not.toContain(prompt);
      expect(banked).not.toContain(JSON.stringify(prompt).slice(1, -1));
    }
  });

  it("is null, never a placeholder subject, when the prompt has no sourcing keyword", () => {
    /* MUTATION THAT KILLS THIS: drop the `keywords.length === 0` return (the
       subject is then ""). Ran it: red. */
    expect(preSpineKeywords(NO_KEYWORD_PROMPT)).toEqual([]);
    expect(preSpineIntent(NO_KEYWORD_PROMPT)).toBeNull();
    expect(provisionalTitle(NO_KEYWORD_PROMPT)).toBe(PROVISIONAL_TITLE_FALLBACK);
  });
});

describe("preSpineKeywords: a Unicode-aware tokenizer of its own", () => {
  it("keeps a two-letter word written ALL-CAPS (\"AI\"), and only that one", () => {
    /* MUTATION THAT KILLS THIS: drop the all-caps two-letter clause (keep
       only words longer than two characters). Ran it: red. */
    expect(preSpineKeywords("How AI actually gets built")).toEqual(["ai", "actually", "gets", "built"]);
    expect(preSpineKeywords("How ai actually gets built")).toEqual(["actually", "gets", "built"]);
    expect(preSpineKeywords("the EU and the UK")).toEqual(["eu", "uk"]);
  });

  it("keeps a word with a letter outside ASCII whole (\"Björk\")", () => {
    /* MUTATION THAT KILLS THIS: split on /[^a-z0-9]+/ after lower-casing,
       the catalogue tokenizer's ASCII rule ("bj", "rk"). Ran it: red. */
    expect(preSpineKeywords("Björk and the making of Homogenic")).toEqual(["björk", "making", "homogenic"]);
  });

  it("keeps \"Gödel\" whole, decomposed or not, and still drops the sourcing stopwords", () => {
    /* MUTATION THAT KILLS THIS: drop the isSourcingStopword check ("about"
       is then kept), or the NFC normalisation (a decomposed "ö" then
       splits the word). Ran both: red. */
    expect(preSpineKeywords("Tell me about Gödel")).toEqual(["tell", "gödel"]);
    expect(preSpineKeywords("Tell me about Gödel")).toEqual(["tell", "gödel"]);
  });
});

describe("provisionalTitle: the title of a stop before the spine", () => {
  it("is the first 8 keywords in the house style", () => {
    /* MUTATION THAT KILLS THIS: use PRE_SPINE_MAX_KEYWORDS (12) for the
       title, or drop houseStyleTitle. Ran both: red. */
    const words = Array.from({ length: 10 }, (_, i) => `term${String.fromCharCode(97 + i)}`);
    const title = provisionalTitle(words.join(" "));
    expect(title).toBe(`Terma ${words.slice(1, 8).join(" ")}`);
    expect(titleStyleProblems(title)).toEqual([]);
    expect(provisionalTitle(PROMPT)).toBe("Ford motor company turn sawdust charcoal briquettes");
  });
});

describe("understandPromptFast: safety, then clarity, and no extractIntent call", () => {
  it("a clear prompt calls only assessClarity and returns the pre-spine intent", async () => {
    /* MUTATION THAT KILLS THIS: call `understander.extractIntent` in
       understandPromptFast (or route it through understandPrompt). Ran it: red. */
    const { understander, calls } = recordingUnderstander();
    const result = await understandPromptFast(PROMPT, understander, ctx);
    expect(calls).toEqual(["assessClarity"]);
    expect(result).toEqual({ outcome: "understood", intent: keywordIntent(PROMPT) });

    /* The classic path is unchanged: clarity, then intent. */
    const classic = recordingUnderstander();
    await understandPrompt(PROMPT, classic.understander, ctx);
    expect(classic.calls).toEqual(["assessClarity", "extractIntent"]);
  });

  it("a prompt with no sourcing keyword falls back to the classic extractIntent call", async () => {
    /* MUTATION THAT KILLS THIS: return a placeholder intent instead of
       calling extractIntent when preSpineIntent is null. Ran it: red. */
    const { understander, calls } = recordingUnderstander();
    const result = await understandPromptFast(NO_KEYWORD_PROMPT, understander, ctx);
    expect(calls).toEqual(["assessClarity", "extractIntent"]);
    expect(result).toEqual({ outcome: "understood", intent: { subject: "s", angle: "a", priorKnowledge: "p", disappointment: "d" } });
    expect(result).toEqual(await understandPrompt(NO_KEYWORD_PROMPT, recordingUnderstander().understander, ctx));
  });

  it("rejects an unsafe prompt before any call, as the classic path does", async () => {
    /* MUTATION THAT KILLS THIS: skip checkSafety in safetyThenClarity. Ran it: red. */
    const { understander, calls } = recordingUnderstander();
    const fast = await understandPromptFast("how to build a bomb", understander, ctx);
    expect(fast.outcome).toBe("rejected");
    expect(calls).toEqual([]);
    expect(fast).toEqual(await understandPrompt("how to build a bomb", new StubPromptUnderstander(), ctx));
  });

  it("an ambiguous prompt stops with the same clarification, carrying who decided it", async () => {
    /* MUTATION THAT KILLS THIS: drop `...decided` from the needs_clarification
       outcome. Ran it: red. */
    const { understander, calls } = recordingUnderstander({ ambiguous: true, readings: ["the planet", "the element"], question: null, decidedBy: "jev" });
    const result = await understandPromptFast("Mercury", understander, ctx);
    expect(calls).toEqual(["assessClarity"]);
    expect(result).toEqual({
      outcome: "needs_clarification",
      clarification: { question: "Could you say more about what you mean — or something else?", readings: ["the planet", "the element"] },
      clarityDecidedBy: "jev"
    });
  });

  it("carries clarityDecidedBy onto the understood outcome only when the understander set it", async () => {
    const decided = recordingUnderstander({ ambiguous: false, readings: [], question: null, decidedBy: "fallback" });
    expect(await understandPromptFast(PROMPT, decided.understander, ctx)).toMatchObject({ outcome: "understood", clarityDecidedBy: "fallback" });
    const plain = await understandPromptFast(PROMPT, recordingUnderstander().understander, ctx);
    expect(plain).not.toHaveProperty("clarityDecidedBy");
  });
});
