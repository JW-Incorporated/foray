import { z } from "zod";
import { GenerationRequestSchema, IntentUnderstandingSchema, SAFETY_CATEGORIES, type GenerationRequest, type UnderstandPromptResult } from "../types/generation";
import { StageTimingLog, type StageTiming } from "./stageTiming";
import { BudgetStopError, EpisodeBudgetExceededError, findBudgetError } from "../cost/budgetGuard";
import { CheckpointSession, checkpointFingerprint, type CheckpointStore } from "./checkpoint";
import { DeepenedActSchema, SpineSchema } from "../types/spine";
import { NewSegmentSchema, SourcedActSchema, TapeBoundarySchema, TapePointerSchema, TranscriptionQueueCandidateSchema } from "../types/tapeSourcing";
import { ResearchShapeSchema } from "../types/research";
import { ForayItemSchema } from "./forayItems";
import { NarratedBeatSchema } from "../types/narration";

import { understandPrompt } from "./understandPrompt";
import { buildResearchShape } from "./researchShape";
import { buildSpineWithReasks, type SpineReask } from "./buildSpine";
import { postSeedWithFloor, summarizeSeedFloor, SPINE_SEED_FLOOR } from "./postSeedSpine";
import { deepenActs } from "./deepenActs";
import { sourceBeats, summarizeSourcing } from "./sourceBeats";
import { summarizeSeeding } from "./spineSeeding";
import { createDigestAudioSourceResolver, type AudioSourceResolver } from "./audioSourceLookup";
import { createActGate, narrationActConcurrency, writeNarration } from "./writeNarration";
import { countSynthesisCandidates, verifiedPageSummaries, verifyBySynthesis } from "./synthesisVerify";
import { PrefetchingEvidenceGatherer } from "./evidencePrefetch";
import { createEvidenceGatherer, type EvidenceGatherer } from "./gatherEvidence";
import { ForayStitcher } from "./stitchForay";
import {
  finalizeForay,
  generationBatchId,
  makeSupersedableCut,
  mintedSegmentRow,
  readExistingForayIds,
  type FinalizeForayInput,
  type FinalizeForayResult,
  type ForaySlot
} from "./finalizeForay";
import { resolveTopic, forayIdFor, type TopicCandidate } from "./resolveTopic";
import {
  chooseTopic,
  consideredTopicIds,
  measureTopicSupply,
  noSupplyReason,
  topicDecisionLine,
  pinnedTopicDecision,
  type SupplyBasis,
  type TopicDecision
} from "./topicSupply";
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
import type { ActWriteRequest, NarrationBuildContext, NarrationWriterBuilder, SelectAndWriteRequest } from "./NarrationWriterBuilder";
import type { ActVerifyRequest, NarrationVerifierBuilder, SynthesisVerifyRequest } from "./NarrationVerifierBuilder";
import type { ContinuityBuilder } from "./ContinuityBuilder";
import type { NarrationWriteStats, WrittenAct, WrittenSlot } from "./writeNarration";
import { loadTranscriptArchive, type TranscriptCueProvider, type TranscriptDigestEntry } from "./transcriptArchiveLookup";
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
  /**
   * F-91: the digest archive the topic decision measures supply against and
   * §4.5 then sources from — ONE array for both, so the count and the gate see
   * the same tape. Defaults to `loadTranscriptArchive()`, which is the same
   * process-cached read `sourceBeats` would make on its own; injectable so a
   * test can stage an archive with no supply for a subject.
   */
  transcriptArchive?: TranscriptDigestEntry[];
  /** F-91: tier 1's curated pool, for the same reason as `transcriptArchive`.
   * Defaults to `loadSegmentPool()`. */
  segmentPool?: SegmentRecord[];
  /** G-35: the gatherer the evidence prefetch wraps and `writeNarration` is
   * then handed. Defaults to exactly the gatherer `writeNarration` would
   * have built for itself (`createEvidenceGatherer` with `cueProvider`);
   * injectable so a test can count what reaches it. */
  evidence?: EvidenceGatherer;
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
  /**
   * G-30 (manual step 25): the ids already committed in `data/forays.json`,
   * consulted BEFORE this run's id is minted so a collision is suffixed here
   * (`uniqueForayId`) instead of thrown by `finalizeForay` after the whole
   * Foray has been paid for. Defaults to reading the file under
   * `options.root`; injectable so a test can stage a collision without a
   * fixture checkout.
   */
  existingForayIds?: (root?: string) => ReadonlySet<string>;
}

/**
 * G-30 (manual step 10): thrown from inside the `stitch:<i>` stage when the
 * partial candidate WS-D2 just built for act `actIndex` failed its own
 * `check-forays` pass and `options.refusedPartial` is `"abort"`. Named so the
 * batch driver can end the run with a reason a report can carry, rather than
 * a person watching the partial file and stopping the process by hand
 * (run 2 attempts 5–6). The refused act's stitch is NOT checkpointed — the
 * throw happens before `checkpoint.stage` records it — so the acts before it
 * stay banked and the refused one is rebuilt on the next run.
 */
export class RefusedPartialError extends Error {
  constructor(
    public readonly actIndex: number,
    public readonly totalActs: number,
    public readonly checkForaysErrors: string[],
    public readonly checkNarrationErrors: string[]
  ) {
    const errors = [...checkForaysErrors, ...checkNarrationErrors];
    super(
      `Refused partial candidate: act ${actIndex + 1} of ${totalActs} failed check-forays — ` +
        `${errors.slice(0, 3).join("; ")}${errors.length > 3 ? ` (+${errors.length - 3} more)` : ""}`
    );
    this.name = "RefusedPartialError";
  }
}

/** Suffixes `id` with `-2`, `-3`, … until it collides with nothing in
 * `taken`. Exported for `generateForays`'s tests; the pipeline applies it to
 * every minted id (see `RunPipelineDeps.existingForayIds`). */
