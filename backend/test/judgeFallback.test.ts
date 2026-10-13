import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveRouting, routingSummary } from "../src/config/stageRouting";
import { BudgetGuard } from "../src/cost/budgetGuard";
import { InMemoryCostEventSink } from "../src/cost/costEvents";
import { readGateConfig, judgeThreshold, judgedPass } from "../src/generation/gateConfig";
import {
  CircuitBreaker,
  FallbackJudgeClient,
  HttpJevClient,
  NullJevClient,
  createJevClient,
  isJudgeOutage,
  meteredJevClient,
  type JudgeFallbackInfo
} from "../src/generation/jevClient";
import type { JevCallInfo, JevError, JevQuestion, JevResult } from "../src/generation/jevTypes";
import { QwenJudgeClient } from "../src/generation/qwenJudgeClient";
import { scriptedProvider } from "./helpers/fakeChatProvider";
import { FakeJevClient, jevFixtures, noulAnswer, scoreAnswer } from "./helpers/fakeJevClient";

/**
 * GV-47 (docs/roadmap/generation-v2.md, from W5-19 + W2-12; OQ-05): the
 * judge fallback. FallbackJudgeClient asks Jev and, on an outage only, the
 * Qwen judge, behind a circuit breaker on a fake clock; the 'judge' route
 * picks jev | jev:<lane> | local:<lane> | none; 'none' is fail-closed;
 * thresholds are read per judge. Offline: FakeJevClient and a scripted
 * ChatProvider; nothing reaches Jev, LiteLLM, the Spark or the second box.
 * Each test names the mutation that turns it red.
 */

/* env.ts loads the repo-root .env at import; a developer's JEV_API_KEY there
   must not leak into the routing cases. */
vi.mock("dotenv", () => ({ default: { config: vi.fn() }, config: vi.fn() }));

const fx = jevFixtures();
const STATE = fx.state;
const NOUL: JevQuestion[] = [fx.questions[0]!];
const KEY = "jev-synthetic-key-gv47";
const BASE_URL = "http://litellm.invalid:4000";

const outage = (category: JevError["category"], reason: string, httpStatus?: number): JevError => ({
  category,
  reason,
  ...(httpStatus !== undefined ? { httpStatus } : {})
});

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

/** A primary that fails with each scripted error in turn (undefined = answers). */
function scriptedPrimary(errors: Array<JevError | undefined>, noul = 0.9): FakeJevClient {
  let call = 0;
  return new FakeJevClient({ byId: { supported: noulAnswer(noul) }, fail: () => errors[call++] });
}

const qwenFake = (noul = 0.6): FakeJevClient => new FakeJevClient({ byId: { supported: noulAnswer(noul) }, model: "local-worker" });

const askOf = (c: { ask: FakeJevClient["ask"] }, signal?: AbortSignal): Promise<JevResult> =>
  c.ask(STATE, NOUL, { purpose: "sentence-support", ...(signal ? { signal } : {}) });

