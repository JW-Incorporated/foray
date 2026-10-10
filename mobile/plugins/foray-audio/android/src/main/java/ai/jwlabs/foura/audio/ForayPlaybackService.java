package ai.jwlabs.foura.audio;

import ai.jwlabs.foura.audio.engine.EngineAudio;
import ai.jwlabs.foura.audio.engine.EngineLog;
import ai.jwlabs.foura.audio.engine.EnginePlayer;
import ai.jwlabs.foura.audio.engine.EngineSeams;
import ai.jwlabs.foura.audio.engine.ExoDeck;
import ai.jwlabs.foura.audio.engine.FocusMapping;
import ai.jwlabs.foura.audio.engine.ForayEngineHost;
import ai.jwlabs.foura.audio.engine.HandlerTiming;
import ai.jwlabs.foura.engine.DeckReading;
import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.EngineConfig;
import ai.jwlabs.foura.engine.EngineInput;
import ai.jwlabs.foura.engine.EngineItem;
import ai.jwlabs.foura.engine.EngineState;
import ai.jwlabs.foura.engine.JSWriter;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.MediaMapping;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.CommandButton;
import androidx.media3.session.DefaultMediaNotificationProvider;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import androidx.media3.session.SessionCommand;
import androidx.media3.session.SessionCommands;
import androidx.media3.session.SessionResult;
import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;
import java.io.FileDescriptor;
import java.io.PrintWriter;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * THE NATIVE ENGINE'S SERVICE (card A-26, docs/plans/android-assessment.md §5.4, Track A1): a
 * Media3 {@link MediaSessionService} that hosts the engine ({@link ForayEngineHost} over the JVM
 * core and the {@link ExoDeck}) and publishes it as ONE media session, whose player is the
 * {@link EnginePlayer} facade over the core's snapshot. The Android twin of what iOS spreads over
 * {@code ForayEngine}, {@code AudioSessionOwner}, {@code RemoteSurface} and
 * {@code NowPlayingPublisher}.
 *
 * <h2>WHAT IT DOES, BY THE CARD</h2>
 * <ul>
 *   <li>The session player is a {@code SimpleBasePlayer} facade ({@link EnginePlayer}), the
 *       {@code WebViewPlayer} pattern: presses become {@link EngineInput.RemotePress}es, and the
 *       lock screen, the shade and a car read the core's snapshot.</li>
 *   <li>{@link DefaultMediaNotificationProvider}, with the 15/30 pair as the session's media
 *       button preferences, granted to every controller in {@code onConnect} (the media
 *       notification controller included: that grant is what puts them into the PLATFORM
 *       session's custom actions, which A04-F2 found empty on the JS lane's hand-built
 *       notification).</li>
 *   <li>The deck's ExoPlayer is built with {@code setAudioAttributes(CONTENT_TYPE_SPEECH,
 *       USAGE_MEDIA, handleAudioFocus = true)} (a duck becomes pause-and-resume, because Media3
 *       pauses speech rather than ducking it) and {@code setHandleAudioBecomingNoisy(true)};
 *       {@link FocusMapping} turns what Media3 did into the core's session events.</li>
 *   <li>Media buttons (a headset, a steering wheel, {@code cmd media_session dispatch}) arrive
 *       through the session as the facade's commands, and each one is an
 *       {@code EngineInput.remote}.</li>
 *   <li>In native mode it replaces {@code PlaybackKeepAliveService}: while it hosts the engine,
 *       {@code ForayAudioPlugin.start} refuses to start the legacy service, and its
 *       {@code onCreate} stops one that is running. The legacy service stays, unchanged, for
 *       the JS lane.</li>
 *   <li>A core relinquish (the page's {@code relinquish}, A-29) ends the session with the
 *       engine (CH3-07): the host's torn-down hook releases the session, the facade and the
 *       deck's player and stops the service, so the legacy lane's session is the only one a car
 *       sees, and {@code ForayAudioPlugin.start} may start the legacy service again.</li>
 * </ul>
 *
 * <h2>WHO STARTS IT</h2>
 *
 * Nothing in a shipping build yet. Native mode on Android is off ({@code mobile/ENGINE_DEFAULT.json}
 * {@code android: js}, A-20) and the page's native branch is A-28's; until then the only client is
 * the DEBUG build's {@code EngineDriveReceiver} ({@code src/debug}), which the native-mode leg of
 * {@code android-playback.yml} drives over adb. A client binds with a {@code MediaController}
 * (the Media3 way: the service is created bound, and Media3 promotes it to the foreground when the
 * facade reports playing).
 *
 * <h2>THE DUMP</h2>
 *
 * {@code adb shell dumpsys activity service ai.jwlabs.foura/ai.jwlabs.foura.audio.ForayPlaybackService}
 * prints one {@code ForayEngine {json}} line (the core's state, the deck's playhead, the surface)
 * and the engine's last rows. It is read on the main thread (the dump waits up to two seconds for
 * it), because the core and the player are confined there. The native-mode scenarios read it; so
 * can a device pass.
 */
