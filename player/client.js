/* Client bootstrap — the only file that connects the player to the page (#25).

   app.js is a classic script; everything under player/ is ES modules. So this
   module owns the wiring and exposes a tiny surface on `window.ForayPlayer`,
   which app.js calls lazily on click. Module scripts are deferred, so app.js
   must never assume this exists at parse time — only at interaction time.

   This file also owns its own DOM (mini-player + Now Playing sheet), built with
   createElement/textContent rather than HTML strings. Episode titles come from
   third-party RSS, and DOM construction is safe by default in a way string
   concatenation is not. There is a strict CSP with no inline styles or scripts;
   all styling lives in styles.css.

   ── Forays (#128) ─────────────────────────────────────────────────────────
   A Foray is one queue of 32 segments, so it needs a second entry point next
   to `play(item)`: `playForay(resolved)`. Everything below the surface is
   unchanged — the same manager, the same backend, the same out-point watch. Two
   things are different above it, and both exist because a segment is a slice of
   somebody else's episode:

     - POSITION IS FORAY POSITION. The audio element's `currentTime` for segment
       20 is ~31 minutes, which is a fact about a stranger's podcast. Everything
       displayed and everything scrubbed goes through `forayElapsed` /
       `segmentAtElapsed` (player/foray-resolve.js, tested) so the listener only
       ever sees the Foray's own clock.
     - THE SKIP BUTTONS MOVE BETWEEN SEGMENTS. ±15/30 s inside a 90-second
       segment would mostly leave it, and leaving a segment is what `next` is
       for.

   The resolution itself — forays.json + segments.json + segment-sources.json —
   is NOT done here. app.js needs the same running order to render, so it lives
   in the pure module and both callers use it through `ForayPlayer.resolve`.

   ── Resuming across sessions ──────────────────────────────────────────────
   `PositionStore` already persists a position per QUEUE ITEM, and for a Foray
   that is 32 rows none of which is the Foray's own clock. So a Foray's resume
   point is written separately, by `player/foray-progress.js`, in the only unit a
   listener recognises: elapsed across the whole thing. This file is where the
   live playhead meets that store — on every tick (throttled), and forced at the
   two moments the next tick may never come, pause and page-hide.

   ── Durable storage (#40) ─────────────────────────────────────────────────
   This module owns the ONE `DurableStore` the whole app shares. It is built
   here, not in app.js, for a mechanical reason: app.js is a classic script and
   cannot import an ES module, and `index.html` is outside the auto-merge
   allowlist so a third `<script>` tag is not available. So the store is created
   at module evaluation and published on `window.forayStorage` alongside
   `window.ForayPlayer`; app.js's `lsGet`/`lsSet` pick it up and fall back to raw
   `localStorage` until it appears (and forever, if this module fails to load).

   Two consequences worth knowing before changing anything here:
     - `hydrate()` is started immediately and is what app.js awaits before its
       first write. Reading `cp_interests` or `cp_sb_session` before it finishes
       is how a RESTORED profile gets overwritten by a fresh one — the fix
       causing the defect it fixes.
     - `navigator.storage.persist()` is requested once, and a refusal is
       recorded rather than treated as an error. Nothing below branches on it.

   ── Deleting all of it (#42) ──────────────────────────────────────────────
   The store's `purge()` is what app.js's "delete my data" control calls, so the
   same published object is both halves of the promise: it is where a listener's
   state becomes durable, and where it stops existing. This module's own
   contribution is `stopForDataDeletion()` — a stop that persists nothing, because
   a player left running writes a position back one tick after the clear.

   ── The field record (#264) ───────────────────────────────────────────────
   This file's telemetry hook used to be a console filter rather than a pipeline:
   a three-word regex dropped `outPoint.reached`, `seam.gap.armed`, `load.deadline`
   and every load timing, and what survived went to `console.warn` — which the
   comment beneath it calls "a console line nobody has open", true of a phone in a
   car. Five changes shipped into the seam and transport area (#227, #235, #239,
   #260, #266) with no field measurement between them.

   So the whole telemetry stream now also reaches `player/diagnostic-log.js`, a
   bounded local ring, and `window.forayDiagnosticReport()` renders it as copyable
   text for the surface app.js builds. Three things to know before changing any of
   it, all argued at length in that file's header:

     - IT DOES NOT TRANSMIT, and that is the design. The `cp_events` pipeline has
       NO consent gate, so a richer record of a person's listening must not ride
       it. Nothing here touches `cp_events` or `trySyncEvents`.
     - WRITES ARE DURABLE AT THE MOMENT OF THE EVENT, not flushed on unload. A page
       suspended mid-seam is exactly when the record matters.
     - THE MESSAGE TEXT IS NEVER STORED — only matched numbers, authored segment
       ids, stage names from a fixed vocabulary, and the error CLASS of a failed
       tap (#225: an `Error`/`DOMException` `.name`, never a `.message`). No audio,
       no URLs, no identity. `diagnostic-log.js`'s header holds the full rule.
*/

import { PlayerQueueManager } from "./queue-manager.js";
import { HtmlAudioBackend } from "./html-audio-backend.js";
import { PositionStore } from "./position-store.js";
import { SINGLE_ITEM } from "./queue-strategy.js";
import { seekPrecision, formatTimestamp, EXACT, OWN } from "./seek-policy.js";
import { itemRuntimeSec } from "./foray-queue.js";
import {
  resolveForay, indexSegments, indexSources, findForay, listableForays,
  forayElapsed, segmentAtElapsed, fmtClock, fmtSpan, progressSegments,
} from "./foray-resolve.js";
import {
  ForayProgressStore, resumePoint, remainingLabel, percentDone,
  DRIFT_EXACT, DRIFT_UNVERIFIED, DRIFT_UNANCHORED,
} from "./foray-progress.js";
import {
  DiagnosticLog, PlayerDiagnostics, formatDiagnosticReport,
} from "./diagnostic-log.js";
import { forayCredits, collectionIdsByShow, creditsSummary, artworkUrlsByShow } from "./foray-sources.js";
import { mountStrip, stripModel, stripSummary } from "./segment-strip.js";
import {
  HOLD_MS, MOVE_TOLERANCE_PX, ZOOM_SCALE,
  startGesture, moveGesture, holdTimeoutGesture, endGesture, zoomOriginPercent,
  BUBBLE_SCALE, BUBBLE_WIDTH, BUBBLE_HEIGHT, BUBBLE_GAP_PX,
  bubblePosition, bubbleContentOffset,
} from "./strip-scrub-gesture.js";
import { createDurableStore } from "./durable-store.js";
import { makeIdbTier } from "./idb-tier.js";
import {
  createMediaSession, mediaSessionView, SEEK_BACKWARD_SEC, SEEK_FORWARD_SEC,
} from "./media-session.js";
import {
  readRate, writeRate, nextRate, normalizeRate, rateLabel, rateAriaLabel, RATES,
} from "./playback-rate.js";

/* The in-page buttons and the lock screen use ONE pair of numbers, imported
   rather than declared twice — `04_VOICE_AUDIO_SPEC.md`'s "±30/15 s seek". */
const SEEK_BACK = SEEK_BACKWARD_SEC;
const SEEK_FWD = SEEK_FORWARD_SEC;

let manager = null;
let backend = null;
let positions = null;
let ui = null;
/** The lock screen / car / headphone surface (#27). Built once in
    `ensureBooted`, inert where `navigator.mediaSession` does not exist. */
let media = null;
/** Show name -> artwork URL, from `data/discover.json` when a caller hands it
    over. One map per Foray, not per tick. */
let artworkByShow = new Map();

/* ---------- durable storage (#40) ----------

   Built before anything else in this module, because everything below it stores
   something. `createDurableStore` drops any tier it cannot have, so a browser
   with no IndexedDB gets a localStorage-only store and a browser with neither
   gets one that works for the session and says so in `health()`. */
const storage = createDurableStore({
  localStorage: typeof localStorage !== "undefined" ? localStorage : null,
  idbTier: makeIdbTier({}),
  onFault: (fault, health) => {
    // The player cannot fix a dead tier. What it must not do is hide one.
    console.warn("[storage]", fault.tier, fault.op, fault.key ?? "", fault.error);
    if (typeof window.forayLogEvent === "function") {
      window.forayLogEvent("storage_fault", {
        tier: fault.tier, op: fault.op, key: fault.key, error: fault.error,
        durable_tiers: health.durableTiers, persisted: health.persisted,
      });
    }
  },
});

/* Started immediately, awaited by app.js before its first write. Rejection is
   impossible by construction (every tier failure is caught into `health()`), but
   an unhandled rejection here would take the module down, so it is attached. */
const storageReady = storage.hydrate().catch(() => storage);

/* A request, not a setting: Chromium may grant it silently, Firefox may prompt,
   Safari does not meaningfully honour it, and a refusal changes nothing about
   how this store behaves. Fired and forgotten — the answer lands in `health()`.
   Deliberately NOT awaited before hydration: exempting storage from eviction has
   nothing to do with reading what is already in it. */
storage.requestPersistence(typeof navigator !== "undefined" ? navigator : null).catch(() => {});

/* app.js is a classic script and cannot import this module, so the store is
   handed over the same way the event pipeline is. Published BEFORE any await so
   that app.js, whose `init()` parks on its first fetch, sees it. */
window.forayStorage = storage;
window.forayStorageReady = storageReady;
/** For a founder or a tester with a console open: the whole failure record. */
window.forayStorageHealth = () => storage.health();

/* Resume points are readable with nothing booted: the home screen asks for them
   before anything has been played, and booting an <audio> element to answer a
   question about storage would be absurd. */
