import { env, readString } from "../config/env";
import { resolveRouting, type RoutingTable, type StageRoute } from "../config/stageRouting";
import type { BudgetGuard } from "../cost/budgetGuard";
import type { ChatProvider } from "./chat/ChatProvider";
import { chatProviderFor } from "./chat/providerRegistry";
import {
  JEV_CHOICE_MAX_OPTIONS,
  JEV_CHOICE_MIN_OPTIONS,
  JEV_SCORE_MAX_LEVELS,
  JEV_SCORE_MIN_LEVELS,
  type JevAnswer,
  type JevAskOptions,
  type JevCallInfo,
  type JevClient,
  type JevError,
  type JevErrorCategory,
  type JevFailure,
  type JevQuestion,
  type JevResult,
  type JevState,
  type JevUsage,
  type JudgeId
} from "./jevTypes";
import { QwenJudgeClient, type QwenJudgeClientOptions } from "./qwenJudgeClient";
import { currentRunLog, recordModelCall } from "./runLog";

/**
 * GV-20 (docs/roadmap/generation-v2.md, from W5-01 + W2-11): the ONE
 * TypeScript Jev client (decision 6). Jev is TypeSafe's hosted
 * typed-decision model; the judged gates of later cards (clarity, clip
 * judge, sentence support, spine choice, ...) ask it noul / choice / score
 * questions through the JevClient interface in jevTypes.ts.
 *
 * INERT UNTIL A KEY EXISTS. createJevClient() returns NullJevClient (every
 * ask is {ok:false, no_key}) unless JEV_API_KEY or JEV_KEY_FILE is set, and
 * nothing in the pipeline calls it until a judged card's flag is switched on.
 *
 * What HttpJevClient does, once per ask:
 *   - POSTs {base}/v1/systemone with body {state, model, questions} and
 *     `Authorization: Bearer <key>`. The key lives in a closure and goes in
 *     that header only: never a field, an error, a log line or a CallRecord.
 *   - Holds the whole ask (connect + body) to FORAY_JEV_BUDGET_MS (4000 ms by
 *     default) with an AbortController. NO retries: a retry is a caller's
 *     policy, with a budget.
 *   - Validates the reply like jevclient.py _parse_answers: answer type
 *     matches the question; a choice is one of the criteria keys;
 *     probabilities are finite, in 0..1 and keyed exactly by the criteria
 *     (score: '0'..'n-1'); a score is in [0, levels-1]; confidence in 0..1.
 *   - NEVER THROWS on a transport, HTTP or parse failure. Each is
 *     {ok:false, error:{category, reason}} with a FIXED reason ('timeout',
 *     'network', 'http_<status>', 'malformed_json', ...); the response body
 *     is never read into it.
 *   - Pins the model ('jev-1.13.0' unless FORAY_JEV_MODEL says otherwise). A
 *     reply naming another model is still ok, with modelMismatch:true and one
 *     console warning.
 *   - Records exactly one CallRecord (provider 'jev', role 'judge', label =
 *     purpose) through runLog.recordModelCall when a RunLog is active; this
 *     file is in PROVIDER_CALL_SITES (GV-07).
 *
 * meteredJevClient meters every ask through BudgetGuard (the one place Jev
 * spend is checked); createJevPool bounds fan-out. Per-Foray Jev-call caps
 * are GV-90's.
 *
 * GV-47 (OQ-05, decision 7): the judge is ROUTED. createJevClient reads the
 * routing table's 'judge' stage (FORAY_STAGE_JUDGE=jev|jev:<lane>|local:<lane>|none,
 * config/stageRouting.ts) and returns:
 *   - none            NullJevClient: fail-closed, every consumer reads
 *                     {ok:false} as 'not passed';
 *   - local:<lane>    the Qwen judge (qwenJudgeClient.ts) on that lane;
 *   - jev             HttpJevClient (NullJevClient without a key);
 *   - jev:<lane>      FallbackJudgeClient(Jev, the Qwen judge on <lane>) with
 *                     a circuit breaker; the Qwen judge alone when there is
 *                     no Jev key.
 * Local mode's default is jev with a local:second fallback; outside local
 * mode it is jev when a Jev key exists, else none. There is no
 * FORAY_JUDGE_FALLBACK variable (decision 4). Every answer is tagged with
 * the judge that gave it, so thresholds are read per judge (gateConfig.ts).
 *
 * qwenJudgeClient.ts imports this file's validator and pool, and
 * createJevClient builds a QwenJudgeClient: the two modules import each
 * other, which is safe because neither uses the other at load time.
 *
 * PRIVACY / RETENTION (RQ-04). Jev is hosted off-network: every ask sends its
 * `state` and question text to TypeSafe (LM-25). OQ-05's adopted default
 * allows this; TypeSafe's retention of that text is an open question recorded
 * against RQ-04. Callers keep `state` minimal (a sentence and the passages it
 * is judged on, never a listener's history), and Jev is weak on numbers,
 * dates and long irrelevant context (LM-23).
 *
 * The Jev host and path appear in THIS file only: backend/test/jevClient.test.ts
 * fails when another generation module names them.
 */

