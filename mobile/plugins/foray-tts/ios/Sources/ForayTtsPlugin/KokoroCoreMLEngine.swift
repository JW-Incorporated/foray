import Accelerate
import CoreML
import Foundation
import os

/* KV-R3's second backend: Kokoro as SEVEN Core ML models, most of it on the
 * Apple Neural Engine (docs/voice/kokoro-speed-1.5x.md §3 option 1, §4 S5).
 *
 * ── Where this comes from, and under what licence ─────────────────────────
 * The inference chain below is VENDORED from laishere/kokoro-coreml
 * (https://github.com/laishere/kokoro-coreml, commit 484907db, Apache-2.0,
 * Copyright 2026 laishere): its `iOSDemo/iOSDemo/KokoroEngine.swift` and
 * `MLHelpers.swift` — the ~160 lines that run the seven stages in order from
 * token ids and a style row. The boundary conversions (fp16 <-> fp32 between
 * stages), the non-finite-duration guard and the zeroed tail slack on every
 * input buffer follow FluidAudio's productized copy of the same chain
 * (https://github.com/FluidInference/FluidAudio, commit 20d4f0bd,
 * `Sources/FluidAudio/TTS/KokoroAne/Pipeline/`, Apache-2.0, Copyright
 * FluidInference). Both licence texts ship beside this package in
 * `docs/legal/licenses/`, and `docs/legal/third-party-notices.md` carries the
 * notice. VENDORED, NOT DEPENDED ON (§2 item 5): FluidAudio as a SwiftPM
 * dependency would force this package's floor to iOS 17 for every listener,
 * and it crashed on first synthesis on a macOS 15 VM (§2 item 8).
 *
 * What was changed, as Apache-2.0 §4(b) asks:
 *   - input is OUR token ids (tools/narration/kokoro-vocab.json, the same
 *     table as the chain's vocab.json, id for id) and OUR af_heart style row,
 *     chosen exactly as the ORT engine chooses it (`ids.count - 2`), so the
 *     two engines render identical inputs and differ only in the runtime;
 *   - each stage's compute units come from the probe PASS (`units(for:)`),
 *     not from constants;
 *   - errors are closed tokens (`cml-*`), never a message, and a failure
 *     names its stage;
 *   - per-stage milliseconds are kept for the record (§5 item 6).
 *
 * ── The models ─────────────────────────────────────────────────────────────
 * `tools/mobile/fetch-models.mjs` pins the seven COMPILED stages
 * (`.mlmodelc`, FluidInference/kokoro-82m-coreml at a fixed commit) file by
 * file, and `inject-models.mjs` puts them in `App.app/public/kokoro-coreml/`.
 * Built for iOS 17 (`minimum_deployment_target=iOS17`), which is why this
 * class is `@available(iOS 17.0, *)`: below it the pass records
 * `coreml-requires-ios17` and never touches Core ML.
 *
 * ── What this is NOT ──────────────────────────────────────────────────────
 * Not a narration path, exactly like `KokoroOrtProbeEngine`: no audio
 * session, no playback. It is built when a founder taps the probe and
 * released when the pass ends.
 */

/// The seven stages, in chain order. The raw value is the stage's token in a
/// failure (`cmlStage`) and its column in `stageMs`.
public enum KokoroCoreMLStage: String, CaseIterable {
    case albert, postAlbert, alignment, prosody, noise, vocoder, tail

    /// The compiled model's directory name (`fetch-models.mjs`'s
    /// `COREML_STAGES`). The `_v2` Prosody/Noise/Tail are what FluidAudio
    /// ships: onset, noise-phase and level fixes over the originals.
    var bundleName: String {
        switch self {
        case .albert: return "KokoroAlbert"
        case .postAlbert: return "KokoroPostAlbert"
        case .alignment: return "KokoroAlignment"
        case .prosody: return "KokoroProsody_v2"
        case .noise: return "KokoroNoise_v2"
        case .vocoder: return "KokoroVocoder"
        case .tail: return "KokoroTail_v2"
        }
    }
}

/// Where the compiled stages are looked for: the bundle root first, then the
/// `public/kokoro-coreml/` folder the build step writes (the same two places,
/// in the same order, as `KokoroModelFiles`).
enum KokoroCoreMLFiles {
    /// `fetch-models.mjs`'s `COREML_DIR`.
    static let DIR = "kokoro-coreml"

