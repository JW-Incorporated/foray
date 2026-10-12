/* GV-28 (W3-07, docs/roadmap/generation-v2.md): the Embedder interface the
 * passage store embeds with, and its three implementations.
 *
 * An Embedder is
 *   { model, embed(texts) -> Promise<Float32Array[]>, countTokens?(text) -> number }
 * where `model` is the registry spec (name, revision, dim, pooling,
 * normalized, query_prefix, passage_prefix) the store registers before it
 * writes a vector. `embed` encodes strings VERBATIM: the store prepends the
 * model row's passage_prefix or query_prefix, so the prefix convention lives
 * with the model row and nowhere else. `countTokens` is present only when the
 * embedder has a real tokenizer; without it the store splits by chars/4.
 *
 * - 'stub': deterministic word hashing into 64 dims, for tests. No model.
 * - 'transformers': tools/corpus/embedder.mjs createEmbedder (bge-small q8 on
 *   CPU). An opt-in runtime of about 373 MB, installed in tools/corpus/embed;
 *   absent, it throws that module's EmbeddingRuntimeUnavailable.
 * - 'openai': an OpenAI-compatible embeddings endpoint (LiteLLM or any local
 *   server): POST ${FORAY_EMBED_URL}/v1/embeddings with FORAY_EMBED_MODEL and
 *   bearer FORAY_EMBED_KEY. FORAY_EMBED_DIM is required, and every returned
 *   vector of another length is refused.
 *
 * No Anthropic model and no relay: the providers here are local or
 * OpenAI-compatible only (docs/roadmap/generation-v2.md, Constraints). */

import { BGE_SMALL_EN_V15, createEmbedder as createCorpusEmbedder } from "../corpus/embedder.mjs";

export const EMBEDDER_KINDS = Object.freeze(["stub", "transformers", "openai"]);

export const STUB_DIM = 64;

/** The stub's word rule: runs of letters and digits, lowercased. */
const WORD = /[\p{L}\p{N}]+/gu;

/** 32-bit FNV-1a: a fixed hash so the stub's vectors never change. */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The stub's vector: each word adds 1 to bucket fnv1a(word) % dim, so texts
 * sharing words point the same way. A text with no word gets bucket 0, so no
 * vector is ever zero (the store refuses to normalize a zero vector). */
export function stubVector(text, dim = STUB_DIM) {
  const v = new Float32Array(dim);
  const words = String(text).toLowerCase().match(WORD) ?? [];
  for (const w of words) v[fnv1a(w) % dim] += 1;
  if (words.length === 0) v[0] = 1;
  return v;
}

function stubEmbedder({ dim = STUB_DIM, tokenizer = false, queryPrefix = "", passagePrefix = "", revision = "1" } = {}) {
  const embedder = {
    model: Object.freeze({
      name: "stub-hash",
      revision: String(revision),
      dim,
      pooling: "mean",
      normalized: 1,
      query_prefix: queryPrefix,
      passage_prefix: passagePrefix,
    }),
    embed: async (texts) => texts.map((t) => stubVector(t, dim)),
  };
  /* A word-count "tokenizer", only when asked for: it lets a test take the
     real-tokenizer path of the splitter with no model. */
  if (tokenizer) embedder.countTokens = (s) => (String(s).match(/\S+/g) ?? []).length;
  return embedder;
}

/** tools/corpus's registry spec has a `quantization` this store's model row
 * does not; a different quantization is a different vector space, so it is
 * folded into the revision. */
export function transformersSpec(model = BGE_SMALL_EN_V15) {
  return Object.freeze({
    name: model.name,
    revision: model.quantization ? `${model.revision}+${model.quantization}` : String(model.revision),
    dim: model.dim,
    pooling: model.pooling,
    normalized: model.normalized === false || model.normalized === 0 ? 0 : 1,
    query_prefix: model.query_prefix ?? "",
    passage_prefix: model.passage_prefix ?? "",
  });
}

async function transformersEmbedder({ model = BGE_SMALL_EN_V15, createEmbedder = createCorpusEmbedder, ...rest } = {}) {
  const inner = await createEmbedder({ model, ...rest });
  return {
    model: transformersSpec(model),
    embed: (texts) => inner.encode(texts),
    countTokens: (text) => inner.countTokens(text),
  };
}

