import Foundation
import UIKit

/// Now Playing's artwork: the ONE loader, for both lanes (CH3-21). The
/// native lane's NowPlayingPublisher (card NE-18; docs/native-engine-plan.md
/// §4.5) uses one confined to main; the legacy lane's
/// `ForayAudioPlugin.artworkItem(for:)` uses one confined to its `stateQueue`.
///
/// ── THE RULES, AND WHY EACH ONE ────────────────────────────────────────────
///
///   - HTTPS OR BUNDLED ONLY. `MediaMapping.artworkUrl` has already gated the
///     page's URL (https, a `data:image/` URI, or a relative path). Here a
///     relative path is our own icon in the app bundle's `public/` (where
///     Capacitor copies the web assets), an `https:` URL is a publisher's
///     square, and everything else, `data:` included, has no artwork: a
///     `data:` URI on the lock screen is an image the page could make of
///     anything, and nothing the engine shows ever needs one. (The legacy
///     lane's `bundle://public/<path>` is stripped to `<path>` by its caller;
///     a `data:` or `file:` URI gets no artwork there either.)
///   - OFF THE CALLER'S QUEUE. The network fetch runs on URLSession's queue,
///     the bundle read and every decode on a utility queue; only the finished
///     `UIImage` comes back to the cache's queue. The engine is main-confined
///     (plan §4.2), the legacy lane's remote-command handlers share its
///     `stateQueue`, and a car's press must never wait behind an image.
///   - BOUNDED AT 10 s, WHOLE. `URLRequest.timeoutInterval` bounds the gaps
///     between packets, not the fetch, so a trickling server could hold one
///     open for a minute. A deadline on the cache's queue settles the load at
///     10 s whatever the transfer is doing, and cancels it.
///   - CACHED, AND A FAILURE IS A RETRY TIME. A re-write of an unchanged
///     entry (every seek, every state change, the 1 s refresh) must not fetch
///     again (the legacy lane's 2026-09-23 lesson: an uncached artwork fetch
///     sat in front of the car's play). A failed or timed-out NETWORK load is
///     "no artwork" for `retryAfterSec` and then may be tried again by the
///     next write (audit round 3, mobile-native-6): a dead URL costs one
///     attempt per window, not one per write, and a fetch that timed out in a
///     dead zone as the car connected does not leave CarPlay bare for the
///     rest of the item. An unsupported source or a bundled file that is not
///     there is an answer, not a failure, and is never tried again. A key
///     with no artwork is dropped (the entry is built fresh), never left
///     showing the previous item's square.
///   - NOT FOR NARRATION. A narration line's metadata already carries only
///     our icon (`MediaMapping.metadata`: "a narration line is ours"), so no
///     publisher's artwork can reach this cache for one.
///
/// CONFINED TO ITS QUEUE: every method is called on `queue` (main for the
/// engine, whose publisher the host drives on main; the legacy plugin's
/// serial `stateQueue` for its lane), and every completion and the deadline
/// are delivered there.
final class ArtworkCache {
    /// Where an artwork source is read from.
    enum Source: Equatable {
        case remote(URL)
        /// A path relative to the bundle's `public/`.
        case bundled(String)
    }

    /// What the cache knows about a source right now.
    enum Lookup {
        case image(UIImage)
        /// Unsupported, failed or timed out: no artwork for this key.
        case failed
        /// Never asked for, or a load in flight.
        case missing
    }

    /// Fetch `url` within `timeoutSec`, calling `done` once, on any thread,
    /// with the body of a 2xx answer or nil. Returns a cancel handle.
    typealias Fetcher = (_ url: URL, _ timeoutSec: Double, _ done: @escaping (Data?) -> Void) -> (() -> Void)
    /// Read a bundled image by its path under `public/`, on the utility queue.
    typealias BundleReader = (_ path: String) -> UIImage?
    /// Run `fire` on the cache's queue `sec` seconds from now: the
    /// deadline's only clock. Production is `queueDeadline(on:)` over that
    /// queue; a test injects a manual one so the
    /// deadline fires when the test says, not when a loaded runner's wall
    /// clock happens to get there first (NowPlayingPublisherTests).
    typealias DeadlineTimer = (_ sec: Double, _ fire: @escaping () -> Void) -> Void

    /// Plan §4.5: "bounded at 10 s".
    static let timeoutSec: Double = 10
    /// The web assets' directory inside the app bundle (`cap copy`).
    static let bundleDirectory = "public"
    /// Decoded squares kept at once: a drive touches a handful of shows, and
    /// each decoded 600x600 image is over a megabyte.
    static let capacity = 8
    /// How long a failed network load waits before a write may try it again
    /// (the legacy lane's `artworkRetryAfterSec`, audit round 3,
    /// mobile-native-6).
    static let retryAfterSec: Double = 45

    private let queue: DispatchQueue
    private let timeoutSec: Double
    private let fetcher: Fetcher
    private let bundleReader: BundleReader
    private let deadline: DeadlineTimer
    /// Monotonic seconds, for the retry window.
    private let now: () -> Double
    private let work = DispatchQueue(label: "ai.jwlabs.foura.engine.artwork", qos: .utility)

    private var images: [String: UIImage] = [:]
    /// Insertion order of `images`, oldest first, for the capacity bound.
    private var order: [String] = []
    /// When each source that has no artwork may be tried again, on `now`'s
    /// clock: a failed network load's retry time, or `.infinity` for an
    /// answer (unsupported, or a bundled file that is not there).
    private var noArtworkUntil: [String: Double] = [:]
    private var waiting: [String: [(UIImage?) -> Void]] = [:]

