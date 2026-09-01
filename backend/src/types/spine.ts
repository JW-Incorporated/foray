import { z } from "zod";

/**
 * §4.3 spine types (docs/curation/generation-architecture.md §4.3).
 * Output of the spine-building stage: takes §4.1's `IntentUnderstanding`,
 * §4.2's `ResearchShape`, and the requested duration tier as input, and
 * produces the ONE document that fixes acts, slots, beats, voice and the
 * exploration budget before any per-act deepening (§4.4) begins.
 *
 * §5's topology table calls this stage "1, always" and "the one stage
 * where parallelism is actively destructive" — the spine *is* the
 * coherence, so it is built in one document by one agent/call, never
 * assembled from independently-produced pieces.
 *
 * VOICE IS SPINE-LEVEL, STRUCTURALLY. `ActSchema` below is `.strict()`
 * and carries no `voice` field of its own — a per-act voice cannot even
 * parse, let alone drift, at this stage (§4.3: "the voice must be decided
 * here, once, so every downstream writer inherits it rather than
 * inventing one").
 */

export const DurationTierSchema = z.enum(["short", "medium", "long"]);
export type DurationTier = z.infer<typeof DurationTierSchema>;

/** §3's duration-to-shape budget table, used exactly. Each tuple is
 * `[min, max]` inclusive, matching the doc's table verbatim. */
export const DURATION_SHAPE_BUDGETS: Record<DurationTier, { acts: [number, number]; slots: [number, number]; items: [number, number] }> = {
  short: { acts: [1, 1], slots: [2, 3], items: [8, 10] },
  medium: { acts: [3, 4], slots: [5, 7], items: [28, 36] },
  long: { acts: [5, 7], slots: [12, 18], items: [80, 110] }
};

/** §8's own runtime tolerance — the closest existing precedent for "a
 * reasonable tolerance" on the act/slot/item budgets, per this stage's
 * task brief. Applied as slack on top of the §3 min/max band, not
 * instead of it: a count inside the band is always fine; a count outside
 * it is only fine within this fraction of the nearest edge. */
export const SHAPE_TOLERANCE = 0.15;

/** Floor from product principle #1 (§4.3 / §8): at least this fraction of
 * beats must be marked exploration. A floor, not a target — more is fine. */
export const EXPLORATION_FLOOR = 0.3;

/**
 * A beat is the atomic unit of content, stated as a CLAIM, never a topic.
 * §4.3's own example: "Charcoal briquettes were a Ford Motor Company
 * waste-disposal scheme" is a beat; "Briquettes" is not.
 *
 * `exploration` marks beats belonging to the ~30% exploration budget
 * (§4.3: "Mark these in the spine. They are the first thing a
 * cost-cutting pass will delete and the last thing that should be
 * deleted.") — explicit and structural, not left to be inferred later.
 */
export const BeatSchema = z
  .object({
    claim: z.string().trim().min(1),
    exploration: z.boolean()
  })
  .strict();
export type Beat = z.infer<typeof BeatSchema>;

/** The persistence-layer subdivision an act decomposes into (§2's
 * reconciliation rule: "one act may contain several slots"). This is a
 * planning-time slot, not a `forays.json` write — §2 is explicit that
 * slots are not added as a new `forays.json` field here. */
export const SlotSchema = z
  .object({
    title: z.string().trim().min(1),
    beats: z.array(BeatSchema).min(1)
  })
  .strict();
export type Slot = z.infer<typeof SlotSchema>;

/** One top-level narrative movement. Deliberately has NO `voice` field —
 * see the module doc comment above. */
export const ActSchema = z
  .object({
    title: z.string().trim().min(1),
    thesis: z.string().trim().min(1),
    /** What the listener believes entering the act. */
    startState: z.string().trim().min(1),
    /** What the listener should believe leaving the act. */
    endState: z.string().trim().min(1),
    slots: z.array(SlotSchema).min(1)
  })
  .strict();
export type Act = z.infer<typeof ActSchema>;

