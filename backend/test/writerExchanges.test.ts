import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeNarration, type WriteNarrationOptions } from "../src/generation/writeNarration";
import { replayMechanicalGate, type WriterExchange } from "../src/generation/writeAct";
import { runForayPipeline, type RunPipelineDeps } from "../src/generation/runPipeline";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import { checkpointFingerprint } from "../src/generation/checkpoint";
import { FileTranscriptCueProvider } from "../src/generation/transcriptArchiveLookup";
import { tapeDocIdFor } from "../src/types/narration";
import {
  exchangesFilename,
  exchangesFlagRefusal,
  generateOneCandidate,
  main,
  parseArgs,
  WRITER_EXCHANGE_SCHEMA,
  CliArgError,
  type CliArgs
} from "../src/cli/generateForays";
import type { EvidenceDoc, EvidenceGatherer, EvidencePack } from "../src/generation/gatherEvidence";
import type { ActWriteRequest, ActWriteResult, NarrationBuildContext } from "../src/generation/NarrationWriterBuilder";
import type { FinalizeForayResult } from "../src/generation/finalizeForay";
import type { GenerationRequest } from "../src/types/generation";
import type { SourcedAct, TapePointer } from "../src/types/tapeSourcing";
import type { DeepenedAct, Voice } from "../src/types/spine";
import { FakeCheckpointStore } from "./helpers/fakeCheckpointStore";

/**
 * GV-110 (docs/roadmap/generation-v2.md, from W7-09; R2-17): the bench-only
 * writer exchange recorder. For bench prompts only, every writer request and
 * reply plus the round's mechanical issues and the verifier's verdict, per
 * act and round:
 *
 *   - writeAct: `onExchange` fires once per round, at the round's end, with
 *     exactly what the writer was sent and returned (whole-act, streamed and
 *     seam-edit rounds name their call), the mechanical issues and the
 *     verdict; omitted, the act is byte-identical; a throwing callback costs
 *     nothing;
 *   - replay: a recorded round-1 exchange, through JSON as the CLI writes it,
 *     replays through replayMechanicalGate with the same mechanical issues
 *     (the dead helper's first caller);
 *   - the driver: RunPipelineDeps.onWriterExchange carries the real act index
 *     on the classic and the per-act path (a multi-act stub spine), and a run
 *     without it banks byte-identical narration;
 *   - the CLI: --record-exchanges is refused before any model call for a
 *     non-bench prompt, an --out outside data-local/ or --dry-run; on a bench
 *     prompt it appends one line per exchange to
 *     <out>/<checkpointKey>.exchanges.jsonl with the writer's stage
 *     assignment and no key, and the row names the file.
 *
 * Offline: stub builders and synthetic windows; no model, no network. The
 * only files written are in a temp directory.
 *
 * MUTATIONS RUN against this suite (each turned it red, then reverted):
 *   1. writeAct.ts: delete the `options.onExchange(...)` call -> the writeAct
 *      and pipeline tests are red (no exchange).
 *   2. writeAct.ts: send `mechanical: []` -> "one exchange per round" and the
 *      replay test are red.
 *   3. writeAct.ts: drop `verdict` from the exchange -> "one exchange per
 *      round" is red.
 *   4. writeAct.ts: record the padded reply on a seam-edit round -> "a seam
 *      edit round" is red (the reply holds seams the writer was not asked for).
 *   5. writeNarration.ts: do not thread `onExchange` into writeActNarration ->
 *      every capture is empty.
 *   6. runPipeline.ts: pass `actIndex: 0` (writeNarration's own index) ->
 *      the classic and per-act act-index tests are red.
 *   7. generateForays.ts: delete the exchangesFlagRefusal check in main ->
 *      the main refusal test is red (the pipeline runs).
 *   8. generateForays.ts: exchangesFlagRefusal without the data-local check
 *      -> "--out outside data-local" is red.
 *   9. generateForays.ts: record without the `spec.bench === true` check ->
 *      "a non-bench prompt records nothing" is red.
 *  10. generateForays.ts: drop `exchangesFile` from the row -> red.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const voice: Voice = { style: "well-read friend", register: "conversational", sentenceRhythm: "varied", narratorPresence: "medium" };
const ctx: NarrationBuildContext = { userId: "founder-1" };

/* ------------------------------------------------------------ fixture
   actNarration.test.ts's acceptance shape (one act, four narration beats,
   two clips), with short synthetic windows. */

