import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_QUESTION,
  JUDGE_QUESTIONS_VERSION,
  PROMPT_FIT_QUESTION,
  SEAM_QUESTION,
  createArchiveClipWindows,
  judgeCandidate,
  judgedPathFor,
  main,
  overviewOf,
  parseJudgeArgs,
  readCandidate,
  resolvePrompt,
  type ClipWindowSource,
  type JudgeCandidateDeps,
  type JudgedFile
} from "../src/cli/judgeCandidate";
import { UnitBudgetGuard, UnitBudgetStopError } from "../src/cost/unitBudget";
import { CLIP_QUESTIONS } from "../src/generation/clipJudge";
import { readGateConfig } from "../src/generation/gateConfig";
import { FallbackJudgeClient, HttpJevClient, parseJevReply, type JevFetch } from "../src/generation/jevClient";
import type { JevClient, JevQuestion, JevState } from "../src/generation/jevTypes";
import { RunLog, runWithRunLog } from "../src/generation/runLog";
import { supportQuestions } from "../src/generation/sentenceSupport";
import type { TranscriptCue, TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";
import { PRELUDE_BOILERPLATE } from "../src/types/narration";
import { FakeJevClient, type FakeJevAnswer } from "./helpers/fakeJevClient";

/**
 * GV-92 (W1-18; MQ-10, MQ-12, MQ-02, MQ-03, MQ-05): the offline judged pass
 * over one candidate. Every judge here replays the committed synthetic bodies
 * in fixtures/jev-recorded-judge-v1.json, through FakeJevClient (GV-20) or
 * through HttpJevClient over a scripted fetch; the clip windows come from an
 * inline cue provider. No test reaches Jev, the Spark or any network model.
 */

interface FixtureBody {
  model: string;
  answers: Array<Record<string, unknown>>;
  usage: Record<string, number>;
}
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "jev-recorded-judge-v1.json"), "utf8")) as {
  questionsVersion: string;
  bodies: Record<string, FixtureBody>;
};

/* ---- the synthetic candidate ---- */

const PROMPT = "Why does a slow overnight fermentation make sourdough taste better";
const OVERVIEW = "We follow one loaf from starter to crust, and hear two bakers disagree about what matters most.";

const CUE_TEXT = {
  a1: "The cold proof is the whole secret of the loaf.",
  a2: "Twelve hours in the fridge lets the acids build the flavour.",
  b1: "Honestly I think the oven matters more than any proof."
};

const RAW_CANDIDATE = {
  id: "synth-bread",
  title: "Slow Bread",
  slots: [
    { id: "cold-proof", title: "The cold proof" },
    { id: "the-oven", title: "The oven" }
  ],
  items: [
    { type: "narration", id: "prelude", mode: "marker", script: `This is a Foray about sourdough. ${PRELUDE_BOILERPLATE} ${OVERVIEW}` },
    { type: "narration", id: "act-1-introduction", mode: "intro", script: "Baker Ada Marsh explains why the dough waits overnight." },
    { type: "segment", segment_id: "seg-a", slot: "cold-proof" },
    {
      type: "narration",
      id: "seam-1",
      mode: "carry",
      script: "The cold proof gives the loaf its flavour. Ben Ortiz says the oven decides the rest.",
      cites: [{ kind: "tape", segment_id: "seg-a" }]
    },
    { type: "segment", segment_id: "seg-b", slot: "the-oven" },
    { type: "jingle", id: "jingle-1" },
    { type: "narration", id: "seam-2", mode: "hinge", script: "Meanwhile the market for flour kept changing." },
    { type: "segment", segment_id: "seg-c", slot: "the-oven" },
    { type: "narration", id: "act-2-exit", mode: "marker", script: "That is where the loaf ends up." }
  ],
  segments: [{ id: "seg-a", itemId: "synth--bread-one", startSec: 0, endSec: 60, boundary: "turn" }]
};

const POOL = [
  { id: "seg-b", item_id: "synth--bread-two", start_sec: 10, end_sec: 50 },
  { id: "seg-c", item_id: "synth--no-such-episode", start_sec: 0, end_sec: 30 }
];

const ARCHIVE: TranscriptDigestEntry[] = [
  { show_id: "synth", show_title: "Synth Bakes", guid: "g1", title: "Bread one", cues: 3 },
  { show_id: "synth", show_title: "Synth Bakes", guid: "g2", title: "Bread two", cues: 2 }
];

