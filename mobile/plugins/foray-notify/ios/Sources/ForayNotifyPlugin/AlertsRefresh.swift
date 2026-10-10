import Foundation
import UserNotifications

/// New-episode alerts for followed shows, the native half (issue #761;
/// docs/roadmap/player-features.md PQ-28, "Exact change" (1)).
///
/// THE RULES ARE THE PAGE'S. `player/show-alerts.js` (PQ-25) is the rule set
/// and `app.js` `checkFollowedShows` (PQ-26) is the page's check; `AlertRules`
/// below mirrors them case for case, over the SAME record in the SAME row, so
/// a check made here and a check made by the page leave one record in one
/// shape. `AlertsRefreshTests.swift` mirrors `player/show-alerts.test.js`'s
/// nine cases; `tools/mobile/foray-notify.test.mjs` pins the literals both
/// sides must agree on (the row key, the API origin, the six-hour interval,
/// the cap of six, the task identifier, the event name).
///
/// THE ROW. The page writes `cp_starred_shows` (a JSON object keyed by
/// `show_id`; app.js `saveStarredShows` is its one page writer) through the
/// Preferences plugin, which keeps it in `UserDefaults.standard` under
/// `CapacitorStorage.cp_starred_shows` (the prefix foray-audio's
/// `CapacitorStoragePrefixTests` pins against the real plugin). The refresh
/// reads that string, checks the due shows, and writes the row back the way
/// the page would: the record GAINS `checked_at`, `latest_published_at`,
/// `seen_published_at`, `unseen_count`, and keeps every other field.
///
/// THE STALE-PAGE GUARD (player/durable-store.js rule 5). On iOS a page is
/// the one writer that can be STALE: loaded an hour ago, or rehydrated from an
/// old mirror. `cp_starred_shows` is not one of the engine's deferred
/// prefixes, so the page CAN write an older copy of a record back over the one
/// this refresh wrote, with `seen_published_at` rolled back. The badge then
/// says the right thing again on the next check (the episode really is unseen
/// by the page), but a refresh that read only the record would post the SAME
/// alert a second time. So the refresh keeps its own ledger — the newest
/// `published_at` it has notified per show — under `ForayNotify.` in
/// `UserDefaults`, OUTSIDE the `CapacitorStorage.` prefix the page writes, and
/// posts only past it. The ledger names only shows that are still followed:
/// every refresh, and every plugin load, drops the rest (an unfollowed show,
/// or "Delete my data" emptying the row, leaves nothing behind after the next
/// one). Fixing the page side (deferring the row) is PQ-30's, with app.js.
///
/// WHAT IS NOT CHECKED HERE. A `pi:` show: the endpoint finds it only by the
/// shard key the page reads from the show record in memory
/// (`shardKeyForShow`), which the stored follow record does not carry, so a
/// native request would be a 404 by construction. The page still checks it.
public enum AlertRules {
    /// `CHECK_INTERVAL_MS` in player/show-alerts.js, in seconds.
    public static let checkIntervalSec: TimeInterval = 6 * 3600
    /// `FOLLOWED_CHECK_CAP` in app.js: at most this many shows per check.
    public static let maxShowsPerRun = 6
    /// The request's deadline: a background refresh has ~30 s in all.
    public static let fetchTimeoutSec: TimeInterval = 10
    /// app.js `API_ORIGIN`; the refresh asks the same endpoint the show page does.
    public static let apiOrigin = "https://foray-web-seven.vercel.app"

    /// The page's row and where the Preferences plugin keeps it.
    public static let starredShowsKey = "cp_starred_shows"
    public static let preferencesKeyPrefix = "CapacitorStorage."
    public static var starredShowsDefaultsKey: String { preferencesKeyPrefix + starredShowsKey }

    /// The stale-page guard's ledger: `[show_id: newest published_at notified]`.
    /// NOT under `preferencesKeyPrefix`: the page must never be able to write it.
    public static let ledgerDefaultsKey = "ForayNotify.lastNotifiedPublishedAt"

    /// The `BGAppRefreshTaskRequest` identifier. PQ-30's plist key
    /// (`BGTaskSchedulerPermittedIdentifiers`) must carry exactly this.
    public static let taskIdentifier = "ai.jwlabs.foura.alerts"

    /// The event a tapped alert fires; `ALERT_EVENT` in player/alert-open.js.
    public static let eventAlertOpened = "alertOpened"
    /// The userInfo marker that says a notification is one of ours.
    public static let userInfoMarker = "foray"
    public static let userInfoMarkerValue = "alert"

    // MARK: the record rules (player/show-alerts.js)

    /// A non-empty string, or nil (`NSNull`, a number and "" are all absent).
    static func text(_ value: Any?) -> String? {
        guard let s = value as? String, !s.isEmpty else { return nil }
        return s
    }

