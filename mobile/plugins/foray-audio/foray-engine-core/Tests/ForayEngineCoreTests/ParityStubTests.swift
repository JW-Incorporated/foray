import XCTest
import ForayEngineCore
import ForayEngineParity

/// The THIN XCTest wrapper over `ForayEngineParity` on the host side
/// (docs/native-engine-plan.md §4.1): `swift test --package-path
/// mobile/plugins/foray-audio/foray-engine-core`, run by `ci.yml`'s `ios-kit`
/// on macOS today and by G-1a's `engine-parity` job on Linux once it exists.
/// Its twin, `ForayAudioPluginTests/EngineParityWrapperTests.swift`, runs the
/// same library inside `xcodebuild test -scheme ForayAudio` on a Simulator.
///
/// A wrapper asserts two things about a report, never one: that nothing
/// failed, AND that something ran. "Zero failures" alone is satisfied by a
/// runner that decoded nothing.
final class ParityStubTests: XCTestCase {
    func testSmokeCasesAllPass() throws {
        let report = ParityRunner.run(try ParityRunner.smokeCases())
        XCTAssertEqual(report.failures, [], report.failures.map(\.detail).joined(separator: "\n"))
        XCTAssertEqual(report.executed, 2)
    }

    /// TO SEE IT FAIL: make `runOne` return `.pass` whenever the call is
    /// known. The comparator must be able to say no, or every green above is
    /// worthless.
    func testAWrongExpectationFails() {
        let report = ParityRunner.run([
            ParityCase(id: "neg.hello", call: "EngineHandshake.notBuiltHello",
                       expect: .object(["mode": .string("native"), "reason": .string("not-built")]))
        ])
        XCTAssertEqual(report.failures.map(\.id), ["neg.hello"])
    }

    /// TO SEE IT FAIL: make an unknown `call` a pass or a skip. A renamed
    /// callable must turn its cases red, not quietly drop them.
    func testAnUnknownCallFails() {
        let report = ParityRunner.run([
            ParityCase(id: "neg.unknown", call: "NoSuch.thing", expect: .null)
        ])
        XCTAssertEqual(report.failures.map(\.id), ["neg.unknown"])
    }

    func testCasesDecodeInThePlanCaseFormat() throws {
        let cases = try ParityRunner.decodeCases(Data(#"""
        [{"id": "a", "covers": ["queue-state: x"], "call": "SharedRowStore.userDefaultsKey",
          "args": {"rowKey": "cp_pos:ep1", "n": 1.5, "b": true, "z": null, "l": [1]},
          "expect": "CapacitorStorage.cp_pos:ep1"}]
        """#.utf8))
        XCTAssertEqual(cases.count, 1)
        XCTAssertEqual(cases[0].covers, ["queue-state: x"])
        XCTAssertEqual(ParityRunner.run(cases).failures, [])
    }

    /// The stub `engineHello` answer (§5.1). The plugin copies this dictionary
    /// verbatim, so this is the answer a page would see from a build with no
    /// engine in it.
    func testNotBuiltHelloIsLegacyNotBuilt() {
        XCTAssertEqual(EngineHandshake.notBuiltHello(), ["mode": "legacy", "reason": "not-built"])
        XCTAssertEqual(EngineHandshake.protocolVersion, 1)
    }

    /// The host-side half of the prefix pin. The other half, against the real
    /// `@capacitor/preferences` class, needs a Simulator and lives in
    /// `ForayAudioPluginTests/CapacitorStoragePrefixTests.swift`.
    func testSharedRowKeysCarryTheCapacitorStoragePrefix() {
        XCTAssertEqual(SharedRowStore.preferencesKeyPrefix, "CapacitorStorage.")
        XCTAssertEqual(SharedRowStore.userDefaultsKey(for: "cp_foray:abc"), "CapacitorStorage.cp_foray:abc")
    }
}
