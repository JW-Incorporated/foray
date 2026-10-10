import XCTest
import ForayEngineCore
import ForayEngineParity

/// Card NE-38rs: route resume in the engine (founder Q5, docs/DECISIONS.md
/// 2026-09-25). The pure rule is the `route-resume` parity family's
/// (`RouteResumeFamily`, run by `ParityFamilyTests`); these drive the WHOLE
/// core the way the host does, through `EngineCoreTests.Host`, for what the
/// family cannot see: the salted keys and the rows, the one-second "heard"
/// rule, the grace and activation of a resume, the either-order attribution,
/// the wall clock, and the known set a reload hands back.
///
/// Each test names the edit that turns it red.
final class RouteResumeTests: XCTestCase {
    typealias Host = EngineCoreTests.Host

    static let salt = "00112233445566778899aabbccddeeff"
    static let carPlayUID = "CarPlay-7F3A-UID"
    static let carPlay = RoutePort(portType: "CarAudio", uid: carPlayUID)
    static let a2dpUID = "8C:DE:52:11:22:33-tacl"
    static let a2dp = RoutePort(portType: "BluetoothA2DPOutput", uid: a2dpUID)

    static func lost(_ port: RoutePort) -> RouteChange {
        RouteChange(oldDeviceUnavailable: true, portType: port.portType, portUID: port.uid)
    }

    static func back(_ port: RoutePort) -> RouteChange {
        RouteChange(oldDeviceUnavailable: false, portType: port.portType, portUID: port.uid)
    }

    static func config(bluetooth: Bool = false, holdPolicy: SessionPolicy.HoldPolicy = .default,
                       knownRoutes: [String] = []) -> EngineConfig {
        EngineConfig(build: "test", holdPolicy: holdPolicy, routeResumeBluetooth: bluetooth, routeSalt: salt,
                     knownRoutes: knownRoutes)
    }

    /// A host playing item "a", confirmed audible through `route`.
    static func playing(through route: RoutePort?, config: EngineConfig = RouteResumeTests.config()) -> Host {
        var host = Host(config: config)
        host.route = route
        host.send(.queue(.load([EngineCoreTests.item("a")])))
        host.send(.queue(.playIndex(0, startSec: nil, source: .tap)))
        host.land()
        host.confirm()
        return host
    }

    static func rows(_ kind: String, _ commands: [EngineCommand]) -> [DiagEntry] {
        commands.compactMap { if case let .diag(entry) = $0, entry.kind == kind { return entry }; return nil }
    }

    /// The one `route kind=back` row of a turn.
    func backRow(_ commands: [EngineCommand], file: StaticString = #filePath, line: UInt = #line) throws -> DiagEntry {
        let backs = RouteResumeTests.rows("route", commands).filter { $0[field: "kind"] == .string("back") }
        XCTAssertEqual(backs.count, 1, "\(commands)", file: file, line: line)
        return try XCTUnwrap(backs.first, file: file, line: line)
    }

    func resumed(_ commands: [EngineCommand]) -> Bool { commands.contains(.graceBegin(.routeResume)) }

    // MARK: - The acceptance cases

    /// Q5: a listener's pause is never resumed, even when the car it played
    /// through (a KNOWN car) is then switched off and on. `main`'s branch
    /// (`case .interrupted(_, true)`) resumed it, because the reducer models a
    /// listener's pause as exactly that: this test failed there (PR body).
    /// TO SEE IT FAIL: step `.press("play")` instead of `"pause"` for a pause
    /// in `pressName`, or drop the `pausedBy` check from `RouteResume.decision`.
    func testAListenersPauseIsNotResumedWhenTheCarIsLostAndBack() throws {
        var car = RouteResumeTests.playing(through: RouteResumeTests.carPlay)
        car.send(.command(.pause, source: .tap))
        car.send(.session(.route(RouteResumeTests.lost(RouteResumeTests.carPlay))))
        let back = car.send(.session(.route(RouteResumeTests.back(RouteResumeTests.carPlay))))
        XCTAssertFalse(resumed(back), "a listener's pause was resumed: \(back)")
        XCTAssertFalse(back.contains { if case .deck(.load) = $0 { return true }; return false }, "\(back)")
        XCTAssertFalse(back.contains(.deck(.play)), "\(back)")
        let row = try backRow(back)
        XCTAssertEqual(row[field: "decision"], .string("no"))
        XCTAssertEqual(row[field: "why"], .string("listener-paused"))
        XCTAssertEqual(row[field: "pausedBy"], .string("listener"))
        XCTAssertEqual(row[field: "known"], .bool(true), "the car was known: the pause alone kept it paused")
    }

