package dev.jwlabs.foura.audio;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaStyleNotificationHelper;

/**
 * A `mediaPlayback` foreground service that holds the app's process importance up
 * while the WebView plays audio, and — since #27 — carries the Media3
 * {@link MediaSession} that puts a Foray on the lock screen.
 *
 * <h2>Why this exists at all</h2>
 *
 * The audio is a plain {@code <audio>} element inside Capacitor's WebView. Nothing
 * in this class touches it, decodes anything, or knows what is playing beyond what
 * the page reports. What it buys, from {@code docs/research/mp1-background-audio.md}
 * §5.3, is two things at a layer above Blink that no amount of JavaScript can reach:
 *
 * <ol>
 *   <li><b>Audio focus on Android 15+.</b> "If an app targets Android 15 (API level
 *       35) or higher, it cannot request audio focus unless it's the top app or
 *       running a foreground service." Capacitor 8.5.0 generates
 *       {@code targetSdkVersion = 36}, so the shell is inside that rule from its
 *       first build.</li>
 *   <li><b>Not being frozen.</b> The documented process-importance ladder is
 *       foreground → visible → service → cached, and a cached process is moved into
 *       a frozen cgroup where "all of its threads are suspended".
 *       {@code startForeground()} confers <i>visible</i>. Playing audio appears
 *       nowhere on that ladder.</li>
 * </ol>
 *
 * <p>MP1 is careful to call the second one an <b>inference</b> from two documented
 * facts rather than a sentence AOSP states, and this class does not upgrade it.
 * Nothing here has been observed on a device or an emulator — see
 * {@code docs/android-native-code.md} for exactly what is measured.
 *
 * <h2>And a third reason, which is #27's</h2>
 *
 * {@code navigator.mediaSession} is switched off in Android WebView at the engine
 * level (MP1 §5.4), so <b>a foreground service is the only vehicle on Android for
 * lock-screen and steering-wheel controls</b>. That is why the FGS and #27's Android
 * half were always one job. The session lives here, next to the notification it needs
 * to be paired with, and the notification this class used to post — "Playback
 * active", a platform icon, no title — is now built from what the page reports.
 *
 * <h2>THE LIFETIME CHANGED WITH #27, AND IT IS THE ONE THING TO UNDERSTAND</h2>
 *
 * #244 stopped this service 25 s after the last element went silent. That is correct
 * for a keep-alive and <b>wrong for a session</b>: the controls live in the
 * notification, so pausing from the lock screen and waiting 25 s took away the
 * buttons you paused with, leaving no way to resume without unlocking the phone.
 *
 * <p>So the service now lives for as long as <b>a Foray is loaded</b>, not as long as
 * <b>audio is sounding</b>. The decision is still the web half's — this class has no
 * idea what "loaded" means — and it is made in {@code foray-audio-shell.js}'s
 * {@code setMediaLoaded}, from a signal only the page has: {@code client.js} nulls the
 * media session's metadata in {@code stopAndClose} and nowhere else.
 *
 * <p>That is <b>fewer</b> starts and stops than #244 made, not more, and every
 * {@code startForegroundService} avoided is one Android 12+ cannot refuse. What it
 * costs is an ongoing notification that can outlive interest, which is why the
 * notification carries a stop button: it is the listener's one-press exit, and it
 * routes to the page's {@code stopAndClose}, which clears the metadata, which stops
 * this service.
 *
 * <h2>What it is still NOT for</h2>
 *
 * It is <b>not</b> a fix for the seam. Hidden-page throttling in Blink is on the
 * media-load <i>task chain</i> and is keyed to <b>visibility</b>, not audibility
 * (MP1 §4.1a): a hidden load of a small local bundled file still measured 9-11 s. A
 * foreground service does not make the page visible and so does not shorten that.
 *
 * <p>It also does <b>not request audio focus</b>, and that is deliberate rather than
 * unfinished. Whether WebView requests focus for a plain {@code <audio>} element is
 * unestablished (MP1 §5.2, open in both directions). If it does, a second requester
 * in the same process fighting it is worse than either alone; if it does not, adding
 * one here would make this class the owner of ducking and interruption behaviour for
 * audio it cannot pause. Only a device settles which branch we are in, and until then
 * the honest position is the one MP1 left.
 *
 * <h2>START_NOT_STICKY</h2>
 *
 * If Android kills this service under memory pressure, restarting it would put a
 * foreground service and its notification back up with no page and no audio behind
 * it. The web layer re-asks on the next {@code play()}, which is the only signal
 * that means anything.
 */
