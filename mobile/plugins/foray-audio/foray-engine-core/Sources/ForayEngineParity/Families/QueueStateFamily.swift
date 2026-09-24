import Foundation
import ForayEngineCore

/// The `queue-state` family against `PlayerQueueState` (ForayEngineCore/
/// Reducer): card NE-07s, the reducer at parity with `player/queue-state.js`.
///
/// The fixtures (recorded by NE-07j) are `reduce(state, event)` and
/// `itemBounds(bounds)` calls whose arguments and answers are the JS reducer's
/// own plain objects: `{type, ...}` for states, events and effects, and
/// `{id, kind, bounds}` for items. So this runner's whole job is a CODEC
/// between those objects and the Swift enums, in both directions.
///
/// DECODING IS STRICT, AND THAT IS DELIBERATE. The JS reducer would happily
/// read a malformed object (a missing `bounds`, a `precise` of "yes", an event
/// type it has never heard of); the typed port cannot even hold one. Guessing
/// a meaning here would be the runner DECIDING something the JS does not, so
/// every shape the Swift types cannot represent faithfully is refused as
/// `E_BAD_CASE` and reported, never quietly coerced. In particular a fixture
/// item's `bounds` must already be what `itemBounds` returns: the JS reducer
/// uses bounds as it finds them, while Swift's `ItemBounds` can only be built
/// normalised, and a case that relied on the difference would be pinning a
/// state `itemRef` can never produce.
///
/// ENCODING writes exactly the keys the JS constructors (`S.*`, `E.*`, `F.*`,
/// `itemRef`) write, nulls included: `loadingItem` always carries `previous`
/// and `pendingSeek`, an item always carries `bounds`. The comparator is exact
/// about absent versus null, so this is what "the same object" means.
public enum QueueStateFamily {
    public static let module = "player/queue-state.js"

    /// The reducer under test, as a value, so a test can hand the runner a
    /// deliberately broken one and watch a named case go red (NE-07s's
    /// mutation: swap two effects in itemLoaded). Production is always
    /// `PlayerQueueState.reduce`.
    public typealias Reduce = (PlayerQueueState, PlayerEvent) -> (PlayerQueueState, [PlayerEffect])

    public static let runner = makeRunner()

    public static func makeRunner(
        reduce: @escaping Reduce = { PlayerQueueState.reduce(state: $0, event: $1) }
    ) -> PureFamilyRunner {
        PureFamilyRunner(
            family: "queue-state",
            module: QueueStateFamily.module,
            reads: [:],
            calls: [
                "reduce": { args in
                    guard args.count == 2 else {
                        throw HarnessError("E_BAD_CASE", "reduce takes (state, event), got \(args.count) argument(s)")
                    }
                    let state = try decodeState(args[0])
                    let event = try decodeEvent(args[1])
                    let (next, effects) = reduce(state, event)
                    return .returned(.array([encode(next), .array(effects.map { encode($0) })]))
                },
                "itemBounds": { args in
                    // `if (!bounds) return null;` then `finiteNonNegative(bounds.x)`,
                    // where only `typeof n === "number"` is a number. Member access
                    // on a truthy non-object is `undefined` in JS, which is what
                    // `JSValue`'s subscript answers too.
                    let bounds = args.first ?? .undefined
                    guard bounds.isTruthy else { return .returned(.null) }
                    let made = ItemBounds.make(startSec: bounds["startSec"].numberValue,
                                               endSec: bounds["endSec"].numberValue)
                    return .returned(made.map { encode($0) } ?? JSValue.null)
                }
            ])
    }

    // MARK: decode (the JS objects -> the Swift enums)

    static func decodeState(_ value: JSValue) throws -> PlayerQueueState {
        switch try tag(value, "state") {
        case "idle": return .idle
        case "ended": return .ended
        case "loadingItem":
            return .loadingItem(target: try item(value["target"], "loadingItem.target"),
                                previous: try optionalItem(value["previous"], "loadingItem.previous"),
                                pendingSeek: try decodePendingSeek(value["pendingSeek"]))
        case "playing": return .playing(item: try item(value["item"], "playing.item"))
        case "transitioning":
            return .transitioning(from: try item(value["from"], "transitioning.from"),
                                  to: try item(value["to"], "transitioning.to"))
        case "interrupted":
            return .interrupted(item: try item(value["item"], "interrupted.item"),
                                wasPlaying: try bool(value["wasPlaying"], "interrupted.wasPlaying"))
        case let other:
            throw HarnessError("E_BAD_CASE", "no Swift state for {type: \"\(other)\"}")
        }
    }

    static func decodeEvent(_ value: JSValue) throws -> PlayerEvent {
        switch try tag(value, "event") {
        case "play": return .play(try item(value["item"], "play.item"))
        case "itemLoaded": return .itemLoaded
        case "itemEnded":
            return .itemEnded(next: try optionalItem(value["next"], "itemEnded.next"),
                              bridged: try bool(value["bridged"], "itemEnded.bridged"))
        case "interruptionBegan": return .interruptionBegan
        case "interruptionEnded":
            return .interruptionEnded(shouldResume: try bool(value["shouldResume"], "interruptionEnded.shouldResume"))
        case "routeChanged":
            return .routeChanged(oldDeviceUnavailable: try bool(value["oldDeviceUnavailable"],
                                                                "routeChanged.oldDeviceUnavailable"))
        case "skipToNext": return .skipToNext(try optionalItem(value["item"], "skipToNext.item"))
        case "skipToPrevious": return .skipToPrevious(try optionalItem(value["item"], "skipToPrevious.item"))
        case "stop": return .stop
        case "error":
            guard let message = value["message"].stringValue else {
                throw HarnessError("E_BAD_CASE", "error.message must be a string")
            }
            return .error(message)
        case "seek":
            guard let seconds = value["seconds"].numberValue else {
                throw HarnessError("E_BAD_CASE", "seek.seconds must be a number")
            }
            return .seek(seconds: seconds, precise: try bool(value["precise"], "seek.precise"))
        case "elementResumed": return .elementResumed
        case let other:
            // The JS default branch (an unknown event is logged and ignored) is
            // excluded as js-module-shape: a Swift enum has no unknown case.
            throw HarnessError("E_BAD_CASE", "no Swift event for {type: \"\(other)\"}")
        }
    }

