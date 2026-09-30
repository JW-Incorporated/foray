import XCTest
import ForayEngineCore

/// Card NE-40, THE D-5 STOP-CAUSE AUDIT (docs/native-engine-plan.md §14 Track
/// M3): every path that stops the listener's audio writes a `stop` row with a
/// named cause BEFORE the command that silences anything, so a Copy pasted
/// after a drive says why the audio stopped, and `stop cause=unknown` never
/// appears.
///
/// WHERE A STOP COMES FROM. The host's adapters decide nothing: each one
/// reports what it saw as an input, and the core's `stopRow` is the one place
/// a cause is written. So the audit is a table of every input that can stop
/// audio, from every adapter the card names:
///
///   - AVDeck / DeckPair: `.ended` (the out-point or the file's end, the last
///     item), `.failed` (a load, or the held item mid-play), `.deadlineExceeded`
///     (P-13, including a seam's next clip that never loads: that IS the seam
///     timeout), `.pausedUncommanded` (the system stopped the deck);
///   - SpeechNarrator (the fallback voice): `.failed` for a line, `.finished`
///     for the last line, and the line's own deadline and suspension pulses;
///   - InterludePlayer and SilenceNode: stopped by a transport action's cut
///     (their own `interlude cut` / `silence stopped` rows, after the stop row)
///     or by the silence cap, which is not a stop (digital silence in a seam);
///   - AudioSessionOwner (the session observers): an interruption, a lost
///     route (the route policy), a media-services reset;
///   - BackgroundGrace: the expiration handler (`.timer(.graceExpired)`);
///   - the page and the car: pause, close, data deletion, relinquish, and the
///     engine going away (teardown).
///
/// Every `stopRow(` call site in EngineCore.swift is named by a `site:` below;
/// tools/mobile/shell-invariants.test.mjs reads both files and is red when a
/// call site has no row here, so a new stop path cannot land without its
/// audit entry.
///
/// TWO CAUSES ARE NEVER EMITTED, on purpose (`reserved`): `seam-timeout` (a
/// seam's next clip that never becomes ready is its load's P-13 deadline, and
/// says `load-deadline`, which carries the class and the token) and `unknown`
/// (the vocabulary's residue: a paste that shows one names a defect). The
/// switch in `disposition` has no `default`, so a cause the vocabulary gains
/// is a compile error here until it is audited.
final class StopCauseTests: XCTestCase {
    typealias Host = EngineCoreTests.Host

    static let tape = EngineConfig(build: "test", forayTapeEnabled: true)
    static let jingle = EngineConfig(build: "test", forayTapeEnabled: true, interludeAvailable: true)
    static let silence = EngineConfig(build: "test", forayTapeEnabled: true, silenceNodeEnabled: true)

    // MARK: - The inventory

    /// One path that stops audio: its name, the adapter or surface it starts
    /// at, the EngineCore function that writes its row (`site`), the cause the
    /// row must carry, and the turn that takes it (setup excluded).
    struct StopPath {
        let name: String
        let origin: String
        let site: String
        let cause: Vocabulary.StopCause
        let run: () throws -> [EngineCommand]
    }

