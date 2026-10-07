import Foundation

/// The iOS download store: a background `URLSession` that fetches episode
/// audio into `Application Support/foray-downloads/`, and a JSON index beside
/// the files that remembers what is there. Issue #29; PQ-20.
///
/// WHAT RUNS WHERE.
/// - The rules (requests, redirect cap, status verdicts, file names, usage)
///   are `DownloadPolicy`'s, pure and XCTest-covered.
/// - The PROBE (`Range: bytes=0-0` GET) runs in an ephemeral foreground
///   session, because only a default or ephemeral session asks its delegate
///   about redirects; that is where the eight-redirect cap is enforced.
/// - The TRANSFER runs in the background session
///   (`DownloadPolicy.sessionIdentifier`), so it continues while the app is
///   suspended, fetching the URL the probe landed on.
///
/// THE APPDELEGATE HOOK. `handleEventsForBackgroundURLSession` is forwarded
/// here by the method `tools/mobile/inject-background-audio.mjs` writes into
/// the generated AppDelegate (PQ-21); the shell build re-checks it is there.
/// The hook is not what makes a download land: a transfer that finishes while
/// the app is suspended is still delivered if the hook is missing, because
/// iOS replays the session's delegate events when the app next creates the
/// session with this identifier (on the plugin's `load()`), and a transfer
/// that finishes in the foreground needs no hook at all. What the hook adds
/// is finishing (and emitting `downloadDone`) while the app stays in the
/// background, and telling iOS when that work is done.
///
/// THE ATTEMPT ROW (#29, 29-part). Every attempt that ends -- the probe
/// refusing, or the transfer finishing, failing or being cancelled -- emits
/// one `downloadAttempt` (`emitAttempt`): the requested host (the row's
/// original `url`), the host the last response came from, its status, the
/// bytes announced and received, and the outcome. An unreachable probe is
/// not an end: its transfer is, and that emits. A download the listener
/// REMOVED emits nothing (its row went first, as for `downloadFailed`), so
/// "Delete my data" does not write diagnostics behind itself.
///
/// THREADING. Every read and write of `index` happens on `queue`; the session
/// delegates run on `delegateQueue`, a serial queue whose callbacks hop onto
/// `queue` the same way. Events are handed to `emit` as they happen.
final class DownloadStore: NSObject {
    static let shared = DownloadStore()

    /// The plugin's `notifyListeners`, set in its `load()`.
    var emit: ((String, [String: Any]) -> Void)?

    private let queue = DispatchQueue(label: "ai.jwlabs.foura.downloads.store")
    private let delegateQueue: OperationQueue = {
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        q.name = "ai.jwlabs.foura.downloads.delegate"
        return q
    }()

    private var index = DownloadIndex()
    private var loaded = false
    private var lastProgressAt: [String: TimeInterval] = [:]
    private var backgroundCompletion: (() -> Void)?
    private var probes: [String: Probe] = [:]

    /// Created once, in `init`, and never replaced: iOS allows one session
    /// per background identifier per process, and the session must exist
    /// before iOS can replay the events of a transfer that finished while the
    /// app was not running.
    private var session: URLSession!

    private override init() {
        super.init()
        let config = URLSessionConfiguration.background(withIdentifier: DownloadPolicy.sessionIdentifier)
        // The listener asked for this episode; iOS may still defer a large
        // transfer to a better moment, which is what background transfers are for.
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        session = URLSession(configuration: config, delegate: self, delegateQueue: delegateQueue)
    }

    // MARK: the directory

