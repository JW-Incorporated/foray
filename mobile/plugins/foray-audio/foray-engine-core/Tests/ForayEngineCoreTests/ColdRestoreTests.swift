import XCTest
import ForayEngineCore

/// Card NE-24: the core rebuilt from its own restore record (plan §4.5), and
/// the Developer `simulateTermination` command that writes one on demand.
/// Linux- and macOS-runnable: the host's half (the boot, the exit) is
/// ForayAudioPluginTests/Engine/ColdPathTests.
final class ColdRestoreTests: XCTestCase {

    private static func item(_ id: String) -> JSONNode {
        .object([JSONMember("id", .string(id)), JSONMember("kind", .string("episode")),
                 JSONMember("audio_url", .string("https://cdn.example/\(id).mp3")),
                 JSONMember("duration_sec", .number(3600))])
    }

    private static let event: JSONNode = .object([
        JSONMember("seq", .number(7)), JSONMember("kind", .string("position")),
        JSONMember("episode_id", .string("a")), JSONMember("seconds", .number(600)),
        JSONMember("duration", .null), JSONMember("at", .number(1_790_000_000_000))])

    private static let advance: JSONNode = .object([
        JSONMember("planSeq", .number(2)), JSONMember("hopSeq", .number(0)), JSONMember("nextId", .string("b")),
        JSONMember("seq", .number(4)), JSONMember("at", .number(1_790_000_000_000))])

    private static func record(mode: RestoreRecord.Mode = .episode) -> RestoreRecord {
        RestoreRecord(mode: mode, queue: [item("a"), item("b")], index: 1, offsetSec: 812.5,
                      forayId: mode == .foray ? "f1" : nil, rate: 1.25, advanceLog: [advance], pendingEvents: [event],
                      updatedAt: "2026-09-24T12:00:00.000Z", build: "2026092500")
    }

    private static let now = EngineNow(wallMs: 1_790_000_000_000, monoMs: 1000)

    /// What the record carries comes back, through the stored string (the
    /// bytes a terminated process left), and the queue arrives through
    /// `coldLaunch` without a single audible or session command.
    /// TO SEE IT FAIL: forget the pending events, the advance log, the rate,
    /// or the offset in `restoring`.
    func testARecordRoundTripsIntoACoreThatPaintsWithoutActivating() throws {
        let stored = try XCTUnwrap(RestoreRecord.parse(Self.record().serialized()))
        let cold = try XCTUnwrap(EngineCore.restoring(stored, config: EngineConfig(build: "b")))
        XCTAssertEqual(cold.queue.map(\.id), ["a", "b"])
        XCTAssertEqual(cold.index, 1)
        var core = cold.core
        XCTAssertEqual(core.state.rate, 1.25)
        XCTAssertEqual(core.state.positions["b"]?.seconds, 812.5)
        XCTAssertEqual(core.state.pendingEvents.map(\.seq), [7])
        XCTAssertEqual(core.state.pendingEvents.first?.node, Self.event, "re-sent to the page byte for byte")
        XCTAssertEqual(core.state.lastEventSeq, 7)
        XCTAssertEqual(core.state.advanceLog.map(\.seq), [4])
        XCTAssertEqual(core.state.lastAdvanceSeq, 4)

        let out = core.handle(.lifecycle(.coldLaunch(queue: cold.queue, index: cold.index, autoplay: false)), now: Self.now)
        for command in out {
            switch command {
            case .deck, .sessionActivate, .speak, .graceBegin:
                XCTFail("a cold boot is silent and inactive: \(command)")
            default: break
            }
        }
        XCTAssertEqual(core.state.currentItem?.id, "b")
        XCTAssertEqual(core.state.session, .inactive)
    }

    /// Nothing is guessed: a relinquished record, a Foray (M2), an empty
    /// queue or an item with no id restores nothing.
    func testRecordsWithNothingToPlayRestoreNothing() {
        XCTAssertNil(EngineCore.restoring(.relinquished(updatedAt: "2026-09-24T12:00:00.000Z", build: "b"),
                                          config: EngineConfig()))
        XCTAssertNil(EngineCore.restoring(Self.record(mode: .foray), config: EngineConfig()))
        var empty = Self.record()
        empty.queue = []
        empty.index = 0
        XCTAssertNil(EngineCore.restoring(empty, config: EngineConfig()))
        var noId = Self.record()
        noId.queue = [.object([JSONMember("kind", .string("episode"))]), Self.item("b")]
        XCTAssertNil(EngineCore.restoring(noId, config: EngineConfig()))
    }

    /// DV-7a's command: with a queue it writes the record from the state it
    /// has NOW; with none it is refused `not-loaded`, and writes nothing.
    /// TO SEE IT FAIL: drop the `writeRestore()` or the empty-queue refusal.
    func testSimulateTerminationWritesTheRecordOrIsRefused() throws {
        var idle = EngineCore(config: EngineConfig(build: "b"))
        let refused = idle.handle(.command(.simulateTermination, source: .tap), now: Self.now)
        XCTAssertTrue(refused.contains(.commandFailed(reason: "not-loaded")), "\(refused)")
        XCTAssertFalse(refused.contains { if case .writeRestore = $0 { return true } else { return false } })

        let cold = try XCTUnwrap(EngineCore.restoring(Self.record(), config: EngineConfig(build: "b")))
        var core = cold.core
        _ = core.handle(.lifecycle(.coldLaunch(queue: cold.queue, index: cold.index, autoplay: false)), now: Self.now)
        let out = core.handle(.command(.simulateTermination, source: .tap), now: Self.now)
        let written = out.compactMap { command -> RestoreRecord? in
            if case let .writeRestore(record?) = command { return record }
            return nil
        }
        let record = try XCTUnwrap(written.last, "\(out)")
        XCTAssertEqual(record.mode, .episode)
        XCTAssertEqual(record.index, 1)
        XCTAssertEqual(record.offsetSec, 812.5)
        XCTAssertEqual(record.pendingEvents, [Self.event])
        XCTAssertFalse(out.contains { if case .commandFailed = $0 { return true } else { return false } })
    }
}
