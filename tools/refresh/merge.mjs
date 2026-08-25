/* Nightly merge — STATIC machinery (committed, tested, never regenerated).
   Reads the resolved digest + an agent-authored edits file, enforces the copy
   rules the CI gate checks, and appends into data/discover.json +
   data/item-tags.json.

   This replaces the old data-local/merge-*.mjs pattern, where each night's
   hooks/tags were hardcoded as an EDIT={...} object baked into a fresh copy of
   the script. Here the machinery is static and the per-night content lives in a
   plain JSON data file (edits.json) — so this script is versioned once and the
   agent (local or Claude Cloud) only ever produces data, never code.

   Inputs (override paths via env):
     RESOLVED_PATH  resolved digest from resolve.mjs   (default data-local/resolved.json)
     EDITS_PATH     agent-authored { id: {hook, tags} } (default data-local/edits.json)
   Writes data/discover.json + data/item-tags.json in place.

   Contract for edits.json:
     { "<item-id>": { "hook": "<=16 words", "tags": ["5-12","lowercase-hyphenated"],
                      "topics": ["<taxonomy node id>", ...]   // OPTIONAL, see below
                    }, ... }
   Resolved items with no matching edit are SKIPPED and reported (the agent may
   deliberately omit a cross-promo/trailer it caught). Items already present in
   discover.json are skipped (idempotent — safe to re-run).

   `topics` IS OPTIONAL AND IS THE ONLY PER-EPISODE TOPIC SEAM IN THE PIPELINE
   (#292). Omit it and the episode keeps the show-level label `scan.mjs` /
   `backfill-show.mjs` seeded from `catalog.json`'s `taxonomy_node_ids` — correct
   for a single-subject show, and the default that must stay cheap to express.
   Supply it and it replaces that label outright, for a show that ranges. It is
   applied HERE, at the one point both the nightly and the backfill converge, so
   the two pipelines cannot disagree about it. Rules and rationale live in
   `tools/refresh/topics.mjs`.                                                  */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import copyRules from "../../backend/src/copy/rules.js";
import { episodeTopics } from "./topics.mjs";

const root = new URL("../../", import.meta.url);
const p = (rel) => new URL(rel, root);
// If the env override is set, resolve it as a filesystem path relative to cwd
// (works on Windows + POSIX). Otherwise fall back to the repo-relative default.
const envPath = (name, def) => (process.env[name] ? resolvePath(process.cwd(), process.env[name]) : p(def));

const RESOLVED_PATH = envPath("RESOLVED_PATH", "data-local/resolved.json");
const EDITS_PATH = envPath("EDITS_PATH", "data-local/edits.json");
/* The two OUTPUT files are overridable for the same reason the inputs are: this
   script had no test at all before #292, because the only way to run it was to
   let it write the real catalogue. Defaults are unchanged, so the nightly and the
   README recipe are untouched. */
const MERGE_DISCOVER_PATH = envPath("MERGE_DISCOVER_PATH", "data/discover.json");
const MERGE_TAGS_PATH = envPath("MERGE_TAGS_PATH", "data/item-tags.json");

const { resolved } = JSON.parse(readFileSync(RESOLVED_PATH, "utf8"));
const edits = JSON.parse(readFileSync(EDITS_PATH, "utf8"));
const discover = JSON.parse(readFileSync(MERGE_DISCOVER_PATH, "utf8"));
const tagsDoc = JSON.parse(readFileSync(MERGE_TAGS_PATH, "utf8"));
const nodeIds = new Set(JSON.parse(readFileSync(p("data/taxonomy.json"), "utf8")).nodes.map((n) => n.id));

// DAI status is a per-SHOW property (issue #22), so a new episode inherits its
// show's existing verdict for free — no network call in the nightly path. A
// show we have never classified yields false, and `classify-dai.mjs` picks it
// up on its next run. Missing file is not an error: this is additive metadata,
// and a nightly must not fail because a classification cache is absent.
let daiByShow = {};
try {
  daiByShow = JSON.parse(readFileSync(p("data/dai-classification.json"), "utf8")).shows || {};
} catch (_) { /* not classified yet */ }
const daiFor = (cid) => Boolean(daiByShow[cid]?.dai);

