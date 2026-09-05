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
}
