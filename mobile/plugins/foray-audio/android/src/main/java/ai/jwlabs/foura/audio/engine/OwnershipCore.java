package ai.jwlabs.foura.audio.engine;

import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.EngineContract;
import ai.jwlabs.foura.engine.EngineInput;
import ai.jwlabs.foura.engine.EngineMode;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.Vocabulary;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import java.util.function.Consumer;

/**
 * WHO PLAYS THIS PROCESS, AND WHAT HAPPENS WHEN THE ENGINE IS BROKEN (card A-29,
 * docs/plans/android-assessment.md §5.4; the Android subset of iOS NE-17,
 * docs/native-engine-plan.md §4.6). The pure half of foray-audio's {@code EngineOwnership}: every
 * rule, over seams (the private keys, the timing, the rows, the engine and the hand-over), so a
 * plain JUnit test drives it through whole launches. The Android wrapper only moves values in
 * and out and binds the service.
 *
 * <ul>
 *   <li><b>{@link #decideOnce()}</b> reads the build's default, the Developer setting, the strike
 *       state and the build number, runs {@link EngineMode#decide}, and writes the answer back
 *       BEFORE anything native boots, so a boot that crashes the process has already been counted
 *       against itself. Once per process: every later call returns the same answer and writes
 *       nothing.</li>
 *   <li><b>The healthy marker</b> (the first turn the engine completes, 5 s after it boots, or the
 *       Activity pausing once it has booted) clears the sentinel and resets the strikes. A strike is counted only
 *       for a native boot that never reached one, so three crashing boots in a row pin the build
 *       to the JS lane (sticky until the build number changes) and a healthy one never counts.</li>
 *   <li><b>The hello watchdog</b>: a page that does not say engineHello within 15 s of loading, while
 *       the engine is idle, gets the process back: the engine relinquishes by itself, with a
 *       page-health strike. A page that says nothing within 10 s of a foreground load is a
 *       page-health strike on its own.</li>
 *   <li><b>A fault</b>: an engine that throws while answering the hello gives the process back at
 *       once (a {@code mode kind=fault} row, a page-health strike, the relinquish), and the page is
 *       told {@code legacy / downgrade}: it runs the JS player, not silence.</li>
 *   <li><b>The relinquish is terminal</b> and one way: the core goes terminal, the service is
 *       stopped (the hand-over), and a second relinquish is refused.</li>
 * </ul>
 *
 * <p>WHY A SENTINEL AND NOT A LAUNCH COUNTER (plan §4.6, R18). A car's play button launches 4a in
 * the background. A counter would call three of those a crash loop; the sentinel counts only a
 * native boot that never reached a healthy marker.
 *
 * <p>WHERE ANDROID DIFFERS FROM iOS, AND WHY.
 * <ul>
 *   <li>The page load is the plugin's {@code load()}: one per Activity, which is one per WebView,
 *       and always before the page's own scripts run, so a hello can never arrive before the load
 *       that it answers (iOS needs a separate "navigation started" signal for that). A reload
 *       inside one WebView does not re-arm the watchdog; the page's own 5 s hello bound still
 *       relinquishes for it.</li>
 *   <li>The watchdog is armed whether or not the engine has bound yet (on Android the engine boots
 *       asynchronously, after the decision); when it fires with no engine there is nothing to give
 *       back, and the page was already answered {@code not-built}.</li>
 *   <li>A hello the engine throws on is a page-health strike: on iOS the hello cannot throw.</li>
 * </ul>
 *
 * <p>ROWS ONLY IN THE NATIVE LANE, as on iOS: a legacy launch writes no row, so a data deletion
 * cannot miss one. Rows are tokens and numbers only.
 *
 * <p>PURE JVM, and NOT THREAD-SAFE BY DESIGN: every method is called on the main looper.
 */
public final class OwnershipCore {
    /** The engine-private keys (plan §4.6, iOS's names; SharedPreferences on Android). Every write is synchronous. */
    public interface Keys {
        /** The stored value, or null. */
        String get(String key);

