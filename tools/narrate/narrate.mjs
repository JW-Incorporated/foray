#!/usr/bin/env node
/* The dry-run narration CLI (#247 item 11). Calls nothing.
 *
 *   node tools/narrate/narrate.mjs --project
 *       What a fully narrated Foray costs, and ten of them. Needs no scripts,
 *       which is the state of the repo today: zero narration items exist in
 *       data/forays.json.
 *
 *   node tools/narrate/narrate.mjs <scripts.json> [--voice ID] [--model ID]
 *       Exact per-beat and per-Foray character counts for scripts that exist.
 *       `scripts.json` is `{ "id": "...", "beats": [ { "id": "...", "text": "..." } ] }`
 *       or a bare array of those beats.
 *
 *   node tools/narrate/narrate.mjs <scripts.json> --cache <index.json>
 *       Same, against a cache index, so the report shows what a RE-RUN bills —
 *       which for an unchanged script is zero.
 *
 * There is deliberately no `--synthesize`. Spending is a founder decision and
 * this file is not the place it gets made; `adapter.mjs`'s `synthesize()` needs
 * an explicit key from a caller that has one.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapter, costOf, DEFAULT_MODEL_ID, DEFAULT_OUTPUT_FORMAT } from "./adapter.mjs";
import { NarrationCache } from "./cache.mjs";
import { projectForay, tierFor, SPINE, BUDGETS } from "./projection.mjs";
import { CHARS_PER_MIN_MEASURED, CHARS_PER_MIN_LOW, CHARS_PER_MIN_HIGH, mp3Bytes } from "./billable.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PRICING = JSON.parse(fs.readFileSync(path.join(HERE, "pricing.json"), "utf8"));

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
const usd = (n) => `$${n.toFixed(2)}`;
const mins = (sec) => `${(sec / 60).toFixed(1)} min`;
const n = (x) => x.toLocaleString("en-US");

/** Per-beat and per-Foray counts for scripts that exist. */
export function reportScripts(doc, { voiceId, modelId, outputFormat, cacheIndex } = {}) {
  const beats = Array.isArray(doc) ? doc : (doc?.beats ?? []);
  const cache = new NarrationCache(cacheIndex ?? {});
  const adapter = createAdapter({ voiceId, modelId, outputFormat, cache });
  const { beats: planned, totals } = adapter.planForay(beats);

  const lines = [];
  lines.push(`Foray: ${(Array.isArray(doc) ? "(unnamed)" : doc?.id) ?? "(unnamed)"}`);
  lines.push(`Voice ${voiceId} · model ${modelId} · format ${outputFormat} · DRY RUN, nothing called`);
  lines.push("");
  lines.push("beat                             chars    billed   est dur  cache");
  for (const b of planned) {
    lines.push(
      `${String(b.id ?? "?").slice(0, 30).padEnd(32)}` +
      `${String(n(b.chars)).padStart(6)}` +
      `${String(n(b.billedChars)).padStart(10)}` +
      `${(b.estDurationSec.toFixed(1) + "s").padStart(10)}` +
      `  ${b.cached ? "HIT" : "miss"}` +
      `${b.empty ? "  [EMPTY SCRIPT]" : ""}` +
      `${b.nonAsciiCount ? `  [${b.nonAsciiCount} non-ascii: ${b.nonAsciiSamples.join("")}]` : ""}`
    );
  }
  const c = costOf(totals.billedChars, PRICING);
  lines.push("");
  lines.push(`${totals.beats} beats · ${n(totals.chars)} characters · ${mins(totals.estDurationSec)} estimated`);
  lines.push(`BILLABLE this run: ${n(totals.billedChars)} characters (${totals.cachedBeats} of ${totals.beats} beats served from cache)`);
  lines.push(`  ${n(c.creditsLow)}-${n(c.creditsHigh)} credits · ~${usd(c.usd)} at the API rate`);
  if (totals.emptyBeats) lines.push(`  ${totals.emptyBeats} beat(s) have EMPTY scripts and would generate nothing`);
  return { text: lines.join("\n"), totals, beats: planned };
}

