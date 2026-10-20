import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CliArgError,
  main,
  modeLines,
  parseArgs,
  candidateFilename,
  mergeReportEntries,
  readPriorReportEntries,
  runStartIntegrity,
  withStageProviders
} from "../src/cli/generateForays";
import { SYNC_STATE_RELATIVE_PATH, integrityGate, type IntegrityVerdict } from "../src/generation/archiveIntegrity";
import type { RemoteRetrieval } from "../src/generation/retrievalClient";
import { TRANSCRIPT_TEXT_INDEX_VERSION } from "../src/generation/transcriptTextIndex";
import { parseArgs as parseSingleArgs, understandRouteLine } from "../src/cli/generateForay";
import { resolveRouting } from "../src/config/stageRouting";
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
      /* GV-101: the guard's escape hatch, off unless given. */
      allowShortArchive: false,
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

/* GV-55 (R2-21, HW-12): `--stage-provider stage=provider[:lane][,...]` routes
   stages for one run exactly as FORAY_STAGE_<STAGE> would, and the run states
   its routing. Every routing table is resolved from an injected source;
   nothing here reaches a model or the network. */
describe("generateForays --stage-provider (GV-55)", () => {
  const LLM = "http://user:secret@litellm.test:4000/v1";
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  /* MUTATION: read only the first entry of a comma list (`value.split(",")`
     -> `[value.split(",")[0]]`). Ran it: red (deepen is never routed). */
  it("parses spine=local:second,deepen=local:spark, repeats merge, and adds nothing without it", () => {
    const args = parseArgs(["--prompts", "p.json", "--stage-provider", "spine=local:second,deepen=local:spark"]);
    expect(args.stageProviders).toEqual({ spine: "local:second", deepen: "local:spark" });
    expect(parseArgs(["--prompts", "p.json", "--stage-provider", "spine=local:second", "--stage-provider", "research=none"]).stageProviders).toEqual({
      spine: "local:second",
      research: "none"
    });
    expect("stageProviders" in parseArgs(["--prompts", "p.json"])).toBe(false);
  });

  /* MUTATION: `out[stage] = spec` -> `out[stage.toUpperCase()]` in
     withStageProviders' loop (the variable is never set). Ran it: red. */
  it("is applied as FORAY_STAGE_* overrides before resolveRouting, winning over the same variable already set", () => {
    const { stageProviders } = parseArgs(["--prompts", "p.json", "--stage-provider", "spine=local:second,deepen=local:spark"]);
    const env = { FORAY_LLM_BASE_URL: LLM, FORAY_STAGE_SPINE: "local:spark" };
    const source = withStageProviders(env, stageProviders);
    expect(source.FORAY_STAGE_SPINE).toBe("local:second");
    expect(source.FORAY_STAGE_DEEPEN).toBe("local:spark");
    expect(env.FORAY_STAGE_SPINE).toBe("local:spark");
    const routing = resolveRouting(source);
    expect(routing.routes.spine).toMatchObject({ provider: "local", lane: "second" });
    expect(routing.routes.deepen).toMatchObject({ provider: "local", lane: "spark" });
    expect(routing.overridden).toEqual(["spine", "deepen"]);
  });

  /* MUTATION: drop the per-entry resolveRouting check in parseStageProviders
     (a provider the stage does not accept, or an unknown lane, then passes
     the parse). Ran it: red. */
  it("refuses a malformed entry, naming it", () => {
    const bad = ["spine", "=local", "nostage=local", "spine=bogus", "spine=local:moon", "judge=anthropic", "research=local", "spine=local:spark:x"];
    for (const entry of bad) {
      let thrown: unknown;
      try {
        parseArgs(["--prompts", "p.json", "--stage-provider", entry]);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, entry).toBeInstanceOf(CliArgError);
      expect((thrown as Error).message, entry).toContain(`"${entry}"`);
      expect((thrown as Error).message).toContain("--stage-provider");
    }
    expect(() => parseArgs(["--prompts", "p.json", "--stage-provider", "spine=local,spine=stub"])).toThrow(/"spine=stub" routes a stage a second time/);
    expect(() => parseArgs(["--prompts", "p.json", "--stage-provider"])).toThrow(CliArgError);
    expect(() => parseArgs(["--stage-provider", "--prompts", "p.json"])).toThrow(/needs a value/);
  });

  /* MUTATION: drop the CliArgError catch in main (the refusal then rejects
     main's promise instead of exiting 1 with the message). Ran it: red. */
  it("a malformed value exits non-zero naming it, before anything runs", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await main(["--prompts", "does-not-exist.json", "--stage-provider", "spine=bogus"]);
    expect(process.exitCode).toBe(1);
    expect(String(err.mock.calls[0]![0])).toMatch(/--stage-provider: "spine=bogus"/);
    expect(log).not.toHaveBeenCalled();
    expect(process.env.FORAY_STAGE_SPINE).toBeUndefined();
  });

  /* MUTATION: always print the mixed/live line (a stub run then claims to be
     live). Ran it: red. MUTATION: drop the stub-mode clause of `inert` (a stub
     run with a Jev key, whose judge defaults to jev, then claims to be
     mixed/live). Ran it: red. */
  it("MODE keeps today's lines for stub and legacy, says mixed/live and prints STAGES when routed, never a credential", () => {
    const caps = { runUsd: 50, episodeUsd: 5 };
    const models = { opus: "o-1", sonnet: "s-1", haiku: "h-1" };
    expect(modeLines(resolveRouting({}), caps, models)).toEqual([
      "MODE: dry-run (no ANTHROPIC_API_KEY) — stub builders, $0, output is structurally real but editorially empty."
    ]);
    expect(modeLines(resolveRouting({ JEV_API_KEY: "jev-synthetic" }), caps, models)).toEqual([
      "MODE: dry-run (no ANTHROPIC_API_KEY) — stub builders, $0, output is structurally real but editorially empty."
    ]);
    /* GV-68: the legacy builders need both opt-ins; a key alone is a dry
       run whose MODE line says the key was ignored. MUTATION: drop the
       anthropicKeyIgnored branch of modeLines. Ran it: red. */
    const ignored = modeLines(resolveRouting({ ANTHROPIC_API_KEY: "sk-ant-synthetic" }), caps, models);
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toMatch(/^MODE: dry-run — stub builders, \$0/);
    expect(ignored[0]).toContain("ANTHROPIC_API_KEY is set and IGNORED");
    expect(ignored[0]).toContain("FORAY_ALLOW_ANTHROPIC_LEGACY=1");
    expect(ignored[0]).not.toContain("sk-ant-synthetic");
    const ignoredLocal = modeLines(resolveRouting({ ANTHROPIC_API_KEY: "sk-ant-synthetic", FORAY_LLM_BASE_URL: LLM }), caps, models);
    expect(ignoredLocal[0]).toMatch(/^MODE: mixed\/live — generation mode local .*ANTHROPIC_API_KEY is set and IGNORED/);
    const legacy = modeLines(
      resolveRouting({ ANTHROPIC_API_KEY: "sk-ant-synthetic", FORAY_GENERATION_MODE: "anthropic-legacy", FORAY_ALLOW_ANTHROPIC_LEGACY: "1" }),
      caps,
      models
    );
    expect(legacy[0]).toBe("MODE: live — Anthropic builders, metered by BudgetGuard (run $50 for this process, per-Foray $5).");
    expect(legacy[1]).toBe("MODELS: opus=o-1 sonnet=s-1 haiku=h-1");
    const local = modeLines(resolveRouting({ FORAY_LLM_BASE_URL: LLM, FORAY_STAGE_SPINE: "local:second" }), caps, models);
    expect(local[0]).toMatch(/^MODE: mixed\/live — generation mode local \(from FORAY_LLM_BASE_URL\)/);
    expect(local.some((l) => l.startsWith("MODELS:"))).toBe(false);
    const stages = local.find((l) => l.startsWith("STAGES: "))!;
    expect(stages).toContain("spine=local:second");
    expect(stages).toContain("research=none");
    expect(stages).toContain("overridden: spine");
    expect(stages).not.toContain("secret");
  });

  /* MUTATION: print the intent route under `clarity=`. Ran it: red. */
  it("generate-foray prints its understand route", () => {
    expect(understandRouteLine(resolveRouting({}))).toBe("UNDERSTAND: mode stub; clarity=stub, intent=stub, title=stub");
    const line = understandRouteLine(resolveRouting({ FORAY_LLM_BASE_URL: LLM, FORAY_STAGE_UNDERSTAND_CLARITY: "jev" }));
    expect(line).toMatch(/^UNDERSTAND: mode local; clarity=jev, intent=local:spark \S+, title=local:spark \S+$/);
    expect(line).not.toContain("secret");
  });
});

