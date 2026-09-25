import Foundation
import ForayEngineCore

/// What the DeckPair needs from each of its decks beyond the `DeckDriving`
/// seam: whether its load is ready NOW (readiness is re-asserted at the
/// boundary, never trusted), which source it holds, the prefetch window's
/// switch, and the handover's `adopt-identity` step. AVDeck conforms; the
/// headless tests drive the pair with recording fakes.
protocol PairableDeck: DeckDriving {
    var isReady: Bool { get }
    var loadedURL: String? { get }
    var prepareWindowAvailable: Bool { get set }
    func adopt(token: DeckToken)
}

extension AVDeck: PairableDeck {}

/// Two decks, at most one audible, the standby one prepared at the next
/// segment's in-point while the other plays (card NE-32;
/// docs/native-engine-plan.md §4.3, P-10). Behind `EngineConfig
/// .deckPairEnabled`, OFF until NE-37: with it off the engine plays through
/// one AVDeck exactly as in M1.
///
/// IT SITS BEHIND THE SAME SEAM AS ONE DECK. The core speaks `DeckCommand`s
/// to "the deck" and hears `DeckEvent`s; the pair routes them:
///
///   - `.prepare(item, url, in-point)` (the core's answer to the playing
///     deck's `.prepareWindow`) loads the STANDBY deck through AVDeck's own
///     readiness-gated pipeline: duration, both statuses `.readyToPlay`, a
///     zero-tolerance seek to the in-point, `preroll` at rate 0. Its events
///     never reach the core; they only move the warm load's state and its
///     stage list. Whether to warm at all is `DeckPolicy.prefetchDecision`.
///   - `.load` at the boundary asks `DeckPolicy.warmPromotion`: a warm deck
///     that is ready, holds the same source at the same in-point, can play
///     NOW and has not drifted is PROMOTED by the handover
///     (`DeckPolicy.handoverSteps`, in its order), and the core hears
///     `.prepared(hit: true)` and `.ready` at once. Anything else is a MISS:
///     the warm load is forgotten (its buffer kept, `discardFreesBuffer`),
///     `.prepared(hit: false)` names the stages it reached, and the load runs
///     as an ordinary load on the deck that holds the player role.
///   - everything else goes to the deck that holds the player role; a rate
///     goes to BOTH (the standby primes at the listener's rate, and the
///     handover carries it again).
///
/// NEVER TWO AUDIBLE. The roles swap only after the outgoing deck has been
/// paused AND reads not audible (its rate is 0); if it still reads audible
/// the handover is refused and the load degrades to an ordinary one. No step
/// of the handover plays: the core's own `.play` follows the load, after the
/// seam beat.
///
/// NEVER TOUCH A DECK'S PLAYER. NE-25b measured that a foreign seek on a
/// deck's `AVPlayer` can leave it `.ready` at the wrong place with no event to
/// say so (docs/ios-native-engine-measurements.md §10.3). The pair only ever
/// sends `DeckCommand`s.
///
/// STAND-DOWN. An uncommanded pause of the playing deck while a warm load is
/// IN FLIGHT stands warming down for good (`unexplainedPauseAction`): the one
/// window in which a second player could have taken the session. From then
/// on the pair is one deck with a spare.
final class DeckPair: DeckDriving {

    struct Config {
        /// The ring's structured rows (`prepare` rows). Default: none.
        var diag: (DiagEntry) -> Void = { _ in }
    }

    /// A load held warm on the standby deck.
    private struct WarmLoad {
        var warm: DeckPolicy.Warm
        /// The standby deck's own token for it: negative, so it can never be
        /// mistaken for one of the core's (which count up from 1).
        var token: DeckToken
        var stages: [Vocabulary.Stage]
        var prerolled = false

        /// Not yet ready and not failed: the window `unexplainedPauseAction` names.
        var inFlight: Bool { !warm.ready && !warm.failed }
    }

    /// Bound on `handoverLog`, the test-visible record of handover steps.
    private static let logCap = 128

    var onEvent: ((DeckEvent) -> Void)?

    /// Internal, not private: the Simulator tests read each deck's player.
    let decks: [PairableDeck]
    /// The deck holding the player role.
    private(set) var activeIndex = 0
    private var standbyIndex: Int { 1 - activeIndex }
    /// Whose events reach the core. nil only inside a handover, between
    /// `detach-outgoing` and `attach-incoming`.
    private var forwarding: Int? = 0
    /// False once warming has stood down (or the pair was invalidated).
    private(set) var available = true
    private var rate: Double = 1
    private var warmLoad: WarmLoad?
    private var nextWarmToken: DeckToken = -1
    private var invalidated = false
    private let config: Config
    /// Keeps the shared assets alive as long as the pair.
    private let assetCache: AssetCache?

    /// How many handovers completed (the tests count swaps).
    private(set) var swaps = 0
    /// Every handover step and every promotion verdict, in order.
    private(set) var handoverLog: [String] = []

