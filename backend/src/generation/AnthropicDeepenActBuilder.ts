import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../config/env";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import { parseWithRetry } from "./parseWithRetry";
import type { Act, DeepenedAct, Spine } from "../types/spine";
import type { DeepenActBuilder, DeepenActContext } from "./DeepenActBuilder";

/**
 * Real §4.4 act-deepening via the Anthropic API, mirroring
 * AnthropicSpineBuilder's structure. Called ONCE PER ACT (§5: "1 per act
 * (3-7)"), always with the FULL spine attached to the prompt so the model
 * never has to guess what a sibling act already established.
 *
 * NEVER instantiate this class in a test — same rule as every other
 * Anthropic* class in this codebase. Use createDeepenActBuilder().
 */

const MODEL = "claude-sonnet-4-5";
const USD_PER_INPUT_TOKEN = 3.0 / 1_000_000;
const USD_PER_OUTPUT_TOKEN = 15.0 / 1_000_000;
const MAX_OUTPUT_TOKENS = 4000;

const BeatSchema = z.object({ claim: z.string(), exploration: z.boolean() });
const SlotSchema = z.object({ title: z.string(), beats: z.array(BeatSchema) });
const RawDeepenedActSchema = z.object({
  title: z.string(),
  thesis: z.string(),
  startState: z.string(),
  endState: z.string(),
  slots: z.array(SlotSchema),
  introduction: z.string(),
  exit: z.string()
});

function roughTokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

export class AnthropicDeepenActBuilder implements DeepenActBuilder {
  readonly providerName = "anthropic";
  private readonly client: Anthropic;

  /** `client` is an optional injection point for tests — see
   * AnthropicEnricher.ts's constructor doc comment for the full rationale;
   * the same pattern applies identically here. */
  constructor(private readonly budgetGuard: BudgetGuard = defaultBudgetGuard, client?: Anthropic) {
    if (!client && env.anthropicDryRun) {
      throw new Error(
        "AnthropicDeepenActBuilder constructed without ANTHROPIC_API_KEY set — use createDeepenActBuilder() so it falls back to StubDeepenActBuilder instead."
      );
    }
    this.client = client ?? new Anthropic({ apiKey: env.anthropicApiKey });
  }

  async deepenAct(fullSpine: Spine, targetAct: Act, targetActIndex: number, ctx: DeepenActContext): Promise<DeepenedAct> {
    const promptText = buildDeepenActPrompt(fullSpine, targetAct, targetActIndex);
    const estimatedInputTokens = roughTokenEstimate(promptText);
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "deepen_act",
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
    if (!textBlock) throw new Error("Anthropic deepen-act response had no text block");

    return parseWithRetry(RawDeepenedActSchema, textBlock.text, "Anthropic deepen-act output");
  }
}


function buildDeepenActPrompt(spine: Spine, targetAct: Act, targetActIndex: number): string {
  const otherActsSummary = spine.acts
    .map((act, i) =>
      i === targetActIndex
        ? `Act ${i + 1} (THIS IS THE ACT YOU ARE DEEPENING — full detail below): "${act.title}"`
        : `Act ${i + 1}: "${act.title}" — thesis: ${act.thesis} — start: ${act.startState} — end: ${act.endState}`
    )
    .join("\n");

  const targetSlotLines = targetAct.slots
    .map((slot, i) => `  Slot ${i + 1}: "${slot.title}"\n${slot.beats.map((b) => `    - ${b.claim}${b.exploration ? " [exploration]" : ""}`).join("\n")}`)
    .join("\n");

  return [
    `You are deepening ONE act of a full spine for an audio documentary ("Foray") on: "${spine.subject}".`,
    `Angle: ${spine.angle}`,
    `Voice (decided once for the whole spine — do not vary it): style: ${spine.voice.style}; register: ${spine.voice.register}; ` +
      `sentence rhythm: ${spine.voice.sentenceRhythm}; narrator presence: ${spine.voice.narratorPresence}`,
    "",
    "FULL SPINE (all acts, for context — you own only the target act):",
    otherActsSummary,
    "",
    `TARGET ACT (Act ${targetActIndex + 1} of ${spine.acts.length}): "${targetAct.title}"`,
    `Thesis: ${targetAct.thesis}`,
    `Start state: ${targetAct.startState}`,
    `End state: ${targetAct.endState}`,
    "Slots and beats to refine:",
    targetSlotLines,
    "",
    "Your job:",
    "1. Refine this act's slots and sharpen its beats — make the claims more specific/concrete where they",
    "   are still high-level. Do NOT add or remove slots. You may refine beat wording but every beat must",
    "   remain a CLAIM, never a topic (e.g. \"Charcoal briquettes were a Ford Motor Company waste-disposal",
    "   scheme\" is a beat; \"Briquettes\" is not).",
    "2. Write this act's own INTRODUCTION — what a listener hears entering this act. Use the full spine so",
    `   act ${targetActIndex + 1} does not re-explain what an earlier act already established.`,
    "3. Write this act's EXIT — the connective tissue into the next act (its own half of the handoff; a",
    "   later continuity pass reconciles the full cross-act seam, this is just this act's side of it).",
    "",
    "Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:",
    '{"title": string, "thesis": string, "startState": string, "endState": string, ' +
      '"slots": [{"title": string, "beats": [{"claim": string, "exploration": boolean}]}], ' +
      '"introduction": string, "exit": string}'
  ].join("\n");
}
