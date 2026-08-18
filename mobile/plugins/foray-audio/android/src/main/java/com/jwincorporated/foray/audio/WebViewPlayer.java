package com.jwincorporated.foray.audio;

import android.net.Uri;
import android.os.Looper;

import androidx.annotation.NonNull;
import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.common.SimpleBasePlayer;
import androidx.media3.common.util.UnstableApi;

import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;

import java.util.ArrayList;
import java.util.List;

/**
 * A Media3 {@link Player} that plays nothing.
 *
 * <h2>What this is, in one sentence</h2>
 *
 * The audio is an {@code <audio>} element inside Capacitor's WebView and the page's
 * own state machine owns it. This class is the <b>adapter</b> that lets a Media3
 * {@code MediaSession} — and therefore the lock screen, the notification, a
 * Bluetooth button and a car head unit — read that state and ask it for things. It
 * decodes nothing, holds no audio, and has no opinion it did not receive from
 * {@link NowPlayingHub}.
 *
 * <h2>Why {@code SimpleBasePlayer}</h2>
 *
 * {@code Player} is ~90 methods. {@code SimpleBasePlayer} is the class Media3
 * documents for exactly this case — "a player that only supports a subset of
 * commands" — and reduces the whole contract to one {@link #getState()} plus a
 * {@code handleXxx} per command we declare. It also gives us two things that would
 * otherwise be ours to get wrong: a <b>placeholder state</b> so a controller sees a
 * press take effect before the page has answered, and <b>position extrapolation</b>
 * from the last report and the rate, which is what lets the page write the playhead
 * once a second instead of four times.
 *
 * <p>The rejected alternative was a hand-rolled platform {@code MediaSession} +
 * {@code PlaybackStateCompat}. It is less code today and it means owning the
 * translation to every Android version's media surface forever, which is the work
 * Media3 exists to have already done.
 *
 * <h2>THE TIMELINE IS THREE WINDOWS AND THAT IS DELIBERATE — read this before
 * changing it</h2>
 *
 * Media3 answers "is there a next track?" from the <b>timeline</b>, not from a
 * capability flag: {@code BasePlayer.seekToNext()} checks {@code hasNextMediaItem()}
 * and does nothing when the playlist has one item. So a single-window timeline —
 * the obvious modelling of "one Foray" — makes {@code KEYCODE_MEDIA_NEXT} from a
 * steering wheel a no-op, which is the one control #27 exists for.
 *
 * <p>But the timeline cannot be the real running order either. The page has 22-32
 * segments; this process is told about <b>one</b>, because
 * {@code player/media-session.js} publishes the current item's metadata and nothing
 * else, and reaching into {@code player/} for a queue listing is not this change's
 * to do.
 *
 * <p>So the timeline is a <b>neighbourhood</b>: one window for "something before",
 * one for now, one for "something after", present only when the page installed the
 * matching handler. It says exactly what we know — there is a previous and a next,
 * ask the page what they are — and it holds no second opinion about the running
 * order, which is the invariant this whole change is built on.
 *
 * <p><b>Every window carries the same metadata and the same duration</b>, and that is
 * not laziness. Media3 shows a placeholder state between a press and our answer; with
 * empty neighbours, pressing next at a cross-episode seam would blank the
 * notification's title for the 5-11 s the load takes (MP1 §4.4). Repeating the
 * current metadata means the display holds still until the truth arrives — which is
 * also what is actually true during a seam, since the outgoing segment is what was
 * last sounding.
 *
 * <p>The cost, named: a controller that renders queue position shows "2 of 3". No
 * Android media surface does, and the alternative was a dead next button.
 *
 * <h2>The clock is the FORAY's</h2>
 *
 * {@code durationMs} and {@code positionMs} span the whole Foray, not the current
 * segment. That is {@code player/media-session.js} §3's decision and its three
 * reasons carry over verbatim, the sharpest being that a {@code seekto} from a head
 * unit arrives <b>in the timeline we reported</b>: report the segment and a car scrub
 * can only ever move inside 110 seconds.
 *
 * <h2>Nothing here has been executed</h2>
 *
 * No device, no emulator. See {@code docs/android-native-code.md} § what is measured.
 */
