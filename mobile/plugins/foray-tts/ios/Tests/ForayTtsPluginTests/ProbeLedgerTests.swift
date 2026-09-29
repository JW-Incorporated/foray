import XCTest
import CoreML
@testable import ForayTtsPlugin

/// Probe v3.1: the crash-resilient, self-reporting probe (ProbeLedger.swift,
/// KokoroProbeMatrix.swift). Build 2026092705 died twice on its first pass
/// (`ane`, a SIGSEGV inside `-[MLModel predictionFromFeatures:error:]`,
/// libBNNS — FluidAudio #844/#889) and left no row. Each test names the
/// mutation that turns it red.
final class ProbeLedgerTests: XCTestCase {
    private var dir: URL!

    override func setUp() {
        super.setUp()
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("kvr31-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: dir)
        ProbeStageHook.set(nil)
        super.tearDown()
    }

    private func ledger(legacy: URL? = nil) -> ProbeLedger {
        ProbeLedger(directory: dir, legacyMarker: legacy)
    }

    private func reports(_ ledger: ProbeLedger) -> [[String: Any]] {
        let data = Data(ledger.pendingReportsJSON().utf8)
        return (try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]) ?? []
    }

    // MARK: the breadcrumb

    /// **The breadcrumb names the pass, speed, stage, Core ML stage model,
    /// chunk, tokens, frames and every input's shape, and reads back.** And
    /// build 2026092705's four-token marker still parses, so the kill already
    /// on the founder's phone is reported. MUTATION: drop `in=` from `line()`.
    func testTheBreadcrumbCarriesTheShapesAndReadsTheLegacyMarker() throws {
        let crumb = ProbeBreadcrumb(pass: "ane", stage: "first-predict", chunk: 0, peakBytes: 812_000_000,
                                    speed: 1.0, sub: "vocoder", run: 7, at: 9, tokens: 42, frames: 310,
                                    inputs: "asr:1x512x310,x_source_0:1x22x7440")
        let line = crumb.line()
        XCTAssertEqual(line, "v2 matrix ane first-predict 0 812000000 1.0 vocoder 7 9 tokens=42 frames=310 in=asr:1x512x310,x_source_0:1x22x7440")
        XCTAssertEqual(ProbeBreadcrumb.parse(line), crumb)
        XCTAssertNil(ProbeBreadcrumb.parse(line + " in=/private/var/x"), "a path is not a shape")
        XCTAssertNil(ProbeBreadcrumb.parse("v2 matrix ane first-predict 0 1 - - 0 0 note=hello"))
        let legacy = try XCTUnwrap(ProbeBreadcrumb.parse("ane synth 0 812000000"))
        XCTAssertEqual(legacy.pass, "ane")
        XCTAssertEqual(legacy.stage, "synth")
        XCTAssertEqual(legacy.mode, "matrix")
        XCTAssertEqual(ProbeBreadcrumb.inputsToken(["b": [1, 128], "a": [1, 42]]), "a:1x42,b:1x128", "sorted by name")
    }

