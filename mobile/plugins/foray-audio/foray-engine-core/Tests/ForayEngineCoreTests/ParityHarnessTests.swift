import XCTest
import ForayEngineCore
import ForayEngineParity

/// The parity runner's own rules, each proved by breaking ONE input in memory
/// and watching the books turn red (card NE-05's mutations, kept as tests so
/// they stay proved). Every test starts from the REAL tree
/// (`player/parity/`, read in place), so "the rest is green" is a fact about
/// the repo, not about a hand-made fixture.
final class ParityHarnessTests: XCTestCase {
    private func realData() throws -> ParityData {
        try ParityData.load(parityDir: try ParityLocator.locate())
    }

    private func outcome(_ id: String, in report: SuiteReport) -> CaseResult.Outcome? {
        report.results.first { $0.id == id }?.outcome
    }

    private var seamId: String { "seam-gap/rule-is-2.0s" }

    // MARK: the books

    func testTheRealTreeIsGreenAndRunsTheSeamGapFamily() throws {
        let report = ParitySuite(data: try realData()).run()
        XCTAssertTrue(report.ok, report.failures.map { "\($0.id): \($0.detail)" }.joined(separator: "\n")
            + report.problems.joined(separator: "\n"))
        let seam = try XCTUnwrap(report.summary(for: "seam-gap"))
        XCTAssertTrue(seam.hasRunner)
        XCTAssertEqual(seam.executed, seam.cases)
        XCTAssertEqual(seam.passed, seam.cases, "seam-gap is burned down in full by NE-05")
        XCTAssertGreaterThanOrEqual(seam.cases, 30)
    }

    /// THE CARD'S MUTATION: move one seam-gap id into swift-pending.json
    /// while Swift passes it, and the runner goes red. A pending entry that
    /// passes is stale, and a list that is never burned down stops meaning
    /// "owed". TO SEE IT FAIL: make a pending pass an `.pending` outcome.
    func testAPendingIdThatPassesTurnsTheRunRed() throws {
        var data = try realData()
        data.pending[seamId] = "NE-05"
        let report = ParitySuite(data: data).run()
        XCTAssertEqual(outcome(seamId, in: report), .stalePending)
        XCTAssertFalse(report.ok)
    }

    /// A manifest id the Swift side neither ran nor owes is a rule it
    /// silently dropped. TO SEE IT FAIL: count a runner-less id as not-ported
    /// whether or not it is pending.
    func testAManifestIdNeitherExecutedNorPendingTurnsTheRunRed() throws {
        var data = try realData()
        data.manifest["zz-unported"] = ["zz-unported/a"]
        data.fixtures["zz-unported"] = []
        let red = ParitySuite(data: data).run()
        XCTAssertEqual(outcome("zz-unported/a", in: red), .unaccounted)
        XCTAssertFalse(red.ok)

        data.pending["zz-unported/a"] = "NE-99s"
        let owed = ParitySuite(data: data).run()
        XCTAssertEqual(outcome("zz-unported/a", in: owed), .notPorted)
        XCTAssertTrue(owed.ok, "an owed id is not a failure")
    }

    /// A runner that exists but lost a case is the same drop.
    func testAnIdMissingFromTheFixtureFilesIsUnaccounted() throws {
        var data = try realData()
        data.manifest["seam-gap"]?.append("seam-gap/not-in-any-file")
        let report = ParitySuite(data: data).run()
        XCTAssertEqual(outcome("seam-gap/not-in-any-file", in: report), .unaccounted)
    }

    // MARK: jsOnly families (plan §5.5 C-2, card NE-13)

    private var continuationId: String { "continuation/plan-empty-state" }

