import Foundation

/// What the engine answers to `engineHello` (docs/native-engine-plan.md §5.1),
/// and the one fact about the page's storage the engine must share with it.
///
/// NE-01 IS A PACKAGING SPIKE, so this is deliberately the whole of the core
/// for now: one type that the plugin really calls, so the build proves that
/// `ForayAudioPlugin` links `ForayEngineCore` through the nested path
/// dependency, and that the parity library can run a case against it. The
/// reducer (NE-02), the policies and `EngineCore` (NE-07s onward) arrive in
/// their own cards.
public enum EngineHandshake {
    /// Protocol v1 of the web <-> native contract (§5). Not sent by the stub
    /// below: a page that finds no `protocol` in the answer treats it as a
    /// mismatch and runs the JS player, which is exactly right for a build
    /// with no engine in it.
    public static let protocolVersion = 1

    /// The answer's `mode` while no engine is built: `legacy` is "the lane the
    /// app plays through today" (§4.6), not `js`, because on iOS the legacy
    /// lane is the JS player PLUS this plugin's Now Playing half, and the page
    /// must keep both.
    public static let notBuiltMode = "legacy"
    /// The answer's `reason`, from the closed vocabulary §4.6 logs on every
    /// `mode` row (`no-plist-key`, `crash-loop`, `downgrade`, ...).
    public static let notBuiltReason = "not-built"

    /// `{mode: "legacy", reason: "not-built"}`, the stub `engineHello`
    /// resolves with until NE-20 replaces it. A plain dictionary so the core
    /// stays free of Capacitor's `JSObject`: the plugin copies it across.
    public static func notBuiltHello() -> [String: String] {
        ["mode": notBuiltMode, "reason": notBuiltReason]
    }
}

/// Where `@capacitor/preferences` keeps the page's rows in `UserDefaults`.
///
/// WHY THE ENGINE NEEDS TO KNOW. The engine and the page must write the SAME
/// shared rows (`cp_pos:*`, `cp_foray:*`, `cp_last_episode`, §4.6) so a
/// position survives switching engines, and the page writes them through the
/// Preferences plugin, which prefixes every key with its group name and a dot.
/// The prefix is a fact about a dependency, not a decision of ours, so it is
/// pinned against the REAL plugin class by
/// `ForayAudioPluginTests/CapacitorStoragePrefixTests.swift` (a write through
/// `Preferences` read back from raw `UserDefaults`). A Capacitor upgrade that
/// changes it turns that test red instead of silently forking the rows.
///
/// It holds only while the page never calls Preferences' `configure` with a
/// group of its own; `shell-invariants.test.mjs` pins that too.
public enum SharedRowStore {
    public static let preferencesKeyPrefix = "CapacitorStorage."

    /// The raw `UserDefaults` key the page's `Preferences.set({key})` lands in.
    public static func userDefaultsKey(for rowKey: String) -> String {
        preferencesKeyPrefix + rowKey
    }
}
