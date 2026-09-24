import XCTest
import AVFoundation
import ForayEngineCore
@testable import ForayAudioPlugin

/// NE-25b (docs/native-engine-plan.md §4.3 and card NE-25b): the two-deck
/// preroll that NE-32's DeckPair rests on, measured on the Simulator before
/// DeckPair exists.
///
/// THE QUESTION. A Foray's next segment must sit seeked to its in-point and
/// prerolled on a SECOND player while the first is audible (P-10), so the
/// seam costs a `play()` and not a load. Nobody in this repo has measured:
///   - how long the standby deck takes to become ready while the other deck
///     is sounding, against the same load with nothing sounding;
///   - whether the standby's seek and preroll disturb the audible deck at all
///     (a stall, a pause, a rate drop would be heard in the car);
///   - how long the swap takes: the standby's `play` to `.playing`;
///   - how often `preroll` completes `finished == false` when a seek lands on
///     the player while it runs (Apple: a preroll is interrupted "by a time
///     change"), and whether AVDeck's retry-once-then-ordinary-load recovers
///     every time.
///
/// BOTH DECKS ARE THE REAL `AVDeck`, NOT A RIG. The readiness gate being
/// measured is the production one (`AVDeck.prerollWhenReady`, the only
/// `preroll(` in the plugins and the core), so this file calls no `preroll(`
/// of its own (`shell-invariants.test.mjs` pins that). Its evidence that no
/// preroll was issued before `.readyToPlay` is the deck's own primitive
/// log, which `prerollWhenReady` writes from `player.status`, `item.status`
/// and `player.rate` read on the line before the call: every preroll in this
/// file must read `player=1 item=1 rate=0.0`, including the retries a forced
/// seek provokes, and a source that is HELD back must see no preroll at all
/// until it answers.
///
/// IT MEASURES, AND ASSERTS ONLY ONE-SIDED RULES (as NE-25a does): the gate
/// held, the standby stayed silent until its play, the audible deck was not
/// disturbed, and every load reached `.ready`. Every number goes to the job
/// summary (`MeasurementReport`, tag `NE-25b`) and one `NE-25b-json` log line
/// per trial, and from there into docs/ios-native-engine-measurements.md with
/// the run id. A Simulator is not a phone and a local file is not a CDN: DV-4
/// and DV-5 repeat this in M2.
///
/// RUN ON CI ONLY (ios-kit, `xcodebuild test -scheme ForayAudio`).
final class TwoDeckPrerollTests: XCTestCase {
    /// Where the standby lands: 0.35 s before a double click, inside all four
    /// click tracks (the WAV is 60 s). NE-25a's in-point set.
    static let standbyStartSec = 19.65
    /// The audible deck plays the 90 s CBR track from here, and is reloaded
    /// from the top once it passes `audibleReloadAfterSec`, so it never ends
    /// in the middle of a trial.
    static let audibleFixture = "click-cbr.mp3"
    static let audibleStartSec = 1.0
    static let audibleReloadAfterSec = 75.0
    static let reps = 3

    /// What `AVDeck.prerollWhenReady` records when the gate holds:
    /// `AVPlayer.Status.readyToPlay` and `AVPlayerItem.Status.readyToPlay`
    /// are both raw value 1, and the player is at rate 0.
    static let gatePrimitive = "preroll player=1 item=1 rate=0.0"

    /// How long the slow source withholds every byte. Long enough that a
    /// gate that did not wait would have prerolled inside it (unheld local
    /// loads are ready in 30-110 ms, NE-25a §7.3).
    static let holdSec = 1.5

    /// The forced seek: issued this long after the standby's preroll is
    /// observed in its primitive log (0 = in the same main-queue turn the
    /// poll sees it), to `standbyStartSec + forcedSeekOffsetSec`.
    static let forcedSeekDelaysMs: [Double] = [0, 2, 5, 10, 25]
    static let forcedSeekFixtures = ["click-cbr.mp3", "click-vbr-xing.mp3"]
    static let forcedSeekReps = 4
    static let forcedSeekOffsetSec = 3.0

    /// As AVDeckTests: a behaviour test must not fail because the runner's
    /// media stack is slow (NE-15 measured a 19.6 s cold first load); the
    /// production 20 s deadline has its own test there.
    private static let testDeadlineSec: Double = 40

    private struct Logged {
        let deck: String
        let atMs: Double
        let event: DeckEvent
    }

    private struct Ready {
        let landedSec: Double
        let prerolled: Bool
        let elapsedMs: Int
        let atMs: Double
    }

    enum Condition: String, Encodable {
        case alone
        case whileAudible = "while-audible"
    }

