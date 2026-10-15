import * as fs from "fs";
import * as path from "path";
import { defaultUnitBudgetGuard, findUnitBudgetError, UnitBudgetStopError, type UnitBudgetExceededError, type UnitBudgetGuard } from "../cost/unitBudget";
import { loadCatalogueData, type CatalogueData } from "../generation/catalogueLookup";
import { CLIP_JUDGE_PURPOSE, clipLevelFor, JevClipJudge, type ClipQuestion } from "../generation/clipJudge";
import { findDigestForItem } from "../generation/gatherEvidence";
import { resolveGateConfig, judgeThreshold, type GateConfig } from "../generation/gateConfig";
import { createJevClient, createJevPool, DEFAULT_JEV_POOL_SIZE, NullJevClient } from "../generation/jevClient";
import type { JevChoiceQuestion, JevClient, JevResult, JevScoreQuestion, JevState, JudgeId } from "../generation/jevTypes";
import { RunLog, runWithRunLog, withCallContext } from "../generation/runLog";
import { loadSegmentPool, type SegmentRecord } from "../generation/segmentPoolLookup";
import {
  candidateSourcesFor,
  isSupportUnavailable,
  JevSentenceSupportJudge,
  statementSentences,
  type SupportSource
} from "../generation/sentenceSupport";
import {
  FileTranscriptCueProvider,
  loadTranscriptArchive,
  type TranscriptCue,
  type TranscriptCueProvider,
  type TranscriptDigestEntry
} from "../generation/transcriptArchiveLookup";
import { PRELUDE_BOILERPLATE } from "../types/narration";

/**
 * GV-92 (docs/roadmap/generation-v2.md, from W1-18; MQ-10, MQ-12, MQ-02,
 * MQ-03, MQ-05): the OFFLINE judged-metrics pass. It runs after a run, off
 * the timed path, over one finished candidate Foray, and writes
 * `<candidate>.judged.json`, which tools/generation-bench/score.mjs (GV-24)
 * reads for its judged cells.
 *
 *   MQ-10 promptFit      one Score 1-5: do the prelude's overview and the slot
 *                        titles answer the prompt's subject and angle, and
 *                        avoid what would disappoint the person who asked?
 *   MQ-12 seamCoherence  one Score 1-5 per seam (a narration item right after
 *                        a clip): does this hand-off follow from the clip just
 *                        heard? Context: the last ~150 words of that clip's
 *                        window plus the seam's script.
 *   MQ-05 clipOnSubjectRate  ClipJudge (GV-79) per played clip, against the
 *                        listener's subject sentence; on subject when the
 *                        subject Score reaches the judge's clipLevel.
 *   MQ-02 supportedSentenceRate  SentenceSupportJudge (GV-27): yes/no per
 *                        statement sentence of a cited narration item, against
 *                        the clips it cites; yes when p reaches supportMinP.
 *   MQ-03 attributionAccuracy  per clip introduction: does the speaker the
 *                        introduction names match the window's diarised
 *                        speakers?
 *
 * NO JudgeClient INTERFACE (the card's integration note). The pass takes an
 * injected JevClient (GV-20); in production that is createJevClient(), which
 * is Jev with GV-47's Qwen-judge fallback when the judge route says so. Every
 * call is recorded by the client stack itself (jevClient.ts for Jev, the chat
 * provider under qwenJudgeClient.ts for the Qwen judge), and the CLI runs
 * inside runWithRunLog so those CallRecords land in one run log, under the
 * call context {stage:'judge', role:'judge'}. Nothing here calls Anthropic or
 * the relay, and nothing here writes data/forays.json.
 *
 * METERED (GV-90). Every ask goes through UnitBudgetGuard.metered with unit
 * `jevCalls`, under the session `judge:<candidate id>` and the report entry's
 * tier. A cap stop ends the pass with UnitBudgetStopError naming the metric
 * that was running; no judged file is written. ClipJudge swallows a unit cap
 * error (it re-throws only dollar budget errors), so the metering wrapper
 * also remembers the stop and the pass re-raises it after the clip phase.
 * Every ask counts one unit, a Qwen-judge fallback ask included: the cap
 * bounds the pass's judge calls, conservatively.
 *
 * WHAT LEAVES THE NETWORK (LM-25, adopted OQ-05): the prompt, the overview
 * and slot titles, clip windows and narration scripts, each question's
 * context held at JUDGE_MAX_CONTEXT_CHARS (~2k tokens: Jev is weak on long
 * irrelevant context, LM-23). WHAT IS WRITTEN: numbers, ids and fixed
 * reasons only. judged.json carries no prompt text and no transcript text.
 *
 * UNCALIBRATED. Jev thresholds are untuned (LM-24): every file says
 * `calibrated: false` until the founder's listening cards calibrate them.
 *
 *   node tools/generation-bench/judge.mjs --candidate <foray.json>
 *     [--report <report.json> [--entry N]] [--golden <golden-v1.json>]
 *     [--prompt-id <id>] [--out <file>] [--runlog <file>]
 */

