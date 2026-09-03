import { BANNED } from "../copy/rules";
import type { SourcedAct, SourcedBeat, SourcedSlot, TapePointer } from "../types/tapeSourcing";
import {
  containsContestedLanguage,
  disclosureNarratedBeat,
  MODE_CHAR_BANDS,
  validateNarratedBeat,
  type NarratedBeat,
  type NarrationMode
} from "../types/narration";
import type { Voice } from "../types/spine";
import type { NarrationBuildContext, NarrationWriterBuilder } from "./NarrationWriterBuilder";
import type { NarrationVerifierBuilder } from "./NarrationVerifierBuilder";

/**
 * §4.7 end to end (docs/curation/generation-architecture.md §4.7): takes
 * §4.5-4.6's `SourcedAct[]` (backend/src/generation/sourceBeats.ts) and,
 * for every narration beat plus any tape beat that needs short
 * connective narration around it, writes ONE page — always via a
 * `NarrationWriterBuilder` call, then a SEPARATE `NarrationVerifierBuilder`
 * call reading that page against its own declared sources.
 *
 * §4.5's OWN NOTE, RESOLVED HERE: the task brief flags that tape-adjacent
 * beats "may still need short connective narration... check the
 * sourced-beats output shape to see whether mode assignment... is
 * already flagged there or needs deciding here." It is not — `SourcedBeat`
 * (tapeSourcing.ts) only ever carries `sourcing: "tape"` with a pointer,
 * or `sourcing: "narration"` with a Patch/Carry assignment; there is no
 * field for "this tape beat also needs a Hinge/Frame/Marker/Correction
 * around it". `decideConnectiveNarration` below is where that decision is
 * made, deterministically, from beat POSITION within its slot — see its
 * own doc comment for the exact rule and citation to narration-craft.md
 * §3b's seam table.
 *
 * TWO DISTINCT AGENT ROLES, NEVER COLLAPSED: `writer` and `verifier` are
 * required to be different builder instances — enforced structurally by
 * `writePageAndVerify` throwing if a caller passes the SAME object
 * reference for both (a real bug this stage's task brief explicitly
 * warns against: "do not collapse them into one call that also checks
 * itself").
 *
 * FAILURE POLICY, mirroring `deepenActs.ts`'s established pattern: a
 * page is retried ONCE (rewrite, then re-verify) on either a structural
 * validation failure (out-of-budget, banned copy, missing sources,
 * contested-not-flagged) or a failed verification pass. If the retry
 * also fails, the whole `writeNarration` call fails loudly — a page that
 * cannot be written to pass its own quality bar is not optional content,
 * same reasoning `deepenActs.ts` applies to a whole act.
 */