    static let paths: [StopPath] = [
        // The page and the car.
        StopPath(name: "a listener's pause (the app)", origin: "page", site: "pause", cause: .pause) {
            var host = StopCauseTests.playingEpisode()
            return host.send(.command(.pause, source: .tap))
        },
        StopPath(name: "a listener's pause (the car, the lock screen)", origin: "RemoteSurface", site: "pause", cause: .pause) {
            var host = StopCauseTests.playingEpisode()
            return host.send(.remote(RemotePress(.pause)))
        },
        StopPath(name: "a pause while the seam's jingle sounds", origin: "page + InterludePlayer", site: "pause", cause: .pause) {
            var host = try StopCauseTests.inJingle()
            return host.send(.command(.pause, source: .tap), after: 0)
        },
        StopPath(name: "a pause while the silence node renders", origin: "page + SilenceNode", site: "pause", cause: .pause) {
            var host = try StopCauseTests.inSilence()
            return host.send(.command(.pause, source: .tap), after: 0)
        },
        StopPath(name: "a pause during a spoken line", origin: "page + SpeechNarrator", site: "pause", cause: .pause) {
            var (host, _) = try StopCauseTests.speakingLine()
            return host.send(.command(.pause, source: .tap), after: 0)
        },
        StopPath(name: "a close", origin: "page", site: "stop", cause: .close) {
            var host = StopCauseTests.playingEpisode()
            return host.send(.command(.stop(persist: true), source: .tap))
        },
        StopPath(name: "a close while the seam's jingle sounds", origin: "page + InterludePlayer", site: "stop", cause: .close) {
            var host = try StopCauseTests.inJingle()
            return host.send(.command(.stop(persist: true), source: .tap), after: 0)
        },
        StopPath(name: "Delete my data (stop without persisting)", origin: "page", site: "stop", cause: .dataDeletion) {
            var host = StopCauseTests.playingEpisode()
            return host.send(.command(.stop(persist: false), source: .tap))
        },
        StopPath(name: "Delete my data (purge)", origin: "page", site: "stop", cause: .dataDeletion) {
            var host = StopCauseTests.playingEpisode()
            return host.send(.command(.purge, source: .tap))
        },
        StopPath(name: "the one-way relinquish", origin: "page / EngineOwnership", site: "relinquish", cause: .relinquish) {
            var host = StopCauseTests.playingEpisode()
            return host.send(.command(.relinquish(cap: .all), source: .tap))
        },
        StopPath(name: "a relinquish while the seam's jingle sounds", origin: "page + InterludePlayer", site: "relinquish", cause: .relinquish) {
            var host = try StopCauseTests.inJingle()
            return host.send(.command(.relinquish(cap: .foray), source: .tap), after: 0)
        },
        StopPath(name: "the engine going away while it plays (dispose)", origin: "the page's dispose()", site: "teardown", cause: .relinquish) {
            var host = StopCauseTests.playingEpisode()
            return host.send(.lifecycle(.teardown))
        },

        // AVDeck and DeckPair.
        StopPath(name: "an episode ends and nothing follows", origin: "AVDeck .ended", site: "itemEnded", cause: .ended) {
            var host = StopCauseTests.playingEpisode()
            host.reading.audible = false
            host.reading.ended = true
            return host.send(.deck(.ended(token: host.lastLoad ?? 0)))
        },
        StopPath(name: "a Foray's last clip ends", origin: "AVDeck .ended", site: "itemEnded", cause: .finalEnd) {
            var host = try StopCauseTests.playingForay([ForayTapeTests.clip(0, "a", 100, 200)])
            host.reading.audible = false
            host.reading.ended = true
            return host.send(.deck(.ended(token: host.lastLoad ?? 0)), after: 0)
        },
        StopPath(name: "the load-time ladder refuses the last segment left", origin: "AVDeck .ready (ADR-0007)", site: "skipUnplayableSegment", cause: .finalEnd) {
            var host = Host(config: StopCauseTests.tape)
            host.reading.durationSec = 3600
            host.send(try EngineCoreTests.command("playForay", ForayTapeTests.forayArgs([StopCauseTests.approximate(0), StopCauseTests.approximate(1)])))
            host.land()
            return host.land()
        },
        StopPath(name: "the first load fails", origin: "AVDeck .failed", site: "onLoadFailure", cause: .error) {
            var host = Host()
            host.send(.queue(.load([EngineCoreTests.item("a")])))
            host.send(.queue(.playIndex(0, startSec: nil, source: .tap)))
            return host.send(.deck(.failed(token: host.lastLoad ?? 0, message: "decode")))
        },
        StopPath(name: "the playing item fails mid-play", origin: "AVDeck .failed", site: "onLoadFailure", cause: .error) {
            var host = StopCauseTests.playingEpisode()
            return host.send(.deck(.failed(token: host.lastLoad ?? 0, message: "decode")))
        },
        StopPath(name: "a load passes its P-13 deadline", origin: "AVDeck .deadlineExceeded", site: "onLoadFailure", cause: .loadDeadline) {
            var host = Host()
            host.send(.queue(.load([EngineCoreTests.item("a")])))
            host.send(.queue(.playIndex(0, startSec: nil, source: .tap)))
            return host.send(.deck(.deadlineExceeded(token: host.lastLoad ?? 0, afterMs: 20000)))
        },
        StopPath(name: "a seam's next clip never becomes ready (the seam timeout)", origin: "DeckPair .deadlineExceeded", site: "onLoadFailure", cause: .loadDeadline) {
            var host = StopCauseTests.inSeam(config: StopCauseTests.tape)
            return host.send(.deck(.deadlineExceeded(token: host.lastLoad ?? 0, afterMs: 20000)))
        },
        StopPath(name: "the system stops the deck (uncommanded pause)", origin: "AVDeck .pausedUncommanded", site: "reconcile", cause: .systemPause) {
            var host = StopCauseTests.playingEpisode()
            host.reading.audible = false
            return host.send(.deck(.pausedUncommanded(token: host.lastLoad ?? 0, atSec: 12)))
        },
        StopPath(name: "the app comes forward to a silent deck", origin: "lifecycle + AVDeck reading", site: "reconcile", cause: .systemPause) {
            var host = StopCauseTests.playingEpisode()
            host.reading.audible = false
            return host.send(.lifecycle(.foreground))
        },

        // SpeechNarrator, the fallback voice.
        StopPath(name: "the synthesiser refuses a line", origin: "SpeechNarrator .failed", site: "onLoadFailure", cause: .error) {
            var host = Host(config: StopCauseTests.tape)
            host.send(.queue(.loadForay([NarrationOverlayTests.line(0, "a line", durationSec: 4),
                                         NarrationOverlayTests.clip(1, "a", 100, 200)], isLocalFile: false, allowAdPad: false)))
            let out = host.send(.queue(.playIndex(0, startSec: nil, source: .tap)))
            let seq = try XCTUnwrap(NarrationOverlayTests.spokenSeq(out), "nothing was spoken: \(out)")
            return host.send(.narrator(.failed(seq: seq, reason: "refused")), after: 0)
        },
        StopPath(name: "a Foray's last spoken line finishes", origin: "SpeechNarrator .finished", site: "itemEnded", cause: .finalEnd) {
            var (host, seq) = try StopCauseTests.speakingForay()
            return host.send(.narrator(.finished(seq: seq)), after: 0)
        },
        StopPath(name: "a Foray's last spoken line runs past its deadline", origin: "the line deadline (narration pulse)", site: "itemEnded", cause: .finalEnd) {
            var (host, _) = try StopCauseTests.speakingForay()
            for _ in 0..<400 {
                let out = host.send(.timer(.narrationTick), after: EngineConstants.QueueManager.narrationTickMs)
                if StopCauseTests.stopRowIndex(out) != nil { return out }
            }
            return []
        },
        StopPath(name: "a spoken line's pulse finds the process was suspended", origin: "the narration pulse + SpeechNarrator", site: "reconcileNarrationInterrupted", cause: .systemPause) {
            var (host, _) = try StopCauseTests.speakingLine()
            return host.send(.timer(.narrationTick), after: 60_000)
        },

        // AudioSessionOwner: the session observers and the route policy.
        StopPath(name: "an interruption (a call, Siri, another app)", origin: "AudioSessionOwner interruption", site: "onInterruptionBegan", cause: .interruption) {
            var host = StopCauseTests.playingEpisode()
            return host.send(.session(.interruptionBegan(reason: "default")))
        },
        StopPath(name: "an interruption while the seam's jingle sounds", origin: "AudioSessionOwner + InterludePlayer", site: "onInterruptionBegan", cause: .interruption) {
            var host = try StopCauseTests.inJingle()
            return host.send(.session(.interruptionBegan(reason: "default")), after: 0)
        },
        StopPath(name: "an interruption during a spoken line", origin: "AudioSessionOwner + SpeechNarrator", site: "onInterruptionBegan", cause: .interruption) {
            var (host, _) = try StopCauseTests.speakingLine()
            return host.send(.session(.interruptionBegan(reason: "default")), after: 0)
        },
        StopPath(name: "the output route goes away (the car, headphones)", origin: "AudioSessionOwner route (route policy)", site: "onRoute", cause: .routeChange) {
            var host = StopCauseTests.playingEpisode()
            return host.send(.session(.route(RouteChange(oldDeviceUnavailable: true, portType: "carAudio"))))
        },
        StopPath(name: "the route goes away while the seam's jingle sounds", origin: "AudioSessionOwner + InterludePlayer", site: "onRoute", cause: .routeChange) {
            var host = try StopCauseTests.inJingle()
            return host.send(.session(.route(RouteChange(oldDeviceUnavailable: true, portType: "bluetoothA2DP"))), after: 0)
        },
        StopPath(name: "media services are reset", origin: "AudioSessionOwner mediaServicesReset", site: "onMediaServicesReset", cause: .mediaServicesReset) {
            var host = StopCauseTests.playingEpisode()
            return host.send(.session(.mediaServicesReset))
        },

        // BackgroundGrace.
        StopPath(name: "grace expires before the audio started", origin: "BackgroundGrace expiration", site: "onTimer", cause: .graceExpired) {
            var host = StopCauseTests.playingEpisode()
            host.send(.command(.pause, source: .tap))
            host.send(.remote(RemotePress(.play)))
            return host.send(.timer(.graceExpired))
        },
    ]