/* ---------------------------------------------------------------------------
   Questions (JUDGE_QUESTIONS_V1).
   --------------------------------------------------------------------------- */

export const JUDGE_QUESTIONS_VERSION = "judge-questions/1";

/** ~2k tokens of context per question (LM-23). */
export const JUDGE_MAX_CONTEXT_CHARS = 8000;
/** The clip end a seam is judged against (MQ-12). */
export const SEAM_CONTEXT_WORDS = 150;

export const JUDGE_PURPOSES = {
  "MQ-02": "judge-mq02",
  "MQ-03": "judge-mq03",
  "MQ-05": CLIP_JUDGE_PURPOSE,
  "MQ-10": "judge-mq10",
  "MQ-12": "judge-mq12"
} as const;

export const PROMPT_FIT_QUESTION: Readonly<JevScoreQuestion> = Object.freeze({
  id: "promptFit",
  type: "score",
  instructions:
    "`prompt` is what a listener asked for. `overview` and `titles` are what the Foray made for them says it covers. " +
    "Score how well they answer the prompt's subject and angle and avoid what would disappoint the person who asked" +
    " (`disappointment`, when given, names it).",
  criteria: [
    "They answer a different subject; the listener would be disappointed.",
    "They touch the subject but miss the angle the prompt asks for.",
    "They cover the subject and part of the angle.",
    "They answer the subject and angle, with a gap the listener might notice.",
    "They answer the subject and angle squarely and avoid the disappointment."
  ]
});

export const SEAM_QUESTION: Readonly<JevScoreQuestion> = Object.freeze({
  id: "seamFollows",
  type: "score",
  instructions: "`clipEnd` is the end of the clip the listener just heard. Score how well `handoff`, the narration spoken next, follows from it.",
  criteria: [
    "The hand-off ignores or contradicts what was just heard.",
    "The hand-off barely connects to what was just heard.",
    "The hand-off connects, but loosely or abruptly.",
    "The hand-off follows from what was just heard.",
    "The hand-off picks up exactly where the clip left off."
  ]
});

export const ATTRIBUTION_OPTIONS = { match: "match", mismatch: "mismatch", unnamed: "unnamed" } as const;

export const ATTRIBUTION_QUESTION: Readonly<JevChoiceQuestion> = Object.freeze({
  id: "speakerMatch",
  type: "choice",
  instructions:
    "`introduction` is narration spoken just before a clip. `speakers` are the speaker names the clip's transcript gives. " +
    "Does the introduction name who is about to speak, and is that person one of `speakers`?",
  criteria: {
    [ATTRIBUTION_OPTIONS.match]: { what: "The introduction names a speaker who is one of `speakers`." },
    [ATTRIBUTION_OPTIONS.mismatch]: { what: "The introduction names a speaker who is none of `speakers`." },
    [ATTRIBUTION_OPTIONS.unnamed]: { what: "The introduction names no speaker." }
  }
});

/* ---------------------------------------------------------------------------
   The candidate, read loosely (a candidate JSON on disk).
   --------------------------------------------------------------------------- */

export interface CandidateNarration {
  type: "narration";
  id: string;
  script: string;
  slot?: string;
  cites?: Array<{ kind: string; segment_id?: string; publication?: string }>;
}

export interface CandidateSegment {
  type: "segment";
  segment_id: string;
  slot?: string;
  label?: string;
}

export type CandidateItem = CandidateNarration | CandidateSegment | { type: "jingle" };