    /// **Every Core ML stage's predict is breadcrumbed BEFORE it runs, with
    /// the chunk, speed, tokens, frames and input shapes** — the call that
    /// died in the founder's .ips. And every ORT run gets its own crumb
    /// before the engine sees the chunk. MUTATION: move the chunk's
    /// `onProgress` after `synthesize`, or drop the hook in `measurePass`.
    func testEachPredictAndEachRunIsBreadcrumbedBeforeItStarts() {
        let ledger = ledger()
        let marker = ledger.inFlight.url
        var seen: [String] = []
        let coreml = StagedFakeEngine(provider: "coreml") {
            seen.append((try? String(contentsOf: marker, encoding: .utf8)) ?? "")
        }
        _ = ForayTtsPlugin.measurePasses(
            passes: [.ane], idLines: [[0, 1, 2, 0], [0, 3, 4, 5, 0]], modelURL: nil,
            makeEngine: { _ in .engine(coreml) }, isForeground: { true }, isLocked: { false }, ledger: ledger)
        XCTAssertEqual(seen.count, 4, "one read per chunk per speed, inside the predict")
        XCTAssertTrue(seen[0].hasPrefix("v2 matrix ane first-predict 0 "), seen[0])
        XCTAssertTrue(seen[0].contains(" 1.0 vocoder "), seen[0])
        XCTAssertTrue(seen[0].contains("tokens=4 frames=310 in=asr:1x512x310,x_pre:1x512x7201"), seen[0])
        XCTAssertTrue(seen[3].hasPrefix("v2 matrix ane synth 1 "), seen[3])
        XCTAssertTrue(seen[3].contains(" 1.5 vocoder "), seen[3])
        XCTAssertTrue(seen[3].contains("tokens=5 "), seen[3])

        var ortSeen: [String] = []
        let ort = StagedFakeEngine(provider: "cpu", stages: false) {
            ortSeen.append((try? String(contentsOf: marker, encoding: .utf8)) ?? "")
        }
        _ = ForayTtsPlugin.measurePasses(
            passes: [.ortCpuT3], idLines: [[0, 1, 2, 0]], modelURL: nil,
            makeEngine: { _ in .engine(ort) }, isForeground: { true }, isLocked: { false }, ledger: ledger)
        XCTAssertTrue(ortSeen[0].hasPrefix("v2 matrix ort-cpu-t3 first-predict 0 "), ortSeen[0])
        XCTAssertTrue(ortSeen[0].contains(" 1.0 - ") && ortSeen[0].hasSuffix("tokens=4"), ortSeen[0])
        XCTAssertTrue(ortSeen[1].contains(" 1.5 - "), ortSeen[1])
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path), "a finished run leaves no breadcrumb")
    }

    // MARK: the launch

    /// **At launch a leftover breadcrumb becomes a report FIRST and is
    /// cleared SECOND; the report outlives every read until the page acks
    /// it; a Core ML kill skips every Core ML pass.** MUTATION: clear the
    /// breadcrumb in `promoteLeftover` before writing the report, or delete
    /// the report on read (the v3 `takeLeftover` bug).
    func testALeftoverIsPromotedToAReportAndOnlyTheAckForgetsIt() throws {
        let ledger = ledger()
        ledger.inFlight.note(ProbeBreadcrumb(pass: "ane", stage: "first-predict", chunk: 0, peakBytes: 812_000_000,
                                             speed: 1.0, sub: "vocoder", run: 5, tokens: 42, frames: 310,
                                             inputs: "asr:1x512x310"))
        let report = try XCTUnwrap(ledger.promoteLeftover(now: 99))
        XCTAssertFalse(ledger.inFlight.exists, "the breadcrumb is cleared once the report is on disk")
        XCTAssertEqual(report["killedPass"] as? String, "ane")
        XCTAssertEqual(report["killedStage"] as? String, "first-predict")
        XCTAssertEqual(report["killedSub"] as? String, "vocoder")
        XCTAssertEqual(report["killedTokens"] as? Int, 42)
        XCTAssertEqual(report["killedFrames"] as? Int, 310)
        XCTAssertEqual(report["killedIn"] as? String, "asr:1x512x310")
        XCTAssertEqual(report["skipped"] as? [String], ["cml-cpu", "ane-cputail", "ane"],
                       "one libBNNS under all three Core ML passes")
        XCTAssertEqual(ledger.quarantine.entries().map { $0.pass }, [.cmlCpu, .aneCputail, .ane])
        // Read twice: still there. The status the page reads carries it.
        XCTAssertEqual(reports(ledger).count, 1)
        XCTAssertEqual(reports(ledger).count, 1)
        let status = ForayTtsPlugin.probeStatus(ledger, version: OperatingSystemVersion(majorVersion: 26, minorVersion: 6, patchVersion: 2))
        XCTAssertTrue((status["reportsJson"] as? String ?? "").contains("\"killedPass\":\"ane\""))
        XCTAssertTrue((status["skippedJson"] as? String ?? "").contains("\"pass\":\"cml-cpu\""))
        XCTAssertEqual(status["bnnsAffected"] as? Bool, true)
        // A second launch with nothing in flight adds nothing.
        XCTAssertNil(ledger.promoteLeftover())
        // Only the ack forgets it.
        let id = try XCTUnwrap(report["id"] as? String)
        XCTAssertEqual(ledger.acknowledge(ids: ["someone-else"]), 0)
        XCTAssertEqual(ledger.acknowledge(ids: [id]), 1)
        XCTAssertEqual(reports(ledger).count, 0)
        // The skip list stays until "Reset skipped passes".
        XCTAssertEqual(ledger.quarantine.reset(), 3)
        XCTAssertTrue(ledger.quarantine.entries().isEmpty)
    }

    /// **Build 2026092705's marker (tmp, four tokens) is promoted too**, and
    /// an ORT kill skips only its own pass. A soak kill is reported but skips
    /// nothing (it is the soak's finding, not a crash to avoid).
    func testTheLegacyMarkerAndAnOrtKillAndASoakKill() throws {
        let legacy = dir.appendingPathComponent("legacy-inflight.txt")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try "ane synth 0 812000000".write(to: legacy, atomically: true, encoding: .utf8)
        let ledger = ledger(legacy: legacy)
        let report = try XCTUnwrap(ledger.promoteLeftover(now: 1))
        XCTAssertEqual(report["killedPass"] as? String, "ane")
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacy.path))
        XCTAssertEqual(ledger.quarantine.reset(), 3)

        ledger.inFlight.note(pass: .ortCpuT4, stage: "synth", chunksDone: 3, peakBytes: 1)
        _ = ledger.promoteLeftover(now: 2)
        XCTAssertEqual(ledger.quarantine.entries().map { $0.pass }, [.ortCpuT4])
        _ = ledger.quarantine.reset()

        ledger.inFlight.note(pass: .aneCputail, stage: "soak", chunksDone: 40, peakBytes: 1, mode: "soak")
        _ = ledger.promoteLeftover(now: 3)
        XCTAssertTrue(ledger.quarantine.entries().isEmpty, "a soak kill quarantines nothing")
        XCTAssertEqual(reports(ledger).count, 3, "every kill is a report")
    }

    // MARK: the run

    /// **A quarantined pass is not built, says `skipped-killed-last-run`
    /// with where it died, and the others still run.** MUTATION: ignore the
    /// skip list — `make ane` appears and the phone dies again.
    func testASkippedPassIsNeverBuiltAndSaysWhere() {
        let ledger = ledger()
        ledger.quarantine.add(ProbeBreadcrumb(pass: "ane", stage: "first-predict", chunk: 0, peakBytes: 812_000_000,
                                              speed: 1.0, sub: "vocoder", tokens: 42))
        var made: [String] = []
        let result = ForayTtsPlugin.measurePasses(
            passes: [.ortCpuT2, .ane], idLines: [[0, 1, 2, 0]], modelURL: nil,
            makeEngine: { pass in made.append(pass.rawValue); return .engine(StagedFakeEngine(provider: "cpu", stages: false)) },
            isForeground: { true }, isLocked: { false }, ledger: ledger)
        XCTAssertEqual(made, ["ort-cpu-t2"], "no Core ML pass is built after a Core ML kill")
        let passes = result["passes"] as? [[String: Any]] ?? []
        let skipped = passes.filter { $0["reason"] as? String == "skipped-killed-last-run" }
        XCTAssertEqual(skipped.map { $0["pass"] as? String }, ["ane", "ane"])
        XCTAssertEqual(skipped.first?["detail"] as? String, "first-predict-vocoder")
        XCTAssertEqual(skipped.first?["prevKilledSub"] as? String, "vocoder")
        XCTAssertEqual(skipped.first?["prevKilledTokens"] as? Int, 42)
        XCTAssertEqual(passes.filter { $0["ok"] as? Bool == true }.count, 2)
    }

    /// **Each pass's records are handed over and journaled the moment the
    /// pass ends**, before the next pass is built, so a kill in pass 4 still
    /// leaves 1-3. MUTATION: call `onPassDone` after the loop.
    func testEachPassIsHandedOverAndJournaledAsItEnds() {
        let ledger = ledger()
        var events: [String] = []
        var journaledAtDone: [Int] = []
        _ = ForayTtsPlugin.measurePasses(
            passes: [.ortCpuT2, .ortCpuT3, .ortCpuT4], idLines: [[0, 1, 2, 0]], modelURL: nil,
            makeEngine: { pass in events.append("make \(pass.rawValue)"); return .engine(StagedFakeEngine(provider: "cpu", stages: false)) },
            isForeground: { true }, isLocked: { false }, ledger: ledger, run: 42,
            onPassStart: { pass, order in events.append("start \(order) \(pass.rawValue)") },
            onPassDone: { pass, records in
                events.append("done \(pass.rawValue) \(records.count)")
                journaledAtDone.append(ledger.journaled().count)
            })
        XCTAssertEqual(events, ["start 0 ort-cpu-t2", "make ort-cpu-t2", "done ort-cpu-t2 2",
                                "start 1 ort-cpu-t3", "make ort-cpu-t3", "done ort-cpu-t3 2",
                                "start 2 ort-cpu-t4", "make ort-cpu-t4", "done ort-cpu-t4 2"])
        XCTAssertEqual(journaledAtDone, [2, 4, 6], "on disk before the next pass starts")
        XCTAssertTrue(ledger.journaled().isEmpty, "a finished run clears its journal")
    }

    /// **A kill's report carries the passes that finished before it**
    /// (the journal), so the page can still write them.
    func testAKillReportCarriesTheFinishedPasses() throws {
        let ledger = ledger()
        ledger.journal(run: 11, records: [["pass": "ort-cpu-t2", "speed": 1.0, "ok": true, "probeRun": 11.0]])
        ledger.inFlight.note(pass: .cmlCpu, stage: "compile", chunksDone: 0, peakBytes: 1, sub: "albert", run: 11)
        let report = try XCTUnwrap(ledger.promoteLeftover(now: 12))
        XCTAssertEqual((report["completed"] as? [[String: Any]])?.first?["pass"] as? String, "ort-cpu-t2")
        XCTAssertTrue(ledger.journaled().isEmpty)
    }

    /// **What the engine was handed travels on the record**: the longest
    /// chunk (tokens, frames) and per stage the largest input shape.
    /// MUTATION: drop `stageIn` from the record.
    func testStageInputsAndFramesTravelOnTheRecord() {
        let out = ForayTtsPlugin.measurePass(engine: StagedFakeEngine(provider: "coreml"), pass: .ane,
                                             idLines: [[0, 1, 2, 0], [0, 1, 2, 3, 4, 0]], speeds: [1.0, 1.5],
                                             modelFacts: nil, isForeground: { true }, isLocked: { false })
        XCTAssertEqual(out.records[0]["maxTokens"] as? Int, 6)
        XCTAssertEqual(out.records[0]["maxFrames"] as? Int, 310)
        XCTAssertEqual(out.records[0]["stageIn"] as? [String], ["1x6", "-", "-", "-", "-", "1x512x310", "-"])
        XCTAssertEqual(ProbeMath.widerShape("1x4", "1x6"), "1x6")
        XCTAssertEqual(ProbeMath.widerShape("-", "1x2"), "1x2")
        XCTAssertEqual(ProbeMath.widerShape("1x512x9", "1x8"), "1x512x9")
    }

    // MARK: the OS gate and the shape guard

    /// **Core ML is refused on iOS 26.4 and later (Apple's libBNNS fault,
    /// FluidAudio #844/#889) unless armed.** MUTATION: compare against 27.
    func testCoreMLIsGatedOnTheAffectedOSUnlessArmed() {
        func v(_ major: Int, _ minor: Int) -> OperatingSystemVersion {
            OperatingSystemVersion(majorVersion: major, minorVersion: minor, patchVersion: 0)
        }
        XCTAssertFalse(ProbeCoreMLGuard.bnnsAffected(v(26, 3)))
        XCTAssertTrue(ProbeCoreMLGuard.bnnsAffected(v(26, 4)))
        XCTAssertTrue(ProbeCoreMLGuard.bnnsAffected(v(26, 6)))
        XCTAssertTrue(ProbeCoreMLGuard.bnnsAffected(v(27, 0)))
        XCTAssertFalse(ProbeCoreMLGuard.bnnsAffected(v(18, 6)))
        XCTAssertEqual(ProbeCoreMLGuard.refusal(version: v(26, 6), armed: false), "coreml-bnns-os")
        XCTAssertNil(ProbeCoreMLGuard.refusal(version: v(26, 6), armed: true))
        XCTAssertNil(ProbeCoreMLGuard.refusal(version: v(18, 6), armed: false))
    }

    /// **An input outside a stage model's declared shapes is refused by
    /// name (`cml-shape`) before Core ML is handed it.**
    func testTheShapeGuardRefusesOnlyWhatIsPlainlyOutside() throws {
        guard #available(iOS 17.0, *) else { throw XCTSkip("the Core ML engine is iOS 17+") }
        XCTAssertTrue(KokoroCoreMLEngine.shapeAllowed([1, 42], enumerated: [[1, 42], [1, 128]], ranges: []))
        XCTAssertFalse(KokoroCoreMLEngine.shapeAllowed([1, 43], enumerated: [[1, 42], [1, 128]], ranges: []))
        XCTAssertTrue(KokoroCoreMLEngine.shapeAllowed([1, 300], enumerated: [], ranges: [1...1, 1...512]))
        XCTAssertFalse(KokoroCoreMLEngine.shapeAllowed([1, 600], enumerated: [], ranges: [1...1, 1...512]))
        XCTAssertTrue(KokoroCoreMLEngine.shapeAllowed([1, 2, 3], enumerated: [], ranges: [1...1, 1...512]),
                      "a rank the ranges do not describe is left to Core ML")
        XCTAssertTrue(KokoroCoreMLEngine.shapeAllowed([1, 9], enumerated: [], ranges: []))
        XCTAssertTrue(KokoroCoreMLEngine.CODES.contains("cml-shape"))
    }
}

