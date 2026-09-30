package ai.jwlabs.foura.engine;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.Test;

/**
 * Card A-41: what the parity families do not pin (their JS has no fixture for it): the Android
 * markup of a hard term (foray-tts.js {@code buildAndroidSsml}, pinned by foray-tts.test.mjs on the
 * JS side), and the voice rules as the Android narrator uses them, over Android's quality ints.
 */
public class SpeechRulesTest {
    static final List<SpeechRules.LexiconEntry> LEXICON = Arrays.asList(
            new SpeechRules.LexiconEntry("sake", "ˈsɑːkeɪ"),
            new SpeechRules.LexiconEntry("koji", null));

    /** TO SEE IT FAIL: escape nothing, or mark up a term with no authored IPA. */
    @Test
    public void androidSsmlMarksOnlyAuthoredTermsAndEscapes() {
        assertNull("nothing to mark up is no document", SpeechRules.androidSsml("A dash of koji.", LEXICON));
        assertEquals("<speak>Koji &lt;&amp;&gt; <phoneme alphabet=\"ipa\" ph=\"ˈsɑːkeɪ\">SAKE</phoneme>!</speak>",
                SpeechRules.androidSsml("Koji <&> SAKE!", LEXICON));
    }

    /** TO SEE IT FAIL: widen to en-GB while an en-US voice exists, or break a tier tie by list order. */
    @Test
    public void theNarratorsVoiceOnAndroidsScale() {
        List<SpeechRules.VoiceOption> installed = Arrays.asList(
                new SpeechRules.VoiceOption("en-us-x-b", "en-us-x-b", "en-US", 400),
                new SpeechRules.VoiceOption("en-us-x-a", "en-us-x-a", "en-US", 400),
                new SpeechRules.VoiceOption("en-gb-x-z", "en-gb-x-z", "en-GB", 500));
        SpeechRules.VoiceResolution none = SpeechRules.narrationVoice(installed, null, "en-US", null);
        assertEquals("the lowest identifier among the best en-US tier", "en-us-x-a", none.voice().identifier());
        assertFalse(none.didFallBack());
        SpeechRules.VoiceResolution familiar = SpeechRules.narrationVoice(installed, "  ", "en-US", "en-us-x-b");
        assertEquals("a blank request is none; the system's own voice wins the tie", "en-us-x-b", familiar.voice().identifier());
        SpeechRules.VoiceResolution missing = SpeechRules.narrationVoice(installed, "gone", "en-US", null);
        assertTrue(missing.didFallBack());
        assertEquals("en-us-x-a", missing.voice().identifier());
        SpeechRules.VoiceResolution nothing = SpeechRules.narrationVoice(Collections.<SpeechRules.VoiceOption>emptyList(), null, "en-US", null);
        assertNull(nothing.voice());
        assertEquals("", SpeechRules.trimmed(null));
        assertEquals("x", SpeechRules.trimmed("  x\t"));
    }

    /** TO SEE IT FAIL: pick by list order instead of the quality label, or accept a non-English Samantha. */
    @Test
    public void aSamanthaWinsWhenOneIsInstalled() {
        List<SpeechRules.VoiceOption> installed = Arrays.asList(
                new SpeechRules.VoiceOption("com.apple.Samantha-compact", "Samantha", "en-US", 1),
                new SpeechRules.VoiceOption("com.apple.Samantha-premium", "Samantha", "en-US", 3),
                new SpeechRules.VoiceOption("com.apple.Zoe-premium", "Zoe", "en-US", 3));
        assertEquals("com.apple.Samantha-premium", SpeechRules.defaultVoiceIdentifier(installed));
        assertEquals("com.apple.Samantha-premium", SpeechRules.narrationVoice(installed, null, "en-US", null).voice().identifier());
    }
}
