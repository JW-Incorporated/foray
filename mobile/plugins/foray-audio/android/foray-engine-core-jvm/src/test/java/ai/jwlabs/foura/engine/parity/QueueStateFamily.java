package ai.jwlabs.foura.engine.parity;

import static ai.jwlabs.foura.engine.parity.JsArgs.at;
import static ai.jwlabs.foura.engine.parity.JsArgs.obj;

import ai.jwlabs.foura.engine.ItemBounds;
import ai.jwlabs.foura.engine.PendingSeek;
import ai.jwlabs.foura.engine.PlayerEffect;
import ai.jwlabs.foura.engine.PlayerEvent;
import ai.jwlabs.foura.engine.PlayerItemKind;
import ai.jwlabs.foura.engine.PlayerQueueState;
import ai.jwlabs.foura.engine.PlayerQueueStateMachine;
import ai.jwlabs.foura.engine.QueueItemRef;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Call;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BiFunction;

/**
 * The {@code queue-state} family against {@link PlayerQueueStateMachine} (A-23): the JVM
 * twin of the Swift QueueStateFamily. The fixtures are {@code reduce(state, event)} and
 * {@code itemBounds(bounds)} calls whose arguments and answers are the JS reducer's own
 * plain objects, so this runner's whole job is a CODEC between those objects and the
 * sealed types, in both directions.
 *
 * <p>DECODING IS STRICT: every shape the typed port cannot represent faithfully (a missing
 * {@code bounds}, a {@code precise} of "yes", an unknown event type) is refused as
 * {@code E_BAD_CASE}, never coerced. A fixture item's {@code bounds} must already be what
 * {@code itemBounds} returns: {@link ItemBounds} can only be built normalised.
 *
 * <p>ENCODING writes exactly the keys the JS constructors write, nulls included:
 * {@code loadingItem} always carries {@code previous} and {@code pendingSeek}, an item
 * always carries {@code bounds}.
 */
final class QueueStateFamily {
    private QueueStateFamily() {}

    static final String MODULE = "player/queue-state.js";

    /** The reducer under test, as a value, so a test can hand the runner a broken one and watch a named case go red. */
    static FamilyRunner runner(BiFunction<PlayerQueueState, PlayerEvent, PlayerQueueStateMachine.Transition> reduce) {
        Map<String, Call> calls = new LinkedHashMap<>();
        calls.put("reduce", args -> {
            if (args.size() != 2) throw new HarnessError("E_BAD_CASE", "reduce takes (state, event), got " + args.size() + " argument(s)");
            PlayerQueueStateMachine.Transition t = reduce.apply(decodeState(args.get(0)), decodeEvent(args.get(1)));
            List<Json> effects = new ArrayList<>();
            for (PlayerEffect e : t.effects()) effects.add(encode(e));
            return new FamilyRunner.Returned(new Json.Arr(List.of(encode(t.state()), new Json.Arr(effects))));
        });
        calls.put("itemBounds", args -> {
            // `if (!bounds) return null;` then `finiteNonNegative(bounds.x)`, where only
            // `typeof n === "number"` is a number; a truthy non-object's members are undefined.
            Json bounds = JsArgs.arg(args, 0);
            if (!JsArgs.truthy(bounds)) return new FamilyRunner.Returned(Json.NULL);
            ItemBounds made = ItemBounds.make(at(bounds, "startSec").asNumber(), at(bounds, "endSec").asNumber());
            return new FamilyRunner.Returned(made == null ? Json.NULL : encode(made));
        });
        return new FamilyRunner.Pure("queue-state", MODULE, Map.of(), calls);
    }

    static FamilyRunner runner() {
        return runner(PlayerQueueStateMachine::reduce);
    }

    // ---- decode (the JS objects -> the sealed types)

