/* The field record (#264) — LOCAL ONLY, and that is the design, not a phase one.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Two founder reports came out of a car in one evening and neither carried a
 * single number, so each one restarted the diagnosis: #224 has been escalated,
 * downgraded on one clean test, and re-escalated on a failure. Five changes have
 * shipped into the seam and transport area — #227, #235, #239, #260, #266 — and
 * not one has a field measurement. #239's 20 s hidden-load deadline was derived
 * from a simulator loading a LOCAL BUNDLED FILE, which does not bound a cold
 * cross-origin fetch on cellular. We have been tuning constants against an
 * instrument we know is unrepresentative.
 *
 * The player already emits everything needed. `player/client.js`'s telemetry hook
 * threw all of it away at a three-word regex (`/error|rejected|skipped/`) and sent
 * the survivors to `console.warn` — which its own comment calls "a console line
 * nobody has open", true of a phone in a car.
 *
 * ── WHY IT DOES NOT TRANSMIT ───────────────────────────────────────────────
 * #264's original text said the `cp_events` pipeline has a consent gate. IT DOES
 * NOT: `trySyncEvents()` is called unconditionally at `app.js:664` and `:686`,
 * and there is no opt-in anywhere in `app.js` or `client.js`. Seam durations, load
 * timings and visibility transitions are a materially richer record of a person's
 * listening than what that pipeline already carries, so routing them through an
 * ungated transport would increase what is collected without consent. Wyatt is
 * currently the only listener; a buffer he can open and copy is 100% of the
 * diagnostic value with none of the exposure. **Nothing here touches `cp_events`
 * or `trySyncEvents`.** Transmission is a separate change behind a real gate and
 * has to be argued on its own.
 *
 * ── WHAT IS RECORDED, AND WHY EACH ONE ─────────────────────────────────────
 * Chosen against the failures we actually have, not for completeness:
 *
 *   `seam`       observedGapMs, cross-episode or not, the deadline in force, and
 *                the last stage reached. The most valuable row in here: it turns
 *                "it stopped" into "the load took 14 s against a 20 s deadline".
 *   `outPoint`   overshoot. Cheap, and a miss costs a median 936.5 s of the wrong
 *                episode.
 *   `stop`       route loss, unexplained pause, the reconcile that lands the
 *                player in #266's `interrupted` state — and which state it landed
 *                in, for the visibility path that can be observed from the page.
 *   `resume`     what was written, what was read back, and which item and offset
 *                it resolved to. The second field report was a WRONG RESUME and
 *                there is no record of what the error path wrote.
 *   `visibility` transitions WITH DURATIONS, so a hidden window can be correlated
 *                with a stall rather than guessed at.
 *   `nowplaying` (L-06) the three strings actually written to the lock screen,
 *                truncated, plus whether the payload reached native at all.
 *                Founder feedback F15 — "it showed only 4a" — had three
 *                indistinguishable explanations and nothing in the record
 *                could separate them.
 *   `session`    (M-03) the native audio-session and app-lifecycle events an
 *                `<audio>` element cannot report: an interruption, a route
 *                change, a media-services reset, background/foreground. F16's
 *                record holds one unexplained stop and no cause, because
 *                until now the page could not see one.
 *   `transport`  (M-03) which surface asked for a play/pause/stop — a tap, a
 *                remote command, our own reconcile, a session event.
 *
 * ── WHAT IS NEVER RECORDED, BY CONSTRUCTION ────────────────────────────────
 * No audio, no URLs, no listener identity. The rule that guarantees it: a
 * telemetry line's TEXT is never stored. Only four things go in —
 *
 *   1. numbers matched by one of the explicit patterns below,
 *   2. authored segment/item ids (already in `cp_foray:` rows; no new identity),
 *   3. STAGE NAMES from a fixed vocabulary (`STAGE_ROOTS`), taken as the leading
 *      dotted token of a message and dropped entirely if unrecognised,
 *   4. ERROR CLASSES on a failed tap (#225) — an `Error`/`DOMException` `.name`
 *      and never a `.message`, admitted by SHAPE (a bare ASCII identifier of at
 *      most `STAGE_NAME_MAX`) rather than by a fixed list, because a `TypeError`
 *      from module skew is exactly the case that needs recording. See
 *      `errorNameOf` for why a shape is safe here and what would break it.
 *
 * ONE EXCEPTION, ARGUED RATHER THAN SLIPPED IN: the `nowplaying` entry stores
 * the three AUTHORED strings the lock screen was given — an episode title, a
 * show name, a Foray title — capped at `NOWPLAYING_FIELD_MAX`. They are
 * catalogue metadata this repo already ships in `data/`, not listener input,
 * and nothing but the strings themselves can separate F15's three
 * explanations. See the block above `nowPlayingFieldOf` for the full pricing,
 * and note that the unified-log half of the same measurement deliberately
 * carries only `title=y artist=n`, because that channel leaves the device.
 *
 * So `audio.error code=4 src=https://cdn.example/…` stores `code=4` and the stage
 * `audio.error`, and the URL — which `html-audio-backend.js`'s `short()` truncates
 * to 60 characters and could therefore still carry a query token — never reaches
 * this record at all. `player/diagnostic-log.test.js` pins that in both
 * directions.
 *
 * ── IT MUST SURVIVE THE THING IT MEASURES ──────────────────────────────────
 * A page suspended mid-seam is exactly when the record matters, so every write is
 * durable AT THE MOMENT OF THE EVENT rather than flushed on unload. `save()` goes
 * through `DurableStore.setItem`, whose localStorage tier is written
 * SYNCHRONOUSLY (`durable-store.js` `_writeSync`) before the call returns.
 *
 * And every entry carries a MONOTONIC SEQUENCE NUMBER and a wall clock, because
 * the iOS probe learned the hard way that it needs both: its record ended 976 ms
 * after audio resumed and could not separate "time stopped" from "writes stopped"
 * until a sequence-numbered save was added (`tools/mobile/probe/probe-seam.js`,
 * §"SAVE CADENCE"). Be honest about the limit, as that file was made to be: seq
 * and wall are serialised into the SAME blob, so a page cannot record that its own
 * later write failed to persist. What the pair buys is CADENCE — seq against
 * elapsed wall says whether writes were landing or already stuttering before the
 * record ends — and, uniquely here, seq SURVIVES EVICTION: `entries[0].seq > 1`
 * with `dropped > 0` is the difference between "the ring wrapped" and "the log
 * restarted".
 *
 * ── BOUNDED ────────────────────────────────────────────────────────────────
 * `DIAG_CAP` entries, OLDEST FIRST. A 32-segment Foray produces ~31 seams and one
 * `outPoint` each, so 200 entries is roughly three complete Forays. Oldest-first
 * and not head-capped, for the reason the probe's `saveTrail` comment gives: a
 * head cap drops the NEWEST, which is the end of the window and the whole point.
 * Stages inside a seam are capped separately (`STAGE_CAP`) so one pathological
 * seam cannot make a single entry unbounded.
 *
 * ── THE COST, STATED HONESTLY ──────────────────────────────────────────────
 * `html-audio-backend.js:1534` carries the warning in its own words: a telemetry
 * sink that writes localStorage synchronously sits on the hidden, throttled,
 * seam-critical path.
 *
 * THE COST IS NOT FLAT, and an earlier draft of this comment claimed it was.
 * `save()` re-serialises the WHOLE ring and runs once per stage of the seam in
 * flight — 8 to 15 times per seam — so the per-write cost grows with how much is
 * already recorded, and is therefore HIGHEST at the end of a long drive, which is
 * the case #224 is about. That is the wrong direction for a cost to grow in, so it
 * is bounded by arithmetic rather than waved at: `DIAG_CAP` 200 entries, about half
 * of them ~130-byte `outPoint` rows, and `STAGE_CAP` 12 capping a seam row near 900
 * bytes — so a full ring is roughly 100 KB serialised per write, against a seam
 * that happens about every 100 seconds. `STAGE_CAP` came down from 24 to halve it.
 *
 * WHAT IS NOT NEGOTIABLE IS THE PER-STAGE WRITE ITSELF. Debouncing would be the
 * cheap fix and it would break the requirement: every stage of a seam is a separate
 * point at which the page can be suspended, and a stage that was not written is a
 * stage the record cannot report. The whole value of an unstarted seam is the trail
 * it left.
 *
 * Two things DO hold flat. Nothing is recorded per `timeupdate` — the tick is 4 Hz
 * and is not a diagnostic. And `save()` NEVER THROWS: a failing write is counted
 * into `saveErrors` and rides out on the next one, so diagnostics cannot become the
 * outage.
 *
 * Pure by construction: no `localStorage`, `document` or `Date` of its own.
 * Everything is injected, which is what makes the failure paths testable.
 */

/** The one key this record lives under. `cp_`-prefixed like everything else, so
    `DurableStore` owns it, "Delete my data" enumerates it, and CI's key-inventory
    check (`test/data-deletion.test.js`) demands a privacy-policy §1 row for it. */
export const DIAG_KEY = "cp_diag";

/** Entries kept, oldest evicted first. See §"Bounded" above. */
export const DIAG_CAP = 200;

/**
 * Stages kept per seam, oldest dropped first.
 *
 * 12, not 24, and the number is a cost decision as much as a bound. A healthy seam
 * produces about seven stages; twelve keeps the tail of a load that is thrashing
 * `waiting`/`stalled`, which is all a reader needs from one. It was 24, and review
 * did the arithmetic that brought it down — see the cost note above.
 */
export const STAGE_CAP = 12;

/** The serialised record's shape version, so a reader can tell an old blob from
    a corrupt one instead of guessing. */
export const DIAG_VERSION = 1;

/* ---------- the ring ---------- */

/**
 * A bounded, sequence-numbered, durable-on-write record.
 *
 * `record()` returns the entry it appended, and that entry is the LIVE object in
 * the ring — a caller may keep mutating it (a seam accumulates stages for
 * seconds) and call `save()` to re-persist. That is what makes a stall leave a
 * record saying how far it got, instead of leaving nothing at all.
 *
 * Holding a reference into a ring that evicts is safe here by arithmetic rather
 * than by a guard: a seam contributes two entries, so `DIAG_CAP` would have to
 * turn over ~100 seams inside one seam's lifetime for an open entry to be
 * evicted under its owner.
 */
export class DiagnosticLog {
  constructor({
    storage = null, key = DIAG_KEY, cap = DIAG_CAP, now = () => Date.now(),
  } = {}) {
    this.storage = storage;
    this.key = key;
    this.cap = Number.isInteger(cap) && cap > 0 ? cap : DIAG_CAP;
    this._now = now;
    this._entries = null;
    this._seq = 0;
    this._dropped = 0;
    this.saveErrors = 0;
    this.loadError = null;
    /* THE TWO THINGS A CLEAR MUST NOT ERASE (founder record, 2026-09-23).
       `_cleared` is where and when the ring was last emptied — `seq` is kept
       across a clear so a wrapped ring stays distinguishable from a cleared one,
       and until this field existed the header printed that kept counter as
       `recorded 939` beside `entries 0` and `dropped 0` with nothing to say WHY,
       which read as a broken instrument. `_build` is the running build's stamp,
       held OUTSIDE the ring: the build row is one entry like any other and a
       clear took it with the rest, so the record's second line fell back to
       "unknown (no build row yet)" on a page that knew its build perfectly well.
       Both are persisted in the blob and restored by `_load`, and neither is
       user data. */
    this._cleared = null;
    this._build = null;
    /* WRITES BEFORE HYDRATION ARE HELD IN MEMORY (review, 2026-09-23). The
       store behind this ring adopts the durable tier's copy of a key only if
       nothing wrote that key first (`durable-store.js`, property 2), and
       `client.js`'s wait on hydration is BOUNDED at five seconds. So a durable
       read that was merely slow -- a cold Capacitor Preferences `readAll` over
       the bridge, not a hang -- met a boot row already written, skipped the
       durable ring as dirty, and pushed the fresh one-row ring down over it:
       the sweep case `preferencesTier` exists for lost the older ring, and the
       only trace was `storage=not-hydrated`. (The same held on main for any
       row written before hydration: a play press at two seconds was the first
       writer just the same.) So while the store says it has not hydrated, an
       entry goes into the ring in memory -- `read()` shows it, the sheet shows
       it -- and its `save()` is DEFERRED; `flush()` re-reads the store once
       hydration has landed (the adopted ring, if there was one), puts the
       buffered rows after it, and writes once. A store that reports no
       hydration state at all (a plain `Storage`, the tests' fakes) defers
       nothing. `_forced` is the give-up: `client.js` sets it long after the
       bound, so a tier that truly hung still gets the rows into localStorage
       -- the documented trade, at a distance a slow read cannot reach. */
    this._buffered = [];
    this._pendingSave = false;
    this._forced = false;
    this._loadedUnhydrated = false;
  }

  /** Whether persistence is being held for hydration -- see the constructor. */
  _deferring() {
    if (this._forced) return false;
    return this._describeStore().hydrated === false;
  }

  /**
   * Write what was held. Called by `client.js` when hydration lands (and, with
   * `force`, when it has waited long enough to call the tier hung); also by
   * `record()` before every write, so a write after hydration carries the
   * buffered rows with it even if nobody called this. Returns whether a write
   * was made.
   *
   * THE RE-READ IS THE FIX. Between the buffered write and now the store may
   * have adopted the durable tier's ring -- the one the buffered write would
   * have overwritten -- so the ring is read again from the store and the
   * buffered rows go AFTER it, renumbered to continue its sequence (the
   * entries are the same live objects a caller may still hold). The running
   * build is kept over the disk's older one; the clear mark and the drop count
   * are the disk's, which is the truth about the ring being written over.
   */
  flush({ force = false } = {}) {
    if (force) this._forced = true;
    if (!this._pendingSave || this._deferring()) return false;
    if (this._loadedUnhydrated && this._buffered.length) {
      const buffered = this._buffered;
      const build = this._build;
      this._entries = null;
      this._buffered = [];
      this._loadedUnhydrated = false;
      const entries = this._load();
      if (build) this._build = build;
      for (const e of buffered) {
        e.seq = ++this._seq;
        entries.push(e);
      }
      while (entries.length > this.cap) { entries.shift(); this._dropped += 1; }
    }
    this._buffered = [];
    this._loadedUnhydrated = false;
    this._pendingSave = false;
    return this.save();
  }

