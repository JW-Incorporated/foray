import XCTest
import AVFAudio
import ForayEngineCore
@testable import ForayAudioPlugin

/// A recording `AudioSessionAPI`: what the owner asked of the session, in
/// order, and what the session answers.
final class FakeSessionAPI: AudioSessionAPI {
    struct CategoryCall: Equatable {
        var category: AVAudioSession.Category
        var mode: AVAudioSession.Mode
        var policy: AVAudioSession.RouteSharingPolicy
        var options: AVAudioSession.CategoryOptions
    }

    private(set) var categories: [CategoryCall] = []
    /// Every `setActive`, as (active, notifyOthers).
    private(set) var activeCalls: [(Bool, Bool)] = []
    var activateError: Error?
    var deactivateError: Error?
    var categoryError: Error?
    var hint = false
    var ports: [AudioSessionOwner.Port] = []

    var activations: Int { activeCalls.filter { $0.0 }.count }
    var deactivations: [Bool] { activeCalls.filter { !$0.0 }.map { $0.1 } }

    func setCategory(_ category: AVAudioSession.Category, mode: AVAudioSession.Mode,
                     policy: AVAudioSession.RouteSharingPolicy, options: AVAudioSession.CategoryOptions) throws {
        categories.append(CategoryCall(category: category, mode: mode, policy: policy, options: options))
        if let categoryError { throw categoryError }
    }

    func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws {
        activeCalls.append((active, options.contains(.notifyOthersOnDeactivation)))
        if active, let activateError { throw activateError }
        if !active, let deactivateError { throw deactivateError }
    }

    var secondaryAudioShouldBeSilencedHint: Bool { hint }
    var outputPorts: [AudioSessionOwner.Port] { ports }
    var otherAudio = false
    var isOtherAudioPlaying: Bool { otherAudio }
}

/// `AudioSessionOwner`, the real `SessionControlling` (card NE-16;
/// docs/native-engine-plan.md §4.4), over a recording session API and a
/// private `NotificationCenter`, so every notification is synthetic and
/// nothing here depends on what the Simulator's shared session is doing.
///
/// Each test names the edit that turns it red.
final class AudioSessionOwnerTests: XCTestCase {

    private var rows: [DiagEntry] = []

    private func makeOwner(_ api: FakeSessionAPI, center: NotificationCenter = NotificationCenter(),
                       longFormAudio: Bool = false, clock: [Double] = []) -> AudioSessionOwner {
        var ticks = clock
        return AudioSessionOwner(api: api, center: center, config: AudioSessionOwner.Config(
            longFormAudio: longFormAudio,
            monoMs: { ticks.isEmpty ? 0 : ticks.removeFirst() },
            diag: { [weak self] in self?.rows.append($0) }))
    }

    private func sessionRows(_ kind: String) -> [DiagEntry] {
        rows.filter { $0.kind == "session" && $0[field: "kind"] == .string(kind) }
    }

    override func setUp() {
        super.setUp()
        rows = []
    }

    // MARK: - Boot

    /// Plan §4.4 / S-3: the category is set at boot, `.playback` +
    /// `.spokenAudio`, no options, default routing, and NOTHING activates.
    /// TO SEE IT FAIL: call `setActive(true)` from `init`, or change the mode.
    func testBootSetsTheCategoryAndNeverActivates() {
        let api = FakeSessionAPI()
        let owner = makeOwner(api)
        XCTAssertEqual(api.categories, [.init(category: .playback, mode: .spokenAudio, policy: .default, options: [])])
        XCTAssertEqual(api.activeCalls.count, 0, "boot must not activate the session")
        XCTAssertEqual(owner.phase, .inactive)
        XCTAssertEqual(sessionRows("category").first?[field: "why"], .string("boot"))
    }

    /// DV-8's `.longFormAudio` is behind an OFF flag; the build row says which.
    /// TO SEE IT FAIL: default `longFormAudio` to true.
    func testLongFormAudioIsOffUnlessFlagged() {
        let plain = makeOwner(FakeSessionAPI())
        XCTAssertEqual(plain.routeSharing, "default")
        XCTAssertEqual(plain.buildFields(holdPolicy: .forever),
                       [JSONMember("hold", .string("forever")), JSONMember("routeSharing", .string("default"))])

        let api = FakeSessionAPI()
        let flagged = makeOwner(api, longFormAudio: true)
        XCTAssertEqual(api.categories.first?.policy, .longFormAudio)
        XCTAssertEqual(api.categories.first?.mode, .spokenAudio)
        XCTAssertEqual(flagged.buildFields(holdPolicy: .until(minutes: 60)),
                       [JSONMember("hold", .string("until:60")), JSONMember("routeSharing", .string("longFormAudio"))])
    }

