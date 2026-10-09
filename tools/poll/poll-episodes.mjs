/* The S-10 episode poller's command line (PKG-08, docs/roadmap/shows-search.md).

   Usage:
     node tools/poll/poll-episodes.mjs --dry-run [options]
     node tools/poll/poll-episodes.mjs                      (live mode: not built)
   Options (read by --dry-run; ignored otherwise):
     --top-n <int>        non-curated top-N cut for changed_in_dump rows (5000)
     --per-run-cap <int>  most feeds one run would fetch (300)
     --out <path>         summary file (data-local/poll/dry-run-<YYYY-MM-DD>.json;
                          data-local/ is gitignored: nothing generated is
                          committed, docs/DECISIONS.md 2026-09-24, issue #701)
     --now <ISO>          the run's clock (default: now)
     --seed <path>        watchlist seed (data/watchlist-seed.json)

   WHAT THE DRY RUN DOES. It composes PKG-05..07 and fetches NO feed: read the
   committed seed (data/watchlist-seed.json, PKG-07's curated rows), ask
   tools/refresh/candidates.mjs's loadChangeIndex() for this week's change
   index, build the watchlist (watchlist.mjs buildWatchlist, with the seed's
   rows as curatedShows), pick what a run would fetch (select-due.mjs
   selectDue at --now), project the weekly request count (weeklyProjection),
   write a summary and print one line:
     dry-run: <due> due of <total> watched; <n>/week projected at N=<topN> (target < 40000); fetched 0
   Founder gate G9 (default N = 5,000, target < 40,000 requests a week) is
   judged against that projection. Sanity check: with the change index
   unavailable the watchlist is the ~220 curated rows, all daily, so about
   1,540 requests a week.

   DEGRADING. A change index that comes back ok:false (the weekly release is
   late, or has no baseline) is the realistic case, not an error: the dry run
   continues from the seed alone and records change_index: { ok:false, reason }.
   A seed that is ABSENT at the default path is also expected until PKG-07's
   seed is committed (data/watchlist-seed.json does not exist on main yet):
   the run continues with no seed rows and says so on stderr and in
   `seed_status`. A seed path given with --seed that is missing, or any seed
   that does not parse or has no `rows` array, is exit 1: the operator named a
   file, or the committed one is broken, and a silent empty run would hide it.

   EXIT CODES:
     0  dry run written; or no --dry-run and no database configured (a blank
        or whitespace-only URL is not configured)
     1  bad arguments, or an unreadable seed (see DEGRADING)
     3  no --dry-run but a database URL is set: live mode is PKG-10, which is
        BLOCKED on gates G1/G3, so it refuses without touching the network.

   IMPORTS. From tools/shows, only tools/shows/config.mjs (the shared
   DATABASE_URL resolver; tools/refresh/candidates.mjs reads its paths and
   user-agent string). The rest of that module tree pulls pg-copy-streams and
   node:sqlite at import time and would break the root `node --test` group;
   config.mjs stays light (poll-episodes.test.mjs walks its import graph). */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "../ci/entry.mjs";
import { loadChangeIndex } from "../refresh/candidates.mjs";
import { DATABASE_URL_VARS, resolveDatabaseUrl } from "../shows/config.mjs";
import { buildWatchlist, summarize } from "./watchlist.mjs";
import { selectDue, weeklyProjection } from "./select-due.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_SEED = path.join(ROOT, "data", "watchlist-seed.json");
export const TARGET_REQUESTS_PER_WEEK = 40000;

/* One resolver for every shows-pipeline CLI (CH2-12): load-postgres.mjs's
   rule, whitespace is unset. Re-exported for this module's callers. */
export { DATABASE_URL_VARS, resolveDatabaseUrl };

/* G1 (#131) and G3 (#133) were SKIPPED for now and live in
   HUMAN-ACTIONS-DONE.md; HUMAN-ACTIONS.md is where they come back when PKG-10
   is next. The literal "HUMAN-ACTIONS.md" is asserted by the test. */
export const NO_DB_MESSAGE =
  "poll-episodes: no database (gates G1 DATABASE_URL / G3 SHOWS_DATABASE_URL, skipped for now: see HUMAN-ACTIONS.md / HUMAN-ACTIONS-DONE.md #131 #133); nothing to do";
export const LIVE_REFUSAL = "poll-episodes: live mode is not built (PKG-10); refusing";

function defaultOutPath(nowMs) {
  return path.join(ROOT, "data-local", "poll", `dry-run-${new Date(nowMs).toISOString().slice(0, 10)}.json`);
}

function intFlag(name, raw, min) {
  if (raw === undefined || !/^\d+$/.test(raw)) throw new Error(`${name} needs a whole number, got ${raw === undefined ? "nothing" : JSON.stringify(raw)}`);
  const n = Number(raw);
  if (n < min) throw new Error(`${name} must be at least ${min}, got ${n}`);
  return n;
}

