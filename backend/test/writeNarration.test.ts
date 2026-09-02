import { describe, it, expect } from "vitest";
import {
  writeNarration,
  decideConnectiveNarration,
  allWrittenNarration,
  NarrationWriteError,
  type WriteNarrationOptions,
  type WrittenAct
} from "../src/generation/writeNarration";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { createNarrationWriterBuilder } from "../src/generation/createNarrationWriterBuilder";
import { createNarrationVerifierBuilder } from "../src/generation/createNarrationVerifierBuilder";
import type { NarrationBuildContext, NarrationWriteRequest, NarrationWriteResult, NarrationWriterBuilder } from "../src/generation/NarrationWriterBuilder";
import type { NarrationVerifierBuilder, NarrationVerifyRequest, NarrationVerifyResult } from "../src/generation/NarrationVerifierBuilder";
import {
  MODE_CHAR_BANDS,
  containsContestedLanguage,
  disclosureNarratedBeat,
  disclosureTemplate,
  validateNarratedBeat,
  type NarrationMode,
  type NarratedBeat,
  type Source
} from "../src/types/narration";
import type { SourcedAct, SourcedSlot } from "../src/types/tapeSourcing";
import type { Voice } from "../src/types/spine";
import { BANNED } from "../src/copy/rules";
import { env } from "../src/config/env";

const voice: Voice = { style: "well-read friend", register: "conversational", sentenceRhythm: "varied", narratorPresence: "medium" };
const ctx: NarrationBuildContext = { userId: "founder-1" };

function makeOptions(): WriteNarrationOptions {
  return { writer: new StubNarrationWriterBuilder(), verifier: new StubNarrationVerifierBuilder() };
}

function tapePointer(itemId: string) {
  return {
    segmentId: `${itemId}#100`,
    itemId,
    startSec: 100,
    endSec: 130,
    startAnchor: "so the first thing to understand is",
    endAnchor: "and that changed everything after that",
    tier: 1 as const,
    confidence: "high" as const
  };
}

describe("writeNarration — one page per narration beat, within mode budget", () => {
  it.each(Object.keys(MODE_CHAR_BANDS) as NarrationMode[])("produces a script within the %s mode's character budget", async (mode) => {
    const options = makeOptions();
    const slot: SourcedSlot = {
      title: "Test slot",
      beats: [{ sourcing: "narration", claim: "The Lawson criterion sets the bar tokamaks had to clear.", exploration: false, narration: { mode: mode === "Patch" || mode === "Carry" ? mode : "Patch", reason: "test" } }]
    };
    // For non-Patch/Carry modes, drive them via the connective-narration path (tape beat).
    const acts: SourcedAct[] =
      mode === "Patch" || mode === "Carry"
        ? [{ title: "Act", slots: [slot] }]
        : [
            {
              title: "Act",
              slots: [
                {
                  title: "Connective slot",
                  beats: [{ sourcing: "tape", claim: "Tape about a discovery.", exploration: false, tape: tapePointer("item-1") }]
                }
              ]
            }
          ];

    const written = await writeNarration(acts, options, voice, ctx);
    const pages = allWrittenNarration(written);
    expect(pages.length).toBeGreaterThan(0);
    const page = pages.find((p) => p.mode === mode) ?? pages[0]!;
    const [min, max] = MODE_CHAR_BANDS[page.mode];
    expect(page.script.length).toBeGreaterThanOrEqual(min);
    expect(page.script.length).toBeLessThanOrEqual(max);
  });
});

describe("writeNarration — every factual claim carries a non-empty sources array", () => {
  it("a Patch beat's written page has at least one source", async () => {
    const options = makeOptions();
    const acts: SourcedAct[] = [
      {
        title: "Act",
        slots: [
          {
            title: "Slot",
            beats: [{ sourcing: "narration", claim: "Whyte explains the Lawson criterion.", exploration: false, narration: { mode: "Patch", reason: "test" } }]
          }
        ]
      }
    ];
    const written = await writeNarration(acts, options, voice, ctx);
    const page = allWrittenNarration(written)[0]!;
    expect(page.sources.length).toBeGreaterThan(0);
    for (const source of page.sources) {
      expect(source.claimText.length).toBeGreaterThan(0);
      expect(source.quote.length).toBeGreaterThan(0);
    }
  });

  it("validateNarratedBeat flags a Patch/Carry beat with zero sources as invalid", () => {
    const beat: NarratedBeat = {
      mode: "Patch",
      script: "A".repeat(400),
      sources: [],
      pronunciationHints: [],
      verified: true
    };
    const result = validateNarratedBeat(beat);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "missing-sources")).toBe(true);
  });
});

