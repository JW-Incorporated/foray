import XCTest
import ForayEngineCore

/// The position flush at `didEnterBackground` and `willTerminate` (card NE-19;
/// client.js `flushPositions`, corner case #17 and #689): pocketing the phone
/// writes the playhead NOW, paused or playing, whatever the cadence last wrote.
/// EngineStore then writes that row synchronously (the plugin's EngineStoreTests).
final class PositionFlushTests: XCTestCase {
    private typealias Host = EngineCoreTests.Host

    private func writes(_ commands: [EngineCommand]) -> [PositionWrite] {
        commands.compactMap { command in
            if case let .writePosition(write) = command { return write }
            return nil
        }
    }

    private func playingHost() -> Host {
        var host = Host()
        host.send(.queue(.load([EngineCoreTests.item("a")])))
        host.send(.queue(.playIndex(0, startSec: nil, source: .tap)))
        host.land()
        host.confirm()
        XCTAssertEqual(host.core.state.stateType, "playing")
        return host
    }

    /// A PAUSED episode, backgrounded, still writes where it was paused: the
    /// founder's "it jumped back to several minutes ago" (#689).
    /// TO SEE IT FAIL: drop `flushPosition()` from the `.background` case.
    func testBackgroundingAPausedEpisodeWritesItsPlayhead() throws {
        var host = playingHost()
        host.reading.positionSec = 1_394
        host.send(try EngineCoreTests.command("pause"))
        let out = host.send(.lifecycle(.background))
        let write = try XCTUnwrap(writes(out).last, "\(out)")
        XCTAssertEqual(write.itemId, "a")
        XCTAssertEqual(write.seconds, 1_394)
        XCTAssertEqual(write.row.key, "cp_pos:a")
        XCTAssertTrue(write.row.value.hasPrefix("{\"seconds\":1394,"), write.row.value)
        XCTAssertTrue(out.contains { if case .writeRestore = $0 { return true } else { return false } },
                      "the cold path's record moves with it")
    }

    /// `willTerminate` flushes the same way.
    /// TO SEE IT FAIL: drop `flushPosition()` from the `.terminating` case.
    func testTerminatingWritesThePlayhead() throws {
        var host = playingHost()
        host.reading.positionSec = 61
        let write = try XCTUnwrap(writes(host.send(.lifecycle(.terminating))).last)
        XCTAssertEqual(write.seconds, 61)
    }

    /// Nothing loaded, nothing written: the flush never fabricates a position.
    /// TO SEE IT FAIL: write a row without `persistPosition`'s guards.
    func testNothingLoadedWritesNothing() {
        var host = Host()
        XCTAssertEqual(writes(host.send(.lifecycle(.background))), [])
        host.send(.queue(.load([EngineCoreTests.item("a")])))
        XCTAssertEqual(writes(host.send(.lifecycle(.terminating))), [], "queued but never loaded on the deck")
    }
}
