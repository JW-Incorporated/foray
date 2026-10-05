/* Builds data/watchlist-seed.json, the committed curated half of the S-10
   watchlist (PKG-07, docs/roadmap/shows-search.md §3).

   Usage:
     node tools/poll/build-watchlist-seed.mjs            write the seed
     node tools/poll/build-watchlist-seed.mjs --check    re-derive and diff; write nothing
   Options: --out <path> (default data/watchlist-seed.json),
            --pointer <path> (default data/shows-index-pointer.json, via
            tools/refresh/candidates.mjs's loadChangeIndex default).

   What it writes: { version: 1, built_at, pointer_release_tag, rows } where
   `rows` is buildWatchlist()'s CURATED rows only (~220), each with its pi_id
   from the release's id-map.json. `changed_in_dump` rows and reasons are NOT
   written: they say what changed in one week's release, so the poller
   recomputes them at run time (PKG-08) and committing them would make the
   seed stale a week later. One row per line keeps the file under 60 KB.

   Exit codes:
     0  wrote the seed, or --check found it up to date
     1  --check found it stale or missing; or a refusal (fewer than 200 rows,
        over 60 KB, id-map.json values that are not numbers)
     2  loadChangeIndex() returned ok:false — the reason is printed and NOTHING
        is written. This is by design while the release has no baseline: a
        seed built without the id-map would mark every curated show unmapped.
        Do not "fix" it by widening maxAgeHours.

   Never wire --check into CI: the seed is pinned to one release's id-map, and
   a weekly release that maps one more show would turn every PR red. It is a
   local regenerate/verify pair, like tools/build-catalog-client.mjs. */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadChangeIndex } from "../refresh/candidates.mjs";
import { buildWatchlist, summarize, assertSeedSize } from "./watchlist.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_OUT = path.join(ROOT, "data", "watchlist-seed.json");
const DEFAULT_CATALOG = path.join(ROOT, "data", "catalog.json");
const DEFAULT_POINTER = path.join(ROOT, "data", "shows-index-pointer.json");
export const MAX_SEED_BYTES = 60 * 1024;

export function parseArgs(argv) {
  const out = { outPath: DEFAULT_OUT, pointerPath: DEFAULT_POINTER, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") { out.outPath = path.resolve(argv[++i] ?? ""); continue; }
    if (a === "--pointer") { out.pointerPath = path.resolve(argv[++i] ?? ""); continue; }
    if (a === "--check") { out.check = true; continue; }
    throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

/** The seed object: curated rows only, with no changed_in_dump anywhere. An
    empty changed set is passed rather than filtering afterwards, so the rule
    is "this week's diff is never consulted", not "consulted then stripped". */
export function buildSeed({ curatedShows, changeIndex, nowMs, pointerReleaseTag = null }) {
  const rows = buildWatchlist({
    curatedShows,
    changeIndex: { ...changeIndex, changedIds: new Set(), topRows: [] },
    topN: 0,
    nowMs,
  });
  return { version: 1, built_at: new Date(nowMs).toISOString(), pointer_release_tag: pointerReleaseTag, rows };
}

/** One row per line: diffable, and ~56 KB for 220 rows instead of ~77 KB. */
export function serializeSeed(seed) {
  const head = JSON.stringify({ version: seed.version, built_at: seed.built_at, pointer_release_tag: seed.pointer_release_tag });
  const rows = seed.rows.map((r) => "  " + JSON.stringify(r)).join(",\n");
  return head.slice(0, -1) + `,"rows":[\n${rows}\n]}\n`;
}

function comparable(seed) {
  const { built_at: _ignored, ...rest } = seed;
  return JSON.stringify(rest);
}

function readPointerTag(pointerPath) {
  try {
    return JSON.parse(readFileSync(pointerPath, "utf8")).release_tag ?? null;
  } catch {
    return null;
  }
}

/** Testable body of the CLI. Returns the exit code; never calls process.exit.
    `loadIndex` is injectable so a test can hand it a fake ok:false / ok:true
    index without a network or a pointer file. */
export async function run({
  argv = [],
  loadIndex = loadChangeIndex,
  catalogPath = DEFAULT_CATALOG,
  nowMs = Date.now(),
  log = console.log,
  err = console.error,
} = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err(`build-watchlist-seed: ${e.message}`);
    return 1;
  }
  const rel = path.relative(ROOT, opts.outPath) || opts.outPath;

  const changeIndex = await loadIndex({ pointerPath: opts.pointerPath });
  if (!changeIndex || changeIndex.ok !== true) {
    err(`build-watchlist-seed: change index unavailable: ${changeIndex?.reason ?? "no result"}`);
    err(`build-watchlist-seed: wrote nothing (exit 2). The seed needs a release with a baseline (docs/roadmap/shows-search.md, PKG-07).`);
    return 2;
  }
  const badIds = Object.entries(changeIndex.idMap ?? {}).filter(([, v]) => typeof v !== "number" || !Number.isFinite(v));
  if (badIds.length) {
    err(`build-watchlist-seed: id-map.json values are not numbers (e.g. ${JSON.stringify(badIds[0])}); refusing`);
    return 1;
  }

  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const seed = buildSeed({
    curatedShows: catalog.shows,
    changeIndex,
    nowMs,
    pointerReleaseTag: readPointerTag(opts.pointerPath),
  });
  try {
    assertSeedSize(seed.rows);
  } catch (e) {
    err(`build-watchlist-seed: ${e.message}`);
    return 1;
  }
  const text = serializeSeed(seed);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes >= MAX_SEED_BYTES) {
    err(`build-watchlist-seed: seed is ${bytes} B, over the ${MAX_SEED_BYTES} B ceiling; refusing`);
    return 1;
  }

  if (opts.check) {
    let onDisk;
    try {
      onDisk = JSON.parse(readFileSync(opts.outPath, "utf8"));
    } catch (e) {
      err(`${rel} is missing or unreadable (${e.message}) -- run: node tools/poll/build-watchlist-seed.mjs`);
      return 1;
    }
    if (comparable(onDisk) !== comparable(seed)) {
      err(`${rel} is stale -- run: node tools/poll/build-watchlist-seed.mjs`);
      return 1;
    }
    log(`${rel} is up to date (${seed.rows.length} rows).`);
    return 0;
  }

  writeFileSync(opts.outPath, text);
  log(`wrote ${rel}: ${seed.rows.length} rows, ${bytes} B (release ${seed.pointer_release_tag ?? "unknown"}).`);
  log(JSON.stringify(summarize(seed.rows), null, 2));
  return 0;
}

/* pathToFileURL, not a `file://${argv[1]}` template: the template never matches
   on Windows (see tools/build-catalog-client.mjs's entrypoint-guard comment). */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run({ argv: process.argv.slice(2) });
}
