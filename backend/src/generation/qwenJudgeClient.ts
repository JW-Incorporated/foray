import type { LaneId } from "../config/machineProfiles";
import {
  ChatProviderError,
  type ChatMessage,
  type ChatProvider,
  type ChatRequest,
  type ChatResponse,
  type ChatTokenLogprob,
  type ResponseFormat
} from "./chat/ChatProvider";
import { createJevPool, parseJevReply, validateJevQuestions, type JevPool } from "./jevClient";
import type {
  JevAskOptions,
  JevClient,
  JevErrorCategory,
  JevFailure,
  JevQuestion,
  JevResult,
  JevState
} from "./jevTypes";
import { withCallContext } from "./runLog";

/**
 * GV-47 (docs/roadmap/generation-v2.md, from W5-19 + W2-12; covers R1-07,
 * R1-20, OQ-05): the Qwen judge. OQ-05's adopted default is Jev with a
 * Qwen-judge fallback, so a Jev outage (a 503, paused signups, LM-25)
 * degrades the judged gates to a local judge instead of to "unknown
 * everywhere". Decision 7: this class IMPLEMENTS THE JevClient INTERFACE, so
 * every consumer (clarity, clip judge, sentence support, spine judge, critic)
 * keeps one interface and the fallback is transparent; W2-12's separate
 * TypedJudge is not built.
 *
 * ONE REQUEST PER QUESTION SET, on the ChatProvider (LiteLLM's
 * OpenAI-compatible endpoint; never Anthropic, never the relay). The route
 * names the lane: the judge stage's default fallback lane is `second`
 * (alias local-worker), so checks stay off the Spark's prose slots.
 *
 *   - The reply is grammar-constrained to a JSON Schema built FROM THE
 *     QUESTIONS (`judgeResponseFormat`): `{answers: {<questionId>: answer}}`,
 *     where a noul answer is `{noul}`, a choice `{choice, probabilities}` (the
 *     choice an enum of the criteria keys, probabilities keyed exactly by
 *     them) and a score `{score, probabilities}` (score an enum 0..levels-1).
 *     With logprobs a noul is asked as `{holds: boolean}` instead (below).
 *   - Thinking is off (chat_template_kwargs enable_thinking=false).
 *   - The reply passes through W5-01's validator (`parseJevReply`), so a
 *     malformed reply is `{ok:false, malformed}` exactly as Jev's would be.
 *     A reply cut at max_tokens is malformed ('truncated'), never repaired.
 *     There is no re-ask: a judge that cannot answer in shape is unjudged.
 *   - NEVER THROWS on a transport, HTTP or parse failure (the JevClient
 *     contract): a ChatProviderError becomes `{ok:false, error}` with the
 *     same categories Jev uses, so FallbackJudgeClient and every consumer
 *     treat both judges alike.
 *   - Every result is tagged `judge: 'qwen'`, and an ok result carries
 *     `calibrated`. Thresholds are per judge (gateConfig.ts
 *     `supportMinP.qwen`, `clipLevel.qwen`), so a Qwen probability is never
 *     read against a Jev threshold.
 *
 * PROBABILITIES (W2-12). A 35B-A3B MoE's self-reported probabilities are
 * poorly calibrated. When the lane profile says the server returns logprobs
 * (`logprobs: true`), the request asks for top_logprobs and the
 * probabilities are read from the token distribution where each answer's
 * value is decoded: a score's level digit, a choice key's first token (only
 * when that first token names one key), a noul's `true`/`false`. When every
 * answer's distribution could be read, `calibrated` is true; otherwise (no
 * logprobs on the lane, which is today's `second` profile, or an ambiguous
 * first token) the model's own numbers are used, renormalised to sum to 1,
 * and `calibrated` is false.
 *
 * Why not askStructured (GV-19, which the card names): its response_format
 * comes from a FIXED reply-schema name (replySchemas.ts), and a judge's
 * grammar depends on each question set (the choice keys and the number of
 * score levels are part of it); it also sends no logprobs request and
 * re-asks a bad reply. This class keeps askStructured's other rules: a
 * truncated reply is refused before parsing, thinking is off, and the
 * provider records the CallRecord (GV-07), run under the call context
 * {stage:'judge', role:'judge', lane}. It does not meter: meteredJevClient
 * (jevClient.ts) meters every judged ask in one place.
 *
 * The P40 lane has one slot per card and an XID-latch history, so the judge
 * has its own timeout (QWEN_JUDGE_DEFAULT_BUDGET_MS) and at most
 * `maxConcurrent` asks in flight (the lane profile's, 2 by default).
 */

