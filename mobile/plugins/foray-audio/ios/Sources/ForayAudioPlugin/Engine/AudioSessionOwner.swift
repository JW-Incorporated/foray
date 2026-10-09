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
    /// Another app is playing audio right now (`AVAudioSession`'s own
    /// property). Written into every interruption row: an interruption that
    /// began while another app's audio was already playing, and never ended,
    /// is another media app taking over; a call or Siri shows as the output
    /// port moving to the call profile instead.
    var isOtherAudioPlaying: Bool { get }
}

extension AVAudioSession: AudioSessionAPI {
    var outputPorts: [AudioSessionOwner.Port] {
        currentRoute.outputs.map { AudioSessionOwner.Port(type: $0.portType.rawValue, uid: $0.uid) }
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
///     sits behind `Config.longFormAudio`, which the boot sets from
///     `EngineConfig.routeSharingLongForm` (NE-40): OFF unless the Developer
///     row stored the DV-8 trial, and then only from the next launch.
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

    /// One output port: the type goes in rows (`CarAudio`,
    /// `BluetoothA2DPOutput`); the UID only to the core, which hashes it with
    /// the install's salt before its known-route memory keeps it (NE-38rs), so
    /// it never reaches a row (plan §10: port types instead of identities).
    /// The port's NAME is not read at all: it is often its owner's.
    struct Port: Equatable {
        var type: String
        var uid: String
    }

    struct Config {
        /// DV-8's `.longFormAudio` route-sharing trial. OFF: `.spokenAudio`
        /// with default routing is Apple's podcast guidance, and M1's car win
        /// happened on it. NE-40's Developer row turns it on for a drive
        /// (`EngineConfig.routeSharingLongForm`, read at the boot).
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
        var token: String?
        do {
            try api.setActive(false, options: notifyOthers ? [.notifyOthersOnDeactivation] : [])
        } catch {
            token = Self.errorToken(code: (error as NSError).code)
        }
        let ok = token == nil
        // A deactivation that failed left the session running, so it still
        // reads active: a play on it is owned, not an implicit activation.
        if ok { phase = .inactive }
        // L13: WHY it failed, on failure only (`is-busy` is I/O still running).
        row("deactivated", [JSONMember("ok", .bool(ok)), JSONMember("notify", .bool(notifyOthers))]
            + (token.map { [JSONMember("token", .string($0))] } ?? []))
    }

    func reapplyCategory() {
        applyCategory(why: "reapply")
    }

    /// After a media-services reset every AVFoundation object is gone, and
    /// the session with them: the owner forgets its activation (the core
    /// lands inactive and activates again on the next play). The category is
    /// the core's separate `reapplyCategory`. The players are the shell's to
    /// rebuild, right after this (the host's `.sessionRebuild`: both decks,
    /// the narration voice's engine, the jingle); the core's `.unload` only
    /// detaches the item. The notification observers need nothing: they are
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
                                 JSONMember("reason", .string(admitted.rawValue))] + interrupterFields())
        case let .interruptionEnded(shouldResume):
            row("notification", [JSONMember("name", .string("interruption")), JSONMember("type", .string("ended")),
                                 JSONMember("shouldResume", .bool(shouldResume))] + interrupterFields())
        case .route, .mediaServicesReset:
            break
        }
        handler(event)
    }

    /// Who is likely to have taken the session (the 2026-09-28 paste could
    /// not say): whether another app is playing, and where our output goes
    /// now (`BluetoothHFP` while a call or Siri holds a car or headset).
    /// Port TYPE only, as every row (see `routePorts`).
    private func interrupterFields() -> [JSONMember] {
        [JSONMember("otherAudio", .bool(api.isOtherAudioPlaying)),
         JSONMember("port", api.outputPorts.first.map { JSONNode.string($0.type) } ?? .null)]
    }

    private func routeChange(_ note: Notification, _ handler: (SessionEvent) -> Void) {
        let info = note.userInfo
        let reasonRaw = Self.uint(info?[AVAudioSessionRouteChangeReasonKey])
        let previous = (info?[AVAudioSessionRouteChangePreviousRouteKey] as? AVAudioSessionRouteDescription)?
            .outputs.first.map { Port(type: $0.portType.rawValue, uid: $0.uid) }
        let current = api.outputPorts.first
        guard let change = Self.routeChange(reasonRaw: reasonRaw, current: current, previous: previous) else {
            // A category or override change moves no device: written down
            // (DV-12 reads routes), not handed to the rules.
            return row("notification", [JSONMember("name", .string("route")),
                                        JSONMember("reason", reasonRaw.map { JSONNode.number(Double($0)) } ?? .null)]
                       + Self.routePorts(current: current, previous: previous)
                       + [JSONMember("forwarded", .bool(false))])
        }
        row("notification", [JSONMember("name", .string("route")),
                             JSONMember("oldDeviceUnavailable", .bool(change.oldDeviceUnavailable))]
            + Self.routePorts(current: current, previous: previous)
            + [JSONMember("forwarded", .bool(true))])
        handler(.route(change))
    }

    /// L14: BOTH ends of every route row, `port` (where the audio goes now)
    /// and `prevPort` (where it went before), so a paste can tell the car
    /// connecting (`builtInSpeaker` -> `carAudio`) from a Bluetooth head unit
    /// (`bluetoothA2DP`) and from the call profile taking over
    /// (`bluetoothHFP`). Before this, a forwarded row carried only the port
    /// the rules acted on, and a category change only the current one.
    /// PORT TYPES ONLY: `Port.name` never enters a row, because the name of
    /// a car or a headset is often its owner's. DiagGate admits both values
    /// as tokens (letters and digits, which every port type is).
    static func routePorts(current: Port?, previous: Port?) -> [JSONMember] {
        [JSONMember("port", current.map { JSONNode.string($0.type) } ?? .null),
         JSONMember("prevPort", previous.map { JSONNode.string($0.type) } ?? .null)]
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
    /// (category, override, wake, configuration) is nil. The port's type, its
    /// UID and its class (`RouteResume.routeClass`: car, bluetooth, other)
    /// ride to the core, which keys a known route by a salted hash of type and
    /// UID (NE-38rs).
    static func routeChange(reasonRaw: UInt?, current: Port?, previous: Port?) -> RouteChange? {
        guard let reasonRaw, let reason = AVAudioSession.RouteChangeReason(rawValue: reasonRaw) else { return nil }
        let port: Port?
        switch reason {
        case .oldDeviceUnavailable: port = previous
        case .newDeviceAvailable: port = current
        default: return nil
        }
        return RouteChange(oldDeviceUnavailable: reason == .oldDeviceUnavailable, portType: port?.type,
                           portUID: port?.uid, routeClass: RouteResume.routeClass(port?.type))
    }

    /// Where our audio goes now (the current route's first output), for the
    /// host's `EngineNow.route` (NE-38rs: the route a playing deck is heard
    /// through).
    var currentRoute: RoutePort? {
        api.outputPorts.first.map { RoutePort(portType: $0.type, uid: $0.uid) }
    }

    /// Every `AVAudioSession.ErrorCode` the rows name (L13), paired with its
    /// token in the closed DETAIL set (player/engine-vocabulary.js
    /// `SESSION_ERROR_DETAILS`). A table, so the XCTests walk the same pairs.
    static let errorTokens: [(code: AVAudioSession.ErrorCode, token: Vocabulary.SessionErrorDetail)] = [
        (.cannotInterruptOthers, .cannotInterruptOthers),
        (.cannotStartPlaying, .cannotStartPlaying),
        (.insufficientPriority, .insufficientPriority),
        (.isBusy, .isBusy),
        (.siriIsRecording, .siriIsRecording),
        (.mediaServicesFailed, .mediaServicesFailed),
        (.expiredSession, .expiredSession),
        (.missingEntitlement, .missingEntitlement),
        (.resourceNotAvailable, .resourceNotAvailable),
        (.incompatibleCategory, .incompatibleCategory),
        (.sessionNotActive, .sessionNotActive)
    ]

    /// An `AVAudioSession` failure (activation, deactivation, category) as
    /// the closed session-error DETAIL token; any other code is `other`.
    /// Before L13 everything but the first two was `other`, and every car
    /// record said `failed` with no cause.
    ///
    /// THE CONTRACT DOES NOT GROW. `activate()` hands this token to the core,
    /// whose `SessionPolicy.sessionFailedReason` admits it through the
    /// contract's three-token `SessionError` set: the page is answered
    /// `session-failed:cannot-interrupt-others`, `...:cannot-start-playing`,
    /// or `session-failed:other` for every other detail token, while the
    /// `session` row carries the precise one (AudioSessionOwnerTests pins the
    /// fold). The legacy plugin shares this mapping
    /// (`ForayAudioPlugin.sessionErrorToken`).
    static func errorToken(code: Int) -> String {
        (errorTokens.first { $0.code.rawValue == code }?.token ?? .other).rawValue
    }

    // MARK: - Private

    private func applyCategory(why: String) {
        var token: String?
        do {
            try api.setCategory(.playback, mode: .spokenAudio,
                                policy: config.longFormAudio ? .longFormAudio : .default, options: [])
        } catch {
            token = Self.errorToken(code: (error as NSError).code)
        }
        // L13: `token` on failure only, as the `deactivated` row carries it.
        row("category", [JSONMember("why", .string(why)), JSONMember("ok", .bool(token == nil)),
                         JSONMember("routeSharing", .string(routeSharing))]
            + (token.map { [JSONMember("token", .string($0))] } ?? []))
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
