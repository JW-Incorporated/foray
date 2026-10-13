import { tokenizeForSourcing } from "./catalogueLookup";
import { claimTermWeigher, TIER2_WINDOW_MIN_SHARE } from "./transcriptArchiveLookup";
import { SpineSeedLedger } from "./spineSeeding";
import { checkSpineStructure, foldedCopyIssues } from "./spineStructure";
import type { SpineBuildContext, SpineBuilder } from "./SpineBuilder";
import { withCallContext } from "./runLog";
import type { IntentUnderstanding } from "../types/generation";
import type { ResearchShape, ResearchTapeWindow } from "../types/research";
import { SpineSchema, validateSpine, type Beat, type DurationTier, type Spine } from "../types/spine";

/**
 * F-98 (A): SEED YIELD IS MODEL VARIANCE, AND THE PIPELINE STOPS DEPENDING ON IT.
 *
 * Run 8 and run 9 sent the spine model byte-similar prompts offering the SAME
 * eleven tape windows. Run 8's reply seeded 26 of 32 beats; run 9's seeded 9 of
 * 31. Everything downstream follows that one number — seeded beats are where the
 * tape comes from (run 8: 16 tape beats, all of them through the seed; run 9: 10,
 * with 22 unseeded beats falling to narration) — so a Foray's tape share is
 * currently a sample from Opus's variance on a prompt nobody changed.
 *
 * Nothing here asks the model to be steadier. The seed is a POINTER (see
 * `types/spine.ts`'s `BeatSeedSchema`), the windows it points into are listed in
 * the research map in front of us, and matching a claim to a window is a
 * scoring problem this repository already solves — `selectTapeWindow`'s
 * idf-weighted share of the claim's distinctiveness. So after the spine lands,
 * every unseeded non-argument beat is scored against every window the prompt
 * offered, and the best one is ATTACHED as its seed when it clears the same
 * share floor the window search will apply to it downstream.
 *
 * WHAT THIS IS NOT. It is not a second opinion about relevance: an assigned seed
 * faces `sourceBeats.ts`'s seed pass exactly like a spine-written one — the
 * window search inside the episode, the share floor, the lineage gate, the anchor
 * mint, the audio-source check — and a beat whose assigned episode does not carry
 * its claim is narrated, same as today. What it buys is the same thing WS-L
 * bought: the ORDER of the search. And `seedSource` on the beat says which of
 * the two put the seed there, so the run log can report the spine's own yield
 * separately from what post-seeding recovered, and nobody reads an assigned seed
 * as evidence the model wrote the claim from that tape. It did not.
 *
 * THE FLOOR IS THE SECOND HALF (B). Post-seeding can only attach windows that
 * were offered; a spine whose claims wandered off the map entirely is not fixed
 * by scoring. So when the seeded share of non-argument beats is still below
 * `SPINE_SEED_FLOOR` after post-seeding, the spine is re-asked ONCE in F-86's
 * idiom — the same prompt, its own reply as the assistant turn, one user turn
 * naming the beats that carry no seed and the windows that speak to them — and
 * the result is post-seeded again. One re-ask, one Opus call, metered like any
 * other spine call, and the pre-F-98 behaviour is restored exactly by
 * `maxSeedFloorReasks: 0`.
 */

/**
 * The share of a claim's distinctiveness an offered window must speak before it
 * is attached as that beat's seed.
 *
 * DERIVED, NOT CHOSEN: it is `TIER2_WINDOW_MIN_SHARE`, the floor
 * `tapeWindowIsRelevant` applies to a SEED window at `"seed-window"` (share
 * alone — F-72). A seed assigned below it would be refused by the very next
 * stage that looks at it, so assigning one would only spend the seed pass on a
 * window already known to fail. Writing the number here instead of importing it
 * would let the two drift, and the drift would be silent: the beat would still
 * be narrated, and the run log would say it had a seed.
 */
export const ASSIGNED_SEED_MIN_SHARE = TIER2_WINDOW_MIN_SHARE;

