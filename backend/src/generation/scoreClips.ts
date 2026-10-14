import type { CatalogueData } from "./catalogueLookup";
import type { ClipJudge, ClipQuestion } from "./clipJudge";
import { TAPE_CUT_MARK, cueWindowText, findDigestForItem } from "./gatherEvidence";
import type { TranscriptCueProvider, TranscriptDigestEntry } from "./transcriptArchiveLookup";
import type { ClipScoreOutcome, SourcedAct, TapeRelevanceInput } from "../types/tapeSourcing";

/**
 * GV-79 (docs/roadmap/generation-v2.md, W5-03; MQ-05): score every clip the
 * Foray PLAYS against the listener's subject and its beat's claim
 * (`clipJudge.ts`), from the sourcing rows §4.5 already emits.
 *
 * THE PLACED SPAN, ALWAYS. The text judged is the clip's own transcript
 * between the pointer's `startSec` and `endSec` (no padding:
 * `cueWindowText(..., 0)`), i.e. the extended span that plays, not the
 * pre-extension claim window (GV-119's judge, W5-05, scores that one: a
 * different stretch of tape).
 *
 * A MERGED BEAT is scored once, on its carrier's clip (F-96: the two beats
 * share one pointer, and the clip plays once), so its row gets no Scores and
 * the rate counts the clip once.
 *
 * Runs off the timed path (runPipeline's `clip-scores` stage) and calls only
 * the injected judge; reading the transcript is local.
 */

export interface ScoreSourcedClipsInput {
  acts: readonly SourcedAct[];
  tapeRelevance: readonly TapeRelevanceInput[];
}

export interface ScoreSourcedClipsOptions {
  cueProvider: TranscriptCueProvider;
  transcriptArchive: TranscriptDigestEntry[];
  catalogue: CatalogueData;
  judge: ClipJudge;
  /** The listener's subject sentence (`subjectSentenceFor`). */
  subjectSentence: string;
}

/** One row's result, keyed by its position (`clipRowKey`). This is what the
 * `clip-scores` checkpoint banks. */
export interface ClipScoreRecord {
  key: string;
  clipScores: ClipScoreOutcome;
  windowTruncated?: true;
}

/** A row's position as the record key: `act:slot:beat`. */
export function clipRowKey(row: Pick<TapeRelevanceInput, "actIndex" | "slotIndex" | "beatIndex">): string {
  return `${row.actIndex}:${row.slotIndex}:${row.beatIndex}`;
}

export async function scoreSourcedClips(sourced: ScoreSourcedClipsInput, opts: ScoreSourcedClipsOptions): Promise<ClipScoreRecord[]> {
  const records: ClipScoreRecord[] = [];
  const questions: ClipQuestion[] = [];
  const truncated = new Set<string>();
  for (const row of sourced.tapeRelevance) {
    if (row.mergedInto) continue;
    const key = clipRowKey(row);
    const beat = sourced.acts[row.actIndex]?.slots[row.slotIndex]?.beats[row.beatIndex];
    if (!beat || beat.sourcing !== "tape") {
      records.push({ key, clipScores: { unavailable: "no-pointer" } });
      continue;
    }
    const tape = beat.tape;
    const entry = findDigestForItem(tape.itemId, opts.transcriptArchive, opts.catalogue);
    const cues = entry ? opts.cueProvider.getCues(entry) : null;
    if (!cues || cues.length === 0) {
      records.push({ key, clipScores: { unavailable: "no-transcript" } });
      continue;
    }
    let text = cueWindowText(cues, tape.startSec, tape.endSec, 0);
    /* Until R2-12 lifts EVIDENCE_MAX_TAPE_CHARS, a clip over ~190 s is read
       on its first ~3,000 characters: the row says so, and the judge reads
       the transcript without the cut mark (it is ours, not the speaker's). */
    if (text.endsWith(TAPE_CUT_MARK)) {
      text = text.slice(0, -TAPE_CUT_MARK.length).trim();
      truncated.add(key);
    }
    if (text.length === 0) {
      records.push({ key, clipScores: { unavailable: "no-window" } });
      continue;
    }
    questions.push({ key, subjectSentence: opts.subjectSentence, claim: row.claim, windowText: text });
  }

  const scored = questions.length > 0 ? await opts.judge.score(questions) : new Map<string, ClipScoreOutcome>();
  for (const q of questions) {
    records.push({
      key: q.key,
      clipScores: scored.get(q.key) ?? { unavailable: "no-answer" },
      ...(truncated.has(q.key) ? { windowTruncated: true as const } : {})
    });
  }
  /* Row order, so the banked stage reads the same however the judge answered. */
  const order = new Map(sourced.tapeRelevance.map((row, i) => [clipRowKey(row), i]));
  return records.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
}

/** `rows` with each record's Scores (and truncation mark) on the row it
 * names. A new array; the input rows are not touched (the `source`
 * checkpoint holds them). Rows no record names are returned unchanged. */
export function applyClipScores(rows: readonly TapeRelevanceInput[], records: readonly ClipScoreRecord[]): TapeRelevanceInput[] {
  const byKey = new Map(records.map((r) => [r.key, r]));
  return rows.map((row) => {
    const record = byKey.get(clipRowKey(row));
    if (!record) return row;
    return { ...row, clipScores: record.clipScores, ...(record.windowTruncated ? { windowTruncated: true as const } : {}) };
  });
}
