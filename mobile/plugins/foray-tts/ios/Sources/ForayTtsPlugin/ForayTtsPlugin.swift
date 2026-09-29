import Foundation
import AVFAudio
import Capacitor
import CryptoKit
import UIKit
import os

/// K-01's engine seam (`docs/bundled-voice-plan.md`). AT FILE SCOPE and not
/// nested in `ForayTtsPlugin`, because Swift does not allow a protocol inside
/// another declaration — a nested one does not compile, and this file is folded
/// into every generated iOS project by `cap sync`, so it has to build.
///
/// What K-01 needs from a runtime, and nothing more: hand it phoneme ids, get
/// back how long synthesis took and how much audio came out. Deliberately NOT
/// `speak`-shaped — the probe never plays through the narration path, so an
/// engine implementing this cannot accidentally become the way narration is
/// spoken. K-04 promotes it explicitly, or not at all.
public protocol KokoroProbeEngine {
    /// The model identifier this engine loaded, for the record.
    var modelName: String { get }
    /// The ONNX execution provider actually in use (`cpu`, `coreml`).
    var provider: String { get }
    /// Milliseconds to load the model: first ever, and again once warm. Deck
    /// §5 item 6 says cold start is 1–3 s and the mitigation is loading at app
    /// start — which only matters if the warm figure is small, so both are
    /// reported rather than one.
    func load() -> (coldMs: Double, warmMs: Double)
    /// Synthesize one line from its phoneme ids. Returns synthesis wall time,
    /// the seconds of audio produced, and — when no audio was produced — WHICH
    /// of the failures fired, from `player/kokoro-probe.js`'s `SYNTH_REASONS`.
    ///
    /// THE REASON IS NOT OPTIONAL DECORATION (#685). Before it existed, a nil
    /// session, a throwing inference and an empty output tensor were the same
    /// `(0, 0)`, each diagnosed only into `os_log` — which the founder holding
    /// the phone cannot read. Three different bugs arrived as one number, and
    /// the number was zero.
    func synthesize(ids: [Int], speed: Double) -> (synthMs: Double, audioSec: Double, reason: String?)

    /// Whether an accelerator execution provider (CoreML on iOS, NNAPI on
    /// Android) is registered on the session, as opposed to ORT's CPU
    /// provider. `true` only on the KV-R2 `coreml` pass once its EP was
    /// appended (see `providerBasis` for what that does NOT prove).
    /// Reported rather than inferred from `provider`, because `"cpu"` reads as
    /// a fallback that fired and it is not one: it is the only path compiled.
    var acceleratorWired: Bool { get }

    /// Why the last `synthesize` threw, as TOKENS (L03, L36): ORT's error
    /// code, the operator it names, and the stage. Never the message.
    var lastFailure: KokoroProbeFailure? { get }

    /// Why the cold session did not open, from the same token set, or nil.
    var loadError: String? { get }

    /// KV-R2: the pass's execution provider could not be registered at all
    /// (the CoreML EP is absent from this ORT build, or its append threw).
    /// The pass records `coreml-unavailable` instead of pretending to run.
    var providerUnavailable: Bool { get }

    /// How much `provider` KNOWS (KV-R2): `"requested"` when the EP was only
    /// asked for and the runtime cannot say which nodes it actually took (the
    /// CoreML pass on ORT 1.20.0, whose API reports no per-node placement, so
    /// CoreML may have taken all of the graph, part of it, or none, with the
    /// rest silently on the CPU), nil when `provider` is simply what ran.
    var providerBasis: String? { get }

    /// The intra-op thread count the session was built with, or nil when the
    /// engine does not say (a fake). Reported as `intraThreads` (L09).
    var intraThreads: Int? { get }

    /// Release the session `load()` opened. KV-R2 calls it at the end of
    /// every pass, BEFORE the next pass's engine is built, so two 325 MB fp32
    /// sessions never share the process.
    func close()

    /// KV-R3: the Core ML chain's per-stage compute units, in chain order
    /// (`ane,ane,ane,cpu,cpu,ane,cpu`), or nil for an engine with no stages.
    var route: String? { get }

    /// KV-R3: the last `synthesize`'s milliseconds per Core ML stage, in
    /// chain order (§5 item 6), or nil for an engine with no stages.
    var lastStageMs: [Double]? { get }

    /// KV-R3: keep (or stop keeping) each rendered chunk's samples, for the
    /// pass's WAV (§5 item 10). Off unless the matrix asks, chunk by chunk.
    func setCaptureSamples(_ on: Bool)

    /// The last captured chunk's samples, handed over once, or nil.
    func takeLastSamples() -> [Float]?

    /* Probe v3.1: the Core ML engine breadcrumbs each stage's compile, load
       and predict through `ProbeStageHook` (ProbeLedger.swift), not through
       this protocol, which the XCTest fakes implement. */

    /// The last `synthesize`'s input shape per Core ML stage, in chain order:
    /// the largest input handed to that stage (`1x512x310`), `-` for a stage
    /// the chunk never reached. Nil for an engine with no stages.
    var lastStageInputs: [String]? { get }

    /// The last `synthesize`'s predicted frame count (the Core ML durations'
    /// sum), or nil.
    var lastFrames: Int? { get }
}

public extension KokoroProbeEngine {
    /// The honest default for any engine that has not thought about it.
    var acceleratorWired: Bool { false }
    /// An engine that does not say why it failed says nothing, not "ok".
    var lastFailure: KokoroProbeFailure? { nil }
    var loadError: String? { nil }
    var providerUnavailable: Bool { false }
    var providerBasis: String? { nil }
    var intraThreads: Int? { nil }
    func close() {}
    var route: String? { nil }
    var lastStageMs: [Double]? { nil }
    func setCaptureSamples(_ on: Bool) {}
    func takeLastSamples() -> [Float]? { nil }
    var lastStageInputs: [String]? { nil }
    var lastFrames: Int? { nil }
}

/// One inference failure in closed tokens (`player/kokoro-probe.js`'s
/// `ORT_CODES` and `ORT_STAGES`), plus the failing operator's name when the
/// runtime named one. Built so that nothing else CAN be stored: an ORT file
/// error's text can carry the app-container path.
public struct KokoroProbeFailure {
    public let code: String
    public let op: String?
    public let stage: String

    public init(code: String, op: String?, stage: String) {
        self.code = code
        self.op = op
        self.stage = stage
    }
}

