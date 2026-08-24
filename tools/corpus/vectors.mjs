/* Vector serialization: Float32Array <-> BLOB, and the L2 normalization that
 * makes cosine similarity a plain dot product.
 *
 * THE FORMAT IS DELIBERATELY DUMB: bare little-endian float32, no header, no
 * length prefix, no magic bytes. The element count is byteLength/4. That is
 * exactly sqlite-vec's on-disk convention, so if this corpus ever outgrows a
 * brute-force scan, `vec0` becomes a virtual table over THESE SAME BYTES
 * rather than a migration that re-encodes 558 vectors. A header would have
 * bought a self-describing dimension we already store — in
 * `embedding_models.dim`, enforced by a trigger — at the cost of that
 * compatibility.
 *
 * THE ALIGNMENT HAZARD, which is the whole reason this file exists rather
 * than two inline expressions. A `Uint8Array` may be a VIEW into a larger
 * buffer at an arbitrary byteOffset, and the obvious
 * `new Float32Array(u8.buffer, u8.byteOffset, n)` throws
 * "start offset of Float32Array should be a multiple of 4" whenever that
 * offset is not a multiple of 4. Measured on Node 24, `node:sqlite` happens
 * to return each BLOB as its own array at byteOffset 0, so the bad case is
 * not reachable today — but that is an observed implementation detail, not a
 * documented guarantee, and it would fail per-ROW rather than per-code-path
 * if it ever changed, which is the kind of bug that never shows up in a small
 * test. So `readVectorInto` checks the alignment and falls back to a DataView
 * copy, and callers do not get to hand-roll the fast path.
 */

/* Endianness is a property of the machine, not of the format. Everything we
 * run on is little-endian, but "everything is LE" written as an unchecked
 * assumption is how a file format silently becomes machine-specific. */
export const HOST_IS_LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

export const BYTES_PER_FLOAT = 4;

/** Element count a blob of this byte length encodes. */
export function vectorLength(blob) {
  if (blob.byteLength % BYTES_PER_FLOAT !== 0) {
    throw new Error(`vector blob length ${blob.byteLength} is not a multiple of ${BYTES_PER_FLOAT}`);
  }
  return blob.byteLength / BYTES_PER_FLOAT;
}

/**
 * L2-normalize in place and return the same array.
 *
 * Normalizing AT WRITE TIME (not at query time) is what lets similarity be a
 * bare dot product over a flat matrix — no per-row magnitude lookup, no
 * division in the inner loop.
 *
 * A zero or non-finite vector THROWS rather than being stored. It cannot be
 * normalized, and stored as-is it would score 0 (or NaN) against every query
 * forever — a chunk that is silently invisible to search. A model that
 * returns one has failed, and failing loudly at the write is the only moment
 * anyone will notice.
 */
export function l2Normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i];
    if (!Number.isFinite(v)) throw new Error(`vector contains a non-finite value at index ${i}: ${v}`);
    sum += v * v;
  }
  const norm = Math.sqrt(sum);
  if (!(norm > 0)) throw new Error("cannot L2-normalize a zero vector");
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

/** Copy `values` into a fresh Float32Array (accepts arrays or typed arrays). */
export function toFloat32(values) {
  return values instanceof Float32Array ? Float32Array.from(values) : Float32Array.from(values, Number);
}

/**
 * Float32Array -> BLOB bytes, ALWAYS normalized.
 *
 * There is deliberately no opt-out. Nothing downstream re-checks a vector's
 * magnitude — the DB trigger asserts byte length, not unit length — so an
 * un-normalized vector would be stored, scored against with a plain dot
 * product, and quietly rank wrong forever. Normalizing here is also the only
 * place the non-finite check runs, so an escape hatch would be a hole in it.
 */
export function toBlob(values) {
  const f32 = l2Normalize(toFloat32(values));
  if (HOST_IS_LE) return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength).slice();
  const out = new Uint8Array(f32.length * BYTES_PER_FLOAT);
  const view = new DataView(out.buffer);
  for (let i = 0; i < f32.length; i++) view.setFloat32(i * BYTES_PER_FLOAT, f32[i], true);
  return out;
}

/**
 * Decode `blob` into `out` at element index `offset`. Returns the element
 * count written. The out-parameter shape is the point: the backfill loads
 * hundreds of vectors into ONE pre-allocated flat matrix, so the scan is a
 * single contiguous walk instead of N little heap objects.
 */
export function readVectorInto(blob, out, offset = 0) {
  const n = vectorLength(blob);
  if (offset + n > out.length) {
    throw new Error(`vector of ${n} floats does not fit at offset ${offset} in a matrix of ${out.length}`);
  }
  /* Fast path only when the host is LE AND the blob happens to start on a
   * 4-byte boundary. Both conditions are checked, never assumed. */
  if (HOST_IS_LE && blob.byteOffset % BYTES_PER_FLOAT === 0) {
    out.set(new Float32Array(blob.buffer, blob.byteOffset, n), offset);
    return n;
  }
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  for (let i = 0; i < n; i++) out[offset + i] = view.getFloat32(i * BYTES_PER_FLOAT, true);
  return n;
}

/** BLOB -> a standalone Float32Array. Convenience over readVectorInto. */
export function fromBlob(blob) {
  const out = new Float32Array(vectorLength(blob));
  readVectorInto(blob, out);
  return out;
}

/**
 * Dot product of `query` against row `row` of a flat `matrix` of `dim`-wide
 * vectors. Both sides are L2-normalized, so this IS cosine similarity —
 * writing it as cosine (with two magnitudes recomputed per row) would be the
 * same number at several times the cost.
 */
export function dotAt(query, matrix, row, dim) {
  let s = 0;
  const base = row * dim;
  for (let i = 0; i < dim; i++) s += query[i] * matrix[base + i];
  return s;
}

/**
 * Top-k rows of `matrix` by similarity to `query`, as
 * `[{index, score}, …]` sorted descending.
 *
 * Brute force over every row, on purpose. At this corpus's size (hundreds of
 * 384-dim vectors) a full scan is well under a millisecond and is exactly
 * right; an ANN index here would be a second thing to keep in sync with
 * `chunks` for no measurable gain. When the scan stops being instant, the
 * blob format above is already sqlite-vec-compatible.
 */
export function topK(query, matrix, dim, k) {
  const rows = matrix.length / dim;
  const scored = new Array(rows);
  for (let r = 0; r < rows; r++) scored[r] = { index: r, score: dotAt(query, matrix, r, dim) };
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, k));
}
