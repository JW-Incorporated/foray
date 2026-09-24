import Foundation

/* Admission into the closed vocabularies: player/engine-vocabulary.js
 * `admitToken`, ported by hand (card NE-10s) beside the GENERATED sets in
 * Vocabulary.swift, which NE-04's generator owns and this file must not edit.
 * The `diag-tokens` parity family holds the two to the same answers: the sets,
 * in order, and every admit/refuse/throw case. */

extension Vocabulary {
    /// The caller named a vocabulary that does not exist: a bug in code, not a
    /// bad row (JavaScript throws a RangeError for it).
    public struct UnknownSet: Error, Equatable, CustomStringConvertible {
        public let name: String?
        public var description: String { "no closed vocabulary named \(name.map { "\"\($0)\"" } ?? "null")" }
    }

    /// `admitToken(set, token)`: the token itself when `set` holds it EXACTLY,
    /// else nil, and the row drops it. No trimming, no case folding, no
    /// dashed/camel equivalence: a native emitter that spells a token
    /// differently is a defect to surface, and a lenient admission would hide
    /// it. `token` is nil for anything that is not a string (`typeof token
    /// === "string"`), which is never admitted.
    ///
    /// An unknown set, `nil` for a set that is not a string included, throws
    /// `UnknownSet`. The JS checks OWN properties so `"constructor"` and
    /// `"__proto__"` are unknown sets; a Swift dictionary has no inherited
    /// keys, so the lookup below needs no such guard.
    public static func admit(_ token: String?, into set: String?) throws -> String? {
        guard let set, let tokens = sets[set] else { throw UnknownSet(name: set) }
        guard let token, tokens.contains(token) else { return nil }
        return token
    }
}
