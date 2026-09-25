import Foundation

/// How a core is built: what it cannot learn from an input.
public struct EngineConfig: Equatable {
    /// `CFBundleVersion`, stamped into the restore record.
    public var build: String
    public var holdPolicy: SessionPolicy.HoldPolicy
    /// The listener's stored speed (`cp_rate`); snapped onto the ladder.
    public var rate: Double?

    public init(build: String = "", holdPolicy: SessionPolicy.HoldPolicy = .default, rate: Double? = nil) {
        self.build = build
        self.holdPolicy = holdPolicy
        self.rate = rate
    }
}

/// THE ENGINE'S FUNCTIONAL CORE for episodes (card NE-14s; plan §4.2):
/// `handle(input, now) -> [EngineCommand]`, pure, on a value.
///
/// WHAT IT IS. The port of `PlayerQueueManager` (player/queue-manager.js)
/// around the reducer NE-07s already brought to parity, with the three things
/// the web manager does not have to own and the native engine does: the audio
/// session (`SessionPolicy`, NE-11s), BackgroundGrace, and the deck as a
/// request and a response instead of a promise. The manager-episode fixtures
/// the JS records are its contract: the same steps, driven through this core
/// by `ForayEngineParity`'s scenario driver, must produce the same op log.
///
/// WHY IT IS SYNCHRONOUS WHERE THE JS AWAITS. The JS manager awaits each
/// effect; the native engine lives on main and every observation is an input,
/// so an effect that has to wait (a load) is a command now and an input later
/// (`.deck(.ready(token))`), and everything else in a turn happens in order,
/// with nothing interleaved. NE-14s made the JS manager await only what is
/// really asynchronous, so the two runtimes order a fast double skip the same
/// way (`manager-episode/concurrent-double-skip-starts-one-item`).
///
/// THE AUDIBLE-START INVARIANT (plan §4.4) is structural: every play-ish
/// intent goes through `begin`, which asks `SessionPolicy`; an intent that
/// needs the session emits `.sessionActivate` and PARKS until the host feeds
/// `.sessionResult` back in the same turn, so a failed activation ends in
/// `.commandFailed` with nothing audible. `startPlayback` refuses outright
/// without an active session, as the backstop the `session-invariant` rule
/// checks every scenario turn against.
///
/// A relinquished core is terminal: `handle` returns `[]` for everything.
public struct EngineCore {
    /// Plan §4.3: an uncommanded pause within this long of a route going away
    /// (in either order) is the route's, not the system's.
    public static let routeAttributionMs: Double = 500
    /// `REMOTE_DUPLICATE_WINDOW_MS` (foray-media-session.js): a second press of
    /// the same command inside it is recorded as `dupCandidate` (T-8) and
    /// still handled; DV-6 decides whether anything is ever dropped.
    public static let remoteDuplicateWindowMs: Double = 500
    /// The `pendingEvents` log is bounded (plan §5.5): a page that never
    /// attaches must not grow the restore record without limit. At the
    /// once-a-minute event rule this is days of listening.
    public static let pendingEventsCap = 512
    /// Walked hops the page has not acked; the chain the page sends is K = 8
    /// long, so this is many plans of margin.
    public static let advanceLogCap = 64

    public private(set) var state: EngineState
    public let config: EngineConfig

    // The turn in progress. Set at the top of `handle` and read only inside it.
    private var out: [EngineCommand] = []
    private var now = EngineNow(wallMs: 0, monoMs: 0)
    /// The deck as the turn has left it: the host's reading, then updated by
    /// every deck command this turn emits (a load resets the playhead, a pause
    /// silences), exactly as the JS reads its fake element back after an
    /// effect ran.
    private var deck = DeckReading.idle
    /// A load, play, pause or unload was commanded this turn.
    private var deckMovedThisTurn = false
    /// `stop({persist: false})` is data deletion: its reducer save is skipped.
    private var suppressSave = false

    public init(config: EngineConfig = EngineConfig(), positions: [String: ResumeRules.StoredPosition] = [:]) {
        self.config = config
        var initial = EngineState()
        initial.holdPolicy = config.holdPolicy
        initial.rate = PlaybackRate.normalize(config.rate)
        initial.positions = positions
        state = initial
    }

    /// `canNext` (plan §5.5): the queue has a next item, or the continuation
    /// chain is non-empty, REGARDLESS of `autoAdvance` (as the page's
    /// `EPISODE_NAVIGATION.next` does today).
    public var canNext: Bool {
        nextItem(from: cursor, skipBridges: true) != nil || !state.chain.isEmpty
    }

    /// Previous restarts the item in place, so it exists whenever one does.
    public var canPrevious: Bool { state.currentItem != nil }

    // MARK: - The one door

    public mutating func handle(_ input: EngineInput, now: EngineNow) -> [EngineCommand] {
        if state.session == .relinquished { return [] }
        self.now = now
        deck = now.deck
        out = []
        deckMovedThisTurn = false
        if case let .sessionResult(result) = input {
            onSessionResult(result)
        } else {
            if let parked = state.pendingActivation {
                // The host feeds the answer before anything else (plan §4.2);
                // an intent still parked here was never answered, and a play
                // nobody confirmed must not start later on a stranger's turn.
                state.pendingActivation = nil
                diag("session", [JSONMember("kind", .string("activation-abandoned")),
                                 JSONMember("requestId", .number(Double(parked.requestId)))])
            }
            route(input)
        }
        if state.session != .relinquished { settleTurn() }
        let result = out
        out = []
        return result
    }

    private mutating func route(_ input: EngineInput) {
        switch input {
        case let .command(command, source): onCommand(command, source: source)
        case let .queue(queueInput): onQueue(queueInput)
        case let .remote(press): onRemote(press)
        case let .deck(event): onDeck(event)
        case .sessionResult: break
        case let .session(event): onSession(event)
        case let .lifecycle(event): onLifecycle(event)
        case let .timer(timer): onTimer(timer)
        }
    }

    // MARK: - Page commands

