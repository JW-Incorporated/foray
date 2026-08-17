/* PHASE C — does the SEAM TRANSITION survive backgrounding? (#28's iOS half.)
 *
 * ── WHAT PHASE B SETTLED, AND WHAT IT DID NOT ────────────────────────────────
 *
 * Run 32026332637 measured the out-point while the app was genuinely backgrounded:
 * stopped at 45.469 s against `end_sec` 45.460 s — **4.5 ms late** — over a
 * **15.056 s** hidden window with 61 hidden `timeupdate` samples at a 252 ms
 * median, and `resumedAtWall: null`, meaning the app was never brought back. MP1
 * §8's load-bearing inference HELD.
 *
 * That is one half of a Foray. The other half is the TRANSITION, and Foray #1 has
 * 31 of them. Each is:
 *
 *     stop at end_sec  ->  wait a 2.0 s beat (player/seam-gap.js, a setTimeout)
 *                      ->  load a DIFFERENT episode  ->  seek to its start_sec
 *                      ->  play
 *
 * None of that is the mechanism phase B measured, and one number from phase B is
 * the reason to doubt it: the same page measured hidden-page DOM timers aligned to
 * a **median of 1000 ms** (`timerIntervalsMs`: 253, 925, 1000, 1000, 1001, 998, …).
 * `timeupdate` kept its 252 ms rate — that is a media event — but the beat is a
 * `setTimeout`, and `setTimeout` is exactly what was measured at 1 s alignment.
 * The load is worse: a fresh media fetch, with `LOAD_SETTLE_TIMEOUT_MS` at 10 s
 * visible and 20 s hidden (raised 2026-08-17 because a hidden load measures 5-11 s),
 * inside a page that has been SILENT since the boundary and may therefore have
 * lost WebKit's audibility assertion (`audibleActivityClearDelay` — measured at
 * 5 s in run 32036295743, not the 10 s once assumed).
 *
 * If that chain breaks, a listener with a locked screen hears two minutes of Foray
 * and then silence for the rest of the commute. No amount of out-point accuracy
 * fixes it, and nothing in this repo has measured it.
 *
 * ── SO THIS DRIVES THE WHOLE REAL CHAIN, NOT A PIECE OF IT ───────────────────
 *
 * `PlayerQueueManager` over `HtmlAudioBackend`, with the REAL scheduler (the
 * manager's `REAL_SCHEDULER`, i.e. `setTimeout`), the real reducer, the real
 * `seamGapSec` decision and the real cross-file `load()`. Three bounded segments
 * over THREE audio files, so every transition is a genuine fresh load rather than
 * `html-audio-backend.js`'s same-source seek shortcut.
 *
 * The manager is given the queue with `loadQueue`, bypassing the Foray builder,
 * because the builder needs `data/segments.json` and a resolvable draft and none of
 * that is under test here. Everything downstream of the queue — which is all of
 * the seam — is the shipped code.
 *
 * ── THE ONE THING THIS PROBE OVERRIDES, AND WHY ──────────────────────────────
 *
 * The first segment's boundary is re-armed at `currentTime + ARM_AFTER_HIDDEN_SEC`
 * on the first `visibilitychange` to hidden, exactly as `probe-outpoint.js` does.
 * That lesson was expensive: `xcrun simctl launch com.apple.Preferences` returns as
 * soon as the launch is ACCEPTED, and Settings took ~39 s to actually reach the
 * foreground on one run. A fixed `end_sec` therefore raced the harness and produced
 * two different verdicts from identical code, neither of them a measurement. Arming
 * relative to going hidden removes the race instead of tightening it.
 *
 * The override goes through `backend.setOutPoint`, which is the manager's own
 * effect path for the same thing, so nothing in the state machine is bypassed —
 * when the boundary lands, `onItemEnded` reaches the manager exactly as it would in
 * production and the manager arms the beat itself.
 *
 * Segments B and C keep AUTHORED bounds (`end_sec` 27 and 32), because by then the
 * page is hidden and the whole point is that the shipped path runs untouched.
 *
 * ── WHAT WOULD MAKE THIS A LIE, AND WHAT STOPS IT ────────────────────────────
 *
 *   - A transition completing because the app came BACK. `resumedAtWall` is
 *     recorded and `seamTransitionVerdict` refuses any transition that finished at
 *     or after it.
 *   - A transition that never happened being read as "nothing was measured".
 *     Every stage of every pending transition is stamped and saved as it happens,
 *     so a stall leaves a record saying HOW FAR it got — `lastStage` is the
 *     difference between "the beat's timer never fired" and "the load never
 *     settled", which are different bugs with different fixes.
 *   - One lucky transition standing for the mechanism. Three segments means two
 *     transitions, and the verdict requires two: the second one happens after the
 *     page has been silent through a beat, which is when the audibility assertion
 *     would have lapsed if it is going to.
 *
 * ── THE CEILING THAT BOUNDS EVERY NUMBER THIS PROBE CAN PRODUCE ──────────────
 *
 * Every run of this probe produces a record that STOPS 25-28 s after the app went
 * hidden, with most of the window unused. **Run 32077857553 settled why**, by arming
 * the first boundary at 60 s instead of 15 s so the probe's own audio never stopped:
 * the record still ended at +24.6 s and the log still shows
 * `didChangeThrottleState(Suspended)` at **+26.3 s**, with the media clock reading
 * `isPlaying = true` 1.3 s earlier and the record's own trail showing audio at
 * **0.99992x wall clock** across the whole window. So it is a CEILING ON HIDDEN TIME,
 * not a consequence of this probe's silences — see `ARM_AFTER_HIDDEN_SEC`.
 *
 * WHAT THAT MEANS FOR THIS FILE'S OWN CLAIMS, and it is a real limit rather than a
 * caveat: at the measured 9.2 s beat the SECOND transition needs ~39 s of hidden time,
 * and the app is not alive at 39 s. **`MIN_HIDDEN_TRANSITIONS = 2` is therefore
 * unsatisfiable on this instrument**, and `too-few-transitions` on every run to date is
 * a statement about the Simulator's ~26 s budget, not about the seam. One hidden
 * transition is all this rig can ever obtain; the second one needs a device
 * (`HUMAN-ACTIONS.md` #11) or a faster beat.
 */

