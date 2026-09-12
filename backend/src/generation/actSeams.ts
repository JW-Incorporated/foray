import type { SourcedAct, SourcedBeat, TapePointer } from "../types/tapeSourcing";
import { MODE_CHAR_BANDS, NARRATION_CHARS_PER_SEC, type NarrationMode } from "../types/narration";
import { canonicalizeForAnchorMatch } from "../types/anchorText";
import type { IntroKind } from "./NarrationWriterBuilder";
import { beatKindOf, type BeatKind } from "./gatherEvidence";

/**
 * Q-02 / Q-03 (docs/curation/listening-quality-plan.md): THE ACT AS SEAMS,
 * and the rules an Intro is held to. Everything in this module is pure —
 * a plan the writer, the verifier, the stitcher's placement and the
 * report's KPIs all read from the same function, so "one page per seam"
 * means the same thing in every one of them.
 *
 * WHAT A SEAM IS. The beats of an act in play order, flattened across its
 * slots (slots are an editorial grouping, not a break in the tape — F-82),
 * fall into runs: the narration beats before the first clip, the narration
 * beats between two clips, the narration beats after the last clip. Each
 * run, together with the clip it leads into, is a SEAM. A clip that
 * follows a clip directly has a seam of its own with no beats in it — the
 * place an Intro goes when one is needed. The seam's prose is ONE page:
 * recorded on the seam's first narration beat (`WrittenBeat.narration`),
 * or as the clip's `connectiveNarration` when the seam has no beats; the
 * other narration beats of the seam carry `carriedBy` pointing at it. So
 * `stitchAct` emits one narration item per seam with no change to the
 * item model, and a Foray's page count falls from one per beat to roughly
 * one per seam — Wyatt's first complaint, measured
 * (`veracityMetrics.ts`'s `narrationPagesPerSeam`).
 *
 * WHAT AN INTRO IS (Q-02, "don't go overkill"). One or two sentences before
 * a clip: who is speaking, on which show, what to listen for — written
 * from the clip's OPENING (`clipOpening`), never from its point. Three
 * weights, decided in code from the tape (`decideIntro`):
 *
 *   full  — a different episode from the previous clip, and no host
 *           introduction in the clip's own first minute: the seam must
 *           name the show or someone the episode title names
 *           (`introNamesSource`);
 *   light — the same episode as the previous clip: a clause, or nothing;
 *   none  — the host's own introduction is in the clip's opening
 *           (`hostIntroducesGuest`): nothing is required.
 *
 * And one rule for every seam that plays into a clip, whatever the weight:
 * it must not repeat the clip's first sentences (`introRestatesClip`) —
 * F-81/F-82's restate-the-tape rule no longer applies to the page before
 * a clip. The report counts violations as `introRestates`, which must be 0.
 */

export interface BeatPosition {
  slot: number;
  beat: number;
}

/** A narration beat positioned in a seam. */
export interface SeamBeat extends BeatPosition {
  beatId: string;
  claim: string;
  mode: "Patch" | "Carry";
  kind: BeatKind;
  exploration: boolean;
}

/** A clip (tape beat) at one edge of a seam. */
export interface SeamClip extends BeatPosition {
  clipId: string;
  claim: string;
  tape: TapePointer;
}

export interface SeamPlan {
  seamId: string;
  beats: SeamBeat[];
  /** The clip that plays just before the seam. */
  follows?: SeamClip;
  /** The clip the seam introduces — plays just after it. */
  introduces?: SeamClip;
}

/** The act's beats flattened in play order, each with its position. */
export function actBeatsInOrder(act: SourcedAct): Array<BeatPosition & { sourced: SourcedBeat }> {
  const out: Array<BeatPosition & { sourced: SourcedBeat }> = [];
  act.slots.forEach((slot, slotIndex) => {
    slot.beats.forEach((sourced, beatIndex) => out.push({ slot: slotIndex, beat: beatIndex, sourced }));
  });
  return out;
}

/** `b<n>` over the act's flattened beats — the id the writer and verifier
 * name a beat by, and the id a verifier note quotes back. */
export function beatIdAt(flatIndex: number): string {
  return `b${flatIndex}`;
}

