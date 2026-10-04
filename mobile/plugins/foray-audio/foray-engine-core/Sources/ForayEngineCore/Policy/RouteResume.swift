import Foundation

// ── ROUTE RESUME: WHEN A CAR COMES BACK, DOES 4a PLAY AGAIN BY ITSELF? ──────
// (card NE-38rs; founder Q5, docs/DECISIONS.md 2026-09-25)
//
// THE REFERENCE is player/route-resume.js (NE-38rj), recorded as the
// `route-resume` parity family: `decision` is `routeResumeDecision`, `step`
// is the reducer `routeResumeStep` and `replay` is `routeResumeReplay`, line
// for line. EngineCore keeps a `State` and feeds it the same events the JS
// reducer takes, so "what last paused us" and "one resume per loss" are
// tracked the way the fixtures pin them.
//
// THE RULE. A route that comes back resumes playback ONLY when every one of
// these holds:
//   1. the last pause was a route loss (`pausedBy == .route`),
//   2. of THIS route: the key that came back is the key that was lost,
//   3. the route's class allows it: `car` always, `bluetooth` only with the
//      Bluetooth arm on (`EngineConfig.routeResumeBluetooth`, OFF), `other`
//      (headphones, the speaker, AirPlay...) never,
//   4. the route is known: our own audio has been heard through it,
//   5. the loss is at most `maxLostSec` old, on the WALL clock.
// A listener's pause is never resumed, and neither is one a call, Siri or
// the system made.
//
// KEYS (what this file adds to the JS). A route is known by its port type
// and its port UID, never its name (two cars of one model share a name, and
// a name is often its owner's). The engine stores and compares a SALTED
// SHA-256 of the two (`hashedKey`), with a per-install salt, and a row shows
// only its first 8 hex (`rowKey`), so no raw UID ever reaches the ring or a
// paste (DiagGate). The hash is written here in plain Swift because this
// package is Foundation-only and runs on Linux (engine-parity), where
// CryptoKit does not exist; RouteResumeTests pins it to the FIPS 180-4 test
// vectors.
//
// THE KNOWN SET. At most `knownCap` keys, least recently used first out,
// persisted by the host in the engine-private key `ForayEngine.knownRoutes`
// (`Stored`), never under `CapacitorStorage.`.
public enum RouteResume {

    /// `ROUTE_RESUME_MAX_LOST_SEC`: 24 h, provisional. The MEASURE tag lives
    /// on the JS constant (route-resume.js), which the generated one copies
    /// (docs/ios-native-engine-measurements.md §12): NE-38e's `route-back`
    /// verdict reads the `route kind=back lostSec=` rows, and NE-38f settles it.
    public static let maxLostSec: Double = EngineConstants.RouteResume.routeResumeMaxLostSec
    /// `ROUTE_RESUME_BLUETOOTH_DEFAULT`: OFF, provisional (tagged on the JS
    /// constant likewise): the ms from a Bluetooth route's `back` to the
    /// car's own `remote play` settles it. The engines take it as
    /// `EngineConfig.routeResumeBluetooth`.
    public static let bluetoothDefault: Bool = EngineConstants.RouteResume.routeResumeBluetoothDefault
    /// How long our audio must have been heard through a route (a `.playing`
    /// time-control while it was the current route) before it is known.
    public static let knownAfterMs: Double = 1_000
    /// The known set's size: a phone meets a handful of cars.
    public static let knownCap = 8
    /// The hex a row shows of a key.
    public static let rowKeyLength = 8

    // MARK: - Classes and keys (`routeClass`, `routeKey`)

    /// `"car" | "bluetooth" | "other"`.
    public enum RouteClass: String, Equatable, Sendable {
        case car
        case bluetooth
        case other
    }

    /// AVAudioSession.Port raw values (the JS module's CAR_PORTS and
    /// BLUETOOTH_PORTS).
    static let carPorts: Set<String> = ["CarAudio"]
    static let bluetoothPorts: Set<String> = ["BluetoothA2DPOutput", "BluetoothHFP", "BluetoothLE"]

    /// `routeClass(portType)`.
    public static func routeClass(_ portType: String?) -> RouteClass {
        guard let portType else { return .other }
        if carPorts.contains(portType) { return .car }
        if bluetoothPorts.contains(portType) { return .bluetooth }
        return .other
    }