    private mutating func onCommand(_ command: EngineContract.Command, source: EngineSource) {
        switch command {
        case let .playEpisode(item, startSec, _, lastEpisodeRow):
            guard let episode = EngineItem(node: item.node) else { return refuse(.notLoaded) }
            // `loadQueue([item])` then `play(0, {startOffset})`: the page's own
            // path for an episode, with the row it will read back.
            state.queue = [episode]
            state.currentIndex = -1
            state.forayId = nil
            state.lastEpisodeRow = lastEpisodeRow
            state.lastEpisodeRowWritten = false
            state.startingHop = nil
            playIndex(0, startSec: startSec, source: source)
        case .playForay:
            // M2 (NE-30s): until then the page relinquishes before a Foray.
            refuse(.capabilityOff)
        case let .setContinuation(planSeq, autoAdvance, chain, previous):
            state.planSeq = planSeq
            state.autoAdvance = autoAdvance
            state.chain = chain
            state.previousHop = previous
        case .play: play(source: source)
        case .pause: pause(source: source)
        case .toggle: toggle(source: source)
        case .next: next(source: source)
        case .previous: previous(source: source)
        case let .seekBy(deltaSec): seekBy(deltaSec, source: source)
        case let .seekTo(sec): seekTo(sec, source: source)
        case let .jump(index): playIndex(index, startSec: nil, source: source)
        case let .stop(persist): stop(persist: persist, source: source)
        case let .setRate(rate): setRate(rate)
        case .setVoice, .setInterludeEnabled:
            // Narration and the interlude are M2 (NE-31s, NE-33).
            break
        case let .setPageVisible(visible): state.pageVisible = visible
        case let .ackAdvances(upToSeq):
            state.advanceLog.removeAll { $0.seq <= upToSeq }
            writeRestore()
        case let .ackEvents(upToSeq):
            state.pendingEvents.removeAll { $0.seq <= upToSeq }
            writeRestore()
        case .restoreBar:
            // Painting a restored bar is the page's; nothing audible happens.
            break
        case .purge: stop(persist: false, source: source)
        case let .relinquish(cap): relinquish(cap: cap, source: source)
        case let .audition(text, voiceId):
            // OQ-5: refused while running; otherwise the engine's own
            // synthesiser speaks it after a SessionPolicy activation.
            if state.isRunning || audibleNow { return refuse(.engineBusy) }
            begin(.audition(text: text, voiceId: voiceId), source: .audition)
        case .setModeOverride, .probeSession:
            // The host's (EngineOwnership NE-17, SessionProbe NE-25c).
            break
        case let .setHoldPolicy(policy): state.holdPolicy = policy
        }
    }

    private mutating func onQueue(_ input: QueueInput) {
        switch input {
        case let .load(items):
            // `loadQueue(items)`: the queue is replaced, nothing loads.
            state.queue = items
            state.currentIndex = -1
            state.forayId = nil
            state.closed = false
        case let .playIndex(index, startSec, source): playIndex(index, startSec: startSec, source: source)
        case let .setRate(rate): setRate(rate)
        case let .seek(sec, precise):
            // The manager's own `seek`: straight to the reducer, which holds it
            // for a load in flight and refuses it with nothing loaded.
            dispatch(.seek(seconds: sec, precise: precise))
        }
    }

    // MARK: - Transport

    private mutating func playIndex(_ index: Int, startSec: Double?, source: EngineSource) {
        guard state.queue.indices.contains(index) else { return refuse(.notLoaded) }
        begin(.playIndex(index, startSec: startSec), source: source)
    }

    /// `resume()`: play the current item. While the transport already runs,
    /// the reducer answers (the same item loading or playing is a no-op) and no
    /// session or grace is involved.
    private mutating func play(source: EngineSource) {
        guard let item = state.currentItem else { return refuse(.notLoaded) }
        if state.isRunning { return dispatch(.play(item.ref)) }
        begin(.resume, source: source)
    }

    /// `pause()`. THE POSTCONDITION IS SILENCE (#689 report 3): the reducer's
    /// `interruptionBegan` is idempotent and emits no pause from `interrupted`,
    /// so a deck audible while the machine says paused is paused here, by the
    /// deck's own word, never the reverse.
    private mutating func pause(source: EngineSource) {
        state.pausedByListener = true
        stopRow(.pause, source: source)
        dispatch(.interruptionBegan)
        if audibleNow {
            diag("pause", [JSONMember("kind", .string("forced")),
                           JSONMember("why", .string("the deck was audible while the machine said paused"))])
            deckCommand(.pause)
        }
        applySession(SessionPolicy.transition(from: state.session, on: .pause, holdPolicy: state.holdPolicy))
        armHoldTimerIfPaused()
    }

    /// TOGGLE FROM NATIVE TRUTH: `running` is the belief OR the deck's own
    /// word (#689), so a press on a deck the machine thought paused pauses it.
    private mutating func toggle(source: EngineSource) {
        let running = state.isRunning || audibleNow
        let decision = TransportPolicy.resolveToggle(
            want: !running, restored: false, foray: state.forayId != nil, stateType: state.stateType,
            running: running, hasCurrent: state.currentItem != nil, queueLength: Double(state.queue.count))
        switch decision {
        case .pause: pause(source: source)
        case .resume, .load, .playRestored: play(source: source)
        case .startOver: playIndex(0, startSec: nil, source: source)
        case .noChange: break
        }
    }

    /// Next: the queue's next item (bridges stepped over), else the first
    /// continuation hop (`canNext` is the chain, whatever `autoAdvance` says).
    private mutating func next(source: EngineSource) {
        if nextItem(from: cursor, skipBridges: true) != nil { return begin(.skipNext, source: source) }
        if let hop = state.chain.first { return begin(.walkHop(hop), source: source) }
        refuse(.noNext)
    }

    /// Previous RESTARTS the item in place (`skipToPrevious`, the manager's
    /// "restart item"; walking back to `previousHop` is the page's call and
    /// arrives as a playEpisode).
    private mutating func previous(source: EngineSource) {
        guard state.currentItem != nil else { return refuse(.noPrevious) }
        begin(.skipPrevious, source: source)
    }

    /// `seekTo` from the page or the lock screen: clamped the way the page
    /// clamps an episode seek, then `seekAction`: with nothing loaded to seek
    /// in, the target is WRITTEN DOWN as the next play's own start; paused,
    /// loading and playing are the reducer's.
    private mutating func seekTo(_ sec: Double, source: EngineSource) {
        guard let item = state.currentItem else { return refuse(.notLoaded) }
        guard let target = TransportPolicy.clampEpisodeTarget(sec, duration: deck.durationSec ?? item.durationSec) else { return }
        if TransportPolicy.seekAction(restored: false, stateType: state.stateType) == .pend {
            state.pendingStartSec = target
            return
        }
        dispatch(.seek(seconds: target, precise: false))
    }

    private mutating func seekBy(_ deltaSec: Double, source: EngineSource) {
        guard let item = state.currentItem else { return refuse(.notLoaded) }
        let position = (state.loadedId == item.id ? deck.positionSec : nil) ?? state.pendingStartSec ?? 0
        guard let target = TransportPolicy.skipTarget(foray: false, positionSec: position, offsetSec: deltaSec,
                                                      durationSec: deck.durationSec ?? item.durationSec) else { return }
        seekTo(target, source: source)
    }

    /// `stop()`: a close (`persist: true`) or a data deletion (`false`). The
    /// cause row, then the reducer's save and pause, then the session is
    /// released WITH notify: the listener closed the player.
    private mutating func stop(persist: Bool, source: EngineSource) {
        state.pausedByListener = true
        stopRow(persist ? .close : .dataDeletion, source: source)
        state.closed = true
        suppressSave = !persist
        dispatch(.stop)
        suppressSave = false
        applySession(SessionPolicy.transition(from: state.session, on: persist ? .close : .dataDeletion,
                                              holdPolicy: state.holdPolicy))
        if !persist {
            state.positions = [:]
            state.eventMarks = [:]
            state.pendingEvents = []
            state.advanceLog = []
            state.lastEpisodeRow = nil
            state.pendingStartSec = nil
            out.append(.writeRestore(nil))
        }
    }

