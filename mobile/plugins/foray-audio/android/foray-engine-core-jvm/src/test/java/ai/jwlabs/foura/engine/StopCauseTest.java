package ai.jwlabs.foura.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.engine.EngineCommand.InterludeCommand;
import ai.jwlabs.foura.engine.EngineCommand.NarrationCommand;
import ai.jwlabs.foura.engine.EngineCoreTest.Host;
import ai.jwlabs.foura.engine.EngineInput.QueueInput;
import ai.jwlabs.foura.engine.Vocabulary.Source;
import ai.jwlabs.foura.engine.Vocabulary.StopCause;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.EnumSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.junit.Test;

/**
 * Card A-67, THE D-5 STOP-CAUSE AUDIT on the JVM core (mirrors NE-40's StopCauseTests,
 * ForayEngineCore/Tests/ForayEngineCoreTests/StopCauseTests.swift, path for path): every path that
 * stops the listener's audio writes a {@code stop} row with a named cause BEFORE the command that
 * silences anything, so a Copy pasted after a drive says why the audio stopped, and
 * {@code stop cause=unknown} never appears.
 *
 * <p>WHERE A STOP COMES FROM. The host's adapters decide nothing: each reports what it saw as an
 * input, and the core's {@code stopRow} is the one place a cause is written. So the audit is a
 * table of every input that can stop audio. Here they are named by the core's own adapters; the
 * Android shell's (ExoPlayer's errors, focus, BECOMING_NOISY, the device callback, onTaskRemoved,
 * the service's stop, Doze, the line deadline) are audited on top of this table by the Robolectric
 * {@code StopPathAuditTest} in foray-audio, which feeds the real host what each Android adapter
 * feeds it.
 *
 * <p>Every {@code stopRow(} call site in EngineCore.java is named by a {@code site} below;
 * tools/mobile/shell-invariants.test.mjs (A-67) reads both files and is red when a call site has no
 * row here, so a new stop path cannot land without its audit entry.
 *
 * <p>TWO CAUSES ARE NEVER EMITTED, on purpose ({@code reserved}): {@code seam-timeout} (a seam's next
 * clip that never becomes ready is its load's P-13 deadline, {@code load-deadline}) and
 * {@code unknown} (the vocabulary's residue). {@link #disposition} is a switch EXPRESSION with no
 * {@code default}, so a cause the vocabulary gains does not compile here until it is audited.
 */
public class StopCauseTest {
    static final EngineConfig TAPE = new EngineConfig("test").withForayTape(true, false);
    static final EngineConfig JINGLE = TAPE.withInterludeAvailable(true);
    /** The silence node on (it ships OFF): the only way to see a pause cut it. */
    static final EngineConfig SILENCE = new EngineConfig("test", SessionPolicy.HoldPolicy.DEFAULT, null, true,
            SeamGap.DEFAULT_GAP_SEC, false, false, true, false, true, true, null);

    /** A turn that takes a stop path (its setup excluded). */
    interface Turn {
        List<EngineCommand> run();
    }

    /** One path that stops audio: its name, where it starts, the EngineCore method that writes its row, its cause, and its turn. */
    record StopPath(String name, String origin, String site, StopCause cause, Turn turn) {}

    // ---- the inventory