    /// `routeKey(portType, uid)`: `"<port>|<uid>"`, unhashed, or nil when
    /// either is missing, so a UID-less port can never be matched or known.
    public static func routeKey(portType: String?, uid: String?) -> String? {
        guard let portType, !portType.isEmpty, let uid, !uid.isEmpty else { return nil }
        return "\(portType)|\(uid)"
    }

    /// The key the engine stores, compares and persists: the lowercase hex
    /// SHA-256 of the salt, a newline and `routeKey`. Nil exactly when
    /// `routeKey` is.
    public static func hashedKey(portType: String?, uid: String?, salt: String) -> String? {
        guard let key = routeKey(portType: portType, uid: uid) else { return nil }
        return SHA256.hex(Array("\(salt)\n\(key)".utf8))
    }

    /// What a row shows of a hashed key: its first 8 hex.
    public static func rowKey(_ hashed: String?) -> String? {
        hashed.map { String($0.prefix(rowKeyLength)) }
    }

    // MARK: - The decision (`routeResumeDecision`)

    /// What caused the last pause.
    public enum PausedBy: String, Equatable, Sendable {
        case route
        case listener
        case interruption
        case system
        case none
    }

    /// A route as the decision compares it.
    public struct Route: Equatable, Sendable {
        public var port: String?
        public var key: String?

        public init(port: String?, key: String?) {
            self.port = port
            self.key = key
        }
    }

    /// `{resume, why}`. `why` is a closed token, the `route kind=back` row's.
    public struct Decision: Equatable, Sendable {
        public let resume: Bool
        public let why: String

        public init(resume: Bool, why: String) {
            self.resume = resume
            self.why = why
        }
    }

    /// The `why` tokens (route-resume.js).
    public enum Why {
        public static let routeBack = "route-back"
        public static let listenerPaused = "listener-paused"
        public static let interrupted = "interrupted"
        public static let systemPaused = "system-paused"
        public static let notPaused = "not-paused"
        public static let noLoss = "no-loss"
        public static let otherRoute = "other-route"
        public static let notACar = "not-a-car"
        public static let bluetoothOff = "bluetooth-off"
        public static let unknownRoute = "unknown-route"
        public static let lossAgeUnknown = "loss-age-unknown"
        public static let lostTooLong = "lost-too-long"
    }

    /// `NOT_A_ROUTE_PAUSE[pausedBy] ?? "not-paused"`.
    static func notARoutePause(_ pausedBy: String?) -> String {
        switch pausedBy.flatMap(PausedBy.init(rawValue:)) {
        case .listener?: return Why.listenerPaused
        case .interruption?: return Why.interrupted
        case .system?: return Why.systemPaused
        default: return Why.notPaused
        }
    }

    private static func nonEmpty(_ text: String?) -> Bool { !(text?.isEmpty ?? true) }

    /// `routeResumeDecision({pausedBy, lost, back, known, lostAgoSec,
    /// bluetoothArm})`. `pausedBy` is a string as the JS takes it (anything
    /// that is not one of the five reads as `not-paused`); `lostAgoSec` nil
    /// is "not a finite number"; `bluetoothArm` nil is the default.
    public static func decision(pausedBy: String?, lost: Route?, back: Route?, known: Bool,
                                lostAgoSec: Double?, bluetoothArm: Bool?) -> Decision {
        // The founder's Q5 rule: only a pause the route itself caused is resumed.
        guard pausedBy == PausedBy.route.rawValue else { return Decision(resume: false, why: notARoutePause(pausedBy)) }
        guard let lost, nonEmpty(lost.key) else { return Decision(resume: false, why: Why.noLoss) }
        guard let back, nonEmpty(back.key), back.key == lost.key else { return Decision(resume: false, why: Why.otherRoute) }
        let cls = routeClass(back.port)
        if cls == .other { return Decision(resume: false, why: Why.notACar) }
        if cls == .bluetooth && (bluetoothArm ?? bluetoothDefault) != true {
            return Decision(resume: false, why: Why.bluetoothOff)
        }
        guard known else { return Decision(resume: false, why: Why.unknownRoute) }
        guard let age = lostAgoSec, age.isFinite, age >= 0 else { return Decision(resume: false, why: Why.lossAgeUnknown) }
        if age > maxLostSec { return Decision(resume: false, why: Why.lostTooLong) }
        return Decision(resume: true, why: Why.routeBack)
    }

    // MARK: - The bookkeeping (`routeResumeStep`, `routeResumeReplay`)

