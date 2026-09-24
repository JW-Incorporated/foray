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
    var hint = false
    var ports: [AudioSessionOwner.Port] = []

    var activations: Int { activeCalls.filter { $0.0 }.count }
    var deactivations: [Bool] { activeCalls.filter { !$0.0 }.map { $0.1 } }

    func setCategory(_ category: AVAudioSession.Category, mode: AVAudioSession.Mode,
                     policy: AVAudioSession.RouteSharingPolicy, options: AVAudioSession.CategoryOptions) throws {
        categories.append(CategoryCall(category: category, mode: mode, policy: policy, options: options))
    }

    func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws {
        activeCalls.append((active, options.contains(.notifyOthersOnDeactivation)))
        if active, let activateError { throw activateError }
        if !active, let deactivateError { throw deactivateError }
    }

    var secondaryAudioShouldBeSilencedHint: Bool { hint }
    var outputPorts: [AudioSessionOwner.Port] { ports }
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

    /// A refused activation is the closed token, and the owner stays inactive
    /// (so the implicit-activation guard still fires on a stray play).
    /// TO SEE IT FAIL: map every error to `other`, or set `.active` on failure.
    func testAFailedActivationIsAClosedToken() {
        for (code, token) in [
            (AVAudioSession.ErrorCode.cannotInterruptOthers.rawValue, "cannot-interrupt-others"),
            (AVAudioSession.ErrorCode.cannotStartPlaying.rawValue, "cannot-start-playing"),
            (AVAudioSession.ErrorCode.isBusy.rawValue, "other")
        ] {
            let api = FakeSessionAPI()
            api.activateError = NSError(domain: NSOSStatusErrorDomain, code: code)
            let owner = makeOwner(api)
            let answer = owner.activate()
            XCTAssertFalse(answer.ok)
            XCTAssertEqual(answer.error, token)
            XCTAssertEqual(owner.phase, .inactive)
            XCTAssertEqual(sessionRows("activated").last?[field: "token"], .string(token))
        }
    }

    // MARK: - Deactivation

    /// Notify only when the core says so (close, final end, data deletion);
    /// a hold that expired or a `none` pause releases without it.
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
    }

    /// A deactivation the system refused leaves the session running, so the
    /// owner keeps reading it active. TO SEE IT FAIL: set `.inactive` first.
    func testARefusedDeactivationKeepsThePhase() {
        let api = FakeSessionAPI()
        api.deactivateError = NSError(domain: NSOSStatusErrorDomain, code: AVAudioSession.ErrorCode.isBusy.rawValue)
        let owner = makeOwner(api)
        _ = owner.activate()
        owner.deactivate(notifyOthers: false)
        XCTAssertEqual(owner.phase, .active)
        XCTAssertEqual(sessionRows("deactivated").last?[field: "ok"], .bool(false))
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
    /// the NEW port (the car connecting); nothing else reaches the rules.
    /// TO SEE IT FAIL: report the current port for a lost device, or forward
    /// a category change.
    func testRouteChangesReportTheRightPortAndOnlyDeviceChangesForward() {
        let car = AudioSessionOwner.Port(type: AVAudioSession.Port.carAudio.rawValue, name: "My Car")
        let speaker = AudioSessionOwner.Port(type: AVAudioSession.Port.builtInSpeaker.rawValue, name: "Speaker")
        XCTAssertEqual(
            AudioSessionOwner.routeChange(reasonRaw: AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue,
                                          current: speaker, previous: car),
            RouteChange(oldDeviceUnavailable: true, routeName: "My Car", isCarRoute: true, portType: AVAudioSession.Port.carAudio.rawValue))
        XCTAssertEqual(
            AudioSessionOwner.routeChange(reasonRaw: AVAudioSession.RouteChangeReason.newDeviceAvailable.rawValue,
                                          current: car, previous: speaker),
            RouteChange(oldDeviceUnavailable: false, routeName: "My Car", isCarRoute: true, portType: AVAudioSession.Port.carAudio.rawValue))
        for other in [AVAudioSession.RouteChangeReason.categoryChange, .override, .routeConfigurationChange] {
            XCTAssertNil(AudioSessionOwner.routeChange(reasonRaw: other.rawValue, current: car, previous: speaker))
        }
        XCTAssertNil(AudioSessionOwner.routeChange(reasonRaw: nil, current: car, previous: nil))
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
        api.ports = [AudioSessionOwner.Port(type: AVAudioSession.Port.carAudio.rawValue, name: "My Car")]
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
            .route(RouteChange(oldDeviceUnavailable: false, routeName: "My Car", isCarRoute: true, portType: AVAudioSession.Port.carAudio.rawValue)),
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
    /// TO SEE IT FAIL: move the phase on every `began`.
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
