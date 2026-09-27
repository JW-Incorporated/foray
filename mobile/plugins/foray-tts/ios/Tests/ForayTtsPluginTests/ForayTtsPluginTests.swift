import XCTest
import AVFAudio
@testable import ForayTtsPlugin

/// Test target for the plugin, same shape @capacitor/app@8.1.1's own
/// AppPluginTests.swift ships (a `testTarget` Package.swift declares).
///
/// **NOTHING RUNS THIS.** No workflow in this repo invokes `swift test` on this
/// package — `.github/workflows/ios-build.yml`'s `ios-shell` job COMPILES this
/// plugin (transitively, via `cap add ios` folding `Package.swift` into the
/// generated project) and `ci.yml`'s `ios-kit` job tests a different package
/// entirely (`ios/ForayKit`). So treat the assertions below as executable
/// documentation that a founder or a future CI job can run, not as coverage
/// this repo has collected. `mobile/plugins/foray-tts/README.md` says the same
/// thing about this file, and it stays true.
///
/// **The mutations named in each comment below have NOT been executed**, for the
/// same reason: they need `swift test` on a Mac, and the branch that added them
/// was written on Windows. Each mutation's ARITHMETIC was checked (the number the
/// mutant produces was computed and differs from the asserted one), which is a
/// weaker claim than "ran it, saw it red" and is deliberately not written as if
/// it were the same thing. Anyone with a Mac can settle it in one command.
final class ForayTtsPluginTests: XCTestCase {
    func testPluginTypeExists() {
        XCTAssertNotNil(ForayTtsPlugin.self)
    }

    // MARK: - The rate mapping
    //
    // `utteranceRate(playbackMultiplier:)` maps the player's speed ladder onto
    // `AVSpeechUtterance.rate`. Read that method's doc comment first: the mapping
    // is CALIBRATED from one device reading (HUMAN-ACTIONS.md #29's RESULT), not
    // derived, and these tests pin the two anchors, the assumed shape, and the
    // edges — in that order, because they fail for different reasons. An anchor
    // test going red means the measurement changed; the shape test going red means
    // the FORM changed, which is the thing a second device reading might justify.

    /// **Anchor 1, definitional.** The player's default speed of 1.0 must be
    /// ordinary speech — `AVSpeechUtteranceDefaultSpeechRate`, from Apple's own
    /// naming of the constant. This is the one point in the mapping that owes
    /// nothing to the device measurement, and the only one that is not an estimate.
    ///
    /// TO SEE IT FAIL: change the body of `utteranceRate` to
    /// `return Float(multiplier)` — the original behaviour, where 1.0x asked for
    /// `AVSpeechUtteranceMaximumSpeechRate` — and this goes from 0.5 to 1.0.
    func testDefaultPlaybackSpeedIsOrdinarySpeech() {
        XCTAssertEqual(
            ForayTtsPlugin.utteranceRate(playbackMultiplier: 1.0),
            AVSpeechUtteranceDefaultSpeechRate,
            accuracy: 0.0001
        )
    }

    /// **Anchor 2, measured.** HUMAN-ACTIONS.md #29's RESULT: utterance rate
    /// `AVSpeechUtteranceDefaultSpeechRate * 1.5` (= 0.75, which is what the old
    /// mapping sent for a requested 1.5x) was heard at roughly 3x normal speed. So
    /// a listener who asks for 3x is the one who should now get that rate.
    ///
    /// The expected value is written as the PRODUCT, not as the literal 0.75, so
    /// this test says where the number came from and cannot drift if Apple moves
    /// `AVSpeechUtteranceDefaultSpeechRate`.
    ///
    /// TO SEE IT FAIL: change `calibrationPerceivedMultiple` from `3.0` to `2.0`
    /// (i.e. claim the founder heard 2x, not 3x) — the result moves 0.750 -> 0.896.
    func testTheMeasuredAnchorIsWhereTheMeasurementPutIt() {
        XCTAssertEqual(
            ForayTtsPlugin.utteranceRate(playbackMultiplier: 3.0),
            AVSpeechUtteranceDefaultSpeechRate * 1.5,
            accuracy: 0.0005
        )
    }

    /// **The bug this branch exists for.** 1.5x played back at roughly 3x on a real
    /// iPhone, because the mapping sent rate 0.75 for it. Whatever else the curve
    /// gets wrong, requesting 1.5x must no longer send the rate that was MEASURED
    /// to sound like 3x — that is the defect, stated without assuming the fix.
    ///
    /// The second assertion pins today's actual value (0.5923, from
    /// `D + 0.25·log(1.5)/log(3)`) so a future edit to the curve has to say so out
    /// loud rather than sliding.
    ///
    /// TO SEE IT FAIL: restore the old body — `let scaled =
    /// Double(AVSpeechUtteranceDefaultSpeechRate) * multiplier` — and 1.5x is 0.75
    /// again, which is exactly the value the first assertion forbids.
    func testRequestingOneAndAHalfNoLongerSendsTheThreeTimesRate() {
        let atOnePointFive = ForayTtsPlugin.utteranceRate(playbackMultiplier: 1.5)
        XCTAssertLessThan(atOnePointFive, AVSpeechUtteranceDefaultSpeechRate * 1.5)
        XCTAssertEqual(atOnePointFive, 0.5923, accuracy: 0.001)
    }

    /// **The SHAPE, which is the assumption rather than the measurement.** The
    /// mapping treats perceived speed as exponential in utterance rate, so equal
    /// RATIOS of playback multiplier cost equal DIFFERENCES of utterance rate:
    /// 1x -> 2x must cost the same rate step as 2x -> 4x, and as 1.5x -> 3x.
    ///
    /// This is the only test here that a straight line through the same two anchors
    /// would fail, which is the point of writing it separately: the anchors do not
    /// determine the curve, and a future device reading that contradicts this is a
    /// reason to change the FORM, not to nudge the constants. 4x is off the
    /// player's ladder deliberately — it is a probe of the function, not of a speed
    /// anyone can select (and 0.815 is still inside the framework range, so the
    /// clamp is not what this measures).
    ///
    /// TO SEE IT FAIL: replace `log(multiplier) / log(calibrationPerceivedMultiple)`
    /// with `(multiplier - 1) / (calibrationPerceivedMultiple - 1)` — the linear
    /// mapping through the SAME two anchors. Both anchor tests above stay green;
    /// the two steps here become 0.125 and 0.250.
    func testEqualSpeedRatiosCostEqualRateSteps() {
        let atOne = ForayTtsPlugin.utteranceRate(playbackMultiplier: 1.0)
        let atTwo = ForayTtsPlugin.utteranceRate(playbackMultiplier: 2.0)
        let atFour = ForayTtsPlugin.utteranceRate(playbackMultiplier: 4.0)
        let atOnePointFive = ForayTtsPlugin.utteranceRate(playbackMultiplier: 1.5)
        let atThree = ForayTtsPlugin.utteranceRate(playbackMultiplier: 3.0)

        XCTAssertEqual(atTwo - atOne, atFour - atTwo, accuracy: 0.0005)
        XCTAssertEqual(atTwo - atOne, atThree - atOnePointFive, accuracy: 0.0005)
    }

