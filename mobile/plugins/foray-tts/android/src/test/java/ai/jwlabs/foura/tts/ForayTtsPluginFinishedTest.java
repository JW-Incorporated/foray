package ai.jwlabs.foura.tts;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import androidx.test.core.app.ApplicationProvider;

import com.getcapacitor.JSObject;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.shadow.api.Shadow;
import org.robolectric.shadows.ShadowTextToSpeech;

import java.util.List;

/**
 * A-13 (docs/plans/android-assessment.md §5.3): the {@code finished} event, run.
 *
 * <p>{@code finished} is what moves the Foray past a narration line on Android
 * ({@code web/foray-tts.js} listens for it), and its {@code utteranceId} is how
 * the page tells whose line ended (audit round 3, mobile-native-2). Before this,
 * nothing executed the listener that raises it.
 *
 * <p>The plugin runs with its real {@code speak}: Robolectric's
 * {@link ShadowTextToSpeech} accepts the utterance and, like a real engine,
 * reports {@code onStart} and then {@code onDone} later on the main looper,
 * which these tests hold paused until they choose to idle it. The error paths
 * call the listener the plugin registered, the way the engine would.
 *
 * <p>Each test names the one-line mutation it exists to catch.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class ForayTtsPluginFinishedTest {

    /** The plugin with its one bridge dependency, the Context, supplied directly. */
    static final class TestPlugin extends ForayTtsPlugin {
        private final Context context;

        TestPlugin(Context context) {
            this.context = context;
        }

        @Override
        public Context getContext() {
            return context;
        }
    }

    private TestPlugin plugin;
    /** Registered through the plugin's own {@code addListener}, so an event reaches it
     *  through Capacitor's real {@code notifyListeners}. */
    private RecordingCall finished;

    @Before
    public void setUp() {
        Context app = ApplicationProvider.getApplicationContext();
        plugin = new TestPlugin(app);
        plugin.load();
        // The engine's "bound and ready" callback; the shadow never makes it.
        plugin.onInit(TextToSpeech.SUCCESS);
        finished = RecordingCall.of("addListener", "eventName", "finished");
        plugin.addListener(finished);
    }

    /** Speaks one line and returns the utteranceId the plugin answered with. */
    private String speak(String text) {
        RecordingCall call = RecordingCall.of("speak", "text", text);
        plugin.speak(call);
        JSObject answer = call.answer();
        assertTrue("speak accepted: " + answer, answer.optBoolean("ok"));
        String id = answer.getString("utteranceId");
        assertNotNull(id);
        return id;
    }

    private static UtteranceProgressListener engineListener() {
        TextToSpeech tts = ShadowTextToSpeech.getLastTextToSpeechInstance();
        assertNotNull("load() built a TextToSpeech", tts);
        ShadowTextToSpeech shadow = Shadow.extract(tts);
        UtteranceProgressListener listener = shadow.getUtteranceProgressListener();
        assertNotNull("speak() registered an UtteranceProgressListener", listener);
        return listener;
    }

    private static void runEngineCallbacks() {
        Shadows.shadowOf(Looper.getMainLooper()).idle();
    }

    private List<JSObject> events() {
        return finished.resolved;
    }

    /** MUTATION: delete {@code finished.put("utteranceId", utteranceId);} in the
     *  listener's {@code onDone}: this goes red. */
    @Test
    public void onDone_raisesFinishedCarryingTheUtteranceId() {
        String id = speak("The first line of the Foray.");
        assertTrue("nothing is raised before the engine reports", events().isEmpty());

        runEngineCallbacks();

        assertEquals(1, events().size());
        JSObject event = events().get(0);
        assertEquals(id, event.getString("utteranceId"));
        assertFalse("a completed line is not an error", event.has("error"));
        assertFalse(event.optBoolean("audition", true));
    }

    /** MUTATION: delete {@code finished.put("utteranceId", utteranceId);} in
     *  {@code onEngineError}: this goes red. */
    @Test
    public void onError_withACode_raisesFinishedCarryingTheUtteranceIdAndTheCode() {
        String id = speak("A line a network voice cannot reach.");

        engineListener().onError(id, TextToSpeech.ERROR_NETWORK_TIMEOUT);

        assertEquals(1, events().size());
        JSObject event = events().get(0);
        assertEquals(id, event.getString("utteranceId"));
        assertEquals(TextToSpeech.ERROR_NETWORK_TIMEOUT, event.optInt("error", 0));

        // The engine's own later onDone for the same line is not a second ending.
        runEngineCallbacks();
        assertEquals(1, events().size());
    }

    /** MUTATION: delete the body of the one-argument {@code onError(String)}
     *  override (the pre-API-21 overload some engines still call): this goes red. */
    @Test
    @SuppressWarnings("deprecation")
    public void onError_legacyOverload_raisesFinishedCarryingTheUtteranceId() {
        String id = speak("A line a dead engine drops.");

        engineListener().onError(id);

        assertEquals(1, events().size());
        assertEquals(id, events().get(0).getString("utteranceId"));
        assertEquals(TextToSpeech.ERROR, events().get(0).optInt("error", 0));
    }

    /** MUTATION: {@code if (utteranceId == null || !utteranceId.equals(currentUtteranceId) || paused)}
     *  → {@code if (utteranceId == null || paused)} in {@code onDone} or in
     *  {@code onEngineError}: the line a QUEUE_FLUSH replaced would end the line
     *  that replaced it (mobile-native-2), and this goes red. */
    @Test
    public void anUtteranceAQueueFlushReplaced_raisesNothing() {
        String first = speak("A line that is cut off.");
        String second = speak("The line that replaced it.");
        assertNotEquals(first, second);

        engineListener().onError(first, TextToSpeech.ERROR_SERVICE);
        assertTrue("an error for the replaced line is ignored", events().isEmpty());

        // The shadow now reports onDone for BOTH utterances, the replaced one first.
        runEngineCallbacks();

        assertEquals("only the current line ends", 1, events().size());
        assertEquals(second, events().get(0).getString("utteranceId"));
    }
}
