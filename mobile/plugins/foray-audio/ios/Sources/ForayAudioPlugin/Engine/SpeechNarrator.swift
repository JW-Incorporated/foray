import Foundation
import AVFoundation
import ForayEngineCore

// ── SPEECHNARRATOR: THE ENGINE'S ONE SYNTHESIZER (card NE-33) ──────────────
//
// docs/native-engine-plan.md §14 NE-33. The real `Speaking`: it speaks the
// voice picker's audition (OQ-5, moved here from M1's PreviewSpeaker), the
// Developer session probe's line (NE-25c), and every line of a Foray's
// narration the core asks for (`narrate`), answering with the core's
// `NarratorEvent`s keyed by the utterance `seq`.
//
// ── THE PATH DV-9 CHOSE ─────────────────────────────────────────────────────
//
// DV-9 asks whether the session an `AVSpeechSynthesizer` leaves after
// `didFinish` still lets a deck play on a locked phone. It is answered by the
// Developer probe's `probe kind=speech-then-play` row from the founder's
// phone (docs/ios-native-engine-measurements.md §11.2), and when this card was
// written NO such row had been recorded. The card's rule for that case: "If
// not, or if DV-9 is inconclusive: write(_:toBufferCallback:) into
// AVAudioEngine plus AVAudioPlayerNode, with the same NarratorEvents, and
// AVSpeech behind a flag." So:
//
//   - `.pcm` (the default): `PcmOutput`. The synthesizer only RENDERS
//     (`write(_:toBufferCallback:)`); the audio is played by this engine's own
//     `AVAudioPlayerNode` on the application session the core activated. Pause
//     and resume are the player's (`pause()`, `play()`): the same line,
//     continued, never re-spoken. A player pauses at a sample, not at a word:
//     the one thing the PCM path gives up (`pauseSpeaking(at: .word)` is the
//     synthesizer's own and has no PCM equivalent).
//   - `.direct` (`EngineConfig.speechDirect`, OFF): `DirectOutput`, the
//     synthesizer speaking on the application session itself
//     (`usesApplicationAudioSession = true`), `pauseSpeaking(at: .word)`,
//     `continueSpeaking()`. The NE-25c smoke runs this path by name.
//
// Either way it NEVER TOUCHES THE SESSION: no category, no activation. The
// synthesizer and the player USE an active session and would implicitly
// activate an inactive one, so every audible start (`speak`, `narrate(.speak)`,
// `narrate(.resume)`) checks the owner's phase first, like AVDeck's `play`:
// not active means the core's audible-start invariant was broken, which
// writes a `fault kind=implicit-activation at=speaker` row and stops a DEBUG
// build (release still speaks: silence would hide the bug).
//
// ── WHICH VOICE, AND HOW A HARD TERM IS SAID ───────────────────────────────
//
// `SpeechRules` (the core; byte-identical in foray-tts): the requested voice
// (the page's choice, or on a cold path the restore record's `voiceId`), else
// the DEFAULT RULE (`pickDefaultVoice`, Samantha's best installed tier), and
// only with no Samantha installed the synthesizer's own pick (`bestVoice`). A
// requested voice that is not installed is spoken in the fallback and
// reported (`started(voiceFallback: true)`). The bundled lexicon
// (`SpeechLexicon`) marks each hard term with its IPA.
//
// ── WHAT IT REPORTS ─────────────────────────────────────────────────────────
//
//   speak(seq)   -> `started(seq, voiceFallback)` at once (the line is
//                   accepted; `failed` only for an empty line), later
//                   `finished(seq)` when the whole line was heard.
//   pause(seq)   -> nothing (the core froze the line's clock itself).
//   resume(seq)  -> `resumed(seq, .continued)`, or `.refused` when the line is
//                   not held or the output would not restart.
//   stop(seq)    -> `cancelled(seq)`. A stop is NEVER a finish (L-05).
//   discard(seq) -> nothing: the line is dropped silently.
// A line replaced by a newer one ends SILENTLY: only the line in flight
// reports, so nobody takes an old line's end for the new one's.
//
// It opens no logger of its own (NE-19): its rows go to `Config.diag`, which
// the boot points at `EngineOutput.diag`.
final class SpeechNarrator: NSObject, Speaking {

