#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  finalizeForay,
  generationBatchId,
  mintedPoolCollisions,
  mintedSegmentRow,
  type FinalizeForayInput,
  type PoolRowLike
} from "../generation/finalizeForay";
import { evaluateVeracityGate, type VeracityGateResult, type VeracityMetrics } from "../generation/veracityMetrics";

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
 *   0. `git fetch origin main` and refuse, before anything else, if the
 *      checkout's three data files differ from `origin/main`'s — see
 *      THE BRANCH IS CUT FROM ORIGIN/MAIN below. Validation runs against
 *      the pool that is on `main`, or it validated the wrong pool.
 *   1. Validate the candidate via `finalizeForay()` — §4.9 rule 1, calls
 *      into the EXISTING `check-forays.mjs`/`check-narration.mjs`.
 *   2. On failure: print every error, exit 1. NOTHING is written, no
 *      branch, no commit, no PR. §4.9 rule 4 / this stage's own Tests
 *      section: "A stitched Foray that FAILS validation does not
 *      produce a PR, and reports why clearly."
 *   3. On success: cut `generate/<id>` from `origin/main`, write the
 *      updated `data/forays.json` (§4.9 rule 2, exact existing schema)
 *      plus the minted pool/registry rows, then open a PR against
 *      `main` — NEVER a direct commit — using the SAME pattern
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
 * THE BRANCH IS CUT FROM ORIGIN/MAIN, NOT FROM HEAD (F-75, FD-07). The
 * first generated Foray was published from a checkout of the generation
 * branch; `git switch -c generate/<id>` branched from THAT, and the PR
 * carried the branch's hundred unrelated commits — a person re-based the
 * three data files onto `main` by hand (PR #583). The publish is a change to
 * three data files on `main` and nothing else, so:
 *   - `assertDataFilesMatchMain` fetches `origin/main` and refuses if the
 *     working tree's copies of the three files differ from it in any way this
 *     run has not yet written (it runs before anything is written, so ANY
 *     difference is one it did not write). Otherwise the validated pool is
 *     not the pool the PR would land on, and the commit would carry that
 *     difference as if this Foray had made it.
 *   - `cutPublishBranch` starts the branch at `origin/main` explicitly.
 *   - `commitPublish` proves, after committing, that `origin/main..HEAD` is
 *     one commit touching exactly the files this run wrote, and refuses to
 *     push anything else.
 * The PR then says what happens next: `automerge-nightly.yml` may merge a
 * green `data/`-only PR once the hold is lifted, Vercel deploys `main`, and
 * phones pick the Foray up on next launch after the deploy — no store build
 * (the Foray directory, FD-03). `--report <report.json>` records the PR on the
 * candidate's row, with the deploy id when one is known (`--deploy-id`) and
 * `null` otherwise — the id is minted by the deploy, after the merge, so a
 * publish cannot know it yet.
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
 *   npm run publish-foray -- --input path/to/candidate.json --report out/report.json [--deploy-id <id>]
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/** The three files the app reads for Forays and the ONLY files a publish may
 * change (requirements §6.6: "the order lives in forays.json, the timestamps in
 * segments.json, the audio in segment-sources.json"). */
export const PUBLISH_DATA_FILES = ["data/forays.json", "data/segments.json", "data/segment-sources.json"] as const;

/** Where every publish branch starts. Not the checkout's HEAD (F-75). */
export const PUBLISH_BASE = "origin/main";

/** One shell command, its stdout. Injected so the branch choreography is
 * testable without a git repository. */
export type Runner = (cmd: string, args: string[]) => string;

interface CliArgs {
  input: string | null;
  dryRun: boolean;
  hold: boolean;
  force: boolean;
  report: string | null;
  deployId: string | null;
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
    force: argv.includes("--force"),
    report: get("--report") ?? null,
    deployId: get("--deploy-id") ?? null
  };
}

function makeRunner(cwd: string): Runner {
  return (cmd, args) => execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();
}

