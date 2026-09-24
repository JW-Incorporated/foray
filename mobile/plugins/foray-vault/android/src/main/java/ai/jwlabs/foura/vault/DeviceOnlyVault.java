package ai.jwlabs.foura.vault;

import android.util.AtomicFile;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;

/**
 * The device-only store behind {@code ForayVault} on Android (round-2 audit
 * persist-6; founder ruling 2026-09-24, "Option A").
 *
 * <p>One small JSON object in ONE file, and the file's directory is the whole
 * promise: {@link ForayVaultPlugin} puts it in
 * {@code Context.getNoBackupFilesDir()}, which the platform's backup agent
 * always leaves out, so the token is never in the listener's Google backup.
 * {@code SharedPreferences} (what {@code @capacitor/preferences} writes) lives in
 * {@code shared_prefs/}, which IS backed up by default — that is the defect.
 *
 * <p>Writes go through {@link AtomicFile}, so a crash mid-write leaves the
 * previous file rather than half of one. Every method is synchronized: the
 * Capacitor bridge may call from more than one thread.
 */
final class DeviceOnlyVault {
    private final AtomicFile file;

    DeviceOnlyVault(File file) {
        this.file = new AtomicFile(file);
    }

    synchronized List<String> keys() throws IOException, JSONException {
        JSONObject rows = read();
        List<String> out = new ArrayList<>();
        Iterator<String> it = rows.keys();
        while (it.hasNext()) out.add(it.next());
        Collections.sort(out);
        return out;
    }

    /** @return the value, or null when there is no such row */
    synchronized String get(String key) throws IOException, JSONException {
        JSONObject rows = read();
        return rows.has(key) ? rows.getString(key) : null;
    }

    synchronized void set(String key, String value) throws IOException, JSONException {
        JSONObject rows = read();
        rows.put(key, value);
        write(rows);
    }

    synchronized void remove(String key) throws IOException, JSONException {
        JSONObject rows = read();
        if (rows.remove(key) != null) write(rows);
    }

    private JSONObject read() throws IOException, JSONException {
        byte[] bytes;
        try {
            bytes = file.readFully();
        } catch (FileNotFoundException e) {
            return new JSONObject();
        }
        if (bytes.length == 0) return new JSONObject();
        return new JSONObject(new String(bytes, StandardCharsets.UTF_8));
    }

    private void write(JSONObject rows) throws IOException {
        FileOutputStream out = file.startWrite();
        try {
            out.write(rows.toString().getBytes(StandardCharsets.UTF_8));
            file.finishWrite(out);
        } catch (IOException e) {
            file.failWrite(out);
            throw e;
        }
    }
}
