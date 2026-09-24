import Foundation
import ForayEngineCore

/// The `deck-episode` family against `DeckPolicy` (ForayEngineCore/Policy),
/// card NE-14s, from the cases `player/deck-policy.js` recorded (NE-14j).
///
/// THE ONE JOB HERE IS TRANSLATION, NEVER DECISION (as in TransportFamily).
/// Every deck-policy.js function takes ONE destructured object, so a null or
/// missing argument throws a TypeError before the rule runs (except
/// `loadDeadlineMs`, whose object defaults to `{}`). Each field is then read
/// the way its line of JS reads it:
///
///   `outPointSec == null`, `boundarySec != null`   loose: null and undefined
///                                                  are "none"; anything else
///                                                  must be a number
///   `!armed`, `paused`, `superseded`, `stopped`,   truthiness
///   `!failed`
///   `armed = true`, `lastWakeAtSec = null`,        the destructuring default
///   `pinnedMs = null`, `hidden = false`            applies to undefined only
///   `hidden === true`, `hasMetadata === true`      strict: only a real true
///   `deckRate(rate)`                               `typeof rate === "number"`
///   `atSec - outPointSec`, `atSec < ...`           arithmetic and comparison:
///                                                  the port takes numbers, and
///                                                  a case handing it anything
///                                                  else is not representable
public enum DeckEpisodeFamily {
    public static let module = "player/deck-policy.js"

    public static let runner = PureFamilyRunner(
        family: "deck-episode",
        module: DeckEpisodeFamily.module,
        reads: [
            "OUT_POINT_ARM_LEAD_SEC": .number(DeckPolicy.outPointArmLeadSec),
            "OUT_POINT_MIN_TIMER_MS": .number(DeckPolicy.outPointMinTimerMs),
            "LOAD_SETTLE_TIMEOUT_MS": .number(DeckPolicy.loadSettleTimeoutMs),
            "LOAD_SETTLE_TIMEOUT_HIDDEN_MS": .number(DeckPolicy.loadSettleTimeoutHiddenMs),
            "SETTLE_NEAR_SEC": .number(DeckPolicy.settleNearSec)
        ],
        calls: [
            "fineWatchDelayMs": DeckEpisodeFamily.fineWatchDelayMs,
            "fineWakeAction": DeckEpisodeFamily.fineWakeAction,
            "outPointArmed": DeckEpisodeFamily.outPointArmed,
            "loadDeadlineMs": DeckEpisodeFamily.loadDeadlineMs,
            "sameSourceIsSeek": DeckEpisodeFamily.sameSourceIsSeek,
            "settledNear": DeckEpisodeFamily.settledNear,
            "recoveryLoadedOps": DeckEpisodeFamily.recoveryLoadedOps,
            "recoveryFailedOps": DeckEpisodeFamily.recoveryFailedOps
        ])

    /// The one object parameter with no default, or nil for "throws a TypeError".
    static func param(_ args: [JSValue]) -> JSValue? {
        ArgReading.objectParam(ArgReading.arg(args, 0), hasDefault: false)
    }

    /// A field the JS does arithmetic or a `<` comparison with.
    static func number(_ value: JSValue, _ what: String) throws -> Double {
        guard let number = value.numberValue else { throw ArgReading.notRepresentable(what, value) }
        return number
    }

    /// A field read with `== null` / `!= null` and otherwise used as a number.
    static func looseNumber(_ value: JSValue, _ what: String) throws -> Double? {
        if value.isNullish { return nil }
        return try number(value, what)
    }

    static func tokens(_ ops: [DeckPolicy.Recovery]) -> CallOutcome {
        .returned(.array(ops.map { JSValue.string($0.rawValue) }))
    }

    /// `fineWatchDelayMs({ outPointSec, atSec, rate, armed = true, paused = false })`.
    static func fineWatchDelayMs(_ args: [JSValue]) throws -> CallOutcome {
        guard let s = param(args) else { return .threw("TypeError") }
        let armed = s["armed"] == .undefined ? true : s["armed"].isTruthy
        let delay = DeckPolicy.fineWatchDelayMs(outPointSec: try looseNumber(s["outPointSec"], "fineWatchDelayMs's outPointSec"),
                                                atSec: try number(s["atSec"], "fineWatchDelayMs's atSec"),
                                                rate: s["rate"].numberValue,
                                                armed: armed,
                                                paused: s["paused"].isTruthy)
        return .returned(ArgReading.numberOrNull(delay))
    }

