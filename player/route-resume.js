/* Route resume: when a car comes back, does 4a start playing again on its own?
   (founder Q5, docs/DECISIONS.md 2026-09-25; native-engine-plan.md NE-38rj.)

   THE RULE. A known car route that comes back resumes playback ONLY when the
   last pause was that route going away. A pause the listener made is never
   resumed, and neither is one a call, Siri or the system made. Concretely,
   `routeResumeDecision` says yes only when every one of these holds:

     1. the last pause was a route loss (`pausedBy: "route"`),
     2. of THIS route: the key that came back is the key that was lost,
     3. the route's class allows it: `car` always, `bluetooth` only with the
        Bluetooth arm on, `other` (headphones, speaker, AirPlay...) never,
     4. the route is known: our own audio has played through it,
     5. the loss is at most ROUTE_RESUME_MAX_LOST_SEC old.

   `routeResumeStep` is the bookkeeping around it, as a pure reducer: which
   event last paused us, which route was lost and when, and that a loss is spent
   by its one resume. A listener's press, a call, Siri or a system pause after
   the loss clears the eligibility; a route lost while we were already paused
   never arms it. `routeResumeReplay` folds a list of events through it and is
   what the `route-resume` parity family records.

   WHO ASKS. Nothing in JS. This module is the REFERENCE for the native
   engines (NE-38rs on iOS, A-61 on Android), recorded as the `route-resume`
   fixture family. The web and Android JS lanes keep "a reconnect never
   resumes" (queue-manager.js corner case #13, player-core-10), so neither
   queue-manager.js nor client.js imports this file (route-resume.test.js pins
   that). Not on the boot path (CH-07): parity-only, so the web neither
   modulepreloads, precaches nor deploys it; the `route-resume` parity family
   reads it from disk.

   KEYS. `routeKey(portType, uid)` is the port type and the port's UID, never
   its name (two cars of one model share a name, and a name is a DiagGate
   leak). The CALLER hashes it (NE-38rs: a salted SHA-256, 8 hex in rows) and
   persists the known set; this module only compares keys for equality. A port
   with no UID has no key, and a route with no key is never "that route".

   CLASSES. The port types are AVAudioSession.Port raw values, which the iOS
   engine reads directly; A-61 maps Android's AudioDeviceInfo types onto the
   same three classes. */

/** How old a route loss may be and still resume. // MEASURE: verdict=route-back
    (NE-38e `route-back` rows' `lostSec` -> NE-38f): 24 h, provisional. The evidence it rests on:
    "after a day at work" (#114, passed on M1) is about 9-10 h, and a car
    parked overnight is about 14 h, so 24 h covers both with room, while a loss
    from the day before yesterday is not the same drive.

    THE CLOCK. The age is measured on a clock that keeps running while the
    phone sleeps and the app is suspended: wall-clock seconds (Swift `Date()`,
    Java `System.currentTimeMillis()`). NOT uptime (`ProcessInfo.systemUptime`,
    `DispatchTime`, `SystemClock.uptimeMillis`), which stops while the device
    sleeps, so a phone asleep in a parked car overnight would read a two-day
    loss as a few minutes old and resume it. A wall clock that steps backwards
    gives a negative age, which is refused (`loss-age-unknown`). */
export const ROUTE_RESUME_MAX_LOST_SEC = 24 * 60 * 60;

/** Whether a Bluetooth route (A2DP, HFP, LE) may resume on its own.
    // MEASURE: verdict=route-back (NE-38e `route-back`: the ms from a route's `back` to the car's own `remote
    play`): OFF, provisional. The founder's car is BluetoothA2DPOutput and
    sends its own play 7.4 s after connecting (2026-09-28 paste, e#83 -> e#85),
    so an automatic resume would only race that press; and AirPods are A2DP
    too, so on headphones it would misfire outright. CarPlay (`car`) is not
    behind this arm. The engines expose it as `routeResumeBluetooth`. */
export const ROUTE_RESUME_BLUETOOTH_DEFAULT = false;

const CAR_PORTS = new Set(["CarAudio"]);
const BLUETOOTH_PORTS = new Set(["BluetoothA2DPOutput", "BluetoothHFP", "BluetoothLE"]);

/** "car" | "bluetooth" | "other" for an AVAudioSession port type. */
export function routeClass(portType) {
  if (CAR_PORTS.has(portType)) return "car";
  if (BLUETOOTH_PORTS.has(portType)) return "bluetooth";
  return "other";
}

const nonEmpty = (s) => typeof s === "string" && s.length > 0;

/** The key a route is known by: port type and UID, unhashed (the caller
    hashes it). null when either is missing, so a UID-less port can never be
    matched or become known. */
export function routeKey(portType, uid) {
  if (!nonEmpty(portType) || !nonEmpty(uid)) return null;
  return `${portType}|${uid}`;
}

/** Why a pause other than a route loss is not resumed. */
const NOT_A_ROUTE_PAUSE = Object.freeze({
  listener: "listener-paused",
  interruption: "interrupted",
  system: "system-paused",
  none: "not-paused",
});

const no = (why) => ({ resume: false, why });

