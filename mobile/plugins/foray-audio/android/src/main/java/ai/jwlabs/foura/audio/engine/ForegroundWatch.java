package ai.jwlabs.foura.audio.engine;

import ai.jwlabs.foura.engine.EngineCommand;
import ai.jwlabs.foura.engine.EngineState;
import ai.jwlabs.foura.engine.JsonNode;
import java.util.ArrayList;
import java.util.List;

/**
 * Card A-65: whether the engine's service LEFT the foreground, and what the engine was doing when
 * it did. The Android half of NE-46's evidence: iOS's risk in a silent seam is a suspended process
 * (the {@code grace kind=late} row), Android's is a {@code MediaSessionService} that Media3 takes out
 * of the foreground because its player stopped saying play-when-ready (a process in a foreground
 * mediaPlayback service is not suspended). The facade keeps saying it through every seam beat and
 * spoken line ({@link EnginePlayer}); this is the row that would show it did not.
 *
 * <p>The service feeds it Media3's own decision ({@code onUpdateNotificationAsync}'s
 * {@code startInForegroundRequired}, the call Media3 makes for every change it publishes). On the
 * step from foreground to not, it writes
 * {@code fgs kind=left foray=y|n running=y|n inSeam=y|n spoken=y|n}. A paused or finished Foray
 * leaving the foreground ten minutes later (Media3's timeout) is {@code running=n}, expected; the
 * row that matters is {@code foray=y running=y}, and {@code inSeam=y} names a silent seam (the
 * seam beat, or a seam's grace span). A-68 reads them.
 *
 * <p>Pure JVM (the shell invariants pin the engine package's host and seams so); not thread-safe:
 * the service calls it on main.
 */
public final class ForegroundWatch {
    private boolean inForeground;

    /** Whether Media3 last said the service runs in the foreground. */
    public boolean inForeground() {
        return inForeground;
    }

    /**
     * Media3's decision for one notification update. Returns the {@code fgs} row to write when the
     * service has just left the foreground with an engine behind it, else null. {@code state} is the
     * engine's (null when there is none, or it is torn down).
     */
    public EngineCommand.DiagEntry onDecision(boolean startInForegroundRequired, EngineState state) {
        boolean was = inForeground;
        inForeground = startInForegroundRequired;
        if (!was || startInForegroundRequired || state == null) return null;
        boolean foray = state.forayId != null;
        boolean running = state.isRunning() || ForayEngineHost.inSeamBeat(state);
        List<JsonNode.Member> fields = new ArrayList<>(5);
        fields.add(JsonNode.member("kind", JsonNode.str("left")));
        fields.add(JsonNode.member("foray", JsonNode.str(foray ? "y" : "n")));
        fields.add(JsonNode.member("running", JsonNode.str(running ? "y" : "n")));
        fields.add(JsonNode.member("inSeam", JsonNode.str(foray && ForayEngineHost.inSilentSeam(state) ? "y" : "n")));
        fields.add(JsonNode.member("spoken", JsonNode.str(state.isNarrationPlayhead() ? "y" : "n")));
        return new EngineCommand.DiagEntry("fgs", fields);
    }
}
