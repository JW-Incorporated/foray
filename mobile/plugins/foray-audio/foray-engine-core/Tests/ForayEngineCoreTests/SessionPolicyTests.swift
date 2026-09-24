import XCTest
import ForayEngineCore
import ForayEngineParity

/// Card NE-11s's mutations, kept as tests so they stay proved: a MUTATED
/// session table, run through the real parity suite over the real fixture
/// tree, turns named `session` cases red. Plus what no fixture reaches: the
/// Swift token enums against the generated constants, and the hold-policy
/// spelling at its edges.
///
/// The parity wrappers (ParityFamilyTests) prove the port AGREES with the JS
/// table; these prove the table would NOTICE if it stopped agreeing, which is
/// the only reason a green family means anything.
final class SessionPolicyTests: XCTestCase {
    private func report(replacing runner: PureFamilyRunner) throws -> SuiteReport {
        let data = try ParityData.load(parityDir: try ParityLocator.locate())
        var runners = ParityFamilies.all.filter { $0.family != runner.family }
        runners.append(runner)
        return ParitySuite(data: data, runners: runners).run()
    }

    private func outcome(_ id: String, in report: SuiteReport) -> CaseResult.Outcome? {
        report.results.first { $0.id == id }?.outcome
    }

    private func real(_ phase: SessionPolicy.Phase, _ input: SessionPolicy.Input,
                      _ hold: SessionPolicy.HoldPolicy) -> SessionPolicy.Transition {
        SessionPolicy.transition(from: phase, on: input, holdPolicy: hold)
    }

    /// THE CARD'S FIRST MUTATION: a pause that releases the session under the
    /// default `.forever` policy (S-4 broken: other apps are un-ducked and the
    /// car may hand audio back mid-episode). Named cases go red; the `none`
    /// arm, which really does release, stays green.
    func testADeactivateEdgeOnPauseTurnsSessionCasesRed() throws {
        let mutant = SessionFamily.makeRunner(transition: { phase, input, hold in
            if phase == .active && input == .pause {
                return SessionPolicy.Transition(phase: .inactive, actions: [.deactivate])
            }
            return self.real(phase, input, hold)
        })
        let red = try report(replacing: mutant)
        XCTAssertEqual(outcome("session/active-pause", in: red), .failed)
        XCTAssertEqual(outcome("session/active-pause-hold-until", in: red), .failed)
        XCTAssertEqual(outcome("session/active-pause-hold-none", in: red), .passed)
        XCTAssertFalse(red.ok)

        let green = try report(replacing: SessionFamily.runner)
        XCTAssertEqual(outcome("session/active-pause", in: green), .passed)
        XCTAssertTrue(green.ok, green.failures.map { "\($0.id): \($0.detail)" }.joined(separator: "\n"))
    }

    /// THE CARD'S SECOND MUTATION: notify on the relinquish edge. A lane
    /// switch would then invite the app 4a interrupted (a podcast, the car's
    /// radio) to take the audio back (§4.6), so relinquish must carry nothing.
    func testNotifyOnTheRelinquishEdgeTurnsASessionCaseRed() throws {
        let mutant = SessionFamily.makeRunner(transition: { phase, input, hold in
            if phase == .active && input == .relinquish {
                return SessionPolicy.Transition(phase: .relinquished, actions: [.deactivateNotify])
            }
            return self.real(phase, input, hold)
        })
        let red = try report(replacing: mutant)
        XCTAssertEqual(outcome("session/active-relinquish", in: red), .failed)
        XCTAssertEqual(outcome("session/active-close", in: red), .passed, "close does notify; only relinquish was mutated")
        XCTAssertFalse(red.ok)
    }

