package ai.jwlabs.foura.notify;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

/**
 * New-episode alerts for followed shows, the rules (issue #761;
 * docs/roadmap/player-features.md PQ-29). The Android twin of
 * {@code ios/Sources/ForayNotifyPlugin/AlertsRefresh.swift}'s {@code AlertRules}.
 *
 * <p><b>THE RULES ARE THE PAGE'S.</b> {@code player/show-alerts.js} (PQ-25) is the
 * rule set and {@code app.js} {@code checkFollowedShows} (PQ-26) is the page's
 * check; this class mirrors them case for case, over the SAME record in the SAME
 * row, so a check made here and a check made by the page leave one record in one
 * shape. {@code AlertRulesTest} mirrors {@code player/show-alerts.test.js}'s nine
 * cases; {@code tools/mobile/foray-notify.test.mjs} pins the literals all three
 * sides (page, iOS, Android) must agree on.
 *
 * <p><b>THE ROW.</b> The page writes {@code cp_starred_shows} (a JSON object keyed
 * by {@code show_id}) through {@code @capacitor/preferences}, which on Android
 * keeps it in the {@code SharedPreferences} file named after its group,
 * {@code "CapacitorStorage"}, under the bare key (verified in
 * {@code @capacitor/preferences} 8.0.1: {@code PreferencesConfiguration.DEFAULTS.group
 * = "CapacitorStorage"}, {@code context.getSharedPreferences(configuration.group,
 * MODE_PRIVATE)}; {@code player/durable-store.js} never calls {@code configure}, so
 * the default group is the one in use). iOS's {@code "CapacitorStorage." + key} is
 * the same group spelled as a {@code UserDefaults} key prefix.
 *
 * <p><b>THE STALE-PAGE GUARD.</b> The ledger of the newest {@code published_at}
 * already notified per show lives in its OWN {@code SharedPreferences} file,
 * {@link #LEDGER_FILE}, never in the {@code CapacitorStorage} file the page writes
 * through, so a page that writes an older copy of a record back cannot make the
 * refresh announce the same episode twice. See {@link AlertsRefresh}.
 *
 * <p>Pure: no Context, no I/O. {@code org.json} only.
 */
public final class AlertRules {
    private AlertRules() {}

    /** {@code CHECK_INTERVAL_MS} in player/show-alerts.js. */
    public static final long CHECK_INTERVAL_MS = 6L * 3600 * 1000;
    /** {@code FOLLOWED_CHECK_CAP} in app.js: at most this many shows per check. */
    public static final int MAX_SHOWS_PER_RUN = 6;
    /** The request's deadline, connect and read each (iOS: {@code fetchTimeoutSec = 10}). */
    public static final int FETCH_TIMEOUT_MS = 10_000;
    /** app.js {@code API_ORIGIN}; the refresh asks the same endpoint the show page does. */
    public static final String API_ORIGIN = "https://foray-web-seven.vercel.app";

    /** The page's row, and the SharedPreferences file {@code @capacitor/preferences} keeps it in. */
    public static final String STARRED_SHOWS_KEY = "cp_starred_shows";
    public static final String PREFERENCES_FILE = "CapacitorStorage";

    /** The stale-page guard's ledger: {@code {show_id: newest published_at notified}}
     *  as one JSON string, in a file of its own. NOT {@link #PREFERENCES_FILE}: the
     *  page must never be able to write it. */
    public static final String LEDGER_FILE = "ForayNotify";
    public static final String LEDGER_KEY = "lastNotifiedPublishedAt";

    /** The WorkManager unique-work name: the same string as iOS's
     *  {@code BGAppRefreshTaskRequest} identifier, so one name means "the alerts
     *  refresh" on both platforms. */
    public static final String WORK_NAME = "ai.jwlabs.foura.alerts";

    /** The notification channel every alert posts on. */
    public static final String CHANNEL_ID = "foray_alerts";
    public static final String CHANNEL_NAME = "New episodes";

    /** The event a tapped alert fires; {@code ALERT_EVENT} in player/alert-open.js. */
    public static final String EVENT_ALERT_OPENED = "alertOpened";
    /** The intent extras that say a launch is a tap on one of OUR alerts, and which show. */
    public static final String EXTRA_MARKER = "foray";
    public static final String EXTRA_MARKER_VALUE = "alert";
    public static final String EXTRA_SHOW_ID = "showId";

    // ── the record rules (player/show-alerts.js) ──────────────────────────────

    /** A non-empty string, or null ({@code JSONObject.NULL}, a number and "" are all absent). */
    static String text(Object value) {
        if (!(value instanceof String)) return null;
        String s = (String) value;
        return s.isEmpty() ? null : s;
    }

    /** A stamp, or JSON {@code null} where the page's record would hold null. */
    static Object orNull(String s) {
        return s == null ? JSONObject.NULL : s;
    }

