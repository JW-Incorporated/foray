import { describe, it, expect } from "vitest";
import { ISO_TIMESTAMP_RE, joinParts, stableStringify, toChatMessages, type PromptParts } from "../src/generation/promptLayout";
import { buildClarityPromptParts, buildIntentPromptParts } from "../src/generation/prompts/understand";
import { buildSpinePromptParts } from "../src/generation/prompts/spine";
import { buildDeepenActPromptParts } from "../src/generation/prompts/deepen";
import { buildSmoothPromptParts } from "../src/generation/prompts/continuity";
import { ChatPromptUnderstander } from "../src/generation/chat/ChatPromptUnderstander";
import { ChatSpineBuilder } from "../src/generation/chat/ChatSpineBuilder";
import { ChatDeepenActBuilder } from "../src/generation/chat/ChatDeepenActBuilder";
import { ChatContinuityBuilder } from "../src/generation/chat/ChatContinuityBuilder";
import type { StructuredTarget } from "../src/generation/chat/askStructured";
import type { ChatMessage } from "../src/generation/chat/ChatProvider";
import { NARRATOR_STRUCTURE_RULE } from "../src/copy/narratorStructure";
import type { ContinuitySmoothRequest } from "../src/generation/ContinuityBuilder";
import type { IntentUnderstanding } from "../src/types/generation";
import type { ResearchShape } from "../src/types/research";
import {
  DURATION_SHAPE_BUDGETS,
  SPINE_MIN_SEEDED_BEATS_PER_ACT,
  type Act,
  type DurationTier,
  type Spine
} from "../src/types/spine";
import { SPINE_SEED_REPEAT_MIN, SPINE_SEED_THIRD_MIN } from "../src/generation/spineSeeding";
import { scriptedProvider } from "./helpers/fakeChatProvider";

/**
 * GV-32 (docs/roadmap/generation-v2.md, #1286; from W2-13 + W4-04 item 1):
 * the planning prompts as [stable][foray][call] (promptLayout.ts), so the
 * bytes that open a call are the same on every call and SGLang's radix cache
 * can reuse them. Offline only: pure prompt builders, scriptedProvider for the
 * Chat builders, hand-built fixtures. Each test names the mutation that turns
 * it red; every one was run.
 */

const TIERS: DurationTier[] = ["short", "medium", "long"];

const intentA: IntentUnderstanding = {
  subject: "Kingsford and the Model T",
  angle: "an industrial waste-disposal scheme, not a cookout footnote",
  priorKnowledge: "briquettes are used for grilling",
  disappointment: "no mention of the Ford Motor Company connection"
};
const intentB: IntentUnderstanding = {
  subject: "how AI systems get built",
  angle: "the engineering, not the research",
  priorKnowledge: "has heard of machine learning",
  disappointment: "stays at the level of model architectures"
};

const shapeWithWindows: ResearchShape = {
  subject: intentB.subject,
  angle: intentB.angle,
  generatedAt: "2026-10-12T08:00:00.000Z",
  subtopics: [
    {
      label: "Machine Learning",
      source: "semantic-concept",
      tape: { signal: "strong", itemCount: 761, showCount: 4, exampleItemIds: [] },
      controversies: ["benchmarks overfit"],
      externalNotes: null,
      externallyResearched: false,
      tapeWindows: [
        {
          episodeId: "practical-ai--episode-900",
          showTitle: "Practical AI",
          episodeTitle: "Episode 900",
          startSec: 100,
          endSec: 165,
          text: "an audit found thousands of mislabelled validation images across the whole benchmark",
          score: 3.2
        }
      ],
      tapeEpisodesMatched: 3,
      windowsUnavailable: null
    }
  ],
  nonObviousAngle: null,
  externalGapsResearched: []
};
const shapeWithout: ResearchShape = {
  subject: intentA.subject,
  angle: intentA.angle,
  generatedAt: "2026-10-11T23:59:59.000Z",
  subtopics: [
    {
      label: "Ford waste-disposal origins",
      source: "literal-term",
      tape: { signal: "thin", itemCount: 2, showCount: 1, exampleItemIds: [] },
      controversies: [],
      externalNotes: "Kingsford began as a Ford byproduct plant in 1920",
      externallyResearched: true,
      tapeWindows: [],
      windowsUnavailable: "no transcript text index in this fixture"
    }
  ],
  nonObviousAngle: null,
  externalGapsResearched: ["Ford waste-disposal origins"]
};

