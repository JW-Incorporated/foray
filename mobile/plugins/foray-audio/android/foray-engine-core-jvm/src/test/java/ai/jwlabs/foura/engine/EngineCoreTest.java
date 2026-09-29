package ai.jwlabs.foura.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.engine.EngineCommand.GraceOutcome;
import ai.jwlabs.foura.engine.EngineCommand.GraceReason;
import ai.jwlabs.foura.engine.EngineInput.QueueInput;
import ai.jwlabs.foura.engine.Vocabulary.Source;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.function.Predicate;
import org.junit.Test;

/**
 * Card A-24: what the manager-episode fixtures cannot see, because it is native-only (the
 * audio session as request and response, grace spans, cause rows, the restore record,
 * continuation walking): the JVM twin of the Swift EngineCoreTests (NE-14s).
 *
 * <p>Each test drives {@link EngineCore} the way the host will: an input and the deck's
 * reading in, commands out, the activation answered in the same turn. {@link Host} is that
 * host, over a fake deck that goes silent on a load, audible on a play and silent on a pause.
 */
public class EngineCoreTest {
    static final double WALL_MS = 1_790_000_000_000.0;

    static final class Host {
        final EngineCore core;
        DeckReading reading = new DeckReading(0.0, 3600.0, false, false);
        double monoMs = 0;
        boolean activationOK = true;
        Integer lastLoad;
        Double bgRemainingMs;

        Host() {
            this(new EngineConfig("test"));
        }

        Host(EngineConfig config) {
            core = new EngineCore(config);
        }

        /** One turn: the input, then the activation's answer if it asked. */
        List<EngineCommand> send(EngineInput input) {
            monoMs += 1000;
            List<EngineCommand> all = new ArrayList<>(core.handle(input, new EngineNow(WALL_MS, monoMs, reading, bgRemainingMs)));
            Integer id = null;
            for (EngineCommand c : all) if (c instanceof EngineCommand.SessionActivate a) id = a.requestId();
            if (id != null) {
                all.addAll(core.handle(new EngineInput.SessionAnswer(new EngineInput.SessionResult(id, activationOK,
                        activationOK ? null : "cannot-interrupt-others", 3.0)), new EngineNow(WALL_MS, monoMs, reading, bgRemainingMs)));
            }
            for (EngineCommand c : all) {
                if (!(c instanceof EngineCommand.Deck d)) continue;
                switch (d.command()) {
                    case DeckCommand.Load load -> {
                        lastLoad = load.token();
                        reading.positionSec = load.startSec();
                        reading.audible = false;
                        reading.ended = false;
                    }
                    case DeckCommand.Play p -> reading.audible = true;
                    case DeckCommand.Pause p -> reading.audible = false;
                    case DeckCommand.Seek s -> reading.positionSec = s.toSec();
                    default -> {}
                }
            }
            return all;
        }

        List<EngineCommand> send(EngineContract.Command command) {
            return send(new EngineInput.Command(command, Source.TAP));
        }

        /** The load {@code token} (default: the latest) becomes ready. */
        List<EngineCommand> land(Integer token) {
            int t = token != null ? token : lastLoad != null ? lastLoad : 0;
            return send(new EngineInput.Deck(new DeckEvent.Ready(t, reading.positionSec != null ? reading.positionSec : 0, true, 5)));
        }

        List<EngineCommand> land() {
            return land(null);
        }

        /** The deck confirms {@code playing}. */
        List<EngineCommand> confirm() {
            return send(new EngineInput.Deck(new DeckEvent.TimeControl(lastLoad != null ? lastLoad : 0,
                    DeckEvent.TimeControlStatus.PLAYING, null)));
        }
    }

    static JsonNode obj(Object... keyValues) {
        List<JsonNode.Member> members = new ArrayList<>();
        for (int i = 0; i < keyValues.length; i += 2) members.add(JsonNode.member((String) keyValues[i], (JsonNode) keyValues[i + 1]));
        return new JsonNode.Obj(members);
    }

    static EngineItem item(String id) {
        return EngineItem.of(obj("id", JsonNode.str(id), "kind", JsonNode.str("episode"),
                "audio_url", JsonNode.str("https://cdn.example/" + id + ".mp3")));
    }

    static EngineInput load(String... ids) {
        List<EngineItem> items = new ArrayList<>();
        for (String id : ids) items.add(item(id));
        return new EngineInput.Queue(new QueueInput.Load(items));
    }