/** Decided once, at the spine level, per §4.3: "A Foray on fusion reactors
 * and a Foray on 1970s fashion do not share a voice." */
export const VoiceSchema = z
  .object({
    style: z.string().trim().min(1),
    register: z.string().trim().min(1),
    sentenceRhythm: z.string().trim().min(1),
    narratorPresence: z.string().trim().min(1)
  })
  .strict();
export type Voice = z.infer<typeof VoiceSchema>;

export const SpineSchema = z
  .object({
    subject: z.string().trim().min(1),
    angle: z.string().trim().min(1),
    duration: DurationTierSchema,
    generatedAt: z.string(),
    voice: VoiceSchema,
    acts: z.array(ActSchema).min(1)
  })
  .strict();
export type Spine = z.infer<typeof SpineSchema>;

/** Flattened counting helpers — §3's budgets are stated in acts/slots/items
 * (item === beat at spine granularity; §4.5-4.7 is what turns a beat into a
 * playable item, but the count target is set here). */
export function countActs(spine: Spine): number {
  return spine.acts.length;
}
export function countSlots(spine: Spine): number {
  return spine.acts.reduce((sum, act) => sum + act.slots.length, 0);
}
export function allBeats(spine: Spine): Beat[] {
  return spine.acts.flatMap((act) => act.slots.flatMap((slot) => slot.beats));
}
export function countBeats(spine: Spine): number {
  return allBeats(spine).length;
}

/**
 * Claim-shape check (§4.3's own bar). A claim asserts something about its
 * subject; a topic just names it. Heuristic, but a real check rather than
 * a cosmetic one: reject anything under three words outright (no room for
 * a subject + predicate), then require either a recognizable finite
 * auxiliary/linking/modal verb, or a content word inflected as a finite
 * verb (past tense -ed / progressive -ing, excluding the first word so a
 * leading gerund-as-noun like "Farming" alone doesn't pass on shape only).
 */
const FINITE_AUX_VERBS = new Set([
  "is",
  "are",
  "was",
  "were",
  "am",
  "be",
  "been",
  "being",
  "has",
  "have",
  "had",
  "do",
  "does",
  "did",
  "can",
  "could",
  "will",
  "would",
  "shall",
  "should",
  "may",
  "might",
  "must",
  "became",
  "becomes",
  "become",
  "makes",
  "made",
  "gave",
  "gives",
  "took",
  "takes",
  "means",
  "meant",
  "led",
  "leads",
  "caused",
  "causes",
  "began",
  "begins",
  "started",
  "starts",
  "ended",
  "ends",
  "killed",
  "kills",
  "changed",
  "changes",
  "turned",
  "turns",
  "sold",
  "sells",
  "bought",
  "buys",
  "brought",
  "brings",
  "built",
  "builds",
  "found",
  "finds",
  "wrote",
  "writes",
  "said",
  "says",
  "went",
  "goes",
  "kept",
  "keeps",
  "held",
  "holds",
  "won",
  "wins",
  "lost",
  "loses",
  "grew",
  "grows",
  "spread",
  "shaped",
  "shapes",
  "forced",
  "forces",
  "revealed",
  "reveals",
  "proved",
  "proves",
  "disputed",
  "disputes",
  "attribute",
  "attributes",
  "attributed",
  "surprised",
  "surprises",
  "explains",
  "explained",
  "matters",
  "mattered",
  "dismissed",
  "dismisses"
]);

/** Words that are near-universally used as nouns/adjectives even though
 * they carry an -ing/-ed suffix (e.g. "manufacturing", "marketing",
 * "advertised" as an adjective is rarer, so this list is deliberately
 * short and biased toward -ing gerund-as-noun false positives, the
 * dominant failure mode of a bare suffix check). */
const GERUND_NOUN_EXCEPTIONS = new Set(["manufacturing", "marketing", "engineering", "farming", "advertising", "branding", "packaging"]);

