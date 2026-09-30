package ai.jwlabs.foura.engine.parity;

import static ai.jwlabs.foura.engine.parity.JsArgs.at;

import ai.jwlabs.foura.engine.EngineConstants;
import ai.jwlabs.foura.engine.ForayClock;
import ai.jwlabs.foura.engine.ForayItem;
import ai.jwlabs.foura.engine.JSMath;
import ai.jwlabs.foura.engine.MediaMapping;
import ai.jwlabs.foura.engine.StructuralCheck;
import ai.jwlabs.foura.engine.parity.ParityData.FixtureCase;
import ai.jwlabs.foura.engine.parity.ParityData.FixtureFile;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

/**
 * What the A-40 families share (the JVM twin of the Swift ForayHarness.swift, NE-29s): reading a
 * built queue item the way the JS rules read it, routing a family's files by module, and the
 * committed Forays ({@code player/parity/forays.js}).
 *
 * <p>THE ONE JOB HERE IS TRANSLATION, NEVER DECISION. Where JavaScript would do something with a
 * value that a typed port has no parameter for, the case fails as {@code E_BAD_CASE} ("not
 * representable") rather than this file picking an answer.
 */
final class ForayHarness {
    private ForayHarness() {}

    // ---- ForayArgs

    /**
     * One queue item: null when it is not a plain object (JS {@code isPlain}). Every field is read
     * with the JS rule's own type test ({@code isNum}, {@code typeof s === "string"},
     * {@code === true}), which a null stands for.
     */
    static ForayItem item(Json value) {
        if (!(value instanceof Json.Obj)) return null;
        return new ForayItem(s(value, "id"), s(value, "kind"), s(value, "type"), s(value, "title"), s(value, "show"),
                s(value, "audio_url"), n(value, "start_sec"), n(value, "end_sec"), n(value, "authored_end_sec"),
                n(value, "duration_sec"), s(value, "duration_source"), s(value, "script"), s(value, "source_item_id"),
                s(value, "item_id"), JsArgs.isTrue(at(value, "dai_suspected")), JsArgs.isTrue(at(value, "needs_drift_check")),
                s(value, "start_anchor"), s(value, "end_anchor"), n(value, "reference_duration_sec"));
    }

    private static String s(Json value, String key) {
        return at(value, key).asString();
    }

    private static Double n(Json value, String key) {
        return at(value, key).asNumber();
    }

    /**
     * {@code items ?? []} then iterated: null/undefined are no list (null), an array is its items.
     * Anything else makes the JS throw on iteration or read a {@code length} a typed list does not
     * have: not representable.
     */
    static List<ForayItem> items(Json value, String what) {
        if (JsArgs.isNullish(value)) return null;
        List<Json> values = value.asList();
        if (values == null) throw JsArgs.notRepresentable(what, value);
        List<ForayItem> out = new ArrayList<>();
        for (Json v : values) out.add(item(v));
        return out;
    }

    /**
     * The seam census reads a null entry as "no item" and any other non-object through {@code ?.},
     * where a truthy primitive would count as an item with no fields. Only the first has a null
     * spelling. And {@code from.source_item_id !== to.source_item_id} tells null from undefined,
     * which one null cannot: only a string or an absent id translates.
     */
    static List<ForayItem> censusItems(Json value) {
        List<Json> values = value.asList();
        if (values == null) return items(value, "seamCensus's items");
        List<ForayItem> out = new ArrayList<>();
        for (Json entry : values) {
            if (entry instanceof Json.Obj) {
                Json source = at(entry, "source_item_id");
                if (!JsArgs.isUndefined(source) && source.asString() == null) {
                    throw JsArgs.notRepresentable("a census item's source_item_id", source);
                }
                out.add(item(entry));
                continue;
            }
            if (JsArgs.truthy(entry)) throw JsArgs.notRepresentable("a census entry", entry);
            out.add(null);
        }
        return out;
    }