    struct StandbyTrial: Encodable {
        let fixture: String
        let condition: Condition
        let rep: Int
        let startSec: Double
        /// `.ready`'s `elapsedMs`: from the `.load` command to ready,
        /// measured by the deck.
        let timeToReadyMs: Int
        let prerolled: Bool
        /// `currentTime` after the gate minus the request. AVFoundation
        /// reports the request (NE-25a §7.3), so this is a sanity number,
        /// not the audible landing.
        let landingErrorMs: Double
        /// Causes of any `.notReady` with no seek forced: a preroll that
        /// finished `false` by itself.
        let notReady: [String]
        let prerollPrimitives: [String]
        /// The swap: the standby's `play` command to its `.playing`.
        let playToPlayingMs: Double?
        /// What the audible deck reported while the standby loaded (empty is
        /// the rule).
        let audibleDisturbed: [String]
    }

    struct SlowSourceTrial: Encodable {
        let fixture: String
        let holdMs: Double
        let loaderRequestsDuringHold: Int
        let samplesDuringHold: Int
        let prerollsDuringHold: Int
        let itemReadyDuringHold: Bool
        let releaseToReadyMs: Double
        let timeToReadyMs: Int
        let prerollPrimitives: [String]
        let prerolled: Bool
        let audibleDisturbed: [String]
    }

    struct ForcedSeekTrial: Encodable {
        let fixture: String
        let delayMs: Double
        let rep: Int
        /// preroll-unfinished | gate-seek-interrupted | raced | after-ready
        let outcome: String
        let notReady: [String]
        let prerollPrimitives: [String]
        let prerolled: Bool
        let timeToReadyMs: Int
        /// Host ms from the poll seeing the preroll to the forced seek.
        let seekAfterPrerollObservedMs: Double?
        let forcedSeekFinished: Bool?
        let landingErrorMs: Double
        let audibleDisturbed: [String]
    }

    /// The forced seek's completion, written from AVFoundation's callback.
    private final class SeekRecord {
        var issuedAtMs: Double?
        var finished: Bool?
    }

    private var decks: [String: AVDeck] = [:]
    private var log: [Logged] = []
    private var deckRows: [String] = []
    private var faults: [String] = []
    private var loaders: [HeldFileLoader] = []
    private var lastToken: DeckToken = 0
    private var audibleToken: DeckToken?

    override class func setUp() {
        super.setUp()
        // The Simulator's cold media stack (NE-15 §8.2) must not land in the
        // first standby trial's time to ready.
        DeckMeasurements.warmUpOnce()
    }

    override func setUp() {
        super.setUp()
        continueAfterFailure = true
    }

    override func tearDown() {
        decks.values.forEach { $0.send(.unload) }
        decks = [:]
        loaders = []
        XCTAssertEqual(faults, [], "a deck played without an active session")
        super.tearDown()
    }

    // MARK: - (1) Time to ready: alone vs while the other deck is audible

    /// The standby deck (B) loads each click track at 19.65 s through the
    /// readiness-gated pipeline, once with nothing sounding and once while
    /// deck A is audible, three times over; then A pauses and B plays (the
    /// swap). Asserted: B's preroll(s) read both statuses ready at rate 0,
    /// B is silent until its play, and A is not disturbed while B prepares.
    /// TO SEE IT FAIL: let `prerollWhenReady` preroll while `player.rate != 0`
    /// or before `item.status` is ready (the primitive reads it); drop the
    /// pause at the top of `AVDeck.load` and start a trial with B playing
    /// (B audible before its play).
    func testTheStandbyDeckPrerollsWhileTheOtherDeckIsAudible() throws {
        let descriptor = try ClickTrackDescriptor.load()
        decks["A"] = makeDeck("A")
        decks["B"] = makeDeck("B")
        var trials: [StandbyTrial] = []
        for rep in 1...Self.reps {
            for fixture in descriptor.fixtures {
                for condition in [Condition.alone, .whileAudible] {
                    if condition == .alone {
                        pauseAudible()
                    } else {
                        guard try ensureAudible() else { return }
                    }
                    guard let trial = try standbyTrial(fixture.file, condition: condition, rep: rep) else { continue }
                    trials.append(trial)
                    MeasurementReport.json(trial, tag: "NE-25b")
                }
            }
        }
        XCTAssertEqual(trials.count, Self.reps * descriptor.fixtures.count * 2, "a trial produced no measurement")
        reportStandby(trials, fixtures: descriptor.fixtures.map(\.file))
    }

