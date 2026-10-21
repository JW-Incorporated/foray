import { describe, it, expect } from "vitest";
import {
  CLIP_CHOICE_NONE,
  CLIP_CHOICE_PURPOSE,
  CLIP_CHOICE_QUESTION_ID,
  CLIP_JUDGE_PURPOSE,
  CodeProxyClipJudge,
  JevClipJudge,
  NullClipJudge,
  clipChoiceFromResult,
  type ClipChoiceOutcome,
  type ClipChoiceQuestion,
  type ClipJudge,
  type ClipQuestion
} from "../src/generation/clipJudge";
import { PREJUDGE_CONCURRENCY, ClipVerdictBookSchema, prejudgeClips, summarizeClipVerdicts, type ClipVerdictBook } from "../src/generation/prejudgeClips";
import { beatJudgeCandidates, beatVerdictKey, type BeatCandidateSet } from "../src/generation/sourceBeats";
import { readGateConfig } from "../src/generation/gateConfig";
import { CHECKPOINT_STAGE_ORDER, ROUTED_STAGE_FIRST_CHECKPOINT, checkpointFingerprint, stagesAtOrAfter } from "../src/generation/checkpoint";
import { runForayPipeline } from "../src/generation/runPipeline";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import { RunLog, currentCallContext, runWithRunLog } from "../src/generation/runLog";
import { loadSegmentPool, type SegmentRecord } from "../src/generation/segmentPoolLookup";
import { deriveItemId, loadTranscriptArchive, type TranscriptCue, type TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";
import { FileTranscriptTextIndex, type TranscriptBodySource } from "../src/generation/transcriptTextIndex";
import { BudgetExceededError } from "../src/cost/budgetGuard";
import type { FinalizeForayInput, FinalizeForayResult } from "../src/generation/finalizeForay";
import type { GenerationRequest } from "../src/types/generation";
import type { DeepenedAct } from "../src/types/spine";
import type { JevResult } from "../src/generation/jevTypes";
import { FakeJevClient, choiceAnswer, scoreAnswer } from "./helpers/fakeJevClient";
import { FakeCheckpointStore } from "./helpers/fakeCheckpointStore";

/**
 * GV-107 (docs/roadmap/generation-v2.md, W5-04; R1-20, R2-03): the async
 * pre-judge. One choice per beat over the candidate windows
 * `beatJudgeCandidates` enumerates, then the two clip Scores on the choice's
 * top K, banked as a `clip-judge` stage under FORAY_CLIP_JUDGE=enforce only.
 *
 * Offline: every judge is a FakeJevClient, a scripted ClipJudge or the
 * keyless proxy, and every body is synthetic (the FakeBodySource pattern of
 * transcriptTextIndex.test.ts). Nothing reaches Jev, the Spark or a network
 * model. Each test names the mutation it kills; each was run red.
 */

const SUBJECT = "wind turbine reliability (why gearboxes fail)";
const CLAIM = "Wind turbine gearboxes fail early because their bearings take torque reversals the load case never modelled.";

function entry(guid: string, title: string): TranscriptDigestEntry {
  return { show_id: "practical-ai", show_title: "Practical AI", guid, title, cues: 4, feed_duration_sec: 3600, enclosure_url: `https://cdn.example/${guid}.mp3` };
}

/** Synthetic bodies in memory: the text index's source and the cue provider. */
function bodies(cuesByGuid: Record<string, TranscriptCue[]>): TranscriptBodySource {
  return {
    getCues: (e) => cuesByGuid[e.guid] ?? null,
    bodyStat: (e) => (cuesByGuid[e.guid] ? { mtimeMs: 1, size: 1 } : null)
  };
}

function cues(lines: string[], step = 20): TranscriptCue[] {
  return lines.map((text, i) => ({ text, start_sec: i * step, end_sec: i * step + step }));
}

/* Three episodes: one on the claim, one half on it, one off it. */
const ON = entry("pa-on", "Episode 1");
const HALF = entry("pa-half", "Episode 2");
const OFF = entry("pa-off", "Episode 3");
const CUES: Record<string, TranscriptCue[]> = {
  "pa-on": cues([
    "welcome back we are at a test facility in denmark",
    "the gearboxes in a wind turbine are where the trouble starts and the bearings give up first",
    "you get reversals of torque that nobody put into the load case back then",
    "so they fail early years before the model said they would",
    "anyway after the break"
  ]),
  "pa-half": cues([
    "today we talk about wind turbine towers and blades",
    "gearboxes come up later but mostly we talk about turbine blades and torque on the tower",
    "the load case for the tower was fine",
    "and that is the show"
  ]),
  "pa-off": cues(["a recipe for bread with a long cold ferment", "flour water salt and patience", "the crust is the whole point"])
};
const ARCHIVE = [ON, HALF, OFF];

function act(beats: Array<{ claim: string; kind?: "account" | "argument"; seed?: { episodeId: string; startSec: number; endSec: number } }>): DeepenedAct {
  return {
    title: "Gearboxes",
    thesis: "Wind turbines fail at the gearbox.",
    startState: "The listener does not know why turbines fail.",
    endState: "The listener knows why gearboxes fail.",
    slots: [{ title: "Gearboxes", beats: beats.map((b) => ({ exploration: false, kind: b.kind ?? "account", ...b })) }],
    introduction: "Intro",
    exit: "Exit"
  };
}

function enumerate(acts: DeepenedAct[]): BeatCandidateSet[] {
  return beatJudgeCandidates(acts, {
    segmentPool: [],
    transcriptArchive: ARCHIVE,
    cueProvider: bodies(CUES),
    textIndex: new FileTranscriptTextIndex({ archive: ARCHIVE, bodies: bodies(CUES), cache: false }),
    topic: "engineering/ai-robotics"
  });
}

/** A Jev that prefers the passage naming the most claim words, and says how
 * likely 'none' is. */
function preferringJev(noneP = 0.05): FakeJevClient {
  return new FakeJevClient({
    rules: [
      {
        when: (_s, q) => q.type === "choice",
        answer: (state) => {
          const passages = (state as { passages: Record<string, string> }).passages;
          const hits = (t: string) => ["gearboxes", "bearings", "torque", "load", "fail"].filter((w) => t.includes(w)).length;
          const raw = Object.fromEntries(Object.entries(passages).map(([id, t]) => [id, hits(t) + 0.01]));
          const sum = Object.values(raw).reduce((a, b) => a + b, 0);
          const probabilities: Record<string, number> = { [CLIP_CHOICE_NONE]: noneP };
          for (const [id, r] of Object.entries(raw)) probabilities[id] = ((1 - noneP) * r) / sum;
          const best = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
          return choiceAnswer(best, probabilities);
        }
      },
      { when: (_s, q) => q.type === "score", answer: scoreAnswer(4, 5) }
    ]
  });
}

function set(key: string, n: number): BeatCandidateSet {
  const [a, s, b] = key.split("/").map(Number) as [number, number, number];
  return {
    actIndex: a,
    slotIndex: s,
    beatIndex: b,
    claim: `claim ${key}`,
    options: Array.from({ length: n }, (_, i) => ({ key: `search:item-${i}#0-1`, mode: "search" as const, itemId: `item-${i}`, startSec: 0, endSec: 40, firstCue: 0, lastCue: 1, text: `passage ${i}`, share: 0.5, floorCleared: true }))
  };
}

describe("GV-107 JevClipJudge.choose", () => {
  /* MUTATION THAT KILLS THIS: send the caller's option keys (episode ids) as
     the passage ids, or drop the 'none' criterion. Ran it: red. */
  it("asks ONE choice with passages o1..oN plus 'none', under its own purpose, and maps the probabilities back onto the keys", async () => {
    const fake = new FakeJevClient({ byId: { [CLIP_CHOICE_QUESTION_ID]: choiceAnswer("o2", { o1: 0.2, o2: 0.7, [CLIP_CHOICE_NONE]: 0.1 }) } });
    const q: ClipChoiceQuestion = { subjectSentence: SUBJECT, claim: CLAIM, options: [{ key: "search:a#0-1", text: "first" }, { key: "pool:b#10", text: "second" }] };
    const out = await new JevClipJudge(fake).choose(q);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.purpose).toBe(CLIP_CHOICE_PURPOSE);
    expect(fake.calls[0]!.state).toEqual({ subject: SUBJECT, claim: CLAIM, passages: { o1: "first", o2: "second" } });
    const question = fake.calls[0]!.questions[0]!;
    expect(question.type).toBe("choice");
    expect(Object.keys(question.type === "choice" ? question.criteria : {})).toEqual(["o1", "o2", CLIP_CHOICE_NONE]);
    expect(out).toEqual({ ranked: [{ key: "pool:b#10", p: 0.7 }, { key: "search:a#0-1", p: 0.2 }], noneP: 0.1, judge: "jev" });
  });

  /* MUTATION THAT KILLS THIS: read a missing option probability as 0 (or skip
     the 'none' check) instead of failing closed. Ran it: red. */
  it("fails closed: an outage, a missing probability or a wrong answer type is unavailable; a budget stop propagates", async () => {
    const options = [{ key: "k1", text: "x" }, { key: "k2", text: "y" }];
    const failure: JevResult = { ok: false, error: { category: "http", reason: "http_503" }, latencyMs: 1 };
    expect(clipChoiceFromResult(failure, options)).toEqual({ unavailable: "http_503" });
    const missing: JevResult = {
      ok: true,
      answers: [{ id: CLIP_CHOICE_QUESTION_ID, type: "choice", choice: "o1", probabilities: { o1: 0.9, [CLIP_CHOICE_NONE]: 0.1 }, confidence: 0.9 }],
      model: "m",
      modelMismatch: false,
      usage: { inputTokens: null, outputTokens: null },
      requestId: null,
      latencyMs: 1
    };
    expect(clipChoiceFromResult(missing, options)).toEqual({ unavailable: "malformed" });
    const noNone: JevResult = { ...missing, answers: [{ id: CLIP_CHOICE_QUESTION_ID, type: "choice", choice: "o1", probabilities: { o1: 0.5, o2: 0.5 }, confidence: 0.5 }] };
    expect(clipChoiceFromResult(noNone, options)).toEqual({ unavailable: "malformed" });
    const wrongType: JevResult = { ...missing, answers: [{ id: CLIP_CHOICE_QUESTION_ID, type: "noul", noul: 0.4 }] };
    expect(clipChoiceFromResult(wrongType, options)).toEqual({ unavailable: "malformed" });

    const broken = { ask: async () => Promise.reject(new Error("socket")) };
    expect(await new JevClipJudge(broken).choose({ subjectSentence: SUBJECT, claim: CLAIM, options })).toEqual({ unavailable: "threw" });
    const budget = { ask: async () => Promise.reject(new BudgetExceededError(1, 0.1, 1)) };
    await expect(new JevClipJudge(budget).choose({ subjectSentence: SUBJECT, claim: CLAIM, options })).rejects.toBeInstanceOf(BudgetExceededError);
  });

  /* MUTATION THAT KILLS THIS: give the code proxy a word-overlap choice (or
     let the null judge answer). Ran it: red. */
  it("the keyless proxy and the null judge never choose: unavailable, so GV-119 walks as today", async () => {
    const q: ClipChoiceQuestion = { subjectSentence: SUBJECT, claim: CLAIM, options: [{ key: "k", text: "gearboxes fail" }] };
    expect(await new CodeProxyClipJudge().choose()).toEqual({ unavailable: "no-judge" });
    expect(await new NullClipJudge().choose()).toEqual({ unavailable: "off" });
    expect(await new JevClipJudge(new FakeJevClient()).choose({ ...q, options: [] })).toEqual({ unavailable: "no-options" });
  });
});

