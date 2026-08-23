#!/usr/bin/env node
// Ad-inflation scan — which shows actually inject ads into the file we receive?
//
// WHY THIS EXISTS
// A show's `dai_suspected` flag is assigned from its enclosure host, which says
// who *could* insert ads, not who *does*. That matters because it decides
// whether a publisher's transcript is usable: if the delivered audio is the
// file the feed describes, the transcript's timestamps anchor for free
// (ADR-0007). If ads are injected, they do not.
//
// THE MEASUREMENT
//   ratio = delivered total bytes / feed-declared enclosure length
//     1.000  -> no injection; publisher transcript timeline matches our audio
//     >1.000 -> injected ad load, and the ratio quantifies it
//
// HEAD REQUESTS LIE. On DAI hosts, HEAD returns the ad-free master's
// Content-Length while a real GET delivers the assembled file. Verified by
// downloading two Stuff You Should Know episodes in full: HEAD said 35,549,607,
// the download was 44,961,612. So this uses a 2-byte ranged GET and reads the
// true total out of Content-Range -- one tiny request per episode, no download.
//
// Ground truth (episodes downloaded in full, 2026-08-15):
//   Stuff You Should Know 1.27 / 1.17 | Odd Lots 1.15 / 1.14
//   This Podcast Will Kill You 1.10 / 1.10 | Being an Engineer 1.000 / 1.000
// This scan reproduced 1.15 (Odd Lots) and 1.12 (TPWKY) from range headers
// alone, so the cheap probe agrees with the expensive one.
//
// POLITENESS IS NOT THIS FILE'S TO INVENT (#313). Every request below goes
// through `tools/segments/politeness.mjs` -- the one per-host gate, with the
// throttle, the jittered backoff, and the `Retry-After` handling that quiets
// the WHOLE host rather than only the worker that was told to wait. This module
// deliberately has no throttle of its own: the last two fetchers each grew a
// private copy of that policy and both copies drifted into the same two bugs.
// If you need to change how fast this scans, change it there.
//
// THAT INCLUDES THE USER-AGENT, and this file is the reason politeness.mjs now
// owns `AUDIO_UA`. This module used to carry its own `STANDARD_UA`, a third
// copy of the fetcher string with an extra `ad-inflation scan;` product token
// in it. Measured 2026-08-23: Buzzsprout serves the canonical ForayBot UA 206
// and refuses the drifted one 403, reproducibly, on the same enclosure in the
// same minute. A 403 carries no length to measure, so the scan did not fail --
// it returned "could not tell" for all 423 Buzzsprout timed transcripts, and a
// verdict of "could not tell" caused by our own string is the most expensive
// kind of quiet wrong answer this scan can produce.
//
// The same applies to `accept-language`, which this probe did not send at all:
// Node defaults it to `*` and Captivate answers that with 404, which is another
// 301 timed transcripts reading as "could not tell". Both headers now come from
// `AUDIO_PROBE_HEADERS` so neither fetcher can be missing one the other has.
//
// Usage:
//   node tools/transcribe/ad-inflation.mjs [--per-show N] [--out FILE] [--all]
//                                          [--show "Title"] [--dry-run]
// By default it scans only shows that ship timed transcripts, because those are
// the ones where the answer pays out, and it writes the verdicts into
// `data/dai-classification.json` beside the host-derived flag they qualify.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { AUDIO_PROBE_HEADERS, awaitHostSlot, waitBeforeRetry } from '../segments/politeness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Total size from a Content-Range header ("bytes 0-1/44961612"), or null. */
export function parseContentRangeTotal(header) {
  if (typeof header !== 'string') return null;
  const m = /^\s*bytes\s+(?:\d+-\d+|\*)\/(\d+)\s*$/i.exec(header);
  if (!m) return null;
  const total = Number(m[1]);
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

/**
 * A response body small enough to be an error page is not a measurement.
 * One host returned 2 bytes for a HEAD during the first probe.
 */
export const MIN_PLAUSIBLE_BYTES = 1_000_000;

export function isPlausibleAudioSize(bytes) {
  return Number.isFinite(bytes) && bytes >= MIN_PLAUSIBLE_BYTES;
}

/** Ratio of delivered bytes to what the feed declared. null if uncomputable. */
export function inflationRatio(deliveredBytes, declaredBytes) {
  if (!isPlausibleAudioSize(deliveredBytes)) return null;
  if (!Number.isFinite(declaredBytes) || declaredBytes <= 0) return null;
  return deliveredBytes / declaredBytes;
}

/**
 * Below this, the delivered file is the file the feed describes and the
 * publisher's transcript timestamps can be trusted as anchors. 1% absorbs
 * container/tag differences without admitting even a 30-second pre-roll, which
 * on a 40-minute episode is ~1.2%.
 */
export const AD_FREE_THRESHOLD = 1.01;

/**
 * ...and the same 1% on the other side, because the threshold used to be
 * one-sided and that was wrong in a way only a real scan could show.
 *
 * MEASURED 2026-08-23: Around the House with Eric G delivers a median of 0.758
 * -- four of its five sampled episodes arrive a QUARTER SMALLER than the length
 * their own feed declares. A one-sided `ratio < 1.01` called that ad-free and
 * admitted all 301 of the show's timed transcripts.
 *
 * Under-size is not evidence of no ads. It is evidence that the delivered file
 * is not the file the feed describes -- a stale `length` after a re-encode, or
 * a redirector serving something else -- and that disqualifies a transcript for
 * exactly the reason injection does: the publisher's timeline was authored
 * against a copy we are not receiving. A denominator we have just caught being
 * wrong cannot be trusted to answer the ad question either, so the honest
 * verdict is a refusal to answer, not a clean bill of health.
 *
 * Both directions therefore fail closed. 0.99 mirrors the ceiling: it absorbs
 * the same container/tag noise and nothing larger.
 */
export const AD_FREE_FLOOR = 0.99;

/** Said out loud on the record, because an unexplained "unknown" is
    indistinguishable from a failed fetch, and the two want different follow-up:
    a failed fetch wants a retry, this wants the decode-and-compare of ADR-0008. */
/** The other way a ratio can be real and still not settle anything. */
export const THIN_SAMPLE_REASON =
  'the probes that returned a length agree the file is byte-stable, but there are ' +
  'too few of them to admit a show on';

export const UNDERSIZED_REASON =
  'delivered bytes fall short of the feed-declared length, so the declared length ' +
  'does not describe the file we receive and the ratio cannot answer the ad question';

/** Samples delivering FEWER bytes than the feed declared.

    HERE, BESIDE THE FLOOR IT APPLIES, because this is the module that owns the
    rule. It was inlined twice — once in this file's `main`, once in
    `measure-suspects.mjs` — and #321 extracted the second copy before noticing
    the first, which would have made it the seventh duplicated implementation
    this repo has paid for. It cannot be imported the other way round:
    `measure-suspects.mjs` already imports this module, so the rule has to live
    at the end that does not create a cycle.

    Exported rather than private so a committed verdict can be RECOMPUTED from
    its own samples. A derived count that no test can reproduce is a claim. */
export function undersizedSamples(samples) {
  return (samples || []).filter((x) => typeof x.ratio === 'number' && x.ratio < AD_FREE_FLOOR).length;
}

export function classify(ratio) {
  if (ratio == null) return 'unknown';
  if (ratio < AD_FREE_FLOOR) return 'unknown';
  return ratio < AD_FREE_THRESHOLD ? 'ad-free' : 'injected';
}

/** Ratios are recorded to three decimals, so the summary is computed to three
    decimals too. This is not cosmetic. An even-sized sample averages its middle
    pair and can land between them -- (1.011 + 1.014) / 2 = 1.0125 -- and if the
    verdict is taken from the raw median while the RECORD keeps a rounded one,
    a raw 1.0095 is stored as `ad-free` beside a ratio of 1.010. Rounding here,
    once, before classifying, makes the two agree by construction. */
export const RATIO_PRECISION = 1000;

/** Below this, an 'ad-free' verdict rests on a single response, and a single
    response is the cheapest thing for a host to get wrong -- one cached 200,
    one redirect to a trailer. `injected` and `unknown` are unaffected: they
    refuse to admit a transcript, and refusing on thin evidence is free. */
export const MIN_SAMPLES_FOR_AD_FREE = 2;

/** Median is the right summary: one odd episode should not reclassify a show. */
export function summariseShow(ratios) {
  const clean = ratios.filter((r) => typeof r === 'number' && Number.isFinite(r)).sort((a, b) => a - b);
  if (!clean.length) return { median: null, n: 0, verdict: 'unknown', reason: null };
  const mid = clean.length % 2
    ? clean[(clean.length - 1) / 2]
    : (clean[clean.length / 2 - 1] + clean[clean.length / 2]) / 2;
  const median = Math.round(mid * RATIO_PRECISION) / RATIO_PRECISION;
  const measured = classify(median);
  const verdict = measured === 'ad-free' && clean.length < MIN_SAMPLES_FOR_AD_FREE ? 'unknown' : measured;
  return {
    median,
    n: clean.length,
    verdict,
    reason:
      verdict !== 'unknown' ? null
        : median == null ? null
        : measured === 'ad-free' ? THIN_SAMPLE_REASON
        : UNDERSIZED_REASON,
  };
}

/* ------------------------------------------------------------- the request */

/** A probe that hangs holds up the whole sequential scan, and the gate already
    puts a second between requests; 20s is generous for two bytes. */
export const PROBE_TIMEOUT_MS = 20_000;
export const MAX_ATTEMPTS = 3;

/** Statuses worth a second ask. A 403 or a 404 is an answer, not a hiccup, and
    retrying it spends a host's patience to learn nothing new. */
export const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isRetryableStatus(status) {
  return RETRYABLE_STATUS.has(Number(status));
}

/**
 * Probe one enclosure with a 2-byte ranged GET. Injected so tests never touch
 * the network.
 *
 * Returns the evidence, not just the ratio: the declared and delivered byte
 * counts are what make a verdict in `data/dai-classification.json` reproducible
 * by hand, and a bare number cannot carry the reason it is null.
 *
 * WAITING FOR A RETRY IS THE GATE'S JOB, not a private sleep.
 * `waitBeforeRetry` pushes the whole HOST's slot out, so the next iteration's
 * `awaitHostSlot` blocks for exactly as long as the host asked — and so does
 * every other request to that host, which is the bug #313 extracted this module
 * to kill. A local `await sleep(...)` here would quiet this probe alone and
 * silently reintroduce it.
 */
export async function probeEpisode(url, declaredBytes, {
  fetchImpl = fetch,
  headers = AUDIO_PROBE_HEADERS,
  gate = awaitHostSlot,
  retryWait = waitBeforeRetry,
  sleep = undefined,
  now = undefined,
  maxAttempts = MAX_ATTEMPTS,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  /* `now` rides alongside `sleep` for the same reason `sleep` is here: so a
     test can drive the shared gate without real wall-clock. Without it the gate
     assertion had to allow a 50ms slop against `Date.now()`, and a machine that
     stalled between two probes — a 78-suite CI run does — failed it for reasons
     that had nothing to do with the gate. Never set by the tools; a run that
     supplied its own clock would be a run with no throttle. */
  const gateOpts = { ...(sleep ? { sleep } : {}), ...(now ? { now } : {}) };
  let status = null;
  let error = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await gate(url, gateOpts);

    let res = null;
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl && timeoutMs > 0 ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { ...headers },
        ...(ctl ? { signal: ctl.signal } : {}),
      });
    } catch (e) {
      error = e && e.name === 'AbortError' ? 'timeout' : String((e && e.message) || e);
      res = null;
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!res) {
      /* Held even on the LAST attempt -- see the note on the 429 branch. */
      retryWait(url, null, attempt, gateOpts);
      continue;
    }

    status = res.status == null ? null : res.status;
    if (status != null && isRetryableStatus(status)) {
      error = `HTTP ${status}`;
      if (res.body && typeof res.body.cancel === 'function') await res.body.cancel();
      /* UNCONDITIONAL, INCLUDING ON THE LAST ATTEMPT. The hold is a property of
         the HOST, not of whether this caller intends to try again. Guarding it
         with `attempt < maxAttempts` -- which this loop did until review caught
         it -- means three consecutive 429s end with the gate carrying only its
         1.2s minimum, so the next probe of that host goes out 1.2s after it
         asked us to go away for sixty seconds. That is the #313 bug wearing a
         different hat, and it fires exactly when the host is most insistent.
         This scan walks shows that share a handful of CDNs, so the next probe
         is frequently the same host. */
      retryWait(url, res, attempt, gateOpts);
      continue;
    }

    /* A refusal is not retried, but it should still SAY it was a refusal.
       `no usable length in the response` is what a 403 reported before review,
       and a 403 from a blocked User-Agent is the one failure this scan most
       needs to be greppable. */
    if (status != null && status >= 400) error = `HTTP ${status}`;

    const delivered =
      parseContentRangeTotal(res.headers.get('content-range')) ??
      Number(res.headers.get('content-length'));
    if (res.body && typeof res.body.cancel === 'function') await res.body.cancel();

    const ratio = inflationRatio(delivered, declaredBytes);
    /* "NO USABLE LENGTH IN THE RESPONSE" MUST DESCRIBE THE RESPONSE, and it did
       not. This used to fire whenever `ratio` was null — but `inflationRatio`
       also returns null when the CALLER supplied no denominator, which is the
       normal case for `measure-suspects.mjs --repeat`: it deliberately probes
       feeds that publish no `<enclosure length>` and compares deliveries with
       each other instead. Every one of those samples was committed carrying
       `status: 206`, a 60MB `delivered_bytes`, and an error saying the response
       had no usable length. Untrue on its face, and a live trap: the suites
       already assert `ratio == null => error`, so any future code that filtered
       `!s.error` would silently discard exactly the evidence those rows exist
       to hold. A missing denominator is the caller's business; a missing length
       is this function's. */
    const usableLength = isPlausibleAudioSize(delivered);
    return {
      ratio,
      declared_bytes: Number.isFinite(declaredBytes) && declaredBytes > 0 ? declaredBytes : null,
      delivered_bytes: Number.isFinite(delivered) && delivered > 0 ? delivered : null,
      status,
      attempts: attempt,
      /* A RETRY THAT SUCCEEDED IS NOT AN ERROR. `error` is loop-scoped, so a
         503 on attempt 1 followed by a clean 206 on attempt 2 used to return
         `{ratio: 1, error: 'HTTP 503'}` — a sample that measured perfectly and
         reads as a failure. It landed in committed evidence: the Art Bell
         re-probe that recovers 1,368 transcripts carries `ratio: 1, status:
         206, error: 'HTTP 500'` on one of its five samples, which invites
         exactly the `!s.error` filter that would silently drop it. `attempts`
         already records that retries happened, which is the fact worth
         keeping; the stale message is not. */
      error: usableLength ? null : error || 'no usable length in the response',
    };
  }

  return {
    ratio: null,
    declared_bytes: Number.isFinite(declaredBytes) && declaredBytes > 0 ? declaredBytes : null,
    delivered_bytes: null,
    status,
    attempts: maxAttempts,
    error: error || 'exhausted attempts',
  };
}

