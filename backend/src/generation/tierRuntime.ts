import { MODE_CHAR_BANDS, NARRATION_CHARS_PER_SEC } from "../types/narration";
import { tierRuntimeBand, TIER_RUNTIME_TOLERANCE, DURATION_RUNTIME_TARGET_SEC, type Beat, type BeatSeed, type DurationTier, type Spine } from "../types/spine";
import { TAPE_WINDOW_MIN_SEC } from "./transcriptArchiveLookup";

/**
 * GV-89 (docs/roadmap/generation-v2.md, W4-14): WHAT A SPINE ALREADY COMMITS
 * THE FORAY TO, IN SECONDS.
 *
 * A tier had shape counts (acts, slots, beats) and no runtime. The spine is
 * the first point where a plan exists, and it already fixes a floor under the
 * finished runtime: every seed window it keeps is tape the listener will hear
 * at no less than its quoted length (sourcing EXTENDS a window to the thought,
 * never cuts it below `TAPE_WINDOW_MIN_SEC`), and every beat with no tape is a
 * narration page no shorter than the Patch floor. So a plan whose MINIMUM
 * runtime is already over the tier's ceiling cannot fit, whatever sourcing
 * does later, and that is the one spine the post-spine check re-asks
 * (`buildSpine.ts`'s `reaskForRuntime`, behind FORAY_TIER_RUNTIME_CAP).
 *
 * Only a BOUND can be computed here: clip lengths are decided at sourcing, so
 * hard enforcement is GV-106's sourcing ceiling (W4-15), which reads
 * `narrationEstimateSec` below. The estimate is reported, never gated, until
 * the golden set calibrates it against the finished `runtime_sec`.
 *
 * Pure: no model call, no I/O. The same spine always gives the same numbers,
 * so a resumed run reports what the run that banked the spine reported.
 */

/**
 * The real segment pool's median length, in seconds (transcriptArchiveLookup.ts,
 * the note on `MIN_TAPE_SEGMENT_SEC`: "the real pool's shortest segment is 50 s
 * and its median is 124 s"). The estimate's guess for a seeded beat whose
 * quoted window is shorter than a typical clip. To be calibrated by the
 * golden-set live step.
 */
export const TAPE_POOL_MEDIAN_SEC = 124;

/** The shortest narration page a beat with no tape costs: the Patch band's
 * floor at the planning rate (340 chars / 17 = 20 s). */
export const NARRATED_BEAT_FLOOR_SEC = MODE_CHAR_BANDS.Patch[0] / NARRATION_CHARS_PER_SEC;

/** The estimate's narration page for a beat with no tape: the Patch band's
 * middle at the planning rate ((340 + 765) / 2 / 17 = 32.5 s). */
export const NARRATED_BEAT_ESTIMATE_SEC = (MODE_CHAR_BANDS.Patch[0] + MODE_CHAR_BANDS.Patch[1]) / 2 / NARRATION_CHARS_PER_SEC;

/** What the outcome and `report.json` carry: whole seconds. */
export interface SpineRuntime {
  lowerBoundSec: number;
  estimateSec: number;
}

/** The act shape these functions read: a spine act or a deepened one (whose
 * introduction and exit are required rather than folded). */
export interface RuntimeAct {
  introduction?: string;
  exit?: string;
  slots: ReadonlyArray<{ beats: ReadonlyArray<Beat> }>;
}

/** A beat that will be sourced from tape: it carries a seed and is not an
 * argument (§4.5 skips the tape lookup for an argument whatever its seed says,
 * F-38). An absent `kind` is `account`. */
function tapesFromSeed(beat: Beat): beat is Beat & { seed: BeatSeed } {
  return beat.seed !== undefined && beat.kind !== "argument";
}

function seedKey(seed: BeatSeed): string {
  return `${seed.episodeId}\u0000${seed.startSec}\u0000${seed.endSec}`;
}