    enum Path: String {
        /// `write(_:toBufferCallback:)` into the engine's own player (DV-9 unanswered).
        case pcm
        /// `AVSpeechSynthesizer.speak` on the application session.
        case direct
    }

    struct Config {
        var path: Path
        /// `AudioSessionOwner.phase == .active`, read through a closure: one
        /// owner of the session (plan §4.4).
        var sessionIsActive: () -> Bool
        /// Where the narrator's rows go: `EngineOutput.diag`.
        var diag: (DiagEntry) -> Void
        /// DEBUG's hard stop for a broken invariant, injectable for the tests.
        var debugFault: (String) -> Void
        /// The installed voices, read at each line (a voice downloaded while
        /// the app runs counts at the next line). Injectable for the tests.
        var installedVoices: () -> [SpeechRules.VoiceOption]
        /// The language a line is spoken in when no voice decides it.
        var language: () -> String
        /// The name of the voice the system would use for a language.
        var systemVoiceName: (String) -> String?
        /// The pronunciation lexicon.
        var lexicon: [SpeechRules.LexiconEntry]
        /// The output, for the tests: nil builds the one `path` names.
        var output: SpeechOutput?

        init(path: Path = .pcm,
             sessionIsActive: @escaping () -> Bool,
             diag: @escaping (DiagEntry) -> Void,
             debugFault: @escaping (String) -> Void = { assertionFailure($0) },
             installedVoices: @escaping () -> [SpeechRules.VoiceOption] = { SpeechNarrator.installedVoices() },
             language: @escaping () -> String = { AVSpeechSynthesisVoice.currentLanguageCode() },
             systemVoiceName: @escaping (String) -> String? = { AVSpeechSynthesisVoice(language: $0)?.name },
             lexicon: [SpeechRules.LexiconEntry] = SpeechLexicon.entries,
             output: SpeechOutput? = nil) {
            self.path = path
            self.sessionIsActive = sessionIsActive
            self.diag = diag
            self.debugFault = debugFault
            self.installedVoices = installedVoices
            self.language = language
            self.systemVoiceName = systemVoiceName
            self.lexicon = lexicon
            self.output = output
        }
    }

    // MARK: - The one synthesizer configuration

    /// The engine's synthesizer, configured once, here. Both outputs speak
    /// through it (the PCM output only renders with it).
    static func makeSynthesizer() -> AVSpeechSynthesizer {
        let synthesizer = AVSpeechSynthesizer()
        synthesizer.usesApplicationAudioSession = true
        return synthesizer
    }

    /// The utterance rate for a multiplier: 1x is Apple's own default rate
    /// (the founder's 2026-09-24 ruling: narration 1x =
    /// `AVSpeechUtteranceDefaultSpeechRate`), anything else the calibrated
    /// curve the legacy plugin uses (`PlaybackRate.utteranceRate`).
    static func speechRate(multiplier: Double) -> Float {
        multiplier == 1
            ? AVSpeechUtteranceDefaultSpeechRate
            : Float(PlaybackRate.utteranceRate(playbackMultiplier: multiplier))
    }

    /// One line as the engine speaks it: at `rate` (1x unless told), in the
    /// voice when this device has it (else the system's voice for the
    /// language), each hard term marked with its IPA.
    static func utterance(text: String, voiceId: String?, rate: Float = AVSpeechUtteranceDefaultSpeechRate,
                          overrides: [SpeechRules.IpaOverride] = []) -> AVSpeechUtterance {
        let utterance: AVSpeechUtterance
        if overrides.isEmpty {
            utterance = AVSpeechUtterance(string: text)
        } else {
            let attributed = NSMutableAttributedString(string: text)
            let length = (text as NSString).length
            for override in overrides where override.start >= 0 && override.end <= length && override.start < override.end {
                attributed.addAttribute(NSAttributedString.Key(AVSpeechSynthesisIPANotationAttribute), value: override.ipa,
                                        range: NSRange(location: override.start, length: override.end - override.start))
            }
            utterance = AVSpeechUtterance(attributedString: attributed)
        }
        utterance.rate = rate
        if let voiceId, let voice = AVSpeechSynthesisVoice(identifier: voiceId) {
            utterance.voice = voice
        }
        return utterance
    }

