import AVFAudio
import Capacitor
import Foundation
import UIKit
import os

/* Probe v3 (card KV-R3, docs/voice/kokoro-speed-1.5x.md §5): the one founder
 * run that decides the narration engine for 1.5x listening.
 *
 * ── The matrix ─────────────────────────────────────────────────────────────
 * Six passes, each loading its own models and releasing them before the next
 * (`KokoroProbePass`, in run order):
 *
 *   ane          Core ML chain, Neural Engine + ALL for the fp32 tail
 *   ort-cpu-t2   fp32 ONNX Runtime, 2 intra-op threads
 *   ane-cputail  Core ML chain, Neural Engine + CPU-only tail (no GPU: the
 *                route iOS lets run while the phone is locked)
 *   ort-cpu-t3   fp32 ORT, 3 threads
 *   cml-cpu      Core ML chain, every stage CPU-only
 *   ort-cpu-t4   fp32 ORT, 4 threads
 *
 * INTERLEAVED (§5: "ort-cpu-t{2,3,4} … interleaved"), so no engine family has
 * the phone all to itself while it is cool and the other all to itself once
 * it is warm. Within a pass every sentence chunk is rendered at Kokoro speed
 * 1.0 AND 1.5, one after the other, so the two speeds share the same heat.
 *
 * ── The content basis (§1) ────────────────────────────────────────────────
 * A render at speed 1.5 is ~2/3 as long as the same text at 1.0. Dividing its
 * synthesis time by ITS OWN length (the "wall" RTF) makes speed 1.5 look
 * slower than it is for the job; the job is keeping up with a listener at
 * 1.5x, and that is synthesis seconds over the seconds the SAME TEXT lasts at
 * speed 1.0. So every speed's record carries both: `rtfContent` (the
 * decision number: ≤ 0.667 keeps up at 1.5x, ≤ 0.55 with the doc's margin)
 * and `rtfWall`. The content seconds come from THIS pass's speed-1.0 render of
 * the same chunks (`ProbeMath.summarize`).
 *
 * ── Foreground vs locked ──────────────────────────────────────────────────
 * The founder runs the matrix twice: unlocked, then locked right after the
 * tap. Each chunk samples the screen (`background`: the app is not active;
 * `locked`: protected data is unavailable, which on a passcode phone is the
 * lock screen), so the record says which run it was instead of trusting
 * memory. For the locked run to measure anything iOS must not suspend the
 * app, so the probe plays SILENT audio for its duration (`ProbeKeepAlive`) —
 * the condition narration itself runs under (the app playing audio in the
 * background, with iOS's CPU monitor watching), not a trick that flatters it.
 *
 * ── Soak (§5 item 9) ──────────────────────────────────────────────────────
 * The best background-safe pass (`ane-cputail` where Core ML runs, else
 * `ort-cpu-t2`) renders the passage at speed 1.5 in a loop for 30 minutes,
 * locked, logging each loop's RTF, footprint and heat — and the kill marker
 * (`ProbeInFlight`, stage `soak`) says how far it got if iOS ends it.
 */

/// Which engine and placement a probe pass runs (KV-R3). The raw value is
/// the record's `pass`, and `player/kokoro-probe.js`'s `PROBE_PASSES` holds
/// the same words. DECLARATION ORDER IS RUN ORDER (`allCases`): interleaved,
/// Core ML and ORT alternating.
public enum KokoroProbePass: String, CaseIterable {
    case ane
    case ortCpuT2 = "ort-cpu-t2"
    case aneCputail = "ane-cputail"
    case ortCpuT3 = "ort-cpu-t3"
    case cmlCpu = "cml-cpu"
    case ortCpuT4 = "ort-cpu-t4"

    /// The ORT intra-op thread count, or nil for a Core ML pass.
    var ortThreads: Int? {
        switch self {
        case .ortCpuT2: return 2
        case .ortCpuT3: return 3
        case .ortCpuT4: return 4
        default: return nil
        }
    }

    var isCoreML: Bool { ortThreads == nil }

    /// Whether iOS lets the pass run with the phone locked: nothing on the
    /// GPU (iOS blocks Metal in the background, §1). Only `ane` may use it.
    var backgroundSafe: Bool { !KokoroCoreMLPlacement.usesGPU(pass: self) }

    /// The soak's pass (card KV-R3 item 3): `ane-cputail` if the Core ML chain
    /// can run on this phone, else ORT at 2 threads.
    static func soakPass(coreMLAvailable: Bool) -> KokoroProbePass {
        coreMLAvailable ? .aneCputail : .ortCpuT2
    }
}

/// What `makeEngine` hands the matrix for one pass: an engine, or the closed
/// reason there is none (`coreml-requires-ios17`, `model-absent`,
/// `engine-absent`), which becomes that pass's records.
enum ProbeEngineBuild {
    case engine(KokoroProbeEngine)
    case refused(String)
}

