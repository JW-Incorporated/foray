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
 * @param {Function|null} [opts.transport]  `async (request) => {ok, status, bytes, asset}`.
 *
 *   **A THIN WRAPPER AROUND `fetch`, NOT `fetch` ITSELF.** A bare `Response` is
 *   rejected on purpose: its body has not been read yet, so it cannot evidence
 *   that any audio arrived. The wrapper must read the body and AFFIRM success —
 *   forward `ok: true` or the numeric `status`, and return the audio as `bytes` —
 *   a count, or anything carrying `byteLength` or `size` (`Buffer`, any
 *   `TypedArray`, `ArrayBuffer`, `DataView`, `Blob`). A bare `.length` is NOT
 *   read, so do not pass a string or a `content-length` header value. A result
 *   that affirms nothing is treated as a failure and records nothing, because
 *   `fetch` resolves on 429/500 and a cached failure skips the beat forever.
 *   Roughly:
 *
 *       const r = await fetch(req.url, { method: req.method, headers: req.headers,
 *                                       body: JSON.stringify(req.body) });
 *       const buf = await r.arrayBuffer();
 *       return { ok: r.ok, status: r.status, bytes: buf };
 *
 *   Injected in tests, and NOT defaulted to `fetch`, so that a missing transport
 *   cannot silently reach the network.
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

    /* A FAILED CALL MUST NOT BE CACHED, and this is the sharpest edge in the
       module. `transport` wraps `fetch` in production, and **fetch resolves for
       429 and 500** -- it only rejects on a network-level failure. So the
       obvious `await transport(...)` followed by `cache.record(...)` writes a
       cache entry for a generation that never happened, and every later run
       reads that entry as "already voiced" and skips the beat. The Foray then
       ships with a silent gap and no error anywhere: exactly what `cache.mjs`'s
       header calls "the most damaging bug this module could have", which was
       guarded for dry runs and open for failed real ones.

       So success is asserted POSITIVELY: the result must AFFIRM success, not
       merely fail to deny it. The first draft of this fix got that wrong in a way
       worth recording, because it read as correct — it accepted any result whose
       `ok` was not literally `false` and whose `status` was absent or 2xx. The
       most natural wrapper anyone would write,

           const r = await fetch(...); const b = await r.arrayBuffer();
           return { bytes: b.byteLength };

       forgets to forward `ok`/`status`, reports no failure signal at all, and
       therefore sailed through — caching a 429's JSON error body as voiced audio.
       The original bug, undiminished, behind a guard that looked like it closed
       it. "Absence of contrary evidence" is not a positive assertion.

       So: at least one AFFIRMATIVE signal (`ok === true`, or a numeric 2xx
       status), no contradicting one, and real bytes. A transport that reports
       nothing is treated as a failure, which is the safe direction — it re-bills
       rather than skipping the beat forever. */
    const rawStatus = result?.status;
    const status = typeof rawStatus === "number" ? rawStatus : null;
    /* A status that is PRESENT but not a number cannot be read, and an unreadable
       status must not be silently ignored: treating it as absent let
       `{ ok: true, status: "404" }` through as a success, caching a genuine
       failure. Unparseable therefore contradicts. */
    const statusUnparseable = rawStatus !== undefined && rawStatus !== null && status === null;
    const statusAffirms = status !== null && status >= 200 && status < 300;
    /* Read ONCE, like `status` above. Reading `result.ok` three times let a
       non-idempotent getter returning true, false, true be cached as a success --
       the severe direction. Only a pathological transport can do that, but the
       whole posture of this block is not trusting the object it was handed, and a
       value that can change between two reads is not a value. */
    const rawOk = result?.ok;
    const okAffirms = rawOk === true;
    // `ok` present but not strictly true contradicts, which catches `ok: 0` and
    // `ok: null` as well as `ok: false`.
    const okContradicts = rawOk !== undefined && rawOk !== true;
    const statusContradicts = statusUnparseable || (status !== null && !statusAffirms);
    const bytes = byteCountOf(result?.bytes);

    if (okContradicts || statusContradicts || !(okAffirms || statusAffirms) || bytes == null) {
      const denied = okContradicts || statusContradicts;
      return {
        ...p,
        bytes: null,
        asset: null,
        failed: {
          status,
          reason: denied
            ? `transport reported failure (status ${status ?? "unknown"})`
            : bytes == null
              ? "transport returned no audio bytes"
              : "transport affirmed neither ok:true nor a 2xx status, so success cannot be assumed",
        },
      };
    }

    // Recorded ONLY after a generation that demonstrably produced audio. A dry
    // run must never write here either -- see `cache.record`'s comment.
    cache.record(p.key, {
      chars: p.chars, voiceId, modelId, outputFormat, asset: result?.asset ?? null,
    });
    return { ...p, bytes, asset: result?.asset ?? null };
  }

  return { plan, planForay, synthesize, dryRun, cache, config: { voiceId, modelId, outputFormat, charsPerMin } };
}