  /**
   * Read what is already on disk, once.
   *
   * LAZY, DELIBERATELY, AND THIS IS THE ONE ORDERING THAT CAN LOSE A RECORD.
   * `client.js` builds this at module evaluation, before `storage.hydrate()` has
   * pulled the IndexedDB tier up into memory. Reading then sees the localStorage
   * copy ONLY — and the case where the two differ is precisely the case that
   * matters: Safari clears script-writable storage after about seven days without
   * a visit, so localStorage is empty and the durable tier holds the record. A log
   * that had already read `[]` would then overwrite that durable copy with a fresh
   * short ring on its very next write.
   *
   * So nothing reads here until something is recorded, and `client.js` defers even
   * the `boot` row until `storageReady` resolves. (An earlier draft called
   * `diag.boot()` at module scope and had exactly the bug above.)
   *
   * A previous session's entries are KEPT. The founder listens in a car and opens
   * the app later; a log that cleared itself on load would be empty exactly when
   * it is read.
   */
  _load() {
    if (this._entries) return this._entries;
    this._entries = [];
    /* Read before the store had hydrated: what is read now is the localStorage
       copy only, and `flush()` reads again once the durable one may have been
       adopted. */
    this._loadedUnhydrated = this._describeStore().hydrated === false;
    let raw = null;
    try { raw = this.storage ? this.storage.getItem(this.key) : null; } catch (_) { raw = null; }
    if (!raw) return this._entries;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.entries)) {
        for (const e of parsed.entries) {
          /* `wall` AND `seq` ARE CHECKED, not only `type`, because one bad row used
             to poison the whole record permanently. `lineFor` formats
             `new Date(e.wall)`, which throws a RangeError on a missing or
             non-numeric clock — so the report threw, the surface said "the record
             could not be read", `save()` faithfully rewrote the bad row, and the only
             way out was Clear, which discards the evidence. A row that cannot be
             rendered is not a row; dropping it keeps every other row readable. */
          if (!e || typeof e !== "object") continue;
          if (typeof e.type !== "string") continue;
          if (!Number.isFinite(e.wall) || !Number.isFinite(e.seq)) continue;
          this._entries.push(e);
        }
      }
      if (Number.isInteger(parsed?.dropped) && parsed.dropped >= 0) this._dropped = parsed.dropped;
      this._cleared = clearedMarkOf(parsed?.cleared);
      this._build = buildStampOf(parsed?.build);
      /* Continue the sequence rather than restarting it. `seq` is the only field
         that can distinguish "the ring wrapped" from "the log was cleared", and
         restarting at 1 would erase that distinction on every reload. Taken as
         the max of the stored counter and the highest entry, so a truncated blob
         cannot hand out a number twice. */
      let top = Number.isInteger(parsed?.seq) ? parsed.seq : 0;
      for (const e of this._entries) if (Number.isInteger(e.seq) && e.seq > top) top = e.seq;
      this._seq = top;
    } catch (err) {
      /* A corrupt blob is not a reason to lose the instrument. Start clean and
         SAY SO in the record, so a reader is never left wondering whether an
         empty log means "nothing happened". */
      this._entries = [];
      this.loadError = String(err?.message ?? err).slice(0, 120);
    }
    return this._entries;
  }

  get entries() { return this._load(); }
  get dropped() { this._load(); return this._dropped; }
  get seq() { this._load(); return this._seq; }
  /** Where the ring was last emptied — `{ seq, wall }` — or null if never. */
  get cleared() { this._load(); return this._cleared; }
  /** The running build's stamp, or null until `setBuild` has been told it. */
  get build() { this._load(); return this._build; }

  /**
   * Remember which build this is, outside the ring.
   *
   * Sanitised here by the same shape rules as the `build` ROW, so the header
   * can print it without a second check. Returns what was kept. Persisted on
   * the next save rather than right now: the stamp arrives asynchronously and
   * always beside a `build` row, so a save is already on its way, and a page
   * whose ring is empty must not gain a `cp_` key for a stamp alone — see
   * `clear()` on why the key's absence is load-bearing after "Delete my data".
   */
  setBuild(stamp) {
    this._load();
    this._build = buildStampOf(stamp);
    return this._build;
  }

  /** Append one entry and persist immediately. Returns the live entry. */
  record(type, fields = {}) {
    /* A write after hydration landed carries whatever was held before it. */
    this.flush();
    const entries = this._load();
    /* THE FRAME LAST, so no caller field can overwrite it. Spread first and a stray
       `wall` or `seq` in `fields` silently replaces the two values every ordering,
       eviction and cadence claim in this file rests on. Nothing collides today, which
       is the only reason this was not already a bug. */
    const entry = { ...fields, seq: ++this._seq, wall: this._now(), type: String(type) };
    entries.push(entry);
    if (this._deferring()) this._buffered.push(entry);
    while (entries.length > this.cap) {
      const gone = entries.shift();
      this._dropped += 1;
      const held = this._buffered.indexOf(gone);
      if (held >= 0) this._buffered.splice(held, 1);
    }
    this.save();
    return entry;
  }

  /**
   * The whole record: what is serialised, plus WHERE it lives.
   *
   * `key` and `store` are the two facts a reader needs when the counters and the
   * ring disagree — "939 recorded, 0 here" is only diagnosable if the header can
   * say which key was read and which tiers hold it. They are read-side only:
   * `save()` writes `_blob()`, so a store's description never persists into the
   * store it describes.
   */
  read() {
    return { ...this._blob(), key: this.key, store: this._describeStore() };
  }

  /** What `save()` writes. */
  _blob() {
    const entries = this._load();
    return {
      v: DIAG_VERSION,
      cap: this.cap,
      seq: this._seq,
      dropped: this._dropped,
      /* Where the ring was last emptied, so a reader can reconcile `seq` with
         `entries` + `dropped` instead of being handed a contradiction. */
      cleared: this._cleared,
      /* The running build, kept across `clear()` — see the constructor. */
      build: this._build,
      saveErrors: this.saveErrors,
      loadError: this.loadError,
      /* An ISO stamp at the TOP LEVEL, and it is load-bearing rather than
         decorative: `durable-store.js`'s `isNewer` reads `updated_at`/`updatedAt`/
         `ts` to decide a hydration conflict, and a record with no stamp falls to
         "local wins" — which would discard the durable copy after a localStorage
         eviction. */
      updatedAt: new Date(this._now()).toISOString(),
      entries: entries.slice(),
    };
  }

  /**
   * Persist now, synchronously.
   *
   * NEVER THROWS. A `setItem` that fails is counted and the count rides out on
   * the next save that lands — the probe's lesson, and the reason
   * `durable-store.js` refuses to let its own health record become an outage.
   * Storage faults are deliberately NOT recorded as entries: `client.js`'s
   * `onFault` sink already writes an event, and a diagnostic that logged its own
   * failed write would be a feedback loop rather than a measurement.
   */
  save() {
    if (!this.storage) return false;
    if (this._deferring()) {
      /* Held, not lost: `flush()` writes it once the store has hydrated, or
         once `client.js` gives up waiting -- see the constructor. */
      this._pendingSave = true;
      return false;
    }
    try {
      this.storage.setItem(this.key, JSON.stringify(this._blob()));
      return true;
    } catch (_) {
      this.saveErrors += 1;
      return false;
    }
  }

  /**
   * Which tiers the store behind this record has, and whether it has hydrated —
   * for the header, when the ring and the counters disagree. A plain `Storage`
   * (tests, a page with no durable store) has no `health()`, and that is
   * reported as such rather than guessed. Total: a throwing `health()` reads as
   * unknown, because a diagnostics read must never be the outage.
   */
  _describeStore() {
    const s = this.storage;
    if (!s) return { tiers: [], hydrated: null };
    if (typeof s.health !== "function") return { tiers: ["storage"], hydrated: null };
    try {
      const h = s.health();
      const tiers = h && h.tiers && typeof h.tiers === "object" ? Object.keys(h.tiers) : [];
      return { tiers, hydrated: typeof h?.hydrated === "boolean" ? h.hydrated : null };
    } catch (_) {
      return { tiers: [], hydrated: null };
    }
  }

  /**
   * Empty it, and REMOVE THE KEY rather than write an empty record.
   *
   * Two callers, and the second one is why it removes. The first is the founder's
   * "clear, drive, copy" loop — a buffer holding three earlier drives makes the
   * drive under test hard to find. The second is `stopForDataDeletion()`: "Delete
   * my data" purges the tiers, and a log that answered by writing `entries: []`
   * back would put a `cp_` key on a device a listener had just asked to be
   * emptied. Memory is cleared too, or the next `record()` would resurrect every
   * entry the purge removed.
   *
   * `seq` is NOT reset, so a cleared log stays distinguishable from a wrapped
   * one: `entries[0].seq > 1` with `dropped === 0` means "cleared". And since
   * 2026-09-23 the clear is WRITTEN DOWN as `cleared: { seq, wall }` rather than
   * left for a reader to infer from that arithmetic: the founder's record that
   * day read `recorded 939 · entries 0 · dropped 0` and nothing on it said the
   * ring had been emptied, so it was read as an instrument that had lost its
   * rows. The build stamp (`_build`) is kept too — a clear empties the RECORD,
   * not the page's knowledge of which build it is running.
   */
  clear() {
    this._load();
    this._cleared = { seq: this._seq, wall: this._now() };
    this._entries = [];
    this._dropped = 0;
    this.loadError = null;
    /* A clear is the listener's word, and it removes the key at once: nothing
       held for hydration outlives it, and the ring read after it is this one. */
    this._buffered = [];
    this._pendingSave = false;
    this._loadedUnhydrated = false;
    if (!this.storage) return;
    try { this.storage.removeItem(this.key); } catch (_) { this.saveErrors += 1; }
  }

  /**
   * "Delete my data": empty it AND forget that there was anything to empty
   * (round-2 audit, persist-5).
   *
   * `clear()` keeps the sequence and writes the clear down on purpose — for the
   * founder's clear-drive-copy loop, where "recorded 939, cleared at #939" is the
   * point. A deletion is the opposite case. This used to share `clear()`, so the
   * next background transition wrote `cp_diag` back carrying the pre-deletion row
   * count and the exact time of the deletion, on a device the sheet had just
   * called clear. Here the counter, the dropped count and the mark all go. The
   * build stamp stays: it is the running page's own build, not the listener's.
   */
  forget() {
    this.clear();
    this._seq = 0;
    this._dropped = 0;
    this._cleared = null;
    this.loadError = null;
  }
}

/* ---------- reading the player ---------- */

/** The leading dotted token of a telemetry message, when its root is one this
    module recognises. Everything else — including every word of prose and every
    URL — is dropped. This is the whole of the "no raw text" rule. */
const STAGE_ROOTS = new Set([
  "audio", "backend", "event", "foray", "gesture", "handover", "item", "load",
  "outPoint", "play", "player", "prefetch", "queue", "rate", "reconcile",
  "restore", "resume", "seam", "seek", "transitionTTS",
]);

/** Media events worth a stage. `timeupdate` is deliberately absent: it fires at
    4 Hz and is not a diagnostic. */
export const MEDIA_STAGES = new Set(["playing", "waiting", "stalled", "ended"]);

const STAGE_NAME_MAX = 48;

/**
 * The stage name a message contributes, or null.
 *
 * Split on whitespace, COLON and EQUALS, and all three separators are
 * load-bearing against real emitters:
 *
 *   whitespace  `prefetch.ready sb at 500s — …`     -> `prefetch.ready`
 *   colon       `player.error: media error 4`        -> `player.error`
 *   equals      `rate.set=1.5 (was 1)`               -> `rate.set`
 *
 * Without the colon, `player.error:` carries a trailing punctuation mark, fails
 * the character check below and the stage is DROPPED — so the most important line
 * in the stream would contribute nothing. Without the equals, the same happens to
 * `queue.built.SINGLE_ITEM.n=2`, `restore.index=…` and `play.ignored.noItemAt=0`.
 * Cutting at the separator keeps the name and drops the value, which is the rule:
 * a stage name is a vocabulary word, never data.
 */
export function stageOf(message) {
  const head = String(message ?? "").trim().split(/[\s:=]/, 1)[0] ?? "";
  if (!head || head.length > STAGE_NAME_MAX) return null;
  if (!/^[A-Za-z][A-Za-z0-9.]*$/.test(head)) return null;
  const root = head.split(".", 1)[0];
  return STAGE_ROOTS.has(root) ? head : null;
}

/** The two things a failed tap can be, and the page is the only side that knows
    which. A start got nowhere; a control failed over audio that is still going.
    `app.js`'s two guards carry exactly this distinction (#225), and a value from
    anywhere else is normalised to `start` rather than stored. */
const TAP_PHASES = new Set(["start", "control"]);

/**
 * A value as text, or `""` when it refuses to become text.
 *
 * `String(v)` runs `v.toString()`, which a broken or hostile object can make
 * throw — and both callers below run inside `app.js`'s failure guards, where a
 * throw is the outage this record exists to explain. COERCE ONCE, HERE: every
 * sanitiser below binds the result to a local and tests THAT, so a `toString`
 * returning a different value on each call cannot pass a check with one string
 * and be stored as another. Review found exactly that hole in the first draft of
 * `tapFailed`, which tested `String(phase)` and then stored `String(phase)` a
 * second time.
 */
function asText(v) {
  try { return String(v ?? ""); } catch (_) { return ""; }
}

/** The phase, normalised to the vocabulary. Exported so the rule is testable on
    its own rather than only through an entry, and so the one-coercion property
    above has somewhere to be pinned. */
export function tapPhaseOf(phase) {
  const p = asText(phase);
  return TAP_PHASES.has(p) ? p : "start";
}

/**
 * An error's CLASS, or null.
 *
 * `.name` and never `.message`. A `.name` answers the only question this record
 * is asked — was the browser refusing, or did the code break — while a `.message`
 * carries prose and URLs, and this record gets pasted into issues. Same rule
 * `knownCar` above enforces, applied before the value is stored rather than after.
 *
 * A SHAPE RULE, NOT A CLOSED VOCABULARY, and the distinction is worth stating
 * because the shape is weaker: `DOMException.name` really is a closed set, but
 * this accepts any ASCII identifier of up to `STAGE_NAME_MAX`. That is deliberate
 * — a `TypeError` from module skew is exactly the case #225 needs to see, and it
 * is not in any list worth maintaining. It is safe because no production path
 * assigns a data-derived `.name`: every throw reaching here is a first-party or
 * platform error. A caller that ever sets `.name` from a URL, a title or an id
 * would defeat it, so that is the line not to cross.
 *
 * Underscore but no dot: an error name is one identifier, so the dotted form a
 * stage name allows would mean something got through that is not a name.
 *
 * `trim()` BEFORE the anchored test, and the order matters: a trailing newline
 * would otherwise be the classic way past a `$`.
 */
export function errorNameOf(name) {
  const n = asText(name).trim();
  if (!n || n.length > STAGE_NAME_MAX) return null;
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(n) ? n : null;
}

/* Every number this record holds comes through one of these. Formats the iOS CI
   probe already reads (`tools/mobile/probe/probe-seam.js`), so they are as much
   a contract as anything untyped in this repo gets — and
   `player/diagnostic-record.test.js` drives the REAL player through a REAL seam,
   so a format change reddens a suite rather than silently emptying the record. */
const RE = {
  outPoint: /^outPoint\.reached target=(-?[\d.]+) at=(-?[\d.]+) overshoot=(-?[\d.]+)s/,
  itemEnded: /^item\.ended\.outPoint (\S+)@(\d+)s/,
  seamArmed: /^seam\.gap\.armed ([\d.]+)s beat: (\S+) -> (\S+)/,
  seamHold: /^seam\.gap\.hold (\d+)ms/,
  seamCut: /^seam\.gap\.cut\.([A-Za-z0-9_]+)/,
  deadline: /^load\.deadline (\d+)ms \((hidden|visible)\) for (\S+)/,
  sameSource: /^load\.sameSource (\S+) -> (\d+)s/,
  externalStop: /^reconcile\.externalStop why=(\S+)/,
  /* The other direction (2026-09-22, founder report 1): the element was playing
     while the machine said paused — a lock-screen or car press WebKit honoured
     without this page. Matched, and only the trigger token captured. */
  externalPlay: /^reconcile\.externalPlay why=(\S+)/,
  unexpectedPause: /^audio\.pausedUnexpectedly/,
  /* The element's own state at an unexplained pause (founder report 2). Each
     field is optional so a line from before 2026-09-22 still records a row. */
  elementTime: /\bt=(-?[\d.]+)/,
  elementReady: /\brs=(\d)/,
  elementNetwork: /\bns=(\d)/,
  elementError: /\berr=(\d+)/,
  audioError: /^audio\.error code=(\S+)/,
  playRejected: /^play\.rejected (\S+)/,
  /* Matched, never CAPTURED — see the handler. The route name is a device a person
     named, and it must not reach a record that gets pasted into an issue. */
  knownCar: /^route\.autoResume\.knownCar=/,
  restore: /^restore\.index=(\d+)\.position=(\d+)s/,
  queueEnded: /^queue\.ended/,
};

