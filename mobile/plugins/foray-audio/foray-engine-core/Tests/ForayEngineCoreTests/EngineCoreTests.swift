import XCTest
import ForayEngineCore
import ForayEngineParity

/// Card NE-14s: what the manager-episode fixtures cannot see, because it is
/// native-only (the audio session as request and response, grace spans,
/// cause rows, the restore record, continuation walking) or because it is the
/// proof that the scenario driver's checks would notice a broken core.
///
/// Each test drives `EngineCore` the way the host will (NE-15h): an input and
/// the deck's reading in, commands out, the activation answered in the same
/// turn. `Host` is that host, over a fake deck that goes silent on a load,
/// audible on a play and silent on a pause.
final class EngineCoreTests: XCTestCase {
    struct Host {
        var core: EngineCore
        var reading = DeckReading(positionSec: 0, durationSec: 3600, audible: false, ended: false)
        var monoMs: Double = 0
        var activationOK = true
        var lastLoad: DeckToken?
        /// What the host read from `backgroundTimeRemaining` (nil: foreground).
        var bgRemainingMs: Double?

        init(config: EngineConfig = EngineConfig(build: "test"),
             positions: [String: ResumeRules.StoredPosition] = [:]) {
            core = EngineCore(config: config, positions: positions)
        }

        /// One turn: the input, then the activation's answer if it asked.
        @discardableResult
        mutating func send(_ input: EngineInput, after ms: Double = 1000) -> [EngineCommand] {
            monoMs += ms
            let now = EngineNow(wallMs: 1_790_000_000_000, monoMs: monoMs, deck: reading, bgRemainingMs: bgRemainingMs)
            var all = core.handle(input, now: now)
            if let id = all.compactMap(Host.activation).last {
                all += core.handle(.sessionResult(SessionResult(requestId: id, ok: activationOK,
                                                                error: activationOK ? nil : "cannot-interrupt-others",
                                                                activateMs: 3)),
                                   now: EngineNow(wallMs: 1_790_000_000_000, monoMs: monoMs, deck: reading,
                                                  bgRemainingMs: bgRemainingMs))
            }
            for command in all {
                switch command {
                case let .deck(.load(token, _, _, startSec, _)):
                    lastLoad = token
                    reading.positionSec = startSec
                    reading.audible = false
                    reading.ended = false
                case .deck(.play): reading.audible = true
                case .deck(.pause): reading.audible = false
                case let .deck(.seek(toSec)): reading.positionSec = toSec
                default: break
                }
            }
            return all
        }

        static func activation(_ command: EngineCommand) -> Int? {
            if case let .sessionActivate(id) = command { return id }
            return nil
        }

        /// The current load becomes ready.
        @discardableResult
        mutating func land(_ token: DeckToken? = nil) -> [EngineCommand] {
            send(.deck(.ready(token: token ?? lastLoad ?? 0, landedSec: reading.positionSec ?? 0, prerolled: true, elapsedMs: 5)))
        }

        /// The deck confirms `.playing`.
        @discardableResult
        mutating func confirm() -> [EngineCommand] {
            send(.deck(.timeControl(token: lastLoad ?? 0, status: .playing, waitingReason: nil)))
        }
    }

    static func item(_ id: String, _ extra: [JSONMember] = []) -> EngineItem {
        EngineItem(node: .object([JSONMember("id", .string(id)), JSONMember("kind", .string("episode")),
                                  JSONMember("audio_url", .string("https://cdn.example/\(id).mp3"))] + extra))!
    }

    /// A host playing `ids[0]` (queued with the rest), confirmed audible.
    func playing(_ ids: [String] = ["a"], config: EngineConfig = EngineConfig(build: "test")) -> Host {
        var host = Host(config: config)
        host.send(.queue(.load(ids.map { EngineCoreTests.item($0) })))
        host.send(.queue(.playIndex(0, startSec: nil, source: .tap)))
        host.land()
        host.confirm()
        XCTAssertEqual(host.core.state.stateType, "playing")
        return host
    }

    /// A page command, decoded through the contract exactly as the bridge will.
    static func command(_ cmd: String, _ args: JSONNode? = nil, source: String = "tap") throws -> EngineInput {
        var members = [JSONMember("v", .number(1)), JSONMember("cmdSeq", .number(1)), JSONMember("cmd", .string(cmd)),
                       JSONMember("source", .string(source))]
        if let args { members.append(JSONMember("args", args)) }
        let request = try EngineContract.SendRequest(contract: .object(members))
        return .command(request.command, source: request.source)
    }

    func index(_ commands: [EngineCommand], _ match: (EngineCommand) -> Bool) -> Int? {
        commands.firstIndex(where: match)
    }

    func isPlay(_ command: EngineCommand) -> Bool { command == .deck(.play) }
    func isLoad(_ command: EngineCommand) -> Bool {
        if case .deck(.load) = command { return true }
        return false
    }

    // MARK: - The audible-start invariant, as request and response

    /// A failed activation is `.commandFailed(session-failed:<token>)` and
    /// NOTHING audible or even loading: the play never happened.
    func testAFailedActivationFailsTheCommandAndStartsNothing() {
        var host = Host()
        host.activationOK = false
        host.send(.queue(.load([EngineCoreTests.item("a")])))
        let out = host.send(.queue(.playIndex(0, startSec: nil, source: .tap)))
        XCTAssertTrue(out.contains(.commandFailed(reason: "session-failed:cannot-interrupt-others")), "\(out)")
        XCTAssertNil(index(out, isLoad), "nothing loads without the session")
        XCTAssertNil(index(out, isPlay))
        XCTAssertEqual(host.core.state.session, .inactive)
        XCTAssertEqual(host.core.state.stateType, "idle")
    }

