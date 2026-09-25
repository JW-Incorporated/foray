import Foundation
import ForayEngineCore

/// What the bridge needs of the process's owner (`EngineOwnership`, NE-17):
/// the lane, the engine, and the three things only the owner may do (stand
/// the hello watchdog down, write the Developer override, run the one-way
/// relinquish with the legacy hand-over). A protocol so the bridge's tests
/// run over a fake owner and the NE-15h recording seams.
@MainActor
protocol EngineBridgeOwner: AnyObject {
    @discardableResult func decideOnce() -> EngineMode.Decision
    var engine: ForayEngine? { get }
    func helloReceived()
    func setModeOverride(_ mode: EngineMode.Override)
    @discardableResult func relinquish(cap: EngineContract.RelinquishCap, source: EngineSource) -> EngineVerdict
}

extension EngineOwnership: EngineBridgeOwner {}

/// What the bridge reads from the engine's store (NE-19) and hears from it.
protocol EngineRecords: AnyObject {
    /// The shared rows under these row-key prefixes, as stored.
    func sharedRows(prefixes: [String]) -> [String: String]
    /// The whole diagnostics ring, oldest first.
    var diagnosticRows: [DiagRow] { get }
    /// A ring row the page hears live (`EngineBridgeRules.liveDiagKinds`).
    var onLiveRow: ((DiagRow) -> Void)? { get set }
}

extension EngineStore: EngineRecords {
    var diagnosticRows: [DiagRow] { diagnostics.rows }
}

/// THE BRIDGE (card NE-20; docs/native-engine-plan.md §5.1-§5.4): what
/// `engineHello`, `engineSend` and `engineRead` answer, and which `engine`
/// events reach the page.
///
/// The plugin moves bytes (Capacitor's options in, a `JSObject` out, and
/// `notifyListeners`); everything the page is told is decided here, on main,
/// from the owner's lane and the engine's core. Every payload's shape is the
/// core's (`EngineBridgeRules`, `EngineSnapshot`), so the host `swift test`
/// checks each against the contract schema and this file never builds JSON
/// of its own.
///
/// ── ALWAYS AN ANSWER ─────────────────────────────────────────────────────
///
/// Each method returns a payload, never throws: an invalid send is `{ok:
/// false, reason: "unknown-cmd", snapshot}`, an invalid read reads nothing,
/// and a process with no engine (legacy, not built, relinquished) says so in
/// the hello and refuses sends with a reason.
///
/// ── EVENTS: COALESCED, AND ONLY TO A PAGE THAT IS LOOKING ────────────────
///
/// A hidden page is descheduled within seconds (FR-8), and a
/// `notifyListeners` into it is work for nobody. So nothing at all leaves
/// while the page is hidden; snapshots go at most once a second while it is
/// visible (`SnapshotCoalescer`), and the page reads on visible instead
/// (§5.4). What a hidden page missed that matters (walked hops, position
/// events) rides in the snapshot's counts and the hello's logs.
///
/// ── SEQUENCE GAPS ────────────────────────────────────────────────────────
///
/// Every valid send writes a `cmd` row with its source before anything can
/// no-op (D-4), and `seqGap: "y"` when its `cmdSeq` is not the last one plus
/// one: a command the page sent that never arrived, or a second page talking
/// to the same engine. A hello resets the count, because a new page starts
/// its own.
@MainActor
final class EngineBridge {

    /// The Info.plist key the build's capabilities are declared under
    /// (tools/mobile/inject-background-audio.mjs `ENGINE_CAPABILITIES_KEY`).
    nonisolated static let capabilitiesKey = "ForayEngineCapabilities"

    private let owner: EngineBridgeOwner
    private let records: EngineRecords?
    private let timing: EngineTiming
    private let declaredCapabilities: [String]?
    /// Where an event goes: the plugin's `notifyListeners("engine", ...)`.
    private let deliver: (JSONNode) -> Void

    private var stamper = SnapshotStamper()
    private var coalescer = SnapshotCoalescer()
    private var window: EngineObservation?
    private var lastCmdSeq: Int?
    private var lastError: String?
    private weak var hooked: ForayEngine?
    private var handBackAnnounced = false

    init(owner: EngineBridgeOwner, records: EngineRecords?, timing: EngineTiming,
         declaredCapabilities: [String]?, deliver: @escaping (JSONNode) -> Void) {
        self.owner = owner
        self.records = records
        self.timing = timing
        self.declaredCapabilities = declaredCapabilities
        self.deliver = deliver
        hookIfNeeded()
    }

    /// The build's declared capabilities ∩ what this binary may advertise.
    var capabilities: [EngineContract.Capability] {
        EngineBridgeRules.capabilities(declared: declaredCapabilities)
    }

