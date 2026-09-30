package ai.jwlabs.foura.audio.engine;

import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.SpeechRules;
import android.content.Context;
import android.media.AudioAttributes;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.function.Consumer;

/**
 * {@link SpeechNarrator.Output} over Android {@link TextToSpeech} (card A-41): the engine's own
 * synthesiser, in the service's process, so a Foray's spoken line (or a rendered line's fallback) is
 * heard on a locked phone with no page. Not the legacy lane's {@code ForayTtsPlugin}: that one
 * belongs to the page and dies with its bridge; this one is the engine's, built by the service and
 * released at its teardown.
 *
 * <h2>WHAT ANDROID GIVES, AND WHAT THIS DOES WITH IT</h2>
 * <ul>
 *   <li><b>Init is asynchronous.</b> {@code TextToSpeech}'s constructor answers later
 *       ({@code onInit}). A line asked for before then is held and spoken the moment init succeeds;
 *       if init fails it ends {@code failed} (the narrator reports a failed line as over, so the
 *       Foray advances). A line after a failed init is refused at once.</li>
 *   <li><b>No pause.</b> {@code TextToSpeech} has {@code speak} and {@code stop} and nothing between
 *       (the legacy plugin's L-05 finding). Pause is a stop that remembers the last word boundary
 *       ({@code onRangeStart}, API 26+); resume speaks the rest of the line from that word
 *       ({@code continued}), or the whole line when no boundary was reported or the line was marked
 *       up ({@code fromStart}).</li>
 *   <li><b>Its audio.</b> {@code USAGE_MEDIA} / {@code CONTENT_TYPE_SPEECH}, so a spoken line is on
 *       the same stream as the deck's audio.</li>
 *   <li><b>Its voices.</b> Every installed voice that needs no network (a spoken fallback in a
 *       tunnel must not depend on the network that just failed), named by {@code Voice.getName()},
 *       ranked by {@code getQuality()}; a voice the listener asked for by name stays eligible even if
 *       it needs the network, as the legacy plugin honours an explicit request.</li>
 *   <li><b>Its callbacks</b> arrive on the synthesiser's own thread and are posted to the host's
 *       looper, keyed by utterance id so a line this output already left never reports.</li>
 * </ul>
 */
public final class TtsOutput implements SpeechNarrator.Output {
    private static final String UTTERANCE_PREFIX = "foray-engine-";

    private final Handler main;
    private final Consumer<EngineCommand.DiagEntry> diag;
    private TextToSpeech tts;
    private boolean ready;
    private boolean initFailed;
    private SpeechNarrator.EndListener onEnd;

    /** The line in flight, its text as spoken and where the engine last said it was. */
    private SpeechNarrator.Line line;
    private int lineId;
    /** Bumped on every speak call, so a stopped utterance's late callbacks are recognisably stale. */
    private int generation;
    private String utteranceId;
    /** Where the utterance in flight starts inside the line's text (0, or the resumed word). */
    private int spokenFrom;
    /** The last word boundary inside the LINE's text. */
    private int boundary;
    private boolean held;
    /** A line asked for before init answered: spoken when it does. */
    private boolean pendingStart;

    public TtsOutput(Context context, Looper looper, Consumer<EngineCommand.DiagEntry> diag) {
        this.main = new Handler(looper);
        this.diag = diag;
        tts = new TextToSpeech(context.getApplicationContext(), status -> main.post(() -> initialised(status)));
    }

    private void initialised(int status) {
        TextToSpeech engine = tts;
        if (engine == null) return;
        if (status != TextToSpeech.SUCCESS) {
            initFailed = true;
            row("init-failed", "status", String.valueOf(status));
            if (pendingStart) {
                pendingStart = false;
                end(lineId, SpeechNarrator.End.FAILED);
            }
            return;
        }
        ready = true;
        engine.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build());
        engine.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override
            public void onStart(String id) {
                main.post(() -> {
                    if (id != null && id.equals(utteranceId)) row("line-started", "engine", engineName());
                });
            }

            @Override
            public void onRangeStart(String id, int start, int end, int frame) {
                main.post(() -> {
                    if (id != null && id.equals(utteranceId) && start >= 0) boundary = spokenFrom + start;
                });
            }