    init(_ first: PairableDeck, _ second: PairableDeck, config: Config = Config(), assetCache: AssetCache? = nil) {
        decks = [first, second]
        self.config = config
        self.assetCache = assetCache
        for index in decks.indices {
            decks[index].onEvent = { [weak self] event in self?.deckEvent(index, event) }
        }
        decks[activeIndex].prepareWindowAvailable = true
    }

    /// The production pair: two AVDecks on one shared `AssetCache`, so a
    /// deck never cancels the other's asset load.
    static func make(sessionIsActive: @escaping () -> Bool, diag: @escaping (DiagEntry) -> Void) -> DeckPair {
        let cache = AssetCache()
        func deck() -> AVDeck {
            AVDeck(config: AVDeck.Config(
                sessionIsActive: sessionIsActive,
                makeAsset: { [unowned cache] url, precise in cache.asset(for: url, preciseTiming: precise) },
                cancelsAssetLoading: false,
                diag: diag))
        }
        return DeckPair(deck(), deck(), config: Config(diag: diag), assetCache: cache)
    }

    /// The deck holding the player role is the one the core reads.
    var reading: DeckReading {
        decks[activeIndex].reading
    }

    func send(_ command: DeckCommand) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !invalidated else { return }
        switch command {
        case let .load(token, itemId, url, startSec, preciseTiming):
            load(command, token: token, itemId: itemId, url: url, startSec: startSec, preciseTiming: preciseTiming)
        case let .prepare(itemId, url, startSec):
            prepare(itemId: itemId, url: url, startSec: startSec)
        case let .setRate(newRate):
            // Both decks: the standby primes at the rate it will play at.
            // AVDeck refuses a non-positive rate itself, and says so.
            if newRate > 0, newRate.isFinite { rate = newRate }
            decks[activeIndex].send(command)
            decks[standbyIndex].send(command)
        case .unload:
            // The core unloads at a relinquish or a media-services reset: a
            // release, the one discard that frees the warm buffer too.
            decks[activeIndex].send(.unload)
            if warmLoad != nil || decks[standbyIndex].loadedURL != nil,
               DeckPolicy.discardFreesBuffer("release") {
                decks[standbyIndex].send(.unload)
            }
            warmLoad = nil
            assetCache?.removeAll()
        case .play, .pause, .seek, .setOutPoint:
            decks[activeIndex].send(command)
        }
    }

    func invalidate() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !invalidated else { return }
        invalidated = true
        available = false
        warmLoad = nil
        onEvent = nil
        for deck in decks {
            deck.onEvent = nil
            deck.invalidate()
        }
        assetCache?.removeAll()
    }

    // MARK: - Prepare

    private func prepare(itemId: String, url: String?, startSec: Double) {
        let offset = DeckPolicy.warmOffset(startSec)
        let decision = DeckPolicy.prefetchDecision(
            available: available, url: url, currentUrl: decks[activeIndex].loadedURL,
            warm: warmLoad?.warm, offsetSec: offset)
        row("prefetch", [JSONMember("decision", .string(decision.rawValue))])
        guard decision == .start, let url else { return }
        // A warm load being replaced is forgotten; the standby's next load
        // replaces its item (`discardFreesBuffer("replaced")` is false: no
        // separate media work).
        let token = nextWarmToken
        nextWarmToken -= 1
        warmLoad = WarmLoad(
            warm: DeckPolicy.Warm(itemId: itemId, url: url, offsetSec: offset, ready: false, failed: false),
            token: token, stages: [.attach])
        let standby = decks[standbyIndex]
        standby.prepareWindowAvailable = false
        standby.send(.setRate(rate))
        // Precise timing: a prepared item is the next SEGMENT of a Foray, and
        // P-7's provisional rule is precise for bounded segments. A precise
        // asset promoted for an approximate ask is never worse.
        standby.send(.load(token: token, itemId: itemId, url: url, startSec: offset, preciseTiming: true))
    }

    // MARK: - Load: promote or degrade

    private func load(_ command: DeckCommand, token: DeckToken, itemId: String, url: String?, startSec: Double,
                      preciseTiming: Bool) {
        guard let held = warmLoad else {
            decks[activeIndex].send(command)
            return
        }
        // At a boundary the warm load is spent either way: promoted, or
        // forgotten with its buffer kept (`discardFreesBuffer("boundary")`).
        warmLoad = nil
        let standby = decks[standbyIndex]
        let promotion = DeckPolicy.warmPromotion(
            warm: held.warm, url: url, offsetSec: DeckPolicy.warmOffset(startSec),
            canPlay: standby.isReady, atSec: standby.reading.positionSec)
        log("promotion:\(promotion.rawValue)")
        if promotion == .promote, handover(to: token) {
            row("promote", [JSONMember("token", .number(Double(token)))])
            let incoming = decks[activeIndex].reading
            emit(.prepared(token: token, hit: true, stages: held.stages))
            emit(.durationLoaded(token: token, durationSec: incoming.durationSec))
            emit(.ready(token: token, landedSec: incoming.positionSec ?? held.warm.offsetSec,
                        prerolled: held.prerolled, elapsedMs: 0))
            return
        }
        row("miss", [JSONMember("reason", .string(promotion == .promote ? "handover-refused" : promotion.rawValue)),
                     JSONMember("token", .number(Double(token)))])
        // Only the load of the item that was prepared is described: a skip to
        // somewhere else was never a prepare to miss.
        if held.warm.url == url {
            emit(.prepared(token: token, hit: false, stages: held.stages))
        }
        decks[activeIndex].send(command)
    }

    /// `DeckPolicy.handoverSteps`, in order. Returns false, with the roles
    /// unchanged, when the outgoing deck will not confirm paused.
    private func handover(to token: DeckToken) -> Bool {
        let outgoingIndex = activeIndex
        let outgoing = decks[outgoingIndex]
        let incoming = decks[standbyIndex]
        for step in DeckPolicy.handoverSteps() {
            switch step {
            case .detachOutgoing:
                forwarding = nil
            case .pauseOutgoing:
                // Always commanded: it also ends the outgoing deck's intent to
                // play, so its stop can never read as an uncommanded pause.
                outgoing.send(.pause)
                guard !outgoing.reading.audible else {
                    forwarding = outgoingIndex
                    log("handover:refused-outgoing-audible")
                    return false
                }
            case .swapRoles:
                activeIndex = standbyIndex
            case .attachIncoming:
                forwarding = activeIndex
            case .adoptIdentity:
                incoming.adopt(token: token)
            case .carryVolume:
                // The decks carry no duck (the engine ducks nothing in M2).
                break
            case .carryRate:
                incoming.send(.setRate(rate))
            }
            log("handover:\(step.rawValue)")
        }
        outgoing.prepareWindowAvailable = false
        incoming.prepareWindowAvailable = available
        swaps += 1
        return true
    }

    // MARK: - Events

    private func deckEvent(_ index: Int, _ event: DeckEvent) {
        guard !invalidated else { return }
        if index == forwarding {
            if case .pausedUncommanded = event {
                let action = DeckPolicy.unexplainedPauseAction(
                    expected: false, ended: false, warmInFlight: warmLoad?.inFlight ?? false)
                if action == .standDown { standDown() }
            }
            onEvent?(event)
            return
        }
        // The standby deck: only its warm load's events count, and none of
        // them reaches the core (the outgoing deck's late events, under the
        // core's old token, are dropped here too).
        guard index == standbyIndex, var held = warmLoad, event.deckToken == held.token else { return }
        switch event {
        case .durationLoaded:
            held.stages.append(.duration)
        case let .notReady(_, attempt, _):
            held.stages.append(.notReady)
            held.stages.append(attempt < 2 ? .retry : .ordinaryLoad)
        case let .ready(_, landedSec, prerolled, _):
            held.stages += [.readiness, .seek] + (prerolled ? [.preroll] : []) + [.ready]
            held.prerolled = prerolled
            // Ready only AT the in-point (never on readiness for the head).
            held.warm.ready = DeckPolicy.warmSettled(offsetSec: held.warm.offsetSec, atSec: landedSec, canPlay: true)
            row(held.warm.ready ? "warm-ready" : "warm-unsettled", [JSONMember("prerolled", .bool(prerolled))])
        case .failed:
            held.warm.failed = true
            row("warm-failed")
        case .deadlineExceeded:
            held.stages.append(.deadline)
            held.warm.failed = true
            row("warm-deadline")
        default:
            return
        }
        warmLoad = held
    }

    private func standDown() {
        available = false
        warmLoad = nil
        for deck in decks { deck.prepareWindowAvailable = false }
        row("stand-down")
        log("stand-down")
    }

    // MARK: - Helpers

    private func emit(_ event: DeckEvent) {
        onEvent?(event)
    }

    private func row(_ event: String, _ fields: [JSONMember] = []) {
        config.diag(DiagEntry(kind: "prepare", fields: [JSONMember("kind", .string(event))] + fields))
    }

    private func log(_ entry: String) {
        handoverLog.append(entry)
        if handoverLog.count > Self.logCap { handoverLog.removeFirst(handoverLog.count - Self.logCap) }
    }
}

private extension DeckEvent {
    /// The load token an event carries (`.refused` carries none).
    var deckToken: DeckToken? {
        switch self {
        case let .durationLoaded(token, _), let .ready(token, _, _, _), let .notReady(token, _, _),
             let .deadlineExceeded(token, _), let .failed(token, _), let .timeControl(token, _, _),
             let .pausedUncommanded(token, _), let .seeked(token, _, _), let .stalled(token),
             let .ended(token), let .prepareWindow(token), let .prepared(token, _, _):
            return token
        case .refused:
            return nil
        }
    }
}
