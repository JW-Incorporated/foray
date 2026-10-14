import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ChatNarrationWriterBuilder,
  DEFAULT_STREAM_CHUNK_IDLE_MS,
  seamEditMaxTokens,
  streamedActMaxTokens
} from "../src/generation/chat/ChatNarrationWriterBuilder";
import { ChatProviderError, type ChatRequest } from "../src/generation/chat/ChatProvider";
import { targetFor } from "../src/generation/chat/targetFor";
import { actWritePromptParts, seamEditPromptParts } from "../src/generation/prompts/actWrite";
import { toChatMessages } from "../src/generation/promptLayout";
import { collectActStream, type ActWriteRequest, type NarrationBuildContext, type SeamEditRequest, type WriterStreamEvent, type WrittenSeam } from "../src/generation/NarrationWriterBuilder";
import type { EvidenceDoc } from "../src/generation/gatherEvidence";
import { DEFAULT_WRITER_STREAM_IDLE_MS, drainWriterStream } from "../src/generation/writeAct";
import { DEFAULT_LANE_PROFILES } from "../src/config/machineProfiles";
import type { StageRoute } from "../src/config/stageRouting";
import type { CostEventInput } from "../src/cost/costEvents";
import type { Voice } from "../src/types/spine";
import { scriptedProvider, type ScriptedStream } from "./helpers/fakeChatProvider";

/**
 * GV-84 (docs/roadmap/generation-v2.md, W4-19; covers R1-06, R2-08, GP-05,
 * GP-02): the streamed act writer and the seam edit on
 * ChatNarrationWriterBuilder. Offline only: scriptedProvider stream and
 * complete scripts (backend/test/helpers/fakeChatProvider.ts) over the
 * committed JSONL reply fixtures/local/writer-act-stream.jsonl; vitest fake
 * timers drive the chunk delays. No network, no model, no key.
 *
 * Mutations run against this suite (each turned the named test red, then
 * was reverted):
 *   1. streamAct: buffer the seams and yield them only after the provider's
 *      'done' (every seam then arrives at the end) -> "yields each seam as
 *      its line closes", "a provider failure midway", "a stalled stream",
 *      "a consumer that stops early".
 *   2. streamAct: send actWritePromptParts(request) (the 'json' contract)
 *      -> "sends the jsonl contract".
 *   3. streamedActMaxTokens: Math.max(12000, ...) as the floor (the one-shot
 *      writer's) -> "streamedActMaxTokens".
 *   4. streamAct: push '\n' before end() whatever the finish reason -> "a
 *      finish 'length'".
 *   5. streamAct: never push '\n' before end() -> "a finish 'stop' whose
 *      last line has no newline".
 *   6. nextWithin: one timer for the whole stream instead of one per chunk
 *      -> "the idle bound is between chunks".
 *   7. streamAct: drop `controller.abort()` on the idle path and in the
 *      finally -> "a stalled stream is aborted".
 *   8. constructor: assign writeActStream whatever the provider -> "no
 *      writeActStream without provider.stream".
 *   9. editSeams: seamEditPromptParts(request) (the 'json' contract) -> "the
 *      seam edit starts with the streamed act's prefix".
 *  10. seamEditPromptParts: drop the read-only neighbour lines -> "holds
 *      only the requested seams, their neighbours and their documents".
 *  11. seamEditMaxTokens: drop SEAM_EDIT_TOKEN_HEADROOM -> "the seam edit
 *      starts with the streamed act's prefix".
 *  12. actWrite.ts: add `import type Anthropic from "@anthropic-ai/sdk";` ->
 *      "no Anthropic SDK import".
 *  13. streamAct: drop `usage` from the 'end' event -> "yields the
 *      fixture's seams in order under random chunk sizes".
 *  14. editSeams: push '\n' before end() whatever the finish reason -> "a
 *      seam edit cut at its cap".
 *  15. DEFAULT_STREAM_CHUNK_IDLE_MS back to 120_000 (equal to writeAct's
 *      bound) -> "under writeAct's drain with the default bounds" and "the
 *      idle bound is between chunks".
 *  16. writeActStream returns the bare streamAct generator (its return()
 *      queued behind the pending read, no immediate abort) -> "under
 *      writeAct's drain with the default bounds" (the request is still open
 *      at writeAct's bound).
 */

const FIXTURE = path.join(__dirname, "fixtures", "local", "writer-act-stream.jsonl");
const REPLY = fs.readFileSync(FIXTURE, "utf8");
const FIXTURE_SEAMS: WrittenSeam[] = REPLY.split("\n")
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line) as WrittenSeam);

