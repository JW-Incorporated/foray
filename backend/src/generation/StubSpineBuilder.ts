import * as crypto from "crypto";
import { defaultBudgetGuard, type BudgetGuard } from "../cost/budgetGuard";
import type { IntentUnderstanding } from "../types/generation";
import type { ResearchShape, ResearchTapeWindow } from "../types/research";
import {
  DURATION_SHAPE_BUDGETS,
  SPINE_MIN_SEEDED_BEATS_PER_ACT,
  isClaimShaped,
  type Act,
  type Beat,
  type DurationTier,
  type Slot,
  type Spine,
  type Voice
} from "../types/spine";
import { tokenizeForSourcing } from "./catalogueLookup";
import { SpineSeedLedger } from "./spineSeeding";
import { countSentences, normalizeClaim, MAX_BEAT_CLAIM_WORDS } from "./spineStructure";
import type { SpineBuildContext, SpineBuilder } from "./SpineBuilder";

/**
 * Deterministic fake spine builder, used whenever ANTHROPIC_API_KEY is
 * absent (env.anthropicDryRun) — same role as StubPromptUnderstander /
 * StubExternalResearcher / StubEnricher: zero API keys, zero network
 * calls, reproducible fixtures that still satisfy `validateSpine`
 * (correct act/slot/beat counts for the tier, every beat claim-shaped,
 * the ~30% exploration floor met, one spine-level voice).
 *
 * This is a fixture generator, not a content-quality stand-in — the real
 * provider (a future AnthropicSpineBuilder, gated behind the same
 * ANTHROPIC_API_KEY split as every other collaborator here) is what does
 * the actual planning judgement §4.3 asks for. This stub exists so
 * `buildSpine.ts` and its structural gates (shape budgets, claim-shape,
 * exploration marking, single spine-level voice) can be tested and used
 * without API spend, exactly like every other stage's dry-run path.
 */
export class StubSpineBuilder implements SpineBuilder {
  readonly providerName = "stub";

  constructor(private readonly budgetGuard: BudgetGuard = defaultBudgetGuard) {}

