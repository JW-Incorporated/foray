import XCTest
import ForayEngineCore
@testable import ForayAudioPlugin

/// DeckPair's routing, headless (card NE-32): two recording decks, no
/// AVFoundation, so every rule is deterministic. The Simulator half (real
/// AVDecks on the click tracks: seam silence, never early, the rate across
/// swaps, the watchdog's window) is `DeckPairSeamTests`.
///
/// Each test names the rule it guards and the edit that turns it red.
final class DeckPairTests: XCTestCase {

    /// A deck that records what it was told and reports what the test says.
    final class FakePairDeck: PairableDeck {
        let name: String
        let journal: Journal
        var onEvent: ((DeckEvent) -> Void)?
        var reading = DeckReading()
        var isReady = false
        var loadedURL: String?
        var prepareWindowAvailable = false
        /// A deck whose pause does not take (the swap must then be refused).
        var stuckAudible = false
        private(set) var sent: [DeckCommand] = []
        private(set) var adopted: [DeckToken] = []
        private(set) var invalidated = false

        init(_ name: String, journal: Journal) {
            self.name = name
            self.journal = journal
        }

        func send(_ command: DeckCommand) {
            sent.append(command)
            journal.entries.append("\(name).\(command.logName)")
            switch command {
            case let .load(_, _, url, startSec, _):
                loadedURL = url
                isReady = false
                reading = DeckReading(positionSec: startSec, durationSec: nil, audible: false, ended: false)
            case .play:
                reading.audible = true
            case .pause:
                if !stuckAudible { reading.audible = false }
            case .unload:
                loadedURL = nil
                isReady = false
                reading = DeckReading()
            default:
                break
            }
        }

        func adopt(token: DeckToken) {
            adopted.append(token)
            journal.entries.append("\(name).adopt:\(token)")
        }

        func invalidate() {
            invalidated = true
        }

        /// The load the pair issued on this deck most recently.
        var lastLoadToken: DeckToken? {
            for command in sent.reversed() {
                if case let .load(token, _, _, _, _) = command { return token }
            }
            return nil
        }

        func count(_ name: String) -> Int { sent.filter { $0.logName == name }.count }

        /// The deck's load became ready at `atSec` (prerolled).
        func becomeReady(_ token: DeckToken, atSec: Double, duration: Double = 90) {
            isReady = true
            reading.positionSec = atSec
            reading.durationSec = duration
            onEvent?(.durationLoaded(token: token, durationSec: duration))
            onEvent?(.ready(token: token, landedSec: atSec, prerolled: true, elapsedMs: 30))
        }
    }

    final class Journal {
        var entries: [String] = []
    }

    private let urlA = "https://cdn.test/a.mp3"
    private let urlB = "https://cdn.test/b.mp3"
    private let urlC = "https://cdn.test/c.mp3"

    private var journal = Journal()
    private var a: FakePairDeck!
    private var b: FakePairDeck!
    private var pair: DeckPair!
    private var events: [DeckEvent] = []
    private var rows: [DiagEntry] = []

    override func setUp() {
        super.setUp()
        journal = Journal()
        a = FakePairDeck("A", journal: journal)
        b = FakePairDeck("B", journal: journal)
        events = []
        rows = []
        pair = DeckPair(a, b, config: DeckPair.Config(diag: { [unowned self] in self.rows.append($0) }))
        pair.onEvent = { [unowned self] in self.events.append($0) }
    }

    /// A playing item "a" on deck A (core token 1) with the standby asked to
    /// prepare "b" at 300 s.
    @discardableResult
    private func playingWithPrepare(readyStandby: Bool = true) -> DeckToken {
        pair.send(.load(token: 1, itemId: "a", url: urlA, startSec: 100, preciseTiming: true))
        a.becomeReady(1, atSec: 100)
        pair.send(.play)
        pair.send(.prepare(itemId: "b", url: urlB, startSec: 300))
        let warm = b.lastLoadToken ?? 0
        if readyStandby { b.becomeReady(warm, atSec: 300) }
        return warm
    }

    private func prepared(_ token: DeckToken) -> (hit: Bool, stages: [Vocabulary.Stage])? {
        for event in events {
            if case let .prepared(t, hit, stages) = event, t == token { return (hit, stages) }
        }
        return nil
    }

    // MARK: - prepare

    /// The standby deck loads the next item at its in-point, through its own
    /// readiness-gated pipeline, at the listener's rate, with a token of its
    /// own, and NOTHING it reports reaches the core.
    /// TO SEE IT FAIL: forward the standby's events, or load it on deck A.
    func testAPrepareLoadsTheStandbyAtItsInPointAndTheCoreHearsNothingOfIt() {
        pair.send(.setRate(1.5))
        let warm = playingWithPrepare()
        XCTAssertLessThan(warm, 0, "a warm token can never be one of the core's")
        XCTAssertEqual(b.sent, [.setRate(1.5), .setRate(1.5),
                                .load(token: warm, itemId: "b", url: urlB, startSec: 300, preciseTiming: true)])
        XCTAssertEqual(a.count("load"), 1, "the player is left alone")
        XCTAssertFalse(events.contains { if case let .ready(t, _, _, _) = $0 { return t == warm }; return false },
                       "the standby's ready is the pair's, not the core's")
        XCTAssertEqual(events.count, 2, "only deck A's durationLoaded and ready reached the core: \(events)")
    }

