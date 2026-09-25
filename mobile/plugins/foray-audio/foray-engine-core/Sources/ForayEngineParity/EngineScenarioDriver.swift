import Foundation
import ForayEngineCore

/// The Swift driver for `{setup, steps, expect: {checkpoints, ops}}` scenarios
/// (plan §6.2; card NE-14s): runner.js `runScenario`, over `EngineCore`
/// instead of `PlayerQueueManager`.
///
/// WHAT IT IS. The fake world around the core, in the op-log grammar the JS
/// fakes write (player/parity/fakes.js): a deck that logs
/// `load:<id>@<s>`, `play`, `pause`, `seek:<s>`, `rate:<r>`, `outPoint:<s>`
/// exactly as FakeBackend does, and a store that logs `store.save:<id>@<s>`
/// (or, with `setup.positionEvents`, `store.set:cp_pos:<id>` and
/// `event.position:...`, as the real PositionStore over MemoryStore does).
/// Everything else the core commands (the session, grace, timers, rows,
/// diagnostics) is logged as a native-only `n.*` token, which the comparator
/// strips (plan §6.2), so the Swift report shows it and the verdict ignores it.
///
/// TIMING IS THE JS RUNNER'S. A step that JS awaits settles here too: loads the
/// fake resolves at once land (in the order they were issued) and a started
/// deck confirms `.playing`, before the next step. A call with
/// `await: false` is fed and NOT settled, so two such calls in a row are two
/// turns with both loads still in flight, as in JS. `setup.backend.holdLoads`
/// holds loads until a `deck: "loaded"` step lands them.
///
/// THE DRIVER ALSO CHECKS WHAT NO OP LOG CAN SHOW (plan §4.4, card NE-14s):
///   - the audible-start invariant on EVERY turn (`SessionPolicy
///     .audibleStartViolations`, the rule the `session-invariant` family pins);
///   - `play` only on a deck whose current load reported `.ready`;
///   - at most one audible source at a time;
///   - every grace begin has an end, and none is open when the scenario ends.
/// A broken one appends a `!...` token to the op log (never stripped), so the
/// case goes red with the evidence in its diff.
public struct EngineScenarioDriver {
    /// A deliberately broken core, for the mutation tests (card NE-14s): the
    /// fault is injected into the core's OUTPUT, so what is proven is that the
    /// driver's checks catch a core that behaves this way.
    public enum Mutation: Equatable {
        /// `deckPlay` right after every `deckLoad`: a play before the deck is ready.
        case playOnLoad
        /// A `deckPlay` at the head of any turn that begins lostToInterruption.
        case playWhileLost
    }

    /// One scenario's outcome.
    public struct Run {
        /// `{checkpoints, ops}`, the shape of the case's `expect`.
        public let encoded: JSONValue
        /// Every broken check, in order (also in the op log as `!` tokens).
        public let violations: [String]
        /// Every command the core emitted, in order.
        public let commands: [EngineCommand]
        /// The item each `play` started, in order.
        public let plays: [String]
        /// The most sources audible at once.
        public let maxAudibleSources: Int
        /// The core as the scenario left it.
        public let finalState: EngineState
    }

    public let mutation: Mutation?

    public init(mutation: Mutation? = nil) {
        self.mutation = mutation
    }

    public func run(_ testCase: FixtureCase, context: Codec.Context) throws -> Run {
        guard let rawSetup = testCase.fields["setup"], let rawSteps = testCase.fields["steps"]?.arrayValue else {
            throw HarnessError("E_BAD_CASE", "case \(testCase.id) is not a scenario")
        }
        let setup = try Codec.expandInputs(rawSetup, context)
        let world = try ScenarioWorld(setup: setup, mutation: mutation)
        for (index, rawStep) in rawSteps.enumerated() {
            guard case let .object(fields) = rawStep else {
                throw HarnessError("E_BAD_CASE", "step \(index) of \(testCase.id) is not an object")
            }
            let verbs = fields.keys.filter { ScenarioWorld.verbs.contains($0) }
            guard verbs.count == 1, let verb = verbs.first else {
                throw HarnessError("E_UNKNOWN_VERB", "step \(index) of \(testCase.id) has no single known verb")
            }
            try world.step(verb: verb, fields: fields, context: context)
        }
        world.settle()
        world.checkpoint("end")
        world.finish()
        return Run(encoded: world.encoded(), violations: world.violations, commands: world.commands,
                   plays: world.plays, maxAudibleSources: world.maxAudible, finalState: world.core.state)
    }
}