    /// Faster in must mean faster out, at every stop the player can actually
    /// select. A speed control that is only approximately calibrated is a known
    /// limitation; one that is not monotonic is a broken control, and monotonicity
    /// is a property this mapping should keep even if the curve is re-fitted.
    ///
    /// TO SEE IT FAIL: wrap the logarithm as `abs(log(multiplier))`. Every stop at
    /// or above 1.0 is unchanged — so all four tests above stay green — but 0.75x
    /// rises to 0.566, above the 0.500 of 1x, and the ladder stops being ordered.
    func testTheLadderIsStrictlyIncreasing() {
        let ladder: [Double] = [0.75, 1, 1.25, 1.5, 1.75, 2]
        let rates = ladder.map { ForayTtsPlugin.utteranceRate(playbackMultiplier: $0) }
        for i in 1..<rates.count {
            XCTAssertGreaterThan(
                rates[i], rates[i - 1],
                "rate for \(ladder[i])x must exceed rate for \(ladder[i - 1])x"
            )
        }
    }

    /// The ladder in `player/playback-rate.js` tops out at 2.0 and bottoms at
    /// 0.75, so every stop must land inside the framework's range on its own rather
    /// than relying on the framework to clamp it — and must land STRICTLY inside,
    /// because a stop pinned to an end of the scale is a stop the listener cannot
    /// tell apart from the one next to it.
    ///
    /// TO SEE IT FAIL: change `anchorSpan` to `anchorRate` (0.25 -> 0.75, a
    /// plausible slip). 2.0x then asks for 0.973 and 0.75x for 0.304 — still inside
    /// the range, so the range assertions survive; the strictness assertion on
    /// 2.0x's headroom is what catches it, which is why the margin is named.
    func testEveryLadderStopLandsStrictlyInsideTheFrameworkRange() {
        let ladder: [Double] = [0.75, 1, 1.25, 1.5, 1.75, 2]
        for stop in ladder {
            let rate = ForayTtsPlugin.utteranceRate(playbackMultiplier: stop)
            XCTAssertGreaterThan(rate, AVSpeechUtteranceMinimumSpeechRate)
            XCTAssertLessThan(rate, AVSpeechUtteranceMaximumSpeechRate)
        }
        // The fastest stop keeps real headroom above it — this is what makes the
        // top of the ladder a rate rather than a ceiling.
        XCTAssertLessThan(
            ForayTtsPlugin.utteranceRate(playbackMultiplier: 2.0),
            AVSpeechUtteranceMaximumSpeechRate - 0.2
        )
        XCTAssertGreaterThan(
            ForayTtsPlugin.utteranceRate(playbackMultiplier: 0.75),
            AVSpeechUtteranceMinimumSpeechRate + 0.2
        )
    }

    /// A nonsense multiplier must not escape the range. `getDouble("rate")` takes
    /// whatever JSON the page sent.
    ///
    /// TO SEE IT FAIL: delete the `min`/`max` clamp and `return Float(scaled)` —
    /// 1000 then returns 2.07, well past `AVSpeechUtteranceMaximumSpeechRate`.
    func testAbsurdMultipliersAreClamped() {
        XCTAssertEqual(
            ForayTtsPlugin.utteranceRate(playbackMultiplier: 1000),
            AVSpeechUtteranceMaximumSpeechRate,
            accuracy: 0.0001
        )
        XCTAssertEqual(
            ForayTtsPlugin.utteranceRate(playbackMultiplier: -5),
            AVSpeechUtteranceMinimumSpeechRate,
            accuracy: 0.0001
        )
    }

    /// **A logarithm has a domain, and `min`/`max` do not clamp NaN.** Swift's
    /// `max(x, y)` is `y >= x ? y : x` and `min(x, y)` is `y <= x ? y : x`; both
    /// comparisons are false against NaN, so a NaN passes through the clamp
    /// untouched and would be assigned to `utterance.rate`. `log` of a negative is
    /// NaN and `log(0)` is -infinity, and both 0 and a negative are reachable —
    /// `rate` is whatever number the page put in the JSON. So the guard is not
    /// defensive tidying; it is the difference between "slowest rate" and "NaN on
    /// an AVFoundation property".
    ///
    /// Infinity is included from the other side: it must survive the guard and be
    /// clamped, not rejected, because `+inf` is genuinely "as fast as possible".
    ///
    /// TO SEE IT FAIL: delete `guard multiplier > 0 else { return Float(minRate) }`.
    /// The 0 case still passes (log(0) is -infinity, which the clamp DOES handle),
    /// and only the NaN and negative cases go red — which is the whole reason this
    /// test does not stop at 0.
    func testNonNumericMultipliersProduceAUsableRateRatherThanNaN() {
        for bad in [0.0, -1.0, Double.nan, -Double.infinity] {
            let rate = ForayTtsPlugin.utteranceRate(playbackMultiplier: bad)
            XCTAssertTrue(rate.isFinite, "multiplier \(bad) produced a non-finite rate")
            XCTAssertGreaterThanOrEqual(rate, AVSpeechUtteranceMinimumSpeechRate)
            XCTAssertLessThanOrEqual(rate, AVSpeechUtteranceMaximumSpeechRate)
        }
        let atInfinity = ForayTtsPlugin.utteranceRate(playbackMultiplier: .infinity)
        XCTAssertEqual(atInfinity, AVSpeechUtteranceMaximumSpeechRate, accuracy: 0.0001)
    }

    // MARK: - Voice selection
    //
    // These build `VoiceOption` values by hand rather than calling
    // `AVSpeechSynthesisVoice.speechVoices()`, and that is the point: the real
    // catalogue is a per-DEVICE download set, so a test that read it would
    // assert something different on every machine — and would pass vacuously on
    // a simulator that happens to carry only the compact tier, which is the one
    // configuration where the bug being fixed here is invisible.
    //
    // EVERY MUTATION BELOW IS NAMED BUT NONE HAS BEEN RUN. See this file's
    // header: nothing in this repo executes `swift test`, and the machine this
    // change was written on is Windows. Treat the "TO SEE IT FAIL" lines as
    // instructions for the first person with a Mac, not as a claim that the
    // assertion has ever been red.