    /// CarPlay lost while playing and back: exactly one resume, as a car's
    /// press is one: grace from the moment it comes back, the `resume
    /// kind=route` row, the activation (the hold ran out while it was gone),
    /// then the play. A second `back` (iOS repeats route notifications)
    /// resumes nothing.
    /// TO SEE IT FAIL: drop the `begin(.routeResume, ...)` in `onRoute`, or
    /// keep the loss after a resume in `RouteResume.step` (two resumes).
    func testCarPlayLostAndBackResumesExactlyOnceWithAnActivationAndGrace() throws {
        var car = RouteResumeTests.playing(through: RouteResumeTests.carPlay,
                                           config: RouteResumeTests.config(holdPolicy: .until(minutes: 1)))
        let lost = car.send(.session(.route(RouteResumeTests.lost(RouteResumeTests.carPlay))))
        let lostRow = try XCTUnwrap(RouteResumeTests.rows("route", lost).first)
        XCTAssertEqual(lostRow[field: "kind"], .string("lost"))
        XCTAssertEqual(lostRow[field: "known"], .bool(true))
        XCTAssertEqual(lostRow[field: "class"], .string("car"))
        XCTAssertEqual(car.core.state.stateType, "interrupted")
        // The car stays off long enough for the hold to run out.
        car.send(.timer(.holdExpired), after: 60_000)
        XCTAssertNotEqual(car.core.state.session, .active, "premise: the session was released while the car was gone")

        let back = car.send(.session(.route(RouteResumeTests.back(RouteResumeTests.carPlay))))
        let row = try backRow(back)
        XCTAssertEqual(row[field: "decision"], .string("resume"))
        XCTAssertEqual(row[field: "why"], .string("route-back"))
        XCTAssertEqual(row[field: "pausedBy"], .string("route"))
        XCTAssertEqual(back.filter { $0 == .graceBegin(.routeResume) }.count, 1, "\(back)")
        let grace = try XCTUnwrap(back.firstIndex(of: .graceBegin(.routeResume)))
        let activation = try XCTUnwrap(back.firstIndex { Host.activation($0) != nil }, "no activation: \(back)")
        XCTAssertLessThan(grace, activation, "grace covers the activation, as for a car's press")
        let resumeRows = RouteResumeTests.rows("resume", back)
        XCTAssertEqual(resumeRows.count, 1)
        XCTAssertEqual(resumeRows.first?[field: "kind"], .string("route"))
        XCTAssertEqual(resumeRows.first?[field: "graceReason"], .string("route-resume"))
        XCTAssertTrue(back.contains(.deck(.play)) || back.contains { if case .deck(.load) = $0 { return true }; return false },
                      "the resume plays: \(back)")

        let again = car.send(.session(.route(RouteResumeTests.back(RouteResumeTests.carPlay))), after: 300)
        XCTAssertFalse(resumed(again), "a second back resumed again: \(again)")
        XCTAssertEqual(try backRow(again)[field: "why"], .string("not-paused"))
    }

    /// A2DP (the founder's car, and AirPods) with the Bluetooth arm OFF: the
    /// row says so, so the drive's `route-back` verdict can tell whether the
    /// car's own play came soon enough to leave it off. With the arm on, the
    /// same return resumes.
    /// TO SEE IT FAIL: pass `bluetoothArm: true` from the core, or drop the
    /// class check from `RouteResume.decision`.
    func testA2DPWithTheArmOffIsNoBecauseBluetoothIsOff() throws {
        var off = RouteResumeTests.playing(through: RouteResumeTests.a2dp)
        off.send(.session(.route(RouteResumeTests.lost(RouteResumeTests.a2dp))))
        let back = off.send(.session(.route(RouteResumeTests.back(RouteResumeTests.a2dp))))
        let row = try backRow(back)
        XCTAssertEqual(row[field: "decision"], .string("no"))
        XCTAssertEqual(row[field: "why"], .string("bluetooth-off"))
        XCTAssertEqual(row[field: "class"], .string("bluetooth"))
        XCTAssertEqual(row[field: "known"], .bool(true))
        XCTAssertFalse(resumed(back))
        // The car's own play, 7.4 s later, resumes as any press does.
        let press = off.send(.remote(RemotePress(.play)), after: 7_400)
        XCTAssertTrue(press.contains(.graceBegin(.remotePlay)), "\(press)")

        var on = RouteResumeTests.playing(through: RouteResumeTests.a2dp, config: RouteResumeTests.config(bluetooth: true))
        on.send(.session(.route(RouteResumeTests.lost(RouteResumeTests.a2dp))))
        let armed = on.send(.session(.route(RouteResumeTests.back(RouteResumeTests.a2dp))))
        XCTAssertEqual(try backRow(armed)[field: "decision"], .string("resume"))
        XCTAssertTrue(resumed(armed))
    }

