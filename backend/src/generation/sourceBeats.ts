import type { Beat, DeepenedAct } from "../types/spine";
import type {
  NewSegment,
  SourcedAct,
  SourcedBeat,
  SourcedSlot,
  SourceBeatsResult,
  SourcingTrace,
  TapePointer,
  TapeRelevanceInput,
  Tier1Gate,
  Tier1TraceRow,
  Tier2Gate,
  Tier2TraceRow,
  TranscriptionQueueCandidate
} from "../types/tapeSourcing";
import { validateSourcing } from "../types/tapeSourcing";
import type { AudioSourceResolver, MintedSegmentSource } from "./audioSourceLookup";
import {
  familiesOfNodes,
  familyGateAllows,
  isOnTopic,
  taxonomyNodesForItemId,
  taxonomyNodesForShowId,
  taxonomyRoot,
  unionNodes
} from "./taxonomyFamily";

/** check-forays' M4 cap, mirrored. The checker stays the authority; this only
    keeps sourcing from building something it will certainly reject. */
export const M4_ITEM_SHARE_MAX = 0.25;
import {
  findTier1Match,
  loadSegmentPool,
  requiredOverlapFor,
  scoreSegmentsAgainstClaim,
  TIER1_MATCH_THRESHOLD,
  type SegmentRecord,
  type SegmentWindowText
} from "./segmentPoolLookup";
import {
  ANCHOR_WINDOW_PAD_SEC,
  anchoredWindowEvidence,
  type AnchoredWindowEvidence,
  anchoredWindowIsOnTopic,
  bestTranscriptArchiveCandidate,
  cueWindowText,
  findTranscriptArchiveMatch,
  loadTranscriptArchive,
  MIN_ANCHOR_WORDS,
  resolveAnchorFromCues,
  titleTokenScore,
  NullTranscriptCueProvider,
  TIER2_MATCH_THRESHOLD,
  TIER2_WINDOW_OVERLAP_MIN,
  type ResolvedAnchorSpan,
  type TranscriptCueProvider,
  type TranscriptDigestEntry
} from "./transcriptArchiveLookup";
import {
  NullTranscriptTextIndex,
  TRANSCRIPT_TEXT_CANDIDATES,
  type TranscriptTextCandidate,
  type TranscriptTextIndex
} from "./transcriptTextIndex";
import { tokenizeForSourcing } from "./catalogueLookup";

/**
 * §4.5-4.6 orchestrator (docs/curation/generation-architecture.md §4.5,
 * §4.6): takes §4.4's `DeepenedAct[]` and decides, for every beat, HOW it
 * is sourced — real tape (resolved to a §4.6 pointer) or narration
 * (flagged Patch/Carry for §4.7, which this module does not write).
 *
 * WHY NO LLM COLLABORATOR HERE, UNLIKE §4.3's SpineBuilder / §4.4's
 * DeepenActBuilder (a deliberate departure this stage's own task brief
 * explicitly allows, and asks to be flagged as a finding): §4.5's task
 * brief says the LLM builder pattern applies "likely only for the
 * semantic-match step against segments.json, not for the deterministic
 * anchor/pointer math," and explicitly prefers "a deterministic scorer
 * with a confidence threshold over calling out to the LLM (if needed at
 * all)." `segmentPoolLookup.ts` and `transcriptArchiveLookup.ts`
 * implement exactly that: a tokenize-and-score matcher (reusing
 * `catalogueLookup.ts`'s tokenizer) against a fixed threshold, which is
 * enough to pass or fail every §4.5 tier deterministically. There is
 * therefore no LLM call in this module's normal path, no
 * `*Builder`/`Stub*`/`Anthropic*`/`create*` quad, and no
 * `defaultBudgetGuard.checkAndRecord(...)` call site — none of the three
 * would have anything to guard, and adding one that always records a
 * zero-cost stub event would be dead ceremony, not safety. If a future
 * pass finds the deterministic threshold too blunt for ambiguous claims,
 * an LLM tie-breaker slots in cleanly behind the SAME `findTier1Match` /
 * `findTranscriptArchiveMatch` call sites this module already isolates
 * matching behind — that is the seam to extend, not a reason to build
 * an unused builder quad today.
 *
 * §1.1 / §4.6 SEEK-AND-STOP: nothing in this module fetches, downloads,
 * or persists an audio byte. `NullTranscriptCueProvider` is the default
 * cue source and always returns `null` (see its doc comment) — the ONLY
 * network-adjacent capability plugged in here is a caller-supplied
 * `TranscriptCueProvider`, and the interface itself can only return
 * already-on-disk TEXT cues, never audio. There is no code path in this
 * module, its default provider, or its two lookup modules that opens an
 * HTTP connection or writes a byte to `data-local/` — verified
 * structurally by `sourceBeats.noFetch.test.ts` (module-source grep for
 * fetch/http/download call sites), not asserted only in prose.
 *
 * WHAT GENERATION RUN 1 CHANGED HERE (fix plan WS-C; findings F-06, F-23,
 * F-24, F-29, F-33, F-38). Attempt 4 finished with 5 of 22 tape anchors on
 * topic: a Kansas City walkway beat took a British hearth-cooking segment, a
 * barbecue show and four geology episodes turned up in a Foray about
 * engineering disasters, and an analytical beat — a thesis no recording can be
 * about — was given tape at all. Every one of those was this module matching
 * words against a PROXY for the tape (a title, an 18-word curator note) with no
 * check that the two were about the same subject. Four things changed, none of
 * them a new model call:
 *
 *   1. a beat §4.4 tagged `kind: "argument"` skips the tape search entirely;
 *   2. tier 1 scores the claim against the TRANSCRIPT the segment was cut from
 *      when a cue provider can supply it, falling back to metadata only when it
 *      cannot;
 *   3. tier 2 must find the claim's words spoken AROUND its anchor, not merely
 *      somewhere in the same hour of tape, and what it mints is cut to whole
 *      cues with a minimum duration instead of being the anchor's own few
 *      seconds;
 *   4. a candidate must share a taxonomy family — a LINEAGE, see
 *      `taxonomyFamily.ts` — with the Foray's resolved topic, which is why
 *      `runPipeline.ts` now resolves the topic before sourcing.
 *
 * The topic gate reads `data/taxonomy.json`, `data/catalog.json`,
 * `data/segment-sources.json` (and, for a numeric breadth show id only,
 * `data/breadth-classification.json`) through `taxonomyFamily.ts`. All are
 * committed catalogue files, same as `data/segments.json`; the SEEK-AND-STOP
 * property above is unchanged.
 */

