package ai.jwlabs.foura.engine.parity;

/**
 * A CASE is malformed, as opposed to the rule under test throwing. The codes are the
 * closed {@code $defs.harnessError} enum of player/parity/schema/fixture.schema.json,
 * the ones the JS runner (player/parity/codec.js) and the Swift one raise, so a broken
 * fixture reports the same code in all three runtimes.
 */
public final class HarnessError extends RuntimeException {
    private static final long serialVersionUID = 1L;

    private final String code;

    public HarnessError(String code, String message) {
        super(code + ": " + message);
        this.code = code;
    }

    public String code() {
        return code;
    }
}
