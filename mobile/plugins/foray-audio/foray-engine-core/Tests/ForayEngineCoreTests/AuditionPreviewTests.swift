import XCTest
import ForayEngineCore

/// Card NE-47 (docs/native-engine-plan.md; Spark §3.3): the voice picker's
/// preview plays the voice's RENDERED `preview.m4a` on the engine.
///
///   - An audition that carries a `url` loads it on the PREVIEW deck (never
///     the main one) and plays it when the load lands, under the tap's own
///     activation: one `.sessionActivate`, none for the play.
///   - It is refused `engine-busy` while running, as a spoken one is.
///   - A preview that will not load (a 404, a dead host, its deadline) is
///     spoken instead, in the voice the page resolved.
///   - An audition with no `url` is spoken, exactly as before the card.
///
/// The fixtures (`manager-foray/audition-url-*`, `contract/send-request-*-
/// audition-*`) hold the same rules against the JS reference; these hold
/// what no op log shows: the tokens, the activation count, the session
/// guard and the main deck left alone.
final class AuditionPreviewTests: XCTestCase {
    static let url = "https://audio.jwlabs.ai/n/kokoro-fp32-aac64-v1/af_heart/preview.m4a"

    static func audition(_ text: String = "This is how I sound", voiceId: String? = nil,
                         url: String? = AuditionPreviewTests.url) throws -> EngineInput {
        var args = [JSONMember("text", .string(text)), JSONMember("voiceId", voiceId.map { JSONNode.string($0) } ?? .null)]
        if let url { args.append(JSONMember("url", .string(url))) }
        return try EngineCoreTests.command("audition", .object(args), source: "audition")
    }

    static func previews(_ out: [EngineCommand]) -> [DeckCommand] {
        out.compactMap { if case let .preview(command) = $0 { return command }; return nil }
    }

    static func deckCommands(_ out: [EngineCommand]) -> [DeckCommand] {
        out.compactMap { if case let .deck(command) = $0 { return command }; return nil }
    }

    static func speaks(_ out: [EngineCommand]) -> [EngineCommand] {
        out.filter { if case .speak = $0 { return true }; return false }
    }

    static func activations(_ out: [EngineCommand]) -> Int {
        out.filter { if case .sessionActivate = $0 { return true }; return false }.count
    }

    /// Episode "a" playing, confirmed audible (EngineCoreTests `playing`).
    static func playing() -> EngineCoreTests.Host {
        var host = EngineCoreTests.Host()
        host.send(.queue(.load([EngineCoreTests.item("a")])))
        host.send(.queue(.playIndex(0, startSec: nil, source: .tap)))
        host.land()
        host.confirm()
        return host
    }

    static func ready(_ token: DeckToken) -> EngineInput {
        .preview(.ready(token: token, landedSec: 0, prerolled: true, elapsedMs: 40))
    }

    /// The contract decodes the url only on the narration host.
    /// TO SEE IT FAIL: read `url` with `R.string`, or drop it from the decode.
    func testTheURLIsDecodedOnlyOnTheNarrationHost() throws {
        guard case let .command(command, _) = try Self.audition() else { return XCTFail("not a command") }
        XCTAssertEqual(command, .audition(text: "This is how I sound", voiceId: nil, url: Self.url))
        guard case let .command(spoken, _) = try Self.audition(url: nil) else { return XCTFail("not a command") }
        XCTAssertEqual(spoken, .audition(text: "This is how I sound", voiceId: nil, url: nil))
        for bad in ["http://audio.jwlabs.ai/preview.m4a", "https://cdn.example.com/preview.m4a",
                    Self.url + "?token=abc", Self.url + "#t=1", "https://audio.jwlabs.ai.evil.example/p.m4a",
                    "https://user:pw@audio.jwlabs.ai/p.m4a", "https://audio.jwlabs.ai:8443/p.m4a",
                    "https://audio.jwlabs.ai/", "https://audio.jwlabs.ai/a b.m4a", "https://audio.jwlabs.ai/%2e.m4a",
                    "https://audio.jwlabs.ai/caf\u{E9}.m4a", ""] {
            XCTAssertThrowsError(try Self.audition(url: bad), bad)
        }
    }

