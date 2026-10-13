import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { JsonlSeamParser, WRITTEN_SEAM_JSON_SCHEMA, type SeamLineEvent } from "../src/generation/seamStream";
import { RawWrittenSeamLineSchema } from "../src/generation/replySchemas";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { collectActStream, type ActWriteRequest, type WriterStreamEvent, type WrittenSeam } from "../src/generation/NarrationWriterBuilder";
import type { EvidenceDoc } from "../src/generation/gatherEvidence";
import type { CostEventInput } from "../src/cost/costEvents";
import type { Voice } from "../src/types/spine";

/**
 * GV-43 (docs/roadmap/generation-v2.md, W4-09; covers R1-06, R2-08): the
 * streamed writer contract. A streamed act reply is JSONL, one seam per line
 * in listening order; JsonlSeamParser yields each seam as its line closes,
 * survives any chunk boundary, turns a malformed line into a 'bad-line'
 * event and a reply cut at the token cap into one 'unfinished' event; the
 * stub writer streams its writeAct seams on an injected clock and
 * collectActStream drains a stream back into writeAct's result.
 *
 * Pure and offline: hand-built reply text and the Stub writer, no provider.
 *
 * MUTATIONS RUN against this suite (each turned it red, then reverted), named
 * again in the test that kills it:
 *   1. seamStream.ts push: `while` -> `if` (one line per chunk at most).
 *   2. seamStream.ts push: the unterminated tail parsed as a line on every
 *      push (no wait for '\n').
 *   3. seamStream.ts readLine: the opening-fence skip removed.
 *   4. seamStream.ts parseSeamLine: validate with RawWrittenSeamSchema
 *      (hints optional) instead of the line schema.
 *   5. seamStream.ts end(): the remainder parsed as a seam line instead of
 *      reported 'unfinished'.
 *   6. seamStream.ts parseSeamLine: JSON.parse unguarded (throws on a bad
 *      line).
 *   7. replySchemas.ts: RawWrittenSeamLineSchema = RawWrittenSeamSchema
 *      (pronunciationHints left optional).
 *   8. StubNarrationWriterBuilder.writeActStream: the per-seam sleep removed.
 *   9. StubNarrationWriterBuilder.writeActStream: seams yielded reversed.
 *  10. NarrationWriterBuilder.collectActStream: no throw when the stream
 *      ends without 'end'.
 */

/* ---------- fixtures ---------- */

const voice: Voice = { style: "well-read friend", register: "conversational", sentenceRhythm: "varied", narratorPresence: "medium" };

const NBS: EvidenceDoc = {
  docId: "print:nbs-143",
  kind: "print",
  title: "National Bureau of Standards, Building Science Series 143 (1982)",
  url: "https://nvlpubs.nist.gov/nistpubs/Legacy/BSS/nbsbuildingscience143.pdf",
  retrievedAt: "2026-09-09T00:00:00.000Z",
  text:
    "The box beam-hanger rod connections were not checked for adequacy at any stage of the design. " +
    "The as-built connection could support about sixty percent of the load required by the Kansas City Building Code."
};

/** Three seams; the stub writes a non-empty script for each. */
const writeRequest: ActWriteRequest = {
  actTitle: "The connection nobody checked",
  voice,
  seams: [
    { seamId: "s0", beats: [{ beatId: "b0", claim: "The hanger-rod connection was never checked during design.", mode: "Patch", kind: "account" }], band: [200, 600] },
    { seamId: "s1", beats: [{ beatId: "b1", claim: "As built, it held about sixty percent of the code load.", mode: "Patch", kind: "account" }], band: [200, 600] },
    { seamId: "s2", beats: [{ beatId: "b2", claim: "The Kansas City Building Code set the load the walkway had to carry.", mode: "Patch", kind: "account" }], band: [200, 600] }
  ],
  clips: [],
  documents: [NBS]
};

const SEAMS: WrittenSeam[] = [
  {
    seamId: "s0",
    script: "Nobody checked the hanger-rod connection.\nNot once, at any stage.",
    claims: [{ claimText: "The connection was never checked.", quote: "The box beam-hanger rod connections were not checked", docId: "print:nbs-143", contested: false }],
    usedClaims: [0],
    pronunciationHints: []
  },
  {
    seamId: "s1",
    script: "Sixty percent — café-grade arithmetic, “not even close”. 🏗",
    claims: [],
    usedClaims: [],
    pronunciationHints: [{ word: "Hyatt", hint: "HIGH-at" }]
  },
  {
    seamId: "s2",
    script: "The code said what the walkway had to carry. Quotes \"inside\" and a backslash \\ too.",
    claims: [],
    usedClaims: [],
    pronunciationHints: []
  }
];

