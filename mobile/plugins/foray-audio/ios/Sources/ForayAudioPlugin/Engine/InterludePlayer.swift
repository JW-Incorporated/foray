import Foundation
import AVFoundation
import ForayEngineCore

/// The part of `AVAudioPlayer` InterludePlayer touches. `AVJingle` is the
/// real one; the XCTests hand InterludePlayer a fake, because the case the
/// ceiling exists for (`audioPlayerDidFinishPlaying` never arriving) cannot
/// be produced on demand by a real player.
protocol JingleAPI: AnyObject {
    /// The file ran out (`true`) or failed mid-play (`false`), on ANY thread.
    var onFinish: ((Bool) -> Void)? { get set }
    /// From the first frame, at 1.0x. False: the player refused.
    func playFromStart() -> Bool
    func stop()
}

/// One `AVAudioPlayer` on the bundled `interlude-placeholder.wav`, built on
/// the first start (after the session is active, never at boot: a player
/// that prepares its buffers can take the audio hardware).
final class AVJingle: NSObject, JingleAPI, AVAudioPlayerDelegate {
    var onFinish: ((Bool) -> Void)?
    private let url: URL
    private var player: AVAudioPlayer?

    init(url: URL) {
        self.url = url
    }

    func playFromStart() -> Bool {
        if player == nil {
            guard let made = try? AVAudioPlayer(contentsOf: url) else { return false }
            made.delegate = self
            // INTERLUDE_RATE: 1.0x, whatever the listener's speed. With rate
            // control off AVAudioPlayer plays at exactly 1.0; the rate is
            // written anyway so a later `enableRate` cannot inherit a stale one.
            made.enableRate = false
            made.rate = Float(Interlude.rate)
            made.numberOfLoops = 0
            player = made
        }
        guard let player else { return false }
        player.currentTime = 0
        return player.play()
    }

    func stop() {
        player?.stop()
        player?.currentTime = 0
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        onFinish?(flag)
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        onFinish?(false)
    }
}

/// THE REAL `InterludePlaying` (card NE-34; docs/native-engine-plan.md §14):
/// the jingle a seam between two podcasts carries (queue-manager.js §13),
/// played natively so a locked phone hears it with no page.
///
/// It DECIDES NOTHING about when: the core arms the jingle at the out-point,
/// stretches the seam to its ceiling and shrinks it back on the end report.
/// What it owns is the three rules the platform leaves to whoever holds the
/// player:
///
///   1. THE AUDIBLE-START INVARIANT, again (plan §4.4). `AVAudioPlayer.play()`
///      activates an inactive session by itself, which would make this a
///      second session owner. The core never asks without the session; if it
///      ever did, this refuses with a `fault kind=implicit-activation
///      at=interlude` row (and stops a DEBUG build) instead of sounding.
///   2. THE CEILING IS AN ENGINE TIMER. The end the core waits for is
///      `audioPlayerDidFinishPlaying`. If it never comes (a route change that
///      swallowed it, a decoder that stalled), the jingle is stopped at
///      `INTERLUDE_CEILING_SEC` from its start by a timer on the engine's own
///      clock (`EngineTiming`), and reported `ceiling`: nothing is ever left
///      waiting on a delegate call.
///   3. ONE END PER START. A late `didFinish` for a start that was stopped,
///      restarted or already ended at the ceiling reports nothing.
///
/// The asset is a copy of `player/assets/interlude-placeholder.wav` in the
/// plugin's resources, pinned by SHA-256 (`assetSHA256`, held equal to both
/// files by tools/audio/interlude-asset.test.mjs and by the XCTest that hashes
/// the bundled copy), so the phone plays the same bytes the web does.
final class InterludePlayer: InterludePlaying {

    /// SHA-256 of `player/assets/interlude-placeholder.wav` and of the bundled
    /// copy (`Resources/interlude-placeholder.wav`).
    static let assetSHA256 = "597c4fbad12846431d5c6c78bf6a4fc469b2c2d416f53f50bcb26d2e823f83af"
    static let assetName = "interlude-placeholder"
    static let assetExtension = "wav"
    /// SwiftPM's resource bundle for this target (`<package>_<target>`).
    static let resourceBundleName = "ForayAudio_ForayAudioPlugin"

