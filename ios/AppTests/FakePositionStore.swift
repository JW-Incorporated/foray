import Foundation
@testable import Foray

/// Test double for `PositionStore` (see `PlayerQueueManager.swift`) — an in-memory
/// dictionary instead of `UserDefaults`, exactly the seam the protocol's own doc
/// comment says exists so tests don't require real disk I/O.
final class FakePositionStore: PositionStore, @unchecked Sendable {
    private(set) var saved: [String: Double] = [:]

    func savePosition(itemID: String, seconds: Double) {
        saved[itemID] = seconds
    }

    func loadPosition(itemID: String) -> Double? {
        saved[itemID]
    }
}
