#!/usr/bin/env node
/* S-01 (docs/search-plan.md): measure before numbers, before any search code
   changes. Modelled on tools/build-catalog-client.mjs's argument shape
   (`--out`/`--check`) and its "refuse to write an empty/nonsense result" rule.

   WHY THIS EXISTS
   Every later S-card (S-02..S-08) is graded against a number this file
   produces. Without it, "faster" and "the frame budget" are opinions.
   docs/search-plan.md §1.3/§1.4 already recorded a one-off desktop
   measurement; this is the same measurement, committed, runnable on CI and
   on a founder's own machine, so it stops being a one-time claim.

   WHAT IT MEASURES (four independent things — never averaged together):

   (a) LOCAL PASS — SearchEngine.searchShows() over the 220-show curated
       catalogue (data/catalog-client.json), for the fixed 12-query battery,
       20 reps per query, reporting MEDIAN and P95 — never a mean, never a
       single sample (docs/search-plan.md S-01 "Not acceptable" line).
   (b) DECODE — the one-time JSON.parse() of data/catalog-client.json itself,
       20 reps, median/p95. This is the client's real load cost today, not a
       stand-in for a future index format that does not exist in this repo.
   (b2) THE INDEX PASS — S-03 landed the merged index S-01 said there was
       nothing to measure yet, so the second measurement it reserved space for
       now exists: `data/show-index.tsv` (10,113 rows), its `parseShowIndex`
       decode, and the same 12-query battery run through BOTH index passes,
       reported as SEPARATE columns. The separation is the point. The PREFIX
       pass (binary search) sits on a keystroke and is graded against a 16 ms
       frame; the SCAN pass (linear) sits on the 250 ms debounce tick and only
       when the prefix pass under-delivered. Measured 2026-09-12, they differ
       by three orders of magnitude (0.004 ms vs 8-45 ms), so a single averaged
       column would describe neither. SKIPPED, NOT FAILED, when the index is
       not on disk — a checkout from before S-03 is not a finding about the
       index's speed.
   (c) BREADTH ROUND-TRIP — three forced-MISS requests (a unique query each,
       so the function actually runs) and three repeat-HIT requests (the
       same query, back to back) against API_ORIGIN's
       /api/shows/search endpoint, recording ttfb, status, and the
       Cache-Control / X-Vercel-Cache / Age headers AS RECEIVED — never
       assumed from the source file. §1.4 already found the response is
       missing the `stale-while-revalidate` token the source sets; this
       probe has to notice that class of drift, not paper over it.
       NETWORK SAMPLES ARE SKIPPED, NOT FAILED, when the origin is
       unreachable (offline CI runner, no egress) — the report says
       "no coverage" instead of red, the same "absence is a real state, not
       an error" rule app.js's own header states elsewhere in this repo.

   (d) THE PARITY CASES (P-06, docs/search-parity-plan.md §2.1) — the three
       queries the P-deck names as THE defect: `tim ferriss`, `lex fridman`,
       `sam harris`. Each is asked of /api/shows/search TWICE, plain and with
       `fallthrough=1`, and BOTH answers are reported: row count, the first
       three titles, and the 1-indexed rank of the show the listener meant.
       The pair is the measurement — a single count cannot regress visibly
       ("1 row for tim ferriss" reads as a thin catalogue, not as a gate that
       was never asked), and a row count alone can improve from 1 to 14 while
       the show the listener typed slides from first to third. SKIPPED, NOT
       FAILED, when the origin is unreachable, like (c). NOTE that this
       section measures the DEPLOYED endpoint, never the checkout it is run
       from.

   THE FIELD LIST IS THE CONTRACT the doc quotes from and later cards are
   graded against — a stat this script stops reporting silently breaks the
   contract, so add here and in docs/search-plan.md together.

   Usage:
     node tools/search-probe.mjs [--out path] [--check] [--no-network]
       --out          write the JSON report here (default: printed to stdout)
       --check        run the probe and exit 0/1 on whether it *produced* a
                       structurally valid report (never diffs prior numbers —
                       these are point-in-time measurements, not a derived
                       artifact like build-catalog-client's). Prints the
                       12-query table either way.
       --no-network   skip the breadth round-trip AND the parity cases
                       outright (matches "skipped, not failed" — useful for a
                       fully offline dev loop). */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");

