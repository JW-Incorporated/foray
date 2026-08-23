import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseContentRangeTotal, inflationRatio, classify, summariseShow,
  probeEpisode, selectTargets, isPlausibleAudioSize, isRetryableStatus,
  applyVerdicts, adFreeShows,
  AD_FREE_THRESHOLD, AD_FREE_FLOOR, MIN_PLAUSIBLE_BYTES, RETRYABLE_STATUS,
  UNDERSIZED_REASON,
} from './ad-inflation.mjs';
import { AUDIO_UA, AUDIO_PROBE_HEADERS, MIN_HOST_INTERVAL_MS, resetHostGates } from '../segments/politeness.mjs';
import { AD_FREE_SHOWS } from '../segments/fetch-transcripts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The numbers in this file are not invented. They come from four episodes
// downloaded in full on 2026-08-15 and from the range headers of the same
// enclosures, which is what makes them worth asserting on.
//
// Each test below that guards a request names the one-line MUTATION that makes
// it fail, and each was run against that mutation before being committed
// (CLAUDE.md, and the header of politeness.test.mjs, which exists because the
// politeness layer had no test at all while three file headers described it).

/** A response shaped like the ones the hosts actually send. */
const res = (headers, { status = 206 } = {}) => ({
  status,
  headers: new Map(Object.entries(headers)),
  body: null,
});

test('parseContentRangeTotal reads the total, not the requested slice', () => {
  assert.equal(parseContentRangeTotal('bytes 0-1/44961612'), 44961612);
  assert.equal(parseContentRangeTotal('bytes 0-1/52666700'), 52666700);
});

test('parseContentRangeTotal tolerates the unsatisfied-range form', () => {
  assert.equal(parseContentRangeTotal('bytes */44961612'), 44961612);
});

test('parseContentRangeTotal refuses a range with an unknown total', () => {
  // "*" as the total means the server will not say -- guessing would silently
  // classify an injected show as ad-free.
  assert.equal(parseContentRangeTotal('bytes 0-1/*'), null);
});

test('parseContentRangeTotal rejects junk rather than coercing it', () => {
  for (const junk of [null, undefined, '', 'bytes 0-1', 'items 0-1/500', 42, {}]) {
    assert.equal(parseContentRangeTotal(junk), null, `should reject ${JSON.stringify(junk)}`);
  }
});

test('a two-byte error page is not a measurement', () => {
  // An early probe had a host answer with 2 bytes; counting that as the file
  // size would have produced a ratio near zero and read as "ad-free".
  assert.equal(isPlausibleAudioSize(2), false);
  assert.equal(isPlausibleAudioSize(MIN_PLAUSIBLE_BYTES), true);
  assert.equal(inflationRatio(2, 35549607), null);
});

test('inflationRatio reproduces the measured Stuff You Should Know episodes', () => {
  // HEAD claimed 35,549,607 for the first of these. The download was 44,961,612.
  assert.equal(inflationRatio(44961612, 35549607).toFixed(3), '1.265');
  assert.equal(inflationRatio(52666700, 45619089).toFixed(3), '1.154');
});

test('inflationRatio returns null on a missing or zero declared length', () => {
  assert.equal(inflationRatio(44961612, 0), null);
  assert.equal(inflationRatio(44961612, undefined), null);
});

test('classify splits the measured shows the way the downloads did', () => {
  assert.equal(classify(1.000), 'ad-free');   // Being an Engineer, measured twice
  assert.equal(classify(1.265), 'injected');  // Stuff You Should Know
  assert.equal(classify(1.095), 'injected');  // This Podcast Will Kill You
  assert.equal(classify(null), 'unknown');
});

test('the threshold admits container noise but not a pre-roll', () => {
  // ~30s of pre-roll on a 40 min episode is ~1.2%, which must not pass.
  assert.ok(AD_FREE_THRESHOLD > 1.000);
  assert.equal(classify(1.012), 'injected');
  assert.equal(classify(1.002), 'ad-free');
});

