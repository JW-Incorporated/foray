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
   * @param {Storage} [opts.storage] any Storage-shaped object; defaults to
   *   `localStorage` where one exists, and to nothing where it does not (a
   *   browser that has taken storage away is not a crash).
   */
  constructor({ onSave = null, storage = null } = {}) {
    this._onSave = onSave;
    this._lastEmitted = new Map();
    this._storage = storage ?? (typeof localStorage !== "undefined" ? localStorage : null);
    /** Writes this store attempted and was refused. A non-zero value means
        positions are not being recorded — the one number that distinguishes
        "nothing to resume" from "we forgot". */
    this.refusedWrites = 0;
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
    const r = this.load(id);
    if (!r) return 0;
    if (r.seconds < MIN_RESUME_SEC) return 0;
    const dur = duration ?? r.duration;
    if (dur && r.seconds > dur - NEAR_END_SEC) return 0; // effectively finished
    return r.seconds;
  }

  clear(id) {
    try { this._storage?.removeItem(KEY(id)); } catch (_) {}
    this._lastEmitted.delete(id);
  }
}
