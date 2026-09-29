package ai.jwlabs.foura.engine;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * The audio session's policy: the port of {@code sessionTransition} and
 * {@code audibleStartViolations} in {@code player/engine-contract.js}
 * (docs/native-engine-plan.md §4.4), and the JVM twin of {@code SessionPolicy} in
 * ForayEngineCore (Policy/SessionPolicy.swift, NE-11s). The {@code session} and
 * {@code session-invariant} parity families are the contract.
 *
 * <p>A PURE TABLE: the whole decision is one function of (phase, input, holdPolicy), and
 * the platform half (iOS's AudioSessionOwner; on Android, audio focus and the
 * MediaSessionService, A-26) only carries out the actions it returns.
 *
 * <p>ACTIVATION IS A REQUEST AND A RESPONSE: an edge that needs the session emits
 * {@code activate} and LEAVES THE PHASE WHERE IT WAS; only an ok {@code sessionResult}
 * moves it to {@code active}. So nothing reports active on the strength of an activation
 * that has not happened, which is what makes the audible-start invariant checkable.
 *
 * <p>Every closed set's tokens are the generated {@link EngineConstants.EngineContract}
 * lists; the parity family reads them from these enums, and a JUnit test holds the two to
 * one order.
 */
public final class SessionPolicy {
    private SessionPolicy() {}

    /** {@code SESSION_PHASES}. {@code RELINQUISHED} is terminal. */
    public enum Phase {
        INACTIVE("inactive"),
        ACTIVE("active"),
        LOST_TO_INTERRUPTION("lostToInterruption"),
        RELINQUISHED("relinquished");

        public final String token;

        Phase(String token) {
            this.token = token;
        }

        public static Phase of(String token) {
            for (Phase v : values()) if (v.token.equals(token)) return v;
            return null;
        }
    }

    /** {@code PLAY_VIAS}: what caused a play the session may activate for (a user-caused play only). */
    public enum PlayVia {
        TAP("tap"),
        REMOTE("remote"),
        AUTORESUME("autoresume"),
        AUDITION_TAP("auditionTap");

        public final String token;

        PlayVia(String token) {
            this.token = token;
        }

        public static PlayVia of(String token) {
            for (PlayVia v : values()) if (v.token.equals(token)) return v;
            return null;
        }
    }

    /**
     * {@code SESSION_ACTIONS}. {@code DEACTIVATE} releases with no notify;
     * {@code DEACTIVATE_NOTIFY} is reserved for the three endings that mean "4a is done"
     * (close, final end, data deletion): notifying at a pause would invite the app 4a
     * interrupted to take the car back mid-episode.
     */
    public enum Action {
        ACTIVATE("activate"),
        DEACTIVATE("deactivate"),
        DEACTIVATE_NOTIFY("deactivate-notify"),
        REAPPLY_CATEGORY("reapply-category"),
        REBUILD("rebuild"),
        COMMAND_FAILED("command-failed");

        public final String token;

        Action(String token) {
            this.token = token;
        }
    }

    /** {@code SESSION_ROWS}: the row an edge writes when the policy deliberately IGNORED an input. */
    public enum Row {
        STALE_SUSPENSION("stale-suspension"),
        MIC_MUTED("mic-muted"),
        STALE_HOLD("stale-hold"),
        MEDIA_SERVICES_RESET("media-services-reset");

        public final String token;

        Row(String token) {
            this.token = token;
        }
    }

    /** {@code SESSION_INPUTS}, as names, in the JS table's order. */
    public enum InputKind {
        USER_PLAY("userPlay"),
        SESSION_RESULT("sessionResult"),
        PAUSE("pause"),
        BEAT("beat"),
        NARRATION("narration"),
        BACKGROUND("background"),
        HOLD_EXPIRED("holdExpired"),
        INTERRUPTION_BEGAN("interruptionBegan"),
        INTERRUPTION_ENDED("interruptionEnded"),
        MEDIA_SERVICES_RESET("mediaServicesReset"),
        RELINQUISH("relinquish"),
        CLOSE("close"),
        FINAL_END("finalEnd"),
        DATA_DELETION("dataDeletion");

