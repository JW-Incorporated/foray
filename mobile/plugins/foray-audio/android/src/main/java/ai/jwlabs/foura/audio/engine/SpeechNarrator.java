package ai.jwlabs.foura.audio.engine;

import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.EngineInput;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.SpeechRules;
import ai.jwlabs.foura.engine.Vocabulary;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/**
 * THE ENGINE'S ONE SYNTHESISER on Android (card A-41, docs/plans/android-assessment.md §5.5): the
 * JVM twin of the iOS {@code SpeechNarrator} (ForayAudioPlugin/Engine/SpeechNarrator.swift, NE-33).
 * It speaks the voice picker's audition and every line of a Foray's narration the core asks for:
 * a spoken bridge, and a RENDERED line's §14 fallback (its file failed or missed its deadline, so
 * its script is read instead). A rendered line whose file plays is never here: it is an ordinary
 * file on the deck. So {@code TextToSpeech} is a seam BEHIND the engine, used only when there is no
 * file to play.
 *
 * <p>It owns the bookkeeping (which line is current, what to report); an {@link Output} only
 * renders. The production output is {@link TtsOutput} (Android {@code TextToSpeech}); the tests
 * hand a fake, so this class is plain Java.
 *
 * <h2>WHICH VOICE, AND HOW A HARD TERM IS SAID</h2>
 *
 * {@link SpeechRules} (the JVM core, the parity families {@code default-voice} and {@code lexicon}):
 * the requested voice, else the DEFAULT RULE (Samantha's best installed tier), and only with no
 * Samantha installed the synthesiser's own pick. A requested voice that is not installed is spoken
 * in the fallback and reported ({@code started(voiceFallback: true)}). The bundled lexicon
 * ({@link SpeechLexicon}) marks each hard term with its IPA as the legacy lane's Android SSML does
 * (foray-tts.js {@code buildAndroidSsml}); Android documents no phoneme attribute, so whether the
 * engine honours it is the device's to say.
 *
 * <h2>WHAT IT REPORTS</h2>
 * <pre>
 *   speak(seq)   -> started(seq, voiceFallback) at once (the line is accepted); failed(seq) for an
 *                   empty line or a synthesiser that could not start; later finished(seq) when the
 *                   line ran out, or finished(seq) with a {@code speaker kind=line-failed} row when
 *                   the output failed mid-line (mobile-native-3: a failed line advances).
 *   pause(seq)   -> nothing (the core froze the line's clock itself).
 *   resume(seq)  -> resumed(seq, continued) when the line goes on from the word it stopped at,
 *                   resumed(seq, fromStart) when it is re-spoken from its first word (ANDROID HAS NO
 *                   PAUSE: the legacy plugin's L-05 finding), or refused.
 *   stop(seq)    -> cancelled(seq). A stop is NEVER a finish (L-05).
 *   discard(seq) -> nothing: the line is dropped silently.
 * </pre>
 * A line replaced by a newer one ends SILENTLY: only the line in flight reports.
 *
 * <h2>THE SESSION</h2>
 *
 * It never requests audio focus or touches the session: every audible start ({@code speak},
 * {@code narrate(speak)}, {@code narrate(resume)}) checks the session answer first, like the deck's
 * play; not active means the core's audible-start invariant was broken, which writes a
 * {@code fault kind=implicit-activation at=speaker} row (and still speaks: silence would hide it).
 *
 * <p>NOT THREAD-SAFE, BY DESIGN: every call, and every {@link Output} end, is on the host's looper.
 */
public final class SpeechNarrator implements EngineSeams.Speaking {

    /** How a line ended, as the output saw it. */
    public enum End {
        FINISHED("finished"),
        CANCELLED("cancelled"),
        FAILED("failed");

        public final String token;

        End(String token) {
            this.token = token;
        }
    }

    /** How a held line went on. */
    public enum Resumed {
        /** From the word it stopped at: the line's clock continues. */
        CONTINUED,
        /** From its first word: the line's clock restarts. */
        FROM_START,
        /** It could not go on. */
        REFUSED
    }

    /**
     * One line, as the narrator hands it to an output: plain values, so a fake output can read the
     * decision without a voice installed. {@code ssml} is the marked-up text, or null for none;
     * {@code voiceId} null leaves the synthesiser's own voice.
     */
    public record Line(String text, String ssml, String voiceId, float rate) {}

