import XCTest
import ForayEngineCore
import ForayEngineParity

/// Card NE-30s: what the Foray tape families cannot see, because it goes
/// through the engine CONTRACT the manager-foray scenarios do not use
/// (`playForay` and its structural check, the Foray clock's transport, a
/// Foray never chaining, `cp_foray`), or because it is native-only (the
/// beat's timer, grace across a seam, the `skipped` event).
///
/// The host is EngineCoreTests' (`Host`): an input and the deck's reading in,
/// commands out, the activation answered in the same turn.
final class ForayTapeTests: XCTestCase {
    typealias Host = EngineCoreTests.Host

    static let tape = EngineConfig(build: "test", forayTapeEnabled: true)

    /// A built clip, as `buildForayQueue` hands it to `playForay`.
    static func clip(_ index: Int, _ name: String, _ start: Double, _ end: Double,
                     _ extra: [JSONMember] = []) -> JSONNode {
        .object([JSONMember("id", .string("f1#\(index)")), JSONMember("kind", .string("episode")),
                 JSONMember("audio_url", .string("https://cdn.test/\(name).mp3")),
                 JSONMember("start_sec", .number(start)), JSONMember("end_sec", .number(end)),
                 JSONMember("duration_sec", .number(3600))] + extra)
    }

    static let twoClips = [clip(0, "a", 100, 200), clip(1, "b", 300, 400)]

    static func forayArgs(_ items: [JSONNode], startElapsedSec: Double? = nil) -> JSONNode {
        var members = [JSONMember("forayId", .string("f1")), JSONMember("title", .string("A Foray")),
                       JSONMember("items", .array(items)), JSONMember("buildReport", .object([])),
                       JSONMember("isLocalFile", .bool(false)), JSONMember("allowAdPad", .bool(false)),
                       JSONMember("voiceId", .null)]
        if let startElapsedSec { members.append(JSONMember("startElapsedSec", .number(startElapsedSec))) }
        return .object(members)
    }

    static func loads(_ out: [EngineCommand]) -> [String] {
        out.compactMap {
            if case let .deck(.load(_, itemId, _, startSec, _)) = $0 { return "\(itemId)@\(JSWriter.numberToString(startSec))" }
            return nil
        }
    }

    static func foraysRows(_ out: [EngineCommand]) -> [StoredRow] {
        out.compactMap {
            if case let .writeRow(row) = $0, row.key.hasPrefix("cp_foray:") { return row }
            return nil
        }
    }

    /// A host playing the Foray's first clip, confirmed audible.
    func playing(_ items: [JSONNode] = ForayTapeTests.twoClips) throws -> Host {
        var host = Host(config: ForayTapeTests.tape)
        host.send(try EngineCoreTests.command("playForay", ForayTapeTests.forayArgs(items)))
        host.land()
        host.confirm()
        XCTAssertEqual(host.core.state.stateType, "playing")
        return host
    }

    /// The out-point (or the file) ends the current clip, in the same instant.
    @discardableResult
    func end(_ host: inout Host) -> [EngineCommand] {
        host.reading.audible = false
        host.reading.ended = true
        return host.send(.deck(.ended(token: host.lastLoad ?? 0)), after: 0)
    }

    // MARK: - playForay

    /// The flag is OFF by default (plan §12, until NE-37): a Foray is refused
    /// `capability-off` and nothing loads, exactly M1's answer.
    func testWithTheTapeOffPlayForayIsRefusedAndNothingLoads() throws {
        var host = Host()
        let out = host.send(try EngineCoreTests.command("playForay", ForayTapeTests.forayArgs(ForayTapeTests.twoClips)))
        XCTAssertTrue(out.contains(.commandFailed(reason: "capability-off")), "\(out)")
        XCTAssertEqual(ForayTapeTests.loads(out), [])
    }