export const JEV_DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const JEV_SYSTEMONE_PATH = "/v1/systemone";
export const JEV_PINNED_MODEL = "jev-1.13.0";
export const JEV_DEFAULT_BUDGET_MS = 4000;
/** Input price, USD per token ($0.042 per million input tokens). */
export const JEV_INPUT_USD_PER_TOKEN = 0.042e-6;
export const JEV_REQUEST_ID_HEADER = "x-typesafe-request-id";
export const DEFAULT_JEV_POOL_SIZE = 8;

/* ---------------------------------------------------------------------------
   Fetch shape. Declared here rather than imported from chat/ (the
   OpenAI-compatible client is inert outside generation/chat/); Node's global
   fetch and backend/test/helpers/fakeFetch.ts both satisfy it.
   --------------------------------------------------------------------------- */

export interface JevFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface JevFetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export type JevFetch = (url: string, init: JevFetchInit) => Promise<JevFetchResponse>;

/* ---------------------------------------------------------------------------
   Question validation (W2-11: choice 2..255 options, score 2..10 levels).
   --------------------------------------------------------------------------- */

const nonEmpty = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

const own = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

/** Null when every question is well formed, else a fixed reason. A bad
 * question is the caller's bug; it is reported, never sent. */
export function validateJevQuestions(questions: readonly JevQuestion[]): string | null {
  if (!Array.isArray(questions) || questions.length === 0) return "no_questions";
  const ids = new Set<string>();
  for (const q of questions as readonly unknown[]) {
    if (!isRecord(q) || !nonEmpty(q.id) || ids.has(q.id)) return "invalid_question_id";
    ids.add(q.id);
    if (!nonEmpty(q.instructions)) return "invalid_question";
    const criteria = q.criteria;
    if (q.type === "noul") {
      if (!isRecord(criteria) || !nonEmpty(criteria.true) || !nonEmpty(criteria.false)) return "invalid_question";
    } else if (q.type === "choice") {
      if (!isRecord(criteria)) return "invalid_question";
      const keys = Object.keys(criteria);
      if (keys.length < JEV_CHOICE_MIN_OPTIONS || keys.length > JEV_CHOICE_MAX_OPTIONS) return "invalid_question";
      for (const key of keys) {
        const option = criteria[key];
        if (key.length === 0 || !isRecord(option) || !nonEmpty(option.what)) return "invalid_question";
      }
    } else if (q.type === "score") {
      if (!Array.isArray(criteria) || criteria.length < JEV_SCORE_MIN_LEVELS || criteria.length > JEV_SCORE_MAX_LEVELS) {
        return "invalid_question";
      }
      if (!criteria.every(nonEmpty)) return "invalid_question";
    } else {
      return "invalid_question";
    }
  }
  return null;
}

/* ---------------------------------------------------------------------------
   Reply parsing (port of jevclient.py _parse_answers).
   --------------------------------------------------------------------------- */

export interface ParsedJevReply {
  answers: JevAnswer[];
  model: string | null;
  usage: JevUsage;
}