/**
 * The seams of an act, in play order. Every narration beat is in exactly
 * one seam; every clip closes exactly one seam (its `introduces`) and
 * opens the next (its `follows`). A trailing run of narration beats after
 * the last clip is a seam with no clip after it. An act that is nothing
 * but consecutive clips has one beatless seam per clip.
 */
export function planActSeams(act: SourcedAct): SeamPlan[] {
  const seams: SeamPlan[] = [];
  let open: SeamPlan = { seamId: "s0", beats: [] };
  let clipCount = 0;
  actBeatsInOrder(act).forEach(({ slot, beat, sourced }, flatIndex) => {
    if (sourced.sourcing === "narration") {
      open.beats.push({
        slot,
        beat,
        beatId: beatIdAt(flatIndex),
        claim: sourced.claim,
        mode: sourced.narration.mode,
        kind: beatKindOf(sourced as unknown as { kind?: unknown }),
        exploration: sourced.exploration
      });
      return;
    }
    const clip: SeamClip = { slot, beat, clipId: `c${clipCount++}`, claim: sourced.claim, tape: sourced.tape };
    open.introduces = clip;
    seams.push(open);
    open = { seamId: `s${seams.length}`, beats: [], follows: clip };
  });
  if (open.beats.length > 0) seams.push(open);
  return seams;
}

/** The mode a seam is PLANNED under — what its beats ask of it: the
 * provisional mode the mechanical gate runs with before the verifier has
 * answered. Since F-97 this is not the mode the page is recorded under;
 * `assignSeamMode` decides that after writing, from what the seam did. */
export function seamMode(seam: Pick<SeamPlan, "beats">): NarrationMode {
  if (seam.beats.some((b) => b.mode === "Carry")) return "Carry";
  if (seam.beats.length > 0) return "Patch";
  return "Intro";
}

/** What a seam turned out to rest on, as the verifier answered it. */
export interface SeamRest {
  /** True when any source the seam rests on is print (a span of a
   * document, or a verified page of this Foray). */
  print: boolean;
  /** True when any source the seam rests on is a clip's window. */
  tape: boolean;
}

/**
 * F-97: THE MODE IS ASSIGNED AFTER WRITING, from what the seam does, not
 * before as a contract the writer must hit. Run 9 planned every seam with
 * beats as a Patch and then refused it in code for not selecting a claim
 * — but a seam that carries its beats by bridging two clips, resting on
 * their windows, is a Frame doing a Frame's job, and the per-page rules
 * for a Patch were never about it. The data model keeps its modes; this
 * is how a seam page gets one:
 *
 *   Intro  — no beat positioned in the seam: the introduction only;
 *   Carry  — a Carry beat is positioned in it and it rests on print;
 *   Patch  — it rests on print (a document span or a verified page);
 *   Frame  — it rests on tape only and plays into a clip;
 *   Hinge  — it rests on tape only after the last clip, or on nothing (a
 *            question, a hand-off).
 *
 * Every mode here is one `check-forays.mjs` admits, and a Frame/Hinge
 * resting on a tape source is what `TAPE_SOURCE_MODES` already allows —
 * so the assigned page is valid under the per-page rules, not only the
 * act's.
 */
export function assignSeamMode(seam: Pick<SeamPlan, "beats" | "introduces">, rest: SeamRest): NarrationMode {
  if (seam.beats.length === 0) return "Intro";
  if (rest.print) return seam.beats.some((b) => b.mode === "Carry") ? "Carry" : "Patch";
  if (rest.tape) return seam.introduces ? "Frame" : "Hinge";
  return "Hinge";
}

/**
 * The longest a seam page may be, in characters: `check-narration.mjs`'s
 * `NARRATION_SOFT_MAX_SEC` (150 s — narration-craft §0's Carry soft max,
 * past which an item needs `needs_review`) at the planning rate. A seam
 * carrying several beats sums their bands, and without this cap two Carry
 * beats would license a page the checker then flags. Mirrored here rather
 * than imported for the reason `MODE_CHAR_BANDS` gives.
 */
export const SEAM_MAX_CHARS = 150 * NARRATION_CHARS_PER_SEC;

/**
 * The character band a seam's script is held to (`validateNarratedBeat`'s
 * `charBand`). The floor is the largest floor among the beats it carries
 * — a seam carrying a Carry must be at least a Carry's worth — or the
 * Intro floor for an intro-only seam; the ceiling is the sum of the beats'
 * ceilings plus an Intro's when the seam introduces a clip, capped at
 * `SEAM_MAX_CHARS`. Beats are the checklist, not the template: three
 * Patch beats need not take three Patches' worth of words, only at least
 * one's.
 */