/* MUTATION: delete the `ratio < AD_FREE_FLOOR` branch from `classify`, i.e.
   restore the one-sided threshold this tool shipped with.

   THIS IS NOT HYPOTHETICAL. The 2026-08-23 scan measured Around the House with
   Eric G at a median of 0.758 across five episodes -- the delivered file is a
   QUARTER SMALLER than the length its feed declares. A one-sided `ratio < 1.01`
   reads that as "ad-free" and admits all 301 of the show's timed transcripts.

   Under-size is not evidence of no ads; it is evidence that the delivered file
   is not the file the feed describes, which is the same reason injection
   disqualifies a transcript. Whether the publisher re-encoded without updating
   the RSS `length`, or the redirector served something else entirely, the
   feed-declared denominator is not describing our audio -- so the numerator
   cannot answer the ad question either. Both directions must fail closed. */
test('a file smaller than its declared length is not "ad-free", it is unknown', () => {
  assert.ok(AD_FREE_FLOOR < 1.000, 'the floor must admit exact matches');
  assert.equal(classify(0.758), 'unknown');   // Around the House, measured n=5
  assert.equal(classify(0.5), 'unknown');
  assert.equal(classify(0.989), 'unknown');
  // ...while ordinary container/tag noise on the low side still passes.
  assert.equal(classify(0.999), 'ad-free');
  assert.equal(classify(AD_FREE_FLOOR), 'ad-free');
});

test('summariseShow explains an under-size verdict rather than just refusing', () => {
  // "unknown" with no reason is indistinguishable from a failed fetch, and the
  // two want completely different follow-up work.
  const s = summariseShow([0.75, 0.76, 0.77]);
  assert.equal(s.verdict, 'unknown');
  assert.equal(s.reason, UNDERSIZED_REASON);
  assert.equal(summariseShow([1.0, 1.0]).reason, null);
  assert.equal(summariseShow([]).reason, null);
});

test('summariseShow uses the median so one odd episode cannot flip a show', () => {
  const s = summariseShow([1.0, 1.0, 1.31]);
  assert.equal(s.median, 1.0);
  assert.equal(s.verdict, 'ad-free');
  assert.equal(s.n, 3);
});

test('summariseShow averages the middle pair on an even sample', () => {
  assert.equal(summariseShow([1.0, 1.2]).median, 1.1);
});

test('summariseShow reports unknown rather than guessing when nothing measured', () => {
  const s = summariseShow([null, undefined, NaN]);
  assert.equal(s.median, null);
  assert.equal(s.verdict, 'unknown');
  assert.equal(s.n, 0);
});

/* ------------------------------------------------------------- the request */

test('probeEpisode asks for two bytes, follows redirects, and identifies itself', async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return res({ 'content-range': 'bytes 0-1/44961612' });
  };
  const p = await probeEpisode('https://example.test/ep.mp3', 35549607, { fetchImpl, gate: async () => 0 });
  assert.equal(seen.opts.method, 'GET');
  assert.equal(seen.opts.headers.range, 'bytes=0-1');
  assert.equal(seen.opts.redirect, 'follow');
  assert.equal(p.ratio.toFixed(3), '1.265');
});

/* MUTATION: put the old private string back on the request --
   `'user-agent': 'ForayBot/0.1 (ad-inflation scan; +https://github.com/...)'`.

   Measured 2026-08-23, alternating requests to one Buzzsprout enclosure:
   the canonical UA gets 206, the variant carrying an extra `ad-inflation scan;`
   product token gets 403, reproducibly. A 403 has no length to measure, so the
   scan does not fail -- it reports "could not tell" for every Buzzsprout show,
   which is 423 timed transcripts including the 337 already being anchored on
   Being an Engineer. */
test('probeEpisode sends the shared audio User-Agent with no extra product token', async () => {
  let seen;
  const fetchImpl = async (url, opts) => { seen = opts; return res({ 'content-range': 'bytes 0-1/2000000' }); };
  await probeEpisode('https://example.test/ep.mp3', 2000000, { fetchImpl, gate: async () => 0 });
  assert.equal(seen.headers['user-agent'], AUDIO_UA);
  assert.doesNotMatch(seen.headers['user-agent'], /scan|inflation/i,
    'a product token in the UA is what Buzzsprout refuses');
  assert.match(seen.headers['user-agent'], /github\.com\/JW-Incorporated\/foray/);
  assert.match(seen.headers['user-agent'], /wjduvall@gmail\.com/, 'the contact address is the honest part');
});