    /// The invariant's own table notices a checker that counts an activation
    /// nobody asked for (an implicit activation, which is the defect).
    func testAnUnrequestedSuccessCountedAsActiveTurnsTheInvariantRed() throws {
        let mutant = SessionInvariantFamily.makeRunner(checker: { phase, turn in
            // "Any ok result means active": a success nobody asked for counts,
            // as if a request had preceded it.
            let asked = turn.flatMap { cmd -> [String] in
                cmd == SessionPolicy.TurnMarker.resultOk ? [SessionPolicy.TurnMarker.activate, cmd] : [cmd]
            }
            return SessionPolicy.audibleStartViolations(sessionAtEntry: phase, turn: asked)
        })
        let red = try report(replacing: mutant)
        XCTAssertEqual(outcome("session-invariant/unrequested-success-does-not-count", in: red), .failed)
        XCTAssertEqual(outcome("session-invariant/activation-ok-then-play", in: red), .passed)
    }

    /// Every Swift token set is the generated JS one, in order: the enums are
    /// what an emitter spells through, so a renamed raw value must be red
    /// here even before a fixture reads it.
    func testTokensAreTheGeneratedOnes() {
        typealias C = EngineConstants.EngineContract
        XCTAssertEqual(SessionPolicy.Phase.allCases.map(\.rawValue), C.sessionPhases)
        XCTAssertEqual(SessionPolicy.InputKind.allCases.map(\.rawValue), C.sessionInputs)
        XCTAssertEqual(SessionPolicy.PlayVia.allCases.map(\.rawValue), C.playVias)
        XCTAssertEqual(SessionPolicy.Action.allCases.map(\.rawValue), C.sessionActions)
        XCTAssertEqual(SessionPolicy.Row.allCases.map(\.rawValue), C.sessionRows)
        XCTAssertEqual(SessionPolicy.HoldPolicy.kinds, C.holdPolicyKinds)
        XCTAssertEqual(SessionPolicy.HoldPolicy.default.text, C.defaultHoldPolicy)
        XCTAssertEqual(SessionPolicy.audibleCommands, C.audibleCommands)
        XCTAssertEqual(Double(EngineMode.strikeLimit), C.strikeLimit)
        XCTAssertEqual(EngineMode.Mode.allCases.map(\.rawValue), C.engineModes)
        XCTAssertEqual(EngineMode.Override.allCases.map(\.rawValue), C.modeOverrides)
        XCTAssertEqual(EngineMode.EventKind.allCases.map(\.rawValue), C.engineModeEvents)
        XCTAssertEqual(Double(EngineContract.protocolVersion), C.`protocol`)
        XCTAssertEqual(EngineContract.BridgeMethod.allCases.map(\.rawValue), C.bridgeMethods)
        XCTAssertEqual(EngineContract.CommandName.allCases.map(\.rawValue), C.commands)
        XCTAssertEqual(EngineContract.EventType.allCases.map(\.rawValue), C.events)
        XCTAssertEqual(EngineContract.Refusal.allCases.map(\.rawValue), C.refusals)
        XCTAssertEqual(EngineContract.ReadKind.allCases.map(\.rawValue), C.readKinds)
        XCTAssertEqual(EngineContract.PageMode.allCases.map(\.rawValue), C.pageModes)
        XCTAssertEqual(EngineContract.Capability.allCases.map(\.rawValue), C.capabilities)
        XCTAssertEqual(EngineContract.RelinquishCap.allCases.map(\.rawValue), C.relinquishCaps)
        XCTAssertEqual(EngineContract.SnapshotMode.allCases.map(\.rawValue), C.snapshotModes)
        XCTAssertEqual(EngineContract.PlayerState.allCases.map(\.rawValue), C.playerStates)
        XCTAssertEqual(EngineContract.Kind.allCases.map(\.rawValue), C.contractKinds)
        XCTAssertEqual(EngineContract.HandshakeReason.allCases.map(\.rawValue), C.handshakeReasons)
        XCTAssertEqual(EngineContract.ownedPrefixes, C.ownedPrefixes)
    }

