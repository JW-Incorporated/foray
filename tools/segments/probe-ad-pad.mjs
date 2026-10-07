#!/usr/bin/env node
/* The pad ledger's collector (DAI-04, docs/roadmap/dai.md).

   WHAT IT DOES. For each DAI source row in data/segment-sources.json that
   carries a feed-declared denominator (`audio_bytes`), it sends ONE 2-byte
   ranged GET through ad-inflation.mjs's probeEpisode and appends the evidence
   — declared bytes, delivered bytes, the host, the status — to
   data/ad-pad-probes.json. It computes no pad and stores no ratio: the ledger
   holds observations, and tools/segments/ad-pad.mjs (via stamp-ad-pad.mjs) is
   the only place they become a verdict.

   WHY A GAP BETWEEN PROBES. ADR-0008's pad is delta_max + spread over N >= 2
   probes of the SAME episode. Two probes a minute apart see the same ad
   decision and measure a spread of nothing, which is a margin of nothing. A
   second probe of an item inside `minGapHours` (default 24) is refused, and
   `run` checks the gap BEFORE it spends a request, so a re-run inside the gap
   costs the host nothing.

   POLITENESS IS THE GATE'S JOB. probeEpisode already waits on
   politeness.mjs's per-host slot and honours Retry-After; this file adds no
   private throttle and probes one row at a time.

   THE TRUST RULE (HUMAN-ACTIONS #24). A ranged GET from an origin on
   RANGED_GET_UNTRUSTED_HOSTS is still recorded — it is evidence of what that
   host declares — and ad-pad.mjs refuses to size a pad from it. The run line
   marks such a probe `untrusted` so the operator sees it at collection time.
   `host` is the hostname of the committed `audio_url`; a redirect chain
   (pscrb.fm is a tracking prefix) can end on another CDN, which this probe
   does not observe.

   --dry-run SENDS NOTHING. It selects the rows and applies the gap against
   the existing ledger exactly as a real run would, then prints
   `would probe <id> host=<host>` per row it would ask, the too-soon and
   skipped rows, and the number of requests a real run would spend. It never
   calls the probe and never writes the ledger. (Until this was fixed a dry run
   probed every row and only skipped the write: 104 GETs on DAI-08 day 1.)

   Run (manual, on the PC, never in CI):
     node tools/segments/probe-ad-pad.mjs [--id ID ...] [--all] [--min-gap-hours N] [--dry-run]
   Paths: AD_PAD_LEDGER (default data/ad-pad-probes.json), SEGMENT_SOURCES
   (default data/segment-sources.json). */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { probeEpisode, rangedGetTrusted } from "../transcribe/ad-inflation.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOUR_MS = 3_600_000;

/** The rows to probe, and why each excluded candidate was excluded. */
export function selectRows(sourcesDoc, { ids = [], all = false } = {}) {
  const sources = Array.isArray(sourcesDoc?.sources) ? sourcesDoc.sources : [];
  const wanted = new Set(ids);
  const candidates = sources.filter((row) =>
    wanted.size > 0 ? wanted.has(row?.id) : all || row?.dai_suspected === true,
  );
  const rows = [];
  const skipped = [];
  for (const row of candidates) {
    if (typeof row.audio_url !== "string" || row.audio_url === "") skipped.push({ id: row.id, reason: "no audio_url" });
    else if (!(Number(row.audio_bytes) > 0)) skipped.push({ id: row.id, reason: "no audio_bytes" });
    else rows.push(row);
  }
  return { rows, skipped };
}

/** One ranged-GET probe of one row as a ledger row, or null when nothing was
    delivered (a failed probe is not evidence). */
export async function probeRow(row, { probe = probeEpisode, now = () => new Date() } = {}) {
  const p = await probe(row.audio_url, row.audio_bytes);
  if (p == null || p.delivered_bytes == null) return null;
  return {
    item_id: row.id,
    probed_at: now().toISOString(),
    method: "ranged-get",
    host: new URL(row.audio_url).hostname,
    status: p.status,
    attempts: p.attempts,
    declared_bytes: p.declared_bytes,
    delivered_bytes: p.delivered_bytes,
  };
}

/** The latest ledger probe of `itemId` lying strictly inside `minGapHours` of
    `atIso`, or null. */
function probeInsideGap(probes, itemId, atIso, minGapHours) {
  const at = Date.parse(atIso);
  let last = null;
  for (const p of probes) {
    if (p?.item_id !== itemId) continue;
    const t = Date.parse(p.probed_at);
    if (!Number.isFinite(t) || !(Math.abs(at - t) < minGapHours * HOUR_MS)) continue;
    if (last == null || t > Date.parse(last)) last = p.probed_at;
  }
  return last;
}