@OptIn(markerClass = UnstableApi.class)
public class PlaybackKeepAliveService extends Service {

    private static final String TAG = "ForayAudio";

    /** Low-importance so the notification is silent and does not push into view. */
    static final String CHANNEL_ID = "foray-playback";

    /** Any non-zero id. Zero is rejected by {@code startForeground}. */
    static final int NOTIFICATION_ID = 1837;

    /** The one {@code Intent} action this service answers besides a bare start. Its
     *  {@link #EXTRA_TRANSPORT} names an action from {@code ROUTABLE_ACTIONS} in
     *  {@code foray-media-session.js}. */
    static final String ACTION_TRANSPORT = "dev.jwlabs.foura.audio.TRANSPORT";
    static final String EXTRA_TRANSPORT = "action";

    /** Media3 requires a session id unique within the process. There is exactly one
     *  of these services, so a constant is right — and a constant is also what makes
     *  a leaked session from a previous instance fail loudly at construction rather
     *  than quietly becoming a second session on the lock screen. */
    private static final String SESSION_ID = "foray";

    /**
     * Read by {@link ForayAudioPlugin} so a JS caller can be told what actually
     * happened rather than what was requested.
     *
     * <p>{@code volatile} because it is written on the main thread and read from
     * the bridge's thread pool. It is deliberately a plain flag and not a count:
     * this service is a singleton per process, and "how many times was start
     * called" is not a question worth being able to answer wrongly.
     */
    private static volatile boolean running = false;

    /**
     * The service instance that currently owns a live {@link MediaSession}, or null.
     *
     * <p>Reported by the plugin's {@code state()} so a device pass can tell "no controls
     * because there is no session" apart from "no controls because the notification is
     * suppressed".
     *
     * <p><b>AN IDENTITY RATHER THAN A BOOLEAN, and a review pass is why.</b> A stop and a
     * start can overlap — the new instance's {@code onCreate} can run before the old
     * one's {@code onDestroy} — and with a plain flag the OLD instance's
     * {@code releaseSession()} sets it false while the NEW session is live. So
     * {@code state()} would report no session during exactly the restart a device pass
     * would be trying to diagnose, on the field the documentation tells it to trust.
     * {@link NowPlayingHub} identity-checks {@code listener} and {@code sink} for this
     * same overlap; this is the third of the three.
     */
    @Nullable private static volatile PlaybackKeepAliveService sessionOwner = null;

    /** What the notification last SAID, so an unchanged one is not re-posted. Null
     *  until the first post. */
    @Nullable private String lastNotificationKey;

    @Nullable private MediaSession session;
    @Nullable private WebViewPlayer player;
    @Nullable private NowPlayingHub.Listener listener;

    static boolean isRunning() {
        return running;
    }

    static boolean isSessionActive() {
        return sessionOwner != null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        ensureChannel(this);
        startSession();
    }

    /**
     * Build the player and the session.
     *
     * <p>Wrapped, because a failure here must cost the lock screen and not the
     * background audio. Everything #244 built — the process importance, the audio-focus
     * exemption — works with no session at all, and the two are independent by
     * construction: {@code onStartCommand} calls {@code startForeground} whether or not
     * {@code session} is null, and {@link #buildNotification} degrades to the
     * placeholder text.
     */
    private void startSession() {
        try {
            WebViewPlayer built = new WebViewPlayer(Looper.getMainLooper(), new WebViewPlayer.Bridge() {
                @NonNull
                @Override
                public NowPlaying nowPlaying() {
                    return NowPlayingHub.get();
                }

                @Override
                public void onTransport(@NonNull String action, long positionMs, long offsetMs) {
                    NowPlayingHub.dispatch(action, positionMs, offsetMs);
                }
            });
            MediaSession.Builder builder = new MediaSession.Builder(this, built).setId(SESSION_ID);
            PendingIntent launch = launchIntent();
            /* Only when we have one: `setSessionActivity(null)` is not allowed, and the
               package manager can genuinely fail to resolve a launch intent for our own
               package in a stripped or instrumented install. */
            if (launch != null) builder.setSessionActivity(launch);
            player = built;
            session = builder.build();
            sessionOwner = this;
            listener = nowPlaying -> onNowPlayingChanged();
            NowPlayingHub.setListener(listener);
        } catch (Exception e) {
            Log.w(TAG, "could not create the MediaSession; continuing without lock-screen controls", e);
            releaseSession();
        }
    }

