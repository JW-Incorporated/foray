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
  parseArgs,
  printSuiteVerdict,
  publishPrBody,
  recordPublishInReport,
  recordRefusalInReport,
  restoreDataFiles,
  snapshotDataFiles,
  supersedeLines,
  writePublishDataFiles,
  type Out,
  type Runner
} from "../src/cli/publishForay";
import type { SuiteSpawn } from "../src/cli/publishSuites";
import { mintedSegmentRow } from "../src/generation/finalizeForay";
import type { NewSegment } from "../src/types/tapeSourcing";

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

/**
 * F-98 (B) AT THE WRITE: a draft pool row superseded by a longer cut is
 * rewritten IN PLACE, the drafts timed on it are restated, and `--supersedes`
 * removes the prior draft of the same prompt with the rows only it played.
 *
 * Run 9 reused four of run 8's pre-Q-01 cuts at their old lengths because
 * F-84's id rule leaves no second id to mint under. Sourcing now decides when a
 * row is ours to re-cut (`poolRowIsSupersedable`); this is the other half — the
 * write that makes the decision true on disk without breaking the Forays that
 * were timed on the old cut.
 *
 * MUTATIONS, each named in the test that kills it:
 *   - append the superseding row instead of replacing it → "in place"
 *   - skip the runtime restatement                        → "restates"
 *   - restate a curated or published Foray's runtime      → "only drafts"
 *   - remove a Foray `--supersedes` names that is not a generated draft → "refuses"
 *   - drop rows a surviving Foray still plays             → "only the orphans"
 *   - drop the paragraphs from the PR body                → "PR body"
 */
