/* The TTS adapter, dry by default (#247 item 11).

   It plans a narration batch, reports exact character counts and an estimated
   cost, and CALLS NOTHING. `blocked-on-spend` is a label in this repo for a
   reason, and #247 forbids touching a paid API.

   ── The one design idea in this file ──────────────────────────────────────

   A dry run is worthless if it counts a different string than the real call
   sends. The repo has been burned by exactly this shape before — a fake that
   answered the way the real thing could not — so the defence here is
   structural rather than a comment asking people to be careful:

     **`buildRequest()` produces the real HTTP request, and the dry run reports
     the character count OF THAT REQUEST'S BODY.**

   There is no second code path and no "estimated text". `plan()` builds the
   identical object `synthesize()` would send and measures it. To make the
   estimate wrong you have to make the REQUEST wrong, and then the estimate is
   wrong in the same direction by the same amount — which is a bug that shows up
   as broken audio rather than as a surprise invoice.

   `narrate.test.mjs` pins this by handing the adapter a transport that captures
   what it was given and asserting the captured body is character-identical to
   what the dry run reported.

   ── How a key makes it real, and why that is the ONLY change ──────────────

   `createAdapter()` takes `apiKey`. With no key — the state of the world today —
   `plan()` works fully and `synthesize()` REFUSES. With a key, `synthesize()`
   posts `buildRequest()` through `transport` and records the generation in the
   cache. No other file changes: not `billable.mjs`, not `cache.mjs`, not the
   CLI, not the caller. The endpoint, the headers and the body shape are all
   written out below against the published API reference so that the first real
   run is a configuration change rather than an implementation.

   **Nothing in this file has ever executed against the provider.** The request
   shape is transcribed from `elevenlabs.io/docs/api-reference/text-to-speech/convert`
   and is UNVERIFIED against a live endpoint. Expect the first real call to need
   a correction here, and treat that as the plan rather than as a defect.
*/

import { billableText, countChars, estimateDurationSec, nonAsciiChars, CHARS_PER_MIN_MEASURED } from "./billable.mjs";
import { NarrationCache } from "./cache.mjs";

/** Defaults chosen in `pricing.json` — see `recommended_for_narration`. */
export const DEFAULT_MODEL_ID = "eleven_flash_v2_5";
export const DEFAULT_OUTPUT_FORMAT = "mp3_44100_64";

/** The published base. Transcribed, never called. */
export const API_BASE = "https://api.elevenlabs.io/v1";

/**
 * The exact HTTP request a real synthesis would make.
 *
 * This is the single source of truth for the payload. `plan()` measures its
 * body; `synthesize()` sends it. Do not construct a request anywhere else.
 *
 * @param {object} spec
 * @param {string} spec.text
 * @param {string} spec.voiceId
 * @param {string} [spec.modelId]
 * @param {string} [spec.outputFormat]
 * @param {string} [spec.apiKey]  omitted in a dry run, so the header is absent
 * @returns {{url: string, method: string, headers: object, body: {text: string, model_id: string}}}
 */
export function buildRequest(spec = {}) {
  const {
    text, voiceId,
    modelId = DEFAULT_MODEL_ID,
    outputFormat = DEFAULT_OUTPUT_FORMAT,
    apiKey = null,
  } = spec;

  const headers = { "content-type": "application/json", accept: "audio/mpeg" };
  // The key is the ONLY thing a dry run lacks. Everything else is identical, so
  // the dry run measures the real payload.
  if (apiKey) headers["xi-api-key"] = apiKey;

  return {
    url: `${API_BASE}/text-to-speech/${encodeURIComponent(voiceId ?? "")}?output_format=${encodeURIComponent(outputFormat)}`,
    method: "POST",
    headers,
    // `billableText` and NOT the raw script: what we send is what we are billed
    // for, and `cache.mjs` hashes the same canonical form.
    body: { text: billableText(text), model_id: modelId },
  };
}

/**
 * @param {object} opts
 * @param {string|null} [opts.apiKey]  supply this and the adapter becomes real
 * @param {Function|null} [opts.transport]  `async (request) => {bytes}`. Injected
 *   in tests. In production this would be `fetch`; it is NOT defaulted to
 *   `fetch` here, so that a missing transport cannot silently reach the network.
 * @param {NarrationCache} [opts.cache]
 * @param {number} [opts.charsPerMin]
 * @param {string} [opts.voiceId]
 * @param {string} [opts.modelId]
 * @param {string} [opts.outputFormat]
 */