/* MUTATION: drop `accept-language` from AUDIO_PROBE_HEADERS.

   Node's fetch then sends its default `accept-language: *`, and Captivate's
   edge answers that with `404 Missing redirect URL` -- which is Around the
   House's 301 transcripts reading as "could not tell" for a reason that is
   entirely ours. Recorded in verify-source-audio.mjs since 2026-08-16; this
   scan had no Accept-Language at all until 2026-08-23. */
test('probeEpisode sends a real Accept-Language, because Captivate 404s the default', async () => {
  let seen;
  const fetchImpl = async (url, opts) => { seen = opts; return res({ 'content-range': 'bytes 0-1/2000000' }); };
  await probeEpisode('https://example.test/ep.mp3', 2000000, { fetchImpl, gate: async () => 0 });
  assert.equal(seen.headers['accept-language'], 'en');
  assert.equal(seen.headers['accept-language'], AUDIO_PROBE_HEADERS['accept-language']);
});

test('probeEpisode falls back to content-length when the host ignores Range', async () => {
  const fetchImpl = async () => res({ 'content-length': '44961612' });
  const p = await probeEpisode('https://example.test/ep.mp3', 35549607, { fetchImpl, gate: async () => 0 });
  assert.equal(p.ratio.toFixed(3), '1.265');
});

test('probeEpisode drains the body so a ranged GET cannot leak a socket', async () => {
  let cancelled = false;
  const fetchImpl = async () => ({
    status: 206,
    headers: new Map([['content-range', 'bytes 0-1/2000000']]),
    body: { cancel: async () => { cancelled = true; } },
  });
  await probeEpisode('https://example.test/ep.mp3', 2000000, { fetchImpl, gate: async () => 0 });
  assert.equal(cancelled, true);
});

test('probeEpisode returns the evidence, not only the verdict', async () => {
  // A verdict in data/dai-classification.json has to be re-checkable by hand,
  // and a bare ratio cannot carry the reason it is null.
  const fetchImpl = async () => res({ 'content-range': 'bytes 0-1/44961612' });
  const p = await probeEpisode('https://example.test/ep.mp3', 35549607, { fetchImpl, gate: async () => 0 });
  assert.equal(p.declared_bytes, 35549607);
  assert.equal(p.delivered_bytes, 44961612);
  assert.equal(p.status, 206);
  assert.equal(p.attempts, 1);
  assert.equal(p.error, null);
});

test('a probe that cannot be measured says why', async () => {
  const fetchImpl = async () => res({}, { status: 403 });
  const p = await probeEpisode('https://example.test/ep.mp3', 35549607, { fetchImpl, gate: async () => 0 });
  assert.equal(p.ratio, null);
  assert.equal(p.status, 403);
  assert.ok(p.error, 'a null ratio with no error is indistinguishable from a clean zero');
});

/* --------------------------------------------------------- the politeness */

/* MUTATION: delete the `await gate(url, gateOpts)` line at the top of the
   retry loop. Every probe then fires the instant the previous one resolves,
   and this catalogue's enclosures cluster onto a handful of CDNs -- so a
   27-show scan becomes a burst at whoever hosts the most shows. */
test('the default probe path waits on the shared per-host gate', async () => {
  resetHostGates();
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); };
  const fetchImpl = async () => res({ 'content-range': 'bytes 0-1/2000000' });

  // Two different URLs, ONE host -- which is the case the gate exists for.
  await probeEpisode('https://one-host.test/a.mp3', 2000000, { fetchImpl, sleep });
  await probeEpisode('https://one-host.test/b.mp3', 2000000, { fetchImpl, sleep });

  assert.equal(slept.length, 1, 'the first probe claims a free slot; the second must wait');
  assert.ok(slept[0] >= MIN_HOST_INTERVAL_MS - 50, `waited ${slept[0]}ms, expected ~${MIN_HOST_INTERVAL_MS}`);
});

