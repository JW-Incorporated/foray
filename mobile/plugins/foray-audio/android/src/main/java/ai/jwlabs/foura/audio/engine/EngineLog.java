package ai.jwlabs.foura.audio.engine;

import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.JSWriter;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.RestoreRecord;
import ai.jwlabs.foura.engine.Rows;
import android.util.Log;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import java.util.function.DoubleSupplier;

/**
 * {@link EngineSeams.Output} until A-27 (card A-26): every write is a line, kept in a bounded
 * ring (the service's {@code dump}, read by the native-mode scenario runner and by a device pass)
 * and written to logcat under {@link #TAG}. Nothing is persisted: the position store, the restore
 * record and the pending-event log are A-27's {@code EngineStore}, and the page's diagnostics ring
 * is A-28's bridge.
 *
 * <p>Tokens and numbers only, as every engine row is: an item's id may appear, a URL or a title
 * never does (the core's rows already keep to that; this class adds nothing to them).
 */
public final class EngineLog implements EngineSeams.Output {
    public static final String TAG = "ForayEngine";
    /** How many lines the ring keeps. */
    public static final int CAPACITY = 400;

    private final ArrayDeque<String> ring = new ArrayDeque<>();
    private final DoubleSupplier wallMs;
    private final Consumer<String> sink;
    private int seq;

    /** Logcat, stamped with the wall clock. */
    public EngineLog() {
        this(System::currentTimeMillis, line -> Log.i(TAG, line));
    }

    public EngineLog(DoubleSupplier wallMs, Consumer<String> sink) {
        this.wallMs = wallMs;
        this.sink = sink;
    }

    /** The ring, oldest first. Called on the host's thread. */
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
    }

    @Override
    public void writeRow(Rows.StoredRow row) {
        line("row", String.valueOf(row));
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
    }

    @Override
    public void diag(EngineCommand.DiagEntry entry) {
        line(entry.kind(), JSWriter.stringify(new JsonNode.Obj(entry.fields())));
    }
}
