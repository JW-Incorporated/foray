import Foundation
import ForayEngineCore

/// The Foray tape (card NE-30s), from the scenarios NE-30j recorded:
///
///   - `manager-foray`: queue-manager's Foray tape (tape.json: in-points and
///     out-points, the out-point as the item's end, back-to-back slices, speed
///     across seams, ADR-0007's ladder at load, the dropped-items report, the
///     seam beat under every transport action on fast and slow loads) and
///     foray-playback's playback half over the REAL frozen Forays
///     (real-forays.json), driven through `EngineCore` with the Foray tape on;
///   - `prepare`: seams at the AUDIBLE level ("item N+1 audible at T with
///     offset O"), through the engine CONTRACT with the standby deck, the
///     `n.prepare:` / `n.handover:` tokens asserted.
///
/// A Foray a scenario plays is the PAGE's build (`buildForayQueue`), read from
/// player/parity/scenario-builds.json: the engine never builds one (plan §3
/// A-1), so what the core is handed here is exactly what `playForay` carries.
public enum ManagerForayFamily {
    public static let runner = makeRunner()

    public static func makeRunner(mutation: EngineScenarioDriver.Mutation? = nil) -> FamilyRunner {
        ForayTapeRunner(family: "manager-foray", target: "manager",
                        driver: EngineScenarioDriver(mutation: mutation, forayTape: true))
    }
}

public enum PrepareFamily {
    public static let runner = makeRunner()

    public static func makeRunner(mutation: EngineScenarioDriver.Mutation? = nil) -> FamilyRunner {
        ForayTapeRunner(family: "prepare", target: "engine",
                        driver: EngineScenarioDriver(mutation: mutation, forayTape: true))
    }
}

/// Scenarios only, of one target: a fixture file that names a module, or a
/// case aimed at another target, is refused rather than run.
struct ForayTapeRunner: FamilyRunner {
    let family: String
    let target: String
    let driver: EngineScenarioDriver

    func run(_ testCase: FixtureCase, in file: FixtureFile, context: Codec.Context) throws -> JSONValue {
        guard testCase.kind == .scenario else {
            throw HarnessError("E_BAD_CASE", "the \(family) family is scenarios only; \(testCase.id) is not one")
        }
        let setupTarget = testCase.fields["setup"]?.objectValue?["target"]?.stringValue
        guard setupTarget == target else {
            throw HarnessError("E_SCENARIO_TARGET", "the Swift \(family) family drives the \(target) target, not \(setupTarget ?? "none")")
        }
        return try driver.run(testCase, context: context).encoded
    }
}
