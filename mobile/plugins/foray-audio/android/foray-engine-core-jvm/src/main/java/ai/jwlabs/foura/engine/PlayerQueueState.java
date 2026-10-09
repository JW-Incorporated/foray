package ai.jwlabs.foura.engine;

/**
 * The player queue's state: player/queue-state.js {@code S.*}, the JVM twin of the
 * {@code PlayerQueueState} enum in ForayEngineCore (Reducer/PlayerQueueState.swift, whose
 * header carries the design notes: the ownership split, {@code interrupted} doubling as
 * paused-but-ready, the bridge phase as one state, and the single-player invariant).
 * {@link PlayerQueueStateMachine#reduce} is the transition function.
 */
public sealed interface PlayerQueueState permits PlayerQueueState.Idle, PlayerQueueState.LoadingItem,
        PlayerQueueState.Playing, PlayerQueueState.Transitioning, PlayerQueueState.Interrupted, PlayerQueueState.Ended {

    /** Nothing loaded, nothing playing: the initial state, and the state after a stop. */
    record Idle() implements PlayerQueueState {}

    /**
     * {@code target} is being prepared. {@code previous} is carried for telemetry only;
     * {@code pendingSeek} is a seek queued while loading, applied on itemLoaded.
     */
    record LoadingItem(QueueItemRef target, QueueItemRef previous, PendingSeek pendingSeek) implements PlayerQueueState {
        public LoadingItem(QueueItemRef target, QueueItemRef previous) {
            this(target, previous, null);
        }
    }

    /** {@code item} is actively playing. */
    record Playing(QueueItemRef item) implements PlayerQueueState {}

    /** The bridge TTS between {@code from} (just ended) and {@code to} (upcoming) is loading or playing. */
    record Transitioning(QueueItemRef from, QueueItemRef to) implements PlayerQueueState {}

    /**
     * Paused by an interruption or a route loss, or paused-but-ready after an interruption
     * ended without shouldResume. {@code wasPlaying}: the listener meant to be playing when it
     * began (audio audible, or a load in flight, CH3-01); a route lost mid-load records false.
     */
    record Interrupted(QueueItemRef item, boolean wasPlaying) implements PlayerQueueState {}

    /** The queue is exhausted: distinct from idle, so "never pressed play" and "played everything" differ. */
    record Ended() implements PlayerQueueState {}

    PlayerQueueState IDLE = new Idle();
    PlayerQueueState ENDED = new Ended();
}
