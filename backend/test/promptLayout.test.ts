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
import { ChatNarrationWriterBuilder } from "../src/generation/chat/ChatNarrationWriterBuilder";
import { ChatNarrationVerifierBuilder } from "../src/generation/chat/ChatNarrationVerifierBuilder";
import { actWritePromptParts } from "../src/generation/prompts/actWrite";
import { actVerifyPromptParts } from "../src/generation/prompts/actVerify";
import type { ActFrame, ActWriteRequest, ClipBrief, SeamBrief } from "../src/generation/NarrationWriterBuilder";
import type { ActSourceBrief, ActVerifyRequest, VerifyClipBrief } from "../src/generation/NarrationVerifierBuilder";
import type { EvidenceDoc } from "../src/generation/gatherEvidence";
import { MIN_QUOTE_WORDS } from "../src/types/narration";
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
 * GV-50 (W4-11 + W2-14): the act writer's and verifier's prompts as
 * [stable][foray][call] (prompts/actWrite.ts, prompts/actVerify.ts).
 * ---------------------------------------------------------------------- */

const actVoice = { style: "plain", register: "a well-read friend", sentenceRhythm: "short, then long", narratorPresence: "light" };
const actFrameFixture: ActFrame = {
  actIntroduction: "Now the walkway itself.",
  actExit: "Which leaves the question of who signed off.",
  previousActExit: "That was the design. Then came the build.",
  startState: "knows the hotel opened in a hurry",
  endState: "sees the connection that failed",
  actIndex: 1,
  totalActs: 3
};
const actClips: ClipBrief[] = [
  {
    clipId: "c0",
    segmentId: "seg-a",
    itemId: "item-a",
    show: "Engineering Disasters",
    title: "The Hyatt collapse",
    docId: "tape:seg-a",
    opening: "So the first thing to understand is the drawings.",
    durationSec: 120.4,
    intro: "full",
    carries: [
      { beatId: "b1", claim: "A guest explains the rod change." },
      { beatId: "b2", claim: "And why nobody caught it." }
    ]
  },
  { clipId: "c1", segmentId: "seg-b", itemId: "item-b", show: "Engineering Disasters", title: "After", opening: "", durationSec: 60, intro: "light", showFirstHeard: false }
];
const actDocs: EvidenceDoc[] = [
  { docId: "d0", kind: "print", title: "NBS report", url: "https://example.org/nbs", text: "The connection as built carried double the load.\nIt failed at the fourth floor." },
  { docId: "tape:seg-a", kind: "tape", title: "Engineering Disasters — The Hyatt collapse", text: "So the first thing to understand is the drawings." },
  { docId: "page:a0-s0-b0", kind: "page", title: "This Foray, page a0-s0-b0", text: "The hotel opened in 1980." }
];
const actSeams = (retry: boolean): SeamBrief[] => [
  {
    seamId: "s0",
    beats: [
      { beatId: "b0", claim: "The hotel opened in a hurry.", mode: "Patch", kind: "account", seedLost: true },
      { beatId: "b3", claim: "Speed mattered more than review.", mode: "Patch", kind: "argument" }
    ],
    introduces: "c0",
    intro: "full",
    band: [200, 600],
    ...(retry ? { previousScript: "The hotel opened fast.", notes: "the prose does not carry beat b3" } : {})
  },
  { seamId: "s1", beats: [], follows: "c0", introduces: "c1", intro: "light", band: [30, 260], ...(retry ? { previousScript: "Same voice.", frozen: true } : {}) }
];
/** Unframed, act 1's frame and act 0's frame (with the overview), each on round 1 and on a retry. */
function actWriteRequests(): ActWriteRequest[] {
  const out: ActWriteRequest[] = [];
  for (const frame of [undefined, actFrameFixture, { ...actFrameFixture, actIndex: 0, previousActExit: undefined, forayOverview: "Why a walkway fell." }])
    for (const retry of [false, true])
      out.push({
        actTitle: frame ? "The walkway" : "Act 1",
        voice: actVoice,
        seams: actSeams(retry),
        clips: actClips,
        documents: actDocs,
        ...(retry ? { retryNote: "Attempt 1 was rejected for: the prose does not carry beat b3." } : {}),
        ...(frame ? { frame } : {})
      });
  return out;
}
const actSources: ActSourceBrief[] = [
  { id: "k0", kind: "claim", claimText: "who speaks", quote: "the drawings", publication: "Engineering Disasters", contested: false, selectedBy: "s0", docId: "tape:seg-a" },
  { id: "k1", kind: "claim", claimText: "double the load", quote: "carried double the load", publication: "NBS report", contested: true, selectedBy: "s0", docId: "d0" },
  { id: "k2", kind: "claim", claimText: "opened in 1980", quote: "The hotel opened in 1980.", publication: "This Foray, page a0-s0-b0", contested: false, docId: "page:a0-s0-b0" },
  { id: "c0", kind: "clip", claimText: "what is said in clip c0", publication: "Engineering Disasters", contested: false, docId: "tape:seg-a" },
  { id: "p0", kind: "page", claimText: "The hotel opened in 1980.", publication: "This Foray, page a0-s0-b0", contested: false, docId: "page:a0-s0-b0" }
];
/** A round with s0 to judge and one with s0 frozen, each with beats on the checklist and with none. */
function actVerifyRequests(): ActVerifyRequest[] {
  const clips: VerifyClipBrief[] = actClips.map((c, i) => ({ ...c, windowText: i === 0 ? "So the first thing to understand is the drawings." : "" }));
  const out: ActVerifyRequest[] = [];
  for (const frozen of [false, true])
    for (const beats of [actSeams(false)[0]!.beats, []])
      out.push({
        actTitle: frozen ? "The walkway" : "Act 1",
        voice: actVoice,
        beats,
        seams: [
          { seamId: "s0", script: "The hotel opened fast.\nThen the party.", selected: ["k0", "k1"], carries: ["b0"], introduces: "c0", intro: "full", ...(frozen ? { frozen: true } : {}) },
          { seamId: "s1", script: "Same voice.", selected: [], carries: [], follows: "c0", introduces: "c1", intro: "light" }
        ],
        clips,
        sources: actSources,
        documents: actDocs
      });
  return out;
}

