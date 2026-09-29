import XCTest
import ForayEngineCore
import ForayEngineParity

/// Card NE-31s: what the narration and jingle families cannot see, because it
/// is native-only (the utterance `seq` on every command and answer, the voice
/// and its fallback, the restore record's voiceId, grace at narration end, the
/// silence node, teardown) or is a rule no scenario can reach (a deadline
/// landing mid-transition, queue-manager.js's `_applying` retry, which a
/// synchronous turn makes impossible by construction).
///
/// The host is EngineCoreTests' (`Host`), with the synthesiser played by the
/// test: it feeds `NarratorEvent`s for the `seq` the core stamped.
final class NarrationOverlayTests: XCTestCase {
    typealias Host = EngineCoreTests.Host

    static let tape = EngineConfig(build: "test", forayTapeEnabled: true)

    /// A built script-only line, as `buildForayQueue` hands it over.
    static func line(_ index: Int, _ script: String, durationSec: Double? = nil) -> EngineItem {
        var members = [JSONMember("id", .string("f1#\(index)")), JSONMember("kind", .string("tts")),
                       JSONMember("type", .string("narration")), JSONMember("script", .string(script)),
                       JSONMember("audio_url", .null)]
        if let durationSec { members.append(JSONMember("duration_sec", .number(durationSec))) }
        return EngineItem(node: .object(members))!
    }

    static func clip(_ index: Int, _ name: String, _ start: Double, _ end: Double) -> EngineItem {
        EngineItem(node: ForayTapeTests.clip(index, name, start, end))!
    }

    static func speaks(_ out: [EngineCommand]) -> [NarrationCommand] {
        out.compactMap { if case let .narration(command) = $0 { return command }; return nil }
    }

    static func spokenSeq(_ out: [EngineCommand]) -> Int? {
        speaks(out).compactMap { if case let .speak(seq, _, _, _) = $0 { return seq }; return nil }.last
    }

    static func armsTick(_ out: [EngineCommand]) -> Bool {
        out.contains(.timerArm(.narrationTick, afterMs: EngineConstants.QueueManager.narrationTickMs, repeating: false))
    }

    /// A host whose Foray opens on `items[0]`, a spoken line the synthesiser
    /// has accepted.
    func speaking(_ items: [EngineItem], config: EngineConfig = NarrationOverlayTests.tape) -> (Host, Int) {
        var host = Host(config: config)
        host.send(.queue(.loadForay(items, isLocalFile: false, allowAdPad: false)))
        let out = host.send(.queue(.playIndex(0, startSec: nil, source: .tap)))
        guard let seq = NarrationOverlayTests.spokenSeq(out) else {
            XCTFail("no line was spoken: \(out)")
            return (host, 0)
        }
        host.send(.narrator(.started(seq: seq, voiceFallback: false)), after: 0)
        XCTAssertEqual(host.core.state.stateType, "playing")
        XCTAssertEqual(host.core.state.narration?.seq, seq)
        return (host, seq)
    }

    // MARK: - The rule no scenario can reach (xctest.json)