    /// The continuation hops are the page's rule by design: the engine walks
    /// what JS computed and never ports it, and record.mjs refuses to put the
    /// ids in swift-pending.json. So they must be neither run nor owed, and
    /// the real tree stays green. TO SEE IT FAIL: drop the `jsOnly` branch in
    /// ParitySuite.run, and every continuation id is `unaccounted`.
    func testAJsOnlyFamilyIsNeitherRunNorOwed() throws {
        let report = ParitySuite(data: try realData()).run()
        XCTAssertEqual(outcome(continuationId, in: report), .jsOnly)
        let family = try XCTUnwrap(report.summary(for: "continuation"))
        XCTAssertTrue(family.jsOnly)
        XCTAssertGreaterThan(family.cases, 0)
        XCTAssertEqual(family.executed, 0)
        XCTAssertEqual(family.owed, 0)
        XCTAssertEqual(family.failed, 0)
        XCTAssertTrue(family.logLine.hasSuffix(" js-only"), family.logLine)
        XCTAssertTrue(report.problems(for: "continuation").isEmpty, report.problems.joined(separator: "\n"))
    }

    /// The FLAG decides, not the family's name: the same files without it are
    /// a dropped rule. TO SEE IT FAIL: stop reading `jsOnly` in FixtureFile.
    func testWithoutTheFlagTheSameFamilyIsUnaccounted() throws {
        var data = try realData()
        data.fixtures["continuation"] = try XCTUnwrap(data.fixtures["continuation"]).map {
            FixtureFile(path: $0.path, family: $0.family, module: $0.module, cases: $0.cases, jsOnly: false)
        }
        let report = ParitySuite(data: data).run()
        XCTAssertEqual(outcome(continuationId, in: report), .unaccounted)
        XCTAssertFalse(report.ok)
    }

    /// Owing a jsOnly id, or registering a runner for its family, says the rule
    /// is being ported after all; the books must not hold both answers.
    /// TO SEE IT FAIL: drop either problem in the `jsOnly` branch.
    func testAPendingEntryOrARunnerForAJsOnlyFamilyIsAProblem() throws {
        var data = try realData()
        data.pending[continuationId] = "NE-99s"
        let owed = ParitySuite(data: data).run()
        XCTAssertFalse(owed.ok)
        XCTAssertTrue(owed.problems(for: "continuation").contains { $0.contains(continuationId) && $0.contains("NE-99s") })

        let stray = PureFamilyRunner(family: "continuation", module: "player/continuation.js", reads: [:], calls: [:])
        let ported = ParitySuite(data: try realData(), runners: ParityFamilies.all + [stray as FamilyRunner]).run()
        XCTAssertFalse(ported.ok)
        XCTAssertTrue(ported.problems(for: "continuation").contains { $0.contains("runner is registered") })
    }

    /// TO SEE IT FAIL: compare with `==` on anything, or skip the compare.
    func testAWrongExpectFailsAndAnOwedOneDoesNot() throws {
        var data = try realData()
        let file = try XCTUnwrap(data.fixtures["seam-gap"]?.first)
        let cases = file.cases.map { $0.id == seamId ? $0.with(expect: .object(["value": .number(2.5)])) : $0 }
        data.fixtures["seam-gap"] = [FixtureFile(path: file.path, family: file.family, module: file.module, cases: cases)]
        let red = ParitySuite(data: data).run()
        XCTAssertEqual(outcome(seamId, in: red), .failed)
        XCTAssertFalse(red.ok)

        data.pending[seamId] = "NE-28s"
        let owed = ParitySuite(data: data).run()
        XCTAssertEqual(outcome(seamId, in: owed), .pending)
        XCTAssertTrue(owed.ok)
    }

    func testACaseWithNoExpectIsNeverAPass() throws {
        var data = try realData()
        let file = try XCTUnwrap(data.fixtures["seam-gap"]?.first)
        let cases = file.cases.map { testCase -> FixtureCase in
            guard testCase.id == seamId else { return testCase }
            var fields = testCase.fields
            fields["expect"] = nil
            return FixtureCase(id: testCase.id, fields: fields)
        }
        data.fixtures["seam-gap"] = [FixtureFile(path: file.path, family: file.family, module: file.module, cases: cases)]
        XCTAssertEqual(outcome(seamId, in: ParitySuite(data: data).run()), .failed)
    }

