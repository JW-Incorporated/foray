import * as path from "path";
import { z } from "zod";
import type { ClipScoreOutcome, TapePointer, TapeRelevanceInput } from "../types/tapeSourcing";
import { NarratedBeatSchema, isSynthesisVerified, isTapeSource, tapeDocIdFor, type NarratedBeat } from "../types/narration";
import type { CatalogueData } from "./catalogueLookup";
import { CLIP_SCORE_LEVELS, JevClipJudge, subjectSentenceFor, type ClipQuestion } from "./clipJudge";
import { TAPE_CUT_MARK, cueWindowText, findDigestForItem } from "./gatherEvidence";
import { DEFAULT_JEV_POOL_SIZE, createJevPool } from "./jevClient";
import type { JevClient, JudgeId } from "./jevTypes";
import type { JudgeThresholdName } from "./gateConfig";
import { JevSentenceSupportJudge, candidateSourcesFor, isSupportUnavailable, statementSentences, type SentenceSupportItem, type SupportSource } from "./sentenceSupport";
import type { TranscriptCueProvider, TranscriptDigestEntry } from "./transcriptArchiveLookup";

/**
 * GV-103 (docs/roadmap/generation-v2.md, from W5-07; covers R1-07, R2-09,
 * R2-03, R1-20): the judge calibration harness. LM-24: untuned thresholds
 * fail (10 of 13 retries). Labelled examples go in; an agreement-by-
 * threshold table comes out, for page support (GV-27's per-sentence judge)
 * and for the clip scores (GV-79's two Scores), and the lowest threshold at
 * which judge-vs-label agreement reaches 0.9 is the recommendation. The
 * value goes into GV-47's per-judge gate keys (`supportMinP.<judge>`,
 * `clipLevel.<judge>`) in a follow-up orchestrator PR; nothing here changes
 * a run.
 *
 * NO NEW CLAUDE CALL. Labels come from the founder or the review lane (GV-41),
 * or, only when the founder allows it (#1163, OQ-06), from the pipeline's
 * own verifier verdicts already on disk (`labelSource: 'run-verdict'`). The
 * judge asked is the JevClient interface: Jev, or the Qwen judge (GV-47).
 *
 * PURE. This module reads no file and writes none (promptNoPersistence): the
 * export is built from checkpoint stages the driver hands over, and the CLI
 * (`cli/calibrateJudges.ts`) does every read and write.
 *
 * THE DATA (the card's "data reality"). A run's checkpoint holds the
 * WrittenActs (verified, verifierNotes, evidence) and is DELETED when the
 * candidate is written, so `generateForays --keep-calibration <dir>` writes
 * a `CalibrationExport` per prompt just before that discard. The export holds
 * no prompt: only the written acts, the sourcing rows, the tape pointers and
 * the listener's subject sentence (the spine's subject and angle, which the
 * candidate already carries as its title, the §9.4 carve-out).
 */

/* ---------------------------------------------------------------------------
   Where calibration data may be written.
   --------------------------------------------------------------------------- */

/** The directory name the repository's .gitignore excludes wherever it sits
 * (`data-local/`, no leading slash), so a file under it is never committed. */
export const DATA_LOCAL_DIR = "data-local";

/** Whether `p`, resolved against `cwd`, is a `data-local` directory or inside
 * one. */
export function isUnderDataLocal(p: string, cwd: string = process.cwd()): boolean {
  const resolved = path.resolve(cwd, p);
  return resolved.split(/[\\/]+/).includes(DATA_LOCAL_DIR);
}

/** Why `flag`'s value `p` is refused, or null when it is under data-local/.
 * Transcript windows, scripts and evidence text are machine-local data that
 * must never reach git (hard rule: generated local data is never committed). */
export function dataLocalRefusal(flag: string, p: string, cwd: string = process.cwd()): string | null {
  if (p.trim().length === 0) return `${flag} needs a path under ${DATA_LOCAL_DIR}/`;
  if (isUnderDataLocal(p, cwd)) return null;
  return `${flag} must be under ${DATA_LOCAL_DIR}/ (it holds transcript and evidence text that is never committed); got a path outside it`;
}