    /// The activation is asked for, answered, and only then does the load go
    /// out; the play waits for the deck's `.ready`.
    func testTheActivationPrecedesTheLoadAndThePlayWaitsForReady() {
        var host = Host()
        host.send(.queue(.load([EngineCoreTests.item("a")])))
        let first = host.core.handle(.queue(.playIndex(0, startSec: nil, source: .tap)),
                                     now: EngineNow(wallMs: 0, monoMs: 1, deck: host.reading))
        XCTAssertEqual(first.compactMap(Host.activation), [1], "the core stops at sessionActivate")
        XCTAssertNil(index(first, isLoad), "no load before the answer")
        let answered = host.core.handle(.sessionResult(SessionResult(requestId: 1, ok: true)),
                                        now: EngineNow(wallMs: 0, monoMs: 1, deck: host.reading))
        XCTAssertNotNil(index(answered, isLoad))
        XCTAssertNil(index(answered, isPlay), "a play before the deck is ready is the uncatchable preroll crash's cousin")
        host.lastLoad = 1
        let ready = host.land()
        XCTAssertEqual(ready.filter { if case .deck = $0 { return true }; return false }, [.deck(.setRate(1)), .deck(.play)],
                       "rate on every play, then play")
    }

    /// Nothing is ever audible while the session is lost to an interruption:
    /// the load that was in flight when the call came lands silently.
    func testALoadLandingDuringAnInterruptionStaysSilent() {
        var host = Host()
        host.send(.queue(.load([EngineCoreTests.item("a")])))
        host.send(.queue(.playIndex(0, startSec: nil, source: .tap)))
        host.send(.session(.interruptionBegan(reason: "default")))
        XCTAssertEqual(host.core.state.session, .lostToInterruption)
        let landed = host.land()
        XCTAssertNil(index(landed, isPlay), "\(landed)")
        XCTAssertEqual(host.core.state.stateType, "interrupted")
    }

    /// Two loads in flight: only the one that owns the deck plays (#19).
    func testASupersededLoadNeverPlays() {
        var host = Host()
        host.send(.queue(.load([EngineCoreTests.item("a"), EngineCoreTests.item("b")])))
        host.send(.queue(.playIndex(0, startSec: nil, source: .tap)))
        let first = host.lastLoad
        host.send(.queue(.playIndex(1, startSec: nil, source: .tap)))
        XCTAssertNotEqual(first, host.lastLoad)
        XCTAssertNil(index(host.land(first), isPlay), "a's late landing plays nothing")
        XCTAssertNil(host.core.state.loadedId, "and claims nothing")
        XCTAssertNotNil(index(host.land(), isPlay))
        XCTAssertEqual(host.core.state.loadedId, "b")
    }

    /// The terminal state: after a relinquish, every input is `[]`, and the
    /// relinquish itself never deactivates or notifies.
    func testARelinquishedCoreAnswersNothingEver() throws {
        var host = playing()
        let out = host.send(try EngineCoreTests.command("relinquish", .object([JSONMember("cap", .string("foray"))])))
        XCTAssertFalse(out.contains { if case .sessionDeactivate = $0 { return true }; return false }, "no deactivate, no notify")
        XCTAssertTrue(out.contains { if case let .writeRestore(record?) = $0 { return record.mode == .relinquished }; return false })
        XCTAssertNotNil(index(out, { $0 == .deck(.pause) }))
        XCTAssertEqual(host.core.state.session, .relinquished)
        for input: EngineInput in [.session(.interruptionEnded(shouldResume: true)),
                                   .session(.route(RouteChange(oldDeviceUnavailable: false))),
                                   .session(.mediaServicesReset), .remote(RemotePress(.play)),
                                   .deck(.ready(token: 1, landedSec: 0, prerolled: true, elapsedMs: 0)),
                                   .timer(.positionTick), .lifecycle(.foreground)] {
            XCTAssertEqual(host.send(input), [], "\(input)")
        }
    }

    // MARK: - Every stop path writes its cause first

    /// The `stop` diagnostics row with `cause`, and where it sits.
    func stopRow(_ cause: Vocabulary.StopCause, in commands: [EngineCommand]) -> Int? {
        commands.firstIndex {
            if case let .diag(entry) = $0 { return entry.kind == "stop" && entry[field: "cause"] == .string(cause.rawValue) }
            return false
        }
    }

    /// The first command that silences anything or releases the session.
    func firstSilencing(_ commands: [EngineCommand]) -> Int? {
        commands.firstIndex {
            switch $0 {
            case .deck(.pause), .deck(.unload), .sessionDeactivate, .sessionReapplyCategory: return true
            default: return false
            }
        }
    }

    func assertCauseFirst(_ cause: Vocabulary.StopCause, _ commands: [EngineCommand],
                          file: StaticString = #filePath, line: UInt = #line) {
        guard let row = stopRow(cause, in: commands) else {
            return XCTFail("no stop row cause=\(cause.rawValue) in \(commands)", file: file, line: line)
        }
        if let silencing = firstSilencing(commands) {
            XCTAssertLessThan(row, silencing, "the cause row must come before the stop", file: file, line: line)
        }
    }

    func testStopCausePause() throws {
        var host = playing()
        assertCauseFirst(.pause, host.send(try EngineCoreTests.command("pause")))
    }

    func testStopCauseInterruption() {
        var host = playing()
        assertCauseFirst(.interruption, host.send(.session(.interruptionBegan(reason: "default"))))
    }