function act(n: number, seeded = false): Act {
  return {
    title: `The ${["first", "second", "third"][n - 1]} turn`,
    thesis: `thesis ${n}`,
    startState: `believes ${n}`,
    endState: `believes ${n + 1}`,
    slots: [
      {
        title: `slot ${n}`,
        beats: [
          { claim: `Claim ${n}a happened`, exploration: false },
          seeded
            ? { claim: `Claim ${n}b was said on tape`, exploration: true, seed: { episodeId: "pa-900", startSec: 100.4, endSec: 165.6 } }
            : { claim: `Claim ${n}b happened`, exploration: true }
        ]
      }
    ]
  };
}

const spineA: Spine = {
  subject: intentA.subject,
  angle: intentA.angle,
  overview: "A cookout staple turns out to be a factory's leftovers.",
  duration: "medium",
  generatedAt: "2026-10-12T08:00:00.000Z",
  voice: { style: "plain", register: "conversational", sentenceRhythm: "short", narratorPresence: "light" },
  acts: [act(1), act(2, true), act(3)]
};
const spineB: Spine = {
  ...spineA,
  subject: intentB.subject,
  angle: intentB.angle,
  generatedAt: "2026-09-09T00:00:00.000Z",
  voice: { style: "brisk", register: "wry", sentenceRhythm: "long", narratorPresence: "present" },
  acts: [act(2), act(1, true)]
};

const seamA: ContinuitySmoothRequest = {
  previousActTitle: "The first turn",
  previousActExit: "And the bench was behind them.",
  nextActTitle: "The second turn",
  nextActIntroduction: "Now the budget."
};
const seamB: ContinuitySmoothRequest = {
  previousActTitle: "Data, first",
  previousActExit: "The labels were wrong all along.",
  nextActTitle: "Shipping it",
  nextActIntroduction: "Someone has to deploy the thing."
};

/** The non-blank lines of a prompt, sorted: its content without its order. */
function lineSet(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .sort();
}

/** a minus b, as multisets. */
function minus(a: string[], b: string[]): string[] {
  const rest = [...b];
  return a.filter((x) => {
    const i = rest.indexOf(x);
    if (i === -1) return true;
    rest.splice(i, 1);
    return false;
  });
}

describe("promptLayout: joinParts, toChatMessages, stableStringify", () => {
  it("joinParts joins the non-empty parts in order, a blank line between them", () => {
    /* MUTATION THAT KILLS THIS: drop the `.filter((p) => p.length > 0)` in
       joinParts (an empty foray then leaves a double blank line). Ran it: red. */
    expect(joinParts({ stable: "S1\nS2", foray: "F", call: "C" })).toBe("S1\nS2\n\nF\n\nC");
    expect(joinParts({ stable: "S", foray: "", call: "C" })).toBe("S\n\nC");
    expect(joinParts({ stable: "S", foray: "F", call: "" })).toBe("S\n\nF");
  });

  it("toChatMessages sends [system: stable, user: foray + call], and the user turn is exactly foray when there is no call", () => {
    /* MUTATION THAT KILLS THIS: put `parts.foray` into the system message
       (the per-Foray text then sits in the cross-Foray prefix). Ran it: red. */
    const parts: PromptParts = { stable: "rules", foray: "this foray", call: "this call" };
    expect(toChatMessages(parts)).toEqual([
      { role: "system", content: "rules" },
      { role: "user", content: "this foray\n\nthis call" }
    ]);
    expect(toChatMessages({ stable: "rules", foray: "this foray", call: "" })[1]).toEqual({ role: "user", content: "this foray" });
    expect(toChatMessages({ stable: "rules", foray: "", call: "this call" })[1]).toEqual({ role: "user", content: "this call" });
    expect(toChatMessages(parts)).not.toBe(toChatMessages(parts));
  });

  it("stableStringify sorts keys at every depth, drops timestamp-valued properties and keeps array order", () => {
    /* MUTATION THAT KILLS THIS: drop `.sort()` in stripAndSort (key order
       then follows insertion order). Ran it: red. Second: drop the
       ISO_TIMESTAMP_RE skip. Ran it: red. */
    const a = { b: 1, a: { d: [3, 1, 2], c: "x" }, generatedAt: "2026-10-12T08:00:00.000Z" };
    const b = { generatedAt: "2025-01-01T00:00:00Z", a: { c: "x", d: [3, 1, 2] }, b: 1 };
    expect(stableStringify(a)).toBe('{"a":{"c":"x","d":[3,1,2]},"b":1}');
    expect(stableStringify(b)).toBe(stableStringify(a));
    expect(stableStringify({ when: "on 2026-10-12" })).toBe('{"when":"on 2026-10-12"}');
  });
});

