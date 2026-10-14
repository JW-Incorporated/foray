import { describe, expect, it } from "vitest";
import { applyClipScores, clipRowKey, scoreSourcedClips, type ClipScoreRecord } from "../src/generation/scoreClips";
import { CLIP_SCORE_LEVELS, JevClipJudge, type ClipJudge, type ClipQuestion } from "../src/generation/clipJudge";
import { TAPE_CUT_MARK, EVIDENCE_MAX_TAPE_CHARS } from "../src/generation/gatherEvidence";
import { deriveItemId, type TranscriptCue, type TranscriptCueProvider, type TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";
import { computeClipOnSubject, tapeRelevanceFromRows } from "../src/generation/veracityMetrics";
import type { CatalogueData } from "../src/generation/catalogueLookup";
import type { SourcedAct, TapeRelevanceInput } from "../src/types/tapeSourcing";
import { FakeJevClient, scoreAnswer } from "./helpers/fakeJevClient";

/**
 * GV-79 (W5-03, MQ-05): `scoreSourcedClips` against a synthetic germ-theory
 * Foray: an inline TranscriptCueProvider with synthetic cues, a synthetic
 * archive, an empty catalogue and a scripted judge. No transcript on disk,
 * no network.
 */

const SUBJECT = "germ theory (how doctors came to accept that microbes cause disease)";
const CATALOGUE: CatalogueData = { items: [], itemTags: {}, concepts: {}, shows: [] };

function entry(show: string, title: string): TranscriptDigestEntry {
  return { show_id: show, show_title: show, guid: `${show}-${title}`, title, cues: 10 };
}

const GERM = entry("history-of-medicine", "Semmelweis and the germ theory");
const CYCLO = entry("food-safety-weekly", "The cyclospora outbreak");
const HEPB = entry("liver-talk", "Hepatitis B in the clinic");
const ARCHIVE = [GERM, CYCLO, HEPB];

const PRE_ROLL = "Earlier the host talked about germ theory and microbes at length.";
const CUES: Record<string, TranscriptCue[]> = {
  [GERM.guid]: [
    { start_sec: 100, end_sec: 160, text: "Semmelweis told doctors to wash their hands because microbes caused childbed fever." },
    { start_sec: 160, end_sec: 300, text: "The germ theory of disease took decades to be accepted." }
  ],
  [CYCLO.guid]: [
    /* Before the placed span: the padding a writer's window would carry. The
       judge must not read it (the placed span only). */
    { start_sec: 10, end_sec: 40, text: PRE_ROLL },
    { start_sec: 100, end_sec: 200, text: "Cyclospora outbreaks came from imported lettuce last summer." }
  ],
  [HEPB.guid]: [{ start_sec: 50, end_sec: 150, text: "Hepatitis B is a liver infection that a vaccine prevents." }]
};

function cueProvider(cues: Record<string, TranscriptCue[]> = CUES): TranscriptCueProvider & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    getCues: (e) => {
      asked.push(e.guid);
      return cues[e.guid] ?? null;
    }
  };
}

function tapeBeat(e: TranscriptDigestEntry, claim: string, startSec: number, endSec: number, mergedInto?: { slot: number; beat: number }) {
  return {
    sourcing: "tape" as const,
    claim,
    exploration: false,
    tape: {
      segmentId: `${deriveItemId(e)}-${startSec}`,
      itemId: deriveItemId(e),
      startSec,
      endSec,
      startAnchor: "start",
      endAnchor: "end",
      tier: 2 as const,
      confidence: "high" as const
    },
    ...(mergedInto ? { mergedInto } : {})
  };
}

const CLAIMS = [
  "Doctors resisted the idea that microbes cause disease.",
  "Outbreaks were traced to contaminated produce.",
  "A vaccine can prevent a chronic infection.",
  "Handwashing cut deaths on the wards."
];

/* Three clips the Foray plays, plus a fourth beat merged into the first
   clip (F-96): four beats, three clips. The first clip is the EXTENDED span
   100-300 s (the claim window was 100-160 s). */
const ACTS: SourcedAct[] = [
  {
    title: "The invisible enemy",
    slots: [
      {
        title: "Who believed it",
        beats: [
          tapeBeat(GERM, CLAIMS[0]!, 100, 300),
          tapeBeat(CYCLO, CLAIMS[1]!, 100, 200),
          tapeBeat(HEPB, CLAIMS[2]!, 50, 150),
          tapeBeat(GERM, CLAIMS[3]!, 100, 300, { slot: 0, beat: 0 })
        ]
      }
    ]
  }
];

function rowsFor(acts: SourcedAct[]): TapeRelevanceInput[] {
  return acts[0]!.slots[0]!.beats.map((beat, beatIndex) => {
    if (beat.sourcing !== "tape") throw new Error("fixture");
    return {
      actIndex: 0,
      slotIndex: 0,
      beatIndex,
      claim: beat.claim,
      itemId: beat.tape.itemId,
      segmentId: beat.tape.segmentId,
      tier: 2,
      taxonomyNodeIds: ["health/medicine"],
      families: ["health"],
      forayTopic: "health/medicine",
      forayFamily: "health",
      /* Every anchor passes the lineage rule: QK-04 reads 1.0 here, which is
         the whole reason MQ-05 exists. */
      onTopic: true,
      ...(beat.mergedInto ? { mergedInto: beat.mergedInto } : {})
    };
  });
}

/** A scripted Jev that scores the germ-theory passage on subject and the
 * other two off (subject 0 and 1). */