/// One chunk at one speed, as the matrix saw it.
struct ProbeChunkReading {
    var synthMs: Double
    var audioSec: Double
    var reason: String?
    var cpuSec: Double = 0
    var stageMs: [Double]? = nil
    var background: Bool = false
    var locked: Bool = false

    /// Rendered real audio: no failure reason and a positive length.
    var rendered: Bool { reason == nil && audioSec > 0 }
}

/// One pass at one speed, folded (`ProbeMath.summarize`).
struct ProbeSpeedSummary {
    var synthColdMs = 0.0
    var audioColdSec = 0.0
    var contentColdSec = 0.0
    var synthWarmMs = 0.0
    var audioWarmSec = 0.0
    var contentWarmSec = 0.0
    var cpuWarmSec = 0.0
    var stageWarmMs: [Double]?
    var failures = 0
    var nonFinite = 0
    var silent = 0
    var outcomes: [String] = []
    var bgChunks = 0
    var lockedChunks = 0
    var firstFailure: String?

    var rtfContentWarm: Double? { ProbeMath.ratio(synthWarmMs / 1000, contentWarmSec) }
    var rtfContentCold: Double? { ProbeMath.ratio(synthColdMs / 1000, contentColdSec) }
    var rtfWallWarm: Double? { ProbeMath.ratio(synthWarmMs / 1000, audioWarmSec) }
    var cpuPerContentSec: Double? { ProbeMath.ratio(cpuWarmSec, contentWarmSec) }
}

/// One soak loop (the whole passage once, at speed 1.5).
struct ProbeSoakLoop {
    var endSec: Double
    var synthMs: Double
    var contentSec: Double
    var audioSec: Double
    var cpuSec: Double
    var peakBytes: UInt64
    var thermal: String
    var background: Bool
    var locked: Bool
    var failures: Int
    var nonFinite: Int

    var rtfContent: Double? { ProbeMath.ratio(synthMs / 1000, contentSec) }
}

/// The probe's arithmetic, PURE so XCTest can hold it (KV-R3): the content
/// basis, the verdict, and the soak's per-minute series.
enum ProbeMath {
    /// The speeds every pass renders, in render order. 1.0 FIRST: its render
    /// is the content basis for every other speed.
    static let SPEEDS: [Double] = [1.0, 1.5]
    /// The speed a pass's WAV is kept at: the listening rate.
    static let WAV_SPEED = 1.5
    /// The 1.5x target on the content basis WITH the doc's margin (§1:
    /// "≤ 0.667, or ≤ ~0.55 with margin"). `player/kokoro-probe.js`'s
    /// `TARGET_CONTENT_RTF`.
    static let TARGET_CONTENT_RTF = 0.55
    /// Break-even for 1.5x listening: 1 / 1.5.
    static let BREAK_EVEN_CONTENT_RTF = 1.0 / 1.5
    /// Below this no engine rendered anything (`kokoro-probe.js`'s RTF_FLOOR).
    static let RTF_FLOOR = 0.01

    /// a / b, or nil when either is not a real measurement.
    static func ratio(_ a: Double, _ b: Double) -> Double? {
        guard a.isFinite, b.isFinite, a >= 0, b > 0 else { return nil }
        return a / b
    }

    /// Fold one speed's chunks into its record, against `base` — the SAME
    /// pass's speed-1.0 chunks (for speed 1.0, `base` is `readings` itself).
    ///
    /// Chunk 0 is the COLD figure; chunks 1… are WARM. A warm chunk counts
    /// only when it rendered at this speed AND at 1.0, so the synthesis
    /// seconds and the content seconds are always over the same text; a
    /// failed chunk is counted as a failure instead, and fails the verdict.
    static func summarize(_ readings: [ProbeChunkReading], base: [ProbeChunkReading]) -> ProbeSpeedSummary {
        var s = ProbeSpeedSummary()
        for (index, reading) in readings.enumerated() {
            s.outcomes.append(ForayTtsPlugin.lineOutcome(reading.reason))
            if reading.background { s.bgChunks += 1 }
            if reading.locked { s.lockedChunks += 1 }
            if let reason = reading.reason {
                s.failures += 1
                if s.firstFailure == nil { s.firstFailure = reason }
                if reason == "non-finite" { s.nonFinite += 1 }
                if reason == "silent" { s.silent += 1 }
            }
            let baseRendered = index < base.count && base[index].rendered
            if index == 0 {
                s.synthColdMs = reading.synthMs
                if reading.rendered {
                    s.audioColdSec = reading.audioSec
                    s.contentColdSec = baseRendered ? base[index].audioSec : 0
                }
                continue
            }
            guard reading.rendered, baseRendered else { continue }
            s.synthWarmMs += reading.synthMs
            s.audioWarmSec += reading.audioSec
            s.contentWarmSec += base[index].audioSec
            s.cpuWarmSec += reading.cpuSec
            if let stages = reading.stageMs {
                var sum = s.stageWarmMs ?? [Double](repeating: 0, count: stages.count)
                if sum.count == stages.count {
                    for k in stages.indices { sum[k] += stages[k] }
                    s.stageWarmMs = sum
                }
            }
        }
        return s
    }

