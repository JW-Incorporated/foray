package ai.jwlabs.foura.engine.parity;

import static ai.jwlabs.foura.engine.parity.JsArgs.arg;
import static ai.jwlabs.foura.engine.parity.JsArgs.at;
import static ai.jwlabs.foura.engine.parity.JsArgs.obj;
import static ai.jwlabs.foura.engine.parity.JsArgs.truthy;

import ai.jwlabs.foura.engine.MediaAction;
import ai.jwlabs.foura.engine.MediaMapping;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Call;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Outcome;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Returned;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Threw;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BiFunction;
import java.util.function.Function;

/**
 * The {@code media-episode} family against {@link MediaMapping} (A-23): the lock-screen
 * mapping and the remote-command table recorded from {@code player/media-session.js}. The
 * JVM twin of the Swift MediaEpisodeFamily.
 *
 * <p>TWO FIXTURE FILES, TWO JS MODULES, ONE FAMILY. {@code media-mapping.json} calls
 * media-session.js directly. {@code media-actions.json} goes through the harness adapter
 * {@code player/parity/media-actions.js}, because {@code mediaSessionActions} answers with
 * FUNCTIONS no fixture can hold: the adapter installs a recording surface, presses
 * buttons, and returns {@code {installed, calls}}. This runner is that adapter's JVM half.
 *
 * <p>The adapter's second call, {@code commandAvailability(snapshot, trackRoute)} (CH3-10),
 * is authored there from docs/DECISIONS.md 2026-09-23 rather than recorded from a page
 * module; here it is {@link MediaMapping#commandAvailability} with the default seek steps,
 * written as the adapter writes it ({@code enabled} in {@code RemoteCommand} order,
 * {@code clearsNowPlaying}).
 *
 * <p>TRANSLATION, NEVER DECISION:
 * <pre>
 *   {...} = {}          an absent argument is {}; null THROWS a TypeError (destructuring null)
 *   x = default         the default applies to undefined ONLY: an explicit null index is
 *                       "not a number", not 0
 *   typeof s === "string" / isNum   a value of any other type is null in the typed port
 *   Boolean(view.x)     JavaScript truthiness
 * </pre>
 */
final class MediaEpisodeFamily {
    private MediaEpisodeFamily() {}

    static final String FAMILY = "media-episode";
    static final String MAPPING_MODULE = "player/media-session.js";
    static final String ACTIONS_MODULE = "player/parity/media-actions.js";

    /** media-actions.js's {@code SURFACE_METHODS}: the closed set a case may name. */
    static final List<String> SURFACE_METHODS = Arrays.asList("play", "pause", "stop", "next", "previous", "seekBy", "seekTo");

    private static final Outcome TYPE_ERROR = new Threw("TypeError");

    /**
     * {@code installedActions} and {@code commandAvailability} are injectable for ONE reason:
     * so a test can hand the fixtures a mutant rule ("next is offered with no next", "the
     * track route is ignored") and watch a case go red.
     */
    static FamilyRunner runner(Function<MediaMapping.Surface, List<MediaAction>> installedActions,
                               BiFunction<MediaMapping.CommandSnapshot, Boolean, MediaMapping.CommandAvailability> commandAvailability) {
        return new FamilyRunner.MultiModule(FAMILY, List.of(mappingRunner(), actionsRunner(installedActions, commandAvailability)));
    }

    static FamilyRunner runner(Function<MediaMapping.Surface, List<MediaAction>> installedActions) {
        return runner(installedActions, MediaEpisodeFamily::availability);
    }

    static FamilyRunner runnerWithAvailability(
            BiFunction<MediaMapping.CommandSnapshot, Boolean, MediaMapping.CommandAvailability> commandAvailability) {
        return runner(MediaMapping::installedActions, commandAvailability);
    }

    /** The real rule, with the default steps the adapter's call never overrides. */
    static MediaMapping.CommandAvailability availability(MediaMapping.CommandSnapshot snapshot, Boolean trackRoute) {
        return MediaMapping.commandAvailability(snapshot, MediaMapping.SeekSteps.DEFAULT, trackRoute);
    }

    static FamilyRunner runner() {
        return runner(MediaMapping::installedActions);
    }