/* MUTATION: replace `retryWait(url, res, attempt, gateOpts)` with a local
   `await sleep(backoff)`.

   That is precisely the bug #313 extracted politeness.mjs to kill: a private
   sleep quiets THIS probe while every other request to the same host keeps
   firing inside the window the publisher asked for silence. Passing the
   response to the shared helper is what pushes the gate for the whole host. */
test('a 429 goes to the shared waitBeforeRetry, with the response attached', async () => {
  const calls = [];
  const fetchImpl = async () => res({}, { status: 429 });
  await probeEpisode('https://slow.test/a.mp3', 2000000, {
    fetchImpl,
    gate: async () => 0,
    maxAttempts: 2,
    retryWait: (url, response, attempt) => { calls.push({ url, status: response && response.status, attempt }); return 0; },
  });
  assert.equal(calls.length, 1, 'one retry, one hand-off to the shared gate');
  assert.equal(calls[0].url, 'https://slow.test/a.mp3', 'the HOST is what gets held, so it needs the url');
  assert.equal(calls[0].status, 429, 'without the response, Retry-After cannot be read at all');
});

/* MUTATION: pass `null` instead of `res` to `retryWait`. The wait then falls
   back to our own 2000ms backoff and ignores what the host actually asked for,
   which is how a 60-second Retry-After becomes fifty more requests. */
test('Retry-After is honoured end to end, through the real gate', async () => {
  resetHostGates();
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); };
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    return n === 1
      ? res({ 'retry-after': '5' }, { status: 429 })
      : res({ 'content-range': 'bytes 0-1/2000000' });
  };
  const p = await probeEpisode('https://retry.test/a.mp3', 2000000, { fetchImpl, sleep });
  assert.equal(p.attempts, 2);
  assert.ok(
    slept.some((ms) => ms >= 4500 && ms <= 5500),
    `expected a ~5000ms wait from Retry-After: 5, got ${JSON.stringify(slept)}`,
  );
});

/* MUTATION: add 403 (or 404) to RETRYABLE_STATUS. A refusal is an answer;
   asking twice more spends a host's patience to learn exactly nothing, and on
   a host that refuses our UA it triples the requests that earned the refusal. */
test('a refusal is not retried, a hiccup is', async () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(403), false);
  assert.equal(isRetryableStatus(404), false);
  assert.equal(isRetryableStatus(200), false);
  assert.ok(!RETRYABLE_STATUS.has(403));

  let hits = 0;
  const fetchImpl = async () => { hits += 1; return res({}, { status: 403 }); };
  const p = await probeEpisode('https://refuses.test/a.mp3', 2000000, { fetchImpl, gate: async () => 0 });
  assert.equal(hits, 1, 'a 403 must cost exactly one request');
  assert.equal(p.attempts, 1);

  hits = 0;
  const flaky = async () => { hits += 1; return res({}, { status: 503 }); };
  await probeEpisode('https://flaky.test/a.mp3', 2000000, {
    fetchImpl: flaky, gate: async () => 0, retryWait: () => 0,
  });
  assert.equal(hits, 3, 'a 503 is worth the bounded retries');
});

/* ------------------------------------------------------------- the targets */

test('selectTargets only spends requests on shows that ship timed transcripts', () => {
  const discover = {
    items: [
      { show: 'Has Transcripts', audio_url: 'u1', audio_bytes: 10 },
      { show: 'Has Transcripts', audio_url: 'u2', audio_bytes: 10 },
      { show: 'No Transcripts', audio_url: 'u3', audio_bytes: 10 },
    ],
  };
  const availability = {
    shows: [
      { title: 'Has Transcripts', episodes_with_timed_transcript: 120, dai_suspected: true },
      { title: 'No Transcripts', episodes_with_timed_transcript: 0, dai_suspected: true },
    ],
  };
  const { byShow, timed } = selectTargets({ discover, availability });
  assert.deepEqual([...byShow.keys()], ['Has Transcripts']);
  assert.equal(timed.get('Has Transcripts').timedTranscripts, 120);
  assert.equal(timed.get('Has Transcripts').flaggedDai, true);
});