    static func stageURL(_ stage: KokoroCoreMLStage) -> URL? {
        if let root = Bundle.main.url(forResource: stage.bundleName, withExtension: "mlmodelc", subdirectory: DIR) {
            return root
        }
        return Bundle.main.url(forResource: stage.bundleName, withExtension: "mlmodelc",
                               subdirectory: "\(ForayTtsPlugin.RESOURCE_SUBDIR)/\(DIR)")
    }

    /// Every stage's URL, or nil when any one is missing (`model-absent`).
    static func allStageURLs() -> [KokoroCoreMLStage: URL]? {
        var out: [KokoroCoreMLStage: URL] = [:]
        for stage in KokoroCoreMLStage.allCases {
            guard let url = stageURL(stage) else { return nil }
            out[stage] = url
        }
        return out
    }
}

/// Which compute units each stage asks for on each Core ML pass, as TOKENS —
/// pure, so the placement is testable without Core ML (docs/voice/
/// kokoro-speed-1.5x.md §5's table):
///   `ane`          Albert, PostAlbert, Alignment, Vocoder on CPU+ANE;
///                  Prosody, Noise, Tail on ALL (may use the GPU, which iOS
///                  blocks in the background).
///   `ane-cputail`  the same, but Prosody, Noise, Tail on the CPU only — no
///                  GPU anywhere, so iOS lets it run while the phone is locked.
///   `cml-cpu`      all seven on the CPU only.
/// `nil` for an ORT pass.
enum KokoroCoreMLPlacement {
    static func token(pass: KokoroProbePass, stage: KokoroCoreMLStage) -> String? {
        switch pass {
        case .cmlCpu:
            return "cpu"
        case .ane, .aneCputail:
            switch stage {
            case .albert, .postAlbert, .alignment, .vocoder: return "ane"
            case .prosody, .noise, .tail: return pass == .ane ? "all" : "cpu"
            }
        default:
            return nil
        }
    }

    /// The whole route in chain order, e.g. `ane,ane,ane,cpu,cpu,ane,cpu`.
    static func route(pass: KokoroProbePass) -> String? {
        let tokens = KokoroCoreMLStage.allCases.compactMap { token(pass: pass, stage: $0) }
        return tokens.count == KokoroCoreMLStage.allCases.count ? tokens.joined(separator: ",") : nil
    }

    /// Whether any stage may touch the GPU — i.e. whether iOS will let the
    /// pass run with the phone locked (docs/voice/kokoro-speed-1.5x.md §1).
    static func usesGPU(pass: KokoroProbePass) -> Bool {
        KokoroCoreMLStage.allCases.contains { token(pass: pass, stage: $0) == "all" }
    }
}

/// A chain failure, as closed tokens: the `cml-*` code and the stage.
struct KokoroCoreMLChainError: Error {
    let code: String
    let stage: KokoroCoreMLStage
}

/// The probe's Core ML engine. One instance per PASS.
@available(iOS 17.0, *)
final class KokoroCoreMLEngine: KokoroProbeEngine {
    static let SAMPLE_RATE: Double = 24_000
    /// `--max-frames` the models were converted with: a chunk whose predicted
    /// durations sum past it cannot run (`cml-frames-cap`). The probe's
    /// longest chunk is ~490 frames at speed 1.0.
    static let MAX_FRAMES = 2_000
    /// The closed failure codes, also `player/kokoro-probe.js`'s `CML_CODES`.
    ///
    /// `cml-shape` (probe v3.1): an input whose shape the stage model does not
    /// DECLARE (outside its enumerated shapes or its size range). The founder's
    /// A19 crash (build 2026092705) was libBNNS writing one byte past a 5.45 MB
    /// buffer inside `-[MLModel predictionFromFeatures:error:]`; FluidAudio
    /// #844/#889 put that on Apple's side, but an out-of-range flexible
    /// dimension is another way to get there, so such an input is refused by
    /// name before Core ML is handed it.
    static let CODES = ["cml-load", "cml-input", "cml-predict", "cml-output", "cml-nan-duration", "cml-frames-cap", "cml-shape"]

    private static let log = Logger(subsystem: "ai.jwlabs.foura", category: "kokoro-probe")

