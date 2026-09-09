#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { finalizeForay, type FinalizeForayInput } from "../generation/finalizeForay";
import { evaluateVeracityGate } from "../generation/veracityMetrics";

/**
 * `npm run publish-foray` — §4.9's finalize-and-publish CLI
 * (docs/curation/generation-architecture.md §4.9).
 *
 * WHAT THIS TAKES: a JSON file matching `FinalizeForayInput`
 * (`finalizeForay.ts`) — the Foray-level fields (id/title/topic/summary/
 * slots/runtimeSec) plus `items: ForayItem[]`, i.e. exactly
 * `stitchForay()`'s own `StitchForayResult.items` (§4.8's output) with
 * §4.9's few additional fields §4.8 has no reason to own. This is a real,
 * honest seam: §4.0-4.8 are wired stage-to-stage as in-memory function
 * calls (see `stitchForay.ts`), but nothing yet drives the WHOLE chain
 * end to end from one CLI entry point — `generateForay.ts` (§4.0-4.1's
 * own CLI) stops at "understood", because §4.2 (research) is the next
 * unbuilt stage in that chain, not because of anything §4.9 does. A
 * founder or a future orchestrating script runs the pipeline's stages
 * and hands this CLI their `stitchForay()` result as JSON; wiring one
 * top-to-bottom `npm run generate-foray-full` command is explicitly
 * out of scope for this stage's own task brief (§4.9 is "finalize AND
 * PUBLISH", not "orchestrate 4.0-4.8") and is honestly flagged as a gap
 * in `docs/curation/generation-pipeline-status.md`.
 *
 * WHAT THIS DOES, IN ORDER:
 *   1. Validate the candidate via `finalizeForay()` — §4.9 rule 1, calls
 *      into the EXISTING `check-forays.mjs`/`check-narration.mjs`.
 *   2. On failure: print every error, exit 1. NOTHING is written, no
 *      branch, no commit, no PR. §4.9 rule 4 / this stage's own Tests
 *      section: "A stitched Foray that FAILS validation does not
 *      produce a PR, and reports why clearly."
 *   3. On success: write the updated `data/forays.json` (§4.9 rule 2,
 *      exact existing schema), then open a PR against `main` — NEVER a
 *      direct commit — using the SAME pattern
 *      `docs/agents/runner-prompts/foray-nightly.md` step 7 already
 *      uses (branch, commit, push, `gh pr create --base main`). Phase 1
 *      only: this always produces a PR a founder reviews (§1.3), and
 *      `--hold` (default true) applies the `hold` label so
 *      `automerge-nightly.yml` — which would otherwise auto-merge any
 *      green PR touching only `data/` — does NOT auto-merge a generated
 *      Foray. That auto-merge path exists for machine-authored content
 *      whose failure mode is a red CI check; a generated Foray's failure
 *      mode is prose a validator cannot judge (tone, factual framing,
 *      whether the narrator sounds right), which is exactly why §4.9
 *      keeps a founder in the loop even though the file it writes lives
 *      in an otherwise auto-mergeable path. Phase 2 (§1.3's later,
 *      NOT-built-here automated-publish behaviour) is the point where
 *      this hold would come off — not this stage.
 *
 * WS-B VERACITY GATE (docs/curation/generation-fix-plan-2026-09-09.md):
 * between validation and writing anything, this also checks the
 * candidate's `meta.veracity` (computed by `runPipeline.ts`, see
 * `veracityMetrics.ts`) against three floors — `groundedQuoteRate < 1`,
 * `purposeFidelity < 0.8`, or `tapeRelevance < 0.9` all refuse to publish,
 * printing which pages/anchors failed. `null` on any of those three counts
 * as failing (unmeasured is not passing — see `evaluateVeracityGate`'s own
 * comment). `--force` overrides the gate and notes the override, with the
 * specific failures, in the PR body — it does NOT skip check-forays.mjs/
 * check-narration.mjs, which have no override.
 *
 * Usage:
 *   npm run publish-foray -- --input path/to/candidate.json
 *   npm run publish-foray -- --input path/to/candidate.json --dry-run
 *   npm run publish-foray -- --input path/to/candidate.json --no-hold
 *   npm run publish-foray -- --input path/to/candidate.json --force
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

interface CliArgs {
  input: string | null;
  dryRun: boolean;
  hold: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  return {
    input: get("--input") ?? null,
    dryRun: argv.includes("--dry-run"),
    hold: !argv.includes("--no-hold"),
    force: argv.includes("--force")
  };
}

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): string {
  return execFileSync(cmd, args, { cwd: opts.cwd ?? REPO_ROOT, encoding: "utf8" }).trim();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error("Usage: npm run publish-foray -- --input path/to/candidate.json [--dry-run] [--no-hold] [--force]");
    process.exitCode = 1;
    return;
  }

  const raw = fs.readFileSync(path.resolve(args.input), "utf8");
  const input = JSON.parse(raw) as FinalizeForayInput;

  const result = await finalizeForay(input);

  for (const t of result.timings) console.log(`[timing] ${t.name}: ${t.ms}ms`);

  if (!result.validation.ok) {
    console.error(`Foray "${input.id}" FAILED validation — no file written, no PR opened.`);
    for (const e of result.validation.checkForaysErrors) console.error(`  check-forays: ${e}`);
    for (const e of result.validation.checkNarrationErrors) console.error(`  check-narration: ${e}`);
    process.exitCode = 1;
    return;
  }

  for (const w of result.validation.checkForaysWarnings) console.warn(`  check-forays WARN: ${w}`);
  for (const w of result.validation.checkNarrationWarnings) console.warn(`  check-narration WARN: ${w}`);
  console.log(`Foray "${input.id}" passed validation.`);

  // WS-B veracity gate — see this file's own doc comment.
  const gate = evaluateVeracityGate(input.meta?.veracity);
  if (!gate.ok) {
    console.error(`Foray "${input.id}" FAILED the veracity gate:`);
    for (const f of gate.failures) console.error(`  ${f}`);
    if (!args.force) {
      console.error('Refusing to publish. Use --force to override (the override will be noted in the PR body).');
      process.exitCode = 1;
      return;
    }
    console.warn("--force: publishing despite the veracity gate failures above.");
  }

  if (args.dryRun) {
    console.log("--dry-run: not writing data/forays.json, not opening a PR.");
    console.log(JSON.stringify(result.forayRecord, null, 2));
    return;
  }

  const forayPath = path.join(REPO_ROOT, "data", "forays.json");
  const live = JSON.parse(fs.readFileSync(forayPath, "utf8")) as { forays: unknown[] };
  live.forays.push(result.forayRecord);
  fs.writeFileSync(forayPath, `${JSON.stringify(live, null, 2)}\n`);
  console.log(`Wrote data/forays.json (+1 Foray: ${input.id}).`);

  // Branch, commit, push, PR — matching foray-nightly.md step 7 exactly.
  const branch = `generate/${input.id}`;
  run("git", ["switch", "-c", branch]);
  run("git", ["add", "data/forays.json"]);
  run("git", ["commit", "-m", `Generated Foray: ${input.title} (${input.id})`]);
  run("git", ["push", "-u", "origin", "HEAD"]);

  const prBody =
    `Automated §4.9 finalize/publish. Foray "${input.id}" passed check-forays.mjs and ` +
    `check-narration.mjs. Phase 1 (docs/curation/generation-architecture.md §1.3): this PR ` +
    "is for a founder to review before it reaches the catalogue — it does not auto-merge." +
    (!gate.ok
      ? `\n\n**WS-B veracity gate overridden with --force.** Failures at publish time:\n${gate.failures
          .map((f) => `- ${f}`)
          .join("\n")}`
      : "");
  const prUrl = run("gh", ["pr", "create", "--base", "main", "--title", `Generated Foray: ${input.title}`, "--body", prBody]);
  console.log(`Opened PR: ${prUrl}`);

  if (args.hold) {
    run("gh", ["pr", "edit", prUrl, "--add-label", "hold"]);
    console.log('Applied "hold" — automerge-nightly.yml will not merge this without it being removed by a founder.');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
