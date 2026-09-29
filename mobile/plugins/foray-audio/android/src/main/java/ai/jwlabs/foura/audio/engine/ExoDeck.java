package ai.jwlabs.foura.audio.engine;

import ai.jwlabs.foura.engine.DeckCommand;
import ai.jwlabs.foura.engine.DeckEvent;
import ai.jwlabs.foura.engine.DeckPolicy;
import ai.jwlabs.foura.engine.DeckPolicy.OutPointEvent;
import ai.jwlabs.foura.engine.DeckPolicy.OutPointLayer;
import ai.jwlabs.foura.engine.DeckPolicy.OutPointOp;
import ai.jwlabs.foura.engine.DeckReading;
import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.JSWriter;
import ai.jwlabs.foura.engine.JsonNode;
import android.net.Uri;
import android.os.Looper;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.common.Timeline;
import androidx.media3.common.util.Clock;
import androidx.media3.common.util.HandlerWrapper;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.PlayerMessage;
import androidx.media3.exoplayer.SeekParameters;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;
import androidx.media3.extractor.DefaultExtractorsFactory;
import androidx.media3.extractor.mp3.Mp3Extractor;
import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/**
 * One {@link ExoPlayer}, behind the {@link DeckDriving} seam (card A-25,
 * docs/plans/android-assessment.md §5.4): the Media3 twin of the iOS {@code AVDeck}
 * (ForayAudioPlugin/Engine/AVDeck.swift, NE-15 / NE-32).
 *
 * <p>It speaks the CORE'S deck vocabulary ({@link DeckCommand} / {@link DeckEvent} in
 * foray-engine-core-jvm). It takes no playback decision of its own: what an uncommanded
 * pause means, what follows a deadline, when the out-point stops are the core's rulings
 * ({@code EngineCore}, {@link DeckPolicy}), fixture-pinned in {@code deck-episode},
 * {@code outpoint} and {@code deck}. This type runs commands against Media3 and reports
 * what it observed.
 *
 * <h2>THE LOAD PIPELINE IS GATED ON READINESS (P-1, P-8)</h2>
 *
 * <ol>
 *   <li>pause whatever sounds, then attach the source at the start position
 *       ({@code setMediaSource(source, startMs)}, {@code SeekParameters.EXACT});
 *   <li>{@code prepare()} with {@code playWhenReady} false;
 *   <li>report the duration once the timeline is real (the placeholder is not);
 *   <li>wait for {@code STATE_READY}: Media3's READY with play-when-ready off is the
 *       renderers holding decodable data AT THE START POSITION, which is what AVPlayer's
 *       zero-tolerance seek plus {@code preroll} buy on iOS. That is the preroll;
 *   <li>emit {@code ready(prerolled: true)}. {@code play} is refused until then.
 * </ol>
 *
 * <p>WHY NO RETRY AND NO "ORDINARY LOAD" FALLBACK, where AVDeck has both. AVDeck's retry
 * exists because {@code preroll} on a non-ready AVPlayer raises an uncatchable exception and
 * because an AVPlayer seek can be "interrupted". Media3 has neither failure mode: a seek is a
 * position the player lands on, and readiness is one state. So this deck never emits
 * {@code notReady}; a load that does not become READY ends at the deadline or as a failure.
 *
 * <h2>THE LOAD DEADLINE (P-13)</h2>
 *
 * <p>{@link Config#loadDeadlineSec} after the load started, a load that is not READY is
 * detached ({@code stop()} + {@code clearMediaItems()}, and the generation moves so nothing
 * that completes late can sound) and reported as {@code deadlineExceeded}. The timers run on
 * the player's own {@link Clock}, so a Robolectric test's {@code FakeClock} fires them in
 * virtual time.
 *
 * <h2>SAME SOURCE IS A SEEK, NOT A LOAD ({@code DeckPolicy.sameSourceIsSeek})</h2>
 *
 * <p>The core re-enters the item the deck holds with a fresh {@code load} (a paused listener's
 * play, an interruption's rewind). When the deck already holds that URL with the same timing
 * option, healthy and not idle past {@link Config#reuseMaxIdleSec}, the load KEEPS THE
 * SOURCE: a new token and generation, a {@code seekTo} in the buffer it has, and the same
 * gate (the next READY). No refetch. Anything else is a cold load, and the {@code attach}
 * row says why ({@code cold}).
 *
 * <h2>THE OUT-POINT (plan §4.3 P-2; the decisions are {@link DeckPolicy#outPointStep})</h2>
 *
 * <p>This type only runs the ops the watch returns, over two Media3 layers:
 * <ul>
 *   <li>{@code boundary}: a {@link PlayerMessage} at the out-point, delivered on this deck's
 *       looper. Media3 delivers a positioned message when the PLAYBACK position (what has been
 *       played, not what has been read) passes it, so it is never early by construction; the
 *       position is rounded UP to the millisecond the message takes;
 *   <li>{@code watchdog}: one clock timer until the window, then the poll, as on iOS.
 * </ul>
 * <p>{@code endTime} (AVPlayer's {@code forwardPlaybackEndTime}, the item stopping itself) has
 * no Media3 counterpart that can be set on a playing source: a {@code ClippingConfiguration}
 * is fixed when the source is built, and changing it re-prepares the source and throws the
 * buffer away, which is the refetch same-source reuse exists to avoid. So the endTime ops are
 * run as no-ops ({@link Config#outPointLayers} leaves the layer out), and the reducer, which
 * the fixtures pin, is unchanged. A file that runs out before its boundary is still the
 * item's one, natural, end ({@code ended:natural}).
 *
 * <p>NEVER EARLY: a layer's report before the playhead reached the boundary stops nothing
 * ({@code outPoint.early:}, a row) and the watchdog re-arms from where the playhead is.
 *
 * <h2>ROWS</h2>
 *
 * <p>The core writes the rows for the duration, a not-ready and a refusal. What only the deck
 * can see goes out through {@link Config#diag} as {@code deck} and {@code outPoint} rows:
 * the attach or reuse, {@code ready} with its elapsed ms per gate step, the deadline with the
 * step it was stuck on, a failure's Media3 error code (never its sentence), time-control
 * changes with the buffer ahead, and a stall. Tokens and numbers only; a URL never leaves
 * this type (its host does, as a token).
 *
 * <h2>ONE THREAD</h2>
 *
 * <p>Every call is on the player's application looper (the engine's), and Media3 delivers
 * every listener callback there. Each timer and each positioned message carries the load
 * {@code generation} it was armed under, so a callback that outlives its load (a superseded
 * load, a deadline, an unload) returns without effect.
 *
 * <h2>THE PLAYER</h2>
 *
 * <p>Handed in, so a test builds it with {@code TestExoPlayerBuilder} and a {@code FakeClock}.
 * The deck sets what a deck owns: {@code setWakeMode(C.WAKE_MODE_NETWORK)} (the CPU and the
 * Wi-Fi radio stay up while it plays with the screen off: the card's requirement, and the
 * reason this module's manifest declares WAKE_LOCK), {@code SeekParameters.EXACT}, no
 * repeat. Audio attributes, focus and becoming-noisy are the session's (A-26), and releasing
 * the player is its owner's: {@link #invalidate()} stops observing it and nothing more.
 */
