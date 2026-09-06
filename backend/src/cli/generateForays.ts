#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { runForayPipeline, type RunPipelineOutcome } from "../generation/runPipeline";
import type { GenerationRequest } from "../types/generation";
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

interface CliArgs {
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

  const report: Array<{ prompt: string; outcome: string; detail: string; ms: number; file?: string }> = [];
  let generated = 0;
  let skipped = 0;

  for (const spec of queue) {
    const file = path.join(path.resolve(args.out), candidateFilename(spec.prompt));
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

    let outcome: RunPipelineOutcome;
    try {
      outcome = await runForayPipeline(request, { userId: args.authorId, topic: spec.topic });
    } catch (err) {
      /* One prompt's failure must not end the batch — a rate limit or a budget
         stop on prompt 7 should still leave prompts 1-6 on disk and prompt 8
         attempted. The error is recorded, not swallowed. */
      const detail = err instanceof Error ? err.message : String(err);
      report.push({ prompt: spec.prompt, outcome: "error", detail, ms: 0 });
      console.log(`  ERROR  ${spec.prompt.slice(0, 60)} — ${detail.slice(0, 120)}`);
      continue;
    }

    const ms = outcome.timings.reduce((sum, t) => sum + t.ms, 0);
    const line = summarize(outcome);
    console.log(`  ${outcome.outcome === "generated" ? "built " : "stop  "} ${spec.prompt.slice(0, 60)} — ${line}`);

    const entry = { prompt: spec.prompt, outcome: outcome.outcome, detail: line, ms };
    if (outcome.outcome === "generated" && outcome.result.validation.ok) {
      if (!args.dryRun) fs.writeFileSync(file, `${JSON.stringify(outcome.input, null, 2)}\n`);
      generated++;
      report.push({ ...entry, file: args.dryRun ? undefined : file });
    } else {
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
