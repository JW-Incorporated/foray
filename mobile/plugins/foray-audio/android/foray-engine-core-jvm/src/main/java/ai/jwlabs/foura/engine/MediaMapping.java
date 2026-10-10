package ai.jwlabs.foura.engine;

import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumSet;
import java.util.List;
import java.util.Set;

/**
 * What the lock screen, the notification, the car and the headphones are told, and which
 * of their buttons work: the port of {@code player/media-session.js} (the reference), and
 * the JVM twin of {@code MediaMapping} in ForayEngineCore (Policy/MediaMapping.swift,
 * NE-12s). The {@code media-episode} parity family is the contract; A-23 runs it. The
 * Foray half of the same rules (narration credit, the clip counter, a finished Foray's
 * {@code none}) is ported here too, because it is the same functions, and the
 * {@code media} family that pins it for Forays is A-40's.
 *
 * <p>THE RULES ARE THE JS FILE'S, AND SO ARE THEIR REASONS (title = the episode, artist =
 * the SHOW, album = the Foray plus "clip N of M", or the app's name when there is no
 * collection; "4a" never credits anything a listener hears; a finished Foray shows no transport; the seek pair is the founder's and never the
 * platform's offset; a car scrub with no time is not a seek to zero). This file restates
 * none of them.
 *
 * <p>Java Strings are UTF-16, as JavaScript's are, so {@code startsWith} and {@code charAt}
 * here compare what the JS compares. Only {@code trim} needs spelling out
 * ({@link Rows#isJSWhitespace}): Java's {@code trim} strips every char up to U+0020 and
 * nothing above it, where JS strips U+FEFF, U+00A0 and the Zs set.
 *
 * <p>NO NUMBER HERE IS RETYPED: the seek pair, the state names, the app's name and icon
 * come from the generated {@link EngineConstants.MediaSession}.
 */
public final class MediaMapping {
    private MediaMapping() {}

    // ---- constants, read from the generated file

    /** {@code NONE} / {@code PAUSED} / {@code PLAYING}: the web's {@code playbackState} values. */
    public static final String NONE = EngineConstants.MediaSession.NONE;
    public static final String PAUSED = EngineConstants.MediaSession.PAUSED;
    public static final String PLAYING = EngineConstants.MediaSession.PLAYING;

    /** {@code SEEK_BACKWARD_SEC} / {@code SEEK_FORWARD_SEC}: the founder's pair. */
    public static final double SEEK_BACKWARD_SEC = EngineConstants.MediaSession.SEEK_BACKWARD_SEC;
    public static final double SEEK_FORWARD_SEC = EngineConstants.MediaSession.SEEK_FORWARD_SEC;

    /** {@code APP_ARTWORK_URL} / {@code APP_NAME}. */
    public static final String APP_ARTWORK_URL = EngineConstants.MediaSession.APP_ARTWORK_URL;
    public static final String APP_NAME = EngineConstants.MediaSession.APP_NAME;

    /** What {@code mediaArtworkList} tells the OS about our own icon (media-session.js passes these as the override). */
    static final String APP_ARTWORK_SIZES = "512x512";
    static final String APP_ARTWORK_TYPE = "image/png";

    // ---- artwork

    /** One {@code MediaImage}: {@code {src, sizes?, type?}}. A missing size or type is ABSENT (null), never guessed. */
    public record Artwork(String src, String sizes, String type) {}

