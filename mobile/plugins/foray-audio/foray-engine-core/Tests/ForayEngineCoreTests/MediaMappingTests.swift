import XCTest
import ForayEngineCore
import ForayEngineParity

/// `MediaMapping` beyond what the `media-episode` fixtures already pin
/// (card NE-12s). The fixtures are the contract with player/media-session.js
/// and run through `ParityFamilyTests.testMediaEpisodeFamily`; this file holds
/// the two things no fixture can:
///
/// 1. `commandAvailability(snapshot)` (NP-5), which has no JavaScript twin:
///    the page expresses it as `episodeMediaSurface` plus
///    `EPISODE_NAVIGATION`, and native mode replaces that wiring. So its truth
///    table is written out here, every snapshot the M1 engine can be in.
/// 2. Proof the fixtures would CATCH the card's mutation ("enable next when
///    canNext is false"): a mutant enablement table is handed to the real
///    fixture run and a named case must go red.
///
/// Plus a handful of JavaScript-semantics edges the port was written against
/// (UTF-16 prefixes, U+FEFF trimming, the counter past 1e21). Each expected
/// value below was read off `node` running media-session.js, not reasoned.
final class MediaMappingTests: XCTestCase {
    typealias Snapshot = MediaMapping.CommandSnapshot
    typealias Command = MediaMapping.RemoteCommand

    // MARK: - the vocabulary and the seek pair come from the generated file

    func testActionsAreDeclaredInTheGeneratedInstallOrder() {
        XCTAssertEqual(MediaAction.allCases.map(\.rawValue), EngineConstants.MediaSession.mediaActions)
    }

    func testTheSeekPairIsTheGeneratedOneEverywhere() {
        XCTAssertEqual(MediaMapping.seekBackwardSec, EngineConstants.MediaSession.seekBackwardSec)
        XCTAssertEqual(MediaMapping.seekForwardSec, EngineConstants.MediaSession.seekForwardSec)
        let steps = MediaMapping.SeekSteps()
        XCTAssertEqual(MediaMapping.intent(for: .seekBackward, steps: steps), .seekBy(-EngineConstants.MediaSession.seekBackwardSec))
        XCTAssertEqual(MediaMapping.intent(for: .seekForward, steps: steps), .seekBy(EngineConstants.MediaSession.seekForwardSec))
        let availability = MediaMapping.commandAvailability(Snapshot(mode: .episode))
        XCTAssertEqual(availability.skipBackwardIntervalSec, EngineConstants.MediaSession.seekBackwardSec)
        XCTAssertEqual(availability.skipForwardIntervalSec, EngineConstants.MediaSession.seekForwardSec)
    }

    // MARK: - commandAvailability (NP-5)

    /// Every mode x ended x canNext x canPrevious x autoAdvance, against the
    /// rule as the card states it, written independently of the port.
    func testCommandAvailabilityTruthTable() {
        let modes: [Snapshot.Mode] = [.unloaded, .episode, .foray]
        for mode in modes {
            for ended in [false, true] {
                for canNext in [false, true] {
                    for canPrevious in [false, true] {
                        for autoAdvance in [false, true] {
                            let snapshot = Snapshot(mode: mode, ended: ended, canNext: canNext,
                                                    canPrevious: canPrevious, autoAdvance: autoAdvance)
                            let got = MediaMapping.commandAvailability(snapshot)
                            let finished = mode == .unloaded || (mode == .foray && ended)
                            var want: Set<Command> = []
                            if !finished {
                                want = [.play, .pause, .togglePlayPause, .skipBackward, .skipForward,
                                        .changePlaybackPosition]
                                if canNext { want.insert(.nextTrack) }
                                if canPrevious { want.insert(.previousTrack) }
                            }
                            XCTAssertEqual(got.enabled, want, "\(snapshot)")
                            XCTAssertEqual(got.clearsNowPlaying, finished, "\(snapshot)")
                            XCTAssertFalse(got.isEnabled(.stop), "stop is registered and never enabled (T-7): \(snapshot)")
                        }
                    }
                }
            }
        }
    }

    /// The card's named mutation: next is the chain being non-empty, and
    /// continuous playback being off does not grey out the wheel's skip.
    func testNextFollowsCanNextAndNeverAutoAdvance() {
        let noChain = MediaMapping.commandAvailability(Snapshot(mode: .episode, canNext: false, autoAdvance: true))
        XCTAssertFalse(noChain.isEnabled(.nextTrack), "next enabled with no next: a button that does nothing")
        let chainButOff = MediaMapping.commandAvailability(Snapshot(mode: .episode, canNext: true, autoAdvance: false))
        XCTAssertTrue(chainButOff.isEnabled(.nextTrack), "next must follow the chain regardless of autoAdvance")
    }

    func testAnEndedEpisodeKeepsItsTargetsAndItsNowPlaying() {
        let ended = MediaMapping.commandAvailability(Snapshot(mode: .episode, ended: true, canNext: true))
        XCTAssertFalse(ended.clearsNowPlaying)
        XCTAssertTrue(ended.isEnabled(.play))
        XCTAssertTrue(ended.isEnabled(.nextTrack))
    }

