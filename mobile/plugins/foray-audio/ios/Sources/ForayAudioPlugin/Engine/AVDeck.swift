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
/// An item with NO out-point (a rendered narration line, an episode left to
/// its natural end) has a boundary too: its duration (NE-45s,
/// `DeckPolicy.windowBoundarySec`), so the clip after a rendered line is
/// prepared while the line plays, and a line shorter than the lead opens its
/// window at its first play.
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
/// ── A LOAD THAT IS GETTING SOMEWHERE IS NOT THROWN AWAY (§16) ─────────────
///
/// The M2 car drive (2026-10-01): a Foray clip's precise load passed its 20 s
/// deadline with its duration in and 44 MB fetched, was detached, and each
/// press of play then started the clip cold from nothing (`cold=no-item`,
/// `cold=not-ready`). Two changes, both for a PRECISE load only (a Foray clip;
/// a whole episode and a rendered line load approximate and keep M1's
/// car-proven cold reload unchanged), and both only when the load has made
/// progress (its duration is in, or the access log shows bytes):
///   - a same-source `.load` while the load is still in flight CONTINUES it
///     (`continueInFlight`, a `deck kind=continue` row): the new token, the
///     new start, a fresh deadline, and the same item, asset and gate;
///   - its deadline LAPSES rather than detaching first: `.deadlineExceeded`
///     is delivered with the item still attached, and the core's retry of the
///     same clip in that turn (queue-manager.js §16, `deck kind=retry`) is such
///     a same-source load. Anything else (no retry, another item, an unload)
///     and the item is detached exactly as before, after the event.
/// A load with no progress is detached and its asset forgotten as before, so
/// its retry is a fresh connection.
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

    /// P-13, CLIP OR EPISODE (`DeckDeadlineClass.clip`): how long a load may
    /// take to reach `.ready` before the deck gives up, detaches the item, and
    /// reports `.deadlineExceeded`. PROVISIONAL (card NE-38;
    /// docs/ios-native-engine-measurements.md §12), 20 s unchanged:
    ///   - the Simulator's cold first loads took 1.5-19.6 s (§8.2) and its
    ///     warm loads 0.2-1.2 s (§8.1, §10.1);
    ///   - in the field (2026-09-28, build 2026092706) token 1 had its duration
    ///     in 2.2 s and token 3 in 1.4 s; the only load past 19 s (token 2)
    ///     was a same-source refetch, which #866 made a seek.
    /// Settled by the `deck kind=ready elapsedMs marks` rows of cold loads and
    /// every `deck kind=deadline step= class=clip` row (NE-38e verdict
    /// `P13-clip`, whose proposal NE-38f applies or declines).
    static let defaultLoadDeadlineSec: Double = 20 // MEASURE: verdict=P13-clip (NE-38e). Rows: deck kind=ready elapsedMs marks, deck kind=deadline step= class=clip.

    /// P-13, A RENDERED NARRATION LINE (`DeckDeadlineClass.line`, new in
    /// NE-38). PROVISIONAL, 8 s: a line is about 160 KB (64 kbps, about 20 s
    /// of speech), warm AVPlayer loads take under 1.3 s, and a line whose
    /// file fails is read aloud from its script on a fresh token (NE-37c),
    /// so a longer wait only lengthens a silence in the car. Settled by the
    /// same rows with `class=line` (NE-38e verdict `P13-line`, NE-38f).
    static let defaultLineLoadDeadlineSec: Double = 8 // MEASURE: verdict=P13-line (NE-38e). Rows: deck kind=ready elapsedMs class=line, deck kind=deadline step= class=line.

    /// A pause reported this close to the item's end is the end, not an
    /// uncommanded stop: with `actionAtItemEnd = .pause` the rate drops to 0
    /// at the end, and that KVO can land before `didPlayToEndTime` does.
    static let endSlackSec: Double = 0.5

    /// How long a stopped-while-intending-to-play observation must hold
    /// before it is reported (see `checkUncommandedPause`). Well inside the
    /// core's 500 ms route-attribution window (plan §4.3).
    static let pauseSettleSec: Double = 0.25

    /// How long the deck may have been idle (not playing, not loading) and
    /// still treat a same-source load as a seek in the held item. Past it the
    /// load is cold, exactly as before same-source reuse existed. The field's
    /// proven path is a car resuming 4a after HOURS parked (the milestone-1
    /// car test, build 2026092706, where every load was cold), and a held
    /// item that old has had its connection and possibly its signed redirect
    /// expire behind a `.readyToPlay` status, so the buffer it would keep is
    /// not worth the risk of an item that fails mid-drive. The pause the
    /// 2026-09-28 paste refetched after (12 s) is well inside it.
    /// Measured on a clock that runs while the phone sleeps. `AssetCache`
    /// keeps a shared asset for the same limit, by this constant.
    /// PROVISIONAL (card NE-38; docs/ios-native-engine-measurements.md §12),
    /// 600 s unchanged: #866's review found that an item held for hours can
    /// report ready over an expired connection, and M1's car win came from
    /// cold loads. Settled by a `deck kind=reuse idleSec=` followed within
    /// 30 s by `failed`, `deadline` or `stalled` on that token (the risk of a
    /// longer limit), and by the `deck kind=attach cold=stale idleSec=` rows
    /// (what this limit cost): NE-38e verdict `reuse-idle`, NE-38f.
    static let defaultReuseMaxIdleSec: Double = 600 // MEASURE: verdict=reuse-idle (NE-38e). Rows: deck kind=reuse idleSec= then failed/deadline/stalled within 30 s, deck kind=attach cold=stale idleSec=.

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
        /// P-13 for a clip or an episode (`defaultLoadDeadlineSec`).
        var loadDeadlineSec: Double
        /// P-13 for a rendered narration line (`defaultLineLoadDeadlineSec`).
        var lineLoadDeadlineSec: Double
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
        /// The ring's structured rows: the `outPoint` row (NE-32) and the `deck`
        /// rows (see ROWS above). The boot hands it `EngineOutput.diag`; the
        /// default writes nowhere.
        var diag: (DiagEntry) -> Void
        /// NE-32: layer 1's pad (`defaultStopPadSec`).
        var stopPadSec: Double
        /// NE-32: a one-shot timer on main, `ms` of wall clock from now.
        /// Injectable so a test can count the watchdog's wakeups.
        var schedule: (TimerPurpose, Double, @escaping () -> Void) -> EngineObservation
        /// Runs `work` on main `sec` seconds from now unless it was cancelled
        /// first: the load deadline and the pause settle. Injectable so a
        /// Simulator test can fire them in virtual time instead of racing a
        /// loaded runner's wall clock (AVDeckTests).
        var after: (_ sec: Double, _ work: DispatchWorkItem) -> Void
        /// NE-32: the monotonic clock the out-point watch reads, in ms; also
        /// the one a load's elapsed time (`.ready`, `.deadlineExceeded`) is
        /// read from, so a deadline fired in virtual time reports virtual time.
        var nowMs: () -> Double
        /// NE-32: which out-point layers run. All three in production; a
        /// Simulator test arms one alone to prove it stops never-early.
        var outPointLayers: Set<DeckPolicy.OutPointLayer>
        /// Same source is a seek (see above). On in production; NE-25b's
        /// two-deck spike turns it off, because each of its trials measures a
        /// COLD gate on the same fixture.
        var reusesSameSource: Bool
        /// See `defaultReuseMaxIdleSec`.
        var reuseMaxIdleSec: Double
        /// The clock idleness is read from, in ms. NOT `nowMs`: uptime stops
        /// while the device sleeps, and a phone parked all day sleeps for most
        /// of it, so uptime would call an eight-hour-old item fresh.
        /// Injectable so a test can age the held item.
        var idleClockMs: () -> Double
        /// A load on this asset failed or passed its deadline. A DeckPair's
        /// decks hand it to their shared `AssetCache` (`forget`), so the retry
        /// gets a NEW asset: a failed or hung asset stays that way, and the
        /// cache would otherwise hand the same one back (NE-37c review). A
        /// lone deck makes a new asset for every cold load already.
        var assetFailed: (AVURLAsset) -> Void
        /// §16: whether the current load has made progress, in place of the
        /// item's own reading (`loadProgressed`). nil in production. A
        /// Simulator test's stand-in for an asset that has fetched part of a
        /// file but is not ready, which no deterministic fixture can be: a
        /// loader that never answers makes no progress, and one that answers
        /// becomes ready. What a progressing load then DOES (lapse, continue,
        /// detach) is the real code either way.
        var forcesLoadProgress: Bool? = nil

        init(
            loadDeadlineSec: Double = AVDeck.defaultLoadDeadlineSec,
            lineLoadDeadlineSec: Double = AVDeck.defaultLineLoadDeadlineSec,
            sessionIsActive: @escaping () -> Bool,
            writeRow: @escaping (String) -> Void = AVDeck.logRow,
            debugFault: @escaping (String) -> Void = { assertionFailure($0) },
            makeAsset: @escaping (URL, Bool) -> AVURLAsset = AVDeck.defaultAsset,
            cancelsAssetLoading: Bool = true,
            diag: @escaping (DiagEntry) -> Void = { _ in },
            stopPadSec: Double = AVDeck.defaultStopPadSec,
            schedule: @escaping (TimerPurpose, Double, @escaping () -> Void) -> EngineObservation = AVDeck.mainQueueTimer,
            after: @escaping (_ sec: Double, _ work: DispatchWorkItem) -> Void = AVDeck.mainQueueAfter,
            nowMs: @escaping () -> Double = AVDeck.uptimeMs,
            outPointLayers: Set<DeckPolicy.OutPointLayer> = Set(DeckPolicy.OutPointLayer.allCases),
            reusesSameSource: Bool = true,
            reuseMaxIdleSec: Double = AVDeck.defaultReuseMaxIdleSec,
            idleClockMs: @escaping () -> Double = AVDeck.continuousMs,
            assetFailed: @escaping (AVURLAsset) -> Void = { _ in }
        ) {
            self.loadDeadlineSec = loadDeadlineSec
            self.lineLoadDeadlineSec = lineLoadDeadlineSec
            self.sessionIsActive = sessionIsActive
            self.writeRow = writeRow
            self.debugFault = debugFault
            self.makeAsset = makeAsset
            self.cancelsAssetLoading = cancelsAssetLoading
            self.diag = diag
            self.stopPadSec = stopPadSec
            self.schedule = schedule
            self.after = after
            self.nowMs = nowMs
            self.outPointLayers = outPointLayers
            self.reusesSameSource = reusesSameSource
            self.reuseMaxIdleSec = reuseMaxIdleSec
            self.idleClockMs = idleClockMs
            self.assetFailed = assetFailed
        }

        /// The P-13 deadline, in seconds, of a load of this class (NE-38):
        /// the core names the class, the deck owns the seconds.
        func deadlineSec(for deadlineClass: DeckDeadlineClass) -> Double {
            switch deadlineClass {
            case .clip: return loadDeadlineSec
            case .line: return lineLoadDeadlineSec
            }
        }
    }

    static func logRow(_ row: String) {
        logger.notice("\(row, privacy: .public)")
    }

    static func mainQueueTimer(_ purpose: TimerPurpose, _ ms: Double, _ fire: @escaping () -> Void) -> EngineObservation {
        outPointTiming.schedule(afterMs: ms, repeating: false, fire: fire)
    }

    /// Production's timer for the load deadline and the pause settle: main,
    /// by the wall clock.
    static func mainQueueAfter(_ sec: Double, _ work: DispatchWorkItem) {
        DispatchQueue.main.asyncAfter(deadline: .now() + sec, execute: work)
    }

    /// Production's clock: uptime, which never jumps when the wall clock is set.
    static func uptimeMs() -> Double {
        Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000
    }

    /// A monotonic clock that keeps counting while the device sleeps
    /// (Darwin's CLOCK_MONOTONIC; `uptimeMs` does not).
    static func continuousMs() -> Double {
        Double(clock_gettime_nsec_np(CLOCK_MONOTONIC)) / 1_000_000
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
    /// The current load's P-13 class (NE-38): which deadline it runs under,
    /// and the `class=` of its rows.
    private var deadlineClass: DeckDeadlineClass = .clip
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
    /// and its timing option: what "the same source" is compared against,
    /// here (`coldReason`) and by the pair (NE-32's prefetch decision and
    /// its "same episode" check). nil while no item is attached.
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
    /// `config.idleClockMs()` when the held item was last live: loading,
    /// ready, commanded, or observed playing or stopping. What
    /// `reuseMaxIdleSec` is measured from.
    private var lastLiveMs: Double = 0
    /// §16, set ONLY while a progressing precise load's `.deadlineExceeded`
    /// is being delivered (see `deadlineFired`): the token whose deadline
    /// passed and the gate stage it was in. The core answers in that same turn,
    /// on main; a same-source retry continues the load (`continueInFlight`),
    /// and anything else leaves it to be detached exactly as before.
    private var lapsed: (token: DeckToken, stage: Stage)?

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
        case let .load(token, _, url, startSec, preciseTiming, deadlineClass):
            load(token: token, url: url, startSec: startSec, preciseTiming: preciseTiming, deadlineClass: deadlineClass)
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

    private func load(token newToken: DeckToken, url urlString: String?, startSec: Double, preciseTiming: Bool,
                      deadlineClass newClass: DeckDeadlineClass) {
        // Whatever was sounding stops BEFORE the new item attaches. A
        // `replaceCurrentItem` on a playing player keeps the rate, so the new
        // item would start by itself the moment it buffered: audible before
        // the gate, at the wrong offset, and with no preroll.
        intendsToPlay = false
        if player.rate != 0 {
            // It was sounding up to this instant: live, however long ago the
            // last command was.
            noteLive()
            record("pause (load)")
            player.pause()
        }
        // Every out-point layer and timer of the previous load goes, whether
        // this load keeps the item or not (a load drops the out-point).
        resetOutPoint()
        if continuesInFlight(urlString, preciseTiming: preciseTiming) {
            continueInFlight(token: newToken, startSec: startSec, deadlineClass: newClass)
            return
        }
        let idleSec = item == nil ? nil : max(0, (config.idleClockMs() - lastLiveMs) / 1000)
        let cold = coldReason(urlString, preciseTiming: preciseTiming, idleSec: idleSec)
        if cold == nil {
            reuse(token: newToken, startSec: startSec, idleSec: idleSec, deadlineClass: newClass)
            return
        }
        detachItem()
        generation += 1
        token = newToken
        deadlineClass = newClass
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
            deckRow("failed", newToken, [JSONMember("where", .string("no-url")), classField])
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
        noteLive()
        observe(item: item, generation: generation)
        armDeadline(generation: generation)
        record("attach")
        deckRow("attach", newToken, [
            JSONMember("startSec", Self.secNode(targetStartSec)),
            JSONMember("precise", .bool(preciseTiming)),
            JSONMember("host", Self.hostNode(url.host)),
            // Why this load did not keep the held item (`no-item` when there
            // was none), and how long that item had been idle.
            JSONMember("cold", .string(cold ?? "no-item")),
            JSONMember("idleSec", Self.secNode(idleSec)),
            classField
        ])
        player.replaceCurrentItem(with: item)
        loadDuration(of: asset, generation: generation)
    }

    /// `DeckPolicy.sameSourceIsSeek` from what this deck holds: the same URL
    /// (and the same timing option, which is the asset's), an item still on
    /// the player whose duration and both statuses are in, no error on it,
    /// and not idle past `reuseMaxIdleSec`. Nil means keep the item; any
    /// other answer is why the load is cold, as a row token.
    private func coldReason(_ url: String?, preciseTiming: Bool, idleSec: Double?) -> String? {
        guard config.reusesSameSource else { return "off" }
        guard let item, player.currentItem === item else { return "no-item" }
        guard let url, url == loadedURL else { return "other-source" }
        guard preciseTiming == loadedPreciseTiming else { return "timing" }
        let failed = stage == .failed || item.status == .failed || item.error != nil
        if failed { return "failed" }
        let hasMetadata = durationKnown && item.status == .readyToPlay && player.status == .readyToPlay
        if !hasMetadata { return "not-ready" }
        guard let idleSec, idleSec <= config.reuseMaxIdleSec else { return "stale" }
        return DeckPolicy.sameSourceIsSeek(loadedUrl: loadedURL, url: url, hasMetadata: hasMetadata, failed: failed)
            ? nil : "policy"
    }

    /// The held item is live now (see `lastLiveMs`).
    private func noteLive() {
        lastLiveMs = config.idleClockMs()
    }

    // MARK: - §16: continue a load that is getting somewhere

    /// Progress, by the item's own word: the duration is in, or bytes arrived.
    static func progressed(durationKnown: Bool, bytes: Int64) -> Bool {
        durationKnown || bytes > 0
    }

    /// Every byte the attached item's access log says it fetched.
    private var bytesFetched: Int64 {
        item?.accessLog()?.events.reduce(Int64(0)) { $0 + max(0, $1.numberOfBytesTransferred) } ?? 0
    }

    private var loadProgressed: Bool {
        config.forcesLoadProgress ?? Self.progressed(durationKnown: durationKnown, bytes: bytesFetched)
    }

    /// Does a `.load` of `url` continue the load in flight (see the header)?
    /// The same item still on the player, the same URL, PRECISE timing on
    /// both, no error, still loading or gating (or lapsed at its deadline),
    /// and progress made.
    private func continuesInFlight(_ url: String?, preciseTiming: Bool) -> Bool {
        guard preciseTiming, loadedPreciseTiming, let item, player.currentItem === item,
              let url, url == loadedURL, item.status != .failed, item.error == nil else { return false }
        let inFlight = lapsed != nil || stage == .loading || stage == .gating
        return inFlight && loadProgressed
    }

    /// The load in flight takes the new token, start and class, and a fresh
    /// deadline; the item, its asset, its observers (whose callbacks read the
    /// token when they fire) and the gate's progress are kept. A gate seek or
    /// preroll already running re-seeks itself when the start moved
    /// (`gateSeekCompleted`); a load still waiting for its duration or
    /// statuses moves on from the next observation, or now if they are in.
    /// `heldMs` is how long the item has been loading since its attach.
    private func continueInFlight(token newToken: DeckToken, startSec: Double, deadlineClass newClass: DeckDeadlineClass) {
        let fromToken = token
        if let held = lapsed {
            stage = held.stage
            lapsed = nil
        }
        deadline?.cancel()
        deadline = nil
        pauseSuspicion?.cancel()
        pauseSuspicion = nil
        token = newToken
        deadlineClass = newClass
        targetStartSec = max(0, startSec)
        reachedEnd = false
        noteLive()
        armDeadline(generation: generation)
        record("continue")
        deckRow("continue", newToken, [
            JSONMember("fromToken", fromToken.map { JSONNode.number(Double($0)) } ?? .null),
            JSONMember("heldMs", .number(Double(msSinceLoadStarted()))),
            JSONMember("step", .string(gateStep)),
            JSONMember("durationKnown", .bool(durationKnown)),
            JSONMember("startSec", Self.secNode(targetStartSec)),
            classField
        ] + accessFields())
        if stage == .loading { advanceIfReady() }
    }

    /// Same source: keep the item and its buffer, and run the SAME gate under
    /// the new token. The generation moves, so every callback of the previous
    /// load (a gate seek, a preroll, a deadline, a pause settle) is void, and
    /// the item's observers are re-registered under it. The gate starts from
    /// `advanceIfReady` like any load's (duration and both statuses are in),
    /// so the one path to `preroll(` is unchanged. The out-point lives on the
    /// item, and a load drops it (`DeckCommand.load`): `load` disarmed it,
    /// with every other layer and timer, in `resetOutPoint` before this ran.
    private func reuse(token newToken: DeckToken, startSec: Double, idleSec: Double?,
                       deadlineClass newClass: DeckDeadlineClass) {
        let fromSec = player.currentTime().seconds
        deadline?.cancel()
        deadline = nil
        pauseSuspicion?.cancel()
        pauseSuspicion = nil
        generation += 1
        token = newToken
        deadlineClass = newClass
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
        noteLive()
        guard let item else { return }
        // The out-point lives on the item; `load` already dropped it
        // (`resetOutPoint`, the one writer of layer 1 besides the watch).
        unobserveItem()
        observe(item: item, generation: generation)
        armDeadline(generation: generation)
        record("reuse")
        deckRow("reuse", newToken, [
            JSONMember("startSec", Self.secNode(targetStartSec)),
            JSONMember("fromSec", Self.secNode(fromSec)),
            JSONMember("bufferedAheadSec", Self.secNode(bufferedAhead(of: targetStartSec))),
            JSONMember("idleSec", Self.secNode(idleSec)),
            classField
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
        noteLive()
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
            JSONMember("likelyToKeepUp", item.map { JSONNode.bool($0.isPlaybackLikelyToKeepUp) } ?? .null),
            classField
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
        config.after(config.deadlineSec(for: deadlineClass), work)
    }

    private func deadlineFired(generation gen: Int) {
        guard gen == generation, stage == .loading || stage == .gating, let token else { return }
        let afterMs = msSinceLoadStarted()
        let progressed = loadProgressed
        // Where it was stuck, read BEFORE the detach drops the item: the step,
        // what AVFoundation said, how much it had fetched and from where.
        deckRow("deadline", token, [
            JSONMember("afterMs", .number(Double(afterMs))),
            JSONMember("step", .string(gateStep)),
            // NE-38: which deadline ran out (`P13-clip` or `P13-line`).
            classField,
            JSONMember("reuse", .bool(reusedItem)),
            JSONMember("durationKnown", .bool(durationKnown)),
            JSONMember("playerStatus", .string(Self.statusToken(player.status.rawValue))),
            JSONMember("itemStatus", .string(Self.statusToken(item?.status.rawValue))),
            JSONMember("attempts", .number(Double(gateAttempts))),
            JSONMember("targetSec", Self.secNode(targetStartSec)),
            JSONMember("bufferedAheadSec", Self.secNode(bufferedAhead(of: targetStartSec))),
            JSONMember("marks", .object(gateMarks)),
            // §16: whether a retry of this source in the core's answer keeps it.
            JSONMember("progressed", .bool(progressed))
        ] + accessFields() + errorLogFields())
        // Why, as the core's closed token (NE-39n), read while the item and
        // its error log are still attached.
        let cause = Self.fallbackCause(error: nil, log: lastErrorLogEvent(), deadline: true)
        if loadedPreciseTiming && progressed {
            // §16: LAPSED, NOT LOST. The event goes out with the item still
            // attached and the deck reading as failed (no playhead, no play,
            // no seek), so the core sees exactly what it always saw; nothing
            // asynchronous can land meanwhile (this is main, and so is every
            // callback). A same-source retry in the core's turn continues the
            // load and clears `lapsed`; so does any load or unload, which
            // replaces the item itself. Otherwise it is detached as before.
            deadline = nil
            lapsed = (token: token, stage: stage)
            stage = .failed
            record("lapse (deadline)")
            emit(.deadlineExceeded(token: token, afterMs: afterMs, cause: cause))
            guard lapsed != nil else { return }
            lapsed = nil
            if let asset { config.assetFailed(asset) }
            detachItem()
            generation += 1
            record("detach (deadline)")
            player.replaceCurrentItem(with: nil)
            return
        }
        // A hung asset stays hung: the next load of this source gets a new one.
        if let asset { config.assetFailed(asset) }
        // Detach FIRST, and move the generation, so nothing that completes
        // late (a duration, a status, a seek) can preroll or sound: a URL that
        // turns ready at 21 s must not start the wrong thing in the car.
        detachItem()
        generation += 1
        stage = .failed
        record("detach (deadline)")
        player.replaceCurrentItem(with: nil)
        emit(.deadlineExceeded(token: token, afterMs: afterMs, cause: cause))
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
        noteLive()
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
        noteLive()
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
        // A lapsed load (§16) is replaced or dropped with its item.
        lapsed = nil
        deadline?.cancel()
        deadline = nil
        pauseSuspicion?.cancel()
        pauseSuspicion = nil
        unobserveItem()
        if config.cancelsAssetLoading { asset?.cancelLoading() }
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
            // Playing, waiting, or the moment it stopped (an interruption, a
            // route): the item was live up to here.
            noteLive()
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
            self.step(.pause(atSec: self.playheadSec))
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
        noteLive()
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
        let cause = Self.fallbackCause(error: error, log: lastErrorLogEvent(), deadline: false)
        // A failed asset is never retried by AVFoundation: the next load of
        // this source gets a new one.
        if let asset { config.assetFailed(asset) }
        emit(.failed(token: token, message: message, cause: cause))
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
        // It was sounding up to the boundary: live (same-source reuse).
        noteLive()
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
    /// deck is audible toward a boundary (an armed out-point, or the item's
    /// duration when it has none), and only with a standby deck.
    private func rearmPrepareWindow() {
        windowTimer?.cancel()
        windowTimer = nil
        guard !invalidated, token != nil, stage == .ready,
              let delay = DeckPolicy.prefetchWindowDelayMs(
                available: prepareWindowAvailable, outPointSec: watch.outPointSec,
                armed: watch.armed && !watch.fired, paused: !watch.playing, atSec: playheadSec,
                rate: watch.rate, leadSec: EngineConstants.HtmlAudioBackend.prefetchLeadSec,
                alreadyOpened: windowOpened, durationSec: itemDurationSec) else { return }
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

    /// The item's latest error-log event as the two values the fallback's
    /// cause reads (`logStatus`, `logDomain`), or nil when the log is empty.
    private func lastErrorLogEvent() -> (status: Int, domain: String)? {
        guard let event = item?.errorLog()?.events.last else { return nil }
        return (event.errorStatusCode, event.errorDomain)
    }

    /// The `cause=` of the core's `narration kind=fallback` row (NE-39n): the
    /// failure's error and its underlying one, and the error log's last
    /// status and domain, read by the core's pure
    /// `NarrationFallbackCauseReading` into one closed token. The same fields
    /// the `failed` and `deadline` rows print, so a paste can check the
    /// mapping against the row beside it. Every deck failure carries one; the
    /// core writes it only when the failure is a rendered line falling back.
    static func fallbackCause(error: Error?, log: (status: Int, domain: String)?,
                              deadline: Bool) -> Vocabulary.NarrationFallbackCause {
        var errors: [NarrationFallbackCauseReading.Code] = []
        if let error {
            let ns = error as NSError
            errors.append(.init(domain: ns.domain, code: ns.code))
            if let under = ns.userInfo[NSUnderlyingErrorKey] as? NSError {
                errors.append(.init(domain: under.domain, code: under.code))
            }
        }
        return NarrationFallbackCauseReading.cause(errors: errors, logStatus: log?.status,
                                                   logDomain: log?.domain, deadline: deadline)
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
    /// The current load's `class=` (NE-38), on its attach, reuse, ready,
    /// deadline and no-url rows.
    private var classField: JSONMember {
        JSONMember("class", .string(deadlineClass.rawValue))
    }

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