const jsonl = (seams: unknown[]): string => seams.map((s) => JSON.stringify(s)).join("\n") + "\n";

/** A seam line with no pronunciationHints field at all. */
function withoutHints(seam: WrittenSeam): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...seam };
  delete copy.pronunciationHints;
  return copy;
}

const seamsOf = (events: SeamLineEvent[]): WrittenSeam[] => events.flatMap((e) => (e.type === "seam" ? [e.seam] : []));

/** Feeds `text` to a fresh parser in chunks cut at `cuts`, then ends it. */
function parseInChunks(text: string, cuts: number[]): SeamLineEvent[] {
  const parser = new JsonlSeamParser();
  const events: SeamLineEvent[] = [];
  let from = 0;
  for (const cut of [...new Set(cuts)].sort((a, b) => a - b)) {
    if (cut <= from || cut >= text.length) continue;
    events.push(...parser.push(text.slice(from, cut)));
    from = cut;
  }
  events.push(...parser.push(text.slice(from)));
  events.push(...parser.end());
  return events;
}

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

function recordingGuard() {
  const checks: CostEventInput[] = [];
  return { checks, guard: { checkAndRecord: async (input: CostEventInput) => void checks.push(input) } as never };
}

/* ---------- the parser ---------- */

describe("JsonlSeamParser: one seam per line, in order, whatever the chunking", () => {
  it("a whole reply pushed at once yields every seam in order and end() adds nothing", () => {
    /* MUTATION THAT KILLS THIS: push's `while` -> `if` (mutation 1): only
       the first closed line of a chunk is read, so one push of three lines
       yields one seam. */
    const parser = new JsonlSeamParser();
    const events = parser.push(jsonl(SEAMS));
    expect(events).toEqual(SEAMS.map((seam) => ({ type: "seam", seam })));
    expect(parser.end()).toEqual([]);
  });

  it("the fixture reply split at every single boundary, and at a grid of boundary pairs, yields the same three seams", () => {
    /* MUTATION THAT KILLS THIS: parse the unterminated tail on every push
       (mutation 2): a chunk ending mid-line becomes a bad-line event and
       the seam it held is lost. */
    const text = jsonl(SEAMS);
    const want = JSON.stringify(SEAMS.map((seam) => ({ type: "seam", seam })));
    const failing: string[] = [];
    for (let i = 1; i < text.length; i++) {
      if (JSON.stringify(parseInChunks(text, [i])) !== want) failing.push(`${i}`);
      if (i % 11 !== 0) continue;
      for (let j = i + 1; j < text.length; j += 13) {
        if (JSON.stringify(parseInChunks(text, [i, j])) !== want) failing.push(`${i},${j}`);
      }
    }
    expect(failing).toEqual([]);
  });

  it("property: N arbitrary seam lines split at arbitrary boundaries always yield the same N seams in order", () => {
    /* MUTATION THAT KILLS THIS: mutation 2 again, on generated replies whose
       strings carry quotes, backslashes, newlines and astral characters. */
    const claimArb = fc.record({ claimText: fc.string(), quote: fc.string(), docId: fc.string(), contested: fc.boolean() });
    const seamArb: fc.Arbitrary<WrittenSeam> = fc.record({
      seamId: fc.string({ minLength: 1, maxLength: 6 }),
      script: fc.string({ unit: "grapheme", maxLength: 80 }),
      claims: fc.array(claimArb, { maxLength: 3 }),
      usedClaims: fc.array(fc.integer({ min: 0, max: 9 }), { maxLength: 3 }),
      pronunciationHints: fc.array(fc.record({ word: fc.string(), hint: fc.string() }), { maxLength: 2 })
    });
    fc.assert(
      fc.property(fc.array(seamArb, { minLength: 1, maxLength: 6 }), fc.array(fc.nat(), { maxLength: 12 }), (seams, rawCuts) => {
        const text = jsonl(seams);
        const events = parseInChunks(
          text,
          rawCuts.map((c) => c % text.length)
        );
        expect(events).toEqual(seams.map((seam) => ({ type: "seam", seam })));
      }),
      { numRuns: 200 }
    );
  });

  it("escaped newlines, unicode escapes, a leading ```json fence, a closing fence and blank or CRLF lines are all handled", () => {
    /* MUTATION THAT KILLS THIS: drop the opening-fence skip (mutation 3):
       the "```json" line becomes a bad-line event. */
    const escaped = '{"seamId":"s9","script":"line one\\nline two \\u00e9\\u2014\\ud83c\\udfd7","claims":[],"usedClaims":[],"pronunciationHints":[]}';
    const text = "```json\r\n\r\n" + escaped + "\r\n\n" + JSON.stringify(SEAMS[0]) + "\n```\n";
    const events = parseInChunks(text, [3, 9, 40]);
    expect(events).toEqual([
      { type: "seam", seam: { seamId: "s9", script: "line one\nline two é—🏗", claims: [], usedClaims: [], pronunciationHints: [] } },
      { type: "seam", seam: SEAMS[0] }
    ]);
    /* A bare ``` fence opens too, and an unterminated closing fence at the
       end is the fence, not an unfinished seam. */
    expect(parseInChunks("```\n" + jsonl([SEAMS[1]]) + "```", [])).toEqual([{ type: "seam", seam: SEAMS[1] }]);
  });

  it("a malformed line becomes a bad-line event and every later line still parses; a line missing pronunciationHints is not a seam", () => {
    /* MUTATIONS THAT KILL THIS: validate with RawWrittenSeamSchema
       (mutation 4) -- the hint-less line passes as a seam; JSON.parse
       unguarded (mutation 6) -- the broken line throws out of push. */
    const hintless = withoutHints(SEAMS[1]!);
    const text = [JSON.stringify(SEAMS[0]), '{"seamId":"s1","script":"cut', JSON.stringify(hintless), JSON.stringify(SEAMS[2])].join("\n") + "\n";
    const events = parseInChunks(text, [10, 120]);
    expect(events.map((e) => e.type)).toEqual(["seam", "bad-line", "bad-line", "seam"]);
    expect(seamsOf(events)).toEqual([SEAMS[0], SEAMS[2]]);
    const [, broken, invalid] = events;
    expect(broken).toMatchObject({ type: "bad-line", line: '{"seamId":"s1","script":"cut' });
    expect((broken as { error: string }).error).toMatch(/^invalid JSON/);
    expect((invalid as { error: string }).error).toMatch(/^not a seam line: pronunciationHints/);
  });

  it("a reply cut mid-line yields every completed seam plus one 'unfinished' event, never a seam, and never throws", () => {
    /* MUTATION THAT KILLS THIS: end() parses the remainder as a seam line
       (mutation 5): the last cut below leaves a line that is valid JSON
       (the script string closes at a sentence end), and it would pass as
       a seam the model never finished. */
    const full = jsonl(SEAMS);
    const lastStart = full.lastIndexOf("\n", full.length - 2) + 1;
    const lastLine = full.slice(lastStart, full.length - 1);
    for (let cut = lastStart + 1; cut <= lastStart + lastLine.length; cut++) {
      const text = full.slice(0, cut);
      let events: SeamLineEvent[] = [];
      expect(() => (events = parseInChunks(text, [Math.floor(cut / 2)]))).not.toThrow();
      expect(seamsOf(events)).toEqual(SEAMS.slice(0, 2));
      expect(events.at(-1)).toEqual({ type: "unfinished", partial: text.slice(lastStart) });
      expect(events.filter((e) => e.type === "unfinished")).toHaveLength(1);
    }
    /* The whole last line without its newline is still unfinished: end()
       never guesses. */
    const noNewline = full.slice(0, -1);
    expect(parseInChunks(noNewline, []).at(-1)).toEqual({ type: "unfinished", partial: lastLine });
  });
});