    func testOnlyNothingLoadedOrAFinishedForayClearsNowPlaying() {
        for snapshot in [Snapshot(mode: .unloaded), Snapshot(mode: .unloaded, canNext: true),
                         Snapshot(mode: .foray, ended: true, canNext: true, canPrevious: true)] {
            let got = MediaMapping.commandAvailability(snapshot)
            XCTAssertTrue(got.clearsNowPlaying, "\(snapshot)")
            XCTAssertEqual(got.enabled, [], "\(snapshot)")
        }
        XCTAssertFalse(MediaMapping.commandAvailability(Snapshot(mode: .foray, ended: false)).clearsNowPlaying)
    }

    // MARK: - the fixtures catch the mutation

    /// A table that offers `nexttrack` whether or not the surface has a next:
    /// the fixture run must mark the no-next cases FAILED, not pass them.
    func testTheFixturesCatchNextOfferedWithNoNext() throws {
        let mutant = MediaEpisodeFamily.makeRunner(installedActions: { surface in
            var always = surface
            always.next = true
            return MediaMapping.installedActions(always)
        })
        let dir = try ParityLocator.locate()
        let report = ParitySuite(data: try ParityData.load(parityDir: dir), runners: [mutant]).run()
        let results = Dictionary(uniqueKeysWithValues: report.results(for: "media-episode").map { ($0.id, $0.outcome) })
        for id in ["media-episode/actions-no-next-no-button", "media-episode/actions-absent-next-previous",
                   "media-episode/actions-empty-surface"] {
            XCTAssertEqual(results[id], .failed, "\(id) did not catch a next offered with no next")
        }
        // And the real table passes the same cases, so the red is the mutant's.
        let real = ParitySuite(data: try ParityData.load(parityDir: dir), runners: [MediaEpisodeFamily.runner]).run()
        XCTAssertEqual(real.results(for: "media-episode").filter { $0.outcome.isFailure }.map(\.id), [])
    }

    // MARK: - presses

    func testAStopCarriesOnlyClose() {
        XCTAssertEqual(MediaMapping.intent(for: .stop, details: MediaMapping.PressDetails(close: true)), .stop(close: true))
        XCTAssertEqual(MediaMapping.intent(for: .stop), .stop(close: false))
    }

    func testAScrubWithNoUsableTimeIsIgnoredAndZeroIsHonoured() {
        for time in [nil, -1, .nan, .infinity] as [Double?] {
            XCTAssertNil(MediaMapping.intent(for: .seekTo, details: MediaMapping.PressDetails(seekTime: time)), "\(String(describing: time))")
        }
        XCTAssertEqual(MediaMapping.intent(for: .seekTo, details: MediaMapping.PressDetails(seekTime: 0)), .seekTo(0))
    }

    // MARK: - JavaScript semantics (expected values read off node)

    func testProtocolRelativeIsJudgedByCodeUnitsNotGraphemes() {
        // "//" + U+0301: Swift's hasPrefix("//") says no, startsWith("//") says yes.
        XCTAssertNil(MediaMapping.artworkUrl("//\u{301}x"))
    }

    func testTrimIsJavaScriptsTrim() {
        XCTAssertEqual(MediaMapping.artworkUrl("\u{FEFF}https://x/y.png\u{FEFF}"), "https://x/y.png")
    }

    func testSizesAreReadAsTheRegexReadsThem() {
        XCTAssertNil(MediaMapping.artwork("https://x/a_12345x600.png")?.sizes, "a five-digit run is not a size")
        XCTAssertEqual(MediaMapping.artwork("https://x/a-12x34567b.png")?.sizes, "12x3456")
        XCTAssertNil(MediaMapping.artwork("https://x/600x600/b.png")?.sizes, "a size must be in the last segment")
        XCTAssertEqual(MediaMapping.artwork("600x600.JPEG?x=a/b"), MediaMapping.Artwork(src: "600x600.JPEG?x=a/b", type: "image/jpeg"))
        XCTAssertEqual(MediaMapping.artwork("data:IMAGE/PNG;base64,xx"), MediaMapping.Artwork(src: "data:IMAGE/PNG;base64,xx", type: "image/png"))
    }

    func testTheCounterIsSpelledAsJavaScriptSpellsNumbers() {
        let meta = MediaMapping.metadata(item: MediaMapping.Item(kind: "episode", title: "T"), forayTitle: "F", index: 1e21, total: 2e21)
        XCTAssertEqual(meta.album, "F · clip 1e+21 of 2e+21")
    }

    func testANegativeZeroPositionIsReportedAsZero() {
        let state = MediaMapping.positionState(durationSec: 10, positionSec: -0.0)
        XCTAssertEqual(state?.position.sign, .plus)
    }

    // MARK: - the narration credit ladder (ported now, played in M2)

    func testNarrationIsNeverCreditedToTheApp() {
        let tts = MediaMapping.metadata(item: MediaMapping.Item(kind: "tts"), nextItem: MediaMapping.Item(title: " Next ", show: "S"), forayTitle: "")
        XCTAssertEqual(tts.title, "Up next: Next")
        XCTAssertEqual(tts.artist, "Next")
        let jingle = MediaMapping.metadata(item: MediaMapping.Item(kind: "jingle"), nextItem: MediaMapping.Item(show: "S"))
        XCTAssertEqual(jingle.title, MediaMapping.appName, "a title may fall back to the app's name")
        XCTAssertEqual(jingle.artist, "S", "a credit never does")
        XCTAssertEqual(MediaMapping.narrationCredit(forayTitle: " F ", nextItem: MediaMapping.Item(title: "T", show: "S")), "F")
        XCTAssertEqual(MediaMapping.narrationCredit(forayTitle: nil, nextItem: nil), "")
    }
}
