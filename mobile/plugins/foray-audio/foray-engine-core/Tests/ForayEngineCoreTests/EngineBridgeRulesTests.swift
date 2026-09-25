import XCTest
import ForayEngineCore

/// Card NE-20, the pure half (docs/native-engine-plan.md §5.1-§5.4): every
/// payload the bridge builds is one the contract schema accepts (the same
/// decoder the `contract` and `snapshot` parity families run), `seq` is a
/// content version, and the coalescer lets nothing out while the page is
/// hidden and at most one snapshot a second while it is visible.
///
/// Host `swift test` (Linux and macOS): no Simulator needed. The bridge
/// itself, over the recording seams, is `EngineBridgeTests` in the plugin.
///
/// Each test names the edit that turns it red.
final class EngineBridgeRulesTests: XCTestCase {

    private func stamped(_ body: [JSONMember], seq stamper: inout SnapshotStamper) -> JSONNode {
        stamper.stamp(body, wallMs: 1_790_000_000_000, monoMs: 5_000).snapshot
    }

    private func refusal(_ kind: EngineContract.Kind, _ payload: JSONNode) -> String {
        EngineContract.refusal(kind, payload).map { "\($0)" } ?? "accepted"
    }

    // MARK: - Snapshot v1

    /// An engine that has played nothing answers a valid snapshot: mode
    /// `none`, nothing loaded, the session inactive, the default hold.
    /// TO SEE IT FAIL: drop a required member from `EngineSnapshot.body`
    /// (say `holdPolicy`), or write `durationSec: 0` for "unknown".
    func testAnIdleEngineSnapshotIsContractValid() {
        var stamper = SnapshotStamper()
        let snapshot = stamped(EngineSnapshot.body(core: EngineCore(), deck: .idle, lastError: nil), seq: &stamper)
        XCTAssertEqual(refusal(.snapshot, snapshot), "accepted")
        XCTAssertEqual(snapshot["mode"], .string("none"))
        XCTAssertEqual(snapshot["state"], .string("idle"))
        XCTAssertEqual(snapshot["itemId"], .null)
        XCTAssertEqual(snapshot["durationSec"], .null)
        XCTAssertEqual(snapshot["session"], .string("inactive"))
        XCTAssertEqual(snapshot["holdPolicy"], .string("forever"))
        XCTAssertEqual(snapshot["effectiveRate"], .number(0))
        XCTAssertEqual(snapshot["v"], .number(1))
        XCTAssertEqual(snapshot["seq"], .number(1))
        XCTAssertEqual(snapshot["capturedAtWallMs"], .number(1_790_000_000_000))
        XCTAssertEqual(snapshot["capturedAtMonotonicMs"], .number(5_000))
        // A lastError the page must see survives into the snapshot.
        let failed = stamped(EngineSnapshot.body(core: EngineCore(), deck: .idle, lastError: "load"), seq: &stamper)
        XCTAssertEqual(failed["lastError"], .string("load"))
        XCTAssertEqual(refusal(.snapshot, failed), "accepted")
    }

    /// `seq` moves exactly when the content moved, never for the capture
    /// time alone (reference-engine.js `snapshot()`).
    /// TO SEE IT FAIL: bump `seq` on every stamp, or fold the capture stamps
    /// into the content key.
    func testSeqIsAContentVersion() {
        var stamper = SnapshotStamper()
        let body = EngineSnapshot.body(core: EngineCore(), deck: .idle, lastError: nil)
        let first = stamper.stamp(body, wallMs: 1, monoMs: 1)
        let again = stamper.stamp(body, wallMs: 2_000, monoMs: 2_000)
        XCTAssertTrue(first.changed)
        XCTAssertFalse(again.changed, "only the capture time moved")
        XCTAssertEqual(again.snapshot["seq"], .number(1))
        XCTAssertEqual(again.snapshot["capturedAtWallMs"], .number(2_000))
        let moved = stamper.stamp(EngineSnapshot.body(core: EngineCore(), deck: .idle, lastError: "chain-start"),
                                  wallMs: 3_000, monoMs: 3_000)
        XCTAssertTrue(moved.changed)
        XCTAssertEqual(moved.snapshot["seq"], .number(2))
    }

    // MARK: - The coalescer (§5.4)