    private void releaseSession() {
        NowPlayingHub.clearListener(listener);
        listener = null;
        /* ONLY IF WE ARE STILL THE OWNER. See the field's comment: a newer instance may
           already have taken it, and claiming otherwise would make `state()` lie. */
        if (sessionOwner == this) sessionOwner = null;
        try {
            if (session != null) session.release();
        } catch (Exception e) {
            Log.w(TAG, "releasing the MediaSession failed", e);
        }
        session = null;
        try {
            /* AFTER the session, and the order is not arbitrary: the session holds the
               player and calls into it, so releasing the player first would leave the
               session talking to a released player for the length of one teardown. */
            if (player != null) player.release();
        } catch (Exception e) {
            Log.w(TAG, "releasing the player failed", e);
        }
        player = null;
    }

    /**
     * The page reported something new: re-read the state and repaint.
     *
     * <p>{@code refresh()} first, because the notification is built from the same
     * {@link NowPlayingHub} value and the session should not be a frame behind the
     * shade — a controller that reads the session while the notification says
     * something else is the "two opinions" failure in miniature.
     */
    private void onNowPlayingChanged() {
        if (player != null) player.refresh();
        if (!running) return;
        NowPlaying np = NowPlayingHub.get();
        /* THE PLAYER IS REFRESHED EVERY TIME AND THE NOTIFICATION IS NOT, and a review
           pass is why. The page reports the playhead about once a second — the web half
           spends real effort getting it down from four (`foray-media-session.js`
           decision 1) — and Media3 genuinely needs those, because it extrapolates the
           position from the last one. The NOTIFICATION does not: nothing on it depends on
           the playhead (no `setProgress`, no chronometer), so re-posting it at 1 Hz is
           ~3,600 byte-identical notifications an hour, each one rebuilding six
           `PendingIntent`s — and `player/media-session.js`'s own header warns that
           writing at rate "on Android … redraws the notification and visibly flickers".
           So the bridge rate was argued down and then spent here.

           `visibleKey` is the same idea as the web half's `identityKey`, one layer
           further in: everything a listener can SEE, and nothing else. */
        String key = visibleKey(np);
        if (key.equals(lastNotificationKey)) return;
        lastNotificationKey = key;
        try {
            NotificationManagerCompat.from(this).notify(NOTIFICATION_ID, buildNotification());
        } catch (Exception e) {
            /* `notify` is a no-op when notifications are disabled rather than a throw,
               so this catches the rarer thing: a builder that could not resolve a
               resource. Either way, a repaint that fails must not stop the service. */
            Log.w(TAG, "could not update the playback notification", e);
        }
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        /* HANDLED BEFORE `startForeground`, and it has to be: a transport press arrives
           as a start of an ALREADY-foreground service, and delivering the press first
           means the page has begun acting on it before we spend a frame rebuilding a
           notification we are about to rebuild again when the page answers. */
        if (intent != null && ACTION_TRANSPORT.equals(intent.getAction())) {
            String action = intent.getStringExtra(EXTRA_TRANSPORT);
            if (action != null && !action.isEmpty()) NowPlayingHub.dispatch(action, 0L, 0L);
        }
        try {
            /* SEEDED HERE, because `startForeground` posts the notification too. Without
               this the first `onNowPlayingChanged` after a start would compare against a
               null key, decide the display had changed, and post an identical
               notification — harmless, but it would make the gate above look like it was
               working when it was one post behind. */
            lastNotificationKey = visibleKey(NowPlayingHub.get());
            ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), foregroundServiceType());
            running = true;
        } catch (Exception e) {
            /* Broad on purpose, and the reason is the whole point of this catch.
               From Android 14, startForeground throws
               InvalidForegroundServiceTypeException / MissingForegroundServiceTypeException
               when the manifest and the type argument disagree, and from Android 12
               ForegroundServiceStartNotAllowedException when the app was not allowed
               to start one. All of those are unchecked, all of them would otherwise
               kill the app MID-FORAY, and none of them is worth a crash: an app that
               plays audio without the service is degraded, an app that has died is
               not playing anything. The flag stays false so the JS side sees the
               truth, and stopSelf() means we do not sit as a started-but-not-
               foreground service. */
            Log.w(TAG, "startForeground failed; continuing without a foreground service", e);
            running = false;
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        releaseSession();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        /* Nothing binds to this. The plugin starts and stops it with intents, which
           keeps its lifetime independent of the Activity's — and a Media3
           `MediaSession` needs no binding either, because it is not a
           `MediaSessionService`. Becoming one was considered and declined: Media3 would
           then own when the service is foreground, keyed to `player.isPlaying`, and
           that is precisely the lifetime #244 argued out against a 20 s floor and a
           30 s ceiling and this change extends. Handing it to a library we cannot run
           here would replace a reviewed mechanism with an unverifiable one. */
        return null;
    }

    /* ------------------------------------------------------------ notification */

    private int foregroundServiceType() {
        /* The typed overload exists from API 29. Below that a foreground service has
           no type and passing 0 is the documented "no type" value; the
           `mediaPlayback` requirement itself only starts at API 34. minSdk is 24. */
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            : 0;
    }

    /**
     * Create the notification channel. Idempotent — {@code createNotificationChannel}
     * on an existing id updates it rather than failing, which matters because
     * {@code onCreate} runs again after every stop.
     */
    static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.foray_playback_channel_name),
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription(context.getString(R.string.foray_playback_channel_description));
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    /**
     * The notification, which on a modern Android IS the lock-screen media control.
     *
     * <h3>Why this is hand-built rather than {@code DefaultMediaNotificationProvider}</h3>
     *
     * Media3 ships one, and it is written for {@code MediaSessionService} — it is
     * driven by that service's own foreground lifecycle through a
     * {@code MediaNotification.ActionFactory} only {@code MediaNotificationManager}
     * implements. We keep #244's lifecycle (see the class comment), so we keep the
     * notification, and it is ~40 lines of explicit actions rather than an adapter
     * around a provider built for a service we deliberately are not.
     *
     * <h3>What is on it, and why</h3>
     *
     * The three strings the page reported, in the three places Android renders:
     * {@code contentTitle} (the episode), {@code contentText} (the show), and
     * {@code subText} (the Foray plus "part N of M"). Then previous, play/pause, next
     * and stop — declared only when the page installed the matching handler, so a
     * single episode gets no dead skip buttons.
     *
     * <p><b>No artwork bitmap, and that is a decision.</b> The lock screen falls back
     * to the app's icon, and the data says that is nearly always what artwork would
     * have shown anyway: {@code player/media-session.js} §5 records that joining our
     * shows against {@code data/discover.json} covers <b>1 of the 12 shows</b> the two
     * shipped Forays draw on, so eleven times in twelve the "artwork" IS the app icon.
     * Buying the twelfth means a native HTTP fetch, a bitmap decode, a cache and a
     * re-post — with no device to verify any of it on. The session's metadata still
     * carries {@code artworkUri} (see {@code WebViewPlayer}), so a surface that loads
     * art from the session itself gets the publisher's square for free; what is
     * declined is loading it ourselves for the shade.
     */
    private Notification buildNotification() {
        NowPlaying np = NowPlayingHub.get();
        NotificationCompat.Builder notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            /* A PLATFORM drawable, so this plugin ships no res/drawable and cannot
               collide with the app's icons. It is the status-bar glyph only; the large
               icon a media notification shows is the app's own. */
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(np.title.isEmpty()
                ? getString(R.string.foray_playback_notification_title)
                : np.title)
            .setContentText(np.artist.isEmpty()
                ? getString(R.string.foray_playback_notification_text)
                : np.artist)
            .setContentIntent(launchIntent())
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            /* PUBLIC, and it is load-bearing rather than cosmetic: with the default
               PRIVATE and a lock screen set to hide sensitive content, the whole point
               of this notification — the title and the buttons, on a locked phone — is
               replaced by "Contents hidden". A podcast title is not a secret, and the
               one surface #27 is about is the one this controls. */
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setSilent(true)
            /* ONGOING ONLY WHILE SOUNDING — AND ON MOST ANDROID VERSIONS THAT BUYS
               NOTHING, which a review pass caught being stated as if it were a mechanism.
               The platform ORs FLAG_FOREGROUND_SERVICE / FLAG_NO_CLEAR onto a foreground
               service's notification, and user dismissal of one arrived in Android 14
               (API 34). minSdk here is 24, so on API 24-33 this notification cannot be
               swiped away at all and `setDeleteIntent` below can never fire.

               It is kept because it is correct from 14 on, and because it costs nothing.
               What a listener on API 24-33 actually has is the STOP BUTTON — which is why
               that button is not gated on `acceptsTransport()` — plus the service
               stopping on its own once nothing is playing. The doc says this plainly now
               rather than promising a swipe. */
            .setOngoing(np.state == NowPlaying.PLAYING)
            .setShowWhen(false)
            /* Swiping the notification away IS a stop, routed through the page exactly
               as the button is — WHERE SWIPING IS POSSIBLE AT ALL, which per the comment
               above is Android 14 and later. Set unconditionally because it is inert
               rather than wrong below that. */
            .setDeleteIntent(transportIntent("stop", 5))
            /* Without this the system may hold the notification back for ~10 s.
               A user who backgrounds the app should be able to see immediately why
               it is still running. */
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE);

        if (!np.album.isEmpty()) notification.setSubText(np.album);

        /* Compact-view indices are COLLECTED as the actions are added rather than
           written as literals. With previous and next each conditional, a hardcoded
           `0, 1, 2` puts the wrong three buttons in the collapsed notification for
           single-episode playback — and the collapsed view is the one on the lock
           screen. */
        int index = 0;
        int prevIndex = -1;
        int playIndex = -1;
        int nextIndex = -1;
        /* `acceptsTransport()`, NOT `isLoaded()`, and it is the same rule
           `WebViewPlayer`'s command set uses — deliberately read from the same method so
           the media panel and the shade cannot offer different things. A FINISHED Foray
           keeps its title and loses its buttons, which is exactly what
           `player/media-session.js` §4's `"none"` does in a browser. */
        boolean transport = np.acceptsTransport();
        if (transport && np.hasPrevious) {
            notification.addAction(
                android.R.drawable.ic_media_previous,
                getString(R.string.foray_action_previous),
                transportIntent("previoustrack", 1)
            );
            prevIndex = index++;
        }
        if (transport && (np.canPlay || np.canPause)) {
            boolean playing = np.state == NowPlaying.PLAYING;
            notification.addAction(
                playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                getString(playing ? R.string.foray_action_pause : R.string.foray_action_play),
                transportIntent(playing ? "pause" : "play", 2)
            );
            playIndex = index++;
        }
        if (transport && np.hasNext) {
            notification.addAction(
                android.R.drawable.ic_media_next,
                getString(R.string.foray_action_next),
                transportIntent("nexttrack", 3)
            );
            nextIndex = index++;
        }
        /* STOP IS NOT GATED ON `transport`, and that gap was a BLOCKING review finding.
           `acceptsTransport()` is false for a FINISHED Foray — correctly, because a play
           button that does nothing is worse than none — and the first version gated every
           action on it, INCLUDING STOP. Every session ends in that state, so every session
           ended with an ongoing notification carrying no buttons at all and no way out but
           unlocking the phone and closing the player. §5.1's whole trade rests on stop
           being "the one-press exit", so it has to exist in every state that can show a
           notification. The web half now also reports a finished Foray as not-loaded, so
           the service stops on its own — two independent fixes, because this one is the
           one a listener can act on. */
        if (np.isLoaded() && np.canStop) {
            notification.addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                getString(R.string.foray_action_stop),
                transportIntent("stop", 4)
            );
            index++;
        }

        MediaSession live = session;
        if (live != null) {
            /* THE PAIRING IS THE MECHANISM. `MediaStyle` stamps the platform session's
               token onto the notification, which is how the system knows this
               notification and that session are one media item — and it is what promotes
               it into the media control panel on the lock screen and in quick settings
               instead of leaving it an ordinary ongoing notification. Without the
               session there is still a notification with working buttons; there is just
               no media panel. */
            /* NO `setShowCancelButton`/`setCancelButtonIntent`. They were in the first
               draft of this method and the compiler's deprecation note is what sent me to
               read them: both are documented in Media3 as *"a no-op and usages can be
               safely removed… previously only operational on API < 21"*, and minSdk here
               is 24. They would have read as the dismissal mechanism and been nothing.
               The real one is `setDeleteIntent` above plus `setOngoing` tracking whether
               audio is actually sounding. */
            MediaStyleNotificationHelper.MediaStyle style =
                new MediaStyleNotificationHelper.MediaStyle(live);
            int[] compact = compactActions(prevIndex, playIndex, nextIndex);
            if (compact.length > 0) style.setShowActionsInCompactView(compact);
            notification.setStyle(style);
        }
        return notification.build();
    }

    /** Previous, play/pause and next, in that order, skipping the ones that are not
     *  there. Stop is deliberately not in the compact view: it is the cancel button and
     *  the swipe, and a stop next to a play on a lock screen is a mis-tap away from
     *  ending the Foray. */
    /**
     * Everything on the notification a listener can SEE, as one string.
     *
     * <p>Deliberately excludes the playhead — see {@link #onNowPlayingChanged}. Includes
     * the capability flags as well as the text, because they decide which BUTTONS are
     * drawn, and a Foray moving from playing to paused has to repaint even though every
     * string is identical.
     */
    private static String visibleKey(@NonNull NowPlaying np) {
        return np.state + "|" + np.title + "|" + np.artist + "|" + np.album
            + "|" + np.hasPrevious + np.hasNext + np.canPlay + np.canPause + np.canStop
            + "|" + np.acceptsTransport();
    }

    private static int[] compactActions(int prevIndex, int playIndex, int nextIndex) {
        int count = 0;
        if (prevIndex >= 0) count++;
        if (playIndex >= 0) count++;
        if (nextIndex >= 0) count++;
        int[] out = new int[count];
        int at = 0;
        if (prevIndex >= 0) out[at++] = prevIndex;
        if (playIndex >= 0) out[at++] = playIndex;
        if (nextIndex >= 0) out[at++] = nextIndex;
        return out;
    }

    /**
     * A press on a notification button -> this service -> the page.
     *
     * <p><b>A DISTINCT REQUEST CODE PER ACTION, and it is not decoration.</b>
     * {@code PendingIntent} equality ignores extras — two {@code PendingIntent}s
     * differing only in an extra with the same request code are the SAME
     * {@code PendingIntent}, and {@code FLAG_UPDATE_CURRENT} then rewrites the first
     * one's extras. Share a code across these and every button on the notification
     * performs whichever action was built last.
     */
    @Nullable
    private PendingIntent transportIntent(@NonNull String action, int requestCode) {
        Intent intent = new Intent(this, PlaybackKeepAliveService.class)
            .setAction(ACTION_TRANSPORT)
            .putExtra(EXTRA_TRANSPORT, action);
        try {
            return PendingIntent.getService(
                this,
                requestCode,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
        } catch (Exception e) {
            Log.w(TAG, "could not build a transport intent for " + action, e);
            return null;
        }
    }

    /**
     * Tapping the notification reopens the app. Resolved through the package
     * manager rather than by naming {@code MainActivity}: the activity belongs to
     * the GENERATED project, and this plugin must not hold a compile-time reference
     * into a tree that `cap add android` rewrites.
     */
    @Nullable
    private PendingIntent launchIntent() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch == null) return null;
        launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
            this,
            0,
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }
}