/* ---------------------------------------------------------------------------
   Labelled examples.
   --------------------------------------------------------------------------- */

export const EXAMPLE_KINDS = ["page-support", "clip-subject", "clip-claim"] as const;
export type ExampleKind = (typeof EXAMPLE_KINDS)[number];

export const LABEL_SOURCES = ["founder", "review-lane", "run-verdict"] as const;
export type LabelSource = (typeof LABEL_SOURCES)[number];

const SupportSourceSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["claim", "clip", "page", "doc"]),
    text: z.string(),
    publication: z.string()
  })
  .strict();

/** What a page-support example carries: the page's script, its beat's
 * claim, the documents the page held (as support sources) and the ids of
 * those its own declared sources point at (always offered to the judge). */
export const PagePayloadSchema = z
  .object({
    script: z.string().min(1),
    claim: z.string(),
    sources: z.array(SupportSourceSchema),
    mustInclude: z.array(z.string())
  })
  .strict();
export type PagePayload = z.infer<typeof PagePayloadSchema>;

/** What a clip example carries: exactly what GV-79's judge reads. */
export const ClipPayloadSchema = z
  .object({
    subjectSentence: z.string(),
    claim: z.string(),
    windowText: z.string().min(1)
  })
  .strict();
export type ClipPayload = z.infer<typeof ClipPayloadSchema>;

export const LabelledExampleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page-support"), id: z.string().min(1), payload: PagePayloadSchema, label: z.boolean(), labelSource: z.enum(LABEL_SOURCES) }).strict(),
  z.object({ kind: z.literal("clip-subject"), id: z.string().min(1), payload: ClipPayloadSchema, label: z.boolean(), labelSource: z.enum(LABEL_SOURCES) }).strict(),
  z.object({ kind: z.literal("clip-claim"), id: z.string().min(1), payload: ClipPayloadSchema, label: z.boolean(), labelSource: z.enum(LABEL_SOURCES) }).strict()
]);
export type LabelledExample = z.infer<typeof LabelledExampleSchema>;

/** A row written for labelling: the example with `label` and `labelSource`
 * null until the founder or the review lane fills them in. */
export type UnlabelledExample = Omit<LabelledExample, "label" | "labelSource"> & { label: boolean | null; labelSource: LabelSource | null };

/* ---------------------------------------------------------------------------
   The export --keep-calibration writes.
   --------------------------------------------------------------------------- */

/* Split so no reader mistakes it for a User-Agent literal; the value is the
   export's schema id. */
export const CALIBRATION_EXPORT_SCHEMA = "foray-calibration-export" + "/1";

export interface CalibrationTapePointer {
  actIndex: number;
  slotIndex: number;
  beatIndex: number;
  tape: TapePointer;
}

export interface CalibrationClipScore {
  key: string;
  clipScores: ClipScoreOutcome;
  windowTruncated?: true;
}

/**
 * One prompt's calibration data. NO PROMPT FIELD, by design: `key` is the
 * first 8 hex characters of the prompt's sha1 (the same suffix the
 * candidate's file name carries, so the two can be paired), never text.
 */
export interface CalibrationExport {
  schema: typeof CALIBRATION_EXPORT_SCHEMA;
  key: string;
  promptId?: string;
  forayId?: string;
  duration?: string;
  subjectSentence: string;
  /** `narrate:<i>` as banked: the written acts, with every page's verified
   * flag, verifierNotes and evidence. */
  writtenActs: unknown[];
  /** The source stage's `tapeRelevance` rows (one per tape beat). */
  tapeRelevance: TapeRelevanceInput[];
  /** The sourced acts' tape pointers, by position. */
  tapePointers: CalibrationTapePointer[];
  /** GV-79's own clip scores, when the run banked a `clip-scores` stage. */
  clipScores?: CalibrationClipScore[];
}

const TapePointerShape = z
  .object({ segmentId: z.string(), itemId: z.string(), startSec: z.number(), endSec: z.number() })
  .passthrough();
const TapeRelevanceRowShape = z
  .object({ actIndex: z.number().int(), slotIndex: z.number().int(), beatIndex: z.number().int(), claim: z.string(), itemId: z.string() })
  .passthrough();

