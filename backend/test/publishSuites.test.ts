import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  REAL_DATA_READ_RE,
  REAL_DATA_SUITES,
  formatSuiteFailure,
  knownUncoveredGuidance,
  parseTapCounts,
  parseTapFailures,
  runRealDataSuites,
  suiteSummaryLine,
  type SuiteSpawn
} from "../src/cli/publishSuites";

/**
 * G-21c part (1): the publish gate runs the app's own real-data suites, and
 * the list of those suites cannot rot.
 *
 * MUTATIONS, one per test:
 *   - drop `player/media-session.test.js` from REAL_DATA_SUITES → "names the
 *     four suites G-21c lists" is red;
 *   - drop `tools/segments/merge-segments.test.mjs` (or any other grep hit)
 *     from REAL_DATA_SUITES, or add a new suite that `readJson("data/
 *     forays.json")`s without listing it → "every suite on disk that reads a
 *     real data file is listed" is red;
 *   - misspell a listed path → "every listed suite exists on disk" is red;
 *   - widen REAL_DATA_READ_RE to a bare `forays.json` mention → the manifest/
 *     fetch-fixture/comment negatives go red; narrow it (drop `DATA`) → the
 *     home-v2 positive goes red;
 *   - make `parseTapFailures` return `[]`, or stop unquoting `location:` →
 *     "one `not ok` → one failure with name/error/location" is red;
 *   - treat `ok N` lines as failures → "all ok → ok:true" is red;
 *   - drop the `subtestsFailed` skip → "the describe parent is not a second
 *     failure" is red;
 *   - derive the suite only from `location:` → "a suite that fails to load"
 *     is red;
 *   - drop `--test-reporter=tap` or run from a cwd other than repoRoot →
 *     "spawns node --test ... with cwd = repoRoot" is red;
 *   - ignore `spawn`'s `error` → "cannot be started" is red;
 *   - compute `ok` from failures alone (ignore the exit status) → "exits
 *     non-zero with nothing parseable" is red;
 *   - drop the `counts !== null` term → "exits 0 with no TAP footer" is red;
 *   - change the summary label or the `suite › name: error (location)`
 *     shape → "summary line and failure line" is red.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");

/* The four suites the roadmap card names; the pipeline's third Foray broke
   three of them after check-forays.mjs had passed it. */
const NAMED_BY_G21C = [
  "player/media-session.test.js",
  "tools/foray/check-forays.test.mjs",
  "tools/mobile/prepare-webdir.test.mjs",
  "test/foray-directory.test.js"
];

/* Same discovery as the task brief: every `*.test.{js,mjs,cjs}` under the repo
   root, excluding node_modules, backend/ (vitest suites, not node --test) and
   dot-directories (.claude/ worktrees, .git). */
const SUITE_RE = /\.test\.(js|mjs|cjs)$/;
function findSuites(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (relPath === "backend") continue;
      out.push(...findSuites(path.join(dir, entry.name), relPath));
    } else if (SUITE_RE.test(entry.name)) {
      out.push(relPath);
    }
  }
  return out.sort();
}

/** A TAP `location:` value for `abs` the way node's reporter single-quotes it. */
function yamlPath(abs: string): string {
  return `'${abs.replace(/\\/g, "\\\\")}'`;
}

function okEntry(n: number, name: string): string {
  return `# Subtest: ${name}\nok ${n} - ${name}\n  ---\n  duration_ms: 1.1\n  type: 'test'\n  ...\n`;
}

function notOkEntry(n: number, name: string, opts: { file?: string; line?: number; error: string; failureType?: string; indent?: string }): string {
  const i = opts.indent ?? "";
  const loc = opts.file ? `${i}  location: ${yamlPath(`${opts.file}:${opts.line ?? 1}:1`)}\n` : "";
  return (
    `${i}# Subtest: ${name}\n${i}not ok ${n} - ${name}\n${i}  ---\n${i}  duration_ms: 1.2\n${i}  type: 'test'\n${loc}` +
    `${i}  failureType: '${opts.failureType ?? "testCodeFailure"}'\n${i}  error: '${opts.error.replace(/'/g, "''")}'\n` +
    `${i}  code: 'ERR_ASSERTION'\n${i}  stack: |-\n${i}    TestContext.<anonymous> (x.js:5:10)\n${i}  ...\n`
  );
}

function footer(tests: number, pass: number, fail: number): string {
  return `1..${tests}\n# tests ${tests}\n# suites 0\n# pass ${pass}\n# fail ${fail}\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 146.5\n`;
}

/* A fake repo root the fixture locations sit under; absolute on either OS. */
const ROOT = path.resolve(process.platform === "win32" ? "C:/fake-repo" : "/fake-repo");
const MEDIA = path.join(ROOT, "player", "media-session.test.js");
const ASSERTION = "segment seg-1 of foray-x has an empty artist";

