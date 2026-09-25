import XCTest
import ForayEngineCore

/// SpeechRules (card NE-33) beyond what the default-voice and lexicon parity
/// families pin: the two compositions the engine's narrator relies on, which
/// no JS module has as one function (the page composes them itself:
/// `listVoices({ lang: "en" })` then `pickDefaultVoice`).
final class SpeechRulesTests: XCTestCase {
    private let ava = SpeechRules.VoiceOption(identifier: "ava-premium", name: "Ava", language: "en-US", qualityRank: 3)
    private let samanthaCompact = SpeechRules.VoiceOption(identifier: "samantha-compact", name: "Samantha", language: "en-US", qualityRank: 1)
    private let samanthaEnhanced = SpeechRules.VoiceOption(identifier: "samantha-enhanced", name: "Samantha", language: "en-US", qualityRank: 2)
    private let samanthaFrench = SpeechRules.VoiceOption(identifier: "samantha-fr", name: "Samantha", language: "fr-FR", qualityRank: 3)
    private let daniel = SpeechRules.VoiceOption(identifier: "daniel", name: "Daniel", language: "en-GB", qualityRank: 1)

    /// The page's list for the default is every `en-*` voice (VOICE_LIST_LANG
    /// is a bare subtag), labelled, best first; the French Samantha is not on
    /// it, and the best English Samantha tier wins.
    func testTheDefaultIsSamanthasBestEnglishTier() {
        XCTAssertEqual(SpeechRules.defaultVoiceIdentifier(installed: [ava, samanthaFrench, samanthaCompact, daniel, samanthaEnhanced]),
                       "samantha-enhanced")
        XCTAssertNil(SpeechRules.defaultVoiceIdentifier(installed: [ava, samanthaFrench, daniel]), "no English Samantha: no default")
    }

    /// A line with no voice asked for is spoken in the default, never
    /// bestVoice's answer; an asked-for voice wins; a missing one falls back
    /// and says so.
    func testNarrationVoice() {
        let installed = [ava, samanthaCompact, daniel]
        XCTAssertEqual(SpeechRules.narrationVoice(among: installed, requested: nil, language: "en-US", preferringName: nil).voice,
                       samanthaCompact)
        XCTAssertEqual(SpeechRules.bestVoice(among: installed, language: "en-US", preferringName: nil), ava,
                       "the heuristic the default must NOT be")
        XCTAssertEqual(SpeechRules.narrationVoice(among: installed, requested: " ", language: "en-US", preferringName: nil).voice,
                       samanthaCompact, "a blank request is no request")
        XCTAssertEqual(SpeechRules.narrationVoice(among: installed, requested: "daniel", language: "en-US", preferringName: nil),
                       SpeechRules.VoiceResolution(voice: daniel, requested: "daniel", didFallBack: false, reason: ""))
        let missing = SpeechRules.narrationVoice(among: installed, requested: "gone", language: "en-US", preferringName: nil)
        XCTAssertEqual(missing.voice, ava)
        XCTAssertTrue(missing.didFallBack)
        XCTAssertEqual(SpeechRules.narrationVoice(among: [ava, daniel], requested: nil, language: "en-US", preferringName: nil).voice, ava,
                       "no Samantha: the synthesizer's own pick")
    }

    /// Offsets are UTF-16, as JavaScript's are: an emoji before a term moves it
    /// by two, not one.
    func testLexiconOffsetsAreUtf16() {
        let entries = [SpeechRules.LexiconEntry(term: "sake", ipa: "x")]
        XCTAssertEqual(SpeechRules.ipaOverrides("\u{1F525} sake", entries: entries),
                       [SpeechRules.IpaOverride(term: "sake", ipa: "x", start: 3, end: 7)])
        XCTAssertEqual(SpeechRules.ipaOverrides("sake", entries: [SpeechRules.LexiconEntry(term: "sake", ipa: nil)]), [])
    }
}
