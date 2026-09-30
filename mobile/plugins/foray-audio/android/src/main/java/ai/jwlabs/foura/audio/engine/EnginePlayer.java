package ai.jwlabs.foura.audio.engine;

import ai.jwlabs.foura.engine.EngineInput;
import ai.jwlabs.foura.engine.EngineItem;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.MediaMapping;
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
 * The Media3 {@link Player} the native engine's session publishes (card A-26): a
 * {@link SimpleBasePlayer} FACADE over the core's snapshot, the pattern {@code WebViewPlayer}
 * set for the JS lane. It decodes nothing (the deck's ExoPlayer does); it holds no opinion it did
 * not read from {@link ForayEngineHost.Surface}; and every press becomes an
 * {@link EngineInput.RemotePress} into the host, where the core rules on it exactly as it rules
 * on a CarPlay press on iOS.
 *
 * <h2>WHAT IS READ FROM WHERE</h2>
 * <ul>
 *   <li>The commands: {@code MediaMapping.commandAvailability} of the core's snapshot, mapped
 *       one to one onto Media3's player commands (both spellings of next and previous: a
 *       steering wheel's {@code KEYCODE_MEDIA_NEXT} reaches {@code seekToNext}, a notification
 *       button {@code seekToNextMediaItem}). STOP is never declared, because the core never
 *       enables it (T-7: a remote stop is a pause, and a car's stop must never tear the player
 *       down).</li>
 *   <li>The words: {@code MediaMapping.sessionView}'s metadata (title, artist, album, the first
 *       artwork), written into both Media3 pairs, as {@code WebViewPlayer} does.</li>
 *   <li>The state: {@code playing} is READY with play-when-ready on; a stall or a load in
 *       flight (the view's rate 0 while playing) is BUFFERING, which keeps the controls saying
 *       pause and stops the lock screen's clock; {@code paused} is READY, play-when-ready off;
 *       {@code none} is an empty timeline, IDLE.</li>
 *   <li>The clock: the view's position state (the episode's own), which Media3 extrapolates at
 *       the rate given, so the host publishes a surface per turn, not per second.</li>
 * </ul>
 *
 * <h2>THE TIMELINE IS A NEIGHBOURHOOD, AS IN {@code WebViewPlayer}</h2>
 *
 * Media3 answers "is there a next track?" from the timeline, so a single window would make a
 * wheel's next a no-op. One window for "something before" when previous works, one for now,
 * one for "something after" when next works, all carrying the current item's metadata: the
 * engine holds the running order, and the session says only that a neighbour exists.
 *
 * <h2>AN EMPTY SESSION THAT CAN RESUME SAYS SO (A-27)</h2>
 *
 * Media3's playback resumption runs only for a play into a session with no current item whose
 * player can take one ({@code COMMAND_SET_MEDIA_ITEM}) and can play at all
 * ({@code COMMAND_PLAY_PAUSE}). So while the engine has nothing loaded AND
 * {@link Engine#canResume()} (its store holds a record a play can resume, and no input has
 * reached the core yet), the idle state declares exactly those two. Media3 then asks the
 * session's {@code onPlaybackResumption} for the playlist, sets it here
 * ({@link #handleSetMediaItems}), which is {@link Engine#resume()}: the host's cold boot from
 * the record, which paints the session paused at the recorded position. Media3's play that
 * follows is an ordinary remote press. The items Media3 hands in are not played: the record is
 * the truth, and the engine never plays a Media3 item.
 *
 * <h2>EVERY PRESS COMPLETES AT ONCE</h2>
 *
 * The host runs the press synchronously (activation, load and play inside one turn), so by the
 * time a {@code handleXxx} returns, the surface already says what the core did. The returned
 * future is complete and {@link SimpleBasePlayer} re-reads {@link #getState()} straight away:
 * there is no placeholder state for a lock screen to show a guess from.
 */
@OptIn(markerClass = UnstableApi.class)
public final class EnginePlayer extends SimpleBasePlayer {
    /** Where the state comes from and where presses go. The host in production; a recorder in a test. */
    public interface Engine {
        ForayEngineHost.Surface surface();

        ForayEngineHost.Verdict remote(EngineInput.RemotePress press);

        /** Nothing is loaded, and a play could resume the stored record (A-27). */
        default boolean canResume() {
            return false;
        }

        /** Restore from the stored record, if the engine is still cold (A-27's {@code coldBoot}). */
        default void resume() {}
    }

    /** The media id every window carries: no URI, so a controller cannot start a second player from it. */
    public static final String MEDIA_ID = "foray-engine-current";

    private final Engine engine;

    public EnginePlayer(@NonNull Looper looper, @NonNull Engine engine) {
        super(looper);
        this.engine = engine;
    }

    /** The host published a new surface: Media3 re-reads {@link #getState()} and diffs it. */
    public void refresh() {
        invalidateState();
    }

    @NonNull
    @Override
    protected State getState() {
        ForayEngineHost.Surface surface = engine.surface();
        MediaMapping.CommandAvailability availability = surface.availability();
        MediaMapping.SessionView view = surface.view();
        State.Builder state = new State.Builder()
                .setAvailableCommands(commandsFor(availability))
                .setSeekBackIncrementMs(Math.round(availability.skipBackwardIntervalSec() * 1000))
                .setSeekForwardIncrementMs(Math.round(availability.skipForwardIntervalSec() * 1000))
                /* ZERO: previous is the core's (it restarts the item), never Media3's
                   "restart if past three seconds" second opinion. */
                .setMaxSeekToPreviousPositionMs(0L);
        if (view == null || availability.clearsNowPlaying() || MediaMapping.NONE.equals(view.playbackState())) {
            if (canResume()) {
                /* A-27: the two commands Media3's playback resumption needs, and nothing else. */
                state.setAvailableCommands(commandsFor(availability).buildUpon()
                        .add(Player.COMMAND_PLAY_PAUSE)
                        .add(Player.COMMAND_SET_MEDIA_ITEM)
                        .build());
            }
            return state
                    .setPlaylist(ImmutableList.of())
                    .setPlaybackState(Player.STATE_IDLE)
                    .setPlayWhenReady(false, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
                    .build();
        }
        MediaMapping.PositionState position = view.positionState();
        boolean playing = MediaMapping.PLAYING.equals(view.playbackState());
        /* The view's rate is 0 while playing only when the clock must stand still: a stall, or a
           load in flight. That is BUFFERING, the one Media3 state that keeps play-when-ready (the
           controls still say pause) and stops extrapolating the playhead. */
        boolean stalled = playing && (surface.buffering() || (position != null && position.playbackRate() == 0));
        float speed = position != null && position.playbackRate() > 0 ? (float) position.playbackRate() : 1f;
        int before = availability.isEnabled(MediaMapping.RemoteCommand.PREVIOUS_TRACK) ? 1 : 0;
        int after = availability.isEnabled(MediaMapping.RemoteCommand.NEXT_TRACK) ? 1 : 0;
        return state
                .setPlaylist(neighbourhood(view, before + 1 + after))
                .setCurrentMediaItemIndex(before)
                .setContentPositionMs(position != null ? Math.round(position.position() * 1000) : 0L)
                .setPlaybackParameters(new PlaybackParameters(speed))
                .setPlaybackState(stalled ? Player.STATE_BUFFERING : Player.STATE_READY)
                .setPlayWhenReady(playing, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
                .build();
    }

    private boolean canResume() {
        try {
            return engine.canResume();
        } catch (RuntimeException e) {
            return false;
        }
    }

    /**
     * The item {@code onPlaybackResumption} answers with (A-27): this facade's media id and the
     * restored item's words, so a controller that shows the playlist before the play shows ours.
     */
    @NonNull
    public static MediaItem resumptionItem(@NonNull EngineItem item) {
        String title = text(item.node.get("title"));
        String show = text(item.node.get("show"));
        MediaMetadata.Builder metadata = new MediaMetadata.Builder()
                .setTitle(title)
                .setDisplayTitle(title)
                .setArtist(show)
                .setSubtitle(show)
                .setIsBrowsable(false)
                .setIsPlayable(true);
        if (item.durationSec != null && item.durationSec > 0) metadata.setDurationMs(Math.round(item.durationSec * 1000));
        return new MediaItem.Builder().setMediaId(MEDIA_ID).setMediaMetadata(metadata.build()).build();
    }

    private static String text(JsonNode node) {
        return node == null ? null : node.stringValue();
    }

    /** {@code commandAvailability}'s set as Media3 player commands. Read-only commands always. */
    @NonNull
    static Player.Commands commandsFor(@NonNull MediaMapping.CommandAvailability availability) {
        Player.Commands.Builder commands = new Player.Commands.Builder()
                .add(Player.COMMAND_GET_CURRENT_MEDIA_ITEM)
                .add(Player.COMMAND_GET_TIMELINE)
                .add(Player.COMMAND_GET_METADATA)
                /* So the service's own release() is not a no-op (SimpleBasePlayer returns early on
                   an undeclared command); handleRelease has nothing to release. */
                .add(Player.COMMAND_RELEASE);
        if (availability.isEnabled(MediaMapping.RemoteCommand.PLAY) || availability.isEnabled(MediaMapping.RemoteCommand.PAUSE)) {
            commands.add(Player.COMMAND_PLAY_PAUSE);
        }
        if (availability.isEnabled(MediaMapping.RemoteCommand.NEXT_TRACK)) {
            commands.add(Player.COMMAND_SEEK_TO_NEXT);
            commands.add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM);
        }
        if (availability.isEnabled(MediaMapping.RemoteCommand.PREVIOUS_TRACK)) {
            commands.add(Player.COMMAND_SEEK_TO_PREVIOUS);
            commands.add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM);
        }
        if (availability.isEnabled(MediaMapping.RemoteCommand.SKIP_BACKWARD)) commands.add(Player.COMMAND_SEEK_BACK);
        if (availability.isEnabled(MediaMapping.RemoteCommand.SKIP_FORWARD)) commands.add(Player.COMMAND_SEEK_FORWARD);
        if (availability.isEnabled(MediaMapping.RemoteCommand.CHANGE_PLAYBACK_POSITION)) {
            commands.add(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM);
        }
        if (availability.isEnabled(MediaMapping.RemoteCommand.STOP)) commands.add(Player.COMMAND_STOP);
        return commands.build();
    }

    @NonNull
    private static ImmutableList<MediaItemData> neighbourhood(@NonNull MediaMapping.SessionView view, int count) {
        MediaMetadata metadata = metadataFor(view);
        MediaItem item = new MediaItem.Builder().setMediaId(MEDIA_ID).setMediaMetadata(metadata).build();
        MediaMapping.PositionState position = view.positionState();
        long durationUs = position != null && position.duration() > 0 ? Math.round(position.duration() * 1_000_000) : C.TIME_UNSET;
        List<MediaItemData> windows = new ArrayList<>(count);
        for (int i = 0; i < count; i++) {
            windows.add(new MediaItemData.Builder(/* uid= */ "foray-engine-window-" + i)
                    .setMediaItem(item)
                    .setMediaMetadata(metadata)
                    .setDurationUs(durationUs)
                    .setIsSeekable(durationUs != C.TIME_UNSET)
                    .setIsDynamic(false)
                    .build());
        }
        return ImmutableList.copyOf(windows);
    }

    @NonNull
    static MediaMetadata metadataFor(@NonNull MediaMapping.SessionView view) {
        MediaMapping.Metadata m = view.metadata();
        MediaMetadata.Builder metadata = new MediaMetadata.Builder()
                .setTitle(m.title())
                .setDisplayTitle(m.title())
                .setArtist(m.artist())
                .setSubtitle(m.artist())
                .setAlbumTitle(m.album())
                .setIsBrowsable(false)
                .setIsPlayable(true);
        MediaMapping.PositionState position = view.positionState();
        if (position != null && position.duration() > 0) metadata.setDurationMs(Math.round(position.duration() * 1000));
        /* The first ABSOLUTE artwork: the list ends in the page's own icon, a path relative to
           the web app ("icon-512.png"), which no Android bitmap loader can resolve. */
        for (MediaMapping.Artwork art : m.artwork()) {
            Uri uri = art.src() == null ? null : Uri.parse(art.src());
            String scheme = uri == null ? null : uri.getScheme();
            if ("https".equals(scheme) || "http".equals(scheme)) {
                metadata.setArtworkUri(uri);
                break;
            }
        }
        return metadata.build();
    }

    // ---- the presses: each one a RemotePress, run by the host before this returns

    @NonNull
    @Override
    protected ListenableFuture<?> handleSetPlayWhenReady(boolean playWhenReady) {
        return press(playWhenReady ? MediaMapping.RemoteCommand.PLAY : MediaMapping.RemoteCommand.PAUSE, null);
    }

    /**
     * Declared only while the session is empty and can resume (A-27): Media3 applying what
     * {@code onPlaybackResumption} answered. The engine restores from its own record; the items
     * are not played (see the class comment).
     */
    @NonNull
    @Override
    protected ListenableFuture<?> handleSetMediaItems(@NonNull List<MediaItem> mediaItems, int startIndex, long startPositionMs) {
        try {
            engine.resume();
        } catch (RuntimeException e) {
            android.util.Log.w("ForayEngine", "resume failed", e);
        }
        return Futures.immediateVoidFuture();
    }

    @NonNull
    @Override
    protected ListenableFuture<?> handleStop() {
        /* Never declared, so only a controller that ignores the command set gets here; the core
           rules a remote stop a pause anyway (T-7). */
        return press(MediaMapping.RemoteCommand.STOP, null);
    }

    @NonNull
    @Override
    protected ListenableFuture<?> handleRelease() {
        return Futures.immediateVoidFuture();
    }

    @NonNull
    @Override
    protected ListenableFuture<?> handleSeek(int mediaItemIndex, long positionMs, int seekCommand) {
        switch (seekCommand) {
            case Player.COMMAND_SEEK_TO_NEXT:
            case Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM:
                return press(MediaMapping.RemoteCommand.NEXT_TRACK, null);
            case Player.COMMAND_SEEK_TO_PREVIOUS:
            case Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM:
                return press(MediaMapping.RemoteCommand.PREVIOUS_TRACK, null);
            case Player.COMMAND_SEEK_BACK:
                /* No value: the step is the founder's pair (EngineConstants), never Media3's
                   increment or a head unit's, as iOS ignores the event's interval. */
                return press(MediaMapping.RemoteCommand.SKIP_BACKWARD, null);
            case Player.COMMAND_SEEK_FORWARD:
                return press(MediaMapping.RemoteCommand.SKIP_FORWARD, null);
            default:
                /* A scrub. One with no time is not a seek to zero. */
                if (positionMs == C.TIME_UNSET || positionMs < 0) return Futures.immediateVoidFuture();
                return press(MediaMapping.RemoteCommand.CHANGE_PLAYBACK_POSITION, positionMs / 1000.0);
        }
    }

    /**
     * One press into the host. A throw here would be inside a Media3 command on the main thread:
     * it must cost the press, not the process.
     */
    @NonNull
    ListenableFuture<?> press(@NonNull MediaMapping.RemoteCommand command, Double value) {
        try {
            engine.remote(new EngineInput.RemotePress(command, value, null, Looper.myLooper() == Looper.getMainLooper()));
        } catch (RuntimeException e) {
            android.util.Log.w("ForayEngine", "remote " + command + " failed", e);
        }
        return Futures.immediateVoidFuture();
    }
}