    /// Where the bundled jingle is, or nil. Looked up by hand rather than
    /// through SwiftPM's `Bundle.module`, whose accessor traps when the
    /// bundle is missing: a packaging slip must cost the jingle (the boot
    /// leaves `interludeAvailable` off), never the app.
    /// The places are SwiftPM's own (`resource_bundle_accessor.swift`, the
    /// Xcode variant): the app's resources, this code's bundle, and, for a
    /// test bundle, the build products directory beside it.
    static var assetURL: URL? {
        let own = Bundle(for: InterludePlayer.self)
        let hosts = [Bundle.main.resourceURL, own.resourceURL, Bundle.main.bundleURL, own.bundleURL,
                     own.resourceURL?.deletingLastPathComponent(),
                     own.resourceURL?.deletingLastPathComponent().deletingLastPathComponent(),
                     own.resourceURL?.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()]
        for case let host? in hosts {
            let url = host.appendingPathComponent("\(resourceBundleName).bundle")
            if let bundle = Bundle(url: url),
               let asset = bundle.url(forResource: assetName, withExtension: assetExtension) {
                return asset
            }
        }
        return Bundle.main.url(forResource: assetName, withExtension: assetExtension)
    }

    struct Config {
        /// `AudioSessionOwner.phase == .active`, read through a closure, as
        /// AVDeck's and the speaker's are: one owner of the session.
        var sessionIsActive: () -> Bool
        /// Where the player's rows go: `EngineOutput.diag`.
        var diag: (DiagEntry) -> Void
        /// The engine's clock: the ceiling is one of its timers.
        var timing: EngineTiming
        /// Builds the player on the first start.
        var makeJingle: () -> JingleAPI?
        /// `INTERLUDE_CEILING_SEC` in ms, from the start.
        var ceilingMs: Double = Interlude.ceilingSec * 1000
        /// DEBUG's hard stop for a broken invariant, injectable for the tests.
        var debugFault: (String) -> Void = { assertionFailure($0) }
    }

    var onEnded: ((String) -> Void)?

    private let config: Config
    private var jingle: JingleAPI?
    private var ceiling: EngineObservation?
    /// Which start is sounding (0: none). A report for any other is stale.
    private var sounding = 0
    private var starts = 0

    init(config: Config) {
        self.config = config
    }

    /// The real one, on the bundled asset; nil when the asset is missing.
    static func make(sessionIsActive: @escaping () -> Bool, diag: @escaping (DiagEntry) -> Void,
                     timing: EngineTiming) -> InterludePlayer? {
        guard let url = assetURL else {
            diag(DiagEntry(kind: "interlude", fields: [JSONMember("kind", .string("unavailable")),
                                                        JSONMember("why", .string("no-asset"))]))
            return nil
        }
        return InterludePlayer(config: Config(sessionIsActive: sessionIsActive, diag: diag, timing: timing,
                                              makeJingle: { AVJingle(url: url) }))
    }

    /// Whether a start is sounding (tests and diagnostics).
    var isSounding: Bool { sounding != 0 }

    // MARK: - InterludePlaying

    func start() -> Bool {
        guard config.sessionIsActive() else {
            config.diag(DiagEntry(kind: "fault", fields: [
                JSONMember("kind", .string(Vocabulary.FaultKind.implicitActivation.rawValue)),
                JSONMember("at", .string("interlude"))
            ]))
            config.debugFault("fault implicit-activation interlude")
            return false
        }
        silence()
        if jingle == nil {
            jingle = config.makeJingle()
        }
        guard let jingle else { return refused("no-asset") }
        starts += 1
        let this = starts
        jingle.onFinish = { [weak self] ok in
            InterludePlayer.onMain { self?.finish(this, reason: ok ? "ended" : "error") }
        }
        guard jingle.playFromStart() else { return refused("player") }
        sounding = this
        ceiling = config.timing.schedule(afterMs: config.ceilingMs, repeating: false) { [weak self] in
            self?.finish(this, reason: "ceiling")
        }
        return true
    }

    func stop() {
        silence()
    }

    func release() {
        silence()
        jingle?.onFinish = nil
        jingle = nil
    }

    // MARK: - Ends

    /// The start `this` stopped sounding. Reported once, and only while it is
    /// still the one sounding.
    private func finish(_ this: Int, reason: String) {
        guard this == sounding else { return }
        sounding = 0
        ceiling?.cancel()
        ceiling = nil
        if reason == "ceiling" {
            // The delegate never said so: make it true.
            jingle?.stop()
            config.diag(DiagEntry(kind: "interlude", fields: [JSONMember("kind", .string("ceiling"))]))
        }
        onEnded?(reason)
    }

    /// Stop whatever is sounding, with no report.
    private func silence() {
        ceiling?.cancel()
        ceiling = nil
        if sounding != 0 {
            sounding = 0
            jingle?.stop()
        }
    }

    private func refused(_ why: String) -> Bool {
        config.diag(DiagEntry(kind: "interlude", fields: [JSONMember("kind", .string("refused")),
                                                           JSONMember("why", .string(why))]))
        return false
    }

    /// AVAudioPlayer does not document its delegate's thread: hop to main,
    /// where the engine lives (a later turn, never inside the one in progress).
    private static func onMain(_ work: @escaping () -> Void) {
        if Thread.isMainThread {
            work()
        } else {
            DispatchQueue.main.async(execute: work)
        }
    }
}
