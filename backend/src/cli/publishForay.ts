#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  finalizeForay,
  foraysReferencing,
  generationBatchId,
  isGeneratedDraft,
  mintedPoolCollisions,
  mintedSegmentRow,
  restateDraftRuntimes,
  supersededAddedSec,
  type FinalizeForayInput,
  type ForayRowLike,
  type PoolRowLike,
  type RuntimeRestatement
} from "../generation/finalizeForay";
import { evaluateVeracityGate, type VeracityGateResult, type VeracityMetrics } from "../generation/veracityMetrics";
import {
  formatSuiteFailure,
  knownUncoveredGuidance,
  runRealDataSuites,
  suiteSummaryLine,
  type SuiteFailure,
  type SuiteRunResult,
  type SuiteSpawn
} from "./publishSuites";

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
 * `--force` IMPLIES `hold`, AND `--no-hold` ALONGSIDE IT IS REFUSED (audit
 * finding A, 2026-09-12). Nothing downstream of this CLI can see that the
 * veracity gate was overridden: `meta.veracity` is not written into `data/`
 * (`finalizeForay.ts`), no CI check reads it, and `automerge-nightly.yml`
 * merges a green `data/`-only PR unless it carries `hold`/`founder-decision`.
 * So a forced publish always carries `hold`, and the console says the
 * `--no-hold` it was given was declined and why. See `parseArgs`.
 *
 * G-21c REAL-DATA SUITES GATE (docs/curation/foray-to-spec-roadmap.md G-21c):
 * after the three files are written and BEFORE commit/push/PR, this runs the
 * app's own suites that read the real `data/` (`REAL_DATA_SUITES` in
 * `publishSuites.ts` — `player/media-session.test.js`, `tools/foray/
 * check-forays.test.mjs`, `tools/mobile/prepare-webdir.test.mjs`,
 * `test/foray-directory.test.js` and every other suite that reads the files)
 * with `node --test` from the repo root, and refuses when any is red, printing
 * each failing assertion (suite, test name, assertion text) and writing them
 * onto the candidate's `report.json` row as `publish_refused` when `--report`
 * is given. The third generated Foray's data PR (#632) went red in exactly
 * those suites after check-forays.mjs had passed it: the checker validates the
 * document, the suites validate what the app DOES with it. On refusal the
 * working tree is put back byte-for-byte and the publish branch abandoned, so
 * the checkout is left as the veracity refusal leaves it — nothing written,
 * on the branch it started on (see `gateWrittenTree`). `--force` overrides
 * this gate too, and the PR body lists the failing assertions. `--dry-run`
 * writes the files, runs the suites, restores the files, and reports — no
 * branch, no PR — so a candidate can be gated locally without publishing.
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

export interface CliArgs {
  input: string | null;
  dryRun: boolean;
  hold: boolean;
  force: boolean;
  report: string | null;
  deployId: string | null;
  /** F-98: the prior generated DRAFT of this same prompt, removed by this
   * publish so the Foray list does not accumulate one draft per attempt. */
  supersedes: string | null;
  /** `--no-hold` was asked for and REFUSED because `--force` was given too.
   * `main()` says so on the console; the flag combination is not an error, it
   * is a request the gate declines (see `parseArgs`). */
  holdForcedByForce: boolean;
}

/**
 * `--force` IMPLIES `hold`, and that is the whole point of this function.
 *
 * WHY (audit finding A, 2026-09-12). `--force` overrides the WS-B veracity
 * gate — the only check that looks at whether the narration is grounded in
 * the tape — and `meta.veracity` is never written into `data/`, so NOTHING
 * downstream can see that the override happened. `tools/ci/path-policy.mjs`
 * allow-lists `data/`, and `.github/workflows/automerge-nightly.yml` merges a
 * green `data/`-only PR on its own unless it carries `hold` or
 * `founder-decision`. So `--force --no-hold` put a Foray with unverified
 * narration on main, and through the directory (FD-03) onto every phone, with
 * no human in the loop and no artifact of the override outside the PR body
 * nobody was required to read.
 *
 * The G-21c suite override is NOT the same hazard and is deliberately left
 * alone: a suite that is red here is red in CI too, so `--force` on it buys a
 * PR that cannot merge. The veracity override is self-limiting in no such way.
 *
 * WHY THIS FORCES THE FLAG RATHER THAN REFUSING THE RUN. Refusing would make
 * an unattended `--force` run exit 1 and publish nothing, which loses the
 * candidate; forcing `hold` publishes it and asks a founder to look. The
 * failing direction of an accident should be "a human reads it", not "the work
 * is thrown away". The console says the flag was refused and why.
 */