    /** Where a line is heard. Every call and every end is on the host's thread. */
    public interface Output {
        /** The end of line {@code id}; an output may report a line the narrator already left. */
        void setOnEnd(EndListener listener);

        /** The synthesiser can speak now ({@code TextToSpeech}'s init answered success). */
        boolean ready();

        /** The synthesiser will never speak (its init failed). */
        boolean failed();

        /**
         * The installed voices a line may be spoken in, read at each line; {@code requested} (the
         * voice asked for, or null) stays eligible even where the output would otherwise leave it out.
         */
        List<SpeechRules.VoiceOption> installedVoices(String requested);

        /** The language a line is spoken in when no voice decides it. */
        String language();

        /** The name of the voice the synthesiser would use by itself, or null. */
        String systemVoiceName();

        /** Speak {@code line} as line {@code id}, silencing any line in flight. False: refused at once. */
        boolean start(Line line, int id);

        /** Hold the line in flight. False when there was nothing to hold. */
        boolean pause();

        /** Continue the held line. */
        Resumed resume();

        /** Silence the line in flight. Reports nothing. */
        void stop();

        /** Silence everything and let the synthesiser go. */
        void release();
    }

    @FunctionalInterface
    public interface EndListener {
        void ended(int id, End end);
    }

    /** What the narrator needs from the engine. */
    public static final class Config {
        /** The engine's session answer (the service's session exists), read at every audible start. */
        public BooleanSupplier sessionIsActive = () -> true;
        /** Where the narrator's rows go: the engine's store. */
        public Consumer<EngineCommand.DiagEntry> diag = entry -> {};
        /** The pronunciation lexicon. */
        public List<SpeechRules.LexiconEntry> lexicon = Collections.emptyList();
    }

    private enum OwnerKind { AUDITION, NARRATION }

    private record Current(int id, OwnerKind kind, int seq) {}

    private final Config config;
    private final Output output;
    private EngineSeams.SpeakingListener listener;
    /** The line in flight: the only one whose end is reported. */
    private Current current;
    private int nextLineId;
    private boolean paused;
    /** What the last line was handed to the output (the tests read it). */
    private Line lastLine;

    public SpeechNarrator(Output output, Config config) {
        this.output = Objects.requireNonNull(output, "output");
        this.config = Objects.requireNonNull(config, "config");
        output.setOnEnd(this::ended);
    }

    /** The last line handed to the output, or null. */
    public Line lastLine() {
        return lastLine;
    }

    @Override
    public void setListener(EngineSeams.SpeakingListener listener) {
        this.listener = listener;
    }

    // ---- the audition

    @Override
    public void speak(String text, String voiceId) {
        guardSession();
        if (text == null || text.isEmpty() || !begin(text, voiceId, 1, OwnerKind.AUDITION, 0)) {
            EngineSeams.SpeakingListener l = listener;
            if (l != null) l.onAuditionEnded(End.FAILED.token);
        }
    }

    @Override
    public void stopSpeaking() {
        Current line = current;
        current = null;
        paused = false;
        output.stop();
        if (line != null) report(line, End.CANCELLED);
    }

    // ---- the narration

    @Override
    public void narrate(EngineCommand.NarrationCommand command) {
        switch (command) {
            case EngineCommand.NarrationCommand.Speak s -> {
                if (s.text() == null || s.text().isEmpty()) {
                    event(new EngineInput.NarratorEvent.Failed(s.seq(), "empty text"));
                    return;
                }
                if (output.failed()) {
                    event(new EngineInput.NarratorEvent.Failed(s.seq(), "no-synthesiser"));
                    return;
                }
                guardSession();
                boolean[] fellBack = new boolean[1];
                if (!begin(s.text(), s.voiceId(), s.utteranceRate(), OwnerKind.NARRATION, s.seq(), fellBack)) {
                    event(new EngineInput.NarratorEvent.Failed(s.seq(), "synthesiser-refused"));
                    return;
                }
                event(new EngineInput.NarratorEvent.Started(s.seq(), fellBack[0]));
            }
            case EngineCommand.NarrationCommand.Pause p -> {
                if (!isCurrent(p.seq()) || paused) return;
                if (output.pause()) paused = true;
            }
            case EngineCommand.NarrationCommand.Resume r -> {
                if (!isCurrent(r.seq())) {
                    event(new EngineInput.NarratorEvent.Resumed(r.seq(), new EngineInput.NarrationResumeAnswer.Refused("not-held")));
                    return;
                }
                if (!paused) {
                    event(new EngineInput.NarratorEvent.Resumed(r.seq(), EngineInput.NarrationResumeAnswer.CONTINUED));
                    return;
                }
                guardSession();
                Resumed how = output.resume();
                if (how == Resumed.REFUSED) {
                    event(new EngineInput.NarratorEvent.Resumed(r.seq(), new EngineInput.NarrationResumeAnswer.Refused("output-refused")));
                    return;
                }
                paused = false;
                event(new EngineInput.NarratorEvent.Resumed(r.seq(),
                        how == Resumed.FROM_START ? EngineInput.NarrationResumeAnswer.FROM_START : EngineInput.NarrationResumeAnswer.CONTINUED));
            }
            case EngineCommand.NarrationCommand.Stop st -> {
                if (isCurrent(st.seq())) {
                    current = null;
                    paused = false;
                    output.stop();
                }
                // A stop is never a finish (L-05), whatever the line was doing.
                event(new EngineInput.NarratorEvent.Cancelled(st.seq()));
            }
            case EngineCommand.NarrationCommand.Discard d -> {
                if (!isCurrent(d.seq())) return;
                current = null;
                paused = false;
                output.stop();
            }
        }
    }