        public final String token;

        InputKind(String token) {
            this.token = token;
        }

        public static InputKind of(String token) {
            for (InputKind v : values()) if (v.token.equals(token)) return v;
            return null;
        }
    }

    /**
     * One input, with the fields its edge reads. Where JS reads a field with
     * {@code === true}, the field is a plain boolean: only a real {@code true} is true
     * there, and the adapter that builds the input says so.
     */
    public sealed interface Input permits Input.UserPlay, Input.SessionResult, Input.Simple, Input.HoldExpired,
            Input.InterruptionBegan, Input.InterruptionEnded {
        InputKind kind();

        record UserPlay(PlayVia via) implements Input {
            public InputKind kind() {
                return InputKind.USER_PLAY;
            }
        }

        /** The answer to {@code activate}. {@code token}: the failure's session error (admitted by {@link #sessionFailedReason}). */
        record SessionResult(boolean ok, String token) implements Input {
            public InputKind kind() {
                return InputKind.SESSION_RESULT;
            }
        }

        /**
         * An input that carries no fields: pause, beat, narration, background,
         * mediaServicesReset, relinquish, close, finalEnd, dataDeletion.
         */
        record Simple(InputKind kind) implements Input {
            public Simple {
                switch (kind) {
                    case USER_PLAY, SESSION_RESULT, HOLD_EXPIRED, INTERRUPTION_BEGAN, INTERRUPTION_ENDED ->
                            throw new IllegalArgumentException(kind.token + " carries fields; use its own record");
                    default -> {}
                }
            }
        }

        /** {@code running}: whether the engine is audibly running when the hold timer fires. */
        record HoldExpired(boolean running) implements Input {
            public InputKind kind() {
                return InputKind.HOLD_EXPIRED;
            }
        }

        /** {@code reason} is already admitted ({@link #interruptionReason}); {@code activatedInProcess}: THIS process activated. */
        record InterruptionBegan(Vocabulary.InterruptionReason reason, boolean running, boolean activatedInProcess) implements Input {
            public InterruptionBegan {
                if (reason == null) throw new IllegalArgumentException("admit the reason with interruptionReason()");
            }

            public InputKind kind() {
                return InputKind.INTERRUPTION_BEGAN;
            }
        }

        record InterruptionEnded(boolean shouldResume, boolean wasPlaying) implements Input {
            public InputKind kind() {
                return InputKind.INTERRUPTION_ENDED;
            }
        }
    }

    /**
     * {@code pauseHoldPolicy}: hold the session through any pause ({@code forever}, the
     * default), release it at a pause ({@code none}), or release it after {@code until:<m>}
     * minutes of pause. One string, so it round-trips through storage and a Developer row.
     */
    public record HoldPolicy(String kind, int minutes) {
        /** {@code HOLD_POLICY_KINDS}, in order. */
        public static final List<String> KINDS = Collections.unmodifiableList(Arrays.asList("forever", "none", "until"));

        public static final HoldPolicy FOREVER = new HoldPolicy("forever", 0);
        public static final HoldPolicy NONE = new HoldPolicy("none", 0);
        /** {@code DEFAULT_HOLD_POLICY}. */
        public static final HoldPolicy DEFAULT = FOREVER;

        public HoldPolicy {
            if (!KINDS.contains(kind) || (kind.equals("until") ? minutes <= 0 : minutes != 0)) {
                throw new IllegalArgumentException("not a hold policy: " + kind + " " + minutes);
            }
        }

        public static HoldPolicy until(int minutes) {
            return new HoldPolicy("until", minutes);
        }