    /// The route whose loss paused us, and when (wall-clock seconds).
    public struct Loss: Equatable, Sendable {
        public var port: String?
        public var key: String?
        public var atSec: Double?

        public init(port: String?, key: String?, atSec: Double?) {
            self.port = port
            self.key = key
            self.atSec = atSec
        }
    }

    /// `routeResumeInitial({playing})`. `playing` is the engine's intent
    /// (playing, or loading to play), not what the speaker does this instant.
    public struct State: Equatable, Sendable {
        public var playing: Bool
        public var pausedBy: PausedBy
        public var lost: Loss?

        public init(playing: Bool = true) {
            self.playing = playing
            pausedBy = .none
            lost = nil
        }
    }

    /// One event the reducer takes. `atSec` is WALL-CLOCK seconds (`Date()`),
    /// never uptime, which stops while the phone sleeps: a phone asleep in a
    /// parked car overnight would read a two-day loss as minutes old.
    public enum Event: Equatable, Sendable {
        /// The route went away. Arms a resume only while playing.
        case lost(port: String?, key: String?, atSec: Double?)
        /// A route came back: asks `decision`.
        case back(port: String?, key: String?, known: Bool, atSec: Double?)
        /// Any press (the listener, the lock screen, the car's own buttons):
        /// `pause` pauses as the listener, `play` plays, anything else leaves
        /// a paused engine paused by the listener. Clears the loss.
        case press(command: String?)
        /// A call or Siri took the session.
        case interruption
        /// The system paused us (media services reset, the queue ended...).
        case system
        /// Our audio became audible, whatever started it.
        case playing
    }

    /// `routeResumeStep(state, event, {bluetoothArm})`. Pure.
    public static func step(_ state: State, _ event: Event, bluetoothArm: Bool? = nil) -> (state: State, decision: Decision?) {
        var s = state
        switch event {
        case let .lost(port, key, atSec):
            if s.playing {
                s.playing = false
                s.pausedBy = .route
                s.lost = Loss(port: port, key: key, atSec: atSec)
            }
            return (s, nil)
        case let .back(port, key, known, atSec):
            var age: Double?
            if let lost = s.lost, let lostAt = lost.atSec, let backAt = atSec { age = backAt - lostAt }
            let made = decision(pausedBy: s.pausedBy.rawValue, lost: s.lost.map { Route(port: $0.port, key: $0.key) },
                                back: Route(port: port, key: key), known: known, lostAgoSec: age,
                                bluetoothArm: bluetoothArm)
            if made.resume {
                // At most one resume per loss.
                s.playing = true
                s.pausedBy = .none
                s.lost = nil
            }
            return (s, made)
        case let .press(command):
            s.lost = nil
            if command == "pause" {
                s.playing = false
                s.pausedBy = .listener
            } else if command == "play" {
                s.playing = true
                s.pausedBy = .none
            } else if !s.playing {
                s.pausedBy = .listener
            }
            return (s, nil)
        case .interruption, .system:
            if s.playing || s.pausedBy == .route {
                s.playing = false
                s.pausedBy = event == .interruption ? .interruption : .system
            }
            s.lost = nil
            return (s, nil)
        case .playing:
            s.playing = true
            s.pausedBy = .none
            s.lost = nil
            return (s, nil)
        }
    }

    /// One decision of a replay, with the index of the `back` it answered.
    public struct ReplayDecision: Equatable, Sendable {
        public let event: Int
        public let decision: Decision
    }

    /// `routeResumeReplay(events, {bluetoothArm, playing})`: fold `events`
    /// through `step` from `State(playing:)`.
    public static func replay(_ events: [Event], bluetoothArm: Bool? = nil,
                              playing: Bool = true) -> (decisions: [ReplayDecision], resumes: Int) {
        var state = State(playing: playing)
        var decisions: [ReplayDecision] = []
        for (index, event) in events.enumerated() {
            let result = step(state, event, bluetoothArm: bluetoothArm)
            state = result.state
            if let made = result.decision { decisions.append(ReplayDecision(event: index, decision: made)) }
        }
        return (decisions, decisions.filter { $0.decision.resume }.count)
    }

    // MARK: - The known set

    /// The routes our audio has been heard through, least recently used
    /// first, at most `knownCap`. Only 64-hex keys (`hashedKey`'s shape) are
    /// ever held, so a stored value from anywhere else is dropped on load.
    public struct KnownRoutes: Equatable, Sendable {
        public private(set) var keys: [String]

