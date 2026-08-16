/* "Jump back in" — where a listener left a Foray, across sessions.

   ── Why this is not PositionStore ─────────────────────────────────────────
   `player/position-store.js` answers "how far into THIS audio file am I", keyed
   by queue-item id. That is the right key for an episode and the wrong one for a
   Foray: a Foray is 32 queue items, its resume point is a pair (which segment,
   how far into it), and the number a listener recognises is neither — it is
   elapsed across the WHOLE Foray (`forayElapsed`). Storing 32 per-segment rows
   and trying to reconstruct "23:14 of 1:01:13" from them means guessing which of
   them was the live one; storing one row per Foray does not.

   So this is a second, deliberately small store beside that one. It records the
   Foray's own clock, and the segment index only as a hint for painting the
   running order before anything has loaded.

   Pure: no DOM, no network, no timers, no `localStorage` reference of its own —
   the storage object is passed in, which is what makes it testable without a
   browser. Keys keep the legacy `cp_` prefix (CLAUDE.md § Conventions).

   ── The two thresholds, and why they are not PositionStore's ──────────────
   PositionStore resumes above 10 s and calls the last 30 s "finished". A Foray
   is an hour of 90-second segments, so both are re-derived rather than copied:
   20 s in is still the first segment (offering to resume it is noise), and the
   last 45 s is inside the closing segment, where resuming lands the listener in
   a goodbye. Neither number is tuned against real listening yet — there is
   none — so they are named constants, not literals buried in a branch.
*/

/** One row per Foray. `cp_` prefix: renaming these wipes user state. */
export const KEY_PREFIX = "cp_foray:";

/** Below this, there is nothing worth resuming to — offer a fresh start. */
export const MIN_RESUME_SEC = 20;

/** Inside this of the end, the Foray is finished. Resuming 20 seconds before
    the last out-point is worse than saying nothing. */
export const NEAR_END_SEC = 45;

/** Progress older than this stops being offered. A month-old half-listen is not
    a thing anyone is "jumping back in" to, and the row is otherwise immortal. */
export const MAX_AGE_H = 24 * 30;

const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const nonEmpty = (s) => typeof s === "string" && s.trim().length > 0;

export function progressKey(forayId) {
  return `${KEY_PREFIX}${forayId}`;
}

/**
 * The stored shape. Written in one place so a reader never has to guess which
 * fields an older row has.
 *
 * @param {object} p
 * @param {string} p.forayId
 * @param {string} [p.title]     so the home screen can name it without loading
 *                               and joining three data files first
 * @param {number} p.elapsedSec  the FORAY's clock, not the audio element's
 * @param {number} p.totalSec
 * @param {number} [p.index]     segment the listener was on, for painting
 * @param {Date|string} [p.now]
 */
export function makeProgress({ forayId, title = "", elapsedSec, totalSec, index = -1, now = new Date() }) {
  return {
    foray_id: forayId,
    title: nonEmpty(title) ? title : "",
    elapsed_sec: clampNum(elapsedSec),
    total_sec: clampNum(totalSec),
    index: Number.isInteger(index) && index >= 0 ? index : -1,
    updated_at: typeof now === "string" ? now : now.toISOString(),
  };
}

function clampNum(n) {
  return isNum(n) && n > 0 ? n : 0;
}

/** A row is only usable if it names a Foray and carries a finite clock. Anything
    else is a partially-written or hand-edited entry and is treated as absent. */
export function isProgressRecord(r) {
  return Boolean(
    r && typeof r === "object" && nonEmpty(r.foray_id) &&
    isNum(r.elapsed_sec) && r.elapsed_sec >= 0 &&
    isNum(r.total_sec) && r.total_sec > 0
  );
}

/* ---------- storage ---------- */

export function readProgress(storage, forayId) {
  if (!storage || !nonEmpty(forayId)) return null;
  try {
    const raw = storage.getItem(progressKey(forayId));
    if (!raw) return null;
    const r = JSON.parse(raw);
    return isProgressRecord(r) ? r : null;
  } catch (_) {
    return null;
  }
}

export function writeProgress(storage, record) {
  if (!storage || !isProgressRecord(record)) return false;
  try {
    storage.setItem(progressKey(record.foray_id), JSON.stringify(record));
    return true;
  } catch (_) {
    // Quota, private mode, or storage blocked outright. Losing a resume point
    // is bad; throwing inside the player's render loop is worse.
    return false;
  }
}

export function clearProgress(storage, forayId) {
  if (!storage || !nonEmpty(forayId)) return;
  try { storage.removeItem(progressKey(forayId)); } catch (_) {}
}

/**
 * Every stored Foray position, most recent first.
 *
 * Enumerated through `length`/`key(i)` rather than `Object.keys`, because that
 * is the part of the Storage interface that is actually specified — and because
 * a caller passing a plain object as a fake should have to implement the same
 * two methods the real thing has.
 */
