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
     MERGE_CATALOG_PATH  the curated catalogue, read for each show's label_scope
                         (default data/catalog.json; never written)
   Writes data/discover.json + data/item-tags.json in place, and nothing else.
   (Until issue #701 it also restamped deploy-manifest.json + sw.js's BUILD_ID,
   because both data files are hashed by the deploy stamp and that stamp was
   committed. The stamp is a build output now — tools/web/prepare-dist.mjs and
   .github/workflows/pages.yml write it at deploy time — so the nightly's commit
   is just the data, and there is no manifest step to skip or to fail.)

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
   `tools/refresh/topics.mjs`.

   ONE EXCEPTION: an episode of a show marked `"label_scope": "general"` in
   catalog.json MUST carry its own `topics`, or the run is refused in the
   preflight with TOPICS_REQUIRED_GENERAL (docs/roadmap/README.md item 24).    */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { isEntryScript } from "../ci/entry.mjs";
import copyRules from "../../backend/src/copy/rules.js";
import { episodeTopics, topicSource } from "./topics.mjs";
import { minutesFromSeconds } from "../check-durations.mjs";

const root = new URL("../../", import.meta.url);
const p = (rel) => new URL(rel, root);
// If the env override is set, resolve it as a filesystem path relative to cwd
// (works on Windows + POSIX). Otherwise fall back to the repo-relative default.
const envPath = (name, def) => (process.env[name] ? resolvePath(process.cwd(), process.env[name]) : p(def));

/* THE SUMMARY LINES ARE A CONTRACT, not log text. `nightly-runner.mjs finish`
   reads merge's stdout to tell "nothing to do" (its exit 4, no PR) from "merged
   N" (tests, branch, PR) from MERGE_UNPARSED (exit 5). When the two files only
   agreed by string, a reword here made every nightly exit 5 AFTER a successful
   merge: catalogue written, no PR, the silent night of #290 (CH2-14, T1-22).
   So the lines are built here and parsed here, and the runner imports both.

   `parseAdded(stdout)` is the count merge reported: 0 for the nothing-to-merge
   line (checked first), N for an ADDED line, null when merge said neither. */
export const MERGE_SUMMARY = Object.freeze({
  nothing: "MERGE: 0 items added (nothing to merge).",
  added: (n, now) => `ADDED ${n} items. built_at=${now}`,
  parseAdded(stdout) {
    const lines = String(stdout ?? "").split(/\r?\n/);
    if (lines.includes(MERGE_SUMMARY.nothing)) return 0;
    for (const line of lines) {
      const m = /^ADDED (\d+) items\./.exec(line);
      if (m) return Number(m[1]);
    }
    return null;
  },
});

/* The whole merge, run once. Returns the process exit code: 1 when the
   copy-rule / topics preflight refuses the edits (nothing written), 0 otherwise.
   Paths are read from the environment at call time, so importing this module
   (nightly-runner.mjs does, for MERGE_SUMMARY) reads and writes nothing. */