    /// `setRate(rate)`: snapped onto the ladder, remembered, and handed to the
    /// deck at once (it holds it and re-applies it on every play). A snapped
    /// value says so (product principle 2).
    private mutating func setRate(_ requested: Double?) {
        let snap = PlaybackRate.snap(requested)
        if snap.snapped {
            diag("rate", [JSONMember("kind", .string("snapped")),
                          JSONMember("requested", Rows.finiteOrNull(requested)),
                          JSONMember("applied", .number(snap.applied))])
        }
        state.rate = snap.applied
        deckCommand(.setRate(snap.applied))
    }

    /// The one-way relinquish (plan §4.6): stop WITH persistence, keep the
    /// session active with no deactivate and no notify (so no app 4a
    /// interrupted is invited back), end grace, cancel timers, write the
    /// `{mode: "relinquished"}` record, and go terminal.
    private mutating func relinquish(cap: EngineContract.RelinquishCap, source: EngineSource) {
        stopRow(.relinquish, source: source)
        if state.isRunning {
            state.pausedByListener = true
            dispatch(.interruptionBegan)
        } else {
            persistPosition()
        }
        if audibleNow { deckCommand(.pause) }
        deckCommand(.unload)
        if state.grace != nil { endGrace(.relinquished) }
        if state.positionTimerArmed {
            out.append(.timerCancel(.positionTick))
            state.positionTimerArmed = false
        }
        cancelHoldTimer()
        state.session = SessionPolicy.transition(from: state.session, on: .relinquish, holdPolicy: state.holdPolicy).phase
        state.pendingActivation = nil
        state.pendingLoad = nil
        if let stamp = Rows.timestamp(epochMs: now.wallMs) {
            out.append(.writeRestore(RestoreRecord.relinquished(updatedAt: stamp, build: config.build)))
        }
        diag("mode", [JSONMember("reason", .string(Vocabulary.ModeReason.downgrade.rawValue)),
                      JSONMember("cap", .string(cap.rawValue))])
    }

    // MARK: - Remote commands

    /// A lock-screen, car or headset press. The `remote` row is written FIRST,
    /// before any no-op return (D-4), with `dupCandidate` recorded and nothing
    /// dropped (T-8). A remote stop is a pause (T-7).
    private mutating func onRemote(_ press: RemotePress) {
        var dup = false
        if let last = state.lastRemote, last.command == press.command {
            let gap = now.monoMs - last.atMono
            dup = gap >= 0 && gap < EngineCore.remoteDuplicateWindowMs
        }
        state.lastRemote = LastRemote(command: press.command, atMono: now.monoMs)
        diag("remote", [
            JSONMember("cmd", .string(press.command.rawValue)),
            JSONMember("dupCandidate", .string(dup ? "y" : "n")),
            JSONMember("route", press.routePort.map { JSONNode.string($0) } ?? .null),
            JSONMember("grace", .string(state.grace?.rawValue ?? "none")),
            JSONMember("thread", .string(press.onMain ? "main" : "bg")),
            JSONMember("state", .string(state.stateType))
        ])
        let steps = MediaMapping.SeekSteps()
        switch press.command {
        case .play: play(source: .remote)
        case .pause: pause(source: .remote)
        case .togglePlayPause: toggle(source: .remote)
        case .nextTrack: next(source: .remote)
        case .previousTrack: previous(source: .remote)
        case .skipForward: seekBy(press.value ?? steps.forwardSec, source: .remote)
        case .skipBackward: seekBy(-(press.value ?? steps.backwardSec), source: .remote)
        case .changePlaybackPosition:
            guard let target = press.value else { return refuse(.notLoaded) }
            seekTo(target, source: .remote)
        case .stop:
            switch TransportPolicy.remoteStopAction(close: nil) {
            case .pause: pause(source: .remote)
            case .close: stop(persist: true, source: .remote)
            }
        }
    }

    // MARK: - Beginning a play: grace, the session, then the intent

    /// Every intent that may start audio comes through here. Grace first
    /// (the span is silent from this moment), then `SessionPolicy`: an intent
    /// that needs the session parks behind `.sessionActivate`.
    private mutating func begin(_ intent: DeferredIntent, source: EngineSource) {
        // A play reopens a closed player; an audition is not a play of the
        // queue and leaves the lock screen as the close left it (NE-18).
        if case .audition = intent {} else { state.closed = false }
        if let reason = graceReason(for: intent, source: source) { beginGrace(reason) }
        let via: SessionPolicy.PlayVia
        switch source {
        case .tap: via = .tap
        case .remote, .restore: via = .remote
        case .audition: via = .auditionTap
        case .reconcile, .session, .autoadvance, .autoresume: via = .autoresume
        }
        let transition = SessionPolicy.transition(from: state.session, on: .userPlay(via: via), holdPolicy: state.holdPolicy)
        if transition.actions.contains(.activate) { return requestActivation(intent, source: source) }
        run(intent, source: source)
    }

    /// Which grace span an intent opens, if any (plan §4.4): a remote play, a
    /// tap while backgrounded, an interruption resume, a route resume, a cold
    /// play, and a continuation hop loading in the background.
    private func graceReason(for intent: DeferredIntent, source: EngineSource) -> GraceReason? {
        switch intent {
        case .interruptionResume: return .interruptionResume
        case .routeResume: return .routeResume
        case .coldPlay: return .coldPlay
        case .audition: return nil
        case .walkHop where source == .autoadvance:
            return state.backgrounded ? .autoAdvance : nil
        case .playIndex, .resume, .skipNext, .skipPrevious, .walkHop:
            if source == .remote { return .remotePlay }
            return state.backgrounded ? .backgroundTap : nil
        }
    }

    private mutating func requestActivation(_ intent: DeferredIntent, source: EngineSource) {
        state.lastRequestId += 1
        state.pendingActivation = PendingActivation(requestId: state.lastRequestId, intent: intent, source: source)
        out.append(.sessionActivate(requestId: state.lastRequestId))
    }

    /// The activation's answer, in the same turn. Only then does the parked
    /// intent run; a failure is `.commandFailed(session-failed:<token>)` and
    /// nothing audible (an interruption's resume stays paused).
    private mutating func onSessionResult(_ result: SessionResult) {
        guard let parked = state.pendingActivation, parked.requestId == result.requestId else {
            diag("session", [JSONMember("kind", .string("result-unexpected")),
                             JSONMember("requestId", .number(Double(result.requestId)))])
            return
        }
        state.pendingActivation = nil
        let transition = SessionPolicy.transition(from: state.session, on: .sessionResult(ok: result.ok, token: result.error),
                                                  holdPolicy: state.holdPolicy)
        state.session = transition.phase
        diag("session", [
            JSONMember("kind", .string("activate")),
            JSONMember("ok", .bool(result.ok)),
            JSONMember("activateMs", Rows.finiteOrNull(result.activateMs)),
            JSONMember("reason", transition.reason.map { JSONNode.string($0) } ?? .null)
        ])
        guard result.ok else {
            out.append(.commandFailed(reason: transition.reason ?? SessionPolicy.sessionFailedReason(result.error)))
            if parked.intent == .interruptionResume { dispatch(.interruptionEnded(shouldResume: false)) }
            return
        }
        state.activatedInProcess = true
        cancelHoldTimer()
        run(parked.intent, source: parked.source)
    }

