package ai.jwlabs.foura.engine.parity;

import static ai.jwlabs.foura.engine.parity.JsArgs.arg;
import static ai.jwlabs.foura.engine.parity.JsArgs.at;
import static ai.jwlabs.foura.engine.parity.JsArgs.truthy;

import ai.jwlabs.foura.engine.EngineConstants;
import ai.jwlabs.foura.engine.JSWriter;
import ai.jwlabs.foura.engine.SpeechRules;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Call;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Returned;
import ai.jwlabs.foura.engine.parity.ParityData.FixtureCase;
import ai.jwlabs.foura.engine.parity.ParityData.FixtureFile;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * THE SPEECH FAMILIES (card A-41), the JVM twins of the Swift SpeechFamilies (NE-33):
 * <ul>
 *   <li>{@code default-voice}: player/default-voice.js, the founder's Samantha ruling of
 *       2026-09-10, against {@link SpeechRules} (pickDefaultVoice and its helpers);</li>
 *   <li>{@code lexicon}: foray-tts.js {@code buildIpaOverrides}, the pronunciation matcher, against
 *       {@link SpeechRules#ipaOverrides};</li>
 *   <li>{@code speech-rate}: what reaches the synthesiser (the text, the voice, 1x whatever the
 *       listener's speed; OQ-3) through {@code EngineCore} with the Foray tape on, as manager-foray's
 *       narration scenarios are driven, plus {@code NARRATION_RATE} read from the generated
 *       constants.</li>
 * </ul>
 *
 * <p>TRANSLATION ONLY, as in {@link ForayFamilies}. The JS reads its arguments through
 * {@code String(x || "")}, {@code typeof x === "string"} and {@code Array.isArray}; the helpers below
 * are exactly those coercions, so a JVM rule is never handed a value the JS would have read
 * differently.
 */
final class SpeechFamilies {
    private SpeechFamilies() {}

    static final String DEFAULT_VOICE_MODULE = "player/default-voice.js";
    static final String LEXICON_MODULE = "mobile/plugins/foray-tts/web/foray-tts.js";
    static final String QUEUE_MANAGER_MODULE = "player/queue-manager.js";

    // ---- default-voice (player/default-voice.js)

    static FamilyRunner defaultVoice() {
        Map<String, Json> reads = new LinkedHashMap<>();
        reads.put("DEFAULT_VOICE_NAME", Json.str(SpeechRules.DEFAULT_VOICE_NAME));
        reads.put("VOICE_LIST_LANG", Json.str(SpeechRules.VOICE_LIST_LANG));
        Map<String, Call> calls = new LinkedHashMap<>();
        // `String(label || "").toLowerCase()`.
        calls.put("qualityRank", args -> new Returned(Json.num(SpeechRules.qualityRank(stringOr(arg(args, 0))))));
        // `typeof language !== "string"` -> "".
        calls.put("primarySubtag", args -> {
            String language = arg(args, 0).asString();
            return new Returned(Json.str(language == null ? "" : SpeechRules.primarySubtag(language)));
        });
        calls.put("isEnglish", args -> new Returned(Json.bool(SpeechRules.isEnglish(arg(args, 0).asString()))));
        calls.put("bestInstalledByName", args -> {
            List<Json> entries = arg(args, 0).asList();
            Json name = arg(args, 1);
            // `!Array.isArray(voices) || !name` -> null.
            if (entries == null || !truthy(name)) return new Returned(Json.NULL);
            Integer index = SpeechRules.bestInstalledIndex(jsString(name), listed(entries));
            return new Returned(index == null ? Json.NULL : entries.get(index));
        });
        calls.put("pickDefaultVoice", args -> {
            List<Json> entries = arg(args, 0).asList();
            if (entries == null) return new Returned(Json.NULL);
            String picked = SpeechRules.pickDefaultVoice(listed(entries));
            return new Returned(picked == null ? Json.NULL : Json.str(picked));
        });
        return new FamilyRunner.Pure("default-voice", DEFAULT_VOICE_MODULE, reads, calls);
    }

    // ---- lexicon (foray-tts.js buildIpaOverrides)

    static FamilyRunner lexicon() {
        Map<String, Call> calls = new LinkedHashMap<>();
        calls.put("buildIpaOverrides", args -> {
            String text = arg(args, 0).asString();
            if (text == null) throw new HarnessError("E_BAD_CASE", "buildIpaOverrides takes a string text");
            // `lexiconEntries = []`, and `!entry || !entry.term` is skipped.
            List<Json> given = arg(args, 1).asList();
            List<SpeechRules.LexiconEntry> entries = new ArrayList<>();
            if (given != null) {
                for (Json entry : given) {
                    if (!truthy(entry) || !truthy(at(entry, "term"))) continue;
                    String term = at(entry, "term").asString();
                    if (term == null) continue;
                    // `entry.ipa ?? null`, then `m.ipa != null`.
                    Json ipa = at(entry, "ipa");
                    entries.add(new SpeechRules.LexiconEntry(term, JsArgs.isNullish(ipa) ? null : ipa.asString()));
                }
            }
            List<Json> out = new ArrayList<>();
            for (SpeechRules.IpaOverride o : SpeechRules.ipaOverrides(text, entries)) {
                out.add(JsArgs.obj("term", Json.str(o.term()), "ipa", Json.str(o.ipa()), "start", Json.num(o.start()),
                        "end", Json.num(o.end())));
            }
            return new Returned(new Json.Arr(out));
        });
        return new FamilyRunner.Pure("lexicon", LEXICON_MODULE, Map.<String, Json>of(), calls);
    }

    // ---- speech-rate (queue-manager.js NARRATION_RATE, and the manager's scenarios)

    static FamilyRunner speechRate(EngineScenarioDriver.Mutation mutation) {
        FamilyRunner.Pure reads = new FamilyRunner.Pure("speech-rate", QUEUE_MANAGER_MODULE,
                Map.of("NARRATION_RATE", Json.num(EngineConstants.QueueManager.NARRATION_RATE)), Map.<String, Call>of());
        FamilyRunner scenarios = new ForayTapeFamilies.TapeRunner("speech-rate", List.of("manager"),
                new EngineScenarioDriver(mutation, true));
        return new SpeechRateRunner(reads, scenarios);
    }

    static FamilyRunner speechRate() {
        return speechRate(null);
    }

    /** {@code constants.json} reads {@code NARRATION_RATE}; {@code speak.json} is the manager's scenarios. */
    record SpeechRateRunner(FamilyRunner.Pure reads, FamilyRunner scenarios) implements FamilyRunner {
        @Override
        public String family() {
            return "speech-rate";
        }

        @Override
        public Json run(FixtureCase testCase, FixtureFile file, Codec.Context context) {
            return "scenario".equals(testCase.kind()) ? scenarios.run(testCase, file, context) : reads.run(testCase, file, context);
        }
    }

    // ---- the coercions

    /** {@code String(value)} for the values a fixture can hold. */
    static String jsString(Json value) {
        return switch (value) {
            case Json.Undefined u -> "undefined";
            case Json.Null n -> "null";
            case Json.Bool b -> b.value() ? "true" : "false";
            case Json.Num n -> Double.isNaN(n.value()) ? "NaN"
                    : Double.isInfinite(n.value()) ? (n.value() > 0 ? "Infinity" : "-Infinity") : JSWriter.numberToString(n.value());
            case Json.Str s -> s.value();
            case Json.Arr a -> {
                List<String> parts = new ArrayList<>();
                for (Json item : a.items()) parts.add(JsArgs.isNullish(item) ? "" : jsString(item));
                yield String.join(",", parts);
            }
            case Json.Obj o -> "[object Object]";
        };
    }

    /** {@code String(value || "")}, as null for the "" the rule reads. */
    static String stringOr(Json value) {
        return truthy(value) ? jsString(value) : null;
    }

    /**
     * One {@code listVoices()} entry as default-voice.js reads it, or null for an entry it skips
     * ({@code !v || typeof v.identifier !== "string" || !v.identifier}).
     */
    static SpeechRules.ListedVoice listedVoice(Json value) {
        if (!truthy(value)) return null;
        String identifier = at(value, "identifier").asString();
        if (identifier == null || identifier.isEmpty()) return null;
        String name = stringOr(at(value, "name"));
        return new SpeechRules.ListedVoice(identifier, name == null ? "" : name, at(value, "language").asString(),
                stringOr(at(value, "quality")));
    }

    static List<SpeechRules.ListedVoice> listed(List<Json> entries) {
        List<SpeechRules.ListedVoice> out = new ArrayList<>();
        for (Json entry : entries) out.add(listedVoice(entry));
        return out;
    }
}
