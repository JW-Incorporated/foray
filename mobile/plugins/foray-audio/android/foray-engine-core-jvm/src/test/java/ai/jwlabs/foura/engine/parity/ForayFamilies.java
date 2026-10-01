package ai.jwlabs.foura.engine.parity;

import static ai.jwlabs.foura.engine.parity.JsArgs.arg;
import static ai.jwlabs.foura.engine.parity.JsArgs.at;

import ai.jwlabs.foura.engine.ForayClock;
import ai.jwlabs.foura.engine.ForayItem;
import ai.jwlabs.foura.engine.Interlude;
import ai.jwlabs.foura.engine.MediaMapping;
import ai.jwlabs.foura.engine.SeamGap;
import ai.jwlabs.foura.engine.SeekPolicy;
import ai.jwlabs.foura.engine.StructuralCheck;
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
 * The A-40 policy families, the JVM twins of the Swift SeamGapFamily, SeekPolicyFamily,
 * InterludeFamily and ForayFamilies (ForayClockFamily, ForayStructureFamily, MediaFamily):
 * {@code seam-gap}, {@code seek-policy}, {@code interlude}, {@code foray-clock},
 * {@code foray-structure} and {@code media}.
 *
 * <p>TRANSLATION, NEVER DECISION: each mapping below is the line of JS that reads the field.
 * <pre>
 *   {...} = {}          no argument is {}; null THROWS (destructuring null)
 *   bridged = false     absent -> false, otherwise JS truthiness
 *   cause = AUTO_ADVANCE   absent -> "auto"; a non-string can never equal "auto"
 *   gapSec = SEAM_GAP_SEC  absent -> the default; a non-number maps to NaN (the same JS branch)
 *   typeof x === "number"  durations and the pad: null for any non-number; NaN and the
 *                          infinities pass through as themselves
 * </pre>
 */
final class ForayFamilies {
    private ForayFamilies() {}

    private static final Outcome TYPE_ERROR = new Threw("TypeError");

    /** Never equal to "auto" (nor to any string a fixture could spell). */
    static final String NON_STRING_CAUSE = "\u0000non-string cause";

    // ---- seam-gap (player/seam-gap.js)

    static FamilyRunner seamGap() {
        Map<String, Json> reads = new LinkedHashMap<>();
        reads.put("SEAM_GAP_SEC", Json.num(SeamGap.DEFAULT_GAP_SEC));
        reads.put("AUTO_ADVANCE", Json.str(SeamGap.AUTO_ADVANCE));
        reads.put("USER_ACTION", Json.str(SeamGap.USER_ACTION));
        Map<String, Call> calls = new LinkedHashMap<>();
        calls.put("seamGapSec", args -> {
            Json seam = arg(args, 0);
            if (JsArgs.isNull(seam)) return TYPE_ERROR;
            Json rawCause = at(seam, "cause");
            String cause = JsArgs.isUndefined(rawCause) ? SeamGap.AUTO_ADVANCE
                    : rawCause.asString() != null ? rawCause.asString() : NON_STRING_CAUSE;
            Json rawGap = at(seam, "gapSec");
            double gap = JsArgs.isUndefined(rawGap) ? SeamGap.DEFAULT_GAP_SEC : rawGap.asNumber() != null ? rawGap.asNumber() : Double.NaN;
            double sec = SeamGap.gapSec(seamItem(at(seam, "from"), false), seamItem(at(seam, "to"), false),
                    JsArgs.truthy(at(seam, "bridged")), cause, gap);
            return new Returned(Json.num(sec));
        });
        calls.put("isSegment", args -> new Returned(Json.bool(SeamGap.isSegment(seamItem(arg(args, 0), true)))));
        return new FamilyRunner.Pure("seam-gap", "player/seam-gap.js", reads, calls);
    }

    /** {@code item?.start_sec}, {@code item?.end_sec}; a falsy side of a seam is no item at all ({@code !from}). */
    static SeamGap.SeamItem seamItem(Json value, boolean keepFalsy) {
        if (!keepFalsy && !JsArgs.truthy(value)) return null;
        return new SeamGap.SeamItem(at(value, "start_sec").asNumber(), at(value, "end_sec").asNumber());
    }

