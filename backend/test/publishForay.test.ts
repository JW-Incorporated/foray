import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PUBLISH_BASE,
  PUBLISH_DATA_FILES,
  abandonPublishBranch,
  assertDataFilesMatchMain,
  commitPublish,
  currentRef,
  cutPublishBranch,
  gateWrittenTree,
  publishPrBody,
  recordPublishInReport,
  recordRefusalInReport,
  restoreDataFiles,
  snapshotDataFiles,
  type Out,
  type Runner
} from "../src/cli/publishForay";
import type { SuiteSpawn } from "../src/cli/publishSuites";

/**
 * F-75 (FD-07): the publish branch is cut from `origin/main`, never from the
 * checkout's HEAD. The first generated Foray was published from the generation
 * branch and its PR carried a hundred unrelated commits; a person re-based the
 * data files onto main by hand (PR #583).
 *
 * The git choreography is exercised through the injected `Runner`, recording
 * every command, so the assertions are about WHAT IS ASKED OF GIT — fetch
 * before switch, the start point of the switch, the post-commit proof — not
 * about a real repository's state.
 *
 * MUTATIONS: change `cutPublishBranch` back to `git switch -c <branch>` (the
 * pre-FD-07 line) → the start-point test is red; drop the fetch → the
 * fetch-before-switch test is red; drop the post-commit diff → the "carries a
 * file it did not write" test is red.
 */

function recorder(answers: Record<string, string> = {}): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = [cmd, ...args].join(" ");
    for (const [prefix, out] of Object.entries(answers)) if (key.startsWith(prefix)) return out;
    return "";
  };
  return { run, calls };
}

describe("publishForay branches from origin/main (F-75)", () => {
  it("cuts the publish branch from origin/main, not from HEAD", () => {
    const { run, calls } = recorder();
    cutPublishBranch(run, "generate/foray-x");
    expect(calls).toEqual([["git", "switch", "--no-track", "-c", "generate/foray-x", "origin/main"]]);
    expect(PUBLISH_BASE).toBe("origin/main");
  });

  it("fetches origin/main before comparing the three data files against it", () => {
    const { run, calls } = recorder();
    assertDataFilesMatchMain(run);
    expect(calls[0]).toEqual(["git", "fetch", "origin", "main"]);
    expect(calls[1]).toEqual(["git", "diff", "--name-only", "origin/main", "--", ...PUBLISH_DATA_FILES]);
  });

  it("refuses, naming the files, when a data file differs from origin/main before anything was written", () => {
    const { run, calls } = recorder({ "git diff --name-only origin/main --": "data/segments.json\ndata/forays.json\n" });
    expect(() => assertDataFilesMatchMain(run)).toThrow(/data\/segments\.json, data\/forays\.json differ .*origin\/main/);
    // Nothing was switched, written or pushed on the way to the refusal.
    expect(calls.some((c) => c[1] === "switch" || c[1] === "push" || c[1] === "commit")).toBe(false);
  });

  it("the three files it guards are exactly the three the app reads for Forays", () => {
    expect([...PUBLISH_DATA_FILES]).toEqual(["data/forays.json", "data/segments.json", "data/segment-sources.json"]);
  });
});

describe("commitPublish proves the commit is the publish and nothing else", () => {
  it("stages only the written files and passes when origin/main..HEAD is that one commit", () => {
    const { run, calls } = recorder({
      "git rev-list --count origin/main..HEAD": "1",
      "git diff --name-only origin/main HEAD": "data/segments.json\ndata/forays.json"
    });
    commitPublish(run, ["data/forays.json", "data/segments.json"], "Generated Foray: X (x)");
    expect(calls[0]).toEqual(["git", "add", "data/forays.json", "data/segments.json"]);
    expect(calls[1]).toEqual(["git", "commit", "-m", "Generated Foray: X (x)"]);
  });

  it("refuses when the commit carries a file the publish did not write", () => {
    const { run } = recorder({
      "git rev-list --count origin/main..HEAD": "1",
      "git diff --name-only origin/main HEAD": "data/forays.json\napp.js"
    });
    expect(() => commitPublish(run, ["data/forays.json"], "m")).toThrow(/touches \[app\.js, data\/forays\.json\] but this run wrote \[data\/forays\.json\]/);
  });

  it("refuses when origin/main..HEAD is more than the one publish commit (the F-75 shape)", () => {
    const { run } = recorder({
      "git rev-list --count origin/main..HEAD": "101",
      "git diff --name-only origin/main HEAD": "data/forays.json"
    });
    expect(() => commitPublish(run, ["data/forays.json"], "m")).toThrow(/101 commit\(s\), not the one publish commit/);
  });
});

