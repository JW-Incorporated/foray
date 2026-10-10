package ai.jwlabs.foura.notify;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.Arrays;
import java.util.Collections;

/**
 * {@link AlertRules}, with no network, no notification manager and no phone
 * (issue #761; docs/roadmap/player-features.md PQ-29). The first nine mirror
 * {@code player/show-alerts.test.js} case for case, as iOS's
 * {@code AlertsRefreshTests.swift} does: the page and both refreshes write the SAME
 * record, so a rule that differs between them is a badge and an alert that
 * disagree. Robolectric only for the framework's real {@code org.json}.
 *
 * <p>Each test names the one-line mutation it exists to catch.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class AlertRulesTest {
    static final String T1 = "2026-09-30T10:00:00.000Z";
    static final String T2 = "2026-10-01T09:00:00.000Z";
    static final String T3 = "2026-10-02T08:00:00.000Z";
    static final long T0 = AlertRules.parseIso("2026-10-03T00:00:00.000Z");
    static final long SIX_HOURS = AlertRules.CHECK_INTERVAL_MS;

    static JSONObject row(String publishedAt, String title) throws Exception {
        JSONObject r = new JSONObject();
        r.put("title", title);
        r.put("audio_url", "https://example.com/" + title + ".mp3");
        if (publishedAt != null) r.put("published_at", publishedAt);
        return r;
    }

    static JSONObject record(String id, Object... fields) throws Exception {
        JSONObject r = new JSONObject();
        r.put("show_id", id);
        r.put("title", "Show One");
        r.put("artwork_url", "https://example.com/a.jpg");
        r.put("starred_at", "2026-09-01T00:00:00.000Z");
        for (int i = 0; i + 1 < fields.length; i += 2) r.put((String) fields[i], fields[i + 1]);
        return r;
    }

    static JSONArray rows(Object... items) {
        JSONArray a = new JSONArray();
        for (Object item : items) a.put(item);
        return a;
    }

    // ── the nine cases of player/show-alerts.test.js ─────────────────────────

    /** Default on: a record with no {@code alerts}, as every existing follow is.
     *  MUTATION: {@code !Boolean.FALSE.equals(...)} -> {@code Boolean.FALSE.equals(...)} in {@code alertsOn}.
     *  MUTATION 2: {@code Boolean.FALSE.equals(x)} -> {@code "false".equals(String.valueOf(x))}
     *  (a string "false" reads as off, which the page's {@code === false} never does). */
    @Test
    public void alertsAreOnByDefault() throws Exception {
        assertTrue(AlertRules.alertsOn(record("s1")));
        assertTrue(AlertRules.alertsOn(null));
        assertTrue(AlertRules.alertsOn(new JSONObject("{\"alerts\":0}")));
        assertTrue(AlertRules.alertsOn(new JSONObject("{\"alerts\":\"false\"}")));
        assertFalse(AlertRules.alertsOn(new JSONObject("{\"alerts\":false}")));
    }

    /** The per-show switch: a show whose alerts are off is never checked.
     *  MUTATION: drop {@code !alertsOn(r)} from {@code plan}'s skip. */
    @Test
    public void aShowWithAlertsOffIsNotChecked() throws Exception {
        JSONObject shows = new JSONObject();
        shows.put("s1", record("s1", "alerts", false));
        shows.put("s2", record("s2", "alerts", true));
        assertEquals(Collections.singletonList("s2"), AlertRules.plan(shows, T0));
    }

    /** Due when never checked, and at exactly six hours, not before.
     *  MUTATION: {@code >= CHECK_INTERVAL_MS} -> {@code >} in {@code dueForCheck}.
     *  MUTATION 2: {@code if (then == null) return true} -> {@code return false}
     *  (an unreadable stamp would silence the show for good). */
    @Test
    public void dueWhenNeverCheckedAndAtExactlySixHours() throws Exception {
        JSONObject checked = record("s1", "checked_at", AlertRules.isoString(T0));
        assertTrue(AlertRules.dueForCheck(record("s1"), T0));
        assertFalse(AlertRules.dueForCheck(checked, T0 + SIX_HOURS - 1));
        assertTrue(AlertRules.dueForCheck(checked, T0 + SIX_HOURS));
        assertTrue(AlertRules.dueForCheck(record("s1", "checked_at", "not a date"), T0));
        assertEquals(6L * 3600 * 1000, AlertRules.CHECK_INTERVAL_MS);
    }

    /** A fresh follow's first check seeds the watermark and reports 0 new.
     *  MUTATION: {@code orNull(seen != null ? seen : latest)} -> {@code orNull(seen)} in {@code afterCheck}. */
    @Test
    public void aFreshFollowSeedsTheWatermarkAndReportsNothingNew() throws Exception {
        JSONObject next = AlertRules.afterCheck(record("s1"), rows(row(T2, "Ep 2"), row(T1, "Ep 1")), T0);
        assertEquals(T2, next.get("seen_published_at"));
        assertEquals(T2, next.get("latest_published_at"));
        assertEquals(0, next.getInt("unseen_count"));
        assertEquals("toISOString's shape", "2026-10-03T00:00:00.000Z", next.get("checked_at"));
        assertEquals("the record only gains fields", "https://example.com/a.jpg", next.get("artwork_url"));
    }

    /** A row after the watermark is counted, and becomes the latest.
     *  MUTATION: {@code isLater(published, seen)} -> {@code isLater(seen, published)} in {@code newSince}. */
    @Test
    public void aRowAfterTheWatermarkIsCounted() throws Exception {
        JSONObject rec = record("s1", "seen_published_at", T1, "latest_published_at", T1);
        JSONObject next = AlertRules.afterCheck(rec, rows(row(T2, "Ep 2"), row(T1, "Ep 1")), T0);
        assertEquals(1, next.getInt("unseen_count"));
        assertEquals(T2, next.get("latest_published_at"));
        assertEquals(T1, next.get("seen_published_at"));
    }

    /** A row at exactly the watermark is not new.
     *  MUTATION: {@code a.compareTo(b) > 0} -> {@code >= 0} in {@code isLater}. */
    @Test
    public void aRowAtExactlyTheWatermarkIsNotNew() throws Exception {
        JSONObject rec = record("s1", "seen_published_at", T1);
        assertTrue(AlertRules.newSince(rows(row(T1, "Ep 1")), rec).isEmpty());
        assertEquals(0, AlertRules.afterCheck(rec, rows(row(T1, "Ep 1")), T0).getInt("unseen_count"));
    }

    /** markSeen zeroes the count and moves the watermark up, never down.
     *  MUTATION: {@code laterOf(latest, seen)} -> {@code text(seen)} in {@code markSeen}. */
    @Test
    public void markSeenZeroesTheCountAndCatchesTheWatermarkUp() throws Exception {
        JSONObject seen = AlertRules.markSeen(record("s1", "unseen_count", 3, "seen_published_at", T1, "latest_published_at", T2));
        assertEquals(0, seen.getInt("unseen_count"));
        assertEquals(T2, seen.get("seen_published_at"));
        JSONObject ahead = AlertRules.markSeen(record("s1", "seen_published_at", T2, "latest_published_at", T1));
        assertEquals("never below what was already seen", T2, ahead.get("seen_published_at"));
    }

    /** The notification is the show's title over the newest episode's.
     *  MUTATION: swap the two lines in {@code alertText}. */
    @Test
    public void alertTextIsTheShowOverTheNewestEpisode() throws Exception {
        String[] text = AlertRules.alertText(record("s1"), row(T2, "Ep 2"));
        assertEquals("Show One", text[0]);
        assertEquals("Ep 2", text[1]);
        assertEquals("", AlertRules.alertText(null, null)[0]);
    }

    /** A row without {@code published_at} is ignored: never new, never the latest.
     *  MUTATION: drop the {@code text(published_at) != null} filter in {@code datedRows}. */
    @Test
    public void aRowWithoutPublishedAtIsIgnored() throws Exception {
        JSONObject rec = record("s1", "seen_published_at", T1, "latest_published_at", T1);
        JSONArray rows = rows(row(null, "Undated"), row("", "Blank"), row(T1, "Ep 1"), "not a row");
        assertTrue(AlertRules.newSince(rows, rec).isEmpty());
        JSONObject next = AlertRules.afterCheck(rec, rows, T0);
        assertEquals(0, next.getInt("unseen_count"));
        assertEquals(T1, next.get("latest_published_at"));
    }

    // ── the page's other rules ───────────────────────────────────────────────

    /** The latest never moves backwards: a page that lost a row does not make it new again.
     *  MUTATION: {@code laterOf(latestOf(rows), base latest)} -> {@code latestOf(rows)} in {@code afterCheck}. */
    @Test
    public void theLatestNeverMovesBackwards() throws Exception {
        JSONObject rec = record("s1", "seen_published_at", T1, "latest_published_at", T2);
        assertEquals(T2, AlertRules.afterCheck(rec, rows(row(T1, "Ep 1")), T0).get("latest_published_at"));
    }

    /** app.js {@code checkFollowedShows}' pick: alerts on, due, a {@code show_id}, oldest
     *  check first, at most six; and never a {@code pi:} show (no shard key here).
     *  MUTATION: drop the {@code MAX_SHOWS_PER_RUN} break. MUTATION 2: drop the {@code pi:} skip. */
    @Test
    public void thePlanIsOldestCheckFirstAtMostSixAndNeverAPiShow() throws Exception {
        JSONObject shows = new JSONObject();
        for (int i = 1; i <= 8; i++) {
            shows.put("s" + i, record("s" + i, "checked_at", AlertRules.isoString(T0 - (20L + i) * 3600 * 1000)));
        }
        shows.put("fresh", record("fresh"));
        shows.put("pi:42", record("pi:42"));
        shows.put("recent", record("recent", "checked_at", AlertRules.isoString(T0 - 3600 * 1000)));
        shows.put("no-id", new JSONObject("{\"title\":\"No id\"}"));
        assertEquals(Arrays.asList("fresh", "s8", "s7", "s6", "s5", "s4"), AlertRules.plan(shows, T0));
        assertEquals(6, AlertRules.MAX_SHOWS_PER_RUN);
    }

    /** The request is the show page's: encodeURIComponent'd id, page 1.
     *  MUTATION: {@code encodeUriComponent(showId)} -> {@code URLEncoder.encode(showId, "UTF-8")}
     *  (a space becomes {@code +}). */
    @Test
    public void theEpisodesUrlEncodesTheIdLikeThePage() {
        assertEquals("https://foray-web-seven.vercel.app/api/shows/pod%2Fx%20y/episodes", AlertRules.episodesUrl("pod/x y"));
        assertEquals("https://foray-web-seven.vercel.app/api/shows/lex-fridman/episodes", AlertRules.episodesUrl("lex-fridman"));
        assertEquals("a!~*'()%C3%A9", AlertRules.encodeUriComponent("a!~*'()é"));
    }

    /** A failed answer by the page's rule: no {@code episodes}, or the degraded 200.
     *  MUTATION: drop the empty-with-error refusal in {@code rowsFromBody}. */
    @Test
    public void aDegradedAnswerIsAFailure() throws Exception {
        assertNull(AlertRules.rowsFromBody(new JSONObject("{\"episodes\":[],\"error\":\"feed unreadable\"}")));
        assertNull(AlertRules.rowsFromBody(new JSONObject("{\"error\":\"unknown show_id\"}")));
        assertEquals(0, AlertRules.rowsFromBody(new JSONObject("{\"episodes\":[],\"error\":null}")).length());
        assertEquals(1, AlertRules.rowsFromBody(new JSONObject("{\"episodes\":[{\"title\":\"a\"}],\"error\":\"stale\"}")).length());
    }

    /** A tap names its show only when it carries our marker; one alert per show.
     *  MUTATION: drop the marker check in {@code showIdFromExtras}. */
    @Test
    public void aTapIsOursOnlyWithTheMarker() {
        assertEquals("s1", AlertRules.showIdFromExtras("alert", "s1"));
        assertNull(AlertRules.showIdFromExtras(null, "s1"));
        assertNull(AlertRules.showIdFromExtras("alert", ""));
        assertEquals("foray-alert-s1", AlertRules.notificationTag("s1"));
    }
}
