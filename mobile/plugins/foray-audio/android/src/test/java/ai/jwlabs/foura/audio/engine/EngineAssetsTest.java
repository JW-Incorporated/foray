package ai.jwlabs.foura.audio.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import ai.jwlabs.foura.audio.engine.ForayEngineHostTest.FakeTiming;
import ai.jwlabs.foura.engine.SpeechRules;
import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Card A-41: the engine's two bundled files reach the module's assets, read in place from the repo
 * by build.gradle: the jingle, which {@link MediaJingle#make} finds and hashes to the pin (so the
 * service builds its core with the jingle on), and the lexicon, which {@link SpeechLexicon} parses
 * with its one authored IPA.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class EngineAssetsTest {
    /** TO SEE IT FAIL: drop the assets srcDirs from build.gradle, or change the pin. */
    @Test
    public void theJingleShipsAndHashesToItsPin() {
        Context context = ApplicationProvider.getApplicationContext();
        List<String> rows = new ArrayList<>();
        InterludePlayer player = MediaJingle.make(context, () -> true, entry -> rows.add(entry.kind() + " " + entry.fields()), new FakeTiming());
        assertNotNull("the jingle is not among the assets, or is not the pinned one: " + rows, player);
        assertTrue(rows.toString(), rows.isEmpty());
    }

    /** TO SEE IT FAIL: drop the lexicon's srcDir, or read {@code ipa} as the category. */
    @Test
    public void theLexiconShipsAndParses() {
        List<SpeechRules.LexiconEntry> entries = SpeechLexicon.load(ApplicationProvider.<Context>getApplicationContext().getAssets());
        assertTrue("hard-terms.json carries 80-odd terms; read " + entries.size(), entries.size() > 50);
        SpeechRules.LexiconEntry sake = null;
        for (SpeechRules.LexiconEntry e : entries) if (e.term().equals("sake")) sake = e;
        assertNotNull(sake);
        assertEquals("ˈsɑːkeɪ", sake.ipa());
        SpeechRules.LexiconEntry koji = null;
        for (SpeechRules.LexiconEntry e : entries) if (e.term().equals("koji")) koji = e;
        assertNotNull(koji);
        assertNull("an unauthored ipa stays null", koji.ipa());
    }

    /** A lexicon that does not parse is no lexicon, never a crash; the hash is SHA-256 in lowercase hex. */
    @Test
    public void aBadLexiconIsNoneAndTheHashIsHex() throws Exception {
        assertTrue(SpeechLexicon.parse("{ not json").isEmpty());
        assertTrue(SpeechLexicon.parse("{\"entries\": 3}").isEmpty());
        assertEquals(1, SpeechLexicon.parse("{\"entries\":[{\"term\":\"a\",\"ipa\":null},{\"term\":\"\"},{\"ipa\":\"x\"}]}").size());
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
                MediaJingle.sha256Hex(new ByteArrayInputStream("abc".getBytes(StandardCharsets.UTF_8))));
    }
}
