/* The backfill: every chunk -> one vector, resumable, runtime-injected.
 *
 * The embedder is a parameter, not an import, so this whole file is tested
 * with a deterministic stub and never pulls onnxruntime into the base
 * tooling. See embedder.mjs for the boundary it sits behind.
 */

import { registerModel, chunksMissingEmbedding, currentChunks, embeddingInput, writeEmbeddings, embeddingCoverage } from "./embeddings.mjs";


export const DEFAULT_BATCH = 16;

/**
 * @param {object} db
 * @param {{model:object, embedPassages:(t:string[])=>Promise<Float32Array[]>, countTokens?:(s:string)=>number}} embedder
 * @param {object} [opts]
 * @param {boolean} [opts.force=false]  re-embed chunks that already have a vector
 * @param {number}  [opts.batch=16]
 * @param {(p:{done:number,total:number})=>void} [opts.onProgress]
 */
export async function backfill(db, embedder, { force = false, batch = DEFAULT_BATCH, onProgress } = {}) {
  const model = registerModel(db, embedder.model);

  /* Resumable by default: only chunks with no vector under THIS model. A
   * backfill that always redid everything would make a crash halfway through
   * a 558-chunk run cost the whole run, and would make `embed` unusable as
   * the "top up after an ingest" command it needs to be. */
  const todo = force ? currentChunks(db) : chunksMissingEmbedding(db, model.id);

  /* The model truncates silently at its input limit — the tail of an
   * over-long chunk simply is not in its vector, while `search` keeps
   * displaying the whole chunk. Count it and report it rather than let the
   * corpus be quietly 60% invisible (which is exactly what the pre-rechunk
   * measurement found). */
  const limit = embedder.model.maxTokens ?? null;
  const canMeasure = Boolean(limit && embedder.countTokens);
  /* null, not 0, when we could not measure: "no chunk is truncated" and
   * "nobody checked" must not print as the same reassuring zero. */
  let truncated = canMeasure ? 0 : null;

  const inputs = todo.map((c) => embeddingInput(c, model.passage_prefix));
  if (canMeasure) {
    for (const t of inputs) if (embedder.countTokens(t) > limit) truncated++;
  }

  let done = 0;
  for (let i = 0; i < todo.length; i += batch) {
    const slice = todo.slice(i, i + batch);
    const vectors = await embedder.embedPassages(inputs.slice(i, i + batch));
    if (vectors.length !== slice.length) {
      throw new Error(`embedder returned ${vectors.length} vectors for ${slice.length} chunks`);
    }
    for (const v of vectors) {
      if (v.length !== model.dim) {
        throw new Error(`embedder returned a ${v.length}-dim vector but model ${model.name} declares ${model.dim}`);
      }
    }
    /* Committed per batch, not once at the end: an interrupted run leaves the
     * batches it finished on disk, and the next run picks up from there. */
    writeEmbeddings(db, model.id, slice.map((c, j) => ({ chunkId: c.id, vector: vectors[j] })));
    done += slice.length;
    onProgress?.({ done, total: todo.length });
  }

  /* Derived from the coverage counts rather than by re-loading every chunk's
   * full text just to take its length. */
  const coverage = embeddingCoverage(db, model.id);
  return { model, embedded: done, skipped: coverage.chunks - todo.length, truncated, coverage };
}