/// A fake engine that, like the Core ML engine, calls `ProbeStageHook` before
/// its stages, and runs `during` from inside `synthesize` (the moment a
/// SIGSEGV would land) so a test can read the breadcrumb then.
private final class StagedFakeEngine: KokoroProbeEngine {
    let modelName = "fake"
    let provider: String
    private let stages: Bool
    private let during: () -> Void
    private var last: [String]?
    private var frames: Int?

    init(provider: String, stages: Bool = true, during: @escaping () -> Void = {}) {
        self.provider = provider
        self.stages = stages
        self.during = during
    }

    func load() -> (coldMs: Double, warmMs: Double) {
        if stages { ProbeStageHook.note("compile", "albert") }
        return (1, 1)
    }

    func synthesize(ids: [Int], speed: Double) -> (synthMs: Double, audioSec: Double, reason: String?) {
        if stages {
            ProbeStageHook.note("predict", "albert", inputs: "input_ids:1x\(ids.count)")
            ProbeStageHook.note("predict", "vocoder", frames: 310, inputs: "asr:1x512x310,x_pre:1x512x7201")
            last = ["1x\(ids.count)", "-", "-", "-", "-", "1x512x310", "-"]
            frames = 310
        }
        during()
        return (100, 2, nil)
    }

    var lastStageInputs: [String]? { last }
    var lastFrames: Int? { frames }
}