    /// The one place the narrator reads the framework's catalogue.
    static func installedVoices() -> [SpeechRules.VoiceOption] {
        AVSpeechSynthesisVoice.speechVoices().map {
            SpeechRules.VoiceOption(identifier: $0.identifier, name: $0.name, language: $0.language,
                                    qualityRank: $0.quality.rawValue)
        }
    }

    // MARK: - State

    var onFinish: ((SpeechEnd) -> Void)?
    var onNarratorEvent: ((NarratorEvent) -> Void)?

    private enum Owner: Equatable {
        case audition
        case narration(seq: Int)
    }

    private let config: Config
    let output: SpeechOutput
    /// The line in flight: the only one whose end is reported.
    private var current: (id: Int, owner: Owner)?
    private var nextLineId = 0
    private var paused = false
    /// What the last line was handed to the output: the tests read it.
    private(set) var lastLine: SpeechLine?

    init(config: Config) {
        self.config = config
        if let given = config.output {
            output = given
        } else if config.path == .pcm {
            output = PcmOutput(diag: config.diag)
        } else {
            output = DirectOutput(diag: config.diag)
        }
        super.init()
        output.onEnd = { [weak self] id, end in self?.ended(id, end) }
    }

    /// The synthesizer the output speaks or renders with (the NE-25c smoke
    /// reads its configuration).
    var synthesizer: AVSpeechSynthesizer? { output.synthesizer }
    /// Lines the output has audibly begun (the NE-25c smoke waits on it).
    var linesStarted: Int { output.linesStarted }

    // MARK: - Speaking: the audition

    func speak(text: String, voiceId: String?) {
        guardSession()
        begin(text: text, voiceId: voiceId, multiplier: 1, owner: .audition)
    }

    func stopSpeaking() {
        guard let line = current else {
            output.stop()
            return
        }
        current = nil
        paused = false
        output.stop()
        report(line.owner, .cancelled)
    }

    // MARK: - Speaking: the narration

    func narrate(_ command: NarrationCommand) {
        switch command {
        case let .speak(seq, text, voiceId, utteranceRate):
            guard !text.isEmpty else {
                onNarratorEvent?(.failed(seq: seq, reason: "empty text"))
                return
            }
            guardSession()
            let resolution = begin(text: text, voiceId: voiceId, multiplier: utteranceRate, owner: .narration(seq: seq))
            onNarratorEvent?(.started(seq: seq, voiceFallback: resolution.didFallBack))
        case let .pause(seq):
            guard isCurrent(seq), !paused else { return }
            if output.pause() { paused = true }
        case let .resume(seq):
            guard isCurrent(seq) else {
                onNarratorEvent?(.resumed(seq: seq, answer: .refused(reason: "not-held")))
                return
            }
            guard paused else {
                onNarratorEvent?(.resumed(seq: seq, answer: .continued))
                return
            }
            guardSession()
            if output.resume() {
                paused = false
                onNarratorEvent?(.resumed(seq: seq, answer: .continued))
            } else {
                onNarratorEvent?(.resumed(seq: seq, answer: .refused(reason: "output-refused")))
            }
        case let .stop(seq):
            if isCurrent(seq) {
                current = nil
                paused = false
                output.stop()
            }
            // A stop is never a finish (L-05), whatever the line was doing.
            onNarratorEvent?(.cancelled(seq: seq))
        case let .discard(seq):
            guard isCurrent(seq) else { return }
            current = nil
            paused = false
            output.stop()
        }
    }