    /// Every cause, and whether a path emits it. No `default`: a cause the
    /// vocabulary gains does not compile here until it is audited.
    enum Disposition: Equatable {
        case emitted
        case reserved(why: String)
    }

    static func disposition(_ cause: Vocabulary.StopCause) -> Disposition {
        switch cause {
        case .pause, .ended, .finalEnd, .systemPause, .routeChange, .interruption, .graceExpired,
             .loadDeadline, .error, .relinquish, .dataDeletion, .close, .mediaServicesReset:
            return .emitted
        case .seamTimeout:
            return .reserved(why: "a seam's next clip that never becomes ready is its load's P-13 deadline: load-deadline")
        case .unknown:
            return .reserved(why: "the residue: a paste that shows one names a defect, never a path")
        }
    }

    // MARK: - What the table is checked for

    /// THE ACCEPTANCE: every stop path writes its cause row, with the cause
    /// named, admitted by the ring's gate, before the first command that
    /// silences anything in that turn (a deck pause or unload, the narration's
    /// stop or pause, the jingle's stop, the silence node's stop, the
    /// session's release).
    /// TO SEE IT FAIL: move `stopRow(.pause, source: source)` below
    /// `cutSeamGap("pause")` in `pause()` (the jingle and silence rows go red);
    /// delete the `stopRow(.relinquish)` in `teardown()`; delete any
    /// `stopRow(` call.
    func testEveryStopPathWritesItsCauseBeforeTheStop() throws {
        for path in StopCauseTests.paths {
            let out = try path.run()
            guard let at = StopCauseTests.stopRowIndex(out), case let .diag(entry) = out[at] else {
                XCTFail("\(path.name) (\(path.origin)): no stop row in \(out)")
                continue
            }
            XCTAssertEqual(entry[field: "cause"], .string(path.cause.rawValue), "\(path.name): \(entry)")
            XCTAssertEqual(DiagGate.admit(entry)?[field: "cause"], .string(path.cause.rawValue),
                           "\(path.name): the ring's gate keeps the cause")
            XCTAssertNotEqual(entry[field: "cause"], .string(Vocabulary.StopCause.unknown.rawValue), path.name)
            if let silencing = out.firstIndex(where: StopCauseTests.silences) {
                XCTAssertLessThan(at, silencing, "\(path.name): the cause row comes before the stop: \(out)")
            }
            XCTAssertEqual(out.filter(StopCauseTests.isStopRow).count, 1, "\(path.name): one stop, one row: \(out)")
        }
    }