/* The 12-query battery, verbatim from docs/search-plan.md S-01. The last
   entry is deliberately a real non-ASCII show title from the full breadth
   catalogue (data/catalog-breadth.json), not the 220-show curated set,
   because no non-ASCII title exists there today (measured: zero of 220) —
   the local pass legitimately returns zero hits for it, and that zero is
   itself the point: the battery must exercise non-ASCII matching even
   where the curated set cannot supply an example of its own. */
export const NON_ASCII_QUERY = "伊藤洋一のRound Up World Now！";
export const QUERY_BATTERY = [
  "l", "le", "lex", "lex f", "sci", "science f", "hist", "the daily",
  "radiolab", "99%", "zzqx", NON_ASCII_QUERY,
];

export const REPS = 20;
export const API_ORIGIN = "https://foray-web-seven.vercel.app";

/** Sorted-array median. Even length averages the two middle values. */
export function median(sorted) {
  if (!sorted.length) return null;
  const n = sorted.length;
  return n % 2 ? sorted[n >> 1] : (sorted[(n >> 1) - 1] + sorted[n >> 1]) / 2;
}

/** Nearest-rank p95 — ceil(0.95 * n), 1-indexed, clamped to the last element.
    Deliberately not an interpolated percentile: for a 20-sample battery the
    two agree everywhere that matters and nearest-rank is trivial to check by
    hand against a printed table, which is worth more here than precision. */
export function p95(sorted) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[idx];
}

/** Times `fn()` `reps` times with `process.hrtime.bigint()` (monotonic, not
    wall-clock — this repo's own #195 rule against wall-clock assertions
    applies here too), returns { samples (ms, sorted), median, p95 } plus
    whatever `fn()` last returned, so a hit count can ride along for free. */
export function timeReps(fn, reps = REPS) {
  const samples = [];
  let last;
  for (let i = 0; i < reps; i++) {
    const start = process.hrtime.bigint();
    last = fn();
    const end = process.hrtime.bigint();
    samples.push(Number(end - start) / 1e6);
  }
  const sorted = samples.slice().sort((a, b) => a - b);
  return { samples: sorted, median: median(sorted), p95: p95(sorted), last };
}

/** The local pass over one catalogue for the whole battery. `searchShows` and
    `shows` are injected (never imported at module scope) so this file has no
    hard dependency on search-engine.js's module shape and the unit test can
    hand it a fake. */
export function localPassBattery(searchShows, shows, queries = QUERY_BATTERY, reps = REPS) {
  const rows = [];
  for (const q of queries) {
    const { median: med, p95: pp, last } = timeReps(() => searchShows(q, shows), reps);
    rows.push({ query_len: q.length, ms_median: med, ms_p95: pp, hits: last.length });
  }
  return rows;
}

/** The INDEX pass over `data/show-index.tsv` for the whole battery (S-03
    landed the file S-01 said there was nothing to measure yet).

    TWO PASSES, REPORTED SEPARATELY, because they run at different moments and
    are graded against different budgets: `prefix` is what a KEYSTROKE costs
    (binary search, must fit a 16 ms frame), `scan` is what the DEBOUNCE TICK
    costs (linear, runs only when the prefix pass under-delivers). Averaging
    them would hide exactly the number S-03 exists to move.

    Both functions are injected rather than imported, for the same reason
    `localPassBattery` injects `searchShows`: this file must stay runnable
    against a fake. */