const forayProgress = new ForayProgressStore({ storage });

/* ---------- the field record (#264) ----------

   LOCAL ONLY. Nothing below reaches `cp_events`, `trySyncEvents` or the network,
   and `player/diagnostic-log.js`'s header carries the argument: the `cp_events`
   pipeline has NO consent gate (`trySyncEvents()` is called unconditionally at
   `app.js:664` and `:686`), so routing a richer record of a person's listening
   through it would increase what is collected without one.

   Built at module evaluation like the store it writes through, but it READS
   lazily — `DiagnosticLog._load()` runs on the first write, and the first write is
   held until `storageReady` below. An earlier draft argued the laziness was enough
   on its own because "nothing records until the first seam, which is seconds after
   hydration". That was wrong: `diag.boot()` was itself a record, at module scope,
   ahead of hydration. The ordering is now explicit rather than inferred.

   `visibilitychange` is bound HERE and not in `bind()`, because a hidden window
   has to be measurable whether or not anything has been played: `bind()` runs
   inside `ensureBooted`, which does not happen until the first tap. */
const diagLog = new DiagnosticLog({ storage });
const diag = new PlayerDiagnostics({
  log: diagLog,
  isHidden: () => typeof document !== "undefined" && document.hidden === true,
});
/* EVERY WRITER WAITS FOR HYDRATION, and it is the LISTENER — not just the boot row
   — that has to wait. This ordering is load-bearing rather than tidy.

   The ring is read lazily on its first write, and that first write must not happen
   before `hydrate()` has pulled the IndexedDB tier up. localStorage is the tier
   Safari clears after about seven days without a visit, so the case where the two
   tiers disagree is the case where the durable copy is the ONLY copy — and a write
   that landed first would read an empty localStorage, stamp a newer `updatedAt`, win
   `isNewer`, and overwrite the record it was built to keep.

   A FIRST ATTEMPT AT THIS DEFERRED ONLY `diag.boot()` AND WAS NOT ENOUGH, which is
   why the registration itself is inside the `then` now: `visibility()` records too,
   and a listener who pockets the phone during the hydration window would have been
   the first writer. A transition genuinely missed inside that window costs one row
   and no data; the alternative cost the whole record.

   `storageReady` never rejects (every tier failure is caught into `health()`), but
   the catch is attached anyway. */
storageReady.then(() => {
  diag.boot();
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => diag.visibility(document.hidden === true));
  }
}).catch(() => {});

/** The record, as text, for the surface app.js builds. Published beside
    `forayStorageHealth` and for the same reason: app.js is a classic script and
    cannot import this module, so anything it needs is handed over on `window`. */
window.forayDiagnosticReport = () => formatDiagnosticReport(diagLog.read());
/**
 * Empty it — the founder's loop is clear, drive, copy, and three earlier drives in
 * the buffer make the drive under test hard to find.
 *
 * BOTH HALVES, and the second is not optional. `diagLog.clear()` removes the ring;
 * `diag.reset()` drops what is in flight. Without the reset, a Clear pressed during
 * playback leaves the open seam pointing at an entry no longer in the ring — so the
 * next boundary is written outside the record and lost, and the orphan's next stage
 * calls `save()`, putting `cp_diag` back one tick after it was deliberately removed.
 */
window.forayDiagnosticClear = () => { diagLog.clear(); diag.reset(); return true; };
/**
 * The same clear, for "Delete my data".
 *
 * A SEPARATE NAME FROM A SEPARATE CALLER, because the two are called at different
 * moments and one of them must not be early. `purge()` removes `cp_diag` from both
 * tiers like any other `cp_` key — but this module holds the ring IN MEMORY, so
 * without this the next `visibilitychange` writes every purged entry straight back
 * under a key a listener has just asked to be emptied. `app.js` calls it from the
 * LOCAL clear, not from `stopForDataDeletion`: a run that fails at the server step
 * leaves the device untouched on purpose, and that has to include this record.
 */
window.forayForgetDiagnostics = () => { diagLog.clear(); diag.reset(); return true; };
/**
 * A tap the PAGE saw fail, into the record (#225).
 *
 * The one thing the record could not see. Everything else in it is emitted from
 * inside this module or the element below it, so a failure that came back OUT of
 * `playForay` as an exception — a module skew, a queue that could not be built, a
 * rejection with no media event behind it — reached `app.js`'s guards, painted a
 * line on screen, and left the record with no entry for the tap at all. The
 * founder's "several errors" is exactly that class, and it is why #225's next
 * field report should arrive with evidence instead of a count.
 *
 * A BRIDGE AND NOT AN IMPORT because `app.js` is a classic script, like every
 * other `window.foray*` above it. It takes an error NAME, never a message: the
 * sanitising is done in `diagnostic-log.js` so that a caller of a different
 * vintage cannot get raw text into a record that gets pasted into issues.
 *
 * Returns a boolean rather than the entry, so nothing on the page can come to
 * hold a reference into the ring.
 */
window.forayNoteTapFailure = (phase, errorName) => {
  /* TOTAL FOR EVERY CALLER, not just for the one that has its own guard. `app.js`
     wraps its call because this bridge may be of a different vintage; that
     protects `app.js` and does nothing for the next caller. A published global
     that can throw is a hazard the next person inherits undocumented, so the
     boolean this already returns becomes the honest answer instead. */
  try {
    diag.tapFailed({ phase, name: errorName });
    return true;
  } catch (_) {
    return false;
  }
};

/* ---------- DOM ---------- */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function buildUI() {
  const root = el("div", "fp");
  root.id = "foray-player";
  root.hidden = true;

  /* mini bar */
  const bar = el("div", "fp-bar");
  const art = el("img", "fp-art");
  art.alt = "";
  const info = el("button", "fp-info");
  info.type = "button";
  info.setAttribute("aria-label", "Open player");
  const title = el("span", "fp-title");
  const show = el("span", "fp-show");
  info.append(title, show);

  const playBtn = el("button", "fp-play", "▶");
  playBtn.type = "button";
  playBtn.setAttribute("aria-label", "Play");

  const closeBtn = el("button", "fp-close", "✕");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Stop and close player");

  const progress = el("div", "fp-progress");
  const fill = el("div", "fp-fill");
  progress.append(fill);

  bar.append(art, info, playBtn, closeBtn);
  root.append(progress, bar);

  /* expanded sheet */
  const sheet = el("div", "fp-sheet");
  sheet.hidden = true;
  const sTitle = el("h2", "fp-s-title");
  const sShow = el("p", "fp-s-show");
  const sWhy = el("p", "fp-s-why");

  const scrub = el("input", "fp-scrub");
  scrub.type = "range";
  scrub.min = "0";
  scrub.max = "1000";
  scrub.value = "0";
  scrub.setAttribute("aria-label", "Seek");

  const times = el("div", "fp-times");
  const tNow = el("span", "fp-now", "0:00");
  const tLeft = el("span", "fp-left", "--:--");
  times.append(tNow, tLeft);

  const row = el("div", "fp-row");
  const backBtn = el("button", "fp-btn", `↺ ${SEEK_BACK}`);
  backBtn.type = "button";
  backBtn.setAttribute("aria-label", `Back ${SEEK_BACK} seconds`);
  const bigPlay = el("button", "fp-btn fp-big", "▶");
  bigPlay.type = "button";
  bigPlay.setAttribute("aria-label", "Play");
  const fwdBtn = el("button", "fp-btn", `${SEEK_FWD} ↻`);
  fwdBtn.type = "button";
  fwdBtn.setAttribute("aria-label", `Forward ${SEEK_FWD} seconds`);
  row.append(backBtn, bigPlay, fwdBtn);

  const row2 = el("div", "fp-row2");
  const rateBtn = el("button", "fp-rate", "1×");
  rateBtn.type = "button";
  rateBtn.setAttribute("aria-label", "Playback speed");
  const openLink = el("a", "fp-openep", "Open episode ↗");
  openLink.target = "_blank";
  openLink.rel = "noopener";
  /* The bar already survives navigation — it lives on <body>, not inside
     #view — but until now there was no way BACK. Leaving the foray page to look
     at something else meant the running order, the segment you were on and the
     thumbs were all gone until you found the URL again. This is that way back,
     and it is an in-app hash route, never an external link. */
  const forayLink = el("a", "fp-openep fp-toforay", "Back to the running order");
  forayLink.hidden = true;
  const collapse = el("button", "fp-collapse", "Close");
  collapse.type = "button";
  row2.append(rateBtn, openLink, forayLink, collapse);

  const note = el("p", "fp-note");

  sheet.append(sTitle, sShow, sWhy, scrub, times, row, row2, note);
  root.append(sheet);
  document.body.append(root);

  return {
    root, bar, art, title, show, playBtn, closeBtn, fill, sheet,
    sTitle, sShow, sWhy, scrub, tNow, tLeft, bigPlay, backBtn, fwdBtn,
    rateBtn, openLink, forayLink, collapse, info, note,
  };
}

/* ---------- state -> DOM ---------- */

let current = null;
let scrubbing = false;

/** The Foray being played, or null for ordinary single-episode playback.
    `{ resolved, index, onChange, error }`.

    `index` is the segment the LISTENER is on, which is not the same as the one
    the backend has finished loading — the same distinction the manager keeps as
    `_targetIndex` vs `currentIndex`. It matters here for a plain reason: a load
    can take a second (or hit its ten-second deadline), and a running order that
    only highlights the new row once the bytes arrive looks broken. Intent is
    painted immediately; a divergence is reconciled by `syncForaySegment`. */