    /**
     * {@code artworkUrl(url)}: the one URL gate. {@code https:}, a {@code data:image/} URI,
     * or a relative path; everything else (http, javascript:, protocol-relative, anything
     * with a control character or a space inside) is null.
     */
    public static String artworkUrl(String url) {
        String s = nonEmptyTrimmed(url);
        if (s == null) return null;
        // CONTROL: any code unit from U+0000 to U+0020, or U+007F. Refuse, never strip.
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c <= 0x20 || c == 0x7F) return null;
        }
        if (s.startsWith("//")) return null;
        String scheme = schemeOf(s);
        if (scheme == null) return s;
        if (asciiEqualsIgnoringCase(scheme, "https")) return s;
        if (asciiEqualsIgnoringCase(scheme, "data") && asciiHasPrefixIgnoringCase(s, "data:image/")) return s;
        return null;
    }

    /** {@code mediaArtwork(url, {sizes, type})}: null when the URL may not be used. A blank override is no override. */
    public static Artwork artwork(String url, String sizes, String type) {
        String src = artworkUrl(url);
        if (src == null) return null;
        String s = nonEmptyTrimmed(sizes);
        String t = nonEmptyTrimmed(type);
        return new Artwork(src, s != null ? s : sizesOf(src), t != null ? t : typeOf(src));
    }

    public static Artwork artwork(String url) {
        return artwork(url, null, null);
    }

    /**
     * {@code mediaArtworkList({showArtworkUrl, appArtworkUrl})}: the publisher's square
     * when usable, else our icon, else nothing. Never both: the OS picks by size, so
     * offering both is a coin flip over whose mark shows.
     */
    public static List<Artwork> artworkList(String showArtworkUrl, String appArtworkUrl) {
        Artwork show = artwork(showArtworkUrl);
        if (show != null) return Collections.singletonList(show);
        Artwork app = artwork(appArtworkUrl, APP_ARTWORK_SIZES, APP_ARTWORK_TYPE);
        if (app != null) return Collections.singletonList(app);
        return Collections.emptyList();
    }

    /**
     * {@code sizesOf(url)}: {@code /(?:^|[/_-])(\d{2,4})x(\d{2,4})(?:[^/]*)$/}, the
     * {@code 600x600} Apple encodes in its artwork URLs, or null. Leftmost match, as
     * {@code RegExp.exec} finds it: the first digit run must be WHOLE (2-4 digits then
     * {@code x}); the second takes up to 4 digits and the rest may hold no {@code /}. At
     * index 0 the {@code ^} branch is tried before the delimiter branch.
     */
    static String sizesOf(String u) {
        int n = u.length();
        for (int start = 0; start < n; start++) {
            if (start == 0) {
                String hit = matchDigits(u, 0);
                if (hit != null) return hit;
            }
            char c = u.charAt(start);
            if (c == '/' || c == '_' || c == '-') {
                String hit = matchDigits(u, start + 1);
                if (hit != null) return hit;
            }
        }
        return null;
    }

    private static String matchDigits(String u, int p) {
        int n = u.length();
        int i = p;
        while (i < n && isDigit(u.charAt(i))) i++;
        if (i - p < 2 || i - p > 4 || i >= n || u.charAt(i) != 'x') return null;
        int start2 = i + 1;
        int j = start2;
        while (j < n && j - start2 < 4 && isDigit(u.charAt(j))) j++;
        if (j - start2 < 2 || u.indexOf('/', j) >= 0) return null;
        return u.substring(p, i) + "x" + u.substring(start2, j);
    }

    /**
     * {@code typeOf(url)}: the MIME type a {@code data:image/...} URI names (lower-cased),
     * or the one its path's extension names, or null. Never guessed.
     */
    static String typeOf(String u) {
        // /^data:(image\/[a-z0-9.+-]+)/i
        if (asciiHasPrefixIgnoringCase(u, "data:image/")) {
            int end = 11;
            while (end < u.length() && isMimeChar(u.charAt(end))) end++;
            if (end > 11) return asciiLower(u.substring(5, end));
        }
        // url.split(/[?#]/)[0]
        int cut = u.length();
        for (int i = 0; i < u.length(); i++) {
            if (u.charAt(i) == '?' || u.charAt(i) == '#') {
                cut = i;
                break;
            }
        }
        String path = u.substring(0, cut);
        String[][] table = {
            {".jpg", "image/jpeg"}, {".jpeg", "image/jpeg"}, {".png", "image/png"},
            {".webp", "image/webp"}, {".gif", "image/gif"}, {".svg", "image/svg+xml"},
        };
        for (String[] row : table) if (asciiHasSuffixIgnoringCase(path, row[0])) return row[1];
        return null;
    }

    // ---- metadata

    /** A queue item as the mapping reads it. A null field is what {@code typeof s === "string"} rejects. */
    public record Item(String kind, String title, String show) {}

    /** The three strings and the artwork list. */
    public record Metadata(String title, String artist, String album, List<Artwork> artwork) {
        public Metadata {
            artwork = Collections.unmodifiableList(new ArrayList<>(artwork));
        }
    }

    /**
     * {@code narrationCredit({forayTitle, nextItem})}: the artist for a line WE wrote
     * (narration, a jingle). The Foray's title, then the next item's episode title, then
     * its show, then "". NEVER the app's name.
     */
    public static String narrationCredit(String forayTitle, Item nextItem) {
        return orIfEmpty(orIfEmpty(clean(forayTitle), clean(nextItem == null ? null : nextItem.title())),
                clean(nextItem == null ? null : nextItem.show()));
    }

    /**
     * {@code mediaMetadata({item, nextItem, forayTitle, index, total, showArtworkUrl,
     * appArtworkUrl})}. Pure and total; nothing is ever fabricated (a missing show is an
     * empty artist). {@code index} / {@code total} null: not numbers at all. The JS
     * defaults (0, 0, "", our icon) apply only when a value is ABSENT, which is the
     * caller's to decide ({@link View}).
     */
    public static Metadata metadata(Item item, Item nextItem, String forayTitle, Double index, Double total,
                                    String showArtworkUrl, String appArtworkUrl) {
        String foray = clean(forayTitle);
        String kind = item == null ? null : item.kind();
        boolean jingle = EngineConstants.ForayQueue.JINGLE.equals(kind);
        boolean narration = EngineConstants.QueueState.TTS.equals(kind) || jingle;

        String title;
        String artist;
        if (jingle) {
            title = orIfEmpty(foray, APP_NAME);
            artist = narrationCredit(foray, nextItem);
        } else if (narration) {
            String upNext = clean(nextItem == null ? null : nextItem.title());
            // "Up next: <episode>", verbatim from 04_VOICE_AUDIO_SPEC.md; never the line's own slug id.
            title = upNext.isEmpty() ? orIfEmpty(foray, APP_NAME) : "Up next: " + upNext;
            artist = narrationCredit(foray, nextItem);
        } else {
            title = orIfEmpty(orIfEmpty(clean(item == null ? null : item.title()), foray), APP_NAME);
            artist = clean(item == null ? null : item.show());
        }
        // A narration line is ours; a publisher's square does not belong on it.
        return new Metadata(title, artist, albumOf(foray, index, total),
                artworkList(narration ? null : showArtworkUrl, appArtworkUrl));
    }

    /**
     * {@code albumOf(forayTitle, index, total)}: "The history of grilling · clip 12 of 32",
     * worded exactly as the mini bar words it. The counter needs a non-negative integer
     * index and a positive integer total; an index past the end reads as the last clip.
     * With neither a title nor a counter it is {@code APP_NAME}, never "" (issue #1006).
     */
    static String albumOf(String forayTitle, Double index, Double total) {
        String counter = "";
        if (index != null && total != null && JSMath.isInteger(index) && index >= 0 && JSMath.isInteger(total) && total > 0) {
            counter = "clip " + JSWriter.numberToString(Math.min(index, total - 1) + 1) + " of " + JSWriter.numberToString(total);
        }
        if (!forayTitle.isEmpty() && !counter.isEmpty()) return forayTitle + " · " + counter;
        if (!forayTitle.isEmpty()) return forayTitle;
        // `n.charAt(0).toUpperCase() + n.slice(1)`: the counter alone is a sentence.
        if (!counter.isEmpty()) return "C" + counter.substring(1);
        return APP_NAME;
    }

    // ---- position and playback state

    /** A {@code MediaPositionState}, in the clock the caller reports (the episode's, or the whole Foray's). */
    public record PositionState(double duration, double position, double playbackRate) {}

    /**
     * {@code mediaPositionState({durationSec, positionSec, playbackRate, buffering})}: null
     * when there is no finite positive duration ("do not report"); otherwise the position
     * clamped into {@code [0, duration]} and a rate that is a finite positive number or 1.
     * A null argument is "not a number", which every JS branch treats as its default. A
     * STALL STOPS THE CLOCK: while {@code buffering} the rate is 0.
     */
    public static PositionState positionState(Double durationSec, Double positionSec, Double playbackRate, boolean buffering) {
        Double duration = finite(durationSec);
        if (duration == null || !(duration > 0)) return null;
        Double raw = finite(positionSec);
        double r0 = raw == null ? 0 : raw;
        // Math.min(Math.max(0, raw), duration), written out so a -0 position is +0.
        double low = r0 > 0 ? r0 : 0;
        double position = low < duration ? low : duration;
        Double r = finite(playbackRate);
        double rate = r != null && r > 0 ? r : 1;
        return new PositionState(duration, position, buffering ? 0 : rate);
    }

    /**
     * {@code mediaPlaybackState({hasItem, playing, inSeamGap, ended, foray})}. A finished
     * FORAY is {@code none} (a play button that can do nothing is worse than none); a
     * finished EPISODE is {@code paused} (play from ended starts it over). The seam beat
     * reads as playing.
     */
    public static String playbackState(boolean hasItem, boolean playing, boolean inSeamGap, boolean ended, boolean foray) {
        if (!hasItem) return NONE;
        if (ended) return foray ? NONE : PAUSED;
        if (playing || inSeamGap) return PLAYING;
        return PAUSED;
    }

    // ---- the whole view

    /**
     * {@code mediaSessionView(view)}'s input: every live value, gathered by the caller,
     * decided here. The field initialisers are the JS parameter defaults, which apply to an
     * ABSENT value only.
     */
    public static final class View {
        public Item item;
        public Item nextItem;
        public String forayTitle = "";
        public Double index = 0.0;
        public Double total = 0.0;
        public String showArtworkUrl;
        public String appArtworkUrl = APP_ARTWORK_URL;
        public Double durationSec;
        public Double positionSec = 0.0;
        public Double playbackRate = 1.0;
        /** The element is halted for data: the clock reports rate 0. */
        public boolean buffering;
        public boolean playing;
        public boolean inSeamGap;
        public boolean ended;
        /** The item is a Foray, whose end reports {@code none} (an episode's, {@code paused}). */
        public boolean foray;
    }

    /**
     * {@code mediaSessionView(view)}'s three members, and {@code buffering}: the view's own flag,
     * carried as is (CH3-22, R5-08). The JS and Swift views report a stall only through the rate
     * (a browser's and iOS's Now Playing have nothing else to say it with); Media3 has a BUFFERING
     * state, and the Android facade ({@code EnginePlayer}) reads it from HERE, the one derivation
     * ({@code EngineCore.mediaView}: the stall latch or a load in flight), never from the rate,
     * which an item with no known duration does not report. Parity compares the three JS members
     * only ({@code MediaEpisodeFamily}).
     */
    public record SessionView(Metadata metadata, PositionState positionState, String playbackState, boolean buffering) {}

    /** {@code mediaSessionView(view)}, plus the view's {@code buffering}. */
    public static SessionView sessionView(View v) {
        return new SessionView(
                metadata(v.item, v.nextItem, v.forayTitle, v.index, v.total, v.showArtworkUrl, v.appArtworkUrl),
                positionState(v.durationSec, v.positionSec, v.playbackRate, v.buffering),
                playbackState(v.item != null, v.playing, v.inSeamGap, v.ended, v.foray),
                false);
    }

    // ---- remote commands: which exist, and what a press means

    /**
     * Which intents the listener can reach right now: {@code mediaSessionActions}'s
     * {@code surface}, as flags. An absent intent is a button NOT offered, never one that
     * silently does nothing.
     */
    public static final class Surface {
        public boolean play;
        public boolean pause;
        public boolean stop;
        public boolean next;
        public boolean previous;
        public boolean seekBy;
        public boolean seekTo;
    }

    /** The step a skip press takes: the founder's pair unless a surface says otherwise. The PLATFORM's offset is never an input. */
    public record SeekSteps(double backwardSec, double forwardSec) {
        public static final SeekSteps DEFAULT = new SeekSteps(SEEK_BACKWARD_SEC, SEEK_FORWARD_SEC);
    }

    /**
     * What a press carries that the mapping reads: {@code details.seekTime} (null when not
     * a number) and whether {@code details.close === true}. {@code seekOffset} is
     * deliberately NOT a field: the head unit's step is data about the press, never an order.
     */
    public record PressDetails(Double seekTime, boolean close) {
        public static final PressDetails NONE = new PressDetails(null, false);
    }

    /** What a press turns into: one call on the surface. */
    public sealed interface Intent permits Intent.Play, Intent.Pause, Intent.Stop, Intent.Previous, Intent.Next,
            Intent.SeekBy, Intent.SeekTo {
        record Play() implements Intent {}

        record Pause() implements Intent {}

        /** {@code close}: the Android notification's Stop, the one stop that may tear the player down. */
        record Stop(boolean close) implements Intent {}

        record Previous() implements Intent {}

        record Next() implements Intent {}

        record SeekBy(double offset) implements Intent {}

        record SeekTo(double position) implements Intent {}
    }

    /** {@code mediaSessionActions(surface)}'s action list, in {@code MEDIA_ACTIONS} order: installed exactly when its intent exists. */
    public static List<MediaAction> installedActions(Surface surface) {
        List<MediaAction> out = new ArrayList<>();
        if (surface.play) out.add(MediaAction.PLAY);
        if (surface.pause) out.add(MediaAction.PAUSE);
        if (surface.stop) out.add(MediaAction.STOP);
        if (surface.previous) out.add(MediaAction.PREVIOUS_TRACK);
        if (surface.next) out.add(MediaAction.NEXT_TRACK);
        if (surface.seekBy) {
            out.add(MediaAction.SEEK_BACKWARD);
            out.add(MediaAction.SEEK_FORWARD);
        }
        if (surface.seekTo) out.add(MediaAction.SEEK_TO);
        return out;
    }

    /**
     * The handler {@code mediaSessionActions} installs for {@code action}, pressed with
     * {@code details}: the intent it issues, or null when the press is ignored (a
     * {@code seekto} with no usable time is not a seek to zero). Only ever asked for an
     * INSTALLED action.
     */
    public static Intent intent(MediaAction action, PressDetails details, SeekSteps steps) {
        return switch (action) {
            case PLAY -> new Intent.Play();
            case PAUSE -> new Intent.Pause();
            case STOP -> new Intent.Stop(details.close());
            case PREVIOUS_TRACK -> new Intent.Previous();
            case NEXT_TRACK -> new Intent.Next();
            case SEEK_BACKWARD -> new Intent.SeekBy(-steps.backwardSec());
            case SEEK_FORWARD -> new Intent.SeekBy(steps.forwardSec());
            case SEEK_TO -> {
                // `!isNum(t) || t < 0` ignores it; -0 is not < 0, so it seeks to 0.
                Double t = finite(details.seekTime());
                yield t == null || t < 0 ? null : new Intent.SeekTo(t);
            }
        };
    }

    // ---- command enablement from the engine's snapshot (NP-5)

    /** The Snapshot v1 fields (plan §5.3) that decide which remote commands work. */
    public record CommandSnapshot(Mode mode, boolean ended, boolean canNext, boolean canPrevious, boolean autoAdvance) {
        /** Snapshot v1 {@code mode}; {@code "none"} (nothing loaded) is spelled UNLOADED. */
        public enum Mode {
            UNLOADED("none"),
            EPISODE("episode"),
            FORAY("foray");

            public final String token;

            Mode(String token) {
                this.token = token;
            }
        }
    }

    /** The remote commands the engine registers (the MPRemoteCommandCenter set; Media3's player commands on Android, A-26). */
    public enum RemoteCommand {
        PLAY, PAUSE, TOGGLE_PLAY_PAUSE, NEXT_TRACK, PREVIOUS_TRACK, SKIP_BACKWARD, SKIP_FORWARD, CHANGE_PLAYBACK_POSITION, STOP
    }

    /** Which commands are enabled, the skip intervals to advertise, and whether Now Playing is cleared. */
    public record CommandAvailability(Set<RemoteCommand> enabled, double skipBackwardIntervalSec, double skipForwardIntervalSec,
                                      boolean clearsNowPlaying) {
        public CommandAvailability {
            enabled = Collections.unmodifiableSet(enabled.isEmpty() ? EnumSet.noneOf(RemoteCommand.class) : EnumSet.copyOf(enabled));
        }

        public boolean isEnabled(RemoteCommand command) {
            return enabled.contains(command);
        }
    }

    /**
     * {@code commandAvailability(snapshot, trackRoute)}: NP-5. The episode surface is the
     * page's: play, pause, the seek pair and a scrub always; next / previous exactly when the
     * engine has a neighbour AND the route has a track button ({@code trackRoute}: the
     * 2026-09-23 ruling, "the track pair only where a track button exists", held in the core
     * for both platforms since CH3-10). The Android host passes true: its notification and
     * Android Auto draw both pairs side by side (code-health-3 founder question 3, on its
     * default; #1163). It goes through {@link #installedActions}, the SAME table the fixtures
     * pin, and the {@code media-episode} family's {@code availability-*} cases pin this
     * function itself. Stop is registered and ALWAYS disabled (a remote stop is a pause).
     * Toggle works exactly when play and pause both do. Everything is disabled and Now
     * Playing cleared ONLY when nothing is loaded or a Foray has finished.
     */
    public static CommandAvailability commandAvailability(CommandSnapshot snapshot, SeekSteps steps, boolean trackRoute) {
        boolean finished = snapshot.mode() == CommandSnapshot.Mode.UNLOADED
                || (snapshot.mode() == CommandSnapshot.Mode.FORAY && snapshot.ended());
        if (finished) {
            return new CommandAvailability(EnumSet.noneOf(RemoteCommand.class), steps.backwardSec(), steps.forwardSec(), true);
        }
        Surface surface = new Surface();
        surface.play = true;
        surface.pause = true;
        surface.next = snapshot.canNext() && trackRoute;
        surface.previous = snapshot.canPrevious() && trackRoute;
        surface.seekBy = true;
        surface.seekTo = true;
        List<MediaAction> installed = installedActions(surface);
        Set<RemoteCommand> enabled = EnumSet.noneOf(RemoteCommand.class);
        if (installed.contains(MediaAction.PLAY)) enabled.add(RemoteCommand.PLAY);
        if (installed.contains(MediaAction.PAUSE)) enabled.add(RemoteCommand.PAUSE);
        if (installed.contains(MediaAction.PLAY) && installed.contains(MediaAction.PAUSE)) enabled.add(RemoteCommand.TOGGLE_PLAY_PAUSE);
        if (installed.contains(MediaAction.NEXT_TRACK)) enabled.add(RemoteCommand.NEXT_TRACK);
        if (installed.contains(MediaAction.PREVIOUS_TRACK)) enabled.add(RemoteCommand.PREVIOUS_TRACK);
        if (installed.contains(MediaAction.SEEK_BACKWARD)) enabled.add(RemoteCommand.SKIP_BACKWARD);
        if (installed.contains(MediaAction.SEEK_FORWARD)) enabled.add(RemoteCommand.SKIP_FORWARD);
        if (installed.contains(MediaAction.SEEK_TO)) enabled.add(RemoteCommand.CHANGE_PLAYBACK_POSITION);
        return new CommandAvailability(enabled, steps.backwardSec(), steps.forwardSec(), false);
    }

    // ---- JavaScript string and number semantics

    /** {@code typeof s === "string" && s.trim().length > 0 ? s.trim() : null}. */
    static String nonEmptyTrimmed(String value) {
        if (value == null) return null;
        String trimmed = jsTrim(value);
        return trimmed.isEmpty() ? null : trimmed;
    }

    /** media-session.js {@code clean(s)}: trimmed, or "". */
    static String clean(String value) {
        String t = nonEmptyTrimmed(value);
        return t == null ? "" : t;
    }

    /** {@code String.prototype.trim}: ECMAScript WhiteSpace and LineTerminator from both ends, and nothing else. */
    static String jsTrim(String value) {
        int start = 0;
        int end = value.length();
        while (start < end && Rows.isJSWhitespace(value.charAt(start))) start++;
        while (end > start && Rows.isJSWhitespace(value.charAt(end - 1))) end--;
        return value.substring(start, end);
    }

    /** {@code /^([a-zA-Z][a-zA-Z0-9+.-]*):/}'s capture, or null. */
    static String schemeOf(String u) {
        if (u.isEmpty() || !isAsciiLetter(u.charAt(0))) return null;
        int i = 1;
        while (i < u.length()) {
            char c = u.charAt(i);
            if (!(isAsciiLetter(c) || isDigit(c) || c == '+' || c == '.' || c == '-')) break;
            i++;
        }
        return i < u.length() && u.charAt(i) == ':' ? u.substring(0, i) : null;
    }

    static boolean isDigit(char c) {
        return c >= '0' && c <= '9';
    }

    static boolean isAsciiLetter(char c) {
        return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
    }

    /** {@code [a-z0-9.+-]} under the {@code i} flag: ASCII only (ECMA-262 Canonicalize never maps a non-ASCII unit into it). */
    static boolean isMimeChar(char c) {
        return isAsciiLetter(c) || isDigit(c) || c == '.' || c == '+' || c == '-';
    }

    static char asciiLower(char c) {
        return c >= 'A' && c <= 'Z' ? (char) (c + 0x20) : c;
    }

    static String asciiLower(String s) {
        StringBuilder out = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) out.append(asciiLower(s.charAt(i)));
        return out.toString();
    }

    static boolean asciiEqualsIgnoringCase(String u, String ascii) {
        if (u.length() != ascii.length()) return false;
        for (int i = 0; i < u.length(); i++) if (asciiLower(u.charAt(i)) != asciiLower(ascii.charAt(i))) return false;
        return true;
    }

    static boolean asciiHasPrefixIgnoringCase(String u, String ascii) {
        return u.length() >= ascii.length() && asciiEqualsIgnoringCase(u.substring(0, ascii.length()), ascii);
    }

    static boolean asciiHasSuffixIgnoringCase(String u, String ascii) {
        return u.length() >= ascii.length() && asciiEqualsIgnoringCase(u.substring(u.length() - ascii.length()), ascii);
    }

    /** {@code Number.isFinite}: the value, or null. */
    static Double finite(Double value) {
        return value != null && Rows.isFinite(value) ? value : null;
    }

    /** JavaScript's {@code a || b} for two strings: {@code b} when {@code a} is empty. */
    static String orIfEmpty(String a, String b) {
        return a.isEmpty() ? b : a;
    }
}