    let pass: KokoroProbePass
    private let stageURLs: [KokoroCoreMLStage: URL]
    private let style: [Float]
    private var models: [KokoroCoreMLStage: MLModel] = [:]
    private var captureSamples = false
    private var lastSamples: [Float]?

    let modelName = "kokoro-82m-v1.0-coreml7"
    var provider: String { "coreml" }
    /// ANE placement is only ASKED FOR: Core ML moves any op the Neural
    /// Engine will not take to the CPU (or GPU) without saying so. `cml-cpu`
    /// asks for the CPU alone, which is what runs.
    var providerBasis: String? { pass == .cmlCpu ? nil : "requested" }
    var acceleratorWired: Bool { pass != .cmlCpu }
    var route: String? { KokoroCoreMLPlacement.route(pass: pass) }
    private(set) var loadError: String?
    private(set) var lastFailure: KokoroProbeFailure?
    private(set) var lastStageMs: [Double]?
    /// Crash resilience: the largest input per stage and the frame count of
    /// the last chunk (`KokoroProbeEngine.lastStageInputs`/`lastFrames`).
    private(set) var lastStageInputs: [String]?
    private(set) var lastFrames: Int?
    /// Time spent in the breadcrumb during the chunk being timed (its fsyncs),
    /// taken out of the chunk's synthesis time.
    private var crumbMs = 0.0
    private var stageInputs: [String] = []
    private var frames: Int?

    /// nil when a stage or the voice is missing or malformed; the plugin then
    /// records `model-absent`/`engine-absent` for the pass.
    init?(pass: KokoroProbePass) {
        guard KokoroCoreMLPlacement.route(pass: pass) != nil,
              let urls = KokoroCoreMLFiles.allStageURLs(),
              let voice = KokoroModelFiles.voiceURL(),
              let raw = try? Data(contentsOf: voice) else { return nil }
        let expected = KokoroOrtProbeEngine.STYLE_ROWS * KokoroOrtProbeEngine.STYLE_DIM * MemoryLayout<Float>.size
        guard raw.count == expected else {
            Self.log.error("voice file is \(raw.count) bytes, expected \(expected)")
            return nil
        }
        self.pass = pass
        self.stageURLs = urls
        self.style = raw.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
    }

    /// Compute units for one stage on this pass.
    private func units(for stage: KokoroCoreMLStage) -> MLComputeUnits {
        switch KokoroCoreMLPlacement.token(pass: pass, stage: stage) {
        case "ane": return .cpuAndNeuralEngine
        case "all": return .all
        default: return .cpuOnly
        }
    }

    /// Load all seven stages twice: the COLD figure includes the first
    /// Neural Engine compile (~20 s on first use, per FluidInference), the
    /// WARM one is what a later launch pays once the compile is cached. The
    /// cold set is released before the warm one loads, so two copies never
    /// coexist (the same rule as the ORT engine).
    func load() -> (coldMs: Double, warmMs: Double) {
        loadError = nil
        lastFailure = nil
        crumbMs = 0
        let cold = timed { self.models = self.loadAll(cold: true) } - takeCrumbMs()
        guard models.count == KokoroCoreMLStage.allCases.count else {
            models = [:]
            return (cold, 0)
        }
        models = [:]
        let warm = timed { self.models = self.loadAll(cold: false) } - takeCrumbMs()
        if models.count != KokoroCoreMLStage.allCases.count { models = [:] }
        return (cold, warm)
    }

    /// The breadcrumb (`ProbeStageHook`, fsync'd by the pass in flight),
    /// timed so the caller can leave its cost out of what it measured.
    private func crumb(_ stage: String, _ model: KokoroCoreMLStage, frames: Int? = nil, inputs: String? = nil) {
        let start = DispatchTime.now().uptimeNanoseconds
        ProbeStageHook.note(stage, model.rawValue, frames: frames, inputs: inputs)
        crumbMs += Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
    }

    private func takeCrumbMs() -> Double {
        defer { crumbMs = 0 }
        return crumbMs
    }