describe("GV-32: the stable part is byte-identical across unrelated inputs", () => {
  it("clarity and intent: the rules and the JSON shape are stable, the listener's prompt is the call, there is no foray part", () => {
    /* MUTATION THAT KILLS THIS: move the quoted `"${prompt}"` line from the
       call part into buildIntentPromptParts' stable part. Ran it: red. */
    for (const build of [buildClarityPromptParts, buildIntentPromptParts]) {
      const a = build("Jupiter");
      const b = build("the history of barbecue in Kansas City");
      expect(a.stable).toBe(b.stable);
      expect(a.stable).not.toContain("Jupiter");
      expect(a.foray).toBe("");
      expect(a.call).toContain('"Jupiter"');
      expect(b.call).toContain('"the history of barbecue in Kansas City"');
      expect(a.stable).toMatch(/Respond with ONLY a single JSON object/);
    }
  });

  it("spine: the prefix is identical across two intents, two research maps and all three tiers, and names no subject, tier, tier number or episode", () => {
    /* MUTATION THAT KILLS THIS: move the `Duration tier: ...` line from the
       foray part into SPINE_STABLE (with its budget numbers). Ran it: red.
       Second: move `...seedRule` into SPINE_STABLE. Ran it: red. */
    const prefixes = new Set<string>();
    for (const intent of [intentA, intentB])
      for (const shape of [shapeWithWindows, shapeWithout])
        for (const tier of TIERS) {
          const parts = buildSpinePromptParts(intent, shape, tier);
          prefixes.add(parts.stable);
          expect(parts.call).toBe("");
          expect(parts.foray).toContain(`Duration tier: ${tier}.`);
          expect(parts.foray).toContain(`"${intent.subject}"`);
        }
    expect(prefixes.size).toBe(1);
    const stable = [...prefixes][0]!;
    for (const intent of [intentA, intentB]) {
      expect(stable).not.toContain(intent.subject);
      expect(stable).not.toContain(intent.angle);
    }
    expect(stable).not.toContain("practical-ai--episode-900");
    expect(stable).not.toContain("Machine Learning");
    expect(stable).not.toMatch(/\b(short|medium|long)\b/);
    expect(stable).not.toContain("Duration tier");
    for (const tier of TIERS) {
      const b = DURATION_SHAPE_BUDGETS[tier];
      expect(stable).not.toContain(`${b.acts[0]}-${b.acts[1]} acts`);
      expect(stable).not.toContain(`${b.slots[0]}-${b.slots[1]} slots`);
      expect(stable).not.toContain(`${b.items[0]}-${b.items[1]} beats`);
    }
    /* The only digits in the prefix are the fixed rules' own (30% exploration,
       "22 segments" as a forbidden example), never a tier's. */
    expect(stable.replace(NARRATOR_STRUCTURE_RULE, "").match(/\d+/g)).toEqual(["22", "30"]);
  });

  it("deepen: the stable part is identical for every act of two spines, the foray part for every act of one spine, and only the call part names the act being deepened", () => {
    /* MUTATION THAT KILLS THIS: in buildDeepenActPromptParts, render the
       target act's summary line as the legacy marker
       (`i === targetActIndex ? 'Act N (THIS IS THE ACT YOU ARE DEEPENING ...'`)
       again. Ran it: red. Second: put `act ${targetActIndex + 1}` back into
       rule 4. Ran it: red. */
    const stables = new Set<string>();
    for (const spine of [spineA, spineB]) {
      const forays = new Set<string>();
      const calls = new Set<string>();
      spine.acts.forEach((a, i) => {
        const parts = buildDeepenActPromptParts(spine, a, i);
        stables.add(parts.stable);
        forays.add(parts.foray);
        calls.add(parts.call);
        expect(parts.foray).not.toContain("THIS IS THE ACT YOU ARE DEEPENING");
        expect(parts.call).toContain(`THIS IS THE ACT YOU ARE DEEPENING: Act ${i + 1}, "${a.title}"`);
        expect(parts.call).toContain(`TARGET ACT (Act ${i + 1} of ${spine.acts.length})`);
      });
      expect(forays.size).toBe(1);
      expect(calls.size).toBe(spine.acts.length);
      expect([...forays][0]).toContain(`on: "${spine.subject}"`);
    }
    expect(stables.size).toBe(1);
  });

  it("continuity: the stable part is identical across two seams, and the next act's title is only in the call part", () => {
    /* MUTATION THAT KILLS THIS: move the `Keep it a real introduction to
       "${request.nextActTitle}"` line into CONTINUITY_STABLE. Ran it: red. */
    const a = buildSmoothPromptParts(seamA);
    const b = buildSmoothPromptParts(seamB);
    expect(a.stable).toBe(b.stable);
    expect(a.foray).toBe("");
    for (const seam of [seamA, seamB]) {
      expect(a.stable).not.toContain(seam.nextActTitle);
      expect(a.stable).not.toContain(seam.previousActExit);
    }
    expect(a.call).toContain(`Keep it a real introduction to "${seamA.nextActTitle}"`);
    expect(a.stable).toContain(NARRATOR_STRUCTURE_RULE);
  });
});