  async buildSpine(
    intent: IntentUnderstanding,
    researchShape: ResearchShape,
    duration: DurationTier,
    ctx: SpineBuildContext
  ): Promise<Spine> {
    await this.budgetGuard.checkAndRecord({
      userId: ctx.userId,
      operation: "spine_build",
      provider: this.providerName,
      estimatedUsd: 0,
      dryRun: true,
      sessionId: ctx.sessionId
    });

    const budget = DURATION_SHAPE_BUDGETS[duration];
    const actCount = midpoint(budget.acts);
    const slotCount = midpoint(budget.slots);
    const itemCount = midpoint(budget.items);

    const subtopicLabels = researchShape.subtopics.length > 0 ? researchShape.subtopics.map((s) => s.label) : [intent.subject];

    /* WS-L (F-63): the transcript windows §4.2 quoted, in map order. When there
       are none — CI, a checkout with no transcript bodies, a subject the archive
       is silent on — every line below behaves exactly as it did before, which is
       what keeps every pre-WS-L dry run and fixture byte-identical. */
    const windows = researchShape.subtopics.flatMap((s) => s.tapeWindows);
    const usedClaims = new Set<string>();
    /* G-25: the stub seeds EVERY beat an admissible window exists for, not
       only the floor's two per act, because the seed is the only path that
       yields tape (tape-yield brief §5 R4) and a fixture that seeded the
       minimum would measure the minimum. The stub has no judgement of kind —
       the real prompt leaves argument beats unseeded; this stub leaves unseeded
       the beats no admissible window remains for, and `StubDeepenActBuilder`
       decides their kind as before.
       ADMISSIBLE means what §4.5's ledger will admit (R3; `spineSeeding.ts`):
       one seed per episode until the spine carries eight, and one episode's
       tape seeded forward. The cursor walks the windows in map order and skips
       what the ledger refuses; `usesByWindow` picks a different sentence each
       time the same window is seeded from. */
    const ledger = new SpineSeedLedger();
    const usesByWindow = new Map<number, number>();
    let seedCursor = 0;

    const slotsPerAct = distributeEvenly(slotCount, actCount);
    const beatsPerSlot = distributeEvenly(itemCount, slotCount);

    // Which global beat indices are exploration beats — evenly spread so a
    // cost-cutting pass truncating from the end can't accidentally strip
    // every exploration beat at once, while still guaranteeing >= floor.
    const requiredExploration = Math.ceil(itemCount * 0.35); // comfortably clears the 30% floor
    const explorationIndices = spreadIndices(itemCount, requiredExploration);

    let slotCursor = 0;
    let beatCursor = 0;
    const acts: Act[] = [];

    for (let a = 0; a < actCount; a++) {
      const seed = hashToInt(`${intent.subject}::act::${a}`);
      const actSlots: Slot[] = [];
      const nSlotsThisAct = slotsPerAct[a]!;
      /* The floor `spineStructure.ts` enforces, met exactly — a fixture
         generator that could not satisfy the gate it is used to test would be
         no fixture at all (the same argument F-13's `CLAIM_QUALIFIERS` were
         added under). The ledger is a preference and the floor is a gate, so
         when the map's windows come from fewer episodes than the ledger wants
         (one, in the smallest fixtures), an act still below its floor takes
         the next window in tape order — what the real prompt says too:
         "a subject whose tape lives in one episode still gets a spine". */
      let seededThisAct = 0;

      for (let s = 0; s < nSlotsThisAct; s++) {
        const nBeatsThisSlot = beatsPerSlot[slotCursor]!;
        slotCursor += 1;
        const beats: Beat[] = [];
        for (let b = 0; b < nBeatsThisSlot; b++) {
          const label = subtopicLabels[beatCursor % subtopicLabels.length]!;
          const exploration = explorationIndices.has(beatCursor);
          const pick =
            windows.length === 0
              ? null
              : nextWindow(windows, seedCursor, (w) => ledger.allows(w.episodeId, w.startSec)) ??
                (seededThisAct < SPINE_MIN_SEEDED_BEATS_PER_ACT
                  ? nextWindow(windows, seedCursor, (w) => ledger.orderAllows(w.episodeId, w.startSec)) ?? nextWindow(windows, seedCursor, () => true)
                  : null);
          if (pick) {
            const { window, index } = pick;
            /* WHICH sentence of the window, so two beats seeded from the same
               window do not write the same claim: the sentence advances each
               time this window is seeded from. */
            const uses = usesByWindow.get(index) ?? 0;
            const claim = claimFromWindow(window, uses, usedClaims);
            beats.push({
              claim,
              exploration,
              seed: { episodeId: window.episodeId, startSec: window.startSec, endSec: window.endSec }
            });
            usedClaims.add(normalizeClaim(claim));
            usesByWindow.set(index, uses + 1);
            ledger.record(window.episodeId, window.startSec);
            seededThisAct += 1;
            seedCursor = index + 1;
          } else {
            const claim = claimFor(intent.subject, label, beatCursor, exploration);
            beats.push({ claim, exploration });
            usedClaims.add(normalizeClaim(claim));
          }
          beatCursor += 1;
        }
        actSlots.push({ title: `${capitalize(intent.subject)} — slot ${slotCursor}`, beats });
      }

      acts.push({
        title: `Act ${a + 1}: ${actTitleFor(intent.subject, a, seed)}`,
        thesis: `Act ${a + 1} establishes ${actTitleFor(intent.subject, a, seed).toLowerCase()} as it relates to ${intent.subject}.`,
        startState: a === 0 ? intent.priorKnowledge : `The listener has just finished act ${a}.`,
        endState: `The listener now understands ${actTitleFor(intent.subject, a, seed).toLowerCase()} and how it changes their view of ${intent.subject}.`,
        slots: actSlots
      });
    }

    return {
      subject: intent.subject,
      angle: intent.angle,
      duration,
      generatedAt: new Date().toISOString(),
      voice: stubVoice(intent),
      acts
    };
  }
}

function midpoint([min, max]: [number, number]): number {
  return Math.round((min + max) / 2);
}

/** Splits `total` into `buckets` near-equal non-negative integer parts,
 * each at least 1 when `total >= buckets`. */
function distributeEvenly(total: number, buckets: number): number[] {
  const base = Math.floor(total / buckets);
  let remainder = total - base * buckets;
  const result: number[] = [];
  for (let i = 0; i < buckets; i++) {
    let n = base;
    if (remainder > 0) {
      n += 1;
      remainder -= 1;
    }
    result.push(Math.max(n, total >= buckets ? 1 : n));
  }
  return result;
}

/** Picks `count` indices out of `[0, total)`, spread as evenly as
 * possible across the range. */
function spreadIndices(total: number, count: number): Set<number> {
  const n = Math.min(count, total);
  const indices = new Set<number>();
  if (n <= 0 || total <= 0) return indices;
  const step = total / n;
  for (let i = 0; i < n; i++) {
    indices.add(Math.min(total - 1, Math.floor(i * step)));
  }
  return indices;
}