    /// Each silencing path is a real stop: the turn silences something, or
    /// leaves the transport stopped, so no row in the table is vacuous.
    /// TO SEE IT FAIL: make a path's turn a no-op (e.g. send the pause to an
    /// idle host).
    func testEveryPathReallyStopsSomething() throws {
        for path in StopCauseTests.paths {
            let out = try path.run()
            let silenced = out.contains(where: StopCauseTests.silences)
            let refused = out.contains { if case .commandFailed = $0 { return true }; return false }
            XCTAssertFalse(refused, "\(path.name): the turn was refused, so nothing stopped: \(out)")
            XCTAssertTrue(silenced || StopCauseTests.stopRowIndex(out) != nil, "\(path.name): \(out)")
        }
    }

    /// Every cause in the closed vocabulary is either emitted by at least one
    /// path above or reserved with a reason, and a reserved one is emitted by
    /// none.
    /// TO SEE IT FAIL: drop the `.graceExpired` path from the table; mark
    /// `.seamTimeout` emitted.
    func testEveryStopCauseIsEmittedByAPathOrReservedWithAReason() {
        let emitted = Set(StopCauseTests.paths.map(\.cause))
        for cause in Vocabulary.StopCause.allCases {
            switch StopCauseTests.disposition(cause) {
            case .emitted:
                XCTAssertTrue(emitted.contains(cause), "\(cause.rawValue) is emitted but no path in the table shows it")
            case let .reserved(why):
                XCTAssertFalse(emitted.contains(cause), "\(cause.rawValue) is reserved but a path emits it")
                XCTAssertFalse(why.isEmpty, cause.rawValue)
            }
        }
    }

