import type { FinalizeForayValidation, ForaySlot } from "./finalizeForay";
import { slugifySlotTitle, type ForayItem } from "./forayItems";
import type { SourcedAct } from "../types/tapeSourcing";
import { MODE_CHAR_BANDS, NARRATION_CHARS_PER_SEC } from "../types/narration";

/**
 * F-79 — judging a PARTIAL candidate on the PROJECTED WHOLE for the rules
 * that are shares of the whole, and on the partial itself for every rule that
 * is not (docs/curation/generation-run-2026-09-09.md, F-79; requirements
 * §3.11).
 *
 * THE FINDING. Run 5 (2026-09-11, the AI-systems prompt) sourced 25 tape
 * beats over 34, and G-30's new "abort on a refused partial" default fired
 * after act 1 because `check-forays` on the act-1 partial reported
 * `M4 FAIL: "practical-ai--open-source-self-driving-with-comma-ai" is 16.7 %
 * of segments and 26.4 % of runtime, over the 25 % cap` — a share computed
 * over a one-act partial of 6 segments that the whole 25-segment Foray would
 * dilute to a few per cent. Attempt 6's partial did the same at 3 segments
 * (33 % each). The run was ended for a failure the finished Foray would not
 * have had.
 *
 * WHICH RULES ARE MONOTONE UNDER PARTIAL ASSEMBLY, AND WHICH ARE NOT. A rule
 * is monotone here if a failure on any prefix of the Foray is still a failure
 * on the whole — appending later acts can never clear it. Those rules are
 * meaningful on a partial and stay strict on it. A share-of-whole rule has a
 * denominator that grows with every act, so a verdict on a prefix says
 * nothing about the whole; those are read from a projection instead.
 *
 *   PROJECTED (`PROJECTED_RULES`, matched by `projectedRuleOf`):
 *     M4        both clauses — one episode's share of segments / of tape
 *               runtime. The denominators are the whole Foray's.
 *     D3        mean segment duration ≥ 90 s — a mean over every segment.
 *     D5-IQR    interquartile range of segment durations ≥ 45 s — a spread
 *               over the whole distribution (a 3-segment act has no IQR to
 *               speak of).
 *     D2-end    "the Foray ends on two consecutive segments under 60 s" — a
 *               partial's last two segments are not the Foray's; the next
 *               act supplies (or fails to supply) the ≥ 150 s recovery.
 *     D4-share  `quote` segments over 20 % of segments — a share.
 *
 *   PARTIAL (`PARTIAL_RULES`), all monotone or per-item:
 *     shape/copy/disclosure/per-item rules (title, summary, slot titles,
 *     items[0] is the disclosure, a narration item has a script and a
 *     mode, a segment id resolves, an anchor on a DAI source, …);
 *     D1        a rolling-600 s start count is local, and `d1Budget` only
 *               FALLS as the Foray gets longer (8 / 6 / 5), so a prefix
 *               failure is a whole failure;
 *     D2-run    three consecutive short segments, or two followed by a
 *               short recovery — the offending run is already in the prefix;
 *     D4-adjacent, D5-triples — local runs of items;
 *     L2/L3/L4  per-segment duration bounds;
 *     M3        same-episode segments out of chronological order — the
 *               out-of-order pair is already in the prefix;
 *     runtime_sec agreement and slot contiguity — per-record.
 *
 * (The task brief names "M3-runtime": `check-forays.mjs` has no runtime
 * clause on M3 — M3 is the ordering rule, and it is monotone. M4 carries both
 * the count and the runtime clause, and both are projected.)
 *
 * HOW THE PROJECTION IS BUILT — from the SOURCING STAGE'S PLAN, not from a
 * guess. §4.5 (`sourceBeats.ts`) decides every beat's tape-or-narration before
 * a single page is written, and a tape beat's pointer already carries the
 * segment id, the episode and the cut (`startSec`/`endSec`). So at the moment
 * act N's partial exists, every later act's segment list is known exactly;
 * only its narration is unwritten, and that is estimated at each beat's mode
 * band midpoint (narration-craft §0's `MODE_CHAR_BANDS`, at the shared 17
 * chars/s) — narration is not a segment, so it moves no projected rule, and
 * the estimate exists so the projected record's clock is honest, not so a
 * rule can read it.
 *
 * WHAT THIS DOES NOT DO. It does not change a single rule's text in
 * `check-forays.mjs` — the projection is a second, ordinary record handed to
 * the same `finalize`, and the only thing this module adds is WHICH record
 * each rule's verdict is read from. It does not weaken the partial: every
 * monotone rule is still judged on the partial alone, and a projected rule
 * that fails on the projection refuses the partial exactly as before (G-30's
 * abort default stays; it now fires on a failure the finished Foray would
 * also have). And it does not run on the LAST act — that partial is the whole,
 * and the projection would be the same record twice.
 */

/** The share-of-whole rules whose verdict is read from the projection. */
export const PROJECTED_RULES = ["M4", "D3", "D5-IQR", "D2-end", "D4-share"] as const;
export type ProjectedRule = (typeof PROJECTED_RULES)[number];