    static EngineInput playIndex(int index) {
        return new EngineInput.Queue(new QueueInput.PlayIndex(index, null, Source.TAP));
    }

    /** A host playing {@code ids[0]} (queued with the rest), confirmed audible. */
    static Host playing(String... ids) {
        Host host = new Host();
        host.send(load(ids.length == 0 ? new String[] {"a"} : ids));
        host.send(playIndex(0));
        host.land();
        host.confirm();
        assertEquals("playing", host.core.state().stateType());
        return host;
    }

    static int index(List<EngineCommand> commands, Predicate<EngineCommand> match) {
        for (int i = 0; i < commands.size(); i++) if (match.test(commands.get(i))) return i;
        return -1;
    }

    static boolean isPlay(EngineCommand c) {
        return c instanceof EngineCommand.Deck d && d.command() instanceof DeckCommand.Play;
    }

    static boolean isLoad(EngineCommand c) {
        return c instanceof EngineCommand.Deck d && d.command() instanceof DeckCommand.Load;
    }

    static boolean isPause(EngineCommand c) {
        return c instanceof EngineCommand.Deck d && d.command() instanceof DeckCommand.Pause;
    }

    static boolean failedWith(List<EngineCommand> commands, String reason) {
        return index(commands, c -> c instanceof EngineCommand.CommandFailed f && f.reason().equals(reason)) >= 0;
    }

    // ---- the audible-start invariant, as request and response

    /** A failed activation is {@code commandFailed(session-failed:<token>)} and NOTHING audible or even loading. */
    @Test
    public void aFailedActivationFailsTheCommandAndStartsNothing() {
        Host host = new Host();
        host.activationOK = false;
        host.send(load("a"));
        List<EngineCommand> out = host.send(playIndex(0));
        assertTrue(out.toString(), failedWith(out, "session-failed:cannot-interrupt-others"));
        assertEquals("nothing loads without the session", -1, index(out, EngineCoreTest::isLoad));
        assertEquals(-1, index(out, EngineCoreTest::isPlay));
        assertEquals(SessionPolicy.Phase.INACTIVE, host.core.state().session);
        assertEquals("idle", host.core.state().stateType());
    }

    /** The activation is asked for, answered, and only then does the load go out; the play waits for {@code ready}. */
    @Test
    public void theActivationPrecedesTheLoadAndThePlayWaitsForReady() {
        Host host = new Host();
        host.send(load("a"));
        List<EngineCommand> first = host.core.handle(playIndex(0), new EngineNow(0, 1, host.reading));
        assertEquals("the core stops at sessionActivate", List.of(new EngineCommand.SessionActivate(1)),
                first.stream().filter(c -> c instanceof EngineCommand.SessionActivate).toList());
        assertEquals("no load before the answer", -1, index(first, EngineCoreTest::isLoad));
        List<EngineCommand> answered = host.core.handle(new EngineInput.SessionAnswer(new EngineInput.SessionResult(1, true, null, null)),
                new EngineNow(0, 1, host.reading));
        assertTrue(index(answered, EngineCoreTest::isLoad) >= 0);
        assertEquals("no play before the deck is ready", -1, index(answered, EngineCoreTest::isPlay));
        host.lastLoad = 1;
        List<EngineCommand> ready = host.land();
        List<EngineCommand> deck = ready.stream().filter(c -> c instanceof EngineCommand.Deck).toList();
        assertEquals("rate on every play, then play", Arrays.asList(new EngineCommand.Deck(new DeckCommand.SetRate(1)),
                new EngineCommand.Deck(DeckCommand.PLAY)), deck);
    }

    /** Nothing is ever audible while the session is lost to an interruption. */
    @Test
    public void aLoadLandingDuringAnInterruptionStaysSilent() {
        Host host = new Host();
        host.send(load("a"));
        host.send(playIndex(0));
        host.send(new EngineInput.Session(new EngineInput.SessionEvent.InterruptionBegan("default")));
        assertEquals(SessionPolicy.Phase.LOST_TO_INTERRUPTION, host.core.state().session);
        List<EngineCommand> landed = host.land();
        assertEquals(landed.toString(), -1, index(landed, EngineCoreTest::isPlay));
        assertEquals("interrupted", host.core.state().stateType());
    }