    private func option(_ identifier: String, _ name: String, _ language: String, _ rank: Int) -> ForayTtsPlugin.VoiceOption {
        ForayTtsPlugin.VoiceOption(identifier: identifier, name: name, language: language, qualityRank: rank)
    }

    /// A stand-in catalogue: one language carrying all three tiers, plus a
    /// second locale of the same primary subtag, plus an unrelated language.
    private var catalogue: [ForayTtsPlugin.VoiceOption] {
        [
            option("com.apple.ttsbundle.Samantha-compact", "Samantha", "en-US", 1),
            option("com.apple.voice.enhanced.en-US.Samantha", "Samantha", "en-US", 2),
            option("com.apple.voice.enhanced.en-US.Ava", "Ava", "en-US", 2),
            option("com.apple.voice.premium.en-US.Zoe", "Zoe", "en-US", 3),
            option("com.apple.ttsbundle.Daniel-compact", "Daniel", "en-GB", 1),
            option("com.apple.ttsbundle.Amelie-compact", "Amélie", "fr-FR", 1)
        ]
    }

    /// THE WHOLE BUG. `AVSpeechSynthesisVoice(language:)` returns the system
    /// default, which is the compact tier; a premium voice sitting installed on
    /// the same device was never asked for.
    ///
    /// TO SEE IT FAIL: in `bestVoice`, change `pool.map(\.qualityRank).max()` to
    /// `.min()` — the selection returns the compact Samantha, which is exactly
    /// the voice the founder called "much worse than the original test".
    func testBestVoicePrefersPremiumOverEnhancedOverCompact() {
        let best = ForayTtsPlugin.bestVoice(among: catalogue, language: "en-US", preferringName: "Samantha")
        XCTAssertEqual(best?.identifier, "com.apple.voice.premium.en-US.Zoe")
        XCTAssertEqual(best?.qualityRank, 3)
    }

    /// Enhanced/Premium voices are per-device downloads. On a stock phone that
    /// has fetched nothing, selection must still produce a voice.
    ///
    /// TO SEE IT FAIL: make `bestVoice` return nil unless `topRank >= 2` — a
    /// stock device then gets no voice at all from the resolver.
    func testBestVoiceDegradesToWhateverIsInstalled() {
        let compactOnly = [
            option("com.apple.ttsbundle.Samantha-compact", "Samantha", "en-US", 1),
            option("com.apple.ttsbundle.Fred-compact", "Fred", "en-US", 1)
        ]
        let best = ForayTtsPlugin.bestVoice(among: compactOnly, language: "en-US", preferringName: "Samantha")
        XCTAssertEqual(best?.identifier, "com.apple.ttsbundle.Samantha-compact")
    }

    /// Ties inside the top tier go to the voice the system would have used
    /// anyway, so an upgrade sounds like the listener's own voice getting better
    /// rather than a stranger arriving.
    ///
    /// TO SEE IT FAIL: delete the `preferringName` branch in `bestVoice` — the
    /// deterministic identifier tie-break then picks Ava, because
    /// "…enhanced.en-US.Ava" sorts before "…enhanced.en-US.Samantha".
    func testEnhancedTieBreaksTowardTheSystemDefaultName() {
        let enhancedOnly = catalogue.filter { $0.qualityRank != 3 }
        let best = ForayTtsPlugin.bestVoice(among: enhancedOnly, language: "en-US", preferringName: "Samantha")
        XCTAssertEqual(best?.identifier, "com.apple.voice.enhanced.en-US.Samantha")
    }

    /// An exact locale match must never be displaced by a same-primary-subtag
    /// one, even when the other locale carries a better tier.
    ///
    /// TO SEE IT FAIL: in `candidates`, drop the `if !exact.isEmpty { return exact }`
    /// early return — en-GB's Daniel then competes for an en-US request.
    func testExactLocaleWinsOverPrimarySubtagWidening() {
        let chosen = ForayTtsPlugin.candidates(catalogue, language: "en-US")
        XCTAssertEqual(chosen.count, 4)
        XCTAssertFalse(chosen.contains { $0.language == "en-GB" })
    }

    /// …but a locale with nothing installed widens rather than going silent.
    ///
    /// TO SEE IT FAIL: make `candidates` return `exact` unconditionally — an
    /// en-AU request on this catalogue then yields no voice at all.
    func testUnknownLocaleWidensToThePrimarySubtag() {
        let chosen = ForayTtsPlugin.candidates(catalogue, language: "en-AU")
        XCTAssertEqual(chosen.count, 5, "every en-* voice, and no French one")
        XCTAssertFalse(chosen.contains { $0.language == "fr-FR" })
    }

    /// An explicitly requested, installed identifier is used verbatim — the
    /// caller's choice outranks the quality ladder.
    ///
    /// TO SEE IT FAIL: in `resolveVoice`, delete the `all.first(where:)` exact
    /// branch — the request is silently upgraded to the premium voice and
    /// `didFallBack` still reads false, which is the worst of both.
    func testExplicitInstalledVoiceIsHonouredEvenWhenNotTheBest() {
        let resolution = ForayTtsPlugin.resolveVoice(
            among: catalogue,
            requested: "com.apple.voice.enhanced.en-US.Ava",
            language: "en-US",
            preferringName: "Samantha"
        )
        XCTAssertEqual(resolution.voice?.identifier, "com.apple.voice.enhanced.en-US.Ava")
        XCTAssertFalse(resolution.didFallBack)
        XCTAssertEqual(resolution.reason, "")
    }

    /// The case a listening test cannot survive without: an identifier that is
    /// not downloaded on THIS phone must still speak, and must say it did not
    /// use what was asked for.
    ///
    /// TO SEE IT FAIL: make `resolveVoice` return `didFallBack: false` on the
    /// not-installed path. A founder then reports "the enhanced voice sounds
    /// identical to the compact one" and is describing a voice that was never
    /// on the device.
    func testUninstalledVoiceFallsBackAndSaysSo() {
        let resolution = ForayTtsPlugin.resolveVoice(
            among: catalogue,
            requested: "com.apple.voice.premium.en-US.NotDownloaded",
            language: "en-US",
            preferringName: "Samantha"
        )
        XCTAssertEqual(resolution.voice?.identifier, "com.apple.voice.premium.en-US.Zoe")
        XCTAssertTrue(resolution.didFallBack)
        XCTAssertEqual(resolution.requested, "com.apple.voice.premium.en-US.NotDownloaded")
        XCTAssertFalse(resolution.reason.isEmpty)
    }

