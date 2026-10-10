import Foundation
import ForayEngineCore

/// `native-episode` (code-health-3 CH3-20; R3-03, R3-04, R3-08): the episode
/// path at the steering wheel, through `EngineCore` with the Foray tape off,
/// on the manager target (the one this driver logs the native tokens on).
///
/// WHAT NO OTHER FAMILY CAN SAY. Every other episode family compares the deck's
/// and the store's ops only: compare.js strips the `n.*` tokens, so the session,
/// grace, the stop cause (`n.diag:stop:<cause>`), `n.failed:` and the restore
/// record were invisible to parity, and no fixture could press the command a
/// one-button headset or an AVRCP head unit sends (`togglePlayPause`), feed the
/// deck's load deadline, expire grace or relinquish. This family keeps the
/// tokens (`Comparator.nativeTokenFamilies`) and drives those inputs
/// (`EngineScenarioDriver`'s raw `remote`, `deck: "deadline"`, `lifecycle:
/// "graceExpired"` and `"relinquish"`).
///
/// ITS EXPECTS ARE THIS CORE'S. The family is `nativeOnly` (the schema): the
/// JS reference has none of those inputs, so record.mjs never records it; each
/// case is authored from what this core does, and the JVM ParitySuite runs the
/// same cases (`JvmFamilies.NATIVE_EPISODE`), so a one-platform edit to remote
/// handling, a stop row's order or the grace span goes red on the other.
public enum NativeEpisodeFamily {
    public static let runner = makeRunner()

    public static func makeRunner(mutation: EngineScenarioDriver.Mutation? = nil) -> FamilyRunner {
        NativeEpisodeRunner(driver: EngineScenarioDriver(mutation: mutation))
    }
}

struct NativeEpisodeRunner: FamilyRunner {
    let family = "native-episode"
    let driver: EngineScenarioDriver

    func run(_ testCase: FixtureCase, in file: FixtureFile, context: Codec.Context) throws -> JSONValue {
        guard testCase.kind == .scenario else {
            throw HarnessError("E_BAD_CASE", "native-episode holds scenarios only, got \(testCase.id)")
        }
        return try driver.run(testCase, context: context).encoded
    }
}
