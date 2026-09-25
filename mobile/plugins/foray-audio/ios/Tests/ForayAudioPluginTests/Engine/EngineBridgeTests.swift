import XCTest
import ForayEngineCore
@testable import ForayAudioPlugin

/// `EngineBridge` (card NE-20, docs/native-engine-plan.md §5.1-§5.4): what
/// `engineHello`, `engineSend` and `engineRead` answer, and which `engine`
/// events reach the page, over a real `ForayEngine` on the NE-15h recording
/// seams and a fake owner. No Capacitor, no WebView: the plugin's part is to
/// move these payloads across, and `shell-invariants` pins that it does.
///
/// The card's acceptance, executed headless on the Simulator by `ci.yml`'s
/// ios-kit: 1,000 transitions while hidden emit zero events and one snapshot
/// on visible; an invalid payload resolves `{ok: false, reason:
/// "unknown-cmd"}`; audition while running is `engine-busy`; audition while
/// idle activates once through the SessionControlling fake before speaking.
/// Every answer is also checked against the contract decoder the page's
/// schema is ported to.
///
/// Each test names the edit that turns it red.
final class EngineBridgeTests: XCTestCase {

    // MARK: - Harness

    @MainActor
    final class FakeOwner: EngineBridgeOwner {
        let decision: EngineMode.Decision
        var engine: ForayEngine?
        private(set) var hellos = 0
        private(set) var overrides: [EngineMode.Override] = []
        private(set) var relinquishes = 0

        init(native: Bool, engine: ForayEngine?) {
            decision = EngineMode.decide(EngineMode.Inputs(
                buildDefault: native ? .native : .js, modeOverride: .auto, sentinelWasSet: false, strikes: 0,
                stickyLegacyBuild: nil, currentBuild: "test", built: engine != nil))
            self.engine = engine
        }

        func decideOnce() -> EngineMode.Decision { decision }
        func helloReceived() { hellos += 1 }
        func setModeOverride(_ mode: EngineMode.Override) { overrides.append(mode) }

        /// What EngineOwnership.relinquish does with the engine.
        func relinquish(cap: EngineContract.RelinquishCap, source: EngineSource) -> EngineVerdict {
            relinquishes += 1
            guard let engine, !engine.isTornDown else {
                return EngineVerdict(failures: [EngineContract.Refusal.relinquished.rawValue], deferred: false)
            }
            let verdict = engine.handle(.command(.relinquish(cap: cap), source: source))
            if !verdict.deferred { engine.teardown() }
            return verdict
        }
    }

    final class FakeRecords: EngineRecords {
        var rows: [String: String] = [:]
        var diagnosticRows: [DiagRow] = []
        var onLiveRow: ((DiagRow) -> Void)?

        func sharedRows(prefixes: [String]) -> [String: String] {
            rows.filter { key, _ in prefixes.contains { key.hasPrefix($0) } }
        }
    }

    /// One process: the engine on the recording seams, its owner, and the
    /// bridge on a clock of its own (the engine's timers must not be fired by
    /// a test that means the bridge's window).
    @MainActor
    final class Rig {
        let world: FakeWorld
        let clock: FakeTiming
        let records: FakeRecords
        let engine: ForayEngine?
        let owner: FakeOwner
        let bridge: EngineBridge

        init(native: Bool = true, capabilities: [String]? = ["episode", "continuation"]) {
            let world = FakeWorld()
            let records = FakeRecords()
            let clock = FakeTiming(log: SeamLog())
            var engine: ForayEngine?
            if native {
                let built = ForayEngine(seams: world.seams, config: EngineConfig(build: "test"))
                built.start()
                engine = built
            }
            let owner = FakeOwner(native: native, engine: engine)
            let box = Box()
            self.world = world
            self.records = records
            self.clock = clock
            self.engine = engine
            self.owner = owner
            self.box = box
            bridge = EngineBridge(owner: owner, records: records, timing: clock,
                                  declaredCapabilities: capabilities, deliver: { box.events.append($0) })
        }

        final class Box { var events: [JSONNode] = [] }
        private let box: Box
        var events: [JSONNode] { box.events }
        var eventTypes: [String] { box.events.compactMap { $0["type"]?.stringValue } }
        func clearEvents() { box.events.removeAll() }

        private var seq = 0

