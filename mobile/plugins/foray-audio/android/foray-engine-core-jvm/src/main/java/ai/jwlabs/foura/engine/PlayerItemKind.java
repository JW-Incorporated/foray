package ai.jwlabs.foura.engine;

/**
 * What kind of asset a queue item is (queue-state.js {@code itemRef}'s {@code kind}). A
 * TTS item always plays at 1.0x regardless of the show's rate; an episode plays at the
 * show's rate. The tokens are the generated queue-state.js constants.
 */
public enum PlayerItemKind {
    EPISODE(EngineConstants.QueueState.EPISODE),
    TTS(EngineConstants.QueueState.TTS);

    public final String token;

    PlayerItemKind(String token) {
        this.token = token;
    }

    public static PlayerItemKind of(String token) {
        for (PlayerItemKind k : values()) if (k.token.equals(token)) return k;
        return null;
    }
}
