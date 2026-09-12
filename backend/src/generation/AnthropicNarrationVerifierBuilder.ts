import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { parseWithRetry } from "./parseWithRetry";
import { env } from "../config/env";
import { costFor, modelFor } from "../config/models";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import type {
  ActSourceBrief,
  ActVerifyRequest,
  ActVerifyResult,
  NarrationBuildContext,
  NarrationVerifierBuilder,
  VerifyClipBrief
} from "./NarrationVerifierBuilder";
import { recordUsage } from "./usageTracking";

/**
 * Real §4.7 verification via the Anthropic API — a SEPARATE call, and
 * this file is a SEPARATE class, from `AnthropicNarrationWriterBuilder`.
 * §4.7 rule 2 / §5's topology table ("1 per act, never the writer") is
 * enforced at the orchestrator level (`writeNarration.ts` constructs two
 * distinct builder instances and never lets a caller pass the same
 * instance for both roles — see that file's doc comment), but this class
 * existing as its own file with its own prompt is what makes "a
 * genuinely different agent" true rather than aspirational: it never
 * imports, calls, or shares any state with
 * `AnthropicNarrationWriterBuilder`.
 *
 * REAL QUESTIONS, NOT ONE (WS-A). Run 1's prompt said "read it against
 * ONLY its declared sources", which made this a consistency check on the
 * writer's own declarations: it passed a page citing Chernobyl interviews
 * for a Kansas City claim in five seconds (F-27), never asked whether a
 * page did the job its beat existed for (F-41), and decided the
 * zero-source case by sampling (F-44). It is now given the act's beats,
 * prose, clips and whole source set, and answers per BEAT whether the
 * prose carries its claim and per SEAM whether every statement is
 * supported and a genuinely contested point handled (F-43 — the keyword
 * detector no longer decides this).
 *
 * It is NOT asked whether a quote exists. `writeNarration.ts` proves that
 * in code, against the held documents, before this is ever called.
 *
 * ONE CALL SINCE F-100. Runs 1-8 asked the same questions of one slot's
 * pages (`verifySlot`) and F-88 asked a fourth of a page whose retrieval
 * had found nothing (`verifySynthesis`). Q-03/F-97 folded both into
 * `verifyAct` — the ground F-88 needed is now part of the act's source set
 * — and both methods, both prompts and their schemas are deleted with
 * F-100. Neither could be reached: `createNarrationVerifierBuilder()`
 * returns this class or the stub, and both verify per act.
 *
 * NEVER instantiate this class in a test. Use createNarrationVerifierBuilder().
 */

/* Model id and per-token rates come from `src/config/models.ts`, the one
 * place a Claude model id is written down (F-03). Which TIER this stage
 * needs stays this stage's decision; which model serves that tier does not.
 * An id and its price are read from the same row, so they cannot drift
 * apart the way seven hand-copied pairs did. */
const MODEL = modelFor("sonnet");
const USD_PER_INPUT_TOKEN = costFor("sonnet").usdPerInputToken;
const USD_PER_OUTPUT_TOKEN = costFor("sonnet").usdPerOutputToken;
/* Q-03: one verdict per beat and one per seam of a whole act. F-97: each
 * names what it rests on (`restsOn`, ids of the act's source set) and a
 * carried beat names its carrier. Optional in the SCHEMA so a reply that
 * omits them is still valid JSON; `writeAct.ts` reads an absent `restsOn`
 * as "the seam's own claims" and refuses a declarative seam that rests on
 * nothing either way. */
const RawActVerifySchema = z.object({
  beats: z.array(
    z.object({
      beatId: z.string(),
      carried: z.boolean(),
      carriedBy: z.string().optional(),
      restsOn: z.array(z.string()).optional(),
      notes: z.string().optional()
    })
  ),
  seams: z.array(
    z.object({
      seamId: z.string(),
      claimsSupported: z.boolean(),
      restsOn: z.array(z.string()).optional(),
      contestedHandled: z.boolean(),
      notes: z.string().optional()
    })
  )
});
const MAX_ACT_VERIFY_OUTPUT_TOKENS = 4000;

function roughTokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

export class AnthropicNarrationVerifierBuilder implements NarrationVerifierBuilder {
  readonly providerName = "anthropic";
  private readonly client: Anthropic;

  constructor(private readonly budgetGuard: BudgetGuard = defaultBudgetGuard) {
    if (env.anthropicDryRun) {
      throw new Error(
        "AnthropicNarrationVerifierBuilder constructed without ANTHROPIC_API_KEY set — use createNarrationVerifierBuilder() so it falls back to StubNarrationVerifierBuilder instead."
      );
    }
    this.client = new Anthropic({ apiKey: env.anthropicApiKey });
  }

  /** Q-03: the per-beat question for a whole act. See `buildActVerifyPrompt`. */
  async verifyAct(request: ActVerifyRequest, ctx: NarrationBuildContext): Promise<ActVerifyResult> {
    const raw = await this.ask(buildActVerifyPrompt(request), RawActVerifySchema, ctx, MAX_ACT_VERIFY_OUTPUT_TOKENS);
    return { beats: raw.beats, seams: raw.seams.map((s) => ({ ...s, restsOn: s.restsOn ?? [] })) };
  }

  private async ask<T>(promptText: string, schema: z.ZodType<T>, ctx: NarrationBuildContext, maxOutputTokens: number): Promise<T> {
    const estimatedInputTokens = roughTokenEstimate(promptText);
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "narration_verify",
      provider: this.providerName,
      model: MODEL,
      estimatedUsd: estimatedInputTokens * USD_PER_INPUT_TOKEN + maxOutputTokens * USD_PER_OUTPUT_TOKEN,
      sessionId: ctx.sessionId
    });

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: maxOutputTokens,
      messages: [{ role: "user", content: promptText }]
    });

    recordUsage(response.usage);
    const textBlock = response.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
    if (!textBlock) throw new Error("Anthropic narration-verify response had no text block");

    const reask = async (): Promise<string> => {
      const reaskLine = "Your previous reply was not valid JSON; reply with the JSON object only.";
      // The re-ask is its own real API call — it re-sends the whole prompt
      // plus the bad reply, so it is its own metered spend, gated the same
      // way as the original call (see parseWithRetry.ts's BUDGET note).
      // Run 1's verifier call #34 returned an unclosed object and charged a
      // page one of its three attempts for it (F-39); this is that fix.
      const reaskEstimatedInputTokens = roughTokenEstimate(promptText + textBlock.text + reaskLine);
      await this.budgetGuard.checkAndRecord({
        userId: ctx.userId,
        operation: "narration_verify",
        provider: this.providerName,
        model: MODEL,
        estimatedUsd: reaskEstimatedInputTokens * USD_PER_INPUT_TOKEN + maxOutputTokens * USD_PER_OUTPUT_TOKEN,
        sessionId: ctx.sessionId
      });

      const retryResponse = await this.client.messages.create({
        model: MODEL,
        max_tokens: maxOutputTokens,
        messages: [
          { role: "user", content: promptText },
          { role: "assistant", content: textBlock.text },
          { role: "user", content: reaskLine }
        ]
      });
      recordUsage(retryResponse.usage);
      const retryTextBlock = retryResponse.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
      if (!retryTextBlock) throw new Error("Anthropic narration-verify re-ask response had no text block");
      return retryTextBlock.text;
    };

    return parseWithRetry(schema, textBlock.text, "LLM output", reask);
  }
}