    @Override
    public void release() {
        current = null;
        paused = false;
        output.release();
    }

    // ---- internals

    private boolean isCurrent(int seq) {
        Current line = current;
        return line != null && line.kind() == OwnerKind.NARRATION && line.seq() == seq;
    }

    private boolean begin(String text, String voiceId, double multiplier, OwnerKind kind, int seq) {
        return begin(text, voiceId, multiplier, kind, seq, new boolean[1]);
    }

    /**
     * Resolve the voice and the hard terms, make the line current (BEFORE the old one is silenced, so
     * the old one's end finds itself superseded), and hand it to the output.
     */
    private boolean begin(String text, String voiceId, double multiplier, OwnerKind kind, int seq, boolean[] fellBack) {
        String language = output.language();
        SpeechRules.VoiceResolution resolution = SpeechRules.narrationVoice(output.installedVoices(voiceId), voiceId, language,
                output.systemVoiceName());
        fellBack[0] = resolution.didFallBack();
        if (resolution.didFallBack()) {
            config.diag.accept(new EngineCommand.DiagEntry("speaker", Arrays.asList(
                    JsonNode.member("kind", JsonNode.str("voice-fallback")),
                    JsonNode.member("chosen", JsonNode.bool(resolution.voice() != null)))));
        }
        nextLineId += 1;
        Line line = new Line(text, SpeechRules.androidSsml(text, config.lexicon),
                resolution.voice() == null ? null : resolution.voice().identifier(), (float) multiplier);
        current = new Current(nextLineId, kind, seq);
        paused = false;
        lastLine = line;
        if (!output.start(line, nextLineId)) {
            current = null;
            config.diag.accept(new EngineCommand.DiagEntry("speaker", Collections.singletonList(
                    JsonNode.member("kind", JsonNode.str("start-refused")))));
            return false;
        }
        return true;
    }

    private void ended(int id, End end) {
        Current line = current;
        if (line == null || line.id() != id) return;
        current = null;
        paused = false;
        report(line, end);
    }

    private void report(Current line, End end) {
        if (line.kind() == OwnerKind.AUDITION) {
            EngineSeams.SpeakingListener l = listener;
            if (l != null) l.onAuditionEnded(end.token);
            return;
        }
        // A line the output FAILED to play is over, and advances now (mobile-native-3); a cancel
        // never advances (L-05).
        if (end == End.FAILED) {
            config.diag.accept(new EngineCommand.DiagEntry("speaker", Collections.singletonList(
                    JsonNode.member("kind", JsonNode.str("line-failed")))));
        }
        event(end == End.CANCELLED ? new EngineInput.NarratorEvent.Cancelled(line.seq()) : new EngineInput.NarratorEvent.Finished(line.seq()));
    }

    private void event(EngineInput.NarratorEvent event) {
        EngineSeams.SpeakingListener l = listener;
        if (l != null) l.onNarratorEvent(event);
    }

    private void guardSession() {
        if (config.sessionIsActive.getAsBoolean()) return;
        config.diag.accept(new EngineCommand.DiagEntry("fault", Arrays.asList(
                JsonNode.member("kind", JsonNode.str(Vocabulary.FaultKind.IMPLICIT_ACTIVATION.token)),
                JsonNode.member("at", JsonNode.str("speaker")))));
    }
}
