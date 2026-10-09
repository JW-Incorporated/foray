#!/usr/bin/env node
/* One-shot artwork backfill for curated shows (#560 item 10). Not nightly.

   WHY. 53 of the 220 curated rows in `data/catalog.json` carried
   `artwork_url: null`, so their tiles rendered blank. Every one of them has an
   `apple_collection_id`, and the keyless iTunes Lookup API returns
   `artworkUrl600` for that id. This script fills ONLY the null `artwork_url`
   fields from it, mapped exactly as `tools/harvest-catalog.mjs` maps it
   (`artwork_url: r.artworkUrl600 ?? null`).

   WHAT IT WILL NOT DO.
   - It never overwrites a non-null `artwork_url` (curated art stays curated).
   - It never touches any other field, and it never re-serialises the file: the
     edit is a literal `"artwork_url": null` -> `"artwork_url": "<url>"` splice
     inside the one show block that owns the matching `apple_collection_id`.
     It then parses old and new and refuses to write unless the ONLY differences
     are those `artwork_url` fields.
   - It does not rebuild `data/catalog-client.json`; run
     `node tools/build-catalog-client.mjs` afterwards.

   TRAFFIC. One `lookup` request per 150 ids (so one request for today's 53),
   through `tools/harvest-merge.mjs`'s `politeFetchJson` — the one policy for
   Apple's iTunes endpoints: >= 3 s before every request, the repo's polite
   User-Agent, 429/5xx/network errors retried with backoff, any other 4xx fatal.

   Usage:
     node tools/refresh/backfill-artwork.mjs            # fetch + write
     node tools/refresh/backfill-artwork.mjs --dry-run  # fetch + report only */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { politeFetchJson } from "../harvest-merge.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CATALOG = join(ROOT, "data", "catalog.json");
const BATCH = 150;
const DRY = process.argv.includes("--dry-run");

/** The harvest mapping (tools/harvest-catalog.mjs): artworkUrl600, else null. */
export function artworkFromLookup(result) {
  if (!result || result.kind !== "podcast" || !result.collectionId) return null;
  return typeof result.artworkUrl600 === "string" && result.artworkUrl600.startsWith("https://")
    ? result.artworkUrl600
    : null;
}

/** Splice `"artwork_url": null` -> url inside the block owning `id`. Returns new text or null. */
export function spliceArtwork(text, id, url) {
  const anchor = `"apple_collection_id": ${id},`;
  const at = text.indexOf(anchor);
  if (at < 0 || text.indexOf(anchor, at + anchor.length) >= 0) return null; // missing or ambiguous
  const blockEnd = text.indexOf('"show_id":', at);
  const end = blockEnd < 0 ? text.length : blockEnd;
  const needle = '"artwork_url": null';
  const hit = text.indexOf(needle, at);
  if (hit < 0 || hit > end) return null;
  return text.slice(0, hit) + `"artwork_url": ${JSON.stringify(url)}` + text.slice(hit + needle.length);
}

/** One `lookup` request for `ids`; `fetchJson` is injected for tests. */
export async function lookup(ids, fetchJson = politeFetchJson()) {
  const data = await fetchJson(`https://itunes.apple.com/lookup?id=${ids.join(",")}&entity=podcast`);
  return data.results || [];
}

async function main() {
  const before = readFileSync(CATALOG, "utf8");
  const catalog = JSON.parse(before);
  const missing = catalog.shows.filter((s) => s.artwork_url == null && s.apple_collection_id);
  console.log(`${missing.length} curated shows with null artwork_url`);
  if (!missing.length) return;

  const found = new Map();
  const ids = missing.map((s) => s.apple_collection_id);
  const fetchJson = politeFetchJson();
  for (let i = 0; i < ids.length; i += BATCH) {
    for (const r of await lookup(ids.slice(i, i + BATCH), fetchJson)) {
      const art = artworkFromLookup(r);
      if (art) found.set(r.collectionId, art);
    }
  }

  let text = before;
  const fixed = [];
  const unresolved = [];
  for (const s of missing) {
    const art = found.get(s.apple_collection_id);
    const next = art ? spliceArtwork(text, s.apple_collection_id, art) : null;
    if (next) { text = next; fixed.push(s); } else unresolved.push(s);
  }

  // Guard: the only permitted differences are the artwork_url fields we filled.
  const after = JSON.parse(text);
  const fixedIds = new Set(fixed.map((s) => s.apple_collection_id));
  const strip = (c) => JSON.stringify({ ...c, shows: c.shows.map((s) => (fixedIds.has(s.apple_collection_id) ? { ...s, artwork_url: null } : s)) });
  if (strip(after) !== strip(catalog)) throw new Error("refusing to write: diff touches more than artwork_url");
  if (JSON.stringify(after, null, 2) + "\n" !== text) throw new Error("refusing to write: formatting drifted");

  console.log(`fixed ${fixed.length}, unresolved ${unresolved.length}`);
  for (const s of unresolved) console.log(`  unresolved: ${s.apple_collection_id} ${s.title}`);
  if (DRY) { console.log("--dry-run: not writing"); return; }
  writeFileSync(CATALOG, text);
  console.log("wrote data/catalog.json; now run: node tools/build-catalog-client.mjs");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