    /// `go` (content RTF ≤ 0.55), `marginal` (≤ 0.667: keeps up at 1.5x with
    /// no margin), `no`, or `unmeasured`. A pass with a non-finite or a
    /// dropped chunk is never better than `no`: that voice skips a sentence.
    static func verdict(contentRtf: Double?, finite: Bool?, dropped: Int) -> String {
        guard let rtf = contentRtf, rtf.isFinite, rtf >= RTF_FLOOR else { return "unmeasured" }
        if finite == false || dropped > 0 { return "no" }
        if rtf <= TARGET_CONTENT_RTF { return "go" }
        if rtf <= BREAK_EVEN_CONTENT_RTF { return "marginal" }
        return "no"
    }

    static let THERMAL_ORDER = ["nominal", "fair", "serious", "critical"]

    /// The soak's loops, one entry per MINUTE since the soak began: the mean
    /// content RTF of the loops that ended in that minute (nil when none did —
    /// a minute with no loop is itself the finding) and the worst heat.
    static func minuteSeries(_ loops: [ProbeSoakLoop]) -> [(rtf: Double?, thermal: String?)] {
        guard let last = loops.map({ $0.endSec }).max(), last.isFinite, last >= 0 else { return [] }
        let minutes = Int(last / 60) + 1
        var sums = [Double](repeating: 0, count: minutes)
        var counts = [Int](repeating: 0, count: minutes)
        var heat = [Int](repeating: -1, count: minutes)
        for loop in loops {
            let m = min(max(Int(loop.endSec / 60), 0), minutes - 1)
            if let rtf = loop.rtfContent { sums[m] += rtf; counts[m] += 1 }
            heat[m] = max(heat[m], THERMAL_ORDER.firstIndex(of: loop.thermal) ?? -1)
        }
        return (0..<minutes).map { m -> (rtf: Double?, thermal: String?) in
            (rtf: counts[m] > 0 ? sums[m] / Double(counts[m]) : nil,
             thermal: heat[m] >= 0 ? THERMAL_ORDER[heat[m]] : nil)
        }
    }

    /// The median of the finite values, or nil.
    static func median(_ values: [Double]) -> Double? {
        let sorted = values.filter { $0.isFinite }.sorted()
        guard !sorted.isEmpty else { return nil }
        let mid = sorted.count / 2
        return sorted.count % 2 == 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
    }
}

/// 16-bit mono PCM WAV (§5 item 10: one WAV per pass, for the founder's ear).
enum ProbeWav {
    static func pcm16(_ samples: [Float]) -> [Int16] {
        samples.map { Int16(max(-1, min(1, $0.isFinite ? $0 : 0)) * 32_767) }
    }

    static func wav(_ pcm: [Int16], sampleRate: Int = 24_000) -> Data {
        var data = Data(capacity: 44 + pcm.count * 2)
        func put32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        func put16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        let payload = UInt32(pcm.count * 2)
        data.append(contentsOf: Array("RIFF".utf8)); put32(36 + payload)
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8)); put32(16)
        put16(1); put16(1)                                  // PCM, mono
        put32(UInt32(sampleRate)); put32(UInt32(sampleRate * 2))
        put16(2); put16(16)                                 // block align, bits
        data.append(contentsOf: Array("data".utf8)); put32(payload)
        pcm.withUnsafeBufferPointer { buf in
            for v in buf { put16(UInt16(bitPattern: v)) }
        }
        return data
    }

    /// Where a pass's WAV goes: the app's caches, overwritten every run, and
    /// never named in a record (a path is not something the record holds).
    static func directory() -> URL? {
        guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return nil }
        let dir = caches.appendingPathComponent("kokoro-probe", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
}

/// Silent audio for the length of a probe run, so iOS keeps the app running
/// when the founder locks the phone — the condition narration synthesizes
/// under (an app playing audio in the background). Mixes with other audio and
/// takes nothing from it; the previous session category is restored after.
final class ProbeKeepAlive {
    private var player: AVAudioPlayer?
    private var previous: (category: AVAudioSession.Category, mode: AVAudioSession.Mode,
                           options: AVAudioSession.CategoryOptions)?

