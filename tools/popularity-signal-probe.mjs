#!/usr/bin/env node
/* PKG-12 (docs/roadmap/shows-search.md) — the P-10 popularity probe.

   THE QUESTION (docs/search-parity-plan.md P-10, option 1)
   `chart_rank` is Apple's PER-GENRE chart position, so `popularityBand`
   collapses it to <=10/<=50/<=200 and, inside the top band, the alphabet
   decides: `daily` puts *The Daily* 17th behind ~15 other rank-1..10 rows from
   other genres. Option 1 is "a cross-genre popularity measure". The S-04
   change-index release may already carry one: `tools/shows/shard-build.mjs`'s
   `buildTop` writes `top.json` as every curated show plus the top N
   non-curated shows, each block sorted by the PodcastIndex dump's
   `popularityScore`. The score itself is NOT in the row (`toShardRow` keeps
   `{ id, t, a, i, u, img, n, c }`), so the row's POSITION is the signal, and
   `i` (the iTunes id) joins it to the breadth index, whose `show_id` IS the
   Apple collection id.

   This file measures three things and changes nothing:
     signal   — whether top.json's order is popularity at all, or just pi_id
                order (see `blockOrder`: a tied score sorts by id);
     coverage — how many index rows carry a top.json position at all;
     order    — for the four queries `test/show-search-ranking.test.js` pins,
                whether the show the listener meant would lead the rows above
                it if position were the prior.

   WHAT "top_position" MEANS, EXACTLY. The 0-based index of the row in
   top.json. top.json is TWO popularity-sorted blocks concatenated, curated
   first (`[...curated, ...topRest]`), so a curated row's position is always
   smaller than any non-curated row's and the two are NOT comparable with each
   other. Positions are comparable inside one block only.

   WHAT "would_lead_by_top_position" MEANS, EXACTLY. True when the intended show
   has a top_position and no row ranked above it today, IN THE SAME TIER, has a
   smaller one. "Same tier" is the comparator group the popularity prior is
   consulted inside: `compareShowMatches` orders by match tier
   (exact / word-boundary / substring), then curated-before-breadth, and only
   then by `popularityBand`. A position prior would replace that band and could
   only ever reorder rows that tie on both keys above it, so those are the rows
   it is compared against. That is also exactly the set where top.json's two
   blocks never mix (curated is one of the two keys), so the comparison never
   reads a curated-block position against a breadth-block one.
   The intended show with NO position is `false`: the signal cannot speak for it.

   WHY NOT `loadChangeIndex` (the card's step 2), measured 2026-10-04.
   `tools/refresh/candidates.mjs` `loadChangeIndex` downloads all three release
   assets and, since #835 (audit round 3), refuses any release whose
   `changed.json` is the pre-baseline bare array. The only published release,
   `shows-index-sat-12-sep-2026-23-24-31-gmt`, ships exactly that array, 7.0 MB
   of it (`gh release view` asset sizes: changed.json 7,011,308 B, top.json
   616,389 B). So the card's call returns `ok:false` with no `topRows` at ANY
   max-age, after a 7 MB download it never needed. This reads the same pointer
   (`tools/shows/config.mjs` POINTER_PATH) and fetches `top.json` alone — the
   card's own budget of "one release download, < 1 MB" — with the pointer age
   unbounded and recorded rather than enforced, which is what the card asked
   `maxAgeHours: Infinity` for.

   NETWORK: one GET (plus any redirect `fetch` follows), through
   `tools/segments/politeness.mjs`'s host gate and client User-Agent, retried on
   429/5xx with that module's backoff. Tests inject a fake fetch and never
   touch the network.

   Usage: node tools/popularity-signal-probe.mjs [--out path] [--check]
     --out    write the JSON report (validated first; an invalid report is
              refused, not written)
     --check  validate the report's shape and exit 1 if it is wrong        */

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryScript } from "./ci/entry.mjs";
import { POINTER_PATH } from "./shows/config.mjs";
import { UA, awaitHostSlot, waitBeforeRetry, discardBody } from "./segments/politeness.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The four queries `test/show-search-ranking.test.js` pins, with the show
    each one is for. Order matters only for the printed summary. */
export const PINNED_QUERIES = Object.freeze([
  ["history", "Dan Carlin's Hardcore History"],
  ["daily", "The Daily"],
  ["money", "Planet Money"],
  ["american", "This American Life"],
]);

export const TOP_ROWS_REPORTED = 25;
const FETCH_ATTEMPTS = 3;

/** A GET through the shared politeness gate. Retries 429 and 5xx (and a
    thrown network error) up to `attempts` times; `waitBeforeRetry` holds the
    whole host, and the next `awaitHostSlot` is what actually waits. */
