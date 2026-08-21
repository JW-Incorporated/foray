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
 *
 * ── WHAT IS NEVER RECORDED, BY CONSTRUCTION ────────────────────────────────
 * No audio, no URLs, no listener identity. The rule that guarantees it: a
 * telemetry line's TEXT is never stored. Only three things go in —
 *
 *   1. numbers matched by one of the explicit patterns below,
 *   2. authored segment/item ids (already in `cp_foray:` rows; no new identity),
 *   3. STAGE NAMES from a fixed vocabulary (`STAGE_ROOTS`), taken as the leading
 *      dotted token of a message and dropped entirely if unrecognised.
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

  /** Append one entry and persist immediately. Returns the live entry. */
  record(type, fields = {}) {
    const entries = this._load();
    /* THE FRAME LAST, so no caller field can overwrite it. Spread first and a stray
       `wall` or `seq` in `fields` silently replaces the two values every ordering,
       eviction and cadence claim in this file rests on. Nothing collides today, which
       is the only reason this was not already a bug. */
    const entry = { ...fields, seq: ++this._seq, wall: this._now(), type: String(type) };
    entries.push(entry);
    while (entries.length > this.cap) { entries.shift(); this._dropped += 1; }
    this.save();
    return entry;
  }

  /** The whole record, in the shape that is serialised. */
  read() {
    const entries = this._load();
    return {
      v: DIAG_VERSION,
      cap: this.cap,
      seq: this._seq,
      dropped: this._dropped,
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
    try {
      this.storage.setItem(this.key, JSON.stringify(this.read()));
      return true;
    } catch (_) {
      this.saveErrors += 1;
      return false;
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
   * one: `entries[0].seq > 1` with `dropped === 0` means "cleared".
   */
  clear() {
    this._load();
    this._entries = [];
    this._dropped = 0;
    this.loadError = null;
    if (!this.storage) return;
    try { this.storage.removeItem(this.key); } catch (_) { this.saveErrors += 1; }
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
 * An error's CLASS, or null.
 *
 * `.name` and never `.message`. A DOM exception's name is a closed vocabulary
 * (`NotAllowedError`, `NotSupportedError`, `AbortError`) and answers the only
 * question this record is asked — was the browser refusing, or did the code
 * break. A `.message` carries prose and URLs, and this record gets pasted into
 * issues; that is the same rule `knownCar` above is written to enforce, applied
 * before the value is stored rather than after.
 *
 * Underscore but no dot: an error name is one identifier, so the dotted form a
 * stage name allows would mean something got through that is not a name.
 */
export function errorNameOf(name) {
  const n = String(name ?? "").trim();
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
  unexpectedPause: /^audio\.pausedUnexpectedly/,
  audioError: /^audio\.error code=(\S+)/,
  playRejected: /^play\.rejected (\S+)/,
  /* Matched, never CAPTURED — see the handler. The route name is a device a person
     named, and it must not reach a record that gets pasted into an issue. */
  knownCar: /^route\.autoResume\.knownCar=/,
  restore: /^restore\.index=(\d+)\.position=(\d+)s/,
  queueEnded: /^queue\.ended/,
};

const num = (s) => { const n = Number(s); return Number.isFinite(n) ? n : null; };

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

  /** Called once, after storage has hydrated, so the record says when the page
      loaded and in what visibility state. The clock this is measured against was
      already started in the constructor — see `_visSince`. */
  boot() {
    return this.log.record("boot", { hidden: this._isHidden() });
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
         pause inside the 2.0 s beat left an open seam, and then:
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

    if (RE.unexpectedPause.test(m)) {
      this.log.record("stop", {
        source: "element", why: "pausedUnexpectedly", state: null, hidden: this._isHidden(),
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
    this._stage(n);
    return true;
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
    return this.log.record("tapFail", {
      phase: TAP_PHASES.has(String(phase)) ? String(phase) : "start",
      error: errorNameOf(name),
      hidden: this._isHidden(),
    });
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
    case "stop":
      return `${head} ${e.source} ${e.why}  state=${e.state ?? "?"}  hidden=${e.hidden ? "y" : "n"}`;
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
      return `${head} hidden=${e.hidden ? "y" : "n"}`;
    /* `error=none` rather than an empty space, because the two are different
       findings: a tap that failed with no error CLASS is a `playForay` that
       returned a rejection carrying nothing, and a reader who sees a blank will
       assume the field was never written. */
    case "tapFail":
      return `${head} ${e.phase ?? "?"} failed  error=${e.error ?? "none"}` +
        `  hidden=${e.hidden ? "y" : "n"}`;
    default:
      return `${head} ${JSON.stringify(e)}`;
  }
}

/**
 * The whole record as copyable text.
 *
 * Plain text and not JSON because of where it is read: a phone, in a car,
 * possibly by someone who is going to paste it into a message. The header states
 * the cap and the eviction rule on its own face, so a reader is never left
 * wondering whether a short log means a quiet drive or a full ring.
 */
export function formatDiagnosticReport(record) {
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
  const head = [
    `Foray playback diagnostics — v${r.v ?? "?"}`,
    `Local only. Nothing here is sent anywhere.`,
    "",
    `entries ${entries.length} of ${r.cap ?? DIAG_CAP} (oldest dropped first)`,
    `dropped ${r.dropped ?? 0} · recorded ${r.seq ?? 0} · writeErrors ${r.saveErrors ?? 0}`,
    `seams ${seams.length}: ${measured.length} measured, ${open.length} never started`
      + (cut.length ? `, ${cut.length} cut short` : ""),
    `gap median ${ms(mid)}, worst ${ms(worst)}`,
    r.loadError ? `earlier record unreadable: ${r.loadError}` : null,
    `updated ${r.updatedAt ?? "—"}`,
    "",
  ].filter((l) => l != null);

  if (!entries.length) head.push("Nothing recorded yet. Play a Foray and come back.");
  return head.concat(entries.map(lineFor)).join("\n");
}