    /** Two loads in flight: only the one that owns the deck plays (#19). */
    @Test
    public void aSupersededLoadNeverPlays() {
        Host host = new Host();
        host.send(load("a", "b"));
        host.send(playIndex(0));
        Integer first = host.lastLoad;
        host.send(playIndex(1));
        assertNotEquals(first, host.lastLoad);
        assertEquals("a's late landing plays nothing", -1, index(host.land(first), EngineCoreTest::isPlay));
        assertNull("and claims nothing", host.core.state().loadedId);
        assertTrue(index(host.land(), EngineCoreTest::isPlay) >= 0);
        assertEquals("b", host.core.state().loadedId);
    }

    /**
     * Media services were reset: the session is gone, so the next play asks for it again, and
     * a refused activation plays nothing.
     */
    @Test
    public void aPlayAfterAMediaServicesResetAsksForTheSessionAgain() {
        Host host = playing();
        host.send(new EngineInput.Session(new EngineInput.SessionEvent.MediaServicesReset()));
        assertEquals(SessionPolicy.Phase.INACTIVE, host.core.state().session);
        host.activationOK = false;
        List<EngineCommand> out = host.send(EngineContract.Command.PLAY);
        assertTrue(out.toString(), index(out, c -> c instanceof EngineCommand.SessionActivate) >= 0);
        assertEquals(-1, index(out, EngineCoreTest::isPlay));
        assertTrue(out.toString(), failedWith(out, "session-failed:cannot-interrupt-others"));
    }

    /** The terminal state: after a relinquish every input is answered with nothing, and the relinquish never deactivates. */
    @Test
    public void aRelinquishedCoreAnswersNothingEver() {
        Host host = playing();
        List<EngineCommand> out = host.send(new EngineContract.Command.Relinquish(EngineContract.RelinquishCap.FORAY));
        assertEquals("no deactivate, no notify", -1, index(out, c -> c instanceof EngineCommand.SessionDeactivate));
        assertTrue(index(out, c -> c instanceof EngineCommand.WriteRestore r && r.record() != null
                && r.record().mode() == RestoreRecord.Mode.RELINQUISHED) >= 0);
        assertTrue(index(out, EngineCoreTest::isPause) >= 0);
        assertEquals(SessionPolicy.Phase.RELINQUISHED, host.core.state().session);
        for (EngineInput input : Arrays.<EngineInput>asList(
                new EngineInput.Session(new EngineInput.SessionEvent.InterruptionEnded(true)),
                new EngineInput.Session(new EngineInput.SessionEvent.Route(new EngineInput.RouteChange(false, null, false))),
                new EngineInput.Session(new EngineInput.SessionEvent.MediaServicesReset()),
                new EngineInput.Remote(new EngineInput.RemotePress(MediaMapping.RemoteCommand.PLAY)),
                new EngineInput.Deck(new DeckEvent.Ready(1, 0, true, 0)),
                new EngineInput.Timer(EngineTimer.POSITION_TICK),
                new EngineInput.Lifecycle(new EngineInput.LifecycleEvent.Foreground()))) {
            assertEquals(input.toString(), List.of(), host.send(input));
        }
    }

    // ---- every stop path writes its cause first

    static int stopRow(Vocabulary.StopCause cause, List<EngineCommand> commands) {
        return index(commands, c -> c instanceof EngineCommand.Diag d && d.entry().kind().equals("stop")
                && JsonNode.str(cause.token).equals(d.entry().field("cause")));
    }

    static int firstSilencing(List<EngineCommand> commands) {
        return index(commands, c -> isPause(c) || (c instanceof EngineCommand.Deck d && d.command() instanceof DeckCommand.Unload)
                || c instanceof EngineCommand.SessionDeactivate || c instanceof EngineCommand.SessionReapplyCategory);
    }

    static void assertCauseFirst(Vocabulary.StopCause cause, List<EngineCommand> commands) {
        int row = stopRow(cause, commands);
        assertTrue("no stop row cause=" + cause.token + " in " + commands, row >= 0);
        int silencing = firstSilencing(commands);
        if (silencing >= 0) assertTrue("the cause row must come before the stop", row < silencing);
    }

