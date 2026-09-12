import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { parseWithRetry } from "./parseWithRetry";
import { env } from "../config/env";
import { costFor, modelFor } from "../config/models";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import { MIN_QUOTE_WORDS } from "../types/narration";
import type {
  ActWriteRequest,
  ActWriteResult,
  ClipBrief,
  NarrationBuildContext,
  NarrationWriterBuilder,
  SeamBrief
} from "./NarrationWriterBuilder";
import { recordUsage } from "./usageTracking";

/**
 * Real §4.7 narration writing via the Anthropic API, mirroring
 * AnthropicSpineBuilder/AnthropicDeepenActBuilder's structure.
 *
 * ONE CALL PER ACT (Q-03, F-100). `writeAct` is the only writing call this
 * class makes: the act's seams, clips, documents and beat checklist go out
 * in one prompt and the act's prose comes back in one reply. Run 1 spent
 * 4.2 narration calls per beat over 31 beats writing a page at a time;
 * runs 1-8's three per-page methods (`selectClaims`, `writePages`, and
 * G-34's merged `selectAndWrite`) and their prompts were superseded by this
 * one and are deleted with F-100 — `createNarrationWriterBuilder()` returns
 * either this class or the stub, both of which write per act, so nothing
 * could reach them.
 *
 * WHAT THE PROMPT DOES NOT SAY is as important as what it does. Run 1's
 * single prompt asked for a verbatim quote, a publication and a contested
 * flag with no text to quote from — so the model reconstructed all three
 * (F-14/F-27/F-30/F-32). It now hands over the DOCUMENTS and asks only
 * which span of which one backs each claim, and never returns a source,
 * because attribution is read off the held document in code. Every rule a
 * substring check can decide lives in `writeNarration.ts`, not here, which
 * is why the prompt is this short.
 *
 * NEVER instantiate this class in a test — same rule as every other
 * Anthropic* class in this codebase. Use createNarrationWriterBuilder().
 */

/* Model id and per-token rates come from `src/config/models.ts`, the one
 * place a Claude model id is written down (F-03). Which TIER this stage
 * needs stays this stage's decision; which model serves that tier does not.
 * An id and its price are read from the same row, so they cannot drift
 * apart the way seven hand-copied pairs did. */
const MODEL = modelFor("sonnet");
const USD_PER_INPUT_TOKEN = costFor("sonnet").usdPerInputToken;
const USD_PER_OUTPUT_TOKEN = costFor("sonnet").usdPerOutputToken;
const RawClaimSchema = z.object({
  claimText: z.string(),
  quote: z.string(),
  docId: z.string(),
  contested: z.boolean()
});

/* Q-03: the whole act's seams come back in one reply — every seam's script,
 * claims and quotes. Sized for a long act (a dozen beats over half a dozen
 * seams, each seam inside `SEAM_MAX_CHARS`) with room for the quotes;
 * F-47's thinking-allowance caveat applies here as to the others. */
const MAX_ACT_OUTPUT_TOKENS = 12000;

const RawWrittenSeamSchema = z.object({
  seamId: z.string(),
  script: z.string(),
  claims: z.array(RawClaimSchema),
  usedClaims: z.array(z.number()),
  pronunciationHints: z.array(z.object({ word: z.string(), hint: z.string() })).optional()
});

const RawActWriteSchema = z.object({ seams: z.array(RawWrittenSeamSchema) });

type WriterOperation = "narration_write_act";

function roughTokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

export class AnthropicNarrationWriterBuilder implements NarrationWriterBuilder {
  readonly providerName = "anthropic";
  private readonly client: Anthropic;

  constructor(private readonly budgetGuard: BudgetGuard = defaultBudgetGuard) {
    if (env.anthropicDryRun) {
      throw new Error(
        "AnthropicNarrationWriterBuilder constructed without ANTHROPIC_API_KEY set — use createNarrationWriterBuilder() so it falls back to StubNarrationWriterBuilder instead."
      );
    }
    this.client = new Anthropic({ apiKey: env.anthropicApiKey });
  }