const num = (s) => { const n = Number(s); return Number.isFinite(n) ? n : null; };

/* ---------- the `data` entry's vocabulary (FD-01) ----------

   The same discipline as `STAGE_ROOTS` and `errorNameOf`: nothing reaches the
   record unless it is a member of a fixed set or matches a shape that cannot
   carry prose. Exported so `diagnostic-log.test.js` can pin the rule directly. */

/** When the entry was written. `stale-shell` is the web's worker refusing a fresh
    document to a page running last-known code — the same fact from the other
    side, recorded the same way. */
export const DATA_PHASES = new Set(["boot", "refresh", "stale-shell"]);
/** Where a document came from. `sw-cache` is the web's pinned generation. */
export const DATA_SOURCES = new Set(["bundle", "cache", "network", "sw-cache"]);
/** The three documents, in the pointer's own vocabulary. */
export const DATA_FILE_KEYS = ["forays", "segments", "sources"];

/* ---------- L-06: what was sent to the lock screen ----------

   THE ONE PLACE THIS RECORD HOLDS AUTHORED PROSE, AND IT IS A DELIBERATE
   EXCEPTION TO §"What is never recorded", NOT AN OVERSIGHT.

   Founder feedback F15: the lock screen and the car showed only "4a". Three
   explanations produce that symptom and they are indistinguishable from
   outside — a narration line with no `nextItem` and an empty Foray title (the
   old `mediaMetadata()` then emitted "4a" as BOTH title and artist), an item
   whose own `title`/`show` are empty, or a payload that never reached
   `MPNowPlayingInfoCenter` at all (WebKit's default Now Playing is the app
   name, which is also "4a"). Nothing but the three strings themselves can
   separate the first two, so the three strings are recorded.

   THE EXPOSURE, PRICED. What enters the record is catalogue metadata —
   episode titles, show names, the Foray's own title — all of which are
   already public, authored strings that this repo ships in `data/`. It is not
   listener input, not a URL, not a route name. `NOWPLAYING_FIELD_MAX` caps
   each at 40 characters, which is about what a car head unit renders anyway,
   so a long title is truncated to roughly what the founder was looking at.
   Everything else about the payload is a flag or a number.

   The unified-log half deliberately does NOT carry them: `ForayAudioPlugin.swift`
   logs `title=y artist=n album=y` and nothing more, because that channel is
   uploaded as a CI artifact. Two channels, two exposures, and the field
   content only crosses the lower one. */

/** Each of title/artist/album, capped. 40 rather than 60 because the question
    is "was this field empty, and did it say what we think it said" — a car
    display's own limit, and an answer that does not need the whole string. */
export const NOWPLAYING_FIELD_MAX = 40;

/** The three writes a `nowplaying` row can stand for. See `nowPlaying()`. */
export const NOWPLAYING_VIA = new Set(["metadata", "state", "clear"]);

/** One Now Playing field: trimmed, capped, and `""` for anything that is not a
    string. `null` is NOT returned for a missing field, because the empty
    string IS the finding here — an absent field and an empty one are the same
    defect from a lock screen, and `lineFor` renders both as `—`. */
export function nowPlayingFieldOf(v) {
  const s = asText(v).trim();
  return s.length > NOWPLAYING_FIELD_MAX ? `${s.slice(0, NOWPLAYING_FIELD_MAX - 1)}…` : s;
}

/* ---------- M-03: why did it stop? ----------

   The native side of the record. `ForayAudioPlugin.swift` and
   `ForayTtsPlugin.swift` observe `AVAudioSession`'s interruption, route-change
   and media-services-reset notifications plus `UIApplication`'s
   background/foreground, and raise one `session` event each. This is the
   vocabulary those events are admitted against — the same closed-set
   discipline `STAGE_ROOTS` and `DATA_PHASES` already keep, for the same
   reason: an event arrives from native code and must not be able to put a
   sentence, a device name or a URL in a record the founder pastes into an
   issue.

   AN UNRECOGNISED KIND IS DROPPED, not stored as "unknown". A record that
   invented a row for an event it could not name would be worse than a gap:
   the gap is readable as "this build's plugin says something this build's
   page does not understand", which is a real and findable condition. */

/** What a native plugin may report. Mirrors the `kind` strings in
    `ForayAudioPlugin.swift`/`ForayTtsPlugin.swift`'s `emitSession` calls.

    THE LAST THREE ARE THINGS THE PLUGIN DID, not things the OS did to it
    (founder, 2026-09-23: "paused and turned off my screen, got in my car, then
    my car resumed Spotify"). iOS hands a car's play to the app that still holds
    an active playback session and a Now Playing entry; `ForayAudioPlugin.swift`
    now takes the app's own session when the transport pauses and re-asserts the
    Now Playing entry when the app is backgrounded, and each of those is a row
    here — so a drive that still resumed Spotify can say whether 4a had let go
    (no row) or was holding on and lost anyway (rows, then Spotify). */
export const SESSION_KINDS = new Set([
  "interruptionBegan", "interruptionEnded", "routeChange", "mediaServicesReset",
  "background", "foreground",
  "sessionActivated", "sessionReleased", "nowPlayingReasserted",
]);

/** Where a remote command physically arrived (founder, 2026-09-23). One token
    per door: iOS has two — the plugin's `MPRemoteCommandCenter` (`command-center`;
    whatever pressed it — the lock screen, Control Center, CarPlay, a Bluetooth
    stack and a headphone pinch are indistinguishable there) and WebKit's OWN
    `MediaSession` (`webkit`), which the shim tees the page's handlers onto
    because WebKit publishes a Now Playing entry of its own for every `<audio>`
    element; Android has two, Media3's session and the notification's own
    buttons. */
export const REMOTE_ORIGINS = new Set(["command-center", "webkit", "media-session", "notification"]);

/** Which of the platform's commands it was, BEFORE the plugin mapped it onto a
    page action. Kept beside the action because the mapping is the finding:
    a `toggle-play-pause` that became `play` on a playing transport is the bug
    where a car's one button could pause nothing. Dashed tokens, so both
    natives spell them the same way — and the SHIM translates for the doors
    that name a press by its spec action instead (`REMOTE_COMMAND_FOR_ACTION`
    in `foray-media-session.js`: WebKit's tee and Android's Media3 sink both
    said `nexttrack`, which this set does not hold, so every skip through those
    doors was a row `remoteCommand` dropped). `shell-invariants.test.mjs` pins
    the translation's range into this set. */
export const REMOTE_COMMANDS = new Set([
  "play", "pause", "toggle-play-pause", "stop", "next-track", "previous-track",
  "skip-backward", "skip-forward", "change-position", "close",
]);

/** Which plugin spoke. Two producers, because a narration line and a tape
    segment are silenced through different objects and a record that could not
    tell them apart would answer "the audio stopped" when the question is
    "which audio". */
export const SESSION_PRODUCERS = new Set(["audio", "tts", "page"]);

/** M-03(b). Where a play or a pause came from. The founder's F16 record shows
    a stop with no cause; half of "no cause" is that nothing ever recorded
    which surface asked for the state the player was in when it stopped. */
export const TRANSPORT_SOURCES = new Set(["tap", "remote", "reconcile", "session", "restore"]);
/* `play-restored` joined these on 2026-09-22, and its absence is why a bug cost
   two field records. `setRunning`'s restored branch logged
   `diag.transport(source, "play-restored")` for the first press on a ribbon
   restored at launch — the one press that loads the audio — and `transport()`
   returns null for an action not in this set, so the row was DROPPED. The press
   then threw (`play(item, null)`), and the founder's record showed four
   `play from tap` rows and no first press at all. The vocabulary being closed is
   right; a caller emitting a word that is not in it and being silently ignored
   is not, and `test/diagnostics-surface.test.js` now pins the two together. */
export const TRANSPORT_ACTIONS = new Set(["play", "pause", "stop", "play-restored"]);

/** A status, a trigger, a validation code: a lower-case dashed token, never a
    sentence. `sha256-forays`, `segment-missing`, `foreground` all pass; a reason
    with a space or a slash in it does not. */
/* ---------- which build wrote this (founder report 3, 2026-09-22) ----------

   `player/build-stamp.js` reads the two numbers; this is where they are admitted
   (by shape, the same as every other field here) and printed. */
const buildTokenOf = (v) => {
  const s = typeof v === "number" && Number.isFinite(v) ? String(v) : asText(v).trim();
  return /^[0-9][0-9.]{0,31}$/.test(s) ? s : null;
};
const deployTokenOf = (v) => {
  const s = asText(v).trim().toLowerCase();
  return /^[0-9a-f]{8,64}$/.test(s) ? s : null;
};

/** A build stamp by shape — the `build` row's four fields and nothing else — or
    null for anything that is not an object. A function declaration rather than
    a `const`, because `DiagnosticLog._load` above calls it and this file's
    class comes before its helpers. */
function buildStampOf(v) {
  if (!v || typeof v !== "object") return null;
  return {
    shell: v.shell === true,
    web: deployTokenOf(v.web),
    native: buildTokenOf(v.native),
    version: buildTokenOf(v.version),
  };
}

/** The clear mark `clear()` writes, by shape: a non-negative integer `seq` and
    a finite wall clock, or null. A corrupt mark reads as "never cleared", which
    is the direction that makes the header's gap line FIRE rather than hide. */
function clearedMarkOf(v) {
  if (!v || typeof v !== "object") return null;
  if (!Number.isInteger(v.seq) || v.seq < 0 || !Number.isFinite(v.wall)) return null;
  return { seq: v.seq, wall: v.wall };
}

export function dataTokenOf(v) {
  const s = asText(v).trim();
  return /^[a-z][a-z0-9-]{0,47}$/.test(s) ? s : null;
}

/** A deploy id, or `unknown`. `generate-manifest.mjs` writes short hex; the shape
    admits a tagged id too, and nothing with a space, a slash or a query. */
export function dataVersionOf(v) {
  const s = asText(v).trim();
  if (s === "unknown") return s;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s) ? s : null;
}

/** An authored Foray id — the same class of identifier `cp_foray:` rows carry. */
export function dataIdOf(v) {
  const s = asText(v).trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(s) ? s : null;
}

/** `source@version`, or `absent`. Rebuilt from its two halves rather than trusted,
    so a caller cannot smuggle text through the tag. */
export function dataFileTagOf(v) {
  const s = asText(v).trim();
  if (s === "absent") return s;
  const at = s.indexOf("@");
  if (at < 0) return null;
  const source = s.slice(0, at);
  const version = dataVersionOf(s.slice(at + 1));
  return DATA_SOURCES.has(source) && version ? `${source}@${version}` : null;
}

/**
 * Turns the player's telemetry stream and a handful of page events into entries.
 *
 * Stateful in exactly one way: it holds the SEAM CURRENTLY IN FLIGHT, because a
 * seam is not one line — it is a boundary, a beat, a load with a deadline, and an
 * item becoming audible, spread over seconds and across two files. Everything
 * else is recorded and forgotten.
 */
export class PlayerDiagnostics {
  constructor({ log, now = () => Date.now(), isHidden = () => false } = {}) {
    this.log = log;
    this._now = now;
    /* Wrapped, because a surface's throwing `isHidden` must not be able to stop
       the record — `html-audio-backend.js`'s `_loadDeadlineMs` guards the same
       call for the same reason. */
    this._hidden = isHidden;
    /** The open seam entry, or null. */
    this._seam = null;
    /** The reconcile stop awaiting its landed state — see `reconciled()`. */
    this._stop = null;
    /** The failed-tap entry THIS INSTANCE opened and is still counting into, or
        null. Identity, never shape — see `tapFailed` for the session-crossing
        defect that reading the ring's tail produced. */
    this._lastTap = null;
    /** The `media` row THIS INSTANCE opened and is still counting into — the
        same identity rule as `_lastTap`, for `waiting`/`stalled` runs. */
    this._lastMedia = null;
    /** When the current visibility state began, for the DURATION half of a
        visibility transition — a hidden window is only correlatable with a stall
        if its length is known.
        STAMPED IN THE CONSTRUCTOR, not in `boot()`: the boot ROW waits for
        hydration (see `_load`), and a listener who backgrounds the page inside that
        window would otherwise get a transition with no duration on it. Recording
        nothing yet costs nothing — this is a clock, not a write. */
    this._visSince = now();
  }

  _isHidden() {
    try { return this._hidden() === true; } catch (_) { return false; }
  }

  /** Write what the ring held for hydration -- `DiagnosticLog.flush`. `client.js`
      calls it when hydration lands and, with `force`, when it stops waiting. */
  flush(opts = {}) {
    try { return this.log.flush(opts); } catch (_) { return false; }
  }

  /** Called once, after storage has hydrated, so the record says when the page
      loaded and in what visibility state. The clock this is measured against was
      already started in the constructor — see `_visSince`. */
  boot({ hydrated = null } = {}) {
    /* `hydrated` is whether the durable store had finished hydrating when this
       row was written (2026-09-23). `client.js` waits for hydration, but the
       wait is now BOUNDED — a durable tier that never answers used to hold the
       boot row, the build row and the visibility listener hostage forever, and
       a record that stopped at the storage layer's first hang was a record with
       nothing in it. `false` here means the page wrote before the store had been
       fully read, which is the one case where an older durable copy of this
       ring can have been superseded; null is a caller that did not say. */
    const row = { hidden: this._isHidden() };
    if (typeof hydrated === "boolean") row.hydrated = hydrated;
    return this.log.record("boot", row);
  }

  /**
   * Which build this boot is (founder report 3, 2026-09-22): the web deploy id
   * and, in the shell, the native build number and version. One row per boot,
   * written when the answer arrives (it is asynchronous — a file read and a
   * native call), so a ring that spans an app update says which rows came from
   * which build. An unknown half is null, never a guess; the row is written
   * even when both are unknown, because "this build could not say" is itself
   * the finding a reader needs.
   */
  build({ web = null, native = null, version = null, shell = false } = {}) {
    /* Kept on the log as well as in the ring (2026-09-23): the row is history —
       which rows came from which build — and the log's copy is the running
       build, which a `clear()` must not take with the rows. The header reads
       the log's copy first, so it can name the build on a record with no rows. */
    const stamp = this.log.setBuild({ shell, web, native, version });
    return this.log.record("build", { ...stamp });
  }

  /* ---------- telemetry ---------- */

