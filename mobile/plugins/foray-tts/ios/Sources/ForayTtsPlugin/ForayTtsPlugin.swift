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
           settings for a different synthesis path entirely) -- rate is
           [AVSpeechUtteranceMinimumSpeechRate, AVSpeechUtteranceMaximumSpeechRate]
           and pitch/volume are the framework's own [0.5, 2.0] / [0.0, 1.0]. A
           caller passing an out-of-range value is clamped by the framework
           itself; nothing here re-validates that. */
        if let rate = call.getDouble("rate") {
            utterance.rate = Float(rate)
        }
        if let pitch = call.getDouble("pitch") {
            utterance.pitchMultiplier = Float(pitch)
        }
        if let volume = call.getDouble("volume") {
            utterance.volume = Float(volume)
        }

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