    /// queue-manager.js: "a deadline that lands mid-transition retries on the
    /// next tick instead of killing the ticker". There, `_onTtsFinished`
    /// declines while `_applying > 0` and the ticker must outlive the refusal.
    /// Here every input is one synchronous turn, so a pulse can never land in
    /// the middle of a transition: what the rule protects is that a line past
    /// its deadline advances EXACTLY ONCE and the ticker is never lost before
    /// it does. Every pulse before the deadline re-arms; the first one past it
    /// (4 s x 1.5 + 10 s = 16 s) advances; a pulse delivered while that
    /// advance's load is still in flight advances nothing; and the landing
    /// drops the line.
    func testADeadlineTickNeverLandsMidTransitionAndNeverAdvancesTwice() {
        var (host, seq) = speaking([NarrationOverlayTests.line(0, "four seconds of narration", durationSec: 4),
                                    NarrationOverlayTests.clip(1, "a", 100, 200)])
        XCTAssertEqual(EngineCore.narrationDeadlineSec(host.core.state.currentItem, rate: 1), 16)
        var advancedAt: Int?
        for tick in 1...80 {
            let out = host.send(.timer(.narrationTick), after: EngineConstants.QueueManager.narrationTickMs)
            XCTAssertTrue(out.contains { if case .narrationPulse = $0 { return true }; return false }, "tick \(tick): \(out)")
            if ForayTapeTests.loads(out).isEmpty {
                XCTAssertTrue(NarrationOverlayTests.armsTick(out), "tick \(tick) did not re-arm: \(out)")
                continue
            }
            XCTAssertEqual(ForayTapeTests.loads(out), ["f1#1@100"])
            XCTAssertFalse(NarrationOverlayTests.armsTick(out), "the tick that advanced re-armed: \(out)")
            advancedAt = tick
            break
        }
        XCTAssertEqual(advancedAt, 65, "16.25 s is the first pulse past a 16 s deadline")
        XCTAssertEqual(host.core.state.advancedSpeakSeq, seq)
        // A pulse the host had already queued, delivered before the load lands.
        let stray = host.send(.timer(.narrationTick), after: EngineConstants.QueueManager.narrationTickMs)
        XCTAssertEqual(ForayTapeTests.loads(stray), [], "\(stray)")
        XCTAssertEqual(host.core.state.stateType, "loadingItem")
        let landed = host.land()
        XCTAssertNil(host.core.state.narration)
        XCTAssertTrue(landed.contains(.narration(.discard(seq: seq))), "a line past its deadline is dropped: \(landed)")
        XCTAssertFalse(host.core.state.narrationTickArmed)
    }

    // MARK: - speak(seq, script, voice, utteranceRate)

    /// OQ-3 (founder, 2026-09-24): a line is uttered at NARRATION_RATE, 1x,
    /// whatever the listener's speed, in the listener's voice; with
    /// `narrationFollowsListenerRate` (OFF) it would ride the listener's rate.
    func testALineIsSpokenAt1xInTheChosenVoice() throws {
        var host = Host(config: EngineConfig(build: "test", rate: 1.5, forayTapeEnabled: true))
        host.send(try EngineCoreTests.command("setVoice", .object([JSONMember("voiceId", .string("voice-a"))])))
        host.send(.queue(.loadForay([NarrationOverlayTests.line(0, "hello there")], isLocalFile: false, allowAdPad: false)))
        let out = host.send(.queue(.playIndex(0, startSec: nil, source: .tap)))
        XCTAssertEqual(NarrationOverlayTests.speaks(out), [.speak(seq: 1, text: "hello there", voiceId: "voice-a", utteranceRate: 1)])
        XCTAssertFalse(out.contains { if case .deck(.load) = $0 { return true }; return false }, "a spoken line never loads a deck")

        var follows = Host(config: EngineConfig(build: "test", rate: 1.5, forayTapeEnabled: true,
                                                narrationFollowsListenerRate: true))
        follows.send(.queue(.loadForay([NarrationOverlayTests.line(0, "hello there")], isLocalFile: false, allowAdPad: false)))
        let fast = follows.send(.queue(.playIndex(0, startSec: nil, source: .tap)))
        XCTAssertEqual(NarrationOverlayTests.speaks(fast), [.speak(seq: 1, text: "hello there", voiceId: nil, utteranceRate: 1.5)])
    }

