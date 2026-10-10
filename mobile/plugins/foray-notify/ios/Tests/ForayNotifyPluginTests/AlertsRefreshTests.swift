import XCTest
@testable import ForayNotifyPlugin

/// `AlertRules` and one whole `AlertsRefresh` pass, with no network, no
/// notification center and no phone (issue #761; docs/roadmap/player-features.md
/// PQ-28). The first nine mirror `player/show-alerts.test.js` case for case:
/// the page and this refresh write the SAME record, so a rule that differs
/// between them is a badge and an alert that disagree. Each test names the
/// mutation that turns it red.
///
/// These run in ci.yml's `ios-kit` job, in the `swift test (foray-notify, iOS
/// Simulator)` step; `tools/mobile/foray-notify.test.mjs` pins that the step
/// exists and that these tests are named here.
final class AlertsRefreshTests: XCTestCase {
    private let t1 = "2026-09-30T10:00:00.000Z"
    private let t2 = "2026-10-01T09:00:00.000Z"
    private let t3 = "2026-10-02T08:00:00.000Z"
    private let t0 = AlertRules.parseISO("2026-10-03T00:00:00.000Z")!

    private var suiteName = ""
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "ForayNotifyPluginTests." + UUID().uuidString
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    private func row(_ publishedAt: String?, _ title: String) -> [String: Any] {
        var r: [String: Any] = ["title": title, "audio_url": "https://example.com/\(title).mp3"]
        if let at = publishedAt { r["published_at"] = at }
        return r
    }

    private func record(_ id: String = "s1", _ fields: [String: Any] = [:]) -> [String: Any] {
        var r: [String: Any] = ["show_id": id, "title": "Show One", "artwork_url": "https://example.com/a.jpg",
                                "starred_at": "2026-09-01T00:00:00.000Z"]
        for (k, v) in fields { r[k] = v }
        return r
    }

    private func json(_ text: String) -> Any? {
        try? JSONSerialization.jsonObject(with: Data(text.utf8))
    }

    // MARK: the nine cases of player/show-alerts.test.js