        /** Store {@code value}; null removes the key. Lands before it returns. */
        void put(String key, String value);
    }

    /** What only the platform can do. */
    public interface Platform {
        /** The engine this process bound: live, or torn down after a relinquish; null when there is none. */
        ForayEngineHost engine();

        /** The engine is terminal: release the binding and stop its service, so the legacy lane is the only one. */
        void handOver();
    }

    /**
     * What the process was launched with: the inputs to the decision that do not live in the keys.
     *
     * @param buildDefault the build's default (mobile/ENGINE_DEFAULT.json's android block), or null
     * @param currentBuild the build number a sticky pin is pinned to (versionCode)
     * @param launchId     this launch's sentinel value; only whether the PREVIOUS one is still set counts
     * @param built        whether this binary has an engine
     */
    public record Launch(EngineMode.BuildDefault buildDefault, String currentBuild, String launchId, boolean built) {
        public Launch {
            if (currentBuild == null) currentBuild = "";
            if (launchId == null || launchId.isEmpty()) launchId = "launch";
        }
    }

    /** The private keys the decision reads and writes: iOS's {@code EnginePrivateKey} names. */
    public static final String KEY_OVERRIDE = EngineLane.OVERRIDE_KEY;
    public static final String KEY_STRIKES = "ForayEngine.strikes";
    public static final String KEY_SENTINEL = "ForayEngine.sentinel";
    public static final String KEY_STICKY = "ForayEngine.stickyLegacyBuild";

    /** Plan §4.6: the healthy marker's run-loop leg, counted from the engine's boot. */
    public static final double HEALTHY_RUN_LOOP_MS = 5_000;
    /** No engineHello this long after a FOREGROUND page load is a page-health strike (plan §4.6). */
    public static final double PAGE_HEALTH_MS = 10_000;
    /**
     * No engineHello this long after a page load, with the engine idle: the engine relinquishes by
     * itself. Longer than the page's own 5 s bound (native-engine.js HELLO_TIMEOUT_MS), so a page
     * that gave up has always sent its own relinquish first.
     */
    public static final double HELLO_WATCHDOG_MS = 15_000;

    /** Which marker proved the native boot healthy (the {@code mode kind=healthy} row). */
    public enum HealthyMarker {
        FIRST_INPUT("first-input"),
        RUN_LOOP("run-loop"),
        RESIGN_OR_BACKGROUND("resign-or-background");

        public final String token;

        HealthyMarker(String token) {
            this.token = token;
        }
    }

    private final Keys keys;
    private final Launch launch;
    private final EngineSeams.Timing timing;
    private final Consumer<EngineCommand.DiagEntry> diag;
    private final Platform platform;

    private EngineMode.Decision decision;
    private boolean booted;
    private boolean relinquished;
    private boolean healthyMarked;
    private boolean pageHealthTaken;
    private boolean helloThisNavigation;
    private EngineSeams.Cancellable healthyTimer;
    private EngineSeams.Cancellable pageHealthTimer;
    private EngineSeams.Cancellable helloTimer;

    public OwnershipCore(Keys keys, Launch launch, EngineSeams.Timing timing, Consumer<EngineCommand.DiagEntry> diag,
                         Platform platform) {
        this.keys = Objects.requireNonNull(keys, "keys");
        this.launch = Objects.requireNonNull(launch, "launch");
        this.timing = Objects.requireNonNull(timing, "timing");
        this.diag = Objects.requireNonNull(diag, "diag");
        this.platform = Objects.requireNonNull(platform, "platform");
    }

    // ---- the stored state

    /** A stored value as the JS reads it: an empty string is absent. */
    private String read(String key) {
        String v;
        try {
            v = keys.get(key);
        } catch (RuntimeException e) {
            v = null;
        }
        return v == null || v.isEmpty() ? null : v;
    }

    private void write(String key, String value) {
        keys.put(key, value == null || value.isEmpty() ? null : value);
    }