    /// The table's `site` names are EngineCore functions the shell-invariants
    /// scan can find, one per `stopRow(` call site, and none is blank.
    func testEveryPathNamesItsSite() {
        let sites = Set(StopCauseTests.paths.map(\.site))
        XCTAssertEqual(sites, ["pause", "stop", "relinquish", "teardown", "itemEnded", "skipUnplayableSegment",
                               "onLoadFailure", "reconcile", "reconcileNarrationInterrupted", "onInterruptionBegan",
                               "onRoute", "onMediaServicesReset", "onTimer"])
    }

    // MARK: - Silences that are not stops, each with its own row first

    /// A clip's end in the middle of a Foray is a seam, not a stop: no `stop`
    /// row (the next load goes out in the same turn).
    /// TO SEE IT FAIL: write a stop row on every `.ended`.
    func testAMidForaySeamIsNotAStop() {
        let host = StopCauseTests.inSeam(config: StopCauseTests.tape)
        XCTAssertEqual(host.core.state.stateType, "loadingItem")
        let seam = StopCauseTests.seamTurn(StopCauseTests.tape)
        XCTAssertNil(StopCauseTests.stopRowIndex(seam), "\(seam)")
        XCTAssertFalse(ForayTapeTests.loads(seam).isEmpty, "the next clip loads: \(seam)")
    }

