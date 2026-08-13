/* THE ONLY FILE IN THIS REPO THAT IMPORTS AN EMBEDDING RUNTIME.
 *
 * `@huggingface/transformers` pulls in `onnxruntime-node`: ~250MB of native
 * binaries, in a directory (`tools/corpus/`) that has advertised zero native
 * dependencies since it was built. Quarantining it here — behind its own
 * package.json, imported only via a dynamic import in `../embedder.mjs` —
 * is what lets three things stay true:
 *
 *   1. `cd tools/corpus && npm ci` (exactly what CI runs) never installs it.
 *   2. The whole fixture-only test suite runs without it, using a stub.
 *   3. `corpus search --mode keyword` works on a checkout that has never
 *      heard of onnxruntime, and `--mode hybrid` degrades to keyword with a
 *      notice rather than failing.
 *
 * If you find yourself importing this file from anywhere but `embedder.mjs`,
 * that isolation has been broken.
 */

import { env, pipeline, AutoTokenizer } from "@huggingface/transformers";

/**
 * Configure the library's global environment. This is process-global state in
 * transformers.js, so it is set once, explicitly, in one place.
 *
 * `cacheDir` is set EXPLICITLY on purpose. Left alone, transformers.js caches
 * weights inside its own `node_modules`, where they are invisible to
 * .gitignore review, survive nothing, and get re-downloaded on every clean
 * install. Model weights are data, so they belong in `data-local/` with the
 * corpus and the archives — gitignored, machine-local, never committed.
 */
function configureEnv({ cacheDir, allowRemote }) {
  env.cacheDir = cacheDir;
  env.localModelPath = cacheDir;
  env.allowLocalModels = true;
  /* Once the weights are on disk, remote access is switched OFF: a retrieval
   * run that silently re-downloads (or silently picks up an upstream change
   * to a moving revision) is not reproducible. The first run is the only one
   * allowed to touch the network. */
  env.allowRemoteModels = allowRemote;
}

/**
 * @param {{name:string, revision:string, quantization:string, pooling:string}} model
 * @returns {Promise<{extractor, tokenizer}>}
 */
export async function createRuntime({ model, cacheDir, allowRemote }) {
  configureEnv({ cacheDir, allowRemote });

  /* `dtype` MUST be explicit. On Node/CPU the default is fp32, which is ~4x
   * the download and materially slower for no measurable retrieval gain at
   * this corpus's size — and it would silently produce a different vector
   * space than the one the registry says is stored. */
  const extractor = await pipeline("feature-extraction", model.name, {
    dtype: model.quantization,
    revision: model.revision,
  });

  const tokenizer = await AutoTokenizer.from_pretrained(model.name, {
    revision: model.revision,
  });

  return {
    /**
     * Encode a batch of already-prefixed strings.
     * `normalize: false` because normalization happens exactly once, at the
     * write, in vectors.mjs — where a zero vector can also be caught and
     * refused instead of stored as invisible-to-search.
     */
    async encode(texts) {
      const out = await extractor(texts, { pooling: model.pooling, normalize: false });
      const [rows, dim] = out.dims;
      const flat = out.data;
      const vectors = [];
      for (let r = 0; r < rows; r++) vectors.push(Float32Array.from(flat.subarray(r * dim, (r + 1) * dim)));
      return vectors;
    },

    /** True token count under THIS model's tokenizer — the only honest one. */
    countTokens(text) {
      return tokenizer.encode(text).length;
    },

    /** Token count with truncation applied, i.e. what the model would see. */
    truncatedLength(text, maxLength) {
      return tokenizer(text, { truncation: true, max_length: maxLength }).input_ids.dims.at(-1);
    },
  };
}