/** Light validation of an export read back from disk: the fields extraction
 * reads, and the schema id. Pages are validated one by one at extraction. */
export const CalibrationExportSchema = z
  .object({
    schema: z.literal(CALIBRATION_EXPORT_SCHEMA),
    key: z.string().min(1),
    promptId: z.string().optional(),
    forayId: z.string().optional(),
    duration: z.string().optional(),
    subjectSentence: z.string(),
    writtenActs: z.array(z.unknown()),
    tapeRelevance: z.array(TapeRelevanceRowShape),
    tapePointers: z.array(
      z.object({ actIndex: z.number().int(), slotIndex: z.number().int(), beatIndex: z.number().int(), tape: TapePointerShape }).passthrough()
    ),
    clipScores: z.array(z.unknown()).optional()
  })
  .passthrough();

export function parseCalibrationExport(raw: unknown): CalibrationExport {
  return CalibrationExportSchema.parse(raw) as unknown as CalibrationExport;
}

export interface CalibrationExportIdentity {
  key: string;
  promptId?: string;
  forayId?: string;
  duration?: string;
}

const asRecord = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Builds the export from a checkpoint's stages (the driver's
 * `FileCheckpointStore.load(key).stages`): `source` (acts and tapeRelevance),
 * `narrate:<i>` for every act, `spine` (subject, angle) with the
 * `understand` intent as the fallback, and `clip-scores` when banked.
 * Returns why it cannot when a stage it needs is missing. Copies only those
 * fields: no stage that could carry the prompt is read whole.
 */
export function calibrationExportFromStages(stages: Record<string, unknown>, ident: CalibrationExportIdentity): CalibrationExport | { error: string } {
  const source = asRecord(stages.source);
  if (!source || !Array.isArray(source.acts) || !Array.isArray(source.tapeRelevance)) return { error: "no source stage" };
  const acts = source.acts as unknown[];
  const writtenActs: unknown[] = [];
  for (let i = 0; i < acts.length; i += 1) {
    const written = stages[`narrate:${i}`];
    if (written === undefined) return { error: `no narrate:${i} stage` };
    writtenActs.push(written);
  }
  const tapePointers: CalibrationTapePointer[] = [];
  acts.forEach((act, actIndex) => {
    const slots = asRecord(act)?.slots;
    if (!Array.isArray(slots)) return;
    slots.forEach((slot, slotIndex) => {
      const beats = asRecord(slot)?.beats;
      if (!Array.isArray(beats)) return;
      beats.forEach((beat, beatIndex) => {
        const b = asRecord(beat);
        if (b?.sourcing === "tape" && asRecord(b.tape)) tapePointers.push({ actIndex, slotIndex, beatIndex, tape: b.tape as TapePointer });
      });
    });
  });
  const spine = asRecord(stages.spine);
  const intent = asRecord(asRecord(stages.understand)?.intent);
  const subjectSentence = subjectSentenceFor(
    { subject: asString(spine?.subject) ?? "", angle: asString(spine?.angle) ?? "" },
    { subject: asString(intent?.subject) ?? "", angle: asString(intent?.angle) ?? "" }
  );
  const clipScores = Array.isArray(stages["clip-scores"]) ? (stages["clip-scores"] as CalibrationClipScore[]) : undefined;
  return {
    schema: CALIBRATION_EXPORT_SCHEMA,
    key: ident.key,
    ...(ident.promptId !== undefined ? { promptId: ident.promptId } : {}),
    ...(ident.forayId !== undefined ? { forayId: ident.forayId } : {}),
    ...(ident.duration !== undefined ? { duration: ident.duration } : {}),
    subjectSentence,
    writtenActs,
    tapeRelevance: source.tapeRelevance as TapeRelevanceInput[],
    tapePointers,
    ...(clipScores ? { clipScores } : {})
  };
}

/* ---------------------------------------------------------------------------
   Extraction.
   --------------------------------------------------------------------------- */

/** A page as extracted: a page-support example whose label is the
 * pipeline's own verdict when it has one (`labelSource: 'run-verdict'`). */