  /** One line from the player. Every line is offered; most contribute a stage to
      the seam in flight and nothing else. */
  note(message) {
    const m = String(message ?? "");
    let handled = false;

    let hit = RE.outPoint.exec(m);
    if (hit) {
      /* The overshoot entry and the seam are SEPARATE rows on purpose. An
         out-point also fires at the end of the last segment, where no seam
         follows, and folding the two would make the final boundary look like a
         seam that never completed. */
      this.log.record("outPoint", {
        targetSec: num(hit[1]), atSec: num(hit[2]), overshootSec: num(hit[3]),
        hidden: this._isHidden(),
      });
      this._openSeam("outPoint");
      handled = true;
    }

    hit = RE.itemEnded.exec(m);
    if (hit) {
      const seam = this._openSeam("itemEnded");
      seam.fromId = hit[1];
      seam.fromEndSec = num(hit[2]);
      handled = true;
    }

    hit = RE.seamArmed.exec(m);
    if (hit) {
      /* AN OPENER. The out-point normally opens the seam a beat later, but a file
         that runs OUT before its authored `end_sec` emits no `outPoint.reached` at
         all, and the element's `ended` listener registered by `client.js` fires
         AFTER the backend's own — so the arming line reaches this record first. */
      const seam = this._openSeam("seamArmed");
      seam.askedGapMs = Math.round(num(hit[1]) * 1000);
      seam.fromId = hit[2];
      seam.toId = hit[3];
      handled = true;
    }

    hit = RE.seamHold.exec(m);
    if (hit && this._seam) { this._seam.holdMs = num(hit[1]); handled = true; }

    hit = RE.seamCut.exec(m);
    if (hit && this._seam) {
      /* A CUT BEAT ENDS THE SEAM. This used to only stamp `cutBy` and leave the row
         open, and that was wrong in three compounding ways. `_cutSeamGap` fires from
         `_transport` for pause, next, previous, reconcile and dispose, so an ordinary
         pause inside the seam beat left an open seam, and then:
           1. the listener's own ten-minute pause was measured as
              `observedGapMs: 600000` by the next `playing` — and that number became
              the report's `worst` and dragged its median, which are the two headline
              numbers this whole change exists to produce;
           2. never resuming left the row reading NEVER STARTED, a manufactured
              failure on a perfectly healthy drive;
           3. `_openSeam` returns an already-open seam, so the NEXT real boundary
              overwrote this row's ids, deadline and asked gap — collapsing two
              boundaries into one row and under-counting the seams.
         `observedGapMs` stays null, `cutBy` says what ended it, and the report counts
         a cut seam separately from a stall: a listener pressing pause is not a defect
         and must not read as one. */
      this._seam.cutBy = hit[1];
      this._closeSeam("seam.gap.cut." + hit[1], null);
      handled = true;
    }

    hit = RE.deadline.exec(m);
    if (hit && this._seam) {
      /* ANNOTATES, NEVER OPENS, and this is not a detail. Every load emits a
         deadline — including the FIRST one, which is a listener pressing play and
         not a seam at all. An opener here manufactured a phantom seam per Foray
         with `fromId: null`, measured the press-to-audio latency into it, and
         inflated every count in the report's summary. A seam is a BOUNDARY between
         two items; only a boundary may open one. */
      const seam = this._seam;
      seam.deadlineMs = num(hit[1]);
      seam.deadlineFor = hit[2];
      /* THE CROSS-EPISODE ANSWER, and it is derived rather than assumed. A fresh
         fetch names the ITEM here; the same-source shortcut names its seek
         (`seek->1234s`) because the source was never re-pointed. #239's 20 s
         deadline is a claim about the first kind only, and 15 of Foray #1's 31
         seams are the second — so a record that could not tell them apart would
         average the two and answer neither. */
      if (/^seek->/.test(hit[3])) {
        if (seam.crossEpisode == null) seam.crossEpisode = false;
      } else {
        seam.crossEpisode = true;
        seam.toId = hit[3];
      }
      handled = true;
    }

    hit = RE.sameSource.exec(m);
    if (hit && this._seam) {
      // Annotates, never opens — see `RE.deadline` above.
      const seam = this._seam;
      seam.crossEpisode = false;
      seam.toId = hit[1];
      seam.toStartSec = num(hit[2]);
      handled = true;
    }

    hit = RE.externalStop.exec(m);
    if (hit) {
      /* Left with `state: null` for the caller to fill — see `reconciled()`. The
         line is emitted BEFORE the reducer runs, so the state at this instant is
         still `playing` and stamping it here would record a fact that is about to
         stop being true. */
      this._stop = this.log.record("stop", {
        source: "reconcile", why: hit[1], state: null, hidden: this._isHidden(),
      });
      handled = true;
    }

    hit = RE.externalPlay.exec(m);
    if (hit) {
      /* A PLAY THIS PAGE DID NOT MAKE. Recorded as a `transport` row from the
         `reconcile` source so it sits in the same column as every other play:
         a record of a drive where the car resumed the audio now says so,
         instead of showing a stop followed by sound nobody explains. */
      this.transport("reconcile", "play");
      handled = true;
    }

    if (RE.unexpectedPause.test(m)) {
      /* FOUNDER REPORT 2 (2026-09-22): eight of these, all `hidden=y`, and the
         record could not tell them apart. Three fields that can: HOW LONG the
         page had been hidden (a suspension happens on a clock, an interruption
         does not), and the element's `readyState`/`networkState`/`error` at the
         pause (see `html-audio-backend.js`'s `_elementFingerprint`). Absent
         fields are null, never zero — zero is a real `readyState`. */
      this.log.record("stop", {
        source: "element", why: "pausedUnexpectedly", state: null, hidden: this._isHidden(),
        hiddenForMs: this._hiddenForMs(),
        atSec: num(RE.elementTime.exec(m)?.[1]),
        readyState: num(RE.elementReady.exec(m)?.[1]),
        networkState: num(RE.elementNetwork.exec(m)?.[1]),
        errorCode: num(RE.elementError.exec(m)?.[1]),
      });
      handled = true;
    }

    hit = RE.audioError.exec(m);
    if (hit) {
      /* The CODE and not the source. `short()` truncates the URL to 60 characters
         but cannot promise those 60 carry no query token, and this record is
         copied out of the app by hand. */
      this.log.record("stop", {
        source: "element", why: `audio.error.code=${hit[1]}`, state: null, hidden: this._isHidden(),
      });
      handled = true;
    }

    hit = RE.playRejected.exec(m);
    if (hit) {
      this.log.record("stop", {
        source: "autoplay", why: `play.rejected.${hit[1]}`, state: null, hidden: this._isHidden(),
      });
      handled = true;
    }

    if (RE.knownCar.test(m)) {
      /* THE FACT, NEVER THE NAME. `route.autoResume.knownCar=<name>` carries the
         AUDIO ROUTE's name — a device a person named. This repo's own tests use
         "Some Headphones" and "Civic"; a real one says somebody's first name. That is
         not a number, not an authored segment id and not a stage name, so it is none
         of the three classes this record is allowed to hold — and it would ride out
         of the app inside a report pasted into an issue. Latent rather than live
         today (no JS caller passes a route name yet; the native shells will), which
         is exactly how it would have shipped unnoticed. `known: true` answers the
         diagnostic question — was the route recognised — and says nothing about
         whose it is. */
      this.log.record("stop", {
        source: "route", why: "autoResume.knownRoute", known: true,
        state: null, hidden: this._isHidden(),
      });
      handled = true;
    }

    hit = RE.restore.exec(m);
    if (hit) {
      this.log.record("resume", {
        phase: "restore", wrote: null, index: num(hit[1]), positionSec: num(hit[2]),
      });
      handled = true;
    }

    if (RE.queueEnded.test(m) && this._seam) {
      /* NOT A STALL, and saying so is the difference between a real finding and a
         manufactured one. The probe makes the same distinction for the same
         reason: an out-point at the end of the queue opens a seam that nothing
         will ever close, and a record that left it open would report a failure on
         every healthy Foray. */
      this._seam.endOfQueue = true;
      this._closeSeam("queue.ended", null);
      handled = true;
    }

    this._stage(stageOf(m));
    return handled;
  }

  /* ---------- page and media events ---------- */

  /**
   * A media event worth a stage. `ended` also OPENS a seam: a file that runs out
   * before its authored `end_sec` produces no `outPoint.reached` at all, and that
   * seam is measured exactly like any other.
   */
  mediaEvent(name) {
    const n = String(name ?? "");
    if (!MEDIA_STAGES.has(n)) return false;
    if (n === "ended") this._openSeam("ended");
    if (n === "playing") { this._closeSeam("playing", this._now()); return true; }
    /* A STALL WITH NO SEAM IN FLIGHT IS STILL A STALL (founder report 2,
       2026-09-22). `_stage` writes into the open seam and returns when there is
       none — so on an ordinary episode, the case the founder reported, every
       `waiting` and `stalled` was dropped, and a starvation that ended in the
       page being suspended left no trace before its `stop` row. */
    if (!this._seam && (n === "waiting" || n === "stalled")) {
      this._mediaRow(n);
      return true;
    }
    this._stage(n);
    return true;
  }

  /** One `media` row per RUN of the same event — the `tapFailed` rule: a dead
      zone fires `waiting` again and again, and uncoalesced it would evict the
      very rows that explain it. Identity, never shape, and only while it is
      still the tail. */
  _mediaRow(name) {
    const entries = this.log.entries;
    if (this._lastMedia && this._lastMedia === entries[entries.length - 1] && this._lastMedia.name === name) {
      this._lastMedia.repeated += 1;
      this._lastMedia.lastWall = this._now();
      this.log.save();
      return this._lastMedia;
    }
    this._lastMedia = this.log.record("media", {
      name, repeated: 1, lastWall: null, hidden: this._isHidden(), hiddenForMs: this._hiddenForMs(),
    });
    return this._lastMedia;
  }

  /** How long the page has been hidden right now, or null when it is visible.
      The same clock `visibility()` measures its `forMs` against. */
  _hiddenForMs() {
    if (!this._isHidden() || this._visSince == null) return null;
    return Math.max(0, this._now() - this._visSince);
  }

  /**
   * A transport tap that failed, as seen BY THE PAGE (#225).
   *
   * AN ENTRY, NOT A STAGE, and that is the whole reason this method exists rather
   * than a line pushed through `note()`. `_stage` writes into the seam in flight
   * and returns early when there is none — and the failure #225 is about is a
   * COLD START, where no seam has ever been opened. Routed through `note()` this
   * would have recorded exactly nothing, on precisely the tap the record exists
   * to explain.
   *
   * It does NOT duplicate the element layer. A refused `el.play()` already lands
   * as `stop/autoplay` via `play.rejected`, which is the browser's side of the
   * story. This is the page's side: an exception that came back out of
   * `playForay` and put a message on screen. The two can both be present for one
   * tap, and a reader wants that — it is the difference between "the browser held
   * the audio" and "the module threw before the browser was ever asked".
   */
  tapFailed({ phase = "start", name = null } = {}) {
    const phaseName = tapPhaseOf(phase);
    const error = errorNameOf(name);

    /* A MASHED BUTTON MUST NOT WIPE THE RECORD IT IS TRYING TO EXPLAIN.
       A listener whose play button does nothing presses it again, and again —
       that is the founder's report, in his own words. Uncoalesced, ~200 taps
       (about 40 s at a realistic 5/s) evict every seam row in a 200-entry ring,
       so the record of a failure mid-drive is destroyed by the failure itself.
       Measured before this guard existed: 200 taps against a full ring dropped
       all 200 seam entries. `repeated=37` is also simply better evidence than 37
       identical rows.

       ONLY AN UNBROKEN RUN OF THE SAME FAILURE COALESCES. A different phase or a
       different error class is a different finding and starts a new entry, and
       anything else recorded in between (a stop, a visibility change) ends the
       run — so a coalesced entry always means "this, n times, with nothing else
       happening", which is what makes the count readable.

       `repeated` is written as 1 from the start rather than added on the second
       tap, for the reason §6 of the test suite learned the hard way: a reader
       cannot tell a field that means "once" from a field that was never written.

       IDENTITY, NEVER SHAPE, and this is the correction review forced. A first
       version matched on the tail entry's FIELDS — type, phase, error. The ring is
       durable, so `_load()` restores the previous session's entries verbatim, and a
       failed tap that lands before `boot()` has written its row sees yesterday's
       matching `tapFail` at the tail. Today's taps were folded into yesterday's
       entry, keeping yesterday's clock and sequence number, and the whole of
       today's drive left NO row at all. That is not the exotic case: a play button
       that failed yesterday with `NotAllowedError` and fails again today is
       precisely what this feature is for. `_lastTap` is a reference to an entry
       THIS instance created, so a restored one can never be mistaken for it — and
       it also closes the second head of the same defect, where a restored row
       without `repeated` turned `+= 1` into `NaN`.

       IT MUST STILL BE THE TAIL. A `_lastTap` that something has since been
       recorded after is a run that ended, and folding into it would put a count on
       an entry that no longer describes the last thing that happened.

       WHAT THIS DOES NOT FIX, stated rather than hidden: the write RATE. Each
       repeat still re-serialises the ring (`save()`), so mashing drives ~5
       writes/s against the ~0.15/s this file's cost note argues itself into
       accepting. Bounding that needs a timer, and this module deliberately owns
       none — everything is injected, which is what makes its failure paths
       testable. The exposure is a few seconds of a hand on a dead button, and the
       ring no longer grows during it.

       `seq` DELIBERATELY DOES NOT ADVANCE on a repeat. It counts entries recorded,
       which is what the report's `recorded` means and what its ordering claims rest
       on; a coalesced tap is not a new entry. `lastWall` carries the other half
       instead — see below. */
    const entries = this.log.entries;
    if (this._lastTap
      && this._lastTap === entries[entries.length - 1]
      && this._lastTap.phase === phaseName
      && this._lastTap.error === error) {
      this._lastTap.repeated += 1;
      /* WHEN THE RUN ENDED, because the count alone cannot tell a ten-second mash
         from a listener returning to a dead button four times across five minutes,
         and those are different bugs. The FIRST `wall` stays as the entry's stamp —
         it is the moment the failure began, and it is what keeps this row ordered
         against the seam rows that explain it. */
      this._lastTap.lastWall = this._now();
      this.log.save();
      return this._lastTap;
    }

    this._lastTap = this.log.record("tapFail", {
      phase: phaseName,
      error,
      repeated: 1,
      lastWall: null,
      hidden: this._isHidden(),
    });
    return this._lastTap;
  }

  /**
   * A visibility transition, WITH the length of the state it just left.
   *
   * That duration is the point. #239's hidden deadline and the probe's ~26 s
   * suspension ceiling are both claims about how long a page survives hidden, and
   * neither can be checked against a stall unless the hidden window's length is
   * in the same record as the stall.
   */
  visibility(hidden) {
    const now = this._now();
    const forMs = this._visSince == null ? null : now - this._visSince;
    this._visSince = now;
    return this.log.record("visibility", { to: hidden === true ? "hidden" : "visible", forMs });
  }

  /**
   * The reconcile landed (#266). Fills in the state the telemetry line could not
   * know, for the one path a page can observe: `client.js` awaits
   * `reconcileWithBackend` on becoming visible, so it — and nothing inside the
   * player — is where the resulting state is readable.
   */
  reconciled(why, state) {
    const entry = this._stop;
    if (entry && entry.state == null && entry.why === String(why)) {
      entry.state = state == null ? null : String(state);
      this._stop = null;
      this.log.save();
      return entry;
    }
    return null;
  }

