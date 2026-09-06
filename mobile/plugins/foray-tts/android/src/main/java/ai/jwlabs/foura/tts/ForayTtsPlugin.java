package ai.jwlabs.foura.tts;

import android.content.Context;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Log;

import android.speech.tts.Voice;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
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

    /** §7 item 3 (L-03, {@code generation-architecture.md} §7 item 3): the
     *  event this plugin raises once an utterance completes, from
     *  {@link UtteranceProgressListener#onDone}. Mirrors {@code
     *  TRANSPORT_EVENT} in {@code ForayAudioPlugin.java}/{@code
     *  foray-media-session.js} -- the same {@code notifyListeners}/{@code
     *  addListener} mechanism, a different plugin and event name -- and must
     *  stay equal to {@code web/foray-tts.js}'s own {@code FINISHED_EVENT}
     *  string, the same pairing that file's own header states for {@code
     *  PLUGIN_NAME}. */
    private static final String FINISHED_EVENT = "finished";

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
        String requestedVoice = call.getString("voice");
        String androidSsml = call.getString("androidSsml");
        JSArray ipaOverrides = call.getArray("ipaOverrides");
        int overrideCount = ipaOverrides != null ? ipaOverrides.length() : 0;

        try {
            if (lang != null && !lang.isEmpty()) {
                tts.setLanguage(localeFor(lang));
            }

            /* VOICE. Android's equivalent of the iOS change in the same PR, and
               it is genuinely equivalent rather than a token gesture:
               `getVoices()` exposes a per-voice `getQuality()` (VERY_LOW .. VERY_HIGH)
               and `setVoice()` selects one, so "best installed for this language"
               is expressible here too. Two things differ from iOS and both are
               real, not cosmetic:

                 1. Android voices can require a NETWORK CONNECTION
                    (`isNetworkConnectionRequired()`). A commute app must not pick
                    one of those by default — see `resolveVoice` below, which
                    excludes them from the default pick but still LISTS them, so a
                    caller who deliberately asks for one gets it.
                 2. There is no "premium download" tier to explain to a user; the
                    installed set depends on which TTS engine the device ships and
                    which language packs it has, which is engine-specific and not
                    something this plugin can steer.

               `setVoice()` after `setLanguage()` on purpose: the voice carries its
               own locale, so it is the more specific instruction and must win. */
            String usedVoice = "";
            String usedVoiceQuality = "";
            boolean voiceFallback = false;
            String voiceReason = "";

            Voice chosen = resolveVoice(installedVoices(), lang, requestedVoice);
            if (requestedVoice != null && !requestedVoice.isEmpty()
                    && (chosen == null || !requestedVoice.equals(chosen.getName()))) {
                voiceFallback = true;
                voiceReason = "requested voice is not installed on this device";
            }
            if (chosen != null) {
                int setResult = tts.setVoice(chosen);
                if (setResult == TextToSpeech.SUCCESS) {
                    usedVoice = chosen.getName();
                    usedVoiceQuality = qualityLabel(chosen.getQuality());
                } else {
                    /* The engine refused the voice. Not fatal and not worth a
                       failed call: the language set above still stands, so it
                       speaks in the engine's own default voice. */
                    voiceFallback = true;
                    voiceReason = "TextToSpeech.setVoice() refused the selected voice";
                }
            } else if (voiceReason.isEmpty()) {
                voiceReason = "no installed voice matched";
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
                public void onDone(String utteranceId) {
                    /* §7 item 3 (L-03). `speak()` itself stays accept-only
                       (see the class comment on why) -- this is the separate
                       completion signal, mirroring
                       `ForayTtsPlugin.swift`'s `speechSynthesizer(_:didFinish:)`.
                       Fired on Android's own utterance-callback thread, not
                       the main thread; `notifyListeners` is documented safe
                       to call from any thread (it posts to the bridge's own
                       dispatch), the same assumption
                       `ForayAudioPlugin.java`'s TRANSPORT_EVENT emission
                       already makes for a command coming off a media-session
                       callback. */
                    notifyListeners(FINISHED_EVENT, new JSObject());
                }

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
               `startForegroundService`. Completion is reported separately,
               via `onDone` above (L-03, `generation-architecture.md` §7
               item 3) -- `speak()`'s own promise stays accept-only. */
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
            /* Same reporting contract the iOS half states: say which voice
               actually spoke, and say separately whether an explicit ask was
               honoured, so "sounds bad" and "was never installed" are different
               answers on the device where it matters. */
            pendingResult.put("voice", usedVoice);
            pendingResult.put("voiceQuality", usedVoiceQuality);
            pendingResult.put("voiceRequested", requestedVoice == null ? "" : requestedVoice);
            pendingResult.put("voiceFallback", voiceFallback);
            pendingResult.put("voiceReason", voiceReason);
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

    /**
     * Enumerate the voices this device actually has. Same contract as the iOS
     * half's {@code listVoices}, so one caller can read both.
     *
     * <p>Resolves {@code { ok, platform, voices: [{ identifier, name, language,
     * quality, isDefaultChoice, networkRequired }], defaultIdentifier, count }}.
     * {@code identifier} is the engine's voice NAME (e.g. {@code en-us-x-sfg#male_1-local}),
     * because that is what {@link TextToSpeech#setVoice} and this plugin's
     * {@code speak({ voice })} both take — {@code name} repeats it rather than
     * inventing a prettier label the plugin would then have to map back.
     * Android's {@link Voice} exposes no display name.</p>
     */
    @PluginMethod
    public void listVoices(PluginCall call) {
        JSObject result = new JSObject();
        result.put("platform", "android");

        if (tts == null || ttsInitFailed) {
            result.put("ok", false);
            putArray(result, "voices", new JSArray());
            result.put("count", 0);
            result.put("defaultIdentifier", "");
            result.put("reason", "TextToSpeech failed to initialize");
            call.resolve(result);
            return;
        }
        if (!ttsReady) {
            result.put("ok", false);
            putArray(result, "voices", new JSArray());
            result.put("count", 0);
            result.put("defaultIdentifier", "");
            result.put("reason", "TextToSpeech not ready yet (onInit pending)");
            call.resolve(result);
            return;
        }

        String lang = call.getString("lang");
        Collection<Voice> installed = installedVoices();
        Voice best = resolveVoice(installed, lang, null);
        List<Voice> listed = (lang != null && !lang.isEmpty())
            ? candidates(installed, lang)
            : new ArrayList<>(installed);
        sortForListing(listed);

        JSArray voices = new JSArray();
        for (Voice voice : listed) {
            JSObject entry = new JSObject();
            entry.put("identifier", voice.getName());
            entry.put("name", voice.getName());
            entry.put("language", voice.getLocale() == null ? "" : voice.getLocale().toLanguageTag());
            entry.put("quality", qualityLabel(voice.getQuality()));
            entry.put("isDefaultChoice", best != null && best.getName().equals(voice.getName()));
            entry.put("networkRequired", voice.isNetworkConnectionRequired());
            voices.put(entry);
        }

        result.put("ok", true);
        putArray(result, "voices", voices);
        result.put("count", listed.size());
        result.put("installedCount", installed.size());
        result.put("defaultIdentifier", best == null ? "" : best.getName());
        result.put("language", lang == null ? "" : lang);
        result.put("reason", "");
        call.resolve(result);
    }

    /**
     * Attach a {@link JSArray} to a result object.
     *
     * <p>Every other {@code put} in this file uses a primitive/String overload
     * that {@code JSObject} overrides to swallow {@code JSONException}. The
     * Object overload is the one whose exact signature has varied across
     * Capacitor majors, so this wrapper keeps the file compiling either way —
     * and a failure to attach the list must not become a thrown promise, per
     * the class header.</p>
     */
    private static void putArray(JSObject target, String key, JSArray value) {
        try {
            target.put(key, value);
        } catch (Exception e) {
            Log.w(TAG, "could not attach " + key, e);
        }
    }

    /**
     * Every installed voice, or an empty set.
     *
     * <p>{@link TextToSpeech#getVoices()} is documented to return null, and
     * several shipping engines throw from it outright rather than returning
     * null. Neither is allowed to become a rejected promise here — see the class
     * header's "every method resolves" rule.</p>
     */
    private Collection<Voice> installedVoices() {
        try {
            Set<Voice> voices = tts.getVoices();
            return voices == null ? Collections.<Voice>emptyList() : new ArrayList<>(voices);
        } catch (Exception e) {
            Log.w(TAG, "TextToSpeech.getVoices() failed", e);
            return Collections.emptyList();
        }
    }

    /**
     * Voices eligible for {@code languageTag}: exact locale matches alone when
     * there are any, widening to the whole language only when the exact locale
     * has nothing. Mirrors {@code ForayTtsPlugin.swift}'s {@code candidates(_:language:)}.
     *
     * <p>Matching goes through ISO-639-2/ISO-3166-3 codes rather than string
     * equality on the tag, because Android engines are inconsistent about which
     * spelling they hand back: the same voice can present as {@code en-US} on one
     * engine and {@code eng-USA} on another, and a plain {@code equalsIgnoreCase}
     * on the tag silently matches nothing on the second.</p>
     */
    static List<Voice> candidates(Collection<Voice> all, String languageTag) {
        List<Voice> matches = new ArrayList<>();
        if (all == null || all.isEmpty() || languageTag == null || languageTag.isEmpty()) {
            return matches;
        }
        Locale wanted = localeFor(languageTag);
        String wantedLang = iso3Language(wanted);
        String wantedCountry = iso3Country(wanted);

        for (Voice voice : all) {
            Locale locale = voice.getLocale();
            if (locale == null) continue;
            if (!iso3Language(locale).equals(wantedLang)) continue;
            if (!wantedCountry.isEmpty() && !iso3Country(locale).equals(wantedCountry)) continue;
            matches.add(voice);
        }
        if (!matches.isEmpty()) return matches;

        for (Voice voice : all) {
            Locale locale = voice.getLocale();
            if (locale != null && iso3Language(locale).equals(wantedLang)) {
                matches.add(voice);
            }
        }
        return matches;
    }

    /**
     * The voice {@code speak()} should use: the requested one if it is installed,
     * else the best-quality installed voice for the language.
     *
     * <p>Network-only voices are excluded from the DEFAULT pick — a commute app
     * that silently chose one would go mute in a tunnel — but an explicit request
     * for one is honoured, and {@code listVoices()} lists them with
     * {@code networkRequired: true} so the choice is visible.</p>
     *
     * <p>Returns null when nothing matches; the caller then leaves the engine's
     * own default in place rather than failing to speak.</p>
     */
    static Voice resolveVoice(Collection<Voice> all, String languageTag, String requestedName) {
        if (all == null || all.isEmpty()) return null;

        if (requestedName != null && !requestedName.isEmpty()) {
            for (Voice voice : all) {
                if (requestedName.equals(voice.getName())) return voice;
            }
        }

        List<Voice> pool = candidates(all, languageTag);
        if (pool.isEmpty()) return null;

        Voice best = null;
        for (Voice voice : pool) {
            if (voice.isNetworkConnectionRequired()) continue;
            if (best == null || betterThan(voice, best)) best = voice;
        }
        if (best != null) return best;

        /* Everything for this language needs a network. Better than nothing —
           and the caller reports which voice it used, so this is visible. */
        for (Voice voice : pool) {
            if (best == null || betterThan(voice, best)) best = voice;
        }
        return best;
    }

    /** Higher quality wins; ties break on name, purely for determinism. */
    private static boolean betterThan(Voice candidate, Voice incumbent) {
        if (candidate.getQuality() != incumbent.getQuality()) {
            return candidate.getQuality() > incumbent.getQuality();
        }
        return candidate.getName().compareTo(incumbent.getName()) < 0;
    }

    /** Language, then BEST QUALITY FIRST within a language, then name. */
    static void sortForListing(List<Voice> voices) {
        Collections.sort(voices, new Comparator<Voice>() {
            @Override
            public int compare(Voice a, Voice b) {
                String langA = a.getLocale() == null ? "" : a.getLocale().toLanguageTag();
                String langB = b.getLocale() == null ? "" : b.getLocale().toLanguageTag();
                int byLang = langA.compareTo(langB);
                if (byLang != 0) return byLang;
                if (a.getQuality() != b.getQuality()) return b.getQuality() - a.getQuality();
                return a.getName().compareTo(b.getName());
            }
        });
    }

    /**
     * Android's quality scale is a coarse int constant, not iOS's three named
     * tiers, so the labels differ across platforms on purpose. Reported as a
     * bucket name rather than the raw number because the numbers
     * ({@code QUALITY_VERY_HIGH == 500}) mean nothing to a reader.
     */
    static String qualityLabel(int quality) {
        if (quality >= Voice.QUALITY_VERY_HIGH) return "very-high";
        if (quality >= Voice.QUALITY_HIGH) return "high";
        if (quality >= Voice.QUALITY_NORMAL) return "normal";
        if (quality >= Voice.QUALITY_LOW) return "low";
        return "very-low";
    }

    private static String iso3Language(Locale locale) {
        try {
            return locale.getISO3Language();
        } catch (Exception e) {
            /* MissingResourceException for a language with no three-letter code
               — fall back to whatever the locale calls itself. */
            return locale.getLanguage();
        }
    }

    private static String iso3Country(Locale locale) {
        try {
            return locale.getISO3Country();
        } catch (Exception e) {
            return locale.getCountry();
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
