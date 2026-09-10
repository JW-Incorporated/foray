import { describe, it, expect, vi } from "vitest";
import { AnthropicSpineBuilder } from "../src/generation/AnthropicSpineBuilder";
import { BudgetGuard } from "../src/cost/budgetGuard";
import { InMemoryCostEventSink } from "../src/cost/costEvents";
import { makeFakeAnthropicClient, textBlock, toolUseBlock } from "./helpers/fakeAnthropicClient";
import type { IntentUnderstanding } from "../src/types/generation";
import type { ResearchShape } from "../src/types/research";
import { SPINE_MIN_SEEDED_BEATS_PER_ACT } from "../src/types/spine";

/**
 * Error-path + budget-guard-wiring coverage for AnthropicSpineBuilder — see
 * AnthropicEnricher.test.ts for the shared rationale on injected fake
 * clients.
 */
describe("AnthropicSpineBuilder", () => {
  const ctx = { userId: "u1", sessionId: "s1" };
  const intent: IntentUnderstanding = {
    subject: "Charcoal briquettes",
    angle: "an industrial waste-disposal scheme, not a cookout footnote",
    priorKnowledge: "briquettes are used for grilling",
    disappointment: "no mention of the Ford Motor Company connection"
  };
  const researchShape: ResearchShape = {
    subject: intent.subject,
    angle: intent.angle,
    generatedAt: new Date().toISOString(),
    subtopics: [
      {
        label: "Ford waste-disposal origins",
        source: "literal-term",
        tape: { signal: "thin", itemCount: 2, showCount: 1, exampleItemIds: [] },
        controversies: [],
        externalNotes: null,
        externallyResearched: false,
        tapeWindows: [],
        windowsUnavailable: "no transcript text index in this fixture"
      }
    ],
    nonObviousAngle: null,
    externalGapsResearched: []
  };

  const validRawSpine = {
    voice: { style: "s", register: "r", sentenceRhythm: "sr", narratorPresence: "np" },
    acts: [
      {
        title: "Act 1",
        thesis: "thesis",
        startState: "start",
        endState: "end",
        slots: [{ title: "slot", beats: [{ claim: "A claim happened", exploration: false }] }]
      }
    ]
  };

  it("mutation: constructor guard fires even with no client injected (dry-run) — should throw", () => {
    expect(() => new AnthropicSpineBuilder()).toThrow(/AnthropicSpineBuilder constructed without ANTHROPIC_API_KEY/);
  });

  it("does NOT throw the dry-run guard when a client is injected", () => {
    const { client } = makeFakeAnthropicClient([textBlock(JSON.stringify(validRawSpine))]);
    expect(() => new AnthropicSpineBuilder(undefined, client)).not.toThrow();
  });

  it("mutation: delete the checkAndRecord call -> buildSpine calls budgetGuard.checkAndRecord before messages.create", async () => {
    const calls: string[] = [];
    const guard = new BudgetGuard(new InMemoryCostEventSink(), 100);
    vi.spyOn(guard, "checkAndRecord").mockImplementation(async (input) => {
      calls.push("checkAndRecord");
      return { ...input, id: "id", ts: new Date().toISOString() };
    });
    const { client, create } = makeFakeAnthropicClient([]);
    create.mockImplementation(async () => {
      calls.push("messages.create");
      return { content: [textBlock(JSON.stringify(validRawSpine))] };
    });

    const builder = new AnthropicSpineBuilder(guard, client);
    const spine = await builder.buildSpine(intent, researchShape, "short", ctx);

    expect(calls).toEqual(["checkAndRecord", "messages.create"]);
    expect(spine.subject).toBe(intent.subject);
    expect(spine.angle).toBe(intent.angle);
    expect(spine.duration).toBe("short");
    expect(guard.checkAndRecord).toHaveBeenCalledWith(expect.objectContaining({ operation: "spine_build" }));
  });

  it("mutation: return a tool_use-only content array with no text block -> buildSpine should throw", async () => {
    const { client } = makeFakeAnthropicClient([toolUseBlock()]);
    const builder = new AnthropicSpineBuilder(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

    await expect(builder.buildSpine(intent, researchShape, "short", ctx)).rejects.toThrow(
      "Anthropic spine response had no text block"
    );
  });

  it("mutation: return non-JSON LLM output -> buildSpine wraps the parse failure", async () => {
    const { client } = makeFakeAnthropicClient([textBlock("not json")]);
    const builder = new AnthropicSpineBuilder(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

    // The fake client returns the same invalid content on every call, so the
    // one re-ask (see parseWithRetry.ts) also fails and the final error names
    // that.
    await expect(builder.buildSpine(intent, researchShape, "short", ctx)).rejects.toThrow(/failed schema validation after one re-ask/);
  });

  it("mutation: response wrapped in ```json fences -> buildSpine still parses", async () => {
    const { client } = makeFakeAnthropicClient([
      textBlock("```json\n" + JSON.stringify(validRawSpine) + "\n```")
    ]);
    const builder = new AnthropicSpineBuilder(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

    const spine = await builder.buildSpine(intent, researchShape, "short", ctx);
    expect(spine.acts).toHaveLength(1);
    expect(spine.voice.style).toBe("s");
  });

  it("mutation: schema-invalid raw spine (acts missing) -> buildSpine throws", async () => {
    const { client } = makeFakeAnthropicClient([
      textBlock(JSON.stringify({ voice: validRawSpine.voice }))
    ]);
    const builder = new AnthropicSpineBuilder(new BudgetGuard(new InMemoryCostEventSink(), 100), client);

    await expect(builder.buildSpine(intent, researchShape, "short", ctx)).rejects.toThrow();
  });

  it("buildSpine sets generatedAt itself, independent of the LLM's raw output", async () => {
    const { client } = makeFakeAnthropicClient([textBlock(JSON.stringify(validRawSpine))]);
    const builder = new AnthropicSpineBuilder(new BudgetGuard(new InMemoryCostEventSink(), 100), client);
    const before = Date.now();
    const spine = await builder.buildSpine(intent, researchShape, "short", ctx);
    const generatedAtMs = new Date(spine.generatedAt).getTime();
    expect(generatedAtMs).toBeGreaterThanOrEqual(before);
  });
});

/* WS-L (F-63): the prompt is the whole of the finding. Run 2's spine call was
   told "Ai (semantic-concept, tape: strong, 761 items)" and nothing about what
   those items say, three times, and produced 35 beats the archive could not
   carry one of. These cases are about the words that reach the model and the
   field that comes back. */
describe("AnthropicSpineBuilder — WS-L: the spine prompt sees the tape (F-63)", () => {
  const ctx = { userId: "u1", sessionId: "s1" };
  const intent: IntentUnderstanding = {
    subject: "how AI systems get built",
    angle: "the engineering, not the research",
    priorKnowledge: "has heard of machine learning",
    disappointment: "stays at the level of model architectures"
  };
  const windowText = "an audit found thousands of mislabelled validation images across the whole benchmark";
  const shapeWithWindows: ResearchShape = {
    subject: intent.subject,
    angle: intent.angle,
    generatedAt: new Date().toISOString(),
    subtopics: [
      {
        label: "Machine Learning",
        source: "semantic-concept",
        tape: { signal: "strong", itemCount: 761, showCount: 4, exampleItemIds: [] },
        controversies: [],
        externalNotes: null,
        externallyResearched: false,
        tapeWindows: [
          {
            episodeId: "practical-ai--episode-900",
            showTitle: "Practical AI",
            episodeTitle: "Episode 900",
            startSec: 100,
            endSec: 165,
            text: windowText,
            score: 3.2
          }
        ],
        windowsUnavailable: null
      }
    ],
    nonObviousAngle: null,
    externalGapsResearched: []
  };
  const shapeWithout: ResearchShape = {
    ...shapeWithWindows,
    subtopics: shapeWithWindows.subtopics.map((s) => ({ ...s, tapeWindows: [], windowsUnavailable: "no transcript text index" }))
  };
  const rawSpine = {
    voice: { style: "s", register: "r", sentenceRhythm: "sr", narratorPresence: "np" },
    acts: [
      {
        title: "Act 1",
        thesis: "thesis",
        startState: "start",
        endState: "end",
        slots: [
          {
            title: "slot",
            beats: [
              {
                claim: "An audit found thousands of mislabelled validation images",
                exploration: false,
                seed: { episodeId: "practical-ai--episode-900", startSec: 100, endSec: 165 }
              }
            ]
          }
        ]
      }
    ]
  };

  async function promptFor(shape: ResearchShape): Promise<string> {
    const { client, create } = makeFakeAnthropicClient([textBlock(JSON.stringify(rawSpine))]);
    const builder = new AnthropicSpineBuilder(new BudgetGuard(new InMemoryCostEventSink(), 100), client);
    await builder.buildSpine(intent, shape, "short", ctx);
    return String(create.mock.calls[0]![0].messages[0].content);
  }

  it("quotes each subtopic's windows, with the episode and the seconds, and adds exactly one rule", async () => {
    const prompt = await promptFor(shapeWithWindows);
    expect(prompt).toContain("what the tape says");
    expect(prompt).toContain(windowText);
    expect(prompt).toContain("practical-ai--episode-900 100-165s");
    expect(prompt).toContain("Practical AI — Episode 900");
    expect(prompt).toContain(`at least ${SPINE_MIN_SEEDED_BEATS_PER_ACT} beats`);
    expect(prompt).toContain('"seed"');
  });

  it("tells the spine to spread seeds across episodes, and to keep two from one episode in tape order (F-70)", async () => {
    /* Run 2 attempt 4b's spine put two seeded beats of ONE slot on the same
       *Practical AI* episode, the later beat quoting the earlier stretch, and
       the finished Foray failed check-forays on M3 and M4 at once. The
       mechanical guarantee is `sourceBeats.ts`'s ledger — this paragraph stops
       the spine ASKING for tape the ledger will refuse.

       MUTATION THAT KILLS THIS: delete the two lines appended to `seedRule` in
       `AnthropicSpineBuilder.ts`. Ran it — red. */
    const prompt = await promptFor(shapeWithWindows);
    expect(prompt).toContain("DIFFERENT episodeIds");
    expect(prompt).toContain("no episode can supply more than a quarter");
    expect(prompt).toContain("the beat seeded from the earlier startSec comes first");
  });

  it("says none of it when the research map quoted nothing — a subject with no tape keeps today's prompt", async () => {
    const prompt = await promptFor(shapeWithout);
    expect(prompt).not.toContain("what the tape says");
    expect(prompt).not.toContain(`at least ${SPINE_MIN_SEEDED_BEATS_PER_ACT} beats`);
    /* F-70's episode-spreading rule goes with it: it is part of the seed rule,
       and there are no seeds to spread. */
    expect(prompt).not.toContain("DIFFERENT episodeIds");
    /* And the counts are still there: WS-L adds to the map, it does not replace it. */
    expect(prompt).toContain("761 items");
  });

  it("keeps the seed the model returned rather than stripping it at the schema", async () => {
    const { client } = makeFakeAnthropicClient([textBlock(JSON.stringify(rawSpine))]);
    const builder = new AnthropicSpineBuilder(new BudgetGuard(new InMemoryCostEventSink(), 100), client);
    const spine = await builder.buildSpine(intent, shapeWithWindows, "short", ctx);
    expect(spine.acts[0]!.slots[0]!.beats[0]!.seed).toEqual({
      episodeId: "practical-ai--episode-900",
      startSec: 100,
      endSec: 165
    });
  });
});