describe("GV-107 prejudgeClips", () => {
  /* MUTATION THAT KILLS THIS: score every ranked window (drop the
     slice(0, topK)), or ask the choice per window. Ran it: red. */
  it("on synthetic multi-episode bodies: one choice per beat, Scores on at most topK windows, the on-claim passage first", async () => {
    const sets = enumerate([act([{ claim: CLAIM }, { claim: "Turbine towers carry the load case of the blades and the torque." }])]);
    expect(sets).toHaveLength(2);
    for (const s of sets) expect(s.options.length).toBeGreaterThanOrEqual(2);
    const fake = preferringJev();
    const book = await prejudgeClips(sets, new JevClipJudge(fake), { subjectSentence: SUBJECT, topK: 1 });

    expect(fake.callsFor(CLIP_CHOICE_PURPOSE)).toHaveLength(2);
    expect(fake.callsFor(CLIP_JUDGE_PURPOSE)).toHaveLength(2 * 1);
    expect(Object.keys(book)).toEqual(["0/0/0", "0/0/1"]);
    const first = book["0/0/0"]!;
    if ("unavailable" in first) throw new Error("expected a judged verdict");
    expect(first.ranked[0]!.key).toMatch(/practical-ai--episode-1#/);
    expect(first.ranked).toHaveLength(sets[0]!.options.length);
    expect(Object.keys(first.windowScores)).toEqual([first.ranked[0]!.key]);
    expect(first.windowScores[first.ranked[0]!.key]).toEqual({ subject: 4, claim: 4, confidence: 1, judge: "jev" });
    /* What the scorer read is the option's own passage. */
    const scored = fake.callsFor(CLIP_JUDGE_PURPOSE).map((c) => (c.state as { passage: string }).passage);
    expect(scored).toContain(sets[0]!.options.find((o) => o.key === first.ranked[0]!.key)!.text);
    /* The book survives the checkpoint's JSON round trip. */
    expect(ClipVerdictBookSchema.parse(JSON.parse(JSON.stringify(book)))).toEqual(book);
    expect(summarizeClipVerdicts(book)).toBe("clip-judge: 2 beat(s) judged, 'none' highest on 0; 0 unavailable");
  });

  /* MUTATION THAT KILLS THIS: Promise.all over every set (no limit). Ran it:
     red (20 in flight). */
  it("holds at most 8 judge calls in flight (a deferred-promise fake)", async () => {
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const hold = async <T>(value: T): Promise<T> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight -= 1;
      return value;
    };
    const judge: ClipJudge = {
      name: "deferred",
      choose: (q: ClipChoiceQuestion) => hold<ClipChoiceOutcome>({ ranked: q.options.map((o, i) => ({ key: o.key, p: 0.5 - i * 0.1 })), noneP: 0.1, judge: "jev" }),
      score: (qs: readonly ClipQuestion[]) => hold(new Map(qs.map((q) => [q.key, { subject: 3, claim: 3, judge: "jev" as const }])))
    };
    const sets = Array.from({ length: 20 }, (_, i) => set(`0/${i}/0`, 3));
    const pending = prejudgeClips(sets, judge, { subjectSentence: SUBJECT, topK: 2 });
    let done = false;
    void pending.then(() => (done = true));
    while (!done) {
      await new Promise((r) => setTimeout(r, 0));
      expect(inFlight).toBeLessThanOrEqual(PREJUDGE_CONCURRENCY);
      releases.splice(0).forEach((r) => r());
    }
    expect(PREJUDGE_CONCURRENCY).toBe(8);
    expect(peak).toBe(8);
    expect(Object.keys(await pending)).toHaveLength(20);
  });

  /* MUTATION THAT KILLS THIS: let a judge's unavailable choice fall through
     to scoring (or rethrow a non-budget error). Ran it: red. */
  it("an unavailable answer is {unavailable} in the book and never throws; a budget stop propagates", async () => {
    const down = new FakeJevClient({ fail: { category: "timeout", reason: "timeout" } });
    const sets = [set("0/0/0", 2), set("0/0/1", 0)];
    const book = await prejudgeClips(sets, new JevClipJudge(down), { subjectSentence: SUBJECT, topK: 2 });
    expect(book).toEqual({ "0/0/0": { unavailable: "timeout" }, "0/0/1": { unavailable: "no-options" } });
    expect(down.calls).toHaveLength(1);

    const thrower: ClipJudge = { name: "t", choose: async () => Promise.reject(new Error("bug")), score: async () => new Map() };
    expect(await prejudgeClips([set("0/0/0", 2)], thrower, { subjectSentence: SUBJECT, topK: 2 })).toEqual({ "0/0/0": { unavailable: "threw" } });
    const scoreOnly: ClipJudge = { name: "spy", score: async () => new Map() };
    expect(await prejudgeClips([set("0/0/0", 2)], scoreOnly, { subjectSentence: SUBJECT, topK: 2 })).toEqual({ "0/0/0": { unavailable: "no-choice" } });
    expect(await prejudgeClips([set("1/0/0", 2)], new CodeProxyClipJudge(), { subjectSentence: SUBJECT, topK: 2 })).toEqual({ "1/0/0": { unavailable: "no-judge" } });

    const broke: ClipJudge = { name: "b", choose: async () => Promise.reject(new BudgetExceededError(1, 0.1, 1)), score: async () => new Map() };
    await expect(prejudgeClips([set("0/0/0", 2)], broke, { subjectSentence: SUBJECT, topK: 2 })).rejects.toBeInstanceOf(BudgetExceededError);
  });

  /* MUTATION THAT KILLS THIS: count a beat where an option ties 'none' as a
     'none' win (>=), or drop the reasons. Ran it: red. */
  it("summarizes how often 'none' beat every passage, and why verdicts are unavailable", () => {
    const book: ClipVerdictBook = {
      "0/0/0": { ranked: [{ key: "a", p: 0.3 }], noneP: 0.7, judge: "jev", windowScores: {} },
      "0/0/1": { ranked: [{ key: "a", p: 0.5 }], noneP: 0.5, judge: "jev", windowScores: {} },
      "0/0/2": { unavailable: "no-options" },
      "0/0/3": { unavailable: "no-options" }
    };
    expect(summarizeClipVerdicts(book)).toBe("clip-judge: 2 beat(s) judged, 'none' highest on 1; 2 unavailable (no-options 2)");
  });
});