describe("the PR body says what happens after merge", () => {
  it("names the base, the three files, and that phones pick the Foray up on next launch with no store build", () => {
    const body = publishPrBody({ id: "foray-x" }, { ok: true, failures: [] });
    expect(body).toMatch(/cut from `origin\/main`/);
    expect(body).toMatch(/phones pick this Foray up on next launch after the deploy/);
    expect(body).toMatch(/no store build/);
    expect(body).not.toMatch(/overridden/);
  });

  it("records a --force override with its failures", () => {
    const body = publishPrBody({ id: "foray-x" }, { ok: false, failures: ["unverifiedPages 2 > 0"] });
    expect(body).toMatch(/overridden with --force/);
    expect(body).toMatch(/- unverifiedPages 2 > 0/);
  });

  it("F-88: names every page verified by synthesis and the pages it rests on, and says nothing when there are none", () => {
    /* MUTATION THAT KILLS THIS: print the count without `restsOn`, or
       print the heading on a Foray with no synthesis page. */
    const body = publishPrBody(
      { id: "foray-x" },
      { ok: true, failures: [] },
      null,
      {
        synthesisVerifiedPages: 1,
        synthesisVerifiedPageDetails: [{ claim: "Most retellings compress months of decisions into a single moment", mode: "Hinge", restsOn: ["a0/s0/p0", "a0/s1/p0"] }]
      }
    );
    expect(body).toMatch(/1 page\(s\) verified by synthesis of the Foray's own verified pages/);
    expect(body).toMatch(/\[Hinge\] Most retellings compress months of decisions into a single moment — verified by synthesis of pages a0\/s0\/p0, a0\/s1\/p0/);
    expect(publishPrBody({ id: "foray-x" }, { ok: true, failures: [] }, null, { synthesisVerifiedPages: 0, synthesisVerifiedPageDetails: [] })).not.toMatch(/synthesis/);
    expect(publishPrBody({ id: "foray-x" }, { ok: true, failures: [] })).not.toMatch(/synthesis/);
  });
});

describe("recordPublishInReport — report.json carries the deploy id when known, null otherwise", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-fd07-report-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const record = (deployId: string | null) => ({
    pr_url: "https://github.com/JW-Incorporated/foray/pull/999",
    branch: "generate/foray-x",
    base: "origin/main",
    base_sha: "abc123",
    deploy_id: deployId,
    published_at: "2026-09-10T20:00:00.000Z"
  });

  it("writes the record onto the row whose file is the candidate, leaving deploy_id null when unknown", () => {
    const reportPath = path.join(dir, "report.json");
    fs.writeFileSync(
      reportPath,
      JSON.stringify({ generated_at: "x", dry_run: false, entries: [{ prompt: "p", outcome: "generated", detail: "OK foray-x", ms: 1, file: "out/foray-x.json" }] })
    );
    expect(recordPublishInReport(reportPath, "C:/somewhere/else/foray-x.json", record(null))).toBe(true);
    const doc = JSON.parse(fs.readFileSync(reportPath, "utf8")) as { entries: Array<{ publish?: { deploy_id: string | null } }> };
    expect(doc.entries[0]!.publish).toEqual(record(null));
    expect(doc.entries[0]!.publish!.deploy_id).toBeNull();
  });

  it("records the deploy id when one is given", () => {
    const reportPath = path.join(dir, "report.json");
    fs.writeFileSync(reportPath, JSON.stringify({ entries: [{ prompt: "p", outcome: "generated", detail: "OK", ms: 1, file: "foray-x.json" }] }));
    recordPublishInReport(reportPath, "foray-x.json", record("dpl_abc"));
    const doc = JSON.parse(fs.readFileSync(reportPath, "utf8")) as { entries: Array<{ publish?: { deploy_id: string | null } }> };
    expect(doc.entries[0]!.publish!.deploy_id).toBe("dpl_abc");
  });

  it("touches nothing and says so when the report has no row for the candidate", () => {
    const reportPath = path.join(dir, "report.json");
    const before = JSON.stringify({ entries: [{ prompt: "p", outcome: "generated", detail: "OK", ms: 1, file: "other.json" }] });
    fs.writeFileSync(reportPath, before);
    expect(recordPublishInReport(reportPath, "foray-x.json", record(null))).toBe(false);
    expect(fs.readFileSync(reportPath, "utf8")).toBe(before);
  });
});