/// The world one scenario runs in. A class because every step mutates it.
final class ScenarioWorld {
    static let verbs: Set<String> = ["call", "settle", "clock", "deck", "tts", "interlude", "session",
                                     "lifecycle", "remote", "checkpoint"]
    /// The `setup` keys this driver implements; any other is refused, never
    /// ignored, so a case that needs the seam beat or narration (M2) says so.
    static let setupKeys: Set<String> = ["target", "positions", "positionEvents", "rate", "backend", "catalogue", "session"]
    /// A fixed wall clock (rows are stamped with it) and a monotonic one that
    /// moves a second per step, so nothing in one step is "within 500 ms" of
    /// another unless a case says so.
    static let wallMs: Double = 1_790_000_000_000
    static let stepMs: Double = 1000

    var core: EngineCore
    let mutation: EngineScenarioDriver.Mutation?
    let positionEvents: Bool
    let catalogue: JSValue
    let sessionFails: Bool

    // The fake deck (FakeBackend).
    var reading: DeckReading
    let defaultDuration: Double
    let durationById: [String: Double]
    let holdLoads: Bool
    let failLoadFor: Set<String>
    var deckItemId: String?
    var deckToken: DeckToken?
    var readyToken: DeckToken?
    var instantLoads: [(token: DeckToken, itemId: String)] = []
    var heldLoads: [(token: DeckToken, itemId: String)] = []
    var confirmations: [DeckToken] = []
    var speaking = false

    // What the scenario saw.
    var ops: [String] = []
    var checkpoints: [JSONValue] = []
    var mark = 0
    var violations: [String] = []
    var commands: [EngineCommand] = []
    var plays: [String] = []
    var maxAudible = 0
    var graceHeld: GraceReason?
    var monoMs: Double = 0

    init(setup: JSValue, mutation: EngineScenarioDriver.Mutation?) throws {
        guard case let .object(fields) = setup else { throw HarnessError("E_BAD_CASE", "setup must be an object") }
        for key in fields.keys where !ScenarioWorld.setupKeys.contains(key) {
            throw HarnessError("E_BAD_CASE", "setup.\(key) is not implemented by the Swift scenario driver (M2: the seam beat, narration and the interlude are NE-30s/NE-31s)")
        }
        guard let target = setup["target"].stringValue, target == "manager" || target == "engine" else {
            throw HarnessError("E_SCENARIO_TARGET", "the Swift scenario driver runs target manager or engine, got \(setup["target"])")
        }
        self.mutation = mutation
        positionEvents = setup["positionEvents"] == .bool(true)
        catalogue = setup["catalogue"]
        sessionFails = setup["session"]["activation"].stringValue == "fail"
        var positions: [String: ResumeRules.StoredPosition] = [:]
        if case let .object(seeded) = setup["positions"] {
            for (id, value) in seeded {
                guard let seconds = value.numberValue else {
                    throw HarnessError("E_BAD_CASE", "setup.positions.\(id) must be a number of seconds")
                }
                positions[id] = ResumeRules.StoredPosition(seconds: seconds, duration: nil)
            }
        }
        let rate: Double? = setup["rate"].numberValue
        core = EngineCore(config: EngineConfig(build: "parity", rate: rate), positions: positions)
        let backend = setup["backend"]
        holdLoads = backend["holdLoads"] == .bool(true)
        defaultDuration = backend["duration"].numberValue ?? 3600
        var byId: [String: Double] = [:]
        if case let .object(durations) = backend["durationById"] {
            for (id, value) in durations { if let seconds = value.numberValue { byId[id] = seconds } }
        }
        durationById = byId
        var failing: Set<String> = []
        if case let .array(ids) = backend["failLoadFor"] {
            for id in ids { if let text = id.stringValue { failing.insert(text) } }
        }
        failLoadFor = failing
        reading = DeckReading(positionSec: 0, durationSec: defaultDuration, audible: false, ended: false)
    }

