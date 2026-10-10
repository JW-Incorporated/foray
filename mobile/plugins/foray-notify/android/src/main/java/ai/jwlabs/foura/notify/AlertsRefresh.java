package ai.jwlabs.foura.notify;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * One background check: read the page's row, check the due shows, write the row
 * back, post one alert per show with something new past the ledger. The Android
 * twin of {@code AlertsRefresh.swift} (PQ-28), run by {@link AlertsWorker}.
 *
 * <p><b>THE STALE-PAGE GUARD</b> (player/durable-store.js rule 5). A page is the
 * one writer that can be STALE: loaded an hour ago, or rehydrated from its
 * localStorage copy. {@code cp_starred_shows} is a row the page owns, so the page
 * CAN write an older copy of a record back over the one this refresh wrote, with
 * {@code seen_published_at} rolled back. The badge then says the right thing on
 * the next check (the episode really is unseen by the page), but a refresh that
 * read only the record would post the SAME alert a second time. So this keeps
 * its own ledger, the newest {@code published_at} it has notified per show, in
 * the {@link AlertRules#LEDGER_FILE} SharedPreferences file, OUTSIDE the
 * {@code CapacitorStorage} file the page writes through, and posts only past it.
 * The ledger names only shows still followed: every pass, and every plugin load,
 * drops the rest (an unfollowed show, or "Delete my data" emptying the row, leaves
 * nothing behind after the next one).
 *
 * <p>Synchronous: {@link AlertsWorker#doWork()} already runs on WorkManager's
 * background executor. The network, the poster and the clock are injected, so
 * {@code AlertsRefreshTest} runs whole passes with no network and no phone.
 */
public final class AlertsRefresh {

    /** Page 1 of a show's episodes, or null on any failure. */
    public interface Fetch {
        JSONArray rows(String showId);
    }

    /** Post one alert. */
    public interface Post {
        void post(String title, String body, String showId);
    }

    /** Milliseconds since the epoch. */
    public interface Clock {
        long now();
    }

    private final SharedPreferences page;
    private final SharedPreferences ledgerStore;
    private final Fetch fetch;
    private final Post post;
    private final Clock clock;

    public AlertsRefresh(SharedPreferences page, SharedPreferences ledgerStore, Fetch fetch, Post post, Clock clock) {
        this.page = page;
        this.ledgerStore = ledgerStore;
        this.fetch = fetch;
        this.post = post;
        this.clock = clock;
    }

    /** The page's row file and the ledger file of this app. */
    static SharedPreferences pageStore(Context context) {
        return context.getSharedPreferences(AlertRules.PREFERENCES_FILE, Context.MODE_PRIVATE);
    }

    static SharedPreferences ledgerStore(Context context) {
        return context.getSharedPreferences(AlertRules.LEDGER_FILE, Context.MODE_PRIVATE);
    }

    /** The production wiring: the real files, the real endpoint, the real notification. */
    public static AlertsRefresh forContext(Context context) {
        final Context app = context.getApplicationContext() != null ? context.getApplicationContext() : context;
        return new AlertsRefresh(pageStore(app), ledgerStore(app), AlertsRefresh::fetchEpisodes,
            (title, body, showId) -> AlertPoster.post(app, title, body, showId), System::currentTimeMillis);
    }

    /** Run one pass; answers the shows an alert was posted for. */
    public List<String> run() {
        JSONObject shows = readShows(page);
        List<String> ids = AlertRules.plan(shows, clock.now());
        if (ids.isEmpty()) {
            pruneLedger(page, ledgerStore);
            return new ArrayList<>();
        }
        Map<String, JSONArray> answers = new LinkedHashMap<>();
        for (String id : ids) {
            JSONArray rows = null;
            try {
                rows = fetch.rows(id);
            } catch (RuntimeException e) {
                rows = null;
            }
            if (rows != null) answers.put(id, rows);
        }
        return apply(answers);
    }

    /**
     * Write the checked records and post. Re-reads the row first: a show unfollowed
     * while the requests were out is not brought back (app.js
     * {@code updateFollowedShow}'s rule), and a record whose alerts were turned off
     * meanwhile is written but not announced.
     */
    private List<String> apply(Map<String, JSONArray> answers) {
        JSONObject shows = readShows(page);
        Map<String, String> ledger = readLedger(ledgerStore);
        List<String> posted = new ArrayList<>();
        long at = clock.now();
        List<String> ids = new ArrayList<>(answers.keySet());
        Collections.sort(ids);
        for (String id : ids) {
            JSONArray rows = answers.get(id);
            Object current = shows.opt(id);
            if (!(current instanceof JSONObject)) continue;
            JSONObject next = AlertRules.afterCheck(current, rows, at);
            try {
                shows.put(id, next);
            } catch (Exception e) {
                continue;
            }
            if (!AlertRules.alertsOn(next)) continue;
            JSONObject newest = AlertRules.newestNew(rows, current);
            if (newest == null) continue;
            String stamp = AlertRules.text(newest.opt("published_at"));
            if (stamp == null || !AlertRules.shouldNotify(stamp, ledger.get(id))) continue;
            String[] line = AlertRules.alertText(next, newest);
            post.post(line[0], line[1], id);
            ledger.put(id, stamp);
            posted.add(id);
        }
        writeShows(page, shows);
        writeLedger(ledgerStore, ledger, shows);
        return posted;
    }

    // ── the row and the ledger ────────────────────────────────────────────────

    /** The page's row, parsed; an empty object when absent or not a JSON object. */
    public static JSONObject readShows(SharedPreferences page) {
        String raw = page.getString(AlertRules.STARRED_SHOWS_KEY, null);
        if (raw == null) return new JSONObject();
        try {
            Object parsed = new JSONTokener(raw).nextValue();
            return parsed instanceof JSONObject ? (JSONObject) parsed : new JSONObject();
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    /** True when the page's row is present and a JSON object (an unreadable row is never overwritten). */
    static boolean rowReadable(SharedPreferences page) {
        String raw = page.getString(AlertRules.STARRED_SHOWS_KEY, null);
        if (raw == null) return false;
        try {
            return new JSONTokener(raw).nextValue() instanceof JSONObject;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * The row as the page writes it: a JSON string. Android's {@code org.json}
     * escapes every {@code /} as {@code \/}; that is valid JSON and parses back
     * the same, but the page's {@code JSON.stringify} never writes it, so it is
     * undone here and the row reads as the page's own. Safe because a backslash
     * in a value is itself escaped ({@code \\}), so every {@code \/} in the
     * output is an escaped slash.
     */
    static void writeShows(SharedPreferences page, JSONObject shows) {
        if (!rowReadable(page)) return;
        page.edit().putString(AlertRules.STARRED_SHOWS_KEY, shows.toString().replace("\\/", "/")).commit();
    }

    public static Map<String, String> readLedger(SharedPreferences ledgerStore) {
        Map<String, String> out = new LinkedHashMap<>();
        String raw = ledgerStore.getString(AlertRules.LEDGER_KEY, null);
        if (raw == null) return out;
        try {
            Object parsed = new JSONTokener(raw).nextValue();
            if (!(parsed instanceof JSONObject)) return out;
            JSONObject o = (JSONObject) parsed;
            Iterator<String> keys = o.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                String v = AlertRules.text(o.opt(k));
                if (v != null) out.put(k, v);
            }
        } catch (Exception e) {
            // an unreadable ledger is an empty one
        }
        return out;
    }

    /** The ledger, holding only shows that are still followed; removed when empty. */
    static void writeLedger(SharedPreferences ledgerStore, Map<String, String> ledger, JSONObject shows) {
        JSONObject kept = new JSONObject();
        for (Map.Entry<String, String> e : ledger.entrySet()) {
            if (!(shows.opt(e.getKey()) instanceof JSONObject)) continue;
            try {
                kept.put(e.getKey(), e.getValue());
            } catch (Exception ignored) {
                // a key org.json refuses cannot be a show id the page wrote
            }
        }
        if (kept.length() == 0) {
            ledgerStore.edit().remove(AlertRules.LEDGER_KEY).commit();
        } else {
            ledgerStore.edit().putString(AlertRules.LEDGER_KEY, kept.toString()).commit();
        }
    }

    /** Drop the ledger entries of shows no longer followed. */
    public static void pruneLedger(SharedPreferences page, SharedPreferences ledgerStore) {
        writeLedger(ledgerStore, readLedger(ledgerStore), readShows(page));
    }

    public static void pruneLedger(Context context) {
        pruneLedger(pageStore(context), ledgerStore(context));
    }

    // ── the network ───────────────────────────────────────────────────────────

    /** GET page 1 of the show's episodes, 10 s connect and read, no cache; null on any failure. */
    public static JSONArray fetchEpisodes(String showId) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(AlertRules.episodesUrl(showId)).openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(AlertRules.FETCH_TIMEOUT_MS);
            conn.setReadTimeout(AlertRules.FETCH_TIMEOUT_MS);
            conn.setUseCaches(false);
            conn.setRequestProperty("Accept", "application/json");
            if (conn.getResponseCode() != 200) return null;
            try (InputStream in = conn.getInputStream()) {
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                byte[] chunk = new byte[8192];
                int n;
                while ((n = in.read(chunk)) != -1) buf.write(chunk, 0, n);
                Object body = new JSONTokener(new String(buf.toByteArray(), StandardCharsets.UTF_8)).nextValue();
                return AlertRules.rowsFromBody(body);
            }
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
