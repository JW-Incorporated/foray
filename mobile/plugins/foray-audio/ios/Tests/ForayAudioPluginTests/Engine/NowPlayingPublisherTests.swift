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

    /// Spin main until `condition` holds (artwork lands on a later main turn).
    func waitUntil(_ what: String, timeout: Double = 5, _ condition: @escaping () -> Bool) {
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

    /// A seek rewrites the entry at the new playhead at once; a position tick
    /// that lands where the OS's extrapolation already has it writes nothing,
    /// and one the playhead drifted away from does.
    /// TO SEE IT FAIL: drop the seek's forced write, or write on every turn.
    @MainActor
    func testASeekRewritesAndAnOnScheduleTickDoesNot() {
        let world = FakeWorld()
        let engine = playing(world)
        let start = world.deck.reading.positionSec ?? 0
        let writes = world.nowPlaying.writes

        world.timing.advance(5000)
        world.deck.reading.positionSec = start + 5
        engine.handle(.timer(.positionTick))
        XCTAssertEqual(world.nowPlaying.writes, writes, "the lock screen already counts on by itself")

        engine.handle(.command(.seekTo(sec: 600), source: .tap))
        XCTAssertEqual(world.nowPlaying.writes, writes + 1)
        XCTAssertEqual(world.nowPlaying.last?.positionState?.position, 600)

        world.timing.advance(1000)
        world.deck.reading.positionSec = 900
        engine.handle(.timer(.positionTick))
        XCTAssertEqual(world.nowPlaying.writes, writes + 2, "a drift is corrected")
        XCTAssertEqual(world.nowPlaying.last?.positionState?.position, 900)
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
                                                                   playbackRate: 1.5, playing: true)))
        let playing = try XCTUnwrap(center.nowPlayingInfo)
        XCTAssertEqual((playing[MPNowPlayingInfoPropertyPlaybackRate] as? NSNumber)?.doubleValue, 1.5)

        publisher.write(MediaMapping.sessionView(MediaMapping.View(item: item, durationSec: 1800, positionSec: 131,
                                                                   playbackRate: 1.5, playing: false)))
        let paused = try XCTUnwrap(center.nowPlayingInfo)
        XCTAssertEqual((paused[MPNowPlayingInfoPropertyPlaybackRate] as? NSNumber)?.doubleValue, 0)
        XCTAssertEqual(paused[MPMediaItemPropertyTitle] as? String, "Grilling")
        XCTAssertEqual(paused[MPMediaItemPropertyArtist] as? String, "Cooking Show")
        XCTAssertEqual((paused[MPMediaItemPropertyPlaybackDuration] as? NSNumber)?.doubleValue, 1800)
        XCTAssertEqual((paused[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? NSNumber)?.doubleValue, 131)
    }

    // MARK: - Artwork

    /// Plan §4.5: artwork is bounded at the deadline, and a load that misses
    /// it drops the key. The previous item's square is never left showing,
    /// and a dead source is not fetched again on the next write.
    /// TO SEE IT FAIL: keep the last artwork when the new one is not ready,
    /// wait on the fetch without a deadline, or not cache the failure.
    func testAnArtworkTimeoutDropsTheKey() {
        var fetches = 0
        let square = Self.square()
        let cache = ArtworkCache(timeoutSec: 0.2, fetcher: { _, _, _ in
            fetches += 1
            return {}
        }, bundleReader: { _ in square })
        let center = DictionaryCenter()
        let publisher = NowPlayingPublisher(center: center, artwork: cache)

        // Our own icon (bundled) lands on a later main turn and is attached.
        publisher.write(Self.view(title: "A"))
        XCTAssertNil(center.nowPlayingInfo?[MPMediaItemPropertyArtwork])
        waitUntil("our icon lands") { center.nowPlayingInfo?[MPMediaItemPropertyArtwork] != nil }
        XCTAssertEqual(center.nowPlayingInfo?[MPMediaItemPropertyTitle] as? String, "A")

        // A publisher's square that never answers.
        let show = "https://img.example/show/600x600bb.jpg"
        publisher.write(Self.view(title: "B", artwork: show, position: 10))
        XCTAssertNil(center.nowPlayingInfo?[MPMediaItemPropertyArtwork], "never the previous item's square")
        XCTAssertTrue(cache.isLoading(show))
        waitUntil("the deadline passes") { !cache.isLoading(show) }
        guard case .failed = cache.lookup(show) else { return XCTFail("a timed-out load is a failure") }
        XCTAssertNil(center.nowPlayingInfo?[MPMediaItemPropertyArtwork])

        publisher.write(Self.view(title: "B", artwork: show, position: 20, playing: false))
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
