import type { DurationTier } from "../types/spine";
import { readEnumFlag, type FlagSource } from "../generation/generationFlags";

/**
 * GV-14 (docs/roadmap/generation-v2.md, from W1-07; covers R1-17, MT-05,
 * GP-02; decision 10): the ONE table of output-token budgets, per stage and
 * per duration tier, plus the builders' hard caps and the truncation policy
 * the provider layer applies.
 *
 * TARGETS, NOT REGRESSIONS. The numbers in OUTPUT_TOKEN_BUDGETS are R1-17's
 * targets for the REDESIGNED pipeline (folded deepen, Jev verify and clarity,
 * a streamed act-1 writer). Today's relay pipeline will read over budget on
 * nearly every stage; that is the gap the roadmap closes, not a defect of a
 * run. Any report that shows these must say so.
 *
 * THREE MODES, one flag. FORAY_OUTPUT_BUDGETS = off | report | enforce,
 * default report, read at CALL time through generationFlags (decision 5; not
 * config/env.ts):
 *   - off     every CallRecord carries only what its provider passed;
 *   - report  runLog.recordModelCall stamps outputBudget and overBudget from
 *             the stage and the tier in the call context (this card);
 *   - enforce report, AND the provider layer passes min(builderCap, budget)
 *             as max_tokens (`enforcedMaxTokens`) and acts on
 *             `truncationDecision`. Nothing in this card enforces: the
 *             Anthropic builders keep their caps, including the writer's
 *             12000 floor (AnthropicNarrationWriterBuilder.ts, the 2026-09-13
 *             truncation defect), so no request changes under any mode.
 */

/* ---------------------------------------------------------------------------
   The stages a budget is kept for.
   --------------------------------------------------------------------------- */

export const BUDGET_STAGES = [
  "understand.clarity",
  "understand.intent",
  "understand.title",
  "research",
  "retrieval",
  "spine",
  "deepen",
  "narrate.act",
  "narrate.seam1",
  "narrate.verify",
  "continuity"
] as const;
export type BudgetStage = (typeof BUDGET_STAGES)[number];

export const BUDGET_TIERS: readonly DurationTier[] = ["short", "medium", "long"];

/** A cell of the table: a token count, or `per-seam` for a writer budget that
 * is sized from the act's seam plan (`writerActBudget`), not fixed per tier. */
export type BudgetCell = number | "per-seam";

/**
 * R1-17's output-token targets, `[stage][tier]`.
 *
 * - spine: 450 / 1200 / 2400. The long value is a guess (PROPOSED, decision
 *   10) until the golden set measures it.
 * - narrate.act: 1200 on short, R1-17's streamed act-1 writer. Medium and
 *   long are sized per act from the seam plan (`writerActBudget`), as R1-17's
 *   risk asks (RQ-12's per-tier sizing).
 * - narrate.seam1: 150, a sub-budget of narrate.act (the first seam that the
 *   streamed writer emits for first audio). It is never a CallRecord's stage
 *   on its own; the streamed writer asks for it by name.
 * - 0 on every tier: narrate.verify and understand.clarity (Jev decides
 *   them, no LLM prose), deepen (folded into the spine by R1-01), continuity.
 *   A 0 budget means "no model output on the timed path"; it is never
 *   enforced as a max_tokens of 0.
 * - Pre-spine stages sit OUTSIDE R1-17's per-Foray sum, and R1-02 / OQ-04
 *   remove them from the timed path: understand.intent 300, understand.title
 *   40, research 400, retrieval 0 (off the timed path).
 */
export const OUTPUT_TOKEN_BUDGETS: Readonly<Record<BudgetStage, Readonly<Record<DurationTier, BudgetCell>>>> = {
  "understand.clarity": { short: 0, medium: 0, long: 0 },
  "understand.intent": { short: 300, medium: 300, long: 300 },
  "understand.title": { short: 40, medium: 40, long: 40 },
  research: { short: 400, medium: 400, long: 400 },
  retrieval: { short: 0, medium: 0, long: 0 },
  spine: { short: 450, medium: 1200, long: 2400 },
  deepen: { short: 0, medium: 0, long: 0 },
  "narrate.act": { short: 1200, medium: "per-seam", long: "per-seam" },
  "narrate.seam1": { short: 150, medium: 150, long: 150 },
  "narrate.verify": { short: 0, medium: 0, long: 0 },
  continuity: { short: 0, medium: 0, long: 0 }
};