    @Test
    public void everyStopPathWritesItsCauseFirst() {
        assertCauseFirst(Vocabulary.StopCause.PAUSE, playing().send(EngineContract.Command.PAUSE));
        assertCauseFirst(Vocabulary.StopCause.INTERRUPTION,
                playing().send(new EngineInput.Session(new EngineInput.SessionEvent.InterruptionBegan("default"))));
        assertCauseFirst(Vocabulary.StopCause.ROUTE_CHANGE, playing().send(new EngineInput.Session(
                new EngineInput.SessionEvent.Route(new EngineInput.RouteChange(true, null, false)))));
        assertCauseFirst(Vocabulary.StopCause.CLOSE, playing().send(new EngineContract.Command.Stop(true)));
        assertCauseFirst(Vocabulary.StopCause.MEDIA_SERVICES_RESET,
                playing().send(new EngineInput.Session(new EngineInput.SessionEvent.MediaServicesReset())));
        Host system = playing();
        system.reading.audible = false;
        assertCauseFirst(Vocabulary.StopCause.SYSTEM_PAUSE,
                system.send(new EngineInput.Deck(new DeckEvent.PausedUncommanded(system.lastLoad, 12))));
        Host ended = playing();
        assertCauseFirst(Vocabulary.StopCause.ENDED, ended.send(new EngineInput.Deck(new DeckEvent.Ended(ended.lastLoad))));
    }

    /** A data deletion writes no position and removes the restore record. */
    @Test
    public void aDataDeletionWritesNoPositionAndDropsTheRecord() {
        Host host = playing();
        host.reading.positionSec = 600.0;
        List<EngineCommand> out = host.send(new EngineContract.Command.Purge());
        assertEquals(-1, index(out, c -> c instanceof EngineCommand.WritePosition));
        assertTrue(index(out, c -> c instanceof EngineCommand.WriteRestore r && r.record() == null) >= 0);
        assertTrue(host.core.state().positions.isEmpty());
    }

    // ---- grace

    /** A remote play holds grace from the press until the deck confirms playing. */
    @Test
    public void aRemotePlayHoldsGraceUntilTheDeckConfirmsPlaying() {
        Host host = playing();
        host.send(EngineContract.Command.PAUSE);
        List<EngineCommand> press = host.send(new EngineInput.Remote(new EngineInput.RemotePress(MediaMapping.RemoteCommand.PLAY)));
        int begin = index(press, c -> c.equals(new EngineCommand.GraceBegin(GraceReason.REMOTE_PLAY)));
        int load = index(press, EngineCoreTest::isLoad);
        assertTrue(press.toString(), begin >= 0 && load >= 0);
        assertTrue("the span is silent from the press, before the load", begin < load);
        assertFalse("a play command is not audio", host.land().contains(new EngineCommand.GraceEnd(GraceOutcome.PLAYING)));
        assertTrue(host.confirm().contains(new EngineCommand.GraceEnd(GraceOutcome.PLAYING)));
        assertNull(host.core.state().grace);
    }

    @Test
    public void graceEndsWhenTheIntentDoes() {
        Host host = playing();
        host.send(EngineContract.Command.PAUSE);
        host.send(new EngineInput.Remote(new EngineInput.RemotePress(MediaMapping.RemoteCommand.PLAY)));
        assertTrue(host.send(EngineContract.Command.PAUSE).contains(new EngineCommand.GraceEnd(GraceOutcome.NOT_RUNNING)));
    }

    @Test
    public void aTapOpensGraceOnlyInTheBackground() {
        Host host = playing();
        host.send(EngineContract.Command.PAUSE);
        assertFalse(host.send(EngineContract.Command.PLAY).contains(new EngineCommand.GraceBegin(GraceReason.BACKGROUND_TAP)));
        host.land();
        host.confirm();
        host.send(EngineContract.Command.PAUSE);
        host.send(new EngineInput.Lifecycle(new EngineInput.LifecycleEvent.Background()));
        assertTrue(host.send(EngineContract.Command.PLAY).contains(new EngineCommand.GraceBegin(GraceReason.BACKGROUND_TAP)));
    }

    // ---- rows, events and the restore record

