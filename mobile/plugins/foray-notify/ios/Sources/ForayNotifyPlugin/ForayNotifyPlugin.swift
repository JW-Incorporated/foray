import Foundation
import Capacitor
import UserNotifications
import BackgroundTasks

/// `ForayNotify` on iOS: local new-episode alerts for followed shows, and the
/// tap that opens the show (issue #761; docs/roadmap/player-features.md PQ-28).
/// Like foray-vault and foray-downloads, the plugin has no JS entry of its own:
/// the web half is `player/alert-open.js` (`ALERT_PLUGIN`, `ALERT_EVENT`).
///
///   requestPermission()            -> { granted }   the ONE place that asks
///   status()                       -> { status, granted }
///   scheduleRefresh()              -> { earliest }  a BGAppRefreshTaskRequest, 6 h out
///   notifyNow({ title, body, showId })              post one alert now
///
/// and one event, `alertOpened { showId }`, when the listener taps an alert.
///
/// UNDECLARED, SO INERT. Nothing in `mobile/package.json` names this plugin
/// yet, so `cap sync` does not fold it into the shell and no build ships it;
/// its XCTests run in ci.yml's ios-kit job. PQ-30 declares it, writes the
/// `BGTaskSchedulerPermittedIdentifiers` plist key (exactly
/// `AlertRules.taskIdentifier`) and has the AppDelegate call
/// `registerBackgroundRefresh()` before `didFinishLaunching` returns, which is
/// where iOS requires the launch handler to be registered.
///
/// THE TAP. Capacitor's bridge owns `UNUserNotificationCenter`'s delegate
/// (its `NotificationRouter`) and hands each local notification to whichever
/// plugin registered as its `localNotificationHandler`; this plugin registers
/// in `load()` rather than replacing the center's delegate, so the bridge's
/// routing stays whole. A tap on one of OUR alerts (the userInfo marker,
/// `AlertRules.showId(fromUserInfo:)`) emits `alertOpened`. On a cold start
/// the tap can arrive before the page has attached its listener, so the event
/// is RETAINED until one attaches, and only the last tap is kept: two
/// retained taps would route twice and land where the last one says anyway.
@objc(ForayNotifyPlugin)
public class ForayNotifyPlugin: CAPPlugin, CAPBridgedPlugin, NotificationHandlerProtocol {
    public let identifier = "ForayNotifyPlugin"
    public let jsName = "ForayNotify"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scheduleRefresh", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "notifyNow", returnType: CAPPluginReturnPromise)
    ]

    override public func load() {
        bridge?.notificationRouter.localNotificationHandler = self
        // The stale-page guard's ledger names only shows still followed.
        AlertsRefresh.pruneLedger(.standard)
    }

    // MARK: calls

    /// The permission prompt, and the only `requestAuthorization` in the plugin:
    /// the page asks when the listener turns a show's alerts on, never at launch.
    @objc func requestPermission(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            call.resolve(["granted": granted])
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let token = ForayNotifyPlugin.statusToken(settings.authorizationStatus)
            call.resolve(["status": token, "granted": token == "granted" || token == "provisional" || token == "ephemeral"])
        }
    }

    @objc func scheduleRefresh(_ call: CAPPluginCall) {
        do {
            let earliest = try ForayNotifyPlugin.submitRefresh()
            call.resolve(["earliest": AlertRules.isoString(earliest)])
        } catch {
            call.reject(String(describing: error))
        }
    }

    @objc func notifyNow(_ call: CAPPluginCall) {
        guard let showId = call.getString("showId"), !showId.isEmpty else {
            call.reject("showId is required")
            return
        }
        AlertPoster.post(title: call.getString("title") ?? "", body: call.getString("body") ?? "", showId: showId) { error in
            if let error = error {
                call.reject(String(describing: error))
            } else {
                call.resolve()
            }
        }
    }

    // MARK: the tap (NotificationHandlerProtocol, via Capacitor's NotificationRouter)

    public func willPresent(notification: UNNotification) -> UNNotificationPresentationOptions {
        AlertRules.showId(fromUserInfo: notification.request.content.userInfo) == nil ? [] : [.banner, .list, .sound]
    }

    public func didReceive(response: UNNotificationResponse) {
        guard let showId = AlertRules.showId(fromUserInfo: response.notification.request.content.userInfo) else { return }
        emitAlertOpened(showId)
    }

    /// `alertOpened { showId }`, retained until a listener attaches; the last tap wins.
    func emitAlertOpened(_ showId: String) {
        let event = AlertRules.eventAlertOpened
        if !hasListeners(event) {
            retainedEventArguments?.removeObject(forKey: event)
        }
        notifyListeners(event, data: ["showId": showId], retainUntilConsumed: true)
    }

    // MARK: the background refresh

    /// Register the launch handler. iOS requires this before the app finishes
    /// launching, so the AppDelegate calls it (PQ-30's injector), not `load()`.
    @discardableResult
    @objc public static func registerBackgroundRefresh() -> Bool {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: AlertRules.taskIdentifier, using: nil) { task in
            ForayNotifyPlugin.runRefresh(task)
        }
    }

    /// Ask for the next refresh, no earlier than six hours from now.
    @discardableResult
    static func submitRefresh() throws -> Date {
        let request = BGAppRefreshTaskRequest(identifier: AlertRules.taskIdentifier)
        let earliest = Date(timeIntervalSinceNow: AlertRules.checkIntervalSec)
        request.earliestBeginDate = earliest
        try BGTaskScheduler.shared.submit(request)
        return earliest
    }

    /// One refresh: the next one is asked for first (Apple's advice), then the
    /// pass runs; expiry or the pass finishing completes the task, once.
    static func runRefresh(_ task: BGTask) {
        _ = try? submitRefresh()
        let completion = TaskCompletion(task)
        task.expirationHandler = { completion.finish(success: false) }
        AlertsRefresh().run { _ in completion.finish(success: true) }
    }

    static func statusToken(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .notDetermined: return "prompt"
        case .provisional: return "provisional"
        case .ephemeral: return "ephemeral"
        @unknown default: return "unknown"
        }
    }
}

/// `setTaskCompleted` exactly once, whichever of expiry and the pass comes first.
final class TaskCompletion {
    private let task: BGTask
    private let lock = NSLock()
    private var finished = false

    init(_ task: BGTask) { self.task = task }

    func finish(success: Bool) {
        lock.lock()
        defer { lock.unlock() }
        guard !finished else { return }
        finished = true
        task.setTaskCompleted(success: success)
    }
}
