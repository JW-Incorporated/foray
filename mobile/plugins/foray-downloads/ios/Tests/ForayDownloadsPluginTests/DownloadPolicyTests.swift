import XCTest
@testable import ForayDownloadsPlugin

/// `DownloadPolicy` (PQ-20, #29): every rule the iOS download store follows,
/// checked without a network or a background session. Each test names the
/// mutation that turns it red.
///
/// These run in ci.yml's `ios-kit` job, in the `swift test (foray-downloads,
/// iOS Simulator)` step beside foray-tts's (CH-06); the package links
/// Capacitor, which ships iOS slices only, so a host `swift test` cannot
/// build it.
final class DownloadPolicyTests: XCTestCase {
    private let enclosure = URL(string: "https://dts.podtrac.com/redirect.mp3/example.com/ep.mp3")!
    private let ua = "4a/2026100401 (+https://jw-incorporated.github.io/foray/)"

    // MARK: identity

    /// **The names the web half and the AppDelegate hook depend on.**
    /// MUTATION: rename the session identifier -> a relaunch's events are
    /// delivered to a session nobody creates.
    func testTheWireNamesMatchTheWebHalf() {
        XCTAssertEqual(DownloadPolicy.pluginName, "ForayDownloads")
        XCTAssertEqual(DownloadPolicy.sessionIdentifier, "ai.jwlabs.foura.downloads")
        XCTAssertEqual(DownloadPolicy.directoryName, "foray-downloads")
        XCTAssertEqual([DownloadPolicy.eventProgress, DownloadPolicy.eventDone, DownloadPolicy.eventFailed],
                       ["downloadProgress", "downloadDone", "downloadFailed"])
    }

    // MARK: sources

    /// **Only an absolute http(s) URL with a host is fetched.** A `file:`
    /// URL would copy a local file into the store; a custom scheme has no
    /// business in a podcast feed.
    /// MUTATION: drop the scheme check in `isWebURL` -> the file: and data:
    /// cases are accepted.
    func testOnlyHttpAndHttpsSourcesAreAccepted() {
        XCTAssertEqual(DownloadPolicy.source("https://example.com/a.mp3")?.host, "example.com")
        XCTAssertNotNil(DownloadPolicy.source("http://example.com/a.mp3"))
        XCTAssertNotNil(DownloadPolicy.source("  HTTPS://example.com/a.mp3 "))
        XCTAssertNil(DownloadPolicy.source("file:///etc/hosts"))
        XCTAssertNil(DownloadPolicy.source("data:audio/mpeg;base64,AAAA"))
        XCTAssertNil(DownloadPolicy.source("capacitor://localhost/_capacitor_file_/x"))
        XCTAssertNil(DownloadPolicy.source("/var/mobile/a.mp3"))
        XCTAssertNil(DownloadPolicy.source("https:///no-host"))
        XCTAssertNil(DownloadPolicy.source(""))
        XCTAssertNil(DownloadPolicy.source(nil))
    }

    // MARK: requests

    /// **The probe is a one-byte GET, never a HEAD**, and carries the page's
    /// User-Agent.
    /// MUTATION: `request.httpMethod = "HEAD"` in `probeRequest` -> fails.
    func testTheProbeIsAOneByteGet() {
        let probe = DownloadPolicy.probeRequest(url: enclosure, userAgent: ua, allowCellular: false)
        XCTAssertEqual(probe.httpMethod, "GET")
        XCTAssertEqual(probe.value(forHTTPHeaderField: "Range"), "bytes=0-0")
        XCTAssertEqual(probe.value(forHTTPHeaderField: "User-Agent"), ua)
        XCTAssertEqual(probe.url, enclosure)
    }

    /// **The transfer is a plain GET of the landed URL, with no Range.**
    /// MUTATION: build it from `probeRequest` -> the background task fetches
    /// one byte and stores it as the episode.
    func testTheDownloadIsAPlainGetWithTheUserAgent() {
        let request = DownloadPolicy.downloadRequest(url: enclosure, userAgent: ua, allowCellular: true)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertNil(request.value(forHTTPHeaderField: "Range"))
        XCTAssertEqual(request.value(forHTTPHeaderField: "User-Agent"), ua)
    }

