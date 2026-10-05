#!/usr/bin/env node
/* Breadth-shaped catalogue from the corpus (PKG-31, G-15;
   docs/roadmap/corpus.md §3 "PKG-31 · catalog-adapter.mjs").

   Turns the export's shows rows (catalogue.mjs buildShows) into rows with the
   shape of data/catalog-breadth.json, the file backend/src/catalog/
   breadthCatalog.ts and api/shows/search read, plus a diff against that old
   harvest. The output goes to data-local/corpus-export/
   catalog-breadth-corpus.json. This module never writes data/: the CLI
   refuses an --out under data/, and swapping the served file is PKG-32/33's
   pointer, not this module's job.

   Filter, in order. Each skipped row is counted once, under the first rule
   it fails:
   1. `itunes_id` present (a decimal integer, number or string; pg returns
      int8 as a string). The api joins on `apple_collection_id`, so a row
      without one is useless here (`skipped_no_apple_id`).
   2. Both rights flags false (`skipped_rights`). Founder ruling 31,
      docs/roadmap/README.md (corpus Q3): shows with `itunes:block` or
      `podcast:locked` are excluded from the app catalogue.
   3. `language` starting `en` (any case) or null/blank (`skipped_language`).
   4. One row per apple id; the first, in buildShows' corpus_podcast_id
      order, wins (`skipped_duplicate_apple_id`).

   Row shape. These are the 18 keys of a data/catalog-breadth.json row, in
   its order. The plan lists 17. The 18th, `taxonomy_node_ids`, was added by
   tools/refresh/fold-breadth-topics.mjs and is read by breadthCatalog.ts,
   so it is copied from the old breadth row with the same
   apple_collection_id, else []. After them come two additive fields,
   `timed_transcript_episodes` and `audio_episodes`.
   `chart_genre_id` / `chart_genre_name` / `chart_rank` are copied from the old
   row too, else null. The roadmap's G-15 card keeps chart_rank as a prior
   from the old harvest: the corpus has no charts.
   `apple_collection_id` is a number, as in the old file.
   `in_curated` is true only when `foray_show_id` is a data/catalog.json
   show_id. buildShows falls back to String(itunes_id) when no catalog feed
   matches, and catalog show_ids are slugs, so that fallback never counts.

   Report: {rows, skipped_no_apple_id, skipped_rights, skipped_language,
   skipped_duplicate_apple_id, new_vs_old, dropped_vs_old,
   feed_url_changed}. The last three compare apple ids with the old file,
   and feed URLs under normalizeFeedUrl (tools/shows/identity.mjs, imported).

   CLI: node tools/foraycorpus-export/catalog-adapter.mjs --shows
   <shows.jsonl> [--breadth data/catalog-breadth.json] [--catalog
   data/catalog.json] [--out <file>] [--harvested-at <iso>] writes the
   envelope minified, like the original ({version, built_at, region, source,
   genre_count, shows}, one line + "\n"), and prints the report. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { normalizeFeedUrl } from "../shows/identity.mjs";
import { EXPORT_OUT_DIR, ROOT } from "./config.mjs";
import { readShowsJsonl } from "./overlap.mjs";

/** data/catalog-breadth.json's 18 row keys, in the file's order. */
export const BREADTH_KEYS = Object.freeze([
  "apple_collection_id",
  "title",
  "feed_url",
  "artwork_url",
  "apple_genre",
  "apple_genre_ids",
  "episode_count",
  "explicit",
  "chart_genre_id",
  "chart_genre_name",
  "chart_rank",
  "in_curated",
  "podcastindex_id",
  "tier",
  "region",
  "harvest_source",
  "harvested_at",
  "taxonomy_node_ids",
]);
export const ADDITIVE_KEYS = Object.freeze(["timed_transcript_episodes", "audio_episodes"]);
export const DEFAULT_OUT = join(EXPORT_OUT_DIR, "catalog-breadth-corpus.json");

export class AdapterError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "AdapterError";
    this.code = code;
  }
}

const rowsOf = (doc) => (Array.isArray(doc) ? doc : Array.isArray(doc?.shows) ? doc.shows : []);