const CUES: Record<string, TranscriptCue[]> = {
  g1: [
    { text: "Welcome back to the show.", start_sec: 0, end_sec: 5, speaker: "Host" },
    { text: CUE_TEXT.a1, start_sec: 5, end_sec: 30, speaker: "Ada Marsh" },
    { text: CUE_TEXT.a2, start_sec: 30, end_sec: 58, speaker: "Ada Marsh" },
    { text: "Outside the clip.", start_sec: 61, end_sec: 70, speaker: "Host" }
  ],
  g2: [
    { text: "Before the clip.", start_sec: 0, end_sec: 9, speaker: "Carla Diaz" },
    { text: CUE_TEXT.b1, start_sec: 12, end_sec: 40, speaker: "Carla Diaz" }
  ]
};

const CATALOGUE = { items: [], itemTags: {}, concepts: {}, shows: [] };

function windows(candidate = readCandidate(RAW_CANDIDATE)): ClipWindowSource {
  return createArchiveClipWindows({
    candidate,
    pool: POOL,
    archive: ARCHIVE,
    catalogue: CATALOGUE,
    cueProvider: { getCues: (entry) => CUES[entry.guid] ?? null }
  });
}

/* ---- replaying the fixture ---- */

/** Which committed body answers one ask (by the questions asked and the state's content). */
function bodyFor(state: JevState, questions: readonly JevQuestion[]): FixtureBody {
  const s = state as Record<string, unknown>;
  const first = questions[0]!.id;
  const has = (field: string, needle: string): boolean => JSON.stringify(s[field] ?? "").includes(needle);
  if (first === PROMPT_FIT_QUESTION.id) return FIXTURE.bodies.promptFit!;
  if (first === SEAM_QUESTION.id) return has("handoff", "cold proof") ? FIXTURE.bodies.seamStrong! : FIXTURE.bodies.seamWeak!;
  if (first === ATTRIBUTION_QUESTION.id) return has("speakers", "Ada Marsh") ? FIXTURE.bodies.speakerMatch! : FIXTURE.bodies.speakerMismatch!;
  if (first === CLIP_QUESTIONS[0]!.id) return has("passage", "cold proof") ? FIXTURE.bodies.clipOnSubject! : FIXTURE.bodies.clipOffSubject!;
  if (first === "supported") return has("sentence", "cold proof") ? FIXTURE.bodies.supported! : FIXTURE.bodies.borderline!;
  throw new Error(`no fixture body for ${first}`);
}

/** FakeJevClient (GV-20) answering every question from its ask's committed body. */
function replayFake(): FakeJevClient {
  return new FakeJevClient({
    rules: [
      {
        when: () => true,
        answer: (state, q) => {
          /* The question's position in its ask: support asks two (supported, restsOn), the clip judge two (subject, claim). */
          const index = q.id === "restsOn" || q.id === CLIP_QUESTIONS[1]!.id ? 1 : 0;
          const asked: JevQuestion[] = q.id === "restsOn" ? supportQuestions(["s1"]) : q.id === CLIP_QUESTIONS[1]!.id ? [...CLIP_QUESTIONS] : [q];
          return bodyFor(state, asked).answers[index] as unknown as FakeJevAnswer;
        }
      }
    ]
  });
}

/** Jev's own client over a scripted fetch replaying the committed bodies. */
function replayHttp(): { client: HttpJevClient; requests: Array<{ state: JevState; questions: JevQuestion[] }> } {
  const requests: Array<{ state: JevState; questions: JevQuestion[] }> = [];
  const fetchImpl: JevFetch = async (_url, init) => {
    const sent = JSON.parse(init.body) as { state: JevState; questions: JevQuestion[] };
    requests.push(sent);
    const body = JSON.stringify(bodyFor(sent.state, sent.questions));
    return { ok: true, status: 200, headers: { get: () => `rec-${requests.length}` }, text: async () => body };
  };
  return { client: new HttpJevClient({ apiKey: "test-key-not-real", fetchImpl }), requests };
}

const GATES = readGateConfig({});

function deps(client: JevClient, extra: Partial<JudgeCandidateDeps> = {}): JudgeCandidateDeps {
  return { client, windows: windows(), unitGuard: new UnitBudgetGuard(), gates: GATES, ...extra };
}

const input = () => ({ candidate: readCandidate(RAW_CANDIDATE), prompt: PROMPT, promptId: "g99", tier: "short" });