    /// The silence cap ends digital silence inside a seam: not the listener's
    /// audio, so not a `stop`, but its `silence capped` row comes first.
    /// TO SEE IT FAIL: append `.silenceStop` before the row in `onTimer`.
    func testTheSilenceCapIsNamedBeforeItStopsTheSilence() throws {
        var host = try StopCauseTests.inSilence()
        let out = host.send(.timer(.silenceCap), after: Interlude.ceilingSec * 1000)
        guard let row = StopCauseTests.rowIndex(out, kind: "silence", event: "capped"),
              let stop = out.firstIndex(of: .silenceStop) else { return XCTFail("\(out)") }
        XCTAssertLessThan(row, stop)
        XCTAssertNil(StopCauseTests.stopRowIndex(out), "\(out)")
    }

    /// A transport cut silences the jingle after its own `interlude cut` row,
    /// and both after the `stop` row.
    /// TO SEE IT FAIL: append `.interlude(.stop)` before the row in `stopInterlude`.
    func testTheJinglesCutIsNamedAfterTheStopAndBeforeTheSilence() throws {
        var host = try StopCauseTests.inJingle()
        let out = host.send(.command(.pause, source: .tap), after: 0)
        guard let stopRow = StopCauseTests.stopRowIndex(out),
              let cut = StopCauseTests.rowIndex(out, kind: "interlude", event: "cut"),
              let silenced = out.firstIndex(of: .interlude(.stop)) else { return XCTFail("\(out)") }
        XCTAssertLessThan(stopRow, cut)
        XCTAssertLessThan(cut, silenced)
    }

    /// A pause on nothing is not a stop: no row, as the rule in `stopRow` says.
    func testAPauseOnAnIdleEngineWritesNoStopRow() {
        var host = Host()
        XCTAssertNil(StopCauseTests.stopRowIndex(host.send(.command(.pause, source: .tap))))
    }

    // MARK: - Hosts

    /// An episode playing, confirmed audible by the deck.
    static func playingEpisode() -> Host {
        var host = Host()
        host.send(.queue(.load([EngineCoreTests.item("a")])))
        host.send(.queue(.playIndex(0, startSec: nil, source: .tap)))
        host.land()
        host.confirm()
        return host
    }

    /// A Foray (a real `playForay`, so it has an id) playing its first clip.
    static func playingForay(_ items: [JSONNode]) throws -> Host {
        var host = Host(config: tape)
        host.send(try EngineCoreTests.command("playForay", ForayTapeTests.forayArgs(items)))
        host.land()
        host.confirm()
        XCTAssertEqual(host.core.state.stateType, "playing")
        XCTAssertNotNil(host.core.state.forayId)
        return host
    }

    /// A Foray whose only item is a spoken line, the synthesiser speaking it.
    static func speakingForay() throws -> (Host, Int) {
        var host = Host(config: tape)
        let out = host.send(try EngineCoreTests.command("playForay", ForayTapeTests.forayArgs([
            NarrationOverlayTests.line(0, "the only line", durationSec: 4).node])))
        let seq = try XCTUnwrap(NarrationOverlayTests.spokenSeq(out), "nothing was spoken: \(out)")
        host.send(.narrator(.started(seq: seq, voiceFallback: false)), after: 0)
        XCTAssertEqual(host.core.state.narration?.seq, seq)
        XCTAssertNotNil(host.core.state.forayId)
        return (host, seq)
    }

    /// A line spoken ahead of a clip (the manager's queue), the synthesiser
    /// speaking it.
    static func speakingLine() throws -> (Host, Int) {
        var host = Host(config: tape)
        host.send(.queue(.loadForay([NarrationOverlayTests.line(0, "a line", durationSec: 4),
                                     NarrationOverlayTests.clip(1, "a", 100, 200)], isLocalFile: false, allowAdPad: false)))
        let out = host.send(.queue(.playIndex(0, startSec: nil, source: .tap)))
        let seq = try XCTUnwrap(NarrationOverlayTests.spokenSeq(out), "nothing was spoken: \(out)")
        host.send(.narrator(.started(seq: seq, voiceFallback: false)), after: 0)
        XCTAssertEqual(host.core.state.stateType, "playing")
        return (host, seq)
    }