    static final List<StopPath> PATHS = List.of(
            // The page and the car.
            new StopPath("a listener's pause (the app)", "page", "pause", StopCause.PAUSE,
                    () -> playingEpisode().send(EngineContract.Command.PAUSE)),
            new StopPath("a listener's pause (the car, the lock screen)", "the session's remote", "pause", StopCause.PAUSE,
                    () -> playingEpisode().send(EngineCoreTest.remote(MediaMapping.RemoteCommand.PAUSE))),
            new StopPath("a pause while the seam's jingle sounds", "page + InterludePlayer", "pause", StopCause.PAUSE,
                    () -> inJingle().send(new EngineInput.Command(EngineContract.Command.PAUSE, Source.TAP), 0)),
            new StopPath("a pause while the silence node renders", "page + the silence node", "pause", StopCause.PAUSE,
                    () -> inSilence().send(new EngineInput.Command(EngineContract.Command.PAUSE, Source.TAP), 0)),
            new StopPath("a pause during a spoken line", "page + SpeechNarrator", "pause", StopCause.PAUSE,
                    () -> speakingLine().send(new EngineInput.Command(EngineContract.Command.PAUSE, Source.TAP), 0)),
            new StopPath("a close", "page", "stop", StopCause.CLOSE,
                    () -> playingEpisode().send(new EngineContract.Command.Stop(true))),
            new StopPath("a close while the seam's jingle sounds", "page + InterludePlayer", "stop", StopCause.CLOSE,
                    () -> inJingle().send(new EngineInput.Command(new EngineContract.Command.Stop(true), Source.TAP), 0)),
            new StopPath("Delete my data (stop without persisting)", "page", "stop", StopCause.DATA_DELETION,
                    () -> playingEpisode().send(new EngineContract.Command.Stop(false))),
            new StopPath("Delete my data (purge)", "page", "stop", StopCause.DATA_DELETION,
                    () -> playingEpisode().send(new EngineContract.Command.Purge())),
            new StopPath("the one-way relinquish", "page / EngineOwnership", "relinquish", StopCause.RELINQUISH,
                    () -> playingEpisode().send(new EngineContract.Command.Relinquish(EngineContract.RelinquishCap.ALL))),
            new StopPath("a relinquish while the seam's jingle sounds", "page + InterludePlayer", "relinquish", StopCause.RELINQUISH,
                    () -> inJingle().send(new EngineInput.Command(
                            new EngineContract.Command.Relinquish(EngineContract.RelinquishCap.FORAY), Source.TAP), 0)),
            new StopPath("the engine going away while it plays (the service destroyed)", "ForayEngineHost.teardown", "teardown",
                    StopCause.RELINQUISH, () -> playingEpisode().send(new EngineInput.Lifecycle(new EngineInput.LifecycleEvent.Teardown()))),

            // The deck (ExoDeck, DeckPair).
            new StopPath("an episode ends and nothing follows", "ExoDeck ended", "itemEnded", StopCause.ENDED, () -> {
                Host host = playingEpisode();
                host.reading.audible = false;
                host.reading.ended = true;
                return host.send(new EngineInput.Deck(new DeckEvent.Ended(host.lastLoad)));
            }),
            new StopPath("a Foray's last clip ends", "ExoDeck ended", "itemEnded", StopCause.FINAL_END, () -> {
                Host host = playingForay(EngineCoreTest.forayClip(0, 100, 200));
                host.reading.audible = false;
                host.reading.ended = true;
                return host.send(new EngineInput.Deck(new DeckEvent.Ended(host.lastLoad)), 0);
            }),
            new StopPath("the load-time ladder refuses the last segment left", "ExoDeck ready (ADR-0007)", "skipUnplayableSegment",
                    StopCause.FINAL_END, () -> {
                        Host host = new Host(TAPE);
                        host.reading.durationSec = 3600.0;
                        host.send(playForay(approximate(0), approximate(1)));
                        host.land();
                        return host.land();
                    }),
            new StopPath("the first load fails", "ExoDeck failed (an ExoPlayer error)", "onLoadFailure", StopCause.ERROR, () -> {
                Host host = new Host();
                host.send(EngineCoreTest.load("a"));
                host.send(EngineCoreTest.playIndex(0));
                return host.send(new EngineInput.Deck(new DeckEvent.Failed(host.lastLoad, "decode")));
            }),
            new StopPath("the playing item fails mid-play", "ExoDeck failed (an ExoPlayer error)", "onLoadFailure", StopCause.ERROR,
                    () -> {
                        Host host = playingEpisode();
                        return host.send(new EngineInput.Deck(new DeckEvent.Failed(host.lastLoad, "decode")));
                    }),
            new StopPath("a load passes its P-13 deadline", "ExoDeck deadlineExceeded", "onLoadFailure", StopCause.LOAD_DEADLINE, () -> {
                Host host = new Host();
                host.send(EngineCoreTest.load("a"));
                host.send(EngineCoreTest.playIndex(0));
                return host.send(new EngineInput.Deck(new DeckEvent.DeadlineExceeded(host.lastLoad, 20000)));
            }),
            new StopPath("a seam's next clip never becomes ready (the seam timeout)", "DeckPair deadlineExceeded", "onLoadFailure",
                    StopCause.LOAD_DEADLINE, () -> {
                        Host host = inSeam(TAPE);
                        return host.send(new EngineInput.Deck(new DeckEvent.DeadlineExceeded(host.lastLoad, 20000)));
                    }),
            new StopPath("the system stops the deck (uncommanded pause)", "ExoDeck pausedUncommanded", "reconcile", StopCause.SYSTEM_PAUSE,
                    () -> {
                        Host host = playingEpisode();
                        host.reading.audible = false;
                        return host.send(new EngineInput.Deck(new DeckEvent.PausedUncommanded(host.lastLoad, 12)));
                    }),
            new StopPath("the app comes forward to a silent deck", "lifecycle + the deck's reading", "reconcile", StopCause.SYSTEM_PAUSE,
                    () -> {
                        Host host = playingEpisode();
                        host.reading.audible = false;
                        return host.send(new EngineInput.Lifecycle(new EngineInput.LifecycleEvent.Foreground()));
                    }),

            // SpeechNarrator, the fallback voice (TextToSpeech on Android).
            new StopPath("the synthesiser refuses a line", "SpeechNarrator failed", "onLoadFailure", StopCause.ERROR, () -> {
                Host host = new Host(TAPE);
                host.send(new EngineInput.Queue(new QueueInput.LoadForay(List.of(
                        NarrationSeamCoreTest.spoken(0, "a line"), NarrationSeamCoreTest.clip(1, "a", 100, 200)), false, false)));
                List<EngineCommand> out = host.send(EngineCoreTest.playIndex(0));
                Integer seq = NarrationSeamCoreTest.spokenSeq(out);
                assertNotNull("nothing was spoken: " + out, seq);
                return host.send(new EngineInput.Narrator(new EngineInput.NarratorEvent.Failed(seq, "refused")), 0);
            }),
            new StopPath("a Foray's last spoken line finishes", "SpeechNarrator finished", "itemEnded", StopCause.FINAL_END, () -> {
                Spoken s = speakingForay();
                return s.host.send(new EngineInput.Narrator(new EngineInput.NarratorEvent.Finished(s.seq)), 0);
            }),
            new StopPath("a Foray's last spoken line runs past its deadline", "the line deadline (the narration pulse)", "itemEnded",
                    StopCause.FINAL_END, () -> {
                        Host host = speakingForay().host;
                        for (int i = 0; i < 400; i++) {
                            List<EngineCommand> out = host.send(new EngineInput.Timer(EngineTimer.NARRATION_TICK),
                                    EngineConstants.QueueManager.NARRATION_TICK_MS);
                            if (stopRowIndex(out) >= 0) return out;
                        }
                        return List.of();
                    }),
            new StopPath("a spoken line's pulse finds the process was held (Doze, a frozen process)",
                    "the narration pulse + SpeechNarrator", "reconcileNarrationInterrupted", StopCause.SYSTEM_PAUSE,
                    () -> speakingLine().send(new EngineInput.Timer(EngineTimer.NARRATION_TICK), 60_000)),

            // The audio session's observers (FocusMapping, RouteWatcher on Android) and the route policy.
            new StopPath("an interruption (a call, another app's focus)", "FocusMapping interruption", "onInterruptionBegan",
                    StopCause.INTERRUPTION, () -> playingEpisode().send(session(new EngineInput.SessionEvent.InterruptionBegan("default")))),
            new StopPath("an interruption while the seam's jingle sounds", "FocusMapping + InterludePlayer", "onInterruptionBegan",
                    StopCause.INTERRUPTION,
                    () -> inJingle().send(session(new EngineInput.SessionEvent.InterruptionBegan("default")), 0)),
            new StopPath("an interruption during a spoken line", "FocusMapping + SpeechNarrator", "onInterruptionBegan",
                    StopCause.INTERRUPTION,
                    () -> speakingLine().send(session(new EngineInput.SessionEvent.InterruptionBegan("default")), 0)),
            new StopPath("the output route goes away (the car, headphones)", "RouteWatcher / BECOMING_NOISY (the route policy)", "onRoute",
                    StopCause.ROUTE_CHANGE, () -> playingEpisode().send(session(new EngineInput.SessionEvent.Route(
                            new EngineInput.RouteChange(true, "a2dp", "02:00:00:0A:67:01"))))),
            new StopPath("the route goes away while the seam's jingle sounds", "RouteWatcher + InterludePlayer", "onRoute",
                    StopCause.ROUTE_CHANGE, () -> inJingle().send(session(new EngineInput.SessionEvent.Route(
                            new EngineInput.RouteChange(true, "wired", null))), 0)),
            new StopPath("media services are reset", "the session's reset (iOS only today)", "onMediaServicesReset",
                    StopCause.MEDIA_SERVICES_RESET, () -> playingEpisode().send(session(new EngineInput.SessionEvent.MediaServicesReset()))),

            // Grace.
            new StopPath("grace expires before the audio started", "the grace timer (iOS's budget)", "onTimer", StopCause.GRACE_EXPIRED,
                    () -> {
                        Host host = playingEpisode();
                        host.send(EngineContract.Command.PAUSE);
                        host.send(EngineCoreTest.remote(MediaMapping.RemoteCommand.PLAY));
                        return host.send(new EngineInput.Timer(EngineTimer.GRACE_EXPIRED));
                    }));

