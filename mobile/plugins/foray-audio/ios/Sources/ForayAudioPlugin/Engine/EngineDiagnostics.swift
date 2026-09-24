import Foundation
import os
import ForayEngineCore

/// The engine's diagnostics (card NE-19; docs/native-engine-plan.md §4.1, §10):
/// the durable ring the page's Copy merges (NE-26) and `engine-report.mjs`
/// turns into DV verdicts (NE-26r), mirrored line for line into the unified
/// log.
///
/// Everything a row may contain is decided in the core (`DiagGate`), and the
/// file ring itself is the core's `DiagRing`, so both run in the host
/// `swift test`. What lives here is only what the core cannot hold: where the
/// file goes on a phone, and `os.Logger`.
///
/// ── THE UNIFIED-LOG MIRROR ─────────────────────────────────────────────────
///
/// Subsystem `ai.jwlabs.foura`, category `engine`: the app's bundle id, so
/// `log stream --predicate 'subsystem == "ai.jwlabs.foura"'` on a tethered
/// phone or a Simulator shows the engine's rows as they happen, and a
/// sysdiagnose from the car carries them even when the app never reopened to
/// press Copy. Unified-log interpolations are PRIVATE by default and read
/// `<private>` off a debugger; the line is marked `.public`, which is safe
/// ONLY because `DiagGate.loggerText` builds it from admitted tokens and
/// leaves the Now Playing text out. `tools/mobile/shell-invariants.test.mjs`
/// pins that the one `.public` interpolation is that function's output.
final class EngineDiagnostics {
    static let subsystem = "ai.jwlabs.foura"
    static let category = "engine"

    private let logger = Logger(subsystem: "ai.jwlabs.foura", category: "engine")
    let ring: DiagRing
    private let clock: () -> (wallMs: Double, monoMs: Double)

    /// `directory` is `defaultDirectory()` in the app; a test passes a
    /// temporary one. `clock` is the engine's (`EngineTiming`): wall time for
    /// Copy's merge, monotonic time for durations.
    init(directory: URL, capacity: Int = DiagRing.capacity, slack: Int = DiagRing.slack,
         clock: @escaping () -> (wallMs: Double, monoMs: Double)) {
        ring = DiagRing(fileURL: directory.appendingPathComponent(EngineKeys.diagFileName),
                        capacity: capacity, slack: slack)
        self.clock = clock
        excludeFromBackup(directory)
    }

    convenience init(timing: EngineTiming, directory: URL = EngineDiagnostics.defaultDirectory()) {
        self.init(directory: directory, clock: { (wallMs: timing.wallMs, monoMs: timing.monoMs) })
    }

    /// `Application Support/foray-engine/`: not Documents (the Files app shows
    /// Documents), not Caches (iOS purges Caches under storage pressure, and a
    /// drive's rows must survive until Copy).
    static func defaultDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent(EngineKeys.diagDirectoryName, isDirectory: true)
    }

    var fileURL: URL { ring.fileURL }

    /// The ring's rows, oldest first: `engineRead("diagnostics")` (NE-20).
    var rows: [DiagRow] { ring.rows }

    /// One row: gated, stamped, appended to the file before this returns, and
    /// mirrored to the unified log. Nil when the gate refused it whole.
    @discardableResult
    func record(_ entry: DiagEntry) -> DiagRow? {
        let now = clock()
        let row = ring.append(entry, wallMs: now.wallMs, monoMs: now.monoMs)
        // A refused row is still a row (`diag event=row-refused`): mirror the
        // ring's newest, whichever it was.
        if let written = ring.rows.last { mirror(written) }
        return row
    }

    /// ONE packed row per seam (plan §13 item 37): never one per load stage.
    @discardableResult
    func seam(_ seam: SeamRow) -> DiagRow? {
        record(seam.entry)
    }

    /// The `build` row, first thing after a boot.
    @discardableResult
    func build(_ build: BuildRow) -> DiagRow? {
        record(build.entry)
    }

    /// Delete the ring (data deletion).
    func purge() throws {
        try ring.purge()
    }

    private func mirror(_ row: DiagRow) {
        let text = DiagGate.loggerText(row)
        logger.log("\(text, privacy: .public)")
    }

    /// The ring is a record of how playback behaved on THIS phone; a restore
    /// onto another device would merge two phones' drives into one paste.
    /// Best effort: a failure leaves the file in the backup, nothing worse.
    private func excludeFromBackup(_ directory: URL) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var url = directory
        try? url.setResourceValues(values)
    }
}
