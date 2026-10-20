import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  VOICE_GATE_MODES,
  actVoiceSummary,
  computeVoiceMetrics,
  seamSentenceShape,
  seamShapeSummary,
  voiceGateEnforces,
  voiceReport,
  voiceScriptsOf
} from "../src/generation/voiceChecks";
import { GATE_TABLE, gradeBandParser, readGateConfig, voiceGateOf } from "../src/generation/gateConfig";
import { FlagValueError } from "../src/generation/generationFlags";
import { fleschKincaidGrade, READING_GRADE_BAND } from "../src/copy/spokenLine";
import { scoreVoice } from "../../tools/foray/voice-metrics.mjs";
import { runForayPipeline } from "../src/generation/runPipeline";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import type { FinalizeForayInput, FinalizeForayResult } from "../src/generation/finalizeForay";
import type { ForayItem } from "../src/generation/forayItems";
import type { GenerationRequest } from "../src/types/generation";
import type { WrittenAct } from "../src/generation/writeNarration";
import type { GateConfig } from "../src/generation/gateConfig";
import type { PipelineFlags } from "../src/generation/pipelineFlags";

/**
 * GV-104 (docs/roadmap/generation-v2.md, #1286; W5-18 + W4-12; R2-14, QK-25,
 * GP-24, MQ-15..MQ-18): the voice checks on generated narration, the gate
 * rows that steer them, and the pipeline wiring (the writer gate by act
 * position, the report's voice block from the final items). Every test names
 * the mutation that kills it.
 */

const FROZEN = path.resolve(__dirname, "..", "..", "tools", "foray", "fixtures", "frozen", "data", "forays.json");
const frozenItems = (): ForayItem[] => {
  const raw = JSON.parse(fs.readFileSync(FROZEN, "utf8")) as { forays?: unknown[] } | unknown[];
  const list = (Array.isArray(raw) ? raw : raw.forays ?? []) as Array<{ id: string; items: ForayItem[] }>;
  return list.find((f) => f.id === "what-engineers-actually-do-all-day-e08236")!.items;
};

/** 31 words, one sentence. */
const LONG_31 =
  "The engineers who stayed at the bench for a whole career tend to describe the same slow trade of craft for scope and of hands on work for meetings and plans.";
const SEAM = `Interestingly, about 40 percent of them leave. ${LONG_31} Some come back.`;

