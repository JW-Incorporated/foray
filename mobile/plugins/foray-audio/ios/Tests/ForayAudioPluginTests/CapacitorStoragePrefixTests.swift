import XCTest
import ForayEngineCore
#if canImport(PreferencesPlugin)
import PreferencesPlugin
#endif

/// Pins the `CapacitorStorage.` prefix against the REAL `@capacitor/preferences`
/// native class (docs/native-engine-plan.md, card NE-01).
///
/// WHY. The page writes its shared rows (`cp_pos:*`, `cp_foray:*`,
/// `cp_last_episode`) through the Preferences plugin, which stores each under
/// `<group>.` + key in `UserDefaults.standard`. The native engine will read and
/// write the same rows directly (§4.6: "both engines write them identically"),
/// using `SharedRowStore.preferencesKeyPrefix`. If a Capacitor upgrade changed
/// the prefix, the two engines would fork a listener's positions in silence:
/// each would read its own copy and neither would ever be wrong on its own.
///
/// HOW THE MODULE GETS HERE. `@capacitor/preferences` has no SwiftPM URL, so
/// `../../Package.swift` adds it from `mobile/node_modules` ONLY when
/// `FORAY_PREFERENCES_PIN=1` (ci.yml's ios-kit step, after `npm ci` in
/// `mobile/`), which keeps it out of the app's package graph. That step also
/// sets `TEST_RUNNER_FORAY_REQUIRE_PREFERENCES_PIN=1`, so if the variable
/// ever stops reaching the manifest this test FAILS instead of compiling out.
final class CapacitorStoragePrefixTests: XCTestCase {
    func testAPreferencesWriteLandsUnderTheSharedRowPrefixAndARawWriteReadsBack() throws {
        #if canImport(PreferencesPlugin)
        let key = "cp_ne01_prefix_probe_" + UUID().uuidString
        let raw = SharedRowStore.userDefaultsKey(for: key)
        let preferences = Preferences(with: PreferencesConfiguration())
        defer {
            UserDefaults.standard.removeObject(forKey: raw)
            preferences.remove(by: key)
        }

        /* Page -> engine: what the page writes, the engine finds at the raw key.
           TO SEE IT FAIL: change `preferencesKeyPrefix` in the core. */
        preferences.set("written-through-preferences", for: key)
        XCTAssertEqual(UserDefaults.standard.string(forKey: raw), "written-through-preferences")
        /* The literal as well, so a change to BOTH the constant and the plugin's
           default is still a change somebody has to make on purpose here. */
        XCTAssertEqual(SharedRowStore.preferencesKeyPrefix, "CapacitorStorage.")

        /* Engine -> page: a row the engine writes raw is the row the page reads. */
        UserDefaults.standard.set("written-raw", forKey: raw)
        XCTAssertEqual(preferences.get(by: key), "written-raw")
        #else
        if ProcessInfo.processInfo.environment["FORAY_REQUIRE_PREFERENCES_PIN"] == "1" {
            XCTFail("FORAY_REQUIRE_PREFERENCES_PIN=1 reached the test runner but the "
                + "PreferencesPlugin module did not reach this target: FORAY_PREFERENCES_PIN "
                + "is no longer reaching Package.swift, or mobile/node_modules is missing.")
        } else {
            throw XCTSkip("PreferencesPlugin is linked only under FORAY_PREFERENCES_PIN=1 (ci.yml ios-kit).")
        }
        #endif
    }
}
