import { defaultBudgetGuard } from "../../cost/budgetGuard";
import type { CostEventInput } from "../../cost/costEvents";
import { actOutputTokenBudget } from "../AnthropicNarrationWriterBuilder";
import type {
  ActWriteRequest,
  ActWriteResult,
  NarrationBuildContext,
  NarrationWriterBuilder,
  SeamEditRequest,
  WriterStreamEvent,
  WrittenSeam
} from "../NarrationWriterBuilder";
import { toChatMessages } from "../promptLayout";
import { actWritePromptParts, seamEditPromptParts } from "../prompts/actWrite";
import { RawActWriteSchema, toActWriteResult } from "../replySchemas";
import { JsonlSeamParser, type SeamLineEvent } from "../seamStream";
import { recordUsage } from "../usageTracking";
import { ChatProviderError, type ChatMessage, type ChatProvider, type ChatRequest, type ChatStreamEvent, type ChatUsage } from "./ChatProvider";
import { askStructured, type StructuredBudgetGuard, type StructuredTarget } from "./askStructured";

/**
 * GV-31 (docs/roadmap/generation-v2.md, from W2-07; covers R2-21, GP-06,
 * HW-12, R1-18): §4.7 act writing on a ChatProvider, the twin of
 * AnthropicNarrationWriterBuilder: the same prompt (prompts/actWrite.ts, the
 * whole act in one call; GV-50 sends it as toChatMessages(actWritePromptParts),
 * [system: the rules, the reply contract and the voice slot; user: the voice
 * line + this act], so the system message is the prefix every act, round and
 * Foray shares, where the Anthropic writer sends the same parts joined), the
 * same schema (RawActWriteSchema, sent as the
 * 'act_write' json_schema), the same per-act budget (actOutputTokenBudget,
 * sized from the act's seam bands, floor 12000) and the same post-parse
 * mapping (toActWriteResult). writeAct.ts's quote checks, verifier rounds and
 * gates run on the result exactly as they do on the Anthropic one.
 *
 * NON-STREAMING `writeAct`: one reply per act. This is the correctness
 * baseline and the fallback for the streamed writer (R1-06); a whole act at
 * about 22 tok/s does not meet the 30 s first-audio target on its own. It is
 * unchanged by GV-84: with FORAY_WRITER_STREAM off, the local writer sends
 * exactly what it sent before.
 *
 * GV-84 (W4-19; covers R1-06, R2-08, GP-05, GP-02) adds the two calls the
 * fast path needs, both DARK:
 *
 *   - `writeActStream`: THE SAME ACT, ONE STREAMED CALL. The act prompt with
 *     the 'jsonl' output contract (one seam object per line, in listening
 *     order), read through the provider's `stream` and JsonlSeamParser
 *     (seamStream.ts, GV-43), so each seam is handed on the moment its line
 *     closes. Present only when the provider can stream; writeAct.ts uses it
 *     only under FORAY_WRITER_STREAM (or the fast-path umbrella, GV-73).
 *     maxTokens is `streamedActMaxTokens`: no 12000 floor, because a cut
 *     keeps the finished seams (W4-10). The request carries NO
 *     response_format: the OpenAI wire shape has no JSONL constraint (a
 *     json_schema would hold the reply to ONE object), so the contract is
 *     the prompt's and every line is validated on its own by the parser
 *     (the card's fallback for a lane that cannot constrain JSONL).
 *   - `editSeams`: THE SEAM EDIT of the timed round policy (GV-80). One
 *     non-streamed call whose system message is byte-identical to the
 *     streamed act's (seamEditPromptParts shares its `stable`), so the
 *     9-11k-token rules are a prefix-cache hit, and whose user message holds
 *     only the failing seams, their read-only neighbours, the clips they
 *     touch and the documents they cite. The reply is JSONL, one line per
 *     requested seam, parsed by the same parser; maxTokens is
 *     `seamEditMaxTokens`.
 *
 * Priority is not set on either request: the lane scheduler (GV-93) derives
 * it from the run context. The verifier stays a separate instance; the
 * 'distinct instances' rule in writeNarration.ts is unchanged.
 *
 * Decision 9: this is the only Qwen writer class; the local writer's features
 * (W4-19) land here rather than in a second class.
 *
 * DARK: constructed only by the stage factories (GV-37) when the writer
 * routes to 'local' (FORAY_STAGE_WRITER=local:spark). The provider comes in
 * through the constructor, so a test drives it with a scripted provider. No
 * Anthropic call; the Anthropic module is imported for its budget function
 * only (decision 8).
 */

