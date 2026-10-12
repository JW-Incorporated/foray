import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OpenAICompatChatProvider, buildRequestBody, type OpenAICompatChatProviderOptions } from "../src/generation/chat/openAICompatProvider";
import { ChatProviderError, type ChatRequest, type ResponseFormat } from "../src/generation/chat/ChatProvider";
import { responseFormatFor } from "../src/generation/chat/jsonSchema";
import { RunLog, runWithRunLog, withCallContext } from "../src/generation/runLog";
import { fakeFetch, openAIFixture, type FakeFetchReply } from "./helpers/fakeFetch";
import { scriptedProvider } from "./helpers/fakeChatProvider";

/**
 * GV-13 (docs/roadmap/generation-v2.md, from W2-01): the provider-neutral
 * chat contract and the non-streaming OpenAI-compatible client. Offline
 * only: every reply comes from fakeFetch over the synthetic bodies in
 * test/fixtures/openai/, and no test reaches LiteLLM, the Spark or Jev.
 */

const KEY = "sk-synthetic-key-never-leaks-0000";
const BASE = "http://litellm.invalid:4000";

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

function provider(reply: FakeFetchReply | FakeFetchReply[], opts: Partial<OpenAICompatChatProviderOptions> = {}) {
  const fake = fakeFetch(reply);
  const p = new OpenAICompatChatProvider({ baseUrl: BASE, apiKey: KEY, fetchImpl: fake.fetch, ...opts });
  return { p, fake };
}

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: "local-heavy",
    messages: [
      { role: "system", content: "Reply with JSON." },
      { role: "user", content: 'reply {"ok":true}' }
    ],
    maxTokens: 64,
    label: "probe",
    ...overrides
  };
}

const ok = (fixture: string, headers: Record<string, string> = {}): FakeFetchReply => ({ body: openAIFixture(fixture), headers });

afterEach(() => {
  vi.useRealTimers();
});

describe("OpenAICompatChatProvider.complete: reading a reply", () => {
  it("returns text, finishReason, usage, model, requestId and servedBy from a stop reply; cachedTokens is null when prompt_tokens_details is absent", async () => {
    const c = clock();
    const { p } = provider(ok("chat-stop", { "x-request-id": "req-1", "x-litellm-call-id": "litellm-call-9", "x-litellm-model-id": "spark-sglang-a2" }), { now: c.now });
    const res = await p.complete(request());
    expect(res.text).toBe('{"ok":true}');
    expect(res.finishReason).toBe("stop");
    expect(res.usage).toEqual({ promptTokens: 42, completionTokens: 7, cachedTokens: null, reasoningTokens: null });
    expect(res.model).toBe("synthetic-heavy-27b");
    expect(res.requestId).toBe("req-1");
    expect(res.servedBy).toBe("spark-sglang-a2");
    expect(res.timing).toEqual({ startedAt: 1_000_000, firstByteAt: 1_000_000, endedAt: 1_000_000 });
    expect(res).not.toHaveProperty("logprobs");
  });

  it("reads cached and reasoning token counts when present, and never surfaces reasoning_content", async () => {
    const { p } = provider(ok("chat-cached-reasoning"));
    const res = await p.complete(request());
    expect(res.usage).toEqual({ promptTokens: 900, completionTokens: 50, cachedTokens: 768, reasoningTokens: 31 });
    expect(res.text).toBe("Synthetic answer text.");
    expect(JSON.stringify(res)).not.toContain("Synthetic reasoning");
  });

  it("maps finish_reason 'length' to 'length' (a truncated reply is never reported as finished)", async () => {
    const { p } = provider(ok("chat-length"));
    const res = await p.complete(request());
    expect(res.finishReason).toBe("length");
    expect(res.text.startsWith('{"acts"')).toBe(true);
  });

  it("maps content_filter through and any other finish_reason to 'other'", async () => {
    const body = (finish: string | null) => ({ choices: [{ message: { role: "assistant", content: "x" }, finish_reason: finish }] });
    const { p } = provider([{ body: body("content_filter") }, { body: body("tool_calls") }, { body: body(null) }]);
    expect((await p.complete(request())).finishReason).toBe("content_filter");
    expect((await p.complete(request())).finishReason).toBe("other");
    expect((await p.complete(request())).finishReason).toBe("other");
  });

  it("takes requestId from x-litellm-call-id when x-request-id is absent, and leaves requestId, servedBy and model null when nothing says", async () => {
    const { p } = provider([
      ok("chat-stop", { "x-litellm-call-id": "litellm-call-9" }),
      { body: { choices: [{ message: { role: "assistant", content: "x" }, finish_reason: "stop" }] } }
    ]);
    const first = await p.complete(request());
    expect(first.requestId).toBe("litellm-call-9");
    expect(first.servedBy).toBeNull();
    const second = await p.complete(request());
    expect(second.requestId).toBeNull();
    expect(second.model).toBeNull();
    expect(second.usage).toEqual({ promptTokens: null, completionTokens: null, cachedTokens: null, reasoningTokens: null });
  });

  it("returns token logprobs only when the request asked for them", async () => {
    const { p } = provider(ok("chat-cached-reasoning"));
    const asked = await p.complete(request({ logprobs: { top: 2 } }));
    expect(asked.logprobs).toEqual([
      {
        token: "Synthetic",
        logprob: -0.01,
        top: [
          { token: "Synthetic", logprob: -0.01 },
          { token: "Example", logprob: -4.6 }
        ]
      }
    ]);
    const notAsked = await p.complete(request());
    expect(notAsked).not.toHaveProperty("logprobs");
  });

  it("timing.firstByteAt is when the headers arrived, endedAt after the body was read", async () => {
    const c = clock(5_000);
    const fake = fakeFetch(ok("chat-stop"));
    const p = new OpenAICompatChatProvider({
      baseUrl: BASE,
      apiKey: KEY,
      now: c.now,
      fetchImpl: async (url, init) => {
        c.advance(300);
        const res = await fake.fetch(url, init);
        return { ...res, headers: res.headers, text: async () => (c.advance(40), res.text()) };
      }
    });
    const res = await p.complete(request());
    expect(res.timing).toEqual({ startedAt: 5_000, firstByteAt: 5_300, endedAt: 5_340 });
  });
});

