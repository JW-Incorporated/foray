import Foundation
import AVFoundation
import os

/// One `AVPlayer`, behind the `DeckDriving` seam (card NE-15;
/// docs/native-engine-plan.md §4.3 "AVFoundation choices").
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
        /// an asset whose loader never answers (the deadline test).
        var makeAsset: (URL, Bool) -> AVURLAsset

        init(
            loadDeadlineSec: Double = AVDeck.defaultLoadDeadlineSec,
            sessionIsActive: @escaping () -> Bool,
            writeRow: @escaping (String) -> Void = AVDeck.logRow,
            debugFault: @escaping (String) -> Void = { assertionFailure($0) },
            makeAsset: @escaping (URL, Bool) -> AVURLAsset = AVDeck.defaultAsset
        ) {
            self.loadDeadlineSec = loadDeadlineSec
            self.sessionIsActive = sessionIsActive
            self.writeRow = writeRow
            self.debugFault = debugFault
            self.makeAsset = makeAsset
        }
    }

    static func logRow(_ row: String) {
        logger.notice("\(row, privacy: .public)")
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
        playerObservations.forEach { $0.invalidate() }
        itemObservations.forEach { $0.invalidate() }
        itemNotifications.forEach { NotificationCenter.default.removeObserver($0) }
        asset?.cancelLoading()
    }

    func send(_ command: DeckCommand) {
        dispatchPrecondition(condition: .onQueue(.main))
        switch command {
        case let .load(token, url, startSec, preciseTiming):
            load(token: token, url: url, startSec: startSec, preciseTiming: preciseTiming)
        case .play:
            play()
        case .pause:
            pause()
        case let .seek(toSec):
            seek(to: toSec)
        case let .setRate(newRate):
            setRate(newRate)
        case .unload:
            unload()
        }
    }

    // MARK: - Load (steps 1-2)

    private func load(token newToken: DeckToken, url: URL, startSec: Double, preciseTiming: Bool) {
        // Whatever was sounding stops BEFORE the new item attaches. A
        // `replaceCurrentItem` on a playing player keeps the rate, so the new
        // item would start by itself the moment it buffered: audible before
        // the gate, at the wrong offset, and with no preroll.
        intendsToPlay = false
        if player.rate != 0 {
            record("pause (load)")
            player.pause()
        }
        detachItem()
        generation += 1
        token = newToken
        stage = .loading
        targetStartSec = max(0, startSec)
        gateAttempts = 0
        durationKnown = false
        reachedEnd = false
        lastTimeControl = nil
        lastWaitingReason = nil
        loadStartedAt = .now()

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
        prerollWhenReady() // MUTANT O
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
            player.seek(to: Self.time(target), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] finished in
                DispatchQueue.main.async {
                    guard let self, gen == self.generation else { return }
                    self.emit(.seeked(token: token, landedSec: self.player.currentTime().seconds, finished: finished))
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
        detachItem()
        generation += 1
        token = nil
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
        asset?.cancelLoading()
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
            self.emit(.pausedUncommanded(token: token, atSec: self.player.currentTime().seconds))
        }
        pauseSuspicion = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.pauseSettleSec, execute: work)
    }

    /// The player is stopped, the deck meant it to play, and it is not the
    /// end (with `actionAtItemEnd = .pause` the rate drops to 0 there too;
    /// `didPlayToEndTime` reports that).
    private func looksUncommandedPaused() -> Bool {
        guard intendsToPlay, !reachedEnd, stage == .ready, let item,
              player.rate == 0, player.timeControlStatus == .paused else { return false }
        let duration = item.duration
        if duration.isNumeric, player.currentTime().seconds >= duration.seconds - Self.endSlackSec {
            return false
        }
        return true
    }

    private func itemEnded(generation gen: Int) {
        guard gen == generation, let token else { return }
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