    static Json encode(StructuralCheck.Verdict verdict) {
        List<Json> problems = new ArrayList<>();
        for (StructuralCheck.Problem p : verdict.problems()) {
            problems.add(JsArgs.obj("index", Json.num(p.index()), "code", Json.str(p.code())));
        }
        return JsArgs.obj("ok", Json.bool(verdict.ok()), "reason", JsArgs.stringOrNull(verdict.reason()), "problems",
                new Json.Arr(problems));
    }

    static Json encode(StructuralCheck.Census census) {
        return JsArgs.obj("items", Json.num(census.items()), "segments", Json.num(census.segments()), "seams",
                Json.num(census.seams()), "beats", Json.num(census.beats()), "jingles", Json.num(census.jingles()),
                "sameSource", Json.num(census.sameSource()), "sourceChanges", Json.num(census.sourceChanges()));
    }

    /** A parsed JSON value as JavaScript holds it after {@code JSON.parse} (a repeated key: the last wins). */
    static Json value(ai.jwlabs.foura.engine.JsonNode node) {
        return switch (node) {
            case ai.jwlabs.foura.engine.JsonNode.Null x -> Json.NULL;
            case ai.jwlabs.foura.engine.JsonNode.Bool b -> Json.bool(b.value());
            case ai.jwlabs.foura.engine.JsonNode.Num x -> Json.num(x.value());
            case ai.jwlabs.foura.engine.JsonNode.Str x -> Json.str(x.value());
            case ai.jwlabs.foura.engine.JsonNode.Arr a -> {
                List<Json> items = new ArrayList<>();
                for (ai.jwlabs.foura.engine.JsonNode item : a.items()) items.add(value(item));
                yield new Json.Arr(items);
            }
            case ai.jwlabs.foura.engine.JsonNode.Obj o -> {
                Map<String, Json> fields = new LinkedHashMap<>();
                for (ai.jwlabs.foura.engine.JsonNode.Member m : o.members()) fields.put(m.key(), value(m.value()));
                yield new Json.Obj(fields);
            }
        };
    }

    // ---- routing by module

    /** The key a scenario file (one that names no module) is routed under. */
    static final String SCENARIOS = "(scenarios)";

    /**
     * A family whose fixture files are run by different parts, chosen by the FILE's module (a
     * scenario file names none). A file naming any other module is refused.
     */
    record ModuleRouted(String family, Map<String, FamilyRunner> routes) implements FamilyRunner {
        @Override
        public Json run(FixtureCase testCase, FixtureFile file, Codec.Context context) {
            String key = file.module() == null ? SCENARIOS : file.module();
            FamilyRunner part = routes.get(key);
            if (part == null) {
                throw new HarnessError("E_BAD_CASE", file.path() + " targets " + (file.module() == null ? "no module" : file.module())
                        + "; the JVM " + family + " runner ports " + String.join(", ", new TreeSet<>(routes.keySet())));
            }
            return part.run(testCase, file, context);
        }
    }

    // ---- the committed Forays (player/parity/forays.js)

    static final String FORAYS_MODULE = "player/parity/forays.js";
    static final String BUILDS_FILE = "player/parity/foray-builds.json";