/// The bridge half of `foray-tts` on iOS: wraps `AVSpeechSynthesizer` /
/// `AVSpeechUtterance`, and is the one place in this repo that calls
/// `AVSpeechSynthesisIPANotationAttribute` -- the first-party, documented
/// pronunciation-override mechanism `docs/research/on-device-tts.md` §1
/// identified as the whole reason a native plugin is required at all (neither
/// the plain Web Speech API nor either surveyed Capacitor community plugin
/// exposes it).
///
/// Called from `mobile/plugins/foray-tts/web/foray-tts.js` over
/// `window.Capacitor.nativePromise("ForayTts", "speak", …)`, same bridge
/// mechanism `ForayAudioPlugin.java` documents for Android, for the same
/// reason: this repo has no bundler, so there is no generated
/// `@capacitor/core` proxy to import.
///
/// Every method resolves. None of them reject -- same rule
/// `ForayAudioPlugin.java`'s own class comment states, for the same reason: a
/// rejected `PluginCall` becomes an unhandled promise in a page that may be
/// mid-narration, and the web half's own `speak()` already treats a native
/// failure as "fall back to Web Speech", so a thrown promise here would just
/// be swallowed one layer up in a less informative way.
@objc(ForayTtsPlugin)
public class ForayTtsPlugin: CAPPlugin, CAPBridgedPlugin, AVSpeechSynthesizerDelegate {
    public let identifier = "ForayTtsPlugin"
    public let jsName = "ForayTts"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "state", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listVoices", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "kokoroProbe", returnType: CAPPluginReturnPromise)
    ]

    /// §7 item 3 (L-03, `generation-architecture.md` §7 item 3): the event
    /// this plugin raises from `speechSynthesizer(_:didFinish:)` once an
    /// utterance completes. Mirrors `TRANSPORT_EVENT` in
    /// `ForayAudioPlugin.swift`/`foray-media-session.js` -- the same
    /// `notifyListeners`/`addListener` mechanism, a different plugin and
    /// event name, pinned against `web/foray-tts.js`'s own `FINISHED_EVENT`
    /// constant by `shell-invariants.test.mjs` once that suite extends to
    /// this plugin (kept a plain string constant here, not re-derived, so
    /// a rename on either side is a one-line diff to catch, the same
    /// discipline `TRANSPORT_EVENT` already established).
    static let FINISHED_EVENT = "finished"

    /// M-03. The event this plugin raises when the SYSTEM takes speech away —
    /// an `AVAudioSession` interruption, a route change, a media-services
    /// reset. Same name and same `{kind, reason, at}` shape
    /// `ForayAudioPlugin.swift` raises for the element's side, deliberately:
    /// the founder's question is "why did it stop?", and an answer split
    /// across two event names with two vocabularies would have to be rejoined
    /// by whoever reads the record. `player/diagnostic-log.js`'s
    /// `sessionEvent()` is the one reader and it does not care which plugin
    /// spoke — `producer` says which, and nothing else differs.
    static let SESSION_EVENT = "session"

    /// The word `state()` reports and `pause`/`resume`/`stop` return, so the
    /// page never has to derive it from two booleans that can both be false
    /// for two different reasons. Exactly the three L-05 names.
    static let STATE_SPEAKING = "speaking"
    static let STATE_PAUSED = "paused"
    static let STATE_IDLE = "idle"

    private let synthesizer = AVSpeechSynthesizer()
    /// WHICH UTTERANCE (audit round 3, mobile-native-2): the id `speak()`
    /// returned for each queued utterance, and whether it was a voice-picker
    /// preview, so `finished` can say whose completion it is. Keyed by the
    /// utterance object; removed on finish or cancel. The delegate runs on a
    /// different thread from the plugin method, hence the lock.
    private var utteranceMeta: [ObjectIdentifier: (id: String, audition: Bool)] = [:]
    private let utteranceMetaLock = NSLock()

    /// A new `speak()` REPLACES whatever the synthesizer holds (audit round 3,
    /// mobile-native-1). `AVSpeechSynthesizer.speak` only enqueues, and a
    /// paused synthesizer stays paused: after a skip away from a narration line
    /// (the reducer pauses before it loads) the next line queued silently
    /// behind the paused one. Android always spoke with QUEUE_FLUSH; this is
    /// the same rule. `stopSpeaking` fires `didCancel`, never `didFinish`,
    /// so flushing never advances the queue.
    static func mustFlushBeforeSpeaking(isSpeaking: Bool, isPaused: Bool) -> Bool {
        return isSpeaking || isPaused
    }

    private func takeUtteranceMeta(_ utterance: AVSpeechUtterance) -> (id: String, audition: Bool)? {
        utteranceMetaLock.lock()
        defer { utteranceMetaLock.unlock() }
        return utteranceMeta.removeValue(forKey: ObjectIdentifier(utterance))
    }

    override public func load() {
        synthesizer.delegate = self
        registerSessionObservers()
        /* PROBE v3.1: a breadcrumb on disk now can only be a probe run the
           PREVIOUS process did not finish (this runs once per process, before
           any probe can start). It becomes a kill report at once — durably,
           before the breadcrumb is cleared — and the page writes it as its own
           `voiceProbe` row at boot (`mode: "status"`), whether or not the
           founder ever taps the probe again. File I/O of a few hundred bytes:
           no runtime is touched here. */
        ProbeLedger.shared.promoteLeftover()
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: - M-03: why did it stop?

    /// Observe the three notifications that can silence a synthesizer without
    /// anybody pressing anything, and report each one to the page.
    ///
    /// REPORTED, NOT ACTED ON, and that is the whole of this card. An
    /// interruption that ends with `shouldResume` is a decision about whether
    /// the listener wants their narration back, and `player/queue-manager.js`
    /// owns every such decision — a plugin that resumed itself would be a
    /// second opinion about the transport, which is the thing L-05 exists to
    /// remove. What is added here is evidence.
    ///
    /// `AVSpeechSynthesizer` does NOT surface interruptions of its own: it
    /// stops when the session it uses (`usesApplicationAudioSession`, see
    /// `speak()`) is taken, and the delegate's `didCancel` is not called for
    /// that. So the session's own notification is the only channel there is.
    private func registerSessionObservers() {
        let center = NotificationCenter.default
        center.addObserver(
            self,
            selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification,
            object: nil
        )
        center.addObserver(
            self,
            selector: #selector(handleRouteChange(_:)),
            name: AVAudioSession.routeChangeNotification,
            object: nil
        )
        center.addObserver(
            self,
            selector: #selector(handleServicesReset(_:)),
            name: AVAudioSession.mediaServicesWereResetNotification,
            object: nil
        )
    }

    @objc private func handleInterruption(_ note: Notification) {
        let raw = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) ?? 0
        /* Compared as RAW VALUES rather than as `InterruptionType(rawValue:) == .began`:
           that form relies on Swift promoting the implicit member on the right into an
           Optional, which compiles but reads as a nil-vs-value comparison at a glance.
           This one cannot be misread, and it has no optional to unwrap. */
        let began = raw == AVAudioSession.InterruptionType.began.rawValue
        let options = (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt) ?? 0
        let shouldResume = AVAudioSession.InterruptionOptions(rawValue: options).contains(.shouldResume)
        emitSession(
            kind: began ? "interruptionBegan" : "interruptionEnded",
            reason: began ? "began" : (shouldResume ? "should-resume" : "no-resume")
        )
    }

    @objc private func handleRouteChange(_ note: Notification) {
        let raw = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt) ?? 0
        emitSession(kind: "routeChange", reason: Self.routeChangeReason(raw))
    }

    @objc private func handleServicesReset(_ note: Notification) {
        emitSession(kind: "mediaServicesReset", reason: "reset")
    }

    /// `AVAudioSession.RouteChangeReason` -> the closed vocabulary
    /// `player/diagnostic-log.js`'s `dataTokenOf()` admits. A dashed
    /// lower-case token and never a device NAME: a route is something a
    /// person named after themselves, and this record gets pasted into
    /// issues — the same rule `diagnostic-log.js` already enforces for
    /// `route.autoResume.knownCar=`. `internal` (not `private`) so
    /// `ForayTtsPluginTests` can pin the mapping without a live session.
    static func routeChangeReason(_ raw: UInt) -> String {
        switch AVAudioSession.RouteChangeReason(rawValue: raw) {
        case .some(.newDeviceAvailable): return "new-device"
        case .some(.oldDeviceUnavailable): return "old-device-gone"
        case .some(.categoryChange): return "category-change"
        case .some(.override): return "override"
        case .some(.wakeFromSleep): return "wake"
        case .some(.noSuitableRouteForCategory): return "no-route"
        case .some(.routeConfigurationChange): return "config-change"
        case .some(.unknown): return "unknown"
        default: return "unknown"
        }
    }

    private func emitSession(kind: String, reason: String) {
        notifyListeners(Self.SESSION_EVENT, data: Self.sessionEvent(kind: kind, reason: reason))
    }

    /// The wire shape, pure and `internal` so a test can pin it without a
    /// notification centre. `at` is epoch MILLISECONDS, the same unit
    /// `diagnostic-log.js` stamps every entry with, so a reader never has to
    /// guess which clock a native event is on.
    static func sessionEvent(kind: String, reason: String, at: Double = Date().timeIntervalSince1970 * 1000) -> JSObject {
        var event = JSObject()
        event["kind"] = kind
        event["reason"] = reason
        event["producer"] = "tts"
        event["at"] = Int(at.rounded())
        return event
    }

    /// `AVSpeechSynthesizerDelegate`. Documented as "real future work" at the
    /// `speak()` call site below for months -- `speak()` resolves on ACCEPT,
    /// not completion, so nothing in that method itself can ever learn when
    /// the listener stops hearing the line. This is the other half: fired
    /// once per utterance, unconditionally. THE PAYLOAD NAMES THE UTTERANCE
    /// (audit round 3, mobile-native-2): `utteranceId` is the id `speak()`
    /// returned and `audition` says it was a preview. The queue used to be
    /// unable to tell a stale completion (a preview, or a line it had already
    /// left) from the current line's, because it compared only its own
    /// sequence number; `_onTtsFinished` now drops any finish that is not the
    /// line it is waiting for.
    ///
    /// Fired for EVERY completion, not gated on whether JS is still
    /// listening: `notifyListeners` is a no-op with no registered listener
    /// (Capacitor's own documented behaviour), so there is nothing here to
    /// guard.
    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        var data = JSObject()
        if let meta = takeUtteranceMeta(utterance) {
            data["utteranceId"] = meta.id
            data["audition"] = meta.audition
        }
        notifyListeners(Self.FINISHED_EVENT, data: data)
    }

    /// A cancelled utterance (a `stop()`, or a new `speak()` flushing the old
    /// one) is forgotten and NOTHING is emitted: a cancel is never a finish,
    /// and a stop that advanced the queue would be a skip.
    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        _ = takeUtteranceMeta(utterance)
    }

    /// The `rate` this plugin receives is a PLAYBACK-SPEED MULTIPLIER, not a
    /// normalised rate, where **1 means normal speed**. Since the founder's
    /// 2026-09-24 ruling (*"1x for now, but maybe we change later. I recall 1x
    /// felt like 0.6x or so, it was very slow."*) both callers —
    /// `PlayerQueueManager._speakNarration` (`player/queue-manager.js`) and the
    /// voice picker's Preview (`player/client.js` `auditionVoice`) — pass
    /// `NARRATION_RATE`, which is 1, whatever speed the listener chose; they
    /// used to pass the listener's speed off `player/playback-rate.js`'s ladder
    /// `[0.75, 1, 1.25, 1.5, 1.75, 2]`. So today only the 1.0x point of the
    /// curve below is ever asked for, and it is the one point that is not an
    /// estimate: `AVSpeechUtteranceDefaultSpeechRate`. The "felt like 0.6x" is
    /// that default rate as heard, not a mapping error — see anchor 1 below.
    /// That multiplier is also exactly what
    /// Android's `TextToSpeech.setSpeechRate()` means — AOSP's own javadoc on that
    /// method reads *"1.0 is the normal speech rate, lower values slow down the
    /// speech (0.5 is half the normal speech rate), greater values accelerate it
    /// (2.0 is twice the normal speech rate)"* — which is why `ForayTtsPlugin.java`
    /// passes the value straight through and **must keep doing so**. Android is not
    /// the platform with the mapping problem; do not "fix" it to match this file.
    ///
    /// `AVSpeechUtterance.rate` does NOT mean that. Its scale runs from
    /// `AVSpeechUtteranceMinimumSpeechRate` to `AVSpeechUtteranceMaximumSpeechRate`
    /// with `AVSpeechUtteranceDefaultSpeechRate` (0.5) as ordinary speech, and
    /// Apple documents no relationship at all between a step on that scale and a
    /// multiple of normal speaking speed. The first version of this method assigned
    /// the multiplier straight onto `rate` (so 1.0x asked for
    /// `AVSpeechUtteranceMaximumSpeechRate`); the second multiplied
    /// `AVSpeechUtteranceDefaultSpeechRate` by it, which fixed the 1.0x case and
    /// left everything else wrong. This is the third, and the first with a
    /// measurement under it.
    ///
    /// ── THE MAPPING IS CALIBRATED, NOT DERIVED ───────────────────────────────
    ///
    /// **Exactly one point on this curve has ever been heard, and it is the one below.**
    /// `HUMAN-ACTIONS.md` #29's RESULT (2026-09-05, TestFlight build off `main`, one
    /// iPhone, one listener): asking for playback multiplier **1.5** — which the
    /// previous mapping turned into utterance rate `0.75`, i.e.
    /// `AVSpeechUtteranceDefaultSpeechRate` times 1.5 — was heard at **roughly 3x**
    /// normal speed. Nothing else about the curve was measured: not 2.0x, not 0.75x,
    /// and not the shape in between.
    ///
    /// So the mapping rests on **two anchors and one assumption of form**:
    ///
    /// 1. `AVSpeechUtteranceDefaultSpeechRate` = 1.0x normal. Definitional, from
    ///    Apple's own naming of the constant, not from this measurement. The one
    ///    listener's ear disagrees (2026-09-24: "1x felt like 0.6x or so"): if 4a
    ///    ever wants 1x to sound faster than Apple's default, that is a product
    ///    choice to move THIS anchor (and the XCTest that pins it), not a bug in
    ///    the curve. **That choice was put to the founder and he declined it.**
    ///    The question was whether 1x stays at `AVSpeechUtteranceDefaultSpeechRate`
    ///    (0.5) or moves to an estimated ~0.58 to make up the "0.6x" feel; his
    ///    answer, 2026-09-24, verbatim: *"assume 1x speed"* (`docs/DECISIONS.md`).
    ///    So 1x stays exactly `AVSpeechUtteranceDefaultSpeechRate`; the ~0.58 is
    ///    an unmeasured estimate that is NOT in effect, and moving it needs a new
    ///    ruling, not a tidy-up.
    /// 2. `AVSpeechUtteranceDefaultSpeechRate * 1.5` ≈ 3.0x normal. The one reading.
    /// 3. **Form: perceived speed is EXPONENTIAL in utterance rate** — equivalently,
    ///    utterance rate is affine in `log(multiplier)`:
    ///
    ///        perceived(r) = 3.0 ^ ((r − D) / (1.5·D − D))      D = default rate
    ///        rate(m)      = D + (1.5·D − D) · log(m) / log(3.0)
    ///
    /// A one-parameter exponential is the **simplest** family that passes through both
    /// anchors and stays sane over the whole framework range: a straight line through
    /// the same two points hits zero perceived speed at rate 0.375 and goes negative
    /// below it, which is nonsense on a scale whose minimum is 0.0. Exponential also
    /// matches how speed is *heard* — listeners compare speeds as ratios, and a
    /// playback ladder is itself multiplicative — so equal ratios of `multiplier` cost
    /// equal steps of `rate`. That is an argument for plausibility, **not** evidence:
    /// with two anchors, infinitely many curves fit, and this one was chosen for
    /// simplicity, not because the device data distinguishes it from any other.
    ///
    /// **WHAT WOULD SETTLE IT: a second device reading.** This is HUMAN-ACTIONS.md's
    /// **H3**: pick 2x in the app's Narration voice picker, tap **Audition** on the
    /// fixed 20-count line, and time it with a stopwatch; this mapping predicts a rate
    /// of ≈0.658 and therefore ≈2.0x wall clock, so the line should finish in ≈50 s.
    /// (H3's Audition button replaced an earlier diagnostic instrument for this test
    /// — see V-01/D-01 in docs/ios-controls-and-voice-plan.md; that instrument and
    /// its wiring are deleted.) If it does not, the *form* above is what is wrong,
    /// and the fix is a third anchor, not a nudge to these two. Until someone runs
    /// that, treat every value here except 1.0x as an estimate with one point
    /// behind it. **Parked since 2026-09-24:** the Preview now speaks at 1x like
    /// all narration, so H3 cannot be run from the app as written, and no call
    /// from the app reaches the curve above 1x until narration follows the
    /// listener's speed again ("maybe we change later").
    ///
    /// Consequences worth knowing at the ladder's stops (`[0.75, 1, 1.25, 1.5, 1.75, 2]`):
    /// rates ≈ 0.435, 0.500, 0.551, 0.592, 0.627, 0.658. The old mapping sent 0.750 for
    /// 1.5x — the value now reserved for a listener who actually asks for 3x, which the
    /// ladder does not offer, so 0.750 is unreachable in the app.
    ///
    /// Still written against the framework's own constants rather than the literals
    /// 0.0/0.5/1.0, so it cannot drift if Apple ever moves them, and the two
    /// calibration numbers are named rather than inlined. The explicit clamp stays:
    /// the framework clamps out-of-range values itself, but clamping here is what
    /// makes an absurd `rate` from the page land on a known end of the scale rather
    /// than relying on that.
    static func utteranceRate(playbackMultiplier multiplier: Double) -> Float {
        let defaultRate = Double(AVSpeechUtteranceDefaultSpeechRate)
        let minRate = Double(AVSpeechUtteranceMinimumSpeechRate)
        let maxRate = Double(AVSpeechUtteranceMaximumSpeechRate)

        /* A multiplier that is not a positive number has no logarithm, and Swift's
           `min`/`max` PROPAGATE NaN rather than clamping it (both compare false, so
           the NaN is returned), which would put a NaN on `utterance.rate`. `rate`
           arrives from `call.getDouble("rate")` — whatever JSON the page sent — so
           0, a negative, and NaN are all reachable inputs, and all three mean "this
           is not a speed": answer with the slowest rate the framework has rather
           than with a value AVFoundation cannot interpret. */
        guard multiplier > 0 else { return Float(minRate) }

        let anchorRate = defaultRate * calibrationRequestedMultiplier
        let anchorSpan = anchorRate - defaultRate
        let scaled = defaultRate
            + anchorSpan * log(multiplier) / log(calibrationPerceivedMultiple)
        return Float(min(max(scaled, minRate), maxRate))
    }

    /// The playback multiplier that was actually requested on the device in
    /// `HUMAN-ACTIONS.md` #29's RESULT. Under the mapping that build shipped, this
    /// produced utterance rate `AVSpeechUtteranceDefaultSpeechRate * 1.5` = 0.75 —
    /// which is why the anchor rate above is written as that product rather than as
    /// a bare 0.75.
    private static let calibrationRequestedMultiplier = 1.5

    /// What that rate was HEARD as: "roughly 3x". A listener's estimate, reported to
    /// one significant figure, from a single session on a single iPhone. It is the
    /// whole empirical content of this mapping, and it is a soft number — do not
    /// quote it as 3.00.
    private static let calibrationPerceivedMultiple = 3.0
    // MARK: - Voice selection
    //
    // WHY THIS EXISTS AT ALL. Until now `speak()` set a voice only when a `lang`
    // was passed, and it set it with `AVSpeechSynthesisVoice(language:)`. That
    // initialiser returns the SYSTEM DEFAULT voice for a language, which on iOS
    // is the compact/legacy formant-synthesis tier -- the robotic one. Apple's
    // catalogue is not one tier: `docs/research/on-device-tts.md` §1 recorded
    // that it "spans multiple synthesis tiers (compact/legacy formant-style
    // voices through modern neural 'Enhanced'/'Premium' voices, downloaded
    // per-language on demand)", and nothing in this plugin had ever asked for
    // one of the good ones. A founder listening test on 2026-09-05 called the
    // on-device voice "much worse than the original test" (the Kokoro
    // acceptance fixture) -- this is why.
    //
    // ENHANCED AND PREMIUM VOICES ARE PER-DEVICE DOWNLOADS. They are free, but
    // they are not present until someone fetches them in
    // Settings -> Accessibility -> Spoken Content -> Voices. So the selection
    // below is written as "best of what is ACTUALLY INSTALLED", degrading one
    // tier at a time, and the plugin must never fail to speak because a
    // preferred voice is absent. That is the whole design constraint.
    //
    // THE PURE FUNCTIONS ARE THE POINT. `AVSpeechSynthesisVoice` cannot be
    // constructed with arbitrary properties, so the ranking/matching rules live
    // in `static` functions over a plain `VoiceOption` value type that tests can
    // build by hand; `installedVoices()` is the only place that touches the
    // framework's catalogue.
    // THE RULES THEMSELVES NOW LIVE IN SpeechRules.swift (card NE-33): the
    // native engine's narrator speaks by the same rules, and this package
    // keeps a byte-identical copy of that file (the engine's core owns the
    // original; a node test fails when the two differ). The statics below are
    // the legacy lane's names for them, unchanged in signature and in
    // behaviour, so the legacy tests keep pinning exactly what they pinned.

    /// One installed voice, reduced to the four things selection cares about
    /// (`SpeechRules.VoiceOption`: identifier, name, language, qualityRank).
    typealias VoiceOption = SpeechRules.VoiceOption

    /// `1` -> "default", `2` -> "enhanced", `3` -> "premium", else "unknown".
    static func qualityLabel(rank: Int) -> String {
        SpeechRules.qualityLabel(rank: rank)
    }

    /// The primary subtag of a BCP-47 tag, lowercased: `en-US` -> `en`.
    static func primarySubtag(_ tag: String) -> String {
        SpeechRules.primarySubtag(tag)
    }

    /// Voices eligible for `language`, EXACT MATCHES FIRST AND ALONE when there
    /// are any; only then the primary subtag.
    static func candidates(_ all: [VoiceOption], language: String) -> [VoiceOption] {
        SpeechRules.candidates(all, language: language)
    }

    /// The best INSTALLED voice for `language`: highest `qualityRank` wins,
    /// ties toward `preferringName`, then the lowest identifier.
    static func bestVoice(among all: [VoiceOption], language: String, preferringName: String?) -> VoiceOption? {
        SpeechRules.bestVoice(among: all, language: language, preferringName: preferringName)
    }

    /// What `speak()` decided, INCLUDING why (`SpeechRules.VoiceResolution`).
    typealias VoiceResolution = SpeechRules.VoiceResolution

    /// Resolve the voice for one utterance. An identifier that is not installed
    /// is NOT an error: it degrades to `bestVoice`, and says so.
    static func resolveVoice(
        among all: [VoiceOption],
        requested: String?,
        language: String,
        preferringName: String?
    ) -> VoiceResolution {
        SpeechRules.resolveVoice(among: all, requested: requested, language: language, preferringName: preferringName)
    }

    /// Listing order: language, then BEST QUALITY FIRST within a language, then
    /// name.
    static func sortedForListing(_ voices: [VoiceOption]) -> [VoiceOption] {
        SpeechRules.sortedForListing(voices)
    }

    /// The one place that reads the framework's catalogue.
    static func installedVoices() -> [VoiceOption] {
        AVSpeechSynthesisVoice.speechVoices().map {
            VoiceOption(
                identifier: $0.identifier,
                name: $0.name,
                language: $0.language,
                qualityRank: $0.quality.rawValue
            )
        }
    }

    /// The language a call is about: what it asked for, else the device's own.
    private static func effectiveLanguage(_ requested: String?) -> String {
        if let requested = requested, !requested.isEmpty { return requested }
        return AVSpeechSynthesisVoice.currentLanguageCode()
    }

    /// `ipaOverrides` arrives as `[{ term, start, end, ipa }]` -- character
    /// offsets into `text`, built by `foray-tts.js`'s `buildIpaOverrides()`
    /// from `lexicon/hard-terms.json`. Only entries with a non-null,
    /// non-empty `ipa` ever reach this call (the web half already filters
    /// `ipa: null` lexicon entries out -- see that file's header for why a
    /// null ipa must never become a guessed override).
    @objc func speak(_ call: CAPPluginCall) {
        guard let text = call.getString("text"), !text.isEmpty else {
            var result = JSObject()
            result["ok"] = false
            result["platform"] = "ios"
            result["reason"] = "empty text"
            call.resolve(result)
            return
        }

        let overrides = call.getArray("ipaOverrides", JSObject.self) ?? []
        let attributed = NSMutableAttributedString(string: text)

        var appliedCount = 0
        /* Character OFFSETS from JS are Unicode scalar/UTF-16-adjacent
           positions into a JS string; NSAttributedString indexes by UTF-16
           code unit too, which is the same encoding JS strings use
           internally, so start/end map directly without a transcoding step.
           Bounds are still checked defensively -- a lexicon entry computed
           against a slightly different copy of the text (a caller bug, not
           an expected path) must not crash a live narration call. */
        let utf16Length = (text as NSString).length
        for entry in overrides {
            guard
                let ipa = entry["ipa"] as? String, !ipa.isEmpty,
                let start = entry["start"] as? Int,
                let end = entry["end"] as? Int,
                start >= 0, end <= utf16Length, start < end
            else { continue }
            let range = NSRange(location: start, length: end - start)
            attributed.addAttribute(.init(AVSpeechSynthesisIPANotationAttribute), value: ipa, range: range)
            appliedCount += 1
        }

        let utterance = AVSpeechUtterance(attributedString: attributed)

        /* VOICE. See the "Voice selection" MARK above for why this is eight
           lines instead of the one it used to be. The short version: the line
           that stood here was `utterance.voice = AVSpeechSynthesisVoice(language: lang)`,
           which asks for the system DEFAULT voice — the compact/legacy tier —
           and asked for nothing at all when no `lang` was passed.

           The order below is deliberate and each step is a real fallback, not
           defensive noise:
             1. the resolved voice (an explicitly requested identifier, else the
                best-installed tier for the language),
             2. failing that — `AVSpeechSynthesisVoice(identifier:)` returning
                nil for an identifier `speechVoices()` just handed us should be
                impossible, but "impossible" here would mean SILENCE — the
                language default, i.e. exactly the old behaviour,
             3. failing that, `utterance.voice` stays as the framework left it
                and the synthesiser picks for itself.
           Nothing in this ladder can stop the utterance from being spoken. */
        let language = Self.effectiveLanguage(call.getString("lang"))
        let installed = Self.installedVoices()
        let systemDefaultName = AVSpeechSynthesisVoice(language: language)?.name
        let resolution = Self.resolveVoice(
            among: installed,
            requested: call.getString("voice"),
            language: language,
            preferringName: systemDefaultName
        )
        if let chosen = resolution.voice, let voice = AVSpeechSynthesisVoice(identifier: chosen.identifier) {
            utterance.voice = voice
        } else if !language.isEmpty {
            utterance.voice = AVSpeechSynthesisVoice(language: language)
        }

        /* AVSpeechUtterance's own documented ranges, not this repo's
           narrator-voice.md §7 pinned values (those are ElevenLabs-specific
           settings for a different synthesis path entirely) -- pitch/volume are
           the framework's own [0.5, 2.0] / [0.0, 1.0], and a caller passing an
           out-of-range value for either is clamped by the framework itself;
           nothing here re-validates those two.

           RATE IS THE EXCEPTION, and it always was -- it is the one field whose
           incoming UNIT differs from the framework's. See
           `utteranceRate(playbackMultiplier:)` above: what arrives is a playback
           MULTIPLIER, and letting the framework clamp it is exactly how 1.0x
           became AVSpeechUtteranceMaximumSpeechRate. */
        if let rate = call.getDouble("rate") {
            utterance.rate = Self.utteranceRate(playbackMultiplier: rate)
        }
        if let pitch = call.getDouble("pitch") {
            utterance.pitchMultiplier = Float(pitch)
        }
        if let volume = call.getDouble("volume") {
            utterance.volume = Float(volume)
        }

        /* Explicitly claim the shared AVAudioSession before speaking --
           docs/research/on-device-tts.md §9.1/§9.4. AVSpeechSynthesizer's
           `usesApplicationAudioSession` defaults to true, meaning it plays
           through the app's shared session rather than a private one, but
           Apple's own WWDC20 wording is "will use," not "will configure": the
           synthesizer never activates or categorizes that session itself. A
           narration-only Foray (no concurrent <audio> element already
           holding the session open, per generation-architecture.md §1.2)
           cannot rely on some other code path having already done this, so
           it is done here. `.spokenAudio` IS THE APP'S ONE MODE (the platform
           contract, docs/DECISIONS.md 2026-09-23; audit round 2, native-10):
           `ForayAudioPlugin` sets the same pair at load and on every paused
           hold, so a navigation prompt pauses-and-resumes a clip and a
           narration line alike. (This comment used to claim WebKit sets the
           same mode for <audio> automatically; it does not -- WebKit's own
           category write leaves the mode at `.default`, which is why the
           audio plugin now writes it too. Whether WebKit RESETS it when its
           element starts is a device check, `docs/ios-lock-screen.md` §8.5.)
           `try?` matches this plugin's own "every method resolves, none
           reject" rule stated in the class header: a failure to configure the
           session should not turn into a rejected promise mid-narration.
           The pair itself lives in `claimSession()`, shared with `resume()`,
           because both are guarded on the native engine's ownership (NE-16). */
        Self.claimSession()

        /* mobile-native-1: replace, never queue behind (see
           `mustFlushBeforeSpeaking`). */
        if Self.mustFlushBeforeSpeaking(isSpeaking: synthesizer.isSpeaking, isPaused: synthesizer.isPaused) {
            synthesizer.stopSpeaking(at: .immediate)
        }
        /* mobile-native-2: an id per utterance, echoed on `finished`. */
        let utteranceId = UUID().uuidString
        let audition = call.getBool("audition") ?? false
        utteranceMetaLock.lock()
        utteranceMeta[ObjectIdentifier(utterance)] = (id: utteranceId, audition: audition)
        utteranceMetaLock.unlock()
        synthesizer.speak(utterance)

        var result = JSObject()
        result["ok"] = true
        result["platform"] = "ios"
        result["accepted"] = true
        result["utteranceId"] = utteranceId
        result["overridesApplied"] = appliedCount
        result["reason"] = ""
        /* WHICH VOICE ACTUALLY SPOKE, read back off the utterance rather than
           echoing what we decided — the two can differ (fallback step 2/3
           above), and the whole reason this is reported is so a founder running
           a listening test can distinguish "this voice sounds bad" from "this
           voice was never on the device". `voiceRequested`/`voiceFallback` say
           whether an ASK was honoured; the rest describe what was HEARD. */
        result["voice"] = utterance.voice?.identifier ?? ""
        result["voiceName"] = utterance.voice?.name ?? ""
        result["voiceLanguage"] = utterance.voice?.language ?? ""
        result["voiceQuality"] = utterance.voice.map { Self.qualityLabel(rank: $0.quality.rawValue) } ?? ""
        result["voiceRequested"] = resolution.requested
        result["voiceFallback"] = resolution.didFallBack
        result["voiceReason"] = resolution.reason
        /* RESOLVED ON ACCEPT, not on completion -- `AVSpeechSynthesizer.speak()`
           enqueues; it does not block until spoken. `speak()`'s own promise
           stays accept-only: changing it to await completion would delay
           every caller by the utterance's own length for no benefit, since a
           caller that wants completion now has a purpose-built signal.
           Completion is reported separately, via
           `speechSynthesizer(_:didFinish:)` above (L-03,
           `generation-architecture.md` §7 item 3) -- same "accepted, not
           necessarily finished" distinction `ForayTtsPlugin.java` draws for
           Android's `speak()`. */
        call.resolve(result)
    }

    /// Enumerate the voices this DEVICE actually has, with the tier of each and
    /// which one `speak()` would pick if asked for nothing.
    ///
    /// This call is the reason an evaluation is possible at all. Enhanced and
    /// Premium voices are per-language downloads, so two iPhones running the
    /// same build legitimately have different catalogues, and without this there
    /// is no way for anyone — founder, support, or a future settings screen — to
    /// find out which. A bad listening result then has two indistinguishable
    /// explanations: the voice is bad, or the good voice was never downloaded.
    ///
    /// `lang` filters to that language (exact locale if anything matches it,
    /// else the whole primary subtag — the same widening `candidates()` does for
    /// selection, so the list is the list `speak()` was choosing from). Omit it
    /// and every installed voice is returned, across all languages;
    /// `defaultIdentifier` is still computed for the device's own language, so
    /// "what would I get right now?" is answerable from the unfiltered call.
    @objc func listVoices(_ call: CAPPluginCall) {
        let requestedLang = call.getString("lang")
        let language = Self.effectiveLanguage(requestedLang)
        let installed = Self.installedVoices()
        let best = Self.bestVoice(
            among: installed,
            language: language,
            preferringName: AVSpeechSynthesisVoice(language: language)?.name
        )

        let listed: [VoiceOption]
        if let requestedLang = requestedLang, !requestedLang.isEmpty {
            listed = Self.candidates(installed, language: language)
        } else {
            listed = installed
        }

        var voices = JSArray()
        for voice in Self.sortedForListing(listed) {
            var entry = JSObject()
            entry["identifier"] = voice.identifier
            entry["name"] = voice.name
            entry["language"] = voice.language
            entry["quality"] = Self.qualityLabel(rank: voice.qualityRank)
            entry["isDefaultChoice"] = (voice.identifier == best?.identifier)
            voices.append(entry)
        }

        var result = JSObject()
        result["ok"] = true
        result["platform"] = "ios"
        result["language"] = language
        result["voices"] = voices
        result["count"] = voices.count
        result["defaultIdentifier"] = best?.identifier ?? ""
        result["installedCount"] = installed.count
        result["reason"] = ""
        call.resolve(result)
    }

    // MARK: - NE-16: the legacy lane's session claim

    /// The `.playback` / `.spokenAudio` category and an activation, before
    /// `speak()` and `resume()` (their comments say why each needs it). Both
    /// lines are SKIPPED while the native engine owns the session
    /// (`EngineModeFlag.sessionOwnedByEngine`, set by foray-audio in the same
    /// process through the byte-identical `EngineModeFlag.swift`): its
    /// `AudioSessionOwner` is then the one owner (docs/native-engine-plan.md
    /// §4.4), and the page sends auditions through the engine instead (OQ-5).
    /// After a relinquish the flag is false and this behaves exactly as it
    /// did in build 2026092327. Returns whether it touched the session.
    @discardableResult
    static func claimSession(_ session: AVAudioSession = .sharedInstance()) -> Bool {
        guard !EngineModeFlag.sessionOwnedByEngine else { return false }
        try? session.setCategory(.playback, mode: .spokenAudio, options: [])
        try? session.setActive(true)
        return true
    }

    // MARK: - L-05: pause, resume, stop

    /* ── WHY THESE THREE EXIST (L-05, founder feedback F12) ──────────────────
       TestFlight 2026090603: "Once the on-device narration foray test starts,
       none of the pause buttons work." The cause was not in the page. This
       plugin exposed `speak`, `state` and `listVoices` and nothing else, so
       `player/queue-manager.js`'s pause effect could only ever reach
       `backend.pause()` — which pauses the `<audio>` element while
       `AVSpeechSynthesizer` keeps talking. Nothing in the app could silence
       narration once it started. For a driving app that is a safety defect.

       THE THREE FRAMEWORK CALLS, AND THE BOUNDARY EACH USES.
       `pauseSpeaking(at: .word)` rather than `.immediate`: resuming from a
       cut-off syllable is how a synthesizer sounds broken, and the longest a
       word costs is a few hundred milliseconds — which is inside the "within a
       second" the card asks for. `stopSpeaking(at: .immediate)` is the
       opposite trade and deliberately so: a stop is a listener asking for
       silence NOW, and finishing the word first would be the app arguing.

       `stopSpeaking` FIRES `didCancel`, NOT `didFinish`, which is the property
       that keeps this card and L-03 from fighting: `speechSynthesizer(_:didFinish:)`
       is what raises `FINISHED_EVENT`, and that event advances the queue. A
       stop that advanced the queue past the line it just silenced would turn
       every pause-then-stop into a skip. The `didCancel` handler above only
       forgets the utterance's id (mobile-native-2); it emits nothing, and that
       silence is the mechanism, which is why it is written down. */

    /// Pause the current utterance at the next word boundary.
    ///
    /// RESOLVES ALWAYS (class header). `paused: false` with the state word is
    /// the honest answer when nothing was speaking — `AVSpeechSynthesizer`
    /// returns `false` from `pauseSpeaking` in that case and inventing a
    /// success would make the page's own state machine wrong.
    @objc func pause(_ call: CAPPluginCall) {
        let accepted = synthesizer.isSpeaking && !synthesizer.isPaused
            ? synthesizer.pauseSpeaking(at: .word)
            : false
        resolveTransport(call, accepted: accepted)
    }

    /// Continue a paused utterance from where it stopped.
    @objc func resume(_ call: CAPPluginCall) {
        /* The session may have been taken while we were paused (a call, another
           app) — `continueSpeaking()` on a session we no longer hold is silent.
           Re-asserting the category and activation here is safe in a way the
           equivalent call in `ForayAudioPlugin.setNowPlaying` is NOT: that one
           sits on `render()`'s 4 Hz hot path and re-interrupting WebKit there
           was the F11/F13 pause loop. This runs once per listener press. */
        Self.claimSession()
        let accepted = synthesizer.isPaused ? synthesizer.continueSpeaking() : false
        resolveTransport(call, accepted: accepted)
    }

    /// Stop speaking and discard everything queued.
    ///
    /// `stopAndClose` in `player/client.js` is the caller that matters: closing
    /// the player must not leave a voice talking into a car.
    @objc func stop(_ call: CAPPluginCall) {
        let accepted = synthesizer.isSpeaking || synthesizer.isPaused
            ? synthesizer.stopSpeaking(at: .immediate)
            : false
        resolveTransport(call, accepted: accepted)
    }

    private func resolveTransport(_ call: CAPPluginCall, accepted: Bool) {
        var result = JSObject()
        result["ok"] = true
        result["platform"] = "ios"
        result["accepted"] = accepted
        result["state"] = currentStateWord()
        result["reason"] = accepted ? "" : "nothing to act on"
        call.resolve(result)
    }

    /// `speaking | paused | idle`, from the synthesizer's two booleans.
    ///
    /// ORDER MATTERS AND IS NOT ARBITRARY: `isSpeaking` stays TRUE while
    /// paused (Apple's documented behaviour — a paused synthesizer is still
    /// "speaking" an utterance), so reading `isSpeaking` first would report a
    /// paused synthesizer as speaking and the lock screen would show a pause
    /// button for audio that is already silent. `isPaused` is therefore
    /// checked first. Pure and `internal` so `ForayTtsPluginTests` can pin the
    /// precedence without a synthesizer.
    static func stateWord(isSpeaking: Bool, isPaused: Bool) -> String {
        if isPaused { return STATE_PAUSED }
        if isSpeaking { return STATE_SPEAKING }
        return STATE_IDLE
    }

    private func currentStateWord() -> String {
        Self.stateWord(isSpeaking: synthesizer.isSpeaking, isPaused: synthesizer.isPaused)
    }

    @objc func state(_ call: CAPPluginCall) {
        var result = JSObject()
        result["platform"] = "ios"
        result["speaking"] = synthesizer.isSpeaking
        result["paused"] = synthesizer.isPaused
        /* The word, ALONGSIDE the two booleans rather than instead of them.
           `state()` shipped with the pair and something may already read it;
           L-05 needs one value the page can put in a switch. Both is cheaper
           than a migration. */
        result["state"] = currentStateWord()
        call.resolve(result)
    }

    // MARK: - K-01: the bundled-voice measurement
    //
    // `docs/bundled-voice-plan.md` K-01: "a throwaway measurement path, not a
    // product feature". It answers ONE question — can this phone synthesize
    // Kokoro fast enough, in little enough memory, with the screen locked —
    // and it is deleted in K-04's cutover.
    //
    // WHAT IS HERE AND WHAT IS DELIBERATELY NOT.
    // Here: the method, the bundle lookup, the memory and lock-screen
    // readings, the refusal vocabulary, and the seam an engine plugs into.
    // Not here: ONNX Runtime, and no `Package.swift` dependency on it. That is
    // a ~16 MB binary dependency whose build nobody in this repo can verify —
    // this branch was written on Windows, `ios-build.yml`'s `ios-shell` job is
    // the only thing that compiles this file, and adding an unbuilt dependency
    // to the one package every shell build folds in would risk turning that
    // job red for a card whose own gate is a founder's phone. So the engine is
    // a REGISTERED SEAM (`probeEngine`), K-04 fills it, and until it does this
    // method resolves `ok: false, reason: "engine-absent"` — which is a real
    // finding a founder can read, not a silent zero.
    //
    // THE REASON CODES ARE A CLOSED SET shared with `player/kokoro-probe.js`'s
    // `PROBE_REASONS`. A code this file invents and that file does not know
    // degrades to `refused`, which loses the diagnosis; keep them in step.

    /// The seam (protocol at file scope, above). `nil` on every build today. K-04 sets it from its
    /// own `load()`; the XCTest target sets it to a fake to exercise the
    /// record-building below without a model.
    public static var probeEngine: KokoroProbeEngine?

    /// The bundled weights, if the build fetched them
    /// (`tools/mobile/fetch-models.mjs`). Looked up by name rather than
    /// assumed present: a build that skipped the fetch step must say
    /// `model-absent`, not crash.
    ///
    /// fp32 SINCE KV-R2 (deck D13): the only Kokoro export that is finite on
    /// Apple silicon. `fetch-models.mjs`'s iOS model pin; Android keeps q8f16.
    static let MODEL_RESOURCE = "kokoro-v1_0-fp32"
    static let MODEL_EXTENSION = "onnx"
    /// The one voice the probe bundles — `fetch-models.mjs`'s `PROBE_VOICE`.
    /// One, not three: K-01 times the graph, and the graph takes the same time
    /// whichever 256-float style vector it is handed. Which three voices SHIP
    /// is K-03's audition and K-04's cutover.
    static let VOICE_RESOURCE = "af_heart"
    /// Where `tools/mobile/inject-models.mjs` puts both. Capacitor's iOS
    /// template carries the web bundle as a folder reference at
    /// `App.app/public`, so a file placed in the generated `ios/App/App/public`
    /// after `cap sync` reaches the built app with no `.pbxproj` surgery — and
    /// a Node script editing an Xcode project file is a class of fragility this
    /// repo has so far avoided (`inject-app-icon.mjs` and `inject-splash.mjs`
    /// both write into an asset catalog, which is a directory of JSON, not a
    /// project graph). The bundle ROOT is still searched first, so a future
    /// proper resource phase needs no change here.
    static let RESOURCE_SUBDIR = "public"

    /// The probe's own serial queue (audit round 3, mobile-native-5). Two model
    /// loads and a synthesis per line used to run on the bridge's serial
    /// plugin queue, so a probe run mid-Foray held every ForayTts call behind
    /// it. Serial, so two taps queue rather than load the model twice at once.
    static let probeQueue = DispatchQueue(label: "ai.jwlabs.foura.tts.kokoroProbe", qos: .userInitiated)

    @objc func kokoroProbe(_ call: CAPPluginCall) {
        /* KV-R3: STOP THE SOAK. Answered HERE, on the bridge's thread, and
           never queued: the soak is running on `probeQueue`, and a stop sent
           there would wait out the whole 30 minutes behind it. */
        if call.getString("mode") == "stop" {
            ProbeSoakStop.shared.request()
            var stop = JSObject()
            stop["platform"] = "ios"
            stop["mode"] = "stop"
            stop["ok"] = true
            stop["reason"] = ""
            call.resolve(stop)
            return
        }
        /* PROBE v3.1: the ledger's three questions, answered HERE for the same
           reason `stop` is — a running matrix holds `probeQueue`, and the
           drawer's "Reset skipped passes" must not wait ten minutes. */
        switch call.getString("mode") {
        case "status":
            call.resolve(Self.probeStatus(ProbeLedger.shared))
            return
        case "killed-ack":
            let ids = (call.getArray("ids") as? [String]) ?? []
            var ack = JSObject()
            ack["platform"] = "ios"
            ack["mode"] = "killed-ack"
            ack["ok"] = true
            ack["reason"] = ""
            ack["removed"] = ProbeLedger.shared.acknowledge(ids: ids)
            call.resolve(ack)
            return
        case "reset":
            var reset = JSObject()
            reset["platform"] = "ios"
            reset["mode"] = "reset"
            reset["ok"] = true
            reset["reason"] = ""
            reset["cleared"] = ProbeLedger.shared.quarantine.reset()
            call.resolve(reset)
            return
        default:
            break
        }
        Self.probeQueue.async { [weak self] in
            self?.runKokoroProbe(call)
        }
    }

    private func runKokoroProbe(_ call: CAPPluginCall) {
        var result = JSObject()
        result["platform"] = "ios"

        /* KV-R3: "play the WAV this pass rendered" — no passage, no engine. */
        if call.getString("mode") == "listen" {
            call.resolve(Self.playProbeWav(pass: call.getString("pass")))
            return
        }

        // The passage, pre-phonemized, from the page. NO TEXT FRONT-END ON
        // DEVICE is the licence argument this whole deck rests on (deck §4),
        // so this method never sees a string it would have to phonemize and
        // never falls back to one.
        let passage = call.getObject("passage")
        let lines = (passage?["lines"] as? [[String: Any]]) ?? []
        if lines.isEmpty {
            result["ok"] = false
            result["reason"] = "passage-empty"
            call.resolve(result)
            return
        }
        /* KV-R2: ONE INFERENCE PER SENTENCE CHUNK, in passage order. Each
           line carries `chunks` (`phonemize.py`'s `sentence_chunks`, each
           with its own ids); a line with none is unphonemized, whatever else
           it holds. The phone never cuts a chunk itself (D3). */
        guard let idLines = Self.chunkIds(lines) else {
            result["ok"] = false
            result["reason"] = "passage-unphonemized"
            call.resolve(result)
            return
        }

        /* KV-R3: MODEL-ABSENT ONLY WHEN NEITHER ENGINE HAS ITS FILES. Each pass
           otherwise answers for itself — an ORT pass with no fp32 file, or a
           Core ML pass on a phone below iOS 17 (`coreml-requires-ios17`) or
           with no compiled stages, is that pass's refusal, and the passes that
           can run still do. */
        /* PROBE v3.1: on iOS 26.4+ Core ML is refused (`coreml-bnns-os`,
           FluidAudio #844/#889) unless the drawer's "arm Core ML (may crash)"
           switch sent `armCoreML: true`. */
        let armed = call.getBool("armCoreML") ?? false
        let coreMLRefusal = Self.coreMLRefusal(armed: armed)
        let ledger = ProbeLedger.shared
        if KokoroModelFiles.modelURL() == nil, coreMLRefusal != nil, Self.probeEngine == nil {
            result["ok"] = false
            result["reason"] = "model-absent"
            result["lookedFor"] = "\(Self.MODEL_RESOURCE).\(Self.MODEL_EXTENSION)"
            call.resolve(result)
            return
        }

        /* THE ENGINES ARE BUILT HERE, ON DEMAND, ONE PASS AT A TIME, AND
           NOWHERE ELSE. `probeEngine` stays nil on every shipping build — the
           XCTest that asserts it still does — and this is why that remains true
           AND the probe can still answer: neither runtime is touched at
           `load()`, at app start, or on any path narration reaches. */

        /* SILENT AUDIO FOR THE LENGTH OF THE RUN (`ProbeKeepAlive`), so a
           phone locked right after the tap keeps running the probe the way it
           keeps running narration. Stopped before the call resolves. */
        let keepAlive = ProbeKeepAlive()
        let keepAliveState = keepAlive.start()
        defer { keepAlive.stop() }

        if call.getString("mode") == "soak" {
            /* THE SOAK: the best background-safe pass, speed 1.5, in a loop. */
            let minutes = min(max(call.getDouble("soakMinutes") ?? Self.SOAK_MINUTES, 1), 60)
            let skipped = Set(ledger.quarantine.entries().map { $0.pass })
            let pass = KokoroProbePass.soakPass(coreMLAvailable: coreMLRefusal == nil, skipped: skipped)
            var answer: JSObject
            switch Self.buildEngine(pass, armed: armed) {
            case .refused(let reason):
                answer = Self.refusalRecord(pass: pass, speed: ProbeMath.WAV_SPEED, reason: reason)
                answer["mode"] = "soak"
            case .engine(let engine):
                defer { engine.close() }
                /* A stop tapped before this soak began is not this soak's. */
                ProbeSoakStop.shared.reset()
                answer = Self.runSoak(engine: engine, pass: pass, idLines: idLines, minutes: minutes, ledger: ledger)
            }
            answer["keepAlive"] = keepAliveState
            call.resolve(answer)
            return
        }

        /* PER-PASS FLUSH: each pass's records go to the page (`probePass`)
           the moment the pass ends — the ledger's journal has them on disk
           already — and each pass start is a row in the engine's own ring. */
        let run = probeNowMs()
        var answer = Self.measurePasses(idLines: idLines, modelURL: KokoroModelFiles.modelURL(),
                                        makeEngine: { Self.buildEngine($0, armed: armed) },
                                        ledger: ledger, run: run,
                                        wavDirectory: ProbeWav.directory(),
                                        onPassStart: { pass, order in
                                            ProbeEngineRow.post(event: "voice-pass", pass: pass, order: order, run: run)
                                        },
                                        onPassDone: { [weak self] pass, records in
                                            let stamped = records.map { r -> [String: Any] in
                                                var r = r
                                                r["keepAlive"] = keepAliveState
                                                return r as [String: Any]
                                            }
                                            self?.notifyListeners(Self.PROBE_PASS_EVENT, data: [
                                                "platform": "ios", "pass": pass.rawValue,
                                                "probeRun": Double(run), "passes": stamped,
                                            ])
                                        })
        if var records = answer["passes"] as? [JSObject] {
            for i in records.indices { records[i]["keepAlive"] = keepAliveState }
            answer["passes"] = records
        }
        call.resolve(answer)
    }

    /// The event each finished pass's records travel on (probe v3.1), the
    /// same word as `web/foray-tts.js`'s `PROBE_PASS_EVENT`.
    static let PROBE_PASS_EVENT = "probePass"

    /// `mode: "status"`: the unacknowledged kill reports (JSON text the page
    /// parses), the skip list, and whether this OS is one Core ML is gated on.
    static func probeStatus(_ ledger: ProbeLedger,
                            version: OperatingSystemVersion = ProcessInfo.processInfo.operatingSystemVersion) -> JSObject {
        var status = JSObject()
        status["platform"] = "ios"
        status["mode"] = "status"
        status["ok"] = true
        status["reason"] = ""
        status["reportsJson"] = ledger.pendingReportsJSON()
        let skipped: [[String: Any]] = ledger.quarantine.entries().map { entry in
            var o = entry.crumb.fields(prefix: "killed")
            o["pass"] = entry.pass.rawValue
            return o
        }
        status["skippedJson"] = (try? JSONSerialization.data(withJSONObject: skipped))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        status["bnnsAffected"] = ProbeCoreMLGuard.bnnsAffected(version)
        return status
    }

    /// The soak's default length (card KV-R3: "a loop for 30 minutes").
    static let SOAK_MINUTES = 30.0

    /// Every chunk's ids, in passage order, or nil when any line has no
    /// chunk ids. A line from before KV-R2 that carries only a whole-line
    /// `ids` still counts as one chunk, so an older passage measures rather
    /// than refusing — but the passage this build ships is chunked.
    static func chunkIds(_ lines: [[String: Any]]) -> [[Int]]? {
        var out: [[Int]] = []
        for line in lines {
            if let chunks = line["chunks"] as? [[String: Any]], !chunks.isEmpty {
                for chunk in chunks {
                    guard let ids = chunk["ids"] as? [Int], !ids.isEmpty else { return nil }
                    out.append(ids)
                }
            } else if let ids = line["ids"] as? [Int], !ids.isEmpty {
                out.append(ids)
            } else {
                return nil
            }
        }
        return out.isEmpty ? nil : out
    }

    /* KV-R3: the passes, the matrix and the soak live in
       `KokoroProbeMatrix.swift` (`measurePasses`, `measurePass`, `runSoak`). */

    /// A line's outcome token (L05), from its `SYNTH_REASONS` code.
    static func lineOutcome(_ reason: String?) -> String {
        guard let reason else { return "ok" }
        switch reason {
        case "inference-threw": return "threw"
        case "no-output": return "no-output"
        case "non-finite": return "nan"
        case "silent": return "silent"
        case "session-absent": return "skip"
        default: return "zero"
        }
    }

    /// `ProcessInfo.ThermalState` as the page's four words (L10).
    static func thermalToken(_ state: ProcessInfo.ThermalState) -> String {
        switch state {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        @unknown default: return "unknown"
        }
    }

    /// The hardware model identifier (`iPhone15,2`), from `utsname`. Never
    /// `UIDevice.name`, which is whatever the owner called the phone.
    static func machineIdentifier() -> String {
        var info = utsname()
        uname(&info)
        let capacity = MemoryLayout.size(ofValue: info.machine)
        return withUnsafePointer(to: info.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: capacity) { String(cString: $0) }
        }
    }

    /// A value admitted as a diagnostics TOKEN: ',' becomes '.' (DiagGate
    /// tokens exclude commas, so `iPhone15,2` is `iPhone15.2`), any other
    /// character outside `[A-Za-z0-9._-]` becomes '-', capped at 32; nil
    /// when nothing is left.
    static func machineToken(_ raw: String) -> String? {
        let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")
        let mapped = raw.replacingOccurrences(of: ",", with: ".").map { allowed.contains($0) ? $0 : "-" }
        let token = String(mapped.prefix(32))
        return token.isEmpty ? nil : token
    }

    /// The model file's length and the first 8 hex digits of its SHA-256
    /// (L08), streamed in 1 MiB chunks so 86 MB is never held at once. Nil
    /// when the file cannot be read to the end — a partial hash is not one.
    static func modelFileFacts(_ url: URL) -> (bytes: Int, sha8: String)? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        var hasher = SHA256()
        var bytes = 0
        do {
            while true {
                let chunk: Data? = try autoreleasepool { try handle.read(upToCount: 1 << 20) }
                guard let chunk, !chunk.isEmpty else { break }
                bytes += chunk.count
                hasher.update(data: chunk)
            }
        } catch {
            return nil
        }
        let sha8 = hasher.finalize().prefix(4).map { String(format: "%02x", $0) }.joined()
        return (bytes, sha8)
    }

    /// Run a UIKit read on the main thread, without deadlocking when already
    /// there — the same care `isForeground()` takes.
    static func onMain<T>(_ body: () -> T) -> T {
        if Thread.isMainThread { return body() }
        return DispatchQueue.main.sync(execute: body)
    }

    /// Peak resident bytes for this task, or 0 when the kernel refuses. Zero
    /// is turned into "not measured" by `player/kokoro-probe.js`'s
    /// `toMegabytes`/`probeVerdict`, which treats an unmeasured ceiling as a
    /// FAILURE rather than a pass — see that file's own note on why.
    ///
    /// A TRUE PEAK NOW. This returned `phys_footprint`, which is the CURRENT
    /// footprint: read after the last line, it said how much was held at the
    /// end, not the high-water mark the 400 MB ceiling is about. The kernel
    /// keeps the peak in the same `TASK_VM_INFO` answer; an older kernel that
    /// leaves it 0 falls back to the current figure. The peak is the
    /// PROCESS's since launch and cannot be reset, so a second probe run in
    /// the same app session reports the larger of the two; `baseMemoryBytes`
    /// (read before `load()`) is what tells a reader how much was already held.
    static func peakResidentBytes() -> UInt64 {
        let footprint = taskFootprint()
        return footprint.peak > 0 ? footprint.peak : footprint.current
    }

    /// `phys_footprint` (current) and `ledger_phys_footprint_peak`, or zeros
    /// when the kernel refuses.
    static func taskFootprint() -> (current: UInt64, peak: UInt64) {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let kerr: kern_return_t = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        guard kerr == KERN_SUCCESS else { return (0, 0) }
        return (info.phys_footprint, UInt64(max(0, info.ledger_phys_footprint_peak)))
    }

    /// Whether the app is frontmost right now.
    ///
    /// `UIApplication.shared` is main-thread-only, and a Capacitor plugin
    /// method runs on the bridge's own queue, so this hops. `Thread.isMainThread`
    /// is checked first because `DispatchQueue.main.sync` FROM the main thread
    /// is a deadlock, not a slow call — and a probe that hung the app would be
    /// the worst possible outcome of an instrument whose entire job is to be
    /// run once by a founder who then has to report what happened.
    ///
    /// Defaults to `true` ("frontmost", so `lockedScreenCompleted` reads
    /// false) when the state cannot be read. Unmeasured must never read as
    /// proven — the same direction `probeVerdict` fails an unmeasured RTF in.
    static func isForeground() -> Bool {
        let read: () -> Bool = { UIApplication.shared.applicationState == .active }
        if Thread.isMainThread { return read() }
        return DispatchQueue.main.sync(execute: read)
    }
}