            @Override
            public void onDone(String id) {
                main.post(() -> {
                    if (id != null && id.equals(utteranceId) && !held) end(lineId, SpeechNarrator.End.FINISHED);
                });
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onError(String id) {
                onError(id, TextToSpeech.ERROR);
            }

            @Override
            public void onError(String id, int code) {
                main.post(() -> {
                    if (id == null || !id.equals(utteranceId) || held) return;
                    row("engine-error", "code", String.valueOf(code));
                    end(lineId, SpeechNarrator.End.FAILED);
                });
            }
        });
        row("ready", "engine", engineName());
        if (pendingStart) {
            pendingStart = false;
            if (!utter(line.text(), line.ssml(), 0)) end(lineId, SpeechNarrator.End.FAILED);
        }
    }

    @Override
    public void setOnEnd(SpeechNarrator.EndListener listener) {
        onEnd = listener;
    }

    @Override
    public boolean ready() {
        return ready;
    }

    @Override
    public boolean failed() {
        return initFailed || tts == null;
    }

    @Override
    public List<SpeechRules.VoiceOption> installedVoices(String requested) {
        List<SpeechRules.VoiceOption> out = new ArrayList<>();
        if (!ready || tts == null) return out;
        Set<Voice> voices;
        try {
            voices = tts.getVoices();
        } catch (RuntimeException e) {
            return out;
        }
        if (voices == null) return out;
        String asked = requested == null ? null : requested.trim();
        for (Voice v : voices) {
            if (v == null || v.getName() == null || v.getLocale() == null) continue;
            Set<String> features = v.getFeatures();
            if (features != null && features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
            if (v.isNetworkConnectionRequired() && !v.getName().equals(asked)) continue;
            out.add(new SpeechRules.VoiceOption(v.getName(), v.getName(), v.getLocale().toLanguageTag(), v.getQuality()));
        }
        return out;
    }

    @Override
    public String language() {
        return Locale.getDefault().toLanguageTag();
    }

    @Override
    public String systemVoiceName() {
        if (!ready || tts == null) return null;
        try {
            Voice v = tts.getDefaultVoice();
            return v == null ? null : v.getName();
        } catch (RuntimeException e) {
            return null;
        }
    }

    @Override
    public boolean start(SpeechNarrator.Line next, int id) {
        silence();
        line = next;
        lineId = id;
        boundary = 0;
        held = false;
        if (tts == null || initFailed) return false;
        if (!ready) {
            pendingStart = true;
            return true;
        }
        return utter(next.text(), next.ssml(), 0);
    }

    @Override
    public boolean pause() {
        if (line == null || held) return false;
        held = true;
        pendingStart = false;
        utteranceId = null;
        if (tts != null) tts.stop();
        return true;
    }

    @Override
    public SpeechNarrator.Resumed resume() {
        if (line == null || !held || tts == null || initFailed) return SpeechNarrator.Resumed.REFUSED;
        held = false;
        if (!ready) {
            /* A-41 review: paused before init answered (the pause dropped the held start). Refusing
               here would leave the line held for good once init succeeds, with nobody to resume it;
               so it is spoken from its first word when init answers, as a first start is. */
            boundary = 0;
            pendingStart = true;
            return SpeechNarrator.Resumed.FROM_START;
        }
        String text = line.text();
        /* The rest of the PLAIN line from the word in flight; a marked-up line, or one the engine
           reported no boundary for, is re-spoken whole (an SSML tail would be half a tag). */
        if (line.ssml() == null && boundary > 0 && boundary < text.length()) {
            int from = boundary;
            return utter(text.substring(from), null, from) ? SpeechNarrator.Resumed.CONTINUED : SpeechNarrator.Resumed.REFUSED;
        }
        boundary = 0;
        return utter(text, line.ssml(), 0) ? SpeechNarrator.Resumed.FROM_START : SpeechNarrator.Resumed.REFUSED;
    }

    @Override
    public void stop() {
        silence();
    }

    @Override
    public void release() {
        silence();
        TextToSpeech engine = tts;
        tts = null;
        ready = false;
        if (engine != null) {
            try {
                engine.stop();
                engine.shutdown();
            } catch (RuntimeException ignored) {
                // A synthesiser that is already gone has nothing left to release.
            }
        }
    }

    // ---- internals

    /** Speak {@code text} (or its {@code ssml}) as the current line, from {@code from} inside the line's text. */
    private boolean utter(String text, String ssml, int from) {
        TextToSpeech engine = tts;
        if (engine == null) return false;
        SpeechNarrator.Line current = line;
        applyVoice(engine, current.voiceId());
        engine.setSpeechRate(current.rate() > 0 ? current.rate() : 1f);
        generation += 1;
        String id = UTTERANCE_PREFIX + lineId + "-" + generation;
        utteranceId = id;
        spokenFrom = from;
        int result;
        try {
            result = engine.speak(ssml != null ? ssml : text, TextToSpeech.QUEUE_FLUSH, new Bundle(), id);
        } catch (RuntimeException e) {
            result = TextToSpeech.ERROR;
        }
        if (result != TextToSpeech.SUCCESS) {
            utteranceId = null;
            row("speak-refused", "result", String.valueOf(result));
            return false;
        }
        return true;
    }

    private void applyVoice(TextToSpeech engine, String name) {
        if (name == null) return;
        try {
            Set<Voice> voices = engine.getVoices();
            if (voices == null) return;
            for (Voice v : voices) {
                if (v != null && name.equals(v.getName())) {
                    engine.setVoice(v);
                    return;
                }
            }
        } catch (RuntimeException ignored) {
            // The voice stays the engine's own; the narrator already reported what it asked for.
        }
    }

    /** Forget the line in flight and silence it. Nothing is reported. */
    private void silence() {
        pendingStart = false;
        held = false;
        String was = utteranceId;
        utteranceId = null;
        line = null;
        if (was != null && tts != null) {
            try {
                tts.stop();
            } catch (RuntimeException ignored) {
                // Nothing was speaking.
            }
        }
    }

    private void end(int id, SpeechNarrator.End end) {
        if (id != lineId || line == null) return;
        utteranceId = null;
        line = null;
        SpeechNarrator.EndListener listener = onEnd;
        if (listener != null) listener.ended(id, end);
    }

    private String engineName() {
        try {
            return tts == null || tts.getDefaultEngine() == null ? "none" : tts.getDefaultEngine();
        } catch (RuntimeException e) {
            return "unknown";
        }
    }

    private void row(String kind, String key, String value) {
        diag.accept(new EngineCommand.DiagEntry("speaker", Arrays.asList(
                JsonNode.member("kind", JsonNode.str(kind)), JsonNode.member(key, JsonNode.str(value)))));
    }

    /** For the dump: whether the synthesiser answered, and with which engine. */
    public List<JsonNode.Member> describe() {
        List<JsonNode.Member> out = new ArrayList<>();
        out.add(JsonNode.member("ready", JsonNode.bool(ready)));
        out.add(JsonNode.member("failed", JsonNode.bool(failed())));
        out.add(JsonNode.member("engine", JsonNode.str(engineName())));
        return Collections.unmodifiableList(out);
    }
}