    /// A stamp, or JSON `null` where the page's record would hold null.
    static func orNull(_ s: String?) -> Any {
        if let s = s { return s }
        return NSNull()
    }

    /// `a` is later than `b` as an ISO-8601 string compare (the API writes UTC
    /// ISO strings, so lexical order is time order), the page's `>`.
    static func isLater(_ a: String, than b: String) -> Bool {
        b.utf8.lexicographicallyPrecedes(a.utf8)
    }

    /// `record.alerts === false`: only a real boolean false turns alerts off
    /// (JSONSerialization gives a JSON `0` as an NSNumber that `as? Bool` would
    /// also read as false, so the CF type is checked).
    static func isStrictFalse(_ value: Any?) -> Bool {
        guard let n = value as? NSNumber else { return false }
        return CFGetTypeID(n) == CFBooleanGetTypeID() && !n.boolValue
    }

    /// Alerts are on unless the listener turned them off for this show.
    public static func alertsOn(_ record: Any?) -> Bool {
        guard let r = record as? [String: Any] else { return true }
        return !isStrictFalse(r["alerts"])
    }

    /// `checked_at` as the page writes it (`toISOString`), with or without
    /// the milliseconds.
    static func parseISO(_ s: String) -> Date? {
        let withMs = ISO8601DateFormatter()
        withMs.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withMs.date(from: s) { return d }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: s)
    }

    /// `Date.prototype.toISOString`'s shape: UTC, milliseconds, `Z`.
    public static func isoString(_ date: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: date)
    }

    /// True when the show has never been checked, its stamp cannot be read, or
    /// the interval has elapsed (`>=`: a check at exactly six hours runs).
    public static func dueForCheck(_ record: Any?, now: Date) -> Bool {
        guard let r = record as? [String: Any], let stamp = text(r["checked_at"]) else { return true }
        guard let then = parseISO(stamp) else { return true }
        return now.timeIntervalSince(then) >= checkIntervalSec
    }

    /// Rows with a usable `published_at`, in the order given.
    static func datedRows(_ rows: Any?) -> [[String: Any]] {
        ((rows as? [Any]) ?? []).compactMap { $0 as? [String: Any] }.filter { text($0["published_at"]) != nil }
    }

    /// The later of two stamps (either may be absent).
    static func laterOf(_ a: String?, _ b: String?) -> String? {
        guard let a = a else { return b }
        guard let b = b else { return a }
        return isLater(b, than: a) ? b : a
    }

    /// The newest `published_at` among the rows, or nil when none carries one.
    static func latestOf(_ rows: Any?) -> String? {
        datedRows(rows).reduce(nil as String?) { laterOf($0, text($1["published_at"])) }
    }

    /// Rows published after the record's watermark. No watermark: nothing is new.
    public static func newSince(_ rows: Any?, _ record: Any?) -> [[String: Any]] {
        guard let r = record as? [String: Any], let seen = text(r["seen_published_at"]) else { return [] }
        return datedRows(rows).filter { isLater(text($0["published_at"]) ?? "", than: seen) }
    }

    /// The record after a feed check: stamped, the latest noted (never
    /// backwards), the new counted, and the watermark seeded on a first check.
    public static func afterCheck(_ record: Any?, rows: Any?, now: Date) -> [String: Any] {
        let base = (record as? [String: Any]) ?? [:]
        let latest = laterOf(latestOf(rows), text(base["latest_published_at"]))
        let seen = text(base["seen_published_at"])
        var out = base
        out["checked_at"] = isoString(now)
        out["latest_published_at"] = orNull(latest)
        out["unseen_count"] = seen == nil ? 0 : newSince(rows, base).count
        out["seen_published_at"] = orNull(seen ?? latest)
        return out
    }

    /// The listener has seen the show: the watermark catches up, the count clears.
    public static func markSeen(_ record: Any?) -> [String: Any] {
        var out = (record as? [String: Any]) ?? [:]
        out["unseen_count"] = 0
        out["seen_published_at"] = orNull(laterOf(text(out["latest_published_at"]), text(out["seen_published_at"])))
        return out
    }

    /// The notification's two lines: the show over the newest episode.
    public static func alertText(_ record: Any?, newest: Any?) -> (title: String, body: String) {
        let title = (record as? [String: Any]).flatMap { $0["title"] as? String } ?? ""
        let body = (newest as? [String: Any]).flatMap { $0["title"] as? String } ?? ""
        return (title, body)
    }

    /// The newest of the rows past the watermark, or nil when none is new.
    public static func newestNew(_ rows: Any?, _ record: Any?) -> [String: Any]? {
        newSince(rows, record).reduce(nil as [String: Any]?) { best, row in
            guard let b = best, let bp = text(b["published_at"]) else { return row }
            return isLater(text(row["published_at"]) ?? "", than: bp) ? row : b
        }
    }

    // MARK: the native-only rules

    /// The stale-page guard: post only for an episode newer than the newest
    /// this device has already been told about for the show.
    public static func shouldNotify(newest: String, lastNotified: String?) -> Bool {
        guard let last = lastNotified, !last.isEmpty else { return true }
        return isLater(newest, than: last)
    }

    /// The shows one refresh checks, as app.js `checkFollowedShows` picks them:
    /// a record with a `show_id`, alerts on, due; never a `pi:` show (no shard
    /// key here, see the header); oldest `checked_at` first; at most six.
    public static func plan(_ shows: [String: Any], now: Date) -> [String] {
        let due: [(id: String, at: String)] = shows.values.compactMap { value in
            guard let r = value as? [String: Any], let id = text(r["show_id"]) else { return nil }
            guard alertsOn(r), dueForCheck(r, now: now), !id.hasPrefix("pi:") else { return nil }
            return (id: id, at: (r["checked_at"] as? String) ?? "")
        }
        let ordered = due.sorted { a, b in
            a.at == b.at ? a.id.utf8.lexicographicallyPrecedes(b.id.utf8) : a.at.utf8.lexicographicallyPrecedes(b.at.utf8)
        }
        return ordered.prefix(maxShowsPerRun).map { $0.id }
    }

    /// `encodeURIComponent`'s unreserved set, so the path is the one the page asks for.
    static let uriComponentAllowed = CharacterSet(charactersIn:
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")

    /// `<API_ORIGIN>/api/shows/<id>/episodes`, the request the show page makes for page 1.
    public static func episodesURL(showId: String) -> URL? {
        guard let id = showId.addingPercentEncoding(withAllowedCharacters: uriComponentAllowed) else { return nil }
        return URL(string: "\(apiOrigin)/api/shows/\(id)/episodes")
    }

    /// The rows of an answer, or nil when it is a failure by the page's rule:
    /// no `episodes` array, or the endpoint's degraded 200 (`error` with no rows).
    public static func rows(fromBody body: Any?) -> [Any]? {
        guard let b = body as? [String: Any], let rows = b["episodes"] as? [Any] else { return nil }
        if rows.isEmpty, let err = b["error"], !(err is NSNull) { return nil }
        return rows
    }

    /// The show a tapped notification names, or nil when it is not one of ours.
    public static func showId(fromUserInfo info: [AnyHashable: Any]) -> String? {
        guard (info[userInfoMarker] as? String) == userInfoMarkerValue else { return nil }
        return text(info["showId"])
    }

    /// One alert per show: a later one for the same show replaces it.
    public static func requestIdentifier(showId: String) -> String { "foray-alert-" + showId }
}