const ctx: NarrationBuildContext = { userId: "founder-1", sessionId: "s1" };
const sparkRoute: StageRoute = { provider: "local", lane: "spark", model: "local-heavy" };
const sparkTarget = targetFor(sparkRoute, DEFAULT_LANE_PROFILES.spark);
const voice: Voice = { style: "well-read friend", register: "conversational", sentenceRhythm: "varied", narratorPresence: "medium" };

const documents: EvidenceDoc[] = [
  { docId: "tape:seg-1", title: "Night Shift Radio: the 3 a.m. ward", text: "I always listen before I look, that is the first thing the ward teaches you.", kind: "tape" },
  { docId: "print:survey", title: "A survey of night nurses", text: "In the survey, most night nurses reported sorting patients by sound before they saw them.", kind: "print" },
  { docId: "tape:seg-2", title: "Night Shift Radio: the handover", text: "There is a word for it, gestalt, the whole picture at once.", kind: "tape" },
  { docId: "print:other", title: "An unrelated report", text: "A document no edited seam cites, which an edit request must not carry.", kind: "print" }
];

/** The act the fixture answers: s0 introduces c0, s1 carries a beat after
 * it, s2 introduces c1, s3 closes. */
function actRequest(): ActWriteRequest {
  return {
    actTitle: "Listening before looking",
    voice,
    seams: [
      { seamId: "s0", beats: [], introduces: "c0", intro: "full", band: [80, 240] },
      {
        seamId: "s1",
        beats: [{ beatId: "b1", claim: "Night nurses sort patients by sound first.", mode: "Carry", kind: "account" }],
        follows: "c0",
        band: [200, 600]
      },
      { seamId: "s2", beats: [], follows: "c0", introduces: "c1", intro: "light", band: [0, 160] },
      { seamId: "s3", beats: [], follows: "c1", band: [0, 200] }
    ],
    clips: [
      { clipId: "c0", segmentId: "seg-1", itemId: "i1", show: "Night Shift Radio", title: "The 3 a.m. ward", docId: "tape:seg-1", opening: "I always listen before I look.", durationSec: 64, intro: "full" },
      { clipId: "c1", segmentId: "seg-2", itemId: "i2", show: "Night Shift Radio", title: "The handover", docId: "tape:seg-2", opening: "There is a word for it.", durationSec: 48, intro: "light", showFirstHeard: false }
    ],
    documents: documents.slice(0, 3)
  };
}

/** Splits `text` into chunks of 1..max characters with a seeded generator. */
function randomChunks(text: string, seed: number, max = 23): string[] {
  let state = seed >>> 0 || 1;
  const rand = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  const chunks: string[] = [];
  for (let at = 0; at < text.length; ) {
    const size = 1 + Math.floor(rand() * max);
    chunks.push(text.slice(at, at + size));
    at += size;
  }
  return chunks;
}

function recordingGuard() {
  const checks: CostEventInput[] = [];
  return { checks, guard: { checkAndRecord: async (input: CostEventInput) => void checks.push(input) } };
}

