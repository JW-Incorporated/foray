package ai.jwlabs.foura.engine.parity;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.stream.Stream;

/**
 * Everything one JVM parity run reads, from player/parity/ IN PLACE (docs/native-engine-plan.md
 * §6: "Fixtures are read in place"; nothing under foray-engine-core-jvm is a copy of a
 * fixture): the families and their ids (manifest.json), what each fixture file holds,
 * what the JVM owes (jvm-pending.json), the floors (floors.json), the families
 * unported.json says tests will be recorded into, and every fixture file on disk.
 *
 * <p>Plain data with public mutable maps, so a test can change ONE thing (corrupt an
 * expect, move an id out of pending, add a stray family) and prove the suite notices,
 * without writing to the tree.
 */
public final class ParityData {
    /** family -> ordered case ids, from manifest.json. */
    public final Map<String, List<String>> manifest = new TreeMap<>();
    /** family -> the fixture files manifest.json lists for it, as read. */
    public final Map<String, List<FixtureFile>> fixtures = new TreeMap<>();
    /** jvm-pending.json "families": a whole family the JVM does not run yet -> the card that owes it. */
    public final Map<String, String> pendingFamilies = new TreeMap<>();
    /** jvm-pending.json "cases": one case id owed inside a family the JVM does run -> its card. */
    public final Map<String, String> pendingCases = new TreeMap<>();
    /** family -> minimum case count, from floors.json. */
    public final Map<String, Integer> floors = new TreeMap<>();
    /**
     * family -> how many covered-suite tests unported.json says will be recorded into it
     * (not yet fixtures, so neither run nor owed here: the JS side owes them first).
     */
    public final Map<String, Integer> unportedFamilies = new TreeMap<>();
    /** Every fixtures/**.json on disk, repo-relative POSIX. */
    public final TreeSet<String> filesOnDisk = new TreeSet<>();
    /** The repo root, for {@code $foray}. */
    public Path repoRoot;

    /** One fixture file, player/parity/fixtures/&lt;family&gt;/&lt;name&gt;.json. */
    public record FixtureFile(String path, String family, String module, List<FixtureCase> cases, boolean jsOnly) {}

    /** One case, kept as the JSON it is plus typed accessors. */
    public record FixtureCase(String id, Json raw) {
        /** runner.js caseKind: exactly one of read / call / steps, else null. */
        public String kind() {
            int n = 0;
            String kind = null;
            if (raw.get("read") != null) { n++; kind = "read"; }
            if (raw.get("call") != null) { n++; kind = "call"; }
            if (raw.get("steps") != null) { n++; kind = "scenario"; }
            return n == 1 ? kind : null;
        }

        public Json expect() {
            return raw.get("expect");
        }

        public Double tolerance() {
            Json t = raw.get("tolerance");
            return t == null ? null : t.asNumber();
        }

        public List<Json> args() {
            Json a = raw.get("args");
            return a == null || a.asList() == null ? List.of() : a.asList();
        }

        /** The same case with a different expect: how a test proves a wrong expectation is caught. */
        public FixtureCase withExpect(Json expect) {
            Map<String, Json> fields = new LinkedHashMap<>(raw.asMap());
            fields.put("expect", expect);
            return new FixtureCase(id, new Json.Obj(fields));
        }
    }

    static FixtureFile fixtureFile(String rel, Json doc) {
        String family = doc.get("family") == null ? null : doc.get("family").asString();
        if (family == null) throw new HarnessError("E_BAD_CASE", rel + " has no family");
        Json rawCases = doc.get("cases");
        if (rawCases == null || rawCases.asList() == null) throw new HarnessError("E_BAD_CASE", rel + " has no cases");
        List<FixtureCase> cases = new ArrayList<>();
        for (Json c : rawCases.asList()) {
            Json id = c.get("id");
            if (id == null || id.asString() == null) throw new HarnessError("E_BAD_CASE", rel + " has a case with no id");
            cases.add(new FixtureCase(id.asString(), c));
        }
        Json module = doc.get("module");
        return new FixtureFile(rel, family, module == null ? null : module.asString(), cases,
                Json.TRUE.equals(doc.get("jsOnly")));
    }

