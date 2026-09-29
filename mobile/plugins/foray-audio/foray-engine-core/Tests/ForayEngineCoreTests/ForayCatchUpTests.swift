import XCTest
import ForayEngineCore

/// Card NE-37c: the rules `main` added to the JS player after `engine/m2` was
/// held for the M1 car test (audit round 3, #835; the Phase 2 narration
/// fallback, #867), ported to the engine where no parity scenario can reach
/// them: races the page's async bridge has and one synchronous turn does not
/// (a speak() in flight, a load landing after the listener moved), late
/// reports about a file the engine has already given up on, and what a
/// Foray's lock screen and car say (the M2 drive's H6).
///
/// The host is EngineCoreTests' (`Host`), with the synthesiser played by the
/// test: it answers each `speak(seq)` itself, when the case says it lands.
final class ForayCatchUpTests: XCTestCase {
    typealias Host = EngineCoreTests.Host

    static let tape = EngineConfig(build: "test", forayTapeEnabled: true)

    /// A RENDERED narration line: a file, and (unless nil) its script.
    static func rendered(_ index: Int, _ script: String? = "the line read aloud") -> EngineItem {
        var members = [JSONMember("id", .string("f1#\(index)")), JSONMember("kind", .string("tts")),
                       JSONMember("type", .string("narration")),
                       JSONMember("audio_url", .string("https://audio.test/f1-\(index).mp3")),
                       JSONMember("duration_sec", .number(4))]
        if let script { members.append(JSONMember("script", .string(script))) }
        return EngineItem(node: .object(members))!
    }

    static func line(_ index: Int, _ script: String) -> EngineItem {
        NarrationOverlayTests.line(index, script, durationSec: 4)
    }

    static func clip(_ index: Int, _ name: String, _ start: Double, _ end: Double) -> EngineItem {
        NarrationOverlayTests.clip(index, name, start, end)
    }

    static func stops(_ out: [EngineCommand]) -> [Int] {
        NarrationOverlayTests.speaks(out).compactMap { if case let .stop(seq) = $0 { return seq }; return nil }
    }

    /// A host with `items` queued as the manager's Foray and `index` asked to
    /// play; `out` is that turn's output.
    static func host(_ items: [EngineItem], at index: Int = 0, out: inout [EngineCommand]) -> Host {
        var host = Host(config: ForayCatchUpTests.tape)
        host.send(.queue(.loadForay(items, isLocalFile: false, allowAdPad: false)))
        out = host.send(.queue(.playIndex(index, startSec: nil, source: .tap)))
        return host
    }

    static func host(_ items: [EngineItem]) -> Host {
        var ignored: [EngineCommand] = []
        return host(items, out: &ignored)
    }

    /// The clip on the deck ends (its out-point or its file), in one instant.
    @discardableResult
    static func endClip(_ host: inout Host) -> [EngineCommand] {
        host.reading.audible = false
        host.reading.ended = true
        return host.send(.deck(.ended(token: host.lastLoad ?? 0)), after: 0)
    }

    // MARK: - mobile-native-2: a finish is this line's, or it is nothing

    /// queue-manager.js "a `finished` naming another utterance is stale and is
    /// dropped; this line's own advances (mobile-native-2)". Natively every
    /// answer carries the utterance's `seq`: a finish for an older or a newer
    /// one advances nothing, and the line's own finish advances it.
    /// TO SEE IT FAIL: drop `line.seq == seq` from `finishLine`.
    func testAFinishForAnotherUtteranceIsStaleAndOnlyThisLinesOwnAdvances() {
        var out: [EngineCommand] = []
        var host = ForayCatchUpTests.host([ForayCatchUpTests.line(0, "a line"), ForayCatchUpTests.clip(1, "a", 100, 200)],
                                          out: &out)
        guard let seq = NarrationOverlayTests.spokenSeq(out) else { return XCTFail("nothing spoken: \(out)") }
        host.send(.narrator(.started(seq: seq, voiceFallback: false)), after: 0)
        XCTAssertEqual(ForayTapeTests.loads(host.send(.narrator(.finished(seq: seq + 1)), after: 0)), [])
        XCTAssertEqual(ForayTapeTests.loads(host.send(.narrator(.finished(seq: seq - 1)), after: 0)), [])
        XCTAssertEqual(host.core.state.narration?.seq, seq, "the line is still the playhead")
        let own = host.send(.narrator(.finished(seq: seq)), after: 0)
        XCTAssertEqual(ForayTapeTests.loads(own), ["f1#1@100"], "its own finish advances: \(own)")
    }

