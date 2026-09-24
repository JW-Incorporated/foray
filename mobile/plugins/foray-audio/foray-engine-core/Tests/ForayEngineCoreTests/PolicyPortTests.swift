import XCTest
import ForayEngineCore
import ForayEngineParity

/// The parts of NE-09's ports that no parity case can reach on its own: the
/// JavaScript arithmetic they are built on (`JSMath`, the runners' ToNumber),
/// the snap decision `setRate` makes from two ported rules, and the closed
/// token sets against the generated constants. The RULES themselves are the
/// rate / resume-rules / transport families (ParityFamilyTests); these pin the
/// ground those families stand on, so a red family means the rule, not the
/// arithmetic under it.
final class PolicyPortTests: XCTestCase {
    // MARK: JSMath, where Swift's own answer differs from JavaScript's

    /// TO SEE IT FAIL: implement `JSMath.max` as `Swift.max` (0 and -0 for the
    /// first two, since Swift drops the NaN and keeps the second zero).
    func testMaxAndMinPropagateNaNAndOrderSignedZeroesAsJavaScriptDoes() {
        XCTAssertTrue(JSMath.max(0, .nan).isNaN)
        XCTAssertTrue(JSMath.min(.nan, 1).isNaN)
        XCTAssertEqual(JSMath.max(0, -0.0).sign, .plus, "Math.max(0, -0) is +0")
        XCTAssertEqual(JSMath.max(-0.0, 0).sign, .plus)
        XCTAssertEqual(JSMath.max(-0.0, -0.0).sign, .minus)
        XCTAssertEqual(JSMath.min(0, -0.0).sign, .minus, "Math.min(0, -0) is -0")
        XCTAssertEqual(JSMath.max(3, 7), 7)
        XCTAssertEqual(JSMath.min(3, 7), 3)
    }

    /// TO SEE IT FAIL: implement `JSMath.round` as `x.rounded()` (-2.5 -> -3)
    /// or as `(x + 0.5).rounded(.down)` (0.49999999999999994 -> 1).
    func testRoundBreaksTiesUpwardsAndKeepsTheSignOfZero() {
        XCTAssertEqual(JSMath.round(125.4), 125)
        XCTAssertEqual(JSMath.round(125.5), 126)
        XCTAssertEqual(JSMath.round(-2.5), -2)
        XCTAssertEqual(JSMath.round(-2.6), -3)
        XCTAssertEqual(JSMath.round(0.49999999999999994), 0)
        XCTAssertEqual(JSMath.round(-0.4).sign, .minus, "Math.round(-0.4) is -0")
        XCTAssertEqual(JSMath.round(-0.5).sign, .minus, "Math.round(-0.5) is -0")
        XCTAssertTrue(JSMath.round(.nan).isNaN)
        XCTAssertEqual(JSMath.round(.infinity), .infinity)
    }

    // MARK: ToNumber, which the runners use to translate a case's arguments

    /// TO SEE IT FAIL: make `stringToNumber` return `Double(text) ?? .nan`
    /// (" 42 " and "" go NaN; "inf" and "nan" stop being NaN).
    func testStringToNumberIsECMAScriptsNotSwifts() {
        XCTAssertEqual(JSCoercion.stringToNumber(" 42 "), 42)
        XCTAssertEqual(JSCoercion.stringToNumber(""), 0)
        XCTAssertEqual(JSCoercion.stringToNumber("0x10"), 16)
        XCTAssertEqual(JSCoercion.stringToNumber("1e3"), 1000)
        XCTAssertEqual(JSCoercion.stringToNumber(".5"), 0.5)
        XCTAssertEqual(JSCoercion.stringToNumber("-Infinity"), -.infinity)
        XCTAssertEqual(JSCoercion.stringToNumber("-0").sign, .minus)
        for junk in ["inf", "nan", "Infinityx", "later", "1e", "-0x10", "1.2.3"] {
            XCTAssertTrue(JSCoercion.stringToNumber(junk).isNaN, "\(junk) must be NaN")
        }
        XCTAssertTrue(JSValue.undefined.toNumber.isNaN)
        XCTAssertEqual(JSValue.null.toNumber, 0)
        XCTAssertEqual(JSValue.array([]).toNumber, 0)
        XCTAssertEqual(JSValue.array([.string("7")]).toNumber, 7)
        XCTAssertTrue(JSValue.object([:]).toNumber.isNaN)
    }

    // MARK: PlaybackRate

    /// `setRate`'s decision: the applied rate is `normalizeRate`'s and
    /// `snapped` is `!isRate`, so a stale stored rate is always SAID (the
    /// row itself is NE-14s's). TO SEE IT FAIL: compute `snapped` as
    /// `requested.map { $0 != applied } ?? false` (a missing request then
    /// reads as "not snapped", though the listener asked for nothing usable).
    func testSnapSaysWhenTheRequestWasNotAStop() {
        XCTAssertEqual(PlaybackRate.snap(1.5), PlaybackRate.Snap(applied: 1.5, snapped: false))
        XCTAssertEqual(PlaybackRate.snap(1.6), PlaybackRate.Snap(applied: 1.5, snapped: true))
        XCTAssertEqual(PlaybackRate.snap(3), PlaybackRate.Snap(applied: 2, snapped: true))
        XCTAssertEqual(PlaybackRate.snap(nil), PlaybackRate.Snap(applied: 1, snapped: true))
        XCTAssertEqual(PlaybackRate.snap(.nan), PlaybackRate.Snap(applied: 1, snapped: true))
    }

    /// The port reads the generated ladder: a port with its own copy would
    /// pass today and fork tomorrow.
    func testTheLadderIsTheGeneratedOne() {
        XCTAssertEqual(PlaybackRate.rates, EngineConstants.PlaybackRate.rates)
        XCTAssertEqual(PlaybackRate.defaultRate, EngineConstants.PlaybackRate.defaultRate)
    }

    // MARK: TransportPolicy's closed tokens

    /// The enums' raw values are the JS tokens; the generated constants are
    /// the JS tokens too, so they must agree case for case. TO SEE IT FAIL:
    /// rename `.itemBefore`'s raw value.
    func testTransportTokensAreTheGeneratedOnes() {
        typealias T = EngineConstants.Transport
        XCTAssertEqual(Set(TransportPolicy.Toggle.allCases.map(\.rawValue)),
                       [T.Toggle.playRestored, T.Toggle.startOver, T.Toggle.none, T.Toggle.load,
                        T.Toggle.resume, T.Toggle.pause])
        XCTAssertEqual(Set(TransportPolicy.Previous.allCases.map(\.rawValue)),
                       [T.Previous.itemBefore, T.Previous.manager])
        XCTAssertEqual(Set(TransportPolicy.Seek.allCases.map(\.rawValue)), [T.Seek.pend, T.Seek.seek])
        XCTAssertEqual(Set(TransportPolicy.RemoteStop.allCases.map(\.rawValue)),
                       [T.RemoteStop.close, T.RemoteStop.pause])
        XCTAssertEqual(TransportPolicy.restartWindowSec, T.restartWindowSec)
    }
}