    /** Whether a path emits a cause, or why none does. */
    sealed interface Disposition permits Emitted, Reserved {}

    record Emitted() implements Disposition {}

    record Reserved(String why) implements Disposition {}

    /** Every cause, and whether a path emits it. A switch EXPRESSION, no default: a new cause does not compile until audited. */
    static Disposition disposition(StopCause cause) {
        return switch (cause) {
            case PAUSE, ENDED, FINAL_END, SYSTEM_PAUSE, ROUTE_CHANGE, INTERRUPTION, GRACE_EXPIRED, LOAD_DEADLINE, ERROR, RELINQUISH,
                    DATA_DELETION, CLOSE, MEDIA_SERVICES_RESET -> new Emitted();
            case SEAM_TIMEOUT -> new Reserved("a seam's next clip that never becomes ready is its load's P-13 deadline: load-deadline");
            case UNKNOWN -> new Reserved("the residue: a paste that shows one names a defect, never a path");
        };
    }

    // ---- what the table is checked for

    /**
     * THE ACCEPTANCE: every stop path writes its cause row, the cause named, admitted by the ring's
     * gate, before the first command that silences anything in that turn, and one row per stop. TO
     * SEE IT FAIL: move {@code stopRow(StopCause.PAUSE, source)} below {@code cutSeamGap("pause")} in
     * {@code pause()} (the jingle and silence rows go red); delete the {@code stopRow} in
     * {@code teardown()}; delete any {@code stopRow(} call.
     */
    @Test
    public void everyStopPathWritesItsCauseBeforeTheStop() {
        List<String> failures = new ArrayList<>();
        for (StopPath path : PATHS) {
            List<EngineCommand> out = path.turn().run();
            int at = stopRowIndex(out);
            if (at < 0) {
                failures.add(path.name() + " (" + path.origin() + "): no stop row in " + out);
                continue;
            }
            EngineCommand.DiagEntry entry = ((EngineCommand.Diag) out.get(at)).entry();
            if (!JsonNode.str(path.cause().token).equals(entry.field("cause"))) {
                failures.add(path.name() + ": cause " + entry.field("cause") + ", wanted " + path.cause().token);
            }
            EngineCommand.DiagEntry admitted = DiagGate.admit(entry);
            if (admitted == null || !JsonNode.str(path.cause().token).equals(admitted.field("cause"))) {
                failures.add(path.name() + ": the ring's gate does not keep the cause: " + admitted);
            }
            if (JsonNode.str(StopCause.UNKNOWN.token).equals(entry.field("cause"))) failures.add(path.name() + ": cause=unknown");
            int silencing = firstSilencing(out);
            if (silencing >= 0 && silencing < at) failures.add(path.name() + ": a silencing command before the cause row: " + out);
            long rows = out.stream().filter(StopCauseTest::isStopRow).count();
            if (rows != 1) failures.add(path.name() + ": one stop, one row, not " + rows + ": " + out);
        }
        assertTrue(String.join("\n", failures), failures.isEmpty());
    }