    // ---- seek-policy (player/seek-policy.js)

    static FamilyRunner seekPolicy() {
        Map<String, Json> reads = new LinkedHashMap<>();
        reads.put("DRIFT_TOLERANCE_SEC", Json.num(SeekPolicy.DRIFT_TOLERANCE_SEC));
        reads.put("AD_PAD_CEILING_SEC", Json.num(SeekPolicy.AD_PAD_CEILING_SEC));
        reads.put("OWN", Json.str(SeekPolicy.OWN));
        reads.put("FOREIGN", Json.str(SeekPolicy.FOREIGN));
        reads.put("EXACT", Json.str(SeekPolicy.Precision.EXACT.token));
        reads.put("APPROXIMATE", Json.str(SeekPolicy.Precision.APPROXIMATE.token));
        reads.put("PADDED", Json.str(SeekPolicy.Precision.PADDED.token));
        Map<String, Call> calls = new LinkedHashMap<>();
        calls.put("seekPrecision", args -> {
            SeekPolicy.Verdict verdict = verdict(args);
            return verdict == null ? TYPE_ERROR : new Returned(encode(verdict));
        });
        calls.put("canSeekExactly", args -> {
            SeekPolicy.Verdict verdict = verdict(args);
            return verdict == null ? TYPE_ERROR : new Returned(Json.bool(SeekPolicy.canSeekExactly(verdict)));
        });
        calls.put("canPlaySegment", args -> {
            SeekPolicy.Verdict verdict = verdict(args);
            return verdict == null ? TYPE_ERROR : new Returned(Json.bool(SeekPolicy.canPlaySegment(verdict)));
        });
        calls.put("locateStep", args -> {
            SeekPolicy.LocateStep step = SeekPolicy.locateStep();
            return new Returned(JsArgs.obj("implemented", Json.bool(step.implemented()), "reason", Json.str(step.reason())));
        });
        calls.put("segmentLoadGate", args -> {
            Json item = arg(args, 0);
            Json opts = JsArgs.objectParam(arg(args, 1), true);
            if (opts == null) return TYPE_ERROR;
            SeekPolicy.LoadGate gate = SeekPolicy.segmentLoadGate(JsArgs.truthy(at(item, "needs_drift_check")),
                    JsArgs.truthy(at(item, "dai_suspected")), at(item, "reference_duration_sec").asNumber(),
                    at(item, "ad_pad_sec").asNumber(), at(opts, "observedDuration").asNumber(), JsArgs.truthy(at(opts, "isLocalFile")),
                    JsArgs.truthy(at(opts, "allowAdPad")));
            Map<String, Json> fields = new LinkedHashMap<>();
            fields.put("ok", Json.bool(gate.ok()));
            if (gate.reason() != null) fields.put("reason", Json.str(gate.reason()));
            if (gate.note() != null) fields.put("note", Json.str(gate.note()));
            return new Returned(new Json.Obj(fields));
        });
        return new FamilyRunner.Pure("seek-policy", "player/seek-policy.js", reads, calls);
    }

    /** {@code seekPrecision(item, ctx = {})}, or null for "destructuring null threw". */
    static SeekPolicy.Verdict verdict(List<Json> args) {
        Json item = arg(args, 0);
        Json ctx = JsArgs.objectParam(arg(args, 1), true);
        if (ctx == null) return null;
        Json rawSource = at(ctx, "source");
        String source = JsArgs.isUndefined(rawSource) ? SeekPolicy.FOREIGN : rawSource.asString();
        return SeekPolicy.seekPrecision(JsArgs.truthy(at(item, "dai_suspected")), JsArgs.truthy(at(ctx, "isLocalFile")), source,
                at(ctx, "observedDuration").asNumber(), at(ctx, "recordedDuration").asNumber(), at(ctx, "adPadSec").asNumber(),
                JsArgs.truthy(at(ctx, "allowAdPad")));
    }

