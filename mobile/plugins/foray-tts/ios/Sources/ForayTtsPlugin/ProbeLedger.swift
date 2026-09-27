import Darwin
import Foundation

/* Probe v3.1: a pass that KILLS 4a is recorded at once, skipped next time,
 * and the safe passes run first (build 2026092705: two taps, two crashes on
 * the first pass, and no row at all — the kill marker only surfaced inside a
 * LATER completed run, and `takeLeftover()` deleted it the moment the next
 * run started, so a second crash erased the first one's evidence).
 *
 * ── What is on disk, and why each file exists ─────────────────────────────
 * `Application Support/kokoro-probe/` (not tmp, which iOS may purge between
 * launches, and not Caches, which it purges under pressure):
 *
 *   inflight.txt    THE BREADCRUMB. One line, rewritten (write → fsync →
 *                   rename) BEFORE every step that can take the process
 *                   down: the pass's load, each Core ML stage's cold load
 *                   (the Neural Engine compile) and warm load, each Core ML
 *                   stage's prediction on every chunk (`synth` + `vocoder`),
 *                   the WAV, the release. A process that dies leaves the
 *                   last one naming where.
 *   killed.json     THE REPORT. At the next launch (the plugin's `load()`),
 *                   the breadcrumb becomes a report here — written durably
 *                   FIRST, the breadcrumb cleared SECOND, so no crash in
 *                   between loses it. The page reads it at boot and writes a
 *                   `voiceProbe` row; the report is deleted only when the page
 *                   says the row is written (`killed-ack`). Evidence is never
 *                   erased by the thing that reads it.
 *   quarantine.txt  THE SKIP LIST. The pass that killed 4a — and, when it was
 *                   a Core ML pass, every Core ML pass (they share Apple's
 *                   libBNNS, which is what crashes on A19/iOS 26.4+) — is
 *                   skipped by every later run with `skipped-killed-last-run`,
 *                   until the drawer's "Reset skipped passes". Each re-tap
 *                   makes progress instead of dying in the same place.
 *   journal.json    THE FINISHED PASSES of the run in flight, appended as each
 *                   pass finishes, so a kill in pass 4 still leaves passes 1–3
 *                   in the next report even if the page never got to write
 *                   them (WebKit's storage flush is not the app's).
 *
 * Every write is small (one line, or a few KB of JSON) and synchronous. The
 * types below are pure over a directory URL, so XCTest drives them in a
 * temporary folder. */

/// Write `data` so that a process killed at any instant leaves either the old
/// file or the whole new one: a temporary sibling, fsync'd, then renamed over.
enum ProbeDurable {
    @discardableResult
    static func write(_ data: Data, to url: URL) -> Bool {
        let dir = url.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let tmp = dir.appendingPathComponent(".\(url.lastPathComponent).tmp")
        let fd = Darwin.open(tmp.path, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
        guard fd >= 0 else { return false }
        var ok = true
        data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
            guard let base = buffer.baseAddress else { return }
            var offset = 0
            while offset < buffer.count {
                let n = Darwin.write(fd, base + offset, buffer.count - offset)
                if n <= 0 { ok = false; break }
                offset += n
            }
        }
        if Darwin.fsync(fd) != 0 { ok = false }
        _ = Darwin.close(fd)
        guard ok, Darwin.rename(tmp.path, url.path) == 0 else {
            _ = Darwin.unlink(tmp.path)
            return false
        }
        return true
    }
}

/// One breadcrumb: where a probe was when it last wrote one.
///
///   mode   `matrix` or `soak`
///   pass   the `KokoroProbePass` raw value
///   stage  `ProbeBreadcrumb.STAGES` (`player/kokoro-probe.js` KILLED_STAGES)
///   chunk  chunks finished before the one in flight (loops, for `soak`)
///   peak   this pass's footprint high-water mark so far, bytes
///   speed  the Kokoro speed in flight, or nil (a load has none)
///   sub    the Core ML stage (`albert` … `tail`), or nil
///   run    the run's id (its start, epoch ms), shared by its records
///   at     when the breadcrumb was written, epoch ms
///
/// and, after those ten, optional `key=value` tokens (the coordinator's ask
/// after the .ips: WHICH SHAPE killed it, not only which stage):
///
///   tokens=N   the chunk's token count (ids, pad included)
///   frames=N   the chunk's predicted frame count (Core ML durations' sum),
///              once PostAlbert has produced it
///   in=…       every input the Core ML stage is about to be handed,
///              `name:dims`, comma separated, sorted (`x_pre:1x512x7201`)
struct ProbeBreadcrumb: Equatable {
    /// `load` the pass's engine is being built and loaded; `compile` a Core ML
    /// stage's COLD load (the Neural Engine compile); `load-warm` its warm
    /// load; `first-predict` the first chunk's inference; `synth` a later
    /// chunk; `wav` writing the pass's WAV; `close` releasing its models;
    /// `soak` a soak loop.
    static let STAGES = ["load", "compile", "load-warm", "first-predict", "synth", "wav", "close", "soak"]
    static let MODES = ["matrix", "soak"]