describe("GV-50: the act prompts are a content-preserving reorder (every pre-GV-50 instruction line is still sent)", () => {
  it("the writer sends the legacy lines except the role line, which lost the act title to the call part", () => {
    /* MUTATION THAT KILLS THIS: delete the "A SEAM is one stretch of
       narration..." line from the call part. Ran it: red. Second: drop the
       "Also list any hard-to-pronounce..." line from writeStable. Ran it: red. */
    for (const request of actWriteRequests()) {
      const now = lineSet(joinParts(actWritePromptParts(request)));
      const before = lineSet(legacyBuildActWritePrompt(request));
      expect(minus(before, now)).toEqual([
        `You are writing the narration of one act ("${request.actTitle}") of an audio documentary ("Foray") — the whole act at once, as one voice telling one story.`
      ]);
      expect(minus(now, before).sort()).toEqual(
        [
          `You are writing the narration of one act of an audio documentary ("Foray") — the whole act at once, as one voice telling one story.`,
          `THE ACT YOU ARE WRITING: "${request.actTitle}"`
        ].sort()
      );
    }
  });

  it("the verifier sends the legacy lines except the role line, the seams-to-judge header and the word 'above', each rewritten on purpose and listed here", () => {
    /* MUTATION THAT KILLS THIS: drop the `SEAMS TO JUDGE: ...` line from the
       verifier's call part (the judged ids then reach the model nowhere).
       Ran it: red. Second: delete "Do NOT check whether a quote exists..."
       from VERIFY_STABLE. Ran it: red. */
    for (const request of actVerifyRequests()) {
      const judged = request.seams.filter((s) => !s.frozen).map((s) => s.seamId).join(", ") || "none";
      const now = lineSet(joinParts(actVerifyPromptParts(request)));
      const before = lineSet(legacyBuildActVerifyPrompt(request));
      expect(minus(before, now).sort()).toEqual(
        [
          `You are the FACT-VERIFICATION pass for the narration of one act ("${request.actTitle}") of an audio documentary ("Foray"). You did NOT write it.`,
          `2. For each SEAM to judge (${judged}; the FROZEN seams are confirmed already — do not answer for them):`,
          "   claimsSupported — does every statement the script makes about the world follow from SOME act source above — this seam's selected claims,"
        ].sort()
      );
      expect(minus(now, before).sort()).toEqual(
        [
          `You are the FACT-VERIFICATION pass for the narration of one act of an audio documentary ("Foray"). You did NOT write it.`,
          `THE ACT YOU ARE VERIFYING: "${request.actTitle}"`,
          "2. For each SEAM to judge (named on the SEAMS TO JUDGE line below; the FROZEN seams are confirmed already — do not answer for them):",
          "   claimsSupported — does every statement the script makes about the world follow from SOME act source below — this seam's selected claims,",
          `SEAMS TO JUDGE: ${judged}`
        ].sort()
      );
    }
  });
});