/**
 * Q-03: the per-act verification prompt. The beats are the CHECKLIST;
 * the act's seams and clips are laid out in play order with every clip's
 * transcript window; the answer is one verdict per beat (carried, by
 * which seam or clip, resting on which act sources, or a note naming what
 * is missing and where it belongs) and one per seam (the two page
 * questions that survive — support and contested; purpose is now the
 * per-beat question — plus what the seam rests on).
 *
 * F-97: SUPPORT IS ACT-SCOPED. The act's sources are printed ONCE, as one
 * numbered set — every claim any seam selected, every clip's window, every
 * verified page of an earlier act — and a seam's statements may rest on
 * any of them. The verifier is told so in as many words, because run 9's
 * prompt said "the source attached to it" and refused every bridge.
 * Seams marked frozen were confirmed in an earlier round: context only.
 * Introductions are exempt from the support question: who is speaking,
 * the show and the episode are checked structurally against the segment
 * source row before this is called (Q-02). Exported for the prompt tests
 * only.
 */
export function buildActVerifyPrompt(request: ActVerifyRequest): string {
  const clips = new Map(request.clips.map((c) => [c.clipId, c]));
  const judged = request.seams.filter((s) => !s.frozen).map((s) => s.seamId);
  return [
    `You are the FACT-VERIFICATION pass for the narration of one act ("${request.actTitle}") of an audio documentary ("Foray"). You did NOT write it.`,
    "",
    "THE CHECKLIST — the beats to judge this round (each must be carried somewhere in the act):",
    ...(request.beats.length > 0
      ? request.beats.flatMap((b) =>
          /* F-99: a beat whose seed tape is not in this Foray. Judged on
             what the act's sources CAN carry: demanding the seed's
             specifics is demanding something no seam could ever have
             written, which is how six of run 9's eight unverified pages
             came to be. */
          b.seedLost
            ? [
                `  ${b.beatId}: ${b.claim}`,
                `    SEED LOST — the tape this claim was written from is NOT in this act and nothing was retrieved for it. Judge it carried when the prose makes as much of its point as the act's sources support; do NOT demand the names, numbers or incidents that only the missing tape could supply. If the act's sources do not reach the point at all, say exactly that in notes.`
              ]
            : [`  ${b.beatId}: ${b.claim}`]
        )
      : ["  (none — every beat is already confirmed)"]),
    "",
    "THE ACT'S SOURCES — one set for the whole act. Any statement in any seam may rest on any of these, not only the ones the seam selected:",
    ...request.sources.map(actSourceEntry),
    "",
    "THE ACT, IN PLAY ORDER — narration seams and the clips of real tape between them:",
    actVerifyLayout(request, clips),
    "",
    "Answer two sets of questions.",
    "1. For each BEAT on the checklist: carried — does the act's narration (any seam, frozen ones included, not only the one the beat was positioned in)",
    "   or one of its clips make the beat's point, resting on an act source (a selected claim, a clip's window, a verified page)? A beat is carried when",
    "   a listener would hear its point made, in whatever words. It is NOT carried when no seam or clip makes the point, or a seam makes it and nothing",
    "   in the act's sources supports it. When carried, say by which seam or clip (carriedBy: \"s1\" or \"c0\") and on which sources it rests (restsOn).",
    "   When not carried, say in notes which seam it belongs in and what is missing, in one sentence a writer can act on.",
    `2. For each SEAM to judge (${judged.join(", ") || "none"}; the FROZEN seams are confirmed already — do not answer for them):`,
    "   claimsSupported — does every statement the script makes about the world follow from SOME act source above — this seam's selected claims,",
    "   another seam's, any clip's transcript window, any verified page? A bridge that restates what the clip before it established, or sets up",
    "   the clip after it, is supported by those windows. Judge a statement about a clip against that clip's window as printed on its CLIP line.",
    "   Then list in restsOn the ids of the sources the seam's statements actually rest on — required whenever claimsSupported is true and the",
    "   script states anything; a seam that only asks a question or hands off to the listener rests on nothing and lists none.",
    "   When a statement is NOT supported, QUOTE the sentence in notes, and say what no source covers.",
    "   EXEMPT from this question: the sentences that introduce a clip — who is speaking, the show, the episode — which are checked by",
    "   structure against the segment's source row before you are called. Do not fail a seam for them.",
    "   contestedHandled — read the sources: if reputable sources actively disagree about something the script asserts, the script must",
    "   say the point is disputed, in any natural wording. If nothing is genuinely contested, this is true.",
    "",
    "Do NOT check whether a quote exists in its source — that was already proven mechanically before you were called.",
    "",
    "DOCUMENTS the claims quote:",
    request.documents.filter((d) => d.kind !== "tape").map((d) => `  --- ${d.title}${d.url ? ` | ${d.url}` : ""}\n${d.text}`).join("\n") || "  (none — every source is a clip's window)",
    "",
    "Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:",
    '{"beats": [{"beatId": string, "carried": boolean, "carriedBy": string (the seam or clip id, when carried), "restsOn": string[] (source ids, when carried), "notes": string (required and specific whenever carried is false)}], ' +
      '"seams": [{"seamId": string, "claimsSupported": boolean, "restsOn": string[], "contestedHandled": boolean, "notes": string (required whenever an answer is false; quote the unsupported sentence)}]}'
  ].join("\n");
}

