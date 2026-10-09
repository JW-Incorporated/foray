import XCTest
@testable import ForayDownloadsPlugin

/// `DownloadStore`'s start-up rule, checked without a background session
/// (CH3-05, R4-04; docs/roadmap/code-health-3.md). Each test names the
/// mutation that turns it red.
///
/// These run in ci.yml's `ios-kit` job, in the `swift test (foray-downloads,
/// iOS Simulator)` step, beside `DownloadPolicyTests`.
final class DownloadStoreTests: XCTestCase {
    private func row(_ id: String, _ status: String, reason: String? = nil) -> DownloadRecord {
        DownloadRecord(id: id, url: "https://example.com/\(id).mp3",
                       file: DownloadPolicy.fileName(forEpisodeId: id), status: status, reason: reason)
    }

    /// **`reconcileInterrupted` emits one `downloadFailed` per row it flips.**
    /// A `queued` / `downloading` row with neither a live transfer nor a probe
    /// becomes `failed` / `interrupted`, and the page hears it (as Android's
    /// `pollOnce` already says it); a row with a live transfer or a probe, and
    /// every settled row, is left alone and owes nothing.
    /// MUTATION: return `[]` from `settleInterrupted` (the silent flip before
    /// CH3-05) -> the event assertions fail. MUTATION 2: drop
    /// `!live.contains(id)` -> the live transfer is flipped too.
    func testSettleInterruptedOwesOneDownloadFailedPerFlippedRow() {
        var index = DownloadIndex(items: [
            "a-queued": row("a-queued", "queued"),
            "b-downloading": row("b-downloading", "downloading"),
            "c-live": row("c-live", "downloading"),
            "d-probing": row("d-probing", "queued"),
            "e-done": row("e-done", "done"),
            "f-failed": row("f-failed", "failed", reason: DownloadPolicy.reasonCancelled),
            "g-refused": row("g-refused", "unplayable-here", reason: DownloadPolicy.reasonUnplayableHere)
        ])
        let before = index

        let events = DownloadStore.settleInterrupted(&index, live: ["c-live"], probing: ["d-probing"])

        XCTAssertEqual(events.map { $0.name }, [DownloadPolicy.eventFailed, DownloadPolicy.eventFailed])
        XCTAssertEqual(events.map { $0.payload["id"] as? String }, ["a-queued", "b-downloading"])
        for event in events {
            XCTAssertEqual(event.payload["reason"] as? String, DownloadPolicy.reasonInterrupted)
            XCTAssertTrue(event.payload["status"] is NSNull, "no HTTP status: nothing answered")
            XCTAssertEqual(Set(event.payload.keys), ["id", "reason", "status"])
        }
        for id in ["a-queued", "b-downloading"] {
            XCTAssertEqual(index.items[id]?.status, "failed", id)
            XCTAssertEqual(index.items[id]?.reason, DownloadPolicy.reasonInterrupted, id)
        }
        for id in ["c-live", "d-probing", "e-done", "f-failed", "g-refused"] {
            XCTAssertEqual(index.items[id], before.items[id], id)
        }
    }

    /// **A second pass owes nothing.** The flipped rows are `failed` now, so a
    /// later start-up neither re-flips nor re-announces them.
    /// MUTATION: also flip `failed` rows -> the second pass owes two events.
    func testSettleInterruptedIsIdempotent() {
        var index = DownloadIndex(items: ["a": row("a", "queued"), "b": row("b", "done")])
        XCTAssertEqual(DownloadStore.settleInterrupted(&index, live: [], probing: []).count, 1)
        let settled = index
        XCTAssertTrue(DownloadStore.settleInterrupted(&index, live: [], probing: []).isEmpty)
        XCTAssertEqual(index, settled)
    }
}