    // MARK: - Activation

    /// A success is timed (`activateMs`, one decimal), moves the owner's phase
    /// to active, and writes `session kind=activated` with the hint.
    /// TO SEE IT FAIL: drop the phase update, or the hint from `row`.
    func testActivationIsTimedAndItsRowCarriesTheHint() {
        let api = FakeSessionAPI()
        api.hint = true
        let owner = makeOwner(api, clock: [100, 103.24])
        let answer = owner.activate()
        XCTAssertEqual(answer, SessionActivation(ok: true, error: nil, activateMs: 3.2))
        XCTAssertEqual(owner.phase, .active)
        XCTAssertEqual(api.activations, 1)
        let row = sessionRows("activated").last
        XCTAssertEqual(row?[field: "ok"], .bool(true))
        XCTAssertEqual(row?[field: "token"], .null)
        XCTAssertEqual(row?[field: "activateMs"], .number(3.2))
        XCTAssertEqual(row?[field: "hint"], .bool(true), "every session row carries secondaryAudioShouldBeSilencedHint")
        XCTAssertEqual(row?[field: "phase"], .string("active"))
    }

    /// Every `AVAudioSession.ErrorCode` the rows name, as its DETAIL token
    /// (L13); any other code is `other`. Written out as literals, not read
    /// back from `errorTokens`, so a wrong pair in the table is caught.
    static let errorCases: [(code: Int, token: String)] = [
        (AVAudioSession.ErrorCode.cannotInterruptOthers.rawValue, "cannot-interrupt-others"),
        (AVAudioSession.ErrorCode.cannotStartPlaying.rawValue, "cannot-start-playing"),
        (AVAudioSession.ErrorCode.insufficientPriority.rawValue, "insufficient-priority"),
        (AVAudioSession.ErrorCode.isBusy.rawValue, "is-busy"),
        (AVAudioSession.ErrorCode.siriIsRecording.rawValue, "siri-is-recording"),
        (AVAudioSession.ErrorCode.mediaServicesFailed.rawValue, "media-services-failed"),
        (AVAudioSession.ErrorCode.expiredSession.rawValue, "expired-session"),
        (AVAudioSession.ErrorCode.missingEntitlement.rawValue, "missing-entitlement"),
        (AVAudioSession.ErrorCode.resourceNotAvailable.rawValue, "resource-not-available"),
        (AVAudioSession.ErrorCode.incompatibleCategory.rawValue, "incompatible-category"),
        (AVAudioSession.ErrorCode.sessionNotActive.rawValue, "session-not-active"),
        (AVAudioSession.ErrorCode.badParam.rawValue, "other"),
        (-1, "other")
    ]

    /// A refused activation is the closed DETAIL token (L13: every car record
    /// said `failed` with no cause), and the owner stays inactive (so the
    /// implicit-activation guard still fires on a stray play). The page's
    /// answer does NOT grow: the core folds every detail token outside the
    /// contract's three into `session-failed:other`, which is a `Refusal`.
    /// TO SEE IT FAIL: map every error to `other`; set `.active` on failure;
    /// or admit the detail set in `SessionPolicy.sessionFailedReason` (the
    /// reply then names a refusal the contract does not define).
    func testAFailedActivationIsAClosedToken() {
        let contract: Set<String> = ["cannot-interrupt-others", "cannot-start-playing"]
        for (code, token) in Self.errorCases {
            let api = FakeSessionAPI()
            api.activateError = NSError(domain: NSOSStatusErrorDomain, code: code)
            let owner = makeOwner(api)
            let answer = owner.activate()
            XCTAssertFalse(answer.ok)
            XCTAssertEqual(answer.error, token)
            XCTAssertEqual(owner.phase, .inactive)
            XCTAssertEqual(sessionRows("activated").last?[field: "token"], .string(token))
            XCTAssertNotNil(Vocabulary.SessionErrorDetail(rawValue: token), "\(token) is in the generated detail set")

            let reason = SessionPolicy.sessionFailedReason(answer.error)
            XCTAssertNotNil(EngineContract.Refusal(rawValue: reason), "\(token) -> \(reason) is a contract refusal")
            XCTAssertEqual(reason, contract.contains(token) ? "session-failed:\(token)" : "session-failed:other", token)
            XCTAssertEqual(EngineBridgeRules.refusal(for: [reason]),
                           contract.contains(token) ? EngineContract.Refusal(rawValue: reason) : EngineContract.Refusal.sessionFailedOther, token)
        }
        XCTAssertEqual(AudioSessionOwner.errorTokens.count, Self.errorCases.count - 2, "every named code is tabled")
    }