export const QWEN_JUDGE_DEFAULT_BUDGET_MS = 20_000;
export const QWEN_JUDGE_DEFAULT_MAX_TOKENS = 600;
export const QWEN_JUDGE_DEFAULT_MAX_CONCURRENT = 2;
/** top_logprobs asked for per token when the lane returns logprobs. */
export const QWEN_JUDGE_TOP_LOGPROBS = 10;
export const QWEN_JUDGE_SCHEMA_NAME = "jev_judge_answers";

export const QWEN_JUDGE_SYSTEM_PROMPT = [
  "You are a strict, literal judge. You read a STATE and answer each QUESTION about it, using only what the state says.",
  "A noul question asks whether its `true` criterion holds: noul is the probability, from 0 to 1, that it does (or `holds` is true or false).",
  "A choice question: pick the one option key whose `what` fits best, and give a probability from 0 to 1 for every option key.",
  "A score question: its criteria are levels, level 0 first; pick the level that fits and give a probability for every level.",
  "Reply with the JSON object only, keyed by question id."
].join("\n");

export interface QwenJudgeClientOptions {
  provider: ChatProvider;
  /** The lane's LiteLLM alias (the route's model), e.g. local-worker. */
  model: string;
  lane: LaneId;
  /** How the lane constrains JSON (the lane profile's structuredOutput). */
  structuredOutput: "json_schema" | "json_object" | "none";
  /** Whether the lane returns token logprobs (the lane profile's flag). */
  logprobs: boolean;
  /** Total time one ask may take. */
  budgetMs?: number;
  maxTokens?: number;
  /** Asks in flight at once (the lane profile's maxConcurrent). */
  maxConcurrent?: number;
  /** Epoch-milliseconds clock for latencyMs (injectable for tests). */
  now?: () => number;
}

/* ---------------------------------------------------------------------------
   The request: messages and the per-question-set JSON Schema.
   --------------------------------------------------------------------------- */

type Schema = Record<string, unknown>;

const obj = (properties: Record<string, Schema>): Schema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false
});

const probabilitiesSchema = (keys: readonly string[]): Schema => obj(Object.fromEntries(keys.map((k) => [k, { type: "number" }])));

const scoreKeys = (levels: number): string[] => Array.from({ length: levels }, (_, i) => String(i));

function answerSchema(q: JevQuestion, logprobs: boolean): Schema {
  switch (q.type) {
    case "noul":
      return logprobs ? obj({ holds: { type: "boolean" } }) : obj({ noul: { type: "number" } });
    case "choice": {
      const keys = Object.keys(q.criteria);
      return obj({ choice: { type: "string", enum: keys }, probabilities: probabilitiesSchema(keys) });
    }
    case "score": {
      const levels = q.criteria.length;
      return obj({ score: { type: "integer", enum: Array.from({ length: levels }, (_, i) => i) }, probabilities: probabilitiesSchema(scoreKeys(levels)) });
    }
  }
}

/** The reply's JSON Schema for one question set. */
export function judgeReplySchema(questions: readonly JevQuestion[], logprobs: boolean): Schema {
  return obj({ answers: obj(Object.fromEntries(questions.map((q) => [q.id, answerSchema(q, logprobs)]))) });
}

/** The response_format sent for a question set on a lane. */
export function judgeResponseFormat(
  questions: readonly JevQuestion[],
  structuredOutput: QwenJudgeClientOptions["structuredOutput"],
  logprobs: boolean
): ResponseFormat | undefined {
  if (structuredOutput === "json_schema") {
    return { type: "json_schema", name: QWEN_JUDGE_SCHEMA_NAME, schema: judgeReplySchema(questions, logprobs), strict: true };
  }
  if (structuredOutput === "json_object") return { type: "json_object" };
  return undefined;
}

/** The two messages of one ask. The state and the questions go as JSON; the
 * reply shape is spelled out too, for a lane that cannot hold a schema. */