    /**
     * The committed Forays, shared by the foray-clock, foray-structure and media families. THE
     * BUILD IS THE PAGE'S: every function in forays.js takes the RAW authored Foray and asks a rule
     * about the page's BUILD of it, which the engine never makes, so the build is read from
     * {@code player/parity/foray-builds.json} (emitted from the real JS build and checked by
     * run.test.js). The rule under test is then the JVM port's, over exactly the items
     * {@code playForay} would carry.
     */
    record ForaysModule(String family) implements FamilyRunner {
        @Override
        public Json run(FixtureCase testCase, FixtureFile file, Codec.Context context) {
            if (!FORAYS_MODULE.equals(file.module())) {
                throw new HarnessError("E_BAD_CASE", file.path() + " targets " + file.module() + "; this part ports " + FORAYS_MODULE);
            }
            if (!"call".equals(testCase.kind())) throw new HarnessError("E_BAD_CASE", FORAYS_MODULE + " cases are calls");
            String name = testCase.raw().get("call").asString();
            List<Json> args = new ArrayList<>();
            for (Json arg : testCase.args()) args.add(Codec.expandInputs(arg, context));
            Json result;
            switch (name) {
                case "committedForays" -> result = JsArgs.obj("atLeastTwo", Json.bool(committedCount(context) >= 2));
                case "frozenCensus" -> {
                    String id = JsArgs.arg(args, 0).asString();
                    if (id == null) throw new HarnessError("E_BAD_CASE", "frozenCensus takes a Foray id");
                    List<Json> items = table(context).frozen().get(id);
                    if (items == null) {
                        throw new HarnessError("E_BAD_CASE", id + " has no frozen build in " + BUILDS_FILE
                                + "; run node tools/parity/foray-builds.mjs --write");
                    }
                    result = encode(StructuralCheck.seamCensus(censusItems(new Json.Arr(items))));
                }
                default -> {
                    Built built = build(JsArgs.arg(args, 0), context);
                    // `build()` throws a TypeError for anything but {id, title, items[]}.
                    if (built == null) return JsArgs.obj("throws", JsArgs.obj("name", Json.str("TypeError")));
                    result = switch (name) {
                        case "clockAudit" -> clockAudit(built);
                        case "structureOf" -> {
                            List<ForayItem> items = new ArrayList<>();
                            for (Json item : built.playable()) items.add(item(item));
                            yield encode(StructuralCheck.check(items));
                        }
                        case "appAsArtist" -> Json.num(appAsArtist(built));
                        case "lockScreenAudit" -> lockScreenAudit(built);
                        case "lockScreenClock" -> lockScreenClock(built);
                        default -> throw new HarnessError("E_UNKNOWN_EXPORT", FORAYS_MODULE + " has no JVM port of export \"" + name + "\"");
                    };
                }
            }
            return JsArgs.obj("return", Codec.encode(result));
        }
    }

    /** {@code resolveForay(foray)}'s parts these rules read: the raw document, its title, and the built queue. */
    record Built(Json foray, String title, List<Json> playable) {
        List<ForayItem> items() {
            List<ForayItem> out = new ArrayList<>();
            for (Json item : playable) out.add(item(item));
            return out;
        }

        double totalSec() {
            return ForayClock.forayRuntimeSec(items());
        }
    }

    record Table(Map<String, List<Json>> data, Map<String, List<Json>> frozen) {}

    private static final Map<Path, Table> TABLES = new HashMap<>();

