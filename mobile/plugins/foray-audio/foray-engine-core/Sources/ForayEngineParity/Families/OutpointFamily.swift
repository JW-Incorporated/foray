import Foundation
import ForayEngineCore

/// The `outpoint` family against DeckPolicy's native out-point
/// (ForayEngineCore/Policy/DeckPolicyOutPoint.swift), card NE-28s, from the
/// cases NE-28j recorded:
///
///   - `outpoint-policy.json` (module `player/deck-policy.js`): the constants,
///     `watchdogDelayMs`, `watchdogWakeAction`, `outPointOvershootMs` and
///     `initialOutPointWatch`, as pure calls;
///   - `outpoint-watch.json` (scenarios, `setup.target: "deck"`):
///     `outPointStep` over a DRIVEN CLOCK, the Swift twin of runner.js
///     `runDeckScenario`.
///
/// THE DRIVER IS runner.js's, LINE FOR LINE. It owns the wall clock and the
/// playhead (kept in whole ms of content, so a long clock accumulates no
/// floating-point error), moves the playhead by `elapsed x rate` while the
/// deck plays and is not stalled, and delivers the watchdog's one timer at the
/// moment it comes due, with the playhead where it really is by then. The op
/// log is the reducer's ops, in order; nothing else writes to it.
public enum OutpointFamily {
    public static let module = "player/deck-policy.js"

    public static let runner: FamilyRunner = OutpointRunner(pure: PureFamilyRunner(
        family: "outpoint",
        module: OutpointFamily.module,
        reads: [
            "OUT_POINT_WATCHDOG_WINDOW_SEC": .number(DeckPolicy.outPointWatchdogWindowSec),
            "OUT_POINT_WATCHDOG_POLL_MS": .number(DeckPolicy.outPointWatchdogPollMs),
            "OUT_POINT_LAYER": .object([
                "END_TIME": .string(DeckPolicy.OutPointLayer.endTime.rawValue),
                "BOUNDARY": .string(DeckPolicy.OutPointLayer.boundary.rawValue),
                "WATCHDOG": .string(DeckPolicy.OutPointLayer.watchdog.rawValue)
            ]),
            "WATCHDOG_WAKE": .object([
                "STOP": .string(DeckPolicy.WatchdogWake.stop.rawValue),
                "REARM": .string(DeckPolicy.WatchdogWake.rearm.rawValue)
            ])
        ],
        calls: [
            "watchdogDelayMs": OutpointFamily.watchdogDelayMs,
            "watchdogWakeAction": OutpointFamily.watchdogWakeAction,
            "outPointOvershootMs": OutpointFamily.outPointOvershootMs,
            "initialOutPointWatch": { _ in .returned(OutpointFamily.encode(DeckPolicy.OutPointWatch())) }
        ]))

    /// `watchdogDelayMs({ outPointSec, atSec, rate, armed = true, paused = false })`:
    /// no default for the object. `outPointSec` passes only as a number
    /// (`typeof`); `atSec` is compared and subtracted, both of which apply
    /// ToNumber; `rate` goes through `deckRate` (`typeof`).
    static func watchdogDelayMs(_ args: [JSValue]) throws -> CallOutcome {
        guard let s = ArgReading.objectParam(ArgReading.arg(args, 0), hasDefault: false) else { return .threw("TypeError") }
        let armed = s["armed"] == .undefined ? true : s["armed"].isTruthy
        let delay = DeckPolicy.watchdogDelayMs(outPointSec: s["outPointSec"].numberValue, atSec: s["atSec"].toNumber,
                                               rate: s["rate"].numberValue, armed: armed, paused: s["paused"].isTruthy)
        return .returned(ArgReading.numberOrNull(delay))
    }

    /// `watchdogWakeAction({ atSec, outPointSec })`: `atSec >= outPointSec`.
    /// Two strings would compare as strings there, so only numbers are taken.
    static func watchdogWakeAction(_ args: [JSValue]) throws -> CallOutcome {
        guard let s = ArgReading.objectParam(ArgReading.arg(args, 0), hasDefault: false) else { return .threw("TypeError") }
        let wake = DeckPolicy.watchdogWakeAction(atSec: try DeckEpisodeFamily.number(s["atSec"], "watchdogWakeAction's atSec"),
                                                 outPointSec: try DeckEpisodeFamily.number(s["outPointSec"], "watchdogWakeAction's outPointSec"))
        return .returned(.string(wake.rawValue))
    }