export interface SourceBeatsOptions {
  segmentPool?: SegmentRecord[];
  transcriptArchive?: TranscriptDigestEntry[];
  cueProvider?: TranscriptCueProvider;
  /**
   * §4.5 tier-2's CANDIDATE SEARCH over what the archive actually says
   * (`transcriptTextIndex.ts`; fix plan WS-H, findings F-06 and F-49).
   *
   * Defaults to `NullTranscriptTextIndex`, which returns nothing — so a caller
   * that supplies no index (CI, every test written before WS-H) gets exactly
   * the title-metadata path tier 2 has always walked, and a machine that holds
   * the transcript bodies gets a search over the text. Same shape and same
   * default-to-honest-nothing contract as `cueProvider` above.
   */
  textIndex?: TranscriptTextIndex;
  /**
   * The Foray's resolved `data/taxonomy.json` node (§4.5's TOPIC GATE).
   *
   * Supplied by `runPipeline.ts`, which now resolves the topic BEFORE sourcing
   * for exactly this reason. Omitted, the gate is inert and sourcing behaves as
   * it did before run 1 — which is the right default for a caller that has no
   * topic to gate on, and never happens in a real run.
   */
  topic?: string | null;
  /** Repo root for the catalogue reads the topic gate makes. Tests only. */
  root?: string;
  /**
   * Resolves the `data/segment-sources.json` row for an episode tier 2 wants to
   * mint a segment from (`audioSourceLookup.ts`).
   *
   * INERT WHEN OMITTED, like `topic` above and for the same reason: a caller
   * with no way to resolve audio behaves exactly as this module did before the
   * resolver existed. `runPipeline.ts` always supplies one, and with it in place
   * tier 2 will not mint tape for an episode whose audio cannot be honestly
   * registered — a segment nothing can play is not tape, and
   * `check-forays.mjs` rejects the Foray that references it ("nothing can
   * resolve its audio").
   */
  audioSourceFor?: AudioSourceResolver;
}

/**
 * Sources every beat of every deepened act. Pure function over its
 * inputs (plus whatever `cueProvider` is asked to resolve) — no network,
 * no writes, matching §1.1/§4.6.
 */
