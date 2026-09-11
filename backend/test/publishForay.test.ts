import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PUBLISH_BASE,
  PUBLISH_DATA_FILES,
  assertDataFilesMatchMain,
  commitPublish,
  cutPublishBranch,
  publishPrBody,
  recordPublishInReport,
  type Runner
} from "../src/cli/publishForay";

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
      {
        synthesisVerifiedPages: 1,
        synthesisVerifiedPageDetails: [{ claim: "Most retellings compress months of decisions into a single moment", mode: "Hinge", restsOn: ["a0/s0/p0", "a0/s1/p0"] }]
      }
    );
    expect(body).toMatch(/1 page\(s\) verified by synthesis of the Foray's own verified pages/);
    expect(body).toMatch(/\[Hinge\] Most retellings compress months of decisions into a single moment — verified by synthesis of pages a0\/s0\/p0, a0\/s1\/p0/);
    expect(publishPrBody({ id: "foray-x" }, { ok: true, failures: [] }, { synthesisVerifiedPages: 0, synthesisVerifiedPageDetails: [] })).not.toMatch(/synthesis/);
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