/** Where a seed window first appears in the plan, for the re-ask's lines. */
export interface PlannedWindow {
  seed: BeatSeed;
  actIndex: number;
  slotIndex: number;
  beatIndex: number;
  claim: string;
  /** How many beats are seeded from this same window. */
  beats: number;
}

/**
 * Each DISTINCT seed window of the plan once, in spine order. Two beats seeded
 * from the same window are one stretch of tape, so it is counted once.
 */
export function plannedWindows(acts: ReadonlyArray<RuntimeAct>): PlannedWindow[] {
  const byKey = new Map<string, PlannedWindow>();
  acts.forEach((act, actIndex) =>
    act.slots.forEach((slot, slotIndex) =>
      slot.beats.forEach((beat, beatIndex) => {
        if (!tapesFromSeed(beat)) return;
        const key = seedKey(beat.seed);
        const seen = byKey.get(key);
        if (seen) seen.beats += 1;
        else byKey.set(key, { seed: beat.seed, actIndex, slotIndex, beatIndex, claim: beat.claim, beats: 1 });
      })
    )
  );
  return [...byKey.values()];
}

/** A window's least runtime: its quoted length, never under the tape floor. */
export function windowFloorSec(seed: BeatSeed): number {
  return Math.max(TAPE_WINDOW_MIN_SEC, seed.endSec - seed.startSec);
}

/** The beats that will be narrated rather than played: no seed, or an argument. */
function narratedBeatCount(acts: ReadonlyArray<RuntimeAct>): number {
  let n = 0;
  for (const act of acts) for (const slot of act.slots) for (const beat of slot.beats) if (!tapesFromSeed(beat)) n += 1;
  return n;
}

/** The introduction and exit characters the acts carry (folded on the spine,
 * or written by §4.4), at the planning rate. */
function actFramingSec(acts: ReadonlyArray<RuntimeAct>): number {
  let chars = 0;
  for (const act of acts) chars += (act.introduction ?? "").length + (act.exit ?? "").length;
  return chars / NARRATION_CHARS_PER_SEC;
}

function overviewSec(spine: Spine): number {
  return spine.overview.length / NARRATION_CHARS_PER_SEC;
}

/** The parts of the lower bound, for the log and the re-ask's wording. */
export interface RuntimeLowerBoundParts {
  windows: number;
  tapeSec: number;
  narratedBeats: number;
  narrationSec: number;
  framingSec: number;
  totalSec: number;
}

export function spineRuntimeLowerBoundParts(spine: Spine): RuntimeLowerBoundParts {
  const windows = plannedWindows(spine.acts);
  const tapeSec = windows.reduce((sum, w) => sum + windowFloorSec(w.seed), 0);
  const narratedBeats = narratedBeatCount(spine.acts);
  const narrationSec = narratedBeats * NARRATED_BEAT_FLOOR_SEC;
  const framingSec = overviewSec(spine) + actFramingSec(spine.acts);
  return { windows: windows.length, tapeSec, narratedBeats, narrationSec, framingSec, totalSec: tapeSec + narrationSec + framingSec };
}

/**
 * The least runtime the plan can finish at, in seconds:
 *   - each distinct seed window once, at max(TAPE_WINDOW_MIN_SEC, endSec - startSec);
 *   - each beat with no tape at the Patch floor (MODE_CHAR_BANDS.Patch[0] / NARRATION_CHARS_PER_SEC);
 *   - the overview and any folded introduction and exit, characters / NARRATION_CHARS_PER_SEC.
 * Seeds attached by post-seeding count exactly like the spine's own: the
 * caller passes the post-seeded spine.
 */
export function spineRuntimeLowerBoundSec(spine: Spine): number {
  return spineRuntimeLowerBoundParts(spine).totalSec;
}

/**
 * The narration an act list is expected to cost, in seconds: the introduction
 * and exit characters at the planning rate, plus each beat with no tape at the
 * Patch band's middle. GV-106 (W4-15) subtracts it from the tier ceiling to
 * get the sourcing stage's clip budget.
 */
