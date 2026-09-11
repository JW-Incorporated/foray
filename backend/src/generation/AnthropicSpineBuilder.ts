import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../config/env";
import { costFor, modelFor } from "../config/models";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import { parseWithRetry } from "./parseWithRetry";
import type { IntentUnderstanding } from "../types/generation";
import type { ResearchShape } from "../types/research";
import { DURATION_SHAPE_BUDGETS, SPINE_MIN_SEEDED_BEATS_PER_ACT, type DurationTier, type Spine } from "../types/spine";
import type { SpineBuildContext, SpineBuilder } from "./SpineBuilder";
import { SPINE_SEED_REPEAT_MIN, SPINE_SEED_THIRD_MIN } from "./spineSeeding";
import { recordUsage } from "./usageTracking";

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

/* Model id and per-token rates come from `src/config/models.ts`, the one
 * place a Claude model id is written down (F-03). Which TIER this stage
 * needs stays this stage's decision; which model serves that tier does not.
 * An id and its price are read from the same row, so they cannot drift
 * apart the way seven hand-copied pairs did. */
const MODEL = modelFor("opus");
const USD_PER_INPUT_TOKEN = costFor("opus").usdPerInputToken;
const USD_PER_OUTPUT_TOKEN = costFor("opus").usdPerOutputToken;
const MAX_OUTPUT_TOKENS = 8000;

/* `seed` is optional and passed through: WS-L asks for at least
   `SPINE_MIN_SEEDED_BEATS_PER_ACT` beats per act written from a quoted
   transcript window, and the seed is how the beat says which one. A missing or
   malformed seed must not cost the whole spine a re-ask — `spineStructure.ts`
   is what enforces the floor, with a message that says what to fix. */
const BeatSeedSchema = z.object({ episodeId: z.string(), startSec: z.number(), endSec: z.number() });
const BeatSchema = z.object({ claim: z.string(), exploration: z.boolean(), seed: BeatSeedSchema.optional() });
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

    recordUsage(response.usage);
    const textBlock = response.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
    if (!textBlock) throw new Error("Anthropic spine response had no text block");

    const reask = async (): Promise<string> => {
      const reaskLine = "Your previous reply was not valid JSON; reply with the JSON object only.";
      // The re-ask is its own real API call — it re-sends the whole prompt
      // plus the bad reply, so it is its own metered spend, gated the same
      // way as the original call (see parseWithRetry.ts's BUDGET note).
      const reaskEstimatedInputTokens = roughTokenEstimate(promptText + textBlock.text + reaskLine);
      await this.budgetGuard.checkAndRecord({
        userId: ctx.userId,
        operation: "spine_build",
        provider: this.providerName,
        model: MODEL,
        estimatedUsd: reaskEstimatedInputTokens * USD_PER_INPUT_TOKEN + MAX_OUTPUT_TOKENS * USD_PER_OUTPUT_TOKEN,
        sessionId: ctx.sessionId
      });

      const retryResponse = await this.client.messages.create({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [
          { role: "user", content: promptText },
          { role: "assistant", content: textBlock.text },
          { role: "user", content: reaskLine }
        ]
      });
      const retryTextBlock = retryResponse.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
      if (!retryTextBlock) throw new Error("Anthropic spine re-ask response had no text block");
      return retryTextBlock.text;
    };

    const raw = await parseWithRetry(RawSpineSchema, textBlock.text, "Anthropic spine output", reask);
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


/**
 * WHAT THE TAPE SAYS, UNDER THE SUBTOPIC IT SAYS IT ABOUT (WS-L; finding F-63).
 *
 * This is the change F-63 asks for, in the one place it can be made: run 2's
 * spine prompt said "Ai (semantic-concept, tape: strong, 761 items)" and not one
 * word of what those 761 items contain, so Opus wrote 35 beats from its own
 * knowledge of production machine learning and the archive was asked, four
 * stages later, to illustrate claims about ImageNet and feature stores that
 * nobody in it has ever uttered. The windows below are the archive's own
 * sentences, with the episode and the seconds they were spoken at.
 */
function tapeWindowLines(researchShape: ResearchShape): string[] {
  const lines: string[] = [];
  for (const subtopic of researchShape.subtopics) {
    if (subtopic.tapeWindows.length === 0) continue;
    lines.push(`  ${subtopic.label} — what the tape says:`);
    for (const w of subtopic.tapeWindows) {
      lines.push(`    [${w.episodeId} ${Math.round(w.startSec)}-${Math.round(w.endSec)}s] ${w.showTitle} — ${w.episodeTitle}`);
      lines.push(`      "${w.text}"`);
    }
  }
  return lines;
}

/** Exported for tests and for measuring the prompt's size against a real
 * research map (G-25 records it): the words that reach the model are the
 * whole of WS-L and G-25, so they are asserted on directly. */