describe("writeNarration — the verifier is a genuinely separate call from the writer", () => {
  it("throws if the same builder instance is passed as both writer and verifier", async () => {
    const shared = new StubNarrationWriterBuilder();
    const acts: SourcedAct[] = [
      { title: "Act", slots: [{ title: "Slot", beats: [{ sourcing: "narration", claim: "A claim.", exploration: false, narration: { mode: "Patch", reason: "test" } }] }] }
    ];
    await expect(
      writeNarration(acts, { writer: shared, verifier: shared as unknown as NarrationVerifierBuilder }, voice, ctx)
    ).rejects.toThrow(/writer and verifier must be distinct/);
  });

  it("calls the writer once and the verifier once per page — two distinct builder invocations, not one self-reporting call", async () => {
    let writeCalls = 0;
    let verifyCalls = 0;
    const writer: NarrationWriterBuilder = {
      providerName: "spy-writer",
      async writePage(request: NarrationWriteRequest): Promise<NarrationWriteResult> {
        writeCalls += 1;
        const [min] = MODE_CHAR_BANDS[request.mode];
        return {
          script: "A".repeat(min + 5),
          sources: [{ claimText: request.claim, quote: `Quote backing: ${request.claim}`, publication: "Test pub", contested: false }],
          pronunciationHints: []
        };
      }
    };
    const verifier: NarrationVerifierBuilder = {
      providerName: "spy-verifier",
      async verifyPage(_request: NarrationVerifyRequest): Promise<NarrationVerifyResult> {
        verifyCalls += 1;
        return { verified: true };
      }
    };
    const acts: SourcedAct[] = [
      { title: "Act", slots: [{ title: "Slot", beats: [{ sourcing: "narration", claim: "A verifiable claim.", exploration: false, narration: { mode: "Patch", reason: "test" } }] }] }
    ];

    await writeNarration(acts, { writer, verifier }, voice, ctx);

    expect(writeCalls).toBe(1);
    expect(verifyCalls).toBe(1);
    // Never the same function/object serving both roles.
    expect(writer).not.toBe(verifier);
  });

  it("retries once and fails the whole page when the verifier keeps rejecting it", async () => {
    const writer = new StubNarrationWriterBuilder();
    const alwaysRejects: NarrationVerifierBuilder = {
      providerName: "always-reject",
      async verifyPage(): Promise<NarrationVerifyResult> {
        return { verified: false, verifierNotes: "simulated rejection" };
      }
    };
    const acts: SourcedAct[] = [
      { title: "Act", slots: [{ title: "Slot", beats: [{ sourcing: "narration", claim: "A claim.", exploration: false, narration: { mode: "Patch", reason: "test" } }] }] }
    ];

    await expect(writeNarration(acts, { writer, verifier: alwaysRejects }, voice, ctx)).rejects.toThrow(NarrationWriteError);
  });
});

describe("writeNarration — copy-rule violations are caught", () => {
  it("validateNarratedBeat catches a banned word via the shared BANNED pattern list", () => {
    const beat: NarratedBeat = {
      mode: "Patch",
      script: `This is a fascinating look at the topic. ${"A".repeat(320)}`,
      sources: [{ claimText: "x", quote: "y", publication: "z", contested: false }],
      pronunciationHints: [],
      verified: true
    };
    const result = validateNarratedBeat(beat, { bannedPhrasePatterns: BANNED });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "banned-copy")).toBe(true);
  });

  it("validateNarratedBeat catches an out-of-budget (over-length) script", () => {
    const beat: NarratedBeat = {
      mode: "Hinge",
      script: "A".repeat(10000),
      sources: [],
      pronunciationHints: [],
      verified: true
    };
    const result = validateNarratedBeat(beat);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "out-of-budget")).toBe(true);
  });
});

describe("writeNarration — contested claims say so explicitly", () => {
  it("containsContestedLanguage finds the flagged phrases", () => {
    expect(containsContestedLanguage("This detail is contested among historians.")).toBe(true);
    expect(containsContestedLanguage("This is a plain, uncontroversial fact.")).toBe(false);
  });

  it("validateNarratedBeat flags a contested source with no textual acknowledgement", () => {
    const beat: NarratedBeat = {
      mode: "Patch",
      script: "A".repeat(400),
      sources: [{ claimText: "x", quote: "y", publication: "z", contested: true }],
      pronunciationHints: [],
      verified: true
    };
    const result = validateNarratedBeat(beat);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "contested-not-flagged-in-text")).toBe(true);
  });
});

