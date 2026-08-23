/* Classify every show's DAI status and stamp `dai_suspected` onto the
   catalogue. One-shot + re-runnable; see tools/refresh/dai.mjs for why the
   host list is the only signal.

   Usage:
     node tools/refresh/classify-dai.mjs --dry-run
     node tools/refresh/classify-dai.mjs
     node tools/refresh/classify-dai.mjs --recheck     # re-resolve cached shows
     node tools/refresh/classify-dai.mjs --reclassify  # re-apply the host list, no network

   Classification is cached per SHOW in data/dai-classification.json, keyed by
   apple_collection_id — ad stitching is a publisher-level choice, so there is
   no reason to resolve per episode. A normal re-run resolves nothing it has
   already seen, which keeps the nightly's cost at zero.                      */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classifyShow, daiHostIn, daiReason, mergeShowEntry } from "./dai.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const RECHECK = args.includes("--recheck");
// The host list is the maintenance lever and gets edited whenever we learn
// something. Re-resolving 213 shows over the network just to apply a one-line
// list change would be absurd, so --reclassify re-evaluates the hosts already
// cached and touches nothing external.
const RECLASSIFY = args.includes("--reclassify");
const THROTTLE_MS = 700;

const CLASS_PATH = join(ROOT, "data", "dai-classification.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const discover = JSON.parse(readFileSync(join(ROOT, "data", "discover.json"), "utf8"));
const session = JSON.parse(readFileSync(join(ROOT, "data", "session.json"), "utf8"));
const cache = existsSync(CLASS_PATH)
  ? JSON.parse(readFileSync(CLASS_PATH, "utf8"))
  : { built_at: null, shows: {} };

// One sample episode per show is enough — DAI is a publisher-level choice.
const sampleByShow = new Map();
for (const i of discover.items) {
  if (!i.audio_url || !i.apple_collection_id) continue;
  if (!sampleByShow.has(i.apple_collection_id)) {
    sampleByShow.set(i.apple_collection_id, { url: i.audio_url, show: i.show });
  }
}
for (const e of Object.values(session.episodes)) {
  if (!e.audio_url || !e.apple_collection_id) continue;
  if (!sampleByShow.has(e.apple_collection_id)) {
    sampleByShow.set(e.apple_collection_id, { url: e.audio_url, show: e.show });
  }
}

/** The hosts a cached entry lets us judge it on, WITHOUT a request.

    An entry written before the chain fix has only `resolved_host` — the last
    hop — so that is all `--reclassify` can offer it, and a Spreaker show cached
    that way stays `unknown` until something re-resolves it. That is the honest
    behaviour rather than a gap: this mode exists to apply the current host list
    to the evidence on file, and inventing chain hops it never recorded would be
    the opposite. `--recheck` is the mode that goes and gets the chain. */
function cachedHosts(entry) {
  if (Array.isArray(entry.resolved_chain) && entry.resolved_chain.length) return entry.resolved_chain;
  return entry.resolved_host ? [entry.resolved_host] : [];
}

if (RECLASSIFY) {
  let flipped = 0;
  for (const [cid, entry] of Object.entries(cache.shows)) {
    if (!entry.resolved_host) continue;
    const via = daiHostIn(cachedHosts(entry));
    const dai = !!via;
    if (dai !== entry.dai) {
      const where = via && via !== entry.resolved_host ? `${via} -> ${entry.resolved_host}` : entry.resolved_host;
      console.log(`  ${entry.dai ? "DAI -> static" : "static -> DAI"}  ${entry.show.slice(0, 38).padEnd(39)} ${where}`);
      entry.dai = dai;
      entry.reason = daiReason(via, entry.resolved_host, null);
      flipped++;
    }
  }
  console.log(`reclassified from the current host list: ${flipped} show(s) changed
`);
}

const todo = RECLASSIFY ? [] : [...sampleByShow.entries()].filter(([cid]) => RECHECK || !cache.shows[cid]);
console.log(`${sampleByShow.size} show(s) with audio; ${todo.length} to resolve\n`);

let n = 0;
for (const [cid, { url, show }] of todo) {
  n++;
  await sleep(THROTTLE_MS);
  const verdict = await classifyShow(url);
  cache.shows[cid] = mergeShowEntry(cache.shows[cid], show, verdict);
  console.log(`[${n}/${todo.length}] ${verdict.dai ? "DAI  " : "     "} ${show.slice(0, 40).padEnd(41)} ${verdict.resolved_host || "?"}`);
}

// Stamp the flag onto every item that has audio. Items with no audio_url get
// no flag — there is nothing to seek in, and a null there is meaningful.
let stamped = 0;
const flagFor = (cid) => (cache.shows[cid] ? cache.shows[cid].dai : false);
for (const i of discover.items) {
  if (!i.audio_url) { delete i.dai_suspected; continue; }
  i.dai_suspected = flagFor(i.apple_collection_id);
  stamped++;
}
for (const e of Object.values(session.episodes)) {
  if (!e.audio_url) { delete e.dai_suspected; continue; }
  e.dai_suspected = flagFor(e.apple_collection_id);
  stamped++;
}

const daiShows = Object.values(cache.shows).filter((s) => s.dai).length;
const daiItems = [...discover.items, ...Object.values(session.episodes)].filter((i) => i.dai_suspected).length;

console.log(`\n${"=".repeat(58)}`);
console.log(`shows classified : ${Object.keys(cache.shows).length} (${daiShows} DAI, ${Object.keys(cache.shows).length - daiShows} static/unknown)`);
console.log(`items stamped    : ${stamped} (${daiItems} dai_suspected, ${stamped - daiItems} precise-seek eligible)`);

const byHost = {};
for (const s of Object.values(cache.shows)) {
  const k = (s.resolved_host || "?") + (s.dai ? "  [DAI]" : "");
  byHost[k] = (byHost[k] || 0) + 1;
}
console.log("\nresolved origins:");
Object.entries(byHost).sort((a, b) => b[1] - a[1]).slice(0, 14)
  .forEach(([h, c]) => console.log(`  ${String(c).padStart(4)}  ${h}`));

if (DRY) {
  console.log("\n--dry-run: no files written.");
} else {
  cache.built_at = new Date().toISOString();
  writeFileSync(CLASS_PATH, JSON.stringify(cache, null, 2) + "\n");
  discover.built_at = cache.built_at;
  writeFileSync(join(ROOT, "data", "discover.json"), JSON.stringify(discover, null, 2) + "\n");

  // session.json is hand-authored and its blocks are one per line — patch its
  // text rather than reformatting it (same reasoning as backfill-audio.mjs).
  const sPath = join(ROOT, "data", "session.json");
  let txt = readFileSync(sPath, "utf8");
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let patched = 0;
  for (const [id, e] of Object.entries(session.episodes)) {
    if (e.dai_suspected === undefined) continue;
    // UPDATE in place when the field already exists; insert only when it does
    // not. The obvious idempotence guard — skip any block that already has the
    // field — silently strands the old value whenever --reclassify flips a
    // show, which is precisely what that mode exists to do. The bug would only
    // ever surface as a stale flag in shipped data.
    const existing = new RegExp(`("${esc(id)}":\\s*\\{[^{}]*?"dai_suspected":\\s*)(?:true|false)`);
    if (existing.test(txt)) {
      txt = txt.replace(existing, `$1${e.dai_suspected}`);
      patched++;
      continue;
    }
    const re = new RegExp(`("${esc(id)}":\\s*\\{[^{}]*?"audio_bytes":\\s*(?:-?\\d+|null))`);
    if (!re.test(txt)) continue;
    txt = txt.replace(re, `$1, "dai_suspected": ${e.dai_suspected}`);
    patched++;
  }
  const reparsed = JSON.parse(txt); // refuse to write anything unparseable
  for (const [id, e] of Object.entries(session.episodes)) {
    if (e.dai_suspected === undefined) continue;
    if (reparsed.episodes[id].dai_suspected !== e.dai_suspected) {
      throw new Error(`session patch mismatch on ${id}`);
    }
  }
  writeFileSync(sPath, txt);
  console.log(`\nwrote data/dai-classification.json, data/discover.json, data/session.json (${patched} session blocks patched)`);
}