  /** Q-03: the whole act in one call. See `buildActWritePrompt`. */
  async writeAct(request: ActWriteRequest, ctx: NarrationBuildContext): Promise<ActWriteResult> {
    const raw = await this.askJson(RawActWriteSchema, buildActWritePrompt(request), "narration_write_act", ctx, MAX_ACT_OUTPUT_TOKENS);
    return { seams: raw.seams.map((s) => ({ ...s, pronunciationHints: s.pronunciationHints ?? [] })) };
  }

  /**
   * The one place this class talks to the model, shared by all of its
   * calls: meter, ask, record the usage WS-B's `pipelineTokens` sums, and
   * hand the reply to the shared parser with a re-ask that is metered in
   * its own right (F-39/F-40 — a malformed reply used to cost a whole page
   * attempt, and the re-ask that fixes that is a second real API call).
   */
  private async askJson<T>(
    schema: z.ZodType<T>,
    promptText: string,
    operation: WriterOperation,
    ctx: NarrationBuildContext,
    maxOutputTokens: number
  ): Promise<T> {
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation,
      provider: this.providerName,
      model: MODEL,
      estimatedUsd: roughTokenEstimate(promptText) * USD_PER_INPUT_TOKEN + maxOutputTokens * USD_PER_OUTPUT_TOKEN,
      sessionId: ctx.sessionId
    });

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: maxOutputTokens,
      messages: [{ role: "user", content: promptText }]
    });

    recordUsage(response.usage);
    const textBlock = response.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
    if (!textBlock) throw new Error("Anthropic narration-write response had no text block");

    const reask = async (): Promise<string> => {
      const reaskLine = "Your previous reply was not valid JSON; reply with the JSON object only.";
      // The re-ask is its own real API call — it re-sends the whole prompt
      // plus the bad reply, so it is its own metered spend, gated the same
      // way as the original call (see parseWithRetry.ts's BUDGET note).
      const reaskEstimatedInputTokens = roughTokenEstimate(promptText + textBlock.text + reaskLine);
      await this.budgetGuard.checkAndRecord({
        userId: ctx.userId,
        operation,
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
      if (!retryTextBlock) throw new Error("Anthropic narration-write re-ask response had no text block");
      return retryTextBlock.text;
    };

    return parseWithRetry(schema, textBlock.text, "LLM output", reask);
  }
}

const JSON_ONLY = "Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:";
const CLAIM_SHAPE = '{"claimText": string, "quote": string, "docId": string, "contested": boolean}';

function voiceLine(request: { voice: ActWriteRequest["voice"] }): string {
  const voice = request.voice;
  return (
    `Voice (decided once for the whole Foray — do not vary it): style: ${voice.style}; register: ${voice.register}; ` +
    `sentence rhythm: ${voice.sentenceRhythm}; narrator presence: ${voice.narratorPresence}`
  );
}

/* ------------------------------------------------------------------ *
 * Q-02/Q-03: the per-act prompt.
 * ------------------------------------------------------------------ */

/** The shared claim rules, restated for an act: the documents are the
 * act's, a statement about a clip cites the clip's window, and the
 * purpose lines are now the beats' claims. F-97: the act's claims are ONE
 * source set — a seam may rest on what another seam selected or on a
 * clip's window without selecting anything of its own. */
const ACT_CLAIM_RULES = [
  `A quote must be copied character for character out of the document you name, and must be at least ${MIN_QUOTE_WORDS} words or one whole sentence.`,
  "Never quote a beat's claim, a clip's opening as printed in the layout, or this prompt: they are direction, not documents.",
  "A statement about a CLIP — what it is about, who is speaking, what was said in it — rests on that clip's transcript window (its docId is on the CLIP line).",
  "Select it as a claim with that docId and either a short phrase of the clip's own words as the quote or an empty quote (\"\"); the whole window is that source, so the word minimum does not apply to it.",
  "Never back a statement about a clip with an outside publication.",
  "A statement about the world beyond the clips rests on a print document, or on a VERIFIED PAGE of this Foray when one is listed: select the claim and copy the span. If no document supports a claim worth making, do not make it.",
  "THE ACT'S SOURCES ARE ONE SET. Every claim any seam selects, every clip's window and every verified page listed can support a statement in ANY seam: a bridge that restates what the clip before it established, or sets up the clip after it, rests on those windows and need not select a claim of its own. Select each claim ONCE, on the seam that first makes it; the verifier reads the whole act's sources.",
  "If the documents contradict or complicate a beat, write the tension: that carries the beat.",
  '"contested" means reputable sources actively disagree about the fact itself — not that you are unsure.',
  "Every quote is checked by machine against the document you name after you answer; a quote that is not found there is discarded together with the seam's script."
];