import { PlayerQueueManager } from "./player/queue-manager.js";
import { HtmlAudioBackend } from "./player/html-audio-backend.js";
import { SEAM_GAP_SEC } from "./player/seam-gap.js";

/* THREE files, so BOTH transitions load audio the element has never held. Two would
   force an A, B, A queue whose second load WebKit may satisfy from its media cache —
   and the second transition is the one that matters most, because it happens after
   the page has been silent through a beat and the audibility assertion may have
   lapsed. Putting the easier load on the harder question is the sort of thing that
   makes a green result mean less than it appears to. */
const TONE_A = "probe-tone.wav";
const TONE_B = "probe-tone-b.wav";
const TONE_C = "probe-tone-c.wav";

/** How far past the moment of going hidden the FIRST boundary is armed.
 *
 * ── 60 s, AND THE NUMBER IS THE EXPERIMENT ───────────────────────────────────
 *
 * It was 15 s, matching `probe-outpoint.js`, for as long as the only question was
 * whether ONE boundary survives backgrounding. It is 60 s now because of the
 * question that replaced it, and raising it is the whole measurement rather than a
 * tuning change. Do not lower it back without reading this.
 *
 * THE OBSERVATION. In all three seam runs so far (32036295743, 32057395270,
 * 32064639785) the durable record simply STOPS 25.2 s, 26.8 s and 27.9 s after the
 * app went hidden, and `simulator-log-seam.txt` shows a real WebKit process
 * suspension at that moment. `docs/research/mp1-background-audio.md` §4.1b reads
 * that as a CEILING — "the page is suspended ~26 s in" — which, if it is one and it
 * reproduces on a phone, means a Foray stops advancing half a minute after the
 * screen locks and every seam refinement above is moot.
 *
 * THE CONFOUND, which is why 15 s could never settle it. With the boundary at 15 s
 * the probe's own audio STOPS at 15 s — that is what a boundary is — and WebKit then
 * starts two timers (measured, run 32036295743, and again in 32064639785's log): a
 * 5 s audible-activity clear and a ~10 s foreground-assertion release. 15 s of
 * playback plus a ~12 s assertion release lands at ~27 s, which is the same number
 * the record stops at, to the second. So "the platform suspends a hidden WebView
 * ~28 s in whatever it is doing" and "the platform suspends a hidden WebView ~12 s
 * after ITS AUDIO STOPS" both predict every run we have, and the two have opposite
 * consequences for the product.
 *
 * WHAT 60 s DOES. It moves the probe's first silence from 15 s of hidden time to
 * 60 s, and changes nothing else. The two readings now predict visibly different
 * records:
 *
 *   - a WALL-CLOCK ceiling  -> the record still stops at ~26-28 s of hidden time,
 *     while `seg-a` is audibly PLAYING and 30+ s short of its boundary. Nothing
 *     about our audio can explain it. That is the fatal answer, and the next step is
 *     HUMAN-ACTIONS.md #11 on real hardware rather than any further CI work.
 *   - a SILENCE-DRIVEN release -> the record runs to ~60 s, the boundary fires on
 *     time, and the suspension (if any) arrives ~10-12 s after the beat's silence
 *     starts. The ~28 s figure was then an artifact of this probe's own 15 s arm and
 *     the three prior runs measured the arm, not the platform.
 *
 * §4.1b predicts the first ("moving the probe's first boundary to 45-60 s of hidden
 * time puts it PAST the suspension, so it would measure nothing"). That prediction
 * is the thing under test: if the record covers 60 s of hidden time, it is wrong.
 *
 * ── THE EXPERIMENT RAN. IT IS 15 s AGAIN, AND HERE IS WHY BOTH ARE RIGHT ─────
 *
 * Run **32077857553** (PR #240) set this to 60 s with a 175 s window, and the answer
 * came back on the FIRST reading above:
 *
 *   - `seg-a` played CONTINUOUSLY from before the app was hidden, and the record's
 *     own trail shows a media/wall ratio of **0.99992 over 24.6 s** — audio at
 *     exactly 1x, no silence anywhere, `paused: false` on every one of 24 stamps.
 *   - **NO assertion-release timer was armed at any point** (no
 *     `audible-clear-armed`, no `foreground-release-armed`) — the mechanism the
 *     earlier runs' arithmetic suggested was simply absent.
 *   - The record still stops at **+24.59 s**, and the log has
 *     `didChangeThrottleState(Suspended)` at **+26.28 s**, with the media clock
 *     reading `isPlaying = true` 1.3 s earlier.
 *
 * So the ~26 s is a CEILING ON HIDDEN TIME, not a consequence of this probe's own
 * silence. The traced cause is in that log and it is Simulator-specific:
 * `WKProcessAssertionBackgroundTaskManager: _handleBackgroundTaskExpirationOnMainThread
 * (remainingTime=3.9)` — a ~30 s UIKit background-task budget expiring — while the
 * `'View is playing audio'` foreground activity was still held and the RBS
 * `'WebKit Media Playback'` assertion had been REFUSED at playback start for want of
 * `com.apple.runningboard.assertions.webkit`. That entitlement is what
 * `UIBackgroundModes: audio` buys a real signed app, so this is the one mechanism a
 * Simulator cannot model. `HUMAN-ACTIONS.md` #11 is the only thing that settles it.
 *
 * AND THAT IS WHY THE CONSTANT GOES BACK TO 15. At 60 s the first boundary lands
 * ~34 s PAST the ceiling, so the probe never reaches a seam at all and
 * `seamTransitionVerdict` reports `inconclusive` — a probe whose standing job is the
 * regression test for #227 and #224 would measure nothing, every run, for 14 extra
 * billable minutes. §4.1b predicted exactly that and was right.
 *
 * TO RE-RUN THE CEILING EXPERIMENT: set this to 60 and raise pass 2's `sleep 90` to
 * 175 in `.github/workflows/ios-build.yml` (a GOVERNED file — that needs a founder
 * label). `ios-workflow.test.mjs` derives the window's floor from this constant, so
 * it will tell you if you move one without the other.
 */