    /// The intent itself, once the session allows sound.
    private mutating func run(_ intent: DeferredIntent, source: EngineSource) {
        switch intent {
        case let .playIndex(index, startSec):
            guard state.queue.indices.contains(index) else { return refuse(.notLoaded) }
            state.currentIndex = index
            state.pausedByListener = false
            state.pausedByRoute = false
            // `Number.isFinite(at) && at >= 0 ? at : null`: the listener's own
            // destination rides on the LOAD, so nothing is audible from the
            // wrong second and no second step can race it.
            let explicit: Double? = startSec.flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
            dispatch(.play(state.queue[index].ref), offsets: LoadOffsets(explicit: explicit))
        case .resume:
            guard let item = state.currentItem else { return refuse(.notLoaded) }
            state.pausedByListener = false
            state.pausedByRoute = false
            let explicit = state.pendingStartSec
            state.pendingStartSec = nil
            dispatch(.play(item.ref), offsets: LoadOffsets(explicit: explicit))
        case .skipNext:
            guard let next = nextItem(from: cursor, skipBridges: true) else { return refuse(.noNext) }
            // currentIndex is NOT advanced here: the reducer's skip saves the
            // outgoing position first, against what is loaded. `load` moves it.
            state.targetIndex = next.index
            dispatch(.skipToNext(next.item.ref))
        case .skipPrevious:
            // "Restart" must mean zero, or the save the reducer emits first
            // would make the reload resume exactly where the press left.
            dispatch(.skipToPrevious(nil), offsets: LoadOffsets(forced: 0))
        case .interruptionResume:
            dispatch(.interruptionEnded(shouldResume: true), offsets: LoadOffsets(rewind: true))
        case .routeResume:
            guard let item = state.currentItem else { return }
            state.pausedByRoute = false
            dispatch(.play(item.ref))
        case .coldPlay:
            guard let item = state.currentItem else { return refuse(.notLoaded) }
            dispatch(.play(item.ref))
        case let .walkHop(hop): walk(hop, source: source)
        case let .audition(text, voiceId): out.append(.speak(text: text, voiceId: voiceId))
        }
    }

    // MARK: - The reducer and its effects

    private mutating func dispatch(_ event: PlayerEvent, offsets: LoadOffsets = LoadOffsets()) {
        let (next, effects) = PlayerQueueState.reduce(state: state.player, event: event)
        state.player = next
        for effect in effects { perform(effect, offsets: offsets) }
    }

    /// Every effect has a case (`_perform`): a missed effect is a stuck player.
    private mutating func perform(_ effect: PlayerEffect, offsets: LoadOffsets) {
        switch effect {
        case let .loadItem(ref): load(ref, offsets: offsets)
        case .startPlayback: startPlayback()
        case .pausePlayback: deckCommand(.pause)
        case .savePosition: if !suppressSave { persistPosition() }
        case let .seekTo(seconds, _): deckCommand(.seek(toSec: seconds))
        case let .seekRejected(reason):
            diag("seek", [JSONMember("kind", .string("rejected")), JSONMember("reason", .string(reason))])
        case let .setOutPoint(seconds): deckCommand(.setOutPoint(sec: seconds))
        case .resetRateForTTS:
            // Corner case #18: a rendered narration line plays at NARRATION_RATE,
            // never the listener's speed.
            deckCommand(.setRate(EngineConstants.QueueManager.narrationRate))
        case .restoreRate: deckCommand(.setRate(state.rate))
        case .playTransitionTTS:
            // Bridges and narration are M2 (NE-31s). Until then a bridge is
            // stepped over the way a bridge that failed to load is
            // (`_advancePastBridgeFailure`): a missing line never stalls the
            // queue (corner case #12).
            let next = nextItem(from: cursor, skipBridges: true)
            dispatch(.itemEnded(next: next?.item.ref, bridged: false))
        case .emitTelemetry: break
        }
    }

    /// `_loadItem(ref)`: where the load starts, decided in the JS order, then
    /// one `.load` with a fresh token. The index moves NOW (after the outgoing
    /// save already ran); the loaded id moves only when `.ready` comes back.
    private mutating func load(_ ref: QueueItemRef, offsets: LoadOffsets) {
        guard let item = state.queue.first(where: { $0.id == ref.id }) else {
            return dispatch(.error("loadItem: unknown ref \(ref.id)"))
        }
        let bounds = item.bounds
        state.targetIndex = nil
        let playhead = deck.positionSec
        let readable = playhead.map { $0.isFinite } ?? false
        // RE-ENTERING THE ITEM THE DECK HOLDS is a resume in place (#689), never
        // from the end of a finished item (audit 2026-09-22), and never when a
        // restart or the listener's own destination was asked for.
        let reEntering = offsets.forced == nil && offsets.explicit == nil && state.loadedId == item.id
            && readable && !deck.ended
        var inPlace = false
        if reEntering, let at = playhead {
            if let b = bounds {
                inPlace = at > b.startSec && at < b.endSec
            } else {
                // A bridge is one authored line: there is no "where I was".
                inPlace = item.kind != .tts && at > 0
            }
        }
        // An explicit offset beats the in-point only from INSIDE the slice
        // (#65 §4: never the stranger's episode before it).
        var explicitInside: Double?
        if let explicit = offsets.explicit {
            if let b = bounds {
                if explicit >= b.startSec && explicit < b.endSec { explicitInside = explicit }
            } else {
                explicitInside = explicit
            }
        }
        let startSec: Double
        if let explicit = explicitInside {
            startSec = explicit
        } else if inPlace, let at = playhead {
            // An OS interruption's should-resume steps back INTERRUPTION_REWIND_SEC,
            // never before the item's own start (plan §4.4, NE-14j).
            startSec = offsets.rewind
                ? (TransportPolicy.interruptionResumeOffset(playheadSec: at, startSec: bounds?.startSec) ?? at)
                : at
        } else if let b = bounds {
            // A segment's in-point overrides any saved position, always.
            startSec = b.startSec
        } else if let forced = offsets.forced {
            startSec = forced
        } else {
            startSec = item.kind == .tts ? 0 : savedPosition(for: item)
        }
        if let index = state.queue.firstIndex(where: { $0.id == item.id }) { state.currentIndex = index }
        state.lastToken += 1
        let token = state.lastToken
        state.pendingLoad = PendingLoad(token: token, itemId: item.id)
        deckCommand(.load(token: token, itemId: item.id, url: item.audioUrl, startSec: startSec,
                          preciseTiming: bounds != nil))
    }

    /// `_savedPositionFor(item)`: where a COLD start begins, through the one
    /// owner of "where did the listener get to" (`ResumeRules.resumeOffset`:
    /// nothing under 10 s, nothing inside the last 30 s).
    private func savedPosition(for item: EngineItem) -> Double {
        let duration: Double? = item.durationSec.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
        let seconds = ResumeRules.resumeOffset(for: state.positions[item.id], duration: duration)
        return seconds.isFinite && seconds > 0 ? seconds : 0
    }