/** The projection: no scripts needed. */
export function reportProjection({ forays = 10, regenFactor = 3, kbps = 64 } = {}) {
  const one = projectForay({ regenFactor, kbps }, PRICING);
  const lines = [];

  lines.push("A FULLY NARRATED FORAY — projection, not a measurement");
  lines.push(`Inventory: ${SPINE.emptyBeats} empty + ${SPINE.thinBeats} thin beats, ${one.items.bridgeItems} cross-episode bridges (rule X1, after absorption)`);
  lines.push(`Budgets:   ${BUDGETS.emptyBeatSec}s empty, ${BUDGETS.thinBeatSec}s thin, ${BUDGETS.bridgeSec}s bridge, ${BUDGETS.padSecPerItem}s pad per item`);
  lines.push(`Rate:      ${one.charsPerMin} chars/min`);
  lines.push("");
  lines.push(`  narration audio        ${mins(one.seconds.audioSec)}  (${mins(one.seconds.speechSec)} of speech)`);
  lines.push(`  characters             ${n(one.chars)}`);
  lines.push(`  with ${regenFactor}x regeneration  ${n(one.charsWithRegen)}`);
  lines.push(`  bytes at ${one.kbps} kbps      ${mb(one.bytes)}`);
  lines.push(`  cost, one pass         ${n(one.cost.creditsLow)}-${n(one.cost.creditsHigh)} credits · ~${usd(one.cost.usd)}`);
  lines.push(`  cost, ${regenFactor}x              ${n(one.costWithRegen.creditsLow)}-${n(one.costWithRegen.creditsHigh)} credits · ~${usd(one.costWithRegen.usd)}`);
  lines.push("");

  const many = {
    chars: one.charsWithRegen * forays,
    bytes: one.bytes * forays,
    cost: costOf(one.charsWithRegen * forays, PRICING),
  };
  lines.push(`${forays} FORAYS at ${regenFactor}x regeneration`);
  lines.push(`  characters             ${n(many.chars)}`);
  lines.push(`  bytes at ${one.kbps} kbps      ${mb(many.bytes)}`);
  lines.push(`  cost                   ${n(many.cost.creditsLow)}-${n(many.cost.creditsHigh)} credits · ~${usd(many.cost.usd)}`);
  const t = tierFor(many.cost.creditsHigh, PRICING);
  const tr = tierFor(many.cost.creditsHigh, PRICING, { useRollover: true });
  lines.push(`  cheapest sufficient tier in ONE month: ${t ? `${t.id} at ${usd(t.price_usd_month)}/mo (${n(t.credits_per_month)} credits)` : "none — needs Enterprise or spreading over months"}`);
  if (tr && t && tr.id !== t.id) lines.push(`  with rollover (3x quota):              ${tr.id} at ${usd(tr.price_usd_month)}/mo`);
  lines.push("");

  lines.push("SENSITIVITY — the chars-per-minute rate is the biggest single unknown");
  lines.push("rate      chars/Foray   cost/Foray(1x)   10 Forays at 3x");
  const rates = [...new Set([CHARS_PER_MIN_LOW, 840, CHARS_PER_MIN_MEASURED, CHARS_PER_MIN_HIGH, PRICING.provider_implied_rate.credits_per_minute])].sort((a, b) => a - b);
  for (const rate of rates) {
    const p = projectForay({ charsPerMin: rate, regenFactor, kbps }, PRICING);
    const m = costOf(p.charsWithRegen * forays, PRICING);
    lines.push(
      `${String(rate).padEnd(10)}${String(n(p.chars)).padStart(11)}${("~" + usd(p.cost.usd)).padStart(17)}${("~" + usd(m.usd)).padStart(18)}` +
      (rate === 840 ? "   <- the #247 sketch" : rate === PRICING.provider_implied_rate.credits_per_minute ? "   <- the provider's own implied rate" : "")
    );
  }
  lines.push("");
  lines.push("BITRATE — the hosting question, not the spend one");
  lines.push("kbps    one Foray   10 Forays");
  for (const k of [32, 64, 96, 128]) {
    const bytes = mp3Bytes(one.seconds.audioSec, k);
    lines.push(`${String(k).padEnd(8)}${mb(bytes).padStart(9)}${mb(bytes * forays).padStart(12)}`);
  }
  lines.push("");
  lines.push("CAVEATS");
  for (const c of one.caveats) lines.push(`  - ${c}`);
  lines.push(`  - pricing verified ${PRICING.verified_at}; ${PRICING.credit_per_character.api_note.split(".")[0]}.`);
  return { text: lines.join("\n"), one, many };
}

function main(argv) {
  const args = argv.slice(2);
  if (!args.length || args.includes("--help")) {
    console.log("usage: narrate.mjs --project | narrate.mjs <scripts.json> [--voice ID] [--model ID] [--cache index.json]");
    return 0;
  }
  const flag = (name, dflt) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
  };
  if (args.includes("--project")) {
    console.log(reportProjection({
      forays: Number(flag("--forays", 10)),
      regenFactor: Number(flag("--regen", 3)),
      kbps: Number(flag("--kbps", 64)),
    }).text);
    return 0;
  }
  /* The first bare argument that is not a flag's value. Walked by INDEX rather
     than found by value: `args.indexOf(a)` returns the FIRST occurrence, so a
     value that repeats an earlier token (`--voice narrator --model narrator`)
     made the previous-token test consult the wrong position. */
  let file = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) { i++; continue; }
    file = args[i];
    break;
  }
  if (!file) { console.error("no scripts file given"); return 1; }
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  const cachePath = flag("--cache", null);
  console.log(reportScripts(doc, {
    voiceId: flag("--voice", "VOICE_ID_UNSET"),
    modelId: flag("--model", DEFAULT_MODEL_ID),
    outputFormat: flag("--format", DEFAULT_OUTPUT_FORMAT),
    cacheIndex: cachePath && fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : null,
  }).text);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exit(main(process.argv));
}