export type ParseJevReplyResult = ({ ok: true } & ParsedJevReply) | { ok: false; reason: string };

class Malformed extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const isProbability = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;

const tokenCount = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null);

/** A copy of `raw` keyed EXACTLY by `keys`, every value a probability. */
function probabilitiesFor(raw: unknown, keys: readonly string[]): Record<string, number> {
  if (!isRecord(raw)) throw new Malformed("probabilities_mismatch");
  const got = Object.keys(raw);
  if (got.length !== keys.length || !keys.every((k) => own(raw, k))) throw new Malformed("probabilities_mismatch");
  const out: Record<string, number> = {};
  for (const k of keys) {
    const p = raw[k];
    if (!isProbability(p)) throw new Malformed("probabilities_mismatch");
    out[k] = p;
  }
  return out;
}

function confidenceOf(raw: unknown): number {
  if (!isProbability(raw)) throw new Malformed("confidence_out_of_range");
  return raw;
}

function parseAnswer(raw: unknown, q: JevQuestion): JevAnswer {
  if (!isRecord(raw)) throw new Malformed("malformed_answers");
  if (raw.id !== undefined && raw.id !== q.id) throw new Malformed("answer_id_mismatch");
  if (raw.type !== q.type) throw new Malformed("answer_type_mismatch");
  switch (q.type) {
    case "noul": {
      if (!isProbability(raw.noul)) throw new Malformed("noul_out_of_range");
      return { id: q.id, type: "noul", noul: raw.noul };
    }
    case "choice": {
      const keys = Object.keys(q.criteria);
      if (typeof raw.choice !== "string" || !own(q.criteria, raw.choice)) throw new Malformed("choice_not_in_criteria");
      return {
        id: q.id,
        type: "choice",
        choice: raw.choice,
        probabilities: probabilitiesFor(raw.probabilities, keys),
        confidence: confidenceOf(raw.confidence)
      };
    }
    case "score": {
      const levels = q.criteria.length;
      const score = raw.score;
      if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > levels - 1) {
        throw new Malformed("score_out_of_range");
      }
      const keys = Array.from({ length: levels }, (_, i) => String(i));
      return {
        id: q.id,
        type: "score",
        score,
        legend: typeof raw.legend === "string" ? raw.legend : null,
        probabilities: probabilitiesFor(raw.probabilities, keys),
        confidence: confidenceOf(raw.confidence)
      };
    }
  }
}

/** The raw answers, in question order. Jev's `answers` is read as an array
 * (one per question, in order; an `id`, when present, must match) or as an
 * object keyed by question id with exactly the asked ids. */
function answersInOrder(raw: unknown, questions: readonly JevQuestion[]): unknown[] {
  if (Array.isArray(raw)) {
    if (raw.length !== questions.length) throw new Malformed("malformed_answers");
    return raw;
  }
  if (isRecord(raw)) {
    const keys = Object.keys(raw);
    if (keys.length !== questions.length || !questions.every((q) => own(raw, q.id))) throw new Malformed("malformed_answers");
    return questions.map((q) => raw[q.id]);
  }
  throw new Malformed("malformed_answers");
}

/** Parses a /v1/systemone reply body against the questions that were asked.
 * Never throws; a failure is a fixed reason. */
export function parseJevReply(rawBody: string, questions: readonly JevQuestion[]): ParseJevReplyResult {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: "malformed_json" };
  }
  try {
    if (!isRecord(json)) throw new Malformed("malformed_body");
    const answers = answersInOrder(json.answers, questions).map((a, i) => parseAnswer(a, questions[i]!));
    if (json.model !== undefined && json.model !== null && !nonEmpty(json.model)) throw new Malformed("malformed_model");
    const usage = isRecord(json.usage) ? json.usage : {};
    return {
      ok: true,
      answers,
      model: nonEmpty(json.model) ? json.model : null,
      usage: {
        inputTokens: tokenCount(usage.input_tokens ?? usage.prompt_tokens),
        outputTokens: tokenCount(usage.output_tokens ?? usage.completion_tokens)
      }
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Malformed ? err.reason : "malformed_answers" };
  }
}

