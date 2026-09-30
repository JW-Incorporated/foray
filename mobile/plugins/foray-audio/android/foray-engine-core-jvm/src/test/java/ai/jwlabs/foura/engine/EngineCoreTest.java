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
import java.util.Map;
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

        Host(Map<String, ResumeRules.StoredPosition> positions) {
            core = new EngineCore(new EngineConfig("test"), positions);
        }

        /** One turn: the input, then the activation's answer if it asked. */
        List<EngineCommand> send(EngineInput input) {
            return send(input, 1000);
        }

        /** One turn, {@code afterMs} on the monotonic clock after the last. */
        List<EngineCommand> send(EngineInput input, double afterMs) {
            monoMs += afterMs;
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
        return playing(new EngineConfig("test"), ids);
    }

    static Host playing(EngineConfig config, String... ids) {
        Host host = new Host(config);
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

    // ---- ported from the Swift EngineCoreTests (NE-14s, NE-16g): the rest of what the fixtures cannot see

    static EngineInput session(EngineInput.SessionEvent event) {
        return new EngineInput.Session(event);
    }

    static EngineInput remote(MediaMapping.RemoteCommand command) {
        return new EngineInput.Remote(new EngineInput.RemotePress(command));
    }

    static boolean isDeactivate(EngineCommand c) {
        return c instanceof EngineCommand.SessionDeactivate;
    }

    static boolean isSeek(EngineCommand c) {
        return c instanceof EngineCommand.Deck d && d.command() instanceof DeckCommand.Seek;
    }

    static boolean loadsAt(List<EngineCommand> commands, double startSec) {
        return index(commands, c -> c instanceof EngineCommand.Deck d && d.command() instanceof DeckCommand.Load l
                && l.startSec() == startSec) >= 0;
    }

    /** The diag rows of one kind in a turn, in order. */
    static List<EngineCommand.DiagEntry> rows(String kind, List<EngineCommand> commands) {
        List<EngineCommand.DiagEntry> found = new ArrayList<>();
        for (EngineCommand c : commands) {
            if (c instanceof EngineCommand.Diag d && d.entry().kind().equals(kind)) found.add(d.entry());
        }
        return found;
    }

    static List<EngineCommand> deckOnly(List<EngineCommand> commands) {
        return commands.stream().filter(c -> c instanceof EngineCommand.Deck).toList();
    }

    static EngineContract.Command episode(String id) {
        return new EngineContract.Command.PlayEpisode(
                obj("id", JsonNode.str(id), "audio_url", JsonNode.str("https://cdn.example/" + id + ".mp3")), null, null,
                obj("id", JsonNode.str(id)));
    }

    /** The stop paths the combined test above does not reach, each with what else it must do. */
    @Test
    public void theOtherStopPathsWriteTheirCauseFirst() {
        Host error = playing();
        List<EngineCommand> failed = error.send(new EngineInput.Deck(new DeckEvent.Failed(error.lastLoad, "decode")));
        assertCauseFirst(Vocabulary.StopCause.ERROR, failed);
        assertTrue(failed.toString(), failed.contains(new EngineCommand.Emit(new EngineCommand.EngineEvent.Error("load", "decode"))));

        Host deadline = new Host();
        deadline.send(load("a"));
        deadline.send(playIndex(0));
        assertCauseFirst(Vocabulary.StopCause.LOAD_DEADLINE,
                deadline.send(new EngineInput.Deck(new DeckEvent.DeadlineExceeded(deadline.lastLoad, 20000))));
        assertEquals("idle", deadline.core.state().stateType());

        Host ended = playing();
        List<EngineCommand> end = ended.send(new EngineInput.Deck(new DeckEvent.Ended(ended.lastLoad)));
        assertTrue("an episode that simply ends releases the session with notify: " + end,
                end.contains(new EngineCommand.SessionDeactivate(true)));

        List<EngineCommand> closed = playing().send(new EngineContract.Command.Stop(true));
        assertTrue(closed.toString(), closed.contains(new EngineCommand.SessionDeactivate(true)));

        List<EngineCommand> deleted = playing().send(new EngineContract.Command.Stop(false));
        assertCauseFirst(Vocabulary.StopCause.DATA_DELETION, deleted);
        assertEquals("a deletion writes nothing back", -1, index(deleted, c -> c instanceof EngineCommand.WritePosition));

        assertCauseFirst(Vocabulary.StopCause.RELINQUISH,
                playing().send(new EngineContract.Command.Relinquish(EngineContract.RelinquishCap.ALL)));
    }

    /** A media-services reset lands paused and NOT resumable: the deck holds nothing. */
    @Test
    public void aMediaServicesResetIsNotResumable() {
        Host host = playing();
        host.send(session(new EngineInput.SessionEvent.MediaServicesReset()));
        assertEquals(new PlayerQueueState.Interrupted(item("a").ref(), false), host.core.state().player);
        assertNull("the deck holds nothing after a reset", host.core.state().loadedId);
        assertEquals("not resumable", -1,
                index(host.send(session(new EngineInput.SessionEvent.InterruptionEnded(true))), EngineCoreTest::isLoad));
    }

    /** Grace that runs out ends the span and pauses, and a load landing after it plays nothing. */
    @Test
    public void anExpiredGraceStopsWithItsCause() {
        Host host = playing();
        host.send(EngineContract.Command.PAUSE);
        host.send(remote(MediaMapping.RemoteCommand.PLAY));
        assertEquals(GraceReason.REMOTE_PLAY, host.core.state().grace);
        List<EngineCommand> out = host.send(new EngineInput.Timer(EngineTimer.GRACE_EXPIRED));
        assertTrue(out.toString(), stopRow(Vocabulary.StopCause.GRACE_EXPIRED, out) >= 0);
        assertTrue(out.contains(new EngineCommand.GraceEnd(GraceOutcome.EXPIRED)));
        assertEquals("a load landing after the grace expired plays nothing", -1, index(host.land(), EngineCoreTest::isPlay));
    }

    /** A stop of nothing is not a stop: no row when nothing ran. */
    @Test
    public void noCauseRowWhenNothingWasRunning() {
        List<EngineCommand> out = new Host().send(session(new EngineInput.SessionEvent.InterruptionBegan("appWasSuspended")));
        assertEquals(out.toString(), 0, rows("stop", out).size());
    }

    /**
     * An interruption's resume, a KNOWN car coming back and a cold play each open their grace
     * span. Headphones plugged back in (a route never seen as a car) resume nothing (corner
     * case #13): no fixture drives a route coming back, so this is the only thing that
     * notices a core resuming on any route.
     */
    @Test
    public void resumesAndColdPlaysOpenGraceAndOnlyAKnownCarResumes() {
        Host host = playing();
        host.send(session(new EngineInput.SessionEvent.InterruptionBegan("default")));
        assertTrue(host.send(session(new EngineInput.SessionEvent.InterruptionEnded(true)))
                .contains(new EngineCommand.GraceBegin(GraceReason.INTERRUPTION_RESUME)));

        Host car = playing();
        car.send(session(new EngineInput.SessionEvent.Route(new EngineInput.RouteChange(true, "Civic", true))));
        List<EngineCommand> back = car.send(session(new EngineInput.SessionEvent.Route(new EngineInput.RouteChange(false, "Civic", false))));
        assertTrue(back.toString(), back.contains(new EngineCommand.GraceBegin(GraceReason.ROUTE_RESUME)));
        assertTrue("the known car resumes: " + back, index(back, EngineCoreTest::isLoad) >= 0);

        Host phones = playing();
        phones.send(session(new EngineInput.SessionEvent.Route(new EngineInput.RouteChange(true, "AirPods", false))));
        List<EngineCommand> plugged = phones.send(session(new EngineInput.SessionEvent.Route(
                new EngineInput.RouteChange(false, "AirPods", false))));
        assertEquals("headphones plugged in never resume: " + plugged, -1, index(plugged, EngineCoreTest::isLoad));
        assertEquals(-1, index(plugged, c -> c instanceof EngineCommand.SessionActivate));
        assertEquals(-1, index(plugged, c -> c instanceof EngineCommand.GraceBegin));
        assertEquals("interrupted", phones.core.state().stateType());

        Host cold = new Host();
        assertTrue(cold.send(new EngineInput.Lifecycle(new EngineInput.LifecycleEvent.ColdLaunch(List.of(item("a")), 0, true)))
                .contains(new EngineCommand.GraceBegin(GraceReason.COLD_PLAY)));
    }

    /**
     * The H-1 verdict reads the {@code remote} row: a car's play in the background says
     * {@code grace=y} with the budget the host read, although the span opens only while the
     * press is handled, and the row still leads the turn (D-4). A pause says {@code grace=n}.
     */
    @Test
    public void theRemoteRowSaysWhetherThePressIsCovered() {
        Host host = playing();
        host.send(EngineContract.Command.PAUSE);
        host.send(new EngineInput.Lifecycle(new EngineInput.LifecycleEvent.Background()));
        host.bgRemainingMs = 29_400.4;
        List<EngineCommand> press = host.send(new EngineInput.Remote(
                new EngineInput.RemotePress(MediaMapping.RemoteCommand.PLAY, null, "carAudio", true)));
        assertTrue("the remote row is the turn's first command: " + press,
                press.get(0) instanceof EngineCommand.Diag d && d.entry().kind().equals("remote"));
        EngineCommand.DiagEntry row = rows("remote", press).get(0);
        assertEquals(JsonNode.str("y"), row.field("grace"));
        assertEquals(JsonNode.str("remote-play"), row.field("graceReason"));
        assertEquals(JsonNode.num(29_400), row.field("bgRemainingMs"));
        assertEquals(JsonNode.str("carAudio"), row.field("route"));
        assertEquals("the state the press found", JsonNode.str("interrupted"), row.field("state"));

        host.land();
        host.confirm();
        EngineCommand.DiagEntry paused = rows("remote", host.send(remote(MediaMapping.RemoteCommand.PAUSE))).get(0);
        assertEquals(JsonNode.str("n"), paused.field("grace"));
        assertEquals(JsonNode.NULL, paused.field("graceReason"));

        host.bgRemainingMs = null;
        EngineCommand.DiagEntry foreground = rows("remote", host.send(remote(MediaMapping.RemoteCommand.PAUSE))).get(0);
        assertEquals("the foreground has no budget to report", JsonNode.NULL, foreground.field("bgRemainingMs"));
    }

    /**
     * Each resume writes one {@code resume} row (interruption or route) and a cold play one
     * {@code cold-play} row, as its span opens and before the activation it waits on.
     */
    @Test
    public void resumeAndColdPlayRowsCarryGrace() {
        Host host = playing();
        host.bgRemainingMs = 27_000.0;
        host.send(session(new EngineInput.SessionEvent.InterruptionBegan("default")));
        List<EngineCommand> resumed = host.send(session(new EngineInput.SessionEvent.InterruptionEnded(true)));
        List<EngineCommand.DiagEntry> resumes = rows("resume", resumed);
        assertEquals(resumed.toString(), 1, resumes.size());
        EngineCommand.DiagEntry resume = resumes.get(0);
        assertEquals(JsonNode.str("interruption"), resume.field("kind"));
        assertEquals(JsonNode.str("a"), resume.field("item"));
        assertEquals(JsonNode.str("y"), resume.field("grace"));
        assertEquals(JsonNode.str("interruption-resume"), resume.field("graceReason"));
        assertEquals(JsonNode.num(27_000), resume.field("bgRemainingMs"));
        int activate = index(resumed, c -> c instanceof EngineCommand.SessionActivate);
        int at = index(resumed, c -> c instanceof EngineCommand.Diag d && d.entry().kind().equals("resume"));
        if (activate >= 0) assertTrue("the row is written before the activation it waits on", at < activate);

        Host car = playing();
        car.bgRemainingMs = 12_000.0;
        car.send(session(new EngineInput.SessionEvent.Route(new EngineInput.RouteChange(true, "Civic", true))));
        List<EngineCommand> back = car.send(session(new EngineInput.SessionEvent.Route(new EngineInput.RouteChange(false, "Civic", false))));
        EngineCommand.DiagEntry route = rows("resume", back).get(0);
        assertEquals(JsonNode.str("route"), route.field("kind"));
        assertEquals(JsonNode.str("y"), route.field("grace"));
        assertEquals(JsonNode.str("route-resume"), route.field("graceReason"));
        assertEquals(JsonNode.num(12_000), route.field("bgRemainingMs"));

        Host cold = new Host();
        cold.bgRemainingMs = 25_000.0;
        List<EngineCommand> launched = cold.send(new EngineInput.Lifecycle(
                new EngineInput.LifecycleEvent.ColdLaunch(List.of(item("a")), 0, true)));
        EngineCommand.DiagEntry coldRow = rows("cold-play", launched).get(0);
        assertEquals(JsonNode.str("a"), coldRow.field("item"));
        assertEquals(JsonNode.num(0), coldRow.field("index"));
        assertEquals(JsonNode.str("y"), coldRow.field("grace"));
        assertEquals(JsonNode.str("cold-play"), coldRow.field("graceReason"));
        assertEquals(JsonNode.num(25_000), coldRow.field("bgRemainingMs"));

        // A foreground tap play is no resume and no cold play: no such rows.
        Host tap = new Host();
        tap.send(load("a"));
        List<EngineCommand> played = tap.send(playIndex(0));
        assertTrue(played.toString(), rows("resume", played).isEmpty() && rows("cold-play", played).isEmpty());
    }

    /** The resume is in place, INTERRUPTION_REWIND_SEC back, and a mic mute is a row, not a stop. */
    @Test
    public void interruptionsByReason() {
        Host host = playing();
        host.reading.positionSec = 42.5;
        List<EngineCommand> muted = host.send(session(new EngineInput.SessionEvent.InterruptionBegan("builtInMicMuted")));
        assertEquals("a muted mic takes nothing away", -1, firstSilencing(muted));
        assertEquals(SessionPolicy.Phase.ACTIVE, host.core.state().session);
        host.send(session(new EngineInput.SessionEvent.InterruptionBegan("default")));
        List<EngineCommand> resumed = host.send(session(new EngineInput.SessionEvent.InterruptionEnded(true)));
        assertTrue(resumed.toString(), loadsAt(resumed, 41));
    }

    /**
     * Plan §4.3: a pause the deck reports, followed within 500 ms by the route going away, is
     * the route's: a later call's should-resume does not bring it back (corner case #13).
     */
    @Test
    public void anUncommandedPauseThenARouteLossIsTheRoutes() {
        Host host = playing();
        host.reading.audible = false;
        host.send(new EngineInput.Deck(new DeckEvent.PausedUncommanded(host.lastLoad, 3)));
        assertFalse(host.core.state().pausedByRoute);
        List<EngineCommand> route = host.send(
                session(new EngineInput.SessionEvent.Route(new EngineInput.RouteChange(true, null, false))), 200);
        assertTrue(route.toString(),
                rows("session", route).stream().anyMatch(e -> JsonNode.str("route-attributed").equals(e.field("kind"))));
        assertEquals(-1, index(host.send(session(new EngineInput.SessionEvent.InterruptionEnded(true))), EngineCoreTest::isLoad));
    }

    /** Toggle reads the deck, not only the belief: an audible deck behind a paused machine is paused by the press. */
    @Test
    public void toggleFromNativeTruth() {
        Host host = playing();
        host.send(EngineContract.Command.PAUSE);
        host.reading.audible = true;
        List<EngineCommand> out = host.send(EngineContract.Command.TOGGLE);
        assertTrue(out.toString(), index(out, EngineCoreTest::isPause) >= 0);
        assertEquals(-1, index(out, EngineCoreTest::isLoad));
        host.reading.audible = false;
        assertTrue("a silent deck: the press plays", index(host.send(EngineContract.Command.TOGGLE), EngineCoreTest::isLoad) >= 0);
    }

    /** A remote stop is a pause (T-7): nothing is torn down, nothing released. */
    @Test
    public void aRemoteStopIsAPause() {
        Host host = playing();
        List<EngineCommand> out = host.send(remote(MediaMapping.RemoteCommand.STOP));
        assertTrue(index(out, EngineCoreTest::isPause) >= 0);
        assertEquals(-1, index(out, EngineCoreTest::isDeactivate));
        assertTrue(stopRow(Vocabulary.StopCause.PAUSE, out) >= 0);
        assertEquals("interrupted", host.core.state().stateType());
    }

    /** T-8: a second press inside the window is RECORDED as a dup candidate and still handled. */
    @Test
    public void duplicateRemotePressesAreRecordedNotDropped() {
        Host host = playing();
        EngineInput skip = remote(MediaMapping.RemoteCommand.SKIP_FORWARD);
        assertEquals(JsonNode.str("n"), rows("remote", host.send(skip, 5000)).get(0).field("dupCandidate"));
        List<EngineCommand> second = host.send(skip, 120);
        assertEquals(JsonNode.str("y"), rows("remote", second).get(0).field("dupCandidate"));
        assertTrue("handled, not dropped", index(second, EngineCoreTest::isSeek) >= 0);
        assertEquals(JsonNode.str("n"), rows("remote", host.send(skip, 900)).get(0).field("dupCandidate"));
    }

    /** The rate reaches the deck on every play, including a resume. */
    @Test
    public void rateOnEveryPlay() {
        Host host = playing();
        host.send(new EngineInput.Queue(new QueueInput.SetRate(1.5)));
        host.send(session(new EngineInput.SessionEvent.InterruptionBegan("default")));
        host.send(session(new EngineInput.SessionEvent.InterruptionEnded(true)));
        assertEquals(Arrays.asList(new EngineCommand.Deck(new DeckCommand.SetRate(1.5)), new EngineCommand.Deck(DeckCommand.PLAY)),
                deckOnly(host.land()));
    }

    /** Seeks with nothing loaded ride on the next load; seeks while loading are held for it; while paused they move the deck. */
    @Test
    public void seeksWhileIdleLoadingAndPaused() {
        Host idle = new Host();
        idle.send(new EngineInput.Lifecycle(new EngineInput.LifecycleEvent.ColdLaunch(List.of(item("a")), 0, false)));
        List<EngineCommand> pended = idle.send(new EngineContract.Command.SeekTo(600));
        assertEquals("nothing loaded: nothing to seek", List.of(), deckOnly(pended));
        assertTrue(loadsAt(idle.send(EngineContract.Command.PLAY), 600));

        Host loading = new Host();
        loading.send(load("a"));
        loading.send(playIndex(0));
        assertEquals("held for the load", -1, index(loading.send(new EngineContract.Command.SeekTo(90)), EngineCoreTest::isSeek));
        assertEquals(Arrays.asList(new EngineCommand.Deck(new DeckCommand.SetRate(1)), new EngineCommand.Deck(new DeckCommand.Seek(90)),
                new EngineCommand.Deck(DeckCommand.PLAY)), deckOnly(loading.land()));

        Host paused = playing();
        paused.send(EngineContract.Command.PAUSE);
        List<EngineCommand> moved = paused.send(new EngineContract.Command.SeekTo(120));
        assertTrue(moved.toString(), moved.contains(new EngineCommand.Deck(new DeckCommand.Seek(120))));
        assertEquals("a seek while paused stays paused", -1, index(moved, EngineCoreTest::isPlay));
    }

    /**
     * Audit round 2, p-impatient-1: a nudge tapped while a resumed episode is still loading
     * steps from the second the load will land on, never from 0:00.
     */
    @Test
    public void aNudgeDuringAColdLoadStepsFromWhereTheLoadLands() {
        Host host = new Host(Map.of("a", new ResumeRules.StoredPosition(2280, null)));
        host.send(load("a"));
        List<EngineCommand> started = host.send(playIndex(0));
        assertTrue("the cold load resumes: " + started, loadsAt(started, 2280));
        List<EngineCommand> nudged = host.send(new EngineContract.Command.SeekBy(-15));
        assertEquals("held for the load: " + nudged, -1, index(nudged, EngineCoreTest::isSeek));
        List<EngineCommand> landed = host.land();
        assertTrue("15 s before the resume point: " + landed, landed.contains(new EngineCommand.Deck(new DeckCommand.Seek(2265))));
    }

    /**
     * Audit round 2, player-3: a scrub made while paused is written for the outgoing episode
     * before playing another one moves the queue on.
     */
    @Test
    public void playingAnotherEpisodeKeepsAScrubMadeWhilePaused() {
        Host host = new Host();
        host.send(episode("a"));
        host.land();
        host.confirm();
        host.reading.positionSec = 600.0;
        host.send(EngineContract.Command.PAUSE);
        host.send(new EngineContract.Command.SeekTo(1800));
        assertEquals("precondition: the deck moved", Double.valueOf(1800), host.reading.positionSec);
        List<EngineCommand> left = host.send(episode("b"));
        int wrote = index(left, c -> c instanceof EngineCommand.WritePosition w && w.write().itemId().equals("a")
                && w.write().seconds() == 1800);
        int loadB = index(left, c -> c instanceof EngineCommand.Deck d && d.command() instanceof DeckCommand.Load l
                && l.itemId().equals("b"));
        assertTrue("the scrub is what was kept: " + left, wrote >= 0);
        assertTrue(left.toString(), loadB >= 0);
        assertTrue("written before the queue moved on", wrote < loadB);
    }

    /** Hold policy {@code none}: the pause releases the session (no notify) after the deck is silent; the next play activates again. */
    @Test
    public void holdPolicyNoneReleasesAtPause() {
        Host host = playing(new EngineConfig("test", SessionPolicy.HoldPolicy.NONE, null));
        List<EngineCommand> out = host.send(EngineContract.Command.PAUSE);
        int pause = index(out, EngineCoreTest::isPause);
        int release = index(out, c -> c.equals(new EngineCommand.SessionDeactivate(false)));
        assertTrue(out.toString(), pause >= 0 && release >= 0);
        assertTrue("silent before released", pause < release);
        List<EngineCommand> again = host.send(EngineContract.Command.PLAY);
        assertEquals(again.toString(), 1, again.stream().filter(c -> c instanceof EngineCommand.SessionActivate).count());
    }

    // ---- A-42: a remote press in a Foray is on the Foray's clock

    /** A clip of a built Foray ({@code f1#<index>}), as ForayTapeScenarioTest.clip. */
    static JsonNode forayClip(int index, double start, double end) {
        return obj("id", JsonNode.str("f1#" + index), "kind", JsonNode.str("episode"),
                "audio_url", JsonNode.str("https://cdn.test/c" + index + ".mp3"),
                "start_sec", JsonNode.num(start), "end_sec", JsonNode.num(end), "duration_sec", JsonNode.num(3600));
    }

    /** What the deck is told after {@code press}, in a three-clip Foray (100 s each) playing clip 0 at source {@code atSec}. */
    static List<DeckCommand> deckAfterRemoteInAForay(double atSec, EngineInput.RemotePress press) {
        Host host = new Host(new EngineConfig("test").withForayTape(true, false));
        host.send(new EngineContract.Command.PlayForay("f1", "Three",
                List.of(forayClip(0, 100, 200), forayClip(1, 300, 400), forayClip(2, 500, 600)),
                new JsonNode.Obj(List.of()), null, false, false, null));
        host.land();
        host.confirm();
        assertTrue("the Foray is playing clip 0", host.core.state().isRunning() && host.core.state().currentIndex == 0);
        host.reading.positionSec = atSec;
        List<DeckCommand> deck = new ArrayList<>();
        for (EngineCommand c : host.send(new EngineInput.Remote(press))) {
            if (c instanceof EngineCommand.Deck d) deck.add(d.command());
        }
        return deck;
    }

    /**
     * A lock-screen or car press in a Foray is on the FORAY's clock, the one the surface publishes
     * ({@code forayMediaView}), as client.js's forayMediaSurface routes it (foraySeek, nudgeBy). A
     * scrub to 150 s is 50 s into the second clip (source 350); a 30 s skip from clip 0's source
     * second 190 (Foray 90) is 20 s into the second clip (source 320). MUTATION: send the remote
     * changePlaybackPosition or skip down the episode path (A-40's onRemote): the scrub seeks clip
     * 0's source to 150, and the skip to 220, past its 200 s out-point into the rest of the episode.
     */
    @Test
    public void aRemoteScrubOrSkipInAForayIsOnTheForayClock() {
        List<DeckCommand> scrub = deckAfterRemoteInAForay(110,
                new EngineInput.RemotePress(MediaMapping.RemoteCommand.CHANGE_PLAYBACK_POSITION, 150.0, null, true));
        assertTrue("a scrub to Foray 150 s loads the second clip at source 350: " + scrub, scrub.stream().anyMatch(
                c -> c instanceof DeckCommand.Load l && l.itemId().equals("f1#1") && Math.abs(l.startSec() - 350) < 0.01));
        assertFalse("never clip 0's source second 150: " + scrub, scrub.stream().anyMatch(c -> c instanceof DeckCommand.Seek));
        List<DeckCommand> skip = deckAfterRemoteInAForay(190,
                new EngineInput.RemotePress(MediaMapping.RemoteCommand.SKIP_FORWARD, null, null, true));
        assertTrue("a 30 s skip from Foray 90 s loads the second clip at source 320: " + skip, skip.stream().anyMatch(
                c -> c instanceof DeckCommand.Load l && l.itemId().equals("f1#1") && Math.abs(l.startSec() - 320) < 0.01));
        assertFalse("never past clip 0's out-point: " + skip, skip.stream().anyMatch(c -> c instanceof DeckCommand.Seek));
        List<DeckCommand> back = deckAfterRemoteInAForay(150,
                new EngineInput.RemotePress(MediaMapping.RemoteCommand.SKIP_BACKWARD, null, null, true));
        assertTrue("a 15 s skip back inside clip 0 is a seek on its source (Foray 50 s -> source 135): " + back, back.stream().anyMatch(
                c -> c instanceof DeckCommand.Seek s && Math.abs(s.toSec() - 135) < 0.01));
    }
}