/** The openai embedder's settings from the environment, checked. */
export function openAIEmbedConfig(env = process.env, overrides = {}) {
  const url = String(overrides.url ?? env.FORAY_EMBED_URL ?? "").trim().replace(/\/+$/, "");
  const model = String(overrides.model ?? env.FORAY_EMBED_MODEL ?? "").trim();
  const key = String(overrides.key ?? env.FORAY_EMBED_KEY ?? "").trim();
  const dimRaw = overrides.dim ?? env.FORAY_EMBED_DIM;
  const dim = Number(dimRaw);
  if (!url) throw new Error("FORAY_EMBED_URL is not set (the OpenAI-compatible server's base URL; /v1/embeddings is appended)");
  if (!model) throw new Error("FORAY_EMBED_MODEL is not set");
  if (!Number.isInteger(dim) || dim <= 0) throw new Error(`FORAY_EMBED_DIM must be a positive integer (the model's dimension), got ${JSON.stringify(dimRaw ?? null)}`);
  return {
    url,
    model,
    key,
    dim,
    revision: String(overrides.revision ?? env.FORAY_EMBED_REVISION ?? "main"),
    query_prefix: String(overrides.queryPrefix ?? env.FORAY_EMBED_QUERY_PREFIX ?? ""),
    passage_prefix: String(overrides.passagePrefix ?? env.FORAY_EMBED_PASSAGE_PREFIX ?? ""),
  };
}

function openAIEmbedder({ env = process.env, fetch: fetchImpl = globalThis.fetch, timeoutMs = 60000, ...overrides } = {}) {
  const cfg = openAIEmbedConfig(env, overrides);
  const endpoint = `${cfg.url}/v1/embeddings`;
  return {
    model: Object.freeze({
      name: cfg.model,
      revision: cfg.revision,
      dim: cfg.dim,
      /* The server pools; the store only needs a name for it. */
      pooling: "server",
      normalized: 1,
      query_prefix: cfg.query_prefix,
      passage_prefix: cfg.passage_prefix,
    }),
    async embed(texts) {
      if (texts.length === 0) return [];
      const headers = { "content-type": "application/json" };
      if (cfg.key) headers.authorization = `Bearer ${cfg.key}`;
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: cfg.model, input: texts, encoding_format: "float" }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`embeddings request failed: HTTP ${res.status}${detail ? ` ${detail.slice(0, 200)}` : ""}`);
      }
      const body = await res.json();
      const data = Array.isArray(body?.data) ? body.data : null;
      if (!data || data.length !== texts.length) {
        throw new Error(`embeddings response has ${data ? data.length : "no"} vectors for ${texts.length} inputs`);
      }
      const out = new Array(texts.length);
      data.forEach((d, i) => {
        const at = Number.isInteger(d?.index) ? d.index : i;
        if (at < 0 || at >= texts.length || out[at]) throw new Error(`embeddings response has a bad or repeated index ${d?.index}`);
        const e = d?.embedding;
        if (!Array.isArray(e)) throw new Error(`embeddings response item ${at} has no float embedding`);
        if (e.length !== cfg.dim) {
          throw new Error(`dimension mismatch: ${cfg.model} returned ${e.length} dims, FORAY_EMBED_DIM says ${cfg.dim}`);
        }
        out[at] = Float32Array.from(e, Number);
      });
      return out;
    },
  };
}

/**
 * Build an Embedder of `kind` ('stub' | 'transformers' | 'openai'). Async
 * because the transformers runtime loads asynchronously.
 */
export async function createPassageEmbedder({ kind, ...opts } = {}) {
  switch (kind) {
    case "stub":
      return stubEmbedder(opts);
    case "transformers":
      return transformersEmbedder(opts);
    case "openai":
      return openAIEmbedder(opts);
    default:
      throw new Error(`unknown embedder kind ${JSON.stringify(kind)}; expected one of ${EMBEDDER_KINDS.join(", ")}`);
  }
}