async function drain(stream: AsyncIterable<WriterStreamEvent>): Promise<WriterStreamEvent[]> {
  const events: WriterStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GV-84: writeActStream, one JSONL call per act", () => {
  it("yields the fixture's seams in order under random chunk sizes, then one clean end with the usage", async () => {
    for (const seed of [1, 7, 42, 1286, 99991]) {
      const chunks = randomChunks(REPLY, seed).map((text) => ({ text }));
      const provider = scriptedProvider({
        stream: [{ chunks, usage: { promptTokens: 9800, completionTokens: 410, cachedTokens: 9600, reasoningTokens: null } }]
      });
      const { checks, guard } = recordingGuard();
      const writer = new ChatNarrationWriterBuilder(provider, sparkTarget, guard);
      const events = await drain(writer.writeActStream!(actRequest(), ctx));
      expect(events.filter((e) => e.type === "seam").map((e) => (e as Extract<WriterStreamEvent, { type: "seam" }>).seam)).toEqual(FIXTURE_SEAMS);
      expect(events.at(-1)).toEqual({ type: "end", stopReason: "end", unfinishedSeamIds: [], usage: { promptTokens: 9800, outputTokens: 410 } });
      expect(events.filter((e) => e.type === "end")).toHaveLength(1);
      /* One stream is one metered call. */
      expect(checks.map((c) => c.operation)).toEqual(["narration_write_act"]);
      expect(provider.requests).toHaveLength(1);
    }
  });

  it("yields each seam as its line closes, while the model is still writing the rest", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const lines = REPLY.split("\n").filter((l) => l.length > 0);
    /* One line every second; the line's newline arrives with the next line. */
    const chunks = lines.map((line, i) => ({ text: (i === 0 ? "" : "\n") + line, delayMs: 1000 }));
    chunks.push({ text: "\n", delayMs: 1000 });
    const provider = scriptedProvider({ stream: [{ chunks }] });
    const writer = new ChatNarrationWriterBuilder(provider, sparkTarget, recordingGuard().guard);
    const pending = drain(writer.writeActStream!(actRequest(), ctx));
    await vi.runAllTimersAsync();
    const events = await pending;
    const seams = events.filter((e): e is Extract<WriterStreamEvent, { type: "seam" }> => e.type === "seam");
    /* Line k closes when chunk k+1 arrives, at (k+2) s. */
    expect(seams.map((e) => [e.seam.seamId, e.atMs])).toEqual([
      ["s0", 2000],
      ["s1", 3000],
      ["s2", 4000],
      ["s3", 5000]
    ]);
  });

  it("sends the jsonl contract on the W4-11 prefix, the computed maxTokens, thinking off and no response_format", async () => {
    const provider = scriptedProvider({ stream: [{ chunks: [{ text: REPLY }] }] });
    const writer = new ChatNarrationWriterBuilder(provider, sparkTarget, recordingGuard().guard);
    const request = actRequest();
    await drain(writer.writeActStream!(request, ctx));
    const sent = provider.requests[0]!;
    const parts = actWritePromptParts(request, { output: "jsonl" });
    expect(sent.messages).toEqual(toChatMessages(parts));
    expect(sent.messages[0]).toEqual({ role: "system", content: parts.stable });
    expect(sent.messages[0]!.content).toContain("Respond in JSONL: one seam object per line");
    expect(sent.messages[0]!.content).not.toContain("Respond with ONLY a single JSON object");
    /* bands 240 + 600 + 160 + 200 = 1200 chars -> 600 tokens -> the 1200 floor. */
    expect(sent.maxTokens).toBe(streamedActMaxTokens(request));
    expect(sent.maxTokens).toBe(1200);
    expect(sent.thinking).toBe(false);
    expect(sent.responseFormat).toBeUndefined();
    expect(sent.priority).toBeUndefined();
    expect(sent.label).toBe("narration_write_act");
    expect(sent.model).toBe(sparkTarget.model);
    expect(sent.signal).toBeInstanceOf(AbortSignal);
  });

  it("streamedActMaxTokens = min(32000, max(1200, ceil(sum of band maxima x 0.5)))", () => {
    const seams = (maxima: number[]) => ({ seams: maxima.map((max, i) => ({ seamId: `s${i}`, beats: [], band: [0, max] as [number, number] })) });
    expect(streamedActMaxTokens(seams([100, 200]))).toBe(1200);
    expect(streamedActMaxTokens(seams([2401, 2400]))).toBe(2401);
    expect(streamedActMaxTokens(seams([5001]))).toBe(2501);
    expect(streamedActMaxTokens(seams([70000]))).toBe(32000);
    expect(streamedActMaxTokens(seams([]))).toBe(1200);
  });

  it("a finish 'length' yields the finished seams and an end with stopReason 'length' and the unfinished seam ids", async () => {
    /* Cut right after s2's closing brace: the unterminated line is valid
       JSON, and must still not pass as a seam (end() never guesses). */
    const cutAt = REPLY.indexOf('{"seamId":"s3"') - 1;
    const provider = scriptedProvider({ stream: [{ chunks: randomChunks(REPLY.slice(0, cutAt), 5).map((text) => ({ text })), finish: "length" }] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const writer = new ChatNarrationWriterBuilder(provider, sparkTarget, recordingGuard().guard);
    const result = await collectActStream(writer.writeActStream!(actRequest(), ctx));
    expect(result.seams.map((s) => s.seamId)).toEqual(["s0", "s1"]);
    expect(result.stopReason).toBe("length");
    expect(result.unfinishedSeamIds).toEqual(["s2", "s3"]);
    expect(warn.mock.calls.some(([msg]) => String(msg).includes("ended mid-line"))).toBe(true);
  });

  it("a finish 'stop' whose last line has no newline still yields that seam; a bad line costs only its seam", async () => {
    const lines = REPLY.split("\n").filter((l) => l.length > 0);
    lines[1] = lines[1]!.replace('"usedClaims":[0],', ""); // s1 loses a required field
    const reply = lines.join("\n"); // no final newline
    const provider = scriptedProvider({ stream: [{ chunks: randomChunks(reply, 11).map((text) => ({ text })), finish: "stop" }] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const writer = new ChatNarrationWriterBuilder(provider, sparkTarget, recordingGuard().guard);
    const result = await collectActStream(writer.writeActStream!(actRequest(), ctx));
    expect(result.seams.map((s) => s.seamId)).toEqual(["s0", "s2", "s3"]);
    expect(result.stopReason).toBe("end");
    expect(result.unfinishedSeamIds).toEqual(["s1"]);
    /* The warning names the error, never the seam's text. */
    const logged = warn.mock.calls.map(([msg]) => String(msg)).join("\n");
    expect(logged).toContain("not a seam");
    expect(logged).not.toContain("triage");
  });

  it("the idle bound is between chunks: a slow healthy stream longer than the bound is not cut", async () => {
    vi.useFakeTimers();
    const idle = 5_000;
    /* Chunks 4 s apart: minutes in all, never 5 s without a chunk. */
    const chunks = randomChunks(REPLY, 3, 40).map((text) => ({ text, delayMs: 4_000 }));
    expect(chunks.length * 4_000).toBeGreaterThan(idle * 3);
    const provider = scriptedProvider({ stream: [{ chunks }] });
    const writer = new ChatNarrationWriterBuilder(provider, sparkTarget, recordingGuard().guard, { chunkIdleTimeoutMs: idle });
    const pending = collectActStream(writer.writeActStream!(actRequest(), ctx));
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.seams).toEqual(FIXTURE_SEAMS);
    expect(result.stopReason).toBe("end");
    /* A backstop: strictly longer than writeAct.ts's bound, so under
       writeAct the stall is always writeAct's graceful cut. */
    expect(DEFAULT_STREAM_CHUNK_IDLE_MS).toBeGreaterThan(DEFAULT_WRITER_STREAM_IDLE_MS);
  });

  it("under writeAct's drain with the default bounds, a stall right after a line closes is writeAct's graceful 'stalled' cut, and the request is aborted at once", async () => {
    vi.useFakeTimers();
    const firstLineEnd = REPLY.indexOf("\n") + 1;
    /* The first chunk closes s0's line; then the provider goes silent. */
    const stalled: ScriptedStream = { chunks: [{ text: REPLY.slice(0, firstLineEnd) }, { text: REPLY.slice(firstLineEnd), delayMs: 600_000 }] };
    const provider = scriptedProvider({ stream: [stalled] });
    const writer = new ChatNarrationWriterBuilder(provider, sparkTarget, recordingGuard().guard);
    const seen: string[] = [];
    const outcome = drainWriterStream(writer.writeActStream!(actRequest(), ctx), DEFAULT_WRITER_STREAM_IDLE_MS, (seam) => seen.push(seam.seamId)).then(
      (drained) => ({ drained }),
      (err: unknown) => ({ err })
    );
    await vi.advanceTimersByTimeAsync(DEFAULT_WRITER_STREAM_IDLE_MS);
    const result = await outcome;
    expect(result).toEqual({ drained: { stopReason: "stalled", unfinishedSeamIds: [] } });
    expect(seen).toEqual(["s0"]);
    /* writeAct's stall frees the lane now, not at the builder's backstop. */
    expect((provider.requests[0] as ChatRequest).signal!.aborted).toBe(true);
    await vi.runAllTimersAsync();
  });

  it("a stalled stream is aborted at the idle bound: the finished seams arrive, then a 'timeout' error with the partial text", async () => {
    vi.useFakeTimers();
    const firstLineEnd = REPLY.indexOf("\n") + 1;
    const head = REPLY.slice(0, firstLineEnd + 10);
    const stalled: ScriptedStream = { chunks: [{ text: head }, { text: REPLY.slice(head.length), delayMs: 600_000 }] };
    const provider = scriptedProvider({ stream: [stalled] });
    const writer = new ChatNarrationWriterBuilder(provider, sparkTarget, recordingGuard().guard, { chunkIdleTimeoutMs: 30_000 });
    const seen: string[] = [];
    const run = (async () => {
      for await (const event of writer.writeActStream!(actRequest(), ctx)) if (event.type === "seam") seen.push(event.seam.seamId);
    })();
    const outcome = run.then(
      () => null,
      (err: unknown) => err
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await outcome;
    expect(seen).toEqual(["s0"]);
    expect(err).toBeInstanceOf(ChatProviderError);
    expect((err as ChatProviderError).kind).toBe("timeout");
    expect((err as ChatProviderError).message).toBe("stream_idle");
    expect((err as ChatProviderError).partialText).toBe(head);
    /* The HTTP request is cancelled, so the lane is freed. */
    expect((provider.requests[0] as ChatRequest).signal!.aborted).toBe(true);
  });

  it("a consumer that stops early cancels the request", async () => {
    const provider = scriptedProvider({ stream: [{ chunks: randomChunks(REPLY, 9).map((text) => ({ text })) }] });
    const writer = new ChatNarrationWriterBuilder(provider, sparkTarget, recordingGuard().guard);
    for await (const event of writer.writeActStream!(actRequest(), ctx)) {
      if (event.type === "seam") break;
    }
    expect(provider.requests[0]!.signal!.aborted).toBe(true);
  });

  it("a provider failure midway throws after the seams that finished", async () => {
    const provider = scriptedProvider({ stream: [{ chunks: [{ text: REPLY.slice(0, REPLY.indexOf("\n") + 5) }], drop: { kind: "network", reason: "stream_dropped" } }] });
    const writer = new ChatNarrationWriterBuilder(provider, sparkTarget, recordingGuard().guard);
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const event of writer.writeActStream!(actRequest(), ctx)) if (event.type === "seam") seen.push(event.seam.seamId);
      })()
    ).rejects.toThrow("stream_dropped");
    expect(seen).toEqual(["s0"]);
  });

  it("no writeActStream without provider.stream; writeAct stays the one-shot json call", async () => {
    const provider = scriptedProvider({ complete: [JSON.stringify({ seams: FIXTURE_SEAMS })] });
    const writer = new ChatNarrationWriterBuilder(provider, sparkTarget, recordingGuard().guard);
    expect(typeof writer.writeActStream).toBe("undefined");
    expect("writeActStream" in writer && writer.writeActStream !== undefined).toBe(false);
    const result = await writer.writeAct(actRequest(), ctx);
    expect(result.seams).toEqual(FIXTURE_SEAMS);
    const sent = provider.requests[0]!;
    expect(sent.messages).toEqual(toChatMessages(actWritePromptParts(actRequest())));
    expect(sent.responseFormat).toMatchObject({ type: "json_schema", name: "act_write" });
    expect(sent.maxTokens).toBe(12000);
    /* With a stream script the method is there. */
    const streaming = new ChatNarrationWriterBuilder(scriptedProvider({ stream: [] }), sparkTarget, recordingGuard().guard);
    expect(typeof streaming.writeActStream).toBe("function");
  });
});

