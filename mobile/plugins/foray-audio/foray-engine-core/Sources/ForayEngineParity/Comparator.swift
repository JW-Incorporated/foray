import Foundation

/// The Swift parity comparator: a line-for-line port of
/// `player/parity/compare.js`, which is the reference.
///
/// WHY A PORT AND NOT "JUST ==". Two comparators that disagree make parity a
/// coin toss: a case green in `record.mjs --check` and red here (or the other
/// way round) says nothing about the RULE. So the rules are compare.js's, each
/// one a decision recorded there (exact by default, key order never matters,
/// array order always does, `n.*` op tokens stripped outside `prepare`, a
/// tolerance never forgives a `$num` tag), and the `compare` fixture family
/// runs the SAME table through both: JS records `compareVerdict`'s answer from
/// compare.js, and `CompareFamily` checks this port gives the same paths and
/// reasons. A change to either side that the other does not share turns that
/// family red.
public enum Comparator {
    /// compare.js `NATIVE_TOKEN_PREFIX`.
    public static let nativeTokenPrefix = "n."
    /// compare.js `NATIVE_TOKEN_FAMILIES`: the families whose op logs KEEP
    /// `n.*` tokens (plan §6.2: the prepare family asserts them).
    public static let nativeTokenFamilies = ["prepare"]

    public struct Difference: Equatable, CustomStringConvertible {
        /// `$`, `$.return`, `$.ops[2]`: the same spelling compare.js uses.
        public let path: String
        /// nil = absent (compare.js's `undefined`).
        public let expected: JSONValue?
        public let actual: JSONValue?
        public let why: String

        public var description: String {
            "\(path): expected \(expected?.description ?? "undefined"), got \(actual?.description ?? "undefined") (\(why))"
        }
    }

    /// compare.js `compare(expected, actual, {family, tolerance})`. Both sides
    /// are ENCODED (tags, not live NaN). Empty = equal.
    public static func compare(_ expected: JSONValue, _ actual: JSONValue,
                               family: String? = nil, tolerance: Double? = nil) -> [Difference] {
        let keepNative = family.map { nativeTokenFamilies.contains($0) } ?? false
        // `typeof opts.tolerance === "number" && opts.tolerance >= 0 ? ... : 0`:
        // NaN fails `>= 0` there and here.
        let tol: Double = {
            guard let tolerance, tolerance >= 0 else { return 0 }
            return tolerance
        }()
        var diffs: [Difference] = []

        func walk(_ e: JSONValue, _ a: JSONValue, _ at: String, _ key: String?) {
            if case let .number(en) = e, case let .number(an) = a {
                if en == an { return }
                if tol > 0 && Swift.abs(en - an) <= tol { return }
                diffs.append(Difference(path: at, expected: e, actual: a,
                                        why: tol > 0 ? "differs by more than \(JSNumber.string(tol))" : "not equal"))
                return
            }
            if isSpecialNum(e) || isSpecialNum(a) {
                // NaN equals only a NaN tag and -0 only a -0 tag; no tolerance,
                // because 0 within any tolerance of -0 is the sign bug a -0
                // case exists to catch.
                if isSpecialNum(e) && isSpecialNum(a) && strictEquals(e["$num"]!, a["$num"]!) { return }
                diffs.append(Difference(path: at, expected: e, actual: a, why: "special number differs"))
                return
            }
            if e.arrayValue != nil || a.arrayValue != nil {
                guard var ea = e.arrayValue, var aa = a.arrayValue else {
                    diffs.append(Difference(path: at, expected: e, actual: a, why: "one side is not an array"))
                    return
                }
                if key == "ops" && !keepNative {
                    ea = stripNative(ea)
                    aa = stripNative(aa)
                }
                if ea.count != aa.count {
                    diffs.append(Difference(path: at, expected: .array(ea), actual: .array(aa),
                                            why: "length \(ea.count) != \(aa.count)"))
                    return
                }
                for index in ea.indices { walk(ea[index], aa[index], "\(at)[\(index)]", nil) }
                return
            }
            if e.objectValue != nil || a.objectValue != nil {
                guard let eo = e.objectValue, let ao = a.objectValue else {
                    diffs.append(Difference(path: at, expected: e, actual: a, why: "one side is not an object"))
                    return
                }
                for k in jsSorted(Set(eo.keys).union(ao.keys)) {
                    let path = "\(at).\(k)"
                    switch (eo[k], ao[k]) {
                    case let (nil, av?):
                        diffs.append(Difference(path: path, expected: nil, actual: av, why: "unexpected key"))
                    case let (ev?, nil):
                        diffs.append(Difference(path: path, expected: ev, actual: nil, why: "missing key"))
                    case let (ev?, av?):
                        walk(ev, av, path, k)
                    case (nil, nil):
                        break
                    }
                }
                return
            }
            if !strictEquals(e, a) { diffs.append(Difference(path: at, expected: e, actual: a, why: "not equal")) }
        }

        walk(expected, actual, "$", nil)
        return diffs
    }

    /// compare.js `isSpecialNum`: an object whose ONLY key is `$num`.
    static func isSpecialNum(_ value: JSONValue) -> Bool {
        guard let fields = value.objectValue else { return false }
        return fields.count == 1 && fields["$num"] != nil
    }

    static func stripNative(_ ops: [JSONValue]) -> [JSONValue] {
        ops.filter { op in
            guard let token = op.stringValue else { return true }
            return !token.hasPrefix(nativeTokenPrefix)
        }
    }

    /// JavaScript `===` between two JSON values: primitives by value, and an
    /// array or object is never `===` a freshly parsed one.
    static func strictEquals(_ lhs: JSONValue, _ rhs: JSONValue) -> Bool {
        switch (lhs, rhs) {
        case (.null, .null): return true
        case let (.bool(l), .bool(r)): return l == r
        case let (.number(l), .number(r)): return l == r
        // By UTF-16 code units, as `===` compares: Swift's `==` treats a
        // precomposed and a decomposed "é" as equal, and JavaScript does not.
        case let (.string(l), .string(r)): return l.utf16.elementsEqual(r.utf16)
        default: return false
        }
    }

    /// `[...keys].sort()`: JavaScript sorts strings by UTF-16 code units,
    /// which is not Swift's `<` outside the Basic Multilingual Plane. The
    /// order is observable: it is the order the differences are reported in.
    static func jsSorted(_ keys: Set<String>) -> [String] {
        keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
    }

    /// compare.js `formatDiffs`: one line per difference, capped.
    public static func format(_ diffs: [Difference], max: Int = 12) -> String {
        var lines = diffs.prefix(max).map { "  \($0)" }
        if diffs.count > max { lines.append("  ... and \(diffs.count - max) more") }
        return lines.joined(separator: "\n")
    }
}