    func testStopCauseRouteChange() {
        var host = playing()
        assertCauseFirst(.routeChange, host.send(.session(.route(RouteChange(oldDeviceUnavailable: true, portType: "carAudio")))))
    }

    func testStopCauseSystemPause() {
        var host = playing()
        host.reading.audible = false
        assertCauseFirst(.systemPause, host.send(.deck(.pausedUncommanded(token: host.lastLoad!, atSec: 12))))
    }

    func testStopCauseError() {
        var host = playing()
        let out = host.send(.deck(.failed(token: host.lastLoad!, message: "decode")))
        assertCauseFirst(.error, out)
        XCTAssertTrue(out.contains(.emit(.error(code: "load", message: "decode"))))
    }

    func testStopCauseLoadDeadline() {
        var host = Host()
        host.send(.queue(.load([EngineCoreTests.item("a")])))
        host.send(.queue(.playIndex(0, startSec: nil, source: .tap)))
        let out = host.send(.deck(.deadlineExceeded(token: host.lastLoad!, afterMs: 20000)))
        assertCauseFirst(.loadDeadline, out)
        XCTAssertEqual(host.core.state.stateType, "idle")
    }

    func testStopCauseEnded() {
        var host = playing()
        let out = host.send(.deck(.ended(token: host.lastLoad!)))
        assertCauseFirst(.ended, out)
        XCTAssertTrue(out.contains(.sessionDeactivate(notifyOthers: true)), "an episode that simply ends releases the session with notify")
    }

    func testStopCauseClose() throws {
        var host = playing()
        let out = host.send(try EngineCoreTests.command("stop", .object([JSONMember("persist", .bool(true))])))
        assertCauseFirst(.close, out)
        XCTAssertTrue(out.contains(.sessionDeactivate(notifyOthers: true)))
    }

    func testStopCauseDataDeletionWritesNoPosition() throws {
        var host = playing()
        let out = host.send(try EngineCoreTests.command("stop", .object([JSONMember("persist", .bool(false))])))
        assertCauseFirst(.dataDeletion, out)
        XCTAssertFalse(out.contains { if case .writePosition = $0 { return true }; return false }, "a deletion writes nothing back")
        XCTAssertTrue(out.contains(.writeRestore(nil)))
    }

    func testStopCauseRelinquish() throws {
        var host = playing()
        assertCauseFirst(.relinquish, host.send(try EngineCoreTests.command("relinquish", .object([JSONMember("cap", .string("all"))]))))
    }

    func testStopCauseMediaServicesReset() {
        var host = playing()
        let out = host.send(.session(.mediaServicesReset))
        assertCauseFirst(.mediaServicesReset, out)
        XCTAssertEqual(host.core.state.player, .interrupted(item: EngineCoreTests.item("a").ref, wasPlaying: false))
        XCTAssertNil(host.core.state.loadedId, "the deck holds nothing after a reset")
        XCTAssertNil(index(host.send(.session(.interruptionEnded(shouldResume: true))), isLoad), "not resumable")
    }

    func testStopCauseGraceExpired() {
        var host = playing()
        host.send(.command(.pause, source: .tap))
        host.send(.remote(RemotePress(.play)))
        XCTAssertEqual(host.core.state.grace, .remotePlay)
        let out = host.send(.timer(.graceExpired))
        XCTAssertNotNil(stopRow(.graceExpired, in: out), "\(out)")
        XCTAssertTrue(out.contains(.graceEnd(.expired)))
        XCTAssertNil(index(host.land(), isPlay), "a load landing after the grace expired plays nothing")
    }

    /// A stop of nothing is not a stop: no row when nothing ran.
    func testNoCauseRowWhenNothingWasRunning() {
        var host = Host()
        let out = host.send(.session(.interruptionBegan(reason: "appWasSuspended")))
        XCTAssertNil(out.firstIndex { if case let .diag(entry) = $0 { return entry.kind == "stop" }; return false })
    }

    // MARK: - BackgroundGrace

    func testARemotePlayHoldsGraceUntilTheDeckConfirmsPlaying() {
        var host = playing()
        host.send(.command(.pause, source: .tap))
        let press = host.send(.remote(RemotePress(.play)))
        guard let begin = index(press, { $0 == .graceBegin(.remotePlay) }), let load = index(press, isLoad) else {
            return XCTFail("\(press)")
        }
        XCTAssertLessThan(begin, load, "the span is silent from the press, before the load")
        XCTAssertFalse(host.land().contains(.graceEnd(.playing)), "a play command is not audio")
        XCTAssertTrue(host.confirm().contains(.graceEnd(.playing)))
        XCTAssertNil(host.core.state.grace)
    }

    func testGraceEndsWhenTheIntentDoes() throws {
        var host = playing()
        host.send(.command(.pause, source: .tap))
        host.send(.remote(RemotePress(.play)))
        XCTAssertTrue(host.send(try EngineCoreTests.command("pause")).contains(.graceEnd(.notRunning)))
    }

    func testATapOpensGraceOnlyInTheBackground() {
        var host = playing()
        host.send(.command(.pause, source: .tap))
        XCTAssertFalse(host.send(.command(.play, source: .tap)).contains(.graceBegin(.backgroundTap)))
        host.land()
        host.confirm()
        host.send(.command(.pause, source: .tap))
        host.send(.lifecycle(.background))
        XCTAssertTrue(host.send(.command(.play, source: .tap)).contains(.graceBegin(.backgroundTap)))
    }