    /// An empty catalogue is not a crash and not a silent success.
    ///
    /// TO SEE IT FAIL: change `bestVoice`'s `guard let topRank = … else { return nil }`
    /// to force-unwrap the max — an empty pool then traps instead of resolving.
    func testEmptyCatalogueResolvesToNoVoiceWithAReason() {
        let resolution = ForayTtsPlugin.resolveVoice(
            among: [],
            requested: nil,
            language: "en-US",
            preferringName: nil
        )
        XCTAssertNil(resolution.voice)
        XCTAssertFalse(resolution.didFallBack, "nothing was asked for, so nothing was refused")
        XCTAssertFalse(resolution.reason.isEmpty)
    }

    /// TO SEE IT FAIL: return `"enhanced"` for rank 3 in `qualityLabel` — the
    /// premium tier is then reported as enhanced everywhere, including in the
    /// `listVoices()` output a founder reads to decide what to download.
    func testQualityLabels() {
        XCTAssertEqual(ForayTtsPlugin.qualityLabel(rank: 1), "default")
        XCTAssertEqual(ForayTtsPlugin.qualityLabel(rank: 2), "enhanced")
        XCTAssertEqual(ForayTtsPlugin.qualityLabel(rank: 3), "premium")
        XCTAssertEqual(ForayTtsPlugin.qualityLabel(rank: 99), "unknown", "a future tier sorts right but is not mislabelled")
    }

    /// TO SEE IT FAIL: flip the quality comparison in `sortedForListing` to
    /// `<` — the compact voices head each language and the good ones sink to the
    /// bottom of the list, which is the opposite of what the list is read for.
    func testListingPutsBestQualityFirstWithinALanguage() {
        let sorted = ForayTtsPlugin.sortedForListing(catalogue)
        let englishUS = sorted.filter { $0.language == "en-US" }
        XCTAssertEqual(englishUS.first?.qualityRank, 3)
        XCTAssertEqual(englishUS.last?.qualityRank, 1)
        XCTAssertEqual(sorted.first?.language, "en-GB", "languages sort ahead of quality")
    }

    /// TO SEE IT FAIL: make `primarySubtag` return the whole tag — `en-US` then
    /// never widens to `en`, and `testUnknownLocaleWidensToThePrimarySubtag`
    /// goes with it.
    func testPrimarySubtag() {
        XCTAssertEqual(ForayTtsPlugin.primarySubtag("en-US"), "en")
        XCTAssertEqual(ForayTtsPlugin.primarySubtag("EN_us"), "en")
        XCTAssertEqual(ForayTtsPlugin.primarySubtag("fr"), "fr")
        XCTAssertEqual(ForayTtsPlugin.primarySubtag(""), "")
    }

    // MARK: - §7 item 3 (L-03): the `finished` event

    /// Pins the event name against `web/foray-tts.js`'s own `FINISHED_EVENT`
    /// constant — the same discipline `shell-invariants.test.mjs` applies to
    /// `TRANSPORT_EVENT`. A rename on either side without the other is a
    /// silent drop: `notifyListeners` simply has no subscriber for the new
    /// name and the queue stops advancing past narration with no error
    /// anywhere.
    ///
    /// TO SEE IT FAIL: rename `FINISHED_EVENT` here to `"done"` without
    /// updating `web/foray-tts.js`.
    func testFinishedEventNameMatchesTheWebHalf() {
        XCTAssertEqual(ForayTtsPlugin.FINISHED_EVENT, "finished")
    }

    // MARK: - K-01: the bundled-voice probe (docs/bundled-voice-plan.md)
    //
    // Same honesty caveat as everything above: nothing runs these, and the
    // mutations named below have NOT been executed. What they pin is the one
    // property no Node suite can reach — that the engine seam exists, is
    // empty on a shipping build, and that the plugin declares the method the
    // web half calls by name.

    /// **The seam is empty on every build that ships**, and it stays empty
    /// even now that ONNX Runtime IS linked (2026-09-12). That is the whole
    /// inertness claim: `KokoroOrtProbeEngine` is constructed inside
    /// `kokoroProbe`, on demand, after the model-presence check passes — so
    /// ORT is never touched at `load()`, never at app start, and never on any
    /// path narration reaches. A build that shipped with a probe engine
    /// pre-registered would be running ONNX Runtime in every listener's app
    /// for a card that measures one founder's phone.
    ///
    /// TO SEE IT FAIL: assign `ForayTtsPlugin.probeEngine` a default in the
    /// plugin source, or move the `KokoroOrtProbeEngine()` construction into
    /// the plugin's `load()`.
    func testProbeEngineIsUnregisteredByDefault() {
        XCTAssertNil(ForayTtsPlugin.probeEngine)
    }

    /// **The probe finds no weights in a test bundle, and says so.** The test
    /// host has no `kokoro-v1_0-q8f16.onnx` in either place the lookup
    /// searches, so this pins the ORDER of the refusals rather than a
    /// measurement: a passage problem first, then `model-absent`, and only
    /// then an engine. It is the one assertion that would notice
    /// `KokoroModelFiles.modelURL()` being changed to return a path that
    /// always exists — after which every build would answer `engine-absent`
    /// and a founder would be sent to look at the runtime instead of at the
    /// fetch step.
    ///
    /// TO SEE IT FAIL: have `modelURL()` fall back to `Bundle.main.bundlePath`.
    func testModelIsAbsentInATestBundle() {
        XCTAssertNil(KokoroModelFiles.modelURL())
        XCTAssertNil(KokoroModelFiles.voiceURL())
    }

    /// **An engine cannot be built without the files.** `init?` returns nil,
    /// which the plugin turns into `engine-absent` — not a crash, and not a
    /// zero that would read as "infinitely fast" in an RTF.
    ///
    /// TO SEE IT FAIL: make `KokoroOrtProbeEngine.init?` non-failable and open
    /// the session lazily instead.
    func testProbeEngineRefusesToBuildWithNoWeights() {
        XCTAssertNil(KokoroOrtProbeEngine())
    }

    /// **The method is declared, and named exactly what the web half calls.**
    /// `web/foray-tts.js`'s `kokoroProbe()` invokes
    /// `nativePromise("ForayTts", "kokoroProbe", …)`; a method missing from
    /// `pluginMethods` rejects at the bridge, which the web half turns into
    /// `engine-absent` — indistinguishable, from a founder's phone, from "this
    /// build has no runtime". That ambiguity is exactly what a probe must not
    /// have.
    ///
    /// TO SEE IT FAIL: drop the `kokoroProbe` entry from `pluginMethods`.
    func testKokoroProbeIsADeclaredPluginMethod() {
        let plugin = ForayTtsPlugin()
        XCTAssertTrue(plugin.pluginMethods.contains { $0.name == "kokoroProbe" })
    }

