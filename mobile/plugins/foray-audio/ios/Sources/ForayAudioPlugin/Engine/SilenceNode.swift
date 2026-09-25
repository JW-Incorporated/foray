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
/// behind `EngineConfig.silenceNodeEnabled`, OFF. It is enabled in a follow-up
/// only if the drive rows show a suspension inside a silent seam.
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
