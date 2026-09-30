package ai.jwlabs.foura.engine;

/**
 * Which P-13 load deadline a load runs under (card A-60, the JVM twin of NE-38's
 * {@code DeckDeadlineClass} in ForayEngineCore, Engine/DeckVocabulary.swift;
 * docs/plans/android-assessment.md §5.7, docs/android-emulator-measurements.md §16).
 *
 * <p>The CORE names the class, because only the core knows what the item is; the DECK maps it
 * to seconds, because the seconds are a property of Media3 and the network
 * ({@code ExoDeck.DEFAULT_LOAD_DEADLINE_SEC}, {@code ExoDeck.DEFAULT_LINE_LOAD_DEADLINE_SEC}).
 * The class also rides on the deck's {@code attach}, {@code reuse}, {@code ready},
 * {@code deadline} and no-url {@code failed} rows ({@code class=}), so NE-38e's {@code P13-clip}
 * and {@code P13-line} verdicts (tools/mobile/engine-report.mjs) split time-to-ready by it.
 *
 * <p>WHY A LINE HAS ITS OWN. A rendered narration line (a {@code tts} item with a file) is a
 * small file (about 160 KB), and one that fails is read aloud from its script by
 * {@code TextToSpeech}, so waiting a clip's 20 s for it only lengthens a silence in the car. A
 * clip is a slice of a large episode on a third-party host.
 */
public enum DeckDeadlineClass {
    /** An episode or a Foray clip: anything that is not a narration line. */
    CLIP("clip"),
    /** A rendered narration line ({@code kind: "tts"}) played from its file. */
    LINE("line");

    /** The row token ({@code class=clip|line}), the Swift raw value. */
    public final String token;

    DeckDeadlineClass(String token) {
        this.token = token;
    }

    /** The class of the load of {@code item}: a narration item is a line, everything else a clip. A spoken line never reaches a deck. */
    public static DeckDeadlineClass of(EngineItem item) {
        return item != null && item.kind == PlayerItemKind.TTS ? LINE : CLIP;
    }
}
