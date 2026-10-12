import { NARRATOR_STRUCTURE_RULE } from "../../copy/narratorStructure";
import type { Act, Spine } from "../../types/spine";
import { joinParts, type PromptParts } from "../promptLayout";

/**
 * §4.4's act-deepening prompt, moved here from AnthropicDeepenActBuilder.ts by
 * GV-32 (decision 8: prompt text moves once, into prompts/*.ts; the Anthropic
 * and Chat builders both import it).
 *
 * Layout (promptLayout.ts, W2-13):
 *   stable  "Your job" with its six rules and the reply shape.
 *   foray   the subject line, angle and voice, and the FULL SPINE summary
 *           with EVERY act rendered alike (title, thesis, start, end), so it
 *           is byte-identical for every act of one Foray. deepenActs.ts hands
 *           every act's call the same spine.
 *   call    which act this call deepens (the act marker), and that act's
 *           title, thesis, states, slots and frozen-seed lines.
 *
 * The one rewrite (the rest are the pre-GV-32 lines, reordered): the act
 * marker no longer sits inside the spine summary, where it made the summary
 * differ per act; it opens the call part instead. Rule 4 said "act N does not
 * re-explain..." with this act's number inside the rules; it now says "this
 * act", and the number is on the TARGET ACT line in the call part.
 */

/** The deepen prompt's static half: built once, the same bytes for every Foray and act. */
const DEEPEN_STABLE = [
  "Your job:",
  "1. Refine this act's slots and sharpen its beats — make the claims more specific/concrete where they",
  "   are still high-level. Do NOT add or remove slots. You may refine beat wording but every beat must",
  "   remain a CLAIM, never a topic (e.g. \"Charcoal briquettes were a Ford Motor Company waste-disposal",
  "   scheme\" is a beat; \"Briquettes\" is not). The one exception is rule 2.",
  "2. A BEAT MARKED [SEEDED] HAS A FROZEN CLAIM: copy its `claim` string ACROSS VERBATIM, character for",
  "   character. Do not sharpen it, shorten it, re-order it, add an example to it or improve its prose.",
  "   Its wording was written from the stretch of real tape named on the beat, and the sourcing stage",
  "   scores THAT WORDING, word for word, against THAT STRETCH OF TAPE before it will use it: every word",
  "   you add that nobody on the recording says lowers the score, and a beat that drops below the floor",
  "   loses its tape and becomes narration instead. A rewrite that reads better is still a beat with no",
  "   tape. Everything else about a seeded beat is yours to write as normal — `exploration` and `kind`",
  "   below, and the act's own title, thesis, states, introduction and exit — only the claim is frozen.",
  "3. Tag every beat `kind`. \"account\" is the DEFAULT and covers most beats: an event, a practice, a",
  "   measurement, or a mechanism someone could be heard describing — a person explaining how a thing",
  "   is done is an account, not an argument. Use \"argument\" ONLY for a claim about what something",
  "   MEANS or what someone SHOULD do, which no recording of an event, a person or a practice could",
  "   carry. Arguments are narrated, never illustrated with tape, so a beat wrongly tagged \"argument\"",
  "   silently loses its tape; at most a third of any one slot's beats may be arguments.",
  "4. Write this act's own INTRODUCTION — what a listener hears entering this act. Use the full spine so",
  "   this act does not re-explain what an earlier act already established.",
  "5. Write this act's EXIT — the connective tissue into the next act (its own half of the handoff; a",
  "   later continuity pass reconciles the full cross-act seam, this is just this act's side of it).",
  `6. The introduction and the exit are SPOKEN. ${NARRATOR_STRUCTURE_RULE}`,
  "",
  "Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:",
  '{"title": string, "thesis": string, "startState": string, "endState": string, ' +
    '"slots": [{"title": string, "beats": [{"claim": string, "exploration": boolean, "kind": "account" | "argument", ' +
    '"seed"?: {"episodeId": string, "startSec": number, "endSec": number}}]}], ' +
    '"introduction": string, "exit": string}'
].join("\n");

/** One act's line in the FULL SPINE summary; every act, the target included, is rendered this way. */
function spineSummaryLine(act: Act, i: number): string {
  return `Act ${i + 1}: "${act.title}" — thesis: ${act.thesis} — start: ${act.startState} — end: ${act.endState}`;
}

export function buildDeepenActPromptParts(spine: Spine, targetAct: Act, targetActIndex: number): PromptParts {
  const targetSlotLines = targetAct.slots
    .map(
      (slot, i) =>
        `  Slot ${i + 1}: "${slot.title}"\n${slot.beats
          .map(
            (b) =>
              `    - ${b.claim}${b.exploration ? " [exploration]" : ""}` +
              /* WS-L: a seeded beat was written from a stretch of real tape.
                 Marked FROZEN rather than merely shown (F-68): §4.5 scores this
                 claim's own words against that stretch, so a paraphrase here is
                 what loses the tape. `deepenActs.ts` restores both the claim and
                 the seed either way. */
              (b.seed
                ? ` [SEEDED — THIS CLAIM IS FROZEN, COPY IT VERBATIM; written from tape ${b.seed.episodeId} ` +
                  `${Math.round(b.seed.startSec)}-${Math.round(b.seed.endSec)}s]`
                : "")
          )
          .join("\n")}`
    )
    .join("\n");

  return {
    stable: DEEPEN_STABLE,
    foray: [
      `You are deepening ONE act of a full spine for an audio documentary ("Foray") on: "${spine.subject}".`,
      `Angle: ${spine.angle}`,
      `Voice (decided once for the whole spine — do not vary it): style: ${spine.voice.style}; register: ${spine.voice.register}; ` +
        `sentence rhythm: ${spine.voice.sentenceRhythm}; narrator presence: ${spine.voice.narratorPresence}`,
      "",
      "FULL SPINE (all acts, for context — you own only the target act):",
      spine.acts.map(spineSummaryLine).join("\n")
    ].join("\n"),
    call: [
      `THIS IS THE ACT YOU ARE DEEPENING: Act ${targetActIndex + 1}, "${targetAct.title}" — full detail below.`,
      `TARGET ACT (Act ${targetActIndex + 1} of ${spine.acts.length}): "${targetAct.title}"`,
      `Thesis: ${targetAct.thesis}`,
      `Start state: ${targetAct.startState}`,
      `End state: ${targetAct.endState}`,
      "Slots and beats to refine:",
      targetSlotLines
    ].join("\n")
  };
}

/** The legacy single-string deepen prompt (the Anthropic builder sends it). */
export function buildDeepenActPrompt(spine: Spine, targetAct: Act, targetActIndex: number): string {
  return joinParts(buildDeepenActPromptParts(spine, targetAct, targetActIndex));
}
