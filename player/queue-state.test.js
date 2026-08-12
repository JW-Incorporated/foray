/* Port of ios/ForayKit/Tests/ForayKitTests/PlayerQueueStateTests.swift.

   Every test in the Swift suite has a counterpart here under the SAME name,
   so the two files can be diffed by eye and neither can drift silently.
   Tests below the "seek" heading are new — that behaviour does not exist in
   the Swift original (see player/queue-state.js §seek).

   Run: node --test player/
*/

import test from "node:test";
import assert from "node:assert/strict";
import { reduce, itemRef, S, E, F, EPISODE, TTS } from "./queue-state.js";

/* ---------- fixtures ---------- */

const episodeA = itemRef("episode-a", EPISODE);
const episodeB = itemRef("episode-b", EPISODE);
const episodeC = itemRef("episode-c", EPISODE);
const introTTS = itemRef("intro-tts", TTS);

const isTelemetry = (e) => e && e.type === "emitTelemetry";

/* ---------- idle -> loadingItem -> playing ---------- */

test("testPlayFromIdleTransitionsToLoadingItem", () => {
  const [state, effects] = reduce(S.idle(), E.play(episodeA));
  assert.deepStrictEqual(state, S.loadingItem(episodeA, null));
  assert.deepStrictEqual(effects, [F.loadItem(episodeA)]);
});

test("testItemLoadedForEpisodeStartsPlaybackAndRestoresRate", () => {
  const [state, effects] = reduce(S.loadingItem(episodeA, null), E.itemLoaded());
  assert.deepStrictEqual(state, S.playing(episodeA));
  assert.deepStrictEqual(effects, [F.restoreRate(), F.startPlayback()]);
});

test("testItemLoadedForTTSResetsRateInsteadOfRestoring", () => {
  const [state, effects] = reduce(S.loadingItem(introTTS, null), E.itemLoaded());
  assert.deepStrictEqual(state, S.playing(introTTS));
  assert.deepStrictEqual(effects, [F.resetRateForTTS(), F.startPlayback()]);
  assert.ok(
    !effects.some((e) => e.type === "restoreRate"),
    "TTS items must never restore the per-show rate on load"
  );
});

test("testItemLoadedIgnoredWhenNotLoading", () => {
  const [state, effects] = reduce(S.idle(), E.itemLoaded());
  assert.deepStrictEqual(state, S.idle());
  assert.equal(effects.length, 1);
  assert.ok(isTelemetry(effects[0]), `expected telemetry-only effect, got ${JSON.stringify(effects)}`);
});

/* ---------- itemEnded / transitions (bridge TTS) ---------- */

test("testItemEndedWithNoNextItemEndsQueue", () => {
  const [state, effects] = reduce(S.playing(episodeA), E.itemEnded(null, false));
  assert.deepStrictEqual(state, S.ended());
  assert.deepStrictEqual(effects, [F.emitTelemetry("queue.ended")]);
});

test("testItemEndedDirectCutLoadsNextEpisodeWithoutBridge", () => {
  const [state, effects] = reduce(S.playing(episodeA), E.itemEnded(episodeB, false));
  assert.deepStrictEqual(state, S.loadingItem(episodeB, episodeA));
  assert.deepStrictEqual(effects, [F.loadItem(episodeB)]);
});

test("testItemEndedBridgedEntersTransitioningAndPlaysTransitionTTSAtFullRate", () => {
  const [state, effects] = reduce(S.playing(episodeA), E.itemEnded(episodeB, true));
  assert.deepStrictEqual(state, S.transitioning(episodeA, episodeB));
  assert.deepStrictEqual(effects, [F.resetRateForTTS(), F.playTransitionTTS()]);
});

test("testItemLoadedDuringTransitioningStartsPlaybackWithoutChangingStateValue", () => {
  const transitioning = S.transitioning(episodeA, episodeB);
  const [state, effects] = reduce(transitioning, E.itemLoaded());
  assert.deepStrictEqual(state, transitioning);
  assert.deepStrictEqual(effects, [F.resetRateForTTS(), F.startPlayback()]);
});

test("testItemEndedAfterTransitioningMovesToNextEpisodeAndRestoresRate", () => {
  const transitioning = S.transitioning(episodeA, episodeB);
  const [state, effects] = reduce(transitioning, E.itemEnded(episodeB, false));
  assert.deepStrictEqual(state, S.loadingItem(episodeB, episodeB));
  assert.deepStrictEqual(effects, [F.restoreRate(), F.loadItem(episodeB)]);
});