export function judgeMessages(state: JevState, questions: readonly JevQuestion[], logprobs: boolean): ChatMessage[] {
  const shape = JSON.stringify(judgeReplySchema(questions, logprobs));
  return [
    { role: "system", content: QWEN_JUDGE_SYSTEM_PROMPT },
    { role: "user", content: `STATE:\n${JSON.stringify(state)}\n\nQUESTIONS:\n${JSON.stringify(questions)}\n\nReply with JSON matching this schema:\n${shape}` }
  ];
}

/* ---------------------------------------------------------------------------
   Reading the reply.
   --------------------------------------------------------------------------- */

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

const isProbability = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;

/** A self-reported probability map scaled to sum to 1, when every value is a
 * probability and the sum is positive; anything else is returned untouched so
 * the validator refuses it. */
function renormalised(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const values = Object.values(raw);
  if (values.length === 0 || !values.every(isProbability)) return raw;
  const sum = values.reduce((a: number, b) => a + (b as number), 0);
  if (!(sum > 0)) return raw;
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, (v as number) / sum]));
}

/** The offset just past `key` followed by optional whitespace, ':' and
 * optional whitespace, searching from `from`; -1 when absent. A plain scan,
 * not a RegExp built from the key. */
function afterKey(text: string, key: string, from: number): number {
  const quoted = JSON.stringify(key);
  for (let at = text.indexOf(quoted, from); at >= 0; at = text.indexOf(quoted, at + 1)) {
    let i = at + quoted.length;
    while (/\s/.test(text[i] ?? "")) i += 1;
    if (text[i] !== ":") continue;
    i += 1;
    while (/\s/.test(text[i] ?? "")) i += 1;
    return i;
  }
  return -1;
}

/** Character offset where `field`'s value starts inside the answer object of
 * question `id` (just after an opening quote for a string value), or null. */
export function valueOffset(text: string, id: string, field: string): number | null {
  const answer = afterKey(text, id, 0);
  if (answer < 0 || text[answer] !== "{") return null;
  const value = afterKey(text, field, answer + 1);
  if (value < 0) return null;
  return text[value] === '"' ? value + 1 : value;
}

/**
 * The probability of each label at the token where a value starts at `at`,
 * from top_logprobs, renormalised over the labels it could read. A label gets
 * the mass of every alternative whose text (after the part of the token that
 * precedes the value) is a non-empty prefix of that label and of no other
 * label. Null when the tokens do not spell `text`, no alternative maps to a
 * label, or the chosen token itself is ambiguous.
 */