        public init(_ keys: [String] = []) {
            var kept: [String] = []
            for key in keys where RouteResume.isHashedKey(key) {
                kept.removeAll { $0 == key }
                kept.append(key)
            }
            self.keys = Array(kept.suffix(RouteResume.knownCap))
        }

        public func contains(_ key: String?) -> Bool {
            guard let key else { return false }
            return keys.contains(key)
        }

        /// Our audio was heard through `key` again: it becomes the most
        /// recently used, and the least recently used goes past the cap.
        /// Returns whether the set (or its order) changed.
        @discardableResult
        public mutating func use(_ key: String) -> Bool {
            guard RouteResume.isHashedKey(key), keys.last != key else { return false }
            keys.removeAll { $0 == key }
            keys.append(key)
            if keys.count > RouteResume.knownCap { keys.removeFirst(keys.count - RouteResume.knownCap) }
            return true
        }
    }

    /// 64 lowercase hex characters.
    public static func isHashedKey(_ key: String) -> Bool {
        let scalars = key.unicodeScalars
        return scalars.count == 64 && scalars.allSatisfy(isLowerHex)
    }

    // MARK: - What the host persists (`ForayEngine.knownRoutes`)

    /// The private key's value: `{"v":1,"salt":"<hex>","keys":[...]}`. The
    /// salt is per install and lives beside the keys it made, so a purge
    /// (which removes the key) takes both.
    public struct Stored: Equatable, Sendable {
        public static let version = 1
        public let salt: String
        public let keys: [String]

        public init(salt: String, keys: [String]) {
            self.salt = salt
            self.keys = KnownRoutes(keys).keys
        }

        /// Nil for nothing stored, or anything this build cannot trust: the
        /// host then starts a new salt and an empty set.
        public static func parse(_ text: String?) -> Stored? {
            guard let text, !text.isEmpty, let node = try? JSONNode.parse(text),
                  node["v"]?.numberValue == Double(version),
                  let salt = node["salt"]?.stringValue, isSalt(salt),
                  let keys = node["keys"]?.arrayValue else { return nil }
            return Stored(salt: salt, keys: keys.compactMap(\.stringValue))
        }

        public var serialized: String {
            JSWriter.stringify(.object([
                JSONMember("v", .number(Double(Stored.version))),
                JSONMember("salt", .string(salt)),
                JSONMember("keys", .array(keys.map { JSONNode.string($0) }))
            ]))
        }
    }

    /// A salt: 32 lowercase hex characters (16 random bytes).
    public static func isSalt(_ text: String) -> Bool {
        let scalars = text.unicodeScalars
        return scalars.count == 32 && scalars.allSatisfy(isLowerHex)
    }

