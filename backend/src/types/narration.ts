import { z } from "zod";

/**
 * §4.7 narration types (docs/curation/generation-architecture.md §4.7).
 * Takes §4.5-4.6's `SourcedBeat[]` (backend/src/types/tapeSourcing.ts) —
 * every beat already carrying either a tape pointer or a Patch/Carry
 * narration assignment — and, for every narration-sourced beat, produces
 * ONE PAGE: a script in the spine's voice, in one of the six modes
 * (`docs/curation/narration-craft.md` §0/§2.1), inside that mode's
 * second/character budget.
 *
 * PER §4.5'S OWN NOTE (see this stage's task brief), a tape-sourced beat
 * may still need short connective narration around it — Hinge, Frame,
 * Marker or Correction. §4.5-4.6's output shape (`SourcedBeat`) does not
 * flag this: it only ever assigns Patch/Carry, and only to a beat with NO
 * tape. This module therefore treats connective narration as a §4.7
 * DECISION, not an input it reads off `SourcedBeat` — see
 * `decideConnectiveNarration` in `writeNarration.ts`.
 *
 * MANDATORY QUALITY BAR — FACTUAL ACCURACY (the doc's own words: "the
 * product risk that kills this feature"):
 *   1. Every factual claim in a page carries a source, recorded
 *      alongside the script even though never spoken — `sources: Source[]`
 *      below, one entry per claim, structurally required (not a comment).
 *   2. A verification pass reads the page against its sources — a
 *      DIFFERENT agent than the writer (see `NarrationVerifierBuilder`,
 *      never the same class as `NarrationWriterBuilder`).
 *   3. A contested claim says so explicitly in the narration text AND
 *      structurally, via `Source.contested`.
 *
 * PRONUNCIATION: §9.1's on-device narration work owns the actual control
 * mechanism; this stage only has to carry the hint per hard/foreign word
 * so nothing has to be retrofitted later — `pronunciationHints` below.
 */

/** The six narration modes, §2.1 / narration-craft.md §0. Capitalized to
 * match `tapeSourcing.ts`'s existing `NarrationAssignmentSchema` enum
 * ("Patch" | "Carry") rather than introducing a second casing for the
 * same four extra modes this stage adds (Hinge/Frame/Marker/Correction). */
export const NarrationModeSchema = z.enum(["Hinge", "Frame", "Marker", "Correction", "Patch", "Carry"]);
export type NarrationMode = z.infer<typeof NarrationModeSchema>;

/** narration-craft.md §0's table, in CHARACTERS — the primitive
 * `tools/foray/check-narration.mjs`'s `MODE_CHAR_BANDS` also uses, and
 * mirrored here rather than imported: that file is ESM-only
 * (`tools/`, no build step) and this backend compiles to CommonJS
 * (backend/tsconfig.build.json), so a runtime `require()` of an .mjs
 * module is not viable from a `tsc`-built CommonJS entry point.
 * `backend/test/narration.test.ts` cross-checks these numbers against
 * `check-narration.mjs`'s exported `MODE_CHAR_BANDS` at test time (a
 * live `import()` of the ESM module works fine under vitest), so the two
 * tables cannot silently drift apart — same discipline `copyRules.js`
 * documents for its own single-source-of-truth problem, applied via a
 * cross-file equality test instead of a shared runtime import. */
export const MODE_CHAR_BANDS: Record<NarrationMode, [number, number]> = {
  Hinge: [50, 135],
  Frame: [70, 170],
  Marker: [135, 340],
  Correction: [100, 205],
  Patch: [340, 765],
  Carry: [765, 1870]
};

/** narration-craft.md §2a: the planning rate the whole cost model rests
 * on. Matches `check-narration.mjs`'s `NARRATION_CHARS_PER_SEC` exactly
 * (same cross-check test enforces it). */
export const NARRATION_CHARS_PER_SEC = 17;

export function scriptSeconds(chars: number): number {
  return Math.round((chars / NARRATION_CHARS_PER_SEC) * 1000) / 1000;
}