  /* ---------- L-06: what the lock screen was actually told ---------- */

  /**
   * One `setNowPlaying`, as it was sent.
   *
   * Called from `player/media-session.js`'s `onWrite` hook, which fires only
   * when metadata was ACTUALLY assigned to the platform — not on every
   * `syncMediaSession()`. That is what makes an empty stretch of record a
   * finding rather than a gap: a Foray that played for ten minutes with no
   * `nowplaying` row never reached the OS at all, which is the third of F15's
   * three explanations and the one nobody could previously distinguish.
   *
   * `native` is the shim's own verdict, read by the caller from
   * `window.ForayMediaSession.inspect()` — `sends` (how many payloads have
   * crossed the Capacitor bridge this session) and whether the last one came
   * back with a reason. A `nowplaying` row whose `sends` never moves is the
   * same finding stated positively.
   *
   * @param {object} fields
   * @param {object} [fields.metadata] `{ title, artist, album, artwork }`
   * @param {string} [fields.playbackState]
   * @param {object} [fields.native] `{ installed, sends, lastReason }`
   */
  nowPlaying({
    metadata = null, playbackState = null, native = null, writeOk = true, writeError = "", via = "metadata",
  } = {}) {
    const m = metadata && typeof metadata === "object" ? metadata : {};
    const artwork = Array.isArray(m.artwork) ? m.artwork : [];
    return this.log.record("nowplaying", {
      /* WHICH WRITE (founder, 2026-09-23). `metadata` is the three strings
         changing; `state` is `playbackState` changing with the strings as they
         were — the pause, which until now left no row; `clear` is the player
         closing. Anything else is stored as `metadata`, the shape every row
         before this field had. */
      via: NOWPLAYING_VIA.has(via) ? via : "metadata",
      title: nowPlayingFieldOf(m.title),
      artist: nowPlayingFieldOf(m.artist),
      album: nowPlayingFieldOf(m.album),
      /* THE COUNT, NOT THE URL. An artwork `src` is a publisher's CDN URL with
         whatever a query string happens to carry, and this record is pasted
         into issues — the same rule the `audio.error` handler keeps when it
         stores a code and drops the source. The count answers the only
         question a blank square raises: was one offered at all. */
      artworkCount: artwork.length,
      state: dataTokenOf(playbackState) ?? "",
      /* Did the assignment to `navigator.mediaSession.metadata` complete
         (2026-09-21)? Everything above this line describes what we COMPUTED;
         without this the row said nothing about whether it landed, and a record
         could read "5 written, 0 with an empty credit" while the car showed the
         app name. Defaults to true so every existing caller and fixture keeps
         its meaning -- only a caller that KNOWS it failed says so.
         The reason is admitted by shape, like `native.reason` below: an
         exception message is arbitrary text and this record gets pasted into
         issues. */
      writeOk: writeOk !== false,
      writeError: writeOk === false ? (errorNameOf(writeError) ?? "") : "",
      /* The shim's verdict, admitted by SHAPE. `installed` and `sends` are a
         boolean and a number; `lastReason` is an exception message from an
         arbitrary throw, so only an `errorNameOf`-shaped identifier survives
         and prose is dropped. */
      native: native && typeof native === "object"
        ? {
          installed: native.installed === true,
          sends: Number.isFinite(native.sends) ? native.sends : null,
          reason: errorNameOf(native.lastReason),
        }
        : null,
      hidden: this._isHidden(),
    });
  }

  /* ---------- M-03: why did it stop? ---------- */

  /**
   * A native audio-session or app-lifecycle event (M-03, founder feedback F16
   * / #548).
   *
   * The founder's record for that drive holds ONE row — `stop element
   * pausedUnexpectedly` at `hidden=y` — and cannot say why, because the page
   * cannot see any of the things that cause it: an `<audio>` element reports
   * a bare `pause` for a phone call, a Bluetooth disconnect, a Siri
   * invocation and a media-services reset alike. The plugins can see all
   * four. This is where what they saw lands, in the SAME ring as the `stop`
   * row it explains, so the answer is one line above the question.
   *
   * AN UNRECOGNISED `kind` IS DROPPED AND `null` IS RETURNED. `SESSION_KINDS`
   * is the contract with the Swift; a row invented for an event this build
   * cannot name would put an unbounded native string in the record.
   *
   * @param {object} event `{ kind, reason, producer, at }` — the wire shape
   *   `ForayAudioPlugin.swift`'s `sessionEvent(kind:reason:)` writes.
   */
  sessionEvent({ kind = null, reason = null, producer = null, at = null } = {}) {
    const k = asText(kind).trim();
    if (!SESSION_KINDS.has(k)) return null;
    const who = asText(producer).trim();
    /* THE NATIVE CLOCK, KEPT SEPARATELY FROM `wall`. `record()` stamps `wall`
       with the PAGE's clock at the moment the event was handled, and a page
       that was suspended handles a background event late — by exactly the
       interval M-03 is trying to measure. `at` is the plugin's own epoch-ms
       stamp from the moment the notification fired, so the pair is the
       delivery lag, and the lag is itself a finding. */
    const nativeAt = Number.isFinite(at) && at > 0 ? at : null;
    return this.log.record("session", {
      kind: k,
      reason: dataTokenOf(reason) ?? "",
      producer: SESSION_PRODUCERS.has(who) ? who : "audio",
      at: nativeAt,
      lagMs: nativeAt == null ? null : this._now() - nativeAt,
      hidden: this._isHidden(),
      hiddenForMs: this._hiddenForMs(),
    });
  }

  /**
   * WHO asked for this play/pause/stop (M-03(b)).
   *
   * The other half of "why did it stop". A `stop` row says the element
   * stopped; it does not say whether a person pressed something, a car sent a
   * remote command, our own reconcile decided the element was lying, or a
   * session event arrived. Those are four different bugs and the record could
   * not tell them apart.
   *
   * Both fields come from closed sets and an unrecognised one is DROPPED
   * rather than stored — the same rule `sessionEvent` keeps, for the same
   * reason.
   */
  transport(source, action) {
    const s = asText(source).trim();
    const a = asText(action).trim();
    if (!TRANSPORT_SOURCES.has(s) || !TRANSPORT_ACTIONS.has(a)) return null;
    return this.log.record("transport", { source: s, action: a, hidden: this._isHidden() });
  }

  /**
   * A remote command the NATIVE side received, before the page did anything
   * with it (founder, 2026-09-23: "my car resumed Spotify. This is still
   * wrong.").
   *
   * `transport(…, "remote")` above is written by the page's handler, so a
   * command that reached the plugin and found no handler — or reached a
   * WebView too asleep to run one — is invisible there, and "the car's play
   * did nothing" and "the car's play never came" read the same. The shim
   * (`foray-media-session.js`) re-broadcasts every native `transport` event
   * as `foray:remote` with what the plugin saw: the platform's own COMMAND,
   * the page ACTION it was mapped to, which native door it came through, and
   * whether a handler was found. The plugin's own stamp rides beside `wall`,
   * as it does for `sessionEvent`, so the lag says how asleep the page was.
   *
   * `deduped` is the shim's own verdict that this copy of a press was the
   * SECOND door delivering the same action inside its window
   * (`REMOTE_DUPLICATE_WINDOW_MS` in foray-media-session.js) and was dropped —
   * so a lock-screen skip that moved the playhead once while two rows say it
   * arrived twice is the mechanism working, and a skip that moved twice with
   * no `dup=y` row is the window being too short. Read together with `handled`.
   *
   * Every field is admitted by a closed set or by shape, and an unrecognised
   * command or origin is DROPPED, for the reason `sessionEvent` states.
   *
   * @param {object} event `{ command, action, origin, handled, deduped, at }`
   */
  remoteCommand({ command = null, action = null, origin = null, handled = null, deduped = null, at = null } = {}) {
    const c = asText(command).trim();
    const o = asText(origin).trim();
    if (!REMOTE_COMMANDS.has(c) || !REMOTE_ORIGINS.has(o)) return null;
    const nativeAt = Number.isFinite(at) && at > 0 ? at : null;
    return this.log.record("remote", {
      command: c,
      /* The page action is a spec word (`ROUTABLE_ACTIONS`), lower-case letters
         only; anything else is stored as empty rather than as a string from
         native code. */
      action: /^[a-z]{1,24}$/.test(asText(action)) ? asText(action) : "",
      origin: o,
      handled: handled === true,
      deduped: deduped === true,
      at: nativeAt,
      lagMs: nativeAt == null ? null : this._now() - nativeAt,
      hidden: this._isHidden(),
    });
  }

  /* ---------- resume decisions ---------- */

  /** What was WRITTEN as the resume point — or, when `wrote` is false, why
      nothing was. The refusal is the interesting half: the second field report
      was a wrong resume, and the path that declines to write is the path with no
      record of what it did. */
  resumeWrite(fields = {}) {
    return this.log.record("resume", { phase: "write", ...fields });
  }

  /** What was READ BACK and where it resolved to — the requested position in the
      Foray's own clock, and the item and offset it became. */
  resumeStart(fields = {}) {
    return this.log.record("resume", { phase: "start", ...fields });
  }

  /* ---------- search (S-01, docs/search-plan.md) ---------- */

  /**
   * K-01's voice-engine measurement, as one row in the record
   * (`docs/bundled-voice-plan.md` K-01; `player/kokoro-probe.js` owns the
   * arithmetic that produced it).
   *
   * IT GOES IN THE RING RATHER THAN ON A SCREEN OF ITS OWN, and that is the
   * whole reason the card names this surface: the founder already knows how
   * to copy this record out (HUMAN-ACTIONS.md #21), and a second copyable
   * surface would be a second thing to explain over a phone. It is also why
   * the row survives a backgrounded app — `DiagnosticLog` is durable on
   * write, so a probe run with the screen locked is still readable after.
   *
   * THE FIELDS ARE TAKEN, NOT SPREAD. `kokoro-probe.js` already flattened the
   * native payload once; naming the fields again here is what stops a future
   * native addition from silently entering a ring that re-serialises itself
   * on every one of its next 200 writes (see this file's cost note).
   */
  voiceProbe(record = {}) {
    const num = (v) => (Number.isFinite(v) ? v : null);
    return this.log.record("voiceProbe", {
      engine: typeof record.engine === "string" ? record.engine : null,
      probeOk: record.ok === true,
      reason: typeof record.reason === "string" ? record.reason : null,
      provider: typeof record.provider === "string" ? record.provider : null,
      model: typeof record.model === "string" ? record.model : null,
      loadColdMs: num(record.modelLoadColdMs),
      loadWarmMs: num(record.modelLoadWarmMs),
      rtfCold: num(record.rtfCold),
      rtfWarm: num(record.rtfWarm),
      audioSec: num(record.audioSec),
      /* #685. `over 77.4s` read as a measured length and was a planning
         estimate; the RTFs were divided by it while the phone rendered
         nothing. Which of the two it is now travels WITH the number, and the
         synthesis sub-reason with it, because "could not measure" and "could
         not measure because there was no ONNX session" are one re-run apart. */
      audioFrom: typeof record.audioFrom === "string" ? record.audioFrom : null,
      synthReason: typeof record.synthReason === "string" ? record.synthReason : null,
      synthFailures: num(record.synthFailures),
      acceleratorWired: record.acceleratorWired === true,
      peakMemoryMb: num(record.peakMemoryMb),
      lockedOk: record.lockedScreenCompleted === true,
      batteryPct: num(record.batteryDeltaPct),
      hidden: this._isHidden(),
    });
  }

  /**
   * One completed Shows search, once per query — never per keystroke, and
   * never the query text itself.
   *
   * (The comment you are reading was, until the 2026-09-12 client audit,
   * sitting above `voiceProbe()` instead: a K-01 card inserted a function
   * between this JSDoc and the function it documents, and JSDoc has no way to
   * notice. It is back where it belongs.)
   *
   * QUERY LENGTH, NEVER THE QUERY TEXT. `app.js`'s single call site
   * (`recordSearchDiagnostic`) passes `qLen`, not `query`, for the exact
   * reason every other entry in this file admits numbers, ids and stage
   * names and nothing else (see this file's header, "WHAT IS NEVER
   * RECORDED"): a founder's search terms are a materially richer signal
   * about what he listens to than anything else in this record, and this
   * module has no consent-gated transport to carry them even if it wanted
   * to. `Number.isFinite` guards `qLen` the same way every numeric field
   * elsewhere in this file is guarded — a non-numeric value is dropped to
   * `null` rather than stored, so a caller that ever passed the raw string
   * by mistake stores nothing rather than storing the string.
   *
   * `paintedMs` is nullable by design: the local pass paints synchronously
   * (§1.3 measures it at sub-millisecond for 220 shows) so a caller with no
   * paint-timing instrumentation yet, or one measuring only the local half,
   * still gets a valid entry with `paintedMs: null` — "no timing" is a real
   * state here, not an error, matching this record's "absence is a real
   * state" rule everywhere else.
   *
   * THE FIELD NAMES ARE camelCase LIKE EVERY OTHER ENTRY IN THIS FILE, as of
   * the audit. This row shipped in snake_case — `q_len`, `local_ms` — and was
   * the only one, which meant a reader of a pasted record had to know which
   * card wrote which row before they could name a field. One vocabulary.
   *
   * `hidden` for the same reason: it was the only entry omitting it (compare
   * `voiceProbe` directly above), and it is the field that separates "search
   * took 900 ms" from "search took 900 ms in a backgrounded tab whose timers
   * were throttled" — exactly the question a slow-search report asks.
   *
   * THE FOUR SLOW HALVES ARE ALL HERE, and that is the audit's other half:
   *   `netMs`/`netHits`  the breadth (shows) endpoint, or 0 on a cache hit
   *   `dirMs`/`dirHits`  the APPLE DIRECTORY pass (P-02,
   *                      docs/search-parity-plan.md) — a SECOND request to the
   *                      same endpoint carrying `fallthrough=1`, and the
   *                      slowest of the show passes by construction because a
   *                      third party is in it (measured 381-561 ms against
   *                      118 ms for the catalogue pass). It is its own pair of
   *                      fields rather than being folded into `netMs` for the
   *                      reason the audit split the halves in the first place:
   *                      the two fail independently, and "search took 900 ms"
   *                      is a different finding depending on WHICH pass spent
   *                      it. `dirMs` is the field to watch for P-02's
   *                      latency risk — the local paint is unaffected, so a
   *                      directory regression never shows up in `paintedMs`.
   *   `epMs`/`epHits`    the EPISODES endpoint — the slower of the two, and
   *                      until the audit it was measured by nothing at all
   *   `ctaMs`            the create-a-playlist CTA's relaxation scan, a
   *                      1.3-8 s synchronous pass that used to run behind a
   *                      `setTimeout(0)` where no number could see it
   * Null means "this half did not run on this search", which is a real state
   * for all four (a cache hit, a query under the directory's 3-character
   * floor, a page with no episode section, a query that already matched a
   * playlist) and not an error.
   */
  search({
    qLen = null, localMs = null, localHits = null,
    netMs = null, netHits = null, dirMs = null, dirHits = null,
    epMs = null, epHits = null,
    ctaMs = null, paintedMs = null, path = null,
  } = {}) {
    const num = (v) => (Number.isFinite(v) ? v : null);
    return this.log.record("search", {
      qLen: num(qLen),
      localMs: num(localMs),
      localHits: num(localHits),
      netMs: num(netMs),
      netHits: num(netHits),
      dirMs: num(dirMs),
      dirHits: num(dirHits),
      epMs: num(epMs),
      epHits: num(epHits),
      ctaMs: num(ctaMs),
      paintedMs: num(paintedMs),
      path: typeof path === "string" && path.length <= STAGE_NAME_MAX ? path : null,
      hidden: this._isHidden(),
    });
  }