    /// A url audition loads on the PREVIEW deck, activates once, and plays
    /// when the load is ready, with nothing spoken and the main deck untouched.
    /// TO SEE IT FAIL: send the load as a `.deck` command, play in the same
    /// turn as the load, or ask for a second activation before the play.
    func testAURLAuditionLoadsOnThePreviewDeckAndActivatesOnce() throws {
        var host = EngineCoreTests.Host()
        let out = host.send(try Self.audition())
        XCTAssertEqual(Self.activations(out), 1, "\(out)")
        let token = try XCTUnwrap(host.core.state.preview?.token)
        XCTAssertEqual(Self.previews(out), [.load(token: token, itemId: EngineCore.previewItemId, url: Self.url,
                                                  startSec: 0, preciseTiming: false)])
        XCTAssertEqual(Self.deckCommands(out), [], "the main deck is not the preview's")
        XCTAssertEqual(Self.speaks(out), [], "a rendered preview is not spoken")
        XCTAssertEqual(host.core.state.session, .active)
        let activate = try XCTUnwrap(out.firstIndex { if case .sessionActivate = $0 { return true }; return false })
        let load = try XCTUnwrap(out.firstIndex { if case .preview(.load) = $0 { return true }; return false })
        XCTAssertLessThan(activate, load, "the activation comes first")

        let played = host.send(Self.ready(token))
        XCTAssertEqual(Self.previews(played), [.play])
        XCTAssertEqual(Self.activations(played), 0, "the tap's own activation covers the play")
        XCTAssertEqual(host.core.state.preview?.playing, true)
        XCTAssertEqual(host.core.state.stateType, "idle", "a preview is not a play of the queue")

        // A second ready (a duplicate report) plays nothing twice; the end clears it.
        XCTAssertEqual(Self.previews(host.send(Self.ready(token))), [])
        host.send(.preview(.ended(token: token)))
        XCTAssertNil(host.core.state.preview)
    }

    /// Refused while running, exactly as a spoken audition is: nothing loads.
    /// TO SEE IT FAIL: check `isRunning` only for a spoken audition.
    func testAURLAuditionIsRefusedWhileRunning() throws {
        var host = Self.playing()
        XCTAssertEqual(host.core.state.stateType, "playing")
        let out = host.send(try Self.audition())
        XCTAssertTrue(out.contains(.commandFailed(reason: "engine-busy")), "\(out)")
        XCTAssertEqual(Self.previews(out), [])
        XCTAssertEqual(Self.speaks(out), [])
        XCTAssertNil(host.core.state.preview)
    }

    /// A 404 (the deck's `.failed`) and a load past its deadline are both
    /// spoken instead, in the voice the page resolved; a stale token's
    /// failure is nobody's.
    /// TO SEE IT FAIL: drop `previewFailed`'s `.speak`, or answer a failure
    /// for any token.
    func testAPreviewThatWillNotLoadIsSpoken() throws {
        var host = EngineCoreTests.Host()
        host.send(try Self.audition(voiceId: "com.apple.voice.compact.en-US.Samantha"))
        let first = try XCTUnwrap(host.core.state.preview?.token)
        XCTAssertEqual(host.send(.preview(.failed(token: first + 99, message: "404"))).filter {
            if case .speak = $0 { return true }; return false }, [], "a stale failure is dropped")
        let failed = host.send(.preview(.failed(token: first, message: "HTTP 404")))
        XCTAssertEqual(Self.speaks(failed), [.speak(text: "This is how I sound", voiceId: "com.apple.voice.compact.en-US.Samantha")])
        XCTAssertEqual(Self.activations(failed), 0)
        XCTAssertNil(host.core.state.preview)

        host.send(try Self.audition())
        let second = try XCTUnwrap(host.core.state.preview?.token)
        XCTAssertNotEqual(second, first)
        let late = host.send(.preview(.deadlineExceeded(token: second, afterMs: 6000)))
        XCTAssertEqual(Self.speaks(late), [.speak(text: "This is how I sound", voiceId: nil)])
        // The failed load's own late ready plays nothing.
        XCTAssertEqual(Self.previews(host.send(Self.ready(second))), [])
    }