const ARM_AFTER_HIDDEN_SEC = 15;
/** If the app is never backgrounded, arm anyway so the run produces a record that
 *  says so instead of playing a tone for the whole window and reporting nothing.
 *
 *  70 s, NOT 45 s, and the reason is a measured harness quirk: `simctl launch
 *  com.apple.Preferences` took ~39 s to actually foreground Settings in run
 *  32025079276. A fallback that fires before backgrounding happens would arm the
 *  boundary while VISIBLE and quietly turn the real measurement into the
 *  wall-clock race that produced two contradictory verdicts from identical code.
 *  This path exists only to make a never-backgrounded run REPORTABLE; it is not
 *  meant to be reached. */
const FALLBACK_ARM_AFTER_MS = 70000;
/** Segment A's authored end. Deliberately far out — it exists only to be
 *  overridden on going hidden, and a value the run can never reach means a missed
 *  override shows up as "no boundary" rather than as a boundary at the wrong time.
 *
 *  200 s, PAST THE 150 s TONE, and it had to move when `ARM_AFTER_HIDDEN_SEC` did.
 *  At 120 s it was unreachable inside the old ~105 s page life and reachable inside
 *  the new one: the fallback arm targets `currentTime + 60`, which can exceed 120,
 *  so a missed override would have produced a real-looking `endReason: "outPoint"`
 *  boundary at 120 s — a measurement of the harness wearing the result's label.
 *  Past the tone, a missed override instead ends the FILE, which arrives as
 *  `END_NATURAL` and `seamTransitionVerdict`'s first caveat says so by name. */
const SEGMENT_A_END_SEC = 200;

const TICK_MS = 250;
const MAX_SAMPLES = 600;
/** How many save stamps the trail keeps. See `rec.saveTrail`. */
const SAVE_TRAIL_MAX = 300;

