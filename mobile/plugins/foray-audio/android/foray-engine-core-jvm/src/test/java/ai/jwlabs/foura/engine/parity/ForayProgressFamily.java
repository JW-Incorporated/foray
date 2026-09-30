package ai.jwlabs.foura.engine.parity;

import static ai.jwlabs.foura.engine.parity.JsArgs.arg;
import static ai.jwlabs.foura.engine.parity.JsArgs.at;

import ai.jwlabs.foura.engine.ForayProgressRules;
import ai.jwlabs.foura.engine.JSDate;
import ai.jwlabs.foura.engine.JSWriter;
import ai.jwlabs.foura.engine.JsonNode;
import ai.jwlabs.foura.engine.ResumeRules;
import ai.jwlabs.foura.engine.Rows;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Call;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Outcome;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Returned;
import ai.jwlabs.foura.engine.parity.FamilyRunner.Threw;
import ai.jwlabs.foura.engine.parity.ParityData.FixtureCase;
import ai.jwlabs.foura.engine.parity.ParityData.FixtureFile;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The {@code foray-progress} family against {@link ForayProgressRules} and {@link Rows}, card A-40,
 * the JVM twin of the Swift ForayProgressFamily: progress.json (the pure half of
 * player/foray-progress.js) and storage.json (its storage half through
 * player/parity/foray-store.js {@code storageRun}).
 *
 * <p>Translation only. The storage half needs a Storage, which no fixture can hold:
 * {@code storageRun} builds one from data and runs the ops in order, and {@link StorageRun} is that
 * adapter's JVM twin. It decides nothing: validity, the throttle, staleness, the list's order and
 * the row's bytes are the core's.
 */
final class ForayProgressFamily {
    private ForayProgressFamily() {}

    static final String MODULE = "player/foray-progress.js";
    static final String STORE_MODULE = "player/parity/foray-store.js";
    private static final Outcome TYPE_ERROR = new Threw("TypeError");