    // ---- media-session.js

    static FamilyRunner.Pure mappingRunner() {
        Map<String, Json> reads = new LinkedHashMap<>();
        reads.put("NONE", Json.str(MediaMapping.NONE));
        reads.put("PAUSED", Json.str(MediaMapping.PAUSED));
        reads.put("PLAYING", Json.str(MediaMapping.PLAYING));
        reads.put("SEEK_BACKWARD_SEC", Json.num(MediaMapping.SEEK_BACKWARD_SEC));
        reads.put("SEEK_FORWARD_SEC", Json.num(MediaMapping.SEEK_FORWARD_SEC));
        reads.put("APP_ARTWORK_URL", Json.str(MediaMapping.APP_ARTWORK_URL));
        reads.put("APP_NAME", Json.str(MediaMapping.APP_NAME));
        // From the port's own enum, not the generated constant: the case pins the order the port INSTALLS in.
        List<String> actions = new ArrayList<>();
        for (MediaAction a : MediaAction.values()) actions.add(a.token);
        reads.put("MEDIA_ACTIONS", JsArgs.strings(actions));

        Map<String, Call> calls = new LinkedHashMap<>();
        calls.put("artworkUrl", args -> new Returned(JsArgs.stringOrNull(MediaMapping.artworkUrl(arg(args, 0).asString()))));
        calls.put("mediaArtwork", args -> {
            // `artworkUrl(url)` runs first and a refused URL returns before `over` is touched,
            // so `over = null` only throws for a good URL.
            String url = arg(args, 0).asString();
            if (MediaMapping.artworkUrl(url) == null) return new Returned(Json.NULL);
            Json over = arg(args, 1);
            if (JsArgs.isNull(over)) return TYPE_ERROR;
            MediaMapping.Artwork art = MediaMapping.artwork(url, at(over, "sizes").asString(), at(over, "type").asString());
            return new Returned(art == null ? Json.NULL : encode(art));
        });
        calls.put("mediaArtworkList", args -> {
            Json options = arg(args, 0);
            if (JsArgs.isNull(options)) return TYPE_ERROR;
            List<Json> out = new ArrayList<>();
            for (MediaMapping.Artwork a : MediaMapping.artworkList(at(options, "showArtworkUrl").asString(), appArtwork(options))) {
                out.add(encode(a));
            }
            return new Returned(new Json.Arr(out));
        });
        calls.put("mediaMetadata", args -> {
            Json view = arg(args, 0);
            if (JsArgs.isNull(view)) return TYPE_ERROR;
            MediaMapping.View v = decodeView(view);
            return new Returned(encode(MediaMapping.metadata(v.item, v.nextItem, v.forayTitle, v.index, v.total, v.showArtworkUrl,
                    v.appArtworkUrl)));
        });
        calls.put("mediaPositionState", args -> {
            Json view = arg(args, 0);
            if (JsArgs.isNull(view)) return TYPE_ERROR;
            MediaMapping.View v = decodeView(view);
            return new Returned(encode(MediaMapping.positionState(v.durationSec, v.positionSec, v.playbackRate, v.buffering)));
        });
        calls.put("mediaPlaybackState", args -> {
            Json view = arg(args, 0);
            if (JsArgs.isNull(view)) return TYPE_ERROR;
            return new Returned(Json.str(MediaMapping.playbackState(truthy(at(view, "hasItem")), truthy(at(view, "playing")),
                    truthy(at(view, "inSeamGap")), truthy(at(view, "ended")), truthy(at(view, "foray")))));
        });
        calls.put("mediaSessionView", args -> {
            // `view = {}`, then `mediaMetadata(view)` destructures it: null throws.
            Json view = arg(args, 0);
            if (JsArgs.isNull(view)) return TYPE_ERROR;
            MediaMapping.SessionView session = MediaMapping.sessionView(decodeView(view));
            return new Returned(obj("metadata", encode(session.metadata()), "positionState", encode(session.positionState()),
                    "playbackState", Json.str(session.playbackState())));
        });
        return new FamilyRunner.Pure(FAMILY, MAPPING_MODULE, reads, calls);
    }