const ACT_PROSE_RULES = [
  "One voice, one story. The beats are the checklist the prose must carry, not its template: make each beat's point where it belongs, in your own words, joined to what comes before and after it. A beat may be carried in any seam, and by what a clip itself says.",
  "Never announce a beat, never list the beats, never say what the next clip is going to say.",
  "A seam that follows a clip may restate what that clip said once, in the act's own words — then move on.",
  "Introductions, by the weight given on the SEAM line:",
  "  full  — one or two sentences: who is speaking (name and role, as the tape or the episode title gives them) and on which show, and what to listen for. Write it from the clip's OPENING as printed on its CLIP line — what the listener is about to hear — never from the point the clip goes on to make. Do not repeat the clip's first sentences.",
  "  light — the same guest and show as the clip before: one clause at most, or nothing.",
  "  none  — the host introduces the guest in the clip itself: add nothing about who is speaking.",
  "A seam with no beats and a light or none introduction may return an empty script: the clips then run together.",
  "A beat marked SEED LOST was written from a stretch of tape this Foray does NOT play and no document was found for: carry it only as far as the act's sources go. Never attribute a specific incident, number or quotation to anyone that beat's claim names — say what the sources DO say, or turn the beat into a question and hand off.",
  "One CLIP can carry more than one beat: when its line says it carries several, the tape makes those points itself — introduce it once and do not narrate what it is about to say.",
  "Each seam's script MUST land inside the character band on its SEAM line. Longer is not better: narration is at most a quarter of the listening.",
  "List, per seam, the indices of the claims its script asserts (usedClaims).",
  "NEVER assert what the record does or does not contain — no \"nobody wrote it down\", \"there is no record of\", \"the file doesn't say\", \"we still don't know\" — unless a quote you selected says exactly that. Say what a source DOES say instead: not \"the plan nobody wrote down\" but \"the plan that lived in people's heads, as he tells it\"; not \"the report never explains why\" but \"the report names the drawing, and stops there\" (only if it does), or leave the point out.",
  "",
  "Copy rules, unchanged and non-negotiable:",
  "- Never say: fascinating, deep dive, delve, explores.",
  "- No vulgar or gratuitously edgy content; register is a well-read friend, not a shock jock.",
  "- Never speak a URL, a citation, or a number a listener cannot hold in their head while driving.",
  "- If a claim is marked contested, the script must say the point is disputed."
];

/**
 * Q-03: the act in one prompt — its seams and clips laid out in play
 * order, the beats under the seam that positions them, every document the
 * act may quote, and on a retry the previous scripts with the verifier's
 * notes. Exported for the prompt tests only — never instantiate the class
 * in a test.
 */