@OptIn(markerClass = UnstableApi.class)
public final class ExoDeck implements DeckDriving {
    private static final String TAG = "ForayEngine.ExoDeck";

    /**
     * P-13: how long a load may take to reach READY before the deck gives up. PROVISIONAL,
     * and the same number as AVDeck's: NE-38 sets both from the field's time-to-ready rows.
     */
    public static final double DEFAULT_LOAD_DEADLINE_SEC = 20; // MEASURE: NE-38 (OQ-4, DV-5).

    /** A stop this close to the item's end is the end, not an uncommanded pause. */
    public static final double END_SLACK_SEC = 0.5;

    /**
     * How long a stopped-while-intending-to-play observation must hold before it is reported:
     * a play command in between cancels it (AVDeck measured the false report this prevents).
     */
    public static final double PAUSE_SETTLE_SEC = 0.25;

    /** How long a held source may have been idle and still be reused (AVDeck's reasoning, AVDeck's number). */
    public static final double DEFAULT_REUSE_MAX_IDLE_SEC = 600; // MEASURE: NE-38, from the attach/reuse rows.

    /**
     * How far below the boundary a layer's report may read and still be the boundary: the
     * player's position is whole milliseconds (truncated), the message position is rounded up.
     */
    public static final double LAYER_SLACK_SEC = 0.001;

    private static final int PRIMITIVE_CAP = 256;

    /** Makes the source for a load: the URL the core handed over and its timing option. */
    public interface MediaSourceMaker {
        MediaSource make(String url, boolean preciseTiming);
    }

    /**
     * Progressive sources over {@code dataSources}. {@code preciseTiming} (the core's choice:
     * bounded segments and local files) turns on MP3 INDEX SEEKING, which lands a VBR file with
     * no seek table on the frame the time names by reading up to it, instead of estimating a
     * byte offset from the first frame's bitrate. The approximate path is Media3's default
     * (constant-bitrate seeking when there is no table). docs/android-emulator-measurements.md
     * §8 has what each one costs in in-point error on the click tracks.
     */
    public static MediaSourceMaker progressive(DataSource.Factory dataSources) {
        ProgressiveMediaSource.Factory precise = new ProgressiveMediaSource.Factory(dataSources,
                new DefaultExtractorsFactory().setMp3ExtractorFlags(Mp3Extractor.FLAG_ENABLE_INDEX_SEEKING));
        ProgressiveMediaSource.Factory approximate = new ProgressiveMediaSource.Factory(dataSources,
                new DefaultExtractorsFactory().setConstantBitrateSeekingEnabled(true));
        return (url, preciseTiming) -> (preciseTiming ? precise : approximate).createMediaSource(MediaItem.fromUri(url));
    }

    /** What the deck is configured with. Every field has a production default but {@link #mediaSources}. */
    public static final class Config {
        public double loadDeadlineSec = DEFAULT_LOAD_DEADLINE_SEC;
        /**
         * Whether the engine's audio session is active (the session owner, A-26). The core's
         * audible-start invariant means a play should never arrive without one; this is the
         * backstop's question. Default: always, until the session owner exists.
         */
        public BooleanSupplier sessionIsActive = () -> true;
        /** A plain log line (the fault, the out-point). Default: logcat. */
        public Consumer<String> writeRow = row -> Log.i(TAG, row);
        /** DEBUG's hard stop for a broken invariant; injectable so a test can see it fire. Default: nothing. */
        public Consumer<String> debugFault = row -> {};
        /** The ring's structured rows ({@code deck}, {@code outPoint}). Default: nowhere. */
        public Consumer<EngineCommand.DiagEntry> diag = entry -> {};
        /** Required: see {@link #progressive}. */
        public MediaSourceMaker mediaSources;
        /** Which out-point layers run. Both Media3 has; a test arms one alone to prove it stops never-early. */
        public Set<OutPointLayer> outPointLayers = EnumSet.of(OutPointLayer.BOUNDARY, OutPointLayer.WATCHDOG);
        /** Same source is a seek. On in production. */
        public boolean reusesSameSource = true;
        public double reuseMaxIdleSec = DEFAULT_REUSE_MAX_IDLE_SEC;
    }

