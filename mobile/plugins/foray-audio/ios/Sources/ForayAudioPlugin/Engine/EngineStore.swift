import Foundation
import ForayEngineCore

/// Where everything the engine keeps is kept (card NE-19; docs/native-engine-plan.md
/// §4.6), and the real `EngineOutput` the host hands its persistence and
/// reporting commands to.
///
/// ── TWO KINDS OF STATE, TWO PLACES ────────────────────────────────────────
///
///   SHARED ROWS  `cp_pos:*`, `cp_foray:*`, `cp_last_episode`, under
///                `CapacitorStorage.` in `UserDefaults.standard`: the exact
///                keys `@capacitor/preferences` stores the page's rows under,
///                holding the exact `JSWriter` strings the page's own writers
///                produce (`Rows`, NE-10s). So a position the engine wrote is
///                a position the page reads, byte for byte, when the listener
///                switches engines (§4.6 "positions survive switching
///                engines"). The engine writes NO other `CapacitorStorage.`
///                key: `writeShared` refuses one outside OWNED_PREFIXES.
///   PRIVATE      `ForayEngine.*` (`EnginePrivateKey`): the restore record,
///                strikes, sentinel, override, sticky build and hold policy.
///                Outside the prefix, so DurableStore never hydrates, mirrors
///                or clobbers them (NE-23), plus the diagnostics ring, which
///                is a file (`EngineDiagnostics`).
///
/// ── SYNCHRONOUS ───────────────────────────────────────────────────────────
///
/// Every write lands in `UserDefaults` before the call returns: no queue, no
/// debounce, no write-behind. The moments a position matters most are
/// `didEnterBackground` and `willTerminate` (the core flushes the playhead on
/// both, client.js `flushPositions`), and a write deferred past the handler
/// that asked for it is a write a suspension or a kill can lose, which is the
/// founder's #689 "it jumped back several minutes". `flush()` then asks
/// `UserDefaults` to persist its in-memory copy at those same two moments.
///
/// Main-confined like the host that drives it.
final class EngineStore: EngineOutput {
    let defaults: UserDefaults
    let diagnostics: EngineDiagnostics

    /// Events for the page (NE-20's bridge sets these). Until then they are
    /// dropped here, which is safe: the pending events and walked hops also
    /// ride in the restore record, which the page drains on attach (§5.5).
    var onEmit: ((EngineEvent) -> Void)?
    var onPendingEvent: ((PendingEvent) -> Void)?
    /// A ring row of a kind the page hears live (`EngineBridgeRules
    /// .liveDiagKinds`: faults), AFTER the gate and the file took it. Set by
    /// NE-20's bridge; the row is the ring's own, so the live copy and the
    /// Copy paste are the same bytes.
    var onLiveRow: ((DiagRow) -> Void)?

    init(defaults: UserDefaults = .standard, diagnostics: EngineDiagnostics) {
        self.defaults = defaults
        self.diagnostics = diagnostics
    }

    // MARK: - Shared rows

    /// Store one shared row verbatim. Refuses (with a `fault` row, never a
    /// throw) a key the engine does not own: writing the page's `cp_rate`
    /// would be the engine doing the page's job with the page's bytes.
    @discardableResult
    func writeShared(_ row: StoredRow) -> Bool {
        guard EngineKeys.isOwnedRow(row.key) else {
            diagnostics.record(DiagEntry(kind: "fault", fields: [
                JSONMember("kind", .string("not-owned")),
                JSONMember("key", .string(row.key))
            ]))
            return false
        }
        defaults.set(row.value, forKey: SharedRowStore.userDefaultsKey(for: row.key))
        return true
    }

    /// The row the page would read for `rowKey`, as stored.
    func readShared(_ rowKey: String) -> String? {
        defaults.string(forKey: SharedRowStore.userDefaultsKey(for: rowKey))
    }

    /// Every shared engine row under the given row-key prefixes (all of
    /// OWNED_PREFIXES by default): `engineRead("rows", prefixes)`, whose
    /// answer the page adopts as its whole set for those prefixes (NE-23).
    func sharedRows(prefixes: [String] = Rows.ownedPrefixes) -> [String: String] {
        var rows: [String: String] = [:]
        for (rawKey, value) in defaults.dictionaryRepresentation() {
            guard let rowKey = EngineKeys.sharedRowKey(rawKey: rawKey),
                  prefixes.contains(where: { rowKey.hasPrefix($0) }),
                  let text = value as? String else { continue }
            rows[rowKey] = text
        }
        return rows
    }

    // MARK: - Private keys

    func string(_ key: EnginePrivateKey) -> String? {
        defaults.string(forKey: key.rawValue)
    }

    func set(_ value: String?, for key: EnginePrivateKey) {
        if let value {
            defaults.set(value, forKey: key.rawValue)
        } else {
            defaults.removeObject(forKey: key.rawValue)
        }
    }

    /// The cold path's record (NE-24), or nil for none or one this build
    /// cannot trust (`RestoreRecord.parse`).
    func restoreRecord() -> RestoreRecord? {
        RestoreRecord.parse(string(.restore))
    }

    // MARK: - Lifecycle and deletion

    /// Persist `UserDefaults`' in-memory copy now: at `didEnterBackground`
    /// and `willTerminate`, after the core's flush has written the playhead.
    /// Apple calls this unnecessary in general, and it is cheap; it is the
    /// belt to the synchronous writes' braces at the two moments a process
    /// is most likely to stop running.
    func flush() {
        defaults.synchronize()
    }

    /// Everything the engine ever stored, gone (data deletion, `engineSend
    /// purge`, NE-23's Delete-my-data order): every shared engine row, EVERY
    /// `ForayEngine.*` key (not only today's six, so a key a later card adds
    /// is not forgotten) and the ring file. The page's own `CapacitorStorage.`
    /// rows (`cp_rate`, `cp_engine_applied`, ...) are the page's to clear.
    /// Returns what it removed, so the caller and the tests can enumerate it.
    @discardableResult
    func purge() -> [String] {
        var removed: [String] = []
        for rawKey in defaults.dictionaryRepresentation().keys.sorted()
        where EngineKeys.sharedRowKey(rawKey: rawKey) != nil || EngineKeys.isPrivate(rawKey: rawKey) {
            defaults.removeObject(forKey: rawKey)
            removed.append(rawKey)
        }
        let ringPath = diagnostics.fileURL.path
        let hadRing = FileManager.default.fileExists(atPath: ringPath)
        do {
            try diagnostics.purge()
            if hadRing { removed.append(ringPath) }
        } catch {
            // The file could not be removed; say so in the (now empty) ring
            // rather than report a deletion that did not happen.
            diagnostics.record(DiagEntry(kind: "fault", fields: [JSONMember("kind", .string("purge-failed"))]))
        }
        defaults.synchronize()
        return removed
    }

    // MARK: - EngineOutput

    func writePosition(_ write: PositionWrite) {
        writeShared(write.row)
    }

    func writeRow(_ row: StoredRow) {
        writeShared(row)
    }

    func writeRestore(_ record: RestoreRecord?) {
        set(record?.serialized(), for: .restore)
    }

    func appendEvent(_ event: PendingEvent) {
        onPendingEvent?(event)
    }

    func emit(_ event: EngineEvent) {
        onEmit?(event)
    }

    func diag(_ entry: DiagEntry) {
        if let row = diagnostics.record(entry), EngineBridgeRules.liveDiagKinds.contains(row.kind) {
            onLiveRow?(row)
        }
    }

    // `flush()` above is the protocol's too: the host calls it right after the
    // core has handled `didEnterBackground` / `willTerminate`.
}
