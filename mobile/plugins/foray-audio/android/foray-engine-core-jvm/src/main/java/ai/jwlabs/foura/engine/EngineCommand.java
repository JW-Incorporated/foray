package ai.jwlabs.foura.engine;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/**
 * WHAT COMES OUT OF {@link EngineCore#handle} (docs/native-engine-plan.md §4.2): the JVM
 * twin of {@code EngineCommand} and the types it carries in ForayEngineCore
 * (Engine/EngineCommand.swift, NE-14s).
 *
 * <p>The core never touches ExoPlayer, audio focus, the media session, storage or a timer.
 * It returns these, in order, and the host interprets each through its seam (A-25, A-26).
 * ORDER IS THE CONTRACT: "the stop row before the pause", "the activation before the play"
 * and "the save before the load" are claims about positions in this list, and the parity
 * driver and the JUnit tests assert them there.
 *
 * <p>The narrating overlay's commands, the jingle's and the silence node's arrive with
 * A-41 and A-40.
 */
public sealed interface EngineCommand permits EngineCommand.Deck, EngineCommand.SessionActivate, EngineCommand.SessionDeactivate,
        EngineCommand.SessionReapplyCategory, EngineCommand.SessionRebuild, EngineCommand.GraceBegin, EngineCommand.GraceEnd,
        EngineCommand.TimerArm, EngineCommand.TimerCancel, EngineCommand.WritePosition, EngineCommand.WriteRow,
        EngineCommand.AppendEvent, EngineCommand.WriteRestore, EngineCommand.Speak, EngineCommand.Emit, EngineCommand.Diag,
        EngineCommand.CommandFailed {

    record Deck(DeckCommand command) implements EngineCommand {}

    /**
     * Activate the audio session and answer with a {@link EngineInput.SessionAnswer} for this
     * id IN THE SAME TURN (plan §4.2). Nothing audible is emitted until then.
     */
    record SessionActivate(int requestId) implements EngineCommand {}

    /**
     * {@code notifyOthers} only for a close, a final end or a data deletion: a pause or a
     * relinquish never invites the app we interrupted back.
     */
    record SessionDeactivate(boolean notifyOthers) implements EngineCommand {}

    record SessionReapplyCategory() implements EngineCommand {}

    record SessionRebuild() implements EngineCommand {}

    record GraceBegin(GraceReason reason) implements EngineCommand {}

    record GraceEnd(GraceOutcome outcome) implements EngineCommand {}

    record TimerArm(EngineTimer timer, double afterMs, boolean repeating) implements EngineCommand {}

    record TimerCancel(EngineTimer timer) implements EngineCommand {}

    record WritePosition(PositionWrite write) implements EngineCommand {}

    /** A shared row the page also reads ({@code cp_last_episode}). */
    record WriteRow(Rows.StoredRow row) implements EngineCommand {}

    record AppendEvent(PendingEvent event) implements EngineCommand {}

    /** The engine-private restore record; null removes it (data deletion). */
    record WriteRestore(RestoreRecord record) implements EngineCommand {}

    /** Speak an audition line (OQ-5): audible, so it follows an activation. */
    record Speak(String text, String voiceId) implements EngineCommand {}

    record Emit(EngineEvent event) implements EngineCommand {}

    record Diag(DiagEntry entry) implements EngineCommand {}

    /** The command did not happen; the reason is a contract refusal token. */
    record CommandFailed(String reason) implements EngineCommand {}

    EngineCommand SESSION_REAPPLY_CATEGORY = new SessionReapplyCategory();
    EngineCommand SESSION_REBUILD = new SessionRebuild();

    /**
     * The command's name in a turn, as {@link SessionPolicy#audibleStartViolations} reads it:
     * {@code deckPlay} and {@code speak} are audible; {@code sessionActivate} and
     * {@code sessionDeactivate} move the session.
     */
    static String turnName(EngineCommand command) {
        return switch (command) {
            case Deck d -> switch (d.command()) {
                case DeckCommand.Load x -> "deckLoad";
                case DeckCommand.Play x -> "deckPlay";
                case DeckCommand.Pause x -> "deckPause";
                case DeckCommand.Seek x -> "deckSeek";
                case DeckCommand.SetRate x -> "deckSetRate";
                case DeckCommand.SetOutPoint x -> "deckSetOutPoint";
                case DeckCommand.Unload x -> "deckUnload";
            };
            case SessionActivate x -> SessionPolicy.TurnMarker.ACTIVATE;
            case SessionDeactivate x -> SessionPolicy.TurnMarker.DEACTIVATE;
            case SessionReapplyCategory x -> "sessionReapplyCategory";
            case SessionRebuild x -> "sessionRebuild";
            case GraceBegin x -> "graceBegin";
            case GraceEnd x -> "graceEnd";
            case TimerArm x -> "timerArm";
            case TimerCancel x -> "timerCancel";
            case WritePosition x -> "writePosition";
            case WriteRow x -> "writeRow";
            case AppendEvent x -> "appendEvent";
            case WriteRestore x -> "writeRestore";
            case Speak x -> "speak";
            case Emit x -> "emit";
            case Diag x -> "diag";
            case CommandFailed x -> "commandFailed";
        };
    }

    /**
     * Why a grace span was begun: a span that is silent while the engine intends to play
     * (plan §4.4). The host holds the process awake (iOS: a background task; Android: the
     * foreground service, A-26) until the deck confirms playing, the intent ends, or the span
     * expires. The seam spans arrive with A-40 and the narration handover with A-41.
     */
    enum GraceReason {
        REMOTE_PLAY("remote-play"),
        BACKGROUND_TAP("background-tap"),
        INTERRUPTION_RESUME("interruption-resume"),
        ROUTE_RESUME("route-resume"),
        COLD_PLAY("cold-play"),
        /** The next episode of a continuation chain loading after an end. */
        AUTO_ADVANCE("auto-advance");

        public final String token;

        GraceReason(String token) {
            this.token = token;
        }
    }

    /** How a grace span ended. Every begin has exactly one of these. */
    enum GraceOutcome {
        /** The deck confirmed it is playing. */
        PLAYING("playing"),
        /** The intent ended without sound: a pause, a stop, a failed load, a refused activation. */
        NOT_RUNNING("not-running"),
        /** The span's expiration fired first. */
        EXPIRED("expired"),
        RELINQUISHED("relinquished");

        public final String token;

        GraceOutcome(String token) {
            this.token = token;
        }
    }

    /**
     * A {@code cp_pos:<id>} write: the row's exact bytes ({@link Rows#position}) and the facts
     * it was built from, for the diagnostics and the parity driver.
     */
    record PositionWrite(String itemId, double seconds, Double duration, Rows.StoredRow row) {}

    /**
     * One entry of the bounded {@code pendingEvents} log the page drains on attach (plan
     * §5.5): {@code {seq, kind: "position", episode_id, seconds, duration, at}}.
     */
    record PendingEvent(int seq, String kind, String episodeId, double seconds, Double duration, double atMs) {
        /** {@code $defs.pendingEvent}, as the contract and the restore record carry it. */
        public JsonNode node() {
            List<JsonNode.Member> members = new ArrayList<>();
            members.add(JsonNode.member("seq", JsonNode.num(seq)));
            members.add(JsonNode.member("kind", JsonNode.str(kind)));
            members.add(JsonNode.member("episode_id", JsonNode.str(episodeId)));
            members.add(JsonNode.member("seconds", JsonNode.num(seconds)));
            members.add(JsonNode.member("duration", duration == null ? JsonNode.NULL : JsonNode.num(duration)));
            members.add(JsonNode.member("at", JsonNode.num(atMs)));
            return new JsonNode.Obj(members);
        }
    }

    /** One walked continuation hop (plan §5.5): the page applies it on attach, idempotently, and acks it by {@code seq}. */
    record AdvanceEntry(int seq, EngineContract.Hop hop, double atMs) {
        /** The hop as sent, plus {@code seq} and {@code at}. */
        public JsonNode node() {
            List<JsonNode.Member> members = new ArrayList<>();
            List<JsonNode.Member> sent = hop.node().members();
            if (sent != null) {
                for (JsonNode.Member m : sent) {
                    if (!m.key().equals("seq") && !m.key().equals("at")) members.add(m);
                }
            }
            members.add(JsonNode.member("seq", JsonNode.num(seq)));
            members.add(JsonNode.member("at", JsonNode.num(atMs)));
            return new JsonNode.Obj(members);
        }
    }

    /** A diagnostics row before the ring stamps it ({@code seq}, {@code at}, {@code mono} are the ring's). */
    record DiagEntry(String kind, List<JsonNode.Member> fields) {
        public DiagEntry {
            Objects.requireNonNull(kind, "kind");
            fields = Collections.unmodifiableList(new ArrayList<>(fields));
        }

        /** The last field named {@code key}, or null. */
        public JsonNode field(String key) {
            JsonNode found = null;
            for (JsonNode.Member m : fields) if (m.key().equals(key)) found = m.value();
            return found;
        }
    }

    /** Events for the page (plan §5.4), best effort. {@code skipped} arrives with the Foray tape (A-40). */
    sealed interface EngineEvent permits EngineEvent.Advanced, EngineEvent.Error {
        /** A continuation hop was walked (source autoadvance, or a next press). */
        record Advanced(AdvanceEntry entry) implements EngineEvent {}

        /** {@code error{code}}: {@code chain-start} when a hop's start failed (C-6), {@code load} for any other failed item. */
        record Error(String code, String message) implements EngineEvent {}
    }
}