describe("GV-92 the committed judge fixture", () => {
  /* MUTATION THAT KILLS THIS: change a score body's probabilities to keys
     '1'..'5' (or drop a choice key). Ran it: red, parseJevReply refuses it. */
  it("every body is a valid /v1/systemone reply to the questions it answers", () => {
    expect(FIXTURE.questionsVersion).toBe(JUDGE_QUESTIONS_VERSION);
    const asked: Record<string, JevQuestion[]> = {
      promptFit: [PROMPT_FIT_QUESTION],
      seamStrong: [SEAM_QUESTION],
      seamWeak: [SEAM_QUESTION],
      speakerMatch: [ATTRIBUTION_QUESTION],
      speakerMismatch: [ATTRIBUTION_QUESTION],
      clipOnSubject: [...CLIP_QUESTIONS],
      clipOffSubject: [...CLIP_QUESTIONS],
      supported: supportQuestions(["s1"]),
      borderline: supportQuestions(["s1"])
    };
    expect(Object.keys(FIXTURE.bodies).sort()).toEqual(Object.keys(asked).sort());
    for (const [name, questions] of Object.entries(asked)) {
      const parsed = parseJevReply(JSON.stringify(FIXTURE.bodies[name]), questions);
      expect(parsed.ok, name).toBe(true);
    }
  });
});

describe("GV-92 judgeCandidate with the recorded bodies", () => {
  /* MUTATION THAT KILLS THIS: in judgeCandidate, read MQ-10's Score without
     the +1 (0-4 instead of 1-5). Ran it: red on MQ-10 (3 instead of 4) and
     MQ-12 (2.5 instead of 3.5). Also: drop the jingle skip in prevClip (seam-2
     then follows a jingle and is not a seam): red on MQ-12. */
  it("writes the expected MQ-10, MQ-12, MQ-03, MQ-05 and MQ-02 values", async () => {
    const judged = await judgeCandidate(input(), deps(replayFake()));
    expect(judged.questionsVersion).toBe("judge-questions/1");
    expect(judged.candidateId).toBe("synth-bread");
    expect(judged.promptId).toBe("g99");
    expect(judged.provider).toBe("jev");
    expect(judged.model).toBe("jev-1.13.0");
    expect(judged.calibrated).toBe(false);
    expect(judged["MQ-10"]).toEqual({ value: 4, scored: 1, unscored: 0 });
    /* seam-1 strong (5), seam-2 weak (2) after the jingle; the exit follows seg-c, which has no transcript. */
    expect(judged["MQ-12"]).toEqual({ value: 3.5, scored: 2, unscored: 1 });
    /* intro names Ada Marsh (match), seam-1 names Ben Ortiz before Carla Diaz (mismatch), seam-2's clip has no transcript. */
    expect(judged["MQ-03"]).toEqual({ value: 0.5, scored: 2, unscored: 1, passed: 1, unnamed: 0 });
    /* seg-a on subject (4 >= 3), seg-b off (1), seg-c unscored. */
    expect(judged["MQ-05"]).toEqual({ value: 0.5, scored: 2, unscored: 1, passed: 1 });
    /* seam-1's two sentences against seg-a: 0.9 and 0.6, both >= Jev's 0.5. */
    expect(judged["MQ-02"].value).toBe(1);
    expect(judged["MQ-02"].scored).toBe(2);
    expect(judged["MQ-02"].unscored).toBe(0);
    expect(judged["MQ-02"].uncited).toBeGreaterThan(0);
    const keys = judged.perItem.map((r) => `${r.metric} ${r.key}`);
    expect(keys).toContain("MQ-12 act-2-exit");
    expect(judged.perItem.find((r) => r.metric === "MQ-12" && r.key === "act-2-exit")?.unavailable).toBe("no-transcript");
    expect(judged.perItem.find((r) => r.metric === "MQ-05" && r.key === "2:seg-a")).toMatchObject({ subject: 4, claim: 3, level: 3, pass: true, provider: "jev" });
  });

  /* MUTATION THAT KILLS THIS: send the whole clip window instead of
     lastWords(..., SEAM_CONTEXT_WORDS) as the seam's clipEnd. Ran it: red,
     the cue before the last 150 words reaches the judge. */
  it("asks each seam about the clip's last ~150 words and the seam script only", async () => {
    const long = Array.from({ length: 400 }, (_, i) => `w${i}`).join(" ");
    const cues: Record<string, TranscriptCue[]> = { ...CUES, g1: [{ text: `EARLYMARK ${long}`, start_sec: 1, end_sec: 59, speaker: "Ada Marsh" }] };
    const fake = replayFake();
    const candidate = readCandidate(RAW_CANDIDATE);
    const w = createArchiveClipWindows({ candidate, pool: POOL, archive: ARCHIVE, catalogue: CATALOGUE, cueProvider: { getCues: (e) => cues[e.guid] ?? null } });
    await judgeCandidate(input(), deps(fake, { windows: w }));
    const seam = fake.calls.find((c) => c.purpose === "judge-mq12" && JSON.stringify(c.state).includes("cold proof"))!;
    const state = seam.state as { clipEnd: string; handoff: string };
    expect(state.clipEnd.split(" ")).toHaveLength(150);
    expect(state.clipEnd).not.toContain("EARLYMARK");
    expect(state.clipEnd.endsWith("w399")).toBe(true);
    expect(state.handoff).toBe(RAW_CANDIDATE.items[3]!.script);
  });

  /* MUTATION THAT KILLS THIS: read the overview as the whole prelude script
     (drop the PRELUDE_BOILERPLATE strip). Ran it: red. */
  it("asks MQ-10 about the prompt, the overview without the disclosure and the slot titles", async () => {
    const fake = replayFake();
    await judgeCandidate(input(), deps(fake));
    const [ask] = fake.callsFor("judge-mq10");
    expect(ask!.state).toEqual({ prompt: PROMPT, overview: OVERVIEW, titles: ["The cold proof", "The oven"] });
    expect(overviewOf(readCandidate(RAW_CANDIDATE))).toBe(OVERVIEW);
  });

  /* MUTATION THAT KILLS THIS: drop a field from the no-text rule (write the
     state's handoff or the clip's passage into perItem). Ran it: red. */
  it("judged.json contains no prompt text and no transcript text", async () => {
    const judged = await judgeCandidate(input(), deps(replayFake()));
    const text = JSON.stringify(judged);
    for (const needle of [PROMPT, OVERVIEW, ...Object.values(CUE_TEXT), "Ada Marsh", "Carla Diaz", "cold proof", "flavour", "Meanwhile"]) {
      expect(text).not.toContain(needle);
    }
  });
});