    /// Every refusal a failed activation can produce is one the contract lets
    /// engineSend return; otherwise the engine would answer the page with a
    /// response the page's own validator refuses.
    func testEveryActivationFailureIsAContractRefusal() {
        for token in Vocabulary.SessionError.allCases.map(\.rawValue) + ["busy", ""] {
            let reason = SessionPolicy.sessionFailedReason(token)
            XCTAssertNotNil(EngineContract.Refusal(rawValue: reason), reason)
        }
        XCTAssertNotNil(EngineContract.Refusal(rawValue: SessionPolicy.sessionFailedReason(nil)))
    }

    /// `/^until:([1-9][0-9]{0,5})$/`, at its edges: the stored spelling
    /// round-trips, and nothing a regex would refuse is let through by
    /// Swift's looser number parsing.
    func testHoldPolicySpellingRoundTripsAndRefusesWhatThePatternRefuses() {
        for text in ["forever", "none", "until:1", "until:60", "until:999999"] {
            XCTAssertEqual(SessionPolicy.HoldPolicy(text)?.text, text)
        }
        XCTAssertEqual(SessionPolicy.HoldPolicy("until:60"), .until(minutes: 60))
        for text in ["", "until:", "until:0", "until:01", "until:1000000", "until:+5", "until:-5", "until:1.5",
                     "until: 5", "until:5 ", " forever", "Forever", "until:\u{0663}", "until:６"] {
            XCTAssertNil(SessionPolicy.HoldPolicy(text), text)
        }
    }
}

/// The contract's decoding as the bridge (NE-20) will use it: typed values
/// out, and the distinctions the parity families only see as accept / refuse.
final class ContractDecodingTests: XCTestCase {
    private func node(_ json: String) throws -> JSONNode { try JSONNode.parse(json) }

    private let idleSnapshot = """
        {"v":1,"seq":0,"capturedAtWallMs":1790000000000,"capturedAtMonotonicMs":0,"mode":"none","state":"idle",
         "running":false,"inSeamGap":false,"inInterlude":false,"buffering":false,"ended":false,"positionSec":0,
         "durationSec":null,"sourceTimeSec":null,"playheadItemId":null,"isNarrationPlayhead":false,"rate":1,
         "effectiveRate":0,"canNext":false,"canPrevious":false,"autoAdvance":true,"skippedSegments":0,
         "pendingAdvances":0,"pendingEvents":0,"session":"inactive","holdPolicy":"forever",
         "nowPlaying":{"title":"","artist":"","album":""}}
        """