    /// `compile` on the COLD load (the Neural Engine compile happens inside
    /// `MLModel(contentsOf:)` the first time), `load-warm` on the warm one;
    /// each stage model's crumb is written before its load begins.
    private func loadAll(cold: Bool) -> [KokoroCoreMLStage: MLModel] {
        var out: [KokoroCoreMLStage: MLModel] = [:]
        for stage in KokoroCoreMLStage.allCases {
            guard let url = stageURLs[stage] else { return [:] }
            let config = MLModelConfiguration()
            config.computeUnits = units(for: stage)
            crumb(cold ? "compile" : "load-warm", stage)
            do {
                out[stage] = try MLModel(contentsOf: url, configuration: config)
            } catch {
                Self.log.error("could not load \(stage.bundleName): \(error.localizedDescription)")
                loadError = "cml-load"
                lastFailure = KokoroProbeFailure(code: "cml-load", op: nil, stage: stage.rawValue)
                return [:]
            }
        }
        return out
    }

    func close() {
        models = [:]
        lastSamples = nil
    }

    func setCaptureSamples(_ on: Bool) {
        captureSamples = on
        if !on { lastSamples = nil }
    }

    func takeLastSamples() -> [Float]? {
        defer { lastSamples = nil }
        return lastSamples
    }

    func synthesize(ids: [Int], speed: Double) -> (synthMs: Double, audioSec: Double, reason: String?) {
        lastFailure = nil
        lastStageMs = nil
        lastStageInputs = nil
        lastFrames = nil
        crumbMs = 0
        stageInputs = [String](repeating: "-", count: KokoroCoreMLStage.allCases.count)
        frames = nil
        guard models.count == KokoroCoreMLStage.allCases.count else { return (0, 0, "session-absent") }
        guard ids.count > 2 else { return (0, 0, "zero-samples") }
        var stageMs = [Double](repeating: 0, count: KokoroCoreMLStage.allCases.count)
        var sampleCount = 0
        var reason: String?
        let wall = timed {
            do {
                let samples = try self.chain(ids: ids, speed: Float(speed), stageMs: &stageMs)
                sampleCount = samples.count
                reason = samples.isEmpty ? "zero-samples" : KokoroOrtProbeEngine.sampleVerdict(samples)
                if self.captureSamples, reason == nil { self.lastSamples = samples }
            } catch let failure as KokoroCoreMLChainError {
                self.lastFailure = KokoroProbeFailure(code: failure.code, op: nil, stage: failure.stage.rawValue)
                reason = "inference-threw"
            } catch {
                self.lastFailure = KokoroProbeFailure(code: "cml-predict", op: nil, stage: KokoroCoreMLStage.albert.rawValue)
                reason = "inference-threw"
            }
        }
        /* The breadcrumbs' fsyncs are not synthesis. */
        let ms = max(0, wall - takeCrumbMs())
        lastStageMs = stageMs
        lastStageInputs = stageInputs
        lastFrames = frames
        if let reason { return (ms, 0, reason) }
        return (ms, Double(sampleCount) / Self.SAMPLE_RATE, nil)
    }