@OptIn(markerClass = UnstableApi.class)
public class ForayPlaybackService extends MediaSessionService {
    private static final String TAG = EngineLog.TAG;
    static final String SESSION_ID = "foray-engine";
    /** Not the legacy service's 1837: the two must never overwrite each other's notification. */
    static final int NOTIFICATION_ID = 1838;
    static final String CMD_SEEK_BACK = PlaybackKeepAliveService.CMD_SEEK_BACK;
    static final String CMD_SEEK_FORWARD = PlaybackKeepAliveService.CMD_SEEK_FORWARD;
    /** The dump's first line starts with this, then one JSON object. */
    static final String DUMP_PREFIX = "ForayEngine ";
    /** How many of the ring's rows the dump prints. */
    static final int DUMP_ROWS = 80;

    @Nullable private static volatile ForayPlaybackService current;

    @Nullable private ExoPlayer exo;
    @Nullable private ExoDeck deck;
    /**
     * Volatile: {@link #isHosting()} is read by the plugin's bridge thread; every other use is on
     * main. Null from the moment the engine tears down (its hook releases everything) or the
     * service is destroyed, so non-null IS "hosting" and the bridge thread never asks the host.
     */
    @Nullable private volatile ForayEngineHost host;
    @Nullable private EnginePlayer player;
    @Nullable private MediaSession session;
    @Nullable private Player.Listener focusListener;
    private final FocusMapping focus = new FocusMapping();
    private final EngineLog log = new EngineLog();

    /** The live service, or null. Main thread. */
    @Nullable
    static ForayPlaybackService current() {
        return current;
    }

    /**
     * Native mode owns playback: this service is alive and holds its engine. Called on the
     * plugin's bridge thread, so it reads the two volatiles and nothing else (CH3-07, R5-05):
     * the host's own {@code tornDown} is main-thread state, and a torn-down host is never held.
     */
    static boolean isHosting() {
        ForayPlaybackService s = current;
        return s != null && s.host != null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        PlaybackKeepAliveService.ensureChannel(this);
        if (PlaybackKeepAliveService.isRunning()) {
            /* ONE OWNER OF THE MEDIA SESSION. Native mode replaces the legacy service; a legacy
               service left running would publish a second session and a second notification. */
            log.diag(new EngineCommand.DiagEntry("owner", kind("stop-legacy")));
            try {
                stopService(new Intent(this, PlaybackKeepAliveService.class));
            } catch (RuntimeException e) {
                Log.w(TAG, "could not stop the legacy service", e);
            }
        }
        try {
            attach(new ExoPlayer.Builder(this).build());
        } catch (RuntimeException e) {
            Log.w(TAG, "could not build the native engine; the service holds no session", e);
            release();
        }
        setMediaNotificationProvider(new DefaultMediaNotificationProvider.Builder(this)
                .setChannelId(PlaybackKeepAliveService.CHANNEL_ID)
                .setChannelName(R.string.foray_playback_channel_name)
                .setNotificationId(NOTIFICATION_ID)
                .build());
        current = this;
    }