describe("GV-32: nothing run-specific in the cacheable parts", () => {
  it("no part the Chat builders send carries an ISO timestamp, the sessionId or the checkpoint key", async () => {
    /* MUTATION THAT KILLS THIS: add `Spine written ${spine.generatedAt}` to
       the deepen foray part (or `Run: ${ctx.sessionId}` anywhere). Ran the
       first: red. */
    const checkpointKey = "2026-10-12-charcoal-briquettes-medium";
    const ctx = { userId: "founder-1", sessionId: checkpointKey };
    const target: StructuredTarget = { providerName: "local:spark", model: "local-heavy", structuredOutput: "json_schema", usdPerMtokIn: 0, usdPerMtokOut: 0 };
    const guard = { checkAndRecord: async () => undefined };
    const sent: ChatMessage[][] = [];
    const record = (reply: string) => scriptedProvider({ complete: (req) => (sent.push(req.messages), reply) });

    await new ChatPromptUnderstander(record('{"ambiguous": false, "readings": [], "question": null}'), target, guard).assessClarity("Mercury", ctx);
    await new ChatPromptUnderstander(
      record(JSON.stringify({ ...intentA, title: "How a car company made charcoal", summary: "Why a car company made charcoal." })),
      target,
      guard
    ).extractIntent("charcoal briquettes", ctx);
    const rawSpine = { overview: spineA.overview, voice: spineA.voice, acts: spineA.acts };
    await new ChatSpineBuilder(record(JSON.stringify(rawSpine)), target, guard).buildSpine(intentA, shapeWithWindows, "medium", ctx);
    const deepened = { ...spineA.acts[1]!, introduction: "In.", exit: "Out." };
    await new ChatDeepenActBuilder(record(JSON.stringify(deepened)), target, guard).deepenAct(spineA, spineA.acts[1]!, 1, ctx);
    await new ChatContinuityBuilder(record('{"nextIntroduction": "Then."}'), target, guard).smoothSeam(seamA, ctx);

    expect(sent).toHaveLength(5);
    for (const messages of sent) {
      expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
      for (const m of messages) {
        expect(m.content).not.toMatch(ISO_TIMESTAMP_RE);
        expect(m.content).not.toContain(checkpointKey);
        expect(m.content).not.toContain("2026-10-12");
      }
    }
    /* The fixtures do carry timestamps: the test is not vacuous. */
    expect(shapeWithWindows.generatedAt).toMatch(ISO_TIMESTAMP_RE);
    expect(spineA.generatedAt).toMatch(ISO_TIMESTAMP_RE);
  });

  it("a re-ask keeps the prefix: a spine fix re-ask and a deepen JSON re-ask open with the first call's exact [system, user]", async () => {
    /* MUTATION THAT KILLS THIS: in ChatSpineBuilder, open with
       `[{ role: "user", content: joinParts(parts) }]` (the legacy single turn)
       instead of toChatMessages(parts). Ran it: red. */
    const target: StructuredTarget = { providerName: "local:second", model: "local-worker", structuredOutput: "json_schema", usdPerMtokIn: 0, usdPerMtokOut: 0 };
    const guard = { checkAndRecord: async () => undefined };
    const ctx = { userId: "u1", sessionId: "s1" };
    const rawSpine = { overview: spineA.overview, voice: spineA.voice, acts: spineA.acts };
    const spineProvider = scriptedProvider({ complete: [JSON.stringify(rawSpine), JSON.stringify(rawSpine)] });
    const builder = new ChatSpineBuilder(spineProvider, target, guard);
    const previous = await builder.buildSpine(intentA, shapeWithWindows, "short", ctx);
    await builder.buildSpine(intentA, shapeWithWindows, "short", { ...ctx, revision: { previous, violations: ["act 1: two sentences"], attempt: 1 } });
    const [first, reask] = spineProvider.requests;
    expect(first!.messages).toEqual(toChatMessages(buildSpinePromptParts(intentA, shapeWithWindows, "short")));
    expect(reask!.messages.slice(0, 2)).toEqual(first!.messages);
    expect(reask!.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);

    const deepened = JSON.stringify({ ...spineA.acts[0]!, introduction: "In.", exit: "Out." });
    const deepenProvider = scriptedProvider({ complete: ["not json", deepened] });
    await new ChatDeepenActBuilder(deepenProvider, target, guard).deepenAct(spineA, spineA.acts[0]!, 0, ctx);
    const [d1, d2] = deepenProvider.requests;
    expect(d1!.messages).toEqual(toChatMessages(buildDeepenActPromptParts(spineA, spineA.acts[0]!, 0)));
    expect(d2!.messages.slice(0, 2)).toEqual(d1!.messages);
  });
});

