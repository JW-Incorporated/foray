/* RSS <item> reading for the tools/ scripts: ONE text() helper, ONE XMLParser
   configuration and ONE item -> fresh-pending record (code-health-2 CH2-29,
   T1-06).

   Before this file the `text` helper was copied into scan.mjs, backfill-show.mjs,
   backfill-audio.mjs and harvest-episodes.mjs, the XMLParser options into those
   four and classify/prepare-batch.mjs, and scan.mjs and backfill-show.mjs each
   built the fresh-pending record field for field by hand. resolve.mjs reads that
   record; a field added to one copy and not the other would have read
   `undefined` for every backfilled episode of a newly curated show.

   Used by: refresh/scan.mjs, refresh/backfill-show.mjs, refresh/backfill-audio.mjs,
   harvest-episodes.mjs, classify/prepare-batch.mjs.

   fast-xml-parser IS RESOLVED LAZILY, inside feedParser(), out of
   backend/node_modules. CI's data-and-site job never installs backend/'s
   dependencies and runs the suites of every importer above, so merely importing
   this module must never need the parser. */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { audioFieldsFrom, durationMinutes } from "./enclosure.mjs";
import { decodeEntities } from "./entities.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** An element's text: fast-xml-parser yields a string (or number) for a bare
    element and `{ "#text": …, "@_attr": … }` once it carries attributes. */
export const text = (v) => (v == null ? null : typeof v === "object" ? (v["#text"] ?? null) : String(v));

/** A new XMLParser with the one configuration every RSS reader in tools/ uses
    (attributes kept, under an `@_` prefix; values trimmed). */
export function feedParser() {
  const { XMLParser } = createRequire(join(ROOT, "backend", "package.json"))("fast-xml-parser");
  return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: true });
}

/** An <item>'s guid, title and publish Date: what scan.mjs checks against its
    seen-guid state, window and known titles BEFORE it builds a record, and what
    the record itself carries. Any of the three may be null. */
export function itemIdentity(it) {
  /* `text()` already unwraps the `{ "#text": … }` form fast-xml-parser produces for
     `<guid isPermaLink="false">`, so there is no ternary here (T1-18: scan.mjs and
     harvest-episodes.mjs carried a dead one; a mutation test on it came back green).
     No guid -> the enclosure URL stands in. */
  const guid = text(it.guid) || text(it.enclosure?.["@_url"]);
  /* Entities decoded HERE, where the title enters data/ ("Vibe Coding &#038; Linux"
     rendered literally — visual pass 1 review, 2026-09-23; tools/refresh/entities.mjs). */
  const title = decodeEntities(text(it.title));
  let pub = null;
  try { const d = new Date(it.pubDate); pub = isNaN(d) ? null : d; } catch (_) { /* unparseable */ }
  return { guid, title, pub };
}

/** One RSS <item> -> one fresh-pending.json record: the shape resolve.mjs reads,
    pushed by the nightly (scan.mjs) and by a show backfill (backfill-show.mjs)
    alike. `topics` comes from the SHOW's taxonomy_node_ids, which is how a
    curated show labels its episodes.

    Returns `{ record, reason }`: `record` is null (and `reason` says why) when
    the item has no guid, no title or no parseable pubDate; otherwise `reason` is
    the enclosure's withheld reason, if any. */
export function itemToPendingRecord(show, it) {
  const { guid, title, pub } = itemIdentity(it);
  if (!guid || !title || !pub) {
    return { record: null, reason: !guid ? "no guid" : !title ? "no title" : "unparseable pubDate" };
  }
  const desc = String(text(it.description) || text(it["itunes:summary"]) || "")
    .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
  // Audio provenance (issue #21): the enclosure is the authoritative playable URL.
  const audio = audioFieldsFrom(it);
  return {
    record: {
      show: show.title,
      show_id: show.show_id || null,
      apple_collection_id: show.apple_collection_id,
      artwork_url: show.artwork_url || null,
      topics: show.taxonomy_node_ids || [],
      guid, title,
      release_date: pub.toISOString().slice(0, 10),
      duration_min: durationMinutes(it["itunes:duration"]),   // one parser (arch-drift-5)
      duration_sec: audio.duration_sec,
      audio_url: audio.audio_url,
      audio_type: audio.audio_type,
      audio_bytes: audio.audio_bytes,
      description: desc,
      explicit_hint: /yes|true|explicit/i.test(String(text(it["itunes:explicit"]) || "")),
    },
    reason: audio.reason,
  };
}