/** Round 2 of the act above: s1 failed; s0 and s2 are its neighbours. */
function editRequest(): SeamEditRequest {
  const act = actRequest();
  return {
    actTitle: act.actTitle,
    voice,
    seams: [{ ...act.seams[1]!, previousScript: "She is describing triage.", notes: "the prose does not carry beat b1" }],
    neighbours: [
      { seamId: "s0", script: FIXTURE_SEAMS[0]!.script },
      { seamId: "s2", script: FIXTURE_SEAMS[2]!.script }
    ],
    clips: [act.clips[0]!],
    documents: [documents[0]!, documents[1]!],
    retryNote: "seam s1: the prose does not carry beat b1"
  };
}

describe("GV-84: editSeams, the short seam edit on the same prefix", () => {
  it("the seam edit starts with the streamed act's byte-identical prefix, and returns the requested seams", async () => {
    const provider = scriptedProvider({
      stream: [{ chunks: [{ text: REPLY }] }],
      complete: [{ text: `${JSON.stringify(FIXTURE_SEAMS[1])}`, usage: { promptTokens: 9900, completionTokens: 120, cachedTokens: 9600, reasoningTokens: null } }]
    });
    const { checks, guard } = recordingGuard();
    const writer = new ChatNarrationWriterBuilder(provider, sparkTarget, guard);
    await drain(writer.writeActStream!(actRequest(), ctx));
    const edit = editRequest();
    const result = await writer.editSeams(edit, ctx);
    const [streamed, edited] = provider.requests;
    expect(edited!.messages[0]!.content).toBe(streamed!.messages[0]!.content);
    expect(edited!.messages[0]!.role).toBe("system");
    expect(edited!.messages).toEqual(toChatMessages(seamEditPromptParts(edit, { output: "jsonl" })));
    /* s1's band max 600 -> 300 + 200. */
    expect(edited!.maxTokens).toBe(seamEditMaxTokens(edit));
    expect(edited!.maxTokens).toBe(500);
    expect(edited!.responseFormat).toBeUndefined();
    expect(edited!.thinking).toBe(false);
    expect(result.seams).toEqual([FIXTURE_SEAMS[1]]);
    expect(checks.map((c) => c.operation)).toEqual(["narration_write_act", "narration_edit_seams"]);
  });

  it("holds only the requested seams, their neighbours and their documents, in play order", async () => {
    const provider = scriptedProvider({ complete: [JSON.stringify(FIXTURE_SEAMS[1])] });
    const writer = new ChatNarrationWriterBuilder(provider, sparkTarget, recordingGuard().guard);
    await writer.editSeams(editRequest(), ctx);
    const user = provider.requests[0]!.messages[1]!.content;
    const s0 = user.indexOf("SEAM s0 — READ-ONLY, as the listener hears it:");
    const clip = user.indexOf('\nCLIP c0 — "The 3 a.m. ward"');
    const s1 = user.indexOf("SEAM s1 — 200-600 characters — follows CLIP c0 — EDIT");
    const s2 = user.indexOf("SEAM s2 — READ-ONLY, as the listener hears it:");
    expect([s0, clip, s1, s2].every((i) => i >= 0)).toBe(true);
    expect(s0 < clip && clip < s1 && s1 < s2).toBe(true);
    /* The followed clip is printed once, before the seam that follows it. */
    expect(user.split("\n").filter((line) => line.startsWith("CLIP c0 ")).length).toBe(1);
    expect(user).toContain('  previous script: "She is describing triage."');
    expect(user).toContain("  fix: the prose does not carry beat b1");
    expect(user).toContain("Return a seam for each seam marked EDIT (s1) and for no other");
    expect(user).toContain("REJECTIONS SO FAR: seam s1: the prose does not carry beat b1");
    /* Nothing else of the act: not s3, not c1, not a document the seam does not cite. */
    expect(user).not.toContain("SEAM s3");
    expect(user).not.toContain("CLIP c1");
    expect(user).toContain("docId: tape:seg-1");
    expect(user).toContain("docId: print:survey");
    expect(user).not.toContain("tape:seg-2");
    expect(user).not.toContain("print:other");
  });

  it("seamEditPromptParts shares stable with actWritePromptParts for both contracts and with a voice block", () => {
    const edit = editRequest();
    const act = actRequest();
    for (const options of [{}, { output: "jsonl" as const }, { output: "jsonl" as const, voiceBlock: "VOICE CARD\nexemplar" }]) {
      expect(seamEditPromptParts(edit, options).stable).toBe(actWritePromptParts(act, options).stable);
      expect(seamEditPromptParts(edit, options).foray).toBe(actWritePromptParts(act, options).foray);
    }
    /* A silent neighbour says so. */
    const silent = seamEditPromptParts({ ...edit, neighbours: [{ seamId: "s2", script: "" }] }).call;
    expect(silent).toContain("SEAM s2 — READ-ONLY, silent: the clips run together here");
  });

  it("a seam edit cut at its cap keeps the finished seams; an unterminated line is never parsed", async () => {
    const reply = `${JSON.stringify(FIXTURE_SEAMS[1])}\n${JSON.stringify({ ...FIXTURE_SEAMS[2], seamId: "s2" })}`;
    const provider = scriptedProvider({ complete: [{ text: reply, finishReason: "length" }] });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const writer = new ChatNarrationWriterBuilder(provider, sparkTarget, recordingGuard().guard);
    const result = await writer.editSeams(editRequest(), ctx);
    expect(result.seams.map((s) => s.seamId)).toEqual(["s1"]);
  });
});

describe("GV-84: no Anthropic SDK import", () => {
  it("chat/ChatNarrationWriterBuilder.ts and prompts/actWrite.ts import no @anthropic-ai/sdk", () => {
    const generation = path.join(__dirname, "..", "src", "generation");
    for (const file of ["chat/ChatNarrationWriterBuilder.ts", "prompts/actWrite.ts"]) {
      const source = fs.readFileSync(path.join(generation, file), "utf8");
      expect(source, file).not.toMatch(/["']@anthropic-ai\/[^"']*["']/);
      expect(source, file).not.toMatch(/anthropicCall/);
    }
  });
});
