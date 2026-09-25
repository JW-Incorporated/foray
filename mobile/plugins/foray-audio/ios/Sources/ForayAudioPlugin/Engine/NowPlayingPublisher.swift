import Foundation
import MediaPlayer
import UIKit
import ForayEngineCore

/// The part of `MPNowPlayingInfoCenter` the publisher touches. The real
/// centre conforms below; a test can hand the publisher a dictionary.
protocol NowPlayingInfoCentering: AnyObject {
    var nowPlayingInfo: [String: Any]? { get set }
}

extension MPNowPlayingInfoCenter: NowPlayingInfoCentering {}

/// The real `NowPlayingWriting` (card NE-18; docs/native-engine-plan.md
/// §4.5): `MediaMapping`'s `SessionView` as an `MPNowPlayingInfoCenter`
/// entry.
///
/// It decides NOTHING about what the entry says or when it is written. The
/// words are `MediaMapping.metadata` (fixture-pinned against
/// player/media-session.js), the moment is the host's (every transition,
/// every seek, and a playhead that drifted from the OS's extrapolation), and
/// the rate is `NowPlayingRate`. What lives here is only the dictionary:
///
///   - RATE 0 WHEN NOT PLAYING, AND `playbackState` IS NEVER WRITTEN (OQ-8).
///     Apple documents `playbackState` as macOS-only; on iOS what makes a
///     paused entry read as paused, and what keeps 4a the Now Playing app
///     across a pause, is `MPNowPlayingInfoPropertyPlaybackRate == 0` with
///     every other field intact. A stall writes 0 too (p-car-8).
///   - NOTHING IS CLEARED BUT BY `clear()`. A pause, an unresumed
///     interruption and a relinquish all leave the entry (the host never
///     calls `clear()` for them); `clear()` is a finished Foray, a close or a
///     data deletion. The car baseline (docs/field-records/2026-09-24-car-
///     baseline.md) is why: iOS hands a car's play to the app whose entry and
///     session it last saw playing.
///   - EVERY ENTRY IS BUILT FRESH. Artwork the cache has is attached; artwork
///     it is still loading is attached when it lands (if the entry is still
///     on it); artwork that failed or timed out is simply absent, so the key
///     is dropped rather than left showing the previous item's square.
///
/// MAIN-CONFINED, like the host that drives it.
final class NowPlayingPublisher: NowPlayingWriting {
    private let center: NowPlayingInfoCentering
    let artwork: ArtworkCache
    /// Monotonic seconds, for the playhead an artwork re-post carries.
    private let uptime: () -> Double

    /// The entry last written and when (`uptime`), nil after `clear()`.
    private var current: (view: MediaMapping.SessionView, at: Double)?

    init(center: NowPlayingInfoCentering = MPNowPlayingInfoCenter.default(),
         artwork: ArtworkCache = ArtworkCache(),
         uptime: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime }) {
        self.center = center
        self.artwork = artwork
        self.uptime = uptime
    }

    func write(_ view: MediaMapping.SessionView) {
        current = (view, uptime())
        var image: UIImage?
        if let src = Self.artworkSource(of: view) {
            switch artwork.lookup(src) {
            case let .image(found):
                image = found
            case .failed:
                image = nil
            case .missing:
                artwork.load(src) { [weak self] landed in self?.artworkLanded(src, landed) }
            }
        }
        center.nowPlayingInfo = Self.info(for: view, artwork: image)
    }

    func clear() {
        current = nil
        center.nowPlayingInfo = nil
    }

    /// The artwork the entry would show: the first (and only) one
    /// `MediaMapping.artworkList` offers.
    static func artworkSource(of view: MediaMapping.SessionView) -> String? {
        view.metadata.artwork.first?.src
    }

    /// An artwork load finished. Re-posted only when it found an image and
    /// the entry still names that artwork; the playhead is carried forward
    /// by the time since the write at the entry's own rate, so attaching a
    /// picture never jumps the scrubber back.
    private func artworkLanded(_ src: String, _ image: UIImage?) {
        guard let image, let current, Self.artworkSource(of: current.view) == src else { return }
        let elapsed = Swift.max(0, uptime() - current.at)
        center.nowPlayingInfo = Self.info(for: current.view, artwork: image, advancedBySec: elapsed)
    }

    /// The dictionary. `advancedBySec` moves the playhead on at the entry's
    /// rate (clamped to the duration), for a re-post of an entry written
    /// earlier.
    static func info(for view: MediaMapping.SessionView, artwork image: UIImage?,
                     advancedBySec: Double = 0) -> [String: Any] {
        let rate = NowPlayingRate.of(view)
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: view.metadata.title,
            MPMediaItemPropertyArtist: view.metadata.artist,
            MPMediaItemPropertyAlbumTitle: view.metadata.album,
            MPNowPlayingInfoPropertyMediaType: NSNumber(value: MPNowPlayingInfoMediaType.audio.rawValue),
            MPNowPlayingInfoPropertyPlaybackRate: NSNumber(value: rate)
        ]
        if let position = view.positionState {
            let elapsed = Swift.min(position.position + advancedBySec * rate, position.duration)
            info[MPMediaItemPropertyPlaybackDuration] = NSNumber(value: position.duration)
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = NSNumber(value: elapsed)
        }
        if let image {
            info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
        }
        return info
    }
}