/* THE QUEUE. Three bounded segments, three files, and every transition therefore a
   real load. B's and C's bounds are authored and untouched by the probe at runtime.

   `seg-b` IS 15 s AND `seg-c` IS 12 s, where they were 8 s and 6 s, and the reason
   survives the arm going back to 15 s: AUDIO MUST OUTLAST THE SUSPICION. In run
   32064639785 the record's last write landed **0.3 s** before `seg-b`'s audio was due
   to run out, so "the page was suspended" and "the probe simply ran out of audio" fit
   the same artifact — the ambiguity that cost this project a day and two retractions.
   With the ceiling measured at ~26 s of hidden time (run 32077857553) and `seg-b`
   becoming audible at ~24 s, a 15 s segment leaves its audio ~13 s still to run when
   the record stops. Nothing about the record's end can be blamed on the fixture.

   THE LENGTHS ARE ALSO BOUNDED FROM ABOVE, by the window rather than by taste: at the
   MEASURED 9.2 s beat, 15 + 9.2 + 15 + 9.2 = 48.4 s of hidden chain plus the measured
   39 s foregrounding delay is 87.4 s inside a 90 s window. `ios-workflow.test.mjs`
   derives that floor from these very bounds, so lengthening a middle segment without
   raising the window fails a test instead of silently producing a run that measures
   nothing.

   Both stay well inside their 60 s tone files (`install-probe.mjs` generates them).
   The tones are deliberately NOT lengthened: `capacitor://` media loads go through a
   UIProcess scheme handler that took 3.0 s for a 960 KB file while hidden in run
   32064639785, and a bigger file would push a hidden load toward
   `LOAD_SETTLE_TIMEOUT_HIDDEN_MS` for no gain. */
const QUEUE = [
  { id: "seg-a", audio_url: TONE_A, start_sec: 0, end_sec: SEGMENT_A_END_SEC },
  { id: "seg-b", audio_url: TONE_B, start_sec: 12, end_sec: 27 },
  { id: "seg-c", audio_url: TONE_C, start_sec: 20, end_sec: 32 },
];

/* A NUMBERED SLOT, not one fixed key — `xcrun simctl launch` on a running app can
   RESTART it, and a restart's empty record must never overwrite a finished
   measurement. `pickSeam` in tools/mobile/ios-ci.mjs chooses the most informative
   afterwards, ranking the decisive negative first. */
const KEY_BASE = "foray_probe_seam";
const KEY = (function () {
  for (let n = 0; n < 5; n++) {
    const key = n === 0 ? KEY_BASE : KEY_BASE + "_" + n;
    try {
      const prior = JSON.parse(localStorage.getItem(key) || "null");
      if (!prior || !Array.isArray(prior.transitions) || prior.transitions.length === 0) return key;
    } catch (e) {
      return key;
    }
  }
  return KEY_BASE + "_5";
})();

