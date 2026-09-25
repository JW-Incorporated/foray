import XCTest
import ForayEngineCore

/// Card NE-18: the core's two surface readings, host-free (Linux and macOS
/// `swift test`). `commandSnapshot` is what the remote buttons are enabled
/// from and `mediaView` what Now Playing says; the host only carries them to
/// MediaPlayer.
///
/// Each test names the edit that turns it red.
final class EngineSurfaceTests: XCTestCase {
    typealias Host = EngineCoreTests.Host

    static func item(_ id: String) -> EngineItem {
        EngineCoreTests.item(id, [JSONMember("title", .string("Title \(id)")), JSONMember("show", .string("Show")),
                                  JSONMember("artwork_url", .string("https://img.example/\(id)/600x600bb.jpg"))])
    }

    func playing(_ ids: [String]) -> Host {
        var host = Host()
        host.send(.queue(.load(ids.map { Self.item($0) })))
        host.send(.queue(.playIndex(0, startSec: nil, source: .tap)))
        host.land()
        host.confirm()
        XCTAssertEqual(host.core.state.stateType, "playing")
        return host
    }

    /// Nothing current is `none`; a playing episode with a next is `episode`
    /// with both neighbours; a close is `none` again until a play reopens it.
    /// An audition does not reopen a closed player.
    /// TO SEE IT FAIL: leave `closed` unset by `stop`, clear it on an
    /// audition, or never clear it.
    func testTheSnapshotModeFollowsACloseAndAPlay() {
        XCTAssertEqual(Host().core.commandSnapshot.mode, .unloaded)

        var host = playing(["a", "b"])
        XCTAssertEqual(host.core.commandSnapshot,
                       MediaMapping.CommandSnapshot(mode: .episode, ended: false, canNext: true, canPrevious: true))

        host.send(.command(.stop(persist: true), source: .tap))
        XCTAssertTrue(host.core.state.closed)
        XCTAssertEqual(host.core.commandSnapshot.mode, .unloaded)
        XCTAssertTrue(MediaMapping.commandAvailability(host.core.commandSnapshot).clearsNowPlaying)
        XCTAssertNil(host.core.mediaView(deck: host.reading))

        host.send(.command(.audition(text: "Hello", voiceId: nil), source: .tap))
        XCTAssertTrue(host.core.state.closed, "an audition is not a play of the queue")

        host.send(.queue(.playIndex(0, startSec: nil, source: .tap)))
        XCTAssertFalse(host.core.state.closed)
        XCTAssertEqual(host.core.commandSnapshot.mode, .episode)

        var deleted = playing(["a"])
        deleted.send(.command(.purge, source: .tap))
        XCTAssertEqual(deleted.core.commandSnapshot.mode, .unloaded, "a data deletion clears Now Playing too")
    }

    /// A pause is not a close: the snapshot keeps its mode and the view its
    /// words, PAUSED.
    /// TO SEE IT FAIL: set `closed` on a pause.
    func testAPauseKeepsTheEntry() throws {
        var host = playing(["a"])
        host.send(.command(.pause, source: .tap))
        XCTAssertEqual(host.core.commandSnapshot.mode, .episode)
        let view = MediaMapping.sessionView(try XCTUnwrap(host.core.mediaView(deck: host.reading)))
        XCTAssertEqual(view.metadata.title, "Title a")
        XCTAssertEqual(view.metadata.artist, "Show")
        XCTAssertEqual(view.metadata.artwork.first?.src, "https://img.example/a/600x600bb.jpg")
        XCTAssertEqual(view.playbackState, MediaMapping.paused)
    }

    /// The playhead is the deck's while it holds the item and the next
    /// play's start otherwise: a restored entry says where play resumes.
    /// A load in flight stops the OS clock.
    /// TO SEE IT FAIL: read the deck for an item it does not hold, or report
    /// the listener's rate while the load is in flight.
    func testThePlayheadIsTheDecksOrTheRestoredOne() throws {
        var host = Host(positions: ["a": ResumeRules.StoredPosition(seconds: 754, duration: 1800)])
        host.send(.lifecycle(.coldLaunch(queue: [Self.item("a")], index: 0, autoplay: false)))
        let restored = try XCTUnwrap(host.core.mediaView(deck: DeckReading(positionSec: 3, durationSec: 99)))
        XCTAssertEqual(restored.positionSec, 754)
        XCTAssertEqual(restored.durationSec, 1800)
        XCTAssertFalse(restored.playing)

        host.send(.queue(.playIndex(0, startSec: nil, source: .tap)))
        let loading = try XCTUnwrap(host.core.mediaView(deck: host.reading))
        XCTAssertTrue(loading.playing)
        XCTAssertTrue(loading.buffering)
        XCTAssertEqual(MediaMapping.sessionView(loading).positionState?.playbackRate, 0)

        host.land()
        host.confirm()
        let live = try XCTUnwrap(host.core.mediaView(deck: DeckReading(positionSec: 800, durationSec: 1801, audible: true)))
        XCTAssertEqual(live.positionSec, 800)
        XCTAssertEqual(live.durationSec, 1801)
        XCTAssertFalse(live.buffering)
    }
}