    // MARK: steps

    func step(verb: String, fields: [String: JSONValue], context: Codec.Context) throws {
        monoMs += ScenarioWorld.stepMs
        switch verb {
        case "call":
            try call(fields, context: context)
            // JS awaits an ordinary call to its end (the load landed, the play
            // started); `await: false` leaves it in flight.
            if fields["await"] != .bool(false) { settle() }
        case "settle":
            settle()
        case "deck":
            try deck(fields)
            settle()
        case "session":
            try session(fields)
            settle()
        case "lifecycle":
            try lifecycle(fields, context: context)
            settle()
        case "checkpoint":
            guard let name = fields["checkpoint"]?.stringValue else {
                throw HarnessError("E_BAD_CASE", "a checkpoint needs a name")
            }
            checkpoint(name)
        default:
            // clock (the manager's scheduler: the seam beat), tts, interlude
            // and remote have no Swift driver yet; say which, never skip.
            throw HarnessError("E_BAD_CASE", "the \"\(verb)\" verb has no Swift scenario driver yet (M2: NE-30s/NE-31s; remote presses: NE-29j)")
        }
    }

    private func call(_ fields: [String: JSONValue], context: Codec.Context) throws {
        guard let name = fields["call"]?.stringValue else { throw HarnessError("E_BAD_CASE", "a call step needs a name") }
        let args: [JSValue]
        if case let .array(values) = try Codec.expandInputs(fields["args"] ?? .array([]), context) {
            args = values
        } else {
            throw HarnessError("E_BAD_CASE", "a call's args must be an array")
        }
        func arg(_ index: Int) -> JSValue { index < args.count ? args[index] : .undefined }
        switch name {
        case "loadQueue":
            feed(.queue(.load(try items(arg(0), "loadQueue's items"))))
        case "play":
            // `play(index = 0, opts = {})`, `Number(opts?.startOffset)`.
            let index: Int
            if arg(0) == .undefined {
                index = 0
            } else {
                guard let number = arg(0).numberValue, number.rounded() == number else {
                    throw HarnessError("E_BAD_CASE", "play's index must be an integer, got \(arg(0))")
                }
                index = Int(number)
            }
            let start = arg(1).isNullish ? nil : arg(1)["startOffset"].numberValue
            feed(.queue(.playIndex(index, startSec: start, source: .tap)))
        case "resume": feed(.command(.play, source: .tap))
        case "pause": feed(.command(.pause, source: .tap))
        case "skipToNext": feed(.command(.next, source: .tap))
        case "skipToPrevious": feed(.command(.previous, source: .tap))
        case "stop": feed(.command(.stop(persist: true), source: .tap))
        case "seek":
            guard let seconds = arg(0).numberValue else {
                throw HarnessError("E_BAD_CASE", "seek's seconds must be a number, got \(arg(0))")
            }
            feed(.queue(.seek(sec: seconds, precise: arg(1)["precise"].isTruthy)))
        case "setRate":
            feed(.queue(.setRate(arg(0).numberValue)))
        case "playForay":
            feed(.queue(.load(try forayQueue(arg(0)))))
            feed(.queue(.playIndex(0, startSec: nil, source: .tap)))
        default:
            throw HarnessError("E_UNKNOWN_EXPORT", "\"\(name)\" is not a manager call the Swift scenario driver makes")
        }
    }