    /// V-01: the synthesiser's own fallback is reported, and a speak that
    /// failed clears it; the voice rides in the restore record, and a cold
    /// core takes it back.
    func testVoiceFallbackAndTheVoiceInTheRestoreRecord() throws {
        var (host, _) = speaking([NarrationOverlayTests.line(0, "one"), NarrationOverlayTests.line(1, "two"),
                                  NarrationOverlayTests.clip(2, "a", 100, 200)],
                                 config: EngineConfig(build: "test", forayTapeEnabled: true, voiceId: "voice-a"))
        XCTAssertEqual(host.core.state.lastVoiceFallback, false)
        let finished = host.send(.narrator(.finished(seq: 1)), after: 0)
        guard let second = NarrationOverlayTests.spokenSeq(finished) else { return XCTFail("\(finished)") }
        XCTAssertEqual(host.core.state.stateType, "transitioning")
        host.send(.narrator(.started(seq: second, voiceFallback: true)), after: 0)
        XCTAssertEqual(host.core.state.lastVoiceFallback, true)

        let chosen = host.send(try EngineCoreTests.command("setVoice", .object([JSONMember("voiceId", .string("voice-b"))])))
        var written: RestoreRecord?
        for command in chosen {
            if case let .writeRestore(record?) = command { written = record }
        }
        guard var cold = written else { return XCTFail("no restore record: \(chosen)") }
        XCTAssertEqual(cold.voiceId, "voice-b")
        cold.mode = .episode
        XCTAssertEqual(EngineCore.restoring(cold, config: EngineConfig())?.core.state.voiceId, "voice-b")

        // A bridge the synthesiser refuses is stepped over, and says nothing
        // about a voice any more.
        var refusing = Host(config: NarrationOverlayTests.tape)
        refusing.send(.queue(.loadForay([NarrationOverlayTests.clip(0, "a", 100, 200), NarrationOverlayTests.line(1, "bridge"),
                                         NarrationOverlayTests.clip(2, "b", 300, 400)], isLocalFile: false, allowAdPad: false)))
        refusing.send(.queue(.playIndex(0, startSec: nil, source: .tap)))
        refusing.land()
        refusing.confirm()
        refusing.reading.audible = false
        refusing.reading.ended = true
        let bridge = refusing.send(.deck(.ended(token: refusing.lastLoad ?? 0)), after: 0)
        guard let bridgeSeq = NarrationOverlayTests.spokenSeq(bridge) else { return XCTFail("\(bridge)") }
        let skipped = refusing.send(.narrator(.failed(seq: bridgeSeq, reason: "refused")), after: 0)
        XCTAssertEqual(ForayTapeTests.loads(skipped), ["f1#2@300"])
        XCTAssertNil(refusing.core.state.lastVoiceFallback)
    }

    // MARK: - L-05

    /// Pause holds the utterance at a word and freezes its clock; resume
    /// CONTINUES the same seq (never a second speak); stop is immediate and a
    /// cancel is never a finish; a finish is taken once, for its own seq.
    func testPauseResumeStopAndExactlyOnceBySeq() {
        var (host, seq) = speaking([NarrationOverlayTests.line(0, "a line"), NarrationOverlayTests.clip(1, "a", 100, 200)])
        let paused = host.send(.command(.pause, source: .tap), after: 1000)
        XCTAssertEqual(NarrationOverlayTests.speaks(paused), [.pause(seq: seq)])
        XCTAssertEqual(host.core.narrationElapsedSec(atMono: host.monoMs + 5000), 1, "the clock froze at the pause")
        let resumed = host.send(.command(.play, source: .tap), after: 5000)
        XCTAssertEqual(NarrationOverlayTests.speaks(resumed), [.resume(seq: seq)], "continue, never re-speak")
        host.send(.narrator(.resumed(seq: seq, answer: .continued)), after: 0)
        XCTAssertEqual(host.core.narrationElapsedSec(atMono: host.monoMs), 1, "the clock continues from where it froze")

        // A finish for any other utterance is not this line's.
        XCTAssertEqual(ForayTapeTests.loads(host.send(.narrator(.finished(seq: seq + 7)), after: 0)), [])
        // A cancel (a stop, a replacement, the session taken) never advances.
        XCTAssertEqual(ForayTapeTests.loads(host.send(.narrator(.cancelled(seq: seq)), after: 0)), [])
        XCTAssertEqual(host.core.state.stateType, "playing")

        let stopped = host.send(.command(.stop(persist: true), source: .tap))
        XCTAssertEqual(NarrationOverlayTests.speaks(stopped), [.stop(seq: seq)], "one call: no pause before the stop")
        XCTAssertEqual(host.core.state.stateType, "idle")
        XCTAssertEqual(ForayTapeTests.loads(host.send(.narrator(.finished(seq: seq)), after: 0)), [], "stop never advances")
    }

