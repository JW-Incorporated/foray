import type { Act, DeepenedAct, Slot, Spine } from "../types/spine";
import { DeepenedActSchema, validateDeepenedAct } from "../types/spine";
import type { DeepenActBuilder, DeepenActContext } from "./DeepenActBuilder";

/**
 * THE ARGUMENT CAP (finding F-49).
 *
 * Run 2 asked for a Foray on how AI systems get built, and the deepen stage
 * came back with 29 of its 35 beats tagged `argument`. §4.5 skips tape lookup
 * for an argument by design (F-38), so 29 beats never went looking for tape,
 * the remaining 6 found none, and the pipeline produced an all-narration Foray
 * on the one subject this archive is richest in (337 *Practical AI* bodies).
 *
 * Nothing was wrong with any single judgement. On an angle-driven spine — "the
 * unglamorous reality of production ML is engineering discipline, not research"
 * — every beat can be read as evidence for the angle, and a model asked "is
 * this a thesis?" keeps saying yes. A prompt line alone cannot hold that back,
 * because the prompt is exactly what drifted.
 *
 * So the shape of a slot is asserted here, in code, where a run cannot argue
 * with it: AT MOST ONE THIRD of a slot's beats may be `argument`, rounded up —
 * a 3-beat slot may have 1, a 6-beat slot 2, a 1-beat slot 1 (a cap of zero
 * would stop a single-beat slot holding an argument at all, which is a
 * different rule than the one asked for). One third is the three-to-one ratio
 * of things-that-happened to claims-about-them that a documentary slot reads
 * as; it is a bound on drift, not a target.
 *
 * WHICH ONES ARE RE-TAGGED, AND WHY IT IS THE LAST ONES. The beats over the cap
 * are the ones appearing LAST in the slot, in slot order. The alternative —
 * ranking beats by how argument-shaped they look and keeping the strongest —
 * would have this module re-judge the model's own judgement with a worse
 * instrument than the model had, and the ranking would be a second, silent
 * heuristic nobody could read off the output. Slot order is deterministic,
 * explicable in one sentence, and a slot's opening beats are where its thesis
 * is normally stated.
 *
 * RE-TAGGING IS THE SAFE DIRECTION. `account` only means "§4.5 may look for
 * tape for this"; the search still has to clear every threshold and gate, so a
 * re-tagged beat with no real tape simply becomes narration — which is what it
 * was going to be anyway. The reverse mistake (a real account tagged
 * `argument`) is the one that costs tape silently, and it is the one that
 * happened.
 */
export const MAX_ARGUMENT_SHARE_PER_SLOT = 1 / 3;

/** How many of a slot's `beatCount` beats may be `argument` — one third,
 * rounded up, floored at 1 so a one-beat slot can still hold one. */
export function argumentCapFor(beatCount: number): number {
  return Math.max(1, Math.ceil(beatCount * MAX_ARGUMENT_SHARE_PER_SLOT));
}

/**
 * Applies the cap to one deepened act, re-tagging the surplus `argument` beats
 * `account` and recording what it did in the act's own `warnings` — a field, so
 * it is checkpointed with the act, survives a resume and can be asserted in a
 * test. Run 2's only symptom was the absence of tape four stages later; a
 * `console.warn` would have been no better.
 *
 * Returns the act UNCHANGED (the same object, not a copy) when nothing is over
 * the cap, so an act that needed no correction is byte-identical to what the
 * builder returned. Idempotent: a second pass changes nothing, which is what
 * lets it be applied to a resumed act as safely as to a fresh one.
 */