    private enum Stage {
        IDLE,
        /** Attached and prepared (or seeking in a held source); waiting for READY. */
        LOADING,
        READY,
        FAILED
    }

    /** A timer the deck armed; cancelling one that already ran is harmless. */
    private final class Timer implements Runnable {
        private final Runnable work;
        private boolean cancelled;

        Timer(Runnable work) {
            this.work = work;
        }

        @Override
        public void run() {
            if (cancelled || invalidated) return;
            cancelled = true;
            work.run();
        }

        void cancel() {
            if (!cancelled) {
                cancelled = true;
                handler.removeCallbacks(this);
            }
        }
    }

    /** A seek issued while READY, reported as {@code seeked} when the player is READY again. */
    private static final class PendingSeek {
        final int generation;
        final int token;

        PendingSeek(int generation, int token) {
            this.generation = generation;
            this.token = token;
        }
    }

    private final ExoPlayer player;
    private final Config config;
    private final Clock clock;
    private final HandlerWrapper handler;
    private final Player.Listener playerListener = new PlayerListener();
    private final List<String> primitives = new ArrayList<>();

    private DeckDriving.Listener listener;
    private Stage stage = Stage.IDLE;
    private Integer token;
    private int generation;
    private double targetStartSec;
    /** The current item was READY at least once: its duration and its buffer are real. */
    private boolean hasMetadata;
    private boolean durationReported;
    private long loadStartedAtMs;
    private Timer deadline;
    private double rate = 1;
    /** True from a commanded play until a commanded pause, the end, or an observed stop. */
    private boolean intendsToPlay;
    private boolean reachedEnd;
    private DeckEvent.TimeControlStatus lastTimeControl;
    private String lastWaitingReason;
    /** Bumped by every commanded play; a pause suspicion armed under an older value is void. */
    private int playSeq;
    private Timer pauseSuspicion;
    private boolean invalidated;
    private String loadedUrl;
    private boolean loadedPreciseTiming;
    private boolean reusedItem;
    private String gateStep = "idle";
    private final List<JsonNode.Member> gateMarks = new ArrayList<>();
    private long lastLiveMs;
    private PendingSeek pendingSeek;

    private DeckPolicy.OutPointWatch watch = new DeckPolicy.OutPointWatch();
    private PlayerMessage boundaryMessage;
    private Timer watchdog;

    public ExoDeck(@NonNull ExoPlayer player, @NonNull Config config) {
        if (config.mediaSources == null) throw new IllegalArgumentException("ExoDeck needs Config.mediaSources");
        this.player = player;
        this.config = config;
        this.clock = player.getClock();
        this.handler = clock.createHandler(player.getApplicationLooper(), null);
        // The deck's own settings (see THE PLAYER above).
        player.setWakeMode(C.WAKE_MODE_NETWORK);
        player.setSeekParameters(SeekParameters.EXACT);
        player.setRepeatMode(Player.REPEAT_MODE_OFF);
        player.setPlayWhenReady(false);
        player.addListener(playerListener);
    }

    @Override
    public void setListener(DeckDriving.Listener listener) {
        this.listener = invalidated ? null : listener;
    }

    @Override
    public void send(DeckCommand command) {
        checkThread();
        if (invalidated) return;
        switch (command) {
            case DeckCommand.Load c -> load(c.token(), c.url(), c.startSec(), c.preciseTiming());
            case DeckCommand.Play c -> play();
            case DeckCommand.Pause c -> pause();
            case DeckCommand.Seek c -> seek(c.toSec());
            case DeckCommand.SetRate c -> setRate(c.rate());
            case DeckCommand.SetOutPoint c -> setOutPoint(c.sec());
            case DeckCommand.Unload c -> unload();
        }
    }

    /**
     * The host reads this before every input. While a load is still gating, the playhead
     * reads as the START it will land on, not the player's position: an input handled in
     * that window (a pause, a restore write) would otherwise save a stale place.
     */
    @Override
    public DeckReading reading() {
        switch (stage) {
            case LOADING:
                return new DeckReading(targetStartSec, durationSec(), audible(), false);
            case READY:
                return new DeckReading(positionSec(), durationSec(), audible(), reachedEnd);
            default:
                return DeckReading.idle();
        }
    }

    /** Teardown: silence, detach, drop every timer and listener, and never report again. */
    @Override
    public void invalidate() {
        checkThread();
        if (invalidated) return;
        unload();
        cancelWatchdog();
        cancelBoundary();
        invalidated = true;
        listener = null;
        player.removeListener(playerListener);
    }

    /** Every Media3 call that can move the audible state, in order (bounded). The tests assert on it. */
    public List<String> primitives() {
        return Collections.unmodifiableList(new ArrayList<>(primitives));
    }

    /** The token of the load the deck holds, or null. */
    @Nullable
    public Integer token() {
        return token;
    }

    // ---------------------------------------------------------------- load

