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

import { PlayerQueueManager, NARRATION_RATE } from "./queue-manager.js";
import { HtmlAudioBackend } from "./html-audio-backend.js";
import { PositionStore } from "./position-store.js";
import {
  makeLastEpisode, writeLastEpisode, readLastEpisode, lastEpisodeState,
  episodeProgress,
} from "./episode-progress.js";
import { SINGLE_ITEM } from "./queue-strategy.js";
import { seekPrecision, formatTimestamp, EXACT, OWN } from "./seek-policy.js";
import { itemRuntimeSec } from "./foray-queue.js";
import { TTS } from "./queue-state.js";
import {
  resolveForay, indexSegments, indexSources, findForay, listableForays, allForays,
  forayElapsed, segmentAtElapsed, segmentStarts, fmtClock, fmtSpan, progressSegments,
  foraysReferencingShow,
} from "./foray-resolve.js";
import {
  ForayProgressStore, resumePoint, progressLabel, percentDone,
  DRIFT_EXACT, DRIFT_UNVERIFIED, DRIFT_UNANCHORED, DRIFT_DROPPED,
} from "./foray-progress.js";
import {
  DiagnosticLog, PlayerDiagnostics, formatDiagnosticReport,
} from "./diagnostic-log.js";
import { forayCredits, collectionIdsByShow, creditsSummary, artworkUrlsByShow } from "./foray-sources.js";
import { createForayDirectory, DIRECTORY_DB_NAME } from "./foray-directory.js";
import { mountStrip, stripModel, stripSummary, stripTally, segmentStripHtml, applyStripGrow, NARRATOR_NAME } from "./segment-strip.js";
import {
  HOLD_MS, MOVE_TOLERANCE_PX, ZOOM_SCALE,
  startGesture, moveGesture, holdTimeoutGesture, endGesture, zoomOriginPercent, unzoomedStripX,
  BUBBLE_SCALE, BUBBLE_WIDTH, BUBBLE_HEIGHT, BUBBLE_GAP_PX,
  bubblePosition, bubbleContentOffset,
} from "./strip-scrub-gesture.js";
import { startDrag, moveDrag, endDrag, dragOffset, claimsTouch } from "./sheet-drag-dismiss.js";
import { createDurableStore, preferencesTier, vaultTier } from "./durable-store.js";
import { readBuildStamp, BUILD_STAMP_WAIT_MS } from "./build-stamp.js";
import { createTtsBridge } from "./tts-bridge.js";
import { runKokoroProbe, formatProbeReport, probeVerdict } from "./kokoro-probe.js";
import { createInterludePlayer, readInterludePref, writeInterludePref } from "./interlude.js";
import { makeIdbTier } from "./idb-tier.js";
import { createEventLog } from "./event-log.js";
import {
  createMediaSession, mediaSessionView, SEEK_BACKWARD_SEC, SEEK_FORWARD_SEC,
} from "./media-session.js";
import {
  readRate, writeRate, nextRate, normalizeRate, rateLabel, rateAriaLabel, RATES,
} from "./playback-rate.js";
import { pickDefaultVoice, VOICE_LIST_LANG } from "./default-voice.js";
import * as continuation from "./continuation.js";

/* Continuous playback's rules (NE-13), for app.js: it decides what plays after
   an episode, and it is a classic script that cannot import them. Published at
   module evaluation, before `window.ForayPlayer` exists, so every caller that
   reaches app.js through the player finds the rules already there. */
window.forayContinuation = continuation;
/* The transport's DECISIONS live in transport-policy.js as pure functions
   (NE-08), so the native engine can port them and be checked against them.
   This file gathers the state, asks, and acts; it keeps no copy of a rule. */
import {
  resolveToggle, previousAction, episodePreviousRestarts, skipTarget, nudgeAction, scrubTarget,
  seekAction, remoteStopAction, clampEpisodeTarget, sourceOffsetFor,
  TOGGLE, PREVIOUS, NUDGE, SEEK, REMOTE_STOP,
} from "./transport-policy.js";

/* The in-page buttons and the lock screen use ONE pair of numbers, imported
   rather than declared twice — `04_VOICE_AUDIO_SPEC.md`'s "±30/15 s seek". */
const SEEK_BACK = SEEK_BACKWARD_SEC;
const SEEK_FWD = SEEK_FORWARD_SEC;

let manager = null;
let backend = null;
let positions = null;
/** Read-only position access that does NOT require the player to be booted.
 *
 *  Founder, 2026-09-21: "there is a progress bar on Forays but not on episodes".
 *  `lastEpisodeCard` is called while HOME renders, which happens in `route()` --
 *  before `restoreNowPlayingRibbon` calls `ensureBooted`. So `positions` was
 *  still null, the offset defaulted to 0, and the card drew an empty bar.
 *
 *  Deliberately NOT solved by booting the player from a home render: that would
 *  build the manager, the backend and two <audio> elements to paint a progress
 *  bar. `PositionStore` over the same durable store is a thin reader on the same
 *  `cp_pos:<id>` rows the booted one writes, so there is still ONE definition of
 *  a position -- this just reaches it earlier. The booted instance is preferred
 *  whenever it exists so a live session never reads a staler copy of itself. */
let positionsRead = null;
function positionReader() {
  if (positions) return positions;
  if (!positionsRead) positionsRead = new PositionStore({ storage });
  return positionsRead;
}
/** The interlude jingle's own element (queue-manager.js §13). Built with the
    manager, primed on every play tap beside `backend.notePlayGesture()`. */
let interlude = null;
let ui = null;
/** The one on-device TTS bridge instance for the whole page (V-01, §"the
    narration voice picker"). Built at module scope, not inside
    `ensureBooted`, so `ForayPlayer.listVoices()` works before anything has
    booted — a listener opening the drawer's voice picker before ever
    pressing play must see installed voices immediately, and `_speakNarration`
    (via `ensureBooted`'s manager construction) reuses this SAME instance
    rather than resolving the plugin module a second time. `createTtsBridge`
    memoises its own module load, so two callers sharing one instance cost
    exactly one dynamic import either way. */
const ttsBridge = createTtsBridge();

/* K-01's passage, fetched lazily and memoised.

   TWO URLS FOR THE SAME REASON `tts-bridge.js` HAS TWO (read that file's
   header): the shell carries a flattened copy at the bundle root, put there by
   `prepare-webdir.mjs`'s SHELL_ONLY_FILES table, while the website serves the
   repo verbatim and so holds it at its `tools/` path. Tried in the right order
   for the host rather than a fixed one, so the shell — the only host where the
   measurement matters — never eats a 404 first.

   A failed fetch resolves `null`, never throws: `runKokoroProbe` turns that
   into `passage-missing`, which is a finding a founder can read. */
let probePassage = null;
export const PROBE_PASSAGE_SHELL_FIRST = Object.freeze([
  "kokoro-probe-passage.json",
  "tools/mobile/kokoro-probe-passage.json",
]);
export const PROBE_PASSAGE_SITE_FIRST = Object.freeze([
  "tools/mobile/kokoro-probe-passage.json",
  "kokoro-probe-passage.json",
]);

async function loadProbePassage(
  fetchJson = (u) => fetch(u).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))),
  inShell = typeof window !== "undefined" && !!window.Capacitor,
) {
  if (probePassage) return probePassage;
  const urls = inShell ? PROBE_PASSAGE_SHELL_FIRST : PROBE_PASSAGE_SITE_FIRST;
  for (const u of urls) {
    try {
      const doc = await fetchJson(u);
      if (doc && Array.isArray(doc.lines)) { probePassage = doc; return doc; }
    } catch (_) { /* try the other host's path */ }
  }
  return null;
}
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
  /* Inside the native shell only: UserDefaults / SharedPreferences, the one
     tier a WebView storage sweep cannot reach. Null on the web. */
  nativeTier: preferencesTier(typeof window !== "undefined" ? window.Capacitor : null),
  /* Inside the native shell only: the device-only vault (Keychain this-device-
     only / Android no-backup storage) that holds the auth token and nothing
     else, so the token is never in a phone backup (persist-6, founder ruling
     2026-09-24 "Option A"). Null on the web, and on a shell build without the
     plugin — where the token stays in the tiers above, as before. */
  vault: vaultTier(typeof window !== "undefined" ? window.Capacitor : null),
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
const storageHydrated = storage.hydrate().catch(() => storage);

/* THE WAIT THE FIELD RECORD PUTS ON HYDRATION IS BOUNDED (2026-09-23).

   `hydrate()` awaits every durable tier's `readAll` and then drains the write
   queue, and a WKWebView's IndexedDB is known to leave a transaction unsettled
   after the app has been in the background (`idb-tier.js`, hazard 1). Everything
   the record writes at boot — the `boot` row, the `build` row, the
   `visibilitychange` and native-session listeners — used to sit behind that
   promise with no bound, so a store that never finished reading produced a page
   that never recorded anything: no build row, no rows, and a header that said
   so in a way that read as a broken instrument. `app.js` has bounded its own
   wait on the same promise at five seconds since the store shipped; this is
   that bound, for the FIELD RECORD's writers and for nothing else -- the
   `boot`/`build`/visibility/native-session writers below, and the two
   `diag.dataSource` bridges. The playback-rate restore further down reads a
   VALUE hydration provides and stays on `storageHydrated`: run at the bound it
   would read the default, apply it, and never run again (review, 2026-09-23).

   Resolves `true` when hydration landed in time and `false` when the bound was
   hit, and the boot row carries the answer (`storage=not-hydrated`). A row
   written after the bound does NOT overwrite the durable tier's copy of the
   ring: `DiagnosticLog` holds every write in memory while the store says it has
   not hydrated and `flush()`es once it has, putting the held rows after the
   adopted ring (review, 2026-09-23 -- a durable read that was merely slow, not
   hung, used to lose the older ring the moment the boot row landed, because the
   store treats the first writer of a key as its owner). Only after
   `HYDRATE_GIVE_UP_MS` is the tier called hung and the held rows written
   anyway; a read that slow is not a read. The timer is cleared when hydration
   lands so a healthy boot holds nothing open. */
const HYDRATE_WAIT_MS = 5000;
const HYDRATE_GIVE_UP_MS = 60_000;
const storageReady = new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), HYDRATE_WAIT_MS);
  storageHydrated.then(() => { clearTimeout(timer); resolve(true); }, () => { clearTimeout(timer); resolve(true); });
});

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
window.forayStorageReady = storageHydrated;
/** For a founder or a tester with a console open: the whole failure record. */
window.forayStorageHealth = () => storage.health();

/* ---------- the event queue (M3) ----------

   Built the same way `storage` above is: at module evaluation, over the real
   `indexedDB` where one exists, published on `window` because `app.js` is a
   classic script and cannot import this module. `app.js`'s `logEvent()` is a
   thin call to `append()` below; see `event-log.js`'s header for the queue
   itself and why it replaces a synchronous localStorage rewrite. */
const eventLog = createEventLog({
  indexedDB: typeof indexedDB !== "undefined" ? indexedDB : null,
  onFault: (fault) => {
    // Same rule as the storage fault above: the player cannot fix a dead
    // tier, but it must not hide one either.
    console.warn("[event-log]", fault.op, fault.error);
  },
});
window.forayEventLog = eventLog;
/** For a founder or a tester with a console open, beside `forayStorageHealth`. */
window.forayEventLogHealth = () => eventLog.health();

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
   the catch is attached anyway. It resolves with whether hydration landed inside
   the bound — see `HYDRATE_WAIT_MS` — and the boot row records that. */
storageReady.then((hydrated) => {
  diag.boot({ hydrated: hydrated === true });
  if (hydrated !== true) {
    /* The bound was hit, so the rows below are being HELD by the ring (see
       `HYDRATE_WAIT_MS`). Write them when hydration lands -- after the adopted
       ring, never over it -- and, if it never does, when the tier has earned
       the name "hung". The give-up timer is left to fire on a healthy late
       hydration too: `flush({ force })` with nothing pending is a no-op. */
    storageHydrated.then(() => diag.flush()).catch(() => {});
    setTimeout(() => diag.flush({ force: true }), HYDRATE_GIVE_UP_MS);
  }
  /* WHICH BUILD (founder report 3, 2026-09-22) — see `player/build-stamp.js`.
     Beside `boot()` and after hydration for the same reason `boot()` waits:
     it is a write into the durable record. Asynchronous, so it lands a moment
     after the boot row; never rejects. */
  recordBuildStamp();
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => diag.visibility(document.hidden === true));
  }
  /* M-03 (founder feedback F16 / #548). The native side of "why did it stop?".
     `ForayAudioPlugin.swift` and `ForayTtsPlugin.swift` observe the
     `AVAudioSession` interruption / route-change / media-services-reset
     notifications and `UIApplication`'s background / foreground, and
     `foray-media-session.js` re-broadcasts each one on `window` as
     `SESSION_DOM_EVENT`. A DOM event rather than a direct call because
     `player/` may not import a Capacitor plugin's web half (see
     `tts-bridge.js`'s header on the two-URL problem) and because the shim is a
     separate module tag that may load before or after this one.

     REGISTERED ALONGSIDE `visibilitychange`, inside the same hydration wait
     and for the same reason: `sessionEvent()` records, and a record written
     before the durable tier has been pulled up would overwrite it.

     `diag.sessionEvent` drops anything whose `kind` is not in its own closed
     set, so an untrusted `CustomEvent` dispatched by a page script cannot put
     a string in the record. */
  if (typeof window !== "undefined") {
    window.addEventListener("foray:session", (e) => {
      try { diag.sessionEvent(e?.detail ?? {}); } catch (_) { /* diagnostics must never break the page */ }
      /* AND THE PLAYER, not only the record (2026-09-22, founder report 1).
         Until now these events reached `diag.sessionEvent` and nothing else. */
      try { onNativeSession(e?.detail ?? {}); } catch (_) { /* a session event must never break the page */ }
    });
    /* WHAT THE NATIVE SIDE RECEIVED (founder, 2026-09-23: "got in my car, then
       my car resumed Spotify"). The shim re-broadcasts every remote command the
       plugin saw — the platform's own command, the action it became, which door,
       and whether a handler existed — as `foray:remote`. The record only, on
       purpose: the press itself already reached the handler by the time this
       fires, and a second route to the transport would be a second opinion. */
    window.addEventListener("foray:remote", (e) => {
      try { diag.remoteCommand(e?.detail ?? {}); } catch (_) { /* diagnostics must never break the page */ }
    });
  }
}).catch(() => {});

/**
 * What the native shell's session events MEAN to the player (founder report 1,
 * 2026-09-22 — "a resumed episode restarts from a stale position").
 *
 * They arrived here and went only to the diagnostic record, so the one layer
 * that can see an iOS background, a Bluetooth route vanishing or a phone call
 * starting told the player nothing. Now:
 *
 *   - EVERY kind flushes both position stores first. Each of these is a moment
 *     after which the page may not run again for a long time (a background
 *     suspends it; a route loss ends the drive), which is the same argument the
 *     page's own `visibilitychange` flush makes — and the WebView does not
 *     always deliver `visibilitychange` when the app, rather than the page,
 *     goes away.
 *   - `routeChange` / `old-device-gone` is the car switched off or headphones
 *     out: `manager.routeChanged`, corner case #13, which pauses. It can only
 *     stop audio, never start it.
 *   - `interruptionBegan`, `foreground` and `mediaServicesReset` RECONCILE
 *     rather than command. These can be delivered LATE — a suspended page
 *     handles them when it wakes (`lagMs` in the record measures it) — and an
 *     interruption acted on as a command after the listener had already
 *     resumed from the lock screen would pause audio they were hearing. The
 *     element is the authority; the event is only the reason to ask it. A
 *     spoken narration line has no element to ask, so `interruptionBegan` asks
 *     the synthesiser instead (audit round 2, native-3; the manager's
 *     `_reconcileNarrationInterrupted`) — and only for an interruption, never
 *     for a return to the foreground.
 *   - `interruptionEnded` with `should-resume` RESUMES (founder question 2,
 *     ruled 2026-09-23 in docs/DECISIONS.md; audit round 2, p-car-3). Apple
 *     Podcasts and Spotify come back after a call; 4a stayed silent. Two
 *     guards, because audio with no press is the thing this used to refuse
 *     outright: the event must be fresh (`INTERRUPTION_RESUME_MAX_LAG_MS` — a
 *     page that handles it minutes later is a listener who has since opened the
 *     app, not one mid-call), and the manager resumes only an interruption the
 *     OS caused, never a pause the listener made before it. A resume the
 *     listener already did, or WebKit already did, is a no-op in the reducer.
 */
function onNativeSession(detail) {
  if (!manager || !detail || typeof detail !== "object") return;
  const kind = String(detail.kind ?? "");
  if (!["background", "foreground", "routeChange", "interruptionBegan", "interruptionEnded", "mediaServicesReset"].includes(kind)) return;
  flushPositions();
  if (kind === "routeChange" && detail.reason === "old-device-gone") {
    manager.routeChanged({ oldDeviceUnavailable: true })
      .then(() => { render(); persistForayProgress({ force: true }); })
      .catch((err) => console.warn("[player] route change failed", err));
    return;
  }
  if (kind === "interruptionBegan" || kind === "foreground" || kind === "mediaServicesReset") {
    /* The narration reconcile is the one place a stale event could STOP a
       voice, so it alone reads the lag; the element path asks the element. */
    const interruption = kind === "interruptionBegan" && sessionLagMs(detail) <= INTERRUPTION_RESUME_MAX_LAG_MS;
    reconcileOnReturn(`session:${kind}`, { interruption })
      .catch((err) => console.warn("[player] reconcile failed", err));
    return;
  }
  if (kind === "interruptionEnded") {
    const fresh = sessionLagMs(detail) <= INTERRUPTION_RESUME_MAX_LAG_MS;
    const shouldResume = detail.reason === "should-resume" && fresh;
    manager.interruptionEnded(shouldResume)
      .then(() => { render(); persistForayProgress({ force: true }); })
      .catch((err) => console.warn("[player] interruption end failed", err));
  }
}

/** How old an interruption's end may be and still start audio on its own.
    A page suspended for the whole call handles the event when it wakes, which
    is normally within a second of the OS delivering it; one handled later than
    this was woken by the listener, and starting audio under their thumb is the
    complaint founder report 1 made about a stale event in the other direction. */
const INTERRUPTION_RESUME_MAX_LAG_MS = 30_000;

/** Page clock minus the plugin's own stamp — the same pair `diag.sessionEvent`
    records as `lagMs`. Infinity when the stamp is missing, so an unstamped
    event can only ever be treated as stale, never as fresh. */
function sessionLagMs(detail) {
  const at = Number(detail?.at);
  return Number.isFinite(at) && at > 0 ? Date.now() - at : Infinity;
}

/** Ask for both halves of the build stamp and write the row. The pinned id is
    app.js's (a page the service worker served from a retained generation is
    running THAT generation's code, not the manifest's newest). */
function recordBuildStamp() {
  const pinnedMeta = () => {
    try {
      const m = typeof document !== "undefined" && typeof document.querySelector === "function"
        ? document.querySelector('meta[name="foray-pin-deploy-id"]') : null;
      return m && typeof m.getAttribute === "function" ? m.getAttribute("content") : null;
    } catch (_) { return null; }
  };
  const pinned = (typeof self !== "undefined" && self.__forayPinnedDeployId) || pinnedMeta();
  readBuildStamp({
    inShell: typeof window !== "undefined" && !!window.Capacitor,
    capacitor: typeof window !== "undefined" ? window.Capacitor ?? null : null,
    pinned,
    fetchJson: (u) => fetch(u, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))),
    /* Bounded per half, so a bridge call that never answers still yields a row
       with the half that did (2026-09-23) — see `readBuildStamp`. */
    timeoutMs: BUILD_STAMP_WAIT_MS,
  })
    .then((stamp) => { try { diag.build(stamp); } catch (_) { /* the instrument must never be the outage */ } })
    .catch(() => {});
}

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
 *
 * THE BUILD SURVIVES THE CLEAR, AND SO DOES THE FACT OF THE CLEAR (2026-09-23).
 * The founder's record that day was a cleared ring — `recorded 939`, nothing in
 * it — whose second line said `build unknown (no build row yet)`, because the
 * build row is a row and the clear had taken it; and nothing on it said it had
 * been cleared. `DiagnosticLog` now keeps the running build's stamp and the
 * clear mark outside the ring, and the header prints both, so nothing needs to
 * be re-recorded here: the key stays absent after a Clear (the test
 * "Clear mid-seam resets what is in flight" uses that as its probe), and the
 * next row written carries the stamp and the mark down with it.
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
 *
 * `forget()`, NOT `clear()` (round-2 audit, persist-5): the founder's Clear keeps
 * the running count and a "cleared at #N, hh:mm:ss" mark, and after a deletion
 * that mark is a record of how much the listener did and when they deleted it.
 */
window.forayForgetDiagnostics = () => { diagLog.forget(); diag.reset(); return true; };
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

/**
 * One completed Shows search (S-01, docs/search-plan.md), into the record.
 *
 * A BRIDGE AND NOT AN IMPORT, same reason as every other `window.foray*`
 * above: `app.js` is a classic script. Takes the same shape
 * `PlayerDiagnostics.search()` does — `qLen`, never `query` — and the
 * sanitising against a non-numeric value lives in `diagnostic-log.js` so a
 * caller of a different vintage cannot get raw query text into a record
 * that gets pasted into issues, exactly the same guarantee
 * `forayNoteTapFailure` gives `err.name` above.
 *
 * Returns a boolean, never the entry, for the same reason as every other
 * bridge here: nothing on the page should hold a reference into the ring.
 */
window.forayRecordSearch = (fields) => {
  try {
    diag.search(fields || {});
    return true;
  } catch (_) {
    return false;
  }
};