    // MARK: - Internals

    private func isCurrent(_ seq: Int) -> Bool {
        current?.owner == .narration(seq: seq)
    }

    /// Resolve the voice and the hard terms, make the line current (BEFORE the
    /// old one is silenced, so the old one's end finds itself superseded), and
    /// hand it to the output.
    @discardableResult
    private func begin(text: String, voiceId: String?, multiplier: Double, owner: Owner) -> SpeechRules.VoiceResolution {
        let language = config.language()
        let resolution = SpeechRules.narrationVoice(among: config.installedVoices(), requested: voiceId,
                                                    language: language, preferringName: config.systemVoiceName(language))
        if resolution.didFallBack {
            config.diag(DiagEntry(kind: "speaker", fields: [
                JSONMember("kind", .string("voice-fallback")),
                JSONMember("chosen", .bool(resolution.voice != nil))
            ]))
        }
        nextLineId += 1
        let line = SpeechLine(text: text, voiceIdentifier: resolution.voice?.identifier,
                              rate: Self.speechRate(multiplier: multiplier),
                              overrides: SpeechRules.ipaOverrides(text, entries: config.lexicon))
        current = (nextLineId, owner)
        paused = false
        lastLine = line
        output.start(line, id: nextLineId)
        return resolution
    }

    private func ended(_ id: Int, _ end: SpeechEnd) {
        guard let line = current, line.id == id else { return }
        current = nil
        paused = false
        report(line.owner, end)
    }

    private func report(_ owner: Owner, _ end: SpeechEnd) {
        switch owner {
        case .audition:
            onFinish?(end)
        case let .narration(seq):
            onNarratorEvent?(end == .finished ? .finished(seq: seq) : .cancelled(seq: seq))
        }
    }

    private func guardSession() {
        guard !config.sessionIsActive() else { return }
        config.diag(DiagEntry(kind: "fault", fields: [
            JSONMember("kind", .string(Vocabulary.FaultKind.implicitActivation.rawValue)),
            JSONMember("at", .string("speaker"))
        ]))
        config.debugFault("fault implicit-activation speaker")
    }
}

// MARK: - The outputs

/// One line, as the narrator hands it to an output: plain values, so a test's
/// fake output can read the decision without a voice being installed.
struct SpeechLine: Equatable {
    let text: String
    let voiceIdentifier: String?
    let rate: Float
    let overrides: [SpeechRules.IpaOverride]
}

/// Where a line is heard. The narrator owns the bookkeeping (which line is
/// current, what to report); an output only renders.
protocol SpeechOutput: AnyObject {
    /// The end of line `id`, ON MAIN: `.finished` only when it was heard to
    /// its end. An output may report a line the narrator already left; the
    /// narrator ignores it.
    var onEnd: ((Int, SpeechEnd) -> Void)? { get set }
    var synthesizer: AVSpeechSynthesizer? { get }
    var linesStarted: Int { get }
    /// Speak `line` as line `id`, silencing any line in flight.
    func start(_ line: SpeechLine, id: Int)
    /// Hold the line in flight. False when there was nothing to hold.
    func pause() -> Bool
    /// Continue the held line from where it stopped. False when it cannot.
    func resume() -> Bool
    /// Silence the line in flight. Reports nothing.
    func stop()
}

/// Path A (`EngineConfig.speechDirect`): the synthesizer speaks on the
/// application session.
final class DirectOutput: NSObject, SpeechOutput, AVSpeechSynthesizerDelegate {
    var onEnd: ((Int, SpeechEnd) -> Void)?
    let speech: AVSpeechSynthesizer
    var synthesizer: AVSpeechSynthesizer? { speech }
    private(set) var linesStarted = 0
    private let diag: (DiagEntry) -> Void
    private var current: (id: Int, utterance: AVSpeechUtterance)?

    init(diag: @escaping (DiagEntry) -> Void) {
        self.diag = diag
        speech = SpeechNarrator.makeSynthesizer()
        super.init()
        speech.delegate = self
    }