    private void load(int newToken, String url, double startSec, boolean preciseTiming) {
        // Whatever was sounding stops BEFORE the new source attaches: a play-when-ready player
        // would start the new one by itself the moment it buffered, before the gate.
        intendsToPlay = false;
        if (player.getPlayWhenReady()) {
            noteLive();
            record("pause (load)");
            player.pause();
        }
        resetOutPoint();
        Double idleSec = loadedUrl == null ? null : Math.max(0, (nowMs() - lastLiveMs) / 1000.0);
        String cold = coldReason(url, preciseTiming, idleSec);
        if (cold == null) {
            reuse(newToken, startSec, idleSec);
            return;
        }
        detach();
        generation += 1;
        token = newToken;
        stage = Stage.LOADING;
        targetStartSec = Math.max(0, startSec);
        hasMetadata = false;
        durationReported = false;
        reachedEnd = false;
        lastTimeControl = null;
        lastWaitingReason = null;
        pendingSeek = null;
        loadStartedAtMs = nowMs();
        loadedUrl = null;
        reusedItem = false;
        gateStep = "prepare";
        gateMarks.clear();
        // The core hands the page's audio_url through as it is. Anything that is not an
        // absolute URL fails THIS load, under its token, so the core's failure path runs.
        Uri uri = url == null ? null : Uri.parse(url);
        if (uri == null || uri.getScheme() == null) {
            stage = Stage.FAILED;
            record("no-url");
            clearPlayer();
            deckRow("failed", newToken, m("where", str("no-url")));
            emit(new DeckEvent.Failed(newToken, "no-url"));
            return;
        }
        MediaSource source = config.mediaSources.make(url, preciseTiming);
        loadedUrl = url;
        loadedPreciseTiming = preciseTiming;
        noteLive();
        armDeadline(generation);
        record("attach");
        deckRow("attach", newToken,
                m("startSec", sec(targetStartSec)),
                m("precise", JsonNode.bool(preciseTiming)),
                m("host", hostNode(uri.getHost())),
                // Why this load did not keep the held source (`no-item` when there was none).
                m("cold", str(cold)),
                m("idleSec", sec(idleSec)));
        player.setMediaSource(source, msOf(targetStartSec));
        player.prepare();
    }

    /**
     * {@code DeckPolicy.sameSourceIsSeek} from what this deck holds; null means keep the
     * source, any other answer is why the load is cold, as a row token.
     */
    private String coldReason(String url, boolean preciseTiming, Double idleSec) {
        if (!config.reusesSameSource) return "off";
        if (loadedUrl == null || player.getMediaItemCount() == 0) return "no-item";
        if (url == null || !url.equals(loadedUrl)) return "other-source";
        if (preciseTiming != loadedPreciseTiming) return "timing";
        boolean failed = stage == Stage.FAILED || player.getPlayerError() != null;
        if (failed) return "failed";
        int state = player.getPlaybackState();
        boolean metadata = hasMetadata && state != Player.STATE_IDLE;
        if (!metadata) return "not-ready";
        if (idleSec == null || idleSec > config.reuseMaxIdleSec) return "stale";
        return DeckPolicy.sameSourceIsSeek(loadedUrl, url, metadata, failed) ? null : "policy";
    }

    /** Same source: keep the source and its buffer, and run the same gate (the next READY) under the new token. */
    private void reuse(int newToken, double startSec, Double idleSec) {
        double fromSec = positionSec();
        cancelDeadline();
        cancelPauseSuspicion();
        generation += 1;
        token = newToken;
        stage = Stage.LOADING;
        targetStartSec = Math.max(0, startSec);
        reachedEnd = false;
        lastTimeControl = null;
        lastWaitingReason = null;
        pendingSeek = null;
        loadStartedAtMs = nowMs();
        reusedItem = true;
        durationReported = true;
        gateStep = "seek";
        gateMarks.clear();
        noteLive();
        armDeadline(generation);
        record("reuse");
        deckRow("reuse", newToken,
                m("startSec", sec(targetStartSec)),
                m("fromSec", sec(fromSec)),
                m("bufferedAheadSec", sec(bufferedAheadSec())),
                m("idleSec", sec(idleSec)));
        // Media3 masks a seek from READY or ENDED as BUFFERING at once, so the READY that
        // completes the gate is the one after this seek, never the one before it.
        player.seekTo(msOf(targetStartSec));
        if (player.getPlaybackState() == Player.STATE_READY) becomeReady();
    }

    private void becomeReady() {
        if (token == null) return;
        cancelDeadline();
        stage = Stage.READY;
        gateStep = "ready";
        mark("ready");
        noteLive();
        double landed = positionSec();
        int elapsed = msSinceLoadStarted();
        deckRow("ready", token,
                m("landedSec", sec(landed)),
                m("targetSec", sec(targetStartSec)),
                m("prerolled", JsonNode.TRUE),
                m("reuse", JsonNode.bool(reusedItem)),
                m("elapsedMs", JsonNode.num(elapsed)),
                m("attempts", JsonNode.num(0)),
                m("marks", new JsonNode.Obj(gateMarks)),
                m("bufferedAheadSec", sec(bufferedAheadSec())));
        emit(new DeckEvent.Ready(token, landed, true, elapsed));
    }

    private void reportDuration() {
        if (durationReported || token == null) return;
        long durationMs = player.getDuration();
        durationReported = true;
        mark("duration");
        emit(new DeckEvent.DurationLoaded(token, durationMs == C.TIME_UNSET ? null : durationMs / 1000.0));
    }

    // ---------------------------------------------------------------- the deadline (P-13)

    private void armDeadline(int gen) {
        cancelDeadline();
        deadline = new Timer(() -> deadlineFired(gen));
        handler.postDelayed(deadline, Math.round(config.loadDeadlineSec * 1000));
    }