describe("GV-107 the gate key and the checkpoint stage", () => {
  /* MUTATION THAT KILLS THIS: default FORAY_CLIP_JUDGE_TOP_K to anything but
     2, or accept a non-integer. Ran it: red. */
  it("FORAY_CLIP_JUDGE_TOP_K defaults to 2 and is an integer 0..20", () => {
    expect(readGateConfig({}).clipJudgeTopK).toBe(2);
    expect(readGateConfig({ FORAY_CLIP_JUDGE_TOP_K: "4" }).clipJudgeTopK).toBe(4);
    expect(() => readGateConfig({ FORAY_CLIP_JUDGE_TOP_K: "2.5" })).toThrow(/FORAY_CLIP_JUDGE_TOP_K/);
    expect(() => readGateConfig({ FORAY_CLIP_JUDGE_TOP_K: "21" })).toThrow(/FORAY_CLIP_JUDGE_TOP_K/);
  });

  /* MUTATION THAT KILLS THIS: list `clip-judge` after `source` (a rerun from
     `source` would then rebuild the book from scratch, and a fork that changes
     the judge route could keep another judge's book). Ran it: red. */
  it("clip-judge sits between deepen and source, and the judge route's first banked stage is clip-judge", () => {
    const order = CHECKPOINT_STAGE_ORDER as readonly string[];
    expect(order.indexOf("clip-judge")).toBe(order.indexOf("deepen") + 1);
    expect(order.indexOf("source")).toBe(order.indexOf("clip-judge") + 1);
    expect(stagesAtOrAfter(["deepen:0", "clip-judge", "clip-judge:1", "source"], "source")).toEqual(["source"]);
    expect(stagesAtOrAfter(["deepen:0", "clip-judge", "clip-judge:1", "source"], "clip-judge")).toEqual(["clip-judge", "clip-judge:1", "source"]);
    expect(ROUTED_STAGE_FIRST_CHECKPOINT.judge).toBe("clip-judge");
  });
});

