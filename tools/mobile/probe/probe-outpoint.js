/* PHASE B — does OUR out-point still fire when the app is not in the foreground?
 *
 * Issue #38, attacking `docs/research/mp1-background-audio.md` §8:
 *
 *   "The coarse stage runs on `timeupdate` … so DOM-timer alignment should not
 *    apply to it, and it should keep firing at its usual ~4 Hz. THIS IS
 *    INFERENCE, and it is the single most load-bearing untested claim here."
 *
 * If that inference is wrong, the fallback is the file's natural `ended` event,
 * which MP1 §3 measured at a **936.5 s median overrun — 15.6 minutes of the
 * wrong episode** — and iOS would need a native audio backend too (#28).
 *
 * SO THIS DRIVES THE REAL BACKEND, not a reimplementation of it. It imports
 * `player/html-audio-backend.js` from the bundle and uses its public contract:
 * `setOutPoint(seconds)`, `onItemEnded(reason)`, `lastOutPointOvershootSec`.
 * `load()` is deliberately not used — it wants a resolved item and a network
 * fetch, and the out-point stages do not depend on it.
 *
 * WHAT THE NUMBERS MEAN, AND THE ONE THAT MATTERS
 *   overshootSec              how far past end_sec playback got. For scale: ~14 ms
 *                             foreground, but that figure is MP1 §4.3's
 *                             desktop-Chromium measurement (n=3, a hidden TAB),
 *                             not a phone and not this backend on iOS. MP1 §8
 *                             predicts 0.25–1 s backgrounded; anything in minutes
 *                             is the disaster.
 *   stoppedWhileBackgrounded  false means nothing stopped it until the app came
 *                             back — the failure mode, whatever the overshoot.
 *   timeupdateIntervalsMs     the coarse stage's actual rate while hidden. This
 *                             is the inference itself, measured.
 *   timerIntervalsMs          a 250 ms setInterval while hidden, against MP1
 *                             §7.5's claim that WebKit aligns hidden-page DOM
 *                             timers to 1 s. Also never measured before.
 *
 * A SIMULATOR IS NOT A DEVICE. It does not model true suspension or power
 * management, so a pass here is weak and a failure is strong. That asymmetry is
 * stated wherever these numbers are reported.
 */
import { HtmlAudioBackend } from "./player/html-audio-backend.js";

/* A NUMBERED SLOT, NOT ONE FIXED KEY. `xcrun simctl launch` on an app that is
   already running can RESTART it, and a restart would run this file again — so a
   single key means the second run's empty record silently overwrites the
   measurement the first run was launched to collect, and the report reads
   "nothing was measured" from a run that measured everything. Any slot holding a
   finished record (`stoppedAtSec` set) is left alone; `pickOutPoint` in
   tools/mobile/ios-ci.mjs chooses the most informative one afterwards. */
const KEY_BASE = "foray_probe_outpoint";
const KEY = (function () {
  for (let n = 0; n < 5; n++) {
    const key = n === 0 ? KEY_BASE : KEY_BASE + "_" + n;
    try {
      const prior = JSON.parse(localStorage.getItem(key) || "null");
      if (!prior || prior.stoppedAtSec == null) return key;
    } catch (e) {
      return key;
    }
  }
  return KEY_BASE + "_5";
})();

/* THE BOUNDARY IS ARMED RELATIVE TO GOING HIDDEN, NOT TO WALL CLOCK.
 *
 * The first real run armed it at a fixed `end_sec = 25` and let the workflow
 * background the app on a `sleep`. The result looked perfect and measured almost
 * nothing: the page was VISIBLE for 24.5 s of those 25 s and hidden for the final
 * **0.446 s**, with exactly TWO hidden `timeupdate` samples. `simctl launch
 * com.apple.Preferences` returns as soon as the launch is accepted, and Settings
 * took ~10 s to actually come to the foreground on a cold-booted simulator — so
 * the backgrounding landed nowhere near where the timeline assumed.
 *
 * A wall-clock race cannot be tightened into reliability; it has to be removed.
 * So the out-point is now armed on the first `visibilitychange` to hidden, at
 * `currentTime + ARM_AFTER_HIDDEN_SEC`. However long backgrounding takes, the
 * boundary is that many seconds INSIDE the hidden window, and the hidden window
 * is what the measurement is about.
 *
 * There is still a fallback arm, because "never hidden" must be reported rather
 * than hung on — `outPointVerdict` has an explicit verdict for it. */