/**
 * G-21c part (1): after the three files are written, the app's own real-data
 * suites run against them, and a red suite refuses the publish — leaving the
 * checkout exactly as a veracity refusal does (files back byte-for-byte, back
 * on the branch it started on, publish branch deleted).
 *
 * MUTATIONS, one per test:
 *   - drop `restoreDataFiles` from the refusal path → "refuses on a red suite
 *     ... restores the written bytes" is red (the file still says WRITTEN);
 *     drop `abandonPublishBranch` → the same test is red (no switch/-D);
 *   - ignore `force` → "proceeds under --force" is red;
 *   - restore or abandon on a GREEN run → "proceeds on green" is red;
 *   - drop `--detach` for a detached HEAD → "abandon on a detached HEAD" is red;
 *   - skip `null` entries in `restoreDataFiles` → "a file that did not exist
 *     is removed again" is red;
 *   - drop the override paragraph from the PR body → "the PR body notes a
 *     --force override of the suites" is red;
 *   - write `publish` instead of `publish_refused` → "recordRefusalInReport"
 *     is red.
 */

function silent(): { out: Out; lines: { log: string[]; warn: string[]; error: string[] } } {
  const lines = { log: [] as string[], warn: [] as string[], error: [] as string[] };
  return { out: { log: (l) => lines.log.push(l), warn: (l) => lines.warn.push(l), error: (l) => lines.error.push(l) }, lines };
}

/** A TAP transcript node --test would print for one red assertion in
 * `player/media-session.test.js` under `root`. */
function redTap(root: string): string {
  const loc = `${path.join(root, "player", "media-session.test.js")}:284:1`.replace(/\\/g, "\\\\");
  return (
    "TAP version 13\n# Subtest: every segment of every shipped Foray maps to a non-empty title and artist\n" +
    "not ok 1 - every segment of every shipped Foray maps to a non-empty title and artist\n  ---\n  duration_ms: 1\n  type: 'test'\n" +
    `  location: '${loc}'\n  failureType: 'testCodeFailure'\n  error: 'seg-1 of foray-x has an empty artist'\n  code: 'ERR_ASSERTION'\n  ...\n` +
    "1..1\n# tests 1\n# suites 0\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 5\n"
  );
}
const GREEN_TAP =
  "TAP version 13\n# Subtest: fine\nok 1 - fine\n  ---\n  duration_ms: 1\n  type: 'test'\n  ...\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 5\n";

const spawnReplying =
  (status: number, stdout: string): SuiteSpawn =>
  () => ({ status, stdout, stderr: "" });