    static FamilyRunner runner() {
        Map<String, Json> reads = new LinkedHashMap<>();
        reads.put("KEY_PREFIX", Json.str(Rows.forayKey("")));
        reads.put("MIN_RESUME_SEC", Json.num(ForayProgressRules.MIN_RESUME_SEC));
        reads.put("NEAR_END_SEC", Json.num(ForayProgressRules.NEAR_END_SEC));
        reads.put("MAX_AGE_H", Json.num(ForayProgressRules.MAX_AGE_H));
        for (ForayProgressRules.Drift d : ForayProgressRules.Drift.values()) reads.put("DRIFT_" + d.name(), Json.str(d.token));
        reads.put("DRIFT_TOLERANCE_SEC", Json.num(ForayProgressRules.DRIFT_TOLERANCE_SEC));
        reads.put("PLAYED_LABEL", Json.str(ForayProgressRules.PLAYED_LABEL));
        reads.put("SAVE_EVERY_SEC", Json.num(ResumeRules.FORAY_WRITE_EVERY_SEC));
        Map<String, Call> calls = new LinkedHashMap<>();
        calls.put("progressKey", args -> {
            String id = arg(args, 0).asString();
            if (id == null) throw JsArgs.notRepresentable("progressKey's forayId", arg(args, 0));
            return new Returned(Json.str(Rows.forayKey(id)));
        });
        calls.put("makeProgress", args -> {
            // `makeProgress({...})` has no default: null or undefined throws.
            Json p = arg(args, 0);
            if (JsArgs.isNullish(p)) return TYPE_ERROR;
            return new Returned(ForayHarness.value(Rows.makeForayProgress(input(p), stamp(at(p, "now")))));
        });
        calls.put("isProgressRecord", args -> new Returned(Json.bool(ForayProgressRules.isProgressRecord(row(arg(args, 0))))));
        calls.put("resumePoint", args -> {
            Json opts = JsArgs.objectParam(arg(args, 1), true);
            if (opts == null) return TYPE_ERROR;
            ForayProgressRules.ResumePoint point = ForayProgressRules.resumePoint(row(arg(args, 0)), at(opts, "totalSec").asNumber(),
                    at(opts, "maxIndex").asNumber(), live(at(opts, "segments")), !isFalse(at(opts, "present")));
            if (point == null) return new Returned(Json.NULL);
            return new Returned(JsArgs.obj("elapsedSec", Json.num(point.elapsedSec()), "index", Json.num(point.index()),
                    "remainingSec", Json.num(point.remainingSec()), "percent", Json.num(point.percent()), "finished",
                    Json.bool(point.finished()), "drift", Json.str(point.drift().token)));
        });
        calls.put("reconcileSegment", args -> {
            Json opts = JsArgs.objectParam(arg(args, 2), true);
            if (opts == null) return TYPE_ERROR;
            ForayProgressRules.Reconciled at = ForayProgressRules.reconcileSegment(row(arg(args, 0)), live(arg(args, 1)),
                    !isFalse(at(opts, "present")));
            Map<String, Json> out = new LinkedHashMap<>();
            out.put("drift", Json.str(at.drift().token));
            if (at.elapsedSec() != null) out.put("elapsedSec", Json.num(at.elapsedSec()));
            if (at.index() != null) out.put("index", Json.num(at.index()));
            return new Returned(new Json.Obj(out));
        });
        calls.put("percentDone", args -> new Returned(Json.num(ForayProgressRules.percentDone(arg(args, 0).asNumber(),
                arg(args, 1).asNumber()))));
        calls.put("remainingLabel", args -> {
            Json opts = JsArgs.objectParam(arg(args, 1), true);
            if (opts == null) return TYPE_ERROR;
            return new Returned(Json.str(ForayProgressRules.remainingLabel(arg(args, 0).asNumber(), JsArgs.truthy(at(opts, "estimated")))));
        });
        calls.put("progressLabel", args -> {
            Json opts = JsArgs.objectParam(arg(args, 1), true);
            if (opts == null) return TYPE_ERROR;
            Json point = arg(args, 0);
            if (!JsArgs.truthy(point)) return new Returned(Json.str(""));
            return new Returned(Json.str(ForayProgressRules.progressLabel(JsArgs.truthy(at(point, "finished")),
                    at(point, "remainingSec").asNumber(), JsArgs.truthy(at(opts, "estimated")))));
        });
        Map<String, FamilyRunner> routes = new LinkedHashMap<>();
        routes.put(MODULE, new FamilyRunner.Pure("foray-progress", MODULE, reads, calls));
        routes.put(STORE_MODULE, new StorageRunner());
        return new ForayHarness.ModuleRouted("foray-progress", routes);
    }

    private static boolean isFalse(Json value) {
        return value instanceof Json.Bool b && !b.value();
    }

    /** A row object as the rules read it; null for anything but an object. */
    static ForayProgressRules.ForayRow row(Json value) {
        if (!(value instanceof Json.Obj)) return null;
        return new ForayProgressRules.ForayRow(at(value, "foray_id").asString(), at(value, "elapsed_sec").asNumber(),
                at(value, "total_sec").asNumber(), at(value, "index").asNumber(), at(value, "segment_id").asString(),
                at(value, "into_sec").asNumber());
    }

    /** The live running order: null unless it is an array; an entry that is not an object is null (never a descriptor). */
    static List<ForayProgressRules.LiveSegment> live(Json value) {
        List<Json> values = value.asList();
        if (values == null) return null;
        List<ForayProgressRules.LiveSegment> out = new ArrayList<>();
        for (Json entry : values) {
            if (!(entry instanceof Json.Obj)) {
                out.add(null);
                continue;
            }
            out.add(new ForayProgressRules.LiveSegment(at(entry, "id").asString(), at(entry, "startSec").asNumber(),
                    at(entry, "durationSec").asNumber()));
        }
        return out;
    }

