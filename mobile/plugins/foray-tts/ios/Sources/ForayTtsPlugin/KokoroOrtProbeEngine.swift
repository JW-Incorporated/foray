import Foundation
import OnnxRuntimeBindings
import os

/* K-01's runtime: ONNX Runtime, driven directly, three tensors in and one out.
 *
 * ── Why this file exists at all ───────────────────────────────────────────
 * K-01 landed the probe with its engine seam EMPTY and said so:
 * "`probeEngine` is nil on every build today. K-04 fills it." The founder then
 * ran the probe on build 2026091212 and got
 *
 *     voiceProbe kokoro-probe could not measure: passage-unphonemized
 *
 * — the first of four refusals, and behind it two more waiting: `model-absent`
 * (no weights in the bundle) and `engine-absent` (no runtime). Clearing only
 * the first would have moved the founder one refusal along and cost him a
 * second trip to a locked phone. All three are cleared together or the card
 * has not moved.
 *
 * ── Why ONNX Runtime and not sherpa-onnx / MLX ────────────────────────────
 * Deck §4, unchanged: sherpa-onnx's TTS API takes TEXT and phonemizes it
 * internally with espeak-ng, which is the GPL dependency this whole design
 * exists to keep off the phone; MLX Swift is iOS 18+ and this package's floor
 * is iOS 15. ORT is MIT, takes tensors, and has nothing to say about text.
 *
 * ── What this is NOT ──────────────────────────────────────────────────────
 * NOT a narration path. It has no `speak`, no audio session, no
 * `AVAudioEngine`, and nothing in `queue-manager.js` can reach it. It answers
 * `KokoroProbeEngine` — ids in, timings out — and K-04 is where a real engine
 * with chunking, a ring buffer and a `finished` event gets designed against
 * the numbers this produces. The samples are counted and thrown away: K-01
 * measures whether the phone CAN, not what it sounds like.
 *
 * ── The graph, documented ─────────────────────────────────────────────────
 * `onnx-community/Kokoro-82M-v1.0-ONNX`: `input_ids` (int64, [1, N] with a pad
 * at each end, N ≤ 512), `style` (float32, [1, 256]), `speed` (float32, [1]);
 * one float32 output at 24 kHz. The style row is chosen by the UNPADDED id
 * count — the voice file is 510 rows of 256 floats, one per possible length —
 * which is why `ids.count - 2` appears below and why dropping a single phoneme
 * would change the voice as well as the word.
 */

/// Whether this build can even try. `false` on any build that did not fetch
/// the weights; the plugin turns that into `model-absent` before it ever
/// constructs an engine, so a founder is told which artefact is missing.
enum KokoroModelFiles {
    /// The weights, looked for where the build step puts them.
    ///
    /// TWO PLACES, IN THIS ORDER, and the order is the finding: Capacitor's
    /// iOS template carries the web bundle as a FOLDER REFERENCE at
    /// `App.app/public`, so a file dropped into the generated
    /// `ios/App/App/public` after `cap sync` ships without any Xcode project
    /// surgery — that is what `tools/mobile/inject-models.mjs` does and it is
    /// the only injection point in the generated project that does not mean
    /// editing a `.pbxproj` from a Node script. The bundle root is tried
    /// FIRST anyway, so that if K-04 later adds a proper resource build phase
    /// this code needs no change to prefer it.
    static func modelURL() -> URL? {
        if let root = Bundle.main.url(forResource: ForayTtsPlugin.MODEL_RESOURCE,
                                      withExtension: ForayTtsPlugin.MODEL_EXTENSION) {
            return root
        }
        return Bundle.main.url(forResource: ForayTtsPlugin.MODEL_RESOURCE,
                               withExtension: ForayTtsPlugin.MODEL_EXTENSION,
                               subdirectory: ForayTtsPlugin.RESOURCE_SUBDIR)
    }

    /// The style matrix for the one voice the probe bundles.
    static func voiceURL() -> URL? {
        if let root = Bundle.main.url(forResource: ForayTtsPlugin.VOICE_RESOURCE, withExtension: "bin") {
            return root
        }
        return Bundle.main.url(forResource: ForayTtsPlugin.VOICE_RESOURCE,
                               withExtension: "bin",
                               subdirectory: ForayTtsPlugin.RESOURCE_SUBDIR)
    }
}

/// The probe's ONNX Runtime engine. One instance per probe run.
final class KokoroOrtProbeEngine: KokoroProbeEngine {
    /// Kokoro v1.0 emits 24 kHz. Hard-coded rather than read from the graph
    /// because the graph does not carry it — it is a property of the model
    /// card, and a wrong value here would scale every RTF by the ratio without
    /// changing anything a reader could see.
    static let SAMPLE_RATE: Double = 24_000

    /// The style matrix's shape, from the voice file's own length:
    /// 510 * 256 * 4 = 522,240 bytes, which is what
    /// `tools/mobile/fetch-models.mjs` pins and what its test asserts.
    static let STYLE_ROWS = 510
    static let STYLE_DIM = 256

    private static let log = Logger(subsystem: "ai.jwlabs.foura", category: "kokoro-probe")

    private let modelPath: String
    private let style: [Float]
    private var session: ORTSession?
    private var env: ORTEnv?
    private var loadColdMs: Double = 0
    private var loadWarmMs: Double = 0
    private var providerName = "cpu"

    let modelName = "kokoro-82m-v1.0-q8f16"
    var provider: String { providerName }