describe("GV-32: a content-preserving reorder (every pre-GV-32 instruction line is still sent)", () => {
  it("clarity, intent, spine (with and without windows, every tier) and continuity send exactly the legacy lines, only reordered", () => {
    /* MUTATION THAT KILLS THIS: delete "sprinkle a token few; hit the floor
       for real." from SPINE_STABLE. Ran it: red. Second: drop `...seedRule`
       from the spine foray part. Ran it: red. */
    for (const p of ["Mercury", "the history of barbecue"]) {
      expect(lineSet(joinParts(buildClarityPromptParts(p)))).toEqual(lineSet(legacyBuildClarityPrompt(p)));
      expect(lineSet(joinParts(buildIntentPromptParts(p)))).toEqual(lineSet(legacyBuildIntentPrompt(p)));
    }
    for (const intent of [intentA, intentB])
      for (const shape of [shapeWithWindows, shapeWithout])
        for (const tier of TIERS)
          expect(lineSet(joinParts(buildSpinePromptParts(intent, shape, tier)))).toEqual(lineSet(legacyBuildSpinePrompt(intent, shape, tier)));
    for (const seam of [seamA, seamB]) expect(lineSet(joinParts(buildSmoothPromptParts(seam)))).toEqual(lineSet(legacyBuildSmoothPrompt(seam)));
  });

  it("deepen sends the legacy lines except the act-marker lines, which are rewritten on purpose and listed here", () => {
    /* MUTATION THAT KILLS THIS: drop the "Slots and beats to refine:" line
       from the deepen call part. Ran it: red. Second: delete rule 3's
       "silently loses its tape..." line. Ran it: red. */
    for (const spine of [spineA, spineB])
      spine.acts.forEach((a, i) => {
        const now = lineSet(joinParts(buildDeepenActPromptParts(spine, a, i)));
        const before = lineSet(legacyBuildDeepenActPrompt(spine, a, i));
        /* Rewritten: the marker left the spine summary (the target act is now
           summarised like every other act) and opens the call part; rule 4
           says "this act" instead of the act's number. */
        expect(minus(before, now).sort()).toEqual(
          [`Act ${i + 1} (THIS IS THE ACT YOU ARE DEEPENING — full detail below): "${a.title}"`, `   act ${i + 1} does not re-explain what an earlier act already established.`].sort()
        );
        expect(minus(now, before).sort()).toEqual(
          [
            `Act ${i + 1}: "${a.title}" — thesis: ${a.thesis} — start: ${a.startState} — end: ${a.endState}`,
            `THIS IS THE ACT YOU ARE DEEPENING: Act ${i + 1}, "${a.title}" — full detail below.`,
            "   this act does not re-explain what an earlier act already established."
          ].sort()
        );
      });
  });
});

/* ------------------------------------------------------------------------
 * LEGACY PROMPTS, FROZEN: the pre-GV-32 builders copied verbatim from
 * AnthropicPromptUnderstander.ts, AnthropicSpineBuilder.ts,
 * AnthropicDeepenActBuilder.ts and AnthropicContinuityBuilder.ts at
 * origin/main c7cd8925 (renamed legacy*), so the line-set tests above compare
 * against the words the pipeline sent before the reorder. Never edit them to
 * make a test pass: a changed instruction line is a prompt change, not a
 * reorder, and belongs in its own card.
 * ---------------------------------------------------------------------- */
function legacyBuildClarityPrompt(prompt: string): string {
  return [
    "A user has asked for an AI-generated audio documentary (a \"Foray\") on this prompt:",
    "",
    `"${prompt}"`,
    "",
    "Decide if this prompt is GENUINELY ambiguous — meaning it names something with two or",
    "more substantially different plausible subjects (e.g. \"Mercury\" could mean the planet,",
    "the element, or the Roman god). Do NOT flag a prompt as ambiguous just because it is broad",
    "or could be narrowed — \"Roman siege weapons\" is NOT ambiguous even though it covers many",
    "devices, because there is one clear subject. The bar is high: only flag it when a wrong",
    "guess would produce a genuinely different Foray.",
    "",
    "If ambiguous, give exactly 2-3 concrete readings (do not include an \"or something else\"",
    "option in `readings` — that is appended separately) and a single one-sentence question",
    "offering those readings.",
    "",
    "Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:",
    '{"ambiguous": boolean, "readings": string[], "question": string|null}'
  ].join("\n");
}