    /// OQ-5: an audition is refused while a spoken line is running.
    func testAuditionIsRefusedWhileALineIsSpoken() throws {
        var (host, _) = speaking([NarrationOverlayTests.line(0, "a line"), NarrationOverlayTests.clip(1, "a", 100, 200)])
        let out = host.send(try EngineCoreTests.command("audition", .object([JSONMember("text", .string("hi")),
                                                                              JSONMember("voiceId", .null)])))
        XCTAssertTrue(out.contains(.commandFailed(reason: "engine-busy")), "\(out)")
        XCTAssertFalse(out.contains { if case .speak = $0 { return true }; return false })
    }

    /// Corner case #18 with a spoken line: a speed tap is kept (`pendingRate`)
    /// and reaches the deck only when the line has ended.
    func testASpeedTapDuringALineLandsAfterIt() {
        var (host, seq) = speaking([NarrationOverlayTests.line(0, "a line"), NarrationOverlayTests.clip(1, "a", 100, 200)])
        let tapped = host.send(.queue(.setRate(1.5)))
        XCTAssertFalse(tapped.contains(.deck(.setRate(1.5))), "\(tapped)")
        XCTAssertEqual(host.core.state.pendingRate, 1.5)
        host.send(.narrator(.finished(seq: seq)), after: 0)
        let landed = host.land()
        XCTAssertTrue(landed.contains(.deck(.setRate(1.5))), "\(landed)")
        XCTAssertNil(host.core.state.pendingRate)
    }

    // MARK: - Grace, the silence node, the snapshot, teardown

    /// Grace at narration end: in the background a line that finishes opens
    /// a span that the next item's audible start closes.
    func testGraceCoversTheNarrationHandoverInTheBackground() {
        var (host, seq) = speaking([NarrationOverlayTests.line(0, "a line"), NarrationOverlayTests.clip(1, "a", 100, 200)])
        host.send(.lifecycle(.background))
        let ended = host.send(.narrator(.finished(seq: seq)), after: 0)
        XCTAssertTrue(ended.contains(.graceBegin(.narrationHandover)), "\(ended)")
        host.land()
        let audible = host.confirm()
        XCTAssertTrue(audible.contains(.graceEnd(.playing)), "\(audible)")
        XCTAssertNil(host.core.state.grace)
    }

    /// The silence node is OFF by default; on, a silent seam starts it capped
    /// at INTERLUDE_CEILING_SEC and the next clip's start stops it. It never
    /// runs for a transport that is not running.
    func testTheSilenceNodeIsFlaggedOffAndCappedWhenOn() {
        func seam(_ config: EngineConfig) -> (Host, [EngineCommand]) {
            var host = Host(config: config)
            host.send(.queue(.loadForay([NarrationOverlayTests.clip(0, "a", 100, 200), NarrationOverlayTests.clip(1, "b", 300, 400)],
                                        isLocalFile: false, allowAdPad: false)))
            host.send(.queue(.playIndex(0, startSec: nil, source: .tap)))
            host.land()
            host.confirm()
            host.reading.audible = false
            host.reading.ended = true
            let out = host.send(.deck(.ended(token: host.lastLoad ?? 0)), after: 0)
            return (host, out)
        }
        let (_, off) = seam(NarrationOverlayTests.tape)
        XCTAssertFalse(off.contains { if case .silenceStart = $0 { return true }; return false }, "\(off)")
        var (host, on) = seam(EngineConfig(build: "test", forayTapeEnabled: true, silenceNodeEnabled: true))
        let capMs = EngineConstants.Interlude.interludeCeilingSec * 1000
        XCTAssertTrue(on.contains(.silenceStart(capMs: capMs)), "\(on)")
        XCTAssertTrue(on.contains(.timerArm(.silenceCap, afterMs: capMs, repeating: false)), "\(on)")
        let landed = host.land()
        XCTAssertTrue(landed.contains(.silenceStop), "\(landed)")
        XCTAssertFalse(host.core.state.silenceActive)
        XCTAssertEqual(Interlude.silenceNodeSec(sinceOutPointSec: 0, running: false, sessionActive: true), 0)
        XCTAssertEqual(Interlude.silenceNodeSec(sinceOutPointSec: 0, running: true, sessionActive: false), 0)
    }