        /// One engineSend, numbered as the page numbers them.
        @discardableResult
        func send(_ cmd: String, _ args: String? = nil, source: String = "tap") -> JSONNode {
            seq += 1
            return bridge.send(EngineBridgeTests.json(#"{"v":1,"cmdSeq":\#(seq),"cmd":"\#(cmd)","source":"\#(source)""#
                                    + (args.map { #","args":\#($0)"# } ?? "") + "}"))
        }

        /// Episode "a" playing on a warm deck, through the engine directly
        /// (the bridge's own playEpisode waits on the `episode` capability).
        func playing() {
            world.deck.answersReady = true
            engine?.handle(.queue(.load([ForayEngineHostTests.item("a")])))
            engine?.handle(.queue(.playIndex(0, startSec: nil, source: .tap)))
        }

        var cmdRows: [DiagEntry] { world.output.diags.filter { $0.kind == "cmd" } }
    }

    static func json(_ text: String) -> JSONNode {
        try! JSONNode.parse(text)
    }

    private static let hello = json(#"{"pageBuild":"test","protocol":1}"#)

    private func accepted(_ kind: EngineContract.Kind, _ payload: JSONNode, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertNil(EngineContract.refusal(kind, payload), JSWriter.stringify(payload), file: file, line: line)
    }

    // MARK: - The acceptance

    /// §5.4: nothing leaves a hidden page, however much happens; the page
    /// coming back gets ONE snapshot, the latest, at once; after that, at
    /// most one a second.
    /// TO SEE IT FAIL: deliver from `transitioned()` without the coalescer,
    /// drop the `visible` guard in `SnapshotCoalescer.pump`, or apply
    /// `setPageVisible` to the coalescer before a refused send returns.
    @MainActor
    func testAThousandHiddenTransitionsEmitNothingAndVisibleSendsOneSnapshot() throws {
        let rig = Rig()
        let engine = try XCTUnwrap(rig.engine)
        XCTAssertEqual(rig.bridge.hello(Self.hello)["mode"], .string("native"))
        XCTAssertEqual(rig.send("setPageVisible", #"{"visible":false}"#)["ok"], .bool(true))
        XCTAssertFalse(rig.bridge.pageVisible)
        rig.clearEvents()

        for index in 0..<1000 {
            // A rate change moves the snapshot's content every time.
            engine.handle(.queue(.setRate(index % 2 == 0 ? 1.5 : 1.0)))
            rig.clock.advance(250)
            rig.clock.fire(afterMs: EngineBridgeRules.snapshotEventMinMs)
        }
        XCTAssertEqual(rig.events.count, 0, "a hidden page hears nothing: \(rig.eventTypes)")

        XCTAssertEqual(rig.send("setPageVisible", #"{"visible":true}"#)["ok"], .bool(true))
        XCTAssertEqual(rig.eventTypes, ["snapshot"], "one snapshot on visible")
        let snapshot = try XCTUnwrap(rig.events.first?["snapshot"])
        accepted(.event, try XCTUnwrap(rig.events.first))
        XCTAssertEqual(snapshot["rate"], .number(1.0), "the latest content, not a stale one")

        // Visible: the window holds the next change, and releases the latest.
        engine.handle(.queue(.setRate(2.0)))
        engine.handle(.queue(.setRate(1.25)))
        XCTAssertEqual(rig.events.count, 1, "at most one a second")
        rig.clock.fire(afterMs: EngineBridgeRules.snapshotEventMinMs)
        XCTAssertEqual(rig.eventTypes, ["snapshot", "snapshot"])
        XCTAssertEqual(rig.events.last?["snapshot"]?["rate"], .number(1.25))
        XCTAssertGreaterThan(rig.events.last?["snapshot"]?["seq"]?.numberValue ?? 0,
                             snapshot["seq"]?.numberValue ?? .infinity, "seq is a content version and moved")
    }

    /// §5.1: engineSend never rejects. A payload the contract refuses (not an
    /// object, an unknown command, a command without its args, a wrong `v`)
    /// is `{ok: false, reason: "unknown-cmd", snapshot}`, and the engine is
    /// not touched.
    /// TO SEE IT FAIL: throw from `send`, reply without a snapshot, or pass
    /// a half-decoded command to the engine.
    @MainActor
    func testAnInvalidPayloadResolvesUnknownCmd() {
        let rig = Rig()
        let before = rig.world.log.entries.filter { !$0.hasPrefix("output.") }
        for payload in [
            JSONNode.null,
            Self.json(#"{"v":1,"cmdSeq":1,"cmd":"teleport","source":"tap"}"#),
            Self.json(#"{"v":1,"cmdSeq":2,"cmd":"seekTo","source":"tap"}"#),
            Self.json(#"{"v":2,"cmdSeq":3,"cmd":"play","source":"tap"}"#),
            Self.json(#"{"v":1,"cmdSeq":4,"cmd":"play","source":"a-stranger"}"#)
        ] {
            let reply = rig.bridge.send(payload)
            accepted(.sendResponse, reply)
            XCTAssertEqual(reply["ok"], .bool(false), JSWriter.stringify(payload))
            XCTAssertEqual(reply["reason"], .string("unknown-cmd"), JSWriter.stringify(payload))
        }
        XCTAssertEqual(rig.world.log.entries.filter { !$0.hasPrefix("output.") }, before, "no seam was touched")
        XCTAssertEqual(rig.cmdRows.count, 5)
        XCTAssertTrue(rig.cmdRows.allSatisfy { $0[field: "invalid"] == .string("y") })
        XCTAssertEqual(rig.cmdRows[1][field: "cmd"], .string("teleport"))
    }

    /// OQ-5: one session owner. While the engine plays, an audition is
    /// refused `engine-busy` and nothing is spoken.
    /// TO SEE IT FAIL: drop the core's running check, or route audition
    /// around the engine (a second synthesizer is a second owner).
    @MainActor
    func testAuditionWhileRunningReturnsEngineBusy() {
        let rig = Rig()
        rig.playing()
        XCTAssertEqual(rig.engine?.state.stateType, "playing")
        let reply = rig.send("audition", #"{"text":"Hello","voiceId":null}"#)
        accepted(.sendResponse, reply)
        XCTAssertEqual(reply["ok"], .bool(false))
        XCTAssertEqual(reply["reason"], .string("engine-busy"))
        XCTAssertEqual(rig.world.speaker.spoken, [])
        XCTAssertEqual(reply["snapshot"]?["running"], .bool(true))
    }

    /// OQ-5 and §4.4's audible-start invariant: while idle, the audition
    /// activates the session ONCE, through the SessionControlling seam, and
    /// only then speaks, with the page-resolved voice.
    /// TO SEE IT FAIL: speak before `.sessionResult`, or activate from the
    /// bridge instead of the core.
    @MainActor
    func testAuditionWhileIdleActivatesOnceBeforeSpeaking() throws {
        let rig = Rig()
        let reply = rig.send("audition", #"{"text":"Hello","voiceId":"com.apple.voice.compact.en-US.Samantha"}"#)
        accepted(.sendResponse, reply)
        XCTAssertEqual(reply["ok"], .bool(true), JSWriter.stringify(reply))
        XCTAssertEqual(rig.world.session.activateCalls, 1)
        XCTAssertEqual(rig.world.speaker.spoken, ["Hello"])
        let activate = try XCTUnwrap(rig.world.log.index(of: "session.activate"))
        let speak = try XCTUnwrap(rig.world.log.index(of: "speaker.speak"))
        XCTAssertLessThan(activate, speak, "activated before speaking: \(rig.world.log.entries)")
        XCTAssertEqual(reply["snapshot"]?["session"], .string("active"))

        // A refused activation speaks nothing and says why.
        let refused = Rig()
        refused.world.session.answer = SessionActivation(ok: false, error: "cannot-interrupt-others", activateMs: 3)
        let failed = refused.send("audition", #"{"text":"Hello","voiceId":null}"#)
        XCTAssertEqual(failed["reason"], .string("session-failed:cannot-interrupt-others"))
        XCTAssertEqual(refused.world.speaker.spoken, [])
    }

    // MARK: - engineHello

    /// A native hello says everything the page attaches with, and its
    /// capabilities are the plist's ∩ the advertised; a legacy process says
    /// only its lane and why. Both stand the watchdog down.
    /// TO SEE IT FAIL: answer the plist's capabilities as is, or skip
    /// `helloReceived()`.
    @MainActor
    func testHelloAnswersNativeOrLegacy() {
        let rig = Rig(capabilities: ["episode", "continuation", "foray"])
        let native = rig.bridge.hello(Self.hello)
        accepted(.helloResponse, native)
        XCTAssertEqual(native["mode"], .string("native"))
        XCTAssertEqual(native["reason"], .string("build-default"))
        XCTAssertEqual(native["capabilities"], .array([.string("continuation")]))
        XCTAssertEqual(native["pendingAdvances"], .array([]))
        XCTAssertEqual(rig.owner.hellos, 1)

        let legacy = Rig(native: false)
        let answer = legacy.bridge.hello(Self.hello)
        accepted(.helloResponse, answer)
        XCTAssertEqual(answer["mode"], .string("legacy"))
        XCTAssertEqual(answer["reason"], .string("not-built"))
        XCTAssertEqual(legacy.owner.hellos, 1)
        // Legacy refuses the transport, but the Developer override still works.
        let play = legacy.send("play")
        accepted(.sendResponse, play)
        XCTAssertEqual(play["reason"], .string("capability-off"))
        XCTAssertEqual(legacy.send("setModeOverride", #"{"mode":"native"}"#)["ok"], .bool(true))
        XCTAssertEqual(legacy.owner.overrides, [.native])
    }

    /// A capability the hello did not grant is refused before the engine
    /// hears of it: this build advertises no `episode` yet.
    /// TO SEE IT FAIL: drop the `requiredCapability` check.
    @MainActor
    func testPlayEpisodeWithoutTheCapabilityIsRefused() {
        let rig = Rig()
        let reply = rig.send("playEpisode", #"{"item":{"id":"a","audio_url":"https://cdn.example/a.mp3"},"lastEpisodeRow":{"id":"a"}}"#)
        accepted(.sendResponse, reply)
        XCTAssertEqual(reply["reason"], .string("capability-off"))
        XCTAssertEqual(rig.world.deck.count("load"), 0)
        XCTAssertEqual(rig.world.session.activateCalls, 0)
    }

    // MARK: - seqGap and D-4

    /// Every valid send is on record with its source before anything can
    /// no-op; a `cmdSeq` that skips is marked; a new page's hello restarts
    /// the count.
    /// TO SEE IT FAIL: write the row only on success, compare against the
    /// last seq without the +1, or keep the count across a hello.
    @MainActor
    func testEverySendIsRecordedAndASkippedCmdSeqIsAGap() {
        let rig = Rig()
        _ = rig.bridge.send(Self.json(#"{"v":1,"cmdSeq":1,"cmd":"pause","source":"tap"}"#))
        _ = rig.bridge.send(Self.json(#"{"v":1,"cmdSeq":2,"cmd":"next","source":"remote"}"#))
        _ = rig.bridge.send(Self.json(#"{"v":1,"cmdSeq":4,"cmd":"play","source":"tap"}"#))
        XCTAssertEqual(rig.cmdRows.map { $0[field: "cmd"] }, [.string("pause"), .string("next"), .string("play")])
        XCTAssertEqual(rig.cmdRows.map { $0[field: "source"] }, [.string("tap"), .string("remote"), .string("tap")])
        XCTAssertEqual(rig.cmdRows.map { $0[field: "seqGap"] }, [nil, nil, .string("y")])

        _ = rig.bridge.hello(Self.hello)
        _ = rig.bridge.send(Self.json(#"{"v":1,"cmdSeq":1,"cmd":"pause","source":"tap"}"#))
        XCTAssertNil(rig.cmdRows.last?[field: "seqGap"], "a new page counts from its own start")
    }

    // MARK: - Relinquish and modeChanged

    /// The page's relinquish goes through the owner (which runs the legacy
    /// hand-over); a visible page hears `modeChanged` and the relinquished
    /// snapshot; afterwards the hello says legacy/downgrade and the
    /// transport is refused `relinquished`.
    /// TO SEE IT FAIL: relinquish through the engine alone, or answer a
    /// native hello from a torn-down engine.
    @MainActor
    func testRelinquishGoesThroughTheOwnerAndAnnouncesTheHandBack() {
        let rig = Rig()
        _ = rig.bridge.hello(Self.hello)
        rig.clearEvents()
        let reply = rig.send("relinquish", #"{"cap":"all"}"#, source: "restore")
        accepted(.sendResponse, reply)
        XCTAssertEqual(reply["ok"], .bool(true))
        XCTAssertEqual(rig.owner.relinquishes, 1)
        XCTAssertEqual(rig.engine?.isTornDown, true)
        XCTAssertEqual(rig.eventTypes.first, "modeChanged")
        XCTAssertEqual(rig.eventTypes.filter { $0 == "modeChanged" }.count, 1, "announced once")
        for event in rig.events { accepted(.event, event) }
        XCTAssertEqual(reply["snapshot"]?["session"], .string("relinquished"))

        let hello = rig.bridge.hello(Self.hello)
        accepted(.helloResponse, hello)
        XCTAssertEqual(hello["mode"], .string("legacy"))
        XCTAssertEqual(hello["reason"], .string("downgrade"))
        XCTAssertEqual(rig.send("play")["reason"], .string("relinquished"))
    }

    // MARK: - engineRead

    /// Shared rows by prefix, the engine's only; an unowned prefix reads
    /// nothing; diagnostics is the whole ring in one call; the snapshot read
    /// is the one the events carry.
    /// TO SEE IT FAIL: read an unowned prefix, or return the ring's text
    /// instead of its rows.
    @MainActor
    func testReadServesRowsByPrefixTheRingAndTheSnapshot() {
        let rig = Rig()
        rig.records.rows = ["cp_pos:a": #"{"s":1}"#, "cp_last_episode": #"{"id":"a"}"#]
        rig.records.diagnosticRows = [DiagRow(seq: 1, wallMs: 1, monoMs: 1, kind: "build", fields: []),
                                      DiagRow(seq: 2, wallMs: 2, monoMs: 2, kind: "cmd", fields: [])]

        let positions = rig.bridge.read(Self.json(#"{"what":"rows","prefixes":["cp_pos:"]}"#))
        accepted(.rowsResponse, positions)
        XCTAssertEqual(positions["rows"]?.members?.map(\.key), ["cp_pos:a"])
        let all = rig.bridge.read(Self.json(#"{"what":"rows"}"#))
        XCTAssertEqual(all["rows"]?.members?.map(\.key), ["cp_last_episode", "cp_pos:a"])
        let unowned = rig.bridge.read(Self.json(#"{"what":"rows","prefixes":["cp_rate"]}"#))
        XCTAssertEqual(unowned, Self.json(#"{"rows":{}}"#), "an unowned prefix reads nothing")

        let ring = rig.bridge.read(Self.json(#"{"what":"diagnostics"}"#))
        accepted(.diagnosticsResponse, ring)
        XCTAssertEqual(ring["rows"]?.arrayValue?.count, 2)

        rig.playing()
        let snapshot = rig.bridge.read(Self.json(#"{"what":"snapshot"}"#))
        accepted(.snapshot, snapshot)
        XCTAssertEqual(snapshot["mode"], .string("episode"))
        XCTAssertEqual(snapshot["itemId"], .string("a"))
        XCTAssertEqual(snapshot["state"], .string("playing"))
    }

    /// The core's `error` event and a live fault row reach a visible page,
    /// and neither reaches a hidden one; the error is the snapshot's
    /// `lastError` either way.
    /// TO SEE IT FAIL: forward events without the visibility guard, or
    /// forget `lastError`.
    @MainActor
    func testEngineEventsAndFaultRowsReachOnlyAVisiblePage() {
        let rig = Rig()
        _ = rig.bridge.hello(Self.hello)
        rig.clearEvents()
        rig.records.onLiveRow?(DiagRow(seq: 9, wallMs: 1, monoMs: 1, kind: "fault",
                                       fields: [JSONMember("kind", .string("implicit-activation"))]))
        XCTAssertEqual(rig.eventTypes, ["diag"])
        accepted(.event, rig.events[0])

        rig.send("setPageVisible", #"{"visible":false}"#)
        rig.clearEvents()
        rig.records.onLiveRow?(DiagRow(seq: 10, wallMs: 1, monoMs: 1, kind: "fault", fields: []))
        rig.engine?.onEmit?(.error(code: "chain-start", message: "hop x carries no playable item"))
        XCTAssertEqual(rig.events.count, 0)
        let snapshot = rig.bridge.read(Self.json(#"{"what":"snapshot"}"#))
        XCTAssertEqual(snapshot["lastError"], .string("chain-start"))
    }

    /// Capacitor's options become the core's JSON with booleans kept apart
    /// from numbers; anything that is not an object reads as null.
    /// TO SEE IT FAIL: convert with `as? NSNumber` (a boolean then reads as
    /// 1), or return an empty object for nil.
    func testCapacitorOptionsDecodeAsTheCoresJSON() {
        let options: [AnyHashable: Any] = ["visible": true, "cmdSeq": 3, "rate": 1.5, "voiceId": NSNull(),
                                           "args": ["text": "Hi"]]
        let node = EngineBridge.payload(from: options)
        XCTAssertEqual(node["visible"], .bool(true))
        XCTAssertEqual(node["cmdSeq"], .number(3))
        XCTAssertEqual(node["rate"], .number(1.5))
        XCTAssertEqual(node["voiceId"], .null)
        XCTAssertEqual(node["args"]?["text"], .string("Hi"))
        XCTAssertEqual(EngineBridge.payload(from: nil), .null)
    }
}
