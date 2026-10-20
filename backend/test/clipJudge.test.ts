import { describe, expect, it } from "vitest";
import {
  CLIP_JUDGE_PURPOSE,
  CLIP_QUESTIONS,
  CLIP_SCORE_LEVELS,
  CodeProxyClipJudge,
  JevClipJudge,
  NullClipJudge,
  clipLevelFor,
  clipScoresFromResult,
  codeProxyLevel,
  createClipJudge,
  subjectSentenceFor,
  type ClipQuestion
} from "../src/generation/clipJudge";
import { readGateConfig } from "../src/generation/gateConfig";
import { NullJevClient, meteredJevClient } from "../src/generation/jevClient";
import { UnitBudgetExceededError, UnitBudgetGuard } from "../src/cost/unitBudget";
import { PRE_SPINE_SENTINEL, preSpineIntent } from "../src/generation/preSpineIntent";
import { BudgetExceededError, type BudgetGuard } from "../src/cost/budgetGuard";
import type { JevClient, JevResult } from "../src/generation/jevTypes";
import { FakeJevClient, scoreAnswer } from "./helpers/fakeJevClient";

/**
 * GV-79 (W5-03, MQ-05): the clip-on-subject judge. Every judge here is a
 * fake or the keyless code proxy: no test reaches Jev, the Spark or any
 * network model.
 */

const SUBJECT = "germ theory (how doctors came to accept that microbes cause disease)";

function q(key: string, windowText: string, claim = "Microbes, not miasma, cause infection."): ClipQuestion {
  return { key, subjectSentence: SUBJECT, claim, windowText };
}

function recordingGuard(): BudgetGuard & { events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    async checkAndRecord(event: Record<string, unknown>) {
      events.push(event);
    }
  } as unknown as BudgetGuard & { events: Array<Record<string, unknown>> };
}

describe("GV-79 subjectSentenceFor", () => {
  /* MUTATION THAT KILLS THIS: read intent.subject before spine.subject. Ran
     it: red on the first and the fold case. */
  it("is the spine's subject (angle), never the intent's when the spine has them", () => {
    expect(subjectSentenceFor({ subject: "germ theory", angle: "how microbes were accepted" }, { subject: "germs", angle: "x" })).toBe(
      "germ theory (how microbes were accepted)"
    );
  });

  it("falls back to the intent per missing spine field, and drops an angle that only repeats the subject", () => {
    expect(subjectSentenceFor({ subject: "germ theory" }, { subject: "germs", angle: "the long fight" })).toBe("germ theory (the long fight)");
    expect(subjectSentenceFor(null, { subject: "germs", angle: "the long fight" })).toBe("germs (the long fight)");
    expect(subjectSentenceFor({ subject: "germ theory", angle: "germ theory" }, null)).toBe("germ theory");
  });

  it("fold-on: the keyword intent with sentinels never reaches the sentence while the spine has its fields", () => {
    const intent = preSpineIntent("tell me about the germ theory of disease and Semmelweis")!;
    const sentence = subjectSentenceFor({ subject: "Germ theory", angle: "the doctors who resisted it" }, intent);
    expect(sentence).toBe("Germ theory (the doctors who resisted it)");
    expect(sentence).not.toContain(intent.subject);
    expect(sentence).not.toContain(PRE_SPINE_SENTINEL);
  });
});

describe("GV-79 clipScoresFromResult", () => {
  const ok = (answers: Array<{ id: string; score: number; confidence?: number }>, judge?: "jev" | "qwen"): JevResult => ({
    ok: true,
    answers: answers.map((a) => ({ ...scoreAnswer(a.score, CLIP_SCORE_LEVELS, a.confidence ?? 1), id: a.id })),
    model: "m",
    modelMismatch: false,
    usage: { inputTokens: null, outputTokens: null },
    requestId: null,
    latencyMs: 0,
    ...(judge ? { judge } : {})
  });

  /* MUTATION THAT KILLS THIS: swap the two answer ids in the read. Ran it:
     red. */
  it("reads both Scores by id, the lower confidence, and the answering judge (Jev when untagged)", () => {
    expect(clipScoresFromResult(ok([{ id: "claim", score: 1, confidence: 0.4 }, { id: "subject", score: 3, confidence: 0.9 }]))).toEqual({
      subject: 3,
      claim: 1,
      confidence: 0.4,
      judge: "jev"
    });
    expect(clipScoresFromResult(ok([{ id: "subject", score: 4 }, { id: "claim", score: 4 }], "qwen"))).toMatchObject({ judge: "qwen" });
  });

  it("fails closed: an outage or a missing answer is unavailable, never a score", () => {
    expect(clipScoresFromResult({ ok: false, error: { category: "no_key", reason: "no_key" }, latencyMs: 0 })).toEqual({ unavailable: "no_key" });
    expect(clipScoresFromResult(ok([{ id: "subject", score: 4 }]))).toEqual({ unavailable: "malformed" });
  });

  it("clamps an out-of-range score to the 0..4 card", () => {
    expect(clipScoresFromResult(ok([{ id: "subject", score: 7 }, { id: "claim", score: -1 }]))).toMatchObject({ subject: 4, claim: 0 });
  });
});

