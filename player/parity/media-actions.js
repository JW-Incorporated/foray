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

   The page never imports this file. It is harness code, like runner.js. */

import { mediaSessionActions } from "../media-session.js";
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