/* ------------------------------------------------------------------------- *
 * runForayPipeline's wiring, on stub runs. The pool's items get synthetic
 * digest rows whose derived id IS the pool item id (so the pool's window text
 * can be read), and the cue provider answers ONLY inside a `clip-judge` stage
 * (read from the call context): sourcing, evidence and narration see no
 * transcript, exactly as in every other stub run, and the judge sees pool
 * passages. The judge is scripted and records the stage it was asked in.
 * ------------------------------------------------------------------------- */

const request: GenerationRequest = { prompt: "the history of grilling and barbecue", duration: "short", author_id: "founder-1", visibility: "catalogue" };
const KEY = "gv107-wiring";
const FP = checkpointFingerprint({ prompt: request.prompt, duration: request.duration });

function stubDeps() {
  const finalize = async (input: FinalizeForayInput): Promise<FinalizeForayResult> =>
    ({
      validation: { ok: true, checkForaysErrors: [], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] },
      forayRecord: { id: input.id, generated: true } as never,
      timings: []
    }) as unknown as FinalizeForayResult;
  return {
    understander: new StubPromptUnderstander(),
    researcher: new StubExternalResearcher(),
    spineBuilder: new StubSpineBuilder(),
    deepenBuilder: new StubDeepenActBuilder(),
    narrationWriter: new StubNarrationWriterBuilder(),
    narrationVerifier: new StubNarrationVerifierBuilder(),
    continuityBuilder: new StubContinuityBuilder(),
    finalize
  };
}