    /// The known set is handed back by a reload: a core built from what the
    /// host stored (`EngineConfig.knownRoutes`, with the same salt) knows the
    /// car without hearing it again, and a core with an empty set does not.
    /// (ForayAudioPluginTests' RouteResumeHostTests does the same through the
    /// real EngineStore and its private key.)
    /// TO SEE IT FAIL: drop `initial.knownRoutes = ...` from `EngineCore.init`,
    /// or hash with anything but `config.routeSalt`.
    func testTheKnownSetSurvivesAReload() throws {
        var first = RouteResumeTests.playing(through: RouteResumeTests.carPlay)
        first.send(.session(.route(RouteResumeTests.lost(RouteResumeTests.carPlay))))
        let stored = RouteResume.Stored(salt: RouteResumeTests.salt, keys: first.core.state.knownRoutes.keys)
        XCTAssertEqual(stored.keys.count, 1)
        let reread = try XCTUnwrap(RouteResume.Stored.parse(stored.serialized))
        XCTAssertEqual(reread, stored)

        // Played through the phone's speaker (no route heard), then the car.
        var reloaded = RouteResumeTests.playing(through: nil, config: RouteResumeTests.config(knownRoutes: reread.keys))
        reloaded.send(.session(.route(RouteResumeTests.lost(RouteResumeTests.carPlay))))
        let back = reloaded.send(.session(.route(RouteResumeTests.back(RouteResumeTests.carPlay))))
        XCTAssertEqual(try backRow(back)[field: "known"], .bool(true))
        XCTAssertTrue(resumed(back), "\(back)")

        var fresh = RouteResumeTests.playing(through: nil)
        fresh.send(.session(.route(RouteResumeTests.lost(RouteResumeTests.carPlay))))
        let unknown = fresh.send(.session(.route(RouteResumeTests.back(RouteResumeTests.carPlay))))
        XCTAssertEqual(try backRow(unknown)[field: "why"], .string("unknown-route"))
        XCTAssertFalse(resumed(unknown))
    }

    /// No row carries the raw UID (DiagGate; plan §10): every row of a whole
    /// drive (play, loss, return, resume) is searched for it, and the `key`
    /// the rows do carry is the first 8 hex of the salted hash.
    /// TO SEE IT FAIL: write `change.portUID` into the `route` rows, or the
    /// whole hashed key instead of `RouteResume.rowKey`.
    func testNoRowCarriesTheRawUID() throws {
        var car = RouteResumeTests.playing(through: RouteResumeTests.carPlay)
        var all = car.send(.session(.route(RouteResumeTests.lost(RouteResumeTests.carPlay))))
        all += car.send(.session(.route(RouteResumeTests.back(RouteResumeTests.carPlay))))
        all += car.land()
        all += car.confirm()
        let diags: [DiagEntry] = all.compactMap { if case let .diag(entry) = $0 { return entry }; return nil }
        XCTAssertFalse(diags.isEmpty)
        for entry in diags {
            let text = JSWriter.stringify(.object([JSONMember("kind", .string(entry.kind))] + entry.fields))
            XCTAssertFalse(text.contains(RouteResumeTests.carPlayUID), "the raw UID reached a row: \(text)")
            XCTAssertFalse(text.contains("CarPlay-7F3A"), "part of the raw UID reached a row: \(text)")
        }
        let hashed = try XCTUnwrap(RouteResume.hashedKey(portType: "CarAudio", uid: RouteResumeTests.carPlayUID,
                                                         salt: RouteResumeTests.salt))
        let routeRows = RouteResumeTests.rows("route", all)
        XCTAssertEqual(routeRows.count, 2)
        for row in routeRows {
            XCTAssertEqual(row[field: "key"], .string(String(hashed.prefix(8))))
            let admitted = try XCTUnwrap(DiagGate.admit(row))
            XCTAssertNil(admitted[field: "dropped"], "the gate withheld part of a route row: \(admitted)")
        }
        XCTAssertEqual(car.core.state.knownRoutes.keys, [hashed], "the set holds the salted hash, never the UID")
    }

