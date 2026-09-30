package ai.jwlabs.foura.audio.engine;

/**
 * What the {@link DeckPair} needs from each of its decks beyond the {@link DeckDriving} seam (card
 * A-40, the JVM twin of the Swift {@code PairableDeck}, NE-32): whether its load is ready NOW
 * (readiness is re-asserted at the boundary, never trusted), which source it holds, the prefetch
 * window's switch, and the handover's {@code adopt-identity} step. {@link ExoDeck} conforms; the
 * plain-JVM tests drive the pair with recording fakes.
 */
public interface PairableDeck extends DeckDriving {
    /** The deck's current load reached READY (prerolled at its start) and has not failed since. */
    boolean isReady();

    /** The URL the deck holds, or null. */
    String loadedUrl();

    /**
     * Whether this deck may open the prefetch window ({@code prepareWindow}) as its boundary
     * approaches: only the playing deck of a pair that can still warm the other.
     */
    void setPrepareWindowAvailable(boolean available);

    /**
     * The handover's {@code adopt-identity} step: the standby deck's load becomes the core's load
     * {@code token}, so every later event carries the token the core is waiting on. Nothing else
     * about the load changes.
     */
    void adopt(int token);
}
