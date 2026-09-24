import Foundation
import ForayEngineCore

/// The parity engine's first shape: decode a case, run it against the core,
/// compare, and hand back RESULTS AS DATA (docs/native-engine-plan.md §6.4).
///
/// NO `import XCTest`, AND THAT IS THE POINT OF THIS TARGET. SwiftPM test
/// targets cannot share sources across packages, so the only way one parity
/// engine runs in both `Tests/ForayEngineCoreTests` (host `swift test`) and
/// `ForayAudioPluginTests` (`xcodebuild test -scheme ForayAudio` on a
/// Simulator) is a library that each of them wraps in a few lines.
/// `shell-invariants.test.mjs` fails on an XCTest import here.
///
/// THIS IS NE-01's SMOKE RUNNER, KEPT. Its cases are inline and pin the two
/// answers NE-01 put in the core; they need no fixture directory, so they
/// still run when the fixture tree cannot be found (and a wrapper then fails
/// for THAT reason, not for a smoke case). The real runner is `ParitySuite`
/// (NE-05): it reads `player/parity/fixtures` in place, runs each family
/// through its `FamilyRunner`, keeps the `swift-pending.json` books and writes
/// `parity-report.json`.
public enum ParityRunner {
    /// A call the runner does not know is a FAILURE, never a skip: a renamed
    /// callable would otherwise turn every case that names it green.
    public static let callables: [String: (JSONValue) -> JSONValue?] = [
        "EngineHandshake.notBuiltHello": { _ in
            .object(EngineHandshake.notBuiltHello().mapValues { .string($0) })
        },
        "SharedRowStore.userDefaultsKey": { args in
            guard case let .object(fields) = args,
                  case let .string(rowKey)? = fields["rowKey"] else { return nil }
            return .string(SharedRowStore.userDefaultsKey(for: rowKey))
        }
    ]

    public static func decodeCases(_ data: Data) throws -> [ParityCase] {
        try JSONDecoder().decode([ParityCase].self, from: data)
    }

    public static func run(_ cases: [ParityCase]) -> ParityReport {
        ParityReport(results: cases.map(runOne))
    }

    static func runOne(_ testCase: ParityCase) -> ParityResult {
        guard let call = callables[testCase.call] else {
            return ParityResult(id: testCase.id, outcome: .fail,
                                detail: "unknown call \(testCase.call)")
        }
        guard let actual = call(testCase.args ?? .object([:])) else {
            return ParityResult(id: testCase.id, outcome: .fail,
                                detail: "\(testCase.call) rejected its args")
        }
        if actual == testCase.expect {
            return ParityResult(id: testCase.id, outcome: .pass, detail: "")
        }
        return ParityResult(id: testCase.id, outcome: .fail,
                            detail: "expected \(testCase.expect), got \(actual)")
    }

    /// The stub's own cases, inline rather than a bundled resource so the
    /// library needs no resource handling on any of its three platforms.
    /// They pin the two answers NE-01 added, in §6.2's case format.
    public static let smokeCasesJSON = #"""
    [
      {"id": "ne01.hello.not-built",
       "call": "EngineHandshake.notBuiltHello",
       "expect": {"mode": "legacy", "reason": "not-built"}},
      {"id": "ne01.rows.capacitor-storage-prefix",
       "call": "SharedRowStore.userDefaultsKey", "args": {"rowKey": "cp_last_episode"},
       "expect": "CapacitorStorage.cp_last_episode"}
    ]
    """#

    public static func smokeCases() throws -> [ParityCase] {
        try decodeCases(Data(smokeCasesJSON.utf8))
    }
}

public struct ParityCase: Decodable, Equatable {
    public let id: String
    public let covers: [String]?
    public let call: String
    public let args: JSONValue?
    public let expect: JSONValue

    public init(id: String, covers: [String]? = nil, call: String,
                args: JSONValue? = nil, expect: JSONValue) {
        self.id = id
        self.covers = covers
        self.call = call
        self.args = args
        self.expect = expect
    }
}

public struct ParityResult: Equatable {
    public enum Outcome: String { case pass, fail }
    public let id: String
    public let outcome: Outcome
    public let detail: String
}

public struct ParityReport: Equatable {
    public let results: [ParityResult]
    public var executed: Int { results.count }
    public var failures: [ParityResult] { results.filter { $0.outcome == .fail } }
}