    static func isLowerHex(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x30...0x39, 0x61...0x66: return true // 0-9 a-f
        default: return false
        }
    }

    /// A new per-install salt.
    public static func newSalt() -> String {
        var generator = SystemRandomNumberGenerator()
        return (0..<16).map { _ in UInt8.random(in: 0...255, using: &generator) }
            .map { SHA256.hexByte($0) }.joined()
    }

    // MARK: - SHA-256 (FIPS 180-4), for `hashedKey`

    enum SHA256 {
        static let initial: [UInt32] = [
            0x6a09_e667, 0xbb67_ae85, 0x3c6e_f372, 0xa54f_f53a, 0x510e_527f, 0x9b05_688c, 0x1f83_d9ab, 0x5be0_cd19
        ]

        static let rounds: [UInt32] = [
            0x428a_2f98, 0x7137_4491, 0xb5c0_fbcf, 0xe9b5_dba5, 0x3956_c25b, 0x59f1_11f1, 0x923f_82a4, 0xab1c_5ed5,
            0xd807_aa98, 0x1283_5b01, 0x2431_85be, 0x550c_7dc3, 0x72be_5d74, 0x80de_b1fe, 0x9bdc_06a7, 0xc19b_f174,
            0xe49b_69c1, 0xefbe_4786, 0x0fc1_9dc6, 0x240c_a1cc, 0x2de9_2c6f, 0x4a74_84aa, 0x5cb0_a9dc, 0x76f9_88da,
            0x983e_5152, 0xa831_c66d, 0xb003_27c8, 0xbf59_7fc7, 0xc6e0_0bf3, 0xd5a7_9147, 0x06ca_6351, 0x1429_2967,
            0x27b7_0a85, 0x2e1b_2138, 0x4d2c_6dfc, 0x5338_0d13, 0x650a_7354, 0x766a_0abb, 0x81c2_c92e, 0x9272_2c85,
            0xa2bf_e8a1, 0xa81a_664b, 0xc24b_8b70, 0xc76c_51a3, 0xd192_e819, 0xd699_0624, 0xf40e_3585, 0x106a_a070,
            0x19a4_c116, 0x1e37_6c08, 0x2748_774c, 0x34b0_bcb5, 0x391c_0cb3, 0x4ed8_aa4a, 0x5b9c_ca4f, 0x682e_6ff3,
            0x748f_82ee, 0x78a5_636f, 0x84c8_7814, 0x8cc7_0208, 0x90be_fffa, 0xa450_6ceb, 0xbef9_a3f7, 0xc671_78f2
        ]

        static func rotr(_ x: UInt32, _ n: UInt32) -> UInt32 {
            (x >> n) | (x << (32 - n))
        }

        static func digest(_ message: [UInt8]) -> [UInt8] {
            var data = message
            let bitLength = UInt64(message.count) &* 8
            data.append(0x80)
            while data.count % 64 != 56 { data.append(0) }
            for shift in stride(from: 56, through: 0, by: -8) {
                data.append(UInt8(truncatingIfNeeded: bitLength >> UInt64(shift)))
            }
            var hash = initial
            var w = [UInt32](repeating: 0, count: 64)
            for chunk in stride(from: 0, to: data.count, by: 64) {
                for i in 0..<16 {
                    let at = chunk + 4 * i
                    let b0 = UInt32(data[at]) << 24
                    let b1 = UInt32(data[at + 1]) << 16
                    let b2 = UInt32(data[at + 2]) << 8
                    let b3 = UInt32(data[at + 3])
                    w[i] = b0 | b1 | b2 | b3
                }
                for i in 16..<64 {
                    // w[i-15] (spelled so: the core holds no literal 15, NE-12s)
                    let x: UInt32 = w[i + 1 - 16]
                    let y: UInt32 = w[i - 2]
                    let s0: UInt32 = rotr(x, 7) ^ rotr(x, 18) ^ (x >> 3)
                    let s1: UInt32 = rotr(y, 17) ^ rotr(y, 19) ^ (y >> 10)
                    let sum: UInt32 = w[i - 16] &+ s0
                    w[i] = sum &+ w[i - 7] &+ s1
                }
                var a = hash[0], b = hash[1], c = hash[2], d = hash[3]
                var e = hash[4], f = hash[5], g = hash[6], h = hash[7]
                for i in 0..<64 {
                    let bigS1: UInt32 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
                    let choose: UInt32 = (e & f) ^ (~e & g)
                    let partial: UInt32 = h &+ bigS1 &+ choose
                    let t1: UInt32 = partial &+ rounds[i] &+ w[i]
                    let bigS0: UInt32 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
                    let majority: UInt32 = (a & b) ^ (a & c) ^ (b & c)
                    let t2: UInt32 = bigS0 &+ majority
                    h = g
                    g = f
                    f = e
                    e = d &+ t1
                    d = c
                    c = b
                    b = a
                    a = t1 &+ t2
                }
                hash[0] = hash[0] &+ a
                hash[1] = hash[1] &+ b
                hash[2] = hash[2] &+ c
                hash[3] = hash[3] &+ d
                hash[4] = hash[4] &+ e
                hash[5] = hash[5] &+ f
                hash[6] = hash[6] &+ g
                hash[7] = hash[7] &+ h
            }
            var out: [UInt8] = []
            out.reserveCapacity(32)
            for word in hash {
                out.append(UInt8(truncatingIfNeeded: word >> 24))
                out.append(UInt8(truncatingIfNeeded: word >> 16))
                out.append(UInt8(truncatingIfNeeded: word >> 8))
                out.append(UInt8(truncatingIfNeeded: word))
            }
            return out
        }

        static let hexDigits = Array("0123456789abcdef")

        static func hexByte(_ byte: UInt8) -> String {
            String([hexDigits[Int(byte >> 4)], hexDigits[Int(byte & 0x0f)]])
        }

        static func hex(_ message: [UInt8]) -> String {
            digest(message).map(hexByte).joined()
        }
    }

    /// The lowercase hex SHA-256 of `bytes` (the tests pin it to FIPS 180-4's vectors).
    public static func sha256Hex(_ bytes: [UInt8]) -> String {
        SHA256.hex(bytes)
    }
}