export async function politeFetch(url, { fetchImpl = fetch, attempts = FETCH_ATTEMPTS, gate = {} } = {}) {
  for (let attempt = 1; ; attempt++) {
    await awaitHostSlot(url, gate);
    let res;
    try {
      res = await fetchImpl(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    } catch (e) {
      if (attempt >= attempts) throw e;
      waitBeforeRetry(url, null, attempt, gate);
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
      await discardBody(res);
      waitBeforeRetry(url, res, attempt, gate);
      continue;
    }
    return res;
  }
}

/** Reads the change-index pointer and fetches its `top.json`. Throws with a
    reason on any failure: a probe that cannot read the signal has nothing to
    report, and an empty report would read as "zero coverage". */
export async function loadTopRows({ pointer, pointerPath = POINTER_PATH, fetchImpl = fetch, now = Date.now(), gate } = {}) {
  const p = pointer ?? JSON.parse(readFileSync(pointerPath, "utf8"));
  if (!p || !p.asset_base_url) throw new Error("pointer has no asset_base_url");
  const publishedMs = p.published_at ? Date.parse(p.published_at) : NaN;
  const url = `${p.asset_base_url}/top.json`;
  const res = await politeFetch(url, { fetchImpl, gate });
  if (!res.ok) throw new Error(`top.json fetch failed: HTTP ${res.status} (${url})`);
  const topRows = await res.json();
  if (!Array.isArray(topRows)) throw new Error("top.json is not an array");
  return {
    topRows,
    url,
    release_tag: p.release_tag ?? null,
    published_at: p.published_at ?? null,
    age_hours: Number.isNaN(publishedMs) ? null : Math.round(((now - publishedMs) / 3_600_000) * 10) / 10,
  };
}

/** `String(row.i)` -> index in top.json. The coercion is the join: top.json's
    `i` is the dump's numeric itunesId, while the breadth index's `show_id` and
    the lookups below are strings. A row with no `i` is skipped (and counted by
    the caller). The FIRST occurrence wins, which is the more popular one. */
export function buildPositionMap(topRows) {
  const posByItunesId = new Map();
  const curatedByItunesId = new Map();
  let withId = 0;
  let curated = 0;
  topRows.forEach((row, idx) => {
    if (row && row.c) curated++;
    if (row == null || row.i == null || row.i === "") return;
    withId++;
    const key = String(row.i);
    if (!posByItunesId.has(key)) {
      posByItunesId.set(key, idx);
      curatedByItunesId.set(key, !!row.c);
    }
  });
  return { posByItunesId, curatedByItunesId, total: topRows.length, withId, curated };
}

/** Is a top.json block's order distinguishable from pi_id order?
    `buildTop` sorts by `popularityScore` desc, THEN `id` asc. If every score
    in a block ties (or is missing, which `Number(x) || 0` turns into a tie),
    the block comes out in plain ascending pi_id — PodcastIndex registration
    order, i.e. feed age — and its positions say nothing about popularity. A
    block with zero adjacent inversions is exactly that case, so a position
    "signal" read from it would be a feed-age signal under another name. */
export function blockOrder(rows) {
  let inversions = 0;
  for (let k = 1; k < rows.length; k++) {
    if (Number(rows[k - 1].id) > Number(rows[k].id)) inversions++;
  }
  return { rows: rows.length, pi_id_inversions: inversions, ordered_by_pi_id: rows.length > 1 && inversions === 0 };
}

/** catalogue show_id -> String(apple_collection_id), from `data/catalog.json`
    (the client file drops the Apple id). */
export function appleIdByShowId(catalogShows) {
  const out = new Map();
  for (const s of catalogShows || []) {
    if (s && s.show_id && s.apple_collection_id != null && s.apple_collection_id !== "") {
      out.set(s.show_id, String(s.apple_collection_id));
    }
  }
  return out;
}

/** `search-engine.js`'s own rule: only a row that SAYS breadth is breadth. */
export function catalogTier(row) {
  return row?.tier === "breadth" ? "breadth" : "curated";
}

/** A row's top.json position, or null. Breadth rows join on their own
    show_id (the Apple collection id); curated rows go through the catalogue. */
export function makePositionOf(posByItunesId, appleIds) {
  return (row) => {
    if (!row) return null;
    const appleId = catalogTier(row) === "breadth" ? String(row.show_id) : appleIds.get(row.show_id);
    if (appleId == null) return null;
    const pos = posByItunesId.get(appleId);
    return pos == null ? null : pos;
  };
}

/** Coverage over the parsed index rows (`parseShowIndex(...).rows`). */
export function computeCoverage(indexRows, positionOf) {
  let breadth = 0;
  let curated = 0;
  let breadthHit = 0;
  let curatedHit = 0;
  for (const row of indexRows) {
    const hit = positionOf(row) != null;
    if (catalogTier(row) === "breadth") {
      breadth++;
      if (hit) breadthHit++;
    } else {
      curated++;
      if (hit) curatedHit++;
    }
  }
  return {
    index_rows: indexRows.length,
    breadth_rows: breadth,
    curated_rows: curated,
    breadth_rows_with_top_position: breadthHit,
    curated_rows_with_top_position: curatedHit,
    pct_breadth: breadth ? Math.round((breadthHit / breadth) * 10000) / 100 : 0,
  };
}

/** See the header. `rows` is the ranked list, `at` the intended show's index
    in it, `groupOf` the comparator group (match tier + catalogue tier). */
export function wouldLeadByTopPosition(rows, at, positionOf, groupOf) {
  if (at < 0 || at >= rows.length) return false;
  const mine = positionOf(rows[at]);
  if (mine == null) return false;
  const group = groupOf(rows[at]);
  for (let i = 0; i < at; i++) {
    if (groupOf(rows[i]) !== group) continue;
    const p = positionOf(rows[i]);
    if (p != null && p < mine) return false;
  }
  return true;
}

const MATCH_TIER_NAMES = ["exact", "boundary", "substring", "unmatched"];

/** The list a listener sees before any network pass — the same merge
    `test/show-search-ranking.test.js` builds: the curated 220 from the client
    catalogue, plus every index row whose show_id is not one of them. */
export function mergedShowList(catalogClientShows, indexRows) {
  const seen = new Set(catalogClientShows.map((s) => s.show_id));
  return catalogClientShows.concat(indexRows.filter((r) => !seen.has(r.show_id)));
}

export function probeQuery(SearchEngine, q, intendedTitle, shows, positionOf) {
  const folded = SearchEngine.foldDiacritics(q).trim();
  const matchTier = (row) =>
    SearchEngine.showMatchTier(SearchEngine.showMatchBucket(SearchEngine.foldDiacritics(row.title), folded).bucket);
  const groupOf = (row) => `${matchTier(row)}|${catalogTier(row)}`;
  const results = SearchEngine.searchShows(q, shows);
  const at = results.findIndex((s) => s.title === intendedTitle);
  const top25 = results.slice(0, TOP_ROWS_REPORTED).map((s, i) => [
    i + 1,
    s.title,
    catalogTier(s),
    s.chart_rank ?? null,
    positionOf(s),
  ]);
  const sameTierAbove = at < 0 ? [] : results.slice(0, at).filter((s) => groupOf(s) === groupOf(results[at]));
  const positioned = sameTierAbove.map((s) => [s.title, positionOf(s)]).filter(([, p]) => p != null);
  positioned.sort((a, b) => a[1] - b[1]);
  return {
    top25,
    intended: {
      title: intendedTitle,
      rank_today: at < 0 ? null : at + 1,
      top_position: at < 0 ? null : positionOf(results[at]),
      match_tier: at < 0 ? null : MATCH_TIER_NAMES[matchTier(results[at])],
      catalog_tier: at < 0 ? null : catalogTier(results[at]),
      same_tier_rows_above: sameTierAbove.length,
      same_tier_rows_above_with_position: positioned.length,
      best_position_above: positioned[0] ?? null,
    },
    would_lead_by_top_position: wouldLeadByTopPosition(results, at, positionOf, groupOf),
  };
}

/** Builds the whole report from already-loaded inputs. Pure. */
export function buildReport({ SearchEngine, indexText, catalogClient, catalog, top, generatedAt }) {
  const index = SearchEngine.parseShowIndex(indexText);
  const map = buildPositionMap(top.topRows);
  const positionOf = makePositionOf(map.posByItunesId, appleIdByShowId(catalog.shows ?? catalog));
  const shows = mergedShowList(catalogClient.shows, index.rows);
  const queries = {};
  for (const [q, title] of PINNED_QUERIES) queries[q] = probeQuery(SearchEngine, q, title, shows, positionOf);
  return {
    generated_at: generatedAt,
    pointer_release_tag: top.release_tag,
    pointer_published_at: top.published_at,
    pointer_age_hours: top.age_hours,
    top_json: {
      url: top.url,
      rows: map.total,
      rows_with_itunes_id: map.withId,
      curated_rows: map.curated,
      curated_block_order: blockOrder(top.topRows.filter((r) => r && r.c)),
      non_curated_block_order: blockOrder(top.topRows.filter((r) => r && !r.c)),
      position_semantics:
        "0-based index in top.json; curated block first, then the top non-curated by popularityScore; positions compare only within one block",
    },
    coverage: computeCoverage(index.rows, positionOf),
    queries,
  };
}

/** Shape only. Returns a list of problems; empty means valid. */
export function validateReport(report) {
  const errors = [];
  if (!report || typeof report !== "object") return ["report is not an object"];
  for (const key of ["generated_at", "pointer_release_tag", "pointer_published_at"]) {
    if (typeof report[key] !== "string" || !report[key]) errors.push(`${key} must be a non-empty string`);
  }
  if (typeof report.pointer_age_hours !== "number" || !Number.isFinite(report.pointer_age_hours)) {
    errors.push("pointer_age_hours must be a finite number — the pointer age is unbounded on purpose, so it has to be recorded");
  }
  const c = report.coverage;
  if (!c || typeof c !== "object") {
    errors.push("coverage section missing");
  } else {
    for (const key of ["index_rows", "breadth_rows_with_top_position", "curated_rows_with_top_position", "pct_breadth"]) {
      if (typeof c[key] !== "number" || !Number.isFinite(c[key])) errors.push(`coverage.${key} must be a number`);
    }
  }
  const qs = report.queries;
  if (!qs || typeof qs !== "object") {
    errors.push("queries section missing");
    return errors;
  }
  for (const [q] of PINNED_QUERIES) {
    const entry = qs[q];
    if (!entry) {
      errors.push(`queries.${q} missing — all four pinned queries are required`);
      continue;
    }
    if (!Array.isArray(entry.top25)) errors.push(`queries.${q}.top25 must be an array`);
    else if (entry.top25.some((row) => !Array.isArray(row) || row.length !== 5)) {
      errors.push(`queries.${q}.top25 rows must be [rank, title, tier, chart_rank, top_position]`);
    }
    const i = entry.intended;
    if (!i || typeof i.title !== "string" || !("rank_today" in i) || !("top_position" in i)) {
      errors.push(`queries.${q}.intended must carry title, rank_today and top_position`);
    }
    if (typeof entry.would_lead_by_top_position !== "boolean") {
      errors.push(`queries.${q}.would_lead_by_top_position must be a boolean`);
    }
  }
  return errors;
}

export function summaryLines(report) {
  const c = report.coverage;
  const order = (b) => (b ? `${b.pi_id_inversions} pi_id inversions in ${b.rows}` : "n/a");
  const lines = [
    `pointer ${report.pointer_release_tag} published ${report.pointer_published_at} (${report.pointer_age_hours}h old); top.json curated block ${order(report.top_json?.curated_block_order)}, non-curated ${order(report.top_json?.non_curated_block_order)}`,
    `coverage: ${c.breadth_rows_with_top_position}/${c.breadth_rows} breadth rows (${c.pct_breadth}%), ${c.curated_rows_with_top_position}/${c.curated_rows} curated, of ${c.index_rows} index rows`,
  ];
  for (const [q] of PINNED_QUERIES) {
    const e = report.queries[q];
    lines.push(`${q}: ${e.intended.title} rank ${e.intended.rank_today ?? "-"}, top_position ${e.intended.top_position ?? "null"}, would_lead_by_top_position ${e.would_lead_by_top_position}`);
  }
  return lines;
}

function parseArgs(argv) {
  const out = { outPath: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out.outPath = path.resolve(argv[++i]);
    else if (argv[i] === "--check") out.check = true;
    else throw new Error(`unknown argument ${argv[i]}\nusage: node tools/popularity-signal-probe.mjs [--out path] [--check]`);
  }
  return out;
}

async function main() {
  const { outPath, check } = parseArgs(process.argv.slice(2));
  const SearchEngine = createRequire(import.meta.url)(path.join(ROOT, "search-engine.js"));
  const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), "utf8"));
  const top = await loadTopRows();
  const report = buildReport({
    SearchEngine,
    indexText: readFileSync(path.join(ROOT, "data/show-index.tsv"), "utf8"),
    catalogClient: readJson("data/catalog-client.json"),
    catalog: readJson("data/catalog.json"),
    top,
    generatedAt: new Date().toISOString(),
  });

  /* The card's two stop conditions. Both mean the join is broken, not that
     the signal is weak, so neither may be written up as a measurement. */
  if (report.top_json.rows_with_itunes_id === 0) {
    console.error("STOP: top.json rows carry no `i` (iTunes id) — nothing to join on.");
    process.exit(2);
  }
  if (report.coverage.breadth_rows_with_top_position === 0) {
    console.error("STOP: breadth coverage is exactly 0 — a join bug, not a finding.");
    process.exit(2);
  }

  for (const line of summaryLines(report)) console.log(line);

  const errors = validateReport(report);
  if (errors.length) {
    console.error("\npopularity-signal-probe: report shape INVALID:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  if (check) console.log("\npopularity-signal-probe --check: structurally valid.");
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
    console.log(`wrote ${path.relative(ROOT, outPath)}`);
  }
}

/* tools/ci/entry.mjs's guard, never a `file://${argv[1]}` template — see
   tools/entrypoint-guards.test.mjs for why the template is false on Windows and
   a pathToFileURL comparison false through a junction. */
if (isEntryScript(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
