#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { runForayPipeline, type RunPipelineOutcome } from "../generation/runPipeline";
import { FileTranscriptCueProvider } from "../generation/transcriptArchiveLookup";
import type { GenerationRequest } from "../types/generation";
import type { PartialCandidate } from "../generation/partialCandidate";
import { env } from "../config/env";

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
 * RESUMABLE BY CONSTRUCTION. A prompt whose candidate file already exists is
 * skipped, so re-running after a crash, a budget stop, or a rate limit costs
 * nothing for the work already done. That is also why `runForayPipeline` is
 * deterministic given a fixed clock: the skip is keyed on the prompt, and a
 * retry must not mint a second id for the same work.
 *
 * Usage:
 *   npm run generate-forays -- --prompts prompts.json [--out data-local/foray-candidates]
 *                              [--duration short|medium|long] [--limit N] [--dry-run]
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

export interface CliArgs {
  prompts: string | null;
  out: string;
  duration: "short" | "medium" | "long";
  limit: number | null;
  dryRun: boolean;
  authorId: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const d = get("--duration");
  const limitRaw = get("--limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
  return {
    prompts: get("--prompts") ?? null,
    out: get("--out") ?? path.join("data-local", "foray-candidates"),
    duration: d === "short" || d === "medium" || d === "long" ? d : "short",
    limit: Number.isFinite(limit) && limit > 0 ? limit : null,
    dryRun: argv.includes("--dry-run"),
    authorId: get("--author") ?? "founder-1"
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

/** WS-D2's partial-candidate file, next to `candidateFilename`'s own file and
 * keyed the same way (same slug+hash, so a reader can find both without a
 * lookup table). `readPartialCandidate` (`generationStatus.ts`) is the
 * counterpart that reads this back for a status request. */
export function partialCandidateFilename(prompt: string): string {
  return candidateFilename(prompt).replace(/\.json$/, ".partial.json");
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

export type ReportEntry = { prompt: string; outcome: string; detail: string; ms: number; file?: string; ttlA1Ms?: number | null };

/**
 * One prompt's worth of `main()`'s loop body, extracted so a test can drive
 * it directly — same reason `parseArgs`/`normalizePrompts`/`candidateFilename`
 * are already exported. `deps.runPipeline` defaults to the real
 * `runForayPipeline`; `deps.onPartialWrite` is a TEST-ONLY hook (no
 * production caller passes it) fired synchronously right after each partial
 * write lands on disk, so a test can assert on the file's on-disk content at
 * the exact moment WS-D2's "rewrites it on each act" happens, rather than
 * only at the very end once (on success) the partial file has already been
 * cleaned up.
 */
export async function generateOneCandidate(
  spec: PromptSpec,
  args: CliArgs,
  deps: {
    cueProvider: FileTranscriptCueProvider;
    runPipeline?: typeof runForayPipeline;
    onPartialWrite?: (candidate: PartialCandidate, partialFile: string) => void;
  }
): Promise<{ skipped: boolean; entry?: ReportEntry; file?: string }> {
  const runPipeline = deps.runPipeline ?? runForayPipeline;
  const file = path.join(path.resolve(args.out), candidateFilename(spec.prompt));
  if (fs.existsSync(file)) {
    console.log(`  skip   ${spec.prompt.slice(0, 60)} (already built)`);
    return { skipped: true, file };
  }

  const request: GenerationRequest = {
    prompt: spec.prompt,
    duration: spec.duration ?? args.duration,
    author_id: args.authorId,
    visibility: "catalogue"
  };

  /* WS-D2 (docs/curation/generation-fix-plan-2026-09-09.md, "D2 (streaming
     publish)"): "generateForays writes the partial file and rewrites it on
     each act." The partial file lives next to the eventual candidate file,
     under the SAME resumable-batch directory this CLI already writes to —
     no new location, no `data/`/`data-local/` write this CLI didn't already
     make. `--dry-run` writes nothing here either, matching the
     final-candidate path's own `--dry-run` behaviour just below. */
  const partialFile = path.join(path.resolve(args.out), partialCandidateFilename(spec.prompt));
  const onActReady = args.dryRun
    ? undefined
    : (candidate: PartialCandidate) => {
        fs.writeFileSync(partialFile, `${JSON.stringify(candidate, null, 2)}\n`);
        deps.onPartialWrite?.(candidate, partialFile);
      };

  let outcome: RunPipelineOutcome;
  try {
    /* The machine this driver runs on holds the transcript bodies (data-local/,
       gitignored), so §4.5 tier 2 gets the real cue provider. On a checkout
       without them the provider returns null for every episode and the run
       behaves exactly as before — pool segments only. */
    outcome = await runPipeline(request, { userId: args.authorId, topic: spec.topic }, { cueProvider: deps.cueProvider, onActReady });
  } catch (err) {
    /* One prompt's failure must not end the batch — a rate limit or a budget
       stop on prompt 7 should still leave prompts 1-6 on disk and prompt 8
       attempted. The error is recorded, not swallowed. */
    const detail = err instanceof Error ? err.message : String(err);
    console.log(`  ERROR  ${spec.prompt.slice(0, 60)} — ${detail.slice(0, 120)}`);
    return { skipped: false, entry: { prompt: spec.prompt, outcome: "error", detail, ms: 0 } };
  }

  const ms = outcome.timings.reduce((sum, t) => sum + t.ms, 0);
  const line = summarize(outcome);
  const ttlA1Ms = outcome.outcome === "generated" ? outcome.ttlA1Ms : null;
  console.log(
    `  ${outcome.outcome === "generated" ? "built " : "stop  "} ${spec.prompt.slice(0, 60)} — ${line}` +
      (ttlA1Ms != null ? ` (ttlA1=${ttlA1Ms}ms)` : "")
  );

  const entry: ReportEntry = { prompt: spec.prompt, outcome: outcome.outcome, detail: line, ms, ttlA1Ms };
  if (outcome.outcome === "generated" && outcome.result.validation.ok) {
    if (!args.dryRun) {
      fs.writeFileSync(file, `${JSON.stringify(outcome.input, null, 2)}\n`);
      /* The whole Foray is finalized — the partial file's job (letting the
         requesting listener start early) is done, and leaving it on disk
         next to the real candidate would just be a second, staler copy of
         the same content for anyone reading the output directory by hand.
         Best-effort: its absence is not an error. */
      try {
        fs.unlinkSync(partialFile);
      } catch {
        /* nothing to clean up — fine */
      }
    }
    return { skipped: false, entry: { ...entry, file: args.dryRun ? undefined : file }, file };
  }
  return { skipped: false, entry };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.prompts) {
    console.error(
      "Usage: npm run generate-forays -- --prompts prompts.json [--out DIR] " +
        "[--duration short|medium|long] [--limit N] [--dry-run]"
    );
    process.exitCode = 1;
    return;
  }

  const specs = normalizePrompts(JSON.parse(fs.readFileSync(path.resolve(args.prompts), "utf8")));
  const queue = args.limit ? specs.slice(0, args.limit) : specs;

  /* State the mode before doing anything expensive. A run that silently used
     stubs and produced 200 placeholder Forays would look exactly like a
     successful run until someone listened to one. */
  console.log(
    env.anthropicDryRun
      ? `MODE: dry-run (no ANTHROPIC_API_KEY) — stub builders, $0, output is structurally real but editorially empty.`
      : `MODE: live — Anthropic builders, metered by BudgetGuard (daily $${env.dailyBudgetUsd}, per-Foray $${env.episodeBudgetUsd}).`
  );
  console.log(`${queue.length} prompt(s); writing candidates to ${args.out}`);

  fs.mkdirSync(path.resolve(args.out), { recursive: true });

  const report: ReportEntry[] = [];
  let generated = 0;
  let skipped = 0;
  const cueProvider = new FileTranscriptCueProvider();

  for (const spec of queue) {
    const result = await generateOneCandidate(spec, args, { cueProvider });
    if (result.skipped) {
      skipped++;
      continue;
    }
    if (result.entry) {
      report.push(result.entry);
      if (result.file) generated++;
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