    /// A fixture that moved to another JS module pins a rule this port was
    /// never checked against: refused, not run.
    func testAFixtureNamingAnotherModuleIsRefused() throws {
        var data = try realData()
        let file = try XCTUnwrap(data.fixtures["seam-gap"]?.first)
        data.fixtures["seam-gap"] = [FixtureFile(path: file.path, family: file.family,
                                                 module: "player/somewhere-else.js", cases: file.cases)]
        let report = ParitySuite(data: data).run()
        XCTAssertEqual(outcome(seamId, in: report), .failed)
        XCTAssertEqual(report.results.first(where: { $0.id == seamId })?.detail.contains("E_BAD_CASE"), true)
    }

    /// "Zero failures" from a runner that ran too little is not a pass.
    func testAFloorAboveTheExecutedCountIsAProblem() throws {
        var data = try realData()
        data.floors["seam-gap"] = 10_000
        let report = ParitySuite(data: data).run()
        XCTAssertFalse(report.ok)
        XCTAssertTrue(report.problems(for: "seam-gap").contains { $0.contains("below its floor") })
    }

    func testAFixtureIdTheManifestLacksIsAProblem() throws {
        var data = try realData()
        data.manifest["seam-gap"]?.removeAll { $0 == seamId }
        let report = ParitySuite(data: data).run()
        XCTAssertTrue(report.problems.contains { $0.contains(seamId) && $0.contains("not in manifest.json") })
    }

    func testARunnerForAFamilyTheManifestLacksIsAProblem() throws {
        let stray = PureFamilyRunner(family: "no-such-family", module: "player/x.js", reads: [:], calls: [:])
        let report = ParitySuite(data: try realData(), runners: ParityFamilies.all + [stray as FamilyRunner]).run()
        XCTAssertTrue(report.problems.contains { $0.contains("no-such-family") })
    }

    func testTheReportRoundTripsAsJSONAndCarriesTheFamilyLine() throws {
        let report = ParitySuite(data: try realData()).run()
        let decoded = try JSONDecoder().decode(SuiteReport.self, from: try report.json())
        XCTAssertEqual(decoded, report)
        let line = try XCTUnwrap(report.summary(for: "seam-gap")).logLine
        XCTAssertTrue(line.hasPrefix("parity family=seam-gap cases="), line)
    }

    // MARK: locating the tree