/* ---------------------------------------------------------------------------
   The per-seam writer budget.
   --------------------------------------------------------------------------- */

/** About four characters per token. */
export const WRITER_TOKENS_PER_CHAR = 0.25;
/** Headroom over the band ceilings, so a seam at its ceiling is not cut. */
export const WRITER_BUDGET_HEADROOM = 1.25;
/** JSON scaffolding per seam (`seamId`, `script`, quotes and braces). */
export const WRITER_TOKENS_PER_SEAM = 20;

/**
 * The narrate.act budget for an act on medium and long: ceil(sum of every
 * seam band's MAX chars x 0.25 x 1.25) + 20 per seam. `seamBands` are the
 * `[min, max]` character bands `actSeams.ts`'s `seamBand` derives from
 * MODE_CHAR_BANDS (types/narration.ts), one per seam.
 */
export function writerActBudget(seamBands: ReadonlyArray<readonly [number, number]>): number {
  const maxChars = seamBands.reduce((sum, [, max]) => sum + max, 0);
  return Math.ceil(maxChars * WRITER_TOKENS_PER_CHAR * WRITER_BUDGET_HEADROOM) + WRITER_TOKENS_PER_SEAM * seamBands.length;
}

export interface OutputBudgetContext {
  /** The act's seam bands, for a `per-seam` cell. */
  seamBands?: ReadonlyArray<readonly [number, number]>;
}

/** True for one of the three duration tiers. */
export function isBudgetTier(tier: unknown): tier is DurationTier {
  return typeof tier === "string" && (BUDGET_TIERS as readonly string[]).includes(tier);
}

/**
 * The output budget of `stage` on `tier`, or null when it cannot be known: a
 * `per-seam` cell without seam bands, or a tier that is not one of the three.
 */
export function outputBudgetFor(stage: BudgetStage, tier: DurationTier, ctx: OutputBudgetContext = {}): number | null {
  if (!isBudgetTier(tier)) return null;
  const cell = OUTPUT_TOKEN_BUDGETS[stage][tier];
  if (cell !== "per-seam") return cell;
  return ctx.seamBands ? writerActBudget(ctx.seamBands) : null;
}

/** The stages R1-17 sums per Foray (pre-spine stages are outside it). */
export const R1_17_STAGES: readonly BudgetStage[] = ["spine", "narrate.act", "deepen", "continuity", "narrate.verify"];

/**
 * R1-17's per-Foray output sum: spine + narrate.act + deepen + continuity +
 * narrate.verify. 1,650 on short. Null on medium and long without the seam
 * bands their writer budget is sized from.
 */
export function R1_17_SUM(tier: DurationTier, ctx: OutputBudgetContext = {}): number | null {
  let sum = 0;
  for (const stage of R1_17_STAGES) {
    const budget = outputBudgetFor(stage, tier, ctx);
    if (budget === null) return null;
    sum += budget;
  }
  return sum;
}

/* ---------------------------------------------------------------------------
   The builders' hard caps, moved here with unchanged values.
   --------------------------------------------------------------------------- */

/**
 * The max_tokens each Anthropic builder sends today, as one constant
 * (decision 10). Nothing reads it in GV-14; GV-25 points the Anthropic and
 * Chat builders at it, and GV-100 adds spineMaxTokens beside it. The writer
 * is not here: it keeps `actOutputTokenBudget` and its 12000 floor.
 * backend/test/outputBudgets.test.ts greps each builder and fails on drift.
 */
export const BUILDER_MAX_TOKENS = {
  clarity: 400,
  intent: 600,
  title: 120,
  spine: 8000,
  deepen: 4000,
  continuity: 500,
  verifier: 4000
} as const;
export type BuilderCapKey = keyof typeof BUILDER_MAX_TOKENS;

