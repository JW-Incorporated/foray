package ai.jwlabs.foura.audio.engine;

import androidx.annotation.NonNull;
import androidx.annotation.OptIn;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;

/**
 * The deck's audio settings (card A-26), in one place so the service and the focus tests
 * configure their player identically:
 * {@code setAudioAttributes(CONTENT_TYPE_SPEECH, USAGE_MEDIA, handleAudioFocus = true)}, so Media3
 * requests AUDIOFOCUS_GAIN when the deck plays and, because the content is SPEECH, pauses on a
 * duck instead of lowering the volume under a navigation prompt (a duck becomes pause-and-resume);
 * and {@code setHandleAudioBecomingNoisy(true)}, so headphones out or Bluetooth gone pauses.
 * {@link FocusMapping} is how the engine hears what Media3 did with either.
 */
@OptIn(markerClass = UnstableApi.class)
public final class EngineAudio {
    private EngineAudio() {}

    /** Speech, media usage. */
    public static AudioAttributes speech() {
        return new AudioAttributes.Builder()
                .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
                .setUsage(C.USAGE_MEDIA)
                .build();
    }

    public static void configure(@NonNull ExoPlayer player) {
        player.setAudioAttributes(speech(), /* handleAudioFocus= */ true);
        player.setHandleAudioBecomingNoisy(true);
    }
}