const rec = {
  phase: "seam",
  startedAtWall: Date.now(),
  lastSavedAtWall: null,
  /* SAVE CADENCE. Run 32036295743's record simply STOPS at +25.2 s of a 90 s
     hidden window, one second after the second segment became audible, with its
     out-point armed and the 1000 ms timer samples ending at the same instant.
     Two readings: the page stopped being scheduled, or its localStorage writes
     stopped reaching disk.

     BE HONEST ABOUT WHAT THIS PAIR CAN AND CANNOT DO -- a first version of this
     comment claimed it separates those two readings, and a review showed it
     cannot. `saveSeq` and `lastSavedAtWall` are stamped and then serialised into
     the SAME `setItem` blob, so whatever blob reaches disk always carries a
     matching pair. Under either reading the recovered record reads
     `saveSeq=N, lastSavedAtWall=T_N`. The state "high seq, old wall clock" is
     unobservable by construction, and no in-record counter can be otherwise:
     a page cannot record the fact that its own later write failed to persist.

     WHAT THIS DOES BUY, which is still worth having: the number of saves and the
     first save's wall clock, so the CADENCE is checkable. `saveSeq` against
     `(lastSavedAtWall - firstSavedAtWall) / 2000` says whether saves were landing
     on the 2 s interval or already stuttering before the record ends -- a
     stuttering cadence is evidence for the write-path reading without settling it.

     WHAT ACTUALLY SEPARATES THEM is an out-of-band channel that does not depend on
     the thing under suspicion. That is the system log, which is why the workflow
     now gives each pass its own capture with a corrected predicate. If a run's
     `simulator-log-seam.txt` shows RunningBoard moving this process to a suspended
     state around the moment the record ends, that is the descheduling reading,
     decided. If it shows the process alive to the end of the window, it is the
     write-path reading. Failing both, the last resort is a one-off diagnostic run
     that resumes the app and reads the IN-MEMORY record -- which trades away the
     never-resume property this harness is built on, so it is a deliberate
     one-shot, not a change to the standing measurement. */
  saveSeq: 0,
  firstSavedAtWall: null,
  /* THE ONE THING `saveSeq` + `lastSavedAtWall` CANNOT DO, done here instead.
     The pair above says WHEN the record stops. It cannot say whether the page
     stopped being scheduled or its writes stopped landing, for the reason spelled
     out above: both stamps ride in the same blob.

     This trail is one stamp PER SAVE, each carrying the MEDIA clock alongside the
     wall clock. That is the discriminator, because the two clocks are driven by
     different machinery — `Date.now()` needs the page to be running, `currentTime`
     needs the audio pipeline to be running, and run 32064639785's log shows the
     second outliving the first by ~13 s.

     So a recovered record answers three questions the earlier one could not:

       - a trail whose wall deltas hold ~2 s to the end, then nothing: the page was
         being scheduled right up to the last stamp. Whatever ended it was abrupt.
       - a trail with a GAP — stamp N at hidden+70 s, stamp N+1 at hidden+83 s — is
         a page that was frozen and RESUMED, which no single "the record stops"
         observation can show. `mediaSec` across that gap then says whether the audio
         kept flowing through the freeze (delta ~= the gap) or stalled with it
         (delta ~= 0).
       - stamps whose wall clock advances while `mediaSec` does not, with
         `paused: false`: audio starved while the page ran, which is neither of the
         two readings and would be a third finding.

     A RING, AND THE EVICTION END MATTERS: it drops the OLDEST stamps, because the END
     of the window is what this exists to show. A review caught the first version
     dropping the newest, which would have silently discarded exactly the stamps that
     say where the record stopped. 300 stamps is AT LEAST 10 minutes at the 2 s
     interval — "at least", because a save also fires on every stage and telemetry
     line, so the real cadence is faster and 300 buys correspondingly less wall clock.
     It is not expected to be reached inside a 175 s window; if it is,
     `saveTrailAnalysis` reports `truncated` rather than letting a ringed trail read as
     a stopped one. */
  saveTrail: [],
  plannedItems: QUEUE.length,
  askedGapMs: Math.round(SEAM_GAP_SEC * 1000),
  backgroundedAtWall: null,
  resumedAtWall: null,
  hiddenTransitions: 0,
  armedBoundaryAtSec: null,
  armedWhileHidden: null,
  autoplayBlocked: false,
  autoplayError: null,
  /** One per item that became audible. */
  items: [],
  /** One per boundary, closed when the next item becomes audible. */
  transitions: [],
  /** A 250 ms setInterval sampled while hidden — the beat's own clock, measured in
   *  this run rather than quoted from another one. */
  timerIntervalsMs: [],
  /** The manager's and the backend's own telemetry, stamped. This is the trail a
   *  human reads when a verdict is a stall. */
  telemetry: [],
  seamGapFlips: [],
  error: null,
};

const outEl = document.getElementById("out");

/** The `<audio>` element, once it exists.
 *
 *  A MODULE-LEVEL BINDING RATHER THAN THE `const el` BELOW, because `save()` is
 *  called from the outermost `catch` too. If the probe threw before the element was
 *  created, a `save()` that read `el` would hit the temporal dead zone, throw a
 *  second time out of the handler, and lose the very error it was recording — the
 *  record would come back empty and the run would report "nothing was measured"
 *  instead of the stack that explains it. */
let mediaEl = null;

function push(arr, v) {
  if (arr.length < MAX_SAMPLES) arr.push(v);
}