const ARM_AFTER_HIDDEN_SEC = 15;
/** If the app is never backgrounded, arm anyway at this media time so the run
 *  produces a record that says so instead of timing out silently. */
const FALLBACK_ARM_AT_SEC = 60;
const TONE = "probe-tone.wav";
const TICK_MS = 250;
const MAX_SAMPLES = 1200;

const rec = {
  phase: "outpoint",
  /** Filled in when the boundary is actually armed — see ARM_AFTER_HIDDEN_SEC. */
  endSec: null,
  armedWhileHidden: null,
  /** Seconds of HIDDEN playback before the out-point fired. The number that says
   *  whether this run measured backgrounding at all. */
  hiddenPlaybackSec: null,
  startedAtWall: Date.now(),
  backgroundedAtWall: null,
  resumedAtWall: null,
  hiddenTransitions: 0,
  stoppedAtSec: null,
  stoppedAtWall: null,
  stoppedWhileBackgrounded: null,
  endReason: null,
  overshootSec: null,
  autoplayBlocked: false,
  autoplayError: null,
  timeupdateIntervalsMs: [],
  timerIntervalsMs: [],
  hiddenTimeupdates: 0,
  visibleTimeupdates: 0,
  telemetry: [],
  error: null,
};

const outEl = document.getElementById("out");

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(rec)); } catch (e) {}
  if (outEl) {
    outEl.textContent =
      `end_sec        ${rec.endSec}\n` +
      `stopped at     ${rec.stoppedAtSec === null ? "— NOT YET —" : rec.stoppedAtSec.toFixed(3) + " s"}\n` +
      `overshoot      ${rec.overshootSec === null ? "—" : rec.overshootSec.toFixed(3) + " s"}\n` +
      `while hidden   ${rec.stoppedWhileBackgrounded}\n` +
      `hidden window  ${rec.hiddenPlaybackSec === null ? "—" : rec.hiddenPlaybackSec.toFixed(3) + " s of hidden playback"}\n` +
      `end reason     ${rec.endReason}\n` +
      `hidden tu/vis  ${rec.hiddenTimeupdates} / ${rec.visibleTimeupdates}\n` +
      `median tu ms   ${median(rec.timeupdateIntervalsMs)}\n` +
      `median timer   ${median(rec.timerIntervalsMs)} (asked for ${TICK_MS})\n` +
      `autoplay       ${rec.autoplayBlocked ? "BLOCKED: " + rec.autoplayError : "ok"}\n` +
      `error          ${rec.error || "none"}\n`;
  }
  try { console.log("FORAY_PROBE_OUTPOINT " + JSON.stringify(rec)); } catch (e) {}
}

function median(a) {
  if (!a || !a.length) return "—";
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return String(Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2));
}

function push(arr, v) {
  if (arr.length < MAX_SAMPLES) arr.push(v);
}

