package ai.jwlabs.foura.engine.parity;

import static ai.jwlabs.foura.engine.parity.JsArgs.arg;
import static ai.jwlabs.foura.engine.parity.JsArgs.at;

import ai.jwlabs.foura.engine.DeckPolicy;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Call;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Outcome;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Returned;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Threw;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The {@code deck-episode} family against {@link DeckPolicy} (card A-24), from the cases
 * {@code player/deck-policy.js} recorded (NE-14j). The JVM twin of the Swift
 * DeckEpisodeFamily.
 *
 * <p>THE ONE JOB HERE IS TRANSLATION, NEVER DECISION. Every deck-policy.js function takes
 * ONE destructured object, so a null or missing argument throws a TypeError before the
 * rule runs (except {@code loadDeadlineMs}, whose object defaults to {@code {}}). Each
 * field is then read the way its line of JS reads it:
 * <pre>
 *   outPointSec == null, boundarySec != null   loose: null and undefined are "none";
 *                                              anything else must be a number
 *   !armed, paused, superseded, stopped,       truthiness
 *   !failed
 *   armed = true, lastWakeAtSec = null,        the destructuring default applies to
 *   pinnedMs = null, hidden = false            undefined only
 *   hidden === true, hasMetadata === true      strict: only a real true
 *   deckRate(rate)                             typeof rate === "number"
 *   atSec - outPointSec, atSec &lt; ...           arithmetic and comparison: the port takes
 *                                              numbers, and a case handing it anything
 *                                              else is not representable
 * </pre>
 */
final class DeckEpisodeFamily {
    private DeckEpisodeFamily() {}

    static final String FAMILY = "deck-episode";
    static final String MODULE = "player/deck-policy.js";

    private static final Outcome TYPE_ERROR = new Threw("TypeError");

    static FamilyRunner runner() {
        Map<String, Json> reads = new LinkedHashMap<>();
        reads.put("OUT_POINT_ARM_LEAD_SEC", Json.num(DeckPolicy.OUT_POINT_ARM_LEAD_SEC));
        reads.put("OUT_POINT_MIN_TIMER_MS", Json.num(DeckPolicy.OUT_POINT_MIN_TIMER_MS));
        reads.put("LOAD_SETTLE_TIMEOUT_MS", Json.num(DeckPolicy.LOAD_SETTLE_TIMEOUT_MS));
        reads.put("LOAD_SETTLE_TIMEOUT_HIDDEN_MS", Json.num(DeckPolicy.LOAD_SETTLE_TIMEOUT_HIDDEN_MS));
        reads.put("SETTLE_NEAR_SEC", Json.num(DeckPolicy.SETTLE_NEAR_SEC));
        Map<String, Call> calls = new LinkedHashMap<>();
        calls.put("fineWatchDelayMs", DeckEpisodeFamily::fineWatchDelayMs);
        calls.put("fineWakeAction", DeckEpisodeFamily::fineWakeAction);
        calls.put("outPointArmed", DeckEpisodeFamily::outPointArmed);
        calls.put("loadDeadlineMs", DeckEpisodeFamily::loadDeadlineMs);
        calls.put("sameSourceIsSeek", DeckEpisodeFamily::sameSourceIsSeek);
        calls.put("settledNear", DeckEpisodeFamily::settledNear);
        calls.put("recoveryLoadedOps", DeckEpisodeFamily::recoveryLoadedOps);
        calls.put("recoveryFailedOps", DeckEpisodeFamily::recoveryFailedOps);
        return new FamilyRunner.Pure(FAMILY, MODULE, reads, calls);
    }

    /** The one object parameter with no default, or null for "throws a TypeError". */
    private static Json param(List<Json> args) {
        return JsArgs.objectParam(arg(args, 0), false);
    }

    /** A field the JS does arithmetic or a {@code <} comparison with. */
    private static double number(Json value, String what) {
        Double n = value.asNumber();
        if (n == null) throw JsArgs.notRepresentable(what, value);
        return n;
    }

    /** A field read with {@code == null} / {@code != null} and otherwise used as a number. */
    private static Double looseNumber(Json value, String what) {
        return JsArgs.optionalNumber(value, what);
    }

    private static Outcome tokens(List<DeckPolicy.Recovery> ops) {
        List<String> out = new ArrayList<>();
        for (DeckPolicy.Recovery op : ops) out.add(op.token);
        return new Returned(JsArgs.strings(out));
    }