    func testTheWalkFromThisFileFindsPlayerParity() throws {
        let dir = try ParityLocator.locate(environment: [:])
        XCTAssertEqual(dir.lastPathComponent, "parity")
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.appendingPathComponent("manifest.json").path))
    }

    func testForayParityDirWinsAndMayNameTheFixturesDirectory() throws {
        let real = try ParityLocator.locate(environment: [:])
        XCTAssertEqual(try ParityLocator.locate(environment: ["FORAY_PARITY_DIR": real.path]).path, real.path)
        let viaFixtures = real.appendingPathComponent("fixtures").path
        XCTAssertEqual(try ParityLocator.locate(environment: ["FORAY_PARITY_DIR": viaFixtures]).standardizedFileURL.path,
                       real.standardizedFileURL.path)
    }

    /// Set but wrong is an error, never a quiet fall-back to the walk.
    func testAWrongForayParityDirIsAnErrorNotAFallback() {
        XCTAssertThrowsError(try ParityLocator.locate(environment: ["FORAY_PARITY_DIR": "/no/such/dir"]))
    }

    func testNoTreeAboveTheFileIsAnError() {
        XCTAssertThrowsError(try ParityLocator.locate(environment: [:], filePath: "/no/such/place/File.swift"))
    }

    // MARK: the codec (player/parity/codec.js)

    func testSegExpandsToSeamGapTestsSegWithItsDefaults() throws {
        let ctx = Codec.Context(repoRoot: nil)
        let seg = try Codec.expandInputs(.object(["$seg": .array([.string("a")])]), ctx)
        XCTAssertEqual(seg, .object(["id": .string("a"), "kind": .string("episode"),
                                     "start_sec": .number(100), "end_sec": .number(210)]))
        let withExtra = try Codec.expandInputs(.object(["$seg": .array([
            .string("b"), .number(0), .object(["$num": .string("Infinity")]), .object(["kind": .string("tts")])
        ])]), ctx)
        XCTAssertEqual(withExtra["kind"], .string("tts"), "a later key wins, as a JS spread does")
        XCTAssertEqual(withExtra["end_sec"], .number(.infinity))
        XCTAssertEqual(try Codec.expandInputs(.object(["$tts": .array([.string("n1")])]), ctx),
                       .object(["id": .string("n1"), "kind": .string("tts")]))
    }

    func testTagsAreAloneAndClosed() {
        let ctx = Codec.Context(repoRoot: nil)
        XCTAssertThrowsError(try Codec.expandInputs(.object(["$nope": .null]), ctx)) {
            XCTAssertEqual(($0 as? HarnessError)?.code, "E_BAD_MACRO")
        }
        XCTAssertThrowsError(try Codec.expandInputs(.object(["$seg": .array([.string("a")]), "x": .null]), ctx)) {
            XCTAssertEqual(($0 as? HarnessError)?.code, "E_BAD_MACRO")
        }
        XCTAssertThrowsError(try Codec.expandInputs(.object(["$num": .string("nan")]), ctx)) {
            XCTAssertEqual(($0 as? HarnessError)?.code, "E_BAD_SPECIAL")
        }
        XCTAssertThrowsError(try Codec.expandInputs(.object(["$seg": .array([])]), ctx))
    }

    func testEncodeTagsWhatJSONCannotHoldAndDropsUndefinedMembers() {
        XCTAssertEqual(Codec.encode(JSValue.number(.nan)), .object(["$num": .string("NaN")]))
        XCTAssertEqual(Codec.encode(JSValue.number(-0.0)), .object(["$num": .string("-0")]))
        XCTAssertEqual(Codec.encode(JSValue.number(-.infinity)), .object(["$num": .string("-Infinity")]))
        XCTAssertEqual(Codec.encode(JSValue.undefined), .object(["$undefined": .bool(true)]))
        XCTAssertEqual(Codec.encode(JSValue.object(["a": .undefined, "b": .number(1)])), .object(["b": .number(1)]))
        XCTAssertEqual(Codec.encode(JSValue.array([.undefined])), .array([.object(["$undefined": .bool(true)])]))
    }

    // MARK: JavaScript number text

    /// Swift prints `2.0`, `1e-07` and `1e+16`; JavaScript prints `2`, `1e-7`
    /// and `10000000000000000`. The comparator's "differs by more than" text
    /// is in the compare fixtures, so it must be JavaScript's.
    func testNumbersAreSpelledAsJavaScriptSpellsThem() {
        let table: [(Double, String)] = [
            (2, "2"), (0.1, "0.1"), (-1.5, "-1.5"), (1e16, "10000000000000000"), (1e20, "100000000000000000000"),
            (1e21, "1e+21"), (1.5e300, "1.5e+300"), (0.000001, "0.000001"), (1e-7, "1e-7"), (2.5e-5, "0.000025"),
            (123.456, "123.456"), (-0.0, "0"), (.infinity, "Infinity"), (.nan, "NaN")
        ]
        for (value, text) in table { XCTAssertEqual(JSNumber.string(value), text, "\(value)") }
    }

    // MARK: the ported rule, directly

    func testTheSeamRuleIsTwoSecondsBetweenTwoSegmentsOnAutoAdvance() {
        let a = SeamItem(startSec: 100, endSec: 210)
        let b = SeamItem(startSec: 0, endSec: 90)
        XCTAssertEqual(SeamGap.defaultGapSec, 2.0)
        XCTAssertEqual(SeamGap.gapSec(from: a, to: b), 2.0)
        XCTAssertEqual(SeamGap.gapSec(from: a, to: b, cause: SeamGap.userAction), 0)
        XCTAssertEqual(SeamGap.gapSec(from: a, to: b, bridged: true), 0)
        XCTAssertEqual(SeamGap.gapSec(from: a, to: SeamItem(startSec: nil, endSec: nil)), 0)
        XCTAssertEqual(SeamGap.gapSec(from: a, to: b, gapSec: .nan), 0)
        XCTAssertNil(ItemBounds.make(startSec: 210, endSec: 210))
        XCTAssertEqual(ItemBounds.make(startSec: -5, endSec: 10)?.startSec, 0)
    }
}
