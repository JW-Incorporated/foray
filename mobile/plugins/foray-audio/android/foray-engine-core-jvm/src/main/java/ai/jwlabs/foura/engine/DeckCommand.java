package ai.jwlabs.foura.engine;

/**
 * What the core asks ONE deck to do (docs/native-engine-plan.md §4.2-§4.3): the JVM twin
 * of {@code DeckCommand} in ForayEngineCore (Engine/DeckVocabulary.swift, NE-14s). The
 * ExoPlayer deck (A-25) carries these out behind its DeckDriving seam and reports back
 * {@link DeckEvent}s. The deck DOES NOT DECIDE: every event is an observation, and what it
 * means is {@link EngineCore}'s ruling.
 *
 * <p>{@code prepare} (A-40) is the standby deck's warm load: the next Foray segment at its
 * in-point, while this one is still audible. An episode never prepares, and a single deck
 * ignores it (it never opens the prefetch window that asks for one).
 */
public sealed interface DeckCommand permits DeckCommand.Load, DeckCommand.Play, DeckCommand.Pause, DeckCommand.Seek,
        DeckCommand.SetRate, DeckCommand.SetOutPoint, DeckCommand.Unload, DeckCommand.Prepare {

    /**
     * Attach the item's audio and run the readiness-gated pipeline to {@code startSec}. The
     * deck answers {@code ready} or {@code failed} / {@code deadlineExceeded} for THIS token.
     * {@code url} is null only for an item with no audio of its own, which the deck reports
     * as a failed load. {@code preciseTiming}: a bounded item (a segment) seeks exactly.
     *
     * <p>{@code deadlineClass} (A-60, NE-38) is which P-13 deadline the load runs under: the
     * core names it from the item ({@link DeckDeadlineClass#of}), the deck maps it to seconds.
     * The five-argument form is a {@code CLIP}, whose deadline is the one every load had before.
     */
    record Load(int token, String itemId, String url, double startSec, boolean preciseTiming, DeckDeadlineClass deadlineClass)
            implements DeckCommand {
        public Load {
            if (deadlineClass == null) deadlineClass = DeckDeadlineClass.CLIP;
        }

        public Load(int token, String itemId, String url, double startSec, boolean preciseTiming) {
            this(token, itemId, url, startSec, preciseTiming, DeckDeadlineClass.CLIP);
        }
    }

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

    /**
     * The deck said its boundary is the prefetch lead away ({@code prepareWindow}): warm the item
     * that boundary will advance to, at its in-point, on the STANDBY deck (A-40's deck pair). It
     * plays nothing and reports only {@code prepared} with the next load of that item.
     * {@code deadlineClass} as on {@link Load}: the standby's warm load runs under the same
     * deadline the item's own load would (A-60, NE-38).
     */
    record Prepare(String itemId, String url, double startSec, DeckDeadlineClass deadlineClass) implements DeckCommand {
        public Prepare {
            if (deadlineClass == null) deadlineClass = DeckDeadlineClass.CLIP;
        }

        public Prepare(String itemId, String url, double startSec) {
            this(itemId, url, startSec, DeckDeadlineClass.CLIP);
        }
    }

    DeckCommand PLAY = new Play();
    DeckCommand PAUSE = new Pause();
    DeckCommand UNLOAD = new Unload();
}