@OptIn(markerClass = UnstableApi.class)
final class WebViewPlayer extends SimpleBasePlayer {

    /** Where the state comes from and where presses go. An interface rather than a
     *  direct {@link NowPlayingHub} reference so this class has no static state to
     *  reason about, and so the seam is nameable in review. */
    interface Bridge {
        @NonNull
        NowPlaying nowPlaying();

        void onTransport(@NonNull String action, long positionMs, long offsetMs);
    }

    private final Bridge bridge;

    WebViewPlayer(@NonNull Looper looper, @NonNull Bridge bridge) {
        super(looper);
        this.bridge = bridge;
    }

    /** Called by the service whenever the page reports something new. Media3 then
     *  re-reads {@link #getState()} and diffs it for its listeners. */
    void refresh() {
        invalidateState();
    }

    @NonNull
    @Override
    protected State getState() {
        NowPlaying np = bridge.nowPlaying();
        State.Builder state = new State.Builder()
            .setAvailableCommands(commandsFor(np))
            .setSeekBackIncrementMs(np.seekBackMs)
            .setSeekForwardIncrementMs(np.seekForwardMs)
            /* ZERO, and this is a decision rather than a default. Media3's
               `seekToPrevious()` restarts the current item instead of going back when
               the playhead is past this threshold — a sensible default and NOT ours to
               hold. `player/media-session.js` §2 is explicit that previous must inherit
               `forayPrevious`'s own restart-vs-previous window rather than a second
               opinion about it, and zero is how you say "never decide this here". */
            .setMaxSeekToPreviousPositionMs(0L)
            .setPlaybackParameters(new PlaybackParameters(np.playbackRate));

        if (!np.isLoaded()) {
            /* An empty timeline is legal only in IDLE or ENDED (`State`'s own
               checkArgument), and IDLE is right: nothing is loaded, so there is nothing
               for a controller to render and no command to run. */
            return state
                .setPlaylist(ImmutableList.of())
                .setPlaybackState(Player.STATE_IDLE)
                .setPlayWhenReady(false, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
                .build();
        }

        int before = np.hasPrevious ? 1 : 0;
        int after = np.hasNext ? 1 : 0;
        state
            .setPlaylist(neighbourhood(np, before + 1 + after))
            .setCurrentMediaItemIndex(before)
            /* A `long`, not a `PositionSupplier`, and that is the cheap win: `State`'s
               constructor upgrades a long to `PositionSupplier.getExtrapolating(pos,
               speed)` by itself when the state is READY and playWhenReady — so the
               playhead advances between our reports at exactly the rate we declared,
               and the page can write it once a second. Building the supplier by hand
               would be the same behaviour with one more thing to get wrong. */
            .setContentPositionMs(np.positionMs);

        if (np.state == NowPlaying.ENDED) {
            return state
                .setPlaybackState(Player.STATE_ENDED)
                .setPlayWhenReady(false, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
                .build();
        }
        return state
            /* READY for both playing and paused. There is no BUFFERING state reported,
               deliberately: the page's own "loading" is a seam, and `media-session.js`
               §4 argues at length that a seam must read as PLAYING because a transport
               state that blinks 31 times an hour is how an app stops feeling native. A
               BUFFERING spinner on a car display is the same defect wearing a different
               icon. */
            .setPlaybackState(Player.STATE_READY)
            .setPlayWhenReady(
                np.state == NowPlaying.PLAYING,
                Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST
            )
            .build();
    }

    /**
     * The commands we declare — which is exactly the set of action handlers the PAGE
     * installed, mapped over.
     *
     * <p>That mapping is the whole reason single-episode playback renders honestly:
     * {@code client.js}'s {@code episodeMediaSurface} has no {@code next}/{@code
     * previous} (the queue is one item, product principle 1 — no autoplay chains), so
     * {@code mediaSessionActions} installs no {@code nexttrack}, so nothing here
     * declares {@code COMMAND_SEEK_TO_NEXT}, so the OS greys the button out. A
     * command declared on a hope is a button that does nothing.
     *
     * <p>What is DECLINED, and each for a reason:
     * <ul>
     *   <li>{@code COMMAND_SET_SHUFFLE_MODE} — a Foray is an authored running order.
     *       Shuffling it is a category error, not a missing feature.</li>
     *   <li>{@code COMMAND_SET_REPEAT_MODE} — nothing repeats a 51-minute Foray, and
     *       a repeat toggle the page cannot honour would render as ON or OFF, either
     *       of which is a claim.</li>
     *   <li>{@code COMMAND_SET_SPEED_AND_PITCH} — the rate is a durable preference
     *       (#242) the page owns and re-applies at every seam. We REPORT it, because
     *       Media3 extrapolates the playhead with it, and do not accept changes to
     *       it.</li>
     *   <li>{@code COMMAND_SEEK_TO_MEDIA_ITEM} — an arbitrary jump into the running
     *       order. The Foray page does that with 32 real titles in front of the
     *       listener; a lock screen offering it against a 3-window fiction would jump
     *       somewhere neither of us meant.</li>
     *   <li>{@code COMMAND_SET_VOLUME} and the device-volume family — the element's
     *       volume is not a transport control, and the media stream's volume is the
     *       OS's own slider, which appears whether we claim it or not.</li>
     *   <li>{@code COMMAND_PREPARE} — there is nothing to prepare; the page loads its
     *       own audio.</li>
     * </ul>
     */
    @NonNull
    private static Player.Commands commandsFor(@NonNull NowPlaying np) {
        Player.Commands.Builder commands = new Player.Commands.Builder()
            /* Read-only commands, always. Without them a controller may not ask what is
               playing, which is the entire content of a lock screen. */
            .add(Player.COMMAND_GET_CURRENT_MEDIA_ITEM)
            .add(Player.COMMAND_GET_TIMELINE)
            .add(Player.COMMAND_GET_METADATA)
            /* Declared so `release()` is not silently a no-op: `SimpleBasePlayer.release`
               returns early on any command it was not given, so the service's own
               teardown would do nothing without this. `handleRelease` has nothing to
               release, which is why a controller reaching it is harmless. */
            .add(Player.COMMAND_RELEASE);
        if (!np.isLoaded()) return commands.build();

        /* ONE COMMAND FOR BOTH, because Media3 has one: `COMMAND_PLAY_PAUSE` governs
           `play()` and `pause()` together. The page installs both handlers or neither,
           so `||` is not papering over a case that happens — it is refusing to declare
           a play/pause button when the page offered no way to do either. */
        if (np.canPlay || np.canPause) commands.add(Player.COMMAND_PLAY_PAUSE);
        if (np.canStop) commands.add(Player.COMMAND_STOP);
        if (np.hasNext) {
            /* BOTH spellings. `KEYCODE_MEDIA_NEXT` reaches `seekToNext()`
               (`COMMAND_SEEK_TO_NEXT`) while a notification button and a Media3
               controller use `seekToNextMediaItem()`. Declaring one and not the other
               is how a control works from a car and not from the shade. */
            commands.add(Player.COMMAND_SEEK_TO_NEXT);
            commands.add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM);
        }
        if (np.hasPrevious) {
            commands.add(Player.COMMAND_SEEK_TO_PREVIOUS);
            commands.add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM);
        }
        if (np.canSeekTo) commands.add(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM);
        if (np.canSeekBack) commands.add(Player.COMMAND_SEEK_BACK);
        if (np.canSeekForward) commands.add(Player.COMMAND_SEEK_FORWARD);
        return commands.build();
    }

