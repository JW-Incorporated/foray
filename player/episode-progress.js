/* WHICH ordinary episode was last playing — the one fact nothing recorded.
 *
 * FOUNDER, 2026-09-18: "When I come back to 4a after a day, the podcast I was
 * listening to should still be in the now playing ribbon at the bottom."
 *
 * WHAT WAS ACTUALLY MISSING, which is much less than it first looks. Position
 * is already durable and has been since #26/#40: `position-store.js` writes
 * `cp_pos:<id>` through the IndexedDB-backed store on every `savePosition`
 * effect and on its own 15-second timer, and `resumeOffset()` already knows the
 * difference between "we stored 4 seconds" and "resume at 4 seconds". None of
 * that needed rebuilding and this file deliberately does not restate it —
 * position has ONE definition and it lives there.
 *
 * What nobody wrote down is the POINTER: which episode that was. `client.js`
 * holds it in a module-level `let current = null`, so a reload started with no
 * idea what had been playing, and the ribbon came back empty however good the
 * position data behind it was.
 *
 * WHY THE POINTER CARRIES A DISPLAY SNAPSHOT AND NOT JUST AN ID. The bar has to
 * repaint before any catalogue or API has loaded — that is the whole of
 * surviving a day — and an id alone cannot do it for the founder's own case: an
 * episode opened from a show page is not in `data/session.json` and does not
 * enter `state.itemIndex` until something fetches it. A Lex episode reached from
 * the show list would restore as a blank bar with a spinner, which is the
 * complaint again in a different costume.
 *
 * ONE ROW, NOT A HISTORY. "The podcast I was listening to" is singular. A
 * per-episode history is a different and much larger feature — eviction, a
 * surface to see it, a rule for when a row dies — and nothing today asks for it.
 */

/** The single pointer row. `cp_` prefix: renaming wipes user state (CLAUDE.md).
    Deliberately NOT `cp_pos:*`-shaped — that namespace is one row per episode
    and is owned by `position-store.js`. */
export const KEY = "cp_last_episode";

/** A pointer older than this stops being offered.
 *
 * Thirty days, matching `foray-progress.js`'s own MAX_AGE_H, so a Foray and an
 * episode age out of "Jump back in" together — one rail holding two kinds of
 * thing that disappear on different schedules is a bug report waiting to
 * happen. It is emphatically NOT the old 72-hour `CONTINUE_MAX_AGE_H`: "after a
 * day" is the founder's own headline and three days is uncomfortably close to
 * it. */
export const MAX_AGE_H = 24 * 30;

/** Kept from the item for repainting, as a closed list. The whole item would
    drag topics, scores and provenance into a row rewritten on every play —
    and `audio_url` is here because without it the restored bar has a play
    button that cannot play, which is the exact defect `bannerHtml`'s comment
    records for the partial snapshots it used to restore. */
const SNAPSHOT_FIELDS = ["id", "title", "show", "artwork_url", "audio_url", "duration_min", "duration_sec"];

/** The snapshot half, alone, so a caller can compare two without the timestamp
    making every comparison unequal. */
export function episodeSnapshot(item) {
  const out = {};
  if (!item) return out;
  for (const f of SNAPSHOT_FIELDS) {
    if (item[f] !== undefined && item[f] !== null) out[f] = item[f];
  }
  return out;
}

/**
 * Build the pointer. Null when there is nothing worth pointing at, so a caller
 * can write unconditionally and let this decide.
 */
export function makeLastEpisode(item, { now = Date.now() } = {}) {
  if (!item || !item.id) return null;
  return { ...episodeSnapshot(item), id: item.id, updated_at: new Date(now).toISOString() };
}

/** Persist, or clear when `record` is null. Returns whether the store took it —
    `lsSet`'s contract rather than a swallowed failure. */
export function writeLastEpisode(storage, record) {
  if (!storage) return false;
  try {
    if (record === null) { storage.removeItem(KEY); return true; }
    return storage.setItem(KEY, JSON.stringify(record)) !== false;
  } catch (_) {
    return false;
  }
}

/** Read it back, or null. Never throws: a corrupt half-written value is the
    same as no value, and losing the ribbon beats a boot that dies on a parse. */
export function readLastEpisode(storage) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    if (!rec || typeof rec !== "object" || !rec.id) return null;
    return rec;
  } catch (_) {
    return null;
  }
}

/**
 * Should this pointer be offered, and with what position?
 *
 * `positionSec` is supplied by the CALLER, from `PositionStore.resumeOffset` —
 * this module does not read positions, so the two cannot drift apart on what a
 * resume point is. The verdict is returned as a state rather than a boolean so
 * the mini bar and the home rail ask one question and get one answer.
 *
 *   `none`   — nothing stored, aged out, or unusable.
 *   `resume` — offer it, at `positionSec`.
 *
 * There is deliberately no `finished` state here. `resumeOffset` already
 * collapses "finished" to 0, and an episode you finished is still the podcast
 * you were listening to — the founder asked for it to be IN THE RIBBON, not for
 * it to be mid-way through. Dropping it at the end would be the same complaint
 * on the day he finishes something.
 */
export function lastEpisodeState(record, { positionSec = 0, now = Date.now() } = {}) {
  if (!record || !record.id) return { state: "none" };
  const ts = Date.parse(record.updated_at || "");
  if (!Number.isFinite(ts)) return { state: "none" };
  if ((now - ts) / 3.6e6 > MAX_AGE_H) return { state: "none", reason: "aged-out" };
  const pos = Number(positionSec);
  return { state: "resume", positionSec: Number.isFinite(pos) && pos > 0 ? pos : 0 };
}

/** Fraction played, 0..1, or null when either number is unknown. One definition
    for the bar's fill and the home card's progress line, so they agree. */
export function episodePercentDone(record, positionSec) {
  const pos = Number(positionSec);
  const dur = Number(record?.duration_sec ?? (record?.duration_min ? record.duration_min * 60 : NaN));
  if (!Number.isFinite(pos) || !Number.isFinite(dur) || dur <= 0) return null;
  return Math.max(0, Math.min(1, pos / dur));
}

/** "18 min left", or null when the duration is unknown. Minutes, not seconds: a
    second-precision countdown on a home card is noise that changes while you
    read it. */
export function episodeRemainingLabel(record, positionSec) {
  const pct = episodePercentDone(record, positionSec);
  if (pct === null) return null;
  const dur = Number(record.duration_sec ?? record.duration_min * 60);
  const mins = Math.round(Math.max(0, dur - Number(positionSec)) / 60);
  return mins <= 0 ? "finished" : `${mins} min left`;
}
