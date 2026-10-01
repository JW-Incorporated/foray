import Foundation
import ForayEngineCore

/// The `route-resume` family against `RouteResume` (ForayEngineCore/Policy),
/// card NE-38rs, from the cases `player/route-resume.js` recorded (NE-38rj).
///
/// THE ONE JOB HERE IS TRANSLATION, NEVER DECISION (as in SeamGapFamily). The
/// JS reads each value this way, and each mapping below is that line of JS:
///
///   `({pausedBy, ...} = {})`            no argument is `{}`; null THROWS
///   `pausedBy !== "route"`              only the string "route" is a route pause
///   `!lost || !nonEmpty(lost.key)`      a falsy side is no route; only a
///                                       non-empty STRING is a key
///   `routeClass(back.port)`             only a string can be a car's port
///   `known !== true`                    strict: only a real true is known
///   `Number.isFinite(lostAgoSec)`       only a number is an age
///   `(bluetoothArm ?? DEFAULT) !== true` null and undefined are the default,
///                                       and only a real true arms it
///   `event?.on`                         anything but the six events THROWS
///   `event.atSec - s.lost.atSec`        only numbers make an age (a fixture
///                                       never spells one otherwise)
public enum RouteResumeFamily {
    public static let module = "player/route-resume.js"

    public static let runner = PureFamilyRunner(
        family: "route-resume",
        module: RouteResumeFamily.module,
        reads: [
            "ROUTE_RESUME_MAX_LOST_SEC": .number(RouteResume.maxLostSec),
            "ROUTE_RESUME_BLUETOOTH_DEFAULT": .bool(RouteResume.bluetoothDefault)
        ],
        calls: [
            "routeClass": { args in .returned(.string(RouteResume.routeClass(ArgReading.arg(args, 0).stringValue).rawValue)) },
            "routeKey": { args in
                let key = RouteResume.routeKey(portType: ArgReading.arg(args, 0).stringValue,
                                               uid: ArgReading.arg(args, 1).stringValue)
                return .returned(key.map { JSValue.string($0) } ?? .null)
            },
            "routeResumeDecision": RouteResumeFamily.decision,
            "routeResumeReplay": RouteResumeFamily.replay
        ])

    /// A route side: falsy is none; otherwise its `port` and `key`, strings only.
    static func route(_ value: JSValue) -> RouteResume.Route? {
        guard value.isTruthy else { return nil }
        return RouteResume.Route(port: value["port"].stringValue, key: value["key"].stringValue)
    }

    /// `bluetoothArm`: nullish is "use the default", anything else is on
    /// only when it is `true`.
    static func arm(_ value: JSValue) -> Bool? {
        value.isNullish ? nil : value == .bool(true)
    }

    static func decision(_ args: [JSValue]) throws -> CallOutcome {
        guard let p = ArgReading.objectParam(ArgReading.arg(args, 0), hasDefault: true) else { return .threw("TypeError") }
        let made = RouteResume.decision(pausedBy: p["pausedBy"].stringValue, lost: route(p["lost"]), back: route(p["back"]),
                                        known: p["known"] == .bool(true), lostAgoSec: p["lostAgoSec"].numberValue,
                                        bluetoothArm: arm(p["bluetoothArm"]))
        return .returned(encode(made))
    }

    static func encode(_ decision: RouteResume.Decision) -> JSValue {
        .object(["resume": .bool(decision.resume), "why": .string(decision.why)])
    }

    /// One event as `routeResumeStep` reads it, or nil for one it throws on.
    static func event(_ value: JSValue) -> RouteResume.Event? {
        switch value["on"].stringValue {
        case "lost"?:
            return .lost(port: value["port"].stringValue, key: value["key"].stringValue, atSec: value["atSec"].numberValue)
        case "back"?:
            return .back(port: value["port"].stringValue, key: value["key"].stringValue,
                         known: value["known"] == .bool(true), atSec: value["atSec"].numberValue)
        case "press"?: return .press(command: value["command"].stringValue)
        case "interruption"?: return .interruption
        case "system"?: return .system
        case "playing"?: return .playing
        default: return nil
        }
    }

    /// `routeResumeReplay(events, {bluetoothArm = DEFAULT, playing = true} = {})`.
    static func replay(_ args: [JSValue]) throws -> CallOutcome {
        guard case let .array(items) = ArgReading.arg(args, 0) else { return .threw("TypeError") }
        guard let opts = ArgReading.objectParam(ArgReading.arg(args, 1), hasDefault: true) else { return .threw("TypeError") }
        var events: [RouteResume.Event] = []
        for item in items {
            guard let event = event(item) else { return .threw("TypeError") }
            events.append(event)
        }
        let playingOpt = opts["playing"]
        let playing = playingOpt == .undefined ? true : playingOpt == .bool(true)
        let result = RouteResume.replay(events, bluetoothArm: arm(opts["bluetoothArm"]), playing: playing)
        let decisions: [JSValue] = result.decisions.map {
            .object(["event": .number(Double($0.event)), "resume": .bool($0.decision.resume),
                     "why": .string($0.decision.why)])
        }
        return .returned(.object(["decisions": .array(decisions), "resumes": .number(Double(result.resumes))]))
    }
}