/* ---------------------------------------------------------------------------
   Clients.
   --------------------------------------------------------------------------- */

/** What every ask returns when no key is configured. */
export class NullJevClient implements JevClient {
  async ask(): Promise<JevResult> {
    return { ok: false, error: { category: "no_key", reason: "no_key" }, latencyMs: 0 };
  }
}

export interface HttpJevClientOptions {
  apiKey: string;
  /** e.g. https://api.typesafe.ai (no trailing path). */
  baseUrl?: string;
  model?: string;
  /** Total time one ask may take, connect plus body. */
  budgetMs?: number;
  fetchImpl?: JevFetch;
  /** Epoch-milliseconds clock for latencyMs (injectable for tests). */
  now?: () => number;
  /** Where the model-mismatch warning goes (console.warn by default). */
  warn?: (message: string) => void;
}

/** A model id safe to print: printable id characters only, at most 64. */
const printableModel = (m: string): string => m.replace(/[^\w.:/-]/g, "?").slice(0, 64);

export class HttpJevClient implements JevClient {
  readonly model: string;
  readonly url: string;
  readonly budgetMs: number;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  /** Sends one request. The key is captured by this closure and nowhere else,
   * so neither JSON.stringify nor util.inspect of the client can show it. */
  private readonly post: (body: string, signal: AbortSignal) => Promise<JevFetchResponse>;

  constructor(opts: HttpJevClientOptions) {
    if (!nonEmpty(opts.apiKey)) throw new Error("HttpJevClient: an API key is required (use NullJevClient without one)");
    const budgetMs = opts.budgetMs ?? JEV_DEFAULT_BUDGET_MS;
    if (!(Number.isFinite(budgetMs) && budgetMs > 0)) throw new Error("HttpJevClient: budgetMs must be a positive number");
    const fetchImpl = opts.fetchImpl ?? (globalThis as { fetch?: JevFetch }).fetch;
    if (typeof fetchImpl !== "function") throw new Error("HttpJevClient: no fetch implementation");
    const base = (opts.baseUrl ?? JEV_DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
    this.url = `${base}${JEV_SYSTEMONE_PATH}`;
    this.model = opts.model ?? JEV_PINNED_MODEL;
    this.budgetMs = budgetMs;
    this.now = opts.now ?? Date.now;
    this.warn = opts.warn ?? ((message) => console.warn(message));
    const key = opts.apiKey;
    const url = this.url;
    this.post = (body, signal) =>
      fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body,
        signal
      });
  }

  async ask(state: JevState, questions: readonly JevQuestion[], opts: JevAskOptions): Promise<JevResult> {
    const invalid = validateJevQuestions(questions);
    if (invalid !== null) return { ok: false, error: { category: "malformed", reason: invalid }, latencyMs: 0 };
    const logStartMs = currentRunLog()?.nowMs() ?? 0;
    const result = await this.send(state, questions, opts.signal);
    this.record(opts.purpose, logStartMs, result);
    return result;
  }

  private async send(state: JevState, questions: readonly JevQuestion[], callerSignal: AbortSignal | undefined): Promise<JevResult> {
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
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
    /* Raced as well as passed: a fetch (or body read) that ignores its signal
       must not hold the ask past its budget. */
    const aborted = new Promise<never>((_, reject) => {
      const stop = (): void => reject(new Error("aborted"));
      if (controller.signal.aborted) stop();
      else controller.signal.addEventListener("abort", stop, { once: true });
    });
    aborted.catch(() => undefined);
    /* A caller's cancel is a deadline the caller set: category timeout,
       reason 'aborted'. */
    const classify = (): JevFailure =>
      timedOut ? fail("timeout", "timeout") : callerSignal?.aborted ? fail("timeout", "aborted") : fail("network", "network");

    try {
      if (controller.signal.aborted) return classify();
      let body: string;
      try {
        body = JSON.stringify({ state, model: this.model, questions });
      } catch {
        return fail("malformed", "invalid_state");
      }
      let res: JevFetchResponse;
      try {
        res = await Promise.race([aborted, this.post(body, controller.signal)]);
      } catch {
        return classify();
      }
      if (!res.ok) {
        /* Drained and dropped: the body never reaches the error. */
        void Promise.resolve()
          .then(() => res.text())
          .catch(() => undefined);
        return fail("http", `http_${res.status}`, res.status);
      }
      let raw: string;
      try {
        raw = await Promise.race([aborted, res.text()]);
      } catch {
        return classify();
      }
      const parsed = parseJevReply(raw, questions);
      if (!parsed.ok) return fail("malformed", parsed.reason);
      const model = parsed.model ?? this.model;
      const modelMismatch = model !== this.model;
      if (modelMismatch) {
        this.warn(`jev: asked for model ${printableModel(this.model)} but ${printableModel(model)} answered`);
      }
      let requestId: string | null = null;
      try {
        requestId = res.headers.get(JEV_REQUEST_ID_HEADER);
      } catch {
        requestId = null;
      }
      return {
        ok: true,
        answers: parsed.answers,
        model,
        modelMismatch,
        usage: parsed.usage,
        requestId,
        latencyMs: this.now() - startedAt
      };
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }

  /** GV-07: one CallRecord per ask that reached the wire; a no-op outside a RunLog. */
  private record(purpose: string, logStartMs: number, result: JevResult): void {
    const log = currentRunLog();
    if (!log) return;
    recordModelCall({
      provider: "jev",
      role: "judge",
      machine: null,
      model: result.ok ? result.model : this.model,
      label: purpose,
      startMs: logStartMs,
      endMs: log.nowMs(),
      promptTokens: result.ok ? result.usage.inputTokens : null,
      outputTokens: result.ok ? result.usage.outputTokens : null,
      jsonValid: result.ok ? true : result.error.category === "malformed" ? false : null,
      ...(result.ok ? {} : { error: errorKind(result.error) })
    });
  }
}