    init(queue: DispatchQueue = .main,
         timeoutSec: Double = ArtworkCache.timeoutSec,
         fetcher: @escaping Fetcher = ArtworkCache.urlSessionFetch,
         bundleReader: @escaping BundleReader = ArtworkCache.readBundled,
         deadline: DeadlineTimer? = nil,
         now: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime }) {
        self.queue = queue
        self.timeoutSec = timeoutSec
        self.fetcher = fetcher
        self.bundleReader = bundleReader
        self.deadline = deadline ?? ArtworkCache.queueDeadline(on: queue)
        self.now = now
    }

    /// The source a `MediaMapping.Artwork.src` is read from, or nil when it
    /// may not be shown: https with a host, or a plain relative path (no
    /// scheme, no leading slash, no `..`, no query or fragment).
    static func source(for src: String) -> Source? {
        if let url = URL(string: src), let scheme = url.scheme {
            guard scheme.lowercased() == "https", let host = url.host, !host.isEmpty else { return nil }
            return .remote(url)
        }
        guard !src.isEmpty, !src.contains(":"), !src.hasPrefix("/"), !src.contains("?"), !src.contains("#"),
              !src.contains("\\"), !src.split(separator: "/").contains("..") else { return nil }
        return .bundled(src)
    }

    func lookup(_ src: String) -> Lookup {
        if let image = images[src] { return .image(image) }
        if hasNoArtwork(src) { return .failed }
        return .missing
    }

    /// Whether `src` is known to have no artwork right now: an answer, or a
    /// failure still inside its retry window.
    private func hasNoArtwork(_ src: String) -> Bool {
        guard let until = noArtworkUntil[src] else { return false }
        return now() < until
    }

    /// Whether a load for `src` is in flight.
    func isLoading(_ src: String) -> Bool { waiting[src] != nil }

    /// Load `src` once. `completion` runs on the cache's queue with the
    /// image, or nil when the source is unsupported, the load failed, or the
    /// deadline passed. A second call while the first is in flight joins it.
    func load(_ src: String, completion: @escaping (UIImage?) -> Void) {
        dispatchPrecondition(condition: .onQueue(queue))
        if let image = images[src] { return completion(image) }
        if hasNoArtwork(src) { return completion(nil) }
        guard let source = Self.source(for: src) else {
            noArtworkUntil[src] = .infinity
            return completion(nil)
        }
        if waiting[src] != nil {
            waiting[src]?.append(completion)
            return
        }
        waiting[src] = [completion]

        // Settled exactly once, on the queue: by the image, the failure, or
        // the deadline, whichever comes first. Only a network load is worth
        // trying again; a bundled file that is not there will not appear.
        let pending = PendingLoad()
        let retryable: Bool
        if case .remote = source { retryable = true } else { retryable = false }
        let finish: (UIImage?) -> Void = { [weak self] image in
            guard !pending.settled else { return }
            pending.settled = true
            pending.cancel?()
            pending.cancel = nil
            self?.settle(src, image, retryable: retryable)
        }
        deadline(timeoutSec) { finish(nil) }

        switch source {
        case let .remote(url):
            let (work, queue) = (self.work, self.queue)
            pending.cancel = fetcher(url, timeoutSec) { data in
                // Decoded off the cache's queue, on the utility queue,
                // whatever thread the fetcher answered on.
                work.async {
                    let image = data.flatMap { UIImage(data: $0) }
                    queue.async { finish(image) }
                }
            }
        case let .bundled(path):
            let (read, queue) = (bundleReader, self.queue)
            work.async {
                let image = read(path)
                queue.async { finish(image) }
            }
        }
    }

    /// One load's settlement, shared by its three possible endings (all on the queue).
    private final class PendingLoad {
        var settled = false
        var cancel: (() -> Void)?
    }

    private func settle(_ src: String, _ image: UIImage?, retryable: Bool) {
        if let image {
            noArtworkUntil[src] = nil
            images[src] = image
            order.removeAll { $0 == src }
            order.append(src)
            while order.count > Self.capacity {
                images[order.removeFirst()] = nil
            }
        } else {
            noArtworkUntil[src] = retryable ? now() + Self.retryAfterSec : .infinity
        }
        let completions = waiting.removeValue(forKey: src) ?? []
        completions.forEach { $0(image) }
    }

    // MARK: - The real deadline, fetch and bundle read

    /// The whole-load deadline on `queue`, by the wall clock.
    static func queueDeadline(on queue: DispatchQueue) -> DeadlineTimer {
        return { sec, fire in queue.asyncAfter(deadline: .now() + sec, execute: fire) }
    }

    /// URLSession, honouring the HTTP cache, a non-2xx answer read as none.
    static func urlSessionFetch(_ url: URL, _ timeoutSec: Double, _ done: @escaping (Data?) -> Void) -> (() -> Void) {
        let request = URLRequest(url: url, cachePolicy: .returnCacheDataElseLoad, timeoutInterval: timeoutSec)
        let task = URLSession.shared.dataTask(with: request) { data, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            done((200..<300).contains(status) ? data : nil)
        }
        task.resume()
        return { task.cancel() }
    }

    /// `public/<path>` inside `Bundle.main`, or nil when it is not there.
    static func readBundled(_ path: String) -> UIImage? {
        let relative = path as NSString
        let directory = relative.deletingLastPathComponent
        let inDirectory = directory.isEmpty ? bundleDirectory : bundleDirectory + "/" + directory
        guard let file = Bundle.main.path(forResource: relative.lastPathComponent, ofType: nil, inDirectory: inDirectory) else {
            return nil
        }
        return UIImage(contentsOfFile: file)
    }
}
