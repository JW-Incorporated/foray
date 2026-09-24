import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  narratorStructureLeaks,
  toNarrationWords,
  NARRATOR_STRUCTURE_RULE,
  NARRATOR_STRUCTURE_EXAMPLES
} from "../src/copy/narratorStructure";
import { buildActWritePrompt } from "../src/generation/AnthropicNarrationWriterBuilder";
import { buildSmoothPrompt } from "../src/generation/AnthropicContinuityBuilder";
import { buildDeepenActPrompt } from "../src/generation/AnthropicDeepenActBuilder";
import { buildSpinePrompt } from "../src/generation/AnthropicSpineBuilder";
import { toForayItem } from "../src/generation/forayItems";
import { deepenActs } from "../src/generation/deepenActs";
import { smoothActIntroduction } from "../src/generation/smoothSeam";
import { HANDOFF_SCRIPT } from "../src/generation/writeNarration";
import { preludeItem } from "../src/generation/runPipeline";
import type { ActWriteRequest } from "../src/generation/NarrationWriterBuilder";
import type { DeepenActBuilder } from "../src/generation/DeepenActBuilder";
import type { ContinuityBuilder } from "../src/generation/ContinuityBuilder";
import type { Act, DeepenedAct, Spine } from "../src/types/spine";
import type { IntentUnderstanding } from "../src/types/generation";
import type { ResearchShape } from "../src/types/research";