export function seamBand(seam: Pick<SeamPlan, "beats" | "introduces">): [number, number] {
  const [introMin, introMax] = MODE_CHAR_BANDS.Intro;
  if (seam.beats.length === 0) return [introMin, introMax];
  let floor = 0;
  let ceiling = 0;
  for (const beat of seam.beats) {
    const [min, max] = MODE_CHAR_BANDS[beat.mode];
    floor = Math.max(floor, min);
    ceiling += max;
  }
  if (seam.introduces) ceiling += introMax;
  return [floor, Math.min(ceiling, SEAM_MAX_CHARS)];
}

/* ------------------------------------------------------------------ *
 * Q-02: the Intro rules.
 * ------------------------------------------------------------------ */

/** How much of a clip an Intro is written from: about its first minute of
 * speech at conversational pace (~2.5 words/s). */
export const CLIP_OPENING_WORDS = 150;

/**
 * The clip's opening — `words` tokens of the transcript window from the
 * clip's start anchor on, in the window's own text. The window
 * (`gatherEvidence.ts`'s `cueWindowText`) holds ninety seconds BEFORE the
 * clip as run-up, so the anchor is what locates where the clip itself
 * starts. Empty when the anchor is not found in the window (no cue body,
 * or a window cut before the anchor): an Intro cannot be written from an
 * opening the pipeline does not hold, and neither rule below fires on an
 * empty opening.
 */
