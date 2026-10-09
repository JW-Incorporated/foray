import XCTest
import AVFoundation
import ForayEngineCore
@testable import ForayAudioPlugin

/// Card NE-45s on the Simulator: a narration line's seams are DECK seams,
/// end to end. The real core (`ForayEngine` over `EngineCore`, the Foray tape
/// on) drives the real `DeckPair` of two `AVDeck`s on local files; only the
/// session, the lock screen, the remote and the synthesiser are fakes. RUN ON
/// CI ONLY (ios-kit's `xcodebuild test -scheme ForayAudio`).
///
/// What each tape proves (the card's acceptance):
///   - clip -> RENDERED line -> clip in one episode: both seams are prepare
///     hits, each seam's silence (the outgoing `.ended` to the incoming
///     `.playing`) is at most `SEAM_GAP_SEC` + 250 ms, and the second clip is
///     never attached cold (it was prepared on the demoted deck, by a seek,
///     while the line played);
///   - clip -> SPOKEN line -> clip: the clip after the line is prepared under
///     the voice, at the line's start, and its seam is `prepare=hit`;
///   - a prepared line whose file is missing (the local 404): the warm load
///     fails on the standby and NOTHING is heard early; at the line's turn it
///     is spoken, and only then;
///   - at most one thing is audible at any moment (both decks' rates and the
///     synthesiser, sampled every 5 ms).
///
/// The rendered line is a short WAV this file writes (a quiet 440 Hz tone),
/// because a line has no out-point: its boundary is its duration, and a line
/// shorter than `PREFETCH_LEAD_SEC` opens its window at its first play.
///
/// FLAKE POLICY (DeckPairSeamTests' reasoning): a starved Simulator media
/// stack can lose a race it would win on a phone, so the tape is re-run up
/// to `attempts` times while a hit or the silence budget is missed, and every
/// attempt is in the table. The SAFETY rules (never two audible, never a voice
/// early) are asserted on EVERY attempt.
final class NarrationSeamTests: XCTestCase {
    private static let testDeadlineSec: Double = 40
    static let seamBudgetMs = (SeamGap.defaultGapSec + 0.25) * 1000
    static let attempts = 3
    static let tag = "NE-45s"

    override class func setUp() {
        super.setUp()
        DeckMeasurements.warmUpOnce()
    }

