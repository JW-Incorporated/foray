/* Which shows carry ONE topic set across every episode — the #292 measurement,
   committed so the next person re-runs it instead of re-deriving it.

     node tools/refresh/topic-uniformity.mjs
     node tools/refresh/topic-uniformity.mjs --min 12
     node tools/refresh/topic-uniformity.mjs --show "Stuff You Should Know"

   IT REPORTS AND EXITS 0. It is not a gate and must not become one. A uniform
   topic set is a DEFECT on a show that ranges and a TRUTH on a show that does
   not, and nothing measurable here separates them — `Engines of Our Ingenuity`
   (38 episodes, `history/technology`) and `Stuff You Should Know` (23 episodes,
   `history/technology` + `science/materials`, covering a Soviet borehole and
   Bonnie and Clyde) are the same row to any counter. Only reading the episodes
   decides. A gate here would therefore either fail on correct data forever or be
   silenced, and both end with nobody reading the list.

   `--show` prints one show's episodes with their topics, which is the view you
   want when deciding whether its uniform label is a truth or a default. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { uniformTopicShows, substantialShows, topicKey } from "./topics.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function main(argv) {
  const arg = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  /* Validated rather than trusted: `--min abc` is NaN, `eps.length < NaN` is
     false, and the report would then call EVERY show uniform — a wrong headline
     that looks like a finding. */
  const min = Number(arg("--min", "8"));
  if (!Number.isInteger(min) || min < 1) {
    console.error(`--min must be a positive integer, got ${JSON.stringify(arg("--min", "8"))}`);
    process.exit(1);
  }
  const only = arg("--show", null);
  const discover = JSON.parse(readFileSync(join(ROOT, "data", "discover.json"), "utf8"));

  if (only) {
    const eps = discover.items.filter((i) => i.show === only);
    if (eps.length === 0) {
      console.error(`no show titled ${JSON.stringify(only)} in data/discover.json`);
      process.exit(1);
    }
    const distinct = new Set(eps.map((e) => topicKey(e.topics)));
    console.log(`${only}: ${eps.length} episodes, ${distinct.size} distinct topic set(s)\n`);
    for (const e of eps) console.log(`  ${(e.topics || []).join(", ").padEnd(52)} ${e.title}`);
    return;
  }

  const uniform = uniformTopicShows(discover.items, { minEpisodes: min });
  const total = substantialShows(discover.items, { minEpisodes: min });
  console.log(`${uniform.length} of ${total} shows with >= ${min} episodes carry ONE topic set on every episode`);
  console.log(`(${discover.items.length} items, ${new Set(discover.items.map((i) => i.show)).size} shows)\n`);
  for (const r of uniform) {
    console.log(`${String(r.episodes).padStart(4)}  ${r.show.padEnd(46)} ${r.topics.join(", ")}`);
  }
  console.log("\nA uniform label is a defect only where the show RANGES. Read before re-tagging.");
}

main(process.argv.slice(2));
