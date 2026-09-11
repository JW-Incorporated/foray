import type { ForayItem } from "./forayItems";
import type { MintedSegmentSource } from "./audioSourceLookup";
import type { NewSegment } from "../types/tapeSourcing";
import { finalizeForay, type FinalizeForayInput, type FinalizeForayResult, type FinalizeForayValidation, type ForaySlot } from "./finalizeForay";

/**
 * WS-D2 — the partial-candidate shape (docs/curation/generation-fix-plan-2026-09-09.md,
 * "D2 (streaming publish)"), closing the gap `generation-architecture.md` §4.9
 * names explicitly and declines to resolve itself: "Making Act 1 playable
 * while later acts are written therefore needs either a schema/storage
 * mechanism... or an equivalent player-side streaming contract, neither of
 * which this document specifies... that is a finding for founder sign-off
 * before implementation, not a liberty taken here." This module IS that
 * mechanism, built per the fix plan's own spec: `acts[].status: "ready" |
 * "pending"`, top-level `status: "partial" | "complete"`, emitted as soon as
 * Act 1's items are finalised and rewritten as later acts complete.
 *
 * WHAT THIS DOES NOT CHANGE. §1.3's founder-reviewed PR remains the ONLY
 * gate for *catalogue* listing (`publishForay.ts` is untouched by this
 * module). A `PartialCandidate` is never written to `data/forays.json` and
 * never becomes one on its own — it exists only so the ONE listener who
 * asked for this Foray can start listening before the whole thing finishes,
 * per §1.4 ("playback starts before generation finishes") and the fix plan's
 * explicit "visibility: private... for the requesting listener only".
 *
 * VALIDATION REUSES §4.9's OWN GATES, SCOPED DOWN. `buildPartialCandidate`
 * calls the exact same `finalizeForay()` (or an injected stand-in — see
 * `runPipeline.ts`'s `RunPipelineDeps.finalize`, reused here rather than a
 * second seam) that the whole-Foray path uses, handed only the items/slots
 * finished so far — "validated with the same check-forays gates, but for
 * Act 1's [and, on a later call, each subsequent act's] items only," per the
 * fix plan. HONESTLY NOTED, not hidden: some of `check-forays.mjs`'s checks
 * (D5's inter-quartile floor over segment durations, for one) are sized for
 * a whole Foray's worth of segments and MAY read a short Act-1-only slice as
 * a false failure that the same content clears once every act is in. That is
 * a real, inherited scope limit of reusing the whole-Foray checker on a
 * subset — exactly the kind of validator-scope gap `finalizeForay.ts`'s own
 * doc comment already states plainly for `check-narration.mjs` — not a
 * silent claim that a partial candidate's `validation` is a preview of the
 * final verdict.
 */

export type PartialActStatus = "ready" | "pending";

export interface PartialCandidateAct {
  index: number;
  title: string;
  status: PartialActStatus;
}

export interface PartialCandidate {
  id: string;
  title: string;
  topic: string;
  summary: string;
  /** Top-level status, per the fix plan's own field name. "complete" once
   * every act named in `acts` is "ready" — still never published; see
   * module doc comment. */
  status: "partial" | "complete";
  /** Always "private" (fix plan, D2): a partial candidate is for the
   * requesting listener only, never the shared catalogue. */
  visibility: "private";
  /** The listener who asked for this Foray — `readPartialCandidate`
   * (`generationStatus.ts`) refuses to serve this document to anyone else. */
  authorId: string;
  acts: PartialCandidateAct[];
  slots: ForaySlot[];
  items: ForayItem[];
  runtimeSec: number;
  /** §4.9/WS-D2: prompt received -> Act 1 ready, in milliseconds. `null`
   * until Act 1 itself is the act just finished (set once, on the very
   * first `onActReady` call, and carried unchanged on every later
   * rewrite — see `runPipeline.ts`). */
  ttlA1Ms: number | null;
  /** ISO date string — when the pipeline run that produced this candidate
   * started (mirrors `FinalizeForayInput.builtAt`). */
  builtAt: string;
  /** ISO date string — when THIS act's write happened, so a poller can tell
   * a stale response from a fresh one without diffing the body. */
  updatedAt: string;
  validation: FinalizeForayValidation;
}

/** Per-act info `runForayPipeline` hands this module — everything
 * `stitchForay.ts`'s `onActReady` callback carries, plus the pipeline-level
 * bookkeeping (slots/runtime/ttl) only the orchestrator can compute. */