/**
 * THE NARRATOR NEVER SAYS THE PIPELINE'S WORDS FOR THE FORAY'S PIECES.
 *
 * Wyatt, 2026-09-24, answering the audit's persona 65 — the narrator says
 * "this act", "Act one", "two acts back" out loud, a word the app never
 * defines and never shows: "Accept the ones that are currently there; update
 * our foray generation scripting to avoid making more in the future."
 *
 * So the committed narration is left as voiced, and the GENERATOR changes:
 * every prompt that writes spoken narration states one rule
 * (`NARRATOR_STRUCTURE_RULE`), every stage refuses a violation so the model
 * says it with content, and where no retry is left the words are rewritten
 * in code (`toNarrationWords`) — the last attempt of §4.4, the one call §4.8
 * makes, the prelude's overview, and every narration item on its way out
 * (`forayItems.ts`). The check is `copy/narratorStructure.js`, which now also
 * applies the copy rules' INTERNAL_VOCABULARY (`copy/rules.js`) to speech.
 *
 * The lines below that name a Foray's narration come from the FROZEN fixture
 * (`tools/foray/fixtures/frozen/`), whose generated Foray carries the
 * persona's own examples verbatim. Every test names the mutation that kills
 * it.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const FROZEN_FORAYS = path.join(REPO_ROOT, "tools", "foray", "fixtures", "frozen", "data", "forays.json");

interface FrozenItem {
  type: string;
  script?: string;
}
interface FrozenForay {
  id: string;
  generated?: boolean;
  items: FrozenItem[];
}

function frozenGeneratedScripts(): string[] {
  const data = JSON.parse(fs.readFileSync(FROZEN_FORAYS, "utf8")) as { forays: FrozenForay[] };
  return data.forays
    .filter((f) => f.generated === true)
    .flatMap((f) => f.items.filter((i) => i.type === "narration" && typeof i.script === "string").map((i) => i.script!));
}

describe("narratorStructure — the check reaches every shape the pipeline's words take", () => {
  it("catches persona 65's own lines, verbatim from the frozen generated Foray, and rewrites them into WHEN, not into another unit", () => {
    /* The persona's examples: "this act", "Act one", "two acts back". The
       frozen Foray carries "Two acts back, the ladder cracked. One act back,
       ..." — the singular was invisible to the old count, which only knew
       plurals. MUTATION THAT KILLS THIS: delete the `relative-piece` rule ->
       "Two acts back" is rewritten as a count ("A few stories back"), red. */
    const scripts = frozenGeneratedScripts();
    const line = scripts.find((s) => s.includes("Two acts back"));
    expect(line, "the frozen generated Foray no longer carries persona 65's line").toBeDefined();
    const phrases = narratorStructureLeaks(line!).map((l) => l.phrase);
    expect(phrases).toEqual(expect.arrayContaining(["Two acts back", "One act back"]));
    const spoken = toNarrationWords(line!).text;
    expect(spoken).toContain("Earlier, the ladder cracked. Earlier, that crack forced a choice");
    expect(narratorStructureLeaks(spoken)).toEqual([]);
  });

  it("does not read a contraction as a possessive: \"That's this act.\" is a pointer", () => {
    /* A committed generated line ended "That's this act." and passed, because
       the possessive anchor ("Macbeth's first act") took "That's" for an
       owner. MUTATION THAT KILLS THIS: drop the NOT_A_POSSESSIVE lookahead
       from POSSESSIVE_ANCHOR -> the first expectation goes red. */
    expect(narratorStructureLeaks("Budget line, vendors, outages. That's this act.")).not.toHaveLength(0);
    expect(narratorStructureLeaks("Here's the next act.")).not.toHaveLength(0);
    expect(narratorStructureLeaks("Macbeth's first act opens in a storm.")).toEqual([]);
  });

  it("holds speech to the copy rules' INTERNAL_VOCABULARY, under the same anchors", () => {
    /* A word a Foray's title may not use (rules.js INTERNAL_VOCABULARY) is
       never said aloud either. MUTATION THAT KILLS THIS: delete the
       `...INTERNAL_VOCABULARY.map(...)` entries from RULES -> "a forty-beat
       history", "the running order" and "every act" go uncaught. */
    for (const line of ["It is a forty-beat history.", "You cannot see the running order.", "Every act asks the same question.", "One beat, then the drop."]) {
      expect(narratorStructureLeaks(line), line).not.toHaveLength(0);
    }
    /* ...and the anchors still hold, so a Foray about a drummer, a statute
       or a play can say what it needs to. MUTATION: delete TEMPO_ANCHOR ->
       the first line goes red; drop "his|her|their..." from
       POSSESSIVE_ANCHOR -> "His final act" goes red. */
    for (const line of [
      "The track runs at ninety beats per minute.",
      "The Clean Air Act passed in 1970.",
      "The play's three acts run ninety minutes.",
      "His final act was to sign the order.",
      "Three acts of Macbeth were cut.",
      "In the first act of Macbeth, the witches speak.",
      "Where does the story go from here? Keep listening."
    ]) {
      expect(narratorStructureLeaks(line), line).toEqual([]);
    }
  });

  it("knows the pipeline's slot and spine, and a pointer at a counted run of pieces", () => {
    /* MUTATION THAT KILLS THIS: take `slots?|spines?` back out of
       STRUCTURE_NOUN, or delete the `pointer-count` rule (then "the next four
       acts" is a count, and its rewrite reads "the next a few stories"). */
    expect(narratorStructureLeaks("The next slot is about money.")).not.toHaveLength(0);
    expect(narratorStructureLeaks("This spine was built from tape.")).not.toHaveLength(0);
    expect(toNarrationWords("Over the next four acts I'm going to argue a point.").text).toBe("Over what follows I'm going to argue a point.");
  });
});