let wiringFixture: {
  segmentPool: SegmentRecord[];
  transcriptArchive: TranscriptDigestEntry[];
  cueProvider: { getCues: (e: TranscriptDigestEntry) => TranscriptCue[] | null };
  asked: string[];
} | null = null;
/** The real pool's food rows, re-homed under `gv107--<item>` so a synthetic
 * digest row derives each item id (the committed food items carry no
 * `<show>--` prefix, so no digest row could), each with a body made of its
 * own segments' metadata. Sourcing sees the same pool on every run here. */
function poolPassages() {
  if (wiringFixture) return wiringFixture;
  const segmentPool: SegmentRecord[] = loadSegmentPool()
    .filter((seg) => seg.topic.startsWith("food/") && /^[a-z0-9-]+$/.test(seg.item_id))
    .map((seg) => ({ ...seg, item_id: `gv107--${seg.item_id}`, id: `gv107--${seg.item_id}#${Math.round(seg.start_sec)}` }));
  const textByItem = new Map<string, string>();
  for (const seg of segmentPool) textByItem.set(seg.item_id, `${textByItem.get(seg.item_id) ?? ""} ${seg.topic.replace(/[/-]/g, " ")} ${seg.why} ${seg.start_anchor} ${seg.end_anchor}`);
  const rows: TranscriptDigestEntry[] = [];
  for (const id of textByItem.keys()) {
    const row: TranscriptDigestEntry = { show_id: "gv107", show_title: "x", guid: `gv107-${id}`, title: id.slice("gv107--".length).replace(/-/g, " "), cues: 1 };
    if (deriveItemId(row) === id) rows.push(row);
  }
  const asked: string[] = [];
  wiringFixture = {
    segmentPool,
    transcriptArchive: [...loadTranscriptArchive(), ...rows],
    asked,
    cueProvider: {
      getCues: (e: TranscriptDigestEntry) => {
        const stage = currentCallContext().stage ?? "";
        if (!stage.startsWith("clip-judge") || !e.guid.startsWith("gv107-")) return null;
        asked.push(stage);
        return [{ start_sec: 0, end_sec: 1_000_000, text: textByItem.get(e.guid.slice("gv107-".length)) ?? "" }];
      }
    }
  };
  return wiringFixture;
}