/**
 * Step 0: the working tree's three data files must be byte-for-byte
 * `origin/main`'s. Fetches first, so "main" means main as of now, not as of
 * the last time someone pulled. Runs BEFORE validation and BEFORE any write,
 * so any difference it finds is one this publish did not make.
 */
export function assertDataFilesMatchMain(run: Runner): void {
  run("git", ["fetch", "origin", "main"]);
  const differing = run("git", ["diff", "--name-only", PUBLISH_BASE, "--", ...PUBLISH_DATA_FILES])
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (differing.length > 0) {
    throw new Error(
      `Refusing to publish: ${differing.join(", ")} differ${differing.length === 1 ? "s" : ""} between this checkout and ` +
        `${PUBLISH_BASE} in a way this publish did not write (F-75). A publish is a change to the three data files on main ` +
        "and nothing else — run it from a checkout whose data/ matches origin/main (e.g. `git checkout origin/main -- " +
        `${PUBLISH_DATA_FILES.join(" ")}\` after committing or stashing anything you meant to keep).`
    );
  }
}

/** Step 3a: the publish branch starts at `origin/main`, explicitly, never at
 * whatever the checkout happens to have checked out (F-75). */
export function cutPublishBranch(run: Runner, branch: string): void {
  run("git", ["switch", "--no-track", "-c", branch, PUBLISH_BASE]);
}

/**
 * Step 3b: stage exactly the written files, commit, and PROVE the commit is
 * the publish and nothing else before anything is pushed: `origin/main..HEAD`
 * is one commit, and the files it touches are exactly `writtenDataFiles`.
 */
export function commitPublish(run: Runner, writtenDataFiles: readonly string[], message: string): void {
  run("git", ["add", ...writtenDataFiles]);
  run("git", ["commit", "-m", message]);

  const commits = run("git", ["rev-list", "--count", `${PUBLISH_BASE}..HEAD`]).trim();
  if (commits !== "1") {
    throw new Error(`Refusing to push: ${PUBLISH_BASE}..HEAD is ${commits} commit(s), not the one publish commit (F-75).`);
  }
  const touched = run("git", ["diff", "--name-only", PUBLISH_BASE, "HEAD"])
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .sort();
  const expected = [...writtenDataFiles].sort();
  if (touched.length !== expected.length || touched.some((f, i) => f !== expected[i])) {
    throw new Error(
      `Refusing to push: the publish commit touches [${touched.join(", ")}] but this run wrote [${expected.join(", ")}] (F-75).`
    );
  }
}

/** F-88: the lines the PR body and the publish log print for the pages
 * verified by synthesis of the Foray's own verified pages — none when
 * there are none, so a Foray without one reads exactly as before. */
export function synthesisVerifiedLines(veracity: Pick<VeracityMetrics, "synthesisVerifiedPages" | "synthesisVerifiedPageDetails"> | undefined): string[] {
  if (!veracity || veracity.synthesisVerifiedPages === 0) return [];
  return [
    `${veracity.synthesisVerifiedPages} page(s) verified by synthesis of the Foray's own verified pages (F-88):`,
    ...veracity.synthesisVerifiedPageDetails.map((p) => `[${p.mode}] ${p.claim.slice(0, 80)} — verified by synthesis of pages ${p.restsOn.join(", ")}`)
  ];
}

/** The PR body: what was checked, what happens after merge, any override,
 * and (F-88) which pages stand on the Foray's own pages rather than print. */
export function publishPrBody(
  input: Pick<FinalizeForayInput, "id">,
  gate: VeracityGateResult,
  veracity?: Pick<VeracityMetrics, "synthesisVerifiedPages" | "synthesisVerifiedPageDetails">
): string {
  const synthesis = synthesisVerifiedLines(veracity);
  return (
    `Automated §4.9 finalize/publish. Foray "${input.id}" passed check-forays.mjs and ` +
    `check-narration.mjs. Phase 1 (docs/curation/generation-architecture.md §1.3): this PR ` +
    "is for a founder to review before it reaches the catalogue — it does not auto-merge while the `hold` label is on." +
    "\n\nBranch cut from `origin/main`; touches only `data/forays.json`, `data/segments.json` and `data/segment-sources.json`. " +
    "Once merged, Vercel deploys `main` and phones pick this Foray up on next launch after the deploy — " +
    "no store build (the Foray directory, FD-03)." +
    (!gate.ok
      ? `\n\n**WS-B veracity gate overridden with --force.** Failures at publish time:\n${gate.failures
          .map((f) => `- ${f}`)
          .join("\n")}`
      : "") +
    (synthesis.length > 0 ? `\n\n**${synthesis[0]}**\n${synthesis.slice(1).map((l) => `- ${l}`).join("\n")}` : "")
  );
}

