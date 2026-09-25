import XCTest
import MediaPlayer
import ForayEngineCore
@testable import ForayAudioPlugin

/// Card NE-18: the remote surface, headless. The truth table runs every
/// remote command in every snapshot state through the host over recording
/// fakes (a package test cannot press a real `MPRemoteCommand`), and the real
/// `RemoteSurface` is checked for what a Simulator CAN show: the advertised
/// skip pair, `stop` never enabled, the verdict-to-status mapping, and the
/// main-thread discipline of a press that arrives off main.
///
/// Each test names the edit that turns it red.
final class RemoteSurfaceTests: XCTestCase {

    /// The snapshot states an episode can be in when a press arrives.
    enum Situation: String, CaseIterable {
        /// A fresh engine: nothing current.
        case nothing
        /// A cold launch restored item `a` of `[a, b]`, nothing loaded.
        case restored
        /// `a` of `[a, b]` playing.
        case playing
        /// ...then paused by the listener.
        case paused
        /// ...then interrupted by the system.
        case interrupted
        /// `[a]` played to its end: an ended EPISODE (not a finished Foray).
        case ended
        /// ...playing `a` of `[a, b]`, then the listener closed the player.
        case closed

        var hasCurrent: Bool { self != .nothing }
        var canNext: Bool { self != .nothing && self != .ended }
    }

    static func item(_ id: String) -> EngineItem { ForayEngineHostTests.item(id) }

    @MainActor
    static func engine(in situation: Situation, world: FakeWorld) -> ForayEngine {
        world.deck.answersReady = true
        let engine = ForayEngine(seams: world.seams, config: EngineConfig(build: "test"))
        engine.start()
        switch situation {
        case .nothing:
            break
        case .restored:
            engine.handle(.lifecycle(.coldLaunch(queue: [item("a"), item("b")], index: 0, autoplay: false)))
        case .playing, .paused, .interrupted, .closed:
            engine.handle(.queue(.load([item("a"), item("b")])))
            engine.handle(.queue(.playIndex(0, startSec: nil, source: .tap)))
            switch situation {
            case .paused: engine.handle(.command(.pause, source: .tap))
            case .interrupted: world.session.post(.interruptionBegan(reason: "default"))
            case .closed: engine.handle(.command(.stop(persist: true), source: .tap))
            default: break
            }
        case .ended:
            engine.handle(.queue(.load([item("a")])))
            engine.handle(.queue(.playIndex(0, startSec: nil, source: .tap)))
            world.deck.reading.audible = false
            world.deck.reading.ended = true
            world.deck.report(.ended(token: world.deck.lastToken ?? 0))
        }
        return engine
    }

    /// THE DOCUMENTED STATUS of a press, per command, from two facts about the
    /// snapshot (RemoteSurface's header states the same table):
    ///   - pause and stop always succeed (a stop is a pause, T-7);
    ///   - next succeeds exactly when there is a next (else `no-next`, failed);
    ///   - previous succeeds exactly when an item is current (it restarts it);
    ///   - play, toggle, both skips and a scrub succeed when an item is
    ///     current, and are "no actionable item" when nothing is (`not-loaded`,
    ///     the cold path with no restore record, plan §4.5).
    static func documented(_ command: MediaMapping.RemoteCommand, _ situation: Situation) -> RemoteVerdict {
        switch command {
        case .pause, .stop:
            return .success
        case .nextTrack:
            return situation.canNext ? .success : .commandFailed
        case .previousTrack:
            return situation.hasCurrent ? .success : .commandFailed
        case .play, .togglePlayPause, .skipBackward, .skipForward, .changePlaybackPosition:
            return situation.hasCurrent ? .success : .noActionableNowPlayingItem
        }
    }

    // MARK: - The truth table