    private void deadlineFired(int gen) {
        deadline = null;
        if (gen != generation || stage != Stage.LOADING || token == null) return;
        int afterMs = msSinceLoadStarted();
        int stuck = token;
        // Where it was stuck, read BEFORE the detach drops the source.
        deckRow("deadline", stuck,
                m("afterMs", JsonNode.num(afterMs)),
                m("step", str(gateStep)),
                m("reuse", JsonNode.bool(reusedItem)),
                m("durationKnown", JsonNode.bool(durationReported)),
                m("playerState", str(stateToken(player.getPlaybackState()))),
                m("loading", JsonNode.bool(player.isLoading())),
                m("targetSec", sec(targetStartSec)),
                m("bufferedAheadSec", sec(bufferedAheadSec())),
                m("marks", new JsonNode.Obj(gateMarks)));
        // Detach FIRST, and move the generation, so nothing that completes late can sound:
        // a URL that turns ready at 21 s must not start the wrong thing in the car.
        detach();
        generation += 1;
        stage = Stage.FAILED;
        record("detach (deadline)");
        clearPlayer();
        emit(new DeckEvent.DeadlineExceeded(stuck, afterMs));
    }

    // ---------------------------------------------------------------- transport

    private void play() {
        if (stage != Stage.READY || token == null) {
            // Plan §4.3: play is legal only after ready. A play before it would start an
            // unlanded source: audio at the wrong offset, the bug the gate exists to prevent.
            emit(new DeckEvent.Refused("play", stage == Stage.FAILED ? "failed" : "not-ready"));
            return;
        }
        // The core's audible-start invariant means this is never reached without an active
        // session. If it is, the row says so and DEBUG stops; release still plays, because
        // refusing would be silence in the car, and the row is what finds the core's bug.
        if (!config.sessionIsActive.getAsBoolean()) {
            String row = "fault implicit-activation deck token=" + token;
            config.writeRow.accept(row);
            config.debugFault.accept(row);
        }
        intendsToPlay = true;
        reachedEnd = false;
        noteLive();
        playSeq += 1;
        cancelPauseSuspicion();
        applyRateAndPlay();
        step(new OutPointEvent.Play(playheadSec(), nowMs()));
    }

    /** The only place this type starts audio. The rate is re-applied on EVERY play (plan §4.3). */
    private void applyRateAndPlay() {
        record("play rate=" + JSWriter.numberToString(rate));
        player.setPlaybackParameters(new PlaybackParameters((float) rate));
        player.play();
    }

    private void pause() {
        intendsToPlay = false;
        noteLive();
        record("pause");
        player.pause();
        step(new OutPointEvent.Pause(playheadSec()));
    }

    private void setRate(double newRate) {
        if (!(newRate > 0) || Double.isInfinite(newRate)) {
            emit(new DeckEvent.Refused("setRate", "non-positive"));
            return;
        }
        rate = newRate;
        record("rate=" + JSWriter.numberToString(newRate));
        // Speed is pitch-corrected time stretching (Sonic), the speech-quality algorithm.
        player.setPlaybackParameters(new PlaybackParameters((float) newRate));
        // Re-armed on every rate change: the watchdog's delay is WALL clock.
        step(new OutPointEvent.Rate(newRate, playheadSec(), nowMs()));
    }

    /** The out-point: hand the boundary to the watch. Null (or junk) disarms. A load drops it. */
    private void setOutPoint(Double sec) {
        if (loadedUrl == null || token == null) return;
        Double end = sec != null && !Double.isNaN(sec) && !Double.isInfinite(sec) && sec > 0 ? sec : null;
        step(new OutPointEvent.Load(token, end, playheadSec()));
        if (intendsToPlay && player.getPlayWhenReady()) step(new OutPointEvent.Play(playheadSec(), nowMs()));
    }

    private void seek(double toSec) {
        double target = Math.max(0, toSec);
        switch (stage) {
            case LOADING -> {
                // Before ready, a seek moves the start: the gate lands there.
                targetStartSec = target;
                record("seek " + JSWriter.numberToString(target) + " (gating)");
                player.seekTo(msOf(target));
            }
            case READY -> {
                if (token == null) return;
                reachedEnd = false;
                // A seek that has not landed yet is superseded: AVPlayer answers it finished=false.
                if (pendingSeek != null && pendingSeek.generation == generation) {
                    emit(new DeckEvent.Seeked(pendingSeek.token, positionSec(), false));
                }
                pendingSeek = new PendingSeek(generation, token);
                record("seek " + JSWriter.numberToString(target));
                // The watch moves with the seek NOW (a scrub past the boundary clears it before
                // the player gets there), and again from where it really landed.
                step(new OutPointEvent.Seek(target, nowMs()));
                player.seekTo(msOf(target));
                if (player.getPlaybackState() == Player.STATE_READY) seekLanded();
            }
            default -> emit(new DeckEvent.Refused("seek", "not-loaded"));
        }
    }

    private void seekLanded() {
        PendingSeek landedSeek = pendingSeek;
        pendingSeek = null;
        if (landedSeek == null || landedSeek.generation != generation) return;
        double landed = positionSec();
        step(new OutPointEvent.Seek(landed, nowMs()));
        emit(new DeckEvent.Seeked(landedSeek.token, landed, true));
    }

    private void unload() {
        intendsToPlay = false;
        if (player.getPlayWhenReady()) {
            record("pause (unload)");
            player.pause();
        }
        resetOutPoint();
        detach();
        generation += 1;
        token = null;
        stage = Stage.IDLE;
        pendingSeek = null;
        if (player.getMediaItemCount() > 0) {
            record("detach");
            clearPlayer();
        }
    }

    private void detach() {
        cancelDeadline();
        cancelPauseSuspicion();
        loadedUrl = null;
    }

    private void clearPlayer() {
        player.stop();
        player.clearMediaItems();
    }