    // MARK: - player-core-4 / -7: a speak() the player has left is silenced

    /// queue-manager.js "a narration load superseded while speak() is in
    /// flight stops talking over the next item (player-core-4)" and "stop()
    /// while a narration line's speak() is in flight leaves no voice behind
    /// (player-core-7)". The voice starts on accept; if the player moved on
    /// before that answer (a jump to a clip, a stop), the utterance is told to
    /// stop and nothing else moves.
    /// TO SEE IT FAIL: drop `abandonSpeech` from `narrationStarted`.
    func testASpeakThePlayerLeftIsSilencedNeverTalkingOverTheNextItem() {
        var out: [EngineCommand] = []
        var host = ForayCatchUpTests.host([ForayCatchUpTests.line(0, "a line"), ForayCatchUpTests.clip(1, "a", 100, 200)],
                                          out: &out)
        guard let seq = NarrationOverlayTests.spokenSeq(out) else { return XCTFail("nothing spoken: \(out)") }
        let jumped = host.send(.queue(.playIndex(1, startSec: nil, source: .tap)), after: 0)
        XCTAssertEqual(ForayTapeTests.loads(jumped), ["f1#1@100"])
        let late = host.send(.narrator(.started(seq: seq, voiceFallback: false)), after: 0)
        XCTAssertEqual(ForayCatchUpTests.stops(late), [seq], "the stale voice is stopped: \(late)")
        XCTAssertNil(host.core.state.narration, "a line nobody is on never becomes the playhead")
        XCTAssertEqual(host.core.state.stateType, "loadingItem")

        var first: [EngineCommand] = []
        var stopping = ForayCatchUpTests.host([ForayCatchUpTests.line(0, "a line"), ForayCatchUpTests.clip(1, "a", 100, 200)],
                                              out: &first)
        guard let pending = NarrationOverlayTests.spokenSeq(first) else { return XCTFail("nothing spoken: \(first)") }
        stopping.send(.command(.stop(persist: true), source: .tap), after: 0)
        XCTAssertEqual(stopping.core.state.stateType, "idle")
        let afterStop = stopping.send(.narrator(.started(seq: pending, voiceFallback: false)), after: 0)
        XCTAssertEqual(ForayCatchUpTests.stops(afterStop), [pending], "no voice behind a stopped player: \(afterStop)")
        XCTAssertNil(stopping.core.state.narration)
    }

    /// queue-manager.js "a stale speak() does not stop the NEWER line that
    /// replaced it (player-core-4)": when a newer speak() has been issued, the
    /// late answer for the older one stops nothing; the newer line starts.
    /// TO SEE IT FAIL: drop the `seq == state.speakSeq` guard in `abandonSpeech`.
    func testAStaleSpeakNeverStopsTheNewerLineThatReplacedIt() {
        var out: [EngineCommand] = []
        var host = ForayCatchUpTests.host([ForayCatchUpTests.line(0, "one"), ForayCatchUpTests.line(1, "two"),
                                           ForayCatchUpTests.clip(2, "a", 100, 200)], out: &out)
        guard let older = NarrationOverlayTests.spokenSeq(out) else { return XCTFail("nothing spoken: \(out)") }
        let jumped = host.send(.queue(.playIndex(1, startSec: nil, source: .tap)), after: 0)
        guard let newer = NarrationOverlayTests.spokenSeq(jumped), newer != older else { return XCTFail("\(jumped)") }
        let late = host.send(.narrator(.started(seq: older, voiceFallback: false)), after: 0)
        XCTAssertEqual(ForayCatchUpTests.stops(late), [], "the newer line is never cut off: \(late)")
        host.send(.narrator(.started(seq: newer, voiceFallback: false)), after: 0)
        XCTAssertEqual(host.core.state.narration?.seq, newer)
        XCTAssertEqual(host.core.state.narration?.itemId, "f1#1")
    }

    // MARK: - player-core-2: the listener can move during a bridge's load

