package ai.jwlabs.foura.engine;

/**
 * Side effects the reducer wants performed: player/queue-state.js {@code F.*}, the JVM
 * twin of {@code PlayerEffect} in ForayEngineCore. The caller maps each onto the real
 * player; the reducer itself does no I/O.
 */
public sealed interface PlayerEffect permits PlayerEffect.LoadItem, PlayerEffect.StartPlayback, PlayerEffect.PausePlayback,
        PlayerEffect.SavePosition, PlayerEffect.PlayTransitionTTS, PlayerEffect.ResetRateForTTS, PlayerEffect.RestoreRate,
        PlayerEffect.EmitTelemetry, PlayerEffect.SeekTo, PlayerEffect.SeekRejected, PlayerEffect.SetOutPoint {

    record LoadItem(QueueItemRef item) implements PlayerEffect {}

    record StartPlayback() implements PlayerEffect {}

    record PausePlayback() implements PlayerEffect {}

    /** Persist the current item and position (on every pause, interruption, route change, skip and stop). */
    record SavePosition() implements PlayerEffect {}

    /** Play the local transition TTS bridging the item that ended into the next. */
    record PlayTransitionTTS() implements PlayerEffect {}

    /** Force the rate to 1.0 before a TTS item becomes audible. */
    record ResetRateForTTS() implements PlayerEffect {}

    /** Restore the show's rate after leaving a TTS item. */
    record RestoreRate() implements PlayerEffect {}

    /** Telemetry, byte-identical to the JS reducer's. */
    record EmitTelemetry(String message) implements PlayerEffect {}

    /** Seek the current source to {@code seconds}, with the caller's precision. */
    record SeekTo(double seconds, boolean precise) implements PlayerEffect {}

    /** A seek that cannot apply in the current state; the text is telemetry. */
    record SeekRejected(String reason) implements PlayerEffect {}

    /**
     * Arm the backend's out-point watch at {@code seconds} on the source's timeline: only
     * for a bounded item, only on itemLoaded (after the in-point landed, before anything
     * is audible). A load drops any armed boundary, so there is no clear.
     */
    record SetOutPoint(double seconds) implements PlayerEffect {}

    PlayerEffect START_PLAYBACK = new StartPlayback();
    PlayerEffect PAUSE_PLAYBACK = new PausePlayback();
    PlayerEffect SAVE_POSITION = new SavePosition();
    PlayerEffect PLAY_TRANSITION_TTS = new PlayTransitionTTS();
    PlayerEffect RESET_RATE_FOR_TTS = new ResetRateForTTS();
    PlayerEffect RESTORE_RATE = new RestoreRate();
}
