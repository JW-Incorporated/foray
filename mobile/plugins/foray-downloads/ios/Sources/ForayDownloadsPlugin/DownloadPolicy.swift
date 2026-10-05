import Foundation
import CryptoKit

/// Every RULE the iOS download store follows, kept apart from the store so
/// XCTest can check each one without a network, a background session or a
/// phone (`DownloadPolicyTests.swift`). Issue #29; docs/roadmap/player-features.md
/// PQ-20. Nothing here touches the disk or opens a connection: it builds
/// requests, reads statuses and redirects, names files and does arithmetic over
/// the JSON index.
///
/// THE CONTRACT IS THE WEB HALF'S. `player/download-bridge.js` names the plugin
/// (`ForayDownloads`), its seven calls and its three events, and
/// `player/download-store.js`'s `reportFromEvent` reads the event payloads.
/// `tools/mobile/foray-downloads.test.mjs` pins the names here against that
/// file, so a rename on either side fails CI.
///
/// REQUIRED REASON APIS. None. Disk-space reads (the DiskSpace category) are
/// not declared in the app's privacy manifest (#1014), so `usage` is summed
/// from the bytes this store recorded, never asked of the volume.
public enum DownloadPolicy {
    /// The background `URLSession`'s identifier. One per app; the AppDelegate
    /// hook (PQ-21) forwards relaunch events for exactly this identifier.
    public static let sessionIdentifier = "ai.jwlabs.foura.downloads"

    /// `Application Support/<this>/`: not Documents (the Files app shows it),
    /// not Caches (iOS purges Caches under storage pressure, and a download the
    /// listener asked for must survive until they remove it). The same choice
    /// `EngineDiagnostics.defaultDirectory()` makes for `foray-engine`.
    public static let directoryName = "foray-downloads"

    /// The JSON index, kept beside the audio files in the same directory, so
    /// `removeAll` deleting the directory deletes the index with them.
    public static let indexFileName = "index.json"

    /// The longest redirect chain followed. Podcast enclosures routinely pass
    /// through two or three measurement hops before the host; eight is
    /// generous for that and still stops a loop.
    public static let maxRedirects = 8

    /// The probe asks for one byte. A host that ignores `Range` answers 200
    /// with the whole file, so the store cancels the probe on its first
    /// response; either way the status and the landing URL are known before a
    /// background transfer is started.
    public static let probeRange = "bytes=0-0"

    /// Progress events are spaced at least this far apart (seconds), plus one
    /// at the very end, so a fast transfer does not flood the bridge.
    public static let progressInterval: TimeInterval = 0.5

    // MARK: the wire (player/download-bridge.js)

    public static let pluginName = "ForayDownloads"
    public static let eventProgress = "downloadProgress"
    public static let eventDone = "downloadDone"
    public static let eventFailed = "downloadFailed"

    // MARK: failure reasons (download-store.js keeps `reason` on failed rows)

    public static let reasonTooManyRedirects = "too-many-redirects"
    public static let reasonUnplayableHere = "unplayable-here"
    public static let reasonBadURL = "bad-url"
    public static let reasonBadRedirect = "bad-redirect"
    public static let reasonCancelled = "cancelled"
    public static let reasonNotSaved = "not-saved"
    public static let reasonInterrupted = "interrupted"

    // MARK: sources

    /// The enclosure URL a call may ask for: an absolute `http` or `https` URL
    /// with a host. Anything else (`file:`, `data:`, a relative string, a
    /// custom scheme) is refused before a request exists, so the page cannot
    /// make the plugin read or copy a local file into the store.
    /// MUTATION: accept any scheme -> `testOnlyHttpAndHttpsSourcesAreAccepted`.
    public static func source(_ string: String?) -> URL? {
        guard let raw = string?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty,
              let url = URL(string: raw), isWebURL(url) else { return nil }
        return url
    }

