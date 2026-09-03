import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ForayItem } from "./forayItems";
import { StageTimingLog, type StageTiming } from "./stageTiming";

/**
 * §4.9 — Finalize and publish (docs/curation/generation-architecture.md
 * §4.9): "Validate against check-forays.mjs and check-narration.mjs.
 * Write data/forays.json. In phase 1 this is a PR a founder reviews."
 *
 * THIS MODULE'S JOB, AND ONLY THIS JOB: take §4.8's `ForayItem[]`
 * (`stitchForay.ts`'s output, already mapped to the `data/forays.json`
 * item shape by `forayItems.ts`) plus the handful of Foray-level fields
 * §4.9 has to originate itself (id, title, topic, summary, slots — none
 * of which any earlier stage produces), run it through the EXISTING
 * validators, and — only if they are clean — return the exact
 * `data/forays.json` document a caller should write. This module never
 * writes the file itself and never touches git/GitHub: see
 * `backend/src/cli/publishForay.ts` for the CLI that does both of those,
 * matching this repo's own "PR a founder reviews" pattern (§4.9's task
 * brief: "wire this pipeline's output into the SAME PR-creation pattern
 * the rest of this repo's automated workflows already use" — see
 * `docs/agents/runner-prompts/foray-nightly.md` step 7 for that pattern).
 *
 * WHY NOT REIMPLEMENT VALIDATION: `tools/foray/check-forays.mjs` and
 * `tools/foray/check-narration.mjs` are the ONLY things CI runs against
 * `data/forays.json` (`tools/foray/check-forays.test.mjs`) and this is
 * deliberate — a second, backend-side copy of D1/D5/L2/L3/mode-band
 * checking would drift from the CI gate the moment either changed, and
 * a PR that "passed" this module's own rules but failed the CI gate
 * would be a worse failure mode than not validating locally at all. So
 * both are imported and called as-is (dynamic `import()`, matching the
 * precedent in `backend/test/writeNarration.test.ts`'s disclosure
 * round-trip test — `tools/` has no build step and is loaded straight
 * from the checkout).
 *
 * CHECK-NARRATION.MJS'S ACTUAL SCOPE, HONESTLY STATED: that validator
 * gates the curation-authored artifacts under
 * `docs/curation/narration/<foray_id>/{arc,threads/,beats/}` — see its
 * own header. The automated §4 pipeline (this stage's own upstream,
 * §4.0-4.8) never writes those files; `writeNarration.ts` produces
 * `WrittenAct[]` in memory and hands it straight to `stitchForay.ts`,
 * which maps it directly into `ForayItem[]`. So calling `checkNarration()`
 * here validates whatever OTHER Forays' curation artifacts already exist
 * on disk (today: none fail, `alcohol-forms-1` is a proposed/gated draft
 * per its own arc.json) — it is NOT, and structurally cannot be, a check
 * of THIS Foray's own narration content, because this Foray has no
 * `docs/curation/narration/<id>/` directory to check. This is exactly
 * what the task brief asks for ("do not reimplement... this stage calls
 * into it") applied honestly: the call happens, its result is surfaced,
 * and this comment says plainly what it can and cannot prove about the
 * Foray being published — rather than silently implying it audited
 * narration content it never touched.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface ForaySlot {
  id: string;
  title: string;
}

/** The Foray-level fields §4.9 originates — everything upstream of this
 * stage produces `items`/`slots` inputs (`ForayItem[]`, act titles) but
 * none of the pipeline's earlier stages own a Foray `id`, `topic` (a
 * `data/taxonomy.json` node) or public `summary`; §4.0-4.1's own
 * `GenerationRequest` carries the free-text prompt, not these. */
export interface FinalizeForayInput {
  id: string;
  title: string;
  topic: string;
  summary: string;
  slots: ForaySlot[];
  items: ForayItem[];
  runtimeSec: number;
  /** ISO date string. Defaults to "now" if omitted. */
  builtAt?: string;
}

export interface FinalizeForayValidation {
  ok: boolean;
  checkForaysErrors: string[];
  checkForaysWarnings: string[];
  checkNarrationErrors: string[];
  checkNarrationWarnings: string[];
}