    /**
     * {@code makeProgress}'s / {@code save}'s argument. {@code foray_id: forayId} is written RAW
     * by makeProgress, so an id that is not a string (or absent) has no typed spelling.
     */
    static Rows.ForayProgressInput input(Json p) {
        Json id = at(p, "forayId");
        if (!JsArgs.isUndefined(id) && id.asString() == null) throw JsArgs.notRepresentable("forayId", id);
        return new Rows.ForayProgressInput(id.asString(), at(p, "title").asString(), at(p, "elapsedSec").asNumber(),
                at(p, "totalSec").asNumber(), at(p, "index").asNumber(), at(p, "segmentId").asString(), at(p, "intoSec").asNumber());
    }

    /** {@code typeof now === "string" ? now : now.toISOString()}: every case names its instant as a string. */
    static String stamp(Json now) {
        String text = now.asString();
        if (text == null) throw JsArgs.notRepresentable("now", now);
        return text;
    }

    /** storage.json: {@code storageRun({storage, initial, everySec, ops})}. */
    static final class StorageRunner implements FamilyRunner {
        @Override
        public String family() {
            return "foray-progress";
        }

        @Override
        public Json run(FixtureCase testCase, FixtureFile file, Codec.Context context) {
            if (!"call".equals(testCase.kind()) || !"storageRun".equals(testCase.raw().get("call").asString())) {
                throw new HarnessError("E_UNKNOWN_EXPORT", STORE_MODULE + " has no JVM port of that export");
            }
            List<Json> args = new ArrayList<>();
            for (Json arg : testCase.args()) args.add(Codec.expandInputs(arg, context));
            // Key order matters twice: `write` stringifies the record as given, and the initial
            // rows are the storage's insertion order. The fixture's own JSON keeps both (the JVM
            // parser keeps source order).
            Json ordered = testCase.args().isEmpty() ? Json.NULL : testCase.args().get(0);
            StorageRun run = new StorageRun(arg(args, 0), ordered);
            return JsArgs.obj("return", Codec.encode(run.run()));
        }
    }

    /** foray-store.js's adapter, op by op. */
    static final class StorageRun {
        /** {@code FIXED_NOW}: the instant a case that names none runs at. */
        static final String FIXED_NOW = "2026-08-16T10:00:00.000Z";

        /** The Storage a case runs against; {@code FALLBACK} is the store's own stand-in when the case has none. */
        enum Storage { MEMORY, NONE, NO_KEY, FALLBACK }

        final Json spec;
        final Json ordered;
        final Storage direct;
        final Storage store;
        final List<String> keys = new ArrayList<>();
        final Map<String, String> values = new HashMap<>();
        boolean failWrites = false;
        final ForayProgressRules.WriteThrottle throttle;

        StorageRun(Json spec, Json ordered) {
            Json raw = at(spec, "storage");
            Storage storage;
            if (JsArgs.isUndefined(raw) || "memory".equals(raw.asString())) {
                storage = Storage.MEMORY;
            } else if ("none".equals(raw.asString())) {
                storage = Storage.NONE;
            } else if ("noKey".equals(raw.asString())) {
                storage = Storage.NO_KEY;
            } else {
                throw new HarnessError("E_BAD_CASE", "storageRun: unknown storage " + Json.show(Codec.encode(raw)));
            }
            if (storage == Storage.MEMORY && at(ordered, "initial") instanceof Json.Obj initial) {
                for (Map.Entry<String, Json> e : initial.fields().entrySet()) {
                    String text = e.getValue().asString();
                    if (text == null) throw new HarnessError("E_BAD_CASE", "storageRun: initial." + e.getKey() + " must be a string");
                    if (!values.containsKey(e.getKey())) keys.add(e.getKey());
                    values.put(e.getKey(), text);
                }
            }
            this.spec = spec;
            this.ordered = ordered;
            this.direct = storage;
            this.store = storage == Storage.NONE ? Storage.FALLBACK : storage;
            // `everySec` is passed only when present: `isNum(x) && x > 0 ? x : SAVE_EVERY_SEC`.
            this.throttle = new ForayProgressRules.WriteThrottle(at(spec, "everySec").asNumber());
        }