    // MARK: - Deactivation

    /// Notify only when the core says so (close, final end, data deletion);
    /// a hold that expired or a `none` pause releases without it. A
    /// deactivation that worked carries no `token`.
    /// TO SEE IT FAIL: always pass `.notifyOthersOnDeactivation`.
    func testDeactivationNotifiesOnlyWhenAsked() {
        let api = FakeSessionAPI()
        let owner = makeOwner(api)
        _ = owner.activate()
        owner.deactivate(notifyOthers: false)
        XCTAssertEqual(owner.phase, .inactive)
        _ = owner.activate()
        owner.deactivate(notifyOthers: true)
        XCTAssertEqual(api.deactivations, [false, true])
        XCTAssertEqual(sessionRows("deactivated").map { $0[field: "notify"] }, [.bool(false), .bool(true)])
        XCTAssertEqual(sessionRows("deactivated").map { $0[field: "token"] }, [nil, nil])
    }

    /// `is-busy` is a deactivation that HAPPENED (CH3-15, half of R2-08).
    /// Apple, `setActive(_:options:)`: "Deactivating an audio session that
    /// has running audio objects stops them, makes the session inactive, and
    /// returns an AVAudioSessionErrorCodeIsBusy error." So the owner reads
    /// it inactive, as the core does (it hears no answer from a deactivate),
    /// and the row still says why it was not clean (L13: I/O was running).
    /// Until CH3-15 this pinned the opposite (the phase stayed `.active`).
    /// TO SEE IT FAIL: set `.inactive` only when `ok`, or drop `token` from
    /// the row.
    func testAnIsBusyDeactivationStillDeactivates() {
        let api = FakeSessionAPI()
        api.deactivateError = NSError(domain: NSOSStatusErrorDomain, code: AVAudioSession.ErrorCode.isBusy.rawValue)
        let owner = makeOwner(api)
        _ = owner.activate()
        owner.deactivate(notifyOthers: false)
        XCTAssertEqual(owner.phase, .inactive)
        XCTAssertEqual(sessionRows("deactivated").last?[field: "ok"], .bool(false))
        XCTAssertEqual(sessionRows("deactivated").last?[field: "token"], .string("is-busy"))
        XCTAssertEqual(sessionRows("deactivated").last?[field: "phase"], .string("inactive"))
    }

    /// Any other failed deactivation left the session as it was, so the
    /// owner keeps reading it active (a play on it is owned, not an implicit
    /// activation), and the row says why.
    /// TO SEE IT FAIL: set `.inactive` on every deactivation, failed or not.
    func testARefusedDeactivationKeepsThePhase() {
        let api = FakeSessionAPI()
        api.deactivateError = NSError(domain: NSOSStatusErrorDomain,
                                      code: AVAudioSession.ErrorCode.mediaServicesFailed.rawValue)
        let owner = makeOwner(api)
        _ = owner.activate()
        owner.deactivate(notifyOthers: false)
        XCTAssertEqual(owner.phase, .active)
        XCTAssertEqual(sessionRows("deactivated").last?[field: "ok"], .bool(false))
        XCTAssertEqual(sessionRows("deactivated").last?[field: "token"], .string("media-services-failed"))
    }

    /// A category the system refused says why (L13); one it took carries no
    /// `token`. TO SEE IT FAIL: drop `token` from `applyCategory`'s row.
    func testARefusedCategoryRowCarriesItsToken() {
        _ = makeOwner(FakeSessionAPI())
        XCTAssertEqual(sessionRows("category").last?[field: "ok"], .bool(true))
        XCTAssertNil(sessionRows("category").last?[field: "token"])

        rows = []
        let api = FakeSessionAPI()
        api.categoryError = NSError(domain: NSOSStatusErrorDomain,
                                    code: AVAudioSession.ErrorCode.incompatibleCategory.rawValue)
        _ = makeOwner(api)
        XCTAssertEqual(sessionRows("category").last?[field: "ok"], .bool(false))
        XCTAssertEqual(sessionRows("category").last?[field: "token"], .string("incompatible-category"))
    }

    // MARK: - Readings

