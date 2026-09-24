/* Playback position persistence (#26).

   Corner case #17: "position save must be so reliable that yanking the phone
   off BT and pocketing it loses <= 15s." That is the whole bar.

   Local is authoritative. Sync rides the existing cp_events pipeline (PR #13)
   rather than inventing a second write path — the manager calls save() on every
   savePosition effect plus its own 15s timer, and both land here.

   ── Where "local" is (#40) ────────────────────────────────────────────────
   It used to be `localStorage`, referenced directly. Browsers evict that, and a
   position that survives pocketing the phone but not next Tuesday only clears
   half of corner case #17. The store is injected now — `player/client.js` hands
   in `player/durable-store.js` (IndexedDB, localStorage kept as a mirror) and
   the default stays `localStorage` so nothing breaks where the better option is
   unavailable. A refused write is counted rather than swallowed; see `save()`.
*/

/** One row per episode. `cp_` prefix: renaming wipes user state (CLAUDE.md).
    Exported because the native engine writes the same key (NE-10j's `rows`
    family records it, and `player/engine-contract.js` OWNED_PREFIXES names
    the namespace the engine owns on iOS). */
export const positionKey = (id) => `cp_pos:${id}`;
const KEY = positionKey;

/** Positions inside this margin of the end mean "finished" — resuming 4 seconds
    before the outro is worse than starting over. */
export const NEAR_END_SEC = 30;
/** Below this, there is nothing worth resuming to. */
export const MIN_RESUME_SEC = 10;
/** A position event (the cp_events row) goes out at most this often per item,
    in media seconds. */
export const POSITION_EVENT_EVERY_SEC = 60;

/* ── The rules, as pure functions (NE-08) ─────────────────────────────────
   The class below is storage glue; what it DECIDES is here, so the native
   engine's ResumeRules port (NE-09) can be checked against the same answers.
   player/position-store.test.js asserts these through the `resume-rules`
   fixture family (player/parity/fixtures/resume-rules/), which is also the
   Swift side's test list: one file is both. Each function is the class's old
   inline code with its inputs named; nothing here reads storage or a clock. */

/**
 * The row `save` writes, or null when there is nothing to write: no id, or a
 * seconds value that is not a finite, non-negative number.
 * @param {string} id
 * @param {number} seconds
 * @param {object} [meta]  `{duration}`; a non-number duration is stored as null
 * @param {string} updatedAt  ISO timestamp (the caller's clock, not ours)
 */
