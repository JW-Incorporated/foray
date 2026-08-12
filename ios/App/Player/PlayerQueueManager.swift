import Foundation
import AVFoundation
import CoreMedia
import MediaPlayer
import ForayKit
import OSLog

// MARK: - PlayableItem
//
// The App-level realization of a session queue entry: a `QueueItemRef`
// (identity + kind, from ForayKit) plus everything needed to
// actually play it locally. Mirrors the session document's item shape
// (docs/brief/02_ARCHITECTURE.md: "ordered items, each: {type: intro_tts |
// episode | transition_tts | outro_tts, asset_url, episode_ref?,
// start_offset?, expected_duration, card}").
//
// `DownloadManager` (not part of this deliverable — see ios/README.md
// "what's stubbed") is responsible for making `localURL` point at an
// already-downloaded file before this item is ever handed to
// `PlayerQueueManager`. Per 04_VOICE_AUDIO_SPEC.md "Everything local before
// play," this manager does not attempt to stream except as an explicit,
// separately-invoked degrade path (not implemented in this scaffold).
public struct PlayableItem: Sendable, Equatable {
    public let ref: QueueItemRef
    public let localURL: URL
    /// Title shown on lock screen / Now Playing. For TTS items this should
    /// already be framed per spec ("Up next: <episode>"), not a generic
    /// "Intro" label.
    public let nowPlayingTitle: String
    public let nowPlayingSubtitle: String?
    public let artworkURL: URL?
    /// Where to start (mid-episode resume). Zero for TTS items and fresh
    /// episode starts.
    public let startOffset: CMTime
    /// Per-show playback rate. Irrelevant for `.tts` items — the state
    /// machine forces 1.0x for those regardless of this value
    /// (05_CORNER_CASES.md #18), so this field is simply ignored by the
    /// manager when `ref.kind == .tts`.
    public let showRate: Float
    public let expectedDuration: CMTime?

    public init(
        ref: QueueItemRef,
        localURL: URL,
        nowPlayingTitle: String,
        nowPlayingSubtitle: String? = nil,
        artworkURL: URL? = nil,
        startOffset: CMTime = .zero,
        showRate: Float = 1.0,
        expectedDuration: CMTime? = nil
    ) {
        self.ref = ref
        self.localURL = localURL
        self.nowPlayingTitle = nowPlayingTitle
        self.nowPlayingSubtitle = nowPlayingSubtitle
        self.artworkURL = artworkURL
        self.startOffset = startOffset
        self.showRate = showRate
        self.expectedDuration = expectedDuration
    }
}

/// Injectable so tests (and cold-launch restore) don't require real disk
/// I/O. Default implementation persists to `UserDefaults` — adequate for a
/// single lightweight (itemID, seconds) pair; swap for a proper local store
/// if position history grows.
public protocol PositionStore: Sendable {
    func savePosition(itemID: String, seconds: Double)
    func loadPosition(itemID: String) -> Double?
}

public struct UserDefaultsPositionStore: PositionStore {
    private let defaults: UserDefaults
    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }
    public func savePosition(itemID: String, seconds: Double) {
        defaults.set(seconds, forKey: "position.\(itemID)")
    }
    public func loadPosition(itemID: String) -> Double? {
        let key = "position.\(itemID)"
        guard defaults.object(forKey: key) != nil else { return nil }
        return defaults.double(forKey: key)
    }
}

