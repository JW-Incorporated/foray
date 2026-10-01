package ai.jwlabs.foura.engine.parity;

import static ai.jwlabs.foura.engine.parity.JsArgs.arg;
import static ai.jwlabs.foura.engine.parity.JsArgs.at;

import ai.jwlabs.foura.engine.RouteResume;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Call;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Outcome;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Returned;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Threw;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The {@code route-resume} family against {@link RouteResume} (main code), card A-61, the JVM twin
 * of the Swift RouteResumeFamily (NE-38rs), from the cases player/route-resume.js recorded
 * (NE-38rj).
 *
 * <p>TRANSLATION, NEVER DECISION: each mapping below is the line of JS that reads the value.
 * <pre>
 *   ({pausedBy, ...} = {})              no argument is {}; null THROWS
 *   pausedBy !== "route"                only the string "route" is a route pause
 *   !lost || !nonEmpty(lost.key)        a falsy side is no route; only a non-empty STRING is a key
 *   routeClass(back.port)               only a string can be a car's port
 *   known !== true                      strict: only a real true is known
 *   Number.isFinite(lostAgoSec)         only a number is an age
 *   (bluetoothArm ?? DEFAULT) !== true  null and undefined are the default; only a real true arms it
 *   event?.on                           anything but the six events THROWS
 *   event.atSec - s.lost.atSec          only numbers make an age (a fixture never spells one otherwise)
 * </pre>
 */
final class RouteResumeFamily {
    private RouteResumeFamily() {}

    static final String MODULE = "player/route-resume.js";
    private static final Outcome TYPE_ERROR = new Threw("TypeError");

    static FamilyRunner runner() {
        Map<String, Json> reads = new LinkedHashMap<>();
        reads.put("ROUTE_RESUME_MAX_LOST_SEC", Json.num(RouteResume.MAX_LOST_SEC));
        reads.put("ROUTE_RESUME_BLUETOOTH_DEFAULT", Json.bool(RouteResume.BLUETOOTH_DEFAULT));
        Map<String, Call> calls = new LinkedHashMap<>();
        calls.put("routeClass", args -> new Returned(Json.str(RouteResume.routeClass(arg(args, 0).asString()).token)));
        calls.put("routeKey", args -> {
            String key = RouteResume.routeKey(arg(args, 0).asString(), arg(args, 1).asString());
            return new Returned(JsArgs.stringOrNull(key));
        });
        calls.put("routeResumeDecision", RouteResumeFamily::decision);
        calls.put("routeResumeReplay", RouteResumeFamily::replay);
        return new FamilyRunner.Pure("route-resume", MODULE, reads, calls);
    }

    /** A route side: falsy is none; otherwise its {@code port} and {@code key}, strings only. */
    static RouteResume.Route route(Json value) {
        if (!JsArgs.truthy(value)) return null;
        return new RouteResume.Route(at(value, "port").asString(), at(value, "key").asString());
    }

    /** {@code bluetoothArm}: nullish is "use the default", anything else is on only when it is {@code true}. */
    static Boolean arm(Json value) {
        return JsArgs.isNullish(value) ? null : JsArgs.isTrue(value);
    }

    static Outcome decision(List<Json> args) {
        Json p = JsArgs.objectParam(arg(args, 0), true);
        if (p == null) return TYPE_ERROR;
        RouteResume.Decision made = RouteResume.decision(at(p, "pausedBy").asString(), route(at(p, "lost")),
                route(at(p, "back")), JsArgs.isTrue(at(p, "known")), at(p, "lostAgoSec").asNumber(), arm(at(p, "bluetoothArm")));
        return new Returned(encode(made));
    }

    static Json encode(RouteResume.Decision decision) {
        Map<String, Json> m = new LinkedHashMap<>();
        m.put("resume", Json.bool(decision.resume()));
        m.put("why", Json.str(decision.why()));
        return new Json.Obj(m);
    }

    /** One event as {@code routeResumeStep} reads it, or null for one it throws on. */
    static RouteResume.Event event(Json value) {
        String on = at(value, "on").asString();
        if (on == null) return null;
        return switch (on) {
            case "lost" -> new RouteResume.Event.Lost(at(value, "port").asString(), at(value, "key").asString(),
                    at(value, "atSec").asNumber());
            case "back" -> new RouteResume.Event.Back(at(value, "port").asString(), at(value, "key").asString(),
                    JsArgs.isTrue(at(value, "known")), at(value, "atSec").asNumber());
            case "press" -> new RouteResume.Event.Press(at(value, "command").asString());
            case "interruption" -> RouteResume.Event.INTERRUPTION;
            case "system" -> RouteResume.Event.SYSTEM;
            case "playing" -> RouteResume.Event.PLAYING;
            default -> null;
        };
    }

    /** {@code routeResumeReplay(events, {bluetoothArm = DEFAULT, playing = true} = {})}. */
    static Outcome replay(List<Json> args) {
        List<Json> items = arg(args, 0).asList();
        if (items == null) return TYPE_ERROR;
        Json opts = JsArgs.objectParam(arg(args, 1), true);
        if (opts == null) return TYPE_ERROR;
        List<RouteResume.Event> events = new ArrayList<>();
        for (Json item : items) {
            RouteResume.Event event = event(item);
            if (event == null) return TYPE_ERROR;
            events.add(event);
        }
        Json playingOpt = at(opts, "playing");
        boolean playing = JsArgs.isUndefined(playingOpt) || JsArgs.isTrue(playingOpt);
        RouteResume.Replay result = RouteResume.replay(events, arm(at(opts, "bluetoothArm")), playing);
        List<Json> decisions = new ArrayList<>();
        for (RouteResume.ReplayDecision d : result.decisions()) {
            Map<String, Json> m = new LinkedHashMap<>();
            m.put("event", Json.num(d.event()));
            m.put("resume", Json.bool(d.decision().resume()));
            m.put("why", Json.str(d.decision().why()));
            decisions.add(new Json.Obj(m));
        }
        Map<String, Json> out = new LinkedHashMap<>();
        out.put("decisions", new Json.Arr(decisions));
        out.put("resumes", Json.num(result.resumes()));
        return new Returned(new Json.Obj(out));
    }
}
