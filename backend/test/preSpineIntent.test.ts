import { describe, it, expect } from "vitest";
import {
  PRE_SPINE_MAX_KEYWORDS,
  PRE_SPINE_NO_KEYWORDS,
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
    const intent = preSpineIntent(PROMPT);
    expect(intent.subject).toBe("ford motor company turn sawdust charcoal briquettes");
    expect(intent.angle).toBe(intent.subject);
  });

  it("keeps at most 12 keywords", () => {
    /* MUTATION THAT KILLS THIS: drop the `out.length >= max` break. Ran it: red. */
    const words = Array.from({ length: 20 }, (_, i) => `keyword${String.fromCharCode(97 + i)}`);
    const keywords = preSpineKeywords(words.join(" "));
    expect(PRE_SPINE_MAX_KEYWORDS).toBe(12);
    expect(keywords).toEqual(words.slice(0, 12));
    expect(preSpineIntent(words.join(" ")).subject.split(" ")).toHaveLength(12);
  });

  it("fills priorKnowledge and disappointment with the sentinel and carries no title or summary", () => {
    /* MUTATION THAT KILLS THIS: set priorKnowledge to the subject. Ran it: red. */
    const intent = preSpineIntent(PROMPT);
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

  it("never holds the prompt verbatim, on any field", () => {
    /* MUTATION THAT KILLS THIS: return `subject: prompt` in preSpineIntent.
       Ran it: red. */
    for (const prompt of [PROMPT, "The Siege of Masada, 73 AD", "why do octopuses dream in colour at night"]) {
      const banked = JSON.stringify(preSpineIntent(prompt));
      expect(banked).not.toContain(prompt);
      expect(banked).not.toContain(JSON.stringify(prompt).slice(1, -1));
    }
  });

  it("falls back to a fixed subject, never the prompt, when the prompt has no sourcing keyword", () => {
    /* MUTATION THAT KILLS THIS: join the empty keyword list (subject ""),
       which IntentUnderstandingSchema refuses. Ran it: red. */
    const intent = preSpineIntent("is it on?");
    expect(intent.subject).toBe(PRE_SPINE_NO_KEYWORDS);
    expect(IntentUnderstandingSchema.safeParse(intent).success).toBe(true);
    expect(provisionalTitle("is it on?")).toBe(PROVISIONAL_TITLE_FALLBACK);
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
    expect(result).toEqual({ outcome: "understood", intent: preSpineIntent(PROMPT) });

    /* The classic path is unchanged: clarity, then intent. */
    const classic = recordingUnderstander();
    await understandPrompt(PROMPT, classic.understander, ctx);
    expect(classic.calls).toEqual(["assessClarity", "extractIntent"]);
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
