import { describe, it, expect, afterEach } from "vitest";
import {
  BestOfTwoSpineBuilder,
  DEFAULT_SPINE_BEST_OF_GRACE_MS,
  __swapSpineJudgeForTests,
  judgeOrderSwapped,
  renderSpineForJudge,
  spineBestOfLever,
  spineJudgeQuestion,
  spineSampleIssues
} from "../src/generation/bestOfSpine";
import { createSpineBuilder } from "../src/generation/createSpineBuilder";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { PRE_SPINE_SENTINEL, preSpineIntent } from "../src/generation/preSpineIntent";
import { buildSpineWithReasks } from "../src/generation/buildSpine";
import type { SpineBuildContext, SpineBuilder, SpineSelectionRecord } from "../src/generation/SpineBuilder";
import { RoutingConfigError } from "../src/config/stageRouting";
import { FlagValueError } from "../src/generation/generationFlags";
import { BudgetGuard } from "../src/cost/budgetGuard";
import { InMemoryCostEventSink } from "../src/cost/costEvents";
import type { IntentUnderstanding } from "../src/types/generation";
import type { ResearchShape } from "../src/types/research";
import type { DurationTier, Spine } from "../src/types/spine";
import { FakeSpineJudge } from "./helpers/fakeSpineJudge";

/**
 * GV-91 (W7-07, W4-16 folded in): the constrained best-of-2 spine wrapper.
 * OFFLINE: both samplers are StubSpineBuilders behind scripted gates, the
 * judge is the scripted FakeSpineJudge, and the clock and the deadline timer
 * are injected, so no case waits on a real timer or calls a model.
 */

const guard = () => new BudgetGuard(new InMemoryCostEventSink(), 100);

function intent(overrides: Partial<IntentUnderstanding> = {}): IntentUnderstanding {
  return {
    subject: "the history of grilling",
    angle: "how an industrial waste product became a backyard ritual",
    priorKnowledge: "knows charcoal grilling exists",
    disappointment: "stays surface-level and never mentions Ford",
    ...overrides
  };
}

const research: ResearchShape = {
  subject: "the history of grilling",
  angle: "how an industrial waste product became a backyard ritual",
  generatedAt: "2026-10-14T00:00:00.000Z",
  subtopics: [
    {
      label: "Ford briquette scheme",
      source: "semantic-concept",
      tape: { signal: "strong", itemCount: 30, showCount: 5, exampleItemIds: [] },
      controversies: [],
      externalNotes: null,
      externallyResearched: false,
      tapeWindows: [],
      windowsUnavailable: "no transcript text index in this fixture"
    }
  ],
  nonObviousAngle: "how an industrial waste product became a backyard ritual",
  externalGapsResearched: []
};

const ctx: SpineBuildContext = { userId: "founder-1" };

/** A deferred: a promise the test settles. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

/**
 * A fake ms clock and deadline timer. `sleep(ms)` resolves (advancing the
 * clock by ms) only when ms is in `fire`; otherwise it never resolves, so
 * the race is decided by the sample.
 */
function fakeTime(fire: number[] = []) {
  const state = { t: 1000, slept: [] as number[] };
  return {
    state,
    now: () => state.t,
    sleep: (ms: number) => {
      state.slept.push(ms);
      if (!fire.includes(ms)) return new Promise<void>(() => undefined);
      return Promise.resolve().then(() => {
        state.t += ms;
      });
    }
  };
}

/** A Stub spine with a marked overview, released by a gate, or a throw. */
class ScriptedBuilder implements SpineBuilder {
  readonly providerName: string;
  calls = 0;
  revisions = 0;
  private readonly stub: StubSpineBuilder;
  constructor(
    private readonly label: string,
    private readonly opts: { gate?: Promise<void>; throws?: Error; twoSentence?: boolean; onCall?: () => void } = {}
  ) {
    this.providerName = `scripted-${label}`;
    this.stub = new StubSpineBuilder(guard(), opts.twoSentence ? { twoSentenceClaimReplies: 99 } : {});
  }
  async buildSpine(i: IntentUnderstanding, r: ResearchShape, d: DurationTier, c: SpineBuildContext): Promise<Spine> {
    this.calls++;
    if (c.revision) this.revisions++;
    this.opts.onCall?.();
    if (this.opts.gate) await this.opts.gate;
    if (this.opts.throws) throw this.opts.throws;
    const spine = await this.stub.buildSpine(i, r, d, c);
    return { ...spine, overview: `Plan ${this.label}: ${spine.overview}` };
  }
}