function errorKind(error: JevError): { kind: string; status?: number } {
  return { kind: error.category, ...(error.httpStatus !== undefined ? { status: error.httpStatus } : {}) };
}

/* ---------------------------------------------------------------------------
   GV-47: the fallback judge and its circuit breaker.
   --------------------------------------------------------------------------- */

export const DEFAULT_BREAKER_FAILURES_TO_OPEN = 3;
export const DEFAULT_BREAKER_COOL_OFF_MS = 60_000;

export interface CircuitBreakerOptions {
  /** Consecutive primary outages (timeout, http, network) that open it. */
  failuresToOpen?: number;
  /** How long an open breaker sends every ask straight to the fallback. */
  coolOffMs?: number;
  /** Epoch-milliseconds clock (a fake one in tests). */
  now?: () => number;
}

export type BreakerState = "closed" | "open" | "half-open";

/**
 * W2-12's breaker. Closed: the primary is asked. After `failuresToOpen`
 * consecutive outages it opens for `coolOffMs`, and the primary is not asked
 * at all. When the cool-off ends it is half-open: the next ask tries the
 * primary again; a success closes it, an outage re-opens it for another
 * cool-off. A malformed reply is not an outage (the primary answered), so it
 * neither opens nor closes the breaker.
 */
export class CircuitBreaker {
  readonly failuresToOpen: number;
  readonly coolOffMs: number;
  private readonly now: () => number;
  private failures = 0;
  private openUntil: number | null = null;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failuresToOpen = opts.failuresToOpen ?? DEFAULT_BREAKER_FAILURES_TO_OPEN;
    this.coolOffMs = opts.coolOffMs ?? DEFAULT_BREAKER_COOL_OFF_MS;
    if (!(Number.isInteger(this.failuresToOpen) && this.failuresToOpen > 0)) throw new Error("CircuitBreaker: failuresToOpen must be a positive integer");
    if (!(Number.isFinite(this.coolOffMs) && this.coolOffMs >= 0)) throw new Error("CircuitBreaker: coolOffMs must be a non-negative number");
    this.now = opts.now ?? Date.now;
  }

  get state(): BreakerState {
    if (this.openUntil === null) return "closed";
    return this.now() < this.openUntil ? "open" : "half-open";
  }

  /** False while open: the primary must not be asked. */
  allowsPrimary(): boolean {
    return this.state !== "open";
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openUntil = null;
  }

  recordOutage(): void {
    this.failures += 1;
    if (this.failures >= this.failuresToOpen) this.openUntil = this.now() + this.coolOffMs;
  }
}