    /** {@code fineWatchDelayMs({ outPointSec, atSec, rate, armed = true, paused = false })}. */
    private static Outcome fineWatchDelayMs(List<Json> args) {
        Json s = param(args);
        if (s == null) return TYPE_ERROR;
        Json armedField = at(s, "armed");
        boolean armed = JsArgs.isUndefined(armedField) || JsArgs.truthy(armedField);
        Double delay = DeckPolicy.fineWatchDelayMs(looseNumber(at(s, "outPointSec"), "fineWatchDelayMs's outPointSec"),
                number(at(s, "atSec"), "fineWatchDelayMs's atSec"), at(s, "rate").asNumber(), armed,
                JsArgs.truthy(at(s, "paused")));
        return new Returned(JsArgs.numberOrNull(delay));
    }

    /**
     * {@code fineWakeAction({ atSec, outPointSec, lastWakeAtSec = null })}: an explicit null
     * and a missing field are both "no previous wake"; anything else must be a number.
     */
    private static Outcome fineWakeAction(List<Json> args) {
        Json s = param(args);
        if (s == null) return TYPE_ERROR;
        DeckPolicy.FineWake wake = DeckPolicy.fineWakeAction(number(at(s, "atSec"), "fineWakeAction's atSec"),
                number(at(s, "outPointSec"), "fineWakeAction's outPointSec"),
                looseNumber(at(s, "lastWakeAtSec"), "fineWakeAction's lastWakeAtSec"));
        return new Returned(Json.str(wake.token));
    }

    /** {@code outPointArmed({ atSec, outPointSec })}. */
    private static Outcome outPointArmed(List<Json> args) {
        Json s = param(args);
        if (s == null) return TYPE_ERROR;
        return new Returned(Json.bool(DeckPolicy.outPointArmed(number(at(s, "atSec"), "outPointArmed's atSec"),
                number(at(s, "outPointSec"), "outPointArmed's outPointSec"))));
    }

    /**
     * {@code loadDeadlineMs({ pinnedMs = null, hidden = false } = {})}: the object has a
     * default, {@code pinnedMs != null} is loose (and returned as given, so it must be a
     * number), {@code hidden === true} is strict.
     */
    private static Outcome loadDeadlineMs(List<Json> args) {
        Json s = JsArgs.objectParam(arg(args, 0), true);
        if (s == null) return TYPE_ERROR;
        double deadline = DeckPolicy.loadDeadlineMs(looseNumber(at(s, "pinnedMs"), "loadDeadlineMs's pinnedMs"),
                JsArgs.isTrue(at(s, "hidden")));
        return new Returned(Json.num(deadline));
    }

    /**
     * {@code sameSourceIsSeek({ loadedUrl, url, hasMetadata, failed })}:
     * {@code Boolean(loadedUrl) && loadedUrl === url && hasMetadata === true && !failed}. A
     * falsy {@code loadedUrl} is "nothing loaded"; a truthy one must be a string, and
     * {@code url} is compared strictly, so a non-string url never equals it.
     */
    private static Outcome sameSourceIsSeek(List<Json> args) {
        Json s = param(args);
        if (s == null) return TYPE_ERROR;
        Json loaded = at(s, "loadedUrl");
        String loadedUrl = null;
        if (JsArgs.truthy(loaded)) {
            loadedUrl = loaded.asString();
            if (loadedUrl == null) throw JsArgs.notRepresentable("sameSourceIsSeek's loadedUrl", loaded);
        }
        return new Returned(Json.bool(DeckPolicy.sameSourceIsSeek(loadedUrl, at(s, "url").asString(),
                JsArgs.isTrue(at(s, "hasMetadata")), JsArgs.truthy(at(s, "failed")))));
    }

    /** {@code settledNear({ atSec, targetSec })}. */
    private static Outcome settledNear(List<Json> args) {
        Json s = param(args);
        if (s == null) return TYPE_ERROR;
        return new Returned(Json.bool(DeckPolicy.settledNear(number(at(s, "atSec"), "settledNear's atSec"),
                number(at(s, "targetSec"), "settledNear's targetSec"))));
    }

    /** {@code recoveryLoadedOps({ superseded, stopped, boundarySec })}. */
    private static Outcome recoveryLoadedOps(List<Json> args) {
        Json s = param(args);
        if (s == null) return TYPE_ERROR;
        return tokens(DeckPolicy.recoveryLoadedOps(JsArgs.truthy(at(s, "superseded")), JsArgs.truthy(at(s, "stopped")),
                looseNumber(at(s, "boundarySec"), "recoveryLoadedOps's boundarySec")));
    }

    /** {@code recoveryFailedOps({ superseded, stopped })}. */
    private static Outcome recoveryFailedOps(List<Json> args) {
        Json s = param(args);
        if (s == null) return TYPE_ERROR;
        return tokens(DeckPolicy.recoveryFailedOps(JsArgs.truthy(at(s, "superseded")), JsArgs.truthy(at(s, "stopped"))));
    }
}