    /// Visible: the first change goes at once, the rest of the second waits,
    /// and the latest goes when the window closes. A window that closes on
    /// nothing new sends nothing.
    /// TO SEE IT FAIL: emit on every `changed()`, or forget `dirty` so a
    /// closing window re-sends an unchanged snapshot.
    func testVisibleChangesGoAtMostOncePerWindow() {
        var coalescer = SnapshotCoalescer()
        XCTAssertEqual(coalescer.changed(), [.emit, .openWindow(ms: 1000)])
        for _ in 0..<50 { XCTAssertEqual(coalescer.changed(), []) }
        XCTAssertEqual(coalescer.windowClosed(), [.emit, .openWindow(ms: 1000)], "the latest, once")
        XCTAssertEqual(coalescer.windowClosed(), [], "nothing new, nothing sent")
        XCTAssertEqual(coalescer.changed(), [.emit, .openWindow(ms: 1000)])
        XCTAssertEqual(EngineBridgeRules.snapshotEventMinMs, 1000)
    }

    /// Hidden: a thousand changes and every window closing send nothing; the
    /// page coming back into view gets exactly one, at once, even with a
    /// window left open from before it hid. Visible to visible is only a
    /// change, so a page repeating `setPageVisible(true)` cannot beat 1 Hz.
    /// TO SEE IT FAIL: drop `visible` from `pump`'s guard, or keep a stale
    /// window on hidden -> visible.
    func testHiddenSendsNothingAndVisibleSendsOne() {
        var coalescer = SnapshotCoalescer()
        XCTAssertEqual(coalescer.changed(), [.emit, .openWindow(ms: 1000)])
        XCTAssertEqual(coalescer.setVisible(false), [])
        var steps: [SnapshotCoalescer.Step] = []
        for index in 0..<1000 {
            steps += coalescer.changed()
            if index % 100 == 0 { steps += coalescer.windowClosed() }
        }
        XCTAssertEqual(steps, [], "nothing leaves while hidden")
        XCTAssertEqual(coalescer.setVisible(true), [.emit, .openWindow(ms: 1000)], "one snapshot on visible")
        XCTAssertEqual(coalescer.setVisible(true), [], "already visible: the window holds it")
        XCTAssertEqual(coalescer.windowClosed(), [.emit, .openWindow(ms: 1000)])
    }

    // MARK: - engineHello

    /// Both answers are ones the page's decoder takes; the native one carries
    /// everything `HelloResponse` requires of it.
    /// TO SEE IT FAIL: drop `ownedKeyPrefixes` or `protocol` from
    /// `nativeHello`, or answer the legacy lane with mode `js`.
    func testHelloAnswersAreContractValid() {
        let legacy = EngineBridgeRules.legacyHello(reason: .notBuilt)
        XCTAssertEqual(refusal(.helloResponse, legacy), "accepted")
        XCTAssertEqual(legacy["mode"], .string("legacy"))
        XCTAssertEqual(legacy["protocol"], .number(1))

        var stamper = SnapshotStamper()
        let native = EngineBridgeRules.nativeHello(
            reason: .buildDefault, capabilities: [.continuation],
            snapshot: stamped(EngineSnapshot.body(core: EngineCore(), deck: .idle, lastError: nil), seq: &stamper),
            pendingAdvances: [], pendingEvents: [])
        XCTAssertEqual(refusal(.helloResponse, native), "accepted")
        XCTAssertEqual(native["engineVersion"], .string(EngineBridgeRules.engineVersion))
        XCTAssertEqual(native["capabilities"], .array([.string("continuation")]))
        XCTAssertEqual(native["ownedKeyPrefixes"], .array(EngineContract.ownedPrefixes.map { JSONNode.string($0) }))
    }

    /// The hello's capabilities are the plist's ∩ what the binary may
    /// advertise, in the contract's order; no plist key is none.
    /// NE-27b: the M1 binary advertises episode, continuation and restore,
    /// never `foray` (M2); coverage.test.js refuses any of them whose families
    /// still owe work.
    /// TO SEE IT FAIL: return the plist's list as is, drop `episode` or
    /// `restore` from the advertised list, or advertise `foray` before M2.
    func testCapabilitiesAreThePlistsIntersectedWithTheAdvertised() {
        XCTAssertEqual(EngineBridgeRules.capabilities(declared: nil), [])
        XCTAssertEqual(EngineBridgeRules.capabilities(declared: []), [])
        XCTAssertEqual(EngineBridgeRules.capabilities(declared: ["foray", "bogus", "continuation", "episode"]), [.episode, .continuation])
        XCTAssertEqual(EngineBridgeRules.capabilities(declared: ["restore", "continuation", "episode", "foray"]),
                       [.episode, .continuation, .restore], "the contract's order, not the plist's; foray is not advertised")
        XCTAssertEqual(EngineBridgeRules.capabilities(declared: ["continuation"]), [.continuation])
        XCTAssertEqual(EngineBridgeRules.advertisedCapabilities, ["episode", "continuation", "restore"])
        XCTAssertFalse(EngineBridgeRules.advertisedCapabilities.contains("foray"), "foray waits for M2 (NE-30s)")
        XCTAssertEqual(EngineBridgeRules.requiredCapability(.probeSession), nil)
        XCTAssertEqual(EngineBridgeRules.requiredCapability(.purge), nil)
    }

