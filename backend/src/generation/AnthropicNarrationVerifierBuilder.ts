import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { parseWithRetry } from "./parseWithRetry";
import { env } from "../config/env";
import { costFor, modelFor } from "../config/models";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import type {
  NarrationBuildContext,
  NarrationVerifierBuilder,
  NarrationVerifyRequest,
  NarrationVerifyResult,
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
    const promptText = buildVerifyPrompt(request);
    const estimatedInputTokens = roughTokenEstimate(promptText);
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "narration_verify",
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
      recordUsage(retryResponse.usage);
      const retryTextBlock = retryResponse.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
      if (!retryTextBlock) throw new Error("Anthropic narration-verify re-ask response had no text block");
      return retryTextBlock.text;
    };

    return parseWithRetry(RawVerifyResultSchema, textBlock.text, "LLM output", reask);
  }
}

function buildVerifyPrompt(request: NarrationVerifyRequest): string {
  return [
    'You are the FACT-VERIFICATION pass for the narration pages of one slot of an audio documentary ("Foray").',
    "You did NOT write these pages. For each page below, answer three questions independently.",
    "",
    "1. claimsSupported — does every statement the script makes about the world follow from the quote attached to it?",
    "   A quote that is about the right subject but does not say what the claim says is NOT support.",
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
  const sources = page.sources
    .map((s, i) => `  Source ${i + 1}: claim="${s.claimText}" quote="${s.quote}" publication="${s.publication}"${s.contested ? " [marked contested]" : ""}`)
    .join("\n");
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
