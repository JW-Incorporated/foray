import { describe, it, expect } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";
import { execFileSync } from "node:child_process";
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

describe("writeNarration — HTML entities in writer output are decoded (F-26)", () => {
  it("decodes &amp;/&quot;/&#39; in script and every source field (the real 'Simon &amp; Schuster' case)", async () => {
    const rawScript =
      "Simon &amp; Schuster published the collection, and the editor said &quot;yes&quot; right away " +
      "— it&#39;s a true story about a slow, careful decision." +
      " The publisher spent years building a catalog of accessible nonfiction, one careful title at a time, and this was simply the next entry on a long, patient list." +
      " The publisher spent years building a catalog of accessible nonfiction, one careful title at a time, and this was simply the next entry on a long, patient list.";
    const entityWriter: NarrationWriterBuilder = {
      providerName: "entity-writer",
      async writePage(): Promise<NarrationWriteResult> {
        return {
          script: rawScript,
          sources: [
            {
              claimText: "Simon &amp; Schuster published the book.",
              quote: "Simon &amp; Schuster acquired the rights.",
              publication: "Simon &amp; Schuster Press",
              contested: false
            }
          ],
          pronunciationHints: []
        };
      }
    };
    const alwaysVerifies: NarrationVerifierBuilder = {
      providerName: "always-verify",
      async verifyPage(): Promise<NarrationVerifyResult> {
        return { verified: true };
      }
    };
    const acts: SourcedAct[] = [
      { title: "Act", slots: [{ title: "Slot", beats: [{ sourcing: "narration", claim: "A claim about publishing.", exploration: false, narration: { mode: "Patch", reason: "test" } }] }] }
    ];

    const written = await writeNarration(acts, { writer: entityWriter, verifier: alwaysVerifies }, voice, ctx);
    const page = allWrittenNarration(written)[0]!;

    expect(page.script).toContain("Simon & Schuster");
    expect(page.script).not.toMatch(/&(amp|quot|#39);/);
    expect(page.sources[0]!.claimText).toBe("Simon & Schuster published the book.");
    expect(page.sources[0]!.quote).toBe("Simon & Schuster acquired the rights.");
    expect(page.sources[0]!.publication).toBe("Simon & Schuster Press");
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

  it("round-trips through check-forays.mjs's own DISCLOSURE_RX", () => {
    // check-forays.mjs is loaded by dynamic import, and Vitest re-resolves
    // that import through its own vite-node loader — which mishandles a
    // space in the checkout path (this repo lives under "Vibe Coding"),
    // producing "Invalid or unexpected token" whether the specifier is
    // relative, an absolute path, or a pathToFileURL'd file:// URL, with or
    // without a `/* @vite-ignore */` hint (see the `finalize` seam comment
    // in runPipeline.ts for the fuller account of the same defect). A plain
    // Node subprocess started outside vite-node does not have that problem,
    // so do the ESM import and the checkForays() call there instead.
    //
    // DISCLOSURE_RX itself is not exported, so exercise it the way the real
    // validator does: build a minimal generated foray whose items[0] is this
    // stage's disclosure beat, and confirm checkForays raises no
    // disclosure-related error for it.
    const checkForaysUrl = pathToFileURL(resolvePath(__dirname, "../../tools/foray/check-forays.mjs")).href;
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
    const input = { forays: { forays: [foray] }, segments: { segments: [] }, sources: { sources: [] }, taxonomy: {} };
    const script =
      `import(${JSON.stringify(checkForaysUrl)}).then((mod) => {` +
      `process.stdout.write(JSON.stringify(mod.checkForays(${JSON.stringify(input)})));` +
      `});`;
    const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    const result = JSON.parse(stdout) as { errors: string[] };
    expect(result.errors.some((e: string) => e.toLowerCase().includes("disclosure"))).toBe(false);
  });

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

describe("writeNarration — generation run 1 (2026-09-09) regressions", () => {
  function scriptedWriter(pages: NarrationWriteResult[]): NarrationWriterBuilder & { calls: number; notes: Array<string | undefined> } {
    const w = {
      providerName: "scripted",
      calls: 0,
      notes: [] as Array<string | undefined>,
      async writePage(req: NarrationWriteRequest): Promise<NarrationWriteResult> {
        w.notes.push(req.contextNote);
        const page = pages[Math.min(w.calls, pages.length - 1)]!;
        w.calls++;
        return page;
      }
    };
    return w;
  }
  const okSource: Source = { claimText: "one welded joint carried both walkways", quote: "one welded joint carried both walkways", publication: "National Bureau of Standards, Building Science Series 143 (1982)", contested: false };
  const framePage = (publication: string): NarrationWriteResult => ({
    script: "One welded joint now carried both walkways' weight. Neither firm checked whether it could hold that load.",
    sources: [{ ...okSource, publication }],
    pronunciationHints: []
  });

  it("rejects a publication that is a tape item id and tells the writer why on the retry", async () => {
    const writer = scriptedWriter([framePage("bfh-griddle-bakestone"), framePage(okSource.publication)]);
    const acts: SourcedAct[] = [
      { title: "Act", slots: [{ title: "Slot", beats: [{ sourcing: "tape", claim: "c", exploration: false, tape: tapePointer("bfh-griddle-bakestone") }] }] }
    ];
    const written = await writeNarration(acts, { writer, verifier: new StubNarrationVerifierBuilder() }, voice, ctx);
    expect(writer.calls).toBe(2);
    expect(writer.notes[1]).toMatch(/is a tape item id, not a publication/);
    expect(allWrittenNarration(written)[0]!.sources[0]!.publication).toBe(okSource.publication);
  });

  it("gives a page three informed attempts, then drops a CONNECTIVE page but keeps the tape beat", async () => {
    const writer = new StubNarrationWriterBuilder();
    let verifyCalls = 0;
    const alwaysRejects: NarrationVerifierBuilder = {
      providerName: "always-reject",
      async verifyPage(): Promise<NarrationVerifyResult> {
        verifyCalls++;
        return { verified: false, verifierNotes: "simulated rejection" };
      }
    };
    const acts: SourcedAct[] = [
      { title: "Act", slots: [{ title: "Slot", beats: [{ sourcing: "tape", claim: "Tape about a discovery.", exploration: false, tape: tapePointer("item-1") }] }] }
    ];
    const written = await writeNarration(acts, { writer, verifier: alwaysRejects }, voice, ctx);
    expect(verifyCalls).toBe(3);
    const beat = written[0]!.slots[0]!.beats[0]!;
    expect(beat.sourcing).toBe("tape");
    expect(beat.sourcing === "tape" && beat.connectiveNarration).toBeFalsy();
    expect(allWrittenNarration(written)).toHaveLength(0);
  });

  it("still fails the Foray when a NARRATION beat's page is rejected three times — its page is the beat's content", async () => {
    const writer = new StubNarrationWriterBuilder();
    let verifyCalls = 0;
    const alwaysRejects: NarrationVerifierBuilder = {
      providerName: "always-reject",
      async verifyPage(): Promise<NarrationVerifyResult> {
        verifyCalls++;
        return { verified: false, verifierNotes: "simulated rejection" };
      }
    };
    const acts: SourcedAct[] = [
      { title: "Act", slots: [{ title: "Slot", beats: [{ sourcing: "narration", claim: "A claim.", exploration: false, narration: { mode: "Patch", reason: "test" } }] }] }
    ];
    await expect(writeNarration(acts, { writer, verifier: alwaysRejects }, voice, ctx)).rejects.toThrow(NarrationWriteError);
    expect(verifyCalls).toBe(3);
  });
});

describe("writeNarration — F-36/F-37: a content page with zero sources is rejected by the validator, not the verifier", () => {
  it("sends the writer an informed retry and never calls the verifier for the empty page", async () => {
    let verifyCalls = 0;
    const verifier: NarrationVerifierBuilder = {
      providerName: "counting",
      async verifyPage(): Promise<NarrationVerifyResult> {
        verifyCalls++;
        return { verified: true, verifierNotes: "" };
      }
    };
    const notes: Array<string | undefined> = [];
    let calls = 0;
    const writer: NarrationWriterBuilder = {
      providerName: "scripted",
      async writePage(req: NarrationWriteRequest): Promise<NarrationWriteResult> {
        notes.push(req.contextNote);
        calls++;
        const pad = (t: string) => `${t} `.repeat(Math.ceil(400 / (t.length + 1))).trim();
        if (calls === 1) return { script: pad("Listen for what breaks the plan, and for who noticed first."), sources: [], pronunciationHints: [] };
        return {
          script: pad("One welded joint now carried both walkways' weight. Neither firm checked whether it could hold that load."),
          sources: [{ claimText: "one welded joint carried both walkways", quote: "one welded joint carried both walkways", publication: "National Bureau of Standards, Building Science Series 143 (1982)", contested: false }],
          pronunciationHints: []
        };
      }
    };
    const acts: SourcedAct[] = [
      { title: "Act", slots: [{ title: "Slot", beats: [{ sourcing: "narration", claim: "c", exploration: false, narration: { mode: "Patch", reason: "test" } }] }] }
    ];
    const written = await writeNarration(acts, { writer, verifier }, voice, ctx);
    expect(calls).toBe(2);
    expect(verifyCalls).toBe(1);
    expect(notes[1]).toMatch(/at least one source/);
    expect(allWrittenNarration(written)).toHaveLength(1);
  });
});

describe("containsContestedLanguage — F-43: natural phrasings count, not only house phrases", () => {
  it.each([
    "How much it choked the channel is something historians still argue over.",
    "Historians still dispute how much the screens mattered.",
    "The point is contested.",
    "Whether that was the cause is an open question.",
    "The record cannot settle which came first."
  ])("accepts: %s", (script) => {
    expect(containsContestedLanguage(script)).toBe(true);
  });
  it("still rejects a script that asserts without hedging", () => {
    expect(containsContestedLanguage("The screens choked the channel and the dam went over the top.")).toBe(false);
  });
});