export function narrationEstimateSec(acts: ReadonlyArray<RuntimeAct>): number {
  return actFramingSec(acts) + narratedBeatCount(acts) * NARRATED_BEAT_ESTIMATE_SEC;
}

/**
 * The plan's expected runtime, in seconds: each distinct seed window at
 * max(its length, the 124 s pool median), the narration estimate, and the
 * overview. Reported, never gated.
 */
export function spineRuntimeEstimateSec(spine: Spine): number {
  const tapeSec = plannedWindows(spine.acts).reduce((sum, w) => sum + Math.max(TAPE_POOL_MEDIAN_SEC, w.seed.endSec - w.seed.startSec), 0);
  return tapeSec + narrationEstimateSec(spine.acts) + overviewSec(spine);
}

/** Both numbers, rounded to whole seconds, as the outcome carries them. */
export function spineRuntimeOf(spine: Spine): SpineRuntime {
  return { lowerBoundSec: Math.round(spineRuntimeLowerBoundSec(spine)), estimateSec: Math.round(spineRuntimeEstimateSec(spine)) };
}

/**
 * How far the plan's minimum runtime is over the tier's hard ceiling, in
 * seconds; 0 when it fits. Only a positive overrun is re-asked.
 */
export function runtimeOverrunSec(spine: Spine, tier: DurationTier = spine.duration): number {
  return Math.max(0, spineRuntimeLowerBoundSec(spine) - tierRuntimeBand(tier)[1]);
}

/** True when no sourcing can bring this plan under the tier's ceiling. */
export function spineCannotFit(spine: Spine, tier: DurationTier = spine.duration): boolean {
  return runtimeOverrunSec(spine, tier) > 0;
}

/**
 * What the runtime re-ask names: one line with the overrun and what it is
 * made of, then one line per distinct seed window (where it first appears,
 * its length, and the claim), so the model can see which beats carry the
 * time and decide what to drop or merge.
 */
export function runtimeViolations(spine: Spine, tier: DurationTier = spine.duration): string[] {
  const parts = spineRuntimeLowerBoundParts(spine);
  const ceiling = tierRuntimeBand(tier)[1];
  const target = DURATION_RUNTIME_TARGET_SEC[tier];
  const headline =
    `the plan's minimum runtime is ${Math.round(parts.totalSec)} s — ${parts.windows} distinct seeded window(s) at ${Math.round(parts.tapeSec)} s ` +
    `(each plays at least its quoted length, never under ${TAPE_WINDOW_MIN_SEC} s), ${parts.narratedBeats} narrated beat(s) at ` +
    `${Math.round(NARRATED_BEAT_FLOOR_SEC)} s each and ${Math.round(parts.framingSec)} s of overview and act framing — above the ${tier} tier's ceiling of ` +
    `${ceiling} s (target ${target} s, +${Math.round(TIER_RUNTIME_TOLERANCE * 100)}%) by ${Math.round(parts.totalSec - ceiling)} s`;
  const windows = plannedWindows(spine.acts).map((w) => {
    const where = `act ${w.actIndex + 1}, slot ${w.slotIndex + 1}, beat ${w.beatIndex + 1}`;
    const claim = w.claim.length > 120 ? `${w.claim.slice(0, 120)}…` : w.claim;
    const shared = w.beats > 1 ? ` (shared by ${w.beats} beats)` : "";
    return `${where}: seeded from [${w.seed.episodeId} ${Math.round(w.seed.startSec)}-${Math.round(w.seed.endSec)}s], at least ${Math.round(
      windowFloorSec(w.seed)
    )} s of tape${shared} — "${claim}"`;
  });
  return [headline, ...windows];
}

/** The run log's one line, printed on every run that reached the spine. */
export function spineRuntimeLine(runtime: SpineRuntime, tier: DurationTier): string {
  const [min, max] = tierRuntimeBand(tier);
  return `spine runtime: lower bound ${runtime.lowerBoundSec}s, estimate ${runtime.estimateSec}s, tier band [${min},${max}]`;
}
