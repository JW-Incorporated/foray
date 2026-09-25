import Foundation

/// One item of a BUILT Foray queue, as the engine reads it: what `playForay`'s
/// `items` carry (plan §5.2), which `buildForayQueue` (player/foray-queue.js)
/// emits and the engine never builds itself (plan §3 A-1, §11).
///
/// Every field is nil where the JS value is absent OR of the wrong type: the
/// rules below read each one through `typeof x === "number"` (then
/// `Number.isFinite`), `typeof s === "string"` or `=== true`, and each of those
/// lands on the same answer for "absent" and "wrong type", so one nil carries
/// both. A number field may hold a non-finite Double; the rules check
/// finiteness themselves, exactly where the JS calls `isNum`.
public struct ForayItem: Equatable {
    public var id: String?
    /// `episode` (a segment), `tts` (narration) or `jingle`.
    public var kind: String?
    public var type: String?
    public var title: String?
    public var show: String?
    public var audioUrl: String?
    public var startSec: Double?
    public var endSec: Double?
    /// The authored out-point before ADR-0008's pad; the clock counts it.
    public var authoredEndSec: Double?
    public var durationSec: Double?
    public var durationSource: String?
    public var script: String?
    public var sourceItemId: String?
    public var itemId: String?
    /// `dai_suspected === true`.
    public var daiSuspected: Bool
    /// `needs_drift_check === true`.
    public var needsDriftCheck: Bool
    public var startAnchor: String?
    public var endAnchor: String?
    public var referenceDurationSec: Double?

    public init(id: String? = nil, kind: String? = nil, type: String? = nil, title: String? = nil,
                show: String? = nil, audioUrl: String? = nil, startSec: Double? = nil, endSec: Double? = nil,
                authoredEndSec: Double? = nil, durationSec: Double? = nil, durationSource: String? = nil,
                script: String? = nil, sourceItemId: String? = nil, itemId: String? = nil,
                daiSuspected: Bool = false, needsDriftCheck: Bool = false, startAnchor: String? = nil,
                endAnchor: String? = nil, referenceDurationSec: Double? = nil) {
        self.id = id
        self.kind = kind
        self.type = type
        self.title = title
        self.show = show
        self.audioUrl = audioUrl
        self.startSec = startSec
        self.endSec = endSec
        self.authoredEndSec = authoredEndSec
        self.durationSec = durationSec
        self.durationSource = durationSource
        self.script = script
        self.sourceItemId = sourceItemId
        self.itemId = itemId
        self.daiSuspected = daiSuspected
        self.needsDriftCheck = needsDriftCheck
        self.startAnchor = startAnchor
        self.endAnchor = endAnchor
        self.referenceDurationSec = referenceDurationSec
    }

    /// A built queue item as `playForay` carries it (NE-30s): each field is
    /// the JS value when it has the type the rules test for (`typeof`), else
    /// nil, and the two flags are `=== true`, exactly as the parity harness
    /// reads a fixture's item.
    public init(node: JSONNode) {
        self.init(
            id: node["id"]?.stringValue, kind: node["kind"]?.stringValue, type: node["type"]?.stringValue,
            title: node["title"]?.stringValue, show: node["show"]?.stringValue,
            audioUrl: node["audio_url"]?.stringValue, startSec: node["start_sec"]?.numberValue,
            endSec: node["end_sec"]?.numberValue, authoredEndSec: node["authored_end_sec"]?.numberValue,
            durationSec: node["duration_sec"]?.numberValue, durationSource: node["duration_source"]?.stringValue,
            script: node["script"]?.stringValue, sourceItemId: node["source_item_id"]?.stringValue,
            itemId: node["item_id"]?.stringValue, daiSuspected: node["dai_suspected"] == .bool(true),
            needsDriftCheck: node["needs_drift_check"] == .bool(true),
            startAnchor: node["start_anchor"]?.stringValue, endAnchor: node["end_anchor"]?.stringValue,
            referenceDurationSec: node["reference_duration_sec"]?.numberValue)
    }

    /// The item as the seam rules read it (seam-gap.js `isSegment`).
    public var seam: SeamItem { SeamItem(startSec: startSec, endSec: endSec) }

    /// The item as interlude.js reads it.
    public var interlude: InterludeItem {
        InterludeItem(kind: kind, type: type, sourceItemId: sourceItemId, itemId: itemId,
                      audioUrl: audioUrl, startSec: startSec, endSec: endSec)
    }