/** One factual claim's evidence, recorded alongside the script even
 * though `quote` is never spoken (§4.7's rule 1, and Ruling 3 —
 * `check-narration.mjs`'s `REFERENCE_LEAK_RE` — bans a citation from
 * ever reaching a spoken line). `claimText` ties this source to the
 * specific sentence/assertion it backs, so "every factual claim carries
 * a source" is checkable per-claim rather than only "the page has some
 * sources somewhere". */
export const SourceSchema = z
  .object({
    /** The factual assertion this source supports, in the author's own
     * words — not necessarily verbatim from the script (a script may
     * fold several claims into one sentence), but specific enough that a
     * verifier can find and check it against the script. */
    claimText: z.string().trim().min(1),
    /** Verbatim span from the source. Never spoken — see the module doc
     * comment and Ruling 3. */
    quote: z.string().trim().min(1),
    publication: z.string().trim().min(1),
    url: z.string().trim().min(1).optional(),
    /** ISO date the span was retrieved, when known. */
    retrieved: z.string().trim().min(1).optional(),
    /** §4.7 rule 3: a genuinely contested claim must say so, both here
     * (structural — a verifier or downstream consumer can filter on it
     * without re-parsing prose) and in the narration text itself
     * (checked by `containsContestedLanguage` below, applied by the
     * caller — this schema cannot itself read the script it belongs to). */
    contested: z.boolean()
  })
  .strict();
export type Source = z.infer<typeof SourceSchema>;

/** §4.7's pronunciation-control hint, per hard/foreign word. Nothing
 * consumes this yet (§9.1 owns the actual TTS-facing mechanism) — the
 * field exists so the data shape does not need retrofitting later. */
export const PronunciationHintSchema = z
  .object({
    word: z.string().trim().min(1),
    /** Plain-English or phonetic guide — deliberately untyped beyond
     * "non-empty string", since §9.1 has not chosen a notation yet. */
    hint: z.string().trim().min(1)
  })
  .strict();
export type PronunciationHint = z.infer<typeof PronunciationHintSchema>;

/**
 * One written-and-verified narration page — the §4.7 output for a single
 * narration beat. Matches this stage's task brief's output shape
 * exactly: `{ mode, script, sources, pronunciationHints, verified,
 * verifierNotes? }`.
 */
export const NarratedBeatSchema = z
  .object({
    mode: NarrationModeSchema,
    script: z.string().trim().min(1),
    /** Per-claim sources, §4.7 rule 1. May be empty ONLY for a page that
     * asserts no factual claim at all (a pure Hinge/Frame handoff with no
     * new information) — `writeNarration.ts`'s orchestrator treats an
     * empty array on a Patch/Carry page (which by definition carries
     * content) as a hard validation failure; see `validateNarratedBeat`. */
    sources: z.array(SourceSchema),
    pronunciationHints: z.array(PronunciationHintSchema),
    /** Set only by the verification pass (§4.7 rule 2) — never
     * self-reported by the writer. `writeNarration.ts`'s orchestrator is
     * the only code path allowed to flip this to `true`. */
    verified: z.boolean(),
    verifierNotes: z.string().trim().min(1).optional()
  })
  .strict();
export type NarratedBeat = z.infer<typeof NarratedBeatSchema>;

export interface NarratedBeatValidationIssue {
  code:
    | "script-empty"
    | "out-of-budget"
    | "missing-sources"
    | "contested-not-flagged-in-text"
    | "banned-copy"
    | "not-verified";
  message: string;
}
export interface NarratedBeatValidationResult {
  valid: boolean;
  issues: NarratedBeatValidationIssue[];
}

/** narration-craft.md §5e-derived (mirrors `check-narration.mjs`'s
 * `BANNED_HEDGES`/language for "contested" framing): phrases a script
 * uses to flag a claim it is not standing fully behind. Kept narrow and
 * explicit rather than inferred, since §4.7 rule 3 requires the text say
 * so "explicitly". */
const CONTESTED_PHRASES = [
  "contested",
  "disputed",
  "some historians disagree",
  "not everyone agrees",
  "accounts differ",
  "the evidence is mixed",
  "no consensus"
];

