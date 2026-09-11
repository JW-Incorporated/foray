import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { parseWithRetry } from "./parseWithRetry";
import { env } from "../config/env";
import { costFor, modelFor } from "../config/models";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import { MIN_QUOTE_WORDS, MODE_CHAR_BANDS } from "../types/narration";
import type {
  ClaimSelectionRequest,
  ClaimSelectionResult,
  NarrationBuildContext,
  NarrationPageBrief,
  NarrationWriterBuilder,
  ProsePageBrief,
  ProseWriteRequest,
  ProseWriteResult,
  SelectAndWriteRequest,
  SelectAndWriteResult
} from "./NarrationWriterBuilder";
import { recordUsage } from "./usageTracking";

/**
 * Real §4.7 narration writing via the Anthropic API, mirroring
 * AnthropicSpineBuilder/AnthropicDeepenActBuilder's structure.
 *
 * TWO CALLS PER SLOT, NOT ONE PER PAGE (WS-A). Run 1 spent 4.2 narration
 * calls per beat because every page was written alone and re-written
 * alone; both calls here take a whole slot's pages at once, and
 * `writeNarration.ts` runs the slots of an act in parallel (WS-D1).
 *
 * ONE CALL PER SLOT IN THE COMMON CASE (G-34). `selectAndWrite` asks for
 * the claims, their quotes and the scripts in one reply. The orchestrator
 * prefers it, runs the same mechanical gate on the quotes afterwards, and
 * comes back to `writePages` only for a page whose quotes did not all
 * resolve — with the claims that did. The prompt is built from the SAME
 * rule lines as the two split prompts (`SELECTION_RULES`, `PROSE_RULES`),
 * so the merged and split paths cannot drift apart in what they ask.
 *
 * WHAT THE PROMPTS NO LONGER SAY is as important as what they do. Run 1's
 * single prompt asked for a verbatim quote, a publication and a contested
 * flag with no text to quote from — so the model reconstructed all three
 * (F-14/F-27/F-30/F-32). `selectClaims` now hands over the DOCUMENTS and
 * asks only which span of which one backs each claim; `writePages` never
 * sees the documents at all and never returns a source, because
 * attribution is read off the held document in code. Every rule that a
 * substring check can decide has moved out of these prompts and into
 * `writeNarration.ts`, which is why they are this short.
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
/* A whole slot's pages come back in one reply now, not one page's, so the
 * ceiling is per-slot rather than per-page. Sized for the largest realistic
 * slot (7 beats, the medium tier's upper bound) with Carry-band scripts.
 * F-47's caveat applies: if a tier moves to a model whose adaptive thinking
 * bills against `max_tokens`, both of these need a thinking allowance on
 * top, exactly like every other builder's. */
const MAX_OUTPUT_TOKENS = 4000;
/* G-34: the combined reply carries a slot's quotes AND its scripts, so its
 * ceiling is the two above added — sized the same way, for the largest
 * realistic slot. Still one request, which is the whole saving. */
const MAX_MERGED_OUTPUT_TOKENS = 6000;

const RawClaimSchema = z.object({
  claimText: z.string(),
  quote: z.string(),
  docId: z.string(),
  contested: z.boolean()
});

const RawSelectionSchema = z.object({
  pages: z.array(
    z.object({
      pageId: z.string(),
      claims: z.array(RawClaimSchema)
    })
  )
});

const RawWrittenPageShape = {
  pageId: z.string(),
  script: z.string(),
  usedClaims: z.array(z.number()),
  /* F-50. Optional in the SCHEMA so a reply that omits it is still
     valid JSON for this stage — an absent flag means "not claimed",
     which is what a page that simply did its purpose should say. */
  purposeRevised: z.boolean().optional(),
  pronunciationHints: z.array(z.object({ word: z.string(), hint: z.string() }))
};

const RawProseSchema = z.object({
  pages: z.array(z.object(RawWrittenPageShape))
});

/* G-34: one page of the combined reply is a selection page and a prose
 * page in one object. Same fields, same optionality. */
const RawSelectAndWriteSchema = z.object({
  pages: z.array(z.object({ ...RawWrittenPageShape, claims: z.array(RawClaimSchema) }))
});