export function sourceBeats(deepenedActs: DeepenedAct[], options: SourceBeatsOptions = {}): SourceBeatsResult {
  const segmentPool = options.segmentPool ?? loadSegmentPool();
  const transcriptArchive = options.transcriptArchive ?? loadTranscriptArchive();
  const cueProvider = options.cueProvider ?? new NullTranscriptCueProvider();
  const textIndex = options.textIndex ?? new NullTranscriptTextIndex();

  const newSegments: NewSegment[] = [];
  /* One row per episode a segment was minted from, deduplicated by item id:
     `check-forays.mjs` requires exactly one registry entry per item id, and two
     beats commonly take two segments from one episode. */
  const newSegmentSources = new Map<string, MintedSegmentSource>();
  const transcriptionQueueCandidates: TranscriptionQueueCandidate[] = [];
  const mintedIds = new Set<string>(segmentPool.map((s) => s.id));
  /* What THIS Foray has already committed to. Both are Foray-wide, not
     per-slot, because both rules they serve span the whole running order:
       - `usedSegmentIds` — a segment may not play twice;
       - `lastStartByItem`  — segments from one episode must play in ascending
         time order (check-forays' M3), so an episode already heard at 1964 s
         cannot later be joined at 900 s.
     A set scoped to a slot or an act would satisfy neither. */
  const usedSegmentIds = new Set<string>();
  const lastStartByItem = new Map<string, number>();
  /* M4: no single episode may be more than a quarter of a Foray. The checker
     measures share of segments AND of runtime; sourcing can only bound the
     first, because it places beats one at a time and does not know the final
     runtime until stitching. Bounding the count is what is available here and
     it is what was actually failing ("33.3 % of segments and 33.0 % of
     runtime") — the two track each other closely enough that holding the count
     under the cap holds the runtime under it too in practice, and check-forays
     remains the authority either way.

     The cap is computed from the total beat count up front rather than adjusted
     as the Foray grows: a running denominator would let the first episode take
     three beats before the fourth beat made three too many, which is how a
     greedy cap ends up over the line at the end. */
  const totalBeats = deepenedActs.reduce(
    (n, act) => n + act.slots.reduce((m, slot) => m + slot.beats.length, 0),
    0
  );
  const maxPerItem = Math.max(1, Math.floor(totalBeats * M4_ITEM_SHARE_MAX));
  const usedCountByItem = new Map<string, number>();

  const forayTopic = options.topic ?? null;
  const state: SourcingState = {
    segmentPool,
    transcriptArchive,
    cueProvider,
    textIndex,
    windowText: makeSegmentWindowText(transcriptArchive, cueProvider),
    forayTopic,
    root: options.root,
    audioSourceFor: options.audioSourceFor,
    mintedIds,
    newSegments,
    newSegmentSources,
    transcriptionQueueCandidates,
    usedSegmentIds,
    lastStartByItem,
    usedCountByItem,
    maxPerItem
  };
  const tapeRelevance: TapeRelevanceInput[] = [];
  /* One row per narration-degraded beat, saying what each tier saw and which
     gate refused it (F-49). The two arrays partition the Foray's beats. */
  const sourcingTrace: SourcingTrace[] = [];

  const acts: SourcedAct[] = deepenedActs.map((act, actIndex) => {
    const slots: SourcedSlot[] = act.slots.map((slot, slotIndex) => {
      // Resolve tape-or-not for every beat in the slot FIRST, because the
      // Patch/Carry decision needs to know whether ANY beat in this slot —
      // not just this one — ended up tape-sourced (§4.5: "pick based on
      // whether the SLOT the beat belongs to has any other tape-sourced
      // beats").
      const resolutions = slot.beats.map((beat) => resolveOneBeat(beat, state));
      const slotHasTape = resolutions.some((r) => r.kind === "tape");

      const beats: SourcedBeat[] = slot.beats.map((beat, beatIndex) => {
        const resolution = resolutions[beatIndex]!;
        if (resolution.kind === "tape") {
          tapeRelevance.push({
            actIndex,
            slotIndex,
            beatIndex,
            claim: beat.claim,
            itemId: resolution.pointer.itemId,
            segmentId: resolution.pointer.segmentId,
            tier: resolution.pointer.tier,
            taxonomyNodeIds: resolution.nodes,
            families: familiesOfNodes(resolution.nodes),
            forayTopic,
            forayFamily: taxonomyRoot(forayTopic),
            onTopic: isOnTopic(forayTopic, resolution.nodes, state.root)
          });
          return { sourcing: "tape", claim: beat.claim, exploration: beat.exploration, kind: beat.kind, tape: resolution.pointer };
        }
        sourcingTrace.push({
          actIndex,
          slotIndex,
          beatIndex,
          claim: beat.claim,
          outcome: resolution.diagnosis.outcome,
          tier1: resolution.diagnosis.tier1,
          tier2: resolution.diagnosis.tier2
        });
        // Narration: Patch when this slot has other tape-sourced beats
        // (this beat supplies what that tape misses); Carry when the
        // slot has no tape at all (this beat IS the content).
        const mode = slotHasTape ? "Patch" : "Carry";
        const reason = slotHasTape
          ? `${resolution.reason} Slot "${slot.title}" has other tape-sourced beats — this beat patches what the slot's tape misses.`
          : `${resolution.reason} Slot "${slot.title}" has no tape-sourced beats at all — this beat carries the content alone.`;
        return { sourcing: "narration", claim: beat.claim, exploration: beat.exploration, kind: beat.kind, narration: { mode, reason } };
      });

      return { title: slot.title, beats };
    });

    return { title: act.title, slots };
  });

  const validation = validateSourcing(deepenedActs, acts);
  if (!validation.valid) {
    // This should be structurally unreachable — resolveOneBeat/the map
    // above never drop, add, or reorder a beat — but fail loudly rather
    // than silently violate §4.5's own guardrail if it ever is.
    throw new Error(`sourceBeats violated the beat-preservation guardrail: ${validation.issues.map((i) => i.message).join("; ")}`);
  }

  return { acts, newSegments, transcriptionQueueCandidates, tapeRelevance, sourcingTrace, newSegmentSources: [...newSegmentSources.values()] };
}

/**
 * One line per slot: how much of it is tape, how much is narration, and the
 * single most common reason its narrated beats got no tape (F-49).
 *
 * A pure function returning strings rather than something that prints: the
 * pipeline prints these, tests read them, and a batch driver could put them in
 * a report without this module knowing about any of the three.
 *
 * THE "TOP REASON" IS WHERE THE BEATS GOT FURTHEST. A beat that never reached
 * tier 2 is reported against tier 1; a beat whose search reached a real episode
 * is reported against tier 2, because that is the gate whose threshold a human
 * would go and look at. Ties break toward the reason that appears first in the
 * slot, so the line is stable for a given slot.
 */