export function capArgumentBeats(act: DeepenedAct): DeepenedAct {
  const warnings: string[] = [];
  const slots: Slot[] = act.slots.map((slot) => {
    const cap = argumentCapFor(slot.beats.length);
    let kept = 0;
    let retagged = 0;
    const beats = slot.beats.map((beat) => {
      if (beat.kind !== "argument") return beat;
      if (kept < cap) {
        kept += 1;
        return beat;
      }
      retagged += 1;
      return { ...beat, kind: "account" as const };
    });
    if (retagged === 0) return slot;
    warnings.push(
      `Slot "${slot.title}": ${kept + retagged} of ${slot.beats.length} beats came back tagged "argument"; at most ${cap} may be ` +
        `(one third of the slot, rounded up). The last ${retagged} were re-tagged "account", so §4.5 looks for tape for them.`
    );
    return { title: slot.title, beats };
  });

  if (warnings.length === 0) return act;
  return { ...act, slots, warnings: [...(act.warnings ?? []), ...warnings] };
}

/**
 * THE SEED SURVIVES DEEPENING (fix plan WS-L; finding F-63).
 *
 * §4.3 writes some of its `account` beats FROM a quoted transcript window and
 * names the episode on the beat (`BeatSeedSchema`); §4.5 opens that episode
 * before anything its own index ranks. Between the two sits this stage, whose
 * job is to sharpen wording — and a model asked to re-emit a JSON object will
 * sometimes drop a field it was not asked to change. Losing the seed there costs
 * exactly what F-63 costs: the tape stops being what the beat was written from.
 *
 * SO IT IS RESTORED IN CODE, NOT REQUESTED IN THE PROMPT. The deepened beat
 * keeps its own seed when it returned one (a builder that legitimately re-points
 * a reworded beat is obeyed); otherwise the original beat's seed is put back.
 * The join is positional and only within a slot whose beat COUNT is unchanged —
 * §4.4 refines beats, it does not add or remove them, and where that assumption
 * does not hold this restores nothing rather than attaching one beat's tape to
 * another beat's claim.
 *
 * Returns the act unchanged (the same object) when nothing had to be restored,
 * so an act from a spine with no seeds is byte-identical to what the builder
 * returned. Idempotent, like `capArgumentBeats`, and applied on the same path.
 */
export function carryBeatSeeds(original: Act, deepened: DeepenedAct): DeepenedAct {
  let restoredAnywhere = 0;
  const slots: Slot[] = deepened.slots.map((slot, slotIndex) => {
    const originalSlot = original.slots[slotIndex];
    if (!originalSlot || originalSlot.beats.length !== slot.beats.length) return slot;
    let restoredHere = 0;
    const beats = slot.beats.map((beat, beatIndex) => {
      const seed = originalSlot.beats[beatIndex]?.seed;
      if (beat.seed || !seed) return beat;
      restoredHere += 1;
      return { ...beat, seed };
    });
    if (restoredHere === 0) return slot;
    restoredAnywhere += restoredHere;
    return { title: slot.title, beats };
  });
  return restoredAnywhere === 0 ? deepened : { ...deepened, slots };
}

/**
 * §4.4 end to end (docs/curation/generation-architecture.md §4.4 / §5):
 * takes the frozen §4.3 spine and produces one deepened act per input act,
 * by invoking `builder.deepenAct()` ONCE PER ACT, IN PARALLEL
 * (`Promise.all`) — §5's topology table: "1 per act (3-7)... the natural
 * parallel boundary."
 *
 * Every call receives the FULL spine (not just its own act's slice) —
 * this is load-bearing, not a convenience: §4.4 states "the full-spine
 * context is what stops act 3 from re-explaining what act 1 established."
 *
 * FAILURE-ISOLATION POLICY (this stage's own call, per the task brief):
 * a single act's deepening is retried ONCE on failure (a transient LLM/API
 * hiccup is the overwhelmingly likely cause and a free retry is cheap
 * relative to redoing every other act). If the retry also fails, the
 * WHOLE Foray build fails — a deepened act is not optional content, it is
 * one act of the finished spine, and §6.1 already establishes that acts
 * are played in order; a Foray missing act 3 is not a valid Foray, it is
 * a corrupt one. A failure in one act's deepening never corrupts or
 * silently drops another act's independently-produced result — every
 * other act's `deepenAct()` call proceeds and completes (or fails) on its
 * own, per §4.4's "genuinely independent" framing; this function simply
 * declines to return a partial result set once any act's retry budget is
 * exhausted.
 */
