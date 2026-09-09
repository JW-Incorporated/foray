import { z } from "zod";
import { GenerationRequestSchema, IntentUnderstandingSchema, SAFETY_CATEGORIES, type GenerationRequest, type UnderstandPromptResult } from "../types/generation";
import { StageTimingLog, type StageTiming } from "./stageTiming";
import { BudgetStopError, EpisodeBudgetExceededError, findBudgetError } from "../cost/budgetGuard";
import { CheckpointSession, checkpointFingerprint, type CheckpointStore } from "./checkpoint";
import { DeepenedActSchema, SpineSchema } from "../types/spine";
import { NewSegmentSchema, SourcedActSchema, TapePointerSchema, TranscriptionQueueCandidateSchema } from "../types/tapeSourcing";
import { ResearchShapeSchema } from "../types/research";
import { ForayItemSchema } from "./forayItems";
import { NarratedBeatSchema } from "../types/narration";

import { understandPrompt } from "./understandPrompt";
import { buildResearchShape } from "./researchShape";
import { buildSpine } from "./buildSpine";
import { deepenActs } from "./deepenActs";
import { sourceBeats, summarizeSourcing } from "./sourceBeats";
import { createDigestAudioSourceResolver, type AudioSourceResolver } from "./audioSourceLookup";
import { writeNarration } from "./writeNarration";
import { stitchForay } from "./stitchForay";
import { finalizeForay, mintedSegmentRow, type FinalizeForayInput, type FinalizeForayResult, type ForaySlot } from "./finalizeForay";
import { resolveTopic, forayIdFor, type TopicCandidate } from "./resolveTopic";
import { slugifySlotTitle } from "./forayItems";
import { loadSegmentPool, type SegmentRecord } from "./segmentPoolLookup";
import { NARRATION_CHARS_PER_SEC } from "../types/narration";
import { disclosureTemplate } from "../types/narration";
import { buildPartialCandidate, type PartialCandidate } from "./partialCandidate";
import { resetUsageTracking, getUsageTotals } from "./usageTracking";
import { buildVeracityMetrics } from "./veracityMetrics";

import { createPromptUnderstander } from "./createPromptUnderstander";
import { createExternalResearcher } from "./createExternalResearcher";
import { createSpineBuilder } from "./createSpineBuilder";
import { createDeepenActBuilder } from "./createDeepenActBuilder";
import { createNarrationWriterBuilder } from "./createNarrationWriterBuilder";
import { createNarrationVerifierBuilder } from "./createNarrationVerifierBuilder";
import { createContinuityBuilder } from "./createContinuityBuilder";

import type { PromptUnderstander } from "./PromptUnderstander";
import type { ExternalResearcher } from "./ExternalResearcher";
import type { SpineBuilder } from "./SpineBuilder";
import type { DeepenActBuilder } from "./DeepenActBuilder";
import type { NarrationWriterBuilder } from "./NarrationWriterBuilder";
import type { NarrationVerifierBuilder } from "./NarrationVerifierBuilder";
import type { ContinuityBuilder } from "./ContinuityBuilder";
import type { WrittenAct, WrittenSlot } from "./writeNarration";
import type { TranscriptCueProvider } from "./transcriptArchiveLookup";
import type { TranscriptTextIndex } from "./transcriptTextIndex";
import type { TapeRelevanceInput } from "../types/tapeSourcing";
import type { Spine } from "../types/spine";
import type { ForayItem } from "./forayItems";

/**
 * §4.0 -> §4.9 in one call.
 *
 * WHAT THIS CLOSES. `docs/curation/generation-pipeline-status.md` states it
 * outright: "There is currently **no single CLI or script that drives all nine
 * stages end to end.**" Every stage existed, tested, with each one's output
 * typed as the next one's input — and the connective tissue between them was a
 * founder, by hand, moving JSON between two CLIs that meet at opposite ends of
 * the pipeline (`generateForay.ts` stops at "understood"; `publishForay.ts`
 * starts at a finished stitch result). That is workable for one Foray and it is
 * the entire reason there are four in `data/forays.json` rather than four
 * hundred.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It is a batch chain, not §6's progressive
 * generation: every stage completes before the next begins, nothing plays while
 * a later act is still being written. §6 remains unbuilt and this module does
 * not pretend otherwise — see the status doc's §6 section, which argues that
 * building the monitoring plumbing for a live system that does not exist is the
 * wrong thing to build. When progressive generation lands, this function is the
 * thing it replaces, and `StageTimingLog` will already have real per-stage
 * numbers from batch runs to size the generation lead against.
 *
 * EVERY DEPENDENCY IS INJECTABLE, and the defaults are the `create*()`
 * factories, which each return a Stub when `ANTHROPIC_API_KEY` is absent and an
 * Anthropic-backed builder when it is present (`env.anthropicDryRun`). So this
 * same function is what tests drive with stubs at zero cost and what a real run
 * drives with a key — one code path, not two, which is the only way the tested
 * thing and the shipped thing stay the same thing.
 *
 * COST. Every Anthropic builder meters itself through `defaultBudgetGuard`
 * before it calls out, so a run that exceeds the per-Foray ceiling stops inside
 * the stage that crossed it rather than here. This module adds no second
 * budget: two budget checks that can disagree is worse than one.
 */