    /// `audio` when silence is playing, `failed` when the session refused.
    ///
    /// ONE SESSION OWNER (NE-16): when the native engine owns the session
    /// (`EngineModeFlag.sessionOwnedByEngine`, the build default) this never
    /// touches its category or activation — the owner set `.playback` at
    /// boot, and the player below plays inside it. Only in legacy mode does
    /// the probe set the category itself, and it puts the old one back.
    func start() -> String {
        let session = AVAudioSession.sharedInstance()
        do {
            if !EngineModeFlag.sessionOwnedByEngine {
                previous = (session.category, session.mode, session.categoryOptions)
                try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
                try session.setActive(true)
            }
            let silence = ProbeWav.wav([Int16](repeating: 0, count: 24_000))
            let player = try AVAudioPlayer(data: silence)
            player.numberOfLoops = -1
            player.volume = 0
            guard player.play() else { return "failed" }
            self.player = player
            return "audio"
        } catch {
            return "failed"
        }
    }

    func stop() {
        player?.stop()
        player = nil
        if !EngineModeFlag.sessionOwnedByEngine {
            if let previous { try? AVAudioSession.sharedInstance().setCategory(previous.category, mode: previous.mode, options: previous.options) }
        }
        previous = nil
    }
}

extension ForayTtsPlugin {
    /// Process CPU seconds so far (every thread: ORT's workers and Core ML's
    /// CPU work, not the Neural Engine's) — what iOS's background CPU monitor
    /// counts (§1).
    static func processCPUSeconds() -> Double {
        Double(clock_gettime_nsec_np(CLOCK_PROCESS_CPUTIME_ID)) / 1_000_000_000
    }

    /// Whether the lock screen is up, as iOS says it: protected data becomes
    /// unavailable when a passcode phone locks (within ~10 s). A phone with no
    /// passcode never reads `true`, which is why `background` is sampled too.
    static func isLocked() -> Bool {
        onMain { !UIApplication.shared.isProtectedDataAvailable }
    }

    /// Why a Core ML pass cannot run here, or nil when it can.
    static func coreMLRefusal() -> String? {
        guard #available(iOS 17.0, *) else { return "coreml-requires-ios17" }
        return KokoroCoreMLFiles.allStageURLs() == nil ? "model-absent" : nil
    }

    /// The real engine for `pass`, or why there is none. The XCTest target's
    /// fake (`probeEngine`) wins when set.
    static func buildEngine(_ pass: KokoroProbePass) -> ProbeEngineBuild {
        if let fake = probeEngine { return .engine(fake) }
        if pass.isCoreML {
            guard #available(iOS 17.0, *) else { return .refused("coreml-requires-ios17") }
            if let refusal = coreMLRefusal() { return .refused(refusal) }
            guard let engine = KokoroCoreMLEngine(pass: pass) else { return .refused("engine-absent") }
            return .engine(engine)
        }
        guard KokoroModelFiles.modelURL() != nil else { return .refused("model-absent") }
        guard let engine = KokoroOrtProbeEngine(pass: pass) else { return .refused("engine-absent") }
        return .engine(engine)
    }

    /// KV-R3's matrix: every pass (in run order), every speed. The answer is
    /// `{ ok: true, platform, speeds, passes: [record…] }` — ONE RECORD PER
    /// PASS × SPEED, each `player/kokoro-probe.js` turns into its own
    /// `voiceProbe` row. A pass's WAV is only ever NAMED by its pass
    /// (`hasWav`); the drawer plays it through `mode: "listen"`, so no path
    /// ever crosses the bridge.
    ///
    /// IF THE APP IS KILLED MID-PASS nothing here returns; the marker
    /// (`ProbeInFlight`, noted before each load and after each chunk) is read
    /// by the next run and lands on its first record as `prevKilled*`.
    static func measurePasses(passes: [KokoroProbePass] = KokoroProbePass.allCases,
                              idLines: [[Int]], speeds: [Double] = ProbeMath.SPEEDS, modelURL: URL?,
                              makeEngine: (KokoroProbePass) -> ProbeEngineBuild,
                              isForeground: () -> Bool = { ForayTtsPlugin.isForeground() },
                              isLocked: () -> Bool = { ForayTtsPlugin.isLocked() },
                              inFlight: ProbeInFlight = ProbeInFlight(),
                              wavDirectory: URL? = nil) -> JSObject {
        var result = JSObject()
        result["platform"] = "ios"
        result["speeds"] = speeds
        /* THE fp32 MODEL IS HASHED ONCE (325 MB), for the ORT passes only. */
        let facts = passes.contains(where: { !$0.isCoreML }) ? modelURL.flatMap { modelFileFacts($0) } : nil
        let killed = inFlight.takeLeftover()
        var records: [JSObject] = []
        for pass in passes {
            let wavURL = wavDirectory?.appendingPathComponent("\(pass.rawValue).wav")
            if let wavURL { try? FileManager.default.removeItem(at: wavURL) }
            let outcome: (records: [JSObject], wav: Bool) = autoreleasepool {
                switch makeEngine(pass) {
                case .refused(let reason):
                    return (speeds.map { refusalRecord(pass: pass, speed: $0, reason: reason) }, false)
                case .engine(let engine):
                    /* `defer`: a pass that returns early still releases its
                       models before the next pass builds any. */
                    defer { engine.close() }
                    return measurePass(engine: engine, pass: pass, idLines: idLines, speeds: speeds,
                                       modelFacts: pass.isCoreML ? nil : facts,
                                       isForeground: isForeground, isLocked: isLocked,
                                       onProgress: { stage, done, peak in
                                           inFlight.note(pass: pass, stage: stage, chunksDone: done, peakBytes: peak)
                                       },
                                       wavURL: wavURL)
                }
            }
            var passRecords = outcome.records
            if records.isEmpty, !passRecords.isEmpty, let killed {
                passRecords[0]["prevKilledPass"] = killed.pass
                passRecords[0]["prevKilledStage"] = killed.stage
                passRecords[0]["prevKilledChunksDone"] = killed.chunksDone
                passRecords[0]["prevKilledPeakBytes"] = Double(killed.peakBytes)
            }
            records.append(contentsOf: passRecords)
        }
        inFlight.clear()
        result["passes"] = records
        result["ok"] = true
        result["reason"] = ""
        return result
    }