describe("FallbackJudgeClient: falls back on an outage only, and tags every answer", () => {
  it.each([
    ["a timeout", outage("timeout", "timeout")],
    ["a 503", outage("http", "http_503", 503)],
    ["a network error", outage("network", "network")]
  ])("%s on Jev is answered by the Qwen judge, tagged qwen", async (_label, error) => {
    /* MUTATION THAT KILLS THIS: fall back on 'network' only (the pre-GV-47
       reading of an outage), or drop the fallback's judge tag. Ran both: red. */
    const primary = scriptedPrimary([error]);
    const fallback = qwenFake(0.6);
    const seen: JudgeFallbackInfo[] = [];
    const c = new FallbackJudgeClient(primary, fallback, { onFallback: (i) => seen.push(i) });
    const r = await askOf(c);
    expect(r).toMatchObject({ ok: true, judge: "qwen", answers: [{ id: "supported", noul: 0.6 }] });
    expect(fallback.calls).toHaveLength(1);
    expect(seen).toEqual([{ purpose: "sentence-support", reason: error.reason, breaker: "closed" }]);
  });

  it("a malformed Jev reply, a missing key and a caller's cancel never fall back; each stays tagged jev", async () => {
    /* MUTATION THAT KILLS THIS: treat every {ok:false} as an outage. Ran it: red. */
    for (const error of [outage("malformed", "noul_out_of_range"), outage("no_key", "no_key"), outage("timeout", "aborted")]) {
      const fallback = qwenFake();
      const c = new FallbackJudgeClient(scriptedPrimary([error]), fallback);
      const r = await askOf(c);
      expect(r).toMatchObject({ ok: false, error, judge: "jev" });
      expect(fallback.calls).toHaveLength(0);
    }
    expect(isJudgeOutage({ ok: false, error: outage("timeout", "timeout"), latencyMs: 0 })).toBe(true);
  });

  it("Jev's own answers are tagged jev", async () => {
    /* MUTATION THAT KILLS THIS: return the primary's result untagged. Ran it: red. */
    const c = new FallbackJudgeClient(scriptedPrimary([undefined]), qwenFake());
    expect(await askOf(c)).toMatchObject({ ok: true, judge: "jev", answers: [{ noul: 0.9 }] });
  });
});

describe("FallbackJudgeClient: the circuit breaker on a fake clock", () => {
  it("3 consecutive Jev outages open it for coolOffMs; then one probe, and a success closes it", async () => {
    /* MUTATION THAT KILLS THIS: open on the 2nd outage, or keep asking Jev
       while open, or never leave 'open' after the cool-off. Ran all three: red. */
    const t = clock();
    const down = outage("http", "http_503", 503);
    const primary = scriptedPrimary([down, down, down, undefined, undefined]);
    const fallback = qwenFake();
    const seen: JudgeFallbackInfo[] = [];
    const c = new FallbackJudgeClient(primary, fallback, { breaker: { now: t.now, coolOffMs: 60_000 }, onFallback: (i) => seen.push(i) });
    for (let i = 0; i < 3; i += 1) await askOf(c);
    expect(c.breaker.state).toBe("open");
    expect(primary.calls).toHaveLength(3);

    t.advance(59_999);
    expect(await askOf(c)).toMatchObject({ ok: true, judge: "qwen" });
    expect(primary.calls).toHaveLength(3);
    expect(seen.at(-1)).toEqual({ purpose: "sentence-support", reason: "breaker_open", breaker: "open" });
    expect(c.nextJudge()).toBe("qwen");

    t.advance(1);
    expect(c.breaker.state).toBe("half-open");
    expect(await askOf(c)).toMatchObject({ ok: true, judge: "jev" });
    expect(c.breaker.state).toBe("closed");
    expect(await askOf(c)).toMatchObject({ ok: true, judge: "jev" });
    expect(primary.calls).toHaveLength(5);
  });

  it("an outage while half-open re-opens it at once; a success between outages resets the count", async () => {
    /* MUTATION THAT KILLS THIS: re-open only when the count EQUALS
       failuresToOpen (a half-open outage then never re-opens), or do not
       reset the count on a success. Ran both: red. */
    const t = clock();
    const b = new CircuitBreaker({ now: t.now, failuresToOpen: 3, coolOffMs: 1000 });
    b.recordOutage();
    b.recordOutage();
    b.recordSuccess();
    b.recordOutage();
    b.recordOutage();
    expect(b.state).toBe("closed");
    b.recordOutage();
    expect(b.state).toBe("open");
    t.advance(1000);
    expect(b.state).toBe("half-open");
    b.recordOutage();
    expect(b.state).toBe("open");
    expect(() => new CircuitBreaker({ failuresToOpen: 0 })).toThrow(/failuresToOpen/);
  });
});

