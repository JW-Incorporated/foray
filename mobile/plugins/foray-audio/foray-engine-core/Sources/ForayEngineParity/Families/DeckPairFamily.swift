import Foundation
import ForayEngineCore

/// deck-pair.json (player/deck-policy.js, recorded by NE-30j; card NE-32
/// ports it): the warm handover's decisions, which the native DeckPair asks
/// exactly as reference-engine.js's WarmingBackend does. Registered on the
/// `deck` family's module route beside the single-deck readings.
///
/// Every reader names the JavaScript it stands for. A value the typed port
/// has no parameter for (a url that is a number, an offset that is a string)
/// fails the case as `E_BAD_CASE` rather than guessing (ArgReading's rule).
enum DeckPairFamily {
    static let calls: [String: ([JSValue]) throws -> CallOutcome] = [
        "warmOffset": DeckPairFamily.warmOffset,
        "prefetchDecision": DeckPairFamily.prefetchDecision,
        "warmSettled": DeckPairFamily.warmSettled,
        "warmPromotion": DeckPairFamily.warmPromotion,
        "handoverSteps": DeckPairFamily.handoverSteps,
        "discardFreesBuffer": DeckPairFamily.discardFreesBuffer,
        "playRefusalAction": DeckPairFamily.playRefusalAction,
        "unexplainedPauseAction": DeckPairFamily.unexplainedPauseAction,
        "prefetchWindowOpens": DeckPairFamily.prefetchWindowOpens
    ]

    private static func param(_ args: [JSValue]) -> JSValue? {
        ArgReading.objectParam(ArgReading.arg(args, 0), hasDefault: false)
    }

    private static func number(_ value: JSValue, _ what: String) throws -> Double {
        guard let number = value.numberValue else { throw ArgReading.notRepresentable(what, value) }
        return number
    }

    /// A url the JS compares with `===` after a truthiness check: nil when
    /// falsy, a string otherwise.
    private static func url(_ value: JSValue, _ what: String) throws -> String? {
        guard value.isTruthy else { return nil }
        guard let text = value.stringValue else { throw ArgReading.notRepresentable(what, value) }
        return text
    }

    /// `warm` as the JS reads it: `{url, offset, ready, failed}`, or nil when
    /// falsy (`warm = null`, `if (!warm)`).
    private static func warm(_ value: JSValue, _ what: String) throws -> DeckPolicy.Warm? {
        guard value.isTruthy else { return nil }
        guard let url = value["url"].stringValue else { throw ArgReading.notRepresentable("\(what).url", value["url"]) }
        return DeckPolicy.Warm(itemId: "", url: url, offsetSec: try number(value["offset"], "\(what).offset"),
                               ready: value["ready"].isTruthy, failed: value["failed"].isTruthy)
    }

    /// `warmOffset(startOffset)`: `Number.isFinite(x) && x > 0 ? x : 0`.
    static func warmOffset(_ args: [JSValue]) throws -> CallOutcome {
        .returned(.number(DeckPolicy.warmOffset(ArgReading.arg(args, 0).numberValue)))
    }

    /// `prefetchDecision({available, url, currentUrl, warm = null, offsetSec = 0})`.
    static func prefetchDecision(_ args: [JSValue]) throws -> CallOutcome {
        guard let s = param(args) else { return .threw("TypeError") }
        let offset: Double = try s["offsetSec"] == .undefined ? 0 : number(s["offsetSec"], "prefetchDecision's offsetSec")
        let answer = DeckPolicy.prefetchDecision(
            available: s["available"].isTruthy, url: try url(s["url"], "prefetchDecision's url"),
            currentUrl: s["currentUrl"].stringValue, warm: try warm(s["warm"], "prefetchDecision's warm"),
            offsetSec: offset)
        return .returned(.string(answer.rawValue))
    }

    /// `warmSettled({offsetSec, atSec, canPlay})`: `atSec ?? 0`, `canPlay === true`.
    static func warmSettled(_ args: [JSValue]) throws -> CallOutcome {
        guard let s = param(args) else { return .threw("TypeError") }
        return .returned(.bool(DeckPolicy.warmSettled(
            offsetSec: try number(s["offsetSec"], "warmSettled's offsetSec"),
            atSec: try ArgReading.optionalNumber(s["atSec"], "warmSettled's atSec"),
            canPlay: s["canPlay"] == .bool(true))))
    }

    /// `warmPromotion({warm, url, offsetSec, canPlay, atSec})`.
    static func warmPromotion(_ args: [JSValue]) throws -> CallOutcome {
        guard let s = param(args) else { return .threw("TypeError") }
        let answer = DeckPolicy.warmPromotion(
            warm: try warm(s["warm"], "warmPromotion's warm"), url: s["url"].stringValue,
            offsetSec: try number(s["offsetSec"], "warmPromotion's offsetSec"),
            canPlay: s["canPlay"] == .bool(true),
            atSec: try ArgReading.optionalNumber(s["atSec"], "warmPromotion's atSec"))
        return .returned(.string(answer.rawValue))
    }

    /// `handoverSteps()`.
    static func handoverSteps(_ args: [JSValue]) throws -> CallOutcome {
        .returned(.array(DeckPolicy.handoverSteps().map { JSValue.string($0.rawValue) }))
    }

    /// `discardFreesBuffer(cause)`: `cause === "release"`.
    static func discardFreesBuffer(_ args: [JSValue]) throws -> CallOutcome {
        .returned(.bool(DeckPolicy.discardFreesBuffer(ArgReading.arg(args, 0).stringValue)))
    }

    /// `playRefusalAction({errorName, handoverUnproven, isPlayer = true, released = false})`.
    static func playRefusalAction(_ args: [JSValue]) throws -> CallOutcome {
        guard let s = param(args) else { return .threw("TypeError") }
        let isPlayer = s["isPlayer"] == .undefined ? true : s["isPlayer"].isTruthy
        let answer = DeckPolicy.playRefusalAction(
            errorName: s["errorName"].stringValue, handoverUnproven: s["handoverUnproven"].isTruthy,
            isPlayer: isPlayer, released: s["released"].isTruthy)
        return .returned(.string(answer.rawValue))
    }

    /// `unexplainedPauseAction({expected, ended, warmInFlight})`.
    static func unexplainedPauseAction(_ args: [JSValue]) throws -> CallOutcome {
        guard let s = param(args) else { return .threw("TypeError") }
        let answer = DeckPolicy.unexplainedPauseAction(
            expected: s["expected"].isTruthy, ended: s["ended"].isTruthy, warmInFlight: s["warmInFlight"].isTruthy)
        return .returned(.string(answer.rawValue))
    }

    /// `prefetchWindowOpens({available, outPointSec, armed, paused, atSec, rate, leadSec, alreadyOpened = false})`.
    static func prefetchWindowOpens(_ args: [JSValue]) throws -> CallOutcome {
        guard let s = param(args) else { return .threw("TypeError") }
        return .returned(.bool(DeckPolicy.prefetchWindowOpens(
            available: s["available"].isTruthy,
            outPointSec: try ArgReading.optionalNumber(s["outPointSec"], "prefetchWindowOpens's outPointSec"),
            armed: s["armed"].isTruthy, paused: s["paused"].isTruthy,
            atSec: try number(s["atSec"], "prefetchWindowOpens's atSec"),
            rate: s["rate"].numberValue,
            leadSec: try number(s["leadSec"], "prefetchWindowOpens's leadSec"),
            alreadyOpened: s["alreadyOpened"].isTruthy)))
    }
}