/* ---------- the Foray directory (FD-03) ----------

   Built here and handed to app.js on `window`, for the reason everything above
   is: app.js is a classic script and cannot import `player/foray-directory.js`,
   and the validator the directory runs (`validateForayDocuments`) is the same
   join `resolve()` below uses, so the set app.js paints is a set this player can
   play.

   Its cache is its OWN IndexedDB database (`DIRECTORY_DB_NAME`), not a `cp_` key
   in `storage` above — the three documents are ~300 KB of public JSON, which is
   neither user data nor something the durable store's every hydration should
   deserialise and filter back out. `makeIdbTier` answers null where there is no
   IndexedDB, and the directory then runs cache-less: seed at boot, network after.

   Nothing is fetched at module scope. `app.js`'s `init()` calls `start()` and
   `boot()` before its first paint (the cache and the bundled pointer only, both
   bounded) and `refresh()` after it — the split that keeps the network off the
   critical path is app.js's, and `test/foray-directory.test.js` pins it there.

   Every choice and outcome lands in the field record through `diag.dataSource`
   (FD-01), after hydration for the reason `diag.boot()` waits for it. */
const directory = createForayDirectory({
  fetch: (url, opts) => fetch(url, opts),
  cache: makeIdbTier({ dbName: DIRECTORY_DB_NAME }),
  onEvent: (fields) => {
    storageReady.then(() => diag.dataSource(fields)).catch(() => {});
  },
});
window.forayDirectory = directory;
/**
 * The page's own `data` entry (FD-01): the boot-time source of each document as
 * app.js saw it, and the web's `stale-shell` pin. Same shape and the same
 * sanitising as every other bridge above: fields, never prose, and a boolean back
 * so nothing on the page holds a reference into the ring.
 */
