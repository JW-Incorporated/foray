import Foundation

/// One fixture file, `player/parity/fixtures/<family>/<name>.json`, read IN
/// PLACE (plan §6: "Fixtures are read in place"). Nothing under
/// `foray-engine-core` is a copy of a fixture; `shell-invariants.test.mjs`
/// fails on any `.json` there.
public struct FixtureFile {
    /// Repo-relative POSIX path, as `manifest.json` spells it.
    public let path: String
    public let family: String
    /// The JS module every read/call case in the file targets.
    public let module: String?
    public let cases: [FixtureCase]
    /// The schema's `jsOnly` (plan §5.5 C-2): the file pins a JS rule that is
    /// deliberately never ported (the continuation hops, which the page
    /// computes and the engine only walks). The suite skips such a family by
    /// this flag, because no Swift card can owe its ids and record.mjs refuses
    /// to write them into swift-pending.json.
    public let jsOnly: Bool

    public init(path: String, family: String, module: String?, cases: [FixtureCase], jsOnly: Bool = false) {
        self.path = path
        self.family = family
        self.module = module
        self.cases = cases
        self.jsOnly = jsOnly
    }

    init(path: String, document: JSONValue) throws {
        guard let family = document["family"]?.stringValue else {
            throw HarnessError("E_BAD_CASE", "\(path) has no family")
        }
        guard let rawCases = document["cases"]?.arrayValue else {
            throw HarnessError("E_BAD_CASE", "\(path) has no cases")
        }
        self.init(path: path, family: family, module: document["module"]?.stringValue,
                  cases: try rawCases.map { try FixtureCase(raw: $0, file: path) },
                  jsOnly: document["jsOnly"] == .bool(true))
    }
}

/// One case, kept as the JSON it is plus typed accessors, so a schema field
/// this library does not know yet is carried rather than lost.
public struct FixtureCase {
    public enum Kind: String { case read, call, scenario }

    public let id: String
    public let fields: [String: JSONValue]

    public init(id: String, fields: [String: JSONValue]) {
        self.id = id
        self.fields = fields
    }

    init(raw: JSONValue, file: String) throws {
        guard let fields = raw.objectValue, let id = fields["id"]?.stringValue else {
            throw HarnessError("E_BAD_CASE", "\(file) has a case with no id")
        }
        self.init(id: id, fields: fields)
    }

    /// runner.js `caseKind`: exactly one of read / call / steps.
    public var kind: Kind? {
        let shapes: [(key: String, kind: Kind)] = [("read", .read), ("call", .call), ("steps", .scenario)]
        let present = shapes.filter { fields[$0.key] != nil }
        return present.count == 1 ? present[0].kind : nil
    }

    public var read: String? { fields["read"]?.stringValue }
    public var call: String? { fields["call"]?.stringValue }
    public var args: [JSONValue] { fields["args"]?.arrayValue ?? [] }
    public var expect: JSONValue? { fields["expect"] }
    public var tolerance: Double? { fields["tolerance"]?.numberValue }
    public var authored: Bool { fields["authored"] == .bool(true) }

    /// A copy with a different `expect`: how a test proves a wrong expectation
    /// is caught without touching a fixture on disk.
    public func with(expect: JSONValue) -> FixtureCase {
        var copy = fields
        copy["expect"] = expect
        return FixtureCase(id: id, fields: copy)
    }
}

/// Everything one parity run reads: the families (manifest.json), what each
/// fixture file holds, what is owed (swift-pending.json), and the floors.
///
/// Held as plain data so a test can change ONE thing (move an id into
/// pending, raise a floor, corrupt an expect) and prove the runner notices,
/// without writing to the tree.
public struct ParityData {
    /// family -> ordered case ids, from manifest.json.
    public var manifest: [String: [String]]
    /// family -> the files manifest.json lists for it, as read.
    public var fixtures: [String: [FixtureFile]]
    /// case id -> the card that owes it, from swift-pending.json.
    public var pending: [String: String]
    /// family -> minimum case count, from floors.json.
    public var floors: [String: Int]
    /// The repo root, for `$foray` (which reads data/forays.json).
    public var repoRoot: URL?

    public init(manifest: [String: [String]], fixtures: [String: [FixtureFile]], pending: [String: String],
                floors: [String: Int], repoRoot: URL?) {
        self.manifest = manifest
        self.fixtures = fixtures
        self.pending = pending
        self.floors = floors
        self.repoRoot = repoRoot
    }