    /// **The bundled-model resource name is the one `fetch-models.mjs` writes.**
    /// The two halves of "did the build fetch the weights?" are a filename in
    /// a build script and a filename in a lookup; they are in different
    /// languages and different trees, so the only thing keeping them in step
    /// is that both are pinned — here, and in
    /// `tools/mobile/fetch-models.test.mjs`.
    ///
    /// TO SEE IT FAIL: change `MODEL_RESOURCE` without changing the pin in
    /// `tools/mobile/fetch-models.mjs`.
    func testModelResourceName() {
        // fp32 since KV-R2 (deck D13): the only export finite on Apple silicon.
        XCTAssertEqual(ForayTtsPlugin.MODEL_RESOURCE, "kokoro-v1_0-fp32")
        XCTAssertEqual(ForayTtsPlugin.MODEL_EXTENSION, "onnx")
    }

    /// **The voice and the subdirectory are the ones the build step writes.**
    /// `tools/mobile/fetch-models.mjs`'s `PROBE_VOICE` names the file and
    /// `tools/mobile/inject-models.mjs` writes it into the generated project's
    /// `public/` folder reference — which is the only place in a
    /// Capacitor-generated iOS app a Node script can add a resource without
    /// editing a `.pbxproj`. `inject-models.test.mjs` asserts the same pair
    /// from the other side, in Node, by reading this source file.
    ///
    /// TO SEE IT FAIL: change either constant without changing the pin table.
    func testVoiceAndSubdirectoryMatchTheBuildStep() {
        XCTAssertEqual(ForayTtsPlugin.VOICE_RESOURCE, "af_heart")
        XCTAssertEqual(ForayTtsPlugin.RESOURCE_SUBDIR, "public")
    }
    // MARK: - L-05: pause, resume, stop (founder feedback F12)

    /// `speaking | paused | idle`, and the PRECEDENCE is the whole test.
    /// `AVSpeechSynthesizer.isSpeaking` stays TRUE while paused — Apple's
    /// documented behaviour, a paused synthesizer is still "speaking" an
    /// utterance — so reading `isSpeaking` first would report a paused
    /// synthesizer as speaking, and the lock screen would offer a pause button
    /// for audio that is already silent. That costs a press, which on a driving
    /// app is the whole of F12's complaint in miniature.
    ///
    /// TO SEE IT FAIL: swap the two `if`s in `stateWord`. The third case below
    /// goes red and nothing else in this repo notices.
    func testStateWordChecksPausedBeforeSpeaking() {
        XCTAssertEqual(ForayTtsPlugin.stateWord(isSpeaking: false, isPaused: false), "idle")
        XCTAssertEqual(ForayTtsPlugin.stateWord(isSpeaking: true, isPaused: false), "speaking")
        // The case that matters: BOTH true is what a paused synthesizer reports.
        XCTAssertEqual(ForayTtsPlugin.stateWord(isSpeaking: true, isPaused: true), "paused")
    }

    /// The three words are a contract with `web/foray-tts.js` and with
    /// `ForayTtsPlugin.java`, which reports the same three. A caller should not
    /// have to know which platform answered.
    ///
    /// TO SEE IT FAIL: rename any one of them here alone.
    func testTheThreeStateWordsAreTheOnesBothPlatformsUse() {
        XCTAssertEqual(ForayTtsPlugin.STATE_SPEAKING, "speaking")
        XCTAssertEqual(ForayTtsPlugin.STATE_PAUSED, "paused")
        XCTAssertEqual(ForayTtsPlugin.STATE_IDLE, "idle")
    }

    // MARK: - M-03: the session event

    /// Both plugins raise the SAME event name with the same shape, and
    /// `producer` is what separates them. A record that had to join two event
    /// names with two vocabularies to answer "why did it stop?" would be
    /// answering a harder question than the founder asked.
    ///
    /// TO SEE IT FAIL: rename `SESSION_EVENT` here without renaming it in
    /// `web/foray-media-session.js`, which is what subscribes.
    func testSessionEventNameMatchesTheAudioPluginAndTheWebHalf() {
        XCTAssertEqual(ForayTtsPlugin.SESSION_EVENT, "session")
    }

    /// `producer: "tts"` — a narration line and a tape segment are silenced
    /// through different objects, and a record that could not tell them apart
    /// would answer "the audio stopped" to the question "WHICH audio".
    ///
    /// TO SEE IT FAIL: emit `producer: "audio"` here. The record accepts it
    /// (both are in its vocabulary) and quietly attributes every silenced
    /// narration line to the element.
    func testSessionEventNamesThisPluginAsTheProducer() {
        let event = ForayTtsPlugin.sessionEvent(kind: "interruptionBegan", reason: "began", at: 1_700_000_000_000)
        XCTAssertEqual(event["kind"] as? String, "interruptionBegan")
        XCTAssertEqual(event["reason"] as? String, "began")
        XCTAssertEqual(event["producer"] as? String, "tts")
        XCTAssertEqual(event["at"] as? Int, 1_700_000_000_000)
    }

    /// A route change reports a CODE, never the route's name — a Bluetooth
    /// route is named after the person who owns the car, and this record is
    /// pasted into issues.
    ///
    /// TO SEE IT FAIL: return `String(raw)`. `dataTokenOf()` in the record
    /// admits only a lower-case dashed token, so a number lands as an empty
    /// reason and the row says nothing.
    func testRouteChangeReasonIsAClosedVocabularyOfDashedTokens() {
        XCTAssertEqual(
            ForayTtsPlugin.routeChangeReason(AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue),
            "old-device-gone"
        )
        XCTAssertEqual(ForayTtsPlugin.routeChangeReason(9_999), "unknown")
        for raw: UInt in 0...8 {
            let token = ForayTtsPlugin.routeChangeReason(raw)
            XCTAssertFalse(token.isEmpty)
            XCTAssertEqual(token, token.lowercased())
            XCTAssertFalse(token.contains(" "))
        }
    }

