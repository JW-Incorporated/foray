import Foundation
import ForayEngineCore

/// The real `HoldPolicyStoring` (card NE-16; docs/native-engine-plan.md §4.4,
/// §4.6): `pauseHoldPolicy` in the engine-private key `ForayEngine.holdPolicy`.
///
/// ONE STRING, the policy's own spelling (`forever`, `none`, `until:<m>`), so
/// the stored value, the Developer row, the `build` row and the Copy header's
/// `hold=` all read the same, and a value this build cannot parse (a later
/// build's policy, a hand edit) is IGNORED rather than guessed at: the
/// default `.forever` meets S-4 as written.
///
/// Written synchronously on main, like `ForayEngine.modeOverride` (NE-17): a
/// Developer toggle followed by a force-quit must not lose the setting to a
/// write-behind.
final class HoldPolicyStore: HoldPolicyStoring {
    /// Outside `CapacitorStorage.` on purpose: the page reaches it only
    /// through `engineSend setHoldPolicy` and the snapshot's `holdPolicy`.
    static let key = "ForayEngine.holdPolicy"

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func load() -> SessionPolicy.HoldPolicy? {
        defaults.string(forKey: Self.key).flatMap(SessionPolicy.HoldPolicy.init)
    }

    func save(_ policy: SessionPolicy.HoldPolicy) {
        defaults.set(policy.text, forKey: Self.key)
    }
}
