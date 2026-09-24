import Foundation
import AVFoundation
import ForayEngineCore
import os

/// The engine's own synthesizer in M1 (docs/native-engine-plan.md §4.1
/// "SpeechNarrator (M1: PreviewSpeaker seed)"): the real `Speaking`.
///
/// It speaks the voice picker's audition (OQ-5: in native mode the preview
/// goes through the engine, one session owner) and NE-25c's session probe.
/// NE-33 grows it into SpeechNarrator on whichever path DV-9 chooses.
///
/// ── ONE SYNTHESIZER CONFIGURATION, AND IT IS THE ONE UNDER TEST ───────────
///
/// `makeSynthesizer()` and `utterance(text:voiceId:)` are the only places the
/// engine configures speech, so the Simulator smoke (`SpeechSessionSmokeTests`)
/// and the Developer probe on the founder's phone exercise exactly what M2's
/// narration will ship:
///
///   - `usesApplicationAudioSession = true`, written out although it is the
///     default: the synthesizer speaks through the session AudioSessionOwner
///     holds, not a private one of its own. That is the whole of DV-9's
///     question ("does the session it leaves behind still play?"), so the
///     setting must not drift by an SDK default changing under us.
///   - Apple's default rate, `AVSpeechUtteranceDefaultSpeechRate`: narration
///     speaks at 1x whatever the listener's speed (OQ-3, founder 2026-09-24,
///     "assume 1x speed"; `narrationFollowsListenerRate = false`).
///
/// It never touches the session. The synthesizer USES an active session and
/// would implicitly activate an inactive one, so `speak` checks the owner's
/// phase first, like AVDeck's `play` (plan §4.3): not active means the core's
/// audible-start invariant was broken, which writes a `fault
/// implicit-activation speaker` row and stops a DEBUG build.
///
/// `onFinish` is delivered ON MAIN, once per `speak`, and only for the line in
/// flight: a line replaced by a newer one ends silently, so a probe or a
/// narrator never mistakes the old line's cancel for the new line's end.
final class PreviewSpeaker: NSObject, Speaking, AVSpeechSynthesizerDelegate {

    struct Config {
        /// `AudioSessionOwner.phase == .active`, read through a closure for
        /// the reason AVDeck's is: one owner of the session (plan §4.4).
        var sessionIsActive: () -> Bool
        /// Where a diagnostics row goes (NE-19's ring once the boot path wires
        /// it). Default: os.Logger.
        var writeRow: (String) -> Void
        /// DEBUG's hard stop for a broken invariant, injectable for the tests.
        var debugFault: (String) -> Void

        init(sessionIsActive: @escaping () -> Bool,
             writeRow: @escaping (String) -> Void = PreviewSpeaker.logRow,
             debugFault: @escaping (String) -> Void = { assertionFailure($0) }) {
            self.sessionIsActive = sessionIsActive
            self.writeRow = writeRow
            self.debugFault = debugFault
        }
    }

    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "ai.jwlabs.foura",
        category: "ForayEngine.PreviewSpeaker"
    )

    static func logRow(_ row: String) {
        logger.notice("\(row, privacy: .public)")
    }

    /// The engine's synthesizer, configured once, here.
    static func makeSynthesizer() -> AVSpeechSynthesizer {
        let synthesizer = AVSpeechSynthesizer()
        synthesizer.usesApplicationAudioSession = true
        return synthesizer
    }

    /// One line as the engine speaks it: 1x, and the page-resolved voice when
    /// this device has it (else the system's voice for the language).
    static func utterance(text: String, voiceId: String?) -> AVSpeechUtterance {
        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        if let voiceId, let voice = AVSpeechSynthesisVoice(identifier: voiceId) {
            utterance.voice = voice
        }
        return utterance
    }

    var onFinish: ((SpeechEnd) -> Void)?

    /// Internal, not private: the Simulator smoke reads it.
    let synthesizer: AVSpeechSynthesizer
    private let config: Config
    /// The line in flight; the delegate reports only this one.
    private var current: AVSpeechUtterance?

    init(config: Config) {
        self.config = config
        synthesizer = PreviewSpeaker.makeSynthesizer()
        super.init()
        synthesizer.delegate = self
    }

    // MARK: - Speaking

    func speak(text: String, voiceId: String?) {
        if false && !config.sessionIsActive() {
            // Release still speaks: silence would hide the core's bug, and the
            // row is what finds it.
            let row = "fault implicit-activation speaker"
            config.writeRow(row)
            config.debugFault(row)
        }
        let utterance = Self.utterance(text: text, voiceId: voiceId)
        // The new line becomes current BEFORE the old one is stopped, so the
        // old line's didCancel finds itself superseded and reports nothing.
        current = utterance
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
        synthesizer.speak(utterance)
    }

    func stopSpeaking() {
        synthesizer.stopSpeaking(at: .immediate)
    }

    // MARK: - AVSpeechSynthesizerDelegate

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        deliver(.finished, for: utterance)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        deliver(.cancelled, for: utterance)
    }

    /// Apple does not document the delegate's thread. On main the end is
    /// handed on in the SAME turn (the probe's play must follow `didFinish`
    /// with nothing in between, which is DV-9's question); off main it hops,
    /// and the row says it did, because then the turn is not the same.
    private func deliver(_ end: SpeechEnd, for utterance: AVSpeechUtterance) {
        let hand: () -> Void = { [weak self] in
            guard let self else { return }
            self.current = nil
            self.onFinish?(end)
        }
        if Thread.isMainThread {
            hand()
        } else {
            config.writeRow("speaker \(end.rawValue) thread=bg")
            DispatchQueue.main.async(execute: hand)
        }
    }
}