let foray = null;

function isPlaying() {
  return manager?.state?.type === "playing";
}

/** Is the Foray RUNNING, as a listener would say it?
 *
 *  Wider than `isPlaying()` by exactly one state: the 2.0 s seam beat between
 *  two unbridged segments (`player/seam-gap.js`). Structurally that is
 *  `loadingItem`, so `isPlaying()` is false — but nobody has pressed anything,
 *  the Foray is advancing on its own, and the only sane meaning for the main
 *  button during those two seconds is STOP.
 *
 *  Every play/pause control goes through this. The first draft changed the
 *  Foray page's LABEL to "❚❚ Pause" during a beat while `forayToggle` still
 *  branched on `isPlaying()` — so the button said Pause and started audio. */
function isRunning() {
  return isPlaying() || manager?.inSeamGap === true;
}

/**
 * Where we are in the Foray's own seconds, or NULL when the player cannot say.
 *
 * Null is the whole point of this function existing (#263). The element's clock
 * only means something about a particular piece of audio, and there are ordinary
 * moments when it means nothing about the segment on screen:
 *
 *   - mid-jump, before the load lands; and
 *   - after a load FAILED, which is the reported case. `_loadItem` moves
 *     `currentIndex` before calling `backend.load`, and assigning `src` resets
 *     the element's `currentTime` to 0 — so a seam whose load timed out leaves
 *     the manager pointing at segment N+1 with a playhead of 0. Reading that
 *     through `forayElapsed` produces the segment's IN-POINT, a position the
 *     listener was never at, and the writer below was storing it over a good
 *     resume row. That is the founder's "restarted the segment".
 *
 * `playheadItemId` is the manager's answer to "which item is the playhead
 * about", and asking it is what separates a real position from a fabricated one.
 */
function forayPlayhead() {
  if (!foray || foray.index < 0) return null;
  if (manager?.currentIndex !== foray.index) return null;
  const item = foray.resolved.playable[foray.index];
  if (!item || !item.id || manager?.playheadItemId !== item.id) return null;
  const t = backend?.currentTime;
  if (typeof t !== "number" || !Number.isFinite(t)) return null;
  return forayElapsed(foray.resolved.playable, foray.index, t);
}

/** Where we are, in the Foray's own seconds — a number, always, because a clock
    has to paint something, and with no readable playhead the honest answer for a
    display is the segment's start. NOT for deciding what to write down: a
    display that rounds down for one frame costs nothing, and a stored row that
    rounds down costs the listener the part of the hour they had reached. Use
    `forayPlayhead` for that, and only that. */
function forayPosition() {
  if (!foray || foray.index < 0) return 0;
  return forayPlayhead() ?? forayElapsed(foray.resolved.playable, foray.index, null);
}

/**
 * Move the listener to `index`: now-playing, the page and the position all
 * follow from this one call, whether the move was a click or an out-point.
 *
 * `pendingFrom` records where the manager was when we asked. Until the manager
 * either arrives at `index` or lands somewhere else entirely, `syncForaySegment`
 * must leave our intent alone — the first draft did not, and the nested render
 * inside `setNowPlaying` immediately reconciled every jump straight back to the
 * segment we were leaving. Prev and next looked completely dead.
 */
function setForayIndex(index, { pending = true } = {}) {
  if (!foray) return;
  foray.index = index;
  foray.pendingFrom = pending ? (manager?.currentIndex ?? -1) : null;
  const item = foray.resolved.playable[index];
  if (item) setNowPlaying(forayNowPlaying(item, index), item.why);
  else notifyForay();
}

/** Reconcile with the manager when IT moved us — the out-point path, where the
    backend reports an end and the manager loads the next segment with nothing
    in this file involved. Called from render(), which every relevant media
    event already drives, so no new callback is needed on the manager. */
function syncForaySegment() {
  if (!foray) return;
  /* AN ERROR CANNOT SURVIVE AUDIO (#225). `foray.error` describes the last
     ATTEMPT, and a player that is producing sound has plainly moved past it.
     Without this the field stands for the rest of the session: the surface reads
     "an error, and nothing playing" as a failed start, so the listener pressing
     pause ten minutes later would have the page decide their Foray had never
     started — and offer to resume them at the position the page opened on. */
  if (foray.error && isPlaying()) foray.error = null;
  const index = manager?.currentIndex ?? -1;
  if (index < 0) return;
  if (index === foray.index) { foray.pendingFrom = null; return; }
  // A jump we asked for is still in flight and the manager has not moved yet.
  // Leave it; the load will land or fail, and either way we hear about it.
  if (foray.pendingFrom != null && index === foray.pendingFrom) return;
  foray.error = null;
  setForayIndex(index, { pending: false });
}

/** The mini-player wants a catalogue-shaped item; a queue item is close but
    names the episode rather than the segment.

    The bar leads with the FORAY's title, not the source episode's — the mockup's
    `MiniPlayer` does the same, and for the same reason: the episode title
    changes nine times over the hour and is not the thing being listened to. The
    show is on the second line, which is where the mockup puts it too
    (`Now: <show name>`), extended with the part number because a Foray's second
    line has room and "part 12 of 32" is the one fact a mini bar can add. */
function forayNowPlaying(item, index) {
  const total = foray.resolved.playable.length;
  const show = item.show ? `Now: ${item.show}` : "Now playing";
  return {
    id: item.id,
    title: foray.resolved.title || item.title || "",
    show: `${show} · part ${index + 1} of ${total}`,
    duration_sec: null,
    dai_suspected: Boolean(item.dai_suspected),
  };
}

/** Everything a page needs to paint itself, in Foray terms. */
function forayStateSnapshot() {
  if (!foray) return null;
  return {
    forayId: foray.resolved.id,
    index: foray.index,
    loading: manager?.state?.type === "loadingItem",
    playing: isPlaying(),
    /* The 2.0 s seam beat between two unbridged segments (player/seam-gap.js).
       Structurally this is `loadingItem` too, but calling it "Loading…" on the
       page would be the app apologising for a silence it chose on purpose —
       and it is the one state where pressing the main button has to mean
       "stop", not "start". */
    gap: manager?.inSeamGap === true,
    ended: manager?.state?.type === "ended",
    elapsedSec: forayPosition(),
    totalSec: foray.resolved.totalSec,
    // A segment that would not load is the failure a listener actually meets,
    // and it is silent otherwise: the manager pauses and the page just sits
    // there. Hand it up so the surface can say what happened.
    error: foray.error ?? null,
    /* The chosen speed, so the Foray page can label its own speed button from the
       same value the mini-player's is labelled from (#242). On the snapshot rather
       than fetched by the page for one reason: the page repaints from `onChange`,
       and a tap on EITHER button has to move BOTH — `applyRate` notifies, so it
       does. */
    rate: currentRate(),
  };
}

function notifyForay() {
  if (foray?.onChange) foray.onChange(forayStateSnapshot());
}

/**
 * Write down where the listener is, so closing the tab does not cost them the
 * hour they were part-way through.
 *
 * Called from `render()`, which every media event already drives, so there is no
 * second timer — the store throttles the 4 Hz tick down to one write per five
 * seconds of movement. `force` is for the moments where the next tick may never
 * arrive: pause, page-hide, and closing the bar.
 *
 * Reaching the end CLEARS the row rather than storing "100%". A finished Foray
 * that keeps offering "0 min left" on the home screen is worse than one that
 * quietly goes back to being unplayed.
 */
function persistForayProgress({ force = false } = {}) {
  if (!foray || foray.index < 0) return;
  const id = foray.resolved.id;
  /* ── THE RESUME DECISION, RECORDED (#264) ────────────────────────────────
     ONLY ON `force`, and the rule is not arbitrary. This function runs from
     `render()`, which every media event drives, so the unforced path is a 4 Hz
     tick and recording it would flood a 200-entry ring inside a minute. `force`
     is exactly the set of moments a resume point becomes the thing read back
     next time — pause, page-hide, closing the bar, and the #263 reconcile — and
     it is bounded by human actions rather than by the clock.

     THE REFUSALS ARE THE HALF THAT MATTERS. The second field report was a WRONG
     RESUME, and the path that declines to write (below, when the playhead is
     unknown after a failed load) is the path with no record of what it did. A
     forced write that refused is the defect; a throttled tick that refused is
     noise, which is the other reason this is gated on `force`. */
  const note = (fields) => { if (force) diag.resumeWrite({ forayId: id, index: foray.index, ...fields }); };
  if (manager?.state?.type === "ended") {
    forayProgress.clear(id);
    note({ wrote: false, why: "finished-cleared" });
    return;
  }
  /* A resume is TWO steps — load the segment at its in-point, then seek into it
     — and the load fires real media events in between. Without this the tick
     between them writes the segment's in-point over the precise position we are
     in the middle of restoring, and a resume that then failed (or a tab closed
     inside that second) would have quietly rounded the listener back by up to a
     whole segment, again on every attempt. */
  if (foray.resumeSeekPending) { note({ wrote: false, why: "resume-in-flight" }); return; }
  /* WHICH segment, not only which index (#40). `data/forays.json` is served
     network-first, so the document this row is read back against can have moved
     a segment or lost one — and an index is a position, which stops meaning
     anything the moment the order changes. The authored id plus the offset INTO
     the segment is what survives that; see `reconcileSegment`. */
  /* THE POSITION HAS TO BE ONE WE ACTUALLY READ (#263). `forayPlayhead` is null
     mid-jump — which is what the `currentIndex !== foray.index` check used to
     cover — and it is also null after a load FAILED, which nothing covered: the
     element's clock had been reset to 0 by the `src` assignment while the manager
     had already moved to the segment that would not load, so `forayPosition()`
     honestly reported that segment's in-point and this function wrote it down.
     The founder then re-opened the site and got sent back to the start of a
     segment, having asked for none of it.

     Refusing to write is the whole fix, and it is deliberately not "write
     something better": at that moment nobody knows where the listener was. The
     last row still says where they got to, at most SAVE_EVERY_SEC of clock
     earlier, which is a few seconds before the boundary they stopped at — and
     five seconds of a segment they had already heard is not a defect. An unknown
     position must never overwrite a known one. */
  const elapsedSec = forayPlayhead();
  if (elapsedSec == null) { note({ wrote: false, why: "playhead-unknown" }); return; }
  const seg = forayProgressSegments()[foray.index] ?? null;
  /* `wrote` IS THE STORE'S ANSWER, NOT OUR INTENTION. `ForayProgressStore.save`
     returns false when `writeProgress` is refused — a full localStorage with no live
     durable tier — and counts it into `refusedWrites`. An earlier draft recorded
     `wrote: true` before this call and threw the return value away, which put a false
     statement in the one row that exists because "there is no record of what the
     error path wrote". A diagnostic that lies is worse than a missing one. */
  const wrote = forayProgress.save({
    forayId: id,
    title: foray.resolved.title,
    elapsedSec,
    totalSec: foray.resolved.totalSec,
    index: foray.index,
    segmentId: seg ? seg.id : null,
    intoSec: seg ? Math.max(0, elapsedSec - seg.startSec) : 0,
    force,
  });
  note({
    wrote,
    ...(wrote ? {} : { why: "store-refused" }),
    elapsedSec: Math.round(elapsedSec),
    segmentId: seg ? seg.id : null,
    intoSec: seg ? Math.round(Math.max(0, elapsedSec - seg.startSec)) : 0,
  });
}