    /// Read `player/parity/` (`parityDir`) in place.
    public static func load(parityDir: URL) throws -> ParityData {
        let repoRoot = parityDir.deletingLastPathComponent().deletingLastPathComponent()
        func read(_ name: String) throws -> JSONValue {
            let url = parityDir.appendingPathComponent(name)
            do {
                return try JSONValue.parse(try Data(contentsOf: url))
            } catch {
                throw HarnessError("E_BAD_CASE", "cannot read \(url.path): \(error)")
            }
        }
        let manifestDoc = try read("manifest.json")
        guard let families = manifestDoc["families"]?.objectValue else {
            throw HarnessError("E_BAD_CASE", "manifest.json has no families")
        }
        var manifest: [String: [String]] = [:]
        var fixtures: [String: [FixtureFile]] = [:]
        for (family, entry) in families {
            manifest[family] = (entry["ids"]?.arrayValue ?? []).compactMap(\.stringValue)
            let files = (entry["files"]?.objectValue ?? [:]).keys.sorted()
            fixtures[family] = try files.map { rel -> FixtureFile in
                let url = repoRoot.appendingPathComponent(rel)
                let doc: JSONValue
                do {
                    doc = try JSONValue.parse(try Data(contentsOf: url))
                } catch {
                    throw HarnessError("E_BAD_CASE", "manifest.json lists \(rel), which cannot be read: \(error)")
                }
                return try FixtureFile(path: rel, document: doc)
            }
        }
        var pending: [String: String] = [:]
        for (id, card) in try read("swift-pending.json").objectValue ?? [:] where !id.hasPrefix("//") {
            pending[id] = card.stringValue ?? ""
        }
        var floors: [String: Int] = [:]
        for (family, n) in try read("floors.json")["families"]?.objectValue ?? [:] {
            if let count = n.numberValue { floors[family] = Int(count) }
        }
        return ParityData(manifest: manifest, fixtures: fixtures, pending: pending, floors: floors, repoRoot: repoRoot)
    }
}

/// Where `player/parity/` is.
///
/// 1. `FORAY_PARITY_DIR`, when set: the directory itself, or its `fixtures/`
///    child (the plan names both; either is accepted). A variable that is set
///    but wrong is an ERROR, never a quiet fall-through to the walk: CI sets it
///    precisely so it cannot silently read some other tree.
/// 2. Otherwise walk up from `#filePath` (a source file of whoever asked) to
///    the first ancestor holding `player/parity/manifest.json`. Every place the
///    library runs today builds from a checkout, and a Simulator test process
///    reads the host's filesystem, so the walk finds the tree the run was
///    built from, which is the tree whose fixtures it must obey.
public enum ParityLocator {
    public static let environmentKey = "FORAY_PARITY_DIR"

    public static func locate(environment: [String: String] = ProcessInfo.processInfo.environment,
                              filePath: String = #filePath) throws -> URL {
        let fm = FileManager.default
        if let configured = environment[environmentKey], !configured.isEmpty {
            let dir = URL(fileURLWithPath: configured)
            if fm.fileExists(atPath: dir.appendingPathComponent("manifest.json").path) { return dir }
            let parent = dir.deletingLastPathComponent()
            if dir.lastPathComponent == "fixtures",
               fm.fileExists(atPath: parent.appendingPathComponent("manifest.json").path) {
                return parent
            }
            throw HarnessError("E_BAD_CASE", "\(environmentKey)=\(configured) holds no manifest.json (nor does its parent)")
        }
        // Bounded, and stopped at the root by path: `deletingLastPathComponent`
        // on "/" is not guaranteed to be a fixed point on every Foundation.
        var dir = URL(fileURLWithPath: filePath).deletingLastPathComponent().standardizedFileURL
        for _ in 0..<64 {
            let candidate = dir.appendingPathComponent("player").appendingPathComponent("parity")
            if fm.fileExists(atPath: candidate.appendingPathComponent("manifest.json").path) { return candidate }
            if dir.path == "/" || dir.path.isEmpty { break }
            let parent = dir.deletingLastPathComponent().standardizedFileURL
            if parent.path == dir.path { break }
            dir = parent
        }
        throw HarnessError("E_BAD_CASE", "no player/parity/manifest.json above \(filePath), and \(environmentKey) is not set")
    }
}