export interface RunPipelineDeps {
  understander?: PromptUnderstander;
  researcher?: ExternalResearcher;
  spineBuilder?: SpineBuilder;
  deepenBuilder?: DeepenActBuilder;
  narrationWriter?: NarrationWriterBuilder;
  narrationVerifier?: NarrationVerifierBuilder;
  continuityBuilder?: ContinuityBuilder;
  /** §4.5 tier-2: supplies real cue text so a beat can be anchored to tape. */
  cueProvider?: TranscriptCueProvider;
  /** §4.5 tier-2: the candidate search over transcript TEXT (WS-H, F-06).
   * Omitted, tier 2 keeps to the title-metadata path — see
   * `SourceBeatsOptions.textIndex`. */
  textIndex?: TranscriptTextIndex;
  /** §4.5 tier-2: resolves the `data/segment-sources.json` row that makes a
   * minted segment playable. Defaults to the real catalogue-reading resolver;
   * injectable so a test can exercise the refusal path without a checkout. */
  audioSourceFor?: AudioSourceResolver;
  /**
   * §4.9's validate step. Defaults to the real `finalizeForay`, which runs the
   * candidate through `tools/foray/check-forays.mjs` and `check-narration.mjs`
   * — the same scripts CI runs, never a reimplementation.
   *
   * INJECTABLE FOR ONE HONEST REASON, stated so nobody mistakes it for a
   * general escape hatch: those two are `.mjs` build scripts loaded by dynamic
   * import, and Vitest re-resolves that import through its own loader, which
   * percent-encodes a space in the checkout path (`Vibe%20Coding`) and then
   * cannot find the file. `finalizeForay.test.ts` therefore fails all five of
   * its cases on a Windows checkout under a path with a space in it, and passes
   * on CI's Linux runner. That is a pre-existing test-runner defect, not a
   * defect in §4.9, and it is not this stage's to fix — but without a seam it
   * would make the orchestrator untestable on the founders' own machines too.
   *
   * The real implementation is the default, so a production run and a CI run
   * both exercise the true checkers. Tests that inject a fake here are testing
   * THIS module's chaining and mapping, and say so; the one test that exercises
   * the real validator is skipped where the environment cannot load it, with the
   * reason named rather than the failure hidden.
   */
  finalize?: (input: FinalizeForayInput, root?: string) => Promise<FinalizeForayResult>;
  /**
   * WS-D2 (docs/curation/generation-fix-plan-2026-09-09.md, "D2 (streaming
   * publish)"): "If the runPipeline stage structure makes act-by-act
   * emission require a callback (`onActReady`), add it as an optional
   * dependency in `runForayPipeline`'s deps object and keep all existing
   * call sites working." This is that callback — optional, so every
   * existing caller (the batch CLI's earlier tests, `publishForay.ts`'s own
   * input shape) is unaffected by its absence.
   *
   * Fired once per act, the instant that act's items are stitched and
   * coverage-validated (`stitchForay.ts`'s own `onActReady`), with a
   * complete, listener-ready `PartialCandidate` — disclosure item
   * prepended, `visibility: "private"`, `acts[]` marked `"ready"` through
   * this act and `"pending"` after it. `generateForays.ts` is the one
   * caller today: it writes/rewrites the partial file on every act.
   */
  onActReady?: (candidate: PartialCandidate) => void | Promise<void>;
  /**
   * Per-stage resume (F-17/F-18). Omit it and the pipeline behaves exactly as
   * it did before checkpoints existed: nothing is written, nothing is skipped.
   * Supply it (with `options.checkpointKey`) and every stage's output is
   * persisted the moment it exists, so a re-run of the same request pays only
   * for the stages that had not finished.
   *
   * See `checkpoint.ts` for what run 1 lost without this: 2 h 35 m, 103 model
   * calls and 22 of 31 finished beats, discarded because beat 23 failed.
   */
  checkpoint?: CheckpointStore;
}

export interface RunPipelineOptions {
  userId: string;
  sessionId?: string;
  /**
   * Overrides topic resolution. Supply it when a human has already ruled on the
   * taxonomy node; leave it out and `resolveTopic` derives one or the run stops.
   */
  topic?: string;
  /** Injected in tests so a run is reproducible; defaults to now. */
  now?: () => Date;
  /** Repo root, for the taxonomy and validation file reads. */
  root?: string;
  /**
   * Names this Foray's checkpoint (F-17/F-18) — the batch driver passes the
   * candidate file's basename, so the checkpoint sits beside the candidate the
   * same prompt will eventually produce. Without it, `deps.checkpoint` is
   * ignored: a checkpoint with no key would be a checkpoint shared by every
   * prompt in the batch.
   */
  checkpointKey?: string;
}

export type RunPipelineOutcome =
  /** §4.0 safety refused the prompt. */
  | { outcome: "rejected"; category: string; explanation: string; timings: StageTiming[] }
  /** §4.1 could not read the prompt one way; a human has to disambiguate. */
  | { outcome: "needs-clarification"; question: string; readings: string[]; timings: StageTiming[] }
  /** The pipeline ran but no taxonomy node could be resolved — nothing is published. */
  | { outcome: "unresolved-topic"; title: string; candidates: TopicCandidate[]; timings: StageTiming[] }
  /** A Foray was built. `validation.ok` says whether it may be published. */
  | {
      outcome: "generated";
      input: FinalizeForayInput;
      result: FinalizeForayResult;
      spine: Spine;
      /** WS-C: one row per tape-sourced beat, carrying the topic gate's own
       * verdict on the anchor it took (see `TapeRelevanceInput`). Surfaced here
       * because §4.5 is the only stage that knows all of it at once, and
       * because WS-B's `tapeRelevance` metric otherwise has to re-derive the
       * join from disk — and can only do so for anchors that resolve against
       * `data/segment-sources.json`, which a freshly minted tier-2 segment need
       * not. */
      tapeRelevance: TapeRelevanceInput[];
      timings: StageTiming[];
      /** WS-D2: prompt received -> Act 1 ready, in milliseconds. `null` only
       * when `deps.onActReady` was never supplied (no act-boundary clock was
       * ever read) — see `report.json`'s own `ttlA1Ms` field, which is where
       * `generateForays.ts` surfaces this per §4.9/D2's "measure it and
       * print ttlA1Ms in the report." */
      ttlA1Ms: number | null;
    };

