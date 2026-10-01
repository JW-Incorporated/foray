package ai.jwlabs.foura.engine.parity;

import static ai.jwlabs.foura.engine.parity.JsArgs.arg;
import static ai.jwlabs.foura.engine.parity.JsArgs.at;

import ai.jwlabs.foura.engine.DeckPolicy;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Call;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Outcome;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Returned;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Threw;
import ai.jwlabs.foura.engine.parity.ParityData.FixtureCase;
import ai.jwlabs.foura.engine.parity.ParityData.FixtureFile;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The {@code outpoint} and {@code deck} families (card A-25) against the rest of
 * {@link DeckPolicy}: the JVM twins of the Swift OutpointFamily, DeckFamily and
 * DeckPairFamily (ForayEngineParity/Families/).
 *
 * <ul>
 *   <li>{@code outpoint}: {@code outpoint-policy.json} (module {@code player/deck-policy.js})
 *       pins the constants and the arithmetic as pure calls; {@code outpoint-watch.json}
 *       drives {@link DeckPolicy#outPointStep} over {@link DeckWorld}'s driven clock.
 *   <li>{@code deck}: routed by the fixture FILE's module. {@code deck-readings.json} and
 *       {@code deck-pair.json} (module {@code player/deck-policy.js}) are the deck's guards
 *       and the standby deck's decisions; {@code deck-slices.json} (no module, scenarios)
 *       is the out-point over one deck across consecutive slices, the same DeckWorld.
 * </ul>
 *
 * <p>TRANSLATION ONLY, as everywhere in this package: each reader names the JavaScript it
 * stands for, and a value the typed port has no parameter for fails the case as
 * {@code E_BAD_CASE} rather than guessing.
 */
final class DeckFamilies {
    private DeckFamilies() {}

    static final String MODULE = "player/deck-policy.js";

    private static final Outcome TYPE_ERROR = new Threw("TypeError");

    private static Outcome ret(Json value) {
        return new Returned(value);
    }

    private static Json param(List<Json> args) {
        return JsArgs.objectParam(arg(args, 0), false);
    }

    /** A field the JS does arithmetic or a comparison with. */
    private static double number(Json value, String what) {
        Double n = value.asNumber();
        if (n == null) throw JsArgs.notRepresentable(what, value);
        return n;
    }

    // ================================================================ outpoint

    static FamilyRunner outpoint() {
        Map<String, Json> reads = new LinkedHashMap<>();
        reads.put("OUT_POINT_WATCHDOG_WINDOW_SEC", Json.num(DeckPolicy.OUT_POINT_WATCHDOG_WINDOW_SEC));
        reads.put("OUT_POINT_WATCHDOG_POLL_MS", Json.num(DeckPolicy.OUT_POINT_WATCHDOG_POLL_MS));
        reads.put("OUT_POINT_LAYER", JsArgs.obj(
                "END_TIME", Json.str(DeckPolicy.OutPointLayer.END_TIME.token),
                "BOUNDARY", Json.str(DeckPolicy.OutPointLayer.BOUNDARY.token),
                "WATCHDOG", Json.str(DeckPolicy.OutPointLayer.WATCHDOG.token)));
        reads.put("WATCHDOG_WAKE", JsArgs.obj(
                "STOP", Json.str(DeckPolicy.WatchdogWake.STOP.token),
                "REARM", Json.str(DeckPolicy.WatchdogWake.REARM.token)));
        Map<String, Call> calls = new LinkedHashMap<>();
        calls.put("watchdogDelayMs", DeckFamilies::watchdogDelayMs);
        calls.put("watchdogWakeAction", DeckFamilies::watchdogWakeAction);
        calls.put("outPointOvershootMs", DeckFamilies::outPointOvershootMs);
        calls.put("initialOutPointWatch", args -> ret(encode(new DeckPolicy.OutPointWatch())));
        FamilyRunner.Pure pure = new FamilyRunner.Pure("outpoint", MODULE, reads, calls);
        return new FamilyRunner() {
            @Override
            public String family() {
                return "outpoint";
            }

            @Override
            public Json run(FixtureCase testCase, FixtureFile file, Codec.Context context) {
                if (!"scenario".equals(testCase.kind())) return pure.run(testCase, file, context);
                return DeckWorld.run(testCase, context, "outpoint");
            }
        };
    }

    /**
     * {@code watchdogDelayMs({ outPointSec, atSec, rate, armed = true, paused = false })}: no
     * default for the object. {@code outPointSec} passes only as a number ({@code typeof});
     * {@code atSec} is compared and subtracted, both ToNumber; {@code rate} goes through
     * {@code deckRate} ({@code typeof}).
     */
    private static Outcome watchdogDelayMs(List<Json> args) {
        Json s = param(args);
        if (s == null) return TYPE_ERROR;
        Json armedField = at(s, "armed");
        boolean armed = JsArgs.isUndefined(armedField) || JsArgs.truthy(armedField);
        Double delay = DeckPolicy.watchdogDelayMs(at(s, "outPointSec").asNumber(), JsArgs.toNumber(at(s, "atSec")),
                at(s, "rate").asNumber(), armed, JsArgs.truthy(at(s, "paused")));
        return ret(JsArgs.numberOrNull(delay));
    }

    /** {@code watchdogWakeAction({ atSec, outPointSec })}: two strings would compare as strings, so only numbers are taken. */
    private static Outcome watchdogWakeAction(List<Json> args) {
        Json s = param(args);
        if (s == null) return TYPE_ERROR;
        DeckPolicy.WatchdogWake wake = DeckPolicy.watchdogWakeAction(number(at(s, "atSec"), "watchdogWakeAction's atSec"),
                number(at(s, "outPointSec"), "watchdogWakeAction's outPointSec"));
        return ret(Json.str(wake.token));
    }

    /** {@code outPointOvershootMs({ atSec, outPointSec })}: a subtraction, so ToNumber. */
    private static Outcome outPointOvershootMs(List<Json> args) {
        Json s = param(args);
        if (s == null) return TYPE_ERROR;
        return ret(Json.num(DeckPolicy.outPointOvershootMs(JsArgs.toNumber(at(s, "atSec")), JsArgs.toNumber(at(s, "outPointSec")))));
    }

    /** {@code initialOutPointWatch()} and the watch as JS spells it. */
    static Json encode(DeckPolicy.OutPointWatch watch) {
        return JsArgs.obj(
                "token", Json.num(watch.token),
                "outPointSec", JsArgs.numberOrNull(watch.outPointSec),
                "armed", Json.bool(watch.armed),
                "fired", Json.bool(watch.fired),
                "playing", Json.bool(watch.playing),
                "rate", Json.num(watch.rate),
                "timerDueMs", JsArgs.numberOrNull(watch.timerDueMs));
    }

    // ================================================================ deck

    /**
     * deck-policy.js's calls the {@code deck} family's module files make, and (A-62) the
     * {@code prepare-narration} family's {@code policy.json}: {@code warmsAcross} and the duration
     * window, through the same readers (the Swift {@code DeckPairFamily.calls}).
     */
    static Map<String, Call> deckCalls() {
        Map<String, Call> calls = new LinkedHashMap<>();
        // deck-readings.json: the single deck's guards.
        calls.put("deckRate", args -> ret(Json.num(DeckPolicy.deckRate(arg(args, 0).asNumber()))));
        calls.put("deckSeekTarget", args -> ret(JsArgs.numberOrNull(DeckPolicy.deckSeekTarget(arg(args, 0).asNumber()))));
        calls.put("deckVolume", args -> ret(Json.num(DeckPolicy.deckVolume(JsArgs.toNumber(arg(args, 0))))));
        calls.put("deckDuration", args -> ret(JsArgs.numberOrNull(DeckPolicy.deckDuration(arg(args, 0).asNumber()))));
        calls.put("deckReportedRate", DeckFamilies::deckReportedRate);
        // Their translations are the deck-episode family's.
        calls.put("loadDeadlineMs", DeckEpisodeFamily::loadDeadlineMs);
        calls.put("sameSourceIsSeek", DeckEpisodeFamily::sameSourceIsSeek);
        // deck-pair.json: the warm handover's decisions.
        calls.put("warmOffset", args -> ret(Json.num(DeckPolicy.warmOffset(arg(args, 0).asNumber()))));
        calls.put("prefetchDecision", DeckFamilies::prefetchDecision);
        calls.put("warmSettled", DeckFamilies::warmSettled);
        calls.put("warmPromotion", DeckFamilies::warmPromotion);
        calls.put("handoverSteps", args -> {
            List<String> steps = new ArrayList<>();
            for (DeckPolicy.HandoverStep step : DeckPolicy.handoverSteps()) steps.add(step.token);
            return ret(JsArgs.strings(steps));
        });
        calls.put("discardFreesBuffer", args -> ret(Json.bool(DeckPolicy.discardFreesBuffer(arg(args, 0).asString()))));
        calls.put("playRefusalAction", DeckFamilies::playRefusalAction);
        calls.put("unexplainedPauseAction", DeckFamilies::unexplainedPauseAction);
        calls.put("prefetchWindowOpens", DeckFamilies::prefetchWindowOpens);
        calls.put("warmsAcross", DeckFamilies::warmsAcross);
        return calls;
    }

    static FamilyRunner deck() {
        FamilyRunner.Pure pure = new FamilyRunner.Pure("deck", MODULE, Map.of(), deckCalls());
        return new FamilyRunner() {
            @Override
            public String family() {
                return "deck";
            }

            @Override
            public Json run(FixtureCase testCase, FixtureFile file, Codec.Context context) {
                if (file.module() != null) return pure.run(testCase, file, context);
                if (!"scenario".equals(testCase.kind())) {
                    throw new HarnessError("E_BAD_CASE", file.path() + " names no module, so its cases must be scenarios");
                }
                return DeckWorld.run(testCase, context, "deck");
            }
        };
    }

    /**
     * {@code deckReportedRate({elementRate, pendingRate})}: no default for the object. The
     * element's rate is taken only as a finite number above 0; otherwise {@code pendingRate}
     * comes back exactly as it was handed.
     */
    private static Outcome deckReportedRate(List<Json> args) {
        Json s = param(args);
        if (s == null) return TYPE_ERROR;
        Double usable = DeckPolicy.deckReportedRate(at(s, "elementRate").asNumber(), null);
        if (usable != null) return ret(Json.num(usable));
        return ret(at(s, "pendingRate"));
    }

    /** A url the JS compares with {@code ===} after a truthiness check: null when falsy, a string otherwise. */
    private static String url(Json value, String what) {
        if (!JsArgs.truthy(value)) return null;
        String text = value.asString();
        if (text == null) throw JsArgs.notRepresentable(what, value);
        return text;
    }

    /** {@code warm} as the JS reads it: {@code {url, offset, ready, failed}}, or null when falsy. */
    private static DeckPolicy.Warm warm(Json value, String what) {
        if (!JsArgs.truthy(value)) return null;
        String url = at(value, "url").asString();
        if (url == null) throw JsArgs.notRepresentable(what + ".url", at(value, "url"));
        return new DeckPolicy.Warm("", url, number(at(value, "offset"), what + ".offset"),
                JsArgs.truthy(at(value, "ready")), JsArgs.truthy(at(value, "failed")));
    }

    /** {@code prefetchDecision({available, url, currentUrl, warm = null, offsetSec = 0})}. */
    private static Outcome prefetchDecision(List<Json> args) {
        Json s = param(args);
        if (s == null) return TYPE_ERROR;
        Json offsetField = at(s, "offsetSec");
        double offset = JsArgs.isUndefined(offsetField) ? 0 : number(offsetField, "prefetchDecision's offsetSec");
        DeckPolicy.PrefetchDecision answer = DeckPolicy.prefetchDecision(JsArgs.truthy(at(s, "available")),
                url(at(s, "url"), "prefetchDecision's url"), at(s, "currentUrl").asString(),
                warm(at(s, "warm"), "prefetchDecision's warm"), offset);
        return ret(Json.str(answer.token));
    }

    /** {@code warmSettled({offsetSec, atSec, canPlay})}: {@code atSec ?? 0}, {@code canPlay === true}. */
    private static Outcome warmSettled(List<Json> args) {
        Json s = param(args);
        if (s == null) return TYPE_ERROR;
        return ret(Json.bool(DeckPolicy.warmSettled(number(at(s, "offsetSec"), "warmSettled's offsetSec"),
                JsArgs.optionalNumber(at(s, "atSec"), "warmSettled's atSec"), JsArgs.isTrue(at(s, "canPlay")))));
    }

    /** {@code warmPromotion({warm, url, offsetSec, canPlay, atSec})}. */
    private static Outcome warmPromotion(List<Json> args) {
        Json s = param(args);
        if (s == null) return TYPE_ERROR;
        DeckPolicy.Promotion answer = DeckPolicy.warmPromotion(warm(at(s, "warm"), "warmPromotion's warm"),
                at(s, "url").asString(), number(at(s, "offsetSec"), "warmPromotion's offsetSec"),
                JsArgs.isTrue(at(s, "canPlay")), JsArgs.optionalNumber(at(s, "atSec"), "warmPromotion's atSec"));
        return ret(Json.str(answer.token));
    }

    /** {@code playRefusalAction({errorName, handoverUnproven, isPlayer = true, released = false})}. */
    private static Outcome playRefusalAction(List<Json> args) {
        Json s = param(args);
        if (s == null) return TYPE_ERROR;
        Json isPlayerField = at(s, "isPlayer");
        boolean isPlayer = JsArgs.isUndefined(isPlayerField) || JsArgs.truthy(isPlayerField);
        DeckPolicy.RefusalAction answer = DeckPolicy.playRefusalAction(at(s, "errorName").asString(),
                JsArgs.truthy(at(s, "handoverUnproven")), isPlayer, JsArgs.truthy(at(s, "released")));
        return ret(Json.str(answer.token));
    }

    /** {@code unexplainedPauseAction({expected, ended, warmInFlight})}. */
    private static Outcome unexplainedPauseAction(List<Json> args) {
        Json s = param(args);
        if (s == null) return TYPE_ERROR;
        DeckPolicy.UnexplainedPause answer = DeckPolicy.unexplainedPauseAction(JsArgs.truthy(at(s, "expected")),
                JsArgs.truthy(at(s, "ended")), JsArgs.truthy(at(s, "warmInFlight")));
        return ret(Json.str(answer.token));
    }

    /**
     * {@code prefetchWindowOpens({available, outPointSec, armed, paused, atSec, rate, leadSec, alreadyOpened = false,
     * durationSec = null})}. {@code durationSec} is read as JavaScript's {@code Number.isFinite(d) && d > 0} reads
     * it, through {@link DeckPolicy#windowBoundarySec}: a number or none (a value of another type is not
     * representable).
     */
    private static Outcome prefetchWindowOpens(List<Json> args) {
        Json s = param(args);
        if (s == null) return TYPE_ERROR;
        return ret(Json.bool(DeckPolicy.prefetchWindowOpens(JsArgs.truthy(at(s, "available")),
                JsArgs.optionalNumber(at(s, "outPointSec"), "prefetchWindowOpens's outPointSec"),
                JsArgs.truthy(at(s, "armed")), JsArgs.truthy(at(s, "paused")),
                number(at(s, "atSec"), "prefetchWindowOpens's atSec"), at(s, "rate").asNumber(),
                number(at(s, "leadSec"), "prefetchWindowOpens's leadSec"), JsArgs.truthy(at(s, "alreadyOpened")),
                JsArgs.optionalNumber(at(s, "durationSec"), "prefetchWindowOpens's durationSec"))));
    }

    /**
     * {@code warmsAcross({from = null, to = null} = {})} (NE-45j; card A-62): {@code !from || !to} is truthiness,
     * then {@code typeof to.audio_url === "string" && to.audio_url.length > 0}, then {@code to.kind === TTS ||
     * itemBounds({startSec: to.start_sec, endSec: to.end_sec}) != null} (a whole episode is never prepared).
     */
    private static Outcome warmsAcross(List<Json> args) {
        Json s = JsArgs.objectParam(arg(args, 0), true);
        if (s == null) return TYPE_ERROR;
        Json to = at(s, "to");
        boolean hasTo = JsArgs.truthy(to);
        ai.jwlabs.foura.engine.ItemBounds bounds = hasTo
                ? ai.jwlabs.foura.engine.ItemBounds.make(at(to, "start_sec").asNumber(), at(to, "end_sec").asNumber()) : null;
        return ret(Json.bool(DeckPolicy.warmsAcross(JsArgs.truthy(at(s, "from")), hasTo,
                hasTo ? at(to, "audio_url").asString() : null,
                hasTo && "tts".equals(at(to, "kind").asString()), bounds != null)));
    }
}
