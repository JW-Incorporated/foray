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
/// every seek, a playhead that drifted from the OS's extrapolation, and every
/// second while the clock runs), and the rate is `NowPlayingRate`. What
/// lives here is only the dictionary:
///
///   - THE DEFAULT RATE NEVER DISAGREES WITH A RUNNING CLOCK.
///     `MPNowPlayingInfoPropertyDefaultPlaybackRate` is the entry's own
///     running rate whenever it has one (1.5 for a clip at the founder's
///     1.5x, 1 for a spoken line, which runs at 1x whatever the listener's
///     speed), and the listener's chosen rate only when the clock stands
///     still (paused, stalled or loading: rate 0). That is the legacy lane's
///     behaviour (ForayAudioPlugin.swift `applyNowPlayingInfo` writes both
///     keys from the same `payload.playbackRate`, the element's real rate),
///     not "always the listener's": a playing entry whose rate differs from
///     its default is what a rate-to-AVRCP mapper may report as a scan
///     rather than play. The native lane had dropped the key, so at 1.5x iOS
///     saw an item playing at 1.5 whose default was 1.0; the two native-era
///     car reports (2026-09-28, 2026-10-06: a plain-Bluetooth head unit's
///     bar stuck at 0 while playing) both lacked it.
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
///   - EVERY ENTRY IS BUILT FRESH, AND ONLY BY A WRITE. Artwork the cache has
///     is attached; artwork that failed or timed out is simply absent, so the
///     key is dropped rather than left showing the previous item's square.
///     Artwork it is still loading is NOT re-posted from here: the publisher
///     keeps no view of the entry (CH3-16; it once held `current` beside the
///     host's `published`, on a second clock, and re-posted it 10 s after a
///     relinquish over the legacy lane's entry, R1-01). A landing is reported
///     through `onArtworkLanded`; the host, the one holder of the entry,
///     rewrites it at the deck's playhead, and after its teardown the hook is
///     nil.
///   - THE ARTWORK OBJECT IS REUSED. The host rewrites a playing entry every
///     second (the car's progress bar, docs/ios-lock-screen.md §3); each of
///     those carries the SAME `MPMediaItemArtwork` for as long as the entry
///     shows the same picture, so neither CarPlay nor a head unit is handed a
///     "new" artwork to fetch and redraw once a second (legacy:
///     `artworkItem(for:)`).
///
/// MAIN-CONFINED, like the host that drives it.
final class NowPlayingPublisher: NowPlayingWriting {
    private let center: NowPlayingInfoCentering
    let artwork: ArtworkCache
    /// The one artwork object the entry shows, for the picture it was built
    /// from: every rewrite of the same picture hands the centre this object.
    private var artworkObject: (src: String, image: UIImage, item: MPMediaItemArtwork)?

    /// The host's: told the source of an artwork that landed after the write
    /// that asked for it (only an image; a failure or a timeout changes
    /// nothing the entry shows). Nil after the host's teardown.
    var onArtworkLanded: ((String) -> Void)?

    init(center: NowPlayingInfoCentering = MPNowPlayingInfoCenter.default(),
         artwork: ArtworkCache = ArtworkCache()) {
        self.center = center
        self.artwork = artwork
    }

    func write(_ view: MediaMapping.SessionView, listenRate: Double) {
        var picture: MPMediaItemArtwork?
        if let src = Self.artworkSource(of: view) {
            switch artwork.lookup(src) {
            case let .image(found):
                picture = artworkItem(src, found)
            case .failed:
                picture = nil
            case .missing:
                artwork.load(src) { [weak self] landed in
                    guard landed != nil else { return }
                    self?.onArtworkLanded?(src)
                }
            }
        }
        center.nowPlayingInfo = Self.info(for: view, artwork: picture, listenRate: listenRate)
    }

    func clear() {
        artworkObject = nil
        center.nowPlayingInfo = nil
    }

    /// The `MPMediaItemArtwork` for `image`: the one already handed out while
    /// the picture is the same, a new one only when it changed.
    func artworkItem(_ src: String, _ image: UIImage) -> MPMediaItemArtwork {
        if let held = artworkObject, held.src == src, held.image === image { return held.item }
        let item = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
        artworkObject = (src, image, item)
        return item
    }

    /// The artwork the entry would show: the first (and only) one
    /// `MediaMapping.artworkList` offers.
    static func artworkSource(of view: MediaMapping.SessionView) -> String? {
        view.metadata.artwork.first?.src
    }

    /// `MPNowPlayingInfoPropertyDefaultPlaybackRate`: the entry's running
    /// rate (`NowPlayingRate.of`) when its clock runs, so a playing entry's
    /// rate and default always agree (a spoken line at 1.5x says 1 and 1);
    /// the listener's rate when it stands still (rate 0: paused, stalled,
    /// loading); 1 when neither is usable (never 0, never NaN).
    static func defaultRate(entryRate: Double, listenRate: Double) -> Double {
        if entryRate.isFinite && entryRate > 0 { return entryRate }
        return listenRate.isFinite && listenRate > 0 ? listenRate : 1
    }

    /// The dictionary, at the playhead the view carries (clamped to the
    /// duration, as before).
    static func info(for view: MediaMapping.SessionView, artwork picture: MPMediaItemArtwork?,
                     listenRate: Double) -> [String: Any] {
        let rate = NowPlayingRate.of(view)
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: view.metadata.title,
            MPMediaItemPropertyArtist: view.metadata.artist,
            MPMediaItemPropertyAlbumTitle: view.metadata.album,
            MPNowPlayingInfoPropertyMediaType: NSNumber(value: MPNowPlayingInfoMediaType.audio.rawValue),
            MPNowPlayingInfoPropertyPlaybackRate: NSNumber(value: rate),
            MPNowPlayingInfoPropertyDefaultPlaybackRate: NSNumber(value: defaultRate(entryRate: rate, listenRate: listenRate))
        ]
        if let position = view.positionState {
            info[MPMediaItemPropertyPlaybackDuration] = NSNumber(value: position.duration)
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = NSNumber(value: Swift.min(position.position, position.duration))
        }
        if let picture {
            info[MPMediaItemPropertyArtwork] = picture
        }
        return info
    }
}