    static PlayerQueueState decodeState(Json value) {
        String type = tag(value, "state");
        return switch (type) {
            case "idle" -> PlayerQueueState.IDLE;
            case "ended" -> PlayerQueueState.ENDED;
            case "loadingItem" -> new PlayerQueueState.LoadingItem(item(at(value, "target"), "loadingItem.target"),
                    optionalItem(at(value, "previous"), "loadingItem.previous"), decodePendingSeek(at(value, "pendingSeek")));
            case "playing" -> new PlayerQueueState.Playing(item(at(value, "item"), "playing.item"));
            case "transitioning" -> new PlayerQueueState.Transitioning(item(at(value, "from"), "transitioning.from"),
                    item(at(value, "to"), "transitioning.to"));
            case "interrupted" -> new PlayerQueueState.Interrupted(item(at(value, "item"), "interrupted.item"),
                    bool(at(value, "wasPlaying"), "interrupted.wasPlaying"));
            default -> throw new HarnessError("E_BAD_CASE", "no JVM state for {type: \"" + type + "\"}");
        };
    }

    static PlayerEvent decodeEvent(Json value) {
        String type = tag(value, "event");
        return switch (type) {
            case "play" -> new PlayerEvent.Play(item(at(value, "item"), "play.item"));
            case "itemLoaded" -> PlayerEvent.ITEM_LOADED;
            case "itemEnded" -> new PlayerEvent.ItemEnded(optionalItem(at(value, "next"), "itemEnded.next"),
                    bool(at(value, "bridged"), "itemEnded.bridged"));
            case "interruptionBegan" -> PlayerEvent.INTERRUPTION_BEGAN;
            case "interruptionEnded" -> new PlayerEvent.InterruptionEnded(bool(at(value, "shouldResume"), "interruptionEnded.shouldResume"));
            case "routeChanged" -> new PlayerEvent.RouteChanged(bool(at(value, "oldDeviceUnavailable"), "routeChanged.oldDeviceUnavailable"));
            case "skipToNext" -> new PlayerEvent.SkipToNext(optionalItem(at(value, "item"), "skipToNext.item"));
            case "skipToPrevious" -> new PlayerEvent.SkipToPrevious(optionalItem(at(value, "item"), "skipToPrevious.item"));
            case "stop" -> PlayerEvent.STOP;
            case "error" -> {
                String message = at(value, "message").asString();
                if (message == null) throw new HarnessError("E_BAD_CASE", "error.message must be a string");
                yield new PlayerEvent.Error(message);
            }
            case "seek" -> {
                Double seconds = at(value, "seconds").asNumber();
                if (seconds == null) throw new HarnessError("E_BAD_CASE", "seek.seconds must be a number");
                yield new PlayerEvent.Seek(seconds, bool(at(value, "precise"), "seek.precise"));
            }
            case "elementResumed" -> PlayerEvent.ELEMENT_RESUMED;
            // The JS default branch (an unknown event is logged and ignored) is excluded as
            // js-module-shape: a sealed type has no unknown member.
            default -> throw new HarnessError("E_BAD_CASE", "no JVM event for {type: \"" + type + "\"}");
        };
    }

    static String tag(Json value, String what) {
        String type = value instanceof Json.Obj ? at(value, "type").asString() : null;
        if (type == null) {
            throw new HarnessError("E_BAD_CASE", "a " + what + " must be an object with a string type, got " + Json.show(Codec.encode(value)));
        }
        return type;
    }

    static boolean bool(Json value, String field) {
        if (!(value instanceof Json.Bool b)) {
            throw new HarnessError("E_BAD_CASE", field + " must be a boolean, got " + Json.show(Codec.encode(value)));
        }
        return b.value();
    }

    static QueueItemRef optionalItem(Json value, String field) {
        return JsArgs.isNull(value) ? null : item(value, field);
    }

    /** An {@code itemRef(id, kind, bounds)} object: bounds present, and either null or already {@code itemBounds}-normalised. */
    static QueueItemRef item(Json value, String field) {
        String id = value instanceof Json.Obj ? at(value, "id").asString() : null;
        if (id == null) {
            throw new HarnessError("E_BAD_CASE", field + " must be an itemRef object with a string id, got " + Json.show(Codec.encode(value)));
        }
        PlayerItemKind kind = PlayerItemKind.of(at(value, "kind").asString() == null ? "" : at(value, "kind").asString());
        if (kind == null) {
            throw new HarnessError("E_BAD_CASE", field + ".kind must be \"episode\" or \"tts\", got " + Json.show(Codec.encode(at(value, "kind"))));
        }
        Json raw = at(value, "bounds");
        if (JsArgs.isNull(raw)) return new QueueItemRef(id, kind, null);
        Double start = at(raw, "startSec").asNumber();
        Double end = at(raw, "endSec").asNumber();
        ItemBounds bounds = raw instanceof Json.Obj && start != null && end != null ? ItemBounds.make(start, end) : null;
        if (bounds == null || bounds.startSec() != start || bounds.endSec() != end) {
            throw new HarnessError("E_BAD_CASE", field + ".bounds must be null or what itemBounds returns (a finite forward slice), got "
                    + Json.show(Codec.encode(raw)));
        }
        return new QueueItemRef(id, kind, bounds);
    }