    /// The founder's ear (§5 item 10): play one pass's speed-1.5 WAV from the
    /// last matrix run, natively — the page's content-security policy admits
    /// no local media, and a path never crosses the bridge. A new play stops
    /// the one before. Resolves as soon as playback starts.
    static var listenPlayer: AVAudioPlayer?

    static func playProbeWav(pass raw: String?) -> JSObject {
        var result = JSObject()
        result["platform"] = "ios"
        result["mode"] = "listen"
        listenPlayer?.stop()
        listenPlayer = nil
        guard let raw, let pass = KokoroProbePass(rawValue: raw), let dir = ProbeWav.directory() else {
            result["ok"] = false
            result["reason"] = "refused"
            result["detail"] = "unknown-pass"
            return result
        }
        result["pass"] = pass.rawValue
        let url = dir.appendingPathComponent("\(pass.rawValue).wav")
        guard FileManager.default.fileExists(atPath: url.path) else {
            result["ok"] = false
            result["reason"] = "refused"
            result["detail"] = "no-wav"
            return result
        }
        do {
            /* NE-16: the engine's session is left to its owner; in legacy
               mode the probe asks for playback itself. */
            let session = AVAudioSession.sharedInstance()
            if !EngineModeFlag.sessionOwnedByEngine {
                try session.setCategory(.playback, mode: .spokenAudio, options: [])
                try session.setActive(true)
            }
            let player = try AVAudioPlayer(contentsOf: url)
            guard player.play() else { throw NSError(domain: "kokoro-probe", code: 1) }
            listenPlayer = player
            result["ok"] = true
            result["reason"] = ""
            result["durationSec"] = player.duration
        } catch {
            result["ok"] = false
            result["reason"] = "refused"
            result["detail"] = "play-failed"
        }
        return result
    }

    /// A pass that could not run, once per speed so the table has its rows.
    static func refusalRecord(pass: KokoroProbePass, speed: Double, reason: String) -> JSObject {
        var refused = JSObject()
        refused["platform"] = "ios"
        refused["pass"] = pass.rawValue
        refused["speed"] = speed
        refused["provider"] = pass.isCoreML ? "coreml" : "cpu"
        if let route = KokoroCoreMLPlacement.route(pass: pass) { refused["route"] = route }
        refused["ok"] = false
        refused["reason"] = reason
        return refused
    }