const ITEM_A = "synthetic-show--skills-over-models";
const ITEM_B = "synthetic-show--a-robot-in-a-simulator";
const SEGMENT_A = `${ITEM_A}#410`;
const SEGMENT_B = `${ITEM_B}#980`;
const SHOW = "Practical AI";
const TITLE_A = "Skills over models";
const TITLE_B = "A robot in a simulator";
const ANCHOR_A = "so the first thing to understand is";
const ANCHOR_B = "when we put the robot in the simulator";
const WINDOW_A =
  "Before the break we were talking about hiring, and how long it takes to find people who can maintain a pipeline. " +
  `${ANCHOR_A} that the mix of skills in the organization decides the tools, and the model choice comes last, ` +
  "because a team that cannot keep a pipeline running will not keep any model running for long.";
const WINDOW_B =
  "That was the part of the conversation about tooling, which we will come back to. " +
  `${ANCHOR_B} the first thing that broke was the physics, not the policy, ` +
  "and it took a week of watching replays to see that the wheels were sliding on a floor that did not exist.";
const PRINT: EvidenceDoc = {
  docId: "print:synthetic-report",
  kind: "print",
  title: "A synthetic building report (1982)",
  url: "https://example.org/synthetic-report.pdf",
  text:
    "The box beam-hanger rod connections were not checked for adequacy at any stage of the design. " +
    "The as-built connection could support about sixty percent of the load required by the Kansas City Building Code. " +
    "Investigators traced the change to a shop drawing produced by the fabricator and approved without calculation."
};
const CLAIMS = {
  b0: "The Hyatt walkway hangers carried double the load the design assumed.",
  b1: "The connection was never checked for adequacy at any stage.",
  b2: "Investigators traced the change to a fabricator's shop drawing.",
  b3: "The as-built connection could carry about sixty percent of the code load."
};

function pointer(itemId: string, segmentId: string, startAnchor: string, startSec: number): TapePointer {
  return { segmentId, itemId, startSec, endSec: startSec + 120, startAnchor, endAnchor: "will not keep any model running", tier: 1, confidence: "high" };
}
const narration = (claim: string) => ({ sourcing: "narration" as const, claim, exploration: false, narration: { mode: "Patch" as const, reason: "t" } });
const tape = (claim: string, p: TapePointer) => ({ sourcing: "tape" as const, claim, exploration: false, tape: p });

function fourBeatsTwoClips(): SourcedAct {
  return {
    title: "Act 1: Skills decide the tools",
    slots: [
      { title: "Opening", beats: [narration(CLAIMS.b0), narration(CLAIMS.b1), tape("A guest explains why skills decide the tools.", pointer(ITEM_A, SEGMENT_A, ANCHOR_A, 410))] },
      { title: "The turn", beats: [narration(CLAIMS.b2), tape("The robot in the simulator.", pointer(ITEM_B, SEGMENT_B, ANCHOR_B, 980)), narration(CLAIMS.b3)] }
    ]
  };
}

function gatherer(): EvidenceGatherer {
  const windows: Record<string, string> = { [SEGMENT_A]: WINDOW_A, [SEGMENT_B]: WINDOW_B };
  const titles: Record<string, { show: string; title: string }> = { [ITEM_A]: { show: SHOW, title: TITLE_A }, [ITEM_B]: { show: SHOW, title: TITLE_B } };
  const windowDoc = (p: TapePointer): EvidenceDoc => {
    const t = titles[p.itemId]!;
    return { docId: tapeDocIdFor(p.segmentId), kind: "tape", title: `${t.show} — ${t.title}`, text: windows[p.segmentId]! };
  };
  return {
    async gather(beat): Promise<EvidencePack> {
      const docs: EvidenceDoc[] = [];
      let tapeContext: EvidencePack["tape"];
      if (beat.tape) {
        docs.push({ ...windowDoc(beat.tape), tapePosition: "next" });
        const t = titles[beat.tape.itemId]!;
        tapeContext = { itemId: beat.tape.itemId, showTitle: t.show, episodeTitle: t.title, startSec: beat.tape.startSec, endSec: beat.tape.endSec };
      }
      for (const [position, p] of [["previous", beat.adjacentTape?.previous], ["next", beat.adjacentTape?.next]] as const) {
        if (!p || docs.some((d) => d.docId === tapeDocIdFor(p.segmentId))) continue;
        docs.push({ ...windowDoc(p), tapePosition: position });
      }
      if (!beat.tape) docs.push(PRINT);
      return { purpose: beat.claim, beatKind: "account", docs, ...(tapeContext ? { tape: tapeContext } : {}) };
    }
  };
}

