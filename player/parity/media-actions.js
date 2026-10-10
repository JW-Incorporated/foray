/* The remote-command mapping, as data (NE-12j, plan §6: the `media-episode`
   family's action half).

   WHY THIS FILE EXISTS. `mediaSessionActions(surface, opts)` in
   player/media-session.js is the rule a lock-screen, car or headphone press
   obeys: which OS buttons exist for a given surface (an absent method is a
   greyed-out button), and what each press turns into (`seekbackward` is always
   our -15, never the platform's `seekOffset`; `seekto` with no usable time is
   not a seek to zero; only `{close: true}` reaches `stop`). Its answer is a list
   of `[action, handler]` pairs, and a handler is a function — nothing a fixture
   can hold, and nothing the Swift runner could compare. So a case cannot `call`
   it directly.

   This adapter asks the REAL function and writes down what it did: it builds a
   surface that only records, hands it to `mediaSessionActions`, presses the
   buttons a case names, and returns `{installed, calls}`. Nothing here decides a
   mapping. Change a rule in media-session.js and these cases change on the next
   `record.mjs --check`, exactly as a direct call would.

   WHAT THE SWIFT PORT IMPLEMENTS (NE-12s's MediaMapping): the same function of
   the same inputs — given which intents are available and a sequence of remote
   presses with their details, the ordered list of commands to enable and the
   intents issued. On iOS "available" becomes `commandAvailability(snapshot)`
   and a press arrives from MPRemoteCommandCenter, but the table is this one.

   THE CALL SHAPE (one export, `mediaActions`):

     mediaActions({ surface, opts, presses })
       surface  array of surface method names, any subset of
                play, pause, stop, next, previous, seekBy, seekTo — or null /
                absent, which is handed to mediaSessionActions as-is (the "empty
                surface installs nothing" rule is about exactly those inputs)
       opts     passed through when present ({ seekBackwardSec, seekForwardSec })
       presses  [[action] | [action, details], ...] in order; a one-element
                press is a handler invoked with NO argument, a two-element one
                with `details` (which may be the $undefined tag)
     -> { installed: [action, ...]  in MEDIA_ACTIONS order,
          calls:     [[method, ...args], ...]  every surface call, in order,
                     with the arguments it really received — `["next"]` means
                     next() got none, `["stop", {"$undefined": true}]` means
                     stop was handed an explicit undefined }

   A press of an action the surface did not install is a HARNESS error, not a
   result: the OS never delivers a press for a command nobody registered, so a
   case that asks for one is malformed.

   THE SECOND CALL, `commandAvailability` (CH3-10): the engine's NP-5 rule,
   which the page has no twin of (the page's lane registers through WebKit, and
   the legacy native lane through ForayAudioPlugin's own enablement). It is
   AUTHORED HERE from the contract, not recorded from a page module, and every
   case in its group is `authored: true`:

     commandAvailability(snapshot, trackRoute)
       snapshot    { mode, ended?, canNext?, canPrevious?, autoAdvance? } —
                   Snapshot v1's fields (plan §5.3); `mode` is one of
                   engine-contract.js SNAPSHOT_MODES, every flag a boolean
                   (absent = false). Anything else is a malformed case.
       trackRoute  boolean: the current route has a track button without
                   looking (a headset, a Bluetooth stack, a car)
     -> { enabled: [command, ...]  in REMOTE_COMMANDS order,
          clearsNowPlaying: boolean }

   The rule, read off docs/DECISIONS.md 2026-09-23 §1 and plan §4.5 (NP-5):
   nothing loaded, or a finished Foray, enables nothing and clears Now Playing;
   anything else enables play, pause, toggle, the skip pair and a scrub through
   the SAME `mediaSessionActions` table as above, and the track pair exactly
   when there is a neighbour AND a track route ("the track pair only where a
   track button exists", founder question 1 of that entry: on the speaker the
   lock screen keeps ↺15/30↻ whatever Up Next holds). `stop` is never enabled
   (T-7); `autoAdvance` is read by nothing (the wheel's skip follows the
   chain). Swift's `MediaMapping.commandAvailability(_:steps:trackRoute:)` and
   the JVM's `commandAvailability(snapshot, steps, trackRoute)` answer the same
   cases through their media-episode runners.

   The page never imports this file. It is harness code, like runner.js. */

import { mediaSessionActions } from "../media-session.js";
import { SNAPSHOT_MODES } from "../engine-contract.js";
import { HarnessError } from "./codec.js";

/** The surface methods mediaSessionActions reads. Closed: a case that names
    anything else is asking about a method the rule does not know. */