    /** {@code count} identical windows. See the class comment for why they are
     *  identical and why there are three of them. */
    @NonNull
    private static ImmutableList<MediaItemData> neighbourhood(@NonNull NowPlaying np, int count) {
        MediaMetadata metadata = metadataFor(np);
        MediaItem item = new MediaItem.Builder()
            /* A stable id and no URI. `MediaItem` is what a controller inspects to
               identify the track; there is deliberately no `setUri`, because a URI here
               would be a claim that this process can play something, and a
               `MediaController` that acted on it would start a second player over the
               top of the WebView's audio. */
            .setMediaId("foray-current")
            .setMediaMetadata(metadata)
            .build();
        long durationUs = np.durationMs > 0 ? np.durationMs * 1000L : C.TIME_UNSET;
        List<MediaItemData> windows = new ArrayList<>(count);
        for (int i = 0; i < count; i++) {
            windows.add(new MediaItemData.Builder(/* uid= */ "foray-window-" + i)
                .setMediaItem(item)
                .setMediaMetadata(metadata)
                .setDurationUs(durationUs)
                /* Seekable only if the page will accept a seek. An unseekable window is
                   how the OS is told not to draw a draggable scrubber, rather than
                   drawing one that snaps back. */
                .setIsSeekable(np.canSeekTo)
                .setIsDynamic(false)
                .build());
        }
        return ImmutableList.copyOf(windows);
    }