export function summarizeSourcing(result: SourceBeatsResult): string[] {
  const traceByBeat = new Map<string, SourcingTrace>();
  for (const t of result.sourcingTrace) traceByBeat.set(`${t.actIndex}:${t.slotIndex}:${t.beatIndex}`, t);

  const lines: string[] = [];
  result.acts.forEach((act, actIndex) => {
    act.slots.forEach((slot, slotIndex) => {
      let tape = 0;
      const reasons = new Map<string, number>();
      slot.beats.forEach((beat, beatIndex) => {
        if (beat.sourcing === "tape") {
          tape += 1;
          return;
        }
        const trace = traceByBeat.get(`${actIndex}:${slotIndex}:${beatIndex}`);
        const reason = trace ? topReasonFor(trace) : "unknown";
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      });
      const narration = slot.beats.length - tape;
      let top: string | null = null;
      let topCount = 0;
      for (const [reason, count] of reasons) {
        if (count > topCount) {
          top = reason;
          topCount = count;
        }
      }
      lines.push(
        `source: act ${actIndex + 1} slot ${slotIndex + 1} "${slot.title}" — ${tape} tape / ${narration} narration` +
          (top ? `; top reason: ${top} (${topCount} of ${narration})` : "")
      );
    });
  });
  return lines;
}

/** The one label that best explains a narrated beat — see `summarizeSourcing`. */
export function topReasonFor(trace: SourcingTrace): string {
  if (trace.outcome === "skipped:argument") return "skipped:argument";
  if (trace.tier2 && trace.tier2.bestEpisodeTitle) return `tier2:${trace.tier2.gate}`;
  if (trace.tier1) return `tier1:${trace.tier1.gate}`;
  return trace.tier2 ? `tier2:${trace.tier2.gate}` : "no-tape";
}

/** Everything `resolveOneBeat` needs, gathered once so the beat-level function
 * takes one argument instead of eleven. Mutable members are the Foray-wide
 * ledgers documented in `sourceBeats` above. */
interface SourcingState {
  segmentPool: SegmentRecord[];
  transcriptArchive: TranscriptDigestEntry[];
  cueProvider: TranscriptCueProvider;
  /** See `SourceBeatsOptions.textIndex` — the Null index makes tier 2's
   * candidate search exactly the title search it was before WS-H. */
  textIndex: TranscriptTextIndex;
  windowText: SegmentWindowText;
  /** The Foray's resolved `data/taxonomy.json` node — the gate's left-hand
   * side. Null when the caller had none, which makes the gate inert. */
  forayTopic: string | null;
  root: string | undefined;
  /** See `SourceBeatsOptions.audioSourceFor` — undefined leaves tier 2 exactly
   * as it was before a minted segment had to be resolvable to audio. */
  audioSourceFor: AudioSourceResolver | undefined;
  mintedIds: Set<string>;
  newSegments: NewSegment[];
  newSegmentSources: Map<string, MintedSegmentSource>;
  transcriptionQueueCandidates: TranscriptionQueueCandidate[];
  usedSegmentIds: Set<string>;
  lastStartByItem: Map<string, number>;
  usedCountByItem: Map<string, number>;
  maxPerItem: number;
}

/** The trace rows a narration-degraded beat carries out with it — the caller
 * adds the beat's own position and claim (F-49). */
interface SourcingDiagnosis {
  outcome: "skipped:argument" | "no-tape";
  tier1: Tier1TraceRow | null;
  tier2: Tier2TraceRow | null;
}

type BeatResolution =
  /** `nodes` — every taxonomy node this anchor resolved to, the same union the
   * gate judged it on and the one WS-B's metric recomputes from disk. */
  | { kind: "tape"; pointer: TapePointer; nodes: string[] }
  | { kind: "narration"; reason: string; diagnosis: SourcingDiagnosis };

/**
 * Whether a pool segment may be used, and if not, WHICH rule refused it.
 *
 * Extracted from `findTier1Match`'s inline predicate so the trace can name the
 * gate that stopped the best candidate instead of reporting a bare "no match"
 * (F-49). The check order is unchanged, and `tier1IsUsable` below is the same
 * predicate the search has always been given — a boolean view of this one.
 */
function tier1VetoFor(segment: SegmentRecord, state: SourcingState): Exclude<Tier1Gate, "no-candidates" | "threshold"> | null {
  /* THE TOPIC GATE (F-29). The pool has always carried a `topic` node per
     segment and the Foray has always had one; nothing compared them, which is
     how a Kansas City walkway beat took a British hearth-cooking segment.
     Checked inside the ranked walk, like the assembly rules below, so the
     search falls through to the next ON-TOPIC candidate instead of giving up. */
  if (!familyGateAllows(state.forayTopic, nodesForSegment(segment, state), state.root)) return "topic-lineage";
  /* Already spoken for by an earlier beat of this Foray — F-29's "exhaustion of
     the one relevant episode", which is what sent run 1 to a griddle segment. */
  if (state.usedSegmentIds.has(segment.id)) return "exhausted";
  if ((state.usedCountByItem.get(segment.item_id) ?? 0) >= state.maxPerItem) return "m4-share";
  const lastStart = state.lastStartByItem.get(segment.item_id);
  // Same episode, earlier in the tape than one already placed -> M3 violation.
  if (lastStart !== undefined && segment.start_sec < lastStart) return "m3-order";
  return null;
}

function tier1IsUsable(segment: SegmentRecord, state: SourcingState): boolean {
  return tier1VetoFor(segment, state) === null;
}