export function selectTargets({ discover, availability, perShow = 3, onlyTranscribed = true }) {
  const timed = new Map();
  for (const s of availability.shows ?? []) {
    const n = s.episodes_with_timed_transcript || 0;
    if (n > 0) timed.set(s.title, { timedTranscripts: n, flaggedDai: !!s.dai_suspected });
  }
  const items = Array.isArray(discover) ? discover : (discover.items ?? []);
  const byShow = new Map();
  for (const it of items) {
    if (!it.audio_url || !it.audio_bytes) continue;
    if (onlyTranscribed && !timed.has(it.show)) continue;
    if (!byShow.has(it.show)) byShow.set(it.show, []);
    const bucket = byShow.get(it.show);
    if (bucket.length < perShow) bucket.push(it);
  }
  return { byShow, timed };
}

/* ------------------------------------------------------------ the verdicts */

/** Why a show can have no verdict for a reason that is not the network.

    A show whose every curated episode declares `length="0"` — which Megaphone
    does, per ADR-0008 — yields no probe target at all. That is "could not
    tell", and it has to be RECORDED as that: a show simply absent from the
    output reads as one nobody got to, and the point of this scan is to end the
    "nobody measured it" state for every show in the pool, including the ones
    where the answer is that we still cannot say. */
export const NO_TARGETS_REASON =
  'no curated episode declares an enclosure length, so the ratio has no denominator';