/** The Foray-level `slots` record: §4.9 wants `{id, title}` per act slot. */
export function slotsFromSpine(spine: Spine): ForaySlot[] {
  const slots: ForaySlot[] = [];
  const seen = new Set<string>();
  for (const act of spine.acts) {
    for (const slot of act.slots) {
      const id = slugifySlotTitle(slot.title);
      /* Two acts may legitimately name a slot the same thing; the id must still
         be unique because check-forays joins items to slots by it. A numeric
         suffix keeps the first occurrence's id stable, which matters because a
         re-run that adds a later duplicate must not renumber the earlier one. */
      let unique = id;
      let n = 2;
      while (seen.has(unique)) unique = `${id}-${n++}`;
      seen.add(unique);
      slots.push({ id: unique, title: slot.title });
    }
  }
  return slots;
}

/** A jingle's fixed length, mirroring `player/foray-queue.js`'s own constant. */
export const JINGLE_DURATION_SEC = 1.5;

/**
 * The Foray's runtime on the LISTENER'S clock, which is what `runtime_sec`
 * means and what `check-forays.mjs` recomputes and compares against.
 *
 * A `ForayItem` deliberately carries no duration: `forayItems.ts` strips
 * `startSec`/`endSec` off a tape item on the way out, because `data/forays.json`
 * references a segment rather than restating it. So the length of a tape item
 * has to be resolved from `data/segments.json`, exactly as the checker resolves
 * it — a first attempt that read `duration_sec` straight off the items summed
 * every Foray to zero, and the checker said so on all three prompts of the first
 * end-to-end run.
 *
 * Narration is estimated at the one shared rate (`NARRATION_CHARS_PER_SEC`,
 * which `player/foray-queue.js`, `check-forays.mjs` and `forayItems.ts` all
 * already derive from) rather than a second constant that could drift. The
 * agreement between this function and the checker is pinned by a test rather
 * than asserted here — a runtime that disagrees by more than half a second is
 * a publish-blocking error, so the two must not be allowed to drift quietly.
 */
export function runtimeSecFor(items: ForayItem[], pool: SegmentRecord[] = loadSegmentPool()): number {
  const byId = new Map(pool.map((s) => [s.id, s]));
  let total = 0;
  for (const item of items) {
    const rec = item as unknown as Record<string, unknown>;
    if (rec.type === "segment") {
      const seg = byId.get(String(rec.segment_id));
      /* An unresolvable segment contributes nothing here. It is not this
         function's job to report it — `check-forays.mjs` fails the Foray on the
         missing reference itself, with a better message than a runtime
         mismatch would give. */
      if (seg && Number.isFinite(seg.end_sec) && Number.isFinite(seg.start_sec) && seg.end_sec > seg.start_sec) {
        total += seg.end_sec - seg.start_sec;
      }
      continue;
    }
    if (rec.type === "jingle") {
      total += JINGLE_DURATION_SEC;
      continue;
    }
    const script = typeof rec.script === "string" ? rec.script.trim() : "";
    if (script.length > 0) total += Math.round((script.length / NARRATION_CHARS_PER_SEC) * 1000) / 1000;
  }
  return Math.round(total * 1000) / 1000;
}

/**
 * §4.7's disclosure, as the `items[0]` `check-forays.mjs` demands.
 *
 * "A generated Foray whose first item is not the disclosure fails validation.
 * It should be impossible to publish without it." Nothing in §4.0-§4.8 produces
 * it — the stitch stage assembles what the acts contain, and the disclosure is
 * not part of any act — so the orchestrator is the first place that can put it
 * there, and the first end-to-end run proved it: every candidate came back
 * INVALID on exactly this rule.
 *
 * It carries a `slot`, and must: an item that opens a Foray has no preceding
 * item to inherit one from, and check-forays rejects that case explicitly.
 */
export function disclosureItem(subject: string, firstSlotId: string): ForayItem {
  return {
    type: "narration",
    id: "disclosure",
    script: disclosureTemplate(subject),
    mode: "marker",
    slot: firstSlotId
  } as ForayItem;
}

/** How many of `slotsFromSpine(spine)`'s flattened slots belong to acts
 * `0..actIndex` inclusive. `slotsFromSpine` iterates acts in the same order
 * (§4.3/§6.1: the spine is frozen, acts never reorder), so a prefix count is
 * exactly that act range's own slots. Used only by WS-D2's partial-candidate
 * path — the whole-Foray path never needs a sub-range. */
function slotCountThroughAct(spine: Spine, actIndex: number): number {
  let n = 0;
  for (let i = 0; i <= actIndex; i++) n += spine.acts[i]?.slots.length ?? 0;
  return n;
}

