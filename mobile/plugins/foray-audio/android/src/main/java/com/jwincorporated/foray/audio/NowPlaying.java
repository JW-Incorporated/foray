package com.jwincorporated.foray.audio;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.getcapacitor.JSObject;

/**
 * Everything the lock screen should say, as one immutable value.
 *
 * <h2>This class holds no opinions</h2>
 *
 * Every field arrives from {@code mobile/plugins/foray-audio/web/foray-media-session.js},
 * which gets it from {@code player/media-session.js} — the module that decides what
 * the three strings say, that previous/next are segments, and which clock the
 * position is on. <b>Nothing here re-decides any of that</b>, because the Android app
 * and mobile Chrome must not disagree about what a Foray is.
 *
 * <p>So the only judgement in this file is defensive: what to do with a payload that
 * is missing a field or carries a value the web half should never have sent. The
 * answer is always <b>the honest empty value</b>, never a guess and never an
 * exception. A malformed payload must degrade to a blank line on a notification, not
 * to a crash mid-Foray — {@code ForayAudioPlugin}'s class comment is the general
 * form of that rule and this is one more instance of it.
 *
 * <h2>Immutable, because two threads read it</h2>
 *
 * It is written from the Capacitor bridge's worker pool and read by
 * {@link WebViewPlayer#getState()} on the main thread. A value object published
 * through {@link NowPlayingHub}'s {@code volatile} field needs no lock: a reader
 * either sees the whole old value or the whole new one, never half of each. A
 * mutable holder with per-field setters would have to be synchronised, and a
 * half-updated now-playing state is a lock screen showing one segment's title over
 * another's position.
 */
final class NowPlaying {

    /** No Foray is loaded. The player was closed, or nothing has played yet. */
    static final int IDLE = 0;
    /** Loaded and sounding — which per {@code media-session.js} §4 INCLUDES the 2.0 s
     *  authored seam beat, because a transport state that blinks 31 times an hour is
     *  how an app stops feeling native. */
    static final int PLAYING = 1;
    /** Loaded and not sounding. */
    static final int PAUSED = 2;
    /** The Foray finished. Distinct from {@link #PAUSED} because a play button that
     *  cannot do anything is worse than no button — {@code media-session.js} §4 again,
     *  which reports the web spec's {@code "none"} for exactly this case. */
    static final int ENDED = 3;

    static final NowPlaying EMPTY = new NowPlaying();

    final int state;
    @NonNull final String title;
    @NonNull final String artist;
    @NonNull final String album;
    /** A URI the NATIVE process can load, or {@code ""}. The web half has already
     *  translated address spaces — see {@code assetUri} there — because a bundled
     *  asset's URL inside the WebView names an origin served by Capacitor's local
     *  server and by nothing else in this process. */
    @NonNull final String artworkUri;
    /** The whole FORAY's duration in ms, or 0 for unknown. Not the segment's:
     *  {@code media-session.js} §3 is the argument, and the short version is that a
     *  car progress bar that fills and resets every 110 seconds reads as a broken
     *  app. */
    final long durationMs;
    final long positionMs;
    final float playbackRate;

    /* Which transport controls the PAGE installed handlers for. Media3 turns these
       into `Player` commands, and a command we do not declare is a button the OS
       greys out — which is the honest rendering of single-episode playback, where the
       queue is one item and `nexttrack` has nowhere to go. */
    final boolean canPlay;
    final boolean canPause;
    final boolean canStop;
    final boolean hasNext;
    final boolean hasPrevious;
    final boolean canSeekBack;
    final boolean canSeekForward;
    final boolean canSeekTo;
    final long seekBackMs;
    final long seekForwardMs;

    private NowPlaying() {
        this(IDLE, "", "", "", "", 0L, 0L, 1f,
            false, false, false, false, false, false, false, false, 0L, 0L);
    }

    private NowPlaying(
        int state, String title, String artist, String album, String artworkUri,
        long durationMs, long positionMs, float playbackRate,
        boolean canPlay, boolean canPause, boolean canStop,
        boolean hasNext, boolean hasPrevious,
        boolean canSeekBack, boolean canSeekForward, boolean canSeekTo,
        long seekBackMs, long seekForwardMs
    ) {
        this.state = state;
        this.title = title;
        this.artist = artist;
        this.album = album;
        this.artworkUri = artworkUri;
        this.durationMs = durationMs;
        this.positionMs = positionMs;
        this.playbackRate = playbackRate;
        this.canPlay = canPlay;
        this.canPause = canPause;
        this.canStop = canStop;
        this.hasNext = hasNext;
        this.hasPrevious = hasPrevious;
        this.canSeekBack = canSeekBack;
        this.canSeekForward = canSeekForward;
        this.canSeekTo = canSeekTo;
        this.seekBackMs = seekBackMs;
        this.seekForwardMs = seekForwardMs;
    }

