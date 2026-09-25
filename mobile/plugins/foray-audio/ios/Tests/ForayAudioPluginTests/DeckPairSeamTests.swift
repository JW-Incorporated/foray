import XCTest
import AVFoundation
import ForayEngineCore
@testable import ForayAudioPlugin

/// DeckPair and AVDeck's three-layer out-point against REAL AVPlayers in the
/// iOS Simulator, on NE-25a's click tracks (card NE-32;
/// docs/native-engine-plan.md §4.3, §14). RUN ON CI ONLY (ios-kit's
/// `xcodebuild test -scheme ForayAudio`).
///
/// The core is not in these tests: `TapeDriver` stands in for it, and does
/// at each boundary exactly what `EngineCore` does (NE-30s, fixture-pinned in
/// manager-foray and prepare): on `.prepareWindow` it prepares the next
/// segment; on `.ended` it loads the next segment at its in-point; once that
/// load is ready AND the seam beat (`SEAM_GAP_SEC`, 0.5 s of wall clock from
/// the out-point, the founder's ruling of 2026-09-24) has run, it arms the
/// out-point and plays. The seam's SILENCE is then the out-point's `.ended`
/// to the next segment's `.playing`.
///
/// Every number goes to the job summary under "NE-32:" tables (the one
/// `MeasurementReport` hand-off) and to the log as `NE-32 |` lines.
final class DeckPairSeamTests: XCTestCase {
    /// The behaviour tests' load deadline (AVDeckTests' reasoning: a cold
    /// Simulator media stack can take most of the production 20 s).
    private static let testDeadlineSec: Double = 40
    /// The seam budget the card's acceptance names: `SEAM_GAP_SEC` + 250 ms.
    private static let seamGapSec = SeamGap.defaultGapSec
    private static let seamBudgetMs = (seamGapSec + 0.25) * 1000
    /// NE-25a's never-early slack (1 ms of CMTime), the same the deck uses.
    private static let neverEarlySlackSec = AVDeck.layerSlackSec
    /// The WebView's out-point overshoot on its generated tone (§7.6, ios-build
    /// run 35963652608): the baseline the card reports the native numbers
    /// against. Not a pass mark.
    private static let webViewBaselineMs = 6.0

    private var rows: [DiagEntry] = []

    override class func setUp() {
        super.setUp()
        DeckMeasurements.warmUpOnce()
    }

    override func setUp() {
        super.setUp()
        rows = []
    }