    private func deck(_ fields: [String: JSONValue]) throws {
        guard let event = fields["deck"]?.stringValue else { throw HarnessError("E_BAD_CASE", "a deck step needs an event") }
        switch event {
        case "ended":
            // The file ran out: the deck is silent and at its end (NE-14k;
            // runner.js sets the fake element's `paused` and `ended` first).
            reading.audible = false
            reading.ended = true
            feed(.deck(.ended(token: deckToken ?? 0)))
        case "ranOut":
            // At the end with the `.ended` event not yet delivered (NE-14k).
            reading.audible = false
            reading.ended = true
        case "error":
            feed(.deck(.failed(token: deckToken ?? 0, message: fields["message"]?.stringValue ?? "error")))
        case "time":
            guard let seconds = fields["sec"]?.numberValue else { throw HarnessError("E_BAD_CASE", "deck time needs sec") }
            reading.positionSec = seconds
        case "duration":
            guard let seconds = fields["sec"]?.numberValue else { throw HarnessError("E_BAD_CASE", "deck duration needs sec") }
            reading.durationSec = seconds
        case "audible":
            // `backend.paused = step.audible === false`.
            reading.audible = fields["audible"] != .bool(false)
            trackAudible()
        case "observedPause":
            reading.audible = false
            feed(.deck(.pausedUncommanded(token: deckToken ?? 0, atSec: reading.positionSec ?? 0)))
        case "loaded", "loadFailed":
            let wanted = fields["id"]?.stringValue
            guard let at = heldLoads.firstIndex(where: { wanted == nil || $0.itemId == wanted }) else {
                let which = wanted.map { " for " + $0 } ?? ""
                throw HarnessError("E_BAD_CASE", "no held load\(which) to settle")
            }
            let held = heldLoads.remove(at: at)
            land(held.token, itemId: held.itemId, fail: event == "loadFailed" || failLoadFor.contains(held.itemId))
        default:
            throw HarnessError("E_BAD_CASE", "unknown deck event \"\(event)\"")
        }
    }

    /// The audio session's notifications. `interruptionReconciled` is the iOS
    /// PAGE's route for an interruption-began notification (it asks the
    /// element instead of commanding it); natively that same notification
    /// reaches the engine directly, so both arrive as one input.
    private func session(_ fields: [String: JSONValue]) throws {
        guard let event = fields["session"]?.stringValue else { throw HarnessError("E_BAD_CASE", "a session step needs an event") }
        switch event {
        case "interruptionBegan", "interruptionReconciled":
            feed(.session(.interruptionBegan(reason: fields["reason"]?.stringValue)))
        case "interruptionEnded":
            guard case let .bool(shouldResume)? = fields["shouldResume"] else {
                throw HarnessError("E_BAD_CASE", "session interruptionEnded needs a boolean shouldResume")
            }
            feed(.session(.interruptionEnded(shouldResume: shouldResume)))
        case "routeLost", "routeAvailable":
            feed(.session(.route(RouteChange(oldDeviceUnavailable: event == "routeLost",
                                             routeName: fields["routeName"]?.stringValue,
                                             isCarRoute: fields["isCarRoute"] == .bool(true)))))
        case "mediaServicesReset":
            feed(.session(.mediaServicesReset))
        default:
            throw HarnessError("E_BAD_CASE", "unknown session event \"\(event)\"")
        }
    }

    private func lifecycle(_ fields: [String: JSONValue], context: Codec.Context) throws {
        guard let event = fields["lifecycle"]?.stringValue else { throw HarnessError("E_BAD_CASE", "a lifecycle step needs an event") }
        switch event {
        case "coldLaunch":
            let queue = try items(try Codec.expandInputs(fields["items"] ?? .array([]), context), "coldLaunch's items")
            let index = Int(fields["index"]?.numberValue ?? 0)
            feed(.lifecycle(.coldLaunch(queue: queue, index: index, autoplay: fields["autoplay"] == .bool(true))))
        case "foreground": feed(.lifecycle(.foreground))
        case "background": feed(.lifecycle(.background))
        default:
            throw HarnessError("E_BAD_CASE", "unknown lifecycle event \"\(event)\"")
        }
    }

    // MARK: the page's side of a queue