    private func fixture(_ file: String) throws -> URL {
        let name = (file as NSString).deletingPathExtension
        let ext = (file as NSString).pathExtension
        return try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: ext, subdirectory: "ClickTracks"),
                             "missing bundled fixture ClickTracks/\(file)")
    }

    /// A mono 16-bit WAV of `seconds` of a quiet tone: the rendered line.
    static func writeLine(seconds: Double) throws -> URL {
        let rate = 22_050
        let count = Int(Double(rate) * seconds)
        var data = Data()
        func put(_ text: String) { data.append(contentsOf: Array(text.utf8)) }
        func u32(_ value: UInt32) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        func u16(_ value: UInt16) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        put("RIFF"); u32(UInt32(36 + count * 2)); put("WAVE")
        put("fmt "); u32(16); u16(1); u16(1); u32(UInt32(rate)); u32(UInt32(rate * 2)); u16(2); u16(16)
        put("data"); u32(UInt32(count * 2))
        for i in 0..<count {
            let sample = Int16(sin(Double(i) * 2 * .pi * 440 / Double(rate)) * 2_000)
            u16(UInt16(bitPattern: sample))
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("ne45s-line-\(UUID().uuidString).wav")
        try data.write(to: url)
        return url
    }

    // MARK: - the world

    /// The DeckPair the host drives, watched: every event it forwards to the
    /// core and every load the core sends it, stamped.
    final class SpyDeck: DeckDriving {
        let pair: DeckPair
        let decks: [AVDeck]
        var onEvent: ((DeckEvent) -> Void)?
        private(set) var events: [(ms: Double, event: DeckEvent)] = []
        private(set) var loads: [(ms: Double, token: DeckToken, itemId: String)] = []

        init(deadlineSec: Double, rows: @escaping (DiagEntry) -> Void) {
            let cache = AssetCache()
            func deck() -> AVDeck {
                AVDeck(config: AVDeck.Config(
                    loadDeadlineSec: deadlineSec,
                    lineLoadDeadlineSec: deadlineSec,
                    sessionIsActive: { true },
                    writeRow: { print("NE-45s-ROW \($0)") },
                    debugFault: { print("NE-45s-FAULT \($0)") },
                    makeAsset: { [unowned cache] url, precise in cache.asset(for: url, preciseTiming: precise) },
                    cancelsAssetLoading: false,
                    diag: rows,
                    assetFailed: { [unowned cache] asset in cache.forget(asset) }))
            }
            decks = [deck(), deck()]
            pair = DeckPair(decks[0], decks[1], config: DeckPair.Config(diag: rows), assetCache: cache)
            pair.onEvent = { [unowned self] event in
                self.events.append((NarrationSeamTests.nowMs(), event))
                self.onEvent?(event)
            }
        }

        var reading: DeckReading { pair.reading }

        func send(_ command: DeckCommand) {
            if case let .load(token, itemId, _, _, _, _) = command {
                loads.append((NarrationSeamTests.nowMs(), token, itemId))
            }
            pair.send(command)
        }

        func invalidate() { pair.invalidate() }

        func rebuild() { pair.rebuild() }

        /// The core token of the last load of `itemId`.
        func token(of itemId: String) -> DeckToken? { loads.last { $0.itemId == itemId }?.token }

        func firstEvent(after ms: Double = 0, _ match: (DeckEvent) -> Bool) -> Double? {
            events.first { $0.ms >= ms && match($0.event) }?.ms
        }

        func prepared(_ token: DeckToken) -> Bool? {
            for entry in events {
                if case let .prepared(t, hit, _) = entry.event, t == token { return hit }
            }
            return nil
        }
    }

    /// The synthesiser, scripted: a line starts at once and finishes
    /// `lineSec` later. It sounds between the two (the audible sampler counts it).
    final class ScriptedSpeaker: Speaking {
        var onFinish: ((SpeechEnd) -> Void)?
        var onNarratorEvent: ((NarratorEvent) -> Void)?
        let lineSec: Double
        private(set) var spokenAtMs: [Double] = []
        private(set) var finishedAtMs: Double?
        private(set) var sounding = false
        private var current: Int?

        init(lineSec: Double) { self.lineSec = lineSec }

        func speak(text: String, voiceId: String?) {}
        func stopSpeaking() { sounding = false }
        func rebuild() { sounding = false }

        func narrate(_ command: NarrationCommand) {
            switch command {
            case let .speak(seq, _, _, _):
                spokenAtMs.append(NarrationSeamTests.nowMs())
                current = seq
                sounding = true
                DispatchQueue.main.async { [weak self] in
                    self?.onNarratorEvent?(.started(seq: seq, voiceFallback: false))
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + lineSec) { [weak self] in
                    guard let self, self.current == seq, self.sounding else { return }
                    self.sounding = false
                    self.finishedAtMs = NarrationSeamTests.nowMs()
                    self.onNarratorEvent?(.finished(seq: seq))
                }
            case let .stop(seq), let .discard(seq), let .pause(seq):
                if current == seq { sounding = false }
            case .resume:
                break
            }
        }
    }

    static func nowMs() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000 }

    static func clip(_ index: Int, _ url: URL, _ start: Double, _ end: Double, durationSec: Double) -> EngineItem {
        EngineItem(node: .object([
            JSONMember("id", .string("f1#\(index)")), JSONMember("kind", .string("episode")),
            JSONMember("audio_url", .string(url.absoluteString)),
            JSONMember("start_sec", .number(start)), JSONMember("end_sec", .number(end)),
            JSONMember("duration_sec", .number(durationSec))]))!
    }

    static func line(_ index: Int, file: URL?, durationSec: Double) -> EngineItem {
        EngineItem(node: .object([
            JSONMember("id", .string("f1#\(index)")), JSONMember("kind", .string("tts")),
            JSONMember("type", .string("narration")),
            JSONMember("audio_url", file.map { .string($0.absoluteString) } ?? .null),
            JSONMember("script", .string("A line read aloud.")),
            JSONMember("duration_sec", .number(durationSec))]))!
    }

    /// One tape: the Foray played from its first item until its last item is
    /// `.playing` (or `timeout`), sampled for audibility throughout.
    @MainActor
    final class Tape {
        let spy: SpyDeck
        let speaker: ScriptedSpeaker
        let world: FakeWorld
        let engine: ForayEngine
        let items: [EngineItem]
        /// The decks' and the pair's rows (a plain box: AVDeck calls it on main).
        final class RowSink { var rows: [DiagEntry] = [] }
        let sink: RowSink
        var rows: [DiagEntry] { sink.rows }
        private(set) var maxAudible = 0
        private(set) var audibleSamples: [(ms: Double, count: Int)] = []

        init(items: [EngineItem], speechSec: Double) {
            let box = RowSink()
            let fakes = FakeWorld()
            let deck = SpyDeck(deadlineSec: NarrationSeamTests.testDeadlineSec, rows: { box.rows.append($0) })
            let voice = ScriptedSpeaker(lineSec: speechSec)
            let seams = EngineSeams(session: fakes.session, background: fakes.background, remote: fakes.remote,
                                    nowPlaying: fakes.nowPlaying, deck: deck, speaker: voice,
                                    timing: MainQueueTiming(), output: fakes.output)
            self.items = items
            sink = box
            world = fakes
            spy = deck
            speaker = voice
            engine = ForayEngine(seams: seams, config: EngineConfig(build: "test", forayTapeEnabled: true,
                                                                   deckPairEnabled: true))
        }

        var audibleNow: Int {
            spy.decks.filter { $0.player.rate != 0 }.count + (speaker.sounding ? 1 : 0)
        }

        func run(timeout: TimeInterval) -> Bool {
            engine.start()
            let sampler = Timer(timeInterval: 0.005, repeats: true) { [unowned self] _ in
                MainActor.assumeIsolated {
                    let count = self.audibleNow
                    self.maxAudible = max(self.maxAudible, count)
                    if count > 1 { self.audibleSamples.append((NarrationSeamTests.nowMs(), count)) }
                }
            }
            RunLoop.main.add(sampler, forMode: .common)
            engine.handle(.queue(.loadForay(items, isLocalFile: true, allowAdPad: false)))
            engine.handle(.queue(.playIndex(0, startSec: nil, source: .tap)))
            let lastId = items[items.count - 1].id
            let until = Date().addingTimeInterval(timeout)
            var done = false
            while Date() < until {
                if let token = spy.token(of: lastId),
                   spy.firstEvent({ if case .timeControl(token, .playing, _) = $0 { return true }; return false }) != nil {
                    done = true
                    break
                }
                RunLoop.main.run(until: Date().addingTimeInterval(0.01))
            }
            // A little more of the last clip, so a late second sound shows.
            RunLoop.main.run(until: Date().addingTimeInterval(0.3))
            sampler.invalidate()
            engine.teardown()
            return done
        }

        /// The packed seam rows the core wrote, in order.
        var seams: [SeamRow] {
            world.output.diags.compactMap { entry in
                guard entry.kind == SeamRow.kind else { return nil }
                return SeamRow(DiagRow(seq: 0, wallMs: 0, monoMs: 0, kind: entry.kind, fields: entry.fields))
            }
        }

        /// `.ended` of item `from` to the first `.playing` of item `to`.
        func silenceMs(from: String, to: String) -> Double? {
            guard let out = spy.token(of: from), let into = spy.token(of: to),
                  let ended = spy.firstEvent({ $0 == .ended(token: out) }),
                  let playing = spy.firstEvent(after: ended, {
                      if case .timeControl(into, .playing, _) = $0 { return true }; return false
                  }) else { return nil }
            return playing - ended
        }

        func deckRows(_ event: String, token: DeckToken? = nil) -> [DiagEntry] {
            rows.filter { row in
                guard row.kind == "deck", row[field: "kind"] == .string(event) else { return false }
                guard let token else { return true }
                return row[field: "token"] == .number(Double(token))
            }
        }
    }

    // MARK: - clip -> rendered line -> clip

    /// THE CARD'S CASE. Both clips are from click-cbr.mp3; the line is a 5 s
    /// file. The first clip's window (at its play: a 6 s slice is inside the
    /// 12 s lead) prepares the line; the line is promoted at the out-point;
    /// its own window (from its duration: at its play) prepares the second
    /// clip on the DEMOTED deck, which still holds the episode, by a seek
    /// (`deck kind=reuse`); the second clip is promoted at the line's end.
    /// TO SEE IT FAIL: put the beat rule back in `warmNextSegment` (the line
    /// is then loaded cold, and so is the clip after it), or open no window
    /// for an item without an out-point in AVDeck (the clip after the line is
    /// then attached cold).
    @MainActor
    func testClipRenderedLineClipPreparesBothSeamsInsideTheBudgetOnLocalFiles() throws {
        let cbr = try fixture("click-cbr.mp3")
        let lineFile = try NarrationSeamTests.writeLine(seconds: 5)
        let items = [NarrationSeamTests.clip(0, cbr, 10, 16, durationSec: 90),
                     NarrationSeamTests.line(1, file: lineFile, durationSec: 5),
                     NarrationSeamTests.clip(2, cbr, 40, 43, durationSec: 90)]
        var table: [[String]] = []
        var best: (into: Double?, outOf: Double?) = (nil, nil)
        for attempt in 1...NarrationSeamTests.attempts {
            let tape = Tape(items: items, speechSec: 2)
            let finished = tape.run(timeout: 60)
            XCTAssertTrue(finished, "attempt \(attempt): the last clip never played; \(tape.spy.events.map { $0.event })")
            XCTAssertLessThanOrEqual(tape.maxAudible, 1, "attempt \(attempt): two things audible at \(tape.audibleSamples)")
            XCTAssertEqual(tape.speaker.spokenAtMs, [], "attempt \(attempt): a rendered line that plays is never spoken")
            let lineToken = tape.spy.token(of: "f1#1") ?? 0
            let clipToken = tape.spy.token(of: "f1#2") ?? 0
            let lineHit = tape.spy.prepared(lineToken) == true
            let clipHit = tape.spy.prepared(clipToken) == true
            let coldAttach = !tape.deckRows("attach", token: clipToken).isEmpty
            let seekPrepare = tape.deckRows("reuse").contains { ($0[field: "token"]?.numberValue ?? 0) < 0 }
            let into = tape.silenceMs(from: "f1#0", to: "f1#1")
            let outOf = tape.silenceMs(from: "f1#1", to: "f1#2")
            let rows = tape.seams
            let kinds = rows.map { "\($0.from?.rawValue ?? "?")>\($0.to?.rawValue ?? "?") \($0.prepare?.rawValue ?? "?")" }
            table.append(["\(attempt)", lineHit ? "hit" : "miss", clipHit ? "hit" : "miss",
                          into.map { msValue($0) } ?? "-", outOf.map { msValue($0) } ?? "-",
                          coldAttach ? "yes" : "no", seekPrepare ? "yes" : "no", kinds.joined(separator: ", ")])
            let inside = [into, outOf].allSatisfy { ($0 ?? .infinity) <= NarrationSeamTests.seamBudgetMs }
            best = (into, outOf)
            if lineHit && clipHit && !coldAttach && inside && finished {
                XCTAssertEqual(rows.map(\.from), [.clip, .line], "\(kinds)")
                XCTAssertEqual(rows.map(\.to), [.line, .clip], "\(kinds)")
                XCTAssertEqual(rows.map(\.prepare), [.hit, .hit], "\(kinds)")
                XCTAssertTrue(seekPrepare, "the clip after the line was prepared by a seek on the demoted deck: \(tape.rows)")
                break
            }
            if attempt == NarrationSeamTests.attempts {
                XCTAssertTrue(lineHit, "the rendered line was not promoted on any of \(attempt) tapes: \(table)")
                XCTAssertTrue(clipHit, "the clip after the line was not promoted on any of \(attempt) tapes: \(table)")
                XCTAssertFalse(coldAttach, "the clip after the line was attached cold: \(table)")
                XCTAssertLessThanOrEqual(best.into ?? .infinity, NarrationSeamTests.seamBudgetMs, "clip -> line: \(table)")
                XCTAssertLessThanOrEqual(best.outOf ?? .infinity, NarrationSeamTests.seamBudgetMs, "line -> clip: \(table)")
            }
            print("NE-45s | attempt \(attempt) missed a hit or the budget; a fresh tape")
        }
        MeasurementReport.table(
            title: "NE-45s: clip -> rendered line -> clip on local files (the real core and DeckPair)",
            columns: ["tape", "line prepare", "clip prepare", "clip -> line silence ms", "line -> clip silence ms",
                      "cold attach of the 2nd clip", "2nd clip prepared by a seek", "seam rows"],
            rows: table,
            notes: ["Budget: SEAM_GAP_SEC \(SeamGap.defaultGapSec) s + 250 ms = \(Int(NarrationSeamTests.seamBudgetMs)) ms at each boundary (a line seam asks for no beat).",
                    "click-cbr.mp3 10-16 s, a 5 s generated WAV line, click-cbr.mp3 40-43 s; silence is the outgoing `.ended` to the incoming `.playing`.",
                    "Tapes are re-run (up to \(NarrationSeamTests.attempts)) only while a hit or the budget is missed; never-two-audible is asserted on every tape."],
            tag: NarrationSeamTests.tag)
    }

    // MARK: - clip -> spoken line -> clip

    /// The clip after a SPOKEN line is prepared under the voice, at the line's
    /// start, and the seam out of the line is `prepare=hit`. The voice starts
    /// only after the first clip's `.ended`, and nothing else sounds under it.
    /// TO SEE IT FAIL: drop the `line-start` warm from `narrationStarted`.
    @MainActor
    func testTheClipAfterASpokenLineIsPreparedUnderTheVoiceAndIsAHit() throws {
        let cbr = try fixture("click-cbr.mp3")
        let wav = try fixture("click.wav")
        let items = [NarrationSeamTests.clip(0, cbr, 10, 16, durationSec: 90),
                     NarrationSeamTests.line(1, file: nil, durationSec: 4),
                     NarrationSeamTests.clip(2, wav, 20, 23, durationSec: 60)]
        var table: [[String]] = []
        for attempt in 1...NarrationSeamTests.attempts {
            let tape = Tape(items: items, speechSec: 2)
            let finished = tape.run(timeout: 60)
            XCTAssertTrue(finished, "attempt \(attempt): the last clip never played; \(tape.spy.events.map { $0.event })")
            XCTAssertLessThanOrEqual(tape.maxAudible, 1, "attempt \(attempt): two things audible at \(tape.audibleSamples)")
            let ended = tape.spy.token(of: "f1#0").flatMap { t in tape.spy.firstEvent({ $0 == .ended(token: t) }) }
            let spoke = tape.speaker.spokenAtMs.first
            XCTAssertNotNil(spoke, "attempt \(attempt): the line was never spoken")
            if let ended, let spoke { XCTAssertGreaterThanOrEqual(spoke, ended, "attempt \(attempt): a voice before the clip ended") }
            let clipToken = tape.spy.token(of: "f1#2") ?? 0
            let hit = tape.spy.prepared(clipToken) == true
            let row = tape.seams.last
            let silence = tape.speaker.finishedAtMs.flatMap { done in
                tape.spy.firstEvent(after: done, { if case .timeControl(clipToken, .playing, _) = $0 { return true }; return false })
                    .map { $0 - done }
            }
            table.append(["\(attempt)", hit ? "hit" : "miss", row?.prepare?.rawValue ?? "-", silence.map { msValue($0) } ?? "-"])
            if hit && finished {
                XCTAssertEqual(row?.from, .line)
                XCTAssertEqual(row?.to, .clip)
                XCTAssertEqual(row?.prepare, .hit, "the clip after a spoken line is prepare=hit")
                break
            }
            if attempt == NarrationSeamTests.attempts {
                XCTFail("the clip after the spoken line was not promoted on any of \(attempt) tapes: \(table)")
            }
        }
        MeasurementReport.table(
            title: "NE-45s: the clip after a spoken line (prepared at the line's start)",
            columns: ["tape", "clip prepare", "seam row prepare", "voice finished -> clip .playing ms"],
            rows: table,
            notes: ["click-cbr.mp3 10-16 s, a spoken line (the scripted synthesiser speaks 2 s), click.wav 20-23 s."],
            tag: NarrationSeamTests.tag)
    }

    // MARK: - a prepared line whose file is missing

    /// A prepared line whose file 404s (here: a local file that does not
    /// exist) fails on the STANDBY, and the core hears nothing of it: the
    /// first clip plays to its out-point with no voice over it. At the line's
    /// turn its load misses, fails again cold, and the line is spoken; the
    /// seam into it says `prepare=miss`.
    /// TO SEE IT FAIL: forward the standby's `.failed` to the core (the line
    /// is then spoken over the first clip).
    @MainActor
    func testAPreparedLineWhoseFileIsMissingIsSpokenAtItsTurnWithNoEarlyAudio() throws {
        let cbr = try fixture("click-cbr.mp3")
        let wav = try fixture("click.wav")
        let missing = FileManager.default.temporaryDirectory.appendingPathComponent("ne45s-missing-\(UUID().uuidString).m4a")
        let items = [NarrationSeamTests.clip(0, cbr, 10, 16, durationSec: 90),
                     NarrationSeamTests.line(1, file: missing, durationSec: 4),
                     NarrationSeamTests.clip(2, wav, 20, 23, durationSec: 60)]
        let tape = Tape(items: items, speechSec: 2)
        let finished = tape.run(timeout: 60)
        XCTAssertTrue(finished, "the last clip never played; \(tape.spy.events.map { $0.event })")
        XCTAssertLessThanOrEqual(tape.maxAudible, 1, "two things audible at \(tape.audibleSamples)")
        let warmFailed = tape.rows.contains { $0.kind == "prepare" && $0[field: "kind"] == .string("warm-failed") }
        XCTAssertTrue(warmFailed, "the line was prepared, and its warm load failed on the standby: \(tape.rows)")
        let ended = try XCTUnwrap(tape.spy.token(of: "f1#0").flatMap { t in tape.spy.firstEvent({ $0 == .ended(token: t) }) },
                                  "the first clip never reached its out-point")
        let spoke = try XCTUnwrap(tape.speaker.spokenAtMs.first, "the line was never spoken")
        XCTAssertGreaterThanOrEqual(spoke, ended, "the voice started \(ended - spoke) ms BEFORE the line's turn")
        XCTAssertEqual(tape.speaker.spokenAtMs.count, 1, "spoken once")
        let lineToken = try XCTUnwrap(tape.spy.token(of: "f1#1"))
        XCTAssertEqual(tape.spy.prepared(lineToken), false, "at its turn the prepared line is a miss")
        let into = try XCTUnwrap(tape.seams.first { $0.to == .line }, "\(tape.seams)")
        XCTAssertEqual(into.prepare, .miss)
        MeasurementReport.table(
            title: "NE-45s: a prepared line whose file is missing",
            columns: ["clip .ended -> voice ms", "seam into the line", "max audible"],
            rows: [[msValue(spoke - ended), into.prepare?.rawValue ?? "-", "\(tape.maxAudible)"]],
            notes: ["The standby's warm load failed before the out-point (`prepare kind=warm-failed`); nothing reached the core until the line's own load failed at its turn."],
            tag: NarrationSeamTests.tag)
    }
}
