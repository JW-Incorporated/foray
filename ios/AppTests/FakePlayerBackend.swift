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
///
/// LOCKED, not just `@unchecked Sendable` on faith: `PlayerQueueManager` (an actor)
/// calls into this from its own isolated context, but a test's polling loop (see
/// `PlayerQueueManagerTests.waitUntil`) reads `calls`/`rate` from the test's task
/// concurrently with that — an unsynchronized `Array`/`Float` read-while-append is
/// a real data race, not just a compiler-diagnostic suppression, so every mutable
/// property here goes through `lock`.
final class FakePlayerBackend: PlayerBackend, @unchecked Sendable {

    enum Call: Equatable {
        case load(url: URL, startOffset: CMTime)
        case seek(to: CMTime)
        case play
        case pause
    }

    private let lock = NSLock()
    private var _calls: [Call] = []
    private var _nextLoadError: Error?
    private var _rate: Float = 1.0
    private var _currentTime: CMTime = .zero
    private var _currentDuration: CMTime? = nil
    private var _onItemDidPlayToEnd: (@Sendable () -> Void)?

    var calls: [Call] {
        lock.lock(); defer { lock.unlock() }
        return _calls
    }

    /// Set by a test to make the next `load(url:startOffset:)` throw, simulating a
    /// missing/corrupt local file (05_CORNER_CASES.md #6/#10).
    var nextLoadError: Error? {
        get { lock.lock(); defer { lock.unlock() }; return _nextLoadError }
        set { lock.lock(); _nextLoadError = newValue; lock.unlock() }
    }

    var rate: Float {
        get { lock.lock(); defer { lock.unlock() }; return _rate }
        set { lock.lock(); _rate = newValue; lock.unlock() }
    }

    var currentTime: CMTime {
        get { lock.lock(); defer { lock.unlock() }; return _currentTime }
        set { lock.lock(); _currentTime = newValue; lock.unlock() }
    }

    var currentDuration: CMTime? {
        get { lock.lock(); defer { lock.unlock() }; return _currentDuration }
        set { lock.lock(); _currentDuration = newValue; lock.unlock() }
    }

    /// Fired manually by a test to simulate `AVPlayerItemDidPlayToEndTime` — the
    /// same seam `AVPlayerBackend.onItemDidPlayToEnd` wires up in production.
    var onItemDidPlayToEnd: (@Sendable () -> Void)? {
        get { lock.lock(); defer { lock.unlock() }; return _onItemDidPlayToEnd }
        set { lock.lock(); _onItemDidPlayToEnd = newValue; lock.unlock() }
    }

    /// Test helper: drop everything recorded so far, without touching the other
    /// fields (`rate`, `nextLoadError`, etc). Equivalent to `calls.removeAll()` on
    /// the old unlocked array, but safe against the manager's own Task appending
    /// to it concurrently.
    func clearCalls() {
        lock.lock(); _calls.removeAll(); lock.unlock()
    }

    func load(url: URL, startOffset: CMTime) async throws {
        let error: Error? = {
            lock.lock(); defer { lock.unlock() }
            _calls.append(.load(url: url, startOffset: startOffset))
            let e = _nextLoadError
            _nextLoadError = nil
            return e
        }()
        if let error { throw error }
    }

    func seek(to time: CMTime) async {
        lock.lock()
        _calls.append(.seek(to: time))
        _currentTime = time
        lock.unlock()
    }

    func play() {
        lock.lock(); _calls.append(.play); lock.unlock()
    }

    func pause() {
        lock.lock(); _calls.append(.pause); lock.unlock()
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
