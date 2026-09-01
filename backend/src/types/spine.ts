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
 * subject; a topic just names it.
 *
 * This is a LEXICAL HEURISTIC, not a parser — there is no dependency-free
 * POS tagger in this codebase, and hand-rolling exhaustive English
 * grammar is out of scope for a single validation gate. Three review
 * rounds on this function converged on one structural trade-off, made
 * explicit here rather than left implicit:
 *
 *   REJECTING a valid claim is far more costly than ACCEPTING an invalid
 *   one. A false rejection throws out an entire generated spine
 *   (`buildSpine` fails the whole 8-110-beat paid LLM call over one
 *   beat); a false acceptance lets a single topic-shaped beat slip past
 *   validation into an otherwise-fine spine. This function is therefore
 *   deliberately biased toward ACCEPTING — it looks for verb-shaped
 *   evidence ANYWHERE past the first word, not only in a strict
 *   subject-adjacent position, even though that means a rare
 *   bare-noun-phrase construction (e.g. "Ford briquettes and Kingsford
 *   products") can slip through as a false accept. The `beat-not-claim-
 *   shaped` validation issue is best treated as high-recall, not perfect
 *   precision: it reliably catches the doc's own example non-claim
 *   ("Briquettes") and short noun phrases, without being a silent
 *   production-killer for ordinary English sentences an LLM actually
 *   writes.
 *
 * Signals combined, none needing to be individually exhaustive:
 *   1. A small CLOSED class of auxiliary/modal/copula verbs
 *      (`FINITE_AUX_VERBS`) — genuinely closed in English.
 *   2. A short list of common IRREGULAR past-tense verbs
 *      (`COMMON_IRREGULAR_PAST_VERBS`) — covers simple pasts with no
 *      -s/-ed/-ing signal at all ("ran", "wrote", "sold").
 *   3. Regular past-tense morphology (-ed), and progressive morphology
 *      (-ing directly after a be-auxiliary) — covers the open regular-
 *      verb class without enumerating it.
 *   4. Present-tense 3rd-person-singular morphology (-s/-es), gated only
 *      by a small plural-noun exception list, checked anywhere past the
 *      first word (see the trade-off note above for why this is
 *      deliberately not further position-restricted).
 *   5. A narrow bare-form fallback for a single plural-noun-looking
 *      subject directly followed by an unsuffixed present-tense verb
 *      ("Researchers study...", "Historians dispute...") — the one verb
 *      shape with NO morphological signal at all, so it can only be
 *      caught structurally at the sentence's own subject-verb boundary.
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
  "must"
]);

/** Supplements (3)/(4) above for common IRREGULAR simple-past verbs that
 * carry no -ed/-s/-ing signal at all. Deliberately small and explicitly
 * a supplement, not the primary detection mechanism — see the doc
 * comment on `isClaimShaped`. */
const COMMON_IRREGULAR_PAST_VERBS = new Set([
  "ran",
  "went",
  "came",
  "saw",
  "knew",
  "thought",
  "took",
  "gave",
  "found",
  "told",
  "wrote",
  "spoke",
  "broke",
  "chose",
  "grew",
  "threw",
  "drove",
  "rode",
  "flew",
  "fell",
  "held",
  "kept",
  "left",
  "lost",
  "meant",
  "met",
  "paid",
  "sold",
  "sent",
  "set",
  "shot",
  "sang",
  "sat",
  "stood",
  "won",
  "began",
  "became",
  "brought",
  "bought",
  "built",
  "caught",
  "led",
  "made",
  "understood",
  "spent",
  "spread",
  "swam",
  "taught",
  "woke",
  "wore"
]);

/** Words that are near-universally used as nouns even though they carry
 * an -s suffix (plural nouns), to keep the present-tense-agreement check
 * from treating an obvious plural noun as a verb. Kept deliberately
 * small and expanded as real false positives are found — it only needs
 * to catch the common cases, not be exhaustive, since it gates one of
 * several signals in a deliberately accept-biased check (see the
 * trade-off note on `isClaimShaped`). */
const PLURAL_NOUN_EXCEPTIONS = new Set([
  "years",
  "decades",
  "episodes",
  "listeners",
  "companies",
  "dealerships",
  "briquettes",
  "reports",
  "sources",
  "records",
  "documents",
  "items",
  "beats",
  "acts",
  "slots",
  "products",
  "grills",
  "shows",
  "podcasts"
]);

/** Words that are near-universally used as nouns/adjectives even though
 * they carry an -ing suffix (gerund-as-noun), e.g. "manufacturing",
 * "marketing" — a short, clearly-labeled exception list, not the
 * primary detection mechanism. */
const GERUND_NOUN_EXCEPTIONS = new Set(["manufacturing", "marketing", "engineering", "farming", "advertising", "branding", "packaging"]);

/** Function words that can immediately follow a subject without being a
 * verb ("Researchers and engineers...", "Historians of this era...") —
 * used to gate the bare-form fallback below, so a non-verb second word
 * doesn't get misread as a bare-form present-tense verb. Deliberately
 * covers the common conjunctions/prepositions, not an exhaustive closed
 * class of every non-verb. */
const NON_VERB_SECOND_WORDS = new Set([
  "and",
  "or",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "with",
  "by",
  "as",
  "who",
  "which",
  "from"
]);

/** True when `word` (lowercased, punctuation-stripped) looks like an
 * INFLECTED finite verb by itself — closed-class auxiliary, a known
 * irregular past, regular -ed, or -s/-es agreement not on the
 * plural-noun exception list. Does NOT check bare present-tense form (no
 * suffix at all, e.g. "study", "dispute") — that is only accepted at the
 * sentence's own subject-verb boundary via the fallback in
 * `isClaimShaped`, since a bare word is otherwise indistinguishable from
 * a noun. */
function looksLikeInflectedVerb(word: string): boolean {
  if (FINITE_AUX_VERBS.has(word)) return true;
  if (COMMON_IRREGULAR_PAST_VERBS.has(word)) return true;
  if (word.length > 4 && word.endsWith("ed") && !GERUND_NOUN_EXCEPTIONS.has(word)) return true;
  if (word.length > 3 && (word.endsWith("es") || word.endsWith("s")) && !PLURAL_NOUN_EXCEPTIONS.has(word)) return true;
  return false;
}

export function isClaimShaped(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const rawWords = trimmed.split(/\s+/).filter(Boolean);
  if (rawWords.length < 3) return false;

  const words = rawWords.map((w) => w.toLowerCase().replace(/[^a-z0-9']/g, ""));

  // (1) Closed-class auxiliary/modal/copula, anywhere in the sentence.
  if (words.some((w) => FINITE_AUX_VERBS.has(w))) return true;

  // (2)-(4) Any INFLECTED verb-shaped word anywhere past the first token
  // (irregular past, regular -ed, or -s/-es agreement). Checked anywhere
  // in the sentence rather than only at the grammatical subject boundary
  // — see the accept-biased trade-off documented on this function —
  // which is what lets a common-noun subject ("Charcoal production
  // shapes modern grilling culture") pass without needing to identify
  // where its subject phrase ends.
  for (let i = 1; i < words.length; i++) {
    const word = words[i]!;
    if (word.length === 0) continue;

    if (looksLikeInflectedVerb(word)) return true;

    // Progressive: "-ing" directly preceded by a be-auxiliary, e.g. "is
    // reshaping", "was disputing" — excludes bare sentence-final gerund
    // nouns like "...briquette manufacturing" because there is no
    // preceding auxiliary there.
    if (word.length > 4 && word.endsWith("ing") && !GERUND_NOUN_EXCEPTIONS.has(word)) {
      const prev = words[i - 1];
      if (prev && (prev === "is" || prev === "are" || prev === "was" || prev === "were" || prev === "been" || prev === "being")) {
        return true;
      }
    }
  }

  // (5) NARROW bare-form fallback: a single-token, plural-noun-looking
  // subject ("Researchers", "Historians" — capitalized, ends in "s")
  // directly followed by an unsuffixed present-tense verb ("study",
  // "dispute"), which carries no morphological signal at all and so
  // cannot be caught by (2)-(4) above.
  const firstRaw = rawWords[0]!;
  const secondWord = words[1];
  if (
    /^[A-Z]/.test(firstRaw) &&
    words[0]!.endsWith("s") &&
    !PLURAL_NOUN_EXCEPTIONS.has(words[0]!) &&
    secondWord &&
    secondWord.length >= 3 &&
    !NON_VERB_SECOND_WORDS.has(secondWord) &&
    !looksLikeInflectedVerb(secondWord) &&
    !/^[A-Z]/.test(rawWords[1] ?? "")
  ) {
    return true;
  }

  return false;
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
