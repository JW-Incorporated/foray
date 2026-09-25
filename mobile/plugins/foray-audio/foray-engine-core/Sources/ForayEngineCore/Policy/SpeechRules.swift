import Foundation

// ── SPEECH RULES: WHICH VOICE, AND HOW A HARD TERM IS SAID (card NE-33) ─────
//
// ONE FILE, TWO PACKAGES, BYTE-IDENTICAL. This file is
//   mobile/plugins/foray-audio/foray-engine-core/Sources/ForayEngineCore/Policy/SpeechRules.swift
// and, byte for byte, the legacy plugin's copy
//   mobile/plugins/foray-tts/ios/Sources/ForayTtsPlugin/SpeechRules.swift
// `foray-tts` is a separate SwiftPM package that cannot see a type in
// `foray-audio` (docs/native-engine-plan.md §2), so the shared code is copied,
// and tools/mobile/shell-invariants.test.mjs fails the moment the two copies
// differ by one byte. Edit both, or neither. Foundation only: it builds in the
// core (Linux, the `swift:5.10` parity job) and in the plugin alike.
//
// WHAT IS HERE, AND WHERE EACH RULE CAME FROM
//
//   - The installed-voice rules the legacy plugin has shipped since PR #491:
//     `candidates` (the exact locale first and alone), `bestVoice` (highest
//     quality tier, ties toward the voice the system would have used, then the
//     lowest identifier), `resolveVoice` (a requested identifier, else the
//     best tier, saying when it fell back), `sortedForListing`,
//     `qualityLabel`. Moved here from ForayTtsPlugin.swift unchanged; the
//     plugin's own statics now call these, so its legacy tests pin them.
//   - The default voice, player/default-voice.js (the founder's 2026-09-10
//     ruling: "Samantha was the least worst so let's go with that for now"):
//     `pickDefaultVoice` and the helpers it is built from. The parity family
//     `default-voice` runs these against the JS module's recorded answers.
//   - The pronunciation lexicon's matcher, foray-tts.js `buildIpaOverrides`
//     (case-insensitive, on a word boundary, an apostrophe counting as part
//     of a word, sorted by position, only entries with an authored `ipa`).
//     The parity family `lexicon` runs it against the JS answers.
//
// The engine (SpeechNarrator) uses all three for every line it speaks:
// `narrationVoice` for the voice, `ipaOverrides` for the hard terms.
public enum SpeechRules {

    // MARK: - The installed-voice rules (ForayTtsPlugin, PR #491)

    /// One installed voice, reduced to the four things selection cares about.
    /// `qualityRank` is `AVSpeechSynthesisVoiceQuality.rawValue`: the raw
    /// integer rather than the enum, because `.premium` is iOS 16+ and ranking
    /// by rawValue needs no availability check and cannot go stale if Apple
    /// appends a further tier above premium.
    public struct VoiceOption: Equatable {
        public let identifier: String
        public let name: String
        public let language: String
        public let qualityRank: Int

        public init(identifier: String, name: String, language: String, qualityRank: Int) {
            self.identifier = identifier
            self.name = name
            self.language = language
            self.qualityRank = qualityRank
        }
    }

    /// `1` -> "default", `2` -> "enhanced", `3` -> "premium". Anything else is
    /// reported as "unknown" rather than guessed: a future tier still SORTS
    /// correctly (rank is numeric) and is merely unlabelled.
    public static func qualityLabel(rank: Int) -> String {
        switch rank {
        case 1: return "default"
        case 2: return "enhanced"
        case 3: return "premium"
        default: return "unknown"
        }
    }

    /// The primary subtag of a language tag, lowercased: `en-US` -> `en`,
    /// `en_GB` -> `en`, `eng-USA` -> `eng` (default-voice.js `primarySubtag`
    /// splits on the same two characters).
    public static func primarySubtag(_ tag: String) -> String {
        let lowered = tag.lowercased()
        if let cut = lowered.firstIndex(where: { $0 == "-" || $0 == "_" }) {
            return String(lowered[lowered.startIndex..<cut])
        }
        return lowered
    }

