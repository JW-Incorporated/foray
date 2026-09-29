package ai.jwlabs.foura.engine;

/**
 * What the core asks ONE deck to do (docs/native-engine-plan.md §4.2-§4.3): the JVM twin
 * of {@code DeckCommand} in ForayEngineCore (Engine/DeckVocabulary.swift, NE-14s). The
 * ExoPlayer deck (A-25) carries these out behind its DeckDriving seam and reports back
 * {@link DeckEvent}s. The deck DOES NOT DECIDE: every event is an observation, and what it
 * means is {@link EngineCore}'s ruling.
 *
 * <p>{@code prepare} (the standby deck's warm load) arrives with the Foray tape (A-40); an
 * episode never prepares.
 */
public sealed interface DeckCommand permits DeckCommand.Load, DeckCommand.Play, DeckCommand.Pause, DeckCommand.Seek,
        DeckCommand.SetRate, DeckCommand.SetOutPoint, DeckCommand.Unload {

    /**
     * Attach the item's audio and run the readiness-gated pipeline to {@code startSec}. The
     * deck answers {@code ready} or {@code failed} / {@code deadlineExceeded} for THIS token.
     * {@code url} is null only for an item with no audio of its own, which the deck reports
     * as a failed load. {@code preciseTiming}: a bounded item (a segment) seeks exactly.
     */
    record Load(int token, String itemId, String url, double startSec, boolean preciseTiming) implements DeckCommand {}

    /**
     * Legal only after {@code ready} for the current token. The core also emits it only with
     * the audio session active (the audible-start invariant); the adapter's check is the backstop.
     */
    record Play() implements DeckCommand {}

    record Pause() implements DeckCommand {}

    /** Zero tolerance. */
    record Seek(double toSec) implements DeckCommand {}

    /** Held by the deck and re-applied on every play. */
    record SetRate(double rate) implements DeckCommand {}

    /** A bounded item's out-point in the source's seconds; null disarms. A load drops the armed one. */
    record SetOutPoint(Double sec) implements DeckCommand {}

    record Unload() implements DeckCommand {}

    DeckCommand PLAY = new Play();
    DeckCommand PAUSE = new Pause();
    DeckCommand UNLOAD = new Unload();
}