    private func standbyTrial(_ file: String, condition: Condition, rep: Int) throws -> StandbyTrial? {
        let a = try XCTUnwrap(decks["A"])
        let b = try XCTUnwrap(decks["B"])
        let token = nextToken()
        let since = log.count
        b.send(.loadURL(token: token, url: try fixture(file), startSec: Self.standbyStartSec, preciseTiming: true))
        guard let ready = waitReady("B", token, since: since) else { return nil }
        let label = "\(file) \(condition.rawValue) #\(rep)"

        let ops = opsOfLastLoad(b)
        let prerolls = ops.filter { $0.hasPrefix("preroll") }
        let notReady = notReadyCauses("B", token, since: since)
        assertGateHeld(prerolls, notReady: notReady, prerolled: ready.prerolled, label)
        XCTAssertEqual(Array(ops.prefix(2)), ["attach", "seek 19.650"], "\(label): the gate seek must be the first thing after the attach: \(ops)")

        // At most one deck audible (plan §4.3): B is prepared, not playing.
        XCTAssertEqual(b.player.rate, 0, "\(label): the standby was audible before its play")
        XCTAssertFalse(log[since...].contains { $0.deck == "B" && Self.isPlaying($0.event) },
                       "\(label): the standby reported .playing before its play")

        var disturbed: [String] = []
        if condition == .whileAudible {
            disturbed = disturbances("A", since: since)
            XCTAssertEqual(disturbed, [], "\(label): the audible deck was disturbed while the standby prepared")
            XCTAssertEqual(a.player.timeControlStatus, .playing, "\(label): the audible deck stopped while the standby prepared")
        }

        // The swap NE-32 performs: the outgoing deck pauses, the standby plays.
        let swapSince = log.count
        if condition == .whileAudible {
            a.send(.pause)
        }
        let playAt = now()
        b.send(.play)
        let playing = waitFor("B .playing", deck: "B", since: swapSince, timeout: 10) {
            if case .timeControl(token, .playing, _) = $0 { return true }
            return false
        }
        b.send(.pause)

        return StandbyTrial(
            fixture: file, condition: condition, rep: rep, startSec: Self.standbyStartSec,
            timeToReadyMs: ready.elapsedMs, prerolled: ready.prerolled,
            landingErrorMs: (ready.landedSec - Self.standbyStartSec) * 1000,
            notReady: notReady, prerollPrimitives: prerolls,
            playToPlayingMs: playing.map { $0.atMs - playAt },
            audibleDisturbed: disturbed
        )
    }

    private func reportStandby(_ trials: [StandbyTrial], fixtures: [String]) {
        var rows: [[String]] = []
        for file in fixtures {
            for condition in [Condition.alone, .whileAudible] {
                let group = trials.filter { $0.fixture == file && $0.condition == condition }
                guard !group.isEmpty else { continue }
                rows.append([
                    file,
                    condition.rawValue,
                    group.map { "\($0.timeToReadyMs)" }.joined(separator: ", "),
                    "\(group.filter(\.prerolled).count)/\(group.count)",
                    "\(group.filter { !$0.notReady.isEmpty }.count)",
                    group.map { $0.playToPlayingMs.map(msValue) ?? "-" }.joined(separator: ", "),
                    condition == .whileAudible ? "\(group.filter { !$0.audibleDisturbed.isEmpty }.count)" : "n/a"
                ])
            }
        }
        let alone = trials.filter { $0.condition == .alone }
        let audible = trials.filter { $0.condition == .whileAudible }
        MeasurementReport.table(
            title: "NE-25b: standby deck, time to ready alone vs while the other deck is audible",
            columns: ["fixture", "condition", "time to ready, ms (per rep)", "prerolled", "unforced not-ready",
                      "swap: play to .playing, ms", "audible deck disturbed"],
            rows: rows,
            notes: [
                "Both decks are AVDeck (readiness-gated: duration, player.status and item.status .readyToPlay, "
                    + "zero-tolerance seek to \(Self.standbyStartSec) s, preroll while the player is at rate 0). "
                    + "Precise timing. The audible deck plays \(Self.audibleFixture) at 1x. The swap sends the audible "
                    + "deck's pause and the standby's play in one main turn (NE-32 plays after the outgoing deck "
                    + "confirms .paused).",
                "Time to ready, all fixtures: alone \(Self.spread(alone.map { Double($0.timeToReadyMs) })) ms; "
                    + "while audible \(Self.spread(audible.map { Double($0.timeToReadyMs) })) ms.",
                "Swap, play to .playing: alone \(Self.spread(alone.compactMap(\.playToPlayingMs))) ms; "
                    + "after the audible deck's pause \(Self.spread(audible.compactMap(\.playToPlayingMs))) ms.",
                "Every preroll read `\(Self.gatePrimitive)` on the line before the call (asserted).",
                "Landing (currentTime after the gate, which reports the request): "
                    + "\(Self.spread(trials.map(\.landingErrorMs))) ms."
            ],
            tag: "NE-25b"
        )
    }