    /**
     * The three strings, and what carries them.
     *
     * <p><b>The mapping is not decided here.</b> {@code player/media-session.js} §1
     * argues it — {@code title} is the source EPISODE, {@code artist} is the source
     * SHOW because publishers deserve the credit in the field the OS labels "artist",
     * and {@code album} is the Foray plus "part N of M" because it is the field a
     * narrow notification drops first and the one fact a listener can reconstruct.
     * Re-deciding it here would mean the Android app and mobile Chrome disagreed about
     * what a Foray is.
     *
     * <p>What IS decided here is the Android-only part: <b>which Media3 field each
     * string goes in, and how many of them</b>. {@code title}/{@code artist} are the
     * platform metadata keys the system media panel reads;
     * {@code displayTitle}/{@code subtitle} are what Media3's own notification
     * providers read first. Writing both pairs is why one mapping renders the same on
     * a lock screen, in the shade and on a head unit — and it costs two setter calls
     * against a class of bug that only shows up on one surface.
     */
    @NonNull
    private static MediaMetadata metadataFor(@NonNull NowPlaying np) {
        MediaMetadata.Builder metadata = new MediaMetadata.Builder()
            .setTitle(np.title)
            .setDisplayTitle(np.title)
            .setArtist(np.artist)
            .setSubtitle(np.artist)
            .setAlbumTitle(np.album)
            .setIsBrowsable(false)
            .setIsPlayable(true);
        if (np.durationMs > 0) metadata.setDurationMs(np.durationMs);
        if (!np.artworkUri.isEmpty()) {
            /* `Uri.parse` never throws — it accepts anything and produces an opaque Uri
               for a string that is not a URL — so the gate is the web half's `assetUri`,
               which returns "" for everything it will not vouch for. A bad URI here
               costs a picture; there is no path from it to a crash. */
            metadata.setArtworkUri(Uri.parse(np.artworkUri));
        }
        return metadata.build();
    }

    /* ------------------------------------------------------------- the presses */

    /**
     * Every {@code handleXxx} below does the same three things: name the action the
     * page's {@code navigator.mediaSession} handler is registered under, hand it over,
     * and return a future that is <b>already complete</b>.
     *
     * <p>The completed future is the load-bearing part. Media3 shows its placeholder
     * state until the future resolves, and a future that waited for the page to answer
     * would hold the placeholder across a whole cross-episode seam — 5-11 s of the
     * lock screen showing an optimistic guess (position 0, the next window) instead of
     * the truth. Completing at once means the placeholder lasts one message loop and
     * every subsequent frame is the page's real state, arriving through
     * {@link #refresh()}. <b>The page is the source of truth; the future is not a
     * promise that the page agreed.</b>
     */
    @NonNull
    @Override
    protected ListenableFuture<?> handleSetPlayWhenReady(boolean playWhenReady) {
        return send(playWhenReady ? "play" : "pause", 0L, 0L);
    }