    /// One pass over the whole chunked passage at every speed, over ANY
    /// engine (the XCTest target drives it with fakes). Returns one record per
    /// speed, and whether the pass's WAV was written.
    static func measurePass(engine: KokoroProbeEngine, pass: KokoroProbePass, idLines: [[Int]], speeds: [Double],
                            modelFacts: (bytes: Int, sha8: String)?,
                            isForeground: () -> Bool, isLocked: () -> Bool,
                            onProgress: (String, Int, UInt64) -> Void = { _, _, _ in },
                            wavURL: URL? = nil) -> (records: [JSObject], wav: Bool) {
        /* WHAT RAN, AND ON WHAT — read before any stopwatch starts. */
        var common = JSObject()
        common["platform"] = "ios"
        common["pass"] = pass.rawValue
        common["cores"] = ProcessInfo.processInfo.activeProcessorCount
        if let device = machineToken(machineIdentifier()) { common["device"] = device }
        if let os = machineToken(onMain { UIDevice.current.systemVersion }) { common["os"] = os }
        if engine is KokoroOrtProbeEngine, let version = KokoroOrtProbeEngine.runtimeVersion() {
            common["ortVersion"] = version
        }
        if let threads = engine.intraThreads { common["intraThreads"] = threads }
        if let route = engine.route { common["route"] = route }
        if let facts = modelFacts {
            common["modelBytes"] = facts.bytes
            common["modelSha8"] = facts.sha8
        }

        let warned = ProbeFlag()
        let observer = NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: nil) { _ in warned.set() }
        defer { NotificationCenter.default.removeObserver(observer) }
        let batteryWasMonitored = onMain { UIDevice.current.isBatteryMonitoringEnabled }
        let batteryStart = onMain { () -> Float in
            UIDevice.current.isBatteryMonitoringEnabled = true
            return UIDevice.current.batteryLevel
        }
        let batteryStartedAt = DispatchTime.now().uptimeNanoseconds
        common["thermalStart"] = thermalToken(ProcessInfo.processInfo.thermalState)
        common["lowPower"] = ProcessInfo.processInfo.isLowPowerModeEnabled
        common["baseMemoryBytes"] = Double(taskFootprint().current)

        /* THIS PASS'S PEAK, sampled every 10 ms from the load to the last
           chunk (the kernel's own peak is the process's and cannot be reset). */
        let sampler = FootprintSampler()
        sampler.start()
        onProgress("load", 0, sampler.peak)
        let load = engine.load()
        onProgress("synth", 0, sampler.peak)
        common["provider"] = engine.provider
        if let basis = engine.providerBasis { common["providerBasis"] = basis }
        common["model"] = engine.modelName
        common["acceleratorWired"] = engine.acceleratorWired
        common["modelLoadColdMs"] = load.coldMs
        common["modelLoadWarmMs"] = load.warmMs
        if let loadError = engine.loadError {
            if engine.provider == "coreml" {
                common["cmlCode"] = loadError
                if let stage = engine.lastFailure?.stage { common["cmlStage"] = stage }
            } else {
                common["loadErr"] = loadError
            }
        }

        if engine.providerUnavailable {
            let peak = Double(sampler.stop())
            onMain { UIDevice.current.isBatteryMonitoringEnabled = batteryWasMonitored }
            return (speeds.map { speed -> JSObject in
                var record = common
                record["speed"] = speed
                record["peakMemoryBytes"] = peak
                record["acceleratorWired"] = false
                record["ok"] = false
                record["reason"] = "coreml-unavailable"
                record["detail"] = ""
                return record
            }, false)
        }

        /* THE MATRIX: each chunk at every speed, in passage order. */
        var readings = [[ProbeChunkReading]](repeating: [], count: speeds.count)
        var firstFailure = [KokoroProbeFailure?](repeating: nil, count: speeds.count)
        var bgAtFail = [Bool?](repeating: nil, count: speeds.count)
        let wavIndex = wavURL == nil ? nil : speeds.firstIndex(of: ProbeMath.WAV_SPEED)
        var pcm: [Int16] = []
        for (index, ids) in idLines.enumerated() {
            for (k, speed) in speeds.enumerated() {
                let capture = k == wavIndex
                engine.setCaptureSamples(capture)
                let cpuStart = processCPUSeconds()
                let out = engine.synthesize(ids: ids, speed: speed)
                let cpu = processCPUSeconds() - cpuStart
                let reading = ProbeChunkReading(synthMs: out.synthMs,
                                                audioSec: out.reason == nil ? out.audioSec : 0,
                                                reason: out.reason, cpuSec: cpu, stageMs: engine.lastStageMs,
                                                background: !isForeground(), locked: isLocked())
                if out.reason != nil, bgAtFail[k] == nil {
                    bgAtFail[k] = reading.background
                    firstFailure[k] = engine.lastFailure
                }
                if capture, let samples = engine.takeLastSamples() { pcm.append(contentsOf: ProbeWav.pcm16(samples)) }
                readings[k].append(reading)
            }
            onProgress("synth", index + 1, sampler.peak)
        }
        engine.setCaptureSamples(false)

        common["thermalEnd"] = thermalToken(ProcessInfo.processInfo.thermalState)
        let batteryEnd = onMain { () -> Float in
            let level = UIDevice.current.batteryLevel
            UIDevice.current.isBatteryMonitoringEnabled = batteryWasMonitored
            return level
        }
        if batteryStart >= 0, batteryEnd >= 0 {
            common["batteryDeltaPct"] = (Double(batteryStart - batteryEnd) * 1000).rounded() / 10
            common["batteryWindowSec"] = Double(DispatchTime.now().uptimeNanoseconds - batteryStartedAt) / 1_000_000_000
        }
        common["memWarn"] = warned.value
        common["availableMemoryBytes"] = Double(os_proc_available_memory())
        common["peakMemoryBytes"] = Double(sampler.stop())
        common["processPeakBytes"] = Double(peakResidentBytes())
        common["lines"] = idLines.count