    /// `startPlayback`. The session backstop: without an active session this
    /// refuses and says so, whatever path got here. A play that did start
    /// stamps the page's `lastEpisodeRow` (it "actually plays" now) and the
    /// restore record.
    private mutating func startPlayback() {
        guard state.session == .active else {
            diag("fault", [JSONMember("kind", .string("no-session")),
                           JSONMember("session", .string(state.session.rawValue))])
            out.append(.commandFailed(reason: EngineContract.Refusal.sessionFailedOther.rawValue))
            return
        }
        deckCommand(.play)
        if let row = state.lastEpisodeRow, !state.lastEpisodeRowWritten,
           row["id"]?.stringValue == state.loadedId,
           let stamp = Rows.timestamp(epochMs: now.wallMs),
           let stored = EngineCore.lastEpisodeRow(row, updatedAt: stamp) {
            out.append(.writeRow(stored))
            state.lastEpisodeRowWritten = true
        }
        writeRestore()
    }

    /// `cp_last_episode` as the ENGINE writes it (plan §5.2): the page's
    /// `lastEpisodeRow` VERBATIM, in the page's key order, with `updated_at`
    /// stamped by the engine when the item plays (replacing a stale stamp in
    /// place, as `{...row, updated_at}` does in JS). A row with no non-empty
    /// string id is not a pointer and writes nothing. Pinned byte for byte by
    /// `manager-episode/last-episode-row-*` against rows.js
    /// `engineLastEpisodeRow`.
    public static func lastEpisodeRow(_ row: JSONNode, updatedAt: String) -> StoredRow? {
        guard case var .object(members) = row, let id = row["id"]?.stringValue, !id.isEmpty else { return nil }
        if let at = members.firstIndex(where: { $0.key == "updated_at" }) {
            members[at] = JSONMember("updated_at", .string(updatedAt))
        } else {
            members.append(JSONMember("updated_at", .string(updatedAt)))
        }
        return StoredRow(key: Rows.lastEpisodeKey, value: JSWriter.stringify(.object(members)))
    }

    // MARK: - Deck events

    private mutating func onDeck(_ event: DeckEvent) {
        switch event {
        case let .ready(token, _, _, _): onReady(token)
        case let .failed(token, message): onLoadFailure(token, message: message, cause: .error)
        case let .deadlineExceeded(token, afterMs):
            onLoadFailure(token, message: "no ready inside \(afterMs) ms", cause: .loadDeadline)
        case let .ended(token): onEnded(token)
        case let .timeControl(token, status, _): onTimeControl(token, status: status)
        case let .pausedUncommanded(token, _): onUncommandedPause(token)
        case let .stalled(token): if token == state.loadedToken { state.buffering = true }
        case let .durationLoaded(token, durationSec):
            diag("deck", [JSONMember("kind", .string("duration")), JSONMember("token", .number(Double(token))),
                          JSONMember("durationSec", Rows.finiteOrNull(durationSec))])
        case let .notReady(token, attempt, cause):
            diag("deck", [JSONMember("kind", .string("not-ready")), JSONMember("token", .number(Double(token))),
                          JSONMember("attempt", .number(Double(attempt))), JSONMember("cause", .string(cause))])
        case let .refused(command, reason):
            diag("deck", [JSONMember("kind", .string("refused")), JSONMember("command", .string(command)),
                          JSONMember("reason", .string(reason))])
        case .seeked: break
        }
    }

    /// A load landed. Only the load that owns the deck continues (corner case
    /// #19): a superseded one is logged and plays nothing, stamps nothing.
    private mutating func onReady(_ token: DeckToken) {
        guard let pending = state.pendingLoad, pending.token == token else {
            return diag("deck", [JSONMember("kind", .string("superseded")), JSONMember("token", .number(Double(token)))])
        }
        state.pendingLoad = nil
        state.loadedId = pending.itemId
        state.loadedToken = token
        state.startingHop = nil
        // The ADR-0007 gate and the seam beat run here in M2 (NE-30s).
        dispatch(.itemLoaded)
    }

    /// A load (or the item it loaded) failed. A failure nobody is waiting on
    /// any more is not the CURRENT item failing; otherwise the cause row, the
    /// page's error (`chain-start` for a hop, C-6), then the reducer's error
    /// (idle, pause).
    private mutating func onLoadFailure(_ token: DeckToken, message: String, cause: Vocabulary.StopCause) {
        let isPending = state.pendingLoad?.token == token
        let isHeld = state.pendingLoad == nil && state.loadedToken == token
        guard isPending || isHeld else {
            return diag("deck", [JSONMember("kind", .string("superseded-failure")), JSONMember("token", .number(Double(token)))])
        }
        let itemId = state.pendingLoad?.itemId ?? state.loadedId ?? "?"
        state.pendingLoad = nil
        stopRow(cause)
        if state.startingHop != nil {
            state.startingHop = nil
            out.append(.emit(.error(code: "chain-start", message: message)))
        } else {
            out.append(.emit(.error(code: "load", message: message)))
        }
        dispatch(.error("loadItem(\(itemId)) failed: \(message)"))
    }

    /// `_handleBackendItemEnded`: the item ran out. The queue's next item, or
    /// the next continuation hop when `autoAdvance` is on, or the end.
    private mutating func onEnded(_ token: DeckToken) {
        guard token == state.loadedToken else {
            return diag("deck", [JSONMember("kind", .string("stale-ended")), JSONMember("token", .number(Double(token)))])
        }
        switch state.player {
        case .transitioning:
            let next = nextItem(from: cursor, skipBridges: true)
            dispatch(.itemEnded(next: next?.item.ref, bridged: false))
        case .playing:
            if let next = nextItem(from: cursor, skipBridges: false) {
                // The seam beat and the interlude between two items are M2's
                // (NE-30s/NE-31s).
                return dispatch(.itemEnded(next: next.item.ref, bridged: next.item.kind == .tts))
            }
            if state.autoAdvance, let hop = state.chain.first {
                dispatch(.itemEnded(next: nil, bridged: false))
                return begin(.walkHop(hop), source: .autoadvance)
            }
            if state.autoAdvance {
                diag("continuation", [JSONMember("kind", .string("chain-exhausted"))])
            }
            stopRow(state.forayId != nil ? .finalEnd : .ended)
            dispatch(.itemEnded(next: nil, bridged: false))
            applySession(SessionPolicy.transition(from: state.session, on: .finalEnd, holdPolicy: state.holdPolicy))
        case .idle, .loadingItem, .interrupted, .ended:
            diag("deck", [JSONMember("kind", .string("ended-ignored")), JSONMember("state", .string(state.stateType))])
        }
    }

    private mutating func onTimeControl(_ token: DeckToken, status: DeckTimeControl) {
        guard token == state.loadedToken else { return }
        switch status {
        case .playing:
            state.buffering = false
            if state.grace != nil { endGrace(.playing) }
        case .waiting: state.buffering = true
        case .paused: break
        }
    }

