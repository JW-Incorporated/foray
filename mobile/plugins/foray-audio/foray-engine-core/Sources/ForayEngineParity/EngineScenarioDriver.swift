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
/// THE SEAM BEAT'S CLOCK (NE-30s) is the JS scheduler's. `setup.scheduler:
/// "manual"` is fakes.js `manualScheduler`: the monotonic clock moves ONLY on
/// a `clock` step, and the beat's one timer fires when that step passes it.
/// Otherwise it is `instantScheduler`: the beat's timer fires as the step
/// settles (the next microtask), and the clock moves a second per step as
/// before. The `engine` target (the prepare family, runner.js
/// `runEngineScenario`) always runs on the manual clock and drives the core
/// through the CONTRACT (engineSend payloads), with a standby deck that
/// prepares and hands over as reference-engine.js's WarmingBackend does; its
/// op log holds only the deck's tokens and `n.prepare:` / `n.handover:`,
/// which the prepare family asserts rather than strips.
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
        /// NE-30s: a load commanded inside a seam beat reaches the deck only
        /// once the beat's deadline has passed, i.e. the next item is loaded
        /// AFTER the beat instead of inside it (the defect the beat's absolute
        /// deadline exists to prevent: a seam costing gap + load).
        case loadAfterBeat
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
    /// M2's Foray tape (NE-30s): the core runs with `forayTapeEnabled`, and a
    /// Foray a scenario plays is the PAGE's build from
    /// `player/parity/scenario-builds.json`. Off, the driver is M1's exactly
    /// (the manager-episode family runs so, which is the card's "with the
    /// flags off, the manager-episode family is unchanged").
    public let forayTape: Bool
    /// A test's own page builds, by step index, for a case that is not in a
    /// fixture file (and so not in scenario-builds.json): the XCTests that
    /// drive more seams than a fixture does (A-4).
    public let inlineBuilds: [Int: [JSONNode]]

    public init(mutation: Mutation? = nil, forayTape: Bool = false, inlineBuilds: [Int: [JSONNode]] = [:]) {
        self.mutation = mutation
        self.forayTape = forayTape
        self.inlineBuilds = inlineBuilds
    }

    public func run(_ testCase: FixtureCase, context: Codec.Context) throws -> Run {
        guard let rawSetup = testCase.fields["setup"], let rawSteps = testCase.fields["steps"]?.arrayValue else {
            throw HarnessError("E_BAD_CASE", "case \(testCase.id) is not a scenario")
        }
        let setup = try Codec.expandInputs(rawSetup, context)
        let world = try ScenarioWorld(setup: setup, mutation: mutation, forayTape: forayTape,
                                      caseId: testCase.id, context: context)
        world.inlineBuilds = inlineBuilds
        for (index, rawStep) in rawSteps.enumerated() {
            guard case let .object(fields) = rawStep else {
                throw HarnessError("E_BAD_CASE", "step \(index) of \(testCase.id) is not an object")
            }
            let verbs = fields.keys.filter { ScenarioWorld.verbs.contains($0) }
            guard verbs.count == 1, let verb = verbs.first else {
                throw HarnessError("E_UNKNOWN_VERB", "step \(index) of \(testCase.id) has no single known verb")
            }
            world.stepIndex = index
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
    /// ignored, so a case that needs narration or the interlude (NE-31s) says so.
    static let setupKeys: Set<String> = ["target", "positions", "positionEvents", "rate", "backend", "catalogue", "session",
                                         "seamGapSec", "view", "scheduler", "seamGapEvents", "forayBuild", "capabilities"]
    /// runner.js `VIEW_KEYS`: what a Foray scenario may add to its checkpoints.
    static let viewKeys: Set<String> = ["outPoint", "seamGapRemainingMs", "timersLive", "positionSec"]
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
    let caseId: String
    let forayTape: Bool
    /// runner.js `runEngineScenario`: the contract, the standby deck, T.
    let engineTarget: Bool
    /// fakes.js `manualScheduler` (see the driver's header).
    let manualClock: Bool
    let view: [String]
    let seamGapEvents: Bool
    var stepIndex = 0
    var inlineBuilds: [Int: [JSONNode]] = [:]

    // The fake deck (FakeBackend).
    var reading: DeckReading
    let defaultDuration: Double
    let durationById: [String: Double]
    let holdLoads: Bool
    let failLoadFor: Set<String>
    var deckItemId: String?
    var deckToken: DeckToken?
    var readyToken: DeckToken?
    /// FakeBackend's `outPoint`: set by `setOutPoint`, dropped by a load.
    var deckOutPoint: Double?
    var instantLoads: [(token: DeckToken, itemId: String)] = []
    var heldLoads: [(token: DeckToken, itemId: String)] = []
    var confirmations: [DeckToken] = []
    var speaking = false
    /// The standby deck (reference-engine.js WarmingBackend), engine target only.
    var warm: DeckPolicy.Warm?
    var currentUrl: String?
    /// The seam beat's one timer, on the monotonic clock.
    var seamTimerDue: Double?
    /// `loadAfterBeat`'s withheld loads.
    var deferredLoads: [DeckCommand] = []

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
    /// runner.js `returned`: what `returns` steps recorded for the next checkpoint.
    var returned: [JSONValue] = []
    /// Refusals the core answered in the current engine command.
    var refusals: [String] = []
    var cmdSeq = 0

    init(setup: JSValue, mutation: EngineScenarioDriver.Mutation?, forayTape: Bool, caseId: String,
         context: Codec.Context) throws {
        guard case let .object(fields) = setup else { throw HarnessError("E_BAD_CASE", "setup must be an object") }
        for key in fields.keys where !ScenarioWorld.setupKeys.contains(key) {
            throw HarnessError("E_BAD_CASE", "setup.\(key) is not implemented by the Swift scenario driver (M2: narration and the interlude are NE-31s)")
        }
        guard let target = setup["target"].stringValue, target == "manager" || target == "engine" else {
            throw HarnessError("E_SCENARIO_TARGET", "the Swift scenario driver runs target manager or engine, got \(setup["target"])")
        }
        engineTarget = target == "engine"
        var tape = forayTape
        if engineTarget, case let .array(caps) = setup["capabilities"] {
            tape = tape && caps.contains(.string("foray"))
        }
        self.forayTape = tape
        // Without the tape the core has no beat, which is exactly a manager
        // built with `seamGapSec: 0` (NE-29s, media/remote). Any other beat
        // there is a case this driver cannot run, never a guess.
        if !tape && setup["seamGapSec"] != .undefined && setup["seamGapSec"] != .number(0) {
            throw HarnessError("E_BAD_CASE", "setup.seamGapSec \(setup["seamGapSec"]) needs the Foray tape (NE-30s); without it the Swift scenario driver runs only 0")
        }
        switch setup["scheduler"] {
        case .undefined, .string("instant"): manualClock = engineTarget
        case .string("manual"): manualClock = true
        default: throw HarnessError("E_BAD_CASE", "setup.scheduler is manual or instant, got \(setup["scheduler"])")
        }
        var viewList: [String] = []
        switch setup["view"] {
        case .undefined: break
        case let .array(keys):
            for key in keys {
                guard let name = key.stringValue, ScenarioWorld.viewKeys.contains(name) else {
                    throw HarnessError("E_BAD_CASE", "unknown view key \(key) (one of \(ScenarioWorld.viewKeys.sorted().joined(separator: ", ")))")
                }
                if name == "timersLive" && !manualClock {
                    throw HarnessError("E_BAD_CASE", "view \"timersLive\" needs setup.scheduler = \"manual\"")
                }
                viewList.append(name)
            }
        default: throw HarnessError("E_BAD_CASE", "setup.view is a list of view keys")
        }
        view = viewList
        seamGapEvents = setup["seamGapEvents"] == .bool(true)
        self.caseId = caseId
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
        let gapSec: Double
        switch setup["seamGapSec"] {
        case .undefined: gapSec = SeamGap.defaultGapSec
        case let .number(value): gapSec = value
        default: throw HarnessError("E_BAD_CASE", "setup.seamGapSec must be a number, got \(setup["seamGapSec"])")
        }
        core = EngineCore(config: EngineConfig(build: "parity", rate: rate, forayTapeEnabled: tape, seamGapSec: gapSec),
                          positions: positions)
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
        if !manualClock { monoMs += ScenarioWorld.stepMs }
        if engineTarget { return try engineStep(verb: verb, fields: fields, context: context) }
        switch verb {
        case "call":
            try call(fields, context: context)
            // JS awaits an ordinary call to its end (the load landed, the play
            // started); `await: false` leaves it in flight.
            if fields["await"] != .bool(false) { settle() }
        case "settle":
            settle()
        case "clock":
            guard manualClock else { throw HarnessError("E_BAD_CASE", "\"clock\" needs setup.scheduler = \"manual\"") }
            try advance(fields["clock"])
        case "deck":
            try deck(fields)
            settle()
        case "session":
            try session(fields)
            settle()
        case "lifecycle":
            try lifecycle(fields, context: context)
            settle()
        case "remote":
            try remote(fields, context: context)
            if fields["await"] != .bool(false) { settle() }
        case "checkpoint":
            guard let name = fields["checkpoint"]?.stringValue else {
                throw HarnessError("E_BAD_CASE", "a checkpoint needs a name")
            }
            checkpoint(name)
        default:
            // tts and interlude have no Swift driver yet; say which, never skip.
            throw HarnessError("E_BAD_CASE", "the \"\(verb)\" verb has no Swift scenario driver yet (M2: NE-31s)")
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
        if fields["returns"] != nil && !(forayTape && (name == "playForay" || name == "setQueueFromForay")) {
            throw HarnessError("E_BAD_CASE", "only a Foray's build report can be recorded (returns: forayReport)")
        }
        switch name {
        case "loadQueue":
            feed(.queue(.load(try items(arg(0), "loadQueue's items"))))
        case "setQueueFromPick":
            // The default strategy, SINGLE_ITEM: `picked ? [picked] : []`.
            feed(.queue(.load(try items(.array([arg(0)]), "setQueueFromPick's item"))))
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
        case "playForay", "setQueueFromForay":
            if forayTape {
                // The PAGE's build (the engine never builds a Foray, plan §3 A-1).
                let build = try forayBuild(context)
                feed(.queue(.loadForay(build.items, isLocalFile: build.isLocalFile, allowAdPad: build.allowAdPad)))
                if name == "playForay" && !build.items.isEmpty {
                    feed(.queue(.playIndex(0, startSec: nil, source: .tap)))
                }
                if let projection = fields["returns"] {
                    guard projection == .string("forayReport") else {
                        throw HarnessError("E_BAD_CASE", "unknown returns projection \(projection) (one of forayReport)")
                    }
                    if fields["await"] == .bool(false) {
                        throw HarnessError("E_BAD_CASE", "a call that records what it returns must be awaited")
                    }
                    returned.append(build.report)
                }
            } else {
                feed(.queue(.load(try forayQueue(arg(0)))))
                // `setQueueFromForay`: the same page-built queue, loaded and not started (NE-29s).
                if name == "playForay" { feed(.queue(.playIndex(0, startSec: nil, source: .tap))) }
            }
        default:
            throw HarnessError("E_UNKNOWN_EXPORT", "\"\(name)\" is not a manager call the Swift scenario driver makes")
        }
    }

    /// A lock-screen, car or headset press (NE-29s; runner.js `remote`).
    /// The press goes through the SAME table the page's does
    /// (`MediaMapping.intent(for:)`, which the media-episode family pins over
    /// `mediaSessionActions`), and the intent reaches the engine the way iOS
    /// delivers it: as the `MPRemoteCommand` it stands for, into
    /// `EngineCore`'s own remote handlers (plan §4.5). runner.js's surface
    /// installs every intent, so every action is installed here too.
    private func remote(_ fields: [String: JSONValue], context: Codec.Context) throws {
        guard let name = fields["remote"]?.stringValue, let action = MediaAction(rawValue: name) else {
            throw HarnessError("E_BAD_CASE", "unknown remote action \(fields["remote"] ?? .null)")
        }
        let details = try Codec.expandInputs(fields["details"] ?? .object([:]), context)
        let press = MediaMapping.PressDetails(seekTime: details["seekTime"].numberValue,
                                              close: details["close"] == .bool(true))
        guard let intent = MediaMapping.intent(for: action, details: press) else { return } // an ignored press
        let command: RemotePress
        switch intent {
        case .play: command = RemotePress(.play)
        case .pause: command = RemotePress(.pause)
        case .next: command = RemotePress(.nextTrack)
        case .previous: command = RemotePress(.previousTrack)
        case let .seekBy(offset):
            command = offset < 0 ? RemotePress(.skipBackward, value: -offset) : RemotePress(.skipForward, value: offset)
        case let .seekTo(position): command = RemotePress(.changePlaybackPosition, value: position)
        case .stop:
            // runner.js's surface CLOSES on stop; natively a remote stop is a
            // pause (plan §4.5, T-7). No answer is pinned for the difference.
            throw HarnessError("E_BAD_CASE", "a remote stop pauses natively (T-7) where the JS surface closes; no Swift case runs it")
        }
        feed(.remote(command))
    }

    private func deck(_ fields: [String: JSONValue]) throws {
        guard let event = fields["deck"]?.stringValue else { throw HarnessError("E_BAD_CASE", "a deck step needs an event") }
        switch event {
        case "ended":
            // The file ran out, or the out-point stopped it (`reason`, which
            // only telemetry reads: the two are one end). The deck is silent
            // and at its end (NE-14k; runner.js sets the fake element's
            // `paused` and `ended` first).
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

    /// `clock: ms` on the manual scheduler (`advance`): move the clock, run
    /// what came due (the beat's one timer), then settle.
    private func advance(_ value: JSONValue?) throws {
        guard let ms = value?.numberValue, ms.isFinite, ms >= 0, ms.rounded() == ms else {
            throw HarnessError("E_BAD_CASE", "clock takes whole milliseconds")
        }
        monoMs += ms
        if let due = seamTimerDue, due <= monoMs {
            seamTimerDue = nil
            feed(.timer(.seamBeat))
        }
        if !deferredLoads.isEmpty, let until = core.state.gapUntilMono, monoMs >= until {
            let withheld = deferredLoads
            deferredLoads = []
            for command in withheld { applyDeck(command) }
        }
        settle()
    }

    // MARK: the engine target (runner.js `runEngineScenario`, NE-30j)

    private func engineStep(verb: String, fields: [String: JSONValue], context: Codec.Context) throws {
        switch verb {
        case "call":
            try engineCall(fields, context: context)
        case "deck":
            try engineDeck(fields)
            settle()
        case "clock":
            try advance(fields["clock"])
        case "settle":
            settle()
        case "checkpoint":
            guard let name = fields["checkpoint"]?.stringValue else {
                throw HarnessError("E_BAD_CASE", "a checkpoint needs a name")
            }
            checkpoint(name)
        default:
            throw HarnessError("E_BAD_CASE", "the engine target takes call, deck, clock, settle and checkpoint steps, not \"\(verb)\"")
        }
    }

    /// An engine COMMAND: `{call: "<cmd>", args?, source?, refused?}` sent as
    /// the engineSend payload the page sends, decoded by the contract, and
    /// answered (the reply's refusal, if any) before the next step. A
    /// `playForay`'s items are the page's BUILD of the authored ones.
    private func engineCall(_ fields: [String: JSONValue], context: Codec.Context) throws {
        guard let name = fields["call"]?.stringValue else { throw HarnessError("E_BAD_CASE", "a call step needs a name") }
        cmdSeq += 1
        let source = fields["source"]?.stringValue ?? "tap"
        var members: [JSONMember] = [
            JSONMember("v", .number(Double(EngineContract.protocolVersion))),
            JSONMember("cmdSeq", .number(Double(cmdSeq))),
            JSONMember("cmd", .string(name)),
            JSONMember("source", .string(source))
        ]
        refusals = []
        var refusedBeforeSend: String?
        if let raw = fields["args"] {
            var args = ScenarioWorld.node(try Codec.expandInputs(raw, context))
            if name == "playForay", forayTape {
                let build = try forayBuild(context)
                if build.items.isEmpty {
                    // reference-engine.js: nothing playable is refused-structure.
                    refusedBeforeSend = EngineContract.Refusal.refusedStructure.rawValue
                } else {
                    args = ScenarioWorld.replacing("items", in: args, with: .array(build.items.map(\.node)))
                }
            }
            members.append(JSONMember("args", args))
        }
        if let refusedBeforeSend {
            refusals.append(refusedBeforeSend)
        } else {
            let request: EngineContract.SendRequest
            do {
                request = try EngineContract.SendRequest(contract: .object(members))
            } catch {
                throw HarnessError("E_BAD_CASE", "engine \(name) is not a contract command: \(error)")
            }
            feed(.command(request.command, source: request.source))
            settle()
        }
        let want = fields["refused"]?.stringValue
        let got = refusals.first
        guard got == want else {
            throw HarnessError("E_BAD_CASE", "engine \(name) answered \(got ?? "ok"), the step expects \(want ?? "ok")")
        }
    }

    /// The engine's deck events (runner.js `ENGINE_DECK_EVENTS`).
    private func engineDeck(_ fields: [String: JSONValue]) throws {
        guard let event = fields["deck"]?.stringValue else { throw HarnessError("E_BAD_CASE", "a deck step needs an event") }
        switch event {
        case "ended", "error", "time", "duration":
            try deck(fields)
        case "window":
            // WarmingBackend `openPrefetchWindow`: only an armed out-point on
            // an audible deck has a boundary to approach.
            if deckOutPoint != nil && reading.audible, let token = deckToken {
                feed(.deck(.prepareWindow(token: token)))
            }
        case "stall":
            if let token = deckToken { feed(.deck(.stalled(token: token))) }
        case "flowing":
            if let token = deckToken { feed(.deck(.timeControl(token: token, status: .playing, waitingReason: nil))) }
        default:
            throw HarnessError("E_BAD_CASE", "unknown engine deck event \"\(event)\" (one of ended, error, time, duration, window, stall, flowing)")
        }
    }

    /// This step's page build: the test's own, else the table's.
    private func forayBuild(_ context: Codec.Context) throws -> ScenarioBuilds.Build {
        if let nodes = inlineBuilds[stepIndex] {
            return try ScenarioBuilds.build(key: "\(caseId)@\(stepIndex)", entry: .object([
                JSONMember("items", .array(nodes)), JSONMember("skipped", .array([])), JSONMember("warnings", .number(0))
            ]))
        }
        return try ScenarioBuilds.build(caseId: caseId, step: stepIndex, context: context)
    }

    /// `object` with `key` replaced (or appended).
    static func replacing(_ key: String, in object: JSONNode, with value: JSONNode) -> JSONNode {
        guard case var .object(members) = object else { return object }
        if let at = members.firstIndex(where: { $0.key == key }) {
            members[at] = JSONMember(key, value)
        } else {
            members.append(JSONMember(key, value))
        }
        return .object(members)
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

    /// `playForay(foray, {resolveItem})`'s queue WITHOUT the Foray tape (the
    /// NE-29s media/remote cases): the one shape it can build faithfully,
    /// plain segments of catalogue rows with no ad-drift check (`dai_suspected`
    /// false), which buildForayQueue turns into
    /// `{id: "<foray>#<i>", kind, audio_url, start_sec, end_sec}`. With the
    /// tape a Foray is the page's build from scenario-builds.json instead.
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
                throw HarnessError("E_BAD_CASE", "without the Foray tape the Swift driver builds only plain segments of catalogue rows")
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
        case .loadAfterBeat?, nil:
            return output
        }
    }

    /// A native-only token: logged for the report (and stripped by the
    /// comparator) on the manager target; the engine target's op log is the
    /// deck's and the standby deck's only, as reference-engine.js's is.
    private func native(_ token: String) {
        if !engineTarget { ops.append(token) }
    }

    /// Interpret the core's commands in the fake world, logging each one.
    private func apply(_ output: [EngineCommand], names: inout [String]) {
        for command in output {
            commands.append(command)
            names.append(command.turnName)
            switch command {
            case let .deck(deckCommand):
                if mutation == .loadAfterBeat, case .load = deckCommand, core.state.inSeamGap {
                    deferredLoads.append(deckCommand)
                } else {
                    applyDeck(deckCommand)
                }
            case let .writePosition(write):
                if engineTarget { break }
                ops.append(positionEvents ? "store.set:\(write.row.key)"
                                          : "store.save:\(write.itemId)@\(ScenarioWorld.rounded(write.seconds))")
            case let .appendEvent(event):
                let text = "event.position:\(event.episodeId)@\(ScenarioWorld.number(event.seconds)):"
                    + (event.duration.map(ScenarioWorld.number) ?? "null")
                if positionEvents && !engineTarget { ops.append(text) } else { native("n.\(text)") }
            case let .sessionActivate(requestId): native("n.session.activate:\(requestId)")
            case let .sessionDeactivate(notifyOthers): native(notifyOthers ? "n.session.deactivate:notify" : "n.session.deactivate")
            case .sessionReapplyCategory: native("n.session.category")
            case .sessionRebuild: native("n.session.rebuild")
            case let .graceBegin(reason):
                if let open = graceHeld { broke("grace-begun-twice:\(open.rawValue)") }
                graceHeld = reason
                native("n.grace.begin:\(reason.rawValue)")
            case let .graceEnd(outcome):
                if graceHeld == nil { broke("grace-end-without-begin:\(outcome.rawValue)") }
                graceHeld = nil
                native("n.grace.end:\(outcome.rawValue)")
            case let .timerArm(timer, afterMs, _):
                if timer == .seamBeat { seamTimerDue = monoMs + afterMs }
                native("n.timer.arm:\(timer.rawValue)")
            case let .timerCancel(timer):
                if timer == .seamBeat { seamTimerDue = nil }
                native("n.timer.cancel:\(timer.rawValue)")
            case let .writeRow(row): native("n.row:\(row.key)")
            case let .writeRestore(record): native("n.restore:\(record?.mode.rawValue ?? "removed")")
            case .speak:
                speaking = true
                trackAudible()
                native("n.speak")
            case let .emit(event):
                switch event {
                case .advanced: native("n.emit:advanced")
                case let .error(code, _): native("n.emit:error:\(code)")
                case .skipped: native("n.emit:skipped")
                }
            case let .diag(entry):
                let sub = entry[field: "kind"]?.stringValue
                if entry.kind == "beat", seamGapEvents, !engineTarget, sub == "begin" || sub == "end" {
                    // The surface's beat callback (`onSeamGapChange`), as an op.
                    ops.append("event.seamGap:\(sub == "begin")")
                } else {
                    let cause = entry[field: "cause"]?.stringValue.map { ":\($0)" } ?? ""
                    native("n.diag:\(entry.kind)\(cause)")
                }
            case let .commandFailed(reason):
                refusals.append(reason)
                native("n.failed:\(reason)")
            }
        }
    }

    /// FakeBackend, command by command (and, on the engine target,
    /// WarmingBackend's standby deck).
    func applyDeck(_ command: DeckCommand) {
        switch command {
        case let .load(token, itemId, url, startSec, _):
            if engineTarget {
                // `warmPromotion` at the boundary: a load that finds its source
                // and in-point warm is a handover, said BEFORE the load.
                let offset = JSMath.round(DeckPolicy.warmOffset(startSec))
                let promotion = DeckPolicy.warmPromotion(warm: warm, url: url, offsetSec: offset, canPlay: true, atSec: offset)
                if promotion == .promote { ops.append("n.handover:\(itemId)@\(ScenarioWorld.number(offset))") }
                warm = nil
                currentUrl = url
            }
            // A load re-points the element: paused, at the offset, no boundary.
            deckItemId = itemId
            deckToken = token
            readyToken = nil
            deckOutPoint = nil
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
            deckOutPoint = sec
            ops.append("outPoint:\(sec.map(ScenarioWorld.rounded) ?? "null")")
        case .unload:
            deckItemId = nil
            deckToken = nil
            readyToken = nil
            deckOutPoint = nil
            reading = DeckReading(positionSec: nil, durationSec: nil, audible: false, ended: false)
            native("n.deck.unload")
        case let .prepare(itemId, url, startSec):
            guard engineTarget else { return native("n.deck.prepare:\(itemId)") }
            // WarmingBackend `prefetch`: the standby deck's own decision.
            let offset = JSMath.round(DeckPolicy.warmOffset(startSec))
            switch DeckPolicy.prefetchDecision(available: true, url: url, currentUrl: currentUrl, warm: warm, offsetSec: offset) {
            case .already:
                warm?.itemId = itemId
            case .start:
                warm = DeckPolicy.Warm(itemId: itemId, url: url ?? "", offsetSec: offset, ready: true, failed: false)
                ops.append("n.prepare:\(itemId)@\(ScenarioWorld.number(offset))")
            case .unavailable, .noUrl, .sameEpisode:
                break
            }
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
    /// step: instant loads, in issue order, then (on the instant scheduler)
    /// the seam beat's timer, then each started deck saying `.playing`.
    func settle() {
        var budget = 256
        while budget > 0 {
            budget -= 1
            if !instantLoads.isEmpty {
                let next = instantLoads.removeFirst()
                land(next.token, itemId: next.itemId, fail: failLoadFor.contains(next.itemId))
                continue
            }
            if !manualClock, seamTimerDue != nil {
                seamTimerDue = nil
                feed(.timer(.seamBeat))
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
        var fields: [String: JSONValue] = [
            "name": .string(name),
            "ops": .array(ops[mark...].map { JSONValue.string($0) }),
            "index": .number(Double(state.currentIndex)),
            "inInterlude": .bool(false),
            "inSeamGap": .bool(state.inSeamGap),
            "playhead": state.loadedId.map { JSONValue.string($0) } ?? .null,
            "rate": .number(state.rate),
            "state": .string(state.stateType)
        ]
        if engineTarget { fields["nowMs"] = .number(monoMs) }
        for key in view {
            switch key {
            case "outPoint": fields[key] = deckOutPoint.map { JSONValue.number($0) } ?? .null
            case "seamGapRemainingMs": fields[key] = .number(core.seamGapRemainingMs(atMono: monoMs))
            case "timersLive": fields[key] = .number(seamTimerDue == nil ? 0 : 1)
            case "positionSec": fields[key] = .number(reading.positionSec ?? 0)
            default: break
            }
        }
        if !returned.isEmpty { fields["returned"] = .array(returned) }
        returned = []
        checkpoints.append(.object(fields))
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

/// The page's build of every Foray a scenario plays (NE-30s):
/// `player/parity/scenario-builds.json`, which
/// `tools/parity/scenario-builds.mjs --write` emits from the real
/// `buildForayQueue` and run.test.js holds current. The engine never builds a
/// Foray (plan §3 A-1), so its input here is exactly what `playForay` carries.
enum ScenarioBuilds {
    static let file = "player/parity/scenario-builds.json"

    struct Build {
        let items: [EngineItem]
        let isLocalFile: Bool
        let allowAdPad: Bool
        /// runner.js `project("forayReport")`: queue ids, skipped entries, the
        /// warning count.
        let report: JSONValue
    }

    private static let lock = NSLock()
    private static var cache: [String: JSONNode] = [:]

    /// The table, read once per repo root, in key order (item nodes are kept
    /// verbatim, as the page sends them).
    static func table(_ context: Codec.Context) throws -> JSONNode {
        guard let root = context.repoRoot else {
            throw HarnessError("E_BAD_CASE", "a scenario's Foray build needs the repo root, and this run has none")
        }
        lock.lock()
        defer { lock.unlock() }
        if let hit = cache[root.path] { return hit }
        let text: String
        do {
            text = try String(contentsOf: root.appendingPathComponent(file), encoding: .utf8)
        } catch {
            throw HarnessError("E_BAD_CASE", "cannot read \(file): \(error)")
        }
        let doc: JSONNode
        do {
            doc = try JSONNode.parse(text)
        } catch {
            throw HarnessError("E_BAD_CASE", "cannot parse \(file): \(error)")
        }
        let builds = doc["builds"] ?? .object([])
        cache[root.path] = builds
        return builds
    }

    static func build(caseId: String, step: Int, context: Codec.Context) throws -> Build {
        let key = "\(caseId)@\(step)"
        guard let entry = try table(context)[key], case .object = entry else {
            throw HarnessError("E_BAD_CASE", "\(key) has no build in \(file); run node tools/parity/scenario-builds.mjs --write")
        }
        return try build(key: key, entry: entry)
    }

    /// One table entry (`{isLocalFile, allowAdPad, warnings, skipped, items}`).
    static func build(key: String, entry: JSONNode) throws -> Build {
        let nodes = entry["items"]?.arrayValue ?? []
        let items = try nodes.map { (node: JSONNode) throws -> EngineItem in
            guard let item = EngineItem(node: node) else {
                throw HarnessError("E_BAD_CASE", "\(key): a built item has no id")
            }
            return item
        }
        let report: JSONValue = .object([
            "items": .array(items.map { JSONValue.string($0.id) }),
            "skipped": Codec.encode(ForayArgs.value(entry["skipped"] ?? .array([]))),
            "warnings": .number(entry["warnings"]?.numberValue ?? 0)
        ])
        return Build(items: items, isLocalFile: entry["isLocalFile"] == .bool(true),
                     allowAdPad: entry["allowAdPad"] == .bool(true), report: report)
    }
}