    var mode: String
    var pass: String
    var stage: String
    var chunk: Int
    var peakBytes: UInt64
    var speed: Double?
    var sub: String?
    var run: Int64
    var at: Int64
    var tokens: Int?
    var frames: Int?
    var inputs: String?

    /// `in=` is capped; longer than this is not a shape list.
    static let INPUTS_MAX = 240

    init(mode: String = "matrix", pass: String, stage: String, chunk: Int, peakBytes: UInt64,
         speed: Double? = nil, sub: String? = nil, run: Int64 = 0, at: Int64 = 0,
         tokens: Int? = nil, frames: Int? = nil, inputs: String? = nil) {
        self.tokens = tokens
        self.frames = frames
        self.inputs = inputs
        self.mode = mode
        self.pass = pass
        self.stage = stage
        self.chunk = chunk
        self.peakBytes = peakBytes
        self.speed = speed
        self.sub = sub
        self.run = run
        self.at = at
    }

    /// The probe v2 name for `chunk` (the kill marker's `chunksDone`).
    var chunksDone: Int { chunk }

    /// `v2 <mode> <pass> <stage> <chunk> <peak> <speed|-> <sub|-> <run> <at>`
    /// then `tokens=` `frames=` `in=` when known.
    func line() -> String {
        let speedText = speed.map { String($0) } ?? "-"
        var text = "v2 \(mode) \(pass) \(stage) \(chunk) \(peakBytes) \(speedText) \(sub ?? "-") \(run) \(at)"
        if let tokens { text += " tokens=\(tokens)" }
        if let frames { text += " frames=\(frames)" }
        if let inputs { text += " in=\(inputs)" }
        return text
    }

    /// A breadcrumb back, or nil for anything else. Also reads build
    /// 2026092705's four-token marker (`ane load 0 812000000`), so the crashes
    /// already on a phone surface at the first launch of the build after it.
    static func parse(_ text: String) -> ProbeBreadcrumb? {
        let parts = text.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\r" }).map(String.init)
        if parts.count == 4 {
            guard KokoroProbePass(rawValue: parts[0]) != nil,
                  ["load", "synth", "soak"].contains(parts[1]),
                  let done = Int(parts[2]), done >= 0,
                  let peak = UInt64(parts[3]) else { return nil }
            return ProbeBreadcrumb(mode: parts[1] == "soak" ? "soak" : "matrix", pass: parts[0], stage: parts[1],
                                   chunk: done, peakBytes: peak)
        }
        guard parts.count >= 10, parts.count <= 13, parts[0] == "v2",
              MODES.contains(parts[1]),
              KokoroProbePass(rawValue: parts[2]) != nil,
              STAGES.contains(parts[3]),
              let chunk = Int(parts[4]), chunk >= 0,
              let peak = UInt64(parts[5]),
              let run = Int64(parts[8]), let at = Int64(parts[9]) else { return nil }
        var speed: Double?
        if parts[6] != "-" {
            guard let s = Double(parts[6]), s.isFinite, s > 0, s <= 4 else { return nil }
            speed = s
        }
        var sub: String?
        if parts[7] != "-" {
            guard isToken(parts[7]) else { return nil }
            sub = parts[7]
        }
        var crumb = ProbeBreadcrumb(mode: parts[1], pass: parts[2], stage: parts[3], chunk: chunk, peakBytes: peak,
                                    speed: speed, sub: sub, run: run, at: at)
        for extra in parts.dropFirst(10) {
            guard let eq = extra.firstIndex(of: "=") else { return nil }
            let key = String(extra[..<eq]), value = String(extra[extra.index(after: eq)...])
            switch key {
            case "tokens":
                guard let n = Int(value), n >= 0 else { return nil }
                crumb.tokens = n
            case "frames":
                guard let n = Int(value), n >= 0 else { return nil }
                crumb.frames = n
            case "in":
                guard isInputs(value) else { return nil }
                crumb.inputs = value
            default:
                return nil
            }
        }
        return crumb
    }