    /// Observe, don't believe (plan §4.3 Q-9): the deck stopped and nobody
    /// here asked it to. Within 500 ms of a route going away it is the
    /// route's; otherwise the system's; either way the machine is corrected
    /// towards paused, never the reverse.
    private mutating func onUncommandedPause(_ token: DeckToken) {
        guard token == state.loadedToken else { return }
        state.lastUncommandedPauseAtMono = now.monoMs
        deck.audible = false
        var routeAttributed = false
        if let lost = state.lastRouteLostAtMono {
            let gap = now.monoMs - lost
            routeAttributed = gap >= 0 && gap <= EngineCore.routeAttributionMs
        }
        reconcile(unexplainedPause: true, routeAttributed: routeAttributed)
    }

    /// `reconcileWithBackend(why)`: correct the machine against what the deck
    /// is doing. Only ever towards paused from `playing` (it never calls
    /// play); towards `playing` from `interrupted` only on the deck's own word
    /// that THIS item is audible (`elementResumed` carries no play).
    private mutating func reconcile(unexplainedPause: Bool, routeAttributed: Bool) {
        if case let .interrupted(item, _) = state.player {
            guard audibleNow, let current = state.currentItem, state.loadedId == current.id, item.id == current.id else { return }
            return dispatch(.elementResumed)
        }
        guard case .playing = state.player else { return }
        guard !deck.audible else { return }
        guard !deck.ended else {
            return diag("reconcile", [JSONMember("kind", .string("skipped-ended"))])
        }
        stopRow(routeAttributed ? .routeChange : .systemPause)
        // The OS took the audio; the listener did not press anything.
        state.pausedByListener = false
        // WHO took it decides whether a should-resume may bring it back: a
        // foreground reconcile finding the deck stopped is the #263 route case,
        // which corner case #13 says never resumes by itself.
        if routeAttributed || !unexplainedPause { state.pausedByRoute = true }
        dispatch(.interruptionBegan)
    }

    // MARK: - The audio session's notifications

    private mutating func onSession(_ event: SessionEvent) {
        switch event {
        case let .interruptionBegan(raw): onInterruptionBegan(raw)
        case let .interruptionEnded(shouldResume): onInterruptionEnded(shouldResume)
        case let .route(change): onRoute(change)
        case .mediaServicesReset: onMediaServicesReset()
        }
    }

    /// Interruptions by REASON (plan §4.4): a muted built-in mic and a stale
    /// `appWasSuspended` are rows, not stops; anything else takes the session
    /// and pauses (`interruptionBegan()`), with its cause row first.
    private mutating func onInterruptionBegan(_ raw: String?) {
        let reason = SessionPolicy.interruptionReason(raw)
        let running = state.isRunning || audibleNow
        let transition = SessionPolicy.transition(
            from: state.session,
            on: .interruptionBegan(reason: reason, running: running, activatedInProcess: state.activatedInProcess),
            holdPolicy: state.holdPolicy)
        diag("session", [JSONMember("kind", .string("interruption")), JSONMember("phase", .string("began")),
                         JSONMember("reason", .string(reason.rawValue)), JSONMember("running", .bool(running))])
        if transition.row == .micMuted || transition.row == .staleSuspension {
            return applySession(transition)
        }
        stopRow(.interruption)
        applySession(transition)
        dispatch(.interruptionBegan)
    }

    /// `interruptionEnded(shouldResume)`: ONLY AN INTERRUPTION THE OS CAUSED IS
    /// RESUMED (not a listener's pause, not a lost route), and the resume is
    /// request/response: activate, then the in-place load that steps back
    /// INTERRUPTION_REWIND_SEC, holding grace until the deck plays.
    private mutating func onInterruptionEnded(_ shouldResume: Bool) {
        let resume = shouldResume && !state.pausedByListener && !state.pausedByRoute
        if shouldResume && !resume {
            diag("session", [JSONMember("kind", .string("interruption")), JSONMember("phase", .string("ended")),
                             JSONMember("resumed", .bool(false)),
                             JSONMember("why", .string(state.pausedByRoute ? "route-lost" : "listener-paused"))])
        }
        var wasPlaying = false
        if case let .interrupted(_, playing) = state.player { wasPlaying = playing }
        let transition = SessionPolicy.transition(from: state.session,
                                                  on: .interruptionEnded(shouldResume: resume, wasPlaying: wasPlaying),
                                                  holdPolicy: state.holdPolicy)
        let resuming = resume && wasPlaying
        if transition.actions.contains(.activate) {
            if resuming { beginGrace(.interruptionResume) }
            return requestActivation(.interruptionResume, source: .session)
        }
        applySession(transition)
        if resuming && state.session != .active {
            // Released while paused (hold policy none): the resume activates
            // like any other play.
            return begin(.interruptionResume, source: .autoresume)
        }
        if resuming { beginGrace(.interruptionResume) }
        dispatch(.interruptionEnded(shouldResume: resume), offsets: LoadOffsets(rewind: resume))
    }

    /// `routeChanged(...)` (corner case #13): a lost route pauses and is not
    /// resumable by a later call; a route reappearing resumes only a car this
    /// engine has seen before, never headphones being plugged in.
    private mutating func onRoute(_ change: RouteChange) {
        if change.isCarRoute, let name = change.routeName { state.knownCarRoutes.insert(name) }
        diag("session", [JSONMember("kind", .string("route")),
                         JSONMember("oldDeviceUnavailable", .bool(change.oldDeviceUnavailable)),
                         JSONMember("port", change.portType.map { JSONNode.string($0) } ?? .null)])
        if change.oldDeviceUnavailable {
            state.lastRouteLostAtMono = now.monoMs
            state.pausedByRoute = true
            if let paused = state.lastUncommandedPauseAtMono, now.monoMs - paused >= 0,
               now.monoMs - paused <= EngineCore.routeAttributionMs {
                // The deck's pause came first and was reconciled as the
                // system's; the route is why (plan §4.3, either order).
                diag("session", [JSONMember("kind", .string("route-attributed")), JSONMember("to", .string("pause"))])
            }
            stopRow(.routeChange)
            dispatch(.routeChanged(oldDeviceUnavailable: true))
        } else {
            dispatch(.routeChanged(oldDeviceUnavailable: false))
        }
        guard !change.oldDeviceUnavailable, let name = change.routeName, state.knownCarRoutes.contains(name),
              state.currentItem != nil, case .interrupted(_, true) = state.player else { return }
        diag("session", [JSONMember("kind", .string("route-resume")), JSONMember("knownCar", .bool(true))])
        begin(.routeResume, source: .autoresume)
    }

    /// Media services were reset: the session is gone and every AVFoundation
    /// object with it. Re-apply the category, rebuild, and land paused and NOT
    /// resumable (`interrupted(wasPlaying: false)`): the deck holds nothing,
    /// so the next play rebuilds from the saved position.
    private mutating func onMediaServicesReset() {
        let transition = SessionPolicy.transition(from: state.session, on: .mediaServicesReset, holdPolicy: state.holdPolicy)
        stopRow(.mediaServicesReset)
        applySession(transition)
        dispatch(.interruptionBegan)
        dispatch(.interruptionEnded(shouldResume: false))
        deckCommand(.unload)
        state.loadedId = nil
        state.loadedToken = nil
        state.pendingLoad = nil
    }