    /// J-4: a queue with a clip that has no audio is refused whole, before
    /// anything is audible or even loading.
    func testABadStructureIsRefusedBeforeAnythingLoads() throws {
        var host = Host(config: ForayTapeTests.tape)
        let silent: JSONNode = .object([JSONMember("id", .string("f1#0")), JSONMember("kind", .string("episode")),
                                        JSONMember("start_sec", .number(100)), JSONMember("end_sec", .number(200))])
        let out = host.send(try EngineCoreTests.command("playForay", ForayTapeTests.forayArgs([silent])))
        XCTAssertTrue(out.contains(.commandFailed(reason: "refused-structure")), "\(out)")
        XCTAssertEqual(ForayTapeTests.loads(out), [])
        XCTAssertNil(host.core.state.forayId)
    }

    /// The in-point rule: the first clip loads at its `start_sec`, and a
    /// resume point on the Foray clock lands inside its own clip
    /// (`segmentAtElapsed`, `sourceOffsetFor`): 150 s in is 50 s into clip 1.
    func testTheInPointAndAForayClockResumePoint() throws {
        var first = Host(config: ForayTapeTests.tape)
        let start = first.send(try EngineCoreTests.command("playForay", ForayTapeTests.forayArgs(ForayTapeTests.twoClips)))
        XCTAssertEqual(ForayTapeTests.loads(start), ["f1#0@100"])
        var resumed = Host(config: ForayTapeTests.tape)
        let out = resumed.send(try EngineCoreTests.command(
            "playForay", ForayTapeTests.forayArgs(ForayTapeTests.twoClips, startElapsedSec: 150)))
        XCTAssertEqual(ForayTapeTests.loads(out), ["f1#1@350"])
        XCTAssertEqual(resumed.core.state.currentIndex, 1)
    }

    /// A Foray is ONE queue: next on its last clip is `no-next` even with a
    /// continuation chain set, and its end walks no hop.
    func testAForayNeverChains() throws {
        var host = try playing()
        let hop: JSONNode = .object([JSONMember("planSeq", .number(1)), JSONMember("hopSeq", .number(1)),
                                     JSONMember("nextId", .string("ep-x")),
                                     JSONMember("item", EngineCoreTests.item("ep-x").node)])
        host.send(try EngineCoreTests.command("setContinuation", .object([
            JSONMember("planSeq", .number(1)), JSONMember("autoAdvance", .bool(true)), JSONMember("chain", .array([hop]))])))
        XCTAssertFalse(host.core.canNext && host.core.state.currentIndex == 1)
        let next = host.send(try EngineCoreTests.command("next"))
        XCTAssertEqual(ForayTapeTests.loads(next), ["f1#1@300"])
        host.land()
        host.confirm()
        let refused = host.send(try EngineCoreTests.command("next"))
        XCTAssertTrue(refused.contains(.commandFailed(reason: "no-next")), "\(refused)")
        XCTAssertFalse(host.core.canNext)
        let ended = end(&host)
        XCTAssertEqual(host.core.state.stateType, "ended")
        XCTAssertFalse(ended.contains { if case .emit(.advanced) = $0 { return true }; return false }, "\(ended)")
    }

    /// Play on a FINISHED Foray starts at its first clip's in-point, never a
    /// resume of the last clip's last second.
    func testPlayOnAnEndedForayStartsAtZero() throws {
        var host = try playing([ForayTapeTests.clip(0, "a", 100, 200)])
        end(&host)
        XCTAssertEqual(host.core.state.stateType, "ended")
        let again = host.send(try EngineCoreTests.command("play"))
        XCTAssertEqual(ForayTapeTests.loads(again), ["f1#0@100"])
    }

    /// Foray-clock transport: a seek is on the Foray clock (clip 1, 20 s in).
    func testASeekIsOnTheForayClock() throws {
        var host = try playing()
        let out = host.send(try EngineCoreTests.command("seekTo", .object([JSONMember("sec", .number(120))])))
        XCTAssertEqual(ForayTapeTests.loads(out), ["f1#1@320"], "\(out)")
    }