test('selectTargets caps episodes per show, because the median needs few', () => {
  const items = Array.from({ length: 9 }, (_, i) => ({ show: 'S', audio_url: `u${i}`, audio_bytes: 10 }));
  const availability = { shows: [{ title: 'S', episodes_with_timed_transcript: 5 }] };
  const { byShow } = selectTargets({ discover: { items }, availability, perShow: 3 });
  assert.equal(byShow.get('S').length, 3);
});

test('selectTargets skips episodes with no declared length to divide by', () => {
  const discover = { items: [{ show: 'S', audio_url: 'u1' }, { show: 'S', audio_url: 'u2', audio_bytes: 10 }] };
  const availability = { shows: [{ title: 'S', episodes_with_timed_transcript: 1 }] };
  const { byShow } = selectTargets({ discover, availability });
  assert.equal(byShow.get('S').length, 1);
  assert.equal(byShow.get('S')[0].audio_url, 'u2');
});

test('selectTargets accepts a bare-array discover.json as well as {items}', () => {
  const availability = { shows: [{ title: 'S', episodes_with_timed_transcript: 1 }] };
  const { byShow } = selectTargets({
    discover: [{ show: 'S', audio_url: 'u1', audio_bytes: 10 }],
    availability,
  });
  assert.equal(byShow.get('S').length, 1);
});

/* ------------------------------------------------------------ the verdicts */

const classFixture = () => ({
  built_at: '2026-01-01T00:00:00.000Z',
  shows: {
    111: { show: 'Clean Show', dai: true, reason: 'host:megaphone.fm', resolved_host: 'megaphone.fm' },
    222: { show: 'Ad Show', dai: true, reason: 'host:megaphone.fm', resolved_host: 'megaphone.fm' },
  },
});

/* MUTATION: have applyVerdicts also set `shows[key].dai = r.verdict !== 'ad-free'`.

   It looks like the helpful thing to do and it is silently self-erasing:
   `classify-dai.mjs --reclassify` recomputes `dai` from the host list on every
   run and touches nothing else, so the measured verdict would survive until the
   next nightly and then quietly revert. The two fields answer different
   questions -- `dai` is who COULD inject, `ad_inflation` is who DOES. */
test('applyVerdicts writes beside the host flag, never into it', () => {
  const c = classFixture();
  applyVerdicts(c, [
    { show: 'Clean Show', apple_collection_id: 111, verdict: 'ad-free', median: 1.0004, n: 5, samples: [] },
  ], { measuredAt: '2026-08-23T00:00:00.000Z' });

  assert.equal(c.shows[111].dai, true, 'the host-derived flag is not ours to overwrite');
  assert.equal(c.shows[111].reason, 'host:megaphone.fm');
  assert.equal(c.shows[111].ad_inflation.verdict, 'ad-free');
  assert.equal(c.shows[111].ad_inflation.median_ratio, 1);
  assert.equal(c.shows[111].ad_inflation.episodes_probed, 5);
  assert.equal(c.shows[111].ad_inflation.measured_at, '2026-08-23T00:00:00.000Z');
});

test('applyVerdicts rounds the ratio for the record but keeps it honest', () => {
  const c = classFixture();
  applyVerdicts(c, [{ show: 'Ad Show', apple_collection_id: 222, verdict: 'injected', median: 1.2713456, n: 5, samples: [] }]);
  assert.equal(c.shows[222].ad_inflation.median_ratio, 1.271);
});

/* MUTATION: change the `!shows[key]` guard to create the entry instead of
   counting it. A verdict attached to a show the classifier has never resolved
   is a row with no host, no `dai` and no `checked_at` -- it looks like a
   classification and is not one. */