    /// The interruption notification as the core reads it, reason included.
    /// TO SEE IT FAIL: read the reason as `default` whatever the key says, or
    /// drop the `.shouldResume` option.
    func testInterruptionReasonsAndShouldResumeAreRead() {
        let began = AVAudioSession.InterruptionType.began.rawValue
        let ended = AVAudioSession.InterruptionType.ended.rawValue
        func reason(_ r: AVAudioSession.InterruptionReason) -> UInt { r.rawValue }
        XCTAssertEqual(AudioSessionOwner.interruptionEvent(typeRaw: began, reasonRaw: reason(.default), optionsRaw: nil),
                       .interruptionBegan(reason: "default"))
        XCTAssertEqual(AudioSessionOwner.interruptionEvent(typeRaw: began, reasonRaw: reason(.appWasSuspended), optionsRaw: nil),
                       .interruptionBegan(reason: "appWasSuspended"))
        XCTAssertEqual(AudioSessionOwner.interruptionEvent(typeRaw: began, reasonRaw: reason(.builtInMicMuted), optionsRaw: nil),
                       .interruptionBegan(reason: "builtInMicMuted"))
        // A reason outside the closed set (iOS 17's routeDisconnected is 3) is
        // `unknown`, which the table treats as a lost session.
        XCTAssertEqual(AudioSessionOwner.interruptionEvent(typeRaw: began, reasonRaw: 3, optionsRaw: nil),
                       .interruptionBegan(reason: "unknown"))
        XCTAssertEqual(AudioSessionOwner.interruptionEvent(typeRaw: began, reasonRaw: nil, optionsRaw: nil),
                       .interruptionBegan(reason: nil))
        XCTAssertEqual(AudioSessionOwner.interruptionEvent(
            typeRaw: ended, reasonRaw: nil, optionsRaw: AVAudioSession.InterruptionOptions.shouldResume.rawValue),
                       .interruptionEnded(shouldResume: true))
        XCTAssertEqual(AudioSessionOwner.interruptionEvent(typeRaw: ended, reasonRaw: nil, optionsRaw: 0),
                       .interruptionEnded(shouldResume: false))
        XCTAssertNil(AudioSessionOwner.interruptionEvent(typeRaw: nil, reasonRaw: nil, optionsRaw: nil))
        XCTAssertNil(AudioSessionOwner.interruptionEvent(typeRaw: 99, reasonRaw: nil, optionsRaw: nil))
    }

    /// A lost device reports the LOST port (the car switching off), a new one
    /// the NEW port (the car connecting), each with its UID and its class
    /// (NE-38rs: car, bluetooth, other); nothing else reaches the rules.
    /// TO SEE IT FAIL: report the current port for a lost device, drop the
    /// UID, classify by anything but the port type, or forward a category
    /// change.
    func testRouteChangesReportTheRightPortAndOnlyDeviceChangesForward() {
        let car = AudioSessionOwner.Port(type: AVAudioSession.Port.carAudio.rawValue, uid: "car-uid-1")
        let speaker = AudioSessionOwner.Port(type: AVAudioSession.Port.builtInSpeaker.rawValue, uid: "Speaker")
        let a2dp = AudioSessionOwner.Port(type: AVAudioSession.Port.bluetoothA2DP.rawValue, uid: "8C:DE:52:11:22:33-tacl")
        XCTAssertEqual(
            AudioSessionOwner.routeChange(reasonRaw: AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue,
                                          current: speaker, previous: car),
            RouteChange(oldDeviceUnavailable: true, portType: AVAudioSession.Port.carAudio.rawValue, portUID: "car-uid-1",
                        routeClass: .car))
        XCTAssertEqual(
            AudioSessionOwner.routeChange(reasonRaw: AVAudioSession.RouteChangeReason.newDeviceAvailable.rawValue,
                                          current: car, previous: speaker),
            RouteChange(oldDeviceUnavailable: false, portType: AVAudioSession.Port.carAudio.rawValue, portUID: "car-uid-1",
                        routeClass: .car))
        XCTAssertEqual(
            AudioSessionOwner.routeChange(reasonRaw: AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue,
                                          current: speaker, previous: a2dp),
            RouteChange(oldDeviceUnavailable: true, portType: "BluetoothA2DPOutput", portUID: "8C:DE:52:11:22:33-tacl",
                        routeClass: .bluetooth))
        XCTAssertEqual(
            AudioSessionOwner.routeChange(reasonRaw: AVAudioSession.RouteChangeReason.newDeviceAvailable.rawValue,
                                          current: speaker, previous: nil)?.routeClass, .other)
        XCTAssertEqual(
            AudioSessionOwner.routeChange(reasonRaw: AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue,
                                          current: speaker, previous: nil),
            RouteChange(oldDeviceUnavailable: true, portType: nil, portUID: nil, routeClass: .other),
            "no previous route: no port, no UID, never a car")
        for other in [AVAudioSession.RouteChangeReason.categoryChange, .override, .routeConfigurationChange] {
            XCTAssertNil(AudioSessionOwner.routeChange(reasonRaw: other.rawValue, current: car, previous: speaker))
        }
        XCTAssertNil(AudioSessionOwner.routeChange(reasonRaw: nil, current: car, previous: nil))
    }