export function uniqueForayId(id: string, taken: ReadonlySet<string>): string {
  if (!taken.has(id)) return id;
  for (let n = 2; ; n++) {
    const candidate = `${id}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface RunPipelineOptions {
  userId: string;
  sessionId?: string;
  /**
   * G-30 (manual step 10; abort-vs-continue is D4): what to do when an act's
   * partial candidate fails its `check-forays` pass. `"abort"` throws
   * `RefusedPartialError` from the `stitch:<i>` stage the moment the partial
   * is refused — after `deps.onActReady` has seen it, so the refused partial
   * is on disk for diagnosis. `"continue"` (the default here, so every
   * existing caller is unchanged) carries on to the whole-Foray finalize,
   * which applies the same gates to the finished assembly. The batch driver
   * defaults to `"abort"` and exposes `--continue-on-refused-partial`.
   * Nothing happens without `deps.onActReady`: no partial is built then.
   */
  refusedPartial?: "abort" | "continue";
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
  /**
   * G-32: how many acts narrate at once. Defaults to the
   * `NARRATION_ACT_CONCURRENCY` env (4 — see `narrationActConcurrency` in
   * `writeNarration.ts`). `1` is the pre-G-32 behaviour, acts in series.
   * Stitch and continuity are NOT governed by this: they run one act at a
   * time in act order whatever the number is.
   */
  narrationActConcurrency?: number;
  /**
   * F-86: how many times §4.3's builder is re-asked when its reply fails the
   * structural gate before the run fails. Defaults to the
   * `SPINE_STRUCTURAL_REASKS` env (1 — see `spineStructuralReasks` in
   * `buildSpine.ts`). `0` is the pre-F-86 behaviour: the first refusal fails
   * the run.
   */
  spineStructuralReasks?: number;
  /**
   * F-98: how many times §4.3's builder is re-asked when, AFTER deterministic
   * post-seeding, the seeded share of non-argument beats is still below
   * `SPINE_SEED_FLOOR`. Defaults to `DEFAULT_SEED_FLOOR_REASKS` (1). `0` spends
   * no call on the floor — post-seeding still runs, since it calls nothing.
   */
  spineSeedFloorReasks?: number;
}

/** G-32: one act's narration, as the report shows it — the `narrate:<i>`
 * stage timing with the act named, so a reader can see acts overlapping
 * (`startedAt` + `ms`) rather than infer it from a shorter total. */
export interface NarrationActTiming {
  act: number;
  startedAt: string;
  ms: number;
  /** The act came off the checkpoint; nothing was narrated this run. */
  resumed?: true;
}

export type RunPipelineOutcome =
  /** §4.0 safety refused the prompt. */
  | { outcome: "rejected"; category: string; explanation: string; timings: StageTiming[] }
  /** §4.1 could not read the prompt one way; a human has to disambiguate. */
  | { outcome: "needs-clarification"; question: string; readings: string[]; timings: StageTiming[] }
  /** The pipeline ran but no taxonomy node could be resolved — nothing is published. */
  | { outcome: "unresolved-topic"; title: string; candidates: TopicCandidate[]; spineReasks: SpineReask[]; timings: StageTiming[] }
  /** F-91: a topic resolved, but no candidate topic's family admits enough of
   * the archive to source a beat from (`chooseTopic` said `no-supply`). The
   * run stops BEFORE the spine — before any Opus or Sonnet call — because
   * run 8 showed what the alternative buys: seven model calls and a NO TAPE
   * stop five minutes later. `stoppedBefore` says which stage the stop
   * preceded: `"spine"` on the common path, `"deepen"` when only the spine's
   * act titles let a topic resolve at all (the pre-spine text resolved
   * nothing, so the spine was built and the decision came after it). */
  | {
      outcome: "no-supply";
      title: string;
      reason: string;
      topicDecision: PipelineTopicDecision;
      stoppedBefore: "spine" | "deepen";
      spineReasks: SpineReask[];
      timings: StageTiming[];
    }
  /** §4.5 sourced every beat to narration (F-65). A Foray with no tape cannot
   * pass §4.9, so the run stops before paying for narration. `sourcing` is
   * `summarizeSourcing`'s one line per slot, top reason included. */
  | {
      outcome: "no-tape";
      title: string;
      sourcing: string[];
      topicDecision: PipelineTopicDecision;
      spineReasks: SpineReask[];
      timings: StageTiming[];
    }
  /** A Foray was built. `validation.ok` says whether it may be published. */
  | {
      outcome: "generated";
      input: FinalizeForayInput;
      result: FinalizeForayResult;
      spine: Spine;
      /** F-86: every structural re-ask §4.3 took, with the violations it was
       * asked to fix. Empty on the common path (the first reply passed) and
       * on a resume (the banked spine is the one that passed). Carried into
       * `report.json` as `spineReasks`. */
      spineReasks: SpineReask[];
      /** WS-C: one row per tape-sourced beat, carrying the topic gate's own
       * verdict on the anchor it took (see `TapeRelevanceInput`). Surfaced here
       * because §4.5 is the only stage that knows all of it at once, and
       * because WS-B's `tapeRelevance` metric otherwise has to re-derive the
       * join from disk — and can only do so for anchors that resolve against
       * `data/segment-sources.json`, which a freshly minted tier-2 segment need
       * not. */
      tapeRelevance: TapeRelevanceInput[];
      /** F-91: how the Foray's topic was chosen — the resolver's pick, the
       * supply each candidate had, and whether supply moved the choice. */
      topicDecision: PipelineTopicDecision;
      timings: StageTiming[];
      /** WS-D2: prompt received -> Act 1 ready, in milliseconds. `null` only
       * when `deps.onActReady` was never supplied (no act-boundary clock was
       * ever read) — see `report.json`'s own `ttlA1Ms` field, which is where
       * `generateForays.ts` surfaces this per §4.9/D2's "measure it and
       * print ttlA1Ms in the report." */
      ttlA1Ms: number | null;
      /** G-32: the act-concurrency cap this run narrated under, and one
       * timing per act. `generateForays.ts` carries both into `report.json`
       * (`narrationConcurrency`, `narrationActs`). */
      narration: { concurrency: number; acts: NarrationActTiming[] };
    };

/**
 * F-91: the topic decision as the run records it. `chooseTopic`'s own record
 * when the resolver chose, or a `pinned` record when the caller supplied
 * `options.topic` — a human's ruling is not second-guessed by supply, but its
 * supply is still measured and reported, so a pinned topic the archive cannot
 * carry is at least SAID before the run spends anything. `basis` says what
 * the supply numbers counted: transcript bodies on this machine, or every
 * archive entry (no body source wired — CI, tests).
 */
export type PipelineTopicDecision = TopicDecision & { basis: SupplyBasis };

/** The Foray-level `slots` record: §4.9 wants `{id, title}` per act slot. */
/** `check-forays.mjs`'s `MAX_WHY_LINE_WORDS`, applied to `title` and `summary`
 * (and every slot title) as "our own prose". Mirrored rather than imported:
 * that file is `.mjs` and Vitest cannot load it on every checkout (see
 * `RunPipelineDeps.finalize`). `check-forays.test.mjs` pins the number. */
export const MAX_COPY_WORDS = 18;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Cuts `text` at a word boundary so it has at most `max` words, then strips a
 * dangling separator. Never invents words: a clamped line is an honest prefix. */
export function clampWords(text: string, max: number = MAX_COPY_WORDS): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= max) return words.join(" ");
  return words.slice(0, max).join(" ").replace(/[\s,;:—–-]+$/u, "");
}

/**
 * The two listener-facing lines §4.9 puts on the record, derived ONCE here
 * (F-64). Run 2 attempt 3 spent 76 minutes narrating a Foray whose `summary`
 * was the understander's 26-word restatement of the prompt, and
 * `check-forays.mjs` refused it at finalize for being over 18 words — the
 * one rule in the whole run that no model ever saw. Now: the understander is
 * asked for a bounded `title` and `summary` by name; whatever comes back is
 * clamped to the checker's own limit so the record cannot fail this rule; and
 * a clamp that actually cut something is reported, because it means the
 * understander ignored the instruction and the prompt needs looking at.
 *
 * `title` keeps its old shape (`subject: angle`) when the understander gave
 * none, so every id minted by `forayIdFor(title, …)` for a pre-F-64 request
 * is unchanged (`runPipeline.test.ts` pins one).
 */
export function forayCopy(intent: { subject: string; angle?: string; title?: string; summary?: string }): {
  title: string;
  summary: string;
  clamped: string[];
} {
  const clamped: string[] = [];
  const rawTitle = intent.title?.trim() || `${intent.subject}${intent.angle ? `: ${intent.angle}` : ""}`.slice(0, 120);
  const rawSummary = intent.summary?.trim() || intent.subject;
  const title = clampWords(rawTitle);
  const summary = clampWords(rawSummary);
  if (wordCount(rawTitle) > MAX_COPY_WORDS) clamped.push(`title (${wordCount(rawTitle)} words)`);
  if (wordCount(rawSummary) > MAX_COPY_WORDS) clamped.push(`summary (${wordCount(rawSummary)} words)`);
  return { title, summary, clamped };
}

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
  seedWindowWon: z.boolean().optional(),
  /* F-72: which floor admitted a seeded beat's window. Optional for the same
     reason as the pair above. */
  seedFloor: z.literal("share-only").optional(),
  /* Q-04: D5's pair clause chose this segment's length (F-80's triple clause
     before it — a checkpoint written under F-80 carries the old spelling and
     reads as the new gate). Optional likewise. */
  lengthGate: z
    .enum(["d5-pair", "d5-triple"])
    .transform((): "d5-pair" => "d5-pair")
    .optional(),
  /* Q-01: where the clip's edges landed and how far relevance carried it.
     Optional so a checkpoint written before Q-01 still resumes. */
  boundary: TapeBoundarySchema.optional(),
  extendedBySec: z.number().optional(),
  /* F-84: the pool's cut at the same start was reused. Optional likewise. */
  poolCut: z.literal("reused").optional(),
  /* F-96: the seconds a reused pool cut fell short of this run's extent, and
     the beat whose clip a merged beat rides in. Optional: a checkpoint
     written before F-96 still resumes. */
  poolCutShortBySec: z.number().optional(),
  mergedInto: z.object({ slot: z.number().int().nonnegative(), beat: z.number().int().nonnegative() }).optional()
});

/* F-80 renamed the D5 gate from `d5-uniform` (a preference, #571) to
   `d5-triple` (a rule), and Q-04 restated the rule as a PAIR (`d5-pair`). A
   checkpoint written by #571–#620 or by F-80–Q-04 can carry either old
   spelling in its trace, and a resume must not fail on the runs the ledger
   decided — so both legacy spellings are accepted and read as the new one. */
const LEGACY_D5_GATES = ["d5-uniform", "d5-triple"] as const;
const readLegacyD5Gate = <G extends string>(gate: G | (typeof LEGACY_D5_GATES)[number]): G | "d5-pair" =>
  (LEGACY_D5_GATES as readonly string[]).includes(gate) ? "d5-pair" : (gate as G);

/* Mirrors `SourcingTrace` (types/tapeSourcing.ts, F-49): why each narrated beat
   got no tape. Checkpointed with the stage for the same reason `tapeRelevance`
   is — a resumed run must be able to say what the search saw, or the evidence
   the thresholds are tuned against disappears on the first resume. */
/* Every gate `Tier2Gate` can name, F-73's four length gates included — the
   trace emits them, and a checkpoint that could not parse its own trace would
   fail to resume on exactly the runs the D-tier ledger decided (G-24). */
const TIER2_GATE_SCHEMA = z
  .enum([
    "text-index:no-candidate",
    "title-tokens",
    "lineage",
    "no-body",
    "no-anchor",
    "window-overlap",
    "no-audio-source",
    "m4-share",
    "m3-order",
    "d2-short-run",
    "d3-mean",
    "d5-pair",
    ...LEGACY_D5_GATES,
    "m4-runtime",
    "pool-cut",
    "past-duration"
  ])
  .transform(readLegacyD5Gate);
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
      gate: z
        .enum([
          "no-candidates",
          "threshold",
          "topic-lineage",
          "exhausted",
          "m4-share",
          "m3-order",
          "d2-short-run",
          "d3-mean",
          "d5-pair",
          ...LEGACY_D5_GATES,
          "m4-runtime"
        ])
        .transform(readLegacyD5Gate),
      /* G-24 R2: tier 1's weighted floor, when a transcript window was scored. */
      windowWeightedShare: z.number().optional(),
      windowDistinctiveTerms: z.array(z.string()).optional()
    })
    .nullable(),
  tier2: z
    .object({
      bestShowId: z.string().nullable(),
      bestEpisodeTitle: z.string().nullable(),
      score: z.number(),
      requiredScore: z.number(),
      /* `m4-share`/`m3-order` are F-70's: tier 2 now keeps the same Foray-wide
         ledger tier 1 does, so its trace can name the same two gates. */
      gate: TIER2_GATE_SCHEMA,
      /* F-61: the window search's own numbers, and the anchors minted from the
         tape. Optional, like the WS-H fields below, so a checkpoint written
         before this change still parses on resume. */
      windowMatchedTerms: z.array(z.string()).optional(),
      windowDistinctiveTerms: z.array(z.string()).optional(),
      windowTermShare: z.number().optional(),
      windowWeightedShare: z.number().optional(),
      windowStartSec: z.number().optional(),
      windowEndSec: z.number().optional(),
      /* F-87: the cut's end and the feed's declared duration, both numbers a
         `past-duration` row is read as. */
      spanEndSec: z.number().optional(),
      feedDurationSec: z.number().optional(),
      startAnchor: z.string().optional(),
      endAnchor: z.string().optional(),
      /* Q-01: the cut's boundary kind and extension, beside its anchors. */
      boundary: TapeBoundarySchema.optional(),
      extendedBySec: z.number().optional(),
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
      seedWindowWon: z.boolean().optional(),
      /* F-72: set when a seed window the share-only floor admitted was then
         refused further down the walk. */
      seedFloor: z.literal("share-only").optional(),
      /* G-24 R3: the seed window's OWN gate and share, alongside the furthest
         candidate's. Optional so a checkpoint written before G-24 still parses. */
      seedGate: TIER2_GATE_SCHEMA.optional(),
      seedWindowWeightedShare: z.number().optional()
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
  /* Q-03: a narration beat holds its seam's page, or points at the beat
     that does (`carriedBy`), and records the round its claim was first
     confirmed on. Every field the per-page path wrote is still here, so a
     `narrate:<i>` key from runs 1–8 parses unchanged. */
  z.object({
    sourcing: z.literal("narration"),
    claim: z.string(),
    exploration: z.boolean(),
    narration: NarratedBeatSchema.optional(),
    carriedBy: z.object({ slot: z.number().int().nonnegative(), beat: z.number().int().nonnegative() }).optional(),
    verifiedAtAttempt: z.number().int().min(1).optional()
  })
]);
const WrittenSlotSchema = z.object({ title: z.string(), beats: z.array(WrittenBeatSchema) });
const WrittenActSchema = z.object({
  title: z.string(),
  slots: z.array(WrittenSlotSchema)
});

/* PRE-F-66 SHAPE, STILL READ. Until F-66 the whole of §4.8 was one stage under
   one `stitch` key holding the whole Foray's items. A checkpoint written by
   that code is still on disk in every output directory run 2 touched, and it
   still describes finished work — so `runForayPipeline` reads it and skips
   per-act stitching entirely when it is there. Nothing WRITES this key any
   more; see `StitchActCheckpointSchema`. */
const StitchCheckpointSchema = z.object({ items: z.array(ForayItemSchema) });

/* F-66: §4.8's unit is now an ACT, keyed `stitch:<i>`, matching `deepen:<i>` /
   `narrate:<i>`. A bare array rather than `{items}` because that is exactly
   what `ForayStitcher.stitchNextAct` returns, and a checkpoint that mirrors the
   function's own return value is one less shape to keep in step. */
const StitchActCheckpointSchema = z.array(ForayItemSchema);

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

  /** `stage`, but saying whether the value was RESUMED rather than produced.
   * Only F-66's per-act stitching needs to know: a `ForayStitcher` whose act
   * came off disk must still be told about that act, or the next act's
   * `itemsSoFar` would be missing everything before it. */
  const stageDetail = async <T>(name: string, parse: (raw: unknown) => T, fn: () => Promise<T>): Promise<{ value: T; resumed: boolean }> => {
    const result = await checkpoint.stage(name, parse, () => timed(name, fn));
    if (result.resumed) timings.markResumed(name);
    return result;
  };

  const stage = async <T>(name: string, parse: (raw: unknown) => T, fn: () => Promise<T>): Promise<T> => {
    return (await stageDetail(name, parse, fn)).value;
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
    },
    /* G-34: the merged select+prose call is ONE request and counts as
       one. Forwarded only when the wrapped builder offers it — its
       absence is what tells `writeNarration` to take the two-call path,
       so a wrapper that always declared it would silently break every
       builder without it. */
    ...(narrationWriter.selectAndWrite
      ? {
          selectAndWrite: (mergedRequest: SelectAndWriteRequest, mergedCtx: NarrationBuildContext) => {
            narrationWriterCalls++;
            return narrationWriter.selectAndWrite!(mergedRequest, mergedCtx);
          }
        }
      : {}),
    /* Q-03: the per-act call is ONE request and counts as one. Forwarded
       only when the wrapped builder offers it, for the same reason as
       `selectAndWrite`: its absence is what sends `writeNarration` down
       the per-slot path. */
    ...(narrationWriter.writeAct
      ? {
          writeAct: (actRequest: ActWriteRequest, actCtx: NarrationBuildContext) => {
            narrationWriterCalls++;
            return narrationWriter.writeAct!(actRequest, actCtx);
          }
        }
      : {})
  };
  /* G-34: `retryRounds` is counted by the stage itself (a round is a
     slot going back to the writer), not by the proxies above, which see
     requests and cannot tell a round from a call. */
  const narrationStats: NarrationWriteStats = { retryRounds: 0 };
  const countingNarrationVerifier: NarrationVerifierBuilder = {
    providerName: narrationVerifier.providerName,
    verifySlot: (verifyRequest, verifyCtx) => {
      narrationVerifierCalls++;
      return narrationVerifier.verifySlot(verifyRequest, verifyCtx);
    },
    /* F-88: the synthesis question is one verifier request and counts as
       one. Forwarded only when the wrapped verifier answers it — a wrapper
       that always declared it would make `synthesisVerify.ts` call into
       nothing. */
    ...(narrationVerifier.verifySynthesis
      ? {
          verifySynthesis: (synthesisRequest: SynthesisVerifyRequest, synthesisCtx: NarrationBuildContext) => {
            narrationVerifierCalls++;
            return narrationVerifier.verifySynthesis!(synthesisRequest, synthesisCtx);
          }
        }
      : {}),
    /* Q-03: the per-act verdict is one request. */
    ...(narrationVerifier.verifyAct
      ? {
          verifyAct: (actRequest: ActVerifyRequest, actCtx: NarrationBuildContext) => {
            narrationVerifierCalls++;
            return narrationVerifier.verifyAct!(actRequest, actCtx);
          }
        }
      : {})
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

  /* THE FORAY'S COPY, from the intent alone — hoisted ahead of the topic
     decision below because a stop there has to name the Foray it refused. */
  const { title, summary, clamped: clampedCopy } = forayCopy(intent);
  for (const what of clampedCopy) {
    console.warn(`runPipeline: ${what} exceeded the ${MAX_COPY_WORDS}-word copy rule and was clamped — the understander ignored its length instruction (F-64)`);
  }

  /* THE FORAY'S TOPIC, DECIDED HERE — BEFORE THE RESEARCH MAP AND THE SPINE
     (F-91). It used to be resolved after the spine, from a text that included
     the act titles, while §4.2 resolved a SECOND topic of its own from the
     prompt, subject and angle to filter the research map. Run 8 showed why one
     decision has to be made once, first, and with the archive in view: the
     resolver put "how engineering careers really work" on `business/careers`
     (one token: "careers"), the lineage gate then refused every episode of the
     one show that carries the subject, and the run spent an Opus call and four
     Sonnet calls before §4.5 could say NO TAPE. `chooseTopic` measures how much
     of the archive each candidate's family admits — the SAME predicate §4.5's
     tier 2 applies — and lets supply break a tie the word-scorer could not,
     within a score floor. No candidate with supply means the archive cannot
     carry the subject at all, and the run stops here, having paid for one
     Haiku call.

     WHAT COUNTS AS SUPPLY. An entry the family admits AND, when the cue
     provider can say so (`bodyStat`), one with a transcript body on this
     machine: a digest row nothing can open is not tape. `basis` records which
     of the two was counted so the log and the report are honest about it.

     WHY THE SAME TEXT §4.2 USED. The pre-spine text is the prompt, subject and
     angle (F-67: the prompt leads). The act titles are the spine's framing,
     not the subject, and a topic that needs them to resolve at all is decided
     AFTER the spine below, on the old text — the one behaviour the old order
     had that this one must keep. `options.topic` (a human's ruling) is never
     overridden; its supply is measured and said, and that is all. */
  const archive = deps.transcriptArchive ?? loadTranscriptArchive();
  const segmentPool = deps.segmentPool ?? loadSegmentPool();
  const bodySource = deps.cueProvider as (TranscriptCueProvider & { bodyStat?: (entry: TranscriptDigestEntry) => unknown }) | undefined;
  const isSearchable =
    bodySource && typeof bodySource.bodyStat === "function"
      ? (entry: TranscriptDigestEntry) => bodySource.bodyStat!(entry) !== null
      : undefined;
  const basis: SupplyBasis = isSearchable ? "bodies" : "archive";
  const measure = (ids: string[]) =>
    measureTopicSupply(ids, { archive, segmentPool, root: options.root, ...(isSearchable ? { isSearchable } : {}) });
  const decideTopic = (text: string): { candidates: TopicCandidate[]; decision: PipelineTopicDecision } => {
    const resolved = resolveTopic(text, { root: options.root });
    const supply = measure(consideredTopicIds(resolved, { root: options.root }));
    return { candidates: resolved.candidates, decision: { ...chooseTopic(resolved, supply, { root: options.root }), basis } };
  };
  const preSpineText = [req.prompt, intent.subject, intent.angle].join(" ");
  let topicDecision: PipelineTopicDecision;
  let preSpineCandidates: TopicCandidate[] = [];
  if (options.topic) {
    topicDecision = { ...pinnedTopicDecision(options.topic, measure([options.topic])), basis };
    console.log(`  ${topicDecisionLine(topicDecision, basis)}`);
  } else {
    const decided = decideTopic(preSpineText);
    preSpineCandidates = decided.candidates;
    topicDecision = decided.decision;
    if (topicDecision.reason !== "unresolved") console.log(`  ${topicDecisionLine(topicDecision, basis)}`);
    if (topicDecision.reason === "no-supply") {
      return {
        outcome: "no-supply",
        title,
        reason: noSupplyReason(topicDecision, basis),
        topicDecision,
        stoppedBefore: "spine",
        spineReasks: [],
        timings: timings.all()
      };
    }
  }
  /* Null only when the pre-spine text resolved nothing — the post-spine
     fallback below then gets the act titles' help, as it always did. */
  let topic: string | null = topicDecision.topic;

  /* §4.2 — research to establish shape. The map is filtered by the SAME topic
     §4.5 will gate on (F-11, F-91): before F-91 this stage resolved its own,
     and a supply-aware pick here would have left the map filtered by the
     unsupplied one. `null` (unresolved so far) disables the filter, exactly as
     the stage's own miss did. */
  const researchShape = await stage(
    "research-shape",
    (raw) => ResearchShapeSchema.parse(raw),
    () =>
      buildResearchShape(intent, {
        researcher,
        ctx,
        root: options.root,
        /* F-67: the listener's own words join the topic text. */
        prompt: req.prompt,
        topic,
        /* WS-L (F-63): the same text index and cue provider §4.5 sources with,
           handed to §4.2 so the map carries what the tape SAYS about each
           candidate and the spine can write its beats from that rather than
           from an item count. Both default to their Null implementations, so a
           driver that wires neither gets the pre-WS-L map. */
        ...(deps.textIndex ? { textIndex: deps.textIndex } : {}),
        ...(deps.cueProvider ? { cueProvider: deps.cueProvider } : {})
      })
  );

  // §4.3 — the spine, frozen from here on (§6.1's invariant, batch-true).
  /* F-86: the re-asks the stage took, for the report. Set only when the stage
     actually RAN — a resumed spine is the banked one, which passed the gate
     when it was banked, so a resume reports none. The checkpoint holds the
     spine alone, never a refused reply: `buildSpineWithReasks` returns only a
     spine that passed, and `stage` banks only what it returns. */
  let spineReasks: SpineReask[] = [];
  /* F-98: whether the seed floor spent its one re-ask. A resumed spine reports
     `false` for the same reason a resumed spine reports no structural re-asks —
     the checkpoint is the spine, not the conversation that produced it — while
     the counts in the line itself are read off the banked spine's `seedSource`
     marks and are therefore right either way. */
  let seedFloorReasked = false;
  const spine = await stage(
    "spine",
    (raw) => SpineSchema.parse(raw),
    async () => {
      const built = await buildSpineWithReasks(intent, researchShape, req.duration, spineBuilder, ctx, {
        ...(options.spineStructuralReasks !== undefined ? { maxStructuralReasks: options.spineStructuralReasks } : {}),
        onReask: (reask) =>
          console.log(
            `  spine: reply ${reask.attempt} failed the structural check (F-13) — re-asking once with the violations named (F-86): ${reask.violations.join("; ")}`
          )
      });
      spineReasks = built.reasks;
      /* F-98 — DETERMINISTIC POST-SEEDING, THEN THE FLOOR. Inside the spine
         stage, so what the checkpoint banks is the spine the rest of the run
         will use: a resume must not re-decide the seeds, and the seed is what
         decides where the tape comes from. `postSeedSpine.ts` owns both halves;
         the only thing that happens here is the logging. */
      const seeded = await postSeedWithFloor(built.spine, intent, researchShape, req.duration, spineBuilder, ctx, {
        ...(options.spineSeedFloorReasks !== undefined ? { maxSeedFloorReasks: options.spineSeedFloorReasks } : {}),
        onReask: ({ share, violations }) =>
          console.log(
            `  spine: ${(share * 100).toFixed(0)} % of non-argument beats seeded after post-seeding, below the ${SPINE_SEED_FLOOR} floor — ` +
              `re-asking once with ${violations.length} unseeded beat(s) named (F-98)`
          )
      });
      seedFloorReasked = seeded.reasked;
      return seeded.spine;
    }
  );
  console.log(`  ${summarizeSeedFloor(spine, seedFloorReasked)}`);

  /* THE POST-SPINE FALLBACK (F-91). Until F-91 the topic was resolved HERE —
     the first point where both the intent and the frozen spine existed — from
     a text that added the act titles (F-67: the prompt leads; the titles are
     the spine's framing). The decision now happens before §4.2, above, and
     this block runs only when that text resolved nothing: the act titles get
     their old chance to help, the supply rule applies the same way, and a
     `no-supply` verdict still stops the run before deepen and sourcing — later
     than the pre-spine stop, but four Sonnet calls earlier than NO TAPE.

     The unresolved-topic OUTCOME is unchanged: same shape, same title, same
     ranked candidates, still returned rather than guessed at, because
     `check-forays.mjs` only asks whether a node exists and never whether it is
     the right one. `generatedAt` deliberately did NOT move with it: it is the
     time the Foray was finished, and stamping it here would date every Foray
     several minutes before it existed. */
  if (!topic) {
    const topicText = [preSpineText, spine.acts.map((a) => a.title).join(" ")].join(" ");
    const decided = decideTopic(topicText);
    topicDecision = decided.decision;
    if (!topicDecision.topic) {
      return {
        outcome: "unresolved-topic",
        title,
        candidates: decided.candidates.length > 0 ? decided.candidates : preSpineCandidates,
        spineReasks,
        timings: timings.all()
      };
    }
    console.log(`  ${topicDecisionLine(topicDecision, basis)} [resolved with the spine's act titles]`);
    if (topicDecision.reason === "no-supply") {
      return {
        outcome: "no-supply",
        title,
        reason: noSupplyReason(topicDecision, basis),
        topicDecision,
        stoppedBefore: "deepen",
        spineReasks,
        timings: timings.all()
      };
    }
    topic = topicDecision.topic;
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
  /* G-30 (manual step 25): an id that already sits in `data/forays.json` is
     suffixed `-2`, `-3`, … HERE — before the first partial candidate hands it
     to `finalizeForay`, which would otherwise throw on the duplicate at act 1
     (and again at the end, after the whole run was paid for). The read is the
     same file finalize reads; a checkout without it takes the id as minted. */
  const forayId = uniqueForayId(forayIdFor(title, startedAt), (deps.existingForayIds ?? readExistingForayIds)(options.root));
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
        /* F-91: the tape the topic decision was measured on — both tiers. */
        segmentPool,
        transcriptArchive: archive,
        topic,
        root: options.root,
        /* Tier 2 may only mint tape whose audio can be honestly registered
           (F-49 plumbing) — see `audioSourceLookup.ts`. */
        audioSourceFor: deps.audioSourceFor ?? createDigestAudioSourceResolver({ root: options.root }),
        /* F-98 (B): which committed pool rows a longer cut of the same window
           may supersede. The rule is `poolRowIsSupersedable`'s — a machine's
           unreviewed cut, played only by generated drafts — and the Foray list
           it is asked against is the one on disk, read once here rather than
           per candidate. A checkout without `data/forays.json` (CI, a fixture
           run) supersedes nothing, which is the same inert default every other
           catalogue-reading option in this call has. */
        supersedableCut: makeSupersedableCut(options.root)
      })
  );

  /* ONE LINE PER SLOT, SAYING WHAT §4.5 DID (F-49). Run 2 finished with zero
     tape beats and nothing in the run log said so until the Foray was built;
     the operator's first evidence was an all-narration candidate 30 minutes
     later. These are printed, not returned, because they are for the person
     watching the run — the machine-readable form is `sourced.sourcingTrace`. */
  /* AND ONE LINE FOR THE WHOLE FORAY (G-25): how many beats the spine seeded
     from the research map against how many got tape, and how many of those
     through their seed. The seed is the only path that yields (tape-yield
     brief §5), so the person watching needs the two counts side by side. */
  const sourcingLines = [...summarizeSourcing(sourced), summarizeSeeding(deepened, sourced)];
  for (const line of sourcingLines) console.log(`  ${line}`);

  /* NO TAPE, NO FORAY — SAID NOW, NOT AFTER NARRATION (F-65). A Foray with no
     segment item fails `check-forays.mjs` ("no resolvable segment items")
     without exception, so once §4.5 has sourced every beat to narration the
     run's only remaining product is a 76-minute demonstration of that. Run 2
     attempt 3 was exactly that: the sourcing lines above said "0 tape" 51
     seconds in, and the checker said the same thing 76 minutes and 139,803
     tokens later. Stopping here returns the sourcing summary as the outcome so
     the report names the top reason per slot; the fix is upstream of this line
     (the spine reads the tape — WS-L), never a looser check. */
  const tapeBeats = sourced.acts.reduce(
    (sum, act) => sum + act.slots.reduce((s, slot) => s + slot.beats.filter((b) => b.sourcing === "tape").length, 0),
    0
  );
  if (tapeBeats === 0) {
    return { outcome: "no-tape", title, sourcing: sourcingLines, topicDecision, spineReasks, timings: timings.all() };
  }

  /* G-35 — EVERY PAGE'S EVIDENCE, IN ONE FAN-OUT, BEFORE ANY ACT IS WRITTEN.
     Retrieval used to sit inside each act's `writeSlot`, serial with the acts
     around it; now the whole Foray's packs are gathered here, bounded by
     `EVIDENCE_PREFETCH_CONCURRENCY`, and `writeNarration` below is handed the
     same object so its gathers are memo lookups. Timed as its own stage but
     NOT checkpointed: its product is a warm cache, and a resumed run simply
     skips the slots it will not narrate again (`skipSlot`). See
     `evidencePrefetch.ts` for why the seeded claims are not started during
     deepen. */
  const evidence = new PrefetchingEvidenceGatherer(
    deps.evidence ?? createEvidenceGatherer(deps.cueProvider ? { cueProvider: deps.cueProvider } : {})
  );
  await timed("evidence", () =>
    evidence.prefetch(sourced.acts, ctx, {
      skipSlot: (actIndex, slotIndex) => checkpoint.has(`narrate:${actIndex}`) || checkpoint.has(`narrate:${actIndex}:${slotIndex}`)
    })
  );
  /* ONE clock for the fan-out. The stage log's reading is the report's
     `timings[]` entry; the gatherer's `prefetchMs` is set FROM it rather
     than measured again alongside it, so the two numbers `report.json`
     carries for the same work cannot differ by the millisecond that lands
     between two `Date.now()` starts. */
  const evidenceStage = timings.all().find((t) => t.name === "evidence");
  if (evidenceStage) evidence.recordStageMs(evidenceStage.ms);

  /* The pool the runtime clock is measured against has to include what tier 2
     just minted, or a tier-2 tape item contributes 0 s to `runtime_sec` and
     `check-forays.mjs` fails the Foray for a runtime that disagrees with its
     own items. The cast is the shape difference only (`Record<string, unknown>`
     vs. the typed pool row); every field the pool gate requires is on the row
     (F-78), read from the same minted source rows the publish will write.

     THE COMMITTED ROW WINS A TIE ON ID (F-84). `runtimeSecFor` keys the pool by
     id and the last row under an id is the one it measures, so the minted rows
     go FIRST and the on-disk pool after them: a Foray whose item names an id
     `data/segments.json` already holds is timed on the cut that will actually
     play — the committed one, which the publish never overwrites and which
     `mintedPoolCollisions` refuses to shadow with a different cut. Sourcing
     reuses the pool's cut at a shared start, so the two agree on the ids they
     share; this is the order that keeps them agreeing if a checkpoint resumes
     against a pool that has since gained the row. */
  const rowContext = { batchId: generationBatchId(forayId), sources: sourced.newSegmentSources };
  const mintedPool = sourced.newSegments.map((s) => mintedSegmentRow(s, topic, rowContext) as unknown as SegmentRecord);
  const runtimePool = mintedPool.length ? [...mintedPool, ...loadSegmentPool()] : loadSegmentPool();

  /* §4.7 — write narration, then verify it independently (distinct instances,
     enforced there). Driven ONE CALL PER ACT rather than one call for all, so
     each act's pages are checkpointed under their own act's keys. Since G-32
     those N calls are STARTED together (see the gate below) and only WAITED
     ON in act order; the writer/verifier instances are shared across them,
     as they were across the slots of one act before.

     TWO CHECKPOINT KEYS, NOT ONE (F-51). `narrate:<i>` is still the outer
     record: once an act is finished, one key holds it and nothing inside it is
     consulted again. But `narrate:<i>` is only WRITTEN when the whole act
     finishes, so a run that dies partway through act 1 re-paid for every page
     of it — run 2 would have re-paid for twelve pages to reach the one that
     failed. `narrate:<i>:<slot>` banks each slot the moment it is written, and
     `writeNarration`'s `resume` hook reads them back, so a re-run pays only
     for the slots that never landed.

     SINCE Q-03 THE ACT IS THE UNIT OF WRITING (`writeAct.ts`), so a fresh run
     writes no per-slot key: the act's seams span its slots and are banked
     together under `narrate:<i>` the moment the act lands. The per-slot keys
     are still READ — a run-1…8 checkpoint whose every slot of an act was
     banked resumes that act without a call — and still written by the
     per-slot fallback path. Both legacy key names stay readable.

     AND §4.8 NOW RUNS INSIDE THIS SAME LOOP (F-66). Stitching used to be one
     stage AFTER the loop, so act 1's items — and with them WS-D2's partial
     candidate and `ttlA1Ms` — did not exist until the LAST act had been
     narrated. Run 2 attempt 3 is the measurement: act 1 was narrated and
     checkpointed at 18 minutes, the partial candidate was first written at 76
     minutes, and `ttlA1Ms` came back 4,579,741 ms — the whole run, not the
     time to first listen. Nothing in act N's stitch depends on act N+1 (see
     `ForayStitcher`), so act N is stitched the instant it is narrated and the
     listener's clock finally measures what its name says. */

  /* WS-D2's clock: set once, the first time `onActReady` fires for act index
     0 — now immediately after act 0 is narrated — then carried unchanged on
     every later act's rewrite, matching `PartialCandidate.ttlA1Ms`'s own doc
     comment.

     IT STAYS `null` ON A RESUMED RUN, and that is correct rather than a gap.
     When F-17/F-18's checkpoint already holds act 0's stitch, `stageDetail()`
     returns the stored items and act 0 never goes through the stitcher, so
     `onActReady` never fires for it and no act boundary is ever timed. The
     resumed process did not take that long, and the process that did is gone;
     a number measured from THIS run's start would be a fiction. Reported as
     "not measured" instead. The same is true of any run that supplied no
     `deps.onActReady` — there was no act-boundary clock to read. */
  let ttlA1Ms: number | null = null;

  /* F-66 BACK-COMPAT: a checkpoint written before §4.8 was split per act holds
     one `stitch` key carrying the whole Foray's items. That work really was
     done and paid for, so it is read rather than discarded — and when it is
     there, the per-act path below is skipped entirely, exactly as the old
     single stage was. Nothing WRITES this key any more (see
     `StitchActCheckpointSchema`); the next fresh run for the prompt keys per
     act. */
  const legacyStitched = checkpoint.resumeSync("stitch", (raw) => StitchCheckpointSchema.parse(raw) as { items: ForayItem[] });
  if (legacyStitched) timings.markResumed("stitch");

  /* §4.8's per-act driver. Constructed BEFORE narration starts because it
     needs nothing narration produces: its continuity smoothing reads act
     N-1's exit and act N's introduction, both of them §4.4 output (see
     `smoothActIntroduction`). */
  const stitcher = new ForayStitcher(
    deepened,
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
              {
                id: forayId,
                title,
                topic,
                summary,
                authorId: options.userId,
                builtAt: startedAt,
                /* F-71: the same minted tier-2 tape the whole-Foray input
                   carries below. Without it the partial candidate's own
                   `finalizeForay` is handed a pool this run's segments are not
                   in, and reports them as unknown segment ids — a failure of
                   the input, not of the Foray. */
                segments: sourced.newSegments,
                segmentSources: sourced.newSegmentSources,
                root: options.root,
                /* F-79: the sourcing plan, so the partial's share-of-whole
                   rules (M4 above all) are judged on the projected whole
                   rather than on this act's slice — see partialProjection.ts. */
                projection: { sourcedActs: sourced.acts, slots }
              },
              finalize
            );
            await deps.onActReady!(candidate);
            /* G-30 (manual step 10): the partial-refusal exit. AFTER the
               callback, so the refused partial is on disk for whoever reads
               the report; BEFORE `checkpoint.stage` records this act's
               stitch, so a re-run rebuilds the refused act rather than
               resuming past it. */
            if (!candidate.validation.ok && options.refusedPartial === "abort") {
              throw new RefusedPartialError(
                actIndex,
                allActTitles.length,
                candidate.validation.checkForaysErrors,
                candidate.validation.checkNarrationErrors
              );
            }
          }
        : undefined
    },
    ctx
  );

  /* G-32: EVERY act's narration starts now, at once, through a gate of
     `narrationActConcurrency` acts in flight (default 4, env
     `NARRATION_ACT_CONCURRENCY`). The `narrate:<i>` stage is unchanged — same
     key, same per-slot `narrate:<i>:<slot>` keys, same `writeNarration` call
     handed one act — it is only no longer waited on before the next act's
     starts. The gate wraps the stage rather than the reverse so a resumed act
     (its `narrate:<i>` already banked) passes through in microseconds and the
     `narrate:<i>` timing measures narration, not queue time.

     WHY THE LOOP BELOW STILL RUNS IN ACT ORDER. §4.8 has two act-ordered
     dependencies narration does not: the continuity call at each boundary
     reads act N-1's exit into act N's introduction (`smoothActIntroduction`),
     and `itemsSoFar` — the partial candidate, and so `ttlA1Ms` — is acts 0..N
     concatenated. `ForayStitcher` makes that contract explicit ("acts must be
     handed in ascending order, one each"), so the loop awaits act i's
     narration, stitches it, and only then looks at act i+1 — which by then is
     usually already written. Act 0's stitch still fires `onActReady` for act 0
     the moment act 0 is narrated, so `ttlA1Ms` is what it was.

     WHAT HAPPENS ON A FAILURE. The promises are all started, so the loop
     cannot simply throw: acts still narrating would keep making model calls
     after this function had returned, into the next Foray's `usageTracking`
     bracket and with nobody to bank their slots. So a failure — a narration
     error, a `RefusedPartialError` from a stitch — aborts the gate (queued
     acts never start), waits for every in-flight act to settle (their slots
     land in the checkpoint as they finish, which is the point of F-51's key),
     and THEN rethrows the original error. The wait is bounded by one act's
     narration.

     THE COST OF THAT ORDER, NAMED (F-87). Act 0's partial is validated only
     when the ordered loop below reaches act 0's stitch — and by then EVERY
     act's narration has started, and with the default concurrency (4) has
     been paid for. Run 7 attempt 3 narrated 81 calls before act 1's partial
     was refused for a segment sourcing should never have minted. The design
     stays (the narration is still the right narration; only the tape was
     wrong, and sourcing now refuses it) but the report says where the abort
     landed: `generateForays.ts` carries `RefusedPartialError.actIndex` and
     `totalActs` into `report.json` as `refusedAtAct`, so a reader can count
     what the ordering cost against what it saved. */
  const actConcurrency = options.narrationActConcurrency ?? narrationActConcurrency();
  const gate = createActGate(actConcurrency);
  /* F-88: which acts' narration has landed, by position, for the synthesis
     pass — it reads the whole Foray's verified pages, and `writeNarration`
     is handed one act. A rejected act contributes nothing; the ordered loop
     reports its error when it reaches it. Declared BEFORE the acts start
     because F-97 reads it from inside them too (`ground`). */
  const settledActs: Array<WrittenAct | undefined> = [];
  const narrations: Array<Promise<WrittenAct>> = sourced.acts.map((act, i) => {
    const p = gate.run(() =>
      stage(
        `narrate:${i}`,
        (raw) => WrittenActSchema.parse(raw) as WrittenAct,
        async () => {
          const [one] = await writeNarration(
            [act],
            {
              writer: countingNarrationWriter,
              verifier: countingNarrationVerifier,
              /* G-34: one accumulator shared by every concurrent act — a
                 plain counter the stage increments; `meta.veracity` reads
                 it once every act has settled. */
              stats: narrationStats,
              /* G-35: the prefetched packs — ONE gatherer shared by every
                 concurrent act, so each act's gathers are memo lookups
                 against the fan-out that ran before this gate opened.
                 Requirements §8.1 still holds — the gatherer inside was
                 built with the same cue provider §4.5 sources against, so a
                 tape beat's evidence pack holds the cue window and not just
                 the episode title. */
              evidence,
              /* `writeNarration` is handed ONE act, so its own act index is
                 always 0; `i` is what names the slot's key. */
              resume: (_actIndex, slotIndex) =>
                checkpoint.resumeSync(`narrate:${i}:${slotIndex}`, (raw) => WrittenSlotSchema.parse(raw) as WrittenSlot),
              onSlotWritten: (_actIndex, slotIndex, slot) => checkpoint.save(`narrate:${i}:${slotIndex}`, slot),
              /* Q-02: the rows tier 2 minted this run, so an Intro before a
                 clip the committed registry does not hold yet can still be
                 checked against its show and episode title. */
              segmentSources: sourced.newSegmentSources,
              /* F-97: F-88's ground on the act path — the verified pages of
                 the acts that have already landed when THIS act starts. With
                 `actConcurrency` acts starting together the first wave sees
                 none; a later act's thesis seam may rest on them. */
              ground: () => verifiedPageSummaries(settledActs)
            },
            spine.voice,
            ctx
          );
          return one!;
        }
      )
    );
    /* A rejection here is reported by the ordered loop below when it reaches
       this act (or by `allSettled` on the failure path), never as an
       unhandled rejection in the meantime. `p` itself stays rejected. */
    p.catch(() => undefined);
    return p;
  });

  narrations.forEach((p, j) => {
    p.then(
      (a) => {
        settledActs[j] = a;
      },
      () => undefined
    );
  });

  const written: WrittenAct[] = [];
  try {
    for (let i = 0; i < sourced.acts.length; i++) {
      let writtenAct = await narrations[i]!;

      /* F-88: SYNTHESIS, between this act's narration landing and its stitch.
         A thesis Hinge whose retrieval found nothing (an F-60 hand-off) is
         written from the Foray's verified pages and verified as a
         generalisation of them — which needs every act's pages, so an act
         holding one waits for the others' narration to settle first. An act
         with none pays nothing. Its own `synthesis:<i>` key, so a resume
         neither re-pays for it nor loses it: `narrate:<i>` still holds the
         hand-off, and this stage holds the page that replaced it. Before the
         stitch, because the stitcher owns a page's leading and trailing
         sentences and the partial candidate leaves through `onActReady`. */
      if (countSynthesisCandidates(writtenAct) > 0) {
        await Promise.allSettled(narrations);
        const before = writtenAct;
        writtenAct = await stage(
          `synthesis:${i}`,
          (raw) => WrittenActSchema.parse(raw) as WrittenAct,
          () => verifyBySynthesis(before, i, settledActs, { writer: countingNarrationWriter, verifier: countingNarrationVerifier, stats: narrationStats }, spine.voice, ctx)
        );
      }
      written.push(writtenAct);

      if (legacyStitched) continue;

      /* THIS act, stitched now — not after the last act (F-66). Timed and
         checkpointed under its own `stitch:<i>` key, so a resume does not re-pay
         for an act that was already assembled and so the stage timing names the
         act rather than pretending §4.8 was one 58-minute step. */
      const { value: actItems, resumed } = await stageDetail(
        `stitch:${i}`,
        (raw) => StitchActCheckpointSchema.parse(raw) as ForayItem[],
        () => stitcher.stitchNextAct(writtenAct)
      );
      /* A resumed act never went through the stitcher, so it has to be told:
         act i+1's `itemsSoFar` is every act before it, banked or built. */
      if (resumed) stitcher.acceptStitchedAct(actItems);
    }
  } catch (err) {
    gate.abort(err instanceof Error ? err : new Error(String(err)));
    await Promise.allSettled(narrations);
    throw err;
  }

  /* G-32's evidence, for the report: one row per act off the same stage log
     the run already keeps, so a reader sees `startedAt` overlap rather than
     taking a shorter total on trust. */
  const narrationActs: NarrationActTiming[] = timings
    .all()
    .map((t) => ({ t, m: /^narrate:(\d+)$/.exec(t.name) }))
    .filter((x): x is { t: StageTiming; m: RegExpExecArray } => x.m !== null)
    .map(({ t, m }) => ({ act: Number(m[1]), startedAt: t.startedAt, ms: t.ms, ...(t.resumed ? { resumed: true as const } : {}) }))
    .sort((a, b) => a.act - b.act);

  /* §4.8's product, however it was assembled this run: every act's items in
     act order, each one either stitched inside the loop above or read back
     from its own `stitch:<i>` checkpoint (or, for a pre-F-66 checkpoint, the
     whole thing at once). */
  const stitchedItems = legacyStitched ? legacyStitched.items : stitcher.items();

  const generatedAt = now().toISOString();
  /* The disclosure is prepended here rather than inside stitch: it is a
     Foray-level obligation, not an act's content, and stitch has no concept of
     "the whole Foray" to attach it to. Prepending also keeps it out of the
     runtime sum below by construction — it is a spoken marker, not tape. */
  const items = [disclosureItem(intent.subject, slots[0]!.id), ...stitchedItems];

  /* WS-B: computed here, with the resolved `topic` (`tapeRelevance` needs
     it) and before `finalize` runs, so `meta.veracity` rides along on
     EVERY candidate this function returns — including one that fails
     check-forays/check-narration below, which `generateForays.ts` still
     records in `report.json` even though it never writes a candidate file. */
  /* G-35: printed now, when the hit rate is finally known, and carried into
     `report.json` through `meta.veracity.retrieval`. */
  console.log(`  ${evidence.summaryLine()}`);
  const veracity = buildVeracityMetrics({
    sourcedActs: sourced.acts,
    writtenActs: written,
    topic,
    writerCalls: narrationWriterCalls,
    verifierCalls: narrationVerifierCalls,
    retryRounds: narrationStats.retryRounds,
    pipelineTokens: getUsageTotals().total,
    stageTimings: timings.all(),
    retrieval: evidence.metrics(),
    tapeRelevanceRows: sourced.tapeRelevance,
    root: options.root
  });

  const input: FinalizeForayInput = {
    id: forayId,
    title,
    topic,
    summary,
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

  return {
    outcome: "generated",
    input,
    result,
    spine,
    spineReasks,
    tapeRelevance: sourced.tapeRelevance,
    topicDecision,
    timings: timings.all(),
    ttlA1Ms,
    narration: { concurrency: actConcurrency, acts: narrationActs }
  };
}