/** Everything else `check-forays.mjs` gates — judged on the partial alone.
 * Names, not regexes: nothing needs to match these, they are what the
 * candidate's `ruleScope.partial` reports. */
export const PARTIAL_RULES = [
  "shape",
  "copy",
  "disclosure",
  "per-item",
  "runtime_sec",
  "slots",
  "D1",
  "D2-run",
  "D4-adjacent",
  "D5-triples",
  "L2/L3/L4",
  "M3",
  "#65-anchors"
] as const;

/* Matched against the message AFTER the checker's own `foray "<id>": ` prefix
 * is stripped. Each pattern is the opening of exactly one `E(...)` call in
 * `check-forays.mjs`; the two D2 and two D4/D5 clauses share a rule prefix,
 * so the clause text is what tells the projected clause from the monotone
 * one. */
const PROJECTED_RULE_PATTERNS: ReadonlyArray<readonly [ProjectedRule, RegExp]> = [
  ["M4", /^M4 FAIL:/],
  ["D3", /^D3 FAIL:/],
  ["D5-IQR", /^D5 FAIL: interquartile range/],
  ["D2-end", /^D2 FAIL: the Foray ends on two consecutive segments/],
  ["D4-share", /^D4 FAIL: \d+\/\d+ segments are `quote`/]
];

/** The projected rule a `check-forays` error line belongs to, or `null` when
 * the line is a monotone rule's and must be judged on the partial. */
export function projectedRuleOf(error: string): ProjectedRule | null {
  const body = error.replace(/^foray "[^"]*": /, "");
  for (const [rule, rx] of PROJECTED_RULE_PATTERNS) if (rx.test(body)) return rule;
  return null;
}

/** What `runPipeline.ts` knows after §4.5 and before §4.7: the sourced plan
 * for every act, and the whole Foray's declared slots (in the same act/slot
 * order — `slotsFromSpine`). */
export interface PartialProjectionPlan {
  sourcedActs: SourcedAct[];
  slots: ForaySlot[];
}

export interface ProjectedItems {
  /** The partial's own items, verbatim, followed by one item per beat of
   * every act after `actIndex`. */
  items: ForayItem[];
  /** Seconds the projected acts add to the partial's own runtime: tape from
   * the pointers' cuts, narration from the band-midpoint estimates. */
  addedRuntimeSec: number;
  projectedActs: number;
  projectedTapeSegments: number;
  projectedNarrationItems: number;
}

/** narration-craft §0's band midpoint for a mode, at the shared rate. */
export function projectedNarrationSec(mode: keyof typeof MODE_CHAR_BANDS): number {
  const [lo, hi] = MODE_CHAR_BANDS[mode];
  return Math.round(((lo + hi) / 2 / NARRATION_CHARS_PER_SEC) * 1000) / 1000;
}

/**
 * The projected whole: the partial's items through `actIndex`, then every
 * later act's beats as the sourcing stage planned them. Pure — reads the
 * plan, invents nothing. The slot id of a projected item is the declared
 * slot at the same flat position (`slotsFromSpine` de-duplicates ids, so the
 * title alone is not enough); a plan shorter than the sourced acts falls
 * back to the title's slug, which is what an un-duplicated title gets anyway.
 */
export function buildProjectedItems(partialItems: ForayItem[], actIndex: number, plan: PartialProjectionPlan): ProjectedItems {
  const items: ForayItem[] = [...partialItems];
  let addedRuntimeSec = 0;
  let projectedActs = 0;
  let projectedTapeSegments = 0;
  let projectedNarrationItems = 0;

  let flatSlot = 0;
  for (let a = 0; a < plan.sourcedActs.length; a++) {
    const act = plan.sourcedActs[a]!;
    if (a <= actIndex) {
      flatSlot += act.slots.length;
      continue;
    }
    projectedActs += 1;
    let beatIndex = 0;
    /** F-96: a beat merged into an earlier beat's clip shares its segment;
     * the clip is projected once, as `stitchAct` emits it once. */
    const projectedSegments = new Set<string>();
    for (const slot of act.slots) {
      const slotId = plan.slots[flatSlot]?.id ?? slugifySlotTitle(slot.title);
      flatSlot += 1;
      for (const beat of slot.beats) {
        const n = beatIndex++;
        if (beat.sourcing === "tape") {
          if (projectedSegments.has(beat.tape.segmentId)) continue;
          projectedSegments.add(beat.tape.segmentId);
          items.push({ type: "segment", segment_id: beat.tape.segmentId, slot: slotId });
          addedRuntimeSec += beat.tape.endSec - beat.tape.startSec;
          projectedTapeSegments += 1;
          continue;
        }
        const mode = beat.narration.mode;
        const sec = projectedNarrationSec(mode);
        /* `duration_sec` is what the checker reads first (`narrationDuration`
           in player/foray-queue.js: a present duration wins over the script
           estimate), so the estimate travels on the field the checker
           honours. `ForayNarrationItemSchema` deliberately has no such field
           — the pipeline never measures narration — hence the cast; this
           item is only ever handed to `finalize`, never published. The
           script says what it is, at Hinge-floor length so the per-item
           placeholder rule does not fire on it. */
        const projected = {
          type: "narration",
          id: `projected:act-${a + 1}:beat-${n}`,
          mode: mode.toLowerCase(),
          slot: slotId,
          script: `Projected ${mode} narration for beat ${n + 1} of "${slot.title}" (act ${a + 1}) — not yet written; sized to the ${mode} band midpoint.`,
          duration_sec: sec
        };
        items.push(projected as unknown as ForayItem);
        addedRuntimeSec += sec;
        projectedNarrationItems += 1;
      }
    }
  }

  return {
    items,
    addedRuntimeSec: Math.round(addedRuntimeSec * 1000) / 1000,
    projectedActs,
    projectedTapeSegments,
    projectedNarrationItems
  };
}