    /** The build table, read once per repo root. */
    static synchronized Table table(Codec.Context context) {
        Path root = context.repoRoot();
        if (root == null) throw new HarnessError("E_BAD_CASE", "the committed Forays need the repo root, and this run has none");
        Table hit = TABLES.get(root);
        if (hit != null) return hit;
        Json doc;
        try {
            doc = Json.parse(Files.readString(root.resolve(BUILDS_FILE), StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new HarnessError("E_BAD_CASE", "cannot read " + BUILDS_FILE + ": " + e.getMessage());
        }
        Table table = new Table(section(doc, "data"), section(doc, "frozen"));
        TABLES.put(root, table);
        return table;
    }

    private static Map<String, List<Json>> section(Json doc, String key) {
        Map<String, List<Json>> out = new HashMap<>();
        Json s = doc.get(key);
        if (s != null && s.asMap() != null) {
            for (Map.Entry<String, Json> e : s.asMap().entrySet()) {
                List<Json> list = e.getValue().asList();
                out.put(e.getKey(), list == null ? List.of() : list);
            }
        }
        return out;
    }

    /** {@code build(foray)}: null where forays.js throws its TypeError; a Foray with no build in the table cannot run. */
    static Built build(Json foray, Codec.Context context) {
        if (!(foray instanceof Json.Obj) || at(foray, "items").asList() == null) return null;
        String id = at(foray, "id").asString();
        if (id == null) throw JsArgs.notRepresentable("a Foray's id", at(foray, "id"));
        List<Json> playable = table(context).data().get(id);
        if (playable == null) {
            throw new HarnessError("E_BAD_CASE", id + " has no build in " + BUILDS_FILE + "; run node tools/parity/foray-builds.mjs --write");
        }
        Json rawTitle = at(foray, "title");
        String title;
        if (JsArgs.isNullish(rawTitle)) {
            title = "";
        } else if (rawTitle.asString() != null) {
            title = rawTitle.asString();
        } else {
            throw JsArgs.notRepresentable("a Foray's title", rawTitle);
        }
        return new Built(foray, title, playable);
    }

    /** {@code committedForays()}'s count: data/forays.json's Forays. */
    static int committedCount(Codec.Context context) {
        Path root = context.repoRoot();
        if (root == null) throw new HarnessError("E_BAD_CASE", "committedForays needs the repo root, and this run has none");
        try {
            Json doc = Json.parse(Files.readString(root.resolve("data").resolve("forays.json"), StandardCharsets.UTF_8));
            List<Json> list = doc.get("forays") == null ? null : doc.get("forays").asList();
            return list == null ? 0 : list.size();
        } catch (IOException e) {
            throw new HarnessError("E_BAD_CASE", "cannot read data/forays.json: " + e.getMessage());
        }
    }

    /** One {@code rows(r)} entry: the lock-screen metadata of a playable item, and its credit when it is not a segment. */
    record Row(Json item, MediaMapping.Metadata meta, String credit) {}

    static List<Row> rows(Built r) {
        double total = r.playable().size();
        List<Row> out = new ArrayList<>();
        for (int index = 0; index < r.playable().size(); index++) {
            Json item = r.playable().get(index);
            MediaMapping.Item next = index + 1 < r.playable().size() ? MediaEpisodeFamily.item(r.playable().get(index + 1)) : null;
            MediaMapping.Metadata meta = MediaMapping.metadata(MediaEpisodeFamily.item(item), next, r.title(), (double) index, total,
                    null, MediaMapping.APP_ARTWORK_URL);
            String credit = EngineConstants.QueueState.EPISODE.equals(at(item, "kind").asString()) ? null
                    : MediaMapping.narrationCredit(r.title(), next);
            out.add(new Row(item, meta, credit));
        }
        return out;
    }

    /** {@code appAsArtist(foray)}: how many playable items the lock screen credits to the app. 0 is the rule. */
    static int appAsArtist(Built r) {
        int count = 0;
        for (Row row : rows(r)) {
            if (MediaMapping.APP_NAME.equals(row.meta().artist()) || MediaMapping.APP_NAME.equals(row.credit())) count += 1;
        }
        return count;
    }

    /** {@code lockScreenAudit(foray)}: violation counts, 0 each. */
    static Json lockScreenAudit(Built r) {
        List<Row> list = rows(r);
        int frozen = 0;
        for (int i = 1; i < list.size(); i++) if (key(list.get(i).meta()).equals(key(list.get(i - 1).meta()))) frozen += 1;
        int blankTitle = 0;
        int blankArtist = 0;
        int albumMissing = 0;
        int segmentNotShow = 0;
        int narrationArtwork = 0;
        for (Row row : list) {
            if (row.meta().title().isEmpty()) blankTitle += 1;
            if (row.meta().artist().isEmpty()) blankArtist += 1;
            if (!row.meta().album().contains(r.title())) albumMissing += 1;
            boolean episode = EngineConstants.QueueState.EPISODE.equals(at(row.item(), "kind").asString());
            // `meta.artist !== item.show`: an absent or non-string show never equals a string.
            if (episode && !row.meta().artist().equals(at(row.item(), "show").asString())) segmentNotShow += 1;
            if (!episode && (row.meta().artwork().size() != 1
                    || !MediaMapping.APP_ARTWORK_URL.equals(row.meta().artwork().get(0).src()))) {
                narrationArtwork += 1;
            }
        }
        return JsArgs.obj("blankTitle", Json.num(blankTitle), "blankArtist", Json.num(blankArtist), "albumMissingForay",
                Json.num(albumMissing), "frozenDisplays", Json.num(frozen), "segmentNotShow", Json.num(segmentNotShow),
                "narrationArtwork", Json.num(narrationArtwork));
    }

    private static String key(MediaMapping.Metadata meta) {
        return meta.title() + "|" + meta.artist() + "|" + meta.album();
    }

    /**
     * {@code lockScreenClock(foray)}: at the first tape item from the midpoint on, halfway through
     * the Foray, the lock screen reports the FORAY's clock.
     */
    static Json lockScreenClock(Built r) {
        int mid = r.playable().size() / 2;
        int index = -1;
        for (int i = mid; i < r.playable().size(); i++) {
            if (Double.isFinite(span(r.playable().get(i)))) {
                index = i;
                break;
            }
        }
        if (index < 0) {
            return JsArgs.obj("tapeItemFound", Json.FALSE, "durationIsForayTotal", Json.FALSE, "durationIsNotSegment", Json.FALSE,
                    "positionIsForayClock", Json.FALSE);
        }
        Json item = r.playable().get(index);
        double total = r.totalSec();
        double position = Math.floor(total / 2);
        MediaMapping.View v = new MediaMapping.View();
        v.item = MediaEpisodeFamily.item(item);
        v.forayTitle = r.title();
        v.index = (double) index;
        v.total = (double) r.playable().size();
        v.durationSec = total;
        v.positionSec = position;
        v.playing = true;
        MediaMapping.PositionState state = MediaMapping.sessionView(v).positionState();
        Double duration = state == null ? null : state.duration();
        return JsArgs.obj("tapeItemFound", Json.TRUE,
                "durationIsForayTotal", Json.bool(duration != null && duration == total),
                "durationIsNotSegment", Json.bool(duration == null || duration != span(item)),
                "positionIsForayClock", Json.bool(state != null && state.position() == position));
    }

    /** {@code item.end_sec - item.start_sec} with JS coercion (undefined is NaN). */
    private static double span(Json item) {
        return JsArgs.toNumber(at(item, "end_sec")) - JsArgs.toNumber(at(item, "start_sec"));
    }

    /** {@code clockAudit(foray)}: the Foray clock's four invariants, all true. */
    static Json clockAudit(Built r) {
        List<ForayItem> items = r.items();
        List<Double> starts = ForayClock.segmentStarts(items);
        double total = ForayClock.forayRuntimeSec(items);
        double acc = 0;
        boolean cumulative = true;
        boolean mapsBack = true;
        boolean roundTrips = true;
        for (int i = 0; i < items.size(); i++) {
            ForayItem item = items.get(i);
            double length = ForayClock.itemRuntimeSec(item);
            if (Math.abs(starts.get(i) - acc) > 1e-9) cumulative = false;
            acc += length;
            if (length > 0) {
                ForayClock.Position at = ForayClock.segmentAtElapsed(items, starts.get(i));
                if (at == null || at.index() != i) mapsBack = false;
            }
            double into = JSMath.min(1, length);
            Double start = item == null ? null : item.startSec();
            double base = start != null && Double.isFinite(start) ? start : 0;
            if (Math.abs(ForayClock.forayElapsed(items, (double) i, base + into) - (starts.get(i) + into)) > 1e-9) roundTrips = false;
        }
        Double runtime = at(r.foray(), "runtime_sec").asNumber();
        boolean stated = runtime == null || Math.abs(runtime - total) <= 0.5;
        return JsArgs.obj("statedRuntimeHolds", Json.bool(stated), "startsAreCumulative", Json.bool(cumulative && Math.abs(acc - total) <= 1e-9),
                "everyStartMapsBack", Json.bool(mapsBack), "elapsedRoundTrips", Json.bool(roundTrips));
    }
}