    /// **`allowsCellularAccess` is the call's, on the probe, the transfer and
    /// every redirect.**
    /// MUTATION: `request.allowsCellularAccess = true` in `baseRequest` ->
    /// the Wi-Fi-only cases fail.
    func testCellularAccessFollowsTheCall() {
        for allow in [false, true] {
            XCTAssertEqual(DownloadPolicy.probeRequest(url: enclosure, userAgent: ua, allowCellular: allow).allowsCellularAccess, allow)
            XCTAssertEqual(DownloadPolicy.downloadRequest(url: enclosure, userAgent: ua, allowCellular: allow).allowsCellularAccess, allow)
            let hop = DownloadPolicy.redirected(URLRequest(url: enclosure), userAgent: ua, allowCellular: allow)
            XCTAssertEqual(hop.allowsCellularAccess, allow)
        }
    }

    /// **A User-Agent that is not one printable line is not sent.** URLSession
    /// would otherwise send a header a host may reject outright.
    /// MUTATION: return `value` unchecked -> the newline case is sent.
    func testAMalformedUserAgentFallsBackToTheDefault() {
        XCTAssertNil(DownloadPolicy.userAgentHeader("4a/1\r\nX-Evil: 1"))
        XCTAssertNil(DownloadPolicy.userAgentHeader("   "))
        XCTAssertNil(DownloadPolicy.userAgentHeader(nil))
        XCTAssertNil(DownloadPolicy.userAgentHeader(String(repeating: "a", count: 300)))
        XCTAssertEqual(DownloadPolicy.userAgentHeader(ua), ua)
        let request = DownloadPolicy.downloadRequest(url: enclosure, userAgent: "bad\nua", allowCellular: false)
        XCTAssertNil(request.value(forHTTPHeaderField: "User-Agent"))
    }

    // MARK: redirects

    /// **Eight redirects are followed; the ninth fails as
    /// `too-many-redirects`.**
    /// MUTATION: `count > maxRedirects + 1` -> the ninth is followed.
    func testTheNinthRedirectIsRefused() {
        let next = URL(string: "https://cdn.example.com/ep.mp3")!
        for n in 1...8 {
            XCTAssertEqual(DownloadPolicy.redirect(count: n, to: next), .follow, "redirect \(n)")
        }
        XCTAssertEqual(DownloadPolicy.redirect(count: 9, to: next), .refuse(reason: "too-many-redirects"))
        XCTAssertEqual(DownloadPolicy.maxRedirects, 8)
    }

    /// **A hop to anything but http(s) is refused.** A redirector must not
    /// be able to point the store at a local file.
    /// MUTATION: skip the `isWebURL` check in `redirect` -> file: is followed.
    func testARedirectOffTheWebIsRefused() {
        XCTAssertEqual(DownloadPolicy.redirect(count: 1, to: URL(string: "file:///etc/hosts")),
                       .refuse(reason: "bad-redirect"))
        XCTAssertEqual(DownloadPolicy.redirect(count: 1, to: nil), .refuse(reason: "bad-redirect"))
        XCTAssertEqual(DownloadPolicy.redirect(count: 2, to: URL(string: "http://example.com/a.mp3")), .follow)
    }

    /// **Every hop keeps the User-Agent and the probe's Range.**
    /// MUTATION: return `request` unchanged from `redirected` -> fails.
    func testARedirectKeepsTheHeadersWeOwe() {
        var hop = URLRequest(url: URL(string: "https://cdn.example.com/ep.mp3")!)
        hop.setValue("CFNetwork/1", forHTTPHeaderField: "User-Agent")
        let next = DownloadPolicy.redirected(hop, userAgent: ua, allowCellular: false)
        XCTAssertEqual(next.value(forHTTPHeaderField: "User-Agent"), ua)
        XCTAssertEqual(next.value(forHTTPHeaderField: "Range"), "bytes=0-0")
        XCTAssertEqual(next.url, hop.url)
    }

    // MARK: statuses

