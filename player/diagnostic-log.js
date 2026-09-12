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

/** The five things a native plugin may report. Mirrors the `kind` strings in
    `ForayAudioPlugin.swift`/`ForayTtsPlugin.swift`'s `emitSession` calls. */
export const SESSION_KINDS = new Set([
  "interruptionBegan", "interruptionEnded", "routeChange", "mediaServicesReset",
  "background", "foreground",
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
export const TRANSPORT_ACTIONS = new Set(["play", "pause", "stop"]);

/** A status, a trigger, a validation code: a lower-case dashed token, never a
    sentence. `sha256-forays`, `segment-missing`, `foreground` all pass; a reason
    with a space or a slash in it does not. */
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
  nowPlaying({ metadata = null, playbackState = null, native = null } = {}) {
    const m = metadata && typeof metadata === "object" ? metadata : {};
    const artwork = Array.isArray(m.artwork) ? m.artwork : [];
    return this.log.record("nowplaying", {
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
   * THE THREE SLOW HALVES ARE ALL HERE, and that is the audit's other half:
   *   `netMs`/`netHits`  the breadth (shows) endpoint, or 0 on a cache hit
   *   `epMs`/`epHits`    the EPISODES endpoint — the slower of the two, and
   *                      until the audit it was measured by nothing at all
   *   `ctaMs`            the create-a-playlist CTA's relaxation scan, a
   *                      1.3-8 s synchronous pass that used to run behind a
   *                      `setTimeout(0)` where no number could see it
   * Null means "this half did not run on this search", which is a real state
   * for all three (a cache hit, a page with no episode section, a query that
   * already matched a playlist) and not an error.
   */
  search({
    qLen = null, localMs = null, localHits = null,
    netMs = null, netHits = null, epMs = null, epHits = null,
    ctaMs = null, paintedMs = null, path = null,
  } = {}) {
    const num = (v) => (Number.isFinite(v) ? v : null);
    return this.log.record("search", {
      qLen: num(qLen),
      localMs: num(localMs),
      localHits: num(localHits),
      netMs: num(netMs),
      netHits: num(netHits),
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
         three halves that did not run on this search read.

         `hidden=` at the end like every other line that carries it (2026-09-12
         audit: this was the only case printing none). */
      const n = (v) => (v == null ? "—" : v);
      return `${head} qLen=${n(e.qLen)} local=${ms(e.localMs)}/${n(e.localHits)}h` +
        ` net=${ms(e.netMs)}/${n(e.netHits)}h ep=${ms(e.epMs)}/${n(e.epHits)}h` +
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
       peak 312MB  locked=y  batt −3%  over 76.5s`. A refusal prints its code
       and nothing else — the fields are all null on that path and printing
       seven dashes would bury the one thing that matters, which is WHY. */
    case "voiceProbe": {
      if (e.probeOk !== true) {
        return `${head} ${e.engine ?? "?"} could not measure: ${e.reason ?? "unknown"}`;
      }
      const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : "—");
      return `${head} ${e.engine ?? "?"}${e.provider ? `/${e.provider}` : ""}` +
        `  rtf cold ${f2(e.rtfCold)} warm ${f2(e.rtfWarm)}` +
        `  load ${ms(e.loadColdMs)}/${ms(e.loadWarmMs)}` +
        `  peak ${e.peakMemoryMb == null ? "—" : `${e.peakMemoryMb}MB`}` +
        `  locked=${e.lockedOk ? "y" : "n"}` +
        `  batt ${e.batteryPct == null ? "—" : `${e.batteryPct}%`}` +
        `  over ${e.audioSec == null ? "—" : `${e.audioSec.toFixed(1)}s`}`;
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
      return `${head} "${f(e.title)}" / "${f(e.artist)}" / "${f(e.album)}"` +
        `  art=${e.artworkCount ?? 0}  state=${f(e.state)}  ${native}  hidden=${e.hidden ? "y" : "n"}`;
    }
    /* M-03. `lag` is the delivery lag between the plugin's own stamp and the
       page handling the event — on a suspended WebView it is the length of
       the suspension, which is the measurement the F16 drive could not make. */
    case "session":
      return `${head} ${e.producer ?? "?"} ${e.kind}${e.reason ? ` (${e.reason})` : ""}` +
        `  lag ${ms(e.lagMs)}  hidden=${e.hidden ? "y" : "n"}`;
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
  /* L-06 / M-03. Counted here rather than in the rows because the header is
     what a founder reads on a phone mid-drive; the rows are for pasting. */
  const nowPlaying = entries.filter((e) => e.type === "nowplaying");
  const blankCredit = nowPlaying.filter((e) => !e.artist).length;
  const sessions = entries.filter((e) => e.type === "session");
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
    `4a playback diagnostics — v${r.v ?? "?"}`,
    `Local only. Nothing here is sent anywhere.`,
    "",
    `entries ${entries.length} of ${r.cap ?? DIAG_CAP} (oldest dropped first)`,
    `dropped ${r.dropped ?? 0} · recorded ${r.seq ?? 0} · writeErrors ${r.saveErrors ?? 0}`,
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
    r.loadError ? `earlier record unreadable: ${r.loadError}` : null,
    `updated ${r.updatedAt ?? "—"}`,
    "",
  ].filter((l) => l != null);

  if (!entries.length) head.push("Nothing recorded yet. Play a foray and come back.");
  return head.concat(entries.map(lineFor)).join("\n");
}
