import Foundation

/// How a FamilyRunner reads a case's arguments the way the JS function's
/// parameter list reads them (NE-09). Shared by the rate, resume-rules and
/// transport runners; every helper names the line of JavaScript it stands for.
///
/// WHEN A VALUE CANNOT BE TRANSLATED, THE CASE FAILS. A typed Swift port has
/// no parameter for "the string '0', which is truthy but coerces to 0"; where
/// JavaScript would do something with such a value that a Double cannot carry,
/// these helpers throw `E_BAD_CASE` ("not representable") instead of picking an
/// answer. The case is then red in Swift ("cannot run"), which forces a person
/// to decide whether the port's signature or the case is wrong. A runner that
/// quietly guessed would be deciding the rule, which is the port's job.
enum ArgReading {
    /// The i-th argument; a missing one is `undefined`, as in JavaScript.
    static func arg(_ args: [JSValue], _ index: Int) -> JSValue {
        index < args.count ? args[index] : .undefined
    }

    /// A destructured object parameter. `({a, b} = {})` gives a missing
    /// argument `{}`; `({a, b})` has no default. Destructuring null or
    /// undefined THROWS a TypeError before the body runs, so nil here means
    /// "answer .threw(TypeError)". A primitive destructures to all-undefined
    /// fields, which `JSValue`'s subscript already gives.
    static func objectParam(_ value: JSValue, hasDefault: Bool) -> JSValue? {
        if value == .undefined && hasDefault { return .object([:]) }
        return value.isNullish ? nil : value
    }

    static func notRepresentable(_ what: String, _ value: JSValue) -> HarnessError {
        HarnessError("E_BAD_CASE", "\(what) is \(value), which the typed Swift port has no parameter for")
    }

    /// A value the JS reads as "a number, or null/undefined for none" and
    /// then does arithmetic with or passes through.
    static func optionalNumber(_ value: JSValue, _ what: String) throws -> Double? {
        switch value {
        case .undefined, .null: return nil
        case let .number(number): return number
        default: throw notRepresentable(what, value)
        }
    }

    /// A value the JS reads by TRUTHINESS first and then as a number
    /// (`Number(x || 0)`, `dur ? dur - 1 : ...`). The port takes a Double?
    /// and treats nil, 0 and NaN as falsy, so: a falsy value is nil, a number
    /// is itself, and a truthy non-number is its ToNumber, unless that is 0 or
    /// NaN (truthy in JS, falsy in the port: not representable).
    static func truthyNumber(_ value: JSValue, _ what: String) throws -> Double? {
        if !value.isTruthy { return nil }
        if let number = value.numberValue { return number }
        let coerced = value.toNumber
        guard coerced != 0 && !coerced.isNaN else { throw notRepresentable(what, value) }
        return coerced
    }

    /// A value compared with `=== true` / `=== false` or with another value
    /// strictly: only a real boolean is one.
    static func strictBool(_ value: JSValue, _ what: String) throws -> Bool {
        guard case let .bool(flag) = value else { throw notRepresentable(what, value) }
        return flag
    }

    /// `x === "ended"` and friends: a value that is not a string is never equal
    /// to one, and nil stands for it.
    static func string(_ value: JSValue) -> String? {
        value.stringValue
    }

    /// A Double? result: a number, or null.
    static func numberOrNull(_ value: Double?) -> JSValue {
        value.map { .number($0) } ?? .null
    }
}