        Json run() {
            Json rawOps = at(spec, "ops");
            List<Json> ops = rawOps.asList();
            if (ops == null) {
                if (JsArgs.isUndefined(rawOps)) return result(List.of());
                throw new HarnessError("E_BAD_CASE", "storageRun: ops must be an array");
            }
            List<Json> orderedOps = at(ordered, "ops").asList() == null ? List.of() : at(ordered, "ops").asList();
            List<Json> results = new ArrayList<>();
            for (int i = 0; i < ops.size(); i++) {
                List<Json> parts = ops.get(i).asList();
                String name = parts == null || parts.isEmpty() ? null : parts.get(0).asString();
                if (name == null) throw new HarnessError("E_BAD_CASE", "storageRun: op " + i + " is not [name, ...args]");
                Json a1 = parts.size() > 1 ? parts.get(1) : Json.UNDEFINED;
                switch (name) {
                    case "failWrites" -> {
                        if (direct != Storage.MEMORY) throw new HarnessError("E_BAD_CASE", "failWrites needs the memory storage");
                        failWrites = JsArgs.isTrue(a1);
                        results.add(Json.NULL);
                    }
                    case "write" -> {
                        Json raw = Json.NULL;
                        if (i < orderedOps.size() && orderedOps.get(i).asList() != null && orderedOps.get(i).asList().size() > 1) {
                            raw = orderedOps.get(i).asList().get(1);
                        }
                        results.add(Json.bool(write(direct, a1, raw)));
                    }
                    case "read" -> results.add(read(direct, a1));
                    case "clear" -> {
                        clear(direct, a1);
                        results.add(Json.NULL);
                    }
                    case "list" -> results.add(list(direct, a1));
                    case "save" -> results.add(Json.bool(save(stamped(a1), false)));
                    case "markFinished" -> results.add(Json.bool(save(stamped(a1), true)));
                    case "get" -> results.add(read(store, a1));
                    case "storeClear" -> {
                        clear(store, a1);
                        if (a1.asString() != null) throttle.clear(a1.asString());
                        results.add(Json.NULL);
                    }
                    case "storeList" -> results.add(list(store, a1));
                    case "counters" -> results.add(JsArgs.obj("refusedWrites", Json.num(throttle.refusedWrites()), "failedWrites",
                            Json.num(throttle.refusedWrites())));
                    default -> throw new HarnessError("E_BAD_CASE", "storageRun: unknown op \"" + name + "\"");
                }
            }
            return result(results);
        }

        Json result(List<Json> results) {
            Map<String, Json> rows = new LinkedHashMap<>();
            if (direct == Storage.MEMORY) for (String key : keys) rows.put(key, Json.str(values.getOrDefault(key, "")));
            return JsArgs.obj("results", new Json.Arr(results), "rows", new Json.Obj(rows));
        }

        /** {@code setItem}: false where the JS write throws. */
        boolean setItem(Storage storage, String key, String value) {
            if (storage != Storage.MEMORY || failWrites) return false;
            if (!values.containsKey(key)) keys.add(key);
            values.put(key, value);
            return true;
        }

        String getItem(Storage storage, String key) {
            return storage == Storage.MEMORY ? values.get(key) : null;
        }

        /** {@code readProgress(storage, forayId)}. */
        Json read(Storage storage, Json forayId) {
            String id = forayId.asString();
            if (storage == Storage.NONE || id == null || !Rows.nonEmpty(id)) return Json.NULL;
            String raw = getItem(storage, Rows.forayKey(id));
            if (raw == null || raw.isEmpty()) return Json.NULL;
            JsonNode node = JsonNode.tryParse(raw);
            if (node == null) return Json.NULL;
            Json value = ForayHarness.value(node);
            return ForayProgressRules.isProgressRecord(row(value)) ? value : Json.NULL;
        }