    /// queue-manager.js "a pause during a rendered bridge's load is not undone
    /// when the load lands (player-core-2)" and "a stop during a rendered
    /// bridge's load leaves no audio behind a closed player (player-core-2)".
    /// TO SEE IT FAIL: drop the `stillOn` check from `onReady`.
    func testAPauseOrStopDuringARenderedBridgesLoadIsNotUndoneWhenItLands() {
        for move in ["pause", "stop"] {
            var host = ForayCatchUpTests.host([ForayCatchUpTests.clip(0, "a", 100, 200), ForayCatchUpTests.rendered(1),
                                               ForayCatchUpTests.clip(2, "b", 300, 400)])
            host.land()
            host.confirm()
            let bridge = ForayCatchUpTests.endClip(&host)
            XCTAssertEqual(ForayTapeTests.loads(bridge), ["f1#1@0"], "\(move): the rendered bridge loads: \(bridge)")
            XCTAssertEqual(host.core.state.stateType, "transitioning")
            let token = host.lastLoad ?? 0
            let command: EngineContract.Command = move == "pause" ? .pause : .stop(persist: true)
            host.send(.command(command, source: .tap), after: 0)
            let landed = host.send(.deck(.ready(token: token, landedSec: 0, prerolled: true, elapsedMs: 5)), after: 0)
            XCTAssertFalse(landed.contains(.deck(.play)), "\(move): the bridge landed for nobody and never plays: \(landed)")
            XCTAssertNotEqual(host.core.state.stateType, "transitioning", move)
        }
    }

    /// queue-manager.js "a pause while a SYNTH bridge's speak() is in flight
    /// silences the voice (player-core-2)".
    /// TO SEE IT FAIL: drop the `stillOn` check from `narrationStarted`.
    func testAPauseWhileASpokenBridgesSpeakIsInFlightSilencesTheVoice() {
        var host = ForayCatchUpTests.host([ForayCatchUpTests.clip(0, "a", 100, 200), ForayCatchUpTests.line(1, "a bridge"),
                                           ForayCatchUpTests.clip(2, "b", 300, 400)])
        host.land()
        host.confirm()
        let bridge = ForayCatchUpTests.endClip(&host)
        guard let seq = NarrationOverlayTests.spokenSeq(bridge) else { return XCTFail("the bridge was not spoken: \(bridge)") }
        host.send(.command(.pause, source: .tap), after: 0)
        XCTAssertEqual(host.core.state.stateType, "interrupted")
        let late = host.send(.narrator(.started(seq: seq, voiceFallback: false)), after: 0)
        XCTAssertEqual(ForayCatchUpTests.stops(late), [seq], "the voice that began on accept is stopped: \(late)")
        XCTAssertNil(host.core.state.narration)
        XCTAssertEqual(host.core.state.stateType, "interrupted", "and nothing else moves")
    }

    // MARK: - §14: late reports about a file already given up on

    /// queue-manager.js §14 "a LATE error from a file that timed out does not
    /// stop the line being read in its place" and "an error from the failed
    /// file while the fallback's speak() is in flight does not stop it". The
    /// spoken line rides on a FRESH token, so whatever the deck still says
    /// about the file's token names a load nobody is on.
    /// TO SEE IT FAIL: speak the fallback under the failed load's token.
    func testLateReportsAboutAFailedFileNeverStopItsSpokenLine() {
        var out: [EngineCommand] = []
        var host = ForayCatchUpTests.host([ForayCatchUpTests.rendered(0), ForayCatchUpTests.clip(1, "a", 100, 200)], out: &out)
        XCTAssertEqual(ForayTapeTests.loads(out), ["f1#0@0"])
        let fileToken = host.lastLoad ?? 0
        let fell = host.send(.deck(.deadlineExceeded(token: fileToken, afterMs: 20_000)), after: 0)
        guard let seq = NarrationOverlayTests.spokenSeq(fell) else { return XCTFail("no fallback speak: \(fell)") }
        XCTAssertEqual(NarrationOverlayTests.speaks(fell).first,
                       .speak(seq: seq, text: "the line read aloud", voiceId: nil, utteranceRate: 1))
        let inFlight = host.send(.deck(.failed(token: fileToken, message: "late")), after: 0)
        XCTAssertFalse(inFlight.contains { if case .emit(.error) = $0 { return true }; return false }, "\(inFlight)")
        XCTAssertEqual(host.core.state.stateType, "loadingItem", "the fallback is still on its way to speech")
        host.send(.narrator(.started(seq: seq, voiceFallback: false)), after: 0)
        XCTAssertEqual(host.core.state.narration?.seq, seq)
        XCTAssertEqual(host.core.state.fallbackSpokenId, "f1#0")
        let late = host.send(.deck(.failed(token: fileToken, message: "later still")), after: 0)
        XCTAssertEqual(NarrationOverlayTests.speaks(late), [], "\(late)")
        XCTAssertEqual(host.core.state.stateType, "playing")
        XCTAssertEqual(host.core.state.narration?.seq, seq, "the line being read is untouched")
    }