export function clipOpening(windowText: string, startAnchor: string, words: number = CLIP_OPENING_WORDS): string {
  const tokens = String(windowText ?? "").split(/\s+/).filter(Boolean);
  const needle = canonicalizeForAnchorMatch(startAnchor).split(" ").filter(Boolean);
  if (tokens.length === 0 || needle.length === 0) return "";
  /* Each canonical word remembers the original token it came from, so the
     match index maps back to the window's own text. */
  const canon: Array<{ word: string; token: number }> = [];
  tokens.forEach((token, index) => {
    for (const word of canonicalizeForAnchorMatch(token).split(" ")) if (word) canon.push({ word, token: index });
  });
  for (let i = 0; i + needle.length <= canon.length; i++) {
    let hit = true;
    for (let j = 0; j < needle.length; j++) {
      if (canon[i + j]!.word !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return tokens.slice(canon[i]!.token, canon[i]!.token + words).join(" ");
  }
  return "";
}

/**
 * The phrases a host uses to introduce a guest or a topic, on the
 * canonical form of the opening (lower-case, apostrophes elided,
 * punctuation to spaces — `canonicalizeForAnchorMatch`, so "I'm here with"
 * is `im here with`). Explicit rather than inferred: a match means the
 * tape already does the Intro's job and the narrator says nothing; a miss
 * costs one or two narrated sentences. Exported so a test can name the
 * mutation that deletes an entry.
 */
export const HOST_INTRO_PATTERNS: readonly RegExp[] = [
  /\bmy guests? (today|this week|this episode|is|are)\b/,
  /\bour guests? (today|this week|this episode|is|are)\b/,
  /\b(joining|joined by|joins) (me|us)\b/,
  /\b(were|we are|im|i am) (here|joined|talking|speaking|sitting down) (with|today with|to)\b/,
  /\bwelcome (back )?to (the )?(show|podcast|program|programme)\b/,
  /\bwelcome to [a-z]/,
  /\bplease welcome\b/,
  /\bthanks? (so much |very much )?for (having me|coming on|joining (me|us)|being here|being on)\b/,
  /\byoure listening to\b/,
  /\btoday (were|we are|im|i am) (talking|speaking|joined|sitting down)\b/,
  /\bwith me (today|now|this week) is\b/,
  /\b(let me|id like to|i want to) introduce\b/,
  /\bthis is the [a-z ]{0,40}(podcast|show)\b/
];

/** True when the clip's own opening carries the host's introduction of
 * the guest or the topic — the case where there is no Intro at all. */
export function hostIntroducesGuest(opening: string): boolean {
  const canon = canonicalizeForAnchorMatch(opening);
  if (!canon) return false;
  return HOST_INTRO_PATTERNS.some((rx) => rx.test(canon));
}

/**
 * How much introducing this clip needs, from the tape and the clip before
 * it. The host's own introduction wins (nothing to add); the same episode
 * as the previous clip is a follow-on (a clause at most); everything else
 * is a full Intro.
 */
export function decideIntro(clip: { itemId: string }, previous: { itemId: string } | undefined, opening: string): IntroKind {
  if (hostIntroducesGuest(opening)) return "none";
  if (previous && previous.itemId === clip.itemId) return "light";
  return "full";
}

/* Title-case makes every word of an episode title a candidate name; these
   are the ones that never name anyone. Short and explicit. */
const TITLE_STOPWORDS = new Set([
  "episode", "part", "with", "from", "that", "this", "what", "when", "where", "which", "while", "about", "into",
  "does", "make", "makes", "made", "your", "their", "there", "them", "then", "than", "have", "been", "being",
  "were", "will", "would", "could", "should", "really", "actually", "still", "just", "over", "under", "after",
  "before", "again", "every", "some", "more", "most", "very", "much", "many", "also", "only", "even", "ever",
  "podcast", "show", "interview", "conversation", "talk", "talks", "series", "season", "rerelease", "re", "release"
]);

/**
 * Q-02's structural verification of a full Intro: the script names the
 * show (the source row's `show`, as a whole phrase) or someone the episode
 * title names (a capitalised title token of four letters or more, outside
 * the stopword list — "Couitt" in "Ep. 12: Joe Couitt on mopping floors").
 * No model reads this; it is a substring check against what the segment
 * source row actually carries.
 */
export function introNamesSource(script: string, clip: { show: string; title: string }): boolean {
  const canonScript = ` ${canonicalizeForAnchorMatch(script)} `;
  if (canonScript.trim().length === 0) return false;
  const show = canonicalizeForAnchorMatch(clip.show);
  if (show.length >= 3 && canonScript.includes(` ${show} `)) return true;
  for (const token of String(clip.title ?? "").split(/\s+/)) {
    const bare = token.replace(/^[^A-Za-z]+/, "").replace(/[^A-Za-z]+$/, "");
    if (!/^[A-Z][A-Za-z'’-]{3,}$/.test(bare)) continue;
    const canon = canonicalizeForAnchorMatch(bare);
    if (!canon || TITLE_STOPWORDS.has(canon)) continue;
    if (canonScript.includes(` ${canon} `)) return true;
  }
  return false;
}

/** A run of this many consecutive words shared with the clip's first
 * sentences is the Intro saying what the clip is about to say. Six, the
 * same run `quoteEchoesPurpose` uses for a quote of the purpose (F-46). */
export const INTRO_RESTATE_RUN_WORDS = 6;
/** How far into the clip "its first sentences" reach, in words. */
export const CLIP_FIRST_SENTENCES_WORDS = 60;

/**
 * Q-02's similarity check: does the prose before a clip repeat the clip's
 * first sentences? True when any `INTRO_RESTATE_RUN_WORDS`-word run of the
 * script is spoken, in order, in the first `CLIP_FIRST_SENTENCES_WORDS`
 * words of the clip's opening. Returns the run so the rejection note can
 * quote it. An empty opening restates nothing.
 */
export function introRestatesClip(script: string, opening: string): { restates: boolean; run?: string } {
  const head = canonicalizeForAnchorMatch(opening).split(" ").filter(Boolean).slice(0, CLIP_FIRST_SENTENCES_WORDS);
  const words = canonicalizeForAnchorMatch(script).split(" ").filter(Boolean);
  if (head.length < INTRO_RESTATE_RUN_WORDS || words.length < INTRO_RESTATE_RUN_WORDS) return { restates: false };
  const haystack = ` ${head.join(" ")} `;
  for (let i = 0; i + INTRO_RESTATE_RUN_WORDS <= words.length; i++) {
    const run = words.slice(i, i + INTRO_RESTATE_RUN_WORDS).join(" ");
    if (haystack.includes(` ${run} `)) return { restates: true, run };
  }
  return { restates: false };
}

/** The clip's duration from its pointer. */
export function clipDurationSec(tape: Pick<TapePointer, "startSec" | "endSec">): number {
  return Math.max(0, tape.endSec - tape.startSec);
}
