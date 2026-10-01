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
 * <p>The narrating overlay's commands ({@code narration}, {@code narrationPulse}), the jingle's
 * ({@code interlude}) and the silence node's came with the Foray tape (A-40), as the core's
 * rules; the host's synthesiser and jingle player are A-41's.
 */
public sealed interface EngineCommand permits EngineCommand.Deck, EngineCommand.SessionActivate, EngineCommand.SessionDeactivate,
        EngineCommand.SessionReapplyCategory, EngineCommand.SessionRebuild, EngineCommand.GraceBegin, EngineCommand.GraceEnd,
        EngineCommand.TimerArm, EngineCommand.TimerCancel, EngineCommand.WritePosition, EngineCommand.WriteRow,
        EngineCommand.AppendEvent, EngineCommand.WriteRestore, EngineCommand.Speak, EngineCommand.Emit, EngineCommand.Diag,
        EngineCommand.CommandFailed, EngineCommand.Narration, EngineCommand.Interlude, EngineCommand.SilenceStart,
        EngineCommand.SilenceStop, EngineCommand.NarrationPulse, EngineCommand.Preview {

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

    /**
     * The PREVIEW deck (NE-47, A-66): an audition's rendered {@code preview.m4a}. Only
     * {@code load}, {@code play} and {@code unload} are ever sent; the play is audible, so the
     * invariant reads it as a {@code deckPlay} and it follows an activation.
     */
    record Preview(DeckCommand command) implements EngineCommand {}

    record Emit(EngineEvent event) implements EngineCommand {}

    record Diag(DiagEntry entry) implements EngineCommand {}

    /** The command did not happen; the reason is a contract refusal token. */
    record CommandFailed(String reason) implements EngineCommand {}

    /** The synthesiser, about one utterance (a spoken Foray line). */
    record Narration(NarrationCommand command) implements EngineCommand {}

    /** The jingle player. */
    record Interlude(InterludeCommand command) implements EngineCommand {}

    /** Digital silence across a silent seam, capped (NE-34's node, flagged off). */
    record SilenceStart(double capMs) implements EngineCommand {}

    record SilenceStop() implements EngineCommand {}

    /**
     * The surface's narration pulse ({@code onNarrationTick}): a repaint, not an act on the world. A
     * SPOKEN line only: a RENDERED line is an ordinary deck item (A-62, NE-45s), and the deck's own
     * position is its clock, so it is never pulsed.
     */
    record NarrationPulse(double elapsedSec) implements EngineCommand {}

    /** What the core asks the synthesiser, by the utterance's {@code seq}. */
    sealed interface NarrationCommand permits NarrationCommand.Speak, NarrationCommand.Pause, NarrationCommand.Resume,
            NarrationCommand.Stop, NarrationCommand.Discard {
        /** Speak {@code text}; answered {@code started} or {@code failed} for {@code seq}. */
        record Speak(int seq, String text, String voiceId, double utteranceRate) implements NarrationCommand {}

        /** Hold at a word (L-05). */
        record Pause(int seq) implements NarrationCommand {}

        /** Continue the same utterance; answered {@code resumed}. */
        record Resume(int seq) implements NarrationCommand {}

        /** Silence it now; the line stays the playhead. */
        record Stop(int seq) implements NarrationCommand {}

        /** Forget a paused line nobody will continue (a deck item took the playhead). */
        record Discard(int seq) implements NarrationCommand {}
    }

    /** What the core asks the jingle player. */
    enum InterludeCommand {
        START,
        STOP,
        RELEASE
    }

    EngineCommand SILENCE_STOP = new SilenceStop();

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
                case DeckCommand.Prepare x -> "deckPrepare";
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
            case Narration n -> switch (n.command()) {
                // Both make a line audible, so both are `speak` to the invariant.
                case NarrationCommand.Speak x -> "speak";
                case NarrationCommand.Resume x -> "speak";
                case NarrationCommand.Pause x -> "narrationPause";
                case NarrationCommand.Stop x -> "narrationStop";
                case NarrationCommand.Discard x -> "narrationDiscard";
            };
            case Interlude i -> switch (i.command()) {
                case START -> "interludeStart";
                case STOP -> "interludeStop";
                case RELEASE -> "interludeRelease";
            };
            case SilenceStart x -> "silenceStart";
            case SilenceStop x -> "silenceStop";
            case NarrationPulse x -> "narrationPulse";
            case Preview p -> switch (p.command()) {
                // Audible exactly as the main deck's play is.
                case DeckCommand.Play x -> "deckPlay";
                case DeckCommand.Load x -> "previewLoad";
                case DeckCommand.Unload x -> "previewUnload";
                case DeckCommand.Pause x -> "preview";
                case DeckCommand.Seek x -> "preview";
                case DeckCommand.SetRate x -> "preview";
                case DeckCommand.SetOutPoint x -> "preview";
                case DeckCommand.Prepare x -> "preview";
            };
        };
    }

    /**
     * Why a grace span was begun: a span that is silent while the engine intends to play
     * (plan §4.4). The host holds the process awake (iOS: a background task; Android: the
     * foreground service, A-26) until the deck confirms playing, the intent ends, or the span
     * expires. The seam spans and the narration handover came with the Foray tape (A-40).
     */
    enum GraceReason {
        REMOTE_PLAY("remote-play"),
        BACKGROUND_TAP("background-tap"),
        INTERRUPTION_RESUME("interruption-resume"),
        ROUTE_RESUME("route-resume"),
        COLD_PLAY("cold-play"),
        /** The next episode of a continuation chain loading after an end. */
        AUTO_ADVANCE("auto-advance"),
        /** A Foray seam in the background whose next item the standby deck had prepared. */
        SEAM("seam"),
        /** A Foray seam in the background with no prepared next item. */
        PREPARE_MISS("prepare-miss"),
        /** A spoken line ended in the background and the next item is not audible yet. */
        NARRATION_HANDOVER("narration-handover");

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

        /**
         * An entry read back from the restore record (card A-27; Swift
         * {@code PendingEvent(restored:)}), or null for one this build cannot trust: a
         * {@code seq} that is not a non-negative integer, no kind, no episode id, or a
         * non-finite {@code seconds} or {@code at}. A duration that is not a finite number is
         * none.
         */
        public static PendingEvent restored(JsonNode node) {
            if (node == null) return null;
            Double seq = node.get("seq") == null ? null : node.get("seq").numberValue();
            String kind = node.get("kind") == null ? null : node.get("kind").stringValue();
            String episodeId = node.get("episode_id") == null ? null : node.get("episode_id").stringValue();
            Double seconds = node.get("seconds") == null ? null : node.get("seconds").numberValue();
            Double at = node.get("at") == null ? null : node.get("at").numberValue();
            if (!isCount(seq) || kind == null || episodeId == null || episodeId.isEmpty()) return null;
            if (seconds == null || !Double.isFinite(seconds) || at == null || !Double.isFinite(at)) return null;
            Double duration = node.get("duration") == null ? null : node.get("duration").numberValue();
            if (duration != null && !Double.isFinite(duration)) duration = null;
            return new PendingEvent(seq.intValue(), kind, episodeId, seconds, duration, at);
        }
    }

    /** {@code ContractRead.nonNegativeInt}: a finite, whole, non-negative number (that fits an int). */
    private static boolean isCount(Double value) {
        return value != null && Double.isFinite(value) && value >= 0 && value == Math.rint(value) && value <= Integer.MAX_VALUE;
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

        /**
         * An entry read back from the restore record (card A-27; Swift
         * {@code AdvanceEntry(restored:)}): {@code seq} and {@code at}, and the hop itself as
         * {@code $defs.hop} reads it ({@code planSeq} and {@code hopSeq} non-negative integers,
         * a non-empty {@code nextId}; the rest kept as stored). Null for anything else.
         */
        public static AdvanceEntry restored(JsonNode node) {
            if (node == null || node.members() == null) return null;
            Double seq = node.get("seq") == null ? null : node.get("seq").numberValue();
            Double at = node.get("at") == null ? null : node.get("at").numberValue();
            Double planSeq = node.get("planSeq") == null ? null : node.get("planSeq").numberValue();
            Double hopSeq = node.get("hopSeq") == null ? null : node.get("hopSeq").numberValue();
            String nextId = node.get("nextId") == null ? null : node.get("nextId").stringValue();
            if (!isCount(seq) || at == null || !Double.isFinite(at)) return null;
            if (!isCount(planSeq) || !isCount(hopSeq) || nextId == null || nextId.isEmpty()) return null;
            return new AdvanceEntry(seq.intValue(), new EngineContract.Hop(planSeq.intValue(), hopSeq.intValue(), nextId, node), at);
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

    /** Events for the page (plan §5.4), best effort. */
    sealed interface EngineEvent permits EngineEvent.Advanced, EngineEvent.Error, EngineEvent.Skipped {
        /** A continuation hop was walked (source autoadvance, or a next press). */
        record Advanced(AdvanceEntry entry) implements EngineEvent {}

        /** {@code error{code}}: {@code chain-start} when a hop's start failed (C-6), {@code load} for any other failed item. */
        record Error(String code, String message) implements EngineEvent {}

        /** ADR-0007's ladder refused a segment at load: it is never audible, and the Foray moves on. */
        record Skipped(String itemId, int index, String reason) implements EngineEvent {}
    }
}