/** The stub builders; `mutate` changes what the writer says on a round. Every
 * request and (mutated) reply is kept in call order. */
function builders(mutate?: (reply: ActWriteResult, round: number) => ActWriteResult) {
  const writer = new StubNarrationWriterBuilder();
  const verifier = new StubNarrationVerifierBuilder();
  const requests: ActWriteRequest[] = [];
  const replies: ActWriteResult[] = [];
  const realWrite = writer.writeAct.bind(writer);
  writer.writeAct = async (request, buildCtx) => {
    requests.push(request);
    const raw = await realWrite(request, buildCtx);
    const reply = mutate ? mutate(raw, requests.length) : raw;
    replies.push(reply);
    return reply;
  };
  return { writer, verifier, requests, replies };
}

/** Round 1's s0 introduction names neither the show nor the episode, so the
 * mechanical gate refuses it and the act takes a second round. */
const namelessIntroOnRound1 = (reply: ActWriteResult, round: number): ActWriteResult =>
  round === 1 ? { seams: reply.seams.map((s) => (s.seamId === "s0" ? { ...s, script: s.script.replace(/Practical AI/g, "the show").replace(/Skills over models/g, "an episode") } : s)) } : reply;

async function writeCapturing(mutate?: (reply: ActWriteResult, round: number) => ActWriteResult, extra: Partial<WriteNarrationOptions> = {}) {
  const b = builders(mutate);
  const exchanges: WriterExchange[] = [];
  const [act] = await writeNarration(
    [fourBeatsTwoClips()],
    { writer: b.writer, verifier: b.verifier, evidence: gatherer(), onExchange: (x) => exchanges.push(x), ...extra },
    voice,
    ctx
  );
  return { act: act!, exchanges, ...b };
}

/** The live mechanical issues, as `replayMechanicalGate` returns them, back in
 * the gate's own `seam <id>: <issues>` form. */
function replayedIssues(x: WriterExchange): string[] {
  const replay = replayMechanicalGate(x.request as ActWriteRequest, x.reply, x.round);
  return replay.flatMap((s) => s.issues.map((issue) => `seam ${s.seamId}: ${issue}`));
}

