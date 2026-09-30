package ai.jwlabs.foura.audio.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.EngineInput;
import ai.jwlabs.foura.engine.JSWriter;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.SpeechRules;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.Test;

/**
 * Card A-41: the engine's synthesiser's bookkeeping, on a plain JVM (the iOS
 * SpeechNarratorTests' twin). The output is a fake, so what is pinned is what the narrator
 * decides and reports: the voice and the hard terms it hands on, the core's events for each
 * command, and that only the line in flight ever reports.
 */
public class SpeechNarratorTest {
    static final class FakeOutput implements SpeechNarrator.Output {
        SpeechNarrator.EndListener onEnd;
        boolean ready = true;
        boolean failed;
        boolean refuseStart;
        List<SpeechRules.VoiceOption> voices = new ArrayList<>();
        String systemVoice;
        SpeechNarrator.Resumed resumeAnswer = SpeechNarrator.Resumed.FROM_START;
        final List<String> calls = new ArrayList<>();
        SpeechNarrator.Line line;
        int id;

        @Override
        public void setOnEnd(SpeechNarrator.EndListener listener) {
            onEnd = listener;
        }

        @Override
        public boolean ready() {
            return ready;
        }

        @Override
        public boolean failed() {
            return failed;
        }

        @Override
        public List<SpeechRules.VoiceOption> installedVoices(String requested) {
            return voices;
        }

        @Override
        public String language() {
            return "en-US";
        }

        @Override
        public String systemVoiceName() {
            return systemVoice;
        }

        @Override
        public boolean start(SpeechNarrator.Line next, int lineId) {
            calls.add("start:" + next.text());
            if (refuseStart) return false;
            line = next;
            id = lineId;
            return true;
        }

        @Override
        public boolean pause() {
            calls.add("pause");
            return line != null;
        }

        @Override
        public SpeechNarrator.Resumed resume() {
            calls.add("resume");
            return resumeAnswer;
        }

        @Override
        public void stop() {
            calls.add("stop");
        }

        @Override
        public void release() {
            calls.add("release");
        }

        void end(SpeechNarrator.End end) {
            onEnd.ended(id, end);
        }
    }

    static final class Rig {
        final FakeOutput output = new FakeOutput();
        final List<EngineInput.NarratorEvent> events = new ArrayList<>();
        final List<String> auditions = new ArrayList<>();
        final List<String> rows = new ArrayList<>();
        boolean sessionActive = true;
        final SpeechNarrator narrator;

        Rig(List<SpeechRules.LexiconEntry> lexicon) {
            SpeechNarrator.Config config = new SpeechNarrator.Config();
            config.sessionIsActive = () -> sessionActive;
            config.diag = entry -> rows.add(entry.kind() + " " + JSWriter.stringify(new JsonNode.Obj(entry.fields())));
            config.lexicon = lexicon;
            narrator = new SpeechNarrator(output, config);
            narrator.setListener(new EngineSeams.SpeakingListener() {
                @Override
                public void onNarratorEvent(EngineInput.NarratorEvent event) {
                    events.add(event);
                }

                @Override
                public void onAuditionEnded(String end) {
                    auditions.add(end);
                }
            });
        }

        Rig() {
            this(Collections.<SpeechRules.LexiconEntry>emptyList());
        }

        void narrate(EngineCommand.NarrationCommand command) {
            narrator.narrate(command);
        }
    }

    static EngineCommand.NarrationCommand speak(int seq, String text, String voice) {
        return new EngineCommand.NarrationCommand.Speak(seq, text, voice, 1);
    }

    static SpeechRules.VoiceOption voice(String name, String language, int quality) {
        return new SpeechRules.VoiceOption(name, name, language, quality);
    }

    /**
     * A line is accepted at once ({@code started}), handed on at 1x with the synthesiser's best
     * voice, and its end is {@code finished}. TO SEE IT FAIL: report {@code started} only at the
     * output's end, or hand the line over at the listener's rate.
     */
    @Test
    public void aLineIsStartedAtOnceAndFinishedAtItsEnd() {
        Rig rig = new Rig();
        rig.output.voices = Arrays.asList(voice("en-us-x-low", "en-US", 200), voice("en-us-x-high", "en-US", 400));
        rig.narrate(speak(3, "Up next, the second story.", null));
        assertEquals(List.of(new EngineInput.NarratorEvent.Started(3, false)), rig.events);
        SpeechNarrator.Line line = rig.narrator.lastLine();
        assertEquals("Up next, the second story.", line.text());
        assertEquals("the best installed tier", "en-us-x-high", line.voiceId());
        assertEquals(1f, line.rate(), 0);
        assertNull("no hard term, no markup", line.ssml());
        rig.output.end(SpeechNarrator.End.FINISHED);
        assertEquals(new EngineInput.NarratorEvent.Finished(3), rig.events.get(1));
    }

