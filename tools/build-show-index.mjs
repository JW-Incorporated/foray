#!/usr/bin/env node
/* Derives data/show-index.tsv from data/catalog.json + data/catalog-breadth.json
   (S-03, docs/search-plan.md). Modelled line-for-line on
   tools/build-catalog-client.mjs: same `--out`/`--check` argument shape, same
   "refusing to write an empty derivation" guard, same "the field list is the
   contract" header.

   ============================================================================
   THE DESIGN COMMENT S-03 ASKS FOR, BEFORE THE CODE
   ----------------------------------------------------------------------------
   The card asks for this argument in the PR before the code is written. It is
   here instead, at the top of the module it decides, because a PR comment is
   read once by one reviewer and this file is read by everyone who touches the
   index afterwards — which is exactly the class of decision that should not
   live in a thread. (Said so in the PR body too.)

   (1) WHAT SHAPE, AND WHY NOT A TRIE.
   Measured, docs/search-plan.md §1.3: a linear `indexOf` scan over all 19,904
   merged titles costs 12.9-19.9 ms on the founder's workstation — over a 16 ms
   frame budget, and a mid-range phone is commonly 2-4x slower. A PREFIX answer
   over a sorted array is two binary searches, ~15 comparisons, and free. So the
   emitted file is a flat TSV sorted by lowercased title and the client does
   binary search on the keystroke and the linear scan only on the debounce tick
   (search-engine.js `prefixSearchShows` / `scanShowIndex`). A trie or an FST
   answers the same prefix question for a bespoke binary format and a decoder
   nobody else in this repo reads; these numbers do not justify that.
   Front-coding was measured too and is WORSE: it saves 8 KB raw and costs
   22 KB gzipped, because gzip's own window already exploits the shared
   prefixes of sorted titles. Do not hand-roll it.

   (2) THE SORT ORDER IS THE CONTRACT, and it is code-unit order, not
   `localeCompare`. `prefixSearchShows` compares keys with `<`. A builder that
   sorted with `localeCompare` (which puts "é" next to "e") and a client that
   binary-searches with `<` (which puts it after "z") would disagree on every
   accented title and the disagreement would be SILENT — a prefix query would
   return a slice of the wrong part of the file, not an error. Both sides
   therefore use `<` on the lowercased title, and `test/show-index.test.js`
   pins the emitted order against a reference linear filter.

   (3) HOW IT REACHES THE DEVICE — OPTION B, RUNTIME-CACHED, NOT PRECACHED.
   docs/search-plan.md §1.5 measured the trap: `fetchJson()` pins every call to
   the deploy generation (`app.js:pinnedUrl` appends `?_fdid=`), and
   `sw.js:handleData`'s tagged branch returns a bare 504 for a pinned file the
   generation does not hold. So the index must either be added to `RUNTIME_DATA`
   in BOTH `tools/web/prepare-dist.mjs` and `tools/ci/generate-manifest.mjs` and
   fetched pinned (option A), or served from `prepare-dist.mjs` only and fetched
   UNPINNED (option B).

   This card ships B, and the argument is a cost one rather than a governance
   one (option A's `tools/ci/` touch needs the founder-approved label, which is
   a reason to be honest about the choice, not a reason to make it):
     - Option A puts the index on an ALL-OR-NOTHING precache that already
       re-downloads `data/discover.json` (2.41 MB) on every nightly deploy. The
       index is a title projection of a catalogue that changes on a HARVEST
       (last one 2026-07-09), not nightly, so option A would re-pay for it every
       night for a file that did not change.
     - It would also pay for it on behalf of every listener who never opens the
       search box. The index is fetched lazily on the FIRST FOCUS of `#sh-input`
       (app.js) precisely because that is the only moment it is worth anything.
     - The failure mode of B is the good one. An unpinned `data/` fetch goes
       through `sw.js:handleData`'s untagged branch: origin first, generation
       cache second, `unavailable()` (a 504) third. A 504 here is not a broken
       page — app.js treats an absent index as an absent index and keeps serving
       the 220-show curated pass, which is this repo's "absence is a real state"
       rule applied to a file that is, by construction, an optimisation.
     - B WAS EXPECTED TO COST NEW CODE IN `sw.js`, the highest-privilege file
       on the origin, and it does not. The card assumed a runtime-cache branch
       would have to be written; reading `sw.js:cachePut` says otherwise. Its
       last branch already caches a path `deploy-manifest.json` does not track,
       into the CURRENT generation's cache, with the comment "there are none
       today, but the check costs nothing and keeps this correct if one is ever
       added" — this is the one that has now been added. `handleData`'s untagged
       fallback then answers it from that cache when the origin cannot.
       Verified, not assumed: `test/sw-generation.test.js` has a test named for
       this index that fetches it live, goes offline, and reads it back, and a
       second half proving a manifest-TRACKED path is still protected from a
       stray runtime write. So option B's real cost is zero new worker code and
       one test that makes an existing branch load-bearing rather than
       defensive. The change that was written and then reverted is worth naming
       so nobody re-adds it: a separate `foray-runtime-v1` cache would have
       duplicated what `cachePut` already does and needed its own exemption
       from `activate`'s retention sweep.
     - What B genuinely costs: the index is evicted by a deploy, because the new
       generation's cache is staged from the manifest and this file is not in
       it. The next focus re-fetches it. That is the correct behaviour for a
       derived file, not a regression.

   (4) THE MOBILE BUNDLE. `tools/mobile/prepare-webdir.mjs`'s `runtimeDataFiles()`
   derives the bundle's data list by scanning app.js for literal
   `fetchJson("data/….json")` call sites, so option B's unpinned fetch is
   INVISIBLE to it and the index would silently not ship in the native bundle.
   It is therefore named explicitly there (`UNPINNED_DATA`), the same way
   `SEED_POINTER` already is for the same reason, with its own per-file budget
   checked against `MAX_BYTES`.

   (5) `docs/CATALOG-PIPELINE.md` FORWARD-COMPATIBILITY REQUIREMENT #5 says
   "the web client never fetches the breadth file." This does not violate it —
   what ships is a derived TITLE PROJECTION, exactly as `catalog-client.json` is
   a projection of `catalog.json`, and the 12.5 MB breadth file stays
   server-side. But the requirement's wording is amended in the same PR to say
   so, or the next reader reads a rule this deck appears to have broken.
   ============================================================================

   THE FIELD LIST IS THE CONTRACT `search-engine.js:parseShowIndex` reads
   against — four tab-separated columns, in this order:

     0  title        the show's title, verbatim, minus control characters
     1  id           the curated `show_id`, or `String(apple_collection_id)` for
                     a breadth row. THIS MUST MATCH
                     `backend/src/catalog/breadthCatalog.ts`'s minted id exactly,
                     so a tapped index result resolves through the same
                     `state.breadthShowCache` / `#/show/:id` path a breadth
                     result from the endpoint already does.
     2  chart_rank   Apple's PER-GENRE top-chart position 1-200, or the empty
                     string for a curated row (which has none and needs none).
                     Per-genre, from the 2026-07-09 harvest: NOT comparable
                     across genres, which is why search-engine.js's
                     `popularityBand` buckets it rather than scoring it.
     3  curated      "1" for a curated row, "0" for a breadth one.

   A column added or reordered here without the same change in
   `parseShowIndex` misreads every row silently, so change the two together —
   `test/show-index.test.js` pins the shape from the client's side.

   THE CUT (`--max-rank`), AND WHY IT DEFAULTS WHERE IT DOES. G5 in
   docs/search-plan.md §3 is the founder gate on the index budget; S-03's own
   acceptance line is <= 400 KB GZIPPED. Re-measured here, on this file's real
   output rather than on §1.2's throwaway probe (`zlib.gzipSync` level 9,
   `brotliCompressSync` defaults, 2026-09-12):

     cut              rows     raw       gzip      brotli
     chart_rank<=200  19,904   874.4 KB  398.4 KB  322.4 KB
     chart_rank<=150  15,077   657.7 KB  300.4 KB  245.2 KB
     chart_rank<=100  10,113   435.9 KB  201.1 KB  165.1 KB
     chart_rank<=50    5,136   219.7 KB  102.1 KB   85.1 KB

   THE COMMITTED CUT IS <=100, and the full set was rejected on two measured
   grounds rather than on taste:
     - 398.4 KB against a 400 KB budget is a 0.4 % margin. `chart_rank` comes
       from a HARVEST (`tools/harvest-catalog.mjs`), and the next one that adds
       a few hundred shows breaches it. A budget the next data refresh breaks
       is not a budget.
     - The native bundle counts RAW bytes against `prepare-webdir.mjs`'s
       `MAX_BYTES = 3 MB`. Measured the same day: the bundle is 1.79 MB today.
       The full index takes it to 2.66 MB (89 %), leaving less headroom than
       `data/discover.json`'s own 720 KB budget alone. The <=100 cut takes it
       to 2.21 MB (74 %).
   What the cut costs, stated plainly: a breadth show ranked 101-200 in its
   genre is not on the device. It is NOT lost — the debounced
   `api/shows/search` pass still searches all 19,904 server-side, and S-06's
   Apple fall-through fires from THERE (over the full merged catalogue), not
   from the client's index, precisely so the cut cannot turn into a wrong
   "zero hits" answer. Raising it is one flag and a rebuild if G5 says so.

   Usage: node tools/build-show-index.mjs [--out path] [--check] [--max-rank n] */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/* The committed cut — see THE CUT above for the measurement that chose it.
   A breadth show ranked worse than this in its genre is left to the
   server-side passes rather than carried on every device. 200 would be
   "everything the harvest has" (`chart_rank` is 1-200 by construction).
   `test/show-index.test.js` asserts the emitted file's GZIPPED size against
   S-03's 400 KB budget, so raising this number fails there first. */