describe("voiceReport — the hard errors, the shape and the grade of one script", () => {
  it("a seam with '40 percent', 'Interestingly,' and a 31-word sentence yields a digit and an opener as hard errors and an over-25 shape issue", () => {
    /* MUTATION THAT KILLS THIS: drop the spokenLineErrors call (no digit, no
       opener), or read N21's maximum as a hard error. Ran both: red. */
    expect(LONG_31.split(/\s+/).length).toBe(31);
    const r = voiceReport(SEAM, { hasTape: true });
    expect(r.hardErrors.some((e) => e.includes("digit in a spoken line"))).toBe(true);
    expect(r.hardErrors.some((e) => e.includes('banned opener "interestingly"'))).toBe(true);
    expect(r.hardErrors.every((e) => !e.includes("N21"))).toBe(true);
    expect(r.shapeIssues).toContain("longest sentence is 31 words against §5d's maximum of 25 (N21)");
    expect(r.shape.max).toBe(31);
    expect(r.shape.n).toBe(3);
  });

  it("reports the Flesch-Kincaid grade and the word count of the script", () => {
    /* MUTATION THAT KILLS THIS: grade the first sentence only, or count
       sentences as words. Ran it: red. */
    const r = voiceReport(SEAM);
    expect(r.grade).toBe(fleschKincaidGrade(SEAM));
    expect(r.wordCount).toBe(SEAM.split(/\s+/).length);
  });

  it("flags a question only when no tape sits beside the seam", () => {
    /* MUTATION THAT KILLS THIS: pass `{ hasTape: false }` whatever the caller
       said (or drop the option). Ran it: red. */
    const q = "So why did the walkway fall?";
    const flagged = (opts: { hasTape?: boolean }) => voiceReport(q, opts).hardErrors.filter((e) => e.includes("rhetorical question"));
    expect(flagged({ hasTape: false })).toHaveLength(1);
    expect(flagged({ hasTape: true })).toHaveLength(0);
    expect(flagged({})).toHaveLength(0);
  });

  it("N24: two numeric expressions in one sentence are a hard error; a two-ended range is one", () => {
    /* MUTATION THAT KILLS THIS: drop the numericExpressionsIn check, or
       compare with >= the cap. Ran both: red. */
    expect(voiceReport("Three hundred people worked there and nine of them left.").hardErrors.some((e) => e.includes("(N24)"))).toBe(true);
    expect(voiceReport("The span grew from two to three metres over the winter.").hardErrors).toEqual([]);
    expect(voiceReport("Nine of them left.").hardErrors).toEqual([]);
  });

  it("N21's mean band and rhythm rule are shape issues, the rhythm rule only past twenty seconds", () => {
    /* MUTATION THAT KILLS THIS: apply the rhythm rule to every script, or
       compare the mean against the maximum. Ran both: red. */
    const ten = "The walkway hung from a single steel rod that ran through both of them.";
    expect(ten.split(/\s+/).length).toBe(14);
    expect(voiceReport(ten).shapeIssues).toEqual([]);
    const long = Array.from({ length: 6 }, () => ten).join(" ");
    expect(long.length / 17).toBeGreaterThan(20);
    expect(voiceReport(long).shapeIssues).toEqual(["no sentence under 6 words; §5d's rhythm rule applies over 20 s (N21)"]);
    expect(voiceReport(`${long} It fell.`).shapeIssues).toEqual([]);
    expect(voiceReport("It fell. Then it held.").shapeIssues).toEqual(["mean sentence length 2.5 words is outside §5d's 12-15 (N21)"]);
  });
});

describe("seamSentenceShape and the per-seam summary (W4-12)", () => {
  it("returns the exact mean, max, short share and over-max count of fixed scripts", () => {
    /* MUTATION THAT KILLS THIS: count `shortShare` against SENTENCE_MAX_WORDS,
       or `overMax` against the mean band. Ran both: red. */
    expect(seamSentenceShape(SEAM)).toEqual({ sentences: 3, meanWords: (7 + 31 + 3) / 3, maxWords: 31, shortShare: 1 / 3, overMax: 1 });
    expect(seamSentenceShape("")).toEqual({ sentences: 0, meanWords: 0, maxWords: 0, shortShare: 0, overMax: 0 });
  });

  it("summarises seams sentence-weighted, with the share of seams whose mean is in 12-15 and the seams over 25", () => {
    /* MUTATION THAT KILLS THIS: average the seam means unweighted, or count
       a seam with no sentence in the share. Ran both: red. */
    /* SEAM: 3 sentences, 41 words, mean 13.7 (in band), one over 25; the
       second: 2 sentences, 5 words, mean 2.5 (out of band). */
    const s = seamShapeSummary([SEAM, "It fell. Then it held.", "   "]);
    expect(s).toEqual({ seams: 2, meanWords: (41 + 5) / 5, maxWords: 31, shareInBand: 1 / 2, overMaxSeams: 1 });
    expect(seamShapeSummary([]).shareInBand).toBeNull();
  });

  it("actVoiceSummary reads every kept page of a written act, connective pages included", () => {
    /* MUTATION THAT KILLS THIS: read only `sourcing: "narration"` beats. Ran it: red. */
    const page = (script: string) => ({ mode: "Patch", script, sources: [], pronunciationHints: [], verified: true });
    const act = {
      title: "Act",
      slots: [
        {
          title: "s",
          beats: [
            { sourcing: "narration", claim: "c", exploration: false, narration: page(SEAM) },
            { sourcing: "tape", claim: "t", exploration: false, connectiveNarration: page("The walkway hung from a single rod that ran through both of them.") },
            { sourcing: "tape", claim: "u", exploration: false }
          ]
        }
      ]
    } as unknown as WrittenAct;
    expect(actVoiceSummary(act).seams).toBe(2);
    expect(actVoiceSummary(act).overMaxSeams).toBe(1);
  });
});