    /// `name:dims[,name:dims…]`: identifier names, `x`-joined decimal dims.
    static func isInputs(_ text: String) -> Bool {
        guard !text.isEmpty, text.count <= INPUTS_MAX else { return false }
        return text.split(separator: ",", omittingEmptySubsequences: false).allSatisfy { pair in
            let halves = pair.split(separator: ":", omittingEmptySubsequences: false)
            guard halves.count == 2, let name = halves.first, let dims = halves.last,
                  !name.isEmpty, name.count <= 24, !dims.isEmpty else { return false }
            let nameOK = name.unicodeScalars.allSatisfy { s in
                (s.value >= 0x30 && s.value <= 0x39) || (s.value >= 0x41 && s.value <= 0x5A)
                    || (s.value >= 0x61 && s.value <= 0x7A) || s.value == 0x5F
            }
            let dimsOK = dims.split(separator: "x", omittingEmptySubsequences: false).allSatisfy { d in
                !d.isEmpty && d.count <= 7 && d.unicodeScalars.allSatisfy { $0.value >= 0x30 && $0.value <= 0x39 }
            }
            return nameOK && dimsOK
        }
    }

    /// Shapes as `in=`: `[name: dims]` → `a:1x42,b:1x128`, sorted by name;
    /// nil when the result would not parse back.
    static func inputsToken(_ shapes: [String: [Int]]) -> String? {
        let text = shapes.keys.sorted().map { key in
            "\(key):\((shapes[key] ?? []).map(String.init).joined(separator: "x"))"
        }.joined(separator: ",")
        return isInputs(text) ? text : nil
    }

    /// `[A-Za-z0-9-]{1,24}`: a Core ML stage name, nothing else.
    static func isToken(_ text: String) -> Bool {
        guard !text.isEmpty, text.count <= 24 else { return false }
        return text.unicodeScalars.allSatisfy { s in
            (s.value >= 0x30 && s.value <= 0x39) || (s.value >= 0x41 && s.value <= 0x5A)
                || (s.value >= 0x61 && s.value <= 0x7A) || s.value == 0x2D
        }
    }

    var probePass: KokoroProbePass? { KokoroProbePass(rawValue: pass) }

    /// The breadcrumb as a record's fields: the kill report's own keys.
    func fields(prefix: String) -> [String: Any] {
        var out: [String: Any] = [
            "\(prefix)Pass": pass,
            "\(prefix)Stage": stage,
            "\(prefix)ChunksDone": chunk,
            "\(prefix)PeakBytes": Double(peakBytes),
            "\(prefix)Mode": mode,
        ]
        if let speed { out["\(prefix)Speed"] = speed }
        if let sub { out["\(prefix)Sub"] = sub }
        if run > 0 { out["\(prefix)Run"] = Double(run) }
        if at > 0 { out["\(prefix)At"] = Double(at) }
        if let tokens { out["\(prefix)Tokens"] = tokens }
        if let frames { out["\(prefix)Frames"] = frames }
        if let inputs { out["\(prefix)In"] = inputs }
        return out
    }
}

/// Epoch milliseconds now.
func probeNowMs() -> Int64 {
    Int64((Date().timeIntervalSince1970 * 1000).rounded())
}

/// Where a probe pass had got to, kept on disk (`ProbeBreadcrumb`, written
/// durably before every step that can take the process down), so a run the
/// system KILLS still says where it died. Cleared between passes and when a
/// run finishes normally.
final class ProbeInFlight {
    static let STAGES: Set<String> = Set(ProbeBreadcrumb.STAGES)

    typealias Leftover = ProbeBreadcrumb

    let url: URL

    init(url: URL = ProbeLedger.defaultDirectory().appendingPathComponent(ProbeLedger.INFLIGHT)) {
        self.url = url
    }