/** A NEW ledger with each probe appended unless its item already has a probe
    inside the gap. Never mutates `ledger`. */
export function appendProbes(ledger, probes, { minGapHours = 24 } = {}) {
  const out = { ...ledger, probes: [...(Array.isArray(ledger?.probes) ? ledger.probes : [])] };
  const appended = [];
  const tooSoon = [];
  for (const p of probes) {
    const last = probeInsideGap(out.probes, p.item_id, p.probed_at, minGapHours);
    if (last != null) {
      tooSoon.push({ item_id: p.item_id, last });
      continue;
    }
    out.probes.push(p);
    appended.push(p);
  }
  return { ledger: out, appended, tooSoon };
}

/** Probe the selected rows one at a time and append the evidence. With
    `dryRun` nothing is sent: `probe` is never called, each row a real run
    would probe is logged and returned in `wouldProbe`, `appended` is empty and
    the returned ledger is the input object, untouched. */
export async function run({
  sourcesDoc,
  ledger,
  ids = [],
  all = false,
  minGapHours = 24,
  dryRun = false,
  probe = probeEpisode,
  now = () => new Date(),
  log = console.log,
}) {
  const { rows, skipped } = selectRows(sourcesDoc, { ids, all });
  for (const s of skipped) log(`skipped ${s.id}: ${s.reason}`);

  const existing = Array.isArray(ledger?.probes) ? ledger.probes : [];
  const fresh = [];
  const tooSoon = [];
  const failed = [];
  const wouldProbe = [];
  for (const row of rows) {
    const last = probeInsideGap([...existing, ...fresh], row.id, now().toISOString(), minGapHours);
    if (last != null) {
      tooSoon.push({ item_id: row.id, last });
      log(`too soon ${row.id} (last ${last})`);
      continue;
    }
    if (dryRun) {
      const host = new URL(row.audio_url).hostname;
      wouldProbe.push({ item_id: row.id, host });
      log(`would probe ${row.id} host=${host}`);
      continue;
    }
    let result = null;
    const capture = async (...args) => (result = await probe(...args));
    const ledgerRow = await probeRow(row, { probe: capture, now });
    if (ledgerRow == null) {
      const error = result?.error || "no delivered length";
      failed.push({ item_id: row.id, error });
      log(`failed ${row.id}: ${error}`);
      continue;
    }
    fresh.push(ledgerRow);
    const mark = rangedGetTrusted(ledgerRow.host) ? "" : " untrusted";
    log(`probed ${row.id} ${ledgerRow.delivered_bytes}/${ledgerRow.declared_bytes} host=${ledgerRow.host}${mark}`);
  }

  if (dryRun) {
    log(
      `dry run: ${wouldProbe.length} requests would be sent, ${tooSoon.length} too soon, ${skipped.length} skipped` +
        " (nothing sent, ledger not written)",
    );
    return { ledger, appended: [], tooSoon, skipped, failed, wouldProbe };
  }

  const merged = appendProbes(ledger, fresh, { minGapHours });
  tooSoon.push(...merged.tooSoon);
  log(`${merged.appended.length} probed, ${tooSoon.length} too soon, ${skipped.length} skipped, ${failed.length} failed`);
  return {
    ledger: merged.ledger,
    appended: merged.appended,
    tooSoon,
    skipped,
    failed,
    wouldProbe,
  };
}

/* -------------------------------------------------------------------- main */

function parseArgs(argv) {
  const ids = [];
  let minGapHours = 24;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--id") {
      const id = argv[++i];
      if (!id) throw new Error("--id needs a source row id");
      ids.push(id);
    } else if (argv[i] === "--min-gap-hours") {
      const raw = argv[++i];
      minGapHours = Number(raw);
      if (!Number.isFinite(minGapHours) || minGapHours < 0) {
        throw new Error(`--min-gap-hours must be a non-negative number, got ${raw}`);
      }
    }
  }
  return { ids, minGapHours, all: argv.includes("--all"), dryRun: argv.includes("--dry-run") };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ledgerPath = resolvePath(ROOT, process.env.AD_PAD_LEDGER || join("data", "ad-pad-probes.json"));
  const sourcesPath = resolvePath(ROOT, process.env.SEGMENT_SOURCES || join("data", "segment-sources.json"));
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const sourcesDoc = JSON.parse(readFileSync(sourcesPath, "utf8"));
  const result = await run({ sourcesDoc, ledger, ...args });
  if (!args.dryRun && result.appended.length > 0) {
    writeFileSync(ledgerPath, JSON.stringify(result.ledger, null, 2) + "\n");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  });
}