        /**
         * {@code parseHoldPolicy(policy)}: {@code forever}, {@code none}, or {@code until:<m>}
         * with m a positive whole number of at most six ASCII digits and nothing else
         * ({@code /^until:([1-9][0-9]{0,5})$/}); anything else is null.
         */
        public static HoldPolicy parse(String text) {
            if (text == null) return null;
            if (text.equals("forever")) return FOREVER;
            if (text.equals("none")) return NONE;
            String prefix = "until:";
            if (!text.startsWith(prefix)) return null;
            String rest = text.substring(prefix.length());
            if (rest.isEmpty() || rest.length() > 6 || rest.charAt(0) == '0') return null;
            int minutes = 0;
            for (int i = 0; i < rest.length(); i++) {
                char c = rest.charAt(i);
                if (c < '0' || c > '9') return null;
                minutes = minutes * 10 + (c - '0');
            }
            return until(minutes);
        }

        /** The stored / logged spelling: the inverse of {@link #parse}. */
        public String text() {
            return kind.equals("until") ? "until:" + minutes : kind;
        }

        public boolean isUntil() {
            return kind.equals("until");
        }
    }

    /** One edge's outcome ({@code {phase, actions, row, reason}} in the JS). {@code row}, {@code reason}: null when absent. */
    public record Transition(Phase phase, List<Action> actions, Row row, String reason) {
        public Transition {
            actions = Collections.unmodifiableList(new ArrayList<>(actions));
        }
    }

    /**
     * {@code sessionFailedReason(token)}: {@code session-failed:<token>}, a token outside
     * the closed session-error set admitted as {@code other}.
     */
    public static String sessionFailedReason(String token) {
        Vocabulary.SessionError admitted = token == null ? null : Vocabulary.SessionError.of(token);
        return "session-failed:" + (admitted == null ? Vocabulary.SessionError.OTHER : admitted).token;
    }

    /** The interruption reason an edge reads: one of the closed set, and anything else is {@code unknown}. */
    public static Vocabulary.InterruptionReason interruptionReason(String raw) {
        Vocabulary.InterruptionReason reason = raw == null ? null : Vocabulary.InterruptionReason.of(raw);
        return reason == null ? Vocabulary.InterruptionReason.UNKNOWN : reason;
    }

    private static Transition to(Phase next, Row row, String reason, Action... actions) {
        return new Transition(next, Arrays.asList(actions), row, reason);
    }

    private static Transition to(Phase next, Action... actions) {
        return to(next, null, null, actions);
    }