    func testResumesAndColdPlaysOpenGrace() {
        var host = playing()
        host.send(.session(.interruptionBegan(reason: "default")))
        XCTAssertTrue(host.send(.session(.interruptionEnded(shouldResume: true))).contains(.graceBegin(.interruptionResume)))

        var car = playing()
        car.send(.session(.route(RouteChange(oldDeviceUnavailable: true, routeName: "Civic", isCarRoute: true))))
        XCTAssertTrue(car.send(.session(.route(RouteChange(oldDeviceUnavailable: false, routeName: "Civic"))))
            .contains(.graceBegin(.routeResume)))

        var cold = Host()
        XCTAssertTrue(cold.send(.lifecycle(.coldLaunch(queue: [EngineCoreTests.item("a")], index: 0, autoplay: true)))
            .contains(.graceBegin(.coldPlay)))
    }

    // MARK: - grace= in the remote, resume and cold-play rows (NE-16g)

    /// The diag rows of one kind in a turn, in order.
    func rows(_ kind: String, in commands: [EngineCommand]) -> [DiagEntry] {
        commands.compactMap { if case let .diag(entry) = $0, entry.kind == kind { return entry }; return nil }
    }

    /// The H-1 verdict reads the `remote` row: a car's play in the background
    /// must say `grace=y` with the budget the host read, although the span
    /// opens only while the press is handled; the row still leads the turn
    /// (D-4). A pause opens nothing and says `grace=n`.
    /// TO SEE IT FAIL: drop the `defer` in `onRemote` that fills the grace
    /// fields after the press (the play then reads `grace=n`), or write the
    /// row after the switch (it no longer leads the turn).
    func testTheRemoteRowSaysWhetherThePressIsCovered() throws {
        var host = playing()
        host.send(.command(.pause, source: .tap))
        host.send(.lifecycle(.background))
        host.bgRemainingMs = 29_400.4

        let press = host.send(.remote(RemotePress(.play, routePort: "carAudio")))
        let row = try XCTUnwrap(rows("remote", in: press).first, "\(press)")
        XCTAssertEqual(index(press) { if case let .diag(entry) = $0 { return entry.kind == "remote" }; return false }, 0,
                       "the remote row is the turn's first command")
        XCTAssertEqual(row[field: "grace"], .string("y"))
        XCTAssertEqual(row[field: "graceReason"], .string("remote-play"))
        XCTAssertEqual(row[field: "bgRemainingMs"], .number(29_400))
        XCTAssertEqual(row[field: "route"], .string("carAudio"))
        XCTAssertEqual(row[field: "state"], .string("interrupted"), "the state the press found")

        host.land()
        host.confirm()
        let pause = host.send(.remote(RemotePress(.pause)))
        let paused = try XCTUnwrap(rows("remote", in: pause).first)
        XCTAssertEqual(paused[field: "grace"], .string("n"))
        XCTAssertEqual(paused[field: "graceReason"], .null)

        host.bgRemainingMs = nil
        let foreground = try XCTUnwrap(rows("remote", in: host.send(.remote(RemotePress(.pause)))).first)
        XCTAssertEqual(foreground[field: "bgRemainingMs"], .null, "the foreground has no budget to report")
    }

    /// Plan §10: DV-1/H-1 and H-3 are judged on `resume grace=`, and DV-7a on
    /// the cold play. Each resume writes one `resume` row (kind interruption
    /// or route) and a cold play one `cold-play` row, as its span opens and
    /// before the activation it waits on.
    /// TO SEE IT FAIL: drop `spanRow(for: intent)` from `begin` (no route or
    /// cold-play row), or the `spanRow` calls in `onInterruptionEnded`.
    func testResumeAndColdPlayRowsCarryGrace() throws {
        var host = playing()
        host.bgRemainingMs = 27_000
        host.send(.session(.interruptionBegan(reason: "default")))
        let resumed = host.send(.session(.interruptionEnded(shouldResume: true)))
        let resume = try XCTUnwrap(rows("resume", in: resumed).first, "\(resumed)")
        XCTAssertEqual(rows("resume", in: resumed).count, 1)
        XCTAssertEqual(resume[field: "kind"], .string("interruption"))
        XCTAssertEqual(resume[field: "item"], .string("a"))
        XCTAssertEqual(resume[field: "grace"], .string("y"))
        XCTAssertEqual(resume[field: "graceReason"], .string("interruption-resume"))
        XCTAssertEqual(resume[field: "bgRemainingMs"], .number(27_000))
        if let activate = index(resumed, { Host.activation($0) != nil }),
           let at = index(resumed, { if case let .diag(entry) = $0 { return entry.kind == "resume" }; return false }) {
            XCTAssertLessThan(at, activate, "the row is written before the activation it waits on")
        }

        var car = playing()
        car.bgRemainingMs = 12_000
        car.send(.session(.route(RouteChange(oldDeviceUnavailable: true, routeName: "Civic", isCarRoute: true))))
        let back = car.send(.session(.route(RouteChange(oldDeviceUnavailable: false, routeName: "Civic"))))
        let route = try XCTUnwrap(rows("resume", in: back).first, "\(back)")
        XCTAssertEqual(route[field: "kind"], .string("route"))
        XCTAssertEqual(route[field: "grace"], .string("y"))
        XCTAssertEqual(route[field: "graceReason"], .string("route-resume"))
        XCTAssertEqual(route[field: "bgRemainingMs"], .number(12_000))

        var cold = Host()
        cold.bgRemainingMs = 25_000
        let launched = cold.send(.lifecycle(.coldLaunch(queue: [EngineCoreTests.item("a")], index: 0, autoplay: true)))
        let coldRow = try XCTUnwrap(rows("cold-play", in: launched).first, "\(launched)")
        XCTAssertEqual(coldRow[field: "item"], .string("a"))
        XCTAssertEqual(coldRow[field: "index"], .number(0))
        XCTAssertEqual(coldRow[field: "grace"], .string("y"))
        XCTAssertEqual(coldRow[field: "graceReason"], .string("cold-play"))
        XCTAssertEqual(coldRow[field: "bgRemainingMs"], .number(25_000))

        // A foreground tap play is no resume and no cold play: no such rows.
        var tap = Host()
        tap.send(.queue(.load([EngineCoreTests.item("a")])))
        let played = tap.send(.queue(.playIndex(0, startSec: nil, source: .tap)))
        XCTAssertTrue(rows("resume", in: played).isEmpty && rows("cold-play", in: played).isEmpty, "\(played)")
    }

