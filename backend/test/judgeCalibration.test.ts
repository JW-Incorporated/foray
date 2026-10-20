import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { CalibrateArgError, main as calibrateMain, parseCalibrateArgs, readLabels } from "../src/cli/calibrateJudges";
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
});

describe("GV-103 where calibration data may be written", () => {
  const cwd = path.resolve("/repo/backend");
  it("accepts data-local/ or a path inside one, and refuses anything else", () => {
    expect(isUnderDataLocal("data-local/judge-calibration/x.json", cwd)).toBe(true);
    expect(isUnderDataLocal("data-local", cwd)).toBe(true);
    expect(isUnderDataLocal("../data-local/calibration", cwd)).toBe(true);
    expect(isUnderDataLocal("data-local-not/x", cwd)).toBe(false);
    expect(isUnderDataLocal("data-local/../docs/x.json", cwd)).toBe(false);
    expect(isUnderDataLocal("docs/x.json", cwd)).toBe(false);
    expect(dataLocalRefusal("--out", "docs/x.json", cwd)).toMatch(/--out must be under data-local\//);
    expect(dataLocalRefusal("--out", "data-local/x.json", cwd)).toBeNull();
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
    const code = await calibrateMain(["--labels", "missing.jsonl", "--kind", "page-support", "--judge", "jev", "--out", "tables/x.json"], { judge, log: () => undefined, cwd: dir });
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
      cwd: dir
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
      { judge: new JevCalibrationJudge(supportJudge(), "jev"), log, cwd: dir }
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
  });
});
