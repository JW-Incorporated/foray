import Foundation
import AVFoundation

/// One `AVURLAsset` per source, shared by a DeckPair's two decks (card NE-32;
/// docs/native-engine-plan.md §4.1, §14).
///
/// WHY. A Foray is many slices of few episodes: segment 3 and segment 5 can be
/// the same episode with another in between, so the standby deck often loads
/// a source the other deck loaded minutes ago. Sharing the asset means its
/// duration, and whatever AVFoundation already learnt about the file's
/// layout, are loaded once. An `AVURLAsset` may back several
/// `AVPlayerItem`s; each deck still gets its own item, so the two players
/// never share a playhead.
///
/// WHAT IT MUST NOT DO. A shared asset's pending loads are shared too:
/// `cancelLoading()` on it would cancel the OTHER deck's load. So a deck built
/// on this cache runs with `AVDeck.Config.cancelsAssetLoading = false`, and a
/// superseded load is dropped by the deck's generation check instead.
///
/// The key is the URL AND the timing mode (P-7: precise and approximate
/// timing are different assets). Small and least-recently-used: a Foray
/// needs the current source and the next, and holding every source of a
/// 32-segment Foray would hold their buffers too.
final class AssetCache {
    static let defaultCapacity = 4

    private struct Key: Hashable {
        let url: URL
        let precise: Bool
    }

    private let capacity: Int
    private let make: (URL, Bool) -> AVURLAsset
    /// Most recently used last.
    private var entries: [(key: Key, asset: AVURLAsset)] = []

    init(capacity: Int = AssetCache.defaultCapacity,
         make: @escaping (URL, Bool) -> AVURLAsset = AVDeck.defaultAsset) {
        self.capacity = Swift.max(1, capacity)
        self.make = make
    }

    /// The shared asset for this source and timing mode, made on first use.
    func asset(for url: URL, preciseTiming: Bool) -> AVURLAsset {
        dispatchPrecondition(condition: .onQueue(.main))
        let key = Key(url: url, precise: preciseTiming)
        if let at = entries.firstIndex(where: { $0.key == key }) {
            let hit = entries.remove(at: at)
            entries.append(hit)
            return hit.asset
        }
        let asset = make(url, preciseTiming)
        entries.append((key, asset))
        if entries.count > capacity { entries.removeFirst(entries.count - capacity) }
        return asset
    }

    var count: Int { entries.count }

    /// Everything goes (a release, or teardown).
    func removeAll() {
        entries.removeAll()
    }
}