/** The primary failures that send an ask to the fallback (W5-19): the judge
 * could not be reached or did not answer in time. A malformed reply, a
 * missing key and a caller's own cancel never fall back. */
export function isJudgeOutage(result: JevResult): boolean {
  if (result.ok) return false;
  const { category, reason } = result.error;
  if (category === "timeout") return reason !== "aborted";
  return category === "http" || category === "network";
}

export interface JudgeFallbackInfo {
  purpose: string;
  /** 'breaker_open' when the primary was skipped, else the primary's error reason. */
  reason: string;
  breaker: BreakerState;
}

export interface FallbackJudgeClientOptions {
  /** Called once per ask the fallback answers. */
  onFallback?: (info: JudgeFallbackInfo) => void;
  breaker?: CircuitBreakerOptions;
  /** The tag the fallback's results carry when it sets none (default 'qwen'). */
  fallbackJudge?: JudgeId;
}

/**
 * Asks `primary` (Jev) and, on an outage only, `fallback` (the Qwen judge),
 * behind a CircuitBreaker. Every result is tagged with the judge that
 * produced it: 'jev' for the primary's answers and for failures that do not
 * fall back, the fallback's tag otherwise.
 */
export class FallbackJudgeClient implements JevClient {
  readonly breaker: CircuitBreaker;
  private readonly fallbackJudge: JudgeId;

  constructor(
    readonly primary: JevClient,
    readonly fallback: JevClient,
    private readonly opts: FallbackJudgeClientOptions = {}
  ) {
    this.breaker = new CircuitBreaker(opts.breaker);
    this.fallbackJudge = opts.fallbackJudge ?? "qwen";
  }

  /** The judge the next ask goes to first. */
  nextJudge(): JudgeId {
    return this.breaker.allowsPrimary() ? "jev" : this.fallbackJudge;
  }

  async ask(state: JevState, questions: readonly JevQuestion[], opts: JevAskOptions): Promise<JevResult> {
    if (!this.breaker.allowsPrimary()) return this.askFallback(state, questions, opts, "breaker_open");
    const result = await this.primary.ask(state, questions, opts);
    if (result.ok) {
      this.breaker.recordSuccess();
      return { ...result, judge: "jev" };
    }
    if (!isJudgeOutage(result) || opts.signal?.aborted) return { ...result, judge: "jev" };
    this.breaker.recordOutage();
    return this.askFallback(state, questions, opts, result.error.reason);
  }

  private async askFallback(state: JevState, questions: readonly JevQuestion[], opts: JevAskOptions, reason: string): Promise<JevResult> {
    this.opts.onFallback?.({ purpose: opts.purpose, reason, breaker: this.breaker.state });
    const result = await this.fallback.ask(state, questions, opts);
    return { ...result, judge: result.judge ?? this.fallbackJudge };
  }
}

/* ---------------------------------------------------------------------------
   The routed client.
   --------------------------------------------------------------------------- */

export interface CreateJevClientOptions extends Partial<HttpJevClientOptions> {
  /** A resolved routing table; when given, `source` is not read for routing. */
  routing?: RoutingTable;
  /** Where the routing variables and the LiteLLM key come from (process.env by default). */
  source?: NodeJS.ProcessEnv;
  /** The Qwen judge's ChatProvider (default: the process's, chatProviderFor). */
  chatProvider?: ChatProvider;
  /** Options for the Qwen judge (timeout, max tokens, clock). */
  qwen?: Pick<QwenJudgeClientOptions, "budgetMs" | "maxTokens" | "now">;
  breaker?: CircuitBreakerOptions;
  onFallback?: (info: JudgeFallbackInfo) => void;
}

/** HttpJevClient when a key is present (the option, else env: JEV_API_KEY,
 * else JEV_KEY_FILE), else NullJevClient. Base URL, model and budget default
 * to FORAY_JEV_BASE_URL, FORAY_JEV_MODEL and FORAY_JEV_BUDGET_MS, then to
 * this file's constants. */
