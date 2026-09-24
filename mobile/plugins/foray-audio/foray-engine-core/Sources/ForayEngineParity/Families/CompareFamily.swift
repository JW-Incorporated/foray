import Foundation

/// The `compare` META-family: the comparator itself, as fixtures
/// (plan card NE-05: "a 'compare' meta-family, so the JS and Swift
/// comparators cannot disagree").
///
/// Every other family's verdict goes through a comparator, so a comparator
/// that differs between the runtimes makes every other green meaningless.
/// `player/parity/fixtures/compare/compare.json` is a table of
/// `compareVerdict(expected, actual, opts)` calls; JS records what
/// `compare.js` answers, and this runner checks `Comparator` answers the same
/// `{equal, diffs: [{path, why}]}`.
///
/// THE INPUTS GO THROUGH THE CODEC ON BOTH SIDES. The runners expand a case's
/// args (a `$num` tag becomes a live NaN), and `compareVerdict` re-encodes
/// them before comparing, because a comparator only ever sees encoded values.
/// This runner does the same two steps with the Swift codec, so the family
/// also pins that the two codecs round-trip every tag identically.
public enum CompareFamily {
    public static let module = "player/parity/compare.js"

    public static let runner = PureFamilyRunner(
        family: "compare",
        module: CompareFamily.module,
        reads: [:],
        calls: [
            "compareVerdict": { args in
                let expected = Codec.encode(args.count > 0 ? args[0] : .undefined)
                let actual = Codec.encode(args.count > 1 ? args[1] : .undefined)
                // `opts ?? {}`: a missing or null opts is no options.
                let opts = args.count > 2 ? args[2] : .undefined
                let family = opts["family"].stringValue
                let tolerance = opts["tolerance"].numberValue
                let diffs = Comparator.compare(expected, actual, family: family, tolerance: tolerance)
                return .returned(.object([
                    "equal": .bool(diffs.isEmpty),
                    "diffs": .array(diffs.map { .object(["path": .string($0.path), "why": .string($0.why)]) })
                ]))
            }
        ])
}