/// One pass's memory high-water mark (KV-R2): the current `phys_footprint`,
/// polled every 10 ms on its own queue from `start()` to `stop()`. The
/// kernel's own peak cannot be reset between passes, and sampling only
/// between chunks would miss the activations that exist only DURING one —
/// which is where fp32's ~1.3 GB lived on the ARM64 VM.
final class FootprintSampler {
    private let queue = DispatchQueue(label: "ai.jwlabs.foura.tts.kokoroProbe.footprint", qos: .utility)
    private let lock = NSLock()
    private var highWater: UInt64 = 0
    private var timer: DispatchSourceTimer?

    func start(everyMs: Int = 10) {
        sample()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(everyMs), leeway: .milliseconds(2))
        timer.setEventHandler { [weak self] in self?.sample() }
        timer.resume()
        self.timer = timer
    }

    /// The high-water mark so far.
    var peak: UInt64 {
        lock.lock()
        defer { lock.unlock() }
        return highWater
    }

    /// Stop polling and return the high-water mark, one last reading included.
    func stop() -> UInt64 {
        timer?.cancel()
        timer = nil
        sample()
        return peak
    }

    private func sample() {
        let now = ForayTtsPlugin.taskFootprint().current
        lock.lock()
        if now > highWater { highWater = now }
        lock.unlock()
    }
}

/* `ProbeInFlight` (the kill marker) moved to ProbeLedger.swift, with the
   launch-time report and the quarantine that read it (probe v3.1). */

/// A flag set from a notification block and read once by the probe; locked
/// because the two run on different queues.
final class ProbeFlag {
    private let lock = NSLock()
    private var fired = false

    func set() {
        lock.lock()
        fired = true
        lock.unlock()
    }

    var value: Bool {
        lock.lock()
        defer { lock.unlock() }
        return fired
    }
}