    /// L14: every route row carries BOTH port types, `port` (now) and
    /// `prevPort` (before), whether or not the rules act on it, and never a
    /// port's name. The rows pass DiagGate whole.
    /// TO SEE IT FAIL: drop `prevPort` from `routePorts`, write `$0.name`
    /// instead of `$0.type`, or go back to one `port` per row.
    func testEveryRouteRowCarriesBothPortTypesAndNeverAName() throws {
        let carAudio = AVAudioSession.Port.carAudio.rawValue
        let speakerType = AVAudioSession.Port.builtInSpeaker.rawValue
        let car = AudioSessionOwner.Port(type: carAudio, uid: "Wyatts-Car-UID")
        let speaker = AudioSessionOwner.Port(type: speakerType, uid: "Speaker")
        let both = AudioSessionOwner.routePorts(current: car, previous: speaker)
        XCTAssertEqual(both, [JSONMember("port", .string(carAudio)), JSONMember("prevPort", .string(speakerType))])
        XCTAssertFalse(JSWriter.stringify(.object(both)).contains("Wyatts"), "a port's UID reached a row")
        XCTAssertEqual(AudioSessionOwner.routePorts(current: nil, previous: nil),
                       [JSONMember("port", .null), JSONMember("prevPort", .null)])

        // Through the observer: a forwarded row (a new device) and a written-
        // down one (a category change) both carry both keys.
        let api = FakeSessionAPI()
        api.ports = [car]
        let center = NotificationCenter()
        let owner = makeOwner(api, center: center)
        let observation = owner.observe { _ in }
        for reason in [AVAudioSession.RouteChangeReason.newDeviceAvailable, .categoryChange] {
            post(center, AVAudioSession.routeChangeNotification, object: api,
                 [AVAudioSessionRouteChangeReasonKey: reason.rawValue], fromBackground: false)
        }
        let routeRows = { self.sessionRows("notification").filter { $0[field: "name"] == .string("route") } }
        spin(until: { routeRows().count >= 2 })
        XCTAssertEqual(routeRows().map { $0[field: "forwarded"] }, [.bool(true), .bool(false)])
        for row in routeRows() {
            XCTAssertEqual(row[field: "port"], .string(carAudio))
            XCTAssertEqual(row[field: "prevPort"], .null, "no previous route in the notification: null, not absent")
            XCTAssertFalse(JSWriter.stringify(.object(row.fields)).contains("Wyatts"))
            // Both port types survive the gate. (The row's `name` sub-kind is
            // withheld by rule 4, a key containing `name`: pre-existing, and
            // not this test's subject.)
            let admitted = try XCTUnwrap(DiagGate.admit(row))
            let dropped = admitted[field: "dropped"]?.arrayValue?.compactMap(\.stringValue) ?? []
            XCTAssertFalse(dropped.contains("port") || dropped.contains("prevPort"), "DiagGate withheld a port: \(dropped)")
            XCTAssertEqual(admitted[field: "port"], .string(carAudio))
            XCTAssertEqual(admitted[field: "prevPort"], .null)
        }
        observation.cancel()
    }

    /// NE-38rs: the owner hands the core the port's UID (on the route change,
    /// and as `currentRoute` for every input), and writes it into NO row of
    /// its own: an arrival and a category change are both written down with
    /// port types only.
    /// TO SEE IT FAIL: add the UID to `routePorts`, or make `currentRoute`
    /// drop it (the core could then never know a route).
    func testTheOwnerPassesTheUIDToTheCoreAndNeverIntoARow() throws {
        let uid = "8C:DE:52:11:22:33-tacl"
        let a2dp = AudioSessionOwner.Port(type: AVAudioSession.Port.bluetoothA2DP.rawValue, uid: uid)
        let api = FakeSessionAPI()
        api.ports = [a2dp]
        let center = NotificationCenter()
        let owner = makeOwner(api, center: center)
        XCTAssertEqual(owner.currentRoute, RoutePort(portType: "BluetoothA2DPOutput", uid: uid))
        var events: [SessionEvent] = []
        let observation = owner.observe { events.append($0) }
        for reason in [AVAudioSession.RouteChangeReason.newDeviceAvailable, .categoryChange] {
            post(center, AVAudioSession.routeChangeNotification, object: api,
                 [AVAudioSessionRouteChangeReasonKey: reason.rawValue], fromBackground: false)
        }
        spin(until: { self.sessionRows("notification").filter { $0[field: "name"] == .string("route") }.count >= 2 })
        XCTAssertEqual(events, [.route(RouteChange(oldDeviceUnavailable: false, portType: "BluetoothA2DPOutput",
                                                   portUID: uid, routeClass: .bluetooth))])
        XCTAssertFalse(rows.isEmpty)
        for row in rows {
            let text = JSWriter.stringify(.object(row.fields))
            XCTAssertFalse(text.contains(uid) || text.contains("8C:DE"), "the raw UID reached a row: \(text)")
        }
        api.ports = []
        XCTAssertNil(owner.currentRoute, "no output: no route")
        observation.cancel()
    }

