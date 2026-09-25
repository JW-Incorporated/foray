import Foundation
import AVFoundation
import ForayEngineCore
import os

/// One `AVPlayer`, behind the `DeckDriving` seam (card NE-15;
/// docs/native-engine-plan.md §4.3 "AVFoundation choices").
///
/// It speaks the CORE'S deck vocabulary (`DeckCommand` / `DeckEvent` in
/// `ForayEngineCore/Engine/DeckVocabulary.swift`). NE-15 built it in week 1
/// against a stub of those types; NE-15h deleted the stub, moved the seam
/// into `Seams.swift`, and added what the host needs from a deck: its
/// `reading` before every input, `invalidate()` at teardown, and the
/// out-point's first layer.
///
/// The engine plays through two of these (NE-32's DeckPair), at most one
/// audible. This type is the imperative shell for ONE of them: it runs
/// commands against AVFoundation and reports what it observed as `DeckEvent`s.
/// It takes no playback decision of its own; the rulings (the ADR-0007 gate,
/// what an uncommanded pause means, what follows a deadline) are the core's,
/// fixture-pinned in `deck-episode`.
///
/// ── THE LOAD PIPELINE IS GATED ON READINESS (P-1, P-8) ────────────────────
///
///   1. create the item (`preciseTiming` per load) and attach it;
///   2. load the duration (reported; the core gates it and may `.unload`);
///   3. wait for KVO `player.status` AND `item.status` == `.readyToPlay`;
///   4. seek to the start with ZERO tolerance;
///   5. `preroll`, only while `player.rate == 0`;
///   6. emit `.ready`. `play` is refused until then.
///
/// WHY SO STRICT. `preroll` on a player whose status is not `.readyToPlay`
/// raises `NSInvalidArgumentException`, which Swift cannot catch: it is a
/// crash in the car, not an error row. So `preroll(` is called from exactly
/// one function, `prerollWhenReady`, which re-reads both statuses and the
/// rate on the line before, and `shell-invariants.test.mjs` fails on a
/// `preroll(` anywhere else in the plugins or the core.
///
/// "Not ready" (an interrupted seek, or a preroll that finished `false`)
/// retries the seek + preroll once, then falls back to an ORDINARY load: the
/// same zero-tolerance seek with no preroll, reported as `prerolled: false`.
/// An unprimed deck still plays; `automaticallyWaitsToMinimizeStalling`
/// buffers on play. What it must never do is loop on a flaky pipeline while
/// the car waits for sound.
///
/// ── THE OUT-POINT, IN THREE LAYERS (NE-32; plan §4.3 P-2) ─────────────────
///
/// A bounded item (a Foray segment) stops at its out-point, never early, and
/// the first of three layers to see it wins, per load token:
///
///   1. `forwardPlaybackEndTime = end + stopPad` on the item (stopPad 0:
///      NE-25a measured no early stop, docs/ios-native-engine-measurements.md
///      §7.5). AVFoundation stops ON the boundary; its notification is the
///      slowest signal (~30 ms after the boundary observer, measured).
///   2. a boundary time observer at `end`, the FASTEST signal (0.0-0.4 ms
///      past, measured), which can also fail to fire at all when layer 1
///      stopped the player exactly on the boundary first;
///   3. a watchdog: ONE timer until 1.5 s of wall clock before the predicted
///      crossing, then a 250 ms poll inside that window only, re-armed on every
///      seek, rate change and play (DV-11: one wakeup outside the window, not
///      four a second for a whole Foray).
///
/// The decisions are the core's `DeckPolicy.outPointStep`, fixture-pinned by
/// the `outpoint` family; this type only runs the ops it returns and feeds it
/// what it observed. A report before the playhead reached the boundary stops
/// nothing (`outPoint.early:`); a report after the stop is stale; a scrub past
/// the boundary clears layers 1 and 2 and a scrub back re-arms them. The stop
/// writes the `outPoint` row with its overshoot and reports `.ended`, the same
/// event a natural end reports (the core treats them as one end).
///
/// The same watch opens the PREFETCH WINDOW (`.prepareWindow`) with one more
/// one-shot timer, `PREFETCH_LEAD_SEC` of wall clock before the boundary, but
/// only when a DeckPair has a standby deck to prepare (`prepareWindowAvailable`).
///
/// ── ONE THREAD ─────────────────────────────────────────────────────────────
///
/// The engine is main-confined (plan §4.2), so this is too: `send` asserts
/// main, and every KVO, seek, preroll and asset callback hops to main before
/// it reads or writes state. Each hop carries the load `generation` it was
/// issued under, so a callback that outlives its load (a superseded load, a
/// deadline, an unload) returns without effect, and the late `preroll` of a
/// dead item can never mark a new one ready.
final class AVDeck: DeckDriving {

    /// P-13: how long a load may take to reach `.ready` before the deck gives
    /// up, detaches the item, and reports `.deadlineExceeded`. PROVISIONAL.
    static let defaultLoadDeadlineSec: Double = 20 // MEASURE: NE-38 sets it from the field's time-to-ready rows (OQ-4, DV-5).

    /// A pause reported this close to the item's end is the end, not an
    /// uncommanded stop: with `actionAtItemEnd = .pause` the rate drops to 0
    /// at the end, and that KVO can land before `didPlayToEndTime` does.
    static let endSlackSec: Double = 0.5

    /// How long a stopped-while-intending-to-play observation must hold
    /// before it is reported (see `checkUncommandedPause`). Well inside the
    /// core's 500 ms route-attribution window (plan §4.3).
    static let pauseSettleSec: Double = 0.25

    /// Bound on `primitives`, the test-visible log of AVPlayer calls.
    private static let primitiveCap = 256

