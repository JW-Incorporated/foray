#!/usr/bin/env node
/* §4.8's "texture on a cadence" measurement (docs/curation/generation-
 * architecture.md §4.8, rule 3: "Propose a cadence, measure it against a
 * real long Foray, and write down what you measured — do not ship a number
 * that was guessed.")
 *
 * WHAT THIS MEASURES: the real gap, in seconds, between "cuts" in
 * `data/forays.json`'s `grilling-history-1` Foray — the one ~61-minute,
 * 32-segment, real assembled Foray this repo has (3673.03 s runtime, per
 * its own committed `runtime_sec`; NOT `grilling-history-2`, a smaller
 * superseded edit). A "cut" here means a transition from one segment to
 * the next where the underlying episode (`item_id`) actually changes —
 * exactly the transition §4.8's rule 2 says the jingle marks. The gap is
 * the elapsed playback time between one cut and the next (i.e. the
 * duration of everything played between two consecutive cuts, including
 * same-episode silent-bridge segments run together).
 *
 * grilling-history-1 carries no narration or jingle items at all (it
 * predates this pipeline), so every gap here is a pure same-episode-vs-
 * cross-episode measurement with nothing else contributing to the clock —
 * the cleanest baseline this repo has for "how far apart do real cuts
 * fall when a human curator, not a jingle-cadence rule, decided the
 * order."
 *
 * USAGE
 *   node tools/foray/measure-cadence.mjs
 * Prints the per-cut gaps, and the median/mean, to stdout. The MEASURED
 * median (155.34 s, computed by an actual run of this script against the
 * committed data as of this writing) is hardcoded as `TEXTURE_CADENCE_SEC`
 * in `backend/src/generation/stitchAct.ts` — re-run this script and update
 * that constant (with its own doc comment) if `grilling-history-1` is ever
 * re-curated.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function computeCadence(foraysFile, segmentsFile, forayId = "grilling-history-1") {
  const segById = new Map(segmentsFile.segments.map((s) => [s.id, s]));
  const foray = foraysFile.forays.find((f) => f.id === forayId);
  if (!foray) throw new Error(`Foray "${forayId}" not found`);

  let t = 0;
  let lastCutTime = 0;
  const cutGaps = [];
  let lastItemId = null;

  for (const item of foray.items) {
    if (item.type !== "segment") continue;
    const seg = segById.get(item.segment_id);
    if (!seg) throw new Error(`segment_id "${item.segment_id}" not found in data/segments.json`);
    const dur = seg.end_sec - seg.start_sec;
    if (lastItemId !== null && seg.item_id !== lastItemId) {
      cutGaps.push(t - lastCutTime);
      lastCutTime = t;
    }
    t += dur;
    lastItemId = seg.item_id;
  }
  cutGaps.push(t - lastCutTime); // trailing gap to the end of the Foray

  const sorted = [...cutGaps].sort((a, b) => a - b);
  const n = sorted.length;
  const median = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const mean = cutGaps.reduce((a, b) => a + b, 0) / n;

  return { totalRuntimeSec: t, cutGaps, median, mean };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const forays = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "data/forays.json"), "utf8"));
  const segments = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "data/segments.json"), "utf8"));
  const { totalRuntimeSec, cutGaps, median, mean } = computeCadence(forays, segments);
  console.log(`grilling-history-1: total tape runtime ${totalRuntimeSec.toFixed(2)} s, ${cutGaps.length} cut-gaps`);
  console.log(`cut gaps (s): ${cutGaps.map((g) => g.toFixed(1)).join(", ")}`);
  console.log(`median cut gap: ${median.toFixed(2)} s`);
  console.log(`mean cut gap:   ${mean.toFixed(2)} s`);
}