const RED_TAP =
  "TAP version 13\n" +
  okEntry(1, "passes fine") +
  notOkEntry(2, "every segment of every shipped Foray maps to a non-empty title and artist", { file: MEDIA, line: 284, error: ASSERTION }) +
  footer(2, 1, 1);

const GREEN_TAP = "TAP version 13\n" + okEntry(1, "passes fine") + okEntry(2, "Foray \\#1 is in data/forays.json") + footer(2, 2, 0);

function fakeSpawn(reply: { status: number | null; stdout: string; stderr?: string; error?: Error }): { spawn: SuiteSpawn; calls: Array<{ cmd: string; args: string[]; cwd: string }> } {
  const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
  const spawn: SuiteSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], cwd: opts.cwd });
    return { status: reply.status, stdout: reply.stdout, stderr: reply.stderr ?? "", error: reply.error };
  };
  return { spawn, calls };
}

describe("REAL_DATA_SUITES — the list of suites the publish gate runs", () => {
  it("names the four suites G-21c lists", () => {
    for (const s of NAMED_BY_G21C) expect(REAL_DATA_SUITES).toContain(s);
  });

  it("every suite on disk that reads a real data file is listed (the list cannot rot)", () => {
    const readers = findSuites(REPO_ROOT).filter((rel) =>
      fs
        .readFileSync(path.join(REPO_ROOT, rel), "utf8")
        .split(/\r?\n/)
        .some((line) => REAL_DATA_READ_RE.test(line))
    );
    expect(readers.length).toBeGreaterThanOrEqual(NAMED_BY_G21C.length - 1); // check-forays reads via loadFiles(), not a literal
    const missing = readers.filter((r) => !REAL_DATA_SUITES.includes(r));
    expect(
      missing,
      `these suites read data/forays.json, data/segments.json or data/segment-sources.json but are not in REAL_DATA_SUITES ` +
        `(backend/src/cli/publishSuites.ts) — a publish could break them without the gate noticing (G-21c):\n${missing.join("\n")}`
    ).toEqual([]);
  });

  it("every listed suite exists on disk, is a node --test suite, and is listed once", () => {
    for (const rel of REAL_DATA_SUITES) {
      expect(rel, `${rel} is not a *.test.{js,mjs,cjs} path`).toMatch(SUITE_RE);
      expect(fs.existsSync(path.join(REPO_ROOT, rel)), `${rel} is missing on disk`).toBe(true);
    }
    expect(new Set(REAL_DATA_SUITES).size).toBe(REAL_DATA_SUITES.length);
  });

  it("REAL_DATA_READ_RE matches the repo's read idioms and not manifests, fetch fixtures or comments", () => {
    const positives = [
      'const FORAYS = readJson("data/forays.json");',
      '  forays: readData("data/forays.json"),',
      '  forays: DATA("forays.json"),',
      'const doc = JSON.parse(readFileSync(join(ROOT, "data", "segments.json"), "utf8"));',
      'const forays = readJson(path.join(ROOT, "data", "forays.json"));',
      '    sources: indexSources(readJson("data/segment-sources.json")),',
      '  const bundledForays = read("data/forays.json");'
    ];
    const negatives = [
      '    files: { forays: "data/forays.json", segments: "data/segments.json", sources: "data/segment-sources.json" },',
      'const FORAYS = "data/forays.json";',
      "  r[`${ORIGIN}/data/forays.json`] = set.forays;",
      '  assert.equal(resolveFileUrl(ORIGIN, "data/forays.json"), `${ORIGIN}/data/forays.json`);',
      " * the generated Forays, which land in data/forays.json as `status: \"draft\"`",
      '  const files = { "app.js": "sha256:aa", "data/forays.json": "sha256:bb" };'
    ];
    for (const line of positives) expect(REAL_DATA_READ_RE.test(line), `should match: ${line}`).toBe(true);
    for (const line of negatives) expect(REAL_DATA_READ_RE.test(line), `should NOT match: ${line}`).toBe(false);
  });
});