describe("writeActNarration — onExchange (GV-110)", () => {
  it("fires once per round at the round's end with the request, reply, mechanical issues and verdict", async () => {
    const { exchanges, requests, replies } = await writeCapturing(namelessIntroOnRound1);
    expect(requests).toHaveLength(2);
    expect(exchanges.map((x) => [x.round, x.call])).toEqual([
      [1, "writeAct"],
      [2, "writeAct"]
    ]);
    exchanges.forEach((x, i) => {
      expect(x.actTitle).toBe("Act 1: Skills decide the tools");
      expect(x.request).toBe(requests[i]);
      expect(x.reply).toBe(replies[i]);
    });
    expect(exchanges[0]!.mechanical.length).toBeGreaterThan(0);
    expect(exchanges[0]!.mechanical.every((m) => m.startsWith("seam s0: "))).toBe(true);
    expect(exchanges[0]!.mechanical.join(" ")).toMatch(/Practical AI/);
    expect(exchanges[1]!.mechanical).toEqual([]);
    /* Round 1's verifier judged the seams that passed the gate. */
    expect(exchanges[0]!.verdict?.seams.length).toBeGreaterThan(0);
    expect(exchanges[1]!.verdict).toBeDefined();
  });

  it("without onExchange the written act is byte-identical, and a throwing callback costs nothing", async () => {
    const plain = builders(namelessIntroOnRound1);
    const [without] = await writeNarration([fourBeatsTwoClips()], { writer: plain.writer, verifier: plain.verifier, evidence: gatherer() }, voice, ctx);
    const { act: withRecorder } = await writeCapturing(namelessIntroOnRound1);
    expect(JSON.stringify(withRecorder)).toBe(JSON.stringify(without));

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const throwing = builders(namelessIntroOnRound1);
    const [thrown] = await writeNarration(
      [fourBeatsTwoClips()],
      {
        writer: throwing.writer,
        verifier: throwing.verifier,
        evidence: gatherer(),
        onExchange: () => {
          throw new Error("disk full");
        }
      },
      voice,
      ctx
    );
    expect(JSON.stringify(thrown)).toBe(JSON.stringify(without));
    expect(warn.mock.calls.some((c) => /onExchange threw .* round 1; ignored \(disk full\)/.test(String(c[0])))).toBe(true);
  });

  it("a streamed round names its call, and its reply is the seams that arrived", async () => {
    const { exchanges } = await writeCapturing(undefined, { streamSeams: true });
    expect(exchanges.length).toBeGreaterThan(0);
    expect(exchanges[0]!.call).toBe("writeActStream");
    expect(exchanges[0]!.reply.seams.map((s) => s.seamId)).toEqual((exchanges[0]!.request as ActWriteRequest).seams.map((s) => s.seamId));
  });

  it("a seam edit round records the edit request and the writer's own edited seams, not the padded act", async () => {
    const b = builders(namelessIntroOnRound1);
    const exchanges: WriterExchange[] = [];
    await writeNarration(
      [fourBeatsTwoClips()],
      { writer: b.writer, verifier: b.verifier, evidence: gatherer(), roundPolicy: { maxRounds: 2, editScope: "seams" }, onExchange: (x) => exchanges.push(x) },
      voice,
      ctx
    );
    expect(exchanges.map((x) => x.call)).toEqual(["writeAct", "editSeams"]);
    const edit = exchanges[1]!;
    if (edit.call !== "editSeams") throw new Error("unreachable");
    expect(edit.request.neighbours).toBeDefined();
    expect(edit.request.seams.map((s) => s.seamId)).toEqual(["s0"]);
    expect(edit.reply.seams.map((s) => s.seamId)).toEqual(["s0"]);
  });
});

describe("replayMechanicalGate — a recorded exchange replays with the same mechanical issues (GV-110)", () => {
  it("round 1 refused in code: the same issues, through JSON as the CLI writes the line", async () => {
    const { exchanges } = await writeCapturing(namelessIntroOnRound1);
    const recorded = JSON.parse(JSON.stringify(exchanges[0])) as WriterExchange;
    expect(recorded.mechanical.length).toBeGreaterThan(0);
    expect(replayedIssues(recorded)).toEqual(recorded.mechanical);
  });

  it("a clean round 1: no issue live, none on replay, every seam's claims counted", async () => {
    const { exchanges } = await writeCapturing();
    const recorded = JSON.parse(JSON.stringify(exchanges[0])) as WriterExchange;
    expect(recorded.mechanical).toEqual([]);
    expect(replayedIssues(recorded)).toEqual([]);
    const replay = replayMechanicalGate(recorded.request as ActWriteRequest, recorded.reply);
    expect(replay.map((s) => s.seamId)).toEqual(recorded.reply.seams.map((s) => s.seamId));
  });
});

/* ------------------------------------------------------------ the driver */

const request: GenerationRequest = { prompt: "the history of grilling and barbecue", duration: "medium", author_id: "founder-1", visibility: "catalogue" };
const options = { userId: "founder-1", now: () => new Date("2026-09-05T12:00:00.000Z"), topic: "food/grilling-bbq" };
const KEY = "gv-110";

const finalize = async (): Promise<FinalizeForayResult> =>
  ({
    validation: { ok: true, checkForaysErrors: [], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] },
    forayRecord: { generated: true },
    timings: []
  }) as unknown as FinalizeForayResult;

