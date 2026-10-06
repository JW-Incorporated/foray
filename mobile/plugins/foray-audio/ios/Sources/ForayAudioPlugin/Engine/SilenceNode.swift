import Foundation
import AVFoundation
import ForayEngineCore

/// The part of `AVAudioEngine` SilenceNode touches. `AVSilenceEngine` is the
/// real one; the XCTests use a fake, because the property under test (how
/// long the node runs against a slow load) is a question about timers, and a
/// real engine on the Simulator would only add a sound card to it.
protocol SilenceEngineAPI: AnyObject {
    /// Start rendering. False: the engine refused.
    func start() -> Bool
    func stop()
}

/// An `AVAudioEngine` with one `AVAudioSourceNode` that renders digital
/// silence into the main mixer: TIMING ONLY (L-3). It carries no content and
/// no level; its one effect is that the process is rendering audio through
/// the engine's own active session, which is what `UIBackgroundModes: audio`
/// counts. Built on the first start (the session is active by then, and an
/// engine's output node reads the route).
final class AVSilenceEngine: SilenceEngineAPI {
    private var engine: AVAudioEngine?

    func start() -> Bool {
        let engine = self.engine ?? makeEngine()
        self.engine = engine
        do {
            try engine.start()
            return true
        } catch {
            return false
        }
    }

    func stop() {
        engine?.stop()
    }

    private func makeEngine() -> AVAudioEngine {
        let engine = AVAudioEngine()
        let format = engine.mainMixerNode.outputFormat(forBus: 0)
        // Zeros into every buffer, every cycle. The render block runs on the
        // realtime thread: it captures nothing and allocates nothing.
        let source = AVAudioSourceNode(format: format) { _, _, _, audioBufferList in
            for buffer in UnsafeMutableAudioBufferListPointer(audioBufferList) {
                if let data = buffer.mData { memset(data, 0, Int(buffer.mDataByteSize)) }
            }
            return noErr
        }
        engine.attach(source)
        engine.connect(source, to: engine.mainMixerNode, format: format)
        engine.prepare()
        return engine
    }
}

/// THE REAL `SilenceRendering` (card NE-34; docs/native-engine-plan.md §14),
/// behind `EngineConfig.silenceNodeEnabled`, OFF.
///
/// THE DECISION (card NE-46, provisional, M3): IT STAYS OFF, because
///   - App Review 2.5.4 (R21): background audio that renders nothing audible
///     is what review refuses, capped or not;
///   - no suspension inside a seam has been observed, neither in the M1 car
///     test (#114) nor in the 2026-09-28 paste;
///   - BackgroundGrace holds a task across every silent span (`seam`,
///     `prepare-miss`, `narration-handover`);
///   - NE-45 shrinks silent spans to the beat (the standby deck is prepared
///     across narration seams).
///
/// THE RULE FOR TURNING IT ON. Only if a drive paste shows at least one
/// `grace kind=late inSeam=y` row: an engine timer (the seam beat, the silence
/// cap, the narration tick, a load deadline) that fired more than
/// `NARRATION_SUSPEND_GAP_MS` (5 s) late inside a silent seam while grace was
/// held, i.e. the process was suspended DESPITE grace (EngineCore
/// `noteLateness`, on uptime AND the wall clock, because uptime stops while
/// the device sleeps; NE-38e's `suspension-in-seam` verdict reads it). The flip
/// is a one-line PR (`silenceNodeEnabled = true` in EngineBoot) that cites the
/// paste, and the NE-34 App Review note must already be in the submission
/// notes. Nothing else turns it on.
///
/// THE CAP IS THE POINT. A silence node that runs until the next item is
/// audible would keep an app with a dead network "playing" nothing for as
/// long as the load hangs, which is exactly the background audio App Review
/// refuses. So it runs for at most `INTERLUDE_CEILING_SEC` (4.5 s) from the
/// out-point REGARDLESS OF THE LOAD, measured on the engine's own clock:
/// the core arms its `.silenceCap` timer for the same span, and this stops
/// itself at `min(capMs, INTERLUDE_CEILING_SEC)` even if that timer never
/// reaches it. Past the cap only BackgroundGrace covers the seam.
///
/// And it never runs without the session: `AVAudioEngine.start()` activates
/// an inactive session by itself, so a start without the engine's session is
/// refused with a `fault kind=implicit-activation at=silence` row (the host
/// also refuses for a transport that is not running).
final class SilenceNode: SilenceRendering {

    struct Config {
        var sessionIsActive: () -> Bool
        var diag: (DiagEntry) -> Void
        var timing: EngineTiming
        var makeEngine: () -> SilenceEngineAPI = { AVSilenceEngine() }
        /// The hard cap, `INTERLUDE_CEILING_SEC` in ms.
        var ceilingMs: Double = Interlude.ceilingSec * 1000
        var debugFault: (String) -> Void = { assertionFailure($0) }
    }

    private let config: Config
    private var engine: SilenceEngineAPI?
    private var capTimer: EngineObservation?
    /// When (engine clock) the running span began.
    private var startedMono: Double?
    /// Every span this node rendered, in ms (tests and the Copy).
    private(set) var spansMs: [Double] = []

    init(config: Config) {
        self.config = config
    }

    var isRunning: Bool { startedMono != nil }

    func start(capMs: Double) -> Bool {
        guard !isRunning else { return true }
        guard config.sessionIsActive() else {
            config.diag(DiagEntry(kind: "fault", fields: [
                JSONMember("kind", .string(Vocabulary.FaultKind.implicitActivation.rawValue)),
                JSONMember("at", .string("silence"))
            ]))
            config.debugFault("fault implicit-activation silence")
            return false
        }
        let cap = Swift.min(capMs, config.ceilingMs)
        guard cap.isFinite, cap > 0 else { return refused("no-cap") }
        let engine = self.engine ?? config.makeEngine()
        self.engine = engine
        guard engine.start() else { return refused("engine") }
        startedMono = config.timing.monoMs
        capTimer = config.timing.schedule(afterMs: cap, repeating: false) { [weak self] in
            self?.halt("capped")
        }
        return true
    }

    func stop() {
        halt("stopped")
    }

    private func halt(_ why: String) {
        guard let since = startedMono else { return }
        startedMono = nil
        capTimer?.cancel()
        capTimer = nil
        engine?.stop()
        let ranMs = (config.timing.monoMs - since).rounded()
        spansMs.append(ranMs)
        config.diag(DiagEntry(kind: "silence", fields: [JSONMember("kind", .string("node")),
                                                         JSONMember("why", .string(why)),
                                                         JSONMember("ranMs", .number(ranMs))]))
    }

    private func refused(_ why: String) -> Bool {
        config.diag(DiagEntry(kind: "silence", fields: [JSONMember("kind", .string("node-refused")),
                                                         JSONMember("why", .string(why))]))
        return false
    }
}