    /// **A 403 is `unplayable-here`, at the probe and at completion** -- the
    /// status download-store.js's `reportFromEvent` keys on.
    /// MUTATION: map 403 to `http 403` in `probeVerdict` -> fails.
    func testA403IsUnplayableHere() {
        XCTAssertEqual(DownloadPolicy.probeVerdict(status: 403), .refuse(reason: "unplayable-here"))
        XCTAssertEqual(DownloadPolicy.completionVerdict(status: 403), .refuse(reason: "unplayable-here"))
    }

    /// **The probe proceeds on 2xx and on statuses only a range request
    /// draws, and stops on a dead enclosure.**
    /// MUTATION: refuse every non-2xx in `probeVerdict` -> 416 and 405 fail.
    func testTheProbeLeavesRangeQuirksToTheRealFetch() {
        for status in [200, 206] { XCTAssertEqual(DownloadPolicy.probeVerdict(status: status), .proceed, "\(status)") }
        for status in [405, 416, 500, 503] { XCTAssertEqual(DownloadPolicy.probeVerdict(status: status), .proceed, "\(status)") }
        XCTAssertEqual(DownloadPolicy.probeVerdict(status: 404), .refuse(reason: "http 404"))
        XCTAssertEqual(DownloadPolicy.probeVerdict(status: 410), .refuse(reason: "http 410"))
    }

    /// **Only a 2xx body is kept.** An error page saved as an episode would
    /// read as a corrupt download.
    /// MUTATION: `.proceed` for every status in `completionVerdict` -> fails.
    func testOnlyA2xxBodyIsKept() {
        XCTAssertEqual(DownloadPolicy.completionVerdict(status: 200), .proceed)
        XCTAssertEqual(DownloadPolicy.completionVerdict(status: 206), .proceed)
        XCTAssertEqual(DownloadPolicy.completionVerdict(status: 404), .refuse(reason: "http 404"))
        XCTAssertEqual(DownloadPolicy.completionVerdict(status: 500), .refuse(reason: "http 500"))
        XCTAssertEqual(DownloadPolicy.completionVerdict(status: 0), .refuse(reason: "http 0"))
    }

    // MARK: files

    /// **The file name is SHA-256(episode id) in lowercase hex, plus `.bin`.**
    /// The FIPS 180-2 vector for "abc".
    /// MUTATION: `id + ".bin"` -> fails, and `../x` would escape the directory.
    func testTheFileNameIsTheIdsSha256() {
        XCTAssertEqual(DownloadPolicy.fileName(forEpisodeId: "abc"),
                       "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad.bin")
        let hostile = DownloadPolicy.fileName(forEpisodeId: "../../Library/Preferences/x")
        XCTAssertFalse(hostile.contains("/"))
        XCTAssertTrue(DownloadPolicy.isStoreFileName(hostile))
        XCTAssertNotEqual(DownloadPolicy.fileName(forEpisodeId: "a"), DownloadPolicy.fileName(forEpisodeId: "b"))
    }

    /// **`fileSrc({ path })` answers only for names this store writes.**
    /// MUTATION: return true from `isStoreFileName` -> `index.json` and a
    /// traversal pass.
    func testOnlyStoreFileNamesAreRecognised() {
        XCTAssertFalse(DownloadPolicy.isStoreFileName("index.json"))
        XCTAssertFalse(DownloadPolicy.isStoreFileName("../" + DownloadPolicy.fileName(forEpisodeId: "abc")))
        XCTAssertFalse(DownloadPolicy.isStoreFileName(DownloadPolicy.fileName(forEpisodeId: "abc").uppercased()))
        XCTAssertFalse(DownloadPolicy.isStoreFileName(String(repeating: "g", count: 64) + ".bin"))
    }

    // MARK: progress