    // MARK: - The rest of the rule, end to end

    /// A route becomes known only after our audio was heard through it for a
    /// second: half a second of CarPlay and then the car off is an unknown car.
    /// TO SEE IT FAIL: lower `RouteResume.knownAfterMs` to 0, or mark a route
    /// known at `.playing` instead of a second later.
    func testARouteHeardForLessThanASecondIsNotKnown() throws {
        var car = RouteResumeTests.playing(through: RouteResumeTests.carPlay)
        let lost = car.send(.session(.route(RouteResumeTests.lost(RouteResumeTests.carPlay))), after: 500)
        XCTAssertEqual(RouteResumeTests.rows("route", lost).first?[field: "known"], .bool(false))
        let back = car.send(.session(.route(RouteResumeTests.back(RouteResumeTests.carPlay))))
        XCTAssertEqual(try backRow(back)[field: "why"], .string("unknown-route"))
        XCTAssertFalse(resumed(back))
    }

    /// A second and a half heard through CarPlay, then a stall (`.waiting`)
    /// with no position tick in between (they are 15 s apart), then half a
    /// second more and the car off: the car WAS heard for a second, so it is
    /// known and its return resumes. The stall must not throw the first span
    /// away when the second one starts.
    /// TO SEE IT FAIL: drop the known-set update from `stopHearing`.
    func testAStallDoesNotForgetASecondAlreadyHeard() throws {
        var car = RouteResumeTests.playing(through: RouteResumeTests.carPlay)
        let token = try XCTUnwrap(car.lastLoad)
        car.reading.audible = false
        car.send(.deck(.timeControl(token: token, status: .waiting, waitingReason: nil)), after: 1_500)
        car.reading.audible = true
        car.send(.deck(.timeControl(token: token, status: .playing, waitingReason: nil)), after: 300)
        let lost = car.send(.session(.route(RouteResumeTests.lost(RouteResumeTests.carPlay))), after: 500)
        XCTAssertEqual(RouteResumeTests.rows("route", lost).first?[field: "known"], .bool(true), "\(lost)")
        let back = car.send(.session(.route(RouteResumeTests.back(RouteResumeTests.carPlay))))
        XCTAssertEqual(try backRow(back)[field: "why"], .string("route-back"))
        XCTAssertTrue(resumed(back), "\(back)")
    }

    /// Either order (plan §4.3): the deck's own pause arrives first and is
    /// blamed on the system, then the route goes within 500 ms. It is still
    /// the loss of a PLAYING route, so the car's return resumes it.
    /// TO SEE IT FAIL: drop the snapshot restore in `onRoute`.
    func testAnUncommandedPauseJustBeforeTheLossIsStillTheRoutes() throws {
        var car = RouteResumeTests.playing(through: RouteResumeTests.carPlay)
        car.reading.audible = false
        car.send(.deck(.pausedUncommanded(token: car.lastLoad!, atSec: 3)))
        XCTAssertEqual(car.core.state.routeResume.pausedBy, .system)
        car.send(.session(.route(RouteResumeTests.lost(RouteResumeTests.carPlay))), after: 200)
        XCTAssertEqual(car.core.state.routeResume.pausedBy, .route)
        let back = car.send(.session(.route(RouteResumeTests.back(RouteResumeTests.carPlay))))
        XCTAssertTrue(resumed(back), "\(back)")
    }

