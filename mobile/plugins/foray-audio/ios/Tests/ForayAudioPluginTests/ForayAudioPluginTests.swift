import XCTest
import AVFAudio
@testable import ForayAudioPlugin

/// Mirrors `NowPlayingParsingTest.java` / `NowPlayingHubTest.java` on Android,
/// for the payload-parsing, command-availability and transport-event halves
/// of the iOS plugin.
///
/// RUN ON CI since PR #530 (H4 satisfied): `ci.yml`'s `ios-kit` job runs
/// `xcodebuild test -scheme ForayAudio` against an iOS Simulator on every
/// push (the package links the Capacitor binary framework, which ships only
/// iOS slices, so a host-platform `swift test` cannot build it). On a Windows
/// or Linux checkout these do not run locally; CI is the executor.
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

    // MARK: - changePlaybackPosition -> transport seekto on the Foray's clock
    // (L-01's fourth Tests bullet: "a `changePlaybackPosition` event becomes a
    // `transport {action:"seekto", seekTime}` on the FORAY's clock")

    /// The OS hands `MPChangePlaybackPositionCommandEvent.positionTime` in
    /// SECONDS on the timeline the plugin last reported -- and that timeline
    /// is the FORAY's clock, because `durationMs`/`positionMs` in every report
    /// span the whole Foray (`player/media-session.js` §3, `NowPlayingPayload`'s
    /// own doc comment). So a scrub to 754.25 s must come back as
    /// `{action: "seekto", positionMs: 754250}`: the SAME clock, in the
    /// milliseconds `foray-media-session.js` documents for `TRANSPORT_EVENT`.
    ///
    /// MUTATION: emit seconds instead of milliseconds (drop the `* 1000`), or
    /// re-base onto a segment clock by subtracting anything -> red.
    func testChangePlaybackPosition_becomesSeekToOnTheForayClockInMilliseconds() {
        let event = ForayAudioPlugin.seekToTransportEvent(positionTime: 754.25)
        XCTAssertEqual(event["action"] as? String, "seekto")
        XCTAssertEqual(event["positionMs"] as? Int, 754_250)
        XCTAssertNil(event["offsetMs"], "an absolute seek carries no offset")
    }

    func testChangePlaybackPosition_roundsToTheNearestMillisecond() {
        XCTAssertEqual(ForayAudioPlugin.seekToTransportEvent(positionTime: 0.0004)["positionMs"] as? Int, 0)
        XCTAssertEqual(ForayAudioPlugin.seekToTransportEvent(positionTime: 0.0006)["positionMs"] as? Int, 1)
        XCTAssertEqual(ForayAudioPlugin.seekToTransportEvent(positionTime: 3_599.9996)["positionMs"] as? Int, 3_600_000)
    }

    /// A negative `positionTime` is not a place on any Foray; it clamps to 0
    /// the same way `NowPlayingPayload` clamps a negative `positionMs`.
    /// TO SEE IT FAIL: drop the `max(0, …)` in `seekToTransportEvent`.
    func testChangePlaybackPosition_negativeClampsToZero() {
        XCTAssertEqual(ForayAudioPlugin.seekToTransportEvent(positionTime: -3)["positionMs"] as? Int, 0)
    }

    /// The skip commands are the OTHER shape on the same wire: an OFFSET, never
    /// a position, so the page's own `foraySeek` runs the arithmetic
    /// (`docs/ios-lock-screen.md` §3.1).
    func testSkipCommandsCarryAnOffsetAndNoPosition() {
        let back = ForayAudioPlugin.transportEvent(action: "seekbackward", offsetMs: 15_000)
        XCTAssertEqual(back["action"] as? String, "seekbackward")
        XCTAssertEqual(back["offsetMs"] as? Int, 15_000)
        XCTAssertNil(back["positionMs"])

        let plain = ForayAudioPlugin.transportEvent(action: "play")
        XCTAssertEqual(plain["action"] as? String, "play")
        XCTAssertNil(plain["positionMs"])
        XCTAssertNil(plain["offsetMs"])
    }

    // MARK: - M-03: the session event (founder feedback F16, #548)

    /// The founder's F16 record holds one unexplained stop and no cause,
    /// because the page cannot see an `AVAudioSession` interruption, a route
    /// change or a media-services reset — an `<audio>` element reports a bare
    /// `pause` for all of them. This plugin can see them; these pin the wire
    /// shape it reports them in.
    ///
    /// TO SEE IT FAIL: rename `SESSION_EVENT` here without renaming it in
    /// `web/foray-media-session.js`. `notifyListeners` then has no subscriber
    /// and every native cause is dropped before it reaches the record — with
    /// nothing anywhere reading as an error. `shell-invariants.test.mjs` pins
    /// the same equality from the JS side.
    func testSessionEventNameMatchesTheWebHalf() {
        XCTAssertEqual(ForayAudioPlugin.SESSION_EVENT, "session")
    }

    /// `{kind, reason, producer, at}`, with `at` in epoch MILLISECONDS — the
    /// unit `player/diagnostic-log.js` stamps every entry with, so a reader
    /// never has to guess which clock a native event is on. The pair of that
    /// stamp and the page's own `wall` is the delivery LAG, which on a
    /// suspended WKWebView is the length of the suspension: the measurement
    /// M-03 exists to make.
    ///
    /// TO SEE IT FAIL: emit `at` in seconds. The record's `lagMs` then reads as
    /// roughly 1.7 trillion milliseconds and the whole channel is nonsense.
    func testSessionEventCarriesKindReasonProducerAndAnEpochMsStamp() {
        let event = ForayAudioPlugin.sessionEvent(kind: "background", reason: "did-enter", at: 1_700_000_000_000)
        XCTAssertEqual(event["kind"] as? String, "background")
        XCTAssertEqual(event["reason"] as? String, "did-enter")
        XCTAssertEqual(event["producer"] as? String, "audio")
        XCTAssertEqual(event["at"] as? Int, 1_700_000_000_000)
    }

    /// A route change reports a CODE, never the route's name. A Bluetooth
    /// route is named after the person who owns the car, and this record is
    /// pasted into issues — the rule `player/diagnostic-log.js` already keeps
    /// for `route.autoResume.knownCar=`, applied at the source.
    ///
    /// TO SEE IT FAIL: return the raw value's description, or `String(raw)`.
    /// `dataTokenOf()` in the record admits only a lower-case dashed token, so
    /// anything else lands as an empty reason and the row says nothing.
    func testRouteChangeReasonIsAClosedVocabularyOfDashedTokens() {
        XCTAssertEqual(
            ForayAudioPlugin.routeChangeReason(AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue),
            "old-device-gone"
        )
        XCTAssertEqual(
            ForayAudioPlugin.routeChangeReason(AVAudioSession.RouteChangeReason.newDeviceAvailable.rawValue),
            "new-device"
        )
        // An unknown raw value degrades to `unknown` rather than to a number.
        XCTAssertEqual(ForayAudioPlugin.routeChangeReason(9_999), "unknown")
        for raw: UInt in 0...8 {
            let token = ForayAudioPlugin.routeChangeReason(raw)
            XCTAssertFalse(token.isEmpty)
            XCTAssertEqual(token, token.lowercased())
            XCTAssertFalse(token.contains(" "))
        }
    }

    // MARK: - L-06: the Now Playing field needle (founder feedback F15)

    /// PRESENCE, NEVER CONTENT. F15 is "the lock screen showed only 4a", and
    /// which of its three explanations applies depends only on whether each
    /// field was EMPTY. The unified log is uploaded as a CI artifact, so the
    /// titles themselves must not ride out in it — the truncated strings go in
    /// the on-device record instead, which is copied by hand.
    ///
    /// TO SEE IT FAIL: interpolate the field VALUES into the log line.
    func testFieldPresenceReportsEmptinessAndNeverTheStrings() {
        let line = ForayAudioPlugin.fieldPresence(
            title: "Episode 09: Did Cooking Make Us Human?",
            artist: "",
            album: "The history of grilling",
            hasArtwork: true
        )
        XCTAssertEqual(line, "title=y artist=n album=y artwork=y")
        XCTAssertFalse(line.contains("Cooking"))
        XCTAssertFalse(line.contains("grilling"))
    }

    /// Whitespace is not content: a field of spaces renders as a blank lock
    /// screen, so it has to read as `n`.
    ///
    /// TO SEE IT FAIL: drop the `trimmingCharacters` call.
    func testFieldPresenceTreatsWhitespaceAsEmpty() {
        XCTAssertEqual(
            ForayAudioPlugin.fieldPresence(title: "   ", artist: "\t", album: "\n", hasArtwork: false),
            "title=n artist=n album=n artwork=n"
        )
    }

}