try {
  const el = document.createElement("audio");
  /* In the document rather than a bare `new Audio()`: WebKit's audibility
     bookkeeping is per-element and an out-of-document element is a needless
     difference from how app.js actually plays. */
  el.setAttribute("playsinline", "");
  el.preload = "auto";
  el.src = TONE;
  document.body.appendChild(el);

  const backend = new HtmlAudioBackend({
    element: el,
    telemetry: (m) => {
      push(rec.telemetry, { wall: Date.now(), at: el.currentTime, hidden: document.hidden, m: String(m) });
      save();
    },
  });

  backend.onItemEnded = (reason) => {
    rec.stoppedAtSec = el.currentTime;
    rec.stoppedAtWall = Date.now();
    rec.stoppedWhileBackgrounded = document.hidden === true;
    rec.endReason = String(reason);
    rec.overshootSec =
      typeof backend.lastOutPointOvershootSec === "number"
        ? backend.lastOutPointOvershootSec
        : Math.max(0, rec.stoppedAtSec - (rec.endSec ?? 0));
    /* How much HIDDEN playback this run actually observed. The first run reported
       a beautiful 4 ms overshoot from a 0.446 s hidden window, and nothing in the
       report said so. */
    rec.hiddenPlaybackSec =
      rec.backgroundedAtWall != null && rec.stoppedWhileBackgrounded
        ? (rec.stoppedAtWall - rec.backgroundedAtWall) / 1000
        : 0;
    save();
  };
  backend.onError = (e) => { rec.error = "backend error: " + String(e); save(); };

  /* The coarse stage, measured. Our own listener rather than the backend's, so
     the rate is observed independently of whether the out-point logic acts on
     it. */
  let lastTu = null;
  el.addEventListener("timeupdate", () => {
    const now = Date.now();
    if (lastTu !== null && document.hidden) push(rec.timeupdateIntervalsMs, now - lastTu);
    lastTu = now;
    if (document.hidden) rec.hiddenTimeupdates++;
    else rec.visibleTimeupdates++;
  });

  /* MP1 §7.5's 1 s hidden-page DOM timer alignment, measured. Independent of the
     out-point: the fine stage uses a one-shot setTimeout, so if this reads ~1000
     the fine stage's precision is gone in the background exactly as predicted. */
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    if (document.hidden) push(rec.timerIntervalsMs, now - lastTick);
    lastTick = now;
  }, TICK_MS);

  /** Arm the boundary at `now + seconds`, once. */
  function arm(seconds, whileHidden) {
    if (rec.endSec !== null) return;
    rec.endSec = el.currentTime + seconds;
    rec.armedWhileHidden = whileHidden;
    backend.setOutPoint(rec.endSec);
    save();
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      rec.hiddenTransitions++;
      if (rec.backgroundedAtWall === null) rec.backgroundedAtWall = Date.now();
      /* THE ARM. Relative to going hidden, so the boundary is always
         ARM_AFTER_HIDDEN_SEC deep INSIDE the hidden window no matter how long
         `simctl launch com.apple.Preferences` actually took to foreground
         Settings — which on the first run was about ten seconds, and reduced the
         hidden window to 0.446 s. */
      arm(ARM_AFTER_HIDDEN_SEC, true);
    } else if (rec.backgroundedAtWall !== null && rec.resumedAtWall === null) {
      rec.resumedAtWall = Date.now();
    }
    save();
  });

  /* Save on a slow interval too: localStorage is how the host reads any of this,
     and WebKit flushes it to disk on its own schedule. Frequent-enough writes
     mean a suspended-then-killed app still leaves the numbers behind. */
  setInterval(save, 2000);

  el.addEventListener("playing", () => {
    /* Deliberately does NOT arm. The boundary is armed on going hidden — see
       ARM_AFTER_HIDDEN_SEC. All this records is that playback really started. */
    rec.playingAtWall = rec.playingAtWall ?? Date.now();
    save();
  });

  /* The fallback arm, so "the app was never backgrounded" is a reported result
     rather than a run that just plays a tone and says nothing. `outPointVerdict`
     reads `armedWhileHidden === false` and refuses to draw a background
     conclusion from it. */
  setTimeout(() => arm(Math.max(1, FALLBACK_ARM_AT_SEC - el.currentTime), false), 40000);

  const p = el.play();
  if (p && typeof p.catch === "function") {
    p.catch((e) => {
      /* Capacitor sets `mediaTypesRequiringUserActionForPlayback = []` (MP1
         §7.3), so a rejection here is a finding about the harness, and the
         verdict function reports it as inconclusive rather than as a failure of
         the thing being measured. */
      rec.autoplayBlocked = true;
      rec.autoplayError = String((e && e.message) || e);
      save();
    });
  }
  save();
} catch (e) {
  rec.error = "probe threw: " + String((e && e.stack) || e);
  save();
}