    /** Each path is a real stop: the turn is not refused, and it silences something or writes the row. TO SEE IT FAIL: send a pause to an idle host. */
    @Test
    public void everyPathReallyStopsSomething() {
        for (StopPath path : PATHS) {
            List<EngineCommand> out = path.turn().run();
            assertEquals(path.name() + ": the turn was refused: " + out, -1,
                    EngineCoreTest.index(out, c -> c instanceof EngineCommand.CommandFailed));
            assertTrue(path.name() + ": " + out, firstSilencing(out) >= 0 || stopRowIndex(out) >= 0);
        }
    }

    /** Every cause is emitted by a path or reserved with a reason, and a reserved one is emitted by none. */
    @Test
    public void everyStopCauseIsEmittedByAPathOrReservedWithAReason() {
        Set<StopCause> emitted = EnumSet.noneOf(StopCause.class);
        for (StopPath path : PATHS) emitted.add(path.cause());
        for (StopCause cause : StopCause.values()) {
            Disposition d = disposition(cause);
            if (d instanceof Reserved r) {
                assertFalse(cause.token + " is reserved but a path emits it", emitted.contains(cause));
                assertFalse(cause.token, r.why().isEmpty());
            } else {
                assertTrue(cause.token + " is emitted but no path in the table shows it", emitted.contains(cause));
            }
        }
    }

