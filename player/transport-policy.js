/* The client layer's transport rules, as pure functions (NE-08,
   docs/native-engine-plan.md §6.3 and §14).

   WHY THIS FILE EXISTS
   Every rule below used to live inside a closure in `player/client.js`, next to
   the DOM, the manager and the element it acts on. That was fine while one
   player existed. The native iOS engine reimplements these rules in Swift
   (`TransportPolicy.swift`, NE-09), and a rule that can only be read by booting
   client.js cannot be handed to a second implementation, nor checked against
   one. So the DECISIONS move here and client.js keeps the ACTIONS: it gathers
   what it knows, asks one of these functions, and does what the answer says.

   NO BEHAVIOUR CHANGE, BY CONSTRUCTION. Each function is the old inline code
   with its inputs named, in the same order, with the same quirks — including
   the ones a fresh design would not choose (`previousAction` on a narration
   item; `skipTarget`'s `Number(offset || 0)`). The web and Android suites that
   boot the real client.js (transport-reconcile, media-session, foray-playback)
   are the proof; `transport-policy.test.js` pins the rules themselves, from the
   `transport` fixture family, which is also the Swift port's test list.

   JS IS THE REFERENCE (plan §6). A change to a rule here is a JS PR that
   re-records `player/parity/fixtures/transport/`, which hands the changed case
   ids to swift-pending.json; the Swift port follows. Never edit the Swift side
   first.

   Every answer is a closed token or plain data, so a fixture can record it and
   a Swift `enum` can mirror it. Nothing here reads a clock, the DOM or storage. */

import { TTS } from "./queue-state.js";
import { itemRuntimeSec } from "./foray-queue.js";

/** Below this many seconds into a segment, "previous" means the segment before. */
export const RESTART_WINDOW_SEC = 4;

/** How far inside the end of an item a Foray-clock seek may land. See
    `sourceOffsetFor`. */
export const SEEK_INSIDE_END_SEC = 0.25;

/** Forward seeks stop this far short of the end. A 30-second nudge with eight
    seconds left must not become "finished": seeking past the end makes the
    element fire `ended`, which records the episode as done and — with Up Next —
    starts the next one, from a button whose label promised a nudge. */
export const SEEK_END_GUARD_SEC = 1;

/** What a play/pause press does (`resolveToggle`). */
export const TOGGLE = Object.freeze({
  /** A restored bar (or one whose seek was written down): start its item. */
  PLAY_RESTORED: "play-restored",
  /** A finished Foray: play means start it over (`endedPlayAction`). */
  START_OVER: "start-over",
  /** The transport already is what the press asks for: repaint only. */
  NONE: "none",
  /** Something is showing and nothing is queued: load it, then seek. */
  LOAD: "load",
  RESUME: "resume",
  PAUSE: "pause",
});

/** What "previous" does inside a Foray (`previousAction`). */
export const PREVIOUS = Object.freeze({
  /** Play the item before, from its start. */
  ITEM_BEFORE: "item-before",
  /** Hand it to the manager's own previous (restart this item). */
  MANAGER: "skip-to-previous",
});

/** Where an episode seek goes (`seekAction`). */
export const SEEK = Object.freeze({
  /** Nothing is loaded to seek in: write the target down as the pending start. */
  PEND: "pend",
  /** Paused, loading or playing: the manager takes it (a load holds it as
      `pendingSeek`). */
  SEEK: "seek",
});

/** What a stop from outside the page does (`remoteStopAction`). */
export const REMOTE_STOP = Object.freeze({
  /** The Android notification's own Stop: close the player. */
  CLOSE: "close",
  /** Every other remote stop (a head unit's square, a Bluetooth hang-up). */
  PAUSE: "pause",
});

/**
 * What play means on a transport that has ended, or null when no special rule
 * applies (the ordinary resume does).
 *
 * A FINISHED FORAY STARTS OVER (audit 2026-09-22). `manager.resume()` from
 * `ended` re-loads the LAST segment at its in-point, so "play" on a Foray that
 * had finished replayed its final ninety seconds and ended again, while the
 * Foray page offered to "Resume" something with nothing left to resume.
 *
 * @param {object} s
 * @param {boolean} s.foray     a Foray is loaded
 * @param {string|null} s.stateType  the manager's state type
 */