    static func tag(_ value: JSValue, _ what: String) throws -> String {
        guard case .object = value, let type = value["type"].stringValue else {
            throw HarnessError("E_BAD_CASE", "a \(what) must be an object with a string type, got \(Codec.encode(value))")
        }
        return type
    }

    static func bool(_ value: JSValue, _ field: String) throws -> Bool {
        guard case let .bool(flag) = value else {
            throw HarnessError("E_BAD_CASE", "\(field) must be a boolean, got \(Codec.encode(value))")
        }
        return flag
    }

    static func optionalItem(_ value: JSValue, _ field: String) throws -> QueueItemRef? {
        if value == .null { return nil }
        return try item(value, field)
    }

    /// An `itemRef(id, kind, bounds)` object: `{id, kind, bounds}`, bounds
    /// present and either null or already `itemBounds`-normalised.
    static func item(_ value: JSValue, _ field: String) throws -> QueueItemRef {
        guard case .object = value, let id = value["id"].stringValue else {
            throw HarnessError("E_BAD_CASE", "\(field) must be an itemRef object with a string id, got \(Codec.encode(value))")
        }
        let kind: PlayerItemKind
        switch value["kind"] {
        case .string("episode"): kind = .episode
        case .string("tts"): kind = .tts
        default: throw HarnessError("E_BAD_CASE", "\(field).kind must be \"episode\" or \"tts\", got \(Codec.encode(value["kind"]))")
        }
        switch value["bounds"] {
        case .null:
            return QueueItemRef(id: id, kind: kind, bounds: nil)
        case let raw:
            let rawStart = raw["startSec"].numberValue
            let rawEnd = raw["endSec"].numberValue
            guard case .object = raw, let start = rawStart, let end = rawEnd,
                  let bounds = ItemBounds.make(startSec: start, endSec: end),
                  bounds.startSec == start, bounds.endSec == end else {
                throw HarnessError("E_BAD_CASE",
                    "\(field).bounds must be null or what itemBounds returns (a finite forward slice), got \(Codec.encode(raw))")
            }
            return QueueItemRef(id: id, kind: kind, bounds: bounds)
        }
    }

    static func decodePendingSeek(_ value: JSValue) throws -> PendingSeek? {
        if value == .null { return nil }
        guard case .object = value, let seconds = value["seconds"].numberValue else {
            throw HarnessError("E_BAD_CASE", "loadingItem.pendingSeek must be null or {seconds, precise}, got \(Codec.encode(value))")
        }
        return PendingSeek(seconds: seconds, precise: try bool(value["precise"], "loadingItem.pendingSeek.precise"))
    }

    // MARK: encode (the Swift enums -> the JS objects)

    static func encode(_ state: PlayerQueueState) -> JSValue {
        switch state {
        case .idle: return .object(["type": .string("idle")])
        case .ended: return .object(["type": .string("ended")])
        case let .loadingItem(target, previous, seek):
            let pending: JSValue = seek.map { JSValue.object(["seconds": .number($0.seconds), "precise": .bool($0.precise)]) }
                ?? JSValue.null
            return .object([
                "type": .string("loadingItem"),
                "target": encode(target),
                "previous": previous.map { encode($0) } ?? JSValue.null,
                "pendingSeek": pending
            ])
        case let .playing(item):
            return .object(["type": .string("playing"), "item": encode(item)])
        case let .transitioning(from, to):
            return .object(["type": .string("transitioning"), "from": encode(from), "to": encode(to)])
        case let .interrupted(item, wasPlaying):
            return .object(["type": .string("interrupted"), "item": encode(item), "wasPlaying": .bool(wasPlaying)])
        }
    }

    static func encode(_ effect: PlayerEffect) -> JSValue {
        func bare(_ type: String) -> JSValue { .object(["type": .string(type)]) }
        switch effect {
        case let .loadItem(item): return .object(["type": .string("loadItem"), "item": encode(item)])
        case .startPlayback: return bare("startPlayback")
        case .pausePlayback: return bare("pausePlayback")
        case .savePosition: return bare("savePosition")
        case .playTransitionTTS: return bare("playTransitionTTS")
        case .resetRateForTTS: return bare("resetRateForTTS")
        case .restoreRate: return bare("restoreRate")
        case let .emitTelemetry(message):
            return .object(["type": .string("emitTelemetry"), "message": .string(message)])
        case let .seekTo(seconds, precise):
            return .object(["type": .string("seekTo"), "seconds": .number(seconds), "precise": .bool(precise)])
        case let .seekRejected(reason):
            return .object(["type": .string("seekRejected"), "reason": .string(reason)])
        case let .setOutPoint(seconds):
            return .object(["type": .string("setOutPoint"), "seconds": .number(seconds)])
        }
    }

    static func encode(_ item: QueueItemRef) -> JSValue {
        .object([
            "id": .string(item.id),
            "kind": .string(item.kind == .tts ? "tts" : "episode"),
            "bounds": item.bounds.map { encode($0) } ?? JSValue.null
        ])
    }

    static func encode(_ bounds: ItemBounds) -> JSValue {
        .object(["startSec": .number(bounds.startSec), "endSec": .number(bounds.endSec)])
    }
}
