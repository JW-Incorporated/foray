import fs from "node:fs";
import path from "node:path";
import type { MintedSegmentSource } from "./audioSourceLookup";
import type { ForayItem } from "./forayItems";
import type { NewSegment } from "../types/tapeSourcing";
import { StageTimingLog, type StageTiming } from "./stageTiming";
import type { VeracityMetrics } from "./veracityMetrics";
import { mintedWhyErrors } from "./mintedSegmentCopy";

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

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

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
  /** WS-B (docs/curation/generation-fix-plan-2026-09-09.md): the
   * candidate's own veracity numbers, computed by `runPipeline.ts` (see
   * `veracityMetrics.ts`) BEFORE this stage runs. Not read by
   * `finalizeForay` itself — `check-forays.mjs`/`check-narration.mjs`
   * neither know nor care about it — and not written into `forayRecord`
   * (the published `data/forays.json` schema is out of this stage's
   * scope to extend). It rides along on `FinalizeForayInput` purely so
   * `generateForays.ts` writes it into the candidate JSON on disk
   * ("`meta.veracity` on every candidate") and `publishForay.ts` can read
   * it back to gate the PR. */
  meta?: { veracity: VeracityMetrics };
  /**
   * The segments §4.5 tier 2 MINTED for this Foray, and the source rows that
   * make them playable (`sourceBeats.ts`, `audioSourceLookup.ts`).
   *
   * WHY THE CANDIDATE HAS TO CARRY THEM. A tier-2 pointer names a segment that
   * is not in `data/segments.json` yet — it was cut from a transcript this run,
   * and the merge path that would write it (`tools/segments/merge-segments.mjs`)
   * runs on a curator's batch, not inside a generation run. `check-forays.mjs`
   * resolves every item against the pool it is given, so without these the
   * checker calls the item an "unknown segment_id", drops it before every
   * ordering rule, counts its seconds nowhere, and the Foray fails §4.9 — which
   * is what would have happened to the first Foray this pipeline sourced any
   * tier-2 tape for. `finalizeForay` therefore merges them into the pool and the
   * registry it hands the checker, and `publishForay.ts` writes them to
   * `data/segments.json` and `data/segment-sources.json` alongside
   * `data/forays.json`, so the published Foray resolves for everyone else too.
   *
   * They are NOT written by this module (it writes nothing) and the merge is
   * in-memory only, exactly like the candidate Foray itself.
   */
  segments?: NewSegment[];
  segmentSources?: MintedSegmentSource[];
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

/** What `mintedSegmentRow` needs beyond the segment itself — see its doc
 * comment for where each comes from. */
export interface MintedRowContext {
  /** The pool's `batch_id`: `generation-<foray id>`. The publish is the batch. */
  batchId: string;
  /** The registry rows minted alongside the segments (`audioSourceLookup.ts`);
   * the DAI verdict is read from the row whose `id` is the segment's `item_id`. */
  sources: ReadonlyArray<Pick<MintedSegmentSource, "id" | "dai_suspected">>;
}

/** The batch id every row minted for one Foray carries. One place, so the
 * publish CLI, the runtime pool and the finalize merge agree by construction. */
export function generationBatchId(forayId: string): string {
  return `generation-${forayId}`;
}

/**
 * One minted tier-2 segment in `data/segments.json`'s own field names — every
 * field `tools/segments/merge-segments.mjs --check` (the pool's CI gate)
 * requires, or a thrown Error naming the one it cannot fill (F-78: the first
 * generated Foray's ten rows lacked four of them and a person typed them in).
 *
 * WHERE EACH FIELD COMES FROM, so nobody reads a value as a guess:
 *   - `topic` is the FORAY's resolved node, which is not a guess: §4.5's topic
 *     gate only admitted this episode because it shares that node's lineage.
 *   - `why` is the beat's claim, clamped to the pool's 18-word note at mint
 *     time (`sourceBeats.ts` → `mintedSegmentCopy.ts`). It is checked here
 *     against the SAME copy rules the gate applies, and a row that would fail
 *     the gate is refused here, before anything is written.
 *   - `transcript_source` is what the cue provider read the anchors from
 *     (`publisher` for the archive body, `asr-local` for one this machine
 *     transcribed) — carried on the segment from the mint.
 *   - `dai_suspected` is the episode's audio-source verdict, read from the
 *     `MintedSegmentSource` row minted for this `item_id` and NEVER defaulted:
 *     a missing verdict is a thrown Error, because `false` is exactly the value
 *     the gate exists to reject ("a missing verdict would waive the anchor
 *     rule") and ADR-0007 gates seek precision on it.
 *   - `batch_id` is the publish's (`generationBatchId`).
 *   - `needs_review: true` — a machine cut this, nobody has listened yet.
 */