export class ActDeepeningError extends Error {
  constructor(
    public readonly actIndex: number,
    public readonly actTitle: string,
    public readonly cause: unknown
  ) {
    super(`Deepening act ${actIndex + 1} ("${actTitle}") failed after 1 retry: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = "ActDeepeningError";
  }
}

export class InvalidDeepenedActError extends Error {
  constructor(
    public readonly actIndex: number,
    public readonly actTitle: string,
    public readonly issues: string[]
  ) {
    super(`Deepened act ${actIndex + 1} ("${actTitle}") failed validation: ${issues.join("; ")}`);
    this.name = "InvalidDeepenedActError";
  }
}

async function deepenOneActWithRetry(
  spine: Spine,
  act: Act,
  index: number,
  builder: DeepenActBuilder,
  ctx: DeepenActContext
): Promise<DeepenedAct> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await builder.deepenAct(spine, act, index, ctx);
      const deepened = DeepenedActSchema.parse(raw);

      const validation = validateDeepenedAct(act, deepened);
      if (!validation.valid) {
        throw new InvalidDeepenedActError(
          index,
          act.title,
          validation.issues.map((i) => i.message)
        );
      }

      /* The cap is applied AFTER validation, on the way out: it is this
         stage's own structural rule about the act it returns, not a schema
         property of what the builder said (F-49). The seed restore rides the
         same seam for the same reason (WS-L, F-63). */
      return capArgumentBeats(carryBeatSeeds(act, deepened));
    } catch (err) {
      lastError = err;
    }
  }
  throw new ActDeepeningError(index, act.title, lastError);
}

/**
 * Deepens every act of `spine` in parallel. Structured so a future
 * pipeline orchestrator (§4.0-§4.9 wired end-to-end) can call this as one
 * step — building that orchestrator is explicitly NOT this stage's job.
 */
/**
 * Per-act checkpoint seam (generation run 2026-09-09, findings F-17/F-18).
 *
 * Deliberately a pair of callbacks rather than a store object: this stage owns
 * the retry and failure-isolation policy above and must keep owning it, so all
 * it exposes is "do you already have act N?" and "here is act N". Where those
 * answers are kept — an in-memory map in a test, a JSON file beside the
 * candidate in the batch driver — is not this module's business.
 *
 * Both are optional, and a caller that passes neither gets exactly the
 * behaviour this function had before they existed.
 */
export interface DeepenActsOptions {
  /** Returns an already-deepened act for `index`, or undefined to build it. */
  resume?: (index: number) => DeepenedAct | undefined;
  /** Called with each act as soon as it is built and validated — never for a
   * resumed one, which is already stored. */
  onActDeepened?: (index: number, act: DeepenedAct) => void | Promise<void>;
}

export async function deepenActs(
  spine: Spine,
  builder: DeepenActBuilder,
  ctx: DeepenActContext,
  options: DeepenActsOptions = {}
): Promise<DeepenedAct[]> {
  const calls = spine.acts.map(async (act, index) => {
    const resumed = options.resume?.(index);
    /* A resumed act goes through the cap too. It is idempotent, so an act
       checkpointed after this rule existed comes back untouched; an act
       checkpointed BEFORE it (run 2's own checkpoint — 29 arguments in 35
       beats) is corrected on resume, rather than the resume faithfully
       replaying the defect it exists to avoid re-paying for. A checkpoint
       written before beats carried seeds gets them restored the same way. */
    if (resumed) return capArgumentBeats(carryBeatSeeds(act, resumed));
    const deepened = await deepenOneActWithRetry(spine, act, index, builder, ctx);
    /* Persisted BEFORE `Promise.all` settles, so an act that succeeded is
       banked even when a sibling act's retry budget runs out and fails the
       whole stage. That is the F-17 case: the run dies, and the next attempt
       does not re-pay for the acts that worked. */
    await options.onActDeepened?.(index, deepened);
    return deepened;
  });
  return Promise.all(calls);
}