    /// Voices eligible for `language`, EXACT MATCHES FIRST AND ALONE when
    /// there are any. Only when the exact locale has nothing installed does
    /// this widen to the primary subtag: asking for `en-US` on a device that
    /// only carries `en-GB` should get a British voice rather than silence,
    /// but never while an American voice exists.
    public static func candidates(_ all: [VoiceOption], language: String) -> [VoiceOption] {
        guard !language.isEmpty else { return [] }
        let wanted = language.lowercased()
        let exact = all.filter { $0.language.lowercased() == wanted }
        if !exact.isEmpty { return exact }
        let primary = primarySubtag(language)
        return all.filter { primarySubtag($0.language) == primary }
    }

    /// The best INSTALLED voice for `language`: highest `qualityRank` wins.
    /// Ties go to `preferringName` (the voice the system would have used
    /// anyway), so a device with both tiers of a familiar voice upgrades it
    /// rather than swapping in a stranger; remaining ties fall to the lowest
    /// identifier, so the answer never depends on the catalogue's order.
    public static func bestVoice(among all: [VoiceOption], language: String, preferringName: String?) -> VoiceOption? {
        let pool = candidates(all, language: language)
        guard let topRank = pool.map(\.qualityRank).max() else { return nil }
        let top = pool.filter { $0.qualityRank == topRank }
        if let wanted = preferringName?.lowercased(), !wanted.isEmpty,
           let familiar = top.filter({ $0.name.lowercased() == wanted }).min(by: { $0.identifier < $1.identifier }) {
            return familiar
        }
        return top.min(by: { $0.identifier < $1.identifier })
    }

    /// What was decided for one utterance, INCLUDING why, so a listening test
    /// can tell "this voice sounds bad" from "this voice was never installed".
    public struct VoiceResolution: Equatable {
        public let voice: VoiceOption?
        /// The identifier the caller asked for, `""` if none.
        public let requested: String
        /// True when a specific identifier was asked for and something else
        /// (or nothing) was used instead: the engine's `voiceFallback`.
        public let didFallBack: Bool
        public let reason: String

        public init(voice: VoiceOption?, requested: String, didFallBack: Bool, reason: String) {
            self.voice = voice
            self.requested = requested
            self.didFallBack = didFallBack
            self.reason = reason
        }
    }

    /// Resolve the voice for one utterance. An identifier that is not
    /// installed is NOT an error: it degrades to `bestVoice`, and says so.
    public static func resolveVoice(
        among all: [VoiceOption],
        requested: String?,
        language: String,
        preferringName: String?
    ) -> VoiceResolution {
        let asked = requested?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let best = bestVoice(among: all, language: language, preferringName: preferringName)

        if !asked.isEmpty {
            if let exact = all.first(where: { $0.identifier == asked }) {
                return VoiceResolution(voice: exact, requested: asked, didFallBack: false, reason: "")
            }
            if let best = best {
                return VoiceResolution(
                    voice: best,
                    requested: asked,
                    didFallBack: true,
                    reason: "requested voice is not installed on this device"
                )
            }
            return VoiceResolution(
                voice: nil,
                requested: asked,
                didFallBack: true,
                reason: "requested voice is not installed, and no voice is installed for \(language)"
            )
        }

        if let best = best {
            return VoiceResolution(voice: best, requested: "", didFallBack: false, reason: "")
        }
        return VoiceResolution(
            voice: nil,
            requested: "",
            didFallBack: false,
            reason: "no installed voice for \(language)"
        )
    }

