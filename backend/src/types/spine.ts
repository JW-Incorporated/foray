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
/**
 * What KIND of thing a beat asserts — the distinction §4.5 needs and did not
 * have (finding F-38).
 *
 * An `account` is something that happened to someone, somewhere: a person can
 * be on tape describing it, so looking for tape is worth doing. An `argument`
 * is a thesis about a class of events ("every link in a failure chain gets
 * evaluated against a local question and almost never against the global
 * one") — no episode in any archive is "about" it, so a word-overlap search can
 * only ever return a coincidence. Run 1 ran the same scorer over both and
 * anchored exactly that argument to a *Geology Bites* episode on banded iron
 * formations. Spoken argument is what narration is FOR.
 *
 * Set by §4.4 (the deepen stage), which is the first stage that has both the
 * act's thesis and the beat's final wording in front of it. Optional in the
 * schema on purpose: §4.3's spine writes beats before anything has judged them,
 * and an absent `kind` means `account` — the search-everything behaviour that
 * predates this field.
 *
 * HOW NARROW "ARGUMENT" IS, AFTER RUN 2 (F-49). Told only that an argument is a
 * "thesis or generalisation", the deepen stage tagged 29 of 35 beats of an
 * AI-engineering Foray `argument` — on an angle-driven spine almost every beat
 * can be read as a thesis — and §4.5 skipped tape lookup for all 29. So the
 * line is drawn at what a RECORDING can carry: `account` is the default and
 * covers an event, a practice, a measurement or a mechanism someone could be
 * heard describing; `argument` is only a claim about what something MEANS or
 * what someone SHOULD do, which no recording of an event, a person or a
 * practice could carry. `deepenActs.ts` also caps arguments at one third of a
 * slot's beats, so a prompt that drifts again costs a warning rather than a
 * Foray's worth of tape.
 */
export const BeatKindSchema = z.enum(["account", "argument"]);
export type BeatKind = z.infer<typeof BeatKindSchema>;

/**
 * THE STRETCH OF TAPE A BEAT WAS WRITTEN FROM (fix plan WS-L; finding F-63).
 *
 * §4.2 now hands §4.3 the transcript windows themselves — show, episode, times
 * and the sentences spoken in them (`types/research.ts`'s
 * `ResearchTapeWindowSchema`) — and a seeded beat is one whose claim was
 * written FROM one of those windows rather than from the model's own knowledge
 * of the subject. The seed is the return trip: it names the window, so §4.5 can
 * open that episode before anything the text index ranks and ask F-61's window
 * search whether the tape there is still about the claim as finally worded.
 *
 * IT IS A POINTER, NOT A PROMISE. Nothing downstream trusts it: the seeded
 * episode goes through the same relevance floor, the same lineage gate and the
 * same anchor minting as any other candidate, and a seeded beat whose claim
 * drifted away from its window is narrated exactly like an unseeded one. What
 * the seed buys is the ORDER of the search, and the trace says whether it won.
 *
 * Optional, and absent is the normal case: a beat the spine wrote from
 * knowledge, every beat of a subject with no tape, and every spine written
 * before this field existed.
 */
export const BeatSeedSchema = z
  .object({
    /** `deriveItemId`'s id for the episode, copied from the research window. */
    episodeId: z.string().trim().min(1),
    startSec: z.number().nonnegative(),
    endSec: z.number().positive()
  })
  .strict();
export type BeatSeed = z.infer<typeof BeatSeedSchema>;

/**
 * WHO PUT THE SEED THERE (F-98).
 *
 * `"spine"` — §4.3 wrote the claim FROM that window, which is the whole of
 * WS-L's claim about why a seed is the best-informed guess in the pipeline.
 * `"assigned"` — `postSeedSpine.ts` scored the offered windows against a claim
 * the spine left unseeded and attached the best one. The two are the same
 * POINTER and face the same gates downstream, but they are not the same
 * evidence, and run 8 vs run 9 is why the distinction has to survive into the
 * run log: seed yield is model variance, and a line that reported one number
 * could not say whether a good run was a good reply or a good rescue.
 *
 * Absent means the beat has no seed, or the spine predates this field.
 */
export const BeatSeedSourceSchema = z.enum(["spine", "assigned"]);
export type BeatSeedSource = z.infer<typeof BeatSeedSourceSchema>;