    /// `Application Support/foray-downloads/`, the same base
    /// `EngineDiagnostics.defaultDirectory()` uses for `foray-engine`.
    static func directory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent(DownloadPolicy.directoryName, isDirectory: true)
    }

    private var indexURL: URL {
        DownloadStore.directory().appendingPathComponent(DownloadPolicy.indexFileName, isDirectory: false)
    }

    private func fileURL(_ name: String) -> URL {
        DownloadStore.directory().appendingPathComponent(name, isDirectory: false)
    }

    /// Creates the directory if needed and keeps it, and everything in it, out
    /// of iCloud and computer backups: a downloaded episode can be fetched
    /// again, and a 2 GB backup of podcasts is not the listener's wish.
    private func prepareDirectory() throws {
        let dir = DownloadStore.directory()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try excludeFromBackup(dir)
    }

    private func excludeFromBackup(_ url: URL) throws {
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var target = url
        try target.setResourceValues(values)
    }

    // MARK: the index (on `queue`)

    private func loadIfNeeded() {
        if loaded { return }
        loaded = true
        index = DownloadIndex.decode(try? Data(contentsOf: indexURL))
    }

    private func save() {
        guard let data = index.encoded() else { return }
        do {
            try prepareDirectory()
            try data.write(to: indexURL, options: [.atomic])
            try? excludeFromBackup(indexURL)
        } catch {
            // The files are still on disk; an unsaved index costs a re-download.
        }
    }

    /// A `done` row whose file is gone (deleted from the container, or never
    /// moved) is reported `missing`, the status download-store.js keeps for it.
    private func reconciled(_ record: DownloadRecord) -> DownloadRecord {
        guard record.status == "done" else { return record }
        if FileManager.default.fileExists(atPath: fileURL(record.file).path) { return record }
        var copy = record
        copy.status = "missing"
        return copy
    }

    private func answer(_ record: DownloadRecord) -> [String: Any] {
        let r = reconciled(record)
        var row: [String: Any] = ["id": r.id, "status": r.status, "bytes": r.bytes]
        row["total"] = r.total.map { $0 as Any } ?? (NSNull() as Any)
        row["reason"] = r.reason.map { $0 as Any } ?? (NSNull() as Any)
        // The absolute path is recomputed on every answer: the container's
        // path changes when iOS updates or restores the app.
        row["path"] = r.status == "done" ? fileURL(r.file).path as Any : NSNull() as Any
        return row
    }

    // MARK: start-up

    /// Called from the plugin's `load()`: reads the index and creates the
    /// background session, which is what lets iOS deliver events for
    /// transfers that finished while the app was not running.
    func start() {
        queue.sync { loadIfNeeded() }
        reconcileInterrupted()
    }

    /// A row left `queued` or `downloading` by a process that died has no
    /// probe (those live in memory) and may have no transfer: it would read
    /// "Downloading" forever. Such a row becomes `failed` / `interrupted`,
    /// which the page offers to retry. Rows with a live transfer are left alone.
    private func reconcileInterrupted() {
        session.getAllTasks { [weak self] tasks in
            guard let self = self else { return }
            let live = Set(tasks.compactMap { $0.taskDescription })
            self.queue.sync {
                var changed = false
                for (id, record) in self.index.items
                    where (record.status == "queued" || record.status == "downloading")
                    && !live.contains(id) && self.probes[id] == nil {
                    self.index.items[id]?.status = "failed"
                    self.index.items[id]?.reason = DownloadPolicy.reasonInterrupted
                    changed = true
                }
                if changed { self.save() }
            }
        }
    }

    /// The AppDelegate hook's target (wired by PQ-21). Holds iOS's completion
    /// handler until the session's queued events have been delivered.
    func handleEventsForBackgroundURLSession(identifier: String, completionHandler: @escaping () -> Void) -> Bool {
        guard identifier == DownloadPolicy.sessionIdentifier else { return false }
        queue.sync {
            backgroundCompletion = completionHandler
            loadIfNeeded()
        }
        return true
    }

    // MARK: the calls

    enum CallError: Error, CustomStringConvertible {
        case badId, badURL, notFound, io(String)
        var description: String {
            switch self {
            case .badId: return "ForayDownloads needs an episode id"
            case .badURL: return DownloadPolicy.reasonBadURL
            case .notFound: return "no such download"
            case .io(let message): return message
            }
        }
    }

    /// `enqueue({ id, url, userAgent, allowCellular })`: answers at once with
    /// the row (status `queued`, or the row that already exists), then probes
    /// and starts the transfer. Everything after the answer arrives as events.
    func enqueue(id rawId: String?, url rawURL: String?, userAgent: String?, allowCellular: Bool) throws -> [String: Any] {
        guard let id = rawId, !id.isEmpty else { throw CallError.badId }
        guard let url = DownloadPolicy.source(rawURL) else { throw CallError.badURL }
        return try queue.sync {
            loadIfNeeded()
            if let existing = index.items[id] {
                let current = reconciled(existing)
                if current.status == "queued" || current.status == "downloading" || current.status == "done" {
                    return answer(existing)
                }
            }
            do { try prepareDirectory() } catch { throw CallError.io(String(describing: error)) }
            let record = DownloadRecord(id: id, url: url.absoluteString,
                                        file: DownloadPolicy.fileName(forEpisodeId: id), status: "queued")
            index.items[id] = record
            save()
            startProbe(id: id, url: url, userAgent: userAgent, allowCellular: allowCellular)
            return answer(record)
        }
    }

    /// `cancel({ id })`: stops the probe or transfer; the row becomes
    /// `failed` / `cancelled` (retryable) and a `downloadFailed` says so.
    func cancel(id rawId: String?) throws {
        guard let id = rawId, !id.isEmpty else { throw CallError.badId }
        let known: Bool = queue.sync {
            loadIfNeeded()
            guard var record = index.items[id], record.status == "queued" || record.status == "downloading" else {
                return false
            }
            record.status = "failed"
            record.reason = DownloadPolicy.reasonCancelled
            index.items[id] = record
            save()
            probes.removeValue(forKey: id)?.cancel()
            return true
        }
        cancelTasks { $0 == id }
        if known {
            emit?(DownloadPolicy.eventFailed, DownloadPolicy.failedPayload(id: id, reason: DownloadPolicy.reasonCancelled, status: nil))
        }
    }

    /// `remove({ id })`: stops any transfer, deletes the file and the row.
    /// The row goes first, so the cancelled task's completion finds nothing
    /// to report and no `downloadFailed` resurrects a removed download.
    func remove(id rawId: String?) throws -> Bool {
        guard let id = rawId, !id.isEmpty else { throw CallError.badId }
        let file: String = queue.sync {
            loadIfNeeded()
            let name = index.items.removeValue(forKey: id)?.file ?? DownloadPolicy.fileName(forEpisodeId: id)
            probes.removeValue(forKey: id)?.cancel()
            lastProgressAt.removeValue(forKey: id)
            save()
            return name
        }
        cancelTasks { $0 == id }
        let url = fileURL(file)
        guard FileManager.default.fileExists(atPath: url.path) else { return false }
        do { try FileManager.default.removeItem(at: url) } catch { throw CallError.io(String(describing: error)) }
        return true
    }

    /// `removeAll()`: stops every transfer and deletes the whole directory,
    /// index included ("Delete my data", PQ-18 step 7).
    func removeAll() throws {
        queue.sync {
            loadIfNeeded()
            index = DownloadIndex()
            for probe in probes.values { probe.cancel() }
            probes.removeAll()
            lastProgressAt.removeAll()
        }
        cancelTasks { _ in true }
        let dir = DownloadStore.directory()
        guard FileManager.default.fileExists(atPath: dir.path) else { return }
        do { try FileManager.default.removeItem(at: dir) } catch { throw CallError.io(String(describing: error)) }
    }

    /// `list()`: every row, with `done` rows checked against the disk.
    func list() -> [[String: Any]] {
        queue.sync {
            loadIfNeeded()
            return index.items.keys.sorted().compactMap { key in index.items[key].map { answer($0) } }
        }
    }

    /// `usage()`: `{ bytes, count }` of finished downloads, from the index.
    func usage() -> [String: Any] {
        queue.sync {
            loadIfNeeded()
            let u = index.usage()
            return ["bytes": u.bytes, "count": u.count]
        }
    }

    /// `fileSrc({ id } | { path })`: the stored file's absolute path today.
    /// By id, the episode's file; by path, only a name this store writes
    /// (`DownloadPolicy.isStoreFileName`), resolved inside the directory --
    /// the page cannot use it to learn where anything else is.
    func fileSrc(id: String?, path: String?) throws -> [String: Any] {
        let name: String
        if let id = id, !id.isEmpty {
            name = queue.sync {
                loadIfNeeded()
                return index.items[id]?.file ?? DownloadPolicy.fileName(forEpisodeId: id)
            }
        } else if let path = path, DownloadPolicy.isStoreFileName((path as NSString).lastPathComponent) {
            name = (path as NSString).lastPathComponent
        } else {
            throw CallError.notFound
        }
        let url = fileURL(name)
        return ["path": url.path, "exists": FileManager.default.fileExists(atPath: url.path)]
    }

    // MARK: the probe

    /// Runs on `queue`. A transport failure (offline, or cellular when the
    /// listener allows Wi-Fi only) does not fail the download: the background
    /// transfer is started on the enclosure URL and waits for an allowed
    /// network, which is how "cellular off" stays queued. The redirect cap
    /// is then not enforced for that one transfer, because a background
    /// session follows redirects without asking; that residual is accepted.
    private func startProbe(id: String, url: URL, userAgent: String?, allowCellular: Bool) {
        let probe = Probe(url: url, userAgent: userAgent, allowCellular: allowCellular) { [weak self] outcome in
            guard let self = self else { return }
            self.probeFinished(id: id, outcome: outcome, userAgent: userAgent, allowCellular: allowCellular, original: url)
        }
        probes[id] = probe
        probe.start()
    }

    private func probeFinished(id: String, outcome: Probe.Outcome, userAgent: String?, allowCellular: Bool, original: URL) {
        var target: URL?
        var failure: (reason: String, status: Int?)?
        // Where the refused probe got to, for the attempt row only:
        // `downloadFailed` keeps the status it always carried.
        var reached: (url: URL?, status: Int?) = (nil, nil)
        queue.sync {
            guard probes.removeValue(forKey: id) != nil, index.items[id]?.status == "queued" else { return }
            switch outcome {
            case .landed(let url, let status):
                switch DownloadPolicy.probeVerdict(status: status) {
                case .proceed: target = url
                case .refuse(let reason):
                    failure = (reason, status)
                    reached = (url, status)
                }
            case .refused(let reason, let last, let status):
                failure = (reason, nil)
                reached = (last, status)
            case .unreachable:
                target = original
            }
            if let f = failure {
                index.items[id]?.status = f.reason == DownloadPolicy.reasonUnplayableHere ? "unplayable-here" : "failed"
                index.items[id]?.reason = f.reason
                save()
            }
        }
        if let f = failure {
            emit?(DownloadPolicy.eventFailed, DownloadPolicy.failedPayload(id: id, reason: f.reason, status: f.status))
            emitAttempt(requested: original, landed: reached.url, status: reached.status, expected: -1, received: 0,
                        outcome: DownloadPolicy.outcome(forReason: f.reason))
            return
        }
        guard let url = target else { return }
        let request = DownloadPolicy.downloadRequest(url: url, userAgent: userAgent, allowCellular: allowCellular)
        let task = session.downloadTask(with: request)
        task.taskDescription = id
        task.resume()
    }

    private func cancelTasks(_ matches: @escaping (String) -> Bool) {
        let done = DispatchSemaphore(value: 0)
        session.getAllTasks { tasks in
            for task in tasks where matches(task.taskDescription ?? "") { task.cancel() }
            done.signal()
        }
        _ = done.wait(timeout: .now() + 5)
    }

    private func finishedRecord(_ id: String) -> DownloadRecord? {
        queue.sync { loadIfNeeded(); return index.items[id] }
    }
}