/** The live running order in the shape a stored row is reconciled against.
    Computed once per Foray, not once per tick: `render()` runs at 4 Hz and this
    walks all 32 segments. */
function forayProgressSegments() {
  if (!foray) return [];
  if (!foray.segments) foray.segments = progressSegments(foray.resolved);
  return foray.segments;
}

function render() {
  if (!ui || !current) return;
  syncForaySegment();
  // A seam beat reads as playing everywhere, or the mini bar shows "▶" while
  // the Foray page shows "❚❚ Pause" for the same two seconds.
  const running = isRunning();
  const glyph = running ? "❚❚" : "▶";
  ui.playBtn.textContent = glyph;
  ui.bigPlay.textContent = glyph;
  ui.playBtn.setAttribute("aria-label", running ? "Pause" : "Play");
  ui.bigPlay.setAttribute("aria-label", running ? "Pause" : "Play");

  // In a Foray the clock is the Foray's, not the source episode's: 31 minutes
  // into somebody else's podcast is not a position this listener recognises.
  const pos = foray ? forayPosition() : (backend?.currentTime ?? 0);
  const dur = foray ? foray.resolved.totalSec : (backend?.duration ?? current.duration_sec ?? null);

  if (!scrubbing && dur) {
    ui.scrub.value = String(Math.round((pos / dur) * 1000));
    ui.fill.style.width = `${Math.min(100, (pos / dur) * 100)}%`;
  }
  ui.tNow.textContent = foray ? fmtClock(pos) : formatTimestamp(pos, EXACT);
  ui.tLeft.textContent = dur
    ? `-${foray ? fmtClock(Math.max(0, dur - pos)) : formatTimestamp(Math.max(0, dur - pos), EXACT)}`
    : "--:--";
  syncCardButtons();
  // The lock screen is repainted from the same tick the page is, so the two can
  // never show different states (corner case #11's "lock screen shows correct
  // state"). It writes only when something actually changed.
  syncMediaSession();
  if (foray) {
    persistForayProgress();
    notifyForay();
  }
}

function syncCardButtons() {
  // Reflect play state on the originating card so the page and the bar agree.
  document.querySelectorAll("[data-play]").forEach((b) => {
    const on = current && b.dataset.play === current.id && isPlaying();
    if (on) b.dataset.playing = "1"; else delete b.dataset.playing;
    b.textContent = on ? "❚❚" : "▶";
  });
}

function setNowPlaying(item, why) {
  current = item;
  ui.root.hidden = false;
  document.body.classList.add("fp-open");
  ui.title.textContent = item.title || "";
  ui.show.textContent = item.show || "";
  ui.sTitle.textContent = item.title || "";
  ui.sShow.textContent = item.show || "";
  ui.sWhy.textContent = why || item.hook || "";
  if (item.artwork_url) {
    ui.art.src = item.artwork_url;
    ui.art.hidden = false;
  } else {
    ui.art.hidden = true;
  }
  if (item.apple_episode_url) {
    ui.openLink.href = item.apple_episode_url;
    ui.openLink.hidden = false;
  } else {
    ui.openLink.hidden = true;
  }
  if (foray) {
    // Our own route, built from our own id — the only interpolation here is
    // encodeURIComponent's output, so no scheme can be smuggled in.
    ui.forayLink.href = `#/foray/${encodeURIComponent(foray.resolved.id)}`;
    ui.forayLink.hidden = false;
  } else {
    ui.forayLink.hidden = true;
  }

  // Honest scrub affordance. On an ad-stitched feed our own playhead is
  // reliable for this listener (#22's corollary), so scrubbing is exact — but
  // any timestamp we might later show from chapters is not. Say nothing when
  // it's exact; say something plain when it isn't.
  const { precision } = seekPrecision(item, { isLocalFile: false, source: OWN });
  ui.note.textContent = precision === EXACT ? "" : "Timings on this show are approximate.";
  render();
}

/* ---------- playback speed (#242) ----------

   `player/playback-rate.js` owns the ladder, the labels and the stored value;
   `player/queue-manager.js` owns applying it across a Foray (its §12). This is
   the wiring, and there is exactly one of each function so the mini-player
   button, the Foray page button and a future lock-screen control cannot hold
   different opinions about what the speed is. */

/** The chosen speed, booted or not. `manager.rate` once there is one, because it
    is the thing that will actually be restored at the next seam; the stored value
    before that, because a listener can set the speed before pressing play. */
function currentRate() {
  return manager ? manager.rate : readRate(storage);
}

/* A LATE-HYDRATING STORE MUST NOT LEAVE A STALE SPEED ON SCREEN.
   `storage.getItem` serves memory, and memory is filled from localStorage
   synchronously but from the durable tier only when `hydrate()` finishes. Normally
   that has happened long before anything reads a rate — app.js awaits the same
   memoised `hydrate()` before `state.ready`, so `renderForay` runs after it, and
   `ensureBooted` runs later still, on a click. But app.js gives up on hydration
   after 5 s and renders anyway, and in the case `durable-store.js` exists for —
   localStorage evicted, IndexedDB intact — the value only arrives at the end. So
   repaint once when it lands. Read through `currentRate()`, so a listener who
   tapped inside that window keeps their choice rather than having the stored row
   overrule it. */
storageReady.then(() => { paintRate(); notifyForay(); }).catch(() => {});

/**
 * Apply and persist a speed.
 *
 * WORKS WITH NOTHING BOOTED, deliberately. Setting the speed before pressing play
 * is an ordinary thing to do on the Foray page, and booting an `<audio>` element
 * to record a number would be absurd — so with no manager this writes the value
 * and stops, and `ensureBooted` reads it back when the listener does press play.
 * That is also why `cp_rate` is the single source of truth rather than a variable
 * up here: the two entry points would otherwise disagree across a boot.
 *
 * The write is not guarded here because `writeRate` never throws: a speed that
 * cannot be stored is still a speed that should govern this session, and the
 * refusal lands in `storage.health()` like every other one.
 */
function applyRate(rate) {
  const r = normalizeRate(rate);
  writeRate(storage, r);
  if (manager) manager.setRate(r);
  paintRate(r);
  // The Foray page paints its own copy of this button, and a beat produces no
  // media event to repaint on — so tell it rather than waiting for a tick.
  notifyForay();
  return r;
}

/** Put the value on the button. Both the visible label and the accessible name,
    because `aria-label` REPLACES a button's text: without the second line a
    screen-reader user is told "Playback speed" and never told what it is. */
function paintRate(rate = currentRate()) {
  if (!ui) return;
  ui.rateBtn.textContent = rateLabel(rate);
  ui.rateBtn.setAttribute("aria-label", rateAriaLabel(rate));
}

/** The mini-player's speed picker (#349). Same fix as the Foray page's
    #fy-rate: this button used to cycle to the next stop on every tap, with no
    way to see or jump straight to any of the other five. Opens a small menu
    naming every stop on the ladder instead — copied from what Apple Podcasts,
    Spotify, Overcast and Pocket Casts all do — built fresh each open so it
    never shows a stale "current" mark, and torn down on any dismissal. */
let rateMenuEl = null;

function closeRatePicker() {
  if (!rateMenuEl) return;
  rateMenuEl.remove();
  rateMenuEl = null;
  document.body.classList.remove("fy-sheet-open");
}

