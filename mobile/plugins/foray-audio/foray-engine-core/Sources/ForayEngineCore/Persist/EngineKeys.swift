import Foundation

/* Where the engine keeps what it stores (docs/native-engine-plan.md §4.6,
 * card NE-19): the three SHARED rows under `CapacitorStorage.` that the page
 * reads too, and everything else OUTSIDE that prefix.
 *
 * WHY THE SPLIT IS A SAFETY PROPERTY AND NOT TIDINESS. DurableStore (NE-23)
 * sees every `CapacitorStorage.` key: it hydrates them, mirrors them into
 * localStorage and IDB, and orders two copies of a row by `updated_at`. A
 * strike counter or a sentinel under that prefix would be read by the page as
 * a row, mirrored into two more tiers, and could be written back over the
 * engine's own copy by a stale page. So the engine-only state lives under
 * `ForayEngine.` in the same `UserDefaults`, which the Preferences plugin
 * never enumerates, and the page reaches it only through `engineRead` /
 * `engineSend` (§4.6).
 *
 * The names are §4.6's list, verbatim; `test/data-deletion.test.js` purges the
 * same six names and `tools/mobile/shell-invariants.test.mjs` holds the two
 * lists equal, because NE-27's privacy text will enumerate them and a key that
 * is written but not listed is a key a deletion forgets. */

/// One engine-private `UserDefaults` key.
public enum EnginePrivateKey: String, CaseIterable, Sendable {
    /// The Developer engine setting (`engineSend setModeOverride`, NE-17).
    case modeOverride = "ForayEngine.modeOverride"
    /// The crash-loop guard's strike count (NE-17).
    case strikes = "ForayEngine.strikes"
    /// `<launchId>` written before a native boot, cleared by the healthy marker.
    case sentinel = "ForayEngine.sentinel"
    /// The CFBundleVersion three strikes pinned to legacy.
    case stickyLegacyBuild = "ForayEngine.stickyLegacyBuild"
    /// The cold path's restore record (`RestoreRecord`, NE-24).
    case restore = "ForayEngine.restore"
    /// `pauseHoldPolicy` (`forever`, `none`, `until:<m>`, NE-16).
    case holdPolicy = "ForayEngine.holdPolicy"
}

public enum EngineKeys {
    /// Every private key starts with this. A purge removes EVERY key under it,
    /// not just today's six, so a key a later card adds and forgets to list is
    /// still deleted by "Delete my data".
    public static let privatePrefix = "ForayEngine."

    /// The diagnostics ring: `Application Support/foray-engine/diag.jsonl`.
    /// A file, not a key: 2,000 rows would be a ~300 KB `UserDefaults` value
    /// rewritten on every row, and the plist is loaded whole at launch.
    public static let diagDirectoryName = "foray-engine"
    public static let diagFileName = "diag.jsonl"

    /// The raw `UserDefaults` key of an engine-private value.
    public static func isPrivate(rawKey: String) -> Bool {
        rawKey.hasPrefix(privatePrefix)
    }

    /// The row key (`cp_pos:ep-1`) of a raw `UserDefaults` key that is one of
    /// the ENGINE'S shared rows, or nil: under `CapacitorStorage.` and inside
    /// `OWNED_PREFIXES` (`isOwnedRow`). Every other `CapacitorStorage.` key is the page's
    /// (`cp_rate`, `cp_engine_applied`, ...) and the engine never writes or
    /// deletes it.
    public static func sharedRowKey(rawKey: String) -> String? {
        let prefix = SharedRowStore.preferencesKeyPrefix
        guard rawKey.hasPrefix(prefix) else { return nil }
        let rowKey = String(rawKey.dropFirst(prefix.count))
        return isOwnedRow(rowKey) ? rowKey : nil
    }

    /// A row key the engine owns on iOS (`cp_pos:*`, `cp_foray:*`,
    /// `cp_last_episode`): durable-store.js's `_owner.prefixes.some((p) =>
    /// key.startsWith(p))`, exactly. A stricter rule here (say, `cp_last_episode`
    /// as a whole key only) would leave a key the page REFUSES to write because
    /// the engine owns it, and the engine refuses to write because it does not:
    /// nobody could ever store it.
    public static func isOwnedRow(_ rowKey: String) -> Bool {
        Rows.ownedPrefixes.contains { rowKey.hasPrefix($0) }
    }
}