export const BeatSchema = z
  .object({
    claim: z.string().trim().min(1),
    exploration: z.boolean(),
    kind: BeatKindSchema.optional(),
    seed: BeatSeedSchema.optional(),
    seedSource: BeatSeedSourceSchema.optional()
  })
  .strict();
export type Beat = z.infer<typeof BeatSchema>;

/**
 * How many `account` beats per act must be seeded from a research window
 * (WS-L). A FLOOR, and a low one: two beats an act is the least that makes a
 * Foray's tape a consequence of what the archive holds rather than a coincidence
 * — run 2 shipped 35 beats seeded from none.
 *
 * Enforced in `spineStructure.ts`, and ONLY when the research map actually
 * listed windows: a subject the archive has nothing for still gets today's
 * spine, which is §4.2's guardrail carried one stage forward.
 */
export const SPINE_MIN_SEEDED_BEATS_PER_ACT = 2;

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

/**
 * §4.4 output shape (docs/curation/generation-architecture.md §4.4): the
 * same `Act` shape, with slots/beats refined and two new fields added —
 * `introduction` (the act's own opening, written here rather than left to
 * §4.8's stitching stage) and `exit` (this act's half of the handoff into
 * the next act; §4.8's continuity agent later reconciles the CROSS-act
 * seam, but each act's own exit half is produced here).
 *
 * Still has no `voice` field — voice stays spine-level (see `ActSchema`'s
 * doc comment above); deepening an act never introduces a per-act voice.
 */
export const DeepenedActSchema = ActSchema.extend({
  introduction: z.string().trim().min(1),
  exit: z.string().trim().min(1),
  /**
   * Structural complaints the deepen STAGE has about what the builder handed
   * back, carried on the act itself rather than written to a console (F-49).
   *
   * Run 2 tagged 29 of 35 beats `argument` and nobody saw it until the run
   * had finished with zero tape: the only trace was the absence of tape, four
   * stages later. A warning that travels with the act is checkpointed with it,
   * survives a resume, and can be asserted in a test; a `console.warn` is
   * none of those things. Optional and absent when the act needed no
   * correction, so an untouched act is byte-identical to what it was before
   * this field existed.
   */
  warnings: z.array(z.string().trim().min(1)).optional()
}).strict();
export type DeepenedAct = z.infer<typeof DeepenedActSchema>;

export interface DeepenedActValidationIssue {
  code: "beat-not-claim-shaped" | "introduction-missing" | "exit-missing" | "slot-count-changed";
  message: string;
}

export interface DeepenedActValidationResult {
  valid: boolean;
  issues: DeepenedActValidationIssue[];
}

/**
 * Structural validation for one deepened act, checked against the ORIGINAL
 * spine act it deepened. §4.4 refines slots/beats — it does not add or
 * remove them — so a builder that drops or invents a slot is a bug this
 * catches rather than a silent shape drift.
 */
export function validateDeepenedAct(original: Act, deepened: DeepenedAct): DeepenedActValidationResult {
  const issues: DeepenedActValidationIssue[] = [];

  if (deepened.slots.length !== original.slots.length) {
    issues.push({
      code: "slot-count-changed",
      message: `Deepening changed slot count from ${original.slots.length} to ${deepened.slots.length} — §4.4 refines slots, it does not add or remove them`
    });
  }

  for (const slot of deepened.slots) {
    for (const beat of slot.beats) {
      if (!isClaimShaped(beat.claim)) {
        issues.push({
          code: "beat-not-claim-shaped",
          message: `Refined beat is topic-shaped, not claim-shaped: "${beat.claim}"`
        });
      }
    }
  }

  if (deepened.introduction.trim().length === 0) {
    issues.push({ code: "introduction-missing", message: "Deepened act has no introduction" });
  }
  if (deepened.exit.trim().length === 0) {
    issues.push({ code: "exit-missing", message: "Deepened act has no exit" });
  }

  return { valid: issues.length === 0, issues };
}

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

/** Verbs whose past-tense form is IDENTICAL to their base form (no -ed,
 * no vowel change signal) — "hurt", "cut", "put" etc. These carry
 * absolutely no morphological signal in either tense, so unlike a
 * regular verb or even most irregulars they can never be caught by any
 * suffix rule; they can only be enumerated. Kept as an explicitly
 * separate, small, genuinely closed list (there are only a couple dozen
 * such verbs in English) rather than folded into the general irregular
 * list, since it exists for a different structural reason. */