describe("judge route resolution (FORAY_STAGE_JUDGE)", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    for (const name of ["JEV_API_KEY", "JEV_KEY_FILE", "FORAY_LLM_BASE_URL", "FORAY_GENERATION_MODE", "FORAY_STAGE_JUDGE", "ANTHROPIC_API_KEY"]) delete process.env[name];
  });
  afterEach(() => {
    process.env = { ...saved };
  });
  const provider = scriptedProvider({ complete: [] });

  it("outside local mode: jev when a Jev key exists (no fallback), else none", () => {
    /* MUTATION THAT KILLS THIS: keep the pre-GV-47 'none' default whatever the
       key. Ran it: red. */
    expect(resolveRouting({}).routes.judge).toEqual({ provider: "none", model: "none" });
    expect(resolveRouting({ JEV_KEY_FILE: "/run/secrets/jev" }).routes.judge).toEqual({ provider: "jev", model: "jev" });
    expect(resolveRouting({ ANTHROPIC_API_KEY: "sk-ant-x", JEV_API_KEY: "k" }).routes.judge).toEqual({ provider: "jev", model: "jev" });
    expect(routingSummary(resolveRouting({ JEV_API_KEY: "k" })).stages.judge).toBe("jev");
  });

  it("no route variable and no key: createJevClient is NullJevClient (today's behaviour)", async () => {
    /* MUTATION THAT KILLS THIS: default the judge to local:second outside
       local mode. Ran it: red (RoutingConfigError: no FORAY_LLM_BASE_URL). */
    const c = createJevClient({ source: {} });
    expect(c).toBeInstanceOf(NullJevClient);
    expect(await askOf(c)).toMatchObject({ ok: false, error: { category: "no_key" } });
  });

  it("a key outside local mode: HttpJevClient, no fallback", () => {
    /* MUTATION THAT KILLS THIS: drop the no-fallback branch (every Jev route
       then builds a fallback). Ran it: red. */
    expect(createJevClient({ apiKey: KEY, source: {} })).toBeInstanceOf(HttpJevClient);
  });

  it("local mode with a Jev key: FallbackJudgeClient(Jev, the Qwen judge on the second box)", () => {
    /* MUTATION THAT KILLS THIS: build the fallback on the Spark lane. Ran it: red. */
    const c = createJevClient({ apiKey: KEY, source: { FORAY_LLM_BASE_URL: BASE_URL }, chatProvider: provider });
    expect(c).toBeInstanceOf(FallbackJudgeClient);
    const f = c as FallbackJudgeClient;
    expect(f.primary).toBeInstanceOf(HttpJevClient);
    expect(f.fallback).toBeInstanceOf(QwenJudgeClient);
    expect(f.fallback).toMatchObject({ lane: "second", model: "local-worker", logprobs: false, providerName: "local:second" });
    expect(f.breaker).toMatchObject({ failuresToOpen: 3, coolOffMs: 60_000 });
  });

  it("local mode without a Jev key: the Qwen judge answers alone", () => {
    /* MUTATION THAT KILLS THIS: return FallbackJudgeClient(NullJevClient, ...)
       (every ask would be no_key, which never falls back). Ran it: red. */
    expect(createJevClient({ source: { FORAY_LLM_BASE_URL: BASE_URL }, chatProvider: provider })).toBeInstanceOf(QwenJudgeClient);
  });

  it("local:spark routes the Qwen judge alone onto the Spark with its logprobs; bare jev drops the fallback", () => {
    /* MUTATION THAT KILLS THIS: ignore the lane profile's logprobs flag. Ran it: red. */
    const local = createJevClient({ source: { FORAY_LLM_BASE_URL: BASE_URL, FORAY_STAGE_JUDGE: "local:spark" }, chatProvider: provider });
    expect(local).toBeInstanceOf(QwenJudgeClient);
    expect(local).toMatchObject({ lane: "spark", model: "local-heavy", logprobs: true });
    expect(createJevClient({ apiKey: KEY, source: { FORAY_LLM_BASE_URL: BASE_URL, FORAY_STAGE_JUDGE: "jev" }, chatProvider: provider })).toBeInstanceOf(HttpJevClient);
  });

  it("a malformed FORAY_STAGE_JUDGE throws naming the variable, never the value", () => {
    /* MUTATION THAT KILLS THIS: let createJevClient swallow a routing error
       and resolve the default table instead. Ran it: red. */
    expect(() => createJevClient({ source: { FORAY_STAGE_JUDGE: "qwen-please" } })).toThrow(/FORAY_STAGE_JUDGE/);
    try {
      createJevClient({ source: { FORAY_STAGE_JUDGE: "qwen-please" } });
    } catch (err) {
      expect((err as Error).message).not.toContain("qwen-please");
    }
  });
});