function openRatePicker() {
  closeRatePicker();
  const current = currentRate();

  const wrap = el("div", "fy-sheet");
  const scrim = el("div", "fy-scrim");
  const panel = el("div", "fy-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");

  const grab = el("div", "fy-grab");
  grab.setAttribute("aria-hidden", "true");

  const title = el("h3", null, "Playback speed");
  title.id = "mp-rate-title";
  panel.setAttribute("aria-labelledby", "mp-rate-title");

  const list = el("div", "rate-options");
  for (const stop of RATES) {
    const isCurrent = stop === current;
    const opt = el("button", "rate-option" + (isCurrent ? " on" : ""), rateLabel(stop));
    opt.type = "button";
    if (isCurrent) opt.setAttribute("aria-current", "true");
    opt.addEventListener("click", () => {
      applyRate(stop);
      closeRatePicker();
    });
    list.append(opt);
  }

  const actions = el("div", "fy-sheet-actions");
  const cancel = el("button", "fy-sheet-cancel", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", closeRatePicker);
  actions.append(cancel);

  panel.append(grab, title, list, actions);
  wrap.append(scrim, panel);
  scrim.addEventListener("click", closeRatePicker);
  document.body.append(wrap);
  document.body.classList.add("fy-sheet-open");
  rateMenuEl = wrap;
}

/* ---------- transport, in one place ---------- */

/**
 * Start or stop, whoever asked.
 *
 * Extracted so the lock screen, the car and the headphone pinch route through
 * EXACTLY the code the in-page button runs — including the forced position
 * write, which matters more from a lock screen than from the page: a pause on a
 * car display is very often the last thing that happens before the tab is gone.
 *
 * `want` rather than a toggle, because MediaSession delivers `play` and `pause`
 * as two separate actions and a `play` that arrived while already playing must
 * not pause.
 */
async function setRunning(want) {
  if (!manager) return;
  if (want === isRunning()) { render(); return; }
  if (want) await manager.resume();
  else await manager.pause();
  render();
  persistForayProgress({ force: true });
}

/**
 * Take the player off screen and out of the OS's now-playing slot.
 *
 * `persist: false` exists for exactly one caller — the "delete my data" control
 * (#42). Every other stop flushes the resume point, and must: closing the bar is
 * "get this off my screen", not "I am done with this Foray". A stop that flushed
 * on the way into a deletion would write the row back one tick after it was
 * deleted, and the listener would be told their data was gone while their place
 * in the hour sat in both tiers.
 */
async function stopAndClose({ persist = true } = {}) {
  // Closing the bar is not "I am done with this Foray", it is "get this off my
  // screen". Keep the resume point; the only thing that clears it is finishing.
  if (persist) persistForayProgress({ force: true });
  await manager.stop();
  if (media) media.release();
  ui.root.hidden = true;
  ui.sheet.hidden = true;
  document.body.classList.remove("fp-open", "fp-expanded");
  current = null;
  // Same shape the live snapshot has, so the page never has to guess which
  // fields it got.
  const wasForay = foray;
  foray = null;
  if (wasForay?.onChange) {
    wasForay.onChange({
      forayId: wasForay.resolved.id, index: -1, loading: false, playing: false,
      ended: false, elapsedSec: 0, totalSec: wasForay.resolved.totalSec, error: null,
    });
  }
  syncCardButtons();
}

/* ---------- the lock screen, the car, the headphone pinch (#27) ----------

   `player/media-session.js` owns every decision — which field says what, what
   previous/next mean, which clock the position is on, and what a seam beat
   reports. This is only the wiring, and the two surfaces below are deliberately
   nothing but delegation: a lock-screen control that re-implemented any part of
   the transport would be a second opinion about it, and the two would diverge
   the first time either changed. */

/** In a Foray, previous/next are SEGMENTS — the same functions the ‹‹ / ››
    buttons call, so `forayPrevious`'s restart-vs-previous window is inherited
    rather than restated. Seeking is on the Foray's clock, through the scrubber's
    own path. */
const forayMediaSurface = {
  play: () => setRunning(true),
  pause: () => setRunning(false),
  stop: () => stopAndClose(),
  next: () => ForayPlayer.forayNext(),
  previous: () => ForayPlayer.forayPrevious(),
  seekBy: (offset) => ForayPlayer.foraySeek(Math.max(0, forayPosition() + offset)),
  seekTo: (position) => ForayPlayer.foraySeek(position),
};

/** One episode has no next: the queue is one item (`SINGLE_ITEM`, product
    principle 1 — no autoplay chains), so `next`/`previous` are absent and the
    OS greys those buttons out instead of offering ones that do nothing. */
const episodeMediaSurface = {
  play: () => setRunning(true),
  pause: () => setRunning(false),
  stop: () => stopAndClose(),
  seekBy: (offset) => manager.seek(Math.max(0, (backend?.currentTime ?? 0) + offset), { precise: true }),
  seekTo: (position) => manager.seek(position, { precise: true }),
};

/** Live state -> the pure view the bridge writes. Called from `render()`, which
    every media event and the seam-beat hook already drive, so there is no second
    timer and no polling. */
function syncMediaSession() {
  if (!media || !media.supported) return;
  // Nothing loaded: `render()` already returns before this, and closing the
  // player goes through `stopAndClose`, which calls `release()` — clearing here
  // would drop the metadata and LEAVE the handlers installed, which is the
  // stale-handler bug wearing a tidier face.
  if (!current) return;

  if (foray) {
    const items = foray.resolved.playable;
    const index = foray.index >= 0 ? foray.index : 0;
    media.update(mediaSessionView({
      item: items[index] ?? null,
      nextItem: items[index + 1] ?? null,
      forayTitle: foray.resolved.title,
      index,
      total: items.length,
      showArtworkUrl: artworkByShow.get(items[index]?.show ?? "") ?? null,
      durationSec: foray.resolved.totalSec,
      positionSec: forayPosition(),
      /* THE ELEMENT'S REAL RATE, not the chosen one, and the distinction is the
         whole honesty requirement. The OS extrapolates the playhead forward as
         `position + rate x wall` between our reports, so a rate the element is not
         actually running at makes the lock-screen scrubber drift away from the
         audio — which is worse than no scrubber. `backend.rate` reads the element
         and falls back to what we asked for only when it has no usable answer, so
         a speed Safari refused is a speed the lock screen does not claim.
         The clock these seconds are on is the FORAY's, which is media time, so the
         extrapolation is dimensionally right: position and duration are content
         seconds and the rate is content-per-wall. */
      playbackRate: backend?.rate ?? 1,
      playing: isPlaying(),
      // The 2.0 s authored beat reads as playing, exactly as `isRunning()` has
      // it for the in-page buttons. `media-session.js` §4 is the argument.
      inSeamGap: manager?.inSeamGap === true,
      ended: manager?.state?.type === "ended",
    }));
    return;
  }

  media.update(mediaSessionView({
    item: current,
    forayTitle: "",
    index: 0,
    total: 0,
    showArtworkUrl: current.artwork_url ?? null,
    durationSec: backend?.duration ?? current.duration_sec ?? null,
    positionSec: backend?.currentTime ?? 0,
    /* The rate the element is really running at, for the reason spelled out
       above. A BLOCK comment, deliberately: `media-session.test.js` scans this
       file with a stripper that removes `//` comments LAST, so an apostrophe in
       one reads as an unterminated string literal and swallows the code after it
       until the next apostrophe — which is exactly how "element's" here turned
       four of that suite's wiring assertions red. Block comments go first and are
       safe. */
    playbackRate: backend?.rate ?? 1,
    playing: isPlaying(),
    ended: manager?.state?.type === "ended",
  }));
}

/* ---------- wiring ---------- */

function bind() {
  const toggle = () => setRunning(!isRunning());
  ui.playBtn.addEventListener("click", toggle);
  ui.bigPlay.addEventListener("click", toggle);

  ui.closeBtn.addEventListener("click", () => stopAndClose());

  const setExpanded = (open) => {
    ui.sheet.hidden = !open;
    document.body.classList.toggle("fp-expanded", open);
  };
  ui.info.addEventListener("click", () => setExpanded(ui.sheet.hidden));
  ui.collapse.addEventListener("click", () => setExpanded(false));
  // Following the route with the sheet still open would leave the Foray page
  // rendered underneath a full-height overlay.
  ui.forayLink.addEventListener("click", () => setExpanded(false));

  // In a Foray these are previous/next SEGMENT, not ±15/30 s: a segment here is
  // often under two minutes, so a 30-second nudge mostly leaves it anyway, and
  // "leave this one" is what the button should mean.
  ui.backBtn.addEventListener("click", async () => {
    if (foray) return ForayPlayer.forayPrevious();
    await manager.seek(Math.max(0, (backend.currentTime ?? 0) - SEEK_BACK), { precise: true });
    render();
  });
  ui.fwdBtn.addEventListener("click", async () => {
    if (foray) return ForayPlayer.forayNext();
    await manager.seek((backend.currentTime ?? 0) + SEEK_FWD, { precise: true });
    render();
  });

  ui.scrub.addEventListener("input", () => { scrubbing = true; });
  ui.scrub.addEventListener("change", async () => {
    const frac = Number(ui.scrub.value) / 1000;
    scrubbing = false;
    if (foray) {
      await ForayPlayer.foraySeek(frac * foray.resolved.totalSec);
      return;
    }
    const dur = backend?.duration ?? current?.duration_sec;
    if (dur) await manager.seek(frac * dur, { precise: true });
    render();
  });

  ui.rateBtn.addEventListener("click", () => openRatePicker());

  // Corner case #17: pocketing the phone must not lose the position. This is
  // the path that actually matters on mobile — beforeunload is unreliable there.
  const flush = () => {
    if (current && isPlaying()) manager._persistPosition();
    // Unconditional, unlike the line above: a Foray paused at 23:14 and then
    // backgrounded must still remember 23:14.
    persistForayProgress({ force: true });
    /* The durable write cannot be awaited here — `pagehide` has no way to hold
       the page open, and an IndexedDB commit is asynchronous. That is survivable
       and deliberately so: the localStorage tier is written SYNCHRONOUSLY by the
       line above, so the position is on disk before this handler returns, and the
       next `hydrate()` copies it down into IndexedDB. Kicking the queue costs
       nothing and often wins the race anyway. */
    storage.flush().catch(() => {});
  };
  /**
   * Coming BACK is a boundary too, and that is the whole of #263.
   *
   * The founder drove with the screen off, switched the car off, and the audio
   * route vanished — the audio stopped, correctly. When he re-opened the app the
   * transport still said playing, so his first press went on correcting the
   * app's belief and his second one did what he had wanted. One press must do
   * what the listener meant.
   *
   * This handler only ever flushed on the way OUT, so the surface kept whatever
   * state it last wrote for however long the page was gone. A stop that happened
   * while the page was suspended left no event to catch, but it left the element
   * paused — and `paused` can be read at any later moment. Becoming visible is
   * the boundary where a stop the page could not observe becomes observable, so
   * it is where the surface stops trusting itself and asks.
   *
   * `reconcileWithBackend` never starts audio and is idempotent, so this is safe
   * to fire on every return; `render()` afterwards only because the correction
   * happened outside the media events that normally drive it.
   */
  const reconcileOnReturn = async () => {
    if (!manager) return;
    const corrected = await manager.reconcileWithBackend("visible");
    /* REPAINTED WHETHER OR NOT ANYTHING WAS CORRECTED, and that is not belt and
       braces. Every repaint in this file is driven by a media event, and the last
       thing that happens at the end of a Foray is `pausePlayback` against an
       element that is ALREADY paused — which fires nothing. So the surface can be
       holding a frame from before the state moved with no event left to come and
       fix it. A repaint costs one pass over a handful of nodes and starts no
       audio; a stale transport costs a press. */
    render();
    if (!corrected) return;
    /* WHICH STATE IT LANDED IN (#264/#266). `reconcileWithBackend` emits
       `reconcile.externalStop why=visible` BEFORE it runs the reducer, so the
       record's `stop` row is written with `state: null` — stamping it at emit time
       would record `playing`, which is about to stop being true. This is the one
       place the landed state is readable: the correction happens inside the
       player, and only this caller awaits it. */
    diag.reconciled("visible", manager?.state?.type ?? null);
    /* The playhead the route died at. The reconcile's own `savePosition` covered
       the episode row; a Foray keeps its position in its own store and on its own
       clock, so it needs saying separately — and it can be said, because the
       element still holds this segment's audio at the moment it stopped. */
    persistForayProgress({ force: true });
  };

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { flush(); return; }
    /* Nothing awaits an event handler, so the rejection needs somewhere to land
       other than the console's unhandled bucket — and a reconcile that failed
       must not be the reason the surface never repaints at all. */
    reconcileOnReturn().catch((err) => console.warn("[player] reconcile failed", err));
  });
  window.addEventListener("pagehide", flush);
}

