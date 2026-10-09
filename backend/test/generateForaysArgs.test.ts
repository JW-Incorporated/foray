import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, candidateFilename, mergeReportEntries, readPriorReportEntries } from "../src/cli/generateForays";
import { parseArgs as parseSingleArgs } from "../src/cli/generateForay";
import { BudgetGuard } from "../src/cost/budgetGuard";
import { defaultCostEventSink, InMemoryCostEventSink } from "../src/cost/costEvents";
import { DEFAULT_AUTHOR_ID, readAuthorIdFlag } from "../src/types/generation";

/**
 * F-04 / intervention I-01: "Set `DAILY_BUDGET_USD=1000 EPISODE_BUDGET_USD=1000`
 * for this run; recommend a per-run budget flag on the driver." Run 1 had to
 * edit its environment to start at all, and the run log recorded that as a
 * deviation from the shipped workflow rather than as configuration.
 */

describe("generateForays --budget-usd (F-04)", () => {
  it("is absent by default, so the environment's caps stand", () => {
    expect(parseArgs(["--prompts", "p.json"]).budgetUsd).toBeNull();
  });

  it("reads a per-run ceiling", () => {
    expect(parseArgs(["--prompts", "p.json", "--budget-usd", "40"]).budgetUsd).toBe(40);
    expect(parseArgs(["--prompts", "p.json", "--budget-usd", "7.5"]).budgetUsd).toBe(7.5);
  });

  it("ignores a value that is not a positive number", () => {
    /* A malformed flag must not silently become an unmetered run. Falling back
       to the environment's cap is the safe direction. */
    for (const bad of ["abc", "-5", "0", ""]) {
      expect(parseArgs(["--prompts", "p.json", "--budget-usd", bad]).budgetUsd).toBeNull();
    }
    expect(parseArgs(["--prompts", "p.json", "--budget-usd"]).budgetUsd).toBeNull();
  });

  it("parses --no-resume", () => {
    expect(parseArgs(["--prompts", "p.json"]).noResume).toBe(false);
    expect(parseArgs(["--prompts", "p.json", "--no-resume"]).noResume).toBe(true);
  });

  it("leaves every other flag alone", () => {
    const args = parseArgs(["--prompts", "p.json", "--duration", "medium", "--limit", "3", "--dry-run", "--budget-usd", "12"]);
    expect(args).toEqual({
      prompts: "p.json",
      out: args.out,
      duration: "medium",
      limit: 3,
      dryRun: true,
      authorId: "founder-1",
      budgetUsd: 12,
      noResume: false,
      /* G-30's three flags at their defaults — `generateForaysHandsFree.test.ts`
         pins each one's parsing; this pins that none of them leaks a value
         when absent. */
      maxResumes: 3,
      continueOnRefusedPartial: false,
      notify: null
    });
  });
});

describe("BudgetGuard.setCaps — what the flag actually moves", () => {
  it("raises both ceilings and reports them", () => {
    const guard = new BudgetGuard(defaultCostEventSink, 2, 10);
    expect(guard.caps()).toEqual({ runUsd: 2, episodeUsd: 10 });
    guard.setCaps({ runUsd: 40, episodeUsd: 40 });
    expect(guard.caps()).toEqual({ runUsd: 40, episodeUsd: 40 });
  });

  it("ignores a value that would remove the ceiling", () => {
    const guard = new BudgetGuard(defaultCostEventSink, 25, 10);
    guard.setCaps({ runUsd: Number.NaN, episodeUsd: -1 });
    expect(guard.caps()).toEqual({ runUsd: 25, episodeUsd: 10 });
  });

  it("actually stops a call once the cap is lowered under the spend", async () => {
    /* The setter has to change ENFORCEMENT, not just a reported number. */
    const guard = new BudgetGuard(defaultCostEventSink, 1000, 1000);
    guard.setCaps({ runUsd: 0, episodeUsd: 0 });
    await expect(
      guard.checkAndRecord({ userId: "budget-flag-test", operation: "tier1_classify", provider: "stub", estimatedUsd: 0.5 })
    ).rejects.toThrow(/budget exceeded/i);
  });
});

describe("the checkpoint key is the candidate's basename (F-18)", () => {
  it("derives one from the other, so the two files sit side by side", () => {
    const name = candidateFilename("the history of grilling and barbecue");
    expect(name.endsWith(".json")).toBe(true);
    expect(`${name.replace(/\.json$/, "")}.checkpoint.json`).toBe(name.replace(/\.json$/, ".checkpoint.json"));
  });

  it("is stable for the same prompt and different for another", () => {
    expect(candidateFilename("a")).toBe(candidateFilename("a"));
    expect(candidateFilename("a")).not.toBe(candidateFilename("b"));
  });
});

/* Round-3 audit, lane L6 (backend-rest-7): a re-run in the same --out merges
   report.json instead of rewriting it from this run alone. */