    /**
     * A {@code view} object as media-session.js destructures it. Only an ABSENT member
     * takes the JS default; anything present that is not the right type becomes null,
     * which every function treats as its "not a number" / "not a string" branch.
     */
    static MediaMapping.View decodeView(Json view) {
        MediaMapping.View v = new MediaMapping.View();
        v.item = item(at(view, "item"));
        v.nextItem = item(at(view, "nextItem"));
        v.forayTitle = JsArgs.isUndefined(at(view, "forayTitle")) ? "" : at(view, "forayTitle").asString();
        v.index = numberOrDefault(view, "index", 0.0);
        v.total = numberOrDefault(view, "total", 0.0);
        v.showArtworkUrl = at(view, "showArtworkUrl").asString();
        v.appArtworkUrl = appArtwork(view);
        v.durationSec = at(view, "durationSec").asNumber();
        v.positionSec = numberOrDefault(view, "positionSec", 0.0);
        v.playbackRate = numberOrDefault(view, "playbackRate", 1.0);
        // `buffering ? 0 : rate`: JavaScript truthiness, like the flags below.
        v.buffering = truthy(at(view, "buffering"));
        v.playing = truthy(at(view, "playing"));
        v.inSeamGap = truthy(at(view, "inSeamGap"));
        v.ended = truthy(at(view, "ended"));
        v.foray = truthy(at(view, "foray"));
        return v;
    }

    private static Double numberOrDefault(Json view, String key, Double fallback) {
        return JsArgs.isUndefined(at(view, key)) ? fallback : at(view, key).asNumber();
    }

    /** {@code appArtworkUrl = APP_ARTWORK_URL}: absent is our icon, an explicit null (or any non-string) is no icon at all. */
    static String appArtwork(Json view) {
        return JsArgs.isUndefined(at(view, "appArtworkUrl")) ? MediaMapping.APP_ARTWORK_URL : at(view, "appArtworkUrl").asString();
    }

    /** Read only through {@code item?.kind} / {@code .title} / {@code .show}; present only through {@code Boolean(view.item)}. */
    static MediaMapping.Item item(Json value) {
        if (!truthy(value)) return null;
        return new MediaMapping.Item(at(value, "kind").asString(), at(value, "title").asString(), at(value, "show").asString());
    }

    // ---- media-actions.js (the adapter over mediaSessionActions)