function createHttpOrNull(opts: Partial<HttpJevClientOptions>): JevClient {
  const apiKey = opts.apiKey ?? env.jevApiKey;
  if (!nonEmpty(apiKey)) return new NullJevClient();
  return new HttpJevClient({
    ...opts,
    apiKey,
    baseUrl: opts.baseUrl ?? env.jevBaseUrl ?? JEV_DEFAULT_BASE_URL,
    model: opts.model ?? env.jevModel ?? JEV_PINNED_MODEL,
    budgetMs: opts.budgetMs ?? env.jevBudgetMs
  });
}

/** The Qwen judge on `lane`, with that lane's structured-output mode,
 * logprobs flag and concurrency. */
function createQwenJudge(routing: RoutingTable, lane: NonNullable<StageRoute["lane"]>, model: string, opts: CreateJevClientOptions): QwenJudgeClient {
  const profile = routing.profiles[lane];
  return new QwenJudgeClient({
    provider: opts.chatProvider ?? chatProviderFor(routing, opts.source ?? process.env),
    model,
    lane,
    structuredOutput: profile.structuredOutput,
    logprobs: profile.logprobs,
    maxConcurrent: profile.maxConcurrent,
    ...opts.qwen
  });
}

/**
 * The judge generation uses, chosen by the routing table's 'judge' route
 * (see the module comment). Throws RoutingConfigError (naming the variable,
 * never its value) for a malformed FORAY_STAGE_JUDGE or a local route
 * without FORAY_LLM_BASE_URL. An `apiKey` option counts as a Jev key when
 * the route is resolved here.
 */
export function createJevClient(opts: CreateJevClientOptions = {}): JevClient {
  const { routing: given, source = process.env, chatProvider: _provider, qwen: _qwen, breaker: _breaker, onFallback: _onFallback, ...httpOpts } = opts;
  void [_provider, _qwen, _breaker, _onFallback];
  const keyed = nonEmpty(opts.apiKey) && readString("JEV_API_KEY", source) === undefined ? { ...source, JEV_API_KEY: opts.apiKey } : source;
  const routing = given ?? resolveRouting(keyed);
  const route = routing.routes.judge;
  /* Fail-closed: no route, or 'none', is a judge that never passes anything. */
  if (route === undefined || route.provider === "none") return new NullJevClient();
  if (route.provider === "local" && route.lane !== undefined) return createQwenJudge(routing, route.lane, route.model, opts);
  if (route.provider !== "jev") return new NullJevClient();
  const jev = createHttpOrNull(httpOpts);
  if (route.fallback === undefined) return jev;
  const qwen = createQwenJudge(routing, route.fallback.lane, route.fallback.model, opts);
  /* No Jev key: Jev can never answer, so the Qwen judge answers alone. */
  if (jev instanceof NullJevClient) return qwen;
  return new FallbackJudgeClient(jev, qwen, {
    ...(opts.breaker ? { breaker: opts.breaker } : {}),
    ...(opts.onFallback ? { onFallback: opts.onFallback } : {})
  });
}

/* ---------------------------------------------------------------------------
   Metering and pooling.
   --------------------------------------------------------------------------- */

/** Characters Jev reads for one ask (the state and the questions as sent). */
export function jevInputChars(state: JevState, questions: readonly JevQuestion[]): number {
  try {
    return JSON.stringify({ state, questions }).length;
  } catch {
    return 0;
  }
}

/** The estimate the budget guard is charged before an ask: input characters
 * / 4 tokens at $0.042 per million input tokens. */
export function estimateJevUsd(state: JevState, questions: readonly JevQuestion[]): number {
  return (jevInputChars(state, questions) / 4) * JEV_INPUT_USD_PER_TOKEN;
}

export interface MeteredJevClientOptions {
  guard: BudgetGuard;
  userId: string;
  /** The Foray's generation session, so the per-Foray cap applies. */
  sessionId?: string;
  /** The model named on the cost event (defaults to FORAY_JEV_MODEL, then the pinned model). */
  model?: string;
  /** Called after every ask that ran (R1-14 per-call records, R1-19 Jev-call
   * caps), tagged with the judge that answered (GV-47). */
  onCall?: (info: JevCallInfo) => void;
}