/** What a publish leaves on the candidate's `report.json` row. `deploy_id` is
 * the Vercel deploy the Foray shipped in — `null` until someone knows it. */
export interface PublishRecord {
  pr_url: string;
  branch: string;
  base: string;
  base_sha: string;
  deploy_id: string | null;
  published_at: string;
}

/**
 * Writes `publish` onto the report row whose `file` is this candidate (matched
 * by basename — `generateForays.ts` records the path it wrote). Returns false,
 * touching nothing, when the report has no such row, so a publish of a
 * hand-made candidate is not a crash.
 */
export function recordPublishInReport(reportPath: string, candidateFile: string, record: PublishRecord): boolean {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-supplied --report path.
  const doc = JSON.parse(fs.readFileSync(reportPath, "utf8")) as { entries?: Array<{ file?: string; publish?: PublishRecord }> };
  const want = path.basename(candidateFile);
  const row = (doc.entries ?? []).find((e) => typeof e.file === "string" && path.basename(e.file) === want);
  if (!row) return false;
  row.publish = record;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- same operator-supplied path.
  fs.writeFileSync(reportPath, `${JSON.stringify(doc, null, 2)}\n`);
  return true;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error(
      "Usage: npm run publish-foray -- --input path/to/candidate.json [--dry-run] [--no-hold] [--force] [--report report.json] [--deploy-id <id>]"
    );
    process.exitCode = 1;
    return;
  }
  const run = makeRunner(REPO_ROOT);

  // Step 0 — see THE BRANCH IS CUT FROM ORIGIN/MAIN in this file's doc comment.
  assertDataFilesMatchMain(run);

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
  for (const line of synthesisVerifiedLines(input.meta?.veracity)) console.log(`  ${line}`);
  if (!gate.ok) {
    console.error(`Foray "${input.id}" FAILED the veracity gate:`);
    for (const f of gate.failures) console.error(`  ${f}`);
    if (!args.force) {
      console.error("Refusing to publish. Use --force to override (the override will be noted in the PR body).");
      process.exitCode = 1;
      return;
    }
    console.warn("--force: publishing despite the veracity gate failures above.");
  }

  /* The minted pool rows are built BEFORE the dry-run exit and before any
     write, because `mintedSegmentRow` is where a row the pool gate would refuse
     (no DAI verdict, a `why` that trips a copy rule) is refused — loudly, here,
     not by CI after the PR is open (F-78). */
  const mintedSegments = input.segments ?? [];
  const mintedSources = input.segmentSources ?? [];
  const rowContext = { batchId: generationBatchId(input.id), sources: mintedSources };
  const mintedRows = mintedSegments.map((s) => ({ id: s.id, row: mintedSegmentRow(s, input.topic, rowContext) }));

  if (args.dryRun) {
    console.log("--dry-run: not writing data/forays.json, not opening a PR.");
    console.log(JSON.stringify(result.forayRecord, null, 2));
    if (mintedRows.length > 0) console.log(JSON.stringify({ minted_segments: mintedRows.map((m) => m.row) }, null, 2));
    return;
  }

  // Step 3a — the branch, from origin/main, BEFORE anything is written.
  const branch = `generate/${input.id}`;
  const baseSha = run("git", ["rev-parse", PUBLISH_BASE]);
  cutPublishBranch(run, branch);

  const forayPath = path.join(REPO_ROOT, "data", "forays.json");
  const live = JSON.parse(fs.readFileSync(forayPath, "utf8")) as { forays: unknown[] };
  live.forays.push(result.forayRecord);
  fs.writeFileSync(forayPath, `${JSON.stringify(live, null, 2)}\n`);
  console.log(`Wrote data/forays.json (+1 Foray: ${input.id}).`);

  /* THE TIER-2 TAPE THE FORAY REFERS TO (F-49 plumbing). `finalizeForay`
     validated the candidate against a pool with these merged in; publishing the
     Foray without them would ship a `segment_id` no reader can resolve — which
     is the same "unknown segment_id" failure, moved from the checker to the
     player. Written in the same commit, so the three files are never out of
     step with each other. Ids already on disk are left alone: the committed row
     is the authority for a segment a curator's batch has already merged — and a
     minted row that would sit BESIDE a committed row at the same start, or
     shadow one with a different cut, is refused here rather than written under
     an id the pool gate rejects (F-84, `mintedPoolCollisions`). Asked again at
     the write, not only at finalize, because this is the seam that writes. */
  const writtenDataFiles: string[] = ["data/forays.json"];
  if (mintedRows.length > 0) {
    const poolPath = path.join(REPO_ROOT, "data", "segments.json");
    const pool = JSON.parse(fs.readFileSync(poolPath, "utf8")) as { segments: PoolRowLike[] };
    const collisions = mintedPoolCollisions(mintedSegments, pool.segments);
    if (collisions.length > 0) {
      throw new Error(`publishForay: refusing to write data/segments.json — ${collisions.join("; ")}`);
    }
    const known = new Set(pool.segments.map((s) => s.id));
    const added = mintedRows.filter((m) => !known.has(m.id)).map((m) => m.row);
    if (added.length > 0) {
      pool.segments.push(...added);
      fs.writeFileSync(poolPath, `${JSON.stringify(pool, null, 2)}\n`);
      writtenDataFiles.push("data/segments.json");
      console.log(`Wrote data/segments.json (+${added.length} tier-2 segment(s), flagged needs_review).`);
    }
  }
  if (mintedSources.length > 0) {
    const registryPath = path.join(REPO_ROOT, "data", "segment-sources.json");
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")) as { sources: Array<{ id?: string }> };
    const known = new Set(registry.sources.map((s) => s.id));
    const added = mintedSources.filter((s) => !known.has(s.id));
    if (added.length > 0) {
      registry.sources.push(...added);
      fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
      writtenDataFiles.push("data/segment-sources.json");
      console.log(`Wrote data/segment-sources.json (+${added.length} episode source row(s)).`);
    }
  }

  // Step 3b — commit, prove it is only the publish, push, PR (foray-nightly.md step 7).
  commitPublish(run, writtenDataFiles, `Generated Foray: ${input.title} (${input.id})`);
  run("git", ["push", "-u", "origin", "HEAD"]);

  const prUrl = run("gh", [
    "pr",
    "create",
    "--base",
    "main",
    "--title",
    `Generated Foray: ${input.title}`,
    "--body",
    publishPrBody(input, gate, input.meta?.veracity)
  ]);
  console.log(`Opened PR: ${prUrl}`);

  if (args.hold) {
    run("gh", ["pr", "edit", prUrl, "--add-label", "hold"]);
    console.log('Applied "hold" — automerge-nightly.yml will not merge this without it being removed by a founder.');
  }

  if (args.report) {
    const record: PublishRecord = {
      pr_url: prUrl,
      branch,
      base: PUBLISH_BASE,
      base_sha: baseSha,
      deploy_id: args.deployId,
      published_at: new Date().toISOString()
    };
    const recorded = recordPublishInReport(path.resolve(args.report), args.input, record);
    console.log(
      recorded
        ? `Recorded the publish on ${args.report} (deploy_id: ${record.deploy_id ?? "null — not known until the deploy"}).`
        : `No row for ${path.basename(args.input)} in ${args.report} — nothing recorded.`
    );
  }
}

/* Only run when invoked as a script; importing this module for its exported
   helpers (which the tests do) must not publish anything. */
if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
