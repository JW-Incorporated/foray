/* One-shot, idempotent backfill of two keys on every `data/discover.json` item
   (PKG-01; #547, #560 §6.3):

     topics_source  "show"    the item's topics are its show's inherited
                              `taxonomy_node_ids` seed
                    "episode" the topics were judged for this episode
     explicit       always present; `null` = unrated (Family Mode already reads
                    a missing key and `null` the same way, so stamping `null`
                    changes no behaviour — it only makes "unrated" explicit)

   `merge.mjs` writes both keys on every item it adds from now on; this stamps
   the items merged before it did. It never touches an item that already
   carries a key, so a re-run is a no-op and it can never overwrite the
   nightly's own provenance.

   HOW "show" IS INFERRED FOR AN OLD ITEM. There is no record of whether an
   override was authored, so the rule is: the item's topic set equals its
   show's `taxonomy_node_ids` (order-insensitive, `topicKey`) → "show";
   anything else, or no catalogue show with that title → "episode". An
   override that happened to repeat the show's own label reads as "show",
   which is the honest reading: the item carries exactly the inherited label.

   Usage:
     node tools/refresh/backfill-provenance.mjs           # stamp and write back
     node tools/refresh/backfill-provenance.mjs --check   # exit 1 if any item would change

   Inputs (override paths via env, same idiom as merge.mjs):
     BACKFILL_DISCOVER_PATH  (default data/discover.json)  read and written
     BACKFILL_CATALOG_PATH   (default data/catalog.json)   read only        */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { isEntryScript } from "../ci/entry.mjs";
import { topicKey } from "./topics.mjs";

const root = new URL("../../", import.meta.url);
const p = (rel) => new URL(rel, root);
const envPath = (name, def) => (process.env[name] ? resolvePath(process.cwd(), process.env[name]) : p(def));

/** Stamps the missing keys IN PLACE on `items` and returns the counts. Pure
    apart from that mutation, so a test can call it without a file. */
export function stampProvenance(items, shows) {
  const showByTitle = new Map((shows || []).map((s) => [s.title, s]));
  const counts = { stamped_source: 0, stamped_explicit: 0, unchanged: 0 };
  for (const item of items) {
    let changed = false;
    if (!("topics_source" in item)) {
      const show = showByTitle.get(item.show);
      item.topics_source = show && topicKey(item.topics) === topicKey(show.taxonomy_node_ids) ? "show" : "episode";
      counts.stamped_source++;
      changed = true;
    }
    if (!("explicit" in item)) {
      item.explicit = null;
      counts.stamped_explicit++;
      changed = true;
    }
    if (!changed) counts.unchanged++;
  }
  return counts;
}

function main(argv) {
  const check = argv.includes("--check");
  const discoverPath = envPath("BACKFILL_DISCOVER_PATH", "data/discover.json");
  const catalogPath = envPath("BACKFILL_CATALOG_PATH", "data/catalog.json");
  const discover = JSON.parse(readFileSync(discoverPath, "utf8"));
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const counts = stampProvenance(discover.items, catalog.shows);
  console.log(JSON.stringify(counts));
  const wouldChange = counts.stamped_source + counts.stamped_explicit > 0;
  if (check) {
    if (wouldChange) {
      console.error(
        `backfill-provenance --check: ${counts.stamped_source} item(s) lack topics_source and ` +
          `${counts.stamped_explicit} lack an explicit key. Run node tools/refresh/backfill-provenance.mjs.`
      );
      process.exit(1);
    }
    return;
  }
  if (wouldChange) writeFileSync(discoverPath, JSON.stringify(discover, null, 2) + "\n");
}

if (isEntryScript(import.meta.url)) {
  main(process.argv.slice(2));
}
