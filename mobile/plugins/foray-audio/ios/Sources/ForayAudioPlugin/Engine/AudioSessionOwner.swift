import Foundation
import AVFAudio
import ForayEngineCore
import os

/// The part of `AVAudioSession` the owner touches. `AVAudioSession` conforms
/// below with its own methods; the XCTests hand the owner a recording fake, so
/// "no activation at boot" and "a pause deactivates nothing" are counts on the
/// fake rather than claims about a Simulator's shared session.
protocol AudioSessionAPI: AnyObject {
    func setCategory(_ category: AVAudioSession.Category, mode: AVAudioSession.Mode,
                     policy: AVAudioSession.RouteSharingPolicy, options: AVAudioSession.CategoryOptions) throws
    func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws
    /// Another app's audio would be silenced by ours right now. Holding the
    /// session through a pause (S-4) is exactly when this bites, so every row
    /// the owner writes carries it (plan §4.4, OQ-12's evidence).
    var secondaryAudioShouldBeSilencedHint: Bool { get }
    /// The current route's outputs, as the rows and the route rules read them.
    var outputPorts: [AudioSessionOwner.Port] { get }
}

extension AVAudioSession: AudioSessionAPI {
    var outputPorts: [AudioSessionOwner.Port] {
        currentRoute.outputs.map { AudioSessionOwner.Port(type: $0.portType.rawValue, name: $0.portName) }
    }
}

/// THE ONE OWNER OF THE AUDIO SESSION in native mode (card NE-16;
/// docs/native-engine-plan.md §4.4): the real `SessionControlling`.
///
/// It DECIDES NOTHING. Whether to activate, when to deactivate, and whether
/// to tell other apps is `SessionPolicy`'s table (fixture-pinned in the
/// `session` family) carried out by `EngineCore`; this type runs the action
/// it is handed and reports what the system said. That split is the point:
/// the three earlier owners (the legacy hold, ForayTts, WebKit's implicit
/// activation) each decided for themselves, and every car-test failure the
/// deck lists comes back to "who activated, and when".
///
///   - BOOT: category `.playback`, mode `.spokenAudio`, no options, and NO
///     activation (S-3: painting a restored Now Playing entry must not
///     silence the listener's other app). `.longFormAudio` route sharing
///     sits behind `Config.longFormAudio`, off until DV-8.
///   - ACTIVATE only when asked (the core asks only for a user-caused play,
///     S-1), synchronously, timed: `activateMs` rides back to the core in the
///     same turn and into every `session` row; a device p95 over 100 ms is what
///     would add the reserved CommandGate (plan §4.2).
///   - DEACTIVATE with `.notifyOthersOnDeactivation` only when the core says
///     notify (close, final end, data deletion); a hold that expired, or a
///     pause under `pauseHoldPolicy = none`, releases WITHOUT notify, so the
///     app 4a interrupted is not invited to take the car back mid-episode.
///   - OBSERVE interruptions (with `AVAudioSessionInterruptionReasonKey`),
///     route changes (port type recorded) and media-services resets, every
///     one through `addObserver(forName:object:queue: .main)`: route changes
///     are posted on a secondary thread, and the core's 500 ms route
///     attribution (plan §4.3) relies on arriving in order on main.
///
/// `phase` is what the adapters' implicit-activation guard reads (AVDeck's
/// `sessionIsActive`, plan §4.3): `.active` from a successful activation
/// until a deactivation, a session-losing interruption or a reset. It is the
/// OWNER'S view of the session, not the core's ruling: a late
/// `appWasSuspended` leaves it where it was, because only the core knows
/// whether the engine was running when it arrived (`stale=y`).
final class AudioSessionOwner: SessionControlling {

    /// One output port: the type goes in rows (`carAudio`, `bluetoothA2DP`),
    /// the name only into the core's known-car memory, never into a row
    /// (plan §10: port types instead of route names).
    struct Port: Equatable {
        var type: String
        var name: String
    }

