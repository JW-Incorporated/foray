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
        JSONObject rows = readForWrite();
        rows.put(key, value);
        write(rows);
    }

    synchronized void remove(String key) throws IOException, JSONException {
        JSONObject rows;
        boolean unreadable = false;
        try {
            rows = read();
        } catch (JSONException e) {
            unreadable = true;
            rows = unreadableStore(e);
        }
        /* An unreadable file is REPLACED by the empty store even when it held
           no such key that we could see: "Delete my data" must leave nothing
           the next read could choke on or recover. */
        if (rows.remove(key) != null || unreadable) write(rows);
    }

    /** For a WRITE (audit round 3, mobile-native-7): a file that no longer
     *  parses is treated as an empty store and overwritten. {@link AtomicFile}
     *  only guards against a torn write; storage corruption or a hand edit
     *  used to make {@code set} and {@code remove} throw on every call, so the
     *  listener's account could never be saved again and Delete my data could
     *  not clear the row, until an uninstall. {@code get}/{@code keys} still
     *  reject, so the store keeps saying "could not look" rather than "no
     *  account". */
    private JSONObject readForWrite() throws IOException {
        try {
            return read();
        } catch (JSONException e) {
            return unreadableStore(e);
        }
    }

    /** The empty store an unreadable file is replaced by. Deliberately NOT
     *  logged: this plugin writes nothing to the log (the file may hold a
     *  token, and a parser's message can quote it). The recovery is visible
     *  instead as the next write succeeding. */
    private static JSONObject unreadableStore(JSONException e) {
        return new JSONObject();
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