export class NarrationWriteError extends Error {
  constructor(
    public readonly claim: string,
    public readonly mode: NarrationMode,
    public readonly cause: unknown
  ) {
    super(`Writing narration for "${claim}" (mode ${mode}) failed after 1 retry: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = "NarrationWriteError";
  }
}

export class InvalidNarratedBeatError extends Error {
  constructor(
    public readonly claim: string,
    public readonly mode: NarrationMode,
    public readonly issues: string[]
  ) {
    super(`Narration for "${claim}" (mode ${mode}) failed validation: ${issues.join("; ")}`);
    this.name = "InvalidNarratedBeatError";
  }
}

/** One beat's §4.7 result, preserving its position in the sourced spine
 * (act/slot index unnecessary here — the caller already has the nested
 * `SourcedAct[]` structure; see `writeNarrationForAct` which returns
 * results nested the same way). A tape beat carries `connectiveNarration`
 * only when `decideConnectiveNarration` decided one was needed; a
 * narration beat always carries `narration`. */
export type WrittenBeat =
  | { sourcing: "tape"; claim: string; exploration: boolean; tape: TapePointer; connectiveNarration?: NarratedBeat }
  | { sourcing: "narration"; claim: string; exploration: boolean; narration: NarratedBeat };

export interface WrittenSlot {
  title: string;
  beats: WrittenBeat[];
}
export interface WrittenAct {
  title: string;
  slots: WrittenSlot[];
}

export interface WriteNarrationOptions {
  writer: NarrationWriterBuilder;
  verifier: NarrationVerifierBuilder;
}

/**
 * narration-craft.md §3b's seam table, reduced to a POSITIONAL rule this
 * stage can apply without stitching context (§4.8 owns the real seam
 * work — silence-vs-bridge, jingles, cross-act continuity). This is
 * deliberately conservative: it only ever proposes a mode for a tape
 * beat that OPENS its slot (S1/S2, "Frame — the common case") or that
 * immediately follows a DIFFERENT-source tape beat within the same slot
 * (S1's cross-episode case, also Frame — a Hinge is for same-episode
 * continuations, which this stage cannot detect from a claim + pointer
 * alone since two segments from the same show are not necessarily the
 * same episode's own continuous recording). A tape beat following
 * another tape beat from the SAME item (episode) gets no connective
 * narration — narration-craft.md §3b S3, "must be marked... where the
 * elision exceeds 5 min", a duration judgement out of this stage's scope
 * (left as a `null` result, i.e. §4.8's silence-is-a-valid-bridge rule
 * applies by default).
 */
export function decideConnectiveNarration(slot: SourcedSlot, beatIndex: number): NarrationMode | null {
  const beat = slot.beats[beatIndex];
  if (!beat || beat.sourcing !== "tape") return null;

  const previous = beatIndex > 0 ? slot.beats[beatIndex - 1] : undefined;

  if (!previous) {
    // Opens the slot: narration-craft.md §3b S1/S2 — a Frame introduces
    // tape that carries the beat and is the common case for entering it.
    return "Frame";
  }

  if (previous.sourcing === "narration") {
    // S4 in narration-craft.md's table (tape -> narration is the OTHER
    // direction; a narration item exiting into tape needs its own
    // Frame-shaped handoff on the tape side, matching S5's "strongest
    // place to use Set-up -> explanation").
    return "Frame";
  }

  // previous.sourcing === "tape"
  if (previous.tape.itemId !== beat.tape.itemId) {
    // Cross-episode tape-to-tape: S1, Frame, attribution mandatory.
    return "Frame";
  }

  // Same-episode continuation: leave to §4.8 (silence or a later
  // duration-aware Hinge decision it is better positioned to make).
  return null;
}

export async function writeNarration(acts: SourcedAct[], options: WriteNarrationOptions, voice: Voice, ctx: NarrationBuildContext): Promise<WrittenAct[]> {
  const { writer, verifier } = options;
  if (writer === (verifier as unknown as NarrationWriterBuilder)) {
    throw new Error("writeNarration: writer and verifier must be distinct builder instances (§4.7 rule 2 — verification must never be the writer)");
  }

  const writtenActs: WrittenAct[] = [];
  for (const act of acts) {
    const slots: WrittenSlot[] = [];
    for (const slot of act.slots) {
      const beats: WrittenBeat[] = [];
      for (let i = 0; i < slot.beats.length; i++) {
        const beat = slot.beats[i]!;
        beats.push(await writeOneBeat(beat, slot, i, writer, verifier, voice, ctx));
      }
      slots.push({ title: slot.title, beats });
    }
    writtenActs.push({ title: act.title, slots });
  }
  return writtenActs;
}

async function writeOneBeat(
  beat: SourcedBeat,
  slot: SourcedSlot,
  index: number,
  writer: NarrationWriterBuilder,
  verifier: NarrationVerifierBuilder,
  voice: Voice,
  ctx: NarrationBuildContext
): Promise<WrittenBeat> {
  if (beat.sourcing === "narration") {
    const narrated = await writePageAndVerify(beat.claim, beat.narration.mode, voice, writer, verifier, ctx);
    return { sourcing: "narration", claim: beat.claim, exploration: beat.exploration, narration: narrated };
  }

  const connectiveMode = decideConnectiveNarration(slot, index);
  if (!connectiveMode) {
    return { sourcing: "tape", claim: beat.claim, exploration: beat.exploration, tape: beat.tape };
  }
  const connective = await writePageAndVerify(
    beat.claim,
    connectiveMode,
    voice,
    writer,
    verifier,
    ctx,
    `This is connective narration around real tape (source item ${beat.tape.itemId}); it hands the listener into or out of that tape, it does not restate the tape's own content (narration-craft.md's spoiler rule).`
  );
  return { sourcing: "tape", claim: beat.claim, exploration: beat.exploration, tape: beat.tape, connectiveNarration: connective };
}

async function writePageAndVerify(
  claim: string,
  mode: NarrationMode,
  voice: Voice,
  writer: NarrationWriterBuilder,
  verifier: NarrationVerifierBuilder,
  ctx: NarrationBuildContext,
  contextNote?: string
): Promise<NarratedBeat> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const written = await writer.writePage({ claim, mode, voice, contextNote }, ctx);

      const structural = validateNarratedBeat(
        { mode, script: written.script, sources: written.sources, pronunciationHints: written.pronunciationHints, verified: true },
        { bannedPhrasePatterns: BANNED }
      );
      if (!structural.valid) {
        throw new InvalidNarratedBeatError(claim, mode, structural.issues.map((i) => i.message));
      }

      const verification = await verifier.verifyPage({ claim, mode, voice, contextNote, ...written }, ctx);
      if (!verification.verified) {
        throw new InvalidNarratedBeatError(claim, mode, [verification.verifierNotes ?? "verifier rejected the page with no notes"]);
      }

      return {
        mode,
        script: written.script,
        sources: written.sources,
        pronunciationHints: written.pronunciationHints,
        verified: true,
        verifierNotes: verification.verifierNotes
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw new NarrationWriteError(claim, mode, lastError);
}

/** Flattens every `WrittenBeat`'s narration output (the beat's own page
 * plus any connective page a tape beat carries) across `acts` — used by
 * tests and by a future §4.8 stitching stage that needs a flat ordered
 * list of narration pages rather than the nested act/slot structure. */
export function allWrittenNarration(acts: WrittenAct[]): NarratedBeat[] {
  const out: NarratedBeat[] = [];
  for (const act of acts) {
    for (const slot of act.slots) {
      for (const beat of slot.beats) {
        if (beat.sourcing === "narration") out.push(beat.narration);
        else if (beat.connectiveNarration) out.push(beat.connectiveNarration);
      }
    }
  }
  return out;
}

export { disclosureNarratedBeat, MODE_CHAR_BANDS, containsContestedLanguage };
