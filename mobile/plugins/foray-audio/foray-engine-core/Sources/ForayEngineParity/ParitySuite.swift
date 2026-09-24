import Foundation

/// The Swift parity runner (docs/native-engine-plan.md §6.4, card NE-05).
///
/// It walks `manifest.json` family by family, runs every case a registered
/// `FamilyRunner` can run, compares with the ported `Comparator`, and keeps
/// the books against `swift-pending.json`. Results come back AS DATA (a
/// `SuiteReport`); the XCTest wrappers turn them into one `XCTFail` per case,
/// and `parity-report.json` carries them to CI.
///
/// THE BOOKS, which are the point of the card:
///
///   executed & matched & not pending  -> passed
///   executed & differs  & not pending -> FAILED
///   executed & differs  & pending     -> pending   (owed, and honestly so)
///   executed & matched  & pending     -> FAILED "stale-pending": the port
///        caught up, so the card that owes it must burn the id down. Without
///        this a pending list only ever grows, and "pending" stops meaning
///        "not done".
///   not executed (no runner, or not in the fixture files) & pending
///                                     -> not-ported (owed)
///   not executed & not pending        -> FAILED "unaccounted": a manifest id
///        the Swift side neither ran nor owes, i.e. a rule it silently
///        dropped (plan §8 R6, the failure this deck exists to prevent).
///
/// Plus, per family a runner exists for: the executed count must reach the
/// family's floor in `floors.json`, so a runner that decodes nothing cannot
/// report "zero failures" as a pass.
public struct ParitySuite {
    public let data: ParityData
    public let runners: [String: FamilyRunner]

    public init(data: ParityData, runners: [FamilyRunner] = ParityFamilies.all) {
        self.data = data
        var byFamily: [String: FamilyRunner] = [:]
        for runner in runners { byFamily[runner.family] = runner }
        self.runners = byFamily
    }

    public func run() -> SuiteReport {
        let context = Codec.Context(repoRoot: data.repoRoot)
        var families: [FamilySummary] = []
        var results: [CaseResult] = []
        var problems: [String] = []

        for family in data.manifest.keys.sorted() {
            let ids = data.manifest[family] ?? []
            let runner = runners[family]
            var index: [String: (FixtureCase, FixtureFile)] = [:]
            for file in data.fixtures[family] ?? [] {
                if file.family != family {
                    problems.append("\(file.path) says family \(file.family), but manifest.json lists it under \(family)")
                }
                for testCase in file.cases { index[testCase.id] = (testCase, file) }
            }
            let manifestIds = Set(ids)
            for stray in index.keys.sorted() where !manifestIds.contains(stray) {
                problems.append("\(stray) is in a \(family) fixture file but not in manifest.json (re-record)")
            }

            var familyResults: [CaseResult] = []
            for id in ids {
                let owedBy = data.pending[id]
                guard let runner, let entry = index[id] else {
                    let why = runner == nil ? "no Swift runner for family \(family)" : "not in the fixture files manifest.json lists"
                    familyResults.append(owedBy != nil
                        ? CaseResult(id: id, family: family, outcome: .notPorted, detail: "owed by \(owedBy!) (\(why))")
                        : CaseResult(id: id, family: family, outcome: .unaccounted,
                                     detail: "neither executed nor in swift-pending.json (\(why))"))
                    continue
                }
                let (testCase, file) = entry
                let verdict = ParitySuite.execute(testCase, in: file, runner: runner, context: context)
                switch (verdict, owedBy) {
                case (nil, nil):
                    familyResults.append(CaseResult(id: id, family: family, outcome: .passed, detail: ""))
                case (nil, let card?):
                    familyResults.append(CaseResult(id: id, family: family, outcome: .stalePending,
                        detail: "passes in Swift but swift-pending.json still says \(card) owes it: delete the entry"))
                case (let failure?, nil):
                    familyResults.append(CaseResult(id: id, family: family, outcome: .failed, detail: failure))
                case (let failure?, let card?):
                    familyResults.append(CaseResult(id: id, family: family, outcome: .pending,
                        detail: "owed by \(card): \(failure)"))
                }
            }

            let summary = FamilySummary(family: family, results: familyResults, hasRunner: runner != nil,
                                        floor: data.floors[family])
            if runner != nil, let floor = summary.floor, summary.executed < floor {
                problems.append("family \(family) executed \(summary.executed) case(s), below its floor of \(floor) in floors.json")
            }
            if runner != nil && summary.executed == 0 && !ids.isEmpty {
                problems.append("family \(family) has a Swift runner and executed nothing")
            }
            families.append(summary)
            results.append(contentsOf: familyResults)
        }
        for family in runners.keys.sorted() where data.manifest[family] == nil {
            problems.append("a Swift runner is registered for family \(family), which manifest.json does not list")
        }
        return SuiteReport(families: families, results: results, problems: problems)
    }

