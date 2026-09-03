import { vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * Shared fake-client builder for every real Anthropic* provider test
 * (AnthropicEnricher, AnthropicPromptUnderstander, AnthropicSpineBuilder,
 * AnthropicDeepenActBuilder, AnthropicExternalResearcher).
 *
 * Per this repo's "never instantiate for real" rule (see each provider
 * file's own doc comment): the rule's stated purpose is "tests must run
 * with zero network calls regardless of whether ANTHROPIC_API_KEY happens
 * to be set". This fake violates nothing — it is injected via the
 * constructor's optional `client` parameter (added specifically for this
 * card) and never touches the network. It is deliberately a data-shape
 * fake: it returns exactly the `content` array a real `messages.create`
 * response would carry, so the tests exercise how each provider class
 * PARSES that shape (fence-stripping, the no-text-block throw, the
 * zod-failure wrapped error) rather than any live Anthropic behavior.
 *
 * Per this repo's own "green test is not evidence" doctrine (CLAUDE.md,
 * the #269/#244/#271/#216/#276 postmortems): a fake more forgiving than
 * the real thing has burned this repo before. This fake is intentionally
 * narrow — it only knows how to return a fixed `content` array or throw —
 * so it cannot silently paper over a call-site bug the way a "smart" fake
 * that reimplements request validation could.
 */
export function makeFakeAnthropicClient(content: Anthropic.ContentBlock[]): {
  client: Anthropic;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn().mockResolvedValue({ content });
  const client = { messages: { create } } as unknown as Anthropic;
  return { client, create };
}

/** A minimal valid Anthropic text content block. */
export function textBlock(text: string): Anthropic.ContentBlock {
  return { type: "text", text, citations: [] } as unknown as Anthropic.ContentBlock;
}

/** A tool_use-only block, used to exercise the "no text block" throw. */
export function toolUseBlock(): Anthropic.ContentBlock {
  return { type: "tool_use", id: "toolu_1", name: "web_search", input: {} } as unknown as Anthropic.ContentBlock;
}