describe("GV-79 JevClipJudge", () => {
  /* MUTATION THAT KILLS THIS: send the subject sentence as `passage` (or
     drop the claim from the state). Ran it: red. */
  it("asks once per clip, with {subject, claim, passage} and the two 5-level Score questions, under 'clip-judge'", async () => {
    const fake = new FakeJevClient({ rules: [{ when: () => true, answer: scoreAnswer(4, CLIP_SCORE_LEVELS) }] });
    const judge = new JevClipJudge(fake);
    const out = await judge.score([q("0:0:0", "Pasteur showed the microbes."), q("0:0:1", "Koch grew the bacillus.")]);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls.every((c) => c.purpose === CLIP_JUDGE_PURPOSE)).toBe(true);
    expect(fake.calls[0]!.state).toEqual({ subject: SUBJECT, claim: "Microbes, not miasma, cause infection.", passage: "Pasteur showed the microbes." });
    expect(fake.calls[0]!.questions.map((x) => [x.id, x.type, x.type === "score" ? x.criteria.length : 0])).toEqual([
      ["subject", "score", 5],
      ["claim", "score", 5]
    ]);
    expect(CLIP_QUESTIONS.map((x) => x.instructions)).toEqual([
      "How much is `passage` about `subject`?",
      "How directly does `passage` make the point in `claim`?"
    ]);
    expect(out.get("0:0:1")).toEqual({ subject: 4, claim: 4, confidence: 1, judge: "jev" });
  });

  it("a clip Jev could not answer is unavailable; the others are still scored", async () => {
    const fake = new FakeJevClient({
      rules: [{ when: () => true, answer: scoreAnswer(3, CLIP_SCORE_LEVELS) }],
      fail: (state) => ((state as { passage: string }).passage === "down" ? { category: "http", reason: "http_503" } : undefined)
    });
    const out = await new JevClipJudge(fake).score([q("a", "down"), q("b", "up")]);
    expect(out.get("a")).toEqual({ unavailable: "http_503" });
    expect(out.get("b")).toMatchObject({ subject: 3, claim: 3 });
  });

  /* MUTATION THAT KILLS THIS: swallow every throw as 'threw'. Ran it: red
     (the budget stop no longer propagates). */
  it("a budget stop propagates; any other throw is that clip unscored", async () => {
    const budget: JevClient = { ask: async () => Promise.reject(new BudgetExceededError(1, 0.1, 1)) };
    await expect(new JevClipJudge(budget).score([q("a", "x")])).rejects.toBeInstanceOf(BudgetExceededError);
    const broken: JevClient = { ask: async () => Promise.reject(new Error("boom")) };
    expect((await new JevClipJudge(broken).score([q("a", "x")])).get("a")).toEqual({ unavailable: "threw" });
  });
});

describe("GV-124: the jevCalls cap stops the run instead of leaving the clips unscored (#1413 item 3)", () => {
  /* MUTATION THAT KILLS THIS: re-throw findBudgetError only (the GV-90
     catch). Ran it: red (the refused clip comes back { unavailable:
     "threw" } and the score resolves). */
  it("a UnitBudgetExceededError from the metered client propagates out of score()", async () => {
    const fake = new FakeJevClient({ rules: [{ when: () => true, answer: scoreAnswer(4, CLIP_SCORE_LEVELS) }] });
    const unitGuard = new UnitBudgetGuard({ overrides: { jevCalls: 1 } });
    const metered = meteredJevClient(fake, { guard: recordingGuard(), userId: "founder-1", sessionId: "gv124-clips", unitGuard, tier: "short" });
    const err = await new JevClipJudge(metered).score([q("a", "one"), q("b", "two")]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnitBudgetExceededError);
    expect((err as UnitBudgetExceededError).unit).toBe("jevCalls");
    /* The cap held: one ask went to Jev, the second was never sent. */
    expect(fake.calls).toHaveLength(1);
    expect(unitGuard.spent("gv124-clips").jevCalls).toBe(1);
    /* Wrapped (as a pool or act wrapper may), it still propagates. */
    const wrapped: JevClient = { ask: async () => Promise.reject(new Error("pool", { cause: new UnitBudgetExceededError("s", "jevCalls", 1, 1, 1) })) };
    await expect(new JevClipJudge(wrapped).score([q("a", "x")])).rejects.toThrow("pool");
  });
});