    /// **Progress is spaced half a second apart, with the first and last
    /// ticks always sent.**
    /// MUTATION: `return true` at the top of `shouldEmitProgress` -> the
    /// 0.1 s tick is sent.
    func testProgressIsThrottledButNeverLosesTheEnds() {
        XCTAssertTrue(DownloadPolicy.shouldEmitProgress(lastEmittedAt: nil, now: 10, written: 1, expected: 100))
        XCTAssertFalse(DownloadPolicy.shouldEmitProgress(lastEmittedAt: 10, now: 10.1, written: 2, expected: 100))
        XCTAssertTrue(DownloadPolicy.shouldEmitProgress(lastEmittedAt: 10, now: 10.5, written: 3, expected: 100))
        XCTAssertTrue(DownloadPolicy.shouldEmitProgress(lastEmittedAt: 10, now: 10.1, written: 100, expected: 100))
        XCTAssertFalse(DownloadPolicy.shouldEmitProgress(lastEmittedAt: 10, now: 10.1, written: 5, expected: -1))
    }

    /// **The event payloads have the shapes download-store.js reads**, and an
    /// unknown length is null, not -1.
    /// MUTATION: send `expected` as given -> total is -1 and the usage line
    /// reads a negative size.
    func testPayloadsMatchTheWebHalf() {
        let unknown = DownloadPolicy.progressPayload(id: "e1", written: 10, expected: -1)
        XCTAssertEqual(unknown["id"] as? String, "e1")
        XCTAssertEqual(unknown["bytes"] as? Int64, 10)
        XCTAssertTrue(unknown["total"] is NSNull)
        XCTAssertEqual(DownloadPolicy.progressPayload(id: "e1", written: 10, expected: 50)["total"] as? Int64, 50)

        let failed = DownloadPolicy.failedPayload(id: "e1", reason: "unplayable-here", status: 403)
        XCTAssertEqual(failed["reason"] as? String, "unplayable-here")
        XCTAssertEqual(failed["status"] as? Int, 403)
        XCTAssertTrue(DownloadPolicy.failedPayload(id: "e1", reason: "network -1009", status: nil)["status"] is NSNull)

        let done = DownloadPolicy.donePayload(id: "e1", path: "/a/Application Support/foray-downloads/x.bin", bytes: 42)
        XCTAssertEqual(done["path"] as? String, "/a/Application Support/foray-downloads/x.bin")
        XCTAssertEqual(done["bytes"] as? Int64, 42)
    }

    // MARK: the index

    /// **`usage` sums the bytes of `done` rows only, from the index** -- no
    /// volume query (the DiskSpace category is not declared, #1014).
    /// MUTATION: drop `where record.status == "done"` -> fails.
    func testUsageCountsDoneRowsOnly() {
        let index = DownloadIndex(items: [
            "a": DownloadRecord(id: "a", url: "https://x/a", file: "a.bin", status: "done", bytes: 1_000),
            "b": DownloadRecord(id: "b", url: "https://x/b", file: "b.bin", status: "done", bytes: 2_500),
            "c": DownloadRecord(id: "c", url: "https://x/c", file: "c.bin", status: "downloading", bytes: 9_999),
            "d": DownloadRecord(id: "d", url: "https://x/d", file: "d.bin", status: "failed", bytes: 7, reason: "http 404")
        ])
        let usage = index.usage()
        XCTAssertEqual(usage.bytes, 3_500)
        XCTAssertEqual(usage.count, 2)
        XCTAssertEqual(DownloadIndex().usage().bytes, 0)
    }

    /// **The index round-trips, and a torn or foreign file reads as empty
    /// rather than stopping the store.**
    /// MUTATION: `try!` decode in `DownloadIndex.decode` -> the garbage case
    /// crashes.
    func testTheIndexRoundTripsAndToleratesGarbage() {
        let index = DownloadIndex(items: [
            "a": DownloadRecord(id: "a", url: "https://x/a", file: "a.bin", status: "done", bytes: 12, total: 12)
        ])
        XCTAssertEqual(DownloadIndex.decode(index.encoded()), index)
        XCTAssertEqual(DownloadIndex.decode(Data("{\"items\":".utf8)), DownloadIndex())
        XCTAssertEqual(DownloadIndex.decode(Data("[1,2]".utf8)), DownloadIndex())
        XCTAssertEqual(DownloadIndex.decode(nil), DownloadIndex())
    }
}