    func start(_ line: SpeechLine, id: Int) {
        let utterance = SpeechNarrator.utterance(text: line.text, voiceId: line.voiceIdentifier, rate: line.rate,
                                                 overrides: line.overrides)
        current = (id, utterance)
        if speech.isSpeaking { speech.stopSpeaking(at: .immediate) }
        speech.speak(utterance)
    }

    func pause() -> Bool { speech.pauseSpeaking(at: .word) }
    func resume() -> Bool { speech.continueSpeaking() }

    func stop() {
        current = nil
        speech.stopSpeaking(at: .immediate)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        onMain { [weak self] in self?.linesStarted += 1 }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        deliver(.finished, for: utterance)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        deliver(.cancelled, for: utterance)
    }

    /// Apple does not document the delegate's thread. On main the end is
    /// handed on in the SAME turn (the probe's play must follow `didFinish`
    /// with nothing in between, which is DV-9's question); off main it hops,
    /// and a `speaker thread=bg` row says it did.
    private func deliver(_ end: SpeechEnd, for utterance: AVSpeechUtterance) {
        let hand: () -> Void = { [weak self] in
            guard let self, let line = self.current, line.utterance === utterance else { return }
            self.current = nil
            self.onEnd?(line.id, end)
        }
        if Thread.isMainThread {
            hand()
        } else {
            diag(DiagEntry(kind: "speaker", fields: [
                JSONMember("kind", .string(end.rawValue)), JSONMember("thread", .string("bg"))
            ]))
            DispatchQueue.main.async(execute: hand)
        }
    }

    private func onMain(_ work: @escaping () -> Void) {
        if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
    }
}

/// Path B (the default while DV-9 is unanswered): the synthesizer RENDERS the
/// line (`write(_:toBufferCallback:)`) and this engine's own
/// `AVAudioPlayerNode` plays it, on the session the core activated. A line is
/// finished when the synthesizer has handed over its last buffer (the empty
/// one, or its `didFinish`) AND the player has played every buffer back.
final class PcmOutput: NSObject, SpeechOutput, AVSpeechSynthesizerDelegate {
    var onEnd: ((Int, SpeechEnd) -> Void)?
    let speech: AVSpeechSynthesizer
    var synthesizer: AVSpeechSynthesizer? { speech }
    private(set) var linesStarted = 0
    private let diag: (DiagEntry) -> Void
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var attached = false
    private var connected: AVAudioFormat?
    private var configurationObserver: NSObjectProtocol?

    /// The line in flight, and what is known about it.
    private var lineId: Int?
    private var utterance: AVSpeechUtterance?
    private var scheduled = 0
    private var played = 0
    private var rendered = false
    private var held = false

    init(diag: @escaping (DiagEntry) -> Void) {
        self.diag = diag
        speech = SpeechNarrator.makeSynthesizer()
        super.init()
        speech.delegate = self
        // A route or format change stops the engine (Apple:
        // AVAudioEngineConfigurationChange). A line that was playing restarts
        // where the player stood; if it cannot, it ends CANCELLED (never a
        // finish, so the core never advances past words nobody heard).
        configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { [weak self] _ in
            self?.configurationChanged()
        }
    }