    struct Config {
        /// DV-8's `.longFormAudio` route-sharing trial. OFF: `.spokenAudio`
        /// with default routing is Apple's podcast guidance, and the trial is
        /// an M3 card (NE-40).
        var longFormAudio: Bool
        /// Monotonic milliseconds, for `activateMs`.
        var monoMs: () -> Double
        /// Where the owner's `session` rows go (NE-19's ring, once the boot
        /// path wires it to `EngineOutput.diag`). Default: os.Logger.
        var diag: (DiagEntry) -> Void

        init(longFormAudio: Bool = false,
             monoMs: @escaping () -> Double = { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000 },
             diag: @escaping (DiagEntry) -> Void = AudioSessionOwner.logRow) {
            self.longFormAudio = longFormAudio
            self.monoMs = monoMs
            self.diag = diag
        }
    }

    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "ai.jwlabs.foura",
        category: "ForayEngine.AudioSessionOwner"
    )

    static func logRow(_ entry: DiagEntry) {
        let line = JSWriter.stringify(.object([JSONMember("kind", .string(entry.kind))] + entry.fields))
        logger.notice("\(line, privacy: .public)")
    }

    private let api: AudioSessionAPI
    private let center: NotificationCenter
    private let config: Config

    /// The owner's view of the session (see the type comment).
    private(set) var phase: SessionPolicy.Phase = .inactive

    init(api: AudioSessionAPI = AVAudioSession.sharedInstance(),
         center: NotificationCenter = .default,
         config: Config = Config()) {
        self.api = api
        self.center = center
        self.config = config
        applyCategory(why: "boot")
    }

    /// The route-sharing spelling for the `build` row (DV-8 reads it).
    var routeSharing: String { config.longFormAudio ? "longFormAudio" : "default" }

    /// The fields the `build` row carries for the session (plan §4.4: the
    /// hold policy is recorded in the build row; DV-8's route sharing too).
    /// The row itself is the boot path's (NE-19 / NE-24), which is why this
    /// is a value and not a write.
    func buildFields(holdPolicy: SessionPolicy.HoldPolicy) -> [JSONMember] {
        [JSONMember("hold", .string(holdPolicy.text)), JSONMember("routeSharing", .string(routeSharing))]
    }

    // MARK: - SessionControlling

    func activate() -> SessionActivation {
        let started = config.monoMs()
        var token: String?
        do {
            try api.setActive(true, options: [])
        } catch {
            token = Self.errorToken(code: (error as NSError).code)
        }
        let activateMs = Self.roundedMs(config.monoMs() - started)
        if token == nil { phase = .active }
        row("activated", [
            JSONMember("ok", .bool(token == nil)),
            JSONMember("token", token.map { JSONNode.string($0) } ?? .null),
            JSONMember("activateMs", .number(activateMs))
        ])
        return SessionActivation(ok: token == nil, error: token, activateMs: activateMs)
    }

    func deactivate(notifyOthers: Bool) {
        var ok = true
        do {
            try api.setActive(false, options: notifyOthers ? [.notifyOthersOnDeactivation] : [])
        } catch {
            ok = false
        }
        // A deactivation that failed left the session running, so it still
        // reads active: a play on it is owned, not an implicit activation.
        if ok { phase = .inactive }
        row("deactivated", [JSONMember("ok", .bool(ok)), JSONMember("notify", .bool(notifyOthers))])
    }

    func reapplyCategory() {
        applyCategory(why: "reapply")
    }

    /// After a media-services reset every AVFoundation object is gone, and
    /// the session with them: the owner forgets its activation (the core
    /// lands inactive and activates again on the next play). The category is
    /// the core's separate `reapplyCategory`; the decks are rebuilt by the
    /// core's `.unload`. The notification observers need nothing: they are
    /// on `NotificationCenter`, which survives the reset.
    func rebuild() {
        phase = .inactive
        row("rebuilt", [])
    }

    func observe(_ handler: @escaping (SessionEvent) -> Void) -> EngineObservation {
        let object = api as AnyObject
        let tokens = [
            center.addObserver(forName: AVAudioSession.interruptionNotification, object: object, queue: .main) { [weak self] note in
                self?.interruption(note, handler)
            },
            center.addObserver(forName: AVAudioSession.routeChangeNotification, object: object, queue: .main) { [weak self] note in
                self?.routeChange(note, handler)
            },
            center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: object, queue: .main) { [weak self] _ in
                self?.mediaServicesReset(handler)
            }
        ]
        return NotificationObservation(center: center, tokens: tokens)
    }

    // MARK: - Notifications, on main

    private func interruption(_ note: Notification, _ handler: (SessionEvent) -> Void) {
        let info = note.userInfo
        guard let event = Self.interruptionEvent(
            typeRaw: Self.uint(info?[AVAudioSessionInterruptionTypeKey]),
            reasonRaw: Self.uint(info?[AVAudioSessionInterruptionReasonKey]),
            optionsRaw: Self.uint(info?[AVAudioSessionInterruptionOptionKey])
        ) else {
            return row("notification", [JSONMember("name", .string("interruption")), JSONMember("parsed", .bool(false))])
        }
        switch event {
        case let .interruptionBegan(reason):
            // The system deactivated us, except for a muted built-in mic
            // (nothing of ours stopped) and a late appWasSuspended (the
            // core's call: stale or not). See the type comment.
            // Admitted exactly as the table admits it, so an absent reason
            // is `unknown` here too, and takes the session there.
            let admitted = SessionPolicy.interruptionReason(reason)
            if admitted != .builtInMicMuted, admitted != .appWasSuspended, phase == .active {
                phase = .lostToInterruption
            }
            row("notification", [JSONMember("name", .string("interruption")), JSONMember("type", .string("began")),
                                 JSONMember("reason", .string(admitted.rawValue))])
        case let .interruptionEnded(shouldResume):
            row("notification", [JSONMember("name", .string("interruption")), JSONMember("type", .string("ended")),
                                 JSONMember("shouldResume", .bool(shouldResume))])
        case .route, .mediaServicesReset:
            break
        }
        handler(event)
    }

    private func routeChange(_ note: Notification, _ handler: (SessionEvent) -> Void) {
        let info = note.userInfo
        let reasonRaw = Self.uint(info?[AVAudioSessionRouteChangeReasonKey])
        let previous = (info?[AVAudioSessionRouteChangePreviousRouteKey] as? AVAudioSessionRouteDescription)?
            .outputs.first.map { Port(type: $0.portType.rawValue, name: $0.portName) }
        let current = api.outputPorts.first
        guard let change = Self.routeChange(reasonRaw: reasonRaw, current: current, previous: previous) else {
            // A category or override change moves no device: written down
            // (DV-12 reads routes), not handed to the rules.
            return row("notification", [JSONMember("name", .string("route")),
                                        JSONMember("reason", reasonRaw.map { JSONNode.number(Double($0)) } ?? .null),
                                        JSONMember("port", current.map { JSONNode.string($0.type) } ?? .null),
                                        JSONMember("forwarded", .bool(false))])
        }
        row("notification", [JSONMember("name", .string("route")),
                             JSONMember("oldDeviceUnavailable", .bool(change.oldDeviceUnavailable)),
                             JSONMember("port", change.portType.map { JSONNode.string($0) } ?? .null),
                             JSONMember("forwarded", .bool(true))])
        handler(.route(change))
    }

    private func mediaServicesReset(_ handler: (SessionEvent) -> Void) {
        phase = .inactive
        row("notification", [JSONMember("name", .string("mediaServicesReset"))])
        handler(.mediaServicesReset)
    }

    // MARK: - Pure readings (the XCTests table them)

    /// An interruption notification as the core reads it. The reason token is
    /// the closed vocabulary's spelling; anything outside it (iOS 17's
    /// `routeDisconnected`, a reason a later iOS adds) is `unknown`, which
    /// `SessionPolicy.interruptionReason` treats like `default`: the session
    /// was taken. Nil when the notification carries no readable type.
    static func interruptionEvent(typeRaw: UInt?, reasonRaw: UInt?, optionsRaw: UInt?) -> SessionEvent? {
        guard let typeRaw, let type = AVAudioSession.InterruptionType(rawValue: typeRaw) else { return nil }
        switch type {
        case .began:
            return .interruptionBegan(reason: interruptionReasonToken(reasonRaw))
        case .ended:
            let options = AVAudioSession.InterruptionOptions(rawValue: optionsRaw ?? 0)
            return .interruptionEnded(shouldResume: options.contains(.shouldResume))
        @unknown default:
            return nil
        }
    }

    /// `AVAudioSessionInterruptionReasonKey` as a vocabulary token. Absent is
    /// nil (the core reads it as `unknown`).
    static func interruptionReasonToken(_ raw: UInt?) -> String? {
        guard let raw else { return nil }
        switch AVAudioSession.InterruptionReason(rawValue: raw) {
        case .default?: return Vocabulary.InterruptionReason.default.rawValue
        case .appWasSuspended?: return Vocabulary.InterruptionReason.appWasSuspended.rawValue
        case .builtInMicMuted?: return Vocabulary.InterruptionReason.builtInMicMuted.rawValue
        default: return Vocabulary.InterruptionReason.unknown.rawValue
        }
    }

    /// A route change the rules act on: a device went away (headphones out,
    /// the car switched off: the LOST port is the one that matters) or one
    /// arrived (the car connecting: the NEW port). Every other reason
    /// (category, override, wake, configuration) is nil.
    static func routeChange(reasonRaw: UInt?, current: Port?, previous: Port?) -> RouteChange? {
        guard let reasonRaw, let reason = AVAudioSession.RouteChangeReason(rawValue: reasonRaw) else { return nil }
        let car = AVAudioSession.Port.carAudio.rawValue
        switch reason {
        case .oldDeviceUnavailable:
            return RouteChange(oldDeviceUnavailable: true, routeName: previous?.name,
                               isCarRoute: previous?.type == car, portType: previous?.type)
        case .newDeviceAvailable:
            return RouteChange(oldDeviceUnavailable: false, routeName: current?.name,
                               isCarRoute: current?.type == car, portType: current?.type)
        default:
            return nil
        }
    }

    /// `setActive(true)`'s failure as the closed session-error token.
    static func errorToken(code: Int) -> String {
        if code == AVAudioSession.ErrorCode.cannotInterruptOthers.rawValue {
            return Vocabulary.SessionError.cannotInterruptOthers.rawValue
        }
        if code == AVAudioSession.ErrorCode.cannotStartPlaying.rawValue {
            return Vocabulary.SessionError.cannotStartPlaying.rawValue
        }
        return Vocabulary.SessionError.other.rawValue
    }

    // MARK: - Private

    private func applyCategory(why: String) {
        var ok = true
        do {
            try api.setCategory(.playback, mode: .spokenAudio,
                                policy: config.longFormAudio ? .longFormAudio : .default, options: [])
        } catch {
            ok = false
        }
        row("category", [JSONMember("why", .string(why)), JSONMember("ok", .bool(ok)),
                         JSONMember("routeSharing", .string(routeSharing))])
    }

    /// Every owner row: `session kind=<kind>`, its fields, then the phase and
    /// the silence hint (plan §4.4: every session row carries it).
    private func row(_ kind: String, _ fields: [JSONMember]) {
        config.diag(DiagEntry(kind: "session", fields: [JSONMember("kind", .string(kind))] + fields + [
            JSONMember("phase", .string(phase.rawValue)),
            JSONMember("hint", .bool(api.secondaryAudioShouldBeSilencedHint))
        ]))
    }

    /// One decimal: sub-millisecond noise is not a measurement.
    private static func roundedMs(_ ms: Double) -> Double {
        ms.isFinite ? (max(0, ms) * 10).rounded() / 10 : 0
    }

    /// userInfo numbers arrive as NSNumber from the system and as UInt from a
    /// test; both read the same.
    private static func uint(_ value: Any?) -> UInt? {
        if let value = value as? UInt { return value }
        if let number = value as? NSNumber { return number.uintValue }
        return nil
    }
}

/// Block observers, removed together, once (host teardown): the owner's
/// three, and BackgroundGrace's two lifecycle observers (NE-16g).
final class NotificationObservation: EngineObservation {
    private let center: NotificationCenter
    private var tokens: [NSObjectProtocol]

    init(center: NotificationCenter, tokens: [NSObjectProtocol]) {
        self.center = center
        self.tokens = tokens
    }

    func cancel() {
        tokens.forEach { center.removeObserver($0) }
        tokens = []
    }

    deinit {
        cancel()
    }
}