    static PendingSeek decodePendingSeek(Json value) {
        if (JsArgs.isNull(value)) return null;
        Double seconds = value instanceof Json.Obj ? at(value, "seconds").asNumber() : null;
        if (seconds == null) {
            throw new HarnessError("E_BAD_CASE", "loadingItem.pendingSeek must be null or {seconds, precise}, got " + Json.show(Codec.encode(value)));
        }
        return new PendingSeek(seconds, bool(at(value, "precise"), "loadingItem.pendingSeek.precise"));
    }

    // ---- encode (the sealed types -> the JS objects)

    static Json encode(PlayerQueueState state) {
        return switch (state) {
            case PlayerQueueState.Idle s -> obj("type", Json.str("idle"));
            case PlayerQueueState.Ended s -> obj("type", Json.str("ended"));
            case PlayerQueueState.LoadingItem s -> obj("type", Json.str("loadingItem"), "target", encode(s.target()),
                    "previous", s.previous() == null ? Json.NULL : encode(s.previous()),
                    "pendingSeek", s.pendingSeek() == null ? Json.NULL
                            : obj("seconds", Json.num(s.pendingSeek().seconds()), "precise", Json.bool(s.pendingSeek().precise())));
            case PlayerQueueState.Playing s -> obj("type", Json.str("playing"), "item", encode(s.item()));
            case PlayerQueueState.Transitioning s -> obj("type", Json.str("transitioning"), "from", encode(s.from()), "to", encode(s.to()));
            case PlayerQueueState.Interrupted s -> obj("type", Json.str("interrupted"), "item", encode(s.item()),
                    "wasPlaying", Json.bool(s.wasPlaying()));
        };
    }

    static Json encode(PlayerEffect effect) {
        return switch (effect) {
            case PlayerEffect.LoadItem e -> obj("type", Json.str("loadItem"), "item", encode(e.item()));
            case PlayerEffect.StartPlayback e -> obj("type", Json.str("startPlayback"));
            case PlayerEffect.PausePlayback e -> obj("type", Json.str("pausePlayback"));
            case PlayerEffect.SavePosition e -> obj("type", Json.str("savePosition"));
            case PlayerEffect.PlayTransitionTTS e -> obj("type", Json.str("playTransitionTTS"));
            case PlayerEffect.ResetRateForTTS e -> obj("type", Json.str("resetRateForTTS"));
            case PlayerEffect.RestoreRate e -> obj("type", Json.str("restoreRate"));
            case PlayerEffect.EmitTelemetry e -> obj("type", Json.str("emitTelemetry"), "message", Json.str(e.message()));
            case PlayerEffect.SeekTo e -> obj("type", Json.str("seekTo"), "seconds", Json.num(e.seconds()), "precise", Json.bool(e.precise()));
            case PlayerEffect.SeekRejected e -> obj("type", Json.str("seekRejected"), "reason", Json.str(e.reason()));
            case PlayerEffect.SetOutPoint e -> obj("type", Json.str("setOutPoint"), "seconds", Json.num(e.seconds()));
        };
    }

    static Json encode(QueueItemRef item) {
        return obj("id", Json.str(item.id()), "kind", Json.str(item.kind().token),
                "bounds", item.bounds() == null ? Json.NULL : encode(item.bounds()));
    }

    static Json encode(ItemBounds bounds) {
        return obj("startSec", Json.num(bounds.startSec()), "endSec", Json.num(bounds.endSec()));
    }
}
