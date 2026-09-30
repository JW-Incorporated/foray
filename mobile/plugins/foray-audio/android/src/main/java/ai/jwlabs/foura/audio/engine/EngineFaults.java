package ai.jwlabs.foura.audio.engine;

/**
 * A MUTATION SEAM for the emulator's fallback scenario (card A-29): a fault the engine can be
 * told to throw at one named point, so CI can prove that a broken native engine falls back to the
 * JS lane rather than to silence.
 *
 * <p>NEVER ARMED IN A RELEASE BUILD. The only thing that arms it is {@code EngineOwnership}, and
 * only when the app is debuggable ({@code ApplicationInfo.FLAG_DEBUGGABLE}), from a key only the
 * debug build's {@code EngineDriveReceiver} writes; shell-invariants pins both. Unarmed,
 * {@link #check} is one volatile read.
 *
 * <p>PURE JVM, so the bridge's JUnit tests arm it directly.
 */
public final class EngineFaults {
    private EngineFaults() {}

    /** The engine throws while answering engineHello (the bridge's native branch). */
    public static final String HELLO = "hello-throws";

    /** The fault the emulator asked for, if any. */
    private static volatile String armed;

    /** What an armed fault throws: a plain unchecked exception, as a real engine bug would. */
    public static final class Injected extends IllegalStateException {
        private static final long serialVersionUID = 1L;

        public Injected(String point) {
            super("injected engine fault: " + point);
        }
    }

    /** Arm {@code fault} (null or anything unknown disarms). */
    public static void arm(String fault) {
        armed = HELLO.equals(fault) ? fault : null;
    }

    /** The armed fault, or null. */
    public static String armed() {
        return armed;
    }

    /** Throw {@link Injected} when {@code point} is the armed fault. */
    public static void check(String point) {
        String a = armed;
        if (a != null && a.equals(point)) throw new Injected(point);
    }
}