    /// Whether events may leave (tests read it).
    var pageVisible: Bool { coalescer.visible }

    // MARK: - engineHello

    func hello(_ payload: JSONNode) -> JSONNode {
        // The page claimed the engine: the hello watchdog stands down (NE-17).
        owner.helloReceived()
        hookIfNeeded()
        if !EngineContract.accepts(.helloRequest, payload) {
            row("hello", [JSONMember("invalid", .string("y"))])
        }
        // A new page: its own command count, and a page that starts in view.
        // Its first snapshot is the one in this answer.
        lastCmdSeq = nil
        window?.cancel()
        window = nil
        coalescer = SnapshotCoalescer(visible: true)

        let decision = owner.decideOnce()
        guard let engine = liveEngine else { return EngineBridgeRules.legacyHello(reason: legacyReason(decision)) }
        let state = engine.state
        return EngineBridgeRules.nativeHello(reason: decision.reason, capabilities: capabilities, snapshot: snapshot(),
                                             pendingAdvances: state.advanceLog, pendingEvents: state.pendingEvents)
    }

    // MARK: - engineSend

    func send(_ payload: JSONNode) -> JSONNode {
        hookIfNeeded()
        let request: EngineContract.SendRequest
        do {
            request = try EngineContract.SendRequest(contract: payload)
        } catch {
            row("cmd", [JSONMember("invalid", .string("y")),
                        JSONMember("cmd", payload["cmd"]?.stringValue.map { JSONNode.string($0) } ?? .null)])
            return reply(.unknownCmd)
        }

        // D-4: the source is on record before anything can no-op.
        let gap = lastCmdSeq.map { request.cmdSeq != $0 + 1 } ?? false
        lastCmdSeq = request.cmdSeq
        var fields = [JSONMember("cmd", .string(request.command.name.rawValue)),
                      JSONMember("source", .string(request.source.rawValue)),
                      JSONMember("cmdSeq", .number(Double(request.cmdSeq)))]
        if gap { fields.append(JSONMember("seqGap", .string("y"))) }
        row("cmd", fields)

        let command = request.command
        // The Developer setting works in every lane: it is how a listener on
        // the web player asks for the native one at the next launch.
        if case let .setModeOverride(mode) = command {
            owner.setModeOverride(mode)
            return reply(nil)
        }
        guard let engine = liveEngine else {
            return reply(owner.engine?.isTornDown == true ? .relinquished : .capabilityOff)
        }
        if let needed = EngineBridgeRules.requiredCapability(command), !capabilities.contains(needed) {
            return reply(.capabilityOff)
        }

        let verdict: EngineVerdict
        if case let .relinquish(cap) = command {
            // The owner's, not the core's alone: it runs the legacy hand-over
            // after the core goes terminal (plan §4.6).
            verdict = owner.relinquish(cap: cap, source: request.source)
        } else {
            verdict = engine.handle(.command(command, source: request.source))
        }
        if case let .setPageVisible(visible) = command {
            apply(coalescer.setVisible(visible))
        }
        if case .playEpisode = command, verdict.ok { lastError = nil }
        return reply(EngineBridgeRules.refusal(for: verdict.failures))
    }

    // MARK: - engineRead

    func read(_ payload: JSONNode) -> JSONNode {
        hookIfNeeded()
        guard let request = try? EngineContract.ReadRequest(contract: payload) else {
            // An unowned or unknown prefix reads NOTHING rather than
            // something: shared rows only, and only the engine's.
            switch payload["what"]?.stringValue {
            case EngineContract.ReadKind.snapshot.rawValue: return snapshot()
            case EngineContract.ReadKind.diagnostics.rawValue: return EngineBridgeRules.diagnosticsResponse([])
            default: return EngineBridgeRules.rowsResponse([:])
            }
        }
        switch request.what {
        case .snapshot:
            return snapshot()
        case .rows:
            return EngineBridgeRules.rowsResponse(
                records?.sharedRows(prefixes: request.prefixes ?? EngineContract.ownedPrefixes) ?? [:])
        case .diagnostics:
            return EngineBridgeRules.diagnosticsResponse(records?.diagnosticRows ?? [])
        }
    }

    // MARK: - The engine

    /// The engine playing this process, while it still does.
    private var liveEngine: ForayEngine? {
        guard owner.decideOnce().mode == .native, let engine = owner.engine, !engine.isTornDown else { return nil }
        return engine
    }