function ensureBooted() {
  if (manager) return;

  /* Read BEFORE the manager is built, so `manager.rate` is never momentarily
     wrong: `render()` can run from a media event before anything else in this
     function finishes, and a label that paints "1×" and then corrects itself is
     the flicker this whole feature is about. */
  const rate = readRate(storage);

  positions = new PositionStore({
    storage,
    onSave: (id, seconds, meta) => {
      // Ride the existing event pipeline; app.js owns it.
      if (typeof window.forayLogEvent === "function") {
        window.forayLogEvent("position", { episode_id: id, seconds, duration: meta.duration ?? null });
      }
    },
  });

  /* THE BACKEND GETS THE SINK TOO (#264), and its absence was the whole reason
     the field record could not answer #224.

     Every number that bounds a seam is emitted at the ELEMENT layer, not the
     manager's: `outPoint.reached … overshoot=`, `load.deadline Nms (hidden|visible)
     for X`, `load.sameSource`, `audio.error code=`, `play.rejected`. This
     constructor took no `telemetry` at all, so all of it went nowhere — the iOS CI
     probe reads exactly these strings and this page discarded them. A record built
     on the manager's stream alone knows a seam happened and not how long its load
     took or whether it was a cold cross-origin fetch, which is precisely the
     question #239's 20 s deadline was tuned against a bundled local file to answer.

     `onTelemetry` is hoisted (a function declaration below), so referencing it here
     is safe and keeps the sink defined once. */
  backend = new HtmlAudioBackend({ telemetry: onTelemetry });
  manager = new PlayerQueueManager({
    backend,
    positionStore: positions,
    strategy: SINGLE_ITEM,
    /* The stored speed, as STATE. It reaches the element through the `setRate`
       below — the constructor deliberately touches no backend — but the manager
       has to know it from the first instant, because `restoreRate` fires on the
       very first `itemLoaded` and that is the load a stored 1.5x used to be
       thrown away on. */
    rate,
    /* A seam beat produces NO media events — the element is paused for the
       whole 2 s, so `timeupdate` has stopped and neither `play` nor `pause`
       fires. Without this hook the page keeps whatever frame it had when the
       out-point landed (which says "Loading…") and the `gap` flag never
       reaches it at all, so the beat is invisible and the main button still
       means "start". This is the only repaint during a beat, at both edges. */
    onSeamGapChange: () => render(),
    telemetry: onTelemetry,
  });

  /* The one sink, for BOTH the manager and the backend (#264). Extracted from the
     manager's option so it can be handed to the element layer as well — see
     `HtmlAudioBackend` above.

     THE CONSOLE HALF IS UNCHANGED, and deliberately so: it drives `foray.error`,
     which is a listener-facing surface, and that is a different job from measuring
     the seam. The one behavioural consequence of the second caller is that a media
     error and a refused `play()` now also reach `console.warn`, which is an
     improvement on reaching nothing — and neither matches the narrower
     `foray.error` test below, so the Foray page's standing-error rule is untouched
     (#225's argument still holds exactly as written). */
  function onTelemetry(m) {
      /* FIRST, AND BEFORE THE FILTER (#264). Everything diagnostic used to be
         dropped by the regex below — `outPoint.reached … overshoot=0.003s`,
         `seam.gap.armed`, `load.deadline`, `prefetch.window` — because none of
         those words is "error", "rejected" or "skipped". The record takes the
         whole stream and keeps only numbers it matched and stage names from a
         fixed vocabulary; the message text itself is never stored. */
      diag.note(m);
      if (!/error|rejected|skipped/i.test(m)) return;
      console.warn("[player]", m);
      /* A Foray that stops on a dead segment must SAY so. Without this the
         manager pauses, the page keeps its highlight, and the only evidence is
         a console line nobody has open.

         `.atLoad` and nothing shorter (#225). `setQueueFromForay` emits one
         `foray.segment.skipped[i]` per segment the BUILD dropped, synchronously
         inside `playForay` and before any audio is attempted — a property of the
         running order, which the page already states in its own words ("2
         segments can't play — listed below"). Catching those here stamped a
         standing error on a Foray that was about to play perfectly well, and a
         standing error is indistinguishable from a failed attempt. A skip
         discovered at LOAD is the other thing: the listener's segment, refused
         with the audio in hand. */
      if (foray && /player\.error|segment\.skipped\.atLoad/i.test(m)) {
        foray.error = m;
        notifyForay();
      }
  }

  /* The lock screen / car / headphone surface (#27). `createMediaSession`
     returns an inert bridge where `navigator.mediaSession` is absent — desktop
     Safari, older browsers — so nothing below ever has to check.

     Built BEFORE the DOM, deliberately. `ensureBooted` is guarded by
     `if (manager) return`, so if `buildUI()` ever threw, every later call would
     skip re-initialisation and `play()` would die on `media.setActions` — a
     TypeError producing a perfect, inert page, which is the exact class of
     failure `player/foray-playback.test.js` exists to catch. Nothing here needs
     the DOM, so nothing here waits for it. */
  media = createMediaSession({
    nav: typeof navigator !== "undefined" ? navigator : null,
    MediaMetadata: typeof window !== "undefined" ? window.MediaMetadata : null,
  });

  ui = buildUI();
  bind();

  /* Through the durable store, like every other cp_ key: a playback rate is
     small, but "the app forgot I listen at 1.5x" is the same defect in miniature.
     `manager.setRate`, not `backend.setRate` — the manager is what re-applies it
     at every seam, and going round it would restore the old defect exactly. */
  manager.setRate(rate);
  paintRate(rate);

  /* `addMediaListener`, NOT `backend.el.addEventListener`, and this is not a
     style preference. The backend now owns two `<audio>` elements and hands the
     player role between them at every cross-episode seam
     (`html-audio-backend.js` §"prefetch"). A listener bound to one element
     directly is left attached to a paused, src-less element from the first seam
     onwards — the transport would keep playing and this surface would silently
     stop repainting for the rest of the Foray, with no error anywhere. The
     backend migrates anything registered this way. */
  backend.addMediaListener("timeupdate", render);
  backend.addMediaListener("play", render);
  backend.addMediaListener("pause", render);

  /* The four element events the record needs, and no more (#264).

     `playing` is what CLOSES a seam — audio actually flowing, which is the only
     honest end point for `observedGapMs`; the manager's `itemLoaded` says the
     asset is ready, which is a different and earlier claim. `waiting` and
     `stalled` are the shape a network stall takes, and browsers fire them and
     never `error`, so they are the only evidence that separates "the load never
     settled" from "the beat's timer never fired". `ended` OPENS one: a file that
     runs out before its authored `end_sec` produces no `outPoint.reached` at all.

     `timeupdate` is deliberately absent. It fires at 4 Hz and is not a
     diagnostic, and a record that wrote localStorage on it would be the
     instrument perturbing the measurement — see `html-audio-backend.js:1534`.

     `addMediaListener`, like the repaints above, so these survive the handover
     to the second element at a cross-episode seam. */
  for (const type of ["playing", "waiting", "stalled", "ended"]) {
    backend.addMediaListener(type, () => diag.mediaEvent(type));
  }
}