    /// Audit round 3, mobile-native-1: a new line replaces a paused or
    /// still-speaking one instead of queueing silently behind it. MUTATION:
    /// return `isSpeaking` alone and the paused row goes red.
    func testSpeakFlushesAPausedOrSpeakingSynthesizer() {
        XCTAssertTrue(ForayTtsPlugin.mustFlushBeforeSpeaking(isSpeaking: true, isPaused: true))
        XCTAssertTrue(ForayTtsPlugin.mustFlushBeforeSpeaking(isSpeaking: false, isPaused: true))
        XCTAssertTrue(ForayTtsPlugin.mustFlushBeforeSpeaking(isSpeaking: true, isPaused: false))
        XCTAssertFalse(ForayTtsPlugin.mustFlushBeforeSpeaking(isSpeaking: false, isPaused: false))
    }

    // MARK: - Lane A: the probe says why it failed, and on what
    // (docs/diagnostics/log-gaps-2026-09-26.md). Pure helpers first — none of
    // them touches ONNX Runtime — then the measurement over a fake engine.

    /// **ORT's error codes map to the page's closed tokens, by the C API's
    /// numbering.** onnxruntime-objc has no error enum of its own: its
    /// `error_utils.mm` puts `OrtErrorCode` (onnxruntime_c_api.h: ORT_OK = 0,
    /// ORT_FAIL = 1 … ORT_EP_FAIL = 11) straight into `NSError.code` under the
    /// domain "onnxruntime". MUTATION: drop or reorder one token — every code
    /// after it names the wrong failure.
    func testOrtCodeTokensFollowTheCApiNumbering() {
        let expected = [1: "fail", 2: "invalid-argument", 3: "no-such-file", 4: "no-model",
                        5: "engine-error", 6: "runtime-exception", 7: "invalid-protobuf",
                        8: "model-loaded", 9: "not-implemented", 10: "invalid-graph", 11: "ep-fail"]
        for (code, token) in expected {
            XCTAssertEqual(KokoroOrtProbeEngine.ortCodeToken(code), token, "code \(code)")
        }
        XCTAssertEqual(KokoroOrtProbeEngine.ortCodeToken(0), "other", "ORT_OK is not a failure token")
        XCTAssertEqual(KokoroOrtProbeEngine.ortCodeToken(12), "other")
        XCTAssertEqual(KokoroOrtProbeEngine.ortCodeToken(-1), "other")
        let ort = NSError(domain: "onnxruntime", code: 9, userInfo: nil)
        XCTAssertEqual(KokoroOrtProbeEngine.ortCodeToken(ort), "not-implemented")
        let foreign = NSError(domain: NSCocoaErrorDomain, code: 9, userInfo: nil)
        XCTAssertEqual(KokoroOrtProbeEngine.ortCodeToken(foreign), "other", "a code means nothing outside ORT's domain")
    }

    /// **The operator's NAME comes out of an ORT message, and nothing else
    /// does.** MUTATION: return the message, or widen the capture — the path
    /// assertion goes red.
    func testOrtOpTakesOnlyAnIdentifierFromTheMessage() {
        XCTAssertEqual(KokoroOrtProbeEngine.ortOp(fromMessage:
            "Non-zero status code returned while running ConvTranspose node. Name:'/decoder/up.0' Status Message: bad"),
            "ConvTranspose")
        XCTAssertEqual(KokoroOrtProbeEngine.ortOp(fromMessage:
            "Could not find an implementation for STFT(17) node with name 'stft'"), "STFT")
        let pathy = "Load model from /var/mobile/Containers/Data/Application/0A1B/Library/kokoro.onnx failed: No such file"
        XCTAssertNil(KokoroOrtProbeEngine.ortOp(fromMessage: pathy))
        let both = "while running Gather node. /var/mobile/Containers/x.onnx"
        XCTAssertEqual(KokoroOrtProbeEngine.ortOp(fromMessage: both), "Gather")
        let long = "Could not find an implementation for " + String(repeating: "A", count: 40)
        XCTAssertNil(KokoroOrtProbeEngine.ortOp(fromMessage: long), "an identifier longer than 32 is refused, not cut")
        XCTAssertNil(KokoroOrtProbeEngine.ortOp(fromMessage: ""))
    }

    /// **A buffer of NaN is not audio, and neither is a buffer of silence
    /// (L04).** A GitHub macos-14 run of this model returned non-finite
    /// samples on two lines of four without throwing. MUTATION: skip the
    /// pass, or test only the first sample.
    func testSampleVerdictNamesNaNAndSilence() {
        XCTAssertEqual(KokoroOrtProbeEngine.sampleVerdict([0.1, Float.nan, 0.2] as [Float]), "non-finite")
        XCTAssertEqual(KokoroOrtProbeEngine.sampleVerdict([0.1, 0.2, Float.infinity] as [Float]), "non-finite")
        XCTAssertEqual(KokoroOrtProbeEngine.sampleVerdict([Float](repeating: 0, count: 2400)), "silent")
        XCTAssertEqual(KokoroOrtProbeEngine.sampleVerdict([0.00001, -0.00002] as [Float]), "silent")
        let sine = (0..<2400).map { Float(sin(Double($0) * 2 * Double.pi * 440 / 24_000)) * 0.3 }
        XCTAssertNil(KokoroOrtProbeEngine.sampleVerdict(sine))
    }

    /// **Thermal state in the page's four words (L10).**
    func testThermalTokens() {
        XCTAssertEqual(ForayTtsPlugin.thermalToken(.nominal), "nominal")
        XCTAssertEqual(ForayTtsPlugin.thermalToken(.fair), "fair")
        XCTAssertEqual(ForayTtsPlugin.thermalToken(.serious), "serious")
        XCTAssertEqual(ForayTtsPlugin.thermalToken(.critical), "critical")
    }

    /// **The hardware model identifier as a diagnostics token (L09).**
    /// DiagGate tokens exclude commas, so `iPhone15,2` must arrive as
    /// `iPhone15.2`. MUTATION: drop the comma swap.
    func testMachineTokenSwapsTheCommaAndAdmitsOnlyTokenCharacters() {
        XCTAssertEqual(ForayTtsPlugin.machineToken("iPhone15,2"), "iPhone15.2")
        XCTAssertEqual(ForayTtsPlugin.machineToken("18.6.2"), "18.6.2")
        XCTAssertEqual(ForayTtsPlugin.machineToken("a b/c"), "a-b-c")
        XCTAssertEqual(ForayTtsPlugin.machineToken(String(repeating: "x", count: 40))?.count, 32)
        XCTAssertNil(ForayTtsPlugin.machineToken(""))
        XCTAssertNotNil(ForayTtsPlugin.machineToken(ForayTtsPlugin.machineIdentifier()))
    }