describe("voiceScriptsOf and computeVoiceMetrics — the scorecard over final items", () => {
  it("takes every narration item in order, with tape beside it when a segment is right before or after", () => {
    /* MUTATION THAT KILLS THIS: look only at the next item (a seam after a
       clip reads tapeless). Ran it: red. */
    const items = [
      { type: "narration", id: "prelude", script: "A.", mode: "marker" },
      { type: "narration", id: "n1", script: "B.", mode: "frame" },
      { type: "segment", segment_id: "x#1", slot: "s" },
      { type: "narration", id: "n2", script: "C.", mode: "hinge" },
      { type: "jingle" },
      { type: "narration", id: "n3", script: "D.", mode: "hinge" }
    ] as unknown as ForayItem[];
    expect(voiceScriptsOf(items)).toEqual([
      { id: "prelude", script: "A.", hasTape: false },
      { id: "n1", script: "B.", hasTape: true },
      { id: "n2", script: "C.", hasTape: true },
      { id: "n3", script: "D.", hasTape: false }
    ]);
  });

  it("pins the frozen what-engineers Foray's voice numbers (40 scripts)", () => {
    /* MUTATION THAT KILLS THIS: weight the grade per script instead of per
       word, drop the prelude-style items without tape, or read the band from
       anywhere but the argument. Ran each: red. */
    const scripts = voiceScriptsOf(frozenItems());
    expect(scripts).toHaveLength(40);
    const v = computeVoiceMetrics(scripts);
    const round = (n: number | null) => (n === null ? null : Math.round(n * 10000) / 10000);
    expect({
      items: v.items,
      words: v.words,
      readingGrade: round(v.readingGrade),
      gradeBand: v.gradeBand,
      gradeInBand: v.gradeInBand,
      sentencesOver25Per100Words: round(v.sentencesOver25Per100Words),
      meanSentenceWords: round(v.meanSentenceWords),
      shortSentenceShare: round(v.shortSentenceShare),
      speakability: Object.fromEntries(Object.entries(v.speakabilityPer100Words).map(([k, n]) => [k, round(n)])),
      bannedPer100Words: round(v.bannedPer100Words),
      hardErrors: v.hardErrors,
      seamShape: { ...v.seamShape, meanWords: round(v.seamShape.meanWords), shareInBand: round(v.seamShape.shareInBand) }
    }).toEqual({
      items: 40,
      words: 1647,
      readingGrade: 9.4051,
      gradeBand: [6, 9],
      gradeInBand: false,
      sentencesOver25Per100Words: 1.2143,
      meanSentenceWords: 17.7872,
      shortSentenceShare: 0.1489,
      speakability: { digits: 0.0607, urls: 0, acronyms: 0.7286, brackets: 0 },
      bannedPer100Words: 0.1214,
      hardErrors: 4,
      seamShape: { meanWords: 17.7872, maxWords: 68, shareInBand: 0.05, overMaxSeams: 10 }
    });
    /* A wider band reads the same grade in band. */
    expect(computeVoiceMetrics(scripts, [6, 10]).gradeInBand).toBe(true);
  });

  it("reads the same grade, sentence mean and short share as the scorecard's scoreVoice (one implementation)", () => {
    /* MUTATION THAT KILLS THIS: grade the joined text instead of the
       word-weighted per-item grades. Ran it: red. */
    const scripts = voiceScriptsOf(frozenItems());
    const v = computeVoiceMetrics(scripts);
    const card = scoreVoice(scripts.map((s) => s.script)) as { fkGrade: number; meanWords: number; shortShare: number; words: number; over25: number };
    expect(v.readingGrade).toBeCloseTo(card.fkGrade, 9);
    expect(v.meanSentenceWords).toBeCloseTo(card.meanWords, 9);
    expect(v.shortSentenceShare).toBeCloseTo(card.shortShare, 9);
    expect(v.words).toBe(card.words);
    expect(v.sentencesOver25Per100Words).toBeCloseTo((100 * card.over25) / card.words, 9);
  });

  it("no scripts: a null grade, never in band, and zero rates", () => {
    /* MUTATION THAT KILLS THIS: report grade 0 (in no band, but a number). Ran it: red. */
    const v = computeVoiceMetrics([]);
    expect(v.readingGrade).toBeNull();
    expect(v.gradeInBand).toBeNull();
    expect(v.seamShape.shareInBand).toBeNull();
    expect(v.bannedPer100Words).toBe(0);
  });
});

