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
/// ── SAME SOURCE IS A SEEK, NOT A LOAD (`DeckPolicy.sameSourceIsSeek`) ─────
///
/// The core re-enters the item the deck holds with a fresh `.load` (a paused
/// listener's play, an interruption's rewind: the reducer resumes through
/// `loadingItem`). When the deck already holds that URL, ready and with no
/// error, the load KEEPS THE ITEM: a new token and generation, the same gate
/// (zero-tolerance seek, then preroll, then `.ready`), and no new asset. It
/// is what `DeckVocabulary`'s `.load` and plan §4.4 promise ("no network
/// round trip") and what html-audio-backend.js does. Before this every play
/// after a pause threw the buffer away and fetched the file again from
/// scratch (the 2026-09-28 paste: tokens 1, 2, 3 for one episode, the second
/// load 16 s to its duration and past the 20 s deadline). A failed item, a
/// different URL or a different timing option is still a cold load.
///
/// ── ROWS (the `deck` rows in the ring) ────────────────────────────────────
///
/// The core writes a row for the duration, a not-ready and a refusal. What
/// only the deck can see is written here, through `Config.diag`: the attach
/// or reuse, `.ready` with the elapsed ms of each gate step, the deadline
/// with the step it was stuck on, a failure's error domain and code (never
/// its sentence), `timeControlStatus` with the waiting reason and the buffer
/// ahead, a stall, and the item's access-log and error-log entries (host,
/// HTTP status, bytes, requests over cellular). Tokens and numbers only:
/// DiagGate refuses anything else, and a URL never leaves this type.
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
        /// Runs `work` on main `sec` seconds from now unless it was cancelled
        /// first: the load deadline and the pause settle, the deck's only
        /// timers. Injectable so a Simulator test can fire them in virtual
        /// time instead of racing a loaded runner's wall clock (AVDeckTests).
        var after: (_ sec: Double, _ work: DispatchWorkItem) -> Void
        /// The monotonic clock, in ms, a load's elapsed time is read from
        /// (`.ready`'s and `.deadlineExceeded`'s). Injectable with `after`, so
        /// a deadline fired in virtual time reports virtual time.
        var nowMs: () -> Double
        /// The ring's structured `deck` rows (see ROWS above). The boot hands
        /// it `EngineOutput.diag`; the default writes nowhere.
        var diag: (DiagEntry) -> Void
        /// Same source is a seek (see above). On in production; NE-25b's
        /// two-deck spike turns it off, because each of its trials measures a
        /// COLD gate on the same fixture.
        var reusesSameSource: Bool

        init(
            loadDeadlineSec: Double = AVDeck.defaultLoadDeadlineSec,
            sessionIsActive: @escaping () -> Bool,
            writeRow: @escaping (String) -> Void = AVDeck.logRow,
            debugFault: @escaping (String) -> Void = { assertionFailure($0) },
            makeAsset: @escaping (URL, Bool) -> AVURLAsset = AVDeck.defaultAsset,
            after: @escaping (_ sec: Double, _ work: DispatchWorkItem) -> Void = AVDeck.mainQueueAfter,
            nowMs: @escaping () -> Double = AVDeck.uptimeMs,
            diag: @escaping (DiagEntry) -> Void = { _ in },
            reusesSameSource: Bool = true
        ) {
            self.loadDeadlineSec = loadDeadlineSec
            self.sessionIsActive = sessionIsActive
            self.writeRow = writeRow
            self.debugFault = debugFault
            self.makeAsset = makeAsset
            self.after = after
            self.nowMs = nowMs
            self.diag = diag
            self.reusesSameSource = reusesSameSource
        }
    }

    static func logRow(_ row: String) {
        logger.notice("\(row, privacy: .public)")
    }

    /// Production's timer: main, by the wall clock.
    static func mainQueueAfter(_ sec: Double, _ work: DispatchWorkItem) {
        DispatchQueue.main.asyncAfter(deadline: .now() + sec, execute: work)
    }

    /// Production's clock: uptime, which never jumps when the wall clock is set.
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
    /// `config.nowMs()` when the current load started.
    private var loadStartedAtMs: Double = 0
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
    /// The source the attached item was made from (the load's `url` string)
    /// and its timing option: what "the same source" is compared against.
    private(set) var loadedURL: String?
    private var loadedPreciseTiming = false
    /// The current load kept the attached item (same source) rather than
    /// making a new one. For the rows.
    private var reusedItem = false
    /// The gate step the current load is in, and the ms (since the load
    /// started) at which each step completed: the `ready` and `deadline`
    /// rows say where the time went, or where it stopped.
    private var gateStep = "idle"
    private var gateMarks: [JSONMember] = []

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
        playerObservations.forEach { $0.invalidate() }
        itemObservations.forEach { $0.invalidate() }
        itemNotifications.forEach { NotificationCenter.default.removeObserver($0) }
        asset?.cancelLoading()
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
        }
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
        if let urlString, holdsHealthy(urlString, preciseTiming: preciseTiming) {
            reuse(token: newToken, startSec: startSec)
            return
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
        loadStartedAtMs = config.nowMs()
        loadedURL = nil
        reusedItem = false
        gateStep = "duration"
        gateMarks = []
        // The core hands the page's `audio_url` through as it is (nil for an
        // item with no audio of its own). Anything that is not an absolute
        // URL fails THIS load, under its token, so the core's failure path
        // runs; it is never an exception in the car.
        guard let url = urlString.flatMap({ URL(string: $0) }), url.scheme != nil else {
            stage = .failed
            record("no-url")
            deckRow("failed", newToken, [JSONMember("where", .string("no-url"))])
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
        loadedURL = urlString
        loadedPreciseTiming = preciseTiming
        observe(item: item, generation: generation)
        armDeadline(generation: generation)
        record("attach")
        deckRow("attach", newToken, [
            JSONMember("startSec", Self.secNode(targetStartSec)),
            JSONMember("precise", .bool(preciseTiming)),
            JSONMember("host", Self.hostNode(url.host))
        ])
        player.replaceCurrentItem(with: item)
        loadDuration(of: asset, generation: generation)
    }

    /// `DeckPolicy.sameSourceIsSeek` from what this deck holds: the same URL
    /// (and the same timing option, which is the asset's), an item whose
    /// duration and both statuses are in, and no error on it.
    private func holdsHealthy(_ url: String, preciseTiming: Bool) -> Bool {
        guard config.reusesSameSource, let item, preciseTiming == loadedPreciseTiming else { return false }
        let hasMetadata = durationKnown && item.status == .readyToPlay && player.status == .readyToPlay
        let failed = stage == .failed || item.status == .failed || item.error != nil
        return DeckPolicy.sameSourceIsSeek(loadedUrl: loadedURL, url: url, hasMetadata: hasMetadata, failed: failed)
    }

    /// Same source: keep the item and its buffer, and run the SAME gate under
    /// the new token. The generation moves, so every callback of the previous
    /// load (a gate seek, a preroll, a deadline, a pause settle) is void, and
    /// the item's observers are re-registered under it. The gate starts from
    /// `advanceIfReady` like any load's (duration and both statuses are in),
    /// so the one path to `preroll(` is unchanged. The out-point lives on the
    /// item, and a load drops it (`DeckCommand.load`), so it is disarmed here.
    private func reuse(token newToken: DeckToken, startSec: Double) {
        let fromSec = player.currentTime().seconds
        deadline?.cancel()
        deadline = nil
        pauseSuspicion?.cancel()
        pauseSuspicion = nil
        generation += 1
        token = newToken
        stage = .loading
        targetStartSec = max(0, startSec)
        gateAttempts = 0
        reachedEnd = false
        lastTimeControl = nil
        lastWaitingReason = nil
        loadStartedAtMs = config.nowMs()
        reusedItem = true
        gateStep = "readiness"
        gateMarks = []
        guard let item else { return }
        item.forwardPlaybackEndTime = .invalid
        unobserveItem()
        observe(item: item, generation: generation)
        armDeadline(generation: generation)
        record("reuse")
        deckRow("reuse", newToken, [
            JSONMember("startSec", Self.secNode(targetStartSec)),
            JSONMember("fromSec", Self.secNode(fromSec)),
            JSONMember("bufferedAheadSec", Self.secNode(bufferedAhead(of: targetStartSec)))
        ])
        advanceIfReady()
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
            mark("duration")
            if stage == .loading { gateStep = "readiness" }
            let duration = asset.duration
            let seconds: Double? = duration.isNumeric && duration.seconds.isFinite ? duration.seconds : nil
            emit(.durationLoaded(token: token, durationSec: seconds))
            advanceIfReady()
        case .failed:
            fail(generation: gen, message: "duration: \(error?.localizedDescription ?? "unknown")",
                 where: "duration", error: error)
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
        mark("readiness")
        gateSeek()
    }

    /// Step 4: zero tolerance, because the start offset IS the resume point
    /// (an episode's saved position; later a Foray segment's in-point), and a
    /// tolerant seek lands on the nearest sync point, seconds away on some
    /// encodings.
    private func gateSeek() {
        let gen = generation
        let target = targetStartSec
        gateStep = "seek"
        record("seek \(Self.format(target))")
        player.seek(to: Self.time(target), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] finished in
            DispatchQueue.main.async {
                self?.gateSeekCompleted(finished: finished, target: target, generation: gen)
            }
        }
    }

    private func gateSeekCompleted(finished: Bool, target: Double, generation gen: Int) {
        guard gen == generation, stage == .gating else { return }
        if finished { mark("seek") }
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
        gateStep = "preroll"
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
        mark("preroll")
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
        gateStep = "ordinary-load"
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
        gateStep = "ready"
        let landed = player.currentTime().seconds
        let elapsed = msSinceLoadStarted()
        deckRow("ready", token, [
            JSONMember("landedSec", Self.secNode(landed)),
            JSONMember("targetSec", Self.secNode(targetStartSec)),
            JSONMember("prerolled", .bool(prerolled)),
            JSONMember("reuse", .bool(reusedItem)),
            JSONMember("elapsedMs", .number(Double(elapsed))),
            JSONMember("attempts", .number(Double(gateAttempts))),
            JSONMember("marks", .object(gateMarks)),
            JSONMember("bufferedAheadSec", Self.secNode(bufferedAhead(of: landed))),
            JSONMember("likelyToKeepUp", item.map { JSONNode.bool($0.isPlaybackLikelyToKeepUp) } ?? .null)
        ])
        emit(.ready(
            token: token,
            landedSec: landed,
            prerolled: prerolled,
            elapsedMs: elapsed
        ))
    }

    // MARK: - Deadline (P-13)

    private func armDeadline(generation gen: Int) {
        let work = DispatchWorkItem { [weak self] in self?.deadlineFired(generation: gen) }
        deadline = work
        config.after(config.loadDeadlineSec, work)
    }

    private func deadlineFired(generation gen: Int) {
        guard gen == generation, stage == .loading || stage == .gating, let token else { return }
        let afterMs = msSinceLoadStarted()
        // Where it was stuck, read BEFORE the detach drops the item: the step,
        // what AVFoundation said, how much it had fetched and from where.
        deckRow("deadline", token, [
            JSONMember("afterMs", .number(Double(afterMs))),
            JSONMember("step", .string(gateStep)),
            JSONMember("reuse", .bool(reusedItem)),
            JSONMember("durationKnown", .bool(durationKnown)),
            JSONMember("playerStatus", .string(Self.statusToken(player.status.rawValue))),
            JSONMember("itemStatus", .string(Self.statusToken(item?.status.rawValue))),
            JSONMember("attempts", .number(Double(gateAttempts))),
            JSONMember("targetSec", Self.secNode(targetStartSec)),
            JSONMember("bufferedAheadSec", Self.secNode(bufferedAhead(of: targetStartSec))),
            JSONMember("marks", .object(gateMarks))
        ] + accessFields() + errorLogFields())
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

    /// The out-point's FIRST layer only (plan §4.3 P-2):
    /// `forwardPlaybackEndTime` (nil disarms), so AVFoundation itself treats
    /// that second as the item's end. The boundary observer and the
    /// watchdog armed for the last 1.5 s are NE-32's, which is also the card
    /// in which a bounded item first plays; an episode (M1) never sets one.
    /// It lives on the ITEM, so the next load's fresh item drops it, as the
    /// core's vocabulary says a load does.
    private func setOutPoint(_ sec: Double?) {
        guard let item else { return }
        let end = sec.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
        item.forwardPlaybackEndTime = end.map { Self.time($0) } ?? .invalid
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
                self?.fail(generation: gen, message: "failed-to-end: \(error?.localizedDescription ?? "unknown")",
                           where: "failed-to-end", error: error)
            },
            center.addObserver(forName: AVPlayerItem.playbackStalledNotification, object: item, queue: .main) { [weak self] _ in
                self?.itemStalled(generation: gen)
            },
            // The network's own record (host, HTTP status, bytes, cellular):
            // what the deadline and stall rows cannot say by themselves.
            center.addObserver(forName: AVPlayerItem.newAccessLogEntryNotification, object: item, queue: .main) { [weak self] _ in
                self?.accessLogged(generation: gen)
            },
            center.addObserver(forName: AVPlayerItem.newErrorLogEntryNotification, object: item, queue: .main) { [weak self] _ in
                self?.errorLogged(generation: gen)
            }
        ]
    }

    /// Drop the item's observers (KVO and notifications), keeping the item.
    private func unobserveItem() {
        itemObservations.forEach { $0.invalidate() }
        itemObservations = []
        itemNotifications.forEach { NotificationCenter.default.removeObserver($0) }
        itemNotifications = []
    }

    private func detachItem() {
        deadline?.cancel()
        deadline = nil
        pauseSuspicion?.cancel()
        pauseSuspicion = nil
        unobserveItem()
        asset?.cancelLoading()
        asset = nil
        item = nil
        loadedURL = nil
    }

    private func playerStatusChanged() {
        if player.status == .failed {
            fail(generation: generation, message: "player: \(player.error?.localizedDescription ?? "unknown")",
                 where: "player", error: player.error)
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
            fail(generation: gen, message: "item: \(item.error?.localizedDescription ?? "unknown")",
                 where: "item", error: item.error)
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
            // The row the 2026-09-28 paste did not have: a "playing" engine
            // whose playhead never moved was either waiting (and why) or
            // paused, and only this says which.
            let at = player.currentTime().seconds
            deckRow("time-control", token, [
                JSONMember("status", .string(status.rawValue)),
                JSONMember("reason", reason.map { JSONNode.string(Self.waitingToken($0)) } ?? .null),
                JSONMember("step", .string(gateStep)),
                JSONMember("positionSec", Self.secNode(at)),
                JSONMember("bufferedAheadSec", Self.secNode(bufferedAhead(of: at))),
                JSONMember("likelyToKeepUp", item.map { JSONNode.bool($0.isPlaybackLikelyToKeepUp) } ?? .null),
                JSONMember("rate", .number(Double(player.rate)))
            ])
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
        config.after(Self.pauseSettleSec, work)
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

    private func itemEnded(generation gen: Int) {
        guard gen == generation, let token else { return }
        reachedEnd = true
        intendsToPlay = false
        emit(.ended(token: token))
    }

    private func itemStalled(generation gen: Int) {
        guard gen == generation, let token else { return }
        let at = player.currentTime().seconds
        deckRow("stalled", token, [
            JSONMember("positionSec", Self.secNode(at)),
            JSONMember("bufferedAheadSec", Self.secNode(bufferedAhead(of: at)))
        ] + accessFields())
        emit(.stalled(token: token))
        // THE STALL IS A LATCH IN THE CORE (`buffering = true`), and only a
        // `.timeControl(.playing)` releases it. The stall notification comes
        // through NotificationCenter's main OperationQueue while the
        // timeControl KVO hops through the main dispatch queue, so it can land
        // AFTER the player is already back to `.playing`, which was then never
        // reported again (deduplicated): Now Playing kept `rate 0` for the
        // rest of the item, the car read "paused", hid the elapsed time and
        // kept pressing play. Re-report what the player says NOW, whatever
        // the last report was.
        guard gen == generation, self.token == token else { return }
        lastTimeControl = nil
        lastWaitingReason = nil
        timeControlChanged()
    }

    /// `where` says which observation failed (`duration`, `item`, `player`,
    /// `failed-to-end`); the row carries the error's domain and code and its
    /// underlying one (a CoreMedia or URL error under AVFoundation's), never
    /// the localized sentence, which DiagGate would refuse anyway.
    private func fail(generation gen: Int, message: String, where step: String, error: Error?) {
        guard gen == generation, stage != .failed, let token else { return }
        deadline?.cancel()
        deadline = nil
        stage = .failed
        intendsToPlay = false
        deckRow("failed", token, [
            JSONMember("where", .string(step)),
            JSONMember("step", .string(gateStep)),
            JSONMember("positionSec", Self.secNode(player.currentTime().seconds))
        ] + Self.errorFields(error) + accessFields() + errorLogFields())
        emit(.failed(token: token, message: message))
    }

    // MARK: - Network logs (rows only)

    private func accessLogged(generation gen: Int) {
        guard gen == generation, let token else { return }
        deckRow("access", token, accessFields())
    }

    private func errorLogged(generation gen: Int) {
        guard gen == generation, let token else { return }
        deckRow("http-error", token, errorLogFields())
    }

    /// The item's latest access-log event: where the bytes came from and how
    /// fast. `wwan` is the number of media requests made over cellular.
    private func accessFields() -> [JSONMember] {
        guard let event = item?.accessLog()?.events.last else { return [JSONMember("access", .null)] }
        return [
            JSONMember("host", Self.hostNode(event.uri.flatMap { URLComponents(string: $0)?.host })),
            JSONMember("bytes", .number(Double(max(0, event.numberOfBytesTransferred)))),
            JSONMember("transferMs", Self.msNode(event.transferDuration)),
            JSONMember("requests", .number(Double(max(0, event.numberOfMediaRequests)))),
            JSONMember("wwan", .number(Double(max(0, event.mediaRequestsWWAN)))),
            JSONMember("observedKbps", Self.kbpsNode(event.observedBitrate)),
            JSONMember("stalls", .number(Double(max(0, event.numberOfStalls)))),
            JSONMember("serverChanges", .number(Double(max(0, event.numberOfServerAddressChanges))))
        ]
    }

    /// The item's latest error-log event: the HTTP status (or the URL
    /// error's code) and its domain. Its comment is free text and stays out.
    private func errorLogFields() -> [JSONMember] {
        guard let event = item?.errorLog()?.events.last else { return [] }
        return [
            JSONMember("logHost", Self.hostNode(event.uri.flatMap { URLComponents(string: $0)?.host })),
            JSONMember("logStatus", .number(Double(event.errorStatusCode))),
            JSONMember("logDomain", Self.tokenNode(event.errorDomain))
        ]
    }

    // MARK: - Helpers

    private func emit(_ event: DeckEvent) {
        onEvent?(event)
    }

    /// A `deck` row for `token`, written through `Config.diag`.
    private func deckRow(_ kind: String, _ token: DeckToken, _ fields: [JSONMember]) {
        config.diag(DiagEntry(kind: "deck", fields: [
            JSONMember("kind", .string(kind)),
            JSONMember("token", .number(Double(token)))
        ] + fields))
    }

    /// The first completion of a gate step, in ms since the load started.
    private func mark(_ step: String) {
        guard !gateMarks.contains(where: { $0.key == step }) else { return }
        gateMarks.append(JSONMember(step, .number(Double(msSinceLoadStarted()))))
    }

    /// Seconds of media loaded from `sec` onwards, in the loaded range that
    /// holds it (0 when none does: the playhead sits outside the buffer).
    private func bufferedAhead(of sec: Double) -> Double? {
        guard let item, sec.isFinite else { return nil }
        for value in item.loadedTimeRanges {
            let range = value.timeRangeValue
            let start = range.start.seconds
            let end = range.end.seconds
            guard start.isFinite, end.isFinite else { continue }
            if sec >= start - 0.001 && sec <= end { return end - sec }
        }
        return 0
    }

    /// Three decimals, or null for a value a row cannot carry.
    static func secNode(_ sec: Double?) -> JSONNode {
        guard let sec, sec.isFinite else { return .null }
        return .number((sec * 1000).rounded() / 1000)
    }

    static func msNode(_ sec: TimeInterval) -> JSONNode {
        sec.isFinite && sec >= 0 ? .number((sec * 1000).rounded()) : .null
    }

    static func kbpsNode(_ bitsPerSecond: Double) -> JSONNode {
        bitsPerSecond.isFinite && bitsPerSecond > 0 ? .number((bitsPerSecond / 1000).rounded()) : .null
    }

    /// A host is a token (letters, digits, dots, dashes), lowercased; any
    /// other shape is null rather than a row DiagGate would have to refuse.
    static func hostNode(_ host: String?) -> JSONNode {
        tokenNode(host?.lowercased())
    }

    static func tokenNode(_ text: String?) -> JSONNode {
        guard let text, DiagGate.isToken(text) else { return .null }
        return .string(text)
    }

    /// `AVPlayer.Status` / `AVPlayerItem.Status` raw values (both 0 unknown,
    /// 1 ready, 2 failed); nil is an item that is not there.
    static func statusToken(_ raw: Int?) -> String {
        switch raw {
        case 0?: return "unknown"
        case 1?: return "ready"
        case 2?: return "failed"
        case nil: return "none"
        default: return "other"
        }
    }

    /// `reasonForWaitingToPlay`, shortened to a token.
    static func waitingToken(_ raw: String) -> String {
        switch raw {
        case AVPlayer.WaitingReason.toMinimizeStalls.rawValue: return "minimize-stalls"
        case AVPlayer.WaitingReason.evaluatingBufferingRate.rawValue: return "evaluating-buffering-rate"
        case AVPlayer.WaitingReason.noItemToPlay.rawValue: return "no-item"
        default: return DiagGate.isToken(raw) ? raw : "other"
        }
    }

    /// An error as `domain`/`code`, and its underlying error's, if any.
    static func errorFields(_ error: Error?) -> [JSONMember] {
        guard let error else { return [JSONMember("errDomain", .null)] }
        let ns = error as NSError
        var fields = [JSONMember("errDomain", tokenNode(ns.domain)), JSONMember("errCode", .number(Double(ns.code)))]
        if let under = ns.userInfo[NSUnderlyingErrorKey] as? NSError {
            fields.append(JSONMember("underDomain", tokenNode(under.domain)))
            fields.append(JSONMember("underCode", .number(Double(under.code))))
        }
        return fields
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

    private func msSinceLoadStarted() -> Int {
        Int(max(0, config.nowMs() - loadStartedAtMs))
    }
}
