package ai.jwlabs.foura.audio.engine;

import ai.jwlabs.foura.engine.EngineContract;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * THE LANE'S BUILD-TIME INPUTS on Android (cards A-28 and A-29, docs/plans/android-assessment.md
 * §5.4): the build's default, what it declares, and where the Developer engine setting lives.
 * Pure. The decision itself is {@code EngineMode.decide} (the {@code engine-mode} family, ported by
 * A-29), made once per process by {@link OwnershipCore} with the crash-loop sentinel, the strikes
 * and the sticky pin.
 *
 * <p>SINCE A-31 (the A1 flip) the native lane is the build's default for episodes:
 * {@link #BUILD_DEFAULT_NATIVE} is true and the build declares {@code episode} and
 * {@code continuation}, as mobile/ENGINE_DEFAULT.json's {@code android} block says, and
 * shell-invariants holds the two together. A Foray still relinquishes to the page's player (no
 * {@code foray} until A-42). The Developer engine setting's Web, the crash-loop guard and a
 * terminal relinquish still put a process on the JS player.
 */
public final class EngineLane {
    private EngineLane() {}

    /**
     * mobile/ENGINE_DEFAULT.json {@code android.mode == "native"}: true since A-31. No build step
     * writes it (iOS's plist injector has no Android half); shell-invariants pins this literal to
     * the file instead.
     */
    public static final boolean BUILD_DEFAULT_NATIVE = true;

    /**
     * mobile/ENGINE_DEFAULT.json {@code android.capabilities}: what a native launch of this build
     * DECLARES. The bridge advertises the intersection with what the binary may claim
     * ({@code EngineBridgeRules.ADVERTISED_CAPABILITIES}). Pinned to the file like the mode.
     */
    public static final List<String> DECLARED_CAPABILITIES = Collections.unmodifiableList(Arrays.asList("episode", "continuation"));

    /** Where the Developer engine setting is stored (SharedPreferences), and its key: iOS's names. */
    public static final String PREFS = "ForayEngine";
    public static final String OVERRIDE_KEY = "ForayEngine.modeOverride";

    /** A stored override, read as the JS reads {@code MODE_OVERRIDES.includes(v) ? v : "auto"}. */
    public static String storedOverride(String raw) {
        return raw != null && EngineContract.MODE_OVERRIDES.contains(raw) ? raw : "auto";
    }
}