describe("OpenAICompatChatProvider.complete: the request it sends", () => {
  it("POSTs to <baseUrl>/v1/chat/completions with thinking off by default and the key only in the Authorization header", async () => {
    const { p, fake } = provider(ok("chat-stop"), { baseUrl: `${BASE}/` });
    await p.complete(request());
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.url).toBe(`${BASE}/v1/chat/completions`);
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(call.body).toEqual({
      model: "local-heavy",
      messages: [
        { role: "system", content: "Reply with JSON." },
        { role: "user", content: 'reply {"ok":true}' }
      ],
      max_tokens: 64,
      chat_template_kwargs: { enable_thinking: false }
    });
    expect(call.rawBody).not.toContain(KEY);
    const otherHeaders = Object.entries(call.headers).filter(([k]) => k !== "authorization");
    expect(JSON.stringify(otherHeaders)).not.toContain(KEY);
  });

  it("thinking: true sends enable_thinking true", async () => {
    const { p, fake } = provider(ok("chat-stop"));
    await p.complete(request({ thinking: true }));
    expect(fake.calls[0]!.body.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  it("sends a json_schema response format in OpenAI's shape, straight from responseFormatFor", async () => {
    const { p, fake } = provider(ok("chat-stop"));
    const format: ResponseFormat = responseFormatFor("clarity");
    await p.complete(request({ responseFormat: format }));
    expect(fake.calls[0]!.body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "clarity", schema: JSON.parse(JSON.stringify(responseFormatFor("clarity").schema)), strict: true }
    });
    await p.complete(request({ responseFormat: { type: "json_object" } }));
    expect(fake.calls[1]!.body.response_format).toEqual({ type: "json_object" });
  });

  it("maps temperature, topP, stop, priority and logprobs to the wire names, and spreads extraBody last", async () => {
    const body = buildRequestBody(
      request({
        temperature: 0.2,
        topP: 0.9,
        stop: ["\n\n"],
        priority: 3,
        logprobs: { top: 5 },
        extraBody: { seed: 7, chat_template_kwargs: { enable_thinking: true } }
      })
    );
    expect(body).toMatchObject({ temperature: 0.2, top_p: 0.9, stop: ["\n\n"], priority: 3, logprobs: true, top_logprobs: 5, seed: 7 });
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(Object.keys(buildRequestBody(request()))).toEqual(["model", "messages", "max_tokens", "chat_template_kwargs"]);
  });

  it("rejects a missing baseUrl and a non-positive timeout at construction", () => {
    expect(() => new OpenAICompatChatProvider({ baseUrl: " ", apiKey: KEY, fetchImpl: fakeFetch(ok("chat-stop")).fetch })).toThrow(/baseUrl/);
    expect(() => new OpenAICompatChatProvider({ baseUrl: BASE, apiKey: KEY, timeoutMs: 0, fetchImpl: fakeFetch(ok("chat-stop")).fetch })).toThrow(
      /timeoutMs/
    );
  });
});