    /// The item as the lock-screen mapping reads it (media-session.js).
    public var media: MediaMapping.Item { MediaMapping.Item(kind: kind, title: title, show: show) }
}

/// The Foray clock: how long each item of a built queue is, where each one
/// starts, and where a playhead lands on the listener's clock. The Swift port
/// of `itemRuntimeSec` / `narrationDuration` / `forayRuntimeSec` /
/// `runtimeIsEstimated` (player/foray-queue.js) and `segmentStarts` /
/// `segmentAtElapsed` / `forayElapsed` / `progressSegments`
/// (player/foray-resolve.js), card NE-29s. JS is the reference; the
/// `foray-clock` parity family is the contract.
///
/// ONE DEFINITION OF "HOW LONG IS THIS ITEM" (`itemRuntimeSec`), because three
/// private copies of that subtraction once all counted narration as 0 s: every
/// other function here measures an item through it.
///
/// A jingle counts its measured 3.0 s (OQ-6, plan §9a, applied JS-first by
/// NE-29j): the clock and the audio must agree. Every number is READ from the
/// generated `EngineConstants`.
///
/// `nil` in an items list stands for an entry that is not a plain object; the
/// JS reads every field of such an entry as `undefined`, which is an item with
/// no fields here.
public enum ForayClock {
    /// `JINGLE_DURATION_SEC`.
    public static let jingleDurationSec: Double = EngineConstants.ForayQueue.jingleDurationSec
    /// `NARRATION_CHARS_PER_SEC`: 170 wpm x 6.0 chars/word.
    public static let narrationCharsPerSec: Double = EngineConstants.ForayQueue.narrationCharsPerSec
    /// `NARRATION_FALLBACK_SEC`: what a narration item with neither a duration
    /// nor a script is worth. Not zero: zero makes an item free, silently.
    public static let narrationFallbackSec: Double = EngineConstants.ForayQueue.narrationFallbackSec
    public static let durationMeasured: String = EngineConstants.ForayQueue.durationMeasured
    public static let durationEstimated: String = EngineConstants.ForayQueue.durationEstimated
    public static let durationFallback: String = EngineConstants.ForayQueue.durationFallback
    /// `JINGLE`: the kind a jingle item carries.
    public static let jingle: String = EngineConstants.ForayQueue.jingle

    // MARK: - How long

    /// `narrationDuration(item)`: how long a narration item runs, and on what
    /// authority. A positive finite `duration_sec` keeps its provenance (or is
    /// `measured`); else a non-blank script is projected at
    /// `narrationCharsPerSec`, rounded to the millisecond; else the fallback.
    public static func narrationDuration(_ item: ForayItem?) -> (sec: Double, source: String) {
        if let sec = finite(item?.durationSec), sec > 0 {
            let source = item?.durationSource.flatMap { MediaMapping.nonEmptyTrimmed($0) != nil ? $0 : nil }
            return (sec, source ?? durationMeasured)
        }
        let script = item?.script.map(MediaMapping.jsTrim) ?? ""
        let length = Double(script.utf16.count) // String.prototype.length counts UTF-16 units
        if length > 0 {
            return (JSMath.round(length / narrationCharsPerSec * 1000) / 1000, durationEstimated)
        }
        return (narrationFallbackSec, durationFallback)
    }

    /// `itemRuntimeSec(item)`: a segment's authored length (the pad is
    /// tolerance, not content, ADR-0008), else a positive finite
    /// `duration_sec` (narration, a jingle), else 0.
    public static func itemRuntimeSec(_ item: ForayItem?) -> Double {
        let end = finite(item?.authoredEndSec) ?? item?.endSec
        if let start = finite(item?.startSec), let end = finite(end), end > start { return end - start }
        if let sec = finite(item?.durationSec), sec > 0 { return sec }
        return 0
    }

    /// `forayRuntimeSec(items)`: the listener's clock, narration included.
    public static func forayRuntimeSec(_ items: [ForayItem?]?) -> Double {
        (items ?? []).reduce(0) { $0 + itemRuntimeSec($1) }
    }

    /// `runtimeIsEstimated(items)`: is any item's duration anything but a
    /// measurement? Tape (no `duration_source`) is measured. Not a list: false.
    public static func runtimeIsEstimated(_ items: [ForayItem?]?) -> Bool {
        guard let items else { return false }
        return items.contains { item in
            guard let source = item?.durationSource, MediaMapping.nonEmptyTrimmed(source) != nil else { return false }
            return source != durationMeasured
        }
    }

    // MARK: - Where