    /// Run one case: nil when it matches its expect, otherwise why not.
    static func execute(_ testCase: FixtureCase, in file: FixtureFile, runner: FamilyRunner,
                        context: Codec.Context) -> String? {
        guard let expect = testCase.expect else {
            return "unrecorded: the case has no expect (run tools/parity/record.mjs)"
        }
        let actual: JSONValue
        do {
            actual = try runner.run(testCase, in: file, context: context)
        } catch {
            return "cannot run: \(error)"
        }
        let diffs = Comparator.compare(expect, actual, family: file.family, tolerance: testCase.tolerance)
        return diffs.isEmpty ? nil : "Swift differs from the fixture\n" + Comparator.format(diffs)
    }
}

public struct CaseResult: Codable, Equatable {
    public enum Outcome: String, Codable {
        case passed
        case failed
        case pending
        case stalePending = "stale-pending"
        case notPorted = "not-ported"
        case unaccounted

        /// The outcomes that fail the run.
        public var isFailure: Bool { self == .failed || self == .stalePending || self == .unaccounted }
        /// The outcomes where the Swift port actually ran the case.
        public var wasExecuted: Bool { self == .passed || self == .failed || self == .pending || self == .stalePending }
    }

    public let id: String
    public let family: String
    public let outcome: Outcome
    public let detail: String
}

public struct FamilySummary: Codable, Equatable {
    public let family: String
    public let hasRunner: Bool
    public let floor: Int?
    /// Manifest ids in the family.
    public let cases: Int
    public let executed: Int
    public let passed: Int
    /// Owed: pending (ran, differs) plus not-ported (not run).
    public let owed: Int
    public let failed: Int

    init(family: String, results: [CaseResult], hasRunner: Bool, floor: Int?) {
        self.family = family
        self.hasRunner = hasRunner
        self.floor = floor
        cases = results.count
        executed = results.filter { $0.outcome.wasExecuted }.count
        passed = results.filter { $0.outcome == .passed }.count
        owed = results.filter { $0.outcome == .pending || $0.outcome == .notPorted }.count
        failed = results.filter { $0.outcome.isFailure }.count
    }

    /// The log line the plan names (`parity family=<f> cases=<n>`), with the
    /// books after it so a CI log alone says what ran.
    public var logLine: String {
        "parity family=\(family) cases=\(cases) executed=\(executed) passed=\(passed) owed=\(owed) failed=\(failed)"
            + (hasRunner ? "" : " runner=none")
    }
}

public struct SuiteReport: Codable, Equatable {
    public let families: [FamilySummary]
    public let results: [CaseResult]
    /// Whole-family and whole-tree problems (a floor not reached, a runner for
    /// a family that does not exist, a fixture id the manifest lacks).
    public let problems: [String]

    public var failures: [CaseResult] { results.filter { $0.outcome.isFailure } }
    public var ok: Bool { failures.isEmpty && problems.isEmpty }
    public var executed: Int { results.filter { $0.outcome.wasExecuted }.count }

    public func results(for family: String) -> [CaseResult] { results.filter { $0.family == family } }
    public func summary(for family: String) -> FamilySummary? { families.first { $0.family == family } }
    public func problems(for family: String) -> [String] {
        problems.filter { $0.contains("family \(family) ") || $0.contains("fixtures/\(family)/") }
    }

    /// `parity-report.json`: the whole report, key-sorted, so two runs of the
    /// same tree write the same bytes.
    public func json() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(self)
    }
}

/// One run per test process, shared by every wrapper method.
///
/// Each wrapper method asserts on ONE family (one method per family, one
/// `XCTFail` per case), but the books are only right over the whole
/// manifest, and printing the family lines and writing `parity-report.json`
/// once is what a CI log wants. So the first method to ask runs everything,
/// and the rest read the cached report.
public enum SharedParityRun {
    public static let reportKey = "PARITY_REPORT"

    private static var cached: Result<SuiteReport, Error>?
    private static let lock = NSLock()

    /// The report for this process's run, running it on first use. Throws when
    /// the fixture tree cannot be found or read: a wrapper must FAIL then,
    /// never skip, or the zero-.github fallback could vanish silently.
    public static func report(environment: [String: String] = ProcessInfo.processInfo.environment,
                              filePath: String = #filePath) throws -> SuiteReport {
        lock.lock()
        defer { lock.unlock() }
        if let cached { return try cached.get() }
        let result = Result<SuiteReport, Error> {
            let dir = try ParityLocator.locate(environment: environment, filePath: filePath)
            let report = ParitySuite(data: try ParityData.load(parityDir: dir)).run()
            print("parity dir=\(dir.path)")
            for family in report.families { print(family.logLine) }
            for problem in report.problems { print("parity problem: \(problem)") }
            if let path = environment[reportKey], !path.isEmpty {
                try report.json().write(to: URL(fileURLWithPath: path))
                print("parity report=\(path)")
            }
            return report
        }
        cached = result
        return try result.get()
    }
}
