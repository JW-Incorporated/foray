/* Per-episode topics — the one place the pipeline decides what an episode is
   ABOUT. Pure functions only (no I/O), so both the nightly and the backfill can
   share them and a test can reach every branch. Issue #292.

   THE DEFECT THIS EXISTS TO FIX, STATED PRECISELY. `scan.mjs` and
   `backfill-show.mjs` both seed an episode's `topics` from its SHOW's
   `taxonomy_node_ids`, and nothing downstream could ever change that. Measured on
   committed `main` (1,651 items, 221 shows): of the 99 shows with >= 8 episodes,
   **77 carried an identical topic set on every single episode**. The per-episode
   variation discovery ranks on did not exist.

   THE SHOW-LEVEL SEED IS NOT THE BUG AND IS DELIBERATELY KEPT. For a
   single-subject show a uniform label is ACCURATE: `Engines of Our Ingenuity`
   (38 episodes) really is `history/technology` and `The Race F1 Podcast` (20)
   really is `automotive/racing`. Re-deriving those per episode would add churn
   and risk without adding truth. The bug is that the same default is
   unappealable on shows that RANGE — 23 `Stuff You Should Know` episodes
   covering a borehole, an earthquake, a fusion playlist and Bonnie and Clyde,
   all labelled `history/technology` + `science/materials`.

   `Odd Lots` IS NOT ONE OF THE SAFE EXAMPLES, though the #292 issue and an
   earlier draft of this comment both used it as one. Reading its 22 episodes
   through `topic-uniformity.mjs --show "Odd Lots"` shows *How the Invention of
   Rope Gave Us Modern Civilization*, *the Undersea Cables That Keep the Internet
   Alive*, *Architect Norman Foster on Why the West Struggles to Build Big* and
   *How a Sardine Gets From the Ocean to a Can* — a show that ranges through an
   economics LENS, which is the same profile as `Freakonomics Radio`. It is left
   uniform here only because it was not part of this pass, not because it earned
   it. Do not cite it as proof that a uniform label is fine.

   So the seed stays and gains an OVERRIDE: the curating agent, which already
   authors a hook and 5-12 tags per episode from that episode's own description,
   may also author `topics`. `merge.mjs` is where the override is applied, and
   that is the whole reason it holds for BOTH pipelines — `scan.mjs` and
   `backfill-show.mjs` are two producers of one `fresh-pending` shape that
   converge on `resolve.mjs` -> `merge.mjs`. A fix in either producer would have
   been a fix in one path only, which is the divergence class of #211/#219/#249.

   LABEL, NEVER EXCLUDE. An override may only REPLACE labels, never remove an
   episode from the catalogue. That is why `[]` is refused rather than accepted as
   "no topics": `resolve.mjs` drops an episode whose topic list is empty, so an
   empty override would be an exclusion wearing a label's clothes. And why an
   invalid node id THROWS instead of being filtered away — a silently dropped bad
   id leaves the episode wearing the show default nobody chose, which is the
   original defect restored by the code meant to cure it. */

/** An order-insensitive key for a topic set, so `["a","b"]` and `["b","a"]` are
    the same label and not two. Used by the uniformity report below, and it is
    the reason that report cannot be fooled by re-ordering. */
export function topicKey(topics) {
  return [...new Set(topics || [])].sort().join("|");
}

/** Upper bound on a per-episode override. See the guard in episodeTopics. */
export const MAX_TOPICS = 5;

export class TopicError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** The topics one episode ships with.

    `editTopics` is the agent's per-episode override and is OPTIONAL: absent
    (undefined/null) means "the show-level label is right for this episode", which
    is the correct answer for most episodes of most shows and must stay free to
    express. Present means it wins outright — it does not merge with the seed,
    because a curator who judged an episode to be about `nature/earth-science` is
    making a statement about the whole label, not adding to one.

    `nodeIds` is the set from data/taxonomy.json. Every override id is validated
    against it: the taxonomy is the only topic space that exists, and an id
    outside it is dead weight that CI's data-topic-integrity suite would later
    fail on anyway — better here, before anything is written. */
