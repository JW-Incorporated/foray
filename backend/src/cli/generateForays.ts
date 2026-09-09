#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { runForayPipeline, type RunPipelineOutcome } from "../generation/runPipeline";
import { FileTranscriptCueProvider } from "../generation/transcriptArchiveLookup";
import { checkpointFingerprint } from "../generation/checkpoint";
import { FileCheckpointStore } from "./checkpointStore";
import type { GenerationRequest } from "../types/generation";
import { env } from "../config/env";
import { modelSummary } from "../config/models";
import { BudgetStopError, defaultBudgetGuard } from "../cost/budgetGuard";

/**
 * The batch driver: N prompts in, N candidate Forays out.
 *
 * WHY A BATCH CLI AND NOT JUST THE SINGLE-RUN ONE. `generateForay.ts` (§4.0-4.1)
 * and `publishForay.ts` (§4.9) meet at opposite ends of the pipeline with a
 * founder in between; `runForayPipeline` closed that gap for ONE Foray. Making
 * a lot of them needs three more things that belong in a driver rather than in
 * the pipeline: a queue it can resume, a budget it stops at, and a per-prompt
 * outcome record so a failure is one line in a report instead of the end of the
 * run.
 *
 * IT WRITES CANDIDATES, IT DOES NOT PUBLISH. Every run produces one JSON file
 * per Foray in the output directory, in exactly `publishForay.ts`'s input shape,
 * plus a `report.json`. Publishing stays a separate, per-Foray, founder-reviewed
 * step — `docs/curation/generation-architecture.md` §1.3's phase 1 rule, and the
 * reason `publishForay.ts` applies a `hold` label. A batch driver that also
 * merged its own output would turn a review gate into a rubber stamp.
 *
 * RESUMABLE BY CONSTRUCTION, AT TWO GRAINS.
 *
 *   BETWEEN Forays: a prompt whose candidate file already exists is skipped,
 *   so re-running after a crash, a budget stop, or a rate limit costs nothing
 *   for the work already done. That is also why `runForayPipeline` is
 *   deterministic given a fixed clock: the skip is keyed on the prompt, and a
 *   retry must not mint a second id for the same work.
 *
 *   WITHIN one Foray (F-17/F-18, added after generation run 2026-09-09): every
 *   stage's output is written to `<out>/<candidate-basename>.checkpoint.json`
 *   as soon as it exists, and a re-run resumes at the first stage that never
 *   finished. The between-Forays skip alone was not enough, and the run said
 *   so in numbers: attempt 4 ran 2 h 35 m, finished 22 of 31 beats, failed on
 *   beat 23, wrote no candidate — and so a re-run started again at the clarity
 *   check. The checkpoint is deleted the moment the candidate is written; the
 *   candidate is the resume record from then on.
 *
 * Usage:
 *   npm run generate-forays -- --prompts prompts.json [--out data-local/foray-candidates]
 *                              [--duration short|medium|long] [--limit N]
 *                              [--budget-usd N] [--no-resume] [--dry-run]
 *
 * `prompts.json` is either a JSON array of strings, or of
 * `{ prompt, duration?, topic? }` objects when a prompt needs its taxonomy node
 * pinned by hand rather than resolved.
 */

interface PromptSpec {
  prompt: string;
  duration?: "short" | "medium" | "long";
  topic?: string;
}