    /// `loadQueue`'s items: `filter(Boolean)`, then each a catalogue row.
    private func items(_ value: JSValue, _ what: String) throws -> [EngineItem] {
        guard case let .array(values) = value else { throw HarnessError("E_BAD_CASE", "\(what) must be an array") }
        return try values.filter(\.isTruthy).map { (raw: JSValue) throws -> EngineItem in
            guard let item = EngineItem(node: ScenarioWorld.node(raw)) else {
                throw HarnessError("E_BAD_CASE", "\(what): an item needs a non-empty string id, got \(raw)")
            }
            return item
        }
    }

    /// `playForay(foray, {resolveItem})`'s queue. The engine never builds one:
    /// `buildForayQueue` is the PAGE's (plan §3 A-1), and M2's `playForay`
    /// hands the engine built items. So this stands in for the page, for the
    /// one shape it can build faithfully: plain segments of catalogue rows
    /// with no ad-drift check (`dai_suspected` false), which buildForayQueue
    /// turns into `{id: "<foray>#<i>", kind, audio_url, start_sec, end_sec}`.
    /// Anything else is refused, not guessed.
    private func forayQueue(_ foray: JSValue) throws -> [EngineItem] {
        guard let forayId = foray["id"].stringValue, case let .array(entries) = foray["items"] else {
            throw HarnessError("E_BAD_CASE", "playForay needs {id, items[]}")
        }
        var built: [EngineItem] = []
        for (index, entry) in entries.enumerated() {
            let itemId = entry["item_id"].stringValue ?? ""
            let row = catalogue[itemId]
            guard entry["type"].stringValue == "segment", case .object = row,
                  let start = entry["start_sec"].numberValue, let end = entry["end_sec"].numberValue,
                  row["dai_suspected"] != .bool(true) else {
                throw HarnessError("E_BAD_CASE", "the Swift driver builds only plain segments of catalogue rows (buildForayQueue is the page's; Forays are NE-30s)")
            }
            var members = [
                JSONMember("id", .string("\(forayId)#\(index)")),
                JSONMember("kind", .string("episode")),
                JSONMember("audio_url", row["audio_url"].stringValue.map { JSONNode.string($0) } ?? .null),
                JSONMember("start_sec", .number(start)),
                JSONMember("end_sec", .number(end)),
                JSONMember("source_item_id", .string(itemId))
            ]
            for key in ["title", "show"] {
                if let text = row[key].stringValue { members.append(JSONMember(key, .string(text))) }
            }
            guard let item = EngineItem(node: .object(members)) else {
                throw HarnessError("E_BAD_CASE", "segment \(index) of \(forayId) has no id")
            }
            built.append(item)
        }
        return built
    }

    /// A macro-expanded value as the page would send it (keys sorted, since a
    /// `JSValue` object has no order; scenario items are never byte rows).
    static func node(_ value: JSValue) -> JSONNode {
        switch value {
        case .undefined, .null: return .null
        case let .bool(flag): return .bool(flag)
        case let .number(number): return .number(number)
        case let .string(text): return .string(text)
        case let .array(values): return .array(values.map(node))
        case let .object(fields):
            return .object(fields.keys.sorted().compactMap { (key: String) -> JSONMember? in
                guard let member = fields[key], member != .undefined else { return nil }
                return JSONMember(key, node(member))
            })
        }
    }

    // MARK: feeding the core

    private var now: EngineNow { EngineNow(wallMs: ScenarioWorld.wallMs, monoMs: monoMs, deck: reading) }

    /// One turn: the input, then (as the host does, before anything else) the
    /// answer to any activation it asked for. The audible-start rule is
    /// checked over the whole turn, from the session the turn began with.
    func feed(_ input: EngineInput) {
        let entry = core.state.session
        var names: [String] = []
        var output = core.handle(input, now: now)
        output = mutate(output, entry: entry, turnHead: true)
        var rounds = 0
        while true {
            apply(output, names: &names)
            guard rounds < 4, let request = output.compactMap(ScenarioWorld.activationRequest).last else { break }
            rounds += 1
            let ok = !sessionFails
            names.append(ok ? SessionPolicy.TurnMarker.resultOk : SessionPolicy.TurnMarker.resultFailed)
            output = core.handle(.sessionResult(SessionResult(requestId: request, ok: ok,
                                                              error: ok ? nil : "cannot-start-playing", activateMs: 1)),
                                 now: now)
            // A load usually follows the activation's answer, so a mutation
            // must reach that part of the turn too.
            output = mutate(output, entry: entry, turnHead: false)
        }
        for violation in SessionPolicy.audibleStartViolations(sessionAtEntry: entry, turn: names) {
            broke("audible-start:\(violation.cmd)@\(entry.rawValue)")
        }
    }