describe("OpenAICompatChatProvider.complete: failures", () => {
  for (const status of [401, 429, 503]) {
    it(`HTTP ${status} is kind 'http' with the status, and the message carries neither the key nor the body`, async () => {
      const upstream = `upstream says: invalid key ${KEY} rate limited, please retry`;
      const { p, fake } = provider({ status, body: upstream });
      const err = await p.complete(request()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ChatProviderError);
      expect(err).toMatchObject({ kind: "http", status, message: `http_${status}` });
      expect(String((err as Error).message)).not.toContain(KEY);
      expect(String((err as Error).message)).not.toContain("upstream");
      expect(JSON.stringify(err)).not.toContain(KEY);
      expect(fake.calls).toHaveLength(1);
    });
  }

  it("a hung fetch becomes kind 'timeout' after timeoutMs, not before", async () => {
    vi.useFakeTimers();
    const { p, fake } = provider({ hang: "honor-signal" }, { timeoutMs: 1_000 });
    let settled = false;
    const pending = p.complete(request()).finally(() => (settled = true));
    const assertion = expect(pending).rejects.toMatchObject({ kind: "timeout", message: "timeout" });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(fake.calls[0]!.signal.aborted).toBe(true);
  });

  it("a fetch that ignores its abort signal still times out", async () => {
    vi.useFakeTimers();
    const { p } = provider({ hang: "deaf" }, { timeoutMs: 2_000 });
    const assertion = expect(p.complete(request())).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
  });

  it("a refused connection is kind 'network' and a caller's abort is kind 'aborted'", async () => {
    const refused = provider({ networkError: true });
    await expect(refused.p.complete(request())).rejects.toMatchObject({ kind: "network", message: "network" });

    const hung = provider({ hang: "honor-signal" });
    const controller = new AbortController();
    const pending = hung.p.complete(request({ signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "aborted", message: "aborted" });

    const pre = provider(ok("chat-stop"));
    await expect(pre.p.complete(request({ signal: AbortSignal.abort() }))).rejects.toMatchObject({ kind: "aborted" });
    expect(pre.fake.calls).toHaveLength(0);
  });

  it("a non-JSON body, a choice-less body and a non-string content are kind 'malformed'", async () => {
    const { p } = provider([
      { body: "<html>502 Bad Gateway from a proxy</html>" },
      ok("chat-malformed"),
      { body: { choices: [{ finish_reason: "stop" }] } },
      { body: { choices: [{ message: { role: "assistant", content: 42 }, finish_reason: "stop" }] } }
    ]);
    const first = await p.complete(request()).catch((e: unknown) => e);
    expect(first).toMatchObject({ kind: "malformed", message: "malformed_json" });
    expect((first as Error).message).not.toContain("Bad Gateway");
    await expect(p.complete(request())).rejects.toMatchObject({ kind: "malformed", message: "malformed_choice" });
    await expect(p.complete(request())).rejects.toMatchObject({ kind: "malformed" });
    await expect(p.complete(request())).rejects.toMatchObject({ kind: "malformed" });
  });

  it("never retries: one failed request is one fetch", async () => {
    const { p, fake } = provider([{ status: 503, body: "busy" }, ok("chat-stop")]);
    await expect(p.complete(request())).rejects.toMatchObject({ kind: "http", status: 503 });
    expect(fake.calls).toHaveLength(1);
  });
});

describe("OpenAICompatChatProvider.complete: one CallRecord per call (GV-07)", () => {
  it("a success records exactly one CallRecord carrying the enclosing withCallContext", async () => {
    const c = clock(0);
    const log = new RunLog({ now: c.now });
    const fake = fakeFetch(ok("chat-cached-reasoning", { "x-litellm-model-id": "spark-sglang-a2" }));
    const p = new OpenAICompatChatProvider({
      baseUrl: BASE,
      apiKey: KEY,
      fetchImpl: async (url, init) => {
        c.advance(250);
        return fake.fetch(url, init);
      }
    });
    await runWithRunLog(log, () => withCallContext({ stage: "spine", act: 2, attempt: 1, priority: "critical", lane: "A2" }, () => p.complete(request())));
    const calls = log.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      seq: 0,
      stage: "spine",
      act: 2,
      attempt: 1,
      provider: "openai-compat",
      machine: "spark-sglang-a2",
      model: "local-heavy",
      label: "probe",
      startMs: 0,
      endMs: 250,
      ms: 250,
      queueMs: null,
      ttftMs: null,
      promptTokens: 900,
      cachedTokens: 768,
      outputTokens: 50,
      maxTokens: 64,
      stopReason: "stop"
    });
    expect(calls[0]).not.toHaveProperty("error");
    expect(log.toJsonl()).not.toContain(KEY);
  });

  it("a failure records exactly one CallRecord with the error kind and status, then rethrows", async () => {
    const log = new RunLog();
    const { p } = provider([{ status: 429, body: "slow down" }, { body: "not json" }]);
    await runWithRunLog(log, async () => {
      await withCallContext({ stage: "narrate:1" }, async () => {
        await expect(p.complete(request())).rejects.toMatchObject({ kind: "http" });
        await expect(p.complete(request())).rejects.toMatchObject({ kind: "malformed" });
      });
    });
    const calls = log.calls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ stage: "narrate:1", error: { kind: "http", status: 429 }, promptTokens: null, stopReason: null });
    expect(calls[1]!.error).toEqual({ kind: "malformed" });
  });

  it("a timeout records exactly one CallRecord with kind 'timeout'", async () => {
    vi.useFakeTimers();
    const log = new RunLog();
    const { p } = provider({ hang: "honor-signal" }, { timeoutMs: 500 });
    await runWithRunLog(log, async () => {
      const assertion = expect(p.complete(request())).rejects.toMatchObject({ kind: "timeout" });
      await vi.advanceTimersByTimeAsync(500);
      await assertion;
    });
    expect(log.calls()).toHaveLength(1);
    expect(log.calls()[0]!.error).toEqual({ kind: "timeout" });
  });

  it("outside a RunLog nothing is recorded and the call still succeeds", async () => {
    const { p } = provider(ok("chat-stop"));
    await expect(p.complete(request())).resolves.toMatchObject({ text: '{"ok":true}' });
  });
});

