import type Anthropic from "@anthropic-ai/sdk";
import { recordUsage } from "./usageTracking";

/**
 * THE ONE WAY A GENERATION STAGE TALKS TO THE MODEL (round-3 audit, gen-10
 * and gen-14).
 *
 * Seven `Anthropic*Builder` classes each carried their own copy of
 * "create, record usage, find the text block", and the copies drifted:
 * five of them never recorded a re-ask's usage (gen-14: pipelineTokens and
 * the report's `calls` undercounted), and only the narration writer ever
 * read `stop_reason` (gen-10: a reply cut off at `max_tokens` was silently
 * "repaired" by parseOrRepairJson into valid JSON, so a half sentence could
 * be spoken as a continuity introduction or an act's exit line).
 *
 * `createMessage` is the single call site: it sends the request, records
 * the reply's usage (every reply, originals and re-asks alike), and refuses
 * a truncated reply BEFORE anything parses it. Budget metering stays with
 * each builder (the estimate is the builder's knowledge), and is still done
 * before every call, re-asks included (parseWithRetry.ts's BUDGET note).
 */
export async function createMessage(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  label: string,
  options: { allowTruncated?: boolean } = {}
): Promise<Anthropic.Message> {
  const response = await client.messages.create(params);
  recordUsage(response.usage);
  /* `allowTruncated` is for the one caller that reads a truncated reply
     WITHOUT repairing it (evidence retrieval keeps only the passages that
     finished; see createWebSearchTurnKeepingTruncation). Nobody else passes it. */
  if (!options.allowTruncated) assertReplyComplete(response.stop_reason, label, params.max_tokens);
  return response;
}

/**
 * A reply that stopped because it hit `max_tokens` is refused, never
 * repaired. `parseOrRepairJson` closes open strings and brackets, so a
 * truncated reply would otherwise parse as a SHORTER valid answer (a cut-off
 * introduction, a cut-off `exit`, an act missing its last seams).
 */
export function assertReplyComplete(stopReason: string | null | undefined, label: string, maxOutputTokens: number): void {
  if (stopReason !== "max_tokens") return;
  throw new TruncatedReplyError(
    `Anthropic ${label} reply was truncated: the model hit max_tokens (${maxOutputTokens}) before finishing its JSON. ` +
      "A truncated reply would parse as a shorter valid answer (parseOrRepairJson closes the brackets), so it is refused here instead."
  );
}

export class TruncatedReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TruncatedReplyError";
  }
}

/** The first text block of a reply (the shape every non-tool builder gets:
 * one text block holding the JSON). */
export function firstTextBlock(response: Pick<Anthropic.Message, "content">): Anthropic.TextBlock | undefined {
  return response.content.find((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text");
}

/**
 * gen-1: the ANSWER of a reply that used the server-side web_search tool.
 *
 * Such a reply is several blocks: usually a preamble text block ("I'll
 * search for..."), then `server_tool_use`, then `web_search_tool_result`,
 * then the final answer, which is itself split over several text blocks
 * when it carries citations. The answer is therefore the text blocks AFTER
 * the last `web_search_tool_result`, joined in order (a cited answer's
 * pieces are consecutive spans of one message, so they join with no
 * separator). A reply that never searched is all answer. Returns "" when
 * the reply has no answer text at all.
 */
export function webSearchAnswerText(content: readonly Anthropic.ContentBlock[]): string {
  let start = 0;
  content.forEach((block, i) => {
    if (block.type === "web_search_tool_result") start = i + 1;
  });
  return content
    .slice(start)
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** How many times a web-search turn is resumed after `pause_turn` before
 * the reply is taken as it stands. */
export const MAX_PAUSE_TURN_CONTINUATIONS = 3;

/**
 * gen-1: a server-tool turn can stop with `stop_reason: "pause_turn"` when
 * the server's own sampling loop hits its iteration limit. The documented
 * way to continue is to re-send the conversation with the paused assistant
 * content appended (no extra user turn) and the same tools; the server
 * resumes where it left off. Each continuation is a real, metered call:
 * `meter` runs before every continuation (the caller's budget check), and
 * createMessage records its usage. Returns the whole turn's content, the
 * original blocks followed by every continuation's.
 */
export async function createWebSearchTurn(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  label: string,
  meter: () => Promise<unknown>
): Promise<Anthropic.ContentBlock[]> {
  return (await runWebSearchTurn(client, params, label, meter, false)).content;
}

/**
 * The same turn, but a reply that hit `max_tokens` is RETURNED, flagged
 * `truncated`, instead of refused. For evidence retrieval only (round-3
 * review, L5): a truncated retrieval refused as a failure was retried on every
 * later ask with the same prompt and the same ceiling, paying for the web
 * search again and usually truncating again. The caller must not repair the
 * text: it keeps only the passages that finished (see
 * AnthropicExternalResearcher.salvageCompletePassages).
 */
export async function createWebSearchTurnKeepingTruncation(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  label: string,
  meter: () => Promise<unknown>
): Promise<{ content: Anthropic.ContentBlock[]; truncated: boolean }> {
  return runWebSearchTurn(client, params, label, meter, true);
}

async function runWebSearchTurn(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  label: string,
  meter: () => Promise<unknown>,
  allowTruncated: boolean
): Promise<{ content: Anthropic.ContentBlock[]; truncated: boolean }> {
  let response = await createMessage(client, params, label, { allowTruncated });
  const content: Anthropic.ContentBlock[] = [...response.content];
  let continuations = 0;
  while (response.stop_reason === "pause_turn" && continuations < MAX_PAUSE_TURN_CONTINUATIONS) {
    continuations += 1;
    await meter();
    response = await createMessage(
      client,
      { ...params, messages: [...params.messages, { role: "assistant", content: content as Anthropic.ContentBlockParam[] }] },
      label,
      { allowTruncated }
    );
    content.push(...response.content);
  }
  return { content, truncated: response.stop_reason === "max_tokens" };
}