function save() {
  rec.saveSeq += 1;
  rec.lastSavedAtWall = Date.now();
  if (rec.firstSavedAtWall == null) rec.firstSavedAtWall = rec.lastSavedAtWall;
  /* Both clocks, in the same stamp. See `saveTrail`. `mediaSec` is rounded to
     milliseconds because a raw double per stamp is noise a reader has to skip. */
  /* A RING, DROPPING THE OLDEST — and a review caught this being a head cap, which
     drops the NEWEST. The end of the window is the whole point: a head cap would
     silently discard exactly the stamps that say where the record stopped, in a file
     whose comment says it exists to show where the record stopped. `saveSeq` and
     `firstSavedAtWall` already carry the beginning, so the oldest stamps are the ones
     that can be spared. `saveTrailAnalysis` reports `truncated` when it happens. */
  rec.saveTrail.push({
    seq: rec.saveSeq,
    wall: rec.lastSavedAtWall,
    mediaSec: mediaEl ? Math.round(mediaEl.currentTime * 1000) / 1000 : null,
    paused: mediaEl ? mediaEl.paused === true : null,
    hidden: document.hidden === true,
  });
  while (rec.saveTrail.length > SAVE_TRAIL_MAX) rec.saveTrail.shift();
  /* COUNT THE WRITE FAILURES THE PAGE CAN ACTUALLY SEE. `saveTrail`'s comment is right
     that a page cannot record that its LAST write failed to persist — but a `setItem`
     that THROWS is observable, and it is direct evidence for the write-path reading
     this record exists to separate from the suspension one. It was swallowed before,
     so the one observable half of that question was being thrown away. The count rides
     out on the next save that does land. */
  try {
    localStorage.setItem(KEY, JSON.stringify(rec));
  } catch (e) {
    rec.saveErrors = (rec.saveErrors || 0) + 1;
  }
  try { console.log("FORAY_PROBE_SEAM " + JSON.stringify(rec)); } catch (e) {}
  if (outEl) {
    const done = rec.transitions.filter((t) => t.nextPlayingAtWall != null).length;
    outEl.textContent =
      `queue          ${QUEUE.map((q) => q.id + "@" + q.audio_url).join("  ")}\n` +
      `armed at       ${rec.armedBoundaryAtSec == null ? "— not yet —" : rec.armedBoundaryAtSec.toFixed(2) + " s"}` +
      ` (while hidden: ${rec.armedWhileHidden})\n` +
      `visibility     ${rec.hiddenTransitions} change(s) to hidden, backgrounded=${rec.backgroundedAtWall != null},` +
      ` resumed=${rec.resumedAtWall != null}\n` +
      `items audible  ${rec.items.length} of ${QUEUE.length}\n` +
      `seams          ${done} completed of ${rec.transitions.length} started\n` +
      `beats (ms)     asked ${rec.askedGapMs}; observed ` +
      `${rec.transitions.map((t) => (t.observedGapMs == null ? "…" : Math.round(t.observedGapMs))).join(", ") || "—"}\n` +
      `last stage     ${rec.transitions.length ? rec.transitions[rec.transitions.length - 1].lastStage : "—"}\n` +
      `median timer   ${median(rec.timerIntervalsMs)} (asked for ${TICK_MS})\n` +
      `record         save #${rec.saveSeq}` +
      (rec.backgroundedAtWall == null
        ? " (still visible)"
        : `, ${((rec.lastSavedAtWall - rec.backgroundedAtWall) / 1000).toFixed(1)} s into the hidden window`) +
      `\n` +
      `autoplay       ${rec.autoplayBlocked ? "BLOCKED: " + rec.autoplayError : "ok"}\n` +
      `error          ${rec.error || "none"}\n`;
  }
}

function median(a) {
  if (!a || !a.length) return "—";
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return String(Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2));
}

/** The transition currently waiting for its next item to become audible. */
function pending() {
  const t = rec.transitions[rec.transitions.length - 1];
  return t && t.nextPlayingAtWall == null ? t : null;
}

function stage(name) {
  const t = pending();
  if (!t) return;
  t.lastStage = name;
  t.stages.push({ stage: name, wall: Date.now(), hidden: document.hidden === true });
  save();
}

