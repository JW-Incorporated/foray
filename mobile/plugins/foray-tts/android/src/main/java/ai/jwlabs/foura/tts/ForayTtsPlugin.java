package ai.jwlabs.foura.tts;

import android.content.Context;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Locale;
import java.util.UUID;

/**
 * The bridge half of `foray-tts` on Android: wraps {@link TextToSpeech}.
 *
 * <h2>Called from where</h2>
 *
 * From {@code mobile/plugins/foray-tts/web/foray-tts.js}, over
 * {@code window.Capacitor.nativePromise("ForayTts", "speak", …)} -- same
 * bridge mechanism {@code ForayAudioPlugin} uses and for the same reason: this
 * repo has no bundler, so there is no generated {@code @capacitor/core} proxy.
 *
 * <h2>What {@code docs/research/on-device-tts.md} §2 established, and what this
 * class does about it</h2>
 *
 * The official {@code TextToSpeech} / {@code Voice} reference documents NO
 * phoneme, IPA or SSML attribute anywhere in its API surface -- unlike iOS's
 * {@code AVSpeechSynthesisIPANotationAttribute} (see {@code ForayTtsPlugin.swift}),
 * there is no first-party override mechanism to call. SSML {@code <phoneme>}
 * markup passed into {@code speak()} is, at best, an UNDOCUMENTED,
 * engine-dependent side effect that may do nothing on a given device's
 * selected TTS engine. Per the card's explicit instruction, this class does
 * NOT silently drop the web side's best-effort SSML: when
 * {@code call.getString("androidSsml")} is non-null it is passed straight
 * into {@link TextToSpeech#speak}, and whether it changes anything audible is
 * exactly what `docs/research/narrator-voice.md` §5.7's acceptance fixture
 * exists to determine on a real device -- this class cannot know in advance
 * and does not pretend to.
 *
 * <h2>Every method RESOLVES. None of them rejects.</h2>
 *
 * Same rule {@code ForayAudioPlugin} states and for the same reason: a
 * rejected {@code PluginCall} becomes an unhandled promise in a page that may
 * be mid-narration. Failure is reported as data ({@code ok}, {@code reason}),
 * not as a thrown promise -- the web half's {@code speak()} in
 * {@code foray-tts.js} falls back to the standard Web Speech API on any
 * native failure, so a rejection here would just be swallowed one layer up
 * anyway; resolving with a clear reason is more honest about what happened.
 */
@CapacitorPlugin(name = "ForayTts")
public class ForayTtsPlugin extends Plugin implements TextToSpeech.OnInitListener {

    private static final String TAG = "ForayTts";

    /** Null until {@link #onInit} reports success or failure. Guarded by the
     *  Capacitor bridge's own single-threaded call dispatch -- every
     *  {@code @PluginMethod} here runs on the same worker, so no separate lock
     *  is needed for this field. */
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private boolean ttsInitFailed = false;

    @Override
    public void load() {
        super.load();
        Context context = getContext();
        if (context != null) {
            /* Constructed once per plugin instance (once per Activity), same
               lifetime `foray-audio`'s NowPlayingHub.TransportSink is scoped
               to. `TextToSpeech`'s own constructor is asynchronous -- onInit
               fires later on a callback thread -- so `ttsReady` starts false
               and every `speak()` call below checks it rather than assuming
               construction finished. */
            try {
                tts = new TextToSpeech(context.getApplicationContext(), this);
            } catch (Exception e) {
                Log.w(TAG, "could not construct TextToSpeech", e);
                ttsInitFailed = true;
            }
        } else {
            ttsInitFailed = true;
        }
    }