export function createAdapter(opts = {}) {
  const {
    apiKey = null,
    transport = null,
    cache = new NarrationCache(),
    charsPerMin = CHARS_PER_MIN_MEASURED,
    voiceId = "VOICE_ID_UNSET",
    modelId = DEFAULT_MODEL_ID,
    outputFormat = DEFAULT_OUTPUT_FORMAT,
  } = opts;

  const dryRun = !apiKey;

  /** The cache spec for a script — exactly the four hashed inputs, no more. */
  const specFor = (text) => ({ text, voiceId, modelId, outputFormat });

  /**
   * Plan one script. Never calls anything, key or no key.
   *
   * @param {object} beat  `{ id, text }` — `id` is for reporting only and is
   *   deliberately NOT part of the cache key (see `cache.mjs`).
   * @returns {object}
   */
  function plan(beat = {}) {
    const text = beat.text ?? "";
    /* Build the real request and measure ITS BODY. This is the whole design.
       Deliberately WITHOUT the api key: a plan is a reportable object — the CLI
       prints it, a caller may log or serialise it — and a secret must not ride
       along inside it. That costs nothing, because the key only ever reaches a
       HEADER and the billable unit is the BODY: "the request carries the key only
       when there is one, and is otherwise identical" pins `dry.body` as deep-equal
       to `real.body`, so the string measured here is the string sent. */
    const request = buildRequest(specFor(text));
    const chars = request.body.text.length;
    const cachePlan = cache.plan(specFor(text));

    /* Sanity: the cache and the request must agree on the string. They both
       route through `billableText`, so this can only fire if someone gives one
       of them a different source — which is the drift this module is built to
       make impossible. Assert rather than trust. */
    if (cachePlan.chars !== chars) {
      throw new Error(
        `internal: cache counted ${cachePlan.chars} characters and the request body has ${chars}. ` +
        `Both must come from billableText(); see the header of tools/narrate/adapter.mjs.`
      );
    }

    const nonAscii = nonAsciiChars(text);
    return {
      id: beat.id ?? null,
      chars,
      billedChars: cachePlan.billedChars,
      cached: cachePlan.cached,
      billable: cachePlan.billable,
      key: cachePlan.key,
      estDurationSec: estimateDurationSec(chars, charsPerMin),
      nonAsciiCount: nonAscii.count,
      nonAsciiSamples: nonAscii.samples,
      empty: chars === 0,
      request,
    };
  }

  /**
   * Plan a whole Foray.
   *
   * @param {object[]} beats
   * @returns {{beats: object[], totals: object}}
   */
  function planForay(beats = []) {
    const planned = beats.map(plan);
    const chars = planned.reduce((n, b) => n + b.chars, 0);
    const billedChars = planned.reduce((n, b) => n + b.billedChars, 0);
    return {
      beats: planned,
      totals: {
        beats: planned.length,
        chars,
        billedChars,
        cachedBeats: planned.filter((b) => b.cached).length,
        emptyBeats: planned.filter((b) => b.empty).length,
        estDurationSec: estimateDurationSec(chars, charsPerMin),
        estBilledDurationSec: estimateDurationSec(billedChars, charsPerMin),
      },
    };
  }

  /**
   * The real call. Refuses without a key, which is the state #247 requires.
   *
   * @param {object} beat
   * @returns {Promise<object>}
   */
  async function synthesize(beat = {}) {
    if (dryRun) {
      throw new Error(
        "synthesize() called with no apiKey. This adapter is dry by default and #247 forbids " +
        "spending: pass `apiKey` to createAdapter() only when a founder has authorised the spend."
      );
    }
    if (typeof transport !== "function") {
      throw new Error("synthesize() needs a `transport` — the adapter never reaches for a global fetch.");
    }
    const p = plan(beat);
    if (!p.billable) return { ...p, skipped: "cached", bytes: null };
    if (p.empty) return { ...p, skipped: "empty", bytes: null };

    /* The same request with the key attached. Built here rather than carried on
       the plan so no secret sits inside a reportable object, and then CHECKED
       against what the plan measured — the guarantee this module exists for is
       "we are billed for the string we counted", and this is that guarantee
       executing at runtime rather than only in a test. */
    const keyed = buildRequest({ ...specFor(beat.text ?? ""), apiKey });
    if (keyed.body.text.length !== p.chars) {
      throw new Error(
        `internal: planned ${p.chars} characters but the outgoing body has ${keyed.body.text.length}. ` +
        `buildRequest() must not vary its body with the api key.`
      );
    }
    const result = await transport(keyed);
    // Recorded ONLY after a real generation. A dry run must never write here —
    // see `cache.record`'s comment.
    cache.record(p.key, {
      chars: p.chars, voiceId, modelId, outputFormat, asset: result?.asset ?? null,
    });
    return { ...p, bytes: result?.bytes ?? null, asset: result?.asset ?? null };
  }

  return { plan, planForay, synthesize, dryRun, cache, config: { voiceId, modelId, outputFormat, charsPerMin } };
}

/**
 * Cost of a character count, in credits and dollars, under the snapshot in
 * `pricing.json`.
 *
 * Returns BOTH a floor and a ceiling rather than one number, because
 * `pricing.json` records that the per-character credit rate is only officially
 * bounded as "between 0.5 and 1" for the discounted API models. A single number
 * here would be a guess wearing a decimal point.
 *
 * @param {number} chars
 * @param {object} pricing  the parsed `pricing.json`
 * @param {object} [opts]
 * @param {("flash_turbo"|"multilingual_v2_and_v3")} [opts.model]
 * @param {boolean} [opts.api]  API generations are discounted; UI is always 1:1
 * @returns {{creditsLow: number, creditsHigh: number, usd: number}}
 */
export function costOf(chars, pricing, opts = {}) {
  const { model = "flash_turbo", api = true } = opts;
  const cpc = pricing?.credit_per_character ?? {};
  const discounted = api && model === "flash_turbo";
  const creditsLow = Math.round(chars * (discounted ? (cpc.api_flash_turbo_low ?? 0.5) : 1));
  const creditsHigh = Math.round(chars * 1);
  const perK = pricing?.api_dollar_per_1k_chars?.[model] ?? 0;
  return { creditsLow, creditsHigh, usd: (chars / 1000) * perK };
}