    /** {@code {precision, reason}}, plus {@code padSec} when padded. */
    static Json encode(SeekPolicy.Verdict verdict) {
        Map<String, Json> fields = new LinkedHashMap<>();
        fields.put("precision", Json.str(verdict.precision().token));
        fields.put("reason", Json.str(verdict.reason()));
        if (verdict.padSec() != null) fields.put("padSec", Json.num(verdict.padSec()));
        return new Json.Obj(fields);
    }

    // ---- interlude (player/interlude.js)

    static FamilyRunner interlude() {
        Map<String, Json> reads = new LinkedHashMap<>();
        reads.put("INTERLUDE_DURATION_SEC", Json.num(Interlude.DURATION_SEC));
        reads.put("INTERLUDE_CEILING_SEC", Json.num(Interlude.CEILING_SEC));
        reads.put("INTERLUDE_RATE", Json.num(Interlude.RATE));
        reads.put("INTERLUDE_ASSET_URL", Json.str(Interlude.ASSET_URL));
        Map<String, Call> calls = new LinkedHashMap<>();
        calls.put("interludeEligible", args -> {
            Json seam = JsArgs.objectParam(arg(args, 0), true);
            if (seam == null) return TYPE_ERROR;
            Json rawCause = at(seam, "cause");
            String cause = JsArgs.isUndefined(rawCause) ? SeamGap.AUTO_ADVANCE : rawCause.asString();
            Interlude.InterludeItem from = JsArgs.truthy(at(seam, "from")) ? interludeItem(at(seam, "from")) : null;
            Interlude.InterludeItem to = JsArgs.truthy(at(seam, "to")) ? interludeItem(at(seam, "to")) : null;
            return new Returned(Json.bool(Interlude.eligible(from, to, cause)));
        });
        calls.put("sameSourceEpisode", args -> {
            Json from = arg(args, 0);
            Json to = arg(args, 1);
            return new Returned(Json.bool(Interlude.sameSourceEpisode(JsArgs.isNullish(from) ? null : interludeItem(from),
                    JsArgs.isNullish(to) ? null : interludeItem(to))));
        });
        calls.put("silenceNodeSec", args -> {
            Json s = JsArgs.objectParam(arg(args, 0), true);
            if (s == null) return TYPE_ERROR;
            return new Returned(Json.num(Interlude.silenceNodeSec(at(s, "sinceOutPointSec").asNumber(), JsArgs.isTrue(at(s, "running")),
                    JsArgs.isTrue(at(s, "sessionActive")))));
        });
        return new FamilyRunner.Pure("interlude", "player/interlude.js", reads, calls);
    }

    /** A queue item as the interlude rule reads it; any non-object reads as all-undefined fields. */
    static Interlude.InterludeItem interludeItem(Json value) {
        return new Interlude.InterludeItem(at(value, "kind").asString(), at(value, "type").asString(),
                at(value, "source_item_id").asString(), at(value, "item_id").asString(), at(value, "audio_url").asString(),
                at(value, "start_sec").asNumber(), at(value, "end_sec").asNumber());
    }

    // ---- foray-clock (player/foray-queue.js, player/foray-resolve.js, player/parity/forays.js)

    static final String QUEUE_MODULE = "player/foray-queue.js";
    static final String RESOLVE_MODULE = "player/foray-resolve.js";