    /// Build 2026092705's marker, in the temporary directory.
    static var legacyURL: URL {
        URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("kokoro-probe-inflight.txt")
    }

    func note(_ crumb: ProbeBreadcrumb) {
        var stamped = crumb
        if stamped.at == 0 { stamped.at = probeNowMs() }
        ProbeDurable.write(Data(stamped.line().utf8), to: url)
    }

    func note(pass: KokoroProbePass, stage: String, chunksDone: Int, peakBytes: UInt64,
              speed: Double? = nil, sub: String? = nil, mode: String = "matrix", run: Int64 = 0,
              tokens: Int? = nil, frames: Int? = nil, inputs: String? = nil) {
        note(ProbeBreadcrumb(mode: mode, pass: pass.rawValue, stage: stage, chunk: chunksDone, peakBytes: peakBytes,
                             speed: speed, sub: sub, run: run, tokens: tokens, frames: frames, inputs: inputs))
    }

    /// What a killed run left behind, WITHOUT forgetting it. Only
    /// `ProbeLedger.promote` clears it, and only after the report is on disk.
    func peek() -> ProbeBreadcrumb? {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        return ProbeBreadcrumb.parse(text)
    }

    /// Read and forget (tests, and a malformed file's cleanup).
    func takeLeftover() -> Leftover? {
        let leftover = peek()
        clear()
        return leftover
    }

    var exists: Bool { FileManager.default.fileExists(atPath: url.path) }

    func clear() {
        try? FileManager.default.removeItem(at: url)
    }
}

/// The skip list: pass → the breadcrumb of the kill that put it there. A
/// Core ML kill skips every Core ML pass (one libBNNS under all three).
final class ProbeQuarantine {
    let url: URL

    init(url: URL) {
        self.url = url
    }

    /// Every skipped pass, in run order, with the kill that skipped it.
    func entries() -> [(pass: KokoroProbePass, crumb: ProbeBreadcrumb)] {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        var map: [KokoroProbePass: ProbeBreadcrumb] = [:]
        for line in text.split(separator: "\n") {
            let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
            guard parts.count == 2, let pass = KokoroProbePass(rawValue: parts[0]),
                  let crumb = ProbeBreadcrumb.parse(parts[1]) else { continue }
            map[pass] = crumb
        }
        return KokoroProbePass.allCases.compactMap { pass in map[pass].map { (pass: pass, crumb: $0) } }
    }

    func crumb(for pass: KokoroProbePass) -> ProbeBreadcrumb? {
        entries().first(where: { $0.pass == pass })?.crumb
    }

    /// The passes a kill in `crumb` puts on the list: its own, and every
    /// Core ML pass when it was one.
    static func passesSkipped(by crumb: ProbeBreadcrumb) -> [KokoroProbePass] {
        guard let pass = crumb.probePass else { return [] }
        if pass.isCoreML { return KokoroProbePass.allCases.filter(\.isCoreML) }
        return [pass]
    }

    @discardableResult
    func add(_ crumb: ProbeBreadcrumb) -> [KokoroProbePass] {
        let skipped = Self.passesSkipped(by: crumb)
        guard !skipped.isEmpty else { return [] }
        var map = Dictionary(uniqueKeysWithValues: entries().map { ($0.pass, $0.crumb) })
        for pass in skipped { map[pass] = crumb }
        let text = KokoroProbePass.allCases.compactMap { pass in map[pass].map { "\(pass.rawValue) \($0.line())" } }
            .joined(separator: "\n") + "\n"
        ProbeDurable.write(Data(text.utf8), to: url)
        return skipped
    }

    /// Empty the list; the number of passes it held.
    @discardableResult
    func reset() -> Int {
        let count = entries().count
        try? FileManager.default.removeItem(at: url)
        return count
    }
}

/// The ledger: the four files, and the one operation that moves a breadcrumb
/// into a report without a window in which it can be lost.
final class ProbeLedger {
    static let DIRECTORY = "kokoro-probe"
    static let INFLIGHT = "inflight.txt"
    static let QUARANTINE = "quarantine.txt"
    static let KILLED = "killed.json"
    static let JOURNAL = "journal.json"
    /// A report list that somehow grew is capped, newest kept.
    static let MAX_REPORTS = 8