export function episodeTopics({ showTopics, editTopics, nodeIds, id = "?" } = {}) {
  /* Copied, not aliased: the return value is written onto a discover item, and
     handing back the resolved record's own array makes two documents share one
     mutable list for free. Costs nothing; removes a whole class of later bug. */
  const seed = Array.isArray(showTopics) ? [...showTopics] : [];
  if (editTopics === undefined || editTopics === null) return seed;
  if (!Array.isArray(editTopics)) {
    throw new TopicError("TOPICS_NOT_ARRAY", `${id}: topics must be an array, got ${typeof editTopics}`);
  }
  if (editTopics.length === 0) {
    throw new TopicError(
      "TOPICS_EMPTY",
      `${id}: topics override is empty. resolve.mjs drops an episode with no valid topic, ` +
        `so this would remove the episode from the catalogue rather than relabel it. ` +
        `Omit the field to keep the show's label.`
    );
  }
  /* BOUNDED, BECAUSE ITS NEIGHBOUR IS. `tags` is capped at 5-12 in the same
     preflight; `topics` was unbounded, and nothing downstream would have caught a
     20-id override: data-topic-integrity and the backend's pool-integrity suite
     both check non-empty and resolvable, neither checks length. The harm is
     quiet rather than loud — only `topics[0]` feeds `branchOf`, so an
     over-labelled item's branch still looks right while it surfaces under every
     topic it names, and `interestScore` averages across all of them, flattening
     that item's personalisation toward the mean. 5 is generous: the nightly
     prompt asks for 1-3, and the whole catalogue's maximum is 2. */
  if (editTopics.length > MAX_TOPICS) {
    throw new TopicError(
      "TOPICS_TOO_MANY",
      `${id}: ${editTopics.length} topics, max ${MAX_TOPICS}. An episode about more than a few ` +
        `things is usually an episode whose primary subject has not been chosen.`
    );
  }
  const unknown = editTopics.filter((t) => !nodeIds.has(t));
  if (unknown.length) {
    /* JSON.stringify per element, not join: `[null]` and `[""]` are real
       hand-edit typos and both render as nothing under `join`, leaving the
       operator with "not taxonomy node ids: " and no way to find the offender. */
    throw new TopicError(
      "TOPICS_UNKNOWN",
      `${id}: not taxonomy node ids: ${unknown.map((t) => JSON.stringify(t)).join(", ")} (see data/taxonomy.json)`
    );
  }
  return [...new Set(editTopics)];
}

/** Shows whose every episode carries the SAME topic set — the measurement that
    opened #292, committed so it can be re-run rather than re-derived.

    `minEpisodes` defaults to 8 because that is the threshold the issue's
    measurement used, and a 2-episode show being uniform says nothing.

    THIS IS A REPORT, NOT A GATE, and deliberately so: a uniform label is a defect
    on a show that ranges and a truth on a show that does not, and no arithmetic
    here can tell those apart. Only a human or a curating agent reading the
    episodes can. Returned newest-largest-first so the biggest contributors to
    document frequency are read first. */
export function uniformTopicShows(items, { minEpisodes = 8 } = {}) {
  const byShow = new Map();
  for (const i of items || []) {
    if (!byShow.has(i.show)) byShow.set(i.show, []);
    byShow.get(i.show).push(i);
  }
  const out = [];
  for (const [show, eps] of byShow) {
    if (eps.length < minEpisodes) continue;
    const keys = new Set(eps.map((e) => topicKey(e.topics)));
    if (keys.size !== 1) continue;
    out.push({ show, episodes: eps.length, topics: [...new Set(eps[0].topics || [])].sort() });
  }
  out.sort((a, b) => b.episodes - a.episodes || a.show.localeCompare(b.show));
  return out;
}

/** The denominator the headline reads against: shows big enough to be judged. */
export function substantialShows(items, { minEpisodes = 8 } = {}) {
  const counts = new Map();
  for (const i of items || []) counts.set(i.show, (counts.get(i.show) || 0) + 1);
  return [...counts.values()].filter((n) => n >= minEpisodes).length;
}
