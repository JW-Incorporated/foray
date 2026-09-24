import Foundation
import UIKit
import ForayEngineCore
import os

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
        return NotificationObservation(center: center, tokens: tokens)
    }
}

/// Block-based observers, removed exactly once: when cancelled or dropped.
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

/// Where `EngineOwnership`'s rows go until EngineStore's diagnostics ring
/// (NE-19) exists: the unified log, which `ios-build.yml`'s `log stream`
/// captures. `.public`: the row IS the point of the line, and every value in
/// it is a closed token, a count or a build number.
enum EngineOwnershipLog {
    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "ai.jwlabs.foura",
        category: "ForayEngine"
    )

    static func write(_ entry: DiagEntry) {
        let line = DiagRow(seq: 0, wallMs: Date().timeIntervalSince1970 * 1000,
                           monoMs: Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000,
                           kind: entry.kind, fields: entry.fields).line()
        logger.log("\(line, privacy: .public)")
    }
}