const INVARIANT_FORM_VERBS = new Set([
  "hurt",
  "cut",
  "put",
  "cost",
  "hit",
  "shut",
  "let",
  "bet",
  "burst",
  "quit",
  "split",
  "shed",
  "spread",
  "upset",
  "forecast",
  "broadcast",
  "read",
  "reset",
  "offset",
  "cast"
]);

/** Subordinating/adjunct words that overwhelmingly introduce a clause
 * built around a predicate ("...hurt workers THROUGHOUT the
 * recession", "...changed BECAUSE the market shifted") rather than
 * appearing inside a bare noun phrase. This is a SUPPLEMENTARY signal,
 * not a verb-detection mechanism by itself: combined with a minimum
 * sentence length, its presence is treated as corroborating evidence
 * that the sentence has clause structure (and therefore very likely a
 * predicate/verb) even when the verb itself resists every morphological
 * rule above — precisely the words the earlier verb-list-based rounds
 * of this heuristic kept missing (see the doc comment on
 * `isClaimShaped` for why false-reject is the costlier failure mode
 * here). */
const CLAUSE_ADJUNCT_WORDS = new Set([
  "throughout",
  "during",
  "because",
  "despite",
  "although",
  "since",
  "while",
  "when",
  "after",
  "before",
  "unless",
  "until",
  "whereas"
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
  if (INVARIANT_FORM_VERBS.has(word)) return true;
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

  // (6) Clause-adjunct corroboration: a subordinating/adjunct word
  // ("throughout", "because", "during", ...) is near-exclusively used to
  // attach a clause to a predicate ("The policy hurt workers THROUGHOUT
  // the recession") rather than inside a bare noun phrase. Every verb
  // signal above depends on some morphological marker or an enumerated
  // list; this catches the residual case where the finite verb itself
  // has NEITHER (an invariant-form verb not yet added to that list, or
  // simply one this heuristic hasn't seen) but the sentence still
  // exhibits real clause structure. Gated on a minimum length so it
  // doesn't fire on a short adjunct-containing noun phrase alone.
  if (rawWords.length >= 5 && words.some((w) => CLAUSE_ADJUNCT_WORDS.has(w))) {
    return true;
  }

  return false;
}

/** How many words of a sentence may be its subject before this stops looking
 * — a subject longer than six words is a sentence with a relative clause in
 * it, and the words past that point are no longer naming the thing. */
export const MAX_LEADING_NOUN_PHRASE_WORDS = 6;

/**
 * THE SUBJECT A CLAIM IS ABOUT, AS FAR AS A HEURISTIC CAN SEE IT (F-69).
 *
 * The sentence's words up to its first finite verb: "An on-call rotation
 * spanning training and inference" out of "An on-call rotation spanning
 * training and inference makes a failure materially harder to diagnose".
 *
 * WHAT IT IS FOR. `gatherEvidence.ts` builds F-60's retry query as a PREFIX of
 * the beat's purpose, cut at the first clause boundary; this is the floor under
 * how short that cut may be. A query that stops inside its own subject
 * ("Conway's law bites") names less than the claim does, and the retry exists
 * precisely because a query that names the wrong thing comes back empty.
 *
 * WHY IT LIVES HERE. It is the same verb-shape question `isClaimShaped` asks,
 * answered with the same `looksLikeInflectedVerb` signals and the same closed
 * verb lists. The alternative is a second copy of those lists in the retrieval
 * module, which is the drift this codebase keeps a single declaration to avoid.
 *
 * DELIBERATELY FALLIBLE, IN THE SAFE DIRECTION. When no verb-shaped word turns
 * up inside the cap — a claim whose verb carries no morphology at all — the
 * whole capped prefix is the answer. As a floor, being a word or two long
 * costs a query nothing; being short costs it its subject.
 */
export function leadingNounPhrase(text: string): string {
  const rawWords = String(text ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (rawWords.length === 0) return "";
  const limit = Math.min(rawWords.length, MAX_LEADING_NOUN_PHRASE_WORDS);
  /* From the SECOND word, for `isClaimShaped`'s own reason: a sentence's first
     word is its subject's head or its determiner, never its finite verb. */
  for (let i = 1; i < limit; i++) {
    const word = rawWords[i]!.toLowerCase().replace(/[^a-z0-9']/g, "");
    if (word && looksLikeInflectedVerb(word)) return rawWords.slice(0, i).join(" ");
  }
  return rawWords.slice(0, limit).join(" ");
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