describe("gateWrittenTree — the written files are gated by the app's real-data suites (G-21c)", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-g21c-"));
    fs.mkdirSync(path.join(dir, "data"));
    fs.writeFileSync(path.join(dir, "data", "forays.json"), '{"forays":["ORIGINAL"]}\n');
    fs.writeFileSync(path.join(dir, "data", "segments.json"), '{"segments":["ORIGINAL"]}\n');
    // data/segment-sources.json deliberately absent: the snapshot remembers that.
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = () => {
    fs.writeFileSync(path.join(dir, "data", "forays.json"), '{"forays":["ORIGINAL","WRITTEN"]}\n');
    fs.writeFileSync(path.join(dir, "data", "segment-sources.json"), '{"sources":["WRITTEN"]}\n');
  };
  const read = (rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");

  it("refuses on a red suite: prints the assertion, restores the written bytes, switches back and deletes the branch", () => {
    const snapshot = snapshotDataFiles(dir);
    write();
    const { run, calls } = recorder();
    const { out, lines } = silent();
    const { proceed, suites } = gateWrittenTree({
      repoRoot: dir,
      force: false,
      branch: "generate/foray-x",
      previousRef: { kind: "branch", name: "main" },
      snapshot,
      run,
      spawn: spawnReplying(1, redTap(dir)),
      out
    });
    expect(proceed).toBe(false);
    expect(suites.ok).toBe(false);
    expect(suites.failures.map((f) => [f.suite, f.name, f.error])).toEqual([
      ["player/media-session.test.js", "every segment of every shipped Foray maps to a non-empty title and artist", "seg-1 of foray-x has an empty artist"]
    ]);
    // The assertion text reached the console, with the refusal.
    expect(lines.error.some((l) => /media-session\.test\.js › .*empty artist/.test(l))).toBe(true);
    expect(lines.error.some((l) => /Refusing to publish/.test(l))).toBe(true);
    // The tree is exactly as it was: bytes back, the never-existing file gone.
    expect(read("data/forays.json")).toBe('{"forays":["ORIGINAL"]}\n');
    expect(fs.existsSync(path.join(dir, "data", "segment-sources.json"))).toBe(false);
    // Back on the branch it started on, publish branch deleted.
    expect(calls).toEqual([
      ["git", "switch", "main"],
      ["git", "branch", "-D", "generate/foray-x"]
    ]);
  });

  it("proceeds under --force on a red suite, leaving the written files in place and touching no git", () => {
    const snapshot = snapshotDataFiles(dir);
    write();
    const { run, calls } = recorder();
    const { out, lines } = silent();
    const { proceed, suites } = gateWrittenTree({
      repoRoot: dir,
      force: true,
      branch: "generate/foray-x",
      previousRef: { kind: "branch", name: "main" },
      snapshot,
      run,
      spawn: spawnReplying(1, redTap(dir)),
      out
    });
    expect(proceed).toBe(true);
    expect(suites.ok).toBe(false);
    expect(read("data/forays.json")).toBe('{"forays":["ORIGINAL","WRITTEN"]}\n');
    expect(calls).toEqual([]);
    expect(lines.warn.some((l) => /--force: publishing despite/.test(l))).toBe(true);
  });

  it("proceeds on green: nothing restored, no git, the summary line logged", () => {
    const snapshot = snapshotDataFiles(dir);
    write();
    const { run, calls } = recorder();
    const { out, lines } = silent();
    const { proceed, suites } = gateWrittenTree({
      repoRoot: dir,
      force: false,
      branch: "generate/foray-x",
      previousRef: { kind: "branch", name: "main" },
      snapshot,
      run,
      spawn: spawnReplying(0, GREEN_TAP),
      out
    });
    expect(proceed).toBe(true);
    expect(suites.ok).toBe(true);
    expect(read("data/forays.json")).toBe('{"forays":["ORIGINAL","WRITTEN"]}\n');
    expect(calls).toEqual([]);
    expect(lines.error).toEqual([]);
    expect(lines.log).toEqual([expect.stringMatching(/^real-data suites \(G-21c\): GREEN/)]);
  });

  it("a file that did not exist before the write is removed again on restore", () => {
    const snapshot = snapshotDataFiles(dir);
    expect(snapshot.get("data/segment-sources.json")).toBeNull();
    write();
    restoreDataFiles(dir, snapshot);
    expect(fs.existsSync(path.join(dir, "data", "segment-sources.json"))).toBe(false);
    expect(read("data/forays.json")).toBe('{"forays":["ORIGINAL"]}\n');
    expect(read("data/segments.json")).toBe('{"segments":["ORIGINAL"]}\n');
  });
});