/* ---------- the line schema ---------- */

describe("RawWrittenSeamLineSchema and WRITTEN_SEAM_JSON_SCHEMA", () => {
  it("every field of a seam line is required, pronunciationHints included, and the JSON Schema is zodToJsonSchema's", () => {
    /* MUTATION THAT KILLS THIS: RawWrittenSeamLineSchema = RawWrittenSeamSchema
       (mutation 7): `required` lacks pronunciationHints and a hint-less line
       parses. */
    expect(WRITTEN_SEAM_JSON_SCHEMA.type).toBe("object");
    expect([...(WRITTEN_SEAM_JSON_SCHEMA.required ?? [])].sort()).toEqual(["claims", "pronunciationHints", "script", "seamId", "usedClaims"]);
    expect(WRITTEN_SEAM_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(WRITTEN_SEAM_JSON_SCHEMA.properties?.pronunciationHints).toEqual({
      type: "array",
      items: { type: "object", properties: { word: { type: "string" }, hint: { type: "string" } }, required: ["word", "hint"], additionalProperties: false }
    });
    expect(WRITTEN_SEAM_JSON_SCHEMA.properties?.claims?.items?.required).toEqual(["claimText", "quote", "docId", "contested"]);
    for (const seam of SEAMS) expect(RawWrittenSeamLineSchema.parse(seam)).toEqual(seam);
    const hintless = withoutHints(SEAMS[0]!);
    expect(RawWrittenSeamLineSchema.safeParse(hintless).success).toBe(false);
  });
});

/* ---------- the stub stream and collectActStream ---------- */

describe("StubNarrationWriterBuilder.writeActStream and collectActStream", () => {
  it("the stub streams its writeAct seams in request order, one per configured delay on the fake clock, then one clean 'end'", async () => {
    /* MUTATIONS THAT KILL THIS: the per-seam sleep removed (mutation 8) --
       every atMs is 0; the seams yielded reversed (mutation 9) -- the ids
       come back s2, s1, s0. */
    const clock = fakeClock();
    const writer = new StubNarrationWriterBuilder(recordingGuard().guard, { seamDelayMs: 250, now: clock.now, sleep: clock.sleep });
    const events: WriterStreamEvent[] = [];
    for await (const event of writer.writeActStream(writeRequest, { userId: "founder-1" })) events.push(event);
    expect(events.map((e) => (e.type === "seam" ? `${e.seam.seamId}@${e.atMs}` : `end:${e.stopReason}`))).toEqual(["s0@250", "s1@500", "s2@750", "end:end"]);
    expect(events.at(-1)).toEqual({ type: "end", stopReason: "end", unfinishedSeamIds: [] });
    const written = await new StubNarrationWriterBuilder(recordingGuard().guard).writeAct(writeRequest, { userId: "founder-1" });
    expect(events.flatMap((e) => (e.type === "seam" ? [e.seam] : []))).toEqual(written.seams);
  });

  it("collectActStream of the stub's stream equals its writeAct result, and the stream is metered once like writeAct", async () => {
    /* MUTATION THAT KILLS THIS: collectActStream returns without checking
       for the 'end' event (mutation 10): the truncated stream below
       resolves instead of rejecting. */
    const streamed = recordingGuard();
    const plain = recordingGuard();
    const collected = await collectActStream(new StubNarrationWriterBuilder(streamed.guard).writeActStream(writeRequest, { userId: "founder-1", sessionId: "sess-1" }));
    const written = await new StubNarrationWriterBuilder(plain.guard).writeAct(writeRequest, { userId: "founder-1", sessionId: "sess-1" });
    expect(collected).toEqual({ ...written, stopReason: "end", unfinishedSeamIds: [] });
    expect(streamed.checks).toEqual(plain.checks);
    expect(streamed.checks).toHaveLength(1);

    async function* truncated(): AsyncGenerator<WriterStreamEvent> {
      yield { type: "seam", seam: SEAMS[0]!, atMs: 5 };
    }
    await expect(collectActStream(truncated())).rejects.toThrow(/without an 'end' event/);
    async function* afterEnd(): AsyncGenerator<WriterStreamEvent> {
      yield { type: "end", stopReason: "length", unfinishedSeamIds: ["s1"] };
      yield { type: "seam", seam: SEAMS[1]!, atMs: 9 };
    }
    await expect(collectActStream(afterEnd())).rejects.toThrow(/after its 'end' event/);
    async function* cut(): AsyncGenerator<WriterStreamEvent> {
      yield { type: "seam", seam: SEAMS[0]!, atMs: 5 };
      yield { type: "end", stopReason: "length", unfinishedSeamIds: ["s1", "s2"], usage: { promptTokens: 900, outputTokens: 512 } };
    }
    expect(await collectActStream(cut())).toEqual({ seams: [SEAMS[0]], stopReason: "length", unfinishedSeamIds: ["s1", "s2"] });
  });
});