describe("fail-closed: the 'none' route (contract for every judged gate)", () => {
  it("with the judge route 'none', consumers receive ok:false and judgedPass reads it as not passed", async () => {
    /* MUTATION THAT KILLS THIS: make judgedPass return true for {ok:false}
       (fail-open). Ran it: red. */
    const gates = readGateConfig({});
    const c = createJevClient({ apiKey: KEY, source: { FORAY_STAGE_JUDGE: "none" } });
    expect(c).toBeInstanceOf(NullJevClient);
    const r = await askOf(c);
    expect(r.ok).toBe(false);
    expect(judgedPass(r, "supported", "supportMinP", gates)).toBe(false);
    /* The same holds for every other unjudged result and a missing answer. */
    expect(judgedPass({ ok: false, error: outage("http", "http_503", 503), latencyMs: 3, judge: "qwen" }, "supported", "supportMinP", gates)).toBe(false);
    expect(judgedPass(await askOf(new FakeJevClient({ byId: { supported: noulAnswer(1) } })), "absent", "supportMinP", gates)).toBe(false);
  });
});

describe("per-judge thresholds (gateConfig)", () => {
  it("a lookup for judge 'qwen' never returns the Jev value", () => {
    /* MUTATION THAT KILLS THIS: read `${name}.jev` whatever the judge. Ran it: red. */
    const onlyJev = readGateConfig({ FORAY_SUPPORT_MIN_P_JEV: "0.42", FORAY_CLIP_LEVEL_JEV: "2" });
    expect(judgeThreshold(onlyJev, "supportMinP", "jev")).toBe(0.42);
    expect(judgeThreshold(onlyJev, "supportMinP", "qwen")).toBe(0.7);
    expect(judgeThreshold(onlyJev, "clipLevel", "jev")).toBe(2);
    expect(judgeThreshold(onlyJev, "clipLevel", "qwen")).toBe(3);
    const both = readGateConfig({ FORAY_SUPPORT_MIN_P_JEV: "0.42", FORAY_SUPPORT_MIN_P_QWEN: "0.9" });
    expect(judgeThreshold(both, "supportMinP", "qwen")).toBe(0.9);
    expect(() => judgeThreshold(both, "supportMinP", "code" as never)).toThrow(/unknown judge/);
    expect(() => readGateConfig({ FORAY_SUPPORT_MIN_P_QWEN: "1.5" })).toThrow("Invalid value for environment variable FORAY_SUPPORT_MIN_P_QWEN");
    expect(() => readGateConfig({ FORAY_CLIP_LEVEL_QWEN: "2.5" })).toThrow("Invalid value for environment variable FORAY_CLIP_LEVEL_QWEN");
  });

  it("judgedPass reads the answering judge's threshold: the same 0.6 passes Jev's 0.5 and fails the Qwen judge's 0.7", async () => {
    /* MUTATION THAT KILLS THIS: read the threshold for 'jev' when the result
       is tagged qwen. Ran it: red. */
    const gates = readGateConfig({});
    const asJev = await askOf(new FallbackJudgeClient(scriptedPrimary([undefined], 0.6), qwenFake()));
    const asQwen = await askOf(new FallbackJudgeClient(scriptedPrimary([outage("network", "network")]), qwenFake(0.6)));
    expect(judgedPass(asJev, "supported", "supportMinP", gates)).toBe(true);
    expect(judgedPass(asQwen, "supported", "supportMinP", gates)).toBe(false);
    const score = await new FakeJevClient({ byId: { clarity: scoreAnswer(3, 5) } }).ask(STATE, [fx.questions[2]!], { purpose: "clip-judge" });
    expect(judgedPass({ ...score, judge: "qwen" } as JevResult, "clarity", "clipLevel", gates)).toBe(true);
  });
});