interface CliArgs {
  prompts: string | null;
  out: string;
  duration: "short" | "medium" | "long";
  limit: number | null;
  dryRun: boolean;
  authorId: string;
  /**
   * Per-run spend ceiling in USD (F-04 / I-01). Null means "use the
   * environment's caps", which is the normal case. Given a number, it becomes
   * BOTH the per-Foray and the daily ceiling for this process — the two must
   * move together, because generation calls are not tier-prefixed and so are
   * scored tier 1, whose cutoff is the whole daily budget: raising only the
   * per-Foray cap would just move the stop to the daily one.
   */
  budgetUsd: number | null;
  /** Ignore any checkpoint on disk and rebuild every stage (F-17/F-18). */
  noResume: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const d = get("--duration");
  const limitRaw = get("--limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
  const budgetRaw = get("--budget-usd");
  const budget = budgetRaw === undefined ? NaN : Number(budgetRaw);
  return {
    prompts: get("--prompts") ?? null,
    out: get("--out") ?? path.join("data-local", "foray-candidates"),
    duration: d === "short" || d === "medium" || d === "long" ? d : "short",
    limit: Number.isFinite(limit) && limit > 0 ? limit : null,
    dryRun: argv.includes("--dry-run"),
    authorId: get("--author") ?? "founder-1",
    budgetUsd: Number.isFinite(budget) && budget > 0 ? budget : null,
    noResume: argv.includes("--no-resume")
  };
}

/** Accepts both file shapes; a bare string is the common case. */
export function normalizePrompts(raw: unknown): PromptSpec[] {
  if (!Array.isArray(raw)) {
    throw new Error("prompts file must contain a JSON array of strings or {prompt,...} objects");
  }
  return raw.map((entry, i) => {
    if (typeof entry === "string") return { prompt: entry };
    if (entry && typeof entry === "object" && typeof (entry as PromptSpec).prompt === "string") {
      return entry as PromptSpec;
    }
    throw new Error(`prompts[${i}] is neither a string nor an object with a "prompt" string`);
  });
}

/** Filesystem-safe, stable per prompt — this is the resume key. */
export function candidateFilename(prompt: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- node builtin, sync by design
  const { createHash } = require("crypto") as typeof import("crypto");
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  const hash = createHash("sha1").update(prompt).digest("hex").slice(0, 8);
  return `${slug || "prompt"}-${hash}.json`;
}

/** One line per prompt, so a 200-prompt run reads as a table and not a log. */
export function summarize(outcome: RunPipelineOutcome): string {
  switch (outcome.outcome) {
    case "rejected":
      return `REJECTED (${outcome.category}) — ${outcome.explanation}`;
    case "needs-clarification":
      return `AMBIGUOUS — ${outcome.question}`;
    case "unresolved-topic":
      return `NO TOPIC — nearest: ${outcome.candidates.slice(0, 3).map((c) => c.id).join(", ") || "(none)"}`;
    case "generated":
      return outcome.result.validation.ok
        ? `OK ${outcome.input.id} (${outcome.input.items.length} items, ${outcome.input.runtimeSec}s)`
        : `INVALID ${outcome.input.id} — ${outcome.result.validation.checkForaysErrors.slice(0, 2).join("; ")}`;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.prompts) {
    console.error(
      "Usage: npm run generate-forays -- --prompts prompts.json [--out DIR] " +
        "[--duration short|medium|long] [--limit N] [--budget-usd N] [--no-resume] [--dry-run]"
    );
    process.exitCode = 1;
    return;
  }

  /* F-04. Run 1 could only be started by setting DAILY_BUDGET_USD=1000 in the
     environment, and the run log had to record that as an intervention (I-01)
     because there was no way to say "this run may spend N" on the command
     line. Both caps move together: generation calls are not tier-prefixed, so
     BudgetGuard scores them tier 1, whose cutoff is the whole daily budget —
     raising only the per-Foray ceiling would just move the stop. */
  if (args.budgetUsd !== null) {
    defaultBudgetGuard.setCaps({ dailyUsd: args.budgetUsd, episodeUsd: args.budgetUsd });
  }

  const specs = normalizePrompts(JSON.parse(fs.readFileSync(path.resolve(args.prompts), "utf8")));
  const queue = args.limit ? specs.slice(0, args.limit) : specs;

  /* State the mode before doing anything expensive. A run that silently used
     stubs and produced 200 placeholder Forays would look exactly like a
     successful run until someone listened to one. */
  const caps = defaultBudgetGuard.caps();
  console.log(
    env.anthropicDryRun
      ? `MODE: dry-run (no ANTHROPIC_API_KEY) — stub builders, $0, output is structurally real but editorially empty.`
      : `MODE: live — Anthropic builders, metered by BudgetGuard (daily $${caps.dailyUsd}, per-Foray $${caps.episodeUsd}).`
  );
  /* Which models a run ACTUALLY used, printed rather than assumed: F-03 was
     found by reading source, which is not where a run's behaviour should have
     to be looked up. */
  if (!env.anthropicDryRun) {
    const models = modelSummary();
    console.log(`MODELS: opus=${models.opus} sonnet=${models.sonnet} haiku=${models.haiku}`);
  }
  console.log(`${queue.length} prompt(s); writing candidates to ${args.out}`);

  fs.mkdirSync(path.resolve(args.out), { recursive: true });

  const report: Array<{ prompt: string; outcome: string; detail: string; ms: number; file?: string }> = [];
  let generated = 0;
  let skipped = 0;
  const cueProvider = new FileTranscriptCueProvider();

  for (const spec of queue) {
    const basename = candidateFilename(spec.prompt);
    const file = path.join(path.resolve(args.out), basename);
    if (fs.existsSync(file)) {
      skipped++;
      console.log(`  skip   ${spec.prompt.slice(0, 60)} (already built)`);
      continue;
    }

    const request: GenerationRequest = {
      prompt: spec.prompt,
      duration: spec.duration ?? args.duration,
      author_id: args.authorId,
      visibility: "catalogue"
    };

    /* F-17/F-18. The skip above is the OUTER resume — a prompt whose candidate
       exists costs nothing — and it is unchanged. This is the inner one: a
       prompt whose candidate does NOT exist because the run died at beat 23 of
       31 still has 22 beats on disk, and this is what hands them back. The
       checkpoint key is the candidate's basename minus `.json`, so the two
       files sit side by side and a human can see which prompt a half-finished
       run belongs to. */
    const checkpointKey = basename.replace(/\.json$/, "");
    const checkpointStore = new FileCheckpointStore(
      path.resolve(args.out),
      checkpointFingerprint({ prompt: spec.prompt, duration: request.duration, topic: spec.topic })
    );
    if (args.noResume) checkpointStore.discard(checkpointKey);
    const resumable = !args.noResume && checkpointStore.load(checkpointKey) !== null;
    if (resumable) {
      const stages = Object.keys(checkpointStore.load(checkpointKey)!.stages);
      console.log(`  resume ${spec.prompt.slice(0, 60)} — ${stages.length} stage(s) already done: ${stages.join(", ")}`);
    }

    let outcome: RunPipelineOutcome;
    try {
      /* The machine this driver runs on holds the transcript bodies (data-local/,
         gitignored), so §4.5 tier 2 gets the real cue provider. On a checkout
         without them the provider returns null for every episode and the run
         behaves exactly as before — pool segments only. */
      outcome = await runForayPipeline(
        request,
        { userId: args.authorId, topic: spec.topic, checkpointKey },
        { cueProvider, checkpoint: args.dryRun ? undefined : checkpointStore }
      );
    } catch (err) {
      /* One prompt's failure must not end the batch — a rate limit or a budget
         stop on prompt 7 should still leave prompts 1-6 on disk and prompt 8
         attempted. The error is recorded, not swallowed. */
      const detail = err instanceof Error ? err.message : String(err);
      report.push({ prompt: spec.prompt, outcome: "error", detail, ms: 0 });
      /* Not truncated for a budget stop: its message is the whole point (F-04)
         and cutting it at 120 characters removes the spend and the resume
         instruction, which is exactly the half a person needs. */
      console.log(`  ERROR  ${spec.prompt.slice(0, 60)} — ${err instanceof BudgetStopError ? detail : detail.slice(0, 120)}`);
      if (!args.dryRun && !(err instanceof BudgetStopError)) {
        console.log(`         checkpoint kept at ${checkpointStore.filePathFor(checkpointKey)} — re-run to resume`);
      }
      continue;
    }

    const ms = outcome.timings.reduce((sum, t) => sum + t.ms, 0);
    const line = summarize(outcome);
    console.log(`  ${outcome.outcome === "generated" ? "built " : "stop  "} ${spec.prompt.slice(0, 60)} — ${line}`);

    const entry = { prompt: spec.prompt, outcome: outcome.outcome, detail: line, ms };
    if (outcome.outcome === "generated" && outcome.result.validation.ok) {
      if (!args.dryRun) {
        fs.writeFileSync(file, `${JSON.stringify(outcome.input, null, 2)}\n`);
        /* The candidate now IS the resume record — the outer skip above will
           see it. A checkpoint left beside a finished candidate is only a trap
           for the next reader. */
        checkpointStore.discard(checkpointKey);
      }
      generated++;
      report.push({ ...entry, file: args.dryRun ? undefined : file });
    } else {
      /* A rejected or clarification-needing prompt is TERMINAL: re-running it
         unchanged produces the same answer, and a changed prompt has a
         different fingerprint and so a different checkpoint. Leaving the file
         behind would litter the output directory with checkpoints no run will
         ever resume. A validation failure is NOT terminal — the stages are
         sound and the checkers refused the assembly — so that one keeps its
         checkpoint and the re-run pays only for what it must. */
      if (!args.dryRun && outcome.outcome !== "generated") checkpointStore.discard(checkpointKey);
      report.push(entry);
    }
  }

  /* Count what actually happened, not what the outcome tag says. A run that
     reached §4.9 and FAILED validation still carries `outcome: "generated"` —
     the pipeline generated something and the checkers refused it. The first
     end-to-end run printed "0 did not produce a Foray" while producing zero
     publishable candidates, which is the wrong number to put in front of
     someone deciding whether the batch worked. */
  const publishable = report.filter((r) => r.detail.startsWith("OK ")).length;

  const reportPath = path.join(path.resolve(args.out), "report.json");
  if (!args.dryRun) {
    fs.writeFileSync(
      reportPath,
      `${JSON.stringify({ generated_at: new Date().toISOString(), dry_run: false, entries: report }, null, 2)}\n`
    );
  }

  console.log(
    `\n${generated} candidate(s) written, ${skipped} skipped, ` +
      `${report.length - publishable} did not produce a publishable Foray.`
  );
  if (!args.dryRun) {
    console.log(`Report: ${reportPath}`);
    console.log(`Publish one with: npm run publish-foray -- --input <candidate>.json`);
  }
}

/* Only run when invoked as a script; importing this module for its exported
   helpers (which the tests do) must not start a batch. */
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
