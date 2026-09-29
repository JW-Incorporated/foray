package ai.jwlabs.a05focus;

import android.app.Activity;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Bundle;
import android.util.Log;

/**
 * A-05 (h), `docs/plans/android-assessment.md` §5.3: another app asks for audio
 * focus while 4a is playing, the way Spotify or a navigation prompt would.
 *
 * Driven by `tools/mobile/android-playback.mjs` with
 * `am start -n ai.jwlabs.a05focus/.FocusActivity --es mode <mode>`:
 *
 *   gain       request AUDIOFOCUS_GAIN (another media app starting)
 *   transient  request AUDIOFOCUS_GAIN_TRANSIENT (a prompt that ends)
 *   abandon    abandon whatever this process holds
 *
 * Every outcome is one logcat line under the tag A05Focus, which the runner
 * reads back: the request's result (1 is AUDIOFOCUS_REQUEST_GRANTED), and any
 * focus change the helper itself is sent. The helper plays nothing, so what the
 * runner measures on 4a's side is the focus change alone.
 *
 * singleTask, so a second `am start` arrives in onNewIntent on the same
 * process, and "abandon" can reach the request object "gain" made.
 */
public class FocusActivity extends Activity {
    static final String TAG = "A05Focus";
    private static AudioFocusRequest held;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        handle(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handle(intent);
    }

    private void handle(Intent intent) {
        String mode = intent == null ? null : intent.getStringExtra("mode");
        if (mode == null) mode = "gain";
        AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
        if (am == null) {
            Log.i(TAG, "mode=" + mode + " result=no-audio-manager");
            return;
        }
        if ("abandon".equals(mode)) {
            int r = held == null ? -1 : am.abandonAudioFocusRequest(held);
            held = null;
            Log.i(TAG, "mode=abandon result=" + r);
            return;
        }
        if (held != null) {
            am.abandonAudioFocusRequest(held);
            held = null;
        }
        int gain = "transient".equals(mode) ? AudioManager.AUDIOFOCUS_GAIN_TRANSIENT : AudioManager.AUDIOFOCUS_GAIN;
        AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .build();
        AudioFocusRequest request = new AudioFocusRequest.Builder(gain)
                .setAudioAttributes(attrs)
                .setOnAudioFocusChangeListener(new AudioManager.OnAudioFocusChangeListener() {
                    @Override
                    public void onAudioFocusChange(int change) {
                        Log.i(TAG, "focusChange=" + change);
                    }
                })
                .build();
        int r = am.requestAudioFocus(request);
        if (r == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) held = request;
        Log.i(TAG, "mode=" + mode + " result=" + r);
    }
}