    /// An audition with no url is the audition as it always was: one
    /// activation, then the line spoken, and the preview deck never hears of it.
    /// TO SEE IT FAIL: load a preview for every audition, or drop the speak.
    func testANoURLAuditionIsSpokenExactlyAsBefore() throws {
        var host = EngineCoreTests.Host()
        let out = host.send(try Self.audition(voiceId: "voice-a", url: nil))
        XCTAssertEqual(Self.previews(out), [])
        XCTAssertEqual(Self.speaks(out), [.speak(text: "This is how I sound", voiceId: "voice-a")])
        XCTAssertEqual(Self.activations(out), 1)
        XCTAssertNil(host.core.state.preview)
        XCTAssertEqual(host.core.state.lastPreviewToken, 0)
        // The same audition built without the url argument is the same input.
        XCTAssertEqual(try Self.audition(voiceId: "voice-a", url: nil),
                       .command(.audition(text: "This is how I sound", voiceId: "voice-a"), source: .audition))
    }

    /// A preview while PAUSED mid-episode leaves the main deck exactly as it
    /// was, and the play that follows cuts the preview before it loads.
    /// TO SEE IT FAIL: play the preview on `.deck`, or skip `stopPreview` in
    /// `begin`.
    func testAPreviewWhilePausedLeavesTheMainDeckAloneAndThePlayCutsIt() throws {
        var host = Self.playing()
        host.send(.command(.pause, source: .tap))
        XCTAssertEqual(host.core.state.stateType, "interrupted")
        let out = host.send(try Self.audition())
        XCTAssertEqual(Self.deckCommands(out), [], "\(out)")
        let token = try XCTUnwrap(host.core.state.preview?.token)
        XCTAssertEqual(Self.previews(host.send(Self.ready(token))), [.play])

        let resumed = host.send(.command(.play, source: .tap))
        let unload = try XCTUnwrap(resumed.firstIndex(of: .preview(.unload)), "\(resumed)")
        if let deck = resumed.firstIndex(where: { if case .deck = $0 { return true }; return false }) {
            XCTAssertLessThan(unload, deck, "the preview stops before the main deck moves")
        }
        XCTAssertNil(host.core.state.preview)
        // Its late end is nobody's.
        XCTAssertEqual(Self.previews(host.send(.preview(.ended(token: token)))), [])
    }

    /// The session taken between the load and its ready (a call): the
    /// preview is dropped, never played on a session nobody re-activated.
    /// TO SEE IT FAIL: drop the `session == .active` guard in `onPreview`.
    func testAPreviewReadyAfterTheSessionWasTakenIsDropped() throws {
        var host = EngineCoreTests.Host()
        host.send(try Self.audition())
        let token = try XCTUnwrap(host.core.state.preview?.token)
        host.send(.session(.interruptionBegan(reason: "default")))
        XCTAssertNotEqual(host.core.state.session, .active)
        let out = host.send(Self.ready(token))
        XCTAssertEqual(Self.previews(out), [.unload])
        XCTAssertEqual(Self.speaks(out), [])
        XCTAssertNil(host.core.state.preview)
    }

    /// A stop, a relinquish and the engine's teardown each cut a preview in
    /// flight; with none in flight they send the preview deck nothing.
    func testStopRelinquishAndTeardownCutThePreview() throws {
        for input in [EngineInput.command(.stop(persist: true), source: .tap),
                      .command(.relinquish(cap: .all), source: .tap),
                      .lifecycle(.teardown)] {
            var idle = EngineCoreTests.Host()
            XCTAssertEqual(Self.previews(idle.send(input)), [], "\(input) with no preview")

            var host = EngineCoreTests.Host()
            host.send(try Self.audition())
            XCTAssertNotNil(host.core.state.preview)
            XCTAssertEqual(Self.previews(host.send(input)), [.unload], "\(input)")
            XCTAssertNil(host.core.state.preview)
        }
    }

    /// The invariant reads a preview's play as audible (`deckPlay`) and its
    /// load and unload as silent, so the audible-start rule covers it.
    func testThePreviewPlayIsAudibleToTheInvariant() {
        XCTAssertEqual(EngineCommand.preview(.play).turnName, "deckPlay")
        XCTAssertEqual(EngineCommand.preview(.load(token: 1, itemId: "x", url: Self.url, startSec: 0,
                                                   preciseTiming: false)).turnName, "previewLoad")
        XCTAssertEqual(EngineCommand.preview(.unload).turnName, "previewUnload")
        XCTAssertEqual(SessionPolicy.audibleStartViolations(sessionAtEntry: .inactive, turn: ["deckPlay"]).count, 1)
    }
}
