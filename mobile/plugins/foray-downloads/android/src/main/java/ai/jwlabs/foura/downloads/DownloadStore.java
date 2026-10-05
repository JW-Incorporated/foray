package ai.jwlabs.foura.downloads;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;
import android.net.Uri;
import android.util.AtomicFile;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * The Android download store: the system {@link DownloadManager} fetches episode
 * audio, and a JSON index in {@code getNoBackupFilesDir()/foray-downloads/}
 * remembers what is there. Issue #29; docs/roadmap/player-features.md PQ-22. The
 * twin of the iOS {@code DownloadStore.swift}; the rules are
 * {@link DownloadRules}'s.
 *
 * <p>WHERE THE BYTES GO, AND WHY TWO DIRECTORIES. DownloadManager runs in the
 * system's download provider, a different app, and it refuses a destination in
 * this app's internal storage: {@code setDestinationUri} with a
 * {@code getFilesDir()} path throws {@code SecurityException: Unsupported path}.
 * So the transfer lands in {@code getExternalFilesDir(null)/foray-downloads/}
 * ({@code setDestinationInExternalFilesDir}), the app's own external directory,
 * and the completion handler MOVES the finished file into
 * {@code getNoBackupFilesDir()/foray-downloads/}. Left where it landed, the file
 * would be in Auto Backup's default set (which includes the external files
 * directory), and a backup over its 25 MB quota is skipped whole — one podcast
 * would cost the listener the backup of everything else. The no-backup directory
 * is excluded from cloud backup and device transfer by the platform's contract,
 * which is what iOS's {@code isExcludedFromBackup} promises there.
 *
 * <p>EVENTS. DownloadManager has no progress callback: while any row is in
 * flight the store asks it every {@link DownloadRules#PROGRESS_POLL_MS} ms and
 * emits {@code downloadProgress}. Completion arrives as
 * {@code ACTION_DOWNLOAD_COMPLETE} (a runtime receiver, exported because the
 * sender is the download provider) and is also seen by the poll, whichever is
 * first; both run on one worker thread, so a download is finished once. A
 * download that finished while the app was not running is found by the same
 * poll on the next {@link #start}.
 *
 * <p>THREADING. The index is read and written only under {@code synchronized
 * (this)}. The poll, the receiver's work and the file move run on
 * {@code worker}, one thread; the move itself runs outside the lock. Events go
 * to the plugin's {@code notifyListeners}, which Capacitor allows from any
 * thread.
 */
final class DownloadStore {

    /** The plugin's {@code notifyListeners}, replaced on every plugin load. */
    interface Emitter {
        void emit(String event, JSObject payload);
    }

    private static DownloadStore shared;

    /** One store per process, like iOS's {@code DownloadStore.shared}: the
     *  plugin is re-created with the WebView, the downloads are not. */
    static synchronized DownloadStore get(Context context) {
        if (shared == null) shared = new DownloadStore(context.getApplicationContext());
        return shared;
    }

    private final Context context;
    private final DownloadManager manager;
    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
    private final Map<String, Record> items = new LinkedHashMap<>();
    private volatile Emitter emitter;
    private boolean loaded;
    private boolean started;
    private ScheduledFuture<?> poller;

    private DownloadStore(Context context) {
        this.context = context;
        this.manager = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
    }

    void setEmitter(Emitter emitter) {
        this.emitter = emitter;
    }

    private void emit(String event, JSObject payload) {
        Emitter e = emitter;
        if (e != null) e.emit(event, payload);
    }

    // ── the directories ───────────────────────────────────────────────────────

    /** {@code getNoBackupFilesDir()/foray-downloads/}: the finished files and
     *  the index. */
    private File storeDir() {
        return new File(context.getNoBackupFilesDir(), DownloadRules.DIRECTORY_NAME);
    }

    /** {@code getExternalFilesDir(null)/foray-downloads/}: where DownloadManager
     *  writes before the move, or null when external storage is unavailable. */
    private File landingDir() {
        File base = context.getExternalFilesDir(null);
        return base == null ? null : new File(base, DownloadRules.DIRECTORY_NAME);
    }

    private File storedFile(String name) {
        return new File(storeDir(), name);
    }

    // ── the record and the index (under the lock) ─────────────────────────────

    static final class Record {
        String id;
        String url;
        String file;
        String status;
        long bytes;
        Long total;
        String reason;
        /** DownloadManager's id while in flight, else -1. */
        long transfer = -1;

        JSONObject toJson() throws JSONException {
            JSONObject o = new JSONObject();
            o.put("id", id);
            o.put("url", url);
            o.put("file", file);
            o.put("status", status);
            o.put("bytes", bytes);
            o.put("total", total == null ? JSONObject.NULL : total);
            o.put("reason", reason == null ? JSONObject.NULL : reason);
            o.put("transfer", transfer);
            return o;
        }

        static Record fromJson(JSONObject o) {
            Record r = new Record();
            r.id = o.optString("id", null);
            r.url = o.optString("url", "");
            r.file = o.optString("file", null);
            r.status = o.optString("status", "failed");
            r.bytes = o.optLong("bytes", 0);
            r.total = o.isNull("total") || !o.has("total") ? null : o.optLong("total");
            r.reason = o.isNull("reason") || !o.has("reason") ? null : o.optString("reason");
            r.transfer = o.optLong("transfer", -1);
            return r;
        }

        boolean inFlight() {
            return "queued".equals(status) || "downloading".equals(status);
        }
    }

    private AtomicFile indexFile() {
        return new AtomicFile(new File(storeDir(), DownloadRules.INDEX_FILE_NAME));
    }

    /** Reads the index once. A file that does not parse is an empty index: a
     *  torn write must never stop the app from opening the store. */
    private void loadIfNeeded() {
        if (loaded) return;
        loaded = true;
        items.clear();
        try {
            byte[] raw = indexFile().readFully();
            JSONObject rows = new JSONObject(new String(raw, StandardCharsets.UTF_8)).optJSONObject("items");
            if (rows == null) return;
            Iterator<String> keys = rows.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                JSONObject row = rows.optJSONObject(key);
                if (row == null) continue;
                Record r = Record.fromJson(row);
                if (r.id == null || !r.id.equals(key) || !DownloadRules.isStoreFileName(r.file)) continue;
                items.put(key, r);
            }
        } catch (FileNotFoundException e) {
            // No index yet.
        } catch (IOException | JSONException e) {
            items.clear();
        }
    }

    /** Writes the index through {@link AtomicFile}. A failed write costs a
     *  re-download, never the files already on disk. */
    private void save() {
        File dir = storeDir();
        if (!dir.isDirectory() && !dir.mkdirs()) return;
        AtomicFile file = indexFile();
        FileOutputStream out = null;
        try {
            JSONObject rows = new JSONObject();
            for (Record r : items.values()) rows.put(r.id, r.toJson());
            JSONObject index = new JSONObject();
            index.put("version", 1);
            index.put("items", rows);
            out = file.startWrite();
            out.write(index.toString().getBytes(StandardCharsets.UTF_8));
            file.finishWrite(out);
        } catch (IOException | JSONException e) {
            if (out != null) file.failWrite(out);
        }
    }

    /** A {@code done} row whose file is gone is answered {@code missing}, the
     *  status download-store.js keeps for it. */
    private String reconciledStatus(Record r) {
        if ("done".equals(r.status) && !storedFile(r.file).isFile()) return "missing";
        return r.status;
    }

    private JSObject answer(Record r) {
        String status = reconciledStatus(r);
        JSObject row = new JSObject();
        row.put("id", r.id);
        row.put("status", status);
        row.put("bytes", r.bytes);
        row.put("total", r.total == null ? JSONObject.NULL : r.total);
        row.put("reason", r.reason == null ? JSONObject.NULL : r.reason);
        row.put("path", "done".equals(status) ? storedFile(r.file).getAbsolutePath() : JSONObject.NULL);
        return row;
    }

    // ── start-up ──────────────────────────────────────────────────────────────

    /** Called from the plugin's {@code load()}: reads the index, registers the
     *  completion receiver once per process, and polls once at once, which
     *  settles every row whose transfer finished (or vanished) while the app
     *  was not running. */
    void start() {
        synchronized (this) {
            loadIfNeeded();
            if (started) return;
            started = true;
        }
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                if (DownloadManager.ACTION_DOWNLOAD_COMPLETE.equals(intent.getAction())) {
                    worker.execute(DownloadStore.this::pollOnceSafely);
                }
            }
        };
        ContextCompat.registerReceiver(context, receiver,
                new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE), ContextCompat.RECEIVER_EXPORTED);
        worker.execute(this::pollOnceSafely);
        ensurePolling();
    }

    // ── the calls ─────────────────────────────────────────────────────────────

    /**
     * {@code enqueue({ id, url, userAgent, allowCellular })}: answers at once
     * with the row (status {@code queued}, or the row that already exists);
     * everything after arrives as events.
     *
     * <p>{@code allowCellular} reaches both {@code setAllowedOverMetered} and
     * {@code setAllowedOverRoaming}: a Wi-Fi-only listener's download waits
     * (DownloadManager pauses it, the row stays {@code queued}) until an
     * unmetered network appears.
     */
    JSObject enqueue(String id, String rawUrl, String userAgent, boolean allowCellular) throws IOException {
        if (id == null || id.isEmpty()) throw new IllegalArgumentException("ForayDownloads needs an episode id");
        String url = DownloadRules.source(rawUrl);
        if (url == null) throw new IllegalArgumentException(DownloadRules.REASON_BAD_URL);
        JSObject row;
        synchronized (this) {
            loadIfNeeded();
            Record existing = items.get(id);
            if (existing != null) {
                String current = reconciledStatus(existing);
                if ("queued".equals(current) || "downloading".equals(current) || "done".equals(current)) {
                    return answer(existing);
                }
            }
            File landing = landingDir();
            if (landing == null) throw new IOException("ForayDownloads: no external files directory");
            String file = DownloadRules.fileName(id);
            /* DownloadManager picks a fresh name ("x-1.bin") when its target
               exists, so a stale partial from a dead transfer goes first. */
            File stale = new File(landing, file);
            if (stale.exists() && !stale.delete()) throw new IOException("ForayDownloads: cannot clear " + file);

            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            String ua = DownloadRules.userAgentHeader(userAgent);
            if (ua != null) request.addRequestHeader("User-Agent", ua);
            request.setAllowedOverMetered(allowCellular);
            request.setAllowedOverRoaming(allowCellular);
            request.setDestinationInExternalFilesDir(context, null, DownloadRules.DIRECTORY_NAME + "/" + file);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE);
            request.setTitle("Downloading an episode");

            Record r = new Record();
            r.id = id;
            r.url = url;
            r.file = file;
            r.status = "queued";
            r.transfer = manager.enqueue(request);
            items.put(id, r);
            save();
            row = answer(r);
        }
        ensurePolling();
        return row;
    }

    /** {@code cancel({ id })}: stops the transfer; the row becomes
     *  {@code failed} / {@code cancelled} (retryable) and a
     *  {@code downloadFailed} says so. */
    void cancel(String id) {
        if (id == null || id.isEmpty()) throw new IllegalArgumentException("ForayDownloads needs an episode id");
        long transfer;
        synchronized (this) {
            loadIfNeeded();
            Record r = items.get(id);
            if (r == null || !r.inFlight()) return;
            transfer = r.transfer;
            r.status = "failed";
            r.reason = DownloadRules.REASON_CANCELLED;
            r.transfer = -1;
            save();
        }
        if (transfer >= 0) manager.remove(transfer);
        emit(DownloadRules.EVENT_FAILED, failedPayload(id, DownloadRules.REASON_CANCELLED, null));
    }

    /** {@code remove({ id })}: drops the row FIRST (so a late completion finds
     *  nothing to report), stops any transfer, deletes the file. */
    boolean remove(String id) {
        if (id == null || id.isEmpty()) throw new IllegalArgumentException("ForayDownloads needs an episode id");
        String file;
        long transfer;
        synchronized (this) {
            loadIfNeeded();
            Record r = items.remove(id);
            file = r != null ? r.file : DownloadRules.fileName(id);
            transfer = r != null ? r.transfer : -1;
            save();
        }
        if (transfer >= 0) manager.remove(transfer);
        File landing = landingDir();
        if (landing != null) new File(landing, file).delete();
        File stored = storedFile(file);
        return stored.isFile() && stored.delete();
    }

    /** {@code removeAll()}: stops every transfer and deletes both directories,
     *  the index with them ("Delete my data", PQ-18 step 7). */
    void removeAll() throws IOException {
        List<Long> transfers = new ArrayList<>();
        synchronized (this) {
            loadIfNeeded();
            for (Record r : items.values()) if (r.transfer >= 0) transfers.add(r.transfer);
            items.clear();
        }
        if (!transfers.isEmpty()) {
            long[] ids = new long[transfers.size()];
            for (int i = 0; i < ids.length; i++) ids[i] = transfers.get(i);
            manager.remove(ids);
        }
        File landing = landingDir();
        if (landing != null) deleteTree(landing);
        if (!deleteTree(storeDir())) throw new IOException("ForayDownloads: could not delete every stored file");
    }

    /** {@code list()}: every row, {@code done} rows checked against the disk. */
    synchronized List<JSObject> list() {
        loadIfNeeded();
        List<String> keys = new ArrayList<>(items.keySet());
        Collections.sort(keys);
        List<JSObject> out = new ArrayList<>();
        for (String k : keys) out.add(answer(items.get(k)));
        return out;
    }

    /** {@code usage()}: {@code { bytes, count }} of finished downloads, summed
     *  from the sizes recorded at completion; {@code done} rows only, like
     *  download-store.js's {@code usedBytes}. */
    synchronized JSObject usage() {
        loadIfNeeded();
        long bytes = 0;
        int count = 0;
        for (Record r : items.values()) {
            if (!"done".equals(r.status)) continue;
            bytes += Math.max(0, r.bytes);
            count++;
        }
        JSObject out = new JSObject();
        out.put("bytes", bytes);
        out.put("count", count);
        return out;
    }

    /** {@code fileSrc({ id } | { path })}: the stored file's absolute path. By
     *  path, only a name this store writes, resolved inside the directory. */
    JSObject fileSrc(String id, String path) {
        String name;
        if (id != null && !id.isEmpty()) {
            synchronized (this) {
                loadIfNeeded();
                Record r = items.get(id);
                name = r != null ? r.file : DownloadRules.fileName(id);
            }
        } else if (path != null && DownloadRules.isStoreFileName(new File(path).getName())) {
            name = new File(path).getName();
        } else {
            throw new IllegalArgumentException("no such download");
        }
        File f = storedFile(name);
        JSObject out = new JSObject();
        out.put("path", f.getAbsolutePath());
        out.put("exists", f.isFile());
        return out;
    }

    // ── the poll (on `worker`) ────────────────────────────────────────────────

    /** Starts the every-two-seconds poll unless it is running. */
    private synchronized void ensurePolling() {
        if (poller != null && !poller.isDone()) return;
        poller = worker.scheduleWithFixedDelay(this::tick, DownloadRules.PROGRESS_POLL_MS,
                DownloadRules.PROGRESS_POLL_MS, TimeUnit.MILLISECONDS);
    }

    /** One poll, then stop polling when nothing is in flight. The check and
     *  the stop share the lock with {@link #enqueue}'s insert, so a download
     *  queued during a poll is never left without one. */
    private void tick() {
        pollOnceSafely();
        synchronized (this) {
            if (hasInFlight()) return;
            if (poller != null) poller.cancel(false);
            poller = null;
        }
    }

    private boolean hasInFlight() {
        for (Record r : items.values()) if (r.inFlight()) return true;
        return false;
    }

    /** A throw out of a scheduled task would cancel every later run. */
    private void pollOnceSafely() {
        try {
            pollOnce();
        } catch (Throwable t) {
            // The next tick asks again.
        }
    }

    /** One look at every in-flight row's transfer: progress for the running,
     *  completion for the finished, failure for the failed and for a row
     *  whose transfer DownloadManager no longer knows. */
    private void pollOnce() {
        Map<Long, String> byTransfer = new HashMap<>();
        List<String> orphans = new ArrayList<>();
        synchronized (this) {
            loadIfNeeded();
            for (Record r : items.values()) {
                if (!r.inFlight()) continue;
                if (r.transfer >= 0) byTransfer.put(r.transfer, r.id);
                else orphans.add(r.id);
            }
        }
        for (String id : orphans) fail(id, -1, DownloadRules.REASON_INTERRUPTED, null);
        if (byTransfer.isEmpty()) return;

        long[] ids = new long[byTransfer.size()];
        int n = 0;
        for (Long t : byTransfer.keySet()) ids[n++] = t;
        Map<Long, String> seen = new HashMap<>();
        Cursor c = manager.query(new DownloadManager.Query().setFilterById(ids));
        if (c == null) return;
        try {
            int colId = c.getColumnIndexOrThrow(DownloadManager.COLUMN_ID);
            int colStatus = c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS);
            int colReason = c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON);
            int colSoFar = c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR);
            int colTotal = c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES);
            int colLocal = c.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI);
            while (c.moveToNext()) {
                long transfer = c.getLong(colId);
                String id = byTransfer.get(transfer);
                if (id == null) continue;
                seen.put(transfer, id);
                int status = c.getInt(colStatus);
                if (status == DownloadManager.STATUS_SUCCESSFUL) {
                    complete(id, transfer, c.getString(colLocal));
                } else if (status == DownloadManager.STATUS_FAILED) {
                    int reason = c.getInt(colReason);
                    fail(id, transfer, DownloadRules.failureReason(reason), DownloadRules.httpStatus(reason));
                } else if (status == DownloadManager.STATUS_RUNNING) {
                    progress(id, transfer, c.getLong(colSoFar), c.getLong(colTotal));
                }
                /* PENDING and PAUSED (waiting for Wi-Fi, for a network, to
                   retry) leave the row as it is: "cellular off" stays queued. */
            }
        } finally {
            c.close();
        }
        for (Map.Entry<Long, String> e : byTransfer.entrySet()) {
            if (!seen.containsKey(e.getKey())) {
                /* Cleared from the system's Downloads list, or lost with a
                   provider reset: nothing is coming, so say so. */
                fail(e.getValue(), e.getKey(), DownloadRules.REASON_INTERRUPTED, null);
            }
        }
    }

    private void progress(String id, long transfer, long soFar, long total) {
        synchronized (this) {
            Record r = items.get(id);
            if (r == null || !r.inFlight() || r.transfer != transfer) return;
            r.bytes = Math.max(0, soFar);
            r.total = total > 0 ? Long.valueOf(total) : null;
            if ("queued".equals(r.status)) {
                r.status = "downloading";
                save();
            }
        }
        JSObject p = new JSObject();
        p.put("id", id);
        p.put("bytes", Math.max(0, soFar));
        p.put("total", total > 0 ? Long.valueOf(total) : JSONObject.NULL);
        emit(DownloadRules.EVENT_PROGRESS, p);
    }

    /**
     * A successful transfer: move the file from the landing directory into the
     * no-backup directory, then let DownloadManager forget its row (which also
     * deletes the landed copy when the move had to copy). Runs on
     * {@code worker}; the copy runs outside the lock.
     */
    private void complete(String id, long transfer, String localUri) {
        String file;
        synchronized (this) {
            Record r = items.get(id);
            if (r == null || !r.inFlight() || r.transfer != transfer) return;
            file = r.file;
        }
        File landing = landingDir();
        File landed = landedFile(localUri, landing, file);
        File dest = storedFile(file);
        long bytes;
        try {
            bytes = moveInto(landed, dest);
        } catch (IOException e) {
            // fail() also lets DownloadManager forget the row and its file.
            fail(id, transfer, DownloadRules.REASON_NOT_SAVED, null);
            return;
        }
        manager.remove(transfer);
        boolean stillWanted;
        synchronized (this) {
            Record r = items.get(id);
            stillWanted = r != null && r.inFlight() && r.transfer == transfer;
            if (stillWanted) {
                r.status = "done";
                r.bytes = bytes;
                r.total = bytes;
                r.reason = null;
                r.transfer = -1;
                save();
            }
        }
        if (!stillWanted) {
            // Removed or cancelled while the file moved: keep nothing.
            dest.delete();
            return;
        }
        JSObject p = new JSObject();
        p.put("id", id);
        p.put("path", dest.getAbsolutePath());
        p.put("bytes", bytes);
        emit(DownloadRules.EVENT_DONE, p);
    }

    /** The file DownloadManager wrote: its {@code COLUMN_LOCAL_URI} when that
     *  names a file inside the landing directory, else the name this store
     *  asked for. */
    private static File landedFile(String localUri, File landing, String file) {
        if (landing != null && localUri != null) {
            try {
                String p = Uri.parse(localUri).getPath();
                if (p != null) {
                    File f = new File(p);
                    File parent = f.getCanonicalFile().getParentFile();
                    if (parent != null && parent.equals(landing.getCanonicalFile())) return f;
                }
            } catch (IOException | RuntimeException e) {
                // Fall back to the name we asked for.
            }
        }
        return new File(landing, file);
    }

    /**
     * Moves {@code src} to {@code dest}: a rename when both are on one file
     * system, else a copy to {@code dest.part} and a rename of that, so a crash
     * mid-copy never leaves a short file under the real name. Returns the bytes
     * now at {@code dest}.
     */
    private long moveInto(File src, File dest) throws IOException {
        File dir = dest.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
        if (!src.isFile()) throw new FileNotFoundException(src.getName());
        if (dest.exists() && !dest.delete()) throw new IOException("cannot replace " + dest.getName());
        if (src.renameTo(dest)) return dest.length();
        File part = new File(dir, dest.getName() + ".part");
        long copied = 0;
        try (InputStream in = new FileInputStream(src); OutputStream out = new FileOutputStream(part)) {
            byte[] buf = new byte[64 * 1024];
            int k;
            while ((k = in.read(buf)) != -1) {
                out.write(buf, 0, k);
                copied += k;
            }
        } catch (IOException e) {
            part.delete();
            throw e;
        }
        if (!part.renameTo(dest)) {
            part.delete();
            throw new IOException("cannot rename " + part.getName());
        }
        src.delete();
        return copied;
    }

    /** Settles an in-flight row as failed. {@code transfer} -1 matches a row
     *  that never got one. */
    private void fail(String id, long transfer, String reason, Integer httpStatus) {
        synchronized (this) {
            Record r = items.get(id);
            if (r == null || !r.inFlight() || r.transfer != transfer) return;
            r.status = DownloadRules.statusForReason(reason);
            r.reason = reason;
            r.transfer = -1;
            save();
        }
        if (transfer >= 0) manager.remove(transfer);
        emit(DownloadRules.EVENT_FAILED, failedPayload(id, reason, httpStatus));
    }

    private static JSObject failedPayload(String id, String reason, Integer httpStatus) {
        JSObject p = new JSObject();
        p.put("id", id);
        p.put("reason", reason);
        p.put("status", httpStatus == null ? JSONObject.NULL : httpStatus);
        return p;
    }

    /** Deletes {@code dir} and everything under it; true when nothing is left. */
    private static boolean deleteTree(File dir) {
        if (!dir.exists()) return true;
        File[] children = dir.listFiles();
        if (children != null) {
            for (File child : children) {
                if (child.isDirectory()) deleteTree(child);
                else child.delete();
            }
        }
        return dir.delete() || !dir.exists();
    }
}