    static FamilyRunner.Pure actionsRunner(Function<MediaMapping.Surface, List<MediaAction>> installedActions,
            BiFunction<MediaMapping.CommandSnapshot, Boolean, MediaMapping.CommandAvailability> commandAvailability) {
        Map<String, Call> calls = new LinkedHashMap<>();
        calls.put("mediaActions", args -> {
            Json request = arg(args, 0);
            if (JsArgs.isNull(request)) return TYPE_ERROR;
            MediaMapping.Surface surface = decodeSurface(at(request, "surface"));
            // `mediaSessionActions(surface, opts)` destructures opts at the call, after the adapter built its surface.
            Json opts = at(request, "opts");
            if (JsArgs.isNull(opts)) return TYPE_ERROR;
            MediaMapping.SeekSteps steps = new MediaMapping.SeekSteps(step(opts, "seekBackwardSec", MediaMapping.SEEK_BACKWARD_SEC),
                    step(opts, "seekForwardSec", MediaMapping.SEEK_FORWARD_SEC));
            List<MediaAction> installed = installedActions.apply(surface);

            Json rawPresses = at(request, "presses");
            List<Json> presses;
            if (JsArgs.isUndefined(rawPresses)) {
                presses = List.of();
            } else if (rawPresses.asList() != null) {
                presses = rawPresses.asList();
            } else if ("".equals(rawPresses.asString())) {
                // `for (const press of presses)`: a string iterates its characters.
                presses = List.of();
            } else if (rawPresses.asString() != null) {
                throw new HarnessError("E_BAD_CASE", "a press is [action] or [action, details], got a string");
            } else {
                return TYPE_ERROR; // not iterable
            }

            List<Json> recorded = new ArrayList<>();
            for (Json press : presses) {
                List<Json> parts = press.asList();
                if (parts == null || parts.isEmpty() || parts.size() > 2) {
                    throw new HarnessError("E_BAD_CASE", "a press is [action] or [action, details], got " + Json.show(Codec.encode(press)));
                }
                String name = parts.get(0).asString();
                MediaAction action = name == null ? null : MediaAction.of(name);
                if (action == null || !installed.contains(action)) {
                    throw new HarnessError("E_BAD_CASE", Json.show(Codec.encode(parts.get(0)))
                            + " is not installed for this surface; the OS never delivers a press for it");
                }
                Json details = parts.size() == 2 ? parts.get(1) : Json.UNDEFINED;
                MediaMapping.PressDetails pressed = new MediaMapping.PressDetails(at(details, "seekTime").asNumber(),
                        JsArgs.isTrue(at(details, "close")));
                MediaMapping.Intent intent = MediaMapping.intent(action, pressed, steps);
                if (intent != null) recorded.add(encode(intent));
            }
            List<Json> installedTokens = new ArrayList<>();
            for (MediaAction a : installed) installedTokens.add(Json.str(a.token));
            return new Returned(obj("installed", new Json.Arr(installedTokens), "calls", new Json.Arr(recorded)));
        });
        calls.put("commandAvailability", args -> {
            MediaMapping.CommandSnapshot snapshot = decodeSnapshot(arg(args, 0));
            if (!(arg(args, 1) instanceof Json.Bool route)) throw new HarnessError("E_BAD_CASE", "trackRoute must be a boolean");
            MediaMapping.CommandAvailability availability = commandAvailability.apply(snapshot, route.value());
            List<Json> enabled = new ArrayList<>();
            for (MediaMapping.RemoteCommand c : MediaMapping.RemoteCommand.values()) {
                if (availability.isEnabled(c)) enabled.add(Json.str(REMOTE_COMMAND_TOKENS.get(c)));
            }
            return new Returned(obj("enabled", new Json.Arr(enabled), "clearsNowPlaying", Json.bool(availability.clearsNowPlaying())));
        });
        return new FamilyRunner.Pure(FAMILY, ACTIONS_MODULE, Map.of(), calls);
    }

    /** media-actions.js {@code REMOTE_COMMANDS}: Swift's {@code RemoteCommand} raw values, in declaration order. */
    static final Map<MediaMapping.RemoteCommand, String> REMOTE_COMMAND_TOKENS = Map.of(
            MediaMapping.RemoteCommand.PLAY, "play",
            MediaMapping.RemoteCommand.PAUSE, "pause",
            MediaMapping.RemoteCommand.TOGGLE_PLAY_PAUSE, "togglePlayPause",
            MediaMapping.RemoteCommand.NEXT_TRACK, "nextTrack",
            MediaMapping.RemoteCommand.PREVIOUS_TRACK, "previousTrack",
            MediaMapping.RemoteCommand.SKIP_BACKWARD, "skipBackward",
            MediaMapping.RemoteCommand.SKIP_FORWARD, "skipForward",
            MediaMapping.RemoteCommand.CHANGE_PLAYBACK_POSITION, "changePlaybackPosition",
            MediaMapping.RemoteCommand.STOP, "stop");

    /**
     * The adapter's snapshot, as strictly as the adapter reads it: an object, {@code mode} one
     * of the snapshot modes, every flag a boolean or absent (false). Anything else is a
     * malformed case there, and here.
     */
    static MediaMapping.CommandSnapshot decodeSnapshot(Json value) {
        if (!(value instanceof Json.Obj)) throw new HarnessError("E_BAD_CASE", "a snapshot is an object");
        String token = at(value, "mode").asString();
        MediaMapping.CommandSnapshot.Mode mode = null;
        for (MediaMapping.CommandSnapshot.Mode m : MediaMapping.CommandSnapshot.Mode.values()) {
            if (m.token.equals(token)) mode = m;
        }
        if (mode == null) throw new HarnessError("E_BAD_CASE", "snapshot.mode " + Json.show(Codec.encode(at(value, "mode"))) + " is not a snapshot mode");
        return new MediaMapping.CommandSnapshot(mode, flag(value, "ended"), flag(value, "canNext"), flag(value, "canPrevious"),
                flag(value, "autoAdvance"));
    }

