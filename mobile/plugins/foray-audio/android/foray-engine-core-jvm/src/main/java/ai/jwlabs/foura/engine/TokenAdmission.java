package ai.jwlabs.foura.engine;

import java.util.List;

/**
 * A diagnostics row admits a token only through the closed sets of {@link Vocabulary}
 * (generated from player/engine-vocabulary.js; card A-28 ports admission with the bridge,
 * whose rows are the first the page reads from the Android engine). The JVM twin of the Swift
 * {@code Vocabulary.admit(_:into:)}, held to engine-vocabulary.js {@code admitToken} by the
 * {@code diag-tokens} family.
 *
 * <p>Hand-written beside the generated {@link Vocabulary}, which gen-constants.mjs rewrites
 * whole: the data is generated, admission is a rule.
 */
public final class TokenAdmission {
    private TokenAdmission() {}

    /** A set name no closed vocabulary has: a bug in the caller (the JS throws a RangeError). */
    public static final class UnknownSet extends IllegalArgumentException {
        private static final long serialVersionUID = 1L;

        public UnknownSet(String set) {
            super("no closed vocabulary named " + (set == null ? "null" : JSWriter.quote(set)));
        }
    }

    /**
     * {@code admitToken(set, token)}: the token when it is exactly one of the set's (no case
     * folding, no trimming, no dashed-for-camel guessing), else null. {@code set} null or unknown
     * throws {@link UnknownSet}.
     */
    public static String admit(String token, String set) {
        List<String> tokens = set == null ? null : Vocabulary.SETS.get(set);
        if (tokens == null) throw new UnknownSet(set);
        return token != null && tokens.contains(token) ? token : null;
    }
}