    // MARK: - (2) The gate waits for readiness from a slow source

    /// The standby's source withholds every byte for 1.5 s (a resource
    /// loader that answers nothing until released) while deck A is audible:
    /// the CDN case NE-32 meets at every seam. During the hold no preroll is
    /// issued and no ready is reported; after the release exactly one
    /// preroll is issued, reading both statuses ready at rate 0.
    /// TO SEE IT FAIL: let `advanceIfReady` go on with the duration alone
    /// (`prerollWhenReady` then reports `not-ready-to-play`, which this test
    /// refuses), or preroll straight after the attach (an uncatchable
    /// NSInvalidArgumentException on a non-ready player: the run crashes).
    func testTheStandbyWaitsForReadinessFromASlowSource() throws {
        let file = "click-cbr.mp3"
        let loader = HeldFileLoader(data: try Data(contentsOf: fixture(file)), contentType: "public.mp3")
        loaders.append(loader)
        decks["A"] = makeDeck("A")
        decks["B"] = makeDeck("B") { url, precise in
            let asset = AVDeck.defaultAsset(url, precise)
            asset.resourceLoader.setDelegate(loader, queue: loader.queue)
            return asset
        }
        guard try ensureAudible() else { return }
        let b = try XCTUnwrap(decks["B"])
        let url = try XCTUnwrap(URL(string: "foray-held://deck.test/\(file)"))
        let token = nextToken()
        let since = log.count
        b.send(.loadURL(token: token, url: url, startSec: Self.standbyStartSec, preciseTiming: true))

        var samples = 0
        var itemReadyDuringHold = false
        let holdUntil = Date().addingTimeInterval(Self.holdSec)
        while Date() < holdUntil {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
            samples += 1
            if b.player.currentItem?.status == .readyToPlay { itemReadyDuringHold = true }
        }
        let requestsDuringHold = loader.requests
        let prerollsDuringHold = opsOfLastLoad(b).filter { $0.hasPrefix("preroll") }
        XCTAssertGreaterThan(requestsDuringHold, 0, "the held loader was never asked; the hold proved nothing")
        XCTAssertFalse(itemReadyDuringHold, "the standby's item was ready with no byte served; the hold proved nothing")
        XCTAssertEqual(prerollsDuringHold, [], "a preroll was issued while the source had answered nothing")
        XCTAssertFalse(log[since...].contains { $0.deck == "B" && Self.isReady($0.event) }, "ready with no byte served")

        let releasedAt = now()
        loader.release()
        guard let ready = waitReady("B", token, since: since) else { return }
        let prerolls = opsOfLastLoad(b).filter { $0.hasPrefix("preroll") }
        let notReady = notReadyCauses("B", token, since: since)
        XCTAssertEqual(prerolls, [Self.gatePrimitive], "after the release: one preroll, behind the gate")
        XCTAssertEqual(notReady, [], "the gate reached the preroll before the source was ready")
        XCTAssertTrue(ready.prerolled)
        XCTAssertGreaterThanOrEqual(Double(ready.elapsedMs), Self.holdSec * 1000, "ready before the hold ended")
        XCTAssertEqual(b.player.rate, 0, "the standby was audible before its play")
        let disturbed = disturbances("A", since: since)
        XCTAssertEqual(disturbed, [], "the audible deck was disturbed while the standby waited")

        let trial = SlowSourceTrial(
            fixture: file, holdMs: Self.holdSec * 1000,
            loaderRequestsDuringHold: requestsDuringHold, samplesDuringHold: samples,
            prerollsDuringHold: prerollsDuringHold.count, itemReadyDuringHold: itemReadyDuringHold,
            releaseToReadyMs: ready.atMs - releasedAt, timeToReadyMs: ready.elapsedMs,
            prerollPrimitives: prerolls, prerolled: ready.prerolled, audibleDisturbed: disturbed
        )
        MeasurementReport.json(trial, tag: "NE-25b")
        MeasurementReport.table(
            title: "NE-25b: the readiness gate against a held source, while the other deck is audible",
            columns: ["fixture", "hold, ms", "loader requests in the hold", "prerolls in the hold",
                      "item ready in the hold", "release to ready, ms", "time to ready, ms", "prerolls after"],
            rows: [[
                file, msValue(trial.holdMs), "\(requestsDuringHold)", "\(prerollsDuringHold.count)",
                "\(itemReadyDuringHold)", msValue(trial.releaseToReadyMs), "\(ready.elapsedMs)",
                prerolls.joined(separator: "; ")
            ]],
            notes: [
                "A resource loader on a custom scheme accepts every request and answers none until released, "
                    + "then serves the file's bytes. \(samples) samples of the standby every 10 ms during the hold.",
                "Release to ready is the cost of the gate once bytes flow: duration, both statuses, seek, preroll."
            ],
            tag: "NE-25b"
        )
    }

