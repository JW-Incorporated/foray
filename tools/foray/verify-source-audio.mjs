#!/usr/bin/env node
/* Re-verify every audio_url in data/segment-sources.json against the live web.
 *
 * MANUAL, NEVER CI. This is the one thing in tools/foray/ that touches the
 * network, and it is deliberately not a test: CI must not go red because a
 * podcast CDN had a bad afternoon. Run it when you add a source, and when a
 * playback bug makes you doubt one.
 *
 * WHAT IT PROVES, AND WHY THAT
 *   1. HTTP 206 to a 2-byte ranged GET. 200 means the host ignored Range and
 *      is about to hand a player the whole file — a segment's in-point is a
 *      seek, so a host that cannot serve a range cannot serve a Foray.
 *      HEAD is not used: it lies on ad-inserting hosts (see the method note in
 *      docs/curation/grilling-asr-manifest.json).
 *   2. Content-Range's total against the recorded audio_bytes. A ratio above
 *      ~1.01 means bytes are being stitched in per request, i.e. dynamic ad
 *      insertion, i.e. every authored timestamp in that episode has drifted
 *      and dai_suspected is wrong (#22, #30).
 *
 * It downloads two bytes per episode and no audio (product principle #3).
 *
 *   node tools/foray/verify-source-audio.mjs
 *   node tools/foray/verify-source-audio.mjs --id bfh-griddle-bakestone
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUDIO_PROBE_HEADERS } from "../segments/politeness.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RATIO_CEILING = 1.01;

/* The Range, the User-Agent and the Accept-Language all come from
 * `tools/segments/politeness.mjs`, which records why each one is load-bearing:
 * Captivate 404s Node's default `accept-language: *`, and Buzzsprout 403s a
 * User-Agent carrying an extra product token. This file used to hold its own
 * copy of all three; `ad-inflation.mjs` held a second, drifted copy and was
 * being refused by Buzzsprout because of it. One definition now. */
const HEADERS = AUDIO_PROBE_HEADERS;

const only = (() => {
  const i = process.argv.indexOf("--id");
  return i >= 0 ? process.argv[i + 1] : null;
})();

const { sources } = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "data", "segment-sources.json"), "utf8"));
const targets = only ? sources.filter((s) => s.id === only) : sources;
if (targets.length === 0) {
  console.error(only ? `no source with id "${only}"` : "no sources to verify");
  process.exit(1);
}

let failures = 0;
for (const s of targets) {
  let line = `${s.id.padEnd(30)}`;
  try {
    const res = await fetch(s.audio_url, { headers: HEADERS, redirect: "follow" });
    const range = res.headers.get("content-range");
    const total = range ? Number(range.split("/").pop()) : NaN;
    const ratio = Number.isFinite(total) && s.audio_bytes ? total / s.audio_bytes : NaN;
    line += ` HTTP ${res.status}  total=${Number.isFinite(total) ? total : "?"}  declared=${s.audio_bytes}  ratio=${Number.isFinite(ratio) ? ratio.toFixed(4) : "?"}`;
    // Drain so the socket closes rather than waiting on the agent's timeout.
    await res.arrayBuffer().catch(() => {});
    if (res.status !== 206) { line += "  <-- FAIL: not 206"; failures++; }
    else if (!Number.isFinite(ratio)) { line += "  <-- FAIL: no parsable Content-Range"; failures++; }
    else if (ratio > RATIO_CEILING) { line += `  <-- FAIL: ad-inflated past ${RATIO_CEILING}`; failures++; }
  } catch (e) {
    line += `  <-- FAIL: ${e.message}`;
    failures++;
  }
  console.log(line);
}

console.log(failures === 0 ? `all ${targets.length} verified` : `${failures}/${targets.length} FAILED`);
process.exit(failures === 0 ? 0 : 1);