describe("toNarrationWords — the rewrite where no retry is left", () => {
  it("rewrites each shape into what a narrator would say, capitalising only at a sentence start", () => {
    /* Every line is a real shape from a committed generated Foray.
       MUTATION THAT KILLS THIS: return the listener's unit word ("part")
       instead of `narrationReplacement` -> red, and the result is still a
       pointer at a piece. Treat a dash as a sentence end in
       `atSentenceStart` -> the "reckless engineer" line goes red. */
    const table: Array<[string, string]> = [
      ["Act one opens with the assumption.", "The story opens with the assumption."],
      ["The failures stay invisible. Act 3 goes looking for them.", "The failures stay invisible. What follows goes looking for them."],
      ["The next act follows the money.", "What comes next follows the money."],
      ["By the end of this act you have the shape of the chain.", "By the end of this story you have the shape of the chain."],
      [
        "You've stopped looking for the reckless engineer — the last act showed you the flaw.",
        "You've stopped looking for the reckless engineer — what came before showed you the flaw."
      ],
      ["Every failure this documentary has traced so far.", "Every failure this story has traced so far."],
      ["It is a forty-beat history.", "It is a history."],
      ["It was an eight-act opera.", "It was an opera."]
    ];
    for (const [input, expected] of table) {
      const out = toNarrationWords(input);
      expect(out.text, input).toBe(expected);
      expect(out.changed).toBe(true);
    }
  });

  it("is a fixed point on every line of the frozen generated Foray and on every refused example, and leaves plain English alone", () => {
    /* MUTATION THAT KILLS THIS: make a replacement carry a structural noun
       (e.g. "this act" -> "this part") -> the leak check on the output goes
       red. */
    for (const line of [...frozenGeneratedScripts(), ...NARRATOR_STRUCTURE_EXAMPLES.refused]) {
      const out = toNarrationWords(line);
      expect(narratorStructureLeaks(out.text), out.text).toEqual([]);
      expect(toNarrationWords(out.text)).toEqual({ text: out.text, changed: false });
    }
    for (const line of NARRATOR_STRUCTURE_EXAMPLES.fine) expect(toNarrationWords(line)).toEqual({ text: line, changed: false });
  });
});

const voice = { style: "s", register: "r", sentenceRhythm: "sr", narratorPresence: "np" };

function makeAct(label: string): Act {
  return {
    title: `Act ${label}`,
    thesis: `Act ${label} establishes something new.`,
    startState: `The listener does not yet know about ${label}.`,
    endState: `The listener now understands ${label}.`,
    slots: [{ title: `${label} slot`, beats: [{ claim: `Researchers documented ${label} extensively in the 1990s.`, exploration: false }] }]
  };
}

const spine: Spine = {
  subject: "engineering careers",
  angle: "what the job turns into",
  overview: "We follow engineers from the bench to the budget meeting, told by the people who made the climb.",
  duration: "short",
  generatedAt: "2026-09-24T00:00:00.000Z",
  voice,
  acts: [makeAct("1"), makeAct("2")]
};

describe("the rule is TOLD to every prompt that writes spoken narration", () => {
  it("states one rule whose examples the machine agrees with", () => {
    /* The instruction must never promise the model something the check
       disagrees with. MUTATION THAT KILLS THIS: add an example the check does
       not catch (e.g. "this bit") to `refused`, or one it refuses to `fine`. */
    for (const example of NARRATOR_STRUCTURE_EXAMPLES.refused) {
      expect(narratorStructureLeaks(example), example).not.toHaveLength(0);
      expect(NARRATOR_STRUCTURE_RULE).toContain(`"${example}"`);
    }
    for (const example of NARRATOR_STRUCTURE_EXAMPLES.fine) {
      expect(narratorStructureLeaks(example), example).toEqual([]);
      expect(NARRATOR_STRUCTURE_RULE).toContain(`"${example}"`);
    }
    for (const word of ["Act", "beat", "segment", "slot", "spine", "running order"]) expect(NARRATOR_STRUCTURE_RULE).toContain(word);
  });

  it("the act writer, the act deepener (introductions and exits), the continuity editor and the spine's overview all carry it", () => {
    /* MUTATION THAT KILLS THIS: drop NARRATOR_STRUCTURE_RULE from any one of
       the four prompts -> that line goes red. The deepener is the one that
       matters most: every committed violation was an act introduction or
       exit (types/spine.ts, Q-08). */
    const request = { actTitle: "Act 1", voice, seams: [], clips: [], documents: [] } as unknown as ActWriteRequest;
    expect(buildActWritePrompt(request)).toContain(NARRATOR_STRUCTURE_RULE);
    expect(buildDeepenActPrompt(spine, spine.acts[0]!, 0)).toContain(NARRATOR_STRUCTURE_RULE);
    expect(
      buildSmoothPrompt({ previousActExit: "The bench is behind them.", previousActTitle: "Act 1", nextActIntroduction: "Now the budget.", nextActTitle: "Act 2" })
    ).toContain(NARRATOR_STRUCTURE_RULE);
    const intent: IntentUnderstanding = { subject: spine.subject, angle: spine.angle, priorKnowledge: "p", disappointment: "d" };
    const shape = { subject: spine.subject, angle: spine.angle, generatedAt: spine.generatedAt, subtopics: [], nonObviousAngle: null, externalGapsResearched: [] } as unknown as ResearchShape;
    expect(buildSpinePrompt(intent, shape, "short")).toContain(NARRATOR_STRUCTURE_RULE);
  });
});

