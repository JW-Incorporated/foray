import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * G-21c part (1) — the publish gate runs the app's OWN suites against the
 * data files a publish has just written, before the PR is opened.
 *
 * WHY (docs/curation/foray-to-spec-roadmap.md G-21c, measured 2026-09-11).
 * Four publish-gate defects on the three generated Forays so far — F-78,
 * F-84, F-89 and F-90 — were every one found by CI on the data PR and none by
 * the pipeline's validate step. The third Foray's data PR (#632) went red in
 * `player/media-session.test.js` ("every segment of every shipped Foray maps
 * to a non-empty title and artist"), `tools/foray/check-forays.test.mjs`
 * ("every committed Foray's report is consistent with the items it lists")
 * and `tools/mobile/prepare-webdir.test.mjs` ("REAL REPO: the sliced
 * bundle...") — all suites that read the real `data/forays.json`,
 * `data/segments.json` and `data/segment-sources.json`. `publishForay` had
 * run `check-forays.mjs` and `check-narration.mjs` and called the candidate
 * valid. The pipeline's idea of "valid" is narrower than the app's: the
 * checker validates the DOCUMENT, the suites validate what every CONSUMER of
 * the document does with it (the lock-screen credit, the bundle slice, the
 * directory hydration). So the gate now runs the consumers.
 *
 * HOW. `publishForay` writes the three files into the working tree exactly as
 * it always has, then — before commit/push/PR — runs `node --test` over
 * `REAL_DATA_SUITES` with cwd = the repo root (the same way
 * `tools/ci/run-suites.mjs` runs them: every one of them is in the ROOT group
 * or under a package whose `test` script is plain `node --test`, and their
 * dependencies resolve from the file's own location, not the cwd — verified
 * 2026-09-11: 11 suites, 613 tests, ~46s from the root). The TAP output is
 * parsed for `not ok` lines and the `error:` / `location:` fields that follow
 * each; a red suite refuses the publish with the assertion text in the
 * report, and the working tree is put back (see `publishForay.ts`).
 *
 * THE LIST CANNOT ROT. `backend/test/publishSuites.test.ts` greps the repo
 * for every suite whose source reads one of the three data files
 * (`REAL_DATA_READ_RE`) and fails when one is missing from
 * `REAL_DATA_SUITES`. Adding a suite that reads `data/forays.json` therefore
 * means adding it here, in the same PR, or the backend check goes red.
 */

/**
 * Repo-relative test files that read the REAL `data/forays.json`,
 * `data/segments.json` or `data/segment-sources.json` (not a fixture copy).
 * The first four are the ones G-21c names; the rest are every other hit of
 * `REAL_DATA_READ_RE` on 2026-09-11. Order is the roadmap's, then alphabetical.
 */
export const REAL_DATA_SUITES: readonly string[] = [
  "player/media-session.test.js",
  "tools/foray/check-forays.test.mjs",
  "tools/mobile/prepare-webdir.test.mjs",
  "test/foray-directory.test.js",
  "player/foray-playback.test.js",
  "player/foray-sources.test.js",
  "player/segment-strip.test.js",
  "test/draft-forays-switch.test.js",
  "test/home-v2-real-data.test.js",
  "tools/mobile/shell-invariants.test.mjs",
  "tools/segments/merge-segments.test.mjs",
  /* G-21c part (2) — added by audit finding B, 2026-09-12. This suite reads the
     REAL `data/` (`loadFiles(DATA_ROOT)`, DATA_ROOT = the repo root unless
     FORAY_DATA_ROOT is set), but it names no filename on the line that reads
     them, so `REAL_DATA_READ_RE`'s filename half never saw it and the anti-rot
     grep in `backend/test/publishSuites.test.ts` passed while the suite was
     missing from the gate. Part (2) of G-21c was therefore invisible to part
     (1): the publish that lands a new shape would go green locally and red in
     CI, which is the exact failure #632 made this card exist. `loadFiles(` is
     now an alternative in the regex, so this cannot rot back out. */
  "tools/foray/fixture-coverage.test.mjs"
];

/**
 * A source line that READS one of the three data files: a read-shaped call
 * (`readJson(...)`, `readData(...)`, `fs.readFileSync(...)`, the `read`/`DATA`
 * helpers the suites define) whose argument names `forays.json`,
 * `segments.json` or `segment-sources.json`. Deliberately a call, not a bare
 * mention: `"data/forays.json"` also appears in manifests, fetch fixtures and
 * comments (`player/foray-directory.test.js`, `test/sw-generation.test.js`,
 * `tools/ci/forays-directory.test.mjs`) that never open the file. Applied per
 * line; a call split across lines is not matched, so keep reads on one line.
 *
 * THE SECOND ALTERNATIVE, `loadFiles(` (audit finding B, 2026-09-12).
 * `check-forays.mjs` exports `loadFiles(root)`, which opens all three data
 * files (plus `data/taxonomy.json`) from a checkout root — so a suite that
 * calls it reads the real data while naming no filename at all. Two suites do
 * (`tools/foray/check-forays.test.mjs`, `tools/foray/fixture-coverage.test.mjs`)
 * and the second was missing from `REAL_DATA_SUITES` for exactly this reason,
 * with the anti-rot grep green. A bare `loadFiles(` is enough to match: the
 * name has one meaning in this repo, and a suite that calls it with a FIXTURE
 * root (`loadFiles(FIXTURE_ROOT)`) is a false positive costing one entry in a
 * list, where a miss costs the gate.
 */
export const REAL_DATA_READ_RE =
  /\b(?:readJson|readData|readFileSync|readFile|read|DATA|require|loadJson|readJSON)\s*\([^;\n]*?\b(?:forays|segments|segment-sources)\.json|\bloadFiles\s*\(/;

/** One failed assertion, as `node --test`'s TAP reporter describes it. */
export interface SuiteFailure {
  /** Repo-relative suite path (from the TAP `location:` field), or the test
   * name when the failure is the suite itself failing to load. */
  suite: string;
  /** The test's name — the `not ok N - <name>` text. */
  name: string;
  /** The TAP `error:` field: the assertion message. */
  error: string;
  /** The TAP `location:` field: `<file>:<line>:<col>`, repo-relative. */
  location: string;
}

export interface SuiteRunResult {
  ok: boolean;
  failures: SuiteFailure[];
  durationMs: number;
  /** The TAP footer's `# tests` / `# pass` / `# fail` — `null` when the run
   * produced no footer (the runner could not start). */
  counts: { tests: number; pass: number; fail: number } | null;
  /** `node --test`'s exit status; `null` when it could not be spawned. */
  exitCode: number | null;
  /** The files that were run, repo-relative. */
  files: readonly string[];
}

/** What `runRealDataSuites` needs from `spawnSync`. Injected so the gate's
 * refusal path is testable with a fixture TAP and no real test run. */
export type SuiteSpawn = (
  cmd: string,
  args: readonly string[],
  opts: { cwd: string }
) => { status: number | null; stdout: string; stderr: string; error?: Error };

const defaultSpawn: SuiteSpawn = (cmd, args, opts) => {
  const r = spawnSync(cmd, [...args], {
    cwd: opts.cwd,
    encoding: "utf8",
    env: process.env,
    // 613 tests of TAP with YAML blocks is a few hundred KB; leave headroom for
    // a run where every assertion fails with a stack.
    maxBuffer: 64 * 1024 * 1024
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
};

/** Unquote a TAP YAML scalar: `'C:\\x\\y.js:4:1'` → `C:\x\y.js:4:1`. The
 * reporter single-quotes strings and doubles backslashes and quotes inside. */
function unquoteYaml(raw: string): string {
  const s = raw.trim();
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1).replace(/''/g, "'").replace(/\\\\/g, "\\");
  }
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

/** `C:\repo\player\x.test.js:4:1` → `player/x.test.js:4:1` when the file is
 * under `repoRoot`; otherwise the path as given (forward slashes). */
function relativeLocation(location: string, repoRoot: string): string {
  const m = /^(.*?)(:\d+:\d+)?$/.exec(location);
  const file = m?.[1] ?? location;
  const suffix = m?.[2] ?? "";
  const rel = path.relative(repoRoot, file);
  const inside = rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
  return `${(inside ? rel : file).split(path.sep).join("/")}${suffix}`;
}

/**
 * Every failed assertion in a `node --test --test-reporter=tap` transcript.
 *
 * Node 24's TAP reporter flattens the tests of every file into one stream —
 * there is no per-file wrapper — so the suite is read off each failure's
 * `location:`. `describe` blocks DO nest: the block itself is reported as a
 * parent `not ok` with `failureType: 'subtestsFailed'` above its indented
 * children, and that parent carries no assertion of its own, so it is skipped
 * — the child is the failure. A suite that fails to LOAD (syntax error,
 * missing module) is one `not ok` whose name is the file path and which has
 * no `location:`; its suite is that name.
 */
export function parseTapFailures(tap: string, repoRoot: string): SuiteFailure[] {
  const lines = tap.split(/\r?\n/);
  const failures: SuiteFailure[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = /^\s*not ok\s+\d+\s*-?\s*(.*)$/.exec(lines[i] ?? "");
    if (!head) continue;
    // Drop a trailing `# SKIP`/`# TODO` directive (an unescaped `#`), then
    // unescape the `\#` the reporter writes for a literal `#` in a name.
    const name = (head[1] ?? "")
      .replace(/\s+#.*$/, "")
      .trim()
      .replace(/\\#/g, "#");
    const fields: Record<string, string> = {};
    // The YAML block: `---` ... `...`, indented deeper than the `not ok`.
    let j = i + 1;
    if (/^\s*---\s*$/.test(lines[j] ?? "")) {
      for (j = j + 1; j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j] ?? ""); j++) {
        const kv = /^\s*([A-Za-z_]+):\s?(.*)$/.exec(lines[j] ?? "");
        if (kv && !(kv[1]! in fields)) fields[kv[1]!] = kv[2] ?? "";
      }
    }
    if (fields.failureType !== undefined && unquoteYaml(fields.failureType) === "subtestsFailed") continue;
    const location = fields.location !== undefined ? relativeLocation(unquoteYaml(fields.location), repoRoot) : "";
    const suite = location ? location.replace(/:\d+:\d+$/, "") : relativeLocation(name, repoRoot);
    failures.push({
      suite,
      name,
      error: fields.error !== undefined ? unquoteYaml(fields.error) : "(no error field in TAP output)",
      location
    });
  }
  return failures;
}

/** The `# tests N` / `# pass N` / `# fail N` footer, or null without one. */
export function parseTapCounts(tap: string): SuiteRunResult["counts"] {
  const get = (re: RegExp): number | null => {
    const m = re.exec(tap);
    return m ? Number(m[1]) : null;
  };
  const tests = get(/^# tests (\d+)\s*$/m);
  const pass = get(/^# pass (\d+)\s*$/m);
  const fail = get(/^# fail (\d+)\s*$/m);
  if (tests === null || pass === null || fail === null) return null;
  return { tests, pass, fail };
}

/**
 * Runs `node --test --test-reporter=tap <files>` with cwd = `repoRoot` — AFTER
 * the data files are written and BEFORE any commit — and returns what failed.
 *
 * `ok` is `exitCode === 0 && failures.length === 0 && counts !== null`: a run
 * that exits non-zero without a parseable `not ok` (the runner itself died)
 * is still not ok, and is reported as one synthetic failure so the reason is
 * in the report rather than lost.
 */
export function runRealDataSuites(opts: {
  repoRoot: string;
  files?: readonly string[];
  spawn?: SuiteSpawn;
}): SuiteRunResult {
  const files = opts.files ?? REAL_DATA_SUITES;
  const spawn = opts.spawn ?? defaultSpawn;
  const started = Date.now();
  const r = spawn(process.execPath, ["--test", "--test-reporter=tap", ...files], { cwd: opts.repoRoot });
  const durationMs = Date.now() - started;
  const failures = parseTapFailures(r.stdout, opts.repoRoot);
  const counts = parseTapCounts(r.stdout);
  if (r.error) {
    failures.push({
      suite: "(runner)",
      name: "node --test could not be started",
      error: r.error.message,
      location: ""
    });
  } else if (r.status !== 0 && failures.length === 0) {
    failures.push({
      suite: "(runner)",
      name: `node --test exited ${r.status ?? "null"} with no parseable failure`,
      error: (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-20).join("\n"),
      location: ""
    });
  } else if (r.status === 0 && counts === null) {
    failures.push({
      suite: "(runner)",
      name: "node --test exited 0 but printed no TAP footer",
      error: "the run did not report `# tests` — nothing was proven; treating as red",
      location: ""
    });
  }
  return {
    ok: r.status === 0 && failures.length === 0 && counts !== null,
    failures,
    durationMs,
    counts,
    exitCode: r.error ? null : r.status,
    files
  };
}

/** One line for the console and the report: what ran, how it went. */
export function suiteSummaryLine(result: SuiteRunResult): string {
  const c = result.counts;
  const tests = c ? `${c.tests} tests, ${c.pass} passed, ${c.fail} failed` : "no TAP footer";
  return (
    `real-data suites (G-21c): ${result.ok ? "GREEN" : "RED"} — ${result.files.length} suites, ${tests}, ` +
    `${result.failures.length} failure(s), ${(result.durationMs / 1000).toFixed(1)}s`
  );
}

/** The failures as the console and the PR body print them. */
export function formatSuiteFailure(f: SuiteFailure): string {
  const where = f.location && f.location !== f.suite ? ` (${f.location})` : "";
  return `${f.suite} › ${f.name}: ${f.error}${where}`;
}

/**
 * THE ONE SUITE WHOSE ASSERTION INVERTS, AND WHAT THE OPERATOR HAS TO DO
 * (audit finding B, 2026-09-12).
 *
 * `tools/foray/fixture-coverage.test.mjs` holds `KNOWN_UNCOVERED`: shapes
 * `check-forays.mjs` accepts that no committed Foray carries yet. Each entry
 * is asserted to be STILL uncovered — so the day a publish lands a carrier for
 * `segment.boundary = "turn"`, that suite goes red saying the shape "is now
 * carried by <id>". Every other suite in this gate goes red because something
 * is WRONG with the data. This one goes red because something is RIGHT with
 * it, and the fix is a one-line deletion in the same PR, not a change to the
 * Foray. A publisher shown only `KNOWN_UNCOVERED: segment.boundary = "turn"
 * still has no committed carrier — AssertionError` reads it as the publish
 * being rejected and re-cuts a perfectly good Foray.
 *
 * So the verdict spells it out. Returns the guidance lines for `failures`, or
 * `[]` when none of them came from that suite's inverted assertions.
 */
export function knownUncoveredGuidance(failures: readonly SuiteFailure[]): string[] {
  const shapes = failures
    .filter((f) => /^KNOWN_UNCOVERED:\s/.test(f.name))
    .map((f) => f.name.replace(/^KNOWN_UNCOVERED:\s*/, "").replace(/\s+still has no committed carrier\s*$/, "").trim())
    .filter((s) => s.length > 0);
  if (shapes.length === 0) return [];
  return [
    `${shapes.length === 1 ? "This publish lands a shape" : `This publish lands ${shapes.length} shapes`} the coverage gate ` +
      `still lists as uncovered. That is not a defect in the Foray — it is the fixture arriving (G-21c part (2)).`,
    ...shapes.map((s) => `DELETE the KNOWN_UNCOVERED entry for ${s} from tools/foray/fixture-coverage.test.mjs IN THIS PR.`),
    "Until the entries are gone the gate stays red, here and in CI: the per-entry assertion inverts the moment a carrier " +
      "lands. Lower KNOWN_UNCOVERED_CEILING in the same commit if you want the ceiling to follow the list down; do not " +
      "re-cut the Foray, and do not --force past this."
  ];
}