describe("GV-50: the Chat writer and verifier send [system: stable, user: foray + call]", () => {
  const target: StructuredTarget = { providerName: "local:spark", model: "local-heavy", structuredOutput: "json_schema", usdPerMtokIn: 0, usdPerMtokOut: 0 };
  const guard = { checkAndRecord: async () => undefined };
  const writeReply = '{"seams": [{"seamId": "s0", "script": "The hotel opened fast.", "claims": [], "usedClaims": []}, {"seamId": "s1", "script": "", "claims": [], "usedClaims": []}]}';
  const verifyReply = '{"beats": [], "seams": []}';

  it("every act and round opens with the same system message, and the messages are toChatMessages of the parts", async () => {
    /* MUTATION THAT KILLS THIS: in ChatNarrationWriterBuilder.writeAct, send
       `[{ role: "user", content: buildActWritePrompt(request) }]` (the
       pre-GV-50 single turn) instead of toChatMessages(actWritePromptParts).
       Ran it: red. Second: the same in ChatNarrationVerifierBuilder. Ran it: red. */
    const ctx = { userId: "u1", sessionId: "s1-2026-10-13-walkway" };
    const writes = actWriteRequests();
    const writerProvider = scriptedProvider({ complete: writes.map(() => writeReply) });
    const writer = new ChatNarrationWriterBuilder(writerProvider, target, guard);
    for (const r of writes) await writer.writeAct(r, ctx);
    const verifies = actVerifyRequests();
    const verifierProvider = scriptedProvider({ complete: verifies.map(() => verifyReply) });
    const verifier = new ChatNarrationVerifierBuilder(verifierProvider, target, guard);
    for (const r of verifies) await verifier.verifyAct(r, ctx);

    expect(writerProvider.requests).toHaveLength(writes.length);
    expect(verifierProvider.requests).toHaveLength(verifies.length);
    writerProvider.requests.forEach((req, i) => expect(req.messages).toEqual(toChatMessages(actWritePromptParts(writes[i]!))));
    verifierProvider.requests.forEach((req, i) => expect(req.messages).toEqual(toChatMessages(actVerifyPromptParts(verifies[i]!))));
    for (const provider of [writerProvider, verifierProvider]) {
      expect(new Set(provider.requests.map((r) => r.messages[0]!.content)).size).toBe(1);
      for (const req of provider.requests) {
        expect(req.messages.map((m) => m.role)).toEqual(["system", "user"]);
        for (const m of req.messages) {
          expect(m.content).not.toMatch(ISO_TIMESTAMP_RE);
          expect(m.content).not.toContain(ctx.sessionId);
        }
      }
    }
  });

  it("a JSON re-ask keeps the writer's prefix: the re-ask opens with the first call's exact [system, user]", async () => {
    /* MUTATION THAT KILLS THIS: in ChatNarrationWriterBuilder.writeAct, send
       `[{ role: "user", content: buildActWritePrompt(request) }]` — the
       opening is then one user turn, not toChatMessages(parts). Ran it: red. */
    const provider = scriptedProvider({ complete: ["not json", writeReply] });
    await new ChatNarrationWriterBuilder(provider, target, guard).writeAct(actWriteRequests()[1]!, { userId: "u1" });
    const [first, reask] = provider.requests;
    expect(first!.messages).toEqual(toChatMessages(actWritePromptParts(actWriteRequests()[1]!)));
    expect(reask!.messages.slice(0, 2)).toEqual(first!.messages);
    expect(reask!.messages.length).toBeGreaterThan(2);
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

/* ------------------------------------------------------------------------
 * GV-50's LEGACY ACT PROMPTS, FROZEN: the pre-GV-50 buildActWritePrompt
 * (with actFrameBlock, actLayout and their rule lists) and
 * buildActVerifyPrompt (with actSourceEntry and actVerifyLayout), copied
 * from AnthropicNarrationWriterBuilder.ts and
 * AnthropicNarrationVerifierBuilder.ts at origin/main f6e129e9 (renamed
 * legacy*, code comments dropped), so the GV-50 line-set tests above compare
 * against the words the pipeline sent before the reorder. Never edit them to
 * make a test pass.
 * ---------------------------------------------------------------------- */
const LEGACY_JSON_ONLY = "Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:";
const LEGACY_CLAIM_SHAPE = '{"claimText": string, "quote": string, "docId": string, "contested": boolean}';

function legacyVoiceLine(request: { voice: ActWriteRequest["voice"] }): string {
  const voice = request.voice;
  return (
    `Voice (decided once for the whole Foray — do not vary it): style: ${voice.style}; register: ${voice.register}; ` +
    `sentence rhythm: ${voice.sentenceRhythm}; narrator presence: ${voice.narratorPresence}`
  );
}

const LEGACY_ACT_CLAIM_RULES = [
  `A quote must be copied character for character out of the document you name, and must be at least ${MIN_QUOTE_WORDS} words or one whole sentence.`,
  "Never quote a beat's claim, a clip's opening as printed in the layout, or this prompt: they are direction, not documents.",
  "A statement about a CLIP — what it is about, who is speaking, what was said in it — rests on that clip's transcript window (its docId is on the CLIP line).",
  "Select it as a claim with that docId and either a short phrase of the clip's own words as the quote or an empty quote (\"\"); the whole window is that source, so the word minimum does not apply to it.",
  "Never back a statement about a clip with an outside publication.",
  "A statement about the world beyond the clips rests on a print document, or on a VERIFIED PAGE of this Foray when one is listed: select the claim and copy the span. If no document supports a claim worth making, do not make it.",
  "THE ACT'S SOURCES ARE ONE SET. Every claim any seam selects, every clip's window and every verified page listed can support a statement in ANY seam: a bridge that restates what the clip before it established, or sets up the clip after it, rests on those windows and need not select a claim of its own. Select each claim ONCE, on the seam that first makes it; the verifier reads the whole act's sources.",
  "If the documents contradict or complicate a beat, write the tension: that carries the beat.",
  '"contested" means reputable sources actively disagree about the fact itself — not that you are unsure.',
  "Every quote is checked by machine against the document you name after you answer; a quote that is not found there is discarded together with the seam's script."
];

const LEGACY_ACT_PROSE_RULES = [
  "One voice, one story. The beats are the checklist the prose must carry, not its template: make each beat's point where it belongs, in your own words, joined to what comes before and after it. A beat may be carried in any seam, and by what a clip itself says.",
  "Never announce a beat, never list the beats, never say what the next clip is going to say.",
  NARRATOR_STRUCTURE_RULE,
  "A seam that follows a clip may restate what that clip said once, in the act's own words — then move on.",
  "Introductions, by the weight given on the SEAM line:",
  "  full  — one or two sentences: who is speaking (name and role, as the tape or the episode title gives them) and on which show, and what to listen for. Write it from the clip's OPENING as printed on its CLIP line — what the listener is about to hear — never from the point the clip goes on to make. Do not repeat the clip's first sentences.",
  "The FIRST clip from a show says the show's name (Q-09) — its CLIP line says when that is: \"first clip from this show\". Say it however the sentence wants it; there is no formula, and the same sentence twice in one Foray is worse than not saying it at all. When the line says the show has already been introduced, do NOT name it again: refer back lightly (\"back with the same guest\", \"the engineer from earlier\") or say nothing about the show at all.",
  "  light — the same guest and show as the clip before: one clause at most, or nothing.",
  "  none  — the host introduces the guest in the clip itself: add nothing about who is speaking.",
  "A seam with no beats and a light or none introduction may return an empty script: the clips then run together.",
  "A beat marked SEED LOST was written from a stretch of tape this Foray does NOT play and no document was found for: carry it only as far as the act's sources go. Never attribute a specific incident, number or quotation to anyone that beat's claim names — say what the sources DO say, or turn the beat into a question and hand off.",
  "One CLIP can carry more than one beat: when its line says it carries several, the tape makes those points itself — introduce it once and do not narrate what it is about to say.",
  "Each seam's script MUST land inside the character band on its SEAM line. Longer is not better: narration is at most a quarter of the listening.",
  "List, per seam, the indices of the claims its script asserts (usedClaims).",
  "NEVER assert what the record does or does not contain — no \"nobody wrote it down\", \"there is no record of\", \"the file doesn't say\", \"we still don't know\" — unless a quote you selected says exactly that. Say what a source DOES say instead: not \"the plan nobody wrote down\" but \"the plan that lived in people's heads, as he tells it\"; not \"the report never explains why\" but \"the report names the drawing, and stops there\" (only if it does), or leave the point out.",
  "",
  "Copy rules, unchanged and non-negotiable:",
  "- Never say: fascinating, deep dive, delve, explores.",
  "- No vulgar or gratuitously edgy content; register is a well-read friend, not a shock jock.",
  "- Never speak a URL, a citation, or a number a listener cannot hold in their head while driving.",
  "- If a claim is marked contested, the script must say the point is disputed."
];

function legacyBuildActWritePrompt(request: ActWriteRequest): string {
  const clips = new Map(request.clips.map((c) => [c.clipId, c]));
  return [
    `You are writing the narration of one act ("${request.actTitle}") of an audio documentary ("Foray") — the whole act at once, as one voice telling one story.`,
    legacyVoiceLine(request),
    "",
    "THE ACT, IN PLAY ORDER. Narration and clips alternate. You write the narration; the clips are real tape and play as they are.",
    "A SEAM is one stretch of narration: it carries the beats listed under it, bridges from the clip before to the clip after, and — when it introduces a clip — opens the listener's ear to it.",
    "",
    ...(request.frame ? legacyActFrameBlock(request.frame) : []),
    legacyActLayout(request.seams, clips),
    "",
    "HOW TO WRITE",
    ...LEGACY_ACT_PROSE_RULES,
    "",
    "CLAIMS AND QUOTES",
    ...LEGACY_ACT_CLAIM_RULES,
    "",
    "DOCUMENTS — the only things you may quote:",
    request.documents
      .map(
        (doc) =>
          `--- docId: ${doc.docId} | ${doc.title}${doc.url ? ` | ${doc.url}` : ""}${doc.kind === "tape" ? " | TRANSCRIPT WINDOW of a clip (cite it for statements about that clip)" : doc.kind === "page" ? " | a VERIFIED PAGE of this same Foray, from an earlier act — quote one of its whole sentences" : ""}\n${doc.text}`
      )
      .join("\n\n"),
    "",
    ...(request.retryNote
      ? [
          `REJECTIONS SO FAR: ${request.retryNote}`,
          "Seams marked FROZEN are verified: return each one's script VERBATIM and select no claims for it. Seams marked EDIT carry their previous script and a `fix` line:",
          "EDIT only those, to answer their notes — add a missed beat where it belongs, drop or re-source an unsupported sentence, replace an assertion about the record with what a source says — and keep every sentence that was not objected to.",
          ""
        ]
      : []),
    "Also list any hard-to-pronounce or foreign words with a plain-English pronunciation hint.",
    "",
    LEGACY_JSON_ONLY,
    `{"seams": [{"seamId": string, "script": string, "claims": [${LEGACY_CLAIM_SHAPE}], "usedClaims": [number], "pronunciationHints": [{"word": string, "hint": string}]}]}`
  ].join("\n");
}

function legacyActFrameBlock(frame: ActFrame): string[] {
  return [
    `ACT FRAME — this is act ${frame.actIndex + 1} of ${frame.totalActs}. The lines quoted here are already written and play around your seams as they are; they are not yours to write.`,
    "WHAT THE LISTENER HAS JUST HEARD, in order:",
    ...(frame.forayOverview !== undefined ? [`  the Foray's overview: ${JSON.stringify(frame.forayOverview)}`] : []),
    ...(frame.previousActExit !== undefined ? [`  the previous act's exit: ${JSON.stringify(frame.previousActExit)}`] : []),
    `  this act's introduction: ${JSON.stringify(frame.actIntroduction)}`,
    `  entering this act, the listener believes: ${frame.startState}`,
    "WHERE THE ACT MUST LEAVE THEM:",
    `  leaving this act, the listener should believe: ${frame.endState}`,
    `  the act's exit, which plays right after your last seam: ${JSON.stringify(frame.actExit)}`,
    "FRAME RULES:",
    "- Do not repeat the introduction or the exit, or restate what they say.",
    "- The first seam follows the introduction: pick up where it leaves off, without opening the act again.",
    "- The last seam hands into the exit: end where the exit can take over.",
    ...(frame.previousActExit !== undefined ? ["- Do not re-introduce what the previous act established; the listener has just heard it."] : []),
    ""
  ];
}

function legacyActLayout(seams: SeamBrief[], clips: Map<string, ClipBrief>): string {
  const lines: string[] = [];
  for (const seam of seams) {
    const edges: string[] = [];
    if (seam.follows) edges.push(`follows CLIP ${seam.follows}`);
    if (seam.introduces) edges.push(`introduces CLIP ${seam.introduces} (introduction: ${seam.intro ?? "full"})`);
    lines.push(`SEAM ${seam.seamId} — ${seam.band[0]}-${seam.band[1]} characters${edges.length > 0 ? ` — ${edges.join(", ")}` : ""}${seam.frozen ? " — FROZEN" : seam.previousScript !== undefined ? " — EDIT" : ""}`);
    if (seam.beats.length === 0) lines.push("  carries no beat — the introduction only, or nothing");
    for (const beat of seam.beats) {
      lines.push(`  carries beat ${beat.beatId}${beat.kind === "argument" ? " (an argument — what it means)" : ""}: ${beat.claim}`);
      if (beat.seedLost) {
        lines.push(
          `    SEED LOST — beat ${beat.beatId}'s tape was not available: do not attribute specifics to anyone this claim names; say only what the act's sources say, or hand off.`
        );
      }
    }
    if (seam.frozen && seam.previousScript !== undefined) {
      lines.push(`  FROZEN — verified; return this script verbatim, with no claims: ${JSON.stringify(seam.previousScript)}`);
    } else if (seam.previousScript !== undefined) {
      lines.push(`  previous script: ${JSON.stringify(seam.previousScript)}`);
      if (seam.notes) lines.push(`  fix: ${seam.notes}`);
    }
    if (seam.introduces) {
      const clip = clips.get(seam.introduces);
      if (clip) {
        const carried = clip.carries ?? [];
        lines.push(
          `CLIP ${clip.clipId} — "${clip.title}" on ${clip.show || "an unnamed show"}, ${Math.round(clip.durationSec)} s of tape` +
            (clip.docId ? ` (document ${clip.docId})` : " (no transcript window is held)") +
            (carried.length > 1 ? ` — carries beats ${carried.map((b) => b.beatId).join(", ")}` : "") +
            (clip.show
              ? clip.showFirstHeard === false
                ? ` — ${clip.show} has already been introduced in this Foray: do not name it again`
                : " — FIRST CLIP FROM THIS SHOW: say its name"
              : "")
        );
        if (carried.length > 1) for (const beat of carried) lines.push(`  it carries beat ${beat.beatId}: ${beat.claim}`);
        lines.push(clip.opening ? `  it opens: ${JSON.stringify(clip.opening)}` : "  its opening is not held — introduce it from the show and episode only");
      }
    }
  }
  return lines.join("\n");
}

function legacyBuildActVerifyPrompt(request: ActVerifyRequest): string {
  const clips = new Map(request.clips.map((c) => [c.clipId, c]));
  const judged = request.seams.filter((s) => !s.frozen).map((s) => s.seamId);
  return [
    `You are the FACT-VERIFICATION pass for the narration of one act ("${request.actTitle}") of an audio documentary ("Foray"). You did NOT write it.`,
    "",
    "THE CHECKLIST — the beats to judge this round (each must be carried somewhere in the act):",
    ...(request.beats.length > 0
      ? request.beats.flatMap((b) =>
          b.seedLost
            ? [
                `  ${b.beatId}: ${b.claim}`,
                `    SEED LOST — the tape this claim was written from is NOT in this act and nothing was retrieved for it. Judge it carried when the prose makes as much of its point as the act's sources support; do NOT demand the names, numbers or incidents that only the missing tape could supply. If the act's sources do not reach the point at all, say exactly that in notes.`
              ]
            : [`  ${b.beatId}: ${b.claim}`]
        )
      : ["  (none — every beat is already confirmed)"]),
    "",
    "THE ACT'S SOURCES — one set for the whole act. Any statement in any seam may rest on any of these, not only the ones the seam selected:",
    ...request.sources.map(legacyActSourceEntry),
    "",
    "THE ACT, IN PLAY ORDER — narration seams and the clips of real tape between them:",
    legacyActVerifyLayout(request, clips),
    "",
    "Answer two sets of questions.",
    "1. For each BEAT on the checklist: carried — does the act's narration (any seam, frozen ones included, not only the one the beat was positioned in)",
    "   or one of its clips make the beat's point, resting on an act source (a selected claim, a clip's window, a verified page)? A beat is carried when",
    "   a listener would hear its point made, in whatever words. It is NOT carried when no seam or clip makes the point, or a seam makes it and nothing",
    "   in the act's sources supports it. When carried, say by which seam or clip (carriedBy: \"s1\" or \"c0\") and on which sources it rests (restsOn).",
    "   When not carried, say in notes which seam it belongs in and what is missing, in one sentence a writer can act on.",
    `2. For each SEAM to judge (${judged.join(", ") || "none"}; the FROZEN seams are confirmed already — do not answer for them):`,
    "   claimsSupported — does every statement the script makes about the world follow from SOME act source above — this seam's selected claims,",
    "   another seam's, any clip's transcript window, any verified page? A bridge that restates what the clip before it established, or sets up",
    "   the clip after it, is supported by those windows. Judge a statement about a clip against that clip's window as printed on its CLIP line.",
    "   Then list in restsOn the ids of the sources the seam's statements actually rest on — required whenever claimsSupported is true and the",
    "   script states anything; a seam that only asks a question or hands off to the listener rests on nothing and lists none.",
    "   When a statement is NOT supported, QUOTE the sentence in notes, and say what no source covers.",
    "   EXEMPT from this question: the sentences that introduce a clip — who is speaking, the show, the episode — which are checked by",
    "   structure against the segment's source row before you are called. Do not fail a seam for them.",
    "   contestedHandled — read the sources: if reputable sources actively disagree about something the script asserts, the script must",
    "   say the point is disputed, in any natural wording. If nothing is genuinely contested, this is true.",
    "",
    "Do NOT check whether a quote exists in its source — that was already proven mechanically before you were called.",
    "",
    "DOCUMENTS the claims quote:",
    request.documents.filter((d) => d.kind !== "tape").map((d) => `  --- ${d.title}${d.url ? ` | ${d.url}` : ""}\n${d.text}`).join("\n") || "  (none — every source is a clip's window)",
    "",
    "Respond with ONLY a single JSON object, no markdown fences, no other text, matching exactly:",
    '{"beats": [{"beatId": string, "carried": boolean, "carriedBy": string (the seam or clip id, when carried), "restsOn": string[] (source ids, when carried), "notes": string (required and specific whenever carried is false)}], ' +
      '"seams": [{"seamId": string, "claimsSupported": boolean, "restsOn": string[], "contestedHandled": boolean, "notes": string (required whenever an answer is false; quote the unsupported sentence)}]}'
  ].join("\n");
}

function legacyActSourceEntry(s: ActSourceBrief): string {
  const contested = s.contested ? " [marked contested]" : "";
  if (s.kind === "clip") return `  ${s.id}: the transcript window of CLIP ${s.docId === s.id ? s.id : s.id} — ${s.claimText} (printed under the clip below)`;
  if (s.kind === "page") return `  ${s.id}: a VERIFIED PAGE of this Foray from an earlier act — "${s.claimText}" (${s.publication})`;
  const from = s.selectedBy ? ` (selected by seam ${s.selectedBy})` : "";
  if (s.publication.startsWith("This Foray, page")) return `  ${s.id}${from}: claim="${s.claimText}" quote="${s.quote ?? ""}" from a verified page — ${s.publication}${contested}`;
  if (s.docId.startsWith("tape:")) return `  ${s.id}${from} [TAPE]: claim="${s.claimText}"${s.quote ? ` echoes="${s.quote}"` : ""} — judge against the window of the clip it names (${s.publication})${contested}`;
  return `  ${s.id}${from}: claim="${s.claimText}" quote="${s.quote ?? ""}" publication="${s.publication}"${contested}`;
}

function legacyActVerifyLayout(request: ActVerifyRequest, clips: Map<string, VerifyClipBrief>): string {
  const lines: string[] = [];
  for (const seam of request.seams) {
    const edges: string[] = [];
    if (seam.follows) edges.push(`follows CLIP ${seam.follows}`);
    if (seam.introduces) edges.push(`introduces CLIP ${seam.introduces} (introduction: ${seam.intro ?? "full"})`);
    lines.push(
      `SEAM ${seam.seamId}${seam.frozen ? " — FROZEN (confirmed in an earlier round; context only)" : ""}${seam.carries.length > 0 ? ` — positioned beats ${seam.carries.join(", ")}` : " — no beat positioned here"}${edges.length > 0 ? ` — ${edges.join(", ")}` : ""}`
    );
    lines.push(`  Script:\n${seam.script}`);
    lines.push(`  Selected sources: ${seam.selected.length > 0 ? seam.selected.join(", ") : "(none — it may rest on the act's other sources)"}`);
    if (seam.introduces) {
      const clip = clips.get(seam.introduces);
      if (clip) {
        const carried = clip.carries ?? [];
        lines.push(
          `CLIP ${clip.clipId} — "${clip.title}" on ${clip.show || "an unnamed show"}, ${Math.round(clip.durationSec)} s of tape${clip.docId ? ` (${clip.docId})` : ""}` +
            (carried.length > 1 ? ` — carries beats ${carried.map((b) => b.beatId).join(", ")}, judged against this one window` : "")
        );
        if (carried.length > 1) for (const beat of carried) lines.push(`  it carries beat ${beat.beatId}: ${beat.claim}`);
        lines.push(`  Transcript window:\n${clip.windowText || "    (the window is not held — treat any statement about this clip as unsupported)"}`);
      }
    }
  }
  return lines.join("\n");
}