    /// `prefetchDecision`: the same source the player holds is a seek, not a
    /// refetch; an item already warm is not fetched twice; no url, nothing.
    func testTheStandbyIsNotWarmedForTheSameEpisodeTwiceOrWithoutAUrl() {
        pair.send(.load(token: 1, itemId: "a", url: urlA, startSec: 100, preciseTiming: true))
        pair.send(.prepare(itemId: "a2", url: urlA, startSec: 900))
        pair.send(.prepare(itemId: "x", url: nil, startSec: 0))
        XCTAssertEqual(b.count("load"), 0)
        pair.send(.prepare(itemId: "b", url: urlB, startSec: 300))
        pair.send(.prepare(itemId: "b", url: urlB, startSec: 300))
        XCTAssertEqual(b.count("load"), 1, "already warm")
    }

    // MARK: - the boundary

    /// A HIT: the handover in `DeckPolicy.handoverSteps` order (the outgoing
    /// deck paused BEFORE the roles swap and the identity is adopted), the
    /// core hears `.prepared(hit)` and `.ready` for ITS token at once, nothing
    /// loads on the player, and no step plays.
    /// TO SEE IT FAIL: swap before pausing; skip `adopt`; play in the handover.
    func testAHitPromotesTheStandbyInHandoverOrderAndAnswersAtOnce() {
        pair.send(.setRate(2))
        let warm = playingWithPrepare()
        journal.entries.removeAll()
        a.onEvent?(.ended(token: 1))
        pair.send(.load(token: 2, itemId: "b", url: urlB, startSec: 300, preciseTiming: true))

        XCTAssertEqual(journal.entries, ["A.pause", "B.adopt:2", "B.setRate"], "pause-outgoing, adopt-identity, carry-rate")
        XCTAssertEqual(pair.handoverLog.filter { $0.hasPrefix("handover:") },
                       DeckPolicy.handoverSteps().map { "handover:\($0.rawValue)" })
        XCTAssertEqual(b.adopted, [2])
        XCTAssertEqual(a.count("load"), 1, "a hit loads nothing")
        XCTAssertEqual(b.count("play"), 0)
        XCTAssertEqual(pair.activeIndex, 1)
        XCTAssertEqual(pair.swaps, 1)
        XCTAssertEqual(b.sent.last, .setRate(2), "the rate is carried onto the deck that inherits the role")
        let report = prepared(2)
        XCTAssertEqual(report?.hit, true)
        XCTAssertEqual(report?.stages, [.attach, .duration, .readiness, .seek, .preroll, .ready])
        XCTAssertTrue(events.contains(.ready(token: 2, landedSec: 300, prerolled: true, elapsedMs: 0)), "\(events)")
        XCTAssertLessThan(warm, 0)

        // From now on the core's commands go to B, and only B's events reach it.
        pair.send(.play)
        XCTAssertEqual(b.count("play"), 1)
        XCTAssertEqual(pair.reading, b.reading)
        let before = events.count
        a.onEvent?(.ended(token: 1))
        a.onEvent?(.timeControl(token: 1, status: .paused, waitingReason: nil))
        XCTAssertEqual(events.count, before, "the outgoing deck's late events never reach the core")
        b.onEvent?(.timeControl(token: 2, status: .playing, waitingReason: nil))
        XCTAssertEqual(events.last, .timeControl(token: 2, status: .playing, waitingReason: nil))
    }

    /// A MISS: a standby still loading at the boundary is forgotten and the
    /// load runs as an ordinary load on the player; the core hears
    /// `.prepared(hit: false)` with the stages the standby reached.
    /// TO SEE IT FAIL: promote a warm load that is not ready.
    func testAMissDegradesToAnOrdinaryLoadAndSaysWhereItMissed() {
        playingWithPrepare(readyStandby: false)
        pair.send(.load(token: 2, itemId: "b", url: urlB, startSec: 300, preciseTiming: true))
        XCTAssertEqual(a.lastLoadToken, 2, "the ordinary load, on the player")
        XCTAssertEqual(pair.activeIndex, 0)
        XCTAssertEqual(pair.swaps, 0)
        XCTAssertEqual(prepared(2)?.hit, false)
        XCTAssertEqual(prepared(2)?.stages, [.attach])
        XCTAssertTrue(pair.handoverLog.contains("promotion:not-ready"))
        XCTAssertTrue(rows.contains { $0.kind == "prepare" && $0[field: "reason"] == .string("not-ready") })
    }