    // MARK: - engineSend, engineRead and the events

    /// `{ok, reason?, snapshot}`, the reason from the closed set.
    /// TO SEE IT FAIL: pass a core failure string through unchecked, or send
    /// `ok: false` with no reason.
    func testSendRepliesAreContractValid() {
        var stamper = SnapshotStamper()
        let snapshot = stamped(EngineSnapshot.body(core: EngineCore(), deck: .idle, lastError: nil), seq: &stamper)
        let ok = EngineBridgeRules.sendResponse(refusal: EngineBridgeRules.refusal(for: []), snapshot: snapshot)
        XCTAssertEqual(refusal(.sendResponse, ok), "accepted")
        XCTAssertEqual(ok["ok"], .bool(true))
        XCTAssertNil(ok["reason"])

        XCTAssertEqual(EngineBridgeRules.refusal(for: ["engine-busy"]), .engineBusy)
        XCTAssertEqual(EngineBridgeRules.refusal(for: ["session-failed:cannot-interrupt-others"]), .sessionFailedCannotInterruptOthers)
        XCTAssertEqual(EngineBridgeRules.refusal(for: ["not a token", "no-next"]), .noNext)
        XCTAssertEqual(EngineBridgeRules.refusal(for: ["not a token"]), .unknownCmd)
        let refused = EngineBridgeRules.sendResponse(refusal: .engineBusy, snapshot: snapshot)
        XCTAssertEqual(refusal(.sendResponse, refused), "accepted")
        XCTAssertEqual(refused["reason"], .string("engine-busy"))
    }

    /// Rows are key -> stored string, sorted; the ring is DiagRow objects,
    /// header first, exactly as the file holds them.
    /// TO SEE IT FAIL: hand rows back parsed, or build a diagnostics row by
    /// hand instead of `DiagRow.node`.
    func testReadRepliesAreContractValid() {
        let rows = EngineBridgeRules.rowsResponse(["cp_pos:b": "{\"s\":2}", "cp_pos:a": "{\"s\":1}"])
        XCTAssertEqual(refusal(.rowsResponse, rows), "accepted")
        XCTAssertEqual(rows["rows"]?.members?.map(\.key), ["cp_pos:a", "cp_pos:b"])

        let row = DiagRow(seq: 7, wallMs: 1_790_000_000_000, monoMs: 12, kind: "cmd",
                          fields: [JSONMember("cmd", .string("play")), JSONMember("seq", .number(99))])
        let diagnostics = EngineBridgeRules.diagnosticsResponse([row])
        XCTAssertEqual(refusal(.diagnosticsResponse, diagnostics), "accepted")
        XCTAssertEqual(diagnostics["rows"]?.arrayValue?.first.map(JSWriter.stringify), row.line(),
                       "the page reads the row the file holds, byte for byte")
    }

    /// Every event the bridge can send is one the page's decoder takes.
    /// TO SEE IT FAIL: send `modeChanged` without its reason, or an `error`
    /// without its code.
    func testEventsAreContractValid() {
        var stamper = SnapshotStamper()
        let snapshot = stamped(EngineSnapshot.body(core: EngineCore(), deck: .idle, lastError: nil), seq: &stamper)
        let events = [
            EngineBridgeRules.snapshotEvent(snapshot),
            EngineBridgeRules.event(.error(code: "chain-start", message: "hop x carries no playable item")),
            EngineBridgeRules.modeChangedEvent(reason: .downgrade),
            EngineBridgeRules.diagEvent(DiagRow(seq: 1, wallMs: 1, monoMs: 1, kind: "fault",
                                                fields: [JSONMember("kind", .string("implicit-activation"))]))
        ]
        for event in events {
            XCTAssertEqual(refusal(.event, event), "accepted", JSWriter.stringify(event))
            XCTAssertTrue(EngineContract.EventType.allCases.map(\.rawValue).contains(event["type"]?.stringValue ?? ""))
        }
        XCTAssertEqual(EngineBridgeRules.eventName, "engine")
    }
}
