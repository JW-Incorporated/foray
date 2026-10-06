import XCTest
import MediaPlayer
import UIKit
import ForayEngineCore
@testable import ForayAudioPlugin

/// Card NE-18: Now Playing. The host decides when an entry is written and
/// when it is cleared (over the fakes); NowPlayingPublisher turns an entry
/// into the real `MPNowPlayingInfoCenter` dictionary; ArtworkCache bounds and
/// caches the artwork. The car baseline (docs/field-records/2026-09-24-car-
/// baseline.md) is why "nothing is cleared on a pause" is a test, not a hope.
///
/// Each test names the edit that turns it red.
final class NowPlayingPublisherTests: XCTestCase {

    /// A dictionary standing in for the centre (the artwork tests run many
    /// writes and must not leave the shared centre dirty).
    final class DictionaryCenter: NowPlayingInfoCentering {
        var nowPlayingInfo: [String: Any]? {
            didSet { sets += 1 }
        }
        private(set) var sets = 0
    }

    static func item(_ id: String, title: String, show: String, artwork: String? = nil) -> EngineItem {
        var members = [JSONMember("id", .string(id)), JSONMember("kind", .string("episode")),
                       JSONMember("audio_url", .string("https://cdn.example/\(id).mp3")),
                       JSONMember("title", .string(title)), JSONMember("show", .string(show))]
        if let artwork { members.append(JSONMember("artwork_url", .string(artwork))) }
        return EngineItem(node: .object(members))!
    }

    /// An engine playing "Grilling" by "Cooking Show" on a warm deck.
    @MainActor
    func playing(_ world: FakeWorld) -> ForayEngine {
        world.deck.answersReady = true
        let engine = ForayEngine(seams: world.seams, config: EngineConfig(build: "test"))
        engine.start()
        engine.handle(.queue(.load([Self.item("a", title: "Grilling", show: "Cooking Show"),
                                    Self.item("b", title: "Smoking", show: "Cooking Show")])))
        engine.handle(.queue(.playIndex(0, startSec: nil, source: .tap)))
        XCTAssertEqual(engine.state.stateType, "playing")
        return engine
    }

    static func view(title: String, artwork: String? = nil, position: Double = 0, playing: Bool = true,
                     kind: String = "episode") -> MediaMapping.SessionView {
        MediaMapping.sessionView(MediaMapping.View(
            item: MediaMapping.Item(kind: kind, title: title, show: "Show"), showArtworkUrl: artwork,
            durationSec: 600, positionSec: position, playbackRate: 1, playing: playing))
    }