    /// **The model file is identified by a streamed hash (L08).** SHA-256 of
    /// "abc" begins `ba7816bf`. MUTATION: hash only the first chunk, or
    /// format upper-case.
    func testModelFileFactsHashesTheWholeFile() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("foray-probe-\(UUID().uuidString).bin")
        try Data("abc".utf8).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let facts = try XCTUnwrap(ForayTtsPlugin.modelFileFacts(url))
        XCTAssertEqual(facts.bytes, 3)
        XCTAssertEqual(facts.sha8, "ba7816bf")
        XCTAssertNil(ForayTtsPlugin.modelFileFacts(url.appendingPathExtension("missing")))
    }

    /// **The peak is a peak.** `phys_footprint` is the CURRENT footprint;
    /// the high-water mark can never be below it. MUTATION: return the
    /// current figure only — still passes this floor, which is why the JS
    /// suite also pins `ledger_phys_footprint_peak` by name.
    func testPeakResidentBytesIsNeverBelowTheCurrentFootprint() {
        let now = ForayTtsPlugin.taskFootprint()
        XCTAssertGreaterThan(now.current, 0)
        XCTAssertGreaterThanOrEqual(ForayTtsPlugin.peakResidentBytes(), now.current)
    }

    /// **Every line throws: the failure path says so line by line, and keeps
    /// the readings it used to drop (L05, L34, L35).** The failure path used
    /// to omit `availableMemoryBytes` and `lockedScreenCompleted`, and kept
    /// only the FIRST failure's code. MUTATION: build `lineOutcomes` from
    /// `firstFailure`, or move either reading back into the success branch.
    func testAFailingPassageReportsEveryLineAndTheFullContext() {
        let result = ForayTtsPlugin.measure(engine: ThrowingProbeEngine(),
                                            idLines: [[0, 1, 2, 0], [0, 3, 4, 0], [0, 5, 6, 0], [0, 7, 8, 0]],
                                            speed: 1, modelURL: nil, isForeground: { false })
        XCTAssertEqual(result["ok"] as? Bool, false)
        XCTAssertEqual(result["reason"] as? String, "synthesis-failed")
        XCTAssertEqual(result["detail"] as? String, "inference-threw")
        XCTAssertEqual(result["lineOutcomes"] as? [String], ["threw", "threw", "threw", "threw"])
        XCTAssertEqual(result["synthFailures"] as? Int, 4)
        XCTAssertNotNil(result["availableMemoryBytes"] as? Double)
        XCTAssertEqual(result["lockedScreenCompleted"] as? Bool, true)
        XCTAssertEqual(result["bgAtFail"] as? Bool, true)
        XCTAssertEqual(result["ortCode"] as? String, "not-implemented")
        XCTAssertEqual(result["ortOp"] as? String, "ConvTranspose")
        XCTAssertEqual(result["ortStage"] as? String, "run")
        XCTAssertEqual(result["loadErr"] as? String, "no-model")
        XCTAssertEqual(result["platform"] as? String, "ios")
        XCTAssertNotNil(result["thermalStart"] as? String)
        XCTAssertNotNil(result["thermalEnd"] as? String)
        XCTAssertNotNil(result["lowPower"] as? Bool)
        XCTAssertEqual(result["memWarn"] as? Bool, false)
        XCTAssertNotNil(result["baseMemoryBytes"] as? Double)
        XCTAssertNotNil(result["cores"] as? Int)
        XCTAssertNotNil(result["device"] as? String)
        XCTAssertNil(result["ortVersion"], "a fake engine is not ORT, so no runtime version is claimed")
        XCTAssertFalse((result["device"] as? String ?? ",").contains(","))
    }

    /// **NaN and silence are failures with zero seconds, never audio (L04).**
    /// MUTATION: add a failed line's `audioSec` to the total — the RTF is then
    /// computed over garbage and the probe reports `ok`.
    func testGarbageLinesCountAsFailuresAndContributeNoAudio() {
        let result = ForayTtsPlugin.measure(engine: ScriptedProbeEngine(reasons: [nil, "non-finite", "silent", nil]),
                                            idLines: [[0, 1, 2, 0], [0, 3, 4, 0], [0, 5, 6, 0], [0, 7, 8, 0]],
                                            speed: 1, modelURL: nil, isForeground: { true })
        XCTAssertEqual(result["ok"] as? Bool, true)
        XCTAssertEqual(result["lineOutcomes"] as? [String], ["ok", "nan", "silent", "ok"])
        XCTAssertEqual(result["nonFiniteLines"] as? Int, 1)
        XCTAssertEqual(result["silentLines"] as? Int, 1)
        XCTAssertEqual(result["synthFailures"] as? Int, 2)
        XCTAssertEqual(result["audioColdSec"] as? Double, 2)
        XCTAssertEqual(result["audioWarmSec"] as? Double, 2, "only the one good warm line counts")
        XCTAssertEqual(result["bgAtFail"] as? Bool, false)
        XCTAssertNil(result["ortCode"], "no ORT failure was named")
        XCTAssertEqual(result["lockedScreenCompleted"] as? Bool, false)
    }

    // MARK: - KV-R2: two passes, sentence chunks, the kill marker

    /// **The passes run in order, and each engine is CLOSED before the next
    /// is built** — so two 325 MB fp32 sessions never coexist. MUTATION: move
    /// `engine.close()` after the loop, or build both engines up front.
    func testPassesRunInOrderAndEachEngineIsClosedBeforeTheNextIsBuilt() {
        let log = EventLog()
        let result = ForayTtsPlugin.measurePasses(
            idLines: [[0, 1, 2, 0], [0, 3, 4, 0]], speed: 1, modelURL: nil,
            makeEngine: { pass in log.add("make \(pass.rawValue)"); return LoggingProbeEngine(pass: pass, log: log) },
            isForeground: { false }, inFlight: ProbeInFlight(url: tempURL()))
        XCTAssertEqual(log.events, ["make cpu", "load cpu", "close cpu", "make coreml", "load coreml", "close coreml"])
        XCTAssertEqual(result["ok"] as? Bool, true)
        let passes = result["passes"] as? [[String: Any]] ?? []
        XCTAssertEqual(passes.map { $0["pass"] as? String }, ["cpu", "coreml"])
        XCTAssertEqual(passes.map { $0["provider"] as? String }, ["cpu", "coreml"])
        XCTAssertEqual(passes.first?["lines"] as? Int, 2, "one inference per chunk")
    }

    /// **An unavailable CoreML EP is `coreml-unavailable`, and the CPU pass
    /// still measures.** MUTATION: let an unregistered EP fall through to
    /// the chunk loop — it reads `synthesis-failed/session-absent`, which
    /// names an inference fault that never happened.
    func testAnUnavailableCoreMLPassIsNamedAndTheCPUPassStillRuns() {
        let log = EventLog()
        let result = ForayTtsPlugin.measurePasses(
            idLines: [[0, 1, 2, 0], [0, 3, 4, 0]], speed: 1, modelURL: nil,
            makeEngine: { pass in LoggingProbeEngine(pass: pass, log: log, unavailable: pass == .coreml) },
            isForeground: { false }, inFlight: ProbeInFlight(url: tempURL()))
        let passes = result["passes"] as? [[String: Any]] ?? []
        XCTAssertEqual(passes.count, 2)
        XCTAssertEqual(passes[0]["ok"] as? Bool, true)
        XCTAssertEqual(passes[1]["ok"] as? Bool, false)
        XCTAssertEqual(passes[1]["reason"] as? String, "coreml-unavailable")
        XCTAssertEqual(passes[1]["pass"] as? String, "coreml")
        XCTAssertNil(passes[1]["lineOutcomes"], "nothing ran, so no chunk outcome is claimed")
        XCTAssertTrue(log.events.contains("close coreml"), "even a pass that never ran releases what it built")
    }

    /// **Chunks are flattened in passage order; a line with no chunk ids is
    /// unphonemized.** MUTATION: read only line-level `ids` — the chunked
    /// passage this build ships is refused as `passage-unphonemized`.
    func testChunkIdsFlattensEveryLinesChunksInOrder() {
        let lines: [[String: Any]] = [
            ["chunks": [["ids": [0, 1, 0]], ["ids": [0, 2, 0]]]],
            ["chunks": [["ids": [0, 3, 0]]]],
        ]
        XCTAssertEqual(ForayTtsPlugin.chunkIds(lines), [[0, 1, 0], [0, 2, 0], [0, 3, 0]])
        XCTAssertEqual(ForayTtsPlugin.chunkIds([["ids": [0, 9, 0]]]), [[0, 9, 0]], "an older whole-line passage is one chunk")
        XCTAssertNil(ForayTtsPlugin.chunkIds([["chunks": [["ids": [Int]()]]]]))
        XCTAssertNil(ForayTtsPlugin.chunkIds([["text": "no ids"]]))
    }

    /// **A run the system killed is reported by the next one** (the card's
    /// stop rule: "report the last logged peak"). MUTATION: clear the marker
    /// at the start of a run instead of reading it first.
    func testAKilledRunsLastPassChunkAndPeakReachTheNextRunsFirstRecord() {
        let url = tempURL()
        ProbeInFlight(url: url).note(pass: .coreml, chunk: 6, peakBytes: 1_400_000_000)
        let result = ForayTtsPlugin.measurePasses(
            passes: [.cpu], idLines: [[0, 1, 2, 0]], speed: 1, modelURL: nil,
            makeEngine: { pass in LoggingProbeEngine(pass: pass, log: EventLog()) },
            isForeground: { false }, inFlight: ProbeInFlight(url: url))
        let first = (result["passes"] as? [[String: Any]] ?? []).first ?? [:]
        XCTAssertEqual(first["prevKilledPass"] as? String, "coreml")
        XCTAssertEqual(first["prevKilledChunk"] as? Int, 6)
        XCTAssertEqual(first["prevKilledPeakBytes"] as? Double, 1_400_000_000)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path), "a run that finished leaves no marker")
    }

    private func tempURL() -> URL {
        URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("kvr2-\(UUID().uuidString).txt")
    }

    /// **Every SYNTH_REASONS code has a line token.**
    func testLineOutcomeTokens() {
        XCTAssertEqual(ForayTtsPlugin.lineOutcome(nil), "ok")
        XCTAssertEqual(ForayTtsPlugin.lineOutcome("inference-threw"), "threw")
        XCTAssertEqual(ForayTtsPlugin.lineOutcome("no-output"), "no-output")
        XCTAssertEqual(ForayTtsPlugin.lineOutcome("zero-samples"), "zero")
        XCTAssertEqual(ForayTtsPlugin.lineOutcome("non-finite"), "nan")
        XCTAssertEqual(ForayTtsPlugin.lineOutcome("silent"), "silent")
        XCTAssertEqual(ForayTtsPlugin.lineOutcome("session-absent"), "skip")
    }
}