    /// The seven stages, laishere's order and I/O names. `stageMs` gets each
    /// stage's prediction time (conversions between stages are in the total,
    /// not in a stage).
    private func chain(ids: [Int], speed: Float, stageMs: inout [Double]) throws -> [Float] {
        let tEnc = ids.count
        /* THE SAME STYLE ROW AS THE ORT ENGINE (`ids.count - 2`, clamped), so
           the two engines are fed identical inputs. laishere's demo indexes
           `T - 1` and FluidAudio `phonemes - 1`; neighbouring rows of a voice
           pack differ by little, and one row for both engines is what makes
           the comparison about the runtime alone. */
        let row = min(max(tEnc - 2, 0), KokoroOrtProbeEngine.STYLE_ROWS - 1)
        let dim = KokoroOrtProbeEngine.STYLE_DIM
        let half = dim / 2
        let timbre = Array(style[(row * dim)..<(row * dim + half)])        // cols 0..<128: style_timbre
        let styleS = Array(style[(row * dim + half)..<((row + 1) * dim)])  // cols 128..<256: style_s

        let tokens = ids.map { Int32(truncatingIfNeeded: $0) }
        let inputIds = try KokoroCoreMLArrays.int32([1, tEnc], tokens, stage: .albert)
        let mask = try KokoroCoreMLArrays.int32([1, tEnc], [Int32](repeating: 1, count: tEnc), stage: .albert)
        let styleS16 = try KokoroCoreMLArrays.float16([1, half], styleS, stage: .postAlbert)
        let timbre32 = try KokoroCoreMLArrays.float32([1, half], timbre, stage: .noise)
        let timbre16 = try KokoroCoreMLArrays.float16([1, half], timbre, stage: .vocoder)
        let speed16 = try KokoroCoreMLArrays.float16([1], [speed], stage: .postAlbert)

        // 1. ALBERT: the text encoder.
        let o1 = try predict(.albert, ["input_ids": inputIds, "attention_mask": mask], &stageMs)
        let bertDur = try KokoroCoreMLArrays.rebuild16(output(o1, "bert_dur", .albert), stage: .albert)

        // 2. PostAlbert: durations, d, t_en. `speed` enters the model HERE.
        let o2 = try predict(.postAlbert, ["bert_dur": bertDur, "input_ids": inputIds, "style_s": styleS16,
                                           "speed": speed16, "attention_mask": mask], &stageMs)
        let durations = KokoroCoreMLArrays.floats(try output(o2, "duration", .postAlbert))
        /* A non-finite duration would trap in `Int32(Float)` and take the app
           down (FluidAudio #738): it is a named failure instead. */
        guard durations.allSatisfy({ $0.isFinite }) else {
            throw KokoroCoreMLChainError(code: "cml-nan-duration", stage: .postAlbert)
        }
        let cap = Float(Self.MAX_FRAMES)
        let predDur = durations.map { Int32(min(max($0.rounded(), 1), cap)) }
        frames = predDur.reduce(0, { $0 + Int($1) })
        guard predDur.reduce(0, { $0 + Int($1) }) <= Self.MAX_FRAMES else {
            throw KokoroCoreMLChainError(code: "cml-frames-cap", stage: .postAlbert)
        }
        let predDurArr = try KokoroCoreMLArrays.int32([1, predDur.count], predDur, stage: .alignment)
        let d = try KokoroCoreMLArrays.rebuild16(output(o2, "d", .postAlbert), stage: .postAlbert)
        let tEn = try KokoroCoreMLArrays.rebuild16(output(o2, "t_en", .postAlbert), stage: .postAlbert)

        // 3. Alignment: length regulation.
        let o3 = try predict(.alignment, ["pred_dur": predDurArr, "d": d, "t_en": tEn], &stageMs)
        let en = try KokoroCoreMLArrays.rebuild16(output(o3, "en", .alignment), stage: .alignment)
        let asr = try KokoroCoreMLArrays.rebuild16(output(o3, "asr", .alignment), stage: .alignment)

        // 4. Prosody: F0 and N.
        let o4 = try predict(.prosody, ["en": en, "style_s": styleS16], &stageMs)
        let f0 = try output(o4, "F0", .prosody)
        let n = try output(o4, "N", .prosody)

        // 5. Noise, in fp32 (its sin(cumsum) phase collapses in fp16).
        let f0F32 = try KokoroCoreMLArrays.rebuild32(f0, stage: .noise)
        let o5 = try predict(.noise, ["F0_curve": f0F32, "style_timbre": timbre32], &stageMs)

        // 6. Vocoder, back in fp16; its `anchor` output is discarded.
        let o6 = try predict(.vocoder, [
            "asr": asr,
            "F0_curve": try KokoroCoreMLArrays.rebuild16(f0, stage: .vocoder),
            "N_pred": try KokoroCoreMLArrays.rebuild16(n, stage: .vocoder),
            "x_source_0": try KokoroCoreMLArrays.rebuild16(output(o5, "x_source_0", .noise), stage: .vocoder),
            "x_source_1": try KokoroCoreMLArrays.rebuild16(output(o5, "x_source_1", .noise), stage: .vocoder),
            "style_timbre": timbre16,
        ], &stageMs)

        // 7. Tail: conv_post + exp + sin + iSTFT, fp32, to 24 kHz samples.
        let xPre = try KokoroCoreMLArrays.rebuild32(output(o6, "x_pre", .vocoder), stage: .tail)
        let o7 = try predict(.tail, ["x_pre": xPre], &stageMs)
        return KokoroCoreMLArrays.floats(try output(o7, "audio", .tail))
    }

