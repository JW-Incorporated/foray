import Foundation
import UIKit
import ForayEngineCore

/// The part of `UIApplication` BackgroundGrace touches. `UIKitBackgroundTasks`
/// is the real one; the XCTests hand BackgroundGrace a recording fake, because
/// a package test has no app (`UIApplication.shared` does not exist there) and
/// no way to make the system take background time back on demand.
///
/// Raw identifiers, not `UIBackgroundTaskIdentifier`, so the fake needs no
/// UIKit value and the expiration handler's type does not depend on which
/// SDK annotated it `@MainActor @Sendable`.
protocol BackgroundTaskAPI: AnyObject {
    /// `beginBackgroundTask(withName:expirationHandler:)`: the raw identifier,
    /// or nil for `.invalid` (the system refused).
    func beginBackgroundTask(named name: String, expiration: @escaping () -> Void) -> Int?
    func endBackgroundTask(_ raw: Int)
    /// `backgroundTimeRemaining` in seconds; nil in the foreground, where
    /// UIKit reports a meaningless huge number.
    var backgroundTimeRemainingSec: Double? { get }
}

/// `UIApplication.shared`, on main. Every member is main-actor isolated in
/// UIKit, and the engine only ever calls in from main (plan §4.2), so each
/// call asserts that rather than hopping.
final class UIKitBackgroundTasks: BackgroundTaskAPI {
    /// Anything at or above this is UIKit's "you are in the foreground"
    /// answer (`greatestFiniteMagnitude`), not a budget: the real one starts
    /// at about 30 s when a task begins in the background.
    static let foregroundSentinelSec: Double = 1_000_000

    func beginBackgroundTask(named name: String, expiration: @escaping () -> Void) -> Int? {
        MainActor.assumeIsolated { () -> Int? in
            let id = UIApplication.shared.beginBackgroundTask(withName: name) { expiration() }
            return id == .invalid ? nil : id.rawValue
        }
    }

    func endBackgroundTask(_ raw: Int) {
        MainActor.assumeIsolated {
            UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: raw))
        }
    }

    var backgroundTimeRemainingSec: Double? {
        MainActor.assumeIsolated { () -> Double? in
            let app = UIApplication.shared
            guard app.applicationState != .active else { return nil }
            let remaining = app.backgroundTimeRemaining
            return remaining.isFinite && remaining < Self.foregroundSentinelSec ? remaining : nil
        }
    }
}

/// THE REAL `BackgroundTasking` (card NE-16g; docs/native-engine-plan.md
/// §4.4): the background time that keeps the app alive while the engine
/// INTENDS to play but nothing is audible yet.
///
/// WHY IT EXISTS. `UIBackgroundModes: audio` keeps a backgrounded app running
/// only while audio renders. Between a car's play and the deck's first
/// audible frame (a remote play, a tap on a backgrounded app, an interruption
/// or route resume, a cold play) nothing renders, and iOS may suspend the
/// app in exactly that gap: the car shows "playing" and stays silent. The
/// core opens a span for each of those intents (`EngineCommand.graceBegin`)
/// and closes it on the first confirmed `timeControlStatus == .playing`, when
/// the intent ends, or at idle; the host turns each span into one task here.
///
/// It DECIDES NOTHING, as AudioSessionOwner decides nothing: when a span
/// opens and closes is the core's, what an expiry means (a pause with
/// `stop cause=grace-expired`) is the core's, and the rows are the host's.
///
/// THE ONE RULE IT ENFORCES ITSELF: A TASK NEVER OUTLIVES ITS EXPIRATION
/// HANDLER. UIKit terminates an app whose expired task is still open when the
/// handler returns. The host ends the task inside the handler it passed in;
/// if it did not (a bug, or the engine already gone), this type ends it
/// anyway, after the host's handler has run. And ending is idempotent: a task
/// is ended at most once, because UIKit logs a second end as a programming
/// error.
final class BackgroundGrace: BackgroundTasking {

    private let api: BackgroundTaskAPI
    private let center: NotificationCenter
    /// Tasks begun here and not yet ended.
    private var live: Set<Int> = []

    init(api: BackgroundTaskAPI = UIKitBackgroundTasks(), center: NotificationCenter = .default) {
        self.api = api
        self.center = center
    }

    /// Tasks still open (tests and diagnostics: a leak is a number).
    var liveTaskCount: Int { live.count }

    // MARK: - BackgroundTasking

    func beginTask(named name: String, expiration: @escaping () -> Void) -> BackgroundTaskID? {
        // The handler can only run after begin returns (UIKit calls it later,
        // on main), but it must know which task it belongs to: a box, filled
        // in below.
        let box = TaskBox()
        let raw = api.beginBackgroundTask(named: name) { [weak self, api] in
            Self.onMain {
                guard let id = box.raw else { return }
                guard let self else {
                    // The owner is gone and cannot end it: end it here, or
                    // UIKit kills the app when this handler returns.
                    api.endBackgroundTask(id)
                    return
                }
                self.expired(id, handler: expiration)
            }
        }
        guard let raw else { return nil }
        box.raw = raw
        live.insert(raw)
        return raw
    }

    func endTask(_ id: BackgroundTaskID) {
        guard live.remove(id) != nil else { return }
        api.endBackgroundTask(id)
    }

    var backgroundTimeRemainingSec: Double? { api.backgroundTimeRemainingSec }

    /// `didEnterBackground`, `willEnterForeground` and `willTerminate`,
    /// observed on the main queue (the core's `backgrounded` flag decides
    /// whether a tap opens a span, so it must be ordered with every other
    /// input on main).
    ///
    /// `willTerminate` is NE-19's: the core flushes the playhead on
    /// `.terminating` and the host makes it durable before the handler
    /// returns. This is the only real conformer, so a notification it
    /// does not observe is a flush that never happens on a device.
    func observeLifecycle(_ handler: @escaping (LifecycleEvent) -> Void) -> EngineObservation {
        let background = center.addObserver(forName: UIApplication.didEnterBackgroundNotification,
                                            object: nil, queue: .main) { _ in handler(.background) }
        let foreground = center.addObserver(forName: UIApplication.willEnterForegroundNotification,
                                            object: nil, queue: .main) { _ in handler(.foreground) }
        let terminating = center.addObserver(forName: UIApplication.willTerminateNotification,
                                             object: nil, queue: .main) { _ in handler(.terminating) }
        return NotificationObservation(center: center, tokens: [background, foreground, terminating])
    }

    // MARK: - Expiry

    /// The system took the time back. The host's handler ends the task,
    /// writes `grace kind=expired` and feeds the core `.timer(.graceExpired)`;
    /// whatever it did, the task is closed before this returns.
    private func expired(_ id: Int, handler: () -> Void) {
        guard live.contains(id) else { return }
        handler()
        endTask(id)
    }

    /// UIKit documents the expiration handler as called on main. If a future
    /// SDK ever calls it elsewhere, hop synchronously: the task must still be
    /// ended before the handler returns, and main is where the engine lives.
    private static func onMain(_ work: () -> Void) {
        if Thread.isMainThread {
            work()
        } else {
            DispatchQueue.main.sync(execute: work)
        }
    }
}

/// Which task an expiration handler belongs to, known only after begin
/// returned.
private final class TaskBox {
    var raw: Int?
}