    // MARK: - (3) preroll finished == false under a forced seek

    /// While the standby's preroll runs, the test seeks the standby's
    /// PLAYER directly (around the deck, as the system or a stray caller
    /// would), 0-25 ms after the poll sees the preroll issued. The count of
    /// `notReady(preroll-unfinished)` per delay is the finished=false
    /// frequency the card asks for. Asserted: every load still reaches
    /// `.ready` (retry once, then the ordinary load), every preroll,
    /// including the retry's, reads both statuses ready at rate 0, the
    /// audible deck is not disturbed, and AT LEAST ONE preroll really was
    /// interrupted: a run where none was would publish "every load
    /// recovered" having tested no recovery (run 35988169841 interrupted 12
    /// of 40, every one at 0-2 ms).
    /// TO SEE IT FAIL: make `prerollCompleted` ignore `finished` (no
    /// preroll-unfinished is ever reported, so the vacuity guard fails), or
    /// skip the retry in `notReady` and go straight to `ordinaryLoad` (an
    /// unprimed ready after ONE not-ready fails `assertGateHeld`).
    func testPrerollFinishedFalseUnderAForcedSeek() throws {
        decks["A"] = makeDeck("A")
        decks["B"] = makeDeck("B")
        var trials: [ForcedSeekTrial] = []
        for file in Self.forcedSeekFixtures {
            for delayMs in Self.forcedSeekDelaysMs {
                for rep in 1...Self.forcedSeekReps {
                    guard try ensureAudible() else { return }
                    guard let trial = try forcedSeekTrial(file, delayMs: delayMs, rep: rep) else { continue }
                    trials.append(trial)
                    MeasurementReport.json(trial, tag: "NE-25b")
                }
            }
        }
        XCTAssertEqual(trials.count, Self.forcedSeekFixtures.count * Self.forcedSeekDelaysMs.count * Self.forcedSeekReps,
                       "a trial produced no measurement")
        XCTAssertGreaterThan(trials.filter { $0.outcome == "preroll-unfinished" }.count, 0,
                             "no forced seek interrupted a preroll, so the retry path was never exercised and the recovery claim proves nothing")
        reportForcedSeek(trials)
    }