describe("GV-101 run-start corpus integrity guard: --allow-short-archive", () => {
  /* MUTATION: parse --allow-short-archive as always true. Ran it: red. */
  it("--allow-short-archive parses and defaults to false", () => {
    expect(parseArgs(["--prompts", "p.json"]).allowShortArchive).toBe(false);
    expect(parseArgs(["--prompts", "p.json", "--allow-short-archive"]).allowShortArchive).toBe(true);
  });

  /* MUTATION: always take the local branch in runStartIntegrity (a remote run
     would then check this machine's empty disk and never the server's
     manifest). Ran it: red. MUTATION: rethrow SyncStateError instead of
     returning the unreadable-state verdict. Ran it: red. */
  it("checks the server's manifest when remote, the sync state when local, and an unreadable state is a verdict", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gv101-args-"));
    try {
      /* No state on disk: local and ok, expected null. */
      expect(runStartIntegrity(null, [], root)).toEqual({ kind: "local", ok: true, expected: null, found: 0, missingShows: [], shortShows: [] });
      const stateFile = path.join(root, SYNC_STATE_RELATIVE_PATH);
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ bodies_expected: 4, shows: { "show-0123456789": { show_id: "show", bodies: 4 } } }));
      const local = runStartIntegrity(null, [{ dirName: "show-0123456789", showId: "show", episodes: 3 }], root);
      expect(local).toMatchObject({ kind: "local", ok: false, expected: 4, found: 3, shortShows: [{ show: "show-0123456789", expected: 4, found: 3 }] });
      fs.writeFileSync(stateFile, "{");
      expect(runStartIntegrity(null, [], root)).toMatchObject({ kind: "unreadable-state", ok: false });

      /* Remote: the same unreadable local state is not consulted; the
         manifest the client loaded is. */
      const manifest = [{ dirName: "show", showId: "show", episodes: 2 }];
      const remote = {
        retrieval: { manifestShows: () => manifest } as unknown as RemoteRetrieval,
        health: { indexVersion: TRANSCRIPT_TEXT_INDEX_VERSION, shows: 1, episodes: 2, archiveGeneratedAt: "2026-10-01" },
        pulledArchiveGeneratedAt: "2026-10-01"
      };
      expect(runStartIntegrity(remote, [], root)).toEqual({ kind: "remote", ok: true, expected: 2, found: 2, reasons: [] });
      expect(runStartIntegrity({ ...remote, pulledArchiveGeneratedAt: "2026-09-01" }, [], root).ok).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  /* MUTATION: ignore allowShortArchive in integrityGate (refuse always). Ran
     it: red. MUTATION: refuse on an ok local verdict. Ran it: red. */
  it("a failed check refuses (exit 2) unless --allow-short-archive, which prints the same shortfall and goes on", () => {
    const short: IntegrityVerdict = { kind: "local", ok: false, expected: 7, found: 4, missingShows: ["gone-0000000000"], shortShows: [{ show: "b-1111111111", expected: 4, found: 1 }] };
    const refused = integrityGate(short, false);
    expect(refused.refuse).toBe(true);
    expect(refused.lines[0]).toMatch(/^ARCHIVE SHORT: 4 of 7 synced bodies on disk/);
    expect(refused.lines).toContain("  missing shows: gone-0000000000");
    expect(refused.lines).toContain("  short show: b-1111111111 (1 of 4)");
    expect(refused.lines.at(-1)).toMatch(/exit 2.*--allow-short-archive/);
    const bypassed = integrityGate(short, true);
    expect(bypassed.refuse).toBe(false);
    expect(bypassed.lines.slice(0, -1)).toEqual(refused.lines.slice(0, -1));
    expect(bypassed.lines.at(-1)).toMatch(/--allow-short-archive: sourcing against this corpus anyway/);
    expect(integrityGate({ kind: "remote", ok: false, expected: 3, found: 2, reasons: ["x"] }, false).refuse).toBe(true);
    expect(integrityGate({ kind: "unreadable-state", ok: false, message: "m" }, false).refuse).toBe(true);
    /* No state: nothing printed, nothing refused. */
    expect(integrityGate({ kind: "local", ok: true, expected: null, found: 0, missingShows: [], shortShows: [] }, false)).toEqual({ refuse: false, lines: [] });
    expect(integrityGate({ kind: "local", ok: true, expected: 5, found: 5, missingShows: [], shortShows: [] }, false)).toEqual({
      refuse: false,
      lines: ["archive integrity: 5 of 5 synced bodies on disk"]
    });
  });
});
