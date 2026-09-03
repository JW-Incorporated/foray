import type { DeepenedAct } from "../types/spine";
import type {
  NewSegment,
  SourcedAct,
  SourcedBeat,
  SourcedSlot,
  SourceBeatsResult,
  TapePointer,
  TranscriptionQueueCandidate
} from "../types/tapeSourcing";
import { validateSourcing } from "../types/tapeSourcing";
import { findTier1Match, loadSegmentPool, type SegmentRecord } from "./segmentPoolLookup";
import {
  findTranscriptArchiveMatch,
  loadTranscriptArchive,
  resolveAnchorFromCues,
  NullTranscriptCueProvider,
  type TranscriptCueProvider,
  type TranscriptDigestEntry
} from "./transcriptArchiveLookup";

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
 */

export interface SourceBeatsOptions {
  segmentPool?: SegmentRecord[];
  transcriptArchive?: TranscriptDigestEntry[];
  cueProvider?: TranscriptCueProvider;
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

  const newSegments: NewSegment[] = [];
  const transcriptionQueueCandidates: TranscriptionQueueCandidate[] = [];
  const mintedIds = new Set<string>(segmentPool.map((s) => s.id));

  const acts: SourcedAct[] = deepenedActs.map((act) => {
    const slots: SourcedSlot[] = act.slots.map((slot) => {
      // Resolve tape-or-not for every beat in the slot FIRST, because the
      // Patch/Carry decision needs to know whether ANY beat in this slot —
      // not just this one — ended up tape-sourced (§4.5: "pick based on
      // whether the SLOT the beat belongs to has any other tape-sourced
      // beats").
      const resolutions = slot.beats.map((beat) =>
        resolveOneBeat(beat.claim, segmentPool, transcriptArchive, cueProvider, mintedIds, newSegments, transcriptionQueueCandidates)
      );
      const slotHasTape = resolutions.some((r) => r.kind === "tape");

      const beats: SourcedBeat[] = slot.beats.map((beat, i) => {
        const resolution = resolutions[i]!;
        if (resolution.kind === "tape") {
          return { sourcing: "tape", claim: beat.claim, exploration: beat.exploration, tape: resolution.pointer };
        }
        // Narration: Patch when this slot has other tape-sourced beats
        // (this beat supplies what that tape misses); Carry when the
        // slot has no tape at all (this beat IS the content).
        const mode = slotHasTape ? "Patch" : "Carry";
        const reason = slotHasTape
          ? `No tape found for this beat, but slot "${slot.title}" has other tape-sourced beats — this beat patches what the slot's tape misses.`
          : `No tape found anywhere in the search order for this beat, and slot "${slot.title}" has no tape-sourced beats at all — this beat carries the content alone.`;
        return { sourcing: "narration", claim: beat.claim, exploration: beat.exploration, narration: { mode, reason } };
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

  return { acts, newSegments, transcriptionQueueCandidates };
}

type BeatResolution = { kind: "tape"; pointer: TapePointer } | { kind: "narration" };

function resolveOneBeat(
  claim: string,
  segmentPool: SegmentRecord[],
  transcriptArchive: TranscriptDigestEntry[],
  cueProvider: TranscriptCueProvider,
  mintedIds: Set<string>,
  newSegments: NewSegment[],
  transcriptionQueueCandidates: TranscriptionQueueCandidate[]
): BeatResolution {
  // Tier 1: existing data/segments.json pool. Cheapest possible hit,
  // tried first, per §4.5's own search order — no new segment is ever
  // created here.
  const tier1 = findTier1Match(claim, segmentPool);
  if (tier1) {
    return {
      kind: "tape",
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

  // Tier 2: transcript archive. A hit here PRODUCES a new segment via a
  // real, verbatim anchor located in the episode's actual cue text —
  // never a raw timestamp, never an invented anchor. If cue text is not
  // available (the common case in this checkout — see
  // NullTranscriptCueProvider's doc comment), the episode-level match is
  // real but unresolved this run and the beat falls through, same as no
  // match at all.
  const tier2 = findTranscriptArchiveMatch(claim, transcriptArchive);
  if (tier2) {
    const cues = cueProvider.getCues(tier2.entry);
    if (cues) {
      const span = resolveAnchorFromCues(claim, cues);
      if (span) {
        const itemId = deriveItemId(tier2.entry);
        const segmentId = mintSegmentId(itemId, span.startSec, mintedIds);
        const referenceDurationSec = tier2.entry.feed_duration_sec ?? span.endSec;
        newSegments.push({
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
    }
  }

  // Tier 3: the catalogue without transcripts (or a tier-2 match whose
  // cue text was unavailable/unresolvable) cannot be cut. Log it as a
  // transcription-queue candidate — this pipeline's OWN log, distinct
  // from and never written into `data/transcription-queue.json`, which
  // has its own producer (`tools/transcribe/build-transcription-queue.mjs`)
  // — and let the beat become narration.
  if (tier2) {
    transcriptionQueueCandidates.push({
      claim,
      showId: tier2.entry.show_id,
      reason: `Transcript-archive metadata matched ("${tier2.entry.title}") but no cue text was available to locate a verbatim anchor.`
    });
  } else {
    transcriptionQueueCandidates.push({
      claim,
      reason: "No hit in data/segments.json or the transcript archive; logged for future transcription/extraction, not acted on here."
    });
  }

  return { kind: "narration" };
}

/** Mirrors `tools/segments/prepare-segment-batch.mjs`'s `slugify` +
 * `mintItemIds` shape (`<show_id>--<slug>`) closely enough to be
 * recognizable as the same id family, without importing that ESM build
 * script into a CJS backend module (same rationale as
 * `transcriptArchiveLookup.ts`'s `canonicalizeForAnchorMatch`). */
function deriveItemId(entry: TranscriptDigestEntry): string {
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
