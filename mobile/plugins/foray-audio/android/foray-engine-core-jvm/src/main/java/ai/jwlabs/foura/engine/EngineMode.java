package ai.jwlabs.foura.engine;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Which lane a process plays through: the port of {@code decideEngineMode} and
 * {@code engineModeTrace} in {@code player/engine-contract.js} (docs/native-engine-plan.md §4.6).
 * The JVM twin of {@code EngineMode} in ForayEngineCore (Policy/EngineMode.swift, NE-11s), card
 * A-29 of docs/plans/android-assessment.md. JS is the reference; the {@code engine-mode} parity
 * family is the contract.
 *
 * <p>PURE, ON PURPOSE. foray-audio's {@code EngineOwnership} is the wrapper that reads the
 * engine-private keys and the build's number, calls {@link #decide} ONCE per process, and writes
 * the answer back. Everything that can be wrong about the decision (a strike counted per launch
 * instead of per crash, a sticky pin that outlives the build it was for, an override that beats
 * the crash-loop guard) lives here, where the fixtures can see it; the wrapper only moves values
 * in and out.
 *
 * <p>WHAT IS SAFE TO GET WRONG AND WHAT IS NOT. A native engine that crashes at boot must fall
 * back to the JS player within three launches and STAY there until a new build ships, and a
 * launch that went healthy must never count as a crash (R18). Both are fixture cases.
 */
public final class EngineMode {
    private EngineMode() {}

    /** {@code ENGINE_MODES}: engineHello's {@code mode}. {@code legacy} is the JS lane. */
    public enum Mode {
        NATIVE("native"),
        LEGACY("legacy");

        public final String token;

        Mode(String token) {
            this.token = token;
        }
    }

    /** {@code MODE_OVERRIDES}: the Developer setting 'Playback engine: Automatic / Native / Web', as stored. */
    public enum ModeOverride {
        AUTO("auto"),
        NATIVE("native"),
        WEB("web");

        public final String token;

        ModeOverride(String token) {
            this.token = token;
        }

        /** The member spelled {@code token}, or null for a token outside the set. */
        public static ModeOverride of(String token) {
            for (ModeOverride v : values()) if (v.token.equals(token)) return v;
            return null;
        }

        /**
         * How a STORED override is read: anything outside the closed set (a missing key, a value
         * an older build wrote) is {@code auto}, as the JS reads
         * {@code MODE_OVERRIDES.includes(v) ? v : "auto"}.
         */
        public static ModeOverride stored(String raw) {
            ModeOverride o = raw == null ? null : of(raw);
            return o == null ? AUTO : o;
        }
    }

    /**
     * The build's default ({@code ForayEngineDefault} on iOS; mobile/ENGINE_DEFAULT.json's android
     * block on Android), when it holds one of these. Absent or anything else is null, which
     * {@link #decide} reads as {@code no-plist-key}: a build that forgot it runs the JS player.
     */
    public enum BuildDefault {
        NATIVE("native"),
        JS("js");

        public final String token;

        BuildDefault(String token) {
            this.token = token;
        }

        /** The member spelled {@code token}, or null (no decision anybody made). */
        public static BuildDefault of(String token) {
            for (BuildDefault v : values()) if (v.token.equals(token)) return v;
            return null;
        }
    }

    /** {@code STRIKE_LIMIT}: at this many strikes the process runs legacy, sticky until the build changes. */
    public static final int STRIKE_LIMIT = (int) EngineConstants.EngineContract.STRIKE_LIMIT;

    /** {@code MODE_OVERRIDES}, in the JS order. */
    public static final List<String> MODE_OVERRIDES = EngineConstants.EngineContract.MODE_OVERRIDES;

    /** {@code ENGINE_MODE_EVENTS}, in the JS order. */
    public static final List<String> ENGINE_MODE_EVENTS = EngineConstants.EngineContract.ENGINE_MODE_EVENTS;