        var wrote = false
        if let wavURL, !pcm.isEmpty {
            wrote = (try? ProbeWav.wav(pcm).write(to: wavURL, options: .atomic)) != nil
        }

        let baseIndex = speeds.firstIndex(of: 1.0)
        let records: [JSObject] = speeds.indices.map { k -> JSObject in
            let speed = speeds[k]
            let summary = ProbeMath.summarize(readings[k], base: readings[baseIndex ?? k])
            var record = common
            record["speed"] = speed
            record["lineOutcomes"] = summary.outcomes
            record["nonFiniteLines"] = summary.nonFinite
            record["silentLines"] = summary.silent
            record["synthFailures"] = summary.failures
            record["bgChunks"] = summary.bgChunks
            record["lockedChunks"] = summary.lockedChunks
            record["synthColdMs"] = summary.synthColdMs
            record["synthWarmMs"] = summary.synthWarmMs
            record["contentColdSec"] = summary.contentColdSec
            record["contentWarmSec"] = summary.contentWarmSec
            record["cpuWarmSec"] = summary.cpuWarmSec
            if let stages = summary.stageWarmMs { record["stageMs"] = stages }
            if let failure = firstFailure[k] {
                if engine.provider == "coreml" {
                    record["cmlCode"] = failure.code
                    record["cmlStage"] = failure.stage
                } else {
                    record["ortCode"] = failure.code
                    record["ortStage"] = failure.stage
                    if let op = failure.op { record["ortOp"] = op }
                }
            }
            if let bg = bgAtFail[k] { record["bgAtFail"] = bg }
            /* "Not frontmost when this speed's last chunk finished" — the
               honest weaker fact; `bgChunks`/`lockedChunks` say the rest. */
            record["lockedScreenCompleted"] = readings[k].last?.background ?? false
            record["hasWav"] = k == wavIndex && wrote
            if summary.audioColdSec + summary.audioWarmSec <= 0 {
                record["ok"] = false
                record["reason"] = "synthesis-failed"
                record["detail"] = summary.firstFailure ?? "zero-samples"
                record["audioColdSec"] = 0.0
                record["audioWarmSec"] = 0.0
                return record
            }
            record["ok"] = true
            record["reason"] = ""
            record["detail"] = summary.firstFailure ?? ""
            record["audioColdSec"] = summary.audioColdSec
            record["audioWarmSec"] = summary.audioWarmSec
            return record
        }
        return (records, wrote)
    }

    /// The SOAK (card KV-R3 item 3, §5 item 9): one background-safe pass
    /// renders the passage at speed 1.5 in a loop for `minutes`. First the
    /// passage once at speed 1.0 (the content basis, and the warm-up), then
    /// loops until the time is up. Each loop notes the kill marker, so if iOS
    /// ends the app the next run says `soak` and how many loops it finished.
    static func runSoak(engine: KokoroProbeEngine, pass: KokoroProbePass, idLines: [[Int]], minutes: Double,
                        isForeground: () -> Bool = { ForayTtsPlugin.isForeground() },
                        isLocked: () -> Bool = { ForayTtsPlugin.isLocked() },
                        inFlight: ProbeInFlight = ProbeInFlight(),
                        clock: () -> Double = { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000_000 },
                        maxLoops: Int = Int.max) -> JSObject {
        var result = JSObject()
        result["platform"] = "ios"
        result["mode"] = "soak"
        result["pass"] = pass.rawValue
        result["speed"] = ProbeMath.WAV_SPEED
        result["soakMinutes"] = minutes
        result["cores"] = ProcessInfo.processInfo.activeProcessorCount
        if let device = machineToken(machineIdentifier()) { result["device"] = device }
        if let os = machineToken(onMain { UIDevice.current.systemVersion }) { result["os"] = os }
        if let threads = engine.intraThreads { result["intraThreads"] = threads }
        if let route = engine.route { result["route"] = route }
        if let killed = inFlight.takeLeftover() {
            result["prevKilledPass"] = killed.pass
            result["prevKilledStage"] = killed.stage
            result["prevKilledChunksDone"] = killed.chunksDone
            result["prevKilledPeakBytes"] = Double(killed.peakBytes)
        }
        result["thermalStart"] = thermalToken(ProcessInfo.processInfo.thermalState)
        result["lowPower"] = ProcessInfo.processInfo.isLowPowerModeEnabled
        result["baseMemoryBytes"] = Double(taskFootprint().current)

        inFlight.note(pass: pass, stage: "load", chunksDone: 0, peakBytes: taskFootprint().current)
        let load = engine.load()
        result["provider"] = engine.provider
        result["model"] = engine.modelName
        result["modelLoadColdMs"] = load.coldMs
        result["modelLoadWarmMs"] = load.warmMs

        /* The content basis: every chunk once at speed 1.0. */
        let content: [Double] = idLines.map { ids -> Double in
            let out = engine.synthesize(ids: ids, speed: 1.0)
            return out.reason == nil ? out.audioSec : 0
        }
        guard content.contains(where: { $0 > 0 }) else {
            inFlight.clear()
            result["ok"] = false
            result["reason"] = "synthesis-failed"
            result["detail"] = "calibration"
            return result
        }

        var loops: [ProbeSoakLoop] = []
        let start = clock()
        while clock() - start < minutes * 60, loops.count < maxLoops {
            let sampler = FootprintSampler()
            sampler.start()
            var loop = ProbeSoakLoop(endSec: 0, synthMs: 0, contentSec: 0, audioSec: 0, cpuSec: 0, peakBytes: 0,
                                     thermal: "nominal", background: false, locked: false, failures: 0, nonFinite: 0)
            let cpuStart = processCPUSeconds()
            autoreleasepool {
                for (index, ids) in idLines.enumerated() {
                    let out = engine.synthesize(ids: ids, speed: ProbeMath.WAV_SPEED)
                    if let reason = out.reason {
                        loop.failures += 1
                        if reason == "non-finite" { loop.nonFinite += 1 }
                    } else if content[index] > 0 {
                        loop.synthMs += out.synthMs
                        loop.contentSec += content[index]
                        loop.audioSec += out.audioSec
                    }
                }
            }
            loop.cpuSec = processCPUSeconds() - cpuStart
            loop.peakBytes = sampler.stop()
            loop.thermal = thermalToken(ProcessInfo.processInfo.thermalState)
            loop.background = !isForeground()
            loop.locked = isLocked()
            loop.endSec = clock() - start
            loops.append(loop)
            inFlight.note(pass: pass, stage: "soak", chunksDone: loops.count, peakBytes: loop.peakBytes)
        }
        engine.close()
        inFlight.clear()
        return soakRecord(result, loops: loops)
    }

    /// The soak's loops folded into its record (pure, for XCTest).
    static func soakRecord(_ base: JSObject, loops: [ProbeSoakLoop]) -> JSObject {
        var result = base
        let series = ProbeMath.minuteSeries(loops)
        let rtfs = loops.compactMap { $0.rtfContent }
        result["soakLoops"] = loops.count
        result["soakElapsedSec"] = loops.last?.endSec ?? 0
        /* -1 marks a minute in which no loop ended (JS reads it as null). */
        result["soakRtfSeries"] = series.map { $0.rtf ?? -1 }
        result["soakThermalSeries"] = series.map { $0.thermal ?? "" }
        result["soakRtfMin"] = rtfs.min() ?? -1
        result["soakRtfMedian"] = ProbeMath.median(rtfs) ?? -1
        result["soakRtfMax"] = rtfs.max() ?? -1
        result["soakPeakBytes"] = Double(loops.map { $0.peakBytes }.max() ?? 0)
        result["soakPeakFirstBytes"] = Double(loops.first?.peakBytes ?? 0)
        result["soakPeakLastBytes"] = Double(loops.last?.peakBytes ?? 0)
        result["soakBgLoops"] = loops.filter { $0.background }.count
        result["soakLockedLoops"] = loops.filter { $0.locked }.count
        result["soakFailures"] = loops.reduce(0) { $0 + $1.failures }
        result["soakNonFinite"] = loops.reduce(0) { $0 + $1.nonFinite }
        let cpu = loops.reduce(0.0) { $0 + $1.cpuSec }
        let contentSec = loops.reduce(0.0) { $0 + $1.contentSec }
        if let perContent = ProbeMath.ratio(cpu, contentSec) { result["cpuPerContentSec"] = perContent }
        result["thermalEnd"] = loops.last?.thermal ?? thermalToken(ProcessInfo.processInfo.thermalState)
        result["soakVerdict"] = ProbeMath.verdict(contentRtf: ProbeMath.median(rtfs),
                                                  finite: loops.contains { $0.nonFinite > 0 } ? false : true,
                                                  dropped: loops.reduce(0) { $0 + $1.failures - $1.nonFinite })
        result["availableMemoryBytes"] = Double(os_proc_available_memory())
        if loops.isEmpty {
            result["ok"] = false
            result["reason"] = "synthesis-failed"
            result["detail"] = "no-loop"
        } else {
            result["ok"] = true
            result["reason"] = ""
        }
        return result
    }
}