    deinit {
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }
    }

    func start(_ line: SpeechLine, id: Int) {
        silence()
        let utterance = SpeechNarrator.utterance(text: line.text, voiceId: line.voiceIdentifier, rate: line.rate,
                                                 overrides: line.overrides)
        lineId = id
        self.utterance = utterance
        speech.write(utterance) { [weak self] buffer in
            let pcm = buffer as? AVAudioPCMBuffer
            if Thread.isMainThread {
                self?.received(pcm, for: id)
            } else {
                DispatchQueue.main.async { self?.received(pcm, for: id) }
            }
        }
    }

    func pause() -> Bool {
        guard lineId != nil, !held else { return false }
        held = true
        if attached { player.pause() }
        return true
    }

    func resume() -> Bool {
        guard lineId != nil, held else { return false }
        held = false
        guard startEngine() else { return false }
        if scheduled > played { player.play() }
        return true
    }

    func stop() {
        silence()
    }

    // MARK: - Rendering and playing

    private func received(_ buffer: AVAudioPCMBuffer?, for id: Int) {
        guard id == lineId else { return }
        guard let buffer, buffer.frameLength > 0 else {
            // The empty buffer: the synthesizer has rendered the whole line.
            rendered = true
            return finishIfPlayed(id)
        }
        guard let playable = standardBuffer(buffer), connect(playable.format), startEngine() else {
            diag(DiagEntry(kind: "speaker", fields: [JSONMember("kind", .string("pcm-refused"))]))
            return end(id, .cancelled)
        }
        if scheduled == 0 { linesStarted += 1 }
        scheduled += 1
        player.scheduleBuffer(playable, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            DispatchQueue.main.async { self?.playedBack(id) }
        }
        if !held, !player.isPlaying { player.play() }
    }

    private func playedBack(_ id: Int) {
        guard id == lineId else { return }
        played += 1
        finishIfPlayed(id)
    }

    private func finishIfPlayed(_ id: Int) {
        guard rendered, played >= scheduled else { return }
        end(id, .finished)
    }

    private func end(_ id: Int, _ end: SpeechEnd) {
        guard id == lineId else { return }
        lineId = nil
        utterance = nil
        onEnd?(id, end)
    }

    /// Forget the line in flight and silence it. Nothing is reported.
    private func silence() {
        lineId = nil
        utterance = nil
        scheduled = 0
        played = 0
        rendered = false
        held = false
        if speech.isSpeaking { speech.stopSpeaking(at: .immediate) }
        if attached { player.stop() }
    }

    /// The buffer in the player's standard (deinterleaved float) format at
    /// the synthesizer's own sample rate and channel count.
    private func standardBuffer(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let standard = AVAudioFormat(standardFormatWithSampleRate: buffer.format.sampleRate,
                                           channels: buffer.format.channelCount) else { return nil }
        if buffer.format == standard { return buffer }
        guard let converter = AVAudioConverter(from: buffer.format, to: standard),
              let out = AVAudioPCMBuffer(pcmFormat: standard, frameCapacity: buffer.frameLength) else { return nil }
        do {
            try converter.convert(to: out, from: buffer)
        } catch {
            return nil
        }
        return out
    }

    private func connect(_ format: AVAudioFormat) -> Bool {
        if !attached {
            engine.attach(player)
            attached = true
        }
        if let connected, connected.sampleRate == format.sampleRate, connected.channelCount == format.channelCount {
            return true
        }
        if engine.isRunning { engine.stop() }
        engine.connect(player, to: engine.mainMixerNode, format: format)
        connected = format
        return true
    }

    private func startEngine() -> Bool {
        guard attached else { return true }
        if engine.isRunning { return true }
        engine.prepare()
        do {
            try engine.start()
            return true
        } catch {
            diag(DiagEntry(kind: "speaker", fields: [
                JSONMember("kind", .string("engine-start-failed")),
                JSONMember("error", .string((error as NSError).domain + ":" + String((error as NSError).code)))
            ]))
            return false
        }
    }

    private func configurationChanged() {
        guard let id = lineId else { return }
        diag(DiagEntry(kind: "speaker", fields: [JSONMember("kind", .string("configuration-change"))]))
        if held { return }
        if startEngine() {
            if scheduled > played { player.play() }
        } else {
            end(id, .cancelled)
        }
    }

    // MARK: - AVSpeechSynthesizerDelegate

    /// `didFinish` after a `write` is the synthesizer saying it rendered the
    /// whole line: the same as the empty buffer, whichever comes first.
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let mark: () -> Void = { [weak self] in
            guard let self, let id = self.lineId, self.utterance === utterance else { return }
            self.rendered = true
            self.finishIfPlayed(id)
        }
        if Thread.isMainThread { mark() } else { DispatchQueue.main.async(execute: mark) }
    }
}