export function positionRow(id, seconds, meta = {}, updatedAt) {
  if (!id || typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  // The row's shape has ONE builder, makePositionRecord (NE-10j, below), whose
  // bytes the `rows` family pins. This adds only the gate and takes the caller's
  // timestamp as given; overwriting an existing key keeps the field order.
  return { ...makePositionRecord(seconds, { duration: meta.duration }), updated_at: updatedAt };
}

/**
 * What to resume a stored row at. "We stored 4 seconds" and "resume at 4
 * seconds" are different questions: under MIN_RESUME_SEC there is nothing worth
 * resuming to, and inside NEAR_END_SEC of the end the episode is effectively
 * finished. The caller's duration wins; the row's own stands in for it.
 * @param {object|null} record  a row as `load` returns it
 * @param {object} [opts]  `{duration}`
 */
export function resumeOffsetFor(record, { duration = null } = {}) {
  if (!record) return 0;
  if (record.seconds < MIN_RESUME_SEC) return 0;
  const dur = duration ?? record.duration;
  if (dur && record.seconds > dur - NEAR_END_SEC) return 0; // effectively finished
  return record.seconds;
}

/**
 * The once-a-minute position-event rule. Don't emit an event on every 15 s
 * tick — that would be ~240 rows/hour per listener. Emit at most once every
 * POSITION_EVENT_EVERY_SEC media seconds per item (and always when nothing, or
 * 0, was emitted before); the local write is what actually protects the user.
 * @param {number|undefined} lastEmitted  the seconds of this item's last event
 * @param {number} seconds    the position being saved
 * @param {number|null} duration
 * @returns {{mark:number, seconds:number, duration:number|null}|null}
 *   null = no event; else the event (`seconds` rounded) and the new `mark`
 *   to remember as this item's last-emitted position (unrounded)
 */
export function positionEvent(lastEmitted, seconds, duration) {
  const last = lastEmitted ?? 0;
  if (!(seconds - last >= POSITION_EVENT_EVERY_SEC || last === 0)) return null;
  return { mark: seconds, seconds: Math.round(seconds), duration };
}

/**
 * The stored row, built in one place (NE-10j). It is a pure function so the
 * row's exact bytes can be recorded: the native engine writes `cp_pos:<id>`
 * too (plan §4.6, "positions survive switching engines"), and a Swift writer
 * that orders these four fields differently, or prints `3600` as `3600.0`,
 * would be a second definition of the row that no JS test ever sees. The
 * `rows` parity family pins `JSON.stringify` of this, through `save()`.
 *
 * @param {number} seconds  already validated by the caller (`positionRow`)
 * @param {object} [opts]
 * @param {*}      [opts.duration]  anything; only a finite number survives,
 *                                  everything else is stored as null
 * @param {Date}   [opts.now]
 */
export function makePositionRecord(seconds, { duration = null, now = new Date() } = {}) {
  return {
    seconds,
    duration: typeof duration === "number" && Number.isFinite(duration) ? duration : null,
    updated_at: now.toISOString(),
    source: "local",
  };
}

export class PositionStore {
  /**
   * @param {object} [opts]
   * @param {Function} [opts.onSave] (id, seconds, meta) — used to emit a
   *   cp_events row. Injected so this module never imports app.js.
   * @param {Storage} [opts.storage] any Storage-shaped object; defaults to
   *   `localStorage` where one exists, and to nothing where it does not (a
   *   browser that has taken storage away is not a crash).
   * @param {Function} [opts.now] () => Date, the row's `updated_at` clock.
   *   Injected only so the parity recorder can write down a row's exact bytes
   *   (NE-10j); every shipping caller leaves it as the wall clock.
   */
  constructor({ onSave = null, storage = null, now = () => new Date() } = {}) {
    this._onSave = onSave;
    this._now = now;
    this._lastEmitted = new Map();
    this._storage = storage ?? (typeof localStorage !== "undefined" ? localStorage : null);
    /** Writes this store attempted and was refused. A non-zero value means
        positions are not being recorded — the one number that distinguishes
        "nothing to resume" from "we forgot". */
    this.refusedWrites = 0;
  }

  save(id, seconds, meta = {}) {
    // positionRow gates and builds (through makePositionRecord); the clock is
    // the injected one, so the rows recorder can still fix `updated_at`.
    const record = positionRow(id, seconds, meta, this._now().toISOString());
    if (!record) return;
    const { duration } = record;
    if (!this._storage) { this.refusedWrites += 1; return; }
    try {
      this._storage.setItem(KEY(id), JSON.stringify(record));
    } catch (_) {
      // Storage full or blocked. Losing a position is bad but not worth
      // throwing into the player's effect loop — so it is counted instead of
      // being swallowed, which is the difference #40 is about.
      this.refusedWrites += 1;
      return;
    }

    // At most one event a minute per item (`positionEvent`); the local write
    // above is what actually protects the user.
    if (this._onSave) {
      const event = positionEvent(this._lastEmitted.get(id), seconds, duration);
      if (event) {
        this._lastEmitted.set(id, event.mark);
        try { this._onSave(id, event.seconds, { duration: event.duration }); } catch (_) {}
      }
    }
  }

  load(id) {
    if (!id || !this._storage) return null;
    try {
      const raw = this._storage.getItem(KEY(id));
      if (!raw) return null;
      const r = JSON.parse(raw);
      if (typeof r?.seconds !== "number" || !Number.isFinite(r.seconds)) return null;
      return r;
    } catch (_) {
      return null;
    }
  }

  /** What the manager should actually resume to. Distinct from load() because
      "we stored 4 seconds" and "resume at 4 seconds" are different questions. */
  resumeOffset(id, { duration = null } = {}) {
    return resumeOffsetFor(this.load(id), { duration });
  }

  clear(id) {
    try { this._storage?.removeItem(KEY(id)); } catch (_) {}
    this._lastEmitted.delete(id);
  }
}