describe("GV-79 CodeProxyClipJudge", () => {
  /* MUTATION THAT KILLS THIS: change a cut-point (0.3 -> 0.35). Ran it: red. */
  it("maps a share to 0..4 at 0.05 / 0.15 / 0.3 / 0.5", () => {
    expect([0, 0.049, 0.05, 0.149, 0.15, 0.299, 0.3, 0.499, 0.5, 1].map(codeProxyLevel)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  /* MUTATION THAT KILLS THIS: score the subject from the claim's terms.
     Ran it: red (the off-subject clip's subject level rises). */
  it("scores an on-subject clip high and an off-subject one low, always as judge 'code'", async () => {
    /* On the subject, but not making this claim: the two Scores part. */
    const onSubject = q(
      "on",
      "Germ theory says microbes cause disease; doctors came to accept it once Pasteur and Koch showed the microbes at work.",
      "Handwashing halved maternal deaths in Vienna."
    );
    const offSubject = q("off", "Cyclospora outbreaks follow imported produce and lettuce washing in the summer months.", "Doctors resisted germ theory.");
    const out = await new CodeProxyClipJudge().score([onSubject, offSubject]);
    const on = out.get("on")!;
    const off = out.get("off")!;
    expect("judge" in on && on.judge).toBe("code");
    expect("subject" in on && on.subject).toBeGreaterThanOrEqual(3);
    expect("claim" in on && on.claim).toBe(0);
    expect("subject" in off && off.subject).toBeLessThanOrEqual(1);
    expect("claim" in off && off.claim).toBe(0);
  });

  it("a sentence with no content terms is unavailable, not a zero", async () => {
    const out = await new CodeProxyClipJudge().score([{ key: "x", subjectSentence: "the and of", claim: "it is", windowText: "germs" }]);
    expect(out.get("x")).toEqual({ unavailable: "no-terms" });
  });
});

describe("GV-79 createClipJudge and clipLevelFor", () => {
  const gates = readGateConfig({});

  it("defaults off: FORAY_CLIP_JUDGE is 'off' unless set, and off builds the null judge", async () => {
    expect(gates.clipJudge).toBe("off");
    expect(readGateConfig({ FORAY_CLIP_JUDGE: "shadow" }).clipJudge).toBe("shadow");
    expect(() => readGateConfig({ FORAY_CLIP_JUDGE: "loud" })).toThrow(/FORAY_CLIP_JUDGE/);
    const judge = createClipJudge(gates, new FakeJevClient());
    expect(judge).toBeInstanceOf(NullClipJudge);
    expect((await judge.score([q("a", "x")])).get("a")).toEqual({ unavailable: "off" });
  });

  /* MUTATION THAT KILLS THIS: return JevClipJudge whenever a client is
     passed. Ran it: red (a NullJevClient would score every clip
     unavailable instead of falling back to the proxy). */
  it("no judge key (NullJevClient or none) is the code proxy; a client that can answer is Jev, metered per ask", async () => {
    const shadow = { clipJudge: "shadow" as const };
    expect(createClipJudge(shadow, new NullJevClient())).toBeInstanceOf(CodeProxyClipJudge);
    expect(createClipJudge(shadow, undefined)).toBeInstanceOf(CodeProxyClipJudge);
    const guard = recordingGuard();
    const fake = new FakeJevClient({ rules: [{ when: () => true, answer: scoreAnswer(2, CLIP_SCORE_LEVELS) }] });
    const judge = createClipJudge({ clipJudge: "enforce" }, fake, { meter: { guard, userId: "u1", sessionId: "s1" } });
    expect(judge).toBeInstanceOf(JevClipJudge);
    await judge.score([q("a", "x"), q("b", "y")]);
    expect(guard.events).toHaveLength(2);
    expect(guard.events[0]).toMatchObject({ userId: "u1", sessionId: "s1", provider: "jev", operation: CLIP_JUDGE_PURPOSE });
  });

  /* MUTATION THAT KILLS THIS: read clipLevel.jev for a Qwen answer. Ran it:
     red. */
  it("reads each judge's own level key, and 3 for the code proxy", () => {
    const g = readGateConfig({ FORAY_CLIP_LEVEL_JEV: "2", FORAY_CLIP_LEVEL_QWEN: "4" });
    expect(clipLevelFor(g, "jev")).toBe(2);
    expect(clipLevelFor(g, "qwen")).toBe(4);
    expect(clipLevelFor(g, "code")).toBe(3);
  });
});