describe("meteredJevClient: the judge tag and the charge follow the judge that answers", () => {
  function guard() {
    const sink = new InMemoryCostEventSink();
    return { sink, guard: new BudgetGuard(sink, 100, 100) };
  }

  it("onCall carries judge 'qwen' for a fallback answer and 'jev' otherwise; an open breaker charges the local lane $0", async () => {
    /* MUTATION THAT KILLS THIS: hard-code judge 'jev' in onCall again, or
       charge Jev while the breaker is open. Ran both: red. */
    const t = clock();
    const down = outage("timeout", "timeout");
    const qwen = new QwenJudgeClient({
      provider: scriptedProvider({ complete: () => '{"answers":{"supported":{"noul":0.4}}}' }),
      model: "local-worker",
      lane: "second",
      structuredOutput: "json_schema",
      logprobs: false
    });
    const fallback = new FallbackJudgeClient(scriptedPrimary([undefined, down, down, down]), qwen, { breaker: { now: t.now } });
    const { sink, guard: g } = guard();
    const seen: JevCallInfo[] = [];
    const c = meteredJevClient(fallback, { guard: g, userId: "u1", onCall: (i) => seen.push(i) });
    for (let i = 0; i < 5; i += 1) await askOf(c);
    expect(seen.map((s) => s.judge)).toEqual(["jev", "qwen", "qwen", "qwen", "qwen"]);
    const events = await sink.all();
    expect(events.map((e) => e.provider)).toEqual(["jev", "jev", "jev", "jev", "local:second"]);
    expect(events.at(-1)).toMatchObject({ model: "local-worker", estimatedUsd: 0 });
  });
});

describe("jevSmoke (the Jev live step) asks Jev itself, whatever the judge route", () => {
  const saved = { ...process.env };
  const ENV_NAMES = ["JEV_API_KEY", "JEV_KEY_FILE", "FORAY_LLM_BASE_URL", "FORAY_GENERATION_MODE", "FORAY_STAGE_JUDGE", "ANTHROPIC_API_KEY"];
  beforeEach(() => {
    for (const name of ENV_NAMES) delete process.env[name];
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /* A global fetch that records the URL and refuses: nothing leaves the machine. */
  function refusingFetch(): string[] {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      urls.push(url);
      return Promise.reject(new Error("offline test: no network"));
    });
    return urls;
  }

  it.each([
    ["local mode by FORAY_LLM_BASE_URL (the routed judge is FallbackJudgeClient)", { FORAY_LLM_BASE_URL: BASE_URL }],
    ["FORAY_GENERATION_MODE=local without a base URL (routing would throw)", { FORAY_GENERATION_MODE: "local" }]
  ])("%s: with a key it sends to Jev, not 'no Jev key'", async (_label, extra) => {
    /* MUTATION THAT KILLS THIS: call the routed createJevClient() in
       jevSmoke.ts again (first row: FallbackJudgeClient, so 'no Jev key' and
       no request; second row: RoutingConfigError). Ran it: red. */
    Object.assign(process.env, { JEV_API_KEY: KEY }, extra);
    const urls = refusingFetch();
    const { main } = await import("../src/cli/jevSmoke");
    expect(await main(["--runs", "1"])).toBe(1);
    expect(urls).toHaveLength(3);
    expect(urls.every((u) => u === "https://api.typesafe.ai/v1/systemone")).toBe(true);
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("no Jev key"));
  });

  it("without a key it exits 1 and sends nothing", async () => {
    /* MUTATION THAT KILLS THIS: drop the HttpJevClient check in jevSmoke.ts
       (NullJevClient would be asked). Ran it: red. */
    process.env.FORAY_LLM_BASE_URL = BASE_URL;
    const urls = refusingFetch();
    const { main } = await import("../src/cli/jevSmoke");
    expect(await main(["--runs", "1"])).toBe(1);
    expect(urls).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("no Jev key"));
  });
});