    /** Stored as a decimal string; anything unreadable or negative reads as 0. */
    private int strikes() {
        String raw = read(KEY_STRIKES);
        if (raw == null) return 0;
        try {
            return Math.max(0, Integer.parseInt(raw.trim()));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private void setStrikes(int n) {
        write(KEY_STRIKES, String.valueOf(Math.max(0, n)));
    }

    /** The state {@link EngineMode#trace} folds, as stored now: what the tests compare the owner against. */
    public EngineMode.Stored stored() {
        return new EngineMode.Stored(EngineMode.ModeOverride.stored(read(KEY_OVERRIDE)), strikes(), read(KEY_SENTINEL) != null,
                read(KEY_STICKY));
    }

    // ---- decideOnce

    /**
     * The process's one decision. The first call reads, decides and writes back; every later call
     * returns the same answer and writes nothing. Only what changed is written, so a stock launch
     * with nothing stored writes no key at all.
     */
    public EngineMode.Decision decideOnce() {
        if (decision != null) return decision;
        EngineMode.Stored s = stored();
        EngineMode.Decision d = EngineMode.decide(new EngineMode.Inputs(launch.buildDefault(), s.modeOverride(), s.sentinel(),
                s.strikes(), s.stickyLegacyBuild(), launch.currentBuild(), launch.built()));
        try {
            if (d.strikes() != s.strikes()) setStrikes(d.strikes());
            if (!Objects.equals(d.stickyLegacyBuild(), s.stickyLegacyBuild())) write(KEY_STICKY, d.stickyLegacyBuild());
            if (d.writeSentinel() || s.sentinel()) write(KEY_SENTINEL, d.writeSentinel() ? launch.launchId() : null);
        } catch (RuntimeException e) {
            // A store that cannot be written must not cost the launch its lane: the decision stands.
        }
        decision = d;
        List<JsonNode.Member> f = new ArrayList<>();
        f.add(JsonNode.member("mode", JsonNode.str(d.mode().token)));
        f.add(JsonNode.member("reason", JsonNode.str(d.reason().token)));
        f.add(JsonNode.member("strikes", JsonNode.num(d.strikes())));
        f.add(JsonNode.member("sentinelWasSet", JsonNode.str(s.sentinel() ? "y" : "n")));
        f.add(JsonNode.member("build", JsonNode.str(launch.currentBuild())));
        row(f);
        return d;
    }

    /** The decision as the bridge reads it. */
    public EngineBridge.Decision laneDecision() {
        EngineMode.Decision d = decideOnce();
        return new EngineBridge.Decision(d.mode().token, d.reason());
    }

    public boolean isNative() {
        return decideOnce().isNative();
    }

    public boolean isRelinquished() {
        return relinquished;
    }

    // ---- the engine's boot and the healthy marker

    /**
     * The engine exists (its service bound). Arms the healthy marker's run-loop leg, once. The
     * sentinel was written by {@link #decideOnce()} before the boot began.
     */
    public void engineBooted() {
        if (!isNative() || relinquished || booted) return;
        booted = true;
        if (!healthyMarked) healthyTimer = timing.schedule(HEALTHY_RUN_LOOP_MS, false, () -> markHealthy(HealthyMarker.RUN_LOOP));
    }

    /** The engine completed a turn (an input handled to the end): the first-input healthy marker. */
    public void engineTurned() {
        markHealthy(HealthyMarker.FIRST_INPUT);
    }

    /** The Activity paused (the listener left, or the screen went off): the resign-or-background marker. */
    public void backgrounded() {
        markHealthy(HealthyMarker.RESIGN_OR_BACKGROUND);
    }

    /**
     * Whichever marker comes first clears the sentinel and resets the strikes, once. After a
     * page-health strike the reset is withheld: a page that is broken on every launch must still
     * reach the JS lane, even though its native boot was healthy.
     *
     * <p>ONLY ONCE THE ENGINE EXISTS ({@link #engineBooted()}), as on iOS, where the markers are
     * armed by the boot itself. On Android the service binds asynchronously after the decision,
     * so an Activity pause can come first (a permission dialog, the screen going off during a cold
     * start); it proves nothing about a boot that has not happened, and clearing the sentinel then
     * would forgive a service that goes on to crash the process, or never binds, on every launch.
     */
    public void markHealthy(HealthyMarker marker) {
        if (decision == null || !decision.isNative() || !booted || healthyMarked) return;
        healthyMarked = true;
        cancel(healthyTimer);
        healthyTimer = null;
        try {
            write(KEY_SENTINEL, null);
            if (!pageHealthTaken) setStrikes(0);
        } catch (RuntimeException ignored) {
            // The next launch may count a strike it should not; it can never lose one it should.
        }
        List<JsonNode.Member> f = new ArrayList<>();
        f.add(JsonNode.member("kind", JsonNode.str("healthy")));
        f.add(JsonNode.member("marker", JsonNode.str(marker.token)));
        f.add(JsonNode.member("strikes", JsonNode.num(strikes())));
        row(f);
    }

    /**
     * One strike per process, counted from the strikes this launch STARTED with (the 5 s healthy
     * marker has usually reset the live count by then).
     */
    private void pageHealthStrike() {
        if (decision == null || !decision.isNative() || pageHealthTaken) return;
        pageHealthTaken = true;
        try {
            setStrikes(decision.strikes() + 1);
        } catch (RuntimeException ignored) {
            // Best effort, as above.
        }
        List<JsonNode.Member> f = new ArrayList<>();
        f.add(JsonNode.member("reason", JsonNode.str(Vocabulary.ModeReason.PAGE_HEALTH.token)));
        f.add(JsonNode.member("strikes", JsonNode.num(strikes())));
        row(f);
    }

    /**
     * The Developer setting 'Playback engine: Automatic / Native / Web (applies after restart)',
     * through {@code engineSend setModeOverride}. Written synchronously; strikes and the sticky
     * pin are cleared, so a listener who chose again gets a fresh start. The running process keeps
     * its lane.
     */
    public void setModeOverride(String mode) {
        EngineMode.ModeOverride o = EngineMode.ModeOverride.stored(mode);
        write(KEY_OVERRIDE, o.token);
        setStrikes(0);
        write(KEY_STICKY, null);
        List<JsonNode.Member> f = new ArrayList<>();
        f.add(JsonNode.member("kind", JsonNode.str("set-override")));
        f.add(JsonNode.member("override", JsonNode.str(o.token)));
        row(f);
    }

    // ---- the hello watchdog

    /**
     * A page is loading (see the class comment for why the plugin's {@code load()} is the
     * signal). Each page must say hello: one that does not (an old web bundle, a page that threw
     * at boot) would run the JS player while the engine holds the media session.
     */
    public void pageLoaded(boolean foreground) {
        if (!isNative() || relinquished) return;
        helloThisNavigation = false;
        cancelHelloTimers();
        if (foreground) {
            pageHealthTimer = timing.schedule(PAGE_HEALTH_MS, false, () -> {
                pageHealthTimer = null;
                if (!helloThisNavigation) pageHealthStrike();
            });
        }
        armHelloWatchdog();
    }

    /** engineHello arrived: the page has claimed the engine, for the rest of this page. */
    public void helloReceived() {
        helloThisNavigation = true;
        cancelHelloTimers();
    }

    /** Whether this page said hello (tests read it). */
    public boolean helloThisNavigation() {
        return helloThisNavigation;
    }

    private void armHelloWatchdog() {
        helloTimer = timing.schedule(HELLO_WATCHDOG_MS, false, this::helloWatchdogFired);
    }

    /** Idle: relinquish, with the strike. Running (a car's cold play): never stop the audio for a page's sake; look again later. */
    private void helloWatchdogFired() {
        helloTimer = null;
        if (relinquished || helloThisNavigation) return;
        ForayEngineHost engine = platform.engine();
        if (engine == null || engine.isTornDown()) return;
        if (engine.state().isRunning()) {
            List<JsonNode.Member> f = new ArrayList<>();
            f.add(JsonNode.member("kind", JsonNode.str("hello-watchdog")));
            f.add(JsonNode.member("outcome", JsonNode.str("deferred")));
            row(f);
            armHelloWatchdog();
            return;
        }
        pageHealthStrike();
        // `restore`: the page's boot, not a press (as the page's own handshake relinquish is sourced).
        relinquish(EngineContract.RelinquishCap.ALL, Vocabulary.Source.RESTORE);
    }

    private void cancelHelloTimers() {
        cancel(pageHealthTimer);
        pageHealthTimer = null;
        cancel(helloTimer);
        helloTimer = null;
    }

    private static void cancel(EngineSeams.Cancellable c) {
        if (c != null) c.cancel();
    }

    // ---- the fault

    /**
     * The engine threw while answering the page ({@code at}: {@code hello}). The process is given
     * back at once, so the page's JS player is the only one and the legacy service may start: the
     * fault row, a page-health strike (a build whose engine throws on every launch reaches the
     * sticky JS lane in three), and the relinquish. Never throws.
     */
    public void engineFaulted(String at, RuntimeException error) {
        try {
            List<JsonNode.Member> f = new ArrayList<>();
            f.add(JsonNode.member("kind", JsonNode.str("fault")));
            f.add(JsonNode.member("at", JsonNode.str(at == null ? "unknown" : at)));
            f.add(JsonNode.member("error", JsonNode.str(error == null ? "unknown" : error.getClass().getSimpleName())));
            row(f);
            cancelHelloTimers();
            pageHealthStrike();
        } catch (RuntimeException ignored) {
            // The hand-over below is the one thing that must happen.
        }
        relinquish(EngineContract.RelinquishCap.ALL, Vocabulary.Source.RESTORE);
    }

    // ---- the one-way relinquish

    /**
     * Plan §4.6. The core does the stop with persistence, keeps the session (no deactivate, no
     * notify), writes the {@code {mode: "relinquished"}} restore record and the
     * {@code mode reason=downgrade cap=} row, inside its turn; the host is torn down when the core
     * goes terminal; the hand-over then stops the service. A second relinquish is refused. An
     * engine that throws while giving the process back is still torn down and handed over.
     */
    public ForayEngineHost.Verdict relinquish(EngineContract.RelinquishCap cap, Vocabulary.Source source) {
        ForayEngineHost host = platform.engine();
        if (relinquished || host == null || host.isTornDown()) {
            return new ForayEngineHost.Verdict(Collections.singletonList(EngineContract.Refusal.RELINQUISHED.token), false);
        }
        relinquished = true;
        cancelHelloTimers();
        ForayEngineHost.Verdict verdict;
        try {
            verdict = host.handle(new EngineInput.Command(new EngineContract.Command.Relinquish(cap), source));
        } catch (RuntimeException e) {
            List<JsonNode.Member> f = new ArrayList<>();
            f.add(JsonNode.member("kind", JsonNode.str("fault")));
            f.add(JsonNode.member("at", JsonNode.str("relinquish")));
            f.add(JsonNode.member("error", JsonNode.str(e.getClass().getSimpleName())));
            row(f);
            verdict = new ForayEngineHost.Verdict(Collections.<String>emptyList(), false);
        }
        // Queued behind a turn in progress: the host tears down when the core gets to it.
        // Tearing down now would drop the relinquish itself.
        if (!verdict.deferred()) {
            try {
                host.teardown();
            } catch (RuntimeException ignored) {
                // Handed over below regardless.
            }
        }
        platform.handOver();
        return verdict;
    }

    // ---- rows

    private void row(List<JsonNode.Member> fields) {
        if (decision == null || !decision.isNative()) return;
        try {
            diag.accept(new EngineCommand.DiagEntry("mode", fields));
        } catch (RuntimeException ignored) {
            // A row must never cost the lane.
        }
    }
}