function legacyBuildIntentPrompt(prompt: string): string {
  return [
    "A user asked for an AI-generated audio documentary (a \"Foray\") on this prompt:",
    "",
    `"${prompt}"`,
    "",
    "Produce a structured understanding of the request with exactly these six fields:",
    "- subject: the concrete subject of the Foray, as a short noun phrase of at most 8 words —",
    "  NOT a restatement of the prompt",
    "- angle: the specific angle or thesis worth taking, not just the topic",
    "- priorKnowledge: what the listener probably already knows about this",
    "- disappointment: what would make this Foray a disappointment to the listener — this is",
    "  the most important field; be concrete, not generic",
    "- title: the Foray's public title, at most 10 words, in SENTENCE CASE: capitalise the first word, proper",
    "  nouns and acronyms, and nothing else (\"How AI actually gets built\", \"How Earth got plate tectonics and",
    "  Venus never did\" — not \"How AI Actually Gets Built\"). No closing period; a closing ? or ! is fine.",
    "- summary: one plain sentence of at most 16 words that a listener sees under the title —",
    "  what they will come away knowing, not a list of subtopics",
    "  Neither the title nor the summary may count or number the Foray's parts (\"eight beats\", \"22 segments\",",
    "  \"three acts\", \"Act one\", \"this act\", \"the running order\"): those are our production words, not a",
    "  listener's. A machine checks that after you answer.",
    "",
    "Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:",
    '{"subject": string, "angle": string, "priorKnowledge": string, "disappointment": string, ' +
      '"title": string, "summary": string}'
  ].join("\n");
}

function legacyTapeWindowLines(researchShape: ResearchShape): string[] {
  const lines: string[] = [];
  for (const subtopic of researchShape.subtopics) {
    if (subtopic.tapeWindows.length === 0) continue;
    lines.push(`  ${subtopic.label} — what the tape says:`);
    for (const w of subtopic.tapeWindows) {
      lines.push(`    [${w.episodeId} ${Math.round(w.startSec)}-${Math.round(w.endSec)}s] ${w.showTitle} — ${w.episodeTitle}`);
      lines.push(`      "${w.text}"`);
    }
  }
  return lines;
}

/**
 * THE HALF OF THE SIGNAL THAT SAYS WHETHER THE TAPE FITS (#703).
 *
 * The line this replaces read "tape: strong, 304 items", and a reader — human
 * or Opus — takes that as a statement about this Foray. It is not. Both numbers
 * come from `queryTapeAvailability`, which counts items in
 * `data/discover.json` carrying the concept; neither has looked at a
 * transcript. On 2026-09-14 "Medicine — tape: strong, 304 items" sat above five
 * clips about Lyme disease, injection moulding and toothpaste packaging, and
 * the number of episodes in the searchable corpus that actually said anything
 * about germ theory was zero. A confidence figure that cannot tell "lots of
 * relevant tape" from "lots of tape, none relevant" is worse than no figure.
 *
 * So the prompt now says both, and says which is which: `catalogue` is breadth
 * (how much of this KIND of thing exists at all) and `tape found` is fit (how
 * many episodes on this machine say this subtopic's own words, and how many of
 * them are quoted below). `tape found: none` under `catalogue: strong` is the
 * exact sentence the germ-theory map should have printed.
 */
function legacyTapeFitPhrase(subtopic: ResearchShape["subtopics"][number]): string {
  if (subtopic.tapeEpisodesMatched === undefined) return "tape found: not measured";
  if (subtopic.tapeEpisodesMatched === 0) return "tape found: none";
  return `tape found: ${subtopic.tapeEpisodesMatched} episode(s), ${subtopic.tapeWindows.length} quoted below`;
}

