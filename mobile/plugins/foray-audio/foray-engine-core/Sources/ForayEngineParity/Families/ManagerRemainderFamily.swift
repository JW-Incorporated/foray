import Foundation
import ForayEngineCore

/// `manager-remainder` (card NE-39s; NE-39j recorded it from the real
/// `PlayerQueueManager`): the last of queue-manager's rules, driven through
/// `EngineCore` with the Foray tape on, as `manager-foray` is.
///
///   - warming.json: the warming rules (queue-manager.js §11 as NE-45j
///     rewrote them): the window names the item its boundary advances to, at
///     that item's in-point; a spoken line has no file to warm and the clip
///     after it is asked for at the line's start; the last item warms
///     nothing; a paused window warms nothing; and on the manual clock a
///     warmed seam is the beat, an unwarmed one is the load, and a lost race
///     costs the load and never the segment. `prefetch:<id>@<s>` is the
///     core's `.prepare` (the ASK), not the standby deck's decision, which
///     the `prepare` families assert.
///   - transport.json: the rest (an unknown ref errors to idle, the rate
///     getter and its snap row, the position writer, stop's silence behind a
///     paused machine (player-core-7), and a play settling mid-skip-back
///     keeping the restart).
///
/// What the driver adds for these cases (backend prefetch, cold loads, the
/// slow first play, telemetry, the `positionTimer` view) is in
/// `EngineScenarioDriver`'s header. Two NE-39j cases pinned the JS manager's
/// awaits and are the jsOnly `manager-await` family instead; their native
/// forms are XCTests (ForayCatchUpTests, ForayEngineHostTests).
public enum ManagerRemainderFamily {
    public static let runner = makeRunner()

    public static func makeRunner(mutation: EngineScenarioDriver.Mutation? = nil) -> FamilyRunner {
        ForayTapeRunner(family: "manager-remainder", targets: ["manager"],
                        driver: EngineScenarioDriver(mutation: mutation, forayTape: true))
    }
}