export function buildSpinePrompt(intent: IntentUnderstanding, researchShape: ResearchShape, duration: DurationTier): string {
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

  const windowLines = tapeWindowLines(researchShape);
  /* ONE RULE, ADDED ONLY WHEN THERE IS TAPE TO OBEY IT WITH. A subject the
     archive is silent on keeps exactly today's prompt — §4.2's guardrail again:
     tape is a signal, never a filter. */
  /* AND WHICH EPISODES THE SEEDS IN ONE SLOT MAY COME FROM (F-70). A Foray may
     not draw more than a quarter of its segments from one episode (M4) and may
     not play one episode's tape backwards (M3), and run 2 attempt 4b broke both
     at once: two seeded beats in one slot named the SAME *Practical AI*
     episode, the later beat quoting the earlier stretch of it. The mechanical
     guarantee is `sourceBeats.ts`'s ledger, which now refuses the second window
     in either case — this paragraph exists so the spine stops asking for tape
     that will be refused, and spreads its seeds instead. Guidance, not a gate:
     a subject whose tape lives in one episode still gets a spine. */
  /* AND THE FLOOR IS A FLOOR, NOT THE ASK (G-25; tape-yield brief §5 R4). On
     the run-2 checkpoint the unseeded search admitted 0 of 14 beats at every
     floor value and the seeded path admitted 10 of 14: the seed is the only
     path that yields, so a Foray's tape count is bounded by how many beats the
     spine chose to seed. WS-L asked for two per act and the spine wrote
     fourteen seeds for thirty-two beats. It is now asked to seed every ACCOUNT
     beat a quoted window can carry, and told what an account beat is in the
     same words `types/spine.ts`'s `BeatKind` uses, so that the beats it leaves
     unseeded are the ones no recording could carry — arguments, which
     narration is for — and not simply the ones past the floor.
     AND THE M4 CAP IS STATED IN NUMBERS (R3; `spineSeeding.ts`). "A quarter"
     was already here; what it means at seeding time — one seed per episode
     until the spine carries eight — was not, and the run-2 spine seeded two
     episodes twice with fourteen seeds and lost an on-claim window to it. */
  const seedRule =
    windowLines.length === 0
      ? []
      : [
          "",
          `Every act must carry at least ${SPINE_MIN_SEEDED_BEATS_PER_ACT} beats whose claim states something one of the quoted`,
          "windows above actually says. Each of those beats carries \"seed\": {\"episodeId\": ..., \"startSec\": ...,",
          "\"endSec\": ...} copied from the bracketed window it was written from. Beats written from anything else",
          "omit \"seed\".",
          "",
          "That floor is a minimum, not a target: SEED EVERY ACCOUNT BEAT A WINDOW CAN CARRY. An account beat",
          "states an event, a practice, a measurement or a mechanism a person could be heard describing —",
          "whenever one of the quoted windows says it, write the claim from that window's own words and seed",
          "it. Only an argument beat — a claim about what something MEANS or what someone SHOULD do, which no",
          "recording of an event carries — stays unseeded and is narrated; so does a beat no quoted window",
          "actually says. Never seed a claim its window does not say: every seed is checked against the tape's",
          "own words downstream, and a claim the window does not carry is narrated anyway, with the seed wasted.",
          "",
          "Spread the seeds across EPISODES: across the WHOLE spine, seeded beats must name DIFFERENT episodeIds",
          "wherever the windows above allow it — no episode can supply more than a quarter of the finished",
          `Foray's tape. Concretely: seed each episodeId ONCE until the whole spine carries at least ${SPINE_SEED_REPEAT_MIN}`,
          "seeded beats; a second seed from an episode already seeded is admitted only after that, and a third",
          `only once the spine carries ${SPINE_SEED_THIRD_MIN}. A repeat seeded before then is refused downstream and its beat`,
          "narrated — take another episode's window instead. Each window above is listed once (no episode is quoted",
          "under two subtopics), so a repeat seed names the SAME window again with a sentence of it not yet",
          "used. If the spine really must seed two beats from the SAME",
          "episode, put them in the order the tape says them: the beat seeded from the earlier startSec comes first."
        ];

  return [
    `Build the SPINE for an audio documentary ("Foray") on: "${intent.subject}".`,
    `Angle: ${intent.angle}`,
    `What the listener probably already knows: ${intent.priorKnowledge}`,
    `This Foray disappoints if: ${intent.disappointment}`,
    "",
    "Research map (candidate subtopics found so far):",
    subtopicLines,
    ...windowLines,
    ...seedRule,
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
      '"slots": [{"title": string, "beats": [{"claim": string, "exploration": boolean, ' +
      '"seed"?: {"episodeId": string, "startSec": number, "endSec": number}}]}]}]}'
  ].join("\n");
}