    /// Every command in every snapshot state returns the documented status,
    /// and the status the system got is the one the `remote event=status` row
    /// records, right after the core's own `remote` row for the same press.
    /// TO SEE IT FAIL: return `.success` from every handler (the legacy
    /// lane's receipt), map `not-loaded` to `.commandFailed`, drop the status
    /// row, or write it before the turn.
    @MainActor
    func testEveryCommandInEverySnapshotStateReturnsTheDocumentedStatus() {
        var wrong: [String] = []
        for situation in Situation.allCases {
            for command in MediaMapping.RemoteCommand.allCases {
                let world = FakeWorld()
                let engine = Self.engine(in: situation, world: world)
                let before = world.output.diags.count
                let value: Double? = command == .changePlaybackPosition ? 60 : nil
                let got = world.remote.press(command, value: value)
                let want = Self.documented(command, situation)
                if got != want {
                    wrong.append("\(situation.rawValue) \(command.rawValue): got \(got.map { $0.token } ?? "nil"), documented \(want.token)")
                }
                let rows = Array(world.output.diags[before...]).filter { $0.kind == "remote" }
                let pressRow = rows.firstIndex { $0[field: "dupCandidate"] != nil }
                let statusRow = rows.firstIndex { $0[field: "kind"] == .string("status") }
                if let pressRow, let statusRow, pressRow < statusRow {
                    if rows[statusRow][field: "status"] != .string(got?.token ?? "") ||
                        rows[statusRow][field: "cmd"] != .string(command.rawValue) {
                        wrong.append("\(situation.rawValue) \(command.rawValue): status row \(rows[statusRow].fields)")
                    }
                    if rows[pressRow][field: "route"] != .string("carAudio") || rows[pressRow][field: "thread"] != .string("main") {
                        wrong.append("\(situation.rawValue) \(command.rawValue): remote row \(rows[pressRow].fields)")
                    }
                } else {
                    wrong.append("\(situation.rawValue) \(command.rawValue): rows \(rows.map(\.fields))")
                }
                withExtendedLifetime(engine) {}
            }
        }
        XCTAssertEqual(wrong, [], wrong.joined(separator: "\n"))
    }

    /// The setups are the states they claim to be (a table over the wrong
    /// states would prove nothing).
    @MainActor
    func testTheSituationsAreWhatTheyClaim() {
        let expected: [Situation: String] = [.nothing: "idle", .restored: "idle", .playing: "playing",
                                             .paused: "interrupted", .interrupted: "interrupted", .ended: "ended"]
        for (situation, stateType) in expected {
            let world = FakeWorld()
            let engine = Self.engine(in: situation, world: world)
            XCTAssertEqual(engine.state.stateType, stateType, "\(situation)")
        }
        let world = FakeWorld()
        let closed = Self.engine(in: .closed, world: world)
        XCTAssertTrue(closed.state.closed)
        XCTAssertEqual(closed.state.session, .inactive, "a close releases the session with notify")
    }

    // MARK: - Enablement

    /// `MediaMapping.commandAvailability` of the core's snapshot, applied to
    /// every command after every turn: all eight transport commands whenever
    /// an item is current, next only with a next, nothing at all with nothing
    /// current or after a close, and `stop` never. The expected sets are
    /// written out, not recomputed, so a mutant snapshot reads differently.
    /// TO SEE IT FAIL: build the snapshot with `canNext: true`, read `ended`
    /// as a finished Foray, leave a close as `mode: episode`, apply the
    /// enablement only at start, or enable `stop`.
    @MainActor
    func testEnablementInEverySnapshotState() {
        let transport: Set<MediaMapping.RemoteCommand> = [.play, .pause, .togglePlayPause, .nextTrack, .previousTrack,
                                                          .skipBackward, .skipForward, .changePlaybackPosition]
        let expected: [Situation: Set<MediaMapping.RemoteCommand>] = [
            .nothing: [], .restored: transport, .playing: transport, .paused: transport, .interrupted: transport,
            .ended: transport.subtracting([.nextTrack]), .closed: []
        ]
        for situation in Situation.allCases {
            let world = FakeWorld()
            let engine = Self.engine(in: situation, world: world)
            XCTAssertEqual(world.remote.enabled.count, MediaMapping.RemoteCommand.allCases.count,
                           "every command has an explicit enabled state: \(situation)")
            let enabled = Set(MediaMapping.RemoteCommand.allCases.filter { world.remote.enabled[$0] == true })
            XCTAssertEqual(enabled, expected[situation], "\(situation)")
            XCTAssertEqual(world.remote.enabled[.stop], false, "\(situation)")
            withExtendedLifetime(engine) {}
        }
    }

    /// The one place a verdict becomes MediaPlayer's status.
    /// TO SEE IT FAIL: answer `.success` for every verdict.
    func testTheVerdictIsTheStatus() {
        XCTAssertEqual(RemoteSurface.status(.success), .success)
        XCTAssertEqual(RemoteSurface.status(.noActionableNowPlayingItem), .noActionableNowPlayingItem)
        XCTAssertEqual(RemoteSurface.status(.commandFailed), .commandFailed)
    }

    // MARK: - The real MPRemoteCommandCenter