    private func fixture(_ file: String) throws -> URL {
        let name = (file as NSString).deletingPathExtension
        let ext = (file as NSString).pathExtension
        return try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: ext, subdirectory: "ClickTracks"),
                             "missing bundled fixture ClickTracks/\(file)")
    }

    private func makeDeck(cache: AssetCache? = nil,
                          layers: Set<DeckPolicy.OutPointLayer> = Set(DeckPolicy.OutPointLayer.allCases),
                          schedule: @escaping (AVDeck.TimerPurpose, Double, @escaping () -> Void) -> EngineObservation = AVDeck.mainQueueTimer)
        -> AVDeck {
        let makeAsset: (URL, Bool) -> AVURLAsset
        if let cache {
            makeAsset = { cache.asset(for: $0, preciseTiming: $1) }
        } else {
            makeAsset = AVDeck.defaultAsset
        }
        return AVDeck(config: AVDeck.Config(
            loadDeadlineSec: Self.testDeadlineSec,
            sessionIsActive: { true },
            writeRow: { print("NE-32-ROW \($0)") },
            debugFault: { print("NE-32-FAULT \($0)") },
            makeAsset: makeAsset,
            cancelsAssetLoading: cache == nil,
            diag: { [unowned self] in self.rows.append($0) },
            schedule: schedule,
            outPointLayers: layers))
    }

    private func makePair() -> (DeckPair, [AVDeck]) {
        let cache = AssetCache()
        let decks = [makeDeck(cache: cache), makeDeck(cache: cache)]
        let pair = DeckPair(decks[0], decks[1], config: DeckPair.Config(diag: { [unowned self] in self.rows.append($0) }),
                            assetCache: cache)
        return (pair, decks)
    }

    private func spin(until done: () -> Bool, timeout: TimeInterval) -> Bool {
        let until = Date().addingTimeInterval(timeout)
        while Date() < until {
            if done() { return true }
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
        return done()
    }

    // MARK: - The tape driver (the core's seam, as NE-30s does it)

    struct Segment {
        let file: String
        let url: URL
        let inSec: Double
        let outSec: Double
    }

    struct SeamRecord {
        var endedAtMs: Double
        var stopPositionSec: Double?
        var outSec: Double
        var readyAtMs: Double?
        var playingAtMs: Double?
        var hit: Bool?
        var rateAtPlaying: Float?

        var silenceMs: Double? { playingAtMs.map { $0 - endedAtMs } }
    }

    final class TapeDriver {
        let pair: DeckPair
        let decks: [AVDeck]
        let segments: [Segment]
        let rate: Double
        /// How the driver prepares: `.hit` at the in-point, `.wrongOffset`
        /// at another in-point of the same file (a miss), `.off` not at all.
        enum Prepare { case hit, wrongOffset, off }
        let prepare: Prepare

        private(set) var index = 0
        private(set) var seams: [SeamRecord] = []
        private(set) var lastStopPositionSec: Double?
        private(set) var done = false
        private(set) var failures: [String] = []
        private(set) var maxAudible = 0
        private var sampler: Timer?

        init(pair: DeckPair, decks: [AVDeck], segments: [Segment], rate: Double, prepare: Prepare) {
            self.pair = pair
            self.decks = decks
            self.segments = segments
            self.rate = rate
            self.prepare = prepare
        }

        static func nowMs() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000 }

        func token(_ i: Int) -> DeckToken { i + 1 }

        func start() {
            pair.onEvent = { [unowned self] in self.handle($0) }
            // "Never two audible", sampled every 5 ms for the whole tape.
            let sampler = Timer(timeInterval: 0.005, repeats: true) { [unowned self] _ in
                self.maxAudible = max(self.maxAudible, self.decks.filter { $0.player.rate != 0 }.count)
            }
            RunLoop.main.add(sampler, forMode: .common)
            self.sampler = sampler
            pair.send(.setRate(rate))
            load(0)
        }

        func stop() {
            sampler?.invalidate()
            sampler = nil
            pair.send(.unload)
        }

        private func load(_ i: Int) {
            let s = segments[i]
            pair.send(.load(token: token(i), itemId: "seg\(i)", url: s.url.absoluteString, startSec: s.inSec,
                            preciseTiming: true))
        }

        private func startSegment(_ i: Int) {
            pair.send(.setOutPoint(sec: segments[i].outSec))
            pair.send(.play)
        }

        private func handle(_ event: DeckEvent) {
            let now = Self.nowMs()
            switch event {
            case let .ready(t, _, _, _) where t == token(index):
                if index == 0 {
                    startSegment(0)
                } else {
                    seams[index - 1].readyAtMs = now
                    // The beat: never before gap seconds of wall clock from the out-point.
                    let due = seams[index - 1].endedAtMs + DeckPairSeamTests.seamGapSec * 1000
                    let i = index
                    DispatchQueue.main.asyncAfter(deadline: .now() + max(0, due - now) / 1000) { [unowned self] in
                        guard self.index == i else { return }
                        self.startSegment(i)
                    }
                }
            case let .prepareWindow(t) where t == token(index):
                guard prepare != .off, index + 1 < segments.count else { return }
                let next = segments[index + 1]
                let inSec = prepare == .hit ? next.inSec : next.inSec + 5
                DispatchQueue.main.async { [unowned self] in
                    self.pair.send(.prepare(itemId: "seg\(self.index + 1)", url: next.url.absoluteString, startSec: inSec))
                }
            case let .ended(t) where t == token(index):
                let at = pair.reading.positionSec
                if index + 1 < segments.count {
                    seams.append(SeamRecord(endedAtMs: now, stopPositionSec: at, outSec: segments[index].outSec))
                    index += 1
                    let i = index
                    DispatchQueue.main.async { [unowned self] in self.load(i) }
                } else {
                    lastStopPositionSec = at
                    done = true
                }
            case let .prepared(t, hit, _) where t == token(index) && index > 0:
                seams[index - 1].hit = hit
            case let .timeControl(t, .playing, _) where t == token(index) && index > 0:
                if seams[index - 1].playingAtMs == nil {
                    seams[index - 1].playingAtMs = now
                    seams[index - 1].rateAtPlaying = decks[pair.activeIndex].player.rate
                }
            case let .failed(t, message):
                failures.append("load \(t) failed: \(message)")
                done = true
            case let .deadlineExceeded(t, afterMs):
                failures.append("load \(t) missed its deadline after \(afterMs) ms")
                done = true
            default:
                break
            }
        }
    }

    private func runTape(_ segments: [Segment], rate: Double, prepare: TapeDriver.Prepare,
                         file: StaticString = #filePath, line: UInt = #line) -> TapeDriver {
        let (pair, decks) = makePair()
        let driver = TapeDriver(pair: pair, decks: decks, segments: segments, rate: rate, prepare: prepare)
        driver.start()
        let finished = spin(until: { driver.done }, timeout: 90)
        driver.stop()
        XCTAssertTrue(finished, "the tape did not finish; seams: \(driver.seams)", file: file, line: line)
        XCTAssertEqual(driver.failures, [], file: file, line: line)
        // Never early, at every out-point the tape crossed.
        for (i, seam) in driver.seams.enumerated() {
            let at = seam.stopPositionSec ?? -1
            XCTAssertGreaterThanOrEqual(at, seam.outSec - Self.neverEarlySlackSec,
                                        "seam \(i) stopped EARLY at \(at), out-point \(seam.outSec)", file: file, line: line)
        }
        if let last = driver.lastStopPositionSec, let out = segments.last?.outSec {
            XCTAssertGreaterThanOrEqual(last, out - Self.neverEarlySlackSec, "the last segment stopped EARLY", file: file, line: line)
        }
        XCTAssertLessThanOrEqual(driver.maxAudible, 1, "two decks were audible at once", file: file, line: line)
        return driver
    }

    // MARK: - Seam silence: a prepare hit and a miss

    /// THE SEAM, HIT AND MISS, ON LOCAL FILES: the silence from the out-point
    /// to the next segment's `.playing` is at most `SEAM_GAP_SEC` + 250 ms.
    /// A hit swaps the decks (the standby was prepared and prerolled at the
    /// in-point); a miss (the standby warmed at the WRONG in-point) degrades
    /// to an ordinary load on the player; with no prepare at all it is the
    /// cold M1-style seam.
    /// TO SEE IT FAIL: make the pair never promote (every seam a miss) and the
    /// hit assertion goes red; play before the load is ready and the seam
    /// silence or the never-early check goes red.
    func testSeamSilenceOnAPrepareHitAndOnAMissStaysInsideTheBudget() throws {
        let cbr = try fixture("click-cbr.mp3")
        let wav = try fixture("click.wav")
        let tape = [Segment(file: "click-cbr.mp3", url: cbr, inSec: 10, outSec: 13),
                    Segment(file: "click.wav", url: wav, inSec: 20, outSec: 23)]
        var table: [[String]] = []
        for (label, prepare) in [("hit", TapeDriver.Prepare.hit), ("miss (wrong in-point)", .wrongOffset), ("no prepare", .off)] {
            let driver = runTape(tape, rate: 1, prepare: prepare)
            guard let seam = driver.seams.first else {
                XCTFail("\(label): no seam")
                continue
            }
            switch prepare {
            case .hit: XCTAssertEqual(seam.hit, true, "\(label): the prepared standby was not promoted")
            case .wrongOffset: XCTAssertEqual(seam.hit, false, "\(label): a warm deck at the wrong in-point was promoted")
            case .off: XCTAssertNil(seam.hit, "\(label): nothing was prepared, so nothing is reported")
            }
            XCTAssertEqual(driver.pair.swaps, prepare == .hit ? 1 : 0, label)
            let silence = try XCTUnwrap(seam.silenceMs, "\(label): the next segment never played")
            XCTAssertLessThanOrEqual(silence, Self.seamBudgetMs, "\(label): seam silence \(silence) ms")
            table.append([label, msValue(silence), seam.readyAtMs.map { msValue($0 - seam.endedAtMs) } ?? "-",
                          ms((seam.stopPositionSec ?? .nan) - seam.outSec)])
        }
        MeasurementReport.table(
            title: "NE-32: seam silence on local files (out-point `.ended` to `.playing`, rate 1)",
            columns: ["prepare", "silence ms", "boundary to next ready ms", "outgoing stop past out-point ms"],
            rows: table,
            notes: ["Budget: SEAM_GAP_SEC \(Self.seamGapSec) s + 250 ms = \(Int(Self.seamBudgetMs)) ms. The beat itself is \(Int(Self.seamGapSec * 1000)) ms of that.",
                    "click-cbr.mp3 10-13 s, then click.wav 20-23 s; precise timing; both decks share one AssetCache."],
            tag: "NE-32")
    }

    // MARK: - Never early, at 1x and 2x, every layer

    /// NEVER EARLY (P-2), at 1x and 2x: all three layers together (the
    /// production arming), then each layer ALONE, so a layer that would stop
    /// early cannot hide behind a faster one. The overshoot of the layer that
    /// won is written to the `outPoint` row and reported against the WebView
    /// baseline.
    /// TO SEE IT FAIL: arm `forwardPlaybackEndTime` or the boundary observer
    /// 50 ms before the out-point, or stop on any watchdog wake.
    func testTheOutPointIsNeverEarlyAt1xAnd2xInEveryLayer() throws {
        let cbr = try fixture("click-cbr.mp3")
        let arms: [(String, Set<DeckPolicy.OutPointLayer>)] = [
            ("all three", Set(DeckPolicy.OutPointLayer.allCases)),
            ("endTime alone", [.endTime]), ("boundary alone", [.boundary]), ("watchdog alone", [.watchdog])]
        var table: [[String]] = []
        for rate in [1.0, 2.0] {
            for (label, layers) in arms {
                rows = []
                let deck = makeDeck(layers: layers)
                var events: [DeckEvent] = []
                deck.onEvent = { events.append($0) }
                deck.send(.setRate(rate))
                deck.send(.loadURL(token: 1, url: cbr, startSec: 30, preciseTiming: true))
                guard spin(until: { events.contains { if case .ready = $0 { return true }; return false } }, timeout: 45) else {
                    XCTFail("\(label) \(rate)x: never ready; \(events)")
                    continue
                }
                deck.send(.setOutPoint(sec: 32.5))
                deck.send(.play)
                var stoppedAt: Double?
                let ended = spin(until: {
                    if stoppedAt == nil, events.contains(.ended(token: 1)) { stoppedAt = deck.reading.positionSec }
                    return stoppedAt != nil
                }, timeout: 20)
                XCTAssertTrue(ended, "\(label) \(rate)x: the out-point never stopped the deck; \(events)")
                let at = stoppedAt ?? -1
                XCTAssertGreaterThanOrEqual(at, 32.5 - Self.neverEarlySlackSec, "\(label) \(rate)x stopped EARLY at \(at)")
                XCTAssertEqual(events.filter { $0 == .ended(token: 1) }.count, 1, "\(label) \(rate)x: one end per token")
                let stop = rows.last { $0.kind == "outPoint" && $0[field: "kind"] == .string("stop") }
                let winner = stop?[field: "layer"]?.stringValue ?? "-"
                if layers.count == 1 {
                    XCTAssertEqual(winner, layers.first?.rawValue, "\(label) \(rate)x: another layer stopped it")
                }
                XCTAssertFalse(rows.contains { $0.kind == "outPoint" && $0[field: "kind"] == .string("early") },
                               "\(label) \(rate)x: a layer reported early")
                table.append(["\(Int(rate))x", label, winner, stop?[field: "overshootMs"]?.numberValue.map { msValue($0) } ?? "-",
                              ms(at - 32.5)])
                deck.send(.unload)
            }
        }
        MeasurementReport.table(
            title: "NE-32: out-point overshoot by layer (click-cbr.mp3, 30 s to 32.5 s)",
            columns: ["rate", "layers armed", "layer that stopped it", "outPoint row overshoot ms", "playhead past out-point at .ended ms"],
            rows: table,
            notes: ["Never early is the pass mark (\(Int(Self.neverEarlySlackSec * 1000)) ms of CMTime slack, NE-25a's). Overshoot is reported, not asserted.",
                    "WebView baseline for comparison: the JavaScript out-point stopped \(msValue(Self.webViewBaselineMs)) ms past end_sec (ios-build run 35963652608, docs/ios-native-engine-measurements.md §7.6).",
                    "stopPad = \(AVDeck.defaultStopPadSec) s (NE-25a measured no early stop)."],
            tag: "NE-32")
    }

    // MARK: - The rate across three swaps; never two audible

    /// Four segments at 2x through three seams, every one a prepare hit:
    /// the rate is still 2 on the deck that plays after each swap (the
    /// handover carries it, and AVPlayer does not), no two decks are ever
    /// audible (sampled every 5 ms), and every out-point is never early.
    /// TO SEE IT FAIL: drop `carry-rate` and the standby's `setRate`, or play
    /// the incoming deck before pausing the outgoing one.
    func testTheRateIsHeldAcrossThreeSwapsAndNeverTwoDecksAreAudible() throws {
        let cbr = try fixture("click-cbr.mp3")
        let wav = try fixture("click.wav")
        let tape = [Segment(file: "click-cbr.mp3", url: cbr, inSec: 10, outSec: 13),
                    Segment(file: "click.wav", url: wav, inSec: 10, outSec: 13),
                    Segment(file: "click-cbr.mp3", url: cbr, inSec: 40, outSec: 43),
                    Segment(file: "click.wav", url: wav, inSec: 40, outSec: 43)]
        let driver = runTape(tape, rate: 2, prepare: .hit)
        XCTAssertEqual(driver.seams.count, 3)
        XCTAssertEqual(driver.pair.swaps, 3, "every seam should have been a swap; seams: \(driver.seams)")
        for (i, seam) in driver.seams.enumerated() {
            XCTAssertEqual(seam.hit, true, "seam \(i)")
            XCTAssertEqual(seam.rateAtPlaying, 2, "seam \(i): the rate was not held across the swap")
            if let silence = seam.silenceMs {
                XCTAssertLessThanOrEqual(silence, Self.seamBudgetMs, "seam \(i): \(silence) ms")
            } else {
                XCTFail("seam \(i): the next segment never played")
            }
        }
        MeasurementReport.table(
            title: "NE-32: three swaps at 2x (prepare hits)",
            columns: ["seam", "silence ms", "rate after the swap", "max decks audible (5 ms samples)"],
            rows: driver.seams.enumerated().map { i, seam in
                ["\(i + 1)", seam.silenceMs.map { msValue($0) } ?? "-", seam.rateAtPlaying.map { "\($0)" } ?? "-", "\(driver.maxAudible)"]
            },
            notes: ["The beat is \(Int(Self.seamGapSec * 1000)) ms of WALL clock at any rate (it does not scale with rate)."],
            tag: "NE-32")
    }

    // MARK: - The watchdog's window

    /// DV-11: the watchdog wakes ONLY inside the last 1.5 s of wall clock
    /// before the out-point. Outside it there is one timer, armed for the
    /// moment the window opens, and it is re-armed on a rate change and on a
    /// seek. A recording scheduler (real timers, every arm and wake written
    /// down) stands in for the timer seam. A lone deck arms no prefetch
    /// window (there is no standby to prepare).
    /// TO SEE IT FAIL: poll every 250 ms from play (`watchdogDelayMs`
    /// ignoring the window), or skip the re-arm on `.setRate`.
    func testTheWatchdogWakesOnlyInsideItsWindowAndReArmsOnRateAndSeek() throws {
        let cbr = try fixture("click-cbr.mp3")
        let outSec = 17.0
        var armed: [(purpose: AVDeck.TimerPurpose, ms: Double, remainingWallSec: Double, atMs: Double)] = []
        var wakes: [(purpose: AVDeck.TimerPurpose, remainingWallSec: Double)] = []
        weak var deckRef: AVDeck?
        var currentRate = 1.0
        func remaining() -> Double {
            ((outSec - (deckRef?.reading.positionSec ?? 0)) / currentRate)
        }
        let deck = makeDeck(layers: Set(DeckPolicy.OutPointLayer.allCases), schedule: { purpose, ms, fire in
            armed.append((purpose, ms, remaining(), TapeDriver.nowMs()))
            return AVDeck.mainQueueTimer(purpose, ms) {
                wakes.append((purpose, remaining()))
                fire()
            }
        })
        deckRef = deck
        var events: [DeckEvent] = []
        deck.onEvent = { events.append($0) }
        deck.send(.loadURL(token: 1, url: cbr, startSec: 10, preciseTiming: true))
        guard spin(until: { events.contains { if case .ready = $0 { return true }; return false } }, timeout: 45) else {
            return XCTFail("never ready; \(events)")
        }
        deck.send(.setOutPoint(sec: outSec))
        deck.send(.play)
        XCTAssertEqual(armed.filter { $0.purpose == .watchdog }.count, 1, "one timer outside the window")
        let first = try XCTUnwrap(armed.last)
        XCTAssertEqual(first.ms, (first.remainingWallSec - DeckPolicy.outPointWatchdogWindowSec) * 1000, accuracy: 50,
                       "armed for the moment the window opens")

        _ = spin(until: { false }, timeout: 1.0)
        let beforeRate = armed.count
        currentRate = 2
        deck.send(.setRate(2))
        XCTAssertGreaterThan(armed.count, beforeRate, "a rate change re-arms the watchdog")

        _ = spin(until: { false }, timeout: 0.5)
        let beforeSeek = armed.count
        deck.send(.seek(toSec: 12))
        XCTAssertGreaterThan(armed.count, beforeSeek, "a seek re-arms the watchdog")

        XCTAssertTrue(spin(until: { events.contains(.ended(token: 1)) }, timeout: 20), "never reached the out-point; \(events)")
        let watchdogWakes = wakes.filter { $0.purpose == .watchdog }
        // The first arm is computed from the playhead at the play COMMAND, and
        // audio starts tens of ms later, so a wake can land that much before
        // the window opens by the player's clock: 300 ms of wall clock covers
        // it with margin (NE-25b measured play-to-playing at 9-58 ms).
        let outside = watchdogWakes.filter { $0.remainingWallSec > DeckPolicy.outPointWatchdogWindowSec + 0.3 }
        XCTAssertEqual(outside.count, 0, "watchdog wakes outside the window: \(outside)")
        XCTAssertEqual(armed.filter { $0.purpose == .prepareWindow }.count, 0, "a lone deck opens no prefetch window")
        XCTAssertFalse(events.contains { if case .prepareWindow = $0 { return true }; return false })

        MeasurementReport.table(
            title: "NE-32: the watchdog's wakes (click-cbr.mp3 from 10 s, out-point 17 s; rate 2 after 1 s; seek to 12 s)",
            columns: ["timers armed", "watchdog wakes", "wakes outside the 1.5 s window", "largest remaining wall s at a wake"],
            rows: [["\(armed.count)", "\(watchdogWakes.count)", "\(outside.count)",
                    String(format: "%.3f", watchdogWakes.map { $0.remainingWallSec }.max() ?? .nan)]],
            notes: ["A 51-minute Foray polled every 250 ms would be about 12,000 main wakeups (DV-11); this is one timer per play, seek or rate change, then at most a 250 ms poll inside the window."],
            tag: "NE-32")
        deck.send(.unload)
    }

    // MARK: - AssetCache

    /// One asset per (url, timing mode), least recently used first out.
    func testTheAssetCacheSharesOneAssetPerSourceAndTimingMode() throws {
        let cbr = try fixture("click-cbr.mp3")
        let wav = try fixture("click.wav")
        let cache = AssetCache(capacity: 2)
        let first = cache.asset(for: cbr, preciseTiming: true)
        XCTAssertTrue(first === cache.asset(for: cbr, preciseTiming: true))
        XCTAssertFalse(first === cache.asset(for: cbr, preciseTiming: false), "precise and approximate are different assets")
        _ = cache.asset(for: wav, preciseTiming: true)
        XCTAssertEqual(cache.count, 2)
        XCTAssertFalse(first === cache.asset(for: cbr, preciseTiming: true), "the least recently used entry was evicted")
    }
}
