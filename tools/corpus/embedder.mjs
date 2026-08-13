/* The embedding-runtime BOUNDARY. Everything on this side of it is plain
 * JavaScript with no native dependencies; everything on the other side
 * (`embed/runtime.mjs`) is ~250MB of onnxruntime that most callers never
 * install.
 *
 * The contract this file exists to enforce: **absence of the runtime is a
 * normal, handled state, not an error.** `corpus search` with no --mode, the
 * whole test suite, and every checkout that only ever wanted keyword search
 * must work with `embed/node_modules` missing entirely. So the import is
 * dynamic, the failure is a typed error with install instructions, and
 * callers that can degrade (search, eval) catch it and say so in one line.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EMBED_DIR = path.join(HERE, "embed");
const RUNTIME_PKG = path.join(EMBED_DIR, "node_modules", "@huggingface", "transformers");

/* Weights are DATA. They live beside the corpus and the archives in
 * data-local/ (gitignored, machine-local, never committed) — not in
 * node_modules, where transformers.js would put them by default, where
 * .gitignore review cannot see them, and where a clean install throws them
 * away. */
export const MODELS_DIR = path.resolve(HERE, "..", "..", "data-local", "models");

/**
 * The model this corpus is embedded with.
 *
 * `Xenova/bge-small-en-v1.5` — 384 dimensions, q8 ONNX, MIT licensed, ~34MB
 * on disk. Runs on CPU in Node with no API key, no account and no per-token
 * cost, which is the only shape of embedding that fits this repo's keyless
 * posture (decision-authority item 3). CLS pooling, because that is how the
 * BGE models were trained; mean-pooling them quietly produces a worse space.
 *
 * THE PREFIX ASYMMETRY IS THE PART THAT GETS SILENTLY WRONG. BGE was trained
 * with an instruction prefix on QUERIES and nothing on passages. The empty
 * `passage_prefix` below is a deliberate value, not an unfilled blank. Both
 * strings are written into `embedding_models` and read back from there by the
 * retriever, so the convention lives with the model rather than in whichever
 * caller happens to run next.
 */
export const BGE_SMALL_EN_V15 = Object.freeze({
  name: "Xenova/bge-small-en-v1.5",
  revision: "main",
  dim: 384,
  pooling: "cls",
  normalized: 1,
  quantization: "q8",
  query_prefix: "Represent this sentence for searching relevant passages: ",
  passage_prefix: "",
  /* The model's own hard limit. Input past this is TRUNCATED, silently — the
   * tail of an over-long chunk simply does not exist as far as the vector is
   * concerned. This is why the backfill measures real token lengths before it
   * embeds anything. */
  maxTokens: 512,
});

/* Chunk sizing for the embedding pass, in REAL tokens. 400 leaves ~110 tokens
 * of headroom under bge's 512 limit for the source title + heading path the
 * encoder prepends, plus the two special tokens — measured, not guessed. The
 * min keeps the same 1:4 min:max ratio the chars/4 profile used, so a heading
 * still cannot orphan two sentences into a chunk of their own. */
export const EMBED_CHUNK_MAX = 400;
export const EMBED_CHUNK_MIN = 100;

export class EmbeddingRuntimeUnavailable extends Error {
  constructor(detail = "") {
    super(
      `the embedding runtime is not installed${detail ? ` (${detail})` : ""}.\n` +
      `It is deliberately separate from the base corpus tooling — 373MB installed (measured),\n` +
      `mostly onnxruntime-node, in a directory that otherwise has zero native dependencies.\n` +
      `Keyword search does not need it, and is the default.\n` +
      `To install it:  cd tools/corpus/embed && npm install`
    );
    this.name = "EmbeddingRuntimeUnavailable";
    this.code = "EMBEDDING_RUNTIME_UNAVAILABLE";
  }
}

/** Is the quarantined runtime installed on this machine? Cheap, no import. */
export function runtimeInstalled() {
  return fs.existsSync(RUNTIME_PKG);
}

/** Are this model's weights already on disk (i.e. can we run offline)? */
export function weightsCached(model = BGE_SMALL_EN_V15, modelsDir = MODELS_DIR) {
  return fs.existsSync(path.join(modelsDir, model.name));
}

/**
 * Build an embedder. Throws `EmbeddingRuntimeUnavailable` — never a raw
 * module-resolution error — when the runtime is absent.
 *
 * `allowRemote` defaults to "only if these weights are not already cached",
 * so the first run downloads once and every run after it is offline and
 * reproducible. Pass `allowRemote: false` explicitly to make a missing cache
 * a hard failure instead of a download.
 */
export async function createEmbedder({
  model = BGE_SMALL_EN_V15,
  modelsDir = MODELS_DIR,
  allowRemote = null,
  batchSize = 16,
} = {}) {
  if (!runtimeInstalled()) throw new EmbeddingRuntimeUnavailable(`${path.relative(process.cwd(), RUNTIME_PKG)} not found`);

  let runtime;
  try {
    const mod = await import(new URL("./embed/runtime.mjs", import.meta.url).href);
    runtime = await mod.createRuntime({
      model,
      cacheDir: modelsDir,
      allowRemote: allowRemote === null ? !weightsCached(model, modelsDir) : Boolean(allowRemote),
    });
  } catch (err) {
    /* A module-resolution failure here means a half-installed runtime — same
     * user-visible situation as no runtime, so it gets the same typed error
     * rather than a stack trace about a package nobody asked for. */
    if (err?.code === "ERR_MODULE_NOT_FOUND") throw new EmbeddingRuntimeUnavailable(err.message);
    throw err;
  }

  /** Encode strings VERBATIM, in batches. No prefix is added here — prefixing
   *  is the registry's job, applied by whoever read the model row (see
   *  search.mjs and backfill.mjs), so there is exactly one place that decides
   *  which side of the asymmetry a given string is on. */
  const encode = async (texts) => {
    const out = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      out.push(...(await runtime.encode(texts.slice(i, i + batchSize))));
    }
    return out;
  };

  return {
    model,
    encode,

    /** Encode passages that have ALREADY had the registry's passage prefix
     *  applied by the caller. Kept as a named method so `backfill` reads as
     *  what it is. */
    embedPassages: encode,

    /** True token count under this model's own tokenizer. */
    countTokens: (text) => runtime.countTokens(text),
  };
}
