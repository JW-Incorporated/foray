import XCTest
import ForayEngineCore

/// Card NE-38rs, step 0: the founder's Q5 rule against `main`'s branch,
/// BEFORE the port. A listener's pause is never resumed, even when the car is
/// then switched off and on again. `main`'s `onRoute` resumes any
/// `.interrupted(_, true)`, and the reducer models a listener's pause as
/// exactly that, so this test is expected to FAIL here; the port makes it pass.
final class RouteResumeTests: XCTestCase {
    func testAListenersPauseIsNotResumedWhenTheCarIsLostAndBack() {
        var car = EngineCoreTests.Host()
        car.send(.queue(.load([EngineCoreTests.item("a")])))
        car.send(.queue(.playIndex(0, startSec: nil, source: .tap)))
        car.land()
        car.confirm()
        XCTAssertEqual(car.core.state.stateType, "playing")
        car.send(.command(.pause, source: .tap))
        car.send(.session(.route(RouteChange(oldDeviceUnavailable: true, routeName: "Civic", isCarRoute: true))))
        let back = car.send(.session(.route(RouteChange(oldDeviceUnavailable: false, routeName: "Civic", isCarRoute: true))))
        XCTAssertFalse(back.contains(.graceBegin(.routeResume)), "a listener's pause was resumed: \(back)")
        XCTAssertFalse(back.contains { if case .deck(.load) = $0 { return true }; return false },
                       "a listener's pause was resumed: \(back)")
    }
}