    /// Default on: a record with no `alerts`, as every existing follow is.
    /// MUTATION: `!isStrictFalse(r["alerts"])` -> `isStrictFalse(r["alerts"])`
    /// in `alertsOn`. MUTATION 2: drop the CF boolean check in `isStrictFalse`
    /// -> a JSON `0` reads as "off", which the page's `=== false` never does.
    func testAlertsAreOnByDefault() {
        XCTAssertTrue(AlertRules.alertsOn(record()))
        XCTAssertTrue(AlertRules.alertsOn(nil))
        XCTAssertTrue(AlertRules.alertsOn(json(#"{"alerts":0}"#)))
        XCTAssertTrue(AlertRules.alertsOn(json(#"{"alerts":"false"}"#)))
        XCTAssertFalse(AlertRules.alertsOn(json(#"{"alerts":false}"#)))
    }

    /// The per-show switch: a show whose alerts are off is never checked.
    /// MUTATION: drop `alertsOn(r)` from `plan`'s guard.
    func testAShowWithAlertsOffIsNotChecked() {
        let shows: [String: Any] = ["s1": record("s1", ["alerts": false]), "s2": record("s2", ["alerts": true])]
        XCTAssertEqual(AlertRules.plan(shows, now: t0), ["s2"])
    }

    /// Due when never checked, and at exactly six hours — not before.
    /// MUTATION: `>= checkIntervalSec` -> `> checkIntervalSec` in `dueForCheck`.
    /// MUTATION 2: `guard let then = parseISO(stamp) else { return true }` ->
    /// `return false` (an unreadable stamp would silence the show for good).
    func testDueWhenNeverCheckedAndAtExactlySixHours() {
        let checked = record("s1", ["checked_at": AlertRules.isoString(t0)])
        XCTAssertTrue(AlertRules.dueForCheck(record(), now: t0))
        XCTAssertFalse(AlertRules.dueForCheck(checked, now: t0.addingTimeInterval(AlertRules.checkIntervalSec - 0.001)))
        XCTAssertTrue(AlertRules.dueForCheck(checked, now: t0.addingTimeInterval(AlertRules.checkIntervalSec)))
        XCTAssertTrue(AlertRules.dueForCheck(record("s1", ["checked_at": "not a date"]), now: t0))
        XCTAssertEqual(AlertRules.checkIntervalSec, 6 * 3600)
    }

    /// A fresh follow's first check seeds the watermark and reports 0 new.
    /// MUTATION: `orNull(seen ?? latest)` -> `orNull(seen)` in `afterCheck`.
    func testAFreshFollowSeedsTheWatermarkAndReportsNothingNew() {
        let next = AlertRules.afterCheck(record(), rows: [row(t2, "Ep 2"), row(t1, "Ep 1")], now: t0)
        XCTAssertEqual(next["seen_published_at"] as? String, t2)
        XCTAssertEqual(next["latest_published_at"] as? String, t2)
        XCTAssertEqual(next["unseen_count"] as? Int, 0)
        XCTAssertEqual(next["checked_at"] as? String, "2026-10-03T00:00:00.000Z", "toISOString's shape")
        XCTAssertEqual(next["artwork_url"] as? String, "https://example.com/a.jpg", "the record only gains fields")
    }

    /// A row after the watermark is counted, and becomes the latest.
    /// MUTATION: `isLater(published, than: seen)` -> `isLater(seen, than: published)` in `newSince`.
    func testARowAfterTheWatermarkIsCounted() {
        let rec = record("s1", ["seen_published_at": t1, "latest_published_at": t1])
        let next = AlertRules.afterCheck(rec, rows: [row(t2, "Ep 2"), row(t1, "Ep 1")], now: t0)
        XCTAssertEqual(next["unseen_count"] as? Int, 1)
        XCTAssertEqual(next["latest_published_at"] as? String, t2)
        XCTAssertEqual(next["seen_published_at"] as? String, t1)
    }

    /// A row at exactly the watermark is not new.
    /// MUTATION: `b.utf8.lexicographicallyPrecedes(a.utf8)` -> `!a.utf8.lexicographicallyPrecedes(b.utf8)` (`>=`) in `isLater`.
    func testARowAtExactlyTheWatermarkIsNotNew() {
        let rec = record("s1", ["seen_published_at": t1])
        XCTAssertTrue(AlertRules.newSince([row(t1, "Ep 1")], rec).isEmpty)
        XCTAssertEqual(AlertRules.afterCheck(rec, rows: [row(t1, "Ep 1")], now: t0)["unseen_count"] as? Int, 0)
    }

    /// markSeen zeroes the count and moves the watermark up, never down.
    /// MUTATION: `laterOf(latest, seen)` -> `text(out["seen_published_at"])` in `markSeen`.
    func testMarkSeenZeroesTheCountAndCatchesTheWatermarkUp() {
        let seen = AlertRules.markSeen(record("s1", ["unseen_count": 3, "seen_published_at": t1, "latest_published_at": t2]))
        XCTAssertEqual(seen["unseen_count"] as? Int, 0)
        XCTAssertEqual(seen["seen_published_at"] as? String, t2)
        let ahead = AlertRules.markSeen(record("s1", ["seen_published_at": t2, "latest_published_at": t1]))
        XCTAssertEqual(ahead["seen_published_at"] as? String, t2, "never below what was already seen")
    }

    /// The notification is the show's title over the newest episode's.
    /// MUTATION: swap `title` and `body` in `alertText`.
    func testAlertTextIsTheShowOverTheNewestEpisode() {
        let text = AlertRules.alertText(record(), newest: row(t2, "Ep 2"))
        XCTAssertEqual(text.title, "Show One")
        XCTAssertEqual(text.body, "Ep 2")
        XCTAssertEqual(AlertRules.alertText(nil, newest: nil).title, "")
    }

    /// A row without `published_at` is ignored: never new, never the latest.
    /// MUTATION: drop the `text($0["published_at"]) != nil` filter in `datedRows`.
    func testARowWithoutPublishedAtIsIgnored() {
        let rec = record("s1", ["seen_published_at": t1, "latest_published_at": t1])
        let rows: [Any] = [row(nil, "Undated"), row("", "Blank"), row(t1, "Ep 1"), "not a row"]
        XCTAssertTrue(AlertRules.newSince(rows, rec).isEmpty)
        let next = AlertRules.afterCheck(rec, rows: rows, now: t0)
        XCTAssertEqual(next["unseen_count"] as? Int, 0)
        XCTAssertEqual(next["latest_published_at"] as? String, t1)
    }

    // MARK: the page's other rules

    /// The latest never moves backwards: a page that lost a row does not make
    /// it new again when it returns.
    /// MUTATION: `laterOf(latestOf(rows), base latest)` -> `latestOf(rows) ?? base latest` in `afterCheck`.
    func testTheLatestNeverMovesBackwards() {
        let rec = record("s1", ["seen_published_at": t1, "latest_published_at": t2])
        XCTAssertEqual(AlertRules.afterCheck(rec, rows: [row(t1, "Ep 1")], now: t0)["latest_published_at"] as? String, t2)
    }

    /// app.js `checkFollowedShows`' pick: alerts on, due, a `show_id`, oldest
    /// check first, at most six; and never a `pi:` show (no shard key here).
    /// MUTATION: drop `.prefix(maxShowsPerRun)`. MUTATION 2: drop the `pi:` guard.
    func testThePlanIsOldestCheckFirstAtMostSixAndNeverAPiShow() {
        var shows: [String: Any] = [:]
        for i in 1...8 {
            let at = AlertRules.isoString(t0.addingTimeInterval(-Double(20 + i) * 3600))
            shows["s\(i)"] = record("s\(i)", ["checked_at": at])
        }
        shows["fresh"] = record("fresh")
        shows["pi:42"] = record("pi:42")
        shows["recent"] = record("recent", ["checked_at": AlertRules.isoString(t0.addingTimeInterval(-3600))])
        shows["no-id"] = ["title": "No id"]
        XCTAssertEqual(AlertRules.plan(shows, now: t0), ["fresh", "s8", "s7", "s6", "s5", "s4"])
        XCTAssertEqual(AlertRules.maxShowsPerRun, 6)
    }

    /// The request is the show page's: encodeURIComponent'd id, page 1.
    /// MUTATION: `.urlPathAllowed` for `uriComponentAllowed` -> the `/` stays raw.
    func testTheEpisodesURLEncodesTheIdLikeThePage() {
        XCTAssertEqual(AlertRules.episodesURL(showId: "pod/x y")?.absoluteString,
                       "https://foray-web-seven.vercel.app/api/shows/pod%2Fx%20y/episodes")
        XCTAssertEqual(AlertRules.episodesURL(showId: "lex-fridman")?.absoluteString,
                       "https://foray-web-seven.vercel.app/api/shows/lex-fridman/episodes")
    }

    /// A failed answer by the page's rule: no `episodes`, or the degraded 200.
    /// MUTATION: drop the `rows.isEmpty, let err = b["error"]` refusal in `rows(fromBody:)`.
    func testADegradedAnswerIsAFailure() {
        XCTAssertNil(AlertRules.rows(fromBody: json(#"{"episodes":[],"error":"feed unreadable"}"#)))
        XCTAssertNil(AlertRules.rows(fromBody: json(#"{"error":"unknown show_id"}"#)))
        XCTAssertEqual(AlertRules.rows(fromBody: json(#"{"episodes":[],"error":null}"#))?.count, 0)
        XCTAssertEqual(AlertRules.rows(fromBody: json(#"{"episodes":[{"title":"a"}],"error":"stale"}"#))?.count, 1)
    }

    // MARK: one whole pass

    private func store(_ shows: [String: Any]) {
        AlertsRefresh.writeShows(shows, defaults)
    }

    private func stored(_ id: String) -> [String: Any]? {
        AlertsRefresh.readShows(defaults)?[id] as? [String: Any]
    }

    /// One pass with a fake network (`answers[id]`, nil = a failed request),
    /// a recording poster and a fixed clock. `during` runs inside the fetch,
    /// while the "request" is out.
    @discardableResult
    private func pass(_ answers: [String: [Any]], at now: Date, during: (() -> Void)? = nil) -> [[String]] {
        var posts: [[String]] = []
        let refresh = AlertsRefresh(defaults: defaults,
                                    fetch: { id, done in during?(); done(answers[id]) },
                                    post: { title, body, id in posts.append([title, body, id]) },
                                    now: { now })
        let finished = expectation(description: "refresh pass")
        refresh.run { _ in finished.fulfill() }
        wait(for: [finished], timeout: 5)
        return posts
    }

    /// The row lives where the Preferences plugin keeps it, and the ledger
    /// does NOT: the page must never be able to write the guard.
    /// MUTATION: `ledgerDefaultsKey = "CapacitorStorage.foray_notify_ledger"`.
    func testTheRowIsThePagesAndTheLedgerIsOutsideItsPrefix() {
        XCTAssertEqual(AlertRules.starredShowsDefaultsKey, "CapacitorStorage.cp_starred_shows")
        XCTAssertFalse(AlertRules.ledgerDefaultsKey.hasPrefix(AlertRules.preferencesKeyPrefix))
    }

    /// A first check posts nothing; a later episode posts once, the show over
    /// the episode, and the row is written back in the page's shape.
    /// MUTATION: drop `post(line.title, line.body, id)` in `apply`.
    func testANewEpisodePostsOneAlertAndTheRowIsWrittenBack() {
        store(["s1": record()])
        XCTAssertEqual(pass(["s1": [row(t1, "Ep 1")]], at: t0), [])
        XCTAssertEqual(stored("s1")?["seen_published_at"] as? String, t1)

        let later = t0.addingTimeInterval(AlertRules.checkIntervalSec)
        XCTAssertEqual(pass(["s1": [row(t2, "Ep 2"), row(t1, "Ep 1")]], at: later), [["Show One", "Ep 2", "s1"]])
        XCTAssertEqual(stored("s1")?["unseen_count"] as? Int, 1)
        XCTAssertEqual(stored("s1")?["latest_published_at"] as? String, t2)
        XCTAssertEqual(stored("s1")?["checked_at"] as? String, AlertRules.isoString(later))
        XCTAssertEqual(AlertsRefresh.readLedger(defaults), ["s1": t2])
    }

    /// THE STALE-PAGE GUARD: a record rolled back by the page does not notify
    /// twice. The refresh posts for Ep 2; a stale page then writes its older
    /// copy back (watermark and latest at Ep 1, an old `checked_at`); the next
    /// pass counts Ep 2 as unseen again — the badge is right — but posts
    /// nothing, and a genuinely newer Ep 3 still posts.
    /// MUTATION: `shouldNotify` returns true -> the second pass posts Ep 2 again.
    /// MUTATION 2: `ledger[id] = stamp` removed -> the same.
    func testARecordRolledBackByThePageDoesNotNotifyTwice() {
        let old = AlertRules.isoString(t0.addingTimeInterval(-7 * 3600))
        let pageCopy = record("s1", ["seen_published_at": t1, "latest_published_at": t1, "checked_at": old, "unseen_count": 0])
        store(["s1": pageCopy])
        XCTAssertEqual(pass(["s1": [row(t2, "Ep 2"), row(t1, "Ep 1")]], at: t0), [["Show One", "Ep 2", "s1"]])

        store(["s1": pageCopy]) // the stale page writes its copy back
        XCTAssertEqual(pass(["s1": [row(t2, "Ep 2"), row(t1, "Ep 1")]], at: t0), [], "Ep 2 was already announced")
        XCTAssertEqual(stored("s1")?["unseen_count"] as? Int, 1, "the badge still counts it")

        store(["s1": pageCopy])
        XCTAssertEqual(pass(["s1": [row(t3, "Ep 3"), row(t2, "Ep 2"), row(t1, "Ep 1")]], at: t0),
                       [["Show One", "Ep 3", "s1"]])
        XCTAssertEqual(AlertsRefresh.readLedger(defaults), ["s1": t3])
    }

    /// A failed request leaves the record untouched, so the show stays due.
    /// MUTATION: write `afterCheck(current, rows: [], ...)` for a failed show.
    func testAFailedRequestLeavesTheRecordUntouched() {
        store(["s1": record()])
        XCTAssertEqual(pass([:], at: t0), [])
        XCTAssertNil(stored("s1")?["checked_at"])
        XCTAssertTrue(AlertRules.dueForCheck(stored("s1"), now: t0))
    }

    /// A show unfollowed while its request was out is not brought back, and
    /// its ledger entry goes with it.
    /// MUTATION: `shows[id] = next` without the `guard let current` -> the show reappears.
    func testAnUnfollowDuringTheCheckIsNotUndone() {
        defaults.set(["s1": t1, "gone": t1], forKey: AlertRules.ledgerDefaultsKey)
        store(["s1": record("s1", ["seen_published_at": t1])])
        pass(["s1": [row(t2, "Ep 2")]], at: t0, during: { self.store([:]) })
        XCTAssertNil(stored("s1"))
        XCTAssertNil(defaults.object(forKey: AlertRules.ledgerDefaultsKey), "the ledger names no unfollowed show")
    }

    /// The ledger is pruned to the shows still followed.
    /// MUTATION: `writeLedger` keeps every key.
    func testTheLedgerIsPrunedToFollowedShows() {
        store(["s1": record()])
        defaults.set(["s1": t1, "gone": t2], forKey: AlertRules.ledgerDefaultsKey)
        AlertsRefresh.pruneLedger(defaults)
        XCTAssertEqual(AlertsRefresh.readLedger(defaults), ["s1": t1])
    }

    // MARK: the tap

    /// An alert carries the show it opens; a notification that is not ours
    /// opens nothing.
    /// MUTATION: drop the marker from `AlertPoster.content`'s userInfo.
    func testAnAlertCarriesTheShowItOpens() {
        let content = AlertPoster.content(title: "Show One", body: "Ep 2", showId: "s1")
        XCTAssertEqual(content.threadIdentifier, "s1")
        XCTAssertEqual(AlertRules.showId(fromUserInfo: content.userInfo), "s1")
        XCTAssertNil(AlertRules.showId(fromUserInfo: ["showId": "s1"]))
        XCTAssertNil(AlertRules.showId(fromUserInfo: [AlertRules.userInfoMarker: AlertRules.userInfoMarkerValue, "showId": ""]))
        XCTAssertEqual(AlertRules.requestIdentifier(showId: "s1"), "foray-alert-s1")
    }
}
