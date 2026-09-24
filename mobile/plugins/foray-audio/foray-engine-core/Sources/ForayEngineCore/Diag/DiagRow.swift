import Foundation

/* One engine diagnostics row (docs/native-engine-plan.md §10, §4.3-§4.5; the
 * serialiser and parser are card NE-10s, the ring that stores them is NE-19,
 * the page's merge into Copy is NE-26, the report tool is NE-26r).
 *
 * A row is one JSON line of the ring file (`diag.jsonl`):
 *
 *   {"seq":41,"at":1790000000123,"mono":81234.5,"kind":"seam", ...fields in order}
 *
 * `seq` is the ring's monotonic counter (a gap is a lost row, never a
 * reordering), `at` is wall-clock epoch ms (what Copy merges the page's rows
 * by), `mono` is the monotonic clock in ms (what durations are computed from,
 * because the wall clock can jump under a drive). The fields follow in the
 * order the row's builder put them, written through `JSWriter` like every
 * other thing the engine stores, so a row reads the same in the file, in
 * os.Logger and in the page.
 *
 * What a row may CONTAIN (tokens only through `Vocabulary`, no URLs, port
 * types instead of route names, capped Now Playing text) is EngineDiagnostics'
 * gate (NE-19). This file is the shape, and one builder: the packed seam row. */

public struct DiagRow: Equatable {
    public var seq: Int
    /// Wall clock, epoch milliseconds.
    public var wallMs: Double
    /// Monotonic clock, milliseconds.
    public var monoMs: Double
    public var kind: String
    public var fields: [JSONMember]

    /// The members every row starts with, in order; a builder's field may not reuse one.
    public static let headerKeys = ["seq", "at", "mono", "kind"]

    public init(seq: Int, wallMs: Double, monoMs: Double, kind: String, fields: [JSONMember]) {
        self.seq = seq
        self.wallMs = wallMs
        self.monoMs = monoMs
        self.kind = kind
        self.fields = fields
    }

    /// The row as one JSON line (no trailing newline). A field that reuses a
    /// header key is dropped rather than written twice: a JSON reader keeps the
    /// LAST of a repeated key, so a field named `seq` would silently rewrite
    /// the ring's order for every reader.
    public func line() -> String {
        var members = [
            JSONMember("seq", .number(Double(seq))),
            JSONMember("at", .number(wallMs)),
            JSONMember("mono", .number(monoMs)),
            JSONMember("kind", .string(kind))
        ]
        members.append(contentsOf: fields.filter { !DiagRow.headerKeys.contains($0.key) })
        return JSWriter.stringify(.object(members))
    }

    /// One line back, or nil for a line that is not a row: a torn write at the
    /// end of the file after a crash is the expected case, and it must cost
    /// that one row, not the ring.
    public static func parse(_ line: String) -> DiagRow? {
        guard let row = try? JSONNode.parse(line), let members = row.members,
              let seq = row["seq"]?.numberValue, seq.isFinite, seq >= 0, seq.rounded(.towardZero) == seq,
              seq <= Double(Int.max / 2),
              let wallMs = row["at"]?.numberValue, wallMs.isFinite,
              let monoMs = row["mono"]?.numberValue, monoMs.isFinite,
              let kind = row["kind"]?.stringValue, !kind.isEmpty else { return nil }
        return DiagRow(seq: Int(seq), wallMs: wallMs, monoMs: monoMs, kind: kind,
                       fields: members.filter { !headerKeys.contains($0.key) })
    }

    /// A field's value by key.
    public subscript(field key: String) -> JSONNode? {
        fields.last(where: { $0.key == key })?.value
    }
}

/// The PACKED seam row (plan §13 item 37; NE-19, NE-32): ONE row per seam
/// with everything a seam verdict needs, instead of one row per load stage. A
/// 51-minute, 32-segment Foray has 31 seams; at one row per stage that alone
/// would push the first seam out of a 2,000-row ring before the drive ends.
///
///   observedGapMs  the silence the listener actually heard, out-point to
///                  audible start (null: the next item never became audible)
///   askedGapMs     the gap the seam rule asked for (seam-gap.js)
///   prepared       the standby deck was ready at the boundary (a prepare hit)
///   grace          a BackgroundGrace span covered the seam (§4.4)
///   bgRemainingMs  `backgroundTimeRemaining` at the boundary (null in the
///                  foreground, where UIKit reports an unbounded value)
///   stages         the load stages the standby deck reached, in order
///                  (`Vocabulary.Stage`), so a miss says WHERE it missed
public struct SeamRow: Equatable {
    public static let kind = "seam"

    public var observedGapMs: Double?
    public var askedGapMs: Double
    public var prepared: Bool
    public var grace: Bool
    public var bgRemainingMs: Double?
    public var stages: [Vocabulary.Stage]

    public init(observedGapMs: Double?, askedGapMs: Double, prepared: Bool, grace: Bool,
                bgRemainingMs: Double?, stages: [Vocabulary.Stage]) {
        self.observedGapMs = observedGapMs
        self.askedGapMs = askedGapMs
        self.prepared = prepared
        self.grace = grace
        self.bgRemainingMs = bgRemainingMs
        self.stages = stages
    }

    public var fields: [JSONMember] {
        [
            JSONMember("observedGapMs", Rows.finiteOrNull(observedGapMs)),
            JSONMember("askedGapMs", .number(askedGapMs)),
            JSONMember("prepared", .bool(prepared)),
            JSONMember("grace", .bool(grace)),
            JSONMember("bgRemainingMs", Rows.finiteOrNull(bgRemainingMs)),
            JSONMember("stages", .array(stages.map { JSONNode.string($0.rawValue) }))
        ]
    }

    public func row(seq: Int, wallMs: Double, monoMs: Double) -> DiagRow {
        DiagRow(seq: seq, wallMs: wallMs, monoMs: monoMs, kind: SeamRow.kind, fields: fields)
    }

    /// A seam row back from a `DiagRow`, or nil for another kind or a row
    /// missing a field. A stage token outside the vocabulary is DROPPED, not
    /// fatal (`Vocabulary.admit`): the rest of the seam is still evidence, and
    /// a bad token is the defect a report should show, by its absence.
    public init?(_ row: DiagRow) {
        guard row.kind == SeamRow.kind,
              let asked = row[field: "askedGapMs"]?.numberValue,
              case let .bool(prepared)? = row[field: "prepared"],
              case let .bool(grace)? = row[field: "grace"],
              let stageNodes = row[field: "stages"]?.arrayValue else { return nil }
        self.observedGapMs = row[field: "observedGapMs"]?.numberValue
        self.askedGapMs = asked
        self.prepared = prepared
        self.grace = grace
        self.bgRemainingMs = row[field: "bgRemainingMs"]?.numberValue
        self.stages = stageNodes.compactMap { (node: JSONNode) -> Vocabulary.Stage? in
            guard let token = try? Vocabulary.admit(node.stringValue, into: "stage") else { return nil }
            return Vocabulary.Stage(rawValue: token)
        }
    }
}