    /// A call while the car is gone clears it (Q5), and so does a loss older
    /// than 24 h, measured on the WALL clock (the monotonic one here moves a
    /// second; a phone asleep in a parked car does not count uptime).
    /// TO SEE IT FAIL: step `.interruption` nowhere, or measure `lostSec` on
    /// `now.monoMs`.
    func testACallOrADayAndAnHourKeepsItPaused() throws {
        var call = RouteResumeTests.playing(through: RouteResumeTests.carPlay)
        call.send(.session(.route(RouteResumeTests.lost(RouteResumeTests.carPlay))))
        call.send(.session(.interruptionBegan(reason: "default")))
        call.send(.session(.interruptionEnded(shouldResume: false)))
        XCTAssertEqual(try backRow(call.send(.session(.route(RouteResumeTests.back(RouteResumeTests.carPlay)))))[field: "why"],
                       .string("interrupted"))

        var parked = RouteResumeTests.playing(through: RouteResumeTests.carPlay)
        parked.send(.session(.route(RouteResumeTests.lost(RouteResumeTests.carPlay))))
        parked.wallMs += 25 * 3_600_000
        let back = parked.send(.session(.route(RouteResumeTests.back(RouteResumeTests.carPlay))))
        let row = try backRow(back)
        XCTAssertEqual(row[field: "why"], .string("lost-too-long"))
        XCTAssertEqual(row[field: "lostSec"], .number(25 * 3_600))
        XCTAssertFalse(resumed(back))
    }

    /// Delete my data forgets every known route (the host then removes the
    /// private key).
    /// TO SEE IT FAIL: drop the known-set reset from `stop(persist: false)`.
    func testADataDeletionForgetsTheRoutes() throws {
        var car = RouteResumeTests.playing(through: RouteResumeTests.carPlay)
        car.send(.session(.route(RouteResumeTests.lost(RouteResumeTests.carPlay))))
        XCTAssertEqual(car.core.state.knownRoutes.keys.count, 1)
        car.send(try EngineCoreTests.command("purge"))
        XCTAssertEqual(car.core.state.knownRoutes.keys, [])
    }

    // MARK: - The pieces

    /// FIPS 180-4's vectors: the hash the keys are made of is SHA-256.
    func testSHA256MatchesTheStandardVectors() {
        XCTAssertEqual(RouteResume.sha256Hex(Array("".utf8)),
                       "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        XCTAssertEqual(RouteResume.sha256Hex(Array("abc".utf8)),
                       "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        XCTAssertEqual(RouteResume.sha256Hex(Array("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq".utf8)),
                       "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1")
        XCTAssertEqual(RouteResume.sha256Hex([UInt8](repeating: 0x61, count: 1_000)),
                       "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3")
    }

    /// A key is salted: the same port and UID under two installs' salts are
    /// two keys; no UID is no key.
    func testKeysAreSaltedAndNeedAUID() throws {
        let one = try XCTUnwrap(RouteResume.hashedKey(portType: "CarAudio", uid: "u", salt: RouteResumeTests.salt))
        let other = try XCTUnwrap(RouteResume.hashedKey(portType: "CarAudio", uid: "u", salt: String(repeating: "f", count: 32)))
        XCTAssertNotEqual(one, other)
        XCTAssertTrue(RouteResume.isHashedKey(one))
        XCTAssertEqual(RouteResume.rowKey(one)?.count, 8)
        XCTAssertNil(RouteResume.hashedKey(portType: "CarAudio", uid: "", salt: RouteResumeTests.salt))
        XCTAssertNil(RouteResume.hashedKey(portType: nil, uid: "u", salt: RouteResumeTests.salt))
        XCTAssertTrue(RouteResume.isSalt(RouteResume.newSalt()))
    }

    /// At most eight, least recently used first out; hearing one again makes
    /// it the most recent; anything that is not a salted key is dropped.
    func testTheKnownSetKeepsTheEightMostRecentlyHeard() {
        let keys = (0..<9).map { RouteResume.sha256Hex(Array("k\($0)".utf8)) }
        var set = RouteResume.KnownRoutes(Array(keys.prefix(8)) + ["not-a-key"])
        XCTAssertEqual(set.keys, Array(keys.prefix(8)))
        XCTAssertTrue(set.use(keys[0]), "heard again: now the most recent")
        XCTAssertFalse(set.use(keys[0]), "already the most recent: nothing to write")
        XCTAssertTrue(set.use(keys[8]))
        XCTAssertEqual(set.keys.count, 8)
        XCTAssertFalse(set.contains(keys[1]), "the least recently used went first")
        XCTAssertTrue(set.contains(keys[0]))
        XCTAssertEqual(set.keys.last, keys[8])
        XCTAssertNil(RouteResume.Stored.parse("{\"v\":2,\"salt\":\"\(RouteResumeTests.salt)\",\"keys\":[]}"))
        XCTAssertNil(RouteResume.Stored.parse("{\"v\":1,\"salt\":\"short\",\"keys\":[]}"))
        XCTAssertNil(RouteResume.Stored.parse(nil))
    }
}