describe("the rule is ENFORCED where no retry is left", () => {
  it("§4.4: the first attempt is refused, the last is rewritten in code instead of losing the run", async () => {
    /* MUTATION THAT KILLS THIS: delete the `spokenIntroductionAndExit` call
       in deepenOneActWithRetry -> both attempts fail validation and the
       stage throws ActDeepeningError. */
    const deepenAct = vi.fn(async (_spine: Spine, act: Act): Promise<DeepenedAct> => ({
      ...act,
      introduction: "This act follows the assumption until it breaks.",
      exit: "The next act takes the assumption apart."
    }));
    const builder = { providerName: "test", deepenAct } as unknown as DeepenActBuilder;
    const [first] = await deepenActs({ ...spine, acts: [makeAct("1")] }, builder, { userId: "founder-1" });
    expect(deepenAct).toHaveBeenCalledTimes(2);
    expect(first!.introduction).toBe("This story follows the assumption until it breaks.");
    expect(first!.exit).toBe("What comes next takes the assumption apart.");
  });

  it("§4.8: the one smoothing call's structural bridge is rewritten, not thrown", async () => {
    /* MUTATION THAT KILLS THIS: validate `smoothed.nextIntroduction` instead
       of the rewritten text -> SeamSmoothingError. */
    const acts: DeepenedAct[] = [spine.acts[0]!, spine.acts[1]!].map((act, i) => ({
      ...act,
      introduction: `An introduction that opens part number ${i + 1} of the story with some weight.`,
      exit: `An exit that closes part number ${i + 1} of the story with some weight.`
    }));
    const builder: ContinuityBuilder = {
      providerName: "test",
      smoothSeam: async () => ({ nextIntroduction: "The last act showed you the bench. Now the budget meeting takes over." })
    } as unknown as ContinuityBuilder;
    const introduction = await smoothActIntroduction(acts, 1, { builder }, { userId: "founder-1" });
    expect(introduction).toBe("What came before showed you the bench. Now the budget meeting takes over.");
  });

  it("every narration item leaves the pipeline with the words rewritten out of it (forayItems.ts)", () => {
    /* A seam kept unverified after its last round keeps its last script; this
       is where it stops being a publish-gate refusal after the spend.
       MUTATION THAT KILLS THIS: map `script: item.script` again in
       toForayItem. */
    const item = toForayItem({ kind: "narration", narrationKind: "seam", mode: "Frame", id: "act-2-introduction", slotTitle: "2 slot", script: "Two acts back, the ladder cracked." });
    expect(item).toMatchObject({ type: "narration", script: "Earlier, the ladder cracked." });
  });

  it("the prelude's overview is rewritten too — it is the one narration item that does not pass through forayItems.ts", () => {
    /* MUTATION THAT KILLS THIS: pass `overview` to preludeTemplate unchanged. */
    const prelude = preludeItem("engineering careers", "Over the next four acts we follow engineers up the ladder.", "bench") as { script: string };
    expect(prelude.script).toContain("Over what follows we follow engineers up the ladder.");
    expect(narratorStructureLeaks(prelude.script)).toEqual([]);
  });

  it("the fallback hand-off a seam gets when no page was produced names no piece at all, not even a \"part\"", () => {
    /* It said "Where does this part of the story go next?" — a pointer at a
       piece in the listener's word, which the rule's own audit found fixes
       nothing. MUTATION THAT KILLS THIS: restore that wording. */
    expect(HANDOFF_SCRIPT).not.toMatch(/\b(?:acts?|beats?|segments?|slots?|spines?|parts?|sections?|chapters?)\b/i);
    expect(narratorStructureLeaks(HANDOFF_SCRIPT)).toEqual([]);
  });
});