    private static Json read(Path file) {
        try {
            return Json.parse(Files.readString(file, StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new HarnessError("E_BAD_CASE", "cannot read " + file + ": " + e);
        }
    }

    /** Read {@code parityDir} (player/parity) in place. */
    public static ParityData load(Path parityDir) {
        ParityData data = new ParityData();
        Path root = parityDir.toAbsolutePath().normalize().getParent().getParent();
        data.repoRoot = root;

        Json manifestDoc = read(parityDir.resolve("manifest.json"));
        Map<String, Json> families = manifestDoc.get("families") == null ? null : manifestDoc.get("families").asMap();
        if (families == null) throw new HarnessError("E_BAD_CASE", "manifest.json has no families");
        for (Map.Entry<String, Json> e : families.entrySet()) {
            List<String> ids = new ArrayList<>();
            Json idList = e.getValue().get("ids");
            if (idList != null && idList.asList() != null) {
                for (Json id : idList.asList()) if (id.asString() != null) ids.add(id.asString());
            }
            data.manifest.put(e.getKey(), ids);
            List<FixtureFile> files = new ArrayList<>();
            Json fileMap = e.getValue().get("files");
            if (fileMap != null && fileMap.asMap() != null) {
                for (String rel : new TreeSet<>(fileMap.asMap().keySet())) {
                    Path file = root.resolve(rel);
                    if (!Files.isRegularFile(file)) {
                        throw new HarnessError("E_BAD_CASE", "manifest.json lists " + rel + ", which cannot be read");
                    }
                    files.add(fixtureFile(rel, read(file)));
                }
            }
            data.fixtures.put(e.getKey(), files);
        }

        Json pending = read(parityDir.resolve("jvm-pending.json"));
        for (String section : List.of("families", "cases")) {
            Json m = pending.get(section);
            if (m == null || m.asMap() == null) {
                throw new HarnessError("E_BAD_CASE", "jvm-pending.json has no \"" + section + "\" object");
            }
            Map<String, String> into = section.equals("families") ? data.pendingFamilies : data.pendingCases;
            for (Map.Entry<String, Json> e : m.asMap().entrySet()) {
                into.put(e.getKey(), e.getValue().asString() == null ? "" : e.getValue().asString());
            }
        }
        for (String key : pending.asMap().keySet()) {
            if (!key.startsWith("//") && !key.equals("families") && !key.equals("cases")) {
                throw new HarnessError("E_BAD_CASE", "jvm-pending.json has an unknown key \"" + key + "\"");
            }
        }

        Json floorDoc = read(parityDir.resolve("floors.json")).get("families");
        if (floorDoc != null && floorDoc.asMap() != null) {
            for (Map.Entry<String, Json> e : floorDoc.asMap().entrySet()) {
                Double n = e.getValue().asNumber();
                if (n != null) data.floors.put(e.getKey(), n.intValue());
            }
        }

        // unported.json: suite stem -> test name -> {card, family}; "//" keys are commentary.
        Json unported = read(parityDir.resolve("unported.json"));
        for (Map.Entry<String, Json> suite : unported.asMap().entrySet()) {
            if (suite.getKey().startsWith("//") || suite.getValue().asMap() == null) continue;
            for (Json entry : suite.getValue().asMap().values()) {
                String family = entry.get("family") == null ? null : entry.get("family").asString();
                if (family != null) data.unportedFamilies.merge(family, 1, Integer::sum);
            }
        }

        Path fixturesDir = parityDir.resolve("fixtures");
        if (Files.isDirectory(fixturesDir)) {
            try (Stream<Path> walk = Files.walk(fixturesDir)) {
                walk.filter(p -> Files.isRegularFile(p) && p.getFileName().toString().endsWith(".json"))
                        .forEach(p -> data.filesOnDisk.add(root.relativize(p.toAbsolutePath().normalize()).toString().replace('\\', '/')));
            } catch (IOException e) {
                throw new HarnessError("E_BAD_CASE", "cannot walk " + fixturesDir + ": " + e);
            }
        }
        return data;
    }

    /**
     * Where player/parity/ is.
     *
     * <ol>
     *   <li>{@code FORAY_PARITY_DIR} (environment), when set: the directory itself, or its
     *       {@code fixtures/} child, as the Swift ParityLocator accepts. Set but wrong is an
     *       ERROR, never a quiet fall-through: CI sets it precisely so it cannot silently
     *       read some other tree (android-build.yml's mutation check points it at a copy).
     *   <li>The {@code foray.parity.dir} system property, which build.gradle sets to the
     *       checkout's player/parity for the {@code test} task.
     *   <li>Otherwise walk up from the working directory to the first ancestor holding
     *       player/parity/manifest.json (an IDE run from the module directory).
     * </ol>
     */
    public static Path locate(Map<String, String> env, String property, Path workingDir) {
        String configured = env.get("FORAY_PARITY_DIR");
        if (configured != null && !configured.isEmpty()) {
            Path dir = Path.of(configured).toAbsolutePath().normalize();
            if (Files.isRegularFile(dir.resolve("manifest.json"))) return dir;
            if (dir.getFileName() != null && dir.getFileName().toString().equals("fixtures")
                    && Files.isRegularFile(dir.getParent().resolve("manifest.json"))) {
                return dir.getParent();
            }
            throw new HarnessError("E_BAD_CASE", "FORAY_PARITY_DIR=" + configured + " holds no manifest.json (nor does its parent)");
        }
        if (property != null && !property.isEmpty()) {
            Path dir = Path.of(property).toAbsolutePath().normalize();
            if (Files.isRegularFile(dir.resolve("manifest.json"))) return dir;
            throw new HarnessError("E_BAD_CASE", "foray.parity.dir=" + property + " holds no manifest.json");
        }
        for (Path dir = workingDir.toAbsolutePath().normalize(); dir != null; dir = dir.getParent()) {
            Path candidate = dir.resolve("player").resolve("parity");
            if (Files.isRegularFile(candidate.resolve("manifest.json"))) return candidate;
        }
        throw new HarnessError("E_BAD_CASE", "no player/parity/manifest.json above " + workingDir
                + ", and neither FORAY_PARITY_DIR nor foray.parity.dir is set");
    }
}