// --- Copy-rule preflight — mirrors backend test/copyRules.test.ts (the CI gate).
// We check here too so a bad hook fails fast, before touching the data files,
// rather than reddening CI after a commit. BANNED/wc come from
// backend/src/copy/rules.js — the shared source of truth (2026-07-24; see
// docs/DECISIONS.md) so this list and the CI gate's list can never drift.
const { BANNED, wordCount: wc } = copyRules;

const copyErrors = [];
for (const [id, e] of Object.entries(edits)) {
  if (!e || typeof e.hook !== "string") { copyErrors.push(`${id}: missing hook`); continue; }
  if (wc(e.hook) > 16) copyErrors.push(`${id}: hook ${wc(e.hook)}w > 16`);
  for (const rx of BANNED) if (rx.test(e.hook)) copyErrors.push(`${id}: banned ${rx} in hook`);
  if (!Array.isArray(e.tags) || e.tags.length < 5 || e.tags.length > 12)
    copyErrors.push(`${id}: ${e.tags?.length} tags (need 5-12)`);
  for (const t of e.tags || [])
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(t)) copyErrors.push(`${id}: bad tag "${t}"`);
  /* Topic overrides are validated in the SAME preflight as the copy rules, and
     for the same reason: this loop runs before a single byte is written, so a bad
     override aborts the run instead of half-writing the catalogue. It must never
     become a filter — see topics.mjs on why a dropped bad id restores the very
     defect #292 is about. */
  if (e.topics !== undefined) {
    try {
      episodeTopics({ showTopics: [], editTopics: e.topics, nodeIds, id });
    } catch (err) {
      copyErrors.push(err.message);
    }
  }
}
if (copyErrors.length) {
  console.error("COPY RULE FAILURES:\n" + copyErrors.join("\n"));
  process.exit(1);
}

const now = new Date().toISOString();
const existingIds = new Set(discover.items.map((i) => i.id));

let added = 0;
const shows = [];
const skippedNoEdit = [];
const skippedPresent = [];

for (const ep of resolved) {
  const edit = edits[ep.id];
  if (!edit) { skippedNoEdit.push(`${ep.show} :: ${ep.title} (${ep.id})`); continue; }
  if (existingIds.has(ep.id)) { skippedPresent.push(ep.id); continue; }
  const item = {
    id: ep.id,
    show: ep.show,
    title: ep.title,
    apple_collection_id: ep.apple_collection_id,
    apple_track_id: ep.apple_track_id,
    apple_episode_url: ep.apple_episode_url,
    release_date: ep.release_date,
    duration_min: ep.duration_min,
    // Audio provenance (issue #21). Nullable by design: an item with no
    // playable URL still belongs in discovery, it just links out to Apple
    // Podcasts instead of playing in-app (see the note on issue #25).
    duration_sec: ep.duration_sec ?? null,
    audio_url: ep.audio_url ?? null,
    audio_type: ep.audio_type ?? null,
    audio_bytes: ep.audio_bytes ?? null,
    ...(ep.audio_url ? { dai_suspected: daiFor(ep.apple_collection_id) } : {}),
    artwork_url: ep.artwork_url,
    /* The show-level seed unless the agent judged this episode differently
       (#292). Already validated in the preflight above; this call is the one that
       chooses. */
    topics: episodeTopics({ showTopics: ep.topics, editTopics: edit.topics, nodeIds, id: ep.id }),
    hook: edit.hook,
    explicit: ep.explicit,
  };
  discover.items.push(item);
  tagsDoc.tags[ep.id] = edit.tags;
  existingIds.add(ep.id);
  shows.push(ep.show);
  added++;
}

if (added === 0) {
  console.log("MERGE: 0 items added (nothing to merge).");
  if (skippedNoEdit.length) console.log(`  ${skippedNoEdit.length} resolved item(s) had no edit and were skipped.`);
  process.exit(0);
}

discover.built_at = now;
tagsDoc.built_at = now;
writeFileSync(MERGE_DISCOVER_PATH, JSON.stringify(discover, null, 2) + "\n");
writeFileSync(MERGE_TAGS_PATH, JSON.stringify(tagsDoc, null, 2) + "\n");

const uniqShows = [...new Set(shows)];
console.log(`ADDED ${added} items. built_at=${now}`);
console.log(`SHOWS: ${uniqShows.join(", ")}`);
if (skippedNoEdit.length) console.log(`SKIPPED (no edit authored): ${skippedNoEdit.length}\n  ${skippedNoEdit.join("\n  ")}`);
if (skippedPresent.length) console.log(`SKIPPED (already present): ${skippedPresent.length}`);