export function isClaimShaped(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const rawWords = trimmed.split(/\s+/).filter(Boolean);
  if (rawWords.length < 3) return false;

  const words = rawWords.map((w) => w.toLowerCase().replace(/[^a-z0-9']/g, ""));
  if (words.some((w) => FINITE_AUX_VERBS.has(w))) return true;

  // A content word (not the first token, and not a known gerund-as-noun)
  // inflected as a finite past-tense verb is accepted as evidence of an
  // assertion, e.g. "Ford disposed of briquette waste through dealerships"
  // ("disposed"). Progressive -ing is excluded from this fallback entirely
  // — "manufacturing", "marketing" etc. are common sentence-final gerund
  // nouns that would otherwise produce false positives on bare topics like
  // "charcoal briquette manufacturing".
  return words.some((w, i) => i > 0 && w.length > 4 && w.endsWith("ed") && !GERUND_NOUN_EXCEPTIONS.has(w));
}

export interface SpineValidationIssue {
  code:
    | "act-count-out-of-budget"
    | "slot-count-out-of-budget"
    | "item-count-out-of-budget"
    | "beat-not-claim-shaped"
    | "exploration-floor-not-met";
  message: string;
}

export interface SpineValidationResult {
  valid: boolean;
  issues: SpineValidationIssue[];
  counts: { acts: number; slots: number; items: number; explorationBeats: number };
}

function withinTolerance(actual: number, [min, max]: [number, number], tolerance: number): boolean {
  const lower = min * (1 - tolerance);
  const upper = max * (1 + tolerance);
  return actual >= lower && actual <= upper;
}

/**
 * Validates a spine against §3's duration budgets, §4.3's claim-shape
 * requirement for every beat, and §4.3/§8's ~30% exploration floor. This
 * is a real, structural check — not cosmetic — because this stage is the
 * document's own "highest-leverage artefact" and an invalid spine here
 * corrupts every downstream stage.
 */
export function validateSpine(spine: Spine): SpineValidationResult {
  const issues: SpineValidationIssue[] = [];
  const budget = DURATION_SHAPE_BUDGETS[spine.duration];

  const acts = countActs(spine);
  const slots = countSlots(spine);
  const beats = allBeats(spine);
  const items = beats.length;
  const explorationBeats = beats.filter((b) => b.exploration).length;

  if (!withinTolerance(acts, budget.acts, SHAPE_TOLERANCE)) {
    issues.push({
      code: "act-count-out-of-budget",
      message: `${acts} acts is outside the ${spine.duration} tier's budget of ${budget.acts[0]}-${budget.acts[1]} (±${SHAPE_TOLERANCE * 100}% tolerance)`
    });
  }
  if (!withinTolerance(slots, budget.slots, SHAPE_TOLERANCE)) {
    issues.push({
      code: "slot-count-out-of-budget",
      message: `${slots} slots is outside the ${spine.duration} tier's budget of ${budget.slots[0]}-${budget.slots[1]} (±${SHAPE_TOLERANCE * 100}% tolerance)`
    });
  }
  if (!withinTolerance(items, budget.items, SHAPE_TOLERANCE)) {
    issues.push({
      code: "item-count-out-of-budget",
      message: `${items} beats is outside the ${spine.duration} tier's budget of ${budget.items[0]}-${budget.items[1]} (±${SHAPE_TOLERANCE * 100}% tolerance)`
    });
  }

  for (const beat of beats) {
    if (!isClaimShaped(beat.claim)) {
      issues.push({
        code: "beat-not-claim-shaped",
        message: `Beat is topic-shaped, not claim-shaped: "${beat.claim}"`
      });
    }
  }

  if (items > 0) {
    const required = Math.ceil(items * EXPLORATION_FLOOR - 1e-9);
    if (explorationBeats < required) {
      issues.push({
        code: "exploration-floor-not-met",
        message: `Only ${explorationBeats}/${items} beats marked exploration; need at least ${required} (${EXPLORATION_FLOOR * 100}% floor)`
      });
    }
  }

  return { valid: issues.length === 0, issues, counts: { acts, slots, items, explorationBeats } };
}