/**
 * Meters every ask through BudgetGuard.checkAndRecord (provider 'jev',
 * operation = purpose) BEFORE it is sent, so every judged call site is
 * metered in one place. A budget stop (BudgetExceededError,
 * EpisodeBudgetExceededError) propagates like every other model call's and
 * the ask is not sent; a transport failure never throws. An ask on a
 * NullJevClient sends nothing, so it is not charged.
 */
export function meteredJevClient(client: JevClient, opts: MeteredJevClientOptions): JevClient {
  const model = opts.model ?? env.jevModel ?? JEV_PINNED_MODEL;
  /* GV-47: an ask is charged to the judge it goes to first. The Qwen judge
     (routed alone, or behind an open breaker) runs on a local lane: one $0
     event on that lane, never a Jev charge. */
  const localJudge = (): QwenJudgeClient | null => {
    if (client instanceof QwenJudgeClient) return client;
    if (client instanceof FallbackJudgeClient && client.nextJudge() !== "jev" && client.fallback instanceof QwenJudgeClient) return client.fallback;
    return null;
  };
  return {
    async ask(state, questions, askOpts) {
      if (!(client instanceof NullJevClient)) {
        const local = localJudge();
        await opts.guard.checkAndRecord({
          userId: opts.userId,
          provider: local ? local.providerName : "jev",
          model: local ? local.model : model,
          operation: askOpts.purpose,
          tokensInput: Math.ceil(jevInputChars(state, questions) / 4),
          estimatedUsd: local ? 0 : estimateJevUsd(state, questions),
          ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {})
        });
      }
      const result = await client.ask(state, questions, askOpts);
      opts.onCall?.({
        purpose: askOpts.purpose,
        ok: result.ok,
        category: result.ok ? null : result.error.category,
        latencyMs: result.latencyMs,
        usage: result.ok ? result.usage : null,
        requestId: result.ok ? result.requestId : null,
        judge: result.judge ?? "jev"
      });
      return result;
    }
  };
}

export interface JevPool extends JevClient {
  /** Asks running now. */
  readonly inFlight: number;
  /** Asks waiting for a slot. */
  readonly queued: number;
}

/**
 * A semaphore over `client`: at most `maxInFlight` asks run at once, the rest
 * wait in arrival order, so a caller can fan out a Promise.all safely. An ask
 * whose signal aborts while it waits leaves the queue and returns
 * {ok:false, timeout, 'aborted'} without being sent.
 */
export function createJevPool(client: JevClient, opts: { maxInFlight?: number } = {}): JevPool {
  const max = opts.maxInFlight ?? DEFAULT_JEV_POOL_SIZE;
  if (!(Number.isInteger(max) && max > 0)) throw new Error("createJevPool: maxInFlight must be a positive integer");
  let running = 0;
  const waiters: Array<() => void> = [];

  /** Resolves true once the caller holds a slot, false if it gave up waiting. */
  const acquire = (signal: AbortSignal | undefined): Promise<boolean> => {
    if (running < max) {
      running += 1;
      return Promise.resolve(true);
    }
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const onAbort = (): void => {
        const at = waiters.indexOf(wake);
        if (at >= 0) waiters.splice(at, 1);
        resolve(false);
      };
      /* A released slot is handed straight to the next waiter: `running`
         does not change. */
      const wake = (): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve(true);
      };
      waiters.push(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  const release = (): void => {
    const next = waiters.shift();
    if (next) next();
    else running -= 1;
  };

  return {
    get inFlight() {
      return running;
    },
    get queued() {
      return waiters.length;
    },
    async ask(state, questions, askOpts) {
      if (!(await acquire(askOpts.signal))) {
        return { ok: false, error: { category: "timeout", reason: "aborted" }, latencyMs: 0 };
      }
      try {
        return await client.ask(state, questions, askOpts);
      } finally {
        release();
      }
    }
  };
}
