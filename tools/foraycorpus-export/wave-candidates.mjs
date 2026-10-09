#!/usr/bin/env node
/* Drinks-wave candidate list for #279 (PKG-35, docs/roadmap/corpus.md §3
   "PKG-35 · #279 drinks-wave candidate list").

   #279 found the alcohol Foray blocked by curation, not supply: the tape
   exists in the breadth tier (data/catalog-breadth.json, Apple-chart rows)
   and is not in the curated catalogue. This module filters breadth titles on
   a fixed drinks word list and joins each match to what the repo already
   knows about it, so PKG-36 can pick the wave with evidence in front of it:

   - `in_curated` is COMPUTED from data/catalog.json (normalised feed URL via
     normalizeFeedUrl from tools/shows/identity.mjs, or Apple collection id),
     never read from the breadth row. The breadth flag is a harvest-time
     snapshot: it still says false for the seven shows PR #289 curated.
     `curated_show_id` names the matched catalog show, so the report can say
     which of them PR #289 added (ALREADY CURATED, not candidates).
   - `dai_prior` is data/dai-classification.json
     `shows[String(apple_collection_id)].dai` (host-based prior; that file
     covers only the curated shows, so most breadth rows get null) and
     `dai_measured` is the same entry's `ad_inflation?.verdict ?? null`.
   - `timed_transcript_episodes` comes from a corpus shows.jsonl row
     (catalogue.mjs buildShows) when one matches, else from
     data/breadth-transcript-yield.json `episodes_with_timed_transcript`, else
     null (never swept).
   - `english` is null unless a shows.jsonl row matches. shows.jsonl only
     carries `english_candidate_status === "yes"` podcasts, so a matching row
     means true, unless its declared `language` is a non-English code (false).
     No row says nothing about language, so it is null, never a default true.

   Sort: dai_prior false, then null (unknown), then true; within a tier,
   timed episodes descending (null last); then title. `score` encodes the
   first two keys as one number (tier * 10000 + min(timed, 9999), where tier
   is 2 for false, 1 for null, 0 for true and an unswept show counts 0 timed)
   so a consumer can rank without re-implementing the rule.

   This module never writes data/. #279's rule is "label, never exclude":
   the list labels; PKG-36 applies the wave to data/catalog.json.

   CLI: node tools/foraycorpus-export/wave-candidates.mjs [--shows <shows.jsonl>]
   [--out data-local/corpus-export/wave-drinks.json]
   [--md docs/curation/wave-drinks-candidates-2026-09.md]
   Reads data/ only when the CLI runs. No network. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { isEntryScript } from "../ci/entry.mjs";

import { normalizeFeedUrl } from "../shows/identity.mjs";
import { EXPORT_OUT_DIR, ROOT } from "./config.mjs";
import { readShowsJsonl } from "./overlap.mjs";
import { idKey, rowsOf } from "./rows.mjs";

export const DRINK_WORDS = Object.freeze([
  "whisky",
  "whiskey",
  "bourbon",
  "wine",
  "winemaking",
  "beer",
  "brewing",
  "cider",
  "distill",
  "distilling",
  "distillery",
  "spirits",
  "cocktail",
  "cocktails",
  "mead",
  "sake",
  "rum",
  "gin",
  "vodka",
  "tequila",
  "mezcal",
  "sommelier",
  "vineyard",
  "drinks",
]);

/** A word must be delimited by a non-letter or the string edge on BOTH sides,
    so `gin` does not match "Imagine", `rum` not "Forum", `mead` not "Meadows". */
export const DRINKS_RE = new RegExp("(^|[^a-z])(" + DRINK_WORDS.join("|") + ")([^a-z]|$)", "i");

/** camelCase titles are split before the test ("WhiskyCast" -> "Whisky Cast"),
    because with the `i` flag the boundary rule cannot tell the `C` of "Cast"
    from a letter that continues the word, and the spec's own positive
    "WhiskyCast" would otherwise miss. Only a lower-to-upper step splits, so
    "Imagine", "Forum" and "Meadows" are untouched. */
