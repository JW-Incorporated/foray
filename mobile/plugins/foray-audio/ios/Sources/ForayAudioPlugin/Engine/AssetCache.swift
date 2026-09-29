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
/// WHAT A COLD LOAD MUST STILL GET: A FRESH ASSET (NE-37c review). The M1 car
/// test (build 2026092706, HUMAN-ACTIONS #114) proved the path where every
/// load after a long pause is cold: a new asset, a new connection, a new
/// redirect. AVDeck's same-source rule (#866) keeps a held item only up to
/// `AVDeck.defaultReuseMaxIdleSec`, because an item that old may have lost
/// its connection and its signed redirect behind a `.readyToPlay` status; a
/// cache that handed the cold load the SAME hours-old asset would undo that.
/// And an asset whose load failed or hung stays that way (AVFoundation does
/// not retry a key that failed), so a retry would fail again at once, or hang
/// to the next deadline. So an entry is reused only while it is fresh (used
/// within `maxIdleSec`, on a clock that runs while the phone sleeps) and its
/// duration has not failed; a deck forgets the asset of a load that failed or
/// passed its deadline (`forget`).
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

    private struct Entry {
        let key: Key
        let asset: AVURLAsset
        /// `clockMs()` when the entry was last handed out.
        var usedMs: Double
    }

    private let capacity: Int
    private let maxIdleSec: Double
    private let clockMs: () -> Double
    private let make: (URL, Bool) -> AVURLAsset
    /// Most recently used last.
    private var entries: [Entry] = []

    init(capacity: Int = AssetCache.defaultCapacity,
         maxIdleSec: Double = AVDeck.defaultReuseMaxIdleSec,
         clockMs: @escaping () -> Double = AVDeck.continuousMs,
         make: @escaping (URL, Bool) -> AVURLAsset = AVDeck.defaultAsset) {
        self.capacity = Swift.max(1, capacity)
        self.maxIdleSec = maxIdleSec
        self.clockMs = clockMs
        self.make = make
    }

    /// The shared asset for this source and timing mode: the held one while
    /// it is fresh and has not failed, else a new one made now.
    func asset(for url: URL, preciseTiming: Bool) -> AVURLAsset {
        dispatchPrecondition(condition: .onQueue(.main))
        let key = Key(url: url, precise: preciseTiming)
        let now = clockMs()
        if let at = entries.firstIndex(where: { $0.key == key }) {
            let hit = entries.remove(at: at)
            if Self.reusable(hit.asset, idleSec: Swift.max(0, now - hit.usedMs) / 1000, maxIdleSec: maxIdleSec) {
                entries.append(Entry(key: key, asset: hit.asset, usedMs: now))
                return hit.asset
            }
        }
        let asset = make(url, preciseTiming)
        entries.append(Entry(key: key, asset: asset, usedMs: now))
        if entries.count > capacity { entries.removeFirst(entries.count - capacity) }
        return asset
    }

    /// A held asset may serve another load: used recently, and its duration
    /// not failed or cancelled (a key in either state is never retried).
    static func reusable(_ asset: AVURLAsset, idleSec: Double, maxIdleSec: Double) -> Bool {
        guard idleSec <= maxIdleSec else { return false }
        switch asset.statusOfValue(forKey: "duration", error: nil) {
        case .failed, .cancelled: return false
        default: return true
        }
    }

    /// A load on this asset failed or passed its deadline: the next load of
    /// its source gets a new one. By identity, so an entry already replaced
    /// is left alone.
    func forget(_ asset: AVURLAsset) {
        dispatchPrecondition(condition: .onQueue(.main))
        entries.removeAll { $0.asset === asset }
    }

    var count: Int { entries.count }

    /// Everything goes (a release, or teardown).
    func removeAll() {
        entries.removeAll()
    }
}
