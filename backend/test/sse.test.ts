import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import fc from "fast-check";
import { parseSse, type SseChunk } from "../src/generation/chat/sse";

/**
 * GV-40 (docs/roadmap/generation-v2.md, from W2-02): the Server-Sent Events
 * reader under the streaming OpenAI-compatible provider. Pure and offline:
 * the input is the synthetic stream in test/fixtures/openai/ or a literal.
 * Each test names the mutation of src/generation/chat/sse.ts it kills; every
 * one was applied and seen red.
 */

const FIXTURE_DIR = path.join(__dirname, "fixtures", "openai");

/** The fixture as committed with LF line ends (a CRLF checkout is normalised
 * first, so the CRLF and CR variants below are built from known bytes). */
function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8").replace(/\r\n/g, "\n");
}

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

async function* chunks(parts: SseChunk[]): AsyncGenerator<SseChunk> {
  for (const p of parts) yield p;
}

async function collect(parts: SseChunk[], onDone?: () => void): Promise<string[]> {
  const out: string[] = [];
  for await (const data of parseSse(chunks(parts), onDone ? { onDone } : {})) out.push(data);
  return out;
}

/** The bytes cut at the given offsets (sorted, deduplicated, inside the range). */
function splitAt(bytes: Uint8Array, cuts: number[]): Uint8Array[] {
  const points = [...new Set(cuts.filter((c) => c > 0 && c < bytes.length))].sort((a, b) => a - b);
  const out: Uint8Array[] = [];
  let start = 0;
  for (const p of points) {
    out.push(bytes.slice(start, p));
    start = p;
  }
  out.push(bytes.slice(start));
  return out;
}

const oneByteAtATime = (bytes: Uint8Array): Uint8Array[] => Array.from(bytes, (b) => Uint8Array.of(b));

const variants = (lf: string): Record<string, string> => ({
  lf,
  crlf: lf.replace(/\n/g, "\r\n"),
  cr: lf.replace(/\n/g, "\r")
});

describe("parseSse: chunk boundaries never change the events", () => {
  /* Kills: decoding each chunk without {stream: true} (the 'é' and '—' of the
     fixture split across bytes turn into U+FFFD one byte at a time). */
  it("the JSONL fixture yields the same 8 events in one chunk and one byte at a time, under LF, CRLF and CR", async () => {
    for (const [name, text] of Object.entries(variants(fixture("stream-jsonl.txt")))) {
      const bytes = encode(text);
      const whole = await collect([bytes]);
      expect(whole, name).toHaveLength(8);
      expect(whole.every((d) => d.startsWith("{"))).toBe(true);
      expect(whole.join("")).toContain("café");
      expect(whole.join("")).toContain("—");
      expect(await collect(oneByteAtATime(bytes)), name).toEqual(whole);
    }
  });

  /* Kills: forgetting that a chunk ending in CR may be the first half of a
     CRLF (the LF opening the next chunk then reads as a blank line and
     dispatches a multi-line event early, as two events). */
  it("fast-check: random split points over the fixtures and a multi-line CRLF event give identical events", async () => {
    const multi = "event: x\r\ndata: first\r\ndata: second\r\nid: 7\r\n\r\ndata: third\r\n\r\n";
    const inputs = [
      ...Object.values(variants(fixture("stream-jsonl.txt"))),
      ...Object.values(variants(fixture("stream-length.txt"))),
      multi
    ].map(encode);
    const expected = await Promise.all(inputs.map((b) => collect([b])));
    expect(expected[expected.length - 1]).toEqual(["first\nsecond", "third"]);
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: inputs.length - 1 }), fc.array(fc.nat(), { maxLength: 40 }), async (which, rawCuts) => {
        const bytes = inputs[which]!;
        const cuts = rawCuts.map((c) => c % (bytes.length + 1));
        expect(await collect(splitAt(bytes, cuts))).toEqual(expected[which]);
      }),
      { numRuns: 200 }
    );
  });
});

describe("parseSse: the event-stream rules", () => {
  /* Kills: reading fields other than data (event, id, retry), or stripping
     more than one leading space. */
  it("ignores ':' comments and other fields, joins multi-line data with \\n, and strips exactly one leading space", async () => {
    const text = [": keep-alive", "event: message", "id: 3", "retry: 100", "data:  two spaces", "data:none", "data", "", ""].join("\n");
    expect(await collect([text])).toEqual([" two spaces\nnone\n"]);
    expect(await collect([": only a comment\n\n"])).toEqual([]);
  });

  /* Kills: yielding '[DONE]' as data, or reading on after it. */
  it("data: [DONE] is never yielded: onDone fires once and the reader stops pulling", async () => {
    let pulledAfterDone = false;
    let doneCalls = 0;
    async function* source(): AsyncGenerator<SseChunk> {
      yield "data: {\"a\":1}\n\ndata: [DONE]\n\n";
      pulledAfterDone = true;
      yield "data: {\"late\":true}\n\n";
    }
    const out: string[] = [];
    for await (const d of parseSse(source(), { onDone: () => doneCalls++ })) out.push(d);
    expect(out).toEqual(['{"a":1}']);
    expect(doneCalls).toBe(1);
    expect(pulledAfterDone).toBe(false);
    /* A stream that ends without the sentinel never calls onDone. */
    let called = false;
    await collect(["data: x\n\n"], () => (called = true));
    expect(called).toBe(false);
  });

  /* Kills: dispatching the open event at end of stream. */
  it("an event cut before its blank line (a dropped stream) is discarded, never half-delivered", async () => {
    expect(await collect(["data: {\"whole\":1}\n\ndata: {\"cut\":"])).toEqual(['{"whole":1}']);
    expect(await collect(["data: {\"whole\":1}\n\ndata: {\"cut\":2}\n"])).toEqual(['{"whole":1}']);
  });
});
