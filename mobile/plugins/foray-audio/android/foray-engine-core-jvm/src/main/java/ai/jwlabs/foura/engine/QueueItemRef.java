package ai.jwlabs.foura.engine;

import java.util.Objects;

/**
 * A minimal, opaque reference to a queue item: queue-state.js {@code itemRef(id, kind,
 * bounds)}, the JVM twin of {@code QueueItemRef} in ForayEngineCore
 * (Reducer/PlayerQueueState.swift). {@code bounds} is null for an ordinary unbounded item.
 */
public record QueueItemRef(String id, PlayerItemKind kind, ItemBounds bounds) {
    public QueueItemRef {
        Objects.requireNonNull(id, "id");
        Objects.requireNonNull(kind, "kind");
    }

    public QueueItemRef(String id, PlayerItemKind kind) {
        this(id, kind, null);
    }

    /**
     * queue-state.js {@code sameRef}: identity INCLUDES the bounds, and that is
     * load-bearing: two segments of one episode are two queue items over one source, and
     * every "is this the thing I am already doing?" guard in the reducer would otherwise
     * drop the second as a repeat of the first. Spelled out field by field, as the JS is.
     */
    public static boolean sameRef(QueueItemRef a, QueueItemRef b) {
        if (a == null || b == null) return a == null && b == null;
        return a.id.equals(b.id) && a.kind == b.kind && Objects.equals(a.bounds, b.bounds);
    }
}