test('applyVerdicts refuses to invent a show the classifier has not seen', () => {
  const c = classFixture();
  const { written, unkeyed } = applyVerdicts(c, [
    { show: 'Clean Show', apple_collection_id: 111, verdict: 'ad-free', median: 1.0, n: 3, samples: [] },
    { show: 'Ghost', apple_collection_id: 999, verdict: 'ad-free', median: 1.0, n: 3, samples: [] },
    { show: 'No Id', apple_collection_id: null, verdict: 'unknown', median: null, n: 0, samples: [] },
  ]);
  assert.equal(written, 1);
  assert.equal(unkeyed, 2);
  assert.equal(c.shows[999], undefined);
  assert.equal(Object.keys(c.shows).length, 2);
});

test('applyVerdicts carries the "could not tell" reason into the record', () => {
  const c = classFixture();
  applyVerdicts(c, [
    { show: 'Clean Show', apple_collection_id: 111, verdict: 'unknown', median: null, n: 0, note: 'because reasons', samples: [] },
  ]);
  assert.equal(c.shows[111].ad_inflation.verdict, 'unknown');
  assert.equal(c.shows[111].ad_inflation.note, 'because reasons');
});

/* MUTATION: make adFreeShows return every show whose verdict is not
   'injected'. "Unknown" would then be treated as permission, which is the one
   direction this measurement must never fail in. */
test('adFreeShows admits only a measured ad-free verdict', () => {
  const c = classFixture();
  c.shows[333] = { show: 'Unmeasured', dai: true };
  c.shows[444] = { show: 'Could Not Tell', dai: true, ad_inflation: { verdict: 'unknown' } };
  applyVerdicts(c, [
    { show: 'Clean Show', apple_collection_id: 111, verdict: 'ad-free', median: 1.0, n: 5, samples: [] },
    { show: 'Ad Show', apple_collection_id: 222, verdict: 'injected', median: 1.2, n: 5, samples: [] },
  ]);
  assert.deepEqual(adFreeShows(c), ['Clean Show']);
  assert.deepEqual(adFreeShows({}), []);
  assert.deepEqual(adFreeShows(null), []);
});

/* MUTATION: measure a new ad-free show and forget to add it to
   AD_FREE_SHOWS -- or delete a title from that list.

   The list in fetch-transcripts.mjs decides which DAI-flagged shows may be
   fetched and anchored; the verdicts in data/dai-classification.json are the
   measurement it claims to be a cache of. Two hand-maintained copies of one
   measurement is the drift this repo has now paid for three times
   (#211/#219/#249, politeness in #313, and the User-Agent above). This test is
   the only thing making them one. */
test('AD_FREE_SHOWS is exactly what the committed measurement says it is', () => {
  const classification = JSON.parse(readFileSync(join(ROOT, 'data', 'dai-classification.json'), 'utf8'));
  const measured = adFreeShows(classification);
  assert.ok(measured.length > 0, 'the committed classification carries no ad-free verdict at all');
  assert.deepEqual(
    [...AD_FREE_SHOWS].sort(),
    measured,
    'update AD_FREE_SHOWS from `node tools/transcribe/ad-inflation.mjs` output',
  );
});

test('every committed verdict carries the evidence behind it', () => {
  const classification = JSON.parse(readFileSync(join(ROOT, 'data', 'dai-classification.json'), 'utf8'));
  const measured = Object.values(classification.shows).filter((s) => s.ad_inflation);
  assert.ok(measured.length >= 27, `only ${measured.length} shows carry a measurement`);
  for (const s of measured) {
    const m = s.ad_inflation;
    assert.ok(['ad-free', 'injected', 'unknown'].includes(m.verdict), `${s.show}: bad verdict ${m.verdict}`);
    assert.ok(m.measured_at, `${s.show}: no measured_at`);
    assert.ok(Array.isArray(m.samples), `${s.show}: no samples array`);
    assert.equal(m.episodes_probed, m.samples.filter((x) => typeof x.ratio === 'number').length,
      `${s.show}: episodes_probed disagrees with the samples`);
    if (m.verdict !== 'unknown') {
      assert.equal(typeof m.median_ratio, 'number', `${s.show}: a decided verdict with no ratio`);
      assert.equal(classify(m.median_ratio), m.verdict, `${s.show}: verdict does not follow from its own ratio`);
    }
  }
});
