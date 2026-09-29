package ai.jwlabs.foura.engine;

import java.util.Objects;

/**
 * What the deck says RIGHT NOW, read synchronously by the host before every input (the
 * player's position, the item's duration, whether it is audible, whether it reached its
 * end). The JVM twin of {@code DeckReading} in ForayEngineCore (Engine/DeckVocabulary.swift).
 *
 * <p>WHY A READING AND NOT STATE THE CORE KEEPS. The JS manager asks its element at the
 * moment it decides; a position the core remembered from the last periodic observation
 * would be up to a tick stale at every pause. The reading is an input like any other, so
 * the core stays pure.
 *
 * <p>A small mutable value: {@link EngineCore} takes a {@link #copy} at the top of every
 * turn and never keeps the caller's instance.
 */
public final class DeckReading {
    /** The playhead in the source's seconds; null while nothing is loaded. */
    public Double positionSec;
    public Double durationSec;
    /** Sound is coming out. */
    public boolean audible;
    /** The item ran out and the deck is parked on its end. */
    public boolean ended;

    public DeckReading(Double positionSec, Double durationSec, boolean audible, boolean ended) {
        this.positionSec = positionSec;
        this.durationSec = durationSec;
        this.audible = audible;
        this.ended = ended;
    }

    /** Nothing loaded. */
    public static DeckReading idle() {
        return new DeckReading(null, null, false, false);
    }

    public DeckReading copy() {
        return new DeckReading(positionSec, durationSec, audible, ended);
    }

    @Override
    public boolean equals(Object other) {
        return other instanceof DeckReading r && Objects.equals(r.positionSec, positionSec)
                && Objects.equals(r.durationSec, durationSec) && r.audible == audible && r.ended == ended;
    }

    @Override
    public int hashCode() {
        return Objects.hash(positionSec, durationSec, audible, ended);
    }

    @Override
    public String toString() {
        return "DeckReading[position=" + positionSec + ", duration=" + durationSec + ", audible=" + audible + ", ended=" + ended + "]";
    }
}
