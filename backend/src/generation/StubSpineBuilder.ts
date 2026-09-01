import * as crypto from "crypto";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import type { IntentUnderstanding } from "../types/generation";
import type { ResearchShape } from "../types/research";
import { DURATION_SHAPE_BUDGETS, type Act, type Beat, type DurationTier, type Slot, type Spine, type Voice } from "../types/spine";
import type { SpineBuildContext, SpineBuilder } from "./SpineBuilder";

/**
 * Deterministic fake spine builder, used whenever ANTHROPIC_API_KEY is
 * absent (env.anthropicDryRun) — same role as StubPromptUnderstander /
 * StubExternalResearcher / StubEnricher: zero API keys, zero network
 * calls, reproducible fixtures that still satisfy `validateSpine`
 * (correct act/slot/beat counts for the tier, every beat claim-shaped,
 * the ~30% exploration floor met, one spine-level voice).
 *
 * This is a fixture generator, not a content-quality stand-in — the real
 * provider (a future AnthropicSpineBuilder, gated behind the same
 * ANTHROPIC_API_KEY split as every other collaborator here) is what does
 * the actual planning judgement §4.3 asks for. This stub exists so
 * `buildSpine.ts` and its structural gates (shape budgets, claim-shape,
 * exploration marking, single spine-level voice) can be tested and used
 * without API spend, exactly like every other stage's dry-run path.
 */
export class StubSpineBuilder implements SpineBuilder {
  readonly providerName = "stub";

  constructor(private readonly budgetGuard: BudgetGuard = defaultBudgetGuard) {}

  async buildSpine(
    intent: IntentUnderstanding,
    researchShape: ResearchShape,
    duration: DurationTier,
    ctx: SpineBuildContext
  ): Promise<Spine> {
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "spine_build",
      provider: this.providerName,
      estimatedUsd: 0,
      dryRun: true,
      sessionId: ctx.sessionId
    });

    const budget = DURATION_SHAPE_BUDGETS[duration];
    const actCount = midpoint(budget.acts);
    const slotCount = midpoint(budget.slots);
    const itemCount = midpoint(budget.items);

    const subtopicLabels = researchShape.subtopics.length > 0 ? researchShape.subtopics.map((s) => s.label) : [intent.subject];

    const slotsPerAct = distributeEvenly(slotCount, actCount);
    const beatsPerSlot = distributeEvenly(itemCount, slotCount);

    // Which global beat indices are exploration beats — evenly spread so a
    // cost-cutting pass truncating from the end can't accidentally strip
    // every exploration beat at once, while still guaranteeing >= floor.
    const requiredExploration = Math.ceil(itemCount * 0.35); // comfortably clears the 30% floor
    const explorationIndices = spreadIndices(itemCount, requiredExploration);

    let slotCursor = 0;
    let beatCursor = 0;
    const acts: Act[] = [];

    for (let a = 0; a < actCount; a++) {
      const seed = hashToInt(`${intent.subject}::act::${a}`);
      const actSlots: Slot[] = [];
      const nSlotsThisAct = slotsPerAct[a]!;

      for (let s = 0; s < nSlotsThisAct; s++) {
        const nBeatsThisSlot = beatsPerSlot[slotCursor]!;
        slotCursor += 1;
        const beats: Beat[] = [];
        for (let b = 0; b < nBeatsThisSlot; b++) {
          const label = subtopicLabels[beatCursor % subtopicLabels.length]!;
          const exploration = explorationIndices.has(beatCursor);
          beats.push({ claim: claimFor(intent.subject, label, beatCursor, exploration), exploration });
          beatCursor += 1;
        }
        actSlots.push({ title: `${capitalize(intent.subject)} — slot ${slotCursor}`, beats });
      }

      acts.push({
        title: `Act ${a + 1}: ${actTitleFor(intent.subject, a, seed)}`,
        thesis: `Act ${a + 1} establishes ${actTitleFor(intent.subject, a, seed).toLowerCase()} as it relates to ${intent.subject}.`,
        startState: a === 0 ? intent.priorKnowledge : `The listener has just finished act ${a}.`,
        endState: `The listener now understands ${actTitleFor(intent.subject, a, seed).toLowerCase()} and how it changes their view of ${intent.subject}.`,
        slots: actSlots
      });
    }

    return {
      subject: intent.subject,
      angle: intent.angle,
      duration,
      generatedAt: new Date().toISOString(),
      voice: stubVoice(intent),
      acts
    };
  }
}