    static func activationRequest(_ command: EngineCommand) -> Int? {
        if case let .sessionActivate(requestId) = command { return requestId }
        return nil
    }

    private func mutate(_ output: [EngineCommand], entry: SessionPolicy.Phase, turnHead: Bool) -> [EngineCommand] {
        switch mutation {
        case .playOnLoad?:
            return output.flatMap { command -> [EngineCommand] in
                if case .deck(.load) = command { return [command, .deck(.play)] }
                return [command]
            }
        case .playWhileLost?:
            return turnHead && entry == .lostToInterruption ? [EngineCommand.deck(.play)] + output : output
        case nil:
            return output
        }
    }

    /// Interpret the core's commands in the fake world, logging each one.
    private func apply(_ output: [EngineCommand], names: inout [String]) {
        for command in output {
            commands.append(command)
            names.append(command.turnName)
            switch command {
            case let .deck(deckCommand): applyDeck(deckCommand)
            case let .writePosition(write):
                ops.append(positionEvents ? "store.set:\(write.row.key)"
                                          : "store.save:\(write.itemId)@\(ScenarioWorld.rounded(write.seconds))")
            case let .appendEvent(event):
                let text = "event.position:\(event.episodeId)@\(ScenarioWorld.number(event.seconds)):"
                    + (event.duration.map(ScenarioWorld.number) ?? "null")
                ops.append(positionEvents ? text : "n.\(text)")
            case let .sessionActivate(requestId): ops.append("n.session.activate:\(requestId)")
            case let .sessionDeactivate(notifyOthers): ops.append(notifyOthers ? "n.session.deactivate:notify" : "n.session.deactivate")
            case .sessionReapplyCategory: ops.append("n.session.category")
            case .sessionRebuild: ops.append("n.session.rebuild")
            case let .graceBegin(reason):
                if let open = graceHeld { broke("grace-begun-twice:\(open.rawValue)") }
                graceHeld = reason
                ops.append("n.grace.begin:\(reason.rawValue)")
            case let .graceEnd(outcome):
                if graceHeld == nil { broke("grace-end-without-begin:\(outcome.rawValue)") }
                graceHeld = nil
                ops.append("n.grace.end:\(outcome.rawValue)")
            case let .timerArm(timer, _, _): ops.append("n.timer.arm:\(timer.rawValue)")
            case let .timerCancel(timer): ops.append("n.timer.cancel:\(timer.rawValue)")
            case let .writeRow(row): ops.append("n.row:\(row.key)")
            case let .writeRestore(record): ops.append("n.restore:\(record?.mode.rawValue ?? "removed")")
            case .speak:
                speaking = true
                trackAudible()
                ops.append("n.speak")
            case let .emit(event):
                switch event {
                case .advanced: ops.append("n.emit:advanced")
                case let .error(code, _): ops.append("n.emit:error:\(code)")
                }
            case let .diag(entry):
                let cause = entry[field: "cause"]?.stringValue.map { ":\($0)" } ?? ""
                ops.append("n.diag:\(entry.kind)\(cause)")
            case let .commandFailed(reason): ops.append("n.failed:\(reason)")
            }
        }
    }