test("testItemEndedAfterTransitioningFallsBackToQueuedToWhenNoNextGiven", () => {
  const transitioning = S.transitioning(episodeA, episodeB);
  const [state, effects] = reduce(transitioning, E.itemEnded(null, false));
  assert.deepStrictEqual(state, S.loadingItem(episodeB, episodeB));
  assert.deepStrictEqual(effects, [F.restoreRate(), F.loadItem(episodeB)]);
});

/* ---------- interruption: phone call declined / answered / long ---------- */

test("testInterruptionBeganWhilePlayingSavesPositionAndPauses", () => {
  const [state, effects] = reduce(S.playing(episodeA), E.interruptionBegan());
  assert.deepStrictEqual(state, S.interrupted(episodeA, true));
  assert.deepStrictEqual(effects, [
    F.savePosition(), F.pausePlayback(), F.emitTelemetry("interruption.began"),
  ]);
});

test("testDeclinedCall_InterruptionEndsQuicklyWithShouldResume_ResumesPlayback", () => {
  // playing -> phone rings, declined immediately -> interruption ends
  // almost instantly with shouldResume == true.
  const [interrupted] = reduce(S.playing(episodeA), E.interruptionBegan());

  const [resumed, effects] = reduce(interrupted, E.interruptionEnded(true));
  // Resume routes through loadingItem so the manager can re-prime the asset
  // and re-apply the correct per-kind rate on itemLoaded.
  assert.deepStrictEqual(resumed, S.loadingItem(episodeA, episodeA));
  assert.deepStrictEqual(effects, [
    F.loadItem(episodeA), F.emitTelemetry("interruption.ended.resumed"),
  ]);

  const [playing2, loadedEffects] = reduce(resumed, E.itemLoaded());
  assert.deepStrictEqual(playing2, S.playing(episodeA));
  assert.deepStrictEqual(loadedEffects, [F.restoreRate(), F.startPlayback()]);
});

test("testInterruptionDuringTransition_ResumeLandsOnUpcomingItemNotBridgeTTS", () => {
  // Call arrives while the bridge TTS is audible. On resume we must land on
  // the upcoming episode via a fresh load — never resume the half-played
  // bridge, and never inherit the TTS 1.0x rate.
  const [interrupted] = reduce(S.transitioning(episodeA, episodeB), E.interruptionBegan());
  assert.deepStrictEqual(interrupted, S.interrupted(episodeB, true));

  const [resumed, effects] = reduce(interrupted, E.interruptionEnded(true));
  assert.deepStrictEqual(resumed, S.loadingItem(episodeB, episodeB));
  assert.deepStrictEqual(effects, [
    F.loadItem(episodeB), F.emitTelemetry("interruption.ended.resumed"),
  ]);

  const [playing, loadedEffects] = reduce(resumed, E.itemLoaded());
  assert.deepStrictEqual(playing, S.playing(episodeB));
  assert.deepStrictEqual(loadedEffects, [F.restoreRate(), F.startPlayback()]);
});

test("testAnsweredCall_InterruptionEndsWithoutShouldResume_StaysPausedButReady", () => {
  const [interrupted] = reduce(S.playing(episodeA), E.interruptionBegan());

  const [paused, effects] = reduce(interrupted, E.interruptionEnded(false));
  assert.deepStrictEqual(paused, S.interrupted(episodeA, false));
  assert.deepStrictEqual(effects, [F.emitTelemetry("interruption.ended.staysPaused")]);

  // Lock screen must show a correct (paused, resumable) state, and a manual
  // play() must work from here.
  const [resumedManually, resumeEffects] = reduce(paused, E.play(episodeA));
  assert.deepStrictEqual(resumedManually, S.loadingItem(episodeA, episodeA));
  assert.deepStrictEqual(resumeEffects, [F.loadItem(episodeA)]);
});

test("testLongCall_PositionAndItemIdentityPreservedThroughoutInterruption", () => {
  // 20-minute call: began -> (OS may deactivate our session; the reducer
  // doesn't care) -> ended. Item identity must survive unchanged so
  // "restore exactly" holds.
  const [interrupted, beganEffects] = reduce(S.playing(episodeA), E.interruptionBegan());
  assert.ok(beganEffects.some((e) => e.type === "savePosition"));

  assert.equal(interrupted.type, "interrupted");
  assert.deepStrictEqual(interrupted.item, episodeA);
  assert.equal(interrupted.wasPlaying, true);

  const [resumed] = reduce(interrupted, E.interruptionEnded(true));
  assert.deepStrictEqual(resumed, S.loadingItem(episodeA, episodeA));
  const [playing2] = reduce(resumed, E.itemLoaded());
  assert.deepStrictEqual(playing2, S.playing(episodeA));
});

