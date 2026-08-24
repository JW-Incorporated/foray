/* Which shows the next fresh batch takes.

   Pure, dependency-free (see labels.mjs on why that matters), and split out of
   prepare-batch.mjs so it is testable without backend/node_modules — the
   selector is where the founder's no-exclusion ruling either holds or quietly
   stops holding, so it needs a suite that can drive it directly.

   THE FOUNDER'S RULING, 2026-08-16: "no show should be excluded at this stage,
   just catalogued. I don't want to accidentally toss out shows that are still
   useful, for example for playlists (not forays)." Selection here PARTITIONS the
   queue across six workers and ORDERS it. It never trims it, and it never reads
   a label. tools/classify/no-exclusion.test.mjs asserts that against fixtures
   whose labels are as unhelpful as a real feed can make them.

   ONE THING CHANGED HERE, AND ONLY ONE: the shard key. The selection ORDER is
   byte-for-byte the behaviour prepare-batch.mjs already had — distrust bucket
   descending, input order within a bucket. The fleet review found that order
   close to meaningless (input order is ascending `apple_collection_id`, i.e.
   show REGISTRATION AGE, while `chart_rank` is passed into every batch and never
   used) and recommended re-ordering by rank. That is deliberately NOT done here:
   it is a change to what gets catalogued FIRST, nobody asked for it, and it is
   worth its own decision. The finding is recorded in the PR body. Do not "fix"
   it in passing.                                                            */

import { parseShard, shardOf } from "./labels.mjs";

const NEW_PIPELINE_SOURCE_PREFIX = "classify-agent-";
const RETRY_COOLDOWN_MS = 6 * 3600_000; // 6h between retry attempts on the same failed feed

/* Picks the next `batchSize` shows for a fresh pass.

   THE FOUR REASONS A SHOW IS NOT IN *THIS* BATCH — every one of them about work
   already done or in progress, never about what the show is:

     1. another shard owns it (the six shards PARTITION the catalogue: the union
        of all six is the whole eligible set, and they are disjoint);
     2. it is `in_flight` on an unmerged batch (reclaimed after 12h);
     3. this pipeline has already classified it (`classify-agent-*`);
     4. its feed failed recently and it is inside the retry cooldown.

   None of the four consults a label. A show that ships no transcript is selected
   on exactly the same terms as one that ships a timed VTT for every episode —
   the label says only that the first is more expensive to build from (rate and
   rationale: labels.mjs), and says nothing about whether we keep it. */
export function selectFreshCandidates(shows, classification, progress, now, batchSize, maxFetchAttempts, shard) {
  const shardSpec = parseShard(shard); // throws on a malformed value rather than silently running unsharded
  const entries = classification?.entries || {};
  const inFlight = progress?.in_flight || {};
  const failedFetch = progress?.failed_fetch || {};

  const candidates = [];
  for (const show of shows) {
    const id = String(show.apple_collection_id);
    // Parallel sharded run — a disjoint slice, no collision with sibling shards.
    // Hashed, stable key: `Number(id) % N` is 2.20x unbalanced over the shows
    // that remain and idles a sixth of the fleet from ~day 12 (labels.mjs).
    if (shardSpec && shardOf(id, shardSpec.count) !== shardSpec.index) continue;
    if (inFlight[id]) continue;
    const entry = entries[id];
    if (entry && entry.source && entry.source.startsWith(NEW_PIPELINE_SOURCE_PREFIX)) continue; // already reclassified

    const failed = failedFetch[id];
    if (failed && failed.attempts < maxFetchAttempts && now - new Date(failed.last_attempt_at).getTime() < RETRY_COOLDOWN_MS) {
      continue; // in cooldown, try again later
    }
    candidates.push(show);
  }

  /* Prioritize known-bad sources first (llm-title-genre, the distrusted
     refinement) so the least-trustworthy tags get replaced soonest; then
     genre-map-only; then never-classified. UNCHANGED from the original — and
     note that Array.prototype.sort is stable, which is what preserves input
     order within a bucket. */
  const rank = (show) => {
    const e = entries[String(show.apple_collection_id)];
    if (!e) return 0; // never classified — mildly urgent (no signal at all)
    if (e.source === "llm-title-genre") return 2; // most urgent — known-distrusted
    if (e.source === "genre-map") return 1;
    return 0;
  };
  candidates.sort((a, b) => rank(b) - rank(a));
  return candidates.slice(0, batchSize);
}

/* The Tier-2 queue: shows this pipeline already classified at Tier 1 and flagged
   needs_review. Moved here from prepare-batch.mjs, unchanged, so that it gets the
   same no-exclusion coverage as the fresh selector — it was the one selection path
   with no behavioural test at all, and a review demonstrated that a label-based
   `continue` could be added to it without any suite going red.

   It has NO shard support and no ordering, deliberately: it iterates
   `Object.entries(...)`, so six concurrent shards would select identical shows.
   prepare-batch.mjs refuses `--shard` with `--mode escalate` rather than ignoring
   it. The pile is small (~301 as of 2026-08-16) and drains as one routine.

   Same rule as the fresh selector: no label is consulted. The three reasons a
   show is not here are all about work — not Tier 1 yet, not flagged, or already
   reserved by an unmerged batch. */
export function selectEscalateCandidates(shows, classification, progress, batchSize) {
  const byId = new Map(shows.map((s) => [String(s.apple_collection_id), s]));
  const entries = classification?.entries || {};
  const inFlight = progress?.in_flight || {};
  const candidates = [];
  for (const [id, entry] of Object.entries(entries)) {
    if (entry.source !== "classify-agent-tier1") continue;
    if (!entry.needs_review) continue;
    if (inFlight[id]) continue;
    const show = byId.get(id);
    if (show) candidates.push({ show, priorResult: entry });
  }
  return candidates.slice(0, batchSize);
}

export { RETRY_COOLDOWN_MS, NEW_PIPELINE_SOURCE_PREFIX };