/** GV-84: output tokens per character of the act's seam bands, streamed. */
export const STREAMED_ACT_TOKENS_PER_CHAR = 0.5;
/** GV-84: the smallest cap a streamed act is sent with. */
export const STREAMED_ACT_MIN_TOKENS = 1200;
/** GV-84: the largest cap a streamed act is sent with. */
export const STREAMED_ACT_MAX_TOKENS = 32000;
/** GV-84: what a seam edit adds over its seams' bands (the line framing). */
export const SEAM_EDIT_TOKEN_HEADROOM = 200;

/**
 * GV-84: the streamed act's output cap,
 * min(32000, max(1200, ceil(sum of seam band maxima x 0.5))). There is no
 * 12000 floor (actOutputTokenBudget's): a stream cut at the cap keeps every
 * seam that finished and writeAct.ts re-asks only the rest (W4-10).
 */
export function streamedActMaxTokens(request: Pick<ActWriteRequest, "seams">): number {
  const chars = request.seams.reduce((sum, seam) => sum + (seam.band[1] ?? 0), 0);
  return Math.min(STREAMED_ACT_MAX_TOKENS, Math.max(STREAMED_ACT_MIN_TOKENS, Math.ceil(chars * STREAMED_ACT_TOKENS_PER_CHAR)));
}

/** GV-84: the seam edit's output cap, ceil(sum of the edited seams' band
 * maxima x 0.5) + 200. */
export function seamEditMaxTokens(request: Pick<SeamEditRequest, "seams">): number {
  const chars = request.seams.reduce((sum, seam) => sum + (seam.band[1] ?? 0), 0);
  return Math.ceil(chars * STREAMED_ACT_TOKENS_PER_CHAR) + SEAM_EDIT_TOKEN_HEADROOM;
}

/**
 * GV-84: the longest the streamed reply may go without a single delta
 * before the builder aborts the request (prefill before the first delta
 * included). The provider's own `timeoutMs` bounds the WHOLE stream
 * (chat/openAICompatProvider.ts), and writeAct.ts's streamIdleTimeoutMs
 * bounds the gap between SEAMS but cannot cancel a read the provider is
 * blocked in; this bound is between CHUNKS and cancels the HTTP request, so
 * a stalled Spark lane is freed.
 *
 * A BACKSTOP, strictly longer than writeAct.ts's DEFAULT_WRITER_STREAM_IDLE_MS
 * (120 s): under writeAct the stall is writeAct's to call. Its graceful
 * 'stalled' cut keeps the finished seams and re-asks the rest, and its
 * iterator.return() aborts the request at once (`abortable`). With equal
 * bounds this timer, registered first when writeAct resumes the stream,
 * fired first, and its 'stream_idle' throw failed the narration instead of
 * cutting the act. This bound only decides for a consumer with no bound of
 * its own.
 */
export const DEFAULT_STREAM_CHUNK_IDLE_MS = 150_000;

export interface ChatWriterStreamOptions {
  /** Epoch-ms clock each seam's `atMs` is measured on (default Date.now). */
  now?: () => number;
  /** Between-chunk idle bound (default DEFAULT_STREAM_CHUNK_IDLE_MS). */
  chunkIdleTimeoutMs?: number;
}

/** The operation (cost event) and label (CallRecord) of each call. */
const WRITE_ACT_OPERATION = "narration_write_act";
const EDIT_SEAMS_OPERATION = "narration_edit_seams";

const IDLE = Symbol("idle");

export class ChatNarrationWriterBuilder implements NarrationWriterBuilder {
  /** `local:<lane>` (targetFor). */
  readonly providerName: string;
  /**
   * GV-84: the streamed act. An own property, present only when the
   * provider has `stream`, so writeAct.ts's and runPipeline.ts's
   * `typeof writer.writeActStream === "function"` reads what this writer
   * can actually do.
   */
  readonly writeActStream?: (request: ActWriteRequest, ctx: NarrationBuildContext) => AsyncIterable<WriterStreamEvent>;

  private readonly now: () => number;
  private readonly chunkIdleMs: number;

  constructor(
    private readonly provider: ChatProvider,
    private readonly target: StructuredTarget,
    private readonly budgetGuard: StructuredBudgetGuard = defaultBudgetGuard,
    streamOptions: ChatWriterStreamOptions = {}
  ) {
    this.providerName = target.providerName;
    this.now = streamOptions.now ?? (() => Date.now());
    const idle = streamOptions.chunkIdleTimeoutMs ?? DEFAULT_STREAM_CHUNK_IDLE_MS;
    if (!(Number.isFinite(idle) && idle > 0)) throw new Error("ChatNarrationWriterBuilder: chunkIdleTimeoutMs must be a positive number");
    this.chunkIdleMs = idle;
    if (typeof provider.stream === "function") {
      this.writeActStream = (request, ctx) => this.abortable(request, ctx);
    }
  }