function legacyBuildSpinePrompt(intent: IntentUnderstanding, researchShape: ResearchShape, duration: DurationTier): string {
  const budget = DURATION_SHAPE_BUDGETS[duration];
  const subtopicLines = researchShape.subtopics
    .map(
      (s) =>
        `- ${s.label} (${s.source}, catalogue: ${s.tape.signal}, ${s.tape.itemCount} items; ${legacyTapeFitPhrase(s)}${
          s.controversies.length > 0 ? `; controversies: ${s.controversies.join("; ")}` : ""
        }${
          // §4.2's external research is only invoked for a genuine catalogue
          // gap and is the most expensive collaborator in that stage — its
          // findings must actually reach this prompt, or the paid call has
          // no effect on the Foray's shape and the gap subtopic gets
          // invented from its bare label alone.
          s.externallyResearched && s.externalNotes ? `; external research: ${s.externalNotes}` : ""
        })`
    )
    .join("\n");

  const windowLines = legacyTapeWindowLines(researchShape);
  /* ONE RULE, ADDED ONLY WHEN THERE IS TAPE TO OBEY IT WITH. A subject the
     archive is silent on keeps exactly today's prompt — §4.2's guardrail again:
     tape is a signal, never a filter. */
  /* AND WHICH EPISODES THE SEEDS IN ONE SLOT MAY COME FROM (F-70). A Foray may
     not draw more than a quarter of its segments from one episode (M4) and may
     not play one episode's tape backwards (M3), and run 2 attempt 4b broke both
     at once: two seeded beats in one slot named the SAME *Practical AI*
     episode, the later beat quoting the earlier stretch of it. The mechanical
     guarantee is `sourceBeats.ts`'s ledger, which now refuses the second window
     in either case — this paragraph exists so the spine stops asking for tape
     that will be refused, and spreads its seeds instead. Guidance, not a gate:
     a subject whose tape lives in one episode still gets a spine. */
  /* AND THE FLOOR IS A FLOOR, NOT THE ASK (G-25; tape-yield brief §5 R4). On
     the run-2 checkpoint the unseeded search admitted 0 of 14 beats at every
     floor value and the seeded path admitted 10 of 14: the seed is the only
     path that yields, so a Foray's tape count is bounded by how many beats the
     spine chose to seed. WS-L asked for two per act and the spine wrote
     fourteen seeds for thirty-two beats. It is now asked to seed every ACCOUNT
     beat a quoted window can carry, and told what an account beat is in the
     same words `types/spine.ts`'s `BeatKind` uses, so that the beats it leaves
     unseeded are the ones no recording could carry — arguments, which
     narration is for — and not simply the ones past the floor.
     AND THE M4 CAP IS STATED IN NUMBERS (R3; `spineSeeding.ts`). "A quarter"
     was already here; what it means at seeding time — one seed per episode
     until the spine carries eight — was not, and the run-2 spine seeded two
     episodes twice with fourteen seeds and lost an on-claim window to it. */
  const seedRule =
    windowLines.length === 0
      ? []
      : [
          "",
          `Every act must carry at least ${SPINE_MIN_SEEDED_BEATS_PER_ACT} beats whose claim states something one of the quoted`,
          "windows above actually says. Each of those beats carries \"seed\": {\"episodeId\": ..., \"startSec\": ...,",
          "\"endSec\": ...} copied from the bracketed window it was written from. Beats written from anything else",
          "omit \"seed\".",
          "",
          "That floor is a minimum, not a target: SEED EVERY ACCOUNT BEAT A WINDOW CAN CARRY. An account beat",
          "states an event, a practice, a measurement or a mechanism a person could be heard describing —",
          "whenever one of the quoted windows says it, write the claim from that window's own words and seed",
          "it. Only an argument beat — a claim about what something MEANS or what someone SHOULD do, which no",
          "recording of an event carries — stays unseeded and is narrated; so does a beat no quoted window",
          "actually says. Never seed a claim its window does not say: every seed is checked against the tape's",
          "own words downstream, and a claim the window does not carry is narrated anyway, with the seed wasted.",
          "",
          "Spread the seeds across EPISODES: across the WHOLE spine, seeded beats must name DIFFERENT episodeIds",
          "wherever the windows above allow it — no episode can supply more than a quarter of the finished",
          `Foray's tape. Concretely: seed each episodeId ONCE until the whole spine carries at least ${SPINE_SEED_REPEAT_MIN}`,
          "seeded beats; a second seed from an episode already seeded is admitted only after that, and a third",
          `only once the spine carries ${SPINE_SEED_THIRD_MIN}. A repeat seeded before then is refused downstream and its beat`,
          "narrated — take another episode's window instead. Each window above is listed once (no episode is quoted",
          "under two subtopics), so a repeat seed names the SAME window again with a sentence of it not yet",
          "used. If the spine really must seed two beats from the SAME",
          "episode, put them in the order the tape says them: the beat seeded from the earlier startSec comes first."
        ];

  return [
    `Build the SPINE for an audio documentary ("Foray") on: "${intent.subject}".`,
    `Angle: ${intent.angle}`,
    `What the listener probably already knows: ${intent.priorKnowledge}`,
    `This Foray disappoints if: ${intent.disappointment}`,
    "",
    "Research map (candidate subtopics found so far):",
    subtopicLines,
    ...windowLines,
    ...seedRule,
    "",
    `Duration tier: ${duration}. Target exactly, within a small tolerance: ${budget.acts[0]}-${budget.acts[1]} acts, ` +
      `${budget.slots[0]}-${budget.slots[1]} slots total, ${budget.items[0]}-${budget.items[1]} beats total.`,
    "",
    "For EACH act, give: title, thesis, startState (what the listener believes entering), endState",
    "(what they believe leaving), and slots (each with a title and an ordered list of beats).",
    "",
    "Every slot title is printed for the listener under the Foray. Write it as a heading in plain words, and",
    "never count or point at the Foray's structure in it: no \"this act\", \"the last act\", \"Act one\",",
    "\"three beats\", \"22 segments\" or \"running order\" — the listener cannot see a running order. A machine",
    "checks that after you answer.",
    "",
    "Every beat MUST be a CLAIM, not a topic. Example: \"Charcoal briquettes were a Ford Motor",
    "Company waste-disposal scheme\" is a beat; \"Briquettes\" is not.",
    "",
    "Mark at least 30% of ALL beats (across the whole spine) with exploration: true — beats that go",
    "somewhere the prompt didn't literally ask for but a curious listener would want. Do not just",
    "sprinkle a token few; hit the floor for real.",
    "",
    "Decide the VOICE once for the whole spine (style, register, sentenceRhythm, narratorPresence) —",
    "it applies to every act; do not vary it per act.",
    "",
    "Write the OVERVIEW: three or four sentences the listener hears before anything else, telling them",
    "what this Foray covers. It is spoken aloud, so write it to be heard — no list, no colon-and-bullets,",
    "no \"first we... then we...\". Say what the Foray is about and what makes it worth an hour, the way",
    "you would tell a friend before pressing play. NEVER say how many acts or parts there are, never say",
    "\"this Foray has\", and never mention acts, beats or segments at all: the listener cannot see a",
    "running order and does not need one. A machine checks that after you answer.",
    `The overview is SPOKEN. ${NARRATOR_STRUCTURE_RULE}`,
    "",
    "Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:",
    '{"overview": string, "voice": {"style": string, "register": string, "sentenceRhythm": string, "narratorPresence": string}, ' +
      '"acts": [{"title": string, "thesis": string, "startState": string, "endState": string, ' +
      '"slots": [{"title": string, "beats": [{"claim": string, "exploration": boolean, ' +
      '"seed"?: {"episodeId": string, "startSec": number, "endSec": number}}]}]}]}'
  ].join("\n");
}

