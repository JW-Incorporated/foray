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
    /// where **1 means the listener's normal speed**. That is also what Android's
    /// `TextToSpeech.setSpeechRate()` means, which is why `ForayTtsPlugin.java`
    /// can pass it straight through.
    ///
    /// `AVSpeechUtterance.rate` does NOT mean that. Its scale runs from
    /// `AVSpeechUtteranceMinimumSpeechRate` to `AVSpeechUtteranceMaximumSpeechRate`
    /// with `AVSpeechUtteranceDefaultSpeechRate` (0.5) as ordinary speech — so
    /// assigning the multiplier directly, as this method did until now, turned the
    /// DEFAULT playback speed of 1.0 into `AVSpeechUtteranceMaximumSpeechRate`:
    /// every narration line in the app would have been spoken at the fastest rate
    /// the synthesiser has, on every device, for every listener who had never
    /// touched the speed control. Nobody heard it because nothing ever wired the
    /// plugin to the player (see `player/tts-bridge.js`'s header); this is fixed in
    /// the same change that wires it.
    ///
    /// Written against the framework's own constants rather than the literals
    /// 0.0/0.5/1.0 so it cannot drift if Apple ever moves them. The framework
    /// clamps out-of-range values itself; clamping here as well is what makes
    /// 2.0x land on the maximum instead of relying on that.
    ///
    /// NOT PERCEPTUALLY LINEAR, and this method does not pretend otherwise:
    /// AVSpeechSynthesizer's rate curve is its own, so 1.5 here is "half again
    /// faster than default" in the framework's units, not a measured 1.5x
    /// wall-clock speed-up. Measuring that needs a device, which is the same
    /// limit `HUMAN-ACTIONS.md` #29 exists for.
    static func utteranceRate(playbackMultiplier multiplier: Double) -> Float {
        let scaled = Double(AVSpeechUtteranceDefaultSpeechRate) * multiplier
        let minRate = Double(AVSpeechUtteranceMinimumSpeechRate)
        let maxRate = Double(AVSpeechUtteranceMaximumSpeechRate)
        return Float(min(max(scaled, minRate), maxRate))
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