/* ------------------------------------------------------------------------ *
 * Checkpoint schemas (F-17/F-18).
 *
 * Every stage's stored output is re-validated on the way back IN, against the
 * same schema its own type is built from wherever one exists. Two stages had
 * no schema — §4.7's `WrittenAct[]` and §4.8's stitched items are interfaces,
 * not zod types — so they get one here rather than being trusted unparsed: a
 * checkpoint file is JSON a person can edit and a killed process can truncate,
 * and an unvalidated resume turns that into a failure four stages later with
 * nothing pointing back at the file. See `CheckpointSession`.
 * ------------------------------------------------------------------------ */

const UnderstandCheckpointSchema = z.union([
  z.object({
    outcome: z.literal("rejected"),
    rejection: z.object({ category: z.enum(SAFETY_CATEGORIES), explanation: z.string() })
  }),
  z.object({
    outcome: z.literal("needs_clarification"),
    clarification: z.object({ question: z.string(), readings: z.array(z.string()) })
  }),
  z.object({ outcome: z.literal("understood"), intent: IntentUnderstandingSchema })
]);

/* Mirrors `TapeRelevanceInput` (types/tapeSourcing.ts, WS-C): the rows WS-B's
   veracity gate aggregates. Checkpointed with the stage so a resumed run
   reports the same tape-relevance evidence a fresh one would. */
const TapeRelevanceInputSchema = z.object({
  actIndex: z.number().int(),
  slotIndex: z.number().int(),
  beatIndex: z.number().int(),
  claim: z.string(),
  itemId: z.string(),
  segmentId: z.string(),
  tier: z.union([z.literal(1), z.literal(2)]),
  taxonomyNodeIds: z.array(z.string()),
  families: z.array(z.string()),
  forayTopic: z.string().nullable(),
  forayFamily: z.string().nullable(),
  onTopic: z.boolean().nullable(),
  /* WS-L (F-63): the episode §4.3 seeded the beat from, and whether that seed's
     window is the tape the beat took. Optional so a checkpoint written before
     WS-L still resumes. */
  seededEpisode: z.string().nullable().optional(),
  seedWindowWon: z.boolean().optional()
});

/* Mirrors `SourcingTrace` (types/tapeSourcing.ts, F-49): why each narrated beat
   got no tape. Checkpointed with the stage for the same reason `tapeRelevance`
   is — a resumed run must be able to say what the search saw, or the evidence
   the thresholds are tuned against disappears on the first resume. */
const SourcingTraceSchema = z.object({
  actIndex: z.number().int(),
  slotIndex: z.number().int(),
  beatIndex: z.number().int(),
  claim: z.string(),
  outcome: z.enum(["skipped:argument", "no-tape"]),
  tier1: z
    .object({
      bestSegmentId: z.string().nullable(),
      bestItemId: z.string().nullable(),
      score: z.number(),
      requiredScore: z.number(),
      matchedIn: z.enum(["transcript", "metadata"]).nullable(),
      gate: z.enum(["no-candidates", "threshold", "topic-lineage", "exhausted", "m4-share", "m3-order"])
    })
    .nullable(),
  tier2: z
    .object({
      bestShowId: z.string().nullable(),
      bestEpisodeTitle: z.string().nullable(),
      score: z.number(),
      requiredScore: z.number(),
      gate: z.enum(["text-index:no-candidate", "title-tokens", "lineage", "no-body", "no-anchor", "window-overlap", "no-audio-source"]),
      /* F-61: the window search's own numbers, and the anchors minted from the
         tape. Optional, like the WS-H fields below, so a checkpoint written
         before this change still parses on resume. */
      windowMatchedTerms: z.array(z.string()).optional(),
      windowDistinctiveTerms: z.array(z.string()).optional(),
      windowTermShare: z.number().optional(),
      windowWeightedShare: z.number().optional(),
      windowStartSec: z.number().optional(),
      windowEndSec: z.number().optional(),
      startAnchor: z.string().optional(),
      endAnchor: z.string().optional(),
      /* WS-H: what tier 2's text search saw (`types/tapeSourcing.ts`). Optional
         so a checkpoint written before WS-H still parses on resume. */
      foundBy: z.enum(["text-index", "title"]).optional(),
      textScore: z.number().optional(),
      textRank: z.number().optional(),
      textMatchedTerms: z.number().optional(),
      candidatesConsidered: z.number().optional(),
      /* WS-L: the seed a narrated beat carried, and the standing answer for a
         row in this array — the seed's window did not win. */
      seededEpisode: z.string().optional(),
      seedWindowWon: z.boolean().optional()
    })
    .nullable()
});

/* The `data/segment-sources.json` row for each minted segment's episode
   (`audioSourceLookup.ts`). Without it the checker cannot resolve the audio. */
const MintedSegmentSourceSchema = z.object({
  id: z.string(),
  show: z.string(),
  title: z.string(),
  feed_url: z.string().nullable(),
  episode_guid: z.string(),
  audio_url: z.string(),
  audio_type: z.string(),
  duration_sec: z.number(),
  dai_suspected: z.boolean(),
  source: z.literal("generation-tier-2")
});