export function indexPassBattery(prefixSearch, scan, index, queries = QUERY_BATTERY, reps = REPS) {
  /* TWO SEPARATE SWEEPS OVER THE BATTERY, not one interleaved loop, and this
     is a measurement decision worth stating. The scan pass allocates a result
     object per hit — 5,332 of them for "l", times `reps` — so running the two
     passes back to back inside one query's iteration put the prefix pass's
     timing inside the scan pass's GC window. Measured 2026-09-12: "l"'s prefix
     median read 22-43 ms interleaved and 2.1 ms swept separately, for
     identical work. The interleaved number is not what a keystroke costs, and
     reporting it would have made S-03 look like it had failed its own
     acceptance line for a reason that is an artefact of the harness. */
  const prefix = queries.map((q) => timeReps(() => prefixSearch(q, index), reps));
  const scanned = queries.map((q) => timeReps(() => scan(q, index), reps));
  return queries.map((q, i) => ({
    query_len: q.length,
    prefix_hits: prefix[i].last.length,
    prefix_ms_median: prefix[i].median,
    prefix_ms_p95: prefix[i].p95,
    scan_hits: scanned[i].last.length,
    scan_ms_median: scanned[i].median,
    scan_ms_p95: scanned[i].p95,
    /* Whether app.js would EVER run the scan for this query. It runs the scan
       only on the debounce tick and only when the prefix pass under-delivered
       (`SHOW_PREFIX_UNDERDELIVERS_BELOW`, 10). "l" returns 418 prefix hits, so
       its ~500 ms scan is measured here and never paid in the app — without
       this column the table reads as if it were. */
    scan_reached: prefix[i].last.length < 10,
  }));
}

/** One-time decode cost of the client catalogue JSON, timed `reps` times.
    `raw` is the exact text on disk — JSON.parse is what is timed, not the
    file read, which is disk I/O and not the client's real cost (the browser
    already has the bytes by the time this runs). */
export function decodeStats(raw, reps = REPS) {
  const { median: med, p95: pp } = timeReps(() => JSON.parse(raw), reps);
  return { ms_median: med, ms_p95: pp };
}

/** One HTTP GET, timed, with the three headers §1.4 already found matter.
    `fetchImpl` is injected so the unit test never touches the network — the
    default is the real global fetch, resolved lazily so importing this
    module in a no-network environment cannot throw. */
export async function timedGet(url, fetchImpl = (...a) => fetch(...a)) {
  const start = process.hrtime.bigint();
  const res = await fetchImpl(url, { cache: "no-store" });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return {
    ms, status: res.status,
    cache_control: res.headers.get("cache-control"),
    x_vercel_cache: res.headers.get("x-vercel-cache"),
    age: res.headers.get("age"),
  };
}

/** Three forced-MISS + three repeat-HIT samples against /api/shows/search.
    SKIPPED (not failed) on any thrown error — offline runner, DNS failure,
    a timeout — because a network probe's own unreachability is not a
    finding about the endpoint. `runId` seeds the per-sample unique query so
    two CI runs racing the same second don't collide on the same MISS key. */
export async function breadthRoundTrip({
  origin = API_ORIGIN, fetchImpl, runId = String(Date.now()),
} = {}) {
  const get = (q) => timedGet(`${origin}/api/shows/search?q=${encodeURIComponent(q)}&limit=25`, fetchImpl);
  try {
    const misses = [];
    for (let i = 0; i < 3; i++) misses.push(await get(`__probe_miss_${runId}_${i}__`));

    const hitQuery = `__probe_hit_${runId}__`;
    const hits = [];
    for (let i = 0; i < 3; i++) hits.push(await get(hitQuery));

    return { skipped: false, reason: null, misses, hits };
  } catch (err) {
    return {
      skipped: true,
      reason: `origin unreachable: ${String(err?.message ?? err)}`,
      misses: [], hits: [],
    };
  }
}

/* ==================================================================== */
/* P-06 — THE THREE NAMED PARITY CASES                                  */
/* ==================================================================== */

/** The three queries `docs/search-parity-plan.md` §2.1 names as THE DEFECT.
 *
 *  WHY THESE LIVE HERE AND NOT IN THE 12-QUERY BATTERY. `QUERY_BATTERY` is a
 *  TIMING battery: fixed since S-01, quoted verbatim by §1.6 and §1.7, and its
 *  length is asserted by `validateReport`. Adding a query to it would silently
 *  invalidate every committed comparison table. These cases measure something
 *  else entirely — not how fast a pass runs but WHETHER THE DIRECTORY IS ASKED
 *  AT ALL — so they are their own battery with their own section.
 *
 *  WHAT §2.1 MEASURED, and what this re-measures. On 2026-09-13, against the
 *  live endpoint at `limit=5`, each of these three returned exactly ONE row
 *  both with and without `fallthrough=1`, for three of the best-known shows in
 *  podcasting. That is the whole of P-02's diagnosis: the fall-through was not
 *  broken, it was never asked, because one match is not zero.
 *
 *  SO THE MEASUREMENT IS THE PAIR, NOT EITHER NUMBER. A single count cannot
 *  regress visibly — "1 row for tim ferriss" looks like a thin catalogue, not
 *  a gate. The pair cannot hide: when `plain_rows === directory_rows` for all
 *  three, the directory is inert, and that is exactly the state P-02 exists to
 *  leave behind. `parityCase` therefore always issues BOTH requests and always
 *  reports both, even when they agree.
 *
 *  `target` is the show the listener meant. It is recorded as a RANK, never as
 *  an assertion here, because this file measures and does not grade — but its
 *  rank is the number that caught what row counts alone missed (see §1.8's
 *  `tim ferriss` row). A count can go 1 -> 14 while the show the listener
 *  typed slides from first to third. */