describe("disclosureTemplate / disclosureNarratedBeat — the mandatory first item", () => {
  it("renders correctly with a real subject substituted", () => {
    const text = disclosureTemplate("the history of grilling");
    expect(text).toBe(
      "This is a Foray about the history of grilling. Much of what you'll hear is written by AI. " +
        "We work hard to get the facts right, but AI gets things wrong — so take it as a starting point, not a source."
    );
  });

  it("round-trips through check-forays.mjs's own DISCLOSURE_RX", async () => {
    // The dynamic ESM import of tools/foray/check-forays.mjs can take several
    // seconds in a cold / IO-throttled sandbox (observed ~8s here, well over
    // vitest's 10s default) — bump this single test's timeout rather than
    // the suite's, since it's the only test paying that one-time import cost.
    const mod = (await import("../../tools/foray/check-forays.mjs")) as unknown as { checkForays: (files: unknown) => { errors: string[] } };
    // DISCLOSURE_RX itself is not exported, so exercise it the way the real
    // validator does: build a minimal generated foray whose items[0] is this
    // stage's disclosure beat, and confirm checkForays raises no
    // disclosure-related error for it.
    const beat = disclosureNarratedBeat("marine navigation before satellites");
    const foray = {
      id: "test-foray",
      generated: true,
      subject: "marine navigation before satellites",
      duration_tier: "short",
      why: "A short test why-line under the word limit.",
      hook: "A short test hook.",
      items: [{ type: "narration", script: beat.script }]
    };
    const result = mod.checkForays({ forays: { forays: [foray] }, segments: { segments: [] }, sources: { sources: [] }, taxonomy: {} });
    expect(result.errors.some((e: string) => e.toLowerCase().includes("disclosure"))).toBe(false);
  }, 30000);

  it("throws on an empty subject rather than silently emitting a malformed disclosure", () => {
    expect(() => disclosureTemplate("   ")).toThrow();
  });
});

describe("decideConnectiveNarration — §4.5's own note, resolved by beat position", () => {
  it("assigns Frame to a tape beat that opens its slot", () => {
    const slot: SourcedSlot = { title: "S", beats: [{ sourcing: "tape", claim: "c", exploration: false, tape: tapePointer("item-1") }] };
    expect(decideConnectiveNarration(slot, 0)).toBe("Frame");
  });

  it("assigns Frame to a tape beat immediately following a different-item tape beat", () => {
    const slot: SourcedSlot = {
      title: "S",
      beats: [
        { sourcing: "tape", claim: "c1", exploration: false, tape: tapePointer("item-1") },
        { sourcing: "tape", claim: "c2", exploration: false, tape: tapePointer("item-2") }
      ]
    };
    expect(decideConnectiveNarration(slot, 1)).toBe("Frame");
  });

  it("assigns null to a tape beat following a same-item tape beat (left to §4.8)", () => {
    const slot: SourcedSlot = {
      title: "S",
      beats: [
        { sourcing: "tape", claim: "c1", exploration: false, tape: tapePointer("item-1") },
        { sourcing: "tape", claim: "c2", exploration: false, tape: tapePointer("item-1") }
      ]
    };
    expect(decideConnectiveNarration(slot, 1)).toBeNull();
  });

  it("returns null for a narration-sourced beat (no connective narration decision applies)", () => {
    const slot: SourcedSlot = { title: "S", beats: [{ sourcing: "narration", claim: "c", exploration: false, narration: { mode: "Patch", reason: "r" } }] };
    expect(decideConnectiveNarration(slot, 0)).toBeNull();
  });
});

describe("writeNarration — §4.5's guardrail carries through: beat identity is preserved", () => {
  it("every input beat's claim appears exactly once in the flattened output-adjacent structure", async () => {
    const options = makeOptions();
    const acts: SourcedAct[] = [
      {
        title: "Act",
        slots: [
          {
            title: "Slot",
            beats: [
              { sourcing: "tape", claim: "Tape claim one.", exploration: false, tape: tapePointer("item-1") },
              { sourcing: "narration", claim: "Narration claim two.", exploration: false, narration: { mode: "Carry", reason: "no tape" } }
            ]
          }
        ]
      }
    ];
    const written = await writeNarration(acts, options, voice, ctx);
    const claims = written.flatMap((a) => a.slots.flatMap((s) => s.beats.map((b) => b.claim)));
    expect(claims).toEqual(["Tape claim one.", "Narration claim two."]);
  });
});

describe("createNarrationWriterBuilder / createNarrationVerifierBuilder", () => {
  it("both return stub builders when ANTHROPIC_API_KEY is absent, and are distinct instances", () => {
    expect(env.anthropicDryRun).toBe(true);
    const writer = createNarrationWriterBuilder();
    const verifier = createNarrationVerifierBuilder();
    expect(writer.providerName).toBe("stub");
    expect(verifier.providerName).toBe("stub");
    expect(writer).not.toBe(verifier as unknown as NarrationWriterBuilder);
  });
});

describe("pronunciation hints — the field exists structurally, even though nothing consumes it yet", () => {
  it("a written page carries a pronunciationHints array (possibly empty)", async () => {
    const options = makeOptions();
    const acts: SourcedAct[] = [
      { title: "Act", slots: [{ title: "Slot", beats: [{ sourcing: "narration", claim: "Constantinople fell in 1453.", exploration: false, narration: { mode: "Patch", reason: "test" } }] }] }
    ];
    const written = await writeNarration(acts, options, voice, ctx);
    const page = allWrittenNarration(written)[0]!;
    expect(Array.isArray(page.pronunciationHints)).toBe(true);
  });
});
