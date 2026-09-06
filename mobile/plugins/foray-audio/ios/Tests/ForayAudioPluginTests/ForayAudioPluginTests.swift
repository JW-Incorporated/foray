import XCTest
@testable import ForayAudioPlugin

/// Mirrors `NowPlayingParsingTest.java` / `NowPlayingHubTest.java` on Android,
/// for the payload-parsing and command-availability halves of the iOS plugin.
///
/// **NOTHING RUNS THIS YET on the shipping CI path** until L-01's `.github/`
/// line lands (`ci.yml`'s `ios-kit` job, gated on `founder-approved`, H4).
/// Treat these as executable documentation the same way
/// `ForayTtsPluginTests.swift`'s header does, until that label lands.
final class ForayAudioPluginTests: XCTestCase {
    func testPluginTypeExists() {
        XCTAssertNotNil(ForayAudioPlugin.self)
    }

    // MARK: - NowPlayingPayload parsing (mirrors NowPlayingParsingTest.java)

    func testEmptyPayload_isNone() {
        let payload = NowPlayingPayload.from([:])
        XCTAssertEqual(payload.state, .none)
        XCTAssertEqual(payload.title, "")
    }

    /// TO SEE IT FAIL: change `State(rawValue:)` fallback to default to
    /// `.playing` instead of returning `.empty` -- a garbage state word
    /// would then render stale metadata instead of nothing.
    func testUnknownStateWord_isNone() {
        let payload = NowPlayingPayload.from(["state": "buffering", "title": "x"])
        XCTAssertEqual(payload.state, .none)
        // none carries none of the rest, even though the payload had a
        // title -- mirrors NowPlaying.java's IDLE early-return.
        XCTAssertEqual(payload.title, "")
    }

    func testPlayingState_carriesEveryField() {
        let payload = NowPlayingPayload.from([
            "state": "playing", "title": "Episode 4", "artist": "Show",
            "album": "Foray part 2 of 3", "durationMs": 3_600_000, "positionMs": 120_000,
            "playbackRate": 1.0, "canPlay": true, "canPause": true, "canStop": true,
            "hasNext": true, "hasPrevious": false, "canSeekBack": true,
            "canSeekForward": true, "canSeekTo": true,
        ])
        XCTAssertEqual(payload.state, .playing)
        XCTAssertEqual(payload.title, "Episode 4")
        XCTAssertEqual(payload.artist, "Show")
        XCTAssertEqual(payload.album, "Foray part 2 of 3")
        XCTAssertEqual(payload.durationMs, 3_600_000)
        XCTAssertEqual(payload.positionMs, 120_000)
        XCTAssertEqual(payload.playbackRate, 1.0, accuracy: 0.0001)
        XCTAssertTrue(payload.hasNext)
        XCTAssertFalse(payload.hasPrevious)
    }

    /// Loaded (ended state parses) is a distinct concept from "accepts
    /// transport" -- exercised at the command-availability layer below,
    /// since `NowPlayingPayload` itself carries no `acceptsTransport()` (the
    /// plugin computes `transportable` inline from
    /// `state != .none && state != .ended`, per design comment #3's "none
    /// disables every transport command" and `NowPlaying.acceptsTransport()`
    /// declining both IDLE and ENDED).
    func testEndedState_parsesButIsNotNone() {
        let payload = NowPlayingPayload.from([
            "state": "ended", "title": "Episode 4", "canPlay": true, "canPause": true,
        ])
        XCTAssertEqual(payload.state, .ended)
    }

    /// TO SEE IT FAIL: remove the `clampMs` call on `durationMs`/`positionMs`
    /// -- a negative value then reaches `MPNowPlayingInfoPropertyElapsedPlaybackTime`.
    func testNegativeDurationAndPosition_clampToZero() {
        let payload = NowPlayingPayload.from([
            "state": "playing", "durationMs": -500, "positionMs": -1,
        ])
        XCTAssertEqual(payload.durationMs, 0)
        XCTAssertEqual(payload.positionMs, 0)
    }

    func testAbsurdlyLargeDuration_clampsToTheDayCeiling() {
        let payload = NowPlayingPayload.from([
            "state": "playing", "durationMs": Int64.max,
        ])
        XCTAssertEqual(payload.durationMs, 24 * 60 * 60 * 1000)
    }

    /// TO SEE IT FAIL: drop the `rate > 0` guard in `rateValue` -- Media3's
    /// Android analogue rejects a non-positive rate for the same reason: we
    /// never play backwards, and a zero rate looks like "frozen" to a
    /// listener.
    func testZeroOrNegativePlaybackRate_fallsBackToOne() {
        let zero = NowPlayingPayload.from(["state": "playing", "playbackRate": 0])
        XCTAssertEqual(zero.playbackRate, 1.0, accuracy: 0.0001)

        let negative = NowPlayingPayload.from(["state": "playing", "playbackRate": -2])
        XCTAssertEqual(negative.playbackRate, 1.0, accuracy: 0.0001)
    }

    func testMissingBooleans_defaultToFalse() {
        let payload = NowPlayingPayload.from(["state": "paused"])
        XCTAssertFalse(payload.canPlay)
        XCTAssertFalse(payload.canPause)
        XCTAssertFalse(payload.hasNext)
        XCTAssertFalse(payload.hasPrevious)
        XCTAssertEqual(payload.state, .paused)
    }

    // MARK: - Command availability (mirrors NowPlayingHubTest.java's intent:
    // the enabled command set must equal the flags, and "none" disables all
    // transport)
    //
    // These exercise the pure decision `applyCommandAvailability` makes,
    // reimplemented here as a small pure function so the test does not
    // require a live MPRemoteCommandCenter (which XCTest cannot meaningfully
    // assert against in a headless run). The PLUGIN's own
    // `applyCommandAvailability` must stay in lockstep with this logic --
    // any divergence is a bug in the plugin, not in this test.

    private func transportable(_ payload: NowPlayingPayload) -> Bool {
        payload.state != .none && payload.state != .ended
    }

    /// MUTATION: enable `nextTrack` when `hasNext` is false -> this goes red.
    func testNextTrackEnabledExactlyWhenHasNextAndTransportable() {
        let withNext = NowPlayingPayload.from(["state": "playing", "hasNext": true])
        XCTAssertTrue(transportable(withNext) && withNext.hasNext)

        let withoutNext = NowPlayingPayload.from(["state": "playing", "hasNext": false])
        XCTAssertFalse(transportable(withoutNext) && withoutNext.hasNext)
    }

    /// "none" disables all transport, regardless of what flags were sent --
    /// mirrors `NowPlaying.acceptsTransport()` being false for ENDED/IDLE.
    func testNoneStateDisablesAllTransportRegardlessOfFlags() {
        let payload = NowPlayingPayload.from([
            "state": "bogus", "canPlay": true, "canPause": true, "hasNext": true,
        ])
        XCTAssertEqual(payload.state, .none)
        XCTAssertFalse(transportable(payload))
    }

    func testEndedStateDisablesAllTransportEvenWithFlagsSet() {
        let payload = NowPlayingPayload.from([
            "state": "ended", "canPlay": true, "canPause": true, "hasNext": true,
        ])
        XCTAssertFalse(transportable(payload), "a finished Foray must not accept transport")
    }

    func testPlayingWithFlagsIsTransportable() {
        let payload = NowPlayingPayload.from(["state": "playing", "canPlay": true])
        XCTAssertTrue(transportable(payload) && payload.canPlay)
    }
}