// MARK: the background session

extension DownloadStore: URLSessionDownloadDelegate {
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard let id = downloadTask.taskDescription, !id.isEmpty else { return }
        let now = Date().timeIntervalSince1970
        let emitNow: Bool = queue.sync {
            loadIfNeeded()
            guard index.items[id] != nil else { return false }
            if index.items[id]?.status == "queued" {
                index.items[id]?.status = "downloading"
                save()
            }
            index.items[id]?.bytes = totalBytesWritten
            index.items[id]?.total = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : nil
            guard DownloadPolicy.shouldEmitProgress(lastEmittedAt: lastProgressAt[id], now: now,
                                                    written: totalBytesWritten, expected: totalBytesExpectedToWrite) else {
                return false
            }
            lastProgressAt[id] = now
            return true
        }
        if emitNow {
            emit?(DownloadPolicy.eventProgress,
                  DownloadPolicy.progressPayload(id: id, written: totalBytesWritten, expected: totalBytesExpectedToWrite))
        }
    }

    /// The file at `location` is deleted when this returns, so it is judged
    /// and moved here, synchronously.
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let id = downloadTask.taskDescription, !id.isEmpty, let record = finishedRecord(id) else {
            try? FileManager.default.removeItem(at: location)
            return
        }
        let httpStatus = (downloadTask.response as? HTTPURLResponse)?.statusCode
        let status = httpStatus ?? 0
        // The attempt row (#29): asked of the row's original URL, answered by
        // wherever the background session's redirects ended.
        let attempt = { (outcome: String) in
            self.emitAttempt(requested: URL(string: record.url),
                             landed: downloadTask.response?.url ?? downloadTask.currentRequest?.url,
                             status: httpStatus, expected: downloadTask.countOfBytesExpectedToReceive,
                             received: downloadTask.countOfBytesReceived, outcome: outcome)
        }
        if case .refuse(let reason) = DownloadPolicy.completionVerdict(status: status) {
            try? FileManager.default.removeItem(at: location)
            fail(id: id, reason: reason, status: status)
            attempt(DownloadPolicy.outcome(forReason: reason))
            return
        }
        let dest = fileURL(record.file)
        do {
            try prepareDirectory()
            if FileManager.default.fileExists(atPath: dest.path) { try FileManager.default.removeItem(at: dest) }
            try FileManager.default.moveItem(at: location, to: dest)
            try? excludeFromBackup(dest)
        } catch {
            fail(id: id, reason: DownloadPolicy.reasonNotSaved, status: nil)
            attempt(DownloadPolicy.outcomeNotSaved)
            return
        }
        // Bytes come from the task's own count: no file attribute is read.
        let bytes = downloadTask.countOfBytesReceived
        let stillWanted: Bool = queue.sync {
            guard index.items[id] != nil else { return false }
            index.items[id]?.status = "done"
            index.items[id]?.bytes = bytes
            index.items[id]?.total = bytes
            index.items[id]?.reason = nil
            lastProgressAt.removeValue(forKey: id)
            save()
            return true
        }
        guard stillWanted else {
            // Removed while the last bytes arrived: keep nothing.
            try? FileManager.default.removeItem(at: dest)
            return
        }
        emit?(DownloadPolicy.eventDone, DownloadPolicy.donePayload(id: id, path: dest.path, bytes: bytes))
        attempt(DownloadPolicy.outcomeDone)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error = error, let id = task.taskDescription, !id.isEmpty else { return }
        let cancelled = (error as? URLError)?.code == .cancelled
        // The attempt row (#29), for a row that still exists: a removed
        // download (its row went first) is described by nobody.
        let requested: URL? = queue.sync { loadIfNeeded(); return index.items[id].flatMap { URL(string: $0.url) } }
        if let requested = requested {
            emitAttempt(requested: requested, landed: task.response?.url ?? task.currentRequest?.url,
                        status: (task.response as? HTTPURLResponse)?.statusCode,
                        expected: task.countOfBytesExpectedToReceive, received: task.countOfBytesReceived,
                        outcome: cancelled ? DownloadPolicy.outcomeCancelled : DownloadPolicy.outcomeNetwork)
        }
        // A cancel or remove already settled the row and said so.
        if cancelled { return }
        let code = (error as NSError).code
        fail(id: id, reason: "network \(code)", status: nil)
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let handler: (() -> Void)? = queue.sync {
            let h = backgroundCompletion
            backgroundCompletion = nil
            return h
        }
        if let handler = handler { DispatchQueue.main.async(execute: handler) }
    }

    /// One `downloadAttempt` (#29, 29-part): hosts only, built by
    /// `DownloadPolicy.attemptPayload`, stamped with this clock in epoch ms.
    private func emitAttempt(requested: URL?, landed: URL?, status: Int?, expected: Int64, received: Int64,
                             outcome: String) {
        emit?(DownloadPolicy.eventAttempt,
              DownloadPolicy.attemptPayload(requested: requested, landed: landed, status: status, expected: expected,
                                            received: received, outcome: outcome,
                                            at: Date().timeIntervalSince1970 * 1000))
    }

    private func fail(id: String, reason: String, status: Int?) {
        let known: Bool = queue.sync {
            guard index.items[id] != nil, index.items[id]?.status != "done" else { return false }
            index.items[id]?.status = reason == DownloadPolicy.reasonUnplayableHere ? "unplayable-here" : "failed"
            index.items[id]?.reason = reason
            lastProgressAt.removeValue(forKey: id)
            save()
            return true
        }
        if known {
            emit?(DownloadPolicy.eventFailed, DownloadPolicy.failedPayload(id: id, reason: reason, status: status))
        }
    }
}