    // ---------------------------------------------------------------- observation

    private final class PlayerListener implements Player.Listener {
        @Override
        public void onTimelineChanged(@NonNull Timeline timeline, int reason) {
            if (stage != Stage.LOADING || durationReported || timeline.isEmpty()) return;
            Timeline.Window window = timeline.getWindow(0, new Timeline.Window());
            // The placeholder timeline a source has before it is prepared knows no duration.
            if (window.isPlaceholder || window.durationUs == C.TIME_UNSET) return;
            reportDuration();
        }

        @Override
        public void onPlaybackStateChanged(int state) {
            int gen = generation;
            if (state == Player.STATE_READY) {
                if (stage == Stage.LOADING) {
                    hasMetadata = true;
                    mark("readiness");
                    reportDuration();
                    if (gen == generation && stage == Stage.LOADING) becomeReady();
                } else if (stage == Stage.READY && pendingSeek != null) {
                    seekLanded();
                }
            } else if (state == Player.STATE_ENDED) {
                itemEnded(gen);
            }
            timeControlChanged();
            checkUncommandedPause();
        }

        @Override
        public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
            timeControlChanged();
            checkUncommandedPause();
        }

        @Override
        public void onIsPlayingChanged(boolean isPlaying) {
            timeControlChanged();
            checkUncommandedPause();
        }

        @Override
        public void onPlaybackSuppressionReasonChanged(int reason) {
            timeControlChanged();
            checkUncommandedPause();
        }

