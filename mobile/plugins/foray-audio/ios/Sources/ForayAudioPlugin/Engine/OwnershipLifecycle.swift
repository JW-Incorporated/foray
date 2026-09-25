import Foundation
import UIKit

/// The real `OwnershipLifecycle` (card NE-17): `willResignActive` and
/// `didEnterBackground`, the healthy marker's lifecycle leg. The only UIKit
/// in the ownership story, so `EngineOwnership` runs headless over a fake.
///
/// `queue: .main`: the owner is main-confined and asserts it; a notification
/// delivered on the poster's thread would be a hop the owner cannot see.
final class UIKitOwnershipLifecycle: OwnershipLifecycle {
    func observeResignOrBackground(_ handler: @escaping () -> Void) -> EngineObservation {
        let center = NotificationCenter.default
        let tokens = [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification].map {
            center.addObserver(forName: $0, object: nil, queue: .main) { _ in handler() }
        }
        return ResignObservation(center: center, tokens: tokens)
    }
}

/// Block-based observers, removed exactly once: when cancelled or dropped.
private final class ResignObservation: EngineObservation {
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

extension UIKitOwnershipLifecycle {
    /// Whether iOS launched this process straight into the background: a
    /// car's or a headset's play reaching a terminated 4a (NE-24's `build
    /// launch=background`, which DV-7a is judged on). Read at the boot, inside
    /// `didFinishLaunching`, where a user's launch is still `.inactive`.
    @MainActor
    static var launchedInBackground: Bool {
        UIApplication.shared.applicationState == .background
    }
}
