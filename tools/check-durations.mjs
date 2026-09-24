/* ONE LENGTH PER EPISODE (audit round 2, honesty-1). The catalogue carries two:
   `duration_min`, often Apple's rounded listing length, and `duration_sec`,
   the seconds the player's clock and every "left" label count against. A feed
   that re-published with a different ad load moves one and not the other, and
   for 19 shipped items they disagreed by a minute or more — one row read
   "45 min · 53 min left", because its progress label counts against the
   measured length. app.js's `episodeMinutes` now prints the measured length
   whenever there are seconds; this gate keeps the data from drifting again, so the
   fallback (`duration_min` for an item never measured) is the only place the
   feed's number is ever read.

   Hard failure (exit 1): any item, in data/discover.json or data/session.json,
   carrying both fields with |duration_min - duration_sec/60| >= 1.

   Usage: node tools/check-durations.mjs */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The minute count an item with a measured length must carry — the one rule
    tools/refresh/merge.mjs writes new items with, so the gate and the writer
    cannot disagree. `null` when nothing was measured: the caller keeps the
    feed's number. */
export function minutesFromSeconds(sec) {
  const s = Number(sec);
  return s > 0 ? Math.round(s / 60) : null;
}

/** Every item whose two lengths disagree by a minute or more. */
export function durationDrift(items) {
  const out = [];
  for (const it of items || []) {
    const sec = Number(it?.duration_sec);
    const min = Number(it?.duration_min);
    if (!(sec > 0 && min > 0)) continue;
    if (Math.abs(min - sec / 60) >= 1) out.push({ id: it.id, duration_min: min, duration_sec: sec });
  }
  return out;
}

/** The committed pool, both files, as items with their ids. */
export function committedItems(root = ROOT) {
  const discover = JSON.parse(readFileSync(join(root, "data/discover.json"), "utf8"));
  const session = JSON.parse(readFileSync(join(root, "data/session.json"), "utf8"));
  return [
    ...(discover.items || []),
    ...Object.entries(session.episodes || {}).map(([id, ep]) => ({ id, ...ep })),
  ];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const drift = durationDrift(committedItems());
  if (drift.length) {
    console.error(`${drift.length} item(s) carry two lengths a minute or more apart:`);
    for (const d of drift) console.error(`  ${d.id}: duration_min ${d.duration_min}, duration_sec ${d.duration_sec} (${(d.duration_sec / 60).toFixed(1)} min)`);
    process.exit(1);
  }
  console.log("durations: every measured item's minute count agrees with its seconds");
}