    /** Is a Foray loaded at all? The one derived question worth a name, because both
     *  the player's state machine and the notification ask it. */
    boolean isLoaded() {
        return state != IDLE;
    }

    /**
     * Parse one {@code setNowPlaying} payload.
     *
     * <p>TOTAL, and that is the point: every branch has a defined answer for
     * {@code null}, for a missing key and for a wrong type. {@code JSObject}'s
     * getters already return null rather than throwing on a missing key, so the work
     * here is turning null into the honest empty value.
     *
     * <p>Three clamps, each for a thing that would otherwise reach Media3 and throw
     * from inside {@code SimpleBasePlayer.State}'s own {@code checkArgument}s — and a
     * throw there happens on the main thread inside a state read, which takes the app
     * down rather than the notification:
     * a negative duration or position, and a non-positive playback rate.
     */
    static NowPlaying from(@Nullable JSObject data) {
        if (data == null) return EMPTY;
        int state = stateOf(string(data, "state"));
        if (state == IDLE) {
            /* Nothing else is worth carrying: an idle state renders no metadata and
               declares no commands, so a title alongside it could only ever be a
               contradiction for something to read. */
            return EMPTY;
        }
        return new NowPlaying(
            state,
            string(data, "title"),
            string(data, "artist"),
            string(data, "album"),
            string(data, "artworkUri"),
            Math.max(0L, longOf(data, "durationMs")),
            Math.max(0L, longOf(data, "positionMs")),
            rateOf(data),
            bool(data, "canPlay"),
            bool(data, "canPause"),
            bool(data, "canStop"),
            bool(data, "hasNext"),
            bool(data, "hasPrevious"),
            bool(data, "canSeekBack"),
            bool(data, "canSeekForward"),
            bool(data, "canSeekTo"),
            Math.max(0L, longOf(data, "seekBackMs")),
            Math.max(0L, longOf(data, "seekForwardMs"))
        );
    }

    /** The web half's four state names. Anything else is {@link #IDLE} — the state
     *  that shows nothing, which is the right answer to a word we do not understand. */
    private static int stateOf(String name) {
        switch (name) {
            case "playing": return PLAYING;
            case "paused": return PAUSED;
            case "ended": return ENDED;
            default: return IDLE;
        }
    }

    private static float rateOf(JSObject data) {
        double rate = number(data, "playbackRate", 1d);
        /* Media3's `PlaybackParameters` rejects a non-positive speed, and the web spec
           makes a zero `playbackRate` a TypeError for the same reason. We never play
           backwards, so 1x is the only sane substitute. */
        if (!(rate > 0d) || Double.isNaN(rate) || Double.isInfinite(rate)) return 1f;
        return (float) rate;
    }

    @NonNull
    private static String string(JSObject data, String key) {
        Object value = data.opt(key);
        return value instanceof String ? (String) value : "";
    }

    /**
     * A number off the payload, coerced from whatever {@code org.json} decided to make
     * it.
     *
     * <p><b>READ THROUGH {@code opt} AND {@code Number} ON PURPOSE, AND THIS IS A TRAP
     * WORTH THE PARAGRAPH.</b> The obvious spelling is
     * {@code call.getLong("durationMs")} — and it returns <b>null for every value this
     * payload actually carries</b>. {@code PluginCall.getLong} is
     * {@code value instanceof Long ? (Long) value : defaultValue}, and
     * {@code org.json} parses {@code 3600000} into an <b>Integer</b>, so the cast never
     * matches. {@code getDouble} is broader (Double, Float, Integer) but still misses
     * Long, which is what {@code org.json} produces once a value passes
     * {@code Integer.MAX_VALUE}.
     *
     * <p>Neither failure would be visible from here: a null duration becomes 0, a 0
     * duration becomes {@code C.TIME_UNSET}, and the result is a lock screen with no
     * scrubber and no error anywhere. {@code Number} covers every box
     * {@code org.json} can hand us, including the Long case, and is the one spelling
     * that cannot silently answer zero.
     */
    private static double number(JSObject data, String key, double fallback) {
        Object value = data.opt(key);
        return value instanceof Number ? ((Number) value).doubleValue() : fallback;
    }

    private static long longOf(JSObject data, String key) {
        return (long) number(data, key, 0d);
    }

    private static boolean bool(JSObject data, String key) {
        Object value = data.opt(key);
        return value instanceof Boolean && (Boolean) value;
    }
}