    /** {@code sessionTransition(phase, input, holdPolicy)}: one edge. Each branch is the JS branch of the same name, in order. */
    public static Transition transition(Phase phase, Input input, HoldPolicy holdPolicy) {
        // Terminal: no deactivate and no notify on the way in, and nothing after.
        if (phase == Phase.RELINQUISHED) return to(phase);

        switch (input.kind()) {
            case USER_PLAY:
                // Activate once: an active session is not re-activated per press.
                return phase == Phase.ACTIVE ? to(phase) : to(phase, Action.ACTIVATE);

            case SESSION_RESULT: {
                Input.SessionResult r = (Input.SessionResult) input;
                if (r.ok()) return to(Phase.ACTIVE);
                return to(phase, null, sessionFailedReason(r.token()), Action.COMMAND_FAILED);
            }

            case PAUSE:
            case BEAT:
            case NARRATION:
            case BACKGROUND:
                // A pause, a seam beat, a narration handover or going to the background does
                // not release the session. Only a PAUSE under the `none` policy does, never with notify.
                if (phase == Phase.ACTIVE && input.kind() == InputKind.PAUSE && holdPolicy.equals(HoldPolicy.NONE)) {
                    return to(Phase.INACTIVE, Action.DEACTIVATE);
                }
                return to(phase);

            case HOLD_EXPIRED: {
                Input.HoldExpired h = (Input.HoldExpired) input;
                if (phase == Phase.ACTIVE && holdPolicy.isUntil() && !h.running()) return to(Phase.INACTIVE, Action.DEACTIVATE);
                // A timer the engine failed to cancel must not stop the audio; it is written down.
                return to(phase, Row.STALE_HOLD, null);
            }

            case INTERRUPTION_BEGAN: {
                Input.InterruptionBegan b = (Input.InterruptionBegan) input;
                if (b.reason() == Vocabulary.InterruptionReason.BUILT_IN_MIC_MUTED) return to(phase, Row.MIC_MUTED, null);
                // A late began(appWasSuspended) for a suspension already over describes the past.
                if (b.reason() == Vocabulary.InterruptionReason.APP_WAS_SUSPENDED && b.running() && b.activatedInProcess()) {
                    return to(phase, Row.STALE_SUSPENSION, null);
                }
                return phase == Phase.ACTIVE ? to(Phase.LOST_TO_INTERRUPTION) : to(phase);
            }

            case INTERRUPTION_ENDED: {
                Input.InterruptionEnded e = (Input.InterruptionEnded) input;
                if (phase != Phase.LOST_TO_INTERRUPTION) return to(phase);
                // The session comes back only by activating again, and only for someone listening.
                if (e.shouldResume() && e.wasPlaying()) return to(phase, Action.ACTIVATE);
                // Now Playing and the remote targets stay, so a later press is a userPlay.
                return to(Phase.INACTIVE);
            }

            case MEDIA_SERVICES_RESET:
                return to(Phase.INACTIVE, Row.MEDIA_SERVICES_RESET, null, Action.REAPPLY_CATEGORY, Action.REBUILD);

            case RELINQUISH:
                return to(Phase.RELINQUISHED);

            case CLOSE:
            case FINAL_END:
            case DATA_DELETION:
                return phase == Phase.ACTIVE ? to(Phase.INACTIVE, Action.DEACTIVATE_NOTIFY) : to(Phase.INACTIVE);

            default:
                throw new IllegalStateException("unreachable: " + input.kind());
        }
    }

    // ---- the audible-start invariant (§4.4, the session-invariant family)

    /**
     * {@code AUDIBLE_COMMANDS}: the engine commands that make sound. Each must come after
     * the session was active at the start of the turn, or after a SUCCESSFUL activation in
     * the same turn.
     */
    public static final List<String> AUDIBLE_COMMANDS = EngineConstants.EngineContract.AUDIBLE_COMMANDS;

    /** The session traffic the interpreter interleaves into a turn. */
    public static final class TurnMarker {
        private TurnMarker() {}

        /** The core's request. */
        public static final String ACTIVATE = "sessionActivate";
        /** The interpreter's answer, success. */
        public static final String RESULT_OK = "sessionResult:ok";
        /** The interpreter's answer, failure. */
        public static final String RESULT_FAILED = "sessionResult:failed";
        /** A deactivate in the same turn (hold policy {@code none}). */
        public static final String DEACTIVATE = "sessionDeactivate";
    }

    /** An audible command with no active session behind it: its index in the turn, and the command. */
    public record Violation(int at, String cmd) {}

    /**
     * {@code audibleStartViolations(sessionAtEntry, turn)}: every audible command in one
     * turn that had no active session behind it; empty means the turn keeps the invariant.
     * A {@code sessionResult:ok} counts only as the answer to a {@code sessionActivate}
     * asked earlier in the same turn.
     */
    public static List<Violation> audibleStartViolations(Phase sessionAtEntry, List<String> turn) {
        boolean active = sessionAtEntry == Phase.ACTIVE;
        boolean asked = false;
        List<Violation> violations = new ArrayList<>();
        for (int at = 0; at < turn.size(); at++) {
            String cmd = turn.get(at);
            switch (cmd) {
                case TurnMarker.ACTIVATE -> asked = true;
                case TurnMarker.RESULT_OK -> {
                    if (asked) active = true;
                    asked = false;
                }
                case TurnMarker.RESULT_FAILED -> asked = false;
                case TurnMarker.DEACTIVATE -> active = false;
                default -> {
                    if (AUDIBLE_COMMANDS.contains(cmd) && !active) violations.add(new Violation(at, cmd));
                }
            }
        }
        return violations;
    }
}