    // MARK: - the seam beat

    /// The beat is stamped AT THE OUT-POINT, the next load runs inside it, and
    /// it is wall clock: a speed change during it neither cuts it nor scales
    /// it. The next clip starts when its remainder runs out, not before.
    func testTheBeatIsStampedAtTheOutPointAndDoesNotScaleWithRate() throws {
        var host = try playing()
        host.reading.positionSec = 200
        let out = end(&host)
        XCTAssertTrue(host.core.state.inSeamGap)
        XCTAssertEqual(ForayTapeTests.loads(out), ["f1#1@300"], "the next load starts inside the beat")
        let ready = host.send(.deck(.ready(token: host.lastLoad ?? 0, landedSec: 300, prerolled: true, elapsedMs: 5)), after: 100)
        XCTAssertTrue(ready.contains(.timerArm(.seamBeat, afterMs: 400, repeating: false)), "\(ready)")
        XCTAssertFalse(ready.contains(.deck(.play)), "never early")
        let rate = host.send(.queue(.setRate(2)), after: 100)
        XCTAssertFalse(rate.contains(.timerCancel(.seamBeat)), "a speed change is not a transport action")
        XCTAssertEqual(host.core.seamGapRemainingMs(atMono: host.monoMs), 300)
        let fired = host.send(.timer(.seamBeat), after: 300)
        XCTAssertTrue(fired.contains(.deck(.play)), "\(fired)")
        XCTAssertFalse(host.core.state.inSeamGap)
        XCTAssertTrue(fired.contains { if case let .diag(entry) = $0 { return entry.kind == SeamRow.kind }; return false },
                      "the packed seam row is written when the seam lands")
    }

    /// Any transport action cuts the beat: a pause during it leaves nothing
    /// audible, and the beat's timer is gone.
    func testAPauseDuringTheBeatCutsItAndNothingStarts() throws {
        var host = try playing()
        end(&host)
        host.send(.deck(.ready(token: host.lastLoad ?? 0, landedSec: 300, prerolled: true, elapsedMs: 5)), after: 0)
        let pause = host.send(try EngineCoreTests.command("pause"), after: 100)
        XCTAssertTrue(pause.contains(.timerCancel(.seamBeat)), "\(pause)")
        XCTAssertFalse(pause.contains(.deck(.play)))
        XCTAssertFalse(host.core.state.inSeamGap)
        XCTAssertEqual(host.core.state.stateType, "interrupted")
        let late = host.send(.timer(.seamBeat), after: 1000)
        XCTAssertFalse(late.contains(.deck(.play)), "a stale timer starts nothing")
    }

    /// Backgrounded, the seam holds a grace span from the out-point until the
    /// next clip is audible: `seam` when the standby deck was asked to prepare
    /// it, `prepare-miss` when not.
    func testGraceSpansASeamInTheBackground() throws {
        var host = try playing()
        let window = host.send(.deck(.prepareWindow(token: host.lastLoad ?? 0)))
        XCTAssertTrue(window.contains(.deck(.prepare(itemId: "f1#1", url: "https://cdn.test/b.mp3", startSec: 300))), "\(window)")
        host.send(.lifecycle(.background))
        let out = end(&host)
        XCTAssertTrue(out.contains(.graceBegin(.seam)), "\(out)")
        host.send(.deck(.ready(token: host.lastLoad ?? 0, landedSec: 300, prerolled: true, elapsedMs: 5)), after: 0)
        host.send(.timer(.seamBeat), after: 500)
        let confirmed = host.confirm()
        XCTAssertTrue(confirmed.contains(.graceEnd(.playing)), "\(confirmed)")

        var cold = try playing()
        cold.send(.lifecycle(.background))
        XCTAssertTrue(end(&cold).contains(.graceBegin(.prepareMiss)))
    }