/* ---------- public surface ---------- */

const ForayPlayer = {
  /** True when this item can play in-app. app.js uses it to decide whether to
      show a play button or fall back to the Apple Podcasts link (#25 note). */
  canPlay(item) {
    return Boolean(item && item.audio_url);
  },

  /** Play one episode. SINGLE_ITEM strategy: the queue is this episode and
      nothing follows it (CLAUDE.md principle 1 — no autoplay chains). */
  async play(item, { why = "" } = {}) {
    if (!this.canPlay(item)) return false;
    ensureBooted();
    // BEFORE the first await, always. See `notePlayGesture` (#225).
    backend.notePlayGesture();
    // Leaving a Foray for a single episode must not cost the last few seconds
    // of it — this is the only place `foray` is dropped without a flush.
    persistForayProgress({ force: true });
    foray = null;
    setSkipButtonMode(false);
    // Installed BEFORE the metadata is written, and it replaces the Foray's set
    // rather than adding to it: a stale `nexttrack` still pointed at a Foray
    // nobody is on is the one wiring bug this surface can hide.
    media.setActions(episodeMediaSurface);
    setNowPlaying(item, why);
    manager.setQueueFromPick(item);
    await manager.play(0);
    render();
    return true;
  },

  isPlaying(id) {
    return isPlaying() && current?.id === id;
  },

  /* ---------- Forays (#128) ---------- */

  /** The three-document join, re-exported so app.js resolves the running order
      with exactly the code that builds the queue. app.js is a classic script and
      cannot import an ES module, which is the whole reason this bridge exists. */
  resolve(foraysDoc, { id, segmentsDoc, sourcesDoc, unlocked = [] } = {}) {
    const doc = findForay(foraysDoc, id, { unlocked });
    if (!doc) return null;
    return resolveForay(doc, {
      segments: indexSegments(segmentsDoc),
      sources: indexSources(sourcesDoc),
    });
  },

  /** Which Forays may be listed for this visitor (drafts only when named). */
  listForays(foraysDoc, { unlocked = [] } = {}) {
    return listableForays(foraysDoc, { unlocked });
  },

  fmtClock,
  fmtSpan,

  /* ---------- the SegmentStrip (#128) ----------

     The strip is DOM, and app.js is a classic browser script that cannot import
     an ES module — the same reason `resolve` and `fmtClock` are bridged. Bridged
     as a MOUNT rather than as a model plus a copy of the renderer in app.js:
     two renderers for one element is how the strip and the running order would
     come to disagree about which segment is which.

     `document` is closed over here rather than passed in, so app.js never has
     to hand a global to the player. */
  stripInto(el, items, opts = {}) {
    return mountStrip(el, items, { ...opts, document });
  },

  /** The strip as data, for a caller that wants the numbers without the DOM —
      and for the accessible sentence, which the Now Playing sheet (#133) will
      want next to a strip it renders itself. */
  stripModel,
  stripSummary,

  /* ---------- press-and-hold zoom-to-scrub (V1) ----------

     Bridged for the same reason everything else on this object is: app.js is
     a classic script and cannot import strip-scrub-gesture.js directly. The
     gesture STATE MACHINE lives entirely in that pure module; app.js owns the
     real pointer listeners and the real setTimeout, and only calls through
     here to advance the state and read `zoomOriginPercent` for the CSS
     transform-origin. */
  scrubGesture: {
    HOLD_MS, MOVE_TOLERANCE_PX, ZOOM_SCALE,
    start: startGesture,
    move: moveGesture,
    holdTimeout: holdTimeoutGesture,
    end: endGesture,
    originPercent: zoomOriginPercent,
    /* ---------- floating magnifier bubble (V2) ---------- */
    BUBBLE_SCALE, BUBBLE_WIDTH, BUBBLE_HEIGHT, BUBBLE_GAP_PX,
    bubblePosition,
    bubbleContentOffset,
  },

  /* ---------- playback speed (#242) ---------- */

  /** The chosen speed, as a number. Readable before anything has booted, so a
      page can label its own control on first paint. */
  playbackRate() {
    return currentRate();
  },

  /** "1.5×" — re-exported so the Foray page's button and the mini-player's are
      written by the same function. app.js is a classic script and cannot import
      the module, which is the whole reason this bridge exists. */
  rateLabel(rate) {
    return rateLabel(rate);
  },

  /** The full ladder of selectable speeds, ascending — for a picker menu
      (rather than the cycle button) to enumerate. Re-exported for the same
      reason as rateLabel: app.js is a classic script and cannot import
      playback-rate.js directly. Returns a fresh array each call so a caller
      can't mutate the frozen source. */
  rateStops() {
    return [...RATES];
  },

  /** The accessible name, likewise. A page that wrote its own would be a second
      opinion about copy, and this one has to say the value because `aria-label`
      replaces the button's text. */
  rateAriaLabel(rate) {
    return rateAriaLabel(rate);
  },

  /**
   * Advance to the next speed and return it. The whole of what a button needs.
   *
   * Works with nothing playing: the value is stored and applied at the next boot,
   * so a listener can set the speed before pressing play. Not `async`, and that
   * is worth stating — `applyRate` touches storage synchronously and reaches the
   * element synchronously, so a caller wrapping this in a guard gets a real
   * return value rather than a promise.
   */
  cycleRate() {
    return applyRate(nextRate(currentRate()));
  },

  /** Set a specific speed, snapped onto the ladder. For a settings row or a
      console; the shipped controls all cycle. */
  setPlaybackRate(rate) {
    return applyRate(rate);
  },

  /** Which segment `elapsedSec` lands in, and how far into it — re-exported so
      the page paints the strip's fill with exactly the maths `foraySeek` uses
      to interpret a click on that same strip. A second implementation in
      app.js would be a scrubber whose bar and whose destination disagree. */
  segmentAt(playable, elapsedSec) {
    return segmentAtElapsed(playable, elapsedSec);
  },

  /** How long one queue item is, on the Foray clock — re-exported for the same
      reason `segmentAt` is. `app.js` sizes the strip's bars with it and maps a
      click onto `totalSec`, so a length it measures differently from this puts
      the click in the wrong place by the difference. A narration bridge is the
      case that made this matter: it has no bounds to subtract, so any private
      copy of the subtraction measures it as 0 s. */
  itemLen(item) {
    return itemRuntimeSec(item);
  },

  /**
   * Play a resolved Foray from `startIndex`, or from a position in the Foray's
   * own clock.
   *
   * @param {object} resolved  from `resolve()` above
   * @param {object} [opts]
   * @param {number} [opts.startIndex]
   * @param {number} [opts.startElapsedSec]  resume point, in FORAY seconds.
   *   Wins over `startIndex` when given, because it is strictly more specific:
   *   it names the segment AND the offset inside it. Seeking is a second step
   *   rather than a load offset on purpose — the manager loads a bounded segment
   *   at its in-point by contract (`queue-manager.js`'s `resumingInPlace`), and
   *   that contract is what keeps a Foray from starting mid-sentence in
   *   somebody else's episode.
   * @param {Function} [opts.onChange] called with `{ index, playing, ended,
   *   elapsedSec, totalSec }` on every position tick and every segment change —
   *   the page owns the running order, so it needs to be told, not to poll.
   * @param {object} [opts.discoverDoc] `data/discover.json`, the only document
   *   we have that carries per-show artwork. Optional and thin — it covers one
   *   of the twelve shows the shipped Forays draw on — so its absence costs the
   *   lock screen the publisher's square and nothing else (#27).
   * @returns the build report, or null when nothing is playable.
   */
  async playForay(resolved, {
    startIndex = 0, startElapsedSec = null, onChange = null, discoverDoc = null,
  } = {}) {
    if (!resolved || !resolved.playable.length) return null;
    ensureBooted();
    /* THE FIRST THING, AND BEFORE EVERY AWAIT BELOW (#225).

       This method is called straight out of a click handler, so this line is the
       last moment at which the tap can still be spent on the audio element. The
       load that follows resolves on a media event — a new task — and by then the
       gesture is gone and Safari is entitled to refuse the `play()` that ends
       this call. Both entry points on the Foray page (the main button, which
       passes `startElapsedSec`, and a running-order row, which passes
       `startIndex`) come through here, so both are covered by one line. */
    backend.notePlayGesture();
    foray = { resolved, index: -1, pendingFrom: null, onChange, error: null };
    setSkipButtonMode(true);
    // Once per Foray, not once per tick: this walks the whole discover pool.
    artworkByShow = artworkUrlsByShow(discoverDoc);
    // Previous/next become segment boundaries the moment a Foray is loaded.
    media.setActions(forayMediaSurface);

    const report = manager.setQueueFromForay(resolved.hydrated, {
      resolveItem: (itemId) => resolved.sources.get(itemId) ?? null,
    });

    const at = Number.isFinite(startElapsedSec) && startElapsedSec > 0
      ? segmentAtElapsed(report.items, startElapsedSec)
      : null;
    foray.resumeSeekPending = Boolean(at);
    // Paint the intent before awaiting the load: a running order that only
    // highlights the row once the audio arrives reads as a dead button.
    setForayIndex(clampIndex(at ? at.index : startIndex, report.items.length));
    try {
      /* WHAT WAS READ BACK, AND WHAT IT RESOLVED TO (#264). The page reads the
         row (`forayResume`) and hands the answer down as `startElapsedSec`; this
         is where that number becomes a segment and an offset inside it. Recorded
         as ONE row, before the load, because the pair is what the second field
         report needs and either half alone is unreadable: "resume at 1,240 s"
         means nothing without "segment 12, 41 s in", and a resume that then
         failed leaves this row saying where it was aiming. */
      diag.resumeStart({
        forayId: resolved.id,
        requestedElapsedSec: Number.isFinite(startElapsedSec) ? Math.round(startElapsedSec) : null,
        index: foray.index,
        segmentId: report.items[foray.index]?.id ?? null,
        intoSec: at ? Math.round(at.into) : 0,
        resolvedBy: at ? "elapsed" : "index",
      });
      await manager.play(foray.index);
      if (at) {
        const item = report.items[foray.index];
        if (item) await manager.seek(item.start_sec + at.into, { precise: true });
      }
    } finally {
      // Even if the load threw, the window has to close or this Foray would
      // never write a position again.
      if (foray) foray.resumeSeekPending = false;
    }
    render();
    return report;
  },

  /* ---------- resume across sessions ---------- */

  /**
   * Where this Foray was left, or null when there is nothing worth offering.
   *
   * `totalSec` and `itemCount` should describe the LIVE Foray — the document can
   * have changed since the row was written, and a resume point past the end of
   * the Foray as it exists now is a stale row, not a position.
   *
   * `resolved` is the stronger form of the same idea and is what the Foray page
   * passes (#40): with the whole running order in hand the stored SEGMENT can be
   * looked up rather than trusting the stored index, so a Foray whose segments
   * moved resumes to the same audio, and one whose segment is gone degrades to a
   * clamped clock instead of seeking somewhere wrong. `drift` says which
   * happened; the home rail, which has no resolved document, gets "unverified".
   *
   * @returns {{ elapsedSec, index, remainingSec, percent, finished, drift,
   *             label, clock, title } | null}
   */
  forayResume(forayId, { totalSec = null, itemCount = null, resolved = null } = {}) {
    const record = forayProgress.get(forayId);
    const segments = resolved ? progressSegments(resolved) : null;
    const total = isFiniteNum(totalSec) ? totalSec : (resolved ? resolved.totalSec : null);
    const count = Number.isInteger(itemCount) ? itemCount : (resolved ? resolved.playable.length : null);
    const maxIndex = Number.isInteger(count) && count > 0 ? count - 1 : null;
    const point = resumePoint(record, { totalSec: total, maxIndex, segments });
    if (!point || point.finished) return null;
    return {
      ...point,
      title: record.title || "",
      clock: fmtClock(point.elapsedSec),
      label: remainingLabel(point.remainingSec),
    };
  },

  /** Whether the document is the one this row was written against.
      "Clean" includes the two cases that are not drift at all: nothing was
      checked (`unverified`, the home rail), and there was nothing to check with
      (`unanchored` — every row written before segment ids existed, which is all
      of them on the day this ships). Only `moved` and `dropped` are drift. */
  forayDriftIsClean(point) {
    if (!point) return true;
    return point.drift === DRIFT_EXACT
      || point.drift === DRIFT_UNVERIFIED
      || point.drift === DRIFT_UNANCHORED;
  },

  /** Every Foray with a resume point, most recent first — the home screen's
      "Jump back in" rail. The CALLER still has to apply the draft rule: a stored
      position is not permission to list an unpublished Foray. */
  forayResumeList() {
    return forayProgress.list().map((r) => {
      const point = resumePoint(r);
      return {
        id: r.foray_id,
        title: r.title || "",
        updated_at: r.updated_at,
        elapsedSec: r.elapsed_sec,
        totalSec: r.total_sec,
        index: r.index,
        percent: percentDone(r.elapsed_sec, r.total_sec),
        finished: Boolean(point?.finished),
        label: point && !point.finished ? remainingLabel(point.remainingSec) : "",
      };
    });
  },

  /** Forget a Foray's position. The listener saying "start it again" is the only
      thing besides finishing that may do this. */
  clearForayResume(forayId) {
    forayProgress.clear(forayId);
  },

  /* ---------- who it is made of ---------- */

  /** The publisher credit block for a resolved Foray: which shows and episodes
      it draws on, how much of the runtime each carries, and where to go and
      subscribe. `discoverDoc` is optional and only ever upgrades a link from an
      Apple search to the show's real page. */
  forayCredits(resolved, { discoverDoc = null } = {}) {
    const credits = forayCredits(resolved, { collectionIds: collectionIdsByShow(discoverDoc) });
    return { credits, summary: creditsSummary(credits) };
  },

  /** The live Foray's state, or null when none is loaded. A page that
      re-renders (navigating away and back) needs to paint the CURRENT segment
      rather than assume nothing is playing. */
  forayStatus() {
    return forayStateSnapshot();
  },

  /**
   * Stop everything and write NOTHING — the first step of "delete my data"
   * (#42, `app.js`'s `deleteMyData`).
   *
   * A running player writes a position roughly every 15 seconds and a Foray
   * resume row with it, so a clear that ran underneath live playback would be
   * undone by the next tick — a success message over restored data, which is the
   * one outcome a delete control must never produce. Nothing booted is not an
   * error here: no element, no queue, nothing writing.
   */
  /**
   * Stop, and persist nothing on the way out.
   *
   * THE FIELD RECORD IS NOT CLEARED HERE, and that is a correction. This method runs
   * FIRST in `deleteMyData`, before the server step, and a remote failure returns
   * early with the device deliberately untouched — "its token is the only way back
   * to those rows". Clearing the ring here destroyed it on exactly that path: a
   * listener who is offline, taps Delete, fails the server call and then declines
   * "clear this device only" keeps every other `cp_` key and silently loses the one
   * record we asked them to collect. `forgetDiagnostics()` is called from the local
   * clear instead, which only runs when the device really is being emptied.
   */
  async stopForDataDeletion() {
    if (!manager || !ui) { foray = null; return false; }
    await stopAndClose({ persist: false });
    return true;
  },

  /** Re-point the change callback at a freshly rendered page. */
  watchForay(onChange) {
    if (foray) foray.onChange = onChange;
    return this.forayStatus();
  },

  /** Play/pause the Foray without rebuilding it. One code path with the mini
      bar and the lock screen, including the forced position write. */
  async forayToggle() {
    if (!foray) return;
    await setRunning(!isRunning());
  },

  async forayJump(index) {
    if (!foray) return;
    foray.error = null;
    setForayIndex(clampIndex(index, foray.resolved.playable.length));
    await manager.play(foray.index);
    render();
  },

  async forayNext() {
    if (!foray) return;
    const last = foray.resolved.playable.length - 1;
    if (manager.currentIndex >= last) return;
    foray.error = null;
    setForayIndex(manager.currentIndex + 1);
    await manager.skipToNext();
    render();
  },

  /**
   * Previous means "restart this segment" while we are inside it, and "the one
   * before" when we have only just started it — the convention every podcast
   * player uses, and the only one that is usable when segments are 90 seconds
   * long. The threshold is measured against the segment's own start, not the
   * episode's.
   */
  async forayPrevious() {
    if (!foray) return;
    foray.error = null;
    const index = manager.currentIndex;
    const item = foray.resolved.playable[index];
    const into = item ? (backend.currentTime ?? 0) - item.start_sec : 0;
    if (index > 0 && into < RESTART_WINDOW_SEC) {
      setForayIndex(index - 1);
      await manager.play(foray.index);
    } else {
      await manager.skipToPrevious();
    }
    render();
  },

  /** Seek to a position in the WHOLE Foray: find the segment, then the offset
      inside its source episode. */
  async foraySeek(elapsedSec) {
    if (!foray) return;
    const at = segmentAtElapsed(foray.resolved.playable, elapsedSec);
    if (!at) return;
    const item = foray.resolved.playable[at.index];
    if (at.index !== manager.currentIndex) {
      foray.error = null;
      setForayIndex(at.index);
      await manager.play(at.index);
    }
    await manager.seek(item.start_sec + at.into, { precise: true });
    render();
  },
};

/** Below this many seconds into a segment, "previous" means the segment before. */
const RESTART_WINDOW_SEC = 4;

const isFiniteNum = (n) => typeof n === "number" && Number.isFinite(n);

function clampIndex(index, length) {
  const n = Number.isInteger(index) ? index : 0;
  return Math.min(Math.max(0, n), Math.max(0, length - 1));
}

/** The ±15/30 s buttons become previous/next segment inside a Foray. */
function setSkipButtonMode(isForay) {
  if (!ui) return;
  ui.backBtn.textContent = isForay ? "‹‹" : `↺ ${SEEK_BACK}`;
  ui.fwdBtn.textContent = isForay ? "››" : `${SEEK_FWD} ↻`;
  ui.backBtn.setAttribute("aria-label", isForay ? "Previous segment" : `Back ${SEEK_BACK} seconds`);
  ui.fwdBtn.setAttribute("aria-label", isForay ? "Next segment" : `Forward ${SEEK_FWD} seconds`);
}

window.ForayPlayer = ForayPlayer;
/* app.js is a classic script and this is a deferred module, so app.js cannot
   assume the bridge exists when it renders. One event, once, rather than a
   poll. */
window.dispatchEvent(new Event("forayplayer:ready"));

export default ForayPlayer;