const SourceCheckpointSchema = z.object({
  acts: z.array(SourcedActSchema),
  newSegments: z.array(NewSegmentSchema),
  transcriptionQueueCandidates: z.array(TranscriptionQueueCandidateSchema),
  tapeRelevance: z.array(TapeRelevanceInputSchema),
  /* Defaulted, not required: a checkpoint written before these fields existed
     still resumes, and resumes to the same Foray it would have produced. */
  sourcingTrace: z.array(SourcingTraceSchema).default([]),
  newSegmentSources: z.array(MintedSegmentSourceSchema).default([])
});

const WrittenBeatSchema = z.union([
  z.object({
    sourcing: z.literal("tape"),
    claim: z.string(),
    exploration: z.boolean(),
    tape: TapePointerSchema,
    connectiveNarration: NarratedBeatSchema.optional()
  }),
  z.object({
    sourcing: z.literal("narration"),
    claim: z.string(),
    exploration: z.boolean(),
    narration: NarratedBeatSchema
  })
]);
const WrittenSlotSchema = z.object({ title: z.string(), beats: z.array(WrittenBeatSchema) });
const WrittenActSchema = z.object({
  title: z.string(),
  slots: z.array(WrittenSlotSchema)
});

const StitchCheckpointSchema = z.object({ items: z.array(ForayItemSchema) });

