import Foundation
import AVFoundation
import CoreMedia

// MARK: - PlayerBackend
//
// Thin protocol wrapping the handful of AVPlayer operations
// PlayerQueueManager needs. This exists purely so PlayerQueueManager's
// orchestration logic (which effect -> which backend call, in what order)
// can be exercised in tests with a fake/mock backend, without touching
// AVFoundation or a real audio session. The actual state-machine logic this
// wraps around lives in ForayKit and is already fully unit tested
// without AVFoundation; this protocol boundary is for testing the *glue*.
//
// Deliberately synchronous/void where AVPlayer itself is synchronous
// (`play()`, `pause()`, `rate =`), and `async throws` only where loading an
// asset genuinely involves asynchronous work (`load(url:)`).
public protocol PlayerBackend: AnyObject, Sendable {
    /// Prepares playback of the local (or, in the degrade path, remote)
    /// file at `url`, seeking to `startOffset` before it's ready to play.
    /// Throws if the asset can't be loaded (missing file, corrupt asset,
    /// etc.) — the caller maps that to `PlayerEvent.error`.
    func load(url: URL, startOffset: CMTime) async throws

    /// Relocates playback position within the currently-loaded item
    /// without reloading the asset. Used for MPRemoteCommandCenter
    /// ±30/15s skip and any future scrub-bar UI. No-op if nothing is
    /// loaded.
    func seek(to time: CMTime) async

    func play()
    func pause()

    /// Playback rate. Setting this while paused is safe (AVPlayer applies
    /// it on next `play()`); PlayerQueueManager always sets rate before
    /// calling `play()` for a given item so this ordering isn't load-bearing
    /// here, but IS load-bearing in the real AVPlayer backend — see the
    /// AUDIT note on `AVPlayerBackend.rate`.
    var rate: Float { get set }

    /// Current playback position of the active item, or `.zero` if nothing
    /// is loaded. Used for the 15s position-persistence tick.
    var currentTime: CMTime { get }

    /// Total duration of the active item, if known yet (AVPlayerItem's
    /// duration can be indefinite/unknown briefly after load starts).
    var currentDuration: CMTime? { get }

    /// Fired when the currently-loaded item finishes playing on its own
    /// (`AVPlayerItemDidPlayToEndTime` in the real backend). `PlayerQueueManager`
    /// sets this once, in `registerNotificationsIfNeeded()`, and translates it
    /// into `PlayerEvent.itemEnded`. Part of the protocol (not just
    /// `AVPlayerBackend`) so a fake backend used in tests can simulate an item
    /// ending without `PlayerQueueManager` needing to downcast to a concrete
    /// type — a downcast would silently no-op this wiring for any other
    /// `PlayerBackend` conformer, fake or otherwise.
    var onItemDidPlayToEnd: (@Sendable () -> Void)? { get set }
}

/// Real AVPlayer-backed implementation. Owns exactly ONE `AVPlayer`
/// instance for the app's lifetime and swaps `AVPlayerItem`s on it — this
/// is the concrete embodiment of the "single-player invariant"
/// (05_CORNER_CASES.md #19) that `PlayerQueueState`'s reducer already
/// guards at the state-machine level.
// AUDIT: `@unchecked Sendable` here is a deliberate, narrow promise: this
// class's mutable state (`player`, `itemEndObserver`) is only ever touched
// from methods called by `PlayerQueueManager`, which is itself an actor and
// therefore serializes all access. That invariant holds as long as nothing
// else ever holds a reference to an `AVPlayerBackend` and calls into it
// directly. Confirm on real hardware that AVPlayer's own internal callbacks
// (KVO, notification delivery) that we bridge via `onItemDidPlayToEnd`
// don't reenter this instance from a background thread in a way that races
// with actor-issued calls.
public final class AVPlayerBackend: PlayerBackend, @unchecked Sendable {
    private let player: AVPlayer
    private var itemEndObserver: NSObjectProtocol?

    /// Fired when the currently-loaded item reaches its end
    /// (`AVPlayerItemDidPlayToEndTime`). PlayerQueueManager sets this once
    /// and translates it into `PlayerEvent.itemEnded`.
    public var onItemDidPlayToEnd: (@Sendable () -> Void)?