    /// NE-32's pad on layer 1 (`forwardPlaybackEndTime = end + stopPad`).
    /// NE-25a measured no early stop in 128 trials at 1x and 2x with a pad of
    /// 0, so the pad stays 0 (docs/ios-native-engine-measurements.md §7.5).
    static let defaultStopPadSec: Double = 0

    /// How far below the boundary a LAYER's report may read and still be the
    /// boundary: `CMTime` at a 1 µs timescale can read a hair under the second
    /// it was set to. NE-25a's never-early assertion used the same 1 ms.
    static let layerSlackSec: Double = 0.001

    /// The one-shot timers the out-point uses (the watchdog, the prefetch
    /// window): `DispatchSourceTimer`s on main with a small leeway, because the
    /// watchdog's poll IS its overshoot.
    private static let outPointTiming = MainQueueTiming(leeway: .milliseconds(1))

    /// Which timer a `Config.schedule` call is for (the tests count them).
    enum TimerPurpose: String {
        case watchdog
        case prepareWindow = "prepare-window"
    }

    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "ai.jwlabs.foura",
        category: "ForayEngine.AVDeck"
    )

    struct Config {
        var loadDeadlineSec: Double
        /// `AudioSessionOwner.phase == .active` (NE-16), read through a
        /// closure because the owner does not exist yet and because the deck
        /// must not own a session reference of its own (one owner, §4.4).
        var sessionIsActive: () -> Bool
        /// Where a diagnostics row goes (NE-19's ring, later). Default: os.Logger.
        var writeRow: (String) -> Void
        /// DEBUG's hard stop for a broken invariant. Injectable so an XCTest
        /// can prove the fault fires without crashing the test process.
        var debugFault: (String) -> Void
        /// Makes the asset for a load. Injectable so a test can hand the deck
        /// an asset whose loader never answers (the deadline test), and so a
        /// DeckPair's two decks share one `AssetCache`.
        var makeAsset: (URL, Bool) -> AVURLAsset
        /// Whether a detach cancels the asset's pending loads. True for an
        /// asset this deck owns alone; FALSE for a shared one (`AssetCache`),
        /// where `cancelLoading()` would also cancel the other deck's load.
        var cancelsAssetLoading: Bool
        /// NE-32: the ring's structured rows (the `outPoint` row). Default: none.
        var diag: (DiagEntry) -> Void
        /// NE-32: layer 1's pad (`defaultStopPadSec`).
        var stopPadSec: Double
        /// NE-32: a one-shot timer on main, `ms` of wall clock from now.
        /// Injectable so a test can count the watchdog's wakeups.
        var schedule: (TimerPurpose, Double, @escaping () -> Void) -> EngineObservation
        /// NE-32: the monotonic clock the out-point watch reads, in ms.
        var nowMs: () -> Double
        /// NE-32: which out-point layers run. All three in production; a
        /// Simulator test arms one alone to prove it stops never-early.
        var outPointLayers: Set<DeckPolicy.OutPointLayer>

        init(
            loadDeadlineSec: Double = AVDeck.defaultLoadDeadlineSec,
            sessionIsActive: @escaping () -> Bool,
            writeRow: @escaping (String) -> Void = AVDeck.logRow,
            debugFault: @escaping (String) -> Void = { assertionFailure($0) },
            makeAsset: @escaping (URL, Bool) -> AVURLAsset = AVDeck.defaultAsset,
            cancelsAssetLoading: Bool = true,
            diag: @escaping (DiagEntry) -> Void = { _ in },
            stopPadSec: Double = AVDeck.defaultStopPadSec,
            schedule: @escaping (TimerPurpose, Double, @escaping () -> Void) -> EngineObservation = AVDeck.mainQueueTimer,
            nowMs: @escaping () -> Double = AVDeck.uptimeMs,
            outPointLayers: Set<DeckPolicy.OutPointLayer> = Set(DeckPolicy.OutPointLayer.allCases)
        ) {
            self.loadDeadlineSec = loadDeadlineSec
            self.sessionIsActive = sessionIsActive
            self.writeRow = writeRow
            self.debugFault = debugFault
            self.makeAsset = makeAsset
            self.cancelsAssetLoading = cancelsAssetLoading
            self.diag = diag
            self.stopPadSec = stopPadSec
            self.schedule = schedule
            self.nowMs = nowMs
            self.outPointLayers = outPointLayers
        }
    }

    static func logRow(_ row: String) {
        logger.notice("\(row, privacy: .public)")
    }

    static func mainQueueTimer(_ purpose: TimerPurpose, _ ms: Double, _ fire: @escaping () -> Void) -> EngineObservation {
        outPointTiming.schedule(afterMs: ms, repeating: false, fire: fire)
    }

    static func uptimeMs() -> Double {
        Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000
    }

    /// P-7: precise timing is chosen per load by the core (provisional:
    /// precise for bounded segments and local files, approximate for
    /// unbounded episodes; NE-25a measures both).
    static func defaultAsset(_ url: URL, _ preciseTiming: Bool) -> AVURLAsset {
        AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: preciseTiming])
    }

    var onEvent: ((DeckEvent) -> Void)?

    /// Internal, not private: the Simulator tests read the real player's
    /// rate, and pause it behind the deck's back to stand in for the system.
    let player: AVPlayer

    /// Every AVPlayer call that can move the audible state, in order. The
    /// XCTests assert on it ("no preroll was issued", "no play before
    /// ready"); it is bounded, and it is not a diagnostics row.
    private(set) var primitives: [String] = []

    private enum Stage: Equatable {
        case idle
        /// Attached; waiting for the duration and both statuses.
        case loading
        /// Seeking and prerolling (steps 4-5).
        case gating
        case ready
        case failed
    }

    private let config: Config
    private var stage: Stage = .idle
    private var token: DeckToken?
    private var generation = 0
    private var asset: AVURLAsset?
    private var item: AVPlayerItem?
    private var targetStartSec: Double = 0
    private var gateAttempts = 0
    private var durationKnown = false
    private var loadStartedAt = DispatchTime.now()
    private var deadline: DispatchWorkItem?
    private var playerObservations: [NSKeyValueObservation] = []
    private var itemObservations: [NSKeyValueObservation] = []
    private var itemNotifications: [NSObjectProtocol] = []
    /// The listener's rate. The deck holds it across loads because AVPlayer
    /// does not: every play re-applies it (plan §4.3).
    private var rate: Float = 1
    /// True from a commanded play until a commanded pause, the end, or an
    /// observed stop. It is what makes a rate-0 observation "uncommanded".
    private var intendsToPlay = false
    private var reachedEnd = false
    private var lastTimeControl: DeckTimeControl?
    private var lastWaitingReason: String?
    /// Bumped by every commanded play; a pause suspicion armed under an
    /// older value is void (see `checkUncommandedPause`).
    private var playSeq = 0
    private var pauseSuspicion: DispatchWorkItem?
    /// Set once by `invalidate()`; the deck is inert from then on.
    private var invalidated = false
    /// The source this deck holds (the load's `url` string), for the pair's
    /// "same episode" check.
    private(set) var loadedURL: String?

    /// NE-32: the out-point watch (`DeckPolicy.outPointStep`'s state), the
    /// boundary observer (layer 2), the watchdog's one timer (layer 3), and
    /// the prefetch window's one timer.
    private var watch = DeckPolicy.OutPointWatch()
    private var boundaryObserver: Any?
    private var watchdog: EngineObservation?
    private var windowTimer: EngineObservation?
    private var windowOpened = false
    /// Set by a DeckPair on the deck that holds the player role: there is a
    /// standby deck, so the prefetch window means something. A lone deck
    /// never opens it (the core then never prepares).
    var prepareWindowAvailable = false {
        didSet { if prepareWindowAvailable != oldValue { rearmPrepareWindow() } }
    }

    /// The attached item's duration, when AVFoundation knows a finite one.
    private var itemDurationSec: Double? {
        guard let duration = item?.duration, duration.isNumeric, duration.seconds.isFinite else { return nil }
        return duration.seconds
    }

    init(config: Config) {
        self.config = config
        player = AVPlayer()
        // Plan §4.3's deck settings. `.pause` at the item's end, because the
        // core, not AVPlayer, decides what plays next (an auto-advance is a
        // continuation hop); stall-waiting on, because a play on a thin
        // network should wait rather than start and starve.
        player.actionAtItemEnd = .pause
        player.automaticallyWaitsToMinimizeStalling = true
        observePlayer()
    }

    deinit {
        deadline?.cancel()
        pauseSuspicion?.cancel()
        watchdog?.cancel()
        windowTimer?.cancel()
        if let boundaryObserver { player.removeTimeObserver(boundaryObserver) }
        playerObservations.forEach { $0.invalidate() }
        itemObservations.forEach { $0.invalidate() }
        itemNotifications.forEach { NotificationCenter.default.removeObserver($0) }
        if config.cancelsAssetLoading { asset?.cancelLoading() }
    }

    func send(_ command: DeckCommand) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !invalidated else { return }
        switch command {
        case let .load(token, _, url, startSec, preciseTiming):
            load(token: token, url: url, startSec: startSec, preciseTiming: preciseTiming)
        case .play:
            play()
        case .pause:
            pause()
        case let .seek(toSec):
            seek(to: toSec)
        case let .setRate(newRate):
            setRate(Float(newRate))
        case let .setOutPoint(sec):
            setOutPoint(sec)
        case .unload:
            unload()
        case .prepare:
            // One deck has no standby to warm: the DeckPair (NE-32, behind
            // `deckPairEnabled`) answers it and never forwards it. A lone deck
            // never opens the prefetch window, so the core never asks; if it
            // does, the seam loads cold inside the beat.
            break
        }
    }

    /// The load stage the pair reads at a boundary (readiness is re-asserted
    /// there, never trusted: `DeckPolicy.warmPromotion`'s `canPlay`).
    var isReady: Bool { stage == .ready }

    /// The handover's `adopt-identity` step (NE-32): the standby deck's load
    /// becomes the core's load `token`, so every later event carries the
    /// token the core is waiting on. Nothing else about the load changes.
    func adopt(token newToken: DeckToken) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !invalidated, token != nil else { return }
        token = newToken
        watch.token = newToken
    }

    /// The host reads this before every input (`EngineNow.deck`), because the
    /// core decides from what the deck says NOW, the way the JS asks its
    /// element (`DeckReading`).
    ///
    /// While a load is still gating, the playhead reads as the START it will
    /// land on, not `currentTime()`: a freshly attached item reads 0 until
    /// the zero-tolerance seek lands, and an input handled in that window
    /// (a pause, a restore write) would otherwise save 0 over the listener's
    /// place. That is also exactly how the core's own view of a turn treats a
    /// `.load` it just issued.
    var reading: DeckReading {
        switch stage {
        case .idle, .failed:
            return DeckReading(positionSec: nil, durationSec: nil, audible: false, ended: false)
        case .loading, .gating:
            return DeckReading(positionSec: targetStartSec, durationSec: itemDurationSec,
                               audible: player.rate != 0, ended: false)
        case .ready:
            let at = player.currentTime().seconds
            return DeckReading(positionSec: at.isFinite ? at : targetStartSec, durationSec: itemDurationSec,
                               audible: player.rate != 0, ended: reachedEnd)
        }
    }

    /// Teardown (plan §4.6 relinquish, step 5): silence, drop the item and
    /// every item observer, invalidate the player's own KVO, and never report
    /// again. Every later command is ignored.
    func invalidate() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !invalidated else { return }
        unload()
        invalidated = true
        onEvent = nil
        removeBoundaryObserver()
        playerObservations.forEach { $0.invalidate() }
        playerObservations = []
    }

    /// True while a player-level KVO is registered (the Simulator test of
    /// `invalidate()` reads it; nothing else does).
    var isObservingPlayer: Bool { !playerObservations.isEmpty }

    // MARK: - Load (steps 1-2)

    private func load(token newToken: DeckToken, url urlString: String?, startSec: Double, preciseTiming: Bool) {
        // Whatever was sounding stops BEFORE the new item attaches. A
        // `replaceCurrentItem` on a playing player keeps the rate, so the new
        // item would start by itself the moment it buffered: audible before
        // the gate, at the wrong offset, and with no preroll.
        intendsToPlay = false
        if player.rate != 0 {
            record("pause (load)")
            player.pause()
        }
        resetOutPoint()
        detachItem()
        generation += 1
        token = newToken
        loadedURL = urlString
        stage = .loading
        targetStartSec = max(0, startSec)
        gateAttempts = 0
        durationKnown = false
        reachedEnd = false
        lastTimeControl = nil
        lastWaitingReason = nil
        loadStartedAt = .now()
        // The core hands the page's `audio_url` through as it is (nil for an
        // item with no audio of its own). Anything that is not an absolute
        // URL fails THIS load, under its token, so the core's failure path
        // runs; it is never an exception in the car.
        guard let url = urlString.flatMap({ URL(string: $0) }), url.scheme != nil else {
            stage = .failed
            record("no-url")
            emit(.failed(token: newToken, message: "no-url"))
            return
        }

        let asset = config.makeAsset(url, preciseTiming)
        let item = AVPlayerItem(asset: asset)
        // Plan §4.3: time-domain stretching is the speech-quality algorithm
        // at 1.25-2x; the default (`.spectral` on iOS 15+) smears voices.
        item.audioTimePitchAlgorithm = .timeDomain
        self.asset = asset
        self.item = item
        observe(item: item, generation: generation)
        armDeadline(generation: generation)
        record("attach")
        player.replaceCurrentItem(with: item)
        loadDuration(of: asset, generation: generation)
    }

    private func loadDuration(of asset: AVURLAsset, generation gen: Int) {
        asset.loadValuesAsynchronously(forKeys: ["duration"]) { [weak self] in
            DispatchQueue.main.async { self?.durationLoaded(asset: asset, generation: gen) }
        }
    }

    private func durationLoaded(asset: AVURLAsset, generation gen: Int) {
        guard gen == generation, let token else { return }
        var error: NSError?
        switch asset.statusOfValue(forKey: "duration", error: &error) {
        case .loaded:
            durationKnown = true
            let duration = asset.duration
            let seconds: Double? = duration.isNumeric && duration.seconds.isFinite ? duration.seconds : nil
            emit(.durationLoaded(token: token, durationSec: seconds))
            advanceIfReady()
        case .failed:
            fail(generation: gen, message: "duration: \(error?.localizedDescription ?? "unknown")")
        default:
            // Cancelled by a newer load or the deadline; that path reported.
            break
        }
    }

    // MARK: - The gate (steps 3-6)

    /// Step 3. Runs on every observation that could complete readiness, and
    /// moves on only when the duration AND both statuses say so.
    private func advanceIfReady() {
        guard stage == .loading, durationKnown, let item,
              player.status == .readyToPlay, item.status == .readyToPlay else { return }
        stage = .gating
        gateSeek()
    }

    /// Step 4: zero tolerance, because the start offset IS the resume point
    /// (an episode's saved position; later a Foray segment's in-point), and a
    /// tolerant seek lands on the nearest sync point, seconds away on some
    /// encodings.
    private func gateSeek() {
        let gen = generation
        let target = targetStartSec
        record("seek \(Self.format(target))")
        player.seek(to: Self.time(target), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] finished in
            DispatchQueue.main.async {
                self?.gateSeekCompleted(finished: finished, target: target, generation: gen)
            }
        }
    }

    private func gateSeekCompleted(finished: Bool, target: Double, generation gen: Int) {
        guard gen == generation, stage == .gating else { return }
        // The core moved the start while the seek ran (a `.seek` before
        // `.ready` only moves the target, it issues nothing): seek again.
        // That is not a failure, so it does not spend the retry.
        if target != targetStartSec {
            gateSeek()
            return
        }
        guard finished else {
            notReady(cause: "seek-interrupted")
            return
        }
        prerollWhenReady()
    }

    /// Step 5, and THE ONLY CALLER OF `preroll(` in the plugins and the core
    /// (pinned by `shell-invariants.test.mjs`). Both statuses and the rate are
    /// re-read here, on the line before the call, rather than trusted from
    /// `advanceIfReady`: an item can fail between the seek and this line, and
    /// a preroll on a non-ready player is an uncatchable exception.
    ///
    /// It primes at the rate the deck will play at. The plan's "preroll at
    /// rate 0" is the PLAYER's state (§4.3: "only while rate == 0"); the
    /// argument is the rate the pipeline should be primed for.
    private func prerollWhenReady() {
        guard stage == .gating, let item,
              player.status == .readyToPlay, item.status == .readyToPlay else {
            notReady(cause: "not-ready-to-play")
            return
        }
        guard player.rate == 0 else {
            // Something is sounding on this player; priming it is not
            // allowed and not needed. Ready, unprimed.
            becomeReady(prerolled: false)
            return
        }
        let gen = generation
        let target = targetStartSec
        record("preroll player=\(player.status.rawValue) item=\(item.status.rawValue) rate=\(player.rate)")
        player.preroll(atRate: rate) { [weak self] finished in
            DispatchQueue.main.async {
                self?.prerollCompleted(finished: finished, target: target, generation: gen)
            }
        }
    }

    private func prerollCompleted(finished: Bool, target: Double, generation gen: Int) {
        guard gen == generation, stage == .gating else { return }
        if target != targetStartSec {
            gateSeek()
            return
        }
        guard finished else {
            notReady(cause: "preroll-unfinished")
            return
        }
        becomeReady(prerolled: true)
    }

    /// "Not ready": retry the seek + preroll once, then an ordinary load.
    private func notReady(cause: String) {
        guard let token else { return }
        let gen = generation
        gateAttempts += 1
        emit(.notReady(token: token, attempt: gateAttempts, cause: cause))
        guard gen == generation, stage == .gating else { return }
        if gateAttempts < 2 {
            gateSeek()
        } else {
            ordinaryLoad()
        }
    }

    /// The fallback after a second "not ready": land the start with the same
    /// zero-tolerance seek, skip the preroll, and report ready unprimed.
    private func ordinaryLoad() {
        let gen = generation
        let target = targetStartSec
        record("seek \(Self.format(target)) ordinary")
        player.seek(to: Self.time(target), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, gen == self.generation, self.stage == .gating else { return }
                self.becomeReady(prerolled: false)
            }
        }
    }

    private func becomeReady(prerolled: Bool) {
        guard let token else { return }
        deadline?.cancel()
        deadline = nil
        stage = .ready
        emit(.ready(
            token: token,
            landedSec: player.currentTime().seconds,
            prerolled: prerolled,
            elapsedMs: Self.msSince(loadStartedAt)
        ))
    }

    // MARK: - Deadline (P-13)

    private func armDeadline(generation gen: Int) {
        let work = DispatchWorkItem { [weak self] in self?.deadlineFired(generation: gen) }
        deadline = work
        DispatchQueue.main.asyncAfter(deadline: .now() + config.loadDeadlineSec, execute: work)
    }

    private func deadlineFired(generation gen: Int) {
        guard gen == generation, stage == .loading || stage == .gating, let token else { return }
        let afterMs = Self.msSince(loadStartedAt)
        // Detach FIRST, and move the generation, so nothing that completes
        // late (a duration, a status, a seek) can preroll or sound: a URL that
        // turns ready at 21 s must not start the wrong thing in the car.
        detachItem()
        generation += 1
        stage = .failed
        record("detach (deadline)")
        player.replaceCurrentItem(with: nil)
        emit(.deadlineExceeded(token: token, afterMs: afterMs))
    }

    // MARK: - Transport

    private func play() {
        guard stage == .ready, let token else {
            // Plan §4.3: `deckPlay` is legal only after `ready`. A play before
            // it would start an unseeked, unprimed item: audio at the wrong
            // offset, the exact bug the gate exists to prevent.
            emit(.refused(command: "play", reason: stage == .failed ? "failed" : "not-ready"))
            return
        }
        // Plan §4.4: `AVPlayer.play()` ACTIVATES AN INACTIVE SESSION
        // IMPLICITLY. The core's audible-start invariant means this should
        // never be reached without an active session; if it is, the row says
        // so and DEBUG stops. Release still plays: refusing would be silence
        // in the car, and the row is what finds the core's bug.
        if !config.sessionIsActive() {
            let row = "fault implicit-activation deck token=\(token)"
            config.writeRow(row)
            config.debugFault(row)
        }
        intendsToPlay = true
        reachedEnd = false
        // Voids any pause suspicion armed before this play (see
        // `checkUncommandedPause`): that stop is superseded by the command.
        playSeq += 1
        pauseSuspicion?.cancel()
        pauseSuspicion = nil
        applyRateAndPlay()
        step(.play(atSec: playheadSec, nowMs: config.nowMs()))
    }

    /// The only place this type starts audio. The rate is re-applied on EVERY
    /// play (plan §4.3), because AVPlayer resets it: `play()` uses 1.0 on
    /// iOS 15, and a replaced item or an interruption drops `rate` to 0.
    private func applyRateAndPlay() {
        if #available(iOS 16.0, *) {
            player.defaultRate = rate
            record("play defaultRate=\(rate)")
            player.play()
        } else {
            record("play rate=\(rate)")
            player.rate = rate
        }
    }

    private func pause() {
        intendsToPlay = false
        record("pause")
        player.pause()
        step(.pause(atSec: playheadSec))
    }

    private func setRate(_ newRate: Float) {
        guard newRate > 0, newRate.isFinite else {
            emit(.refused(command: "setRate", reason: "non-positive"))
            return
        }
        rate = newRate
        if #available(iOS 16.0, *) {
            player.defaultRate = newRate
        }
        if intendsToPlay, player.rate != 0 {
            record("rate=\(newRate)")
            player.rate = newRate
        }
        // Re-armed on every rate change: the watchdog's delay is WALL clock.
        step(.rate(Double(newRate), atSec: playheadSec, nowMs: config.nowMs()))
    }

    /// The out-point (plan §4.3 P-2, NE-32): hand the boundary to the watch,
    /// which arms layers 1 and 2 when the playhead is before it and the
    /// watchdog once the deck plays. nil (or junk) disarms. An episode (M1)
    /// never sets one. A load drops it, as the core's vocabulary says.
    private func setOutPoint(_ sec: Double?) {
        guard item != nil, let token else { return }
        let end = sec.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
        windowOpened = false
        step(.load(token: token, outPointSec: end, atSec: playheadSec))
        if intendsToPlay, player.rate != 0 {
            step(.play(atSec: playheadSec, nowMs: config.nowMs()))
        }
    }

    private func seek(to sec: Double) {
        let target = max(0, sec)
        switch stage {
        case .loading, .gating:
            // Before `.ready`, a seek moves the start: the gate lands there.
            targetStartSec = target
        case .ready:
            guard let token else { return }
            reachedEnd = false
            let gen = generation
            record("seek \(Self.format(target))")
            // The watch moves with the seek NOW (a scrub past the boundary
            // clears layers 1 and 2 before the player gets there), and again
            // from where it really landed.
            step(.seek(atSec: target, nowMs: config.nowMs()))
            player.seek(to: Self.time(target), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] finished in
                DispatchQueue.main.async {
                    guard let self, gen == self.generation else { return }
                    let landed = self.player.currentTime().seconds
                    if landed.isFinite { self.step(.seek(atSec: landed, nowMs: self.config.nowMs())) }
                    self.emit(.seeked(token: token, landedSec: landed, finished: finished))
                }
            }
        case .idle, .failed:
            emit(.refused(command: "seek", reason: "not-loaded"))
        }
    }

    private func unload() {
        intendsToPlay = false
        if player.rate != 0 {
            record("pause (unload)")
            player.pause()
        }
        resetOutPoint()
        detachItem()
        generation += 1
        token = nil
        loadedURL = nil
        stage = .idle
        if player.currentItem != nil {
            record("detach")
            player.replaceCurrentItem(with: nil)
        }
    }

    // MARK: - Observation (KVO and notifications -> DeckEvent)

    private func observePlayer() {
        playerObservations = [
            player.observe(\.status, options: [.new]) { [weak self] _, _ in
                DispatchQueue.main.async { self?.playerStatusChanged() }
            },
            player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
                DispatchQueue.main.async { self?.timeControlChanged() }
            },
            player.observe(\.reasonForWaitingToPlay, options: [.new]) { [weak self] _, _ in
                DispatchQueue.main.async { self?.timeControlChanged() }
            },
            player.observe(\.rate, options: [.new]) { [weak self] _, _ in
                DispatchQueue.main.async { self?.checkUncommandedPause() }
            }
        ]
    }

    private func observe(item: AVPlayerItem, generation gen: Int) {
        itemObservations = [
            item.observe(\.status, options: [.initial, .new]) { [weak self] _, _ in
                DispatchQueue.main.async { self?.itemStatusChanged(generation: gen) }
            }
        ]
        let center = NotificationCenter.default
        itemNotifications = [
            center.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main) { [weak self] _ in
                self?.itemEnded(generation: gen)
            },
            center.addObserver(forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: item, queue: .main) { [weak self] note in
                let error = note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
                self?.fail(generation: gen, message: "failed-to-end: \(error?.localizedDescription ?? "unknown")")
            },
            center.addObserver(forName: AVPlayerItem.playbackStalledNotification, object: item, queue: .main) { [weak self] _ in
                self?.itemStalled(generation: gen)
            }
        ]
    }

    private func detachItem() {
        deadline?.cancel()
        deadline = nil
        pauseSuspicion?.cancel()
        pauseSuspicion = nil
        itemObservations.forEach { $0.invalidate() }
        itemObservations = []
        itemNotifications.forEach { NotificationCenter.default.removeObserver($0) }
        itemNotifications = []
        if config.cancelsAssetLoading { asset?.cancelLoading() }
        asset = nil
        item = nil
    }

    private func playerStatusChanged() {
        if player.status == .failed {
            fail(generation: generation, message: "player: \(player.error?.localizedDescription ?? "unknown")")
            return
        }
        advanceIfReady()
    }

    private func itemStatusChanged(generation gen: Int) {
        guard gen == generation, let item else { return }
        switch item.status {
        case .readyToPlay:
            advanceIfReady()
        case .failed:
            fail(generation: gen, message: "item: \(item.error?.localizedDescription ?? "unknown")")
        default:
            break
        }
    }

    /// P-14: `waitingToPlayAtSpecifiedRate` is the core's `buffering: true`;
    /// the waiting reason rides along for the stall rows NE-38 reads.
    private func timeControlChanged() {
        guard let token else { return }
        let status: DeckTimeControl
        switch player.timeControlStatus {
        case .playing: status = .playing
        case .waitingToPlayAtSpecifiedRate: status = .waiting
        default: status = .paused
        }
        let reason = status == .waiting ? player.reasonForWaitingToPlay?.rawValue : nil
        if status != lastTimeControl || reason != lastWaitingReason {
            lastTimeControl = status
            lastWaitingReason = reason
            emit(.timeControl(token: token, status: status, waitingReason: reason))
        }
        checkUncommandedPause()
    }

    /// Plan §4.3 "observe, don't believe" (Q-9). A stopped player while the
    /// deck intends to play, not at the end, is reported ONCE as the
    /// reconcile input; the core attributes it (route, interruption, or
    /// system pause).
    ///
    /// IT IS A SUSPICION FIRST, CONFIRMED `pauseSettleSec` LATER, and a play
    /// command in between cancels it. MEASURED on the Simulator (ios-kit run
    /// 35962750658, `testAnExternalPauseBecomesAReconcileInput`): a play sent
    /// 13 ms after an external pause was followed by an observation of
    /// `rate == 0` AFTER the play, and then `.playing`. Reported at once, that
    /// was a second, false "uncommanded pause" while audio was starting, and
    /// it cleared `intendsToPlay`, so the NEXT real system pause would have
    /// gone unreported. The player's state right after a command is not yet
    /// the truth; a quarter second later it is.
    private func checkUncommandedPause() {
        guard pauseSuspicion == nil, looksUncommandedPaused() else { return }
        let gen = generation
        let seq = playSeq
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.pauseSuspicion = nil
            guard gen == self.generation, seq == self.playSeq, self.looksUncommandedPaused(), let token = self.token
            else { return }
            self.intendsToPlay = false
            self.step(.pause(atSec: self.playheadSec))
            self.emit(.pausedUncommanded(token: token, atSec: self.player.currentTime().seconds))
        }
        pauseSuspicion = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.pauseSettleSec, execute: work)
    }

    private func looksUncommandedPaused() -> Bool {
        guard let item else { return false }
        let duration = item.duration
        return Self.isUncommandedPause(
            intendsToPlay: intendsToPlay,
            reachedEnd: reachedEnd,
            ready: stage == .ready,
            rate: player.rate,
            timeControlPaused: player.timeControlStatus == .paused,
            atSec: player.currentTime().seconds,
            durationSec: duration.isNumeric ? duration.seconds : nil
        )
    }

    /// The rule, as a pure function so an XCTest can pin every branch
    /// without racing AVFoundation (the order in which the end's rate drop,
    /// `.paused` and `didPlayToEndTime` arrive differs run to run: mutation
    /// runs 35963951987 and 35965798877 saw both orders). It moves to the
    /// core's DeckPolicy with NE-14s. A stop counts only when the deck meant
    /// to play, the load is ready, the player is really stopped (rate 0 AND
    /// `.paused`; `.waiting` is buffering), and it is not the end: with
    /// `actionAtItemEnd = .pause` the rate drops to 0 there too, and
    /// `didPlayToEndTime` reports that.
    static func isUncommandedPause(
        intendsToPlay: Bool, reachedEnd: Bool, ready: Bool,
        rate: Float, timeControlPaused: Bool,
        atSec: Double, durationSec: Double?
    ) -> Bool {
        guard intendsToPlay, !reachedEnd, ready, rate == 0, timeControlPaused else { return false }
        if let durationSec, atSec >= durationSec - endSlackSec {
            return false
        }
        return true
    }

    /// `didPlayToEndTime`: either layer 1 (the item reached
    /// `forwardPlaybackEndTime`) or the file ran out. With no out-point it is
    /// the natural end, as in M1. With one, the watch decides: the boundary
    /// reached first by layer 1 is a stop; after a stop by another layer it is
    /// stale (NO second `.ended`: NE-25a measured this notification ~30 ms
    /// after the boundary observer); a file that ran out BEFORE the boundary
    /// (an authored `end_sec` past the real audio) is the item's one, natural,
    /// end.
    private func itemEnded(generation gen: Int) {
        guard gen == generation, let token else { return }
        let at = playheadSec
        guard let out = watch.outPointSec, watch.token == token else {
            finishAtEnd(token)
            return
        }
        // Another layer already stopped this item (and no seek moved it since):
        // this is layer 1's late notification of the same end.
        if watch.fired && reachedEnd { return }
        if watch.armed && at >= out - Self.layerSlackSec {
            step(.layer(.endTime, token: token, atSec: Swift.max(at, out), nowMs: config.nowMs()))
            return
        }
        // Not a boundary stop: a scrub past the boundary freed the item, or the
        // player stopped before it anyway (the file ran out, or, never
        // measured, an early end time). The item has ended; waiting for a
        // boundary the player will not reach would stall the Foray, so it is
        // the natural end, and an early one is written down.
        if watch.armed, let duration = itemDurationSec, at < duration - Self.endSlackSec {
            config.diag(DiagEntry(kind: "outPoint", fields: [
                JSONMember("kind", .string("early")),
                JSONMember("layer", .string(DeckPolicy.OutPointLayer.endTime.rawValue)),
                JSONMember("token", .number(Double(token)))]))
            config.writeRow("outPoint early layer=endTime token=\(token) at=\(Self.format(at)) out=\(Self.format(out))")
        }
        step(.ended(atSec: at))
    }

    private func finishAtEnd(_ token: DeckToken) {
        reachedEnd = true
        intendsToPlay = false
        emit(.ended(token: token))
    }

    private func itemStalled(generation gen: Int) {
        guard gen == generation, let token else { return }
        emit(.stalled(token: token))
    }

    private func fail(generation gen: Int, message: String) {
        guard gen == generation, stage != .failed, let token else { return }
        deadline?.cancel()
        deadline = nil
        stage = .failed
        intendsToPlay = false
        emit(.failed(token: token, message: message))
    }

    // MARK: - The out-point (NE-32)

    /// The playhead the watch reads: the player's, or the start a gating load
    /// will land on (the same rule as `reading`).
    private var playheadSec: Double {
        guard stage == .ready else { return targetStartSec }
        let at = player.currentTime().seconds
        return at.isFinite ? at : targetStartSec
    }

    /// Feed the watch one event and run the ops it answers, in order.
    private func step(_ event: DeckPolicy.OutPointEvent) {
        let (next, ops) = DeckPolicy.outPointStep(watch, event)
        watch = next
        for op in ops { apply(op) }
        rearmPrepareWindow()
    }

    private func apply(_ op: DeckPolicy.OutPointOp) {
        switch op {
        case let .endTime(sec):
            // Layer 1 lives on the ITEM; a disarm is `.invalid`.
            let armed = config.outPointLayers.contains(.endTime) ? sec : nil
            item?.forwardPlaybackEndTime = armed.map { Self.time($0 + config.stopPadSec) } ?? .invalid
        case let .boundary(sec):
            removeBoundaryObserver()
            guard let sec, config.outPointLayers.contains(.boundary) else { return }
            let gen = generation
            let token = watch.token
            boundaryObserver = player.addBoundaryTimeObserver(forTimes: [NSValue(time: Self.time(sec))], queue: .main) { [weak self] in
                self?.layerFired(.boundary, token: token, generation: gen)
            }
        case let .watchdogArm(ms):
            watchdog?.cancel()
            watchdog = nil
            guard config.outPointLayers.contains(.watchdog) else { return }
            let gen = generation
            watchdog = config.schedule(.watchdog, ms) { [weak self] in self?.watchdogFired(generation: gen) }
        case .watchdogCancel:
            watchdog?.cancel()
            watchdog = nil
        case let .stop(layer, overshootMs):
            outPointStop(layer, overshootMs: overshootMs)
        case let .early(layer):
            config.diag(DiagEntry(kind: "outPoint", fields: [
                JSONMember("kind", .string("early")), JSONMember("layer", .string(layer.rawValue)),
                JSONMember("token", .number(Double(watch.token)))]))
            config.writeRow("outPoint early layer=\(layer.rawValue) token=\(watch.token)")
        case .stale:
            break
        case .endedNatural:
            if let token { finishAtEnd(token) }
        }
    }

    /// Layer 2's callback. A boundary observer can fire a hair under the time
    /// it was set to (CMTime rounding), so within `layerSlackSec` it reads as
    /// the boundary itself; anything earlier is an early report.
    private func layerFired(_ layer: DeckPolicy.OutPointLayer, token: DeckToken, generation gen: Int) {
        guard gen == generation, !invalidated else { return }
        var at = playheadSec
        if let out = watch.outPointSec, at < out, at >= out - Self.layerSlackSec { at = out }
        step(.layer(layer, token: token, atSec: at, nowMs: config.nowMs()))
    }

    /// Layer 3's one timer came due. The watch ignores a wake before its due
    /// time, which a timer that fired a hair early (clock rounding) would be,
    /// and would then never re-arm; so the wake is stamped no earlier than due.
    private func watchdogFired(generation gen: Int) {
        guard gen == generation, !invalidated else { return }
        watchdog = nil
        let now = Swift.max(config.nowMs(), watch.timerDueMs ?? 0)
        step(.timer(atSec: playheadSec, nowMs: now))
    }

    /// A layer reached the boundary first: stop (layer 1 already stopped the
    /// player itself), write the `outPoint` row with the overshoot, and report
    /// the item's end.
    private func outPointStop(_ layer: DeckPolicy.OutPointLayer, overshootMs: Double) {
        guard let token else { return }
        intendsToPlay = false
        reachedEnd = true
        pauseSuspicion?.cancel()
        pauseSuspicion = nil
        if player.rate != 0 {
            record("pause (out-point \(layer.rawValue))")
            player.pause()
        }
        config.diag(DiagEntry(kind: "outPoint", fields: [
            JSONMember("kind", .string("stop")), JSONMember("layer", .string(layer.rawValue)),
            JSONMember("overshootMs", .number(overshootMs)), JSONMember("rate", .number(Double(rate))),
            JSONMember("token", .number(Double(token)))]))
        config.writeRow("outPoint layer=\(layer.rawValue) overshootMs=\(JSWriter.numberToString(overshootMs)) rate=\(rate) token=\(token)")
        emit(.ended(token: token))
    }

    /// A load or an unload: every layer and both timers go, and the watch
    /// starts over, keeping only the rate (the boundary lives on the old item,
    /// the observer on the player, so it must be removed here).
    private func resetOutPoint() {
        if watch.outPointSec != nil { item?.forwardPlaybackEndTime = .invalid }
        removeBoundaryObserver()
        watchdog?.cancel()
        watchdog = nil
        windowTimer?.cancel()
        windowTimer = nil
        windowOpened = false
        let heldRate = watch.rate
        watch = DeckPolicy.OutPointWatch()
        watch.rate = heldRate
    }

    private func removeBoundaryObserver() {
        if let boundaryObserver { player.removeTimeObserver(boundaryObserver) }
        boundaryObserver = nil
    }

    /// The prefetch window's one timer (`DeckPolicy.prefetchWindowDelayMs`),
    /// re-derived after every watch step: once per boundary, only while this
    /// deck is audible toward an armed boundary, and only with a standby deck.
    private func rearmPrepareWindow() {
        windowTimer?.cancel()
        windowTimer = nil
        guard !invalidated, token != nil, stage == .ready,
              let delay = DeckPolicy.prefetchWindowDelayMs(
                available: prepareWindowAvailable, outPointSec: watch.outPointSec,
                armed: watch.armed && !watch.fired, paused: !watch.playing, atSec: playheadSec,
                rate: watch.rate, leadSec: EngineConstants.HtmlAudioBackend.prefetchLeadSec,
                alreadyOpened: windowOpened) else { return }
        if delay <= 0 {
            openPrepareWindow()
            return
        }
        let gen = generation
        windowTimer = config.schedule(.prepareWindow, delay) { [weak self] in
            guard let self, gen == self.generation else { return }
            self.windowTimer = nil
            self.rearmPrepareWindow()
        }
    }

    private func openPrepareWindow() {
        guard let token else { return }
        windowOpened = true
        emit(.prepareWindow(token: token))
    }

    // MARK: - Helpers

    private func emit(_ event: DeckEvent) {
        onEvent?(event)
    }

    private func record(_ op: String) {
        primitives.append(op)
        if primitives.count > Self.primitiveCap {
            primitives.removeFirst(primitives.count - Self.primitiveCap)
        }
    }

    private static func time(_ seconds: Double) -> CMTime {
        CMTime(seconds: seconds, preferredTimescale: 1_000_000)
    }

    private static func format(_ seconds: Double) -> String {
        String(format: "%.3f", seconds)
    }

    private static func msSince(_ start: DispatchTime) -> Int {
        Int((DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000)
    }
}