/** What tier 1 saw, once it has decided it has nothing (F-49). Must be called
 * BEFORE any ledger is updated for this beat, or the vetoes it reports would be
 * the beat's own footprint. */
function traceTier1(claim: string, state: SourcingState): Tier1TraceRow {
  const best = scoreSegmentsAgainstClaim(claim, state.segmentPool, { windowText: state.windowText })[0];
  if (!best) {
    return { bestSegmentId: null, bestItemId: null, score: 0, requiredScore: TIER1_MATCH_THRESHOLD, matchedIn: null, gate: "no-candidates" };
  }
  const requiredScore = requiredOverlapFor(best.matchedIn, best.claimTokenCount);
  const gate: Tier1Gate = best.score < requiredScore ? "threshold" : (tier1VetoFor(best.segment, state) ?? "exhausted");
  return {
    bestSegmentId: best.segment.id,
    bestItemId: best.segment.item_id,
    score: best.score,
    requiredScore,
    matchedIn: best.matchedIn,
    gate
  };
}

/** What tier 2 saw when no episode cleared its threshold: the best on-topic
 * episode and the title-token bar it missed, or — when the topic gate is what
 * emptied the field — the best episode of any family, named as such (F-49). */
function traceTier2Rejected(claim: string, state: SourcingState, isUsable: (entry: TranscriptDigestEntry) => boolean): Tier2TraceRow {
  const onTopic = bestTranscriptArchiveCandidate(claim, state.transcriptArchive, isUsable);
  if (onTopic) return archiveTraceRow(onTopic.entry, onTopic.score, "title-tokens");
  const anyFamily = bestTranscriptArchiveCandidate(claim, state.transcriptArchive);
  if (anyFamily) return archiveTraceRow(anyFamily.entry, anyFamily.score, "lineage");
  return { bestShowId: null, bestEpisodeTitle: null, score: 0, requiredScore: TIER2_MATCH_THRESHOLD, gate: "title-tokens" };
}

function archiveTraceRow(entry: TranscriptDigestEntry, score: number, gate: Tier2TraceRow["gate"]): Tier2TraceRow {
  return { bestShowId: entry.show_id, bestEpisodeTitle: entry.title, score, requiredScore: TIER2_MATCH_THRESHOLD, gate };
}

