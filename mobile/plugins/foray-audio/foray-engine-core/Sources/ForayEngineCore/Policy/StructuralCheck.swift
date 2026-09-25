import Foundation

/// J-4 (plan §5.2 `playForay`: "the engine re-validates structure"): the Swift
/// port of `player/foray-structure.js`, card NE-29s. A built Foray queue
/// crosses the bridge into an engine that did not build it, so before anything
/// is audible the engine checks it has the structure `buildForayQueue`
/// guarantees, and refuses it as `refused-structure` with EVERY problem named
/// otherwise. The rules, their order and their reasons are the JS module's
/// header; the `foray-structure` parity family is the contract.
///
/// `seamCensus` is the other half: what each join of a queue is, by the same
/// seam rules the engine applies (`SeamGap`, `Interlude`).
///
/// An items list is nil when the value is not an array; an entry is nil when
/// it is not a plain object (JS `isPlain`).
public enum StructuralCheck {
    /// `REFUSED_STRUCTURE`: the refusal's token on the wire.
    public static let refusedStructure: String = EngineConstants.ForayStructure.refusedStructure
    /// `QUEUE_KINDS`: `episode` (a segment), `tts` (narration), `jingle`.
    public static let queueKinds: [String] = EngineConstants.ForayStructure.queueKinds
    /// `STRUCTURE_PROBLEMS`: the closed set of problem codes, in the JS header's order.
    public static let problemCodes: [String] = EngineConstants.ForayStructure.structureProblems

    /// One problem: the item's queue index (-1 for the queue itself) and its code.
    public struct Problem: Equatable {
        public let index: Int
        public let code: String

        public init(index: Int, code: String) {
            self.index = index
            self.code = code
        }
    }

    /// `structuralCheck(items)`'s answer. `reason` is `refusedStructure`
    /// exactly when `ok` is false.
    public struct Verdict: Equatable {
        public let ok: Bool
        public let reason: String?
        public let problems: [Problem]
    }

    /// `structuralCheck(items)`: every problem of every item in queue order;
    /// `empty` (index -1) when there is no item at all.
    public static func check(_ items: [ForayItem?]?) -> Verdict {
        var problems: [Problem] = []
        if let items, !items.isEmpty {
            var seen = Set<String>()
            for (index, item) in items.enumerated() {
                for code in itemProblems(item) { problems.append(Problem(index: index, code: code)) }
                if let id = item?.id, Rows.nonEmpty(id) {
                    if seen.contains(id) { problems.append(Problem(index: index, code: "duplicate-id")) }
                    seen.insert(id)
                }
            }
        } else {
            problems.append(Problem(index: -1, code: "empty"))
        }
        let ok = problems.isEmpty
        return Verdict(ok: ok, reason: ok ? nil : refusedStructure, problems: problems)
    }

    /// `itemProblems(item)`, in the header's order.
    static func itemProblems(_ item: ForayItem?) -> [String] {
        guard let item else { return ["not-an-object"] }
        var out: [String] = []
        if !nonEmpty(item.id) { out.append("no-id") }
        guard let kind = item.kind, queueKinds.contains(kind) else {
            out.append("unknown-kind")
            return out
        }
        if kind == EngineConstants.QueueState.episode {
            if !nonEmpty(item.audioUrl) { out.append("no-audio") }
            var bounded = false
            if let start = item.startSec, start.isFinite, start >= 0, let end = item.endSec, end.isFinite, end > start {
                bounded = true
            }
            if !bounded { out.append("bad-bounds") }
            if item.daiSuspected && !(nonEmpty(item.startAnchor) && nonEmpty(item.endAnchor)) { out.append("dai-unanchored") }
            if item.needsDriftCheck && !(item.referenceDurationSec?.isFinite ?? false) { out.append("no-reference") }
            return out
        }
        if kind == ForayClock.jingle {
            if !nonEmpty(item.audioUrl) { out.append("no-audio") }
        } else if !nonEmpty(item.audioUrl) && !nonEmpty(item.script) {
            out.append("silent-narration")
        }
        if !(item.durationSec.map { $0.isFinite && $0 > 0 } ?? false) { out.append("no-duration") }
        return out
    }

    /// What every join of a queue is, on an automatic advance.
    public struct Census: Equatable {
        public var items: Int
        public var segments: Int
        /// Every join: items - 1, never negative.
        public var seams: Int
        public var beats: Int
        public var jingles: Int
        public var sameSource: Int
        /// Joins between two SEGMENTS whose `source_item_id` differs: where the
        /// segment strip draws a capsule edge.
        public var sourceChanges: Int
    }

    /// `seamCensus(items)`. A nil entry is a null (or any falsy) one: every
    /// rule answers "no" for it (`!from`, `from?.x`), which is what passing
    /// nil to each port does.
    public static func seamCensus(_ items: [ForayItem?]?) -> Census {
        let list = items ?? []
        var out = Census(items: list.count, segments: list.filter { SeamGap.isSegment($0?.seam) }.count,
                         seams: Swift.max(0, list.count - 1), beats: 0, jingles: 0, sameSource: 0, sourceChanges: 0)
        guard list.count > 1 else { return out }
        for i in 1..<list.count {
            let from = list[i - 1]
            let to = list[i]
            if SeamGap.gapSec(from: from?.seam, to: to?.seam, cause: SeamGap.autoAdvance) > 0 { out.beats += 1 }
            if Interlude.eligible(from: from?.interlude, to: to?.interlude, cause: SeamGap.autoAdvance) { out.jingles += 1 }
            if Interlude.sameSourceEpisode(from?.interlude, to?.interlude) { out.sameSource += 1 }
            if let from, let to, SeamGap.isSegment(from.seam), SeamGap.isSegment(to.seam),
               from.sourceItemId != to.sourceItemId {
                out.sourceChanges += 1
            }
        }
        return out
    }

    /// `nonEmpty(s)`: a string with something left after `trim`.
    static func nonEmpty(_ value: String?) -> Bool {
        guard let value else { return false }
        return Rows.nonEmpty(value)
    }
}
