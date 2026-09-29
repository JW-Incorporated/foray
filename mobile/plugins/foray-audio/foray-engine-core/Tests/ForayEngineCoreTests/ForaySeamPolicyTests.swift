import XCTest
import ForayEngineCore

/// NE-28s: what the interlude, seek-policy and outpoint parity families cannot
/// reach on their own. The RULES are the families (ParityFamilyTests); these
/// pin the ground under them: the ports read the GENERATED constants (a port
/// with its own copy would pass today and fork tomorrow), their closed tokens
/// are the JS tokens, and the reducer's invariants hold on inputs no fixture
/// spells.
final class ForaySeamPolicyTests: XCTestCase {
    func testThePortsReadTheGeneratedConstants() {
        XCTAssertEqual(Interlude.ceilingSec, EngineConstants.Interlude.interludeCeilingSec)
        XCTAssertEqual(Interlude.durationSec, EngineConstants.Interlude.interludeDurationSec)
        XCTAssertEqual(Interlude.rate, EngineConstants.Interlude.interludeRate)
        XCTAssertEqual(SeekPolicy.driftToleranceSec, EngineConstants.SeekPolicy.driftToleranceSec)
        XCTAssertEqual(SeekPolicy.adPadCeilingSec, EngineConstants.SeekPolicy.adPadCeilingSec)
        XCTAssertEqual(DeckPolicy.outPointWatchdogWindowSec, EngineConstants.DeckPolicy.outPointWatchdogWindowSec)
        XCTAssertEqual(DeckPolicy.outPointWatchdogPollMs, EngineConstants.DeckPolicy.outPointWatchdogPollMs)
    }

    /// TO SEE IT FAIL: rename `.padded`'s or `.watchdog`'s raw value.
    func testTheClosedTokensAreTheGeneratedOnes() {
        typealias S = EngineConstants.SeekPolicy
        XCTAssertEqual(Set(SeekPolicy.Precision.allCases.map(\.rawValue)), [S.exact, S.approximate, S.padded])
        typealias D = EngineConstants.DeckPolicy
        XCTAssertEqual(Set(DeckPolicy.OutPointLayer.allCases.map(\.rawValue)),
                       [D.OutPointLayer.endTime, D.OutPointLayer.boundary, D.OutPointLayer.watchdog])
        XCTAssertEqual(Set(DeckPolicy.WatchdogWake.allCases.map(\.rawValue)), [D.WatchdogWake.stop, D.WatchdogWake.rearm])
    }

    /// `nonEmpty` is `s.trim().length > 0` and ECMAScript's trim strips the
    /// no-break space and the BOM, which Swift's whitespace set does not all
    /// agree on. Two cuts keyed by blank ids are two UNIDENTIFIED items, so the
    /// jingle still plays between them. TO SEE IT FAIL: test `key.isEmpty`.
    func testABlankKeyIsNoKey() {
        let a = InterludeItem(kind: "episode", sourceItemId: "\u{00A0}\u{FEFF}", startSec: 100, endSec: 210)
        let b = InterludeItem(kind: "episode", sourceItemId: "\u{00A0}\u{FEFF}", startSec: 100, endSec: 210)
        XCTAssertEqual(Interlude.sourceKey(a), .episode(""))
        XCTAssertFalse(Interlude.sameSourceEpisode(a, b))
        XCTAssertTrue(Interlude.eligible(from: a, to: b))
    }

    /// NEVER EARLY: whatever a layer or the watchdog reports, the reducer only
    /// ever stops at or past the boundary. Walk the playhead across it in
    /// 1 ms steps with every layer reporting at every step. TO SEE IT FAIL:
    /// make `.layer` stop without the `atSec < outPointSec` check.
    func testNoLayerEverStopsBeforeTheBoundary() {
        for layer in [DeckPolicy.OutPointLayer.endTime, .boundary] {
            var watch = DeckPolicy.outPointStep(DeckPolicy.OutPointWatch(), .load(token: 1, outPointSec: 210, atSec: 209.99)).state
            watch = DeckPolicy.outPointStep(watch, .play(atSec: 209.99, nowMs: 0)).state
            var stoppedAt: Double?
            for step in 0...20 {
                let at = 209.99 + Double(step) / 1000
                let result = DeckPolicy.outPointStep(watch, .layer(layer, token: 1, atSec: at, nowMs: Double(step)))
                watch = result.state
                if stoppedAt == nil, result.ops.contains(where: { if case .stop = $0 { return true }; return false }) {
                    stoppedAt = at
                }
            }
            XCTAssertNotNil(stoppedAt, "\(layer) never stopped")
            XCTAssertGreaterThanOrEqual(stoppedAt ?? 0, 210)
        }
    }

    /// The watchdog's timer never wakes before the window opens, and never
    /// asks for less than the timer floor.
    func testTheWatchdogDelayIsNeverBelowTheFloor() {
        for rate in [0.5, 1, 1.25, 1.5, 2] {
            var at = 0.0
            while at < 210 {
                if let delay = DeckPolicy.watchdogDelayMs(outPointSec: 210, atSec: at, rate: rate) {
                    XCTAssertGreaterThanOrEqual(delay, DeckPolicy.outPointMinTimerMs)
                }
                at += 0.0937
            }
        }
    }
}
