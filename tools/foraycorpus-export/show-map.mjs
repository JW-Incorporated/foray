/* R2 show directory → foray show_id map (PKG-12, G-11;
   docs/roadmap/corpus.md §3 "PKG-12 · show-map.mjs").

   The transcript farm names each R2 directory after ITS show id, not
   foray's. The farm facts, inlined in the spec because foray-db is not
   readable from here, are:

   (i)   the farm's `_show_id` (transcript-farm/farm/run.py) is
         String(podcastindex_feed_id) when the queue row has one, else
         slugify(title);
   (ii)  `slugify` (transcript-farm/farm/forayfmt.py) is ported below
         exactly: NFKD, drop non-ASCII, lowercase, runs of [^a-z0-9] → "-",
         trim "-", empty → "show";
   (iii) the farm's `safe_key` is a byte-for-byte port of foray's safeKey,
         so an R2 directory is safeKey(<farm show_id>). safeKey comes from
         ./config.mjs (which re-exports tools/segments/fetch-transcripts.mjs)
         and is never copied;
   (iv)  legacy whisper objects at the bucket ROOT
         (`<show-slug>/<title-slug>-<10 hex>.json`) are not foray-layout
         bodies. This module maps directory names only; the sync (PKG-13)
         decides what is a body.

   The inputs are data/transcription-queue.json (the queue the farm
   consumed: top-level `shows[]` rows with title, feed_url,
   podcastindex_feed_id, apple_collection_id), data/catalog.json
   (`shows[].show_id` slugs, `feed_url`) and data/breadth-transcript-yield.json
   (`shows[]` where show_id === String(apple_collection_id), the breadth
   convention). The caller parses them; this module never reads data/.

   Foray's show_id for a queue row is the curated catalog show whose feed URL
   matches under normalizeFeedUrl from tools/shows/identity.mjs (imported,
   as catalogue.mjs does), via "catalog-feed"; else String(apple_collection_id),
   via "breadth-apple"; else slugify(title), via "queue-title". Both the farm
   directory and the slug directory map to it. Every catalog show_id and every
   breadth String(apple_collection_id) also maps to itself, under
   safeKey(show_id) and under the raw show_id, via "identity" (the #831
   forward contract: a farm that learns foray's ids writes these names).

   The local directory is safeKey(show_id), the name
   fetch-transcripts.mjs transcriptPath writes. The backend's
   transcriptArchiveLookup.ts showDir (a directory equal to showId or
   starting `${showId}-`) finds it, because safeKey of a slug id is
   `<slug>-<sha1 10>`.

   First writer wins on a key collision. Each dropped mapping is reported. */
import { normalizeFeedUrl } from "../shows/identity.mjs";
import { safeKey } from "./config.mjs";

/** The farm's slugify (forayfmt.py), ported step for step. */
export function slugify(title) {
  const ascii = String(title ?? "")
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "");
  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "show" : slug;
}

const rowsOf = (doc) => (Array.isArray(doc) ? doc : Array.isArray(doc?.shows) ? doc.shows : []);
const present = (v) => v !== null && v !== undefined && String(v).trim() !== "";

/**
 * @param {{queue?: object | object[], catalog?: object | object[], breadth?: object | object[]}} docs
 * @returns {{map: Map<string, {show_id: string, via: string}>, collisions: Array<{dir: string, kept: {show_id, via}, dropped: {show_id, via}}>}}
 */
export function buildShowMap({ queue, catalog, breadth } = {}) {
  const map = new Map();
  const collisions = [];
  const put = (dir, entry) => {
    const kept = map.get(dir);
    if (kept === undefined) {
      map.set(dir, entry);
      return;
    }
    if (kept.show_id !== entry.show_id) collisions.push({ dir, kept, dropped: entry });
  };

  const catalogShows = rowsOf(catalog).filter((s) => present(s?.show_id));
  const catalogByFeed = new Map();
  for (const s of catalogShows) {
    const norm = normalizeFeedUrl(s.feed_url);
    if (norm && !catalogByFeed.has(norm)) catalogByFeed.set(norm, String(s.show_id));
  }

  for (const row of rowsOf(queue)) {
    if (!row || typeof row !== "object") continue;
    const norm = normalizeFeedUrl(row.feed_url);
    let entry;
    if (norm && catalogByFeed.has(norm)) entry = { show_id: catalogByFeed.get(norm), via: "catalog-feed" };
    else if (present(row.apple_collection_id)) entry = { show_id: String(row.apple_collection_id), via: "breadth-apple" };
    else entry = { show_id: slugify(row.title), via: "queue-title" };
    if (present(row.podcastindex_feed_id)) put(safeKey(String(row.podcastindex_feed_id)), entry);
    put(safeKey(slugify(row.title)), entry);
  }

  const identity = (id) => {
    const entry = { show_id: id, via: "identity" };
    put(safeKey(id), entry);
    put(id, entry);
  };
  for (const s of catalogShows) identity(String(s.show_id));
  for (const b of rowsOf(breadth)) {
    if (present(b?.apple_collection_id)) identity(String(b.apple_collection_id));
  }

  return { map, collisions };
}

/** The foray show for an R2 directory name, or null when unmapped. */
export function resolveShowDir(map, r2Dir) {
  return map.get(r2Dir) ?? null;
}

/** The local directory for a foray show_id (transcriptPath's name). */
export function localDirFor(showId) {
  return safeKey(showId);
}
