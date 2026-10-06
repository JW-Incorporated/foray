package ai.jwlabs.foura.engine;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * What the engine answers to {@code engineHello} (docs/native-engine-plan.md §5.1).
 *
 * <p>The JVM twin of {@code EngineHandshake} in ForayEngineCore
 * (mobile/plugins/foray-audio/foray-engine-core/Sources/ForayEngineCore/EngineHandshake.swift).
 * As that type was for NE-01, it is the whole of the core for now, because A-21 is a
 * packaging spike. It proves four things: the module compiles as pure Java 21,
 * {@code cap add android} links it into the app, JUnit runs it on a plain JVM, and
 * D8 dexes a sealed interface, a record and a record-pattern {@code switch} into the
 * APK. The parity runner (A-22) and the ported policies (A-23 on) come in their own
 * cards.
 *
 * <p>Nothing calls it on Android yet: {@code engineHello} is not answered there until
 * A-28 (docs/plans/android-assessment.md), and {@code mobile/ENGINE_DEFAULT.json} keeps
 * Android on {@code js} until A-31 flips it.
 *
 * <p>{@code js} there and {@code NOT_BUILT_MODE}'s {@code legacy} here are the same lane
 * (as is the Developer override's {@code web}): the JS player in the page. They are wire and
 * file values, never renamed to match: {@code legacy} is never written into
 * ENGINE_DEFAULT.json (the injector accepts only {@code js} or {@code native}), and
 * {@code js} is never a hello answer. The glossary is the "ONE LANE, THREE NAMES" paragraph
 * beside {@code ENGINE_MODES} in {@code player/engine-contract.js}.
 */
public final class EngineHandshake {
    private EngineHandshake() {}

    /** Protocol v1 of the web-to-native contract (§5). Same value as the Swift core. */
    public static final int PROTOCOL_VERSION = 1;

    /** The answer's {@code mode} while no engine is built (§4.6). */
    public static final String NOT_BUILT_MODE = "legacy";

    /** The answer's {@code reason} while no engine is built. */
    public static final String NOT_BUILT_REASON = "not-built";

    /**
     * An answer to {@code engineHello}. Sealed, so javac checks every {@code switch}
     * over it for exhaustiveness: the JVM spelling of a Swift enum with associated
     * values, which is the shape most of the core's types take.
     */
    public sealed interface Hello permits Hello.NotBuilt {
        /** {@code {mode: "legacy", reason: "not-built"}}: the stub answer until the engine exists. */
        record NotBuilt(String mode, String reason) implements Hello {}
    }

    /** The stub answer: the counterpart of the Swift core's {@code notBuiltHello()}. */
    public static Hello notBuilt() {
        return new Hello.NotBuilt(NOT_BUILT_MODE, NOT_BUILT_REASON);
    }

    /**
     * The answer as the plain string map the plugin copies across the bridge. A map,
     * not Capacitor's {@code JSObject}, so the core stays free of Capacitor.
     * Insertion-ordered and unmodifiable, and built without {@code Map.of}, which is
     * API 30 when this app's minSdk is 24.
     */
    public static Map<String, String> toWire(Hello hello) {
        Map<String, String> out = new LinkedHashMap<>();
        switch (hello) {
            case Hello.NotBuilt(String mode, String reason) -> {
                out.put("mode", mode);
                out.put("reason", reason);
            }
        }
        return Collections.unmodifiableMap(out);
    }
}
