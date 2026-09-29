import Foundation
import ForayEngineCore

// ── THE SPEECH FAMILIES (card NE-33) ────────────────────────────────────────
//
//   - `default-voice`: player/default-voice.js, the founder's Samantha ruling
//     of 2026-09-10, against `SpeechRules` (pickDefaultVoice and its helpers);
//   - `lexicon`: foray-tts.js `buildIpaOverrides`, the pronunciation matcher,
//     against `SpeechRules.ipaOverrides`;
//   - `speech-rate`: what reaches the synthesiser (the text, the voice, 1x
//     whatever the listener's speed; OQ-3), through `EngineCore` with the
//     Foray tape on, as manager-foray's narration scenarios are driven, plus
//     `NARRATION_RATE` read from the generated constants.
//
// TRANSLATION ONLY, as in SeamGapFamily. The JS reads its arguments through
// `String(x || "")`, `typeof x === "string"` and `Array.isArray`; the helpers
// below are exactly those coercions, so a Swift rule is never handed a value
// the JS would have read differently.

public enum DefaultVoiceFamily {
    public static let module = "player/default-voice.js"

    public static let runner = PureFamilyRunner(
        family: "default-voice",
        module: DefaultVoiceFamily.module,
        reads: [
            "DEFAULT_VOICE_NAME": .string(SpeechRules.defaultVoiceName),
            "VOICE_LIST_LANG": .string(SpeechRules.voiceListLang)
        ],
        calls: [
            "qualityRank": { args in
                .returned(.number(Double(SpeechRules.qualityRank(label: SpeechCoercion.stringOr(args.first)))))
            },
            "primarySubtag": { args in
                // `typeof language !== "string"` -> "".
                guard let language = args.first?.stringValue else { return .returned(.string("")) }
                return .returned(.string(SpeechRules.primarySubtag(language)))
            },
            "isEnglish": { args in
                .returned(.bool(SpeechRules.isEnglish(args.first?.stringValue)))
            },
            "bestInstalledByName": { args in
                let voices = args.first ?? .undefined
                let name = args.count > 1 ? args[1] : .undefined
                // `!Array.isArray(voices) || !name` -> null.
                guard case let .array(entries) = voices, name.isTruthy,
                      let index = SpeechRules.bestInstalledIndex(named: SpeechCoercion.jsString(name),
                                                                 in: entries.map(SpeechCoercion.listedVoice)) else {
                    return .returned(.null)
                }
                return .returned(entries[index])
            },
            "pickDefaultVoice": { args in
                guard case let .array(entries)? = args.first else { return .returned(.null) }
                return .returned(SpeechRules.pickDefaultVoice(entries.map(SpeechCoercion.listedVoice)).map { JSValue.string($0) } ?? .null)
            }
        ])
}

public enum LexiconFamily {
    public static let module = "mobile/plugins/foray-tts/web/foray-tts.js"

    public static let runner = PureFamilyRunner(
        family: "lexicon",
        module: LexiconFamily.module,
        reads: [:],
        calls: [
            "buildIpaOverrides": { args in
                guard let text = args.first?.stringValue else {
                    throw HarnessError("E_BAD_CASE", "buildIpaOverrides takes a string text")
                }
                // `lexiconEntries = []`, and `!entry || !entry.term` is skipped.
                var given: [JSValue] = []
                if args.count > 1, case let .array(items) = args[1] { given = items }
                let entries: [SpeechRules.LexiconEntry] = given.compactMap { entry in
                    guard entry.isTruthy, entry["term"].isTruthy, let term = entry["term"].stringValue else { return nil }
                    // `entry.ipa ?? null`, then `m.ipa != null`.
                    return SpeechRules.LexiconEntry(term: term, ipa: entry["ipa"].isNullish ? nil : entry["ipa"].stringValue)
                }
                return .returned(.array(SpeechRules.ipaOverrides(text, entries: entries).map { override in
                    .object([
                        "term": .string(override.term),
                        "ipa": .string(override.ipa),
                        "start": .number(Double(override.start)),
                        "end": .number(Double(override.end))
                    ])
                }))
            }
        ])
}

public enum SpeechRateFamily {
    public static let runner = makeRunner()

    public static func makeRunner(mutation: EngineScenarioDriver.Mutation? = nil) -> FamilyRunner {
        SpeechRateRunner(
            reads: PureFamilyRunner(family: "speech-rate", module: "player/queue-manager.js",
                                    reads: ["NARRATION_RATE": .number(EngineConstants.QueueManager.narrationRate)],
                                    calls: [:]),
            scenarios: ForayTapeRunner(family: "speech-rate", targets: ["manager"],
                                       driver: EngineScenarioDriver(mutation: mutation, forayTape: true)))
    }
}

/// `constants.json` reads `NARRATION_RATE` from queue-manager.js;
/// `speak.json` is the manager's scenarios. Each kind goes to its own runner.
struct SpeechRateRunner: FamilyRunner {
    let reads: PureFamilyRunner
    let scenarios: ForayTapeRunner
    var family: String { "speech-rate" }

    func run(_ testCase: FixtureCase, in file: FixtureFile, context: Codec.Context) throws -> JSONValue {
        if testCase.kind == .scenario {
            return try scenarios.run(testCase, in: file, context: context)
        }
        return try reads.run(testCase, in: file, context: context)
    }
}

enum SpeechCoercion {
    /// `String(value)` for the values a fixture can hold.
    static func jsString(_ value: JSValue) -> String {
        switch value {
        case .undefined: return "undefined"
        case .null: return "null"
        case let .bool(flag): return flag ? "true" : "false"
        case let .number(number): return JSNumber.string(number)
        case let .string(text): return text
        case let .array(items):
            return items.map { $0.isNullish ? "" : jsString($0) }.joined(separator: ",")
        case .object: return "[object Object]"
        }
    }

    /// `String(value || "")`, as a Swift optional the rule reads as "".
    static func stringOr(_ value: JSValue?) -> String? {
        guard let value, value.isTruthy else { return nil }
        return jsString(value)
    }

    /// One `listVoices()` entry as default-voice.js reads it, or nil for an
    /// entry it skips (`!v || typeof v.identifier !== "string" || !v.identifier`).
    static func listedVoice(_ value: JSValue) -> SpeechRules.ListedVoice? {
        guard value.isTruthy, let identifier = value["identifier"].stringValue, !identifier.isEmpty else { return nil }
        return SpeechRules.ListedVoice(identifier: identifier,
                                       name: stringOr(value["name"]) ?? "",
                                       language: value["language"].stringValue,
                                       quality: stringOr(value["quality"]))
    }
}
