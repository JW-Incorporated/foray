/* Idempotence — a re-run must never re-bill for an unchanged script (#247 item 12).

   ── The rule, stated once ─────────────────────────────────────────────────

   A cache entry is keyed by a content hash of EVERYTHING that changes the
   bytes we would receive back. Nothing else. Concretely, the key covers:

     1. the billable script text, canonicalised by `billable.mjs`
     2. the voice id
     3. the model id
     4. the output format (bitrate/sample rate)
     5. the padding seconds baked around each item's audio (`padSecPerItem`)

   So an entry is INVALIDATED by exactly five things, and each one genuinely
   produces different audio:

     - **a script edit** — including a single character of punctuation, because
       punctuation is prosody to a TTS engine and is billed besides
     - **a voice change** — a different narrator reading the same words
     - **a model change** — a different engine reading the same words, and per
       `pricing.json` a different price per character
     - **an output-format change** — 64 kbps and 128 kbps are different files
     - **a padding change** — the leading/trailing silence is encoded directly
       into the audio bytes (`docs/narrator-pipeline.md` §1 item 4), so a
       different `padSecPerItem` is a different file even though the TTS
       provider is never told about it and it never appears in the request body

   And it is NOT invalidated by anything else, which is the half that saves
   money. Re-running the pipeline, re-ordering beats within a Foray, renaming a
   beat, re-titling the Foray, editing a `why` line, moving a script between
   Forays, or changing the estimate's chars-per-minute rate all leave every key
   untouched. **Beat identity is deliberately NOT in the key**: the same
   sentence voiced for two beats is one billable generation, and keying by beat
   would pay twice for one file.

   ── The two ways a cache like this leaks money, both closed here ──────────

   **Leak 1: canonicalisation drift.** If the key hashed the RAW text but the
   request submitted the canonicalised text, then re-saving a script file in an
   editor that flips LF to CRLF would change every key and re-bill the entire
   Foray, with no audible difference and nothing visible in a diff. Both the key
   and the payload therefore come from `billableText()`, so a line-ending change
   is a cache HIT. On a Windows-developed repo whose `.gitattributes` already
   records a CRLF incident, this is not hypothetical.

   **Leak 2: a key that omits an input that changes the audio.** Then a voice or
   model switch silently serves the OLD narrator from cache — the failure that
   costs nothing and ships the wrong product, which is worse. Hence
   `assertKeyInputsComplete`, which fails loudly if a caller invents a
   generation parameter this module does not know how to hash.

   ── What this file does NOT do ────────────────────────────────────────────

   It does not store audio. It records, per key, that a generation HAPPENED and
   what it cost. Audio bytes live wherever `docs/narrator-pipeline.md` §hosting
   says, which is deliberately not git. The index is small, text, diffable and
   safe to commit; the mp3s are none of those things.
*/

import { createHash } from "node:crypto";
import { billableText, countChars } from "./billable.mjs";

/** Every input that changes the bytes we get back, and therefore every input
    that belongs in the key. Order is fixed so the hash is stable.

    `padSecPerItem` is here alongside the four TTS-request inputs even though
    it never reaches `buildRequest()`'s HTTP body: `projection.mjs` and
    `docs/narrator-pipeline.md` §1 item 4 are explicit that the padding is
    ENCODED INTO THE AUDIO FILE (leading/trailing silence baked around the
    item), so a padding-value change produces different bytes exactly like a
    voice or model change does, even though the TTS provider is never told
    about it. Leaving it out of the key is Leak 2 from this file's header —
    "a key that omits an input that changes the audio" — and it is not
    hypothetical: `HUMAN-ACTIONS.md` #3 records the padding value as still
    undecided, so the first time it is set (or later revised), every existing
    cache entry would otherwise silently serve stale-padding audio under an
    unchanged key. */
export const KEY_INPUTS = Object.freeze(["text", "voiceId", "modelId", "outputFormat", "padSecPerItem"]);

/**
 * Guard against a caller passing a generation parameter that would change the
 * audio but that this module would silently drop out of the key.
 *
 * This is the expensive-mistake direction: an unhashed parameter means a
 * changed request serves a stale cache hit forever.
 *
 * @param {object} spec
 * @throws {Error} naming the unknown keys
 */
