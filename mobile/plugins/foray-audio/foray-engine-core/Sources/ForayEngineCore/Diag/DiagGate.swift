import Foundation

/* What an engine diagnostics row may CONTAIN (docs/native-engine-plan.md §4.5,
 * §10; card NE-19). Every row the engine writes passes through `admit` on its
 * way into the ring, and the ring is what the founder pastes into a public
 * GitHub issue (Copy, NE-26) and what `os.Logger` mirrors into a sysdiagnose.
 *
 * THE RULES, and the leak each one closes:
 *
 *   1. A field whose value belongs to a closed vocabulary is admitted ONLY
 *      through `Vocabulary.admit`, exactly (a `cause`, a `source`, a seam's
 *      `stages`, a `mode` row's `reason`, an interruption's `reason`, a
 *      session `error`). A misspelt token is dropped, never "fixed", so the
 *      emitter's defect shows as a gap (player/engine-vocabulary.js).
 *   2. Every other string must be a TOKEN: ASCII letters, digits and `._:-`,
 *      at most 64 characters. That excludes every URL (`/`), every sentence
 *      (space), every e-mail (`@`) and every device name with a space or an
 *      apostrophe in it ("Wyatt's AirPods").
 *   3. A `route` or `port` is a PORT TYPE: letters and digits only. A route
 *      NAME is what the listener called their car; the port type is what the
 *      verdicts need (`carAudio`, `bluetoothA2DP`).
 *   4. A key that names a URL or a name (`audio_url`, `routeName`,
 *      `voiceName`) is dropped whatever its value, because a token-shaped
 *      value can still be one ("MAZDA").
 *   5. The ONLY free text is the three Now Playing strings of a `nowplaying`
 *      row, trimmed and capped at 40 exactly as the page caps its own
 *      (`diagnostic-log.js` nowPlayingFieldOf). They are catalogue metadata,
 *      already public, and never reach os.Logger (`loggerText`).
 *
 * NOTHING IS DROPPED SILENTLY. A field the gate refused is named in the row's
 * `dropped` list, so a Copy shows "this row had a `why` and it was withheld"
 * rather than a row that looks complete. A row whose KIND is not a token is
 * refused whole: there is nothing safe to file it under.
 *
 * A field called `kind` is the row's sub-kind (`session kind=interruption`,
 * plan §10), but `kind` is also the row header's (`DiagRow.headerKeys`), and
 * DiagRow drops a field that would shadow the header. So the gate writes the
 * sub-kind as `event`: `{"kind":"session","event":"interruption",...}`. */
public enum DiagGate {
    /// The row kind whose `title`, `artist` and `album` may be free text.
    public static let nowPlayingKind = "nowplaying"
    public static let nowPlayingTextFields: Set<String> = ["title", "artist", "album"]
    /// diagnostic-log.js `NOWPLAYING_FIELD_MAX`.
    public static let nowPlayingTextMax = 40
    public static let tokenMax = 64
    public static let portTypeMax = 40
    /// Where an entry's own `kind` field goes (see the header).
    public static let subKindField = "event"
    /// The list of refused field names every lossy row carries.
    public static let droppedField = "dropped"
    /// Nested objects deeper than this are dropped: no row needs them, and an
    /// unbounded walk over a value a caller built is a stack to overflow.
    static let maxDepth = 3

    /// The entry as the ring may store it, or nil when its kind is not a token.
    public static func admit(_ entry: DiagEntry) -> DiagEntry? {
        guard isToken(entry.kind) else { return nil }
        let event = entry[field: "kind"]?.stringValue
        var kept: [JSONMember] = []
        var dropped: [String] = []
        for member in entry.fields {
            let key = member.key == "kind" ? subKindField : member.key
            guard isToken(key) else {
                dropped.append("invalid-key")
                continue
            }
            if DiagRow.headerKeys.contains(key) || key == droppedField || isForbiddenKey(key)
                || kept.contains(where: { $0.key == key }) {
                dropped.append(key)
                continue
            }
            let scope = Scope(kind: entry.kind, event: event, key: key)
            let (value, lossy) = admitValue(member.value, scope, depth: 0)
            if let value { kept.append(JSONMember(key, value)) }
            if value == nil || lossy { dropped.append(key) }
        }
        if !dropped.isEmpty {
            kept.append(JSONMember(droppedField, .array(dropped.map { JSONNode.string($0) })))
        }
        return DiagEntry(kind: entry.kind, fields: kept)
    }

    /// Rule 2: the shape every non-vocabulary string must have.
    public static func isToken(_ text: String) -> Bool {
        let scalars = text.unicodeScalars
        guard !scalars.isEmpty, scalars.count <= tokenMax else { return false }
        return scalars.allSatisfy { scalar in
            switch scalar.value {
            case 0x30...0x39, 0x41...0x5A, 0x61...0x7A: return true // 0-9 A-Z a-z
            case 0x2E, 0x5F, 0x3A, 0x2D: return true               // . _ : -
            default: return false
            }
        }
    }

    /// Rule 3: an AVAudioSession port type, as the adapters write it.
    public static func isPortType(_ text: String) -> Bool {
        let scalars = text.unicodeScalars
        guard !scalars.isEmpty, scalars.count <= portTypeMax else { return false }
        return scalars.allSatisfy { scalar in
            switch scalar.value {
            case 0x30...0x39, 0x41...0x5A, 0x61...0x7A: return true // 0-9 A-Z a-z
            default: return false
            }
        }
    }

    /// Rule 4.
    static func isForbiddenKey(_ key: String) -> Bool {
        let lower = key.lowercased()
        return lower.contains("url") || lower.contains("name")
    }