    private func forcedSeekTrial(_ file: String, delayMs: Double, rep: Int) throws -> ForcedSeekTrial? {
        let b = try XCTUnwrap(decks["B"])
        let token = nextToken()
        let since = log.count
        let label = "\(file) forced seek +\(delayMs) ms #\(rep)"
        b.send(.loadURL(token: token, url: try fixture(file), startSec: Self.standbyStartSec, preciseTiming: true))

        // Poll the primitive log at ~0.5 ms until the preroll is issued (or
        // the load ends without one). The deck writes the primitive on the
        // line before `preroll(`, inside one main-queue block, so the poll
        // sees it at the earliest in the next turn: after the call.
        var prerollSeenAt: Double?
        let until = Date().addingTimeInterval(45)
        while Date() < until {
            if opsOfLastLoad(b).contains(where: { $0.hasPrefix("preroll") }) {
                prerollSeenAt = now()
                break
            }
            if log[since...].contains(where: { $0.deck == "B" && Self.isTerminal($0.event, token) }) { break }
            RunLoop.main.run(until: Date().addingTimeInterval(0.0005))
        }
        guard let seenAt = prerollSeenAt else {
            XCTFail("\(label): no preroll was issued: \(opsOfLastLoad(b)); events: \(log[since...].map(\.event))")
            return nil
        }

        let seek = SeekRecord()
        let player = b.player
        let target = CMTime(seconds: Self.standbyStartSec + Self.forcedSeekOffsetSec, preferredTimescale: 1_000_000)
        let issue = { [weak self] in
            seek.issuedAtMs = self?.now()
            player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero) { finished in
                DispatchQueue.main.async { seek.finished = finished }
            }
        }
        if delayMs == 0 {
            issue()
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + delayMs / 1000) { issue() }
        }

        guard let ready = waitReady("B", token, since: since) else { return nil }
        // Let a delayed seek land before the next trial reloads the deck.
        let settle = Date().addingTimeInterval(2)
        while seek.finished == nil, Date() < settle {
            RunLoop.main.run(until: Date().addingTimeInterval(0.005))
        }

        let prerolls = opsOfLastLoad(b).filter { $0.hasPrefix("preroll") }
        let notReady = notReadyCauses("B", token, since: since)
        assertGateHeld(prerolls, notReady: notReady, prerolled: ready.prerolled, label)
        XCTAssertEqual(b.player.rate, 0, "\(label): the standby was audible before its play")
        let disturbed = disturbances("A", since: since)
        XCTAssertEqual(disturbed, [], "\(label): the audible deck was disturbed")

        let outcome: String
        if notReady.contains("preroll-unfinished") {
            outcome = "preroll-unfinished"
        } else if notReady.contains("seek-interrupted") {
            outcome = "gate-seek-interrupted"
        } else if let issued = seek.issuedAtMs, issued < ready.atMs {
            // The seek went out before `.ready` was reported, yet the preroll
            // finished `true`: it had completed before the seek reached the
            // player, and its completion was still hopping to main.
            outcome = "raced"
        } else {
            outcome = "after-ready"
        }
        return ForcedSeekTrial(
            fixture: file, delayMs: delayMs, rep: rep, outcome: outcome,
            notReady: notReady, prerollPrimitives: prerolls, prerolled: ready.prerolled,
            timeToReadyMs: ready.elapsedMs,
            seekAfterPrerollObservedMs: seek.issuedAtMs.map { $0 - seenAt },
            forcedSeekFinished: seek.finished,
            landingErrorMs: (ready.landedSec - Self.standbyStartSec) * 1000,
            audibleDisturbed: disturbed
        )
    }

    private func reportForcedSeek(_ trials: [ForcedSeekTrial]) {
        var rows: [[String]] = []
        for file in Self.forcedSeekFixtures {
            for delayMs in Self.forcedSeekDelaysMs {
                let group = trials.filter { $0.fixture == file && $0.delayMs == delayMs }
                guard !group.isEmpty else { continue }
                func count(_ outcome: String) -> String { "\(group.filter { $0.outcome == outcome }.count)" }
                rows.append([
                    file, msValue(delayMs), "\(group.count)",
                    count("preroll-unfinished"), count("gate-seek-interrupted"), count("raced"), count("after-ready"),
                    "\(group.filter { !$0.prerolled }.count)",
                    Self.spread(group.map { Double($0.timeToReadyMs) }),
                    Self.spread(group.compactMap(\.seekAfterPrerollObservedMs)),
                    group.map { msValue($0.landingErrorMs) }.joined(separator: ", ")
                ])
            }
        }
        let unfinished = trials.filter { $0.outcome == "preroll-unfinished" }.count
        MeasurementReport.table(
            title: "NE-25b: preroll finished=false under a forced seek on the standby, while the other deck is audible",
            columns: ["fixture", "seek delay after preroll seen, ms", "trials", "preroll finished=false",
                      "gate seek interrupted", "raced (preroll done first)", "after ready", "ready unprimed (fallback)",
                      "time to ready, ms", "seek issued after preroll seen, ms", "landing error, ms"],
            rows: rows,
            notes: [
                "finished=false in \(unfinished) of \(trials.count) forced trials. The forced seek goes to "
                    + "\(Self.standbyStartSec + Self.forcedSeekOffsetSec) s on the standby's AVPlayer, around AVDeck.",
                "AVDeck's rule: a preroll that finished false (or an interrupted gate seek) is 'not ready'; "
                    + "it retries the seek and preroll once, then falls back to an ordinary (unprimed) load.",
                "Every load reached .ready and every preroll, retries included, read `\(Self.gatePrimitive)` (asserted).",
                "Landing error is currentTime at .ready minus \(Self.standbyStartSec) s: a 'raced' trial can report the "
                    + "forced seek's target, because AVPlayer reports a pending seek's time."
            ],
            tag: "NE-25b"
        )
    }

    // MARK: - The one-sided rules every trial shares

    /// The readiness gate held: at least one preroll, every one of them read
    /// both statuses `.readyToPlay` at rate 0 on the line before the call,
    /// at most one retry, and the ready is unprimed exactly when the retry
    /// failed too (AVDeck's ordinary-load fallback).
    private func assertGateHeld(_ prerolls: [String], notReady: [String], prerolled: Bool, _ label: String,
                                file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(prerolls.isEmpty, "\(label): no preroll was issued", file: file, line: line)
        XCTAssertLessThanOrEqual(prerolls.count, 2, "\(label): more than one retry: \(prerolls)", file: file, line: line)
        for preroll in prerolls {
            XCTAssertEqual(preroll, Self.gatePrimitive, "\(label): a preroll was issued outside the gate", file: file, line: line)
        }
        XCTAssertFalse(notReady.contains("not-ready-to-play"),
                       "\(label): the gate reached the preroll with a status not ready: \(notReady)", file: file, line: line)
        XCTAssertLessThanOrEqual(notReady.count, 2, "\(label): \(notReady)", file: file, line: line)
        XCTAssertEqual(prerolled, notReady.count < 2,
                       "\(label): prerolled=\(prerolled) after \(notReady.count) not-ready", file: file, line: line)
    }

    // MARK: - Decks and events

    private func makeDeck(_ name: String, makeAsset: ((URL, Bool) -> AVURLAsset)? = nil) -> AVDeck {
        let config = AVDeck.Config(
            loadDeadlineSec: Self.testDeadlineSec,
            sessionIsActive: { true },
            writeRow: { [unowned self] in self.deckRows.append("\(name) \($0)") },
            debugFault: { [unowned self] in self.faults.append("\(name) \($0)") },
            makeAsset: makeAsset ?? AVDeck.defaultAsset
        )
        let deck = AVDeck(config: config)
        deck.onEvent = { [unowned self] event in
            let at = self.now()
            print("TWODECK-EVENT \(name) \(String(format: "%.1f", at)) ms \(event)")
            self.log.append(Logged(deck: name, atMs: at, event: event))
        }
        return deck
    }

    private func fixture(_ file: String) throws -> URL {
        try ClickTrackDescriptor.directory().appendingPathComponent(file)
    }

    private func nextToken() -> DeckToken {
        lastToken += 1
        return lastToken
    }

    private func now() -> Double {
        Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000
    }

    /// Deck A sounding (confirmed `.playing`): resumed if it is paused
    /// mid-file, reloaded from `audibleStartSec` if it has none or is near
    /// its end.
    private func ensureAudible(file: StaticString = #filePath, line: UInt = #line) throws -> Bool {
        let a = try XCTUnwrap(decks["A"])
        if let token = audibleToken, a.player.currentItem != nil,
           a.player.currentTime().seconds < Self.audibleReloadAfterSec {
            if a.player.timeControlStatus == .playing { return true }
            let since = log.count
            a.send(.play)
            return waitFor("A .playing (resume)", deck: "A", since: since, timeout: 10, file: file, line: line) {
                if case .timeControl(token, .playing, _) = $0 { return true }
                return false
            } != nil
        }
        let token = nextToken()
        audibleToken = token
        var since = log.count
        a.send(.loadURL(token: token, url: try fixture(Self.audibleFixture), startSec: Self.audibleStartSec, preciseTiming: true))
        guard waitReady("A", token, since: since, file: file, line: line) != nil else { return false }
        since = log.count
        a.send(.play)
        return waitFor("A .playing", deck: "A", since: since, timeout: 10, file: file, line: line) {
            if case .timeControl(token, .playing, _) = $0 { return true }
            return false
        } != nil
    }

    private func pauseAudible() {
        guard let a = decks["A"], a.player.currentItem != nil, a.player.timeControlStatus != .paused else { return }
        a.send(.pause)
        let until = Date().addingTimeInterval(5)
        while a.player.timeControlStatus != .paused, Date() < until {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
    }

    /// Spins the main run loop (where every deck callback lands) until one
    /// of `deck`'s events logged at or after `since` matches.
    @discardableResult
    private func waitFor(
        _ what: String, deck name: String, since: Int, timeout: TimeInterval = 45,
        file: StaticString = #filePath, line: UInt = #line,
        _ match: (DeckEvent) -> Bool
    ) -> Logged? {
        let until = Date().addingTimeInterval(timeout)
        while true {
            if let hit = log[since...].first(where: { $0.deck == name && match($0.event) }) { return hit }
            if Date() >= until { break }
            RunLoop.main.run(until: Date().addingTimeInterval(0.005))
        }
        XCTFail("timed out after \(timeout) s waiting for \(what); events: \(log[since...].map { "\($0.deck) \($0.event)" })",
                file: file, line: line)
        return nil
    }

    private func waitReady(_ name: String, _ token: DeckToken, since: Int,
                           file: StaticString = #filePath, line: UInt = #line) -> Ready? {
        let hit = waitFor("ready(\(name), token: \(token))", deck: name, since: since, file: file, line: line) {
            Self.isTerminal($0, token)
        }
        guard let hit else { return nil }
        switch hit.event {
        case let .ready(_, landed, prerolled, elapsed):
            return Ready(landedSec: landed, prerolled: prerolled, elapsedMs: elapsed, atMs: hit.atMs)
        case let .failed(_, message):
            XCTFail("\(name) load \(token) failed: \(message)", file: file, line: line)
        case let .deadlineExceeded(_, afterMs):
            XCTFail("\(name) load \(token) hit the deadline after \(afterMs) ms", file: file, line: line)
        default:
            break
        }
        return nil
    }

    /// The deck's primitive log from this load's attach on.
    private func opsOfLastLoad(_ deck: AVDeck) -> [String] {
        guard let attach = deck.primitives.lastIndex(of: "attach") else { return [] }
        return Array(deck.primitives[attach...])
    }

    private func notReadyCauses(_ name: String, _ token: DeckToken, since: Int) -> [String] {
        log[since...].compactMap { entry -> String? in
            guard entry.deck == name, case let .notReady(tok, _, cause) = entry.event, tok == token else { return nil }
            return cause
        }
    }

    /// Anything the audible deck reported that a listener would hear as a
    /// problem: a stop, a stall, a wait, a failure.
    private func disturbances(_ name: String, since: Int) -> [String] {
        log[since...].compactMap { entry -> String? in
            guard entry.deck == name else { return nil }
            switch entry.event {
            case .pausedUncommanded, .stalled, .failed, .ended:
                return "\(entry.event)"
            case let .timeControl(_, status, _) where status != .playing:
                return "\(entry.event)"
            default:
                return nil
            }
        }
    }

    private static func isTerminal(_ event: DeckEvent, _ token: DeckToken) -> Bool {
        switch event {
        case .ready(token, _, _, _), .failed(token, _), .deadlineExceeded(token, _):
            return true
        default:
            return false
        }
    }

    private static func isReady(_ event: DeckEvent) -> Bool {
        if case .ready = event { return true }
        return false
    }

    private static func isPlaying(_ event: DeckEvent) -> Bool {
        if case .timeControl(_, .playing, _) = event { return true }
        return false
    }

    /// "min-max (median m)", whole milliseconds; "-" for none.
    static func spread(_ values: [Double]) -> String {
        guard let low = values.min(), let high = values.max() else { return "-" }
        let sorted = values.sorted()
        return String(format: "%.0f-%.0f (median %.0f, n=%d)", low, high, sorted[sorted.count / 2], values.count)
    }
}

