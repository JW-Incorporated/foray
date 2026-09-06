import { GenerationRequestSchema, type GenerationRequest } from "../types/generation";
import { StageTimingLog, type StageTiming } from "./stageTiming";

import { understandPrompt } from "./understandPrompt";
import { buildResearchShape } from "./researchShape";
import { buildSpine } from "./buildSpine";
import { deepenActs } from "./deepenActs";
import { sourceBeats } from "./sourceBeats";
import { writeNarration } from "./writeNarration";
import { stitchForay } from "./stitchForay";
import { finalizeForay, type FinalizeForayInput, type FinalizeForayResult, type ForaySlot } from "./finalizeForay";
import { resolveTopic, forayIdFor, type TopicCandidate } from "./resolveTopic";
import { slugifySlotTitle } from "./forayItems";
import { loadSegmentPool, type SegmentRecord } from "./segmentPoolLookup";
import { NARRATION_CHARS_PER_SEC } from "../types/narration";
import { disclosureTemplate } from "../types/narration";

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
import type { TranscriptCueProvider } from "./transcriptArchiveLookup";
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
      timings: StageTiming[];
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

export async function runForayPipeline(
  request: GenerationRequest,
  options: RunPipelineOptions,
  deps: RunPipelineDeps = {}
): Promise<RunPipelineOutcome> {
  const req = GenerationRequestSchema.parse(request);
  const timings = new StageTimingLog();
  const now = options.now ?? (() => new Date());
  const ctx = { userId: options.userId, sessionId: options.sessionId };

  const understander = deps.understander ?? createPromptUnderstander();
  const researcher = deps.researcher ?? createExternalResearcher();
  const spineBuilder = deps.spineBuilder ?? createSpineBuilder();
  const deepenBuilder = deps.deepenBuilder ?? createDeepenActBuilder();
  const narrationWriter = deps.narrationWriter ?? createNarrationWriterBuilder();
  const narrationVerifier = deps.narrationVerifier ?? createNarrationVerifierBuilder();
  const continuityBuilder = deps.continuityBuilder ?? createContinuityBuilder();

  /* §4.0-4.1 — safety, then intent. Both non-"understood" outcomes end the run:
     a rejected prompt must not be researched, and a prompt we cannot read one
     way must not be guessed at. */
  const understood = await timings.run("understand", () => understandPrompt(req.prompt, understander, ctx));
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

  // §4.2 — research to establish shape.
  const researchShape = await timings.run("research", () =>
    buildResearchShape(intent, { researcher, ctx })
  );

  // §4.3 — the spine, frozen from here on (§6.1's invariant, batch-true).
  const spine = await timings.run("spine", () => buildSpine(intent, researchShape, req.duration, spineBuilder, ctx));

  // §4.4 — deepen every act, in parallel across acts.
  const deepened = await timings.run("deepen", () => deepenActs(spine, deepenBuilder, ctx));

  /* §4.5-4.6 — source each beat against tape, then resolve the pointer. Purely
     deterministic and keyless: no LLM call happens in here at all. The cue
     provider is what decides whether tier-2 can anchor a real span or whether
     the beat degrades to narration for this run. */
  const sourced = await timings.run("source", async () =>
    sourceBeats(deepened, { cueProvider: deps.cueProvider })
  );

  // §4.7 — write narration, then verify it independently (distinct instances, enforced there).
  const written = await timings.run("narrate", () =>
    writeNarration(sourced.acts, { writer: narrationWriter, verifier: narrationVerifier }, spine.voice, ctx)
  );

  // §4.8 — stitch, smoothing each act's introduction against the one before it.
  const stitched = await timings.run("stitch", () =>
    stitchForay(deepened, written, { continuity: { builder: continuityBuilder } }, ctx)
  );

  /* The Foray-level fields §4.9 says nothing upstream owns. Resolved here
     because this is the first place that has both the intent and the finished
     spine to resolve them from. An unresolvable topic stops the run BEFORE
     finalize: publishing under a wrong-but-valid taxonomy node is the one
     failure `check-forays.mjs` cannot catch, since it only asks whether the
     node exists. */
  const generatedAt = now().toISOString();
  const title = `${intent.subject}${intent.angle ? `: ${intent.angle}` : ""}`.slice(0, 120);
  const topicText = [intent.subject, intent.angle, spine.acts.map((a) => a.title).join(" ")].join(" ");
  const topic = options.topic ?? resolveTopic(topicText, { root: options.root }).resolved;
  if (!topic) {
    return {
      outcome: "unresolved-topic",
      title,
      candidates: resolveTopic(topicText, { root: options.root }).candidates,
      timings: timings.all()
    };
  }

  const slots = slotsFromSpine(spine);
  /* The disclosure is prepended here rather than inside stitch: it is a
     Foray-level obligation, not an act's content, and stitch has no concept of
     "the whole Foray" to attach it to. Prepending also keeps it out of the
     runtime sum below by construction — it is a spoken marker, not tape. */
  const items = [disclosureItem(intent.subject, slots[0]!.id), ...stitched.items];

  const input: FinalizeForayInput = {
    id: forayIdFor(title, generatedAt),
    title,
    topic,
    summary: intent.subject,
    slots,
    items,
    runtimeSec: runtimeSecFor(items),
    builtAt: generatedAt
  };

  // §4.9 — validate against the same two checkers CI runs. Writes nothing.
  const finalize = deps.finalize ?? finalizeForay;
  const result = await timings.run("finalize", () => finalize(input, options.root));

  return { outcome: "generated", input, result, spine, timings: timings.all() };
}