    /// queue-manager.js §14 "a second error while a sounding line is already
    /// falling back does not speak it twice": the file fails mid-line, the
    /// deck is paused BEFORE the script is spoken, and a second report of the
    /// same failure speaks nothing more.
    /// TO SEE IT FAIL: keep the failed file's token on the spoken line.
    func testAFileThatFailsWhileSoundingIsSpokenOnceFromItsFirstWord() {
        var host = ForayCatchUpTests.host([ForayCatchUpTests.rendered(0), ForayCatchUpTests.clip(1, "a", 100, 200)])
        host.land()
        host.confirm()
        XCTAssertEqual(host.core.state.stateType, "playing")
        let fileToken = host.lastLoad ?? 0
        let first = host.send(.deck(.failed(token: fileToken, message: "media error 2")), after: 0)
        guard let pause = first.firstIndex(of: .deck(.pause)),
              let speak = first.firstIndex(where: { if case .narration(.speak) = $0 { return true }; return false }) else {
            return XCTFail("no pause-then-speak: \(first)")
        }
        XCTAssertLessThan(pause, speak, "the deck is silenced before the voice starts")
        let second = host.send(.deck(.failed(token: fileToken, message: "media error 2")), after: 0)
        XCTAssertEqual(NarrationOverlayTests.speaks(second), [], "spoken once: \(second)")
        XCTAssertEqual(host.core.state.stateType, "playing")
    }

    /// queue-manager.js §14 "a failing load the listener has already skipped
    /// past is not spoken": its failure is a superseded load's.
    /// TO SEE IT FAIL: fall back before the `isPending || isHeld` guard.
    func testAFailingLoadTheListenerSkippedPastIsNotSpoken() {
        var host = ForayCatchUpTests.host([ForayCatchUpTests.rendered(0), ForayCatchUpTests.clip(1, "a", 100, 200),
                                           ForayCatchUpTests.clip(2, "b", 300, 400)])
        let fileToken = host.lastLoad ?? 0
        host.send(.queue(.playIndex(1, startSec: nil, source: .tap)), after: 0)
        let failed = host.send(.deck(.failed(token: fileToken, message: "missing file")), after: 0)
        XCTAssertEqual(NarrationOverlayTests.speaks(failed), [], "\(failed)")
        XCTAssertEqual(host.core.state.stateType, "loadingItem")
        XCTAssertNil(host.core.state.fallbackSpokenId)
    }

    // MARK: - player-core-1: previous after a failed Foray load

    /// transport-reconcile "‹‹ after a failed Foray load retries the clip; it
    /// never marks the Foray Played (audit round 3, player-core-1)". The clip
    /// would not load and the machine went idle; previous names the item the
    /// engine holds, so the clip reloads at its in-point instead of the
    /// reducer's "queue exhausted" `ended` (which a Foray writes as Played).
    /// TO SEE IT FAIL: send `skipToPrevious(nil)` from `idle` again.
    func testPreviousAfterAFailedForayLoadRetriesTheClipAndNeverFinishesTheForay() throws {
        var host = Host(config: ForayCatchUpTests.tape)
        let first = host.send(try EngineCoreTests.command("playForay", ForayTapeTests.forayArgs(ForayTapeTests.twoClips)))
        XCTAssertEqual(ForayTapeTests.loads(first), ["f1#0@100"])
        host.send(.deck(.failed(token: host.lastLoad ?? 0, message: "missing file")), after: 0)
        XCTAssertEqual(host.core.state.stateType, "idle", "precondition: a failed load is not the end")
        let retried = host.send(try EngineCoreTests.command("previous"))
        XCTAssertEqual(ForayTapeTests.loads(retried), ["f1#0@100"], "the failed clip is the one retried: \(retried)")
        XCTAssertNotEqual(host.core.state.stateType, "ended", "previous never finishes a Foray")
        XCTAssertFalse(host.core.state.forayFinishedWritten)
        host.land()
        host.confirm()
        XCTAssertEqual(host.core.state.stateType, "playing")
        XCTAssertEqual(host.core.state.currentIndex, 0)
    }

    // MARK: - What the lock screen and the car are told in a Foray (H6)

    /// A Foray through the contract, as the page sends it.
    private func playingForay(_ items: [JSONNode]) throws -> Host {
        var host = Host(config: ForayCatchUpTests.tape)
        host.send(try EngineCoreTests.command("playForay", ForayTapeTests.forayArgs(items)))
        host.land()
        host.confirm()
        XCTAssertEqual(host.core.state.stateType, "playing")
        return host
    }

    private static let titled: [JSONNode] = [
        ForayTapeTests.clip(0, "a", 100, 200, [JSONMember("title", .string("Fire")), JSONMember("show", .string("Origin"))]),
        NarrationOverlayTests.line(1, "a bridge", durationSec: 4).node,
        ForayTapeTests.clip(2, "b", 300, 400, [JSONMember("title", .string("Smoke")), JSONMember("show", .string("Food"))])
    ]