export function mintedSegmentRow(segment: NewSegment, topic: string, ctx: MintedRowContext): Record<string, unknown> {
  const source = ctx.sources.find((s) => s.id === segment.itemId);
  if (!source || typeof source.dai_suspected !== "boolean") {
    throw new Error(
      `mintedSegmentRow: segment "${segment.id}" has no minted source row for item "${segment.itemId}" carrying a boolean ` +
        "dai_suspected — the pool gate requires the verdict and this pipeline never defaults it (audioSourceLookup.ts)"
    );
  }
  const whyErrors = mintedWhyErrors(segment.id, segment.why);
  if (whyErrors.length > 0) {
    throw new Error(`mintedSegmentRow: the pool gate would refuse this row's why — ${whyErrors.join("; ")}`);
  }
  if (!ctx.batchId || ctx.batchId.trim().length === 0) {
    throw new Error(`mintedSegmentRow: segment "${segment.id}" needs a non-empty batch_id`);
  }
  return {
    id: segment.id,
    item_id: segment.itemId,
    topic,
    start_sec: segment.startSec,
    end_sec: segment.endSec,
    reference_duration_sec: segment.referenceDurationSec,
    start_anchor: segment.startAnchor,
    end_anchor: segment.endAnchor,
    why: segment.why,
    confidence: segment.confidence,
    transcript_source: segment.transcriptSource,
    dai_suspected: source.dai_suspected,
    source: "generation-tier-2",
    batch_id: ctx.batchId,
    needs_review: true
  };
}

/** Loads the four files `check-forays.mjs` validates against, with this
 * candidate Foray substituted/appended for `forays` and this run's minted
 * tier-2 segments/sources merged into the pool and the registry — never written
 * to disk, so a failing validation leaves every data file untouched.
 *
 * Exported so a test can assert the merge without loading the `.mjs` checkers,
 * which a Vitest run on a path containing a space cannot do (see
 * `RunPipelineDeps.finalize`). */
export function buildCandidateFiles(
  candidateRecord: Record<string, unknown>,
  root: string,
  minted: { segments?: NewSegment[]; sources?: MintedSegmentSource[]; topic: string } = { topic: "" }
): { forays: unknown; segments: unknown; sources: unknown; taxonomy: unknown } {
  const readJson = (rel: string): unknown => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
  const live = readJson("data/forays.json") as { forays: unknown[] };
  const existingIds = new Set((live.forays as Array<{ id?: unknown }>).map((f) => f.id));
  if (existingIds.has(candidateRecord.id)) {
    throw new Error(`finalizeForay: a Foray with id "${String(candidateRecord.id)}" already exists in data/forays.json — choose a new id or supersede it explicitly (see grilling-history-1's own superseded_by/superseded_note pattern)`);
  }

  const pool = readJson("data/segments.json") as { segments?: unknown[] };
  const registry = readJson("data/segment-sources.json") as { sources?: unknown[] };
  /* A minted id that somehow already exists on disk is the committed row's, not
     this run's: the pool is the authority for a segment that has been merged. */
  const poolIds = new Set((pool.segments ?? []).map((s) => (s as { id?: unknown }).id));
  const registryIds = new Set((registry.sources ?? []).map((s) => (s as { id?: unknown }).id));
  const rowContext: MintedRowContext = {
    batchId: generationBatchId(String(candidateRecord.id)),
    sources: minted.sources ?? []
  };

  return {
    forays: { ...live, forays: [...live.forays, candidateRecord] },
    segments: {
      ...pool,
      segments: [
        ...(pool.segments ?? []),
        ...(minted.segments ?? []).filter((s) => !poolIds.has(s.id)).map((s) => mintedSegmentRow(s, minted.topic, rowContext))
      ]
    },
    sources: {
      ...registry,
      sources: [...(registry.sources ?? []), ...(minted.sources ?? []).filter((s) => !registryIds.has(s.id))]
    },
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
    const files = buildCandidateFiles(candidateRecord, root, {
      segments: input.segments,
      sources: input.segmentSources,
      topic: input.topic
    });
    return mod.checkForays(files);
  });

  const checkNarrationResult = await timings.run("check-narration", async () => {
    const mod = (await import("../../../tools/foray/check-narration.mjs")) as unknown as {
      checkNarration: (root: string) => { errors: string[]; warnings: string[] };
    };
    // See module doc comment: this validates whatever curation artifacts
    // already exist on disk, not this candidate Foray's own content —
    // there is no per-Foray input to pass it, by design of that file.
    //
    // F-51 CHECKED AND LEFT ALONE. A narration page kept with
    // `verified: false` (writeNarration.ts's no-longer-fatal third
    // rejection) passes both checkers untouched: this one never sees the
    // candidate at all, `check-forays.mjs` reads no such field, and
    // `forayItems.ts` does not emit one into a published item. So the only
    // thing between an unverified page and a listener is the veracity gate
    // (`evaluateVeracityGate`, which refuses on `unverifiedPages > 0`) —
    // which is where F-51 deliberately put the decision. Teaching a
    // checker about `verified` would move that decision back into a gate
    // that cannot see the metric.
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