    /** {@code lastEpisodeRow} is stored VERBATIM in the page's key order, with the engine's {@code updated_at}, when the item plays. */
    @Test
    public void lastEpisodeRowIsWrittenVerbatimWhenTheItemPlays() {
        Host host = new Host();
        JsonNode row = obj("title", JsonNode.str("T"), "id", JsonNode.str("ep"), "custom", JsonNode.num(1));
        JsonNode episode = obj("id", JsonNode.str("ep"), "audio_url", JsonNode.str("https://x/ep.mp3"));
        List<EngineCommand> asked = host.send(new EngineContract.Command.PlayEpisode(episode, null, null, row));
        assertEquals("not before it plays", -1, index(asked, c -> c instanceof EngineCommand.WriteRow));
        List<EngineCommand> played = host.land();
        assertTrue(played.toString(), played.contains(new EngineCommand.WriteRow(new Rows.StoredRow("cp_last_episode",
                "{\"title\":\"T\",\"id\":\"ep\",\"custom\":1,\"updated_at\":\"2026-09-21T14:13:20.000Z\"}"))));
        assertTrue(index(played, c -> c instanceof EngineCommand.WriteRestore r && r.record() != null
                && r.record().mode() == RestoreRecord.Mode.EPISODE && r.record().index() == 0) >= 0);
    }

    /**
     * The periodic writer runs exactly while playing, writes only when the playhead moved,
     * and each write may append the once-a-minute position event, which the page acks away.
     */
    @Test
    public void positionCadenceAndPendingEvents() {
        Host host = new Host();
        host.send(load("a"));
        host.send(playIndex(0));
        assertTrue(host.land().contains(new EngineCommand.TimerArm(EngineTimer.POSITION_TICK, ResumeRules.POSITION_INTERVAL_MS, true)));
        host.reading.positionSec = 4.0;
        EngineInput tick = new EngineInput.Timer(EngineTimer.POSITION_TICK);
        assertTrue("a first tick writes", index(host.send(tick), c -> c instanceof EngineCommand.WritePosition) >= 0);
        host.reading.positionSec = 9.0;
        assertEquals("under the minimum delta: no write", -1, index(host.send(tick), c -> c instanceof EngineCommand.WritePosition));
        host.reading.positionSec = 70.0;
        List<EngineCommand> later = host.send(tick);
        assertTrue(index(later, c -> c instanceof EngineCommand.AppendEvent e && e.event().episodeId().equals("a")
                && e.event().seconds() == 70) >= 0);
        assertEquals(Arrays.asList(1, 2), host.core.state().pendingEvents.stream().map(EngineCommand.PendingEvent::seq).toList());
        host.send(new EngineContract.Command.AckEvents(1));
        assertEquals(List.of(2), host.core.state().pendingEvents.stream().map(EngineCommand.PendingEvent::seq).toList());
        assertTrue(host.send(EngineContract.Command.PAUSE).contains(new EngineCommand.TimerCancel(EngineTimer.POSITION_TICK)));
    }

    // ---- continuation (plan §5.5)

    static EngineContract.Hop hop(int seq, String next) {
        JsonNode node = obj("planSeq", JsonNode.num(7), "hopSeq", JsonNode.num(seq), "nextId", JsonNode.str(next),
                "item", obj("id", JsonNode.str(next), "audio_url", JsonNode.str("https://cdn.example/" + next + ".mp3")),
                "lastEpisodeRow", obj("id", JsonNode.str(next)));
        return new EngineContract.Hop(7, seq, next, node);
    }

    static EngineContract.Command continuation(boolean autoAdvance, EngineContract.Hop... hops) {
        return new EngineContract.Command.SetContinuation(7, autoAdvance, Arrays.asList(hops), null);
    }

    /** At an end the chain is walked ONLY with autoAdvance on; {@code canNext} is the chain either way. */
    @Test
    public void anEndWalksTheChainOnlyWithAutoAdvance() {
        Host off = playing();
        off.send(continuation(false, hop(1, "b")));
        assertTrue(off.core.canNext());
        assertEquals(-1, index(off.send(new EngineInput.Deck(new DeckEvent.Ended(off.lastLoad))), EngineCoreTest::isLoad));
        assertEquals("ended", off.core.state().stateType());

        Host on = playing();
        on.send(continuation(true, hop(1, "b"), hop(2, "c")));
        List<EngineCommand> walked = on.send(new EngineInput.Deck(new DeckEvent.Ended(on.lastLoad)));
        assertTrue(index(walked, c -> c instanceof EngineCommand.Deck d && d.command() instanceof DeckCommand.Load l
                && l.itemId().equals("b")) >= 0);
        assertTrue(index(walked, c -> c instanceof EngineCommand.Emit e && e.event() instanceof EngineCommand.EngineEvent.Advanced) >= 0);
        assertEquals(List.of("b"), on.core.state().advanceLog.stream().map(e -> e.hop().nextId()).toList());
        assertEquals(List.of("c"), on.core.state().chain.stream().map(EngineContract.Hop::nextId).toList());
        assertEquals("a hop is not an end", -1, index(walked, c -> c instanceof EngineCommand.SessionDeactivate));
        assertTrue(index(on.land(), c -> c instanceof EngineCommand.WriteRow r && r.row().key().equals("cp_last_episode")) >= 0);
    }