    /**
     * A voice asked for and installed is the one used; one not installed falls back to the best tier
     * and is reported as a fallback (a row, and {@code started(voiceFallback: true)}). TO SEE IT
     * FAIL: ignore the requested voice, or drop the fallback flag.
     */
    @Test
    public void aRequestedVoiceIsUsedOrReportedAsAFallback() {
        Rig rig = new Rig();
        rig.output.voices = Arrays.asList(voice("en-gb-x-a", "en-GB", 300), voice("en-us-x-b", "en-US", 400));
        rig.narrate(speak(1, "One.", "en-gb-x-a"));
        assertEquals("en-gb-x-a", rig.narrator.lastLine().voiceId());
        assertEquals(new EngineInput.NarratorEvent.Started(1, false), rig.events.get(0));
        rig.narrate(speak(2, "Two.", "not-installed"));
        assertEquals("en-us-x-b", rig.narrator.lastLine().voiceId());
        assertEquals(new EngineInput.NarratorEvent.Started(2, true), rig.events.get(1));
        assertTrue(String.join("\n", rig.rows), rig.rows.contains("speaker {\"kind\":\"voice-fallback\",\"chosen\":true}"));
    }

    /**
     * A hard term with an authored IPA is marked up as the legacy lane's Android SSML does; a term
     * with none is plain text. TO SEE IT FAIL: hand the plain text over with a lexicon hit.
     */
    @Test
    public void aHardTermIsMarkedUpWithItsIpa() {
        Rig rig = new Rig(Arrays.asList(new SpeechRules.LexiconEntry("sake", "ˈsɑːkeɪ"),
                new SpeechRules.LexiconEntry("koji", null)));
        rig.narrate(speak(1, "Koji & sake.", null));
        assertEquals("<speak>Koji &amp; <phoneme alphabet=\"ipa\" ph=\"ˈsɑːkeɪ\">sake</phoneme>.</speak>",
                rig.narrator.lastLine().ssml());
        assertEquals("Koji & sake.", rig.narrator.lastLine().text());
    }

    /**
     * Only the line in flight reports: a line replaced by a newer one ends silently, and a stop is
     * always {@code cancelled}, never a finish (L-05). TO SEE IT FAIL: report the old line's end, or
     * answer a stop with {@code finished}.
     */
    @Test
    public void onlyTheLineInFlightReportsAndAStopIsNeverAFinish() {
        Rig rig = new Rig();
        rig.narrate(speak(1, "First.", null));
        int first = rig.output.id;
        rig.narrate(speak(2, "Second.", null));
        rig.output.onEnd.ended(first, SpeechNarrator.End.FINISHED);
        assertEquals("the replaced line's end is silent", 2, rig.events.size());
        rig.narrate(new EngineCommand.NarrationCommand.Stop(2));
        assertEquals(new EngineInput.NarratorEvent.Cancelled(2), rig.events.get(2));
        rig.output.end(SpeechNarrator.End.FINISHED);
        assertEquals("a stopped line's late end is silent too", 3, rig.events.size());
        rig.narrate(new EngineCommand.NarrationCommand.Stop(9));
        assertEquals("a stop of a line not in flight is still cancelled", new EngineInput.NarratorEvent.Cancelled(9), rig.events.get(3));
    }