export const SURFACE_METHODS = Object.freeze(["play", "pause", "stop", "next", "previous", "seekBy", "seekTo"]);

function recordingSurface(names, calls) {
  if (!Array.isArray(names)) return names;
  const surface = {};
  for (const name of names) {
    if (!SURFACE_METHODS.includes(name)) {
      throw new HarnessError("E_BAD_CASE", `surface method ${JSON.stringify(name)} is not one of ${SURFACE_METHODS.join(", ")}`);
    }
    // Rest parameters, so the recorded arity is what the handler really
    // passed: "previoustrack takes no arguments" is a claim about arity.
    surface[name] = (...args) => { calls.push([name, ...args]); };
  }
  return surface;
}

/**
 * Install a surface through the real mapping and press its buttons.
 * @returns {{installed: string[], calls: Array<Array<*>>}}
 */
export function mediaActions({ surface = undefined, opts = undefined, presses = [] } = {}) {
  const calls = [];
  const pairs = opts === undefined
    ? mediaSessionActions(recordingSurface(surface, calls))
    : mediaSessionActions(recordingSurface(surface, calls), opts);
  const handlers = new Map(pairs);
  for (const press of presses) {
    if (!Array.isArray(press) || press.length < 1 || press.length > 2) {
      throw new HarnessError("E_BAD_CASE", `a press is [action] or [action, details], got ${JSON.stringify(press)}`);
    }
    const [action, ...rest] = press;
    const handler = handlers.get(action);
    if (!handler) {
      throw new HarnessError("E_BAD_CASE", `"${action}" is not installed for this surface; the OS never delivers a press for it`);
    }
    handler(...rest);
  }
  return { installed: [...handlers.keys()], calls };
}

/** The remote commands the engine registers (`MediaMapping.RemoteCommand`, in
    its declaration order on both natives). Closed. */
export const REMOTE_COMMANDS = Object.freeze([
  "play", "pause", "togglePlayPause", "nextTrack", "previousTrack",
  "skipBackward", "skipForward", "changePlaybackPosition", "stop",
]);

function flag(snapshot, name) {
  const v = snapshot[name];
  if (v === undefined) return false;
  if (typeof v !== "boolean") throw new HarnessError("E_BAD_CASE", `snapshot.${name} must be a boolean, got ${JSON.stringify(v)}`);
  return v;
}

/**
 * NP-5 with the track-route gate (CH3-10). See the header for the shape.
 * @returns {{enabled: string[], clearsNowPlaying: boolean}}
 */
export function commandAvailability(snapshot, trackRoute) {
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new HarnessError("E_BAD_CASE", `a snapshot is an object, got ${JSON.stringify(snapshot)}`);
  }
  if (!SNAPSHOT_MODES.includes(snapshot.mode)) {
    throw new HarnessError("E_BAD_CASE", `snapshot.mode must be one of ${SNAPSHOT_MODES.join(", ")}, got ${JSON.stringify(snapshot.mode)}`);
  }
  if (typeof trackRoute !== "boolean") {
    throw new HarnessError("E_BAD_CASE", `trackRoute must be a boolean, got ${JSON.stringify(trackRoute)}`);
  }
  const ended = flag(snapshot, "ended");
  const canNext = flag(snapshot, "canNext");
  const canPrevious = flag(snapshot, "canPrevious");
  flag(snapshot, "autoAdvance"); // carried by the snapshot, read by nothing

  const finished = snapshot.mode === "none" || (snapshot.mode === "foray" && ended);
  if (finished) return { enabled: [], clearsNowPlaying: true };

  const surface = ["play", "pause", "seekBy", "seekTo"];
  // THE TRACK PAIR ONLY WHERE A TRACK BUTTON EXISTS (DECISIONS 2026-09-23).
  if (canNext && trackRoute) surface.push("next");
  if (canPrevious && trackRoute) surface.push("previous");
  const { installed } = mediaActions({ surface });
  const has = (action) => installed.includes(action);
  const on = new Set();
  if (has("play")) on.add("play");
  if (has("pause")) on.add("pause");
  if (has("play") && has("pause")) on.add("togglePlayPause");
  if (has("nexttrack")) on.add("nextTrack");
  if (has("previoustrack")) on.add("previousTrack");
  if (has("seekbackward")) on.add("skipBackward");
  if (has("seekforward")) on.add("skipForward");
  if (has("seekto")) on.add("changePlaybackPosition");
  return { enabled: REMOTE_COMMANDS.filter((c) => on.has(c)), clearsNowPlaying: false };
}
