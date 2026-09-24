import Foundation
import ForayEngineCore

/// The `manager-episode` family against `EngineCore` (card NE-14s), from the
/// scenarios NE-14j recorded from the real `PlayerQueueManager`: routes,
/// interruptions and the INTERRUPTION_REWIND_SEC step back, #19's single
/// audible start, cold launch, superseded loads, the double skip, pause
/// silence and position events, all through `EngineScenarioDriver`; and the
/// `lastEpisodeRow` pass-through through `EngineCore.lastEpisodeRow`, against
/// rows.js `engineLastEpisodeRow`.
public enum ManagerEpisodeFamily {
    public static let rowsModule = "player/parity/rows.js"

    public static let runner = makeRunner()

    /// A runner over a deliberately broken core, for the mutation tests.
    public static func makeRunner(mutation: EngineScenarioDriver.Mutation? = nil) -> FamilyRunner {
        ManagerEpisodeRunner(driver: EngineScenarioDriver(mutation: mutation))
    }
}

struct ManagerEpisodeRunner: FamilyRunner {
    let family = "manager-episode"
    let driver: EngineScenarioDriver

    func run(_ testCase: FixtureCase, in file: FixtureFile, context: Codec.Context) throws -> JSONValue {
        switch testCase.kind {
        case .scenario?:
            return try driver.run(testCase, context: context).encoded
        case .call?:
            guard file.module == ManagerEpisodeFamily.rowsModule else {
                throw HarnessError("E_BAD_CASE", "\(file.path) targets \(file.module ?? "no module"); the Swift manager-episode calls port \(ManagerEpisodeFamily.rowsModule)")
            }
            guard testCase.call == "engineLastEpisodeRow" else {
                throw HarnessError("E_UNKNOWN_EXPORT", "\(ManagerEpisodeFamily.rowsModule) has no Swift port of export \"\(testCase.call ?? "")\"")
            }
            let args = try OrderedFixtureArgs.args(of: testCase.id, in: file, context: context)
            return try engineLastEpisodeRow(args)
        case .read?:
            throw HarnessError("E_UNKNOWN_EXPORT", "the manager-episode family reads no constant")
        case nil:
            throw HarnessError("E_BAD_CASE", "case \(testCase.id) is not exactly one of read / call / steps")
        }
    }

    /// `engineLastEpisodeRow(lastEpisodeRow, nowMs)`: an object with a
    /// non-empty string id is written as `{...row, updated_at}`, where
    /// `new Date(nowMs).toISOString()` throws a RangeError for a time a Date
    /// cannot hold; anything else writes nothing.
    func engineLastEpisodeRow(_ args: [JSONNode]) throws -> JSONValue {
        let row = args.first ?? .null
        guard case .object = row, let id = row["id"]?.stringValue, !id.isEmpty else {
            return .object(["return": .array([])])
        }
        guard args.count > 1, let nowMs = args[1].numberValue, let stamp = JSWriter.isoString(epochMs: nowMs) else {
            return .object(["throws": .object(["name": .string("RangeError")])])
        }
        guard let stored = EngineCore.lastEpisodeRow(row, updatedAt: stamp) else {
            return .object(["return": .array([])])
        }
        return .object(["return": .array([.object(["key": .string(stored.key), "value": .string(stored.value)])])])
    }
}

/// A case's `args` IN THE ORDER THE FIXTURE WROTE THEIR KEYS.
///
/// `JSONValue` objects are dictionaries, which is right for comparing (key
/// order never matters there, compare.js) and wrong for an argument whose key
/// order IS the rule: `lastEpisodeRow` is stored verbatim, "in the order the
/// page sent it". So the case is read again from its file with the
/// order-keeping `JSONNode.parse` (the same parser the rows use).
enum OrderedFixtureArgs {
    static func args(of caseId: String, in file: FixtureFile, context: Codec.Context) throws -> [JSONNode] {
        guard let root = context.repoRoot else {
            throw HarnessError("E_BAD_CASE", "reading \(file.path) in key order needs the repo root, and this run has none")
        }
        let url = root.appendingPathComponent(file.path)
        let text: String
        do {
            text = try String(contentsOf: url, encoding: .utf8)
        } catch {
            throw HarnessError("E_BAD_CASE", "cannot read \(file.path): \(error)")
        }
        let doc: JSONNode
        do {
            doc = try JSONNode.parse(text)
        } catch {
            throw HarnessError("E_BAD_CASE", "cannot parse \(file.path): \(error)")
        }
        for entry in doc["cases"]?.arrayValue ?? [] where entry["id"]?.stringValue == caseId {
            return entry["args"]?.arrayValue ?? []
        }
        throw HarnessError("E_BAD_CASE", "\(caseId) is not in \(file.path)")
    }
}