describe("parseTapFailures — node --test's TAP, reduced to the failing assertions", () => {
  it("one `not ok` → one failure with name, assertion text and a repo-relative location", () => {
    const failures = parseTapFailures(RED_TAP, ROOT);
    expect(failures).toEqual([
      {
        suite: "player/media-session.test.js",
        name: "every segment of every shipped Foray maps to a non-empty title and artist",
        error: ASSERTION,
        location: "player/media-session.test.js:284:1"
      }
    ]);
  });

  it("all ok → no failures, and runRealDataSuites reports ok:true with the footer's counts", () => {
    expect(parseTapFailures(GREEN_TAP, ROOT)).toEqual([]);
    expect(parseTapCounts(GREEN_TAP)).toEqual({ tests: 2, pass: 2, fail: 0 });
    const { spawn } = fakeSpawn({ status: 0, stdout: GREEN_TAP });
    const result = runRealDataSuites({ repoRoot: ROOT, files: ["player/media-session.test.js"], spawn });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.counts).toEqual({ tests: 2, pass: 2, fail: 0 });
    expect(result.exitCode).toBe(0);
  });

  it("the describe parent (`subtestsFailed`) is not a second failure — the child carries the assertion", () => {
    const tap =
      "TAP version 13\n# Subtest: the block\n" +
      notOkEntry(1, "inner assertion", { file: MEDIA, line: 30, error: "inner says no", indent: "    " }) +
      "    1..1\n" +
      notOkEntry(1, "the block", { file: MEDIA, line: 20, error: "1 subtest failed", failureType: "subtestsFailed" }) +
      footer(2, 0, 2);
    const failures = parseTapFailures(tap, ROOT);
    expect(failures.map((f) => f.name)).toEqual(["inner assertion"]);
    expect(failures[0]!.error).toBe("inner says no");
    expect(failures[0]!.location).toBe("player/media-session.test.js:30:1");
  });

  it("a suite that fails to load (no `location:`) is attributed by its name", () => {
    const file = path.join(ROOT, "tools", "mobile", "shell-invariants.test.mjs");
    const tap =
      "TAP version 13\n" +
      `# Subtest: ${file}\nnot ok 1 - ${file}\n  ---\n  duration_ms: 3\n  type: 'test'\n  failureType: 'testCodeFailure'\n  error: 'Cannot find module ''esbuild'''\n  code: 'ERR_MODULE_NOT_FOUND'\n  ...\n` +
      footer(1, 0, 1);
    const failures = parseTapFailures(tap, ROOT);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.suite).toBe("tools/mobile/shell-invariants.test.mjs");
    expect(failures[0]!.location).toBe("");
    expect(failures[0]!.error).toBe("Cannot find module 'esbuild'");
  });
});

describe("runRealDataSuites — how the suites are run and how a broken run is reported", () => {
  it("spawns node --test --test-reporter=tap <files> with cwd = repoRoot", () => {
    const { spawn, calls } = fakeSpawn({ status: 0, stdout: GREEN_TAP });
    runRealDataSuites({ repoRoot: ROOT, files: ["player/a.test.js", "tools/b.test.mjs"], spawn });
    expect(calls).toEqual([
      { cmd: process.execPath, args: ["--test", "--test-reporter=tap", "player/a.test.js", "tools/b.test.mjs"], cwd: ROOT }
    ]);
  });

  it("defaults to REAL_DATA_SUITES when no files are given", () => {
    const { spawn, calls } = fakeSpawn({ status: 0, stdout: GREEN_TAP });
    const result = runRealDataSuites({ repoRoot: ROOT, spawn });
    expect(calls[0]!.args.slice(2)).toEqual([...REAL_DATA_SUITES]);
    expect(result.files).toEqual(REAL_DATA_SUITES);
  });

  it("a runner that cannot be started is not ok, with the spawn error as the one failure", () => {
    const { spawn } = fakeSpawn({ status: null, stdout: "", error: new Error("spawn ENOENT") });
    const result = runRealDataSuites({ repoRoot: ROOT, spawn });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.failures).toEqual([{ suite: "(runner)", name: "node --test could not be started", error: "spawn ENOENT", location: "" }]);
  });

  it("a runner that exits non-zero with nothing parseable is not ok, carrying the stderr tail", () => {
    const { spawn } = fakeSpawn({ status: 1, stdout: "TAP version 13\n", stderr: "node: bad option --oops\n" });
    const result = runRealDataSuites({ repoRoot: ROOT, spawn });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.suite).toBe("(runner)");
    expect(result.failures[0]!.error).toContain("bad option --oops");
  });

  it("a runner that exits 0 with no TAP footer proved nothing and is not ok", () => {
    const { spawn } = fakeSpawn({ status: 0, stdout: "TAP version 13\n" });
    const result = runRealDataSuites({ repoRoot: ROOT, spawn });
    expect(result.ok).toBe(false);
    expect(result.counts).toBeNull();
    expect(result.failures[0]!.name).toMatch(/no TAP footer/);
  });

  it("a red run: ok:false, the parsed failure, the footer's counts and the exit status", () => {
    const { spawn } = fakeSpawn({ status: 1, stdout: RED_TAP });
    const result = runRealDataSuites({ repoRoot: ROOT, files: ["player/media-session.test.js"], spawn });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.counts).toEqual({ tests: 2, pass: 1, fail: 1 });
    expect(result.failures.map((f) => f.error)).toEqual([ASSERTION]);
  });

  it("summary line and failure line carry the label, the counts and `suite › name: error (location)`", () => {
    const { spawn } = fakeSpawn({ status: 1, stdout: RED_TAP });
    const result = runRealDataSuites({ repoRoot: ROOT, files: ["player/media-session.test.js", "test/x.test.js"], spawn });
    expect(suiteSummaryLine(result)).toMatch(/^real-data suites \(G-21c\): RED — 2 suites, 2 tests, 1 passed, 1 failed, 1 failure\(s\), \d+\.\ds$/);
    expect(formatSuiteFailure(result.failures[0]!)).toBe(
      `player/media-session.test.js › every segment of every shipped Foray maps to a non-empty title and artist: ${ASSERTION} (player/media-session.test.js:284:1)`
    );
    const green = runRealDataSuites({ repoRoot: ROOT, files: ["a.test.js"], spawn: fakeSpawn({ status: 0, stdout: GREEN_TAP }).spawn });
    expect(suiteSummaryLine(green)).toMatch(/^real-data suites \(G-21c\): GREEN — 1 suites, 2 tests, 2 passed, 0 failed, 0 failure\(s\)/);
  });
});