/// Posts one alert. Shared by the plugin's `notifyNow` and the refresh, so
/// there is one shape of notification.
public enum AlertPoster {
    /// The content: the show over the newest episode, threaded by show, and
    /// carrying the `showId` a tap routes to.
    public static func content(title: String, body: String, showId: String) -> UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.threadIdentifier = showId
        content.userInfo = [AlertRules.userInfoMarker: AlertRules.userInfoMarkerValue, "showId": showId]
        return content
    }

    /// Hand it to the system now (no trigger). Posting asks for nothing: a
    /// device that has not granted permission drops it, silently.
    public static func post(title: String, body: String, showId: String, completion: ((Error?) -> Void)? = nil) {
        let request = UNNotificationRequest(identifier: AlertRules.requestIdentifier(showId: showId),
                                            content: content(title: title, body: body, showId: showId),
                                            trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in completion?(error) }
    }
}

/// One background check: read the row, check the due shows, write the row
/// back, post one alert per show with something new past the ledger.
/// The network, the poster and the clock are injected, so
/// `AlertsRefreshTests` runs the whole pass against a `UserDefaults` suite.
public final class AlertsRefresh {
    public typealias Fetch = (_ showId: String, _ done: @escaping (_ rows: [Any]?) -> Void) -> Void
    public typealias Post = (_ title: String, _ body: String, _ showId: String) -> Void

    private let defaults: UserDefaults
    private let fetch: Fetch
    private let post: Post
    private let now: () -> Date
    private let queue = DispatchQueue(label: "ai.jwlabs.foura.alerts.refresh")

    public init(defaults: UserDefaults = .standard,
                fetch: @escaping Fetch = AlertsRefresh.fetchEpisodes,
                post: @escaping Post = { AlertPoster.post(title: $0, body: $1, showId: $2) },
                now: @escaping () -> Date = Date.init) {
        self.defaults = defaults
        self.fetch = fetch
        self.post = post
        self.now = now
    }