    // MARK: - Interruptions and routes

    /// The resume is in place, INTERRUPTION_REWIND_SEC back, and a mic mute is
    /// a row, not a stop.
    func testInterruptionsByReason() {
        var host = playing()
        host.reading.positionSec = 42.5
        let muted = host.send(.session(.interruptionBegan(reason: "builtInMicMuted")))
        XCTAssertNil(firstSilencing(muted), "a muted mic takes nothing away")
        XCTAssertEqual(host.core.state.session, .active)
        host.send(.session(.interruptionBegan(reason: "default")))
        let resumed = host.send(.session(.interruptionEnded(shouldResume: true)))
        XCTAssertTrue(resumed.contains { if case let .deck(.load(_, _, _, startSec, _)) = $0 { return startSec == 41 }; return false },
                      "\(resumed)")
    }

    /// Plan §4.3: a pause the deck reports, followed within 500 ms by the
    /// route going away, is the route's: a later call's should-resume does
    /// not bring it back (corner case #13).
    func testAnUncommandedPauseThenARouteLossIsTheRoutes() {
        var host = playing()
        host.reading.audible = false
        host.send(.deck(.pausedUncommanded(token: host.lastLoad!, atSec: 3)))
        XCTAssertFalse(host.core.state.pausedByRoute)
        let route = host.send(.session(.route(RouteChange(oldDeviceUnavailable: true))), after: 200)
        XCTAssertTrue(route.contains { if case let .diag(entry) = $0 { return entry.kind == "session" && entry[field: "kind"] == .string("route-attributed") }; return false })
        XCTAssertNil(index(host.send(.session(.interruptionEnded(shouldResume: true))), isLoad))
    }

    // MARK: - Transport

    /// Toggle reads the deck, not only the belief: an audible deck behind a
    /// paused machine is paused by the press.
    func testToggleFromNativeTruth() throws {
        var host = playing()
        host.send(.command(.pause, source: .tap))
        host.reading.audible = true
        let out = host.send(try EngineCoreTests.command("toggle"))
        XCTAssertTrue(out.contains(.deck(.pause)), "\(out)")
        XCTAssertNil(index(out, isLoad))
        host.reading.audible = false
        XCTAssertNotNil(index(host.send(try EngineCoreTests.command("toggle")), isLoad), "a silent deck: the press plays")
    }

    /// A remote stop is a pause (T-7): nothing is torn down, nothing released.
    func testARemoteStopIsAPause() {
        var host = playing()
        let out = host.send(.remote(RemotePress(.stop)))
        XCTAssertTrue(out.contains(.deck(.pause)))
        XCTAssertFalse(out.contains { if case .sessionDeactivate = $0 { return true }; return false })
        XCTAssertNotNil(stopRow(.pause, in: out))
        XCTAssertEqual(host.core.state.stateType, "interrupted")
    }

    /// T-8: a second press inside the window is RECORDED as a dup candidate
    /// and still handled; one outside it is not a candidate.
    func testDuplicateRemotePressesAreRecordedNotDropped() {
        var host = playing()
        func dup(_ commands: [EngineCommand]) -> JSONNode? {
            for command in commands {
                if case let .diag(entry) = command, entry.kind == "remote" { return entry[field: "dupCandidate"] }
            }
            return nil
        }
        XCTAssertEqual(dup(host.send(.remote(RemotePress(.skipForward)), after: 5000)), .string("n"))
        let second = host.send(.remote(RemotePress(.skipForward)), after: 120)
        XCTAssertEqual(dup(second), .string("y"))
        XCTAssertTrue(second.contains { if case .deck(.seek) = $0 { return true }; return false }, "handled, not dropped")
        XCTAssertEqual(dup(host.send(.remote(RemotePress(.skipForward)), after: 900)), .string("n"))
    }

    /// The rate reaches the deck on every play, including a resume.
    func testRateOnEveryPlay() {
        var host = playing()
        host.send(.queue(.setRate(1.5)))
        host.send(.session(.interruptionBegan(reason: "default")))
        host.send(.session(.interruptionEnded(shouldResume: true)))
        XCTAssertEqual(host.land().filter { if case .deck = $0 { return true }; return false }, [.deck(.setRate(1.5)), .deck(.play)])
    }