    private static boolean flag(Json snapshot, String name) {
        Json v = at(snapshot, name);
        if (JsArgs.isUndefined(v)) return false;
        if (v instanceof Json.Bool b) return b.value();
        throw new HarnessError("E_BAD_CASE", "snapshot." + name + " must be a boolean");
    }

    /**
     * The adapter's {@code recordingSurface(names)}: an ARRAY names the methods that exist;
     * anything else is handed to {@code mediaSessionActions} as is, where
     * {@code surface?.[name]} finds no function in any JSON value, so nothing is installed.
     * An unknown name is a malformed case.
     */
    static MediaMapping.Surface decodeSurface(Json value) {
        MediaMapping.Surface surface = new MediaMapping.Surface();
        List<Json> names = value.asList();
        if (names == null) return surface;
        for (Json name : names) {
            String method = name.asString();
            if (method == null || !SURFACE_METHODS.contains(method)) {
                throw new HarnessError("E_BAD_CASE", "surface method " + Json.show(Codec.encode(name)) + " is not one of "
                        + String.join(", ", SURFACE_METHODS));
            }
            switch (method) {
                case "play" -> surface.play = true;
                case "pause" -> surface.pause = true;
                case "stop" -> surface.stop = true;
                case "next" -> surface.next = true;
                case "previous" -> surface.previous = true;
                case "seekBy" -> surface.seekBy = true;
                default -> surface.seekTo = true;
            }
        }
        return surface;
    }

    /**
     * One {@code opts} step: absent is the default. A present non-number is refused as a
     * malformed case rather than coerced: the typed port's steps are doubles from
     * EngineConstants, so no native caller can ever pass one.
     */
    static double step(Json opts, String key, double fallback) {
        Json v = at(opts, key);
        if (JsArgs.isUndefined(v)) return fallback;
        if (v.asNumber() == null) throw new HarnessError("E_BAD_CASE", "opts." + key + " is not a number; the JVM port's seek steps are typed");
        return v.asNumber();
    }

    // ---- encoding

    /** {@code calls.push([name, ...args])}: the surface call an intent is. */
    static Json encode(MediaMapping.Intent intent) {
        return switch (intent) {
            case MediaMapping.Intent.Play i -> new Json.Arr(List.of(Json.str("play")));
            case MediaMapping.Intent.Pause i -> new Json.Arr(List.of(Json.str("pause")));
            // `stop(details?.close === true ? {close: true} : undefined)`: the explicit
            // undefined is an argument, and the fixture records it.
            case MediaMapping.Intent.Stop i -> new Json.Arr(List.of(Json.str("stop"), i.close() ? obj("close", Json.TRUE) : Json.UNDEFINED));
            case MediaMapping.Intent.Previous i -> new Json.Arr(List.of(Json.str("previous")));
            case MediaMapping.Intent.Next i -> new Json.Arr(List.of(Json.str("next")));
            case MediaMapping.Intent.SeekBy i -> new Json.Arr(List.of(Json.str("seekBy"), Json.num(i.offset())));
            case MediaMapping.Intent.SeekTo i -> new Json.Arr(List.of(Json.str("seekTo"), Json.num(i.position())));
        };
    }

    /** {@code {src, sizes?, type?}}: an absent member is absent, not null. */
    static Json encode(MediaMapping.Artwork artwork) {
        Map<String, Json> fields = new LinkedHashMap<>();
        fields.put("src", Json.str(artwork.src()));
        if (artwork.sizes() != null) fields.put("sizes", Json.str(artwork.sizes()));
        if (artwork.type() != null) fields.put("type", Json.str(artwork.type()));
        return new Json.Obj(fields);
    }

    static Json encode(MediaMapping.Metadata metadata) {
        List<Json> art = new ArrayList<>();
        for (MediaMapping.Artwork a : metadata.artwork()) art.add(encode(a));
        return obj("title", Json.str(metadata.title()), "artist", Json.str(metadata.artist()), "album", Json.str(metadata.album()),
                "artwork", new Json.Arr(art));
    }

    static Json encode(MediaMapping.PositionState state) {
        if (state == null) return Json.NULL;
        return obj("duration", Json.num(state.duration()), "position", Json.num(state.position()),
                "playbackRate", Json.num(state.playbackRate()));
    }
}
