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
// Usage:
//   node tools/transcribe/ad-inflation.mjs [--per-show N] [--out FILE] [--all]
// By default it scans only shows that ship timed transcripts, because those are
// the ones where the answer pays out.

export const STANDARD_UA =
  'ForayBot/0.1 (ad-inflation scan; +https://github.com/JW-Incorporated/foray; wjduvall@gmail.com)';

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

export function classify(ratio) {
  if (ratio == null) return 'unknown';
  return ratio < AD_FREE_THRESHOLD ? 'ad-free' : 'injected';
}

/** Median is the right summary: one odd episode should not reclassify a show. */
export function summariseShow(ratios) {
  const clean = ratios.filter((r) => typeof r === 'number' && Number.isFinite(r)).sort((a, b) => a - b);
  if (!clean.length) return { median: null, n: 0, verdict: 'unknown' };
  const median = clean.length % 2
    ? clean[(clean.length - 1) / 2]
    : (clean[clean.length / 2 - 1] + clean[clean.length / 2]) / 2;
  return { median, n: clean.length, verdict: classify(median) };
}

/** Probe one enclosure. Injected so tests never touch the network. */
export async function probeEpisode(url, declaredBytes, { fetchImpl = fetch, ua = STANDARD_UA } = {}) {
  const res = await fetchImpl(url, {
    method: 'GET',
    redirect: 'follow',
    headers: { 'user-agent': ua, range: 'bytes=0-1' },
  });
  const total =
    parseContentRangeTotal(res.headers.get('content-range')) ??
    Number(res.headers.get('content-length'));
  if (res.body && typeof res.body.cancel === 'function') await res.body.cancel();
  return inflationRatio(total, declaredBytes);
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