/** How the candidate's verdict was assembled — the report a reader of the
 * partial file (or of `RefusedPartialError`) needs to tell a whole-Foray
 * failure from a one-act artefact. */
export interface PartialRuleScope {
  /** `projected`: share-of-whole rules read from the projection, the rest
   * from the partial. `whole`: the last act — the partial IS the whole, every
   * rule on it. `partial-only`: no plan was supplied (a caller that predates
   * F-79, or a test), every rule on the partial as before. */
  basis: "projected" | "whole" | "partial-only";
  /** Rules whose verdict came from the projection — empty unless `basis`
   * is `projected`. */
  projected: ProjectedRule[];
  /** Rules judged on the partial's own items. */
  partial: string[];
  projection: {
    acts: number;
    tapeSegments: number;
    narrationItems: number;
    items: number;
    runtimeSec: number;
    /** The projection's full `check-forays` verdict, for diagnosis — only
     * the projected rules' lines above are read into the candidate's
     * validation. */
    errors: string[];
    warnings: string[];
    /** The partial's own share-rule lines the projection superseded — run
     * 5's `M4 FAIL … 16.7 % of segments and 26.4 % of runtime` would sit
     * here, not in `validation.checkForaysErrors`. */
    supersededOnPartial: string[];
  } | null;
}

export function partialOnlyScope(basis: "whole" | "partial-only"): PartialRuleScope {
  return { basis, projected: [], partial: [...PARTIAL_RULES, ...PROJECTED_RULES], projection: null };
}

export interface MergedVerdict {
  validation: FinalizeForayValidation;
  scope: PartialRuleScope;
}

/**
 * One verdict from two: every monotone rule's lines from the partial's own
 * validation, every projected rule's lines from the projection's. The
 * check-narration half is the partial's (it validates on-disk curation
 * artefacts, not either record — see `finalizeForay.ts`). A warning names
 * what was judged where, so the partial file reads the same way this
 * module's doc comment does.
 */
export function mergeProjectedVerdict(
  partial: FinalizeForayValidation,
  projection: FinalizeForayValidation,
  built: ProjectedItems,
  partialTapeSegments: number,
  projectedRuntimeSec: number
): MergedVerdict {
  const supersededOnPartial = partial.checkForaysErrors.filter((e) => projectedRuleOf(e) !== null);
  const keptFromPartial = partial.checkForaysErrors.filter((e) => projectedRuleOf(e) === null);
  const takenFromProjection = projection.checkForaysErrors.filter((e) => projectedRuleOf(e) !== null);
  const checkForaysErrors = [...keptFromPartial, ...takenFromProjection];
  const scopeLine =
    `F-79: ${PROJECTED_RULES.join(", ")} judged on the projected whole ` +
    `(${partialTapeSegments + built.projectedTapeSegments} tape segments across ${built.projectedActs} projected act(s), ` +
    `${built.items.length} items, ${projectedRuntimeSec.toFixed(1)} s); every other rule judged on the partial ` +
    `(${partialTapeSegments} tape segment(s))` +
    (supersededOnPartial.length ? `; ${supersededOnPartial.length} share-rule line(s) on the partial set aside` : "");
  const validation: FinalizeForayValidation = {
    ok: checkForaysErrors.length === 0 && partial.checkNarrationErrors.length === 0,
    checkForaysErrors,
    checkForaysWarnings: [...partial.checkForaysWarnings, scopeLine],
    checkNarrationErrors: partial.checkNarrationErrors,
    checkNarrationWarnings: partial.checkNarrationWarnings
  };
  return {
    validation,
    scope: {
      basis: "projected",
      projected: [...PROJECTED_RULES],
      partial: [...PARTIAL_RULES],
      projection: {
        acts: built.projectedActs,
        tapeSegments: partialTapeSegments + built.projectedTapeSegments,
        narrationItems: built.projectedNarrationItems,
        items: built.items.length,
        runtimeSec: projectedRuntimeSec,
        errors: projection.checkForaysErrors,
        warnings: projection.checkForaysWarnings,
        supersededOnPartial
      }
    }
  };
}

/** Tape segments in an item list — the partial's own count, for the report. */
export function countTapeSegments(items: ForayItem[]): number {
  return items.filter((i) => i.type === "segment").length;
}