    /** Next walks the chain whatever autoAdvance says, and the page acks it. */
    @Test
    public void nextWalksTheChainAndTheAckTrimsTheLog() {
        Host host = playing();
        host.send(continuation(false, hop(1, "b")));
        assertTrue(index(host.send(EngineContract.Command.NEXT), EngineCoreTest::isLoad) >= 0);
        assertEquals(List.of(1), host.core.state().advanceLog.stream().map(EngineCommand.AdvanceEntry::seq).toList());
        assertFalse("the chain is spent", host.core.canNext());
        host.send(new EngineContract.Command.AckAdvances(1));
        assertEquals(0, host.core.state().advanceLog.size());
        assertTrue(failedWith(host.send(EngineContract.Command.NEXT), "no-next"));
    }

    /** C-6: a chained start that fails says {@code chain-start}. */
    @Test
    public void aFailedChainedStartIsAChainStartError() {
        Host host = playing();
        host.send(continuation(true, hop(1, "b")));
        host.send(new EngineInput.Deck(new DeckEvent.Ended(host.lastLoad)));
        List<EngineCommand> failed = host.send(new EngineInput.Deck(new DeckEvent.Failed(host.lastLoad, "404")));
        assertTrue(failed.toString(), failed.contains(new EngineCommand.Emit(new EngineCommand.EngineEvent.Error("chain-start", "404"))));
    }

    // ---- the tokens are the generated ones

    @Test
    public void refusalsAndRelinquishCapsAreTheGeneratedLists() {
        List<String> refusals = new ArrayList<>();
        for (EngineContract.Refusal r : EngineContract.Refusal.values()) refusals.add(r.token);
        assertEquals(EngineConstants.EngineContract.REFUSALS, refusals);
        List<String> caps = new ArrayList<>();
        for (EngineContract.RelinquishCap c : EngineContract.RelinquishCap.values()) caps.add(c.token);
        assertEquals(EngineConstants.EngineContract.RELINQUISH_CAPS, caps);
    }

    @Test
    public void deckPolicyTokensAreTheGeneratedConstants() {
        assertEquals(EngineConstants.DeckPolicy.FineWake.STOP, DeckPolicy.FineWake.STOP.token);
        assertEquals(EngineConstants.DeckPolicy.FineWake.RESCHEDULE, DeckPolicy.FineWake.RESCHEDULE.token);
        assertEquals(EngineConstants.DeckPolicy.FineWake.STAND_DOWN, DeckPolicy.FineWake.STAND_DOWN.token);
        assertEquals(EngineConstants.DeckPolicy.Recovery.ARM_OUT_POINT, DeckPolicy.Recovery.ARM_OUT_POINT.token);
        assertEquals(EngineConstants.DeckPolicy.Recovery.PLAY, DeckPolicy.Recovery.PLAY.token);
        assertEquals(EngineConstants.DeckPolicy.Recovery.REPORT, DeckPolicy.Recovery.REPORT.token);
    }

    /** The audible commands the invariant reads are exactly the turn names the core gives its audible commands. */
    @Test
    public void theAudibleTurnNamesAreTheInvariantsAudibleCommands() {
        assertTrue(SessionPolicy.AUDIBLE_COMMANDS.contains(EngineCommand.turnName(new EngineCommand.Deck(DeckCommand.PLAY))));
        assertTrue(SessionPolicy.AUDIBLE_COMMANDS.contains(EngineCommand.turnName(new EngineCommand.Speak("hi", null))));
        assertFalse(SessionPolicy.AUDIBLE_COMMANDS.contains(EngineCommand.turnName(new EngineCommand.Deck(
                new DeckCommand.Load(1, "a", null, 0, false)))));
    }
}
