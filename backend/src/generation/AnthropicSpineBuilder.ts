import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../config/env";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import { parseWithRetry } from "./parseWithRetry";
import type { IntentUnderstanding } from "../types/generation";
import type { ResearchShape } from "../types/research";
import { DURATION_SHAPE_BUDGETS, type DurationTier, type Spine } from "../types/spine";
import type { SpineBuildContext, SpineBuilder } from "./SpineBuilder";

/**
 * Real §4.3 spine construction via the Anthropic API, mirroring
 * AnthropicPromptUnderstander / AnthropicExternalResearcher's structure
 * and model choice. This is the single most consequential LLM call in
 * the pipeline (§4.3: "the highest-leverage artefact... splitting it is
 * the most likely way to produce an incoherent Foray") so it uses a
 * larger model and a larger output budget than the earlier stages, and
 * it is called EXACTLY ONCE per Foray — never per-act, never per-beat.
 *
 * NEVER instantiate this class in a test — same rule as every other
 * Anthropic* class in this codebase. Use createSpineBuilder() everywhere
 * except explicit, human-invoked production code paths.
 */

const MODEL = "claude-opus-4-1";
const USD_PER_INPUT_TOKEN = 15.0 / 1_000_000;
const USD_PER_OUTPUT_TOKEN = 75.0 / 1_000_000;
const MAX_OUTPUT_TOKENS = 8000;

const BeatSchema = z.object({ claim: z.string(), exploration: z.boolean() });
const SlotSchema = z.object({ title: z.string(), beats: z.array(BeatSchema) });
const ActSchema = z.object({
  title: z.string(),
  thesis: z.string(),
  startState: z.string(),
  endState: z.string(),
  slots: z.array(SlotSchema)
});
const VoiceSchema = z.object({
  style: z.string(),
  register: z.string(),
  sentenceRhythm: z.string(),
  narratorPresence: z.string()
});
const RawSpineSchema = z.object({ voice: VoiceSchema, acts: z.array(ActSchema) });

function roughTokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

export class AnthropicSpineBuilder implements SpineBuilder {
  readonly providerName = "anthropic";
  private readonly client: Anthropic;

  /** `client` is an optional injection point for tests — see
   * AnthropicEnricher.ts's constructor doc comment for the full rationale;
   * the same pattern applies identically here. */
  constructor(private readonly budgetGuard: BudgetGuard = defaultBudgetGuard, client?: Anthropic) {
    if (!client && env.anthropicDryRun) {
      throw new Error(
        "AnthropicSpineBuilder constructed without ANTHROPIC_API_KEY set — use createSpineBuilder() so it falls back to StubSpineBuilder instead."
      );
    }
    this.client = client ?? new Anthropic({ apiKey: env.anthropicApiKey });
  }

  async buildSpine(
    intent: IntentUnderstanding,
    researchShape: ResearchShape,
    duration: DurationTier,
    ctx: SpineBuildContext
  ): Promise<Spine> {
    const promptText = buildSpinePrompt(intent, researchShape, duration);
    const estimatedInputTokens = roughTokenEstimate(promptText);
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "spine_build",
      provider: this.providerName,
      model: MODEL,
      estimatedUsd: estimatedInputTokens * USD_PER_INPUT_TOKEN + MAX_OUTPUT_TOKENS * USD_PER_OUTPUT_TOKEN,
      sessionId: ctx.sessionId
    });

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [{ role: "user", content: promptText }]
    });

    const textBlock = response.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
    if (!textBlock) throw new Error("Anthropic spine response had no text block");

    const raw = parseWithRetry(RawSpineSchema, textBlock.text, "Anthropic spine output");
    return {
      subject: intent.subject,
      angle: intent.angle,
      duration,
      generatedAt: new Date().toISOString(),
      voice: raw.voice,
      acts: raw.acts
    };
  }
}


function buildSpinePrompt(intent: IntentUnderstanding, researchShape: ResearchShape, duration: DurationTier): string {
  const budget = DURATION_SHAPE_BUDGETS[duration];
  const subtopicLines = researchShape.subtopics
    .map(
      (s) =>
        `- ${s.label} (${s.source}, tape: ${s.tape.signal}, ${s.tape.itemCount} items${
          s.controversies.length > 0 ? `; controversies: ${s.controversies.join("; ")}` : ""
        }${
          // §4.2's external research is only invoked for a genuine catalogue
          // gap and is the most expensive collaborator in that stage — its
          // findings must actually reach this prompt, or the paid call has
          // no effect on the Foray's shape and the gap subtopic gets
          // invented from its bare label alone.
          s.externallyResearched && s.externalNotes ? `; external research: ${s.externalNotes}` : ""
        })`
    )
    .join("\n");

  return [
    `Build the SPINE for an audio documentary ("Foray") on: "${intent.subject}".`,
    `Angle: ${intent.angle}`,
    `What the listener probably already knows: ${intent.priorKnowledge}`,
    `This Foray disappoints if: ${intent.disappointment}`,
    "",
    "Research map (candidate subtopics found so far):",
    subtopicLines,
    "",
    `Duration tier: ${duration}. Target exactly, within a small tolerance: ${budget.acts[0]}-${budget.acts[1]} acts, ` +
      `${budget.slots[0]}-${budget.slots[1]} slots total, ${budget.items[0]}-${budget.items[1]} beats total.`,
    "",
    "For EACH act, give: title, thesis, startState (what the listener believes entering), endState",
    "(what they believe leaving), and slots (each with a title and an ordered list of beats).",
    "",
    "Every beat MUST be a CLAIM, not a topic. Example: \"Charcoal briquettes were a Ford Motor",
    "Company waste-disposal scheme\" is a beat; \"Briquettes\" is not.",
    "",
    "Mark at least 30% of ALL beats (across the whole spine) with exploration: true — beats that go",
    "somewhere the prompt didn't literally ask for but a curious listener would want. Do not just",
    "sprinkle a token few; hit the floor for real.",
    "",
    "Decide the VOICE once for the whole spine (style, register, sentenceRhythm, narratorPresence) —",
    "it applies to every act; do not vary it per act.",
    "",
    "Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:",
    '{"voice": {"style": string, "register": string, "sentenceRhythm": string, "narratorPresence": string}, ' +
      '"acts": [{"title": string, "thesis": string, "startState": string, "endState": string, ' +
      '"slots": [{"title": string, "beats": [{"claim": string, "exploration": boolean}]}]}]}'
  ].join("\n");
}