    /// Run one pass; `completion` gets the shows an alert was posted for.
    public func run(completion: @escaping (_ posted: [String]) -> Void) {
        queue.async {
            let shows = AlertsRefresh.readShows(self.defaults) ?? [:]
            let ids = AlertRules.plan(shows, now: self.now())
            if ids.isEmpty {
                AlertsRefresh.pruneLedger(self.defaults, keeping: shows)
                completion([])
                return
            }
            var answers: [String: [Any]] = [:]
            let group = DispatchGroup()
            for id in ids {
                group.enter()
                self.fetch(id) { rows in
                    self.queue.async {
                        if let rows = rows { answers[id] = rows }
                        group.leave()
                    }
                }
            }
            group.notify(queue: self.queue) {
                completion(self.apply(answers))
            }
        }
    }

    /// Write the checked records and post. Re-reads the row first: a show
    /// unfollowed while the requests were out is not brought back (app.js
    /// `updateFollowedShow`'s rule), and a record whose alerts were turned off
    /// meanwhile is written but not announced.
    private func apply(_ answers: [String: [Any]]) -> [String] {
        var shows = AlertsRefresh.readShows(defaults) ?? [:]
        var ledger = AlertsRefresh.readLedger(defaults)
        var posted: [String] = []
        let at = now()
        for (id, rows) in answers.sorted(by: { $0.key < $1.key }) {
            guard let current = shows[id] as? [String: Any] else { continue }
            let next = AlertRules.afterCheck(current, rows: rows, now: at)
            shows[id] = next
            guard AlertRules.alertsOn(next), let newest = AlertRules.newestNew(rows, current),
                  let stamp = AlertRules.text(newest["published_at"]),
                  AlertRules.shouldNotify(newest: stamp, lastNotified: ledger[id]) else { continue }
            let line = AlertRules.alertText(next, newest: newest)
            post(line.title, line.body, id)
            ledger[id] = stamp
            posted.append(id)
        }
        AlertsRefresh.writeShows(shows, defaults)
        AlertsRefresh.writeLedger(ledger, defaults, keeping: shows)
        return posted
    }

    // MARK: the row and the ledger

    /// The page's row, parsed; nil when absent or not a JSON object.
    public static func readShows(_ defaults: UserDefaults) -> [String: Any]? {
        guard let raw = defaults.string(forKey: AlertRules.starredShowsDefaultsKey),
              let obj = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) else { return nil }
        return obj as? [String: Any]
    }

    /// The row as the page writes it: a JSON string.
    static func writeShows(_ shows: [String: Any], _ defaults: UserDefaults) {
        guard JSONSerialization.isValidJSONObject(shows),
              let data = try? JSONSerialization.data(withJSONObject: shows, options: [.withoutEscapingSlashes]),
              let raw = String(data: data, encoding: .utf8) else { return }
        defaults.set(raw, forKey: AlertRules.starredShowsDefaultsKey)
    }

    public static func readLedger(_ defaults: UserDefaults) -> [String: String] {
        (defaults.dictionary(forKey: AlertRules.ledgerDefaultsKey) as? [String: String]) ?? [:]
    }

    /// The ledger, holding only shows that are still followed; removed when empty.
    static func writeLedger(_ ledger: [String: String], _ defaults: UserDefaults, keeping shows: [String: Any]) {
        let kept = ledger.filter { shows[$0.key] is [String: Any] }
        if kept.isEmpty {
            defaults.removeObject(forKey: AlertRules.ledgerDefaultsKey)
        } else {
            defaults.set(kept, forKey: AlertRules.ledgerDefaultsKey)
        }
    }

    /// Drop the ledger entries of shows no longer followed.
    public static func pruneLedger(_ defaults: UserDefaults, keeping shows: [String: Any]? = nil) {
        writeLedger(readLedger(defaults), defaults, keeping: shows ?? readShows(defaults) ?? [:])
    }

    // MARK: the network

    /// GET page 1 of the show's episodes, 10 s, no cache; nil on any failure.
    public static func fetchEpisodes(_ showId: String, _ done: @escaping (_ rows: [Any]?) -> Void) {
        guard let url = AlertRules.episodesURL(showId: showId) else { done(nil); return }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData,
                                 timeoutInterval: AlertRules.fetchTimeoutSec)
        request.httpMethod = "GET"
        URLSession.shared.dataTask(with: request) { data, response, error in
            guard error == nil, (response as? HTTPURLResponse)?.statusCode == 200, let data = data,
                  let body = try? JSONSerialization.jsonObject(with: data) else { done(nil); return }
            done(AlertRules.rows(fromBody: body))
        }.resume()
    }
}
