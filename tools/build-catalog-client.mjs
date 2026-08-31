#!/usr/bin/env node
/* Derives data/catalog-client.json from data/catalog.json (docs/show-pages-plan.md
   Stage 1, kanban card "Build: per-show pages Stage 1").

   WHY THIS EXISTS
   data/catalog.json is the backend curation engine's 220-show bench
   (docs/CATALOG-PIPELINE.md) — feed_url, apple_genre, archetype_fit, cadence_hint,
   explicit, source and the rest are all provenance/curation fields the client's new
   #/show/:id page never reads. Measured: the full file is 134,788 B (33,632 B gzip);
   a client build carrying only the six fields renderShow() actually uses is
   83,552 B (25,451 B gzip) — a ~24% gzip saving for zero behaviour change, and it
   keeps feed_url (a legally-relevant field per CLAUDE.md product principle #3) out
   of a public static fetch that has no use for it yet. Re-run whenever
   data/catalog.json changes (nightly refresh, a new show).

   THE FIELD LIST IS THE CONTRACT app.js's renderShow() reads against — a field this
   script does not project will 404 out of the client silently (undefined, not an
   error), so add here and in app.js's renderShow() together.

   Usage: node tools/build-catalog-client.mjs [--out path] [--check] */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const args = process.argv.slice(2);

function parseArgs(argv) {
  const out = { outPath: path.join(ROOT, "data", "catalog-client.json"), check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") { out.outPath = path.resolve(argv[++i] ?? ""); continue; }
    if (a === "--check") { out.check = true; continue; }
    throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

/* The whitelist renderShow() reads. Keep in lockstep with app.js — a field
   dropped here without dropping its reader in app.js renders `undefined`, not
   an error, so test/show-page.test.js pins this list against the source text of
   both files. */
export const CLIENT_SHOW_FIELDS = [
  "show_id", "title", "artwork_url", "editorial_note", "taxonomy_node_ids", "episode_count",
];

export function projectShow(show) {
  const out = {};
  for (const f of CLIENT_SHOW_FIELDS) out[f] = show[f] ?? null;
  return out;
}

export function buildCatalogClient(catalog) {
  if (!catalog || !Array.isArray(catalog.shows)) {
    throw new Error("data/catalog.json did not parse to { shows: [...] } — refusing to write an empty derivation");
  }
  return { version: catalog.version, shows: catalog.shows.map(projectShow) };
}

function main() {
  const { outPath, check } = parseArgs(args);
  const catalog = JSON.parse(readFileSync(path.join(ROOT, "data", "catalog.json"), "utf8"));
  const client = buildCatalogClient(catalog);
  if (!client.shows.length) throw new Error("derived catalog-client.json has zero shows — refusing to write");
  const text = JSON.stringify(client, null, 2) + "\n";

  if (check) {
    const onDisk = readFileSync(outPath, "utf8");
    if (onDisk !== text) {
      console.error(`${path.relative(ROOT, outPath)} is stale — run: node tools/build-catalog-client.mjs`);
      process.exit(1);
    }
    console.log(`${path.relative(ROOT, outPath)} is up to date (${client.shows.length} shows).`);
    return;
  }

  writeFileSync(outPath, text);
  console.log(`wrote ${path.relative(ROOT, outPath)}: ${client.shows.length} shows, ${text.length} B.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