/** A positive decimal integer id as a number, else null. */
function appleIdOf(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

function isEnglishOrUnknown(language) {
  if (language == null || String(language).trim() === "") return true;
  return String(language).trim().toLowerCase().startsWith("en");
}

function capitalise(s) {
  return typeof s === "string" && s !== "" ? s[0].toUpperCase() + s.slice(1) : null;
}

/**
 * @param {object[]} showRows buildShows rows
 * @param {{breadthOld?: object | object[], catalog?: object | object[], harvestedAt?: string}} options
 * @returns {{shows: object[], report: object}}
 */
export function catalogAdapter(showRows, { breadthOld, catalog, harvestedAt = new Date().toISOString() } = {}) {
  const oldById = new Map();
  for (const old of rowsOf(breadthOld)) {
    const id = appleIdOf(old?.apple_collection_id);
    if (id !== null && !oldById.has(id)) oldById.set(id, old);
  }
  const curatedIds = new Set(
    rowsOf(catalog)
      .map((s) => s?.show_id)
      .filter((id) => id != null)
      .map(String),
  );

  const report = {
    rows: 0,
    skipped_no_apple_id: 0,
    skipped_rights: 0,
    skipped_language: 0,
    skipped_duplicate_apple_id: 0,
    new_vs_old: 0,
    dropped_vs_old: 0,
    feed_url_changed: 0,
  };
  const shows = [];
  const emitted = new Set();
  for (const row of showRows ?? []) {
    const id = appleIdOf(row?.itunes_id);
    if (id === null) {
      report.skipped_no_apple_id += 1;
      continue;
    }
    if (row.rights?.itunes_block !== false || row.rights?.podcast_locked !== false) {
      report.skipped_rights += 1;
      continue;
    }
    if (!isEnglishOrUnknown(row.language)) {
      report.skipped_language += 1;
      continue;
    }
    if (emitted.has(id)) {
      report.skipped_duplicate_apple_id += 1;
      continue;
    }
    emitted.add(id);

    const old = oldById.get(id) ?? null;
    if (old === null) report.new_vs_old += 1;
    else if (normalizeFeedUrl(old.feed_url) !== normalizeFeedUrl(row.feed_url)) report.feed_url_changed += 1;

    shows.push({
      apple_collection_id: id,
      title: row.title ?? null,
      feed_url: row.feed_url ?? null,
      artwork_url: row.image_url ?? null,
      apple_genre: row.categories?.[0]?.category ?? capitalise(row.pi_categories?.[0]) ?? null,
      apple_genre_ids: [],
      episode_count: row.episodes_total ?? null,
      explicit: row.explicit ?? null,
      chart_genre_id: old?.chart_genre_id ?? null,
      chart_genre_name: old?.chart_genre_name ?? null,
      chart_rank: old?.chart_rank ?? null,
      in_curated: row.foray_show_id != null && curatedIds.has(String(row.foray_show_id)),
      podcastindex_id: row.podcastindex_feed_id ?? null,
      tier: "breadth",
      region: "us",
      harvest_source: "foraycorpus",
      harvested_at: harvestedAt,
      taxonomy_node_ids: Array.isArray(old?.taxonomy_node_ids) ? [...old.taxonomy_node_ids] : [],
      timed_transcript_episodes: row.timed_transcript_episodes ?? 0,
      audio_episodes: row.audio_episodes ?? 0,
    });
  }
  for (const id of oldById.keys()) if (!emitted.has(id)) report.dropped_vs_old += 1;
  report.rows = shows.length;
  return { shows, report };
}

/** The data/catalog-breadth.json envelope around the adapted rows. */
export function breadthEnvelope(shows, { builtAt }) {
  const genres = new Set(shows.map((s) => s.chart_genre_id).filter((g) => g != null));
  return { version: 1, built_at: builtAt, region: "us", source: "foraycorpus", genre_count: genres.size, shows };
}

/** Throws unless `out` resolves outside ROOT/data/. */
export function assertNotInData(out, root = ROOT) {
  const rel = relative(join(root, "data"), resolve(out));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new AdapterError("REFUSE_DATA", `refusing to write under data/: ${out}`);
  }
}

/** Minified JSON + "\n", tmp + rename. */
export function writeMinified(out, value) {
  assertNotInData(out);
  mkdirSync(dirname(resolve(out)), { recursive: true });
  const tmp = `${resolve(out)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value) + "\n");
  renameSync(tmp, resolve(out));
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      shows: { type: "string" },
      breadth: { type: "string" },
      catalog: { type: "string" },
      out: { type: "string" },
      "harvested-at": { type: "string" },
    },
    strict: true,
  });
  if (!values.shows) {
    throw new AdapterError("USAGE", "node catalog-adapter.mjs --shows <shows.jsonl> [--breadth <file>] [--catalog <file>] [--out <file>] [--harvested-at <iso>]");
  }
  const out = values.out ?? DEFAULT_OUT;
  assertNotInData(out);
  const harvestedAt = values["harvested-at"] ?? new Date().toISOString();
  const breadthOld = JSON.parse(readFileSync(values.breadth ?? join(ROOT, "data", "catalog-breadth.json"), "utf8"));
  const catalog = JSON.parse(readFileSync(values.catalog ?? join(ROOT, "data", "catalog.json"), "utf8"));
  const { shows, report } = catalogAdapter(readShowsJsonl(values.shows), { breadthOld, catalog, harvestedAt });
  writeMinified(out, breadthEnvelope(shows, { builtAt: harvestedAt }));
  console.log(JSON.stringify({ out, ...report }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error("FATAL:", e?.message ?? e);
    process.exit(1);
  }
}
