import Foundation
import AVFoundation
import CoreMedia
@testable import Foray

/// A test double for `PlayerBackend` (see `App/Player/PlayerBackend.swift`) that
/// records every call instead of touching AVFoundation, so `PlayerQueueManager`'s
/// orchestration (which effect -> which backend call, in what order) can be
/// exercised without a real audio session or asset.
///
/// This is exactly the seam `PlayerBackend.swift`'s own header describes existing
/// for: "PlayerQueueManager's orchestration logic... can be exercised in tests with
/// a fake/mock backend, without touching AVFoundation or a real audio session."
final class FakePlayerBackend: PlayerBackend, @unchecked Sendable {

    enum Call: Equatable {
        case load(url: URL, startOffset: CMTime)
        case seek(to: CMTime)
        case play
        case pause
    }

    private(set) var calls: [Call] = []

    /// Set by a test to make the next `load(url:startOffset:)` throw, simulating a
    /// missing/corrupt local file (05_CORNER_CASES.md #6/#10).
    var nextLoadError: Error?

    var rate: Float = 1.0
    var currentTime: CMTime = .zero
    var currentDuration: CMTime? = nil

    /// Fired manually by a test to simulate `AVPlayerItemDidPlayToEndTime` — the
    /// same seam `AVPlayerBackend.onItemDidPlayToEnd` wires up in production.
    var onItemDidPlayToEnd: (@Sendable () -> Void)?

    func load(url: URL, startOffset: CMTime) async throws {
        calls.append(.load(url: url, startOffset: startOffset))
        if let error = nextLoadError {
            nextLoadError = nil
            throw error
        }
    }

    func seek(to time: CMTime) async {
        calls.append(.seek(to: time))
        currentTime = time
    }

    func play() {
        calls.append(.play)
    }

    func pause() {
        calls.append(.pause)
    }

    /// Test helper: simulate the backend finishing the currently-loaded item, the
    /// same way `AVPlayerBackend`'s `AVPlayerItemDidPlayToEndTime` observer does.
    func simulateItemDidPlayToEnd() {
        onItemDidPlayToEnd?()
    }
}

enum FakePlayerBackendError: Error {
    case missingFile
}