export function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const force = argv.includes("--force");
  const noHold = argv.includes("--no-hold");
  return {
    input: get("--input") ?? null,
    dryRun: argv.includes("--dry-run"),
    hold: force ? true : !noHold,
    force,
    report: get("--report") ?? null,
    deployId: get("--deploy-id") ?? null,
    supersedes: get("--supersedes") ?? null,
    holdForcedByForce: force && noHold
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

/** Where the checkout was before the publish branch was cut — what
 * `abandonPublishBranch` switches back to. A detached HEAD is remembered by
 * sha, since `git switch <sha>` needs `--detach`. */
export type PreviousRef = { kind: "branch"; name: string } | { kind: "detached"; sha: string };

export function currentRef(run: Runner): PreviousRef {
  const name = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (name && name !== "HEAD") return { kind: "branch", name };
  return { kind: "detached", sha: run("git", ["rev-parse", "HEAD"]).trim() };
}

/** The three data files' bytes before a write (`null` = the file did not
 * exist), so a refused publish can put them back EXACTLY. Bytes rather than
 * `git checkout -- data/` because the restore must not depend on what the
 * index holds: step 0 proved the working tree's copies are `origin/main`'s,
 * and this puts back precisely those copies whatever branch or index state
 * the checkout is in. */
export type DataSnapshot = Map<string, Buffer | null>;

export function snapshotDataFiles(repoRoot: string, files: readonly string[] = PUBLISH_DATA_FILES): DataSnapshot {
  const snap: DataSnapshot = new Map();
  for (const rel of files) {
    const abs = path.join(repoRoot, rel);
    snap.set(rel, fs.existsSync(abs) ? fs.readFileSync(abs) : null);
  }
  return snap;
}

export function restoreDataFiles(repoRoot: string, snapshot: DataSnapshot): void {
  for (const [rel, bytes] of snapshot) {
    const abs = path.join(repoRoot, rel);
    if (bytes === null) fs.rmSync(abs, { force: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- same fixed files.
    else fs.writeFileSync(abs, bytes);
  }
}

/** Undo `cutPublishBranch` after a refusal: back to where the checkout was,
 * then delete the never-pushed publish branch. Call AFTER `restoreDataFiles`
 * so the tree is clean and the switch cannot carry a half-written file over. */
export function abandonPublishBranch(run: Runner, branch: string, previous: PreviousRef): void {
  if (previous.kind === "branch") run("git", ["switch", previous.name]);
  else run("git", ["switch", "--detach", previous.sha]);
  run("git", ["branch", "-D", branch]);
}

/** Everything the write needs, built before anything is touched. */
export interface PublishWritePlan {
  forayRecord: unknown;
  mintedSegments: NonNullable<FinalizeForayInput["segments"]>;
  mintedRows: Array<{ id: string; row: PoolRowLike }>;
  mintedSources: Array<{ id?: string }>;
  /**
   * F-98: `--supersedes <foray-id>` — the prior DRAFT of this same prompt, to be
   * removed in the same commit that adds the new one, along with every minted
   * pool row only it referenced.
   *
   * WHY THE FLAG EXISTS. A regenerated draft is a second attempt at one Foray,
   * not a second Foray, and without this the list accumulates one draft per
   * attempt — run 8 and run 9 are the same prompt and both sit in
   * `data/forays.json`. Null on every ordinary publish, which is the whole of
   * the pre-F-98 behaviour.
   */
  supersedesForayId?: string | null;
}

/** What the write did, beyond which files it touched. */
export interface PublishWriteResult {
  /** Repo-relative files actually changed — what `commitPublish` stages. */
  files: string[];
  /** F-98: pool rows this publish re-cut in place, and the drafts whose
   * `runtime_sec` moved with them. */
  superseded: Array<{ id: string; fromEndSec: number; toEndSec: number }>;
  restated: RuntimeRestatement[];
  /** F-98: the prior draft `--supersedes` removed, and the minted rows that went
   * with it because nothing else played them. */
  removed: { forayId: string; segmentIds: string[] } | null;
}

/**
 * Step 3 — write the three data files into the working tree. Returns the
 * repo-relative files it actually changed (a Foray that mints nothing writes
 * only `data/forays.json`). Throws — writing nothing further — on an F-84
 * collision; the caller restores the tree.
 */
export function writePublishDataFiles(repoRoot: string, plan: PublishWritePlan, log: (line: string) => void = console.log): PublishWriteResult {
  const forayPath = path.join(repoRoot, "data", "forays.json");
  const live = JSON.parse(fs.readFileSync(forayPath, "utf8")) as { forays: ForayRowLike[] };

  /* F-98, STEP ONE: THE PRIOR DRAFT GOES BEFORE THE NEW ONE ARRIVES.
     Removed here rather than left for a person because the alternative is the
     Foray list growing one row per regeneration attempt. Only a GENERATED DRAFT
     can be removed — a curated or published Foray of the same prompt is
     somebody's decision, and this refuses rather than quietly declining, so
     `--supersedes` pointed at the wrong id is an error and not a silent no-op. */
  let removed: PublishWriteResult["removed"] = null;
  if (plan.supersedesForayId) {
    const prior = live.forays.find((f) => f.id === plan.supersedesForayId);
    if (!prior) {
      throw new Error(`publishForay: --supersedes "${plan.supersedesForayId}" names no Foray in data/forays.json.`);
    }
    if (!isGeneratedDraft(prior)) {
      throw new Error(
        `publishForay: --supersedes "${plan.supersedesForayId}" is not a generated draft (generated: ${String(prior.generated)}, ` +
          `status: ${String(prior.status)}) — only a draft this pipeline generated may be replaced by a regenerated attempt (F-98).`
      );
    }
    live.forays = live.forays.filter((f) => f !== prior);
    removed = { forayId: String(prior.id), segmentIds: [] };
  }

  /* Step two: the drafts timed on a row this publish re-cuts. Computed against
     the list AFTER the removal above, so a runtime is never restated on a Foray
     that is on its way out. */
  const addedSecById = supersededAddedSec(plan.mintedSegments);
  const { forays: restatedForays, restated } = restateDraftRuntimes(live.forays, addedSecById);
  live.forays = [...restatedForays, plan.forayRecord as ForayRowLike];
  fs.writeFileSync(forayPath, `${JSON.stringify(live, null, 2)}\n`);
  log(
    `Wrote data/forays.json (+1 Foray${removed ? `, -1 superseded draft ${removed.forayId}` : ""}` +
      `${restated.length > 0 ? `, ${restated.length} draft runtime(s) restated` : ""}).`
  );

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
  const superseded: PublishWriteResult["superseded"] = [];
  const poolPath = path.join(repoRoot, "data", "segments.json");
  if (plan.mintedRows.length > 0 || removed) {
    const pool = JSON.parse(fs.readFileSync(poolPath, "utf8")) as { segments: PoolRowLike[] };
    const collisions = mintedPoolCollisions(plan.mintedSegments, pool.segments);
    if (collisions.length > 0) {
      throw new Error(`publishForay: refusing to write data/segments.json — ${collisions.join("; ")}`);
    }
    /* F-98: THE ORPHANS OF THE REMOVED DRAFT. A row the removed draft was the
       only Foray to reference is a row nothing can play any more; left behind it
       is pool litter that the next run's F-84 reuse would hand to a new Foray at
       a length nobody chose. Removed only when it is a generated mint nobody has
       reviewed and no SURVIVING Foray plays it — the same ownership test
       `poolRowIsSupersedable` applies, asked against the list this write is
       about to commit. */
    if (removed) {
      const survivors = live.forays;
      const orphans = pool.segments.filter(
        (row) =>
          typeof row.id === "string" &&
          (row as { needs_review?: unknown }).needs_review === true &&
          (row as { source?: unknown }).source === "generation-tier-2" &&
          foraysReferencing(survivors, row.id).length === 0
      );
      if (orphans.length > 0) {
        const drop = new Set(orphans.map((o) => String(o.id)));
        pool.segments = pool.segments.filter((row) => !drop.has(String(row.id)));
        removed.segmentIds = [...drop];
      }
    }
    /* F-98: a superseding row REWRITES its committed twin in place — same id,
       same start, the longer end and `superseded_from` — rather than being
       skipped by the "ids already on disk are the pool's" rule. The row keeps
       its position in the file, so the diff a reviewer reads is the one row
       whose end moved. */
    const bySupersededId = new Map(plan.mintedRows.filter((m) => addedSecById.has(m.id)).map((m) => [m.id, m.row]));
    if (bySupersededId.size > 0) {
      pool.segments = pool.segments.map((row) => {
        const replacement = typeof row.id === "string" ? bySupersededId.get(row.id) : undefined;
        if (!replacement) return row;
        superseded.push({ id: String(row.id), fromEndSec: Number(row.end_sec), toEndSec: Number(replacement.end_sec) });
        return replacement;
      });
    }
    const known = new Set(pool.segments.map((s) => s.id));
    const added = plan.mintedRows.filter((m) => !known.has(m.id)).map((m) => m.row);
    if (added.length > 0) pool.segments.push(...added);
    if (added.length > 0 || superseded.length > 0 || (removed?.segmentIds.length ?? 0) > 0) {
      fs.writeFileSync(poolPath, `${JSON.stringify(pool, null, 2)}\n`);
      writtenDataFiles.push("data/segments.json");
      log(
        `Wrote data/segments.json (+${added.length} tier-2 segment(s), flagged needs_review` +
          `${superseded.length > 0 ? `; ${superseded.length} draft row(s) superseded by a longer cut` : ""}` +
          `${(removed?.segmentIds.length ?? 0) > 0 ? `; -${removed!.segmentIds.length} row(s) orphaned by the removed draft` : ""}).`
      );
    }
  }
  if (plan.mintedSources.length > 0) {
    const registryPath = path.join(repoRoot, "data", "segment-sources.json");
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")) as { sources: Array<{ id?: string }> };
    const known = new Set(registry.sources.map((s) => s.id));
    const added = plan.mintedSources.filter((s) => !known.has(s.id));
    if (added.length > 0) {
      registry.sources.push(...added);
      fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
      writtenDataFiles.push("data/segment-sources.json");
      log(`Wrote data/segment-sources.json (+${added.length} episode source row(s)).`);
    }
  }
  return { files: writtenDataFiles, superseded, restated, removed };
}

/** Console sinks, injected so the gate's tests are quiet. */
export interface Out {
  log: (line: string) => void;
  warn: (line: string) => void;
  error: (line: string) => void;
}
const CONSOLE: Out = { log: console.log, warn: console.warn, error: console.error };

/** Prints the suites' verdict the way the veracity gate prints its own —
 * every failure, then the refusal or the `--force` override — and says
 * whether the publish may proceed. */
export function printSuiteVerdict(suites: SuiteRunResult, force: boolean, out: Out = CONSOLE): boolean {
  out.log(suiteSummaryLine(suites));
  if (suites.ok) return true;
  out.error("The app's real-data suites FAILED against the written data files (G-21c):");
  for (const f of suites.failures) out.error(`  ${formatSuiteFailure(f)}`);
  /* Audit finding B: one suite in this gate goes red because the publish is
     RIGHT, and the operator has to be told the fix is a deletion in this PR
     rather than a re-cut of the Foray. See `knownUncoveredGuidance`. */
  for (const line of knownUncoveredGuidance(suites.failures)) out.error(`  ${line}`);
  if (!force) {
    out.error("Refusing to publish. Use --force to override (the override and the failing assertions will be noted in the PR body).");
    return false;
  }
  out.warn("--force: publishing despite the real-data suite failures above.");
  return true;
}

/**
 * G-21c: with the three files written on the freshly cut publish branch,
 * run the app's own suites against them. Green (or `--force`) → proceed to
 * commit. Red without `--force` → restore the three files byte-for-byte,
 * switch back to where the checkout was and delete the branch, so the
 * refusal leaves the checkout exactly as the veracity refusal does: nothing
 * written, nothing to clean up. A throw from the run is treated the same way
 * before it propagates.
 */
export function gateWrittenTree(opts: {
  repoRoot: string;
  force: boolean;
  branch: string;
  previousRef: PreviousRef;
  snapshot: DataSnapshot;
  run: Runner;
  spawn?: SuiteSpawn;
  files?: readonly string[];
  out?: Out;
}): { proceed: boolean; suites: SuiteRunResult } {
  const out = opts.out ?? CONSOLE;
  let suites: SuiteRunResult;
  try {
    suites = runRealDataSuites({ repoRoot: opts.repoRoot, files: opts.files, spawn: opts.spawn });
  } catch (err) {
    restoreDataFiles(opts.repoRoot, opts.snapshot);
    abandonPublishBranch(opts.run, opts.branch, opts.previousRef);
    throw err;
  }
  const proceed = printSuiteVerdict(suites, opts.force, out);
  if (!proceed) {
    restoreDataFiles(opts.repoRoot, opts.snapshot);
    abandonPublishBranch(opts.run, opts.branch, opts.previousRef);
    out.error(`Restored ${[...opts.snapshot.keys()].join(", ")} and abandoned branch ${opts.branch}; nothing was committed.`);
  }
  return { proceed, suites };
}

/** The PR body: what was checked, what happens after merge, any override,
 * and (F-88) which pages stand on the Foray's own pages rather than print. */
export function publishPrBody(
  input: Pick<FinalizeForayInput, "id">,
  gate: VeracityGateResult,
  suites: Pick<SuiteRunResult, "ok" | "failures" | "counts" | "files"> | null = null,
  veracity?: Pick<VeracityMetrics, "synthesisVerifiedPages" | "synthesisVerifiedPageDetails">,
  /** F-98: what this publish changed in the pool and the Foray list BESIDE
   * adding one Foray — a re-cut row, a restated draft runtime, a removed prior
   * draft. Every one of them touches something that was already on main, so
   * every one of them is named in the body a founder reads. */
  write?: Pick<PublishWriteResult, "superseded" | "restated" | "removed">
): string {
  const synthesis = synthesisVerifiedLines(veracity);
  return (
    /* WHAT THIS LINE MAY CLAIM (audit finding D, 2026-09-12). It used to say
       the Foray "passed check-forays.mjs and check-narration.mjs". The second
       half was not true of THIS Foray and structurally could not be:
       `check-narration.mjs` validates the curation-authored artifacts under
       `docs/curation/narration/<id>/`, which the automated §4 pipeline never
       writes (see `finalizeForay.ts`'s header, "CHECK-NARRATION.MJS'S ACTUAL
       SCOPE"). The call still happens and its result is still surfaced on the
       console — it just has nothing of this candidate's to look at, so the PR
       body no longer implies a narration audit that never ran. */
    `Automated §4.9 finalize/publish. Foray "${input.id}" passed check-forays.mjs ` +
    `(the Foray document, the pool join, D1/D5/L2/L3 and the mode bands). ` +
    `check-narration.mjs also ran and reported nothing, but it validates curation-authored ` +
    `narration under docs/curation/narration/<id>/, which this pipeline does not write — ` +
    `it is not a check of this Foray's narration. Phase 1 (docs/curation/generation-architecture.md §1.3): this PR ` +
    "is for a founder to review before it reaches the catalogue — it does not auto-merge while the `hold` label is on." +
    "\n\nBranch cut from `origin/main`; touches only `data/forays.json`, `data/segments.json` and `data/segment-sources.json`. " +
    "Once merged, Vercel deploys `main` and phones pick this Foray up on next launch after the deploy — " +
    "no store build (the Foray directory, FD-03)." +
    (suites && suites.ok
      ? `\n\nG-21c: the app's real-data suites (${suites.files.length} suites, ${suites.counts?.tests ?? "?"} tests) ran green against these files before this PR was opened.`
      : "") +
    (!gate.ok
      ? `\n\n**WS-B veracity gate overridden with --force.** Failures at publish time:\n${gate.failures
          .map((f) => `- ${f}`)
          .join("\n")}`
      : "") +
    (suites && !suites.ok
      ? `\n\n**G-21c real-data suites overridden with --force.** Failing assertions at publish time:\n${suites.failures
          .map((f) => `- ${formatSuiteFailure(f)}`)
          .join("\n")}` +
        (knownUncoveredGuidance(suites.failures).length > 0
          ? `\n\n${knownUncoveredGuidance(suites.failures).join("\n")}`
          : "")
      : "") +
    (synthesis.length > 0 ? `\n\n**${synthesis[0]}**\n${synthesis.slice(1).map((l) => `- ${l}`).join("\n")}` : "") +
    supersedeLines(write)
  );
}

/** F-98's paragraphs of the PR body — empty on a publish that only adds, which
 * is every publish before this card. */
export function supersedeLines(write?: Pick<PublishWriteResult, "superseded" | "restated" | "removed">): string {
  if (!write) return "";
  let out = "";
  if (write.superseded.length > 0) {
    out +=
      `\n\n**${write.superseded.length} draft pool row(s) superseded by a longer cut at the same start (F-98).** ` +
      "Each was `needs_review: true` and referenced only by generated drafts; the row is rewritten in place (same id, " +
      "new `end_sec`/`end_anchor`, `superseded_from`, this batch's id) rather than minted beside (F-84's id rule).\n" +
      write.superseded.map((s) => `- \`${s.id}\`: ${s.fromEndSec} s → ${s.toEndSec} s`).join("\n");
  }
  if (write.restated.length > 0) {
    out +=
      "\n\n**Draft Forays whose `runtime_sec` this publish restates** (the checker's 0.5 s drift rule — they play a row " +
      "that got longer):\n" +
      write.restated.map((r) => `- \`${r.forayId}\`: ${r.fromSec.toFixed(3)} s → ${r.toSec.toFixed(3)} s (${r.segmentIds.join(", ")})`).join("\n");
  }
  if (write.removed) {
    out +=
      `\n\n**\`--supersedes\`: the prior draft \`${write.removed.forayId}\` is removed by this PR** — a regenerated draft of ` +
      "the same prompt replaces it rather than sitting beside it." +
      (write.removed.segmentIds.length > 0
        ? `\nMinted pool rows removed with it (no surviving Foray plays them): ${write.removed.segmentIds.map((id) => `\`${id}\``).join(", ")}`
        : "\nNo pool rows were removed — every row it played is still referenced.");
  }
  return out;
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
  /** G-21c: how the app's real-data suites went against the written files.
   * `ok: false` only ever appears with `--force`. */
  suites?: { ok: boolean; summary: string; failures: SuiteFailure[] };
}

/** What a refused publish leaves on the candidate's `report.json` row (G-21c
 * "done when": the failing assertion text is in `report.json`). */
export interface PublishRefusal {
  gate: "real-data-suites";
  summary: string;
  failures: SuiteFailure[];
  refused_at: string;
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

/**
 * G-21c: writes `publish_refused` — the gate, its summary line and every
 * failing assertion — onto the candidate's row, matched the same way
 * `recordPublishInReport` matches. Returns false, touching nothing, when the
 * report has no row for the candidate.
 */
export function recordRefusalInReport(reportPath: string, candidateFile: string, refusal: PublishRefusal): boolean {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-supplied --report path.
  const doc = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
    entries?: Array<{ file?: string; publish_refused?: PublishRefusal }>;
  };
  const want = path.basename(candidateFile);
  const row = (doc.entries ?? []).find((e) => typeof e.file === "string" && path.basename(e.file) === want);
  if (!row) return false;
  row.publish_refused = refusal;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- same operator-supplied path.
  fs.writeFileSync(reportPath, `${JSON.stringify(doc, null, 2)}\n`);
  return true;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error(
      "Usage: npm run publish-foray -- --input path/to/candidate.json [--dry-run] [--no-hold] [--force] [--report report.json] [--deploy-id <id>] [--supersedes <foray-id>]"
    );
    process.exitCode = 1;
    return;
  }
  if (args.holdForcedByForce) {
    console.warn(
      "--no-hold was REFUSED: --force was given too, and a forced publish always carries the `hold` label " +
        "(audit finding A). --force overrides the WS-B veracity gate, `meta.veracity` is never written into data/, " +
        "and automerge-nightly.yml merges a green data/-only PR on its own — so without `hold` an unreviewed " +
        "narration would reach every phone with no human in the loop. Publish without --force to use --no-hold."
    );
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

  const plan: PublishWritePlan = {
    forayRecord: result.forayRecord,
    mintedSegments,
    mintedRows,
    mintedSources,
    supersedesForayId: args.supersedes
  };

  if (args.dryRun) {
    /* G-21c: --dry-run still WRITES the three files — into the working tree,
       the way the real publish does — because the app's suites only mean
       something against the files as they would be committed; then puts the
       bytes back whether the suites passed, failed or threw. No branch, no
       commit, no PR. Step 0 proved the tree's copies are origin/main's, so
       "back" is exact. */
    console.log("--dry-run: writing the three data files to run the app's real-data suites against them, then restoring them; no branch, no PR.");
    const snapshot = snapshotDataFiles(REPO_ROOT);
    let suites: SuiteRunResult;
    try {
      writePublishDataFiles(REPO_ROOT, plan);
      suites = runRealDataSuites({ repoRoot: REPO_ROOT });
    } finally {
      restoreDataFiles(REPO_ROOT, snapshot);
      console.log(`--dry-run: restored ${PUBLISH_DATA_FILES.join(", ")} byte-for-byte.`);
    }
    const proceed = printSuiteVerdict(suites, args.force);
    console.log(JSON.stringify(result.forayRecord, null, 2));
    if (mintedRows.length > 0) console.log(JSON.stringify({ minted_segments: mintedRows.map((m) => m.row) }, null, 2));
    console.log(`--dry-run verdict: ${proceed ? "would publish" : "would REFUSE"} — ${suiteSummaryLine(suites)}`);
    if (!proceed) process.exitCode = 1;
    return;
  }

  // Step 3a — the branch, from origin/main, BEFORE anything is written.
  const previousRef = currentRef(run);
  const branch = `generate/${input.id}`;
  const baseSha = run("git", ["rev-parse", PUBLISH_BASE]);
  cutPublishBranch(run, branch);

  /* Step 3 — the write, then G-21c's gate on what was written. A throw from the
     write (F-84's collision refusal lives there) is cleaned up the same way a
     refusal is: files back, branch abandoned, then the error propagates. Before
     G-21c nothing cleaned up after that throw — the checkout was left on a
     half-written publish branch for a person to untangle. */
  const snapshot = snapshotDataFiles(REPO_ROOT);
  let write: PublishWriteResult;
  try {
    write = writePublishDataFiles(REPO_ROOT, plan);
  } catch (err) {
    restoreDataFiles(REPO_ROOT, snapshot);
    abandonPublishBranch(run, branch, previousRef);
    throw err;
  }
  const { proceed, suites } = gateWrittenTree({ repoRoot: REPO_ROOT, force: args.force, branch, previousRef, snapshot, run });
  if (!proceed) {
    if (args.report) {
      const refusal: PublishRefusal = {
        gate: "real-data-suites",
        summary: suiteSummaryLine(suites),
        failures: suites.failures,
        refused_at: new Date().toISOString()
      };
      const recorded = recordRefusalInReport(path.resolve(args.report), args.input, refusal);
      console.error(
        recorded
          ? `Recorded the refusal (${suites.failures.length} failing assertion(s)) on ${args.report}.`
          : `No row for ${path.basename(args.input)} in ${args.report} — refusal not recorded.`
      );
    }
    process.exitCode = 1;
    return;
  }

  // Step 3b — commit, prove it is only the publish, push, PR (foray-nightly.md step 7).
  commitPublish(run, write.files, `Generated Foray: ${input.title} (${input.id})`);
  run("git", ["push", "-u", "origin", "HEAD"]);

  const prUrl = run("gh", [
    "pr",
    "create",
    "--base",
    "main",
    "--title",
    `Generated Foray: ${input.title}`,
    "--body",
    publishPrBody(input, gate, suites, input.meta?.veracity, write)
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
      published_at: new Date().toISOString(),
      suites: { ok: suites.ok, summary: suiteSummaryLine(suites), failures: suites.failures }
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