        /** {@code writeProgress(storage, record)}: the record stringified in the key order the case wrote it in. */
        boolean write(Storage storage, Json record, Json orderedRecord) {
            String id = at(record, "foray_id").asString();
            if (storage == Storage.NONE || !ForayProgressRules.isProgressRecord(row(record)) || id == null) return false;
            return setItem(storage, Rows.forayKey(id), JSWriter.stringify(detagged(orderedRecord)));
        }

        /** {@code clearProgress(storage, forayId)}. */
        void clear(Storage storage, Json forayId) {
            String id = forayId.asString();
            if (storage != Storage.MEMORY || id == null || !Rows.nonEmpty(id)) return;
            String key = Rows.forayKey(id);
            keys.remove(key);
            values.remove(key);
        }

        /** {@code listProgress(storage, listOpts(o))}: every stored row that reads back, less the stale, most recent first. */
        Json list(Storage storage, Json o) {
            Json rawNow = at(o, "now");
            double now;
            if (JsArgs.isNullish(rawNow)) {
                Double parsed = JSDate.parse(FIXED_NOW);
                now = parsed == null ? Double.NaN : parsed;
            } else if (rawNow.asString() != null) {
                Double parsed = JSDate.parse(rawNow.asString());
                now = parsed == null ? Double.NaN : parsed;
            } else if (rawNow.asNumber() != null) {
                now = rawNow.asNumber();
            } else {
                throw JsArgs.notRepresentable("list's now", rawNow);
            }
            Json rawMax = at(o, "maxAgeH");
            double maxAgeH;
            if (JsArgs.isUndefined(rawMax)) {
                maxAgeH = ForayProgressRules.MAX_AGE_H;
            } else if (rawMax.asNumber() != null) {
                maxAgeH = rawMax.asNumber();
            } else {
                throw JsArgs.notRepresentable("list's maxAgeH", rawMax);
            }
            // No storage, or no `key()`: nothing to enumerate.
            if (storage != Storage.MEMORY) return new Json.Arr(List.of());
            String prefix = Rows.forayKey("");
            record Entry(Json value, String stamp, int offset) {}
            List<Entry> out = new ArrayList<>();
            for (String key : new ArrayList<>(keys)) {
                if (!key.startsWith(prefix)) continue;
                Json row = read(storage, Json.str(key.substring(prefix.length())));
                if (row instanceof Json.Null) continue;
                Json updated = at(row, "updated_at");
                Double stampMs;
                String text;
                if (JsArgs.isUndefined(updated)) {
                    stampMs = null;
                    text = "undefined";
                } else if (JsArgs.isNull(updated)) {
                    stampMs = null;
                    text = "null";
                } else if (updated.asString() != null) {
                    stampMs = JSDate.parse(updated.asString());
                    text = updated.asString();
                } else {
                    throw JsArgs.notRepresentable("a row's updated_at", updated);
                }
                if (ForayProgressRules.rowIsStale(stampMs, now, maxAgeH)) continue;
                out.add(new Entry(row, text, out.size()));
            }
            // Array.prototype.sort is stable: equal stamps keep storage order.
            out.sort((a, b) -> {
                if (ForayProgressRules.rowSortsBefore(a.stamp(), b.stamp())) return -1;
                if (ForayProgressRules.rowSortsBefore(b.stamp(), a.stamp())) return 1;
                return Integer.compare(a.offset(), b.offset());
            });
            List<Json> sorted = new ArrayList<>();
            for (Entry e : out) sorted.add(e.value());
            return new Json.Arr(sorted);
        }

        /** {@code {...(p ?? {}), now: p?.now ?? FIXED_NOW}}. */
        Json stamped(Json p) {
            Map<String, Json> fields = new LinkedHashMap<>();
            if (p instanceof Json.Obj given) fields.putAll(given.fields());
            Json now = fields.get("now");
            if (now == null || JsArgs.isNullish(now)) fields.put("now", Json.str(FIXED_NOW));
            return new Json.Obj(fields);
        }