/* ---------------------------------------------------------------------------
   The mode flag.
   --------------------------------------------------------------------------- */

export const OUTPUT_BUDGET_MODES = ["off", "report", "enforce"] as const;
export type OutputBudgetMode = (typeof OUTPUT_BUDGET_MODES)[number];
export const OUTPUT_BUDGETS_FLAG = "FORAY_OUTPUT_BUDGETS";

/** FORAY_OUTPUT_BUDGETS at call time; `report` when unset. A present but
 * unknown value throws `FlagValueError`, naming the variable only. */
export function outputBudgetMode(source: FlagSource = process.env): OutputBudgetMode {
  return readEnumFlag(OUTPUT_BUDGETS_FLAG, OUTPUT_BUDGET_MODES, "report", source);
}

/**
 * The max_tokens a provider sends for a call: `builderCap` unless the mode
 * is `enforce` and the stage has a positive budget, then min(cap, budget). A
 * 0 or unknown budget leaves the cap: 0 marks a stage that should not call a
 * model on the timed path, not a request for an empty reply.
 */
export function enforcedMaxTokens(builderCap: number, budget: number | null, mode: OutputBudgetMode): number {
  if (mode !== "enforce" || budget === null || budget <= 0) return builderCap;
  return Math.min(builderCap, budget);
}

/* ---------------------------------------------------------------------------
   Truncation policy: what a provider does with a reply cut off at its cap.
   --------------------------------------------------------------------------- */

/**
 * - refuse: throw, as createMessage does for every JSON reply today (gen-10).
 * - reask-once-naming-overrun: ask again ONCE, telling the model it ran past
 *   its budget; a second truncation is refused.
 * - keep-finished-seams: keep the units that finished before the cut (seams
 *   for the writer; passages for evidence retrieval, which is today's
 *   createWebSearchTurnKeepingTruncation rule) and drop the cut one.
 */
export type TruncationPolicy = "refuse" | "reask-once-naming-overrun" | "keep-finished-seams";

export const TRUNCATION_POLICY: Readonly<Record<BudgetStage, TruncationPolicy>> = {
  "understand.clarity": "refuse",
  "understand.intent": "refuse",
  "understand.title": "refuse",
  research: "refuse",
  retrieval: "keep-finished-seams",
  spine: "reask-once-naming-overrun",
  deepen: "refuse",
  "narrate.act": "keep-finished-seams",
  "narrate.seam1": "keep-finished-seams",
  "narrate.verify": "refuse",
  continuity: "refuse"
};

/** The stop reasons that mean "cut off at max_tokens": Anthropic's and the
 * OpenAI-compatible (LiteLLM, SGLang) spelling. */
export const TRUNCATION_STOP_REASONS: readonly string[] = ["max_tokens", "length"];

export type TruncationDecision = "accept" | "refuse" | "reask-once-naming-overrun" | "keep-finished-seams";

/**
 * What the provider must do with one reply. Pure. `attempt` is 1-based (1 is
 * the first ask). A reply that did not stop at its cap is accepted; one that
 * did follows the stage's policy, and a re-ask policy refuses from attempt 2.
 */
export function truncationDecision(
  stage: BudgetStage,
  reply: { stopReason: string | null | undefined; attempt: number }
): TruncationDecision {
  if (!Number.isInteger(reply.attempt) || reply.attempt < 1) {
    throw new RangeError("truncationDecision: attempt must be a positive integer (1 is the first ask)");
  }
  if (!reply.stopReason || !TRUNCATION_STOP_REASONS.includes(reply.stopReason)) return "accept";
  const policy = TRUNCATION_POLICY[stage];
  if (policy === "reask-once-naming-overrun") return reply.attempt === 1 ? policy : "refuse";
  return policy;
}

/* ---------------------------------------------------------------------------
   Which budget a CallRecord is held to.
   --------------------------------------------------------------------------- */

