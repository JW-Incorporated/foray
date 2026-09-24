/* The native engine's closed vocabularies (docs/native-engine-plan.md §4, card
   NE-04): every token an engine diagnostics row may carry in a position that is
   not a number.

   WHY CLOSED. The engine's rows end up in a Copy paste the founder puts into a
   GitHub issue (NE-19, NE-26), and a row is admitted by its tokens, never by
   free text: a token outside these sets is DROPPED, so a native row cannot put
   a sentence, a device name or a URL into a public record. It is the same
   discipline `diagnostic-log.js` keeps for the page's own rows (SESSION_KINDS,
   TRANSPORT_SOURCES, ...), for the same reason. The sets are also a contract:
   `tools/mobile/engine-report.mjs` (NE-26r) turns rows into DV verdicts, and a
   verdict that matches `cause=grace-expired` must be matching the spelling the
   engine writes.

   JS IS THE REFERENCE, AS EVERYWHERE IN THIS DECK. This module is the one place
   a token is added. `node tools/parity/gen-constants.mjs --write` then derives
   the two copies the other side reads — `player/parity/vocabulary.json` (for
   the Swift parity runner and node tools that do not import page modules) and
   `foray-engine-core/Sources/ForayEngineCore/Diag/Vocabulary.swift` (one
   String-backed enum per set, so a Swift emitter cannot spell a token that is
   not here) — and `tools/parity/gen-constants.test.mjs` is red until it has.
   The `diag-tokens` parity family records these sets and `admitToken`, so the
   Swift admission (NE-10s) is held to the same answers.

   SPELLING. Lower-case dashed tokens (`grace-expired`), the shape every native
   row already uses, EXCEPT the interruption reasons, which are Apple's own
   `AVAudioSession.InterruptionReason` case names verbatim: a reader
   cross-checking a row against Apple's documentation should not have to
   translate. The generator refuses any other shape.

   Pure data plus one pure function. No DOM, no storage, no imports. */

/** Where a deck is in its load (plan §4.3's readiness-gated pipeline, and the
    `stage list` of the packed `seam` row, NE-19/NE-32). In pipeline order:
    attach the item, load its duration, run the ADR-0007 gate, wait for BOTH
    `player.status` and `item.status == .readyToPlay` (`readiness`), seek with
    zero tolerance, `preroll(atRate: 0)`, report `ready`, and only then `play`
    and see `playing` confirmed. The rest are the ways a load leaves that line:
    the gate's approximate verdict (`skip`), an interrupted seek or an
    unfinished preroll (`not-ready`), its one `retry`, the fallback to an
    ordinary load (`ordinary-load`), and the load deadline (`deadline`, P-13).
    A seam row lists the stages its standby deck reached, so a prepare miss
    says WHERE it missed. */
export const STAGES = Object.freeze([
  "attach", "duration", "gate", "readiness", "seek", "preroll", "ready", "play", "playing",
  "skip", "not-ready", "retry", "ordinary-load", "deadline",
]);

/** Why an activation failed (§4.4). They mirror the three outcomes of
    `AVAudioSession.setActive(true)` the engine distinguishes: another app's
    session could not be interrupted, the system refused playback, or anything
    else. An engineSend refused for this reason answers `session-failed:<token>`
    (§5.2). */
export const SESSION_ERRORS = Object.freeze(["cannot-interrupt-others", "cannot-start-playing", "other"]);

/** `AVAudioSessionInterruptionReasonKey`, spelled as Apple spells the cases
    (§4.4). `appWasSuspended` is the one that matters most: its began
    notification can arrive late, for a suspension that is already over, and
    the session policy treats it as stale when the engine activated in this
    process and is running. A reason the SDK adds later, or a missing key, is
    `unknown` — never a new string on the wire. */
export const INTERRUPTION_REASONS = Object.freeze(["default", "appWasSuspended", "builtInMicMuted", "unknown"]);