function resolveOneBeat(beat: Beat, state: SourcingState): BeatResolution {
  const claim = beat.claim;

  /* ARGUMENTS ARE NOT ON TAPE (F-38). A thesis about a class of events —
     "every link in a failure chain gets evaluated against a local question and
     almost never against the global one" — has no episode that is about it, so
     the only thing a word scorer can return for it is a coincidence, and in run
     1 it returned a *Geology Bites* episode on banded iron formations. Skipping
     the lookup outright is the difference between that beat being narrated by
     design and being narrated by luck (under the raised thresholds it would
     have scored 2 and fallen through — right answer, wrong reason). No
     transcription-queue candidate is logged either: nothing to transcribe would
     ever help. */
  if (beat.kind === "argument") {
    return {
      kind: "narration",
      reason: "This beat is an argument, not an account — §4.5 does not look for tape for a claim no recording can be about.",
      diagnosis: { outcome: "skipped:argument", tier1: null, tier2: null }
    };
  }

  // Tier 1: existing data/segments.json pool. Cheapest possible hit,
  // tried first, per §4.5's own search order — no new segment is ever
  // created here.
  const tier1 = findTier1Match(claim, state.segmentPool, (segment) => tier1IsUsable(segment, state), { windowText: state.windowText });
  if (tier1) {
    state.usedSegmentIds.add(tier1.segment.id);
    state.lastStartByItem.set(tier1.segment.item_id, tier1.segment.start_sec);
    state.usedCountByItem.set(tier1.segment.item_id, (state.usedCountByItem.get(tier1.segment.item_id) ?? 0) + 1);
    return {
      kind: "tape",
      nodes: nodesForSegment(tier1.segment, state),
      pointer: {
        segmentId: tier1.segment.id,
        itemId: tier1.segment.item_id,
        startSec: tier1.segment.start_sec,
        endSec: tier1.segment.end_sec,
        startAnchor: tier1.segment.start_anchor,
        endAnchor: tier1.segment.end_anchor,
        tier: 1,
        confidence: tier1.segment.confidence
      }
    };
  }

  /* Tier 1 has nothing. Record what it saw NOW, while the Foray-wide ledgers
     still hold only what earlier beats committed to (F-49). */
  const tier1Trace = traceTier1(claim, state);

  /* TIER 2: THE TRANSCRIPT ARCHIVE, ASKED WHAT IT SAYS (WS-H; F-06, F-49).
     A hit here PRODUCES a new segment via a real, verbatim anchor located in
     the episode's actual cue text — never a raw timestamp, never an invented
     anchor.

     WHAT WS-H CHANGED IS THE CANDIDATE SEARCH, AND ONLY THAT. Until now the
     only way to reach an episode's tape was for its TITLE to share three
     content words with the claim, so run 2's 23 searching beats never got past
     the title bar — *Practical AI*, 63 of 63 bodies present, best title score
     ONE against a claim about ImageNet's label errors (F-49's resolved cause).
     Now the claim's content words are put to an index over the archive's own
     cue text (`textIndex`), the top few episodes are opened, and every gate
     that decides whether the tape is about the claim runs on them EXACTLY as
     before: `resolveAnchorFromCues`, the anchored-window overlap test (F-24),
     the taxonomy lineage gate (F-23/F-29), the cut to whole cues, and the
     audio-source check. The title bar survives as a fallback candidate and a
     tie-breaker, never as a gate — which is the whole of F-06.

     Candidates are walked in order and the FIRST one that passes every gate
     wins, so a beat still takes at most one tier-2 segment. What the trace
     reports when none passes is the candidate that got FURTHEST, because that
     is the gate a person would go and argue with. */
  const archiveIsUsable = (entry: TranscriptDigestEntry) =>
    familyGateAllows(state.forayTopic, nodesForArchiveEntry(entry, state), state.root);
  const candidates = tier2Candidates(claim, state, archiveIsUsable);

  let furthest: Tier2Progress | null = null;
  for (const candidate of candidates) {
    const cues = state.cueProvider.getCues(candidate.entry);
    if (!cues) {
      furthest = furtherOf(furthest, { candidate, gate: "no-body" });
      continue;
    }
    const span = resolveAnchorFromCues(claim, cues);
    if (!span) {
      furthest = furtherOf(furthest, { candidate, gate: "no-anchor" });
      continue;
    }
    /* THE ANCHORED-WINDOW CHECK (F-24). An anchor proves a phrase was spoken;
       it does not prove the tape there is about the claim. Run 1's anchors were
       runs like "the original design required", which occur in almost any hour
       of talk, and the minted segment was those few seconds. The claim's
       content words must also turn up AROUND the anchor — not somewhere else in
       the episode — before this is tape. */
    const evidence = anchoredWindowEvidence(claim, cues, span);
    if (!anchoredWindowIsOnTopic(evidence)) {
      furthest = furtherOf(furthest, { candidate, gate: "window-overlap", evidence, span });
      continue;
    }
    const itemId = deriveItemId(candidate.entry);
    /* TAPE NOTHING CAN PLAY IS NOT TAPE. A minted segment is a pointer into an
       episode's audio, and `check-forays.mjs` refuses a pool item id with no
       `data/segment-sources.json` row ("nothing can resolve its audio"). So the
       row is minted here, from the digest's own enclosure and a real DAI
       verdict, or this candidate is passed over — never a segment id that would
       fail §4.9 four stages later. Inert for a caller that supplied no resolver
       (see `SourceBeatsOptions.audioSourceFor`). */
    const audioSource = state.audioSourceFor ? state.audioSourceFor(candidate.entry, itemId) : null;
    if (state.audioSourceFor && !audioSource) {
      furthest = furtherOf(furthest, { candidate, gate: "no-audio-source", evidence, span });
      continue;
    }
    if (audioSource) state.newSegmentSources.set(itemId, audioSource);
    const segmentId = mintSegmentId(itemId, span.startSec, state.mintedIds);
    const referenceDurationSec = candidate.entry.feed_duration_sec ?? span.endSec;
    /* `span.startSec`/`span.endSec` are the CUE BOUNDARIES `cutSpanToCueBoundaries`
       chose, not the matched phrase's own few seconds (F-24(c)) — the minted
       segment's times are the tape's own times. */
    state.newSegments.push({
      id: segmentId,
      itemId,
      startSec: span.startSec,
      endSec: span.endSec,
      referenceDurationSec,
      startAnchor: span.startAnchor,
      endAnchor: span.endAnchor,
      confidence: "medium"
    });
    return {
      kind: "tape",
      nodes: nodesForArchiveEntry(candidate.entry, state),
      pointer: {
        segmentId,
        itemId,
        startSec: span.startSec,
        endSec: span.endSec,
        startAnchor: span.startAnchor,
        endAnchor: span.endAnchor,
        tier: 2,
        confidence: "medium"
      }
    };
  }

  const tier2Trace = tier2TraceFor(claim, state, archiveIsUsable, candidates, furthest);

  /* Tier 3: nothing in the archive could be cut for this beat. Log ONE
     transcription-queue candidate saying how far the search got — this
     pipeline's OWN log, distinct from and never written into
     `data/transcription-queue.json`, which has its own producer
     (`tools/transcribe/build-transcription-queue.mjs`) — and let the beat
     become narration. */
  state.transcriptionQueueCandidates.push(transcriptionQueueRow(claim, furthest));

  return {
    kind: "narration",
    reason: narrationReasonFor(furthest),
    diagnosis: { outcome: "no-tape", tier1: tier1Trace, tier2: tier2Trace }
  };
}

/** One episode tier 2 is willing to open for a claim, and how it was found. */
interface Tier2Candidate {
  entry: TranscriptDigestEntry;
  /** The title-metadata score — now a tie-breaker and a trace field, not a bar. */
  titleScore: number;
  /** The text-index row that produced it, or `null` for the title fallback. */
  text: TranscriptTextCandidate | null;
}

/** How far one candidate got, for the trace. */
interface Tier2Progress {
  candidate: Tier2Candidate;
  gate: Tier2Gate;
  evidence?: AnchoredWindowEvidence;
  span?: ResolvedAnchorSpan;
}