/**
 * Should the engine resume now that route `back` has come back?
 * @param {object} p
 * @param {"route"|"listener"|"interruption"|"system"|"none"} p.pausedBy  what caused the last pause
 *   ("none": we are not paused, or nothing paused us: never started, ended, or already resuming)
 * @param {{port: string, key: string|null}|null} p.lost  the route whose loss paused us
 * @param {{port: string, key: string|null}|null} p.back  the route that just came back
 * @param {boolean} p.known       our audio has played through `back` (the caller's persisted set)
 * @param {number}  p.lostAgoSec  seconds since the loss
 * @param {boolean} [p.bluetoothArm]  defaults to ROUTE_RESUME_BLUETOOTH_DEFAULT
 * @returns {{resume: boolean, why: string}}  `why` is a closed token (the NE-38rs `route kind=back` row's why=)
 */
export function routeResumeDecision({ pausedBy, lost, back, known, lostAgoSec, bluetoothArm } = {}) {
  // The founder's Q5 rule: only a pause the route itself caused is resumed.
  if (pausedBy !== "route") return no(NOT_A_ROUTE_PAUSE[pausedBy] ?? "not-paused");
  if (!lost || !nonEmpty(lost.key)) return no("no-loss");
  if (!back || !nonEmpty(back.key) || back.key !== lost.key) return no("other-route");
  const cls = routeClass(back.port);
  if (cls === "other") return no("not-a-car");
  if (cls === "bluetooth" && (bluetoothArm ?? ROUTE_RESUME_BLUETOOTH_DEFAULT) !== true) return no("bluetooth-off");
  if (known !== true) return no("unknown-route");
  if (!Number.isFinite(lostAgoSec) || lostAgoSec < 0) return no("loss-age-unknown");
  if (lostAgoSec > ROUTE_RESUME_MAX_LOST_SEC) return no("lost-too-long");
  return { resume: true, why: "route-back" };
}

/** The reducer's starting state. `playing` is the engine's intent (playing, or
    loading to play), not what the speaker is doing this instant. */
export function routeResumeInitial({ playing = true } = {}) {
  return { playing: playing === true, pausedBy: "none", lost: null };
}

/**
 * One event through the route-resume bookkeeping. Pure: returns a new state.
 * Events (`on`):
 *   `atSec` is wall-clock seconds (see ROUTE_RESUME_MAX_LOST_SEC: never uptime).
 *   - "lost"  {port, key, atSec}: the route went away. Arms a resume only when we
 *             were playing; a route lost while paused changes nothing.
 *   - "back"  {port, key, known, atSec}: a route came back; asks routeResumeDecision.
 *             A resume spends the loss, so a second back (a duplicate route
 *             notification while the resume's load is pending, or a later one)
 *             finds nothing to resume.
 *   - "press" {command}: any press (the listener, the lock screen, the car's own
 *             buttons). Clears eligibility. "pause" pauses as the listener; "play"
 *             plays; anything else leaves a paused engine paused by the listener.
 *   - "interruption": a call or Siri took the session.
 *   - "system": the system paused us (media services reset, the queue ended...).
 *   - "playing": our audio became audible, whatever started it.
 * @returns {{state: object, decision: {resume: boolean, why: string}|null}}
 */
export function routeResumeStep(state, event, { bluetoothArm = ROUTE_RESUME_BLUETOOTH_DEFAULT } = {}) {
  const s = { ...state };
  switch (event?.on) {
    case "lost":
      if (s.playing) {
        s.playing = false;
        s.pausedBy = "route";
        s.lost = { port: event.port ?? null, key: event.key ?? null, atSec: event.atSec };
      }
      return { state: s, decision: null };
    case "back": {
      const decision = routeResumeDecision({
        pausedBy: s.pausedBy,
        lost: s.lost,
        back: { port: event.port ?? null, key: event.key ?? null },
        known: event.known,
        lostAgoSec: s.lost ? event.atSec - s.lost.atSec : NaN,
        bluetoothArm,
      });
      if (decision.resume) {
        // At most one resume per loss.
        s.playing = true;
        s.pausedBy = "none";
        s.lost = null;
      }
      return { state: s, decision };
    }
    case "press":
      s.lost = null;
      if (event.command === "pause") { s.playing = false; s.pausedBy = "listener"; }
      else if (event.command === "play") { s.playing = true; s.pausedBy = "none"; }
      else if (!s.playing) s.pausedBy = "listener";
      return { state: s, decision: null };
    case "interruption":
    case "system":
      if (s.playing || s.pausedBy === "route") {
        s.playing = false;
        s.pausedBy = event.on;
      }
      s.lost = null;
      return { state: s, decision: null };
    case "playing":
      s.playing = true;
      s.pausedBy = "none";
      s.lost = null;
      return { state: s, decision: null };
    default:
      throw new TypeError(`routeResumeStep: unknown event ${JSON.stringify(event?.on)}`);
  }
}

/**
 * Fold `events` through routeResumeStep from routeResumeInitial.
 * @param {object[]} events
 * @param {{bluetoothArm?: boolean, playing?: boolean}} [opts]  `playing`: the state before the first event (default true)
 * @returns {{decisions: {event: number, resume: boolean, why: string}[], resumes: number}}
 *   one decision per "back" event, with its index in `events`
 */
export function routeResumeReplay(events, { bluetoothArm = ROUTE_RESUME_BLUETOOTH_DEFAULT, playing = true } = {}) {
  if (!Array.isArray(events)) throw new TypeError("routeResumeReplay: events must be an array");
  let state = routeResumeInitial({ playing });
  const decisions = [];
  events.forEach((event, i) => {
    const r = routeResumeStep(state, event, { bluetoothArm });
    state = r.state;
    if (r.decision) decisions.push({ event: i, ...r.decision });
  });
  return { decisions, resumes: decisions.filter((d) => d.resume).length };
}
