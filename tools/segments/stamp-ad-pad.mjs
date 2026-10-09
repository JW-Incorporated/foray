/* Write ADR-0008 pads onto data/segment-sources.json from the probe ledger
   (DAI-03, docs/roadmap/dai.md).

   THE ONLY WRITER of the seven stamped `ad_*` fields (STAMPED_FIELDS). Each
   source row whose `id` has probes in data/ad-pad-probes.json is handed to
   ad-pad.mjs's padFromProbes with the row's own `duration_sec` as the
   reference — check-forays holds that number within 2 s of every segment's
   `reference_duration_sec`, so it IS the duration the anchors were timed
   against. A refusal (n<2, an untrusted ranged-GET host, an undersized
   delivery, no duration) leaves the row exactly as it was and is listed.

   WHAT IT NEVER DOES:
   - invent a row: a ledger item_id with no source row is reported, not added;
   - touch a row the ledger does not name: the hand-authored `ad_*` rows keep
     every value;
   - write or remove `ad_free_ratio`: a legacy field from the ad-inflation scan,
     deliberately absent from STAMPED_FIELDS and ignored by --check.

   --check is the reproducibility gate: every stamped field on a row the ledger
   names must be what the ledger recomputes today. It mirrors the writer, so a
   row the writer would refuse is skipped there too (the writer would leave it
   untouched), and `stamp` followed by `--check` is always silent.

     node tools/segments/stamp-ad-pad.mjs            # write
     node tools/segments/stamp-ad-pad.mjs --dry-run  # print, write nothing
     node tools/segments/stamp-ad-pad.mjs --check    # exit 1 on any drift

   Paths: AD_PAD_LEDGER (default data/ad-pad-probes.json) and SEGMENT_SOURCES
   (default data/segment-sources.json); an env path resolves against the cwd. */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import { groupProbesByItem, padFromProbes } from "./ad-pad.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const STAMPED_FIELDS = Object.freeze([
  "ad_delta_sec",
  "ad_delta_probes",
  "ad_delta_spread_sec",
  "ad_pad_sec",
  "ad_tier",
  "ad_pad_method",
  "ad_pad_measured_at",
]);

const tenth = (x) => Math.round(x * 10) / 10;

function rowsOf(sourcesDoc) {
  if (!sourcesDoc || !Array.isArray(sourcesDoc.sources)) {
    throw new TypeError("segment-sources doc has no `sources` array");
  }
  return sourcesDoc.sources;
}

/** The seven stamped values for one row, or why the row gets none. */
function recompute(row, probes) {
  const ref = row.duration_sec;
  if (!(typeof ref === "number" && Number.isFinite(ref) && ref > 0)) return { refused: "no duration_sec" };
  const r = padFromProbes(probes, { referenceDurationSec: ref });
  if ("refused" in r) return { refused: r.refused };
  return {
    fields: {
      ad_delta_sec: r.delta_max_sec,
      ad_delta_probes: r.n,
      ad_delta_spread_sec: r.spread_sec,
      ad_pad_sec: r.pad_sec,
      ad_tier: r.tier,
      ad_pad_method: r.method,
      ad_pad_measured_at: r.measured_at,
    },
    n: r.n,
  };
}

/** Stamp every ledger-named row. The input doc is not mutated. */
export function stampSources(sourcesDoc, ledger) {
  rowsOf(sourcesDoc);
  const doc = structuredClone(sourcesDoc);
  const byId = new Map();
  for (const row of doc.sources) {
    if (row && typeof row.id === "string" && !byId.has(row.id)) byId.set(row.id, row);
  }
  const stamped = [];
  const refused = [];
  const untouched = [];
  for (const [itemId, probes] of groupProbesByItem(ledger)) {
    const row = byId.get(itemId);
    if (!row) {
      untouched.push(itemId);
      continue;
    }
    const r = recompute(row, probes);
    if (r.refused) {
      refused.push({ item_id: itemId, reason: r.refused });
      continue;
    }
    // Assigning an existing key keeps its position; a new key appends.
    for (const field of STAMPED_FIELDS) row[field] = r.fields[field];
    stamped.push(itemId);
  }
  return { doc, stamped, refused, untouched };
}

function same(committed, recomputed) {
  if (typeof committed === "number" && typeof recomputed === "number") return tenth(committed) === tenth(recomputed);
  return committed === recomputed;
}

/** Every stamped field on a ledger-named row that the ledger does not reproduce. */
export function checkSources(sourcesDoc, ledger) {
  const rows = rowsOf(sourcesDoc);
  const drift = [];
  for (const [itemId, probes] of groupProbesByItem(ledger)) {
    const row = rows.find((s) => s && s.id === itemId);
    if (!row) continue;
    const r = recompute(row, probes);
    if (r.refused) continue; // the writer leaves this row untouched; so does the check
    for (const field of STAMPED_FIELDS) {
      if (!same(row[field], r.fields[field])) {
        drift.push({ item_id: itemId, field, committed: row[field], recomputed: r.fields[field] });
      }
    }
  }
  return drift;
}

/** The on-disk form: 2-space JSON, trailing newline, key order as given. */
export function serialise(doc) {
  return JSON.stringify(doc, null, 2) + "\n";
}

function main(argv) {
  const flags = new Set(argv);
  const ledgerPath = process.env.AD_PAD_LEDGER
    ? resolvePath(process.cwd(), process.env.AD_PAD_LEDGER)
    : join(ROOT, "data", "ad-pad-probes.json");
  const sourcesPath = process.env.SEGMENT_SOURCES
    ? resolvePath(process.cwd(), process.env.SEGMENT_SOURCES)
    : join(ROOT, "data", "segment-sources.json");

  let ledger;
  let sourcesText;
  let sourcesDoc;
  try {
    ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    sourcesText = readFileSync(sourcesPath, "utf8");
    sourcesDoc = JSON.parse(sourcesText);
    rowsOf(sourcesDoc);
  } catch (e) {
    console.error(`FATAL: ${e.message}`);
    return 1;
  }

  if (flags.has("--check")) {
    const drift = checkSources(sourcesDoc, ledger);
    for (const d of drift) {
      console.log(`drift ${d.item_id} ${d.field}: committed=${JSON.stringify(d.committed)} recomputed=${JSON.stringify(d.recomputed)}`);
    }
    return drift.length ? 1 : 0;
  }

  const out = stampSources(sourcesDoc, ledger);
  for (const id of out.stamped) {
    const row = out.doc.sources.find((s) => s && s.id === id);
    console.log(`stamped ${id} pad=${row.ad_pad_sec}s tier=${row.ad_tier} n=${row.ad_delta_probes}`);
  }
  for (const { item_id, reason } of out.refused) console.log(`refused ${item_id}: ${reason}`);
  for (const id of out.untouched) console.log(`ignored ${id}: no source row`);

  if (flags.has("--dry-run")) return 0;
  // Nothing stamped means nothing written — not even a reformat.
  if (!out.stamped.length) return 0;
  const text = serialise(out.doc);
  if (text !== sourcesText) writeFileSync(sourcesPath, text);
  return 0;
}

if (isEntryScript(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