    static func square() -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { context in
            UIColor.orange.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
        }
    }

    /// ArtworkCache's deadline in virtual time: every deadline the cache arms
    /// is held here, with the delay it asked for, and fires only when the test
    /// says so.
    final class ManualDeadlines {
        private(set) var armed: [Double] = []
        private var pending: [() -> Void] = []

        func schedule(_ sec: Double, _ fire: @escaping () -> Void) {
            armed.append(sec)
            pending.append(fire)
        }

        /// Let every armed deadline's time pass (a deadline whose load already
        /// settled is a no-op in the cache, exactly as on main).
        func passAll() {
            let due = pending
            pending = []
            due.forEach { $0() }
        }
    }

    /// Spin main until `condition` holds (artwork lands on a later main turn).
    /// The timeout is only how long a starved runner may take to get there:
    /// nothing the test asserts depends on it.
    func waitUntil(_ what: String, timeout: Double = 60, _ condition: @escaping () -> Bool) {
        let done = expectation(description: what)
        func poll() {
            if condition() { return done.fulfill() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.02) { poll() }
        }
        poll()
        wait(for: [done], timeout: timeout)
    }

    // MARK: - The host: when an entry is written, and when it is not cleared

    /// Plan §4.5: the entry follows every transition, a pause and an
    /// unresumed interruption write rate 0 with every field intact, and
    /// NOTHING is cleared until the listener closes the player; then it is
    /// cleared once and every command is disabled.
    /// TO SEE IT FAIL: clear on a pause or an interruption; write the
    /// listener's rate while paused; keep the entry after a close.
    @MainActor
    func testTheEntryFollowsTransitionsAndIsClearedOnlyByAClose() throws {
        let world = FakeWorld()
        let engine = playing(world)
        let first = try XCTUnwrap(world.nowPlaying.last)
        XCTAssertEqual(first.metadata.title, "Grilling")
        XCTAssertEqual(first.metadata.artist, "Cooking Show")
        XCTAssertEqual(first.playbackState, MediaMapping.playing)
        XCTAssertEqual(NowPlayingRate.of(first), 1)
        XCTAssertEqual(first.positionState?.duration, 3600, "the deck's duration while it holds the item")

        engine.handle(.command(.pause, source: .tap))
        let paused = try XCTUnwrap(world.nowPlaying.last)
        XCTAssertEqual(paused.playbackState, MediaMapping.paused)
        XCTAssertEqual(NowPlayingRate.of(paused), 0)
        XCTAssertEqual(paused.metadata, first.metadata, "a pause keeps every field")
        XCTAssertNotNil(paused.positionState)

        engine.handle(.command(.play, source: .tap))
        XCTAssertEqual(world.nowPlaying.last?.playbackState, MediaMapping.playing)
        world.session.post(.interruptionBegan(reason: "default"))
        world.session.post(.interruptionEnded(shouldResume: false))
        XCTAssertEqual(world.nowPlaying.last?.playbackState, MediaMapping.paused)
        XCTAssertEqual(world.nowPlaying.last?.metadata, first.metadata)
        XCTAssertEqual(world.nowPlaying.clears, 0, "\(world.log.entries)")
        XCTAssertTrue(engine.isPublishingNowPlaying)

        engine.handle(.command(.stop(persist: true), source: .tap))
        XCTAssertEqual(world.nowPlaying.clears, 1)
        XCTAssertNil(world.nowPlaying.last)
        XCTAssertFalse(engine.isPublishingNowPlaying)
        XCTAssertTrue(MediaMapping.RemoteCommand.allCases.allSatisfy { world.remote.enabled[$0] == false })
        XCTAssertTrue(world.output.diags.contains { $0.kind == "nowplaying" && $0[field: "via"] == .string("clear") })

        // A play after the close reopens it.
        engine.handle(.queue(.playIndex(0, startSec: nil, source: .tap)))
        XCTAssertEqual(world.nowPlaying.last?.metadata.title, "Grilling")
        XCTAssertEqual(world.remote.enabled[.play], true)
    }

    /// THE CAR PROGRESS BAR (2026-10-06; the 2026-09-28 report too): a
    /// plain-Bluetooth head unit draws its bar from the elapsed time it is
    /// SENT, so a running entry is rewritten once a second at the deck's own
    /// playhead even when the OS's extrapolation already has it there (steady
    /// 1.5x). A seek and a drift still write at once. A paused or stalled
    /// entry (rate 0) is never refreshed, and no heartbeat stays armed for it.
    /// TO SEE IT FAIL: drop the `.refresh` clause in `rewriteReason` (no write
    /// at the second), arm the heartbeat whatever the rate in
    /// `keepSurfaceRefresh` (it stays live after the pause and the stall), or
    /// drop the seek's forced write (`surfaceMove = .jump`).
    @MainActor
    func testAPlayingEntryIsRefreshedEverySecondAndAPausedOneIsNot() throws {
        let world = FakeWorld()
        let engine = playing(world)
        world.deck.reading.audible = true
        engine.handle(.queue(.setRate(1.5)))
        XCTAssertTrue(engine.isRefreshingNowPlaying, "a running entry arms the 1 s refresh")
        let refreshMs = ForayEngine.nowPlayingRefreshSec * 1000
        XCTAssertEqual(refreshMs, 1000)
        let heartbeat = try XCTUnwrap(world.timing.live.last { $0.afterMs == refreshMs }, "\(world.log.entries)")
        XCTAssertTrue(heartbeat.repeating)
        let start = world.deck.reading.positionSec ?? 0
        let writes = world.nowPlaying.writes

        // Steady 1.5x, the deck exactly where the OS extrapolates it: still
        // one write a second, at the deck's playhead and the listener's rate.
        for second in 1...3 {
            world.deck.reading.positionSec = start + 1.5 * Double(second)
            world.timing.fire(afterMs: refreshMs)
            XCTAssertEqual(world.nowPlaying.writes, writes + second, "second \(second)")
            let entry = try XCTUnwrap(world.nowPlaying.last)
            XCTAssertEqual(entry.positionState?.position, start + 1.5 * Double(second))
            XCTAssertEqual(NowPlayingRate.of(entry), 1.5)
        }

        // A turn half a second after a write writes nothing: no drift, no refresh yet.
        world.timing.advance(500)
        world.deck.reading.positionSec = start + 4.5 + 0.75
        engine.handle(.timer(.positionTick))
        XCTAssertEqual(world.nowPlaying.writes, writes + 3, "half a second after a write")

        // A seek writes at once, at the new playhead.
        engine.handle(.command(.seekTo(sec: 600), source: .tap))
        XCTAssertEqual(world.nowPlaying.writes, writes + 4)
        XCTAssertEqual(world.nowPlaying.last?.positionState?.position, 600)

        // So does a drift, whatever the second says.
        world.timing.advance(200)
        world.deck.reading.positionSec = 900
        engine.handle(.timer(.positionTick))
        XCTAssertEqual(world.nowPlaying.writes, writes + 5, "a drift is corrected at once")
        XCTAssertEqual(world.nowPlaying.last?.positionState?.position, 900)

        // A pause writes rate 0 once and disarms the heartbeat: a minute
        // passes with no write.
        engine.handle(.command(.pause, source: .tap))
        XCTAssertEqual(NowPlayingRate.of(try XCTUnwrap(world.nowPlaying.last)), 0)
        XCTAssertFalse(engine.isRefreshingNowPlaying, "a paused entry's clock stands still")
        XCTAssertFalse(heartbeat.token.isLive)
        XCTAssertNil(world.timing.live.first { $0.afterMs == refreshMs }, "no heartbeat outlives the pause")
        let paused = world.nowPlaying.writes
        world.timing.fire(afterMs: refreshMs)
        world.timing.advance(60_000)
        XCTAssertEqual(world.nowPlaying.writes, paused)

        // A stall (playing, rate 0) is not refreshed either; the sound coming
        // back re-arms it.
        engine.handle(.command(.play, source: .tap))
        let token = try XCTUnwrap(world.deck.lastToken)
        world.deck.report(.timeControl(token: token, status: .playing, waitingReason: nil))
        XCTAssertTrue(engine.isRefreshingNowPlaying, "\(world.log.entries.suffix(8))")
        world.deck.report(.timeControl(token: token, status: .waiting, waitingReason: "AVPlayerWaitingToMinimizeStallsReason"))
        XCTAssertEqual(NowPlayingRate.of(try XCTUnwrap(world.nowPlaying.last)), 0, "a stall stops the clock")
        XCTAssertFalse(engine.isRefreshingNowPlaying, "a stalled entry is not refreshed (p-car-8)")
        world.deck.report(.timeControl(token: token, status: .playing, waitingReason: nil))
        XCTAssertTrue(engine.isRefreshingNowPlaying)
        XCTAssertEqual(world.timing.live.filter { $0.afterMs == refreshMs }.count, 1, "one heartbeat, never two")
    }

    /// The rule itself, on the views: a running entry is due one second after
    /// it was written (a tick a little early still counts, so a busy main
    /// queue does not halve the cadence), a drift is named as one, and a
    /// paused or buffering entry is never due however long it sits.
    /// TO SEE IT FAIL: drop the `.refresh` clause, check it before the drift
    /// (the drift is then misnamed), refresh on rate 0, or drop the early
    /// allowance.
    @MainActor
    func testTheRefreshRuleRunsOnlyWithTheClock() {
        let at100 = Self.view(title: "A", position: 100)
        XCTAssertEqual(ForayEngine.rewriteReason(Self.view(title: "A", position: 101), since: at100, elapsedMs: 1000), .refresh)
        XCTAssertEqual(ForayEngine.rewriteReason(Self.view(title: "A", position: 100.8), since: at100, elapsedMs: 800), .refresh,
                       "a heartbeat a little early still writes")
        XCTAssertNil(ForayEngine.rewriteReason(Self.view(title: "A", position: 100.5), since: at100, elapsedMs: 500))
        XCTAssertEqual(ForayEngine.rewriteReason(Self.view(title: "A", position: 103), since: at100, elapsedMs: 1000), .drift)
        XCTAssertEqual(ForayEngine.rewriteReason(Self.view(title: "B", position: 101), since: at100, elapsedMs: 1000), .transition)

        let paused = Self.view(title: "A", position: 100, playing: false)
        XCTAssertNil(ForayEngine.rewriteReason(paused, since: paused, elapsedMs: 60_000), "a paused entry is never refreshed")
        let buffering = MediaMapping.sessionView(MediaMapping.View(
            item: MediaMapping.Item(kind: "episode", title: "A", show: "Show"), durationSec: 600, positionSec: 100,
            playbackRate: 1.5, buffering: true, playing: true))
        XCTAssertEqual(NowPlayingRate.of(buffering), 0)
        XCTAssertNil(ForayEngine.rewriteReason(buffering, since: buffering, elapsedMs: 60_000), "nor is a stalled one")
    }

    /// DV-10: what the car was told is on record, with the words, whenever
    /// they or the state change.
    /// TO SEE IT FAIL: drop the `nowplaying` row.
    @MainActor
    func testWhatTheCarWasToldIsOnRecord() throws {
        let world = FakeWorld()
        let engine = playing(world)
        engine.handle(.command(.pause, source: .tap))
        let rows = world.output.diags.filter { $0.kind == "nowplaying" }
        XCTAssertEqual(rows.map { $0[field: "via"] }, [.string("metadata"), .string("state")])
        let row = try XCTUnwrap(rows.first)
        XCTAssertEqual(row[field: "title"], .string("Grilling"))
        XCTAssertEqual(row[field: "artist"], .string("Cooking Show"))
        XCTAssertEqual(rows.last?[field: "rate"], .number(0))
        XCTAssertNotNil(DiagGate.admit(row), "the row passes the gate")
    }

    /// A speed change, a stall and the sound coming back change only the
    /// RATE the car is told: the state stays `playing`. Each is on record as
    /// `via=rate`, with the elapsed time and duration the entry carried and
    /// why a playing entry says 0 (`buffering`), next to the listener's rate.
    /// While playing and not buffering the entry carries the LISTENING rate
    /// (1.5), which with the elapsed time is what a head unit draws its
    /// progress from (the 2026-09-28 car showed the total and no position).
    /// TO SEE IT FAIL: drop the `via = "rate"` branch in `publishSurface`, or
    /// publish 1 instead of the listener's rate.
    @MainActor
    func testARateOnlyChangeIsOnRecord() throws {
        let world = FakeWorld()
        let engine = playing(world)
        let token = try XCTUnwrap(world.deck.lastToken)
        world.deck.reading.audible = true
        engine.handle(.queue(.setRate(1.5)))
        XCTAssertEqual(NowPlayingRate.of(try XCTUnwrap(world.nowPlaying.last)), 1.5, "the listening rate is published")
        world.deck.report(.timeControl(token: token, status: .waiting, waitingReason: "AVPlayerWaitingToMinimizeStallsReason"))
        XCTAssertEqual(NowPlayingRate.of(try XCTUnwrap(world.nowPlaying.last)), 0, "a stall stops the clock")
        world.deck.report(.timeControl(token: token, status: .playing, waitingReason: nil))
        XCTAssertEqual(NowPlayingRate.of(try XCTUnwrap(world.nowPlaying.last)), 1.5)
        let rows = world.output.diags.filter { $0.kind == "nowplaying" }
        XCTAssertEqual(rows.map { $0[field: "via"] },
                       [.string("metadata"), .string("rate"), .string("rate"), .string("rate")])
        XCTAssertEqual(rows.map { $0[field: "rate"] }, [.number(1), .number(1.5), .number(0), .number(1.5)])
        XCTAssertEqual(rows.map { $0[field: "buffering"] }, [.bool(false), .bool(false), .bool(true), .bool(false)])
        XCTAssertEqual(rows.map { $0[field: "state"] }, Array(repeating: .string(MediaMapping.playing), count: 4))
        XCTAssertEqual(rows.last?[field: "listenRate"], .number(1.5))
        XCTAssertEqual(rows.last?[field: "durationSec"], .number(3600))
        XCTAssertNotNil(rows.last?[field: "elapsedSec"]?.numberValue)
        for row in rows { XCTAssertNil(DiagGate.admit(row)?[field: DiagGate.droppedField], "the gate dropped part of \(row)") }
    }

    /// A car's skip and a drift are rewritten AND on record (2026-10-06: a
    /// paste with no row after a skip read as a missing write), with the new
    /// playhead; the 1 s refreshes write no row of their own and are counted
    /// into the next one (`refreshes`), and every row passes the gate whole.
    /// TO SEE IT FAIL: leave `via` nil for a jump or a drift in
    /// `publishSurface`, write a row per refresh, or never reset the count.
    @MainActor
    func testSeekAndDriftRewritesAreOnRecord() throws {
        let world = FakeWorld()
        let engine = playing(world)
        world.deck.reading.audible = true
        world.deck.reading.positionSec = 100
        func rows() -> [DiagEntry] { world.output.diags.filter { $0.kind == "nowplaying" } }
        XCTAssertEqual(rows().map { $0[field: "via"] }, [.string("metadata")])

        XCTAssertEqual(world.remote.press(.skipForward), .success)
        let seek = try XCTUnwrap(rows().last)
        XCTAssertEqual(seek[field: "via"], .string("seek"), "\(rows().map(\.fields))")
        XCTAssertEqual(seek[field: "elapsedSec"], .number(100 + MediaMapping.seekForwardSec))
        XCTAssertEqual(seek[field: "state"], .string(MediaMapping.playing))

        world.timing.advance(200)
        world.deck.reading.positionSec = 400
        engine.handle(.timer(.positionTick))
        let drift = try XCTUnwrap(rows().last)
        XCTAssertEqual(drift[field: "via"], .string("drift"))
        XCTAssertEqual(drift[field: "elapsedSec"], .number(400))
        XCTAssertEqual(drift[field: "refreshes"], .number(0))

        let before = rows().count
        for second in 1...3 {
            world.deck.reading.positionSec = 400 + Double(second)
            world.timing.fire(afterMs: ForayEngine.nowPlayingRefreshSec * 1000)
        }
        XCTAssertEqual(rows().count, before, "a refresh writes no row: 3,600 an hour would flood the ring")
        engine.handle(.command(.pause, source: .tap))
        let pause = try XCTUnwrap(rows().last)
        XCTAssertEqual(pause[field: "via"], .string("state"))
        XCTAssertEqual(pause[field: "refreshes"], .number(3), "the refreshes since the last row are counted into the next")
        XCTAssertEqual(pause[field: "listenRate"], .number(1))
        for row in rows() {
            let admitted = try XCTUnwrap(DiagGate.admit(row))
            XCTAssertNil(admitted[field: DiagGate.droppedField], "the gate dropped part of \(row)")
        }
    }

    /// The host hands the publisher the listener's rate on every write, the
    /// paused one included: the default an entry whose clock stands still
    /// (rate 0) falls back to. A running entry's default is its own rate, so
    /// what each write carries is 1.5 / 1.5 playing a clip at 1.5x and
    /// 0 / 1.5 paused there.
    /// TO SEE IT FAIL: pass `NowPlayingRate.of(entry)` (0 while paused) or a
    /// literal 1 instead of `core.state.rate` in `publishSurface`.
    @MainActor
    func testTheHostPassesTheListenersRateOnEveryWrite() throws {
        let world = FakeWorld()
        let engine = playing(world)
        func published() throws -> (rate: Double, defaultRate: Double) {
            let rate = NowPlayingRate.of(try XCTUnwrap(world.nowPlaying.last))
            let listen = try XCTUnwrap(world.nowPlaying.listenRates.last)
            return (rate, NowPlayingPublisher.defaultRate(entryRate: rate, listenRate: listen))
        }
        XCTAssertEqual(world.nowPlaying.listenRates.last, 1)
        world.deck.reading.audible = true
        engine.handle(.queue(.setRate(1.5)))
        XCTAssertEqual(world.nowPlaying.listenRates.last, 1.5)
        XCTAssertEqual(try published().rate, 1.5)
        XCTAssertEqual(try published().defaultRate, 1.5)
        engine.handle(.command(.pause, source: .tap))
        XCTAssertEqual(try published().rate, 0)
        XCTAssertEqual(world.nowPlaying.listenRates.last, 1.5, "a paused entry keeps the listener's default rate")
        XCTAssertEqual(try published().defaultRate, 1.5)
        XCTAssertEqual(world.nowPlaying.listenRates.count, world.nowPlaying.writes)
    }

    /// A SPOKEN Foray line at 1.5x, through the host and the real publisher:
    /// the line runs at 1x on the wall clock (`forayMediaView` says 1), so
    /// the entry carries rate 1 AND default 1. A default of 1.5 against a
    /// rate of 1 is the very mismatch a rate-to-AVRCP mapper may report as a
    /// scan, on every narration line; the legacy lane never wrote it (both
    /// keys from the element's real rate). Paused on the line, the clock
    /// stops and the default falls back to the listener's 1.5.
    /// TO SEE IT FAIL: write `defaultRate` from `listenRate` alone (1.5 over
    /// a running 1x line), or from the entry's rate alone (1 instead of 1.5
    /// while paused).
    @MainActor
    func testASpokenLineAtOneAndAHalfCarriesRateOneAndDefaultOne() throws {
        let world = FakeWorld()
        world.deck.answersReady = true
        let center = DictionaryCenter()
        let publisher = NowPlayingPublisher(center: center, artwork: ArtworkCache(
            fetcher: { _, _, _ in {} }, bundleReader: { _ in nil }, deadline: { _, _ in }))
        var seams = world.seams
        seams.nowPlaying = publisher
        let engine = ForayEngine(seams: seams, config: EngineConfig(build: "test", forayTapeEnabled: true))
        engine.start()
        let line = try XCTUnwrap(EngineItem(node: .object([
            JSONMember("id", .string("f1#0")), JSONMember("kind", .string("tts")),
            JSONMember("type", .string("narration")), JSONMember("script", .string("a line")),
            JSONMember("audio_url", .null)
        ])))
        let clip = try XCTUnwrap(EngineItem(node: .object([
            JSONMember("id", .string("f1#1")), JSONMember("kind", .string("episode")),
            JSONMember("audio_url", .string("https://cdn.test/b.mp3")),
            JSONMember("start_sec", .number(300)), JSONMember("end_sec", .number(400)),
            JSONMember("duration_sec", .number(3600))
        ])))
        engine.handle(.queue(.loadForay([line, clip], isLocalFile: false, allowAdPad: false)))
        engine.handle(.queue(.setRate(1.5)))
        engine.handle(.queue(.playIndex(0, startSec: nil, source: .tap)))
        let seq = try XCTUnwrap(world.speaker.narrated.compactMap { command -> Int? in
            if case let .speak(seq, _, _, _) = command { return seq }
            return nil
        }.last, "no line was spoken: \(world.speaker.narrated)")
        world.speaker.report(.started(seq: seq, voiceFallback: false))
        XCTAssertEqual(engine.state.stateType, "playing")
        XCTAssertEqual(engine.state.rate, 1.5)
        func rates() throws -> (rate: Double?, defaultRate: Double?) {
            let info = try XCTUnwrap(center.nowPlayingInfo)
            return ((info[MPNowPlayingInfoPropertyPlaybackRate] as? NSNumber)?.doubleValue,
                    (info[MPNowPlayingInfoPropertyDefaultPlaybackRate] as? NSNumber)?.doubleValue)
        }
        XCTAssertEqual(try rates().rate, 1, "a spoken line runs at 1x on the wall clock")
        XCTAssertEqual(try rates().defaultRate, 1, "and its default agrees, whatever the listener's speed")

        engine.handle(.command(.pause, source: .tap))
        XCTAssertEqual(try rates().rate, 0)
        XCTAssertEqual(try rates().defaultRate, 1.5, "a stopped clock falls back to the listener's rate")
    }

    // MARK: - The real MPNowPlayingInfoCenter

    /// The acceptance line: after a pause the real centre shows rate 0 with
    /// its title, artist, album, duration and playhead intact, and nothing
    /// was ever written to `playbackState`'s place.
    /// TO SEE IT FAIL: write the listener's rate while paused, or build a
    /// paused entry without its fields.
    func testAfterAPauseTheRealCenterShowsRateZeroWithItsFieldsIntact() throws {
        let center = MPNowPlayingInfoCenter.default()
        let publisher = NowPlayingPublisher(center: center, artwork: ArtworkCache(bundleReader: { _ in nil }))
        defer { center.nowPlayingInfo = nil }
        let item = MediaMapping.Item(kind: "episode", title: "Grilling", show: "Cooking Show")

        publisher.write(MediaMapping.sessionView(MediaMapping.View(item: item, durationSec: 1800, positionSec: 120,
                                                                   playbackRate: 1.5, playing: true)), listenRate: 1.5)
        let playing = try XCTUnwrap(center.nowPlayingInfo)
        XCTAssertEqual((playing[MPNowPlayingInfoPropertyPlaybackRate] as? NSNumber)?.doubleValue, 1.5)

        publisher.write(MediaMapping.sessionView(MediaMapping.View(item: item, durationSec: 1800, positionSec: 131,
                                                                   playbackRate: 1.5, playing: false)), listenRate: 1.5)
        let paused = try XCTUnwrap(center.nowPlayingInfo)
        XCTAssertEqual((paused[MPNowPlayingInfoPropertyPlaybackRate] as? NSNumber)?.doubleValue, 0)
        XCTAssertEqual(paused[MPMediaItemPropertyTitle] as? String, "Grilling")
        XCTAssertEqual(paused[MPMediaItemPropertyArtist] as? String, "Cooking Show")
        XCTAssertEqual((paused[MPMediaItemPropertyPlaybackDuration] as? NSNumber)?.doubleValue, 1800)
        XCTAssertEqual((paused[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? NSNumber)?.doubleValue, 131)
    }

    /// The default rate is the entry's running rate while its clock runs and
    /// the listener's while it stands still (docs/ios-lock-screen.md §3):
    /// 1.5 playing a clip at 1.5, 1 for a spoken line at 1.5x (it runs at
    /// 1x; a playing entry's rate and default never disagree, as the legacy
    /// lane's `applyNowPlayingInfo` wrote both from the element's real rate),
    /// and the listener's 1.5 while paused and while buffering (rate 0).
    /// Without the key iOS sees an item playing at 1.5 whose default is 1.0
    /// (2026-10-06).
    /// TO SEE IT FAIL: drop `MPNowPlayingInfoPropertyDefaultPlaybackRate`
    /// from `info`, write `rate` there unguarded (0 while paused), or write
    /// the listener's rate over a running entry (1.5 over the spoken line).
    func testTheDefaultRateIsTheRunningRateOrTheListenersWhileStopped() throws {
        let center = MPNowPlayingInfoCenter.default()
        let publisher = NowPlayingPublisher(center: center, artwork: ArtworkCache(bundleReader: { _ in nil }))
        defer { center.nowPlayingInfo = nil }
        let item = MediaMapping.Item(kind: "episode", title: "Grilling", show: "Cooking Show")
        func rates() throws -> (rate: Double?, defaultRate: Double?) {
            let info = try XCTUnwrap(center.nowPlayingInfo)
            return ((info[MPNowPlayingInfoPropertyPlaybackRate] as? NSNumber)?.doubleValue,
                    (info[MPNowPlayingInfoPropertyDefaultPlaybackRate] as? NSNumber)?.doubleValue)
        }

        publisher.write(MediaMapping.sessionView(MediaMapping.View(item: item, durationSec: 1800, positionSec: 120,
                                                                   playbackRate: 1.5, playing: true)), listenRate: 1.5)
        XCTAssertEqual(try rates().rate, 1.5)
        XCTAssertEqual(try rates().defaultRate, 1.5)

        publisher.write(MediaMapping.sessionView(MediaMapping.View(item: item, durationSec: 1800, positionSec: 131,
                                                                   playbackRate: 1.5, playing: false)), listenRate: 1.5)
        XCTAssertEqual(try rates().rate, 0)
        XCTAssertEqual(try rates().defaultRate, 1.5, "a paused entry keeps the listener's default")

        publisher.write(MediaMapping.sessionView(MediaMapping.View(item: item, durationSec: 1800, positionSec: 131,
                                                                   playbackRate: 1.5, buffering: true, playing: true)),
                        listenRate: 1.5)
        XCTAssertEqual(try rates().rate, 0, "a stall stops the clock (p-car-8)")
        XCTAssertEqual(try rates().defaultRate, 1.5, "and keeps the default")

        // A spoken line at the listener's 1.5x runs at 1x, and so does its
        // default: 1.5 over a 1x clock is what may read as a scan.
        publisher.write(MediaMapping.sessionView(MediaMapping.View(
            item: MediaMapping.Item(kind: "tts", title: "Narration", show: "Foray"), durationSec: 1800,
            positionSec: 140, playbackRate: 1, playing: true, foray: true)), listenRate: 1.5)
        XCTAssertEqual(try rates().rate, 1)
        XCTAssertEqual(try rates().defaultRate, 1)

        // Never 0 or NaN: a running rate wins, then the listener's, then 1.
        XCTAssertEqual(NowPlayingPublisher.defaultRate(entryRate: 1, listenRate: 1.5), 1)
        XCTAssertEqual(NowPlayingPublisher.defaultRate(entryRate: 0, listenRate: 1.5), 1.5)
        XCTAssertEqual(NowPlayingPublisher.defaultRate(entryRate: .nan, listenRate: 2), 2)
        XCTAssertEqual(NowPlayingPublisher.defaultRate(entryRate: 0, listenRate: 0), 1)
        XCTAssertEqual(NowPlayingPublisher.defaultRate(entryRate: 0, listenRate: .nan), 1)
    }

    /// A rewrite of the same picture (the host's 1 s refresh) hands the
    /// centre the SAME `MPMediaItemArtwork`, so CarPlay and a head unit are
    /// never asked to fetch and redraw it once a second; a new picture is a
    /// new object.
    /// TO SEE IT FAIL: build `MPMediaItemArtwork(boundsSize:)` on every write
    /// (`artworkItem` without its one-entry hold).
    func testTheArtworkObjectIsReusedAcrossRewrites() throws {
        let square = Self.square()
        let png = try XCTUnwrap(square.pngData())
        let cache = ArtworkCache(fetcher: { _, _, done in
            done(png)
            return {}
        }, bundleReader: { _ in square }, deadline: { _, _ in })
        let center = DictionaryCenter()
        let publisher = NowPlayingPublisher(center: center, artwork: cache)
        let showA = "https://img.example/a/600x600bb.jpg"
        let showB = "https://img.example/b/600x600bb.jpg"
        func artwork() -> MPMediaItemArtwork? { center.nowPlayingInfo?[MPMediaItemPropertyArtwork] as? MPMediaItemArtwork }

        publisher.write(Self.view(title: "A", artwork: showA, position: 10), listenRate: 1.5)
        waitUntil("A's square lands") { center.nowPlayingInfo?[MPMediaItemPropertyArtwork] != nil }
        let first = try XCTUnwrap(artwork())
        for second in 1...3 {
            publisher.write(Self.view(title: "A", artwork: showA, position: 10 + 1.5 * Double(second)), listenRate: 1.5)
            XCTAssertTrue(artwork() === first, "rewrite \(second) handed the centre a new artwork object")
        }

        publisher.write(Self.view(title: "B", artwork: showB, position: 0), listenRate: 1.5)
        waitUntil("B's square lands") { center.nowPlayingInfo?[MPMediaItemPropertyArtwork] != nil }
        let second = try XCTUnwrap(artwork())
        XCTAssertFalse(second === first, "a new picture is a new object")
        publisher.write(Self.view(title: "B", artwork: showB, position: 1.5), listenRate: 1.5)
        XCTAssertTrue(artwork() === second)
    }

    // MARK: - Artwork

    /// Plan §4.5: artwork is bounded at the deadline, and a load that misses
    /// it drops the key. The previous item's square is never left showing,
    /// and a dead source is not fetched again on the next write.
    /// TO SEE IT FAIL: keep the last artwork when the new one is not ready,
    /// wait on the fetch without a deadline, or not cache the failure.
    ///
    /// WHY THE DEADLINE IS FIRED BY HAND (ci.yml runs 36296215509, 36205293049
    /// and 15 more between 2026-09-25 and 09-27; 10 passed on a re-run). The
    /// test used to give the cache a real 0.2 s deadline and wait on the wall
    /// clock. That deadline raced the bundled icon's read: the read runs on a
    /// utility queue and hops back to main, and on a loaded Simulator that
    /// took longer than 0.2 s, so the deadline settled the ICON as a failure
    /// and "our icon lands" waited out its 5 s for an image that was never
    /// coming. The cache's deadline is now a seam: here it is held and fired
    /// only after the icon has landed, so the icon can never lose that race,
    /// and the deadline the cache ARMS is asserted to be the production
    /// `ArtworkCache.timeoutSec` (10 s, plan §4.5), not a test value.
    func testAnArtworkTimeoutDropsTheKey() {
        var fetches = 0
        let square = Self.square()
        let deadlines = ManualDeadlines()
        let cache = ArtworkCache(fetcher: { _, _, _ in
            fetches += 1
            return {}
        }, bundleReader: { _ in square }, deadline: deadlines.schedule)
        let center = DictionaryCenter()
        let publisher = NowPlayingPublisher(center: center, artwork: cache)

        // Our own icon (bundled) lands on a later main turn and is attached,
        // with its deadline armed and not yet passed.
        publisher.write(Self.view(title: "A"), listenRate: 1)
        XCTAssertNil(center.nowPlayingInfo?[MPMediaItemPropertyArtwork])
        XCTAssertEqual(deadlines.armed, [ArtworkCache.timeoutSec], "every load is bounded at the plan's 10 s")
        waitUntil("our icon lands") { center.nowPlayingInfo?[MPMediaItemPropertyArtwork] != nil }
        XCTAssertEqual(center.nowPlayingInfo?[MPMediaItemPropertyTitle] as? String, "A")

        // A publisher's square that never answers.
        let show = "https://img.example/show/600x600bb.jpg"
        publisher.write(Self.view(title: "B", artwork: show, position: 10), listenRate: 1)
        XCTAssertNil(center.nowPlayingInfo?[MPMediaItemPropertyArtwork], "never the previous item's square")
        XCTAssertTrue(cache.isLoading(show))
        XCTAssertEqual(deadlines.armed, [ArtworkCache.timeoutSec, ArtworkCache.timeoutSec])

        // Its 10 s pass with the fetch still silent: the deadline settles it.
        deadlines.passAll()
        XCTAssertFalse(cache.isLoading(show), "the deadline settles the load whatever the fetch is doing")
        guard case .failed = cache.lookup(show) else { return XCTFail("a timed-out load is a failure") }
        guard case .image = cache.lookup(NowPlayingPublisher.artworkSource(of: Self.view(title: "A")) ?? "") else {
            return XCTFail("a deadline passing after the icon landed must not undo it")
        }
        XCTAssertNil(center.nowPlayingInfo?[MPMediaItemPropertyArtwork])

        publisher.write(Self.view(title: "B", artwork: show, position: 20, playing: false), listenRate: 1)
        XCTAssertNil(center.nowPlayingInfo?[MPMediaItemPropertyArtwork])
        XCTAssertEqual(fetches, 1, "a dead source costs one attempt")
    }

    /// A narration line never shows a publisher's square: its metadata
    /// offers our icon, which is read from the bundle, never the network.
    /// TO SEE IT FAIL: pass the show's artwork through for a `tts` item.
    func testNarrationNeverCarriesAPublishersArtwork() {
        let view = MediaMapping.sessionView(MediaMapping.View(
            item: MediaMapping.Item(kind: EngineConstants.QueueState.tts, title: "bridge-3"),
            nextItem: MediaMapping.Item(kind: "episode", title: "Smoking"),
            showArtworkUrl: "https://img.example/show/600x600bb.jpg", durationSec: 10))
        let src = NowPlayingPublisher.artworkSource(of: view)
        XCTAssertEqual(src, MediaMapping.appArtworkUrl)
        XCTAssertEqual(src.flatMap(ArtworkCache.source(for:)), .bundled(MediaMapping.appArtworkUrl))
    }

    /// Https or bundled, nothing else.
    /// TO SEE IT FAIL: accept `http:` or `data:`, or a path that climbs out
    /// of `public/`.
    func testOnlyHttpsOrBundledArtworkIsRead() {
        XCTAssertEqual(ArtworkCache.source(for: "https://img.example/a.jpg"),
                       .remote(URL(string: "https://img.example/a.jpg")!))
        XCTAssertEqual(ArtworkCache.source(for: "icon-512.png"), .bundled("icon-512.png"))
        XCTAssertEqual(ArtworkCache.source(for: "img/icon.png"), .bundled("img/icon.png"))
        for refused in ["http://img.example/a.jpg", "data:image/png;base64,AAAA", "https://", "/etc/icon.png",
                        "../icon.png", "img/../../icon.png", "icon.png?x=1", "", "javascript:alert(1)"] {
            XCTAssertNil(ArtworkCache.source(for: refused), refused)
        }
    }
}