function midpoint([min, max]: [number, number]): number {
  return Math.round((min + max) / 2);
}

/** Splits `total` into `buckets` near-equal non-negative integer parts,
 * each at least 1 when `total >= buckets`. */
function distributeEvenly(total: number, buckets: number): number[] {
  const base = Math.floor(total / buckets);
  let remainder = total - base * buckets;
  const result: number[] = [];
  for (let i = 0; i < buckets; i++) {
    let n = base;
    if (remainder > 0) {
      n += 1;
      remainder -= 1;
    }
    result.push(Math.max(n, total >= buckets ? 1 : n));
  }
  return result;
}

/** Picks `count` indices out of `[0, total)`, spread as evenly as
 * possible across the range. */
function spreadIndices(total: number, count: number): Set<number> {
  const n = Math.min(count, total);
  const indices = new Set<number>();
  if (n <= 0 || total <= 0) return indices;
  const step = total / n;
  for (let i = 0; i < n; i++) {
    indices.add(Math.min(total - 1, Math.floor(i * step)));
  }
  return indices;
}

function hashToInt(input: string): number {
  const digest = crypto.createHash("sha1").update(input).digest();
  return digest.readUInt32BE(0);
}

function pick<T>(arr: T[], seed: number): T {
  return arr[seed % arr.length]!;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

const ACT_FRAMES = [
  "the origin",
  "how it actually works",
  "the part nobody expects",
  "the controversy",
  "what changed it",
  "the human cost",
  "where it stands today"
];

function actTitleFor(subject: string, actIndex: number, seed: number): string {
  const frame = ACT_FRAMES[(actIndex + seed) % ACT_FRAMES.length]!;
  return capitalize(frame);
}

/** Claim templates guaranteed to pass `isClaimShaped`'s structural checks
 * (a closed-class auxiliary, an unambiguous irregular past-tense verb, or
 * regular -ed morphology directly following the subject/object it
 * modifies). Deterministic per (subject, label, index) so the stub is
 * reproducible across runs. */
const CLAIM_TEMPLATES = [
  (subject: string, label: string) => `${capitalize(label)} is a documented part of the history of ${subject}.`,
  (subject: string, label: string) => `${capitalize(label)} changed how researchers understood ${subject}.`,
  (subject: string, label: string) => `Early accounts of ${subject} disputed the role that ${label} actually played.`,
  (subject: string, label: string) => `${capitalize(label)} began as a minor detail before it reshaped ${subject}.`,
  (subject: string, label: string) => `${capitalize(subject)} could not have taken its current form without ${label}.`,
  (subject: string, label: string) => `Historians attributed a key turn in ${subject} to ${label}.`,
  (subject: string, label: string) => `${capitalize(label)} was dismissed for years before ${subject} experts took it seriously.`,
  (subject: string, label: string) => `The connection between ${label} and ${subject} surprised even specialists.`
];

/** Extra "curious listener" framing for exploration-marked beats — still
 * claim-shaped, but pointed at an adjacent angle the prompt didn't
 * literally ask for (§4.3's exploration-budget definition). */
const EXPLORATION_TEMPLATES = [
  (subject: string, label: string) => `A tangent from ${label} led researchers to a discovery unrelated to ${subject} at first glance.`,
  (subject: string, label: string) => `${capitalize(label)}, oddly, was what explained a quirk many listeners notice about ${subject}.`,
  (subject: string, label: string) => `Few people asking about ${subject} expect ${label} to matter, but it does.`
];

function claimFor(subject: string, label: string, index: number, exploration: boolean): string {
  const seed = hashToInt(`${subject}::${label}::${index}`);
  const templates = exploration ? EXPLORATION_TEMPLATES : CLAIM_TEMPLATES;
  return pick(templates, seed)(subject, label);
}

function stubVoice(intent: IntentUnderstanding): Voice {
  return {
    style: `Plain, curious, well-read-friend register tuned to ${intent.subject} — no jargon left unexplained.`,
    register: "Conversational but precise; treats the listener as smart and short on time.",
    sentenceRhythm: "Short declarative sentences for claims, one longer sentence per beat max for connective tissue.",
    narratorPresence: "Present enough to guide, never editorializing beyond what the sources support."
  };
}