function hashToInt(input: string): number {
  const digest = crypto.createHash("sha1").update(input).digest();
  return digest.readUInt32BE(0);
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

const ACT_FRAMES = [
  "the origin",
  "how it actually works",
  "the part nobody expects",
  "the controversy",
  "what changed it",
  "the human cost",
  "where it stands today"
];

function actTitleFor(subject: string, actIndex: number, seed: number): string {
  const frame = ACT_FRAMES[(actIndex + seed) % ACT_FRAMES.length]!;
  return capitalize(frame);
}

/** Claim templates guaranteed to pass `isClaimShaped`'s structural checks
 * (a closed-class auxiliary, an unambiguous irregular past-tense verb, or
 * regular -ed morphology directly following the subject/object it
 * modifies). Deterministic per (subject, label, index) so the stub is
 * reproducible across runs. */
const CLAIM_TEMPLATES = [
  (subject: string, label: string) => `${capitalize(label)} is a documented part of the history of ${subject}.`,
  (subject: string, label: string) => `${capitalize(label)} changed how researchers understood ${subject}.`,
  (subject: string, label: string) => `Early accounts of ${subject} disputed the role that ${label} actually played.`,
  (subject: string, label: string) => `${capitalize(label)} began as a minor detail before it reshaped ${subject}.`,
  (subject: string, label: string) => `${capitalize(subject)} could not have taken its current form without ${label}.`,
  (subject: string, label: string) => `Historians attributed a key turn in ${subject} to ${label}.`,
  (subject: string, label: string) => `${capitalize(label)} was dismissed for years before ${subject} experts took it seriously.`,
  (subject: string, label: string) => `The connection between ${label} and ${subject} surprised even specialists.`
];

/** Extra "curious listener" framing for exploration-marked beats — still
 * claim-shaped, but pointed at an adjacent angle the prompt didn't
 * literally ask for (§4.3's exploration-budget definition). */
const EXPLORATION_TEMPLATES = [
  (subject: string, label: string) => `A tangent from ${label} led researchers to a discovery unrelated to ${subject} at first glance.`,
  (subject: string, label: string) => `${capitalize(label)}, oddly, was what explained a quirk many listeners notice about ${subject}.`,
  (subject: string, label: string) => `Few people asking about ${subject} expect ${label} to matter, but it does.`
];

/**
 * Trailing qualifiers, whose only job is to make every stub beat claim
 * DISTINCT (generation run 2026-09-09, finding F-13).
 *
 * The stub used to pick a template by hashing `(subject, label, index)`, which
 * makes a claim reproducible but not unique: a prompt the catalogue has no
 * concepts for gets ONE subtopic label, and eight templates cannot produce
 * thirty-two different claims from it. Every dry-run spine past nine beats
 * therefore carried the same claim two or three times over — which the new
 * §4.3 structural gate correctly refuses, because two acts deepening the same
 * claim is one of the defects it exists to catch. A fixture generator that
 * produces a spine the pipeline would reject is not a fixture, so the fix
 * belongs here rather than in the gate.
 */
const CLAIM_QUALIFIERS = [
  "according to the contemporary record",
  "in the surviving correspondence",
  "in every account written since",
  "long before anyone wrote it down",
  "in the decade that followed",
  "well outside the usual telling",
  "in the trade press of the period",
  "as the practice spread",
  "once the first accounts circulated",
  "in the years either side of the turn",
  "in the parts of the record that survive",
  "by the time it reached a wider audience",
  "in ways the earliest writers missed",
  "across every region that took it up",
  "in the sources most often cited",
  "in the version most people now recognise",
  "before the terminology settled",
  "in the material historians reach for first",
  "wherever the practice took hold",
  "in the accounts closest to the events",
  "in the documents that outlasted the participants",
  "in the record as it stands today",
  "in the correspondence that was kept",
  "in the earliest reliable telling",
  "in the ledgers that were preserved",
  "in the accounts published at the time",
  "before the first serious survey",
  "in the period the specialists argue over",
  "in the material that reached print",
  "across the sources that agree",
  "in the retellings that followed",
  "wherever the records were kept at all",
  "in the era the standard histories skip",
  "in the fragments that were catalogued",
  "in the notes kept alongside the work",
  "once the first surveys were compiled",
  "in the strand most often left out",
  "in the account that displaced the others",
  "in the years the trade remembers",
  "in the version the archives hold"
];

/**
 * Deterministic per (subject, label, index) as before, and now UNIQUE per
 * index: the template cycles on `index`, the qualifier cycles on
 * `index / templates.length`, so two beats collide only when their indices
 * differ by `templates.length * CLAIM_QUALIFIERS.length`.
 *
 * The qualifier list is sized by the SMALLEST template set, not the largest.
 * There are three exploration templates against eight content ones, and the
 * long tier's global beat index runs to 110 — so the list needs at least
 * ceil(110 / 3) = 37 entries for an exploration beat at index 0 not to collide
 * with one at index 72. It has 40. (Found by the long-tier case in
 * `buildSpine.test.ts` failing on exactly that pair.)
 */
function claimFor(subject: string, label: string, index: number, exploration: boolean): string {
  const templates = exploration ? EXPLORATION_TEMPLATES : CLAIM_TEMPLATES;
  const base = templates[index % templates.length]!(subject, label);
  const qualifier = CLAIM_QUALIFIERS[Math.floor(index / templates.length) % CLAIM_QUALIFIERS.length]!;
  return `${base.replace(/\.\s*$/, "")}, ${qualifier}.`;
}

/* WS-L (F-63): the stub's half of the tape-first spine.
 *
 * A seeded beat's claim is made of the WINDOW'S OWN WORDS, not of a template
 * about them, and that is the property being fixtured: §4.5's relevance floor
 * asks whether the tape says the claim, so a stub whose seeded claims were
 * generated prose would produce a dry run in which the seed path can never
 * succeed — the run-2 failure, reproduced in the fixture generator. The claim is
 * a real sentence out of the window where the tape has punctuation to find one,
 * and a run of its words where it does not (word-level transcripts exist, and a
 * stub that only worked on tidy tape would be a stub that only worked in
 * tests). */

/** The longest claim a window sentence may be — well under
 * `MAX_BEAT_CLAIM_WORDS`, because a beat is a claim and a 60-word one is a
 * paragraph that happens to fit. */
const MAX_SEEDED_CLAIM_WORDS = 40;
/** And the shortest: below this a spoken fragment says nothing a beat could be. */
const MIN_SEEDED_CLAIM_WORDS = 6;
/**
 * How many DISTINCT content words a seeded claim must carry — the same integer
 * as §4.5's `TIER2_WINDOW_MIN_TERMS`, and here for the same reason.
 *
 * Measured, not guessed: without this the stub happily made a beat out of "I, I
 * don't know what your thinking is" — eight words, two of them content words —
 * and §4.5 then refused it at `window-overlap` with a weighted share of 1.0,
 * because a claim with two content words cannot clear a floor that asks for
 * three. Seven of eight seeded beats died that way on the run-2 offline replay.
 * A sentence this thin is not a claim in the first place; the filter belongs
 * where the claim is chosen.
 */
const MIN_SEEDED_CLAIM_CONTENT_WORDS = 6;

/**
 * The `index`-th usable claim in `window`, skipping anything already used
 * elsewhere in this spine (the duplicate-claim gate is structural — see
 * `spineStructure.ts`). Deterministic in every branch.
 */
function claimFromWindow(window: ResearchTapeWindow, index: number, used: Set<string>): string {
  /* RICHEST FIRST, and this is not cosmetic. §4.5's relevance floor asks for
     three claim words the corpus considers RARE for that claim
     (`TIER2_DISTINCTIVE_WEIGHT`), so a bland spoken sentence — every word of it
     said in the window, and not one of them distinctive — is refused at
     `window-overlap` with a weighted share of 1.0. That is the floor working;
     what the stub owes it is the sentence of the window that actually carries
     something. Deterministic: content-word count, then the text itself. */
  const candidates = [...sentenceClaims(window.text), ...runClaims(window.text, MAX_SEEDED_CLAIM_WORDS)].sort(
    (a, b) => contentWordCount(b) - contentWordCount(a) || (a < b ? -1 : a > b ? 1 : 0)
  );
  const usable = candidates.filter((c) => !used.has(normalizeClaim(c)));
  if (usable.length > 0) return usable[index % usable.length]!;
  /* Every sentence of this window is already a beat somewhere — which G-25
     makes the common case, since the stub now seeds every beat it can and a
     600-character window holds three or four sentences. Shorter runs of the
     SAME window's words, at a finer stride, before anything else: the property
     `buildSpine.test.ts` holds this stub to is that a seeded claim's words are
     the window's words, and that has to survive the window being reused. */
  const shorter = runClaims(window.text, SHORT_RUN_CLAIM_WORDS, SHORT_RUN_STRIDE_WORDS).filter((c) => !used.has(normalizeClaim(c)));
  if (shorter.length > 0) return shorter[index % shorter.length]!;
  /* Nothing of the window is left to say. The last resort still carries the
     window's opening words, qualified by the timestamp so it is unique to this
     window and this position — the one claim this stub writes that is not made
     of the tape's words alone, and a fixture rich enough to seed from never
     reaches it. */
  const words = window.text.split(/\s+/).filter(Boolean).slice(0, 20).join(" ").replace(/[.!?]+/g, "");
  return `At ${Math.round(window.startSec)} seconds, the tape says: ${words} (${index + 1}).`;
}

/** The run length and stride the reuse fallback in `claimFromWindow` cuts a
 * window into once its sentences are spent: twelve words is a claim, not a
 * paragraph, and a four-word stride gives a 100-word window twenty-odd
 * distinct runs to choose from. */
const SHORT_RUN_CLAIM_WORDS = 12;
const SHORT_RUN_STRIDE_WORDS = 4;

/** The next window at or after `from` (wrapping) that `admit` accepts, with
 * its index so the caller can resume the walk after it — or null when no
 * window in the list is admissible. */
function nextWindow(
  windows: ResearchTapeWindow[],
  from: number,
  admit: (window: ResearchTapeWindow) => boolean
): { window: ResearchTapeWindow; index: number } | null {
  for (let i = 0; i < windows.length; i++) {
    const index = (from + i) % windows.length;
    const window = windows[index]!;
    if (admit(window)) return { window, index };
  }
  return null;
}

/** Sentences of the window that are already claim-shaped — the good case, and
 * the one that keeps the claim verbatim to the tape. */
function sentenceClaims(text: string): string[] {
  const parts = text.match(/[^.!?]+[.!?]+/g) ?? [];
  const claims: string[] = [];
  for (const part of parts) {
    const sentence = part.trim();
    const words = sentence.split(/\s+/).filter(Boolean).length;
    if (words < MIN_SEEDED_CLAIM_WORDS || words > MAX_SEEDED_CLAIM_WORDS) continue;
    if (contentWordCount(sentence) < MIN_SEEDED_CLAIM_CONTENT_WORDS) continue;
    if (countSentences(sentence) !== 1 || !isClaimShaped(sentence)) continue;
    claims.push(capitalize(sentence));
  }
  return claims;
}

/**
 * Runs of the window's OWN words — `length` of them, every `stride` words —
 * with sentence marks stripped so each is the one sentence
 * `checkSpineStructure` requires, and kept only when the run is claim-shaped on
 * its own. The fallback for tape with no sentence punctuation (word-level
 * transcripts exist), and G-25's reuse fallback at a shorter length.
 *
 * NO FRAMING WORDS. This used to write "The tape says: …", which is claim-shaped
 * by construction but puts three words in the claim the tape never said; a
 * seeded claim is held to being the window's words (`buildSpine.test.ts`), so
 * a run that is not claim-shaped by itself is skipped rather than framed.
 */
function runClaims(text: string, length: number, stride: number = length): string[] {
  const words = text.replace(/[.!?]+/g, "").split(/\s+/).filter(Boolean);
  const claims: string[] = [];
  for (let i = 0; i + MIN_SEEDED_CLAIM_WORDS <= words.length; i += stride) {
    const run = words.slice(i, i + length).join(" ");
    const claim = `${capitalize(run)}.`;
    if (claim.split(/\s+/).length > MAX_BEAT_CLAIM_WORDS) continue;
    if (contentWordCount(run) < MIN_SEEDED_CLAIM_CONTENT_WORDS) continue;
    if (countSentences(claim) !== 1 || !isClaimShaped(claim)) continue;
    claims.push(claim);
  }
  return claims;
}

/** Distinct content words, by §4.5's own tokenizer — so "enough to be a claim"
 * means here exactly what "enough to be about the claim" means there. */
function contentWordCount(text: string): number {
  return new Set(tokenizeForSourcing(text)).size;
}

function stubVoice(intent: IntentUnderstanding): Voice {
  return {
    style: `Plain, curious, well-read-friend register tuned to ${intent.subject} — no jargon left unexplained.`,
    register: "Conversational but precise; treats the listener as smart and short on time.",
    sentenceRhythm: "Short declarative sentences for claims, one longer sentence per beat max for connective tissue.",
    narratorPresence: "Present enough to guide, never editorializing beyond what the sources support."
  };
}