    @NonNull
    @Override
    protected ListenableFuture<?> handleStop() {
        /* Routed to the page's `stop`, which is `stopAndClose()` — it closes the
           player, which clears the media session's metadata, which is what tells the
           web half the Foray is no longer loaded and lets it stop this service at
           once. That chain is why `stop` is exposed at all: it is the listener's
           one-press exit from an ongoing notification. */
        return send("stop", 0L, 0L);
    }

    @NonNull
    @Override
    protected ListenableFuture<?> handleRelease() {
        /* Nothing to release: there is no audio, no codec and no socket in this class.
           The session and the notification are the service's, and it releases them in
           `onDestroy`. */
        return Futures.immediateVoidFuture();
    }

    @NonNull
    @Override
    protected ListenableFuture<?> handleSeek(int mediaItemIndex, long positionMs, int seekCommand) {
        switch (seekCommand) {
            case Player.COMMAND_SEEK_TO_NEXT:
            case Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM:
                /* NEXT IS THE NEXT SEGMENT, not +30 s, and that is the answer to the
                   real question here. A Foray is an authored running order of 22-32
                   segments averaging under two minutes, so the segment IS the track:
                   `04_VOICE_AUDIO_SPEC.md` says "nextTrack = next queue item", and it is
                   what the in-page ‹‹/›› buttons do. Mapping next to a 30-second nudge
                   would duplicate `seekforward` and leave "leave this one" — the only
                   thing a driver actually needs — unreachable from a wheel. */
                return send("nexttrack", 0L, 0L);
            case Player.COMMAND_SEEK_TO_PREVIOUS:
            case Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM:
                return send("previoustrack", 0L, 0L);
            case Player.COMMAND_SEEK_BACK:
                /* AS AN OFFSET, not as the absolute position Media3 already computed
                   for us. The page's `seekbackward` handler applies
                   `max(0, forayPosition() + offset)` through `foraySeek` — the scrubber's
                   own path — and routing through it means the lock screen and the in-page
                   button cannot land in different places. Sending an absolute time would
                   work and would bypass the handler #27's table names. */
                return send("seekbackward", 0L, seekIncrement(true));
            case Player.COMMAND_SEEK_FORWARD:
                return send("seekforward", 0L, seekIncrement(false));
            default:
                /* Everything else is a scrub: `COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM` from
                   a head unit's progress bar, and `COMMAND_SEEK_TO_DEFAULT_POSITION`,
                   which Media3 also raises with `TIME_UNSET` for seeks we did not
                   declare. */
                if (positionMs == C.TIME_UNSET || positionMs < 0) {
                    /* A scrub with no time is NOT a seek to zero. The page refuses the
                       same shape in its own `seekto` handler; refusing it here as well
                       means no single bug can send an hour-long Foray back to the start. */
                    return Futures.immediateVoidFuture();
                }
                return send("seekto", positionMs, 0L);
        }
    }

    private long seekIncrement(boolean backward) {
        NowPlaying np = bridge.nowPlaying();
        long ms = backward ? np.seekBackMs : np.seekForwardMs;
        /* Zero means "the page did not tell us", and an offset of zero would be a
           button that seeks nowhere. Passing it on lets the page's own
           `offsetOf(details, fallback)` supply ±15/30 — which is where those numbers
           live. */
        return ms > 0 ? ms : 0L;
    }

    @NonNull
    private ListenableFuture<?> send(@NonNull String action, long positionMs, long offsetMs) {
        try {
            bridge.onTransport(action, positionMs, offsetMs);
        } catch (Exception e) {
            /* This runs on the main thread inside a Media3 command. Failing to deliver
               a pause must cost the pause, not the process. `NowPlayingHub.dispatch`
               already catches; this is the second line, because `bridge` is an interface
               and the next implementation of it is not this file's to trust. */
            android.util.Log.w("ForayAudio", "could not send transport " + action, e);
        }
        return Futures.immediateVoidFuture();
    }
}