    /// Rule 1: the closed set a field is admitted through, if any.
    public static func vocabularySet(kind: String, event: String?, key: String) -> String? {
        switch key {
        case "cause": return "stopCause"
        case "source": return "source"
        case "stages": return "stage"
        default: break
        }
        switch (kind, key) {
        case ("mode", "reason"): return "modeReason"
        case ("session", "error"): return "sessionError"
        case ("session", "reason") where event == "interruption": return "interruptionReason"
        default: return nil
        }
    }

    /// Rule 5, `nowPlayingFieldOf`: trimmed, and past 40 UTF-16 units cut to
    /// 39 plus an ellipsis, so the capped field is exactly 40 as the page's is.
    /// A cut that would split a surrogate pair drops the orphaned half (JS
    /// would keep a lone surrogate; a Swift String cannot hold one).
    public static func nowPlayingText(_ text: String) -> String {
        let trimmed = jsTrim(text)
        let units = Array(trimmed.utf16)
        guard units.count > nowPlayingTextMax else { return trimmed }
        var head = Array(units.prefix(nowPlayingTextMax - 1))
        if let last = head.last, UTF16.isLeadSurrogate(last) { head.removeLast() }
        return String(decoding: head, as: UTF16.self) + "\u{2026}"
    }

    /// The row as os.Logger carries it: `#<seq> <kind> key=value ...`, tokens
    /// only. The Now Playing strings are NOT in it (`title=y` says whether
    /// there was one), because the unified log travels further than the ring
    /// (a sysdiagnose, a CI artifact) and the page's own mirror keeps the same
    /// line (`diagnostic-log.js`: "the field content only crosses the lower
    /// one"). Every value here already passed `admit`.
    public static func loggerText(_ row: DiagRow) -> String {
        var parts = ["#\(row.seq)", row.kind]
        for member in row.fields {
            if row.kind == nowPlayingKind && nowPlayingTextFields.contains(member.key) {
                let present = member.value.stringValue.map { !$0.isEmpty } ?? false
                parts.append("\(member.key)=\(present ? "y" : "n")")
                continue
            }
            switch member.value {
            case let .string(text): parts.append("\(member.key)=\(text)")
            case let .array(items) where items.allSatisfy({ $0.stringValue != nil }):
                parts.append("\(member.key)=\(items.compactMap(\.stringValue).joined(separator: ","))")
            default: parts.append("\(member.key)=\(JSWriter.stringify(member.value))")
            }
        }
        return parts.joined(separator: " ")
    }

    // MARK: - values

    struct Scope {
        let kind: String
        let event: String?
        let key: String
    }

    /// A value as admitted (nil: refused whole) and whether anything inside it
    /// was dropped on the way (an array element, a nested member).
    static func admitValue(_ value: JSONNode, _ scope: Scope, depth: Int) -> (JSONNode?, Bool) {
        if let set = vocabularySet(kind: scope.kind, event: scope.event, key: scope.key) {
            return admitTokens(value, set: set)
        }
        if scope.kind == nowPlayingKind && nowPlayingTextFields.contains(scope.key) && depth == 0 {
            switch value {
            case .null: return (.null, false)
            case let .string(text): return (.string(nowPlayingText(text)), false)
            default: return (nil, false)
            }
        }
        switch value {
        case .null, .bool:
            return (value, false)
        case let .number(number):
            // JSWriter prints a non-finite number as null; say so here instead.
            return number.isFinite ? (value, false) : (.null, true)
        case let .string(text):
            let ok = ["route", "port", "routePort"].contains(scope.key) ? isPortType(text) : isToken(text)
            return ok ? (value, false) : (nil, false)
        case let .array(items):
            var lossy = false
            var kept: [JSONNode] = []
            for item in items {
                let (admitted, itemLossy) = admitValue(item, scope, depth: depth + 1)
                if let admitted { kept.append(admitted) } else { lossy = true }
                lossy = lossy || itemLossy
            }
            return (.array(kept), lossy)
        case let .object(members):
            guard depth < maxDepth else { return (nil, false) }
            var lossy = false
            var kept: [JSONMember] = []
            for member in members {
                guard isToken(member.key), !isForbiddenKey(member.key),
                      !kept.contains(where: { $0.key == member.key }) else {
                    lossy = true
                    continue
                }
                let inner = Scope(kind: scope.kind, event: scope.event, key: member.key)
                let (admitted, innerLossy) = admitValue(member.value, inner, depth: depth + 1)
                if let admitted { kept.append(JSONMember(member.key, admitted)) } else { lossy = true }
                lossy = lossy || innerLossy
            }
            return (.object(kept), lossy)
        }
    }

    /// A vocabulary-bound value: a token of the set, null, or an array of them
    /// (a seam's stage list), with any other token removed.
    static func admitTokens(_ value: JSONNode, set: String) -> (JSONNode?, Bool) {
        switch value {
        case .null:
            return (.null, false)
        case let .string(token):
            return ((try? Vocabulary.admit(token, into: set)).map { JSONNode.string($0) }, false)
        case let .array(items):
            let kept = items.compactMap { item -> JSONNode? in
                (try? Vocabulary.admit(item.stringValue, into: set)).map { JSONNode.string($0) }
            }
            return (.array(kept), kept.count != items.count)
        default:
            return (nil, false)
        }
    }

    /// `String.prototype.trim`.
    static func jsTrim(_ text: String) -> String {
        let scalars = Array(text.unicodeScalars)
        guard let first = scalars.firstIndex(where: { !Rows.isJSWhitespace($0) }),
              let last = scalars.lastIndex(where: { !Rows.isJSWhitespace($0) }) else { return "" }
        var out = String.UnicodeScalarView()
        out.append(contentsOf: scalars[first...last])
        return String(out)
    }
}
