package ai.jwlabs.foura.audio.engine;

import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.EngineConfig;
import ai.jwlabs.foura.engine.EngineCore;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.RestoreRecord;
import ai.jwlabs.foura.engine.Rows;
import android.content.Context;
import android.content.SharedPreferences;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;
import java.util.function.Consumer;

/**
 * Where everything the Android engine keeps is kept (card A-27, docs/plans/android-assessment.md
 * §5.4), and the real {@link EngineSeams.Output} the host hands its persistence commands to. The
 * JVM twin of the iOS {@code EngineStore} (ForayAudioPlugin/Engine/EngineStore.swift, NE-19).
 *
 * <h2>TWO KINDS OF STATE, TWO PLACES</h2>
 * <ul>
 *   <li><b>SHARED ROWS</b> {@code cp_pos:*}, {@code cp_foray:*}, {@code cp_last_episode}, in the
 *       SharedPreferences file {@code @capacitor/preferences} keeps the page's rows in on Android
 *       ({@value #SHARED_FILE}, its default group; on Android the key is the row key itself,
 *       where iOS prefixes it with {@code CapacitorStorage.}), holding the exact {@code JSWriter}
 *       strings the page's own writers produce ({@link Rows}). So a position the engine wrote is
 *       a position the page reads, byte for byte, when the listener switches engines (plan
 *       §4.6). The engine writes NO other key in that file: {@link #writeShared} refuses one
 *       outside {@code OWNED_PREFIXES} with a {@code fault} row.</li>
 *   <li><b>PRIVATE</b> the restore record (and, with A-29, the ownership keys), in the engine's
 *       own file {@value #PRIVATE_FILE}, under the same {@code ForayEngine.*} names iOS uses in
 *       {@code UserDefaults}. Outside the page's file, so the Preferences plugin (and the
 *       DurableStore above it) never hydrates, mirrors or clobbers them.</li>
 * </ul>
 * The diagnostics ring stays {@link EngineLog}'s (in memory, the service's dump and logcat): the
 * page's durable copy of it is A-28's bridge.
 *
 * <h2>SYNCHRONOUS</h2>
 * Every write is {@code commit()}ed before the call returns: no {@code apply()}, no debounce, no
 * write-behind. The record a car's PLAY resumes from is written at the pause, and the process
 * can be killed any time after that; an {@code apply()} still queued at a SIGKILL is a write
 * lost, which is the founder's #689 ("it jumped back several minutes") on a new platform. The
 * files are a few hundred bytes, and a write happens at a pause, a load and at most every few
 * seconds of play.
 *
 * <p>Main-confined like the host that drives it.
 */
public final class EngineStore implements EngineSeams.Output {
    /** {@code @capacitor/preferences}' file on Android ({@code PreferencesConfiguration}'s default group). */
    public static final String SHARED_FILE = "CapacitorStorage";
    /** The engine's own file. */
    public static final String PRIVATE_FILE = "ForayEngine";
    /** Every private key starts with this, as on iOS ({@code EngineKeys.privatePrefix}). */
    public static final String PRIVATE_PREFIX = "ForayEngine.";
    /** The cold path's restore record ({@code EnginePrivateKey.restore}). */
    public static final String KEY_RESTORE = PRIVATE_PREFIX + "restore";

    private final SharedPreferences shared;
    private final SharedPreferences own;
    private final EngineLog log;
    private final Consumer<Boolean> resumableChanged;
    private boolean recordRead;
    private RestoreRecord record;
    /**
     * What {@link #resumableChanged} was last told. It starts true: the service switched the
     * receiver on when it was created, before this store existed.
     */
    private boolean resumable = true;

    /**
     * @param resumableChanged told when the store starts or stops holding a record a PLAY
     *     could resume: false at a relinquished or cleared record and at a purge (the service
     *     switches the media button receiver off, so a dead lane never answers a car), true
     *     again when the engine writes a record after that (a listener who deleted their data
     *     and then played again is resumable again). Only on a change, so a write every few
     *     seconds of play costs no PackageManager call.
     */
    public EngineStore(Context context, EngineLog log, Consumer<Boolean> resumableChanged) {
        this(context.getSharedPreferences(SHARED_FILE, Context.MODE_PRIVATE),
                context.getSharedPreferences(PRIVATE_FILE, Context.MODE_PRIVATE), log, resumableChanged);
    }

    EngineStore(SharedPreferences shared, SharedPreferences own, EngineLog log, Consumer<Boolean> resumableChanged) {
        this.shared = Objects.requireNonNull(shared, "shared");
        this.own = Objects.requireNonNull(own, "own");
        this.log = Objects.requireNonNull(log, "log");
        this.resumableChanged = resumableChanged;
    }

    public EngineLog log() {
        return log;
    }

    /** A row key the engine owns: durable-store.js's {@code _owner.prefixes.some((p) => key.startsWith(p))}, exactly. */
    public static boolean isOwnedRow(String rowKey) {
        if (rowKey == null) return false;
        for (String prefix : Rows.OWNED_PREFIXES) if (rowKey.startsWith(prefix)) return true;
        return false;
    }

    // ---- shared rows