    /// FakeBackend, command by command.
    private func applyDeck(_ command: DeckCommand) {
        switch command {
        case let .load(token, itemId, _, startSec, _):
            // A load re-points the element: paused, at the offset, no boundary.
            deckItemId = itemId
            deckToken = token
            readyToken = nil
            reading.positionSec = startSec
            reading.audible = false
            reading.ended = false
            reading.durationSec = durationById[itemId] ?? defaultDuration
            ops.append("load:\(itemId)@\(ScenarioWorld.rounded(startSec))")
            if holdLoads { heldLoads.append((token, itemId)) } else { instantLoads.append((token, itemId)) }
        case .play:
            if deckToken == nil || readyToken != deckToken {
                broke("deck-play-before-ready")
            }
            reading.audible = true
            speaking = false
            plays.append(deckItemId ?? "?")
            trackAudible()
            ops.append("play")
            if let token = deckToken { confirmations.append(token) }
        case .pause:
            reading.audible = false
            ops.append("pause")
        case let .seek(toSec):
            reading.positionSec = toSec
            ops.append("seek:\(ScenarioWorld.rounded(toSec))")
        case let .setRate(rate):
            ops.append("rate:\(ScenarioWorld.number(rate))")
        case let .setOutPoint(sec):
            ops.append("outPoint:\(sec.map(ScenarioWorld.rounded) ?? "null")")
        case .unload:
            deckItemId = nil
            deckToken = nil
            readyToken = nil
            reading = DeckReading(positionSec: nil, durationSec: nil, audible: false, ended: false)
            ops.append("n.deck.unload")
        }
    }

    /// A load lands (or fails). A superseded load's answer is still delivered,
    /// as the JS fake resolves it: the core must be the one to ignore it.
    private func land(_ token: DeckToken, itemId: String, fail: Bool) {
        if fail {
            feed(.deck(.failed(token: token, message: "missing file")))
            return
        }
        if token == deckToken { readyToken = token }
        feed(.deck(.ready(token: token, landedSec: reading.positionSec ?? 0, prerolled: true, elapsedMs: 0)))
    }

    /// Everything in flight that the JS fakes would resolve before the next
    /// step: instant loads, in issue order, then each started deck saying
    /// `.playing`.
    func settle() {
        var budget = 256
        while budget > 0 {
            budget -= 1
            if !instantLoads.isEmpty {
                let next = instantLoads.removeFirst()
                land(next.token, itemId: next.itemId, fail: failLoadFor.contains(next.itemId))
                continue
            }
            if !confirmations.isEmpty {
                let token = confirmations.removeFirst()
                if token == deckToken && reading.audible {
                    feed(.deck(.timeControl(token: token, status: .playing, waitingReason: nil)))
                }
                continue
            }
            return
        }
        broke("settle-did-not-converge")
    }

    private func trackAudible() {
        let sources = (reading.audible ? 1 : 0) + (speaking ? 1 : 0)
        if sources > 1 { broke("two-audible-sources") }
        maxAudible = Swift.max(maxAudible, sources)
    }

    private func broke(_ what: String) {
        violations.append(what)
        ops.append("!\(what)")
    }

    // MARK: checkpoints and the answer

    func checkpoint(_ name: String) {
        let state = core.state
        checkpoints.append(.object([
            "name": .string(name),
            "ops": .array(ops[mark...].map { JSONValue.string($0) }),
            "index": .number(Double(state.currentIndex)),
            "inInterlude": .bool(false),
            "inSeamGap": .bool(false),
            "playhead": state.loadedId.map { JSONValue.string($0) } ?? .null,
            "rate": .number(state.rate),
            "state": .string(state.stateType)
        ]))
        mark = ops.count
    }

    /// The end-of-scenario checks: no grace span left open.
    func finish() {
        if let open = graceHeld { broke("grace-never-ended:\(open.rawValue)") }
    }

    func encoded() -> JSONValue {
        .object(["checkpoints": .array(checkpoints), "ops": .array(ops.map { JSONValue.string($0) })])
    }

    /// FakeBackend's `r(s) = Math.round(s)`, printed as JS prints a number.
    static func rounded(_ seconds: Double) -> String { number(JSMath.round(seconds)) }

    /// `${n}`: ECMAScript Number::toString.
    static func number(_ value: Double) -> String { JSWriter.numberToString(value) }
}