export function buildActWritePrompt(request: ActWriteRequest): string {
  const clips = new Map(request.clips.map((c) => [c.clipId, c]));
  return [
    `You are writing the narration of one act ("${request.actTitle}") of an audio documentary ("Foray") — the whole act at once, as one voice telling one story.`,
    voiceLine(request),
    "",
    "THE ACT, IN PLAY ORDER. Narration and clips alternate. You write the narration; the clips are real tape and play as they are.",
    "A SEAM is one stretch of narration: it carries the beats listed under it, bridges from the clip before to the clip after, and — when it introduces a clip — opens the listener's ear to it.",
    "",
    actLayout(request.seams, clips),
    "",
    "HOW TO WRITE",
    ...ACT_PROSE_RULES,
    "",
    "CLAIMS AND QUOTES",
    ...ACT_CLAIM_RULES,
    "",
    "DOCUMENTS — the only things you may quote:",
    request.documents
      .map(
        (doc) =>
          `--- docId: ${doc.docId} | ${doc.title}${doc.url ? ` | ${doc.url}` : ""}${doc.kind === "tape" ? " | TRANSCRIPT WINDOW of a clip (cite it for statements about that clip)" : doc.kind === "page" ? " | a VERIFIED PAGE of this same Foray, from an earlier act — quote one of its whole sentences" : ""}\n${doc.text}`
      )
      .join("\n\n"),
    "",
    ...(request.retryNote
      ? [
          `REJECTIONS SO FAR: ${request.retryNote}`,
          "Seams marked FROZEN are verified: return each one's script VERBATIM and select no claims for it. Seams marked EDIT carry their previous script and a `fix` line:",
          "EDIT only those, to answer their notes — add a missed beat where it belongs, drop or re-source an unsupported sentence, replace an assertion about the record with what a source says — and keep every sentence that was not objected to.",
          ""
        ]
      : []),
    "Also list any hard-to-pronounce or foreign words with a plain-English pronunciation hint.",
    "",
    JSON_ONLY,
    `{"seams": [{"seamId": string, "script": string, "claims": [${CLAIM_SHAPE}], "usedClaims": [number], "pronunciationHints": [{"word": string, "hint": string}]}]}`
  ].join("\n");
}

function actLayout(seams: SeamBrief[], clips: Map<string, ClipBrief>): string {
  const lines: string[] = [];
  for (const seam of seams) {
    const edges: string[] = [];
    if (seam.follows) edges.push(`follows CLIP ${seam.follows}`);
    if (seam.introduces) edges.push(`introduces CLIP ${seam.introduces} (introduction: ${seam.intro ?? "full"})`);
    lines.push(`SEAM ${seam.seamId} — ${seam.band[0]}-${seam.band[1]} characters${edges.length > 0 ? ` — ${edges.join(", ")}` : ""}${seam.frozen ? " — FROZEN" : seam.previousScript !== undefined ? " — EDIT" : ""}`);
    if (seam.beats.length === 0) lines.push("  carries no beat — the introduction only, or nothing");
    for (const beat of seam.beats) {
      lines.push(`  carries beat ${beat.beatId}${beat.kind === "argument" ? " (an argument — what it means)" : ""}: ${beat.claim}`);
      /* F-99: the seed behind this claim is not in the Foray. Said on the
         beat's own line, in the imperative, because the general rule above
         is not what a writer reads when it is looking at one claim. */
      if (beat.seedLost) {
        lines.push(
          `    SEED LOST — beat ${beat.beatId}'s tape was not available: do not attribute specifics to anyone this claim names; say only what the act's sources say, or hand off.`
        );
      }
    }
    if (seam.frozen && seam.previousScript !== undefined) {
      lines.push(`  FROZEN — verified; return this script verbatim, with no claims: ${JSON.stringify(seam.previousScript)}`);
    } else if (seam.previousScript !== undefined) {
      lines.push(`  previous script: ${JSON.stringify(seam.previousScript)}`);
      if (seam.notes) lines.push(`  fix: ${seam.notes}`);
    }
    if (seam.introduces) {
      const clip = clips.get(seam.introduces);
      if (clip) {
        /* F-99: a clip §4.5 merged two beats into is ONE clip carrying
           both — it plays once, so it is introduced once and the tape
           makes both points itself. Named on the line only when there is
           more than one: a clip carrying its own beat alone is the
           ordinary case and says nothing new. */
        const carried = clip.carries ?? [];
        lines.push(
          `CLIP ${clip.clipId} — "${clip.title}" on ${clip.show || "an unnamed show"}, ${Math.round(clip.durationSec)} s of tape` +
            (clip.docId ? ` (document ${clip.docId})` : " (no transcript window is held)") +
            (carried.length > 1 ? ` — carries beats ${carried.map((b) => b.beatId).join(", ")}` : "")
        );
        if (carried.length > 1) for (const beat of carried) lines.push(`  it carries beat ${beat.beatId}: ${beat.claim}`);
        lines.push(clip.opening ? `  it opens: ${JSON.stringify(clip.opening)}` : "  its opening is not held — introduce it from the show and episode only");
      }
    }
  }
  return lines.join("\n");
}