    // MARK: - Lifecycle and timers

    private mutating func onLifecycle(_ event: LifecycleEvent) {
        switch event {
        case let .coldLaunch(queue, index, autoplay):
            // `restoreColdLaunchState`: queue and position from local state,
            // before any network call (corner case #15). The offset rides on
            // the load, so nothing is ever audible from the wrong second.
            state.queue = queue
            state.currentIndex = -1
            state.closed = false
            guard queue.indices.contains(index) else {
                return diag("restore", [JSONMember("kind", .string("bad-index"))])
            }
            state.currentIndex = index
            if autoplay { begin(.coldPlay, source: .restore) }
        case .background:
            state.backgrounded = true
            flushPosition()
        case .terminating:
            flushPosition()
        case .foreground:
            state.backgrounded = false
            reconcile(unexplainedPause: false, routeAttributed: false)
        }
    }

    private mutating func onTimer(_ timer: EngineTimer) {
        switch timer {
        case .positionTick: persistIfDue()
        case .graceExpired:
            guard state.grace != nil else { return }
            // The deterministic outcome (plan §4.4): end the task, say so,
            // and pause, as the listener's own pause would.
            endGrace(.expired)
            stopRow(.graceExpired)
            state.pausedByListener = true
            dispatch(.interruptionBegan)
            applySession(SessionPolicy.transition(from: state.session, on: .pause, holdPolicy: state.holdPolicy))
        case .holdExpired:
            state.holdTimerArmed = false
            applySession(SessionPolicy.transition(from: state.session, on: .holdExpired(running: state.isRunning),
                                                  holdPolicy: state.holdPolicy))
        }
    }

    // MARK: - Continuation (plan §5.5)

    /// Walk one hop: log it (`advanceLog`, acked by the page), tell the page,
    /// and play its item as a playEpisode would, with its own
    /// `lastEpisodeRow`. The outgoing episode's position is saved first
    /// unless it simply ran out.
    private mutating func walk(_ hop: EngineContract.Hop, source: EngineSource) {
        if let at = state.chain.firstIndex(of: hop) { state.chain.removeSubrange(0...at) }
        guard let node = hop.node["item"], let item = EngineItem(node: node) else {
            diag("continuation", [JSONMember("kind", .string("hop-unplayable")), JSONMember("nextId", .string(hop.nextId))])
            out.append(.emit(.error(code: "chain-start", message: "hop \(hop.nextId) carries no playable item")))
            return
        }
        switch state.player {
        case .playing, .interrupted: persistPosition()
        case .idle, .loadingItem, .transitioning, .ended: break
        }
        state.lastAdvanceSeq += 1
        let entry = AdvanceEntry(seq: state.lastAdvanceSeq, hop: hop, atMs: now.wallMs)
        state.advanceLog.append(entry)
        if state.advanceLog.count > EngineCore.advanceLogCap {
            state.advanceLog.removeFirst(state.advanceLog.count - EngineCore.advanceLogCap)
        }
        out.append(.emit(.advanced(entry)))
        diag("continuation", [JSONMember("kind", .string("advanced")), JSONMember("source", .string(source.rawValue)),
                              JSONMember("planSeq", .number(Double(hop.planSeq))),
                              JSONMember("hopSeq", .number(Double(hop.hopSeq)))])
        state.queue = [item]
        state.currentIndex = 0
        state.forayId = nil
        state.lastEpisodeRow = hop.node["lastEpisodeRow"]
        state.lastEpisodeRowWritten = false
        state.startingHop = hop
        state.pausedByListener = false
        state.pausedByRoute = false
        dispatch(.play(item.ref))
        writeRestore()
    }

    // MARK: - Positions, events and the restore record

    /// `_persistPosition`: the playhead the DECK holds for the current item.
    /// A segment has no resume point worth keeping; an item the deck does not
    /// hold has no playhead to write (#689), and one is never fabricated.
    private mutating func persistPosition() {
        guard let item = state.currentItem, item.bounds == nil else { return }
        guard state.loadedId == item.id else {
            return diag("position", [JSONMember("kind", .string("refused")),
                                     JSONMember("item", .string(item.id)),
                                     JSONMember("about", state.loadedId.map { JSONNode.string($0) } ?? .null)])
        }
        guard let seconds = deck.positionSec, seconds.isFinite,
              let stamp = Rows.timestamp(epochMs: now.wallMs),
              let row = Rows.position(id: item.id, seconds: seconds, duration: deck.durationSec, updatedAt: stamp) else { return }
        let duration: Double? = deck.durationSec.flatMap { $0.isFinite ? $0 : nil }
        out.append(.writePosition(PositionWrite(itemId: item.id, seconds: seconds, duration: duration, row: row)))
        state.positions[item.id] = ResumeRules.StoredPosition(seconds: seconds, duration: duration)
        state.lastPersisted = ResumeRules.LastWrite(id: item.id, seconds: seconds)
        if let event = ResumeRules.positionEvent(lastEmitted: state.eventMarks[item.id], seconds: seconds, duration: duration) {
            state.eventMarks[item.id] = event.mark
            appendEvent(episodeId: item.id, seconds: event.seconds, duration: event.duration)
        }
        writeRestore()
    }

    /// client.js `flushPositions` (corner case #17, #689): pocketing the phone
    /// must not lose the position, so the app leaving the foreground or being
    /// terminated writes the playhead NOW, playing or paused, whatever the
    /// cadence last wrote. EngineStore writes it synchronously (NE-19), so the
    /// row is in `UserDefaults` before the notification handler returns.
    /// `persistPosition` keeps its own refusals: no item, a segment, or an
    /// item the deck does not hold writes nothing.
    private mutating func flushPosition() {
        guard state.currentItem != nil else { return }
        persistPosition()
    }

    /// `_persistIfDue`: the periodic write, while playing, when the playhead
    /// has moved enough on this item since the last write by anyone.
    private mutating func persistIfDue() {
        guard case .playing = state.player, let item = state.currentItem, item.bounds == nil,
              state.loadedId == item.id,
              ResumeRules.positionTickDue(last: state.lastPersisted, id: item.id, seconds: deck.positionSec) else { return }
        persistPosition()
    }

    private mutating func appendEvent(episodeId: String, seconds: Double, duration: Double?) {
        state.lastEventSeq += 1
        let event = PendingEvent(seq: state.lastEventSeq, kind: "position", episodeId: episodeId,
                                 seconds: seconds, duration: duration, atMs: now.wallMs)
        state.pendingEvents.append(event)
        if state.pendingEvents.count > EngineCore.pendingEventsCap {
            state.pendingEvents.removeFirst(state.pendingEvents.count - EngineCore.pendingEventsCap)
        }
        out.append(.appendEvent(event))
    }

