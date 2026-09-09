import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { parseWithRetry as parseWithRetryShared } from "./parseWithRetry";
import { env } from "../config/env";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import type {
  NarrationBuildContext,
  NarrationVerifierBuilder,
  NarrationVerifyRequest,
  NarrationVerifyResult,
  VerifyPageBrief
} from "./NarrationVerifierBuilder";

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

const MODEL = "claude-sonnet-4-5";
const USD_PER_INPUT_TOKEN = 3.0 / 1_000_000;
const USD_PER_OUTPUT_TOKEN = 15.0 / 1_000_000;
const MAX_OUTPUT_TOKENS = 2000;

const RawVerifyResultSchema = z.object({
  pages: z.array(
    z.object({
      pageId: z.string(),
      claimsSupported: z.boolean(),
      purposeAccomplished: z.boolean(),
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

    const textBlock = response.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
    if (!textBlock) throw new Error("Anthropic narration-verify response had no text block");

    return parseWithRetry(RawVerifyResultSchema, textBlock.text);
  }
}

function buildVerifyPrompt(request: NarrationVerifyRequest): string {
  return [
    'You are the FACT-VERIFICATION pass for the narration pages of one slot of an audio documentary ("Foray").',
    "You did NOT write these pages. For each page below, answer three questions independently.",
    "",
    "1. claimsSupported — does every statement the script makes about the world follow from the quote attached to it?",
    "   A quote that is about the right subject but does not say what the claim says is NOT support.",
    "2. purposeAccomplished — does the script do the job its purpose describes? A page that is accurate but",
    "   re-tells what earlier pages covered, or that drops the concept its purpose names, fails this.",
    "3. contestedHandled — read the sources: if reputable sources actively disagree about something the script",
    "   asserts, the script must say the point is disputed, in any natural wording. If nothing is genuinely",
    "   contested, this is true. Judge the substance, not the presence of any particular phrase.",
    "",
    "Do NOT check whether a quote exists in its source — that was already proven mechanically before you were called.",
    "",
    request.pages.map(verifyPageBlock).join("\n\n"),
    "",
    "Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:",
    '{"pages": [{"pageId": string, "claimsSupported": boolean, "purposeAccomplished": boolean, "contestedHandled": boolean, ' +
      '"notes": string (required and specific whenever any answer is false)}]}'
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

function parseWithRetry<T>(schema: z.ZodType<T>, raw: string): T {
  return parseWithRetryShared(schema, raw, "LLM output");
}
