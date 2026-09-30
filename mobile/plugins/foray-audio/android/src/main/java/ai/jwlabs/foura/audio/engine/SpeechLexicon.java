package ai.jwlabs.foura.audio.engine;

import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.SpeechRules;
import android.content.res.AssetManager;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * THE PRONUNCIATION LEXICON, IN THE ENGINE (card A-41): the Android twin of the iOS
 * {@code SpeechLexicon} (NE-33). The engine speaks narration with no page (a cold start in the car),
 * so the lexicon cannot arrive over the bridge the way the legacy lane's SSML does. It is
 * {@code mobile/plugins/foray-tts/lexicon/hard-terms.json} itself, read IN PLACE from the repo by
 * foray-audio's build.gradle into the app's assets (as the jingle is), so there is no second copy
 * to drift: the file the page's tools audit is the file the phone parses.
 *
 * <p>A lexicon that is missing or does not parse is NO lexicon (every term spoken as plain text),
 * never a crash mid-narration.
 */
public final class SpeechLexicon {
    private SpeechLexicon() {}

    /** Where the lexicon is among the app's assets (foray-audio's build.gradle ships lexicon/ at the root). */
    public static final String ASSET_NAME = "hard-terms.json";

    /** The entries in the app's assets, or none. */
    public static List<SpeechRules.LexiconEntry> load(AssetManager assets) {
        try (InputStream in = assets.open(ASSET_NAME)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            for (int n = in.read(buffer); n >= 0; n = in.read(buffer)) out.write(buffer, 0, n);
            return parse(new String(out.toByteArray(), StandardCharsets.UTF_8));
        } catch (IOException | RuntimeException e) {
            return Collections.emptyList();
        }
    }

    /** The {@code entries} of a hard-terms.json document: each with a non-empty string {@code term}, and its {@code ipa} when a string. */
    public static List<SpeechRules.LexiconEntry> parse(String text) {
        JsonNode root = JsonNode.tryParse(text);
        if (root == null) return Collections.emptyList();
        JsonNode list = root.get("entries");
        List<JsonNode> items = list == null ? null : list.arrayValue();
        if (items == null) return Collections.emptyList();
        List<SpeechRules.LexiconEntry> out = new ArrayList<>();
        for (JsonNode entry : items) {
            JsonNode term = entry.get("term");
            String t = term == null ? null : term.stringValue();
            if (t == null || t.isEmpty()) continue;
            JsonNode ipa = entry.get("ipa");
            out.add(new SpeechRules.LexiconEntry(t, ipa == null ? null : ipa.stringValue()));
        }
        return Collections.unmodifiableList(out);
    }
}
