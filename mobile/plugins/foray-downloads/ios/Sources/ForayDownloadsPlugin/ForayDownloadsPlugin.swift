import Foundation
import Capacitor

/// `ForayDownloads` on iOS: the seven calls `player/download-bridge.js` makes,
/// answered from `DownloadStore` (issue #29; docs/roadmap/player-features.md
/// PQ-20). The web half is that file; like `foray-vault`, this plugin has no JS
/// entry of its own.
///
///   enqueue({ id, url, userAgent, allowCellular }) -> the row (status `queued`)
///   cancel({ id })
///   remove({ id })                                  -> { removed }
///   removeAll()
///   list()                                          -> { items: [row] }
///   usage()                                         -> { bytes, count }
///   fileSrc({ id } | { path })                      -> { path, exists }
///
/// and three events, `downloadProgress {id, bytes, total}`, `downloadDone {id,
/// path, bytes}` and `downloadFailed {id, reason, status}`. A row's `path` is
/// the file's absolute path TODAY: iOS moves the app's container when it
/// updates or restores the app, so the page should take paths from `list()`
/// rather than keep one forever. The page turns a path into a `file://` URL
/// itself (download-store.js percent-encodes it, because "Application
/// Support" has a space).
///
/// A bad argument or a file-system error REJECTS the call; the web half turns
/// every rejection into `{ ok: false, reason }`.
@objc(ForayDownloadsPlugin)
public class ForayDownloadsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ForayDownloadsPlugin"
    public let jsName = "ForayDownloads"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "enqueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeAll", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "usage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fileSrc", returnType: CAPPluginReturnPromise)
    ]

    private let store = DownloadStore.shared

    override public func load() {
        store.emit = { [weak self] name, payload in
            self?.notifyListeners(name, data: payload)
        }
        store.start()
    }

    /// The AppDelegate's `application(_:handleEventsForBackgroundURLSession:
    /// completionHandler:)` forwards here once PQ-21's patch is in; returns
    /// false for any other session's identifier. Until then nothing calls it,
    /// and downloads still complete (see DownloadStore's header).
    @objc public static func handleEventsForBackgroundURLSession(_ identifier: String,
                                                                 completionHandler: @escaping () -> Void) -> Bool {
        DownloadStore.shared.handleEventsForBackgroundURLSession(identifier: identifier,
                                                                 completionHandler: completionHandler)
    }

    @objc func enqueue(_ call: CAPPluginCall) {
        do {
            let row = try store.enqueue(id: call.getString("id"),
                                        url: call.getString("url"),
                                        userAgent: call.getString("userAgent"),
                                        allowCellular: call.getBool("allowCellular") ?? false)
            call.resolve(row)
        } catch {
            call.reject(String(describing: error))
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        do {
            try store.cancel(id: call.getString("id"))
            call.resolve()
        } catch {
            call.reject(String(describing: error))
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        do {
            let removed = try store.remove(id: call.getString("id"))
            call.resolve(["removed": removed])
        } catch {
            call.reject(String(describing: error))
        }
    }

    @objc func removeAll(_ call: CAPPluginCall) {
        do {
            try store.removeAll()
            call.resolve()
        } catch {
            call.reject(String(describing: error))
        }
    }

    @objc func list(_ call: CAPPluginCall) {
        call.resolve(["items": store.list()])
    }

    @objc func usage(_ call: CAPPluginCall) {
        call.resolve(store.usage())
    }

    @objc func fileSrc(_ call: CAPPluginCall) {
        do {
            call.resolve(try store.fileSrc(id: call.getString("id"), path: call.getString("path")))
        } catch {
            call.reject(String(describing: error))
        }
    }
}