export function splitCamel(title) {
  return String(title ?? "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function drinksFilter(title) {
  return DRINKS_RE.test(splitCamel(title));
}

export const DEFAULT_OUT = join(EXPORT_OUT_DIR, "wave-drinks.json");
export const DEFAULT_MD = join(ROOT, "docs", "curation", "wave-drinks-candidates-2026-09.md");
export const REPORT_TOP = 120;

/** The seven shows PR #289 curated (#278's list, #279's revised scope). */
export const PR_289_SHOW_IDS = Object.freeze([
  "basic-brewing-radio",
  "whiskycast",
  "ill-drink-to-that-wine-talk",
  "inside-winemaking",
  "cider-chat",
  "bourbon-pursuit",
  "spirits-and-distilling",
]);

/** Lookup by Apple id (as string) first, then by normalised feed URL. */
function indexBy(rows, idOf, feedOf) {
  const byId = new Map();
  const byFeed = new Map();
  for (const row of rows) {
    const id = idKey(idOf(row));
    if (id !== null && !byId.has(id)) byId.set(id, row);
    const feed = normalizeFeedUrl(feedOf(row));
    if (feed !== "" && !byFeed.has(feed)) byFeed.set(feed, row);
  }
  return (show) => {
    const id = idKey(show?.apple_collection_id);
    if (id !== null && byId.has(id)) return byId.get(id);
    const feed = normalizeFeedUrl(show?.feed_url);
    return feed !== "" && byFeed.has(feed) ? byFeed.get(feed) : null;
  };
}

function englishOf(showsRow) {
  if (!showsRow) return null;
  const lang = typeof showsRow.language === "string" ? showsRow.language.trim().toLowerCase() : "";
  if (lang !== "" && !/^en(\b|[-_])/.test(lang)) return false;
  return true;
}

function daiTier(prior) {
  if (prior === false) return 2;
  if (prior === true) return 0;
  return 1;
}

function scoreOf(row) {
  const timed = Number.isFinite(row.timed_transcript_episodes) ? Math.min(row.timed_transcript_episodes, 9999) : 0;
  return daiTier(row.dai_prior) * 10000 + timed;
}

export function compareWaveRows(a, b) {
  const tier = daiTier(b.dai_prior) - daiTier(a.dai_prior);
  if (tier !== 0) return tier;
  const ta = Number.isFinite(a.timed_transcript_episodes) ? a.timed_transcript_episodes : -1;
  const tb = Number.isFinite(b.timed_transcript_episodes) ? b.timed_transcript_episodes : -1;
  if (ta !== tb) return tb - ta;
  return String(a.title ?? "").localeCompare(String(b.title ?? ""), "en");
}

/**
 * @param {{breadth: object|Array, yields?: object|Array, dai?: {shows?: object}, shows?: Array|null,
 *          catalog?: object|Array, filter?: (title: string) => boolean}} inputs
 * @returns {Array<{apple_collection_id, title, feed_url, in_curated, curated_show_id, chart_rank, english,
 *          timed_transcript_episodes, dai_prior, dai_measured, score}>}
 */
export function buildWave({ breadth, yields = null, dai = null, shows = null, catalog = null, filter = drinksFilter }) {
  const yieldOf = indexBy(rowsOf(yields), (r) => r?.apple_collection_id, (r) => r?.feed_url);
  const corpusOf = indexBy(Array.isArray(shows) ? shows : [], (r) => r?.itunes_id, (r) => r?.feed_url_normalized ?? r?.feed_url);
  const curatedOf = indexBy(rowsOf(catalog), (r) => r?.apple_collection_id, (r) => r?.feed_url);
  const daiShows = dai?.shows && typeof dai.shows === "object" ? dai.shows : {};

  const byKey = new Map();
  for (const show of rowsOf(breadth)) {
    if (!filter(show?.title)) continue;
    const key = idKey(show?.apple_collection_id) ?? `feed:${normalizeFeedUrl(show?.feed_url)}`;
    const prev = byKey.get(key);
    const rank = Number.isFinite(show?.chart_rank) ? show.chart_rank : Infinity;
    const prevRank = prev && Number.isFinite(prev.chart_rank) ? prev.chart_rank : Infinity;
    if (!prev || rank < prevRank) byKey.set(key, show);
  }

  const rows = [];
  for (const show of byKey.values()) {
    const corpus = corpusOf(show);
    const swept = yieldOf(show);
    const daiKey = idKey(show.apple_collection_id);
    const entry = daiKey !== null && Object.hasOwn(daiShows, daiKey) ? daiShows[daiKey] : undefined;
    let timed = null;
    if (corpus && Number.isFinite(corpus.timed_transcript_episodes)) timed = corpus.timed_transcript_episodes;
    else if (swept && Number.isFinite(swept.episodes_with_timed_transcript)) timed = swept.episodes_with_timed_transcript;
    const curated = curatedOf(show);
    const row = {
      apple_collection_id: show.apple_collection_id ?? null,
      title: show.title ?? null,
      feed_url: show.feed_url ?? null,
      in_curated: curated !== null,
      curated_show_id: curated?.show_id ?? null,
      chart_rank: show.chart_rank ?? null,
      english: englishOf(corpus),
      timed_transcript_episodes: timed,
      dai_prior: typeof entry?.dai === "boolean" ? entry.dai : null,
      dai_measured: entry?.ad_inflation?.verdict ?? null,
      score: 0,
    };
    row.score = scoreOf(row);
    rows.push(row);
  }
  return rows.sort(compareWaveRows);
}

function cell(value) {
  if (value === null || value === undefined) return "—";
  return String(value).replace(/\|/g, "\\|");
}

function priorLabel(prior) {
  if (prior === null || prior === undefined) return "?";
  return prior ? "DAI" : "no DAI";
}

function yesNo(value) {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "?";
}

/** The committed report. Deterministic: every date comes from an input. */
export function renderReport(rows, meta = {}) {
  const curated = rows.filter((r) => r.in_curated);
  const candidates = rows.filter((r) => !r.in_curated);
  const count = (list, pred) => list.filter(pred).length;
  const top = candidates.slice(0, REPORT_TOP);
  const lines = [];
  lines.push("# Drinks-wave candidates (#279), 2026-09");
  lines.push("");
  lines.push(
    "Generated by `node tools/foraycorpus-export/wave-candidates.mjs` (PKG-35, `docs/roadmap/corpus.md` §3). " +
      "Do not hand-edit: re-run the CLI. This is a candidate list. It labels shows and changes nothing; " +
      "PKG-36 applies the wave to `data/catalog.json` and re-scores the alcohol spine.",
  );
  lines.push("");
  lines.push("## Inputs");
  lines.push("");
  lines.push(`- \`data/catalog-breadth.json\` built ${cell(meta.breadth_built_at)}, ${cell(meta.breadth_shows)} shows. Its \`in_curated\` flag is not used (stale, see below).`);
  lines.push(`- \`data/catalog.json\`, ${cell(meta.catalog_shows)} curated shows. \`in_curated\` is matched on normalised feed URL or Apple collection id.`);
  lines.push(`- \`data/dai-classification.json\` built ${cell(meta.dai_built_at)}, ${cell(meta.dai_shows)} shows (the curated catalogue only), so most breadth rows have \`dai_prior\` unknown.`);
  lines.push(`- \`data/breadth-transcript-yield.json\` generated ${cell(meta.yields_generated_at)}, ${cell(meta.yields_shows)} swept breadth shows.`);
  lines.push(
    meta.shows_path
      ? `- Corpus shows.jsonl: \`${meta.shows_path}\`, ${cell(meta.shows_rows)} rows.`
      : "- Corpus shows.jsonl: none supplied, so `english` is unknown (`?`) on every row. It is never assumed true.",
  );
  lines.push(`- Filter: \`DRINKS_RE\` over ${DRINK_WORDS.length} words, whole words only (\`gin\` does not match \"Imagine\").`);
  lines.push("");
  lines.push("## Counts");
  lines.push("");
  lines.push("| | shows |");
  lines.push("|---|---|");
  lines.push(`| breadth titles matched | ${rows.length} |`);
  lines.push(`| already curated (in \`data/catalog.json\`) | ${curated.length} |`);
  lines.push(`| candidates (not curated) | ${candidates.length} |`);
  lines.push(`| candidates known English | ${count(candidates, (r) => r.english === true)} |`);
  lines.push(`| candidates language unknown | ${count(candidates, (r) => r.english === null)} |`);
  lines.push(`| candidates non-DAI (\`dai_prior\` false) | ${count(candidates, (r) => r.dai_prior === false)} |`);
  lines.push(`| candidates DAI (\`dai_prior\` true) | ${count(candidates, (r) => r.dai_prior === true)} |`);
  lines.push(`| candidates DAI unknown | ${count(candidates, (r) => r.dai_prior === null)} |`);
  lines.push(`| candidates with timed transcripts (swept) | ${count(candidates, (r) => (r.timed_transcript_episodes ?? 0) > 0)} |`);
  lines.push("");
  lines.push("## Already curated");
  lines.push("");
  lines.push(
    "PR #289 curated the seven shows #278 named and #279's 2026-08-19 comment scoped the wave to. " +
      "Breadth still says `in_curated: false` for them because that flag was written at harvest. " +
      "They are reported here as ALREADY CURATED, not as candidates. A matched show curated before " +
      "PR #289 is marked \"earlier\".",
  );
  lines.push("");
  const by289 = new Set(PR_289_SHOW_IDS);
  const seen = new Set(curated.map((r) => r.curated_show_id));
  lines.push("| show | catalog show_id | curated by | Apple id | DAI prior | DAI measured | timed eps |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of curated) {
    const by = by289.has(r.curated_show_id) ? "PR #289" : "earlier";
    lines.push(`| ${cell(r.title)} | \`${cell(r.curated_show_id)}\` | ${by} | ${cell(r.apple_collection_id)} | ${priorLabel(r.dai_prior)} | ${cell(r.dai_measured)} | ${cell(r.timed_transcript_episodes)} |`);
  }
  const missing = PR_289_SHOW_IDS.filter((id) => !seen.has(id));
  if (missing.length) {
    lines.push("");
    lines.push(`Not matched by the filter or absent from breadth: ${missing.map((id) => `\`${id}\``).join(", ")}.`);
  }
  lines.push("");
  lines.push("## Budget headroom (stale)");
  lines.push("");
  lines.push(
    "#279's 2026-08-19 comment measured the mobile `discover.json` slice at 681.3 KB for 213 shows " +
      "(3.20 KB a show) against an 800 KB budget: about 37 shows of headroom. That figure predates PR #289's " +
      "seven, so on that arithmetic about 30 are left. It is a dated, stale figure, not a fresh measurement. " +
      "Re-measure the slice (rebuild `mobile/www/` first; a stale copy misleads) before PKG-36 picks more than a handful.",
  );
  lines.push("");
  lines.push(
    "#279's rule applies: **label, never exclude.** Shows come in labelled, and nothing already curated goes out " +
      "to make room. The issue also asks for English only, so a `?` in the English column must be resolved before a show is added.",
  );
  lines.push("");
  lines.push(`## Candidates (top ${Math.min(REPORT_TOP, candidates.length)} of ${candidates.length})`);
  lines.push("");
  lines.push(
    "Sorted DAI prior false, then unknown, then true; then timed-transcript episodes descending (unswept last); then title. " +
      "The word list is broad on purpose (`spirits` and `sake` catch ghost and idiom titles), so read each title before picking.",
  );
  if (candidates.length && candidates.every((r) => r.dai_prior === null)) {
    lines.push("");
    lines.push(
      "No candidate has a DAI prior: `data/dai-classification.json` covers only the curated catalogue, so within this " +
        "list the order is in effect timed episodes, then title. A DAI read on the picks is part of PKG-36's evidence.",
    );
  }
  lines.push("");
  lines.push("| # | show | Apple id | chart rank | English | timed eps | DAI prior | DAI measured |");
  lines.push("|---|---|---|---|---|---|---|---|");
  top.forEach((r, i) => {
    lines.push(`| ${i + 1} | ${cell(r.title)} | ${cell(r.apple_collection_id)} | ${cell(r.chart_rank)} | ${yesNo(r.english)} | ${cell(r.timed_transcript_episodes)} | ${priorLabel(r.dai_prior)} | ${cell(r.dai_measured)} |`);
  });
  lines.push("");
  return lines.join("\n");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { shows: { type: "string" }, out: { type: "string" }, md: { type: "string" } },
    strict: true,
  });
  const breadth = readJson(join(ROOT, "data", "catalog-breadth.json"));
  const yields = readJson(join(ROOT, "data", "breadth-transcript-yield.json"));
  const dai = readJson(join(ROOT, "data", "dai-classification.json"));
  const catalog = readJson(join(ROOT, "data", "catalog.json"));
  const showsPath = values.shows ?? null;
  if (showsPath && !existsSync(showsPath)) throw new Error(`--shows not found: ${showsPath}`);
  const shows = showsPath ? readShowsJsonl(showsPath) : null;

  const rows = buildWave({ breadth, yields, dai, shows, catalog });
  const meta = {
    breadth_built_at: breadth.built_at ?? null,
    breadth_shows: rowsOf(breadth).length,
    catalog_shows: rowsOf(catalog).length,
    dai_built_at: dai.built_at ?? null,
    dai_shows: Object.keys(dai.shows ?? {}).length,
    yields_generated_at: yields.generated_at ?? null,
    yields_shows: rowsOf(yields).length,
    shows_path: showsPath ? relative(ROOT, showsPath).replace(/\\/g, "/") : null,
    shows_rows: shows ? shows.length : null,
  };

  const out = values.out ?? DEFAULT_OUT;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ version: 1, inputs: meta, rows }, null, 2) + "\n");
  const md = values.md ?? DEFAULT_MD;
  writeFileSync(md, renderReport(rows, meta));
  console.log(JSON.stringify({ matched: rows.length, curated: rows.filter((r) => r.in_curated).length, out, md }, null, 2));
}

if (isEntryScript(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error("FATAL:", e?.message ?? e);
    process.exit(1);
  }
}