    static func isWebURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return false }
        guard let host = url.host, !host.isEmpty else { return false }
        return true
    }

    // MARK: requests

    /// The one-byte probe: a `GET` with `Range: bytes=0-0`. Never `HEAD` --
    /// a good share of podcast hosts and their measurement redirectors answer
    /// HEAD differently from GET (405, or a different redirect chain), and the
    /// point of the probe is to see what the real fetch will see.
    /// MUTATION: build it with the HEAD method -> `testTheProbeIsAOneByteGet`.
    public static func probeRequest(url: URL, userAgent: String?, allowCellular: Bool) -> URLRequest {
        var request = baseRequest(url: url, userAgent: userAgent, allowCellular: allowCellular)
        request.httpMethod = "GET"
        request.setValue(probeRange, forHTTPHeaderField: "Range")
        return request
    }

    /// The background transfer's request: a plain `GET` of the URL the probe
    /// landed on, carrying the page's User-Agent and the listener's cellular
    /// choice.
    public static func downloadRequest(url: URL, userAgent: String?, allowCellular: Bool) -> URLRequest {
        var request = baseRequest(url: url, userAgent: userAgent, allowCellular: allowCellular)
        request.httpMethod = "GET"
        return request
    }

    /// `allowsCellularAccess` comes from the call and from nothing else: the
    /// "Download over cellular" switch is the listener's, and it defaults off
    /// (download-store.js: `cellular: settings.cellular === true`).
    /// MUTATION: hard-code `true` -> `testCellularAccessFollowsTheCall`.
    static func baseRequest(url: URL, userAgent: String?, allowCellular: Bool) -> URLRequest {
        var request = URLRequest(url: url)
        request.allowsCellularAccess = allowCellular
        if let ua = userAgentHeader(userAgent) {
            request.setValue(ua, forHTTPHeaderField: "User-Agent")
        }
        return request
    }

    /// The page's `4a/<build> (+site)` string, used as given when it is one
    /// printable line; else nil, and URLSession sends its own default.
    static func userAgentHeader(_ value: String?) -> String? {
        guard let ua = value?.trimmingCharacters(in: .whitespaces), !ua.isEmpty, ua.count <= 256 else { return nil }
        let printable = ua.unicodeScalars.allSatisfy { $0.value >= 0x20 && $0.value < 0x7F }
        return printable ? ua : nil
    }

    // MARK: redirects

    public enum RedirectDecision: Equatable {
        case follow
        case refuse(reason: String)
    }

    /// Whether to follow redirect number `count` (1 for the first) to `target`.
    /// The ninth is refused as `too-many-redirects`; a hop to anything but an
    /// absolute http(s) URL is refused as `bad-redirect`.
    ///
    /// WHERE THIS RUNS. Only in the probe. A background `URLSession` follows
    /// redirects itself and never asks its delegate, so the store runs the
    /// probe in an ephemeral session where this decision is honoured, and then
    /// hands the background transfer the URL the probe LANDED on.
    /// MUTATION: `count > maxRedirects + 1` -> `testTheNinthRedirectIsRefused`.
    public static func redirect(count: Int, to target: URL?) -> RedirectDecision {
        if count > maxRedirects { return .refuse(reason: reasonTooManyRedirects) }
        guard let target = target, isWebURL(target) else { return .refuse(reason: reasonBadRedirect) }
        return .follow
    }

    /// The redirected request with the page's User-Agent and the probe's
    /// Range header put back: what URLSession carries across a hop is its
    /// business, what the host sees on every hop is ours.
    public static func redirected(_ request: URLRequest, userAgent: String?, allowCellular: Bool) -> URLRequest {
        var next = request
        next.allowsCellularAccess = allowCellular
        if let ua = userAgentHeader(userAgent) { next.setValue(ua, forHTTPHeaderField: "User-Agent") }
        next.setValue(probeRange, forHTTPHeaderField: "Range")
        return next
    }

    // MARK: statuses

    public enum Verdict: Equatable {
        /// Go on: start the transfer (probe) or keep the file (completion).
        case proceed
        /// Stop and emit `downloadFailed { reason, status }`.
        case refuse(reason: String)
    }

    /// The probe's answer. 2xx goes ahead. 403 is `unplayable-here`: the host
    /// refuses this client, and retrying will not change that
    /// (download-store.js keys `unplayable-here` on status 403 too). A 404 or
    /// 410 is a dead enclosure. Anything else a one-byte probe can draw from a
    /// host that dislikes ranges (405, 416, a 5xx) is left to the real fetch
    /// to judge, rather than refusing a download that would have worked.
    /// MUTATION: map 403 to `http 403` -> `testA403IsUnplayableHere`.
    public static func probeVerdict(status: Int) -> Verdict {
        if (200...299).contains(status) { return .proceed }
        if status == 403 { return .refuse(reason: reasonUnplayableHere) }
        if status == 404 || status == 410 { return .refuse(reason: "http \(status)") }
        return .proceed
    }

    /// The finished transfer's answer: only a 2xx body is audio worth keeping.
    /// A 403 here is `unplayable-here` as above; any other status keeps the
    /// error page out of the store as `http <status>`.
    public static func completionVerdict(status: Int) -> Verdict {
        if (200...299).contains(status) { return .proceed }
        if status == 403 { return .refuse(reason: reasonUnplayableHere) }
        return .refuse(reason: "http \(status)")
    }

    // MARK: files

    /// The stored file's name: SHA-256 of the episode id, lowercase hex, plus
    /// `.bin`. A hash, not the id, so an id with `/`, `..` or a space can
    /// never name a path outside the directory; `.bin`, not `.mp3`, because
    /// the enclosure's real type is not known (AVFoundation sniffs it).
    /// MUTATION: return `id + ".bin"` -> `testTheFileNameIsTheIdsSha256`.
    public static func fileName(forEpisodeId id: String) -> String {
        let digest = SHA256.hash(data: Data(id.utf8))
        return digest.map { String(format: "%02x", $0) }.joined() + ".bin"
    }

    /// Whether `name` is a file this store could have written: 64 hex digits
    /// and `.bin`. `fileSrc({ path })` answers only for such names.
    public static func isStoreFileName(_ name: String) -> Bool {
        guard name.hasSuffix(".bin"), name.count == 68 else { return false }
        return name.dropLast(4).allSatisfy { $0.isHexDigit && !$0.isUppercase }
    }

    // MARK: progress

    /// Whether a progress tick is worth an event: the first one, the last one
    /// (`written == expected`), or one at least `progressInterval` after the
    /// previous event.
    public static func shouldEmitProgress(lastEmittedAt: TimeInterval?, now: TimeInterval,
                                          written: Int64, expected: Int64) -> Bool {
        guard let last = lastEmittedAt else { return true }
        if expected > 0 && written >= expected { return true }
        return now - last >= progressInterval
    }

    /// `downloadProgress { id, bytes, total }`; `total` is null when the host
    /// sent no length (URLSession reports -1).
    public static func progressPayload(id: String, written: Int64, expected: Int64) -> [String: Any] {
        ["id": id, "bytes": max(0, written), "total": expected > 0 ? expected as Any : NSNull() as Any]
    }

    /// `downloadFailed { id, reason, status }`; `status` is the HTTP status
    /// when there was one, else null.
    public static func failedPayload(id: String, reason: String, status: Int?) -> [String: Any] {
        ["id": id, "reason": reason, "status": status.map { $0 as Any } ?? (NSNull() as Any)]
    }

    /// `downloadDone { id, path, bytes }`.
    public static func donePayload(id: String, path: String, bytes: Int64) -> [String: Any] {
        ["id": id, "path": path, "bytes": max(0, bytes)]
    }
}

