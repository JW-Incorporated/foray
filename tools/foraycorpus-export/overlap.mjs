#!/usr/bin/env node
/* Breadth overlap count for the corpus export (PKG-09, G-10;
   docs/roadmap/corpus.md §3 "PKG-09 · overlap.mjs").

   The corpus brief's freshness section ends "overlap not measured": how many
   of the breadth tier's shows (data/catalog-breadth.json, 19,787 Apple-chart
   rows) the corpus already carries. This answers it from the export's own
   shows.jsonl rows (catalogue.mjs buildShows: `itunes_id`,
   `feed_url_normalized`), in two passes per breadth show:

   1. `apple_collection_id` equals a corpus `itunes_id` (compared as strings,
      because pg returns int8 as a string and the breadth file has numbers).
   2. Otherwise, the breadth `feed_url` normalised with normalizeFeedUrl from
      tools/shows/identity.mjs (imported, never copied, so this is the same
      normalisation catalogue.mjs wrote into `feed_url_normalized`) equals a
      corpus row's `feed_url_normalized`.

   A breadth show counts once: an itunes match is not also a feed match. A
   missing id never matches. A null `apple_collection_id` does not match a
   null `itunes_id`, and an empty feed URL does not match an empty one.

   CLI: `node tools/foraycorpus-export/overlap.mjs --shows <shows.jsonl>
   [--breadth data/catalog-breadth.json]` prints the counts as JSON. The
   module only reads `data/` when that CLI runs. PKG-08 wires `--breadth`
   into export.mjs. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { normalizeFeedUrl } from "../shows/identity.mjs";
import { ROOT } from "./config.mjs";
import { idKey, JsonlError, readJsonl } from "./rows.mjs";

export const DEFAULT_BREADTH_PATH = join(ROOT, "data", "catalog-breadth.json");

export class OverlapError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "OverlapError";
    this.code = code;
    this.detail = detail ?? null;
  }
}

/**
 * @param {Iterable<{itunes_id?: unknown, feed_url_normalized?: string|null}>} showRows shows.jsonl rows
 * @param {{shows: Array<{apple_collection_id?: unknown, feed_url?: string}>} | Array} breadthDoc
 *   data/catalog-breadth.json's parsed object (or its `shows` array)
 * @returns {{breadth_shows: number, matched_by_itunes_id: number, matched_by_feed_url_only: number, unmatched: number}}
 */
export function computeOverlap(showRows, breadthDoc) {
  const breadth = Array.isArray(breadthDoc) ? breadthDoc : breadthDoc?.shows;
  if (!Array.isArray(breadth)) throw new OverlapError("BAD_BREADTH", "expected { shows: [...] } or an array");

  const itunesIds = new Set();
  const feeds = new Set();
  for (const row of showRows ?? []) {
    const id = idKey(row?.itunes_id);
    if (id !== null) itunesIds.add(id);
    const feed = row?.feed_url_normalized;
    if (typeof feed === "string" && feed !== "") feeds.add(feed);
  }

  let byItunes = 0;
  let byFeedOnly = 0;
  for (const show of breadth) {
    if (itunesIds.has(idKey(show?.apple_collection_id))) {
      byItunes += 1;
      continue;
    }
    const feed = normalizeFeedUrl(show?.feed_url);
    if (feed !== "" && feeds.has(feed)) byFeedOnly += 1;
  }
  return {
    breadth_shows: breadth.length,
    matched_by_itunes_id: byItunes,
    matched_by_feed_url_only: byFeedOnly,
    unmatched: breadth.length - byItunes - byFeedOnly,
  };
}

/** Parses a shows.jsonl file (rows.mjs readJsonl: blank lines skipped); a
    malformed line throws OverlapError MALFORMED_ROW naming `<path>:<line>`. */
export function readShowsJsonl(path) {
  try {
    return readJsonl(path);
  } catch (e) {
    if (e instanceof JsonlError) throw new OverlapError(e.code, e.detail);
    throw e;
  }
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { shows: { type: "string" }, breadth: { type: "string" } }, strict: true });
  if (!values.shows) throw new OverlapError("USAGE", "node overlap.mjs --shows <shows.jsonl> [--breadth data/catalog-breadth.json]");
  const breadthDoc = JSON.parse(readFileSync(values.breadth ?? DEFAULT_BREADTH_PATH, "utf8"));
  console.log(JSON.stringify(computeOverlap(readShowsJsonl(values.shows), breadthDoc), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error("FATAL:", e?.message ?? e);
    process.exit(1);
  }
}