export function endedPlayAction({ foray, stateType }) {
  return foray && stateType === "ended" ? TOGGLE.START_OVER : null;
}

/**
 * The decision inside every play/pause press — the tap, the lock screen, the
 * car, the headphone pinch all reach it through client.js's `setRunning`.
 *
 * The order is the rule. A restored bar wins over everything (its press has
 * to load audio, not resume it); a finished Foray starts over; a press asking
 * for what the transport already is does nothing (`running` is
 * `transportIsRunning()`, belief OR element — #689); and only then does play
 * load an empty queue or resume, and pause pause.
 *
 * @param {object} s
 * @param {boolean} s.want       true = play, false = pause
 * @param {boolean} s.restored   a restored/pending start is armed
 * @param {boolean} s.foray      a Foray is loaded
 * @param {string|null} s.stateType  the manager's state type
 * @param {boolean} s.running    the transport is running (belief or element)
 * @param {boolean} s.hasCurrent something is showing on the bar
 * @param {number} s.queueLength the manager's queue length
 * @returns {string} a `TOGGLE` token
 */
export function resolveToggle({ want, restored, foray, stateType, running, hasCurrent, queueLength }) {
  if (want && restored) return TOGGLE.PLAY_RESTORED;
  if (want) {
    const ended = endedPlayAction({ foray, stateType });
    if (ended) return ended;
  }
  if (want === running) return TOGGLE.NONE;
  if (!want) return TOGGLE.PAUSE;
  /* NOTHING LOADED, BUT SOMETHING SHOWING: load it rather than resume it.
     `manager.resume()` answers `resume.ignored.noCurrentItem` on an empty
     queue, which is a button that does nothing. Written against the QUEUE
     rather than a flag, so it does not care WHY the queue is empty. */
  if (hasCurrent && queueLength === 0) return TOGGLE.LOAD;
  return TOGGLE.RESUME;
}

/**
 * Previous means "restart this segment" while we are inside it, and "the one
 * before" when we have only just started it — the convention every podcast
 * player uses, and the only one that is usable when segments are 90 seconds
 * long. The threshold is measured against the segment's own start, not the
 * episode's.
 *
 * A narration item has no `start_sec`, so `into` is NaN and the answer is the
 * manager's previous. Recorded as it is (fixture `transport/previous-narration`),
 * not tidied: this card changes no behaviour.
 *
 * @param {object} s
 * @param {number} s.index        the manager's current index
 * @param {object|null} s.item    the playable item at that index
 * @param {number|null} s.currentTime  the element's clock
 * @returns {string} a `PREVIOUS` token
 */
export function previousAction({ index, item, currentTime }) {
  const into = item ? (currentTime ?? 0) - item.start_sec : 0;
  return index > 0 && into < RESTART_WINDOW_SEC ? PREVIOUS.ITEM_BEFORE : PREVIOUS.MANAGER;
}

/** A target the episode can actually hold: never below zero, never past the
    end guard; null for a target that is not a number. With no known duration
    it is only floored. */
export function clampEpisodeTarget(seconds, dur) {
  const s = Number(seconds);
  if (!Number.isFinite(s)) return null;
  const floor = Math.max(0, s);
  return dur ? Math.min(floor, Math.max(0, dur - SEEK_END_GUARD_SEC)) : floor;
}

/**
 * Where a ↺15 / 30↻ nudge lands. Inside a Foray the step is taken on the
 * Foray's clock (so it crosses a clip boundary the way the scrubber does) and
 * never goes below zero; on an episode it is the episode clamp.
 *
 * @param {object} s
 * @param {boolean} s.foray        a Foray is loaded
 * @param {number} s.positionSec   where the bar says the listener is (Foray or
 *                                 episode seconds)
 * @param {*} s.offsetSec          the step, signed
 * @param {number|null} [s.durationSec]  the episode's length, when known
 * @returns {number|null} the target, or null for nothing to seek to
 */
export function skipTarget({ foray, positionSec, offsetSec, durationSec = null }) {
  const offset = Number(offsetSec || 0);
  if (foray) return Math.max(0, positionSec + offset);
  return clampEpisodeTarget(positionSec + offset, durationSec);
}