function stubDeps(extra: Partial<RunPipelineDeps> = {}): RunPipelineDeps {
  return {
    understander: new StubPromptUnderstander(),
    researcher: new StubExternalResearcher(),
    spineBuilder: new StubSpineBuilder(),
    deepenBuilder: new StubDeepenActBuilder(),
    narrationWriter: new StubNarrationWriterBuilder(),
    narrationVerifier: new StubNarrationVerifierBuilder(),
    continuityBuilder: new StubContinuityBuilder(),
    finalize,
    ...extra
  };
}

type Captured = WriterExchange & { actIndex: number };

const store = new FakeCheckpointStore(checkpointFingerprint({ prompt: request.prompt, duration: request.duration, topic: options.topic }));
const narrateStages = () => store.stageKeys(KEY).filter((s) => /^narrate:\d+$/.test(s));
let bankedWithout: Record<string, string>;

/** A banked stage as JSON, with the wall-clock stamps the dry-run evidence
 * fixture puts on every print claim (`retrieved`) masked: everything else
 * must match byte for byte. */
const ISO_STAMP = /"\d{4}-\d{2}-\d{2}T[\d:.]+Z"/g;
const stable = (stage: unknown): string => JSON.stringify(stage).replace(ISO_STAMP, '"<time>"');
let deepened: DeepenedAct[];

/** Each act's index -> its title, from the banked deepen stages. */
function expectActIndices(captured: Captured[]): void {
  expect(deepened.length, "the stub medium spine has several acts").toBeGreaterThanOrEqual(3);
  expect([...new Set(captured.map((x) => x.actIndex))].sort()).toEqual(deepened.map((_, i) => i));
  for (const x of captured) expect(x.actTitle, `act ${x.actIndex}`).toBe(deepened[x.actIndex]!.title);
  for (const x of captured) expect(x.round).toBeGreaterThanOrEqual(1);
}

beforeAll(async () => {
  /* The default run: no recorder. Its narration is the baseline. */
  const out = await runForayPipeline(request, { ...options, checkpointKey: KEY }, stubDeps({ checkpoint: store }));
  expect(out.outcome).toBe("generated");
  const file = store.files.get(KEY)!;
  bankedWithout = Object.fromEntries(narrateStages().map((s) => [s, stable(file.stages[s])]));
  deepened = Object.keys(file.stages)
    .filter((s) => /^deepen:\d+$/.test(s))
    .sort((a, b) => Number(a.split(":")[1]) - Number(b.split(":")[1]))
    .map((s) => file.stages[s] as DeepenedAct);
}, 180_000);

describe("runForayPipeline — onWriterExchange carries the real act index (GV-110)", () => {
  it("classic path: every act's exchanges arrive with its own index, and the banked narration equals the run without a recorder", async () => {
    store.drop(KEY, store.stageKeys(KEY).filter((s) => /^(narrate|stitch):/.test(s)));
    const captured: Captured[] = [];
    const out = await runForayPipeline(request, { ...options, checkpointKey: KEY }, stubDeps({ checkpoint: store, onWriterExchange: (x) => captured.push(x) }));
    expect(out.outcome).toBe("generated");
    expectActIndices(captured);
    const file = store.files.get(KEY)!;
    expect(narrateStages().length).toBe(deepened.length);
    for (const s of narrateStages()) expect(stable(file.stages[s]), s).toBe(bankedWithout[s]);
    /* Each act's request is the one its own act was written from. */
    for (const x of captured) expect((x.request as ActWriteRequest).actTitle).toBe(deepened[x.actIndex]!.title);
  }, 180_000);

  it("a resumed (banked) act records nothing", async () => {
    const captured: Captured[] = [];
    const out = await runForayPipeline(request, { ...options, checkpointKey: KEY }, stubDeps({ checkpoint: store, onWriterExchange: (x) => captured.push(x) }));
    expect(out.outcome).toBe("generated");
    expect(captured).toEqual([]);
  }, 180_000);

  it("per-act path (FORAY_PER_ACT_PIPELINE): every act's exchanges arrive with its own index", async () => {
    const captured: Captured[] = [];
    const out = await runForayPipeline(request, { ...options, flags: { perActPipeline: true } }, stubDeps({ onWriterExchange: (x) => captured.push(x) }));
    expect(out.outcome).toBe("generated");
    expectActIndices(captured);
  }, 180_000);
});