    /// The snapshot says a spoken line is the playhead, and its clock.
    func testTheSnapshotCarriesTheSpokenLine() {
        let (host, _) = speaking([NarrationOverlayTests.line(0, "a line"), NarrationOverlayTests.clip(1, "a", 100, 200)])
        let body = EngineSnapshot.body(core: host.core, deck: host.reading, lastError: nil, monoMs: host.monoMs + 2500)
        XCTAssertEqual(body.first { $0.key == "isNarrationPlayhead" }?.value, .bool(true))
        XCTAssertEqual(body.first { $0.key == "narrationElapsedSec" }?.value, .number(2.5))
        XCTAssertEqual(body.first { $0.key == "inInterlude" }?.value, .bool(false))
        let bare = EngineSnapshot.body(core: host.core, deck: host.reading, lastError: nil)
        XCTAssertNil(bare.first { $0.key == "narrationElapsedSec" })
    }

    /// Teardown: the line is stopped, the deck released, every timer ended,
    /// and nothing is answered after it (a late finish advances nothing).
    func testTeardownSilencesAndAnswersNothingMore() {
        var (host, seq) = speaking([NarrationOverlayTests.line(0, "a line"), NarrationOverlayTests.clip(1, "a", 100, 200)])
        let out = host.send(.lifecycle(.teardown), after: 0)
        XCTAssertEqual(NarrationOverlayTests.speaks(out), [.stop(seq: seq)])
        XCTAssertTrue(out.contains(.deck(.unload)), "\(out)")
        XCTAssertTrue(host.core.state.tornDown)
        XCTAssertEqual(host.core.state.stateType, "playing", "a teardown is not a transport action")
        XCTAssertEqual(host.send(.narrator(.finished(seq: seq)), after: 0), [])
    }
}

/// The card's mutations, through the parity driver.
final class NarrationOverlayScenarioTests: XCTestCase {
    private func data() throws -> ParityData {
        try ParityData.load(parityDir: try ParityLocator.locate())
    }

    private func outcome(_ id: String, mutation: EngineScenarioDriver.Mutation?, data: ParityData) -> CaseResult? {
        var runners = ParityFamilies.all.filter { $0.family != "manager-foray" }
        runners.append(ManagerForayFamily.makeRunner(mutation: mutation))
        return ParitySuite(data: data, runners: runners).run().results.first { $0.id == id }
    }

    /// MUTATION (the card's): map cancel to finished, and the line whose
    /// session was taken from under it (transport-reconcile's L-05 case)
    /// ADVANCES instead of being interrupted.
    func testMappingCancelToFinishedTurnsTheInterruptedLineRed() throws {
        let data = try data()
        let id = "manager-foray/an-interruption-during-a-spoken-line"
        XCTAssertEqual(outcome(id, mutation: nil, data: data)?.outcome, .passed)
        let red = outcome(id, mutation: .cancelAsFinished, data: data)
        XCTAssertEqual(red?.outcome, .failed, red?.detail ?? "no result")
    }