    /// ADR-0007 at load: an APPROXIMATE copy is never audible. The segment is
    /// skipped with a `skipped` event and row, and the Foray goes on.
    func testALadderRefusalSkipsWithAnEventAndARow() throws {
        let dai = ForayTapeTests.clip(0, "dai", 100, 200, [
            JSONMember("dai_suspected", .bool(true)), JSONMember("needs_drift_check", .bool(true)),
            JSONMember("reference_duration_sec", .number(2501)),
            JSONMember("start_anchor", .string("so the thing")), JSONMember("end_anchor", .string("and that is why"))])
        var host = Host(config: ForayTapeTests.tape)
        host.reading.durationSec = 3600
        host.send(try EngineCoreTests.command("playForay", ForayTapeTests.forayArgs([dai, ForayTapeTests.clip(1, "b", 300, 400)])))
        let landed = host.land()
        XCTAssertTrue(landed.contains { if case .emit(.skipped(itemId: "f1#0", index: 0, reason: _)) = $0 { return true }; return false },
                      "\(landed)")
        XCTAssertFalse(landed.contains(.deck(.play)), "the refused copy is never audible")
        XCTAssertEqual(ForayTapeTests.loads(landed), ["f1#1@300"])
        XCTAssertEqual(host.core.state.skippedSegments, 1)
    }

    // MARK: - cp_foray

    /// The cadence: the position tick writes at most once per 5 s of Foray
    /// clock; a pause writes at once (forced); the end marks it finished,
    /// once.
    func testTheCpForayCadence() throws {
        var host = try playing([ForayTapeTests.clip(0, "a", 100, 200)])
        host.reading.positionSec = 110
        let first = ForayTapeTests.foraysRows(host.send(.timer(.positionTick)))
        XCTAssertEqual(first.map(\.key), ["cp_foray:f1"])
        XCTAssertTrue(first.first?.value.contains("\"elapsed_sec\":10") ?? false, first.first?.value ?? "")
        host.reading.positionSec = 112
        XCTAssertEqual(ForayTapeTests.foraysRows(host.send(.timer(.positionTick))).count, 0, "throttled")
        host.reading.positionSec = 116
        XCTAssertEqual(ForayTapeTests.foraysRows(host.send(.timer(.positionTick))).count, 1)
        host.reading.positionSec = 117
        XCTAssertEqual(ForayTapeTests.foraysRows(host.send(try EngineCoreTests.command("pause"))).count, 1, "a pause is forced")
        host.send(try EngineCoreTests.command("play"))
        host.land()
        host.confirm()
        let finished = ForayTapeTests.foraysRows(end(&host))
        XCTAssertEqual(finished.count, 1)
        XCTAssertTrue(finished.first?.value.contains("\"elapsed_sec\":100") ?? false, finished.first?.value ?? "")
    }
}

/// The Foray tape's scenario driver: the card's mutation, A-4, and the flags.
final class ForayTapeScenarioTests: XCTestCase {
    private func data() throws -> ParityData {
        try ParityData.load(parityDir: try ParityLocator.locate())
    }

    /// MUTATION (the card's): start the next load AFTER the beat instead of
    /// inside it, and a seam-timing case goes red.
    func testLoadingAfterTheBeatTurnsASeamTimingCaseRed() throws {
        let data = try data()
        var runners = ParityFamilies.all.filter { $0.family != "manager-foray" }
        runners.append(ManagerForayFamily.makeRunner(mutation: .loadAfterBeat))
        let report = ParitySuite(data: data, runners: runners).run()
        let red = report.results.first { $0.id == "manager-foray/an-unbridged-seam-holds-the-full-beat" }
        XCTAssertEqual(red?.outcome, .failed, red?.detail ?? "no result")
        let clean = ParitySuite(data: data, runners: ParityFamilies.all).run()
        XCTAssertEqual(clean.results.first { $0.id == "manager-foray/an-unbridged-seam-holds-the-full-beat" }?.outcome, .passed)
    }