/**
 * The seeded share of non-argument beats below which the spine is re-asked once.
 *
 * 0.5 SITS BETWEEN THE TWO RUNS THIS CARD IS ABOUT — run 8 seeded 26 of 32
 * (0.81), run 9 seeded 9 of 31 (0.29) — so it refuses run 9's spine and accepts
 * run 8's, which is the whole intent: the re-ask is for a reply that is an
 * outlier against the same prompt, not a routine second call on every run. It is
 * asked AFTER post-seeding, so a spine whose gaps deterministic scoring could
 * close never costs the call at all.
 */
export const SPINE_SEED_FLOOR = 0.5;

/** How many seed-floor re-asks a spine may cost. One, the same budget F-86
 * gives the structural gate, and for the same reason: a second re-ask is a
 * second Opus call against a model that has already been told what is missing. */
export const DEFAULT_SEED_FLOOR_REASKS = 1;

/** A window as post-seeding ranks it for one beat. */
export interface ScoredWindow {
  window: ResearchTapeWindow;
  /** The claim's content words spoken in the window, in the claim's order. */
  matchedTerms: string[];
  /** The fraction of the claim's DISTINCTIVENESS the window speaks — the same
   * number `TapeWindow.weightedShare` carries, computed the same way. */
  weightedShare: number;
}

/** Where a beat sits, and what post-seeding could or could not do for it. */
export interface UnseededBeat {
  actIndex: number;
  slotIndex: number;
  beatIndex: number;
  claim: string;
  /** The best window that was offered, whatever its score — so the re-ask can
   * name "the windows that speak to them" even for a beat below the floor. */
  best: ScoredWindow | null;
}

export interface PostSeedResult {
  spine: Spine;
  /** Non-argument beats: post-seeding's denominator, and the floor's. */
  nonArgument: number;
  /** Seeds the spine itself wrote (`seedSource: "spine"`). */
  spineSeeded: number;
  /** Seeds this pass attached (`seedSource: "assigned"`). */
  assigned: number;
  /** Non-argument beats still carrying no seed, best offered window beside each. */
  unseeded: UnseededBeat[];
  /** `(spineSeeded + assigned) / nonArgument`; 1 when there are no non-argument
   * beats, since a spine with nothing to seed is not below any floor. */
  seededShare: number;
}

/**
 * Every window the spine prompt offered, in the order `tapeWindowLines` printed
 * them, with duplicates (the same episode and start under two subtopics) dropped
 * so one window is scored once and the idf below counts it once.
 */