/**
 * Fold verdicts into `data/dai-classification.json` IN PLACE, keyed the way
 * that file already keys everything: by `apple_collection_id`.
 *
 * `dai` and `reason` are deliberately UNTOUCHED. They are the host-derived
 * flag; `classify-dai.mjs --reclassify` recomputes them from the host list on
 * every run, so a measured verdict written into `dai` would be quietly reverted
 * the next time that ran. Beside the flag is also the honest shape: `dai` says
 * who *could* inject, `ad_inflation` says who *does*.
 */
export function applyVerdicts(classification, results, { measuredAt = new Date().toISOString() } = {}) {
  const shows = classification.shows ?? (classification.shows = {});
  let written = 0;
  let unkeyed = 0;
  for (const r of results) {
    const key = r.apple_collection_id == null ? null : String(r.apple_collection_id);
    if (!key || !shows[key]) { unkeyed++; continue; }
    shows[key].ad_inflation = {
      verdict: r.verdict,
      median_ratio: r.median,
      episodes_probed: r.n,
      measured_at: measuredAt,
      method: '2-byte ranged GET; tools/transcribe/ad-inflation.mjs',
      ...(r.undersized_samples ? { undersized_samples: r.undersized_samples } : {}),
      ...(r.note ? { note: r.note } : {}),
      samples: r.samples,
    };
    written++;
  }
  return { written, unkeyed };
}