function wrapper(primary: SpineBuilder, secondary: SpineBuilder, judge: FakeSpineJudge, time = fakeTime(), graceMs = 3000) {
  return new BestOfTwoSpineBuilder({ primary, secondary, judge, graceMs, judgeTimeoutMs: 5000, now: time.now, sleep: time.sleep });
}

function observed() {
  const records: SpineSelectionRecord[] = [];
  return { records, ctx: { ...ctx, observe: (r: SpineSelectionRecord) => records.push(r) } as SpineBuildContext };
}

/** Session ids whose stable hash keeps / swaps the A/B order. */
function sessionWith(swapped: boolean): string {
  for (let i = 0; i < 64; i++) if (judgeOrderSwapped(`session-${i}`) === swapped) return `session-${i}`;
  throw new Error("no session id found");
}

describe("GV-91: BestOfTwoSpineBuilder chooses between gate-passing samples", () => {
  it("both samples valid: the judge is called once and its choice (1, the second spine) is returned, reason 'judged'", async () => {
    /* MUTATION THAT KILLS THIS: return `a` (the primary) in the judged branch
       regardless of the choice. Ran it: red (overview "Plan A"). */
    const judge = new FakeSpineJudge([{ choose: 1, confidence: 0.8, requestId: "req-1" }]);
    const { records, ctx: c } = observed();
    const out = await wrapper(new ScriptedBuilder("A"), new ScriptedBuilder("B"), judge).buildSpine(intent(), research, "short", c);
    expect(out.overview).toMatch(/^Plan B: /);
    expect(judge.calls).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ chosen: "secondary", reason: "judged", judge: { kind: "fake", outcome: "chose", index: 1, swapped: false, confidence: 0.8, requestId: "req-1" } });
    expect(records[0]!.samples.map((s) => [s.role, s.impl, s.valid, s.late])).toEqual([
      ["primary", "scripted-A", true, false],
      ["secondary", "scripted-B", true, false]
    ]);
  });

  it("the A/B order is a stable hash of the session id, and the choice is mapped back through it", async () => {
    /* MUTATION THAT KILLS THIS: map the presented index straight to the
       sample (`const original = choice.index`). Ran it: red (the swapped
       session returns Plan A). */
    const swappedSession = sessionWith(true);
    expect(judgeOrderSwapped(swappedSession)).toBe(judgeOrderSwapped(swappedSession));
    expect(judgeOrderSwapped(undefined)).toBe(false);
    const judge = new FakeSpineJudge([{ choose: 0 }]);
    const { records, ctx: c } = observed();
    const out = await wrapper(new ScriptedBuilder("A"), new ScriptedBuilder("B"), judge).buildSpine(intent(), research, "short", { ...c, sessionId: swappedSession });
    expect(judge.inputs[0]!.candidates[0]).toMatch(/^Overview: Plan B: /);
    expect(judge.inputs[0]!.candidates[1]).toMatch(/^Overview: Plan A: /);
    expect(out.overview).toMatch(/^Plan B: /);
    expect(records[0]).toMatchObject({ chosen: "secondary", reason: "judged", judge: { swapped: true, index: 0 } });

    const kept = new FakeSpineJudge([{ choose: 0 }]);
    const again = await wrapper(new ScriptedBuilder("A"), new ScriptedBuilder("B"), kept).buildSpine(intent(), research, "short", { ...ctx, sessionId: sessionWith(false) });
    expect(kept.inputs[0]!.candidates[0]).toMatch(/^Overview: Plan A: /);
    expect(again.overview).toMatch(/^Plan A: /);
  });

  it("secondary slower than primary + graceMs: the primary is returned without waiting, reason 'secondary-late', addedMs <= graceMs", async () => {
    /* MUTATION THAT KILLS THIS: await the secondary with no race (drop the
       `this.sleep(this.graceMs)` arm). Ran it: red (the call never returns
       while the secondary's gate is shut; vitest times out). */
    const gate = deferred();
    const secondary = new ScriptedBuilder("B", { gate: gate.promise });
    const judge = new FakeSpineJudge([{ choose: 1 }]);
    const time = fakeTime([3000]);
    const { records, ctx: c } = observed();
    const out = await wrapper(new ScriptedBuilder("A"), secondary, judge, time).buildSpine(intent(), research, "short", c);
    expect(out.overview).toMatch(/^Plan A: /);
    expect(judge.calls).toBe(0);
    expect(records[0]).toMatchObject({ chosen: "primary", reason: "secondary-late", judge: null });
    expect(records[0]!.addedMs).toBeLessThanOrEqual(3000);
    expect(records[0]!.addedMs).toBe(3000);
    expect(records[0]!.samples[1]).toMatchObject({ role: "secondary", late: true, ms: null, valid: false });
    expect(time.state.slept).toEqual([3000]);
    gate.resolve();
  });

  it("no unhandled rejection from a secondary that fails after the wrapper returned", async () => {
    /* MUTATION THAT KILLS THIS: await the secondary with no race (drop the
       `this.sleep(this.graceMs)` arm). Ran it: red (the call never returns
       while the secondary's gate is shut; vitest times out).
       NOT killed by dropping the rejection handler from `sample` (ran it:
       green): with a valid primary the secondary is always subscribed through
       the Promise.race, which handles its later rejection. The next case is
       the one where the sample-level catch is the only handler. */
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const gate = deferred();
      const secondary = new ScriptedBuilder("B", { gate: gate.promise, throws: new Error("second box went away") });
      const out = await wrapper(new ScriptedBuilder("A"), secondary, new FakeSpineJudge(), fakeTime([3000])).buildSpine(intent(), research, "short", ctx);
      expect(out.overview).toMatch(/^Plan A: /);
      gate.resolve();
      for (let i = 0; i < 5; i++) await tick();
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("no unhandled rejection when the primary throws at once and the secondary throws later", async () => {
    /* MUTATION THAT KILLS THIS: drop the rejection handler from `sample`
       (`.then(onOk)` alone). Ran it: red (`await primaryRun` rejects before
       the secondary is awaited, so the secondary's later rejection has no
       handler and an unhandledRejection is seen). */
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const primaryError = new Error("spark busy");
      const gate = deferred();
      const secondary = new ScriptedBuilder("B", { gate: gate.promise, throws: new Error("second box went away") });
      const pending = wrapper(new ScriptedBuilder("A", { throws: primaryError }), secondary, new FakeSpineJudge(), fakeTime([3000])).buildSpine(intent(), research, "short", ctx);
      gate.resolve();
      await expect(pending).rejects.toBe(primaryError);
      for (let i = 0; i < 5; i++) await tick();
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("primary throws: the secondary is awaited past the grace window and returned when valid, reason 'only-valid'", async () => {
    /* MUTATION THAT KILLS THIS: race the secondary against graceMs even when
       the primary failed (drop the `!primaryValid` await). Ran it: red (the
       primary's error is thrown although the secondary was valid). */
    const gate = deferred();
    const secondary = new ScriptedBuilder("B", { gate: gate.promise });
    const judge = new FakeSpineJudge();
    const { records, ctx: c } = observed();
    const pending = wrapper(new ScriptedBuilder("A", { throws: new Error("spark busy") }), secondary, judge, fakeTime([3000])).buildSpine(intent(), research, "short", c);
    for (let i = 0; i < 5; i++) await tick();
    gate.resolve();
    const out = await pending;
    expect(out.overview).toMatch(/^Plan B: /);
    expect(judge.calls).toBe(0);
    expect(records[0]).toMatchObject({ chosen: "secondary", reason: "only-valid" });
    expect(records[0]!.samples[0]).toMatchObject({ role: "primary", valid: false, issues: ["threw"] });
  });

  it("primary fails validation: the valid secondary is used with no judge call (W4-16's 'only one passed')", async () => {
    /* MUTATION THAT KILLS THIS: count a sample valid on schema alone (skip
       checkSpineStructure in spineSampleIssues). Ran it: red (both count as
       valid and the judge is asked). */
    const judge = new FakeSpineJudge([{ choose: 0 }]);
    const { records, ctx: c } = observed();
    const out = await wrapper(new ScriptedBuilder("A", { twoSentence: true }), new ScriptedBuilder("B"), judge).buildSpine(intent(), research, "short", c);
    expect(out.overview).toMatch(/^Plan B: /);
    expect(judge.calls).toBe(0);
    expect(records[0]).toMatchObject({ chosen: "secondary", reason: "only-valid" });
    expect(records[0]!.samples[0]!.issues).toContain("beat-claim-not-single-sentence");
  });

  it("a secondary failing checkSpineStructure is never shown to the judge; the primary is returned", async () => {
    /* MUTATION THAT KILLS THIS: send both samples to the judge whenever the
       primary is valid. Ran it: red (judge called, Plan B returned). */
    const judge = new FakeSpineJudge([{ choose: 1 }]);
    const { records, ctx: c } = observed();
    const out = await wrapper(new ScriptedBuilder("A"), new ScriptedBuilder("B", { twoSentence: true }), judge).buildSpine(intent(), research, "short", c);
    expect(out.overview).toMatch(/^Plan A: /);
    expect(judge.calls).toBe(0);
    expect(records[0]).toMatchObject({ chosen: "primary", reason: "only-valid" });
    expect(records[0]!.samples[1]).toMatchObject({ role: "secondary", valid: false, late: false });
    expect(records[0]!.samples[1]!.issues).toContain("beat-claim-not-single-sentence");
  });

  it("the validity gate uses buildSpineWithReasks's seedable episode ids: a sample with no seeded beats per act is invalid when the map has tape windows, and never judged", async () => {
    /* Card step 6: the gate's checkSpineStructure options are the ones
       buildSpineWithReasks uses, seedableEpisodeIds from the research shape.
       The shared fixture has no tape windows, so the seeded-beat rule is off
       there; this map quotes windows from ten episodes, so it is on.
       MUTATION THAT KILLS THIS: call checkSpineStructure(spine, {
       seedableEpisodeIds: [] }) in spineSampleIssues. Ran it: red (the
       unseeded secondary counts as valid and the judge is asked). */
    const windowed: ResearchShape = {
      ...research,
      subtopics: research.subtopics.map((s) => ({
        ...s,
        windowsUnavailable: null,
        tapeWindows: ["inventory", "payments", "fraud", "search", "ranking", "speech", "vision", "logistics", "billing", "weather"].map((topic, i) => ({
          episodeId: `practical-ai--episode-${900 + i}`,
          showTitle: "Practical AI",
          episodeTitle: `Episode ${900 + i}`,
          startSec: 100 + i * 10,
          endSec: 200 + i * 10,
          text:
            `The ${topic} pipeline failed on a Friday and nobody noticed the ${topic} outage until Monday morning. ` +
            `The ${topic} retraining job ran on a fixed calendar rather than on any signal from the data itself.`,
          score: 2
        }))
      }))
    };
    /** The stub's spine with every seed stripped: well-formed, but no act
     * carries a beat seeded from a window the map listed. */
    class UnseededBuilder extends ScriptedBuilder {
      override async buildSpine(i: IntentUnderstanding, r: ResearchShape, d: DurationTier, c: SpineBuildContext): Promise<Spine> {
        const spine = await super.buildSpine(i, r, d, c);
        const unseeded = (beat: Spine["acts"][number]["slots"][number]["beats"][number]) => {
          const copy = { ...beat };
          delete copy.seed;
          return copy;
        };
        return { ...spine, acts: spine.acts.map((a) => ({ ...a, slots: a.slots.map((s) => ({ ...s, beats: s.beats.map(unseeded) })) })) };
      }
    }
    const judge = new FakeSpineJudge([{ choose: 1 }]);
    const { records, ctx: c } = observed();
    const out = await wrapper(new ScriptedBuilder("A"), new UnseededBuilder("B"), judge).buildSpine(intent(), windowed, "short", c);
    expect(out.overview).toMatch(/^Plan A: /);
    expect(judge.calls).toBe(0);
    expect(records[0]).toMatchObject({ chosen: "primary", reason: "only-valid", judge: null });
    expect(records[0]!.samples[0]).toMatchObject({ role: "primary", valid: true, issues: [] });
    expect(records[0]!.samples[1]).toMatchObject({ role: "secondary", valid: false, late: false });
    expect(records[0]!.samples[1]!.issues).toContain("act-below-seeded-beat-floor");
  });

  it("both invalid: the primary's own spine or error is passed through unchanged, reason 'none-valid'", async () => {
    /* MUTATION THAT KILLS THIS: throw a new error (or return the secondary)
       when no sample passed. Ran it: red (not the primary's object). */
    const primaryError = new Error("primary refused");
    const { records, ctx: c } = observed();
    await expect(
      wrapper(new ScriptedBuilder("A", { throws: primaryError }), new ScriptedBuilder("B", { throws: new Error("secondary refused") }), new FakeSpineJudge()).buildSpine(intent(), research, "short", c)
    ).rejects.toBe(primaryError);
    expect(records[0]).toMatchObject({ chosen: "primary", reason: "none-valid" });

    const out = await wrapper(new ScriptedBuilder("A", { twoSentence: true }), new ScriptedBuilder("B", { twoSentence: true }), new FakeSpineJudge()).buildSpine(intent(), research, "short", ctx);
    expect(out.overview).toMatch(/^Plan A: /);
    expect(spineSampleIssues(out, research, false)).toContain("beat-claim-not-single-sentence");
  });

  it("a judge that throws or hangs past its timeout returns the primary, reason 'judge-failed'", async () => {
    /* MUTATION THAT KILLS THIS: drop the judge-timeout race (await the judge
       alone). Ran it: red (the hanging judge never returns; vitest times out). */
    const { records, ctx: c } = observed();
    const threw = await wrapper(new ScriptedBuilder("A"), new ScriptedBuilder("B"), new FakeSpineJudge([{ throw: "jev 503" }])).buildSpine(intent(), research, "short", c);
    expect(threw.overview).toMatch(/^Plan A: /);
    expect(records[0]).toMatchObject({ chosen: "primary", reason: "judge-failed", judge: { outcome: "threw" } });

    const hung = observed();
    const time = fakeTime([5000]);
    const out = await wrapper(new ScriptedBuilder("A"), new ScriptedBuilder("B"), new FakeSpineJudge([{ hang: true }]), time).buildSpine(intent(), research, "short", hung.ctx);
    expect(out.overview).toMatch(/^Plan A: /);
    expect(hung.records[0]).toMatchObject({ chosen: "primary", reason: "judge-failed", judge: { outcome: "timeout", ms: 5000 } });
  });

  it("revision calls go to the last winner; the loser is not called again", async () => {
    /* MUTATION THAT KILLS THIS: send a re-ask to the primary always. Ran it:
       red (primary called twice, secondary once). */
    const primary = new ScriptedBuilder("A");
    const secondary = new ScriptedBuilder("B");
    const { records, ctx: c } = observed();
    const w = wrapper(primary, secondary, new FakeSpineJudge([{ choose: 1 }]));
    const first = await w.buildSpine(intent(), research, "short", c);
    const revised = await w.buildSpine(intent(), research, "short", { ...c, revision: { previous: first, violations: ["x"], attempt: 1 } });
    expect(revised.overview).toMatch(/^Plan B: /);
    expect([primary.calls, secondary.calls, secondary.revisions]).toEqual([1, 2, 1]);
    expect(records).toHaveLength(1);

    const fresh = new ScriptedBuilder("A");
    const unused = new ScriptedBuilder("B");
    await wrapper(fresh, unused, new FakeSpineJudge()).buildSpine(intent(), research, "short", { ...ctx, revision: { previous: first, violations: ["x"], attempt: 1 } });
    expect([fresh.calls, unused.calls]).toEqual([1, 0]);
  });

  it("buildSpineWithReasks's re-ask loop is unchanged around the wrapper: a refused primary-only round re-asks the primary", async () => {
    /* MUTATION THAT KILLS THIS: return the secondary's invalid spine on
       'none-valid'. Ran it: red (the re-ask's previous is Plan B). */
    const primary = new StubSpineBuilder(guard(), { twoSentenceClaimReplies: 1 });
    const secondary = new ScriptedBuilder("B", { twoSentence: true });
    const w = wrapper(primary, secondary, new FakeSpineJudge());
    const built = await buildSpineWithReasks(intent(), research, "short", w, ctx, { maxStructuralReasks: 1 });
    expect(built.reasks).toHaveLength(1);
    expect(primary.revisions).toHaveLength(1);
    expect(primary.revisions[0]!.previous.overview).not.toMatch(/^Plan B/);
    expect(secondary.calls).toBe(1);
  });
});

describe("GV-91: what the judge sees", () => {
  it("renderSpineForJudge shows overview, voice, act titles, slots and claims, and no ids", async () => {
    /* MUTATION THAT KILLS THIS: render JSON.stringify(spine). Ran it: red
       (the seed's episode id and generatedAt appear). */
    const spine = await new StubSpineBuilder(guard()).buildSpine(intent(), research, "short", ctx);
    const firstBeat = spine.acts[0]!.slots[0]!.beats[0]!;
    const seeded: Spine = {
      ...spine,
      acts: spine.acts.map((a, i) =>
        i === 0 ? { ...a, slots: a.slots.map((s, j) => (j === 0 ? { ...s, beats: [{ ...firstBeat, seed: { episodeId: "ep-secret-123", startSec: 1, endSec: 9 } }, ...s.beats.slice(1)] } : s)) } : a
      ),
      answersDisappointment: "It names Ford and the Kingsford plant."
    };
    const text = renderSpineForJudge(seeded);
    expect(text).toContain(`Overview: ${spine.overview}`);
    expect(text).toContain(spine.voice.style);
    expect(text).toContain(`Act 1: ${spine.acts[0]!.title}`);
    expect(text).toContain(`Slot: ${spine.acts[0]!.slots[0]!.title}`);
    expect(text).toContain(`- ${firstBeat.claim}`);
    expect(text).toContain("It names Ford and the Kingsford plant.");
    expect(text).not.toContain("ep-secret-123");
    expect(text).not.toContain(spine.generatedAt);
  });

  it("fold off: the question is built from the intent's subject, angle and disappointment; sentinels are dropped", () => {
    /* MUTATION THAT KILLS THIS: drop the PRE_SPINE_SENTINEL filter in
       `known`. Ran it: red (the sentinel reaches the question). */
    const q = spineJudgeQuestion(intent(), {});
    expect(q).toContain("Subject: the history of grilling");
    expect(q).toContain("Angle: how an industrial waste product became a backyard ritual");
    expect(q).toContain("never mentions Ford");
    const keyword = preSpineIntent("how did backyard barbecue become a suburban ritual")!;
    expect(spineJudgeQuestion(keyword, {})).not.toContain(PRE_SPINE_SENTINEL);
  });

  it("fold on: the judge's question comes from the listener prompt, never the keyword intent or the sentinel, and the record carries no prompt text", async () => {
    /* MUTATION THAT KILLS THIS: ignore ctx.listenerPrompt in
       spineJudgeQuestion. Ran it: red (the keyword subject is asked). */
    const listenerPrompt = "Tell me how backyard barbecue turned into a suburban ritual after the war";
    const keyword = preSpineIntent(listenerPrompt)!;
    expect(keyword.disappointment).toBe(PRE_SPINE_SENTINEL);
    const judge = new FakeSpineJudge([{ choose: 1 }]);
    const { records, ctx: c } = observed();
    await wrapper(new ScriptedBuilder("A"), new ScriptedBuilder("B"), judge).buildSpine(keyword, research, "short", { ...c, listenerPrompt });
    const question = judge.inputs[0]!.question;
    expect(question).toContain(listenerPrompt);
    expect(question).not.toContain(keyword.subject);
    expect(question).not.toContain(PRE_SPINE_SENTINEL);
    const recorded = JSON.stringify(records);
    expect(recorded).not.toContain("barbecue");
    expect(recorded).not.toContain(keyword.subject);
  });
});

describe("GV-91: createSpineBuilder and the flags", () => {
  let restores: Array<() => void> = [];
  afterEach(() => {
    for (const r of restores) r();
    restores = [];
  });

  it("FORAY_SPINE_BEST_OF unset (or 1): createSpineBuilder returns exactly the routed builder", () => {
    /* MUTATION THAT KILLS THIS: wrap whenever FORAY_STAGE_SPINE_ALT is set.
       Ran it: red (a BestOfTwoSpineBuilder comes back). */
    expect(createSpineBuilder({})).toBeInstanceOf(StubSpineBuilder);
    expect(createSpineBuilder({ FORAY_SPINE_BEST_OF: "1", FORAY_STAGE_SPINE_ALT: "stub" })).toBeInstanceOf(StubSpineBuilder);
    expect(spineBestOfLever({})).toBeUndefined();
  });

  it("FORAY_SPINE_BEST_OF=2 wraps 'spine' and 'spine-alt' with the named judge and the grace", () => {
    /* MUTATION THAT KILLS THIS: pass DEFAULT_SPINE_BEST_OF_GRACE_MS instead
       of the flag's value. Ran it: red (1500 expected). */
    const judge = new FakeSpineJudge();
    restores.push(__swapSpineJudgeForTests("fake", () => judge));
    const source = { FORAY_SPINE_BEST_OF: "2", FORAY_STAGE_SPINE_ALT: "stub", FORAY_SPINE_JUDGE: "fake" };
    const built = createSpineBuilder(source);
    expect(built).toBeInstanceOf(BestOfTwoSpineBuilder);
    const w = built as BestOfTwoSpineBuilder;
    expect(w.providerName).toBe("best-of-2");
    expect(w.primary).toBeInstanceOf(StubSpineBuilder);
    expect(w.secondary).toBeInstanceOf(StubSpineBuilder);
    expect(w.judge).toBe(judge);
    expect(w.graceMs).toBe(DEFAULT_SPINE_BEST_OF_GRACE_MS);
    expect((createSpineBuilder({ ...source, FORAY_SPINE_BEST_OF_GRACE_MS: "1500" }) as BestOfTwoSpineBuilder).graceMs).toBe(1500);
    expect(spineBestOfLever(source)).toEqual({ mode: "best-of-2", judge: "fake", graceMs: 3000 });
  });

  it("refuses best-of-2 with spine-alt unset or 'anthropic', or with no judge registered under the name, naming the variable", () => {
    /* MUTATION THAT KILLS THIS: drop the 'anthropic' check. Ran it: red (no
       throw; a legacy secondary would be built). */
    restores.push(__swapSpineJudgeForTests("fake", () => new FakeSpineJudge()));
    const thrown = (source: NodeJS.ProcessEnv): RoutingConfigError => {
      try {
        createSpineBuilder(source);
      } catch (e) {
        return e as RoutingConfigError;
      }
      throw new Error("expected a refusal");
    };
    const unsetAlt = thrown({ FORAY_SPINE_BEST_OF: "2", FORAY_SPINE_JUDGE: "fake" });
    expect(unsetAlt).toBeInstanceOf(RoutingConfigError);
    expect(unsetAlt.variable).toBe("FORAY_STAGE_SPINE_ALT");
    const legacy = thrown({
      FORAY_SPINE_BEST_OF: "2",
      FORAY_SPINE_JUDGE: "fake",
      FORAY_GENERATION_MODE: "anthropic-legacy",
      FORAY_ALLOW_ANTHROPIC_LEGACY: "1",
      FORAY_STAGE_SPINE: "stub",
      FORAY_STAGE_SPINE_ALT: "anthropic"
    });
    expect(legacy.variable).toBe("FORAY_STAGE_SPINE_ALT");
    const unknownJudge = thrown({ FORAY_SPINE_BEST_OF: "2", FORAY_STAGE_SPINE_ALT: "stub", FORAY_SPINE_JUDGE: "jev" });
    expect(unknownJudge.variable).toBe("FORAY_SPINE_JUDGE");
    expect(unknownJudge.message).not.toContain("jev\"");
    const noJudge = thrown({ FORAY_SPINE_BEST_OF: "2", FORAY_STAGE_SPINE_ALT: "stub" });
    expect(noJudge.variable).toBe("FORAY_SPINE_JUDGE");
  });

  it("malformed FORAY_SPINE_BEST_OF / FORAY_SPINE_BEST_OF_GRACE_MS fail fast naming only the variable", () => {
    /* MUTATION THAT KILLS THIS: drop `.max(MAX_SPINE_BEST_OF_GRACE_MS)`.
       Ran it: red (70000 accepted). */
    expect(() => createSpineBuilder({ FORAY_SPINE_BEST_OF: "3" })).toThrow(FlagValueError);
    expect(() => createSpineBuilder({ FORAY_SPINE_BEST_OF: "3" })).toThrow(/FORAY_SPINE_BEST_OF: expected one of 1\|2$/);
    for (const bad of ["70000", "-1", "1.5", "soon"]) {
      const source = { FORAY_SPINE_BEST_OF: "2", FORAY_STAGE_SPINE_ALT: "stub", FORAY_SPINE_JUDGE: "fake", FORAY_SPINE_BEST_OF_GRACE_MS: bad };
      expect(() => spineBestOfLever(source), bad).toThrow(FlagValueError);
      try {
        spineBestOfLever(source);
      } catch (e) {
        expect((e as Error).message).toContain("FORAY_SPINE_BEST_OF_GRACE_MS");
        expect((e as Error).message).not.toContain(bad);
      }
    }
    expect(() => spineBestOfLever({ FORAY_SPINE_BEST_OF: "2", FORAY_SPINE_JUDGE: "Not A Name" })).toThrow(/FORAY_SPINE_JUDGE/);
  });
});
