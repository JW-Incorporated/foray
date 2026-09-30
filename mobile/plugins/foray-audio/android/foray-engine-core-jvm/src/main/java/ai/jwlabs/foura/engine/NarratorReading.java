package ai.jwlabs.foura.engine;

/**
 * What the synthesiser says it is doing, read by the host before every input (the core asks it
 * where the JS tape asks its narration bridge's {@code state()}). The JVM twin of
 * {@code NarratorReading} in ForayEngineCore (Engine/DeckVocabulary.swift), card A-40.
 * {@code unknown}: no synthesiser, or one that cannot say.
 */
public enum NarratorReading {
    UNKNOWN("unknown"),
    SPEAKING("speaking"),
    PAUSED("paused"),
    IDLE("idle");

    public final String token;

    NarratorReading(String token) {
        this.token = token;
    }
}
