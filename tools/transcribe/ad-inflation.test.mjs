import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseContentRangeTotal, inflationRatio, classify, summariseShow,
  probeEpisode, selectTargets, isPlausibleAudioSize,
  AD_FREE_THRESHOLD, MIN_PLAUSIBLE_BYTES, STANDARD_UA,
} from './ad-inflation.mjs';

// The numbers in this file are not invented. They come from four episodes
// downloaded in full on 2026-08-15 and from the range headers of the same
// enclosures, which is what makes them worth asserting on.

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

test('probeEpisode asks for two bytes, follows redirects, and identifies itself', async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return {
      headers: new Map([['content-range', 'bytes 0-1/44961612']]),
      body: null,
    };
  };
  // node:test has no Headers polyfill concern here -- Map.get matches the shape used.
  const ratio = await probeEpisode('https://example.test/ep.mp3', 35549607, { fetchImpl });
  assert.equal(seen.opts.method, 'GET');
  assert.equal(seen.opts.headers.range, 'bytes=0-1');
  assert.equal(seen.opts.redirect, 'follow');
  assert.match(seen.opts.headers['user-agent'], /ForayBot/);
  assert.equal(ratio.toFixed(3), '1.265');
});

test('probeEpisode falls back to content-length when the host ignores Range', async () => {
  const fetchImpl = async () => ({
    headers: new Map([['content-length', '44961612']]),
    body: null,
  });
  const ratio = await probeEpisode('https://example.test/ep.mp3', 35549607, { fetchImpl });
  assert.equal(ratio.toFixed(3), '1.265');
});

test('probeEpisode drains the body so a ranged GET cannot leak a socket', async () => {
  let cancelled = false;
  const fetchImpl = async () => ({
    headers: new Map([['content-range', 'bytes 0-1/2000000']]),
    body: { cancel: async () => { cancelled = true; } },
  });
  await probeEpisode('https://example.test/ep.mp3', 2000000, { fetchImpl });
  assert.equal(cancelled, true);
});

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

test('the module states that HEAD cannot be substituted for the ranged GET', async () => {
  // This is the trap the whole tool exists to avoid: HEAD returns the ad-free
  // master length on DAI hosts and would report every show as ad-free.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./ad-inflation.mjs', import.meta.url), 'utf8');
  assert.match(src, /HEAD REQUESTS LIE/);
  assert.match(STANDARD_UA, /github\.com\/JW-Incorporated\/foray/);
});
