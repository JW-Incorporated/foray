import XCTest
import ForayEngineCore
@testable import ForayAudioPlugin

/// THE COLD PATH (card NE-24; docs/native-engine-plan.md §4.5), over the
/// recording seams: what a car's play meets after iOS terminated 4a.
///
/// `ForayEngineColdPath.bootIfNeeded()` (the AppDelegate's line) reaches
/// `EngineBoot.makeEngine`, which is `ForayEngine(seams:config:)`, `start()`
/// and `coldBoot(from: store.restoreRecord())` over the REAL conformers.
/// These tests drive the same three calls over the fakes, so what they pin
/// is exactly what the boot does, minus AVFoundation.
final class ColdPathTests: XCTestCase {

    private static func itemNode(_ id: String, duration: Double = 3600) -> JSONNode {
        .object([JSONMember("id", .string(id)), JSONMember("kind", .string("episode")),
                 JSONMember("title", .string("Episode \(id)")), JSONMember("show", .string("A Show")),
                 JSONMember("audio_url", .string("https://cdn.example/\(id).mp3")),
                 JSONMember("duration_sec", .number(duration))])
    }

    private static func event(seq: Int) -> JSONNode {
        .object([JSONMember("seq", .number(Double(seq))), JSONMember("kind", .string("position")),
                 JSONMember("episode_id", .string("a")), JSONMember("seconds", .number(700)),
                 JSONMember("duration", .number(3600)), JSONMember("at", .number(1_790_000_000_000))])
    }

    /// What the engine wrote at the pause before iOS ended the process.
    private static func record(offsetSec: Double = 754, rate: Double = 1.5) -> RestoreRecord {
        RestoreRecord(mode: .episode, queue: [itemNode("a"), itemNode("b")], index: 0, offsetSec: offsetSec,
                      rate: rate, pendingEvents: [event(seq: 3)], updatedAt: "2026-09-24T12:00:00.000Z",
                      build: "2026092500")
    }

    /// The boot, over the fakes: construct, start, cold boot.
    @MainActor
    private func booted(_ world: FakeWorld, from record: RestoreRecord?) -> (ForayEngine, ForayEngine.ColdBootOutcome) {
        let engine = ForayEngine(seams: world.seams, config: EngineConfig(build: "2026092500"))
        engine.start()
        let outcome = engine.coldBoot(from: record)
        return (engine, outcome)
    }

    // MARK: - Painting without activating (S-3)

    /// Plan §4.5 and S-3: a boot from a record registers the remote surface
    /// and paints Now Playing at RATE 0, at the recorded position, with ZERO
    /// activations and nothing sent to the deck: iOS must see 4a as the app
    /// that can play, without 4a interrupting anybody at launch.
    /// TO SEE IT FAIL: coldLaunch with `autoplay: true` (activates at boot),
    /// skip `coldBoot`'s coldLaunch (nothing painted, play not-loaded), or
    /// drop the record's offset from the restored positions.
    @MainActor
    func testBootFromARecordPaintsNowPlayingAtRateZeroWithoutActivating() throws {
        let world = FakeWorld()
        let (engine, outcome) = booted(world, from: Self.record())

        XCTAssertEqual(outcome, .painted)
        XCTAssertEqual(world.session.activateCalls, 0, "a cold boot activates nothing (S-3): \(world.log.entries)")
        XCTAssertTrue(world.deck.sent.isEmpty, "a cold boot loads nothing: \(world.deck.sent)")
        XCTAssertEqual(world.remote.liveTargets, MediaMapping.RemoteCommand.allCases.count)
        XCTAssertEqual(world.remote.enabled[.play], true, "the car's play must be enabled")
        XCTAssertEqual(world.remote.enabled[.stop], false)

        let entry = try XCTUnwrap(world.nowPlaying.last, "Now Playing painted from the record")
        XCTAssertEqual(NowPlayingRate.of(entry), 0, "paused: the lock screen's clock stands still")
        XCTAssertEqual(entry.metadata.title, "Episode a")
        XCTAssertEqual(entry.positionState?.position, 754)
        XCTAssertEqual(entry.positionState?.duration, 3600)

        XCTAssertEqual(engine.state.currentIndex, 0)
        XCTAssertEqual(engine.state.queue.map(\.id), ["a", "b"])
        XCTAssertEqual(engine.state.rate, 1.5, "the listener's speed came back")
        XCTAssertEqual(engine.state.pendingEvents.map(\.seq), [3], "an undrained event survives the termination")
        XCTAssertEqual(engine.state.lastEventSeq, 3, "the next event is numbered after it")
        XCTAssertEqual(world.background.liveTasks, 0, "nothing to cover yet")
        let row = try XCTUnwrap(world.output.diags.first { $0.kind == "restore" && $0[field: "kind"] == .string("cold-boot") })
        XCTAssertEqual(row[field: "record"], .string("painted"))
    }