    /// Two clips of two shows, the first playing, under `config`.
    static func twoClips(_ config: EngineConfig) -> Host {
        var host = Host(config: config)
        host.send(.queue(.loadForay([NarrationOverlayTests.clip(0, "a", 100, 200), NarrationOverlayTests.clip(1, "b", 300, 400)],
                                    isLocalFile: false, allowAdPad: false)))
        host.send(.queue(.playIndex(0, startSec: nil, source: .tap)))
        host.land()
        host.confirm()
        return host
    }

    /// The first clip's end: the seam's turn.
    static func seamTurn(_ config: EngineConfig) -> [EngineCommand] {
        var host = twoClips(config)
        host.reading.audible = false
        host.reading.ended = true
        return host.send(.deck(.ended(token: host.lastLoad ?? 0)), after: 0)
    }

    /// In the seam after the first clip, the next clip's load in flight.
    static func inSeam(config: EngineConfig) -> Host {
        var host = twoClips(config)
        host.reading.audible = false
        host.reading.ended = true
        host.send(.deck(.ended(token: host.lastLoad ?? 0)), after: 0)
        return host
    }

    /// In the seam with the jingle sounding (a jingle player is available).
    static func inJingle() throws -> Host {
        var host = twoClips(jingle)
        host.reading.audible = false
        host.reading.ended = true
        let out = host.send(.deck(.ended(token: host.lastLoad ?? 0)), after: 0)
        XCTAssertTrue(out.contains(.interlude(.start)), "the harness's seam has no jingle: \(out)")
        XCTAssertTrue(host.core.state.inInterlude)
        XCTAssertTrue(host.core.state.isRunning)
        return host
    }

    /// In a silent seam with the silence node rendering (flagged on).
    static func inSilence() throws -> Host {
        var host = twoClips(silence)
        host.reading.audible = false
        host.reading.ended = true
        let out = host.send(.deck(.ended(token: host.lastLoad ?? 0)), after: 0)
        XCTAssertTrue(out.contains { if case .silenceStart = $0 { return true }; return false },
                      "the harness's seam renders no silence: \(out)")
        XCTAssertTrue(host.core.state.silenceActive)
        XCTAssertTrue(host.core.state.isRunning)
        return host
    }

    /// An approximate copy (ADR-0007): the load-time ladder refuses it.
    static func approximate(_ index: Int) -> JSONNode {
        ForayTapeTests.clip(index, "dai\(index)", 100, 200, [
            JSONMember("dai_suspected", .bool(true)), JSONMember("needs_drift_check", .bool(true)),
            JSONMember("reference_duration_sec", .number(2501)),
            JSONMember("start_anchor", .string("so the thing")), JSONMember("end_anchor", .string("and that is why"))])
    }

    // MARK: - Readings

    static func isStopRow(_ command: EngineCommand) -> Bool {
        if case let .diag(entry) = command { return entry.kind == "stop" }
        return false
    }

    static func stopRowIndex(_ out: [EngineCommand]) -> Int? {
        out.firstIndex(where: isStopRow)
    }

    static func rowIndex(_ out: [EngineCommand], kind: String, event: String) -> Int? {
        out.firstIndex {
            if case let .diag(entry) = $0 { return entry.kind == kind && entry[field: "kind"] == .string(event) }
            return false
        }
    }

    /// A command that silences something or releases the session.
    static func silences(_ command: EngineCommand) -> Bool {
        switch command {
        case .deck(.pause), .deck(.unload), .preview(.unload), .sessionDeactivate, .sessionReapplyCategory,
             .silenceStop, .interlude(.stop), .interlude(.release),
             .narration(.stop), .narration(.pause), .narration(.discard):
            return true
        default:
            return false
        }
    }
}