describe("abandonPublishBranch / currentRef — back to where the checkout was", () => {
  it("abandon on a detached HEAD switches with --detach to the remembered sha, then deletes the branch", () => {
    const { run, calls } = recorder();
    abandonPublishBranch(run, "generate/foray-x", { kind: "detached", sha: "abc123" });
    expect(calls).toEqual([
      ["git", "switch", "--detach", "abc123"],
      ["git", "branch", "-D", "generate/foray-x"]
    ]);
    const onBranch = recorder({ "git rev-parse --abbrev-ref HEAD": "feature/x" });
    expect(currentRef(onBranch.run)).toEqual({ kind: "branch", name: "feature/x" });
    const detached = recorder({ "git rev-parse --abbrev-ref HEAD": "HEAD", "git rev-parse HEAD": "abc123" });
    expect(currentRef(detached.run)).toEqual({ kind: "detached", sha: "abc123" });
  });
});

describe("the PR body and the report carry the suites' verdict", () => {
  const failure = {
    suite: "player/media-session.test.js",
    name: "every segment of every shipped Foray maps to a non-empty title and artist",
    error: "seg-1 of foray-x has an empty artist",
    location: "player/media-session.test.js:284:1"
  };

  it("the PR body notes a --force override of the suites with suite, test name and assertion; a green run is mentioned as green", () => {
    const red = publishPrBody({ id: "foray-x" }, { ok: true, failures: [] }, { ok: false, failures: [failure], counts: { tests: 1, pass: 0, fail: 1 }, files: ["player/media-session.test.js"] });
    expect(red).toMatch(/\*\*G-21c real-data suites overridden with --force\.\*\*/);
    expect(red).toMatch(/- player\/media-session\.test\.js › every segment of every shipped Foray maps to a non-empty title and artist: seg-1 of foray-x has an empty artist \(player\/media-session\.test\.js:284:1\)/);
    expect(red).not.toMatch(/ran green/);
    const green = publishPrBody({ id: "foray-x" }, { ok: true, failures: [] }, { ok: true, failures: [], counts: { tests: 613, pass: 613, fail: 0 }, files: new Array(11).fill("x") });
    expect(green).toMatch(/G-21c: the app's real-data suites \(11 suites, 613 tests\) ran green/);
    expect(green).not.toMatch(/overridden/);
  });

  it("recordRefusalInReport writes publish_refused with the failing assertions onto the candidate's row, and touches nothing without one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-g21c-report-"));
    try {
      const reportPath = path.join(dir, "report.json");
      fs.writeFileSync(reportPath, JSON.stringify({ entries: [{ prompt: "p", outcome: "generated", detail: "OK", ms: 1, file: "out/foray-x.json" }] }));
      const refusal = { gate: "real-data-suites" as const, summary: "real-data suites (G-21c): RED — 1 suites, 1 tests, 0 passed, 1 failed, 1 failure(s), 0.1s", failures: [failure], refused_at: "2026-09-11T22:00:00.000Z" };
      expect(recordRefusalInReport(reportPath, "C:/elsewhere/foray-x.json", refusal)).toBe(true);
      const doc = JSON.parse(fs.readFileSync(reportPath, "utf8")) as { entries: Array<{ publish?: unknown; publish_refused?: unknown }> };
      expect(doc.entries[0]!.publish_refused).toEqual(refusal);
      expect(doc.entries[0]!.publish).toBeUndefined();
      expect(JSON.stringify(doc)).toContain("seg-1 of foray-x has an empty artist");

      const before = fs.readFileSync(reportPath, "utf8");
      expect(recordRefusalInReport(reportPath, "other.json", refusal)).toBe(false);
      expect(fs.readFileSync(reportPath, "utf8")).toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