    /// Listing order: language, then BEST QUALITY FIRST within a language,
    /// then name, then identifier.
    public static func sortedForListing(_ voices: [VoiceOption]) -> [VoiceOption] {
        voices.sorted {
            if $0.language != $1.language { return $0.language < $1.language }
            if $0.qualityRank != $1.qualityRank { return $0.qualityRank > $1.qualityRank }
            if $0.name != $1.name { return $0.name < $1.name }
            return $0.identifier < $1.identifier
        }
    }

    // MARK: - The default voice (player/default-voice.js, founder 2026-09-10)

    /// `DEFAULT_VOICE_NAME`: the voice whose best installed tier is the
    /// default. A name, not an identifier: the identifier differs by tier and
    /// by iOS version, and the rule follows the best one the device has.
    public static let defaultVoiceName = "Samantha"

    /// `VOICE_LIST_LANG`: the `lang` the page passes to `listVoices()` before
    /// it picks. A bare primary subtag, so the list widens to every `en-*`.
    public static let voiceListLang = "en"

    /// One entry of a `listVoices()` result as default-voice.js reads it:
    /// the identifier, the name, the language (nil when it is not a string)
    /// and the `quality` LABEL (`premium`, `enhanced`, `default`; Android's
    /// five; Web Speech's `unknown`).
    public struct ListedVoice: Equatable {
        public let identifier: String
        public let name: String
        public let language: String?
        public let quality: String?

        public init(identifier: String, name: String, language: String?, quality: String?) {
            self.identifier = identifier
            self.name = name
            self.language = language
            self.quality = quality
        }
    }

    /// `qualityRank(label)`: rank a `quality` label so two installs of the
    /// SAME name can be compared. Unknown labels rank between `default` and
    /// `low`: an unexpected new tier is neither promoted nor buried.
    public static func qualityRank(label: String?) -> Int {
        switch (label ?? "").lowercased() {
        case "premium", "very-high": return 5
        case "enhanced", "high": return 4
        case "default", "normal": return 3
        case "low": return 1
        case "very-low": return 0
        default: return 2
        }
    }

    /// `isEnglish(language)`: BCP-47 `en-*` and the ISO-639-2 `eng-*` some
    /// Android engines report. A missing language is not English.
    public static func isEnglish(_ language: String?) -> Bool {
        guard let language else { return false }
        let primary = primarySubtag(language)
        return primary == "en" || primary == "eng"
    }

    /// `bestInstalledByName(voices, name)`, as the POSITION of the answer in
    /// `voices` (so a caller holding richer entries can hand back its own).
    /// A nil entry is one default-voice.js skips (not an object, or no
    /// non-empty string identifier). The name matches case-insensitively,
    /// non-English entries are skipped even when the name matches (Eloquence
    /// ships the same names across locales), and ties go to the FIRST listed.
    public static func bestInstalledIndex(named name: String, in voices: [ListedVoice?]) -> Int? {
        guard !name.isEmpty else { return nil }
        let wanted = name.lowercased()
        var best: Int?
        for (index, entry) in voices.enumerated() {
            guard let voice = entry, !voice.identifier.isEmpty else { continue }
            if voice.name.lowercased() != wanted { continue }
            if !isEnglish(voice.language) { continue }
            if let current = best, let held = voices[current] {
                if qualityRank(label: voice.quality) > qualityRank(label: held.quality) { best = index }
            } else {
                best = index
            }
        }
        return best
    }

    /// `pickDefaultVoice(voices)`: THE DECISION. Samantha's best installed
    /// tier, or nil when no Samantha is installed, which means "the
    /// synthesiser's own pick" (`bestVoice`, #491's heuristic).
    public static func pickDefaultVoice(_ voices: [ListedVoice?]) -> String? {
        guard let index = bestInstalledIndex(named: defaultVoiceName, in: voices) else { return nil }
        return voices[index]?.identifier
    }

    /// An installed voice as `listVoices()` reports it to the page.
    public static func listed(_ voice: VoiceOption) -> ListedVoice {
        ListedVoice(identifier: voice.identifier, name: voice.name, language: voice.language,
                    quality: qualityLabel(rank: voice.qualityRank))
    }