    /// MUTATION (the card's): drop the seq check, and exactly-once goes red.
    /// A late duplicate `didFinish` of the first line, arriving once the
    /// second line is speaking, must not advance past the second.
    func testDroppingTheSeqCheckTurnsExactlyOnceRed() throws {
        let data = try data()
        let items: [JSONNode] = [
            NarrationOverlayTests.line(0, "first line").node, NarrationOverlayTests.line(1, "second line").node,
            ForayTapeTests.clip(2, "a", 100, 200)
        ]
        let json = #"{"id":"narration/late-duplicate-finish","setup":{"target":"manager","tts":true},"steps":["#
            + #"{"call":"playForay","args":[{}]},{"tts":"finish"},{"settle":1},{"checkpoint":"second"},"#
            + #"{"tts":"finishPrevious"},{"settle":1},{"checkpoint":"late-duplicate"}]}"#
        let raw = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        let testCase = FixtureCase(id: "narration/late-duplicate-finish", fields: raw.objectValue ?? [:])
        let context = Codec.Context(repoRoot: data.repoRoot)
        let clean = try EngineScenarioDriver(forayTape: true, inlineBuilds: [0: items]).run(testCase, context: context)
        XCTAssertEqual(clean.violations, [])
        XCTAssertEqual(clean.finalState.currentIndex, 1)
        XCTAssertEqual(clean.finalState.stateType, "transitioning")
        XCTAssertEqual(clean.finalState.narration?.itemId, "f1#1")
        let broken = try EngineScenarioDriver(mutation: .finishedClaimsCurrentLine, forayTape: true, inlineBuilds: [0: items])
            .run(testCase, context: context)
        XCTAssertEqual(broken.finalState.currentIndex, 2, "without the seq check the late finish skipped the second line")
    }

    /// MUTATION (the card's): start the silence node while not running, and
    /// the session invariant goes red (an audible command with no session).
    func testStartingTheSilenceNodeWhileNotRunningBreaksTheSessionInvariant() throws {
        let data = try data()
        let id = "manager-foray/a-script-only-line-is-spoken-not-loaded"
        let red = outcome(id, mutation: .silenceWhileNotRunning, data: data)
        XCTAssertEqual(red?.outcome, .failed, red?.detail ?? "no result")
        XCTAssertEqual(outcome(id, mutation: nil, data: data)?.outcome, .passed)
        guard let testCase = (data.fixtures["manager-foray"] ?? []).flatMap(\.cases).first(where: { $0.id == id }) else {
            return XCTFail("\(id) is not recorded")
        }
        let run = try EngineScenarioDriver(mutation: .silenceWhileNotRunning, forayTape: true)
            .run(testCase, context: Codec.Context(repoRoot: data.repoRoot))
        XCTAssertTrue(run.violations.contains("audible-start:silenceStart@inactive"), "\(run.violations)")
    }

    /// Every narration, jingle and audition scenario keeps what no op log can
    /// show: the audible-start invariant on every turn (speak, interludeStart
    /// and silenceStart included), plays only on a ready deck, grace paired,
    /// and never more than one audible source (the deck, the line, the jingle).
    func testEveryNarrationScenarioKeepsTheInvariants() throws {
        let data = try data()
        let context = Codec.Context(repoRoot: data.repoRoot)
        var ran = 0
        for file in data.fixtures["manager-foray"] ?? [] where ["narration", "jingle", "audition"].contains(where: { file.path.contains($0) }) {
            for testCase in file.cases where testCase.kind == .scenario {
                let run = try EngineScenarioDriver(forayTape: true).run(testCase, context: context)
                XCTAssertEqual(run.violations, [], testCase.id)
                XCTAssertLessThanOrEqual(run.maxAudibleSources, 1, testCase.id)
                ran += 1
            }
        }
        XCTAssertGreaterThanOrEqual(ran, 54)
    }
}