    /// The car's play after the cold boot: grace opens FIRST (the span is
    /// silent from the press), then ONE activation, then the load AT THE
    /// RECORDED OFFSET, then the play, all inside the handler, and the system
    /// is told `.success`.
    /// TO SEE IT FAIL: activate before the grace begin, load from 0 (drop the
    /// restored position), or answer the press before the load.
    @MainActor
    func testAColdPlayBeginsGraceActivatesOnceAndLoadsAtTheRecordedOffset() throws {
        let world = FakeWorld()
        world.deck.answersReady = true
        world.background.backgroundTimeRemainingSec = 25
        let (engine, _) = booted(world, from: Self.record())
        world.log.clear()

        XCTAssertEqual(world.remote.press(.play), .success)

        XCTAssertEqual(world.session.activateCalls, 1)
        let log = world.log.entries
        let grace = try XCTUnwrap(world.log.index(of: "background.begin ForayEngine.grace.remote-play"), "\(log)")
        let activate = try XCTUnwrap(world.log.index(of: "session.activate"), "\(log)")
        let load = try XCTUnwrap(world.log.index(of: "deck.load"), "\(log)")
        let play = try XCTUnwrap(world.log.index(of: "deck.play"), "\(log)")
        XCTAssertLessThan(grace, activate, "\(log)")
        XCTAssertLessThan(activate, load, "\(log)")
        XCTAssertLessThan(load, play, "\(log)")
        guard case let .load(_, itemId, _, startSec, _)? = world.deck.sent.first(where: { $0.logName == "load" }) else {
            return XCTFail("no load: \(world.deck.sent)")
        }
        XCTAssertEqual(itemId, "a")
        XCTAssertEqual(startSec, 754, "the car resumes where the listener paused")
        XCTAssertEqual(engine.state.session, .active)
        XCTAssertEqual(world.background.liveTasks, 1, "grace holds until the deck says .playing")
        withExtendedLifetime(engine) {}
    }

    /// Plan §4.5: with no record, or a `{mode: "relinquished"}` one, the
    /// remote surface still exists (so the press reaches the engine and is
    /// answered, not dropped), paints nothing, activates nothing, and the car
    /// is told `.noActionableNowPlayingItem`.
    /// TO SEE IT FAIL: restore a relinquished record's queue, or answer
    /// `.commandFailed` (the car would retry, or blame the app).
    @MainActor
    func testNoRecordOrARelinquishedRecordAnswersNoActionableNowPlayingItem() throws {
        let relinquished = RestoreRecord.relinquished(updatedAt: "2026-09-24T12:00:00.000Z", build: "2026092500")
        let cases: [(RestoreRecord?, ForayEngine.ColdBootOutcome)] = [(nil, .noRecord), (relinquished, .relinquished)]
        for (record, expected) in cases {
            let world = FakeWorld()
            let (engine, outcome) = booted(world, from: record)
            XCTAssertEqual(outcome, expected)
            XCTAssertEqual(world.remote.liveTargets, MediaMapping.RemoteCommand.allCases.count)
            XCTAssertEqual(world.nowPlaying.writes, 0, "nothing to paint")

            XCTAssertEqual(world.remote.press(.play), .noActionableNowPlayingItem)
            XCTAssertEqual(world.session.activateCalls, 0, "\(world.log.entries)")
            XCTAssertTrue(world.deck.sent.isEmpty)
            XCTAssertEqual(world.background.liveTasks, 0)
            withExtendedLifetime(engine) {}
        }
    }

    /// A Foray record (M2) or a queue item with no id is not guessed at: it
    /// is `unplayable`, painted as nothing. And a cold boot after the first
    /// input never replaces the core the page is already driving.
    /// TO SEE IT FAIL: drop the `handledAny` guard, or restore a Foray.
    @MainActor
    func testUnplayableAndLateRecordsAreNeverRestored() {
        var foray = Self.record()
        foray.mode = .foray
        foray.forayId = "f1"
        var noId = Self.record()
        noId.queue = [.object([JSONMember("kind", .string("episode"))])]
        for record in [foray, noId] {
            let world = FakeWorld()
            let (engine, outcome) = booted(world, from: record)
            XCTAssertEqual(outcome, .unplayable)
            XCTAssertTrue(engine.state.queue.isEmpty)
            XCTAssertEqual(world.nowPlaying.writes, 0)
        }

        let world = FakeWorld()
        let engine = ForayEngine(seams: world.seams, config: EngineConfig(build: "test"))
        engine.start()
        engine.handle(.lifecycle(.foreground))
        XCTAssertEqual(engine.coldBoot(from: Self.record()), .late)
        XCTAssertTrue(engine.state.queue.isEmpty, "the page's core was not replaced")
    }

    // MARK: - Developer "Simulate system termination" (DV-7a)

