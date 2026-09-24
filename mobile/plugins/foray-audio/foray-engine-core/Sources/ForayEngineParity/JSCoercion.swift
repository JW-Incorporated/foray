import Foundation

/// JavaScript's value-to-type conversions, for FamilyRunners translating a
/// case's untyped arguments into a typed Swift port's parameters (NE-09).
///
/// A JS rule sometimes reads an argument through the language's coercions:
/// `Number(seconds)` (clampEpisodeTarget), `x - item.start_sec`
/// (previousAction), `lastEmitted ?? 0`. The Swift port takes a Double, so the
/// runner has to do the conversion JavaScript would have done, and do it
/// EXACTLY: a runner that coerced `null` to NaN where JS gives 0 would move a
/// case's answer without either side's rule changing. These are the ECMA-262
/// abstract operations, restricted to the values a fixture can build (no
/// Symbol, no BigInt, no objects with their own valueOf).
public extension JSValue {
    /// ECMA-262 ToNumber: `Number(v)`, and what arithmetic does to an operand.
    var toNumber: Double {
        switch self {
        case .undefined: return .nan
        case .null: return 0
        case let .bool(flag): return flag ? 1 : 0
        case let .number(value): return value
        case let .string(text): return JSCoercion.stringToNumber(text)
        case let .array(items):
            // ToPrimitive(array) is `array.join(",")`: [] is "", [x] is String(x),
            // and two or more elements always hold a comma, which is NaN.
            switch items.count {
            case 0: return 0
            case 1:
                switch items[0] {
                case .undefined, .null: return 0
                case let .number(value): return value
                case let .string(text): return JSCoercion.stringToNumber(text)
                case let .bool(flag): return JSCoercion.stringToNumber(flag ? "true" : "false")
                case .array: return items[0].toNumber
                case .object: return .nan
                }
            default: return .nan
            }
        case .object:
            // "[object Object]".
            return .nan
        }
    }
}

public enum JSCoercion {
    /// ECMA-262 StringToNumber: trim white space and line terminators; "" is
    /// 0; a decimal literal (optionally signed, optionally `Infinity`); an
    /// unsigned 0x / 0o / 0b integer; anything else is NaN. Swift's
    /// `Double(String)` alone is NOT this: it accepts "nan", "inf" and hex
    /// floats, and refuses surrounding white space.
    public static func stringToNumber(_ text: String) -> Double {
        let space = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{FEFF}"))
        let trimmed = text.trimmingCharacters(in: space)
        if trimmed.isEmpty { return 0 }
        for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)]
        where trimmed.hasPrefix(prefix) {
            let digits = trimmed.dropFirst(2)
            guard !digits.isEmpty else { return .nan }
            var value = 0.0
            for ch in digits {
                guard let digit = ch.hexDigitValue, digit < radix else { return .nan }
                value = value * Double(radix) + Double(digit)
            }
            return value
        }
        var body = Substring(trimmed)
        var sign = 1.0
        if let first = body.first, first == "+" || first == "-" {
            if first == "-" { sign = -1 }
            body = body.dropFirst()
        }
        if body == "Infinity" { return sign * .infinity }
        // StrUnsignedDecimalLiteral: digits [. digits] [e [sign] digits], or
        // . digits [...]; at least one digit before the exponent.
        var sawDigit = false
        var index = body.startIndex
        func skipDigits() {
            while index < body.endIndex, body[index].isASCII, body[index].isNumber {
                sawDigit = true
                index = body.index(after: index)
            }
        }
        skipDigits()
        if index < body.endIndex, body[index] == "." {
            index = body.index(after: index)
            skipDigits()
        }
        guard sawDigit else { return .nan }
        if index < body.endIndex, body[index] == "e" || body[index] == "E" {
            index = body.index(after: index)
            if index < body.endIndex, body[index] == "+" || body[index] == "-" { index = body.index(after: index) }
            let exponentStart = index
            while index < body.endIndex, body[index].isASCII, body[index].isNumber { index = body.index(after: index) }
            if index == exponentStart { return .nan }
        }
        guard index == body.endIndex, let magnitude = Double(String(body)) else { return .nan }
        return sign * magnitude
    }
}