/** Why audio stopped: the `cause=` of a `stop` row (D-5). Every audio-stopping
    path emits one BEFORE the stop (NE-40 audits that), and a milestone does not
    exit while any `cause=unknown` remains (plan §7, M2's exit). Named for the
    fact, not the code path:
      pause                a listener's pause, from any surface (`source=` says which)
      ended                an item played to its end and the queue moved on
      final-end            the last item ended and nothing followed
      system-pause         an uncommanded pause the engine could not attribute (§4.3)
      route-change         the output went away (oldDeviceUnavailable, within 500 ms)
      interruption         a phone call, a navigation prompt, another app's session
      grace-expired        BackgroundGrace's expiration handler fired (§4.4)
      seam-timeout         a seam's next item never became ready in time
      load-deadline        a load exceeded its deadline (P-13)
      error                the item failed
      relinquish           the engine handed playback back to the JS lane (§4.6)
      data-deletion        stop {persist: false}
      close                the listener closed the player
      media-services-reset the system's media services restarted
      unknown              none of the above; each one is a defect to name */
export const STOP_CAUSES = Object.freeze([
  "pause", "ended", "final-end", "system-pause", "route-change", "interruption",
  "grace-expired", "seam-timeout", "load-deadline", "error", "relinquish",
  "data-deletion", "close", "media-services-reset", "unknown",
]);

/** Who asked (§5.2's `source`, recorded before any no-op return, D-4). The
    first five are the page's own `TRANSPORT_SOURCES` in diagnostic-log.js — a
    page command carries one of them into engineSend, so every one must be
    admissible here (engine-vocabulary.test.js pins it). The engine adds its own
    three: a continuation hop (`autoadvance`), a resume after an interruption
    or a route return (`autoresume`), and a voice preview (`audition`, OQ-5). */
export const SOURCES = Object.freeze([
  "tap", "remote", "reconcile", "session", "restore", "autoadvance", "autoresume", "audition",
]);

/** Why the process runs the lane it runs: the `reason=` of a `mode` row and of
    every Copy header (§4.6).
      build-default  Info.plist's ForayEngineDefault decided
      override       the Developer engine setting decided
      no-plist-key   ForayEngineDefault is absent, so js (a fixture, NE-11j)
      not-built      this build has no engine (the NE-01 stub's answer)
      crash-loop     three strikes; legacy until CFBundleVersion changes
      page-health    no engineHello arrived in time after a page load
      downgrade      a one-way relinquish to the legacy lane (cap= says why) */
export const MODE_REASONS = Object.freeze([
  "build-default", "override", "no-plist-key", "not-built", "crash-loop", "page-health", "downgrade",
]);

/** Things that must never happen, written as a `fault` row when they do (and
    asserted in DEBUG): an audible primitive reached with the session not
    active (`implicit-activation`, §4.3), and a page write to a row the engine
    owns (`externally-owned`, NE-23). NE-26r counts both on every paste. */
export const FAULT_KINDS = Object.freeze(["implicit-activation", "externally-owned"]);

/** Every set, by the name `admitToken` takes. The names are the Swift enum
    names in lower camel case (`stopCause` -> `Vocabulary.StopCause`). */
export const VOCABULARY = Object.freeze({
  stage: STAGES,
  sessionError: SESSION_ERRORS,
  interruptionReason: INTERRUPTION_REASONS,
  stopCause: STOP_CAUSES,
  source: SOURCES,
  modeReason: MODE_REASONS,
  faultKind: FAULT_KINDS,
});

/** The set names, in declaration order. */
export const VOCABULARY_SETS = Object.freeze(Object.keys(VOCABULARY));

/**
 * Admit a token into a row: the token itself when `set` holds it exactly, else
 * null (the row drops it). Exact means exact — no trimming, no case folding,
 * no dashed/camel equivalence — because a native emitter that spells a token
 * differently is a defect to surface, and a lenient admission would hide it.
 *
 * An unknown SET is a RangeError, not a null: the caller named a vocabulary
 * that does not exist, which is a bug in code, not a bad row. Own properties
 * only, so `"constructor"` and `"__proto__"` are unknown sets, not holes.
 *
 * @param {string} set    one of VOCABULARY_SETS
 * @param {unknown} token
 * @returns {string|null}
 */
export function admitToken(set, token) {
  if (typeof set !== "string" || !Object.hasOwn(VOCABULARY, set)) {
    throw new RangeError(`no closed vocabulary named ${JSON.stringify(set)}`);
  }
  return typeof token === "string" && VOCABULARY[set].includes(token) ? token : null;
}