function legacyBuildDeepenActPrompt(spine: Spine, targetAct: Act, targetActIndex: number): string {
  const otherActsSummary = spine.acts
    .map((act, i) =>
      i === targetActIndex
        ? `Act ${i + 1} (THIS IS THE ACT YOU ARE DEEPENING — full detail below): "${act.title}"`
        : `Act ${i + 1}: "${act.title}" — thesis: ${act.thesis} — start: ${act.startState} — end: ${act.endState}`
    )
    .join("\n");

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

  return [
    `You are deepening ONE act of a full spine for an audio documentary ("Foray") on: "${spine.subject}".`,
    `Angle: ${spine.angle}`,
    `Voice (decided once for the whole spine — do not vary it): style: ${spine.voice.style}; register: ${spine.voice.register}; ` +
      `sentence rhythm: ${spine.voice.sentenceRhythm}; narrator presence: ${spine.voice.narratorPresence}`,
    "",
    "FULL SPINE (all acts, for context — you own only the target act):",
    otherActsSummary,
    "",
    `TARGET ACT (Act ${targetActIndex + 1} of ${spine.acts.length}): "${targetAct.title}"`,
    `Thesis: ${targetAct.thesis}`,
    `Start state: ${targetAct.startState}`,
    `End state: ${targetAct.endState}`,
    "Slots and beats to refine:",
    targetSlotLines,
    "",
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
    `   act ${targetActIndex + 1} does not re-explain what an earlier act already established.`,
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
}

function legacyBuildSmoothPrompt(request: ContinuitySmoothRequest): string {
  return [
    `You are the continuity editor for an audio documentary ("Foray"), working ONLY at the seam between two acts.`,
    `The act that just played, "${request.previousActTitle}", ended with this exit line (already played — DO NOT rewrite it, it is given for context only):`,
    `"""${request.previousActExit}"""`,
    ``,
    `The next act, "${request.nextActTitle}", currently opens with this introduction (NOT yet played — this is the ONLY text you may change):`,
    `"""${request.nextActIntroduction}"""`,
    ``,
    `Rewrite the next act's introduction so it genuinely connects to how the previous act ended — a real callback or handoff, not mere concatenation.`,
    `Keep it a real introduction to "${request.nextActTitle}" — do not drop its own content, only smooth the seam into it.`,
    `Never mention or restate the previous act's exit text verbatim; reference it naturally.`,
    NARRATOR_STRUCTURE_RULE,
    ``,
    `Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:`,
    '{"nextIntroduction": string}'
  ].join("\n");
}
