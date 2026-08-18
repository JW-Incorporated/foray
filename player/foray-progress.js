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

   ── Where the row actually lives (#40) ────────────────────────────────────
   That injected `storage` used to be `localStorage`, which browsers evict —
   Safari after ~7 days without a visit, anyone under storage pressure. So the
   thing `player/client.js` passes in is now `player/durable-store.js`: the same
   synchronous Storage shape, backed by IndexedDB with localStorage kept as a
   mirror. Nothing in this file changed to accommodate that, which was the point
   of injecting it — and `save()` now counts the writes it was refused, because
   a resume store that silently stops recording is the defect, not an edge case.

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

/* ---------- data freshness: the row and the document can disagree ----------

   The service worker serves `data/*.json` network-first (`sw.js`), so a listener
   offline or on a dead cell gets the LAST-KNOWN Foray, while their stored row
   was written against whatever the document said at the time. Between those two
   moments a segment can be repaired, dropped, or moved: #40 pairs durability
   with freshness precisely because a durable row pointed at a changed document
   is a new way to lose someone.

   A row therefore records WHICH segment it was in (`segment_id`) and how far
   into it (`into_sec`), not only a number of seconds into a running order that
   may no longer be that running order. Given the live order, `resumePoint` can
   then say honestly which of five things happened. */

/** No live running order was supplied — the caller did not ask to be checked. */
export const DRIFT_UNVERIFIED = "unverified";
/** The segment is exactly where the row says it is. */
export const DRIFT_EXACT = "exact";
/** The segment still exists, at a different place in the Foray. Resume follows
    the SEGMENT, not the clock: the listener remembers the content. */
export const DRIFT_MOVED = "moved";
/** The stored segment is not in the Foray any more. Resume falls back to the
    clock, clamped to the live runtime, and paints no row as current. */
export const DRIFT_DROPPED = "dropped";
/** A row written before this file recorded segment ids. Checked against the live
    runtime and segment count only, exactly as it always was. */
export const DRIFT_UNANCHORED = "unanchored";

/** Within this much, a re-derived clock and a stored clock are the same moment.
    Segment lengths are sums of measurements of other people's audio; treating a
    half-second as drift would report `moved` on every ordinary resume. */
export const DRIFT_TOLERANCE_SEC = 1;

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
 * @param {string} [p.segmentId] the AUTHORED id of that segment — the only part
 *                               of this row that still means something after the
 *                               running order changes under it
 * @param {number} [p.intoSec]   seconds into that segment, so a segment that
 *                               MOVED can be resumed at the same moment of the
 *                               same audio rather than the same clock reading
 * @param {Date|string} [p.now]
 */
export function makeProgress({
  forayId, title = "", elapsedSec, totalSec, index = -1,
  segmentId = null, intoSec = 0, now = new Date(),
}) {
  return {
    foray_id: forayId,
    title: nonEmpty(title) ? title : "",
    elapsed_sec: clampNum(elapsedSec),
    total_sec: clampNum(totalSec),
    index: Number.isInteger(index) && index >= 0 ? index : -1,
    /* null, not undefined: this row round-trips through JSON, and an absent
       property and a null one must read back the same way. */
    segment_id: nonEmpty(segmentId) ? segmentId : null,
    into_sec: isNum(intoSec) && intoSec > 0 ? intoSec : 0,
    updated_at: typeof now === "string" ? now : now.toISOString(),
  };
}

function clampNum(n) {
  return isNum(n) && n > 0 ? n : 0;
}

/** A row is only usable if it names a Foray and carries a finite clock. Anything
    else is a partially-written or hand-edited entry and is treated as absent.
    `segment_id` and `into_sec` are deliberately NOT required: every row written
    before they existed is still a valid resume point, and demanding them would
    have thrown away the state this change exists to protect. */
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
 * `totalSec` and `maxIndex` are passed separately because the Foray on disk can
 * have changed since the row was written — a segment repaired, one dropped — and
 * the live document is the authority on both how long it is and how many
 * segments it has. Clamping one without the other is the bug this signature is
 * shaped to prevent: a stored `index` of 31 against a Foray that now has 20
 * segments marks the whole running order as already heard.
 *
 * `segments` is the freshness half of #40, and it is optional so that every
 * existing caller keeps its exact behaviour: without it the answer is the clock,
 * clamped, with `drift: "unverified"`. With it, the stored `segment_id` is looked
 * up in the LIVE order and the clock is re-derived from where that segment now
 * starts — so a reordered Foray resumes to the same audio rather than to the same
 * number, and a deleted segment degrades to a clamped clock with no row painted
 * instead of seeking somewhere wrong.
 *
 * @param {object} [opts]
 * @param {number} [opts.totalSec]   the LIVE runtime
 * @param {number} [opts.maxIndex]   the LIVE last playable index
 * @param {Array<{id: ?string, startSec: number, durationSec: number}>} [opts.segments]
 *   the LIVE running order, in play order. Build it with
 *   `progressSegments(resolved)` from `player/foray-resolve.js`.
 * @returns {{ elapsedSec: number, index: number, remainingSec: number,
 *             percent: number, finished: boolean, drift: string } | null}
 */
export function resumePoint(record, { totalSec = null, maxIndex = null, segments = null } = {}) {
  if (!isProgressRecord(record)) return null;
  const total = isNum(totalSec) && totalSec > 0 ? totalSec : record.total_sec;
  const at = reconcileSegment(record, segments);
  // A stored position past the end of the Foray as it exists NOW is not a
  // resume point; it is a stale row against a shorter document.
  const elapsed = Math.min(isNum(at.elapsedSec) ? at.elapsedSec : record.elapsed_sec, total);
  /* A live index from reconciliation is already live and needs no clamp. Without
     one, the stored index is clamped against the live count exactly as before —
     a stored 31 against a 20-segment Foray must not mark the whole running order
     as heard. */
  const index = at.drift === DRIFT_DROPPED
    ? -1
    : (Number.isInteger(at.index) ? at.index : clampIndex(record.index, maxIndex));
  if (elapsed < MIN_RESUME_SEC) return null;
  if (elapsed > total - NEAR_END_SEC) {
    return { elapsedSec: elapsed, index, remainingSec: 0, percent: 100, finished: true, drift: at.drift };
  }
  return {
    elapsedSec: elapsed,
    index,
    remainingSec: total - elapsed,
    percent: percentDone(elapsed, total),
    finished: false,
    drift: at.drift,
  };
}

/**
 * What the stored row means against the running order as it exists now.
 *
 * Exported because it is the whole freshness rule and deserves to be tested
 * directly rather than only through `resumePoint`'s five return fields.
 *
 * Nothing here can throw on a malformed live order or a hand-edited row: a
 * document that changed under a listener is the ordinary case, and the worst
 * allowed outcome is a clamped clock.
 *
 * Leans on one invariant it does not enforce: a segment id appears AT MOST ONCE
 * in a Foray. `tools/foray/check-forays.mjs` fails CI on a repeat, so a reprise
 * of the same segment is not authorable today; if that ever changes, `findIndex`
 * below silently prefers the first occurrence.
 *
 * @param {object} record
 * @param {Array<{id: ?string, startSec: number, durationSec: number}>|null} segments
 * @returns {{ drift: string, elapsedSec?: number, index?: number }}
 */
export function reconcileSegment(record, segments) {
  /* NOT filtered. `index` below is returned as a LIVE index and is used to paint
     the running order, so it has to count positions in the caller's own array —
     filtering first would shift every index after a malformed entry and hand back
     a confident wrong row. A list with no usable entry at all is "no live order". */
  const live = Array.isArray(segments) ? segments : null;
  if (!live || !live.some(isSegmentDescriptor)) return { drift: DRIFT_UNVERIFIED };
  if (!isProgressRecord(record)) return { drift: DRIFT_UNVERIFIED };
  const storedId = nonEmpty(record.segment_id) ? record.segment_id : null;
  if (!storedId) return { drift: DRIFT_UNANCHORED };

  const at = live.findIndex((s) => isSegmentDescriptor(s) && s.id === storedId);
  if (at < 0) return { drift: DRIFT_DROPPED };

  const into = isNum(record.into_sec) && record.into_sec > 0 ? record.into_sec : 0;
  /* Clamped one second INSIDE the segment, not to its boundary. Landing exactly
     on the boundary is the next segment's start, so `segmentAtElapsed` would pick
     index+1 while `index` here says `at` — the painted row and the seek would
     disagree by one for the one case where the segment got shorter. */
  const room = Math.max(0, live[at].durationSec - DRIFT_TOLERANCE_SEC);
  const elapsedSec = live[at].startSec + Math.min(into, room);
  const unmoved = record.index === at
    && Math.abs(elapsedSec - record.elapsed_sec) <= DRIFT_TOLERANCE_SEC;
  return { drift: unmoved ? DRIFT_EXACT : DRIFT_MOVED, elapsedSec, index: at };
}

function isSegmentDescriptor(s) {
  return Boolean(
    s && typeof s === "object" &&
    isNum(s.startSec) && s.startSec >= 0 &&
    isNum(s.durationSec) && s.durationSec >= 0
  );
}

/** -1 ("we do not know") is a legal answer and must survive the clamp; anything
    past the live end becomes -1 rather than the last segment, because "the whole
    thing is behind you" is a stronger claim than the stale row can support. */
function clampIndex(index, maxIndex) {
  if (!Number.isInteger(index) || index < 0) return -1;
  if (!Number.isInteger(maxIndex) || maxIndex < 0) return index;
  return index > maxIndex ? -1 : index;
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
 * MEDIA MINUTES, NOT WALL MINUTES, and that is a decision rather than an omission
 * (recorded 2026-08-17 with the speed control, #242). At 2x this says "42 min
 * left" for 21 minutes of the listener's time. Left as media time on purpose:
 *
 *   - It describes the CONTENT remaining in the Foray, which is a stable property
 *     of the stored row. The speed is a property of a session that has not
 *     happened yet, and the listener may well change it again.
 *   - Dividing by the current rate would make the home rail's label move when a
 *     listener changed speed somewhere unrelated, and would make the same Foray
 *     read differently for two people who are equally far through it.
 *   - Everything else stored here is media time for the same reason: `elapsed_sec`
 *     and `into_sec` are content seconds, which is what lets a resume land on the
 *     same audio whatever speed either session used.
 *
 * Revisit only with a founder: "how much is left" adjusted for speed is a real
 * choice some apps make, and it is a product call, not a rounding one.
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
    /** Writes this store attempted and was refused. See `save()`. */
    this.refusedWrites = 0;
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
  save({
    forayId, title, elapsedSec, totalSec, index = -1,
    segmentId = null, intoSec = 0, force = false, now = new Date(),
  }) {
    if (!nonEmpty(forayId) || !isNum(elapsedSec) || !isNum(totalSec) || totalSec <= 0) return false;
    const last = this._lastWritten.get(forayId);
    if (!force && last != null && Math.abs(elapsedSec - last) < this.everySec) return false;
    const ok = writeProgress(this.storage, makeProgress({
      forayId, title, elapsedSec, totalSec, index, segmentId, intoSec, now,
    }));
    if (ok) this._lastWritten.set(forayId, elapsedSec);
    /* A refused write is COUNTED, not shrugged at. `writeProgress` returns false
       and the caller is a 4 Hz render loop that cannot usefully react, so the
       evidence has to live somewhere a human or a test can reach: this counter
       plus the injected store's own `health()`. "Silently forgot you" is the
       defect; a zero here is the claim that it did not happen. */
    else this.refusedWrites += 1;
    return ok;
  }

  /** How many writes this store has been refused. Non-zero means the listener's
      place is not being recorded — see the note in `save()`. */
  get failedWrites() { return this.refusedWrites; }

  clear(forayId) {
    clearProgress(this.storage, forayId);
    this._lastWritten.delete(forayId);
  }
}