// MARK: - PlayerQueueManager
//
// The AVPlayer-backed actor. Owns a SINGLE `PlayerBackend` (in production,
// a single `AVPlayer` wrapped by `AVPlayerBackend`) and drives it entirely
// through `PlayerQueueState.reduce` from ForayKit — this file
// contains no playback *policy*, only the mapping from abstract
// `PlayerEffect`s to real AVFoundation/MediaPlayer calls, and the mapping
// from real AVFoundation/AVAudioSession notifications to abstract
// `PlayerEvent`s. Being an `actor` gives us the serialization the
// single-player invariant (05_CORNER_CASES.md #19) needs "for free" against
// concurrent callers (voice command handler, remote-command-center
// handler, notification callbacks all potentially firing near-simultaneously).
public actor PlayerQueueManager {
    private let backend: PlayerBackend
    private let positionStore: PositionStore
    private let log = Logger(subsystem: "com.wjduvall.foray", category: "PlayerQueueManager")

    private var state: PlayerQueueState = .idle
    private var queue: [PlayableItem] = []

    /// What is actually LOADED. `persistCurrentPosition()` writes against this,
    /// so it must never point at an item we merely intend to load — see
    /// `targetIndex` and the note on `skipToNext()`.
    private var currentIndex: Int = -1

    /// Where an in-flight skip is HEADING, before its load resolves.
    ///
    /// These two were one variable until the JS port (issue #33) exposed the
    /// problem. The reducer emits `.savePosition` BEFORE `.loadItem` on a skip;
    /// if `currentIndex` has already advanced, the outgoing episode's playhead
    /// gets written under the INCOMING episode's id, destroying that episode's
    /// saved resume point before the load reads it. Deferring the advance alone
    /// would then break fast double-skip (both taps would resolve to the same
    /// target), hence a separate cursor rather than simply moving the
    /// assignment later.
    private var targetIndex: Int?

    /// Overrides the next load's start offset. Used by `skipToPrevious()`,
    /// where "restart" must mean zero rather than the offset the item was
    /// built with.
    private var forceNextStartOffset: CMTime?

    /// Where the next queue lookup counts from: an in-flight skip target if
    /// there is one, else what is loaded.
    ///
    /// AUDIT: like the rest of this file, the currentIndex/targetIndex split has
    /// never been through a compiler — `ios-kit` CI builds ForayKit only, not
    /// the App target. The equivalent logic IS compiled and tested in
    /// player/queue-manager.js (issue #33), where the bug was found; port
    /// parity between the two is currently maintained by eye. Re-verify on the
    /// Mac alongside the other AUDIT items before trusting it.
    private var cursor: Int { targetIndex ?? currentIndex }

    /// Route names (e.g. `AVAudioSessionPortDescription.portName`) the user
    /// has confirmed are "my car" — only these get auto-resume-on-reconnect
    /// (04_VOICE_AUDIO_SPEC.md: "auto-resume on car reconnect... default on
    /// for car BT routes only"; 05_CORNER_CASES.md #13). Persisted
    /// elsewhere (Settings); passed in here as a simple set for now.
    private var knownCarRouteNames: Set<String>

    private var interruptionObserverToken: NSObjectProtocol?
    private var routeChangeObserverToken: NSObjectProtocol?
    private var positionPersistenceTask: Task<Void, Never>?

    public init(
        backend: PlayerBackend = AVPlayerBackend(),
        positionStore: PositionStore = UserDefaultsPositionStore(),
        knownCarRouteNames: Set<String> = []
    ) {
        self.backend = backend
        self.positionStore = positionStore
        self.knownCarRouteNames = knownCarRouteNames
    }

    deinit {
        // NSObjectProtocol observer tokens are safe to drop without
        // explicit removal at process exit, but during normal lifecycle
        // `stop()`/`teardown()` should be preferred; this is a safety net.
    }

    // MARK: - Session lifecycle

    /// Replaces the queue. Does not start playback — call `play(itemAt:)`
    /// or `resumeFromColdLaunch()` explicitly.
    public func loadQueue(_ items: [PlayableItem]) {
        queue = items
        currentIndex = -1
        // A skip target or forced offset from the previous queue would index
        // into content that no longer exists.
        targetIndex = nil
        forceNextStartOffset = nil
    }

    /// Starts playback of the item at `index` in the current queue (e.g.
    /// the user tapped a Today card, which maps to its intro_tts item's
    /// index in a freshly-built queue).
    public func play(itemAt index: Int) async {
        guard queue.indices.contains(index) else {
            log.error("play(itemAt:) out of range: \(index) of \(self.queue.count)")
            return
        }
        currentIndex = index
        targetIndex = nil
        configureAudioSessionIfNeeded()
        registerNotificationsIfNeeded()
        startPositionPersistenceTimerIfNeeded()
        await handle(.play(queue[index].ref))
    }

    /// Cold-launch / relaunch restore path (05_CORNER_CASES.md #15): given
    /// the last-known queue + index + saved position (all read from local
    /// storage by the caller BEFORE any network call), primes the player
    /// paused-and-ready without auto-playing, so a background/terminated
    /// relaunch never surprises the user with sudden audio.
    public func restoreColdLaunchState(items: [PlayableItem], index: Int) async {
        queue = items
        guard queue.indices.contains(index) else { return }
        currentIndex = index
        targetIndex = nil
        forceNextStartOffset = nil
        configureAudioSessionIfNeeded()
        registerNotificationsIfNeeded()
        // Land in `.interrupted(wasPlaying: false)` rather than `.playing`
        // — see design note 2 on PlayerQueueState: this state doubles as
        // "paused but ready," which is exactly cold-launch's correct
        // resting state until the user explicitly presses play.
        let ref = queue[index].ref
        let (newState, _) = PlayerQueueState.reduce(state: .idle, event: .play(ref))
        state = newState // .loadingItem
        do {
            try await backend.load(url: queue[index].localURL, startOffset: queue[index].startOffset)
            let (loadedState, _) = PlayerQueueState.reduce(state: state, event: .itemLoaded)
            state = loadedState // .playing — but we haven't called backend.play()
            // Immediately step to paused-but-ready without ever calling
            // backend.play(), by synthesizing an interruption. This keeps
            // the *state value* honest (interrupted/paused-but-ready)
            // without the reducer needing a bespoke "loaded but don't
            // auto-play" event of its own.
            let (pausedState, pausedEffects) = PlayerQueueState.reduce(state: state, event: .interruptionBegan)
            state = pausedState
            await performAll(pausedEffects)
        } catch {
            await handle(.error("cold launch restore failed: \(error)"))
        }
        updateNowPlayingInfo()
    }

    public func stop() async {
        await handle(.stop)
        teardownNotifications()
        positionPersistenceTask?.cancel()
        positionPersistenceTask = nil
        deactivateAudioSession()
    }

    // MARK: - Transport controls (mirror MPRemoteCommandCenter + UI + voice)

    public func pause() async {
        // There is no dedicated "pause" PlayerEvent in the state machine —
        // pausing is modeled as a manually-triggered interruption-like
        // hold, reusing `.interruptionBegan`/`interruptionEnded`. This
        // keeps a single code path for "why are we paused" (system
        // interruption vs. user request) in the reducer, at the cost of
        // slightly overloading `.interrupted`'s telemetry meaning — an
        // acceptable trade for a scaffold; revisit if telemetry needs to
        // distinguish the two cleanly.
        await handle(.interruptionBegan)
    }

    public func resume() async {
        await handle(.interruptionEnded(shouldResume: true))
    }

    public func skipToNext() async {
        // Deliberately does NOT advance `currentIndex` here. The reducer emits
        // `.savePosition` before `.loadItem`, and `persistCurrentPosition()`
        // writes against `currentPlayableItem()` — so advancing first would
        // stamp the incoming episode with the outgoing one's playhead and wipe
        // its saved resume point. `loadItem(_:)` advances once it knows what
        // actually loaded; `targetIndex` keeps fast double-skip working in the
        // meantime.
        let next = nextItem(after: cursor, skippingBridges: true)
        if let next {
            targetIndex = next.index
        }
        await handle(.skipToNext(next?.item.ref))
    }

    public func skipToPrevious() async {
        // Per 04_VOICE_AUDIO_SPEC.md MPRemoteCommandCenter mapping:
        // "prevTrack = restart item / previous." This scaffold always
        // restarts the current item in place (nil target); jumping to a
        // true previous item is a later refinement once "restart vs. go
        // back" UX (typically threshold on elapsed time, mirroring
        // standard podcast-app behavior) is decided — flagged in README.
        //
        // "Restart" has to mean zero. Without this override the reload uses
        // `item.startOffset`, which for an episode the user resumed mid-way is
        // the original resume point — so "restart" would drop them back where
        // they already were rather than at the beginning.
        forceNextStartOffset = CMTime.zero
        await handle(.skipToPrevious(nil))
    }

    // MARK: - Voice / Tier-1 grammar hookup
    //
    // `IntentGrammar.parse` (ForayKit) returns a `ParsedIntent`;
    // routing `.recognized` intents to these transport methods is the
    // VoiceController's job (not implemented in this scaffold — see
    // README). This manager only needs to expose the primitives.

    // MARK: - Core event pump

    private func handle(_ event: PlayerEvent) async {
        let (newState, effects) = PlayerQueueState.reduce(state: state, event: event)
        state = newState
        await performAll(effects)
        updateNowPlayingInfo()
    }

    private func performAll(_ effects: [PlayerEffect]) async {
        for effect in effects {
            await perform(effect)
        }
    }

    private func perform(_ effect: PlayerEffect) async {
        switch effect {
        case .loadItem(let ref):
            await loadItem(ref)

        case .startPlayback:
            backend.play()

        case .pausePlayback:
            backend.pause()

        case .savePosition:
            persistCurrentPosition()

        case .playTransitionTTS:
            await playTransitionBridge()

        case .resetRateForTTS:
            backend.rate = 1.0

        case .restoreRate:
            if let item = currentPlayableItem() {
                backend.rate = item.showRate
            }

        case .emitTelemetry(let message):
            emitTelemetry(message)
        }
    }

    // MARK: - Effect implementations

    private func loadItem(_ ref: QueueItemRef) async {
        guard let item = playableItem(for: ref) else {
            await handle(.error("loadItem: unknown ref \(ref.id)"))
            return
        }
        let startOffset = forceNextStartOffset ?? item.startOffset
        forceNextStartOffset = nil

        // Advance the index HERE, not at the call site — by now `.savePosition`
        // has already run against the outgoing item. `currentIndex` tracks what
        // is loaded, never what we intend to load.
        if let idx = queue.firstIndex(where: { $0.ref == item.ref }) {
            currentIndex = idx
            if targetIndex == idx { targetIndex = nil }   // arrived
        }

        do {
            try await backend.load(url: item.localURL, startOffset: startOffset)
            await handle(.itemLoaded)
        } catch {
            // Degrade path (05_CORNER_CASES.md #6/#10): if the local file
            // is missing (eviction bug, partial download), a from-scratch
            // production implementation would attempt a network stream
            // here before giving up. Not implemented in this scaffold —
            // see README "what's stubbed." For now we surface the error
            // and let the caller (VoiceController/UI) decide whether to
            // advance past this item.
            await handle(.error("loadItem(\(ref.id)) failed: \(error)"))
        }
    }

    /// Handles the `.playTransitionTTS` effect. At this point `state` has
    /// already transitioned to `.transitioning(from:to:)`, where `to` is
    /// the bridge TTS item's own ref (see design note in
    /// PlayerQueueState.swift: "the whole bridge-TTS phase... as one
    /// state"). Loads and plays it directly; the backend's
    /// `onItemDidPlayToEnd` firing while `state` is still `.transitioning`
    /// is what later resolves into the real next episode (see
    /// `handleBackendItemEnded`).
    private func playTransitionBridge() async {
        guard case .transitioning(_, let bridgeRef) = state, let bridgeItem = playableItem(for: bridgeRef) else {
            emitTelemetry("playTransitionTTS.invoked.without.transitioning.state")
            return
        }
        if let idx = queue.firstIndex(where: { $0.ref == bridgeItem.ref }) {
            currentIndex = idx
            if targetIndex == idx { targetIndex = nil }
        }
        do {
            try await backend.load(url: bridgeItem.localURL, startOffset: .zero)
            backend.play()
        } catch {
            // Bridge asset missing/corrupt: never let a missing transition
            // line stall the whole queue. Skip straight to the real next
            // item per 05_CORNER_CASES.md #12 spirit ("never replay
            // episode audio" — by extension, never let a bridge failure
            // block episode audio either).
            emitTelemetry("transitionTTS.loadFailed: \(error)")
            await advancePastTransitionFailure()
        }
    }

    private func advancePastTransitionFailure() async {
        guard let resolved = nextRealItem(afterBridgeAt: cursor) else {
            await handle(.itemEnded(next: nil, bridged: false))
            return
        }
        await handle(.itemEnded(next: resolved.item.ref, bridged: false))
    }

    // MARK: - Backend "item ended" callback wiring

    /// Called by the backend (via `AVPlayerItemDidPlayToEndTime`) whenever
    /// the currently-loaded asset finishes. Resolves what "next" means
    /// given the current state and queue position, then feeds a single
    /// `PlayerEvent.itemEnded` into the reducer.
    private func handleBackendItemEnded() async {
        switch state {
        case .transitioning:
            // The bridge TTS itself just finished; move into the real next
            // item (the one immediately after the bridge in the queue).
            guard let resolved = nextRealItem(afterBridgeAt: cursor) else {
                await handle(.itemEnded(next: nil, bridged: false))
                return
            }
            await handle(.itemEnded(next: resolved.item.ref, bridged: false))

        case .playing:
            guard let resolved = nextItem(after: cursor, skippingBridges: false) else {
                await handle(.itemEnded(next: nil, bridged: false))
                return
            }
            let bridged = resolved.item.ref.kind == .tts
            // Do NOT advance `currentIndex` yet when bridged — the bridge
            // item itself isn't "the next real item" for UI purposes;
            // `handleBackendItemEnded`'s `.transitioning` branch above
            // advances past it once the bridge finishes. We do still need
            // `currentIndex` to point at the bridge for `playTransitionBridge()`
            // to resolve it via `playableItem(for:)`, so advance to it
            // regardless — the distinction is only about *which* index
            // counts as "the current episode" for Now Playing purposes,
            // which `currentPlayableItem()`'s callers should treat
            // specially during `.transitioning` (show `to`'s "up next"
            // framing, not the bridge item's raw title).
            await handle(.itemEnded(next: resolved.item.ref, bridged: bridged))

        case .idle, .loadingItem, .interrupted, .ended:
            // Stray callback with nothing meaningfully playing; ignore.
            emitTelemetry("backend.itemEnded.ignored.state=\(state)")
        }
    }

    // MARK: - Queue lookups

    private func playableItem(for ref: QueueItemRef) -> PlayableItem? {
        queue.first { $0.ref == ref }
    }

    private func currentPlayableItem() -> PlayableItem? {
        guard queue.indices.contains(currentIndex) else { return nil }
        return queue[currentIndex]
    }

    private struct IndexedItem {
        let index: Int
        let item: PlayableItem
    }

    /// Plain "next array element" lookup, used both by manual skip (which
    /// should skip straight over any bridge) and by natural item-end
    /// resolution (which needs to know whether the very next element is
    /// itself a bridge).
    private func nextItem(after index: Int, skippingBridges: Bool) -> IndexedItem? {
        var candidate = index + 1
        while queue.indices.contains(candidate) {
            let item = queue[candidate]
            if skippingBridges && item.ref.kind == .tts {
                candidate += 1
                continue
            }
            return IndexedItem(index: candidate, item: item)
        }
        return nil
    }

    /// After a bridge item at `bridgeIndex` finishes, find the next
    /// non-bridge (real content) item.
    private func nextRealItem(afterBridgeAt bridgeIndex: Int) -> IndexedItem? {
        nextItem(after: bridgeIndex, skippingBridges: true)
    }

    // MARK: - Position persistence
    //
    // 04_VOICE_AUDIO_SPEC.md "Position persistence": every 15s AND on every
    // pause/interruption/route-change/skip. The event-driven half is
    // handled by the `.savePosition` effect in `perform(_:)`; this timer
    // covers the periodic half.

    private func startPositionPersistenceTimerIfNeeded() {
        guard positionPersistenceTask == nil else { return }
        positionPersistenceTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                guard let self else { return }
                await self.persistCurrentPositionIfPlaying()
            }
        }
    }

    private func persistCurrentPositionIfPlaying() {
        guard case .playing = state else { return }
        persistCurrentPosition()
    }

    private func persistCurrentPosition() {
        guard let item = currentPlayableItem() else { return }
        let seconds = CMTimeGetSeconds(backend.currentTime)
        guard seconds.isFinite else { return }
        positionStore.savePosition(itemID: item.ref.id, seconds: seconds)
    }

    // MARK: - Telemetry

    private func emitTelemetry(_ message: String) {
        // AUDIT: this scaffold logs locally only. Per
        // docs/brief/01_PROMPT.md hard constraint #8 and
        // 02_ARCHITECTURE.md's `events` table, telemetry should also be
        // queued into the local event-batch store and synced to
        // `POST /events` — that sync path is Sync's responsibility (not
        // part of this deliverable) and should subscribe to these
        // messages rather than this method logging directly to os.log.
        log.info("telemetry: \(message, privacy: .public)")
    }

    // MARK: - AVAudioSession configuration

    private var audioSessionConfigured = false

    private func configureAudioSessionIfNeeded() {
        guard !audioSessionConfigured else { return }
        audioSessionConfigured = true
        let session = AVAudioSession.sharedInstance()
        do {
            // AUDIT: category `.playback`, mode `.spokenAudio` per
            // 04_VOICE_AUDIO_SPEC.md. Confirm on-device that `.spokenAudio`
            // mode's "smart handling for speech content" doesn't introduce
            // any unwanted dynamics processing/compression audible on
            // music-adjacent comedy/hang episodes — the spec calls this
            // mode out specifically for podcasts, but our content mix
            // includes music-bed intros on some shows.
            try session.setCategory(.playback, mode: .spokenAudio, options: [])
            try session.setActive(true, options: [])
        } catch {
            log.error("AVAudioSession configuration failed: \(String(describing: error))")
        }
    }

    private func deactivateAudioSession() {
        guard audioSessionConfigured else { return }
        audioSessionConfigured = false
        do {
            // AUDIT: `.notifyOthersOnDeactivation` — confirm this is
            // desired here (it lets other apps' audio duck back up
            // immediately) vs. omitting it; test with a navigation app
            // active concurrently.
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            log.error("AVAudioSession deactivation failed: \(String(describing: error))")
        }
    }

    // MARK: - Interruption / route-change notifications

    private func registerNotificationsIfNeeded() {
        guard interruptionObserverToken == nil else { return }

        interruptionObserverToken = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: nil
        ) { [weak self] notification in
            guard let self else { return }
            Task { await self.handleInterruptionNotification(notification) }
        }

        routeChangeObserverToken = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: AVAudioSession.sharedInstance(),
            queue: nil
        ) { [weak self] notification in
            guard let self else { return }
            Task { await self.handleRouteChangeNotification(notification) }
        }

        if let avPlayerBackend = backend as? AVPlayerBackend {
            avPlayerBackend.onItemDidPlayToEnd = { [weak self] in
                guard let self else { return }
                Task { await self.handleBackendItemEnded() }
            }
        }
    }

    private func teardownNotifications() {
        if let token = interruptionObserverToken {
            NotificationCenter.default.removeObserver(token)
        }
        if let token = routeChangeObserverToken {
            NotificationCenter.default.removeObserver(token)
        }
        interruptionObserverToken = nil
        routeChangeObserverToken = nil
    }

    // AUDIT: The whole block below (userInfo key parsing for both
    // notifications) is the highest-risk area flagged by
    // 04_VOICE_AUDIO_SPEC.md ("Category switching is the #1 glitch risk")
    // and 05_CORNER_CASES.md #11-13. The key names and enum raw-value
    // semantics below match current public AVFoundation API as of recent
    // SDKs, but MUST be re-verified against the actual Xcode 16 /
    // iOS 17 SDK headers on the Mac — this is exactly the kind of code
    // that silently compiles wrong (a key typo just means `nil` from the
    // dictionary, not a compile error) and must be exercised against a
    // real phone call and a real Bluetooth disconnect (M0 acceptance
    // criteria) before being trusted.

    private func handleInterruptionNotification(_ notification: Notification) async {
        guard
            let userInfo = notification.userInfo,
            let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: typeValue)
        else { return }

        switch type {
        case .began:
            await handle(.interruptionBegan)

        case .ended:
            var shouldResume = false
            if let optionsValue = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt {
                let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
                shouldResume = options.contains(.shouldResume)
            }
            // AUDIT (05_CORNER_CASES.md #11): "20-min call: session may be
            // deactivated by the OS — reactivate cleanly." Confirm whether
            // `setActive(true)` here is necessary/sufficient after a long
            // interruption, or whether the system reactivates the session
            // automatically before delivering `.ended`. Reactivating
            // unconditionally is defensive but could itself throw if the
            // session is in a state that disallows it — the do/catch below
            // swallows that on purpose so a reactivation hiccup never
            // crashes the interruption handler, but the swallowed error
            // should be surfaced as telemetry once the events-sync path
            // exists.
            if shouldResume {
                do {
                    try AVAudioSession.sharedInstance().setActive(true, options: [])
                } catch {
                    log.error("Reactivation after interruption failed: \(String(describing: error))")
                }
            }
            await handle(.interruptionEnded(shouldResume: shouldResume))

        @unknown default:
            break
        }
    }

    private func handleRouteChangeNotification(_ notification: Notification) async {
        guard
            let userInfo = notification.userInfo,
            let reasonValue = userInfo[AVAudioSessionRouteChangeReasonKey] as? UInt,
            let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue)
        else { return }

        switch reason {
        case .oldDeviceUnavailable:
            await handle(.routeChanged(oldDeviceUnavailable: true))

        case .newDeviceAvailable:
            await handle(.routeChanged(oldDeviceUnavailable: false))
            await maybeAutoResumeForKnownCarRoute()

        default:
            // AUDIT: other reasons (.categoryChange, .override,
            // .wakeFromSleep, .noSuitableRouteForCategory,
            // .routeConfigurationChange) intentionally not modeled as
            // player events yet. `.routeConfigurationChange` in particular
            // can fire during hold-to-talk category switching
            // (.playback <-> .playAndRecord) — confirm it never spuriously
            // triggers unwanted pause behavior once VoiceController exists.
            break
        }
    }

    /// 05_CORNER_CASES.md #13: "auto-resume on car reconnect only for
    /// routes previously classified as car." Only fires when we are
    /// currently paused-but-ready (`.interrupted`) from a route loss, not
    /// from an unrelated pause.
    private func maybeAutoResumeForKnownCarRoute() async {
        guard case .interrupted(let item, _) = state else { return }
        let currentRoute = AVAudioSession.sharedInstance().currentRoute
        let outputNames = Set(currentRoute.outputs.map(\.portName))
        guard !knownCarRouteNames.isDisjoint(with: outputNames) else { return }
        await handle(.play(item))
    }

    // MARK: - MPNowPlayingInfoCenter / MPRemoteCommandCenter

    private var remoteCommandsConfigured = false

    /// Call once, early (e.g. from `ForayApp.init`), independent of
    /// queue/session state — MPRemoteCommandCenter handlers must exist
    /// before the app is ever backgrounded/locked, and per
    /// 05_CORNER_CASES.md #23 must also work from a cold Siri-intent
    /// launch.
    public func configureRemoteCommands() {
        guard !remoteCommandsConfigured else { return }
        remoteCommandsConfigured = true
        let center = MPRemoteCommandCenter.shared()

        // AUDIT: MPRemoteCommandCenter handler closures are synchronous
        // and must return an `MPRemoteCommandHandlerStatus` immediately;
        // they cannot `await` this actor's methods directly. Spawning a
        // detached `Task` and returning `.success` optimistically matches
        // the <1s latency budget in the common case, but does NOT reflect
        // the *actual* outcome back to the command center/lock-screen UI
        // if `handle(_:)` ends up failing (e.g. load error). Verify this
        // is an acceptable UX on real lock-screen/steering-wheel hardware;
        // if not, consider a synchronous fast-path status cache this
        // closure can read without awaiting.
        center.playCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            Task { await self.resume() }
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            Task { await self.pause() }
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            Task { await self.skipToNext() }
            return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            Task { await self.skipToPrevious() }
            return .success
        }

        // AUDIT: ±30/15s seek per spec ("MPRemoteCommandCenter: play/pause,
        // ±30/15 s seek"). `MPSkipIntervalCommand.preferredIntervals`
        // expects `NSNumber` seconds; confirm whether both skip-forward
        // (30s) and skip-backward (15s) should be registered, or whether
        // this is meant as alternatives depending on control surface —
        // spec text is ambiguous ("±30/15s") and should be confirmed with
        // the user (taste/UX call) before shipping.
        center.skipForwardCommand.preferredIntervals = [30]
        center.skipForwardCommand.addTarget { [weak self] event in
            guard let self, let skipEvent = event as? MPSkipIntervalCommandEvent else { return .commandFailed }
            Task { await self.seekRelative(seconds: skipEvent.interval) }
            return .success
        }
        center.skipBackwardCommand.preferredIntervals = [15]
        center.skipBackwardCommand.addTarget { [weak self] event in
            guard let self, let skipEvent = event as? MPSkipIntervalCommandEvent else { return .commandFailed }
            Task { await self.seekRelative(seconds: -skipEvent.interval) }
            return .success
        }
    }

    /// Relative seek within the current item (not modeled as a
    /// PlayerQueueState event — it doesn't change queue state, only
    /// position). Implemented directly against the backend.
    private func seekRelative(seconds: TimeInterval) async {
        guard case .playing = state else { return }
        let current = CMTimeGetSeconds(backend.currentTime)
        guard current.isFinite else { return }
        var target = max(0, current + seconds)
        // AUDIT: clamp against item duration when known, so +30s near the
        // end of an item doesn't seek past EOF in a way that confuses the
        // "did it end naturally" callback. `currentDuration` can be nil
        // briefly after load; when unknown we trust AVPlayer's own
        // clamping — confirm that assumption on device.
        if let duration = backend.currentDuration, duration.isNumeric {
            target = min(target, CMTimeGetSeconds(duration))
        }
        await backend.seek(to: CMTime(seconds: target, preferredTimescale: 600))
    }

    private func updateNowPlayingInfo() {
        let center = MPNowPlayingInfoCenter.default()
        guard let item = currentPlayableItem() else {
            center.nowPlayingInfo = nil
            return
        }

        var info: [String: Any] = [
            MPMediaItemPropertyTitle: item.nowPlayingTitle,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: CMTimeGetSeconds(backend.currentTime),
            MPNowPlayingInfoPropertyPlaybackRate: backend.rate
        ]
        if let subtitle = item.nowPlayingSubtitle {
            info[MPMediaItemPropertyArtist] = subtitle
        }
        if let duration = item.expectedDuration {
            info[MPMediaItemPropertyPlaybackDuration] = CMTimeGetSeconds(duration)
        }
        // AUDIT: artwork loading (`MPMediaItemArtwork(boundsSize:requestHandler:)`)
        // needs a `UIImage` fetched/cached from `item.artworkURL` — not
        // implemented in this scaffold (would need an image cache, ideally
        // shared with SwiftUI's AsyncImage usage in TodayView/NowPlayingView).
        center.nowPlayingInfo = info
    }
}