    private func predict(_ stage: KokoroCoreMLStage, _ inputs: [String: MLMultiArray],
                         _ stageMs: inout [Double]) throws -> MLFeatureProvider {
        guard let model = models[stage] else { throw KokoroCoreMLChainError(code: "cml-predict", stage: stage) }
        /* CRASH RESILIENCE: what this stage is about to be handed, by shape,
           kept for the record (the largest input per stage) and written to
           the breadcrumb BEFORE the predict, so a SIGSEGV inside it leaves
           the stage, the chunk and every input's shape on disk. */
        let shapes = inputs.mapValues { $0.shape.map(\.intValue) }
        if let index = KokoroCoreMLStage.allCases.firstIndex(of: stage), index < stageInputs.count,
           let largest = shapes.values.max(by: { $0.reduce(1, *) < $1.reduce(1, *) }) {
            stageInputs[index] = largest.map(String.init).joined(separator: "x")
        }
        for (name, shape) in shapes {
            if let declared = Self.declaredShape(model, input: name),
               !Self.shapeAllowed(shape, enumerated: declared.enumerated, ranges: declared.ranges) {
                Self.log.error("\(stage.bundleName) input \(name) shape \(shape) is outside the model's declared shapes")
                throw KokoroCoreMLChainError(code: "cml-shape", stage: stage)
            }
        }
        crumb("predict", stage, frames: frames, inputs: ProbeBreadcrumb.inputsToken(shapes))
        let provider: MLDictionaryFeatureProvider
        do {
            provider = try MLDictionaryFeatureProvider(dictionary: inputs.mapValues { MLFeatureValue(multiArray: $0) })
        } catch {
            throw KokoroCoreMLChainError(code: "cml-input", stage: stage)
        }
        let start = DispatchTime.now().uptimeNanoseconds
        defer {
            if let index = KokoroCoreMLStage.allCases.firstIndex(of: stage) {
                stageMs[index] += Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
            }
        }
        do {
            return try model.prediction(from: provider)
        } catch {
            Self.log.error("\(stage.bundleName) prediction failed: \(error.localizedDescription)")
            throw KokoroCoreMLChainError(code: "cml-predict", stage: stage)
        }
    }

    /// The shapes a stage model DECLARES for one input: its enumerated shapes,
    /// or its per-dimension size ranges, or nil when it declares neither (a
    /// fixed shape, which Core ML checks itself).
    static func declaredShape(_ model: MLModel, input: String) -> (enumerated: [[Int]], ranges: [ClosedRange<Int>])? {
        guard let constraint = model.modelDescription.inputDescriptionsByName[input]?.multiArrayConstraint else { return nil }
        let shape = constraint.shapeConstraint
        switch shape.type {
        case .enumerated:
            return (shape.enumeratedShapes.map { $0.map(\.intValue) }, [])
        case .range:
            /* NSRange(location: lower, length: upper - lower). LENIENT on
               purpose: an unbounded or oddly encoded upper bound admits, so
               this guard can only refuse a shape that is plainly outside. */
            let ranges = shape.sizeRangeForDimension.map { value -> ClosedRange<Int> in
                let r = value.rangeValue
                let lower = max(0, r.location)
                let span = r.length >= 0 && r.length < Int(Int32.max) ? r.length : Int(Int32.max)
                return lower...(lower + span)
            }
            return ([], ranges)
        default:
            return nil
        }
    }

    /// Whether `shape` is one a stage model declares (PURE, for XCTest): in
    /// its enumerated list when it has one, else inside every dimension's
    /// range. A rank the ranges do not describe is left to Core ML.
    static func shapeAllowed(_ shape: [Int], enumerated: [[Int]], ranges: [ClosedRange<Int>]) -> Bool {
        if !enumerated.isEmpty { return enumerated.contains(shape) }
        guard !ranges.isEmpty, ranges.count == shape.count else { return true }
        return zip(shape, ranges).allSatisfy { $1.contains($0) }
    }

    private func output(_ provider: MLFeatureProvider, _ key: String, _ stage: KokoroCoreMLStage) throws -> MLMultiArray {
        guard let value = provider.featureValue(for: key)?.multiArrayValue else {
            throw KokoroCoreMLChainError(code: "cml-output", stage: stage)
        }
        return value
    }

    private func timed(_ body: () -> Void) -> Double {
        let start = DispatchTime.now().uptimeNanoseconds
        body()
        return Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
    }
}

/// MLMultiArray builders and fp16 <-> fp32 conversions for the chain
/// (laishere's `MLHelpers.swift`, with FluidAudio's stride-aware reads and
/// tail slack). Every array this builds owns a zeroed buffer `TAIL_SLACK`
/// bytes longer than its data: FluidAudio found CPU-routed BNNS kernels read a
/// few bytes past the end of an input, which segfaults when the data ends on
/// a page boundary (their #889 class, OS 27). Harmless where it is not needed.
@available(iOS 17.0, *)
enum KokoroCoreMLArrays {
    static let TAIL_SLACK = 16_384

