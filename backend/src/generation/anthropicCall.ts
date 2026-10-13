import type Anthropic from "@anthropic-ai/sdk";
import { TruncatedReplyError } from "./replyErrors";
import { countAnthropicCall, recordUsage } from "./usageTracking";
import { currentRunLog, recordModelCall, withCallContext } from "./runLog";

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
  const startMs = currentRunLog()?.nowMs() ?? 0;
  /* GV-68: counted before the request goes out, so a failed request still
     counts against the zero-Anthropic rule (report.json anthropicCalls). */
  countAnthropicCall();
  let response: Anthropic.Message;
  try {
    response = await client.messages.create(params);
  } catch (err) {
    recordAnthropicCall(params, label, startMs, undefined, err);
    throw err;
  }
  recordUsage(response.usage);
  /* Recorded BEFORE the truncation check below, so a refused max_tokens
     reply still leaves its CallRecord (stopReason 'max_tokens'). */
  recordAnthropicCall(params, label, startMs, response);
  /* `allowTruncated` is for the one caller that reads a truncated reply
     WITHOUT repairing it (evidence retrieval keeps only the passages that
     finished; see createWebSearchTurnKeepingTruncation). Nobody else passes it. */
  if (!options.allowTruncated) assertReplyComplete(response.stop_reason, label, params.max_tokens);
  return response;
}

/**
 * GV-07 (docs/roadmap/generation-v2.md): one CallRecord per request in the
 * active RunLog, success or failure; a no-op when no log is open. Times are
 * on the log's own clock, which a test injects (`new RunLog({ now })`).
 *
 * This path is NON-STREAMING, so it cannot know how long the request queued
 * or when its first token arrived: queueMs, ttftMs and decodeTokPerSec stay
 * null (an absent measurement must not read as a fast one). The provider
 * layer's streamed calls fill them.
 *
 * `machine` is 'relay' when ANTHROPIC_BASE_URL points the SDK elsewhere
 * (the test-drive relay), else 'anthropic-api'. A thrown transport error is
 * recorded with its `name` (and HTTP status when the SDK gives one) and then
 * rethrown unchanged by the caller.
 */
function recordAnthropicCall(
  params: Anthropic.MessageCreateParamsNonStreaming,
  label: string,
  startMs: number,
  response: Anthropic.Message | undefined,
  err?: unknown
): void {
  const log = currentRunLog();
  if (!log) return;
  const usage = response?.usage as (Partial<Anthropic.Usage> & { cache_read_input_tokens?: number | null }) | undefined;
  const count = (n: unknown): number | null => (typeof n === "number" ? n : null);
  const status = (err as { status?: unknown } | undefined)?.status;
  recordModelCall({
    provider: "anthropic",
    machine: process.env.ANTHROPIC_BASE_URL ? "relay" : "anthropic-api",
    model: params.model,
    label,
    startMs,
    endMs: log.nowMs(),
    promptTokens: count(usage?.input_tokens),
    cachedTokens: count(usage?.cache_read_input_tokens),
    outputTokens: count(usage?.output_tokens),
    stopReason: response?.stop_reason ?? null,
    maxTokens: params.max_tokens,
    ...(err !== undefined
      ? { error: { kind: err instanceof Error ? err.name : typeof err, ...(typeof status === "number" ? { status } : {}) } }
      : {})
  });
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

/* GV-19: the class lives in replyErrors.ts, shared with chat/askStructured.ts,
   so one `instanceof` matches a truncation refusal from either path. Re-exported
   here so existing importers keep their import. */
export { TruncatedReplyError };

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
    /* GV-07: a pause_turn continuation is its own request, recorded as one. */
    response = await withCallContext({ reask: "continuation" }, async () => {
      await meter();
      return createMessage(
        client,
        { ...params, messages: [...params.messages, { role: "assistant", content: content as Anthropic.ContentBlockParam[] }] },
        label,
        { allowTruncated }
      );
    });
    content.push(...response.content);
  }
  return { content, truncated: response.stop_reason === "max_tokens" };
}