    // MARK: - Observation

    private func post(_ center: NotificationCenter, _ name: Notification.Name, object: AnyObject,
                      _ info: [AnyHashable: Any]?, fromBackground: Bool) {
        let note = Notification(name: name, object: object, userInfo: info)
        if fromBackground {
            let posted = expectation(description: "posted off main")
            DispatchQueue.global().async {
                center.post(note)
                posted.fulfill()
            }
            wait(for: [posted], timeout: 5)
        } else {
            center.post(note)
        }
    }

    private func spin(until done: () -> Bool) {
        let until = Date().addingTimeInterval(5)
        while !done(), Date() < until {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
    }

    /// All three notifications are observed with `queue: .main`: a route
    /// change posted on a background thread still reaches the handler ON
    /// MAIN (plan §4.2), and cancelling removes every observer.
    /// TO SEE IT FAIL: pass `queue: nil` (the handler runs on the posting
    /// thread), or drop a token from `NotificationObservation`.
    func testNotificationsArriveOnMainAndCancelRemovesThem() {
        let api = FakeSessionAPI()
        api.ports = [AudioSessionOwner.Port(type: AVAudioSession.Port.carAudio.rawValue, uid: "car-uid-1")]
        let center = NotificationCenter()
        let owner = makeOwner(api, center: center)
        _ = owner.activate()
        var events: [SessionEvent] = []
        var allOnMain = true
        let observation = owner.observe { event in
            allOnMain = allOnMain && Thread.isMainThread
            events.append(event)
        }

        post(center, AVAudioSession.routeChangeNotification, object: api,
             [AVAudioSessionRouteChangeReasonKey: AVAudioSession.RouteChangeReason.newDeviceAvailable.rawValue],
             fromBackground: true)
        post(center, AVAudioSession.interruptionNotification, object: api,
             [AVAudioSessionInterruptionTypeKey: NSNumber(value: AVAudioSession.InterruptionType.began.rawValue),
              AVAudioSessionInterruptionReasonKey: NSNumber(value: AVAudioSession.InterruptionReason.default.rawValue)],
             fromBackground: true)
        post(center, AVAudioSession.mediaServicesWereResetNotification, object: api, nil, fromBackground: false)
        spin(until: { events.count >= 3 })

        XCTAssertEqual(events, [
            .route(RouteChange(oldDeviceUnavailable: false, portType: AVAudioSession.Port.carAudio.rawValue,
                               portUID: "car-uid-1", routeClass: .car)),
            .interruptionBegan(reason: "default"),
            .mediaServicesReset
        ])
        XCTAssertTrue(allOnMain, "a session notification was handled off main")
        XCTAssertEqual(owner.phase, .inactive, "a reset forgets the activation")

        // A category change is written down, not forwarded.
        post(center, AVAudioSession.routeChangeNotification, object: api,
             [AVAudioSessionRouteChangeReasonKey: AVAudioSession.RouteChangeReason.categoryChange.rawValue],
             fromBackground: false)
        spin(until: { !sessionRows("notification").filter { $0[field: "forwarded"] == .bool(false) }.isEmpty })
        XCTAssertEqual(events.count, 3)

        observation.cancel()
        post(center, AVAudioSession.interruptionNotification, object: api,
             [AVAudioSessionInterruptionTypeKey: NSNumber(value: AVAudioSession.InterruptionType.ended.rawValue)],
             fromBackground: false)
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        XCTAssertEqual(events.count, 3, "a cancelled observation still delivered")
    }

    /// The owner's phase follows the session-losing interruptions only: a
    /// muted built-in mic stops nothing of ours, and a late appWasSuspended
    /// is the core's call (stale or not).
    /// TO SEE IT FAIL: move the phase on every `began`, or compare the raw
    /// reason instead of the admitted one (an absent key then keeps `.active`).
    func testOnlyASessionLosingInterruptionMovesThePhase() {
        let api = FakeSessionAPI()
        let center = NotificationCenter()
        let owner = makeOwner(api, center: center)
        _ = owner.activate()
        var events = 0
        let observation = owner.observe { _ in events += 1 }
        let table: [(AVAudioSession.InterruptionReason, SessionPolicy.Phase)] = [
            (.builtInMicMuted, .active),
            (.appWasSuspended, .active),
            (.default, .lostToInterruption)
        ]
        for (reason, expected) in table {
            post(center, AVAudioSession.interruptionNotification, object: api,
                 [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.began.rawValue,
                  AVAudioSessionInterruptionReasonKey: reason.rawValue],
                 fromBackground: false)
            spin(until: { events >= 1 })
            events = 0
            XCTAssertEqual(owner.phase, expected, "after \(reason.rawValue)")
        }

        // No reason key at all reads as `unknown`, as the table reads it:
        // the session was taken.
        _ = owner.activate()
        post(center, AVAudioSession.interruptionNotification, object: api,
             [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.began.rawValue],
             fromBackground: false)
        spin(until: { events >= 1 })
        XCTAssertEqual(owner.phase, .lostToInterruption)
        observation.cancel()
    }

    /// An interruption row says who likely took the session: whether another
    /// app was playing, and our output port (a call or Siri moves it to the
    /// call profile). Port TYPES only, never a name.
    /// TO SEE IT FAIL: drop `interrupterFields()` from either notification row.
    func testAnInterruptionRowSaysWhetherOtherAudioWasPlayingAndWhere() {
        let api = FakeSessionAPI()
        api.otherAudio = true
        api.ports = [AudioSessionOwner.Port(type: "BluetoothA2DPOutput", uid: "Wyatt's Car")]
        let center = NotificationCenter()
        let owner = makeOwner(api, center: center)
        _ = owner.activate()
        var events = 0
        let observation = owner.observe { _ in events += 1 }
        post(center, AVAudioSession.interruptionNotification, object: api,
             [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.began.rawValue,
              AVAudioSessionInterruptionReasonKey: AVAudioSession.InterruptionReason.default.rawValue],
             fromBackground: false)
        post(center, AVAudioSession.interruptionNotification, object: api,
             [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.ended.rawValue],
             fromBackground: false)
        spin(until: { events >= 2 })
        let interruptionRows = rows.filter { $0[field: "name"] == .string("interruption") }
        XCTAssertEqual(interruptionRows.count, 2, "\(rows)")
        for row in interruptionRows {
            XCTAssertEqual(row[field: "otherAudio"], .bool(true))
            XCTAssertEqual(row[field: "port"], .string("BluetoothA2DPOutput"))
            XCTAssertFalse(row.fields.contains { $0.value == .string("Wyatt's Car") }, "a route UID reached a row")
        }
        observation.cancel()
    }

    /// The owner as the host's session seam: a launch and a restored bar
    /// set the category and activate NOTHING (S-3), end to end through the
    /// real owner. TO SEE IT FAIL: activate in `init`, or make the core ask
    /// for activation on `.restoreBar` / a cold launch without autoplay.
    @MainActor
    func testThroughTheHostNoActivationAtLaunchOrRestoreBar() {
        let api = FakeSessionAPI()
        let world = FakeWorld()
        var seams = world.seams
        let sessionOwner = makeOwner(api)
        seams.session = sessionOwner
        let engine = ForayEngine(seams: seams, config: EngineConfig(build: "test"))
        engine.start()
        engine.handle(.lifecycle(.coldLaunch(queue: [ForayEngineHostTests.item("a")], index: 0, autoplay: false)))
        engine.handle(.command(.restoreBar, source: .restore))
        XCTAssertEqual(api.activeCalls.count, 0)
        XCTAssertEqual(api.categories.count, 1)
        XCTAssertEqual(engine.state.session, .inactive)

        // The first user-caused play is the first activation.
        world.deck.answersReady = true
        engine.handle(.command(.play, source: .tap))
        XCTAssertEqual(api.activations, 1)
        XCTAssertEqual(sessionOwner.phase, .active)
        engine.teardown()
    }

    /// ONE SESSION PHASE (CH3-19, R2-08), end to end through the real owner
    /// and the real jingle player, wired as the boot wires them (the gate
    /// attached to the engine and the owner; every audible start reads the
    /// gate). A declined call's late `began` lands during a spoken line the
    /// synthesizer says it is still speaking: the core rules it late and
    /// touches nothing, and the owner's own phase (its rows) stays `.active`
    /// with it. The line then ends, the next clip plays, and the jingles at
    /// the seams after it START: no `fault kind=implicit-activation`.
    /// Before CH3-19 the owner moved to `lostToInterruption` on that began,
    /// and its phase was the gate: once the core heard the narrator (R2-05)
    /// every jingle after it would have been refused, for the rest of the
    /// Foray.
    /// TO SEE IT FAIL: move the owner's phase before (or regardless of) the
    /// core's ruling in `interruption(_:_:)`; or gate the jingle on
    /// `owner.phase == .active` with that move in place.
    @MainActor
    func testThroughTheHostALateBeganLeavesBothPhasesActiveAndTheNextJingleStarts() throws {
        let api = FakeSessionAPI()
        let center = NotificationCenter()
        let owner = makeOwner(api, center: center)
        let world = FakeWorld()
        world.deck.answersReady = true
        let clock = ClockTiming()
        let jingle = FakeJingle()
        var faults: [String] = []
        let gate = EngineSessionGate()
        let player = InterludePlayer(config: InterludePlayer.Config(
            sessionIsActive: { gate.isActive }, diag: { world.output.diag($0) }, timing: clock,
            makeJingle: { jingle }, debugFault: { faults.append($0) }))
        var seams = world.seams
        seams.session = owner
        seams.timing = clock
        seams.interlude = player
        let engine = ForayEngine(seams: seams, config: EngineConfig(build: "test", forayTapeEnabled: true,
                                                                    interludeAvailable: true))
        gate.attach(engine, owner: owner)
        engine.start()
        engine.handle(.queue(.loadForay([ForayEngineHostTests.spokenLine(), InterludeSeamTests.clip(1, "a", 100, 200),
                                         InterludeSeamTests.clip(2, "b", 300, 400)],
                                        isLocalFile: false, allowAdPad: false)))
        engine.handle(.queue(.playIndex(0, startSec: nil, source: .tap)))
        let seq = try XCTUnwrap(ForayEngineHostTests.spokenSeq(world.speaker), "\(world.speaker.narrated)")
        world.speaker.report(.started(seq: seq, voiceFallback: false))
        world.speaker.reading = .speaking
        XCTAssertEqual(owner.phase, .active)
        XCTAssertTrue(gate.isActive)

        post(center, AVAudioSession.interruptionNotification, object: api,
             [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.began.rawValue,
              AVAudioSessionInterruptionReasonKey: AVAudioSession.InterruptionReason.default.rawValue],
             fromBackground: false)
        spin(until: { world.output.diags.contains { $0.kind == "session" && $0[field: "kind"] == .string("interruption") } })

        // RED on main: R2-08 (the owner moved to lostToInterruption on every began).
        XCTAssertEqual(owner.phase, .active, "the owner's phase stays with the core's ruling: \(rows)")
        XCTAssertEqual(engine.state.session, .active)
        XCTAssertEqual(engine.state.stateType, "playing")
        XCTAssertTrue(gate.isActive)

        // The line ends; the next clip plays; its out-point is a jingle seam.
        world.speaker.reading = .idle
        world.speaker.report(.finished(seq: seq))
        clock.run(forMs: InterludeSeamTests.ceilingMs)
        let token = try XCTUnwrap(world.deck.lastToken, "the next clip never loaded: \(world.log.entries)")
        world.deck.report(.timeControl(token: token, status: .playing, waitingReason: nil))
        XCTAssertEqual(engine.state.stateType, "playing", "\(world.log.entries)")
        world.deck.reading.audible = false
        world.deck.reading.ended = true
        world.deck.report(.ended(token: token))

        // The line -> clip seam and the clip -> clip seam are both jingle
        // seams (Interlude.eligible: a segment follows, from another source):
        // every jingle after the late began starts.
        XCTAssertGreaterThanOrEqual(jingle.plays, 1, "the jingle after the late began starts: \(world.output.diags)")
        XCTAssertEqual(faults, [])
        XCTAssertFalse(world.output.diags.contains { $0.kind == "fault" }, "\(world.output.diags)")
        engine.teardown()
    }

    /// The real API, once: the shared session takes the owner's category and
    /// mode at boot without being activated by it.
    /// TO SEE IT FAIL: change the mode in `applyCategory`.
    func testTheRealSessionTakesTheCategoryAtBoot() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.ambient, mode: .default, options: [])
        _ = AudioSessionOwner(api: session, center: NotificationCenter(), config: .init(diag: { _ in }))
        XCTAssertEqual(session.category, .playback)
        XCTAssertEqual(session.mode, .spokenAudio)
        XCTAssertEqual(session.routeSharingPolicy, .default)
    }
}