/**
 * How much progress each gate represents. A beat that reached the window test
 * on one episode and a bare title on seven others is a beat whose story is the
 * window test — reporting the last candidate walked, or the highest-ranked one,
 * would hide the only row worth reading (F-49).
 */
const TIER2_GATE_PROGRESS: Record<Tier2Gate, number> = {
  "text-index:no-candidate": 0,
  lineage: 1,
  "title-tokens": 2,
  "no-body": 3,
  "no-anchor": 4,
  "window-overlap": 5,
  "no-audio-source": 6
};

function furtherOf(current: Tier2Progress | null, next: Tier2Progress): Tier2Progress {
  if (!current) return next;
  return TIER2_GATE_PROGRESS[next.gate] > TIER2_GATE_PROGRESS[current.gate] ? next : current;
}

/**
 * The episodes tier 2 will open, best first: the text index's top N, then the
 * title-metadata match if it is not already among them.
 *
 * THE TITLE MATCH IS STILL HERE, LAST. It is what tier 2 ran on before WS-H and
 * it is what a checkout without transcript bodies (`NullTranscriptTextIndex`,
 * every CI run) has: keeping it means this change can only ADD candidates, so
 * no beat that found tape before can stop finding it. Its score is carried on
 * every candidate as the tie-breaker `transcriptTextIndex` ranks equal-text
 * episodes by.
 */
function tier2Candidates(claim: string, state: SourcingState, isUsable: (entry: TranscriptDigestEntry) => boolean): Tier2Candidate[] {
  const claimTokens = new Set(tokenizeForSourcing(claim));
  const candidates: Tier2Candidate[] = [];
  const seen = new Set<string>();
  const key = (entry: TranscriptDigestEntry) => `${entry.show_id}\u0000${entry.guid}`;

  for (const hit of state.textIndex.search(claim, { limit: TRANSCRIPT_TEXT_CANDIDATES, isUsable })) {
    if (seen.has(key(hit.entry))) continue;
    seen.add(key(hit.entry));
    candidates.push({ entry: hit.entry, titleScore: titleTokenScore(claimTokens, hit.entry), text: hit });
  }

  const byTitle = findTranscriptArchiveMatch(claim, state.transcriptArchive, isUsable);
  if (byTitle && !seen.has(key(byTitle.entry))) {
    candidates.push({ entry: byTitle.entry, titleScore: byTitle.score, text: null });
  }
  return candidates;
}

/** The row that says what tier 2 saw and which gate decided (F-49). */
function tier2TraceFor(
  claim: string,
  state: SourcingState,
  isUsable: (entry: TranscriptDigestEntry) => boolean,
  candidates: Tier2Candidate[],
  furthest: Tier2Progress | null
): Tier2TraceRow {
  if (!furthest) {
    /* Nothing was even worth opening. When the text index ran, that IS the
       deciding gate; when the topic gate is what emptied the field, `lineage`
       is the more specific answer and keeps precedence; and when no index ran
       at all (CI, and every caller that predates WS-H) the answer is the
       title-token bar, exactly as before. */
    const rejected = traceTier2Rejected(claim, state, isUsable);
    if (state.textIndex.enabled && rejected.gate === "title-tokens") {
      return { ...rejected, gate: "text-index:no-candidate", candidatesConsidered: 0 };
    }
    return rejected;
  }
  const { candidate, gate, evidence } = furthest;
  const row: Tier2TraceRow = {
    ...archiveTraceRow(candidate.entry, candidate.titleScore, gate),
    candidatesConsidered: candidates.length,
    foundBy: candidate.text ? "text-index" : "title"
  };
  if (candidate.text) {
    row.textScore = Number(candidate.text.score.toFixed(3));
    row.textRank = candidate.text.rank;
    row.textMatchedTerms = candidate.text.matchedTerms;
  }
  if (evidence) {
    row.anchorContentWords = evidence.anchorContentWords;
    row.beyondAnchorOverlap = evidence.beyondAnchorOverlap;
  }
  return row;
}

/** The narration reason a beat carries into §4.7, keyed to how far tier 2 got. */
function narrationReasonFor(furthest: Tier2Progress | null): string {
  switch (furthest?.gate) {
    case "no-audio-source":
      return "Tape was found for this beat but its episode's audio cannot be resolved, so it cannot be played.";
    case "window-overlap":
      return "A transcript anchor was found but the tape around it is not about this claim.";
    default:
      return "No tape found anywhere in the §4.5 search order for this beat.";
  }
}

/** One queue row per narrated beat, naming the episode the search got furthest
 * into and what stopped it there. */