export function assertKeyInputsComplete(spec) {
  const unknown = Object.keys(spec ?? {}).filter((k) => !KEY_INPUTS.includes(k));
  if (unknown.length) {
    throw new Error(
      `cache key would ignore ${unknown.map((k) => `\`${k}\``).join(", ")}. ` +
      `If that parameter changes the audio, add it to KEY_INPUTS in tools/narrate/cache.mjs ` +
      `and accept that every existing entry is invalidated. If it does not change the audio, ` +
      `do not pass it to the cache.`
    );
  }
}

/**
 * The content hash. sha256 of the four inputs, newline-delimited with the field
 * name included so that two different fields cannot collide by swapping values.
 *
 * @param {object} spec
 * @param {string} spec.text          the script, raw; canonicalised in here
 * @param {string} spec.voiceId
 * @param {string} spec.modelId
 * @param {string} spec.outputFormat
 * @param {number} [spec.padSecPerItem] seconds of silence baked around the
 *   item's audio (leading + trailing). Part of the key because it is baked
 *   into the bytes, not merely a request parameter — see KEY_INPUTS' comment.
 * @returns {string} 64-char hex
 */
export function cacheKey(spec = {}) {
  assertKeyInputsComplete(spec);
  const h = createHash("sha256");
  /* LENGTH-PREFIXED, not newline-delimited. A newline delimiter stops being
     unambiguous the moment a value can CONTAIN that delimiter, and script text
     always can: it is multi-line by nature. The previous encoding joined each
     field name to its value with newlines, which meant a script whose body
     happened to contain a line reading exactly "voiceId" could hash identically
     to a different script carrying a crafted voice id. Neither is reachable with
     a real ElevenLabs voice id, but the entire job of this function is that two
     different requests cannot share a digest, and "unreachable in practice" is
     not that guarantee.

     Prefixing every value with its byte length makes the encoding injective: no
     value can impersonate a field boundary, whatever it contains. */
  const field = (name, value) => {
    const v = String(value ?? "");
    h.update(`${name}:${Buffer.byteLength(v, "utf8")}:${v}`);
  };
  // The TEXT is hashed canonicalised, so a line-ending or trailing-space change
  // is a hit rather than a re-bill. See "Leak 1" in the header.
  field("text", billableText(spec.text));
  for (const name of ["voiceId", "modelId", "outputFormat", "padSecPerItem"]) field(name, spec[name]);
  return h.digest("hex");
}

/**
 * An in-memory cache index. `load`/`dump` make it persistable as JSON by a
 * caller; this module deliberately does no file IO, so it stays testable and
 * so nothing here can write to the repo by accident.
 */
export class NarrationCache {
  /** @param {object} [index] a previously dumped index */
  constructor(index = {}) {
    this.entries = new Map(Object.entries(index?.entries ?? {}));
  }

  /** @returns {boolean} */
  has(key) { return this.entries.has(key); }

  /** @returns {object|null} the recorded entry */
  get(key) { return this.entries.get(key) ?? null; }

  /**
   * Decide, for one script, whether a generation would be billed.
   *
   * This is the function the whole file exists for: `billable: false` means a
   * re-run costs nothing.
   *
   * @param {object} spec  as `cacheKey`
   * @returns {{key: string, cached: boolean, billable: boolean, chars: number, billedChars: number}}
   */
  plan(spec) {
    const key = cacheKey(spec);
    const cached = this.has(key);
    const chars = countChars(spec.text);
    /* Deliberately PURE -- no hit/miss counters. It used to keep them and they
       were wrong: `plan()` is a query callers legitimately run more than once for
       the same beat (`synthesize()` re-runs it internally), so one beat and one
       generation counted as two misses. A cache-effectiveness number that
       double-counts is worse than none, and `planForay().totals.cachedBeats`
       already reports it correctly from a single pass. */
    return {
      key,
      cached,
      billable: !cached,
      chars,
      // The number that reaches an invoice. A hit bills nothing, which is the
      // entire point of the module.
      billedChars: cached ? 0 : chars,
    };
  }

  /**
   * Record that a generation happened. Called on a real synthesis, never on a
   * dry run — a dry run that wrote entries would make the NEXT run believe the
   * audio exists and skip it forever, which is the most damaging bug this
   * module could have.
   *
   * @param {string} key
   * @param {object} record
   */
  record(key, record = {}) {
    this.entries.set(key, {
      chars: record.chars ?? null,
      voiceId: record.voiceId ?? null,
      modelId: record.modelId ?? null,
      outputFormat: record.outputFormat ?? null,
      padSecPerItem: record.padSecPerItem ?? null,
      asset: record.asset ?? null,
      generated_at: record.generated_at ?? new Date().toISOString(),
    });
  }

  /** @returns {object} a JSON-serialisable index, key order sorted for a stable diff */
  dump() {
    const entries = {};
    for (const key of [...this.entries.keys()].sort()) entries[key] = this.entries.get(key);
    return { version: 1, entries };
  }
}