export function listProgress(storage, { now = Date.now(), maxAgeH = MAX_AGE_H } = {}) {
  if (!storage || typeof storage.key !== "function") return [];
  const out = [];
  let n = 0;
  try { n = Number(storage.length) || 0; } catch (_) { return []; }
  for (let i = 0; i < n; i++) {
    let key = null;
    try { key = storage.key(i); } catch (_) { continue; }
    if (typeof key !== "string" || !key.startsWith(KEY_PREFIX)) continue;
    const r = readProgress(storage, key.slice(KEY_PREFIX.length));
    if (r && !isStale(r, { now, maxAgeH })) out.push(r);
  }
  return out.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

function isStale(record, { now, maxAgeH }) {
  const t = Date.parse(record?.updated_at ?? "");
  if (!Number.isFinite(t)) return false;  // undated rows are kept, not silently dropped
  return (now - t) / 3.6e6 > maxAgeH;
}

/* ---------- what to do with a row ---------- */

/**
 * Where playback should actually start, and whether to offer it at all.
 *
 * Distinct from `readProgress` for the same reason `PositionStore.resumeOffset`
 * is distinct from its `load`: "we stored 19 seconds" and "resume at 19 seconds"
 * are different questions.
 *
 * `totalSec` is passed separately because the Foray on disk can have changed
 * since the row was written — a segment repaired, one dropped — and the live
 * document is the authority on how long it is now.
 *
 * @returns {{ elapsedSec: number, index: number, remainingSec: number,
 *             percent: number, finished: boolean } | null}
 */
export function resumePoint(record, { totalSec = null } = {}) {
  if (!isProgressRecord(record)) return null;
  const total = isNum(totalSec) && totalSec > 0 ? totalSec : record.total_sec;
  // A stored position past the end of the Foray as it exists NOW is not a
  // resume point; it is a stale row against a shorter document.
  const elapsed = Math.min(record.elapsed_sec, total);
  if (elapsed < MIN_RESUME_SEC) return null;
  if (elapsed > total - NEAR_END_SEC) {
    return { elapsedSec: elapsed, index: record.index, remainingSec: 0, percent: 100, finished: true };
  }
  return {
    elapsedSec: elapsed,
    index: record.index,
    remainingSec: total - elapsed,
    percent: percentDone(elapsed, total),
    finished: false,
  };
}

/** 0–100, rounded. Used for a bar width, so it is clamped rather than trusted. */
export function percentDone(elapsedSec, totalSec) {
  if (!isNum(elapsedSec) || !isNum(totalSec) || totalSec <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((elapsedSec / totalSec) * 100)));
}

/**
 * "32 min left" — the mockup's own phrasing for a partially-played Foray
 * (`ForayCard`'s amber label), and the only progress copy it shows.
 *
 * Whole minutes, because the mockup rounds too and because a Foray's runtime is
 * a sum of measurements of other people's audio; "31 min 42 s left" claims a
 * precision the segment boundaries do not have. Under a minute it says so
 * rather than rounding to "0 min left".
 */
export function remainingLabel(remainingSec) {
  if (!isNum(remainingSec) || remainingSec <= 0) return "finished";
  if (remainingSec < 60) return "under a minute left";
  return `${Math.round(remainingSec / 60)} min left`;
}

/* ---------- the writer ---------- */

/** How often a live playhead is written down. The listener loses at most this
    much on a crash, and it is far inside corner case #17's 15-second bar. */
export const SAVE_EVERY_SEC = 5;

/**
 * A throttled writer, so the player can call `save()` on every position tick
 * (4 Hz) without writing to localStorage 14,000 times an hour.
 *
 * The throttle is on the CLOCK VALUE, not on wall time: a paused player ticks
 * without moving, and a seek moves without ticking. Comparing elapsed seconds
 * gets both right, and makes the whole thing testable with no fake timers.
 */
export class ForayProgressStore {
  /**
   * @param {object} [opts]
   * @param {Storage} [opts.storage]  defaults to `localStorage` when present
   * @param {number}  [opts.everySec]
   */
  constructor({ storage = null, everySec = SAVE_EVERY_SEC } = {}) {
    this.storage = storage ?? (typeof localStorage !== "undefined" ? localStorage : null);
    this.everySec = isNum(everySec) && everySec > 0 ? everySec : SAVE_EVERY_SEC;
    this._lastWritten = new Map();
  }

  get(forayId) {
    return readProgress(this.storage, forayId);
  }

  list(opts = {}) {
    return listProgress(this.storage, opts);
  }

  /**
   * @param {object} p  as `makeProgress`
   * @param {boolean} [p.force]  bypass the throttle — pause, page-hide, the
   *   moments where the next tick may never come
   * @returns {boolean} whether it wrote
   */
  save({ forayId, title, elapsedSec, totalSec, index = -1, force = false, now = new Date() }) {
    if (!nonEmpty(forayId) || !isNum(elapsedSec) || !isNum(totalSec) || totalSec <= 0) return false;
    const last = this._lastWritten.get(forayId);
    if (!force && last != null && Math.abs(elapsedSec - last) < this.everySec) return false;
    const ok = writeProgress(this.storage, makeProgress({ forayId, title, elapsedSec, totalSec, index, now }));
    if (ok) this._lastWritten.set(forayId, elapsedSec);
    return ok;
  }

  clear(forayId) {
    clearProgress(this.storage, forayId);
    this._lastWritten.delete(forayId);
  }
}
