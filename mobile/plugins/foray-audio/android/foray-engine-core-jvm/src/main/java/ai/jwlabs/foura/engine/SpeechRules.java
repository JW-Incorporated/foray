package ai.jwlabs.foura.engine;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * SPEECH RULES: WHICH VOICE, AND HOW A HARD TERM IS SAID (card A-41, docs/plans/android-assessment.md
 * §5.5). The JVM twin of {@code SpeechRules} in ForayEngineCore (Policy/SpeechRules.swift, NE-33),
 * rule for rule, so the Android engine's narrator speaks in the voice and with the pronunciations the
 * iOS engine and the page would:
 * <ul>
 *   <li>the installed-voice rules ({@link #candidates}: the exact locale first and alone;
 *       {@link #bestVoice}: the highest quality tier, ties toward the voice the system would have used,
 *       then the lowest identifier; {@link #resolveVoice}: a requested identifier, else the best tier,
 *       saying when it fell back; {@link #sortedForListing}; {@link #qualityLabel});</li>
 *   <li>the default voice, player/default-voice.js (the founder's 2026-09-10 ruling, Samantha):
 *       {@link #pickDefaultVoice} and the helpers it is built from. The parity family
 *       {@code default-voice} runs these against the JS module's recorded answers;</li>
 *   <li>the pronunciation lexicon's matcher, foray-tts.js {@code buildIpaOverrides}
 *       ({@link #ipaOverrides}). The parity family {@code lexicon} runs it against the JS answers.</li>
 * </ul>
 *
 * <p>ANDROID'S VOICES. An Android {@code Voice} has a name (its identifier), a locale and a quality
 * int ({@code QUALITY_VERY_LOW} 100 .. {@code QUALITY_VERY_HIGH} 500), so the host hands
 * {@link VoiceOption}s whose {@code qualityRank} is that int: the rules only ever compare ranks, so the
 * scale does not matter to them. No Android voice is called Samantha, so on Android the default rule
 * finds none and the synthesiser's own best pick speaks, exactly as default-voice.js decides on a
 * phone with no Samantha; the rule is still ported, so the day a Samantha is installed it wins here as
 * it would on the page.
 *
 * <p>Pure JVM (java.util only): no Android type reaches this module.
 */
public final class SpeechRules {
    private SpeechRules() {}

    // ---- the installed-voice rules (ForayTtsPlugin, PR #491)

    /** One installed voice, reduced to the four things selection cares about. */
    public record VoiceOption(String identifier, String name, String language, int qualityRank) {
        public VoiceOption {
            Objects.requireNonNull(identifier, "identifier");
            Objects.requireNonNull(name, "name");
            Objects.requireNonNull(language, "language");
        }
    }

    /**
     * {@code 1} -> "default", {@code 2} -> "enhanced", {@code 3} -> "premium" (iOS's tiers). Anything
     * else is "unknown" rather than a guess.
     */
    public static String qualityLabel(int rank) {
        return switch (rank) {
            case 1 -> "default";
            case 2 -> "enhanced";
            case 3 -> "premium";
            default -> "unknown";
        };
    }

    /** The primary subtag of a language tag, lowercased: {@code en-US} -> {@code en}, {@code en_GB} -> {@code en}. */
    public static String primarySubtag(String tag) {
        String lowered = lower(tag);
        for (int i = 0; i < lowered.length(); i++) {
            char c = lowered.charAt(i);
            if (c == '-' || c == '_') return lowered.substring(0, i);
        }
        return lowered;
    }

    /**
     * Voices eligible for {@code language}, EXACT MATCHES FIRST AND ALONE when there are any; only
     * when the exact locale has nothing does this widen to the primary subtag.
     */
    public static List<VoiceOption> candidates(List<VoiceOption> all, String language) {
        List<VoiceOption> out = new ArrayList<>();
        if (language == null || language.isEmpty()) return out;
        String wanted = lower(language);
        for (VoiceOption v : all) if (lower(v.language()).equals(wanted)) out.add(v);
        if (!out.isEmpty()) return out;
        String primary = primarySubtag(language);
        for (VoiceOption v : all) if (primarySubtag(v.language()).equals(primary)) out.add(v);
        return out;
    }

    /**
     * The best INSTALLED voice for {@code language}: the highest {@code qualityRank}; ties to
     * {@code preferringName} (the voice the system would have used), then the lowest identifier.
     */
    public static VoiceOption bestVoice(List<VoiceOption> all, String language, String preferringName) {
        List<VoiceOption> pool = candidates(all, language);
        if (pool.isEmpty()) return null;
        int top = Integer.MIN_VALUE;
        for (VoiceOption v : pool) top = Math.max(top, v.qualityRank());
        List<VoiceOption> best = new ArrayList<>();
        for (VoiceOption v : pool) if (v.qualityRank() == top) best.add(v);
        if (preferringName != null && !preferringName.isEmpty()) {
            String wanted = lower(preferringName);
            VoiceOption familiar = null;
            for (VoiceOption v : best) {
                if (lower(v.name()).equals(wanted) && (familiar == null || v.identifier().compareTo(familiar.identifier()) < 0)) familiar = v;
            }
            if (familiar != null) return familiar;
        }
        VoiceOption lowest = null;
        for (VoiceOption v : best) if (lowest == null || v.identifier().compareTo(lowest.identifier()) < 0) lowest = v;
        return lowest;
    }

    /**
     * What was decided for one utterance, INCLUDING why. {@code requested} is "" when none was asked
     * for; {@code didFallBack} is the engine's {@code voiceFallback}.
     */
    public record VoiceResolution(VoiceOption voice, String requested, boolean didFallBack, String reason) {}

    /** Resolve the voice for one utterance. An identifier that is not installed degrades to {@link #bestVoice}, and says so. */
    public static VoiceResolution resolveVoice(List<VoiceOption> all, String requested, String language, String preferringName) {
        String asked = trimmed(requested);
        VoiceOption best = bestVoice(all, language, preferringName);
        if (!asked.isEmpty()) {
            for (VoiceOption v : all) {
                if (v.identifier().equals(asked)) return new VoiceResolution(v, asked, false, "");
            }
            if (best != null) return new VoiceResolution(best, asked, true, "requested voice is not installed on this device");
            return new VoiceResolution(null, asked, true, "requested voice is not installed, and no voice is installed for " + language);
        }
        if (best != null) return new VoiceResolution(best, "", false, "");
        return new VoiceResolution(null, "", false, "no installed voice for " + language);
    }

    /** Listing order: language, then BEST QUALITY FIRST, then name, then identifier. */
    public static List<VoiceOption> sortedForListing(List<VoiceOption> voices) {
        List<VoiceOption> out = new ArrayList<>(voices);
        out.sort((a, b) -> {
            int byLanguage = a.language().compareTo(b.language());
            if (byLanguage != 0) return byLanguage;
            if (a.qualityRank() != b.qualityRank()) return Integer.compare(b.qualityRank(), a.qualityRank());
            int byName = a.name().compareTo(b.name());
            return byName != 0 ? byName : a.identifier().compareTo(b.identifier());
        });
        return out;
    }

    // ---- the default voice (player/default-voice.js, founder 2026-09-10)

    /** {@code DEFAULT_VOICE_NAME}. */
    public static final String DEFAULT_VOICE_NAME = "Samantha";

    /** {@code VOICE_LIST_LANG}: a bare primary subtag, so the list widens to every {@code en-*}. */
    public static final String VOICE_LIST_LANG = "en";

    /**
     * One entry of a {@code listVoices()} result as default-voice.js reads it. {@code language} is null
     * when it is not a string; {@code quality} is the LABEL.
     */
    public record ListedVoice(String identifier, String name, String language, String quality) {
        public ListedVoice {
            Objects.requireNonNull(identifier, "identifier");
            Objects.requireNonNull(name, "name");
        }
    }

    /**
     * {@code qualityRank(label)}: unknown labels rank between {@code default} and {@code low}, so an
     * unexpected tier is neither promoted nor buried.
     */
    public static int qualityRank(String label) {
        return switch (lower(label == null ? "" : label)) {
            case "premium", "very-high" -> 5;
            case "enhanced", "high" -> 4;
            case "default", "normal" -> 3;
            case "low" -> 1;
            case "very-low" -> 0;
            default -> 2;
        };
    }

    /** {@code isEnglish(language)}: BCP-47 {@code en-*} and ISO-639-2 {@code eng-*}. A missing language is not English. */
    public static boolean isEnglish(String language) {
        if (language == null) return false;
        String primary = primarySubtag(language);
        return primary.equals("en") || primary.equals("eng");
    }

    /**
     * {@code bestInstalledByName(voices, name)}, as the POSITION of the answer in {@code voices} (null
     * entries are the ones default-voice.js skips). Case-insensitive name, English only, the best
     * quality label, ties to the FIRST listed.
     */
    public static Integer bestInstalledIndex(String name, List<ListedVoice> voices) {
        if (name == null || name.isEmpty()) return null;
        String wanted = lower(name);
        Integer best = null;
        for (int i = 0; i < voices.size(); i++) {
            ListedVoice voice = voices.get(i);
            if (voice == null || voice.identifier().isEmpty()) continue;
            if (!lower(voice.name()).equals(wanted)) continue;
            if (!isEnglish(voice.language())) continue;
            if (best != null && voices.get(best) != null) {
                if (qualityRank(voice.quality()) > qualityRank(voices.get(best).quality())) best = i;
            } else {
                best = i;
            }
        }
        return best;
    }

    /** {@code pickDefaultVoice(voices)}: Samantha's best installed tier, or null ("the synthesiser's own pick"). */
    public static String pickDefaultVoice(List<ListedVoice> voices) {
        Integer index = bestInstalledIndex(DEFAULT_VOICE_NAME, voices);
        if (index == null) return null;
        ListedVoice voice = voices.get(index);
        return voice == null ? null : voice.identifier();
    }

    /** An installed voice as {@code listVoices()} reports it to the page. */
    public static ListedVoice listed(VoiceOption voice) {
        return new ListedVoice(voice.identifier(), voice.name(), voice.language(), qualityLabel(voice.qualityRank()));
    }

    /**
     * The default identifier on THIS device, computed the way the page computes it:
     * {@code listVoices({lang: VOICE_LIST_LANG})} in listing order, then {@link #pickDefaultVoice}.
     */
    public static String defaultVoiceIdentifier(List<VoiceOption> installed) {
        List<ListedVoice> list = new ArrayList<>();
        for (VoiceOption v : sortedForListing(candidates(installed, VOICE_LIST_LANG))) list.add(listed(v));
        return pickDefaultVoice(list);
    }

    /**
     * The voice a line of narration (or an audition) is spoken in: the asked-for voice (or
     * {@link #resolveVoice}'s fallback, reported as one); with none asked, the DEFAULT RULE first, and
     * only with no Samantha installed the synthesiser's own pick ({@link #bestVoice}).
     */
    public static VoiceResolution narrationVoice(List<VoiceOption> installed, String requested, String language, String preferringName) {
        String asked = trimmed(requested);
        if (asked.isEmpty()) {
            String identifier = defaultVoiceIdentifier(installed);
            if (identifier != null) {
                for (VoiceOption v : installed) {
                    if (v.identifier().equals(identifier)) return new VoiceResolution(v, "", false, "");
                }
            }
        }
        return resolveVoice(installed, requested, language, preferringName);
    }

    // ---- the pronunciation lexicon (foray-tts.js buildIpaOverrides)

    /** One lexicon entry ({@code lexicon/hard-terms.json}): the surface form and its IPA once authored (null until then). */
    public record LexiconEntry(String term, String ipa) {}

    /** One override: {@code text[start, end)} (UTF-16 offsets, as a JavaScript index counts) is said as {@code ipa}. */
    public record IpaOverride(String term, String ipa, int start, int end) {}

    /**
     * {@code buildIpaOverrides(text, entries)}: every case-insensitive match of an entry's term on a
     * word boundary (a letter, a digit or an apostrophe on either side means it is inside a longer
     * word), ONE MATCH PER STRETCH OF TEXT (foray-tts.js {@code findMatches}): earliest first, the
     * LONGEST at a given start, entry order on a tie (a stable sort), and a match that starts inside a
     * kept one is dropped. Only then are entries with no authored {@code ipa} filtered out: a term with
     * {@code ipa: null} produces NO override, but it still claims its stretch, exactly as in the JS.
     */
    public static List<IpaOverride> ipaOverrides(String text, List<LexiconEntry> entries) {
        record Found(int order, String term, String ipa, int start, int end) {}
        List<Found> found = new ArrayList<>();
        for (LexiconEntry entry : entries) {
            if (entry == null || entry.term() == null || entry.term().isEmpty()) continue;
            Pattern pattern = Pattern.compile("(?<![\\p{L}\\p{N}'])" + Pattern.quote(entry.term()) + "(?![\\p{L}\\p{N}'])",
                    Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
            Matcher m = pattern.matcher(text);
            while (m.find()) {
                if (m.end() == m.start()) continue;
                found.add(new Found(found.size(), entry.term(), entry.ipa(), m.start(), m.end()));
            }
        }
        found.sort((a, b) -> {
            if (a.start() != b.start()) return Integer.compare(a.start(), b.start());
            int la = a.end() - a.start();
            int lb = b.end() - b.start();
            return la != lb ? Integer.compare(lb, la) : Integer.compare(a.order(), b.order());
        });
        List<IpaOverride> kept = new ArrayList<>();
        int cursor = 0;
        for (Found f : found) {
            if (f.start() < cursor) continue;
            cursor = f.end();
            if (f.ipa() != null) kept.add(new IpaOverride(f.term(), f.ipa(), f.start(), f.end()));
        }
        return Collections.unmodifiableList(kept);
    }

    /**
     * foray-tts.js {@code buildAndroidSsml(text, entries)}: the terms with an authored IPA wrapped in
     * {@code <phoneme alphabet="ipa" ph="...">}, everything else plain and XML-escaped, inside
     * {@code <speak>}; null when there is nothing to mark up (the caller speaks the plain text). Android
     * documents no phoneme attribute, so this is the legacy lane's best effort, carried unchanged.
     */
    public static String androidSsml(String text, List<LexiconEntry> entries) {
        List<IpaOverride> overrides = ipaOverrides(text, entries);
        if (overrides.isEmpty()) return null;
        StringBuilder out = new StringBuilder("<speak>");
        int cursor = 0;
        for (IpaOverride o : overrides) {
            out.append(escapeXml(text.substring(cursor, o.start())));
            out.append("<phoneme alphabet=\"ipa\" ph=\"").append(escapeXml(o.ipa())).append("\">")
                    .append(escapeXml(text.substring(o.start(), o.end()))).append("</phoneme>");
            cursor = o.end();
        }
        out.append(escapeXml(text.substring(cursor)));
        return out.append("</speak>").toString();
    }

    /** foray-tts.js's {@code esc}: {@code &}, {@code <} and {@code >} only. */
    static String escapeXml(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    /**
     * Swift's {@code trimmingCharacters(in: .whitespacesAndNewlines)} of a requested identifier, or ""
     * for none (not {@code String.strip}, which is API 33, above this app's minSdk 24).
     */
    static String trimmed(String s) {
        if (s == null) return "";
        int start = 0;
        int end = s.length();
        while (start < end && isSpace(s.charAt(start))) start++;
        while (end > start && isSpace(s.charAt(end - 1))) end--;
        return s.substring(start, end);
    }

    private static boolean isSpace(char c) {
        return Character.isWhitespace(c) || Character.isSpaceChar(c);
    }

    /** {@code String.prototype.toLowerCase}, locale-independent. */
    private static String lower(String s) {
        return s.toLowerCase(Locale.ROOT);
    }
}