    /// Seeks with nothing loaded are written down and ride on the next load;
    /// seeks while loading are held for it; seeks while paused move the deck.
    func testSeeksWhileIdleLoadingAndPaused() throws {
        var idle = Host()
        idle.send(.lifecycle(.coldLaunch(queue: [EngineCoreTests.item("a")], index: 0, autoplay: false)))
        let pended = idle.send(try EngineCoreTests.command("seekTo", .object([JSONMember("sec", .number(600))])))
        XCTAssertNil(pended.firstIndex { if case .deck = $0 { return true }; return false }, "nothing loaded: nothing to seek")
        XCTAssertTrue(idle.send(.command(.play, source: .tap))
            .contains { if case let .deck(.load(_, _, _, startSec, _)) = $0 { return startSec == 600 }; return false })

        var loading = Host()
        loading.send(.queue(.load([EngineCoreTests.item("a")])))
        loading.send(.queue(.playIndex(0, startSec: nil, source: .tap)))
        XCTAssertFalse(loading.send(try EngineCoreTests.command("seekTo", .object([JSONMember("sec", .number(90))])))
            .contains { if case .deck(.seek) = $0 { return true }; return false }, "held for the load")
        XCTAssertEqual(loading.land().filter { if case .deck = $0 { return true }; return false },
                       [.deck(.setRate(1)), .deck(.seek(toSec: 90)), .deck(.play)])

        var paused = playing()
        paused.send(.command(.pause, source: .tap))
        let moved = paused.send(try EngineCoreTests.command("seekTo", .object([JSONMember("sec", .number(120))])))
        XCTAssertTrue(moved.contains(.deck(.seek(toSec: 120))))
        XCTAssertNil(index(moved, isPlay), "a seek while paused stays paused")
    }

    /// Audit round 2, p-impatient-1 (transport-reconcile.test.js, xctest.json):
    /// ↺15 tapped while a resumed episode is still loading steps from the
    /// second the load will land on, so it is held for the load and lands 15 s
    /// before the resume point, never at 0:00.
    /// TO SEE IT FAIL: drop the pending load's `startSec` from `seekBy` (the
    /// nudge then steps from 0 and the resume point is sent to 0:00).
    func testANudgeDuringAColdLoadStepsFromWhereTheLoadLands() throws {
        var host = Host(positions: ["a": ResumeRules.StoredPosition(seconds: 2280, duration: nil)])
        host.send(.queue(.load([EngineCoreTests.item("a")])))
        let started = host.send(.queue(.playIndex(0, startSec: nil, source: .tap)))
        XCTAssertTrue(started.contains {
            if case let .deck(.load(_, _, _, startSec, _)) = $0 { return startSec == 2280 }
            return false
        }, "the cold load resumes: \(started)")
        let nudged = host.send(try EngineCoreTests.command("seekBy", .object([JSONMember("deltaSec", .number(-15))])))
        XCTAssertFalse(nudged.contains { if case .deck(.seek) = $0 { return true }; return false }, "held for the load: \(nudged)")
        let landed = host.land()
        XCTAssertTrue(landed.contains(.deck(.seek(toSec: 2265))), "15 s before the resume point: \(landed)")
    }

    /// Audit round 2, player-3 (transport-reconcile.test.js, xctest.json): a
    /// seek while paused saves the second being LEFT and nothing writes while
    /// paused, so playing another episode writes where the deck IS for the
    /// outgoing one first (client.js `play` flushes before the queue changes).
    /// TO SEE IT FAIL: drop the `flushPosition()` at the top of `playEpisode`.
    func testPlayingAnotherEpisodeKeepsAScrubMadeWhilePaused() throws {
        func episode(_ id: String) -> JSONNode {
            .object([JSONMember("item", .object([JSONMember("id", .string(id)),
                                                 JSONMember("audio_url", .string("https://cdn.example/\(id).mp3"))]))])
        }
        var host = Host()
        host.send(try EngineCoreTests.command("playEpisode", episode("a")))
        host.land()
        host.confirm()
        host.reading.positionSec = 600
        host.send(try EngineCoreTests.command("pause"))
        host.send(try EngineCoreTests.command("seekTo", .object([JSONMember("sec", .number(1800))])))
        XCTAssertEqual(host.reading.positionSec, 1800, "precondition: the deck moved")
        let left = host.send(try EngineCoreTests.command("playEpisode", episode("b")))
        let wrote = left.firstIndex {
            if case let .writePosition(write) = $0 { return write.itemId == "a" && write.seconds == 1800 }
            return false
        }
        let loadB = left.firstIndex {
            if case let .deck(.load(_, itemId, _, _, _)) = $0 { return itemId == "b" }
            return false
        }
        XCTAssertNotNil(wrote, "the scrub is what was kept: \(left)")
        XCTAssertNotNil(loadB, "\(left)")
        if let wrote, let loadB { XCTAssertLessThan(wrote, loadB, "written before the queue moved on") }
    }

    /// Hold policy `none`: the pause releases the session (without notify),
    /// after the deck is silent, and the next play activates again.
    func testHoldPolicyNoneReleasesAtPause() {
        var host = playing(config: EngineConfig(build: "test", holdPolicy: .noHold))
        let out = host.send(.command(.pause, source: .tap))
        guard let pause = index(out, { $0 == .deck(.pause) }),
              let release = index(out, { $0 == .sessionDeactivate(notifyOthers: false) }) else {
            return XCTFail("\(out)")
        }
        XCTAssertLessThan(pause, release)
        XCTAssertEqual(host.send(.command(.play, source: .tap)).compactMap(Host.activation).count, 1)
    }

    // MARK: - Rows, events and the restore record