export function distributionAt(logprobs: readonly ChatTokenLogprob[], text: string, at: number, labels: readonly string[]): Record<string, number> | null {
  if (logprobs.map((t) => t.token).join("") !== text) return null;
  let start = 0;
  let index = -1;
  for (let i = 0; i < logprobs.length; i += 1) {
    const end = start + logprobs[i]!.token.length;
    if (at >= start && at < end) {
      index = i;
      break;
    }
    start = end;
  }
  if (index < 0) return null;
  const entry = logprobs[index]!;
  const lead = entry.token.slice(0, at - start);
  const labelOf = (token: string): string | null => {
    if (!token.startsWith(lead)) return null;
    const rest = token.slice(lead.length).trimEnd();
    if (rest.length === 0) return null;
    /* The token spells the start of a label, or a whole label followed by
       the JSON that closes the value. */
    const matches = labels.filter((l) => l.startsWith(rest) || (rest.startsWith(l) && /^["},\]\s]/.test(rest.slice(l.length))));
    return matches.length === 1 ? matches[0]! : null;
  };
  if (labelOf(entry.token) === null) return null;
  const alternatives = entry.top.some((t) => t.token === entry.token) ? entry.top : [{ token: entry.token, logprob: entry.logprob }, ...entry.top];
  const mass: Record<string, number> = Object.fromEntries(labels.map((l) => [l, 0]));
  let total = 0;
  for (const alt of alternatives) {
    const label = labelOf(alt.token);
    if (label === null || !Number.isFinite(alt.logprob)) continue;
    const p = Math.exp(alt.logprob);
    mass[label]! += p;
    total += p;
  }
  if (!(total > 0)) return null;
  for (const l of labels) mass[l] = mass[l]! / total;
  return mass;
}

class Unreadable extends Error {}

export interface ReadJudgeReplyResult {
  /** A Jev-shaped body for parseJevReply. */
  body: string;
  /** True when every answer's probabilities came from logprobs. */
  calibrated: boolean;
}

/**
 * Turns the Qwen judge's reply text into a Jev-shaped reply body, so W5-01's
 * validator (parseJevReply) decides whether it is well formed. Values the
 * validator checks (ranges, keys, the choice) are passed through as given;
 * only the shape is translated. Null when the text is not a JSON object with
 * an `answers` object.
 */
export function readJudgeReply(
  text: string,
  questions: readonly JevQuestion[],
  logprobs: readonly ChatTokenLogprob[] | undefined
): ReadJudgeReplyResult | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(json) || !isRecord(json.answers)) return null;
  const replies = json.answers;
  let calibrated = logprobs !== undefined && logprobs.length > 0;
  const fromLogprobs = (id: string, field: string, labels: readonly string[]): Record<string, number> | null => {
    if (!logprobs || logprobs.length === 0) return null;
    const at = valueOffset(text, id, field);
    return at === null ? null : distributionAt(logprobs, text, at, labels);
  };
  try {
    const answers = questions.map((q) => {
      const raw = replies[q.id];
      if (!isRecord(raw)) throw new Unreadable();
      switch (q.type) {
        case "noul": {
          if (logprobs && logprobs.length > 0 && typeof raw.holds === "boolean") {
            const dist = fromLogprobs(q.id, "holds", ["true", "false"]);
            if (dist) return { id: q.id, type: "noul", noul: dist["true"] ?? 0 };
            calibrated = false;
            return { id: q.id, type: "noul", noul: raw.holds ? 1 : 0 };
          }
          calibrated = false;
          return { id: q.id, type: "noul", noul: raw.noul };
        }
        case "choice": {
          const keys = Object.keys(q.criteria);
          const dist = fromLogprobs(q.id, "choice", keys);
          if (!dist) calibrated = false;
          const probabilities = dist ?? renormalised(raw.probabilities);
          const confidence = typeof raw.choice === "string" && isRecord(probabilities) ? probabilities[raw.choice] : undefined;
          return { id: q.id, type: "choice", choice: raw.choice, probabilities, confidence };
        }
        case "score": {
          const keys = scoreKeys(q.criteria.length);
          const dist = fromLogprobs(q.id, "score", keys);
          if (!dist) calibrated = false;
          const probabilities = dist ?? renormalised(raw.probabilities);
          const score = raw.score;
          const confidence = typeof score === "number" && isRecord(probabilities) ? probabilities[String(score)] : undefined;
          const legend = typeof score === "number" && Number.isInteger(score) ? (q.criteria[score] ?? null) : null;
          return { id: q.id, type: "score", score, legend, probabilities, confidence };
        }
      }
    });
    return { body: JSON.stringify({ answers }), calibrated };
  } catch (err) {
    if (err instanceof Unreadable) return { body: JSON.stringify({ answers: null }), calibrated: false };
    throw err;
  }
}

/* ---------------------------------------------------------------------------
   The client.
   --------------------------------------------------------------------------- */

function categoryOf(err: unknown): { category: JevErrorCategory; reason: string; httpStatus?: number } {
  if (err instanceof ChatProviderError) {
    switch (err.kind) {
      case "http":
        return { category: "http", reason: err.status !== undefined ? `http_${err.status}` : "http", ...(err.status !== undefined ? { httpStatus: err.status } : {}) };
      case "timeout":
        return { category: "timeout", reason: "timeout" };
      case "aborted":
        return { category: "timeout", reason: "aborted" };
      case "malformed":
        return { category: "malformed", reason: "malformed_response" };
      case "network":
        return { category: "network", reason: "network" };
    }
  }
  /* An error the provider did not classify: the judge was not reached. */
  return { category: "network", reason: "provider_error" };
}

export class QwenJudgeClient implements JevClient {
  readonly model: string;
  readonly lane: LaneId;
  /** The cost event's provider (targetFor's naming). */
  readonly providerName: string;
  readonly budgetMs: number;
  readonly maxTokens: number;
  readonly logprobs: boolean;
  private readonly provider: ChatProvider;
  private readonly structuredOutput: QwenJudgeClientOptions["structuredOutput"];
  private readonly now: () => number;
  private readonly pool: JevPool;

  constructor(opts: QwenJudgeClientOptions) {
    const budgetMs = opts.budgetMs ?? QWEN_JUDGE_DEFAULT_BUDGET_MS;
    if (!(Number.isFinite(budgetMs) && budgetMs > 0)) throw new Error("QwenJudgeClient: budgetMs must be a positive number");
    this.provider = opts.provider;
    this.model = opts.model;
    this.lane = opts.lane;
    this.providerName = `local:${opts.lane}`;
    this.structuredOutput = opts.structuredOutput;
    this.logprobs = opts.logprobs;
    this.budgetMs = budgetMs;
    this.maxTokens = opts.maxTokens ?? QWEN_JUDGE_DEFAULT_MAX_TOKENS;
    this.now = opts.now ?? Date.now;
    this.pool = createJevPool({ ask: (state, questions, askOpts) => this.askOnce(state, questions, askOpts) }, { maxInFlight: opts.maxConcurrent ?? QWEN_JUDGE_DEFAULT_MAX_CONCURRENT });
  }

  async ask(state: JevState, questions: readonly JevQuestion[], opts: JevAskOptions): Promise<JevResult> {
    const result = await this.pool.ask(state, questions, opts);
    return { ...result, judge: "qwen" };
  }

  private async askOnce(state: JevState, questions: readonly JevQuestion[], opts: JevAskOptions): Promise<JevResult> {
    const invalid = validateJevQuestions(questions);
    if (invalid !== null) return { ok: false, error: { category: "malformed", reason: invalid }, latencyMs: 0 };
    const startedAt = this.now();
    const fail = (category: JevErrorCategory, reason: string, httpStatus?: number): JevFailure => ({
      ok: false,
      error: { category, reason, ...(httpStatus !== undefined ? { httpStatus } : {}) },
      latencyMs: this.now() - startedAt
    });

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.budgetMs);
    const onCallerAbort = (): void => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", onCallerAbort, { once: true });
    }
    /* Raced as well as passed: a provider that ignores its signal must not
       hold the ask past its budget. */
    const aborted = new Promise<never>((_, reject) => {
      const stop = (): void => reject(new Error("aborted"));
      if (controller.signal.aborted) stop();
      else controller.signal.addEventListener("abort", stop, { once: true });
    });
    aborted.catch(() => undefined);

    try {
      if (controller.signal.aborted) return timedOut ? fail("timeout", "timeout") : fail("timeout", "aborted");
      const responseFormat = judgeResponseFormat(questions, this.structuredOutput, this.logprobs);
      let response: ChatResponse;
      try {
        let messages: ChatMessage[];
        try {
          messages = judgeMessages(state, questions, this.logprobs);
        } catch {
          return fail("malformed", "invalid_state");
        }
        const request: ChatRequest = {
          model: this.model,
          messages,
          maxTokens: this.maxTokens,
          thinking: false,
          temperature: 0,
          label: opts.purpose,
          signal: controller.signal,
          ...(responseFormat ? { responseFormat } : {}),
          ...(this.logprobs ? { logprobs: { top: QWEN_JUDGE_TOP_LOGPROBS } } : {})
        };
        response = await Promise.race([
          aborted,
          withCallContext({ stage: "judge", role: "judge", lane: this.lane }, () => this.provider.complete(request))
        ]);
      } catch (err) {
        if (timedOut) return fail("timeout", "timeout");
        if (opts.signal?.aborted) return fail("timeout", "aborted");
        const { category, reason, httpStatus } = categoryOf(err);
        return fail(category, reason, httpStatus);
      }
      if (response.finishReason === "length") return fail("malformed", "truncated");
      const read = readJudgeReply(response.text, questions, this.logprobs ? response.logprobs : undefined);
      if (read === null) return fail("malformed", "malformed_json");
      const parsed = parseJevReply(read.body, questions);
      if (!parsed.ok) return fail("malformed", parsed.reason);
      return {
        ok: true,
        answers: parsed.answers,
        model: response.model ?? this.model,
        /* LiteLLM answers an alias with the served model's id, so a
           different name is expected here and is not a mismatch. */
        modelMismatch: false,
        usage: { inputTokens: response.usage.promptTokens, outputTokens: response.usage.completionTokens },
        requestId: response.requestId,
        latencyMs: this.now() - startedAt,
        calibrated: read.calibrated
      };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onCallerAbort);
    }
  }
}
