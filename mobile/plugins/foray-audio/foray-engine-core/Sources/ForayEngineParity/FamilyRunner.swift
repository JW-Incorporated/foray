import Foundation

/// Runs the cases of ONE fixture family against its Swift port (plan §6.4).
///
/// One conformer per family, registered in `ParityFamilies.all`. A family
/// with no conformer is not an error in itself: its cases must then all be in
/// `swift-pending.json` (owed by the card that ports it), and the suite fails
/// on any that are not. So a JS card that records a new family never turns
/// Swift red, and a Swift card that forgets to register its runner does not
/// go quietly green either: its burned-down ids become "neither executed nor
/// pending".
public protocol FamilyRunner {
    /// The fixture family (the directory name under `player/parity/fixtures`).
    var family: String { get }

    /// Run one case and return the ENCODED actual, the same shape as the
    /// case's `expect` (`{value}`, `{return}`, `{throws: {name}}`, or
    /// `{checkpoints, ops}`). Throw `HarnessError` when the case cannot run.
    func run(_ testCase: FixtureCase, in file: FixtureFile, context: Codec.Context) throws -> JSONValue
}

/// What a ported function did: returned a value, or threw a JavaScript error
/// of a class the schema's closed `thrown.name` set names.
public enum CallOutcome {
    case returned(JSValue)
    case threw(String)
}

/// A family whose cases are `read`s of constants and `call`s of pure
/// functions of ONE JS module: the shape of every policy family (seam-gap,
/// interlude, seek-policy, rate, ...). The tables map the JS export names the
/// fixture uses to the Swift port; the runner does the decoding, the
/// dispatch and the encoding, which runner.js `runCase` does for JS.
public struct PureFamilyRunner: FamilyRunner {
    public let family: String
    /// The JS module the fixture file must name. A fixture that moves to
    /// another module is refused, not run: its cases would then pin a rule
    /// this port was never checked against (runner.js reads the module from
    /// the FILE for the same reason).
    public let module: String
    public let reads: [String: JSValue]
    public let calls: [String: ([JSValue]) throws -> CallOutcome]

    public init(family: String, module: String, reads: [String: JSValue],
                calls: [String: ([JSValue]) throws -> CallOutcome]) {
        self.family = family
        self.module = module
        self.reads = reads
        self.calls = calls
    }

    public func run(_ testCase: FixtureCase, in file: FixtureFile, context: Codec.Context) throws -> JSONValue {
        guard file.module == module else {
            throw HarnessError("E_BAD_CASE", "\(file.path) targets \(file.module ?? "no module"); the Swift \(family) runner ports \(module)")
        }
        switch testCase.kind {
        case .read?:
            let name = testCase.read ?? ""
            guard let value = reads[name] else {
                throw HarnessError("E_UNKNOWN_EXPORT", "\(module) has no Swift port of export \"\(name)\"")
            }
            return .object(["value": Codec.encode(value)])
        case .call?:
            let name = testCase.call ?? ""
            guard let function = calls[name] else {
                throw HarnessError("E_UNKNOWN_EXPORT", "\(module) has no Swift port of export \"\(name)\"")
            }
            let args = try testCase.args.map { try Codec.expandInputs($0, context) }
            switch try function(args) {
            case let .returned(value): return .object(["return": Codec.encode(value)])
            case let .threw(name): return .object(["throws": .object(["name": .string(name)])])
            }
        case .scenario?:
            throw HarnessError("E_SCENARIO_TARGET", "the \(family) family has no Swift scenario driver")
        case nil:
            throw HarnessError("E_BAD_CASE", "case \(testCase.id) is not exactly one of read / call / steps")
        }
    }
}

/// A family whose fixture files target more than one JS module (NE-09's
/// `resume-rules`: position-store.js, queue-manager.js and foray-progress.js,
/// because a fixture file names ONE module and the rules live in three). Each
/// file is run by the part that ports its module; a file naming any other
/// module is refused, for the reason `PureFamilyRunner` refuses one.
public struct MultiModuleFamilyRunner: FamilyRunner {
    public let family: String
    public let parts: [PureFamilyRunner]

    public init(family: String, parts: [PureFamilyRunner]) {
        self.family = family
        self.parts = parts
    }

    public func run(_ testCase: FixtureCase, in file: FixtureFile, context: Codec.Context) throws -> JSONValue {
        guard let part = parts.first(where: { $0.module == file.module }) else {
            throw HarnessError("E_BAD_CASE", "\(file.path) targets \(file.module ?? "no module"); the Swift \(family) runner ports "
                + parts.map(\.module).joined(separator: ", "))
        }
        return try part.run(testCase, in: file, context: context)
    }
}

/// The registry: every family Swift can run today. A new port adds its
/// runner here and deletes its ids from `swift-pending.json` in the same PR.
public enum ParityFamilies {
    public static var all: [FamilyRunner] {
        [CompareFamily.runner, SeamGapFamily.runner, QueueStateFamily.runner, RateFamily.runner, ResumeRulesFamily.runner, TransportFamily.runner]
    }
}
