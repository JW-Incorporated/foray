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

    /* ── L-05 (founder feedback F12): pause, resume, stop ───────────────────
       ANDROID HAS NO PAUSE. `TextToSpeech` exposes `speak`, `stop` and
       nothing between them — this is a documented limitation of the platform
       API, not of this plugin, and `README.md` says so in the same words so
       nobody re-discovers it from the code.

       WHAT IS IMPLEMENTED INSTEAD, and its exact cost: pause is `stop()` plus
       remembering the last word boundary the engine reported
       (`onRangeStart`), and resume is `speak()` of the REMAINDER of the same
       text from that boundary. The listener hears the line continue from the
       start of the word that was being spoken when they pressed pause, which
       is within a word of the iOS behaviour (`pauseSpeaking(at: .word)`).

       THE COST WHEN THE ENGINE REPORTS NO BOUNDARY: `onRangeStart` is API 24+
       and an engine may never call it at all. Then the boundary stays 0 and
       resume RE-SPEAKS THE WHOLE LINE. That is the honest fallback — a
       narration line is one or two sentences, and hearing it again is
       recoverable in a way silence from a lock-screen resume button is not.
       `resume()`'s answer carries `fromStart` so the page can tell which
       happened, and `foray-tts.js` surfaces it. */

    /** The exact CharSequence handed to {@link TextToSpeech#speak}, kept so
     *  {@link #resume} can re-speak its tail. Null when nothing has been
     *  spoken this session. */
    private String lastSpokenText = null;
    /** The most recent {@code onRangeStart} start offset into
     *  {@link #lastSpokenText}, or 0 when the engine has reported none. */
    private int lastBoundary = 0;
    /** True between a {@link #pause} and the {@link #resume}/{@link #stop}
     *  that ends it. Android cannot be asked, so this class remembers. */
    private boolean paused = false;
    /** True while an utterance this plugin started is believed to be running.
     *  Set on an accepted {@code speak}, cleared by {@code onDone}, a
     *  {@code stop} or a {@code pause}. Android's
     *  {@link TextToSpeech#isSpeaking} exists but answers about the ENGINE,
     *  which other apps share; this answers about us. */
    private boolean speaking = false;

    /** The three words {@code state()} reports, matching iOS exactly so one
     *  caller can read both platforms. */
    private static final String STATE_SPEAKING = "speaking";
    private static final String STATE_PAUSED = "paused";
    private static final String STATE_IDLE = "idle";

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

                /* L-05. The only word-boundary signal `TextToSpeech` has, and
                   the whole of what makes a resume land near where the pause
                   did. API 24+; on anything older, and on any engine that does
                   not implement it, this is simply never called and
                   `lastBoundary` stays 0 — see the field's own comment for
                   what that costs. `end`/`frame` are deliberately ignored:
                   resume re-speaks from the START of the word in flight, which
                   is the behaviour `pauseSpeaking(at: .word)` gives on iOS. */
                @Override
                public void onRangeStart(String utteranceId, int start, int end, int frame) {
                    if (start >= 0) {
                        lastBoundary = start;
                    }
                }

                @Override
                public void onDone(String utteranceId) {
                    speaking = false;
                    paused = false;
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
            /* L-05's bookkeeping, reset BEFORE the call rather than after:
               `onRangeStart` can fire on the engine's own thread before
               `speak()` returns, and clearing the boundary afterwards would
               throw away the first word of the line we are about to be able to
               resume. */
            lastBoundary = 0;
            paused = false;
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

            /* What `resume()` will re-speak the tail of: the SAME CharSequence
               that was handed to the engine, SSML markup included, because
               `onRangeStart`'s offsets are into that string and not into the
               plain text. */
            lastSpokenText = (androidSsml != null && !androidSsml.isEmpty()) ? androidSsml : text;
            speaking = speakResult == TextToSpeech.SUCCESS;

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

    /**
     * L-05. Stop speaking and remember where, so {@link #resume} can continue.
     *
     * <p>See the field block at the top of this class for why this is
     * {@code stop()} plus a boundary rather than a real pause, and what it
     * costs when the engine reports no boundary. Resolves always.</p>
     */
    @PluginMethod
    public void pause(PluginCall call) {
        JSObject result = new JSObject();
        result.put("platform", "android");
        boolean accepted = false;
        if (tts != null && !ttsInitFailed && speaking && !paused) {
            try {
                tts.stop();
                paused = true;
                speaking = false;
                accepted = true;
            } catch (Exception e) {
                Log.w(TAG, "pause() failed", e);
            }
        }
        result.put("ok", true);
        result.put("accepted", accepted);
        /* THE PLATFORM'S LIMIT, ON THE WIRE. A caller comparing the two
           platforms' answers should not have to know which one it is talking
           to; `emulated` says that this pause is a stop-and-remember rather
           than a real one, and iOS never sets it. */
        result.put("emulated", true);
        result.put("boundary", lastBoundary);
        result.put("state", stateWord());
        result.put("reason", accepted ? "" : "nothing was speaking");
        call.resolve(result);
    }

    /**
     * L-05. Re-speak the remainder of the paused line.
     *
     * <p>{@code fromStart} is true when no word boundary was ever reported and
     * the whole line is being spoken again — the honest fallback, stated on
     * the wire rather than hidden.</p>
     */
    @PluginMethod
    public void resume(PluginCall call) {
        JSObject result = new JSObject();
        result.put("platform", "android");
        boolean accepted = false;
        boolean fromStart = false;
        if (tts != null && !ttsInitFailed && paused && lastSpokenText != null) {
            try {
                int from = lastBoundary;
                if (from < 0 || from >= lastSpokenText.length()) {
                    from = 0;
                }
                fromStart = from == 0;
                String remainder = lastSpokenText.substring(from);
                Bundle params = new Bundle();
                int speakResult = tts.speak(
                    remainder, TextToSpeech.QUEUE_FLUSH, params, UUID.randomUUID().toString()
                );
                accepted = speakResult == TextToSpeech.SUCCESS;
                if (accepted) {
                    /* The remainder is a NEW string and `onRangeStart`'s
                       offsets will be into IT, so the base has to move with
                       it or a second pause would resume from the wrong place
                       — off by however far the first pause had got. */
                    lastSpokenText = remainder;
                    lastBoundary = 0;
                    paused = false;
                    speaking = true;
                }
            } catch (Exception e) {
                Log.w(TAG, "resume() failed", e);
            }
        }
        result.put("ok", true);
        result.put("accepted", accepted);
        result.put("emulated", true);
        result.put("fromStart", fromStart);
        result.put("state", stateWord());
        result.put("reason", accepted ? "" : "nothing was paused");
        call.resolve(result);
    }

    /**
     * L-05. Stop speaking and forget the line.
     *
     * <p>{@code player/client.js}'s {@code stopAndClose} is the caller that
     * matters: closing the player must not leave a voice talking into a car.
     * Deliberately does NOT raise {@code FINISHED_EVENT} — that event advances
     * the queue, and a stop that advanced past the line it just silenced would
     * be a skip. Android's {@code UtteranceProgressListener} agrees by
     * construction: {@link TextToSpeech#stop} fires {@code onError}/nothing,
     * never {@code onDone}.</p>
     */
    @PluginMethod
    public void stop(PluginCall call) {
        JSObject result = new JSObject();
        result.put("platform", "android");
        boolean accepted = false;
        if (tts != null && !ttsInitFailed && (speaking || paused)) {
            try {
                tts.stop();
                accepted = true;
            } catch (Exception e) {
                Log.w(TAG, "stop() failed", e);
            }
        }
        speaking = false;
        paused = false;
        lastSpokenText = null;
        lastBoundary = 0;
        result.put("ok", true);
        result.put("accepted", accepted);
        result.put("state", stateWord());
        result.put("reason", accepted ? "" : "nothing to act on");
        call.resolve(result);
    }

    /** {@code speaking | paused | idle}. {@code paused} is checked first for
     *  the same reason the iOS half checks {@code isPaused} first: a paused
     *  line is not a speaking one, and a lock screen that offered a pause
     *  button for already-silent audio would cost a press. */
    private String stateWord() {
        if (paused) {
            return STATE_PAUSED;
        }
        if (speaking) {
            return STATE_SPEAKING;
        }
        return STATE_IDLE;
    }

    @PluginMethod
    public void state(PluginCall call) {
        JSObject result = new JSObject();
        result.put("platform", "android");
        result.put("ready", ttsReady);
        result.put("initFailed", ttsInitFailed);
        /* L-05. The word, ALONGSIDE the two booleans rather than instead of
           them: `state()` shipped with `ready`/`initFailed` and something may
           already read those. */
        result.put("state", stateWord());
        result.put("speaking", speaking);
        result.put("paused", paused);
        call.resolve(result);
    }

    /* ---------- K-01: the bundled-voice measurement ----------
     *
     * `docs/bundled-voice-plan.md` K-01 — "a throwaway measurement path, not a
     * product feature", deleted in K-04's cutover. The iOS half's comment
     * carries the full argument; the two differ only where the platforms do.
     *
     * WHAT IS HERE: the method, the asset lookup, the memory reading, the
     * refusal vocabulary, and the seam an engine plugs into. WHAT IS NOT:
     * `com.microsoft.onnxruntime:onnxruntime-android`, and no `build.gradle`
     * dependency on it. Nothing in this repo can build or run an Android
     * shell — `android-release.yml` is the only thing that compiles this file
     * — so adding an unverified ~16 MB native dependency for a card whose own
     * gate is a founder's phone would risk that job for no measurement gained.
     * K-04 adds it, together with an implementation of {@link KokoroProbeEngine}.
     *
     * THE REASON CODES ARE A CLOSED SET shared with
     * `player/kokoro-probe.js`'s PROBE_REASONS. A code invented here that
     * that file does not know degrades to `refused` and loses the diagnosis.
     */

    /** What K-01 needs from a runtime: phoneme ids in, timings out. NOT
     *  {@code speak}-shaped on purpose — the probe never plays through the
     *  narration path, so an engine implementing this cannot accidentally
     *  become the way narration is spoken. */
    public interface KokoroProbeEngine {
        String modelName();
        String provider();
        /** {@code [coldMs, warmMs]} for loading the model. */
        double[] load();
        /** {@code [synthMs, audioSec]} for one line. */
        double[] synthesize(int[] ids, double speed);
    }

    /** The seam. Null on every build that ships today; K-04 sets it. */
    public static KokoroProbeEngine probeEngine = null;

    /** The bundled weights, looked up in the APK's assets by name rather than
     *  assumed present: a build that skipped `tools/mobile/fetch-models.mjs`
     *  must answer {@code model-absent}, not crash. */
    static final String MODEL_ASSET = "kokoro-v1_0-q8f16.onnx";

    @PluginMethod
    public void kokoroProbe(PluginCall call) {
        JSObject result = new JSObject();
        result.put("platform", "android");

        JSObject passage = call.getObject("passage");
        /* `optJSONArray`, not `getJSONArray`: the latter throws on a missing
         * key, and "the page sent no passage" is an ANSWER this method has a
         * code for, not an exception to be caught two frames away. */
        org.json.JSONArray rawLines = passage == null ? null : passage.optJSONArray("lines");
        List<int[]> idLines = new ArrayList<>();
        int lineCount = 0;
        try {
            if (rawLines != null) {
                lineCount = rawLines.length();
                for (int i = 0; i < lineCount; i++) {
                    org.json.JSONObject line = rawLines.getJSONObject(i);
                    org.json.JSONArray ids = line.optJSONArray("ids");
                    if (ids == null || ids.length() == 0) continue;
                    int[] out = new int[ids.length()];
                    for (int j = 0; j < ids.length(); j++) out[j] = ids.getInt(j);
                    idLines.add(out);
                }
            }
        } catch (Exception e) {
            /* A malformed passage is `passage-unphonemized`, not a crash: the
             * page owns that file and a founder reading the record needs to be
             * told which artefact to fix, not that something threw. */
            idLines.clear();
        }

        if (lineCount == 0) {
            result.put("ok", false);
            result.put("reason", "passage-empty");
            call.resolve(result);
            return;
        }
        if (idLines.size() != lineCount) {
            result.put("ok", false);
            result.put("reason", "passage-unphonemized");
            call.resolve(result);
            return;
        }

        boolean modelPresent = false;
        try {
            Context ctx = getContext();
            String[] assets = ctx == null ? null : ctx.getAssets().list("");
            if (assets != null) {
                for (String a : assets) {
                    if (MODEL_ASSET.equals(a)) { modelPresent = true; break; }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "could not list assets for the Kokoro probe", e);
        }
        if (!modelPresent) {
            result.put("ok", false);
            result.put("reason", "model-absent");
            result.put("lookedFor", MODEL_ASSET);
            call.resolve(result);
            return;
        }

        /* THE ENGINE IS BUILT HERE, ON DEMAND, AND NOWHERE ELSE.
         * `probeEngine` stays null on every shipping build, and this line is
         * why that remains true AND the probe can still answer: ORT is not
         * touched in `load()`, not at app start, and not on any path narration
         * reaches. It is constructed the moment a founder taps the probe
         * button on a build that fetched the weights, and dropped when this
         * method returns. An engine registered at startup would be running
         * ONNX Runtime in every listener's app for a card that measures one
         * phone. */
        KokoroProbeEngine engine = probeEngine;
        if (engine == null) engine = KokoroOrtProbeEngine.create(getContext());
        if (engine == null) {
            result.put("ok", false);
            result.put("reason", "engine-absent");
            call.resolve(result);
            return;
        }

        double speed = passage.optDouble("speed", 1.0);
        double[] load = engine.load();
        double synthColdMs = 0;
        double synthWarmMs = 0;
        for (int i = 0; i < idLines.size(); i++) {
            double[] out = engine.synthesize(idLines.get(i), speed);
            /* FIRST LINE IS THE COLD NUMBER, the rest are warm — the go rule
             * in the card is stated on the warm figure alone, and a mean that
             * folded a two-second first inference into it would fail a phone
             * that is fine. */
            if (i == 0) synthColdMs = out[0]; else synthWarmMs += out[0];
        }

        Runtime rt = Runtime.getRuntime();
        result.put("ok", true);
        result.put("reason", "");
        result.put("model", engine.modelName());
        result.put("provider", engine.provider());
        result.put("modelLoadColdMs", load.length > 0 ? load[0] : 0);
        result.put("modelLoadWarmMs", load.length > 1 ? load[1] : 0);
        result.put("synthColdMs", synthColdMs);
        result.put("synthWarmMs", synthWarmMs);
        result.put("lines", idLines.size());
        /* `totalMemory - freeMemory` is the JVM heap, which is NOT where ORT's
         * arena lives — the native allocation is the number the deck's 833 MB
         * iPad reading is about. `Debug.getNativeHeapAllocatedSize()` is the
         * one the card names, and it is reported ALONGSIDE the JVM figure
         * rather than instead of it, because a reader comparing an Android
         * number to an iOS `phys_footprint` needs to know which is which. */
        result.put("peakMemoryBytes", (double) android.os.Debug.getNativeHeapAllocatedSize());
        result.put("availableMemoryBytes", (double) (rt.maxMemory() - (rt.totalMemory() - rt.freeMemory())));
        /* The honest weaker fact, same as iOS: the app was not resumed when
         * the last line finished. HUMAN-ACTIONS.md H1's instruction is what
         * makes it the strong claim. */
        result.put("lockedScreenCompleted", !isForeground());
        call.resolve(result);
    }

    /** Whether the app is frontmost, tracked from Capacitor's OWN lifecycle
     *  hooks rather than read off the Activity.
     *
     *  NOT {@code getActivity()}: that returns an {@code AppCompatActivity},
     *  and this plugin module does not carry {@code androidx.appcompat} on its
     *  compile classpath — naming it fails
     *  {@code :foray-tts:compileDebugJavaWithJavac} with "cannot access
     *  AppCompatActivity" (measured, `android-shell` run 34707127094). Adding
     *  the dependency for one boolean would widen what a throwaway measurement
     *  card links, and {@code handleOnResume}/{@code handleOnPause} are
     *  {@code Plugin}'s own hooks: free, and a better question anyway — they
     *  track the APP lifecycle, which is what "the screen was locked" means
     *  for a 90-second synthesis loop.
     *
     *  Starts {@code true} ("frontmost", so {@code lockedScreenCompleted}
     *  reads false), because unmeasured must never read as proven — the same
     *  direction `probeVerdict` fails an unmeasured RTF in. */
    private volatile boolean resumed = true;

    @Override
    protected void handleOnResume() {
        resumed = true;
        super.handleOnResume();
    }

    @Override
    protected void handleOnPause() {
        resumed = false;
        super.handleOnPause();
    }

    private boolean isForeground() {
        return resumed;
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