export interface CandidateForay {
  id: string;
  title: string;
  slots: Array<{ id: string; title: string }>;
  items: CandidateItem[];
  segments: Array<{ id: string; itemId: string; startSec: number; endSec: number }>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The parts of a candidate JSON this pass reads; anything else is ignored. */
export function readCandidate(raw: unknown): CandidateForay {
  if (!isRecord(raw) || !Array.isArray(raw.items)) throw new Error("judgeCandidate: the candidate has no items array");
  const items: CandidateItem[] = raw.items.map((it): CandidateItem => {
    if (!isRecord(it)) return { type: "jingle" };
    if (it.type === "segment" && str(it.segment_id)) {
      return { type: "segment", segment_id: str(it.segment_id), ...(str(it.slot) ? { slot: str(it.slot) } : {}), ...(str(it.label) ? { label: str(it.label) } : {}) };
    }
    if (it.type === "narration") {
      const cites = Array.isArray(it.cites) ? it.cites.filter(isRecord).map((c) => ({ kind: str(c.kind), segment_id: str(c.segment_id), publication: str(c.publication) })) : undefined;
      return {
        type: "narration",
        id: str(it.id),
        script: str(it.script),
        ...(str(it.slot) ? { slot: str(it.slot) } : {}),
        ...(cites && cites.length > 0 ? { cites } : {})
      };
    }
    return { type: "jingle" };
  });
  const slots = Array.isArray(raw.slots) ? raw.slots.filter(isRecord).map((s) => ({ id: str(s.id), title: str(s.title) })) : [];
  const segments = Array.isArray(raw.segments)
    ? raw.segments
        .filter(isRecord)
        .filter((s) => str(s.id) && str(s.itemId) && finite(s.startSec) && finite(s.endSec))
        .map((s) => ({ id: str(s.id), itemId: str(s.itemId), startSec: s.startSec as number, endSec: s.endSec as number }))
    : [];
  return { id: str(raw.id), title: str(raw.title), slots, items, segments };
}

/* ---------------------------------------------------------------------------
   Clip windows: the transcript a played clip covers.
   --------------------------------------------------------------------------- */

export type ClipWindowResult = { cues: TranscriptCue[] } | { unavailable: string };

export interface ClipWindowSource {
  windowFor(segmentId: string): ClipWindowResult;
}

export interface ArchiveClipWindowOptions {
  candidate: CandidateForay;
  /** The committed pool (data/segments.json), for clips the run did not mint. */
  pool: ReadonlyArray<Pick<SegmentRecord, "id" | "item_id" | "start_sec" | "end_sec">>;
  archive: TranscriptDigestEntry[];
  catalogue: CatalogueData;
  cueProvider: TranscriptCueProvider;
}

/**
 * Resolves a segment id to its episode and seconds (the candidate's minted
 * `segments` first, then the pool), the episode to its digest entry
 * (findDigestForItem, as scoreClips.ts does) and the entry to the cues that
 * overlap the clip. Reasons: no-segment, no-transcript, no-window.
 */
export function createArchiveClipWindows(opts: ArchiveClipWindowOptions): ClipWindowSource {
  const minted = new Map(opts.candidate.segments.map((s) => [s.id, s]));
  const pooled = new Map(opts.pool.map((s) => [s.id, s]));
  return {
    windowFor(segmentId) {
      const m = minted.get(segmentId);
      const p = m ? null : pooled.get(segmentId);
      const span = m ? { itemId: m.itemId, startSec: m.startSec, endSec: m.endSec } : p ? { itemId: p.item_id, startSec: p.start_sec, endSec: p.end_sec } : null;
      if (!span) return { unavailable: "no-segment" };
      const entry = findDigestForItem(span.itemId, opts.archive, opts.catalogue);
      const cues = entry ? opts.cueProvider.getCues(entry) : null;
      if (!cues || cues.length === 0) return { unavailable: "no-transcript" };
      const inside = cues.filter((c) => c.end_sec > span.startSec && c.start_sec < span.endSec && str(c.text).trim().length > 0);
      if (inside.length === 0) return { unavailable: "no-window" };
      return { cues: inside };
    }
  };
}

const windowText = (cues: readonly TranscriptCue[]): string =>
  cues
    .map((c) => str(c.text).trim())
    .filter(Boolean)
    .join(" ");

/** The last `n` words of `text`. */
export function lastWords(text: string, n: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  return words.slice(Math.max(0, words.length - n)).join(" ");
}

/** `text` cut to at most `max` characters at a word edge; `cut` says whether it was. */
export function capChars(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  const head = text.slice(0, max);
  const edge = head.lastIndexOf(" ");
  return { text: (edge > max / 2 ? head.slice(0, edge) : head).trim(), cut: true };
}

/** The distinct speaker names the window's cues carry (diarised transcripts only). */
export function windowSpeakers(cues: readonly TranscriptCue[]): string[] {
  const out: string[] = [];
  for (const c of cues) {
    const s = typeof c.speaker === "string" ? c.speaker.trim() : "";
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** The prelude's overview: the prelude script without the shared disclosure. */
export function overviewOf(candidate: CandidateForay): string {
  const prelude = candidate.items.find((it): it is CandidateNarration => it.type === "narration" && it.id === "prelude");
  const script = prelude?.script ?? "";
  const at = script.indexOf(PRELUDE_BOILERPLATE);
  return (at >= 0 ? script.slice(at + PRELUDE_BOILERPLATE.length) : script).trim();
}

/* ---------------------------------------------------------------------------
   The judged file.
   --------------------------------------------------------------------------- */

export type JudgedProvider = "jev" | "qwen-judge";

export interface JudgedItem {
  metric: "MQ-02" | "MQ-03" | "MQ-05" | "MQ-10" | "MQ-12";
  /** An item id, `<index>:<segment_id>` for a clip, `<item id>#<n>` for a sentence. */
  key: string;
  provider?: JudgedProvider;
  /** MQ-10 / MQ-12: the Score on 1-5. */
  score?: number;
  /** MQ-05: the clip's two Scores (0-4) and the level they were read at. */
  subject?: number;
  claim?: number;
  level?: number;
  /** MQ-02: the support probability and the threshold it was read at. */
  p?: number;
  minP?: number;
  /** MQ-03: the judge's choice. */
  choice?: string;
  /** The yes/no the metric counts (MQ-02, MQ-03, MQ-05). */
  pass?: boolean;
  /** Why the item has no score (a fixed reason, never text). */
  unavailable?: string;
  /** The context was cut to JUDGE_MAX_CONTEXT_CHARS. */
  truncated?: true;
}

export interface JudgedMetric {
  /** The rate (MQ-02, MQ-03, MQ-05) or mean Score 1-5 (MQ-10, MQ-12); null when nothing was scored. */
  value: number | null;
  scored: number;
  unscored: number;
  /** MQ-02, MQ-03, MQ-05: how many scored items passed. */
  passed?: number;
  /** MQ-02: statement sentences of narration items that cite nothing (not judged). */
  uncited?: number;
  /** MQ-03: introductions that name no speaker (not in the rate). */
  unnamed?: number;
}

export interface JudgedFile {
  questionsVersion: typeof JUDGE_QUESTIONS_VERSION;
  candidateId: string;
  promptId: string | null;
  /** The judge that answered: one provider, 'mixed' when the fallback changed it mid-pass, null when none answered. */
  provider: JudgedProvider | "mixed" | null;
  model: string | null;
  calibrated: false;
  perItem: JudgedItem[];
  "MQ-02": JudgedMetric;
  "MQ-03": JudgedMetric;
  "MQ-05": JudgedMetric;
  "MQ-10": JudgedMetric;
  "MQ-12": JudgedMetric;
}

/* ---------------------------------------------------------------------------
   The pass.
   --------------------------------------------------------------------------- */

export interface JudgeCandidateInput {
  candidate: CandidateForay;
  /** The listener's prompt (report entry or golden manifest). Sent to the judge, never written. */
  prompt: string;
  promptId?: string | null;
  /** What would disappoint the listener, when a manifest carries it. */
  disappointment?: string | null;
  /** The duration tier the jevCalls cap is read at (the report entry's `duration`). */
  tier?: string;
}

export interface JudgeCandidateDeps {
  client: JevClient;
  windows: ClipWindowSource;
  unitGuard?: UnitBudgetGuard;
  /** The metering session (default `judge:<candidate id>`). */
  sessionId?: string;
  gates?: Pick<GateConfig, "supportMinP.jev" | "supportMinP.qwen" | "clipLevel.jev" | "clipLevel.qwen">;
  /** Asks in flight at once for the clip and support fan-outs (default 8). */
  maxInFlight?: number;
}

const providerOf = (judge: JudgeId | undefined): JudgedProvider => (judge === "qwen" ? "qwen-judge" : "jev");
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function metric(scored: number, unscored: number, value: number | null, extra: Partial<JudgedMetric> = {}): JudgedMetric {
  return { value: value === null ? null : round3(value), scored, unscored, ...extra };
}

const mean = (xs: readonly number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

function scoreFrom(result: JevResult, id: string): { score: number } | { unavailable: string } {
  if (!result.ok) return { unavailable: result.error.reason || result.error.category };
  const a = result.answers.find((x) => x.id === id);
  if (!a || a.type !== "score" || !Number.isFinite(a.score)) return { unavailable: "malformed" };
  return { score: a.score + 1 };
}

/**
 * Judges one candidate. Throws UnitBudgetStopError when the jevCalls cap
 * stops the pass; a judge that is down leaves items `unavailable`, never a
 * pass.
 */
export async function judgeCandidate(input: JudgeCandidateInput, deps: JudgeCandidateDeps): Promise<JudgedFile> {
  const { candidate } = input;
  if (input.prompt.trim().length === 0) throw new Error("judgeCandidate: no prompt (pass --report or --golden)");
  const guard = deps.unitGuard ?? defaultUnitBudgetGuard;
  const sessionId = deps.sessionId ?? `judge:${candidate.id || "candidate"}`;
  const gates = deps.gates ?? resolveGateConfig();
  const tier = input.tier;
  const client = deps.client;

  /* Metering, the stop it may raise, and which judges and models answered. */
  const halt: { error: UnitBudgetExceededError | null } = { error: null };
  const judges = new Set<JudgedProvider>();
  const models = new Set<string>();
  const metered: JevClient = {
    async ask(state, questions, opts) {
      if (halt.error) throw halt.error;
      try {
        const result = await guard.metered({ sessionId, unit: "jevCalls", estimate: 1, ...(tier !== undefined ? { tier } : {}) }, () =>
          client.ask(state, questions, opts)
        );
        if (result.ok) {
          judges.add(providerOf(result.judge));
          models.add(result.model);
        }
        return result;
      } catch (err) {
        const unit = findUnitBudgetError(err);
        if (unit && !halt.error) halt.error = unit;
        throw err;
      }
    }
  };
  const pool = createJevPool(metered, { maxInFlight: deps.maxInFlight ?? DEFAULT_JEV_POOL_SIZE });

  const phase = async <T>(name: JudgedItem["metric"], fn: () => Promise<T>): Promise<T> => {
    let value: T;
    try {
      value = await fn();
    } catch (err) {
      const unit = findUnitBudgetError(err) ?? halt.error;
      if (unit) throw new UnitBudgetStopError(`judge:${name}`, unit, `The judged pass for ${candidate.id || "the candidate"} wrote nothing.`);
      throw err;
    }
    if (halt.error) throw new UnitBudgetStopError(`judge:${name}`, halt.error, `The judged pass for ${candidate.id || "the candidate"} wrote nothing.`);
    return value;
  };

  const perItem: JudgedItem[] = [];
  const items = candidate.items;
  const nextClip = (i: number): { index: number; item: CandidateSegment } | null => {
    for (let j = i + 1; j < items.length; j++) {
      const it = items[j]!;
      if (it.type === "segment") return { index: j, item: it };
      if (it.type === "narration") return null;
    }
    return null;
  };
  const prevClip = (i: number): { index: number; item: CandidateSegment } | null => {
    for (let j = i - 1; j >= 0; j--) {
      const it = items[j]!;
      if (it.type === "segment") return { index: j, item: it };
      if (it.type === "narration") return null;
    }
    return null;
  };
  const windows = new Map<string, ClipWindowResult>();
  const windowOf = (segmentId: string): ClipWindowResult => {
    let w = windows.get(segmentId);
    if (!w) {
      w = deps.windows.windowFor(segmentId);
      windows.set(segmentId, w);
    }
    return w;
  };

  return withCallContext({ stage: "judge", role: "judge", ...(tier !== undefined ? { tier } : {}) }, async () => {
    /* ---- MQ-10 prompt fit ---- */
    const mq10 = await phase("MQ-10", async () => {
      const overview = capChars(overviewOf(candidate), JUDGE_MAX_CONTEXT_CHARS / 2);
      const titles = candidate.slots.map((s) => s.title).filter(Boolean);
      const state: JevState = {
        prompt: capChars(input.prompt, 2000).text,
        overview: overview.text,
        titles,
        ...(input.disappointment ? { disappointment: capChars(input.disappointment, 1000).text } : {})
      };
      const result = await pool.ask(state, [PROMPT_FIT_QUESTION], { purpose: JUDGE_PURPOSES["MQ-10"] });
      const s = scoreFrom(result, PROMPT_FIT_QUESTION.id);
      const row: JudgedItem = {
        metric: "MQ-10",
        key: "prelude",
        ...("score" in s ? { score: round3(s.score), provider: providerOf(result.judge) } : { unavailable: s.unavailable }),
        ...(overview.cut ? { truncated: true as const } : {})
      };
      perItem.push(row);
      return "score" in s ? metric(1, 0, s.score) : metric(0, 1, null);
    });

    /* ---- MQ-12 seam coherence ---- */
    const mq12 = await phase("MQ-12", async () => {
      const scores: number[] = [];
      let unscored = 0;
      for (let i = 0; i < items.length; i++) {
        const it = items[i]!;
        if (it.type !== "narration" || !it.script.trim()) continue;
        const clip = prevClip(i);
        if (!clip) continue;
        const w = windowOf(clip.item.segment_id);
        if ("unavailable" in w) {
          unscored++;
          perItem.push({ metric: "MQ-12", key: it.id, unavailable: w.unavailable });
          continue;
        }
        const handoff = capChars(it.script, JUDGE_MAX_CONTEXT_CHARS / 2);
        const clipEnd = capChars(lastWords(windowText(w.cues), SEAM_CONTEXT_WORDS), JUDGE_MAX_CONTEXT_CHARS / 2);
        const result = await pool.ask({ clipEnd: clipEnd.text, handoff: handoff.text }, [SEAM_QUESTION], { purpose: JUDGE_PURPOSES["MQ-12"] });
        const s = scoreFrom(result, SEAM_QUESTION.id);
        if ("score" in s) scores.push(s.score);
        else unscored++;
        perItem.push({
          metric: "MQ-12",
          key: it.id,
          ...("score" in s ? { score: round3(s.score), provider: providerOf(result.judge) } : { unavailable: s.unavailable }),
          ...(handoff.cut || clipEnd.cut ? { truncated: true as const } : {})
        });
      }
      return metric(scores.length, unscored, mean(scores));
    });

    /* ---- MQ-03 attribution ---- */
    const mq03 = await phase("MQ-03", async () => {
      let matched = 0;
      let judged = 0;
      let unnamed = 0;
      let unscored = 0;
      for (let i = 0; i < items.length; i++) {
        const it = items[i]!;
        if (it.type !== "narration" || !it.script.trim()) continue;
        const clip = nextClip(i);
        if (!clip) continue;
        const w = windowOf(clip.item.segment_id);
        const speakers = "unavailable" in w ? [] : windowSpeakers(w.cues);
        if ("unavailable" in w || speakers.length === 0) {
          unscored++;
          perItem.push({ metric: "MQ-03", key: it.id, unavailable: "unavailable" in w ? w.unavailable : "no-diarisation" });
          continue;
        }
        const introduction = capChars(it.script, JUDGE_MAX_CONTEXT_CHARS / 2);
        const result = await pool.ask({ introduction: introduction.text, speakers }, [ATTRIBUTION_QUESTION], { purpose: JUDGE_PURPOSES["MQ-03"] });
        const answer = result.ok ? result.answers.find((a) => a.id === ATTRIBUTION_QUESTION.id) : undefined;
        if (!result.ok || !answer || answer.type !== "choice") {
          unscored++;
          perItem.push({ metric: "MQ-03", key: it.id, unavailable: result.ok ? "malformed" : result.error.reason || result.error.category });
          continue;
        }
        const row: JudgedItem = { metric: "MQ-03", key: it.id, choice: answer.choice, provider: providerOf(result.judge), ...(introduction.cut ? { truncated: true as const } : {}) };
        if (answer.choice === ATTRIBUTION_OPTIONS.unnamed) unnamed++;
        else {
          judged++;
          const pass = answer.choice === ATTRIBUTION_OPTIONS.match;
          if (pass) matched++;
          row.pass = pass;
        }
        perItem.push(row);
      }
      return metric(judged, unscored, judged > 0 ? matched / judged : null, { passed: matched, unnamed });
    });

    /* ---- MQ-05 clip on subject (ClipJudge, GV-79) ---- */
    const mq05 = await phase("MQ-05", async () => {
      const questions: ClipQuestion[] = [];
      const pending: JudgedItem[] = [];
      const truncated = new Set<string>();
      const slotTitle = new Map(candidate.slots.map((s) => [s.id, s.title]));
      items.forEach((it, index) => {
        if (it.type !== "segment") return;
        const key = `${index}:${it.segment_id}`;
        const w = windowOf(it.segment_id);
        if ("unavailable" in w) {
          pending.push({ metric: "MQ-05", key, unavailable: w.unavailable });
          return;
        }
        const passage = capChars(windowText(w.cues), JUDGE_MAX_CONTEXT_CHARS - 2000);
        if (passage.cut) truncated.add(key);
        /* The candidate keeps no beat claim; the slot's title (or the item's
           label) is what the clip was placed to say. */
        const claim = it.label ?? (it.slot ? slotTitle.get(it.slot) : undefined) ?? "";
        questions.push({ key, subjectSentence: capChars(input.prompt, 1000).text, claim: capChars(claim, 1000).text, windowText: passage.text });
        pending.push({ metric: "MQ-05", key });
      });
      const outcomes = questions.length > 0 ? await new JevClipJudge(pool).score(questions) : new Map();
      let scored = 0;
      let passed = 0;
      let unscored = 0;
      for (const row of pending) {
        if (row.unavailable) {
          unscored++;
          perItem.push(row);
          continue;
        }
        const outcome = outcomes.get(row.key) ?? { unavailable: "no-answer" };
        if ("unavailable" in outcome) {
          unscored++;
          perItem.push({ ...row, unavailable: outcome.unavailable });
          continue;
        }
        const level = clipLevelFor(gates, outcome.judge);
        const pass = outcome.subject >= level;
        scored++;
        if (pass) passed++;
        perItem.push({
          ...row,
          provider: providerOf(outcome.judge === "qwen" ? "qwen" : "jev"),
          subject: outcome.subject,
          claim: outcome.claim,
          level,
          pass,
          ...(truncated.has(row.key) ? { truncated: true as const } : {})
        });
      }
      return metric(scored, unscored, scored > 0 ? passed / scored : null, { passed });
    });

    /* ---- MQ-02 supported sentences (SentenceSupportJudge, GV-27) ---- */
    const mq02 = await phase("MQ-02", async () => {
      let uncited = 0;
      const jobs: Array<{ key: string; sentence: string; sources: SupportSource[] } | { key: string; unavailable: string }> = [];
      for (const it of items) {
        /* The prelude and disclosure are the shared boilerplate plus the
           overview (MQ-10's), not claims a source could back. */
        if (it.type !== "narration" || !it.script.trim() || it.id === "prelude" || it.id === "disclosure") continue;
        const sentences = statementSentences(it.script);
        if (!it.cites || it.cites.length === 0) {
          uncited += sentences.length;
          continue;
        }
        const sources: SupportSource[] = [];
        for (const cite of it.cites) {
          if (cite.kind !== "tape" || !cite.segment_id) continue;
          const w = windowOf(cite.segment_id);
          if ("unavailable" in w) continue;
          if (sources.some((s) => s.id === cite.segment_id)) continue;
          sources.push({ id: cite.segment_id, kind: "clip", text: windowText(w.cues), publication: "" });
        }
        sentences.forEach((sentence, n) => {
          const key = `${it.id}#${n}`;
          if (sources.length === 0) jobs.push({ key, unavailable: "no-source-text" });
          else jobs.push({ key, sentence, sources: candidateSourcesFor(sentence, sources, { mustInclude: sources.map((s) => s.id), maxChars: JUDGE_MAX_CONTEXT_CHARS - 1000 }) });
        });
      }
      const verdicts = await Promise.all(
        jobs.map(async (job): Promise<JudgedItem> => {
          if ("unavailable" in job) return { metric: "MQ-02", key: job.key, unavailable: job.unavailable };
          /* One judge per sentence, over a client that remembers which judge
             answered, so the threshold is that judge's (GV-47). */
          let answered: JudgeId | undefined;
          const observed: JevClient = {
            async ask(state, questions, opts) {
              const r = await pool.ask(state, questions, opts);
              answered = r.judge;
              return r;
            }
          };
          const verdict = (await new JevSentenceSupportJudge(observed, { purpose: JUDGE_PURPOSES["MQ-02"], maxInFlight: 1 }).judge([{ id: job.key, sentence: job.sentence, sources: job.sources }])).get(job.key);
          if (!verdict || isSupportUnavailable(verdict)) return { metric: "MQ-02", key: job.key, unavailable: verdict && isSupportUnavailable(verdict) ? verdict.reason : "no-answer" };
          const judge: JudgeId = answered === "qwen" ? "qwen" : "jev";
          const minP = judgeThreshold(gates as GateConfig, "supportMinP", judge);
          return { metric: "MQ-02", key: job.key, provider: providerOf(judge), p: round3(verdict.p), minP, pass: verdict.p >= minP };
        })
      );
      let scored = 0;
      let passed = 0;
      let unscored = 0;
      for (const v of verdicts) {
        perItem.push(v);
        if (v.unavailable) unscored++;
        else {
          scored++;
          if (v.pass) passed++;
        }
      }
      return metric(scored, unscored, scored > 0 ? passed / scored : null, { passed, uncited });
    });

    const providers = [...judges];
    const modelList = [...models];
    return {
      questionsVersion: JUDGE_QUESTIONS_VERSION,
      candidateId: candidate.id,
      promptId: input.promptId ?? null,
      provider: providers.length === 0 ? null : providers.length === 1 ? providers[0]! : "mixed",
      model: modelList.length === 0 ? null : modelList.length === 1 ? modelList[0]! : "mixed",
      calibrated: false,
      perItem,
      "MQ-02": mq02,
      "MQ-03": mq03,
      "MQ-05": mq05,
      "MQ-10": mq10,
      "MQ-12": mq12
    } satisfies JudgedFile;
  });
}

/* ---------------------------------------------------------------------------
   CLI.
   --------------------------------------------------------------------------- */

export interface JudgeArgs {
  candidate: string;
  report?: string;
  entry?: number;
  golden?: string;
  promptId?: string;
  out?: string;
  runlog?: string;
}

const VALUE_FLAGS = ["--candidate", "--report", "--entry", "--golden", "--prompt-id", "--out", "--runlog"] as const;

export function parseJudgeArgs(argv: readonly string[]): JudgeArgs {
  const got: Partial<Record<(typeof VALUE_FLAGS)[number], string>> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (!(VALUE_FLAGS as readonly string[]).includes(flag)) throw new Error(`judgeCandidate: unknown argument ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`judgeCandidate: ${flag} needs a value`);
    got[flag as (typeof VALUE_FLAGS)[number]] = value;
    i++;
  }
  if (!got["--candidate"]) throw new Error("judgeCandidate: --candidate <foray.json> is required");
  let entry: number | undefined;
  if (got["--entry"] !== undefined) {
    entry = Number(got["--entry"]);
    if (!Number.isInteger(entry) || entry < 0) throw new Error("judgeCandidate: --entry must be a non-negative integer");
  }
  return {
    candidate: got["--candidate"],
    ...(got["--report"] ? { report: got["--report"] } : {}),
    ...(entry !== undefined ? { entry } : {}),
    ...(got["--golden"] ? { golden: got["--golden"] } : {}),
    ...(got["--prompt-id"] ? { promptId: got["--prompt-id"] } : {}),
    ...(got["--out"] ? { out: got["--out"] } : {}),
    ...(got["--runlog"] ? { runlog: got["--runlog"] } : {})
  };
}

/** `<candidate>.judged.json`, the name score.mjs looks for beside the candidate. */
export function judgedPathFor(candidateFile: string): string {
  return candidateFile.replace(/\.json$/i, "") + ".judged.json";
}

// eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-supplied CLI paths (--candidate, --report, --golden).
const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"));

/** The report entry for this candidate: `--entry N`, else the entry whose
 * `file` names the candidate, else the only entry. */
export function pickReportEntry(report: unknown, candidateFile: string, index?: number): Record<string, unknown> | null {
  const entries = isRecord(report) && Array.isArray(report.entries) ? report.entries.filter(isRecord) : [];
  if (index !== undefined) return entries[index] ?? null;
  const base = path.basename(candidateFile);
  const byFile = entries.find((e) => typeof e.file === "string" && path.basename(e.file) === base);
  if (byFile) return byFile;
  return entries.length === 1 ? entries[0]! : null;
}

/** The prompt, prompt id, disappointment and tier from the report entry and the golden manifest. */
export function resolvePrompt(args: Pick<JudgeArgs, "candidate" | "entry" | "promptId">, report: unknown, golden: unknown): Pick<JudgeCandidateInput, "prompt" | "promptId" | "disappointment" | "tier"> {
  const entry = report === undefined ? null : pickReportEntry(report, args.candidate, args.entry);
  const promptId = args.promptId ?? (entry && typeof entry.promptId === "string" ? entry.promptId : null);
  const rows = Array.isArray(golden) ? golden.filter(isRecord) : isRecord(golden) && Array.isArray(golden.prompts) ? golden.prompts.filter(isRecord) : [];
  const goldenRow = promptId ? rows.find((r) => r.id === promptId) : undefined;
  const prompt = (entry && str(entry.prompt)) || (goldenRow && str(goldenRow.prompt)) || "";
  const disappointment = (goldenRow && str(goldenRow.disappointment)) || (entry && str(entry.disappointment)) || null;
  const tier = (entry && str(entry.duration)) || (goldenRow && str(goldenRow.duration)) || undefined;
  return { prompt, promptId, disappointment, ...(tier ? { tier } : {}) };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseJudgeArgs(argv);
  const candidate = readCandidate(readJson(args.candidate));
  const resolved = resolvePrompt(args, args.report ? readJson(args.report) : undefined, args.golden ? readJson(args.golden) : undefined);
  if (!resolved.prompt) {
    console.error("judgeCandidate: no prompt for this candidate (give --report with its entry, or --golden with --prompt-id)");
    return 2;
  }
  const client = createJevClient();
  if (client instanceof NullJevClient) {
    console.error("judgeCandidate: no judge. Set JEV_API_KEY or JEV_KEY_FILE (or route FORAY_STAGE_JUDGE to a local judge); nothing was sent.");
    return 2;
  }
  const windows = createArchiveClipWindows({
    candidate,
    pool: loadSegmentPool(),
    archive: loadTranscriptArchive(),
    catalogue: loadCatalogueData(),
    cueProvider: new FileTranscriptCueProvider()
  });
  const log = new RunLog();
  try {
    const judged = await runWithRunLog(log, () => judgeCandidate({ candidate, ...resolved }, { client, windows }));
    const out = args.out ?? judgedPathFor(args.candidate);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-supplied --out, or beside the candidate.
    fs.writeFileSync(out, `${JSON.stringify(judged, null, 2)}\n`);
    const cell = (id: "MQ-02" | "MQ-03" | "MQ-05" | "MQ-10" | "MQ-12"): string => `${id}=${judged[id].value ?? "null"}`;
    console.log(`judgeCandidate: ${out} (${judged.provider ?? "no judge answered"}; uncalibrated) ${["MQ-02", "MQ-03", "MQ-05", "MQ-10", "MQ-12"].map((m) => cell(m as "MQ-02")).join(" ")}`);
    return 0;
  } finally {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-supplied --runlog.
    if (args.runlog) fs.writeFileSync(args.runlog, log.toJsonl());
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(2);
    }
  );
}
