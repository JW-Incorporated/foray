import Foundation

/// How a core is built: what it cannot learn from an input.
public struct EngineConfig: Equatable {
    /// `CFBundleVersion`, stamped into the restore record.
    public var build: String
    public var holdPolicy: SessionPolicy.HoldPolicy
    /// The listener's stored speed (`cp_rate`); snapped onto the ladder.
    public var rate: Double?
    /// M2's Foray tape (card NE-30s): the `playForay` command, ADR-0007's
    /// load-time ladder, the seam beat and its transport cuts, the standby
    /// deck's prepare, rendered narration bridges and the `cp_foray` cadence.
    /// OFF by default (plan §12: M2 code that changes shared episode paths
    /// merged behind an off-by-default flag); off, `playForay` is refused
    /// `capability-off` and every episode path is exactly M1's. The shipping
    /// boot (EngineBoot) turns it on since NE-37, the M2 flip.
    public var forayTapeEnabled: Bool
    /// `seamGapSec` (`SEAM_GAP_SEC`, 0.5 s: the founder's ruling of
    /// 2026-09-24). Passed straight through, as the JS manager passes it:
    /// `SeamGap` owns what a nonsense length means (no beat).
    public var seamGapSec: Double
    /// NE-32's DeckPair: two decks, the standby one prepared and prerolled at
    /// the next segment's in-point while the current one is audible. OFF by
    /// default; the shipping boot turns it on since NE-37 (plan §4.3). The
    /// core decides nothing on it (it prepares when the deck opens the
    /// prefetch window, which a single deck never opens, and at a spoken
    /// line's start, NE-45s, which a single deck ignores); the host reads it
    /// to choose which deck it builds.
    public var deckPairEnabled: Bool
    /// NE-31s, OQ-3 (founder, 2026-09-24: "1x for now, but maybe we change
    /// later"): a spoken line is uttered at `NARRATION_RATE` whatever the
    /// listener's speed. On, it would ride the listener's rate instead. OFF.
    public var narrationFollowsListenerRate: Bool
    /// The narration pulse (`onNarrationTick`): the surface listens, so the
    /// line's clock repaints and its deadline and suspension checks run. The
    /// JS manager runs its ticker only when a surface listens, so the parity
    /// driver sets this from `setup.narrationTicks`; the app always listens.
    public var narrationPulse: Bool
    /// The host has a jingle player (NE-34's InterludePlayer). Off, no seam
    /// gets a jingle, exactly as a manager built with no `interlude`.
    public var interludeAvailable: Bool
    /// `cp_interlude` as read at boot (`interludeEnabled`, default on).
    public var interludeEnabled: Bool
    /// The silence node (NE-34), capped at `INTERLUDE_CEILING_SEC` from the
    /// out-point. OFF, and the decision is NE-46's (provisional, M3): App
    /// Review 2.5.4 (R21); no suspension inside a seam observed (the M1 car
    /// test, the 2026-09-28 paste); BackgroundGrace holds a task across every
    /// silent span; NE-45 shrinks silent spans to the beat. It is turned on
    /// ONLY by a one-line flag PR that cites a drive paste with at least one
    /// `grace kind=late inSeam=y` row (the detector is `noteLateness`), once
    /// the NE-34 App Review note is in the submission notes. SilenceNode.swift's
    /// header states the same rule.
    public var silenceNodeEnabled: Bool
    /// NE-46: each P-13 load deadline in ms, by class, as the host's deck runs
    /// it (`AVDeck.defaultLoadDeadlineSec`, `defaultLineLoadDeadlineSec`), so
    /// a `.deadlineExceeded` that arrives late (the process was suspended past
    /// it) can say so in a `grace kind=late timer=load-deadline` row. Empty
    /// (the default, every headless test and the parity driver): no load
    /// deadline is checked for lateness. The core decides nothing on it.
    public var loadDeadlineMs: [DeckDeadlineClass: Double]
    /// The listener's narration voice at boot (`voice`), nil for the
    /// synthesiser's own pick.
    public var voiceId: String?
    /// NE-33's SpeechNarrator path. DV-9 (does the session an
    /// `AVSpeechSynthesizer` leaves after `didFinish` still play, locked?) has
    /// no row from the phone yet, and the plan's rule for an unanswered or
    /// inconclusive DV-9 is the PCM path: `write(_:toBufferCallback:)` into
    /// the engine's own `AVAudioEngine` player. On, the synthesizer speaks
    /// directly (`speak`, `pauseSpeaking(at: .word)`) on the application
    /// session instead. OFF. The core decides nothing on it; the host reads
    /// it to choose the narrator's output.
    public var speechDirect: Bool
    /// NE-38rs, the Bluetooth arm of route resume
    /// (`ROUTE_RESUME_BLUETOOTH_DEFAULT`): whether a known Bluetooth route
    /// (A2DP, HFP, LE) that comes back after it paused us resumes by itself.
    /// OFF, provisional (measurements §12, NE-38e verdict `route-back`: the ms
    /// from a Bluetooth `route kind=back` to the car's own `remote play`). The
    /// founder's car is A2DP and sends its own play 7.4 s after connecting,
    /// and AirPods are A2DP too. The shipping boot reads it from the plist
    /// (`ForayEngineRouteResumeBluetooth`, from mobile/ENGINE_DEFAULT.json).
    public var routeResumeBluetooth: Bool
    /// NE-38rs: the install's salt for route keys (`RouteResume.hashedKey`),
    /// kept beside the known set in `ForayEngine.knownRoutes`. Empty in a
    /// headless core (tests, the parity driver).
    public var routeSalt: String
    /// NE-38rs: the known set the host read back from `ForayEngine.knownRoutes`.
    public var knownRoutes: [String]
    /// NE-40, DV-8: the audio session's `.longFormAudio` route-sharing trial.
    /// OFF, and it stays off in every shipping build: M1's car win (#114)
    /// happened on the default route-sharing policy, so the default does not
    /// change without a drive that says it should. The shipping boot turns it
    /// on ONLY from the Developer row's stored choice (`setRouteSharing`,
    /// `ForayEngine.routeSharing`, read at the next launch); nothing in
    /// mobile/ENGINE_DEFAULT.json or the plist can. The core decides nothing
    /// on it; the host builds the session owner with it, and the `build` row
    /// and the Copy header say which policy the launch ran (`routeSharing=`).
    public var routeSharingLongForm: Bool // MEASURE: DV-8 (the G-6 drive's optional .longFormAudio arm). Rows: build routeSharing=, session category routeSharing=.
    /// P-7's CBR exemption (M2 drive, 2026-10-01): a clip whose source is
    /// measured constant-bitrate (`seek_map: "cbr"`) loads and warms WITHOUT
    /// precise timing, which on an MP3 reads the whole file before the clip
    /// can start (`EngineItem.preciseTiming(approximateCBR:)`). OFF until the
    /// Simulator row in docs/ios-native-engine-measurements.md §13 says an
    /// approximate seek into an Info-tagged CBR file does byte arithmetic and
    /// does not follow the Info frame's TOC (which on a 45-minute file is
    /// seconds off). The shipping boot turns it on (EngineBoot) once it does.
    public var approximateCBRClips: Bool

