package ai.jwlabs.foura.audio.engine;

import ai.jwlabs.foura.engine.DeckCommand;
import ai.jwlabs.foura.engine.DeckEvent;
import ai.jwlabs.foura.engine.DeckReading;

/**
 * One player the core drives with {@link DeckCommand}s and hears from as {@link DeckEvent}s
 * (the core's vocabulary, foray-engine-core-jvm). The JVM twin of the Swift {@code DeckDriving}
 * protocol (ForayAudioPlugin/Engine/Seams.swift, NE-15h), card A-25
 * (docs/plans/android-assessment.md §5.4).
 *
 * <p>The host (A-26's service) never touches Media3 for a deck: it sends commands through
 * this seam and feeds every event back into {@code EngineCore}. {@link ExoDeck} is the real
 * conformer; a test can stand a recording fake behind the same seam.
 *
 * <p>ONE THREAD. The engine is confined to one looper (the main one in the app, plan §4.2), and
 * so is a deck: every method here is called on it, and every event is delivered on it.
 */
public interface DeckDriving {
    /** Where the deck's observations go, on the deck's looper. */
    interface Listener {
        void onEvent(DeckEvent event);
    }

    /** The host sets it at start and clears it (null) at teardown. */
    void setListener(Listener listener);

    /**
     * What the deck says RIGHT NOW (playhead, duration, audible, ended), read by the host
     * before every input: the core's {@code EngineNow.deck}.
     */
    DeckReading reading();

    void send(DeckCommand command);

    /**
     * Stop observing for good: every listener, timer and pending callback is dropped, and no
     * event is delivered after this. Every later command is ignored.
     */
    void invalidate();
}
