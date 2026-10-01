package ai.jwlabs.foura.audio;

import ai.jwlabs.foura.audio.engine.DeckDriving;
import ai.jwlabs.foura.audio.engine.DeckPair;
import ai.jwlabs.foura.audio.engine.EngineAudio;
import ai.jwlabs.foura.audio.engine.EngineLane;
import ai.jwlabs.foura.audio.engine.EngineLog;
import ai.jwlabs.foura.audio.engine.EnginePlayer;
import ai.jwlabs.foura.audio.engine.EngineSeams;
import ai.jwlabs.foura.audio.engine.EngineStore;
import ai.jwlabs.foura.audio.engine.ExoDeck;
import ai.jwlabs.foura.audio.engine.FocusMapping;
import ai.jwlabs.foura.audio.engine.ForayEngineHost;
import ai.jwlabs.foura.audio.engine.ForegroundWatch;
import ai.jwlabs.foura.audio.engine.HandlerTiming;
import ai.jwlabs.foura.audio.engine.InterludePlayer;
import ai.jwlabs.foura.audio.engine.MediaJingle;
import ai.jwlabs.foura.audio.engine.SpeechLexicon;
import ai.jwlabs.foura.audio.engine.SpeechNarrator;
import ai.jwlabs.foura.audio.engine.TtsOutput;
import ai.jwlabs.foura.engine.DeckDeadlineClass;
import ai.jwlabs.foura.engine.DeckReading;
import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.EngineConfig;
import ai.jwlabs.foura.engine.EngineCore;
import ai.jwlabs.foura.engine.EngineInput;
import ai.jwlabs.foura.engine.EngineItem;
import ai.jwlabs.foura.engine.EngineState;
import ai.jwlabs.foura.engine.JSWriter;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.MediaMapping;
import ai.jwlabs.foura.engine.RestoreRecord;
import android.app.Notification;
import android.app.UiModeManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.content.res.Configuration;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import androidx.media3.common.MediaItem;
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
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
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
 * </ul>
 *
 * <h2>WHO STARTS IT</h2>
 *
 * The page's bridge (A-28): {@code EngineOwnership} binds it with a {@code MediaController} when
 * the process's lane is native, which on Android is the build's default since A-31
 * ({@code mobile/ENGINE_DEFAULT.json} {@code android: native}). The DEBUG build's
 * {@code EngineDriveReceiver} ({@code src/debug}) is a second client, which the native-mode leg of
 * {@code android-playback.yml} drives over adb. A client binds with a {@code MediaController}
 * (the Media3 way: the service is created bound, and Media3 promotes it to the foreground when the
 * facade reports playing).
 *
 * <h2>WHAT IT KEEPS, AND THE CAR'S PLAY AFTER A DEATH (A-27)</h2>
 *
 * The engine's writes go to {@link EngineStore}: the shared position rows in the page's
 * Preferences file and the restore record in the engine's own, each committed before the write
 * returns. When the process dies (a swipe, the low-memory killer, a crash) the session dies with
 * it, and Android sends a media button PLAY to the last media button receiver: ours,
 * {@link ForayMediaButtonReceiver}, switched on in {@link #onCreate} before the session is built.
 * It starts this service with the key event; the session is empty and says it can resume
 * ({@code EnginePlayer}), so Media3 asks {@code onPlaybackResumption} for a playlist, applies it
 * (the host's {@code coldBoot} from the record: the recorded item, paused at the recorded
 * position, nothing activated), and plays, which the engine does from that position. The iOS
 * twin is NE-24's cold path; there the boot paints first because iOS has no resumption callback,
 * and here Media3's own door is the trigger. A page that binds a cold service (A-28) boots from
 * the same record through {@link #restoreIfCold}.
 *
 * <h2>THE DUMP</h2>
 *
 * {@code adb shell dumpsys activity service ai.jwlabs.foura/ai.jwlabs.foura.audio.ForayPlaybackService}
 * prints one {@code ForayEngine {json}} line (the core's state, the deck's playhead, the surface)
 * and the engine's last rows. It is read on the main thread (the dump waits up to two seconds for
 * it), because the core and the player are confined there. The native-mode scenarios read it; so
 * can a device pass. Since A-30 it also says whether the process is in the native lane
 * ({@code nativeLane}, {@link EngineOwnership#engineLane}), which every native scenario gates on.
 *
 * <h2>THE FORAY TAPE (A-40)</h2>
 *
 * The engine is built with the Foray tape on, over a {@link DeckPair} of two ExoPlayers: the
 * playing deck and the standby one the core warms at the next segment's in-point while the first
 * is still audible. Both players are configured alike ({@link EngineAudio}); the focus listener
 * follows the deck that holds the player role, so the paused outgoing deck losing focus to the
 * incoming one at a handover is never read as an interruption. An episode never warms the
 * standby: it plays through the active deck exactly as before. Since A-42 (the A2 flip) the
 * build advertises {@code foray}, so the page's own Foray tap plays here; the debug driver can
 * still hand one over.
 *
 * <h2>THE NARRATOR AND THE JINGLE (A-41)</h2>
 *
 * A rendered narration line is an ordinary file on the deck pair. The engine's own synthesiser
 * ({@link SpeechNarrator} over {@link TtsOutput}, Android {@code TextToSpeech} in this process) speaks
 * a spoken line, a rendered line's fallback (its file failed or missed its deadline) and the voice
 * picker's audition, with the bundled lexicon ({@link SpeechLexicon}). The seam's jingle is
 * {@link InterludePlayer} on the bundled, hash-pinned asset ({@link MediaJingle}); when the asset is
 * missing or differs, the core is built with {@code interludeAvailable} off and no seam waits on a
 * jingle. Both are released with the engine at its teardown. The dump says whether the synthesiser
 * answered ({@code speaker}) and whether the jingle is there ({@code interlude}).
 *
 * <h2>THE FOREGROUND THROUGH A SILENT SEAM (A-65)</h2>
 *
 * A process that runs this foreground service is not suspended; the Android risk in a Foray's
 * silent seam is the service LEAVING the foreground, which Media3 decides from the facade alone
 * (play-when-ready on, READY or BUFFERING; {@link EnginePlayer#keepsServiceInForeground}). The
 * facade keeps saying so through the seam beat and a spoken line, and no silence is rendered (the
 * silence node stays off, as on iOS, NE-46). Two rows would show it failed: the host's
 * {@code grace kind=late ... inSeam=} (NE-46's detector, mirrored; the deck's P-13 deadlines are
 * handed to it here) and this service's {@code fgs kind=left} ({@link ForegroundWatch}), written
 * from Media3's own decision in {@link #onUpdateNotificationAsync}. And a swipe from Recents
 * (Media3's {@code onTaskRemoved}, which keeps the service only while the player
 * {@code isPlaying()}) keeps it too while the facade still says play-when-ready through a seam beat
 * or a stall ({@link #keepsRunningOnTaskRemoved}), so the beat's BUFFERING does not make a swipe
 * stop a Foray a READY clip would have kept.
 *
 * <h2>THE VOICE PREVIEW (A-66, mirrors NE-47)</h2>
 *
 * An audition that names a rendered {@code preview.m4a} plays on a THIRD player, the preview deck
 * ({@link ExoDeck} over its own ExoPlayer, configured as the others by {@link EngineAudio}, so its
 * play requests audio focus for the tap that asked), never on the pair, so a paused Foray's item is
 * untouched. Its rows say {@code lane=preview}. A load that has not answered inside
 * {@link #PREVIEW_LOAD_DEADLINE_SEC}, or that fails, is spoken by {@code TextToSpeech} instead. The
 * page sends no url until the picker offers rendered voices, so until then this player loads nothing.
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
    /**
     * A-66 (iOS {@code EngineBoot.previewLoadDeadlineSec}, NE-47): how long the voice preview's load
     * may take before the audition is spoken instead, for every deadline class on the preview deck.
     * PROVISIONAL, iOS's value: a listener tapped "preview" and is waiting, so this is well under the
     * main deck's 20 s (P-13), and above the few seconds a cold 64 kbps {@code .m4a} of a sentence
     * takes on a slow cellular link. The {@code lane=preview} deck rows carry the load's time to ready
     * and any deadline; the first week of rendered-voice previews settles it.
     */
    static final double PREVIEW_LOAD_DEADLINE_SEC = 6; // MEASURE: verdict=preview-load (NE-47, A-66). Rows: deck kind=ready elapsedMs lane=preview, deck kind=deadline lane=preview, audition kind=fallback reason=timeout.

    @Nullable private static volatile ForayPlaybackService current;

    /** The player of the deck that holds the player role (the focus listener's). */
    @Nullable private ExoPlayer exo;
    /** Every player the service built (one, or the pair's two), for the release. */
    private final List<ExoPlayer> players = new ArrayList<>();
    /** A-66: the voice preview's player (its own deck), or null; released with the others. */
    @Nullable private ExoPlayer previewPlayer;
    @Nullable private DeckDriving deck;
    /** The Foray tape's deck pair (A-40), or null with one deck. */
    @Nullable private DeckPair pair;
    /** A-41: the engine's synthesiser (for the dump), and its jingle player (null when the asset did not ship). */
    @Nullable private TtsOutput speech;
    @Nullable private InterludePlayer jingle;
    /** Volatile: {@link #isHosting()} is read by the plugin's bridge thread; every other use is on main. */
    @Nullable private volatile ForayEngineHost host;
    @Nullable private EnginePlayer player;
    @Nullable private MediaSession session;
    @Nullable private Player.Listener focusListener;
    /** A-41 review: headphones out while no deck plays (a spoken line, the jingle); see {@link FocusMapping}. */
    @Nullable private BroadcastReceiver noisyReceiver;
    private final FocusMapping focus = new FocusMapping();
    /** A-61: route resume's ears (the devices added and removed, car mode), and its device callback. */
    @Nullable private RouteWatcher routes;
    @Nullable private AudioDeviceCallback deviceCallback;
    /** Car mode as {@link #onConfigurationChanged} last saw it, so only a change reports. */
    private boolean lastCarMode;
    /** The process's log (A-28): the page's bridge reads its ring and shared rows in every lane. */
    private final EngineLog log = EngineLog.process();
    /** The process's store over that log (A-27): what the engine keeps across a process death. */
    @Nullable private EngineStore store;
    /** What the cold boot found, once it ran (the dump; null until then). */
    @Nullable private ForayEngineHost.ColdBootOutcome coldBoot;
    /** A-65: Media3's foreground decisions, and the {@code fgs kind=left} row. */
    private final ForegroundWatch foreground = new ForegroundWatch();

    /** The live service, or null. Main thread. */
    @Nullable
    static ForayPlaybackService current() {
        return current;
    }

    /** Native mode owns playback: this service is alive and its engine is not torn down. */
    static boolean isHosting() {
        ForayPlaybackService s = current;
        return s != null && s.host != null && !s.host.isTornDown();
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
        /* A-27: on BEFORE the session is built, because Media3 reads the manifest's media button
           receiver when it builds one, and hands it to the platform session then. Only when this
           process's lane is the native engine's (A-27 review): a JS-lane process that starts this
           service by another door never arms a car's PLAY for the native engine. */
        if (EngineOwnership.engineLane(this)) ForayMediaButtonReceiver.setEnabled(this, true);
        try {
            // A-40: the Foray tape's deck pair, the second player the standby deck. A-66: the third is
            // the voice preview's.
            attach(new ExoPlayer.Builder(this).build(), new ExoPlayer.Builder(this).build(), new ExoPlayer.Builder(this).build());
        } catch (RuntimeException e) {
            Log.w(TAG, "could not build the native engine; the service holds no session", e);
            release();
        }
        setMediaNotificationProvider(new DefaultMediaNotificationProvider.Builder(this)
                .setChannelId(PlaybackKeepAliveService.CHANNEL_ID)
                .setChannelName(R.string.foray_playback_channel_name)
                .setNotificationId(NOTIFICATION_ID)
                .build());
        /* A-27: the service owns its one session from the start, not from the first bind. After
           a process death Android may restart this service on its own (START_STICKY), and a media
           key can then reach the session directly, with no bind and no media button intent: a
           session the service had not added would play with no notification and never be
           promoted to the foreground. */
        MediaSession s = session;
        if (s != null) addSession(s);
        current = this;
    }

    /**
     * Build the engine over {@code built} alone: one deck, no standby. Package-private so a test
     * hands in a {@code TestExoPlayerBuilder} player instead.
     */
    void attach(@NonNull ExoPlayer built) {
        attach(built, null);
    }

    /**
     * Build the engine over {@code built} and, for the Foray tape's deck pair (A-40), the
     * {@code standby} player: the decks, the host, the facade and the session, and the focus
     * listener on the deck that plays. With no standby it is one deck, as in A-26.
     */
    void attach(@NonNull ExoPlayer built, @Nullable ExoPlayer standby) {
        attach(built, standby, null);
    }

    /**
     * As {@link #attach(ExoPlayer, ExoPlayer)}, and with {@code preview} the voice preview's own
     * deck (A-66); with none, a preview's load is answered failed and the audition is spoken.
     */
    void attach(@NonNull ExoPlayer built, @Nullable ExoPlayer standby, @Nullable ExoPlayer preview) {
        exo = built;
        players.add(built);
        EngineAudio.configure(built);
        ExoDeck first = new ExoDeck(built, deckConfig());
        if (standby != null) {
            players.add(standby);
            EngineAudio.configure(standby);
            ExoDeck second = new ExoDeck(standby, deckConfig());
            DeckPair.Config pairConfig = new DeckPair.Config();
            pairConfig.diag = log::diag;
            pairConfig.onActiveChanged = this::activeDeckChanged;
            pair = new DeckPair(first, second, pairConfig);
            deck = pair;
        } else {
            deck = first;
        }
        EngineStore kept = processStore(this);
        store = kept;
        HandlerTiming timing = new HandlerTiming(Looper.getMainLooper());
        /* A-41: the engine's synthesiser (TextToSpeech in this process, with the bundled lexicon) and
           the seam's jingle (the bundled, pinned asset; null when it did not ship). Each checks the
           session answer before it sounds, as the deck does. */
        TtsOutput tts = new TtsOutput(this, Looper.getMainLooper(), log::diag);
        speech = tts;
        SpeechNarrator.Config speakerConfig = new SpeechNarrator.Config();
        speakerConfig.sessionIsActive = () -> session != null;
        speakerConfig.diag = log::diag;
        speakerConfig.lexicon = SpeechLexicon.load(getAssets());
        SpeechNarrator narrator = new SpeechNarrator(tts, speakerConfig);
        InterludePlayer interlude = MediaJingle.make(this, () -> session != null, log::diag, timing);
        jingle = interlude;
        /* A-61: route resume. The watcher is the current route the core reads on every turn, and the
           store keeps the known routes (ForayEngine.knownRoutes) with the install's salt. */
        RouteWatcher watcher = new RouteWatcher(this::inCarMode, timing::monoMs);
        routes = watcher;
        lastCarMode = inCarMode();
        /* A-66 (NE-47): the voice preview's deck, a player of its own whose rows say lane=preview. */
        ExoDeck previewDeck = null;
        if (preview != null) {
            previewPlayer = preview;
            EngineAudio.configure(preview);
            previewDeck = new ExoDeck(preview, previewDeckConfig());
        }
        EngineSeams seams = new EngineSeams(deck, new SessionSeam(), timing, kept, narrator, interlude).withRoutes(watcher, kept)
                .withPreview(previewDeck);
        // A-40: the Foray tape on (the core refuses playForay without it), over the pair when there is one.
        // A-41: the jingle only when its player exists.
        // A-61: the Bluetooth arm as mobile/ENGINE_DEFAULT.json's android block says (off); the host
        // adds the install's salt and the known routes from the store.
        ForayEngineHost engine = new ForayEngineHost(seams, new EngineConfig(buildName(this))
                .withForayTape(true, standby != null).withInterludeAvailable(interlude != null)
                .withRouteResume(EngineLane.ROUTE_RESUME_BLUETOOTH, "", null));
        host = engine;
        // A-65: the deck's own P-13 deadlines, so a late one under grace writes `grace kind=late timer=load-deadline`.
        engine.setLoadDeadlines(loadDeadlinesMs());
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

            @Override
            public boolean canResume() {
                return !engine.isTornDown() && !engine.hasHandledInput() && kept.restorable();
            }

            @Override
            public void resume() {
                restoreIfCold();
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
        /* A-40 review: the seam beat holds the CPU (ForayEngineHost, THE BEAT HOLDS THE CPU). Between
           two segments no player plays, so no Media3 lock is held; Media3's own managers again, on
           the first player's playback looper, whose release runs after the teardown lets this go. */
        engine.setBeatAwake(ExoDeck.systemGateAwake(this, built)::setStayAwake);
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
        registerNoisyReceiver();
        registerDeviceCallback(watcher);
    }

    /** A-65: {@link ExoDeck}'s P-13 deadline per class, in ms, as the decks this service builds run them. */
    static Map<DeckDeadlineClass, Double> loadDeadlinesMs() {
        Map<DeckDeadlineClass, Double> deadlines = new EnumMap<>(DeckDeadlineClass.class);
        deadlines.put(DeckDeadlineClass.CLIP, ExoDeck.DEFAULT_LOAD_DEADLINE_SEC * 1000);
        deadlines.put(DeckDeadlineClass.LINE, ExoDeck.DEFAULT_LINE_LOAD_DEADLINE_SEC * 1000);
        return deadlines;
    }

    /**
     * A-61: the devices added and removed, for route resume ({@link RouteWatcher}). SEEDED BEFORE
     * REGISTERING, as SessionMonitor is: the platform answers a registration with an added call for
     * every device already present, and those are not routes coming back. Wrapped: a callback that
     * cannot register costs route resume, never the service.
     */
    private void registerDeviceCallback(@NonNull RouteWatcher watcher) {
        if (deviceCallback != null) return;
        try {
            AudioManager audio = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (audio == null) return;
            watcher.seed(devices(audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)));
            AudioDeviceCallback callback = new AudioDeviceCallback() {
                @Override
                public void onAudioDevicesAdded(AudioDeviceInfo[] added) {
                    feedRoutes(watcher.onAdded(devices(added)));
                }

                @Override
                public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) {
                    feedRoutes(watcher.onRemoved(devices(removed)));
                }
            };
            audio.registerAudioDeviceCallback(callback, new Handler(Looper.getMainLooper()));
            deviceCallback = callback;
        } catch (RuntimeException e) {
            Log.w(TAG, "could not observe audio devices; route resume will not hear a car", e);
        }
    }

    private void unregisterDeviceCallback() {
        AudioDeviceCallback callback = deviceCallback;
        deviceCallback = null;
        if (callback == null) return;
        try {
            AudioManager audio = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (audio != null) audio.unregisterAudioDeviceCallback(callback);
        } catch (RuntimeException e) {
            Log.w(TAG, "unregistering the device callback failed", e);
        }
    }

    /** The outputs among {@code infos}, as the watcher keeps them (a source, a microphone, is never one). */
    @NonNull
    static List<RouteWatcher.Device> devices(@Nullable AudioDeviceInfo[] infos) {
        List<RouteWatcher.Device> out = new ArrayList<>();
        if (infos == null) return out;
        for (AudioDeviceInfo d : infos) {
            if (d != null && (d.isSink() || !d.isSource())) out.add(RouteWatcher.Device.of(d));
        }
        return out;
    }

    /** Car UI mode ({@code UiModeManager}): Android Auto's projection, or a car dock. */
    private boolean inCarMode() {
        try {
            UiModeManager ui = (UiModeManager) getSystemService(Context.UI_MODE_SERVICE);
            return ui != null && ui.getCurrentModeType() == Configuration.UI_MODE_TYPE_CAR;
        } catch (RuntimeException e) {
            return false;
        }
    }

    /** A-61: entering car mode reports the current route again, classed {@code car} ({@link RouteWatcher#onCarMode}). */
    @Override
    public void onConfigurationChanged(@NonNull Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        RouteWatcher watcher = routes;
        if (watcher == null) return;
        boolean car = (newConfig.uiMode & Configuration.UI_MODE_TYPE_MASK) == Configuration.UI_MODE_TYPE_CAR;
        if (car == lastCarMode) return;
        lastCarMode = car;
        feedRoutes(watcher.onCarMode(car));
    }

    /** The watcher for the tests (null once released). */
    @Nullable
    RouteWatcher routeWatcher() {
        return routes;
    }

    /** BECOMING_NOISY as FocusMapping reports it: a loss that names no port, which {@link #feed} has the watcher name. */
    void becomingNoisy() {
        List<EngineInput.SessionEvent> events = new ArrayList<>(1);
        events.add(new EngineInput.SessionEvent.Route(new EngineInput.RouteChange(true)));
        feed(events);
    }

    /** Route changes from the watcher, as the core's session events. */
    void feedRoutes(@NonNull List<EngineInput.RouteChange> changes) {
        List<EngineInput.SessionEvent> events = new ArrayList<>(changes.size());
        for (EngineInput.RouteChange change : changes) events.add(new EngineInput.SessionEvent.Route(change));
        feed(events);
    }

    /**
     * A-41 review, BECOMING NOISY WITH NO DECK PLAYING ({@link FocusMapping}): Media3's receiver is
     * on only while a deck plays, so a spoken line or the jingle would go on out of the speaker
     * after the headphones came out. This one feeds the lost route when the engine runs and the
     * active deck does not play. Wrapped: a receiver that cannot register costs that pause, not
     * the service.
     */
    private void registerNoisyReceiver() {
        if (noisyReceiver != null) return;
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (intent == null || !AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) return;
                ForayEngineHost engine = host;
                ExoPlayer p = exo;
                if (engine == null) return;
                feed(FocusMapping.onBecomingNoisyOffDeck(p != null && p.getPlayWhenReady(), engine.state().isRunning()));
            }
        };
        try {
            ContextCompat.registerReceiver(this, receiver, new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
                    ContextCompat.RECEIVER_EXPORTED);
            noisyReceiver = receiver;
        } catch (RuntimeException e) {
            Log.w(TAG, "could not register the becoming-noisy receiver; a spoken line will not pause on unplug", e);
        }
    }

    private void unregisterNoisyReceiver() {
        BroadcastReceiver receiver = noisyReceiver;
        noisyReceiver = null;
        if (receiver == null) return;
        try {
            unregisterReceiver(receiver);
        } catch (RuntimeException e) {
            Log.w(TAG, "unregistering the becoming-noisy receiver failed", e);
        }
    }

    private ExoDeck.Config deckConfig() {
        ExoDeck.Config config = new ExoDeck.Config();
        config.context = this;
        config.mediaSources = ExoDeck.progressive(new DefaultDataSource.Factory(this));
        config.diag = log::diag;
        config.sessionIsActive = () -> session != null;
        return config;
    }

    /**
     * A-66 (iOS's preview {@code AVDeck}, NE-47): the voice preview's deck. One deadline for every
     * class ({@link #PREVIEW_LOAD_DEADLINE_SEC}), no same-source reuse (a preview is a few seconds of
     * a voice, played once), and every row tagged {@code lane=preview}, so a Copy never mistakes them
     * for the main deck's.
     */
    private ExoDeck.Config previewDeckConfig() {
        ExoDeck.Config config = deckConfig();
        config.loadDeadlineSec = PREVIEW_LOAD_DEADLINE_SEC;
        config.lineLoadDeadlineSec = PREVIEW_LOAD_DEADLINE_SEC;
        config.reusesSameSource = false;
        config.diag = entry -> log.diag(previewLane(entry));
        return config;
    }

    /** {@code entry} with {@code lane=preview} appended. */
    static EngineCommand.DiagEntry previewLane(EngineCommand.DiagEntry entry) {
        List<JsonNode.Member> fields = new ArrayList<>(entry.fields());
        fields.add(JsonNode.member("lane", JsonNode.str("preview")));
        return new EngineCommand.DiagEntry(entry.kind(), fields);
    }

    /**
     * A handover gave the player role to the other deck: the focus listener moves with it, so what
     * the ENGINE hears about focus is always the playing deck's. The outgoing deck, paused, loses
     * focus to the incoming one when that one plays, and that loss is nobody's interruption.
     */
    private void activeDeckChanged(int index) {
        if (index < 0 || index >= players.size()) return;
        ExoPlayer next = players.get(index);
        ExoPlayer previous = exo;
        Player.Listener listener = focusListener;
        if (next == previous) return;
        if (previous != null && listener != null) previous.removeListener(listener);
        exo = next;
        if (listener != null) next.addListener(listener);
    }

    private void feed(List<EngineInput.SessionEvent> events) {
        ForayEngineHost engine = host;
        if (engine == null) return;
        RouteWatcher watcher = routes;
        for (EngineInput.SessionEvent event : events) {
            /* A-61: a BECOMING_NOISY loss names no port (FocusMapping reads only the player); the
               watcher names the route that is going, or drops it when a removal already said so. */
            if (watcher != null && event instanceof EngineInput.SessionEvent.Route r && r.change().oldDeviceUnavailable()
                    && r.change().portType() == null) {
                EngineInput.RouteChange named = watcher.onNoisy();
                if (named == null) continue;
                event = new EngineInput.SessionEvent.Route(named);
            }
            engine.handle(new EngineInput.Session(event));
        }
    }

    @Nullable
    @Override
    public MediaSession onGetSession(@NonNull MediaSession.ControllerInfo controllerInfo) {
        return session;
    }

    /**
     * A MEDIA BUTTON START THIS SERVICE CANNOT KEEP IS DECLINED, NOT LEFT TO CRASH (A-27 review).
     *
     * <p>A media button intent can start this service in the foreground with nothing to play:
     * below API 31 Media3 hands EVERY session the app builds, the JS lane's
     * {@code PlaybackKeepAliveService} one included, a media button PendingIntent to the app's one
     * {@code MediaSessionService}, which since A-26 is this one; so after a JS-lane process died,
     * a headset's or a car's PLAY lands here, in a process whose lane is the page's player and
     * with no record. Media3 would ask {@code onPlaybackResumption}, fail, play nothing, and never
     * call {@code startForeground}: on API 26 to 30 the system then kills the app for a
     * foreground start that never happened. So a media button intent is passed to Media3 only
     * when the engine can act on it ({@link #answersMediaButton}); otherwise the service keeps
     * the start's promise for a moment (a foreground notification, taken down at once, as
     * Media3's own {@code stopSelfSafely} does for a session it has no answer for) and stops.
     * Nothing plays, which is what the JS lane did with that press before A-26.
     */
    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        if (intent != null && Intent.ACTION_MEDIA_BUTTON.equals(intent.getAction()) && !answersMediaButton()) {
            declineMediaButtonStart();
            return START_NOT_STICKY;
        }
        return super.onStartCommand(intent, flags, startId);
    }

    /**
     * Whether a media button intent reaching this service can be acted on: the engine already
     * handled an input (a notification button, a press into a session in use), or it is cold and
     * a PLAY resumes the record in the native lane ({@link ForayMediaButtonReceiver#answersColdPress}).
     */
    boolean answersMediaButton() {
        ForayEngineHost engine = host;
        if (engine == null || engine.isTornDown()) return false;
        if (engine.hasHandledInput()) return true;
        return ForayMediaButtonReceiver.answersColdPress(this);
    }

    private void declineMediaButtonStart() {
        log.diag(new EngineCommand.DiagEntry("owner", kind("decline-media-button")));
        try {
            PlaybackKeepAliveService.ensureChannel(this);
            Notification notification = new NotificationCompat.Builder(this, PlaybackKeepAliveService.CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.ic_media_play)
                    .setContentTitle(getString(R.string.foray_playback_notification_title))
                    .setSilent(true)
                    .build();
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification,
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                            ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK : 0);
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        } catch (RuntimeException e) {
            // Not startable in the foreground from here (API 31+, from the background): nothing to keep.
            Log.w(TAG, "declining a media button start", e);
        } finally {
            stopSelf();
        }
    }

    /**
     * A-65: every notification update carries Media3's foreground decision; the watch writes
     * {@code fgs kind=left} when it turns from foreground to not with an engine behind it. Media3's
     * own update runs unchanged.
     */
    @NonNull
    @Override
    public ListenableFuture<Void> onUpdateNotificationAsync(@NonNull MediaSession session, boolean startInForegroundRequired) {
        noteForegroundDecision(startInForegroundRequired);
        return super.onUpdateNotificationAsync(session, startInForegroundRequired);
    }

    /** One foreground decision into the watch, and its row into the log. Main thread. */
    void noteForegroundDecision(boolean startInForegroundRequired) {
        ForayEngineHost engine = host;
        EngineState st = engine == null || engine.isTornDown() ? null : engine.state();
        EngineCommand.DiagEntry row = foreground.onDecision(startInForegroundRequired, st);
        if (row != null) log.diag(row);
    }

    /** Whether Media3 last said this service runs in the foreground (the dump, the tests). */
    boolean foregroundRequired() {
        return foreground.inForeground();
    }

    /**
     * A-65: a swipe from Recents. Media3 stops the service unless playback is ongoing AND the player
     * {@code isPlaying()}, which a seam beat or a stall (BUFFERING) is not; the facade still says
     * play-when-ready there, so the Foray goes on as it would through a READY clip.
     */
    @Override
    public void onTaskRemoved(@Nullable Intent rootIntent) {
        if (keepsRunningOnTaskRemoved(isPlaybackOngoing(), player)) return;
        super.onTaskRemoved(rootIntent);
    }

    /** {@link #onTaskRemoved}'s rule: in the foreground, and the facade still engaged (play-when-ready, READY or BUFFERING). */
    static boolean keepsRunningOnTaskRemoved(boolean playbackOngoing, @Nullable Player facade) {
        return playbackOngoing && facade != null && EnginePlayer.keepsServiceInForeground(facade);
    }

    @Override
    public void onDestroy() {
        if (current == this) current = null;
        release();
        super.onDestroy();
    }

    private void release() {
        unregisterNoisyReceiver();
        unregisterDeviceCallback();
        routes = null;
        ForayEngineHost engine = host;
        host = null;
        if (engine != null) engine.teardown();
        MediaSession s = session;
        session = null;
        try {
            if (s != null) s.release();
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
        pair = null;
        speech = null;
        jingle = null;
        store = null;
        if (p != null && focusListener != null) p.removeListener(focusListener);
        focusListener = null;
        for (ExoPlayer built : new ArrayList<>(players)) {
            try {
                built.release();
            } catch (RuntimeException e) {
                Log.w(TAG, "releasing a player failed", e);
            }
        }
        players.clear();
        ExoPlayer shown = previewPlayer;
        previewPlayer = null;
        if (shown != null) {
            try {
                shown.release();
            } catch (RuntimeException e) {
                Log.w(TAG, "releasing the preview player failed", e);
            }
        }
    }

    // ---- the cold path (A-27)

    @Nullable private static EngineStore processStore;
    /** The application the store was built over (a test's Robolectric application changes per test). */
    @Nullable private static Context processStoreContext;

    /**
     * The process's store (A-27), over the process's log: the service's output and the page
     * bridge's records, so {@code engineRead("rows")} answers with the persisted rows and a
     * "Delete my data" in any lane removes what an earlier native session stored. When it stops
     * (or starts again) holding a record a PLAY can resume, it switches the media button receiver.
     * Main thread.
     */
    static EngineStore processStore(Context context) {
        Context app = context.getApplicationContext() != null ? context.getApplicationContext() : context;
        if (processStore == null || processStoreContext != app) {
            /* On again only in the native lane (A-27 review): a JS-lane process never arms it. */
            processStore = new EngineStore(app, EngineLog.process(),
                    resumable -> ForayMediaButtonReceiver.setEnabled(app, resumable && EngineOwnership.engineLane(app)));
            processStoreContext = app;
        }
        return processStore;
    }

    /**
     * The host's cold boot from the stored restore record, once, before any input: the Media3
     * resumption's (through the facade), and A-28's page attach. Later calls are {@code LATE}
     * and change nothing. Main thread.
     */
    @Nullable
    ForayEngineHost.ColdBootOutcome restoreIfCold() {
        ForayEngineHost engine = host;
        EngineStore kept = store;
        if (engine == null || kept == null) return null;
        /* Once per service: a boot that found nothing (no record) leaves the core untouched, and
           asking again would only repeat its row. */
        if (coldBoot != null) return ForayEngineHost.ColdBootOutcome.LATE;
        ForayEngineHost.ColdBootOutcome outcome = engine.coldBoot(kept.restoreRecord());
        if (outcome != ForayEngineHost.ColdBootOutcome.LATE) coldBoot = outcome;
        return outcome;
    }

    @Nullable
    EngineStore store() {
        return store;
    }

    /**
     * Media3's playback resumption answer (A-27): the restored item, at the recorded position,
     * or a failure when the store holds nothing a play can resume (Media3 then plays as asked,
     * and the engine answers {@code noActionableNowPlayingItem}). Nothing is restored HERE: the
     * boot runs when Media3 applies the answer ({@code EnginePlayer.handleSetMediaItems}), so a
     * metadata-only ask ({@code isForPlayback} false) changes nothing.
     */
    ListenableFuture<MediaSession.MediaItemsWithStartPosition> resumption(boolean isForPlayback) {
        EngineStore kept = store;
        RestoreRecord record = kept == null ? null : kept.restoreRecord();
        EngineCore.ColdRestore restored = record == null ? null : EngineCore.restoring(record, new EngineConfig(buildName(this)));
        List<JsonNode.Member> fields = new ArrayList<>();
        fields.add(JsonNode.member("kind", JsonNode.str(restored == null ? "none" : "answer")));
        fields.add(JsonNode.member("forPlayback", JsonNode.bool(isForPlayback)));
        fields.add(JsonNode.member("record", JsonNode.str(record == null ? "none" : record.mode().token)));
        if (restored != null) {
            fields.add(JsonNode.member("item", JsonNode.str(restored.queue().get(restored.index()).id)));
            fields.add(JsonNode.member("offsetSec", JsonNode.num(record.offsetSec())));
        }
        log.diag(new EngineCommand.DiagEntry("resumption", fields));
        if (restored == null) {
            return Futures.immediateFailedFuture(new UnsupportedOperationException("no restorable record"));
        }
        MediaItem item = EnginePlayer.resumptionItem(restored.queue().get(restored.index()));
        return Futures.immediateFuture(new MediaSession.MediaItemsWithStartPosition(
                ImmutableList.of(item), 0, Math.round(record.offsetSec() * 1000)));
    }

    // ---- what a client (the page's bridge, the debug driver) calls, on main

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

    /** A-66: the voice preview's own player, or null. */
    @Nullable
    ExoPlayer previewPlayer() {
        return previewPlayer;
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
     * so activation answers whether the session that owns the lock screen is alive; the rest are
     * rows, because Android has no category to re-apply and no session to rebuild.
     */
    private final class SessionSeam implements EngineSeams.Session {
        @Override
        public EngineSeams.Activation activate() {
            return session != null ? EngineSeams.Activation.granted() : new EngineSeams.Activation(false, "other", null);
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

        @NonNull
        @Override
        public ListenableFuture<MediaSession.MediaItemsWithStartPosition> onPlaybackResumption(@NonNull MediaSession s,
                @NonNull MediaSession.ControllerInfo controller, boolean isForPlayback) {
            return resumption(isForPlayback);
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
        EngineStore kept = store;
        RestoreRecord record = kept == null ? null : kept.restoreRecord();
        m.add(JsonNode.member("record", record == null ? JsonNode.NULL : JsonNode.str(record.mode().token)));
        m.add(JsonNode.member("recordOffsetSec", record == null ? JsonNode.NULL : JsonNode.num(record.offsetSec())));
        m.add(JsonNode.member("coldBoot", coldBoot == null ? JsonNode.NULL : JsonNode.str(coldBoot.token)));
        m.add(JsonNode.member("mediaButtonReceiver", JsonNode.bool(ForayMediaButtonReceiver.isEnabled(this))));
        // A-30: the process's lane, as the receiver reads it (never written here). The native-mode
        // scenarios gate on it, so a leg that silently ran in the JS lane cannot pass as native.
        m.add(JsonNode.member("nativeLane", JsonNode.bool(EngineOwnership.engineLane(this))));
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
            // A-61: the route the watcher tracks (port and class, never an address), the known set's size.
            RouteWatcher watcher = routes;
            m.add(JsonNode.member("route", watcher == null ? JsonNode.NULL : JsonNode.str(watcher.describe())));
            m.add(JsonNode.member("knownRoutes", JsonNode.num(st.knownRoutes.keys().size())));
            m.add(JsonNode.member("routePausedBy", JsonNode.str(st.routeResume.pausedBy().token)));
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
        DeckPair tape = pair;
        if (tape != null) {
            // A-40: which deck plays, how many handovers, and whether warming stood down.
            List<JsonNode.Member> pm = new ArrayList<>();
            pm.add(JsonNode.member("active", JsonNode.num(tape.activeIndex())));
            pm.add(JsonNode.member("swaps", JsonNode.num(tape.swaps())));
            pm.add(JsonNode.member("available", JsonNode.bool(tape.available())));
            m.add(JsonNode.member("pair", new JsonNode.Obj(pm)));
        }
        if (engine != null) {
            EngineState st = engine.state();
            m.add(JsonNode.member("forayId", st.forayId == null ? JsonNode.NULL : JsonNode.str(st.forayId)));
            m.add(JsonNode.member("inSeamGap", JsonNode.bool(st.inSeamGap())));
            m.add(JsonNode.member("skippedSegments", JsonNode.num(st.skippedSegments)));
            m.add(JsonNode.member("inInterlude", JsonNode.bool(st.inInterlude)));
        }
        // A-41: whether the engine's synthesiser answered (and which engine), and whether the jingle shipped.
        TtsOutput tts = speech;
        m.add(JsonNode.member("speaker", tts == null ? JsonNode.NULL : new JsonNode.Obj(tts.describe())));
        InterludePlayer interlude = jingle;
        List<JsonNode.Member> im = new ArrayList<>();
        im.add(JsonNode.member("available", JsonNode.bool(interlude != null)));
        im.add(JsonNode.member("sounding", JsonNode.bool(interlude != null && interlude.isSounding())));
        m.add(JsonNode.member("interlude", new JsonNode.Obj(im)));
        ExoPlayer p = exo;
        if (p != null) {
            m.add(JsonNode.member("exoPlayWhenReady", JsonNode.bool(p.getPlayWhenReady())));
            m.add(JsonNode.member("exoState", JsonNode.num(p.getPlaybackState())));
            m.add(JsonNode.member("exoSuppression", JsonNode.num(p.getPlaybackSuppressionReason())));
            m.add(JsonNode.member("exoPlaying", JsonNode.bool(p.isPlaying())));
        }
        m.add(JsonNode.member("isPlaybackOngoing", JsonNode.bool(isPlaybackOngoing())));
        // A-65: Media3's last foreground decision, as the watch heard it.
        m.add(JsonNode.member("foregroundRequired", JsonNode.bool(foreground.inForeground())));
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