// MARK: the probe

/// One `Range: bytes=0-0` GET in its own ephemeral session: counts redirects
/// against `DownloadPolicy.maxRedirects`, and cancels on the first response,
/// so a host that ignores `Range` sends headers, not the episode.
final class Probe: NSObject, URLSessionDataDelegate {
    enum Outcome {
        /// The chain ended at `url` with HTTP `status`.
        case landed(url: URL, status: Int)
        /// The policy refused the chain (too many redirects, a bad hop);
        /// `last` and `status` are the response that asked for the refused
        /// hop, for the attempt row.
        case refused(reason: String, last: URL?, status: Int?)
        /// No HTTP answer at all: offline, or no allowed network.
        case unreachable
    }

    private let url: URL
    private let userAgent: String?
    private let allowCellular: Bool
    private let completion: (Outcome) -> Void
    private var redirects = 0
    private var outcome: Outcome?
    private var session: URLSession?
    private var finished = false

    init(url: URL, userAgent: String?, allowCellular: Bool, completion: @escaping (Outcome) -> Void) {
        self.url = url
        self.userAgent = userAgent
        self.allowCellular = allowCellular
        self.completion = completion
    }

    func start() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        config.waitsForConnectivity = false
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        let s = URLSession(configuration: config, delegate: self, delegateQueue: queue)
        session = s
        s.dataTask(with: DownloadPolicy.probeRequest(url: url, userAgent: userAgent, allowCellular: allowCellular)).resume()
    }

    func cancel() {
        session?.invalidateAndCancel()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        redirects += 1
        switch DownloadPolicy.redirect(count: redirects, to: request.url) {
        case .follow:
            completionHandler(DownloadPolicy.redirected(request, userAgent: userAgent, allowCellular: allowCellular))
        case .refuse(let reason):
            outcome = .refused(reason: reason, last: response.url ?? task.currentRequest?.url, status: response.statusCode)
            completionHandler(nil)
            task.cancel()
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        if outcome == nil, let http = response as? HTTPURLResponse {
            outcome = .landed(url: http.url ?? dataTask.currentRequest?.url ?? url, status: http.statusCode)
        }
        completionHandler(.cancel)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if finished { return }
        finished = true
        // A refused redirect hands back its 3xx response with no error, and a
        // completed response sets `outcome`; nothing at all is `unreachable`.
        let result = outcome ?? .unreachable
        session.finishTasksAndInvalidate()
        completion(result)
    }
}