/// An ordered record of what the pass loop did to its engines.
private final class EventLog {
    private(set) var events: [String] = []
    func add(_ event: String) { events.append(event) }
}

/// A fake engine per pass that logs load and close, renders 2 s per chunk,
/// and can play an unregistered CoreML EP.
private final class LoggingProbeEngine: KokoroProbeEngine {
    let modelName = "fake"
    let provider: String
    let providerUnavailable: Bool
    private let log: EventLog
    init(pass: KokoroProbePass, log: EventLog, unavailable: Bool = false) {
        provider = pass.rawValue
        providerUnavailable = unavailable
        self.log = log
    }
    func load() -> (coldMs: Double, warmMs: Double) { log.add("load \(provider)"); return (1, 1) }
    func synthesize(ids: [Int], speed: Double) -> (synthMs: Double, audioSec: Double, reason: String?) { (100, 2, nil) }
    func close() { log.add("close \(provider)") }
}

/// Every line throws, the way the 2026-09-26 paste's phone did.
private final class ThrowingProbeEngine: KokoroProbeEngine {
    let modelName = "fake"
    let provider = "cpu"
    func load() -> (coldMs: Double, warmMs: Double) { (457, 374) }
    func synthesize(ids: [Int], speed: Double) -> (synthMs: Double, audioSec: Double, reason: String?) {
        (0, 0, "inference-threw")
    }
    var lastFailure: KokoroProbeFailure? { KokoroProbeFailure(code: "not-implemented", op: "ConvTranspose", stage: "run") }
    var loadError: String? { "no-model" }
}

/// Answers each line with the next scripted reason; a nil reason is 2 s of
/// audio, and a failed line CLAIMS 2 s too, which the plugin must ignore.
private final class ScriptedProbeEngine: KokoroProbeEngine {
    let modelName = "fake"
    let provider = "cpu"
    private var reasons: [String?]
    init(reasons: [String?]) { self.reasons = reasons }
    func load() -> (coldMs: Double, warmMs: Double) { (1, 1) }
    func synthesize(ids: [Int], speed: Double) -> (synthMs: Double, audioSec: Double, reason: String?) {
        let reason = reasons.isEmpty ? nil : reasons.removeFirst()
        return (100, 2, reason)
    }
}