/// A resource-loader delegate that holds every request until `release()`,
/// then serves a file's bytes: a source that is deterministically NOT READY
/// for as long as the test wants, with no network. (NE-15's
/// `NeverAnsweringLoader` never answers at all; this one answers late.)
final class HeldFileLoader: NSObject, AVAssetResourceLoaderDelegate {
    let queue = DispatchQueue(label: "ai.jwlabs.foura.tests.held-file-loader")
    private let data: Data
    private let contentType: String
    private let lock = NSLock()
    private var released = false
    private var held: [AVAssetResourceLoadingRequest] = []
    private var asked = 0

    init(data: Data, contentType: String) {
        self.data = data
        self.contentType = contentType
        super.init()
    }

    var requests: Int {
        lock.lock()
        defer { lock.unlock() }
        return asked
    }

    func release() {
        queue.async {
            self.lock.lock()
            self.released = true
            let waiting = self.held
            self.held = []
            self.lock.unlock()
            waiting.forEach { self.answer($0) }
        }
    }

    func resourceLoader(
        _ resourceLoader: AVAssetResourceLoader,
        shouldWaitForLoadingOfRequestedResource loadingRequest: AVAssetResourceLoadingRequest
    ) -> Bool {
        lock.lock()
        asked += 1
        let answerNow = released
        if !answerNow { held.append(loadingRequest) }
        lock.unlock()
        if answerNow { answer(loadingRequest) }
        return true
    }

    func resourceLoader(_ resourceLoader: AVAssetResourceLoader, didCancel loadingRequest: AVAssetResourceLoadingRequest) {
        lock.lock()
        held.removeAll { $0 === loadingRequest }
        lock.unlock()
    }

    private func answer(_ request: AVAssetResourceLoadingRequest) {
        guard !request.isCancelled, !request.isFinished else { return }
        if let info = request.contentInformationRequest {
            info.contentType = contentType
            info.contentLength = Int64(data.count)
            info.isByteRangeAccessSupported = true
        }
        if let dataRequest = request.dataRequest {
            let from = Int(dataRequest.currentOffset)
            let to = dataRequest.requestsAllDataToEndOfResource
                ? data.count
                : min(data.count, Int(dataRequest.requestedOffset) + dataRequest.requestedLength)
            if from < to {
                dataRequest.respond(with: data.subdata(in: from..<to))
            }
        }
        request.finishLoading()
    }
}