export interface FinalizeForayResult {
  validation: FinalizeForayValidation;
  /** Present only when `validation.ok` — the exact `forays` array entry
   * to append to `data/forays.json`, per §4.9 rule 2 ("in the exact
   * existing schema/format"). */
  forayRecord?: Record<string, unknown>;
  timings: StageTiming[];
}

/** Builds the exact `data/forays.json`-shaped record for one Foray. Sets
 * `generated: true` — the ONE bit `check-forays.mjs` gates its
 * generated-Foray-only checks on (disclosure-as-items[0], mandatory
 * `mode` on every narration item — see that file's own `isGeneratedForay`
 * doc comment: "the day the pipeline in §4 lands, its publish step
 * (§4.9) is what sets this bit, on purpose, once.") This is that line. */
function buildForayRecord(input: FinalizeForayInput): Record<string, unknown> {
  return {
    id: input.id,
    kind: "deep-dive",
    title: input.title,
    topic: input.topic,
    status: "draft",
    summary: input.summary,
    runtime_sec: input.runtimeSec,
    generated: true,
    slots: input.slots,
    items: input.items
  };
}

/** Loads the four files `check-forays.mjs` validates against, with this
 * candidate Foray substituted/appended for `forays` — never written to
 * disk, so a failing validation leaves `data/forays.json` untouched. */
function loadCandidateFiles(candidateRecord: Record<string, unknown>, root: string): { forays: unknown; segments: unknown; sources: unknown; taxonomy: unknown } {
  const readJson = (rel: string): unknown => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
  const live = readJson("data/forays.json") as { forays: unknown[] };
  const existingIds = new Set((live.forays as Array<{ id?: unknown }>).map((f) => f.id));
  if (existingIds.has(candidateRecord.id)) {
    throw new Error(`finalizeForay: a Foray with id "${String(candidateRecord.id)}" already exists in data/forays.json — choose a new id or supersede it explicitly (see grilling-history-1's own superseded_by/superseded_note pattern)`);
  }
  return {
    forays: { ...live, forays: [...live.forays, candidateRecord] },
    segments: readJson("data/segments.json"),
    sources: readJson("data/segment-sources.json"),
    taxonomy: fs.existsSync(path.join(root, "data/taxonomy.json")) ? readJson("data/taxonomy.json") : null
  };
}

/**
 * §4.9's finalize step. Validates a candidate Foray against BOTH
 * existing validators and returns either the writable record (on a
 * clean pass) or the exact errors/warnings a caller should surface —
 * never writes any file itself (see module doc comment).
 */
export async function finalizeForay(input: FinalizeForayInput, root: string = REPO_ROOT): Promise<FinalizeForayResult> {
  const timings = new StageTimingLog();
  const candidateRecord = await timings.run("build-record", () => buildForayRecord(input));

  const checkForaysResult = await timings.run("check-forays", async () => {
    const mod = (await import("../../../tools/foray/check-forays.mjs")) as unknown as {
      checkForays: (files: unknown) => { errors: string[]; warnings: string[] };
    };
    const files = loadCandidateFiles(candidateRecord, root);
    return mod.checkForays(files);
  });

  const checkNarrationResult = await timings.run("check-narration", async () => {
    const mod = (await import("../../../tools/foray/check-narration.mjs")) as unknown as {
      checkNarration: (root: string) => { errors: string[]; warnings: string[] };
    };
    // See module doc comment: this validates whatever curation artifacts
    // already exist on disk, not this candidate Foray's own content —
    // there is no per-Foray input to pass it, by design of that file.
    return mod.checkNarration(root);
  });

  const validation: FinalizeForayValidation = {
    ok: checkForaysResult.errors.length === 0 && checkNarrationResult.errors.length === 0,
    checkForaysErrors: checkForaysResult.errors,
    checkForaysWarnings: checkForaysResult.warnings,
    checkNarrationErrors: checkNarrationResult.errors,
    checkNarrationWarnings: checkNarrationResult.warnings
  };

  return {
    validation,
    forayRecord: validation.ok ? candidateRecord : undefined,
    timings: timings.all()
  };
}