export function offeredWindows(researchShape: ResearchShape): ResearchTapeWindow[] {
  const seen = new Set<string>();
  const windows: ResearchTapeWindow[] = [];
  for (const subtopic of researchShape.subtopics) {
    for (const w of subtopic.tapeWindows) {
      const key = `${w.episodeId}\u0000${Math.round(w.startSec)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      windows.push(w);
    }
  }
  return windows;
}

/**
 * THE CORPUS POST-SEEDING WEIGHS WORDS AGAINST IS THE OFFERED WINDOWS THEMSELVES.
 *
 * `transcriptTextIndex.ts` computes its idf over the whole archive, and that is
 * the right corpus for "which episode should I open". This is a different
 * question — "which of these eleven windows is this claim about" — and the eleven
 * are the only documents in it. A word every offered window says (`engineer`,
 * `career` on run 9's map) separates none of them and is weighed down; a word
 * one window says carries the match. That is exactly what F-61's weighted share
 * is for, applied to the corpus actually being ranked.
 *
 * The formula is `transcriptTextIndex.ts`'s BM25 idf verbatim, so the two
 * weightings are the same shape at different scales rather than two inventions.
 */
export function offeredWindowIdf(windows: readonly ResearchTapeWindow[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const w of windows) {
    for (const term of new Set(tokenizeForSourcing(w.text))) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const docCount = windows.length;
  const idf = new Map<string, number>();
  if (docCount === 0) return idf;
  for (const [term, n] of df) idf.set(term, Math.log(1 + (docCount - n + 0.5) / (n + 0.5)));
  return idf;
}

/**
 * One window's score for one claim: the share of the claim's distinctiveness it
 * speaks, by `claimTermWeigher` — the same weigher `selectTapeWindow` uses, so
 * the number means the same thing here as it does there.
 */
export function scoreWindowForClaim(
  claim: string,
  window: ResearchTapeWindow,
  idf: ReadonlyMap<string, number> | undefined
): ScoredWindow {
  const claimTerms: string[] = [];
  const seen = new Set<string>();
  for (const t of tokenizeForSourcing(claim)) {
    if (seen.has(t)) continue;
    seen.add(t);
    claimTerms.push(t);
  }
  if (claimTerms.length === 0) return { window, matchedTerms: [], weightedShare: 0 };
  const weightOf = claimTermWeigher(claimTerms, idf);
  let totalWeight = 0;
  for (const t of claimTerms) totalWeight += weightOf(t);
  const spoken = new Set(tokenizeForSourcing(window.text));
  const matchedTerms = claimTerms.filter((t) => spoken.has(t));
  let score = 0;
  for (const t of matchedTerms) score += weightOf(t);
  return { window, matchedTerms, weightedShare: totalWeight > 0 ? score / totalWeight : 0 };
}

/** Best first, then more matched terms, then the earlier window — a total order,
 * so a replay of the same map and the same spine assigns the same seeds. */
function bestWindowFor(claim: string, windows: readonly ResearchTapeWindow[], idf: ReadonlyMap<string, number>): ScoredWindow[] {
  return windows
    .map((w) => scoreWindowForClaim(claim, w, idf))
    .sort((a, b) => {
      if (b.weightedShare !== a.weightedShare) return b.weightedShare - a.weightedShare;
      if (b.matchedTerms.length !== a.matchedTerms.length) return b.matchedTerms.length - a.matchedTerms.length;
      if (a.window.episodeId !== b.window.episodeId) return a.window.episodeId < b.window.episodeId ? -1 : 1;
      return a.window.startSec - b.window.startSec;
    });
}

/**
 * DETERMINISTIC POST-SEEDING (F-98 A1). Pure: same spine, same map, same seeds.
 *
 * Walked in SPINE ORDER, because the ledger it consults is order-dependent —
 * M4's share is asked against the count of seeds the spine would then carry and
 * M3's order against the last start already seeded from that episode
 * (`SpineSeedLedger`), and beats play in spine order. The spine's own seeds are
 * recorded as they are passed, so an assigned seed faces the ledger the spine's
 * seeds actually left behind rather than an empty one.
 *
 * WHAT "NON-ARGUMENT" MEANS AT THIS STAGE, HONESTLY. `kind` is assigned by §4.4
 * (`deepenActs.ts`), which runs AFTER this — and it has to, because the re-ask
 * below rewrites the spine and would throw three deepen calls away. So on a
 * fresh spine every beat reads as `account` (an absent `kind` is `account`, by
 * `BeatKindSchema`'s own rule) and the denominator is every beat. A beat §4.4
 * later tags `argument` will therefore have been offered a seed here; that
 * costs nothing — §4.5 skips the tape lookup for an argument beat whatever its
 * seed says (F-38) — but it does mean the floor is measured against a slightly
 * larger denominator than the finished spine's account beats, i.e. in the
 * conservative direction. The guard is still written as `kind !== "argument"`
 * so a caller that already has deepened beats (a test, a replay, a future stage
 * order) gets the narrower and more correct denominator.
 *
 * A BEAT THE LEDGER REFUSES KEEPS NO SEED. Not the second-best window either:
 * the refusal is about the EPISODE's share of the finished Foray, and every
 * other window of that episode is refused for the same reason — while a window
 * from a different episode that still cleared the floor is simply the next
 * candidate, which is what the ranked walk below tries. Only when no ranked
 * window both clears the floor and passes the ledger does the beat stay
 * unseeded, and then it is named in the re-ask.
 */
export function postSeedSpine(spine: Spine, researchShape: ResearchShape): PostSeedResult {
  const windows = offeredWindows(researchShape);
  const idf = offeredWindowIdf(windows);
  const ledger = new SpineSeedLedger();
  const unseeded: UnseededBeat[] = [];
  let nonArgument = 0;
  let spineSeeded = 0;
  let assigned = 0;

  const acts = spine.acts.map((act, actIndex) => ({
    ...act,
    slots: act.slots.map((slot, slotIndex) => ({
      ...slot,
      beats: slot.beats.map((beat, beatIndex): Beat => {
        if (beat.kind === "argument") return beat;
        nonArgument += 1;
        if (beat.seed) {
          spineSeeded += 1;
          ledger.record(beat.seed.episodeId, beat.seed.startSec);
          return { ...beat, seedSource: "spine" };
        }
        const ranked = windows.length > 0 ? bestWindowFor(beat.claim, windows, idf) : [];
        const best = ranked[0] ?? null;
        const pick = ranked.find(
          (candidate) =>
            candidate.weightedShare >= ASSIGNED_SEED_MIN_SHARE && ledger.allows(candidate.window.episodeId, candidate.window.startSec)
        );
        if (!pick) {
          unseeded.push({ actIndex, slotIndex, beatIndex, claim: beat.claim, best });
          return beat;
        }
        assigned += 1;
        ledger.record(pick.window.episodeId, pick.window.startSec);
        return {
          ...beat,
          seed: { episodeId: pick.window.episodeId, startSec: pick.window.startSec, endSec: pick.window.endSec },
          seedSource: "assigned"
        };
      })
    }))
  }));

  return {
    spine: { ...spine, acts },
    nonArgument,
    spineSeeded,
    assigned,
    unseeded,
    seededShare: nonArgument === 0 ? 1 : (spineSeeded + assigned) / nonArgument
  };
}

/**
 * The lines the seed-floor re-ask names: one per beat that still carries no
 * seed, each with the window that scored best for it. The beat is located the
 * way `spineStructure.ts`'s issues locate one — act/slot/beat and the first
 * chunk of the claim — because that is what makes a beat findable in a 31-beat
 * reply, and the window is quoted the way the prompt quoted it, so the model is
 * being pointed back at text it has already been shown.
 */
export function seedFloorViolations(result: PostSeedResult): string[] {
  return result.unseeded.map((beat) => {
    const where = `act ${beat.actIndex + 1}, slot ${beat.slotIndex + 1}, beat ${beat.beatIndex + 1}`;
    const claim = beat.claim.length > 120 ? `${beat.claim.slice(0, 120)}…` : beat.claim;
    const window = beat.best
      ? `closest window offered: [${beat.best.window.episodeId} ${Math.round(beat.best.window.startSec)}-${Math.round(
          beat.best.window.endSec
        )}s] ${beat.best.window.episodeTitle}${
          beat.best.matchedTerms.length > 0 ? ` (shares: ${beat.best.matchedTerms.join(", ")})` : " (shares nothing with the claim)"
        }`
      : "no window was offered for this subject";
    return `${where}: "${claim}" carries no seed — ${window}`;
  });
}

/** F-98's one line per spine, printed beside `summarizeSeeding`'s. Derived from
 * the FINAL spine's `seedSource` marks rather than from the pass that produced
 * them, so a resumed run prints the same line the run that banked the spine did. */
export function summarizeSeedFloor(spine: Spine, reasked: boolean): string {
  const beats = spine.acts.flatMap((a) => a.slots.flatMap((s) => s.beats)).filter((b) => b.kind !== "argument");
  const bySpine = beats.filter((b) => b.seed !== undefined && b.seedSource !== "assigned").length;
  const total = beats.filter((b) => b.seed !== undefined).length;
  return `seeds: spine ${bySpine}/${beats.length} → assigned ${total}/${beats.length} (floor ${SPINE_SEED_FLOOR}, re-asked: ${reasked ? "yes" : "no"})`;
}

export interface PostSeedWithFloorOptions {
  /** Overrides `DEFAULT_SEED_FLOOR_REASKS`; `0` restores the pre-F-98 pipeline
   * exactly (post-seeding still runs — it costs nothing and calls nothing). */
  maxSeedFloorReasks?: number;
  /** Fired the moment the re-ask is decided on, BEFORE the builder is called,
   * so the run log says what is being paid for while it is being paid for. */
  onReask?: (info: { share: number; violations: string[] }) => void;
}

export interface PostSeedWithFloorResult extends PostSeedResult {
  reasked: boolean;
}

/**
 * Post-seeding, the floor, and at most one re-ask (F-98 A1 + A2).
 *
 * THE RE-ASKED REPLY IS KEPT ONLY IF IT IS BETTER, and only if it passes the
 * same two gates the first reply passed (`validateSpine`, `checkSpineStructure`).
 * A re-ask is one sample from the same variance this card exists to stop
 * depending on: it can come back with fewer seeds, or with a claim shape the
 * structural gate would refuse, and in either case the spine that already
 * cleared both gates is the one the run should keep. The call is spent either
 * way — that is what a re-ask costs — but the run is never made worse by it.
 */
export async function postSeedWithFloor(
  spine: Spine,
  intent: IntentUnderstanding,
  researchShape: ResearchShape,
  duration: DurationTier,
  builder: SpineBuilder,
  ctx: SpineBuildContext,
  options: PostSeedWithFloorOptions = {}
): Promise<PostSeedWithFloorResult> {
  const first = postSeedSpine(spine, researchShape);
  const maxReasks = options.maxSeedFloorReasks ?? DEFAULT_SEED_FLOOR_REASKS;
  /* A MAP THAT QUOTED NOTHING IS NOT A SPINE THAT FAILED. With no windows
     offered, every non-argument beat is unseeded by construction and the share
     is 0 — and re-asking would name no window for the model to write from,
     because there is none. §4.2's guardrail again, carried one stage further:
     tape is a signal, never a filter, and a subject the archive is silent on
     still gets its spine. This is the same condition `spineStructure.ts` makes
     WS-L's per-act seed floor inert on. */
  if (maxReasks <= 0 || first.seededShare >= SPINE_SEED_FLOOR || first.unseeded.length === 0 || offeredWindows(researchShape).length === 0) {
    return { ...first, reasked: false };
  }

  const violations = seedFloorViolations(first);
  options.onReask?.({ share: first.seededShare, violations });
  /* `previous` is the spine AS THE MODEL WROTE IT — not the post-seeded one.
     F-86's idiom puts the model's own reply back in the conversation; handing
     it a reply with seeds it did not write would ask it to keep as its own a
     judgement this stage made. */
  const revision = { previous: spine, violations, attempt: 1, kind: "seed-floor" as const };
  /* GV-07: the seed-floor re-ask's model calls are recorded as such (a no-op
     wrapper outside a RunLog). */
  const raw = await withCallContext({ reask: "seed-floor" }, () => builder.buildSpine(intent, researchShape, duration, { ...ctx, revision }));
  /* GV-67: on a folded call the re-asked reply must carry the listener copy
     too; one that dropped a required field is refused like any other
     regression, and the spine that already carried it is kept. */
  if (ctx.listenerPrompt !== undefined && foldedCopyIssues(raw).length > 0) {
    return { ...first, reasked: true };
  }
  const reasked = SpineSchema.parse(raw);
  const seedableEpisodeIds = researchShape.subtopics.flatMap((s) => s.tapeWindows.map((w) => w.episodeId));
  if (!validateSpine(reasked).valid || checkSpineStructure(reasked, { seedableEpisodeIds }).length > 0) {
    return { ...first, reasked: true };
  }
  const second = postSeedSpine(reasked, researchShape);
  return second.seededShare > first.seededShare ? { ...second, reasked: true } : { ...first, reasked: true };
}