/**
 * How many bytes of audio a transport actually returned, whatever shape it used
 * to say so.
 *
 * A transport is somebody else's function and the natural things to hand back
 * are all different: a plain count, a `Buffer`, a `Uint8Array`, an
 * `ArrayBuffer`. Requiring a `number` looked strict and was in fact a
 * correctness bug in the dangerous direction — a Buffer of real audio counted as
 * "no bytes", so a genuine success was recorded as a failure and the beat
 * **re-billed on every run, forever.**
 *
 * @param {unknown} b
 * @returns {number|null} a positive byte count, or null if there is no audio
 */
export function byteCountOf(b) {
  if (typeof b === "number") return Number.isFinite(b) && b > 0 ? b : null;
  /* `byteLength` covers Buffer, every TypedArray, ArrayBuffer and DataView;
     `size` covers Blob, which is one of the four natural ways to read a fetch
     body and was missed by the first draft.

     `.length` is deliberately NOT consulted, though it is tempting and the first
     draft used it. It duck-types far too widely for a module whose whole job is
     distrusting what a transport hands back: `byteCountOf("1234")` would answer
     4, a forwarded JSON error body would answer its character count, and the
     natural-looking `bytes: r.headers.get("content-length")` — a STRING — would
     report "41234" as 5 bytes. Refusing all of those means such a transport
     re-bills rather than recording a wrong number, which is the safe direction. */
  /* `size` is read ONLY off a real Blob. It duck-types onto Set, Map and
     URLSearchParams otherwise (`byteCountOf(new Set([1,2]))` would answer 2),
     which is the same objection this function already makes to `.length`. */
  const n = b?.byteLength ?? (typeof Blob === "function" && b instanceof Blob ? b.size : undefined);
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

/** The two pricing buckets `pricing.json` is keyed by. */
export const FLASH_TURBO = "flash_turbo";
export const MULTILINGUAL = "multilingual_v2_and_v3";

/** Provider model id -> the pricing bucket that prices it.
 *
 *  This map is the seam between two namespaces that are easy to confuse: the
 *  provider's model ids, which is what `buildRequest` sends and what the cache
 *  key hashes, and the pricing buckets, which is what `pricing.json` quotes
 *  rates against. `costOf` accepts either and refuses anything it does not
 *  recognise -- see the comment in its body for why a silent zero was the bug. */
export const MODEL_PRICING_BUCKET = Object.freeze({
  eleven_flash_v2_5: FLASH_TURBO,
  eleven_flash_v2: FLASH_TURBO,
  eleven_turbo_v2_5: FLASH_TURBO,
  eleven_turbo_v2: FLASH_TURBO,
  eleven_multilingual_v2: MULTILINGUAL,
  eleven_v3: MULTILINGUAL,
});

/** @returns {string|null} the pricing bucket for a provider id OR a bucket name */
export function pricingBucketFor(model) {
  if (model === FLASH_TURBO || model === MULTILINGUAL) return model;
  return MODEL_PRICING_BUCKET[model] ?? null;
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
 * @returns {{bucket: string, creditsLow: number, creditsHigh: number, usd: number|null}}
 *   `usd` is null for a UI generation, whose dollar rate pricing.json records as
 *   not published.
 */
export function costOf(chars, pricing, opts = {}) {
  const { model = FLASH_TURBO, api = true } = opts;
  const bucket = pricingBucketFor(model);
  /* THROW rather than price an unknown model at zero. Two namespaces meet here --
     provider model ids (`eleven_flash_v2_5`) and pricing buckets
     (`flash_turbo`) -- and `pricing.json` is keyed by the latter. The obvious
     call, `costOf(chars, PRICING, { model: DEFAULT_MODEL_ID })`, therefore used
     to find no rate and silently report $0.00. A cost tool that answers "free"
     when it does not recognise the model is worse than one that refuses. */
  if (!bucket) {
    throw new Error(
      `costOf: unknown model ${JSON.stringify(model)}. Known provider ids: ` +
      `${Object.keys(MODEL_PRICING_BUCKET).join(", ")}; known buckets: ` +
      `${[...new Set(Object.values(MODEL_PRICING_BUCKET))].join(", ")}.`
    );
  }
  const cpc = pricing?.credit_per_character ?? {};
  const discounted = api && bucket === FLASH_TURBO;
  const creditsLow = Math.round(chars * (discounted ? (cpc.api_flash_turbo_low ?? 0.5) : 1));
  const creditsHigh = Math.round(chars * 1);
  /* `usd` is an API rate, so it is only meaningful for an API generation.
     `pricing.json` records UI billing as a flat 1 credit/character and the
     per-1,000-credit dollar rate as NOT PUBLISHED, so there is no honest dollar
     figure for `api: false` -- and returning the API rate for it, as this used
     to, understates a UI generation on the discounted models by 2x. */
  const perK = pricing?.api_dollar_per_1k_chars?.[bucket];
  return {
    bucket,
    creditsLow,
    creditsHigh,
    usd: api && typeof perK === "number" ? (chars / 1000) * perK : null,
  };
}