        /** {@code store.save(p)}, or {@code store.markFinished(p)} (a save at the Foray's own total, forced past the throttle). */
        boolean save(Json p, boolean finished) {
            Rows.ForayProgressInput input = input(p);
            if (finished) {
                input = new Rows.ForayProgressInput(input.forayId(), input.title(), input.totalSec(), input.totalSec(), input.index(),
                        input.segmentId(), input.intoSec());
            }
            boolean force = finished || JsArgs.truthy(at(p, "force"));
            Rows.StoredRow row = throttle.due(input, force, stamp(at(p, "now")));
            if (row == null || input.forayId() == null || input.elapsedSec() == null) return false;
            boolean ok = setItem(store, row.key(), row.value());
            throttle.recorded(input.forayId(), input.elapsedSec(), ok);
            return ok;
        }

        /**
         * A fixture's ordered JSON with its {@code $num} / {@code $undefined} tags decoded, as
         * {@code JSON.stringify} then prints it (NaN is null; an undefined member is absent; an
         * undefined array element is null).
         */
        static JsonNode detagged(Json node) {
            switch (node) {
                case Json.Arr a -> {
                    List<JsonNode> items = new ArrayList<>();
                    for (Json item : a.items()) {
                        Tag decoded = tag(item);
                        if (decoded != null) {
                            items.add(decoded.value() == null ? JsonNode.NULL : decoded.value());
                        } else {
                            items.add(detagged(item));
                        }
                    }
                    return new JsonNode.Arr(items);
                }
                case Json.Obj o -> {
                    Tag self = tag(node);
                    if (self != null) return self.value() == null ? JsonNode.NULL : self.value();
                    List<JsonNode.Member> members = new ArrayList<>();
                    for (Map.Entry<String, Json> e : o.fields().entrySet()) {
                        Tag decoded = tag(e.getValue());
                        if (decoded != null) {
                            if (decoded.value() != null) members.add(JsonNode.member(e.getKey(), decoded.value()));
                            continue;
                        }
                        members.add(JsonNode.member(e.getKey(), detagged(e.getValue())));
                    }
                    return new JsonNode.Obj(members);
                }
                case Json.Null n -> {
                    return JsonNode.NULL;
                }
                case Json.Undefined u -> {
                    return JsonNode.NULL;
                }
                case Json.Bool b -> {
                    return JsonNode.bool(b.value());
                }
                case Json.Num n -> {
                    return JsonNode.num(n.value());
                }
                case Json.Str s -> {
                    return JsonNode.str(s.value());
                }
            }
        }

        /** A tag's decoded value ({@code value} null for {@code $undefined}). */
        record Tag(JsonNode value) {}

        /** A tag object's value: null if it is not a tag. A macro has no place in a row. */
        static Tag tag(Json node) {
            if (!(node instanceof Json.Obj o) || o.fields().size() != 1) return null;
            Map.Entry<String, Json> member = o.fields().entrySet().iterator().next();
            if (!member.getKey().startsWith("$")) return null;
            switch (member.getKey()) {
                case "$undefined" -> {
                    return new Tag(null);
                }
                case "$num" -> {
                    String spelled = member.getValue().asString();
                    if ("NaN".equals(spelled)) return new Tag(JsonNode.num(Double.NaN));
                    if ("Infinity".equals(spelled)) return new Tag(JsonNode.num(Double.POSITIVE_INFINITY));
                    if ("-Infinity".equals(spelled)) return new Tag(JsonNode.num(Double.NEGATIVE_INFINITY));
                    if ("-0".equals(spelled)) return new Tag(JsonNode.num(-0.0));
                    throw new HarnessError("E_BAD_SPECIAL", "unknown $num tag " + Json.show(member.getValue()));
                }
                default -> throw new HarnessError("E_BAD_MACRO", member.getKey() + " has no place in a stored row");
            }
        }
    }
}