    static func make(_ shape: [Int], _ type: MLMultiArrayDataType, stage: KokoroCoreMLStage) throws -> MLMultiArray {
        let elementSize: Int
        switch type {
        case .float16: elementSize = 2
        case .float32, .int32: elementSize = 4
        default: elementSize = 8
        }
        let count = shape.reduce(1, *)
        let bytes = count * elementSize + TAIL_SLACK
        let buffer = UnsafeMutableRawPointer.allocate(byteCount: bytes, alignment: 64)
        buffer.initializeMemory(as: UInt8.self, repeating: 0, count: bytes)
        var strides = [Int](repeating: 1, count: shape.count)
        if shape.count > 1 {
            for i in stride(from: shape.count - 2, through: 0, by: -1) { strides[i] = strides[i + 1] * shape[i + 1] }
        }
        do {
            return try MLMultiArray(dataPointer: buffer, shape: shape.map { NSNumber(value: $0) }, dataType: type,
                                    strides: strides.map { NSNumber(value: $0) }, deallocator: { $0.deallocate() })
        } catch {
            buffer.deallocate()
            throw KokoroCoreMLChainError(code: "cml-input", stage: stage)
        }
    }

    static func int32(_ shape: [Int], _ values: [Int32], stage: KokoroCoreMLStage) throws -> MLMultiArray {
        let array = try make(shape, .int32, stage: stage)
        let dst = array.dataPointer.bindMemory(to: Int32.self, capacity: values.count)
        values.withUnsafeBufferPointer { dst.update(from: $0.baseAddress!, count: values.count) }
        return array
    }

    static func float32(_ shape: [Int], _ values: [Float], stage: KokoroCoreMLStage) throws -> MLMultiArray {
        let array = try make(shape, .float32, stage: stage)
        let dst = array.dataPointer.bindMemory(to: Float.self, capacity: values.count)
        values.withUnsafeBufferPointer { dst.update(from: $0.baseAddress!, count: values.count) }
        return array
    }

    static func float16(_ shape: [Int], _ values: [Float], stage: KokoroCoreMLStage) throws -> MLMultiArray {
        let array = try make(shape, .float16, stage: stage)
        let dst = array.dataPointer.bindMemory(to: UInt16.self, capacity: values.count)
        values.withUnsafeBufferPointer { convertF32toF16($0.baseAddress!, dst, values.count) }
        return array
    }

    /// A model output as a fresh fp16 array of the same shape.
    static func rebuild16(_ source: MLMultiArray, stage: KokoroCoreMLStage) throws -> MLMultiArray {
        let shape = source.shape.map(\.intValue)
        let count = shape.reduce(1, *)
        let dst = try make(shape, .float16, stage: stage)
        let out = dst.dataPointer.bindMemory(to: UInt16.self, capacity: count)
        if isContiguous(source), source.dataType == .float16 {
            memcpy(dst.dataPointer, source.dataPointer, count * MemoryLayout<UInt16>.size)
        } else if isContiguous(source), source.dataType == .float32 {
            convertF32toF16(source.dataPointer.bindMemory(to: Float.self, capacity: count), out, count)
        } else {
            let values = floats(source)
            values.withUnsafeBufferPointer { convertF32toF16($0.baseAddress!, out, count) }
        }
        return dst
    }

    /// A model output as a fresh fp32 array of the same shape.
    static func rebuild32(_ source: MLMultiArray, stage: KokoroCoreMLStage) throws -> MLMultiArray {
        let shape = source.shape.map(\.intValue)
        let count = shape.reduce(1, *)
        let dst = try make(shape, .float32, stage: stage)
        let values = floats(source)
        let out = dst.dataPointer.bindMemory(to: Float.self, capacity: count)
        values.withUnsafeBufferPointer { out.update(from: $0.baseAddress!, count: min(count, values.count)) }
        return dst
    }

