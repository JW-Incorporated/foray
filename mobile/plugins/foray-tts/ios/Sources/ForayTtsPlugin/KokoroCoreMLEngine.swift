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
 * `ios/ThirdParty/`, and `docs/legal/third-party-notices.md` carries the
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
    static let CODES = ["cml-load", "cml-input", "cml-predict", "cml-output", "cml-nan-duration", "cml-frames-cap"]

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
        let cold = timed { self.models = self.loadAll() }
        guard models.count == KokoroCoreMLStage.allCases.count else {
            models = [:]
            return (cold, 0)
        }
        models = [:]
        let warm = timed { self.models = self.loadAll() }
        if models.count != KokoroCoreMLStage.allCases.count { models = [:] }
        return (cold, warm)
    }

    private func loadAll() -> [KokoroCoreMLStage: MLModel] {
        var out: [KokoroCoreMLStage: MLModel] = [:]
        for stage in KokoroCoreMLStage.allCases {
            guard let url = stageURLs[stage] else { return [:] }
            let config = MLModelConfiguration()
            config.computeUnits = units(for: stage)
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
        guard models.count == KokoroCoreMLStage.allCases.count else { return (0, 0, "session-absent") }
        guard ids.count > 2 else { return (0, 0, "zero-samples") }
        var stageMs = [Double](repeating: 0, count: KokoroCoreMLStage.allCases.count)
        var sampleCount = 0
        var reason: String?
        let ms = timed {
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
        lastStageMs = stageMs
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
    static func floats(_ array: MLMultiArray) -> [Float] {
        let count = array.count
        if isContiguous(array) {
            if array.dataType == .float32 {
                let p = array.dataPointer.bindMemory(to: Float.self, capacity: count)
                return Array(UnsafeBufferPointer(start: p, count: count))
            }
            if array.dataType == .float16 {
                var out = [Float](repeating: 0, count: count)
                let p = array.dataPointer.bindMemory(to: UInt16.self, capacity: count)
                out.withUnsafeMutableBufferPointer { convertF16toF32(p, $0.baseAddress!, count) }
                return out
            }
        }
        return (0..<count).map { array[$0].floatValue }
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
