/* Playback position persistence (#26).

   Corner case #17: "position save must be so reliable that yanking the phone
   off BT and pocketing it loses <= 15s." That is the whole bar.

   Local is authoritative. Sync rides the existing cp_events pipeline (PR #13)
   rather than inventing a second write path — the manager calls save() on every
   savePosition effect plus its own 15s timer, and both land here.
*/

const KEY = (id) => `cp_pos:${id}`;

/** Positions inside this margin of the end mean "finished" — resuming 4 seconds
    before the outro is worse than starting over. */
const NEAR_END_SEC = 30;
/** Below this, there is nothing worth resuming to. */
const MIN_RESUME_SEC = 10;

export class PositionStore {
  /**
   * @param {object} [opts]
   * @param {Function} [opts.onSave] (id, seconds, meta) — used to emit a
   *   cp_events row. Injected so this module never imports app.js.
   */
  constructor({ onSave = null } = {}) {
    this._onSave = onSave;
    this._lastEmitted = new Map();
  }

  save(id, seconds, meta = {}) {
    if (!id || typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return;
    const duration = typeof meta.duration === "number" && Number.isFinite(meta.duration) ? meta.duration : null;
    const record = {
      seconds,
      duration,
      updated_at: new Date().toISOString(),
      source: "local",
    };
    try {
      localStorage.setItem(KEY(id), JSON.stringify(record));
    } catch (_) {
      // Storage full or blocked. Losing a position is bad but not worth
      // throwing into the player's effect loop.
      return;
    }

    // Don't emit an event on every 15s tick — that would be ~240 rows/hour per
    // listener. Emit at most once a minute per item; the local write is what
    // actually protects the user.
    if (this._onSave) {
      const last = this._lastEmitted.get(id) ?? 0;
      if (seconds - last >= 60 || last === 0) {
        this._lastEmitted.set(id, seconds);
        try { this._onSave(id, Math.round(seconds), { duration }); } catch (_) {}
      }
    }
  }

  load(id) {
    if (!id) return null;
    try {
      const raw = localStorage.getItem(KEY(id));
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
    const r = this.load(id);
    if (!r) return 0;
    if (r.seconds < MIN_RESUME_SEC) return 0;
    const dur = duration ?? r.duration;
    if (dur && r.seconds > dur - NEAR_END_SEC) return 0; // effectively finished
    return r.seconds;
  }

  clear(id) {
    try { localStorage.removeItem(KEY(id)); } catch (_) {}
    this._lastEmitted.delete(id);
  }
}