    /// `nil` when anything needed is absent or malformed. A FAILED
    /// CONSTRUCTION IS NOT A CRASH and not a zero: the plugin reports
    /// `engine-absent`, which is one of the four closed reason codes a founder
    /// reads off the screen.
    init?() {
        guard let model = KokoroModelFiles.modelURL(), let voice = KokoroModelFiles.voiceURL() else {
            return nil
        }
        guard let raw = try? Data(contentsOf: voice) else { return nil }
        let expected = Self.STYLE_ROWS * Self.STYLE_DIM * MemoryLayout<Float>.size
        guard raw.count == expected else {
            /* A voice file of the wrong length is a build that fetched
               something else. Refusing beats synthesizing with 256 floats read
               from the middle of an unrelated file, which would produce sound
               and therefore a number. */
            Self.log.error("voice file is \(raw.count) bytes, expected \(expected)")
            return nil
        }
        self.modelPath = model.path
        self.style = raw.withUnsafeBytes { buf in
            Array(buf.bindMemory(to: Float.self))
        }
    }

    /// Load the model twice. The first is the cold figure a listener pays on
    /// first use; the second is what warm re-entry costs, which is the number
    /// deck §5 item 6's "load at app start and keep the session warm"
    /// mitigation actually turns on.
    func load() -> (coldMs: Double, warmMs: Double) {
        loadColdMs = timed { self.session = self.makeSession() }
        loadWarmMs = timed { _ = self.makeSession() }
        return (loadColdMs, loadWarmMs)
    }

    private func makeSession() -> ORTSession? {
        do {
            let env = try ORTEnv(loggingLevel: ORTLoggingLevel.warning)
            let options = try ORTSessionOptions()
            try options.setIntraOpNumThreads(0)   // 0 = ORT picks, per the C API
            try options.setGraphOptimizationLevel(ORTGraphOptimizationLevel.all)
            self.env = env
            providerName = "cpu"
            return try ORTSession(env: env, modelPath: modelPath, sessionOptions: options)
        } catch {
            Self.log.error("could not open the Kokoro session: \(error.localizedDescription)")
            return nil
        }
    }

    /// One line. Returns `(0, 0)` on any failure — which `kokoro-probe.js`
    /// turns into an unmeasured RTF, and `probeVerdict` fails an unmeasured
    /// RTF rather than passing it.
    func synthesize(ids: [Int], speed: Double) -> (synthMs: Double, audioSec: Double) {
        guard let session, ids.count > 2 else { return (0, 0) }
        var samples = 0
        let ms = timed {
            samples = self.run(session: session, ids: ids, speed: speed)
        }
        return (ms, Double(samples) / Self.SAMPLE_RATE)
    }

    private func run(session: ORTSession, ids: [Int], speed: Double) -> Int {
        do {
            /* int64, little-endian, exactly as the graph declares. `Int` is
               64-bit on every device this ships to, but the conversion is
               written out rather than assumed because a silent truncation here
               would be a different phoneme, not a crash. */
            var tokens = ids.map { Int64($0) }
            let idsData = NSMutableData(bytes: &tokens, length: tokens.count * MemoryLayout<Int64>.size)
            let idsValue = try ORTValue(tensorData: idsData,
                                        elementType: ORTTensorElementDataType.int64,
                                        shape: [1, NSNumber(value: tokens.count)])

            /* THE STYLE ROW IS CHOSEN BY THE UNPADDED LENGTH. `ids` arrives
               with a pad at each end (`tools/narration/kokoro-vocab.json`
               documents the encoding), so the row is `count - 2`, clamped
               because a line longer than the matrix has no row of its own and
               the last row is the least wrong answer. K-04 chunks instead. */
            let row = min(max(ids.count - 2, 0), Self.STYLE_ROWS - 1)
            var styleRow = Array(style[(row * Self.STYLE_DIM)..<((row + 1) * Self.STYLE_DIM)])
            let styleData = NSMutableData(bytes: &styleRow, length: styleRow.count * MemoryLayout<Float>.size)
            let styleValue = try ORTValue(tensorData: styleData,
                                          elementType: ORTTensorElementDataType.float,
                                          shape: [1, NSNumber(value: Self.STYLE_DIM)])

            var speedValue = Float(speed)
            let speedData = NSMutableData(bytes: &speedValue, length: MemoryLayout<Float>.size)
            let speedTensor = try ORTValue(tensorData: speedData,
                                           elementType: ORTTensorElementDataType.float,
                                           shape: [1])

            /* Output names come from the GRAPH, not from a constant. The
               onnx-community export calls it `waveform`; a re-export that
               renamed it would otherwise turn into "ORT returned nothing" with
               no diagnosis attached. */
            guard let outputName = (try session.outputNames()).first else { return 0 }
            let outputs = try session.run(
                withInputs: ["input_ids": idsValue, "style": styleValue, "speed": speedTensor],
                outputNames: [outputName],
                runOptions: nil)
            guard let audio = outputs[outputName],
                  let data = try audio.tensorDataWithError() as Data? else { return 0 }
            /* The samples are COUNTED AND DROPPED. K-01 measures speed, memory
               and whether the passage survives a locked screen; what it sounds
               like is K-03's audition, rendered on a workstation from the same
               graph and the same weights. Playing it here would mean an audio
               session, which would mean this file could become the narration
               path by accident. */
            return data.count / MemoryLayout<Float>.size
        } catch {
            Self.log.error("Kokoro inference failed: \(error.localizedDescription)")
            return 0
        }
    }

    /// Wall-clock milliseconds around a block. `CACurrentMediaTime`-equivalent
    /// via a monotonic clock: `Date()` would be wrong across an NTP step, and a
    /// probe that runs for ten minutes on battery is exactly long enough for
    /// one.
    private func timed(_ body: () -> Void) -> Double {
        let start = DispatchTime.now().uptimeNanoseconds
        body()
        return Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
    }
}