    func testASendRequestDecodesToItsTypedCommand() throws {
        let relinquish = try EngineContract.SendRequest(contract: node(
            #"{"v":1,"cmdSeq":7,"cmd":"relinquish","source":"tap","args":{"cap":"foray"},"extra":"ignored"}"#))
        XCTAssertEqual(relinquish.command, .relinquish(cap: .foray))
        XCTAssertEqual(relinquish.cmdSeq, 7)
        XCTAssertEqual(relinquish.source, .tap)

        let hold = try EngineContract.SendRequest(contract: node(
            #"{"v":1,"cmdSeq":8,"cmd":"setHoldPolicy","source":"tap","args":{"policy":"until:60"}}"#))
        XCTAssertEqual(hold.command, .setHoldPolicy(.until(minutes: 60)))

        // lastEpisodeRow is kept AS SENT: the engine stores it verbatim plus updated_at (NE-10s).
        let row = #"{"id":"ep-1","title":"An Episode","show":"A Show"}"#
        let play = try EngineContract.SendRequest(contract: node(
            #"{"v":1,"cmdSeq":6,"cmd":"playEpisode","source":"tap","args":{"item":{"id":"ep-1","audio_url":"https://example.com/a.mp3"},"startSec":30,"lastEpisodeRow":"#
                + row + "}}"))
        guard case let .playEpisode(item, startSec, moved, lastEpisodeRow) = play.command else {
            return XCTFail("decoded \(play.command.name.rawValue), not playEpisode")
        }
        XCTAssertEqual(item.id, "ep-1")
        XCTAssertEqual(item.node["audio_url"], .string("https://example.com/a.mp3"))
        XCTAssertEqual(startSec, 30)
        XCTAssertNil(moved)
        XCTAssertEqual(JSWriter.stringify(lastEpisodeRow), row)
    }

    /// A required key that may be null is not an optional one: `durationSec`
    /// must be SENT (null while unknown), and `setVoice` must name a voice or
    /// say null. Codable's decodeIfPresent cannot tell these apart.
    func testARequiredNullableKeyIsToldApartFromAMissingOne() throws {
        let snapshot = try EngineContract.Snapshot(contract: node(idleSnapshot))
        XCTAssertNil(snapshot.durationSec)
        XCTAssertEqual(snapshot.mode, .nothing)
        let withoutDuration = idleSnapshot.replacingOccurrences(of: #""durationSec":null,"#, with: "")
        XCTAssertFalse(EngineContract.accepts(.snapshot, try node(withoutDuration)))

        XCTAssertTrue(EngineContract.accepts(.sendRequest, try node(
            #"{"v":1,"cmdSeq":1,"cmd":"setVoice","source":"tap","args":{"voiceId":null}}"#)))
        XCTAssertFalse(EngineContract.accepts(.sendRequest, try node(
            #"{"v":1,"cmdSeq":1,"cmd":"setVoice","source":"tap","args":{}}"#)))
    }

    /// `true` is not a number and `1` is not a boolean, on Linux as on Darwin.
    func testNumbersAndBooleansAreNeverCoerced() throws {
        XCTAssertFalse(EngineContract.accepts(.helloRequest, try node(#"{"pageBuild":"b","protocol":true}"#)))
        XCTAssertFalse(EngineContract.accepts(.sendRequest, try node(
            #"{"v":1,"cmdSeq":1,"cmd":"stop","source":"tap","args":{"persist":1}}"#)))
        XCTAssertFalse(EngineContract.accepts(.sendRequest, try node(
            #"{"v":1,"cmdSeq":1.5,"cmd":"play","source":"tap"}"#)))
        XCTAssertTrue(EngineContract.accepts(.sendRequest, try node(
            #"{"v":1.0,"cmdSeq":2.0,"cmd":"play","source":"tap"}"#)), "a whole number written with a point is still an integer")
    }

    /// NE-01's stub hello is inside the contract, and the page reads it as
    /// "run the JS player, nothing native is playing".
    func testTheStubHelloIsAValidLegacyAnswer() throws {
        var members: [JSONMember] = []
        for (key, value) in EngineHandshake.notBuiltHello().sorted(by: { $0.key < $1.key }) {
            members.append(JSONMember(key, .string(value)))
        }
        let hello = JSONNode.object(members)
        XCTAssertTrue(EngineContract.accepts(.helloResponse, hello))
        let decision = EngineContract.decidePageMode(platform: "ios", methodPresent: true, hello: hello)
        XCTAssertEqual(decision.mode, .js)
        XCTAssertEqual(decision.reason, .engineLegacy)
        XCTAssertFalse(decision.relinquish, "a clear legacy answer means nothing native is playing")
        XCTAssertEqual(EngineHandshake.protocolVersion, EngineContract.protocolVersion)
    }

    /// A refusal says where: the path is for the diagnostics row.
    func testARefusalNamesThePathThatFailed() throws {
        let refusal = EngineContract.refusal(.sendRequest, try node(
            #"{"v":1,"cmdSeq":1,"cmd":"relinquish","source":"tap","args":{"cap":"everything"}}"#))
        XCTAssertEqual(refusal?.path, "/args/cap")
        XCTAssertNil(EngineContract.refusal(.readRequest, try node(#"{"what":"snapshot"}"#)))
    }
}