/* The client is inert: a stage reaches it only through a later routing card.
   Scanned recursively; an import from inside generation/chat/ is allowed. */
function importersOutsideChat(srcDir: string): string[] {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|js|mjs|cjs)$/.test(entry.name)) continue;
      const rel = path.relative(srcDir, full).split(path.sep).join("/");
      if (rel.startsWith("generation/chat/")) continue;
      if (/(from\s+|require\(|import\()\s*["'][^"']*openAICompatProvider["']/.test(fs.readFileSync(full, "utf8"))) offenders.push(rel);
    }
  };
  walk(srcDir);
  return offenders.sort();
}

describe("openAICompatProvider is inert (no caller outside generation/chat/)", () => {
  it("no module under backend/src outside generation/chat/ imports it", () => {
    expect(importersOutsideChat(path.join(__dirname, "..", "src"))).toEqual([]);
  });

  it("the guard catches a planted import, nested or not, and allows one inside chat/", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-chat-guard-"));
    try {
      fs.mkdirSync(path.join(dir, "generation", "chat"), { recursive: true });
      fs.mkdirSync(path.join(dir, "routes"), { recursive: true });
      fs.writeFileSync(path.join(dir, "generation", "chat", "askStructured.ts"), 'import { OpenAICompatChatProvider } from "./openAICompatProvider";\n');
      fs.writeFileSync(path.join(dir, "generation", "writeAct.ts"), 'import { OpenAICompatChatProvider } from "./chat/openAICompatProvider";\n');
      fs.writeFileSync(path.join(dir, "routes", "x.ts"), 'const m = require("../generation/chat/openAICompatProvider");\n');
      expect(importersOutsideChat(dir)).toEqual(["generation/writeAct.ts", "routes/x.ts"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scriptedProvider (test helper for later builder cards)", () => {
  it("replays scripted replies in order, records every request and fills the defaults", async () => {
    const p = scriptedProvider({ complete: ['{"a":1}', { text: "cut", finishReason: "length" }, new ChatProviderError("http", "http_503", { status: 503 })] });
    const first = await p.complete(request({ label: "one" }));
    expect(first).toEqual({
      text: '{"a":1}',
      finishReason: "stop",
      usage: { promptTokens: null, completionTokens: null, cachedTokens: null, reasoningTokens: null },
      model: "local-heavy",
      requestId: null,
      servedBy: null,
      timing: { startedAt: 0, firstByteAt: 0, endedAt: 0 }
    });
    expect((await p.complete(request({ label: "two" }))).finishReason).toBe("length");
    await expect(p.complete(request({ label: "three" }))).rejects.toMatchObject({ kind: "http", status: 503 });
    await expect(p.complete(request({ label: "four" }))).rejects.toThrow(/no reply scripted for call 4/);
    expect(p.requests.map((r) => r.label)).toEqual(["one", "two", "three", "four"]);
  });

  it("a function script answers per request", async () => {
    const p = scriptedProvider({ complete: (req) => `echo ${req.label}` });
    expect((await p.complete(request({ label: "x" }))).text).toBe("echo x");
    expect(p.name).toBe("scripted");
  });
});
