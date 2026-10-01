package ai.jwlabs.foura.audio.engine;

import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.Interlude;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.Vocabulary;
import java.util.Arrays;
import java.util.Collections;
import java.util.Objects;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * THE REAL {@code InterludePlaying} on Android (card A-41, docs/plans/android-assessment.md §5.5):
 * the JVM twin of the iOS {@code InterludePlayer} (ForayAudioPlugin/Engine/InterludePlayer.swift,
 * NE-34). The jingle a seam between two podcasts carries (queue-manager.js §13), played natively so
 * a locked phone hears it with no page.
 *
 * <p>It DECIDES NOTHING about when: the core arms the jingle at the out-point, stretches the seam to
 * its ceiling and shrinks it back on the end report. What it owns is the three rules the platform
 * leaves to whoever holds the player:
 * <ol>
 *   <li><b>The audible-start invariant</b> (plan §4.4): the core never asks without the session; if
 *       it ever did, this refuses with a {@code fault kind=implicit-activation at=interlude} row
 *       instead of sounding.</li>
 *   <li><b>The ceiling is an engine timer.</b> The end the core waits for is the player's
 *       completion. If it never comes, the jingle is stopped at {@code INTERLUDE_CEILING_SEC} from its
 *       start by a timer on the engine's own clock and reported {@code ceiling}: nothing is ever left
 *       waiting on a callback.</li>
 *   <li><b>One end per start.</b> A late completion for a start that was stopped, restarted or
 *       already ended at the ceiling reports nothing.</li>
 * </ol>
 *
 * <p>The asset is the web's own {@code player/assets/interlude-placeholder.wav}, which foray-audio's
 * Gradle module ships as an Android asset read in place from the repo (build.gradle), pinned by
 * SHA-256 ({@link #ASSET_SHA256}, held equal to tools/audio/interlude-asset.mjs by
 * shell-invariants): {@link MediaJingle#make} hashes the file before it plays it, so the phone plays
 * the same bytes the web does or no jingle at all (and the service builds its core with
 * {@code interludeAvailable} off).
 *
 * <p>Plain Java: the player is a {@link Jingle}, so the tests hand a fake one (the case the ceiling
 * exists for cannot be produced on demand by a real player).
 */
public final class InterludePlayer implements EngineSeams.InterludePlaying {
    /** SHA-256 of {@code player/assets/interlude-placeholder.wav}. */
    public static final String ASSET_SHA256 = "597c4fbad12846431d5c6c78bf6a4fc469b2c2d416f53f50bcb26d2e823f83af";
    /** Where the jingle is among the app's assets (foray-audio's build.gradle ships player/assets/ at the root). */
    public static final String ASSET_NAME = "interlude-placeholder.wav";

    /** The part of a player this touches. */
    public interface Jingle {
        /** The file ran out ({@code true}) or failed mid-play ({@code false}), on the host's thread. */
        void setOnFinish(Consumer<Boolean> onFinish);

        /** From the first frame, at 1.0x. False: the player refused. */
        boolean playFromStart();

        void stop();

        void release();
    }

    /** What the player needs from the engine. */
    public static final class Config {
        /** The engine's session answer, read at every start. */
        public BooleanSupplier sessionIsActive = () -> true;
        /** Where the player's rows go: the engine's store. */
        public Consumer<EngineCommand.DiagEntry> diag = entry -> {};
        /** The engine's clock: the ceiling is one of its timers. */
        public EngineSeams.Timing timing;
        /** Builds the player on the first start (never at boot). */
        public Supplier<Jingle> makeJingle = () -> null;
        /** {@code INTERLUDE_CEILING_SEC} in ms, from the start. */
        public double ceilingMs = Interlude.CEILING_SEC * 1000;
    }

    private final Config config;
    private Consumer<String> onEnded;
    private Jingle jingle;
    private EngineSeams.Cancellable ceiling;
    /** Which start is sounding (0: none). A report for any other is stale. */
    private int sounding;
    private int starts;

    public InterludePlayer(Config config) {
        this.config = Objects.requireNonNull(config, "config");
        Objects.requireNonNull(config.timing, "timing");
    }

    /** Whether a start is sounding (the tests and the dump). */
    public boolean isSounding() {
        return sounding != 0;
    }

    @Override
    public void setOnEnded(Consumer<String> onEnded) {
        this.onEnded = onEnded;
    }

    @Override
    public boolean start() {
        if (!config.sessionIsActive.getAsBoolean()) {
            config.diag.accept(new EngineCommand.DiagEntry("fault", Arrays.asList(
                    JsonNode.member("kind", JsonNode.str(Vocabulary.FaultKind.IMPLICIT_ACTIVATION.token)),
                    JsonNode.member("at", JsonNode.str("interlude")))));
            return false;
        }
        silence();
        if (jingle == null) jingle = config.makeJingle.get();
        Jingle player = jingle;
        if (player == null) return refused("no-asset");
        starts += 1;
        int self = starts;
        player.setOnFinish(ok -> finish(self, Boolean.TRUE.equals(ok) ? "ended" : "error"));
        if (!player.playFromStart()) return refused("player");
        sounding = self;
        ceiling = config.timing.schedule(config.ceilingMs, false, () -> finish(self, "ceiling"));
        return true;
    }

    @Override
    public void stop() {
        silence();
    }

    @Override
    public void release() {
        silence();
        Jingle player = jingle;
        jingle = null;
        if (player != null) {
            player.setOnFinish(null);
            player.release();
        }
    }

    /** The start {@code self} stopped sounding. Reported once, and only while it is still the one sounding. */
    private void finish(int self, String reason) {
        if (self != sounding) return;
        sounding = 0;
        EngineSeams.Cancellable c = ceiling;
        ceiling = null;
        if (c != null) c.cancel();
        if ("ceiling".equals(reason)) {
            // The player never said so: make it true.
            Jingle player = jingle;
            if (player != null) player.stop();
            config.diag.accept(new EngineCommand.DiagEntry("interlude", Collections.singletonList(
                    JsonNode.member("kind", JsonNode.str("ceiling")))));
        }
        Consumer<String> listener = onEnded;
        if (listener != null) listener.accept(reason);
    }

    /** Stop whatever is sounding, with no report. */
    private void silence() {
        EngineSeams.Cancellable c = ceiling;
        ceiling = null;
        if (c != null) c.cancel();
        if (sounding != 0) {
            sounding = 0;
            Jingle player = jingle;
            if (player != null) player.stop();
        }
    }

    private boolean refused(String why) {
        config.diag.accept(new EngineCommand.DiagEntry("interlude", Arrays.asList(
                JsonNode.member("kind", JsonNode.str("refused")), JsonNode.member("why", JsonNode.str(why)))));
        return false;
    }
}