function actSourceEntry(s: ActSourceBrief): string {
  const contested = s.contested ? " [marked contested]" : "";
  if (s.kind === "clip") return `  ${s.id}: the transcript window of CLIP ${s.docId === s.id ? s.id : s.id} — ${s.claimText} (printed under the clip below)`;
  if (s.kind === "page") return `  ${s.id}: a VERIFIED PAGE of this Foray from an earlier act — "${s.claimText}" (${s.publication})`;
  const from = s.selectedBy ? ` (selected by seam ${s.selectedBy})` : "";
  if (s.publication.startsWith("This Foray, page")) return `  ${s.id}${from}: claim="${s.claimText}" quote="${s.quote ?? ""}" from a verified page — ${s.publication}${contested}`;
  if (s.docId.startsWith("tape:")) return `  ${s.id}${from} [TAPE]: claim="${s.claimText}"${s.quote ? ` echoes="${s.quote}"` : ""} — judge against the window of the clip it names (${s.publication})${contested}`;
  return `  ${s.id}${from}: claim="${s.claimText}" quote="${s.quote ?? ""}" publication="${s.publication}"${contested}`;
}

function actVerifyLayout(request: ActVerifyRequest, clips: Map<string, VerifyClipBrief>): string {
  const lines: string[] = [];
  for (const seam of request.seams) {
    const edges: string[] = [];
    if (seam.follows) edges.push(`follows CLIP ${seam.follows}`);
    if (seam.introduces) edges.push(`introduces CLIP ${seam.introduces} (introduction: ${seam.intro ?? "full"})`);
    lines.push(
      `SEAM ${seam.seamId}${seam.frozen ? " — FROZEN (confirmed in an earlier round; context only)" : ""}${seam.carries.length > 0 ? ` — positioned beats ${seam.carries.join(", ")}` : " — no beat positioned here"}${edges.length > 0 ? ` — ${edges.join(", ")}` : ""}`
    );
    lines.push(`  Script:\n${seam.script}`);
    lines.push(`  Selected sources: ${seam.selected.length > 0 ? seam.selected.join(", ") : "(none — it may rest on the act's other sources)"}`);
    if (seam.introduces) {
      const clip = clips.get(seam.introduces);
      if (clip) {
        /* F-99: one clip may carry two beats (§4.5 merged the second
           beat's window into it). It plays once and there is one window:
           judge both beats against it. */
        const carried = clip.carries ?? [];
        lines.push(
          `CLIP ${clip.clipId} — "${clip.title}" on ${clip.show || "an unnamed show"}, ${Math.round(clip.durationSec)} s of tape${clip.docId ? ` (${clip.docId})` : ""}` +
            (carried.length > 1 ? ` — carries beats ${carried.map((b) => b.beatId).join(", ")}, judged against this one window` : "")
        );
        if (carried.length > 1) for (const beat of carried) lines.push(`  it carries beat ${beat.beatId}: ${beat.claim}`);
        lines.push(`  Transcript window:\n${clip.windowText || "    (the window is not held — treat any statement about this clip as unsupported)"}`);
      }
    }
  }
  return lines.join("\n");
}
