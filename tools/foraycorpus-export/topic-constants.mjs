/* Topic-assignment constants (PKG-28's module, docs/roadmap/corpus.md §3).

   PROVISIONAL. Every number here is the plan's placeholder (corpus.md
   §PKG-28), not a decision. PKG-28 owns this file: it writes
   docs/curation/episode-topics-rule.md, chooses ASSIGN_COSINE_MIN (τ) on a
   50-episode hand-checked sample of real episode terms, edits the numbers
   below to match the doc, sets PROVISIONAL to false and adds the 1-test suite
   that pins them. τ cannot be chosen until a PKG-15 sync exists, so PKG-28 is
   blocked and topics.mjs (PKG-29) was built against these names first, so that
   PKG-28 changes numbers only.

   While PROVISIONAL is true, `topics.mjs --write` refuses to touch data/. A
   dry run (no --write) still works, with `--tau <n>` standing in for τ, which
   is how PKG-28 can look at assignments while choosing it. */

/** True until PKG-28 replaces the placeholders with the rule doc's numbers. */
export const PROVISIONAL = true;

/** Terms kept per node from the corpus evidence (top-K by summed tf-idf). */
export const K = 25;

/** A term found in more than this share of ALL taxonomy nodes' evidence is
    corpus vocabulary, not node vocabulary, and is dropped from every node. */
export const NODE_TERM_MAX_NODE_SHARE = 0.3;

/** τ: the cosine an episode needs to be assigned a node. NOT CHOSEN — the plan
    gives no provisional value, so there is none here; topics.mjs requires an
    explicit `--tau` (or `tau` option) until PKG-28 sets it. */
export const ASSIGN_COSINE_MIN = null;

/** Nodes assigned per episode by cosine (a parent added for a child does not count). */
export const MAX_NODES_PER_EPISODE = 3;

/** A SHOW is `general` when its episodes spread over at least this many root nodes … */
export const GENERAL_MIN_ROOTS = 6;

/** … and no one root holds more than this share of its assigned episodes. */
export const GENERAL_MAX_SHARE = 0.4;