window.forayNoteDataSource = (fields) => {
  try {
    storageReady.then(() => diag.dataSource(fields || {})).catch(() => {});
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

/** A control's visible words AND its accessible name, in one write (audit
    2026-09-22, theme D). `aria-label` REPLACES a button's text for a screen
    reader, so a control whose text changes and whose name does not is a control
    that lies: the card button showed ❚❚ and announced "Play …". This is the
    module's copy of app.js's `setControlLabel` — the same rule, kept here because
    this ES module must evaluate in its own test harness without app.js, and
    app.js must render without this module. The name is dropped, not duplicated,
    when it equals the text. */
function paintControl(btn, text, label) {
  if (!btn) return;
  if (text != null && btn.textContent !== text) btn.textContent = text;
  /* Compared before it is written, like the text (audit round 2, perf-7): this
     runs for every `[data-play]` button on the page at 4 Hz, and an attribute
     rewritten to its own value is still a mutation some screen readers
     re-announce. */
  if (label && label !== text) {
    if (btn.getAttribute("aria-label") !== label) btn.setAttribute("aria-label", label);
  } else if (btn.getAttribute("aria-label") != null) {
    btn.removeAttribute("aria-label");
  }
}

function buildUI() {
  const root = el("div", "fp");
  root.id = "foray-player";
  root.hidden = true;

  /* mini bar */
  const bar = el("div", "fp-bar");
  const art = el("img", "fp-art");
  art.alt = "";
  /* NO static name. This button's contents ARE the episode title and show,
     and the fixed "Open player" that used to sit here replaced them, so a
     screen-reader user was never told what was playing from the bar.
     `paintInfoLabel` names it from the title and says which way it goes. */
  const info = el("button", "fp-info");
  info.type = "button";
  const title = el("span", "fp-title");
  const show = el("span", "fp-show");
  /* A failed play says so ON THE BAR (persona audit #4, 2026-09-22), in the
     show line's place: the bar is the one surface on screen whatever page the
     listener tapped play from, and in a car it is the only one they glance at.
     Hidden until `setPlayFailure` fills it.
     NOT THE LIVE REGION (review 2026-09-23). It sits inside `info`, a
     <button> named by its aria-label, and a button's children are
     presentational — WebKit leaves them out of the accessibility tree, so a
     status role here was never announced under VoiceOver. The announcement is
     `announce` below, a visually hidden element, and the button's own name
     carries the line too (`paintInfoLabel`).
     AND NOT INSIDE THE BAR EITHER (audit round 2, a11y-2). The review put the
     region beside the button, inside `bar` — and expanding Now Playing makes
     the bar `inert` (the owner takes every sibling of the sheet out of reach),
     so "Buffering…" and a failed load were announced from the collapsed bar
     and silent from the one screen a listener stops to look at. It is
     appended to `root` as a sibling of BOTH the bar and the sheet, and
     `setExpanded` names it in `keepReachable`, so it is live in either
     state. */
  const err = el("span", "fp-err");
  err.hidden = true;
  info.append(title, show, err);
  const announce = el("span", "fp-announce sr-only");
  announce.setAttribute("role", "status");
  announce.setAttribute("aria-live", "polite");

  const playBtn = el("button", "fp-play", "▶");
  playBtn.type = "button";
  playBtn.setAttribute("aria-label", "Play");
  /* THE BAR'S SECOND CONTROL (audit 2026-09-22, persona 10). The bar carried
     one ▶ and every other transport action cost a full-screen sheet — four
     interactions to hear a missed sentence again. Apple's mini bar is play +
     one skip; ours is play + back 15 s, the nudge the persona asked for by
     name and the one that matters in a car. One control, not two, so a 390px
     bar keeps its title line. Inside a Foray it nudges on the Foray clock
     (`nudgeBy`), never previous clip — see persona 58 in the sheet below. */
  const skipBtn = el("button", "fp-skip", `↺ ${SEEK_BACK}`);
  skipBtn.type = "button";
  skipBtn.setAttribute("aria-label", `Back ${SEEK_BACK} seconds`);

  /* U-13 (founder feedback F18): this ✕ used to call `stopAndClose()`, and its
     label said so. Closing the Now Playing screen to go and use the app therefore
     ENDED playback and took the mini bar away with it, so there was no way back to
     what was playing — the founder lost an episode mid-listen to a control whose
     only visible job was "get this off my screen". It now collapses to the mini
     bar (the sheet's only button that does; the handle's drag is the gesture —
     the boxed "Close" that once sat in the second row went in visual pass 1),
     and stopping has its own
     separately labelled control (`fp-stop`, also below). styles.css shows it only
     while the sheet is expanded — see the rule under `.fp-close` there — because
     on an already-collapsed bar it would be a control with nothing left to do. Nothing about the stop
     itself changed — same `stopAndClose()`, same effects — only which control
     reaches it. Deliberately NOT a long-press: a destructive action hidden behind
     a timed gesture is undiscoverable and, in a car, unsafe. */
  const closeBtn = el("button", "fp-close", "✕");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Collapse player");

  const progress = el("div", "fp-progress");
  const fill = el("div", "fp-fill");
  progress.append(fill);

  /* The ✕ is NOT on this row any more. U-13 put it here and hid it unless the
     sheet was expanded, which worked while the sheet was a 340px panel docked
     above the bar. Now that the sheet covers the whole screen the bar is
     BEHIND it, so a ✕ living here would be a control that exists, is styled
     visible, and can never be touched — the exact "dead target" defect U-13's
     own comment set out to remove. It moves into the sheet's grab row below,
     which is the only place it can be both visible and hit-testable, and is
     also where the sheet's other dismiss affordances now are. */
  bar.append(art, info, skipBtn, playBtn);
  root.append(progress, bar);

  /* ---------- the Now Playing sheet ----------

     Wyatt (2026-09-13, live bug report): "when I click on the now playing
     episode, it should pop up with the page for the episode, same as Apple
     Podcasts, starting at the top with the 'album artwork' or whatever that
     is. That window should then be scrollable... Also, I should be able to
     drag that page down from the top to return to what I was looking at
     previously."

     Three structural facts follow from that, and all three are in this
     builder rather than in styles.css, because they are about what the sheet
     IS, not how it is painted:

       - IT HAS ITS OWN SCROLLER. `.fp-sheet` is the fixed full-height
         surface and never scrolls; `.fp-sheet-scroll` inside it is the only
         thing that does. Before this the sheet had no scroller at all, so
         "the whole screen" was whatever page happened to be underneath it at
         whatever position that page was left at — which is exactly the
         "bottom part of the transcript" in the report.
       - ITS FIRST CHILD IS THE ARTWORK. Not the title: the report names the
         artwork specifically, and it is also the thing that makes a sheet
         read as "this episode" at a glance from a car cradle.
       - IT HAS A GRAB HANDLE, which is a drag target and not a button. The
         gesture itself is `player/sheet-drag-dismiss.js` (pure, tested);
         this is only the element it is measured against. */
  const sheet = el("div", "fp-sheet");
  sheet.hidden = true;
  /* A DIALOG, and it says so (audit 2026-09-22). It covers the page from the
     topbar down, yet it had no role, no name and no focus move, so a screen
     reader kept exploring the page hidden behind it and could activate
     controls nobody could see. The name is the episode title below
     (`aria-labelledby`); opening and closing go through app.js's sheet owner
     (see `setExpanded`), which moves focus in, makes the page behind inert and
     binds Escape. NOT `aria-modal` (review 2026-09-23): the topbar and the
     drawer stay reachable (U-12/F17: the ☰ must work at every moment), and
     VoiceOver and TalkBack take `aria-modal="true"` as "nothing outside this
     exists" — the ☰ vanished from swipe navigation. `inert` on everything else
     (the owner's `keepReachable`) already does the modal part, and does it
     without hiding the chrome that is meant to stay. */
  sheet.setAttribute("role", "dialog");
  /* `.fy-grab` is the app's existing grabber (the reason sheet, the feedback
     sheet, the delete sheet and the voice sheet all already paint one) —
     reused by class rather than restyled under a new name, so a fifth sheet
     in this app cannot look like a different product. The zone around it is
     this file's own: it needs `touch-action: none` to receive a vertical
     drag, and the 4px bar itself is far too small a target for a thumb. */
  const grabZone = el("div", "fp-grab-zone");
  /* The handle, and beside it the ✕ that used to live on the mini bar. A drag
     is not discoverable and is not available to everyone — a visible, labelled
     dismiss control next to the gesture is what keeps the sheet closeable with
     a switch, a keyboard or a screen reader. Same element, same
     `aria-label`, same handler as before; only its parent changed. */
  grabZone.append(el("div", "fy-grab"), closeBtn);
  const scroll = el("div", "fp-sheet-scroll");
  const sArt = el("img", "fp-s-art");
  sArt.alt = "";
  sArt.hidden = true;
  const sTitle = el("h2", "fp-s-title");
  sTitle.id = "fp-s-title";
  sheet.setAttribute("aria-labelledby", "fp-s-title");
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

  /* PREVIOUS / NEXT CLIP ARE THEIR OWN CONTROLS (audit 2026-09-22, persona
     58). The ↺15 / 30↻ pair used to turn into ‹‹ / ›› inside a Foray — the
     same two buttons, a different glyph, and "previous" restarts the clip — so
     the gesture every other player has taught threw the listener to the top of
     an eleven-minute clip with no way to nudge back a sentence. The seek pair
     now seeks in every mode, and clip navigation is this row, in words, shown
     only while a Foray is loaded (`setSkipButtonMode`). */
  const clips = el("div", "fp-clips");
  clips.hidden = true;
  /* The guillemets are decoration: the accessible name is the words alone, or
     VoiceOver opens with "single left-pointing angle quotation mark" (visual
     pass 1 review, 2026-09-23). */
  const clipPrev = el("button", "fp-clip fp-clip-prev", "‹ Previous clip");
  clipPrev.type = "button";
  clipPrev.setAttribute("aria-label", "Previous clip");
  const clipNext = el("button", "fp-clip fp-clip-next", "Next clip ›");
  clipNext.type = "button";
  clipNext.setAttribute("aria-label", "Next clip");
  clips.append(clipPrev, clipNext);

  const row2 = el("div", "fp-row2");
  const rateBtn = el("button", "fp-rate", "1×");
  rateBtn.type = "button";
  rateBtn.setAttribute("aria-label", "Playback speed");
  /* It opens the speed picker, a dialog (#349) — say so, or a voice-control
     user told "next speed" expects a cycle (audit round 2, player-9). The
     Foray page's `#fy-rate` is the same control and needs the same attribute. */
  rateBtn.setAttribute("aria-haspopup", "dialog");
  const openLink = el("a", "fp-openep", "Episode");
  /* The bar already survives navigation — it lives on <body>, not inside
     #view — but until now there was no way BACK. Leaving the foray page to look
     at something else meant the running order, the segment you were on and the
     thumbs were all gone until you found the URL again. This is that way back,
     and it is an in-app hash route, never an external link. */
  /* "this foray", not "the running order": that is a broadcast-production
     term, and it appeared nowhere else a listener had been (audit 2026-09-22).
     Lowercase because the unit is a common noun (docs/DECISIONS.md,
     2026-08-21; test/app-name.test.js). */
  const forayLink = el("a", "fp-openep fp-toforay", "Back to this foray");
  forayLink.hidden = true;
  /* No "Close" button here any more (visual pass 1, 2026-09-23): the grab
     zone's ✕ and the drag handle are the sheet's two ways out, and a third,
     boxed one at the bottom made the row read as four control kinds. */
  /* U-13: the ONLY control that ends playback and takes the bar away. It is here,
     in the expanded sheet, rather than on the mini bar, because the mini bar has
     to survive everything else a listener does — it is the way back to what is
     playing. Labelled "Stop" in both the text and the accessible name so it can
     never be confused with "Close" beside it, which only collapses. */
  const stopBtn = el("button", "fp-stop", "Stop");
  stopBtn.type = "button";
  stopBtn.setAttribute("aria-label", "Stop");
  /* THE THREE STAPLES AN APPLE USER REACHES FOR FROM THE PLAYER (audit round 2,
     p-impatient-7 / p-switcher-5; founder question 10: the link and Save now,
     the sleep timer parked). The sheet had Stop, speed and "Episode": with five
     episodes queued there was no in-app way to move to the next one — ⏭ existed
     only on the lock screen and the car — and no way to see what was queued or
     to save what was playing without leaving the sheet.

       ⏭        `Next episode`: the SAME action the steering wheel's next is
                (`episodeNavigation.next`, app.js's `playNextAfter(cur, "skip")`),
                so the skipped episode leaves Up Next the same way. Hidden when
                the page offers no next, and inside a Foray (its clip row is the
                next there).
       Up Next  a link to `#/queue` carrying the count, hidden at zero.
       Save     the page's own star for the current episode (`toggleSaved`), so
                the sheet and the rows cannot disagree about what is saved.

     All three read `episodeNavigation` — the object the page hands
     `setEpisodeNavigation` — and are painted by `paintEpisodeSurface` from
     `render()` and from every `setEpisodeNavigation`. The page owns Up Next and
     the stars; the sheet only shows them. The two buttons are the transport
     family's plain box (`.fp-btn`, the seek pair's), NOT `.fp-rate`'s: that
     box is the speed readout's, muted and light on purpose, and borrowing it
     painted two actions as a de-emphasised readout (audit round 2 review of
     visual-5). `.fp-next` / `.fp-save` / `.fp-upnext` carry their own rules
     in styles.css, and `.fp-row2` wraps, so six controls fit a 320px phone. */
  const nextBtn = el("button", "fp-btn fp-next", "⏭");
  nextBtn.type = "button";
  nextBtn.setAttribute("aria-label", "Next episode");
  nextBtn.hidden = true;
  const queueLink = el("a", "fp-openep fp-upnext", "Up Next");
  queueLink.href = "#/queue";
  queueLink.hidden = true;
  const saveBtn = el("button", "fp-btn fp-save", "Save");
  saveBtn.type = "button";
  saveBtn.setAttribute("aria-pressed", "false");
  saveBtn.hidden = true;
  /* STOP FIRST, ALONE AT THE DANGER END (audit 2026-09-22, persona "Stop sits
     next to Close"; visual pass 1). It used to sit in the middle of the row
     beside an identical grey Close. The row is `justify-content: space-between`,
     so Stop leads and the navigation links trail; styles.css gives `.fp-stop`
     the danger colour. No confirmation (a stop is undone by pressing play). */
  row2.append(stopBtn, rateBtn, nextBtn, saveBtn, queueLink, openLink, forayLink);

  const note = el("p", "fp-note");
  note.hidden = true;
  /* The same failure, in the expanded sheet, under the transport — where
     `.fy-error` sits on the Foray page. */
  const sErr = el("p", "fp-err-line");
  sErr.hidden = true;

  /* The publisher's own description, LAST. It is the longest thing here and
     the only reason the sheet needs to scroll at all, so putting it under the
     transport is what keeps play/pause and the scrub bar reachable without
     scrolling — the same order the `#/episode/:id` page uses, and the same
     order Apple Podcasts uses. Empty-and-hidden when the item carries no
     description, because a heading over nothing is worse than an absence.

     THE SAME NOTES THE EPISODE PAGE SHOWS (audit round 2, p-switcher-2). The
     founder's 2026-09-17 ruling — links you can tap, timestamps that seek,
     collapsed under "Episode notes" — reached `#/episode/:id` and not this
     sheet, which painted the same text dead and fully expanded. Same
     `<details>` shell and the same classes as that page, so styles.css has one
     rule for them; the content is built in `paintNotes` from the tokens app.js
     publishes (`window.ForayNotes`), node by node, never from an HTML string —
     the rule this whole file is built on, kept even here. */
  const sDesc = el("details", "fp-s-desc ep-description");
  sDesc.hidden = true;
  const sDescToggle = el("summary", "ep-description-toggle", "Episode notes");
  const sDescText = el("p", "ep-description-text");
  sDesc.append(sDescToggle, sDescText);

  scroll.append(sArt, sTitle, sShow, sWhy, scrub, times, row, clips, row2, sErr, note, sDesc);
  sheet.append(grabZone, scroll);
  root.append(sheet, announce);
  document.body.append(root);

  return {
    root, bar, art, title, show, playBtn, skipBtn, closeBtn, fill, sheet,
    grabZone, scroll, sArt, sDesc, sDescText, clips, clipPrev, clipNext,
    sTitle, sShow, sWhy, scrub, tNow, tLeft, bigPlay, backBtn, fwdBtn,
    rateBtn, nextBtn, saveBtn, queueLink, openLink, forayLink, stopBtn, info, note, err, sErr, announce,
  };
}

/* ---------- a play that failed says so (persona audit #4, 2026-09-22) ----------

   An ordinary episode that would not load used to say nothing, anywhere: the
   manager paused, the glyph flipped back to ▶, and the only evidence was a
   console line. The Foray page already had the standard ("That clip couldn't
   load. Check the connection, then press play."), for the surface a newcomer
   uses least. These are that standard for every episode.

   Two sentences, because only two can be acted on — the same split the Foray
   page makes. A browser holding audio back until it is sure you asked is not a
   fault, and gets an instruction rather than an error.

   ONE SENTENCE PAIR WITH app.js's FY_START_FAILED (audit round 2, copy-6): the
   same failure was worded three ways ("wouldn't load" / "could not load" /
   "Did not load"). The uncontracted form here existed only because the
   source-text suites' string-strippers misread an apostrophe inside a
   double-quoted literal as opening a single-quoted one; those strippers now
   tokenise the three quote kinds in one pass, so listener copy is no longer
   shaped around a test. */
const EP_START_FAILED = "That episode couldn't load. Check the connection, then press play.";
const EP_PLAY_HELD = "Press play again to start it.";

let playFailure = null;

/** Show (a sentence) or clear (null) the failure line on the bar and the sheet.
    The bar's show line steps aside while it is up, so the bar keeps its one
    line of subtitle. */
function setPlayFailure(copy) {
  playFailure = copy || null;
  if (ui) paintStatus();
}

function playFailureCopy(signal) {
  return /NotAllowedError/.test(String(signal ?? "")) ? EP_PLAY_HELD : EP_START_FAILED;
}

/** How far down the Now Playing sheet is currently pulled, in CSS px.
 *
 *  Written as a CUSTOM PROPERTY rather than as `transform` directly, so
 *  styles.css keeps the whole transform — including the transition that
 *  springs the sheet back — and this file only ever supplies one number. That
 *  is the same division `segment-strip.js` already documents for its own
 *  `style.setProperty()` writes: a CSSOM call, never a `style` attribute, so
 *  the strict CSP (`style-src 'self'`, no inline styles) is untouched.
 *
 *  Zero is the resting state and is written as `0px` rather than removed, so
 *  the property always parses — an unset custom property would fall back to
 *  the `var()` default and work, but a MIS-set one would silently invalidate
 *  the whole transform, and "always a length" is the cheaper invariant. */
function setSheetDragOffset(px) {
  if (!ui || !ui.sheet) return;
  const n = Number(px);
  ui.sheet.style.setProperty("--fp-sheet-dy", `${Number.isFinite(n) && n > 0 ? n : 0}px`);
  /* No spring-back transition WHILE a finger is on it: the sheet must track
     the thumb exactly, and a transition on every pointermove turns that into
     lag. The class goes on for the duration of the drag and comes off when it
     rests, which is when the transition should apply. */
  ui.sheet.classList.toggle("fp-sheet-dragging", Number.isFinite(n) && n > 0);
}

/* ---------- state -> DOM ---------- */

let current = null;
let scrubbing = false;
/* A FOCUSED SLIDER IS FROZEN, BUT ITS NEXT STEP IS TAKEN FROM THE AUDIO (audit
   round 2 review of a11y-7). `paintPage` stops writing the value while the
   slider is a keyboard or screen-reader user's, so VoiceOver does not narrate a
   running clock; the native step (an arrow key, a VoiceOver swipe) then moves
   from that frozen value, and a listener parked on Seek for five minutes
   jumped five minutes BACK on a Right Arrow. `scrubShownValue` is the value the
   slider holds as far as paint knows, `scrubLiveValue` where the audio is: a
   discrete step is re-based onto the live value before it seeks. A slider
   focused by a POINTER is not frozen at all — a mouse user's thumb follows the
   audio after a click, as the fill beside it does. */
let scrubShownValue = null;
let scrubLiveValue = null;
let scrubByPointer = false;
/** `{ id, sec }` — the position the load in flight was asked to start at, so
    the bar can show it before the element holds the item (`episodePositionSec`).
    Set by `play()`, meaningful only while `manager.playheadItemId` is not yet
    this id. */
let loadingStart = null;

/* ---------- episode-ended notification (Up Next auto-advance, #369) ----------

   ONE signal, for ordinary single-episode playback only (never for a Foray —
   a Foray already has its own internal advance-to-next-segment machinery and
   this must not be a second opinion about that). `app.js` is the only
   consumer, and it decides entirely on its own whether "ended" should mean
   "start the next Up Next item" (docs/listening-queue-plan.md addendum) —
   this module just reports the fact once, exactly once, per finished item.

   `_endedAnnouncedFor` is the de-dupe: `render()` runs on every `timeupdate`/
   `play`/`pause` while `manager.state.type === "ended"` keeps reading true
   after the first tick, so without this a single finish would fire the
   listener dozens of times. Cleared the moment a NEW item starts (`play()`
   below), so the next episode's own end is reportable again. */
let _endedAnnouncedFor = null;
const _episodeEndedListeners = new Set();

function _announceEpisodeEndedIfNeeded() {
  if (foray || !manager || !current) return;
  if (manager.state?.type !== "ended") return;
  if (_endedAnnouncedFor === current.id) return;
  _endedAnnouncedFor = current.id;
  const id = current.id;
  _episodeEndedListeners.forEach((fn) => {
    try { fn(id); } catch (_) { /* a listener's own bug must not break playback */ }
  });
}

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
  /* L-03: a narration bridge INSERTED mid-Foray (an authored TTS item the
     reducer reaches via `itemEnded`'s `bridged` branch, not through the
     ordinary `play(index)` entry point) lands in `"transitioning"`, not
     `"playing"` — see `queue-state.js`'s `handleItemEnded`. That state means
     exactly the same thing to a listener: the bridge is audible right now,
     nothing is paused, and Now Playing must say so. `PlayerQueueManager`'s
     own `_narrationIsAudible()` already treats the two states as one for the
     rate-deferral guarantee (§12); reading it here for playback state is the
     same rule, not a new one. A narration item reached the ORDINARY way
     (index 0, or any item loaded via `play()`/a skip) already lands in
     `"playing"` like any other item, so this widening changes nothing for
     that path — it only fixes the bridge's own transitional state. */
  const type = manager?.state?.type;
  return type === "playing" || type === "transitioning";
}

/** Is the Foray RUNNING, as a listener would say it?
 *
 *  Wider than `isPlaying()` by exactly one state: the 0.5 s seam beat between
 *  two unbridged segments (`player/seam-gap.js`). Structurally that is
 *  `loadingItem`, so `isPlaying()` is false — but nobody has pressed anything,
 *  the Foray is advancing on its own, and the only sane meaning for the main
 *  button during that half second is STOP.
 *
 *  Every play/pause control goes through this. The first draft changed the
 *  Foray page's LABEL to "❚❚ Pause" during a beat while `forayToggle` still
 *  branched on `isPlaying()` — so the button said Pause and started audio. */
function isRunning() {
  return isPlaying() || manager?.inSeamGap === true;
}

/**
 * THE ONE PLACE BELIEF IS CHECKED AGAINST THE ELEMENT (#689).
 *
 * `isRunning()` above is the app's BELIEF, and every transport surface used to
 * decide from it alone. A belief is a cache, and this file has now been handed
 * two field reports of it being wrong in each direction:
 *
 *   - we say playing, the element is paused (#263, #688) — a stop that happened
 *     while the page was suspended, so no event was ever delivered. Corrected by
 *     `manager.reconcileWithBackend`, which is why `setRunning` awaits it first.
 *   - we say paused, the element is audible (#689 report 3) — *"I scrubbed
 *     ahead, the podcast started playing, but the button still said play"*.
 *     Nothing can correct this into a reducer state without inventing a `play`
 *     nobody pressed, but it can be READ, and reading it is enough: the press
 *     that follows then does what the listener meant instead of being spent on
 *     the disagreement.
 *
 * Composed rather than replaced: `isRunning()` is the wider answer in the states
 * only this app knows about (the 0.5 s seam beat, a spoken narration item, the
 * instant between `playing` and `startPlayback`), and `elementIsAudible` is the
 * wider answer in the states only the element knows about. Either one saying yes
 * is a yes, because both mean "the listener should be pressing STOP".
 *
 * A new surface — another scrub bar, another sheet, a native transport — cannot
 * add a fifth way to drift without going through a control that asks this.
 */
function transportIsRunning() {
  return isRunning() || manager?.elementIsAudible === true;
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
  /* L-03: a script-only narration item is spoken through the on-device
     plugin, not loaded into `backend` — `backend.currentTime` at this
     instant is whatever the LAST rendered item left it at, frozen for the
     whole utterance (see `_beginSynthNarration`'s own comment on the
     manager side). `narrationElapsedSec` is the manager's wall-clock answer
     for exactly this item, and `forayElapsed`'s own narration branch already
     treats a bare elapsed-seconds number as the offset directly, with no
     `start_sec` to subtract — the same contract this call already relies on
     for a rendered bridge. */
  if (manager?.isNarrationPlayhead === true) {
    const t = manager.narrationElapsedSec;
    if (typeof t !== "number" || !Number.isFinite(t)) return null;
    return forayElapsed(foray.resolved.playable, foray.index, t);
  }
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
    (`Now: <show name>`), extended with the clip number because a Foray's second
    line has room and "clip 12 of 32" is the one fact a mini bar can add.
    "Clip", not "part": a part is one of a Foray's titled sections, and a clip is
    the listener's word for the pieces inside them (audit 2026-09-22). */
function forayNowPlaying(item, index) {
  return {
    id: item.id,
    title: foray.resolved.title || item.title || "",
    show: foraySecondLine(foray.resolved.playable, index),
    duration_sec: null,
    dai_suspected: Boolean(item.dai_suspected),
  };
}

/** THE ONE BUILDER of a Foray's second line (audit round 2, copy-5): the
    clip's show and its number, for the live bar and the restored one alike.
    The live line used to open with "Now: " — the mockup's second line — and
    the restored line with "Foray · ", so the same Foray read two ways five
    seconds apart, and no other surface prefixes anything with "Now:" (the bar
    IS the now-playing bar). A narration line has no show; it is credited as
    what it is. */
function foraySecondLine(playable, index) {
  const total = playable.length;
  const item = playable[index];
  const show = item?.show || (item?.kind === TTS ? "Narration" : "");
  const clip = `clip ${Math.min(index, total - 1) + 1} of ${total}`;
  return show ? `${show} · ${clip}` : clip.charAt(0).toUpperCase() + clip.slice(1);
}

/** Everything a page needs to paint itself, in Foray terms. */
function forayStateSnapshot() {
  if (!foray) return null;
  return {
    forayId: foray.resolved.id,
    index: foray.index,
    loading: manager?.state?.type === "loadingItem",
    /* Playback halted for data (audit 2026-09-22) — the Foray page's own
       transport can say "Buffering…" from the same flag the mini bar paints. */
    buffering,
    playing: isPlaying(),
    /* THE ANSWER THE PRESS IS DECIDED BY (audit 2026-09-22). `forayToggle`
       calls `setRunning(!transportIsRunning())`, and the Foray page painted its
       main button from `playing || gap` — the belief without the element. In
       the #689 drift the button said "▶ Resume" over sound and its press
       paused. A page in another file cannot call `transportIsRunning()`, so it
       is handed the value; `playing` and `gap` stay for what they describe. */
    running: transportIsRunning(),
    /* The 0.5 s seam beat between two unbridged segments (player/seam-gap.js).
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
    /* V-01: did the narration item just spoken fall back from the listener's
       chosen voice to the plugin's own best pick? Read straight off the
       manager rather than re-derived, for the same reason `rate` is. */
    voiceFallback: manager ? manager.lastVoiceFallback : null,
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
 * Reaching the end MARKS the row finished (audit round 2, honesty-2). It used
 * to clear it, so a finished Foray went back to looking never opened — no
 * "Played" anywhere — while a finished episode said "Played" on every row.
 * `progressLabel` says "Played" for it, Jump back in leaves it out, and
 * `lastPlayedForay` / `forayResume` skip it, so it never offers "0 min left".
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
    /* Once. `render()` can run again while the queue sits ended, and a forced
       write per repaint would churn the durable tier for a row that says the
       same thing. */
    if (resumePoint(forayProgress.get(id), {})?.finished) return;
    const segs = forayProgressSegments();
    const last = segs[segs.length - 1] ?? null;
    const wrote = forayProgress.markFinished({
      forayId: id,
      title: foray.resolved.title,
      totalSec: foray.resolved.totalSec,
      index: segs.length - 1,
      segmentId: last ? last.id : null,
      intoSec: last ? last.durationSec : 0,
    });
    note({ wrote, why: wrote ? "finished-marked" : "store-refused" });
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

/** The countdown on the right of the bar. NO SIGN ON A ZERO (audit
    2026-09-22): the minus is a promise that there is time left to count, and at
    the exact end — and for the whole of a scrub past a Foray's end — this read
    "-0:00". THE SIGN FOLLOWS THE CLOCK, NOT THE RAW SECONDS (audit round 2,
    honesty-13): the Foray clock floors and the episode clock rounds
    (`formatTimestamp` → `hms`), so a rule written as `left >= 1` dropped the
    sign for the last half-second of an episode — "-0:01", "0:01", "0:00". A
    minus goes on whatever the formatter shows as more than nothing. */
function remainingClock(leftSec) {
  const left = Math.max(0, Number.isFinite(leftSec) ? leftSec : 0);
  const clock = foray ? fmtClock(left) : formatTimestamp(left, EXACT);
  /* A FORAY WHOSE TOTAL IS PARTLY AN ESTIMATE SAYS SO (audit round 2,
     states-11): the "~" the Foray page's own total carries, so this countdown
     cannot present a script-length projection as a stopwatch. */
  const about = foray?.resolved?.estimated === true ? "~" : "";
  return /^0:00$/.test(clock) ? clock : `${about}-${clock}`;
}

/* ---------- the ordinary episode's clock, in one place ----------

   Audit 2026-09-22: every episode seek in this file was written at its own call
   site — the ↺/↻ buttons, the scrubber, the lock screen's seekBy/seekTo, the
   page's timestamp tap — and each carried its own subset of the rules. The back
   button clamped at zero and the forward one did not; the scrubber and both
   buttons called `manager.seek` on a restored bar whose queue is empty, which
   the reducer refuses silently, so the thumb snapped back and the scrub was
   lost; and on an episode that had ENDED every one of them was refused the
   same way. So the rules live here and every surface calls these. */

/** Where the ordinary episode is, as the bar should paint it: a restored or
    finished bar's PENDING position when there is one, else the element's clock. */
function episodePositionSec() {
  if (restoredPending) return restoredPending.positionSec;
  /* WHILE THE LOAD IS IN FLIGHT THE ELEMENT'S CLOCK IS NOT ABOUT THIS EPISODE
     (audit round 2, p-impatient-4 / p-impatient-1). Assigning `src` resets
     `currentTime` to 0 and the resume offset is only written at
     `loadedmetadata`, so for the whole cold load the bar read 0:00 with the
     full runtime left on an episode the listener was 38 minutes into — and a
     ↺15 tapped in that window was computed from that 0, which sent the resume
     point to the store as 0:00 or 0:30. The position the load was ASKED for
     is known here (`loadingStart`), so it is what the bar shows and what a
     nudge steps from until the element holds the item. */
  if (current && loadingStart?.id === current.id
      && manager?.state?.type === "loadingItem" && manager.playheadItemId !== current.id) {
    return loadingStart.sec;
  }
  const t = backend?.currentTime;
  return typeof t === "number" && Number.isFinite(t) ? t : 0;
}

/** The duration the player MEASURED off the media element the last time this
    episode played (`PositionStore` records it beside every position), or null.
    Preferred over the catalogue's `duration_sec` wherever the element itself
    cannot answer (audit round 2, honesty-4): the feed's number is what the
    publisher declared, the measured one is the file that actually played, and
    on an ad-stitched feed they differ by minutes — "Played" or "15 min left"
    computed against the wrong one is a row that lies about the file it names. */
function measuredDurationSec(id) {
  const stored = Number(positionReader().load(id)?.duration);
  return Number.isFinite(stored) && stored > 0 ? stored : null;
}

/** One rule for "how long is this episode" without the element: measured
    first, the catalogue's row second, null when neither knows. */
function knownEpisodeDurationSec(id, catalogueSec) {
  const measured = id ? measuredDurationSec(id) : null;
  if (measured) return measured;
  const cat = Number(catalogueSec);
  return catalogueSec != null && Number.isFinite(cat) && cat > 0 ? cat : null;
}

/** How long the ordinary episode is, or null when nobody knows: the element's
    own answer once it holds this episode, and `knownEpisodeDurationSec`'s
    before that. */
function episodeDurationSec() {
  if (!current) return null;
  const el = backend?.duration;
  if (manager?.playheadItemId === current.id && typeof el === "number" && Number.isFinite(el) && el > 0) return el;
  return knownEpisodeDurationSec(current.id, current.duration_sec);
}

/**
 * THE episode seek. Every surface goes through this.
 *
 * With audio loaded and live, it is `manager.seek`. With NOTHING to seek in —
 * a bar restored at launch (no media behind it, on purpose) or an episode that
 * has ended — the reducer refuses a seek, so the move is written into
 * `restoredPending` instead: the thumb stays where the listener put it, and the
 * next press of play starts THERE (`setRunning`'s restored branch). Before this
 * a scrub on a restored bar was thrown away and play started from the old
 * stored position.
 *
 * The clamp and the pend-or-seek rule are transport-policy.js's
 * (`clampEpisodeTarget`, `seekAction`). NOT `async`: it hands back
 * `landEpisodeSeek`'s own promise, so a caller settles on the same tick it did
 * before the rules moved out (NE-08 changes no behaviour, timing included).
 */
function seekEpisodeTo(seconds) {
  if (!current || foray || !manager) return Promise.resolve(false);
  return landEpisodeSeek(clampEpisodeTarget(seconds, episodeDurationSec()));
}

/** A relative seek, from wherever the bar says the listener is. */
function seekEpisodeBy(offsetSec) {
  if (!current || foray || !manager) return Promise.resolve(false);
  return landEpisodeSeek(skipTarget({
    foray: false, positionSec: episodePositionSec(), offsetSec, durationSec: episodeDurationSec(),
  }));
}

/** Land an already-clamped episode target: written down when there is nothing
    to seek in, sent to the manager otherwise. */
async function landEpisodeSeek(target) {
  if (target == null) return false;
  if (seekAction({ restored: restoredPending != null, stateType: manager.state?.type }) === SEEK.PEND) {
    /* Spread, so a restored FORAY keeps the Foray it will start (`restoreForay`).
       `moved` marks a position the LISTENER chose, so the start honours it even
       at 0:00 — see `setRunning`'s restored branch. */
    restoredPending = { ...(restoredPending ?? { item: current }), positionSec: target, moved: true };
    render();
    return true;
  }
  await manager.seek(target, { precise: true });
  render();
  return true;
}

/** THE ONE NUDGE. ↺15 / 30↻ on the sheet, ↺15 on the mini bar, the Foray
    page's own pair and the lock screen's seek all come here: inside a Foray
    the step is taken on the Foray's clock through `foraySeek` (so it crosses
    a clip boundary the way the scrubber does), otherwise on the episode's.
    Where the step lands is `skipTarget`'s (transport-policy.js). */
function nudgeBy(offsetSec) {
  const offset = Number(offsetSec || 0);
  if (!foray) return seekEpisodeBy(offset);
  /* Where the step lands is `skipTarget`'s, given the Foray's total so the
     nudge stops short of the end the way the episode's does (audit round 2,
     player-5; the scrubber's path is untouched). What a nudge INSIDE a spoken
     line does instead is `nudgeAction`'s (player-11): the synthesiser has no
     offset to seek to, so back re-speaks the line, forward skips it, and the
     live region says which. */
  const playable = foray.resolved.playable;
  const target = skipTarget({
    foray: true, positionSec: forayPosition(), offsetSec: offset, durationSec: foray.resolved.totalSec,
  });
  const at = segmentAtElapsed(playable, target);
  const action = nudgeAction({
    offsetSec: offset,
    landsInCurrentItem: Boolean(at) && at.index === manager?.currentIndex,
    narrationPlayhead: manager?.isNarrationPlayhead === true,
    onLastItem: manager?.currentIndex >= playable.length - 1,
  });
  if (action === NUDGE.RESTART_LINE) {
    announce(NARRATION_RESTARTED_LINE);
    return manager.skipToPrevious().then(() => render());
  }
  if (action === NUDGE.SKIP_LINE) {
    announce(NARRATION_SKIPPED_LINE);
    return ForayPlayer.forayNext();
  }
  if (action === NUDGE.NONE) return undefined;
  return ForayPlayer.foraySeek(target);
}

/* The live region's two words for a nudge inside a spoken line. No
   apostrophes (see EP_START_FAILED). */
const NARRATION_RESTARTED_LINE = "Narration restarted";
const NARRATION_SKIPPED_LINE = "Narration skipped";

/** Say something once through the bar's live region, outside the status
    line's own writes: `paintStatus` re-writes the region only when the STATUS
    changes, so a word said here stands until there is a new status to say. */
function announce(text) {
  if (!ui?.announce) return;
  ui.announce.textContent = text;
}

function render() {
  if (!ui || !current) return;
  syncForaySegment();
  /* A seam beat reads as playing everywhere, or the mini bar shows "▶" while
     the Foray page shows "❚❚ Pause" for the same half second.
     `transportIsRunning()` rather than `isRunning()` since #689: the founder's
     third report is a button that said Play with sound coming out of it, and the
     button the listener presses has to be painted from the same answer the press
     is decided by, or the label and the behaviour are two opinions again. This
     repaints at the next media event or tick — it cannot repaint at the instant
     of a drift nothing announced — but it stops the surface holding the lie
     indefinitely, which is what it did before. */
  const running = transportIsRunning();
  // Sound is coming out: whatever failed before has recovered.
  if (playFailure && running) setPlayFailure(null);
  /* NOTHING ON THE PAGE IS PAINTED WHILE IT IS HIDDEN (audit round 2, perf-7):
     with the screen off in a car this ran every play button on the page, both
     clocks and the scrubber four times a second for a three-hour episode that
     nobody could see. Everything that is NOT the page still runs below — the
     lock screen and the car ARE what is visible then, a Foray's resume row is
     written from here, and the end-of-episode signal that starts the next one
     (`_announceEpisodeEndedIfNeeded`) is the founder's headline case and fires
     with the screen off or not at all. `reconcileOnReturn` repaints in full on
     the way back. */
  if (!(typeof document !== "undefined" && document.hidden === true)) paintPage(running);
  /* The lock screen is repainted from the same tick the page is, so the two can
     never show different states (corner case 11, "lock screen shows correct
     state"). It writes only when something actually changed. A BLOCK comment:
     `media-session.test.js`'s stripper removes line comments last, and an
     apostrophe in one swallows the code after it up to the next apostrophe —
     which, after paintPage moved out of this function, was this very call. */
  syncMediaSession();
  if (foray) {
    persistForayProgress();
    notifyForay();
  } else {
    _announceEpisodeEndedIfNeeded();
  }
}

/** Is the ordinary episode, or the Foray clip, still being fetched? The
    reducer's `loadingItem` minus the two loads that are not "loading" to a
    listener: the seam beat (an authored silence, `isRunning()` already says so)
    and a restored bar, which loads nothing until pressed. */
function isLoading() {
  return manager?.state?.type === "loadingItem" && manager.inSeamGap !== true && !restoredPending;
}

/** The page's own half of a repaint: transport, clocks, scrubber, status line,
    card buttons. Skipped while the document is hidden — see `render()`. */
function paintPage(running) {
  paintStatus();
  /* "››" ON THE LAST SEGMENT IS DISABLED, not silently dead (audit 2026-09-22).
     `forayNext` returns early there, so the button looked live and read "Next
     segment" to a screen reader while doing nothing at all. The listener's
     INTENT index, like the running order's highlight. */
  ui.clipNext.disabled = Boolean(foray) && foray.index >= foray.resolved.playable.length - 1;
  const glyph = running ? "❚❚" : "▶";
  paintControl(ui.playBtn, glyph, running ? "Pause" : "Play");
  paintControl(ui.bigPlay, glyph, running ? "Pause" : "Play");
  /* THE LOAD IS A STATE, and it is shown (audit round 2, p-impatient-4). Between
     the tap and the first audio the glyph honestly says ▶ (persona 15: never
     say playing before audio exists), and until now that was ALL it said — on a
     cold connection the bar slid up reading ▶, 0:00 and the whole runtime, and
     the impatient thumb tapped again. `paintStatus` writes "Loading…" into the
     status line; this marks the controls so styles.css can spin them, and the
     bar as busy for a screen reader. */
  const loading = isLoading();
  for (const btn of [ui.playBtn, ui.bigPlay]) {
    if (loading) { if (btn.dataset.loading !== "1") btn.dataset.loading = "1"; }
    else if (btn.dataset.loading) delete btn.dataset.loading;
  }
  const busy = loading ? "true" : null;
  if (ui.bar.getAttribute("aria-busy") !== busy) {
    if (busy) ui.bar.setAttribute("aria-busy", busy); else ui.bar.removeAttribute("aria-busy");
  }

  /* In a Foray the clock is the Foray's, not the source episode's: 31 minutes
     into somebody else's podcast is not a position this listener recognises. */
  /* A restored bar paints its STORED position, not the element's zero. The
     element has no src yet — that is what makes the restore cheap — so reading
     `backend.currentTime` would show a day-old half-listened episode sitting at
     0:00 with an empty progress bar, which is a quieter version of the bug this
     restore exists to fix. */
  const pos = foray ? forayPosition() : episodePositionSec();
  const dur = foray ? foray.resolved.totalSec : episodeDurationSec();
  /* A RESTORED FORAY'S SECOND LINE FOLLOWS THE THUMB (audit round 2,
     player-10): the clip number was computed once at restore time, so a scrub
     to 45:00 left the bar saying "clip 3 of 32". Recomputed from the same
     `segmentAtElapsed` the seek will use. */
  const pendingForay = restoredPending?.foray?.resolved ?? null;
  if (pendingForay) {
    const at = segmentAtElapsed(pendingForay.playable, pos);
    const line = at ? foraySecondLine(pendingForay.playable, at.index) : ui.show.textContent;
    if (ui.show.textContent !== line) {
      ui.show.textContent = line;
      ui.sShow.textContent = line;
      current.show = line;
      paintInfoLabel();
    }
  }

  /* AN UNKNOWN DURATION PAINTS AN EMPTY BAR, not the last one (audit
     2026-09-22). The reset used to live inside a `dur &&` guard with no else,
     so an episode from a feed with no duration — or any episode for the moment
     before its metadata lands — inherited the PREVIOUS episode's fill and
     thumb: 80% across for something that had not started. `tLeft` below
     already said "--:--"; the bar now agrees with it. */
  /* THE SLIDER IS LEFT ALONE WHILE IT IS THE LISTENER'S: mid-drag
     (`scrubbing`, the thumb and the clocks follow the finger — `paintScrubPreview`)
     and while it has FOCUS (audit round 2, a11y-7: WebKit posts a value-changed
     notification on a focused slider whenever its value or text moves, so a
     VoiceOver user parked on "Seek" heard a running clock talk over their own
     swipes — the same rule the status line already keeps, written only when it
     is theirs to hear). */
  if (!scrubbing) {
    const frac = dur ? Math.min(1, Math.max(0, pos / dur)) : 0;
    ui.fill.style.width = `${frac * 100}%`;
    const live = Math.round(frac * 1000);
    scrubLiveValue = live;
    const held = scrubIsHeld();
    if (!held) {
      ui.scrub.value = String(live);
      scrubShownValue = live;
    }
    paintClocks(pos, dur, !held);
  }
  syncCardButtons(loading);
  paintEpisodeSurface();
}

/**
 * The two clocks and the slider's spoken value, from ONE position (audit round
 * 2, player-6 / honesty-13). `pos` and `dur` are the same seconds `render()`
 * paints from, or the thumb's while a drag is in progress.
 *
 * THE COUNTDOWN IS DERIVED FROM THE CLOCK THE LISTENER SEES, not from the raw
 * difference: elapsed rounds (episode) or floors (Foray) on its own, and a
 * countdown rounded separately made 13 + 48 = 61 out of 12.5 s into 60. Both
 * clocks go through the same formatter's rule first, so they add up.
 */
function paintClocks(pos, dur, valuetext = true) {
  const whole = foray ? Math.floor : Math.round;
  const now = foray ? fmtClock(pos) : formatTimestamp(pos, EXACT);
  if (ui.tNow.textContent !== now) ui.tNow.textContent = now;
  const left = dur ? remainingClock(whole(dur) - whole(pos)) : "--:--";
  if (ui.tLeft.textContent !== left) ui.tLeft.textContent = left;
  if (!valuetext) return;
  /* The slider's value is a 0-1000 fraction, which is what a screen reader
     read out ("Seek, 437"). The clock beside it is the listener's unit, so the
     slider says that instead. */
  const text = dur
    ? `${now} of ${foray ? `${foray.resolved.estimated === true ? "about " : ""}${fmtClock(dur)}` : formatTimestamp(dur, EXACT)}`
    : now;
  if (ui.scrub.getAttribute("aria-valuetext") !== text) ui.scrub.setAttribute("aria-valuetext", text);
}

/** Is the slider a keyboard or screen-reader user's right now — focused, and
    not by the pointer that is dragging it? See `scrubShownValue`. */
function scrubIsHeld() {
  return typeof document !== "undefined" && document.activeElement === ui.scrub && !scrubByPointer;
}

/** A discrete step on a frozen slider (the first `input` of a key press or a
    VoiceOver swipe — never mid-drag, where the thumb's value is absolute) moves
    from where the AUDIO is, not from where the value froze. */
function rebaseHeldScrubStep() {
  if (scrubbing || !scrubIsHeld()) return;
  if (scrubShownValue == null || scrubLiveValue == null) return;
  const step = Number(ui.scrub.value) - scrubShownValue;
  if (!Number.isFinite(step)) return;
  const next = Math.min(1000, Math.max(0, scrubLiveValue + step));
  ui.scrub.value = String(next);
}

/** Mid-drag: the clocks follow the THUMB, not the audio (audit round 2,
    player-6). The seek itself happens on `change`; this is only the readout the
    listener aims with — Apple Podcasts shows the target time as you drag, and
    ours kept counting the audio that was still playing until release. */
function paintScrubPreview() {
  if (!ui || !current) return;
  rebaseHeldScrubStep();
  scrubbing = true;
  const dur = foray ? foray.resolved.totalSec : episodeDurationSec();
  const at = (Number(ui.scrub.value) / 1000) * (dur || 0);
  paintClocks(at, dur);
}

/** The mini bar's title button: named by what is playing, and telling a screen
    reader which way it goes. Called wherever either half changes — a new
    episode (setNowPlaying) and the sheet opening or closing (setExpanded). */
function paintInfoLabel() {
  if (!ui) return;
  /* The line the bar SHOWS: while a failure or buffering line stands in for
     the show line, that is what the button is named with — the hidden show
     line was still being read out beside a failure nobody was told about. */
  const second = ui.err && !ui.err.hidden ? ui.err.textContent : ui.show.textContent;
  const what = [ui.title.textContent, second].filter(Boolean).join(", ");
  paintControl(ui.info, null, what ? `Now playing: ${what}` : "Now playing");
  ui.info.setAttribute("aria-expanded", ui.sheet && !ui.sheet.hidden ? "true" : "false");
}

/** `loading` is the caller's word on whether the current item's load is still
    in flight (`paintPage` passes `isLoading()`; a stop passes nothing). */
function syncCardButtons(loading = false) {
  /* Reflect play state on the originating card so the page and the bar agree.
     `transportIsRunning()`, the same authority `render()` paints the bar from
     two calls up (audit 2026-09-22). This read `isPlaying()` under a comment
     promising "a seam beat reads as playing everywhere", so during the 0.5 s
     beat — and in the #689 drift, sound out of a machine that says paused — the
     card showed "▶" beside a bar showing "❚❚". Since #735 the card's press
     delegates to the bar's toggle, so its glyph has to come from the same
     answer that toggle decides by. */
  const running = transportIsRunning();
  /* EVERY WRITE BELOW IS COMPARED FIRST (audit round 2, perf-7): this walks
     every row on a show page four times a second, and the DOM was being told
     the same thing each time. The walk itself stays — app.js re-renders rows
     without telling the player, and a diff on the player's own state alone
     would leave a fresh row saying ▶ beside a bar saying ❚❚. */
  document.querySelectorAll("[data-play]").forEach((b) => {
    const mine = current && b.dataset.play === current.id;
    const on = mine && running;
    if (on) { if (b.dataset.playing !== "1") b.dataset.playing = "1"; }
    else if (b.dataset.playing) delete b.dataset.playing;
    /* The row's button spins with the bar's (p-impatient-4). */
    if (mine && loading) { if (b.dataset.loading !== "1") b.dataset.loading = "1"; }
    else if (b.dataset.loading) delete b.dataset.loading;
    /* The row's own title, stamped by app.js's playBtn: `current` is a
       different episode on every row but one. */
    const title = b.dataset.title || "this episode";
    paintControl(b, on ? "❚❚" : "▶", `${on ? "Pause" : "Play"} ${title}`);
  });
}

function setNowPlaying(item, why) {
  /* CLEARED HERE, because this is the one function every path to "something
     else is current now" goes through — an ordinary play, a Foray segment, a
     restore. Clearing it in `play()` alone would leave a restored bar armed
     while a DIFFERENT episode played, and the next press of the mini bar would
     abandon what was playing to start yesterday's episode instead.
     `restoreLastEpisode` sets it immediately AFTER calling this, which is why
     the order there is not an accident. */
  restoredPending = null;
  current = item;
  ui.root.hidden = false;
  document.body.classList.add("fp-open");
  ui.title.textContent = item.title || "";
  ui.show.textContent = item.show || "";
  paintInfoLabel();
  ui.sTitle.textContent = item.title || "";
  ui.sShow.textContent = item.show || "";
  /* Emptied paragraphs are HIDDEN, not left blank (audit 2026-09-22): both
     carry margins, so an empty one was a dead band in the sheet — on every
     Foray, which never has a hook. `sDesc` below always did it this way. */
  ui.sWhy.textContent = why || item.hook || "";
  ui.sWhy.hidden = !ui.sWhy.textContent;
  if (item.artwork_url) {
    ui.art.src = item.artwork_url;
    ui.art.hidden = false;
    /* The same URL, the same gate: the sheet's artwork is the mini bar's
       artwork at full size, never a second source that could disagree with
       it. Assigned through `src` on an element built by createElement, like
       every other field here — there is no HTML-string path in this file for
       a third-party URL to escape through. */
    ui.sArt.src = item.artwork_url;
    ui.sArt.hidden = false;
  } else {
    ui.art.hidden = true;
    ui.sArt.hidden = true;
    ui.sArt.removeAttribute("src");
  }
  paintNotes(item);
  /* A RESTORED FORAY (`restoreForay`) is a bar with a Foray behind it and no
     `foray` loaded yet: it links to its Foray page, never to an episode page
     that does not exist. */
  const forayId = foray ? foray.resolved.id : (item.forayId ?? null);
  if (item.id && !item.forayId) {
    // Our own route, built from our own id — mirrors ui.forayLink below:
    // an in-app hash change, never target="_blank".
    ui.openLink.href = `#/episode/${encodeURIComponent(item.id)}`;
    ui.openLink.hidden = false;
  } else {
    ui.openLink.hidden = true;
  }
  if (forayId) {
    // Our own route, built from our own id — the only interpolation here is
    // encodeURIComponent's output, so no scheme can be smuggled in.
    ui.forayLink.href = `#/foray/${encodeURIComponent(forayId)}`;
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
  ui.note.hidden = !ui.note.textContent;
  /* Something else is current now, so neither the last item's failure nor its
     stall describes it. */
  buffering = false;
  setPlayFailure(null);
  render();
}

/* ---------- the notes in the sheet (audit round 2, p-switcher-2) ----------

   Built from `window.ForayNotes.tokens`, app.js's one tokeniser — the same
   pass `episodeDescriptionHtml` feeds the episode page — so a URL or a
   timestamp is recognised in exactly one place. Each token becomes a NODE:
   `textContent` for prose, `href` on an <a> for a link (the scheme re-checked
   here, though app.js's `safeUrl` already refused anything but http(s)), and
   a `data-ts` button for a stamp that seeks through `seekEpisodeTo` — the
   same seek the scrubber and the page's own stamps take. `innerHTML` never
   appears: an RSS description is third-party text, and the file's header rule
   does not bend for a feature.

   PLAIN TEXT FOR A FORAY (`foray` set). A clip's notes belong to its source
   episode, and a stamp in them would seek the Foray's clock somewhere the
   episode meant; `seekEpisodeTo` refuses inside a Foray anyway, so the honest
   paint is text with nothing to press. Also plain when app.js has not
   published the tokeniser (a harness, or a page paired with an older
   cached app.js): the sheet degrades to what it showed before, never to
   nothing. */
function paintNotes(item) {
  const text = item?.description || "";
  ui.sDesc.hidden = !text;
  /* A `textContent` write: the paragraph is prose, not a control, and
     test/toggle-labels.test.js lists it as one (NOT_CONTROLS). Not
     `replaceChildren`/`createTextNode` — the real-client harnesses
     (transport-reconcile, diagnostic-record) drive this path over a DOM stub
     that has neither, and a paint helper must not be the reason a seam test
     dies. Token text goes in through `append(string)`, which the DOM turns
     into a text node itself. */
  ui.sDescText.textContent = "";
  if (!text) return;
  const notes = typeof window !== "undefined" ? window.ForayNotes : null;
  /* `lines` (the line-aware pass, with chapter rows) when the page offers it;
     `tokens` from a page of the vintage before it (audit round 2 review). */
  const read = notes && typeof notes.lines === "function" ? notes.lines
    : notes && typeof notes.tokens === "function" ? notes.tokens : null;
  const tokens = !foray && read ? read(text, episodeDurationSec()) : null;
  if (!Array.isArray(tokens)) { ui.sDescText.textContent = text; return; }
  for (const t of tokens) {
    /* A STAMP-LED LINE IS A 44px CHAPTER ROW HERE TOO (audit round 2 review
       of touch-10): the whole line is one button, the episode page's own
       `.ep-chapter-row`, not a ~21px inline stamp. */
    if (t.kind === "chapter" && Number.isFinite(t.secs)) {
      const row = el("button", "ep-chapter-row");
      row.type = "button";
      row.dataset.ts = String(t.secs);
      if (t.label) row.setAttribute("aria-label", t.label);
      row.append(el("span", "ep-chapter-time", String(t.stamp ?? "")), el("span", "ep-chapter-title", String(t.title ?? "")));
      row.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        seekEpisodeTo(t.secs).catch(() => {});
      });
      ui.sDescText.append(row);
      continue;
    }
    if (t.kind === "link" && /^https?:\/\//i.test(String(t.href || ""))) {
      const a = el("a", null, t.text);
      a.href = t.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      ui.sDescText.append(a);
    } else if (t.kind === "stamp" && Number.isFinite(t.secs)) {
      const b = el("button", "ep-ts", t.text);
      b.type = "button";
      b.dataset.ts = String(t.secs);
      if (t.label) b.setAttribute("aria-label", t.label);
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        seekEpisodeTo(t.secs).catch(() => {});
      });
      ui.sDescText.append(b);
    } else {
      ui.sDescText.append(String(t.text ?? ""));
    }
  }
}

/* ---------- what the bar says when there is no sound ----------

   Audit 2026-09-22, two silences the transport did not explain:

   - A FAILED EPISODE LOAD said nothing anywhere. `play()` returned true
     whatever happened, the bar slid up with "▶" and "--:--", and app.js's
     `if (!ok)` guard was dead code. The failure itself is `setPlayFailure`
     above (one state, with the autoplay split); this paints it.
   - A NETWORK STALL was painted as playing. `waiting` was subscribed only to
     write a diagnostic row, so the button kept saying Pause over silence and
     the car said PLAYING, and a listener at 70 mph had no way to tell a dead
     zone from a crash.

   Both are painted in the mini bar's second line — the one line always on
   screen, a live region, standing in for the show line while it is up — and
   in the sheet's status line under the transport. INTEGRATION (2026-09-22):
   L2 and L5 each fixed the failure half; this is L5's state and elements with
   L2's buffering and short bar copy, painted from one place. The bar's short
   form uses the same verb as the sheet's sentence (see EP_START_FAILED). */
const EPISODE_FAILED_LINE = "Couldn't load — press play to try again";
const BUFFERING_LINE = "Buffering…";
/** Between the tap and the first audio (audit round 2, p-impatient-4). The
    Foray page says the same word from the same state (`snapshot.loading`). */
const LOADING_LINE = "Loading…";
/** What a screen reader hears when Stop takes the player away (a11y-6). */
const STOPPED_LINE = "Stopped";
/** The element is waiting for data while the transport is running. */
let buffering = false;
/** The last STATUS the live region was given — see `paintStatus`. */
let lastAnnouncedStatus = "";

/** Only `waiting` starts it, deliberately not `stalled`: `stalled` means the
    FETCH has stopped delivering, which a well-buffered element plays straight
    through — painting "Buffering…" over audible sound would be a new lie in
    place of the old one. `waiting` is playback actually halted for data. */
function setBuffering(on) {
  const next = Boolean(on) && transportIsRunning();
  if (next === buffering) return;
  buffering = next;
  render();
}

/** The one painter for the bar's and the sheet's status lines: a failure,
    else the load, else a stall, else nothing.

    A FORAY'S FAILURE SHOWS HERE TOO (audit round 2, player-7). It used to be
    dropped — "a Foray keeps its own failure line on its page" — which assumed
    the page was on screen, and it is not for a Foray started from the restored
    ribbon, Jump back in, the lock screen or the car: a clip that 404'd there
    paused into a bar reading ▶ over the Foray's title and nothing anywhere said
    why. The page keeps its richer line; the bar and the sheet get the same
    short sentence an episode gets. `syncForaySegment` clears `foray.error` the
    moment audio flows. */
function paintStatus() {
  const failure = foray ? (foray.error ? EPISODE_FAILED_LINE : null) : playFailure;
  const barLine = failure
    ? (failure === EP_PLAY_HELD ? EP_PLAY_HELD : EPISODE_FAILED_LINE)
    : (isLoading() ? LOADING_LINE : (buffering ? BUFFERING_LINE : ""));
  const sheetLine = failure || (isLoading() ? LOADING_LINE : (buffering ? BUFFERING_LINE : ""));
  if (ui.err.textContent !== barLine) ui.err.textContent = barLine;
  ui.err.hidden = !barLine;
  ui.show.hidden = Boolean(barLine);
  if (ui.sErr.textContent !== sheetLine) ui.sErr.textContent = sheetLine;
  ui.sErr.hidden = !sheetLine;
  /* Written only when the STATUS changes, so a repaint does not re-announce
     it — and so a one-off word said through `announce()` is not wiped by the
     very next tick. */
  if (ui.announce && lastAnnouncedStatus !== sheetLine) {
    lastAnnouncedStatus = sheetLine;
    ui.announce.textContent = sheetLine;
  }
  paintInfoLabel();
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
   overrule it.

   AND THE MANAGER, NOT ONLY THE LABEL (audit 2026-09-22, qa row 168). A player
   booted inside that window — the restored ribbon boots at launch — built its
   manager from the stored rate as it stood THEN, which was the default. The
   repaint above then read `manager.rate` back and confirmed the wrong 1x for the
   whole session. So when hydration lands, the stored speed is handed to a
   manager that already exists. A speed the listener chose inside the window is
   safe without a flag here: `applyRate` wrote it, and hydration never clobbers
   a key written since the store was built, so `readRate` answers their choice.

   ON `storageHydrated`, NOT THE BOUNDED `storageReady` (review, 2026-09-23). The
   bound exists for the field record, whose rows are only worth writing while
   the page is alive; this block reads a VALUE that only hydration can supply.
   Run at the five-second bound it read the default speed, found it equal to
   the manager's, corrected nothing, and never ran again -- so a listener whose
   localStorage had been swept and whose durable tier answered at six seconds
   kept 1x for the session. That is the exact regression this block was written
   to prevent. */
storageHydrated.then(() => {
  if (manager) {
    const stored = readRate(storage);
    if (stored !== manager.rate) manager.setRate(stored);
  }
  paintRate();
  notifyForay();
}).catch(() => {});

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
  paintControl(ui.rateBtn, rateLabel(rate), rateAriaLabel(rate));
}

/* ---------- V-01: the listener's chosen narration voice ----------

   Same split as playback speed just above: this file owns the ONE `cp_voice`
   key and the ONE write path, `queue-manager.js` owns applying it to the next
   `speak()` call (its own §"the listener's narration voice"). Deliberately
   NOT a `player/voice.js` module the way `playback-rate.js` is — there is no
   ladder, no label table, no snapping-onto-a-stop logic to keep pure and
   testable in isolation; a voice identifier is an opaque string from
   `listVoices()`, stored and handed back unchanged. */

/** localStorage key (durable-store.js's `cp_` discipline; CLAUDE.md §
    Conventions — renaming this wipes a listener's chosen voice). Platform is
    folded into the identifier's OWN meaning (`listVoices()` reports
    platform-specific identifiers already — an iOS `AVSpeechSynthesisVoice`
    identifier and an Android `Voice.getName()` never collide in shape), so
    one key covers both rather than `cp_voice_ios`/`cp_voice_android` guessing
    which platform a stored value came from. */
const VOICE_KEY = "cp_voice";

/** The stored voice identifier, or `null` for "let the plugin pick its own
    best-installed tier" — the same default `queue-manager.js`'s constructor
    already treats a missing `voice` option as. */
function readVoice(store) {
  if (!store || typeof store.getItem !== "function") return null;
  try {
    const raw = store.getItem(VOICE_KEY);
    return typeof raw === "string" && raw ? raw : null;
  } catch (_) {
    return null;
  }
}

/** Write the choice down, or clear it. Never throws — same posture as
    `writeRate`: a value that cannot be stored is still a value that should
    govern this session, so the caller applies either way. */
function writeVoice(store, id) {
  if (!store || typeof store.setItem !== "function") return false;
  try {
    if (id) store.setItem(VOICE_KEY, String(id));
    else if (typeof store.removeItem === "function") store.removeItem(VOICE_KEY);
    return true;
  } catch (_) {
    return false;
  }
}

/** Apply and persist a voice choice. Mirrors `applyRate`: works with nothing
    booted (`manager` may not exist yet — a listener can pick a voice before
    ever pressing play), and the write is not guarded on a throw because
    `writeVoice` never throws. */
function applyVoice(id) {
  const v = typeof id === "string" && id ? id : null;
  writeVoice(storage, v);
  if (manager) manager.setVoice(v);
  return v;
}

/** The session's DEFAULT voice — Samantha's best installed identifier per
    `default-voice.js` (founder decision 2026-09-10) — held here and NEVER
    written to `cp_voice`, so "never chose" stays distinguishable from "chose
    Samantha" (that module's header says why). `null` until a `listVoices()`
    result has been seen, or when no Samantha is installed at all, in which
    case the manager keeps `null` and the plugin's own #491 heuristic picks. */
let sessionDefaultVoice = null;

/** Adopt the default from a `listVoices()` result, ONLY while nothing is
    stored: a stored choice always wins and is never overwritten here.
    Applied to the manager session-only (`setVoice`, not `applyVoice`, so no
    storage write). Re-run on every list refresh, so a Samantha Enhanced
    downloaded mid-session — which changes the best identifier — is picked
    up the next time the picker asks what is installed. */
function adoptDefaultVoice(voices) {
  if (readVoice(storage)) return null;
  sessionDefaultVoice = pickDefaultVoice(voices);
  if (manager && manager.voice !== sessionDefaultVoice) manager.setVoice(sessionDefaultVoice);
  return sessionDefaultVoice;
}

/** Resolve the default once for narration, so the first spoken item on a
    phone with no stored choice is Samantha rather than #491's pick. Called
    from `ensureBooted` after the manager exists; the first narration item
    can still race ahead of the plugin's answer, and then speaks with the
    plugin's own fallback, which is the designed degradation. Never rejects. */
async function resolveDefaultVoice() {
  if (readVoice(storage)) return null;
  try {
    const out = await ttsBridge.listVoices({ lang: VOICE_LIST_LANG });
    return adoptDefaultVoice((out && out.voices) || []);
  } catch (_) {
    return null;
  }
}

/** The mini-player's speed picker (#349). Same fix as the Foray page's
    #fy-rate: this button used to cycle to the next stop on every tap, with no
    way to see or jump straight to any of the other five. Opens a small menu
    naming every stop on the ladder instead — copied from what Apple Podcasts,
    Spotify, Overcast and Pocket Casts all do — built fresh each open so it
    never shows a stale "current" mark, and torn down on any dismissal. */
let rateMenuEl = null;

/** app.js's one modal owner (`openSheet`/`closeSheet`: focus in and back out,
    `inert` on the page behind, Tab kept inside, Escape, one instance, and the
    body lock derived from what is actually open). app.js is a classic script
    and this is a module, so it is published on `window`; app.js evaluates
    first, so it is there by the time anything here can open. `null` only in a
    harness that loads this file without app.js — and then the sheet still
    opens and closes, it just owns none of the above. */
function sheetOwner() {
  return (typeof window !== "undefined" && window.ForaySheets) || null;
}

function closeRatePicker() {
  if (!rateMenuEl) return;
  const owner = sheetOwner();
  if (owner) owner.closeSheet(rateMenuEl);
  else document.body.classList.remove("fy-sheet-open");
  rateMenuEl.remove();
  rateMenuEl = null;
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
  rateMenuEl = wrap;
  const owner = sheetOwner();
  if (owner) owner.openSheet(wrap, { panel, onRequestClose: closeRatePicker });
  else document.body.classList.add("fy-sheet-open");
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
/**
 * A bar restored from storage that has never loaded audio (founder, 2026-09-18).
 *
 * The restored ribbon is a real `current` with a real position and NO loaded
 * media behind it — the whole point is that it costs nothing until it is
 * wanted. `manager.resume()` has nothing to resume in that state, so the first
 * press has to be a full start-then-seek instead. One flag, cleared by the
 * press, and `setRunning` is the choke point every press goes through — the tap,
 * the lock screen, the car, the headphone pinch — so none of them can miss it.
 *
 * ALSO THE PENDING START OF A BAR WITH NOTHING TO SEEK IN (audit 2026-09-22):
 * `seekEpisodeTo` writes a scrub or a ↺/↻ here when the bar is restored or its
 * episode has ended, so the thumb stays where the listener put it and the next
 * press starts there. Same shape, same single reader.
 */
let restoredPending = null;

/** The last page's Foray callback (`watchForay`), for a Foray that is started
    from somewhere other than its page. */
let forayWatcher = null;

/** What `resolveToggle` (transport-policy.js) needs to know, read now. Only
    reads: asking twice in one press is free. */
function toggleInputs(want, { restored }) {
  return {
    want,
    restored,
    foray: Boolean(foray),
    stateType: manager.state?.type ?? null,
    running: transportIsRunning(),
    hasCurrent: Boolean(current),
    queueLength: manager.queue.length,
  };
}

async function setRunning(want, source = "tap") {
  if (!manager) return;
  /* The rule is `resolveToggle`'s; this function only acts on its answer. It
     is ASKED TWICE, around the reconcile below, because that is where the old
     inline code decided: the restored branch before the element is consulted,
     everything else after. The second ask passes `restored: false` because the
     restored branch has already been decided by the first. */
  if (resolveToggle(toggleInputs(want, { restored: Boolean(restoredPending) })) === TOGGLE.PLAY_RESTORED) {
    const { item, positionSec, moved, foray: pendingForay } = restoredPending;
    restoredPending = null;
    diag.transport(source, "play-restored");
    /* A RESTORED FORAY starts the Foray, at the position the bar shows — the
       same `startElapsedSec` path the Foray page's own resume uses, so the two
       cannot land in different places. */
    if (pendingForay) {
      await ForayPlayer.playForay(pendingForay.resolved, {
        startElapsedSec: positionSec, discoverDoc: pendingForay.discoverDoc ?? null,
      });
      return;
    }
    /* `play(item)`, NOT `play(item, null)`.
       FOUNDER, 2026-09-22, on build 2026092224: "the play button works on the
       Jump back in card but it does not work from the now playing bar down at
       the bottom."
       `play`'s signature is `(item, { why = "" } = {})`, and a DEFAULT PARAMETER
       ONLY APPLIES TO `undefined`. `null` is destructured, so the call threw
       `Cannot read properties of has-no-'why'` before `ensureBooted`,
       `setQueueFromPick` or `manager.play(0)` ran — the restored ribbon's very
       first press crashed in the one branch that can load the audio.
       And it crashed UNRECOVERABLY, because `restoredPending` is cleared two
       lines above: every later press fell through to the ordinary path and
       called `manager.resume()` on a queue that is still empty, which answers
       `resume.ignored.noCurrentItem` and repaints. Hence four `play from tap`
       rows in the founder's record and no audio. The fallback below is what
       makes that second half impossible regardless of this line. */
    /* THE START POSITION RIDES ON THE LOAD (audit round 2, races-1). This used
       to be `play(item)` then `manager.seek(positionSec)`, and a second press
       inside the load window — a different row's ▶ on Home — let the seek land
       on whatever loaded next: the new episode started at yesterday's position
       in the old one. `manager.play(index, { startOffset })` carries it into
       `_loadItem`, where a superseded load spends it and its successor never
       sees it, so there is no second step to race.
       A SCRUB TO 0:00 IS STILL A SCRUB (review 2026-09-23): a position the
       listener set (`moved`) is always the start, even 0; the stored one only
       when it is past the start, as before — otherwise the load resumes as a
       cold start does, from the store. */
    await ForayPlayer.play(item, (moved || positionSec > 0) ? { startOffset: positionSec } : undefined);
    render();
    return;
  }
  /* M-03(b). RECORDED BEFORE THE EARLY RETURN, and that is the interesting
     case rather than an accident: a remote command that arrives while the
     player already believes it is in that state does nothing, and "the car's
     play button did nothing" is exactly what F5 reported. A record that only
     logged the presses that changed something would be silent for precisely
     the presses being complained about. */
  diag.transport(source, want ? "play" : "pause");
  /* ASK THE ELEMENT BEFORE ACTING ON A BELIEF (#689, #688).
     Until now the only comparison of belief against reality in the whole app
     happened on `visibilitychange`, and a press was decided from the cache. That
     is the shape of #688 — the car's pause was honoured, the play that followed
     found `isRunning()` already false and repainted instead of resuming — and
     `visibilitychange` does not fire for a remote command arriving at an app
     that never went away. A press is the other boundary at which a lie becomes
     both observable and expensive, so it gets the same check.
     Awaited, and the short-circuit below reads the corrected answer: a reconcile
     that ran after the decision would be a diagnostic rather than a fix. It only
     ever moves the machine towards paused (see its own header), so this cannot
     start audio; the `want` branch below is still the only thing that can.
     GUARDED WITH THE RECONCILE'S OWN FIRST CONDITION, and that is about #225
     rather than about speed. `reconcileWithBackend` opens with
     `if (this.state.type !== "playing") return false`, so this changes no
     outcome — but it keeps the RESUME path (which is never in `playing`) free of
     an await between the tap and `manager.resume()`. A microtask does not end
     Safari's gesture window, so this is belt and braces; it is cheap, and #225
     is the bug where the belt broke. */
  if (isPlaying()) await manager.reconcileWithBackend(`transport:${source}`);
  const action = resolveToggle(toggleInputs(want, { restored: false }));
  /* A FINISHED FORAY STARTS OVER (audit 2026-09-22; `endedPlayAction`).
     `manager.resume()` from `ended` re-loads the LAST segment at its in-point,
     so "play" on a Foray that had finished replayed its final ninety seconds and
     ended again — while the Foray page's button offered to "Resume" something
     with nothing left to resume. The page now says "Start over", and this is
     what makes that true for every surface that presses play. */
  if (action === TOGGLE.START_OVER) {
    await ForayPlayer.forayJump(0);
    return;
  }
  /* `transportIsRunning()`, NOT `isRunning()` (`toggleInputs`' `running`). The
     belief alone is what made a press a no-op when it was wrong — "the button
     said play, sound was coming out, and pressing it did nothing but repaint". */
  if (action === TOGGLE.NONE) { render(); return; }
  if (action !== TOGGLE.PAUSE) {
    /* NOTHING LOADED, BUT SOMETHING SHOWING: load it rather than resume it.
       `manager.resume()` answers `resume.ignored.noCurrentItem` on an empty
       queue and repaints, which is a button that does nothing — and the ribbon
       can genuinely be in that state, because the launch restore paints an
       episode with no media behind it on purpose. The restored branch above is
       what normally loads it; this is what happens when that branch has already
       been spent (2026-09-22: it was spent by a press that then threw, and every
       later press landed here and did nothing).
       Written against the QUEUE rather than against a flag, so it does not care
       WHY the queue is empty — which is the difference between fixing one bug
       and closing the shape of it. */
    if (action === TOGGLE.LOAD) {
      /* The start rides on the load, exactly as the restored branch does and
         for the same reason (races-1). `resumeOffset` is the one owner of
         "where did the listener get to" (#26), so this cannot disagree with
         the ribbon that is already on screen. */
      const at = positionReader().resumeOffset(current.id, {
        duration: current.duration_sec ?? null,
      });
      await ForayPlayer.play(current, at > 0 ? { startOffset: at } : undefined);
      render();
      return;
    }
    await manager.resume();
  } else await manager.pause();
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
  /* Closing the bar is not "I am done with this Foray", it is "get this off my
     screen". Keep the resume point; the only thing that clears it is finishing.
     BOTH STORES (audit round 2, player-3): this flushed the Foray row and let
     the episode row stand at whatever was last written — a scrub made while
     paused is never written by the reducer (`handleSeek` saves the position
     being LEFT, and nothing writes while paused), so Stop after pause-and-scrub
     lost the scrub. Leaving is a flush, whichever store. */
  if (persist) flushPositions();
  await manager.stop();
  if (media) media.release();
  lastMediaPositionKey = null;
  /* THE ROOT HIDES FIRST, THEN THE OWNER LETS GO (audit round 2, a11y-6).
     Stop is pressed from inside the open sheet, so the owner has to release
     the page — otherwise it would stay `inert` with no sheet on screen. But
     `closeSheet` hands focus back to the bar's title button, and the very next
     line used to hide the whole player: focus died on a hidden element and a
     screen-reader user was left nowhere, with nothing said. Hidden BEFORE the
     release, the owner's own hidden-subtree check skips that button; focus
     that was on Stop itself is blurred for the same reason; and the page's
     one landing rule (`landOnPage` — the heading, or #view) takes over, then
     the stop is announced from app.js's region, which the hidden root cannot
     silence. */
  ui.root.hidden = true;
  ui.sheet.hidden = true;
  const active = document.activeElement;
  if (active && active !== document.body && typeof ui.root.contains === "function"
      && ui.root.contains(active) && typeof active.blur === "function") active.blur();
  const owner = sheetOwner();
  if (owner) owner.closeSheet(ui.sheet);
  document.body.classList.remove("fp-open", "fp-expanded");
  const nav = typeof window !== "undefined" ? window.ForayNav : null;
  if (nav && typeof nav.landOnPage === "function") nav.landOnPage({ navigated: false });
  if (nav && typeof nav.announce === "function") nav.announce(STOPPED_LINE);
  current = null;
  /* The bar is gone, so there is nothing armed to resume into. The stored
     POINTER stays: closing the bar is "get this off my screen", not "forget
     what I was listening to" — the same distinction the Foray resume point
     makes two lines above. */
  restoredPending = null;
  // Same shape the live snapshot has, so the page never has to guess which
  // fields it got.
  const wasForay = foray;
  foray = null;
  if (wasForay?.onChange) {
    wasForay.onChange({
      forayId: wasForay.resolved.id, index: -1, loading: false, playing: false,
      running: false, ended: false, elapsedSec: 0, totalSec: wasForay.resolved.totalSec, error: null,
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

/**
 * A stop from outside the page. A PAUSE, unless it is the Android notification's
 * own Stop button (`details.close`, sent as `CLOSE_ACTION` by
 * foray-media-session.js), which closes the player: `stopAndClose()` ->
 * `media.release()` clears the metadata, which is what stops the foreground
 * service and takes the notification away (docs/android-lock-screen.md §4.1).
 * A car's or a Bluetooth stack's stop reaches Media3's `handleStop` instead and
 * never carries `close`, so the drive-safety half of the 2026-09-22 audit holds.
 */
function remoteStop(details) {
  diag.transport("remote", "stop");
  if (remoteStopAction(details) === REMOTE_STOP.CLOSE) return stopAndClose();
  return setRunning(false, "remote");
}

/** In a Foray, previous/next are SEGMENTS — the same functions the ‹‹ / ››
    buttons call, so `forayPrevious`'s restart-vs-previous window is inherited
    rather than restated. Seeking is on the Foray's clock, through the scrubber's
    own path. */
const forayMediaSurface = {
  /* `"remote"` (M-03(b)): a press that came from the lock screen, the car or
     the headphone pinch rather than from our own page. The distinction is the
     whole of F5 — "pressed play on the car's controls, nothing happened" —
     and until now the record could not tell that from a tap on the mini bar. */
  play: () => setRunning(true, "remote"),
  pause: () => setRunning(false, "remote"),
  /* A REMOTE STOP IS A PAUSE (audit 2026-09-22). It used to be
     `stopAndClose()`, whose `media.release()` unregisters EVERY handler: one
     press of a head unit's square — or a Bluetooth stack's hang-up gesture —
     blanked the car display, hid the mini bar and left every hardware button
     wired to nothing, recoverable only by unlocking the phone mid-drive. Apple
     Podcasts has no destructive control on the lock screen, and iOS declines
     `stop` natively anyway (ForayAudioPlugin.swift). The teardown stays behind
     the in-page Stop button, which is the one place a person asks for it —
     and behind the Android notification's own Stop button, which arrives as
     `{ close: true }` (`remoteStop`): on API 24-33 that notification cannot be
     swiped away, so its Stop is the listener's only exit. */
  stop: (details) => remoteStop(details),
  next: () => ForayPlayer.forayNext(),
  previous: () => ForayPlayer.forayPrevious(),
  seekBy: (offset) => nudgeBy(offset),
  seekTo: (position) => ForayPlayer.foraySeek(position),
};

/**
 * The page's answer to "what comes before and after this episode", or null.
 *
 * The player's queue is one item (`SINGLE_ITEM`) and knows nothing about Up
 * Next — that list is app.js's. So the NEIGHBOURS are the page's to say, through
 * `ForayPlayer.setEpisodeNavigation({ next, previous })`. The old comment here
 * cited product principle 1 as "no autoplay chains"; the founder reversed that
 * on 2026-09-14 (docs/DECISIONS.md, CLAUDE.md principle 1: continuous playback
 * is WANTED), and with a full Up Next list the steering wheel's skip was greyed
 * out — the one gesture a driver can make without looking.
 */
let episodeNavigation = null;

/** A neighbour action, or null when the page has not offered one — and null is
    what makes `mediaSessionActions` leave the OS button out entirely rather than
    install one that does nothing. */
function episodeNeighbour(which) {
  const fn = episodeNavigation?.[which];
  return typeof fn === "function" ? () => fn() : null;
}

/** The page answers "next after WHAT" from `currentEpisodeId()`, and the
    actions are installed BEFORE `setNowPlaying` moves `current` (the F5 order
    above), so the first install asked about the previous episode. Asked again
    once `current` is the new item — only when the page has offered neighbours
    at all, so a page without Up Next costs nothing. */
function reaskEpisodeNeighbours() {
  if (episodeNavigation && media && current && !foray) media.setActions(episodeMediaSurface);
  paintEpisodeSurface();
}

/** The sheet's ⏭, Up Next link and Save, from the page's episode surface (see
    `buildUI`'s row2). Every reading is a getter on the page's object, taken now,
    so the count and the saved state are the list's and the stars' as they are
    at this paint. A Foray hides all three: its next is a clip, its Up Next is
    not consulted, and its "current" is not an episode a star can name. */
function paintEpisodeSurface() {
  if (!ui) return;
  const nav = episodeNavigation;
  /* `current`/`foray` directly rather than `ForayPlayer.currentEpisodeId()`:
     the same answer, without a read of a `const` this render may reach
     before the object is built. */
  const id = !foray && current?.id && !current.forayId ? current.id : null;
  const showEpisode = Boolean(nav && id);
  let hasNext = false;
  let count = 0;
  let saved = false;
  if (showEpisode) {
    try { hasNext = typeof nav.next === "function"; } catch (_) { hasNext = false; }
    try { count = Number(nav.upNextCount) || 0; } catch (_) { count = 0; }
    try { saved = typeof nav.isSaved === "function" && nav.isSaved(id) === true; } catch (_) { saved = false; }
  }
  ui.nextBtn.hidden = !(showEpisode && hasNext);
  ui.queueLink.hidden = !(showEpisode && count > 0);
  paintControl(ui.queueLink, `Up Next (${count})`, null);
  ui.saveBtn.hidden = !(showEpisode && typeof nav.toggleSaved === "function");
  paintControl(ui.saveBtn, saved ? "Saved ✓" : "Save", saved ? "Saved — tap to unsave" : "Save this episode");
  ui.saveBtn.setAttribute("aria-pressed", saved ? "true" : "false");
  ui.saveBtn.classList.toggle("on", saved);
}

/** Previous/next are the page's (see `episodeNavigation`), read at the moment
    `setActions` installs the surface — so they are getters, not fields. */
const episodeMediaSurface = {
  play: () => setRunning(true, "remote"),
  pause: () => setRunning(false, "remote"),
  /* A remote stop is a pause — see `forayMediaSurface` above for why. */
  stop: (details) => remoteStop(details),
  get next() { return episodeNeighbour("next"); },
  get previous() { return episodeNeighbour("previous"); },
  /* THE SAME SEEK THE PAGE'S BUTTONS MAKE (audit 2026-09-22), so a car scrub
     gets the clamps, the restored-bar rule and the repaint (#689) that the
     in-page controls get — it used to carry its own copy of the first and
     none of the second. */
  seekBy: (offset) => seekEpisodeBy(offset),
  seekTo: (position) => seekEpisodeTo(position),
};

/**
 * L-06. What the native shim says about its own traffic, or `null` on the web.
 *
 * `window.ForayMediaSession` is `foray-media-session.js`'s auto-installed
 * instance — the polyfill that takes over `navigator.mediaSession` inside the
 * Capacitor shell and forwards every write to `ForayAudioPlugin`'s
 * `setNowPlaying`. `inspect()` is its own diagnostic surface (that file's
 * comment: "`sends` is the one number a device pass should read twice a minute
 * apart"), and `sends` is exactly the number that separates F15's third
 * explanation — nothing ever reached `MPNowPlayingInfoCenter` — from the two
 * that are about what we built.
 *
 * READ AT THE MOMENT OF THE WRITE, never cached: the two scripts are
 * independent module tags and neither may assume the other has run, the same
 * lazy-lookup rule `foray-media-session.js`'s own `onLoadedChange` states.
 * Total and never throws — a diagnostics read must not be able to cost the
 * page its lock screen.
 */
function mediaSessionShimState() {
  try {
    const shim = typeof window !== "undefined" ? window.ForayMediaSession : null;
    if (!shim || typeof shim.inspect !== "function") return null;
    const info = shim.inspect();
    return info && typeof info === "object" ? info : null;
  } catch (_) { return null; }
}

/**
 * Run `read` after the shim has had its turn, so a counter read from it is the
 * state AFTER this write rather than before it.
 *
 * FOUNDER FIELD RECORD, 2026-09-22: every `nowplaying` row read
 * `native=on/sent=0`, which reads as "the payload never reached
 * MPNowPlayingInfoCenter" — F15's third explanation, and the alarming one.
 * It was the instrument. `media-session.js` assigns `ms.metadata` and calls
 * this hook SYNCHRONOUSLY, in the same turn; the shim's setter only ENQUEUES
 * its coalescing flush, and the line that increments `sends` runs inside it.
 * So the hook could never see its own write, and a record made of
 * first-writes-after-boot read `0` however healthy the bridge was. Two field
 * records were spent on a number that could not have said anything else.
 *
 * ONE MICROTASK IS ENOUGH, AND IT IS ORDERING RATHER THAN A RACE. The shim
 * enqueued its flush during the assignment, which is strictly before
 * `media-session.js` called us; microtasks run FIFO, so ours cannot overtake
 * it. A second write in the same turn finds the shim's `flushQueued` already
 * set and enqueues nothing new — still ahead of this one. There is no delay to
 * tune and nothing to wait on.
 *
 * TOTAL, like the read it defers: `media-session.js` calls this inside its own
 * `attempt()` guard, and deferring would carry the callback OUT of that guard,
 * so the guard is re-made here. A diagnostics sink must not be able to cost the
 * page its lock screen.
 */
function afterShimFlush(read) {
  const run = () => { try { read(); } catch (_) { /* diagnostics are never load-bearing */ } };
  try {
    if (typeof queueMicrotask === "function") queueMicrotask(run);
    else Promise.resolve().then(run);
  } catch (_) {
    /* No microtask source at all: report early rather than not at all. The row
       is then the pre-write count, which is what it has always been. */
    run();
  }
}

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
  publishMediaView(mediaSessionView(mediaViewFields()));
}

/** The live values the OS view is built from. One function for the three
    shapes the bar can be in — a Foray, a RESTORED Foray, an episode — so no
    field is gathered twice. */
function mediaViewFields() {
  /* A RESTORED FORAY IS DESCRIBED AS A FORAY (audit round 2, player-10). The
     bar's placeholder item is shaped like an episode for convenience, and the
     lock screen took it at its word: title = the Foray, artist = "Foray · clip
     3 of 32", album blank — and then, on the first press, the proper clip /
     show / "<Foray> · clip 3 of 32" layout, the same Foray two ways five
     seconds apart. The resolved Foray is in hand (`restoredPending.foray`),
     so the view is built from it and the clip follows the thumb. */
  const pending = !foray && restoredPending?.foray?.resolved ? restoredPending.foray.resolved : null;
  const live = foray ? foray.resolved : pending;
  if (live) {
    const items = live.playable;
    const position = foray ? forayPosition() : episodePositionSec();
    const index = foray
      ? (foray.index >= 0 ? foray.index : 0)
      : (segmentAtElapsed(items, position)?.index ?? 0);
    return {
      item: items[index] ?? null,
      nextItem: items[index + 1] ?? null,
      forayTitle: live.title,
      foray: true,
      index,
      total: items.length,
      showArtworkUrl: artworkByShow.get(items[index]?.show ?? "") ?? null,
      durationSec: live.totalSec,
      positionSec: position,
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
      /* A stall stops the OS clock too (audit round 2, p-car-8): the bar says
         "Buffering…" and the car said PLAYING at full rate over silence. */
      buffering,
      /* `transportIsRunning()`, not `isPlaying()` (audit 2026-09-22). The OS
         surface is a transport like any other and must be painted from the
         answer the press is decided by: in the #689 drift the element is audible
         while the machine says paused, and the lock screen and the car said
         PAUSED over sound. `playbackState` is also what tells the OS whether to
         keep the session foregrounded, so the lie was not only cosmetic. */
      playing: transportIsRunning(),
      // The 0.5 s authored beat reads as playing, exactly as `isRunning()` has
      // it for the in-page buttons. `media-session.js` §4 is the argument.
      inSeamGap: manager?.inSeamGap === true,
      ended: Boolean(foray) && manager?.state?.type === "ended",
    };
  }

  return {
    item: current,
    forayTitle: "",
    foray: false,
    index: 0,
    total: 0,
    showArtworkUrl: current.artwork_url ?? null,
    /* THE BAR'S OWN READINGS (audit 2026-09-22, qa row 161). These read the
       element directly, which on a RESTORED bar holds nothing: the lock screen
       and the car were told 0:00 while the bar said 30:00, and a feed with no
       duration left the OS with none although the position store measured one.
       `episodePositionSec` / `episodeDurationSec` are what `render()` paints
       from, so the two surfaces cannot disagree. */
    durationSec: episodeDurationSec(),
    positionSec: episodePositionSec(),
    /* The rate the element is really running at, for the reason spelled out
       above. A BLOCK comment, deliberately: `media-session.test.js` scans this
       file with a stripper that removes `//` comments LAST, so an apostrophe in
       one reads as an unterminated string literal and swallows the code after it
       until the next apostrophe — which is exactly how "element's" here turned
       four of that suite's wiring assertions red. Block comments go first and are
       safe. */
    playbackRate: backend?.rate ?? 1,
    buffering,
    /* The same authority as the Foray branch above, for the same reason. */
    playing: transportIsRunning(),
    ended: manager?.state?.type === "ended",
  };
}

/** The last position the OS was given, as whole seconds plus duration and
    rate — see `publishMediaView`. */
let lastMediaPositionKey = null;

/** Hand the view to the bridge, the position ONCE A SECOND (audit round 2,
    perf-7). `render()` runs on every `timeupdate`, four times a second, and the
    bridge's own dedupe is to a tenth of a second, so the OS was written four
    positions a second for a playhead it extrapolates itself. Metadata and the
    transport state go through unthrottled — those are the writes that decide
    what the car shows — and a seek or a rate change is a new whole second or a
    new rate, so it lands on its own tick. */
function publishMediaView(view) {
  const p = view.positionState;
  const key = p ? `${Math.floor(p.position)}/${p.duration}/${p.playbackRate}` : null;
  if (key !== null && key === lastMediaPositionKey) {
    media.update({ metadata: view.metadata, playbackState: view.playbackState });
    return;
  }
  lastMediaPositionKey = key;
  media.update(view);
}

/* ---------- the two boundaries: going away, and coming back ----------

   Module-level rather than closures inside `bind()` (2026-09-22, founder
   report 1) because the page is no longer the only thing that can say "we are
   going away": the native shell's own background / route-change / interruption
   events arrive as `foray:session` (see `onNativeSession`), and they need the
   same flush and the same reconcile the page's `visibilitychange` gets. */

// Corner case #17: pocketing the phone must not lose the position. This is
// the path that actually matters on mobile — beforeunload is unreliable there.
function flushPositions() {
  if (!manager) return;
  /* ONE RULE, BOTH STORES (#689). This line used to read
     `if (current && isPlaying())`, and the comment below — written for the
     Foray store on the very next line — is the argument against it: an EPISODE
     paused at 23:14 and then backgrounded must still remember 23:14 for
     exactly the reason a Foray must. Pause, pocket the phone, and the episode
     row kept whatever was last written, which is the founder's *"it jumped
     back to several minutes ago in the podcast, I assume the last time the app
     was open"*.
     The condition was doing a second job by accident — "a load landed, so the
     element's clock is about this item" — and dropping it here would have
     started writing fabricated positions from a failed load. That question is
     now asked where it belongs, inside `_persistPosition`, against
     `playheadItemId` rather than against the transport. */
  if (current) manager._persistPosition();
  // Same rule, the store it was first written for: a Foray paused at 23:14 and
  // then backgrounded must still remember 23:14.
  persistForayProgress({ force: true });
  /* The durable write cannot be awaited here — `pagehide` has no way to hold
     the page open, and an IndexedDB commit is asynchronous. That is survivable
     and deliberately so: the localStorage tier is written SYNCHRONOUSLY by the
     line above, so the position is on disk before this handler returns, and the
     next `hydrate()` copies it down into IndexedDB. Kicking the queue costs
     nothing and often wins the race anyway. */
  storage.flush().catch(() => {});
}

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
async function reconcileOnReturn(why = "visible", { interruption = false } = {}) {
  if (!manager) return;
  const corrected = await manager.reconcileWithBackend(why, { interruption });
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
  diag.reconciled(why, manager?.state?.type ?? null);
  /* The playhead the route died at. The reconcile's own `savePosition` covered
     the episode row; a Foray keeps its position in its own store and on its own
     clock, so it needs saying separately — and it can be said, because the
     element still holds this segment's audio at the moment it stopped. */
  persistForayProgress({ force: true });
}

/* ---------- wiring ---------- */

function bind() {
  /* `transportIsRunning()`, not `isRunning()` (#689). A toggle derives WHAT IT
     IS ASKING FOR from the current answer, so reading the belief here puts the
     stale value back into the request the moment it is wrong: with sound coming
     out and the machine saying paused, `!isRunning()` asks for PLAY, and
     `setRunning` — correctly — sees that as already true and does nothing. The
     short-circuit and the toggle have to read the same authority or the fix in
     one is undone by the other. */
  const toggle = () => setRunning(!transportIsRunning());
  ui.playBtn.addEventListener("click", toggle);
  ui.bigPlay.addEventListener("click", toggle);

  /* U-13: the only listener that reaches `stopAndClose` from the UI. Everything
     else that used to (the mini bar's ✕) now collapses instead. */
  ui.stopBtn.addEventListener("click", () => stopAndClose());

  /* OPENING IS ALWAYS FROM THE TOP (founder report, 2026-09-13: "it should
     pop up ... starting at the top with the album artwork"). The sheet's
     scroller is a long-lived element — it is built once, at module
     evaluation, and reused for every episode — so it REMEMBERS where it was
     left. Without this line, the second open of the sheet resumes at
     whatever offset the first one ended at, and an episode with a long
     description opens on the middle of that description with the artwork
     scrolled off the top. That is the same class of defect as the router's
     leaked scroll position in app.js, in a different container.

     Written on the way OPEN rather than on the way closed, deliberately: a
     reset on close would be equally correct today and would silently stop
     being enough the day anything else can scroll this element (a resume
     restore, a "jump to the chapter you are in"). "Every open starts at the
     top" is the promise; make it where the promise is kept.

     AND IT MUST BE THE LAST LINE, AFTER THE UNHIDE. A `display: none` element
     has no scrollport: the assignment is silently dropped and the browser
     restores the old offset the moment the element is shown again. Measured
     in Chrome with this line first: open the sheet, scroll 400px down the
     description, close, reopen — `scrollTop` read back 400, which is the
     founder's exact "opens on the bottom part of the transcript", now caused
     by the fix for it. Moving the line below `hidden = false` makes it 0. */
  /* ---------- the sheet MOVES (audit round 2, touch-8) ----------

     It used to appear with a hard cut and, after a pull past the dismiss
     distance, vanish from wherever the thumb left it — `hidden` went to
     `display: none` in the same frame the offset was reset, so the one
     transition styles.css gives it (`.fp-sheet:not(.fp-sheet-dragging)`)
     never painted. Only the spring-back of a SHORT pull animated, which made
     the successful outcome the one broken motion in the sequence. Apple's
     sheet slides both ways.

     The motion itself is the owner's (`ForaySheets.slideIn` / `slideOut`):
     one implementation of "move a panel by its own custom property and say
     when it has settled", shared with every `.fy-panel`, honouring
     `prefers-reduced-motion` in one place. Here: on open the sheet is unhidden
     at its full height and released to 0; on close it is sent to its full
     height FIRST — from wherever the finger left it, so a dismiss finishes
     the slide — and only when it has settled does `setExpanded(false)` run
     for real. `sheetExitPending` swallows a second close asked for mid-slide
     (Escape pressed twice, a bar tap during the exit); the first one's
     settle hides it. A sheet the owner cannot move (no owner, a zero-height
     harness, reduced motion) closes as it always did, at once. */
  let sheetExitPending = false;
  const sheetHeightPx = () => {
    try {
      const h = typeof ui.sheet.getBoundingClientRect === "function" ? ui.sheet.getBoundingClientRect().height : 0;
      return Number.isFinite(h) && h > 0 ? h : 0;
    } catch (_) { return 0; }
  };
  const slideSheetOut = (done) => {
    if (ui.sheet.hidden) return false;
    if (sheetExitPending) return true;
    const owner = sheetOwner();
    const h = sheetHeightPx();
    if (!owner || typeof owner.slideOut !== "function" || !h) return false;
    /* The release transition applies from wherever the drag left it: the
       dragging class is what switches it off. */
    ui.sheet.classList.remove("fp-sheet-dragging");
    const started = owner.slideOut(ui.sheet, "--fp-sheet-dy", h, () => { sheetExitPending = false; done(); });
    if (started) sheetExitPending = true;
    return !!started;
  };
  const slideSheetIn = () => {
    const owner = sheetOwner();
    const h = sheetHeightPx();
    if (!owner || typeof owner.slideIn !== "function" || !h) return;
    owner.slideIn(ui.sheet, "--fp-sheet-dy", h, "fp-sheet-dragging");
  };
  /* True only inside a slide-out's settle: the close below is due NOW, not
     another slide. */
  let sheetSettled = false;
  const setExpanded = (open) => {
    if (!open && !sheetSettled && slideSheetOut(() => {
      sheetSettled = true;
      try { setExpanded(false); } finally { sheetSettled = false; }
    })) return;
    setSheetDragOffset(0);
    const owner = sheetOwner();
    /* Closing: the owner first, while the sheet is still shown — it lifts
       `inert` off the bar and hands focus back to the button that opened
       the sheet, which must not be inert when it receives focus. */
    if (!open && owner) owner.closeSheet(ui.sheet);
    ui.sheet.hidden = !open;
    document.body.classList.toggle("fp-expanded", open);
    paintInfoLabel();
    /* Opening: the page behind (and the mini bar under the sheet) goes inert
       and focus moves into the dialog. The topbar and the drawer stay
       reachable (U-12/F17 above), and so does the player's live region — it
       is a sibling of the bar, not inside it, for exactly this reason (see
       buildUI). Escape, and a navigation, collapse it through this same
       function. */
    if (open && owner) {
      owner.openSheet(ui.sheet, {
        panel: ui.sheet,
        bodyClass: "fp-expanded",
        keepReachable: [".topbar", "#drawer", "#drawer-overlay", ".fp-announce"],
        onRequestClose: () => setExpanded(false),
        returnFocus: ui.info,
      });
    }
    if (open) ui.scroll.scrollTop = 0;
    if (open) slideSheetIn();
  };
  ui.info.addEventListener("click", () => setExpanded(ui.sheet.hidden));
  /* The artwork too — the biggest thing on the bar, and where every podcast
     app opens the player from. It was an inert <img> beside the one button
     that did (audit 2026-09-22). Not a second button in the tab order: the
     title button beside it already is that control for keyboard and screen
     reader, and the art stays `alt=""` decoration to them. */
  ui.art.addEventListener("click", () => setExpanded(ui.sheet.hidden));
  /* The ✕ is the one button that collapses the sheet (the handle's drag is the
     gesture). Declared after `setExpanded` because it is a `const`. */
  ui.closeBtn.addEventListener("click", () => setExpanded(false));
  // Following the route with the sheet still open would leave the Foray page
  // rendered underneath a full-height overlay.
  ui.forayLink.addEventListener("click", () => setExpanded(false));
  // Same reasoning as forayLink above — now that "Episode" is an in-app
  // hash route too, not target="_blank", the sheet must not linger open
  // over the page it navigates to.
  ui.openLink.addEventListener("click", () => setExpanded(false));
  ui.queueLink.addEventListener("click", () => setExpanded(false));
  /* ⏭ IS THE STEERING WHEEL'S NEXT, not a second opinion: `episodeNeighbour`
     is the same wrapper `episodeMediaSurface.next` hands the lock screen. */
  ui.nextBtn.addEventListener("click", () => {
    const next = episodeNeighbour("next");
    if (next) next();
  });
  ui.saveBtn.addEventListener("click", () => {
    const id = !foray && current?.id && !current.forayId ? current.id : null;
    const nav = episodeNavigation;
    if (!id || typeof nav?.toggleSaved !== "function") return;
    try { nav.toggleSaved(id); } catch (_) { /* the page's own star failed; the paint below says so */ }
    paintEpisodeSurface();
  });

  /* ---------- drag the sheet down to dismiss it ----------

     Wyatt: "I should be able to drag that page down from the top to return to
     what I was looking at previously." The decision — how far is far enough,
     what counts as a flick, whether this gesture is even eligible — is
     `player/sheet-drag-dismiss.js`, pure and tested. Everything here is the
     three things only a real browser can supply: the events, the transform,
     and the answer to "is the scroller at its top".

     LISTENERS ARE ON THE WHOLE SHEET, not only the handle, because Apple's
     sheet comes down when you pull anywhere in a body that is already at the
     top — and because a handle alone is a 36px target on a 800px surface. The
     eligibility rule (`fromHandle || atTop`, read ONCE at pointerdown) is
     what keeps that from stealing the scroller's own gesture: a pull that
     starts halfway down a long description is a scroll, forever, no matter
     where it ends up.

     `pointer` events rather than `touch`: the same choice the strip's own
     scrub gesture makes in app.js, and the one that makes this testable with
     a mouse in a desktop browser as well as a thumb on a phone. */
  let drag = null;
  /* ONE FINGER AT A TIME (audit 2026-09-22). Without this a second finger —
     a pinch attempt, a thumb resting while the other hand drags — restarted
     the drag from ITS position, every pointermove from EITHER finger was then
     measured against that, and lifting either one committed a dismiss nobody
     made. The same guard the Foray strip's scrub gesture carries in app.js. */
  let dragPointer = null;
  ui.sheet.addEventListener("pointerdown", (e) => {
    if (ui.sheet.hidden) return;
    if (dragPointer != null) return;
    /* A press that lands on a control is that control's, never the sheet's.
       Without this, starting a scrub by pressing the range thumb and pulling
       slightly down would begin dismissing the sheet underneath it. */
    if (e.target && typeof e.target.closest === "function"
        && e.target.closest("button, a, input, select, textarea")) return;
    const fromHandle = !!(e.target && typeof e.target.closest === "function"
      && e.target.closest(".fp-grab-zone"));
    drag = startDrag(e.clientY, e.timeStamp, {
      fromHandle,
      atTop: (ui.scroll.scrollTop || 0) <= 0,
    });
    dragPointer = e.pointerId;
  });
  ui.sheet.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== dragPointer) return;
    const next = moveDrag(drag, e.clientY, e.timeStamp);
    drag = next;
    setSheetDragOffset(dragOffset(next));
  });
  /* THE SCROLLER MUST NOT GET THE PAN (audit round 2, touch-2). `touch-action:
     none` on the grab zone covers a drag that STARTED there; a pull that
     starts on the artwork or the title at scrollTop 0 — where a thumb
     actually goes — has no such rule, because the body is the scroller and
     must keep scrolling. This file used to `preventDefault()` the pointermove
     for that case, which stops nothing: per the Pointer Events spec only
     `touch-action` or a cancelled, NON-passive `touchmove` keeps the browser
     from panning, so on a phone the first ten pixels twitched, the scroller
     rubber-banded, the browser fired `pointercancel` and the sheet sprang
     back. Same pattern as the strip's own guard in app.js. The decision —
     "does the sheet own this finger" — is the module's (`claimsTouch`): an
     eligible pull moving DOWN claims every move from the first pixel, an
     upward move claims none and scrolls. */
  ui.sheet.addEventListener("touchmove", (e) => {
    if (drag && claimsTouch(drag) && e.cancelable !== false && typeof e.preventDefault === "function") e.preventDefault();
  }, { passive: false });
  const endSheetDrag = (e) => {
    if (!drag || e.pointerId !== dragPointer) return;
    const { dismiss } = endDrag(drag);
    drag = null;
    dragPointer = null;
    if (dismiss) setExpanded(false);
    else setSheetDragOffset(0);
  };
  ui.sheet.addEventListener("pointerup", endSheetDrag);
  /* A cancelled pointer (the browser took it for a system gesture, the finger
     left the screen edge) is a release that never happened — spring back
     rather than dismiss, because nobody decided anything. */
  ui.sheet.addEventListener("pointercancel", (e) => {
    if (!drag || e.pointerId !== dragPointer) return;
    drag = null;
    dragPointer = null;
    setSheetDragOffset(0);
  });

  /* ±15/30 s in EVERY mode (persona 58): these used to become previous/next
     clip inside a Foray, which is the one thing a listener's thumb does not
     expect of them. A 30 s step that leaves a short clip is fine — it lands in
     the next one, exactly as the scrubber would. Clip navigation is the
     `.fp-clips` row. */
  ui.backBtn.addEventListener("click", () => nudgeBy(-SEEK_BACK));
  ui.fwdBtn.addEventListener("click", () => nudgeBy(SEEK_FWD));
  ui.skipBtn.addEventListener("click", () => nudgeBy(-SEEK_BACK));
  ui.clipPrev.addEventListener("click", () => ForayPlayer.forayPrevious());
  ui.clipNext.addEventListener("click", () => ForayPlayer.forayNext());

  /* The clocks follow the thumb while it moves (audit round 2, player-6). */
  ui.scrub.addEventListener("pointerdown", () => { scrubByPointer = true; });
  ui.scrub.addEventListener("keydown", () => { scrubByPointer = false; });
  ui.scrub.addEventListener("blur", () => { scrubByPointer = false; });
  ui.scrub.addEventListener("input", () => paintScrubPreview());
  ui.scrub.addEventListener("change", async () => {
    /* A change with no `input` before it (some assistive paths) is still a
       step from the frozen value. */
    if (!scrubbing) rebaseHeldScrubStep();
    const frac = Number(ui.scrub.value) / 1000;
    scrubShownValue = Number(ui.scrub.value);
    scrubbing = false;
    if (foray) {
      await ForayPlayer.foraySeek(frac * foray.resolved.totalSec);
      return;
    }
    const dur = episodeDurationSec();
    if (dur) await seekEpisodeTo(frac * dur);
    else render();
  });

  ui.rateBtn.addEventListener("click", () => openRatePicker());

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { flushPositions(); return; }
    /* Nothing awaits an event handler, so the rejection needs somewhere to land
       other than the console's unhandled bucket — and a reconcile that failed
       must not be the reason the surface never repaints at all. */
    reconcileOnReturn().catch((err) => console.warn("[player] reconcile failed", err));
  });
  window.addEventListener("pagehide", flushPositions);
}

