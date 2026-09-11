import type { Act } from "../types/spine";
import type { SourceBeatsResult } from "../types/tapeSourcing";
import { M4_ITEM_SHARE_MAX, m4SegmentCapFor } from "./sourceBeats";

/**
 * THE M4 CAP, MADE VISIBLE TO SEEDING (G-25; tape-yield brief §5 R3).
 *
 * §4.5's ledger refuses an episode's SECOND segment until the Foray has placed
 * eight tape segments (`m4SegmentCapFor`: `max(1, floor(placed × 0.25))`), and
 * it asks the question before the episode's body is even opened. Nothing told
 * §4.3 that. The run-2 spine seeded *Federated learning, part 2* twice and
 * *Building durable agents* twice, and beat 1/0/0's seed window — on-claim
 * verbatim at weighted share 0.746 — was refused at `m4-share` with three tape
 * segments placed, while the map listed twenty other episodes the beat could
 * have been seeded from. A seed the ledger will refuse is a seed wasted.
 *
 * SO THE RULE IS STATED HERE, ONCE, IN THE LEDGER'S OWN ARITHMETIC, and both
 * spine builders read it: the prompt tells the model the two numbers below, and
 * the stub keeps a `SpineSeedLedger` while it seeds. Neither is the gate — the
 * gate stays in `sourceBeats.ts`, against the count of segments actually
 * PLACED. This is the optimistic reading of the same rule ("the Foray will
 * carry as many segments as it has seeds"), which is the most the spine can
 * know at the time it seeds, and the reason it is guidance and not a
 * structural refusal: a spine that repeats an episode early loses that beat's
 * tape downstream, and losing one beat is cheaper than re-asking Opus for the
 * whole spine.
 */

/** The smallest number of seeded beats at which one episode may be seeded a
 * SECOND time — 8 at `M4_ITEM_SHARE_MAX` 0.25. Derived, not written down, so
 * it cannot drift from the ledger it describes. */
export const SPINE_SEED_REPEAT_MIN = Math.ceil(2 / M4_ITEM_SHARE_MAX);
/** And a THIRD time — 12. */
export const SPINE_SEED_THIRD_MIN = Math.ceil(3 / M4_ITEM_SHARE_MAX);

/**
 * What §4.5's ledger will say about the seeds a spine is about to carry, asked
 * in spine order as the seeds are chosen. Two questions, the same two the
 * sourcing ledger asks of a candidate before it opens the episode:
 *
 *   - SHARE (M4): one more seed from this episode keeps it inside a quarter of
 *     the seeds the spine will then carry (`m4SegmentCapFor`, with the seeded
 *     count standing in for the placed count).
 *   - ORDER (M3): a later seed from the same episode starts no earlier on the
 *     tape than the seed before it, because beats play in spine order and one
 *     episode's tape plays forward.
 */
export class SpineSeedLedger {
  private readonly countByEpisode = new Map<string, number>();
  private readonly lastStartByEpisode = new Map<string, number>();
  private seededCount = 0;

  /** Seeds recorded so far. */
  get seeded(): number {
    return this.seededCount;
  }

  /** Both rules: share and order. */
  allows(episodeId: string, startSec: number): boolean {
    return this.shareAllows(episodeId) && this.orderAllows(episodeId, startSec);
  }

  /** M4 alone: whether one more seed from `episodeId` stays inside its share
   * of the seeds this spine would then carry. */
  shareAllows(episodeId: string): boolean {
    const used = this.countByEpisode.get(episodeId) ?? 0;
    return used + 1 <= m4SegmentCapFor(this.seededCount + 1);
  }

  /** M3 alone: whether a seed starting at `startSec` may follow what this spine
   * has already seeded from the same episode. */
  orderAllows(episodeId: string, startSec: number): boolean {
    const last = this.lastStartByEpisode.get(episodeId);
    return last === undefined || startSec >= last;
  }

  record(episodeId: string, startSec: number): void {
    this.countByEpisode.set(episodeId, (this.countByEpisode.get(episodeId) ?? 0) + 1);
    this.lastStartByEpisode.set(episodeId, startSec);
    this.seededCount += 1;
  }
}

/**
 * ONE FORAY-WIDE LINE FOR THE PERSON WATCHING THE RUN, printed after
 * `summarizeSourcing`'s one line per slot: how many beats the spine seeded from
 * the research map, how many beats got tape, and how many of those got it
 * through their seed. G-25's whole bet is that the second number follows the
 * first, so the run log has to show both side by side.
 *
 * Pure, like `summarizeSourcing`: the pipeline prints it, tests read it.
 */
export function summarizeSeeding(deepened: readonly Act[], sourced: SourceBeatsResult): string {
  const beats = deepened.flatMap((act) => act.slots.flatMap((slot) => slot.beats));
  const seeded = beats.filter((beat) => beat.seed !== undefined).length;
  const tape = sourced.acts.reduce(
    (sum, act) => sum + act.slots.reduce((s, slot) => s + slot.beats.filter((b) => b.sourcing === "tape").length, 0),
    0
  );
  const throughSeed = sourced.tapeRelevance.filter((row) => row.seedWindowWon === true).length;
  return (
    `source: ${seeded} of ${beats.length} beats seeded from the research map — ` +
    `${tape} tape (${throughSeed} through the seed) / ${beats.length - tape} narration`
  );
}
