package ai.jwlabs.foura.engine;

/**
 * A seek that arrived while its item was still loading: applied on {@code itemLoaded},
 * after the rate is set and before anything is audible (queue-state.js §seek).
 * {@code precise} is the caller's decision (seek-policy); the reducer only carries it.
 */
public record PendingSeek(double seconds, boolean precise) {}