/** Shows measured delivering the file their feed describes.

    `tools/segments/fetch-transcripts.mjs` needs exactly this list to decide
    what it may anchor. It reads it FROM HERE rather than keeping its own copy:
    a hand-maintained second list of the same measurement is the drift this repo
    has paid for twice already (#211/#219/#249, and politeness in #313). */
export function adFreeShows(classification) {
  return Object.values((classification && classification.shows) || {})
    .filter((s) => s && s.ad_inflation && s.ad_inflation.verdict === 'ad-free')
    .map((s) => s.show)
    .sort();
}

/* -------------------------------------------------------------------- main */

function parseArgs(argv) {
  const get = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    /* NaN selects zero targets, which would rewrite all 27 verdicts as "could
       not tell" without making a single request. Fail loudly instead. */
    perShow: (() => {
      const raw = get('--per-show', 5);
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--per-show must be a positive integer, got ${raw}`);
      return n;
    })(),
    out: get('--out', null),
    show: get('--show', null),
    all: argv.includes('--all'),
    dryRun: argv.includes('--dry-run'),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const discover = JSON.parse(readFileSync(join(ROOT, 'data', 'discover.json'), 'utf8'));
  const availability = JSON.parse(readFileSync(join(ROOT, 'data', 'transcript-availability.json'), 'utf8'));
  const classPath = join(ROOT, 'data', 'dai-classification.json');
  const classification = JSON.parse(readFileSync(classPath, 'utf8'));

  const { byShow } = selectTargets({
    discover,
    availability,
    perShow: args.perShow,
    onlyTranscribed: !args.all,
  });

  /* Drive the loop from the AVAILABILITY index rather than from `byShow`, so a
     show with no probeable episode still produces an explicit "could not tell"
     row instead of vanishing from the report. */
  const pool = (availability.shows ?? [])
    .filter((s) => args.all || (s.episodes_with_timed_transcript || 0) > 0)
    .filter((s) => !args.show || s.title === args.show)
    .sort((a, b) => b.episodes_with_timed_transcript - a.episodes_with_timed_transcript);

  console.log(`${pool.length} show(s) shipping timed transcripts; up to ${args.perShow} episode(s) each\n`);

  const started = Date.now();
  let requests = 0;
  let retried = 0;
  const results = [];

  for (const show of pool) {
    const targets = byShow.get(show.title) ?? [];
    const samples = [];
    for (const it of targets) {
      const p = await probeEpisode(it.audio_url, it.audio_bytes);
      requests += p.attempts;
      if (p.attempts > 1) retried++;
      samples.push({
        item_id: it.id ?? null,
        episode: String(it.title || '').slice(0, 90),
        declared_bytes: p.declared_bytes,
        delivered_bytes: p.delivered_bytes,
        ratio: p.ratio == null ? null : Math.round(p.ratio * 1000) / 1000,
        ...(p.error ? { error: p.error, status: p.status } : {}),
      });
    }

    const s = summariseShow(samples.map((x) => x.ratio));
    /* Counted even when the median lands in the band: a single under-sized
       episode means this feed declares lengths it does not deliver, which is
       worth seeing next to a verdict of 'injected' that was computed from the
       same declarations. 5-4 measured 0.875 / 1.024 / 1.059. */
    const undersized = undersizedSamples(samples);
    results.push({
      show: show.title,
      apple_collection_id: show.apple_collection_id ?? null,
      timed_transcripts: show.episodes_with_timed_transcript,
      dai_flagged: show.dai_suspected === true,
      verdict: s.verdict,
      median: s.median,
      n: s.n,
      ...(undersized > 0 ? { undersized_samples: undersized } : {}),
      ...(targets.length === 0 ? { note: NO_TARGETS_REASON } : s.reason ? { note: s.reason } : {}),
      samples,
    });

    const med = s.median == null ? '  -  ' : s.median.toFixed(3);
    console.log(
      `  ${s.verdict.padEnd(8)} ${med}  n=${String(s.n).padStart(2)}  ` +
      `${String(show.episodes_with_timed_transcript).padStart(5)} timed  ${show.title.slice(0, 48)}`,
    );
  }

  const elapsedMin = (Date.now() - started) / 60000;
  const by = (v) => results.filter((r) => r.verdict === v);
  const timedIn = (v) => by(v).reduce((n, r) => n + r.timed_transcripts, 0);

  console.log(`\n${'='.repeat(64)}`);
  console.log(`requests: ${requests} over ${elapsedMin.toFixed(1)} min; probes needing a retry: ${retried}`);
  for (const v of ['ad-free', 'injected', 'unknown']) {
    console.log(`  ${v.padEnd(8)} ${String(by(v).length).padStart(3)} shows  ${String(timedIn(v)).padStart(5)} timed transcripts`);
  }

  if (args.dryRun) {
    console.log('\n--dry-run: no files written.');
  } else {
    const { written, unkeyed } = applyVerdicts(classification, results);
    /* `built_at` belongs to classify-dai.mjs, which keeps discover.json's copy
       equal to it. Overwriting it here desynchronises the two for a change that
       touched neither. Our timestamp goes in our own field. */
    classification.ad_inflation_measured_at = new Date().toISOString();
    writeFileSync(classPath, JSON.stringify(classification, null, 2) + '\n');
    console.log(`\nwrote data/dai-classification.json (${written} shows; ${unkeyed} had no entry to attach to)`);
    console.log(`ad-free shows now: ${adFreeShows(classification).join(', ')}`);
  }

  if (args.out) {
    const outPath = resolvePath(process.cwd(), args.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(
      outPath,
      JSON.stringify({ measured_at: new Date().toISOString(), requests, results }, null, 2) + '\n',
    );
    console.log(`SCAN_WRITTEN: ${outPath}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('FATAL:', e);
    process.exit(1);
  });
}