    /// The engine-private restore record (plan §4.5): what a cold launch
    /// needs to paint and to play without the page.
    private mutating func writeRestore() {
        guard !state.queue.isEmpty, let stamp = Rows.timestamp(epochMs: now.wallMs) else { return }
        let current = state.currentItem
        var offset: Double = 0
        if let current, state.loadedId == current.id, let at = deck.positionSec, at.isFinite {
            offset = at
        } else if let current, let saved = state.positions[current.id] {
            offset = saved.seconds
        }
        let record = RestoreRecord(
            mode: state.forayId != nil ? .foray : .episode,
            queue: state.queue.map(\.node),
            index: Swift.max(0, state.currentIndex),
            offsetSec: offset,
            forayId: state.forayId,
            rate: state.rate,
            advanceLog: state.advanceLog.map(\.node),
            pendingEvents: state.pendingEvents.map(\.node),
            updatedAt: stamp,
            build: config.build)
        out.append(.writeRestore(record))
    }

    // MARK: - Grace, the session, timers, rows

    private mutating func beginGrace(_ reason: GraceReason) {
        guard state.grace == nil else { return }
        state.grace = reason
        out.append(.graceBegin(reason))
    }

    private mutating func endGrace(_ outcome: GraceOutcome) {
        guard state.grace != nil else { return }
        state.grace = nil
        out.append(.graceEnd(outcome))
    }

    /// Apply a `SessionPolicy` transition: the phase, its actions as commands,
    /// and its row.
    private mutating func applySession(_ transition: SessionPolicy.Transition) {
        state.session = transition.phase
        for action in transition.actions {
            switch action {
            case .deactivate: out.append(.sessionDeactivate(notifyOthers: false))
            case .deactivateNotify: out.append(.sessionDeactivate(notifyOthers: true))
            case .reapplyCategory: out.append(.sessionReapplyCategory)
            case .rebuild: out.append(.sessionRebuild)
            case .commandFailed: out.append(.commandFailed(reason: transition.reason ?? SessionPolicy.sessionFailedReason(nil)))
            case .activate: break // only `begin` and `onInterruptionEnded` ask, through requestActivation
            }
        }
        if let row = transition.row {
            diag("session", [JSONMember("kind", .string(row.rawValue))])
        }
    }

    /// `pauseHoldPolicy = .until(m)`: a paused, active session is released
    /// after m minutes (plan §4.4; OQ-12 decides whether it ships).
    private mutating func armHoldTimerIfPaused() {
        guard case let .until(minutes) = state.holdPolicy, state.session == .active, !state.isRunning,
              !state.holdTimerArmed else { return }
        state.holdTimerArmed = true
        out.append(.timerArm(.holdExpired, afterMs: Double(minutes) * 60_000, repeating: false))
    }

    private mutating func cancelHoldTimer() {
        guard state.holdTimerArmed else { return }
        state.holdTimerArmed = false
        out.append(.timerCancel(.holdExpired))
    }

    /// EVERY STOP PATH WRITES ITS CAUSE FIRST, before the command that
    /// silences anything, so a Copy pasted after a drive says why the audio
    /// stopped. Only when something was running or audible: an
    /// `appWasSuspended` on a paused player is not a stop (plan §4.4).
    private mutating func stopRow(_ cause: Vocabulary.StopCause, source: EngineSource? = nil) {
        guard state.isRunning || audibleNow else { return }
        var fields = [JSONMember("cause", .string(cause.rawValue))]
        if let source { fields.append(JSONMember("source", .string(source.rawValue))) }
        fields.append(JSONMember("item", state.currentItem.map { JSONNode.string($0.id) } ?? .null))
        fields.append(JSONMember("positionSec", Rows.finiteOrNull(deck.positionSec)))
        fields.append(JSONMember("state", .string(state.stateType)))
        out.append(.diag(DiagEntry(kind: "stop", fields: fields)))
    }

    private mutating func diag(_ kind: String, _ fields: [JSONMember]) {
        out.append(.diag(DiagEntry(kind: kind, fields: fields)))
    }

    private mutating func refuse(_ refusal: EngineContract.Refusal) {
        out.append(.commandFailed(reason: refusal.rawValue))
    }

    /// Emit a deck command and keep the turn's view of the deck in step.
    private mutating func deckCommand(_ command: DeckCommand) {
        out.append(.deck(command))
        switch command {
        case let .load(_, _, _, startSec, _):
            deck.positionSec = startSec
            deck.audible = false
            deck.ended = false
            deckMovedThisTurn = true
        case .play:
            deck.audible = true
            deckMovedThisTurn = true
        case .pause:
            deck.audible = false
            deckMovedThisTurn = true
        case let .seek(toSec):
            deck.positionSec = toSec
        case .unload:
            deck = DeckReading(positionSec: nil, durationSec: nil, audible: false, ended: false)
            deckMovedThisTurn = true
        case .setRate, .setOutPoint:
            break
        }
    }

    /// `elementIsAudible`: the deck's own answer, as the turn has left it.
    private var audibleNow: Bool { deck.audible && !deck.ended }

    /// After every turn: the position timer runs exactly while playing; grace
    /// ends the moment the intent does (a pause, a stop, a failure), or when
    /// the deck was already audible and nothing new was asked of it; the hold
    /// timer never outlives a play.
    private mutating func settleTurn() {
        let playing = state.isPlaying
        if playing && !state.positionTimerArmed {
            state.positionTimerArmed = true
            out.append(.timerArm(.positionTick, afterMs: ResumeRules.positionIntervalMs, repeating: true))
        } else if !playing && state.positionTimerArmed {
            state.positionTimerArmed = false
            out.append(.timerCancel(.positionTick))
        }
        if state.grace != nil && state.pendingActivation == nil {
            if !state.isRunning {
                endGrace(.notRunning)
            } else if playing && now.deck.audible && !now.deck.ended && !deckMovedThisTurn {
                endGrace(.playing)
            }
        }
        if state.isRunning { cancelHoldTimer() }
    }

    // MARK: - Queue lookups

    /// `_cursor()`: the in-flight skip target if one is pending, else what is loaded.
    private var cursor: Int { state.targetIndex ?? state.currentIndex }

    /// `_nextItem(from, skipBridges)`.
    private func nextItem(from: Int, skipBridges: Bool) -> (index: Int, item: EngineItem)? {
        for index in stride(from: from + 1, to: state.queue.count, by: 1) {
            let item = state.queue[index]
            if skipBridges && item.kind == .tts { continue }
            return (index, item)
        }
        return nil
    }
}

/// The offsets one transport action arms for the load it causes, spent by
/// that load (`_forceNextOffset`, `_startOffsetNext`, `_rewindNextResume`).
/// A turn is synchronous, so an offset can never leak into another action's
/// load the way the JS had to guard against.
struct LoadOffsets {
    var forced: Double?
    var explicit: Double?
    var rewind = false

    init(forced: Double? = nil, explicit: Double? = nil, rewind: Bool = false) {
        self.forced = forced
        self.explicit = explicit
        self.rewind = rewind
    }
}