export interface PartialActInfo {
  actIndex: number;
  totalActs: number;
  /** Every act's title, in order — known from the frozen spine (§6.1)
   * before any act is written, so a "pending" act can be named honestly
   * rather than left blank. */
  allActTitles: string[];
  /** Cumulative items through this act, disclosure included. */
  items: ForayItem[];
  /** Cumulative slots through this act. */
  slots: ForaySlot[];
  runtimeSec: number;
  ttlA1Ms: number | null;
}

export interface PartialCandidateMeta {
  id: string;
  title: string;
  topic: string;
  summary: string;
  authorId: string;
  /** ISO date string, matching `FinalizeForayInput.builtAt`. */
  builtAt: string;
  /**
   * THIS RUN'S MINTED §4.5 TIER-2 TAPE, TRAVELLING WITH THE PARTIAL CANDIDATE
   * TOO (F-71) — the same `sourced.newSegments` / `sourced.newSegmentSources`
   * `runPipeline.ts` puts on the whole-Foray `FinalizeForayInput`, and for the
   * identical reason (see `FinalizeForayInput.segments`): a tier-2 pointer names
   * a segment that is not in `data/segments.json` yet, so a checker handed only
   * the on-disk pool cannot resolve it.
   *
   * WHAT LEAVING THEM OUT COST. Run 2 attempt 4b was the first run to source any
   * tier-2 tape, and its partial candidate came back with five `unknown segment_id
   * "practical-ai--federated-learning-in-production-part-2#1962" — not in
   * data/segments.json` errors and then "no resolvable segment items", while the
   * FINAL candidate — built from the same items, with these two fields — resolved
   * all five. A partial candidate whose validation fails on tape the Foray really
   * has is not a preview of anything; it says the streaming path is broken when
   * what is broken is the input it was handed. On the meta: these are run-level,
   * not per-act, which is why they sit here beside `builtAt` and `root` rather
   * than in `PartialActInfo`.
   *
   * Optional, so a caller that sourced no tier-2 tape (and every test written
   * before F-71) passes nothing and gets exactly today's behaviour.
   */
  segments?: NewSegment[];
  segmentSources?: MintedSegmentSource[];
  /** Repo root, forwarded to `finalize` exactly as `runPipeline.ts` forwards
   * it to the whole-Foray `finalize` call. */
  root?: string;
}

export type FinalizeFn = (input: FinalizeForayInput, root?: string) => Promise<FinalizeForayResult>;

/**
 * Builds one `PartialCandidate` snapshot. Called once per act, from
 * `stitchForay`'s `onActReady` (via `runForayPipeline`) — see that stage's
 * doc comment for why the callback fires where it does.
 *
 * `finalize` defaults to the real `finalizeForay`, matching
 * `RunPipelineDeps.finalize`'s own default/injection pattern (that same
 * seam exists because Vitest cannot load `tools/foray/*.mjs` under a
 * Windows checkout with a space in the path — see `runPipeline.ts`'s doc
 * comment on `RunPipelineDeps.finalize`). `runForayPipeline` passes its own
 * resolved `finalize` through here so the two calls agree on which
 * implementation ran.
 */
export async function buildPartialCandidate(info: PartialActInfo, meta: PartialCandidateMeta, finalize: FinalizeFn = finalizeForay): Promise<PartialCandidate> {
  const finalizeInput: FinalizeForayInput = {
    id: meta.id,
    title: meta.title,
    topic: meta.topic,
    summary: meta.summary,
    slots: info.slots,
    items: info.items,
    runtimeSec: info.runtimeSec,
    builtAt: meta.builtAt,
    /* F-71 — see `PartialCandidateMeta.segments`. The partial candidate is
       validated against the same pool the final one is, so it fails and passes
       on the same rules instead of on which segments the checker could see. */
    segments: meta.segments,
    segmentSources: meta.segmentSources
  };
  const result = await finalize(finalizeInput, meta.root);

  const status: "partial" | "complete" = info.actIndex + 1 >= info.totalActs ? "complete" : "partial";
  const acts: PartialCandidateAct[] = info.allActTitles.map((title, index) => ({
    index,
    title,
    status: index <= info.actIndex ? "ready" : "pending"
  }));

  return {
    id: meta.id,
    title: meta.title,
    topic: meta.topic,
    summary: meta.summary,
    status,
    visibility: "private",
    authorId: meta.authorId,
    acts,
    slots: info.slots,
    items: info.items,
    runtimeSec: info.runtimeSec,
    ttlA1Ms: info.ttlA1Ms,
    builtAt: meta.builtAt,
    updatedAt: new Date().toISOString(),
    validation: result.validation
  };
}