    /** {@code a} is later than {@code b} as an ISO-8601 string compare (the API
     *  writes UTC ISO strings, so lexical order is time order), the page's {@code >}. */
    static boolean isLater(String a, String b) {
        return a.compareTo(b) > 0;
    }

    /** Alerts are on unless the listener turned them off: only a real boolean
     *  {@code false} does ({@code record.alerts === false}); a JSON 0 or "false" does not. */
    public static boolean alertsOn(Object record) {
        if (!(record instanceof JSONObject)) return true;
        return !Boolean.FALSE.equals(((JSONObject) record).opt("alerts"));
    }

    private static SimpleDateFormat utc(String pattern) {
        SimpleDateFormat f = new SimpleDateFormat(pattern, Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        f.setLenient(false);
        return f;
    }

    /** {@code checked_at} as the page writes it ({@code toISOString}), with or
     *  without milliseconds; null when it cannot be read. */
    static Long parseIso(String s) {
        for (String pattern : new String[] { "yyyy-MM-dd'T'HH:mm:ss.SSSXXX", "yyyy-MM-dd'T'HH:mm:ssXXX" }) {
            try {
                Date d = utc(pattern).parse(s);
                if (d != null) return d.getTime();
            } catch (ParseException | IllegalArgumentException e) {
                // try the next shape
            }
        }
        return null;
    }

    /** {@code Date.prototype.toISOString}'s shape: UTC, milliseconds, {@code Z}. */
    public static String isoString(long epochMs) {
        return utc("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").format(new Date(epochMs));
    }

    /** True when the show has never been checked, its stamp cannot be read, or the
     *  interval has elapsed ({@code >=}: a check at exactly six hours runs). */
    public static boolean dueForCheck(Object record, long now) {
        if (!(record instanceof JSONObject)) return true;
        String stamp = text(((JSONObject) record).opt("checked_at"));
        if (stamp == null) return true;
        Long then = parseIso(stamp);
        if (then == null) return true;
        return now - then >= CHECK_INTERVAL_MS;
    }

    /** Rows with a usable {@code published_at}, in the order given. */
    static List<JSONObject> datedRows(Object rows) {
        List<JSONObject> out = new ArrayList<>();
        if (!(rows instanceof JSONArray)) return out;
        JSONArray a = (JSONArray) rows;
        for (int i = 0; i < a.length(); i++) {
            Object r = a.opt(i);
            if (r instanceof JSONObject && text(((JSONObject) r).opt("published_at")) != null) {
                out.add((JSONObject) r);
            }
        }
        return out;
    }

    /** The later of two stamps (either may be absent). */
    static String laterOf(String a, String b) {
        if (a == null) return b;
        if (b == null) return a;
        return isLater(b, a) ? b : a;
    }

    /** The newest {@code published_at} among the rows, or null when none carries one. */
    static String latestOf(Object rows) {
        String latest = null;
        for (JSONObject r : datedRows(rows)) latest = laterOf(latest, text(r.opt("published_at")));
        return latest;
    }

    /** Rows published after the record's watermark. No watermark: nothing is new. */
    public static List<JSONObject> newSince(Object rows, Object record) {
        List<JSONObject> out = new ArrayList<>();
        if (!(record instanceof JSONObject)) return out;
        String seen = text(((JSONObject) record).opt("seen_published_at"));
        if (seen == null) return out;
        for (JSONObject r : datedRows(rows)) {
            if (isLater(text(r.opt("published_at")), seen)) out.add(r);
        }
        return out;
    }

    /** A shallow copy, so the caller's record is never changed in place. */
    static JSONObject copy(Object record) {
        JSONObject out = new JSONObject();
        if (!(record instanceof JSONObject)) return out;
        JSONObject r = (JSONObject) record;
        Iterator<String> keys = r.keys();
        while (keys.hasNext()) {
            String k = keys.next();
            try {
                out.put(k, r.opt(k));
            } catch (Exception e) {
                // a key org.json would refuse cannot have come from org.json
            }
        }
        return out;
    }

    private static void put(JSONObject o, String key, Object value) {
        try {
            o.put(key, value);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** The record after a feed check: stamped, the latest noted (never backwards),
     *  the new counted, and the watermark seeded on a first check. */
    public static JSONObject afterCheck(Object record, Object rows, long now) {
        JSONObject base = record instanceof JSONObject ? (JSONObject) record : new JSONObject();
        String latest = laterOf(latestOf(rows), text(base.opt("latest_published_at")));
        String seen = text(base.opt("seen_published_at"));
        JSONObject out = copy(base);
        put(out, "checked_at", isoString(now));
        put(out, "latest_published_at", orNull(latest));
        put(out, "unseen_count", seen == null ? 0 : newSince(rows, base).size());
        put(out, "seen_published_at", orNull(seen != null ? seen : latest));
        return out;
    }

    /** The listener has seen the show: the watermark catches up, the count clears. */
    public static JSONObject markSeen(Object record) {
        JSONObject out = copy(record);
        put(out, "unseen_count", 0);
        put(out, "seen_published_at",
            orNull(laterOf(text(out.opt("latest_published_at")), text(out.opt("seen_published_at")))));
        return out;
    }

    /** The notification's two lines: the show over the newest episode. */
    public static String[] alertText(Object record, Object newest) {
        Object title = record instanceof JSONObject ? ((JSONObject) record).opt("title") : null;
        Object body = newest instanceof JSONObject ? ((JSONObject) newest).opt("title") : null;
        return new String[] {
            title instanceof String ? (String) title : "",
            body instanceof String ? (String) body : ""
        };
    }

    /** The newest of the rows past the watermark, or null when none is new. */
    public static JSONObject newestNew(Object rows, Object record) {
        JSONObject best = null;
        for (JSONObject r : newSince(rows, record)) {
            if (best == null || isLater(text(r.opt("published_at")), text(best.opt("published_at")))) best = r;
        }
        return best;
    }

    // ── the native-only rules ─────────────────────────────────────────────────

    /** The stale-page guard: post only for an episode newer than the newest this
     *  device has already been told about for the show. */
    public static boolean shouldNotify(String newest, String lastNotified) {
        if (lastNotified == null || lastNotified.isEmpty()) return true;
        return isLater(newest, lastNotified);
    }

    /** The shows one refresh checks, as app.js {@code checkFollowedShows} picks them:
     *  a record with a {@code show_id}, alerts on, due; never a {@code pi:} show (the
     *  endpoint finds one only by the shard key the page holds in memory, which the
     *  stored follow record does not carry, so a native request would 404 by
     *  construction; the page still checks it); oldest {@code checked_at} first,
     *  ties by id; at most six. */
    public static List<String> plan(JSONObject shows, long now) {
        List<String[]> due = new ArrayList<>();
        if (shows != null) {
            Iterator<String> keys = shows.keys();
            while (keys.hasNext()) {
                Object value = shows.opt(keys.next());
                if (!(value instanceof JSONObject)) continue;
                JSONObject r = (JSONObject) value;
                String id = text(r.opt("show_id"));
                if (id == null || !alertsOn(r) || !dueForCheck(r, now) || id.startsWith("pi:")) continue;
                Object at = r.opt("checked_at");
                due.add(new String[] { id, at instanceof String ? (String) at : "" });
            }
        }
        Collections.sort(due, (a, b) -> a[1].equals(b[1]) ? a[0].compareTo(b[0]) : a[1].compareTo(b[1]));
        List<String> out = new ArrayList<>();
        for (String[] d : due) {
            if (out.size() >= MAX_SHOWS_PER_RUN) break;
            out.add(d[0]);
        }
        return out;
    }

    /** {@code encodeURIComponent}'s unreserved set, so the path is the one the page asks for. */
    static final String URI_COMPONENT_ALLOWED =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()";

    /** {@code encodeURIComponent}: UTF-8, every byte outside the unreserved set as
     *  {@code %XX}. ({@code URLEncoder} is a form encoder: it writes a space as
     *  {@code +} and escapes {@code ~ ! ' ( )}, so it would ask for another path.) */
    static String encodeUriComponent(String s) {
        StringBuilder out = new StringBuilder();
        for (byte b : s.getBytes(StandardCharsets.UTF_8)) {
            int c = b & 0xff;
            if (c < 0x80 && URI_COMPONENT_ALLOWED.indexOf(c) >= 0) {
                out.append((char) c);
            } else {
                out.append('%').append(Character.toUpperCase(Character.forDigit(c >> 4, 16)))
                    .append(Character.toUpperCase(Character.forDigit(c & 0xf, 16)));
            }
        }
        return out.toString();
    }

    /** {@code <API_ORIGIN>/api/shows/<id>/episodes}, the request the show page makes for page 1. */
    public static String episodesUrl(String showId) {
        return API_ORIGIN + "/api/shows/" + encodeUriComponent(showId) + "/episodes";
    }

    /** The rows of an answer, or null when it is a failure by the page's rule: no
     *  {@code episodes} array, or the endpoint's degraded 200 ({@code error} with no rows). */
    public static JSONArray rowsFromBody(Object body) {
        if (!(body instanceof JSONObject)) return null;
        JSONObject b = (JSONObject) body;
        Object rows = b.opt("episodes");
        if (!(rows instanceof JSONArray)) return null;
        JSONArray a = (JSONArray) rows;
        Object err = b.opt("error");
        if (a.length() == 0 && err != null && err != JSONObject.NULL) return null;
        return a;
    }

    /** The show a tap names, from the launch intent's extras, or null when it is not one of ours. */
    public static String showIdFromExtras(String marker, String showId) {
        if (!EXTRA_MARKER_VALUE.equals(marker)) return null;
        return text(showId);
    }

    /** One alert per show: a later one for the same show replaces it (iOS's request identifier). */
    public static String notificationTag(String showId) {
        return "foray-alert-" + showId;
    }
}