    /**
     * Store one shared row verbatim, or refuse (with a {@code fault} row, never a throw) a key
     * the engine does not own: writing the page's {@code cp_rate} would be the engine doing the
     * page's job with the page's bytes.
     */
    public boolean writeShared(Rows.StoredRow row) {
        if (row == null) return false;
        if (!isOwnedRow(row.key())) {
            List<JsonNode.Member> fields = new ArrayList<>();
            fields.add(JsonNode.member("kind", JsonNode.str("not-owned")));
            fields.add(JsonNode.member("key", JsonNode.str(row.key())));
            log.diag(new EngineCommand.DiagEntry("fault", fields));
            return false;
        }
        boolean ok = shared.edit().putString(row.key(), row.value()).commit();
        if (!ok) failed("shared");
        return ok;
    }

    /** The row the page would read for {@code rowKey}, as stored. */
    public String readShared(String rowKey) {
        try {
            return shared.getString(rowKey, null);
        } catch (ClassCastException e) {
            return null;
        }
    }

    /**
     * Every shared ENGINE row under the given row-key prefixes (all of {@code OWNED_PREFIXES}
     * when none are given): what {@code engineRead("rows", prefixes)} answers (A-28).
     */
    public Map<String, String> sharedRows(List<String> prefixes) {
        List<String> wanted = prefixes == null ? Rows.OWNED_PREFIXES : prefixes;
        Map<String, String> rows = new TreeMap<>();
        for (Map.Entry<String, ?> e : shared.getAll().entrySet()) {
            String key = e.getKey();
            if (!isOwnedRow(key) || !(e.getValue() instanceof String text)) continue;
            for (String prefix : wanted) {
                if (key.startsWith(prefix)) {
                    rows.put(key, text);
                    break;
                }
            }
        }
        return rows;
    }

    // ---- the restore record

    /** The stored record, or null for none or one this build cannot trust ({@link RestoreRecord#parse}). */
    public RestoreRecord restoreRecord() {
        if (!recordRead) {
            record = readRecord(own);
            recordRead = true;
        }
        return record;
    }

    /** The record's stored string, for the dump and the tests. */
    public String restoreRecordRaw() {
        return own.getString(KEY_RESTORE, null);
    }

    /** Whether the stored record holds something a PLAY can resume (a readable episode queue). */
    public boolean restorable() {
        return EngineCore.restoring(restoreRecord(), new EngineConfig()) != null;
    }

    /**
     * The same question, asked cold, without a service (the media button receiver, in a process
     * that may have just been started for it).
     */
    public static boolean restorable(Context context) {
        RestoreRecord stored = readRecord(context.getSharedPreferences(PRIVATE_FILE, Context.MODE_PRIVATE));
        return EngineCore.restoring(stored, new EngineConfig()) != null;
    }

    private static RestoreRecord readRecord(SharedPreferences prefs) {
        try {
            return RestoreRecord.parse(prefs.getString(KEY_RESTORE, null));
        } catch (RuntimeException e) {
            return null;
        }
    }

    // ---- deletion

    /**
     * Everything the engine ever stored, gone (data deletion; {@code engineSend purge} with
     * A-28): every shared engine row, and EVERY key in the engine's own file (not only today's
     * restore record, so a key a later card adds is not forgotten). The page's own rows
     * ({@code cp_rate}, {@code cp_engine_applied}, ...) are the page's to clear. Returns what it
     * removed, sorted, so the caller and the tests can enumerate it.
     */
    public List<String> purge() {
        List<String> removed = new ArrayList<>();
        SharedPreferences.Editor sharedEdit = shared.edit();
        for (String key : shared.getAll().keySet()) {
            if (isOwnedRow(key)) {
                sharedEdit.remove(key);
                removed.add(key);
            }
        }
        sharedEdit.commit();
        SharedPreferences.Editor ownEdit = own.edit();
        for (String key : own.getAll().keySet()) {
            ownEdit.remove(key);
            removed.add(key);
        }
        ownEdit.commit();
        record = null;
        recordRead = true;
        Collections.sort(removed);
        setResumable(false);
        return removed;
    }

    // ---- EngineSeams.Output

    @Override
    public void writePosition(EngineCommand.PositionWrite write) {
        writeShared(write.row());
        log.writePosition(write);
    }

    @Override
    public void writeRow(Rows.StoredRow row) {
        writeShared(row);
        log.writeRow(row);
    }

    @Override
    public void writeRestore(RestoreRecord next) {
        SharedPreferences.Editor edit = own.edit();
        if (next == null) edit.remove(KEY_RESTORE);
        else edit.putString(KEY_RESTORE, next.serialized());
        if (!edit.commit()) failed("restore");
        record = next;
        recordRead = true;
        log.writeRestore(next);
        setResumable(next != null && next.mode() != RestoreRecord.Mode.RELINQUISHED);
    }

    @Override
    public void appendEvent(EngineCommand.PendingEvent event) {
        // The pending events also ride in the restore record, which the page drains on attach
        // (plan §5.5); the live channel is A-28's bridge.
        log.appendEvent(event);
    }

    @Override
    public void emit(EngineCommand.EngineEvent event) {
        log.emit(event);
    }

    @Override
    public void diag(EngineCommand.DiagEntry entry) {
        log.diag(entry);
    }

    private void setResumable(boolean now) {
        if (now == resumable) return;
        resumable = now;
        if (resumableChanged == null) return;
        try {
            resumableChanged.accept(now);
        } catch (RuntimeException ignored) {
            // Switching a component must never cost a write.
        }
    }

    private void failed(String what) {
        List<JsonNode.Member> fields = new ArrayList<>();
        fields.add(JsonNode.member("kind", JsonNode.str("store-write-failed")));
        fields.add(JsonNode.member("what", JsonNode.str(what)));
        log.diag(new EngineCommand.DiagEntry("fault", fields));
    }
}