    /** The table's sites are the thirteen EngineCore methods that write a stop row (the shell invariant reads the same names). */
    @Test
    public void everyPathNamesItsSite() {
        Set<String> sites = new LinkedHashSet<>();
        for (StopPath path : PATHS) sites.add(path.site());
        assertEquals(new LinkedHashSet<>(Arrays.asList("pause", "stop", "relinquish", "teardown", "itemEnded", "skipUnplayableSegment",
                "onLoadFailure", "reconcile", "reconcileNarrationInterrupted", "onInterruptionBegan", "onRoute", "onMediaServicesReset",
                "onTimer")), sites);
    }

    // ---- silences that are not stops, each with its own row first

    /** A clip's end in the middle of a Foray is a seam, not a stop: no stop row, and the next load goes out. */
    @Test
    public void aMidForaySeamIsNotAStop() {
        Host host = twoClips(TAPE);
        host.reading.audible = false;
        host.reading.ended = true;
        List<EngineCommand> seam = host.send(new EngineInput.Deck(new DeckEvent.Ended(host.lastLoad)), 0);
        assertEquals(seam.toString(), -1, stopRowIndex(seam));
        assertTrue("the next clip loads: " + seam, EngineCoreTest.index(seam, EngineCoreTest::isLoad) >= 0);
    }

    /** The silence cap ends digital silence inside a seam: not a stop, but its row comes first. TO SEE IT FAIL: add SILENCE_STOP before the row. */
    @Test
    public void theSilenceCapIsNamedBeforeItStopsTheSilence() {
        Host host = inSilence();
        List<EngineCommand> out = host.send(new EngineInput.Timer(EngineTimer.SILENCE_CAP), Interlude.CEILING_SEC * 1000);
        int row = rowIndex(out, "silence", "capped");
        int stop = out.indexOf(EngineCommand.SILENCE_STOP);
        assertTrue(out.toString(), row >= 0 && stop >= 0);
        assertTrue(out.toString(), row < stop);
        assertEquals(out.toString(), -1, stopRowIndex(out));
    }

    /** A transport cut silences the jingle after its own {@code interlude cut} row, and both after the stop row. TO SEE IT FAIL: add Interlude STOP before the row in stopInterlude. */
    @Test
    public void theJinglesCutIsNamedAfterTheStopAndBeforeTheSilence() {
        List<EngineCommand> out = inJingle().send(new EngineInput.Command(EngineContract.Command.PAUSE, Source.TAP), 0);
        int stop = stopRowIndex(out);
        int cut = rowIndex(out, "interlude", "cut");
        int silenced = out.indexOf(new EngineCommand.Interlude(InterludeCommand.STOP));
        assertTrue(out.toString(), stop >= 0 && cut >= 0 && silenced >= 0);
        assertTrue(out.toString(), stop < cut);
        assertTrue(out.toString(), cut < silenced);
    }