    /// Any output as flat fp32 values, in logical (row-major) order.
    ///
    /// A STRIDED output (the Neural Engine pads rows to its alignment, which
    /// is why FluidAudio reads by stride) is gathered by stride here, raw,
    /// then converted — not read through `array[i]`, whose linear index is
    /// not documented to honour strides, and which boxes one NSNumber per
    /// element: ~1.8 M of them for the vocoder's input, inside the timed
    /// synthesis, would be measuring Foundation rather than the engine.
    static func floats(_ array: MLMultiArray) -> [Float] {
        let count = array.count
        let contiguous = isContiguous(array)
        switch array.dataType {
        case .float32:
            if contiguous {
                let p = array.dataPointer.bindMemory(to: Float.self, capacity: count)
                return Array(UnsafeBufferPointer(start: p, count: count))
            }
            return gather(array, as: Float.self)
        case .float16:
            let raw: [UInt16]
            if contiguous {
                let p = array.dataPointer.bindMemory(to: UInt16.self, capacity: count)
                raw = Array(UnsafeBufferPointer(start: p, count: count))
            } else {
                raw = gather(array, as: UInt16.self)
            }
            guard !raw.isEmpty else { return [] }
            var out = [Float](repeating: 0, count: raw.count)
            raw.withUnsafeBufferPointer { src in
                out.withUnsafeMutableBufferPointer { convertF16toF32(src.baseAddress!, $0.baseAddress!, raw.count) }
            }
            return out
        default:
            return (0..<count).map { array[$0].floatValue }
        }
    }

    /// The elements of a (possibly strided) array in logical row-major order,
    /// as raw `T`, walking the shape and adding up each index × its stride.
    static func gather<T>(_ array: MLMultiArray, as _: T.Type) -> [T] {
        let shape = array.shape.map(\.intValue)
        let strides = array.strides.map(\.intValue)
        let count = array.count
        guard count > 0, shape.count == strides.count, !shape.isEmpty else { return [] }
        var maxOffset = 0
        for d in shape.indices { maxOffset += (shape[d] - 1) * strides[d] }
        let src = array.dataPointer.bindMemory(to: T.self, capacity: maxOffset + 1)
        var out: [T] = []
        out.reserveCapacity(count)
        var index = [Int](repeating: 0, count: shape.count)
        var offset = 0
        for _ in 0..<count {
            out.append(src[offset])
            /* Odometer: bump the last dimension, carrying left. */
            var d = shape.count - 1
            while d >= 0 {
                index[d] += 1
                offset += strides[d]
                if index[d] < shape[d] { break }
                offset -= strides[d] * index[d]
                index[d] = 0
                d -= 1
            }
        }
        return out
    }

    /// Whether linear indexing matches the raw buffer (Core ML may hand back
    /// strided outputs; a raw copy is only right for compact row-major ones).
    static func isContiguous(_ array: MLMultiArray) -> Bool {
        let shape = array.shape.map(\.intValue)
        let strides = array.strides.map(\.intValue)
        guard shape.count == strides.count else { return false }
        var expected = 1
        for (dimension, stride) in zip(shape.reversed(), strides.reversed()) {
            if dimension > 1, stride != expected { return false }
            expected *= max(dimension, 1)
        }
        return true
    }

    private static func convertF32toF16(_ src: UnsafePointer<Float>, _ dst: UnsafeMutablePointer<UInt16>, _ count: Int) {
        guard count > 0 else { return }
        var from = vImage_Buffer(data: UnsafeMutableRawPointer(mutating: src), height: 1,
                                 width: vImagePixelCount(count), rowBytes: count * MemoryLayout<Float>.size)
        var to = vImage_Buffer(data: UnsafeMutableRawPointer(dst), height: 1,
                               width: vImagePixelCount(count), rowBytes: count * MemoryLayout<UInt16>.size)
        vImageConvert_PlanarFtoPlanar16F(&from, &to, 0)
    }

    private static func convertF16toF32(_ src: UnsafePointer<UInt16>, _ dst: UnsafeMutablePointer<Float>, _ count: Int) {
        guard count > 0 else { return }
        var from = vImage_Buffer(data: UnsafeMutableRawPointer(mutating: src), height: 1,
                                 width: vImagePixelCount(count), rowBytes: count * MemoryLayout<UInt16>.size)
        var to = vImage_Buffer(data: UnsafeMutableRawPointer(dst), height: 1,
                               width: vImagePixelCount(count), rowBytes: count * MemoryLayout<Float>.size)
        vImageConvert_Planar16FtoPlanarF(&from, &to, 0)
    }
}