    /// The default identifier on THIS device, computed the way the page
    /// computes it: `listVoices({ lang: VOICE_LIST_LANG })` (the candidates
    /// for `en`, in listing order, with their labels), then
    /// `pickDefaultVoice`. So a native cold start with no stored voice speaks
    /// in the voice the page would have picked.
    public static func defaultVoiceIdentifier(installed: [VoiceOption]) -> String? {
        let list = sortedForListing(candidates(installed, language: voiceListLang))
        return pickDefaultVoice(list.map { Optional(listed($0)) })
    }

    /// The voice a line of narration (or an audition) is spoken in.
    ///   - An identifier was asked for (the page's choice, or the restore
    ///     record's `voiceId` on a cold path): that voice, or `resolveVoice`'s
    ///     fallback, reported as one.
    ///   - None was: the DEFAULT RULE first (Samantha's best tier), and only
    ///     when no Samantha is installed the synthesiser's own pick
    ///     (`bestVoice`). Never `bestVoice` while a Samantha exists.
    public static func narrationVoice(
        among installed: [VoiceOption],
        requested: String?,
        language: String,
        preferringName: String?
    ) -> VoiceResolution {
        let asked = requested?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if asked.isEmpty, let identifier = defaultVoiceIdentifier(installed: installed),
           let voice = installed.first(where: { $0.identifier == identifier }) {
            return VoiceResolution(voice: voice, requested: "", didFallBack: false, reason: "")
        }
        return resolveVoice(among: installed, requested: requested, language: language, preferringName: preferringName)
    }

    // MARK: - The pronunciation lexicon (foray-tts.js buildIpaOverrides)

    /// One lexicon entry (`lexicon/hard-terms.json`): the surface form, and
    /// its IPA once authored and verified (nil until then).
    public struct LexiconEntry: Equatable {
        public let term: String
        public let ipa: String?

        public init(term: String, ipa: String?) {
            self.term = term
            self.ipa = ipa
        }
    }

    /// One override: `text[start..<end]` (UTF-16 offsets, which is what a
    /// JavaScript string index and an `NSRange` both count) is said as `ipa`.
    public struct IpaOverride: Equatable {
        public let term: String
        public let ipa: String
        public let start: Int
        public let end: Int

        public init(term: String, ipa: String, start: Int, end: Int) {
            self.term = term
            self.ipa = ipa
            self.start = start
            self.end = end
        }
    }

    /// `buildIpaOverrides(text, entries)`: every case-insensitive match of an
    /// entry's term on a word boundary (a letter, a digit or an apostrophe on
    /// either side means it is inside a longer word), sorted by position
    /// (stable, as `Array.prototype.sort` is), keeping only entries whose
    /// `ipa` is authored. A term with `ipa: null` produces NO override: a
    /// guessed pronunciation is worse than the synthesiser's own.
    public static func ipaOverrides(_ text: String, entries: [LexiconEntry]) -> [IpaOverride] {
        let length = text.utf16.count
        var found: [(order: Int, override: IpaOverride)] = []
        for entry in entries where !entry.term.isEmpty {
            let pattern = "(?<![\\p{L}\\p{N}'])" + NSRegularExpression.escapedPattern(for: entry.term) + "(?![\\p{L}\\p{N}'])"
            guard let expression = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { continue }
            for match in expression.matches(in: text, options: [], range: NSRange(location: 0, length: length)) {
                guard let ipa = entry.ipa, match.range.length > 0 else { continue }
                found.append((found.count, IpaOverride(term: entry.term, ipa: ipa, start: match.range.location,
                                                       end: match.range.location + match.range.length)))
            }
        }
        return found.sorted {
            $0.override.start != $1.override.start ? $0.override.start < $1.override.start : $0.order < $1.order
        }.map(\.override)
    }
}
