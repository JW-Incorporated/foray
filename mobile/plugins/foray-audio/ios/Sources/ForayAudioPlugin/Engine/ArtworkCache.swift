import Foundation
import UIKit

/// Now Playing's artwork, for NowPlayingPublisher (card NE-18;
/// docs/native-engine-plan.md §4.5).
///
/// ── THE RULES, AND WHY EACH ONE ────────────────────────────────────────────
///
///   - HTTPS OR BUNDLED ONLY. `MediaMapping.artworkUrl` has already gated the
///     page's URL (https, a `data:image/` URI, or a relative path). Here a
///     relative path is our own icon in the app bundle's `public/` (where
///     Capacitor copies the web assets), an `https:` URL is a publisher's
///     square, and everything else, `data:` included, has no artwork: a
///     `data:` URI on the lock screen is an image the page could make of
///     anything, and nothing the engine shows ever needs one.
///   - OFF MAIN. The network fetch runs on URLSession's queue, the bundle read
///     and every decode on a utility queue; only the finished `UIImage` comes
///     back to main. The engine is main-confined (plan §4.2) and a car's
///     press must never wait behind an image.
///   - BOUNDED AT 10 s, WHOLE. `URLRequest.timeoutInterval` bounds the gaps
///     between packets, not the fetch, so a trickling server could hold one
///     open for a minute. A deadline on main settles the load at 10 s
///     whatever the transfer is doing, and cancels it.
///   - CACHED, AND A FAILURE IS CACHED TOO. A re-write of an unchanged entry
///     (every seek, every state change) must not fetch again, and a dead URL
///     costs one attempt per process, not one per write (the legacy lane's
///     2026-09-23 lesson: an uncached artwork fetch sat in front of the car's
///     play). A failed or timed-out key has no artwork; NowPlayingPublisher
///     builds every entry fresh, so the key is dropped, never left showing
///     the previous item's square.
///   - NOT FOR NARRATION. A narration line's metadata already carries only
///     our icon (`MediaMapping.metadata`: "a narration line is ours"), so no
///     publisher's artwork can reach this cache for one.
///
/// MAIN-CONFINED: every method is called on main (the publisher is driven by
/// the host), and every completion is delivered on main.
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

    /// Plan §4.5: "bounded at 10 s".
    static let timeoutSec: Double = 10
    /// The web assets' directory inside the app bundle (`cap copy`).
    static let bundleDirectory = "public"
    /// Decoded squares kept at once: a drive touches a handful of shows, and
    /// each decoded 600x600 image is over a megabyte.
    static let capacity = 8

    private let timeoutSec: Double
    private let fetcher: Fetcher
    private let bundleReader: BundleReader
    private let work = DispatchQueue(label: "ai.jwlabs.foura.engine.artwork", qos: .utility)

    private var images: [String: UIImage] = [:]
    /// Insertion order of `images`, oldest first, for the capacity bound.
    private var order: [String] = []
    private var failed: Set<String> = []
    private var waiting: [String: [(UIImage?) -> Void]] = [:]

    init(timeoutSec: Double = ArtworkCache.timeoutSec,
         fetcher: @escaping Fetcher = ArtworkCache.urlSessionFetch,
         bundleReader: @escaping BundleReader = ArtworkCache.readBundled) {
        self.timeoutSec = timeoutSec
        self.fetcher = fetcher
        self.bundleReader = bundleReader
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
        if failed.contains(src) { return .failed }
        return .missing
    }

    /// Whether a load for `src` is in flight.
    func isLoading(_ src: String) -> Bool { waiting[src] != nil }

    /// Load `src` once. `completion` runs on main with the image, or nil when
    /// the source is unsupported, the load failed, or the deadline passed.
    /// A second call while the first is in flight joins it.
    func load(_ src: String, completion: @escaping (UIImage?) -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        if let image = images[src] { return completion(image) }
        if failed.contains(src) { return completion(nil) }
        guard let source = Self.source(for: src) else {
            failed.insert(src)
            return completion(nil)
        }
        if waiting[src] != nil {
            waiting[src]?.append(completion)
            return
        }
        waiting[src] = [completion]

        // Settled exactly once, on main: by the image, the failure, or the
        // deadline, whichever comes first.
        let pending = PendingLoad()
        let finish: (UIImage?) -> Void = { [weak self] image in
            guard !pending.settled else { return }
            pending.settled = true
            pending.cancel?()
            pending.cancel = nil
            self?.settle(src, image)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + timeoutSec) { finish(nil) }

        switch source {
        case let .remote(url):
            let work = self.work
            pending.cancel = fetcher(url, timeoutSec) { data in
                // Decoded off main, on the utility queue, whatever thread the
                // fetcher answered on.
                work.async {
                    let image = data.flatMap { UIImage(data: $0) }
                    DispatchQueue.main.async { finish(image) }
                }
            }
        case let .bundled(path):
            let read = bundleReader
            work.async {
                let image = read(path)
                DispatchQueue.main.async { finish(image) }
            }
        }
    }

    /// One load's settlement, shared by its three possible endings (all on main).
    private final class PendingLoad {
        var settled = false
        var cancel: (() -> Void)?
    }

    private func settle(_ src: String, _ image: UIImage?) {
        if let image {
            images[src] = image
            order.removeAll { $0 == src }
            order.append(src)
            while order.count > Self.capacity {
                images[order.removeFirst()] = nil
            }
        } else {
            failed.insert(src)
        }
        let completions = waiting.removeValue(forKey: src) ?? []
        completions.forEach { $0(image) }
    }

    // MARK: - The real fetch and bundle read

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