    /** A pause on nothing is not a stop. */
    @Test
    public void aPauseOnAnIdleEngineWritesNoStopRow() {
        assertEquals(-1, stopRowIndex(new Host().send(EngineContract.Command.PAUSE)));
    }

    /** A teardown of an engine that was not playing writes no stop row (nothing was audible): the service destroyed while paused. */
    @Test
    public void aTeardownWhilePausedWritesNoStopRow() {
        Host host = playingEpisode();
        host.send(EngineContract.Command.PAUSE);
        List<EngineCommand> out = host.send(new EngineInput.Lifecycle(new EngineInput.LifecycleEvent.Teardown()));
        assertEquals(out.toString(), -1, stopRowIndex(out));
        assertTrue("the core still tears down: " + out, EngineCoreTest.rows("mode", out).stream()
                .anyMatch(r -> JsonNode.str("teardown").equals(r.field("kind"))));
    }

    // ---- hosts

    static EngineInput session(EngineInput.SessionEvent event) {
        return new EngineInput.Session(event);
    }

    /** An episode playing, confirmed audible by the deck. */
    static Host playingEpisode() {
        return EngineCoreTest.playing("a");
    }

    static EngineContract.Command playForay(JsonNode... items) {
        return new EngineContract.Command.PlayForay("f1", "A Foray", Arrays.asList(items), new JsonNode.Obj(List.of()), null, false,
                false, null);
    }

    /** A Foray (a real playForay, so it has an id) playing its first clip. */
    static Host playingForay(JsonNode... items) {
        Host host = new Host(TAPE);
        host.send(playForay(items));
        host.land();
        host.confirm();
        assertEquals("playing", host.core.state().stateType());
        assertNotNull(host.core.state().forayId);
        return host;
    }

    /** A spoken narration line as a Foray item. */
    static JsonNode spokenLine(int index, String script) {
        return EngineCoreTest.obj("id", JsonNode.str("f1#" + index), "kind", JsonNode.str("tts"), "type", JsonNode.str("narration"),
                "script", JsonNode.str(script), "audio_url", JsonNode.NULL, "duration_sec", JsonNode.num(4));
    }

    record Spoken(Host host, int seq) {}

    /** A Foray whose only item is a spoken line, the synthesiser speaking it. */
    static Spoken speakingForay() {
        Host host = new Host(TAPE);
        List<EngineCommand> out = host.send(playForay(spokenLine(0, "the only line")));
        Integer seq = NarrationSeamCoreTest.spokenSeq(out);
        assertNotNull("nothing was spoken: " + out, seq);
        host.send(new EngineInput.Narrator(new EngineInput.NarratorEvent.Started(seq, false)), 0);
        assertNotNull(host.core.state().forayId);
        return new Spoken(host, seq);
    }

    /** A line spoken ahead of a clip (the manager's queue), the synthesiser speaking it. */
    static Host speakingLine() {
        Host host = new Host(TAPE);
        host.send(new EngineInput.Queue(new QueueInput.LoadForay(List.of(
                NarrationSeamCoreTest.spoken(0, "a line"), NarrationSeamCoreTest.clip(1, "a", 100, 200)), false, false)));
        List<EngineCommand> out = host.send(EngineCoreTest.playIndex(0));
        Integer seq = NarrationSeamCoreTest.spokenSeq(out);
        assertNotNull("nothing was spoken: " + out, seq);
        host.send(new EngineInput.Narrator(new EngineInput.NarratorEvent.Started(seq, false)), 0);
        assertEquals("playing", host.core.state().stateType());
        return host;
    }

    /** Two clips of two sources, the first playing, under {@code config}. */
    static Host twoClips(EngineConfig config) {
        Host host = new Host(config);
        host.send(new EngineInput.Queue(new QueueInput.LoadForay(List.of(
                NarrationSeamCoreTest.clip(0, "a", 100, 200), NarrationSeamCoreTest.clip(1, "b", 300, 400)), false, false)));
        host.send(EngineCoreTest.playIndex(0));
        host.land();
        host.confirm();
        return host;
    }