test("testInterruptionBeganDuringLoadDoesNotPauseOrSavePosition", () => {
  // Nothing audible yet; no position to save, nothing to pause.
  const [state, effects] = reduce(S.loadingItem(episodeA, null), E.interruptionBegan());
  assert.deepStrictEqual(state, S.interrupted(episodeA, false));
  assert.deepStrictEqual(effects, [F.emitTelemetry("interruption.began.duringLoad")]);
});

test("testInterruptionBeganIsIdempotent", () => {
  const interrupted = S.interrupted(episodeA, true);
  const [state, effects] = reduce(interrupted, E.interruptionBegan());
  assert.deepStrictEqual(state, interrupted);
  assert.deepStrictEqual(effects, []);
});

/* ---------- route change (Bluetooth) ---------- */

test("testRouteChangedOldDeviceUnavailableWhilePlayingPausesImmediately", () => {
  const [state, effects] = reduce(S.playing(episodeA), E.routeChanged(true));
  assert.deepStrictEqual(state, S.interrupted(episodeA, true));
  assert.deepStrictEqual(effects, [
    F.savePosition(), F.pausePlayback(), F.emitTelemetry("route.oldDeviceUnavailable.paused"),
  ]);
});

test("testRouteChangedMidTTSTransitionPausesAndTracksUpcomingItem", () => {
  const [state, effects] = reduce(S.transitioning(episodeA, episodeB), E.routeChanged(true));
  assert.deepStrictEqual(state, S.interrupted(episodeB, true));
  assert.deepStrictEqual(effects, [
    F.savePosition(), F.pausePlayback(),
    F.emitTelemetry("route.oldDeviceUnavailable.pausedDuringTransition"),
  ]);
});

test("testRouteChangedNewDeviceAvailableDoesNotAutoResumeStateMachine", () => {
  // "Resume only for known car routes" lives in the manager; the reducer
  // must not unilaterally resume.
  const interrupted = S.interrupted(episodeA, true);
  const [state, effects] = reduce(interrupted, E.routeChanged(false));
  assert.deepStrictEqual(state, interrupted);
  assert.deepStrictEqual(effects, [F.emitTelemetry("route.changed.available")]);
});

test("testRouteChangedOldDeviceUnavailableDuringLoadSuppressesSubsequentAutoPlay", () => {
  const [interrupted] = reduce(S.loadingItem(episodeA, null), E.routeChanged(true));
  assert.deepStrictEqual(interrupted, S.interrupted(episodeA, false));

  // A stray itemLoaded arriving after the route died must not start audio
  // into a dead route.
  const [state, effects] = reduce(interrupted, E.itemLoaded());
  assert.deepStrictEqual(state, interrupted);
  assert.ok(isTelemetry(effects[0]), "expected itemLoaded to be ignored");
});

/* ---------- single-player invariant (corner case 19) ---------- */

test("testPlayWhileAlreadyPlayingDifferentItemForcesPauseBeforeLoadingNew", () => {
  const [state, effects] = reduce(S.playing(episodeA), E.play(episodeB));
  assert.deepStrictEqual(state, S.loadingItem(episodeB, episodeA));
  assert.deepStrictEqual(effects, [
    F.pausePlayback(),
    F.loadItem(episodeB),
    F.emitTelemetry("player.doubleEntryGuard: play(episode-b) while playing episode-a"),
  ]);
  // Exactly one pausePlayback — never two concurrent "start" effects.
  assert.equal(effects.filter((e) => e.type === "pausePlayback").length, 1);
});

test("testPlaySameItemAlreadyPlayingIsNoOp", () => {
  const playing = S.playing(episodeA);
  const [state, effects] = reduce(playing, E.play(episodeA));
  assert.deepStrictEqual(state, playing);
  assert.deepStrictEqual(effects, []);
});

test("testPlayWhileTransitioningForcesPauseBeforeLoadingNew", () => {
  const [state, effects] = reduce(S.transitioning(episodeA, episodeB), E.play(episodeA));
  assert.deepStrictEqual(state, S.loadingItem(episodeA, episodeB));
  assert.ok(effects.some((e) => e.type === "pausePlayback"));
  assert.equal(effects.filter((e) => e.type === "pausePlayback").length, 1);
});