describe("the voice gate rows (FORAY_VOICE_GATE, FORAY_VOICE_ENFORCE_FROM_ACT, FORAY_READING_GRADE_BAND)", () => {
  it("default report from act 1 with the 6-9 band, and each variable read", () => {
    /* MUTATION THAT KILLS THIS: a default of `enforce` or `off`, a default act
       of 0, or a row missing from GATE_TABLE. Ran each: red. */
    const d = readGateConfig({});
    expect(d.voice).toBe("report");
    expect(d.voiceEnforceFromAct).toBe(1);
    expect(d.readingGradeBand).toEqual([...READING_GRADE_BAND]);
    expect(GATE_TABLE.map((e) => e.env)).toEqual(expect.arrayContaining(["FORAY_VOICE_GATE", "FORAY_VOICE_ENFORCE_FROM_ACT", "FORAY_READING_GRADE_BAND"]));
    const set = readGateConfig({ FORAY_VOICE_GATE: "enforce", FORAY_VOICE_ENFORCE_FROM_ACT: "0", FORAY_READING_GRADE_BAND: "5-8" });
    expect(set.voice).toBe("enforce");
    expect(set.voiceEnforceFromAct).toBe(0);
    expect(set.readingGradeBand).toEqual([5, 8]);
    expect(voiceGateOf(set)).toEqual({ mode: "enforce", enforceFromAct: 0 });
    expect(VOICE_GATE_MODES).toEqual(["off", "report", "enforce"]);
  });

  it("a malformed value throws naming the variable", () => {
    /* MUTATION THAT KILLS THIS: accept a reversed band, or a fractional act. Ran both: red. */
    expect(() => readGateConfig({ FORAY_VOICE_GATE: "strict" })).toThrow(FlagValueError);
    expect(() => readGateConfig({ FORAY_VOICE_ENFORCE_FROM_ACT: "1.5" })).toThrow(/FORAY_VOICE_ENFORCE_FROM_ACT/);
    expect(() => readGateConfig({ FORAY_READING_GRADE_BAND: "9-6" })).toThrow(/FORAY_READING_GRADE_BAND/);
    expect(gradeBandParser.parse("6,9")).toEqual([6, 9]);
    expect(gradeBandParser.parse("6")).toBeUndefined();
    expect(gradeBandParser.parse("6-21")).toBeUndefined();
  });

  it("enforces only in enforce mode and only from the configured act", () => {
    /* MUTATION THAT KILLS THIS: `actIndex > enforceFromAct`, or enforcing in
       report. Ran both: red. */
    expect(voiceGateEnforces({ mode: "enforce", enforceFromAct: 1 }, 0)).toBe(false);
    expect(voiceGateEnforces({ mode: "enforce", enforceFromAct: 1 }, 1)).toBe(true);
    expect(voiceGateEnforces({ mode: "report", enforceFromAct: 0 }, 3)).toBe(false);
    expect(voiceGateEnforces({ mode: "off", enforceFromAct: 0 }, 3)).toBe(false);
    expect(voiceGateEnforces(undefined, 3)).toBe(false);
  });
});

/* ---------------------------------------------------- the pipeline wiring */

/* Medium: the stub spine then has more than one act, so act 2 exists. */
const request: GenerationRequest = { prompt: "the history of grilling and barbecue", duration: "medium", author_id: "founder-1", visibility: "catalogue" };
const options = { userId: "founder-1", now: () => new Date("2026-09-05T12:00:00.000Z"), topic: "food/grilling-bbq" };

function recordingFinalize() {
  return async (input: FinalizeForayInput): Promise<FinalizeForayResult> =>
    ({
      validation: { ok: true, checkForaysErrors: [], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] },
      forayRecord: { id: input.id, generated: true } as never,
      timings: []
    }) as unknown as FinalizeForayResult;
}