  async writeAct(request: ActWriteRequest, ctx: NarrationBuildContext): Promise<ActWriteResult> {
    const { value } = await askStructured({
      provider: this.provider,
      target: this.target,
      schemaName: "act_write",
      schema: RawActWriteSchema,
      messages: toChatMessages(actWritePromptParts(request)),
      maxTokens: actOutputTokenBudget(request),
      operation: "narration_write_act",
      budget: { guard: this.budgetGuard, userId: ctx.userId, ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}) },
      label: "narration_write_act"
    });
    return toActWriteResult(value);
  }

  /**
   * GV-80/GV-84: the seam edit (see the class comment). A reply cut at its
   * cap keeps the seams that finished (TRUNCATION_POLICY 'narrate.act':
   * keep-finished-seams); a missing or bad line costs that seam only, and
   * writeAct.ts refuses a requested seam that did not come back, as on any
   * round. No re-ask: the round policy's next round is the retry.
   */
  async editSeams(request: SeamEditRequest, ctx: NarrationBuildContext): Promise<ActWriteResult> {
    const messages = toChatMessages(seamEditPromptParts(request, { output: "jsonl" }));
    const maxTokens = seamEditMaxTokens(request);
    await this.budgetGuard.checkAndRecord(this.costEvent(EDIT_SEAMS_OPERATION, messages, maxTokens, ctx));
    const response = await this.provider.complete(this.chatRequest(messages, maxTokens, EDIT_SEAMS_OPERATION));
    recordUsage({ input_tokens: response.usage.promptTokens ?? undefined, output_tokens: response.usage.completionTokens ?? undefined });
    const parser = new JsonlSeamParser();
    const events = [...parser.push(response.text), ...(response.finishReason === "stop" ? parser.push("\n") : []), ...parser.end()];
    const seams = this.seamsOf(events, `${EDIT_SEAMS_OPERATION} "${request.actTitle}"`);
    if (response.finishReason === "length") {
      console.warn(`ChatNarrationWriterBuilder: the seam edit of "${request.actTitle}" hit its cap (${maxTokens} tokens); keeping the ${seams.length} finished seam(s)`);
    }
    return { seams };
  }

  /**
   * GV-84: `streamAct` behind an iterator whose return() (and throw())
   * aborts the request AT ONCE. A generator's own return() is queued while a
   * next() is pending, so a consumer that gives up mid-read (writeAct.ts's
   * stall) would not free the lane until the builder's own idle bound fired;
   * the abort ends the provider's read now, the generator unwinds, and the
   * queued return() then settles.
   */
  private abortable(request: ActWriteRequest, ctx: NarrationBuildContext): AsyncIterableIterator<WriterStreamEvent> {
    const controller = new AbortController();
    const events = this.streamAct(request, ctx, controller);
    const iterator: AsyncIterableIterator<WriterStreamEvent> = {
      next: () => events.next(),
      return: (value?: unknown) => {
        controller.abort();
        return events.return(value as undefined);
      },
      throw: (err?: unknown) => {
        controller.abort();
        return events.throw(err);
      },
      [Symbol.asyncIterator]: () => iterator
    };
    return iterator;
  }

  /** GV-84: the streamed act (see the class comment and `writeActStream`). */
  private async *streamAct(request: ActWriteRequest, ctx: NarrationBuildContext, controller: AbortController): AsyncGenerator<WriterStreamEvent> {
    const messages = toChatMessages(actWritePromptParts(request, { output: "jsonl" }));
    const maxTokens = streamedActMaxTokens(request);
    await this.budgetGuard.checkAndRecord(this.costEvent(WRITE_ACT_OPERATION, messages, maxTokens, ctx));
    const chatRequest: ChatRequest = { ...this.chatRequest(messages, maxTokens, WRITE_ACT_OPERATION), signal: controller.signal };
    const startedAt = this.now();
    const parser = new JsonlSeamParser();
    const arrived = new Set<string>();
    const where = `${WRITE_ACT_OPERATION} "${request.actTitle}"`;
    let partialText = "";
    let done: Extract<ChatStreamEvent, { type: "done" }> | undefined;
    const iterator = this.provider.stream!(chatRequest)[Symbol.asyncIterator]();
    let finished = false;
    try {
      for (;;) {
        const next = await this.nextWithin(iterator);
        if (next === IDLE) {
          controller.abort();
          throw new ChatProviderError("timeout", "stream_idle", { partialText });
        }
        if (next.done) break;
        const event = next.value;
        if (done) throw new Error(`ChatNarrationWriterBuilder: the provider stream yielded a '${event.type}' event after its 'done' event`);
        if (event.type === "done") {
          done = event;
          continue;
        }
        partialText += event.text;
        for (const seam of this.seamsOf(parser.push(event.text), where)) {
          arrived.add(seam.seamId);
          yield { type: "seam", seam, atMs: this.now() - startedAt };
        }
      }
      finished = true;
    } finally {
      if (!finished) {
        /* A failure, the idle bound or a consumer that stopped early: cancel
           the request so the lane is freed, and stop the provider's read. */
        controller.abort();
        try {
          const closing = iterator.return?.();
          if (closing) closing.catch(() => undefined);
        } catch {
          /* a provider stream that cannot be told to stop is abandoned all the same */
        }
      }
    }
    if (!done) throw new Error("ChatNarrationWriterBuilder: the provider stream finished without a 'done' event");
    /* end() never guesses (seamStream.ts): a reply that finished normally
       may omit its last newline, so it gets one; a reply cut at the cap does
       not, and its unterminated line is reported, never parsed. */
    const tail = [...(done.finishReason === "stop" ? parser.push("\n") : []), ...parser.end()];
    for (const seam of this.seamsOf(tail, where)) {
      arrived.add(seam.seamId);
      yield { type: "seam", seam, atMs: this.now() - startedAt };
    }
    recordUsage({ input_tokens: done.usage?.promptTokens ?? undefined, output_tokens: done.usage?.completionTokens ?? undefined });
    yield {
      type: "end",
      stopReason: done.finishReason === "length" ? "length" : "end",
      unfinishedSeamIds: request.seams.map((s) => s.seamId).filter((id) => !arrived.has(id)),
      ...(done.usage ? { usage: usageOf(done.usage) } : {})
    };
  }

  /** The provider's next event, or IDLE when none arrives within the
   * between-chunk bound. */
  private nextWithin(iterator: AsyncIterator<ChatStreamEvent>): Promise<IteratorResult<ChatStreamEvent> | typeof IDLE> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = iterator.next();
    pending.catch(() => undefined);
    const idle = new Promise<typeof IDLE>((resolve) => {
      timer = setTimeout(() => resolve(IDLE), this.chunkIdleMs);
    });
    return Promise.race([pending, idle]).finally(() => clearTimeout(timer));
  }

  /** The seams among parser events; every bad or unfinished line is logged
   * (its error, never its text) and costs that seam only. */
  private seamsOf(events: SeamLineEvent[], where: string): WrittenSeam[] {
    const seams: WrittenSeam[] = [];
    for (const event of events) {
      if (event.type === "seam") seams.push(event.seam);
      else if (event.type === "bad-line") console.warn(`ChatNarrationWriterBuilder: ${where} -- a reply line was not a seam (${event.error}); that seam is missing`);
      else console.warn(`ChatNarrationWriterBuilder: ${where} -- the reply ended mid-line (${event.partial.length} chars); that seam is missing`);
    }
    return seams;
  }

  /** The request both GV-84 calls send: no response_format (see the class
   * comment), thinking off unless the target turns it on. */
  private chatRequest(messages: ChatMessage[], maxTokens: number, label: string): ChatRequest {
    return {
      model: this.target.model,
      messages,
      maxTokens,
      thinking: this.target.thinking ?? false,
      label,
      ...(this.target.temperature !== undefined ? { temperature: this.target.temperature } : {})
    };
  }

  /** askStructured's estimate: chars/4 input tokens plus the cap, at the
   * target's rates ($0 on a local lane today). */
  private costEvent(operation: string, messages: readonly ChatMessage[], maxTokens: number, ctx: NarrationBuildContext): CostEventInput {
    const inputTokens = Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
    return {
      userId: ctx.userId,
      operation,
      provider: this.target.providerName,
      model: this.target.model,
      estimatedUsd: (inputTokens * this.target.usdPerMtokIn + maxTokens * this.target.usdPerMtokOut) / 1_000_000,
      ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {})
    };
  }
}

function usageOf(usage: ChatUsage): { promptTokens: number | null; outputTokens: number | null } {
  return { promptTokens: usage.promptTokens, outputTokens: usage.completionTokens };
}