  /**
   * Where the three Foray documents came from (FD-01), and what the directory
   * did about it (FD-03).
   *
   * THE BEFORE-NUMBER every later directory card cites: a Playback-diagnostics
   * copy from a phone has to NAME the source of `forays.json` — bundle, cache or
   * network — and the deploy id it carries. One entry per boot and one per
   * refresh attempt; never per render.
   *
   * Everything here is admitted by SHAPE or by a closed vocabulary, per the header's
   * "no raw text" rule: `phase`/`source` from fixed sets, `status`/`code`/`trigger`
   * as lower-case tokens, `version` as a deploy id, `forayId` as an authored id
   * (class 2 in the header — no new identity), and the per-file tags as
   * `source@version`. A validation REASON — prose naming a file — is deliberately
   * not accepted; the caller sends its `code` instead.
   */
  dataSource({
    phase = null, trigger = null, status = null, source = null, version = null,
    code = null, forayId = null, forays = null, playable = null, ms = null, files = null,
  } = {}) {
    const n = (v) => (Number.isFinite(v) ? v : null);
    const tagged = {};
    if (files && typeof files === "object") {
      for (const k of DATA_FILE_KEYS) {
        const t = dataFileTagOf(files[k]);
        if (t) tagged[k] = t;
      }
    }
    return this.log.record("data", {
      phase: DATA_PHASES.has(phase) ? phase : null,
      trigger: dataTokenOf(trigger),
      status: dataTokenOf(status),
      source: DATA_SOURCES.has(source) ? source : null,
      version: dataVersionOf(version),
      code: dataTokenOf(code),
      forayId: dataIdOf(forayId),
      forays: n(forays),
      playable: n(playable),
      ms: n(ms),
      files: Object.keys(tagged).length ? tagged : null,
      hidden: this._isHidden(),
    });
  }

  /**
   * Forget everything in flight, for a record that has just been emptied.
   *
   * `DiagnosticLog.clear()` removes the ring; this is its other half, and without it
   * `clear()` is unsafe at exactly the moment it was designed for. The documented
   * founder loop is "clear, drive, copy", and the sheet's button is live during
   * playback, so a Clear lands mid-seam — leaving `_seam` pointing at an entry that
   * is no longer in `entries`. Two consequences, both bad: `_openSeam` hands that
   * orphan back for the NEXT boundary, so the first seam after a Clear is written
   * outside the ring and never appears at all; and every `_stage()` on the orphan
   * calls `log.save()`, which puts `cp_diag` back with `entries: []` one tick after
   * `clear()` deliberately removed the key — the precise outcome `clear()`'s own
   * comment claims to avoid.
   *
   * The visibility clock is restamped rather than nulled, so the next transition
   * still carries a duration.
   */
  reset() {
    this._seam = null;
    this._stop = null;
    /* For this method's own reason: a Clear during playback must not leave this
       object pointing at an entry that is no longer in the ring. Without it, the
       next failed tap would increment a counter on an orphan and `save()` it,
       putting a row back under a key a listener has just emptied. */
    this._lastTap = null;
    this._lastMedia = null;
    this._visSince = this._now();
  }

  /* ---------- the seam in flight ---------- */

  _openSeam(opener) {
    if (this._seam) return this._seam;
    /* WRITTEN AT THE BOUNDARY, not when the seam completes. This is the whole
       durability requirement: the load that follows is the thing under suspicion,
       and a record written afterwards is a record that does not exist for the
       failure it was built to explain. An unclosed seam with `observedGapMs:
       null` and a `lastStage` says HOW FAR it got, which is the difference
       between "the beat's timer never fired" and "the load never settled". */
    this._seam = this.log.record("seam", {
      openedBy: String(opener),
      fromId: null, toId: null,
      crossEpisode: null,
      askedGapMs: null, holdMs: null,
      deadlineMs: null, deadlineFor: null,
      observedGapMs: null,
      lastStage: String(opener),
      hiddenAtBoundary: this._isHidden(),
      hiddenAtStart: null,
      endOfQueue: false,
      stages: [],
    });
    return this._seam;
  }

  _stage(name) {
    const seam = this._seam;
    if (!seam || !name) return;
    seam.lastStage = name;
    /* Oldest-first inside the entry too, for `saveTrail`'s reason: the end of the
       window is what says where it stopped. `stagesDropped` so a truncated trail
       cannot read as a short one. */
    seam.stages.push({ stage: name, atMs: this._now() - seam.wall, hidden: this._isHidden() });
    while (seam.stages.length > STAGE_CAP) {
      seam.stages.shift();
      seam.stagesDropped = (seam.stagesDropped ?? 0) + 1;
    }
    this.log.save();
  }

  _closeSeam(stage, playingWall) {
    const seam = this._seam;
    if (!seam) return;
    seam.lastStage = String(stage);
    if (playingWall != null) {
      seam.observedGapMs = playingWall - seam.wall;
      seam.hiddenAtStart = this._isHidden();
    }
    seam.stages.push({ stage: String(stage), atMs: this._now() - seam.wall, hidden: this._isHidden() });
    while (seam.stages.length > STAGE_CAP) {
      seam.stages.shift();
      seam.stagesDropped = (seam.stagesDropped ?? 0) + 1;
    }
    this._seam = null;
    this.log.save();
  }
}

/* ---------- the surface's text ---------- */

const pad = (s, n) => String(s).padEnd(n, " ");
const ms = (v) => (v == null ? "—" : `${Math.round(v)}ms`);
/** Belt to `_load`'s braces. `_load` drops any row with a non-finite `wall`, so this
    should be unreachable — but the report is the only way a founder ever sees any of
    this, and a RangeError here would lose the whole record rather than one row. */
const clockOf = (wall) => {
  try { return new Date(wall).toISOString().slice(11, 23); } catch (_) { return "??:??:??.???"; }
};

/** One entry, as one line a founder can read on a phone. */
function lineFor(e) {
  const head = `#${pad(e.seq, 4)} ${clockOf(e.wall)} ${pad(e.type, 10)}`;
  switch (e.type) {
    case "seam": {
      const kind = e.crossEpisode === true ? "cross-episode"
        : e.crossEpisode === false ? "same-source" : "kind unknown";
      const gap = e.observedGapMs != null ? `gap ${ms(e.observedGapMs)}`
        : e.endOfQueue ? "end of queue"
        : e.cutBy != null ? `cut short by ${e.cutBy}`
        : "NEVER STARTED";
      /* THE TRAIL, and only on a seam that never started, where it is the whole
         answer. `lastStage` alone is not enough: a stop or a reconcile can land
         inside an open seam and become the last thing that happened, so a stalled
         load reads `last=reconcile.externalStop` — which is neither "the beat's
         timer never fired" nor "the load never settled". The tail of the stage trail
         says which, on the one line a founder reads. A completed seam does not need
         it: `gap` and `last=playing` are the answer, and the full trail is in the
         JSON for anyone who wants it. */
      const trail = e.observedGapMs == null && e.endOfQueue !== true && e.cutBy == null
        ? `  trail=${(e.stages ?? []).slice(-5).map((st) => st.stage).join(" > ") || "—"}`
        : "";
      return `${head} ${e.fromId ?? "?"} -> ${e.toId ?? "?"}  ${gap}` +
        `  asked ${ms(e.askedGapMs)}  deadline ${ms(e.deadlineMs)} (${e.deadlineFor ?? "?"})` +
        `  ${kind}  last=${e.lastStage}  hidden=${e.hiddenAtBoundary ? "y" : "n"}` +
        `->${e.hiddenAtStart == null ? "?" : e.hiddenAtStart ? "y" : "n"}${trail}`;
    }
    case "outPoint":
      return `${head} overshoot ${e.overshootSec == null ? "—" : `${e.overshootSec.toFixed(3)}s`}` +
        `  target ${e.targetSec ?? "—"}s  at ${e.atSec ?? "—"}s  hidden=${e.hidden ? "y" : "n"}`;
    case "stop": {
      /* The founder-report-2 fields, only when present, so a row from an older
         build reads exactly as it always did. */
      const extra = [];
      if (e.hiddenForMs != null) extra.push(`hiddenFor ${ms(e.hiddenForMs)}`);
      if (e.atSec != null) extra.push(`at ${e.atSec}s`);
      if (e.readyState != null) extra.push(`rs=${e.readyState}`);
      if (e.networkState != null) extra.push(`ns=${e.networkState}`);
      if (e.errorCode) extra.push(`err=${e.errorCode}`);
      return `${head} ${e.source} ${e.why}  state=${e.state ?? "?"}  hidden=${e.hidden ? "y" : "n"}` +
        (extra.length ? `  ${extra.join(" ")}` : "");
    }
    case "media":
      return `${head} ${e.name}` + (e.repeated > 1 ? ` x${e.repeated}` : "") +
        (e.repeated > 1 && e.lastWall != null ? ` over ${ms(e.lastWall - e.wall)}` : "") +
        `  hidden=${e.hidden ? "y" : "n"}` + (e.hiddenForMs != null ? `  hiddenFor ${ms(e.hiddenForMs)}` : "");
    case "visibility":
      return `${head} -> ${e.to}  after ${ms(e.forMs)}`;
    case "resume": {
      const parts = [e.phase];
      for (const k of ["wrote", "why", "forayId", "index", "segmentId", "elapsedSec",
        "intoSec", "requestedElapsedSec", "seekToSec", "positionSec", "drift"]) {
        if (e[k] != null) parts.push(`${k}=${e[k]}`);
      }
      return `${head} ${parts.join(" ")}`;
    }
    case "boot":
      /* `storage=not-hydrated` only when the row says so: it is the mark of a
         page that wrote after the bounded wait, and a healthy boot prints the
         line it always did. */
      return `${head} hidden=${e.hidden ? "y" : "n"}` + (e.hydrated === false ? "  storage=not-hydrated" : "");
    case "build":
      return `${head} ${buildLabel(e)}`;
    /* FD-01: `data boot forays=cache@9fc92a61 segments=cache@9fc92a61 …` names the
       source of each document on the one surface a founder pastes out. A refresh
       reads `data refresh(foreground) adopted v=… n=6`, or `… invalid why=segment-missing
       foray=…` — the why is a code from a closed vocabulary, never a sentence. */
    case "data": {
      const parts = [`${e.phase ?? "?"}${e.trigger ? `(${e.trigger})` : ""}`];
      if (e.status) parts.push(e.status);
      if (e.source) parts.push(`source=${e.source}`);
      if (e.version) parts.push(`v=${e.version}`);
      if (e.files) for (const k of DATA_FILE_KEYS) if (e.files[k]) parts.push(`${k}=${e.files[k]}`);
      if (e.code) parts.push(`why=${e.code}`);
      if (e.forayId) parts.push(`foray=${e.forayId}`);
      if (e.forays != null) parts.push(`n=${e.forays}`);
      if (e.playable != null) parts.push(`playable=${e.playable}`);
      if (e.ms != null) parts.push(`took ${ms(e.ms)}`);
      return `${head} ${parts.join(" ")}  hidden=${e.hidden ? "y" : "n"}`;
    }
    case "search": {
      /* One line, every field — the doc's own acceptance line names
         paintedMs as the field a probe run must find non-null at least
         once, so it has to be visible on the one surface a founder pastes
         out, not only in the raw JSON. `—` for null fields keeps the line
         legible when a caller has not wired one half yet (e.g. paint timing
         landing in a later card than the network pass), and is also how the
         halves that did not run on this search read.

         `hidden=` at the end like every other line that carries it (2026-09-12
         audit: this was the only case printing none). */
      const n = (v) => (v == null ? "—" : v);
      return `${head} qLen=${n(e.qLen)} local=${ms(e.localMs)}/${n(e.localHits)}h` +
        ` net=${ms(e.netMs)}/${n(e.netHits)}h dir=${ms(e.dirMs)}/${n(e.dirHits)}h` +
        ` ep=${ms(e.epMs)}/${n(e.epHits)}h` +
        ` cta=${ms(e.ctaMs)} painted=${ms(e.paintedMs)}` +
        ` path=${n(e.path)}  hidden=${e.hidden ? "y" : "n"}`;
    }
    /* `error=none` rather than an empty space, because the two are different
       findings: a tap that failed with no error CLASS is a `playForay` that
       returned a rejection carrying nothing, and a reader who sees a blank will
       assume the field was never written. */
    /* `over Ns` is not decoration: `x50` alone cannot separate a hand mashing a
       dead button from a listener coming back to it across five minutes, and those
       are different bugs. */
    /* K-01. ONE LINE, and it has to survive being read aloud over a phone:
       `voiceProbe kokoro-probe rtf cold 0.94 warm 0.61  load 1840/120ms
       peak 312MB  locked=y  batt −3%  over 76.5s(rendered)`. A refusal prints
       its code and nothing else — the fields are all null on that path and
       printing seven dashes would bury the one thing that matters, which is
       WHY — EXCEPT for `synthesis-failed` (#685), the one refusal that comes
       from a phone which did load the model, where the load and memory
       figures exist and are kept.

       `(rendered)`/`(est)` and the `!` after an RTF are #685's other half: the
       line as it shipped could not distinguish 77 seconds of audio a phone
       made from 77 seconds a planner guessed, and printed the zero that
       distinction was hiding as a triumph. */
    case "voiceProbe": {
      if (e.probeOk !== true) {
        /* A refusal used to print its code and NOTHING else, because every
           field was null on that path. `synthesis-failed` broke that premise:
           it is a refusal from a phone that loaded the model, so the load and
           memory figures are real and are the numbers #675 fought for. They
           are appended only when they exist, so `model-absent` still prints
           the one thing that matters and no dashes. */
        const got = (e.loadColdMs != null || e.peakMemoryMb != null)
          ? `  load ${ms(e.loadColdMs)}/${ms(e.loadWarmMs)}` +
            `  peak ${e.peakMemoryMb == null ? "—" : `${e.peakMemoryMb}MB`}`
          : "";
        return `${head} ${e.engine ?? "?"} could not measure: ${e.reason ?? "unknown"}` +
          (e.synthReason ? `/${e.synthReason}` : "") + got;
      }
      const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : "—");
      /* `(est)` vs `(rendered)` — #685. The zero that started that issue was a
         real synthesis time of ~0 divided by a length nobody rendered, and the
         line gave a reader no way to tell. `!` marks an RTF below the floor no
         engine can beat: on one line, with no room for a sentence, it is the
         difference between "spectacular" and "broken". */
      const RTF_FLOOR = 0.01; // === kokoro-probe.js's RTF_FLOOR; this module imports nothing (header), so the two are pinned to each other by a test instead.
      const floor = (v) => (Number.isFinite(v) && v < RTF_FLOOR ? "!" : "");
      return `${head} ${e.engine ?? "?"}${e.provider ? `/${e.provider}` : ""}` +
        (e.acceleratorWired ? "" : "(cpu-only)") +
        `  rtf cold ${f2(e.rtfCold)}${floor(e.rtfCold)} warm ${f2(e.rtfWarm)}${floor(e.rtfWarm)}` +
        `  load ${ms(e.loadColdMs)}/${ms(e.loadWarmMs)}` +
        `  peak ${e.peakMemoryMb == null ? "—" : `${e.peakMemoryMb}MB`}` +
        `  locked=${e.lockedOk ? "y" : "n"}` +
        `  batt ${e.batteryPct == null ? "—" : `${e.batteryPct}%`}` +
        `  over ${e.audioSec == null ? "—" : `${e.audioSec.toFixed(1)}s`}` +
        `(${e.audioFrom === "rendered" ? "rendered" : "est"})` +
        (e.synthFailures ? `  failed ${e.synthFailures}/${e.synthReason ?? "?"}` : "");
    }
    /* L-06. The three fields, in the order the lock screen stacks them, with
       `—` for an empty one — because "empty" is the whole finding for F15 and
       a blank between two pipes would read as a formatting accident. `sent=`
       is the shim's own count: a row where it never moves is a payload that
       never reached `MPNowPlayingInfoCenter`, which is the third explanation
       and the one this line exists to make visible. */
    case "nowplaying": {
      const f = (v) => (v == null || v === "" ? "—" : v);
      const n = e.native;
      const native = n == null
        ? "native=—"
        : `native=${n.installed ? "on" : "off"}/sent=${n.sends ?? "—"}` + (n.reason ? `/${n.reason}` : "");
      /* `write=` is whether the assignment to `navigator.mediaSession.metadata`
         actually completed (2026-09-21). It used to be unknowable from here:
         `media-session.js` did that write inside `attempt()`, which swallows a
         throw, and reported this row afterwards either way -- so a record could
         truthfully say "5 written, 0 with an empty credit" while nothing had
         reached the platform at all. Printed ONLY when it failed, so a healthy
         row keeps its shape and a broken one is impossible to miss. */
      const write = e.writeOk === false ? `  write=FAILED/${f(e.writeError)}` : "";
      /* `via=` only when it is NOT the strings changing, so every row written
         before the field existed keeps its shape and a pause stands out. */
      const via = e.via && e.via !== "metadata" ? `  via=${e.via}` : "";
      return `${head} "${f(e.title)}" / "${f(e.artist)}" / "${f(e.album)}"` +
        `  art=${e.artworkCount ?? 0}  state=${f(e.state)}${via}  ${native}${write}  hidden=${e.hidden ? "y" : "n"}`;
    }
    /* Founder 2026-09-23. `->` is the plugin's mapping of the platform's
       command onto a page action; `handled=n` is a command that arrived with
       nothing to give it to, which is its own finding. */
    case "remote":
      return `${head} ${e.command ?? "?"} -> ${e.action || "—"} from ${e.origin ?? "?"}` +
        `  handled=${e.handled ? "y" : "n"}${e.deduped ? "  dup=y" : ""}  lag ${ms(e.lagMs)}  hidden=${e.hidden ? "y" : "n"}`;
    /* M-03. `lag` is the delivery lag between the plugin's own stamp and the
       page handling the event — on a suspended WebView it is the length of
       the suspension, which is the measurement the F16 drive could not make. */
    case "session":
      return `${head} ${e.producer ?? "?"} ${e.kind}${e.reason ? ` (${e.reason})` : ""}` +
        `  lag ${ms(e.lagMs)}  hidden=${e.hidden ? "y" : "n"}` +
        (e.hiddenForMs != null ? `  hiddenFor ${ms(e.hiddenForMs)}` : "");
    case "transport":
      return `${head} ${e.action} from ${e.source}  hidden=${e.hidden ? "y" : "n"}`;
    case "tapFail":
      return `${head} ${e.phase ?? "?"} failed  error=${e.error ?? "none"}` +
        (e.repeated > 1 ? `  x${e.repeated}` : "") +
        (e.repeated > 1 && e.lastWall != null ? ` over ${ms(e.lastWall - e.wall)}` : "") +
        `  hidden=${e.hidden ? "y" : "n"}`;
    default:
      return `${head} ${JSON.stringify(e)}`;
  }
}