/* ---------- fast double-skip serialisation ---------- */

test("testFastDoubleSkipToNextReplacesInFlightLoadWithoutStackingLoads", () => {
  const [afterFirstSkip, firstEffects] = reduce(S.playing(episodeA), E.skipToNext(episodeB));
  assert.deepStrictEqual(afterFirstSkip, S.loadingItem(episodeB, episodeA));
  assert.deepStrictEqual(firstEffects, [
    F.savePosition(), F.pausePlayback(), F.loadItem(episodeB), F.emitTelemetry("skip.next"),
  ]);

  const [afterSecondSkip, secondEffects] = reduce(afterFirstSkip, E.skipToNext(episodeC));
  assert.deepStrictEqual(afterSecondSkip, S.loadingItem(episodeC, episodeA));

  // Exactly one loadItem in the second reduction — the in-flight load for
  // episodeB is replaced, never run alongside it.
  const loads = secondEffects.filter((e) => e.type === "loadItem");
  assert.deepStrictEqual(loads, [F.loadItem(episodeC)]);
  assert.ok(!secondEffects.some((e) => e.type === "loadItem" && e.item.id === "episode-b"));
});

test("testDoubleSkipToSameInFlightTargetIsNoOp", () => {
  const loading = S.loadingItem(episodeB, episodeA);
  const [state, effects] = reduce(loading, E.skipToNext(episodeB));
  assert.deepStrictEqual(state, loading);
  assert.deepStrictEqual(effects, []);
});

test("testSkipToPreviousWithNoTargetRestartsCurrentItemInPlace", () => {
  const [state, effects] = reduce(S.playing(episodeA), E.skipToPrevious(null));
  assert.deepStrictEqual(state, S.loadingItem(episodeA, episodeA));
  assert.deepStrictEqual(effects, [
    F.savePosition(), F.pausePlayback(), F.loadItem(episodeA),
    F.emitTelemetry("skip.previous.restartInPlace"),
  ]);
});

test("testSkipToNextWithNoTargetEndsQueue", () => {
  const [state, effects] = reduce(S.playing(episodeA), E.skipToNext(null));
  assert.deepStrictEqual(state, S.ended());
  assert.deepStrictEqual(effects, [F.emitTelemetry("skip.next.queueExhausted")]);
});

test("testSkipFromIdleActsLikeFreshPlay", () => {
  const [state, effects] = reduce(S.idle(), E.skipToNext(episodeA));
  assert.deepStrictEqual(state, S.loadingItem(episodeA, null));
  assert.deepStrictEqual(effects, [F.loadItem(episodeA)]);
});

/* ---------- stop ---------- */

test("testStopWhilePlayingSavesPositionAndReturnsToIdle", () => {
  const [state, effects] = reduce(S.playing(episodeA), E.stop());
  assert.deepStrictEqual(state, S.idle());
  assert.deepStrictEqual(effects, [
    F.savePosition(), F.pausePlayback(), F.emitTelemetry("player.stopped"),
  ]);
});

test("testStopWhileIdleIsNoOp", () => {
  const [state, effects] = reduce(S.idle(), E.stop());
  assert.deepStrictEqual(state, S.idle());
  assert.deepStrictEqual(effects, []);
});

test("testStopWhileTransitioningSavesPositionAndPauses", () => {
  const [state, effects] = reduce(S.transitioning(episodeA, episodeB), E.stop());
  assert.deepStrictEqual(state, S.idle());
  assert.deepStrictEqual(effects, [
    F.savePosition(), F.pausePlayback(), F.emitTelemetry("player.stopped"),
  ]);
});

/* ---------- error / degrade path ---------- */

test("testErrorFromAnyStateDropsToIdleAndPauses", () => {
  const [state, effects] = reduce(S.playing(episodeA), E.error("missing file"));
  assert.deepStrictEqual(state, S.idle());
  assert.deepStrictEqual(effects, [
    F.pausePlayback(), F.emitTelemetry("player.error: missing file"),
  ]);
});

/* ---------- ended -> play (fresh session after exhausting one) ---------- */

test("testPlayFromEndedStartsFreshLoad", () => {
  const [state, effects] = reduce(S.ended(), E.play(episodeA));
  assert.deepStrictEqual(state, S.loadingItem(episodeA, null));
  assert.deepStrictEqual(effects, [F.loadItem(episodeA)]);
});