/* ------------------------------------------------------------ the CLI */

function baseArgs(out: string, overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    prompts: null,
    out,
    duration: "short",
    limit: null,
    dryRun: false,
    authorId: "founder-1",
    budgetUsd: null,
    noResume: false,
    maxResumes: 0,
    continueOnRefusedPartial: false,
    notify: null,
    ...overrides
  };
}

const SECRET = "sk-gv110-should-never-be-recorded";

/** A pipeline that fires two scripted exchanges (acts 0 and 1) and stops. */
function scriptedPipeline(seen: { deps?: RunPipelineDeps }): typeof runForayPipeline {
  return async (_req, _opts, deps = {}) => {
    seen.deps = deps;
    const base = { actTitle: "Act 1", round: 1, call: "writeAct" as const, request: { actTitle: "Act 1", voice, seams: [], clips: [], documents: [{ docId: "tape:x#1", kind: "tape", title: "S — E", text: "a synthetic window" }] } as unknown as ActWriteRequest, reply: { seams: [] }, mechanical: [] };
    deps.onWriterExchange?.({ ...base, actIndex: 0, verdict: { beats: [], seams: [] } });
    deps.onWriterExchange?.({ ...base, actTitle: "Act 2", round: 2, actIndex: 1, mechanical: ["seam s0: x"] });
    return { outcome: "rejected", category: "scripted", explanation: "stop", timings: [] };
  };
}

