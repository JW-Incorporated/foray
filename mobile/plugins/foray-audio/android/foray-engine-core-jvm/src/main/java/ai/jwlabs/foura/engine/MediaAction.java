package ai.jwlabs.foura.engine;

/**
 * An OS remote action, spelled as {@code MEDIA_ACTIONS} spells it and declared in that
 * order: {@code values()} IS the install order (the {@code media-actions-vocabulary}
 * case reads it from here, and a JUnit test pins it against the generated constant). The
 * JVM twin of {@code MediaAction} in ForayEngineCore (Policy/MediaMapping.swift).
 */
public enum MediaAction {
    PLAY("play"),
    PAUSE("pause"),
    STOP("stop"),
    PREVIOUS_TRACK("previoustrack"),
    NEXT_TRACK("nexttrack"),
    SEEK_BACKWARD("seekbackward"),
    SEEK_FORWARD("seekforward"),
    SEEK_TO("seekto");

    public final String token;

    MediaAction(String token) {
        this.token = token;
    }

    public static MediaAction of(String token) {
        for (MediaAction a : values()) if (a.token.equals(token)) return a;
        return null;
    }
}