/** `web 2b808ec9d50c5b98 · native 2026092224 (1.4.0)`, with `?` for a half the
    boot could not learn. On the website there is no native half at all, which
    is said as `website` so it is not mistaken for a failed read. */
function buildLabel(e) {
  const web = `web ${e.web ?? "?"}`;
  if (!e.shell) return `${web} · website`;
  return `${web} · native ${e.native ?? "?"}${e.version ? ` (${e.version})` : ""}`;
}

/* ---------- the engine's rows, merged into Copy (NE-26) ----------

   WHY ONE PASTE AND NOT TWO. On the iOS native engine (docs/native-engine-plan.md
   §4.1, NE-19) the rows that answer the car questions — session, remote, seam,
   grace — are written by Swift, into a 2,000-row file ring the page cannot see.
   A founder who has to copy two records from two places, and a reader who has
   to interleave them by hand, is how a drive's evidence gets lost. So Copy asks
   the engine for its whole ring once (engineRead 'diagnostics', NE-20) and this
   block merges it into the same text, by wall clock, each engine line marked
   `src=engine` so no reader mistakes whose clock or whose code wrote it.

   AN ENGINE ROW IS NOT A PAGE ENTRY, and it is never turned into one. The page
   rows carry `type` and `wall`; the engine's carry `kind` and `at` (DiagRow.swift)
   and fields the page's line formatters would misread (an engine `seam` has no
   `cutBy`, so the page's formatter would call every one of them NEVER STARTED).
   Engine rows are wrapped, formatted by their own table, and left out of the
   page's own header counts; they get their own summary lines.

   NOTHING IS DROPPED SILENTLY (the card's acceptance, and DiagGate's rule on the
   Swift side). A kind this table does not know is COUNTED on the header by name,
   a row that is not a row at all (no seq, no clock, no kind) is counted as
   unreadable, a gap in the ring's seq is counted as missing, the oldest rows
   the ring evicted are counted, and rows from before the page's Clear are
   counted rather than shown — the founder's loop is clear, drive, copy, and the
   engine ring outlives a Clear. Every field a formatter does not name is still
   printed as key=value after the ones it does. */

/** DiagRing.capacity (NE-19). */
export const ENGINE_RING_CAP = 2000;

/** Every row kind the native engine writes, which is every kind Copy prints.
    The first eight have their own line shape (card NE-26); the rest print their
    sub-kind and fields. `engine-diagnostics.test.js` scans the Swift emitters and
    fails when the engine writes a kind that is not here — such a row would
    otherwise reach a paste only as a count. */
export const ENGINE_ROW_KINDS = Object.freeze([
  "build", "mode", "session", "remote", "seam", "grace", "probe", "lifecycle",
  "stop", "pause", "rate", "seek", "fault", "deck", "continuation", "reconcile",
  "restore", "position", "diag", "nowplaying", "resume", "outPoint",
  /* NE-25c: PreviewSpeaker's off-main callback row (speaker kind=<end> thread=bg). */
  "speaker",
  /* NE-16g / NE-24: a cold play's span row (grace=, bgRemainingMs), which DV-7a reads. */
  "cold-play",
  /* NE-30s, the Foray tape: the seam beat beginning, ending and being cut
     (beat), a ladder refusal at load (skip) and a noted copy (gate), the
     standby deck asked to prepare (prepare), a rendered bridge that would not
     load (bridge), and a playForay refused for its structure (foray). */
  "beat", "skip", "gate", "prepare", "bridge", "foray",
]);

const ENGINE_HEADER_KEYS = new Set(["seq", "at", "mono", "kind", "event", "dropped"]);

/** The engine's ring as the page can use it: well-formed rows in seq order, and
    a count of everything that was not a row. `seq` is the ring's monotonic
    counter and `at` its wall clock (DiagRow.swift); without both, a row cannot
    be placed, so it is counted, not guessed at. */
export function normalizeEngineRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const good = [];
  let unreadable = 0;
  for (const row of list) {
    const ok = row !== null && typeof row === "object" && !Array.isArray(row)
      && Number.isInteger(row.seq) && row.seq >= 0
      && Number.isFinite(row.at)
      && typeof row.kind === "string" && row.kind !== "";
    if (ok) good.push(row); else unreadable++;
  }
  /* Stable, so two rows with one seq (a ring the engine purged and restarted
     inside one read cannot produce them, but a foreign file line could) keep
     the order the engine served them in. */
  good.sort((a, b) => a.seq - b.seq);
  return { rows: good, unreadable };
}

/**
 * The page's entries and the engine's rows as one list, oldest first.
 *
 * A MERGE, NOT A SORT. Each side is already in its own order (the page's by its
 * seq, the engine's by the ring's), and that order is the truth when a wall
 * clock is not: the clock can step under a drive (a time-zone change, a network
 * time correction), and sorting by it would put an engine row before the row
 * that caused it. Two sorted runs merged by their heads never reorder either
 * run, whatever the clock did. At an equal millisecond the page's row goes
 * first. Engine rows come back wrapped as `{src: "engine", wall, row}`.
 */
export function mergeEngineRows(entries, engineRows) {
  const page = Array.isArray(entries) ? entries : [];
  const engine = Array.isArray(engineRows) ? engineRows : [];
  const out = [];
  let i = 0;
  let j = 0;
  while (i < page.length || j < engine.length) {
    const takeEngine = i >= page.length
      || (j < engine.length && engine[j].at < page[i].wall);
    if (takeEngine) {
      out.push({ src: "engine", wall: engine[j].at, row: engine[j] });
      j++;
    } else {
      out.push(page[i]);
      i++;
    }
  }
  return out;
}

/** A field's value on an engine line. `…Ms` numbers read as durations, the way
    the page's own lines print them; a seam's stage list reads as a trail. */
function engineValue(key, v) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "y" : "n";
  if (typeof v === "number") return /Ms$/.test(key) ? ms(v) : String(v);
  if (Array.isArray(v)) {
    const parts = v.map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
    return parts.length ? parts.join(key === "stages" ? ">" : ",") : "—";
  }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** `key=value` for the named keys that are present, in that order, then every
    other field the row carries: a formatter names what a reader looks for
    first, and never decides what a reader may not see. */
function engineFields(r, lead = [], skip = []) {
  const own = (k) => Object.prototype.hasOwnProperty.call(r, k);
  const named = lead.filter(own);
  const rest = Object.keys(r).filter((k) => !ENGINE_HEADER_KEYS.has(k) && !lead.includes(k) && !skip.includes(k));
  return [...named, ...rest].map((k) => `${k}=${engineValue(k, r[k])}`);
}

/** The body of one engine line, per kind (card NE-26: session, remote, mode, the
    packed seam row, grace, probe and lifecycle, plus the build row the header
    reads). `event` is the row's sub-kind: DiagGate writes a row's own `kind`
    field as `event`, because `kind` is the row header's. */
const ENGINE_LINES = {
  build: (r) => [`v${r.engineVersion ?? "?"}`, ...engineFields(r,
    ["protocol", "bundleVersion", "launch", "pitch", "hold"], ["engineVersion"])],
  /* `strikes` next to the reason: a downgrade is a count reaching STRIKE_LIMIT,
     and the one without the other is half a finding. */
  mode: (r) => engineFields(r, ["mode", "reason", "strikes", "cap"]),
  /* activateMs first: DV-3's reading is how long setActive(true) took, and the
     silence hint is on every session row (plan §4.4). */
  session: (r) => [r.event ?? "?", ...engineFields(r, ["activateMs", "ok", "token", "reason", "hint", "phase"])],
  /* status (the MPRemoteCommandHandlerStatus the engine answered), the route's
     PORT TYPE, the thread the press arrived on, and T-8's duplicate candidate. */
  remote: (r) => [r.cmd ?? "?", ...engineFields(r, ["status", "route", "thread", "dupCandidate", "grace", "state"], ["cmd"])],
  /* The PACKED seam row (DiagRow.swift SeamRow): one row per seam. A null gap is
     a next item that never became audible, said in words as the page's own seam
     line says NEVER STARTED, because a dash reads as "not measured". */
  seam: (r) => [
    r.observedGapMs == null ? "NEVER AUDIBLE" : `gap ${ms(r.observedGapMs)}`,
    `asked ${ms(r.askedGapMs)}`,
    ...engineFields(r, ["prepared", "grace", "bgRemainingMs", "stages"], ["observedGapMs", "askedGapMs"]),
  ],
  grace: (r) => [r.event ?? "?", ...engineFields(r, ["reason", "task", "bgRemainingMs"])],
  probe: (r) => [r.event ?? "?", ...engineFields(r)],
  lifecycle: (r) => [r.event ?? "?", ...engineFields(r)],
  /* The three Now Playing strings are the only free text a row may hold
     (DiagGate rule 5), quoted as the page's own nowplaying line quotes them. */
  nowplaying: (r) => {
    const f = (v) => (v == null || v === "" ? "—" : v);
    return [`"${f(r.title)}" / "${f(r.artist)}" / "${f(r.album)}"`,
      ...engineFields(r, [], ["title", "artist", "album"])];
  },
};

/** One engine row as one line, headed like a page line plus `src=engine`. */
export function engineLineFor(r) {
  const head = `#${pad(r.seq, 4)} ${clockOf(r.at)} ${pad(r.kind, 10)} src=engine`;
  const body = ENGINE_LINES[r.kind]
    ? ENGINE_LINES[r.kind](r)
    : [r.event ?? null, ...engineFields(r)].filter((p) => p != null);
  /* DiagGate's own record of what it withheld from this row. */
  const withheld = Array.isArray(r.dropped) && r.dropped.length ? [`withheld=${r.dropped.join(",")}`] : [];
  return [head, ...body, ...withheld].join(" ");
}

/** The newest row of a kind that satisfies `pick`, or null. */
function newestEngineRow(rows, kind, pick = () => true) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].kind === kind && pick(rows[i])) return rows[i];
  }
  return null;
}

/**
 * The engine header line (card NE-26):
 *
 *   engine=native v<ver> proto=<n> caps=<list> reason=<r> strikes=<n> hold=<policy> build=<CFBundleVersion> | web=<build-stamp>
 *   engine=js reason=<r> [strikes=<n>] build=<CFBundleVersion> | web=<build-stamp>
 *
 * ONE LINE, key=value, because it is read twice: by a founder on a phone, and by
 * tools/mobile/engine-report.mjs (NE-26r), whose header check is exactly
 * "engine=native, strikes=0, which build". Each value comes from the freshest
 * source that has it — the handshake the page decided on, then the snapshot,
 * then the engine's own newest rows, then the page's build stamp — and a value
 * nobody could supply is `?`, never a guess. The JS line leaves out what only a
 * running engine has, and keeps `strikes` when the engine's rows carry them:
 * a crash-loop downgrade is a JS page with three strikes behind it.
 *
 * @param {object|null} engine  `{decision, snapshot, rows}` (see formatDiagnosticReport)
 * @param {object|null} running the page's build stamp ({web, native, …})
 */
