/* A minimal OpenAI-compatible chat client for the dossier tools (GV-65,
 * W3-20, docs/roadmap/generation-v2.md).
 *
 * It talks to LiteLLM on the Spark (or any OpenAI-compatible server) and to
 * nothing else: one POST to `${FORAY_LLM_BASE_URL}/v1/chat/completions` with
 * `Authorization: Bearer <key>`, built on Node's global fetch (no SDK, no new
 * dependency in this package).
 *
 * Configuration is the SAME set of variables the backend reads (decision 38;
 * backend/src/config/stageRouting.ts resolveLlmApiKey), so the one Foray key
 * on #1163 is placed once:
 *   FORAY_LLM_BASE_URL       the LiteLLM origin, e.g. http://192.168.0.72:4000
 *   FORAY_LLM_API_KEY        the key, or
 *   FORAY_LLM_API_KEY_FILE   a file holding it (trimmed)
 * The only variable of the tool's own is the model alias:
 *   FORAY_DOSSIER_MODEL      default 'local-worker' (the P40 lane, overnight)
 *
 * What one complete() does, mirroring backend/src/generation/chat/
 * openAICompatProvider.ts so the two stay aligned:
 *   - sends `response_format: {type:'json_schema', json_schema:{name, schema,
 *     strict:true}}` and `chat_template_kwargs: {enable_thinking:false}`.
 *     Lane A2 runs SGLang with --reasoning-parser qwen3, and LiteLLM's
 *     drop_params can drop an unsupported param silently, so the caller still
 *     validates the reply itself (qwen-select.mjs does);
 *   - reads choices[0].message.content; `reasoning_content` is ignored;
 *   - times out with an AbortController; NO retries (a rerun of the CLI is
 *     the retry, and it is resumable per node);
 *   - every failure is an LlmError with a fixed reason ('http_<status>',
 *     'timeout', 'network', 'malformed_json', 'malformed_choice',
 *     'truncated'). The key goes in the Authorization header and nowhere else:
 *     never into the body, an error message or a log line, and the upstream
 *     error body is never read into a message.
 */

import fs from "node:fs";

export const BASE_URL_ENV = "FORAY_LLM_BASE_URL";
export const API_KEY_ENV = "FORAY_LLM_API_KEY";
export const API_KEY_FILE_ENV = "FORAY_LLM_API_KEY_FILE";
export const MODEL_ENV = "FORAY_DOSSIER_MODEL";
export const DEFAULT_MODEL = "local-worker";
/** The P40 lane is slow on a ~12k-token prompt and can stall on an XID
    fault, so the default is generous; the CLI takes --timeout-ms. */
export const DEFAULT_TIMEOUT_MS = 600_000;

export class LlmError extends Error {
  constructor(reason, { status = null } = {}) {
    super(reason);
    this.name = "LlmError";
    this.reason = reason;
    this.status = status;
  }
}

/** Config problems name the variable, never its value. */
export class LlmConfigError extends Error {
  constructor(variable, message) {
    super(message);
    this.name = "LlmConfigError";
    this.variable = variable;
  }
}

const readString = (env, name) => {
  const v = env[name];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};

/** FORAY_LLM_API_KEY, else the trimmed contents of FORAY_LLM_API_KEY_FILE,
    else undefined (same precedence as the backend's resolveLlmApiKey). */
export function resolveApiKey(env = process.env, readFile = (p) => fs.readFileSync(p, "utf8")) {
  const direct = readString(env, API_KEY_ENV);
  if (direct !== undefined) return direct;
  const file = readString(env, API_KEY_FILE_ENV);
  if (file === undefined) return undefined;
  let text;
  try {
    text = readFile(file);
  } catch {
    throw new LlmConfigError(API_KEY_FILE_ENV, `${API_KEY_FILE_ENV} is set but the file could not be read`);
  }
  const key = String(text).trim();
  if (!key) throw new LlmConfigError(API_KEY_FILE_ENV, `${API_KEY_FILE_ENV} names an empty file`);
  return key;
}

/** {baseUrl, apiKey, model} from the environment; throws LlmConfigError
    naming the missing variable. */
export function llmConfig(env = process.env, { readFile } = {}) {
  const baseUrl = readString(env, BASE_URL_ENV);
  if (!baseUrl) throw new LlmConfigError(BASE_URL_ENV, `${BASE_URL_ENV} is not set (the LiteLLM origin, e.g. http://<spark>:4000)`);
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocol");
  } catch {
    throw new LlmConfigError(BASE_URL_ENV, `${BASE_URL_ENV} is not an http(s) URL`);
  }
  const apiKey = resolveApiKey(env, readFile);
  if (!apiKey) throw new LlmConfigError(API_KEY_ENV, `${API_KEY_ENV} or ${API_KEY_FILE_ENV} must be set (the Foray LiteLLM virtual key)`);
  return { baseUrl, apiKey, model: readString(env, MODEL_ENV) ?? DEFAULT_MODEL };
}

/** `${baseUrl}/v1/chat/completions`, trailing slashes trimmed. */
export const chatCompletionsUrl = (baseUrl) => `${String(baseUrl).trim().replace(/\/+$/, "")}/v1/chat/completions`;

/** The request body for one structured-output call. */
export function buildRequestBody({ model, messages, schema, schemaName, maxTokens, temperature = 0 }) {
  return {
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: maxTokens,
    temperature,
    response_format: { type: "json_schema", json_schema: { name: schemaName, schema, strict: true } },
    chat_template_kwargs: { enable_thinking: false },
  };
}

/**
 * createChatClient({baseUrl, apiKey, model, fetchImpl, timeoutMs}).complete(
 *   {messages, schema, schemaName, maxTokens}) ->
 *   {content, model, finishReason, usage, ms}
 * `content` is the raw reply string; the caller parses and validates it.
 */
export function createChatClient({ baseUrl, apiKey, model, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, now = () => Date.now() }) {
  if (!baseUrl) throw new LlmConfigError(BASE_URL_ENV, `${BASE_URL_ENV} is required`);
  if (!apiKey) throw new LlmConfigError(API_KEY_ENV, `${API_KEY_ENV} is required`);
  const url = chatCompletionsUrl(baseUrl);
  return {
    model,
    url,
    async complete({ messages, schema, schemaName, maxTokens }) {
      const body = buildRequestBody({ model, messages, schema, schemaName, maxTokens });
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const t0 = now();
      let res;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch {
        throw new LlmError(ctrl.signal.aborted ? "timeout" : "network");
      } finally {
        clearTimeout(timer);
      }
      if (!res || typeof res.status !== "number" || res.status < 200 || res.status >= 300) {
        const status = res?.status ?? 0;
        throw new LlmError(`http_${status}`, { status });
      }
      let json;
      try {
        json = JSON.parse(await res.text());
      } catch {
        throw new LlmError("malformed_json");
      }
      const choice = Array.isArray(json?.choices) ? json.choices[0] : undefined;
      const content = choice?.message?.content;
      if (typeof content !== "string") throw new LlmError("malformed_choice");
      // A reply cut at max_tokens is half a JSON object: refuse it here so the
      // caller keeps the code-built dossier.
      if (choice.finish_reason === "length") throw new LlmError("truncated");
      return {
        content,
        model: typeof json.model === "string" && json.model ? json.model : model,
        finishReason: choice.finish_reason ?? null,
        usage: json.usage ?? null,
        ms: now() - t0,
      };
    },
  };
}