describe("GV-92 the injected fallback (GV-47)", () => {
  /* MUTATION THAT KILLS THIS: map judge 'qwen' to provider 'jev' in
     providerOf. Ran it: red. And read supportMinP.jev for a Qwen answer:
     red on MQ-02 (1 instead of 0.5). */
  it("a primary that is unavailable falls back, and every answer is recorded as provider 'qwen-judge' with Qwen's thresholds", async () => {
    const primary = new FakeJevClient({ fail: { category: "http", reason: "http_503", httpStatus: 503 } });
    const fallback = replayFake();
    const judged: JudgedFile = await judgeCandidate(input(), deps(new FallbackJudgeClient(primary, fallback)));
    expect(primary.calls.length).toBeGreaterThan(0);
    expect(fallback.calls.length).toBeGreaterThan(0);
    expect(judged.provider).toBe("qwen-judge");
    const answered = judged.perItem.filter((r) => r.unavailable === undefined);
    expect(answered.length).toBeGreaterThan(0);
    expect(answered.every((r) => r.provider === "qwen-judge")).toBe(true);
    /* 0.6 is under supportMinP.qwen (0.7): the borderline sentence fails for the Qwen judge. */
    expect(judged["MQ-02"].value).toBe(0.5);
    expect(judged.perItem.find((r) => r.metric === "MQ-02" && r.p === 0.6)?.minP).toBe(0.7);
  });
});