export function engineHeaderLine(engine, running = null) {
  const e = engine ?? {};
  const rows = Array.isArray(e.rows) ? e.rows : [];
  const decision = e.decision && typeof e.decision === "object" ? e.decision : null;
  const mode = decision?.mode === "native" ? "native" : "js";
  const hello = decision?.hello && typeof decision.hello === "object" ? decision.hello : null;
  const buildRow = newestEngineRow(rows, "build");
  /* The engine's own decideOnce row (NE-17): `mode kind` carries mode, reason,
     strikes and the CFBundleVersion it decided for. */
  const decidedRow = newestEngineRow(rows, "mode", (r) => typeof r.mode === "string" && typeof r.reason === "string");
  /* No page verdict yet (before NE-22 the page never asks): when the engine
     itself chose its legacy lane — a crash-loop, a sticky legacy build, an
     override — that reason IS why this page plays JS, so it is printed rather
     than `undecided`. An engine that chose native says nothing about a page
     that is not listening to it, so that case stays `undecided`. */
  const pageReason = decision?.reason ?? "undecided";
  const reason = mode === "js" && pageReason === "undecided" && decidedRow?.mode === "legacy"
    ? decidedRow.reason
    : pageReason;
  const strikesRow = newestEngineRow(rows, "mode", (r) => Number.isInteger(r.strikes));
  const strikes = Number.isInteger(hello?.strikes) ? hello.strikes : strikesRow ? strikesRow.strikes : null;
  const bundle = buildRow?.bundleVersion ?? decidedRow?.build ?? running?.native ?? "?";
  const web = `web=${running?.web ?? "?"}`;
  if (mode === "js") {
    return `engine=js reason=${reason}${strikes == null ? "" : ` strikes=${strikes}`} build=${bundle} | ${web}`;
  }
  /* The policy in force: the live snapshot's, else whichever of the engine's
     rows set it last — a hold-policy change or the boot's build row. */
  const holdRow = newestEngineRow(rows, "session", (r) => r.event === "hold-policy" && typeof r.policy === "string");
  const holdFromRows = holdRow && (!buildRow || holdRow.seq > buildRow.seq) ? holdRow.policy : buildRow?.hold;
  const hold = e.snapshot?.holdPolicy ?? holdFromRows ?? "?";
  /* The ENGINE's reason when it answered native (build-default, override):
     the page's own verdict is just "native" again, which says nothing. */
  const why = typeof hello?.reason === "string" ? hello.reason : reason;
  const ver = hello?.engineVersion ?? buildRow?.engineVersion ?? "?";
  const proto = hello?.protocol ?? buildRow?.protocol ?? "?";
  const caps = Array.isArray(hello?.capabilities)
    ? (hello.capabilities.length ? hello.capabilities.join(",") : "none")
    : "?";
  return `engine=native v${ver} proto=${proto} caps=${caps} reason=${why}` +
    ` strikes=${strikes ?? "?"} hold=${hold} build=${bundle} | ${web}`;
}

/** The median of a sorted list, or null. */
function medianOf(sorted) {
  if (!sorted.length) return null;
  const h = sorted.length >> 1;
  return sorted.length % 2 ? sorted[h] : (sorted[h - 1] + sorted[h]) / 2;
}

/**
 * What of the engine's ring this paste shows, and what it does not.
 *
 * Returns `{shown, lines}`: the rows to merge (known kinds, since the page's
 * Clear) and the header lines that account for every other row.
 */
function engineSection(engine, cleared) {
  if (!engine || engine.rows === undefined) return { shown: [], lines: [] };
  if (!Array.isArray(engine.rows)) {
    /* Asked and not answered: an older binary without engineRead, a bridge
       that threw, a read that outlived its bound. Said, with why. */
    return { shown: [], lines: [`engine rows not read (${engine.readError ?? "no answer"})`] };
  }
  const { rows, unreadable } = normalizeEngineRows(engine.rows);
  const lines = [];
  if (!rows.length) {
    lines.push(`engine rows 0 of ${ENGINE_RING_CAP}`);
  } else {
    /* The ring's seq starts at 1 and only climbs (DiagRing.swift), so the first
       row's seq says how many older rows were evicted, and the span against the
       count says how many in between are gone. NE-26r reads an evicted early
       seam as an incomplete drive, not a passed one. */
    const first = rows[0].seq;
    const last = rows[rows.length - 1].seq;
    const missing = last - first + 1 - new Set(rows.map((r) => r.seq)).size;
    lines.push(`engine rows ${rows.length} of ${ENGINE_RING_CAP}, #${first}..#${last}`
      + (first > 1 ? `, ${first - 1} older evicted` : "")
      + (missing > 0 ? `, ${missing} MISSING (seq gaps)` : ""));
  }
  if (unreadable) lines.push(`engine rows unreadable ${unreadable}`);

  const known = new Set(ENGINE_ROW_KINDS);
  const since = cleared && Number.isFinite(cleared.wall) ? cleared.wall : null;
  const beforeClear = since == null ? [] : rows.filter((r) => r.at < since);
  const current = since == null ? rows : rows.filter((r) => r.at >= since);
  if (beforeClear.length) lines.push(`engine rows before the Clear ${beforeClear.length}, not shown`);
  const unknown = new Map();
  for (const r of current) if (!known.has(r.kind)) unknown.set(r.kind, (unknown.get(r.kind) ?? 0) + 1);
  if (unknown.size) {
    lines.push(`engine rows of unknown kinds, not shown: ${[...unknown].map(([k, n]) => `${k} x${n}`).join(", ")}`);
  }
  const shown = current.filter((r) => known.has(r.kind));
  const seams = shown.filter((r) => r.kind === "seam");
  if (seams.length) {
    const gaps = seams.filter((r) => typeof r.observedGapMs === "number").map((r) => r.observedGapMs).sort((a, b) => a - b);
    lines.push(`engine seams ${seams.length}: ${gaps.length} audible, ${seams.filter((r) => r.prepared === true).length} prepared`
      + `, gap median ${ms(medianOf(gaps))}, worst ${ms(gaps.length ? gaps[gaps.length - 1] : null)}`);
  }
  return { shown, lines };
}

/**
 * The whole record as copyable text.
 *
 * Plain text and not JSON because of where it is read: a phone, in a car,
 * possibly by someone who is going to paste it into a message. The header states
 * the cap and the eviction rule on its own face, so a reader is never left
 * wondering whether a short log means a quiet drive or a full ring.
 *
 * `engine` (NE-26) is the native engine's half, when the page has one to give:
 *   decision  the page's engine decision ({mode, reason, hello}), or null
 *   snapshot  the page's latest engine snapshot, or null
 *   rows      the engine's ring (engineRead 'diagnostics'); `null` when it was
 *             asked for and not read, absent when it was not asked for
 *   readError why `rows` is null
 * Without it the header still carries the engine line (`engine=js
 * reason=undecided`): which engine played is the question every other line in
 * a paste depends on.
 */
export function formatDiagnosticReport(record, engine = null) {
  const r = record ?? {};
  const entries = Array.isArray(r.entries) ? r.entries : [];
  const seams = entries.filter((e) => e.type === "seam");
  const measured = seams.filter((e) => typeof e.observedGapMs === "number");
  const cut = seams.filter((e) => e.observedGapMs == null && e.cutBy != null);
  /* NEITHER THE END OF THE QUEUE NOR A CUT BEAT IS A STALL. Both are seams that
     never completed, and counting either as one would make the instrument
     manufacture its own findings: every healthy Foray ends at a boundary, and every
     listener who pauses mid-beat cuts one. */
  const open = seams.filter(
    (e) => e.observedGapMs == null && e.endOfQueue !== true && e.cutBy == null
  );
  /* L-06 / M-03. Counted here rather than in the rows because the header is
     what a founder reads on a phone mid-drive; the rows are for pasting. */
  const nowPlaying = entries.filter((e) => e.type === "nowplaying");
  const blankCredit = nowPlaying.filter((e) => !e.artist).length;
  const sessions = entries.filter((e) => e.type === "session");
  const remotes = entries.filter((e) => e.type === "remote");
  const deduped = remotes.filter((e) => e.deduped).length;
  /* A dropped duplicate is not an unhandled press: the OTHER copy ran. */
  const unhandled = remotes.filter((e) => !e.handled && !e.deduped).length;
  const gaps = measured.map((e) => e.observedGapMs).sort((a, b) => a - b);
  const worst = gaps.length ? gaps[gaps.length - 1] : null;
  const mid = gaps.length
    ? (gaps.length % 2 ? gaps[gaps.length >> 1] : (gaps[(gaps.length >> 1) - 1] + gaps[gaps.length >> 1]) / 2)
    : null;

  /* ── THE HEADER IS THE ANSWER, SO IT HAS TO FIT ON A PHONE ──────────────
     Kept under ~44 characters a line, one fact a line. The first draft ran the
     counts together at 74 characters, which at this monospace size is about 500 px
     — wider than the ~340 px a phone panel gives, so the one part of this record a
     founder reads ON SCREEN (rather than pastes) needed horizontal scrolling to
     read. The per-entry rows below are inherently long and scroll sideways in their
     own box; that is fine, because those are for pasting.

     `recorded`, NOT "saves". `seq` counts entries ever recorded, and `save()` also
     runs on stages that add no entry — "saves" would invite a reader to divide it
     by the elapsed wall clock and call the answer a write cadence, which it is
     not. */
  /* THE BUILD, FIRST (founder report 3). The most recent `build` row — the
     running build — because the first question about any pasted record is
     which build wrote it, and until 2026-09-22 nothing in it could say. */
  const builds = entries.filter((e) => e.type === "build");
  const lastBuild = builds.length ? builds[builds.length - 1] : null;
  /* The log's own copy of the stamp first (it survives a Clear), the newest row
     second (a record from a build that predates the copy), "unknown" last. */
  const running = (r.build && typeof r.build === "object") ? r.build : lastBuild;

  /* ── THE COUNTERS HAVE TO ADD UP, OR THE HEADER SAYS THEY DO NOT ──────────
     The founder's 2026-09-23 record: `recorded 939 · entries 0 · dropped 0`,
     and not a word about why. `seq` counts rows ever recorded and survives a
     Clear on purpose (see `DiagnosticLog.clear`), so the arithmetic that has to
     hold is  seq − clearedAt.seq  ==  entries + dropped.  A record that breaks
     it has lost rows somewhere between the writer and this text — a Clear from
     a build that did not write the mark, rows `_load` refused, a tier that
     handed back a different blob — and every one of those is a finding about
     the INSTRUMENT that must not be rendered as a quiet empty ring. So the gap
     is computed here, printed with the key and the tiers it was read from, and
     a clear is named as a clear. */
  const seq = Number.isFinite(r.seq) ? r.seq : 0;
  const dropped = Number.isFinite(r.dropped) ? r.dropped : 0;
  const cleared = r.cleared && Number.isInteger(r.cleared.seq) ? r.cleared : null;
  const since = seq - (cleared ? cleared.seq : 0);
  const missing = since - dropped - entries.length;
  const key = typeof r.key === "string" ? r.key : DIAG_KEY;
  const tiers = Array.isArray(r.store?.tiers) && r.store.tiers.length ? r.store.tiers.join("+") : "no store";
  const hydrated = r.store?.hydrated == null ? "" : `, hydrated=${r.store.hydrated ? "y" : "n"}`;
  const where = `${key} (${tiers}${hydrated})`;
  const gapLine = missing > 0
    ? `MISSING ${missing} of ${since} recorded rows: not in this ring, not dropped — ${where} was cleared or lost`
    : missing < 0
      ? `INCONSISTENT: ${entries.length} rows exceed the ${since} recorded — ${where}`
      : null;
  /* NE-26: the engine's rows to merge, and the lines accounting for the rest.
     The page's Clear mark bounds them too: the founder's loop is clear, drive,
     copy, and the engine's ring is not emptied by the page's Clear. */
  const engineRows = engineSection(engine, cleared);

  const head = [
    `4a playback diagnostics — v${r.v ?? "?"}`,
    `build ${running ? buildLabel(running) : "unknown (no build row yet)"}`,
    /* NE-26: which engine played, as one parseable line (engineHeaderLine). */
    engineHeaderLine(engine, running),
    `Local only. Nothing here is sent anywhere.`,
    "",
    `entries ${entries.length} of ${r.cap ?? DIAG_CAP} (oldest dropped first)`,
    `dropped ${r.dropped ?? 0} · recorded ${r.seq ?? 0} · writeErrors ${r.saveErrors ?? 0}`,
    cleared ? `cleared at #${cleared.seq} ${clockOf(cleared.wall)} · ${since} recorded since` : null,
    gapLine,
    `seams ${seams.length}: ${measured.length} measured, ${open.length} never started`
      + (cut.length ? `, ${cut.length} cut short` : ""),
    `gap median ${ms(mid)}, worst ${ms(worst)}`,
    /* L-06 ON THE HEADER, not only in the rows, because this is the line a
       founder reads on the phone during a drive test. `0 sent` answers F15
       outright — the payload never reached the OS — and `n with an empty
       credit` answers it the other way, without scrolling 200 rows. */
    `now playing ${nowPlaying.length} written`
      + (nowPlaying.length ? `, ${blankCredit} with an empty credit` : ""),
    /* M-03. `0` here against a `stop` row below is itself the finding the card
       asks for: the stop was preceded by nothing the plugins could see. */
    `session events ${sessions.length}`
      + (sessions.length ? ` (${[...new Set(sessions.map((e) => e.kind))].join(", ")})` : ""),
    /* Founder 2026-09-23. `0` here against a car that resumed Spotify says the
       car's play never reached 4a's native side at all — the OS gave it to
       somebody else — which is a different bug from a play that arrived and
       found nobody awake (`unhandled`). */
    `remote commands ${remotes.length}`
      + (unhandled ? `, ${unhandled} unhandled` : "")
      /* One press through two doors (iOS: WebKit's client and the plugin's).
         Counted on the header because it is the reading H8 asks for: a skip
         that moved once with `1 duplicate dropped` is the de-duplication doing
         its job; one that moved twice with none is the window missing it. */
      + (deduped ? `, ${deduped} duplicate${deduped === 1 ? "" : "s"} dropped` : ""),
    r.loadError ? `earlier record unreadable: ${r.loadError}` : null,
    ...engineRows.lines,
    `updated ${r.updatedAt ?? "—"}`,
    "",
  ].filter((l) => l != null);

  /* An empty ring after a Clear is not "nothing happened yet": the words say
     which it is, because the founder read the first sentence as the instrument
     having recorded nothing during a drive it had in fact recorded. */
  /* Engine rows below are something recorded, so neither sentence is said over
     them: "nothing recorded" above 2,000 engine rows would be false. */
  if (!entries.length && !engineRows.shown.length && cleared) {
    head.push(`Nothing recorded yet since the record was cleared at #${cleared.seq}. Play a foray and come back.`);
  } else if (!entries.length && !engineRows.shown.length) {
    /* A literal, not a template: `test/app-name.test.js` reads this sentence out
       of the push call below to keep it in step with app.js's fallback. */
    head.push("Nothing recorded yet. Play a foray and come back.");
  }
  const merged = mergeEngineRows(entries, engineRows.shown);
  return head.concat(merged.map((e) => (e.src === "engine" ? engineLineFor(e.row) : lineFor(e)))).join("\n");
}