function ensureBooted() {
  if (manager) return;

  /* Read BEFORE the manager is built, so `manager.rate` is never momentarily
     wrong: `render()` can run from a media event before anything else in this
     function finishes, and a label that paints "1×" and then corrects itself is
     the flicker this whole feature is about. */
  const rate = readRate(storage);
  /* Same reasoning, for the same reason, for V-01's voice choice: read once
     here rather than inside the pure `queue-manager.js` (durable-store.js's
     own `cp_` discipline — a `localStorage` read belongs to the wiring file,
     not the pure module), and hand the manager the value it should speak
     with from the very first narration item. */
  const voice = readVoice(storage);

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
  /* The interlude jingle (queue-manager.js §13, player/interlude.js). Its own
     element, so the backend's two-element invariant is untouched; the ONE
     `cp_interlude` read lives here, beside `cp_rate`'s, for the same reason. */
  interlude = createInterludePlayer({ telemetry: onTelemetry });
  manager = new PlayerQueueManager({
    backend,
    positionStore: positions,
    strategy: SINGLE_ITEM,
    interlude,
    interludeEnabled: readInterludePref(storage),
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
    /* L-03: a synth narration item produces no `timeupdate` at all — there is
       no `<audio>` element under it — so without this hook `render()` would
       not run again until some unrelated event, and both the Now Playing
       position and the in-page clock would freeze for the whole utterance.
       Same repaint-on-a-hook shape `onSeamGapChange` already uses above, for
       the same reason: the manager knows exactly when there is nothing else
       to trigger a repaint, and the surface only needs to be told. */
    onNarrationTick: () => render(),
    /* THE THIRD HOOK OF THE SAME FAMILY (audit round 2, player-1). An ordinary
       episode's natural end produces `timeupdate`, `pause`, `ended` — in that
       order, and the reducer moves to `ended` only INSIDE the `ended` listener,
       after every media-event repaint has already run against `playing`. So the
       bar kept saying Pause with the thumb at 100%, the car kept saying PLAYING,
       and continuous playback — which `_announceEpisodeEndedIfNeeded` fires
       from `render()` — waited for an unrelated event: unlocking the phone. In a
       car with the screen off that is never. The manager now says when a state
       has settled, and this repaints from it. NEVER `render()` from the
       backend's own `ended` listener instead: the reducer moves a microtask
       after it, so that repaint would still see `playing`. */
    onStateSettled: () => render(),
    /* THE WIRE (generation-architecture.md §7 items 1-2). `_speakNarration` and
       the whole script-only-narration branch of `_loadItem` have been complete
       since #382 and were unreachable, because this argument was never passed:
       `this._tts` was null in every build, so a narration item carrying a
       `script` and no asset could only ever fail to load. `createTtsBridge`
       resolves the plugin's web half lazily — see tts-bridge.js for why the
       path differs between the shell and the website — so a page that never
       plays narration never fetches it, and a host with no plugin reports one
       unplayable item instead of taking the player down at import time. */
    tts: ttsBridge,
    telemetry: onTelemetry,
    voice,
  });

  /* No stored choice: hand the manager the session default the picker may
     already have resolved (a listener who opened the drawer before pressing
     play), then (re)resolve it from the device so the first narration item
     speaks with Samantha's best installed tier rather than #491's pick.
     Fire-and-forget by design — booting must not wait on a plugin call. */
  if (!voice) {
    if (sessionDefaultVoice) manager.setVoice(sessionDefaultVoice);
    resolveDefaultVoice();
  }

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
      /* The ordinary-episode half (persona audit #4): a media error or a refused
         play() on a single episode reaches the bar and the sheet. The Foray page
         keeps its own line above; this is for everything else. */
      if (!foray && current && /player\.error|play\.rejected/i.test(m)) {
        setPlayFailure(playFailureCopy(m));
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
    /* L-06 (founder feedback F15). Every payload that ACTUALLY reaches the
       platform, into the field record — the three strings and whether the
       Capacitor shim got it across. `media-session.js` fires this only on a
       real write, so a Foray that produced no `nowplaying` rows is the
       measurement, not a hole in it: the payload never left the page. */
    onWrite: (written) => afterShimFlush(() =>
      diag.nowPlaying({ ...written, native: mediaSessionShimState() })),
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
  /* The SECOND consumer of `waiting` (audit 2026-09-22): the listener, not only
     the record. See `setBuffering` for why `stalled` is not one of them. */
  backend.addMediaListener("waiting", () => setBuffering(true));
  for (const type of ["playing", "pause", "ended", "emptied"]) {
    backend.addMediaListener(type, () => setBuffering(false));
  }
}

/* ---------- public surface ---------- */

const ForayPlayer = {
  /** True when this item can play in-app. app.js uses it to decide whether to
      show a play button or fall back to the Apple Podcasts link (#25 note). */
  canPlay(item) {
    return Boolean(item && item.audio_url);
  },

  /** Play one episode. SINGLE_ITEM strategy: the PLAYER's queue is this one
      episode. What plays after it is the page's Up Next, not this queue —
      continuous playback is wanted (CLAUDE.md principle 1, founder ruling
      2026-09-14), and app.js drives it through `onEpisodeEnded` and
      `setEpisodeNavigation`. */
  async play(item, opts) {
    /* READ DEFENSIVELY RATHER THAN DESTRUCTURED IN THE SIGNATURE. This was
       `(item, { why = "" } = {})`, and a default parameter only fires for
       `undefined` — so `play(item, null)` THREW, taking out the only code path
       that loads audio for a restored episode (see `setRunning`'s restored
       branch, 2026-09-22). A string caller was the other shape in the tree:
       app.js's timestamp seek passed `"timestamp"`.
       This function is the single entry point to playback for every surface in
       the app, so it is worth more than a signature's worth of care.
       A STRING IS NOT A WHY LINE (audit 2026-09-22). #735 took a bare string as
       the reason, and the one string caller passed "timestamp" — a caller's tag,
       which the sheet then printed to the listener as the line under the title.
       The why line is listener copy and only `opts.why` supplies it; anything
       else is no reason at all, and the sheet falls back to the item's hook. */
    const why = typeof opts?.why === "string" ? opts.why : "";
    /* Where to begin, in the episode's own seconds — a restored bar's position,
       the scrub made on it (audit round 2, races-1). Internal: app.js never
       passes it. Omitted, the load resumes from the store as it always has. */
    const startAt = Number(opts?.startOffset);
    const startOffset = Number.isFinite(startAt) && startAt >= 0 ? startAt : null;
    if (!this.canPlay(item)) return false;
    ensureBooted();
    // BEFORE the first await, always. See `notePlayGesture` (#225).
    backend.notePlayGesture();
    // The jingle's element needs the same tap, for the same reason (§13).
    if (interlude) interlude.prime();
    /* LEAVING IS A FLUSH, BOTH STORES (audit round 2, player-3). This flushed
       the Foray row only, so an episode left for another one kept whatever its
       row last said — up to ten seconds stale while playing, and a whole scrub
       stale after pause-then-scrub, which the reducer never writes. The outgoing
       item is still `_currentItem()` here, and `setQueueFromPick` below is the
       moment it stops being; `flushPositions` is the same call pagehide makes. */
    flushPositions();
    foray = null;
    setSkipButtonMode(false);
    // A new item starting makes its own eventual "ended" reportable again —
    // without this a listener who replays the SAME episode id would never
    // see a second ended announcement.
    _endedAnnouncedFor = null;
    // Installed BEFORE the metadata is written, and it replaces the Foray's set
    // rather than adding to it: a stale `nexttrack` still pointed at a Foray
    // nobody is on is the one wiring bug this surface can hide.
    media.setActions(episodeMediaSurface);
    /* RE-ASSERT THE METADATA ON EVERY PLAY (founder, 2026-09-21).

       His field record showed `nowplaying` rows only ever after a `boot`, never
       after a `play from tap`: the restored mini bar writes the metadata at
       launch, and when the same episode is then played the dedupe in
       `media-session.js` sees an unchanged key and skips the write. The one
       moment the OS most needs telling — audio is starting now — was the one
       moment it was never told. */
    media.invalidate();
    lastMediaPositionKey = null;
    setNowPlaying(item, why);
    /* What the bar shows while the element does not yet hold this episode
       (`episodePositionSec`): the explicit start, else the same resume point
       `_loadItem` will read from the store. */
    loadingStart = {
      id: item.id,
      sec: startOffset ?? positionReader().resumeOffset(item.id, { duration: item.duration_sec ?? null }),
    };
    reaskEpisodeNeighbours();
    /* THE POINTER, written here and nowhere else (founder, 2026-09-18: "the
       podcast I was listening to should still be in the now playing ribbon").
       Here because this is the one place an ordinary episode becomes the
       current one — position is already durable per episode
       (`position-store.js`), so what was missing was only WHICH episode, and
       one writer for it means it cannot drift from `current`.

       A refused write is not a reason to refuse the play. The listener loses
       the ribbon on next launch, which is the old behaviour, not a new
       failure.

       ONLY A RECORD IS WRITTEN (audit 2026-09-22, qa row 169). `makeLastEpisode`
       answers null for an item with no id, and `writeLastEpisode(null)` means
       DELETE — so a playable item without an id (the gate above checks
       `audio_url`, not `id`) erased the pointer to the episode the listener was
       really in. Null here means "nothing worth pointing at", which leaves the
       old pointer alone; clearing it is a separate decision for callers that
       mean it. */
    const lastRec = makeLastEpisode(item);
    if (lastRec) writeLastEpisode(storage, lastRec);
    manager.setQueueFromPick(item);
    await manager.play(0, startOffset != null ? { startOffset } : undefined);
    render();
    /* THE ANSWER, NOT THE ATTEMPT (audit 2026-09-22). This returned `true`
       whatever happened, so every caller's `if (!ok)` was dead code and a 404
       counted as a start — including for Up Next's advance. A load that failed
       lands the manager in `idle` (`E.error`); anything else is a start that is
       running or on its way.
       AND THE ANSWER IS FOR THIS ITEM (audit round 2, p-impatient-2). The
       manager's state is the state of whoever owns the player NOW: tap ▶ on
       row A, then ▶ on row B half a second later, and A's load is superseded
       quietly while the manager is in B's `loadingItem` — not idle — so A's
       caller was told true, and A entered History, counted as played on its
       playlist and moved the next-up marker, for an episode that never made a
       sound. `current` moved to B in this very function, so the question is
       whether it is still this item. */
    return manager.state?.type !== "idle" && current?.id === item.id;
  },

  /**
   * Repaint the mini bar from storage, without loading any audio.
   *
   * Called by app.js at init. It is a separate entry point rather than
   * something `ensureBooted` does on its own because the player deliberately
   * does not boot until it is needed — but a ribbon that only appears after you
   * press play is exactly the thing being fixed, so the restore has to be able
   * to say "boot, paint, and stop there".
   *
   * Nothing plays. Autoplay would be both surprising and, on mobile, blocked
   * for want of a gesture; the press that follows is what starts it
   * (`restoredPending` in `setRunning`).
   *
   * Returns the restored item, or null — so a caller and a test can tell "there
   * was nothing to restore" from "it happened".
   */
  /**
   * The stored pointer as a home-rail row, or null — "Jump back in"'s episode
   * card (founder, 2026-09-18: "podcasts and playlists should be there too").
   *
   * Needs no `ensureBooted`, unlike `restoreLastEpisode`: this reads storage and
   * returns data. Home must be able to paint the card without the player having
   * been built, or the rail would depend on whether something had played this
   * session — which is the class of bug being fixed.
   */
  lastEpisodeCard() {
    const rec = readLastEpisode(storage);
    if (!rec) return null;
    const store = positionReader();
    /* THE DURATION THE PLAYER MEASURED, first (honesty-4; `knownEpisodeDurationSec`).
       `PositionStore` records `duration` beside every position, read off the
       media element itself, so it is both more available and more accurate than
       a feed's `itunes:duration` -- some feeds carry none at all, and an episode
       whose duration we never learned produced `percent: undefined` and no bar. */
    const stored = store.load(rec.id);
    const durationSec = knownEpisodeDurationSec(rec.id, rec.duration_sec);
    const offset = store.resumeOffset(rec.id, { duration: durationSec });
    if (lastEpisodeState(rec, { positionSec: offset }).state !== "resume") return null;
    /* THE BAR AND THE LABEL READ THE RAW STORED POSITION, not `offset` (audit
       2026-09-22). `offset` is where PLAY resumes, and `resumeOffset` collapses
       a finished episode to 0 for that purpose — so a card built from it showed
       an empty bar and "180 min left" on a three-hour episode the listener had
       just finished. `episodeProgress` is the one reading of a position every
       surface shares; `position_sec` stays `offset`, because that IS where the
       press will start. */
    const progress = episodeProgress({ ...rec, duration_sec: durationSec }, stored?.seconds ?? null);
    /* A FINISHED EPISODE LEAVES JUMP BACK IN (founder question 3, ruled
       2026-09-23: finished things leave the rail and say "Played" on their own
       rows and pages; audit round 2, player-8). The card said "Played, 100%"
       while the ribbon restored the same episode at 0:00 with an empty bar —
       two truths for one episode. Neither surface offers it now; a Foray's row
       is already cleared at its end, so the rail keeps one rule. */
    if (progress.state === "played") return null;
    return {
      ...rec,
      position_sec: offset,
      percent: progress.percent === null ? undefined : progress.percent,
      label: progress.label,
    };
  },

  /**
   * The Foray the listener was most recently IN, when that is more recent than
   * the last ordinary episode — or null (persona audit 2026-09-22, the car tier:
   * "a part-played Foray cannot be resumed from the mini bar").
   *
   * The durable pointer `restoreLastEpisode` reads is written only by `play()`,
   * so after a relaunch mid-Foray the bar offered an unrelated episode from days
   * earlier, and the Foray — the app's signature object, and an hour long — was
   * four taps across three screens away. The Foray's own resume row already
   * says where the listener got to and when; this compares the two `updated_at`
   * stamps and names the Foray when it wins. The page resolves it (only the page
   * holds the three documents) and hands it to `restoreForay`.
   *
   * A finished Foray's row is skipped (it is marked finished, not offered), so
   * a finished Foray never wins over the episode played after it.
   */
  lastPlayedForay() {
    const rows = forayProgress.list();
    const row = rows.find((r) => r && r.foray_id && !resumePoint(r, {})?.finished);
    if (!row) return null;
    const episodeAt = Date.parse(readLastEpisode(storage)?.updated_at || "");
    const forayAt = Date.parse(row.updated_at || "");
    if (!Number.isFinite(forayAt)) return null;
    /* STRICTLY newer. Leaving a Foray for an episode flushes the Foray's row in
       the same instant `play()` writes the episode pointer, so a tie means the
       episode was the later choice. */
    return !Number.isFinite(episodeAt) || forayAt > episodeAt ? row.foray_id : null;
  },

  /**
   * Paint the mini bar with a part-played Foray, loading nothing — the Foray
   * twin of `restoreLastEpisode`. The first press (bar, lock screen or car)
   * starts it at `startElapsedSec` through `playForay`, via `restoredPending`;
   * a scrub or ↺/↻ before that moves where it will start, the same rule the
   * restored episode bar keeps. Returns the painted row, or null.
   */
  restoreForay(resolved, { startElapsedSec = 0, discoverDoc = null } = {}) {
    if (current) return null; // something is already playing; never stomp it
    if (!resolved || !resolved.playable?.length) return null;
    ensureBooted();
    const at = segmentAtElapsed(resolved.playable, startElapsedSec);
    const total = resolved.playable.length;
    /* The same handlers as a restored episode: `play` goes through
       `setRunning`, whose restored branch starts the Foray. Installed before the
       metadata, as `restoreLastEpisode` does, so the car never shows a play
       button with nothing behind it (F5). */
    media.setActions(episodeMediaSurface);
    setNowPlaying({
      id: `foray:${resolved.id}`,
      forayId: resolved.id,
      title: resolved.title || "",
      /* The same builder the live bar uses (copy-5), so the restored bar and
         the bar after the first press say the same thing. `render()` keeps it
         following the thumb (player-10). */
      show: foraySecondLine(resolved.playable, at ? at.index : 0),
      duration_sec: resolved.totalSec,
    }, null);
    const positionSec = Number.isFinite(startElapsedSec) && startElapsedSec > 0 ? startElapsedSec : 0;
    restoredPending = { item: current, positionSec, foray: { resolved, discoverDoc } };
    render();
    return current;
  },

  /**
   * A play that threw on app.js's side of the bridge (persona audit #4). The
   * telemetry path above catches what the manager reports; this catches what it
   * could not — an exception out of `play()` itself — so a tap is never
   * swallowed. `err` is read for its name only, for the autoplay split.
   */
  reportPlayFailure(err) {
    /* A REFUSAL WITH NO ERROR DOES NOT OVERWRITE ONE THAT SAID WHY (review
       2026-09-23). app.js calls this with `null` when `play()` answered false,
       and on the iOS lost-gesture path the telemetry sink has ALREADY painted
       the specific "Press play again" line by then — `play()` returns after
       the rejection. The generic "could not load" replaced it and told the
       listener to check a connection nothing was wrong with. `setNowPlaying`
       clears the line for every new item, so what is here is this attempt. */
    if (err == null && playFailure) return;
    let name = "";
    try { name = String(err?.name ?? ""); } catch (_) { name = ""; }
    setPlayFailure(playFailureCopy(name));
  },

  /**
   * Where the listener is in one episode, for a list ROW (persona audit #78:
   * "nothing on any list tells me which episodes I already played, or how far
   * in I am"). The same `episodeProgress` reading "Jump back in" uses, over the
   * same `PositionStore` rows, through the reader that needs no booted player —
   * so a show page can mark its rows without building audio elements.
   * `durationSec` is the row's own when it has one; the stored duration (read
   * off the media element) otherwise.
   */
  episodeProgress(id, durationSec = null) {
    const stored = positionReader().load(id);
    /* MEASURED FIRST, the row's number second (audit round 2, honesty-4): this
       preferred the catalogue's duration over the one the same module calls
       more accurate two hundred lines up, so a row's "Played" / "min left" was
       computed against a number the file did not have. One rule for every
       surface: `knownEpisodeDurationSec`. */
    return episodeProgress({ duration_sec: knownEpisodeDurationSec(id, durationSec) }, stored?.seconds ?? null);
  },

  restoreLastEpisode() {
    if (current) return null; // something is already playing; never stomp it
    const rec = readLastEpisode(storage);
    if (!rec) return null;
    ensureBooted();
    /* The position comes from `PositionStore`, which has owned it since #26 —
       this module stores no positions of its own, so the bar and the home rail
       cannot disagree about where the listener got to. */
    const durationSec = knownEpisodeDurationSec(rec.id, rec.duration_sec);
    const offset = positions.resumeOffset(rec.id, { duration: durationSec });
    const verdict = lastEpisodeState(rec, { positionSec: offset });
    if (verdict.state !== "resume") return null;
    /* A FINISHED EPISODE IS NOT RESTORED (founder question 3; player-8). The
       ribbon read `resumeOffset`, which collapses a finished episode to 0, and
       painted it at 0:00 with an empty bar and the whole runtime left beside a
       Home card saying "Played". Same rule as `lastEpisodeCard`: finished things
       leave both surfaces. */
    if (episodeProgress({ ...rec, duration_sec: durationSec }, positions.load(rec.id)?.seconds ?? null).state === "played") return null;
    /* THE HANDLERS, NOT JUST THE METADATA (both audit fleets, 2026-09-22).

       `setNowPlaying` -> `render()` publishes title, artist and artwork to
       `navigator.mediaSession`, and that was ALL the restore did. `setActions`
       is called in exactly two places — `play()` and `playForay()` — so a
       session that only ever restored a ribbon published a full now-playing
       entry with NO action handlers behind it. The car and the lock screen
       showed the episode and their play button did nothing.

       That is founder report F5 word for word, quoted eighteen lines from here:
       "pressed play on the car's controls, nothing happened". I reintroduced it
       on 2026-09-18 by adding a path that makes something current without
       playing it — a state that did not exist when `setActions` was placed.

       `episodeMediaSurface` is the right set: a restored bar is always a single
       episode (a Foray restores through its own resume path), and its `play`
       goes through `setRunning`, which is where `restoredPending` turns the
       first press into a real load-and-seek. */
    media.setActions(episodeMediaSurface);
    setNowPlaying(rec, null);
    reaskEpisodeNeighbours();
    restoredPending = { item: rec, positionSec: verdict.positionSec };
    render();
    return rec;
  },

  isPlaying(id) {
    return isPlaying() && current?.id === id;
  },

  /**
   * Tell the lock screen and the car what "next" and "previous" mean for the
   * ordinary episode on the bar — `{ next, previous }`, either may be absent,
   * or null for neither. The page owns Up Next, so the page calls this whenever
   * the answer changes (a play, an edit to the list); the handlers are
   * re-installed at once when an episode is current, so the OS never shows a
   * skip the list cannot honour or greys out one it can.
   */
  setEpisodeNavigation(nav) {
    episodeNavigation = nav && typeof nav === "object" ? nav : null;
    if (media && current && !foray) media.setActions(episodeMediaSurface);
    paintEpisodeSurface();
    return true;
  },

  /**
   * Does "previous" mean RESTART right now? `episodePreviousRestarts`'
   * answer (transport-policy.js): past the restart window — the same window
   * `forayPrevious` measures a clip against — and for a restored bar (whose
   * position is the stored one). The page's `EPISODE_NAVIGATION.previous`
   * asks this so an ordinary episode's ◀◀ has the meaning every podcast
   * player gives it (audit round 2, p-car-5) without a second copy of the
   * window. Null when no episode is current.
   */
  previousMeansRestart() {
    if (!current || foray) return null;
    return episodePreviousRestarts({ positionSec: episodePositionSec() });
  },

  /**
   * Is this episode the one the bar is showing — playing OR paused?
   *
   * `isPlaying(id)` cannot answer that, and the difference is a founder bug.
   * FOUNDER, 2026-09-22: "the pause button on jump back in does not work."
   * `syncCardButtons` repaints every `[data-play]` matching `current.id` as
   * "❚❚", so a card button BECOMES a pause button — while `bindPlay`'s handler
   * called `play()` unconditionally and restarted the episode instead. The
   * mirror case is as bad and was next: pause from the bar, press the card's
   * "▶", and `play()` rebuilds the queue and starts from zero rather than
   * resuming where the listener was.
   *
   * Both are the same missing question — "is this already the current item" —
   * which is why this is one predicate and not two.
   */
  isCurrent(id) {
    return Boolean(id) && current?.id === id;
  },

  /** The id of the ORDINARY episode on the bar, or null — null during a Foray,
      whose next/previous are segments and never the page's. What app.js's
      `setEpisodeNavigation` getters ask "next after what?". */
  currentEpisodeId() {
    /* A restored Foray's bar is `foray:<id>` with no `foray` yet: not an episode. */
    return !foray && current?.id && !current.forayId ? current.id : null;
  },

  /**
   * Toggle whatever the bar is showing, from a surface that is not the bar.
   *
   * The same call the ribbon's own button makes, exposed so a card does not
   * have to reimplement it — and deliberately NOT parameterised by id: a card
   * that is the current item toggles the player, and a card that is not should
   * be calling `play()`. `isCurrent` is how a caller tells those apart.
   */
  async togglePlayback() {
    await setRunning(!transportIsRunning());
  },

  /**
   * Move the clock of the ORDINARY episode that is playing (founder,
   * 2026-09-17: a timestamp in an episode description "then results in jumping
   * to that timestamp in 4a"). Seconds from the start of the episode.
   *
   * This is `episodeMediaSurface.seekTo` made reachable from the page. That
   * surface exists for the lock screen and the car; the same move from a tap in
   * the description had no public path at all, and app.js cannot reach
   * `manager` — the whole point of this module's boundary.
   *
   * REFUSES ON A FORAY, deliberately, rather than doing something plausible. A
   * Foray's clock is the Foray's, not any one episode's: `foraySeek` takes a
   * position on the assembled tape, and handing it a timestamp read off one
   * source episode's description would seek to a confidently wrong place.
   * Returns false so a caller can tell "did not happen" from "happened".
   *
   * `render()` afterwards for the reason #689 gives on the two surfaces below:
   * a seek that moves the audio and leaves the page painting the old position
   * is the bug that fix exists to prevent.
   */
  async seekTo(position) {
    if (foray) return false;
    return seekEpisodeTo(position);
  },

  /** Subscribe to "an ordinary (non-Foray) episode just finished playing".
      Returns an unsubscribe function. Fires at most once per finished
      episode — see `_announceEpisodeEndedIfNeeded`'s header. Never fires for
      a Foray: that has its own internal segment-advance machinery and this
      must not layer a second opinion on top of it (docs/listening-queue-plan.md
      §4 addendum). */
  onEpisodeEnded(fn) {
    if (typeof fn !== "function") return () => {};
    _episodeEndedListeners.add(fn);
    return () => _episodeEndedListeners.delete(fn);
  },

  /* ---------- Forays (#128) ---------- */

  /** The three-document join, re-exported so app.js resolves the running order
      with exactly the code that builds the queue. app.js is a classic script and
      cannot import an ES module, which is the whole reason this bridge exists. */
  resolve(foraysDoc, { id, segmentsDoc, sourcesDoc, unlocked = [], showDrafts = false } = {}) {
    const doc = findForay(foraysDoc, id, { unlocked, showDrafts });
    if (!doc) return null;
    return resolveForay(doc, {
      segments: indexSegments(segmentsDoc),
      sources: indexSources(sourcesDoc),
    });
  },

  /** Which Forays may be listed for this visitor (drafts only when named, or
      when app.js says the founder's test-track switch is on — `showDrafts`
      is an OPTION here because player/ is pure and never reads a `cp_` key). */
  listForays(foraysDoc, { unlocked = [], showDrafts = false } = {}) {
    return listableForays(foraysDoc, { unlocked, showDrafts });
  },

  /** The reverse of `resolve`: which Forays draw on a given show (show page,
      requirements B3/Q6). See foray-resolve.js's foraysReferencingShow for
      why this must live here rather than in app.js. */
  foraysUsingShow(foraysDoc, showNames, { segmentsDoc, sourcesDoc, unlocked = [], showDrafts = false } = {}) {
    return foraysReferencingShow(foraysDoc, showNames, {
      segments: indexSegments(segmentsDoc),
      sources: indexSources(sourcesDoc),
      unlocked,
      showDrafts,
    });
  },

  fmtClock,
  fmtSpan,

  /** The narrator's one name (p-foray-12) — see `segment-strip.js`. */
  narratorName: NARRATOR_NAME,

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
  /** The header's counts, from the strip's own model — see `stripTally`. */
  stripTally,

  /* U-04: the string half of the strip, for callers that build markup as
     template strings interpolated into `innerHTML` — Home's Foray cards
     (U-03) and the show/episode restyle (U-08) — rather than as live DOM.
     Bridged for the same reason `stripInto` is: `app.js` is a classic script
     and cannot `import` from `player/`. `applyStripGrow` is the CSSOM pass a
     caller must run once the string is in the document, since the CSP blocks
     the width from being written as a style attribute in the string itself
     (see `segment-strip.js`'s header on `segmentStripHtml`). */
  segmentStripHtml,
  applyStripGrow,

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
    /* Where a finger in zoomed space sits on the un-zoomed strip — the one
       piece of arithmetic the release commit needs (touch-1). */
    unzoomedX: unzoomedStripX,
  },

  /* ---------- drag-to-dismiss, for the sheets app.js owns (touch-4) ----------
     Every `.fy-panel` paints the same grab handle the Now Playing sheet does
     and, until round 2, only Now Playing answered a drag — eight false
     affordances. The owner (`openSheet`) now binds the gesture to each panel
     it opens, reading the decision from this same pure module, so a fifth
     sheet cannot drag by a different rule. Bridged for the reason everything
     else here is: app.js is a classic script and cannot import it. */
  sheetDrag: {
    start: startDrag,
    move: moveDrag,
    end: endDrag,
    offset: dragOffset,
    claimsTouch,
  },

  /* ---------- the seek nudge (persona 58) ----------
     The Foray page's ↺ / ↻ pair calls this; it is the same `nudgeBy` the
     sheet, the mini bar and the lock screen use, so a step means the same
     thing on every surface. `nudgeSteps` is where the page reads the two
     numbers for its labels, so no surface can name a different step. */
  nudge(offsetSec) { return nudgeBy(offsetSec); },
  nudgeSteps() { return { back: SEEK_BACK, fwd: SEEK_FWD }; },

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
   * Advance to the next speed and return it. Kept for a caller that wants a
   * cycle; NO SHIPPED CONTROL CYCLES ANY MORE (#349 — both speed buttons open
   * the picker, `openRatePicker` here and `openRateMenu` in app.js).
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

  /** Set a specific speed, snapped onto the ladder. What the picker's stops
      call, and what a settings row or a console would. */
  setPlaybackRate(rate) {
    return applyRate(rate);
  },

  /**
   * §13's jingle, on or off, for the drawer switch app.js now carries
   * (finding 5, client audit 2026-09-12: `docs/legal/privacy-policy.md` has
   * disclosed `cp_interlude` as "On unless you turn it off" since FD-06, and
   * `setInterludeEnabled` was called from its own test and nowhere else).
   *
   * SHAPED EXACTLY LIKE `applyRate`, and for the same two reasons: persist,
   * then tell a manager that may already be running. `cp_interlude` is the one
   * `cp_` key `player/` owns rather than the page (`readInterludePref` above
   * is read at boot, beside `cp_rate`'s), so the WRITE belongs beside the read
   * — in `player/interlude.js`, which is the only file that knows the value is
   * the literal word `"off"` and not JSON. app.js calls through here rather
   * than spelling that itself.
   *
   * WORKS WITH NOTHING BOOTED. Setting it before pressing play is ordinary, so
   * with no manager this writes the value and stops; `ensureBooted` reads the
   * key back at the next play. app.js keeps its own raw-string fallback for
   * the case this module never loaded at all — the same posture
   * `storageBackend()` takes towards `window.forayStorage`.
   */
  setInterludeEnabled(on) {
    const v = on !== false;
    writeInterludePref(storage, v);
    if (manager) manager.setInterludeEnabled(v);
    return v;
  },

  /* ---------- V-01: the narration voice picker ---------- */

  /** What `tts.listVoices()` reports for this device — installed voices,
      best-first, plus a default identifier. Re-exported so app.js's
      `renderVoiceSettings` never imports `foray-tts.js` directly (it is a
      classic script; see this file's own header) and never resolves the
      plugin a second time — the SAME lazily-loaded module `_speakNarration`
      uses, through the SAME `createTtsBridge()` instance this file already
      built for the manager. */
  listVoices(opts = {}) {
    /* Every list refresh is also the moment the session default is
       (re)resolved — see `adoptDefaultVoice`. The page passes
       `VOICE_LIST_LANG` itself; an older caller's `en-US` still answers,
       just without the other English locales. */
    return ttsBridge.listVoices(opts).then((out) => {
      adoptDefaultVoice((out && out.voices) || []);
      return out;
    });
  },

  /** The voice in force: the stored choice, else the session default
      (Samantha's best installed tier, once a `listVoices()` result has been
      seen), else `null` for "the plugin picks". Readable before anything has
      booted, same as `playbackRate()`. */
  currentVoice() {
    if (manager) return manager.voice;
    return readVoice(storage) || sessionDefaultVoice;
  },

  /** The default rule itself, re-exported so `app.js` paints the same row
      selected that narration would speak with, from the same `listVoices()`
      result, without a second copy of the rule in a classic script. */
  defaultVoice(voices) {
    return pickDefaultVoice(voices);
  },

  /** Apply and persist a voice choice (V-01's `cp_voice`). */
  setNarrationVoice(id) {
    return applyVoice(id);
  },

  /** Did the most recently spoken narration item fall back from the chosen
      voice to the plugin's own best-installed pick? `null` before anything
      has spoken, or with nothing booted at all — a page reads this after an
      `onChange`/Foray-status tick, never on its own poll. */
  lastVoiceFallback() {
    return manager ? manager.lastVoiceFallback : null;
  },

  /**
   * Speak the fixed audition line through a SPECIFIC voice, at
   * `NARRATION_RATE` — the 1x every synthesized narration line is spoken at
   * since the founder's 2026-09-24 ruling (*"1x for now, but maybe we change
   * later"*). It used to speak at the listener's CURRENT playback speed, as
   * V-01's stopwatch test for H3 (#490's rate curve); once narration stopped
   * following that speed, a Preview at 2x would have been a sample of a pace
   * the narrator never uses, so a preview now sounds like what it previews.
   * Deliberately independent of `manager`/a live Foray: auditioning a
   * voice from the picker must work whether or not anything is playing, and
   * must never touch the queue (an audition mid-Foray is not "the next
   * narration item" — it is a one-off the listener asked for by name).
   *
   * Goes straight to the shared `ttsBridge`, not through `_speakNarration` —
   * that method reads `this._voice` off the LIVE manager, which is exactly
   * the wrong source here: the picker is choosing a DIFFERENT voice than
   * whatever is currently selected, possibly before any manager exists at
   * all. The speed is the same constant `_speakNarration` passes.
   *
   * @param {string} text  the fixed line the caller supplies (app.js owns the
   *   copy; this file has no business authoring narration text)
   * @param {string} voiceId
   * @returns {Promise<object>} the bridge's own `speak()` result — `ok`,
   *   `voiceFallback`, etc. — unchanged, so the caller can show V-01's notice.
   */
  auditionVoice(text, voiceId) {
    return ttsBridge.speak(text, { rate: NARRATION_RATE, voice: voiceId });
  },

  /* ---------- K-01: the bundled-voice measurement ----------

     `docs/bundled-voice-plan.md` K-01. Runs the probe passage through the
     `kokoro-probe` engine, writes the numbers into the SAME field record the
     founder already knows how to copy out, and returns the record so the
     drawer can show it immediately.

     THROUGH THE SHARED `ttsBridge`, exactly like `auditionVoice` and for the
     same reason: resolving `foray-tts.js` a second time would give the probe a
     different module instance from the one narration speaks through, and
     "which build of the plugin answered?" is one of the questions the probe
     exists to settle.

     NOTHING ABOUT NARRATION IS TOUCHED. No manager, no queue, no `this._voice`
     — a measurement that could change what the next narration item sounds like
     would not be a measurement. */
  async runVoiceProbe() {
    const passage = await loadProbePassage();
    const record = await runKokoroProbe({ tts: ttsBridge, passage, now: () => Date.now() });
    /* Recorded WHETHER OR NOT it succeeded. "This build has no model in it" is
       the single most useful thing the first run can tell us, and a record
       that only kept successes would answer every failed run with silence. */
    try { diag.voiceProbe(record); } catch (_) { /* the instrument must never be the outage */ }
    return record;
  },

  /** The probe record as the several lines the drawer shows, plus K-01's
      go/no-go verdict applied to it. Re-exported for the same reason
      `defaultVoice` is: `app.js` is a classic script and must not carry a
      second copy of a rule the record is judged by. `age` is `"newest"` or
      `"oldest"` — which phone this is, which the founder says, because the
      card's ceiling differs between them. */
  formatVoiceProbe(record, age = "oldest") {
    return { text: formatProbeReport(record), verdict: probeVerdict(record, age) };
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
    // The jingle's element needs the same tap, for the same reason (§13).
    if (interlude) interlude.prime();
    /* `onChange ?? forayWatcher`: a Foray started from somewhere that is not
       its page (the restored mini bar, the lock screen) still reaches the page
       that asked to watch — see `watchForay`. */
    foray = { resolved, index: -1, pendingFrom: null, onChange: onChange ?? forayWatcher, error: null };
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
    const offsetAt = at ? sourceOffsetFor(report.items[foray.index], at.into) : null;
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
      /* THE OFFSET RIDES ON THE LOAD (audit round 2, races-1). This was
         `play()` then `seek(offsetAt)`, and a Next clip, a row tap or the lock
         screen inside the load window let the seek land on the NEW clip — at
         the old clip's absolute second, past its out-point, which disarmed the
         boundary and free-played a stranger's episode. `_loadItem` spends the
         offset with the load it was armed for; a superseded load takes it with
         it. */
      await manager.play(foray.index, offsetAt != null ? { startOffset: offsetAt } : undefined);
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
  forayResume(forayId, { totalSec = null, itemCount = null, resolved = null, present = true, includeFinished = false } = {}) {
    const record = forayProgress.get(forayId);
    const segments = resolved ? progressSegments(resolved) : null;
    const total = isFiniteNum(totalSec) ? totalSec : (resolved ? resolved.totalSec : null);
    const count = Number.isInteger(itemCount) ? itemCount : (resolved ? resolved.playable.length : null);
    const maxIndex = Number.isInteger(count) && count > 0 ? count - 1 : null;
    /* `present: false` is FD-05's "the Foray itself is gone from the directory":
       the point degrades to `dropped` with no row painted, never a throw. */
    const point = resumePoint(record, { totalSec: total, maxIndex, segments, present });
    /* A finished Foray is not a place to resume to — the ribbon restore and the
       main button must never start one at its last second — so it is null here
       unless the caller asks for it by name: the Foray page does, to say
       "Played" with a "Play again" beside it (honesty-2). */
    if (!point || (point.finished && !includeFinished)) return null;
    return {
      ...point,
      title: record.title || "",
      clock: fmtClock(point.elapsedSec),
      label: progressLabel(point, { estimated: resolved?.estimated === true }),
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
      position is not permission to list an unpublished Foray.

      `foraysDoc` is FD-05's half: with the live `data/forays.json` in hand, a row
      whose Foray is no longer in the directory reads `drift: "dropped"` rather
      than being offered as a place to jump back to. Without it every row reads
      `unverified`, exactly as before.

      `resolveFor(id)` is the LIVE running order (audit 2026-09-22, qa row 163):
      the page's resolver, handed in because only the page holds the segment
      documents. With it a row's percent and "min left" are measured against the
      Foray as it exists now — the same `totalSec` / `maxIndex` / `segments`
      triple `forayResume` passes — rather than against the runtime stored when
      the row was written, which a regenerated Foray no longer has. A resolver
      that answers null or throws leaves that row on its stored reading. */
  forayResumeList({ foraysDoc = null, resolveFor = null } = {}) {
    /* `allForays`, not `listableForays`: presence is about the DIRECTORY, and the
       draft rule is the caller's (app.js filters by what it may list). */
    const live = foraysDoc ? new Set(allForays(foraysDoc).map((f) => f.id)) : null;
    return forayProgress.list().map((r) => {
      const present = live ? live.has(r.foray_id) : true;
      let resolved = null;
      if (present && typeof resolveFor === "function") {
        try { resolved = resolveFor(r.foray_id) || null; } catch (_) { resolved = null; }
      }
      const liveTotal = resolved && isFiniteNum(resolved.totalSec) && resolved.totalSec > 0 ? resolved.totalSec : null;
      const liveCount = resolved && Array.isArray(resolved.playable) ? resolved.playable.length : null;
      const point = resumePoint(r, {
        present,
        totalSec: liveTotal,
        maxIndex: Number.isInteger(liveCount) && liveCount > 0 ? liveCount - 1 : null,
        segments: resolved ? progressSegments(resolved) : null,
      });
      const totalSec = liveTotal ?? r.total_sec;
      return {
        id: r.foray_id,
        title: r.title || "",
        updated_at: r.updated_at,
        elapsedSec: point ? point.elapsedSec : r.elapsed_sec,
        totalSec,
        index: point && point.index >= 0 ? point.index : r.index,
        percent: point ? point.percent : percentDone(r.elapsed_sec, totalSec),
        finished: Boolean(point?.finished),
        /* "Played" for a finished row, "about N min left" for an estimated
           runtime (honesty-2, states-11). Whether a finished row is SHOWN is
           each caller's rule: Jump back in leaves it out, Library and the
           Forays list say "Played". */
        estimated: resolved?.estimated === true,
        label: progressLabel(point, { estimated: resolved?.estimated === true }),
        drift: present ? (point?.drift ?? DRIFT_UNVERIFIED) : DRIFT_DROPPED,
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
      Apple search to the show's real page. `collectionIds` (show -> id, from
      the page's show index, p-foray-2) does the same for a show discover.json
      does not carry; discover's own id wins where both know the show. */
  forayCredits(resolved, { discoverDoc = null, collectionIds = null } = {}) {
    const ids = new Map(Object.entries(collectionIds && typeof collectionIds === "object" ? collectionIds : {}));
    for (const [show, id] of collectionIdsByShow(discoverDoc)) ids.set(show, id);
    const credits = forayCredits(resolved, { collectionIds: ids });
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

  /** Re-point the change callback at a freshly rendered page.

      REMEMBERED EVEN WITH NOTHING LIVE (review 2026-09-23). A Foray page opened
      over a RESTORED bar renders while `foray` is null, so this attached
      nothing; the bar's press then started the Foray with no `onChange`, and the
      page sat on "Resume" while the audio played — and its button restarted the
      Foray from the render-time resume point instead of pausing. The page's
      paint already ignores a Foray that is not its own (`paintForay`'s id
      gate), so handing it any Foray that starts is safe. */
  watchForay(onChange) {
    forayWatcher = typeof onChange === "function" ? onChange : null;
    if (foray) foray.onChange = onChange;
    return this.forayStatus();
  },

  /** Play/pause the Foray without rebuilding it. One code path with the mini
      bar and the lock screen, including the forced position write. */
  async forayToggle() {
    if (!foray) return;
    /* The same authority the mini bar's toggle reads, for the same reason
       (#689). A block comment, not a line one, because `media-session.test.js`'s
       `codeOnly` strips line comments LAST and an apostrophe in one opens a
       string that swallows the next two hundred lines of this file. */
    await setRunning(!transportIsRunning());
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
    /* `render()` disables "››" on the last segment (audit 2026-09-22), so this
       early return is the backstop for the lock screen's `nexttrack` rather
       than the button's only behaviour. */
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
    /* Measured on the Foray's clock, not the element's (audit round 2,
       player-4): `previousAction` says why. `forayPlayhead` knows which clock
       each kind of item runs on; the clip's start on that clock is
       `segmentStarts`. */
    const choice = previousAction({
      index,
      positionSec: forayPlayhead(),
      segmentStartSec: segmentStarts(foray.resolved.playable)[index],
    });
    if (choice === PREVIOUS.ITEM_BEFORE) {
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
    /* Where it lands and whether it reloads are `scrubTarget`'s: a FINISHED
       Foray has nothing loaded to seek in, so a scrub back into the last
       segment reloads it like any other segment (audit 2026-09-22). */
    const scrub = scrubTarget({
      at, item: at ? foray.resolved.playable[at.index] : null,
      currentIndex: manager.currentIndex, stateType: manager.state?.type ?? null,
    });
    if (!scrub) return;
    if (scrub.reload) {
      foray.error = null;
      setForayIndex(scrub.index);
      /* The offset rides on the load (races-1) — see `playForay`. */
      await manager.play(scrub.index, scrub.offset != null ? { startOffset: scrub.offset } : undefined);
    } else if (scrub.offset != null) {
      await manager.seek(scrub.offset, { precise: true });
    }
    render();
  },
};

/* RESTART_WINDOW_SEC, SEEK_INSIDE_END_SEC and `sourceOffsetFor` moved to
   transport-policy.js (NE-08), exported, so the native engine's generated
   constants and its TransportPolicy port read the same numbers. */

const isFiniteNum = (n) => typeof n === "number" && Number.isFinite(n);

function clampIndex(index, length) {
  const n = Number.isInteger(index) ? index : 0;
  return Math.min(Math.max(0, n), Math.max(0, length - 1));
}

/** Inside a Foray the sheet shows its previous/next-clip row; the ±15/30 s
    pair keeps its glyphs and its names in both modes (persona 58 — they used
    to be repainted as ‹‹ / ›› here). "Clip" is the listener's word for a
    Foray's pieces (docs/audit/persona-synthesis.md §2); "segment" is the
    pipeline's. */
function setSkipButtonMode(isForay) {
  if (!ui) return;
  ui.clips.hidden = !isForay;
  paintControl(ui.backBtn, `↺ ${SEEK_BACK}`, `Back ${SEEK_BACK} seconds`);
  paintControl(ui.fwdBtn, `${SEEK_FWD} ↻`, `Forward ${SEEK_FWD} seconds`);
}

window.ForayPlayer = ForayPlayer;
/* app.js is a classic script and this is a deferred module, so app.js cannot
   assume the bridge exists when it renders. One event, once, rather than a
   poll. */
window.dispatchEvent(new Event("forayplayer:ready"));

export default ForayPlayer;
