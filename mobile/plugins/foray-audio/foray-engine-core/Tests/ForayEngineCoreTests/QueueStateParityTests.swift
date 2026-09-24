import XCTest
import ForayEngineCore
import ForayEngineParity

/// Card NE-07s's own proofs, beside the fixture family that is its contract.
///
/// The queue-state family (run by `ParityFamilyTests.testQueueStateFamily`)
/// is what says the reducer matches player/queue-state.js. These tests say
/// that verdict can be trusted: a broken reducer turns a NAMED case red (the
/// card's mutation, kept as a test so it stays proved), and the telemetry
/// spellings hold where no fixture reaches (bounds past 2^53, half-way values).
final class QueueStateParityTests: XCTestCase {
    private func queueStateResults(reduce: @escaping QueueStateFamily.Reduce) throws -> [String: CaseResult] {
        let data = try ParityData.load(parityDir: try ParityLocator.locate())
        let report = ParitySuite(data: data, runners: [QueueStateFamily.makeRunner(reduce: reduce)]).run()
        var byId: [String: CaseResult] = [:]
        for result in report.results(for: "queue-state") { byId[result.id] = result }
        return byId
    }

    private let namedCase = "queue-state/item-loaded-episode-restores-rate"

    /// THE CARD'S MUTATION: swap two effects in itemLoaded and a named case
    /// goes red. Array order is significant to the comparator (plan §6), and
    /// here it is the rule itself: `restoreRate` must land BEFORE
    /// `startPlayback`, or the first audible moment plays at the wrong rate.
    func testSwappingTwoItemLoadedEffectsTurnsANamedCaseRed() throws {
        let real: QueueStateFamily.Reduce = { PlayerQueueState.reduce(state: $0, event: $1) }
        let control = try queueStateResults(reduce: real)
        XCTAssertEqual(control[namedCase]?.outcome, .passed, control[namedCase]?.detail ?? "missing")

        let mutated = try queueStateResults(reduce: { state, event in
            let (next, original) = PlayerQueueState.reduce(state: state, event: event)
            var effects = original
            if event == .itemLoaded, effects.count >= 2 { effects.swapAt(0, 1) }
            return (next, effects)
        })
        XCTAssertEqual(mutated[namedCase]?.outcome, .failed,
                       "swapping restoreRate and startPlayback must fail \(namedCase)")
    }

    /// The seek and out-point effects ride in a fixed order too: rate, then
    /// the queued seek, then the out-point, then play. Arming the out-point
    /// before the seek would arm it against 0:00.
    func testDroppingThePendingSeekTurnsTheSeekCasesRed() throws {
        let mutated = try queueStateResults(reduce: { state, event in
            let (next, original) = PlayerQueueState.reduce(state: state, event: event)
            var effects = original
            effects.removeAll { if case .seekTo = $0 { return event == .itemLoaded } else { return false } }
            return (next, effects)
        })
        let red = mutated.values.filter { $0.outcome == .failed }.map(\.id)
        XCTAssertFalse(red.isEmpty, "a reducer that forgets its pendingSeek must fail some queue-state case")
    }

    /// Two segments of ONE episode are two items (sameRef includes bounds):
    /// playing the second while the first plays is a real switch, not an
    /// idempotent repeat. Treating them as one would silently drop the next
    /// segment of a Foray.
    func testASecondSegmentOfTheSameEpisodeIsANewItem() throws {
        let first = QueueItemRef(id: "ep-x", kind: .episode, bounds: ItemBounds.make(startSec: 60, endSec: 140))
        let second = QueueItemRef(id: "ep-x", kind: .episode, bounds: ItemBounds.make(startSec: 400, endSec: 512))
        XCTAssertFalse(QueueItemRef.sameRef(first, second))
        XCTAssertTrue(QueueItemRef.sameRef(first, first))
        XCTAssertTrue(QueueItemRef.sameRef(nil, nil))
        XCTAssertFalse(QueueItemRef.sameRef(first, nil))
        let (state, effects) = PlayerQueueState.reduce(state: .playing(item: first), event: .play(second))
        XCTAssertEqual(state, .loadingItem(target: second, previous: first))
        XCTAssertEqual(effects.first, .pausePlayback)
    }

    /// `${Math.round(x)}` past the values any fixture holds. The expected
    /// strings are what node prints for the same numbers:
    /// `String(Math.round(2 ** 60))` is "1152921504606847000" (the shortest
    /// digits, zero-padded), `Math.round(0.49999999999999994)` is 0 and
    /// `Math.round(2.5)` is 3.
    func testSegmentLabelsSpellNumbersTheWayJavaScriptDoes() throws {
        func label(_ start: Double, _ end: Double) throws -> String {
            let bounds = try XCTUnwrap(ItemBounds.make(startSec: start, endSec: end))
            return PlayerQueueStateMachine.describe(.playing(item: QueueItemRef(id: "s", kind: .episode, bounds: bounds)))
        }
        XCTAssertEqual(try label(100, 210), "playing(s[100-210])")
        XCTAssertEqual(try label(0.49999999999999994, 2.5), "playing(s[0-3])")
        XCTAssertEqual(try label(0, 9_007_199_254_740_994), "playing(s[0-9007199254740994])")
        XCTAssertEqual(try label(0, 1_152_921_504_606_846_976), "playing(s[0-1152921504606847000])")
        XCTAssertEqual(try label(0, 1e21), "playing(s[0-1e+21])")
        XCTAssertEqual(PlayerQueueStateMachine.describe(.interrupted(item: QueueItemRef(id: "a", kind: .tts), wasPlaying: false)),
                       "interrupted(a, wasPlaying: false)")
    }
}
