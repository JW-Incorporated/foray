import Foundation
import AVFAudio
import Capacitor

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
        CAPPluginMethod(name: "state", returnType: CAPPluginReturnPromise)
    ]

    private let synthesizer = AVSpeechSynthesizer()

    override public func load() {
        synthesizer.delegate = self
    }

    /// The `rate` this plugin receives is a PLAYBACK-SPEED MULTIPLIER, not a
    /// normalised rate. Its one caller is `PlayerQueueManager._speakNarration`
    /// (`player/queue-manager.js`), which passes `this._rate` — a value off
    /// `player/playback-rate.js`'s `RATES` ladder `[0.75, 1, 1.25, 1.5, 1.75, 2]`,
    /// where **1 means the listener's normal speed**. That is also exactly what
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
    ///    Apple's own naming of the constant, not from this measurement.
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
    /// **WHAT WOULD SETTLE IT: a second device reading.** Play the 99-second counting
    /// line from `tts-locked-screen-check` at the ladder's 2.0x stop and time it; this
    /// mapping predicts a rate of ≈0.658 and therefore ≈2.0x wall clock, so the line
    /// should finish in ≈50 s. If it does not, the *form* above is what is wrong, and
    /// the fix is a third anchor, not a nudge to these two. Until someone runs that,
    /// treat every value here except 1.0x as an estimate with one point behind it.
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

        if let lang = call.getString("lang"), !lang.isEmpty {
            utterance.voice = AVSpeechSynthesisVoice(language: lang)
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
           it is done here -- the same category/mode PlayerQueueManager.swift
           line 555 already sets for the (currently unused) Swift player, and
           the same one WebKit sets automatically for <audio>. `try?`
           matches this plugin's own "every method resolves, none reject"
           rule stated in the class header: a failure to configure the
           session should not turn into a rejected promise mid-narration. */
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [])
        try? AVAudioSession.sharedInstance().setActive(true)

        synthesizer.speak(utterance)

        var result = JSObject()
        result["ok"] = true
        result["platform"] = "ios"
        result["accepted"] = true
        result["overridesApplied"] = appliedCount
        result["reason"] = ""
        /* RESOLVED ON ACCEPT, not on completion -- `AVSpeechSynthesizer.speak()`
           enqueues; it does not block until spoken. A completion-aware version
           (via the delegate's didFinish callback) is real future work, not
           something this card's single proof-of-plumbing call site needs --
           same "accepted, not necessarily finished" distinction
           ForayTtsPlugin.java draws for Android's speak(). */
        call.resolve(result)
    }

    @objc func state(_ call: CAPPluginCall) {
        var result = JSObject()
        result["platform"] = "ios"
        result["speaking"] = synthesizer.isSpeaking
        result["paused"] = synthesizer.isPaused
        call.resolve(result)
    }
}