describe("generate-forays --record-exchanges (GV-110)", () => {
  const cueProvider = new FileTranscriptCueProvider();
  let dir: string;

  it("parseArgs: absent unless given; refused with --dry-run", () => {
    expect(parseArgs(["--prompts", "p.json"])).not.toHaveProperty("recordExchanges");
    expect(parseArgs(["--prompts", "p.json", "--record-exchanges"]).recordExchanges).toBe(true);
    expect(() => parseArgs(["--prompts", "p.json", "--record-exchanges", "--dry-run"])).toThrow(CliArgError);
    expect(() => parseArgs(["--prompts", "p.json", "--record-exchanges", "--dry-run"])).toThrow(/a dry run writes nothing/);
  });

  it("exchangesFlagRefusal: bench prompts only, and --out under data-local/ only", () => {
    const repo = path.resolve(__dirname, "..", "..");
    const bench = [{ prompt: "a", bench: true }, { prompt: "b", bench: true }];
    const underDataLocal = path.join(repo, "data-local", "swaps", "arm-a");
    expect(exchangesFlagRefusal({ out: os.tmpdir() }, [{ prompt: "a" }])).toBeNull();
    expect(exchangesFlagRefusal({ recordExchanges: true, out: underDataLocal }, bench, repo, repo)).toBeNull();
    expect(exchangesFlagRefusal({ recordExchanges: true, out: underDataLocal }, [...bench, { prompt: "c" }], repo, repo)).toMatch(
      /--record-exchanges is for bench prompts only: prompt 3 of 3/
    );
    expect(exchangesFlagRefusal({ recordExchanges: true, out: path.join(os.tmpdir(), "arm") }, bench, repo, repo)).toMatch(/must be under data-local/);
    expect(exchangesFlagRefusal({ recordExchanges: true, out: path.join(repo, "data-local") }, bench, repo, repo)).toMatch(/must be under data-local/);
    expect(exchangesFlagRefusal({ recordExchanges: true, out: path.join(repo, "data", "candidates") }, bench, repo, repo)).toMatch(/must be under data-local/);
  });

  it("main refuses a non-bench prompt or an --out outside data-local/ before anything runs", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv110-main-"));
    const listener = path.join(dir, "listener.json");
    const benchOnly = path.join(dir, "bench.json");
    fs.writeFileSync(listener, JSON.stringify([{ prompt: "a listener's prompt" }]));
    fs.writeFileSync(benchOnly, JSON.stringify([{ prompt: "a bench prompt", bench: true }]));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const runPipeline = vi.fn(scriptedPipeline({}));
    const before = process.exitCode;
    const outside = path.join(dir, "out");
    const inside = path.join("data-local", "gv110-never-created");
    try {
      await main(["--prompts", listener, "--out", inside, "--record-exchanges"], { runPipeline });
      expect(process.exitCode).toBe(1);
      process.exitCode = before;
      await main(["--prompts", benchOnly, "--out", outside, "--record-exchanges"], { runPipeline });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = before;
    }
    expect(String(err.mock.calls[0]![0])).toMatch(/--record-exchanges is for bench prompts only/);
    expect(String(err.mock.calls[1]![0])).toMatch(/must be under data-local/);
    expect(log).not.toHaveBeenCalled();
    expect(runPipeline).not.toHaveBeenCalled();
    expect(fs.existsSync(outside)).toBe(false);
    expect(fs.existsSync(path.resolve(inside))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a bench prompt appends one line per exchange, with the act index, the writer's assignment and no key; the row names the file", async () => {
    vi.stubEnv("FORAY_LLM_API_KEY", SECRET);
    vi.stubEnv("ANTHROPIC_API_KEY", SECRET);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv110-cli-"));
    const seen: { deps?: RunPipelineDeps } = {};
    const spec = { prompt: "a bench prompt", bench: true, id: "golden-07" };
    const result = await generateOneCandidate(spec, baseArgs(dir, { recordExchanges: true }), { cueProvider, runPipeline: scriptedPipeline(seen) });
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".exchanges.jsonl"));
    expect(files).toHaveLength(1);
    expect(result.entry?.exchangesFile).toBe(files[0]);
    expect(files[0]).toBe(exchangesFilename(files[0]!.replace(/\.exchanges\.jsonl$/, "")));
    const text = fs.readFileSync(path.join(dir, files[0]!), "utf8");
    expect(text).not.toContain(SECRET);
    expect(text.toLowerCase()).not.toMatch(/authorization|api[_-]?key|x-api-key/);
    const lines = text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => [l.actIndex, l.round, l.attempt])).toEqual([
      [0, 1, 1],
      [1, 2, 1]
    ]);
    for (const l of lines) {
      expect(l.schema).toBe(WRITER_EXCHANGE_SCHEMA);
      expect(l.forayKey).toBe(files[0]!.replace(/\.exchanges\.jsonl$/, ""));
      expect(l.promptId).toBe("golden-07");
      expect(l.generator).toEqual(result.entry?.stageAssignments?.writer ?? null);
      expect(l.call).toBe("writeAct");
    }
    expect(lines[0]!.verdict).toEqual({ beats: [], seams: [] });
    expect(lines[1]).not.toHaveProperty("verdict");
    expect(lines[1]!.mechanical).toEqual(["seam s0: x"]);
    expect((lines[0]!.request as { documents: Array<{ text: string }> }).documents[0]!.text).toBe("a synthetic window");
    /* The tools reader parses what the CLI wrote. */
    const reader = (await import("../../tools/generation-bench/exchanges.mjs")) as {
      EXCHANGE_SCHEMA: string;
      listExchanges(target: string): Array<{ actIndex: number; finalRound: boolean }>;
    };
    expect(reader.EXCHANGE_SCHEMA).toBe(WRITER_EXCHANGE_SCHEMA);
    expect(reader.listExchanges(dir).map((r) => r.actIndex)).toEqual([0, 1]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("without the flag, under --dry-run, or for a non-bench prompt nothing is recorded and the pipeline gets no recorder", async () => {
    for (const [spec, overrides] of [
      [{ prompt: "a bench prompt", bench: true }, {}],
      [{ prompt: "a bench prompt", bench: true }, { recordExchanges: true, dryRun: true }],
      [{ prompt: "a listener's prompt" }, { recordExchanges: true }]
    ] as const) {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv110-none-"));
      const seen: { deps?: RunPipelineDeps } = {};
      const result = await generateOneCandidate(spec, baseArgs(dir, overrides), { cueProvider, runPipeline: scriptedPipeline(seen) });
      expect(seen.deps).toBeDefined();
      expect(seen.deps).not.toHaveProperty("onWriterExchange");
      expect(fs.readdirSync(dir).filter((f) => f.endsWith(".exchanges.jsonl"))).toEqual([]);
      expect(result.entry).not.toHaveProperty("exchangesFile");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