    /** In the seam after the first clip, the next clip's load in flight. */
    static Host inSeam(EngineConfig config) {
        Host host = twoClips(config);
        host.reading.audible = false;
        host.reading.ended = true;
        host.send(new EngineInput.Deck(new DeckEvent.Ended(host.lastLoad)), 0);
        return host;
    }

    /** In the seam with the jingle sounding. */
    static Host inJingle() {
        Host host = twoClips(JINGLE);
        host.reading.audible = false;
        host.reading.ended = true;
        List<EngineCommand> out = host.send(new EngineInput.Deck(new DeckEvent.Ended(host.lastLoad)), 0);
        assertTrue("the harness's seam has no jingle: " + out, out.contains(new EngineCommand.Interlude(InterludeCommand.START)));
        assertTrue(host.core.state().inInterlude);
        assertTrue(host.core.state().isRunning());
        return host;
    }

    /** In a silent seam with the silence node rendering (flagged on here only). */
    static Host inSilence() {
        Host host = twoClips(SILENCE);
        host.reading.audible = false;
        host.reading.ended = true;
        List<EngineCommand> out = host.send(new EngineInput.Deck(new DeckEvent.Ended(host.lastLoad)), 0);
        assertTrue("the harness's seam renders no silence: " + out,
                EngineCoreTest.index(out, c -> c instanceof EngineCommand.SilenceStart) >= 0);
        assertTrue(host.core.state().silenceActive);
        assertTrue(host.core.state().isRunning());
        return host;
    }

    /** An approximate copy (ADR-0007): the load-time ladder refuses it. */
    static JsonNode approximate(int index) {
        return EngineCoreTest.obj("id", JsonNode.str("f1#" + index), "kind", JsonNode.str("episode"),
                "audio_url", JsonNode.str("https://cdn.test/dai" + index + ".mp3"), "start_sec", JsonNode.num(100),
                "end_sec", JsonNode.num(200), "duration_sec", JsonNode.num(3600), "dai_suspected", JsonNode.bool(true),
                "needs_drift_check", JsonNode.bool(true), "reference_duration_sec", JsonNode.num(2501),
                "start_anchor", JsonNode.str("so the thing"), "end_anchor", JsonNode.str("and that is why"));
    }

    // ---- readings

    static boolean isStopRow(EngineCommand c) {
        return c instanceof EngineCommand.Diag d && d.entry().kind().equals("stop");
    }

    static int stopRowIndex(List<EngineCommand> out) {
        return EngineCoreTest.index(out, StopCauseTest::isStopRow);
    }

    static int rowIndex(List<EngineCommand> out, String kind, String event) {
        return EngineCoreTest.index(out, c -> c instanceof EngineCommand.Diag d && d.entry().kind().equals(kind)
                && JsonNode.str(event).equals(d.entry().field("kind")));
    }

    /** A command that silences something or releases the session (the Swift {@code silences}). */
    static boolean silences(EngineCommand c) {
        if (c instanceof EngineCommand.Deck d) return d.command() instanceof DeckCommand.Pause || d.command() instanceof DeckCommand.Unload;
        if (c instanceof EngineCommand.Preview p) return p.command() instanceof DeckCommand.Unload;
        if (c instanceof EngineCommand.SessionDeactivate || c instanceof EngineCommand.SessionReapplyCategory) return true;
        if (c instanceof EngineCommand.SilenceStop) return true;
        if (c instanceof EngineCommand.Interlude i) return i.command() == InterludeCommand.STOP || i.command() == InterludeCommand.RELEASE;
        if (c instanceof EngineCommand.Narration n) {
            return n.command() instanceof NarrationCommand.Stop || n.command() instanceof NarrationCommand.Pause
                    || n.command() instanceof NarrationCommand.Discard;
        }
        return false;
    }

    static int firstSilencing(List<EngineCommand> out) {
        return EngineCoreTest.index(out, StopCauseTest::silences);
    }
}