    static func defaultDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent(DIRECTORY, isDirectory: true)
    }

    static let shared = ProbeLedger(directory: defaultDirectory())

    let directory: URL
    let inFlight: ProbeInFlight
    let quarantine: ProbeQuarantine
    private let legacyMarker: URL?
    private let lock = NSLock()

    init(directory: URL, legacyMarker: URL? = ProbeInFlight.legacyURL) {
        self.directory = directory
        self.inFlight = ProbeInFlight(url: directory.appendingPathComponent(Self.INFLIGHT))
        self.quarantine = ProbeQuarantine(url: directory.appendingPathComponent(Self.QUARANTINE))
        self.legacyMarker = legacyMarker
    }

    var killedURL: URL { directory.appendingPathComponent(Self.KILLED) }
    var journalURL: URL { directory.appendingPathComponent(Self.JOURNAL) }

    // MARK: the journal

    /// Append one finished pass's records to the run's journal (a new run's
    /// first append replaces an older run's leftovers).
    func journal(run: Int64, records: [[String: Any]]) {
        lock.lock()
        defer { lock.unlock() }
        var existing = readJSONArray(journalURL).filter { ($0["probeRun"] as? Double).map { Int64($0) } == run }
        existing.append(contentsOf: records)
        writeJSONArray(existing, to: journalURL)
    }

    func journaled() -> [[String: Any]] {
        lock.lock()
        defer { lock.unlock() }
        return readJSONArray(journalURL)
    }

    func clearJournal() {
        try? FileManager.default.removeItem(at: journalURL)
    }

    // MARK: the launch

    /// THE LAUNCH: a breadcrumb left by a killed run (this build's, or build
    /// 2026092705's in tmp) becomes a report and a quarantine entry. ORDER IS
    /// THE POINT: the report is written durably before the breadcrumb is
    /// cleared, so a crash here costs nothing. Returns the report, if any.
    @discardableResult
    func promoteLeftover(now: Int64 = probeNowMs()) -> [String: Any]? {
        lock.lock()
        defer { lock.unlock() }
        var markers: [ProbeInFlight] = [inFlight]
        if let legacyMarker { markers.append(ProbeInFlight(url: legacyMarker)) }
        var report: [String: Any]?
        for marker in markers {
            guard marker.exists else { continue }
            guard let crumb = marker.peek() else {
                marker.clear()   // not a breadcrumb: nothing to keep
                continue
            }
            let completed = readJSONArray(journalURL).filter { r in
                crumb.run == 0 || (r["probeRun"] as? Double).map { Int64($0) } == crumb.run
            }
            let skipped = crumb.mode == "matrix" ? quarantine.add(crumb) : []
            let built = Self.killReport(crumb, completed: completed, skipped: skipped, reportedAt: now)
            var reports = readJSONArray(killedURL)
            reports.append(built)
            if reports.count > Self.MAX_REPORTS { reports.removeFirst(reports.count - Self.MAX_REPORTS) }
            guard writeJSONArray(reports, to: killedURL) else { continue }   // keep the marker: try next launch
            try? FileManager.default.removeItem(at: journalURL)
            marker.clear()
            report = built
        }
        return report
    }

    /// The report a breadcrumb becomes (pure, for XCTest): the kill's own
    /// fields (`killed*`), which passes it now skips, and the passes that run
    /// finished before it died.
    static func killReport(_ crumb: ProbeBreadcrumb, completed: [[String: Any]], skipped: [KokoroProbePass],
                           reportedAt: Int64) -> [String: Any] {
        var report = crumb.fields(prefix: "killed")
        report["platform"] = "ios"
        report["id"] = "\(crumb.run)-\(crumb.at)-\(reportedAt)"
        report["reportedAt"] = Double(reportedAt)
        report["skipped"] = skipped.map(\.rawValue)
        report["completed"] = completed
        return report
    }

    /// The reports not yet acknowledged, as JSON text (the page parses it:
    /// nothing here has to become a Capacitor object).
    func pendingReportsJSON() -> String {
        lock.lock()
        defer { lock.unlock() }
        guard let data = try? Data(contentsOf: killedURL), let text = String(data: data, encoding: .utf8) else { return "[]" }
        return text
    }

    /// The page wrote these reports' rows: forget them. Returns how many.
    @discardableResult
    func acknowledge(ids: [String]) -> Int {
        lock.lock()
        defer { lock.unlock() }
        let reports = readJSONArray(killedURL)
        let kept = reports.filter { !ids.contains(($0["id"] as? String) ?? "") }
        let removed = reports.count - kept.count
        if kept.isEmpty {
            try? FileManager.default.removeItem(at: killedURL)
        } else if removed > 0 {
            writeJSONArray(kept, to: killedURL)
        }
        return removed
    }

    // MARK: JSON files

    private func readJSONArray(_ url: URL) -> [[String: Any]] {
        guard let data = try? Data(contentsOf: url),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        return parsed
    }

    @discardableResult
    private func writeJSONArray(_ array: [[String: Any]], to url: URL) -> Bool {
        let value = array as [Any]
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value) else { return false }
        return ProbeDurable.write(data, to: url)
    }
}