    /// DV-7a (plan §10): the command persists the restore record NOW, and the
    /// process exits at the next background entry while PAUSED, after the
    /// flush. Playing, it disarms instead: iOS does not end an app that is
    /// playing, and a Developer tap must not cut the listener off. With
    /// nothing queued there is nothing to restore, so it is refused.
    /// TO SEE IT FAIL: exit on the command itself (foreground: not what iOS
    /// does), exit while playing, or exit before the background flush.
    @MainActor
    func testSimulateTerminationPersistsTheRecordAndExitsOnlyPausedInTheBackground() throws {
        let world = FakeWorld()
        var exits = 0
        var seams = world.seams
        seams.terminate = { exits += 1; world.log.add("process.exit") }
        let engine = ForayEngine(seams: seams, config: EngineConfig(build: "test"))
        engine.start()
        engine.coldBoot(from: Self.record())
        let before = world.output.restores.count

        XCTAssertTrue(engine.handle(.command(.simulateTermination, source: .tap)).ok)
        XCTAssertTrue(engine.terminationArmed)
        XCTAssertEqual(world.output.restores.count, before + 1, "the record is persisted at the tap")
        let written = try XCTUnwrap(world.output.restores.last ?? nil)
        XCTAssertEqual(written.mode, .episode)
        XCTAssertEqual(written.queue.count, 2)
        XCTAssertEqual(written.offsetSec, 754)
        XCTAssertEqual(exits, 0, "never in the foreground")

        world.background.post(.background)
        XCTAssertEqual(exits, 1)
        let flush = try XCTUnwrap(world.log.entries.lastIndex(of: "output.flush"))
        let exit = try XCTUnwrap(world.log.index(of: "process.exit"))
        XCTAssertLessThan(flush, exit, "durable before the process ends")
        XCTAssertTrue(world.output.diags.contains { $0[field: "kind"] == .string("sim-termination-exit") })

        // Playing at the background entry: disarmed, and nobody is cut off.
        let playing = FakeWorld()
        playing.deck.answersReady = true
        var playingExits = 0
        var playingSeams = playing.seams
        playingSeams.terminate = { playingExits += 1 }
        let live = ForayEngine(seams: playingSeams, config: EngineConfig(build: "test"))
        live.start()
        live.coldBoot(from: Self.record())
        XCTAssertTrue(live.handle(.command(.simulateTermination, source: .tap)).ok)
        XCTAssertEqual(playing.remote.press(.play), .success)
        playing.background.post(.background)
        XCTAssertEqual(playingExits, 0)
        XCTAssertFalse(live.terminationArmed)
        XCTAssertTrue(playing.output.diags.contains { $0[field: "kind"] == .string("sim-termination-disarmed") })

        // Nothing queued: refused, not armed.
        let empty = FakeWorld()
        let idle = ForayEngine(seams: empty.seams, config: EngineConfig(build: "test"))
        idle.start()
        XCTAssertEqual(idle.handle(.command(.simulateTermination, source: .tap)).failures, ["not-loaded"])
        XCTAssertFalse(idle.terminationArmed)
    }

    // MARK: - The owner: one engine, whichever entry point runs first

    /// The AppDelegate boots first; the plugin's later `load()` attaches to
    /// the SAME engine and registers nothing a second time, and a car's play
    /// that arrives in between is answered by the cold-booted engine.
    /// TO SEE IT FAIL: build a second engine in `pluginDidLoad`, or let
    /// `load()` run the legacy registration in native mode.
    @MainActor
    func testTheBridgesLaterLoadAttachesToTheColdBootedEngine() throws {
        let suite = "ColdPathTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { UserDefaults().removePersistentDomain(forName: suite) }
        let world = FakeWorld()
        world.deck.answersReady = true
        var built = 0
        let owner = EngineOwnership(
            store: EngineOwnershipTests.store(defaults),
            environment: EngineOwnership.LaunchEnvironment(buildDefault: .native, currentBuild: "b1", launchId: "l1"),
            flag: EngineOwnershipTests.FakeFlag(), timing: FakeTiming(log: world.log),
            lifecycle: EngineOwnershipTests.FakeOwnershipLifecycle(), diag: { _ in },
            engineFactory: { @MainActor () -> ForayEngine in
                built += 1
                let engine = ForayEngine(seams: world.seams, config: EngineConfig(build: "b1"))
                engine.start()
                engine.coldBoot(from: Self.record())
                return engine
            })

        let cold = try XCTUnwrap(owner.bootIfNeeded(), "native: the AppDelegate boots the engine")
        XCTAssertEqual(world.remote.press(.play), .success, "the car's play before any page exists")
        var legacyRuns = 0
        owner.pluginDidLoad(legacyRegistration: { legacyRuns += 1 })

        XCTAssertTrue(owner.engine === cold)
        XCTAssertEqual(built, 1, "one engine per process")
        XCTAssertEqual(world.remote.liveTargets, MediaMapping.RemoteCommand.allCases.count, "never re-registered")
        XCTAssertEqual(legacyRuns, 0)
        XCTAssertEqual(world.session.activateCalls, 1)
    }
}