export function run() {
  const RESOLVED_PATH = envPath("RESOLVED_PATH", "data-local/resolved.json");
  const EDITS_PATH = envPath("EDITS_PATH", "data-local/edits.json");
  /* The two OUTPUT files are overridable for the same reason the inputs are: this
     script had no test at all before #292, because the only way to run it was to
     let it write the real catalogue. Defaults are unchanged, so the nightly and the
     README recipe are untouched. */
  const MERGE_DISCOVER_PATH = envPath("MERGE_DISCOVER_PATH", "data/discover.json");
  const MERGE_TAGS_PATH = envPath("MERGE_TAGS_PATH", "data/item-tags.json");
  /* Read-only: the catalogue is consulted for each show's `label_scope` (see
     topics.mjs, TOPICS_REQUIRED_GENERAL). Overridable so the tests can hand merge
     a fixture catalogue instead of the real one. */
  const MERGE_CATALOG_PATH = envPath("MERGE_CATALOG_PATH", "data/catalog.json");

  const { resolved } = JSON.parse(readFileSync(RESOLVED_PATH, "utf8"));
  const edits = JSON.parse(readFileSync(EDITS_PATH, "utf8"));
  const discover = JSON.parse(readFileSync(MERGE_DISCOVER_PATH, "utf8"));
  const tagsDoc = JSON.parse(readFileSync(MERGE_TAGS_PATH, "utf8"));
  const nodeIds = new Set(JSON.parse(readFileSync(p("data/taxonomy.json"), "utf8")).nodes.map((n) => n.id));
  /* Keyed by show TITLE because that is the only show key a resolved record
     carries (`ep.show`), the same key the item literal below writes. A missing or
     unreadable catalogue is NOT tolerated: swallowing it would switch the
     general-show guard off without a word. */
  const catalog = JSON.parse(readFileSync(MERGE_CATALOG_PATH, "utf8"));
  const labelScopeByShow = new Map(catalog.shows.map((s) => [s.title, s.label_scope]));

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
  // docs/DECISIONS.md) so this list and the CI gate's list can never drift —
  // and since CH2-14 so do the hook cap and the tag bounds, which were literals
  // here: raising MAX_HOOK_WORDS there left this preflight refusing hooks the
  // gate passed.
  const { BANNED, wordCount: wc, MAX_HOOK_WORDS, MIN_TAGS, MAX_TAGS, TAG_RE } = copyRules;

  const copyErrors = [];
  /* The preflight walks EDITS, which carry no show, so the edit's show is found
     through its resolved record. An edit with no resolved record, or one already
     in discover.json, is never merged (see the item loop), so it is not judged
     here either — re-running a night stays idempotent. */
  const resolvedById = new Map(resolved.map((ep) => [ep.id, ep]));
  const presentIds = new Set(discover.items.map((i) => i.id));
  for (const [id, e] of Object.entries(edits)) {
    if (!e || typeof e.hook !== "string") { copyErrors.push(`${id}: missing hook`); continue; }
    if (wc(e.hook) > MAX_HOOK_WORDS) copyErrors.push(`${id}: hook ${wc(e.hook)}w > ${MAX_HOOK_WORDS}`);
    for (const rx of BANNED) if (rx.test(e.hook)) copyErrors.push(`${id}: banned ${rx} in hook`);
    if (!Array.isArray(e.tags) || e.tags.length < MIN_TAGS || e.tags.length > MAX_TAGS)
      copyErrors.push(`${id}: ${e.tags?.length} tags (need ${MIN_TAGS}-${MAX_TAGS})`);
    for (const t of e.tags || [])
      if (!TAG_RE.test(t)) copyErrors.push(`${id}: bad tag "${t}"`);
    /* Topic overrides are validated in the SAME preflight as the copy rules, and
       for the same reason: this loop runs before a single byte is written, so a bad
       override aborts the run instead of half-writing the catalogue. It must never
       become a filter — see topics.mjs on why a dropped bad id restores the very
       defect #292 is about. */
    const ep = presentIds.has(id) ? undefined : resolvedById.get(id);
    const labelScope = ep ? labelScopeByShow.get(ep.show) : undefined;
    if (e.topics !== undefined || labelScope === "general") {
      try {
        episodeTopics({ showTopics: [], editTopics: e.topics, nodeIds, id, labelScope });
      } catch (err) {
        copyErrors.push(err.message);
      }
    }
  }
  if (copyErrors.length) {
    console.error("COPY RULE FAILURES:\n" + copyErrors.join("\n"));
    return 1;
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
      /* The measured length wins when there is one (audit round 2, honesty-1;
         tools/check-durations.mjs gates the committed pool on exactly this). */
      duration_min: minutesFromSeconds(ep.duration_sec) ?? ep.duration_min,
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
      topics: episodeTopics({
        showTopics: ep.topics, editTopics: edit.topics, nodeIds, id: ep.id,
        labelScope: labelScopeByShow.get(ep.show),
      }),
      /* Provenance of the line above (#547): "show" = inherited seed, "episode" =
         the agent's own override. tools/refresh/backfill-provenance.mjs stamped
         the items merged before this field existed. */
      topics_source: topicSource(edit.topics),
      hook: edit.hook,
      /* Always present: `null` = unrated, so a reader can tell "no flag" from "key
         missing" (#560 §6.3). Family Mode already treats null as unrated. */
      explicit: ep.explicit ?? null,
    };
    discover.items.push(item);
    tagsDoc.tags[ep.id] = edit.tags;
    existingIds.add(ep.id);
    shows.push(ep.show);
    added++;
  }

  if (added === 0) {
    console.log(MERGE_SUMMARY.nothing);
    if (skippedNoEdit.length) console.log(`  ${skippedNoEdit.length} resolved item(s) had no edit and were skipped.`);
    return 0;
  }

  discover.built_at = now;
  tagsDoc.built_at = now;
  writeFileSync(MERGE_DISCOVER_PATH, JSON.stringify(discover, null, 2) + "\n");
  writeFileSync(MERGE_TAGS_PATH, JSON.stringify(tagsDoc, null, 2) + "\n");

  const uniqShows = [...new Set(shows)];
  console.log(MERGE_SUMMARY.added(added, now));
  console.log(`SHOWS: ${uniqShows.join(", ")}`);
  if (skippedNoEdit.length) console.log(`SKIPPED (no edit authored): ${skippedNoEdit.length}\n  ${skippedNoEdit.join("\n  ")}`);
  if (skippedPresent.length) console.log(`SKIPPED (already present): ${skippedPresent.length}`);
  return 0;
}

/* Entry guard (CH2-14; isEntryScript since CH2-41b). merge.mjs was top-level
   script code, so importing it ran a merge. tools/ci/entry.mjs's guard is the
   one form tools/entrypoint-guards.test.mjs allows; a `file://` template is
   silently false on Windows, a pathToFileURL comparison through a junction.
   exitCode, not process.exit(), so the summary lines finish flushing to a pipe
   first. */
if (isEntryScript(import.meta.url)) process.exitCode = run();