    /// `lastEpisodeRow` is stored VERBATIM in the page's key order, with the
    /// engine's `updated_at`, when the item actually plays, and not before.
    func testLastEpisodeRowIsWrittenVerbatimWhenTheItemPlays() throws {
        var host = Host()
        let row = JSONNode.object([JSONMember("title", .string("T")), JSONMember("id", .string("ep")),
                                   JSONMember("custom", .number(1))])
        let item = JSONNode.object([JSONMember("id", .string("ep")), JSONMember("audio_url", .string("https://x/ep.mp3"))])
        let asked = host.send(try EngineCoreTests.command("playEpisode", .object([JSONMember("item", item),
                                                                                    JSONMember("lastEpisodeRow", row)])))
        XCTAssertFalse(asked.contains { if case .writeRow = $0 { return true }; return false }, "not before it plays")
        let played = host.land()
        XCTAssertTrue(played.contains(.writeRow(StoredRow(
            key: "cp_last_episode",
            value: #"{"title":"T","id":"ep","custom":1,"updated_at":"2026-09-21T14:13:20.000Z"}"#))), "\(played)")
        XCTAssertTrue(played.contains { if case let .writeRestore(record?) = $0 { return record.mode == .episode && record.index == 0 }; return false })
    }

    /// The periodic writer runs exactly while playing, writes only when the
    /// playhead moved, and each write may append the once-a-minute position
    /// event, which the page acks away.
    func testPositionCadenceAndPendingEvents() throws {
        var host = Host()
        host.send(.queue(.load([EngineCoreTests.item("a")])))
        host.send(.queue(.playIndex(0, startSec: nil, source: .tap)))
        XCTAssertTrue(host.land().contains(.timerArm(.positionTick, afterMs: ResumeRules.positionIntervalMs, repeating: true)))
        host.reading.positionSec = 4
        XCTAssertTrue(host.send(.timer(.positionTick)).contains { if case .writePosition = $0 { return true }; return false },
                      "a first tick writes")
        host.reading.positionSec = 9
        XCTAssertFalse(host.send(.timer(.positionTick)).contains { if case .writePosition = $0 { return true }; return false },
                       "under the minimum delta: no write")
        host.reading.positionSec = 70
        let later = host.send(.timer(.positionTick))
        XCTAssertTrue(later.contains { if case let .appendEvent(event) = $0 { return event.episodeId == "a" && event.seconds == 70 }; return false })
        XCTAssertEqual(host.core.state.pendingEvents.map(\.seq), [1, 2])
        host.send(try EngineCoreTests.command("ackEvents", .object([JSONMember("upToSeq", .number(1))])))
        XCTAssertEqual(host.core.state.pendingEvents.map(\.seq), [2])
        XCTAssertTrue(host.send(.command(.pause, source: .tap)).contains(.timerCancel(.positionTick)))
    }

    // MARK: - Continuation (plan §5.5)

    static func hop(_ seq: Int, next: String) -> JSONNode {
        .object([JSONMember("planSeq", .number(7)), JSONMember("hopSeq", .number(Double(seq))),
                 JSONMember("nextId", .string(next)),
                 JSONMember("item", .object([JSONMember("id", .string(next)),
                                             JSONMember("audio_url", .string("https://cdn.example/\(next).mp3"))])),
                 JSONMember("lastEpisodeRow", .object([JSONMember("id", .string(next))]))])
    }

    func continuation(autoAdvance: Bool, _ hops: [JSONNode]) throws -> EngineInput {
        try EngineCoreTests.command("setContinuation", .object([JSONMember("planSeq", .number(7)),
                                                                JSONMember("autoAdvance", .bool(autoAdvance)),
                                                                JSONMember("chain", .array(hops))]))
    }

    /// At an end the chain is walked ONLY with autoAdvance on; `canNext` is
    /// the chain either way.
    func testAnEndWalksTheChainOnlyWithAutoAdvance() throws {
        var off = playing()
        off.send(try continuation(autoAdvance: false, [EngineCoreTests.hop(1, next: "b")]))
        XCTAssertTrue(off.core.canNext)
        XCTAssertNil(index(off.send(.deck(.ended(token: off.lastLoad!))), isLoad))
        XCTAssertEqual(off.core.state.stateType, "ended")

        var on = playing()
        on.send(try continuation(autoAdvance: true, [EngineCoreTests.hop(1, next: "b"), EngineCoreTests.hop(2, next: "c")]))
        let walked = on.send(.deck(.ended(token: on.lastLoad!)))
        XCTAssertTrue(walked.contains { if case let .deck(.load(_, itemId, _, _, _)) = $0 { return itemId == "b" }; return false })
        XCTAssertTrue(walked.contains { if case .emit(.advanced) = $0 { return true }; return false })
        XCTAssertEqual(on.core.state.advanceLog.map(\.hop.nextId), ["b"])
        XCTAssertEqual(on.core.state.chain.map(\.nextId), ["c"])
        XCTAssertFalse(walked.contains { if case .sessionDeactivate = $0 { return true }; return false }, "a hop is not an end")
        XCTAssertTrue(on.land().contains { if case let .writeRow(row) = $0 { return row.key == "cp_last_episode" }; return false })
    }

    /// Next walks the chain whatever autoAdvance says, and the page acks it.
    func testNextWalksTheChainAndTheAckTrimsTheLog() throws {
        var host = playing()
        host.send(try continuation(autoAdvance: false, [EngineCoreTests.hop(1, next: "b")]))
        XCTAssertNotNil(index(host.send(try EngineCoreTests.command("next")), isLoad))
        XCTAssertEqual(host.core.state.advanceLog.map(\.seq), [1])
        XCTAssertFalse(host.core.canNext, "the chain is spent")
        host.send(try EngineCoreTests.command("ackAdvances", .object([JSONMember("upToSeq", .number(1))])))
        XCTAssertEqual(host.core.state.advanceLog.count, 0)
        XCTAssertTrue(host.send(try EngineCoreTests.command("next")).contains(.commandFailed(reason: "no-next")))
    }

    /// C-6: a chained start that fails says `chain-start`.
    func testAFailedChainedStartIsAChainStartError() throws {
        var host = playing()
        host.send(try continuation(autoAdvance: true, [EngineCoreTests.hop(1, next: "b")]))
        host.send(.deck(.ended(token: host.lastLoad!)))
        let failed = host.send(.deck(.failed(token: host.lastLoad!, message: "404")))
        XCTAssertTrue(failed.contains(.emit(.error(code: "chain-start", message: "404"))), "\(failed)")
    }

    // MARK: - DeckPolicy's tokens are the generated ones

    func testDeckPolicyTokensAreTheGeneratedConstants() {
        XCTAssertEqual(DeckPolicy.FineWake.stop.rawValue, EngineConstants.DeckPolicy.FineWake.stop)
        XCTAssertEqual(DeckPolicy.FineWake.reschedule.rawValue, EngineConstants.DeckPolicy.FineWake.reschedule)
        XCTAssertEqual(DeckPolicy.FineWake.standDown.rawValue, EngineConstants.DeckPolicy.FineWake.standDown)
        XCTAssertEqual(DeckPolicy.Recovery.armOutPoint.rawValue, EngineConstants.DeckPolicy.Recovery.armOutPoint)
        XCTAssertEqual(DeckPolicy.Recovery.play.rawValue, EngineConstants.DeckPolicy.Recovery.play)
        XCTAssertEqual(DeckPolicy.Recovery.report.rawValue, EngineConstants.DeckPolicy.Recovery.report)
    }
}

/// The scenario driver's own checks, proved by breaking the core on purpose
/// (card NE-14s's mutations) and by the properties the fixtures cannot
/// state: one audible source, every grace span closed.
final class EngineScenarioDriverTests: XCTestCase {
    private func data() throws -> ParityData {
        try ParityData.load(parityDir: try ParityLocator.locate())
    }

    private func scenario(_ id: String, in data: ParityData) throws -> FixtureCase {
        for file in data.fixtures["manager-episode"] ?? [] {
            if let found = file.cases.first(where: { $0.id == id }) { return found }
        }
        throw HarnessError("E_BAD_CASE", "no \(id) in the manager-episode fixtures")
    }

    private func report(_ mutation: EngineScenarioDriver.Mutation, data: ParityData) -> SuiteReport {
        var runners = ParityFamilies.all.filter { $0.family != "manager-episode" }
        runners.append(ManagerEpisodeFamily.makeRunner(mutation: mutation))
        return ParitySuite(data: data, runners: runners).run()
    }

    private func result(_ id: String, in report: SuiteReport) -> CaseResult? {
        report.results.first { $0.id == id }
    }

    /// MUTATION: a play before the deck is ready. The named case goes red
    /// with the driver's evidence in its diff.
    func testAPlayBeforeTheDeckIsReadyTurnsTheScenarioRed() throws {
        let data = try data()
        let red = result("manager-episode/play-loads-then-starts", in: report(.playOnLoad, data: data))
        XCTAssertEqual(red?.outcome, .failed)
        XCTAssertTrue(red?.detail.contains("!deck-play-before-ready") ?? false, red?.detail ?? "no result")
    }

    /// MUTATION: a play while the session is lost to an interruption.
    func testAPlayWhileLostToAnInterruptionTurnsTheScenarioRed() throws {
        let data = try data()
        let id = "manager-episode/declined-call-resumes-answered-call-stays-paused"
        let red = result(id, in: report(.playWhileLost, data: data))
        XCTAssertEqual(red?.outcome, .failed)
        XCTAssertTrue(red?.detail.contains("!audible-start:deckPlay@lostToInterruption") ?? false, red?.detail ?? "no result")
        let run = try EngineScenarioDriver(mutation: .playWhileLost).run(try scenario(id, in: data),
                                                                         context: Codec.Context(repoRoot: data.repoRoot))
        XCTAssertTrue(run.violations.contains("audible-start:deckPlay@lostToInterruption"), "\(run.violations)")
    }

    /// Two loads land for two skips; exactly one item starts, and it is the
    /// final target: never two audible sources.
    func testTwoLandingLoadsStartOneItemAndOneSourceOnly() throws {
        let data = try data()
        let run = try EngineScenarioDriver().run(try scenario("manager-episode/double-skip-with-slow-loads-plays-once", in: data),
                                                 context: Codec.Context(repoRoot: data.repoRoot))
        XCTAssertEqual(run.plays, ["a", "c"])
        XCTAssertEqual(run.maxAudibleSources, 1)
        XCTAssertEqual(run.violations, [])
    }

    /// Every manager-episode scenario, unbroken: no check fires, and every
    /// grace span begun is ended (and some are begun: the resumes, the car,
    /// the cold play).
    func testEveryScenarioKeepsTheInvariantsAndClosesItsGrace() throws {
        let data = try data()
        let context = Codec.Context(repoRoot: data.repoRoot)
        var begun = 0
        for file in data.fixtures["manager-episode"] ?? [] {
            for testCase in file.cases where testCase.kind == .scenario {
                let run = try EngineScenarioDriver().run(testCase, context: context)
                XCTAssertEqual(run.violations, [], testCase.id)
                let begins = run.commands.filter { if case .graceBegin = $0 { return true }; return false }.count
                let ends = run.commands.filter { if case .graceEnd = $0 { return true }; return false }.count
                XCTAssertEqual(begins, ends, "\(testCase.id): every grace begin has an end")
                begun += begins
            }
        }
        XCTAssertGreaterThanOrEqual(begun, 5, "the resume, route and cold scenarios open grace")
    }
}