export async function runForayPipeline(
  request: GenerationRequest,
  options: RunPipelineOptions,
  deps: RunPipelineDeps = {}
): Promise<RunPipelineOutcome> {
  const req = GenerationRequestSchema.parse(request);
  const timings = new StageTimingLog();
  const now = options.now ?? (() => new Date());
  const ctx = { userId: options.userId, sessionId: options.sessionId };
  // WS-D2: prompt-received clock. `Date.now()`, not `now()` — `now()` is the
  // injected-for-determinism stamp clock (`startedAt`/`generatedAt`, and so
  // `forayIdFor`'s seed), which tests pin to a fixed instant; ttlA1Ms measures
  // real wall time, exactly like `StageTimingLog` does elsewhere in this
  // module.
  const pipelineStartMs = Date.now();

  /* F-17/F-18. `open` returns an inert session when there is no store, no key,
     or a checkpoint written for a different request — so everything below is
     one code path whether or not the caller wants resume. */
  const checkpoint = await CheckpointSession.open(
    deps.checkpoint,
    options.checkpointKey,
    checkpointFingerprint({ prompt: req.prompt, duration: req.duration, topic: options.topic })
  );
  const resumeHint = options.checkpointKey
    ? `Everything finished so far is checkpointed under "${options.checkpointKey}", so a re-run restarts at this stage.`
    : undefined;

  /**
   * The one seam every stage goes through, doing three things a bare `await`
   * cannot:
   *
   *   - RESUME. Returns the checkpointed output instead of calling the stage,
   *     and records it as resumed rather than as a stage that took 0 ms.
   *   - PERSIST. Writes the stage's output the moment it exists (F-18).
   *   - NAME THE STAGE ON A BUDGET STOP (F-04). `BudgetGuard` throws from
   *     inside a builder and knows only a tier and a dollar figure; this is
   *     the only place that also knows which stage was running and that the
   *     work so far is on disk.
   */
  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await timings.run(name, fn);
    } catch (err) {
      /* Walks `cause`, because §4.4 wraps an act's failure in its own
         `ActDeepeningError` and would otherwise bury the dollar figures. */
      const budget = findBudgetError(err);
      if (budget) {
        const scope = budget instanceof EpisodeBudgetExceededError ? "per-foray" : "daily";
        throw new BudgetStopError(name, budget.spentUsd, budget.capUsd, scope, budget, resumeHint);
      }
      throw err;
    }
  };

  const stage = async <T>(name: string, parse: (raw: unknown) => T, fn: () => Promise<T>): Promise<T> => {
    const { value, resumed } = await checkpoint.stage(name, parse, () => timed(name, fn));
    if (resumed) timings.markResumed(name);
    return value;
  };

  /* WS-B (docs/curation/generation-fix-plan-2026-09-09.md): `pipelineTokens`
     sums every Anthropic reply's `usage` across the whole run — see
     `usageTracking.ts`'s own doc comment on why this is a single
     process-wide counter and why that is only correct for ONE run at a
     time (true today: this function runs to completion before
     `generateForays.ts`'s batch loop starts the next one). Reset here,
     read after finalize below. */
  resetUsageTracking();

  const understander = deps.understander ?? createPromptUnderstander();
  const researcher = deps.researcher ?? createExternalResearcher();
  const spineBuilder = deps.spineBuilder ?? createSpineBuilder();
  const deepenBuilder = deps.deepenBuilder ?? createDeepenActBuilder();
  const narrationWriter = deps.narrationWriter ?? createNarrationWriterBuilder();
  const narrationVerifier = deps.narrationVerifier ?? createNarrationVerifierBuilder();
  const continuityBuilder = deps.continuityBuilder ?? createContinuityBuilder();
  const finalize = deps.finalize ?? finalizeForay;

  /* WS-B: `callsPerBeat` counts every §4.7 writer/verifier call, including
     rejected attempts — wrapping here (rather than instrumenting
     `AnthropicNarrationWriterBuilder`/`StubNarrationWriterBuilder`
     themselves) counts real AND stub/test builders alike with one code
     path, and survives WS-D's per-slot/per-act parallelisation
     untouched (a plain counter, no ordering assumed — contrast
     `usageTracking.ts`'s per-process caveat, which does not apply here
     since these two counters are local to this one call).

     WHAT A "CALL" MEANS NOW (WS-A). The narration stage is no longer one
     writer call per page. A slot is written in two batched calls — claim
     selection, then prose — and verified in one, whatever the page count,
     and slots within an act run in parallel. Each of those is counted ONCE
     here, because each is one request to the model, which is what
     `callsPerBeat` is measuring: the run-1 baseline of 4.2 calls per beat
     was 4.2 REQUESTS per beat, and the target of ≤1.5 is met precisely by
     serving many pages from one request. A four-page slot that passes
     first time therefore costs 2 writer calls and 1 verifier call, not 8
     and 4 — and if it did not count that way the metric would report no
     improvement from the change that produced it. Selection and prose are
     summed into the one writer counter deliberately: they are two halves
     of writing a page, and splitting them would make the number
     incomparable with run 1's. */
  let narrationWriterCalls = 0;
  let narrationVerifierCalls = 0;
  const countingNarrationWriter: NarrationWriterBuilder = {
    providerName: narrationWriter.providerName,
    selectClaims: (selectRequest, selectCtx) => {
      narrationWriterCalls++;
      return narrationWriter.selectClaims(selectRequest, selectCtx);
    },
    writePages: (writeRequest, writeCtx) => {
      narrationWriterCalls++;
      return narrationWriter.writePages(writeRequest, writeCtx);
    }
  };
  const countingNarrationVerifier: NarrationVerifierBuilder = {
    providerName: narrationVerifier.providerName,
    verifySlot: (verifyRequest, verifyCtx) => {
      narrationVerifierCalls++;
      return narrationVerifier.verifySlot(verifyRequest, verifyCtx);
    }
  };

  /* §4.0-4.1 — safety, then intent. Both non-"understood" outcomes end the run:
     a rejected prompt must not be researched, and a prompt we cannot read one
     way must not be guessed at. */
  const understood = await stage<UnderstandPromptResult>(
    "understand",
    (raw) => UnderstandCheckpointSchema.parse(raw) as UnderstandPromptResult,
    () => understandPrompt(req.prompt, understander, ctx)
  );
  if (understood.outcome === "rejected") {
    return {
      outcome: "rejected",
      category: understood.rejection.category,
      explanation: understood.rejection.explanation,
      timings: timings.all()
    };
  }
  if (understood.outcome === "needs_clarification") {
    return {
      outcome: "needs-clarification",
      question: understood.clarification.question,
      readings: understood.clarification.readings,
      timings: timings.all()
    };
  }

  const intent = understood.intent;

  /* §4.2 — research to establish shape. `topic` is left unset so the stage
     resolves one from the intent itself and keeps off-branch concepts out of
     the map (F-11); a caller who pinned the taxonomy node by hand has already
     decided, so that decision wins. */
  const researchShape = await stage(
    "research-shape",
    (raw) => ResearchShapeSchema.parse(raw),
    () =>
      buildResearchShape(intent, {
        researcher,
        ctx,
        root: options.root,
        /* WS-L (F-63): the same text index and cue provider §4.5 sources with,
           handed to §4.2 so the map carries what the tape SAYS about each
           candidate and the spine can write its beats from that rather than
           from an item count. Both default to their Null implementations, so a
           driver that wires neither gets the pre-WS-L map. */
        ...(deps.textIndex ? { textIndex: deps.textIndex } : {}),
        ...(deps.cueProvider ? { cueProvider: deps.cueProvider } : {}),
        ...(options.topic ? { topic: options.topic } : {})
      })
  );

  // §4.3 — the spine, frozen from here on (§6.1's invariant, batch-true).
  const spine = await stage(
    "spine",
    (raw) => SpineSchema.parse(raw),
    () => buildSpine(intent, researchShape, req.duration, spineBuilder, ctx)
  );

  /* THE FORAY'S TOPIC, RESOLVED HERE AND NOT AFTER NARRATION.
     It used to be resolved at the end, next to the other §4.9 fields it is
     grouped with, because nothing before §4.9 needed it. §4.5's topic gate does
     (fix plan WS-C, finding F-29): the taxonomy node is the only thing that can
     tell sourcing that a barbecue episode is not tape for an engineering-
     disasters Foray, and sourcing runs long before finalize. Resolving it here
     — the first point where both the intent and the frozen spine exist — also
     means an unresolvable topic stops the run before the two most expensive
     stages instead of after them.

     The unresolved-topic OUTCOME is unchanged: same shape, same title, same
     ranked candidates, still returned rather than guessed at, because
     `check-forays.mjs` only asks whether a node exists and never whether it is
     the right one. `generatedAt` deliberately did NOT move with it: it is the
     time the Foray was finished, and stamping it here would date every Foray
     several minutes before it existed. */
  const title = `${intent.subject}${intent.angle ? `: ${intent.angle}` : ""}`.slice(0, 120);
  const topicText = [intent.subject, intent.angle, spine.acts.map((a) => a.title).join(" ")].join(" ");
  const resolvedTopic = resolveTopic(topicText, { root: options.root });
  const topic = options.topic ?? resolvedTopic.resolved;
  if (!topic) {
    return {
      outcome: "unresolved-topic",
      title,
      candidates: resolvedTopic.candidates,
      timings: timings.all()
    };
  }

  /* WS-D2 (fix plan, "D2 (streaming publish)") needs four Foray-level facts
     before Act 1 can be handed to a listener, and all four are knowable the
     moment the spine is frozen and the topic resolves — so they are hoisted
     here rather than recomputed inside `onActReady` on every act.

     WHICH TIMESTAMP THE PARTIAL CANDIDATE CARRIES, AND WHY. `startedAt` comes
     from the SAME injected `now()` clock the final `generatedAt` below comes
     from — the deterministic one tests pin, never `Date.now()` — but it is
     read HERE, so it is the time the run reached the frozen spine and not the
     time the Foray finished. A partial candidate has no finish time to stamp:
     it exists, by construction, only while the run is still going. It
     therefore carries `builtAt: startedAt`, and that is the honest reading of
     the field rather than a finish time back-dated or invented.

     `generatedAt` itself is deliberately NOT hoisted — the note just above
     stands: it is the time the Foray was finished, and stamping it here would
     date every published Foray several minutes before it existed.

     `forayId` IS hoisted, seeded from `startedAt`, and the finished candidate
     below reuses it instead of re-deriving one from `generatedAt`. The id is
     the streaming contract: the listener polling the partial and the candidate
     that eventually replaces it have to be the same Foray, and two timestamps
     would mint two ids for one piece of work. Determinism is untouched —
     both stamps are read from the injected clock, so the same request and the
     same clock still produce the same id (`runPipeline.test.ts`). */
  const startedAt = now().toISOString();
  const forayId = forayIdFor(title, startedAt);
  const slots = slotsFromSpine(spine);
  const allActTitles = spine.acts.map((a) => a.title);

  /* §4.4 — deepen every act, in parallel across acts, each act checkpointed on
     its own (F-17): an act that succeeded is banked even when a sibling act
     exhausts its retry budget and fails the stage. */
  const deepened = await timed("deepen", () =>
    deepenActs(spine, deepenBuilder, ctx, {
      resume: (index) => checkpoint.resumeSync(`deepen:${index}`, (raw) => DeepenedActSchema.parse(raw)),
      onActDeepened: (index, act) => checkpoint.save(`deepen:${index}`, act)
    })
  );

  /* §4.5-4.6 — source each beat against tape, then resolve the pointer. Purely
     deterministic and keyless: no LLM call happens in here at all. The cue
     provider is what decides whether tier-2 can anchor a real span or whether
     the beat degrades to narration for this run; `topic` is what decides
     whether a candidate is even in the right subject. */
  const sourced = await stage(
    "source",
    (raw) => SourceCheckpointSchema.parse(raw),
    async () =>
      sourceBeats(deepened, {
        cueProvider: deps.cueProvider,
        textIndex: deps.textIndex,
        topic,
        root: options.root,
        /* Tier 2 may only mint tape whose audio can be honestly registered
           (F-49 plumbing) — see `audioSourceLookup.ts`. */
        audioSourceFor: deps.audioSourceFor ?? createDigestAudioSourceResolver({ root: options.root })
      })
  );

  /* ONE LINE PER SLOT, SAYING WHAT §4.5 DID (F-49). Run 2 finished with zero
     tape beats and nothing in the run log said so until the Foray was built;
     the operator's first evidence was an all-narration candidate 30 minutes
     later. These are printed, not returned, because they are for the person
     watching the run — the machine-readable form is `sourced.sourcingTrace`. */
  for (const line of summarizeSourcing(sourced)) console.log(`  ${line}`);

  /* The pool the runtime clock is measured against has to include what tier 2
     just minted, or a tier-2 tape item contributes 0 s to `runtime_sec` and
     `check-forays.mjs` fails the Foray for a runtime that disagrees with its
     own items. The cast is the shape difference only: a minted row carries no
     curator `why`, and nothing that reads this pool asks for one. */
  const mintedPool = sourced.newSegments.map((s) => mintedSegmentRow(s, topic) as unknown as SegmentRecord);
  const runtimePool = mintedPool.length ? [...loadSegmentPool(), ...mintedPool] : loadSegmentPool();

  /* §4.7 — write narration, then verify it independently (distinct instances,
     enforced there). Driven ONE ACT AT A TIME rather than in a single call, so
     each act's pages are checkpointed as they finish. Act order and the
     writer/verifier instances are unchanged — `writeNarration` iterates the
     acts it is given in order, so N calls of one act and one call of N acts
     produce the same result.

     TWO CHECKPOINT KEYS, NOT ONE (F-51). `narrate:<i>` is still the outer
     record: once an act is finished, one key holds it and nothing inside it is
     consulted again. But `narrate:<i>` is only WRITTEN when the whole act
     finishes, so a run that dies partway through act 1 re-paid for every page
     of it — run 2 would have re-paid for twelve pages to reach the one that
     failed. `narrate:<i>:<slot>` banks each slot the moment it is written, and
     `writeNarration`'s `resume` hook reads them back, so a re-run pays only
     for the slots that never landed. */
  const written: WrittenAct[] = [];
  for (let i = 0; i < sourced.acts.length; i++) {
    const act = sourced.acts[i]!;
    written.push(
      await stage(
        `narrate:${i}`,
        (raw) => WrittenActSchema.parse(raw) as WrittenAct,
        async () => {
          const [one] = await writeNarration(
            [act],
            {
              writer: countingNarrationWriter,
              verifier: countingNarrationVerifier,
              /* Requirements §8.1: the same cue provider §4.5 sources
                 against, so a tape beat's evidence pack holds the cue
                 window and not just the episode title. */
              ...(deps.cueProvider ? { cueProvider: deps.cueProvider } : {}),
              /* `writeNarration` is handed ONE act, so its own act index is
                 always 0; `i` is what names the slot's key. */
              resume: (_actIndex, slotIndex) =>
                checkpoint.resumeSync(`narrate:${i}:${slotIndex}`, (raw) => WrittenSlotSchema.parse(raw) as WrittenSlot),
              onSlotWritten: (_actIndex, slotIndex, slot) => checkpoint.save(`narrate:${i}:${slotIndex}`, slot)
            },
            spine.voice,
            ctx
          );
          return one!;
        }
      )
    );
  }

  /* WS-D2's clock: set once, the first time `onActReady` fires for act index
     0, then carried unchanged on every later act's rewrite — matching
     `PartialCandidate.ttlA1Ms`'s own doc comment.

     IT STAYS `null` ON A RESUMED RUN, and that is correct rather than a gap.
     When F-17/F-18's checkpoint already holds the stitch stage, `stage()`
     below returns the stored items and never calls `stitchForay` at all, so
     `onActReady` never fires and no act boundary is ever timed. The resumed
     process did not take that long, and the process that did is gone; a
     number measured from THIS run's start would be a fiction. Reported as
     "not measured" instead. The same is true of any run that supplied no
     `deps.onActReady` — there was no act-boundary clock to read. */
  let ttlA1Ms: number | null = null;

  /* §4.8 — stitch, smoothing each act's introduction against the one before
     it. Checkpointed like every other stage (F-17/F-18); WS-D2's per-act
     emission is wired INSIDE the checkpointed function, not around it, so a
     resume that skips stitch also skips the partial writes — there is nothing
     to stream when the items were already on disk. */
  const stitched = await stage(
    "stitch",
    (raw) => StitchCheckpointSchema.parse(raw) as { items: ForayItem[] },
    () =>
      stitchForay(
        deepened,
        written,
        {
          continuity: { builder: continuityBuilder },
          onActReady: deps.onActReady
            ? async ({ actIndex, itemsSoFar }) => {
                if (actIndex === 0) ttlA1Ms = Date.now() - pipelineStartMs;
                /* The disclosure is prepended here for the SAME reason the
                   whole-Foray path prepends it below: it is a Foray-level
                   obligation stitch has no concept of, and `check-forays.mjs`
                   requires items[0] to be it — a partial candidate is
                   something `finalizeForay` inside `buildPartialCandidate`
                   validates with those same gates, so it needs the same
                   opening item the final candidate gets. */
                const itemsWithDisclosure = [disclosureItem(intent.subject, slots[0]!.id), ...itemsSoFar];
                const candidate = await buildPartialCandidate(
                  {
                    actIndex,
                    totalActs: allActTitles.length,
                    allActTitles,
                    items: itemsWithDisclosure,
                    slots: slots.slice(0, slotCountThroughAct(spine, actIndex)),
                    runtimeSec: runtimeSecFor(itemsWithDisclosure, runtimePool),
                    ttlA1Ms
                  },
                  { id: forayId, title, topic, summary: intent.subject, authorId: options.userId, builtAt: startedAt, root: options.root },
                  finalize
                );
                await deps.onActReady!(candidate);
              }
            : undefined
        },
        ctx
      )
  );

  const generatedAt = now().toISOString();
  /* The disclosure is prepended here rather than inside stitch: it is a
     Foray-level obligation, not an act's content, and stitch has no concept of
     "the whole Foray" to attach it to. Prepending also keeps it out of the
     runtime sum below by construction — it is a spoken marker, not tape. */
  const items = [disclosureItem(intent.subject, slots[0]!.id), ...stitched.items];

  /* WS-B: computed here, with the resolved `topic` (`tapeRelevance` needs
     it) and before `finalize` runs, so `meta.veracity` rides along on
     EVERY candidate this function returns — including one that fails
     check-forays/check-narration below, which `generateForays.ts` still
     records in `report.json` even though it never writes a candidate file. */
  const veracity = buildVeracityMetrics({
    sourcedActs: sourced.acts,
    writtenActs: written,
    topic,
    writerCalls: narrationWriterCalls,
    verifierCalls: narrationVerifierCalls,
    pipelineTokens: getUsageTotals().total,
    stageTimings: timings.all(),
    tapeRelevanceRows: sourced.tapeRelevance,
    root: options.root
  });

  const input: FinalizeForayInput = {
    id: forayId,
    title,
    topic,
    summary: intent.subject,
    slots,
    items,
    runtimeSec: runtimeSecFor(items, runtimePool),
    builtAt: generatedAt,
    meta: { veracity },
    /* What §4.5 tier 2 cut this run, travelling WITH the candidate: nothing
       else can resolve a segment id that is not in `data/segments.json` yet
       (see `FinalizeForayInput.segments`). */
    segments: sourced.newSegments,
    segmentSources: sourced.newSegmentSources
  };

  // §4.9 — validate against the same two checkers CI runs. Writes nothing.
  const result = await timed("finalize", () => finalize(input, options.root));

  /* `finalize`'s own internal breakdown (build-record/check-forays/check-
     narration) plus this function's now-complete stage list — appended
     after the fact by mutating the SAME `veracity` object `input.meta`
     already holds a reference to, rather than rebuilding `input`. */
  veracity.stageTimings = [...timings.all(), ...result.timings.map((t) => ({ ...t, name: `finalize.${t.name}` }))];

  return { outcome: "generated", input, result, spine, tapeRelevance: sourced.tapeRelevance, timings: timings.all(), ttlA1Ms };
}