describe("F-98 at publish — a superseded row, the drafts timed on it, and --supersedes", () => {
  let dir = "";
  const POOL_ID = "being-an-engineer--ep-3#200";
  const OTHER_ID = "being-an-engineer--ep-9#900";

  const poolRow = (id: string, endSec: number) => ({
    id,
    item_id: id.split("#")[0],
    topic: "business/careers",
    start_sec: 200,
    end_sec: endSec,
    reference_duration_sec: 3600,
    start_anchor: "the recall cost us four million",
    end_anchor: "and i signed the drawing that released it",
    why: "A recall cost four million dollars after a bracket failed fatigue testing.",
    confidence: "medium",
    transcript_source: "publisher",
    dai_suspected: false,
    source: "generation-tier-2",
    batch_id: "generation-prior-draft",
    needs_review: true
  });

  const forayRow = (id: string, segmentIds: string[], extra: Record<string, unknown> = {}) => ({
    id,
    kind: "foray",
    title: id,
    topic: "business/careers",
    status: "draft",
    summary: "s",
    runtime_sec: 100,
    generated: true,
    slots: [],
    items: segmentIds.map((sid) => ({ type: "segment", slot: "s", segment_id: sid })),
    ...extra
  });

  const minted = (id: string, endSec: number, supersedesEndSec?: number): NewSegment => ({
    id,
    itemId: id.split("#")[0]!,
    startSec: 200,
    endSec,
    referenceDurationSec: 3600,
    startAnchor: "the recall cost us four million",
    endAnchor: "and i signed the drawing that released it",
    confidence: "medium",
    why: "A recall cost four million dollars after a bracket failed fatigue testing.",
    transcriptSource: "publisher",
    ...(supersedesEndSec !== undefined ? { supersedesEndSec } : {})
  });

  function writeFiles(forays: unknown[], segments: unknown[]): void {
    fs.writeFileSync(path.join(dir, "data", "forays.json"), `${JSON.stringify({ forays }, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, "data", "segments.json"), `${JSON.stringify({ segments }, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, "data", "segment-sources.json"), `${JSON.stringify({ sources: [] }, null, 2)}\n`);
  }
  const readForays = () => JSON.parse(fs.readFileSync(path.join(dir, "data", "forays.json"), "utf8")).forays as Array<Record<string, unknown>>;
  const readSegments = () => JSON.parse(fs.readFileSync(path.join(dir, "data", "segments.json"), "utf8")).segments as Array<Record<string, unknown>>;

  /** The plan a publish builds: the minted rows in `data/segments.json`'s own
   * field names, exactly as `main` builds them. */
  function planFor(segments: NewSegment[], opts: { supersedes?: string | null } = {}) {
    const rowContext = { batchId: "generation-new-draft", sources: [{ id: "being-an-engineer--ep-3", dai_suspected: false }, { id: "being-an-engineer--ep-9", dai_suspected: false }] };
    return {
      forayRecord: forayRow("new-draft", segments.map((s) => s.id)),
      mintedSegments: segments,
      mintedRows: segments.map((s) => ({ id: s.id, row: mintedSegmentRow(s, "business/careers", rowContext) as unknown as { id: string } })),
      mintedSources: [],
      supersedesForayId: opts.supersedes ?? null
    };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-f98-"));
    fs.mkdirSync(path.join(dir, "data"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("in place: the superseded row keeps its id and position, gains the longer end and `superseded_from`", () => {
    /* MUTATION THAT KILLS THIS: append the superseding row instead of replacing
       it — the pool then holds two rows under one id and `merge-segments.mjs
       --check` refuses the PR, which is the F-84 failure this card must not
       reintroduce. */
    writeFiles([forayRow("prior-draft", [POOL_ID])], [poolRow(POOL_ID, 232), poolRow(OTHER_ID, 999)]);
    const result = writePublishDataFiles(dir, planFor([minted(POOL_ID, 381, 232)]), () => {});

    const rows = readSegments();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: POOL_ID, start_sec: 200, end_sec: 381, superseded_from: 232, batch_id: "generation-new-draft", needs_review: true });
    expect(rows[1]!.id).toBe(OTHER_ID);
    expect(result.superseded).toEqual([{ id: POOL_ID, fromEndSec: 232, toEndSec: 381 }]);
    expect(result.files).toEqual(["data/forays.json", "data/segments.json"]);
  });

  it("restates the runtime of every draft that plays the row, by the seconds the cut gained", () => {
    /* The checker's 0.5 s drift rule: a Foray whose clip got 149 s longer and
       whose `runtime_sec` did not move fails, and it fails in the same commit
       that lengthened it. MUTATION THAT KILLS THIS: skip the restatement. */
    writeFiles(
      [forayRow("prior-draft", [POOL_ID, POOL_ID]), forayRow("unrelated-draft", [OTHER_ID])],
      [poolRow(POOL_ID, 232), poolRow(OTHER_ID, 999)]
    );
    const result = writePublishDataFiles(dir, planFor([minted(POOL_ID, 381, 232)]), () => {});

    const forays = readForays();
    // Two references to the same row: the runtime moves by twice the gain.
    expect(forays.find((f) => f.id === "prior-draft")!.runtime_sec).toBeCloseTo(100 + 2 * 149, 6);
    expect(forays.find((f) => f.id === "unrelated-draft")!.runtime_sec).toBe(100);
    expect(result.restated).toEqual([{ forayId: "prior-draft", fromSec: 100, toSec: 398, segmentIds: [POOL_ID] }]);
    expect(forays[forays.length - 1]!.id).toBe("new-draft");
  });

  it("only drafts are restated: a curated or published Foray's runtime is never touched", () => {
    /* The rule `poolRowIsSupersedable` keeps at sourcing, kept again here so the
       two seams cannot disagree. MUTATION THAT KILLS THIS: restate every Foray
       that plays the row. */
    writeFiles(
      [forayRow("published-1", [POOL_ID], { status: "published" }), forayRow("curated-1", [POOL_ID], { generated: false })],
      [poolRow(POOL_ID, 232)]
    );
    const result = writePublishDataFiles(dir, planFor([minted(POOL_ID, 381, 232)]), () => {});
    expect(result.restated).toEqual([]);
    for (const f of readForays().filter((f) => f.id !== "new-draft")) expect(f.runtime_sec).toBe(100);
  });

  it("--supersedes removes the prior draft and only the orphans it leaves behind", () => {
    /* A regenerated draft is a second attempt at one Foray, not a second Foray.
       MUTATION THAT KILLS THIS: drop rows a surviving Foray still plays — the
       `unrelated-draft` below then references a segment id nothing can resolve,
       which is exactly the "unknown segment_id" failure the publish exists to
       prevent. */
    writeFiles(
      [forayRow("prior-draft", [POOL_ID, OTHER_ID]), forayRow("unrelated-draft", [OTHER_ID])],
      [poolRow(POOL_ID, 232), poolRow(OTHER_ID, 999)]
    );
    const result = writePublishDataFiles(dir, planFor([], { supersedes: "prior-draft" }), () => {});

    expect(readForays().map((f) => f.id)).toEqual(["unrelated-draft", "new-draft"]);
    expect(result.removed).toEqual({ forayId: "prior-draft", segmentIds: [POOL_ID] });
    expect(readSegments().map((r) => r.id)).toEqual([OTHER_ID]);
  });

  it("refuses a --supersedes that names no Foray, or one that is not a generated draft", () => {
    /* Silently declining would leave the list growing and nobody would know.
       MUTATION THAT KILLS THIS: filter by id and move on. */
    writeFiles([forayRow("published-1", [POOL_ID], { status: "published" })], [poolRow(POOL_ID, 232)]);
    expect(() => writePublishDataFiles(dir, planFor([], { supersedes: "no-such-foray" }), () => {})).toThrow(/names no Foray/);
    expect(() => writePublishDataFiles(dir, planFor([], { supersedes: "published-1" }), () => {})).toThrow(/not a generated draft/);
    // Nothing was written by either refusal: the Foray list is untouched.
    expect(readForays().map((f) => f.id)).toEqual(["published-1"]);
  });

  it("PR body: the re-cut row, the restated runtimes and the removed draft are all named for the founder", () => {
    /* Every one of the three touches something already on main. MUTATION THAT
       KILLS THIS: drop `supersedeLines` from the body — the PR then reads as
       "+1 Foray" while it rewrites a pool row and another Foray's runtime. */
    const body = publishPrBody({ id: "new-draft" }, { ok: true, failures: [] }, null, undefined, {
      superseded: [{ id: POOL_ID, fromEndSec: 232, toEndSec: 381 }],
      restated: [{ forayId: "prior-draft", fromSec: 100, toSec: 249, segmentIds: [POOL_ID] }],
      removed: { forayId: "older-draft", segmentIds: [OTHER_ID] }
    });
    expect(body).toContain("superseded by a longer cut at the same start (F-98)");
    expect(body).toContain(`\`${POOL_ID}\`: 232 s → 381 s`);
    expect(body).toContain("restates");
    expect(body).toContain("prior-draft`: 100.000 s → 249.000 s");
    expect(body).toContain("the prior draft `older-draft` is removed by this PR");
    expect(body).toContain(OTHER_ID);
    /* And a publish that only adds reads exactly as it did before F-98. */
    expect(supersedeLines(undefined)).toBe("");
    expect(supersedeLines({ superseded: [], restated: [], removed: null })).toBe("");
  });
});

/**
 * AUDIT FINDING A (2026-09-12): `--force --no-hold` put unreviewed narration on
 * every phone with no human.
 *
 * `--force` overrides the WS-B veracity gate. `meta.veracity` is never written
 * into `data/` (`finalizeForay.ts`), no CI check reads it, `path-policy.mjs`
 * allow-lists `data/`, and `automerge-nightly.yml` merges a green `data/`-only
 * PR unless it carries `hold`/`founder-decision`. The `hold` label was the only
 * thing standing between a forced publish and the directory, and `--no-hold`
 * removed it.
 *
 * MUTATIONS, one per test:
 *   - put `hold: !argv.includes("--no-hold")` back in `parseArgs` (drop the
 *     `force ? true :`) → "`--force` implies hold" is red;
 *   - drop `holdForcedByForce` → "the refusal is reported, not silent" is red;
 *   - make `--force` imply hold for a plain `--no-hold` run too → "`--no-hold`
 *     alone still works" is red.
 */
describe("parseArgs — `--force` implies `hold` (audit finding A)", () => {
  it("`--force` implies hold, and `--no-hold` alongside it is refused", () => {
    const forced = parseArgs(["--input", "c.json", "--force", "--no-hold"]);
    expect(forced.force).toBe(true);
    expect(forced.hold).toBe(true);
    expect(parseArgs(["--input", "c.json", "--force"]).hold).toBe(true);
  });

  it("the refusal is reported, not silent — `holdForcedByForce` marks the run whose flag was declined", () => {
    expect(parseArgs(["--input", "c.json", "--force", "--no-hold"]).holdForcedByForce).toBe(true);
    /* Not set when there was nothing to decline. */
    expect(parseArgs(["--input", "c.json", "--force"]).holdForcedByForce).toBe(false);
    expect(parseArgs(["--input", "c.json", "--no-hold"]).holdForcedByForce).toBe(false);
  });

  it("`--no-hold` alone still works, and a plain publish still holds", () => {
    expect(parseArgs(["--input", "c.json", "--no-hold"]).hold).toBe(false);
    expect(parseArgs(["--input", "c.json"]).hold).toBe(true);
    expect(parseArgs(["--input", "c.json"]).force).toBe(false);
  });
});

/**
 * AUDIT FINDINGS B AND D (2026-09-12): what the operator and the PR body are
 * told.
 *
 * MUTATIONS, one per test:
 *   - drop the `knownUncoveredGuidance` loop from `printSuiteVerdict` → "the
 *     verdict tells the operator to delete the KNOWN_UNCOVERED entry" is red;
 *   - put "passed check-forays.mjs and check-narration.mjs" back in
 *     `publishPrBody` → "the PR body does not claim a narration check that
 *     structurally did not run" is red.
 */
describe("the verdict and the PR body say what was actually checked", () => {
  it("the verdict tells the operator to DELETE the KNOWN_UNCOVERED entry rather than re-cut the Foray", () => {
    const lines: { error: string[]; log: string[]; warn: string[] } = { error: [], log: [], warn: [] };
    const out: Out = {
      log: (l) => lines.log.push(l),
      warn: (l) => lines.warn.push(l),
      error: (l) => lines.error.push(l)
    };
    const proceed = printSuiteVerdict(
      {
        ok: false,
        failures: [
          {
            suite: "tools/foray/fixture-coverage.test.mjs",
            name: 'KNOWN_UNCOVERED: narration.mode = "intro" still has no committed carrier',
            error: 'narration.mode = "intro" is now carried by engineers-1',
            location: "tools/foray/fixture-coverage.test.mjs:190:3"
          }
        ],
        durationMs: 10,
        counts: { tests: 1, pass: 0, fail: 1 },
        exitCode: 1,
        files: ["tools/foray/fixture-coverage.test.mjs"]
      },
      false,
      out
    );
    expect(proceed).toBe(false);
    const said = lines.error.join("\n");
    expect(said).toMatch(/DELETE the KNOWN_UNCOVERED entry for narration\.mode = "intro"/);
    expect(said).toMatch(/IN THIS PR/);
    expect(said).toMatch(/do not --force past this/);
  });

  it("the PR body does not claim a narration check that structurally did not run (finding D)", () => {
    const body = publishPrBody({ id: "foray-x" }, { ok: true, failures: [] });
    /* `check-narration.mjs` validates docs/curation/narration/<id>/, which the
       §4 pipeline never writes — see finalizeForay.ts's header. The old line
       said the Foray "passed check-forays.mjs and check-narration.mjs". */
    expect(body).not.toMatch(/passed check-forays\.mjs and\s+check-narration\.mjs/);
    expect(body).toMatch(/passed check-forays\.mjs/);
    expect(body).toMatch(/it is not a check of this Foray's narration/);
  });
});