function scriptedJudge() {
  const chooseStages: string[] = [];
  const judge = {
    name: "scripted",
    chooseStages,
    scoreCalls: 0,
    async choose(q: ClipChoiceQuestion): Promise<ClipChoiceOutcome> {
      chooseStages.push(currentCallContext().stage ?? "");
      return { ranked: q.options.map((o, i) => ({ key: o.key, p: Math.max(0, 0.8 - i * 0.1) })), noneP: 0.05, judge: "jev" };
    },
    async score(qs: readonly ClipQuestion[]) {
      judge.scoreCalls++;
      return new Map(qs.map((q) => [q.key, { subject: 4, claim: 4, judge: "jev" as const }]));
    }
  };
  return judge;
}

const run = (gates: Record<string, unknown>, flags: Record<string, unknown>, deps: Record<string, unknown>, req: GenerationRequest = request) =>
  runWithRunLog(new RunLog(), () =>
    runForayPipeline(req, { userId: "u", checkpointKey: KEY, now: () => new Date("2026-10-20T00:00:00Z"), gates, flags } as never, { ...stubDeps(), ...deps } as never)
  );

describe("GV-107 runForayPipeline: the clip-judge stage", () => {
  /* MUTATION THAT KILLS THIS: run the pre-judge whenever the clip judge is
     not `off` (shadow too), or drop the stage from the classic path. Ran it:
     red. */
  it("off and shadow build no candidate sets; enforce banks a book of every beat before `source`, and the Foray is unchanged", async () => {
    const fixture = poolPassages();
    const offJudge = scriptedJudge();
    const off = await run({ clipJudge: "off" }, {}, { ...fixture, clipJudge: offJudge, checkpoint: new FakeCheckpointStore(FP) });
    const shadowJudge = scriptedJudge();
    const shadow = await run({ clipJudge: "shadow" }, {}, { ...fixture, clipJudge: shadowJudge, checkpoint: new FakeCheckpointStore(FP) });
    expect(offJudge.chooseStages).toEqual([]);
    expect(shadowJudge.chooseStages).toEqual([]);
    for (const out of [off, shadow]) expect(out.timings.some((t) => t.name.startsWith("clip-judge"))).toBe(false);
    expect(fixture.asked).toEqual([]);

    const store = new FakeCheckpointStore(FP);
    const judge = scriptedJudge();
    const enforce = await run({ clipJudge: "enforce" }, {}, { ...fixture, clipJudge: judge, checkpoint: store });
    if (off.outcome !== "generated" || enforce.outcome !== "generated") throw new Error("expected both to generate");
    const saves = store.saves.map((s) => s.stage);
    expect(saves.indexOf("clip-judge")).toBeGreaterThan(-1);
    expect(saves.indexOf("clip-judge")).toBeLessThan(saves.indexOf("source"));
    expect(judge.chooseStages.length).toBeGreaterThan(0);
    expect(new Set(judge.chooseStages)).toEqual(new Set(["clip-judge"]));
    const book = ClipVerdictBookSchema.parse(store.files.get(KEY)!.stages["clip-judge"]);
    expect(Object.keys(book).length).toBeGreaterThan(0);
    for (const key of Object.keys(book)) expect(key).toMatch(/^\d+\/\d+\/\d+$/);
    expect(Object.values(book).filter((v) => !("unavailable" in v))).toHaveLength(judge.chooseStages.length);
    /* Until GV-119 reads the book, enforce sources exactly what off does. */
    expect(enforce.input.items).toEqual(off.input.items);
    expect(enforce.input.segments).toEqual(off.input.segments);
  }, 180_000);

  /* MUTATION THAT KILLS THIS: run the pre-judge outside `stage` (no
     checkpoint). Ran it: red (the resumed run asks the judge again). */
  it("a banked clip-judge resumes with zero judge calls", async () => {
    const fixture = poolPassages();
    const store = new FakeCheckpointStore(FP);
    const first = scriptedJudge();
    await run({ clipJudge: "enforce" }, {}, { ...fixture, clipJudge: first, checkpoint: store });
    expect(first.chooseStages.length).toBeGreaterThan(0);
    const again = scriptedJudge();
    const resumed = await run({ clipJudge: "enforce" }, {}, { ...fixture, clipJudge: again, checkpoint: store });
    expect(again.chooseStages).toEqual([]);
    expect(resumed.timings.find((t) => t.name === "clip-judge")?.resumed).toBe(true);
  }, 180_000);

  /* MUTATION THAT KILLS THIS: judge every act up front on the per-act path
     (or not at all). Ran it: red. */
  it("per-act: each act is judged in its own clip-judge:<i> stage just before it is sourced, act 0 first", async () => {
    const fixture = poolPassages();
    const medium: GenerationRequest = { ...request, duration: "medium" };
    const store = new FakeCheckpointStore(checkpointFingerprint({ prompt: medium.prompt, duration: medium.duration }));
    const judge = scriptedJudge();
    const out = await run({ clipJudge: "enforce" }, { perActPipeline: true }, { ...fixture, clipJudge: judge, checkpoint: store }, medium);
    if (out.outcome !== "generated") throw new Error("expected the per-act run to generate");
    const saves = store.saves.map((s) => s.stage);
    const judged = saves.filter((s) => s.startsWith("clip-judge:"));
    expect(judged.length).toBeGreaterThan(1);
    judged.forEach((name, i) => {
      expect(name).toBe(`clip-judge:${i}`);
      expect(saves.indexOf(name)).toBeLessThan(saves.indexOf(`source:${i}`));
    });
    expect(judge.chooseStages[0]).toBe("clip-judge:0");
    for (const [i] of judged.entries()) {
      const book = ClipVerdictBookSchema.parse(store.files.get(KEY)!.stages[`clip-judge:${i}`]);
      for (const key of Object.keys(book)) expect(key.startsWith(`${i}/`)).toBe(true);
    }
    expect(saves).not.toContain("clip-judge");
  }, 180_000);
});

/* Keep the key helper honest: the book's key and the enumeration's agree. */
describe("GV-107 beatVerdictKey", () => {
  /* MUTATION THAT KILLS THIS: key the book with ':' (scoreClips' row key).
     Ran it: red. */
  it("is act/slot/beat", () => {
    expect(beatVerdictKey({ actIndex: 2, slotIndex: 1, beatIndex: 0 })).toBe("2/1/0");
  });
});