    /// `outPointOvershootMs({ atSec, outPointSec })`: a subtraction, so ToNumber.
    static func outPointOvershootMs(_ args: [JSValue]) throws -> CallOutcome {
        guard let s = ArgReading.objectParam(ArgReading.arg(args, 0), hasDefault: false) else { return .threw("TypeError") }
        return .returned(.number(DeckPolicy.outPointOvershootMs(atSec: s["atSec"].toNumber, outPointSec: s["outPointSec"].toNumber)))
    }

    /// `initialOutPointWatch()` and the watch as JS spells it.
    static func encode(_ watch: DeckPolicy.OutPointWatch) -> JSValue {
        .object([
            "token": .number(Double(watch.token)),
            "outPointSec": ArgReading.numberOrNull(watch.outPointSec),
            "armed": .bool(watch.armed),
            "fired": .bool(watch.fired),
            "playing": .bool(watch.playing),
            "rate": .number(watch.rate),
            "timerDueMs": ArgReading.numberOrNull(watch.timerDueMs)
        ])
    }
}

struct OutpointRunner: FamilyRunner {
    let family = "outpoint"
    let pure: PureFamilyRunner

    func run(_ testCase: FixtureCase, in file: FixtureFile, context: Codec.Context) throws -> JSONValue {
        guard testCase.kind == .scenario else { return try pure.run(testCase, in: file, context: context) }
        return try DeckWorld.run(testCase, context: context, family: family)
    }
}

extension DeckWorld {
    /// runner.js `runDeckScenario`: the steps over a fresh world, then `end`.
    static func run(_ testCase: FixtureCase, context: Codec.Context, family: String) throws -> JSONValue {
        guard let rawSetup = testCase.fields["setup"], let rawSteps = testCase.fields["steps"]?.arrayValue else {
            throw HarnessError("E_BAD_CASE", "case \(testCase.id) is not a scenario")
        }
        let setup = try Codec.expandInputs(rawSetup, context)
        guard setup["target"] == .string("deck") else {
            throw HarnessError("E_SCENARIO_TARGET", "the Swift \(family) family drives the deck target only, not \(setup["target"])")
        }
        let world = DeckWorld()
        if setup["rate"] != .undefined { world.dispatch(.rate(setup["rate"].numberValue, atSec: world.atSec, nowMs: world.nowMs)) }
        for (index, rawStep) in rawSteps.enumerated() {
            guard case let .object(fields) = rawStep else {
                throw HarnessError("E_BAD_CASE", "step \(index) of \(testCase.id) is not an object")
            }
            let verbs = fields.keys.filter { ScenarioWorld.verbs.contains($0) }
            guard verbs.count == 1, let verb = verbs.first else {
                throw HarnessError("E_UNKNOWN_VERB", "step \(index) of \(testCase.id) has no single known verb")
            }
            let step = JSValue(raw: rawStep)
            switch verb {
            case "deck": try world.deck(step, caseId: testCase.id)
            case "clock": try world.clock(step["clock"])
            case "checkpoint": world.checkpoint(step["checkpoint"].stringValue ?? "")
            default:
                throw HarnessError("E_BAD_CASE", "the deck target takes deck, clock and checkpoint steps, not \"\(verb)\"")
            }
        }
        world.checkpoint("end")
        return Codec.encode(.object(["checkpoints": .array(world.checkpoints), "ops": .array(world.log.map { .string($0) })]))
    }
}

/// runner.js `runDeckScenario`'s locals, as one object every step mutates.
final class DeckWorld {
    static let events = ["load", "play", "pause", "seek", "rate", "stall", "unstall", "endTime", "boundary", "ended"]