/* ==========================================================================
   seek — new behaviour, no Swift counterpart. See queue-state.js §seek and
   issue #20 §5. Precision is the CALLER's decision (issue #30's seek-policy);
   the reducer only carries `precise` through to the backend.
   ========================================================================== */

test("seek while playing saves the old position then seeks, state unchanged", () => {
  const playing = S.playing(episodeA);
  const [state, effects] = reduce(playing, E.seek(1830, true));
  assert.deepStrictEqual(state, playing);
  // savePosition first: the old position is about to be lost, and corner
  // case #17 caps position loss at 15s.
  assert.deepStrictEqual(effects, [F.savePosition(), F.seekTo(1830, true)]);
});

test("seek while interrupted seeks without resuming playback", () => {
  // Scrubbing while paused must not start audio.
  const interrupted = S.interrupted(episodeA, false);
  const [state, effects] = reduce(interrupted, E.seek(90, false));
  assert.deepStrictEqual(state, interrupted);
  assert.deepStrictEqual(effects, [F.savePosition(), F.seekTo(90, false)]);
  assert.ok(!effects.some((e) => e.type === "startPlayback"));
});

test("seek during load is queued and applied on itemLoaded before playback starts", () => {
  // The resume-mid-episode path. Must not race the load.
  const [loading, seekEffects] = reduce(S.loadingItem(episodeA, null), E.seek(4050, true));
  assert.deepStrictEqual(seekEffects, [], "queued seek emits nothing until the item loads");
  assert.deepStrictEqual(loading.pendingSeek, { seconds: 4050, precise: true });

  const [state, effects] = reduce(loading, E.itemLoaded());
  assert.deepStrictEqual(state, S.playing(episodeA));
  assert.deepStrictEqual(effects, [F.restoreRate(), F.seekTo(4050, true), F.startPlayback()]);

  // Exactly one seekTo, and it lands before anything becomes audible.
  assert.equal(effects.filter((e) => e.type === "seekTo").length, 1);
  const seekIdx = effects.findIndex((e) => e.type === "seekTo");
  const playIdx = effects.findIndex((e) => e.type === "startPlayback");
  assert.ok(seekIdx < playIdx, "seek must be applied before playback starts");
});

test("a later seek during load replaces the earlier pending one (last wins)", () => {
  const [first] = reduce(S.loadingItem(episodeA, null), E.seek(100, false));
  const [second] = reduce(first, E.seek(200, true));
  assert.deepStrictEqual(second.pendingSeek, { seconds: 200, precise: true });

  const [, effects] = reduce(second, E.itemLoaded());
  assert.deepStrictEqual(effects.filter((e) => e.type === "seekTo"), [F.seekTo(200, true)]);
});

test("a pending seek does not survive the load target being replaced", () => {
  // The seek was for the old item; carrying it onto a different episode
  // would drop the user at an arbitrary offset in the wrong content.
  const [withSeek] = reduce(S.loadingItem(episodeA, null), E.seek(4050, true));
  const [afterSkip] = reduce(withSeek, E.skipToNext(episodeB));
  assert.equal(afterSkip.pendingSeek, null);
});

test("seek is rejected in idle, ended, and transitioning", () => {
  for (const state of [S.idle(), S.ended(), S.transitioning(episodeA, episodeB)]) {
    const [next, effects] = reduce(state, E.seek(60, true));
    assert.deepStrictEqual(next, state, `${state.type} must be unchanged`);
    assert.equal(effects.length, 1);
    assert.equal(effects[0].type, "seekRejected", `expected seekRejected in ${state.type}`);
  }
});

test("seek carries precise through unchanged — the reducer never decides it", () => {
  const [, exact] = reduce(S.playing(episodeA), E.seek(10, true));
  const [, approx] = reduce(S.playing(episodeA), E.seek(10, false));
  assert.equal(exact.find((e) => e.type === "seekTo").precise, true);
  assert.equal(approx.find((e) => e.type === "seekTo").precise, false);
});

/* ---------- purity ---------- */

test("reduce never mutates the state it is given", () => {
  const playing = S.playing(episodeA);
  const snapshot = JSON.parse(JSON.stringify(playing));
  reduce(playing, E.skipToNext(episodeB));
  reduce(playing, E.interruptionBegan());
  reduce(playing, E.seek(500, true));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(playing)), snapshot);
});

test("an unknown event is ignored with telemetry rather than throwing", () => {
  const playing = S.playing(episodeA);
  const [state, effects] = reduce(playing, { type: "notARealEvent" });
  assert.deepStrictEqual(state, playing);
  assert.ok(isTelemetry(effects[0]));
});