    /**
     * Build the engine over {@code built}: the deck, the host, the facade and the session, and
     * the focus listener. Package-private so a test hands in a {@code TestExoPlayerBuilder}
     * player instead.
     */
    void attach(@NonNull ExoPlayer built) {
        exo = built;
        EngineAudio.configure(built);
        ExoDeck.Config config = new ExoDeck.Config();
        config.context = this;
        config.mediaSources = ExoDeck.progressive(new DefaultDataSource.Factory(this));
        config.diag = log::diag;
        config.sessionIsActive = () -> session != null;
        deck = new ExoDeck(built, config);
        EngineSeams seams = new EngineSeams(deck, new SessionSeam(), new HandlerTiming(Looper.getMainLooper()), log);
        ForayEngineHost engine = new ForayEngineHost(seams, new EngineConfig(buildName(this)));
        host = engine;
        engine.setOnTornDown(() -> engineTornDown(engine));
        EnginePlayer facade = new EnginePlayer(Looper.getMainLooper(), new EnginePlayer.Engine() {
            @Override
            public ForayEngineHost.Surface surface() {
                // Fresh: the playhead is read at the moment Media3 builds its state.
                return engine.freshSurface();
            }

            @Override
            public ForayEngineHost.Verdict remote(EngineInput.RemotePress press) {
                return engine.remote(press);
            }
        });
        player = facade;
        MediaSession.Builder builder = new MediaSession.Builder(this, facade)
                .setId(SESSION_ID)
                .setMediaButtonPreferences(seekButtons())
                .setCallback(new SessionCallback());
        PendingIntent launch = launchIntent();
        if (launch != null) builder.setSessionActivity(launch);
        session = builder.build();
        engine.setSurfaceListener(surface -> facade.refresh());
        engine.start();
        Player.Listener listener = new Player.Listener() {
            @Override
            public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
                feed(focus.onPlayWhenReadyChanged(playWhenReady, reason));
            }

            @Override
            public void onPlaybackSuppressionReasonChanged(int reason) {
                ExoPlayer p = exo;
                feed(focus.onSuppressionChanged(reason, p == null ? Player.STATE_IDLE : p.getPlaybackState()));
            }
        };
        focusListener = listener;
        built.addListener(listener);
    }

    private void feed(List<EngineInput.SessionEvent> events) {
        ForayEngineHost engine = host;
        if (engine == null) return;
        for (EngineInput.SessionEvent event : events) engine.handle(new EngineInput.Session(event));
    }

    @Nullable
    @Override
    public MediaSession onGetSession(@NonNull MediaSession.ControllerInfo controllerInfo) {
        return session;
    }

    @Override
    public void onDestroy() {
        if (current == this) current = null;
        release();
        super.onDestroy();
    }

    /**
     * The host's torn-down hook. A core relinquish leaves playback to the legacy lane, and on
     * Android that lane publishes its own session ({@code PlaybackKeepAliveService}), so ours
     * goes: released (with the facade and the deck's player), no longer current, and stopped.
     * The host has already handed the facade a cleared surface. When {@link #release()} is what
     * tore the engine down ({@code onDestroy}), {@code host} is already null and this is a no-op.
     */
    private void engineTornDown(ForayEngineHost engine) {
        if (host != engine) return;
        if (current == this) current = null;
        release();
        stopSelf();
    }

    private void release() {
        ForayEngineHost engine = host;
        host = null;
        if (engine != null) engine.teardown();
        MediaSession s = session;
        session = null;
        try {
            if (s != null) {
                // The notification goes with the session: a session left added would keep it.
                if (isSessionAdded(s)) removeSession(s);
                s.release();
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "releasing the session failed", e);
        }
        EnginePlayer facade = player;
        player = null;
        try {
            if (facade != null) facade.release();
        } catch (RuntimeException e) {
            Log.w(TAG, "releasing the facade failed", e);
        }
        ExoPlayer p = exo;
        exo = null;
        deck = null;
        if (p != null) {
            if (focusListener != null) p.removeListener(focusListener);
            focusListener = null;
            try {
                p.release();
            } catch (RuntimeException e) {
                Log.w(TAG, "releasing the player failed", e);
            }
        }
    }

    // ---- what a client (the debug driver today, the bridge in A-28) calls, on main

    /** Run one input through the engine. Null when there is no engine. */
    @Nullable
    ForayEngineHost.Verdict handle(@NonNull EngineInput input) {
        ForayEngineHost engine = host;
        return engine == null ? null : engine.handle(input);
    }

    /** The engine's host, or null (tests and the dump). */
    @Nullable
    ForayEngineHost host() {
        return host;
    }

    @Nullable
    MediaSession session() {
        return session;
    }

    @Nullable
    ExoPlayer exoPlayer() {
        return exo;
    }

    FocusMapping focusMapping() {
        return focus;
    }

    List<String> rows() {
        return log.lines();
    }

    /** Items from the queue JSON a client sends: an array of item objects (id, audio_url, …). */
    static List<EngineItem> items(@NonNull String json) {
        JsonNode node = JsonNode.parse(json);
        List<EngineItem> out = new ArrayList<>();
        List<JsonNode> array = node.arrayValue();
        if (array == null) return out;
        for (JsonNode item : array) {
            EngineItem e = EngineItem.of(item);
            if (e != null) out.add(e);
        }
        return out;
    }

    // ---- the session: its seam, its buttons and its callback

    /**
     * The core's audio session on Android. Focus is Media3's (see {@link EngineSeams.Session}),
     * so activation answers whether the session that owns the lock screen is alive and, for a
     * press, whether a call holds the audio (CH3-08); the rest are rows, because Android has no
     * category to re-apply and no session to rebuild.
     */
    private final class SessionSeam implements EngineSeams.Session {
        @Override
        public EngineSeams.Activation activate() {
            if (session == null) return new EngineSeams.Activation(false, "other", null);
            /* A CALL IS A REFUSED ACTIVATION, AS ON iOS (CH3-08, R5-02). Media3 asks for focus a
               turn after the press (FocusIntegrationTest), too late to fail it; iOS's
               setActive(true) fails in the press's turn, insufficient-priority for a call, which
               the core answers commandFailed(session-failed:other). Android reads the same fact
               up front from the audio mode: no permission, no focus request of its own. */
            /* An interruption's resume is not a press: it is the core answering Media3's
               AUDIOFOCUS_GAIN, which the system sends only once the call has given focus up. The
               audio mode can still say IN_CALL at that moment (Telecom abandons the call's focus,
               then resets the mode, which AudioService applies on its own thread), so the resume
               does not ask it: refusing would be R5-02's "nothing resumes after the call". */
            if (resumingAnInterruption()) return EngineSeams.Activation.granted();
            String call = callInProgress(audioMode());
            if (call == null) return EngineSeams.Activation.granted();
            String token = "insufficient-priority";
            List<JsonNode.Member> fields = kind("activate-refused");
            fields.add(JsonNode.member("token", JsonNode.str(token)));
            fields.add(JsonNode.member("call", JsonNode.str(call)));
            log.diag(new EngineCommand.DiagEntry("session", fields));
            return new EngineSeams.Activation(false, token, null);
        }

        @Override
        public void deactivate(boolean notifyOthers) {
            log.diag(new EngineCommand.DiagEntry("session", kind("deactivate-noop")));
        }

        @Override
        public void reapplyCategory() {
            log.diag(new EngineCommand.DiagEntry("session", kind("reapply-noop")));
        }

        @Override
        public void rebuild() {
            log.diag(new EngineCommand.DiagEntry("session", kind("rebuild-noop")));
        }
    }

    /**
     * Whether the activation the core is asking for is an interruption's resume (its parked
     * intent, {@code onInterruptionEnded}'s or the begin it falls back to), not a listener's press.
     */
    private boolean resumingAnInterruption() {
        ForayEngineHost engine = host;
        EngineState.PendingActivation parked = engine == null ? null : engine.state().pendingActivation;
        return parked != null && parked.intent() instanceof EngineState.DeferredIntent.InterruptionResume;
    }

    /** The audio mode now, or {@code MODE_NORMAL} when there is no AudioManager to ask. */
    private int audioMode() {
        AudioManager audio = getSystemService(AudioManager.class);
        return audio == null ? AudioManager.MODE_NORMAL : audio.getMode();
    }

    /**
     * The call an audio mode says is in progress, as the {@code session} row spells it, or null:
     * {@code MODE_IN_CALL} is a telephony call, {@code MODE_IN_COMMUNICATION} a VoIP one. Both
     * hold the audio, so a play would be refused focus. {@code getMode()} needs no permission;
     * the telephony call state would need READ_PHONE_STATE. A ringing phone
     * ({@code MODE_RINGTONE}) is not a call yet: Media3's own request answers for it.
     */
    @Nullable
    static String callInProgress(int audioMode) {
        if (audioMode == AudioManager.MODE_IN_CALL) return "in-call";
        if (audioMode == AudioManager.MODE_IN_COMMUNICATION) return "in-communication";
        return null;
    }

    /** The 15/30 pair: the session's media button preferences, shown by the default notification and the system controls. */
    ImmutableList<CommandButton> seekButtons() {
        CommandButton back = new CommandButton.Builder(CommandButton.ICON_SKIP_BACK_15)
                .setDisplayName(getString(R.string.foray_action_seek_back))
                .setSessionCommand(new SessionCommand(CMD_SEEK_BACK, Bundle.EMPTY))
                .build();
        CommandButton forward = new CommandButton.Builder(CommandButton.ICON_SKIP_FORWARD_30)
                .setDisplayName(getString(R.string.foray_action_seek_forward))
                .setSessionCommand(new SessionCommand(CMD_SEEK_FORWARD, Bundle.EMPTY))
                .build();
        return ImmutableList.of(back, forward);
    }

    /** The custom commands every controller is granted: the pair above. */
    static SessionCommands sessionCommands() {
        return MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
                .add(new SessionCommand(CMD_SEEK_BACK, Bundle.EMPTY))
                .add(new SessionCommand(CMD_SEEK_FORWARD, Bundle.EMPTY))
                .build();
    }

    /** A custom command as the remote press it is, or null for one this session does not know. */
    @Nullable
    static MediaMapping.RemoteCommand remoteFor(@NonNull String customAction) {
        if (CMD_SEEK_BACK.equals(customAction)) return MediaMapping.RemoteCommand.SKIP_BACKWARD;
        if (CMD_SEEK_FORWARD.equals(customAction)) return MediaMapping.RemoteCommand.SKIP_FORWARD;
        return null;
    }

    private final class SessionCallback implements MediaSession.Callback {
        @NonNull
        @Override
        public MediaSession.ConnectionResult onConnect(@NonNull MediaSession s, @NonNull MediaSession.ControllerInfo controller) {
            return new MediaSession.ConnectionResult.AcceptedResultBuilder(s)
                    .setAvailableSessionCommands(sessionCommands())
                    .build();
        }

        @NonNull
        @Override
        public ListenableFuture<SessionResult> onCustomCommand(@NonNull MediaSession s,
                @NonNull MediaSession.ControllerInfo controller, @NonNull SessionCommand command, @NonNull Bundle args) {
            MediaMapping.RemoteCommand remote = remoteFor(command.customAction);
            ForayEngineHost engine = host;
            if (remote == null || engine == null) {
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_ERROR_NOT_SUPPORTED));
            }
            ForayEngineHost.Verdict verdict = engine.remote(new EngineInput.RemotePress(remote, null, null,
                    Looper.myLooper() == Looper.getMainLooper()));
            return Futures.immediateFuture(new SessionResult(verdict.ok()
                    ? SessionResult.RESULT_SUCCESS : SessionResult.RESULT_ERROR_INVALID_STATE));
        }
    }

    @Nullable
    private PendingIntent launchIntent() {
        try {
            Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
            if (launch == null) return null;
            return PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        } catch (RuntimeException e) {
            return null;
        }
    }

    static String buildName(Context context) {
        try {
            String v = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
            return "android-" + (v == null ? "" : v);
        } catch (Exception e) {
            return "android";
        }
    }

    /** A one-field row body, {@code kind=<token>}. (Not {@code List.of}: that is API 30, and minSdk is 24.) */
    private static List<JsonNode.Member> kind(String token) {
        List<JsonNode.Member> fields = new ArrayList<>(1);
        fields.add(JsonNode.member("kind", JsonNode.str(token)));
        return fields;
    }

    // ---- the dump

    /** The engine's state as one JSON object, read on main. */
    String snapshot() {
        ForayEngineHost engine = host;
        List<JsonNode.Member> m = new ArrayList<>();
        m.add(JsonNode.member("engine", JsonNode.str("android-native")));
        m.add(JsonNode.member("hosting", JsonNode.bool(engine != null && !engine.isTornDown())));
        m.add(JsonNode.member("legacyRunning", JsonNode.bool(PlaybackKeepAliveService.isRunning())));
        if (engine != null) {
            EngineState st = engine.state();
            DeckReading reading = deck != null ? deck.reading() : DeckReading.idle();
            EngineItem item = st.currentItem();
            m.add(JsonNode.member("state", JsonNode.str(st.stateType())));
            m.add(JsonNode.member("running", JsonNode.bool(st.isRunning())));
            m.add(JsonNode.member("index", JsonNode.num(st.currentIndex)));
            m.add(JsonNode.member("queue", JsonNode.num(st.queue.size())));
            m.add(JsonNode.member("item", item == null ? JsonNode.NULL : JsonNode.str(item.id)));
            m.add(JsonNode.member("positionSec", reading.positionSec == null ? JsonNode.NULL : JsonNode.num(reading.positionSec)));
            m.add(JsonNode.member("durationSec", reading.durationSec == null ? JsonNode.NULL : JsonNode.num(reading.durationSec)));
            m.add(JsonNode.member("audible", JsonNode.bool(reading.audible)));
            m.add(JsonNode.member("session", JsonNode.str(st.session.token)));
            m.add(JsonNode.member("buffering", JsonNode.bool(st.buffering)));
            m.add(JsonNode.member("activations", JsonNode.num(engine.activations())));
            m.add(JsonNode.member("focusTransientOpen", JsonNode.bool(focus.transientOpen())));
            ForayEngineHost.Surface surface = engine.freshSurface();
            List<JsonNode> enabled = new ArrayList<>();
            for (MediaMapping.RemoteCommand c : MediaMapping.RemoteCommand.values()) {
                if (surface.availability().isEnabled(c)) enabled.add(JsonNode.str(c.name()));
            }
            m.add(JsonNode.member("enabled", new JsonNode.Arr(enabled)));
            MediaMapping.SessionView view = surface.view();
            m.add(JsonNode.member("playbackState", view == null ? JsonNode.NULL : JsonNode.str(view.playbackState())));
            m.add(JsonNode.member("title", view == null ? JsonNode.NULL : JsonNode.str(view.metadata().title())));
            m.add(JsonNode.member("artist", view == null ? JsonNode.NULL : JsonNode.str(view.metadata().artist())));
        }
        ExoPlayer p = exo;
        if (p != null) {
            m.add(JsonNode.member("exoPlayWhenReady", JsonNode.bool(p.getPlayWhenReady())));
            m.add(JsonNode.member("exoState", JsonNode.num(p.getPlaybackState())));
            m.add(JsonNode.member("exoSuppression", JsonNode.num(p.getPlaybackSuppressionReason())));
            m.add(JsonNode.member("exoPlaying", JsonNode.bool(p.isPlaying())));
        }
        m.add(JsonNode.member("isPlaybackOngoing", JsonNode.bool(isPlaybackOngoing())));
        return JSWriter.stringify(new JsonNode.Obj(m));
    }

    @Override
    protected void dump(FileDescriptor fd, PrintWriter writer, String[] args) {
        AtomicReference<String> json = new AtomicReference<>();
        AtomicReference<List<String>> rows = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        Runnable read = () -> {
            try {
                json.set(snapshot());
                rows.set(rows());
            } catch (RuntimeException e) {
                json.set("{\"error\":" + JSWriter.quote(e.getClass().getSimpleName()) + "}");
            } finally {
                done.countDown();
            }
        };
        if (Looper.myLooper() == Looper.getMainLooper()) {
            read.run();
        } else {
            new Handler(Looper.getMainLooper()).post(read);
            try {
                if (!done.await(2, TimeUnit.SECONDS)) {
                    writer.println(DUMP_PREFIX + "{\"error\":\"main-thread-timeout\"}");
                    return;
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
        writer.println(DUMP_PREFIX + json.get());
        List<String> lines = rows.get();
        if (lines == null) return;
        int from = Math.max(0, lines.size() - DUMP_ROWS);
        for (int i = from; i < lines.size(); i++) writer.println("ForayEngine.row " + lines.get(i));
    }
}
