package ai.jwlabs.foura.audio.engine;

import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.JSWriter;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.RestoreRecord;
import ai.jwlabs.foura.engine.Rows;
import android.os.SystemClock;
import android.util.Log;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;
import java.util.function.DoubleSupplier;

/**
 * The engine's rows. Since A-27 the service's {@link EngineSeams.Output} and the bridge's
 * {@link EngineBridge.Records} are {@link EngineStore}, which persists what must survive a process
 * death and hands every write, row and listener to this log; this class alone is still both for
 * the host's and the bridge's plain-JVM tests.
 *
 * <p>TWO RINGS. Every write is a text LINE, kept in a bounded ring (the service's {@code dump},
 * read by the native-mode scenario runner and by a device pass) and written to logcat under
 * {@link #TAG}. Every {@code diag} is ALSO a DiagRow (card A-28): {@code {seq, at, mono, kind,
 * ...fields}}, the shape the iOS ring stores (DiagRow.swift), with its own {@code seq} (a gap is a
 * lost row, never a reordering), kept in a second ring of {@link #ROW_CAPACITY}. That ring is what
 * {@code engineRead("diagnostics")} hands the page, so the Android engine's rows merge into the
 * diagnostics Copy exactly as the iOS engine's do (player/diagnostic-log.js, NE-26).
 *
 * <p>SHARED ROWS, IN MEMORY. The engine's shared rows ({@code cp_pos:}, {@code cp_last_episode})
 * are kept here by key, as written: {@code engineRead("rows")}'s answer when this log is the
 * bridge's records. In the app the store answers it from the persisted rows (A-27), which
 * outlive the process.
 *
 * <p>ONE PER PROCESS ({@link #process()}): the service writes into it, and the bridge reads it in
 * every lane, so a service recreated inside one process continues the same ring.
 *
 * <p>Tokens and numbers only, as every engine row is: an item's id may appear, a URL or a title
 * never does (the core's rows already keep to that; this class adds nothing to them).
 *
 * <p>ONE THREAD: every method is called on the host's looper (main).
 */
public final class EngineLog implements EngineSeams.Output, EngineBridge.Records {
    public static final String TAG = "ForayEngine";
    /** How many lines the text ring keeps. */
    public static final int CAPACITY = 400;
    /** How many DiagRows the page's ring keeps (player/diagnostic-log.js ENGINE_RING_CAP). */
    public static final int ROW_CAPACITY = 2000;
    /** The header every DiagRow starts with; a field may not reuse one (DiagRow.swift headerKeys). */
    static final Set<String> HEADER_KEYS = new HashSet<>(java.util.Arrays.asList("seq", "at", "mono", "kind"));

    private static EngineLog process;

    private final ArrayDeque<String> ring = new ArrayDeque<>();
    private final ArrayDeque<JsonNode> rows = new ArrayDeque<>();
    private final Map<String, String> shared = new LinkedHashMap<>();
    private final DoubleSupplier wallMs;
    private final DoubleSupplier monoMs;
    private final Consumer<String> sink;
    private EngineBridge.Records.Listener listener;
    private int seq;
    private int rowSeq;

    /** The process's log: logcat, stamped with the wall clock and elapsedRealtime. Main thread. */
    public static EngineLog process() {
        if (process == null) {
            process = new EngineLog(System::currentTimeMillis, SystemClock::elapsedRealtime, line -> Log.i(TAG, line));
        }
        return process;
    }

    public EngineLog(DoubleSupplier wallMs, DoubleSupplier monoMs, Consumer<String> sink) {
        this.wallMs = wallMs;
        this.monoMs = monoMs;
        this.sink = sink;
    }

    public EngineLog(DoubleSupplier wallMs, Consumer<String> sink) {
        this(wallMs, () -> 0, sink);
    }

    /** The text ring, oldest first. */
    public List<String> lines() {
        return new ArrayList<>(ring);
    }

    private void line(String kind, String body) {
        seq += 1;
        String text = seq + " " + JSWriter.isoString(wallMs.getAsDouble()) + " " + kind + " " + body;
        ring.addLast(text);
        while (ring.size() > CAPACITY) ring.removeFirst();
        try {
            sink.accept(text);
        } catch (RuntimeException ignored) {
            // A log line must never cost playback.
        }
    }

    @Override
    public void writePosition(EngineCommand.PositionWrite write) {
        line("position", "item=" + write.itemId() + " sec=" + JSWriter.numberToString(write.seconds()));
        if (write.row() != null) keep(write.row());
    }

    @Override
    public void writeRow(Rows.StoredRow row) {
        line("row", String.valueOf(row));
        if (row != null) keep(row);
    }

    private void keep(Rows.StoredRow row) {
        if (row.key() == null) return;
        if (row.value() == null) shared.remove(row.key());
        else shared.put(row.key(), row.value());
    }

    @Override
    public void writeRestore(RestoreRecord record) {
        line("restore", record == null ? "clear" : "write");
    }

    @Override
    public void appendEvent(EngineCommand.PendingEvent event) {
        line("event", JSWriter.stringify(event.node()));
    }

    @Override
    public void emit(EngineCommand.EngineEvent event) {
        line("emit", String.valueOf(event));
        EngineBridge.Records.Listener l = listener;
        if (l != null) {
            try {
                l.onEmit(event);
            } catch (RuntimeException ignored) {
                // The page hearing about it is best effort (§5.4).
            }
        }
    }

    @Override
    public void diag(EngineCommand.DiagEntry entry) {
        line(entry.kind(), JSWriter.stringify(new JsonNode.Obj(entry.fields())));
        rowSeq += 1;
        List<JsonNode.Member> members = new ArrayList<>();
        members.add(JsonNode.member("seq", JsonNode.num(rowSeq)));
        members.add(JsonNode.member("at", JsonNode.num(wallMs.getAsDouble())));
        members.add(JsonNode.member("mono", JsonNode.num(monoMs.getAsDouble())));
        members.add(JsonNode.member("kind", JsonNode.str(entry.kind())));
        for (JsonNode.Member m : entry.fields()) if (!HEADER_KEYS.contains(m.key())) members.add(m);
        JsonNode row = new JsonNode.Obj(members);
        rows.addLast(row);
        while (rows.size() > ROW_CAPACITY) rows.removeFirst();
        EngineBridge.Records.Listener l = listener;
        if (l != null) {
            try {
                l.onRow(row, entry.kind());
            } catch (RuntimeException ignored) {
                // Best effort, as above.
            }
        }
    }

    // ---- EngineBridge.Records

    @Override
    public Map<String, String> sharedRows(List<String> prefixes) {
        Map<String, String> out = new LinkedHashMap<>();
        for (Map.Entry<String, String> e : shared.entrySet()) {
            for (String prefix : prefixes) {
                if (e.getKey().startsWith(prefix)) {
                    out.put(e.getKey(), e.getValue());
                    break;
                }
            }
        }
        return out;
    }

    @Override
    public List<JsonNode> diagnosticRows() {
        return new ArrayList<>(rows);
    }

    /** "Delete my data": every shared row and every ring row, gone. The ring holds rows from here. */
    @Override
    public void purge() {
        shared.clear();
        rows.clear();
        ring.clear();
    }

    @Override
    public void setListener(EngineBridge.Records.Listener listener) {
        this.listener = listener;
    }
}
