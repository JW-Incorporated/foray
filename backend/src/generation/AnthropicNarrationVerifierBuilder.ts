import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { parseWithRetry } from "./parseWithRetry";
import { env } from "../config/env";
import { costFor, modelFor } from "../config/models";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import { isTapeSource, tapeDocIdFor, type Source } from "../types/narration";
import type {
  ActVerifyRequest,
  ActVerifyResult,
  NarrationBuildContext,
  NarrationVerifierBuilder,
  NarrationVerifyRequest,
  NarrationVerifyResult,
  SynthesisVerifyRequest,
  SynthesisVerifyResult,
  VerifiedPageSummary,
  VerifyClipBrief,
  VerifyPageBrief
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
 * THREE QUESTIONS, NOT ONE (WS-A). Run 1's prompt said "read it against
 * ONLY its declared sources", which made this a consistency check on the
 * writer's own declarations: it passed a page citing Chernobyl interviews
 * for a Kansas City claim in five seconds (F-27), never asked whether a
 * page did the job its beat existed for (F-41), and decided the
 * zero-source case by sampling (F-44). It is now given the purpose and
 * the evidence pack, and returns a separate boolean for each of: are the
 * claims supported, is the purpose accomplished, is a genuinely contested
 * point handled (F-43 — the keyword detector no longer decides this).
 *
 * It is NOT asked whether a quote exists. `writeNarration.ts` proves that
 * in code, against the held documents, before this is ever called.
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
/* A verdict per page for a whole slot, not one page's verdict — see the
 * writer's note on this same number, and F-47's caveat about a thinking
 * allowance if a tier moves to a model that bills it against max_tokens. */
const MAX_OUTPUT_TOKENS = 2000;

const RawVerifyResultSchema = z.object({
  pages: z.array(
    z.object({
      pageId: z.string(),
      claimsSupported: z.boolean(),
      purposeAccomplished: z.boolean(),
      /* F-50, and optional for the same reason as the writer's flag: a
         reply that does not answer it has not said "no". */
      purposeRevised: z.boolean().optional(),
      contestedHandled: z.boolean(),
      notes: z.string().optional()
    })
  )
});

/* F-88: the synthesis verdict — the ids the page rests on, or a refusal. */
const RawSynthesisResultSchema = z.object({
  pages: z.array(
    z.object({
      pageId: z.string(),
      synthesis: z.boolean(),
      /* Optional in the reply — a refusal may leave it out — and read as
         empty: a page that rests on nothing is refused in code either way. */
      restsOn: z.array(z.string()).optional(),
      notes: z.string().optional()
    })
  )
});

/* Q-03: one verdict per beat and one per seam of a whole act. */
const RawActVerifySchema = z.object({
  beats: z.array(z.object({ beatId: z.string(), carried: z.boolean(), notes: z.string().optional() })),
  seams: z.array(z.object({ seamId: z.string(), claimsSupported: z.boolean(), contestedHandled: z.boolean(), notes: z.string().optional() }))
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

  async verifySlot(request: NarrationVerifyRequest, ctx: NarrationBuildContext): Promise<NarrationVerifyResult> {
    return this.ask(buildVerifyPrompt(request), RawVerifyResultSchema, ctx);
  }

  /** F-88: the synthesis question — the SAME call family (model, budget
   * operation, re-ask) as `verifySlot`, with its own short prompt. Only
   * `synthesisVerify.ts` calls it, and only after retrieval has failed. */
  async verifySynthesis(request: SynthesisVerifyRequest, ctx: NarrationBuildContext): Promise<SynthesisVerifyResult> {
    const raw = await this.ask(buildSynthesisPrompt(request), RawSynthesisResultSchema, ctx);
    return { pages: raw.pages.map((p) => ({ ...p, restsOn: p.restsOn ?? [] })) };
  }

  /** Q-03: the per-beat question for a whole act. See `buildActVerifyPrompt`. */
  async verifyAct(request: ActVerifyRequest, ctx: NarrationBuildContext): Promise<ActVerifyResult> {
    return this.ask(buildActVerifyPrompt(request), RawActVerifySchema, ctx, MAX_ACT_VERIFY_OUTPUT_TOKENS);
  }

  private async ask<T>(promptText: string, schema: z.ZodType<T>, ctx: NarrationBuildContext, maxOutputTokens: number = MAX_OUTPUT_TOKENS): Promise<T> {
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
 * F-88: the synthesis prompt. Deliberately short, and asked only of a
 * Hinge or Frame whose retrieval returned nothing (`synthesisVerify.ts`
 * decides that; this prompt never sees a Patch or Carry). Exported for
 * the prompt tests only — never instantiate the class in a test.
 */
export function buildSynthesisPrompt(request: SynthesisVerifyRequest): string {
  return [
    'You are the FACT-VERIFICATION pass for the narration pages of an audio documentary ("Foray"), judging SYNTHESIS pages.',
    "A synthesis page is a short Hinge or Frame that generalises across what this Foray's OTHER, already-verified pages establish.",
    "Nothing in print was found for it, so its only permitted ground is those pages. You did NOT write it.",
    "",
    "For each page to judge, decide whether its script is a fair generalisation of the verified pages listed — and ONLY them:",
    "  - every concrete case, entity, number or claim the script names must be established by at least one verified page below;",
    "  - the script must introduce no factual claim of its own beyond what those pages say;",
    "  - a case the script names that no verified page covers is a REFUSAL, not a near miss.",
    "Answer with the ids of the verified pages the script rests on (restsOn, every page whose sentences it quotes included), or refuse",
    "(synthesis: false, restsOn: []) and say in notes which case or claim no verified page covers.",
    "",
    "VERIFIED PAGES (the only ground a synthesis may rest on):",
    request.verifiedPages.map(verifiedPageLine).join("\n"),
    "",
    "PAGES TO JUDGE:",
    request.pages.map(synthesisPageBlock).join("\n\n"),
    "",
    "Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:",
    '{"pages": [{"pageId": string, "synthesis": boolean, "restsOn": string[], "notes": string (required and specific whenever synthesis is false)}]}'
  ].join("\n");
}

function verifiedPageLine(page: VerifiedPageSummary): string {
  const established = page.established.length > 0 ? `\n    established: ${page.established.map((e) => `"${e}"`).join("; ")}` : "";
  return `  [${page.pageId}] (${page.mode}) purpose: ${page.claim}\n    script: ${page.script}${established}`;
}

function synthesisPageBlock(page: VerifyPageBrief): string {
  const sources = page.sources.map((s, i) => `  Source ${i + 1}: claim="${s.claimText}" quoted from page ${s.publication}`).join("\n");
  return [`PAGE ${page.pageId} — mode ${page.mode}`, `Purpose: ${page.purpose}`, `Script:\n${page.script}`, `Sources:\n${sources || "  (none declared)"}`].join("\n");
}

/**
 * Q-03: the per-act verification prompt. The beats are the CHECKLIST;
 * the act's seams and clips are laid out in play order with every
 * seam's sources and every clip's transcript window; the answer is one
 * verdict per beat (carried, or a note naming what is missing and where
 * it belongs) and one per seam (the two page questions that survive —
 * support and contested; purpose is now the per-beat question).
 * Introductions are exempt from the support question: who is speaking,
 * the show and the episode are checked structurally against the segment
 * source row before this is called (Q-02). Exported for the prompt
 * tests only.
 */
export function buildActVerifyPrompt(request: ActVerifyRequest): string {
  const clips = new Map(request.clips.map((c) => [c.clipId, c]));
  return [
    `You are the FACT-VERIFICATION pass for the narration of one act ("${request.actTitle}") of an audio documentary ("Foray"). You did NOT write it.`,
    "",
    "THE CHECKLIST — every beat the act's narration must carry:",
    ...request.beats.map((b) => `  ${b.beatId}: ${b.claim}`),
    "",
    "THE ACT, IN PLAY ORDER — narration seams and the clips of real tape between them:",
    actVerifyLayout(request, clips),
    "",
    "Answer two sets of questions.",
    "1. For each BEAT on the checklist: carried — does the act's narration (any seam, not only the one the beat was positioned in) or one of its clips",
    "   make the beat's point, supported by the sources attached to that seam or by what is said in the clip's window? A beat is carried when a",
    "   listener would hear its point made, in whatever words. It is NOT carried when no seam makes the point, or a seam makes it with no support.",
    "   When a beat is not carried, say in notes which seam it belongs in and what is missing, in one sentence a writer can act on.",
    "2. For each SEAM: claimsSupported — does every statement the script makes about the world follow from the source attached to it?",
    "   A source marked [TAPE] has no quote to check against: judge every statement about that clip against the clip's transcript window",
    "   printed on its CLIP line, and only that window. A restatement of a clip with no tape source is unsupported.",
    "   EXEMPT from this question: the sentences that introduce a clip — who is speaking, the show, the episode — which are checked by",
    "   structure against the segment's source row before you are called. Do not fail a seam for them.",
    "   contestedHandled — read the sources: if reputable sources actively disagree about something the script asserts, the script must",
    "   say the point is disputed, in any natural wording. If nothing is genuinely contested, this is true.",
    "",
    "Do NOT check whether a quote exists in its source — that was already proven mechanically before you were called.",
    "",
    "DOCUMENTS the seams' sources quote:",
    request.documents.filter((d) => d.kind !== "tape").map((d) => `  --- ${d.title}${d.url ? ` | ${d.url}` : ""}\n${d.text}`).join("\n") || "  (none — every source is a clip's window)",
    "",
    "Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:",
    '{"beats": [{"beatId": string, "carried": boolean, "notes": string (required and specific whenever carried is false)}], ' +
      '"seams": [{"seamId": string, "claimsSupported": boolean, "contestedHandled": boolean, "notes": string (required whenever an answer is false)}]}'
  ].join("\n");
}

function actVerifyLayout(request: ActVerifyRequest, clips: Map<string, VerifyClipBrief>): string {
  const lines: string[] = [];
  for (const seam of request.seams) {
    const edges: string[] = [];
    if (seam.follows) edges.push(`follows CLIP ${seam.follows}`);
    if (seam.introduces) edges.push(`introduces CLIP ${seam.introduces} (introduction: ${seam.intro ?? "full"})`);
    lines.push(`SEAM ${seam.seamId} — mode ${seam.mode}${seam.carries.length > 0 ? `, positioned beats ${seam.carries.join(", ")}` : ", no beat positioned here"}${edges.length > 0 ? ` — ${edges.join(", ")}` : ""}`);
    lines.push(`  Script:\n${seam.script}`);
    lines.push(`  Sources:\n${seam.sources.map((s, i) => actSourceLine(s, i)).join("\n") || "    (none declared)"}`);
    if (seam.introduces) {
      const clip = clips.get(seam.introduces);
      if (clip) {
        lines.push(`CLIP ${clip.clipId} — "${clip.title}" on ${clip.show || "an unnamed show"}, ${Math.round(clip.durationSec)} s of tape${clip.docId ? ` (${clip.docId})` : ""}`);
        lines.push(`  Transcript window:\n${clip.windowText || "    (the window is not held — treat any statement about this clip as unsupported)"}`);
      }
    }
  }
  return lines.join("\n");
}

function actSourceLine(s: Source, i: number): string {
  const contested = s.contested ? " [marked contested]" : "";
  if (!isTapeSource(s)) return `    Source ${i + 1}: claim="${s.claimText}" quote="${s.quote}" publication="${s.publication}"${contested}`;
  return `    Source ${i + 1} [TAPE ${s.segmentId}]: claim="${s.claimText}"${s.quote ? ` echoes="${s.quote}"` : ""} publication="${s.publication}"${contested} — judge against that clip's window`;
}

/** Exported for the prompt tests only — never instantiate the class in a
 * test (see the module comment). */
export function buildVerifyPrompt(request: NarrationVerifyRequest): string {
  return [
    'You are the FACT-VERIFICATION pass for the narration pages of one slot of an audio documentary ("Foray").',
    "You did NOT write these pages. For each page below, answer three questions independently.",
    "",
    "1. claimsSupported — does every statement the script makes about the world follow from the quote attached to it?",
    "   A quote that is about the right subject but does not say what the claim says is NOT support.",
    "   A source marked [TAPE] has no quote to check against: its holding document is the transcript window of the",
    "   segment it names — the one that plays just before this page or just after it — printed under it. Every statement",
    "   the script makes about that tape — what it is about, who is speaking, what they say — must be borne out by what",
    "   is said in THAT window. A page between two segments may hold both windows; judge each tape source against the",
    "   window it names, not the other one, and a restatement of the tape with no tape source is unsupported.",
    "2. purposeAccomplished — does the script address the SUBJECT its purpose names, using the evidence it was given?",
    "   Contradicting or qualifying the purpose from the documents ACCOMPLISHES it — a purpose is editorial direction and can",
    "   be wrong. Only a page that ignores the subject, or re-tells what earlier pages covered, fails this.",
    "   purposeRevised — true when the page departs from its purpose because the evidence did. Your own judgement, not the writer's.",
    "3. contestedHandled — read the sources: if reputable sources actively disagree about something the script",
    "   asserts, the script must say the point is disputed, in any natural wording. If nothing is genuinely",
    "   contested, this is true. Judge the substance, not the presence of any particular phrase.",
    "",
    "Do NOT check whether a quote exists in its source — that was already proven mechanically before you were called.",
    "",
    request.pages.map(verifyPageBlock).join("\n\n"),
    "",
    "Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:",
    '{"pages": [{"pageId": string, "claimsSupported": boolean, "purposeAccomplished": boolean, "purposeRevised": boolean, ' +
      '"contestedHandled": boolean, "notes": string (required and specific whenever any answer is false)}]}'
  ].join("\n");
}

function verifyPageBlock(page: VerifyPageBrief): string {
  const sources = page.sources.map((s, i) => sourceLine(s, i, page)).join("\n");
  const docs = page.evidence.docs
    .map((d) => `  --- ${d.title}${d.url ? ` | ${d.url}` : ""}\n${d.text}`)
    .join("\n");
  const lines = [
    `PAGE ${page.pageId} — mode ${page.mode}`,
    `Purpose: ${page.purpose}`,
    `Script:\n${page.script}`,
    `Sources:\n${sources || "  (none declared)"}`
  ];
  if (docs) lines.push(`Documents the page was written from:\n${docs}`);
  return lines.join("\n");
}

/** One declared source as the verifier reads it. A TAPE source (F-81) is
 * handed the segment's transcript window as its holding document, in
 * full, right under the claim — the verifier judges the page's statements
 * about the tape against everything said in it, not against a quote. */
function sourceLine(s: Source, i: number, page: VerifyPageBrief): string {
  const contested = s.contested ? " [marked contested]" : "";
  if (!isTapeSource(s)) {
    return `  Source ${i + 1}: claim="${s.claimText}" quote="${s.quote}" publication="${s.publication}"${contested}`;
  }
  const window = page.evidence.docs.find((d) => d.docId === tapeDocIdFor(s.segmentId));
  /* F-82: which side of the page the named segment plays on, so a page
     holding two windows is judged against the one the source names. */
  const where =
    window?.tapePosition === "previous"
      ? "the segment that plays just BEFORE this page"
      : window?.tapePosition === "next"
        ? "the segment that plays just AFTER this page (the one it introduces)"
        : "the segment this page introduces";
  return [
    `  Source ${i + 1} [TAPE — ${where}, ${s.segmentId}]: claim="${s.claimText}"${s.quote ? ` echoes="${s.quote}"` : ""} publication="${s.publication}"${contested}`,
    "    Holding document for this source: the segment's transcript window below. Judge the claim against everything said in it, and not against any other window this page holds.",
    `    Transcript window:\n${window ? window.text : "    (the window is not held — treat the claim as unsupported)"}`
  ].join("\n");
}