    /// `fineWakeAction({ atSec, outPointSec, lastWakeAtSec = null })`:
    /// `lastWakeAtSec !== null` is strict, so an explicit null and a missing
    /// field are both "no previous wake"; anything else must be a number.
    static func fineWakeAction(_ args: [JSValue]) throws -> CallOutcome {
        guard let s = param(args) else { return .threw("TypeError") }
        let wake = DeckPolicy.fineWakeAction(atSec: try number(s["atSec"], "fineWakeAction's atSec"),
                                             outPointSec: try number(s["outPointSec"], "fineWakeAction's outPointSec"),
                                             lastWakeAtSec: try looseNumber(s["lastWakeAtSec"], "fineWakeAction's lastWakeAtSec"))
        return .returned(.string(wake.rawValue))
    }

    /// `outPointArmed({ atSec, outPointSec })`.
    static func outPointArmed(_ args: [JSValue]) throws -> CallOutcome {
        guard let s = param(args) else { return .threw("TypeError") }
        return .returned(.bool(DeckPolicy.outPointArmed(atSec: try number(s["atSec"], "outPointArmed's atSec"),
                                                        outPointSec: try number(s["outPointSec"], "outPointArmed's outPointSec"))))
    }

    /// `loadDeadlineMs({ pinnedMs = null, hidden = false } = {})`: the object
    /// has a default, `pinnedMs != null` is loose (and returned as given, so it
    /// must be a number), `hidden === true` is strict.
    static func loadDeadlineMs(_ args: [JSValue]) throws -> CallOutcome {
        guard let s = ArgReading.objectParam(ArgReading.arg(args, 0), hasDefault: true) else { return .threw("TypeError") }
        let hidden: Bool = { if case .bool(true) = s["hidden"] { return true }; return false }()
        let deadline = DeckPolicy.loadDeadlineMs(pinnedMs: try looseNumber(s["pinnedMs"], "loadDeadlineMs's pinnedMs"),
                                                 hidden: hidden)
        return .returned(.number(deadline))
    }

    /// `sameSourceIsSeek({ loadedUrl, url, hasMetadata, failed })`:
    /// `Boolean(loadedUrl) && loadedUrl === url && hasMetadata === true && !failed`.
    /// A falsy `loadedUrl` is "nothing loaded"; a truthy one must be a string,
    /// and `url` is compared strictly, so a non-string url never equals it.
    static func sameSourceIsSeek(_ args: [JSValue]) throws -> CallOutcome {
        guard let s = param(args) else { return .threw("TypeError") }
        let loaded = s["loadedUrl"]
        var loadedUrl: String?
        if loaded.isTruthy {
            guard let text = loaded.stringValue else {
                throw ArgReading.notRepresentable("sameSourceIsSeek's loadedUrl", loaded)
            }
            loadedUrl = text
        }
        let hasMetadata: Bool = { if case .bool(true) = s["hasMetadata"] { return true }; return false }()
        return .returned(.bool(DeckPolicy.sameSourceIsSeek(loadedUrl: loadedUrl, url: s["url"].stringValue,
                                                           hasMetadata: hasMetadata, failed: s["failed"].isTruthy)))
    }

    /// `settledNear({ atSec, targetSec })`.
    static func settledNear(_ args: [JSValue]) throws -> CallOutcome {
        guard let s = param(args) else { return .threw("TypeError") }
        return .returned(.bool(DeckPolicy.settledNear(atSec: try number(s["atSec"], "settledNear's atSec"),
                                                      targetSec: try number(s["targetSec"], "settledNear's targetSec"))))
    }

    /// `recoveryLoadedOps({ superseded, stopped, boundarySec })`.
    static func recoveryLoadedOps(_ args: [JSValue]) throws -> CallOutcome {
        guard let s = param(args) else { return .threw("TypeError") }
        return tokens(DeckPolicy.recoveryLoadedOps(superseded: s["superseded"].isTruthy,
                                                   stopped: s["stopped"].isTruthy,
                                                   boundarySec: try looseNumber(s["boundarySec"], "recoveryLoadedOps's boundarySec")))
    }

    /// `recoveryFailedOps({ superseded, stopped })`.
    static func recoveryFailedOps(_ args: [JSValue]) throws -> CallOutcome {
        guard let s = param(args) else { return .threw("TypeError") }
        return tokens(DeckPolicy.recoveryFailedOps(superseded: s["superseded"].isTruthy, stopped: s["stopped"].isTruthy))
    }
}
