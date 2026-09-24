import Foundation
import ForayEngineCore

/// The `resume-rules` family against `ResumeRules` (ForayEngineCore/Policy).
///
/// The family spans THREE JS modules, one fixture file each (a file names
/// one module): position-store.js (where to resume, the row, the position
/// event), queue-manager.js (the 15 s interval and the 10-media-second tick
/// throttle) and foray-progress.js (the Foray's 5 s throttle). So its runner
/// is a `MultiModuleFamilyRunner` over three tables, and a file that moved to
/// a fourth module is refused rather than run against the wrong port.
///
/// TRANSLATION ONLY: each mapping below is the JS parameter list it stands
/// for (see `ArgReading`), and every decision is the port's.
public enum ResumeRulesFamily {
    public static let positionStoreModule = "player/position-store.js"
    public static let queueManagerModule = "player/queue-manager.js"
    public static let forayProgressModule = "player/foray-progress.js"

    public static let runner = MultiModuleFamilyRunner(family: "resume-rules", parts: [
        PureFamilyRunner(
            family: "resume-rules",
            module: ResumeRulesFamily.positionStoreModule,
            reads: [
                "MIN_RESUME_SEC": .number(ResumeRules.minResumeSec),
                "NEAR_END_SEC": .number(ResumeRules.nearEndSec),
                "POSITION_EVENT_EVERY_SEC": .number(ResumeRules.positionEventEverySec)
            ],
            calls: [
                "resumeOffsetFor": ResumeRulesFamily.resumeOffsetFor,
                "positionRow": ResumeRulesFamily.positionRow,
                "positionEvent": ResumeRulesFamily.positionEvent
            ]),
        PureFamilyRunner(
            family: "resume-rules",
            module: ResumeRulesFamily.queueManagerModule,
            reads: [
                "POSITION_INTERVAL_MS": .number(ResumeRules.positionIntervalMs),
                "POSITION_MIN_DELTA_SEC": .number(ResumeRules.positionMinDeltaSec)
            ],
            calls: ["positionTickDue": ResumeRulesFamily.positionTickDue]),
        PureFamilyRunner(
            family: "resume-rules",
            module: ResumeRulesFamily.forayProgressModule,
            reads: ["SAVE_EVERY_SEC": .number(ResumeRules.forayWriteEverySec)],
            calls: ["forayWriteDue": ResumeRulesFamily.forayWriteDue])
    ])

    /// `resumeOffsetFor(record, { duration = null } = {})`.
    static func resumeOffsetFor(_ args: [JSValue]) throws -> CallOutcome {
        // The parameter list is destructured before the body runs: a null
        // `opts` throws even when there is no record.
        guard let opts = ArgReading.objectParam(ArgReading.arg(args, 1), hasDefault: true) else {
            return .threw("TypeError")
        }
        let callerDuration = try ArgReading.optionalNumber(opts["duration"], "resumeOffsetFor's opts.duration")
        let recordArg = ArgReading.arg(args, 0)
        var record: ResumeRules.StoredPosition?
        if recordArg.isTruthy { // `if (!record) return 0`
            // A row reaches this rule through `load`, which admits only a
            // finite-number `seconds`; `duration` is read raw.
            guard let seconds = recordArg["seconds"].numberValue else {
                throw ArgReading.notRepresentable("resumeOffsetFor's record.seconds", recordArg["seconds"])
            }
            let rowDuration = try ArgReading.optionalNumber(recordArg["duration"], "resumeOffsetFor's record.duration")
            record = ResumeRules.StoredPosition(seconds: seconds, duration: rowDuration)
        }
        return .returned(.number(ResumeRules.resumeOffset(for: record, duration: callerDuration)))
    }

