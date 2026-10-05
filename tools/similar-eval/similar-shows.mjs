/* A byte-for-byte mirror of `app.js:similarShows`, so the Similar-shows eval
   (#560 item 8) can score the shipped ranking without booting the app.

   WHY A MIRROR AND NOT AN IMPORT
   `app.js` is a classic browser script: it reads `state` from its own top-level
   scope and exports nothing. The eval needs to call the exact function the show
   page calls, against the exact catalogue the client loads
   (`data/catalog-client.json`, `app.js` `fetchJson("data/catalog-client.json")`).

   WHY IT CANNOT DRIFT
   `test/similar-shows-eval.test.js` lifts the `function similarShows` text out
   of app.js and asserts it is IDENTICAL to the block between the two MIRROR
   markers below. A change to app.js's ranking turns that test red until this
   copy is updated in the same PR, and then the measured floors in the same
   suite say whether the change made Similar shows better or worse.

   Do not edit the block by hand except to paste app.js's current function over
   it. Everything outside the markers is the harness: a module-scoped `state`
   carrying only `catalog`, which is the only field the function reads. */

let state = { catalog: null };

// BEGIN MIRROR app.js similarShows
function similarShows(show, limit = 6) {
  if (show?.label_scope === "general") return [];
  const nodeIds = new Set(show?.taxonomy_node_ids || []);
  if (!nodeIds.size) return [];
  const all = state.catalog?.shows || [];
  return all
    .filter(s => s.show_id !== show.show_id && s.label_scope !== "general")
    .map(s => ({ show: s, shared: (s.taxonomy_node_ids || []).filter(id => nodeIds.has(id)).length }))
    .filter(x => x.shared > 0)
    .sort((a, b) => b.shared - a.shared || a.show.show_id.localeCompare(b.show.show_id))
    .slice(0, limit)
    .map(x => x.show);
}
// END MIRROR

/** The two marker lines around the mirrored block; the drift test slices
 *  this file between them. */
export const MIRROR_BEGIN = "// BEGIN MIRROR app.js similarShows";
export const MIRROR_END = "// END MIRROR";

/**
 * `similarShows(show, limit)` evaluated against `catalog` (the parsed
 * `data/catalog-client.json`). `limit` undefined means the function's own
 * default, so the eval scores the slot count the show page actually renders.
 */
export function similarShowsFor(catalog, show, limit) {
  state = { catalog };
  try {
    return similarShows(show, limit);
  } finally {
    state = { catalog: null };
  }
}