    @Override
    public void onInit(int status) {
        if (status == TextToSpeech.SUCCESS) {
            ttsReady = true;
        } else {
            ttsInitFailed = true;
            Log.w(TAG, "TextToSpeech.onInit reported failure, status=" + status);
        }
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text");
        JSObject result = new JSObject();
        result.put("platform", "android");

        if (text == null || text.isEmpty()) {
            result.put("ok", false);
            result.put("reason", "empty text");
            call.resolve(result);
            return;
        }
        if (tts == null || ttsInitFailed) {
            result.put("ok", false);
            result.put("reason", "TextToSpeech failed to initialize");
            call.resolve(result);
            return;
        }
        if (!ttsReady) {
            /* onInit has not fired yet. Rather than block the bridge thread
               waiting for a callback whose timing this class does not
               control, report the honest state and let the web half's own
               fallback (Web Speech, or simply "try again") decide -- same
               "answer truthfully, do not guess" rule ForayAudioPlugin.state()
               documents for its own async race. */
            result.put("ok", false);
            result.put("reason", "TextToSpeech not ready yet (onInit pending)");
            call.resolve(result);
            return;
        }

        String lang = call.getString("lang");
        Double rate = call.getDouble("rate");
        Double pitch = call.getDouble("pitch");
        String androidSsml = call.getString("androidSsml");
        JSArray ipaOverrides = call.getArray("ipaOverrides");
        int overrideCount = ipaOverrides != null ? ipaOverrides.length() : 0;

        try {
            if (lang != null && !lang.isEmpty()) {
                tts.setLanguage(localeFor(lang));
            }
            if (rate != null) {
                tts.setSpeechRate(rate.floatValue());
            }
            if (pitch != null) {
                tts.setPitch(pitch.floatValue());
            }

            String utteranceId = UUID.randomUUID().toString();
            final PluginCall pendingCall = call;
            final JSObject pendingResult = result;
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override
                public void onStart(String utteranceId) { /* no-op: resolution is on accept, not on completion -- see class comment */ }

                @Override
                public void onDone(String utteranceId) { /* completion is not awaited; see below */ }

                @Override
                public void onError(String utteranceId) { /* completion is not awaited; see below */ }
            });

            /* PASSED THROUGH, NOT DROPPED, per the card's explicit instruction
               and this class's own header: best-effort SSML if the web half
               built one (it authored at least one non-null-ipa override),
               else the plain text `speechSynthesis`-equivalent path. Neither
               is awaited to completion here -- `speak()`'s own `QUEUE_FLUSH`
               call returning SUCCESS means "accepted", exactly the same
               "accepted, not necessarily audible" distinction
               `ForayAudioPlugin.start()`'s own comment draws for
               `startForegroundService`. A completion-aware version (awaiting
               `onDone`) is real future work, not something this card's single
               proof-of-plumbing call site needs. */
            Bundle params = new Bundle();
            int speakResult;
            if (androidSsml != null && !androidSsml.isEmpty()) {
                /* TextToSpeech has no public "speak SSML" entry point distinct
                   from speak(CharSequence, ...) -- the undocumented behaviour
                   on-device-tts.md §2 describes is exactly this: pass the
                   marked-up string as the CharSequence and let the engine
                   decide what, if anything, it does with the tags. */
                speakResult = tts.speak(androidSsml, TextToSpeech.QUEUE_FLUSH, params, utteranceId);
            } else {
                speakResult = tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, utteranceId);
            }

            pendingResult.put("ok", speakResult == TextToSpeech.SUCCESS);
            pendingResult.put("accepted", speakResult == TextToSpeech.SUCCESS);
            pendingResult.put("usedSsml", androidSsml != null && !androidSsml.isEmpty());
            pendingResult.put("overridesRequested", overrideCount);
            pendingResult.put(
                "reason",
                speakResult == TextToSpeech.SUCCESS
                    ? ""
                    : "TextToSpeech.speak() returned ERROR (" + speakResult + ")"
            );
            pendingCall.resolve(pendingResult);
        } catch (Exception e) {
            Log.w(TAG, "speak() failed", e);
            result.put("ok", false);
            result.put("reason", e.getClass().getSimpleName() + ": " + e.getMessage());
            call.resolve(result);
        }
    }

    @PluginMethod
    public void state(PluginCall call) {
        JSObject result = new JSObject();
        result.put("platform", "android");
        result.put("ready", ttsReady);
        result.put("initFailed", ttsInitFailed);
        call.resolve(result);
    }

    private static Locale localeFor(String bcp47) {
        try {
            return Locale.forLanguageTag(bcp47);
        } catch (Exception e) {
            return Locale.getDefault();
        }
    }

    /** Release the engine when the Activity hosting the bridge goes away, same
     *  reasoning {@code ForayAudioPlugin.handleOnDestroy} states for its own
     *  service: without this a destroyed Activity can leak a bound TTS
     *  engine connection. */
    @Override
    protected void handleOnDestroy() {
        if (tts != null) {
            try {
                tts.stop();
                tts.shutdown();
            } catch (Exception e) {
                Log.w(TAG, "could not shut down TextToSpeech", e);
            }
        }
        tts = null;
        ttsReady = false;
        super.handleOnDestroy();
    }
}