describe("GV-92 run log and the jevCalls cap (GV-90)", () => {
  /* MUTATION THAT KILLS THIS: drop the withCallContext({stage:'judge', ...})
     around the pass. Ran it: red on stage. And drop guard.metered (call the
     client directly): red, no meter events. */
  it("every judge call is a CallRecord with role 'judge' and one jevCalls unit", async () => {
    const { client, requests } = replayHttp();
    const log = new RunLog();
    const guard = new UnitBudgetGuard();
    await runWithRunLog(log, () => judgeCandidate(input(), deps(client, { unitGuard: guard })));
    const calls = log.calls();
    expect(calls.length).toBe(requests.length);
    expect(calls.length).toBe(1 + 2 + 2 + 2 + 2);
    expect(calls.every((c) => c.role === "judge" && c.provider === "jev" && c.stage === "judge")).toBe(true);
    expect(new Set(calls.map((c) => c.label))).toEqual(new Set(["judge-mq10", "judge-mq12", "judge-mq03", "clip-judge", "judge-mq02"]));
    const settled = log.events("meter").filter((m) => m.unit === "jevCalls" && !m.reserved);
    expect(settled.length).toBe(calls.length);
    expect(guard.spent("judge:synth-bread").jevCalls).toBe(calls.length);
  });

  /* MUTATION THAT KILLS THIS: wrap the phase in try/catch only (drop the
     post-phase halt check). Ran it: red, JevClipJudge swallows the cap error
     as {unavailable:'threw'} and the stop is reported in judge:MQ-02. */
  it("a jevCalls cap stop ends the pass with UnitBudgetStopError naming the metric, also inside the clip judge", async () => {
    /* MQ-10 1 + MQ-12 2 + MQ-03 2 = 5 asks before the clips; the sixth is refused inside ClipJudge. */
    const guard = new UnitBudgetGuard({ overrides: { jevCalls: 5 } });
    const err = await judgeCandidate(input(), deps(replayFake(), { unitGuard: guard })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnitBudgetStopError);
    expect((err as UnitBudgetStopError).stage).toBe("judge:MQ-05");
    expect((err as UnitBudgetStopError).unit).toBe("jevCalls");
    expect((err as Error).message).toContain("FORAY_JEV_CALLS_PER_FORAY");

    const early = await judgeCandidate(input(), deps(replayFake(), { unitGuard: new UnitBudgetGuard({ overrides: { jevCalls: 2 } }) })).catch((e: unknown) => e);
    expect(early).toBeInstanceOf(UnitBudgetStopError);
    expect((early as UnitBudgetStopError).stage).toBe("judge:MQ-12");
  });
});

describe("GV-92 the CLI", () => {
  /* MUTATION THAT KILLS THIS: prefer the golden prompt over the report
     entry's. Ran it: red. */
  it("takes the prompt from the report entry naming the candidate, else from the golden manifest by promptId", () => {
    const report = {
      entries: [
        { promptId: "g01", prompt: "other prompt", file: "out/other.json", duration: "medium" },
        { promptId: "g99", prompt: PROMPT, file: "out/synth-bread.json", duration: "short" }
      ]
    };
    const golden = [{ id: "g99", prompt: "golden wording", duration: "long", disappointment: "only history" }];
    expect(resolvePrompt({ candidate: "C:/x/synth-bread.json" }, report, golden)).toEqual({ prompt: PROMPT, promptId: "g99", disappointment: "only history", tier: "short" });
    expect(resolvePrompt({ candidate: "c.json", promptId: "g99" }, undefined, golden)).toEqual({ prompt: "golden wording", promptId: "g99", disappointment: "only history", tier: "long" });
    expect(resolvePrompt({ candidate: "c.json", entry: 0 }, report, undefined).prompt).toBe("other prompt");
    expect(judgedPathFor("out/synth-bread.json")).toBe("out/synth-bread.judged.json");
  });

  /* MUTATION THAT KILLS THIS: drop main()'s NullJevClient check. Ran it: red,
     the pass runs on a judge that never answers and writes a judged file. */
  it("refuses unknown flags and a missing --candidate, and exits 2 with no judge key, sending nothing", async () => {
    expect(() => parseJudgeArgs(["--bogus", "x"])).toThrow(/unknown argument --bogus/);
    expect(() => parseJudgeArgs(["--out", "x.json"])).toThrow(/--candidate/);
    expect(() => parseJudgeArgs(["--candidate"])).toThrow(/needs a value/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv92-"));
    const file = path.join(dir, "synth-bread.json");
    fs.writeFileSync(file, JSON.stringify(RAW_CANDIDATE));
    const golden = path.join(dir, "golden.json");
    fs.writeFileSync(golden, JSON.stringify([{ id: "g99", prompt: PROMPT }]));
    const saved = { JEV_API_KEY: process.env.JEV_API_KEY, JEV_KEY_FILE: process.env.JEV_KEY_FILE, FORAY_STAGE_JUDGE: process.env.FORAY_STAGE_JUDGE };
    delete process.env.JEV_API_KEY;
    delete process.env.JEV_KEY_FILE;
    process.env.FORAY_STAGE_JUDGE = "none";
    try {
      expect(await main(["--candidate", file, "--golden", golden, "--prompt-id", "g99"])).toBe(2);
      expect(fs.existsSync(judgedPathFor(file))).toBe(false);
      expect(await main(["--candidate", file])).toBe(2);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