/// One step the Core ML engine is about to take inside a pass: the stage
/// (`compile`, `load-warm`, `predict`), the stage model (`sub`), and for a
/// predict the chunk's frame count and every input's shape.
struct ProbeStageStep {
    var stage: String
    var sub: String?
    var frames: Int?
    var inputs: String?
}

/// The Core ML stage hook: `KokoroCoreMLEngine` calls `note` before each
/// stage's load and prediction, and the pass in flight turns it into a
/// breadcrumb. A static because the engine protocol is public and the XCTest
/// fakes implement it; nothing else sets it. Locked: set on the probe queue,
/// read on the same, but cheap to be sure.
enum ProbeStageHook {
    private static let lock = NSLock()
    private static var sink: ((ProbeStageStep) -> Void)?

    static func set(_ fn: ((ProbeStageStep) -> Void)?) {
        lock.lock()
        sink = fn
        lock.unlock()
    }

    static func note(_ stage: String, _ sub: String?, frames: Int? = nil, inputs: String? = nil) {
        lock.lock()
        let fn = sink
        lock.unlock()
        fn?(ProbeStageStep(stage: stage, sub: sub, frames: frames, inputs: inputs))
    }
}

/// Apple's libBNNS fault (FluidInference/FluidAudio #844, closed not-planned
/// in #889): on iOS 26.4 and later — including 27.0 — the Kokoro Core ML
/// chain crashes the process inside libBNNS on A19 phones, on EVERY compute
/// unit, `.cpuOnly` included. The founder's two crashes on build 2026092705
/// match its six frames. So the Core ML passes are refused there
/// (`coreml-bnns-os`) unless the drawer's "arm Core ML (may crash)" switch is
/// on. Pure, for XCTest.
enum ProbeCoreMLGuard {
    static let REASON = "coreml-bnns-os"

    static func bnnsAffected(_ version: OperatingSystemVersion) -> Bool {
        (version.majorVersion, version.minorVersion) >= (26, 4)
    }

    /// `coreml-bnns-os` on an affected OS unless armed, else nil.
    static func refusal(version: OperatingSystemVersion = ProcessInfo.processInfo.operatingSystemVersion,
                        armed: Bool) -> String? {
        bnnsAffected(version) && !armed ? REASON : nil
    }
}

/// A row in the NATIVE ENGINE's diagnostics ring (foray-audio's DiagRing:
/// `Application Support/foray-engine/diag.jsonl`, one line appended per row
/// before `append` returns, so it survives the process dying a moment later).
/// This plugin cannot import that one, so it POSTS, on the main thread and
/// synchronously, and foray-audio's `VoiceProbeRelay` writes the row before
/// the post returns. The name is pinned equal on both sides by
/// `tools/mobile/foray-tts.test.mjs`.
enum ProbeEngineRow {
    static let NOTIFICATION = "ai.jwlabs.foura.voiceProbeRow"

    static func post(event: String, pass: KokoroProbePass, order: Int, run: Int64, stage: String? = nil) {
        var info: [String: Any] = ["event": event, "pass": pass.rawValue, "order": order, "run": Double(run)]
        if let stage { info["stage"] = stage }
        ForayTtsPlugin.onMain {
            NotificationCenter.default.post(name: Notification.Name(NOTIFICATION), object: nil, userInfo: info)
        }
    }
}