    /**
     * {@code decideEngineMode}'s input.
     *
     * @param buildDefault      the build's default, or null when absent / unreadable
     * @param modeOverride      the Developer setting ({@code ForayEngine.modeOverride})
     * @param sentinelWasSet    the PREVIOUS launch's sentinel is still set: its native boot never
     *                          reached a healthy marker
     * @param strikes           the stored strike count; a negative count reads as 0
     * @param stickyLegacyBuild the build a crash loop pinned to legacy; empty or null is none
     * @param currentBuild      this launch's build number (CFBundleVersion; versionCode on Android)
     * @param built             whether this binary has an engine at all
     */
    public record Inputs(BuildDefault buildDefault, ModeOverride modeOverride, boolean sentinelWasSet, int strikes,
                         String stickyLegacyBuild, String currentBuild, boolean built) {
        public Inputs {
            if (modeOverride == null) modeOverride = ModeOverride.AUTO;
            if (currentBuild == null) currentBuild = "";
        }
    }

    /**
     * The lane, its mode-reason token, and what to store back. {@code writeSentinel} is true
     * exactly when the engine boots natively: the sentinel guards a native boot, and a legacy
     * process has nothing to guard.
     */
    public record Decision(Mode mode, Vocabulary.ModeReason reason, int strikes, String stickyLegacyBuild, boolean writeSentinel) {
        public boolean isNative() {
            return mode == Mode.NATIVE;
        }
    }

    private static String pin(String raw) {
        return raw == null || raw.isEmpty() ? null : raw;
    }

    private static Decision out(Mode mode, Vocabulary.ModeReason reason, int strikes, String sticky) {
        return new Decision(mode, reason, strikes, sticky, mode == Mode.NATIVE);
    }

    /**
     * {@code decideEngineMode(i)}. The ORDER is the rule (engine-contract.js says why each step
     * sits where it does):
     * <ol>
     *   <li>not built → legacy / not-built. Nothing else can matter.</li>
     *   <li>a strike is added ONLY IF the previous sentinel is still set.</li>
     *   <li>a sticky pin from ANOTHER build is dropped with its strikes: a new build is the fix a
     *       crash loop was waiting for.</li>
     *   <li>sticky for THIS build, or strikes at the limit → legacy / crash-loop, the pin
     *       (re)written. Safety beats every preference below it, including a Developer override
     *       of native.</li>
     *   <li>the override, then 6. the build's default.</li>
     * </ol>
     */
    public static Decision decide(Inputs i) {
        int strikes0 = Math.max(0, i.strikes());
        String sticky0 = pin(i.stickyLegacyBuild());
        if (!i.built()) return out(Mode.LEGACY, Vocabulary.ModeReason.NOT_BUILT, strikes0, sticky0);

        int strikes = i.sentinelWasSet() ? strikes0 + 1 : strikes0;
        String sticky = sticky0;
        if (sticky != null && !sticky.equals(i.currentBuild())) {
            sticky = null;
            strikes = 0;
        }
        if (i.currentBuild().equals(sticky) || strikes >= STRIKE_LIMIT) {
            return out(Mode.LEGACY, Vocabulary.ModeReason.CRASH_LOOP, strikes, i.currentBuild());
        }

        switch (i.modeOverride()) {
            case NATIVE:
                return out(Mode.NATIVE, Vocabulary.ModeReason.OVERRIDE, strikes, null);
            case WEB:
                return out(Mode.LEGACY, Vocabulary.ModeReason.OVERRIDE, strikes, null);
            default:
                break;
        }
        if (i.buildDefault() == BuildDefault.NATIVE) return out(Mode.NATIVE, Vocabulary.ModeReason.BUILD_DEFAULT, strikes, null);
        if (i.buildDefault() == BuildDefault.JS) return out(Mode.LEGACY, Vocabulary.ModeReason.BUILD_DEFAULT, strikes, null);
        return out(Mode.LEGACY, Vocabulary.ModeReason.NO_PLIST_KEY, strikes, null);
    }

    // ---- the strike rules across time (engineModeTrace)

    /**
     * The engine-private state the decision reads and writes (§4.6): {@code ForayEngine.modeOverride},
     * {@code .strikes}, {@code .sentinel}, {@code .stickyLegacyBuild}. Read as the JS reads them: a
     * negative count is 0 and an empty pin is none.
     */
    public record Stored(ModeOverride modeOverride, int strikes, boolean sentinel, String stickyLegacyBuild) {
        public Stored {
            if (modeOverride == null) modeOverride = ModeOverride.AUTO;
            strikes = Math.max(0, strikes);
            stickyLegacyBuild = pin(stickyLegacyBuild);
        }