/**
 * The createMessage labels in the Anthropic builders. The prompt understander
 * sends clarity, intent and the title re-ask all under `prompt-understand`,
 * so that label is told apart by role, then by the cap the call sent
 * (BUILDER_MAX_TOKENS), else it is taken as intent.
 */
export const LABEL_BUDGET_STAGES: Readonly<Record<string, BudgetStage | "understand">> = {
  "prompt-understand": "understand",
  "external-research": "research",
  "evidence-retrieval": "retrieval",
  spine: "spine",
  "deepen-act": "deepen",
  narration_write_act: "narrate.act",
  "narration-verify": "narrate.verify",
  "continuity-smooth": "continuity"
};

const ROLE_BUDGET_STAGES: Readonly<Record<string, BudgetStage>> = {
  clarity: "understand.clarity",
  intent: "understand.intent",
  title: "understand.title",
  writer: "narrate.act",
  verifier: "narrate.verify"
};

function understandStage(role: string | null | undefined, maxTokens: number | null | undefined): BudgetStage {
  if (role === "clarity") return "understand.clarity";
  if (role === "intent") return "understand.intent";
  if (role === "title") return "understand.title";
  if (maxTokens === BUILDER_MAX_TOKENS.clarity) return "understand.clarity";
  if (maxTokens === BUILDER_MAX_TOKENS.title) return "understand.title";
  return "understand.intent";
}

/** A pipeline stage name (runPipeline.ts's `timed`) to its budget stage. */
function pipelineStage(stage: string): BudgetStage | null {
  const base = stage.split(":")[0];
  switch (base) {
    case "understand":
      return "understand.intent";
    case "research-shape":
      return "research";
    case "evidence":
      return "retrieval";
    case "spine":
      return "spine";
    case "deepen":
      return "deepen";
    case "narrate":
      return "narrate.act";
    case "stitch":
      return "continuity";
    default:
      return null;
  }
}

/**
 * The BudgetStage a CallRecord is held to: its label first (the most
 * specific), then its role, then the pipeline stage in its context (with a
 * Jev `judge` call mapped to the decision that stage asks of it). Null when
 * none of them names a budgeted stage.
 */
export function budgetStageOf(record: {
  label?: string | null;
  role?: string | null;
  stage?: string | null;
  maxTokens?: number | null;
}): BudgetStage | null {
  const byLabel = record.label ? LABEL_BUDGET_STAGES[record.label] : undefined;
  if (byLabel === "understand") return understandStage(record.role, record.maxTokens);
  if (byLabel) return byLabel;
  const byRole = record.role ? ROLE_BUDGET_STAGES[record.role] : undefined;
  if (byRole) return byRole;
  const byStage = record.stage ? pipelineStage(record.stage) : null;
  /* A Jev call (role 'judge', GV-20) decides: in understand it is the
     clarity check, in narrate the act verify, and nowhere else budgeted. */
  if (record.role === "judge") return byStage === null ? null : (JUDGE_BUDGET_STAGES[byStage] ?? null);
  return byStage;
}

const JUDGE_BUDGET_STAGES: Partial<Record<BudgetStage, BudgetStage>> = {
  "understand.intent": "understand.clarity",
  "narrate.act": "narrate.verify"
};

/**
 * The `outputBudget` and `overBudget` a CallRecord is stamped with in report
 * (and enforce) mode: the budget of its stage on `tier`, and whether its
 * output tokens exceeded it. Null where the stage, the tier, the budget or
 * the output count is unknown; an unknown is never read as "within budget".
 */
export function stampOutputBudget(
  record: { label?: string | null; role?: string | null; stage?: string | null; maxTokens?: number | null; outputTokens?: number | null },
  tier: string | null | undefined
): { outputBudget: number | null; overBudget: boolean | null } {
  const stage = budgetStageOf(record);
  const outputBudget = stage && isBudgetTier(tier) ? outputBudgetFor(stage, tier) : null;
  const outputTokens = record.outputTokens ?? null;
  const overBudget = outputBudget !== null && outputTokens !== null ? outputTokens > outputBudget : null;
  return { outputBudget, overBudget };
}