    static FamilyRunner forayClock() {
        Map<String, Json> reads = new LinkedHashMap<>();
        reads.put("JINGLE_DURATION_SEC", Json.num(ForayClock.JINGLE_DURATION_SEC));
        reads.put("NARRATION_CHARS_PER_SEC", Json.num(ForayClock.NARRATION_CHARS_PER_SEC));
        reads.put("NARRATION_FALLBACK_SEC", Json.num(ForayClock.NARRATION_FALLBACK_SEC));
        reads.put("DURATION_MEASURED", Json.str(ForayClock.DURATION_MEASURED));
        reads.put("DURATION_ESTIMATED", Json.str(ForayClock.DURATION_ESTIMATED));
        reads.put("DURATION_FALLBACK", Json.str(ForayClock.DURATION_FALLBACK));
        reads.put("JINGLE", Json.str(ForayClock.JINGLE));
        Map<String, Call> queue = new LinkedHashMap<>();
        queue.put("narrationDuration", args -> {
            ForayClock.NarrationDuration d = ForayClock.narrationDuration(ForayHarness.item(arg(args, 0)));
            return new Returned(JsArgs.obj("sec", Json.num(d.sec()), "source", Json.str(d.source())));
        });
        queue.put("itemRuntimeSec", args -> new Returned(Json.num(ForayClock.itemRuntimeSec(ForayHarness.item(arg(args, 0))))));
        queue.put("forayRuntimeSec", args -> new Returned(Json.num(ForayClock.forayRuntimeSec(
                ForayHarness.items(arg(args, 0), "forayRuntimeSec's items")))));
        queue.put("runtimeIsEstimated", args -> {
            // `Array.isArray(items)` first: anything else is simply false.
            List<Json> values = arg(args, 0).asList();
            if (values == null) return new Returned(Json.FALSE);
            List<ForayItem> items = new ArrayList<>();
            for (Json v : values) items.add(ForayHarness.item(v));
            return new Returned(Json.bool(ForayClock.runtimeIsEstimated(items)));
        });
        Map<String, Call> resolve = new LinkedHashMap<>();
        resolve.put("segmentStarts", args -> new Returned(JsArgs.numbers(ForayClock.segmentStarts(
                ForayHarness.items(arg(args, 0), "segmentStarts's items")))));
        resolve.put("segmentAtElapsed", args -> {
            List<ForayItem> items = ForayHarness.items(arg(args, 0), "segmentAtElapsed's items");
            ForayClock.Position at = ForayClock.segmentAtElapsed(items, arg(args, 1).asNumber());
            if (at == null) return new Returned(Json.NULL);
            return new Returned(JsArgs.obj("index", Json.num(at.index()), "into", Json.num(at.into()), "start", Json.num(at.start())));
        });
        resolve.put("forayElapsed", args -> new Returned(Json.num(ForayClock.forayElapsed(
                ForayHarness.items(arg(args, 0), "forayElapsed's items"), arg(args, 1).asNumber(), arg(args, 2).asNumber()))));
        resolve.put("progressSegments", ForayFamilies::progressSegments);
        Map<String, FamilyRunner> routes = new LinkedHashMap<>();
        routes.put(QUEUE_MODULE, new FamilyRunner.Pure("foray-clock", QUEUE_MODULE, reads, queue));
        routes.put(RESOLVE_MODULE, new FamilyRunner.Pure("foray-clock", RESOLVE_MODULE, Map.of(), resolve));
        routes.put(ForayHarness.FORAYS_MODULE, new ForayHarness.ForaysModule("foray-clock"));
        return new ForayHarness.ModuleRouted("foray-clock", routes);
    }

    /**
     * {@code progressSegments(resolved)}: {@code resolved?.playable ?? []} and
     * {@code resolved?.entries ?? []}; an entry is used when
     * {@code e && e.playable && Number.isInteger(e.queueIndex)}, with {@code e.segment_id ?? null}
     * as its id (only a string id translates).
     */
    static Outcome progressSegments(List<Json> args) {
        Json resolved = arg(args, 0);
        List<ForayItem> items = ForayHarness.items(at(resolved, "playable"), "progressSegments's playable");
        Json rawEntries = at(resolved, "entries");
        List<ForayClock.ProgressEntry> entries;
        if (JsArgs.isNullish(rawEntries)) {
            entries = null;
        } else if (rawEntries.asList() != null) {
            entries = new ArrayList<>();
            for (Json entry : rawEntries.asList()) {
                if (!JsArgs.truthy(entry)) {
                    entries.add(null);
                    continue;
                }
                Json id = at(entry, "segment_id");
                if (!JsArgs.isNullish(id) && id.asString() == null) throw JsArgs.notRepresentable("an entry's segment_id", id);
                entries.add(new ForayClock.ProgressEntry(JsArgs.truthy(at(entry, "playable")), at(entry, "queueIndex").asNumber(),
                        id.asString()));
            }
        } else {
            throw JsArgs.notRepresentable("progressSegments's entries", rawEntries);
        }
        List<Json> out = new ArrayList<>();
        for (ForayClock.ProgressSegment row : ForayClock.progressSegments(items, entries)) {
            out.add(JsArgs.obj("id", JsArgs.stringOrNull(row.id()), "startSec", Json.num(row.startSec()), "durationSec",
                    Json.num(row.durationSec())));
        }
        return new Returned(new Json.Arr(out));
    }

