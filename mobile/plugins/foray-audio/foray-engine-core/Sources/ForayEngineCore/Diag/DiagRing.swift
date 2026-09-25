import Foundation

/* The engine's diagnostics ring (docs/native-engine-plan.md §4.1, §13 item 37;
 * card NE-19): `Application Support/foray-engine/diag.jsonl`, one `DiagRow` per
 * line, the newest 2,000 kept.
 *
 * WHY A FILE, AND WHY 2,000. Revision 1 had a 200-row in-memory ring. A drive
 * is where the rows matter, and a drive is where iOS terminates a backgrounded
 * app: an in-memory ring dies with the process that saw the failure. And 200
 * rows is about forty seconds of a busy seam (diagnostic-log.js says the same
 * of the page's ring), so the first seam of a 51-minute Foray was evicted long
 * before the founder pressed Copy. A file survives the relaunch, and 2,000
 * packed rows hold a whole Foray with room to spare (`DiagRingTests`' 51-minute
 * retention test is the budget, executed).
 *
 * APPEND-ONLY, COMPACTED IN A BATCH. Each row is one appended line, written
 * before `append` returns (a crash one instruction later still has it). The
 * file may run up to `slack` lines past the cap; the next append past that
 * rewrites it atomically with the newest `capacity` rows. So a row costs one
 * small write, not a 300 KB rewrite, and `rows` never holds more than
 * `capacity` (what Copy and engineRead see is always the capped ring).
 *
 * SEQ IS MONOTONIC ACROSS LAUNCHES. A relaunch reads the file and continues
 * from the highest `seq` it holds, so a gap in the numbers is a lost row and
 * never a reordering, and NE-26 can merge two launches' rows by `at` without
 * inventing an order.
 *
 * A TORN LAST LINE (the process died mid-write) costs that one row: the parser
 * skips it, and the file is rewritten before the next append so the new row
 * does not glue onto the torn one.
 *
 * Foundation only (FileManager, FileHandle, Data), so the whole ring runs in
 * the core's host `swift test` on macOS and Linux. The plugin's
 * EngineDiagnostics adds the Application Support location, the clocks and the
 * os.Logger mirror. Main-confined like the rest of the engine: no locking. */
public final class DiagRing {
    public static let capacity = 2_000
    public static let slack = 200

    public let fileURL: URL
    public let capacity: Int
    public let slack: Int

    /// The newest `capacity` rows, oldest first.
    public private(set) var rows: [DiagRow] = []
    /// The seq the next row gets.
    public private(set) var nextSeq = 1
    /// Lines the file holds now (rows plus any torn or foreign line).
    public private(set) var fileLines = 0
    /// The last write that failed, for the `build` row and the tests. A ring
    /// that cannot write keeps its rows in memory: Copy still works this launch.
    public private(set) var lastWriteError: String?

    private var needsRewrite = false

    public init(fileURL: URL, capacity: Int = DiagRing.capacity, slack: Int = DiagRing.slack) {
        self.fileURL = fileURL
        self.capacity = max(1, capacity)
        self.slack = max(0, slack)
        load()
    }

    /// Gate, stamp and store one entry. Nil when the gate refused the whole
    /// row (`DiagGate.admit`); the refusal itself is written as a `diag` row,
    /// so it is never silent.
    @discardableResult
    public func append(_ entry: DiagEntry, wallMs: Double, monoMs: Double) -> DiagRow? {
        guard let admitted = DiagGate.admit(entry) else {
            store(DiagEntry(kind: "diag", fields: [JSONMember(DiagGate.subKindField, .string("row-refused"))]),
                  wallMs: wallMs, monoMs: monoMs)
            return nil
        }
        return store(admitted, wallMs: wallMs, monoMs: monoMs)
    }

    /// Everything gone: the rows, the file and the counter (data deletion,
    /// plan §4.6). The next row starts again at seq 1.
    public func purge() throws {
        rows = []
        nextSeq = 1
        fileLines = 0
        needsRewrite = false
        if FileManager.default.fileExists(atPath: fileURL.path) {
            try FileManager.default.removeItem(at: fileURL)
        }
    }

    // MARK: - internals

    @discardableResult
    private func store(_ entry: DiagEntry, wallMs: Double, monoMs: Double) -> DiagRow {
        let row = DiagRow(seq: nextSeq, wallMs: wallMs, monoMs: monoMs, kind: entry.kind, fields: entry.fields)
        nextSeq += 1
        rows.append(row)
        if rows.count > capacity { rows.removeFirst(rows.count - capacity) }
        if needsRewrite || fileLines + 1 > capacity + slack {
            rewrite()
        } else {
            appendLine(row.line())
        }
        return row
    }

    private func load() {
        guard let data = FileManager.default.contents(atPath: fileURL.path), !data.isEmpty else { return }
        let text = String(decoding: data, as: UTF8.self)
        let lines = text.split(separator: "\n", omittingEmptySubsequences: true)
        fileLines = lines.count
        var parsed: [DiagRow] = []
        for line in lines {
            if let row = DiagRow.parse(String(line)) { parsed.append(row) }
        }
        rows = Array(parsed.suffix(capacity))
        nextSeq = (parsed.map(\.seq).max() ?? 0) + 1
        // A torn tail, or lines that are not rows: rewrite before the next
        // append rather than glue a good row onto a bad one.
        needsRewrite = data.last != UInt8(ascii: "\n") || parsed.count != lines.count
    }

    private func ensureDirectory() throws {
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
    }

    private func appendLine(_ line: String) {
        let data = Data((line + "\n").utf8)
        do {
            try ensureDirectory()
            if !FileManager.default.fileExists(atPath: fileURL.path) {
                try data.write(to: fileURL)
            } else {
                let handle = try FileHandle(forWritingTo: fileURL)
                defer { try? handle.close() }
                try handle.seekToEnd()
                try handle.write(contentsOf: data)
            }
            fileLines += 1
            lastWriteError = nil
        } catch {
            lastWriteError = String(describing: type(of: error))
            needsRewrite = true
        }
    }

    /// The newest `capacity` rows, atomically: a crash mid-rewrite leaves the
    /// old file, never half of the new one.
    private func rewrite() {
        let text = rows.map { $0.line() + "\n" }.joined()
        do {
            try ensureDirectory()
            try Data(text.utf8).write(to: fileURL, options: .atomic)
            fileLines = rows.count
            needsRewrite = false
            lastWriteError = nil
        } catch {
            lastWriteError = String(describing: type(of: error))
            needsRewrite = true
        }
    }
}