    public init() {
        // AUDIT: confirm on-device that a single long-lived AVPlayer
        // (rather than a fresh AVPlayer per item) doesn't accumulate any
        // internal state across `replaceCurrentItem` calls that causes
        // audible artifacts on rapid item swaps (fast skip). Apple's docs
        // recommend reusing one AVPlayer and swapping items via
        // `replaceCurrentItem(with:)`, which is what we do below, but the
        // "no pops on swap" acceptance criterion (M0 spike) must be
        // verified in the real car, not just in a simulator.
        self.player = AVPlayer()
        // AUDIT: `automaticallyWaitsToMinimizeStalling = true` is the
        // default and is usually right for network streaming, but for
        // predownloaded local files (our normal case) it can introduce a
        // small extra buffering delay before `play()` actually produces
        // sound. Verify whether setting this to `false` measurably helps
        // hit the <1.5s tap-to-audio budget for local files; if so, flip
        // it only when the item's URL is `file://`.
        self.player.automaticallyWaitsToMinimizeStalling = true
    }

    public func load(url: URL, startOffset: CMTime) async throws {
        removeItemEndObserver()

        let asset = AVURLAsset(url: url)
        // AUDIT: `AVURLAsset.load(.isPlayable)` (the modern async property
        // loading API) vs. the older `asset.isPlayable` synchronous
        // property — confirm the exact async-properties API surface
        // available at the deployment target (iOS 17) and that this call
        // is the correct spelling; the async property-loading API changed
        // shape across recent SDK versions and needs a real Xcode to
        // typecheck.
        let isPlayable = try await asset.load(.isPlayable)
        guard isPlayable else {
            throw PlayerBackendError.assetNotPlayable(url)
        }

        let item = AVPlayerItem(asset: asset)
        player.replaceCurrentItem(with: item)

        if startOffset > .zero {
            // AUDIT: `seek(to:toleranceBefore:toleranceAfter:)` with zero
            // tolerances forces frame-accurate seeking, which is slower;
            // for resuming mid-episode a small tolerance (e.g. a few
            // hundred ms) is almost certainly fine and faster. Confirm the
            // <1.5s tap-to-audio budget is met with this seek included, on
            // device, for a multi-hour episode file.
            //
            // AUDIT: the `async -> Bool` overload of `AVPlayerItem.seek`
            // (vs. the older completion-handler-based
            // `seek(to:toleranceBefore:toleranceAfter:completionHandler:)`)
            // is assumed available at the iOS 17 deployment target. This
            // file has never been compiled — verify the exact overload set
            // in Xcode and that the discarded `Bool` return (did the seek
            // finish, vs. get superseded by a later seek) doesn't need
            // handling for our use case.
            await item.seek(to: startOffset, toleranceBefore: .zero, toleranceAfter: .zero)
        }

        itemEndObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self] _ in
            self?.onItemDidPlayToEnd?()
        }
    }

    public func seek(to time: CMTime) async {
        guard let item = player.currentItem else { return }
        // AUDIT: zero tolerance forces frame-accurate seeking (slower);
        // for a ±30/15s remote-command skip, a small tolerance is almost
        // certainly imperceptible and faster — same trade-off as the seek
        // in `load(url:startOffset:)` above. Measure on device.
        await item.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero)
    }

    public func play() {
        player.play()
    }

    public func pause() {
        player.pause()
    }

    public var rate: Float {
        get { player.rate }
        set {
            // AUDIT: setting `player.rate` directly both sets the rate AND
            // starts playback (a non-zero rate assignment on AVPlayer
            // plays). PlayerQueueManager must be careful about *when* it
            // sets `rate` relative to the `.startPlayback` effect so we
            // don't double-trigger playback or, worse, start playback at
            // the wrong (stale per-show) rate for a fraction of a second
            // before the TTS-specific 1.0x rate is applied — confirm the
            // actual sequencing on device (05_CORNER_CASES.md #18).
            player.rate = newValue
        }
    }

    public var currentTime: CMTime {
        player.currentItem?.currentTime() ?? .zero
    }

    public var currentDuration: CMTime? {
        guard let duration = player.currentItem?.duration, duration.isNumeric else {
            return nil
        }
        return duration
    }

    private func removeItemEndObserver() {
        if let itemEndObserver {
            NotificationCenter.default.removeObserver(itemEndObserver)
        }
        itemEndObserver = nil
    }

    deinit {
        removeItemEndObserver()
    }
}

public enum PlayerBackendError: Error {
    case assetNotPlayable(URL)
}