    var state = DeckPolicy.OutPointWatch()
    var nowMs: Double = 0
    var atMs: Double = 0
    var stalled = false
    var loads = 0
    var log: [String] = []
    var checkpoints: [JSValue] = []
    var mark = 0

    var atSec: Double { atMs / 1000 }

    /// `toMs(sec)`: whole ms of content.
    static func toMs(_ sec: Double) -> Double { JSMath.round(sec * 1000) }

    func dispatch(_ event: DeckPolicy.OutPointEvent) {
        let result = DeckPolicy.outPointStep(state, event)
        state = result.state
        log += result.ops.map(\.token)
    }

    func checkpoint(_ name: String) {
        checkpoints.append(.object([
            "name": .string(name),
            "ops": .array(log[mark...].map { .string($0) }),
            "nowMs": .number(nowMs),
            "atSec": .number(atSec),
            "armed": .bool(state.armed),
            "fired": .bool(state.fired),
            "playing": .bool(state.playing),
            "rate": .number(state.rate)
        ]))
        mark = log.count
    }

    func deck(_ step: JSValue, caseId: String) throws {
        let event = step["deck"].stringValue ?? ""
        switch event {
        case "load":
            loads += 1
            // `toMs(step.sec ?? 0)`; `step.outPointSec ?? null`, then the
            // reducer's own `typeof` check.
            atMs = DeckWorld.toMs(step["sec"].isNullish ? 0 : step["sec"].toNumber)
            dispatch(.load(token: loads, outPointSec: step["outPointSec"].numberValue, atSec: atSec))
        case "play":
            dispatch(.play(atSec: atSec, nowMs: nowMs))
        case "pause":
            dispatch(.pause(atSec: atSec))
        case "seek":
            guard let sec = step["sec"].numberValue else { throw HarnessError("E_BAD_CASE", "deck seek needs a numeric sec") }
            atMs = DeckWorld.toMs(sec)
            dispatch(.seek(atSec: atSec, nowMs: nowMs))
        case "rate":
            dispatch(.rate(step["rate"].numberValue, atSec: atSec, nowMs: nowMs))
        case "stall", "unstall":
            stalled = event == "stall"
        case "endTime", "boundary":
            guard loads > 0 else { throw HarnessError("E_BAD_CASE", "a \(event) report with nothing loaded") }
            if step["sec"] != .undefined { atMs = DeckWorld.toMs(step["sec"].toNumber) }
            let token: Int
            if step["token"].isNullish {
                token = loads
            } else if let number = step["token"].numberValue, number == number.rounded(), Swift.abs(number) < 1e15 {
                token = Int(number)
            } else {
                throw ArgReading.notRepresentable("\(caseId)'s \(event) token", step["token"])
            }
            let layer: DeckPolicy.OutPointLayer = event == "endTime" ? .endTime : .boundary
            dispatch(.layer(layer, token: token, atSec: atSec, nowMs: nowMs))
        case "ended":
            // NE-30j: the FILE ran out (an authored end past the real audio).
            guard loads > 0 else { throw HarnessError("E_BAD_CASE", "an end with nothing loaded") }
            if step["sec"] != .undefined { atMs = DeckWorld.toMs(step["sec"].toNumber) }
            dispatch(.ended(atSec: atSec))
        default:
            throw HarnessError("E_BAD_CASE", "unknown deck event \"\(event)\" (one of \(DeckWorld.events.joined(separator: ", ")))")
        }
    }

    /// `clock: ms`: advance the wall clock, delivering the watchdog's timer
    /// each time it comes due on the way.
    func clock(_ value: JSValue) throws {
        guard let ms = value.numberValue, ms.isFinite, ms == ms.rounded(), ms >= 0 else {
            throw HarnessError("E_BAD_CASE", "clock takes whole milliseconds")
        }
        let until = nowMs + ms
        while true {
            let due = state.timerDueMs
            let fires = due.map { $0 <= until } ?? false
            let to = fires ? due! : until
            if state.playing && !stalled { atMs += JSMath.round((to - nowMs) * state.rate) }
            nowMs = to
            if fires { dispatch(.timer(atSec: atSec, nowMs: nowMs)) } else { break }
        }
    }
}