    /// Why this process is not native: the owner's reason in the legacy
    /// lane; `downgrade` once the engine gave the process back; `not-built`
    /// for a native decision with no engine (which the owner never leaves
    /// standing, but a hello must still say something true).
    private func legacyReason(_ decision: EngineMode.Decision) -> Vocabulary.ModeReason {
        if decision.mode == .legacy { return decision.reason }
        return owner.engine == nil ? .notBuilt : .downgrade
    }

    /// Listen to the engine once it exists. Idempotent; a second engine
    /// cannot exist in a process (A-4).
    private func hookIfNeeded() {
        guard let engine = owner.engine, hooked !== engine else { return }
        hooked = engine
        engine.onTransition = { [weak self] in
            MainActor.assumeIsolated { self?.transitioned() }
        }
        engine.onEmit = { [weak self] event in
            MainActor.assumeIsolated { self?.engineEmitted(event) }
        }
        records?.onLiveRow = { [weak self] row in
            MainActor.assumeIsolated { self?.liveRow(row) }
        }
    }

    // MARK: - The snapshot

    private func snapshot() -> JSONNode {
        stamp().snapshot
    }

    private func stamp() -> (snapshot: JSONNode, changed: Bool) {
        let body: [JSONMember]
        if let engine = owner.engine, owner.decideOnce().mode == .native {
            // A torn-down engine still answers (its session reads
            // `relinquished`), but its deck is gone: nothing is loaded.
            let deck = engine.isTornDown ? DeckReading.idle : engine.seams.deck.reading
            body = EngineSnapshot.body(core: engine.coreValue, deck: deck, lastError: lastError)
        } else {
            body = EngineSnapshot.body(core: EngineCore(), deck: .idle, lastError: nil)
        }
        return stamper.stamp(body, wallMs: timing.wallMs, monoMs: timing.monoMs)
    }

    private func reply(_ refusal: EngineContract.Refusal?) -> JSONNode {
        EngineBridgeRules.sendResponse(refusal: refusal, snapshot: snapshot())
    }

    // MARK: - Events

    /// After every input the engine handled, and at its teardown.
    private func transitioned() {
        if let engine = owner.engine, engine.isTornDown, !handBackAnnounced {
            handBackAnnounced = true
            if coalescer.visible { deliver(EngineBridgeRules.modeChangedEvent(reason: .downgrade)) }
        }
        if stamp().changed { apply(coalescer.changed()) }
    }

    private func engineEmitted(_ event: EngineEvent) {
        if case let .error(code, _) = event { lastError = code }
        guard coalescer.visible else { return }
        deliver(EngineBridgeRules.event(event))
    }

    private func liveRow(_ row: DiagRow) {
        guard coalescer.visible else { return }
        deliver(EngineBridgeRules.diagEvent(row))
    }

    private func apply(_ steps: [SnapshotCoalescer.Step]) {
        for step in steps {
            switch step {
            case .emit:
                deliver(EngineBridgeRules.snapshotEvent(snapshot()))
            case let .openWindow(ms):
                window?.cancel()
                window = timing.schedule(afterMs: ms, repeating: false) { [weak self] in
                    MainActor.assumeIsolated { self?.windowClosed() }
                }
            }
        }
    }

    private func windowClosed() {
        window?.cancel()
        window = nil
        apply(coalescer.windowClosed())
    }

    // MARK: - Rows

    /// The bridge's rows go where the engine's go (its output, the ring).
    /// With no engine there is nowhere: the owner writes no rows before the
    /// cold path wires the ring (NE-24), so a deletion cannot miss one.
    private func row(_ kind: String, _ fields: [JSONMember]) {
        owner.engine?.seams.output.diag(DiagEntry(kind: kind, fields: fields))
    }

    /// The snapshot of no engine at all: what a reply carries when the
    /// plugin itself is gone (it never is; a reply must still be valid).
    nonisolated static func emptySnapshot() -> JSONNode {
        var stamper = SnapshotStamper()
        return stamper.stamp(EngineSnapshot.body(core: EngineCore(), deck: .idle, lastError: nil),
                             wallMs: 0, monoMs: 0).snapshot
    }

    // MARK: - Capacitor's options

    /// A call's options as the core reads JSON. Through `JSONSerialization`,
    /// which tells a boolean from a number (a bridged `NSNumber` cannot be
    /// asked reliably), then the core's own parser. Anything that is not a
    /// JSON object reads as `null`, which every decoder refuses.
    nonisolated static func payload(from options: [AnyHashable: Any]?) -> JSONNode {
        guard let options, JSONSerialization.isValidJSONObject(options),
              let data = try? JSONSerialization.data(withJSONObject: options),
              let text = String(data: data, encoding: .utf8),
              let node = try? JSONNode.parse(text) else { return .null }
        return node
    }
}
