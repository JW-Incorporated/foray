/* What IS the queue? (issue #33's blocking product question, made pluggable.)

   The reducer deliberately does not own "what plays next" — it takes the next
   item as an event payload (see the ownership note at the top of
   queue-state.js). That leaves a decision nobody has made: when you pick one of
   the four cards, is the queue that one episode, or that one plus the others?

   Rather than block the manager on an answer, the answer is injected. The seam
   already exists in the architecture; this just names it.

   **Default is SINGLE_ITEM**, and that is a real default, not a placeholder:

   - It is the only option consistent with `CLAUDE.md`'s product principle 1 —
     "no engagement dark patterns (no streaks, no infinite scroll, no autoplay
     chains)". A queue that rolls into the next episode unasked is an autoplay
     chain.
   - It is the smallest thing that works. PICKED_FIRST and CONTINUE_TAIL are
     additive later without reopening the reducer or the manager.
   - Foray's product is "pick one of four", and `app.js` has no queue concept at
     all today, so single-item is also the least surprising.

   Switching is one argument at construction. Joey can still overrule this
   without any code being rewritten — which is the entire point.
*/

/** One episode. It ends, the session ends. No autoplay chain. */
export const SINGLE_ITEM = {
  name: "single-item",
  build: (picked) => (picked ? [picked] : []),
};

/** The picked episode, then the other cards behind it. Closest to the
    "session as a drive" framing in docs/brief/. */
export const PICKED_FIRST = {
  name: "picked-first",
  build: (picked, { others = [] } = {}) =>
    picked ? [picked, ...others.filter((o) => o && o.id !== picked.id)] : [],
};

/** The picked episode, then whatever the listener was part-way through.
    Pairs with the continue-card concept. */
export const CONTINUE_TAIL = {
  name: "continue-tail",
  build: (picked, { continueItem = null } = {}) => {
    const q = picked ? [picked] : [];
    if (continueItem && (!picked || continueItem.id !== picked.id)) q.push(continueItem);
    return q;
  },
};

export const STRATEGIES = { SINGLE_ITEM, PICKED_FIRST, CONTINUE_TAIL };

/** Validate a strategy at construction rather than discovering a typo at the
    moment the user presses play. */
export function assertStrategy(s) {
  if (!s || typeof s.build !== "function" || typeof s.name !== "string") {
    throw new Error("queue strategy must be { name: string, build: function }");
  }
  return s;
}