describe("report.json is merged across re-runs", () => {
  const row = (prompt: string, extra: Record<string, unknown> = {}) => ({
    prompt,
    outcome: "generated",
    detail: "OK x",
    ms: 1,
    file: `/out/${candidateFilename(prompt)}`,
    ...extra
  });

  it("keeps rows for candidates this run skipped as already built, with their publish records", () => {
    const publish = { pr_url: "https://github.com/o/r/pull/1", branch: "generate/a", base: "origin/main", base_sha: "abc", deploy_id: null, published_at: "t" };
    const prior = [row("alpha", { publish }), row("beta", { publish_refused: { gate: "real-data-suites" } })];
    const merged = mergeReportEntries(prior, [row("gamma")]);
    expect(merged.map((e) => e.prompt)).toEqual(["alpha", "beta", "gamma"]);
    expect(merged[0]!.publish).toEqual(publish);
    expect(merged[1]!.publish_refused).toEqual({ gate: "real-data-suites" });
  });

  /* Round-3 review (L6): a row in this run's report is a candidate built
     afresh (a skipped one produces no row), so the old build's publish or
     refusal does not describe it.
     MUTATION: copy old.publish / old.publish_refused onto the new row again --
     the rebuilt alpha reports the old refusal and the old PR. */
  it("a re-generated prompt replaces its row in place and drops the old build's publish / publish_refused", () => {
    const prior = [row("alpha", { detail: "old", publish: { pr_url: "u" }, publish_refused: { gate: "g" } }), row("beta")];
    const merged = mergeReportEntries(prior, [row("alpha", { detail: "new" })]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ prompt: "alpha", detail: "new" });
    expect(merged[0]!.publish).toBeUndefined();
    expect(merged[0]!.publish_refused).toBeUndefined();
  });

  it("matches by candidate basename too, and reads an existing report.json (an unreadable one is set aside, not lost)", () => {
    const elsewhere = { file: `/elsewhere/${candidateFilename("delta")}`, publish: { pr_url: "p" } } as unknown as Parameters<typeof mergeReportEntries>[0][number];
    const merged = mergeReportEntries([elsewhere], [row("delta")]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.file).toBe(`/out/${candidateFilename("delta")}`);
    expect(merged[0]!.publish).toBeUndefined();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-report-"));
    try {
      const reportPath = path.join(dir, "report.json");
      expect(readPriorReportEntries(reportPath)).toEqual([]);
      fs.writeFileSync(reportPath, JSON.stringify({ entries: [row("alpha")] }));
      expect(readPriorReportEntries(reportPath).map((e) => e.prompt)).toEqual(["alpha"]);
      fs.writeFileSync(reportPath, "{ not json");
      expect(readPriorReportEntries(reportPath)).toEqual([]);
      expect(fs.readdirSync(dir).some((n) => n.startsWith("report.json.unreadable-"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* CH2-25 / B2-14: the two generation CLIs used to default to different author
   ids ("founder" and "founder-1") and spell the flag two ways (`--author-id`
   and `--author`), and `author_id` is the `userId` every cost event
   `BudgetGuard` records is attributed to. Both now read one flag and default to one constant. */
describe("author id flag and default (B2-14)", () => {
  const BATCH = ["--prompts", "p.json"];
  const SINGLE = ["--prompt", "Mercury", "--duration", "short"];
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});
  afterEach(() => vi.restoreAllMocks());

  /* MUTATION: put a literal back in either CLI (`?? "founder"` in
     generateForay.ts, or `?? "founder-1"` with a different value in
     generateForays.ts) -- that CLI's default leaves DEFAULT_AUTHOR_ID. */
  it("both CLIs default to the one shared constant", () => {
    expect(DEFAULT_AUTHOR_ID).toBe("founder-1");
    expect(parseArgs(BATCH).authorId).toBe(DEFAULT_AUTHOR_ID);
    expect(parseSingleArgs(SINGLE).authorId).toBe(DEFAULT_AUTHOR_ID);
  });

  it("both CLIs read --author-id", () => {
    expect(parseArgs([...BATCH, "--author-id", "joey"]).authorId).toBe("joey");
    expect(parseSingleArgs([...SINGLE, "--author-id", "joey"]).authorId).toBe("joey");
  });

  /* MUTATION: drop the `--author` alias from readAuthorIdFlag -- an existing
     `generate-forays --author joey` script silently records as founder-1. */
  it("both CLIs still take --author for one release, with a deprecation line", () => {
    const err = quiet();
    expect(parseArgs([...BATCH, "--author", "joey"]).authorId).toBe("joey");
    expect(parseSingleArgs([...SINGLE, "--author", "joey"]).authorId).toBe("joey");
    expect(err).toHaveBeenCalledTimes(2);
    expect(String(err.mock.calls[0]![0])).toMatch(/--author is deprecated.*--author-id joey/);
  });

  it("--author-id wins over --author, and neither warns when --author-id is given", () => {
    const err = quiet();
    expect(readAuthorIdFlag(["--author", "old", "--author-id", "new"])).toBe("new");
    expect(readAuthorIdFlag(["--author-id"])).toBe(DEFAULT_AUTHOR_ID);
    expect(err).not.toHaveBeenCalled();
  });

  it("with no flag, both CLIs record into BudgetGuard under one userId", async () => {
    const sink = new InMemoryCostEventSink();
    const guard = new BudgetGuard(sink, 1000, 1000);
    for (const userId of [parseArgs(BATCH).authorId, parseSingleArgs(SINGLE).authorId]) {
      await guard.checkAndRecord({ userId, operation: "voice_intent", provider: "stub", estimatedUsd: 0.5 });
    }
    expect(new Set((await sink.all()).map((e) => e.userId))).toEqual(new Set([DEFAULT_AUTHOR_ID]));
    expect(await guard.spentThisRun()).toBe(1);
  });
});
