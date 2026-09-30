package ai.jwlabs.foura.engine;

import java.util.Objects;

/**
 * The moment an input arrives: both clocks (wall for rows the page reads, monotonic for
 * every duration, because the wall clock can jump under a drive), the deck's reading, and
 * how much background time the system has left. The JVM twin of {@code EngineNow} in
 * ForayEngineCore (Engine/DeckVocabulary.swift).
 *
 * <p>{@code bgRemainingMs} is null in the foreground. The core decides nothing on it: it
 * only goes into the {@code remote}, {@code resume} and {@code cold-play} rows. (On
 * Android the service's foreground state stands in for iOS's background budget; A-26
 * decides what the host reports here.) {@code narrator}: the synthesiser's own word (A-40
 * ported the narrating overlay's rules; {@code unknown} until a host has one).
 */
public record EngineNow(double wallMs, double monoMs, DeckReading deck, Double bgRemainingMs, NarratorReading narrator) {
    public EngineNow {
        Objects.requireNonNull(deck, "deck");
        Objects.requireNonNull(narrator, "narrator");
    }

    public EngineNow(double wallMs, double monoMs, DeckReading deck, Double bgRemainingMs) {
        this(wallMs, monoMs, deck, bgRemainingMs, NarratorReading.UNKNOWN);
    }

    public EngineNow(double wallMs, double monoMs, DeckReading deck) {
        this(wallMs, monoMs, deck, null, NarratorReading.UNKNOWN);
    }
}