    public init(build: String = "", holdPolicy: SessionPolicy.HoldPolicy = .default, rate: Double? = nil,
                forayTapeEnabled: Bool = false, seamGapSec: Double = SeamGap.defaultGapSec,
                narrationFollowsListenerRate: Bool = false, narrationPulse: Bool = true,
                interludeAvailable: Bool = false, interludeEnabled: Bool = true,
                silenceNodeEnabled: Bool = false, voiceId: String? = nil, speechDirect: Bool = false,
                routeResumeBluetooth: Bool = RouteResume.bluetoothDefault, routeSalt: String = "",
                knownRoutes: [String] = [], loadDeadlineMs: [DeckDeadlineClass: Double] = [:],
                deckPairEnabled: Bool = false, routeSharingLongForm: Bool = false,
                approximateCBRClips: Bool = false) {
        self.build = build
        self.holdPolicy = holdPolicy
        self.rate = rate
        self.forayTapeEnabled = forayTapeEnabled
        self.seamGapSec = seamGapSec
        self.deckPairEnabled = deckPairEnabled
        self.narrationFollowsListenerRate = narrationFollowsListenerRate
        self.narrationPulse = narrationPulse
        self.interludeAvailable = interludeAvailable
        self.interludeEnabled = interludeEnabled
        self.silenceNodeEnabled = silenceNodeEnabled
        self.voiceId = voiceId
        self.speechDirect = speechDirect
        self.routeResumeBluetooth = routeResumeBluetooth
        self.routeSalt = routeSalt
        self.knownRoutes = knownRoutes
        self.loadDeadlineMs = loadDeadlineMs
        self.routeSharingLongForm = routeSharingLongForm
        self.approximateCBRClips = approximateCBRClips
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
    /// P-14, the stall display (plan §4.3; #866): the surface shows
    /// `buffering` from the moment the deck reports
    /// `waitingToPlayAtSpecifiedRate` (a `deck kind=time-control
    /// status=waiting reason=` row) until it reports playing again, with no
    /// debounce. PROVISIONAL (card NE-38): a short waiting spell in the car
    /// flips the lock screen to buffering, which #866's per-item Now Playing
    /// rate latch now publishes honestly. Settled by the `time-control` rows
    /// against the `nowplaying via=rate` rows (NE-38e verdict `rate-latch`,
    /// NE-38f); false would show a stall as playing.
    public static let bufferingWhileWaiting = true // MEASURE: verdict=rate-latch (NE-38e). Rows: deck kind=time-control status=waiting reason=, nowplaying via=rate.
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
    /// `_narrationStopping` (L-05): the `pausePlayback` a stop's reducer emits
    /// must not pause a synthesiser one instruction before the stop stops it.
    private var narrationStopping = false

    public init(config: EngineConfig = EngineConfig(), positions: [String: ResumeRules.StoredPosition] = [:]) {
        self.config = config
        var initial = EngineState()
        initial.holdPolicy = config.holdPolicy
        initial.rate = PlaybackRate.normalize(config.rate)
        initial.positions = positions
        initial.interludeEnabled = config.interludeEnabled
        initial.voiceId = EngineCore.voice(config.voiceId)
        initial.knownRoutes = RouteResume.KnownRoutes(config.knownRoutes)
        state = initial
    }

    /// `typeof id === "string" && id ? id : null`.
    static func voice(_ id: String?) -> String? {
        guard let id, !id.isEmpty else { return nil }
        return id
    }

    /// What a cold boot rebuilt from the engine's private restore record
    /// (card NE-24; plan §4.5): the core, and the queue and index the host
    /// hands it as `.lifecycle(.coldLaunch(autoplay: false))`, which paints
    /// Now Playing at rate 0 and activates nothing (S-3).
    public struct ColdRestore {
        public let core: EngineCore
        public let queue: [EngineItem]
        public let index: Int
    }

    /// A core rebuilt from a restore record, or nil for a record there is
    /// nothing to play from: `relinquished` (the legacy lane owns playback,
    /// §4.6), `foray` (M2, NE-30s: until then a Foray tap relinquishes, so an
    /// M1 build never writes one), an empty queue, or an item with no id.
    ///
    /// What the record carries and a core cannot learn from an input comes
    /// back here: the listener's speed, where the current item was (as the
    /// stored position a cold start resumes from, through `ResumeRules`, the
    /// same rule the JS cold start applies), and the walked hops and pending
    /// events the page has not drained yet, with their sequence numbers, so a
    /// termination loses none of them and the next one written is numbered
    /// after them. The queue and index are NOT set here: they arrive through
    /// the one door, as `coldLaunch`, so the rows and the surface follow.
    public static func restoring(_ record: RestoreRecord, config: EngineConfig) -> ColdRestore? {
        guard record.mode == .episode, !record.queue.isEmpty, record.queue.indices.contains(record.index) else {
            return nil
        }
        let items = record.queue.compactMap(EngineItem.init(node:))
        guard items.count == record.queue.count else { return nil }
        var config = config
        config.rate = record.rate
        let current = items[record.index]
        var positions: [String: ResumeRules.StoredPosition] = [:]
        if record.offsetSec > 0 {
            positions[current.id] = ResumeRules.StoredPosition(seconds: record.offsetSec, duration: current.durationSec)
        }
        var core = EngineCore(config: config, positions: positions)
        let events: [PendingEvent] = record.pendingEvents.compactMap(PendingEvent.init(restored:))
        core.state.pendingEvents = Array(events.suffix(EngineCore.pendingEventsCap))
        core.state.lastEventSeq = events.map(\.seq).max() ?? 0
        let advances: [AdvanceEntry] = record.advanceLog.compactMap(AdvanceEntry.init(restored:))
        core.state.advanceLog = Array(advances.suffix(EngineCore.advanceLogCap))
        core.state.lastAdvanceSeq = advances.map(\.seq).max() ?? 0
        // NE-31s: a cold narration speaks in the voice the listener chose.
        if let voice = EngineCore.voice(record.voiceId) { core.state.voiceId = voice }
        return ColdRestore(core: core, queue: items, index: record.index)
    }

    /// `canNext` (plan §5.5): the queue has a next item (a narration line
    /// counts, NE-39n: Next lands on it), or the continuation chain is
    /// non-empty, REGARDLESS of `autoAdvance` (as the page's
    /// `EPISODE_NAVIGATION.next` does today). A Foray never chains.
    public var canNext: Bool {
        nextItem(from: cursor, skipBridges: false) != nil || (state.forayId == nil && !state.chain.isEmpty)
    }

    /// `seamGapRemainingMs`: what is left of the seam beat at `monoMs`, 0 when
    /// no beat is running.
    public func seamGapRemainingMs(atMono monoMs: Double) -> Double {
        guard let until = state.gapUntilMono else { return 0 }
        return Swift.max(0, until - monoMs)
    }

    /// Previous restarts the item in place, so it exists whenever one does.
    public var canPrevious: Bool { state.currentItem != nil }

    /// `narrationElapsedSec` (NE-31s): the spoken line's wall-time clock at
    /// `monoMs`, nil while the playhead is not a spoken line. What the Foray
    /// clock, the snapshot and the lock screen read for a synth item.
    public func narrationElapsedSec(atMono monoMs: Double) -> Double? {
        state.narration?.elapsedSec(atMono: monoMs)
    }

    // MARK: - The one door

    public mutating func handle(_ input: EngineInput, now: EngineNow) -> [EngineCommand] {
        if state.session == .relinquished || state.tornDown { return [] }
        self.now = now
        deck = now.deck
        out = []
        deckMovedThisTurn = false
        noteHeard()
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
            // NE-46: measured BEFORE the input is handled, while the seam and
            // the grace span it may close are still what the timer found.
            noteLateness(input)
            route(input)
        }
        if state.session != .relinquished && !state.tornDown {
            settleRouteResume()
            settleTurn()
        }
        ledgerTimers()
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
        case let .narrator(event): onNarrator(event)
        case let .interlude(event): onInterlude(event)
        case let .preview(event): onPreview(event)
        }
    }

    // MARK: - Page commands

    private mutating func onCommand(_ command: EngineContract.Command, source: EngineSource) {
        if let press = pressName(command) { routePress(press) }
        switch command {
        case let .playEpisode(item, startSec, _, lastEpisodeRow):
            guard let episode = EngineItem(node: item.node) else { return refuse(.notLoaded) }
            // LEAVING IS A FLUSH (audit round 2, player-3): the outgoing
            // episode's playhead is written before the queue stops naming it
            // (client.js `play` calls `flushPositions` before
            // `setQueueFromPick`), so a scrub made while paused survives
            // playing something else.
            flushPosition()
            // `loadQueue([item])` then `play(0, {startOffset})`: the page's own
            // path for an episode, with the row it will read back.
            state.queue = [episode]
            state.currentIndex = -1
            state.forayId = nil
            state.forayTitle = nil
            state.lastEpisodeRow = lastEpisodeRow
            state.lastEpisodeRowWritten = false
            state.startingHop = nil
            playIndex(0, startSec: startSec, source: source)
        case let .playForay(args):
            // Off (M1, and M2 until NE-37) the page relinquishes before a Foray.
            guard config.forayTapeEnabled else { return refuse(.capabilityOff) }
            playForay(args, source: source)
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
        case let .setVoice(voiceId):
            // `setVoice(id)`: the NEXT line speaks in it (a synthesiser cannot
            // swap voices mid-utterance), and a cold narration too.
            state.voiceId = EngineCore.voice(voiceId)
            diag("narration", [JSONMember("kind", .string("voice")),
                               JSONMember("chosen", .bool(state.voiceId != nil))])
            writeRestore()
        case let .setInterludeEnabled(on):
            // A preference about the rest of the hour, not a transport action:
            // a jingle already sounding is not cut (queue-manager.js).
            if on != state.interludeEnabled {
                diag("interlude", [JSONMember("kind", .string("enabled")), JSONMember("on", .bool(on))])
            }
            state.interludeEnabled = on
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
        case let .audition(text, voiceId, url):
            // OQ-5: refused while running; otherwise the engine's own
            // synthesiser speaks it after a SessionPolicy activation. NE-47:
            // with a `url` the rendered preview plays on the preview deck
            // under that same activation, the tap's own.
            if state.isRunning || audibleNow { return refuse(.engineBusy) }
            begin(.audition(text: text, voiceId: voiceId, url: url), source: .audition)
        case .setModeOverride, .probeSession, .setRouteSharing:
            // The host's (EngineOwnership NE-17, SessionProbe NE-25c, the
            // route-sharing store NE-40).
            break
        case .simulateTermination:
            // Developer only (NE-24, DV-7a). The record a cold boot restores
            // from is written NOW, from this state; the host exits at the
            // next background entry while paused. Nothing queued is nothing
            // to restore, so there is nothing to simulate.
            guard !state.queue.isEmpty else { return refuse(.notLoaded) }
            writeRestore()
            diag("restore", [JSONMember("kind", .string("sim-termination-armed")),
                             JSONMember("item", state.currentItem.map { JSONNode.string($0.id) } ?? .null)])
        case let .setHoldPolicy(policy): state.holdPolicy = policy
        }
    }

    private mutating func onQueue(_ input: QueueInput) {
        switch input {
        case .playIndex: routePress("play")
        case .seek: routePress("seek")
        case .load, .loadForay, .setRate: break
        }
        switch input {
        case let .load(items):
            // `loadQueue(items)`: the queue is replaced, nothing loads.
            state.queue = items
            state.currentIndex = -1
            state.forayId = nil
            state.closed = false
        case let .loadForay(items, isLocalFile, allowAdPad):
            // `setQueueFromForay(foray, opts)` with the page's build: the same
            // replacement, plus the options the load-time ladder reads.
            state.queue = items
            state.currentIndex = -1
            state.forayId = nil
            state.closed = false
            state.forayIsLocalFile = isLocalFile
            state.forayAllowAdPad = allowAdPad
        case let .playIndex(index, startSec, source): playIndex(index, startSec: startSec, source: source)
        case let .setRate(rate): setRate(rate)
        case let .seek(sec, precise):
            // The manager's own `seek`: straight to the reducer, which holds it
            // for a load in flight and refuses it with nothing loaded. A
            // transport action, so it cuts a running beat (a scrub ends the
            // beat early: the parked load starts at the new second).
            cutSeamGap("seek")
            dispatch(.seek(seconds: sec, precise: precise))
            releaseSeamGap()
        }
    }

    // MARK: - Transport

    private mutating func playIndex(_ index: Int, startSec: Double?, source: EngineSource) {
        guard state.queue.indices.contains(index) else { return refuse(.notLoaded) }
        cutSeamGap("play")
        begin(.playIndex(index, startSec: startSec), source: source)
        releaseSeamGap()
    }

    /// `resume()`: play the current item. While the transport already runs,
    /// the reducer answers (the same item loading or playing is a no-op) and no
    /// session or grace is involved. A FINISHED Foray starts over from its
    /// first item (`endedPlayAction`): play after the end is never a resume
    /// of the last clip's last second.
    private mutating func play(source: EngineSource) {
        guard let item = state.currentItem else { return refuse(.notLoaded) }
        if TransportPolicy.endedPlayAction(foray: state.forayId != nil, stateType: state.stateType) == .startOver {
            return playIndex(0, startSec: nil, source: source)
        }
        cutSeamGap("resume")
        if state.isRunning {
            dispatch(.play(item.ref))
        } else {
            begin(.resume, source: source)
        }
        releaseSeamGap()
    }

    /// `pause()`. THE POSTCONDITION IS SILENCE (#689 report 3): the reducer's
    /// `interruptionBegan` is idempotent and emits no pause from `interrupted`,
    /// so a deck audible while the machine says paused is paused here, by the
    /// deck's own word, never the reverse.
    private mutating func pause(source: EngineSource) {
        // D-5 (NE-40): the cause FIRST, before the seam's cut silences a
        // jingle or the silence node under it.
        stopRow(.pause, source: source)
        cutSeamGap("pause")
        state.pausedByListener = true
        dispatch(.interruptionBegan)
        if audibleNow {
            diag("pause", [JSONMember("kind", .string("forced")),
                           JSONMember("why", .string("the deck was audible while the machine said paused"))])
            deckCommand(.pause)
        }
        applySession(SessionPolicy.transition(from: state.session, on: .pause, holdPolicy: state.holdPolicy))
        armHoldTimerIfPaused()
        releaseSeamGap()
        // A pause is a moment the resume point becomes the thing read back
        // next time (client.js `persistForayProgress({force: true})`).
        persistForay(force: true)
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

    /// Next: the queue's next item, a narration line included (NE-39n), else
    /// the first continuation hop (`canNext` is the chain, whatever
    /// `autoAdvance` says).
    ///
    /// NEXT LANDS ON A LINE (NE-39n, 2026-09-29, provisional; the JS
    /// reference is queue-manager.js `_skipToNext`, and the page's own Next is
    /// client.js `forayNext`, `play(index + 1)` since audit round 3,
    /// player-core-6). This stepped over every `.tts` item, the old
    /// transition-bridge rule, so the car and the lock screen skipped an
    /// authored line the phone's own button would have played, and from the
    /// clip before a closing line ended the Foray unheard. One behaviour on
    /// every surface: from a clip whose next item is a line, Next lands on the
    /// line; from a line, on the item after it. The `manager-foray`
    /// `remote-nexttrack-*-line` and `next-*` fixtures pin both.
    private mutating func next(source: EngineSource) {
        if nextItem(from: cursor, skipBridges: false) != nil {
            cutSeamGap("skipToNext")
            begin(.skipNext, source: source)
            return releaseSeamGap()
        }
        // A Foray is ONE queue: its last item's next is nothing, never a hop
        // (CLAUDE.md principle 1, no chaining).
        if state.forayId == nil, let hop = state.chain.first { return begin(.walkHop(hop), source: source) }
        refuse(.noNext)
    }

    /// Previous RESTARTS the item in place (`skipToPrevious`, the manager's
    /// "restart item"; walking back to `previousHop` is the page's call and
    /// arrives as a playEpisode). In a Foray the Foray clock decides
    /// (`previousAction`): inside the first `restartWindowSec` of a clip it
    /// goes to the one before, otherwise it restarts this one.
    private mutating func previous(source: EngineSource) {
        guard let item = state.currentItem else { return refuse(.noPrevious) }
        if forayTransport {
            let index = state.currentIndex
            let starts = ForayClock.segmentStarts(forayItems)
            let start = starts.indices.contains(index) ? starts[index] : 0
            if TransportPolicy.previousAction(index: Double(index), positionSec: forayPositionSec(of: item),
                                              segmentStartSec: start) == .itemBefore {
                return playIndex(index - 1, startSec: nil, source: source)
            }
        }
        cutSeamGap("skipToPrevious")
        begin(.skipPrevious, source: source)
        releaseSeamGap()
    }

    /// `seekTo` from the page or the lock screen: clamped the way the page
    /// clamps an episode seek, then `seekAction`: with nothing loaded to seek
    /// in, the target is WRITTEN DOWN as the next play's own start; paused,
    /// loading and playing are the reducer's.
    ///
    /// IN A FORAY EVERY SEEK IS ON THE FORAY'S CLOCK, WHOEVER ASKS (M2 drive
    /// 2026-10-01). The page's `seekTo` command always came here as a Foray
    /// scrub, but the lock screen's and the car's (`changePlaybackPosition`,
    /// `onRemote`) did not: they reached the episode seek below, which read
    /// the Foray-clock second the lock screen shows (NE-37c) as a second of
    /// the clip's source file, and dispatched a `.seek` the reducer refuses
    /// in `.transitioning`, the state every narration line reached by its
    /// seam plays in. client.js installs `ForayPlayer.foraySeek` for the same
    /// press; this is that rule.
    private mutating func seekTo(_ sec: Double, source: EngineSource) {
        if forayTransport { return forayScrub(to: sec, source: source) }
        guard let item = state.currentItem else { return refuse(.notLoaded) }
        guard let target = TransportPolicy.clampEpisodeTarget(sec, duration: deck.durationSec ?? item.durationSec) else { return }
        if TransportPolicy.seekAction(restored: false, stateType: state.stateType) == .pend {
            state.pendingStartSec = target
            return
        }
        cutSeamGap("seek")
        dispatch(.seek(seconds: target, precise: false))
        releaseSeamGap()
    }

    /// A nudge steps from where the listener IS: the deck's playhead once it
    /// holds the item; WHILE A LOAD OF IT IS IN FLIGHT, the second that load
    /// will land on, never the fresh item's 0 (audit round 2, p-impatient-1:
    /// ↺15 during a cold resume must not send the resume point to 0:00);
    /// otherwise the pended start.
    ///
    /// IN A FORAY A NUDGE IS A STEP ON THE FORAY'S CLOCK, WHOEVER ASKS (M2
    /// drive 2026-10-01, the founder's "skip backwards didn't work during the
    /// AI narration"). The car's back-15 / forward-30 (`onRemote`) used to
    /// come straight here, to the EPISODE nudge: during a spoken line it
    /// stepped from the clip's frozen playhead (or a line load's 0) in the
    /// clip's own seconds and asked the reducer for a `.seek`, which
    /// `.transitioning` refuses, so every press inside a line did nothing.
    /// client.js installs its `nudgeBy` (the Foray clock, `nudgeAction`) for
    /// the same press; so does this engine now, for the page's command and
    /// the car's alike.
    private mutating func seekBy(_ deltaSec: Double, source: EngineSource) {
        if forayTransport { return forayNudge(deltaSec, source: source) }
        guard let item = state.currentItem else { return refuse(.notLoaded) }
        let loading = state.loadedId != item.id && state.pendingLoad?.itemId == item.id ? state.pendingLoad?.startSec : nil
        let position = (state.loadedId == item.id ? deck.positionSec : nil) ?? loading ?? state.pendingStartSec ?? 0
        guard let target = TransportPolicy.skipTarget(foray: false, positionSec: position, offsetSec: deltaSec,
                                                      durationSec: deck.durationSec ?? item.durationSec) else { return }
        seekTo(target, source: source)
    }

    /// `stop()`: a close (`persist: true`) or a data deletion (`false`). The
    /// cause row, then the reducer's save and pause, then the session is
    /// released WITH notify: the listener closed the player.
    private mutating func stop(persist: Bool, source: EngineSource) {
        // D-5 (NE-40): the cause first, before the cut silences a jingle.
        stopRow(persist ? .close : .dataDeletion, source: source)
        cutSeamGap("stop")
        defer { releaseSeamGap() }
        stopPreview("stop")
        state.pausedByListener = true
        // CLOSING IS A FLUSH (audit round 2, player-3): the reducer's stop
        // saves nothing, and a scrub made while paused is written by nothing
        // else, so the playhead is written first (client.js `stopAndClose`).
        // A data deletion writes nothing.
        if persist { flushPosition() }
        state.closed = true
        suppressSave = !persist
        // L-05: "Stopping a Foray must also stop speech", in ONE call: the
        // reducer's pause is held off so a pause never precedes the stop.
        let wasSpeaking = state.narration != nil
        narrationStopping = wasSpeaking
        dispatch(.stop)
        narrationStopping = false
        suppressSave = false
        // THE POSTCONDITION OF STOP IS SILENCE TOO (audit round 3,
        // player-core-7; NE-39s ports it): from `interrupted` or `loadingItem`
        // the reducer's stop emits no pause, because it believes nothing is
        // audible, and in the #689 drift the deck is. `pause()`'s rule, by
        // the deck's own word, never the reverse.
        if audibleNow {
            diag("pause", [JSONMember("kind", .string("forced")),
                           JSONMember("why", .string("the deck was audible while the machine said stopped"))])
            deckCommand(.pause)
        }
        if wasSpeaking { stopNarration() }
        applySession(SessionPolicy.transition(from: state.session, on: persist ? .close : .dataDeletion,
                                              holdPolicy: state.holdPolicy))
        if !persist {
            // Delete my data forgets the routes too (the host removes
            // `ForayEngine.knownRoutes` when the set is empty).
            state.knownRoutes = RouteResume.KnownRoutes()
            state.routeResume = RouteResume.State(playing: false)
            state.routeResumeBeforePause = nil
            state.heardRoute = nil
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
        // A SPOKEN LINE IS NOT SPED UP (corner case #18, founder 2026-09-24):
        // a tap while one is audible is kept (`pendingRate`) and reaches the
        // deck when the line ends (`restoreRate`), never mid-word. A RENDERED
        // line follows the listener (D2, 2026-09-28): the tap goes to the deck
        // now, like any clip (`_loadedIsSynth && _narrationIsAudible()`).
        if config.forayTapeEnabled && state.narration != nil && narrationIsAudible {
            state.pendingRate = snap.applied
            diag("rate", [JSONMember("kind", .string("deferred")), JSONMember("applied", .number(snap.applied))])
            return
        }
        deckCommand(.setRate(snap.applied))
    }

    /// `_narrationIsAudible()`: read from the item, not the reducer's state,
    /// since `transitioning` covers the bridge loading as well as playing.
    private var narrationIsAudible: Bool {
        state.stateType == "transitioning" || state.currentItem?.kind == .tts
    }

    /// queue-manager.js `focusOf(state)` read through `_itemFor`: the queue
    /// item the reducer's state is about (the playing item, the bridge being
    /// transitioned to, the interrupted item, the load's target), nil when
    /// idle or ended.
    private var focusItem: EngineItem? {
        let ref: QueueItemRef?
        switch state.player {
        case let .playing(item): ref = item
        case let .transitioning(_, to): ref = to
        case let .interrupted(item, _): ref = item
        case let .loadingItem(target, _, _): ref = target
        case .idle, .ended: ref = nil
        }
        guard let ref else { return nil }
        return state.queue.first(where: { $0.id == ref.id })
    }

    /// The one-way relinquish (plan §4.6): stop WITH persistence, keep the
    /// session active with no deactivate and no notify (so no app 4a
    /// interrupted is invited back), end grace, cancel timers, write the
    /// `{mode: "relinquished"}` record, and go terminal.
    private mutating func relinquish(cap: EngineContract.RelinquishCap, source: EngineSource) {
        // D-5 (NE-40): the cause first, before the cut silences a jingle.
        stopRow(.relinquish, source: source)
        // Nothing parked may start audio after the engine gave the process back.
        cutSeamGap("relinquish")
        state.gapParkedToken = nil
        state.gapCut = false
        stopPreview("relinquish")
        if state.isRunning {
            state.pausedByListener = true
            dispatch(.interruptionBegan)
        } else {
            persistPosition()
        }
        if audibleNow { deckCommand(.pause) }
        // The synthesiser outlives nothing the engine gave back (NE-31s).
        if state.narration != nil { stopNarration() }
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
    ///
    /// Its grace fields are filled in AFTER the press is handled (NE-16g): the
    /// row keeps its place at the head of the turn, but `grace=y` has to say
    /// whether THIS press is covered, and a car's play opens its span only
    /// once it is being handled. Written before, every background play would
    /// read `grace=n` and the H-1 verdict would have nothing to go on.
    private mutating func onRemote(_ press: RemotePress) {
        var dup = false
        if let last = state.lastRemote, last.command == press.command {
            let gap = now.monoMs - last.atMono
            dup = gap >= 0 && gap < EngineCore.remoteDuplicateWindowMs
        }
        state.lastRemote = LastRemote(command: press.command, atMono: now.monoMs)
        let fields = [
            JSONMember("cmd", .string(press.command.rawValue)),
            JSONMember("dupCandidate", .string(dup ? "y" : "n")),
            JSONMember("route", press.routePort.map { JSONNode.string($0) } ?? .null),
            JSONMember("thread", .string(press.onMain ? "main" : "bg")),
            JSONMember("state", .string(state.stateType))
        ]
        let rowAt = out.count
        diag("remote", fields + graceFields())
        defer { out[rowAt] = .diag(DiagEntry(kind: "remote", fields: fields + graceFields())) }
        // Any press after a loss clears it: the listener (or the car) has
        // taken charge (route-resume.js "press").
        routePress(remotePressName(press.command))
        let steps = MediaMapping.SeekSteps()
        // A skip or a scrub goes through `seekBy` / `seekTo`, which are the
        // nudge and scrub helpers: in a Foray they step on the FORAY's clock
        // (`forayNudge` / `forayScrub`), the clock Now Playing publishes, never
        // the clip's source seconds (#924; the JVM's A-42). Pinned from a clip
        // by `manager-foray/remote-clock-*` and from a line by
        // `manager-foray/narration-skip-*`.
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
        if case .audition = intent {} else {
            state.closed = false
            // NE-47: whatever starts now is the one thing that sounds; a
            // voice preview still loading or playing is cut first.
            stopPreview("play")
        }
        if let reason = graceReason(for: intent, source: source) { beginGrace(reason) }
        spanRow(for: intent)
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

    /// The `resume` and `cold-play` rows (NE-16g; plan §4.4 and §10): written
    /// the moment the intent's span opens, before the activation it may wait
    /// on, with `grace=`, its reason and `bgRemainingMs`. These are the rows
    /// the H-1/H-3 drives are judged on: every background resume must show
    /// `grace=y` and a positive budget, and DV-7a's cold play the same.
    private mutating func spanRow(for intent: DeferredIntent) {
        let item: JSONNode = state.currentItem.map { .string($0.id) } ?? .null
        switch intent {
        case .interruptionResume:
            diag("resume", [JSONMember("kind", .string("interruption")), JSONMember("item", item)] + graceFields())
        case .routeResume:
            diag("resume", [JSONMember("kind", .string("route")), JSONMember("item", item)] + graceFields())
        case .coldPlay:
            diag("cold-play", [JSONMember("item", item), JSONMember("index", .number(Double(state.currentIndex)))]
                 + graceFields())
        case .playIndex, .resume, .skipNext, .skipPrevious, .walkHop, .audition:
            break
        }
    }

    /// `grace=y|n`, the open span's reason, and the background time the host
    /// read for this input (nil in the foreground).
    private func graceFields() -> [JSONMember] {
        [JSONMember("grace", .string(state.grace == nil ? "n" : "y")),
         JSONMember("graceReason", state.grace.map { JSONNode.string($0.rawValue) } ?? .null),
         JSONMember("bgRemainingMs", Rows.finiteOrNull(now.bgRemainingMs.map { $0.rounded() }))]
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
            return releaseSeamGap()
        }
        state.activatedInProcess = true
        cancelHoldTimer()
        run(parked.intent, source: parked.source)
        // A beat cut by the action that asked for this activation is released
        // only now, after that action issued its own load (`_transport`).
        releaseSeamGap()
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
            // The next item, a line included (NE-39n; `next(source:)`).
            guard let next = nextItem(from: cursor, skipBridges: false) else { return refuse(.noNext) }
            // currentIndex is NOT advanced here: the reducer's skip saves the
            // outgoing position first, against what is loaded. `load` moves it.
            state.targetIndex = next.index
            dispatch(.skipToNext(next.item.ref))
        case .skipPrevious:
            // "Restart" must mean zero, or the save the reducer emits first
            // would make the reload resume exactly where the press left.
            //
            // From `idle` (a failed load) or `ended` the reducer has no item in
            // focus, and skipToPrevious(nil) there is its "queue exhausted"
            // branch: it returns `ended`. Name the item this engine holds and
            // the reducer takes its fresh-play branch, so the clip reloads at
            // its in-point (player-core-1, ported from queue-manager.js
            // skipToPrevious; fixture manager-episode/previous-after-a-failed-
            // load-reloads-the-clip). Everywhere else nil keeps the reducer's
            // restart-in-place.
            switch state.player {
            case .idle, .ended:
                guard let held = state.currentItem else { return }
                dispatch(.skipToPrevious(held.ref), offsets: LoadOffsets(forced: 0))
            default:
                dispatch(.skipToPrevious(nil), offsets: LoadOffsets(forced: 0))
            }
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
        case let .audition(text, voiceId, url):
            guard let url else {
                // Spoken: a preview still sounding stops first (one voice
                // at a time); with none, this is the audition as it always was.
                stopPreview("audition")
                return out.append(.speak(text: text, voiceId: voiceId))
            }
            loadPreview(url: url, text: text, voiceId: voiceId)
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
        case .pausePlayback:
            // L-05 (founder feedback F12): every pause surface arrives here, so
            // a spoken line pauses its SYNTHESISER, not a deck that is not
            // playing it.
            if state.narration != nil { pauseNarration() } else { deckCommand(.pause) }
        case .savePosition: if !suppressSave { persistPosition() }
        case let .seekTo(seconds, _): deckCommand(.seek(toSec: seconds))
        case let .seekRejected(reason):
            diag("seek", [JSONMember("kind", .string("rejected")), JSONMember("reason", .string(reason))])
        case let .setOutPoint(seconds): deckCommand(.setOutPoint(sec: seconds))
        case .resetRateForTTS:
            // Founder ruling D2, 2026-09-28 (queue-manager.js §12): a RENDERED
            // line plays at the LISTENER's rate, pitch kept (AVDeck's
            // `.timeDomain`); it was the literal NARRATION_RATE until then
            // (corner case #18). A SPOKEN line has no deck under it: its 1x
            // rode on the utterance (NE-31s). DECIDED BY THE ITEM THIS EFFECT
            // IS FOR, not by the line now loaded: on the bridge path the
            // reducer emits it before the line loads, so `narration` still
            // describes the PREVIOUS item (a spoken line chained before a
            // rendered one would skip the rendered line's rate).
            if let target = focusItem {
                if target.isSynthNarration { return }
            } else if state.narration != nil {
                return
            }
            deckCommand(.setRate(state.rate))
        case .restoreRate:
            if state.narration != nil { return }
            state.pendingRate = nil
            deckCommand(.setRate(state.rate))
        case .playTransitionTTS:
            // With the Foray tape on a bridge plays: a RENDERED one on the deck
            // (NE-30s), a SPOKEN one through the synthesiser (NE-31s),
            // `_playTransitionBridge`. With the tape off every bridge is stepped
            // over the way a bridge that failed to load is
            // (`_advancePastBridgeFailure`): a missing line never stalls the
            // queue (corner case #12).
            if config.forayTapeEnabled { return playTransitionBridge() }
            advancePastBridgeFailure()
        case .emitTelemetry: break
        }
    }

    /// `_loadItem(ref)`: where the load starts, decided in the JS order, then
    /// one `.load` with a fresh token. The index moves NOW (after the outgoing
    /// save already ran); the loaded id moves only when `.ready` comes back.
    /// `attempt` is §16's: 1 for every load the reducer asks for, higher only
    /// for a Foray clip's retry (`retryOrSkipClip`). `url` replaces the
    /// item's own `audio_url` for this one load: the stream a downloaded copy
    /// that will not open falls back to (`fallBackToStream`, CH3-12).
    private mutating func load(_ ref: QueueItemRef, offsets: LoadOffsets, attempt: Int = 1, url: String? = nil) {
        guard let item = state.queue.first(where: { $0.id == ref.id }) else {
            // Drop the beat's deadline with the item it belonged to.
            endSeamGap("unknownRef")
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
        // §14: a rendered line already being SPOKEN because its file failed,
        // paused and now resumed, is a spoken line for this load: it continues
        // the utterance instead of retrying the file mid-sentence. A restart
        // (`forced`) tries the file again.
        let resumingFallback = offsets.forced == nil && state.fallbackSpokenId == item.id
            && state.loadedId == item.id && state.narration?.paused == true
        if config.forayTapeEnabled && (item.isSynthNarration || resumingFallback) {
            // §7 item 1: a script-only line has no file for a deck; it is
            // SPOKEN (NE-31s).
            return loadSpokenLine(item, token: token, restart: offsets.forced != nil)
        }
        let opened = url ?? item.audioUrl
        state.pendingLoad = PendingLoad(token: token, itemId: item.id, startSec: startSec, attempt: attempt, url: opened)
        deckCommand(.load(token: token, itemId: item.id, url: opened, startSec: startSec,
                          preciseTiming: item.preciseTiming(approximateCBR: config.approximateCBRClips),
                          deadlineClass: DeckDeadlineClass(item), bounded: bounds != nil))
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
        if let line = state.narration {
            // A spoken line: its FIRST start is already under way (the
            // synthesiser answered `speak`); a start after a pause CONTINUES
            // the same utterance (L-05: resume from the same sentence).
            if line.paused { out.append(.narration(.resume(seq: line.seq))) }
            return writeRestore()
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
        case let .failed(token, message, why):
            onLoadFailure(token, message: message, cause: .error, fallbackCause: why)
        case let .deadlineExceeded(token, afterMs, why):
            onLoadFailure(token, message: "no ready inside \(afterMs) ms", cause: .loadDeadline, fallbackCause: why)
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
        case let .prepareWindow(token):
            guard token == state.loadedToken else { return }
            warmNextSegment(at: "window")
        case let .prepared(token, hit, stages):
            // Only the load in flight is described; a stale report is dropped.
            guard let pending = state.pendingLoad, pending.token == token else { return }
            state.deckPrepare = DeckPrepareReport(token: token, hit: hit, stages: stages)
            // NE-45s: the seam this load crosses says hit or miss, whichever
            // way the item then becomes audible (a line whose prepared file
            // failed is still a miss when it is spoken instead).
            if var mark = state.seamMark, mark.toItemId == pending.itemId {
                mark.prepare = hit ? .hit : .miss
                state.seamMark = mark
            }
        }
    }

    /// A load landed. Only the load that owns the deck continues (corner case
    /// #19): a superseded one is logged and plays nothing, stamps nothing.
    private mutating func onReady(_ token: DeckToken) {
        guard let pending = state.pendingLoad, pending.token == token else {
            return diag("deck", [JSONMember("kind", .string("superseded")), JSONMember("token", .number(Double(token)))])
        }
        // THE LISTENER CAN MOVE DURING A RENDERED BRIDGE'S LOAD (audit round 3,
        // player-core-2): a pause, an interruption or a stop in that window
        // changes the state but not the load. The bridge plays only if the
        // machine is still transitioning to it; otherwise it landed for nobody
        // and is not started (a pause undone from the car, or a line playing
        // behind a closed player, is what this prevents).
        if pending.bridge, !stillOn(pending) {
            state.pendingLoad = nil
            return diag("bridge", [JSONMember("kind", .string("landed-after-leaving")),
                                   JSONMember("token", .number(Double(token)))])
        }
        state.pendingLoad = nil
        state.loadedId = pending.itemId
        state.loadedToken = token
        state.startingHop = nil
        // A new load owns the deck: the last one's stall is not this one's.
        clearStallLatch()
        // A deck item holds the playhead now: a spoken line it replaced is
        // over (`_endSynthNarration`).
        endSpokenLine()
        if pending.bridge {
            // A rendered bridge plays the moment it lands (`_playTransitionBridge`).
            // NE-45s: it is a deck seam like any other, so it packs a seam row.
            let report = state.deckPrepare.flatMap { $0.token == token ? $0 : nil }
            state.deckPrepare = nil
            packSeamRow(armedAt: nil, report: report)
            return startPlayback()
        }
        guard config.forayTapeEnabled, let item = state.queue.first(where: { $0.id == pending.itemId }) else {
            return dispatch(.itemLoaded)
        }
        landed(item, token: token)
    }

    /// What follows a load that landed (a deck's `.ready`, or a spoken line's
    /// `started`): ADR-0007's gate, then the beat.
    private mutating func landed(_ item: EngineItem, token: DeckToken) {
        // ADR-0007's rung 3 runs HERE and nowhere earlier: the first moment the
        // duration of the copy the listener actually received exists. An
        // APPROXIMATE copy is never made audible: the segment is skipped.
        let gate = SeekPolicy.segmentLoadGate(
            needsDriftCheck: item.needsDriftCheck, daiSuspected: item.daiSuspected,
            referenceDurationSec: item.referenceDurationSec, adPadSec: item.adPadSec,
            observedDuration: deck.durationSec, isLocalFile: state.forayIsLocalFile,
            allowAdPad: state.forayAllowAdPad)
        // §16: a clip that loaded ends a run of clips that would not (before
        // the gate, as queue-manager.js resets it before `_segmentGate`).
        if item.kind != .tts, item.bounds != nil { state.clipLoadSteps = 0 }
        if !gate.ok { return refuseAtLoad(item, reason: gate.reason ?? "") }
        if gate.note != nil {
            diag("gate", [JSONMember("kind", .string("noted")), JSONMember("item", .string(item.id))])
        }
        // The seam beat is spent HERE, between a loaded-and-positioned asset
        // and the `itemLoaded` that arms the out-point and starts it. A load
        // that FAILED never reaches this line: an error never waits out a beat.
        awaitSeamGap(token)
    }

    /// A load (or the item it loaded) failed. A failure nobody is waiting on
    /// any more is not the CURRENT item failing; otherwise the cause row, the
    /// page's error (`chain-start` for a hop, C-6), then the reducer's error
    /// (idle, pause).
    private mutating func onLoadFailure(_ token: DeckToken, message: String, cause: Vocabulary.StopCause,
                                        fallbackCause: Vocabulary.NarrationFallbackCause = .other) {
        let isPending = state.pendingLoad?.token == token
        let isHeld = state.pendingLoad == nil && state.loadedToken == token
        guard isPending || isHeld else {
            return diag("deck", [JSONMember("kind", .string("superseded-failure")), JSONMember("token", .number(Double(token)))])
        }
        if fallBackToScript(token, isPending: isPending, cause: cause, why: fallbackCause) { return }
        if let pending = state.pendingLoad, pending.bridge, pending.token == token {
            // A bridge that will not load never stalls the queue (corner case #12).
            state.pendingLoad = nil
            diag("bridge", [JSONMember("kind", .string("load-failed")), JSONMember("item", .string(pending.itemId))])
            return advancePastBridgeFailure()
        }
        // §16: a Foray clip is retried once, then stepped over, never left idle.
        if isPending, let pending = state.pendingLoad, retryOrSkipClip(pending, cause: cause, why: fallbackCause) {
            return
        }
        // CH3-12: a downloaded copy that will not open streams instead.
        if isPending, let pending = state.pendingLoad,
           fallBackToStream(pending, message: message, cause: cause, why: fallbackCause) {
            return
        }
        let itemId = state.pendingLoad?.itemId ?? state.loadedId ?? "?"
        state.pendingLoad = nil
        stopRow(cause)
        // Drop the beat's deadline with the item it belonged to: a failed seam
        // reports at once, and the next load does not sit out a stale beat.
        endSeamGap("loadFailed")
        if state.startingHop != nil {
            state.startingHop = nil
            out.append(.emit(.error(code: "chain-start", message: message)))
        } else {
            out.append(.emit(.error(code: "load", message: message)))
        }
        dispatch(.error("loadItem(\(itemId)) failed: \(message)"))
    }

    /// CH3-12 (R4-03): a DOWNLOADED copy that will not open (the file was
    /// removed, or an app update moved the container it lived in) is loaded
    /// again from its stream, at the same second, once. The page sends a
    /// downloaded item with the file in `audio_url` and the stream kept as
    /// `source_audio_url` (download-store.js `localPlayable`); in the JS lane
    /// the page itself streams it (client.js `degradeLocalPlay`), but here the
    /// failure can land with the page asleep (a car press after a cold
    /// restore, a hop the engine walked), and the bridge drops every event
    /// while the page is hidden, so the page's fallback never ran.
    ///
    ///   - Only a load that opened a `file:` URL falls back, and only onto a
    ///     non-empty `source_audio_url`. The fallback's own load opened the
    ///     stream, so a failure of THAT is the caller's stop, as today: once.
    ///   - Offline is not the core's to know: the stream runs into its own
    ///     deadline, and then stops `cause=load-deadline`.
    ///   - No `stopRow`: a fallback is not a stop (`deck kind=stream-fallback`
    ///     says what happened). The page still hears `error` code `load`, so
    ///     it marks the download missing; that code is the snapshot's
    ///     `lastError` too, which is how a page that slept through it learns.
    ///
    /// Not pinned by a fixture: the JS manager has no such rule (its lane's
    /// fallback is the page's), so `player/parity/exclusions.json` says so and
    /// both cores pin it with identically named unit tests.
    private mutating func fallBackToStream(_ pending: PendingLoad, message: String, cause: Vocabulary.StopCause,
                                           why: Vocabulary.NarrationFallbackCause) -> Bool {
        guard !pending.bridge, pending.spokenSeq == nil, pending.url?.hasPrefix("file:") == true,
              let item = state.queue.first(where: { $0.id == pending.itemId }),
              let stream = item.node["source_audio_url"]?.stringValue, !stream.isEmpty else { return false }
        // `why`, not `cause`, as in `retryOrSkipClip`: this row is not a stop.
        diag("deck", [JSONMember("kind", .string("stream-fallback")), JSONMember("token", .number(Double(pending.token))),
                      JSONMember("why", .string(cause.rawValue)), JSONMember("fileCause", .string(why.rawValue))])
        state.pendingLoad = nil
        out.append(.emit(.error(code: "load", message: message)))
        load(item.ref, offsets: LoadOffsets(explicit: pending.startSec), attempt: pending.attempt, url: stream)
        return true
    }

    /// §16 (queue-manager.js `_retryOrSkipClip`; the M2 car drive,
    /// 2026-10-01): a Foray CLIP's load failed (its P-13 deadline, or the
    /// deck's `.failed`) while the listener is still on it. It used to stop
    /// the Foray here, idle and silent with the clip on the lock screen, and
    /// every press of play then loaded the clip again from nothing.
    ///
    ///   - The first failure loads the SAME clip at the SAME in-point again
    ///     (`deck kind=retry`). That is what lets the deck keep what the first
    ///     attempt fetched: AVDeck continues a load that was getting somewhere
    ///     (`deck kind=continue`) instead of starting a cold one.
    ///   - A failure of that retry steps over the clip the way the ladder's
    ///     refusal does (`skip kind=load`, the `skipped` event the page
    ///     already shows, `skipUnplayableSegment`): the next item, a narration
    ///     line included, or the end of the Foray.
    ///   - Paused during the load (`interrupted`), the retry still runs,
    ///     quietly, so the listener's play finds the clip; a failed retry while
    ///     paused is today's stop, because stepping on would start the next
    ///     item behind the pause.
    ///
    /// `EngineConstants.QueueManager.forayClipLoadAttempts` counts the loads
    /// and `forayClipMaxSilenceSec` is the silence that bounds. A SECOND clip
    /// in a row that will not load is not stepped over
    /// (`forayClipLoadMaxSteps`, `state.clipLoadSteps`): that is the network,
    /// and stepping on would run through the rest of the Foray, end it and
    /// mark it Played, so it is the caller's stop. Anything that
    /// is not a clip (a plain episode, a narration line, a bridge), or a load
    /// the player has moved off, returns false: the caller's stop, exactly as
    /// before. No `stopRow`: neither a retry nor a step is a stop (a step onto
    /// nothing is `skipUnplayableSegment`'s own `final-end`).
    private mutating func retryOrSkipClip(_ pending: PendingLoad, cause: Vocabulary.StopCause,
                                          why: Vocabulary.NarrationFallbackCause) -> Bool {
        guard config.forayTapeEnabled, !pending.bridge, pending.spokenSeq == nil,
              let item = state.queue.first(where: { $0.id == pending.itemId }),
              item.kind != .tts, item.bounds != nil, focusItem?.id == item.id else { return false }
        let waiting: Bool
        switch state.player {
        case .loadingItem: waiting = true
        case .interrupted: waiting = false
        default: return false
        }
        // `why`, not `cause`: outside a `narration` row DiagGate admits a
        // `cause` only as a stop cause, and neither row is a stop. The clip is
        // named by its queue `index`, not its id: a Foray item id carries a
        // `#` (`f1#1`), which is not a token, so DiagGate would withhold it.
        let index = state.queue.firstIndex(where: { $0.id == item.id }) ?? state.currentIndex
        let fields = [JSONMember("index", .number(Double(index))),
                      JSONMember("why", .string(cause.rawValue)),
                      JSONMember("fileCause", .string(why.rawValue)),
                      JSONMember("waiting", .bool(waiting))]
        if Double(pending.attempt) < EngineConstants.QueueManager.forayClipLoadAttempts {
            diag("deck", [JSONMember("kind", .string("retry")), JSONMember("token", .number(Double(pending.token))),
                          JSONMember("attempt", .number(Double(pending.attempt + 1)))] + fields)
            state.pendingLoad = nil
            // The same in-point: an explicit offset inside the slice, spent by
            // this one load.
            load(item.ref, offsets: LoadOffsets(explicit: pending.startSec), attempt: pending.attempt + 1)
            return true
        }
        guard waiting else { return false }
        // A second clip in a row that will not load is the network, not the
        // clip (`forayClipLoadMaxSteps`): the caller's stop, rather than a run
        // through the rest of the Foray that ends it and marks it Played.
        if Double(state.clipLoadSteps) >= EngineConstants.QueueManager.forayClipLoadMaxSteps { return false }
        state.clipLoadSteps += 1
        state.pendingLoad = nil
        state.skippedSegments += 1
        diag("skip", [JSONMember("kind", .string("load")),
                      JSONMember("attempts", .number(Double(pending.attempt)))] + fields)
        out.append(.emit(.skipped(itemId: item.id, index: index,
                                  reason: "did not load in \(pending.attempt) attempts (\(why.rawValue))")))
        skipUnplayableSegment()
        return true
    }

    /// §14 (queue-manager.js, Phase 2; founder rulings D1-D11, 2026-09-28):
    /// a RENDERED narration line whose FILE fails is read aloud from its
    /// script instead, in all three places a file can fail:
    ///
    ///   - `load`: the line's own load (a Foray's first line, a jump, a skip
    ///     onto it), which used to stop the Foray;
    ///   - `bridge`: a rendered bridge's load, which used to be stepped over;
    ///   - `playing`: the file failing while the line sounds, which used to
    ///     stop the Foray. The deck is paused and the whole script is spoken
    ///     from its first word (speech has no offset).
    ///
    /// Only while the machine is still ON that line (a pause, a stop or a skip
    /// during the load keeps today's outcome). The spoken line gets a FRESH
    /// token, so a late report about the failed file (a second error, a
    /// deadline's twin) names a load nobody is on and is dropped as
    /// `superseded-failure`. If the synthesiser refuses too, its `.failed`
    /// reaches `onLoadFailure` as a spoken load, which never falls back: the
    /// first line stops and a bridge is stepped over, exactly as before. A
    /// line with no script, and a clip, fail exactly as before.
    ///
    /// The row carries `cause=` (NE-39n): the deck's closed reading of why the
    /// file failed (`timeout`, `http-4xx`, `http-5xx`, `offline`, `decode`,
    /// `other`), so a drive's paste says whether the fallback was the network,
    /// the narration host or the file. `reason=` stays as it was (`timeout`
    /// for the load deadline, else `failed`); `where=` is `load`, `bridge` or
    /// `playing`.
    private mutating func fallBackToScript(_ token: DeckToken, isPending: Bool, cause: Vocabulary.StopCause,
                                           why: Vocabulary.NarrationFallbackCause) -> Bool {
        guard config.forayTapeEnabled else { return false }
        let itemId: String?
        let at: String
        if isPending {
            guard let pending = state.pendingLoad, pending.token == token, pending.spokenSeq == nil else { return false }
            itemId = pending.itemId
            at = pending.bridge ? "bridge" : "load"
        } else {
            guard state.narration == nil else { return false }
            itemId = state.loadedId
            at = "playing"
        }
        guard let itemId, let item = state.queue.first(where: { $0.id == itemId }), item.canSpeakInstead,
              focusItem?.id == item.id else { return false }
        switch (at, state.player) {
        case ("load", .loadingItem), ("bridge", .transitioning), ("playing", .playing), ("playing", .transitioning):
            break
        default:
            return false
        }
        diag("narration", [JSONMember("kind", .string("fallback")),
                           JSONMember("reason", .string(cause == .loadDeadline ? "timeout" : "failed")),
                           // `where`, not `at`: `at` is the ring row's wall
                           // clock (DiagRow.headerKeys), so DiagGate drops a
                           // field of that name and the paste never said
                           // whether the load, a bridge or a sounding line fell
                           // back (NE-39n review).
                           JSONMember("where", .string(at)),
                           JSONMember("cause", .string(why.rawValue))])
        // A file that failed mid-line: silence the deck under it first.
        if at == "playing" { deckCommand(.pause) }
        state.lastToken += 1
        // `load` lands like any loaded line (the gate, the beat, itemLoaded);
        // a bridge, and a line already playing, play on without an itemLoaded.
        speakLine(item, token: state.lastToken, bridge: at != "load", fallback: true)
        return true
    }

    /// `_handleBackendItemEnded`: the item ran out. The queue's next item, or
    /// the next continuation hop when `autoAdvance` is on, or the end.
    private mutating func onEnded(_ token: DeckToken) {
        guard token == state.loadedToken else {
            return diag("deck", [JSONMember("kind", .string("stale-ended")), JSONMember("token", .number(Double(token)))])
        }
        itemEnded()
    }

    /// `_handleBackendItemEnded`: the item the playhead is on ended (the deck's
    /// `.ended`, or a spoken line's `didFinish` or deadline, NE-31s). Resolve
    /// what "next" means, then feed exactly one `itemEnded`.
    private mutating func itemEnded() {
        // The stall latch belongs to the item that ended (#866's rate-0 latch,
        // ported to the Foray seams): whatever plays next reports its own.
        clearStallLatch()
        switch state.player {
        case .transitioning:
            let next = nextItem(from: cursor, skipBridges: true)
            // A bridge marks its own seam, so no beat; but narration -> segment
            // DOES get the jingle (§13): the founder's "between podcasts" mark
            // comes after the narrator's line, before the next tape starts.
            if let next {
                armInterlude(from: state.currentItem, to: next.item)
                if config.forayTapeEnabled, let from = state.currentItem,
                   EngineCore.isForaySeam(from: from, to: next.item) {
                    markSeam(from: from, to: next.item)
                    // NE-45s: a RENDERED line's end is a deck seam, and in the
                    // background it holds the same span a clip's out-point
                    // does (a spoken line's end already opened
                    // `narration-handover`, and a span is never begun twice).
                    if state.backgrounded {
                        beginGrace(state.preparedItemId == next.item.id ? .seam : .prepareMiss)
                    }
                }
            }
            dispatch(.itemEnded(next: next?.item.ref, bridged: false))
        case .playing:
            // THE OUT-POINT AND A NATURAL END ARE ONE END: the deck reports
            // either as `.ended` (forwardPlaybackEndTime, the boundary layer,
            // the watchdog or the file running out), and every transition
            // after it is identical, which is the value of the one path.
            if let next = nextItem(from: cursor, skipBridges: false) {
                let bridged = next.item.kind == .tts
                if config.forayTapeEnabled, let from = state.currentItem {
                    // Stamp the beat BEFORE dispatching: `itemEnded` issues the
                    // next load in this same turn, and the whole point is for
                    // that load to happen inside the beat.
                    armSeamGap(from: from, to: next.item, bridged: bridged)
                    // NE-45s: a Foray seam is remembered for its row: one with
                    // a beat (as before) or a clip's end into a line (no beat,
                    // and no row before). An episode's end in a plain queue,
                    // and a bridge after one, are not Foray seams and write
                    // nothing (the Foray tape leaves episode paths unchanged).
                    if state.gapArmedAtMono != nil || (bridged && EngineCore.isForaySeam(from: from, to: next.item)) {
                        markSeam(from: from, to: next.item)
                    }
                    // And the jingle in the same instant, for the same reason
                    // (§13), after the beat so its deadline is the floor.
                    armInterlude(from: from, to: next.item)
                    // The span runs from the out-point until the next item is
                    // audible, so iOS cannot suspend the process mid-seam.
                    if state.backgrounded {
                        beginGrace(state.preparedItemId == next.item.id ? .seam : .prepareMiss)
                    }
                }
                dispatch(.itemEnded(next: next.item.ref, bridged: bridged))
                // A silent seam (a beat with no jingle in it) may render
                // digital silence, flagged off (NE-34).
                return startSilence()
            }
            if state.autoAdvance, state.forayId == nil, let hop = state.chain.first {
                dispatch(.itemEnded(next: nil, bridged: false))
                return begin(.walkHop(hop), source: .autoadvance)
            }
            if state.autoAdvance && state.forayId == nil {
                diag("continuation", [JSONMember("kind", .string("chain-exhausted"))])
            }
            stopRow(state.forayId != nil ? .finalEnd : .ended)
            dispatch(.itemEnded(next: nil, bridged: false))
            markForayFinished()
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
            routeResumeStep(.playing)
            startHearing()
        case .waiting:
            if EngineCore.bufferingWhileWaiting { state.buffering = true }
            stopHearing()
        case .paused: stopHearing()
        }
    }

    /// Observe, don't believe (plan §4.3 Q-9): the deck stopped and nobody
    /// here asked it to. Within 500 ms of a route going away it is the
    /// route's; otherwise the system's; either way the machine is corrected
    /// towards paused, never the reverse.
    private mutating func onUncommandedPause(_ token: DeckToken) {
        guard token == state.loadedToken else { return }
        state.lastUncommandedPauseAtMono = now.monoMs
        stopHearing()
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
            guard state.narration == nil, audibleNow, let current = state.currentItem, state.loadedId == current.id,
                  item.id == current.id else { return }
            return dispatch(.elementResumed)
        }
        guard case .playing = state.player else { return }
        // A spoken line is "playing" with nothing in the deck producing it:
        // the deck's silence says nothing about it (only an interruption asks
        // the synthesiser, `onInterruptionBegan`).
        guard state.narration == nil else { return }
        guard !deck.audible else { return }
        guard !deck.ended else {
            return diag("reconcile", [JSONMember("kind", .string("skipped-ended"))])
        }
        stopRow(routeAttributed ? .routeChange : .systemPause)
        // Route resume (NE-38rs): a pause the route is blamed for was already
        // the loss's (`onRoute` stepped it). One blamed on the system is the
        // system's, unless a route loss follows inside the attribution window,
        // which restores the reducer from this snapshot (either order).
        if !routeAttributed {
            if unexplainedPause {
                state.routeResumeBeforePause = RouteResumeSnapshot(state: state.routeResume, atMono: now.monoMs)
            }
            routeResumeStep(.system)
        }
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
        // A SPOKEN LINE, and the synthesiser says it is still speaking: the
        // event is late (the call was declined and the line carried on), so
        // nothing is touched, the rule the tape keeps for a late event
        // (`_reconcileNarrationInterrupted`). Anything else is the session
        // taken from under the utterance, which AVSpeechSynthesizer reports
        // to nobody: the line is interrupted below, never advanced.
        if state.narration != nil, state.isPlaying, now.narrator == .speaking {
            return diag("session", [JSONMember("kind", .string("interruption")), JSONMember("phase", .string("began")),
                                    JSONMember("late", .string("narration-speaking"))])
        }
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
        // D-5 (NE-40): the cause first, before the cut silences a jingle.
        stopRow(.interruption)
        cutSeamGap("interruption")
        // A call or Siri clears a loss's eligibility (route-resume.js).
        routeResumeStep(.interruption)
        // ...and explains the deck's uncommanded pause (CH3-02 review): the
        // call paused it, so a route loss after this (an A2DP -> HFP flap
        // inside `routeAttributionMs`) lands inside the interruption and is
        // not attributed that pause; the call's should-resume decides.
        state.lastUncommandedPauseAtMono = nil
        applySession(transition)
        dispatch(.interruptionBegan)
        releaseSeamGap()
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
            if resuming {
                beginGrace(.interruptionResume)
                spanRow(for: .interruptionResume)
            }
            return requestActivation(.interruptionResume, source: .session)
        }
        applySession(transition)
        if resuming && state.session != .active {
            // Released while paused (hold policy none): the resume activates
            // like any other play.
            return begin(.interruptionResume, source: .autoresume)
        }
        if resuming {
            beginGrace(.interruptionResume)
            spanRow(for: .interruptionResume)
        }
        dispatch(.interruptionEnded(shouldResume: resume), offsets: LoadOffsets(rewind: resume))
    }

    /// `routeChanged(...)` (corner case #13): a lost route pauses and is not
    /// resumable by a later call. A route coming back resumes ONLY under the
    /// founder's Q5 rule (NE-38rs, `RouteResume`): the last pause was the loss
    /// of THAT route (same salted key), the route is known (our audio was heard
    /// through it for a second), the loss is under 24 h old on the wall clock,
    /// and it is a car (CarPlay; Bluetooth only behind `routeResumeBluetooth`,
    /// OFF). A listener's pause, a call, Siri or a system pause never resumes.
    /// Every loss and every return writes a `route` row with the decision.
    ///
    /// ONLY A LOSS THAT PAUSED SOMETHING IS NON-RESUMABLE (CH3-02, R2-02;
    /// `queue-manager.js` `routeChanged`): the machine was playing, bridging or
    /// loading, or the loss is why the deck already paused (attributed below).
    /// A loss inside an OS interruption — a car's A2DP -> HFP -> A2DP flap
    /// while a call rings — paused nothing; the call did, and its
    /// should-resume decides (code-health-3 founder question 2, default).
    private mutating func onRoute(_ change: RouteChange) {
        diag("session", [JSONMember("kind", .string("route")),
                         JSONMember("oldDeviceUnavailable", .bool(change.oldDeviceUnavailable)),
                         JSONMember("port", change.portType.map { JSONNode.string($0) } ?? .null)])
        let key = routeKey(change.portType, change.portUID)
        if change.oldDeviceUnavailable {
            // Heard through the route that just went away for long enough? The
            // deck may already have stopped (either order), so the span ends
            // where it stopped, not now.
            if let heard = state.heardRoute, heard.key == key,
               heard.heardMs(atMono: now.monoMs) >= RouteResume.knownAfterMs {
                state.knownRoutes.use(heard.key)
            }
            state.heardRoute = nil
            state.lastRouteLostAtMono = now.monoMs
            var pausesSomething: Bool
            switch state.player {
            case .playing, .transitioning, .loadingItem: pausesSomething = true
            case .idle, .interrupted, .ended: pausesSomething = false
            }
            if let paused = state.lastUncommandedPauseAtMono, now.monoMs - paused >= 0,
               now.monoMs - paused <= EngineCore.routeAttributionMs {
                // The deck's pause came first and was reconciled as the
                // system's; the route is why (plan §4.3, either order).
                diag("session", [JSONMember("kind", .string("route-attributed")), JSONMember("to", .string("pause"))])
                if let before = state.routeResumeBeforePause, before.atMono == paused {
                    state.routeResume = before.state
                }
                pausesSomething = true
            }
            // Non-resumable when it paused something: a later call's
            // should-resume must not undo it.
            if pausesSomething { state.pausedByRoute = true }
            state.routeResumeBeforePause = nil
            routeResumeStep(.lost(port: change.portType, key: key, atSec: wallSec))
            diag("route", [JSONMember("kind", .string("lost")),
                           JSONMember("port", change.portType.map { JSONNode.string($0) } ?? .null),
                           JSONMember("class", .string(change.routeClass.rawValue)),
                           JSONMember("key", RouteResume.rowKey(key).map { JSONNode.string($0) } ?? .null),
                           JSONMember("known", .bool(state.knownRoutes.contains(key)))])
            // A beat that outlived a lost route would start audio into a dead
            // route the moment its timer fired.
            // D-5 (NE-40): the cause first, before the cut silences a jingle.
            stopRow(.routeChange)
            cutSeamGap("routeLost")
            dispatch(.routeChanged(oldDeviceUnavailable: true))
            releaseSeamGap()
            // The clock stops with the route, so no later tick carries the
            // position it died at past the 5 s throttle: write it NOW
            // (client.js `reconcileOnReturn`'s forced write; NE-37 ports
            // transport-reconcile's "THE POSITION THE ROUTE DIED AT IS
            // WRITTEN"). An unknown playhead still writes nothing.
            persistForay(force: true)
            return
        }
        dispatch(.routeChanged(oldDeviceUnavailable: false))
        state.heardRoute = nil
        let known = state.knownRoutes.contains(key)
        let pausedBy = state.routeResume.pausedBy
        let lostSec: Double? = state.routeResume.lost?.atSec.map { wallSec - $0 }
        var decision = routeResumeStep(.back(port: change.portType, key: key, known: known, atSec: wallSec))
            ?? RouteResume.Decision(resume: false, why: RouteResume.Why.notPaused)
        if decision.resume && state.currentItem == nil {
            // Nothing to resume (not expected: a loss arms only while playing).
            decision = RouteResume.Decision(resume: false, why: "no-item")
        }
        diag("route", [JSONMember("kind", .string("back")),
                       JSONMember("port", change.portType.map { JSONNode.string($0) } ?? .null),
                       JSONMember("class", .string(change.routeClass.rawValue)),
                       JSONMember("key", RouteResume.rowKey(key).map { JSONNode.string($0) } ?? .null),
                       JSONMember("known", .bool(known)),
                       JSONMember("lostSec", Rows.finiteOrNull(lostSec.map { ($0 * 10).rounded() / 10 })),
                       JSONMember("pausedBy", .string(pausedBy.rawValue)),
                       JSONMember("decision", .string(decision.resume ? "resume" : "no")),
                       JSONMember("why", .string(decision.why))])
        if decision.resume {
            // Like a car's press: grace from this moment, then the activation.
            begin(.routeResume, source: .autoresume)
        } else if audibleNow, state.isRunning, let key {
            // Playing on through a route that just arrived (a car connecting
            // while the phone plays): heard through it from now.
            state.heardRoute = HeardRoute(key: key, sinceMono: now.monoMs, untilMono: nil)
        }
    }

    // MARK: - Route resume's bookkeeping (NE-38rs)

    /// Wall-clock seconds: a loss's age must keep counting while the phone
    /// sleeps (route-resume.js THE CLOCK), which uptime does not.
    private var wallSec: Double { now.wallMs / 1000 }

    /// A port's salted key, or nil for a port with no UID.
    private func routeKey(_ portType: String?, _ uid: String?) -> String? {
        RouteResume.hashedKey(portType: portType, uid: uid, salt: config.routeSalt)
    }

    /// One event through route-resume.js's reducer.
    @discardableResult
    private mutating func routeResumeStep(_ event: RouteResume.Event) -> RouteResume.Decision? {
        let result = RouteResume.step(state.routeResume, event, bluetoothArm: config.routeResumeBluetooth)
        state.routeResume = result.state
        return result.decision
    }

    /// A press: "pause", "play", or any other name (a skip, a seek).
    private mutating func routePress(_ command: String) {
        routeResumeStep(.press(command: command))
    }

    /// What a page command is as a press, if it is one. A toggle is whichever
    /// way it will go (the same native truth `toggle` reads).
    private func pressName(_ command: EngineContract.Command) -> String? {
        switch command {
        case .playEpisode, .playForay, .play, .jump: return "play"
        case .pause, .stop, .purge: return "pause"
        case .toggle: return state.isRunning || audibleNow ? "pause" : "play"
        case .next: return "next"
        case .previous: return "previous"
        case .seekBy, .seekTo: return "seek"
        default: return nil
        }
    }

    /// A remote command as a press (a remote stop is a pause, T-7).
    private func remotePressName(_ command: MediaMapping.RemoteCommand) -> String {
        switch command {
        case .play: return "play"
        case .pause, .stop: return "pause"
        case .togglePlayPause: return state.isRunning || audibleNow ? "pause" : "play"
        default: return command.rawValue
        }
    }

    /// The deck became audible (`.playing` for the loaded token): the route it
    /// is heard through starts (or continues) a heard span.
    private mutating func startHearing() {
        guard let route = now.route, let key = routeKey(route.portType, route.uid) else {
            state.heardRoute = nil
            return
        }
        if let heard = state.heardRoute, heard.key == key, heard.untilMono == nil { return }
        state.heardRoute = HeardRoute(key: key, sinceMono: now.monoMs, untilMono: nil)
    }

    /// The deck stopped being audible: the span ends here (kept, so a loss
    /// that arrives just after the pause still counts what was heard). A span
    /// that already reached `knownAfterMs` through the route that is STILL
    /// current makes it known here: the next `.playing` (after a stall, or a
    /// pause the listener undoes) starts a new span from zero, and the
    /// position tick that `noteHeard` otherwise rides is 15 s apart. A span
    /// whose route has already changed (the pause came first, plan §4.3) is
    /// left for the loss to count.
    private mutating func stopHearing() {
        guard var heard = state.heardRoute, heard.untilMono == nil else { return }
        heard.untilMono = now.monoMs
        state.heardRoute = heard
        if heard.heardMs(atMono: now.monoMs) >= RouteResume.knownAfterMs,
           let route = now.route, heard.key == routeKey(route.portType, route.uid) {
            state.knownRoutes.use(heard.key)
        }
    }

    /// At the top of every turn: a span heard for `knownAfterMs` through the
    /// route that is still current makes that route known (once per span).
    private mutating func noteHeard() {
        guard let heard = state.heardRoute, heard.untilMono == nil, now.deck.audible,
              heard.heardMs(atMono: now.monoMs) >= RouteResume.knownAfterMs,
              let route = now.route, heard.key == routeKey(route.portType, route.uid) else { return }
        state.knownRoutes.use(heard.key)
    }

    /// At the end of every turn: an intent to play that did not survive the
    /// turn (a refused activation, a failed load, the queue's end) is the
    /// system's pause to the reducer, so it can never be a route's.
    private mutating func settleRouteResume() {
        guard state.routeResume.playing, state.pendingActivation == nil, !state.isRunning, !audibleNow else { return }
        routeResumeStep(.system)
    }

    /// Media services were reset: the session is gone and every AVFoundation
    /// object with it. Re-apply the category, rebuild, and land paused and NOT
    /// resumable (`interrupted(wasPlaying: false)`): the deck holds nothing,
    /// so the next play rebuilds from the saved position.
    private mutating func onMediaServicesReset() {
        let transition = SessionPolicy.transition(from: state.session, on: .mediaServicesReset, holdPolicy: state.holdPolicy)
        stopRow(.mediaServicesReset)
        routeResumeStep(.system)
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
            if autoplay {
                // The car's play that relaunched us: a press (route-resume.js).
                routePress("play")
                begin(.coldPlay, source: .restore)
            }
        case .background:
            state.backgrounded = true
            flushPosition()
        case .terminating:
            flushPosition()
        case .foreground:
            state.backgrounded = false
            reconcile(unexplainedPause: false, routeAttributed: false)
        case .teardown:
            teardown()
        }
    }

    private mutating func onTimer(_ timer: EngineTimer) {
        switch timer {
        case .positionTick:
            persistIfDue()
            persistForay(force: false)
        case .seamBeat:
            state.seamTimerArmed = false
            finishSeamGap()
        case .narrationTick:
            state.narrationTickArmed = false
            narrationTick()
        case .silenceCap:
            // INTERLUDE_CEILING_SEC from the out-point: past it only grace covers.
            // Its row first (D-5, NE-40): digital silence in a seam is not the
            // listener's audio stopping, so it is not a `stop` row, but it is
            // named before the command that ends it, like every silencer.
            guard state.silenceActive else { return }
            state.silenceActive = false
            diag("silence", [JSONMember("kind", .string("capped"))])
            out.append(.silenceStop)
        case .graceExpired:
            guard state.grace != nil else { return }
            // The deterministic outcome (plan §4.4): end the task, say so,
            // and pause, as the listener's own pause would.
            stopRow(.graceExpired)
            endGrace(.expired)
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
        // A spoken line has nothing in the deck: the deck's playhead is left
        // over from the item before it, and an utterance has no position.
        if state.narration != nil && item.id == state.loadedId { return }
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
        persistForay(force: true)
    }

    /// `_persistIfDue`: the periodic write, while playing, when the playhead
    /// has moved enough on this item since the last write by anyone.
    private mutating func persistIfDue() {
        guard case .playing = state.player, let item = state.currentItem, item.bounds == nil,
              state.loadedId == item.id, state.narration == nil,
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
            voiceId: state.voiceId,
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

    // MARK: - The late-timer detector (NE-46)

    /// NE-46: every engine timer that fires while grace is held compares its
    /// due time with now: the seam beat, the silence cap, the narration tick
    /// (each from the ledger `ledgerTimers` keeps), and the load deadline
    /// (the deck's own `afterMs` against `EngineConfig.loadDeadlineMs` for
    /// the load's class). More than `NARRATION_SUSPEND_GAP_MS` late means the
    /// process was SUSPENDED despite the task grace held, and that is the one
    /// thing the silence node exists for: `grace kind=late timer= lateMs=
    /// inSeam=y|n bgRemainingMs=`. A drive with an `inSeam=y` row is the
    /// evidence the flag flip needs (NE-38e verdict `suspension-in-seam`).
    /// The row decides nothing: the input is then handled exactly as before.
    ///
    /// TWO CLOCKS. `monoMs` is uptime, and uptime (like the host's dispatch
    /// timers, which run on it) STOPS while the device sleeps. A process that
    /// iOS suspends in a seam on a locked phone in a car is exactly the one
    /// whose device may then sleep, and on uptime alone its timer would look
    /// on time however long the listener waited. So each due time is also
    /// kept on the wall clock, and the row fires on whichever clock is more
    /// late; `clock=wall` says only the wall clock saw it (the device slept,
    /// or, rarely, the wall clock was set under the drive).
    private mutating func noteLateness(_ input: EngineInput) {
        switch input {
        case let .timer(timer):
            let dueWall = state.timerDueWall.removeValue(forKey: timer)
            guard let due = state.timerDueMono.removeValue(forKey: timer) else { return }
            lateRow(timer: timer.rawValue, monoLateMs: now.monoMs - due,
                    wallLateMs: dueWall.map { now.wallMs - $0 })
        case let .deck(.deadlineExceeded(token, afterMs, _)):
            guard token == state.lastToken, let deadlineClass = state.lastLoadClass,
                  let deadlineMs = config.loadDeadlineMs[deadlineClass] else { return }
            lateRow(timer: EngineCore.loadDeadlineTimer, monoLateMs: Double(afterMs) - deadlineMs,
                    wallLateMs: state.lastLoadWallMs.map { now.wallMs - $0 - deadlineMs })
        default:
            return
        }
    }

    /// The `timer=` of a late load deadline (the deck runs it, not the core).
    public static let loadDeadlineTimer = "load-deadline"

    private mutating func lateRow(timer: String, monoLateMs: Double, wallLateMs: Double?) {
        let gap = EngineConstants.QueueManager.narrationSuspendGapMs
        let mono = monoLateMs.isFinite ? monoLateMs : -Double.infinity
        let wall = wallLateMs.flatMap { $0.isFinite ? $0 : nil } ?? -Double.infinity
        let lateMs = Swift.max(mono, wall)
        guard let reason = state.grace, lateMs > gap else { return }
        diag("grace", [JSONMember("kind", .string("late")),
                       JSONMember("timer", .string(timer)),
                       JSONMember("lateMs", .number(lateMs.rounded())),
                       JSONMember("inSeam", .string(inSilentSeam ? "y" : "n")),
                       JSONMember("bgRemainingMs", Rows.finiteOrNull(now.bgRemainingMs.map { $0.rounded() })),
                       JSONMember("reason", .string(reason.rawValue)),
                       JSONMember("clock", .string(mono > gap ? "mono" : "wall"))])
    }

    /// Between an out-point and the next item's audible start: a beat is
    /// running (or its parked load waits), or the span grace holds is a
    /// seam's (`seam`, `prepare-miss`, or the handover after a spoken line).
    private var inSilentSeam: Bool {
        if state.inSeamGap || state.gapParkedToken != nil { return true }
        switch state.grace {
        case .seam?, .prepareMiss?, .narrationHandover?: return true
        default: return false
        }
    }

    /// After every turn: when each one-shot timer the turn armed is due, and
    /// which it cancelled. Read from the commands themselves, so no arm site
    /// can forget it.
    private mutating func ledgerTimers() {
        for command in out {
            switch command {
            case let .timerArm(timer, afterMs, repeating):
                state.timerDueMono[timer] = repeating ? nil : now.monoMs + afterMs
                state.timerDueWall[timer] = repeating ? nil : now.wallMs + afterMs
            case let .timerCancel(timer):
                state.timerDueMono[timer] = nil
                state.timerDueWall[timer] = nil
            default:
                continue
            }
        }
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
        case let .load(_, _, _, startSec, _, deadlineClass, _):
            state.lastLoadClass = deadlineClass
            state.lastLoadWallMs = now.wallMs
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
        case .setRate, .setOutPoint, .prepare:
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

    // MARK: - Forays (NE-30s)

    /// A Foray the ENGINE was handed (`playForay`): its transport runs on the
    /// Foray clock. A queue loaded through the manager's own surface (a
    /// parity scenario's `playForay`) keeps the manager's transport.
    private var forayTransport: Bool { config.forayTapeEnabled && state.forayId != nil }

    /// The queue as the Foray clock reads it.
    private var forayItems: [ForayItem?] { state.queue.map { Optional($0.forayItem) } }

    /// Where the listener is on the Foray clock (client.js `forayPlayhead`):
    /// the deck's playhead once it holds the item, the second a load in flight
    /// will land on, else unknown (nil), which a write never guesses.
    private func forayPositionSec(of item: EngineItem) -> Double? {
        let playhead: Double?
        if let line = state.narration, line.itemId == item.id, state.loadedId == item.id {
            // A spoken line's clock is wall time since it started (L-03).
            playhead = line.elapsedSec(atMono: now.monoMs)
        } else if state.loadedId == item.id {
            playhead = deck.positionSec
        } else if let pending = state.pendingLoad, pending.itemId == item.id {
            playhead = pending.startSec
        } else {
            playhead = nil
        }
        guard let playhead, playhead.isFinite else { return nil }
        return ForayClock.forayElapsed(forayItems, index: Double(state.currentIndex), playheadSec: playhead)
    }

    /// `playForay {forayId, title, items, buildReport, startElapsedSec?,
    /// isLocalFile, allowAdPad, voiceId}` (plan §5.2). The page built the
    /// queue (A-1); the engine RE-VALIDATES its structure (J-4) and refuses it
    /// whole, before anything is audible, when any item is not what
    /// `buildForayQueue` guarantees. A resume point on the Foray clock lands
    /// inside its clip (`segmentAtElapsed`, `sourceOffsetFor`).
    private mutating func playForay(_ args: EngineContract.PlayForay, source: EngineSource) {
        let items = args.items.compactMap { EngineItem(node: $0.node) }
        let verdict = StructuralCheck.check(items.map { Optional($0.forayItem) })
        guard items.count == args.items.count, verdict.ok else {
            diag("foray", [JSONMember("kind", .string("refused-structure")),
                           JSONMember("problems", .number(Double(verdict.problems.count)))])
            return refuse(.refusedStructure)
        }
        // LEAVING IS A FLUSH: whatever was playing writes where it got to.
        flushPosition()
        state.queue = items
        state.currentIndex = -1
        state.forayId = args.forayId
        state.forayTitle = args.title
        state.forayIsLocalFile = args.isLocalFile
        state.forayAllowAdPad = args.allowAdPad
        state.lastEpisodeRow = nil
        state.lastEpisodeRowWritten = false
        state.startingHop = nil
        state.closed = false
        state.preparedItemId = nil
        state.seamMark = nil
        state.skippedSegments = 0
        state.clipLoadSteps = 0
        state.forayFinishedWritten = false
        state.forayThrottle.clear(forayId: args.forayId)
        if let elapsed = args.startElapsedSec, let at = ForayClock.segmentAtElapsed(forayItems, elapsed: elapsed),
           items.indices.contains(at.index) {
            let offset = TransportPolicy.sourceOffset(for: items[at.index].transportItem, into: at.into)
            return playIndex(at.index, startSec: offset, source: source)
        }
        playIndex(0, startSec: nil, source: source)
    }

    /// A scrub on the Foray clock (`seekTo` in a Foray, from the page, the
    /// lock screen or the car): which item it lands in and where
    /// (`segmentAtElapsed`), then `scrubTarget` (reference-engine.js
    /// `_forayScrub`, client.js `foraySeek`):
    ///
    ///   - another item, a Foray with nothing loaded, or a RENDERED line in
    ///     `.transitioning` (where the reducer refuses every seek) is a load
    ///     at the offset; a spoken line elsewhere loads from its first word;
    ///   - the SPOKEN line already sounding is said again from the top (the
    ///     manager's restart): speech has no offset, and this used to answer
    ///     nothing at all, silently;
    ///   - the same clip, or a rendered line that is `.playing`, is a seek.
    private mutating func forayScrub(to elapsed: Double, source: EngineSource) {
        guard let at = ForayClock.segmentAtElapsed(forayItems, elapsed: elapsed),
              state.queue.indices.contains(at.index) else { return refuse(.notLoaded) }
        let item = state.queue[at.index]
        let scrub = TransportPolicy.scrubTarget(atIndex: Double(at.index), into: at.into, item: item.transportItem,
                                                currentIndex: Double(state.currentIndex), stateType: state.stateType)
        if scrub.restart { return restartCurrentItem(source: source) }
        if scrub.reload { return playIndex(at.index, startSec: scrub.offset, source: source) }
        guard let offset = scrub.offset else { return }
        cutSeamGap("seek")
        dispatch(.seek(seconds: offset, precise: true))
        releaseSeamGap()
    }

    /// A back-15 / forward-30 nudge in a Foray (client.js `nudgeBy`,
    /// reference-engine.js `_forayNudge`): a step on the Foray clock, stopped
    /// short of the total (`skipTarget(foray: true)`). INSIDE the spoken line
    /// now sounding the synthesiser has no offset, so `nudgeAction` says what
    /// the press does: back says the line again, forward goes on to the item
    /// after it, and forward from the closing line has nothing to go to
    /// (refused `no-next`, never a silent nothing). Anywhere else it is an
    /// ordinary scrub.
    private mutating func forayNudge(_ deltaSec: Double, source: EngineSource) {
        guard let item = state.currentItem else { return refuse(.notLoaded) }
        let starts = ForayClock.segmentStarts(forayItems)
        let position = forayPositionSec(of: item)
            ?? (starts.indices.contains(state.currentIndex) ? starts[state.currentIndex] : 0)
        guard let target = TransportPolicy.skipTarget(foray: true, positionSec: position, offsetSec: deltaSec,
                                                      durationSec: ForayClock.forayRuntimeSec(forayItems)) else { return }
        let at = ForayClock.segmentAtElapsed(forayItems, elapsed: target)
        // `isNarrationPlayhead` (`_loadedIsSynth`): the spoken line IS what
        // the playhead is on, not a speak() still in flight.
        let speaking = state.narration.map { $0.itemId == item.id && state.loadedId == item.id } ?? false
        switch TransportPolicy.nudgeAction(offsetSec: deltaSec, landsInCurrentItem: at?.index == state.currentIndex,
                                           narrationPlayhead: speaking,
                                           onLastItem: state.currentIndex >= state.queue.count - 1) {
        case .restartLine: restartCurrentItem(source: source)
        case .skipLine: next(source: source)
        case .nothing: refuse(.noNext)
        case .seek: forayScrub(to: target, source: source)
        }
    }

    /// The manager's restart of the item the playhead is on
    /// (`skipToPrevious`): from its first word for a line, its in-point for a
    /// clip. Not `previous(source:)`, whose Foray rule goes to the item
    /// BEFORE inside the restart window.
    private mutating func restartCurrentItem(source: EngineSource) {
        cutSeamGap("skipToPrevious")
        begin(.skipPrevious, source: source)
        releaseSeamGap()
    }

    /// `_warmNextSegment(at)`: name the item the next boundary will advance
    /// to and its in-point, so the standby deck can load it while this one is
    /// still audible. Two callers (queue-manager.js §11, NE-45j; card NE-45s):
    ///
    ///   - the deck's `.prepareWindow` (`at: "window"`), the prefetch lead
    ///     before the boundary: the out-point, or the file's end for an item
    ///     with none (a rendered line, an episode's natural end);
    ///   - the START of a SPOKEN line (`at: "line-start"`), because the
    ///     synthesiser is audible and the deck is idle.
    ///
    /// WARMING FOLLOWS THE FILE, NOT THE BEAT (`DeckPolicy.warmsAcross`): the
    /// next item is prepared when it has a file (a clip, or a rendered line),
    /// whatever the beat says. It used to be `SeamGap.gapSec(...) > 0`, which
    /// warmed only clip -> clip seams and left clip -> line -> clip two cold
    /// loads (the M2 leftover). A spoken line has no file and prepares
    /// nothing; a Foray's last item prepares nothing, since a Foray never
    /// chains. Only an AUDIBLE item approaches a boundary: a playing one, or a
    /// line bridging a seam (`transitioning`), and what follows it is counted
    /// the way `itemEnded` counts it from each state.
    private mutating func warmNextSegment(at: String) {
        guard config.forayTapeEnabled, let from = state.currentItem else { return }
        let bridging: Bool
        switch state.player {
        case .playing: bridging = false
        case .transitioning: bridging = true
        case .idle, .loadingItem, .interrupted, .ended: return
        }
        guard let next = nextItem(from: cursor, skipBridges: bridging) else {
            return diag("prepare", [JSONMember("kind", .string("none")), JSONMember("where", .string(at))])
        }
        guard DeckPolicy.warmsAcross(from: from, to: next.item) else {
            return diag("prepare", [JSONMember("kind", .string("skipped")), JSONMember("item", .string(next.item.id)),
                                    JSONMember("where", .string(at))])
        }
        state.preparedItemId = next.item.id
        deckCommand(.prepare(itemId: next.item.id, url: next.item.audioUrl, startSec: next.item.bounds?.startSec ?? 0,
                             deadlineClass: DeckDeadlineClass(next.item),
                             preciseTiming: next.item.preciseTiming(approximateCBR: config.approximateCBRClips),
                             bounded: next.item.bounds != nil))
    }

    /// A seam that touches a Foray SEGMENT (a bounded slice): a Foray's line
    /// seams are always next to one, and a plain episode queue's (M1's
    /// bridges between whole episodes) never are.
    static func isForaySeam(from: EngineItem, to: EngineItem) -> Bool {
        from.bounds != nil || to.bounds != nil
    }

    /// NE-45s: the seam an item's end just crossed, remembered until the next
    /// item is audible, so every seam (clip -> clip, clip -> line, line -> clip)
    /// packs ONE row with its kinds and whether the standby was ready.
    private mutating func markSeam(from: EngineItem, to: EngineItem) {
        state.seamMark = SeamMark(from: SeamRow.ItemKind(from), to: SeamRow.ItemKind(to), toItemId: to.id,
                                  endedAtMono: now.monoMs)
    }

    // MARK: the seam beat (queue-manager.js §10)

    /// `_setGapDeadline`: the one writer of the deadline, so the `beat` row
    /// (the page's `onSeamGapChange`) can never disagree with `inSeamGap`.
    private mutating func setGapDeadline(_ until: Double?) {
        let was = state.gapUntilMono != nil
        state.gapUntilMono = until
        if until == nil { state.gapArmedAtMono = nil }
        if was != (until != nil) {
            diag("beat", [JSONMember("kind", .string(until != nil ? "begin" : "end"))])
        }
    }

    /// `_armSeamGap(from, to, bridged)`: at the moment the out-point (or a
    /// natural end) fires, decide whether this transition is a seam and stamp
    /// the ABSOLUTE deadline. The beat is wall clock: it does not scale with
    /// the listener's rate.
    private mutating func armSeamGap(from: EngineItem, to: EngineItem, bridged: Bool) {
        let sec = SeamGap.gapSec(from: from.seam, to: to.seam, bridged: bridged, cause: SeamGap.autoAdvance,
                                 gapSec: config.seamGapSec)
        guard sec > 0 else { return }
        setGapDeadline(now.monoMs + sec * 1000)
        state.gapArmedAtMono = now.monoMs
        state.gapAskedMs = sec * 1000
    }

    /// `_awaitSeamGap(seq)`: hold what remains of the beat, then start the
    /// item, if this load still owns the player. Nothing remaining (no beat,
    /// or a slow load that already spent it) starts it now: a slow load costs
    /// max(gap, load), never gap + load.
    private mutating func awaitSeamGap(_ token: DeckToken) {
        let remaining = seamGapRemainingMs(atMono: now.monoMs)
        if remaining <= 0 {
            let armedAt = state.gapArmedAtMono
            // A jingle still claiming to sound once the whole deadline is
            // spent (a slow load past the ceiling) loses to the tape.
            stopInterlude("spent")
            setGapDeadline(nil)
            return seamLanded(armedAt: armedAt)
        }
        state.gapParkedToken = token
        state.gapCut = false
        state.seamTimerArmed = true
        out.append(.timerArm(.seamBeat, afterMs: remaining, repeating: false))
    }

    /// The parked wait's `finish`: the beat ran out, or the action that cut it
    /// has issued its own load. Idempotent. A newer load (a skip, a jump, the
    /// ladder walking past a refused segment) means this one is abandoned
    /// quietly; otherwise `itemLoaded`, which the reducer reads by state: the
    /// out-point armed and the item started, a scrub's pending seek applied,
    /// or nothing at all after a pause or a stop.
    private mutating func finishSeamGap() {
        guard let token = state.gapParkedToken else { return }
        state.gapParkedToken = nil
        if state.seamTimerArmed {
            state.seamTimerArmed = false
            out.append(.timerCancel(.seamBeat))
        }
        state.gapCut = false
        let armedAt = state.gapArmedAtMono
        // §13: the deadline ran out with the jingle still sounding (the
        // ceiling). Two audible things at once is corner case #19's shape,
        // so the jingle loses. A no-op whenever it ended on its own.
        stopInterlude("ceiling")
        setGapDeadline(nil)
        guard state.lastToken == token else {
            return diag("beat", [JSONMember("kind", .string("superseded"))])
        }
        seamLanded(armedAt: armedAt)
    }

    /// The load the beat held becomes audible: the packed `seam` row (plan
    /// §13 item 37) when it was a real seam, then `itemLoaded`.
    private mutating func seamLanded(armedAt: Double?) {
        // NE-32: the DeckPair's own report on this load, when it sent one,
        // is the truth about the standby deck (a prepare ASKED is not a
        // prepare HIT); without one the row says what it always said.
        let report = state.deckPrepare.flatMap { $0.token == state.loadedToken ? $0 : nil }
        state.deckPrepare = nil
        packSeamRow(armedAt: armedAt, report: report)
        stopSilence("landed")
        dispatch(.itemLoaded)
        // §11 (NE-45j): a SPOKEN line leaves the deck idle, so what follows it
        // is prepared now, at the line's start (`_loadItem`).
        if case .playing = state.player, let line = state.narration, line.itemId == state.loadedId {
            warmNextSegment(at: "line-start")
        }
    }

    /// The packed `seam` row (plan §13 item 37; NE-45s), written when the item
    /// after a seam becomes audible: a beat's seam (`armedAt`, stamped at the
    /// out-point) or any seam `markSeam` remembered, a line's included, which
    /// has no beat and so no row before NE-45s. The row names the seam's kinds
    /// (`from`, `to`: clip or line) and `prepare`: `hit` (the standby was
    /// promoted), `miss` (it was prepared and the item still loaded cold) or
    /// `none` (nothing was prepared: one deck, a spoken line, a same-source
    /// seek on the playing deck).
    private mutating func packSeamRow(armedAt: Double?, report: DeckPrepareReport?) {
        let mark = state.seamMark.flatMap { $0.toItemId == state.loadedId ? $0 : nil }
        state.seamMark = nil
        guard let start = armedAt ?? mark?.endedAtMono else { return }
        let spoken = state.narration.map { $0.itemId == state.loadedId } ?? false
        var row = SeamRow(observedGapMs: now.monoMs - start, askedGapMs: armedAt != nil ? state.gapAskedMs : 0,
                          prepared: report?.hit
                              ?? (!spoken && state.preparedItemId != nil && state.preparedItemId == state.loadedId),
                          grace: state.grace != nil, bgRemainingMs: now.bgRemainingMs.map { $0.rounded() },
                          stages: report.map { $0.stages + [.play] } ?? (spoken ? [.play] : [.ready, .play]))
        if let mark {
            row.from = mark.from
            row.to = mark.to
            row.prepare = mark.prepare ?? .unprepared
        }
        out.append(.diag(row.entry))
    }

    /// `_cutSeamGap(why)`: EVERY transport action ends a running beat (the
    /// beat marks an edit the listener did not ask for; touching the transport
    /// names a destination). The clock stops now; the parked wait is left
    /// parked until `releaseSeamGap`, after the action's own load.
    private mutating func cutSeamGap(_ why: String) {
        // §13: a jingle is the beat with sound in it, so whatever cuts the
        // beat silences the jingle (and the silence node under it).
        stopInterlude(why)
        stopSilence(why)
        setGapDeadline(nil)
        // NE-45s: the seam the listener moved during is not a seam any more.
        state.seamMark = nil
        guard state.gapParkedToken != nil, !state.gapCut else { return }
        state.gapCut = true
        if state.seamTimerArmed {
            state.seamTimerArmed = false
            out.append(.timerCancel(.seamBeat))
        }
        diag("beat", [JSONMember("kind", .string("cut")), JSONMember("why", .string(why))])
    }

    /// `_releaseSeamGap`: let a cut wait go, now that `lastToken` tells the
    /// truth. A parked activation's action has not run yet: its answer
    /// releases it (`onSessionResult`).
    private mutating func releaseSeamGap() {
        guard state.gapParkedToken != nil, state.gapCut, state.pendingActivation == nil else { return }
        finishSeamGap()
    }

    /// `_endSeamGap(why)`: cut and release, for the paths that end a seam
    /// without being a transport action (a failed load, a queue run out).
    private mutating func endSeamGap(_ why: String) {
        cutSeamGap(why)
        releaseSeamGap()
    }

    // MARK: ADR-0007 at load, and rendered bridges

    /// The ladder refused the copy in hand: the segment is never audible. A
    /// `skipped` event and row say so, and the Foray moves on.
    private mutating func refuseAtLoad(_ item: EngineItem, reason: String) {
        state.skippedSegments += 1
        let index = state.queue.firstIndex(where: { $0.id == item.id }) ?? state.currentIndex
        diag("skip", [JSONMember("kind", .string("ladder")), JSONMember("item", .string(item.id)),
                      JSONMember("index", .number(Double(index)))])
        out.append(.emit(.skipped(itemId: item.id, index: index, reason: reason)))
        skipUnplayableSegment()
    }

    /// `_skipUnplayableSegment`: still `loadingItem` (nothing was started), so
    /// `skipToNext` replaces the in-flight target. With something left the
    /// beat's deadline is KEPT: the refusal happened inside the beat, so the
    /// replacement spends what remains of it. With nothing left the Foray
    /// ends instead of looping, and there is no load to spend the beat.
    private mutating func skipUnplayableSegment() {
        let next = nextItem(from: cursor, skipBridges: false)
        if let next {
            state.targetIndex = next.index
        } else {
            // D-5 (NE-40): the cause first, before the cut silences a jingle.
            stopRow(.finalEnd)
            endSeamGap("queueExhausted")
        }
        dispatch(.skipToNext(next?.item.ref))
        if next == nil, state.stateType == "ended" {
            markForayFinished()
            applySession(SessionPolicy.transition(from: state.session, on: .finalEnd, holdPolicy: state.holdPolicy))
        }
    }

    /// `_playTransitionBridge`: the reducer is `transitioning` onto a narration
    /// bridge. A RENDERED one (a file) plays on the deck from 0 the moment it
    /// lands; a SPOKEN one is handed to the synthesiser (NE-31s). One that is
    /// missing, or fails to load or to speak, is stepped over so the queue
    /// never stalls.
    private mutating func playTransitionBridge() {
        guard case let .transitioning(_, to) = state.player else {
            return diag("bridge", [JSONMember("kind", .string("without-transitioning"))])
        }
        guard let index = state.queue.firstIndex(where: { $0.id == to.id }) else { return advancePastBridgeFailure() }
        let bridge = state.queue[index]
        state.currentIndex = index
        state.lastToken += 1
        let token = state.lastToken
        if bridge.isSynthNarration { return speakLine(bridge, token: token, bridge: true) }
        state.pendingLoad = PendingLoad(token: token, itemId: bridge.id, startSec: 0, bridge: true)
        deckCommand(.load(token: token, itemId: bridge.id, url: bridge.audioUrl, startSec: 0, preciseTiming: false,
                          deadlineClass: DeckDeadlineClass(bridge)))
    }

    /// `_advancePastBridgeFailure`: the item after the bridge, bridges skipped.
    private mutating func advancePastBridgeFailure() {
        let next = nextItem(from: cursor, skipBridges: true)
        dispatch(.itemEnded(next: next?.item.ref, bridged: false))
    }

    // MARK: - The narrating overlay (NE-31s; queue-manager.js §7 and L-03/L-05)

    /// The multiplier a line is uttered at: `NARRATION_RATE` (1x, OQ-3,
    /// founder 2026-09-24), unless `narrationFollowsListenerRate` is on.
    private var utteranceRate: Double {
        config.narrationFollowsListenerRate ? state.rate : EngineConstants.QueueManager.narrationRate
    }

    /// `_loadItem` for a script-only line. RE-ENTERING A PAUSED UTTERANCE IS A
    /// RESUME, NOT A RESTART (L-05): every resume path routes back through a
    /// load, which is right for a deck and wrong for a synthesiser (`speak`
    /// has no offset), so a re-entry into the line the playhead is already on,
    /// with the line paused and no restart asked for, speaks nothing and lets
    /// `startPlayback` continue the same utterance.
    private mutating func loadSpokenLine(_ item: EngineItem, token: DeckToken, restart: Bool) {
        if !restart, state.loadedId == item.id, let line = state.narration, line.itemId == item.id, line.paused {
            state.pendingLoad = nil
            diag("narration", [JSONMember("kind", .string("resuming-in-place"))])
            return landed(item, token: token)
        }
        speakLine(item, token: token, bridge: false)
    }

    /// `_speakNarration`: ask the synthesiser for utterance `seq`. Like a
    /// deck load it is a request now and an answer later (`started` or
    /// `failed` for that seq), and the playhead moves only on `started`.
    private mutating func speakLine(_ item: EngineItem, token: DeckToken, bridge: Bool, fallback: Bool = false) {
        state.speakSeq += 1
        let seq = state.speakSeq
        state.pendingLoad = PendingLoad(token: token, itemId: item.id, startSec: 0, bridge: bridge, spokenSeq: seq,
                                        fallback: fallback)
        // The audible-start backstop (plan §4.4), as `startPlayback`'s: a line
        // is never spoken into a session this engine does not hold.
        guard state.session == .active else {
            diag("fault", [JSONMember("kind", .string("no-session")), JSONMember("at", .string("narration")),
                           JSONMember("session", .string(state.session.rawValue))])
            return onLoadFailure(token, message: "no active session for narration", cause: .error)
        }
        out.append(.narration(.speak(seq: seq, text: item.node["script"]?.stringValue ?? "", voiceId: state.voiceId,
                                     utteranceRate: utteranceRate)))
    }

    private mutating func onNarrator(_ event: NarratorEvent) {
        guard config.forayTapeEnabled else { return }
        switch event {
        case let .started(seq, voiceFallback):
            narrationStarted(seq, voiceFallback: voiceFallback)
            // A spoken line of ours is audible (route-resume.js "playing").
            if state.narration?.seq == seq { routeResumeStep(.playing) }
        case let .failed(seq, _):
            guard let pending = state.pendingLoad, pending.spokenSeq == seq else {
                return diag("narration", [JSONMember("kind", .string("superseded-failure")), JSONMember("seq", .number(Double(seq)))])
            }
            // A failed speak is not a voice-fallback report (`_lastSpeakResult = null`).
            state.lastVoiceFallback = nil
            // The existing "a load failed" path: a bridge is stepped over, a
            // line the listener asked for is the page's error.
            onLoadFailure(pending.token, message: "foray-tts: speak refused", cause: .error)
        case let .finished(seq):
            finishLine(seq, why: "finished")
        case let .cancelled(seq):
            // A stop, a replacement, or the session taken from under the line:
            // NEVER an advance (L-05, "stop never advances"). What happens next
            // is the transport's (a pause, a stop) or the interruption's.
            diag("narration", [JSONMember("kind", .string("cancelled")),
                               JSONMember("current", .bool(state.narration?.seq == seq))])
        case let .resumed(seq, answer):
            narrationResumed(seq, answer)
        }
    }

    /// The synthesiser accepted utterance `seq`: the line IS the playhead now
    /// (`_loadedId`, `_beginSynthNarration`). A `_loadItem` line then takes
    /// the gate and the beat like any landed load; a bridge is already
    /// `transitioning` and plays on.
    private mutating func narrationStarted(_ seq: Int, voiceFallback: Bool) {
        guard let pending = state.pendingLoad, pending.spokenSeq == seq,
              let item = state.queue.first(where: { $0.id == pending.itemId }) else {
            // SUPERSEDED WHILE speak() WAS IN FLIGHT (audit round 3,
            // player-core-4/7): the voice started on accept, and a skip, a row
            // tap or a stop moved the player on. Silence it, unless a newer
            // speak() already replaced it (`_abandonSpeech`). A repeated
            // `started` for the line already playing is not a stale one.
            if state.narration?.seq != seq { abandonSpeech(seq) }
            return diag("narration", [JSONMember("kind", .string("superseded")), JSONMember("seq", .number(Double(seq)))])
        }
        // THE LISTENER CAN MOVE WHILE THE LINE'S speak() IS IN FLIGHT (audit
        // round 3, player-core-2/4): a pause or an interruption changes the
        // state but not the pending line. The line starts only if the machine
        // is still loading it (`_loadItem`) or still transitioning to it
        // (`_playTransitionBridge`); otherwise the voice that already began is
        // silenced and nothing else moves.
        guard stillOn(pending) else {
            state.pendingLoad = nil
            abandonSpeech(seq)
            return diag("narration", [JSONMember("kind", .string("left-while-speaking")),
                                      JSONMember("seq", .number(Double(seq)))])
        }
        state.pendingLoad = nil
        state.lastVoiceFallback = voiceFallback
        state.loadedId = pending.itemId
        state.loadedToken = pending.token
        state.startingHop = nil
        // A spoken line is the playhead: no deck stall describes it.
        clearStallLatch()
        state.narration = SpokenLine(seq: seq, itemId: item.id, startedAtMono: now.monoMs)
        // §14: remembered only for a rendered line spoken INSTEAD of its file.
        state.fallbackSpokenId = pending.fallback ? item.id : nil
        startNarrationTicker()
        if voiceFallback {
            diag("narration", [JSONMember("kind", .string("voice-fallback"))])
        }
        // The line is audible: a span covering its start is over.
        if state.grace != nil { endGrace(.playing) }
        if pending.bridge {
            // NE-45s: a spoken bridge is a seam's audible start (its row says
            // `to=line prepare=none`, or `miss` for a rendered line whose
            // prepared file failed), and the deck is idle while it is spoken,
            // so the clip after it is prepared NOW (`_playTransitionBridge`,
            // and `_speakInsteadMidLine` for a file that failed while sounding).
            packSeamRow(armedAt: nil, report: nil)
            warmNextSegment(at: "line-start")
            return
        }
        landed(item, token: pending.token)
    }

    /// THE STALL LATCH IS PER ITEM (client.js `setNowPlaying`: "something
    /// else is current now, so neither the last item's failure nor its stall
    /// describes it"). `buffering` is set by a `.stalled` and cleared only by
    /// that deck's `.timeControl(.playing)`, and while it is set Now Playing
    /// publishes rate 0: the car reads "paused" and hides the progress bar
    /// (the 2026-09-28 paste; AVDeck's re-report, #866, fixed the late-stall
    /// half). In a Foray the item after a clip that stalled near its end is a
    /// spoken line or the next clip's load, and neither would ever send the
    /// `.playing` that clears it, so the whole next line read "paused".
    private mutating func clearStallLatch() {
        guard state.buffering else { return }
        state.buffering = false
        diag("deck", [JSONMember("kind", .string("stall-cleared"))])
    }

    /// Is the machine still on the line `pending` is speaking? `_loadItem`'s
    /// check (still `loadingItem` with that target) for a line it loads, and
    /// `_playTransitionBridge`'s `stillOurs` (still `transitioning` to it) for
    /// a bridge. A rendered line that failed WHILE SOUNDING and is read from
    /// its script instead (§14, `_speakInsteadMidLine`'s `stillOnIt`) may
    /// also be `playing`.
    private func stillOn(_ pending: PendingLoad) -> Bool {
        guard focusItem?.id == pending.itemId else { return false }
        switch state.player {
        case .loadingItem: return !pending.bridge
        case .transitioning: return pending.bridge
        case .playing: return pending.bridge && pending.fallback
        case .idle, .ended, .interrupted: return false
        }
    }

    /// `_abandonSpeech(mine)`: a speak() whose line the player has left. The
    /// voice started on accept, so it is told to stop, unless a NEWER speak()
    /// has been issued since, which already replaced this utterance and must
    /// not be cut off.
    private mutating func abandonSpeech(_ seq: Int) {
        guard seq == state.speakSeq else { return }
        out.append(.narration(.stop(seq: seq)))
    }

    /// `_endSynthNarration`: a deck item holds the playhead. A line that did
    /// not finish (left paused by a skip, or past its deadline over silence)
    /// is dropped, so the synthesiser never keeps an utterance nobody will
    /// continue.
    private mutating func endSpokenLine() {
        guard let line = state.narration else { return }
        state.narration = nil
        state.fallbackSpokenId = nil
        stopNarrationTicker()
        if !line.finished { out.append(.narration(.discard(seq: line.seq))) }
    }

    /// `_onTtsFinished`: advance past the line EXACTLY ONCE. The event must
    /// name the line the playhead is on (a finish for a line already left is
    /// not this line's), and each line advances at most once
    /// (`_advancedSpeakSeq`), whether by `didFinish` or by its deadline.
    /// Returns whether it advanced.
    @discardableResult
    private mutating func finishLine(_ seq: Int, why: String) -> Bool {
        guard var line = state.narration else {
            diag("narration", [JSONMember("kind", .string("stray-end")), JSONMember("why", .string(why))])
            return false
        }
        guard line.seq == seq else {
            diag("narration", [JSONMember("kind", .string("stale-end")), JSONMember("why", .string(why))])
            return false
        }
        guard state.advancedSpeakSeq != seq else {
            diag("narration", [JSONMember("kind", .string("duplicate-end")), JSONMember("why", .string(why))])
            return false
        }
        state.advancedSpeakSeq = seq
        if why == "finished" {
            line.finished = true
            state.narration = line
        }
        stopNarrationTicker()
        diag("narration", [JSONMember("kind", .string("ended")), JSONMember("why", .string(why))])
        // Grace at narration end: the synthesiser has stopped rendering and
        // the next item is not audible yet, in the background the one span
        // `UIBackgroundModes: audio` does not cover.
        if state.backgrounded && state.isRunning { beginGrace(.narrationHandover) }
        itemEnded()
        return true
    }

    /// `_pauseNarration`: hold the line at a word; its clock freezes.
    /// Idempotent, because the reducer is not.
    private mutating func pauseNarration() {
        guard !narrationStopping, var line = state.narration, !line.paused else { return }
        line.paused = true
        line.pausedAtMono = now.monoMs
        state.narration = line
        stopNarrationTicker()
        out.append(.narration(.pause(seq: line.seq)))
    }

    /// The synthesiser's answer to `resume(seq)` (`_resumeNarration`): the
    /// clock continues from where it froze, restarts with a line re-spoken
    /// from its first word, or (refused) stays frozen with the line paused,
    /// so the next play tries the resume again.
    private mutating func narrationResumed(_ seq: Int, _ answer: NarrationResumeAnswer) {
        guard var line = state.narration, line.seq == seq, line.paused else {
            return diag("narration", [JSONMember("kind", .string("resume-stale")), JSONMember("seq", .number(Double(seq)))])
        }
        switch answer {
        case .refused:
            diag("narration", [JSONMember("kind", .string("resume-refused"))])
            if state.grace != nil { endGrace(.notRunning) }
            return
        case .fromStart:
            line.startedAtMono = now.monoMs
        case .continued, .noAnswer:
            line.startedAtMono += line.pausedAtMono.map { Swift.max(0, now.monoMs - $0) } ?? 0
        }
        line.paused = false
        line.pausedAtMono = nil
        state.narration = line
        startNarrationTicker()
        if state.grace != nil { endGrace(.playing) }
    }

    /// `_stopNarration`: silence the line at once. The line stays the
    /// playhead (a stop is not a skip); its clock is simply no longer paused.
    private mutating func stopNarration() {
        guard var line = state.narration else { return }
        line.paused = false
        line.pausedAtMono = nil
        state.narration = line
        stopNarrationTicker()
        out.append(.narration(.stop(seq: line.seq)))
    }

    /// `_startNarrationTicker`: one pulse `NARRATION_TICK_MS` out, re-armed by
    /// each pulse, only while a surface listens (`narrationPulse`).
    private mutating func startNarrationTicker() {
        stopNarrationTicker()
        guard config.narrationPulse, var line = state.narration else { return }
        let afterMs = EngineConstants.QueueManager.narrationTickMs
        line.tickDueAtMono = now.monoMs + afterMs
        state.narration = line
        state.narrationTickArmed = true
        out.append(.timerArm(.narrationTick, afterMs: afterMs, repeating: false))
    }

    private mutating func stopNarrationTicker() {
        guard state.narrationTickArmed else { return }
        state.narrationTickArmed = false
        out.append(.timerCancel(.narrationTick))
    }

    /// `_tickNarration`. The pulse repaints the surface. A pulse that lands
    /// `NARRATION_SUSPEND_GAP_MS` late means the process was SUSPENDED, not
    /// busy: the slept time never counts towards the deadline (the start is
    /// shifted as a pause shifts it) and the synthesiser is asked, as a fresh
    /// interruption asks it. Past the deadline (the synthesiser's session was
    /// taken and no `didFinish` is coming) the line is finished, once, through
    /// the same guards; a pulse that cannot advance keeps the ticker alive.
    private mutating func narrationTick() {
        guard var line = state.narration else { return }
        let late = line.tickDueAtMono.map { now.monoMs - $0 } ?? 0
        out.append(.narrationPulse(elapsedSec: line.elapsedSec(atMono: now.monoMs)))
        if late > EngineConstants.QueueManager.narrationSuspendGapMs {
            diag("narration", [JSONMember("kind", .string("suspended")), JSONMember("lateMs", .number(late.rounded()))])
            line.startedAtMono += late
            state.narration = line
            startNarrationTicker()
            return reconcileNarrationInterrupted("narration.suspended")
        }
        let deadline = EngineCore.narrationDeadlineSec(state.currentItem, rate: utteranceRate)
        if deadline > 0 && line.elapsedSec(atMono: now.monoMs) > deadline {
            diag("narration", [JSONMember("kind", .string("deadline")), JSONMember("limitSec", .number(deadline.rounded()))])
            if finishLine(line.seq, why: "deadline") { return }
            guard let current = state.narration, state.advancedSpeakSeq != current.seq else { return }
        }
        startNarrationTicker()
    }

    /// `narrationDeadlineSec(item, rate)`: the line's runtime at the speed it
    /// is SPOKEN at (stretched only when slower than 1x) times
    /// `NARRATION_DEADLINE_FACTOR`, plus the margin. Zero (no deadline) for a
    /// line that carries no runtime: a limit derived from nothing would cut
    /// every unmeasured line off at the margin.
    public static func narrationDeadlineSec(_ item: EngineItem?, rate: Double) -> Double {
        guard let runtime = item?.durationSec, runtime.isFinite, runtime > 0 else { return 0 }
        let slow = rate.isFinite && rate > 0 && rate < 1 ? 1 / rate : 1
        return runtime * slow * EngineConstants.QueueManager.narrationDeadlineFactor
            + EngineConstants.QueueManager.narrationDeadlineMarginSec
    }

    /// `_reconcileNarrationInterrupted`: there is no element to ask, so the
    /// SYNTHESISER is asked. Still speaking: nothing is touched. Anything
    /// else (or nobody able to say) is the session taken from under the line:
    /// `interrupted`, the clock frozen by the pause, resumable by one press or
    /// a should-resume, never an advance.
    private mutating func reconcileNarrationInterrupted(_ why: String) {
        if now.narrator == .speaking {
            return diag("reconcile", [JSONMember("kind", .string("skipped-narration-speaking")), JSONMember("why", .string(why))])
        }
        guard state.isPlaying else { return }
        diag("reconcile", [JSONMember("kind", .string("narration-interrupted")), JSONMember("why", .string(why)),
                           JSONMember("tts", .string(now.narrator.rawValue))])
        stopRow(.systemPause)
        state.pausedByListener = false
        cutSeamGap("reconcile")
        dispatch(.interruptionBegan)
        releaseSeamGap()
    }

    // MARK: - The interlude jingle (NE-31s; queue-manager.js §13)

    /// `_armInterlude(from, to)`: at the same instant as the beat and after
    /// it, start the jingle and stretch the deadline to its ceiling, so the
    /// jingle ABSORBS the next segment's load. The rule is interlude.js's
    /// (`Interlude.eligible`); the clock is the beat's.
    private mutating func armInterlude(from: EngineItem?, to: EngineItem?) {
        guard config.forayTapeEnabled, config.interludeAvailable, state.interludeEnabled, let to else { return }
        guard Interlude.eligible(from: from?.forayItem.interlude, to: to.forayItem.interlude) else {
            return diag("interlude", [JSONMember("kind", .string("skipped"))])
        }
        // The audible-start invariant: nothing sounds without the session.
        guard state.session == .active else {
            return diag("fault", [JSONMember("kind", .string("no-session")), JSONMember("at", .string("interlude"))])
        }
        out.append(.interlude(.start))
        state.inInterlude = true
        state.beatUntilMono = state.gapUntilMono
        setGapDeadline(Swift.max(state.gapUntilMono ?? 0, now.monoMs + Interlude.ceilingSec * 1000))
        diag("interlude", [JSONMember("kind", .string("started"))])
    }

    /// `_onInterludeEnded(reason)`: shrink the seam back to the beat's own
    /// deadline. A wait parked on the ceiling finishes now if the beat is
    /// spent, or is re-timed to what the beat still owes (a jingle that failed
    /// at once never shortens the beat); a load not yet landed just holds the
    /// remainder when it does.
    private mutating func onInterlude(_ event: InterludeEvent) {
        switch event {
        case let .ended(reason):
            guard state.inInterlude else {
                return diag("interlude", [JSONMember("kind", .string("stray-end"))])
            }
            state.inInterlude = false
            let beatUntil = state.beatUntilMono
            state.beatUntilMono = nil
            diag("interlude", [JSONMember("kind", .string("ended")),
                               JSONMember("why", .string(DiagGate.isToken(reason) ? reason : "other"))])
            let remaining = beatUntil.map { Swift.max(0, $0 - now.monoMs) } ?? 0
            if state.gapParkedToken != nil && !state.gapCut {
                if state.seamTimerArmed {
                    state.seamTimerArmed = false
                    out.append(.timerCancel(.seamBeat))
                }
                if remaining <= 0 { return finishSeamGap() }
                setGapDeadline(beatUntil)
                state.seamTimerArmed = true
                out.append(.timerArm(.seamBeat, afterMs: remaining, repeating: false))
                return
            }
            if state.gapCut { return } // parked; `releaseSeamGap` owns it
            setGapDeadline(remaining > 0 ? beatUntil : nil)
        }
    }

    /// `_stopInterlude(why)`: silence a sounding jingle without reporting an
    /// end. Idempotent.
    private mutating func stopInterlude(_ why: String) {
        guard state.inInterlude else { return }
        state.inInterlude = false
        state.beatUntilMono = nil
        // The row first (D-5, NE-40), then the command that silences the jingle.
        diag("interlude", [JSONMember("kind", .string("cut")), JSONMember("why", .string(why))])
        out.append(.interlude(.stop))
    }

    // MARK: - The silence node (NE-31s commands; NE-34's node, flagged OFF)

    /// Digital silence across a silent seam, so the process keeps rendering
    /// while the next load happens. Hard-capped at `INTERLUDE_CEILING_SEC`
    /// from the out-point (`Interlude.silenceNodeSec`, which answers 0 when
    /// the transport is not running or the session is not active), after
    /// which only grace covers.
    private mutating func startSilence() {
        guard config.forayTapeEnabled, config.silenceNodeEnabled, !state.silenceActive,
              state.inSeamGap, !state.inInterlude else { return }
        let sec = Interlude.silenceNodeSec(sinceOutPointSec: 0, running: state.isRunning,
                                           sessionActive: state.session == .active)
        guard sec > 0 else { return diag("silence", [JSONMember("kind", .string("refused"))]) }
        state.silenceActive = true
        out.append(.silenceStart(capMs: sec * 1000))
        out.append(.timerArm(.silenceCap, afterMs: sec * 1000, repeating: false))
    }

    private mutating func stopSilence(_ why: String) {
        guard state.silenceActive else { return }
        state.silenceActive = false
        // The row first (D-5, NE-40), then the command that ends the silence.
        diag("silence", [JSONMember("kind", .string("stopped")), JSONMember("why", .string(why))])
        out.append(.timerCancel(.silenceCap))
        out.append(.silenceStop)
    }

    // MARK: - Teardown (the page's `dispose()`)

    /// The engine itself goes away: the line is stopped, the beat's clock and
    /// the jingle are cut, the parked wait is DROPPED (never released: nothing
    /// may start after this), the deck and the jingle player are released,
    /// every timer and grace span ends, and the core answers nothing more.
    /// The reducer's state is left as it was.
    private mutating func teardown() {
        // D-5 (NE-40): the engine going away while it plays is the audio
        // handed back, so the cause is `relinquish`. The app's host never sends
        // `.teardown` (ForayEngine.teardown() tears the host down after the
        // core's own relinquish, which writes this row); the page's `dispose()`
        // in the parity driver does.
        stopRow(.relinquish)
        stopPreview("dispose")
        if state.narration != nil { stopNarration() }
        cutSeamGap("dispose")
        state.gapParkedToken = nil
        state.gapCut = false
        state.pendingLoad = nil
        state.pendingActivation = nil
        deckCommand(.unload)
        if config.forayTapeEnabled && config.interludeAvailable { out.append(.interlude(.release)) }
        if state.positionTimerArmed {
            state.positionTimerArmed = false
            out.append(.timerCancel(.positionTick))
        }
        cancelHoldTimer()
        if state.grace != nil { endGrace(.relinquished) }
        diag("mode", [JSONMember("kind", .string("teardown"))])
        state.tornDown = true
    }

    // MARK: - The voice picker's rendered preview (NE-47; Spark §3.3)

    /// The id a preview load carries: the deck logs it, nothing reads it.
    public static let previewItemId = "audition-preview"

    /// An audition that names a rendered `preview.m4a` loads it on the
    /// PREVIEW deck, a deck of its own: the item a paused Foray holds on the
    /// main deck is never touched, so its resume is exactly what it was. The
    /// session is already active (the tap's own activation, `begin`), and
    /// the play waits for the load's `.ready` like any deck's. A preview in
    /// flight is replaced: the deck's new load supersedes the old one, whose
    /// late answers name a token nobody holds.
    private mutating func loadPreview(url: String, text: String, voiceId: String?) {
        state.lastPreviewToken += 1
        let token = state.lastPreviewToken
        state.preview = AuditionPreview(token: token, text: text, voiceId: voiceId)
        diag("audition", [JSONMember("kind", .string("preview-load")), JSONMember("token", .number(Double(token)))])
        out.append(.preview(.load(token: token, itemId: EngineCore.previewItemId, url: url, startSec: 0,
                                  preciseTiming: false)))
    }

    /// The preview deck's reports. Only the preview in flight is heard; a
    /// report for any other token (a replaced preview, or one already cut)
    /// is dropped.
    private mutating func onPreview(_ event: DeckEvent) {
        guard let preview = state.preview else { return }
        switch event {
        case let .ready(token, _, _, _):
            guard token == preview.token, !preview.playing else { return }
            // Audible: only on the session the audition's tap activated. An
            // interruption since then (a call) took it, and a preview is not
            // worth an activation nobody asked for: it is dropped, silently.
            guard state.session == .active else { return stopPreview("no-session") }
            state.preview?.playing = true
            diag("audition", [JSONMember("kind", .string("preview-play")), JSONMember("token", .number(Double(token)))])
            out.append(.preview(.play))
        case let .failed(token, _, _):
            guard token == preview.token else { return }
            previewFailed(preview, reason: "failed")
        case let .deadlineExceeded(token, _, _):
            guard token == preview.token else { return }
            previewFailed(preview, reason: "timeout")
        case let .ended(token):
            guard token == preview.token else { return }
            state.preview = nil
            diag("audition", [JSONMember("kind", .string("preview-ended")), JSONMember("token", .number(Double(token)))])
        default:
            // Its time control, stalls, duration and the rest describe a
            // few seconds of a voice sample: nothing the engine acts on.
            break
        }
    }

    /// A preview that would not load (a 404, a dead host, its deadline) is
    /// SPOKEN instead: the listener tapped to hear the voice and hears the
    /// line, in the voice the page resolved (the Apple fallback). Only with
    /// the session still active, as every audible command.
    private mutating func previewFailed(_ preview: AuditionPreview, reason: String) {
        state.preview = nil
        let speaks = state.session == .active
        diag("audition", [JSONMember("kind", .string("fallback")), JSONMember("reason", .string(reason)),
                          JSONMember("spoken", .bool(speaks))])
        guard speaks else { return }
        out.append(.speak(text: preview.text, voiceId: preview.voiceId))
    }

    /// Cut the preview in flight, if any: something else is starting, the
    /// player closed, or the engine is going away.
    private mutating func stopPreview(_ why: String) {
        guard let preview = state.preview else { return }
        state.preview = nil
        diag("audition", [JSONMember("kind", .string("preview-stop")), JSONMember("why", .string(why)),
                          JSONMember("token", .number(Double(preview.token)))])
        out.append(.preview(.unload))
    }

    // MARK: cp_foray (client.js `persistForayProgress`)

    /// The Foray's resume row. `force` is the set of moments a resume point
    /// becomes the thing read back next time (a pause, a close, the app
    /// leaving the foreground); otherwise it is the position tick, throttled
    /// to one write per 5 s of Foray clock (`ForayWriteThrottle`). An unknown
    /// playhead (a load in flight or failed) writes NOTHING: an unknown
    /// position must never overwrite a known one. The authored segment id is
    /// the item's `segment_id` when the page put one on it (#40), else null.
    private mutating func persistForay(force: Bool) {
        guard forayTransport, let forayId = state.forayId, let item = state.currentItem,
              state.stateType != "ended", state.loadedId == item.id,
              let elapsed = forayPositionSec(of: item),
              let stamp = Rows.timestamp(epochMs: now.wallMs) else { return }
        let starts = ForayClock.segmentStarts(forayItems)
        let start = starts.indices.contains(state.currentIndex) ? starts[state.currentIndex] : 0
        let input = Rows.ForayProgressInput(
            forayId: forayId, title: state.forayTitle, elapsedSec: elapsed,
            totalSec: ForayClock.forayRuntimeSec(forayItems), index: Double(state.currentIndex),
            segmentId: item.node["segment_id"]?.stringValue, intoSec: Swift.max(0, elapsed - start))
        guard let row = state.forayThrottle.due(input, force: force, updatedAt: stamp) else { return }
        out.append(.writeRow(row))
        state.forayThrottle.recorded(forayId: forayId, elapsedSec: elapsed, ok: true)
    }

    /// Reaching the end MARKS the row finished, once (`markFinished`): a
    /// finished Foray says "Played", never "0 min left".
    private mutating func markForayFinished() {
        guard forayTransport, !state.forayFinishedWritten, let forayId = state.forayId,
              let last = state.queue.last, let stamp = Rows.timestamp(epochMs: now.wallMs) else { return }
        let total = ForayClock.forayRuntimeSec(forayItems)
        let input = Rows.ForayProgressInput(
            forayId: forayId, title: state.forayTitle, elapsedSec: total, totalSec: total,
            index: Double(state.queue.count - 1), segmentId: last.node["segment_id"]?.stringValue,
            intoSec: ForayClock.itemRuntimeSec(last.forayItem))
        guard let row = state.forayThrottle.due(input, force: true, updatedAt: stamp) else { return }
        out.append(.writeRow(row))
        state.forayThrottle.recorded(forayId: forayId, elapsedSec: total, ok: true)
        state.forayFinishedWritten = true
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