    /// Readiness is re-asserted at the boundary: a warm deck at the wrong
    /// in-point, or one that drifted off it, is never promoted.
    func testAWrongOffsetOrADriftedWarmDeckIsNotPromoted() {
        let warm = playingWithPrepare()
        pair.send(.load(token: 2, itemId: "b", url: urlB, startSec: 600, preciseTiming: true))
        XCTAssertEqual(a.lastLoadToken, 2)
        XCTAssertTrue(pair.handoverLog.contains("promotion:wrong-offset"))

        pair.send(.prepare(itemId: "c", url: urlC, startSec: 40))
        let second = b.lastLoadToken ?? 0
        XCTAssertNotEqual(second, warm, "every warm load has its own token")
        b.becomeReady(second, atSec: 40)
        b.reading.positionSec = 0
        pair.send(.load(token: 3, itemId: "c", url: urlC, startSec: 40, preciseTiming: true))
        XCTAssertEqual(a.lastLoadToken, 3)
        XCTAssertTrue(pair.handoverLog.contains("promotion:drifted"))
    }

    /// A skip to an item that was never prepared is an ordinary load, not a
    /// "miss" of the prepare: no `.prepared` report.
    func testASkipElsewhereIsNotReportedAsAMiss() {
        playingWithPrepare()
        pair.send(.load(token: 2, itemId: "c", url: urlC, startSec: 10, preciseTiming: true))
        XCTAssertEqual(a.lastLoadToken, 2)
        XCTAssertNil(prepared(2))
    }

    /// NEVER TWO AUDIBLE: when the outgoing deck will not confirm paused, the
    /// roles do not swap and the load degrades.
    /// TO SEE IT FAIL: drop the audible check after `pause-outgoing`.
    func testTheRolesDoNotSwapWhileTheOutgoingDeckStillSounds() {
        playingWithPrepare()
        a.stuckAudible = true
        pair.send(.load(token: 2, itemId: "b", url: urlB, startSec: 300, preciseTiming: true))
        XCTAssertEqual(pair.activeIndex, 0)
        XCTAssertEqual(b.adopted, [])
        XCTAssertEqual(a.lastLoadToken, 2)
        XCTAssertEqual(prepared(2)?.hit, false)
        XCTAssertTrue(pair.handoverLog.contains("handover:refused-outgoing-audible"))
    }

    // MARK: - stand-down, rate, release

    /// `unexplainedPauseAction`: an uncommanded pause while a warm load is IN
    /// FLIGHT stands warming down for good; it is still reported to the core.
    func testAnUncommandedPauseDuringAWarmLoadStandsWarmingDown() {
        playingWithPrepare(readyStandby: false)
        a.onEvent?(.pausedUncommanded(token: 1, atSec: 150))
        XCTAssertEqual(events.last, .pausedUncommanded(token: 1, atSec: 150), "reported")
        XCTAssertFalse(pair.available)
        XCTAssertFalse(a.prepareWindowAvailable)
        pair.send(.prepare(itemId: "c", url: urlC, startSec: 10))
        XCTAssertEqual(b.count("load"), 1, "no warming after a stand-down")
    }

    /// A warm load that is already READY is not evidence: the pause is an
    /// ordinary one and warming stays.
    func testAPauseAfterTheWarmLoadIsReadyKeepsWarming() {
        playingWithPrepare()
        a.onEvent?(.pausedUncommanded(token: 1, atSec: 150))
        XCTAssertTrue(pair.available)
    }

    /// Unload is a release (a relinquish or a media-services reset): both
    /// decks let go, the warm buffer too.
    func testUnloadReleasesBothDecks() {
        playingWithPrepare()
        pair.send(.unload)
        XCTAssertEqual(a.count("unload"), 1)
        XCTAssertEqual(b.count("unload"), 1)
        pair.send(.load(token: 2, itemId: "b", url: urlB, startSec: 300, preciseTiming: true))
        XCTAssertEqual(a.lastLoadToken, 2, "nothing warm survives a release")
    }

    /// Teardown reaches both decks, and nothing is routed afterwards.
    func testInvalidateTearsDownBothDecks() {
        pair.invalidate()
        XCTAssertTrue(a.invalidated)
        XCTAssertTrue(b.invalidated)
        pair.send(.play)
        XCTAssertEqual(a.count("play"), 0)
    }

    /// The prefetch window belongs to the deck with the player role, and moves
    /// with it.
    func testThePrefetchWindowFollowsThePlayerRole() {
        XCTAssertTrue(a.prepareWindowAvailable)
        XCTAssertFalse(b.prepareWindowAvailable)
        playingWithPrepare()
        pair.send(.load(token: 2, itemId: "b", url: urlB, startSec: 300, preciseTiming: true))
        XCTAssertFalse(a.prepareWindowAvailable)
        XCTAssertTrue(b.prepareWindowAvailable)
    }
}