    /// A-4 with two fake decks (the player and the standby) across 3 seams:
    /// one engine, every seam prepared inside its window and handed over at
    /// its boundary, never more than one source audible, each clip started
    /// once, in order, and nothing the driver checks broken.
    func testA4HoldsAcrossThreeHandedOverSeams() throws {
        let data = try data()
        let clips = [ForayTapeTests.clip(0, "a", 100, 200), ForayTapeTests.clip(1, "b", 300, 400),
                     ForayTapeTests.clip(2, "c", 500, 600), ForayTapeTests.clip(3, "d", 700, 800)]
        var steps: [String] = [
            #"{"call":"playForay","args":{"forayId":"f1","title":"Four","items":[],"buildReport":{},"isLocalFile":false,"allowAdPad":false,"voiceId":null}}"#
        ]
        for end in [200, 400, 600] {
            steps += [#"{"deck":"time","sec":\#(end - 10)}"#, #"{"deck":"window"}"#, #"{"deck":"time","sec":\#(end)}"#,
                      #"{"deck":"ended","reason":"outPoint"}"#, #"{"clock":500}"#]
        }
        steps.append(#"{"checkpoint":"last"}"#)
        let json = #"{"id":"a4/three-seams","setup":{"target":"engine"},"steps":["# + steps.joined(separator: ",") + "]}"
        let raw = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        let testCase = FixtureCase(id: "a4/three-seams", fields: raw.objectValue ?? [:])
        let run = try EngineScenarioDriver(forayTape: true, inlineBuilds: [0: clips])
            .run(testCase, context: Codec.Context(repoRoot: data.repoRoot))
        XCTAssertEqual(run.violations, [])
        XCTAssertEqual(run.maxAudibleSources, 1)
        XCTAssertEqual(run.plays, ["f1#0", "f1#1", "f1#2", "f1#3"])
        let ops = run.encoded.objectValue?["ops"]?.arrayValue?.compactMap(\.stringValue) ?? []
        XCTAssertEqual(ops.filter { $0.hasPrefix("n.prepare:") }, ["n.prepare:f1#1@300", "n.prepare:f1#2@500", "n.prepare:f1#3@700"])
        XCTAssertEqual(ops.filter { $0.hasPrefix("n.handover:") }, ["n.handover:f1#1@300", "n.handover:f1#2@500", "n.handover:f1#3@700"])
        for handover in ops.enumerated() where handover.element.hasPrefix("n.handover:") {
            XCTAssertEqual(ops[handover.offset + 1].hasPrefix("load:"), true, "the handover is said before its load")
        }
        XCTAssertEqual(run.finalState.stateType, "playing")
        XCTAssertEqual(run.finalState.currentIndex, 3)
    }

    /// With the flags off (the default), the manager-episode family is
    /// unchanged: every scenario passes as recorded, and turning the Foray
    /// tape on changes no episode's op log either.
    func testTheFlagsOffLeaveTheManagerEpisodeFamilyUnchanged() throws {
        let data = try data()
        let context = Codec.Context(repoRoot: data.repoRoot)
        var ran = 0
        for file in data.fixtures["manager-episode"] ?? [] {
            for testCase in file.cases where testCase.kind == .scenario {
                let off = try EngineScenarioDriver().run(testCase, context: context)
                if let expect = testCase.expect {
                    XCTAssertEqual(Comparator.compare(expect, off.encoded, family: file.family, tolerance: testCase.tolerance).count, 0,
                                   testCase.id)
                }
                let on = try EngineScenarioDriver(forayTape: true).run(testCase, context: context)
                XCTAssertEqual(on.encoded, off.encoded, "\(testCase.id): the Foray tape changed an episode path")
                ran += 1
            }
        }
        XCTAssertGreaterThan(ran, 30)
    }
}