    // ---- foray-structure (player/foray-structure.js)

    static final String STRUCTURE_MODULE = "player/foray-structure.js";

    static FamilyRunner forayStructure() {
        Map<String, Json> reads = new LinkedHashMap<>();
        reads.put("REFUSED_STRUCTURE", Json.str(StructuralCheck.REFUSED_STRUCTURE));
        reads.put("QUEUE_KINDS", JsArgs.strings(StructuralCheck.QUEUE_KINDS));
        reads.put("STRUCTURE_PROBLEMS", JsArgs.strings(StructuralCheck.PROBLEM_CODES));
        Map<String, Call> calls = new LinkedHashMap<>();
        calls.put("structuralCheck", args -> {
            // `!Array.isArray(items)` is `empty`, whatever it is.
            List<Json> values = arg(args, 0).asList();
            if (values == null) return new Returned(ForayHarness.encode(StructuralCheck.check(null)));
            List<ForayItem> items = new ArrayList<>();
            for (Json v : values) items.add(ForayHarness.item(v));
            return new Returned(ForayHarness.encode(StructuralCheck.check(items)));
        });
        calls.put("seamCensus", args -> {
            // `Array.isArray(items) ? items : []`.
            Json value = arg(args, 0);
            if (value.asList() == null) return new Returned(ForayHarness.encode(StructuralCheck.seamCensus(null)));
            return new Returned(ForayHarness.encode(StructuralCheck.seamCensus(ForayHarness.censusItems(value))));
        });
        Map<String, FamilyRunner> routes = new LinkedHashMap<>();
        routes.put(STRUCTURE_MODULE, new FamilyRunner.Pure("foray-structure", STRUCTURE_MODULE, reads, calls));
        routes.put(ForayHarness.FORAYS_MODULE, new ForayHarness.ForaysModule("foray-structure"));
        return new ForayHarness.ModuleRouted("foray-structure", routes);
    }

    // ---- media (the Foray half of media-session.js, the committed Forays, remote presses into a Foray)

    static FamilyRunner media() {
        FamilyRunner.Pure episode = MediaEpisodeFamily.mappingRunner();
        Map<String, Call> calls = new LinkedHashMap<>(episode.calls());
        calls.putIfAbsent("narrationCredit", ForayFamilies::narrationCredit);
        Map<String, FamilyRunner> routes = new LinkedHashMap<>();
        routes.put(MediaEpisodeFamily.MAPPING_MODULE, new FamilyRunner.Pure("media", MediaEpisodeFamily.MAPPING_MODULE, episode.reads(),
                calls));
        routes.put(ForayHarness.FORAYS_MODULE, new ForayHarness.ForaysModule("media"));
        routes.put(ForayHarness.SCENARIOS, new MediaRemote(new EngineScenarioDriver()));
        return new ForayHarness.ModuleRouted("media", routes);
    }

    /** {@code narrationCredit({forayTitle = "", nextItem = null} = {})}: null throws. */
    static Outcome narrationCredit(List<Json> args) {
        Json opts = JsArgs.objectParam(arg(args, 0), true);
        if (opts == null) return TYPE_ERROR;
        String title = JsArgs.isUndefined(at(opts, "forayTitle")) ? "" : at(opts, "forayTitle").asString();
        return new Returned(Json.str(MediaMapping.narrationCredit(title, MediaEpisodeFamily.item(at(opts, "nextItem")))));
    }

    /** remote.json: a Foray loaded into the engine, pressed from the lock screen. */
    record MediaRemote(EngineScenarioDriver driver) implements FamilyRunner {
        @Override
        public String family() {
            return "media";
        }

        @Override
        public Json run(FixtureCase testCase, FixtureFile file, Codec.Context context) {
            if (!"scenario".equals(testCase.kind())) {
                throw new HarnessError("E_BAD_CASE", file.path() + " names no module, so its cases must be scenarios");
            }
            return driver.run(testCase, context).encoded();
        }
    }
}