export const BUILD_MAX_RANK = 100;

/** Tabs and newlines inside a value would break the row format; a control
    character would survive into the client's `innerHTML` path. Collapsed to a
    single space rather than dropped, so a title stays readable and its length
    (which the ranking's `localeCompare` tie-break reads) stays sane. */
export function sanitizeCell(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

/** Merged rows, in the shape the emitter writes. Curated first so a breadth
    duplicate that somehow escaped `in_curated` still loses the id race, which
    is `breadthCatalog.ts`'s own `seenIds` rule restated. */
export function mergeShowIndexRows(curated, breadth, { maxRank = BUILD_MAX_RANK } = {}) {
  if (!curated || !Array.isArray(curated.shows)) {
    throw new Error("data/catalog.json did not parse to { shows: [...] } — refusing to write an empty derivation");
  }
  if (!breadth || !Array.isArray(breadth.shows)) {
    throw new Error("data/catalog-breadth.json did not parse to { shows: [...] } — refusing to write an empty derivation");
  }

  const rows = [];
  const seen = new Set();

  for (const show of curated.shows) {
    const id = sanitizeCell(show?.show_id);
    const title = sanitizeCell(show?.title);
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    rows.push({ title, id, chart_rank: null, curated: true });
  }

  for (const show of breadth.shows) {
    if (show?.in_curated) continue; // already carried by the curated row above
    if (show?.apple_collection_id === undefined || show?.apple_collection_id === null) continue;
    const rank = Number(show?.chart_rank);
    /* An unranked breadth row is dropped, not kept at the bottom: `chart_rank`
       is present on all 19,787 rows today (measured), so a missing one means
       the harvest shape changed and this script should not guess. */
    if (!Number.isFinite(rank) || rank <= 0 || rank > maxRank) continue;
    const id = sanitizeCell(show.apple_collection_id);
    const title = sanitizeCell(show?.title);
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    rows.push({ title, id, chart_rank: rank, curated: false });
  }

  /* CODE-UNIT ORDER on the lowercased title — see the design comment (2).
     `id` breaks a title tie so the file is byte-stable across two runs over
     the same input, which is what makes `--check` meaningful. */
  rows.sort((a, b) => {
    const at = a.title.toLowerCase();
    const bt = b.title.toLowerCase();
    if (at < bt) return -1;
    if (at > bt) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return rows;
}

export function formatShowIndex(rows) {
  return rows.map(r => `${r.title}\t${r.id}\t${r.chart_rank ?? ""}\t${r.curated ? "1" : "0"}`).join("\n") + "\n";
}

export function buildShowIndex(curated, breadth, opts) {
  return formatShowIndex(mergeShowIndexRows(curated, breadth, opts));
}

function parseArgs(argv) {
  const out = { outPath: path.join(ROOT, "data", "show-index.tsv"), check: false, maxRank: BUILD_MAX_RANK };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") { out.outPath = path.resolve(argv[++i] ?? ""); continue; }
    if (a === "--check") { out.check = true; continue; }
    if (a === "--max-rank") { out.maxRank = Number.parseInt(argv[++i] ?? "", 10); continue; }
    throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isFinite(out.maxRank) || out.maxRank <= 0) throw new Error("--max-rank must be a positive integer");
  return out;
}

function main() {
  const { outPath, check, maxRank } = parseArgs(process.argv.slice(2));
  const curated = JSON.parse(readFileSync(path.join(ROOT, "data", "catalog.json"), "utf8"));
  const breadth = JSON.parse(readFileSync(path.join(ROOT, "data", "catalog-breadth.json"), "utf8"));
  const rows = mergeShowIndexRows(curated, breadth, { maxRank });
  if (!rows.length) throw new Error("derived show-index.tsv has zero rows — refusing to write");
  const text = formatShowIndex(rows);

  if (check) {
    const onDisk = readFileSync(outPath, "utf8");
    if (onDisk !== text) {
      console.error(`${path.relative(ROOT, outPath)} is stale — run: node tools/build-show-index.mjs`);
      process.exit(1);
    }
    console.log(`${path.relative(ROOT, outPath)} is up to date (${rows.length} shows, ${text.length} B).`);
    return;
  }

  writeFileSync(outPath, text);
  console.log(`wrote ${path.relative(ROOT, outPath)}: ${rows.length} shows, ${text.length} B (max chart_rank ${maxRank}).`);
}

/* `pathToFileURL`, not a `file://${argv[1]}` template — the template form is
   what tools/build-catalog-client.mjs uses and it is silently FALSE on Windows
   (a `C:\…` path is not `file://C:\…`), so the script would exit 0 having
   written nothing. tools/ci/path-policy.mjs already uses this form; matched to
   it rather than to the older neighbour. */
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