export interface PageExample {
  kind: "page-support";
  id: string;
  payload: PagePayload;
  /** The pipeline's verifier verdict, OPTIONAL: absent on a hand-off page
   * (`unverifiedReason`: nothing was judged) and on a page verified as a
   * synthesis (judged against other pages, not its evidence). */
  label?: boolean;
  labelSource?: "run-verdict";
}

/** The page's documents as support sources. A document with no text is
 * dropped: nothing in it can back a sentence. */
function pageSources(page: NarratedBeat): SupportSource[] {
  return (page.evidence ?? [])
    .filter((doc) => doc.text.trim().length > 0)
    .map((doc) => ({ id: doc.docId, kind: doc.docId.startsWith("tape:") ? ("clip" as const) : ("doc" as const), text: doc.text, publication: doc.title }));
}

/** The documents the page's own sources point at: a tape source's window
 * (`tapeDocIdFor`), a print source's document by title or url. */
function declaredDocIds(page: NarratedBeat, sources: readonly SupportSource[]): string[] {
  const ids: string[] = [];
  for (const src of page.sources) {
    let id: string | undefined;
    if (isTapeSource(src)) id = tapeDocIdFor(src.segmentId);
    else id = (page.evidence ?? []).find((d) => d.title === src.publication || (src.url !== undefined && d.url === src.url))?.docId;
    if (id !== undefined && sources.some((s) => s.id === id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function runVerdictOf(page: NarratedBeat): boolean | undefined {
  if (page.unverifiedReason !== undefined) return undefined;
  if (isSynthesisVerified(page)) return undefined;
  return page.verified;
}

/**
 * Every narration page of the export's written acts, in Foray order: a
 * narration beat's own page (a beat carried by another's page has none) and
 * a tape beat's connective page. Ids are `<key>:page:<act>:<slot>:<beat>`
 * (`:frame` for a connective page), unique across exports. A page that does
 * not parse as a NarratedBeat is skipped.
 */
export function extractPages(exp: CalibrationExport): PageExample[] {
  const out: PageExample[] = [];
  exp.writtenActs.forEach((act, a) => {
    const slots = asRecord(act)?.slots;
    if (!Array.isArray(slots)) return;
    slots.forEach((slot, s) => {
      const beats = asRecord(slot)?.beats;
      if (!Array.isArray(beats)) return;
      beats.forEach((beat, b) => {
        const bb = asRecord(beat);
        if (!bb) return;
        const raw = bb.sourcing === "narration" ? bb.narration : bb.sourcing === "tape" ? bb.connectiveNarration : undefined;
        if (raw === undefined) return;
        const parsed = NarratedBeatSchema.safeParse(raw);
        if (!parsed.success) return;
        const page = parsed.data;
        const sources = pageSources(page);
        const verdict = runVerdictOf(page);
        out.push({
          kind: "page-support",
          id: `${exp.key}:page:${a}:${s}:${b}${bb.sourcing === "tape" ? ":frame" : ""}`,
          payload: { script: page.script, claim: asString(bb.claim) ?? "", sources, mustInclude: declaredDocIds(page, sources) },
          ...(verdict !== undefined ? { label: verdict, labelSource: "run-verdict" as const } : {})
        });
      });
    });
  });
  return out;
}

export interface ClipRow {
  /** `<key>:clip:<act>:<slot>:<beat>`. */
  id: string;
  itemId: string;
  segmentId: string;
  startSec: number;
  endSec: number;
  payload: ClipPayload;
  /** The clip runs past the window cap; the text is its first part (GV-79). */
  windowTruncated?: true;
}

export interface ExtractClipsOptions {
  cueProvider: TranscriptCueProvider;
  transcriptArchive: TranscriptDigestEntry[];
  catalogue: CatalogueData;
}

export interface ExtractClipsResult {
  rows: ClipRow[];
  /** Placed clips with no text to label, and why. */
  skipped: { id: string; reason: "no-pointer" | "no-transcript" | "no-window" }[];
}

/**
 * One unlabelled row per placed clip (a merged beat's row is skipped: its
 * clip is its carrier's, which plays once), carrying the subject sentence,
 * the beat's claim and the clip's own transcript between its start and end
 * with no padding: the same text GV-79's scorer judges
 * (scoreClips.ts). Reading the transcript is local.
 */
export function extractClips(exp: CalibrationExport, opts: ExtractClipsOptions): ExtractClipsResult {
  const rows: ClipRow[] = [];
  const skipped: ExtractClipsResult["skipped"] = [];
  const pointers = new Map(exp.tapePointers.map((p) => [`${p.actIndex}:${p.slotIndex}:${p.beatIndex}`, p.tape]));
  for (const row of exp.tapeRelevance) {
    if (row.mergedInto) continue;
    const position = `${row.actIndex}:${row.slotIndex}:${row.beatIndex}`;
    const id = `${exp.key}:clip:${position}`;
    const tape = pointers.get(position);
    if (!tape) {
      skipped.push({ id, reason: "no-pointer" });
      continue;
    }
    const entry = findDigestForItem(tape.itemId, opts.transcriptArchive, opts.catalogue);
    const cues = entry ? opts.cueProvider.getCues(entry) : null;
    if (!cues || cues.length === 0) {
      skipped.push({ id, reason: "no-transcript" });
      continue;
    }
    let text = cueWindowText(cues, tape.startSec, tape.endSec, 0);
    let truncated = false;
    if (text.endsWith(TAPE_CUT_MARK)) {
      text = text.slice(0, -TAPE_CUT_MARK.length).trim();
      truncated = true;
    }
    if (text.length === 0) {
      skipped.push({ id, reason: "no-window" });
      continue;
    }
    rows.push({
      id,
      itemId: tape.itemId,
      segmentId: tape.segmentId,
      startSec: tape.startSec,
      endSec: tape.endSec,
      payload: { subjectSentence: exp.subjectSentence, claim: row.claim, windowText: text },
      ...(truncated ? { windowTruncated: true as const } : {})
    });
  }
  return { rows, skipped };
}

/** A clip row as the two unlabelled examples a labeller marks: is it about
 * the subject, and does it make the claim. */
export function clipExamples(row: ClipRow): UnlabelledExample[] {
  return [
    { kind: "clip-subject", id: row.id, payload: row.payload, label: null, labelSource: null },
    { kind: "clip-claim", id: row.id, payload: row.payload, label: null, labelSource: null }
  ];
}

/** A page as a row to label. With `useRunVerdict` (only under the founder's
 * #1163 allowance), the pipeline's own verdict fills the label. */
export function pageExampleRow(page: PageExample, useRunVerdict = false): UnlabelledExample {
  const keep = useRunVerdict && page.label !== undefined;
  return {
    kind: page.kind,
    id: page.id,
    payload: page.payload,
    label: keep ? page.label! : null,
    labelSource: keep ? "run-verdict" : null
  };
}

/* ---------------------------------------------------------------------------
   The judge side.
   --------------------------------------------------------------------------- */

/** One example's judged value: a page's lowest sentence p, or a clip's
 * level; or why it has none (counted, never treated as a pass or a fail). */
export type JudgedValue = { value: number } | { unjudged: string };

export interface CalibrationJudge {
  /** The judge whose answers count; any other judge's answer is unjudged. */
  readonly judge: JudgeId;
  values(examples: readonly LabelledExample[]): Promise<Map<string, JudgedValue>>;
}

export const CALIBRATION_PURPOSE = "judge-calibration";

/**
 * `client` with every answer from another judge turned into a failure
 * (`judge_mismatch`): a calibration of Jev must never count an answer the
 * Qwen judge gave behind a fallback, and the reverse (GV-47: the two
 * judges' numbers are not comparable). An untagged answer is Jev's.
 */
export function onlyJudge(client: JevClient, judge: JudgeId): JevClient {
  return {
    async ask(state, questions, opts) {
      const result = await client.ask(state, questions, opts);
      if ((result.judge ?? "jev") === judge) return result;
      return { ok: false, error: { category: "malformed", reason: "judge_mismatch" }, latencyMs: result.latencyMs, judge: result.judge ?? "jev" };
    }
  };
}

export interface JevCalibrationJudgeOptions {
  maxInFlight?: number;
}

/**
 * Asks `client` (already metered, when the caller wants it charged) the
 * pipeline's own questions:
 *   page-support  GV-27's per-sentence support ask for every statement
 *                 sentence of the script, against that sentence's candidate
 *                 sources (`candidateSourcesFor`, the page's declared
 *                 documents always included); the page's value is the
 *                 LOWEST sentence p, so "every sentence p >= t" (W5-08) is
 *                 "value >= t". A page with no statement sentence, or any
 *                 sentence the judge could not answer, is unjudged.
 *   clip-subject  GV-79's two-Score ask; the value is the subject level.
 *   clip-claim    the same ask; the value is the claim level.
 */
export class JevCalibrationJudge implements CalibrationJudge {
  private readonly client: JevClient;

  constructor(
    client: JevClient,
    readonly judge: JudgeId,
    private readonly opts: JevCalibrationJudgeOptions = {}
  ) {
    this.client = onlyJudge(client, judge);
  }

  async values(examples: readonly LabelledExample[]): Promise<Map<string, JudgedValue>> {
    const out = new Map<string, JudgedValue>();
    const pages = examples.filter((e): e is Extract<LabelledExample, { kind: "page-support" }> => e.kind === "page-support");
    const clips = examples.filter((e): e is Extract<LabelledExample, { kind: "clip-subject" | "clip-claim" }> => e.kind !== "page-support");
    const maxInFlight = this.opts.maxInFlight ?? DEFAULT_JEV_POOL_SIZE;

    if (pages.length > 0) {
      const items: SentenceSupportItem[] = [];
      const itemsOf = new Map<string, string[]>();
      for (const page of pages) {
        const ids: string[] = [];
        statementSentences(page.payload.script).forEach((sentence, k) => {
          const id = `${page.id}#${k}`;
          ids.push(id);
          items.push({ id, sentence, sources: candidateSourcesFor(sentence, page.payload.sources, { mustInclude: page.payload.mustInclude }) });
        });
        itemsOf.set(page.id, ids);
      }
      const verdicts = await new JevSentenceSupportJudge(this.client, { maxInFlight, purpose: CALIBRATION_PURPOSE }).judge(items);
      for (const page of pages) {
        const ids = itemsOf.get(page.id)!;
        if (ids.length === 0) {
          out.set(page.id, { unjudged: "no-statements" });
          continue;
        }
        let min = Infinity;
        let unavailable: string | null = null;
        for (const id of ids) {
          const v = verdicts.get(id);
          if (!v) unavailable = "no-answer";
          else if (isSupportUnavailable(v)) unavailable = v.reason;
          else min = Math.min(min, v.p);
          if (unavailable !== null) break;
        }
        out.set(page.id, unavailable !== null ? { unjudged: unavailable } : { value: min });
      }
    }

    if (clips.length > 0) {
      /* One ask per distinct clip: the subject and the claim example of the
         same clip share it. */
      const questions = new Map<string, ClipQuestion>();
      for (const clip of clips) {
        const key = JSON.stringify([clip.payload.subjectSentence, clip.payload.claim, clip.payload.windowText]);
        if (!questions.has(key)) questions.set(key, { key, subjectSentence: clip.payload.subjectSentence, claim: clip.payload.claim, windowText: clip.payload.windowText });
      }
      const scored = await new JevClipJudge(createJevPool(this.client, { maxInFlight })).score([...questions.values()]);
      for (const clip of clips) {
        const outcome = scored.get(JSON.stringify([clip.payload.subjectSentence, clip.payload.claim, clip.payload.windowText]));
        if (!outcome) out.set(clip.id, { unjudged: "no-answer" });
        else if ("unavailable" in outcome) out.set(clip.id, { unjudged: outcome.unavailable });
        else if (outcome.judge !== this.judge) out.set(clip.id, { unjudged: "judge_mismatch" });
        else out.set(clip.id, { value: clip.kind === "clip-subject" ? outcome.subject : outcome.claim });
      }
    }
    return out;
  }
}

/* ---------------------------------------------------------------------------
   The table.
   --------------------------------------------------------------------------- */

/** Agreement the recommended threshold must reach (LM-24, the card's goal). */
export const CALIBRATION_TARGET_AGREEMENT = 0.9;

/** Page support: probabilities 0.05..0.95 in steps of 0.05. */
export const DEFAULT_SUPPORT_THRESHOLDS: readonly number[] = Object.freeze(Array.from({ length: 19 }, (_, i) => Math.round((i + 1) * 5) / 100));
/** Clips: every level of GV-79's 5-level Score cards. */
export const DEFAULT_CLIP_THRESHOLDS: readonly number[] = Object.freeze(Array.from({ length: CLIP_SCORE_LEVELS }, (_, i) => i));

export function defaultThresholdsFor(kind: ExampleKind): readonly number[] {
  return kind === "page-support" ? DEFAULT_SUPPORT_THRESHOLDS : DEFAULT_CLIP_THRESHOLDS;
}

/** The GV-47 gate threshold a kind calibrates. Both clip kinds feed
 * `clipLevel` (GV-79: subject >= level AND claim >= level), so the value to
 * set is the higher of their two recommendations. */
export function thresholdNameFor(kind: ExampleKind): JudgeThresholdName {
  return kind === "page-support" ? "supportMinP" : "clipLevel";
}

/** The 95% Wilson score interval of k successes in n, or null when n is 0.
 * Sample sizes here are tiny (about 40 clips, a few dozen pages), so a
 * threshold's agreement is read with its interval and treated as
 * provisional. */
export function wilson95(k: number, n: number): { lo: number; hi: number } | null {
  if (n <= 0) return null;
  const z = 1.959963984540054;
  const p = k / n;
  const z2n = (z * z) / n;
  const centre = (p + z2n / 2) / (1 + z2n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + z2n);
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

export interface ThresholdRow {
  threshold: number;
  /** (tp + tn) / n. */
  agreement: number;
  /** tp / (tp + fp): of what the judge passes, how much the label passes.
   * Null when the judge passes nothing. */
  precision: number | null;
  /** tp / (tp + fn): of what the label passes, how much the judge passes.
   * Null when the label passes nothing. */
  recall: number | null;
  n: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  wilson95: { lo: number; hi: number } | null;
}

export interface ScoredExample {
  id: string;
  label: boolean;
  value: number;
}

/** Predicted pass iff value >= threshold; one row per threshold, in the
 * order given. */
export function agreementTable(scored: readonly ScoredExample[], thresholds: readonly number[]): ThresholdRow[] {
  return thresholds.map((threshold) => {
    let tp = 0;
    let fp = 0;
    let tn = 0;
    let fn = 0;
    for (const ex of scored) {
      const predicted = ex.value >= threshold;
      if (predicted && ex.label) tp += 1;
      else if (predicted) fp += 1;
      else if (ex.label) fn += 1;
      else tn += 1;
    }
    const n = scored.length;
    return {
      threshold,
      agreement: n > 0 ? (tp + tn) / n : 0,
      precision: tp + fp > 0 ? tp / (tp + fp) : null,
      recall: tp + fn > 0 ? tp / (tp + fn) : null,
      n,
      tp,
      fp,
      tn,
      fn,
      wilson95: wilson95(tp + tn, n)
    };
  });
}

/** The lowest threshold whose agreement reaches `target`, or null. */
export function recommendThreshold(rows: readonly ThresholdRow[], target: number = CALIBRATION_TARGET_AGREEMENT): number | null {
  let best: number | null = null;
  for (const row of rows) if (row.n > 0 && row.agreement >= target && (best === null || row.threshold < best)) best = row.threshold;
  return best;
}

export interface CalibrateOptions {
  /** Count `labelSource: 'run-verdict'` examples (the pipeline's own
   * verifier verdicts). Default false: founder and review-lane labels only,
   * until the founder rules on #1163 (OQ-06). */
  allowRunVerdicts?: boolean;
  target?: number;
}

export interface CalibrationResult {
  kind: ExampleKind;
  judge: JudgeId;
  /** The GV-47 gate key the recommendation is for, e.g. `supportMinP.jev`. */
  gateKey: `${JudgeThresholdName}.${JudgeId}`;
  target: number;
  rows: ThresholdRow[];
  /** The lowest threshold with agreement >= target; null when none reaches it. */
  recommended: number | null;
  /** Examples judged and counted. */
  n: number;
  /** Examples the judge gave no value for, and why. */
  unjudged: { id: string; reason: string }[];
  /** Run-verdict examples left out (allowRunVerdicts false). */
  excludedRunVerdicts: number;
  labelSources: Record<LabelSource, number>;
}

/**
 * The agreement-by-threshold table for ONE kind of example: asks `judge`
 * for every example's value, drops the unjudged (reported), and compares
 * prediction (value >= threshold) with label at each threshold.
 */
export async function calibrate(
  examples: readonly LabelledExample[],
  judge: CalibrationJudge,
  thresholds?: readonly number[],
  opts: CalibrateOptions = {}
): Promise<CalibrationResult> {
  if (examples.length === 0) throw new Error("calibrate: no examples");
  const kind = examples[0]!.kind;
  if (examples.some((e) => e.kind !== kind)) throw new Error("calibrate: examples of more than one kind; calibrate one kind at a time");
  const ids = new Set<string>();
  for (const e of examples) {
    if (ids.has(e.id)) throw new Error(`calibrate: duplicate example id '${e.id}'`);
    ids.add(e.id);
  }
  const counted = opts.allowRunVerdicts ? [...examples] : examples.filter((e) => e.labelSource !== "run-verdict");
  const values = counted.length > 0 ? await judge.values(counted) : new Map<string, JudgedValue>();
  const scored: ScoredExample[] = [];
  const unjudged: { id: string; reason: string }[] = [];
  const labelSources: Record<LabelSource, number> = { founder: 0, "review-lane": 0, "run-verdict": 0 };
  for (const e of counted) {
    const v = values.get(e.id) ?? { unjudged: "no-answer" };
    if ("unjudged" in v) {
      unjudged.push({ id: e.id, reason: v.unjudged });
      continue;
    }
    scored.push({ id: e.id, label: e.label, value: v.value });
    labelSources[e.labelSource] += 1;
  }
  const target = opts.target ?? CALIBRATION_TARGET_AGREEMENT;
  const rows = agreementTable(scored, thresholds ?? defaultThresholdsFor(kind));
  return {
    kind,
    judge: judge.judge,
    gateKey: `${thresholdNameFor(kind)}.${judge.judge}`,
    target,
    rows,
    recommended: recommendThreshold(rows, target),
    n: scored.length,
    unjudged,
    excludedRunVerdicts: examples.length - counted.length,
    labelSources
  };
}

/** The table as text, one line per threshold. */
export function formatCalibration(result: CalibrationResult): string[] {
  const pct = (x: number | null): string => (x === null ? "  -  " : `${(x * 100).toFixed(1).padStart(5)}%`);
  const lines = [
    `${result.kind} / ${result.judge}: n=${result.n} (founder ${result.labelSources.founder}, review-lane ${result.labelSources["review-lane"]}, run-verdict ${result.labelSources["run-verdict"]}), unjudged ${result.unjudged.length}` +
      (result.excludedRunVerdicts > 0 ? `, run-verdict labels left out ${result.excludedRunVerdicts}` : ""),
    "threshold  agreement  precision  recall   wilson95"
  ];
  for (const row of result.rows) {
    const w = row.wilson95 ? `${(row.wilson95.lo * 100).toFixed(0)}-${(row.wilson95.hi * 100).toFixed(0)}%` : "-";
    lines.push(`${String(row.threshold).padStart(9)}  ${pct(row.agreement)}     ${pct(row.precision)}     ${pct(row.recall)}  ${w}`);
  }
  lines.push(
    result.recommended === null
      ? `no threshold reaches ${result.target * 100}% agreement; leave ${result.gateKey} at its default`
      : `recommended ${result.gateKey} = ${result.recommended} (lowest threshold with agreement >= ${result.target * 100}%; provisional at n=${result.n})`
  );
  return lines;
}