    /// `positionRow(id, seconds, meta = {}, updatedAt)`.
    static func positionRow(_ args: [JSValue]) throws -> CallOutcome {
        let idArg = ArgReading.arg(args, 0)
        let id: String
        if case let .string(text) = idArg {
            id = text
        } else if !idArg.isTruthy {
            id = "" // `!id`: every falsy id is refused, as the empty string is
        } else {
            throw ArgReading.notRepresentable("positionRow's id", idArg)
        }
        // `typeof seconds !== "number"` -> no row: nil, which the port refuses.
        let seconds = ArgReading.arg(args, 1).numberValue
        let updatedAt: String?
        switch ArgReading.arg(args, 3) {
        case .undefined: updatedAt = nil
        case let .string(text): updatedAt = text
        case let other: throw ArgReading.notRepresentable("positionRow's updatedAt", other)
        }
        var meta = ArgReading.arg(args, 2)
        if meta == .undefined { meta = .object([:]) }
        if meta == .null {
            // The gate runs first; only a row that passes it reads
            // `meta.duration`, which throws on null.
            let gated = ResumeRules.positionRow(id: id, seconds: seconds, duration: nil, updatedAt: updatedAt)
            return gated == nil ? .returned(.null) : .threw("TypeError")
        }
        guard let row = ResumeRules.positionRow(id: id, seconds: seconds, duration: meta["duration"].numberValue,
                                                updatedAt: updatedAt) else {
            return .returned(.null)
        }
        var fields: [String: JSValue] = [
            "seconds": .number(row.seconds),
            "duration": ArgReading.numberOrNull(row.duration),
            "source": .string(row.source)
        ]
        if let stamp = row.updatedAt { fields["updated_at"] = .string(stamp) }
        return .returned(.object(fields))
    }

    /// `positionEvent(lastEmitted, seconds, duration)`. `lastEmitted ?? 0` is
    /// then compared with `=== 0`, so only a number (or nothing) is
    /// representable; `duration` is passed through into the event.
    static func positionEvent(_ args: [JSValue]) throws -> CallOutcome {
        let last = try ArgReading.optionalNumber(ArgReading.arg(args, 0), "positionEvent's lastEmitted")
        guard let seconds = ArgReading.arg(args, 1).numberValue else {
            throw ArgReading.notRepresentable("positionEvent's seconds", ArgReading.arg(args, 1))
        }
        let durationArg = ArgReading.arg(args, 2)
        guard durationArg == .null || durationArg.numberValue != nil else {
            // undefined would come back as a DROPPED key, which a Double? cannot say.
            throw ArgReading.notRepresentable("positionEvent's duration", durationArg)
        }
        guard let event = ResumeRules.positionEvent(lastEmitted: last, seconds: seconds,
                                                    duration: durationArg.numberValue) else {
            return .returned(.null)
        }
        return .returned(.object([
            "mark": .number(event.mark),
            "seconds": .number(event.seconds),
            "duration": ArgReading.numberOrNull(event.duration)
        ]))
    }

    /// `positionTickDue(last, id, seconds)`: `last && last.id === id &&
    /// Math.abs(seconds - last.seconds) < ...`, after `typeof seconds`.
    static func positionTickDue(_ args: [JSValue]) throws -> CallOutcome {
        guard case let .string(id) = ArgReading.arg(args, 1) else {
            throw ArgReading.notRepresentable("positionTickDue's id", ArgReading.arg(args, 1))
        }
        let lastArg = ArgReading.arg(args, 0)
        let last: ResumeRules.LastWrite? = lastArg.isTruthy
            // `last.id === id` against a string id: a non-string never matches
            // (nil); `seconds - last.seconds` is arithmetic (ToNumber).
            ? ResumeRules.LastWrite(id: lastArg["id"].stringValue, seconds: lastArg["seconds"].toNumber)
            : nil
        let due = ResumeRules.positionTickDue(last: last, id: id, seconds: ArgReading.arg(args, 2).numberValue)
        return .returned(.bool(due))
    }

    /// `forayWriteDue(lastWritten, elapsedSec, { everySec = SAVE_EVERY_SEC, force = false } = {})`.
    static func forayWriteDue(_ args: [JSValue]) throws -> CallOutcome {
        guard let opts = ArgReading.objectParam(ArgReading.arg(args, 2), hasDefault: true) else {
            return .threw("TypeError")
        }
        let everySec = opts["everySec"] == .undefined ? ResumeRules.forayWriteEverySec : opts["everySec"].toNumber
        let force = opts["force"].isTruthy // `force = false`, then `if (force ...)`
        let lastArg = ArgReading.arg(args, 0)
        // `lastWritten == null`, then `elapsedSec - lastWritten` (ToNumber).
        let last: Double? = lastArg.isNullish ? nil : lastArg.toNumber
        let due = ResumeRules.forayWriteDue(lastWritten: last, elapsedSec: ArgReading.arg(args, 1).numberValue,
                                            everySec: everySec, force: force)
        return .returned(.bool(due))
    }
}