    /**
     * ANDROID HAS NO PAUSE: a pause holds the line, and a resume answers how it went on
     * ({@code fromStart} when the output re-speaks it, {@code continued} from a word); a resume of a
     * line not held is refused. TO SEE IT FAIL: answer every resume {@code continued}.
     */
    @Test
    public void aResumeSaysHowTheLineWentOn() {
        Rig rig = new Rig();
        rig.narrate(speak(4, "A line to hold.", null));
        rig.narrate(new EngineCommand.NarrationCommand.Pause(4));
        rig.narrate(new EngineCommand.NarrationCommand.Resume(4));
        assertEquals(new EngineInput.NarratorEvent.Resumed(4, EngineInput.NarrationResumeAnswer.FROM_START), rig.events.get(1));
        rig.narrate(new EngineCommand.NarrationCommand.Pause(4));
        rig.output.resumeAnswer = SpeechNarrator.Resumed.CONTINUED;
        rig.narrate(new EngineCommand.NarrationCommand.Resume(4));
        assertEquals(new EngineInput.NarratorEvent.Resumed(4, EngineInput.NarrationResumeAnswer.CONTINUED), rig.events.get(2));
        rig.narrate(new EngineCommand.NarrationCommand.Resume(4));
        assertEquals("a line not held continues as it is", new EngineInput.NarratorEvent.Resumed(4, EngineInput.NarrationResumeAnswer.CONTINUED),
                rig.events.get(3));
        rig.narrate(new EngineCommand.NarrationCommand.Resume(8));
        assertEquals(new EngineInput.NarratorEvent.Resumed(8, new EngineInput.NarrationResumeAnswer.Refused("not-held")), rig.events.get(4));
        assertEquals(List.of("start:A line to hold.", "pause", "resume", "pause", "resume"), rig.output.calls);
    }

    /**
     * A failure is always an answer the core can act on: an empty line and a synthesiser that
     * failed to start are {@code failed} at once (the core steps over the line); an output that
     * fails MID-line is over and advances ({@code finished}, with a row; mobile-native-3). TO SEE IT
     * FAIL: leave a failed line without an answer (the Foray waits on silence).
     */
    @Test
    public void everyFailureIsAnAnswer() {
        Rig rig = new Rig();
        rig.narrate(speak(1, "", null));
        assertEquals(new EngineInput.NarratorEvent.Failed(1, "empty text"), rig.events.get(0));
        rig.output.failed = true;
        rig.narrate(speak(2, "No engine.", null));
        assertEquals(new EngineInput.NarratorEvent.Failed(2, "no-synthesiser"), rig.events.get(1));
        // A-41 review: the refusal is said at the line (the emulator's (k) reads it as "skipped").
        String rows = String.join(" | ", rig.rows);
        assertTrue(rows, rig.rows.contains("speaker {\"kind\":\"line-refused\",\"why\":\"empty-text\"}"));
        assertTrue(rows, rig.rows.contains("speaker {\"kind\":\"line-refused\",\"why\":\"no-synthesiser\"}"));
        rig.output.failed = false;
        rig.output.refuseStart = true;
        rig.narrate(speak(3, "Refused.", null));
        assertEquals(new EngineInput.NarratorEvent.Failed(3, "synthesiser-refused"), rig.events.get(2));
        rig.output.refuseStart = false;
        rig.narrate(speak(4, "Fails mid-line.", null));
        rig.output.end(SpeechNarrator.End.FAILED);
        assertEquals(new EngineInput.NarratorEvent.Finished(4), rig.events.get(4));
        assertTrue(rig.rows.contains("speaker {\"kind\":\"line-failed\"}"));
    }

    /**
     * The audible-start invariant: a line spoken with no session writes a fault row (and still
     * speaks: silence would hide the bug). The audition's end goes to the listener, not the core.
     * TO SEE IT FAIL: drop the session check, or feed the audition's end to the core.
     */
    @Test
    public void aLineWithNoSessionIsAFaultAndTheAuditionEndsToTheListener() {
        Rig rig = new Rig();
        rig.sessionActive = false;
        rig.narrate(speak(1, "No session.", null));
        assertTrue(rig.rows.contains("fault {\"kind\":\"implicit-activation\",\"at\":\"speaker\"}"));
        assertEquals(new EngineInput.NarratorEvent.Started(1, false), rig.events.get(0));
        rig.sessionActive = true;
        rig.narrator.speak("Hear this voice.", null);
        assertEquals(1, rig.events.size());
        rig.output.end(SpeechNarrator.End.FINISHED);
        assertEquals(List.of("finished"), rig.auditions);
        assertEquals("the audition's end is not the core's", 1, rig.events.size());
        rig.narrator.speak("", null);
        assertEquals(List.of("finished", "failed"), rig.auditions);
        rig.narrator.release();
        assertFalse(rig.output.calls.isEmpty());
        assertEquals("release", rig.output.calls.get(rig.output.calls.size() - 1));
    }
}