    /// client.js `mediaViewFields`'s Foray branch: a clip reads as its title
    /// and show with "<Foray> · clip n of N" as the album, and the progress bar
    /// is the FORAY's (its runtime, and the playhead on it); a spoken line
    /// reads "Up next: <the next clip>" credited to the Foray, never "4a".
    /// TO SEE IT FAIL: describe a Foray with the episode view (M2 did).
    func testTheLockScreenDescribesAForayAsAForay() throws {
        var host = try playingForay(ForayCatchUpTests.titled)
        host.reading.positionSec = 150
        let clip = MediaMapping.sessionView(try XCTUnwrap(host.core.mediaView(deck: host.reading, monoMs: host.monoMs)))
        XCTAssertEqual(clip.metadata.title, "Fire")
        XCTAssertEqual(clip.metadata.artist, "Origin")
        XCTAssertEqual(clip.metadata.album, "A Foray · clip 1 of 3")
        let bar = try XCTUnwrap(clip.positionState)
        XCTAssertEqual(bar.position, 50, "50 s into the first clip is 50 s into the Foray")
        XCTAssertEqual(bar.duration, 100 + 4 + 100, "the Foray's runtime, not the clip's")
        XCTAssertEqual(bar.playbackRate, 1)

        let bridge = ForayCatchUpTests.endClip(&host)
        guard let seq = NarrationOverlayTests.spokenSeq(bridge) else { return XCTFail("\(bridge)") }
        host.send(.narrator(.started(seq: seq, voiceFallback: false)), after: 0)
        let line = MediaMapping.sessionView(try XCTUnwrap(host.core.mediaView(deck: host.reading, monoMs: host.monoMs + 2000)))
        XCTAssertEqual(line.metadata.title, "Up next: Smoke")
        XCTAssertEqual(line.metadata.artist, "A Foray", "a line is credited to the Foray, never 4a")
        XCTAssertEqual(line.playbackState, MediaMapping.playing)
        let lineBar = try XCTUnwrap(line.positionState)
        XCTAssertEqual(lineBar.position, 102, "two seconds into the line that starts at 100 s")
        XCTAssertEqual(lineBar.playbackRate, 1, "a SOUNDING line counts on; it is not a load (rate 0)")
    }

    // MARK: - #866 in a Foray: the stall latch is per item

    /// The rate-0 latch (#866, the 2026-09-28 paste): `buffering` is set by a
    /// stall and cleared only by that deck's `.playing`. In a Foray the next
    /// item (a spoken line, or the next clip's load) would never send it, so
    /// the whole next line published rate 0 and the car stopped its clock.
    /// The latch now ends with its item.
    /// TO SEE IT FAIL: drop `clearStallLatch()` from `itemEnded`.
    func testAStallNearAClipsEndDoesNotLatchTheNextLineAtRateZero() throws {
        var host = try playingForay(ForayCatchUpTests.titled)
        host.send(.deck(.stalled(token: host.lastLoad ?? 0)), after: 0)
        XCTAssertTrue(host.core.state.buffering, "precondition: the clip stalled")
        let bridge = ForayCatchUpTests.endClip(&host)
        guard let seq = NarrationOverlayTests.spokenSeq(bridge) else { return XCTFail("\(bridge)") }
        XCTAssertFalse(host.core.state.buffering, "the stall ended with its clip")
        host.send(.narrator(.started(seq: seq, voiceFallback: false)), after: 0)
        let view = try XCTUnwrap(host.core.mediaView(deck: host.reading, monoMs: host.monoMs))
        XCTAssertFalse(view.buffering, "the spoken line publishes its rate, not 0")
    }

    /// A stall on one load never outlives the next load landing.
    /// TO SEE IT FAIL: drop `clearStallLatch()` from `onReady`.
    func testANewLoadLandingClearsTheLastLoadsStall() {
        var host = ForayCatchUpTests.host([ForayCatchUpTests.clip(0, "a", 100, 200), ForayCatchUpTests.clip(1, "b", 300, 400)])
        host.land()
        host.confirm()
        host.send(.deck(.stalled(token: host.lastLoad ?? 0)), after: 0)
        XCTAssertTrue(host.core.state.buffering)
        host.send(.queue(.playIndex(1, startSec: nil, source: .tap)), after: 0)
        host.land()
        XCTAssertFalse(host.core.state.buffering, "the new clip's own reports decide")
    }
}
