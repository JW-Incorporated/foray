package ai.jwlabs.foura.engine;

/**
 * What the reducer is told: player/queue-state.js {@code E.*}, the JVM twin of
 * {@code PlayerEvent} in ForayEngineCore. Events that need a target item carry a
 * {@link QueueItemRef} supplied by the caller (the manager owns "what is next").
 */
public sealed interface PlayerEvent permits PlayerEvent.Play, PlayerEvent.ItemLoaded, PlayerEvent.ItemEnded,
        PlayerEvent.InterruptionBegan, PlayerEvent.InterruptionEnded, PlayerEvent.RouteChanged, PlayerEvent.SkipToNext,
        PlayerEvent.SkipToPrevious, PlayerEvent.Stop, PlayerEvent.Error, PlayerEvent.Seek, PlayerEvent.ElementResumed {

    /** Play a specific item (a first play, or a manual resume after interrupted / ended). */
    record Play(QueueItemRef item) implements PlayerEvent {}

    /** The item being loaded (or the bridge asset) is ready to produce audio. */
    record ItemLoaded() implements PlayerEvent {}

    /** The playing item finished. {@code next} null: the queue is exhausted; {@code bridged}: a transition TTS plays first. */
    record ItemEnded(QueueItemRef next, boolean bridged) implements PlayerEvent {}

    record InterruptionBegan() implements PlayerEvent {}

    record InterruptionEnded(boolean shouldResume) implements PlayerEvent {}

    /** {@code oldDeviceUnavailable}: the output route disappeared ("I turned the car off"), so pause. */
    record RouteChanged(boolean oldDeviceUnavailable) implements PlayerEvent {}

    /** {@code item} null: the queue is exhausted. */
    record SkipToNext(QueueItemRef item) implements PlayerEvent {}

    /** {@code item} null: no previous item, restart the current one in place. */
    record SkipToPrevious(QueueItemRef item) implements PlayerEvent {}

    record Stop() implements PlayerEvent {}

    record Error(String message) implements PlayerEvent {}

    /** Seek the current source to an absolute position; {@code precise} is the caller's (seek-policy). */
    record Seek(double seconds, boolean precise) implements PlayerEvent {}

    /** An OBSERVATION: the player is producing audio for the item held as interrupted. Never a request. */
    record ElementResumed() implements PlayerEvent {}

    PlayerEvent ITEM_LOADED = new ItemLoaded();
    PlayerEvent INTERRUPTION_BEGAN = new InterruptionBegan();
    PlayerEvent STOP = new Stop();
    PlayerEvent ELEMENT_RESUMED = new ElementResumed();
}
