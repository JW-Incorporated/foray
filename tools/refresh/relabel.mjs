/* Validated per-episode relabel of committed `data/discover.json` items
   (PKG-06; #547, #560 §6.3).

   `merge.mjs` is the only place a per-episode `topics` override is applied, and
   it only ever sees tonight's episodes. An item already in the pool that wears
   its broad show's inherited label (`topics_source: "show"`) had no way to be
   corrected except a hand edit of a 2,000-item file — which skips the
   validation `merge.mjs` runs and forgets to restamp `topics_source`. This is
   that hand edit, done with the same guard: every override goes through
   `episodeTopics` (topics.mjs), so an unknown taxonomy id, an empty list or a
   six-id list is refused exactly as the nightly would refuse it, and a
   relabelled item is stamped `topics_source: "episode"` because a person has
   now judged that episode.

   ALL OR NOTHING. Every id is looked up and every override validated BEFORE any
   item is touched, and the file is written once at the end. A batch with one
   missing id or one bad topic writes nothing, so a failed run never leaves the
   pool half-relabelled.

   Usage:
     node tools/refresh/relabel.mjs --id <episode id> --topics a/b,c/d [--dry-run]
     node tools/refresh/relabel.mjs --from <batch.json> [--dry-run]
         batch.json: [{ "id": "<episode id>", "topics": ["a/b", ...] }, ...]

   Prints one `id: [old] -> [new]` line per entry. `--dry-run` prints only.

   Inputs (override paths via env, same idiom as merge.mjs):
     RELABEL_DISCOVER_PATH  (default data/discover.json)  read and written
     data/taxonomy.json                                   read only         */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { episodeTopics } from "./topics.mjs";

const root = new URL("../../", import.meta.url);
const p = (rel) => new URL(rel, root);
const envPath = (name, def) => (process.env[name] ? resolvePath(process.cwd(), process.env[name]) : p(def));

const USAGE =
  "usage: node tools/refresh/relabel.mjs --id <episode id> --topics a/b,c/d [--dry-run]\n" +
  "       node tools/refresh/relabel.mjs --from <batch.json> [--dry-run]";

export class RelabelError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Looks up every entry and validates every override, touching nothing.
    Throws RelabelError (missing ids, then entries with no `topics`, ALL
    named in each case) or TopicError (from
    episodeTopics) before returning; on success returns one
    `{ item, id, old, next }` per entry for applyRelabel to write. */
export function planRelabel(items, entries, nodeIds) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const missing = entries.filter((e) => !byId.has(e?.id)).map((e) => JSON.stringify(e?.id));
  if (missing.length) {
    throw new RelabelError("MISSING_IDS", `not in discover.json: ${missing.join(", ")} — nothing written`);
  }
  /* NO TOPICS IS NOT "KEEP THE SHOW'S". episodeTopics reads an absent or null
     override as "no override" and hands back the show seed, which is right for
     merge.mjs; here applyRelabel would then stamp that inherited label
     `topics_source: "episode"`, claiming a judgement nobody made. A dropped or
     misspelled `topics` key in a hand-written batch must fail the whole batch.
     A present-but-wrong value (a string, an empty list) still goes to
     episodeTopics, whose refusal is the nightly's own. */
  const noTopics = entries.filter((e) => e.topics === undefined || e.topics === null).map((e) => JSON.stringify(e.id));
  if (noTopics.length) {
    throw new RelabelError("TOPICS_MISSING", `no topics given for: ${noTopics.join(", ")} — nothing written`);
  }
  return entries.map((e) => {
    const item = byId.get(e.id);
    /* The wrap, not a copy: episodeTopics is the nightly's own validator, so a
       relabel can never accept a label the nightly would refuse. */
    const next = episodeTopics({ showTopics: item.topics, editTopics: e.topics, nodeIds, id: e.id });
    return { item, id: e.id, old: [...(item.topics || [])], next };
  });
}

/** Writes a validated plan onto its items, in place. */
export function applyRelabel(plan) {
  for (const { item, next } of plan) {
    item.topics = next;
    item.topics_source = "episode";
  }
}

const fmt = ({ id, old, next }) => `${id}: [${old.join(", ")}] -> [${next.join(", ")}]`;

function parseArgs(argv) {
  const opts = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--id" || a === "--topics" || a === "--from") opts[a.slice(2)] = argv[++i];
    else throw new RelabelError("USAGE", `unknown argument ${JSON.stringify(a)}\n${USAGE}`);
  }
  if (opts.from !== undefined) {
    if (opts.id !== undefined || opts.topics !== undefined) {
      throw new RelabelError("USAGE", `--from cannot be combined with --id/--topics\n${USAGE}`);
    }
    const entries = JSON.parse(readFileSync(resolvePath(process.cwd(), opts.from), "utf8"));
    if (!Array.isArray(entries)) throw new RelabelError("USAGE", `${opts.from}: expected a JSON array of { id, topics }`);
    return { dryRun: opts.dryRun, entries };
  }
  if (!opts.id || opts.topics === undefined) throw new RelabelError("USAGE", USAGE);
  const topics = opts.topics.split(",").map((t) => t.trim()).filter(Boolean);
  return { dryRun: opts.dryRun, entries: [{ id: opts.id, topics }] };
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`relabel: ${e.message}`);
    process.exit(2);
  }
  const discoverPath = envPath("RELABEL_DISCOVER_PATH", "data/discover.json");
  const discover = JSON.parse(readFileSync(discoverPath, "utf8"));
  const nodeIds = new Set(JSON.parse(readFileSync(p("data/taxonomy.json"), "utf8")).nodes.map((n) => n.id));
  let plan;
  try {
    plan = planRelabel(discover.items, args.entries, nodeIds);
  } catch (e) {
    console.error(`relabel: ${e.message}`);
    process.exit(1);
  }
  for (const row of plan) console.log(fmt(row));
  if (args.dryRun) return;
  applyRelabel(plan);
  writeFileSync(discoverPath, JSON.stringify(discover, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