/// One download as the index keeps it. `file` is the stored name, never an
/// absolute path: the app's container path changes when iOS updates or
/// restores the app, so the absolute path is recomputed on every answer.
public struct DownloadRecord: Codable, Equatable {
    public var id: String
    public var url: String
    public var file: String
    public var status: String
    public var bytes: Int64
    public var total: Int64?
    public var reason: String?

    public init(id: String, url: String, file: String, status: String,
                bytes: Int64 = 0, total: Int64? = nil, reason: String? = nil) {
        self.id = id
        self.url = url
        self.file = file
        self.status = status
        self.bytes = bytes
        self.total = total
        self.reason = reason
    }
}

/// The whole index: what `list` and `usage` answer from.
public struct DownloadIndex: Codable, Equatable {
    public var version: Int = 1
    public var items: [String: DownloadRecord] = [:]

    public init(items: [String: DownloadRecord] = [:]) {
        self.items = items
    }

    /// The index in `data`, or an empty one when `data` is absent or does not
    /// parse. A torn write must never stop the app from opening the store;
    /// the files it named are found again or re-downloaded.
    public static func decode(_ data: Data?) -> DownloadIndex {
        guard let data = data, let index = try? JSONDecoder().decode(DownloadIndex.self, from: data) else {
            return DownloadIndex()
        }
        return index
    }

    public func encoded() -> Data? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try? encoder.encode(self)
    }

    /// `usage { bytes, count }`: the bytes of finished downloads, summed from
    /// the sizes recorded at completion. Counts `done` rows only, like
    /// download-store.js's `usedBytes`: a transfer in flight has not yet
    /// earned its place on disk. Never a volume query (see the header).
    /// MUTATION: sum every row -> `testUsageCountsDoneRowsOnly`.
    public func usage() -> (bytes: Int64, count: Int) {
        var bytes: Int64 = 0
        var count = 0
        for record in items.values where record.status == "done" {
            bytes += max(0, record.bytes)
            count += 1
        }
        return (bytes, count)
    }
}
