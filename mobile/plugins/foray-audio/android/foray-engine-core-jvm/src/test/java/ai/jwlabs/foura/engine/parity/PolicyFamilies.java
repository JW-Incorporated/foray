package ai.jwlabs.foura.engine.parity;

import static ai.jwlabs.foura.engine.parity.JsArgs.arg;
import static ai.jwlabs.foura.engine.parity.JsArgs.at;
import static ai.jwlabs.foura.engine.parity.JsArgs.numberOrNull;
import static ai.jwlabs.foura.engine.parity.JsArgs.obj;
import static ai.jwlabs.foura.engine.parity.JsArgs.truthy;

import ai.jwlabs.foura.engine.PlaybackRate;
import ai.jwlabs.foura.engine.ResumeRules;
import ai.jwlabs.foura.engine.TransportPolicy;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Call;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Outcome;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Returned;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Threw;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The {@code rate}, {@code resume-rules} and {@code transport} families (A-23) against
 * {@link PlaybackRate}, {@link ResumeRules} and {@link TransportPolicy}: the JVM twins of
 * the Swift RateFamily, ResumeRulesFamily and TransportFamily.
 *
 * <p>TRANSLATION ONLY. Each mapping below is the JS parameter list it stands for (see
 * {@link JsArgs}), and every decision is the port's. A function taking ONE destructured
 * object with no default throws a TypeError for a missing or null argument before the
 * rule runs; {@link JsArgs#objectParam} says so.
 */
final class PolicyFamilies {
    private PolicyFamilies() {}

    private static Outcome ret(Json value) {
        return new Returned(value);
    }

    private static final Outcome TYPE_ERROR = new Threw("TypeError");

    // ---- rate (player/playback-rate.js)

    static final String RATE_MODULE = "player/playback-rate.js";

    /**
     * Every JS function here tests its argument with {@code typeof v === "number"} first,
     * so the one mapping is: a number is itself, every other value is null. The READS come
     * from the port, not from EngineConstants directly, so a port that stopped reading the
     * generated ladder would fail a case.
     */
    static FamilyRunner rate() {
        Map<String, Json> reads = new LinkedHashMap<>();
        reads.put("RATES", JsArgs.numbers(PlaybackRate.RATES));
        reads.put("DEFAULT_RATE", Json.num(PlaybackRate.DEFAULT_RATE));
        reads.put("MIN_RATE", Json.num(PlaybackRate.MIN_RATE));
        reads.put("MAX_RATE", Json.num(PlaybackRate.MAX_RATE));
        Map<String, Call> calls = new LinkedHashMap<>();
        calls.put("isRate", args -> ret(PlaybackRate.isRate(arg(args, 0).asNumber()) ? Json.TRUE : Json.FALSE));
        calls.put("normalizeRate", args -> ret(Json.num(PlaybackRate.normalize(arg(args, 0).asNumber()))));
        calls.put("nextRate", args -> ret(Json.num(PlaybackRate.next(arg(args, 0).asNumber()))));
        // utteranceRate takes a plain double, as the TTS plugin's does: a non-number is NaN,
        // "not a positive number" either way, and the port's guard is what answers it.
        calls.put("utteranceRate", args -> {
            Double m = arg(args, 0).asNumber();
            return ret(Json.num(PlaybackRate.utteranceRate(m == null ? Double.NaN : m)));
        });
        return new FamilyRunner.Pure("rate", RATE_MODULE, reads, calls);
    }

    // ---- resume-rules (three modules, one fixture file each)

    static final String POSITION_STORE_MODULE = "player/position-store.js";
    static final String QUEUE_MANAGER_MODULE = "player/queue-manager.js";
    static final String FORAY_PROGRESS_MODULE = "player/foray-progress.js";

    static FamilyRunner resumeRules() {
        Map<String, Json> storeReads = new LinkedHashMap<>();
        storeReads.put("MIN_RESUME_SEC", Json.num(ResumeRules.MIN_RESUME_SEC));
        storeReads.put("NEAR_END_SEC", Json.num(ResumeRules.NEAR_END_SEC));
        storeReads.put("POSITION_EVENT_EVERY_SEC", Json.num(ResumeRules.POSITION_EVENT_EVERY_SEC));
        Map<String, Call> storeCalls = new LinkedHashMap<>();
        storeCalls.put("resumeOffsetFor", PolicyFamilies::resumeOffsetFor);
        storeCalls.put("positionRow", PolicyFamilies::positionRow);
        storeCalls.put("positionEvent", PolicyFamilies::positionEvent);

        Map<String, Json> managerReads = new LinkedHashMap<>();
        managerReads.put("POSITION_INTERVAL_MS", Json.num(ResumeRules.POSITION_INTERVAL_MS));
        managerReads.put("POSITION_MIN_DELTA_SEC", Json.num(ResumeRules.POSITION_MIN_DELTA_SEC));

        return new FamilyRunner.MultiModule("resume-rules", List.of(
                new FamilyRunner.Pure("resume-rules", POSITION_STORE_MODULE, storeReads, storeCalls),
                new FamilyRunner.Pure("resume-rules", QUEUE_MANAGER_MODULE, managerReads,
                        Map.<String, Call>of("positionTickDue", PolicyFamilies::positionTickDue)),
                new FamilyRunner.Pure("resume-rules", FORAY_PROGRESS_MODULE,
                        Map.of("SAVE_EVERY_SEC", Json.num(ResumeRules.FORAY_WRITE_EVERY_SEC)),
                        Map.<String, Call>of("forayWriteDue", PolicyFamilies::forayWriteDue))));
    }

    /** {@code resumeOffsetFor(record, { duration = null } = {})}: the options are destructured first, so a null opts throws. */
    static Outcome resumeOffsetFor(List<Json> args) {
        Json opts = JsArgs.objectParam(arg(args, 1), true);
        if (opts == null) return TYPE_ERROR;
        Double callerDuration = JsArgs.optionalNumber(at(opts, "duration"), "resumeOffsetFor's opts.duration");
        Json recordArg = arg(args, 0);
        ResumeRules.StoredPosition record = null;
        if (truthy(recordArg)) { // `if (!record) return 0`
            // A row reaches this rule through `load`, which admits only a finite-number `seconds`.
            Double seconds = at(recordArg, "seconds").asNumber();
            if (seconds == null) throw JsArgs.notRepresentable("resumeOffsetFor's record.seconds", at(recordArg, "seconds"));
            record = new ResumeRules.StoredPosition(seconds,
                    JsArgs.optionalNumber(at(recordArg, "duration"), "resumeOffsetFor's record.duration"));
        }
        return ret(Json.num(ResumeRules.resumeOffset(record, callerDuration)));
    }

    /** {@code positionRow(id, seconds, meta = {}, updatedAt)}. */
    static Outcome positionRow(List<Json> args) {
        Json idArg = arg(args, 0);
        String id;
        if (idArg.asString() != null) id = idArg.asString();
        else if (!truthy(idArg)) id = ""; // `!id`: every falsy id is refused, as the empty string is
        else throw JsArgs.notRepresentable("positionRow's id", idArg);
        Double seconds = arg(args, 1).asNumber(); // `typeof seconds !== "number"` -> no row
        Json stampArg = arg(args, 3);
        String updatedAt;
        if (JsArgs.isUndefined(stampArg)) updatedAt = null;
        else if (stampArg.asString() != null) updatedAt = stampArg.asString();
        else throw JsArgs.notRepresentable("positionRow's updatedAt", stampArg);
        Json meta = arg(args, 2);
        if (JsArgs.isUndefined(meta)) meta = obj();
        if (JsArgs.isNull(meta)) {
            // The gate runs first; only a row that passes it reads `meta.duration`, which throws on null.
            return ResumeRules.positionRow(id, seconds, null, updatedAt) == null ? ret(Json.NULL) : TYPE_ERROR;
        }
        ResumeRules.PositionRow row = ResumeRules.positionRow(id, seconds, at(meta, "duration").asNumber(), updatedAt);
        if (row == null) return ret(Json.NULL);
        Map<String, Json> fields = new LinkedHashMap<>();
        fields.put("seconds", Json.num(row.seconds()));
        fields.put("duration", numberOrNull(row.duration()));
        if (row.updatedAt() != null) fields.put("updated_at", Json.str(row.updatedAt()));
        fields.put("source", Json.str(row.source()));
        return ret(new Json.Obj(fields));
    }

    /**
     * {@code positionEvent(lastEmitted, seconds, duration)}. {@code lastEmitted ?? 0} is
     * then compared with {@code === 0}, so only a number (or nothing) is representable;
     * {@code duration} is passed through into the event.
     */
    static Outcome positionEvent(List<Json> args) {
        Double last = JsArgs.optionalNumber(arg(args, 0), "positionEvent's lastEmitted");
        Double seconds = arg(args, 1).asNumber();
        if (seconds == null) throw JsArgs.notRepresentable("positionEvent's seconds", arg(args, 1));
        Json durationArg = arg(args, 2);
        // undefined would come back as a DROPPED key, which a Double cannot say.
        if (!JsArgs.isNull(durationArg) && durationArg.asNumber() == null) {
            throw JsArgs.notRepresentable("positionEvent's duration", durationArg);
        }
        ResumeRules.PositionEvent event = ResumeRules.positionEvent(last, seconds, durationArg.asNumber());
        if (event == null) return ret(Json.NULL);
        return ret(obj("mark", Json.num(event.mark()), "seconds", Json.num(event.seconds()), "duration", numberOrNull(event.duration())));
    }

    /** {@code positionTickDue(last, id, seconds)}: {@code last && last.id === id && Math.abs(seconds - last.seconds) < ...}. */
    static Outcome positionTickDue(List<Json> args) {
        String id = arg(args, 1).asString();
        if (id == null) throw JsArgs.notRepresentable("positionTickDue's id", arg(args, 1));
        Json lastArg = arg(args, 0);
        // `last.id === id` against a string id: a non-string never matches (null);
        // `seconds - last.seconds` is arithmetic (ToNumber).
        ResumeRules.LastWrite last = truthy(lastArg)
                ? new ResumeRules.LastWrite(at(lastArg, "id").asString(), JsArgs.toNumber(at(lastArg, "seconds")))
                : null;
        return ret(ResumeRules.positionTickDue(last, id, arg(args, 2).asNumber()) ? Json.TRUE : Json.FALSE);
    }

    /** {@code forayWriteDue(lastWritten, elapsedSec, { everySec = SAVE_EVERY_SEC, force = false } = {})}. */
    static Outcome forayWriteDue(List<Json> args) {
        Json opts = JsArgs.objectParam(arg(args, 2), true);
        if (opts == null) return TYPE_ERROR;
        Json every = at(opts, "everySec");
        double everySec = JsArgs.isUndefined(every) ? ResumeRules.FORAY_WRITE_EVERY_SEC : JsArgs.toNumber(every);
        boolean force = truthy(at(opts, "force")); // `force = false`, then `if (force ...)`
        Json lastArg = arg(args, 0);
        // `lastWritten == null`, then `elapsedSec - lastWritten` (ToNumber).
        Double last = JsArgs.isNullish(lastArg) ? null : JsArgs.toNumber(lastArg);
        return ret(ResumeRules.forayWriteDue(last, arg(args, 1).asNumber(), everySec, force) ? Json.TRUE : Json.FALSE);
    }

    // ---- transport (player/transport-policy.js)

    static final String TRANSPORT_MODULE = "player/transport-policy.js";

    static FamilyRunner transport() {
        Map<String, Json> reads = new LinkedHashMap<>();
        reads.put("RESTART_WINDOW_SEC", Json.num(TransportPolicy.RESTART_WINDOW_SEC));
        reads.put("SEEK_INSIDE_END_SEC", Json.num(TransportPolicy.SEEK_INSIDE_END_SEC));
        reads.put("SEEK_END_GUARD_SEC", Json.num(TransportPolicy.SEEK_END_GUARD_SEC));
        reads.put("INTERRUPTION_REWIND_SEC", Json.num(TransportPolicy.INTERRUPTION_REWIND_SEC));
        Map<String, Call> calls = new LinkedHashMap<>();
        calls.put("endedPlayAction", PolicyFamilies::endedPlayAction);
        calls.put("resolveToggle", PolicyFamilies::resolveToggle);
        calls.put("previousAction", PolicyFamilies::previousAction);
        calls.put("episodePreviousRestarts", PolicyFamilies::episodePreviousRestarts);
        calls.put("clampEpisodeTarget", PolicyFamilies::clampEpisodeTarget);
        calls.put("skipTarget", PolicyFamilies::skipTarget);
        calls.put("nudgeAction", PolicyFamilies::nudgeAction);
        calls.put("seekAction", PolicyFamilies::seekAction);
        calls.put("sourceOffsetFor", PolicyFamilies::sourceOffsetFor);
        calls.put("scrubTarget", PolicyFamilies::scrubTarget);
        calls.put("remoteStopAction", PolicyFamilies::remoteStopAction);
        calls.put("interruptionResumeOffset", PolicyFamilies::interruptionResumeOffset);
        return new FamilyRunner.Pure("transport", TRANSPORT_MODULE, reads, calls);
    }

    /** The one object parameter, or null for "throws a TypeError". */
    private static Json param(List<Json> args) {
        return JsArgs.objectParam(arg(args, 0), false);
    }

    /**
     * A queue item as {@code sourceOffsetFor} / {@code itemRuntimeSec} read it: {@code !item}
     * is no item; each number by {@code typeof} (no coercion); {@code item.kind === TTS};
     * {@code !item.audio_url} by truthiness.
     */
    static TransportPolicy.Item transportItem(Json value) {
        if (!truthy(value)) return null;
        return new TransportPolicy.Item(at(value, "start_sec").asNumber(), at(value, "end_sec").asNumber(),
                at(value, "authored_end_sec").asNumber(), at(value, "duration_sec").asNumber(), at(value, "kind").asString(),
                truthy(at(value, "audio_url")));
    }

    static Outcome endedPlayAction(List<Json> args) {
        Json s = param(args);
        if (s == null) return TYPE_ERROR;
        TransportPolicy.Toggle t = TransportPolicy.endedPlayAction(truthy(at(s, "foray")), at(s, "stateType").asString());
        return ret(t == null ? Json.NULL : Json.str(t.token));
    }

    /** {@code want === running} is a STRICT comparison, so both must be real booleans. */
    static Outcome resolveToggle(List<Json> args) {
        Json s = param(args);
        if (s == null) return TYPE_ERROR;
        boolean want = JsArgs.strictBool(at(s, "want"), "resolveToggle's want");
        boolean running = JsArgs.strictBool(at(s, "running"), "resolveToggle's running");
        return ret(Json.str(TransportPolicy.resolveToggle(want, truthy(at(s, "restored")), truthy(at(s, "foray")),
                at(s, "stateType").asString(), running, truthy(at(s, "hasCurrent")),
                at(s, "queueLength").asNumber()).token)); // `=== 0`: only a number can be 0
    }

    /**
     * {@code positionSec == null} (loose, so undefined too) is the jump in flight; otherwise
     * {@code index > 0} and {@code positionSec - segmentStartSec} are ARITHMETIC, so they coerce.
     */
    static Outcome previousAction(List<Json> args) {
        Json s = param(args);
        if (s == null) return TYPE_ERROR;
        Json position = at(s, "positionSec");
        return ret(Json.str(TransportPolicy.previousAction(JsArgs.toNumber(at(s, "index")),
                JsArgs.isNullish(position) ? null : JsArgs.toNumber(position), JsArgs.toNumber(at(s, "segmentStartSec"))).token));
    }

    /** {@code positionSec >= 4} against a number coerces. */
    static Outcome episodePreviousRestarts(List<Json> args) {
        Json s = param(args);
        if (s == null) return TYPE_ERROR;
        return ret(TransportPolicy.episodePreviousRestarts(JsArgs.toNumber(at(s, "positionSec"))) ? Json.TRUE : Json.FALSE);
    }

    /** {@code clampEpisodeTarget(seconds, dur)}: {@code Number(seconds)}, then {@code dur ? ...}. */
    static Outcome clampEpisodeTarget(List<Json> args) {
        Double duration = JsArgs.truthyNumber(arg(args, 1), "clampEpisodeTarget's dur");
        return ret(numberOrNull(TransportPolicy.clampEpisodeTarget(JsArgs.toNumber(arg(args, 0)), duration)));
    }

    /**
     * {@code skipTarget({ foray, positionSec, offsetSec, durationSec = null })}.
     * {@code positionSec + offset} would CONCATENATE a string, so the position must be a
     * number; the offset and the duration are read by truthiness.
     */
    static Outcome skipTarget(List<Json> args) {
        Json s = param(args);
        if (s == null) return TYPE_ERROR;
        Double position = at(s, "positionSec").asNumber();
        if (position == null) throw JsArgs.notRepresentable("skipTarget's positionSec", at(s, "positionSec"));
        Double offset = JsArgs.truthyNumber(at(s, "offsetSec"), "skipTarget's offsetSec");
        Double duration = JsArgs.truthyNumber(at(s, "durationSec"), "skipTarget's durationSec");
        return ret(numberOrNull(TransportPolicy.skipTarget(truthy(at(s, "foray")), position, offset, duration)));
    }

    /** The three flags by truthiness; {@code offsetSec < 0} coerces. */
    static Outcome nudgeAction(List<Json> args) {
        Json s = param(args);
        if (s == null) return TYPE_ERROR;
        return ret(Json.str(TransportPolicy.nudgeAction(JsArgs.toNumber(at(s, "offsetSec")), truthy(at(s, "landsInCurrentItem")),
                truthy(at(s, "narrationPlayhead")), truthy(at(s, "onLastItem"))).token));
    }

    static Outcome seekAction(List<Json> args) {
        Json s = param(args);
        if (s == null) return TYPE_ERROR;
        return ret(Json.str(TransportPolicy.seekAction(truthy(at(s, "restored")), at(s, "stateType").asString()).token));
    }

    /** {@code sourceOffsetFor(item, into)}: {@code Number.isFinite(into)} does not coerce. */
    static Outcome sourceOffsetFor(List<Json> args) {
        return ret(numberOrNull(TransportPolicy.sourceOffset(transportItem(arg(args, 0)), arg(args, 1).asNumber())));
    }

    /**
     * {@code scrubTarget({ at, item, currentIndex, stateType })}: {@code !at} is nowhere;
     * {@code at.index} is passed through, so it must be a number; {@code at.index !==
     * currentIndex} is strict, so a non-number index is null.
     */
    static Outcome scrubTarget(List<Json> args) {
        Json s = param(args);
        if (s == null) return TYPE_ERROR;
        Json atArg = at(s, "at");
        if (!truthy(atArg)) return ret(Json.NULL);
        Double index = at(atArg, "index").asNumber();
        if (index == null) throw JsArgs.notRepresentable("scrubTarget's at.index", at(atArg, "index"));
        TransportPolicy.Scrub scrub = TransportPolicy.scrubTarget(index, at(atArg, "into").asNumber(), transportItem(at(s, "item")),
                at(s, "currentIndex").asNumber(), at(s, "stateType").asString());
        return ret(obj("index", Json.num(scrub.index()), "reload", scrub.reload() ? Json.TRUE : Json.FALSE,
                "offset", numberOrNull(scrub.offset())));
    }

    /** {@code interruptionResumeOffset({ playheadSec, startSec = null })}: any non-number is "no number". */
    static Outcome interruptionResumeOffset(List<Json> args) {
        Json s = param(args);
        if (s == null) return TYPE_ERROR;
        return ret(numberOrNull(TransportPolicy.interruptionResumeOffset(at(s, "playheadSec").asNumber(),
                at(s, "startSec").asNumber())));
    }

    /** {@code remoteStopAction(details)}: {@code details?.close === true}. */
    static Outcome remoteStopAction(List<Json> args) {
        Json details = arg(args, 0);
        Boolean close = null;
        if (!JsArgs.isNullish(details) && at(details, "close") instanceof Json.Bool b) close = b.value();
        return ret(Json.str(TransportPolicy.remoteStopAction(close).token));
    }
}
