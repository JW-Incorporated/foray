package ai.jwlabs.foura.audio.engine;

import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.JsonNode;
import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.content.res.AssetManager;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/**
 * {@link InterludePlayer.Jingle} over one {@link MediaPlayer} on the bundled jingle asset (card
 * A-41): built on the first start (never at boot), {@code USAGE_MEDIA} / {@code CONTENT_TYPE_MUSIC},
 * at exactly 1.0x ({@code INTERLUDE_RATE}) whatever the listener's speed, and with no audio focus of
 * its own: the engine's deck holds the focus of the Foray it plays, and the jingle is part of it.
 *
 * <p>{@link #make} finds the asset and checks its SHA-256 against {@link InterludePlayer#ASSET_SHA256}
 * before any player exists: a missing or different file costs the jingle (an
 * {@code interlude kind=unavailable} row, and the service builds its core with
 * {@code interludeAvailable} off), never the app.
 *
 * <p>The player's callbacks arrive on the looper of the thread that built it, which is the host's
 * (the first {@code start}).
 */
public final class MediaJingle implements InterludePlayer.Jingle {
    private final AssetManager assets;
    private final String name;
    private MediaPlayer player;
    private Consumer<Boolean> onFinish;

    MediaJingle(AssetManager assets, String name) {
        this.assets = assets;
        this.name = name;
    }

    /**
     * The real jingle player on the app's asset, or null (and a row) when the asset is missing or is
     * not the pinned jingle.
     */
    public static InterludePlayer make(Context context, BooleanSupplier sessionIsActive, Consumer<EngineCommand.DiagEntry> diag,
                                       EngineSeams.Timing timing) {
        AssetManager assets = context.getAssets();
        String hash;
        try (InputStream in = assets.open(InterludePlayer.ASSET_NAME)) {
            hash = sha256Hex(in);
        } catch (IOException | RuntimeException e) {
            unavailable(diag, "no-asset");
            return null;
        }
        if (!InterludePlayer.ASSET_SHA256.equals(hash)) {
            unavailable(diag, "hash-mismatch");
            return null;
        }
        InterludePlayer.Config config = new InterludePlayer.Config();
        config.sessionIsActive = sessionIsActive;
        config.diag = diag;
        config.timing = timing;
        config.makeJingle = () -> new MediaJingle(assets, InterludePlayer.ASSET_NAME);
        return new InterludePlayer(config);
    }

    private static void unavailable(Consumer<EngineCommand.DiagEntry> diag, String why) {
        diag.accept(new EngineCommand.DiagEntry("interlude", Arrays.asList(
                JsonNode.member("kind", JsonNode.str("unavailable")), JsonNode.member("why", JsonNode.str(why)))));
    }

    static String sha256Hex(InputStream in) throws IOException {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IOException(e);
        }
        byte[] buffer = new byte[16384];
        for (int n = in.read(buffer); n >= 0; n = in.read(buffer)) digest.update(buffer, 0, n);
        StringBuilder out = new StringBuilder();
        for (byte b : digest.digest()) out.append(String.format("%02x", b & 0xff));
        return out.toString();
    }

    @Override
    public void setOnFinish(Consumer<Boolean> onFinish) {
        this.onFinish = onFinish;
    }

    @Override
    public boolean playFromStart() {
        try {
            if (player == null) {
                MediaPlayer made = new MediaPlayer();
                made.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build());
                try (AssetFileDescriptor fd = assets.openFd(name)) {
                    made.setDataSource(fd.getFileDescriptor(), fd.getStartOffset(), fd.getLength());
                }
                made.setLooping(false);
                made.prepare();
                made.setOnCompletionListener(mp -> finished(true));
                made.setOnErrorListener((mp, what, extra) -> {
                    /* A-41 review: a MediaPlayer in its Error state takes no seekTo or start (they
                       only raise another error), so it is let go here and the next start builds a
                       fresh one, instead of every later seam's jingle failing on the dead player. */
                    if (player == mp) release();
                    finished(false);
                    return true;
                });
                player = made;
            }
            MediaPlayer p = player;
            if (p.isPlaying()) p.pause();
            p.seekTo(0);
            // INTERLUDE_RATE is 1.0x, which is a MediaPlayer's own speed: nothing here ever changes it.
            p.start();
            return true;
        } catch (IOException | RuntimeException e) {
            release();
            return false;
        }
    }

    private void finished(boolean ok) {
        Consumer<Boolean> listener = onFinish;
        if (listener != null) listener.accept(ok);
    }

    @Override
    public void stop() {
        MediaPlayer p = player;
        if (p == null) return;
        try {
            if (p.isPlaying()) p.pause();
            p.seekTo(0);
        } catch (RuntimeException ignored) {
            // A player in an error state is released at the next start or at release().
        }
    }

    @Override
    public void release() {
        MediaPlayer p = player;
        player = null;
        if (p == null) return;
        try {
            p.release();
        } catch (RuntimeException ignored) {
            // Already gone.
        }
    }
}