export function containsContestedLanguage(script: string): boolean {
  const low = script.toLowerCase();
  return CONTESTED_PHRASES.some((p) => low.includes(p));
}

/**
 * Structural + copy-rule validation for one written-and-verified page.
 * Pure: takes the beat and an (optional) copy-rule checker so callers can
 * inject `backend/src/copy/rules.js`'s `BANNED` list without this module
 * importing a CommonJS `.js` file with hand-authored types into a
 * `.strict()`-typed module — kept as a parameter for testability too.
 */
export function validateNarratedBeat(
  beat: NarratedBeat,
  opts: { bannedPhrasePatterns?: RegExp[] } = {}
): NarratedBeatValidationResult {
  const issues: NarratedBeatValidationIssue[] = [];

  if (beat.script.trim().length === 0) {
    issues.push({ code: "script-empty", message: "script is empty" });
  }

  const band = MODE_CHAR_BANDS[beat.mode];
  const chars = beat.script.length;
  if (chars < band[0] || chars > band[1]) {
    issues.push({
      code: "out-of-budget",
      message: `${chars} chars is outside the ${beat.mode} band ${band[0]}-${band[1]} (narration-craft.md §0)`
    });
  }

  // A Patch/Carry page IS a beat's content (or supplies the part its tape
  // misses) — either way it is asserting something, so it must carry at
  // least one source. Hinge/Frame/Marker/Correction connective narration
  // may legitimately carry none (a pure handoff introduces no new claim).
  if ((beat.mode === "Patch" || beat.mode === "Carry") && beat.sources.length === 0) {
    issues.push({
      code: "missing-sources",
      message: `${beat.mode} narration carries a factual claim by definition and must have at least one source (§4.7 rule 1)`
    });
  }

  const anyContestedSource = beat.sources.some((s) => s.contested);
  if (anyContestedSource && !containsContestedLanguage(beat.script)) {
    issues.push({
      code: "contested-not-flagged-in-text",
      message: "a source is marked contested but the script does not say so explicitly (§4.7 rule 3)"
    });
  }

  const bannedPatterns = opts.bannedPhrasePatterns ?? [];
  for (const rx of bannedPatterns) {
    if (rx.test(beat.script)) {
      issues.push({ code: "banned-copy", message: `script matches banned copy pattern ${rx}` });
    }
  }

  if (!beat.verified) {
    issues.push({ code: "not-verified", message: "beat has not been through the §4.7 verification pass" });
  }

  return { valid: issues.length === 0, issues };
}

/**
 * §4.7's mandatory disclosure — the first item of every generated Foray,
 * spoken before anything else, using the doc's EXACT template with only
 * `<subject>` filled in. Written once, here, as the single producer of
 * this string so nothing downstream can paraphrase it — the disclosure's
 * value is legal cover, and `tools/foray/check-forays.mjs`'s
 * `DISCLOSURE_RX` (PR #391) matches this exact wording verbatim (checked
 * by `backend/test/disclosureTemplate.test.ts`'s round-trip against that
 * validator, not merely asserted in prose here).
 */
export function disclosureTemplate(subject: string): string {
  const trimmedSubject = subject.trim();
  if (!trimmedSubject) throw new Error("disclosureTemplate: subject must not be empty");
  return (
    `This is a Foray about ${trimmedSubject}. Much of what you'll hear is written by AI. ` +
    "We work hard to get the facts right, but AI gets things wrong — so take it as a starting point, not a source."
  );
}

/** The disclosure as a full narration beat, ready to prepend as
 * `items[0]` — `check-forays.mjs` requires `items[0].type === "narration"`
 * with a `script` matching `DISCLOSURE_RX`, mode is not checked on the
 * disclosure item specifically but is set to "Marker" here (it announces
 * structure — the Foray's own opening — matching narration-craft.md §2c's
 * definition) so it still satisfies the six-mode enum check on any
 * generated Foray. */
export function disclosureNarratedBeat(subject: string): NarratedBeat {
  return {
    mode: "Marker",
    script: disclosureTemplate(subject),
    sources: [],
    pronunciationHints: [],
    verified: true
  };
}