export const PARITY_CASES = [
  { query: "tim ferriss", target: "The Tim Ferriss Show" },
  { query: "lex fridman", target: "Lex Fridman Podcast" },
  { query: "sam harris", target: "Making Sense with Sam Harris" },
];

/** The normalised-title rule, verbatim from `api/shows/appleShowSearch.ts`'s
    `normaliseShowTitle` and `app.js`'s copy of it. Used here ONLY to locate a
    target title in a result list — never to dedupe; the endpoint has already
    done that by the time these rows arrive. */
export function normaliseTitle(title) {
  return String(title || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** 1-INDEXED rank of `target` in `shows`, or `null` when absent. 1-indexed
    because every table this feeds is read by a human counting from the top of
    a list; a 0 here would read as "first" and mean "first" only by accident. */
export function targetRank(shows, target) {
  const want = normaliseTitle(target);
  const i = (shows || []).findIndex((s) => normaliseTitle(s?.title) === want);
  return i === -1 ? null : i + 1;
}

/** One parity case: the SAME query asked twice, plain and with
    `fallthrough=1`, and both answers reported side by side. Throws on a
    network failure — `parityBattery` is where "skipped, not failed" is
    applied, matching `breadthRoundTrip`'s split. */
export async function parityCase({ query, target }, { origin = API_ORIGIN, fetchImpl, limit = 25 } = {}) {
  const get = async (extra) => {
    const url = `${origin}/api/shows/search?q=${encodeURIComponent(query)}&limit=${limit}${extra}`;
    const start = process.hrtime.bigint();
    const res = await (fetchImpl ?? ((...a) => fetch(...a)))(url, { cache: "no-store" });
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const body = await res.json();
    const shows = Array.isArray(body?.shows) ? body.shows : [];
    return { ms, shows, attempted: body?.fallthrough?.attempted ?? null };
  };

  const plain = await get("");
  const directory = await get("&fallthrough=1");

  return {
    query, target,
    plain_rows: plain.shows.length,
    plain_titles: plain.shows.slice(0, 3).map((s) => String(s?.title ?? "")),
    plain_target_rank: targetRank(plain.shows, target),
    directory_rows: directory.shows.length,
    directory_titles: directory.shows.slice(0, 3).map((s) => String(s?.title ?? "")),
    directory_target_rank: targetRank(directory.shows, target),
    /* THE REGRESSION SIGNATURE, computed rather than left to the reader: zero
       means the flag changed nothing, which is §2.1's defect exactly. */
    gain: directory.shows.length - plain.shows.length,
    fallthrough_attempted: directory.attempted,
    plain_ms: plain.ms,
    directory_ms: directory.ms,
  };
}

/** All three cases. SKIPPED, NOT FAILED, on any thrown error — an offline
    runner is not a finding about the gate, the same rule `breadthRoundTrip`
    follows. */
export async function parityBattery({ origin = API_ORIGIN, fetchImpl, cases = PARITY_CASES } = {}) {
  try {
    const out = [];
    for (const c of cases) out.push(await parityCase(c, { origin, fetchImpl }));
    return { skipped: false, reason: null, cases: out };
  } catch (err) {
    return {
      skipped: true,
      reason: `origin unreachable: ${String(err?.message ?? err)}`,
      cases: [],
    };
  }
}

function parseArgs(argv) {
  const out = { outPath: null, check: false, noNetwork: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") { out.outPath = path.resolve(argv[++i] ?? ""); continue; }
    if (a === "--check") { out.check = true; continue; }
    if (a === "--no-network") { out.noNetwork = true; continue; }
    throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

/** The whole report, in the shape the doc and the record-wiring depend on.
    `searchShows` injected (from search-engine.js, a CommonJS module require()
    picks up) so this stays testable without the real catalogue. */
export async function runProbe({ searchShows, engine, noNetwork = false } = {}) {
  const clientRaw = readFileSync(path.join(ROOT, "data", "catalog-client.json"), "utf8");
  const catalog = JSON.parse(clientRaw);
  if (!catalog || !Array.isArray(catalog.shows) || !catalog.shows.length) {
    throw new Error("data/catalog-client.json did not parse to a non-empty { shows: [...] } — refusing to report");
  }

  const local = localPassBattery(searchShows, catalog.shows);
  const decode = decodeStats(clientRaw);
  const network = noNetwork
    ? { skipped: true, reason: "--no-network", misses: [], hits: [] }
    : await breadthRoundTrip();

  /* P-06's named cases. Same "skipped, not failed" contract as `network`, and
     skipped for the same reasons. NOTE WHAT THIS SECTION MEASURES: the
     DEPLOYED endpoint, not the checkout. Until a branch is deployed, running
     this probe from that branch's worktree still reports the deployment's
     behaviour — which is the honest answer, and is why §1.8's after-column is
     a replay rather than a reading of this section. */
  const parity = noNetwork
    ? { skipped: true, reason: "--no-network", cases: [] }
    : await parityBattery();

  /* SKIPPED, NOT FAILED, when the index is absent — the same rule the network
     section follows, and for the same reason: a checkout from before S-03, or
     one where the build step has not run, is not a finding about the index's
     speed. `engine` is optional so every existing caller of runProbe keeps
     working unchanged. */
  let index = { skipped: true, reason: "data/show-index.tsv not on disk", rows: 0, decode: null, battery: [] };
  const indexPath = path.join(ROOT, "data", "show-index.tsv");
  if (engine && existsSync(indexPath)) {
    const raw = readFileSync(indexPath, "utf8");
    const decoded = timeReps(() => engine.parseShowIndex(raw));
    if (decoded.last.rows.length) {
      index = {
        skipped: false, reason: null,
        rows: decoded.last.rows.length,
        bytes: Buffer.byteLength(raw, "utf8"),
        decode: { ms_median: decoded.median, ms_p95: decoded.p95 },
        battery: indexPassBattery(engine.prefixSearchShows, engine.scanShowIndex, decoded.last),
      };
    } else {
      index = { ...index, reason: "data/show-index.tsv decoded to zero rows" };
    }
  }

  return {
    /* v3: the `parity` section is new and `validateReport` now requires it.
       Bumped rather than added silently — §1.6/§1.7 quote a v2 report and a
       reader has to be able to tell which shape they are holding. */
    v: 3,
    run_at: new Date().toISOString(),
    catalog_shows: catalog.shows.length,
    battery: QUERY_BATTERY.map((q, i) => ({ ...local[i], query_len: q.length })),
    decode,
    index,
    network,
    parity,
  };
}

/** A human-readable 12-query table for the CI log / doc quote, printed
    regardless of --check so the numbers are always visible somewhere other
    than the JSON. */
export function formatTable(report) {
  const lines = [
    `search-probe v${report.v} — ${report.run_at} — ${report.catalog_shows} curated shows`,
    "",
    "query_len  hits  ms_median  ms_p95",
  ];
  for (const row of report.battery) {
    lines.push(
      `${String(row.query_len).padStart(9)}  ${String(row.hits).padStart(4)}  ` +
        `${row.ms_median.toFixed(3).padStart(9)}  ${row.ms_p95.toFixed(3).padStart(6)}`
    );
  }
  lines.push("");
  lines.push(`decode (JSON.parse, ${REPS} reps): median ${report.decode.ms_median.toFixed(3)}ms, p95 ${report.decode.ms_p95.toFixed(3)}ms`);
  lines.push("");
  /* S-03's index, as its own section. NOT folded into the 12-query table
     above: that table is the curated 220-show pass and this one is the
     10,113-row index, and a single table would invite reading one number
     where there are two different passes over two different corpora. */
  if (!report.index || report.index.skipped) {
    lines.push(`show index: no coverage (${report.index?.reason ?? "not reported"})`);
  } else {
    lines.push(`show index (data/show-index.tsv): ${report.index.rows} rows, ${report.index.bytes} B`);
    lines.push(`  decode (parseShowIndex, ${REPS} reps): median ${report.index.decode.ms_median.toFixed(3)}ms, p95 ${report.index.decode.ms_p95.toFixed(3)}ms`);
    lines.push("  query_len  pfx_hits  pfx_median  pfx_p95  scan_hits  scan_median  scan_p95  scan_run");
    for (const r of report.index.battery) {
      lines.push(
        `  ${String(r.query_len).padStart(9)}  ${String(r.prefix_hits).padStart(8)}  ` +
        `${r.prefix_ms_median.toFixed(3).padStart(10)}  ${r.prefix_ms_p95.toFixed(3).padStart(7)}  ` +
        `${String(r.scan_hits).padStart(9)}  ${r.scan_ms_median.toFixed(3).padStart(11)}  ${r.scan_ms_p95.toFixed(3).padStart(8)}  ${(r.scan_reached ? "yes" : "no").padStart(8)}`
      );
    }
  }
  lines.push("");
  if (report.network.skipped) {
    lines.push(`breadth round-trip: no coverage (${report.network.reason})`);
  } else {
    const fmt = (s) => `ttfb ${s.ms.toFixed(0)}ms status=${s.status} cache-control=${s.cache_control ?? "—"} x-vercel-cache=${s.x_vercel_cache ?? "—"} age=${s.age ?? "—"}`;
    lines.push("breadth round-trip, forced MISS:");
    for (const s of report.network.misses) lines.push(`  ${fmt(s)}`);
    lines.push("breadth round-trip, repeat (expect HIT after the first):");
    for (const s of report.network.hits) lines.push(`  ${fmt(s)}`);
  }
  lines.push("");
  /* P-06's named cases. Printed with BOTH columns always, and with the target
     show's rank beside each, because either number alone is unreadable: one
     row looks like a thin catalogue rather than a gate, and fourteen rows
     looks like a win even when the show the listener typed is third. */
  if (!report.parity || report.parity.skipped) {
    lines.push(`parity cases (§2.1): no coverage (${report.parity?.reason ?? "not reported"})`);
  } else {
    lines.push("parity cases (docs/search-parity-plan.md §2.1) — same query, plain vs &fallthrough=1:");
    lines.push("  query          plain  tgt#  directory  tgt#  gain  first title (directory)");
    for (const c of report.parity.cases) {
      lines.push(
        `  ${c.query.padEnd(13)}  ${String(c.plain_rows).padStart(5)}  ` +
        `${String(c.plain_target_rank ?? "—").padStart(4)}  ${String(c.directory_rows).padStart(9)}  ` +
        `${String(c.directory_target_rank ?? "—").padStart(4)}  ${String(c.gain).padStart(4)}  ${c.directory_titles[0] ?? "—"}`
      );
    }
    if (report.parity.cases.every((c) => c.gain === 0)) {
      lines.push("  ^ EVERY case gained nothing: the directory pass is inert (this is §2.1's defect).");
    }
  }
  return lines.join("\n");
}

/** Structural validity only — this is a measurement, not a derived artifact,
    so --check cannot diff against a committed expectation the way
    build-catalog-client.mjs's --check does. It can and must catch a report
    that silently stopped reporting one of the three things S-01 promises:
    a battery row per query, a decode stat, and a network section that is
    either populated or honestly marked skipped. */
export function validateReport(report) {
  const errors = [];
  if (!Array.isArray(report.battery) || report.battery.length !== QUERY_BATTERY.length) {
    errors.push(`battery must have exactly ${QUERY_BATTERY.length} rows, got ${report.battery?.length}`);
  }
  for (const row of report.battery ?? []) {
    if (typeof row.ms_median !== "number" || typeof row.ms_p95 !== "number") {
      errors.push("every battery row needs numeric ms_median and ms_p95 — a single sample or a mean-only row is not acceptable (S-01's own rule)");
      break;
    }
  }
  if (typeof report.decode?.ms_median !== "number" || typeof report.decode?.ms_p95 !== "number") {
    errors.push("decode stats must carry a numeric median and p95");
  }
  if (typeof report.index?.skipped !== "boolean") {
    errors.push("index section must explicitly say skipped: true/false — an absent index is \"no coverage\", not silence");
  }
  if (report.index && report.index.skipped === false) {
    if (!Array.isArray(report.index.battery) || report.index.battery.length !== QUERY_BATTERY.length) {
      errors.push(`index battery must have exactly ${QUERY_BATTERY.length} rows, got ${report.index.battery?.length}`);
    }
    for (const row of report.index.battery ?? []) {
      if (typeof row.prefix_ms_p95 !== "number" || typeof row.scan_ms_p95 !== "number") {
        errors.push("every index battery row needs a p95 for BOTH passes — the prefix pass and the scan pass are graded against different budgets and must never be reported as one number");
        break;
      }
    }
  }
  if (typeof report.network?.skipped !== "boolean") {
    errors.push("network section must explicitly say skipped: true/false — silence is not \"no coverage\"");
  }
  /* P-06. The parity section is REQUIRED — a report that stopped carrying it
     is the silent regression this card exists to make impossible, so its
     absence is an error and not a shrug. */
  if (typeof report.parity?.skipped !== "boolean") {
    errors.push("parity section must explicitly say skipped: true/false — P-06's three §2.1 cases are part of the contract, and a report that dropped them is not valid");
  }
  if (report.parity && report.parity.skipped === false) {
    if (!Array.isArray(report.parity.cases) || report.parity.cases.length !== PARITY_CASES.length) {
      errors.push(`parity section must carry exactly ${PARITY_CASES.length} cases, got ${report.parity.cases?.length}`);
    }
    for (const c of report.parity.cases ?? []) {
      /* BOTH COLUMNS OR NEITHER. Reporting only the flagged count would hide
         the defect completely: 1 row reads as a thin catalogue, and it is only
         "1 with the flag AND 1 without it" that names the gate. */
      if (typeof c.plain_rows !== "number" || typeof c.directory_rows !== "number") {
        errors.push("every parity case needs BOTH plain_rows and directory_rows — a single count cannot show that the directory pass was inert, which is the whole measurement");
        break;
      }
      if (!Array.isArray(c.plain_titles) || !Array.isArray(c.directory_titles)) {
        errors.push("every parity case needs its first-three titles for BOTH columns — P-06 asks for titles, not only counts, because a count can improve while the show the listener typed moves down the list");
        break;
      }
    }
  }
  if (report.network && report.network.skipped === false) {
    for (const s of [...report.network.misses, ...report.network.hits]) {
      if (s.cache_control != null && s.x_vercel_cache == null) {
        errors.push("a Cache-Control number with no X-Vercel-Cache beside it is not acceptable (S-01's own rule)");
      }
    }
  }
  return errors;
}

async function main() {
  const { outPath, check, noNetwork } = parseArgs(process.argv.slice(2));
  // eslint-disable-next-line global-require -- app.js/search-engine.js are CommonJS on purpose (see their own headers)
  const SearchEngine = (await import("node:module")).createRequire(import.meta.url)(
    path.join(ROOT, "search-engine.js")
  );

  const report = await runProbe({ searchShows: SearchEngine.searchShows, engine: SearchEngine, noNetwork });
  console.log(formatTable(report));

  if (check) {
    const errors = validateReport(report);
    if (errors.length) {
      console.error("\nsearch-probe --check FAILED:");
      for (const e of errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    console.log("\nsearch-probe --check: structurally valid.");
  }

  if (outPath) {
    writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
    console.log(`\nwrote ${path.relative(ROOT, outPath)}`);
  }
}

/* `pathToFileURL`, not a `file://${argv[1]}` template. The template form is
   what tools/build-catalog-client.mjs uses and it is silently FALSE on Windows
   (a `C:\…` path is not `file://C:\…`), so `node tools/search-probe.mjs`
   printed nothing and exited 0 there — on the founder's own machine, which is
   exactly where S-01's card says this has to run. A measurement tool that
   silently measures nothing is the failure class this repo's CLAUDE.md calls
   "fails green". tools/ci/path-policy.mjs already uses this form; matched to
   it. */
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