/**
 * AUDIT FINDING B (2026-09-12): G-21c part (2) was invisible to G-21c part (1).
 *
 * MUTATIONS, one per test:
 *   - drop `tools/foray/fixture-coverage.test.mjs` from REAL_DATA_SUITES → "the
 *     fixture-coverage suite is in the gate" is red (and so is the anti-rot
 *     grep above, now that the regex can see it — which is the point);
 *   - drop the `|\bloadFiles\s*\(` alternative from REAL_DATA_READ_RE → "a bare
 *     `loadFiles(` read is a real-data read" is red;
 *   - make `knownUncoveredGuidance` return `[]`, or drop the word DELETE, or
 *     stop naming the shape → "says DELETE the entry, names the shape" is red;
 *   - make it match any failure rather than `KNOWN_UNCOVERED: ` names → "an
 *     ordinary red suite gets no coverage-gate guidance" is red.
 */
describe("the fixture-coverage suite joins the publish gate (G-21c part (2))", () => {
  it("the fixture-coverage suite is in the gate, and reads the real data root", () => {
    expect(REAL_DATA_SUITES).toContain("tools/foray/fixture-coverage.test.mjs");
    const src = fs.readFileSync(path.join(REPO_ROOT, "tools/foray/fixture-coverage.test.mjs"), "utf8");
    /* It reads `data/` through check-forays.mjs's loader, naming no filename —
       which is exactly why the grep could not see it before. */
    expect(src).toMatch(/loadFiles\(DATA_ROOT\)/);
  });

  it("a bare `loadFiles(` read is a real-data read, and the negatives still are not", () => {
    expect(REAL_DATA_READ_RE.test("const files = loadFiles(DATA_ROOT);")).toBe(true);
    expect(REAL_DATA_READ_RE.test("const live = loadFiles(REPO_ROOT);")).toBe(true);
    expect(REAL_DATA_READ_RE.test('import { ACCEPTED_SHAPES, loadFiles } from "./check-forays.mjs";')).toBe(false);
    expect(REAL_DATA_READ_RE.test('const FORAYS = "data/forays.json";')).toBe(false);
  });

  it("a KNOWN_UNCOVERED failure says DELETE the entry in this PR, and names the shape", () => {
    const lines = knownUncoveredGuidance([
      {
        suite: "tools/foray/fixture-coverage.test.mjs",
        name: 'KNOWN_UNCOVERED: segment.boundary = "turn" still has no committed carrier',
        error: 'segment.boundary = "turn" is now carried by engineers-1',
        location: "tools/foray/fixture-coverage.test.mjs:210:3"
      }
    ]);
    expect(lines.join("\n")).toMatch(/DELETE the KNOWN_UNCOVERED entry for segment\.boundary = "turn"/);
    expect(lines.join("\n")).toMatch(/tools\/foray\/fixture-coverage\.test\.mjs IN THIS PR/);
    /* The operator must be told not to re-cut a perfectly good Foray. */
    expect(lines.join("\n")).toMatch(/do not re-cut the Foray/);
    expect(lines.join("\n")).not.toMatch(/still has no committed carrier/);
  });

  it("an ordinary red suite gets no coverage-gate guidance", () => {
    expect(
      knownUncoveredGuidance([
        { suite: "player/media-session.test.js", name: "every segment maps to an artist", error: ASSERTION, location: "" }
      ])
    ).toEqual([]);
    expect(knownUncoveredGuidance([])).toEqual([]);
  });
});