type WriterOperation = "narration_select_claims" | "narration_write" | "narration_select_and_write";

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

  async selectClaims(request: ClaimSelectionRequest, ctx: NarrationBuildContext): Promise<ClaimSelectionResult> {
    return this.askJson(RawSelectionSchema, buildSelectionPrompt(request), "narration_select_claims", ctx, MAX_OUTPUT_TOKENS);
  }

  async writePages(request: ProseWriteRequest, ctx: NarrationBuildContext): Promise<ProseWriteResult> {
    return this.askJson(RawProseSchema, buildProsePrompt(request), "narration_write", ctx, MAX_OUTPUT_TOKENS);
  }

  async selectAndWrite(request: SelectAndWriteRequest, ctx: NarrationBuildContext): Promise<SelectAndWriteResult> {
    return this.askJson(RawSelectAndWriteSchema, buildSelectAndWritePrompt(request), "narration_select_and_write", ctx, MAX_MERGED_OUTPUT_TOKENS);
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

/** The pack as the model sees it: the purpose, who is on tape if anyone,
 * and the documents with their ids — nothing else is quotable. */
function evidenceBlock(page: NarrationPageBrief): string {
  const lines: string[] = [`PAGE ${page.pageId} — mode ${page.mode}`, `Purpose (editorial direction, NOT a source): ${page.purpose}`];
  if (page.contextNote) lines.push(`Context: ${page.contextNote}`);
  if (page.evidence.tape) {
    const t = page.evidence.tape;
    lines.push(`Tape this page sits against: "${t.episodeTitle}" from ${t.showTitle}. That is audio, not a print source.`);
  }
  if (page.evidence.docs.length === 0) {
    lines.push("Documents: none were retrieved for this page.");
  } else {
    for (const doc of page.evidence.docs) {
      lines.push(`--- docId: ${doc.docId} | ${doc.title}${doc.url ? ` | ${doc.url}` : ""}\n${doc.text}`);
    }
  }
  if (page.retryNote) lines.push(`REJECTIONS SO FAR: ${page.retryNote}`);
  return lines.join("\n");
}

/* The rule lines, shared by the split prompts and the merged one (G-34)
 * so the three cannot drift in what they ask of the model. */
const SELECTION_RULES = [
  `A quote must be copied character for character out of the document you name, and must be at least ${MIN_QUOTE_WORDS} words or one whole sentence.`,
  "Never quote the purpose or this prompt: they are direction, not documents.",
  "If a document does not support a claim worth making, select no claim for that page rather than a weak one.",
  "If the documents contradict or complicate the purpose, select the claims that show that: the page's job is then to report the tension, not to assert the purpose.",
  '"contested" means reputable sources actively disagree about the fact itself — not that you are unsure.'
];

const PROSE_RULES = [
  "If the claims contradict or complicate the purpose, write the tension — that page accomplishes its purpose — and set purposeRevised true for it.",
  "List the indices of the claims your script actually asserts. A page that asserts none must be a question or a hand-off to the listener, with no statement about the world in it.",
  "Do not say what the record does or does not contain unless a claim below says it.",
  "",
  "Copy rules, unchanged and non-negotiable:",
  "- Never say: fascinating, deep dive, delve, explores.",
  "- No vulgar or gratuitously edgy content; register is a well-read friend, not a shock jock.",
  "- Never speak a URL, a citation, or a number a listener cannot hold in their head while driving.",
  "- If a claim below is marked contested, the script must say the point is disputed."
];

const JSON_ONLY = "Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:";
const CLAIM_SHAPE = '{"claimText": string, "quote": string, "docId": string, "contested": boolean}';
const WRITTEN_PAGE_FIELDS = '"script": string, "usedClaims": [number], "purposeRevised": boolean, "pronunciationHints": [{"word": string, "hint": string}]';

function voiceLine(request: { voice: ProseWriteRequest["voice"] }): string {
  const voice = request.voice;
  return (
    `Voice (decided once for the whole Foray — do not vary it): style: ${voice.style}; register: ${voice.register}; ` +
    `sentence rhythm: ${voice.sentenceRhythm}; narrator presence: ${voice.narratorPresence}`
  );
}

function buildSelectionPrompt(request: ClaimSelectionRequest): string {
  return [
    `You are selecting the factual claims for the narration pages of one slot ("${request.slotTitle}") of an audio documentary.`,
    "For each page, choose the claims it should make and, for each claim, COPY the span of one document below that backs it.",
    "",
    ...SELECTION_RULES,
    "",
    request.pages.map(evidenceBlock).join("\n\n"),
    "",
    JSON_ONLY,
    `{"pages": [{"pageId": string, "claims": [${CLAIM_SHAPE}]}]}`
  ].join("\n");
}

function buildProsePrompt(request: ProseWriteRequest): string {
  return [
    `You are writing the narration pages of one slot ("${request.slotTitle}") of an audio documentary ("Foray").`,
    voiceLine(request),
    "",
    "Write each page from its listed claims and nothing else. The claims are already sourced; you do not return sources.",
    ...PROSE_RULES,
    "",
    request.pages.map(prosePageBlock).join("\n\n"),
    "",
    "Also list any hard-to-pronounce or foreign words with a plain-English pronunciation hint.",
    "",
    JSON_ONLY,
    `{"pages": [{"pageId": string, ${WRITTEN_PAGE_FIELDS}}]}`
  ].join("\n");
}

/**
 * G-34: the two prompts above in one. The evidence block is the selection
 * prompt's (documents, purpose, rejections); the script rules are the
 * prose prompt's; the band each page must land in is stated per page
 * because the prose prompt states it per page. The model is told, in so
 * many words, that the quotes are checked by machine after it answers —
 * the gate is not weakened by being run once instead of twice.
 */
function buildSelectAndWritePrompt(request: SelectAndWriteRequest): string {
  return [
    `You are writing the narration pages of one slot ("${request.slotTitle}") of an audio documentary ("Foray"), in two steps that you return together.`,
    voiceLine(request),
    "",
    "STEP 1 — for each page, choose the claims it should make and, for each claim, COPY the span of one document below that backs it.",
    ...SELECTION_RULES,
    "Every quote is checked by machine against the document you name after you answer; a quote that is not found there is discarded together with the script that used it.",
    "",
    "STEP 2 — write each page's script from the claims you selected for it and nothing else. You do not return sources; attribution is read off the documents.",
    "Each page's script MUST land inside the character band stated on its PAGE line.",
    ...PROSE_RULES,
    "",
    request.pages.map(selectAndWriteBlock).join("\n\n"),
    "",
    "Also list any hard-to-pronounce or foreign words with a plain-English pronunciation hint.",
    "",
    JSON_ONLY,
    `{"pages": [{"pageId": string, "claims": [${CLAIM_SHAPE}], ${WRITTEN_PAGE_FIELDS}}]}`
  ].join("\n");
}

/** The evidence block with the prose prompt's band line on the PAGE
 * heading, since the same reply writes the script. */
function selectAndWriteBlock(page: NarrationPageBrief): string {
  const [min, max] = MODE_CHAR_BANDS[page.mode];
  const block = evidenceBlock(page);
  return block.replace(/^PAGE [^\n]*/, (heading) => `${heading}, ${min}-${max} characters (the script MUST land inside that band).`);
}

function prosePageBlock(page: ProsePageBrief): string {
  const [min, max] = MODE_CHAR_BANDS[page.mode];
  const lines: string[] = [
    `PAGE ${page.pageId} — mode ${page.mode}, ${min}-${max} characters (the script MUST land inside that band).`,
    `What this page must accomplish: ${page.purpose}`
  ];
  if (page.contextNote) lines.push(`Context: ${page.contextNote}`);
  if (page.evidence.tape) {
    lines.push(`It sits against tape: "${page.evidence.tape.episodeTitle}" from ${page.evidence.tape.showTitle}.`);
  }
  lines.push(
    page.claims.length === 0
      ? "Claims: none. This page may assert nothing — ask a question or hand off to the listener."
      : `Claims:\n${page.claims.map((c, i) => `  [${i}] ${c.claimText}${c.contested ? " (CONTESTED — the script must say so)" : ""}`).join("\n")}`
  );
  if (page.retryNote) lines.push(`REJECTIONS SO FAR: ${page.retryNote}`);
  return lines.join("\n");
}