/** Stub deps whose writer puts a digit in every act's first seam on the
 * act's first round (in place of its first "the", so the seam keeps its
 * length and its band), recording each act's writer calls by `ctx.actIndex`. */
function stubDeps(digit = false) {
  const writer = new StubNarrationWriterBuilder();
  const callsByAct = new Map<number, number>();
  const injected = new Set<number>();
  const real = writer.writeAct.bind(writer);
  writer.writeAct = async (req, ctx) => {
    const act = ctx.actIndex ?? -1;
    const n = (callsByAct.get(act) ?? 0) + 1;
    callsByAct.set(act, n);
    const reply = await real(req, ctx);
    if (!digit || n > 1) return reply;
    return {
      seams: reply.seams.map((s, i) => {
        if (i !== 0 || !/\bthe\b/.test(s.script)) return s;
        injected.add(act);
        return { ...s, script: s.script.replace(/\bthe\b/, "300") };
      })
    };
  };
  return {
    deps: {
      understander: new StubPromptUnderstander(),
      researcher: new StubExternalResearcher(),
      spineBuilder: new StubSpineBuilder(),
      deepenBuilder: new StubDeepenActBuilder(),
      narrationWriter: writer,
      narrationVerifier: new StubNarrationVerifierBuilder(),
      continuityBuilder: new StubContinuityBuilder(),
      finalize: recordingFinalize()
    },
    callsByAct,
    injected
  };
}

async function run(gates: Partial<GateConfig>, flags: Partial<PipelineFlags> = {}, digit = false) {
  const { deps, callsByAct, injected } = stubDeps(digit);
  const out = await runForayPipeline(request, { ...options, gates, flags }, deps);
  if (out.outcome !== "generated") throw new Error(`stub run did not generate: ${out.outcome}`);
  return { out, callsByAct, injected };
}

describe("runForayPipeline — GV-104 wiring", () => {
  it("the default run's report carries the voice block over its final items; off leaves it out and changes no item", async () => {
    /* MUTATION THAT KILLS THIS: drop `narrationScripts` from the
       buildVeracityMetrics call (no block), or pass it under `off` too. Ran both: red. */
    const byDefault = await run({});
    const voice = byDefault.out.input.meta?.veracity?.voice;
    expect(voice).toBeDefined();
    expect(voice).toEqual(computeVoiceMetrics(voiceScriptsOf(byDefault.out.input.items)));
    expect(voice!.items).toBe(byDefault.out.input.items.filter((i) => i.type === "narration").length);
    const off = await run({ voice: "off" });
    expect(off.out.input.meta?.veracity?.voice).toBeUndefined();
    expect(off.out.input.items).toEqual(byDefault.out.input.items);
    /* The band comes from the gate config. */
    const banded = await run({ readingGradeBand: [0, 20] });
    expect(banded.out.input.meta?.veracity?.voice?.gradeBand).toEqual([0, 20]);
  }, 120_000);

  for (const [label, flags] of [
    ["classic", {}],
    ["per-act", { perActPipeline: true }]
  ] as const) {
    it(`${label}: enforce re-asks a digit seam from act 2 on (ctx.actIndex), never in act 1; report never re-asks`, async () => {
      /* MUTATION THAT KILLS THIS: drop `voiceGate` from narrateOneAct's
         writeNarration options (no act re-asks), or read the act position
         from writeNarration's own index (always 0: no act re-asks). Ran both: red. */
      const enforced = await run({ voice: "enforce" }, flags, true);
      const acts = [...enforced.callsByAct.keys()].sort((a, b) => a - b);
      expect([...enforced.injected].sort((a, b) => a - b)).toEqual(acts);
      expect(acts.length).toBeGreaterThan(1);
      expect(acts[0]).toBe(0);
      expect(enforced.callsByAct.get(0)).toBe(1);
      for (const a of acts.slice(1)) expect(enforced.callsByAct.get(a)).toBe(2);
      const reported = await run({}, flags, true);
      for (const a of acts) expect(reported.callsByAct.get(a)).toBe(1);
    }, 120_000);
  }
});
