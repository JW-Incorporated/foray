// GENERATED FILE - DO NOT EDIT.
// The Android engine's closed vocabularies, from player/engine-vocabulary.js (A-23).
// Regenerate with `node tools/parity/gen-constants.mjs --write`; tools/parity/gen-constants.test.mjs
// (in npm test) is red while this file disagrees with the JS it comes from.
//
// A diagnostics row admits a token only through these sets; the reasons for
// each set, and for keeping them closed, are in the JS module. The data only.

package ai.jwlabs.foura.engine;

import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class Vocabulary {
    private Vocabulary() {}

    /** {@code stage} */
    public enum Stage {
        ATTACH("attach"),
        DURATION("duration"),
        GATE("gate"),
        READINESS("readiness"),
        SEEK("seek"),
        PREROLL("preroll"),
        READY("ready"),
        PLAY("play"),
        PLAYING("playing"),
        SKIP("skip"),
        NOT_READY("not-ready"),
        RETRY("retry"),
        ORDINARY_LOAD("ordinary-load"),
        DEADLINE("deadline");

        /** The token, as the JS set spells it. */
        public final String token;

        Stage(String token) {
            this.token = token;
        }

        /** The member spelled {@code token}, or null for a token outside the set. */
        public static Stage of(String token) {
            for (Stage v : values()) if (v.token.equals(token)) return v;
            return null;
        }
    }

    /** {@code sessionError} */
    public enum SessionError {
        CANNOT_INTERRUPT_OTHERS("cannot-interrupt-others"),
        CANNOT_START_PLAYING("cannot-start-playing"),
        OTHER("other");

        /** The token, as the JS set spells it. */
        public final String token;

        SessionError(String token) {
            this.token = token;
        }

        /** The member spelled {@code token}, or null for a token outside the set. */
        public static SessionError of(String token) {
            for (SessionError v : values()) if (v.token.equals(token)) return v;
            return null;
        }
    }

    /** {@code sessionErrorDetail} */
    public enum SessionErrorDetail {
        CANNOT_INTERRUPT_OTHERS("cannot-interrupt-others"),
        CANNOT_START_PLAYING("cannot-start-playing"),
        INSUFFICIENT_PRIORITY("insufficient-priority"),
        IS_BUSY("is-busy"),
        SIRI_IS_RECORDING("siri-is-recording"),
        MEDIA_SERVICES_FAILED("media-services-failed"),
        EXPIRED_SESSION("expired-session"),
        MISSING_ENTITLEMENT("missing-entitlement"),
        RESOURCE_NOT_AVAILABLE("resource-not-available"),
        INCOMPATIBLE_CATEGORY("incompatible-category"),
        SESSION_NOT_ACTIVE("session-not-active"),
        OTHER("other");

        /** The token, as the JS set spells it. */
        public final String token;

        SessionErrorDetail(String token) {
            this.token = token;
        }

        /** The member spelled {@code token}, or null for a token outside the set. */
        public static SessionErrorDetail of(String token) {
            for (SessionErrorDetail v : values()) if (v.token.equals(token)) return v;
            return null;
        }
    }

    /** {@code interruptionReason} */
    public enum InterruptionReason {
        DEFAULT("default"),
        APP_WAS_SUSPENDED("appWasSuspended"),
        BUILT_IN_MIC_MUTED("builtInMicMuted"),
        UNKNOWN("unknown");

        /** The token, as the JS set spells it. */
        public final String token;

        InterruptionReason(String token) {
            this.token = token;
        }

        /** The member spelled {@code token}, or null for a token outside the set. */
        public static InterruptionReason of(String token) {
            for (InterruptionReason v : values()) if (v.token.equals(token)) return v;
            return null;
        }
    }

    /** {@code stopCause} */
    public enum StopCause {
        PAUSE("pause"),
        ENDED("ended"),
        FINAL_END("final-end"),
        SYSTEM_PAUSE("system-pause"),
        ROUTE_CHANGE("route-change"),
        INTERRUPTION("interruption"),
        GRACE_EXPIRED("grace-expired"),
        SEAM_TIMEOUT("seam-timeout"),
        LOAD_DEADLINE("load-deadline"),
        ERROR("error"),
        RELINQUISH("relinquish"),
        DATA_DELETION("data-deletion"),
        CLOSE("close"),
        MEDIA_SERVICES_RESET("media-services-reset"),
        UNKNOWN("unknown");

        /** The token, as the JS set spells it. */
        public final String token;

        StopCause(String token) {
            this.token = token;
        }

        /** The member spelled {@code token}, or null for a token outside the set. */
        public static StopCause of(String token) {
            for (StopCause v : values()) if (v.token.equals(token)) return v;
            return null;
        }
    }

    /** {@code source} */
    public enum Source {
        TAP("tap"),
        REMOTE("remote"),
        RECONCILE("reconcile"),
        SESSION("session"),
        RESTORE("restore"),
        AUTOADVANCE("autoadvance"),
        AUTORESUME("autoresume"),
        AUDITION("audition");

        /** The token, as the JS set spells it. */
        public final String token;

        Source(String token) {
            this.token = token;
        }

        /** The member spelled {@code token}, or null for a token outside the set. */
        public static Source of(String token) {
            for (Source v : values()) if (v.token.equals(token)) return v;
            return null;
        }
    }

    /** {@code modeReason} */
    public enum ModeReason {
        BUILD_DEFAULT("build-default"),
        OVERRIDE("override"),
        NO_PLIST_KEY("no-plist-key"),
        NOT_BUILT("not-built"),
        CRASH_LOOP("crash-loop"),
        PAGE_HEALTH("page-health"),
        DOWNGRADE("downgrade");

        /** The token, as the JS set spells it. */
        public final String token;

        ModeReason(String token) {
            this.token = token;
        }

        /** The member spelled {@code token}, or null for a token outside the set. */
        public static ModeReason of(String token) {
            for (ModeReason v : values()) if (v.token.equals(token)) return v;
            return null;
        }
    }

    /** {@code faultKind} */
    public enum FaultKind {
        IMPLICIT_ACTIVATION("implicit-activation"),
        EXTERNALLY_OWNED("externally-owned");

        /** The token, as the JS set spells it. */
        public final String token;

        FaultKind(String token) {
            this.token = token;
        }

        /** The member spelled {@code token}, or null for a token outside the set. */
        public static FaultKind of(String token) {
            for (FaultKind v : values()) if (v.token.equals(token)) return v;
            return null;
        }
    }

    /** Every set's name, in the JS declaration order. */
    public static final List<String> SET_NAMES = Collections.unmodifiableList(Arrays.asList("stage", "sessionError", "sessionErrorDetail", "interruptionReason", "stopCause", "source", "modeReason", "faultKind"));

    /** Every set's tokens, by set name, in the JS declaration order. */
    public static final Map<String, List<String>> SETS;

    static {
        Map<String, List<String>> sets = new LinkedHashMap<>();
        sets.put("stage", Collections.unmodifiableList(Arrays.asList("attach", "duration", "gate", "readiness", "seek", "preroll", "ready", "play", "playing", "skip", "not-ready", "retry", "ordinary-load", "deadline")));
        sets.put("sessionError", Collections.unmodifiableList(Arrays.asList("cannot-interrupt-others", "cannot-start-playing", "other")));
        sets.put("sessionErrorDetail", Collections.unmodifiableList(Arrays.asList("cannot-interrupt-others", "cannot-start-playing", "insufficient-priority", "is-busy", "siri-is-recording", "media-services-failed", "expired-session", "missing-entitlement", "resource-not-available", "incompatible-category", "session-not-active", "other")));
        sets.put("interruptionReason", Collections.unmodifiableList(Arrays.asList("default", "appWasSuspended", "builtInMicMuted", "unknown")));
        sets.put("stopCause", Collections.unmodifiableList(Arrays.asList("pause", "ended", "final-end", "system-pause", "route-change", "interruption", "grace-expired", "seam-timeout", "load-deadline", "error", "relinquish", "data-deletion", "close", "media-services-reset", "unknown")));
        sets.put("source", Collections.unmodifiableList(Arrays.asList("tap", "remote", "reconcile", "session", "restore", "autoadvance", "autoresume", "audition")));
        sets.put("modeReason", Collections.unmodifiableList(Arrays.asList("build-default", "override", "no-plist-key", "not-built", "crash-loop", "page-health", "downgrade")));
        sets.put("faultKind", Collections.unmodifiableList(Arrays.asList("implicit-activation", "externally-owned")));
        SETS = Collections.unmodifiableMap(sets);
    }
}
