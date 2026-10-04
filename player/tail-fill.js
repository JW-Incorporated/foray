/* The tail: "more of what fits", built from today's subject deal (PQ-10,
 * issue #691; docs/roadmap/player-features.md §3).
 *
 * WHY THIS EXISTS. When an episode ends and Up Next and the list are both
 * spent, the page keeps playing (founder ruling 2026-09-14: continuous
 * playback is wanted, "more podcasts to play while I'm in the car"). What it
 * plays next is this tail: a short ordered list of episode ids drawn from the
 * subject deal Home already made for the day (`state.cardSlots` in app.js,
 * built once per session by `buildCards`). The deal is the only ranking the
 * page has, and it already carries the exploration floor as a STRUCTURAL slot
 * (CLAUDE.md principle 1, ~30 %): one `stretch` slot from outside the
 * listener's top interest tier, then up to three `top` slots. The tail keeps
 * that floor by construction rather than by chance.
 *
 * THE RULE (README default Q18: every third tail pick is the stretch subject).
 * Positions are 1-based. Position p with `p % STRETCH_EVERY === 0` takes the
 * next unused id from the stretch slot's `items`; every other position takes
 * the next unused id from the `top` slots, round-robin in `slot` order. An
 * exhausted slot is skipped. An exhausted (or absent) stretch slot leaves ITS
 * positions unfilled — a top slot is never borrowed into them, because that
 * would quietly erase the floor exactly when the stretch subject has the
 * least to offer; the tail is shorter instead. Likewise, the stretch slot is
 * never borrowed into a top position: the share is "every third", not "as
 * many as it has". Two consecutive positions do not share `item.show` when
 * any alternative exists (two episodes of one podcast back to back is a hard
 * cut the listener hears). The walk stops early when nothing is left.
 *
 * THE RETURN VALUE HAS NO HOLES. An unfilled position is dropped, not
 * written as null, so the consumer (PQ-11: `continuationState().tail`, and
 * the engine plan's hops) can walk it as a plain list of playable ids. The
 * role of a given id is asked, not inferred from its index: `tailReason`.
 *
 * INJECTED, NOT READ. `slots` is passed in as data (the same shape
 * `buildCards` writes), `exclude` is whatever the caller has already played or
 * queued (history, Up Next, the list, the current episode). Nothing here touches
 * `state`, storage or Math.random, so the same inputs give the same tail — a
 * fixture can hold the whole decision, and the page can evaluate it eight hops
 * ahead for the native engine. The dealer's own jitter lives in `buildCards`;
 * by the time the slots reach this file, the day's deal is fixed.
 *
 * SLOT SHAPE (app.js `buildCards`):
 *   { slot: 1.., branch, role: "stretch" | "top", item, items: [{ id, show, … }] }
 * The stretch slot is first when one exists. `items` are the subject's episodes
 * in the dealer's order (unseen first, then seen-not-played, then played).
 */

export const STRETCH_EVERY = 3;
export const TAIL_LENGTH = 10;

const isStretchPosition = (p) => p % STRETCH_EVERY === 0;

const showOf = (item) => (item && item.show != null ? String(item.show) : null);

/** Slots of one role, in `slot` order, each reduced to its unused items. */
function lanes(slots, role) {
  return (Array.isArray(slots) ? slots : [])
    .filter((sl) => sl && sl.role === role && Array.isArray(sl.items))
    .slice()
    .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
}

/** First unused item in `lane`, preferring one whose show differs from `prevShow`.
 *  Returns null when the lane has nothing unused. */
function pickFrom(lane, taken, prevShow, strict) {
  let fallback = null;
  for (const it of lane.items) {
    if (!it || it.id == null || taken.has(it.id)) continue;
    if (prevShow === null || showOf(it) !== prevShow) return it;
    if (!strict && fallback === null) fallback = it;
  }
  return fallback;
}

/**
 * Build the tail. Returns an array of episode ids, at most `length` long, with
 * no duplicates, none from `exclude`, and the stretch share at every
 * STRETCH_EVERY-th position (dropped, never borrowed, when the stretch slot
 * has nothing left).
 */
export function buildTail({ slots, exclude = [], length = TAIL_LENGTH } = {}) {
  const taken = new Set(Array.isArray(exclude) ? exclude : []);
  const stretch = lanes(slots, "stretch");
  const tops = lanes(slots, "top");
  const total = Math.max(0, Math.floor(Number(length) || 0));

  const out = [];
  let cursor = 0; // round-robin position over `tops`
  let prevShow = null;

  const anyLeft = (lane) => lane.items.some((it) => it && it.id != null && !taken.has(it.id));

  for (let p = 1; p <= total; p++) {
    /* Stop early: nothing left anywhere. Checked per position (not once) so a
       stretch slot that empties mid-walk still lets the top slots finish. */
    if (!stretch.some(anyLeft) && !tops.some(anyLeft)) break;

    let pick = null;
    if (isStretchPosition(p)) {
      /* The stretch position draws from the stretch slot alone. `stretch` holds
         one slot (buildCards deals at most one); if it ever held more, the first
         by slot order with something left wins. */
      for (const lane of stretch) {
        pick = pickFrom(lane, taken, prevShow, false);
        if (pick) break;
      }
    } else if (tops.length) {
      /* Round-robin over the top slots from `cursor`. First pass: a slot (in
         rotation order) that can offer a different show than the one before.
         Second pass: any slot with anything left. The cursor lands after the
         slot that supplied the pick, so the rotation continues from there. */
      for (const strict of [true, false]) {
        for (let k = 0; k < tops.length && !pick; k++) {
          const idx = (cursor + k) % tops.length;
          const candidate = pickFrom(tops[idx], taken, prevShow, strict);
          if (candidate) {
            pick = candidate;
            cursor = (idx + 1) % tops.length;
          }
        }
        if (pick) break;
      }
    }

    if (!pick) continue; // this position stays unfilled; the walk goes on
    taken.add(pick.id);
    out.push(pick.id);
    prevShow = showOf(pick);
  }
  return out;
}

/** Why an id is in the tail: the slot that supplied it, as `{ role, branch }`,
 *  or null when no slot holds that id. */
export function tailReason(slots, id) {
  if (id == null) return null;
  for (const sl of Array.isArray(slots) ? slots : []) {
    if (!sl || !Array.isArray(sl.items)) continue;
    if (sl.items.some((it) => it && it.id === id)) return { role: sl.role, branch: sl.branch };
  }
  return null;
}