export function parseArgs(argv) {
  const out = { dryRun: false, topN: 5000, perRunCap: 300, outPath: null, nowMs: null, seedPath: DEFAULT_SEED, seedGiven: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") { out.dryRun = true; continue; }
    if (a === "--top-n") { out.topN = intFlag(a, argv[++i], 0); continue; }
    if (a === "--per-run-cap") { out.perRunCap = intFlag(a, argv[++i], 1); continue; }
    if (a === "--out") {
      const v = argv[++i];
      if (!v) throw new Error("--out needs a path");
      out.outPath = path.resolve(v);
      continue;
    }
    if (a === "--seed") {
      const v = argv[++i];
      if (!v) throw new Error("--seed needs a path");
      out.seedPath = path.resolve(v);
      out.seedGiven = true;
      continue;
    }
    if (a === "--now") {
      const v = argv[++i];
      const ms = v ? Date.parse(v) : NaN;
      if (Number.isNaN(ms)) throw new Error(`--now needs an ISO date, got ${v === undefined ? "nothing" : JSON.stringify(v)}`);
      out.nowMs = ms;
      continue;
    }
    throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

/** { ok:true, rows } | { ok:true, rows: [], missing: reason } (absent and not
    required) | { ok:false, reason } (exit 1). */
function loadSeed(seedPath, required) {
  let text;
  try {
    text = readFileSync(seedPath, "utf8");
  } catch (e) {
    if (e.code === "ENOENT" && !required) return { ok: true, rows: [], missing: `no seed at ${path.relative(ROOT, seedPath).split(path.sep).join("/") || seedPath}` };
    return { ok: false, reason: `seed unreadable (${seedPath}): ${e.message}` };
  }
  let seed;
  try {
    seed = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `seed is not JSON (${seedPath}): ${e.message}` };
  }
  if (!seed || !Array.isArray(seed.rows)) return { ok: false, reason: `seed has no rows array (${seedPath})` };
  return { ok: true, rows: seed.rows };
}

function topHosts(hosts, n = 10) {
  return Object.fromEntries(
    Object.entries(hosts)
      .sort(([ha, a], [hb, b]) => b - a || (ha < hb ? -1 : ha > hb ? 1 : 0))
      .slice(0, n),
  );
}

/** The dry run. Never calls process.exit and never fetches a feed. Pass
    `changeIndex` to skip loadChangeIndex entirely (tests), or `loadIndex` to
    replace it. Returns { code, summary, line, outPath }. */
export async function runDryRun({
  seedPath = DEFAULT_SEED,
  seedRequired = false,
  outPath = null,
  nowMs = Date.now(),
  topN = 5000,
  perRunCap = 300,
  changeIndex,
  loadIndex = loadChangeIndex,
  log = console.log,
  err = console.error,
} = {}) {
  const seed = loadSeed(seedPath, seedRequired);
  if (!seed.ok) {
    err(`poll-episodes: ${seed.reason}`);
    return { code: 1, summary: null, line: null, outPath: null };
  }
  if (seed.missing) {
    err(`poll-episodes: ${seed.missing}; continuing with no seed rows (tools/poll/build-watchlist-seed.mjs builds it, PKG-07)`);
  }

  const index = changeIndex ?? (await loadIndex());
  const indexOk = Boolean(index && index.ok === true);
  const change_index = indexOk
    ? { ok: true, changed: index.changedIds?.size ?? 0, top_rows: Array.isArray(index.topRows) ? index.topRows.length : 0 }
    : { ok: false, reason: index?.reason ?? "no result" };
  if (!indexOk) err(`poll-episodes: change index unavailable (${change_index.reason}); dry run from the seed alone`);

  const watchlist = buildWatchlist({ curatedShows: seed.rows, changeIndex: index, topN, nowMs });
  const selection = selectDue(watchlist, { nowMs, perRunCap });
  const projection = weeklyProjection(watchlist);
  const watch = summarize(watchlist);

  const summary = {
    version: 1,
    now: new Date(nowMs).toISOString(),
    top_n: topN,
    seed_rows: seed.rows.length,
    seed_status: seed.missing ? `missing: ${seed.missing}` : "ok",
    change_index,
    watchlist: watch,
    due: {
      count: selection.due.length,
      byHost: topHosts(selection.hosts),
      sample: selection.due.slice(0, 20).map((r) => ({ pi_id: r.pi_id, title: r.title, feed_url: r.feed_url, tier: r.tier })),
    },
    skipped: selection.skipped,
    projection,
    fetched: 0,
  };

  const target = outPath ?? defaultOutPath(nowMs);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(summary, null, 2) + "\n");

  const line = `dry-run: ${summary.due.count} due of ${watch.total} watched; ${Math.round(projection.requestsPerWeek)}/week projected at N=${topN} (target < ${TARGET_REQUESTS_PER_WEEK}); fetched 0`;
  log(line);
  return { code: 0, summary, line, outPath: target };
}

/** The CLI body. Returns the exit code. */
export async function main({ argv = [], env = process.env, log = console.log, err = console.error, ...dryRunOverrides } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err(`poll-episodes: ${e.message}`);
    return 1;
  }
  if (!opts.dryRun) {
    const { url } = resolveDatabaseUrl(env);
    if (!url) {
      log(NO_DB_MESSAGE);
      return 0;
    }
    log(LIVE_REFUSAL);
    return 3;
  }
  const res = await runDryRun({
    seedPath: opts.seedPath,
    seedRequired: opts.seedGiven,
    outPath: opts.outPath,
    nowMs: opts.nowMs ?? Date.now(),
    topN: opts.topN,
    perRunCap: opts.perRunCap,
    log,
    err,
    ...dryRunOverrides,
  });
  return res.code;
}

/* tools/ci/entry.mjs's guard: a `file://${argv[1]}` template never matches on
   Windows, a pathToFileURL comparison never matches through a junction (see
   tools/build-catalog-client.mjs's entrypoint-guard comment). */
if (isEntryScript(import.meta.url)) {
  process.exitCode = await main({ argv: process.argv.slice(2) });
}