/**
 * Where an episode seek goes. `idle` is the restored bar (nothing has loaded)
 * and a failed load; `ended` is an episode that ran out. The reducer refuses a
 * seek in both, so the move is written down as the pending start instead — the
 * thumb stays where the listener put it and the next press of play starts
 * there. Paused and loading are ordinary seeks: the reducer holds a loading
 * seek as `pendingSeek`.
 *
 * @param {object} s
 * @param {boolean} s.restored   a restored/pending start is already armed
 * @param {string|null} s.stateType  the manager's state type
 * @returns {string} a `SEEK` token
 */
export function seekAction({ restored, stateType }) {
  const nothingToSeekIn = restored || stateType === "idle" || stateType === "ended";
  return nothingToSeekIn ? SEEK.PEND : SEEK.SEEK;
}

/**
 * Where in the element's OWN clock a point `into` seconds into queue item
 * `item` lives — the one translation from the Foray's clock to a source file's
 * clock, used by the scrubber (`scrubTarget`) and by a resume (`playForay`).
 * Returns null when there is nothing to seek (audit 2026-09-22, two defects):
 *
 *  - A NARRATION ITEM HAS NO `start_sec`. `item.start_sec + into` was
 *    `undefined + into` — NaN, refused at the bottom of the stack, so a scrub
 *    into a bridge restarted it from its first word. A rendered bridge's file IS
 *    the item, so its offset is `into` itself. A SPOKEN one has no file at all:
 *    the synthesiser cannot start mid-sentence, so there is nothing to seek and
 *    the line starts from the top, as `_loadItem` states for every bridge.
 *  - THE CLOCK'S END-CLAMP IS NOT A SCRUB PAST THE BOUNDARY. `segmentAtElapsed`
 *    answers a position at or past the total with the last segment's END, and
 *    the backend reads a seek landing exactly on an out-point as a deliberate
 *    scrub past it — and disarms the boundary, so the audio free-played on into
 *    the rest of a stranger's episode with the countdown frozen. A seek always
 *    lands just inside the item, so "take me to the end" ends the Foray.
 */
export function sourceOffsetFor(item, into) {
  if (!item || !Number.isFinite(into)) return null;
  const len = itemRuntimeSec(item);
  const inside = Number.isFinite(len) && len > 0
    ? Math.min(Math.max(0, into), Math.max(0, len - SEEK_INSIDE_END_SEC))
    : Math.max(0, into);
  if (Number.isFinite(item.start_sec)) return item.start_sec + inside;
  if (item.kind === TTS && !item.audio_url) return null;
  return inside;
}

/**
 * A scrub on the Foray's clock, once the clock has said where it lands
 * (`segmentAtElapsed`'s `{index, into}`, which stays the Foray clock's job).
 *
 * `reload` is the nothing-to-seek-in rule for a Foray: another clip needs its
 * own load, and a FINISHED Foray has nothing loaded to seek in — the reducer
 * refuses a seek in `ended` — so a scrub back into the last clip reloads it,
 * the same as a scrub into any other clip does (audit 2026-09-22).
 *
 * @param {object} s
 * @param {{index:number, into:number}|null} s.at  where the Foray clock landed
 * @param {object|null} s.item       the playable item at `at.index`
 * @param {number} s.currentIndex    the manager's current index
 * @param {string|null} s.stateType  the manager's state type
 * @returns {{index:number, reload:boolean, offset:number|null}|null}
 *   null when the clock found nowhere to land
 */
export function scrubTarget({ at, item, currentIndex, stateType }) {
  if (!at) return null;
  const reload = at.index !== currentIndex || stateType === "ended" || stateType === "idle";
  return { index: at.index, reload, offset: sourceOffsetFor(item, at.into) };
}

/**
 * A stop from outside the page is a PAUSE, unless it is the Android
 * notification's own Stop button (`details.close`, sent as `CLOSE_ACTION` by
 * foray-media-session.js), which closes the player — on API 24-33 that
 * notification cannot be swiped away, so its Stop is the listener's only exit.
 * A car's or a Bluetooth stack's stop never carries `close`, so one press of a
 * head unit's square cannot blank the car display mid-drive (audit 2026-09-22).
 *
 * @param {object|null|undefined} details  the remote command's details
 * @returns {string} a `REMOTE_STOP` token
 */
export function remoteStopAction(details) {
  return details?.close === true ? REMOTE_STOP.CLOSE : REMOTE_STOP.PAUSE;
}