    /// The skip pair advertised is the founder's, from `EngineConstants`
    /// through `MediaMapping`; `stop` cannot be enabled; every other command's
    /// enablement is what the host asked; cancelling a target kills it.
    /// TO SEE IT FAIL: advertise a literal pair, or honour `setEnabled(true,
    /// for: .stop)`.
    func testTheRealSurfaceAdvertisesTheFoundersPairAndNeverEnablesStop() {
        let center = MPRemoteCommandCenter.shared()
        let surface = RemoteSurface(center: center, routePort: { "carAudio" })
        let targets = MediaMapping.RemoteCommand.allCases.map { surface.addTarget($0) { _ in .success } }
        defer {
            targets.forEach { $0.cancel() }
            MediaMapping.RemoteCommand.allCases.forEach { surface.setEnabled(false, for: $0) }
        }

        XCTAssertEqual(center.skipBackwardCommand.preferredIntervals, [NSNumber(value: MediaMapping.seekBackwardSec)])
        XCTAssertEqual(center.skipForwardCommand.preferredIntervals, [NSNumber(value: MediaMapping.seekForwardSec)])
        XCTAssertEqual(MediaMapping.seekBackwardSec, EngineConstants.MediaSession.seekBackwardSec)
        XCTAssertEqual(MediaMapping.seekForwardSec, EngineConstants.MediaSession.seekForwardSec)

        XCTAssertTrue(surface.mpCommand(.play) === center.playCommand)
        XCTAssertTrue(surface.mpCommand(.togglePlayPause) === center.togglePlayPauseCommand)
        XCTAssertTrue(surface.mpCommand(.changePlaybackPosition) === center.changePlaybackPositionCommand)
        XCTAssertTrue(surface.mpCommand(.stop) === center.stopCommand)

        surface.setEnabled(true, for: .stop)
        XCTAssertFalse(center.stopCommand.isEnabled, "a remote stop is a pause; the button is never offered")
        surface.setEnabled(true, for: .nextTrack)
        XCTAssertTrue(center.nextTrackCommand.isEnabled)
        surface.setEnabled(false, for: .nextTrack)
        XCTAssertFalse(center.nextTrackCommand.isEnabled)

        let first = targets.first as? RemoteTarget
        XCTAssertEqual(first?.isLive, true)
        first?.cancel()
        XCTAssertEqual(first?.isLive, false)
    }

    /// Plan §4.2: a press that arrives off main is marked (`onMain: false`,
    /// the core's `thread=bg`) and handled ON MAIN through
    /// `DispatchQueue.main.sync`, and the verdict is what the handler said;
    /// on main it is handled in place. The route is read for the press.
    /// TO SEE IT FAIL: call the handler on the thread the press arrived on,
    /// or hop with `async` and return `.success` as a receipt.
    func testAPressOffMainIsMarkedAndHandledOnMain() {
        final class Seen {
            var onMainThread: Bool?
            var press: RemotePress?
            var verdict: RemoteVerdict?
        }
        let seen = Seen()
        let done = expectation(description: "delivered")
        DispatchQueue.global(qos: .userInitiated).async {
            seen.verdict = RemoteSurface.deliver(.play, value: nil, routePort: { "carAudio" }) { press in
                seen.onMainThread = Thread.isMainThread
                seen.press = press
                return .noActionableNowPlayingItem
            }
            done.fulfill()
        }
        wait(for: [done], timeout: 5)
        XCTAssertEqual(seen.onMainThread, true)
        XCTAssertEqual(seen.press?.onMain, false)
        XCTAssertEqual(seen.press?.routePort, "carAudio")
        XCTAssertEqual(seen.verdict, .noActionableNowPlayingItem)

        let local = Seen()
        let verdict = RemoteSurface.deliver(.changePlaybackPosition, value: 42, routePort: { nil }) { press in
            local.onMainThread = Thread.isMainThread
            local.press = press
            return .success
        }
        XCTAssertEqual(verdict, .success)
        XCTAssertEqual(local.onMainThread, true)
        XCTAssertEqual(local.press?.onMain, true)
        XCTAssertEqual(local.press?.value, 42)
    }

    /// The OS's skip interval is not an input: a skip press carries no value,
    /// so the core steps by the founder's pair. Through the host: +30 from 100
    /// lands at 130, whatever interval a head unit would have sent.
    /// TO SEE IT FAIL: pass the event's `interval` as the press's value, or
    /// step by a literal in the core.
    @MainActor
    func testASkipStepsByTheFoundersPair() {
        let world = FakeWorld()
        let engine = Self.engine(in: .playing, world: world)
        world.deck.reading.positionSec = 100
        XCTAssertEqual(world.remote.press(.skipForward), .success)
        XCTAssertTrue(world.deck.sent.contains(.seek(toSec: 100 + MediaMapping.seekForwardSec)), "\(world.deck.sent)")
        world.deck.reading.positionSec = 100
        XCTAssertEqual(world.remote.press(.skipBackward), .success)
        XCTAssertTrue(world.deck.sent.contains(.seek(toSec: 100 - MediaMapping.seekBackwardSec)), "\(world.deck.sent)")
        withExtendedLifetime(engine) {}
    }
}
