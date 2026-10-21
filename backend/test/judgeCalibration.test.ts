import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CALIBRATION_EXPORT_SCHEMA,
  DEFAULT_CLIP_THRESHOLDS,
  DEFAULT_SUPPORT_THRESHOLDS,
  JevCalibrationJudge,
  agreementTable,
  calibrate,
  calibrationExportFromStages,
  clipExamples,
  dataLocalRefusal,
  extractClips,
  extractPages,
  isUnderDataLocal,
  pageExampleRow,
  parseCalibrationExport,
  recommendThreshold,
  wilson95,
  type CalibrationExport,
  type LabelledExample
} from "../src/generation/judgeCalibration";
import { judgeThresholdEntry, judgeThresholdSetting } from "../src/generation/gateConfig";
import { deriveItemId, type TranscriptCue, type TranscriptCueProvider, type TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";
import type { CatalogueData } from "../src/generation/catalogueLookup";
import type { JevResult, JevState } from "../src/generation/jevTypes";
import { CalibrateArgError, calibrationSessionId, main as calibrateMain, parseCalibrateArgs, readLabels } from "../src/cli/calibrateJudges";
import { UnitBudgetGuard } from "../src/cost/unitBudget";
import { FakeJevClient, choiceAnswer, noulAnswer, scoreAnswer } from "./helpers/fakeJevClient";

/**
 * GV-103 (W5-07): the judge calibration harness. Every judge here is
 * FakeJevClient and every text is synthetic (fixtures/calibration/
 * synthetic-export.json): no test reaches Jev, the Spark or any network
 * model, and no transcript text is in git.
 */

const FIXTURE = path.join(__dirname, "fixtures", "calibration", "synthetic-export.json");
const exportFixture = (): CalibrationExport => parseCalibrationExport(JSON.parse(fs.readFileSync(FIXTURE, "utf8")));

/* The fake judge's p for every statement sentence of the fixture's pages.
   Page value = the lowest: P1 0.8, P2 0.95, P3 0.7, P4 0.6 (verified);
   P5 0.4, P6 0.3 (refused). */
const SENTENCE_P: Record<string, number> = {
  "The light at Gull Point was first lit in 1871.": 0.9,
  "Keepers trimmed the wick every four hours.": 0.8,
  "The keeper's log records a storm in 1903.": 0.95,
  "Fog signals were added after a wreck in 1911.": 0.7,
  "The horn could be heard for nine miles.": 0.85,
  "Electric lamps replaced the oil wick in 1934.": 0.6,
  "The last keeper retired in 1990.": 0.9,
  "He was paid partly in fish.": 0.4,
  "Gull Point was the first light in the state to be automated.": 0.3
};

function supportJudge(opts: { judgeTag?: "jev" | "qwen"; failSentence?: string } = {}): FakeJevClient {
  const fake = new FakeJevClient({
    byId: {
      supported: (state: JevState) => {
        const sentence = (state as { sentence: string }).sentence;
        const p = SENTENCE_P[sentence];
        if (p === undefined) throw new Error(`no p scripted for '${sentence}'`);
        return noulAnswer(p);
      },
      restsOn: choiceAnswer("none", { none: 1 })
    },
    ...(opts.failSentence
      ? { fail: (state: JevState) => ((state as { sentence: string }).sentence === opts.failSentence ? { category: "timeout" as const, reason: "timeout" } : undefined) }
      : {})
  });
  if (!opts.judgeTag) return fake;
  const tag = opts.judgeTag;
  return Object.assign(Object.create(fake) as FakeJevClient, {
    ask: async (...args: Parameters<FakeJevClient["ask"]>): Promise<JevResult> => ({ ...(await fake.ask(...args)), judge: tag })
  });
}

const labelledPages = (exp: CalibrationExport): LabelledExample[] =>
  extractPages(exp)
    .filter((p) => p.label !== undefined)
    .map((p) => ({ kind: p.kind, id: p.id, payload: p.payload, label: p.label!, labelSource: p.labelSource! }));

describe("GV-103 extractPages", () => {
  it("yields every narration page, with the run's verdict as an optional label", () => {
    const pages = extractPages(exportFixture());
    expect(pages.map((p) => p.id)).toEqual([
      "0a1b2c3d:page:0:0:0",
      "0a1b2c3d:page:0:0:1:frame",
      "0a1b2c3d:page:0:1:0",
      "0a1b2c3d:page:0:1:1",
      "0a1b2c3d:page:0:2:0",
      "0a1b2c3d:page:0:2:1",
      "0a1b2c3d:page:0:2:2"
    ]);
    expect(pages.map((p) => p.label)).toEqual([true, true, true, true, false, false, undefined]);
    expect(pages.filter((p) => p.label !== undefined).every((p) => p.labelSource === "run-verdict")).toBe(true);
  });

  /* MUTATION THAT KILLS THIS: give a hand-off page (unverifiedReason) its
     `verified` flag as a run verdict. Ran it: red (the last label is false). */
  it("gives a hand-off page no run verdict: nothing judged it", () => {
    const handOff = extractPages(exportFixture())[6]!;
    expect(handOff.label).toBeUndefined();
    expect(pageExampleRow(handOff, true)).toMatchObject({ label: null, labelSource: null });
  });

  it("offers the page's declared documents, drops an empty one, and resolves a tape source to its window", () => {
    const [p1, frame] = extractPages(exportFixture());
    expect(p1!.payload.sources.map((s) => s.id)).toEqual(["doc-history"]);
    expect(p1!.payload.mustInclude).toEqual(["doc-history"]);
    expect(frame!.payload.mustInclude).toEqual(["tape:seg-1"]);
    expect(frame!.payload.sources[0]!.kind).toBe("clip");
  });

  it("a row for labelling carries no label unless the run verdict is allowed", () => {
    const p1 = extractPages(exportFixture())[0]!;
    expect(pageExampleRow(p1)).toMatchObject({ label: null, labelSource: null });
    expect(pageExampleRow(p1, true)).toMatchObject({ label: true, labelSource: "run-verdict" });
  });
});

describe("GV-103 calibrate: page support", () => {
  const EXPECTED: Record<string, number> = {};
  for (const t of DEFAULT_SUPPORT_THRESHOLDS) {
    EXPECTED[String(t)] = t <= 0.3 ? 4 / 6 : t <= 0.4 ? 5 / 6 : t <= 0.6 ? 1 : t <= 0.7 ? 5 / 6 : t <= 0.8 ? 4 / 6 : 3 / 6;
  }

  /* MUTATION THAT KILLS THIS: a page's value as the MEAN of its sentences'
     p instead of the lowest (W5-08's "every sentence p >= t"). Ran it: red
     (P5's mean 0.65 passes at 0.45..0.65, agreement drops below 1). */
  it("4 verified and 2 refused pages: the expected agreement at each threshold, and 0.45 recommended", async () => {
    const examples = labelledPages(exportFixture());
    expect(examples.filter((e) => e.label).length).toBe(4);
    expect(examples.filter((e) => !e.label).length).toBe(2);
    const fake = supportJudge();
    const result = await calibrate(examples, new JevCalibrationJudge(fake, "jev"), undefined, { allowRunVerdicts: true });
    expect(result.n).toBe(6);
    expect(result.unjudged).toEqual([]);
    for (const row of result.rows) expect(row.agreement, `t=${row.threshold}`).toBeCloseTo(EXPECTED[String(row.threshold)]!, 10);
    expect(result.recommended).toBe(0.45);
    expect(result.gateKey).toBe("supportMinP.jev");
    const at45 = result.rows.find((r) => r.threshold === 0.45)!;
    expect(at45).toMatchObject({ tp: 4, tn: 2, fp: 0, fn: 0, precision: 1, recall: 1 });
    expect(at45.wilson95!.lo).toBeCloseTo(6 / (6 + 1.959963984540054 ** 2), 10);
    expect(at45.wilson95!.hi).toBe(1);
    /* One ask per statement sentence, under the calibration purpose. */
    expect(fake.callsFor("judge-calibration").length).toBe(9);
  });

  /* MUTATION THAT KILLS THIS: drop the run-verdict filter in calibrate (the
     founder's default is founder labels only). Ran it: red. */
  it("leaves run-verdict labels out unless allowed", async () => {
    const result = await calibrate(labelledPages(exportFixture()), new JevCalibrationJudge(supportJudge(), "jev"));
    expect(result.n).toBe(0);
    expect(result.excludedRunVerdicts).toBe(6);
    expect(result.recommended).toBeNull();
  });

  it("a page any of whose sentences the judge could not answer is unjudged, not a fail", async () => {
    const examples = labelledPages(exportFixture());
    const result = await calibrate(examples, new JevCalibrationJudge(supportJudge({ failSentence: "He was paid partly in fish." }), "jev"), [0.45], {
      allowRunVerdicts: true
    });
    expect(result.unjudged).toEqual([{ id: "0a1b2c3d:page:0:2:0", reason: "timeout" }]);
    expect(result.n).toBe(5);
  });

  /* MUTATION THAT KILLS THIS: construct the judge without onlyJudge (count
     every answer whatever judge gave it). Ran it: red (n is 6). */
  it("never counts another judge's answers: a Qwen answer is unjudged in a Jev calibration", async () => {
    const examples = labelledPages(exportFixture());
    const result = await calibrate(examples, new JevCalibrationJudge(supportJudge({ judgeTag: "qwen" }), "jev"), [0.45], { allowRunVerdicts: true });
    expect(result.n).toBe(0);
    expect(new Set(result.unjudged.map((u) => u.reason))).toEqual(new Set(["judge_mismatch"]));
    const asQwen = await calibrate(examples, new JevCalibrationJudge(supportJudge({ judgeTag: "qwen" }), "qwen"), [0.45], { allowRunVerdicts: true });
    expect(asQwen.n).toBe(6);
    expect(asQwen.gateKey).toBe("supportMinP.qwen");
  });

  it("refuses mixed kinds and duplicate ids", async () => {
    const [page] = labelledPages(exportFixture());
    const clip: LabelledExample = { kind: "clip-subject", id: "c", payload: { subjectSentence: "s", claim: "c", windowText: "w" }, label: true, labelSource: "founder" };
    const judge = new JevCalibrationJudge(supportJudge(), "jev");
    await expect(calibrate([page!, clip], judge)).rejects.toThrow(/more than one kind/);
    await expect(calibrate([page!, page!], judge)).rejects.toThrow(/duplicate/);
  });
});

/* A synthetic transcript: cues before, inside and after each clip. */
const ENTRIES: TranscriptDigestEntry[] = [
  { show_id: "show-a", show_title: "Show A", guid: "g1", title: "Episode one", cues: 3 },
  { show_id: "show-a", show_title: "Show A", guid: "g2", title: "Episode two", cues: 3 }
];
const CUES: Record<string, TranscriptCue[]> = {
  g1: [
    { text: "Before the clip.", start_sec: 0, end_sec: 8 },
    { text: "My grandfather kept the log.", start_sec: 10, end_sec: 25 },
    { text: "He wrote down the storm the whole night.", start_sec: 25, end_sec: 40 },
    { text: "After the clip.", start_sec: 45, end_sec: 50 }
  ],
  g2: [
    { text: "Long before.", start_sec: 50, end_sec: 90 },
    { text: "The day they came the light went automatic, and that was that.", start_sec: 100, end_sec: 160 }
  ]
};
const cueProvider: TranscriptCueProvider = { getCues: (e) => CUES[e.guid] ?? null };
const CATALOGUE: CatalogueData = { items: [], itemTags: {}, concepts: {}, shows: [] };

describe("GV-103 extractClips", () => {
  it("the fixture's item ids are the synthetic archive's", () => {
    expect(ENTRIES.map(deriveItemId)).toEqual(["show-a--episode-one", "show-a--episode-two"]);
  });

  /* MUTATION THAT KILLS THIS: read the window with the evidence padding
     (cueWindowText's default) instead of 0. Ran it: red ("Before the clip."
     joins the first window). And: keep merged rows. Ran it: red (3 rows). */
  it("one row per placed clip (a merged beat's row is its carrier's), with the subject sentence and the clip's own text", () => {
    const { rows, skipped } = extractClips(exportFixture(), { cueProvider, transcriptArchive: ENTRIES, catalogue: CATALOGUE });
    expect(skipped).toEqual([]);
    expect(rows.map((r) => r.id)).toEqual(["0a1b2c3d:clip:0:0:1", "0a1b2c3d:clip:0:1:2"]);
    expect(rows[0]!.payload).toEqual({
      subjectSentence: "Lighthouse keeping (how automation ended the keeper's life)",
      claim: "A keeper's grandson remembers the storm log.",
      windowText: "My grandfather kept the log. He wrote down the storm the whole night."
    });
    expect(rows[1]!.payload.windowText).toBe("The day they came the light went automatic, and that was that.");
    expect(clipExamples(rows[0]!).map((e) => [e.kind, e.label])).toEqual([
      ["clip-subject", null],
      ["clip-claim", null]
    ]);
  });

  it("a clip whose transcript is not on this machine is skipped, by reason", () => {
    const { rows, skipped } = extractClips(exportFixture(), { cueProvider, transcriptArchive: [ENTRIES[0]!], catalogue: CATALOGUE });
    expect(rows.length).toBe(1);
    expect(skipped).toEqual([{ id: "0a1b2c3d:clip:0:1:2", reason: "no-transcript" }]);
  });
});

describe("GV-103 calibrate: clip scores", () => {
  const clipLabelled = (kind: "clip-subject" | "clip-claim", labels: boolean[]): LabelledExample[] =>
    labels.map((label, i) => ({
      kind,
      id: `clip-${i}`,
      payload: { subjectSentence: "lighthouses", claim: `claim ${i}`, windowText: `window ${i}` },
      label,
      labelSource: "founder" as const
    }));
  /* Subject levels 4, 3, 1, 0; claim levels 2, 4, 3, 1. */
  const LEVELS = [
    [4, 2],
    [3, 4],
    [1, 3],
    [0, 1]
  ];
  const clipFake = (): FakeJevClient =>
    new FakeJevClient({
      byId: {
        subject: (state: JevState) => scoreAnswer(LEVELS[Number((state as { passage: string }).passage.split(" ")[1])]![0]!, 5),
        claim: (state: JevState) => scoreAnswer(LEVELS[Number((state as { passage: string }).passage.split(" ")[1])]![1]!, 5)
      }
    });

  /* MUTATION THAT KILLS THIS: read the claim Score for clip-subject. Ran it:
     red. */
  it("clip-subject reads the subject Score and clip-claim the claim Score; level 2 is recommended for subject", async () => {
    const subject = await calibrate(clipLabelled("clip-subject", [true, true, false, false]), new JevCalibrationJudge(clipFake(), "jev"));
    expect(subject.rows.map((r) => r.threshold)).toEqual([...DEFAULT_CLIP_THRESHOLDS]);
    expect(subject.rows.map((r) => r.agreement)).toEqual([0.5, 0.75, 1, 1, 0.75]);
    expect(subject.recommended).toBe(2);
    expect(subject.gateKey).toBe("clipLevel.jev");

    const claim = await calibrate(clipLabelled("clip-claim", [false, true, true, false]), new JevCalibrationJudge(clipFake(), "jev"));
    expect(claim.rows.map((r) => r.agreement)).toEqual([0.5, 0.5, 0.75, 1, 0.75]);
    expect(claim.recommended).toBe(3);
  });

  it("asks once per clip, and a failed ask is unjudged", async () => {
    const fake = clipFake();
    await calibrate(clipLabelled("clip-subject", [true, true, false, false]), new JevCalibrationJudge(fake, "jev"));
    expect(fake.callsFor("clip-judge").length).toBe(4);
    const down = new FakeJevClient({ fail: { category: "network", reason: "network_error" } });
    const result = await calibrate(clipLabelled("clip-subject", [true, false]), new JevCalibrationJudge(down, "jev"));
    expect(result.n).toBe(0);
    expect(result.unjudged.map((u) => u.reason)).toEqual(["network_error", "network_error"]);
  });
});

describe("GV-103 the table's arithmetic", () => {
  it("wilson95 matches the closed form, and is null with no examples", () => {
    expect(wilson95(0, 0)).toBeNull();
    const w = wilson95(5, 10)!;
    expect(w.lo).toBeCloseTo(0.2366, 4);
    expect(w.hi).toBeCloseTo(0.7634, 4);
  });

  it("precision is null when the judge passes nothing and recall when the label passes nothing", () => {
    const [row] = agreementTable([{ id: "a", label: false, value: 0.1 }], [0.5]);
    expect(row).toMatchObject({ agreement: 1, precision: null, recall: null, tn: 1 });
  });

  /* MUTATION THAT KILLS THIS: recommend the HIGHEST threshold reaching the
     target. Ran it: red. */
  it("recommends the lowest threshold reaching the target, or null", () => {
    const rows = agreementTable(
      [
        { id: "a", label: true, value: 0.9 },
        { id: "b", label: false, value: 0.2 }
      ],
      [0.1, 0.3, 0.5, 0.95]
    );
    expect(recommendThreshold(rows)).toBe(0.3);
    expect(recommendThreshold(rows, 1.01)).toBeNull();
  });
});

describe("GV-103 the export --keep-calibration writes", () => {
  const stages = (): Record<string, unknown> => {
    const fixture = exportFixture();
    return {
      understand: { outcome: "understood", intent: { subject: "intent subject", angle: "intent angle", raw: "the listener's words" } },
      spine: { subject: "Lighthouse keeping", angle: "how automation ended the keeper's life", acts: [] },
      source: {
        acts: [
          {
            title: "a",
            slots: [
              { title: "s0", beats: [{ sourcing: "narration", claim: "c" }, { sourcing: "tape", claim: "t", tape: fixture.tapePointers[0]!.tape }] }
            ]
          }
        ],
        tapeRelevance: fixture.tapeRelevance.slice(0, 1),
        newSegments: []
      },
      "narrate:0": fixture.writtenActs[0],
      "clip-scores": [{ key: "0:0:1", clipScores: { subject: 3, claim: 2, judge: "jev" } }]
    };
  };

  /* MUTATION THAT KILLS THIS: copy the `understand` stage whole into the
     export. Ran it: red (the listener's words appear). */
  it("holds the written acts, the sourcing rows, the pointers and the subject sentence, and nothing of the prompt", () => {
    const exp = calibrationExportFromStages(stages(), { key: "0a1b2c3d", promptId: "p1", duration: "short" });
    if ("error" in exp) throw new Error(exp.error);
    expect(exp.schema).toBe(CALIBRATION_EXPORT_SCHEMA);
    expect(exp.subjectSentence).toBe("Lighthouse keeping (how automation ended the keeper's life)");
    expect(exp.writtenActs.length).toBe(1);
    expect(exp.tapePointers).toEqual([{ actIndex: 0, slotIndex: 0, beatIndex: 1, tape: exportFixture().tapePointers[0]!.tape }]);
    expect(exp.clipScores?.length).toBe(1);
    const text = JSON.stringify(exp);
    expect(text).not.toContain("the listener's words");
    expect(text).not.toContain('"prompt"');
    expect(parseCalibrationExport(JSON.parse(text)).key).toBe("0a1b2c3d");
  });

  it("refuses when an act's narration was never banked", () => {
    const s = stages();
    delete s["narrate:0"];
    expect(calibrationExportFromStages(s, { key: "k" })).toEqual({ error: "no narrate:0 stage" });
    expect(calibrationExportFromStages({}, { key: "k" })).toEqual({ error: "no source stage" });
  });

  /* GV-126 (#1413 item 27). Under FORAY_PER_ACT_PIPELINE the run banks
     `source:<i>` ({act, snapshot}), never `source`. MUTATIONS THAT KILL THIS:
     read only the classic `source` key (the export says "no source stage");
     or read the FIRST banked snapshot rather than the last (act 1's narration
     is left out and its tape rows are missing); or compare the indices as
     strings ("source:10" before "source:9"). Ran each: red. */
  it("reads the last banked source:<i> snapshot when the per-act pipeline ran", () => {
    const classic = stages();
    const src = classic.source as { acts: unknown[]; tapeRelevance: unknown[] };
    const fixture = exportFixture();
    const act1 = { title: "b", slots: [{ title: "s1", beats: [{ sourcing: "tape", claim: "u", tape: fixture.tapePointers[1]!.tape }] }] };
    const tape = fixture.tapeRelevance.slice(0, 2);
    const perAct: Record<string, unknown> = { ...classic };
    delete perAct.source;
    perAct["source:0"] = { act: src.acts[0], snapshot: { acts: [src.acts[0]], tapeRelevance: tape.slice(0, 1), newSegments: [] } };
    perAct["source:1"] = { act: act1, snapshot: { acts: [src.acts[0], act1], tapeRelevance: tape, newSegments: [] } };
    perAct["narrate:1"] = fixture.writtenActs[1] ?? fixture.writtenActs[0];
    const exp = calibrationExportFromStages(perAct, { key: "k" });
    if ("error" in exp) throw new Error(exp.error);
    expect(exp.writtenActs.length).toBe(2);
    expect(exp.tapeRelevance).toEqual(tape);
    expect(exp.tapePointers.map((p) => [p.actIndex, p.slotIndex, p.beatIndex])).toEqual([
      [0, 0, 1],
      [1, 0, 0]
    ]);
    /* The same rows the classic stage would have given for act 0 alone. */
    const one: Record<string, unknown> = { ...perAct };
    delete one["source:1"];
    const first = calibrationExportFromStages(one, { key: "k" });
    if ("error" in first) throw new Error(first.error);
    const fromClassic = calibrationExportFromStages({ ...classic, source: { ...src, tapeRelevance: tape.slice(0, 1) } }, { key: "k" });
    if ("error" in fromClassic) throw new Error(fromClassic.error);
    expect(first).toEqual(fromClassic);
    /* Ten acts: source:9 is not the last. */
    const ten: Record<string, unknown> = { ...perAct };
    const acts = Array.from({ length: 11 }, (_, i) => ({ title: `a${i}`, slots: [] }));
    for (let i = 0; i < 11; i += 1) {
      ten[`source:${i}`] = { act: acts[i], snapshot: { acts: acts.slice(0, i + 1), tapeRelevance: [], newSegments: [] } };
      ten[`narrate:${i}`] = fixture.writtenActs[0];
    }
    const eleven = calibrationExportFromStages(ten, { key: "k" });
    if ("error" in eleven) throw new Error(eleven.error);
    expect(eleven.writtenActs.length).toBe(11);
    /* A per-act run whose narration is missing is still refused, by act. */
    delete perAct["narrate:1"];
    expect(calibrationExportFromStages(perAct, { key: "k" })).toEqual({ error: "no narrate:1 stage" });
  });
});

/* GV-127 (#1413 item 33): the `!path.isAbsolute(rel)` arm of
   isUnderDataLocal. It is reachable only under Windows path rules: on a
   different drive path.relative cannot build a relative path and returns the
   target itself (`D:\x\data-local\f.json`), whose first segment is `D:`, not
   `..`; POSIX path.relative always returns a relative path, so the arm never
   fires there. judgeCalibration.ts takes no path module, so the module is
   loaded here with `path` mocked to path.win32: the test then runs the
   Windows rules on any OS (the dev machine is Windows; CI is not). */
describe("GV-127 isUnderDataLocal on Windows paths, a --out on another drive", () => {
  afterEach(() => {
    vi.doUnmock("path");
    vi.resetModules();
  });

  /* MUTATION THAT KILLS THIS: drop `!path.isAbsolute(rel) &&` from
     isUnderDataLocal (a cross-drive D:\x\data-local\f.json is then accepted,
     since its first segment `D:` is not `..`). Ran it: red. */
  it("refuses a data-local/ on another drive, and still accepts the repository's own, under path.win32", async () => {
    vi.resetModules();
    vi.doMock("path", async () => {
      const actual = await vi.importActual<typeof import("path")>("path");
      return { ...actual.win32, default: actual.win32 };
    });
    const win = await import("../src/generation/judgeCalibration");
    const repo = "C:\\repo";
    const cwd = "C:\\repo\\backend";
    /* The arm itself: path.relative across drives is absolute. */
    expect(path.win32.isAbsolute(path.win32.relative("C:\\repo\\data-local", "D:\\x\\data-local\\f.json"))).toBe(true);
    expect(win.isUnderDataLocal("D:\\x\\data-local\\f.json", cwd, repo)).toBe(false);
    expect(win.isUnderDataLocal("D:\\repo\\data-local\\f.json", cwd, repo)).toBe(false);
    expect(win.isUnderDataLocal("D:\\repo\\backend\\data-local\\f.json", cwd, repo)).toBe(false);
    expect(win.dataLocalRefusal("--out", "D:\\x\\data-local\\f.json", cwd, repo)).toMatch(/--out must be under data-local\//);
    /* The same rules still accept the repository's own data-local/, in
       either separator, relative or absolute, and a drive letter in another
       case (Windows paths are case-insensitive). */
    expect(win.isUnderDataLocal("data-local\\judge-calibration\\x.json", cwd, repo)).toBe(true);
    expect(win.isUnderDataLocal("data-local/judge-calibration/x.json", cwd, repo)).toBe(true);
    expect(win.isUnderDataLocal("..\\data-local\\c\\x.json", cwd, repo)).toBe(true);
    expect(win.isUnderDataLocal("C:\\repo\\backend\\data-local\\x.json", "D:\\elsewhere", repo)).toBe(true);
    expect(win.isUnderDataLocal("c:\\repo\\data-local\\x.json", cwd, repo)).toBe(true);
    expect(win.isUnderDataLocal("data-local", cwd, repo)).toBe(false);
    expect(win.isUnderDataLocal("..\\..\\data-local\\x.json", cwd, repo)).toBe(false);
  });
});

describe("GV-103 where calibration data may be written", () => {
  const repo = path.resolve("/repo");
  const cwd = path.join(repo, "backend");
  it("accepts a path inside <repo>/backend/data-local/ or <repo>/data-local/, and refuses anything else", () => {
    expect(isUnderDataLocal("data-local/judge-calibration/x.json", cwd, repo)).toBe(true);
    expect(isUnderDataLocal("../data-local/calibration", cwd, repo)).toBe(true);
    expect(isUnderDataLocal(path.join(repo, "data-local", "c", "x.json"), "/elsewhere", repo)).toBe(true);
    expect(isUnderDataLocal("data-local-not/x", cwd, repo)).toBe(false);
    expect(isUnderDataLocal("data-local/../docs/x.json", cwd, repo)).toBe(false);
    expect(isUnderDataLocal("docs/x.json", cwd, repo)).toBe(false);
    expect(dataLocalRefusal("--out", "docs/x.json", cwd, repo)).toMatch(/--out must be under data-local\//);
    expect(dataLocalRefusal("--out", "data-local/x.json", cwd, repo)).toBeNull();
  });

  /* GV-126 (#1413 item 28). MUTATIONS THAT KILL THIS: accept the directory
     itself (drop `rel !== ""`: `--out data-local` writes a FILE the ignore
     rule does not match), or go back to any `data-local` segment (a path
     outside the repository, or a nested data-local/ inside it, passes). Ran
     each: red. */
  it("refuses the data-local directory itself, a data-local/ outside the repository, and one nested elsewhere in it", () => {
    expect(isUnderDataLocal("data-local", cwd, repo)).toBe(false);
    expect(isUnderDataLocal("data-local/", cwd, repo)).toBe(false);
    expect(isUnderDataLocal("../data-local", cwd, repo)).toBe(false);
    expect(dataLocalRefusal("--out", "data-local", cwd, repo)).toMatch(/--out must be under data-local\//);
    expect(isUnderDataLocal(path.resolve("/elsewhere/data-local/x.json"), cwd, repo)).toBe(false);
    expect(isUnderDataLocal("../../data-local/x.json", cwd, repo)).toBe(false);
    expect(isUnderDataLocal(path.resolve("/repo-other/data-local/x.json"), cwd, repo)).toBe(false);
    expect(isUnderDataLocal("src/data-local/x.json", cwd, repo)).toBe(false);
    expect(isUnderDataLocal("../tools/data-local/x.json", cwd, repo)).toBe(false);
    /* A child whose name merely starts with two dots is still inside. */
    expect(isUnderDataLocal("data-local/..x/y.json", cwd, repo)).toBe(true);
    /* The default root is this checkout: backend/data-local/ is inside it, a temp directory is not. */
    expect(isUnderDataLocal(path.resolve(__dirname, "..", "data-local", "calibration", "x.json"))).toBe(true);
    expect(isUnderDataLocal(path.join(os.tmpdir(), "data-local", "x.json"))).toBe(false);
  });
});

describe("GV-103 the per-judge gate rows a calibration feeds", () => {
  it("names the variable for each judge, and refuses a value the row cannot read", () => {
    expect(judgeThresholdEntry("supportMinP", "jev").env).toBe("FORAY_SUPPORT_MIN_P_JEV");
    expect(judgeThresholdEntry("clipLevel", "qwen").env).toBe("FORAY_CLIP_LEVEL_QWEN");
    expect(judgeThresholdSetting("supportMinP", "qwen", 0.45)).toBe("FORAY_SUPPORT_MIN_P_QWEN=0.45");
    expect(judgeThresholdSetting("clipLevel", "jev", 2.5)).toBeNull();
    expect(() => judgeThresholdEntry("clipLevel", "claude" as never)).toThrow(/unknown judge/);
  });
});

describe("GV-103 calibrateJudges CLI", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv103-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /* MUTATION THAT KILLS THIS: skip dataLocalRefusal on --out. Ran it: red. */
  it("refuses an --out outside data-local/ before reading or asking anything", async () => {
    expect(() => parseCalibrateArgs(["--labels", "l.jsonl", "--kind", "page-support", "--judge", "jev", "--out", "out/table.json"])).toThrow(CalibrateArgError);
    expect(() => parseCalibrateArgs(["--extract", "e.json", "--out", "../outside.jsonl"])).toThrow(/must be under data-local/);
    let asked = 0;
    const judge = { judge: "jev" as const, values: async () => ((asked += 1), new Map()) };
    const code = await calibrateMain(["--labels", "missing.jsonl", "--kind", "page-support", "--judge", "jev", "--out", "tables/x.json"], { judge, log: () => undefined, cwd: dir, repoRoot: dir });
    expect(code).toBe(1);
    expect(asked).toBe(0);
    expect(fs.existsSync(path.join(dir, "tables"))).toBe(false);
  });

  it("refuses a bad kind or judge", () => {
    expect(() => parseCalibrateArgs(["--labels", "l", "--kind", "page", "--judge", "jev", "--out", "data-local/x"])).toThrow(/--kind/);
    expect(() => parseCalibrateArgs(["--labels", "l", "--kind", "clip-claim", "--judge", "claude", "--out", "data-local/x"])).toThrow(/--judge/);
  });

  it("extract writes rows to label; calibrate reads the labelled ones and writes the table under data-local/", async () => {
    fs.mkdirSync(path.join(dir, "data-local", "calibration"), { recursive: true });
    fs.copyFileSync(FIXTURE, path.join(dir, "data-local", "calibration", "calibration-0a1b2c3d.json"));
    const lines: string[] = [];
    const log = (l: string): void => void lines.push(l);
    const extracted = await calibrateMain(["--extract", "data-local/calibration", "--out", "data-local/judge-calibration/to-label.jsonl"], {
      cueProvider,
      transcriptArchive: ENTRIES,
      catalogue: CATALOGUE,
      log,
      cwd: dir,
      repoRoot: dir
    });
    expect(extracted).toBe(0);
    const rows = fs
      .readFileSync(path.join(dir, "data-local", "judge-calibration", "to-label.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { kind: string; label: unknown; labelSource: unknown });
    expect(rows.filter((r) => r.kind === "page-support").length).toBe(7);
    expect(rows.filter((r) => r.kind === "clip-subject").length).toBe(2);
    expect(rows.every((r) => r.label === null && r.labelSource === null)).toBe(true);

    /* The founder marks the pages: the first six as the run did, the hand-off left unlabelled. */
    const verdicts = [true, true, true, true, false, false];
    let k = 0;
    const labelled = rows.map((r) => (r.kind === "page-support" && k < 6 ? { ...r, label: verdicts[k++], labelSource: "founder" } : r));
    fs.writeFileSync(path.join(dir, "data-local", "judge-calibration", "labelled.jsonl"), labelled.map((r) => JSON.stringify(r)).join("\n"));
    const read = readLabels(fs.readFileSync(path.join(dir, "data-local", "judge-calibration", "labelled.jsonl"), "utf8"), "page-support");
    expect(read.examples.length).toBe(6);
    expect(read.unlabelled).toBe(1);

    const code = await calibrateMain(
      ["--labels", "data-local/judge-calibration/labelled.jsonl", "--kind", "page-support", "--judge", "jev", "--out", "data-local/judge-calibration/page.jev.json"],
      { judge: new JevCalibrationJudge(supportJudge(), "jev"), log, cwd: dir, repoRoot: dir }
    );
    expect(code).toBe(0);
    const table = JSON.parse(fs.readFileSync(path.join(dir, "data-local", "judge-calibration", "page.jev.json"), "utf8")) as {
      recommended: number;
      setting: string;
      n: number;
    };
    expect(table.n).toBe(6);
    expect(table.recommended).toBe(0.45);
    expect(table.setting).toBe("FORAY_SUPPORT_MIN_P_JEV=0.45");
    expect(lines.some((l) => l.includes("gate setting: FORAY_SUPPORT_MIN_P_JEV=0.45"))).toBe(true);

    /* GV-126 (#1413 item 32): the default judge is metered under a session,
       so every Jev ask reserves a `jevCalls` unit and the per-session cap
       stops a runaway calibration. MUTATION THAT KILLS THIS: drop `sessionId`
       from the meteredJevClient options (no unit is reserved: spent 0, and
       the capped run completes). Ran it: red. */
    const labelArgs = ["--labels", "data-local/judge-calibration/labelled.jsonl", "--kind", "page-support", "--judge", "jev", "--out", "data-local/judge-calibration/metered.json"];
    const client = supportJudge();
    const unitGuard = new UnitBudgetGuard();
    expect(await calibrateMain(labelArgs, { client, unitGuard, log, cwd: dir, repoRoot: dir })).toBe(0);
    const session = calibrationSessionId("page-support", "jev");
    expect(session).toBe("calibrate:page-support:jev");
    expect(client.calls.length).toBeGreaterThan(1);
    expect(unitGuard.spent(session).jevCalls).toBe(client.calls.length);
    const capped = new UnitBudgetGuard({ overrides: { jevCalls: 1 } });
    await expect(calibrateMain(labelArgs, { client: supportJudge(), unitGuard: capped, log, cwd: dir, repoRoot: dir })).rejects.toThrow(/jevCalls cap/);
  });
});