        @Override
        public void onPlayerError(@NonNull PlaybackException error) {
            fail(generation, "player: " + error.getErrorCodeName(), "player", error);
        }
    }

    /**
     * P-14: waiting while the listener asked for sound is the core's {@code buffering: true};
     * the reason rides along for the stall rows NE-38 reads.
     */
    private void timeControlChanged() {
        if (token == null || invalidated) return;
        DeckEvent.TimeControlStatus status;
        String reason = null;
        if (player.isPlaying()) {
            status = DeckEvent.TimeControlStatus.PLAYING;
        } else if (player.getPlayWhenReady() && player.getPlaybackState() == Player.STATE_BUFFERING
                && player.getPlaybackSuppressionReason() == Player.PLAYBACK_SUPPRESSION_REASON_NONE) {
            status = DeckEvent.TimeControlStatus.WAITING;
            reason = player.isLoading() ? "buffering" : "not-loading";
        } else {
            status = DeckEvent.TimeControlStatus.PAUSED;
        }
        if (status == lastTimeControl && java.util.Objects.equals(reason, lastWaitingReason)) return;
        // P-14: PLAYING to WAITING with no seek or load of ours in flight is the player running
        // dry: a stall, reported before the waiting it causes, whichever of Media3's callbacks
        // (the state or is-playing) said so first.
        if (status == DeckEvent.TimeControlStatus.WAITING && lastTimeControl == DeckEvent.TimeControlStatus.PLAYING
                && stage == Stage.READY && pendingSeek == null && intendsToPlay) {
            itemStalled();
        }
        noteLive();
        lastTimeControl = status;
        lastWaitingReason = reason;
        deckRow("time-control", token,
                m("status", str(status.token)),
                m("reason", reason == null ? JsonNode.NULL : str(reason)),
                m("step", str(gateStep)),
                m("positionSec", sec(positionSec())),
                m("bufferedAheadSec", sec(bufferedAheadSec())),
                m("suppressed", JsonNode.num(player.getPlaybackSuppressionReason())),
                m("rate", JsonNode.num(rate)));
        emit(new DeckEvent.TimeControl(token, status, reason));
    }

    /**
     * Plan §4.3 "observe, don't believe" (Q-9). A stopped player while the deck intends to
     * play, not at the end, is reported ONCE as the reconcile input, after
     * {@link #PAUSE_SETTLE_SEC}, and a play command in between cancels it. STOPPED on Media3
     * is play-when-ready off (focus loss, becoming noisy, a remote) or playback suppressed (a
     * transient focus loss, an unsuitable output); BUFFERING with play-when-ready on is
     * waiting, not stopped. Once reported, the player is held paused: AVPlayer stays paused
     * after an interruption, and a suppressed ExoPlayer would otherwise start again by itself
     * when the suppression lifts, behind the core's back. What happens next is the core's.
     */
    private void checkUncommandedPause() {
        if (pauseSuspicion != null || !looksUncommandedPaused()) return;
        int gen = generation;
        int seq = playSeq;
        pauseSuspicion = new Timer(() -> {
            pauseSuspicion = null;
            if (gen != generation || seq != playSeq || !looksUncommandedPaused() || token == null) return;
            intendsToPlay = false;
            if (player.getPlayWhenReady()) {
                record("pause (uncommanded, suppressed)");
                player.pause();
            }
            step(new OutPointEvent.Pause(playheadSec()));
            emit(new DeckEvent.PausedUncommanded(token, positionSec()));
        });
        handler.postDelayed(pauseSuspicion, Math.round(PAUSE_SETTLE_SEC * 1000));
    }

    private boolean looksUncommandedPaused() {
        if (invalidated || stage != Stage.READY || !intendsToPlay || reachedEnd) return false;
        boolean stopped = !player.getPlayWhenReady()
                || player.getPlaybackSuppressionReason() != Player.PLAYBACK_SUPPRESSION_REASON_NONE;
        if (!stopped) return false;
        Double duration = durationSec();
        return duration == null || positionSec() < duration - END_SLACK_SEC;
    }

    /** STATE_ENDED: the file ran out. With an armed out-point the watch decides (the natural end, or a late boundary). */
    private void itemEnded(int gen) {
        if (gen != generation || token == null || stage != Stage.READY) return;
        double at = playheadSec();
        if (watch.outPointSec == null || watch.token != token) {
            finishAtEnd(token);
            return;
        }
        if (watch.fired && reachedEnd) return;
        double out = watch.outPointSec;
        if (watch.armed && at >= out - LAYER_SLACK_SEC) {
            step(new OutPointEvent.Layer(OutPointLayer.END_TIME, token, Math.max(at, out), nowMs()));
            return;
        }
        // The file ran out BEFORE the boundary (an authored end past the real audio): the
        // item's one, natural, end, written down when it was not at the file's end either.
        Double duration = durationSec();
        if (watch.armed && duration != null && at < duration - END_SLACK_SEC) {
            config.diag.accept(new EngineCommand.DiagEntry("outPoint", list(
                    m("kind", str("early")), m("layer", str(OutPointLayer.END_TIME.token)), m("token", JsonNode.num(token)))));
            config.writeRow.accept("outPoint early layer=endTime token=" + token + " at=" + JSWriter.numberToString(at)
                    + " out=" + JSWriter.numberToString(out));
        }
        step(new OutPointEvent.Ended(at));
    }

    private void finishAtEnd(int endedToken) {
        reachedEnd = true;
        intendsToPlay = false;
        noteLive();
        emit(new DeckEvent.Ended(endedToken));
    }

    private void itemStalled() {
        if (token == null) return;
        deckRow("stalled", token,
                m("positionSec", sec(positionSec())),
                m("bufferedAheadSec", sec(bufferedAheadSec())));
        // THE STALL IS A LATCH IN THE CORE, and only a timeControl(playing) releases it: the
        // waiting that follows is reported, and so is the playing that ends it.
        emit(new DeckEvent.Stalled(token));
    }

    /** The row carries Media3's error code and its name, never the message sentence. */
    private void fail(int gen, String message, String where, @Nullable PlaybackException error) {
        if (gen != generation || stage == Stage.FAILED || token == null) return;
        cancelDeadline();
        stage = Stage.FAILED;
        intendsToPlay = false;
        deckRow("failed", token,
                m("where", str(where)),
                m("step", str(gateStep)),
                m("positionSec", sec(positionSec())),
                m("errCode", error == null ? JsonNode.NULL : JsonNode.num(error.errorCode)),
                m("errName", error == null ? JsonNode.NULL : tokenNode(error.getErrorCodeName())));
        emit(new DeckEvent.Failed(token, message));
    }

    // ---------------------------------------------------------------- the out-point

    /** The playhead the watch reads: the player's, or the start a gating load will land on. */
    private double playheadSec() {
        return stage == Stage.READY ? positionSec() : targetStartSec;
    }

    /** Feed the watch one event and run the ops it answers, in order. */
    private void step(OutPointEvent event) {
        DeckPolicy.OutPointStep result = DeckPolicy.outPointStep(watch, event);
        watch = result.state();
        for (OutPointOp op : result.ops()) apply(op);
    }

    private void apply(OutPointOp op) {
        switch (op) {
            case OutPointOp.EndTime e -> {
                // No Media3 counterpart on a live source (see THE OUT-POINT above).
            }
            case OutPointOp.Boundary b -> {
                cancelBoundary();
                if (b.sec() == null || !config.outPointLayers.contains(OutPointLayer.BOUNDARY)) return;
                int gen = generation;
                int armedToken = watch.token;
                boundaryMessage = player.createMessage((type, payload) -> layerFired(OutPointLayer.BOUNDARY, armedToken, gen))
                        .setLooper(player.getApplicationLooper())
                        .setPosition((long) Math.ceil(b.sec() * 1000))
                        .setDeleteAfterDelivery(true)
                        .send();
            }
            case OutPointOp.WatchdogArm a -> {
                cancelWatchdog();
                if (!config.outPointLayers.contains(OutPointLayer.WATCHDOG)) return;
                int gen = generation;
                watchdog = new Timer(() -> watchdogFired(gen));
                handler.postDelayed(watchdog, (long) Math.ceil(a.ms()));
            }
            case OutPointOp.WatchdogCancel c -> cancelWatchdog();
            case OutPointOp.Stop s -> outPointStop(s.layer(), s.overshootMs());
            case OutPointOp.Early e -> {
                config.diag.accept(new EngineCommand.DiagEntry("outPoint", list(
                        m("kind", str("early")), m("layer", str(e.layer().token)), m("token", JsonNode.num(watch.token)))));
                config.writeRow.accept("outPoint early layer=" + e.layer().token + " token=" + watch.token);
            }
            case OutPointOp.Stale s -> {
                // A report for another token, an unarmed boundary, or after the stop: nothing.
            }
            case OutPointOp.EndedNatural n -> {
                if (token != null) finishAtEnd(token);
            }
        }
    }

    /** Layer 2's callback. Within {@link #LAYER_SLACK_SEC} below the boundary it reads as the boundary itself. */
    private void layerFired(OutPointLayer layer, int armedToken, int gen) {
        boundaryMessage = null;
        if (gen != generation || invalidated) return;
        double at = playheadSec();
        Double out = watch.outPointSec;
        if (out != null && at < out && at >= out - LAYER_SLACK_SEC) at = out;
        step(new OutPointEvent.Layer(layer, armedToken, at, nowMs()));
    }

    /** Layer 3's one timer came due; the wake is stamped no earlier than due (a timer can fire a hair early). */
    private void watchdogFired(int gen) {
        watchdog = null;
        if (gen != generation || invalidated) return;
        double now = Math.max(nowMs(), watch.timerDueMs != null ? watch.timerDueMs : 0);
        step(new OutPointEvent.Timer(playheadSec(), now));
    }

    /** A layer reached the boundary first: stop, write the {@code outPoint} row with the overshoot, report the end. */
    private void outPointStop(OutPointLayer layer, double overshootMs) {
        if (token == null) return;
        intendsToPlay = false;
        reachedEnd = true;
        noteLive();
        cancelPauseSuspicion();
        if (player.getPlayWhenReady()) {
            record("pause (out-point " + layer.token + ")");
            player.pause();
        }
        config.diag.accept(new EngineCommand.DiagEntry("outPoint", list(
                m("kind", str("stop")), m("layer", str(layer.token)), m("overshootMs", JsonNode.num(overshootMs)),
                m("rate", JsonNode.num(rate)), m("token", JsonNode.num(token)))));
        config.writeRow.accept("outPoint layer=" + layer.token + " overshootMs=" + JSWriter.numberToString(overshootMs)
                + " rate=" + JSWriter.numberToString(rate) + " token=" + token);
        emit(new DeckEvent.Ended(token));
    }

    /** A load or an unload: both layers and the timer go, and the watch starts over, keeping only the rate. */
    private void resetOutPoint() {
        cancelBoundary();
        cancelWatchdog();
        double heldRate = watch.rate;
        watch = new DeckPolicy.OutPointWatch();
        watch.rate = heldRate;
    }

    private void cancelBoundary() {
        if (boundaryMessage != null) boundaryMessage.cancel();
        boundaryMessage = null;
    }

    private void cancelWatchdog() {
        if (watchdog != null) watchdog.cancel();
        watchdog = null;
    }

    private void cancelDeadline() {
        if (deadline != null) deadline.cancel();
        deadline = null;
    }

    private void cancelPauseSuspicion() {
        if (pauseSuspicion != null) pauseSuspicion.cancel();
        pauseSuspicion = null;
    }

    // ---------------------------------------------------------------- helpers

    private void checkThread() {
        if (Looper.myLooper() != player.getApplicationLooper()) {
            throw new IllegalStateException("ExoDeck is confined to the player's application looper");
        }
    }

    private void emit(DeckEvent event) {
        DeckDriving.Listener target = listener;
        if (target != null && !invalidated) target.onEvent(event);
    }

    private void noteLive() {
        lastLiveMs = nowMs();
    }

    private long nowMs() {
        return clock.elapsedRealtime();
    }

    private int msSinceLoadStarted() {
        return (int) Math.max(0, nowMs() - loadStartedAtMs);
    }

    private void mark(String step) {
        for (JsonNode.Member member : gateMarks) if (member.key().equals(step)) return;
        gateMarks.add(m(step, JsonNode.num(msSinceLoadStarted())));
    }

    private double positionSec() {
        return player.getCurrentPosition() / 1000.0;
    }

    @Nullable
    private Double durationSec() {
        long duration = player.getDuration();
        return duration == C.TIME_UNSET ? null : duration / 1000.0;
    }

    private boolean audible() {
        int state = player.getPlaybackState();
        return player.getPlayWhenReady() && player.getPlaybackSuppressionReason() == Player.PLAYBACK_SUPPRESSION_REASON_NONE
                && (state == Player.STATE_READY || state == Player.STATE_BUFFERING);
    }

    private double bufferedAheadSec() {
        return Math.max(0, player.getBufferedPosition() - player.getCurrentPosition()) / 1000.0;
    }

    private static long msOf(double sec) {
        return Math.round(sec * 1000);
    }

    private void record(String op) {
        primitives.add(op);
        if (primitives.size() > PRIMITIVE_CAP) primitives.remove(0);
    }

    private void deckRow(String kind, int rowToken, JsonNode.Member... fields) {
        List<JsonNode.Member> members = new ArrayList<>();
        members.add(m("kind", str(kind)));
        members.add(m("token", JsonNode.num(rowToken)));
        Collections.addAll(members, fields);
        config.diag.accept(new EngineCommand.DiagEntry("deck", members));
    }

    private static List<JsonNode.Member> list(JsonNode.Member... members) {
        List<JsonNode.Member> out = new ArrayList<>();
        Collections.addAll(out, members);
        return out;
    }

    private static JsonNode.Member m(String key, JsonNode value) {
        return JsonNode.member(key, value);
    }

    private static JsonNode str(String value) {
        return JsonNode.str(value);
    }

    /** Three decimals, or null for a value a row cannot carry. */
    private static JsonNode sec(@Nullable Double value) {
        if (value == null || Double.isNaN(value) || Double.isInfinite(value)) return JsonNode.NULL;
        return JsonNode.num(Math.round(value * 1000) / 1000.0);
    }

    /** A host is a token (letters, digits, dots, dashes), lowercased; any other shape is null. */
    static JsonNode hostNode(@Nullable String host) {
        return tokenNode(host == null ? null : host.toLowerCase(Locale.ROOT));
    }

    static JsonNode tokenNode(@Nullable String text) {
        if (text == null || text.isEmpty() || text.length() > 128) return JsonNode.NULL;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '_';
            if (!ok) return JsonNode.NULL;
        }
        return JsonNode.str(text);
    }

    private static String stateToken(int state) {
        switch (state) {
            case Player.STATE_IDLE:
                return "idle";
            case Player.STATE_BUFFERING:
                return "buffering";
            case Player.STATE_READY:
                return "ready";
            case Player.STATE_ENDED:
                return "ended";
            default:
                return "other";
        }
    }
}