        public static final Stored FRESH = new Stored(ModeOverride.AUTO, 0, false, null);
    }

    /** {@code ENGINE_MODE_EVENTS}. */
    public enum EventKind {
        LAUNCH("launch"),
        HEALTHY("healthy"),
        PAGE_HEALTH("page-health"),
        SET_OVERRIDE("set-override");

        public final String token;

        EventKind(String token) {
            this.token = token;
        }

        /** The member spelled {@code token}, or null for a token outside the set. */
        public static EventKind of(String token) {
            for (EventKind v : values()) if (v.token.equals(token)) return v;
            return null;
        }
    }

    /** What moves the stored state between and within launches. */
    public sealed interface Event permits Event.Launch, Event.Healthy, Event.PageHealth, Event.SetOverride {
        EventKind kind();

        /**
         * A process starts: {@link #decide} over the stored state; the old sentinel is consumed and
         * a new one written only for a native boot.
         */
        record Launch(BuildDefault buildDefault, String currentBuild, boolean built) implements Event {
            public EventKind kind() {
                return EventKind.LAUNCH;
            }
        }

        /**
         * A healthy marker (first handled input, 5 s of the main looper, the Activity paused, first
         * playing): the sentinel clears and strikes reset to 0. Native processes only; legacy wrote
         * no sentinel.
         */
        record Healthy() implements Event {
            public EventKind kind() {
                return EventKind.HEALTHY;
            }
        }

        /**
         * No engineHello within 10 s of a foreground page load (or a hello the engine could not
         * answer): ONE strike per process, counted from the strikes this launch STARTED with (the
         * 5 s healthy marker has usually reset the live count by then, and a page broken on every
         * launch must still reach legacy). After it, a later healthy marker clears the sentinel but
         * no longer resets the strikes.
         */
        record PageHealth() implements Event {
            public EventKind kind() {
                return EventKind.PAGE_HEALTH;
            }
        }

        /** The Developer setting changed: stored override, strikes 0, sticky cleared. The running process keeps its lane. */
        record SetOverride(ModeOverride mode) implements Event {
            public EventKind kind() {
                return EventKind.SET_OVERRIDE;
            }
        }
    }

    /** The state after one event: the current process's lane (null before the first launch) and the stored state. */
    public record Step(EventKind kind, Mode mode, Vocabulary.ModeReason reason, Stored stored) {}

    /**
     * {@code engineModeTrace(stored, events)}: fold launches and in-process events over the stored
     * state, which one {@link #decide} call cannot show. foray-audio's ownership tests drive
     * {@code EngineOwnership} through the same sequences.
     */
    public static List<Step> trace(Stored initial, List<Event> events) {
        Stored s = initial == null ? Stored.FRESH : initial;
        Mode procMode = null;
        Vocabulary.ModeReason procReason = null;
        int launchStrikes = 0;
        boolean pageHealthTaken = false;
        List<Step> steps = new ArrayList<>();
        for (Event event : events) {
            if (event instanceof Event.Launch l) {
                Decision d = decide(new Inputs(l.buildDefault(), s.modeOverride(), s.sentinel(), s.strikes(),
                        s.stickyLegacyBuild(), l.currentBuild(), l.built()));
                s = new Stored(s.modeOverride(), d.strikes(), d.writeSentinel(), d.stickyLegacyBuild());
                procMode = d.mode();
                procReason = d.reason();
                launchStrikes = d.strikes();
                pageHealthTaken = false;
            } else if (event instanceof Event.Healthy) {
                if (procMode == Mode.NATIVE) {
                    s = new Stored(s.modeOverride(), pageHealthTaken ? s.strikes() : 0, false, s.stickyLegacyBuild());
                }
            } else if (event instanceof Event.PageHealth) {
                if (procMode == Mode.NATIVE && !pageHealthTaken) {
                    pageHealthTaken = true;
                    s = new Stored(s.modeOverride(), launchStrikes + 1, s.sentinel(), s.stickyLegacyBuild());
                }
            } else if (event instanceof Event.SetOverride o) {
                s = new Stored(o.mode(), 0, s.sentinel(), null);
            }
            steps.add(new Step(event.kind(), procMode, procReason, s));
        }
        return Collections.unmodifiableList(steps);
    }
}
