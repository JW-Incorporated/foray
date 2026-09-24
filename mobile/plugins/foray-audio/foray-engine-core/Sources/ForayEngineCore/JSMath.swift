import Foundation

/// JavaScript's `Math.round`, `Math.max` and `Math.min`, for the policy ports
/// whose JS reference calls them (NE-09).
///
/// WHY NOT SWIFT'S OWN. They disagree with JavaScript exactly where a parity
/// case looks, and every disagreement is observable in a fixture:
///
///   - `Swift.max(0, .nan)` is 0 (it is `y >= x ? y : x`, and every
///     comparison with NaN is false); `Math.max(0, NaN)` is NaN.
///   - `Swift.max(0, -0.0)` is -0.0 (the second argument wins a tie);
///     `Math.max(0, -0)` is +0, and `Math.min(0, -0)` is -0. The codec
///     spells -0 as `{"$num": "-0"}`, so a sign slip is a red case.
///   - `x.rounded()` rounds a tie AWAY from zero (-2.5 -> -3); `Math.round`
///     rounds it UP (-2.5 -> -2), and keeps the sign of a zero result
///     (`Math.round(-0.4)` is -0).
///
/// A port that reads "Math.max" in the JS writes `JSMath.max` here, so the
/// translation is mechanical and a reviewer can check it line against line.
public enum JSMath {
    /// `Math.max(a, b)`.
    public static func max(_ a: Double, _ b: Double) -> Double {
        if a.isNaN || b.isNaN { return .nan }
        if a == 0 && b == 0 { return (a.sign == .minus && b.sign == .minus) ? -0.0 : 0.0 }
        return a > b ? a : b
    }

    /// `Math.min(a, b)`.
    public static func min(_ a: Double, _ b: Double) -> Double {
        if a.isNaN || b.isNaN { return .nan }
        if a == 0 && b == 0 { return (a.sign == .minus || b.sign == .minus) ? -0.0 : 0.0 }
        return a < b ? a : b
    }

    /// `Math.round(x)`: the nearest integer, a tie going towards +Infinity.
    ///
    /// Built on `floor` and the exact difference `x - floor(x)` rather than
    /// `floor(x + 0.5)`, because the addition itself rounds: for
    /// 0.49999999999999994, `x + 0.5` is exactly 1.0 in binary and the
    /// "obvious" formula answers 1 where JavaScript answers 0.
    public static func round(_ x: Double) -> Double {
        if !x.isFinite || x == 0 { return x }
        let down = x.rounded(.down)
        let result = (x - down >= 0.5) ? down + 1 : down
        // -0.5 <= x < 0 rounds to -0 in JavaScript, not to +0.
        return (result == 0 && x < 0) ? -0.0 : result
    }
}
