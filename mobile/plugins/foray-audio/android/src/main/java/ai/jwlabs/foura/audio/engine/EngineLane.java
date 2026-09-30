package ai.jwlabs.foura.audio.engine;

import ai.jwlabs.foura.engine.EngineContract;
import ai.jwlabs.foura.engine.Vocabulary;
import java.util.Collections;
import java.util.List;

/**
 * WHICH LANE AN ANDROID PROCESS PLAYS THROUGH (card A-28, docs/plans/android-assessment.md §5.4),
 * before ownership: the build's default and the Developer engine setting, and nothing else. Pure.
 *
 * <p>WHAT IS NOT HERE, AND WHY IT IS SAFE WITHOUT IT. iOS decides with {@code decideEngineMode}
 * (the {@code engine-mode} family): a crash-loop sentinel that pins a build to legacy after three
 * strikes, and the hello watchdog. Those are A-29's ("ownership and fallback"), which ports that
 * family and replaces {@link #decide} with it. Until then the native lane is reached ONLY through
 * the Developer override: {@link #BUILD_DEFAULT_NATIVE} is false, as mobile/ENGINE_DEFAULT.json's
 * {@code android} block says ({@code "mode": "js"} until A-31), and shell-invariants holds the two
 * together. A listener who never opened the Developer drawer runs the JS player, exactly as before
 * A-28.
 */
public final class EngineLane {
    private EngineLane() {}

    /**
     * mobile/ENGINE_DEFAULT.json {@code android.mode == "native"}: false until A-31 flips both. No
     * build step writes it (iOS's plist injector has no Android half yet); shell-invariants pins
     * this literal to the file instead.
     */
    public static final boolean BUILD_DEFAULT_NATIVE = false;

    /**
     * mobile/ENGINE_DEFAULT.json {@code android.capabilities}: what a native launch of this build
     * DECLARES. The bridge advertises the intersection with what the binary may claim
     * ({@code EngineBridgeRules.ADVERTISED_CAPABILITIES}). Pinned to the file like the mode.
     */
    public static final List<String> DECLARED_CAPABILITIES = Collections.emptyList();

    /** Where the Developer engine setting is stored (SharedPreferences), and its key: iOS's names. */
    public static final String PREFS = "ForayEngine";
    public static final String OVERRIDE_KEY = "ForayEngine.modeOverride";

    /** A stored override, read as the JS reads {@code MODE_OVERRIDES.includes(v) ? v : "auto"}. */
    public static String storedOverride(String raw) {
        return raw != null && EngineContract.MODE_OVERRIDES.contains(raw) ? raw : "auto";
    }

    /**
     * The lane: the override when it names one ({@code native} or {@code web}), else the build's
     * default, each with the reason a hello reports.
     */
    public static EngineBridge.Decision decide(boolean buildDefaultNative, String rawOverride) {
        String override = storedOverride(rawOverride);
        if (override.equals("native")) return new EngineBridge.Decision(EngineContract.MODE_NATIVE, Vocabulary.ModeReason.OVERRIDE);
        if (override.equals("web")) return new EngineBridge.Decision(EngineContract.MODE_LEGACY, Vocabulary.ModeReason.OVERRIDE);
        return new EngineBridge.Decision(buildDefaultNative ? EngineContract.MODE_NATIVE : EngineContract.MODE_LEGACY,
                Vocabulary.ModeReason.BUILD_DEFAULT);
    }
}