try {
  const el = document.createElement("audio");
  /* In the document, and `playsinline`, because that is how app.js plays: WebKit's
     audibility bookkeeping is per-element and an out-of-document element is a
     needless difference from the thing under test. */
  el.setAttribute("playsinline", "");
  el.preload = "auto";
  document.body.appendChild(el);
  /* Publish it to `save()` immediately, so the very first stamp carries a media
     clock rather than a null. */
  mediaEl = el;

  const note = (m) => {
    push(rec.telemetry, { wall: Date.now(), at: el.currentTime, hidden: document.hidden === true, m: String(m) });
    if (/play\.rejected/.test(String(m))) {
      /* Capacitor sets `mediaTypesRequiringUserActionForPlayback = []` (MP1 §7.3)
         and run 32026332637 saw autoplay work, so a rejection here is a finding
         about the harness and the verdict reports it as inconclusive rather than as
         a failure of the seam. */
      rec.autoplayBlocked = true;
      rec.autoplayError = String(m);
    }
    save();
  };

  const backend = new HtmlAudioBackend({ element: el, telemetry: note });

  /* Element events split "the beat's timer was late" from "the load was slow",
     which are different bugs. `loadstart` is the element beginning to look for
     media; `playing` is audio actually flowing. */
  el.addEventListener("loadstart", () => {
    const t = pending();
    if (t && t.loadStartedAtWall == null) t.loadStartedAtWall = Date.now();
    stage("load-started");
  });
  el.addEventListener("loadedmetadata", () => stage("loadedmetadata"));
  el.addEventListener("canplay", () => stage("canplay"));
  el.addEventListener("waiting", () => stage("waiting"));
  el.addEventListener("stalled", () => stage("stalled"));

  el.addEventListener("playing", () => {
    const now = Date.now();
    const t = pending();
    /* `playing` FIRES AGAIN AFTER A BUFFERING STALL, so it cannot be counted as
       "an item started" on its own — that would inflate the item count and, worse,
       shift every subsequent `toId` by one. A new item has started only if this is
       the very first `playing` of the run or if it closes an open transition.
       Everything else is the same item resuming. */
    const startsAnItem = rec.items.length === 0 || t != null;
    if (t) {
      t.nextPlayingAtWall = now;
      t.nextStartedAtSec = el.currentTime;
      t.observedGapMs = now - t.boundaryAtWall;
      t.hiddenAtNextPlaying = document.hidden === true;
      t.lastStage = "playing";
      t.stages.push({ stage: "playing", wall: now, hidden: document.hidden === true });
    }
    if (startsAnItem) {
      const planned = QUEUE[rec.items.length];
      push(rec.items, {
        id: planned ? planned.id : `item-${rec.items.length}`,
        /** The FILE, so a transition that silently replayed the same source — the
         *  same-URL seek shortcut, which would make this measure the wrong thing —
         *  is visible in the record rather than inferred from it. */
        src: String(el.currentSrc || "").split("/").pop(),
        expectedSrc: planned ? planned.audio_url : null,
        expectedStartSec: planned ? planned.start_sec : null,
        playingAtWall: now,
        startedAtSec: el.currentTime,
        hiddenAtPlaying: document.hidden === true,
      });
    } else {
      note(`playing again mid-item at ${el.currentTime.toFixed(2)}s (a stall recovered)`);
    }
    save();
  });

  /* The beat, as the manager itself sees it. Two flips per transition (on, off) —
     a beat that arms and never disarms is a beat whose timer did not fire, which is
     a different diagnosis from a load that hung. */
  const onSeamGapChange = (inGap) => {
    push(rec.seamGapFlips, { wall: Date.now(), inGap: inGap === true, hidden: document.hidden === true });
    stage(inGap ? "beat-armed" : "beat-ended");
  };

  const manager = new PlayerQueueManager({
    backend,
    telemetry: note,
    onSeamGapChange,
  });

  /* READ THE BEAT BACK OFF THE MANAGER, do not trust the import.
     `rec.askedGapMs` was initialised from `SEAM_GAP_SEC`, which is what the module
     defines — not necessarily what this manager is using. A review defeated every
     test in this suite with one edit by passing `seamGapSec: 0.05` here, collapsing
     the 2.0 s beat (the throttled `setTimeout` that is the whole reason this phase
     exists) to 50 ms; the record could not even show it, because it reported the
     import's value. Now the record states the number actually in force, and
     `seamTransitionVerdict` floors the observed gap at `SEAM_MIN_PLAUSIBLE_MS`. */
  rec.askedGapMs = Math.round((typeof manager.seamGapSec === "number" ? manager.seamGapSec : 0) * 1000);
  rec.askedGapMsFromModule = Math.round(SEAM_GAP_SEC * 1000);

  /* THE BOUNDARY SIGNAL, taken from the documented seam rather than by parsing
     telemetry strings.
     `onItemEnded(reason)` is "assigned by the manager" in the PlayerBackend
     contract, so this wraps what the manager just assigned and calls straight
     through. Recording BEFORE calling through matters: the manager arms the beat
     inside that call, so a stamp taken afterwards would already include it.
     Wrapping rather than replacing matters more — replacing it would break the very
     advance under test, which is the failure a probe must not be able to cause. */
  const managerItemEnded = backend.onItemEnded;
  backend.onItemEnded = (reason) => {
    const now = Date.now();
    /* NO TRANSITION AFTER THE LAST SEGMENT. The end of `seg-c` is the end of the
       queue, and recording it as a transition that never completed would make every
       healthy run report a stall — the probe manufacturing its own failure. */
    if (!QUEUE[rec.items.length]) {
      note(`queue.finished after ${rec.items.length} item(s), reason=${String(reason)}`);
      return managerItemEnded(reason);
    }
    rec.transitions.push({
      index: rec.transitions.length,
      fromId: rec.items.length ? rec.items[rec.items.length - 1].id : null,
      toId: QUEUE[rec.items.length] ? QUEUE[rec.items.length].id : null,
      endReason: String(reason),
      boundaryAtWall: now,
      boundaryAtSec: el.currentTime,
      overshootSec:
        typeof backend.lastOutPointOvershootSec === "number" ? backend.lastOutPointOvershootSec : null,
      hiddenAtBoundary: document.hidden === true,
      loadStartedAtWall: null,
      nextPlayingAtWall: null,
      nextStartedAtSec: null,
      observedGapMs: null,
      hiddenAtNextPlaying: null,
      lastStage: "boundary",
      stages: [{ stage: "boundary", wall: now, hidden: document.hidden === true }],
    });
    save();
    return managerItemEnded(reason);
  };

  /* The beat's own clock, sampled in THIS run. Phase B measured a 1000 ms median
     while hidden; quoting that instead of re-measuring would be assuming the
     simulator runtime and iOS version have not changed, and they have between runs
     (iOS 26.5 on one, 18.7 on another). */
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    if (document.hidden) push(rec.timerIntervalsMs, now - lastTick);
    lastTick = now;
  }, TICK_MS);

  /**
   * Re-arm segment A's boundary relative to NOW. Once.
   *
   * IT WILL NOT ARM BEFORE PLAYBACK HAS ACTUALLY STARTED, and that guard is not
   * defensive noise. `HtmlAudioBackend.load()` CLEARS any armed out-point — that is
   * its documented contract — so an arm that lands before seg-a's load resolves
   * would be silently discarded, the manager would then arm the authored
   * `end_sec` (`SEGMENT_A_END_SEC`, 200 s), which is past the end of the tone. The
   * run would report "no seam was reached while backgrounded" with nothing to point
   * at — or, worse before 200 s, a boundary at a time nothing chose.
   * `probe-outpoint.js` is immune by accident (it never calls `load()`); this is a
   * hazard phase C introduces by driving the real manager.
   *
   * `rec.items.length > 0` means the element has fired `playing` at least once, so
   * the load is done and nothing else will clear the boundary. If the app goes hidden
   * before then, the arm is deferred to the first `playing` instead of dropped.
   */
  let armWhenPlaying = null;
  function arm(whileHidden) {
    if (rec.armedBoundaryAtSec !== null) return;
    if (rec.items.length === 0) {
      /* Too early — the load has not resolved and would clear this. Remember the
         intent and let the `playing` handler do it. */
      armWhenPlaying = whileHidden;
      note(`arm deferred until playback starts (hidden=${whileHidden})`);
      save();
      return;
    }
    const target = el.currentTime + ARM_AFTER_HIDDEN_SEC;
    rec.armedBoundaryAtSec = target;
    rec.armedWhileHidden = whileHidden;
    armWhenPlaying = null;
    backend.setOutPoint(target);
    save();
  }
  /* REGISTERED AFTER the item-pushing `playing` handler above, and that order is
     load-bearing: this one needs `rec.items.length` to have been incremented already,
     or `arm()` defers again and nothing ever arms. `install-probe.test.mjs` pins the
     order in the source, because a reader reordering two listeners for tidiness would
     otherwise silently disarm the whole measurement. */
  el.addEventListener("playing", () => { if (armWhenPlaying !== null) arm(armWhenPlaying); });

  /* SEEDED FROM `document.hidden` AT STARTUP, not only from the event. This page is
     reached by a `location.replace` from `probe-bridge.js` 3 s after launch; if the
     app were ever backgrounded before that navigation completed, this page would come
     up ALREADY hidden, no `visibilitychange` would ever fire, and the verdict would
     report "the app was never observed to leave the foreground" for a run that was
     hidden throughout. Today's 15 s pre-background sleep leaves ~11 s of margin, so
     this is insurance rather than a fix — but it removes the class. */
  if (document.hidden === true) {
    rec.backgroundedAtWall = Date.now();
    rec.hiddenTransitions++;
    note("the seam page loaded already hidden");
    arm(true);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      rec.hiddenTransitions++;
      /* RE-STAMP IF NOTHING HAS BEEN AUDIBLE YET.
         `backgroundedAtWall`/`resumedAtWall` model ONE hidden window — the first —
         and the startup seeding above makes it easier to record the wrong one: a
         transient `document.hidden` at page load followed by the app being visible
         again would pin `backgroundedAtWall` at launch and `resumedAtWall` a moment
         later, after which every real transition looks like it completed AFTER a
         resume and a healthy run reports `too-few-transitions`. If no item has become
         audible yet then nothing has been measured against those stamps, so the honest
         thing is to take the later window. */
      if (rec.items.length === 0 && rec.resumedAtWall !== null) {
        note("re-stamping the hidden window: nothing was audible during the first one");
        rec.resumedAtWall = null;
        rec.backgroundedAtWall = Date.now();
      }
      if (rec.backgroundedAtWall === null) rec.backgroundedAtWall = Date.now();
      arm(true);
    } else if (rec.backgroundedAtWall !== null && rec.resumedAtWall === null) {
      /* THE FIELD THAT DECIDES WHETHER THIS RUN PROVES ANYTHING. A transition that
         finished at or after this stamp finished because the app came back, which is
         the confound, not the result. */
      rec.resumedAtWall = Date.now();
    }
    save();
  });

  /* The fallback arm, so "the app was never backgrounded" is a reported result
     rather than a run that plays a tone and says nothing. */
  setTimeout(() => arm(false), FALLBACK_ARM_AFTER_MS);

  /* Save on a slow interval too: localStorage is how the host reads any of this and
     WebKit flushes on its own schedule, so a suspended-then-killed app still leaves
     its numbers — including, crucially, a half-finished transition. */
  setInterval(save, 2000);

  manager.loadQueue(QUEUE);
  manager.play(0).catch((e) => {
    rec.error = "play(0) rejected: " + String((e && e.message) || e);
    save();
  });
  save();
} catch (e) {
  rec.error = "probe threw: " + String((e && e.stack) || e);
  save();
}