    /// `segmentStarts(items)`: the cumulative start of every item, in Foray seconds.
    public static func segmentStarts(_ items: [ForayItem?]?) -> [Double] {
        var starts: [Double] = []
        var acc = 0.0
        for item in items ?? [] {
            starts.append(acc)
            acc += itemRuntimeSec(item)
        }
        return starts
    }

    /// Which item a Foray-clock reading falls in, and how far into it.
    public struct Position: Equatable {
        public let index: Int
        public let into: Double
        public let start: Double
    }

    /// `segmentAtElapsed(items, elapsed)`: clamped at both ends (a scrub to the
    /// total, or a rounding error past it, lands on the last item). No items: nil.
    public static func segmentAtElapsed(_ items: [ForayItem?]?, elapsed: Double?) -> Position? {
        let list = items ?? []
        guard !list.isEmpty else { return nil }
        let target: Double = {
            guard let value = finite(elapsed), value > 0 else { return 0 }
            return value
        }()
        let starts = segmentStarts(list)
        for (i, item) in list.enumerated() where target < starts[i] + itemRuntimeSec(item) {
            return Position(index: i, into: target - starts[i], start: starts[i])
        }
        let last = list.count - 1
        return Position(index: last, into: itemRuntimeSec(list[last]), start: starts[last])
    }

    /// `forayElapsed(items, index, playheadSec)`: the Foray clock from a queue
    /// index and the playhead inside the SOURCE. A segment's in-point is
    /// subtracted; a narration item has none (its playhead is the offset). The
    /// offset is clamped into `[0, the item's length]`. `index` is the JS
    /// value when it is a number (nil otherwise); anything but a non-negative
    /// integer is 0.
    public static func forayElapsed(_ items: [ForayItem?]?, index: Double?, playheadSec: Double?) -> Double {
        let list = items ?? []
        guard !list.isEmpty, let index, MediaMapping.isInteger(index), index >= 0 else { return 0 }
        let i = Int(Swift.min(index, Double(list.count - 1)))
        let starts = segmentStarts(list)
        let item = list[i]
        let base = finite(item?.startSec) ?? 0
        var into = 0.0
        if let playhead = finite(playheadSec) {
            into = JSMath.min(JSMath.max(0, playhead - base), itemRuntimeSec(item))
        }
        return starts[i] + into
    }

    /// One row of the stored-progress view of a running order (#40): the
    /// AUTHORED segment id (nil for an item with none, a narration bridge) and
    /// its Foray-clock start and length.
    public struct ProgressSegment: Equatable {
        public let id: String?
        public let startSec: Double
        public let durationSec: Double

        public init(id: String?, startSec: Double, durationSec: Double) {
            self.id = id
            self.startSec = startSec
            self.durationSec = durationSec
        }
    }

    /// An authored entry of a resolved Foray, as `progressSegments` reads it:
    /// `playable` is JavaScript truthiness, `queueIndex` the value when it is a
    /// number, `segmentId` the id when it is a string.
    public struct ProgressEntry: Equatable {
        public let playable: Bool
        public let queueIndex: Double?
        public let segmentId: String?

        public init(playable: Bool, queueIndex: Double?, segmentId: String?) {
            self.playable = playable
            self.queueIndex = queueIndex
            self.segmentId = segmentId
        }
    }

    /// `progressSegments(resolved)`: one row per playable item, in play order,
    /// its id joined back from the entries by `queueIndex` (a later entry for
    /// the same index wins, as a `Map.set` does). A narration bridge still
    /// gets a row with its real length: a bridge counted as 0 s would pull
    /// every later start early.
    public static func progressSegments(_ items: [ForayItem?]?, entries: [ProgressEntry?]?) -> [ProgressSegment] {
        let list = items ?? []
        let starts = segmentStarts(list)
        var idByQueueIndex: [Int: String?] = [:]
        for entry in entries ?? [] {
            guard let entry, entry.playable, let index = entry.queueIndex, MediaMapping.isInteger(index),
                  let key = Int(exactly: index) else { continue }
            idByQueueIndex[key] = entry.segmentId
        }
        return list.enumerated().map { i, item in
            ProgressSegment(id: idByQueueIndex[i] ?? nil, startSec: starts[i], durationSec: itemRuntimeSec(item))
        }
    }

    // MARK: - helpers

    /// `isNum`: a finite number, or nil.
    static func finite(_ value: Double?) -> Double? {
        guard let value, value.isFinite else { return nil }
        return value
    }
}