function germJev(): FakeJevClient {
  return new FakeJevClient({
    rules: [
      {
        when: () => true,
        answer: (state, question) => {
          const passage = (state as { passage: string }).passage;
          const onSubject = /germ theory|microbes/i.test(passage);
          const low = /Hepatitis/.test(passage) ? 1 : 0;
          return scoreAnswer(onSubject ? 4 : question.id === "subject" ? low : 2, CLIP_SCORE_LEVELS);
        }
      }
    ]
  });
}

function score(judge: ClipJudge, cues = cueProvider(), acts = ACTS, rows = rowsFor(acts)) {
  return scoreSourcedClips({ acts, tapeRelevance: rows }, { cueProvider: cues, transcriptArchive: ARCHIVE, catalogue: CATALOGUE, judge, subjectSentence: SUBJECT });
}

describe("GV-79 scoreSourcedClips — the synthetic germ-theory Foray", () => {
  /* MUTATION THAT KILLS THIS: score every row, merged ones included (drop
     the `mergedInto` skip). Ran it: red (four asks, and the rate's
     denominator becomes 4). */
  it("clipOnSubjectRate is 1/3 with both off-subject clips listed, while QK-04 tapeRelevance stays 1.0", async () => {
    const fake = germJev();
    const records = await score(new JevClipJudge(fake));
    expect(fake.calls).toHaveLength(3);
    const rows = applyClipScores(rowsFor(ACTS), records);
    const clips = computeClipOnSubject(rows);
    expect(clips.rate).toBeCloseTo(0.333, 3);
    expect(clips.scored).toBe(3);
    expect(clips.unscored).toBe(0);
    expect(clips.judge).toBe("jev");
    expect(clips.offSubject.map((c) => c.itemId)).toEqual([deriveItemId(CYCLO), deriveItemId(HEPB)]);
    expect(clips.offSubject.map((c) => c.scores.subject)).toEqual([0, 1]);
    expect(tapeRelevanceFromRows(rows).rate).toBe(1);
    /* The merged beat carries no Scores of its own. */
    expect(rows[3]!.clipScores).toBeUndefined();
  });

  /* MUTATION THAT KILLS THIS: build the window with the default padding
     (`cueWindowText(cues, start, end)`). Ran it: red (the pre-roll is read). */
  it("reads the PLACED span only, the whole extended clip, never the padding around it", async () => {
    const fake = germJev();
    await score(new JevClipJudge(fake));
    const passages = fake.calls.map((c) => (c.state as { passage: string }).passage);
    expect(passages[0]).toContain("The germ theory of disease took decades"); // 160-300 s: the extension
    expect(passages.join(" ")).not.toContain(PRE_ROLL);
    expect(fake.calls.every((c) => (c.state as { subject: string }).subject === SUBJECT)).toBe(true);
    expect(fake.calls.map((c) => (c.state as { claim: string }).claim)).toEqual(CLAIMS.slice(0, 3));
  });

  it("a clip with no transcript is unscored and never reaches the judge", async () => {
    const asked: ClipQuestion[][] = [];
    const judge: ClipJudge = {
      name: "spy",
      score: async (qs) => {
        asked.push([...qs]);
        return new Map(qs.map((q) => [q.key, { subject: 4, claim: 4, judge: "jev" as const }]));
      }
    };
    const { [HEPB.guid]: _gone, ...withoutHepB } = CUES;
    void _gone;
    const records = await score(judge, cueProvider(withoutHepB));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.map((q) => q.key)).toEqual(["0:0:0", "0:0:1"]);
    expect(records.find((r) => r.key === "0:0:2")?.clipScores).toEqual({ unavailable: "no-transcript" });
    const clips = computeClipOnSubject(applyClipScores(rowsFor(ACTS), records));
    expect(clips).toMatchObject({ scored: 2, unscored: 1, rate: 1 });
  });

  /* MUTATION THAT KILLS THIS: drop the `windowTruncated` mark. Ran it: red. */
  it("marks a clip read only on its first EVIDENCE_MAX_TAPE_CHARS characters, and hands the judge no cut mark", async () => {
    const long = "Germ theory was argued over for decades by doctors and microbes hunters alike. ".repeat(60);
    expect(long.length).toBeGreaterThan(EVIDENCE_MAX_TAPE_CHARS);
    const cues = { ...CUES, [GERM.guid]: [{ start_sec: 100, end_sec: 300, text: long }] };
    const fake = germJev();
    const records = await score(new JevClipJudge(fake), cueProvider(cues));
    expect(records.find((r) => r.key === "0:0:0")?.windowTruncated).toBe(true);
    expect(records.find((r) => r.key === "0:0:1")?.windowTruncated).toBeUndefined();
    const passage = (fake.calls[0]!.state as { passage: string }).passage;
    expect(passage).not.toContain(TAPE_CUT_MARK.trim());
    const rows = applyClipScores(rowsFor(ACTS), records);
    expect(rows[0]!.windowTruncated).toBe(true);
  });

  it("every clip unscored (Jev down) gives a null rate, not 1", async () => {
    const down = new FakeJevClient({ fail: { category: "network", reason: "network" } });
    const records = await score(new JevClipJudge(down));
    const clips = computeClipOnSubject(applyClipScores(rowsFor(ACTS), records));
    expect(clips.rate).toBeNull();
    expect(clips.unscored).toBe(3);
    expect(clips.judge).toBeNull();
  });

  it("returns records in row order and leaves the input rows untouched", async () => {
    const rows = rowsFor(ACTS);
    const records: ClipScoreRecord[] = await score(new JevClipJudge(germJev()), cueProvider(), ACTS, rows);
    expect(records.map((r) => r.key)).toEqual(rows.filter((r) => !r.mergedInto).map(clipRowKey));
    expect(rows.every((r) => r.clipScores === undefined)).toBe(true);
  });
});