function transcriptionQueueRow(claim: string, furthest: Tier2Progress | null): TranscriptionQueueCandidate {
  if (!furthest) {
    return {
      claim,
      reason: "No hit in data/segments.json or the transcript archive; logged for future transcription/extraction, not acted on here."
    };
  }
  const { candidate, gate, evidence } = furthest;
  const found = candidate.text ? "Transcript text matched" : "Transcript-archive metadata matched";
  switch (gate) {
    case "no-audio-source":
      return {
        claim,
        showId: candidate.entry.show_id,
        reason: `Transcript-archive tape was located in "${candidate.entry.title}", but no data/segment-sources.json row can be written for it (no resolvable https audio URL, feed duration, or DAI verdict), so nothing could play it.`
      };
    case "window-overlap":
      return {
        claim,
        showId: candidate.entry.show_id,
        reason: `${found} ("${candidate.entry.title}") and a ${evidence?.anchorContentWords ?? 0}-content-word anchor was located, but only ${evidence?.beyondAnchorOverlap ?? 0} further claim content words are spoken within ${ANCHOR_WINDOW_PAD_SEC} s of it — below the ${TIER2_WINDOW_OVERLAP_MIN} needed to call the tape there on topic.`
      };
    case "no-anchor":
      return {
        claim,
        showId: candidate.entry.show_id,
        reason: `${found} ("${candidate.entry.title}") but no run of ${MIN_ANCHOR_WORDS} of the claim's own words is spoken verbatim anywhere in it, so no anchor could be located.`
      };
    default:
      return {
        claim,
        showId: candidate.entry.show_id,
        reason: `${found} ("${candidate.entry.title}") but no cue text was available to locate a verbatim anchor.`
      };
  }
}

/**
 * Every taxonomy node a POOL SEGMENT can be said to belong to: its own `topic`
 * plus its show's `taxonomy_node_ids`.
 *
 * The union — rather than the segment's `topic` alone — is deliberate, and it
 * is the same union WS-B's `computeTapeRelevance` builds from disk. Two reasons
 * it has to be a union. A segment's own node is the more specific signal but 67
 * of the 212 pooled segments have no resolvable show, and 16 of the 145 that do
 * disagree with it: the three Hyatt Regency segments carry
 * `architecture/infrastructure`, `engineering/disasters` and `engineering`
 * between them, all cut from one episode of one show the catalogue classifies
 * as `engineering/disasters`. Gating on the segment's own node alone would
 * refuse the first of those three for an engineering Foray — the right episode,
 * refused on a curator's per-segment nuance. And computing it differently from
 * WS-B would let the gate and the metric that scores the gate disagree about
 * the same anchor, which is exactly the kind of silent divergence run 1 was
 * made of.
 */
function nodesForSegment(segment: SegmentRecord, state: SourcingState): string[] {
  return unionNodes(segment.topic ?? null, taxonomyNodesForItemId(segment.item_id, state.root));
}

/** The same, for a tier-2 archive episode: its show's nodes by `show_id`, plus
 * the item-id join so a minted segment resolves the way a pooled one does. */
function nodesForArchiveEntry(entry: TranscriptDigestEntry, state: SourcingState): string[] {
  return unionNodes(taxonomyNodesForShowId(entry.show_id, state.root), taxonomyNodesForItemId(deriveItemId(entry), state.root));
}

/**
 * Joins a pool segment to the transcript body of the episode it was cut from,
 * so tier 1 can score a claim against the words actually spoken inside the
 * segment (F-06 / F-29).
 *
 * The join is `data/segments.json`'s `item_id` against the id `deriveItemId`
 * mints from a digest entry — the same `<show_id>--<title-slug>` shape both
 * sides already use (`causality-engineered-network--47-hyatt-regency-kansas-city`).
 * Everything is cached: a Foray asks about the same segments once per beat, and
 * the cue provider itself caches file reads.
 *
 * NOTE: no path in here reads `data-local/` — the only thing that can reach a
 * transcript body is the injected `TranscriptCueProvider`, which is the same
 * rule the module doc comment states and `sourceBeats.noFetch.test.ts` checks.
 */
function makeSegmentWindowText(archive: TranscriptDigestEntry[], cueProvider: TranscriptCueProvider): SegmentWindowText {
  let byItemId: Map<string, TranscriptDigestEntry> | null = null;
  const cache = new Map<string, string | null>();
  return (segment: SegmentRecord) => {
    if (cache.has(segment.id)) return cache.get(segment.id) ?? null;
    if (!byItemId) {
      byItemId = new Map();
      for (const entry of archive) {
        const id = deriveItemId(entry);
        if (!byItemId.has(id)) byItemId.set(id, entry);
      }
    }
    let text: string | null = null;
    const entry = byItemId.get(segment.item_id);
    if (entry) {
      const cues = cueProvider.getCues(entry);
      if (cues) {
        const window = cueWindowText(cues, segment.start_sec, segment.end_sec).trim();
        text = window.length > 0 ? window : null;
      }
    }
    cache.set(segment.id, text);
    return text;
  };
}

/** Mirrors `tools/segments/prepare-segment-batch.mjs`'s `slugify` +
 * `mintItemIds` shape (`<show_id>--<slug>`) closely enough to be
 * recognizable as the same id family, without importing that ESM build
 * script into a CJS backend module (same rationale as
 * `transcriptArchiveLookup.ts`'s `canonicalizeForAnchorMatch`). */
export function deriveItemId(entry: TranscriptDigestEntry): string {
  const slug = entry.title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return `${entry.show_id}--${slug || "episode"}`;
}

/** Same id shape as `data/segments.json`'s existing rows
 * (`<item_id>#<start_sec rounded>`), with a numeric suffix to resolve a
 * collision — mirrors `mintItemIds`'s collision-resolution rule. */
function mintSegmentId(itemId: string, startSec: number, existing: Set<string>): string {
  const base = `${itemId}#${Math.round(startSec)}`;
  let id = base;
  let n = 2;
  while (existing.has(id)) id = `${base}-${n++}`;
  existing.add(id);
  return id;
}
